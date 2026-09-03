ALTER TABLE podcasts
  ADD COLUMN auto_process_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX podcasts_auto_process_enabled_idx
  ON podcasts (updated_at DESC)
  WHERE auto_process_enabled;
