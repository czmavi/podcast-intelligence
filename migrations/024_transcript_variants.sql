ALTER TABLE processing_runs
  ADD COLUMN transcription_provider TEXT NOT NULL DEFAULT 'local'
    CHECK (transcription_provider IN ('local', 'elevenlabs'));

ALTER TABLE episodes
  ADD COLUMN transcript_selection_pending BOOLEAN NOT NULL DEFAULT false;
