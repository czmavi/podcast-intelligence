import type { Sql } from "./client.ts";
import { JobRepository } from "./repositories/jobs.ts";
import type { JobType } from "../domain/job-types.ts";
import { DomainError, NotFoundError } from "../domain/errors.ts";
import { transcriptAlignmentModeSchema } from "../domain/schemas.ts";

interface EpisodeArtifacts {
  originalAudioPath: unknown;
  normalizedAudioPath: unknown;
  activeProcessingRunId: unknown;
  ragExcluded?: unknown;
  transcriptAlignmentMode?: unknown;
}

interface EpisodeSchedulingStep {
  type: Extract<
    JobType,
    "DOWNLOAD_AUDIO" | "NORMALIZE_AUDIO" | "PROCESS_AUDIO_ML" | "CREATE_CONTENT_CHUNKS"
  >;
  status:
    | "download_queued"
    | "normalization_queued"
    | "transcription_queued"
    | "indexing_queued";
}

export type EpisodeProcessingMode = "resume" | "full";

export interface ScheduledEpisode {
  episodeId: string;
  podcastId: string;
  jobId: string;
  type: EpisodeSchedulingStep["type"];
}

export interface BulkDownloadScheduleResult {
  podcastId: string;
  eligibleCount: number;
  queuedCount: number;
  alreadyQueuedCount: number;
}

export function episodeSchedulingStep(
  episode: EpisodeArtifacts,
  mode: EpisodeProcessingMode = "resume",
): EpisodeSchedulingStep {
  if (!episode.originalAudioPath) {
    return { type: "DOWNLOAD_AUDIO", status: "download_queued" };
  }
  if (!episode.normalizedAudioPath) {
    return { type: "NORMALIZE_AUDIO", status: "normalization_queued" };
  }
  if (mode === "full") {
    return { type: "PROCESS_AUDIO_ML", status: "transcription_queued" };
  }
  if (!episode.activeProcessingRunId) {
    return { type: "PROCESS_AUDIO_ML", status: "transcription_queued" };
  }
  return { type: "CREATE_CONTENT_CHUNKS", status: "indexing_queued" };
}

export async function scheduleEpisode(
  sql: Sql,
  episodeId: string,
  maxAttempts: number,
  mode: EpisodeProcessingMode = "resume",
): Promise<{ jobId: string; type: EpisodeSchedulingStep["type"] }> {
  const rows = await sql`
    SELECT episode.original_audio_path, episode.normalized_audio_path,
      episode.active_processing_run_id, episode.rag_excluded, podcast.transcript_alignment_mode
    FROM episodes episode
    JOIN podcasts podcast ON podcast.id = episode.podcast_id
    WHERE episode.id = ${episodeId}
  `;
  if (!rows[0]) throw new NotFoundError("Epizoda");
  if (rows[0].ragExcluded === true) {
    throw new DomainError(
      "Epizoda je vyloučená z RAG. Před novým zpracováním ji znovu zahrňte.",
      "EPISODE_RAG_EXCLUDED",
      409,
    );
  }
  const step = episodeSchedulingStep(rows[0] as unknown as EpisodeArtifacts, mode);
  const jobs = new JobRepository(sql);
  const payload = step.type === "PROCESS_AUDIO_ML"
    ? {
      ...(mode === "full" ? { force: true } : {}),
      transcriptAlignmentMode: transcriptAlignmentModeSchema.parse(
        rows[0].transcriptAlignmentMode,
      ),
    }
    : {};
  const jobId = await jobs.enqueue(step.type, "episode", episodeId, payload, 0, maxAttempts);
  await sql`
    UPDATE episodes SET processing_status = ${step.status}, processing_error = NULL,
      updated_at = now()
    WHERE id = ${episodeId}
  `;
  return { jobId, type: step.type };
}

export async function scheduleMissingPodcastDownloads(
  sql: Sql,
  podcastId: string,
  maxAttempts: number,
): Promise<BulkDownloadScheduleResult> {
  return await sql.begin(async (tx) => {
    const podcast = (await tx`SELECT id FROM podcasts WHERE id = ${podcastId} FOR UPDATE`)[0];
    if (!podcast) throw new NotFoundError("Podcast");

    const candidates = await tx`
      SELECT episode.id
      FROM episodes episode
      WHERE episode.podcast_id = ${podcastId}
        AND episode.original_audio_path IS NULL
        AND episode.is_present_in_feed
        AND NOT episode.rag_excluded
        AND NOT EXISTS (
          SELECT 1
          FROM jobs active_job
          WHERE active_job.entity_type = 'episode'
            AND active_job.entity_id = episode.id
            AND active_job.status IN ('queued', 'running')
            AND active_job.type <> 'DOWNLOAD_AUDIO'
        )
      ORDER BY episode.published_at DESC NULLS LAST, episode.created_at DESC
      FOR UPDATE OF episode
    `;
    if (candidates.length === 0) {
      return { podcastId, eligibleCount: 0, queuedCount: 0, alreadyQueuedCount: 0 };
    }

    const candidateIds = candidates.map((episode) => String(episode.id));
    const inserted = await tx`
      INSERT INTO jobs (
        type, entity_type, entity_id, payload, priority, max_attempts
      )
      SELECT
        'DOWNLOAD_AUDIO', 'episode', episode.id,
        '{"continuePipeline":false,"source":"bulk_prefetch"}'::jsonb,
        -20, ${maxAttempts}
      FROM episodes episode
      WHERE episode.id = ANY(${candidateIds}::uuid[])
      ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
      DO NOTHING
      RETURNING entity_id
    `;
    const insertedIds = inserted.map((job) => String(job.entityId));
    if (insertedIds.length > 0) {
      await tx`
        UPDATE episodes
        SET processing_status = 'download_queued', processing_error = NULL, updated_at = now()
        WHERE id = ANY(${insertedIds}::uuid[])
      `;
    }
    return {
      podcastId,
      eligibleCount: candidateIds.length,
      queuedCount: insertedIds.length,
      alreadyQueuedCount: candidateIds.length - insertedIds.length,
    };
  });
}

export async function scheduleNextAutoProcessEpisode(
  sql: Sql,
  maxAttempts: number,
): Promise<ScheduledEpisode | null> {
  return await sql.begin(async (tx) => {
    // Serializes all autopilot schedulers, including schedulers in other worker processes.
    await tx`SELECT pg_advisory_xact_lock(1635087391)`;
    const activeJobs = await tx`
      SELECT 1
      FROM jobs
      WHERE status IN ('queued', 'running')
        AND NOT (
          type = 'DOWNLOAD_AUDIO'
          AND payload->>'source' = 'bulk_prefetch'
          AND payload->>'continuePipeline' = 'false'
        )
      LIMIT 1
    `;
    if (activeJobs.length > 0) return null;

    const candidates = await tx`
      SELECT episode.id, episode.podcast_id, episode.original_audio_path,
        episode.normalized_audio_path, episode.active_processing_run_id
      FROM episodes episode
      JOIN podcasts podcast ON podcast.id = episode.podcast_id
      WHERE podcast.auto_process_enabled
        AND NOT episode.rag_excluded
        AND episode.processing_status NOT IN ('ready', 'failed')
        AND (episode.is_present_in_feed OR episode.original_audio_path IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM jobs active_episode_job
          WHERE active_episode_job.entity_type = 'episode'
            AND active_episode_job.entity_id = episode.id
            AND active_episode_job.status IN ('queued', 'running')
        )
      ORDER BY (episode.original_audio_path IS NOT NULL) DESC,
        episode.published_at DESC NULLS LAST, episode.created_at DESC
      FOR UPDATE OF episode SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    const step = episodeSchedulingStep(candidate as unknown as EpisodeArtifacts);
    const inserted = await tx`
      INSERT INTO jobs (
        type, entity_type, entity_id, payload, priority, max_attempts
      ) VALUES (
        ${step.type}, 'episode', ${candidate.id}, '{}'::jsonb, -10, ${maxAttempts}
      )
      ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
      DO UPDATE SET priority = GREATEST(jobs.priority, EXCLUDED.priority)
      RETURNING id
    `;
    await tx`
      UPDATE episodes SET processing_status = ${step.status}, processing_error = NULL,
        updated_at = now()
      WHERE id = ${candidate.id}
    `;
    return {
      episodeId: String(candidate.id),
      podcastId: String(candidate.podcastId),
      jobId: String(inserted[0]?.id),
      type: step.type,
    };
  });
}
