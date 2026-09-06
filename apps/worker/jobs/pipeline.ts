import { join } from "@std/path";
import type { Sql } from "../../../packages/database/client.ts";
import type { Job, JobProgressReporter } from "../../../packages/domain/job-types.ts";
import type { Config } from "../../../packages/shared/config.ts";
import { answerGenerationApiKey } from "../../../packages/shared/config.ts";
import { episodeStorage, toSharedStoragePath } from "../../../packages/shared/paths.ts";
import { downloadAudio, inspectAudio, normalizeAudio } from "../services/audio.ts";
import {
  scribeProcessingResult,
  scribeResponseSchema,
  transcribeWithScribe,
} from "../services/elevenlabs.ts";
import { AudioMlClient } from "../services/ml-client.ts";
import { saveProcessingResult } from "../../../packages/database/repositories/processing.ts";
import { createAndPersistChunks } from "./create_content_chunks.ts";
import { LocalTextEmbeddingProvider } from "../../../packages/search/providers.ts";
import { SystemIncidentRepository } from "../../../packages/database/repositories/system-incidents.ts";
import { PushoverClient } from "../../../packages/shared/pushover.ts";
import { z } from "zod";
import { automaticallyAssignRegularHostsForEpisode } from "../../../packages/database/speaker-matching.ts";
import {
  assignSingleUnknownGuest,
  singleUnknownSpeakerContext,
} from "../../../packages/database/automatic-speaker-identification.ts";
import {
  type IdentifiedGuest,
  OpenAiCompatibleGuestIdentificationProvider,
} from "../../../packages/speakers/guest-identification.ts";
import {
  type TranscriptAlignmentMode,
  transcriptAlignmentModeSchema,
} from "../../../packages/domain/schemas.ts";
import { importPodcast } from "../../../packages/podcast-rss/importer.ts";
import {
  applyAsrCorrectionForMode,
  ASR_CORRECTED_MODE,
  type AsrCorrectionProvider,
  formatAsrCorrectionDebug,
  OpenAiCompatibleAsrCorrectionProvider,
} from "../../../packages/transcription/asr-correction.ts";
import { log } from "../../../packages/shared/logging.ts";

interface EpisodeRow {
  id: string;
  podcastId: string;
  audioUrl: string;
  audioByteSize: number | null;
  audioMimeType: string | null;
  audioSha256: string | null;
  originalAudioPath: string | null;
  normalizedAudioPath: string | null;
  transcriptAlignmentMode: TranscriptAlignmentMode;
  title: string;
  description: string | null;
}

const audioMlCheckPayloadSchema = z.object({
  failedJobId: z.string().uuid(),
  failedAttempt: z.number().int().positive(),
  failureMessage: z.string().max(4000),
});

async function episode(sql: Sql, id: string): Promise<EpisodeRow> {
  const rows = await sql`
    SELECT episode.*, podcast.transcript_alignment_mode
    FROM episodes episode
    JOIN podcasts podcast ON podcast.id = episode.podcast_id
    WHERE episode.id = ${id}
  `;
  if (!rows[0]) throw new Error("Epizoda nebyla nalezena.");
  return rows[0] as unknown as EpisodeRow;
}

export function createHandlers(
  sql: Sql,
  config: Config,
  dependencies: { asrCorrectionProvider?: AsrCorrectionProvider | null } = {},
) {
  const ml = new AudioMlClient(config);
  const textEmbeddings = new LocalTextEmbeddingProvider(config);
  const incidents = new SystemIncidentRepository(sql);
  const pushover = new PushoverClient(config);
  const guestIdentificationApiKey = answerGenerationApiKey(config);
  const guestIdentification = config.ANSWER_GENERATION_PROVIDER === "openai-compatible" &&
      config.ANSWER_GENERATION_BASE_URL
    ? new OpenAiCompatibleGuestIdentificationProvider({
      baseUrl: config.ANSWER_GENERATION_BASE_URL,
      model: config.ANSWER_GENERATION_MODEL,
      ...(guestIdentificationApiKey ? { apiKey: guestIdentificationApiKey } : {}),
      timeoutMs: config.ANSWER_GENERATION_TIMEOUT_MS,
    })
    : null;
  const asrCorrectionProvider = dependencies.asrCorrectionProvider !== undefined
    ? dependencies.asrCorrectionProvider
    : config.ANSWER_GENERATION_PROVIDER === "openai-compatible" &&
        config.ANSWER_GENERATION_BASE_URL
    ? new OpenAiCompatibleAsrCorrectionProvider({
      baseUrl: config.ANSWER_GENERATION_BASE_URL,
      model: config.ASR_CORRECTION_MODEL ?? config.ANSWER_GENERATION_MODEL,
      ...(guestIdentificationApiKey ? { apiKey: guestIdentificationApiKey } : {}),
      timeoutMs: config.ANSWER_GENERATION_TIMEOUT_MS,
      protocol: "vllm",
    })
    : config.OPENAI_API_KEY
    ? new OpenAiCompatibleAsrCorrectionProvider({
      baseUrl: "https://api.openai.com/v1",
      model: config.ASR_CORRECTION_MODEL ?? config.OPENAI_ANSWER_MODEL,
      apiKey: config.OPENAI_API_KEY,
      timeoutMs: config.OPENAI_ANSWER_TIMEOUT_MS,
      protocol: "openai",
    })
    : null;
  return {
    IMPORT_FEED: async (job: Job, progress: JobProgressReporter) => {
      await progress({ phase: "rss_refresh", message: "Aktualizuji RSS feed.", percent: 0 });
      const rows = await sql`SELECT rss_url FROM podcasts WHERE id = ${job.entityId}`;
      if (!rows[0]) throw new Error("Podcast nebyl nalezen.");
      const result = await importPodcast(sql, String(rows[0].rssUrl), config.MAX_JOB_ATTEMPTS);
      await progress({ phase: "rss_refresh", message: "RSS feed je aktuální.", percent: 100 });
      return result;
    },

    DOWNLOAD_AUDIO: async (job: Job, progress: JobProgressReporter) => {
      await progress({ phase: "download", message: "Stahuji audio epizody.", percent: 0 });
      const item = await episode(sql, job.entityId);
      const paths = episodeStorage(config.STORAGE_ROOT, item.podcastId, item.id);
      await sql`UPDATE episodes SET processing_status = 'downloading', updated_at = now()
        WHERE id = ${item.id}`;
      const downloaded = await downloadAudio(
        item.audioUrl,
        paths.original,
        item.audioByteSize,
      );
      await sql.begin(async (tx) => {
        await tx`
          UPDATE episodes SET original_audio_path = ${downloaded.path},
            audio_sha256 = ${downloaded.sha256}, audio_byte_size = ${downloaded.byteSize},
            audio_mime_type = ${downloaded.mimeType}, processing_status = 'downloaded',
            processing_error = NULL, updated_at = now()
          WHERE id = ${item.id}
        `;
        await tx`
          INSERT INTO processing_artifacts (
            episode_id, artifact_type, storage_path, mime_type, byte_size, sha256
          ) VALUES (
            ${item.id}, 'original_audio', ${downloaded.path}, ${downloaded.mimeType},
            ${downloaded.byteSize}, ${downloaded.sha256}
          ) ON CONFLICT DO NOTHING
        `;
      });
      await progress({ phase: "download", message: "Audio je stažené.", percent: 100 });
      return { byteSize: downloaded.byteSize, sha256: downloaded.sha256 };
    },

    NORMALIZE_AUDIO: async (job: Job, progress: JobProgressReporter) => {
      await progress({ phase: "normalization", message: "Normalizuji audio.", percent: 0 });
      const item = await episode(sql, job.entityId);
      if (!item.originalAudioPath) throw new Error("Epizoda nemá stažené audio.");
      const paths = episodeStorage(config.STORAGE_ROOT, item.podcastId, item.id);
      await sql`UPDATE episodes SET processing_status = 'normalizing', updated_at = now()
        WHERE id = ${item.id}`;
      const normalized = await normalizeAudio(item.originalAudioPath, paths.normalized);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE episodes SET normalized_audio_path = ${normalized.path},
            duration_seconds = ${normalized.inspection.durationSeconds},
            processing_status = 'normalized', processing_error = NULL, updated_at = now()
          WHERE id = ${item.id}
        `;
        await tx`
          INSERT INTO processing_artifacts (
            episode_id, artifact_type, storage_path, mime_type, byte_size, metadata
          ) VALUES (
            ${item.id}, 'normalized_audio', ${normalized.path}, 'audio/wav',
            ${normalized.byteSize}, ${
          tx.json({
            durationSeconds: normalized.inspection.durationSeconds,
            sampleRate: normalized.inspection.sampleRate,
            channels: normalized.inspection.channels,
          })
        }
          ) ON CONFLICT DO NOTHING
        `;
      });
      await progress({ phase: "normalization", message: "Audio je normalizované.", percent: 100 });
      return normalized.inspection;
    },

    PROCESS_AUDIO_ML: async (job: Job, progress: JobProgressReporter) => {
      const item = await episode(sql, job.entityId);
      const selectedMode = transcriptAlignmentModeSchema.catch(item.transcriptAlignmentMode).parse(
        job.payload.transcriptAlignmentMode,
      );
      log("info", "Zvolen režim přepisu a diarizace.", {
        jobId: job.id,
        episodeId: item.id,
        selectedMode,
      });
      const force = job.payload.force === true;
      const completedForJob = await sql`
        SELECT id
        FROM processing_runs
        WHERE source_job_id = ${job.id} AND status = 'completed'
        LIMIT 1
      `;
      if (completedForJob[0]?.id) {
        return {
          processingRunId: String(completedForJob[0].id),
          reused: true,
          reusedByJob: true,
        };
      }
      if (job.payload.transcriptProvider === "elevenlabs") {
        if (!config.ELEVENLABS_API_KEY) throw new Error("Chybí ELEVENLABS_API_KEY.");
        if (!item.originalAudioPath) throw new Error("Epizoda nemá stažené audio.");
        const paths = episodeStorage(config.STORAGE_ROOT, item.podcastId, item.id);
        await Deno.mkdir(paths.derived, { recursive: true });
        const rawPath = join(paths.derived, `transcript-scribe-${job.id}-raw.json`);
        await progress({
          phase: "scribe",
          message: "Přepisuji audio a rozlišuji hlasy přes ElevenLabs Scribe.",
          percent: 0,
        });
        let raw;
        try {
          raw = scribeResponseSchema.parse(JSON.parse(await Deno.readTextFile(rawPath)));
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          raw = await transcribeWithScribe({
            audioPath: item.originalAudioPath,
            apiKey: config.ELEVENLABS_API_KEY,
            model: config.ELEVENLABS_SCRIBE_MODEL,
            language: config.DEFAULT_TRANSCRIPTION_LANGUAGE,
            timeoutMs: config.ELEVENLABS_TIMEOUT_MS,
          });
          const temporary = `${rawPath}.${crypto.randomUUID()}.tmp`;
          await Deno.writeTextFile(temporary, JSON.stringify(raw));
          await Deno.rename(temporary, rawPath);
        }
        const inspection = await inspectAudio(item.originalAudioPath);
        const result = scribeProcessingResult(
          raw,
          item.id,
          config.ELEVENLABS_SCRIBE_MODEL,
          inspection.durationSeconds,
        );
        const transcriptPath = join(paths.derived, `transcript-${job.id}.json`);
        await Deno.writeTextFile(transcriptPath, JSON.stringify(result, null, 2));
        const runId = await saveProcessingResult(sql, result, transcriptPath, job.id, {
          candidate: true,
          provider: "elevenlabs",
        });
        await progress({
          phase: "scribe",
          message: "Přepis je připravený k porovnání a výběru.",
          percent: 100,
        });
        return { processingRunId: runId, utterances: result.utterances.length };
      }
      const current = await sql`
        SELECT active_processing_run_id, processing_status
        FROM episodes WHERE id = ${item.id}
      `;
      if (
        !force &&
        current[0]?.activeProcessingRunId &&
        ["transcribed", "indexing_queued", "indexing", "ready"].includes(
          String(current[0]?.processingStatus),
        )
      ) {
        return {
          processingRunId: String(current[0].activeProcessingRunId),
          reused: true,
        };
      }
      if (!item.normalizedAudioPath) throw new Error("Epizoda nemá normalizované audio.");
      if (!await ml.ready()) throw new Error("ML služba zatím není připravená.");
      if (job.payload.nonBlocking !== true) {
        await sql`UPDATE episodes SET processing_status = 'transcribing', updated_at = now()
          WHERE id = ${item.id}`;
      }
      const sharedPath = toSharedStoragePath(
        config.STORAGE_ROOT,
        config.AUDIO_ML_SHARED_ROOT,
        item.normalizedAudioPath,
      );
      const rawResult = await ml.process(
        {
          episodeId: item.id,
          checkpointId: job.id,
          audioPath: sharedPath,
          ...(item.audioSha256 ? { audioFingerprint: item.audioSha256 } : {}),
          language: config.DEFAULT_TRANSCRIPTION_LANGUAGE || null,
          minSpeakers: 1,
          maxSpeakers: 5,
          enableDiarization: true,
          returnSpeakerEmbeddings: true,
          transcriptAlignmentMode: selectedMode === "segment" ? "segment" : "overlap",
        },
        selectedMode === ASR_CORRECTED_MODE
          ? (event) =>
            progress({
              ...event,
              ...(event.percent === undefined ? {} : { percent: event.percent * 0.8 }),
            })
          : progress,
      );
      if (selectedMode === ASR_CORRECTED_MODE) {
        await progress({
          phase: "asr_correction",
          current: 0,
          total: Math.max(1, rawResult.utterances.length),
          percent: 80,
          message: "Kontextově opravuji pravděpodobné chyby přepisu.",
        });
      }
      const result = await applyAsrCorrectionForMode(
        rawResult,
        selectedMode,
        asrCorrectionProvider,
        {
          autoApplyThreshold: config.ASR_CORRECTION_AUTO_APPLY_THRESHOLD,
          concurrency: config.ASR_CORRECTION_CONCURRENCY,
          contextSeconds: config.ASR_CORRECTION_CONTEXT_SIZE,
        },
        { title: item.title, description: item.description },
        selectedMode === ASR_CORRECTED_MODE
          ? (current, total) =>
            progress({
              phase: "asr_correction",
              current,
              total: Math.max(1, total),
              percent: 80 + current / Math.max(1, total) * 20,
              message: "Kontextově opravuji pravděpodobné chyby přepisu.",
            })
          : undefined,
      );
      if (result.asrCorrection) {
        log("info", "ASR korekce přepisu dokončena.", {
          episodeId: item.id,
          selectedMode,
          ...result.asrCorrection,
        });
        if (config.APP_ENV === "development") {
          for (const utterance of result.utterances) {
            if (utterance.corrections?.some((correction) => correction.applied)) {
              log("debug", "Detail ASR korekce pro vývoj.", {
                episodeId: item.id,
                debugView: formatAsrCorrectionDebug(utterance),
              });
            }
          }
        }
      }
      const paths = episodeStorage(config.STORAGE_ROOT, item.podcastId, item.id);
      await Deno.mkdir(paths.derived, { recursive: true });
      const transcriptPath = join(paths.derived, `transcript-${crypto.randomUUID()}.json`);
      await Deno.writeTextFile(transcriptPath, JSON.stringify(result, null, 2), {
        createNew: true,
      });
      const runId = await saveProcessingResult(sql, result, transcriptPath, job.id, {
        candidate: true,
      });
      return { processingRunId: runId, utterances: result.utterances.length };
    },

    IDENTIFY_SPEAKERS: async (job: Job, progress: JobProgressReporter) => {
      await progress({
        phase: "speaker_identification",
        message: "Přiřazuji stálé moderátory.",
        percent: 0,
      });
      const moderators = await automaticallyAssignRegularHostsForEpisode(sql, job.entityId);
      const context = await singleUnknownSpeakerContext(sql, job.entityId);
      if (!context) {
        await progress({
          phase: "speaker_identification",
          message: "Automatické přiřazení mluvčích je hotové.",
          percent: 100,
        });
        return {
          moderators,
          guest: { status: "skipped_unknown_count" },
        };
      }
      if (!guestIdentification) {
        await progress({
          phase: "speaker_identification",
          message: "Chybí model pro rozpoznání hosta z popisku.",
          percent: 100,
        });
        return { moderators, guest: { status: "provider_not_configured" } };
      }

      await progress({
        phase: "speaker_identification",
        message: "Hledám jméno jediného hosta v popisku epizody.",
        percent: 60,
      });
      let identified: IdentifiedGuest | null;
      try {
        identified = await guestIdentification.identifyGuest({
          title: context.title,
          description: context.description,
          knownModeratorNames: context.knownModeratorNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await progress({
          phase: "speaker_identification",
          message: "Rozpoznání hosta z popisku selhalo; pipeline pokračuje bez něj.",
          percent: 100,
        });
        return { moderators, guest: { status: "provider_failed", message } };
      }
      if (!identified) {
        await progress({
          phase: "speaker_identification",
          message: "V popisku nebylo nalezeno jednoznačné jméno hosta.",
          percent: 100,
        });
        return { moderators, guest: { status: "not_found" } };
      }
      const assignment = await assignSingleUnknownGuest(sql, context, identified);
      await progress({
        phase: "speaker_identification",
        message: assignment.status === "assigned"
          ? `Host ${identified.displayName} byl přiřazen.`
          : assignment.status === "skipped_role_conflict"
          ? `${identified.displayName} je v podcastu vedený jako moderátor; přiřazení bylo přeskočeno.`
          : "Hlasy se mezitím změnily; automatické přiřazení hosta bylo přeskočeno.",
        percent: 100,
      });
      return { moderators, guest: { ...assignment, identified } };
    },

    CHECK_AUDIO_ML_HEALTH: async (job: Job, progress: JobProgressReporter) => {
      const payload = audioMlCheckPayloadSchema.parse(job.payload);
      await progress({
        phase: "diagnostics",
        message: "Kontroluji GPU, modely a sdílené úložiště Audio ML.",
        percent: 0,
      });
      const diagnostic = await ml.diagnose().catch((error) => ({
        status: "critical" as const,
        checks: [{
          name: "diagnostic_endpoint",
          ok: false,
          message: error instanceof Error ? error.message : "Diagnostika Audio ML selhala.",
        }],
      }));
      await progress({
        phase: "diagnostics",
        message: diagnostic.status === "ok"
          ? "Kontrolovaná místa Audio ML jsou v pořádku."
          : "Diagnostika našla kritický problém.",
        percent: 100,
      });
      if (diagnostic.status === "ok") {
        return { diagnostic, notification: "not_needed" };
      }

      const failedChecks = diagnostic.checks.filter((check) => !check.ok);
      const fingerprint = `audio_ml:${failedChecks.map((check) => check.name).sort().join(",")}`;
      const message = failedChecks.map((check) => check.message).join(" ").slice(0, 4000);
      const incident = await incidents.record({
        kind: "audio_ml_health",
        fingerprint,
        severity: "critical",
        title: "Audio ML vyžaduje kontrolu",
        message,
        details: {
          diagnostic,
          triggeringEpisodeId: job.entityId,
          failedJobId: payload.failedJobId,
          failedAttempt: payload.failedAttempt,
          failureMessage: payload.failureMessage,
        },
      });
      if (!pushover.configured) {
        return { diagnostic, incidentId: incident.id, notification: "not_configured" };
      }
      const reservation = await incidents.reserveNotification(
        incident.id,
        config.PUSHOVER_NOTIFICATION_COOLDOWN_MS,
      );
      if (!reservation) {
        return { diagnostic, incidentId: incident.id, notification: "cooldown" };
      }
      try {
        const sent = await pushover.send(
          incident.title,
          `${incident.message}\n\nIncident: ${incident.id}`,
        );
        return {
          diagnostic,
          incidentId: incident.id,
          notification: "sent",
          notificationRequestId: sent.requestId,
        };
      } catch (error) {
        await incidents.restoreNotificationReservation(reservation);
        return {
          diagnostic,
          incidentId: incident.id,
          notification: "failed",
          notificationError: error instanceof Error ? error.message : String(error),
        };
      }
    },

    CREATE_CONTENT_CHUNKS: async (job: Job, progress: JobProgressReporter) => {
      await progress({ phase: "chunking", message: "Rozděluji přepis na úryvky.", percent: 0 });
      const count = await createAndPersistChunks(sql, job.entityId);
      await progress({ phase: "chunking", message: "Úryvky jsou vytvořené.", percent: 100 });
      return { chunks: count };
    },

    CREATE_TEXT_EMBEDDINGS: async (job: Job, progress: JobProgressReporter) => {
      const rows = await sql`
        SELECT chunk.id, chunk.text
        FROM content_chunks chunk
        JOIN episodes episode ON episode.active_processing_run_id = chunk.processing_run_id
        WHERE chunk.episode_id = ${job.entityId}
          AND (chunk.embedding IS NULL OR chunk.embedding_model <> ${textEmbeddings.modelName})
        ORDER BY chunk.start_seconds
      `;
      await progress({
        phase: "text_embeddings",
        current: 0,
        total: Math.max(1, rows.length),
        message: "Vytvářím vyhledávací embeddingy.",
      });
      for (let offset = 0; offset < rows.length; offset += 32) {
        const batch = rows.slice(offset, offset + 32);
        const vectors = await textEmbeddings.embedDocuments(
          batch.map((row) => String(row.text)),
        );
        await sql.begin(async (tx) => {
          for (const [index, row] of batch.entries()) {
            const vector = vectors[index];
            if (!vector || vector.length !== textEmbeddings.dimensions) {
              throw new Error("Embedding provider vrátil neplatný vektor.");
            }
            await tx`
              UPDATE content_chunks
              SET embedding = ${`[${vector.join(",")}]`}::vector,
                  embedding_model = ${textEmbeddings.modelName},
                  embedding_version = '1'
              WHERE id = ${row.id}
            `;
          }
        });
        await progress({
          phase: "text_embeddings",
          current: Math.min(rows.length, offset + batch.length),
          total: Math.max(1, rows.length),
          message: "Vytvářím vyhledávací embeddingy.",
        });
      }
      await sql`UPDATE episodes SET processing_status = 'ready', processing_error = NULL,
        updated_at = now() WHERE id = ${job.entityId}`;
      return { embeddedChunks: rows.length, model: textEmbeddings.modelName };
    },
  };
}

export type PipelineHandlers = ReturnType<typeof createHandlers>;
