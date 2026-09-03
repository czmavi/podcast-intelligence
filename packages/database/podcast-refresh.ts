import type { Sql } from "./client.ts";

export interface ScheduledPodcastRefresh {
  podcastId: string;
  jobId: string;
}

export async function scheduleDuePodcastRefresh(
  sql: Sql,
  maxAttempts: number,
): Promise<ScheduledPodcastRefresh | null> {
  return await sql.begin(async (tx) => {
    // Serializes daily RSS schedulers across all worker processes.
    await tx`SELECT pg_advisory_xact_lock(1635087392)`;
    const candidates = await tx`
      SELECT podcast.id
      FROM podcasts podcast
      WHERE podcast.auto_refresh_enabled
        AND COALESCE(podcast.last_imported_at, podcast.created_at)
          <= now() - interval '1 day'
        AND NOT EXISTS (
          SELECT 1
          FROM jobs refresh_job
          WHERE refresh_job.type = 'IMPORT_FEED'
            AND refresh_job.entity_type = 'podcast'
            AND refresh_job.entity_id = podcast.id
            AND (
              refresh_job.status IN ('queued', 'running')
              OR refresh_job.created_at > now() - interval '1 day'
            )
        )
      ORDER BY podcast.last_imported_at ASC NULLS FIRST, podcast.created_at ASC
      FOR UPDATE OF podcast SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    const inserted = await tx`
      INSERT INTO jobs (
        type, entity_type, entity_id, payload, priority, max_attempts
      ) VALUES (
        'IMPORT_FEED', 'podcast', ${candidate.id},
        '{"source":"daily_auto_refresh"}'::jsonb, -30, ${maxAttempts}
      )
      ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
      DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) return null;
    return {
      podcastId: String(candidate.id),
      jobId: String(inserted[0].id),
    };
  });
}
