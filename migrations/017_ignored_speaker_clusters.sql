ALTER TABLE speaker_clusters
  DROP CONSTRAINT speaker_clusters_identity_status_check;

ALTER TABLE speaker_clusters
  ADD CONSTRAINT speaker_clusters_identity_status_check
  CHECK (identity_status IN ('unknown', 'suggested', 'verified', 'rejected', 'ignored'));
