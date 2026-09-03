ALTER TABLE jobs
  ADD COLUMN progress_phase TEXT,
  ADD COLUMN progress_current INTEGER,
  ADD COLUMN progress_total INTEGER,
  ADD COLUMN progress_percent DOUBLE PRECISION,
  ADD COLUMN progress_message TEXT,
  ADD COLUMN progress_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT jobs_progress_current_nonnegative CHECK (
    progress_current IS NULL OR progress_current >= 0
  ),
  ADD CONSTRAINT jobs_progress_total_positive CHECK (
    progress_total IS NULL OR progress_total > 0
  ),
  ADD CONSTRAINT jobs_progress_percent_range CHECK (
    progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100
  );

-- Embeddingy jsou odvozená data a po změně modelu je nelze převést mezi rozměry.
UPDATE content_chunks
SET embedding = NULL, embedding_model = NULL, embedding_version = NULL;

ALTER TABLE content_chunks
  ALTER COLUMN embedding TYPE VECTOR(1024);
