CREATE INDEX jobs_episode_completed_history_idx
  ON jobs(entity_id, completed_at DESC)
  WHERE entity_type = 'episode' AND status = 'completed';
