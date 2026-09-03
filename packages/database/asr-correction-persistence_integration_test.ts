import { assertEquals } from "@std/assert";
import type { ProcessAudioResponse } from "../domain/schemas.ts";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { JobRepository } from "./repositories/jobs.ts";
import { saveProcessingResult } from "./repositories/processing.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: ASR run uloží raw i korigovaný text a audit",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const transcriptPath = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url, transcript_alignment_mode)
        VALUES (
          ${podcastId}, 'ASR persistence', ${`https://example.test/${podcastId}.xml`},
          'overlap_asr_corrected'
        )
      `;
      await sql`
        INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, processing_status)
        VALUES (
          ${episodeId}, ${podcastId}, 'asr-persistence', 'ASR persistence',
          'https://example.test/audio.mp3', 'transcribing'
        )
      `;
      const jobId = await new JobRepository(sql).enqueue(
        "PROCESS_AUDIO_ML",
        "episode",
        episodeId,
        { transcriptAlignmentMode: "overlap_asr_corrected" },
      );
      const correction = {
        originalText: "níž",
        replacementText: "niche",
        startChar: 11,
        endChar: 14,
        reason: "english_term" as const,
        confidence: 0.94,
        applied: true,
      };
      const result: ProcessAudioResponse = {
        schemaVersion: "3",
        episodeId,
        transcriptAlignmentMode: "overlap_asr_corrected",
        durationSeconds: 30,
        detectedLanguage: "cs",
        models: {
          transcription: { name: "whisper", version: "alignment-v3" },
          diarization: { name: "pyannote", version: "4" },
          speakerEmbedding: null,
        },
        speakers: [{
          label: "SPEAKER_02",
          speechSeconds: 5,
          segmentCount: 1,
          representativeSegments: [],
          embedding: null,
        }],
        utterances: [{
          sequence: 0,
          start: 10,
          end: 15,
          playbackStart: 9,
          speaker: "SPEAKER_02",
          text: "Specifická niche.",
          rawText: "Specifická níž.",
          corrections: [correction],
          transcriptionConfidence: null,
          speakerConfidence: 0.9,
          overlapDetected: false,
        }],
        warnings: [],
        asrCorrection: {
          status: "completed",
          model: "test-model",
          contextSeconds: 90,
          autoApplyThreshold: 0.85,
          processedSegments: 1,
          proposedEdits: 1,
          appliedEdits: 1,
          rejectedBelowThreshold: 0,
          rejectedUnsafe: 0,
          modelFailures: 0,
          durationMs: 20,
          promptTokens: 100,
          completionTokens: 20,
        },
      };
      await Deno.writeTextFile(transcriptPath, JSON.stringify(result));
      const runId = await saveProcessingResult(sql, result, transcriptPath, jobId);
      const rows = await sql`
        SELECT run.transcript_alignment_mode, run.asr_correction_metadata,
          utterance.text, utterance.raw_text, utterance.asr_corrections,
          cluster.local_label, utterance.start_seconds, utterance.end_seconds,
          utterance.playback_start_seconds
        FROM processing_runs run
        JOIN utterances utterance ON utterance.processing_run_id = run.id
        JOIN speaker_clusters cluster ON cluster.id = utterance.speaker_cluster_id
        WHERE run.id = ${runId}
      `;
      assertEquals(rows[0], {
        transcriptAlignmentMode: "overlap_asr_corrected",
        asrCorrectionMetadata: result.asrCorrection,
        text: "Specifická niche.",
        rawText: "Specifická níž.",
        asrCorrections: [correction],
        localLabel: "SPEAKER_02",
        startSeconds: 10,
        endSeconds: 15,
        playbackStartSeconds: 9,
      });
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ${episodeId}`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await Deno.remove(transcriptPath).catch(() => undefined);
      await sql.end({ timeout: 5 });
    }
  },
});
