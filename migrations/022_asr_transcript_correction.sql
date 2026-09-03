ALTER TABLE podcasts
  DROP CONSTRAINT podcasts_transcript_alignment_mode_check;

ALTER TABLE podcasts
  ADD CONSTRAINT podcasts_transcript_alignment_mode_check
  CHECK (transcript_alignment_mode IN ('segment', 'overlap', 'overlap_asr_corrected'));

ALTER TABLE processing_runs
  DROP CONSTRAINT processing_runs_transcript_alignment_mode_check;

ALTER TABLE processing_runs
  ADD CONSTRAINT processing_runs_transcript_alignment_mode_check
  CHECK (transcript_alignment_mode IN ('segment', 'overlap', 'overlap_asr_corrected'));

ALTER TABLE processing_runs
  ADD COLUMN asr_correction_metadata JSONB;

ALTER TABLE utterances
  ADD COLUMN raw_text TEXT,
  ADD COLUMN asr_corrections JSONB;

COMMENT ON COLUMN utterances.raw_text IS
  'Původní diarizovaný Whisper text před volitelnou ASR korekcí.';
COMMENT ON COLUMN utterances.asr_corrections IS
  'Audit všech navržených, aplikovaných i odmítnutých ASR korekcí.';
