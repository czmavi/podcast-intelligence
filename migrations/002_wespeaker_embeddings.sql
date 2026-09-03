ALTER TABLE speaker_embeddings
  DROP CONSTRAINT speaker_embeddings_dimensions_check;

ALTER TABLE speaker_embeddings
  ALTER COLUMN embedding TYPE VECTOR(256);

ALTER TABLE speaker_embeddings
  ADD CONSTRAINT speaker_embeddings_dimensions_check CHECK (dimensions = 256);
