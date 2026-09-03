ALTER TABLE utterances
  ADD COLUMN speaker_assignment_source TEXT NOT NULL DEFAULT 'cluster'
  CHECK (speaker_assignment_source IN ('cluster', 'manual'));

CREATE INDEX utterances_manual_speaker_idx
  ON utterances (episode_id, sequence_number)
  WHERE speaker_assignment_source = 'manual';
