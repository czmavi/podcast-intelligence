ALTER TABLE processing_runs
  ADD COLUMN source_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX processing_runs_source_job_idx
  ON processing_runs(source_job_id)
  WHERE source_job_id IS NOT NULL;
