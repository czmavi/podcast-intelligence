ALTER TABLE podcasts
  ADD COLUMN transcript_alignment_mode TEXT NOT NULL DEFAULT 'segment'
    CHECK (transcript_alignment_mode IN ('segment', 'overlap'));

ALTER TABLE processing_runs
  ADD COLUMN transcript_alignment_mode TEXT NOT NULL DEFAULT 'segment'
    CHECK (transcript_alignment_mode IN ('segment', 'overlap'));

-- Verze 2 už používala jemné proporcionální zarovnání, pouze režim ještě
-- nebyl uložen explicitně.
UPDATE processing_runs
SET transcript_alignment_mode = 'overlap'
WHERE pipeline_version = '2';

ALTER TABLE utterances
  ADD COLUMN playback_start_seconds DOUBLE PRECISION
    CHECK (playback_start_seconds IS NULL OR playback_start_seconds >= 0);

UPDATE utterances
SET playback_start_seconds = start_seconds
WHERE playback_start_seconds IS NULL;

ALTER TABLE content_chunks
  ADD COLUMN playback_start_seconds DOUBLE PRECISION
    CHECK (playback_start_seconds IS NULL OR playback_start_seconds >= 0);

UPDATE content_chunks
SET playback_start_seconds = start_seconds
WHERE playback_start_seconds IS NULL;
