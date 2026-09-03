INSERT INTO jobs (
  type, entity_type, entity_id, payload, priority
)
SELECT
  'IDENTIFY_SPEAKERS', 'episode', episode.id,
  '{"continuePipeline":false,"nonBlocking":true,"source":"guest_identification_backfill"}'::jsonb,
  10
FROM episodes episode
WHERE episode.active_processing_run_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM speaker_clusters assigned_cluster
    JOIN podcast_persons moderator
      ON moderator.podcast_id = episode.podcast_id
      AND moderator.person_id = assigned_cluster.assigned_person_id
      AND moderator.role = 'moderator'
    WHERE assigned_cluster.episode_id = episode.id
      AND assigned_cluster.processing_run_id = episode.active_processing_run_id
      AND assigned_cluster.identity_status = 'verified'
  )
  AND (
    SELECT count(*)
    FROM speaker_clusters remaining_cluster
    WHERE remaining_cluster.episode_id = episode.id
      AND remaining_cluster.processing_run_id = episode.active_processing_run_id
      AND remaining_cluster.assigned_person_id IS NULL
      AND remaining_cluster.identity_status = 'unknown'
  ) = 1
ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
DO NOTHING;
