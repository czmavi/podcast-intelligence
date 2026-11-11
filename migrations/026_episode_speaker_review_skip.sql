ALTER TABLE episodes
  ADD COLUMN speaker_review_skipped BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN episodes.speaker_review_skipped IS
  'Manual, reversible exclusion from speaker review navigation; preserves processing and transcript data.';
