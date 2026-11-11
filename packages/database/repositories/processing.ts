import type { Sql } from "../client.ts";
import type { ProcessAudioResponse } from "../../domain/schemas.ts";

function vectorLiteral(values: number[]): string {
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Embedding obsahuje NaN.");
  return `[${values.join(",")}]`;
}

export async function saveProcessingResult(
  sql: Sql,
  result: ProcessAudioResponse,
  transcriptPath: string,
  sourceJobId: string,
  options: { candidate?: boolean; provider?: "local" | "elevenlabs"; maxAttempts?: number } = {},
): Promise<string> {
  return await sql.begin(async (tx) => {
    await tx`SELECT id FROM episodes WHERE id = ${result.episodeId} FOR UPDATE`;
    const existing = (await tx`
      SELECT id FROM processing_runs WHERE source_job_id = ${sourceJobId}
    `)[0];
    if (existing) return String(existing.id);
    const previous = await tx`SELECT id FROM processing_runs
      WHERE episode_id = ${result.episodeId} AND status = 'completed' LIMIT 1`;
    const selectionPending = options.candidate === true && previous.length > 0;
    const autoContinue = options.candidate === true && !selectionPending;
    const runRows = await tx`
      INSERT INTO processing_runs (
        episode_id, status, pipeline_version, transcription_model,
        diarization_model, speaker_embedding_model, source_job_id,
        transcript_alignment_mode, asr_correction_metadata, transcription_provider
      ) VALUES (
        ${result.episodeId}, 'running', ${result.schemaVersion},
        ${result.models.transcription.name}, ${result.models.diarization?.name ?? null},
        ${result.models.speakerEmbedding?.name ?? null}, ${sourceJobId},
        ${result.transcriptAlignmentMode},
        ${result.asrCorrection ? tx.json(result.asrCorrection) : null},
        ${options.provider ?? "local"}
      )
      RETURNING id
    `;
    const runId = String(runRows[0]?.id);
    const clusterIds = new Map<string, string>();
    for (const speaker of result.speakers) {
      const representative = speaker.representativeSegments[0];
      const rows = await tx`
        INSERT INTO speaker_clusters (
          episode_id, processing_run_id, local_label, total_speech_seconds,
          segment_count, representative_start_seconds, representative_end_seconds
        ) VALUES (
          ${result.episodeId}, ${runId}, ${speaker.label}, ${speaker.speechSeconds},
          ${speaker.segmentCount}, ${representative?.start ?? null}, ${representative?.end ?? null}
        )
        RETURNING id
      `;
      const clusterId = String(rows[0]?.id);
      clusterIds.set(speaker.label, clusterId);
      if (speaker.embedding) {
        if (speaker.embedding.length !== 256) {
          throw new Error(`Speaker embedding má ${speaker.embedding.length} místo 256 rozměrů.`);
        }
        await tx`
          INSERT INTO speaker_embeddings (
            processing_run_id, speaker_cluster_id, model_name, model_version,
            embedding, dimensions, source_type,
            duration_seconds, is_verified
          ) VALUES (
            ${runId}, ${clusterId}, ${result.models.speakerEmbedding?.name ?? "unknown"},
            ${result.models.speakerEmbedding?.version ?? null},
            ${vectorLiteral(speaker.embedding)}::vector, 256, 'cluster_centroid',
            ${speaker.speechSeconds}, false
          )
        `;
      }
    }
    for (const utterance of result.utterances) {
      const clusterId = clusterIds.get(utterance.speaker);
      if (!clusterId) throw new Error(`Chybí cluster ${utterance.speaker}.`);
      await tx`
        INSERT INTO utterances (
          episode_id, processing_run_id, speaker_cluster_id, sequence_number,
          start_seconds, end_seconds, text, transcription_confidence,
          speaker_confidence, language, overlap_detected, playback_start_seconds,
          raw_text, asr_corrections
        ) VALUES (
          ${result.episodeId}, ${runId}, ${clusterId}, ${utterance.sequence},
          ${utterance.start}, ${utterance.end}, ${utterance.text},
          ${utterance.transcriptionConfidence}, ${utterance.speakerConfidence},
          ${result.detectedLanguage}, ${utterance.overlapDetected},
          ${utterance.playbackStart ?? utterance.start}, ${utterance.rawText ?? null},
          ${utterance.corrections ? tx.json(utterance.corrections) : null}
        )
      `;
    }
    const stat = await Deno.stat(transcriptPath);
    await tx`
      INSERT INTO processing_artifacts (
        episode_id, processing_run_id, artifact_type, storage_path, mime_type,
        byte_size, model_name, model_version, metadata
      ) VALUES (
        ${result.episodeId}, ${runId}, 'transcript_json', ${transcriptPath},
        'application/json', ${stat.size}, ${result.models.transcription.name},
        ${result.models.transcription.version},
        ${
      tx.json({
        schemaVersion: result.schemaVersion,
        transcriptAlignmentMode: result.transcriptAlignmentMode,
        asrCorrection: result.asrCorrection ?? null,
        warnings: result.warnings,
      })
    }
      )
    `;
    await tx`
      UPDATE processing_runs
      SET status = 'completed', completed_at = now()
      WHERE id = ${runId}
    `;
    await tx`
      UPDATE episodes
      SET active_processing_run_id = CASE WHEN ${selectionPending}
            THEN active_processing_run_id ELSE ${runId}::uuid END,
          transcript_selection_pending = ${selectionPending},
          processing_status = ${autoContinue ? "speaker_identification_pending" : "transcribed"},
          duration_seconds = ${result.durationSeconds}, processing_error = NULL, updated_at = now()
      WHERE id = ${result.episodeId}
    `;
    if (autoContinue) {
      await tx`INSERT INTO jobs (type, entity_type, entity_id, payload, max_attempts)
        VALUES ('IDENTIFY_SPEAKERS', 'episode', ${result.episodeId},
          ${tx.json({ processingRunId: runId })}, ${options.maxAttempts ?? 3})`;
    }
    return runId;
  });
}
