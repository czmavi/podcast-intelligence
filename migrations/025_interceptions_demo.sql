-- Izolované demo „Odposlechy“. Záměrně nemá vazby na podcastové tabulky,
-- aby bylo možné celý modul později odstranit jedinou dopřednou migrací.
CREATE TYPE interception_processing_status AS ENUM (
  'queued', 'processing', 'ready', 'failed'
);

CREATE TABLE interception_persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX interception_persons_name_idx ON interception_persons(normalized_name);

CREATE TABLE interceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  original_audio_path TEXT NOT NULL,
  normalized_audio_path TEXT,
  audio_mime_type TEXT NOT NULL,
  audio_byte_size BIGINT NOT NULL CHECK (audio_byte_size > 0),
  audio_sha256 TEXT NOT NULL,
  duration_seconds DOUBLE PRECISION,
  speaker_count INTEGER NOT NULL CHECK (speaker_count BETWEEN 1 AND 10),
  processing_mode TEXT NOT NULL CHECK (
    processing_mode IN ('segment', 'overlap', 'overlap_asr_corrected')
  ),
  processing_status interception_processing_status NOT NULL DEFAULT 'queued',
  processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX interceptions_created_idx ON interceptions(created_at DESC);

CREATE TABLE interception_speakers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interception_id UUID NOT NULL REFERENCES interceptions(id) ON DELETE CASCADE,
  local_label TEXT NOT NULL,
  total_speech_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  representative_start_seconds DOUBLE PRECISION,
  representative_end_seconds DOUBLE PRECISION,
  assigned_person_id UUID REFERENCES interception_persons(id) ON DELETE SET NULL,
  assignment_source TEXT CHECK (assignment_source IN ('manual', 'automatic')),
  assignment_confidence DOUBLE PRECISION CHECK (assignment_confidence BETWEEN 0 AND 1),
  embedding VECTOR(256),
  embedding_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interception_id, local_label)
);

CREATE TABLE interception_utterances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interception_id UUID NOT NULL REFERENCES interceptions(id) ON DELETE CASCADE,
  speaker_id UUID NOT NULL REFERENCES interception_speakers(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  start_seconds DOUBLE PRECISION NOT NULL CHECK (start_seconds >= 0),
  end_seconds DOUBLE PRECISION NOT NULL CHECK (end_seconds >= start_seconds),
  playback_start_seconds DOUBLE PRECISION NOT NULL CHECK (playback_start_seconds >= 0),
  text TEXT NOT NULL,
  language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interception_id, sequence_number)
);
CREATE INDEX interception_utterances_time_idx
  ON interception_utterances(interception_id, sequence_number);

CREATE TABLE interception_person_voice_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES interception_persons(id) ON DELETE CASCADE,
  speaker_id UUID NOT NULL REFERENCES interception_speakers(id) ON DELETE CASCADE,
  embedding VECTOR(256) NOT NULL,
  model_name TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, speaker_id)
);
CREATE INDEX interception_voice_person_idx
  ON interception_person_voice_references(person_id) WHERE is_verified;
