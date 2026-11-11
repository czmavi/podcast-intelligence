import type { Sql } from "./client.ts";

const transcriptionJobTypes = ["DOWNLOAD_AUDIO", "NORMALIZE_AUDIO", "PROCESS_AUDIO_ML"];

export interface PodcastAutomationCounts {
  totalCount: number;
  processedCount: number;
  remainingCount: number;
  failedCount: number;
  inProgressCount: number;
  unavailableCount: number;
  excludedCount: number;
  reviewCount: number;
}

export async function podcastAutomationProgress(sql: Sql, podcastId: string) {
  const [countRows, durationRows] = await Promise.all([
    sql<PodcastAutomationCounts[]>`
      WITH episode_progress AS (
        SELECT episode.*,
          (episode.processing_status = 'ready' OR EXISTS (
            SELECT 1 FROM processing_runs run
            WHERE run.episode_id = episode.id AND run.status = 'completed'
          )) AS processing_complete
        FROM episodes episode WHERE episode.podcast_id = ${podcastId}
      )
      SELECT count(*)::int AS total_count,
        count(*) FILTER (WHERE NOT rag_excluded AND processing_complete)::int AS processed_count,
        count(*) FILTER (
          WHERE NOT rag_excluded AND NOT processing_complete AND processing_status <> 'failed'
            AND (is_present_in_feed OR original_audio_path IS NOT NULL)
        )::int AS remaining_count,
        count(*) FILTER (
          WHERE NOT rag_excluded AND NOT processing_complete AND processing_status = 'failed'
        )::int AS failed_count,
        count(*) FILTER (
          WHERE NOT rag_excluded AND NOT processing_complete AND EXISTS (
            SELECT 1 FROM jobs job WHERE job.entity_type = 'episode' AND job.entity_id = episode.id
              AND job.status IN ('queued', 'running') AND job.type = ANY(${transcriptionJobTypes})
          )
        )::int AS in_progress_count,
        count(*) FILTER (
          WHERE NOT rag_excluded AND NOT processing_complete AND processing_status <> 'failed'
            AND NOT is_present_in_feed AND original_audio_path IS NULL
        )::int AS unavailable_count,
        count(*) FILTER (WHERE rag_excluded)::int AS excluded_count,
        count(*) FILTER (
          WHERE NOT rag_excluded AND NOT speaker_review_skipped AND processing_complete AND (
            transcript_selection_pending OR active_processing_run_id IS NULL OR EXISTS (
              SELECT 1 FROM speaker_clusters cluster
              WHERE cluster.processing_run_id = episode.active_processing_run_id
                AND cluster.identity_status NOT IN ('verified', 'ignored')
            )
          )
        )::int AS review_count
      FROM episode_progress episode
    `,
    sql`
      WITH latest_completed_job_per_type AS (
        SELECT DISTINCT ON (job.entity_id, job.type)
          job.entity_id, job.type, job.processing_duration_ms, job.completed_at
        FROM jobs job JOIN episodes episode ON episode.id = job.entity_id
        WHERE episode.podcast_id = ${podcastId} AND NOT episode.rag_excluded
          AND (episode.processing_status = 'ready' OR EXISTS (
            SELECT 1 FROM processing_runs run
            WHERE run.episode_id = episode.id AND run.status = 'completed'
          ))
          AND job.entity_type = 'episode' AND job.status = 'completed'
          AND job.processing_duration_ms > 0 AND job.type = ANY(${transcriptionJobTypes})
        ORDER BY job.entity_id, job.type, job.completed_at DESC
      ), episode_history AS (
        SELECT entity_id, sum(processing_duration_ms)::bigint AS active_duration_ms,
          max(completed_at) AS completed_at
        FROM latest_completed_job_per_type
        GROUP BY entity_id HAVING bool_or(type = 'PROCESS_AUDIO_ML')
        ORDER BY max(completed_at) DESC LIMIT 5
      )
      SELECT active_duration_ms FROM episode_history ORDER BY completed_at DESC
    `,
  ]);
  const counts = countRows[0];
  if (!counts) throw new Error("Chybí souhrn zpracování podcastu.");
  return { counts, durations: durationRows.map((row) => Number(row.activeDurationMs)) };
}
