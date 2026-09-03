ALTER TABLE podcasts
  ADD COLUMN storage_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_audio_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_transcript_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_other_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT podcasts_storage_byte_size_nonnegative CHECK (
    storage_byte_size >= 0
    AND storage_audio_byte_size >= 0
    AND storage_transcript_byte_size >= 0
    AND storage_other_byte_size >= 0
  );

ALTER TABLE episodes
  ADD COLUMN storage_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_audio_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_transcript_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN storage_other_byte_size BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT episodes_storage_byte_size_nonnegative CHECK (
    storage_byte_size >= 0
    AND storage_audio_byte_size >= 0
    AND storage_transcript_byte_size >= 0
    AND storage_other_byte_size >= 0
  );
