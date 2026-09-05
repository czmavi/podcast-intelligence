ALTER TABLE podcasts
  ADD COLUMN auto_download_enabled BOOLEAN NOT NULL DEFAULT false;
