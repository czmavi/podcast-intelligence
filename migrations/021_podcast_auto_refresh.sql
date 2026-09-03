ALTER TABLE podcasts
  ADD COLUMN auto_refresh_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX podcasts_auto_refresh_enabled_idx
  ON podcasts (last_imported_at ASC NULLS FIRST)
  WHERE auto_refresh_enabled;
