import type { Sql } from "./client.ts";
import type { CreateTranscriptInput } from "../domain/schemas.ts";
import { DomainError, NotFoundError } from "../domain/errors.ts";

export async function scheduleTranscript(
  sql: Sql,
  episodeId: string,
  input: CreateTranscriptInput,
  maxAttempts: number,
): Promise<{ jobId: string }> {
  return await sql.begin(async (tx) => {
    const episode = (await tx`SELECT * FROM episodes WHERE id = ${episodeId} FOR UPDATE`)[0];
    if (!episode) throw new NotFoundError("Epizoda");
    if (episode.ragExcluded) {
      throw new DomainError(
        "Nejdříve znovu povolte RAG pro tuto epizodu.",
        "EPISODE_RAG_EXCLUDED",
        409,
      );
    }
    if (
      !episode.originalAudioPath || (input.provider === "local" && !episode.normalizedAudioPath)
    ) {
      throw new DomainError(
        "Nejdříve stáhněte a pro lokální přepis zpracujte audio epizody.",
        "AUDIO_NOT_AVAILABLE",
        409,
      );
    }
    const active = await tx`SELECT id FROM jobs WHERE entity_type = 'episode'
      AND entity_id = ${episodeId} AND status IN ('queued', 'running') LIMIT 1`;
    if (active.length) {
      throw new DomainError(
        "Pro epizodu již běží úloha. Počkejte na její dokončení.",
        "EPISODE_BUSY",
        409,
      );
    }
    const jobs = await tx`
      INSERT INTO jobs (type, entity_type, entity_id, payload, max_attempts)
      VALUES ('PROCESS_AUDIO_ML', 'episode', ${episodeId}, ${
      tx.json({
        force: true,
        nonBlocking: true,
        continuePipeline: false,
        transcriptProvider: input.provider,
        transcriptAlignmentMode: input.transcriptAlignmentMode,
      })
    }, ${input.provider === "elevenlabs" ? 1 : maxAttempts})
      RETURNING id
    `;
    return { jobId: String(jobs[0]?.id) };
  });
}

export async function selectTranscript(
  sql: Sql,
  episodeId: string,
  runId: string,
  maxAttempts: number,
): Promise<{ runId: string; jobId: string | null }> {
  return await sql.begin(async (tx) => {
    const episode = (await tx`SELECT * FROM episodes WHERE id = ${episodeId} FOR UPDATE`)[0];
    if (!episode) throw new NotFoundError("Epizoda");
    if (episode.ragExcluded) {
      throw new DomainError(
        "Nejdříve znovu povolte RAG pro tuto epizodu.",
        "EPISODE_RAG_EXCLUDED",
        409,
      );
    }
    const run = (await tx`SELECT id FROM processing_runs
      WHERE id = ${runId} AND episode_id = ${episodeId} AND status = 'completed'`)[0];
    if (!run) throw new NotFoundError("Dokončený přepis této epizody");
    if (episode.activeProcessingRunId === runId && !episode.transcriptSelectionPending) {
      return { runId, jobId: null };
    }
    const active = await tx`SELECT id FROM jobs WHERE entity_type = 'episode'
      AND entity_id = ${episodeId} AND status IN ('queued', 'running') LIMIT 1`;
    if (active.length) {
      throw new DomainError("Přepis lze vybrat po dokončení úloh epizody.", "EPISODE_BUSY", 409);
    }
    await tx`UPDATE episodes SET active_processing_run_id = ${runId},
      transcript_selection_pending = false, processing_status = 'speaker_identification_pending',
      processing_error = NULL, updated_at = now() WHERE id = ${episodeId}`;
    const jobs = await tx`
      INSERT INTO jobs (type, entity_type, entity_id, payload, max_attempts)
      VALUES ('IDENTIFY_SPEAKERS', 'episode', ${episodeId},
        ${tx.json({ processingRunId: runId })}, ${maxAttempts}) RETURNING id
    `;
    return { runId, jobId: String(jobs[0]?.id) };
  });
}

export async function listTranscripts(sql: Sql, episodeId: string) {
  return await sql`
    SELECT run.*,
      (SELECT count(*)::int FROM speaker_clusters WHERE processing_run_id = run.id) AS speaker_count,
      (SELECT count(*)::int FROM utterances WHERE processing_run_id = run.id) AS utterance_count
    FROM processing_runs run WHERE run.episode_id = ${episodeId} AND run.status = 'completed'
    ORDER BY run.started_at DESC, run.id DESC
  `;
}
