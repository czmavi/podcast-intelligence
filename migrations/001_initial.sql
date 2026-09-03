CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE episode_processing_status AS ENUM (
  'new', 'imported', 'download_queued', 'downloading', 'downloaded',
  'normalization_queued', 'normalizing', 'normalized',
  'transcription_queued', 'transcribing', 'transcribed',
  'speaker_identification_pending', 'indexing_queued', 'indexing', 'ready',
  'failed'
);
CREATE TYPE job_status AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

CREATE TABLE podcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  rss_url TEXT NOT NULL UNIQUE,
  website_url TEXT,
  description TEXT,
  image_url TEXT,
  last_imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id UUID NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,
  audio_url TEXT NOT NULL,
  source_url TEXT,
  duration_seconds DOUBLE PRECISION,
  audio_mime_type TEXT,
  audio_byte_size BIGINT,
  audio_sha256 TEXT,
  original_audio_path TEXT,
  normalized_audio_path TEXT,
  processing_status episode_processing_status NOT NULL DEFAULT 'new',
  processing_error TEXT,
  active_processing_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (podcast_id, external_id)
);
CREATE INDEX episodes_podcast_published_idx ON episodes(podcast_id, published_at DESC);

CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  is_regular_host BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX persons_normalized_name_idx ON persons(normalized_name);

CREATE TABLE episode_participants (
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('moderator', 'guest', 'other', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'rss', 'title', 'description', 'llm')),
  confidence DOUBLE PRECISION CHECK (confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_id, person_id)
);

CREATE TABLE processing_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  pipeline_version TEXT NOT NULL,
  transcription_model TEXT,
  diarization_model TEXT,
  speaker_embedding_model TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error TEXT
);
ALTER TABLE episodes ADD CONSTRAINT episodes_active_run_fk
  FOREIGN KEY (active_processing_run_id) REFERENCES processing_runs(id) ON DELETE SET NULL;

CREATE TABLE speaker_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  processing_run_id UUID NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  local_label TEXT NOT NULL,
  total_speech_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  representative_start_seconds DOUBLE PRECISION,
  representative_end_seconds DOUBLE PRECISION,
  assigned_person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
  identity_confidence DOUBLE PRECISION,
  identity_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (identity_status IN ('unknown', 'suggested', 'verified', 'rejected')),
  identity_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (processing_run_id, local_label)
);

CREATE TABLE utterances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  processing_run_id UUID NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  speaker_cluster_id UUID NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
  sequence_number INTEGER NOT NULL,
  start_seconds DOUBLE PRECISION NOT NULL CHECK (start_seconds >= 0),
  end_seconds DOUBLE PRECISION NOT NULL CHECK (end_seconds >= start_seconds),
  text TEXT NOT NULL,
  transcription_confidence DOUBLE PRECISION,
  speaker_confidence DOUBLE PRECISION,
  language TEXT,
  overlap_detected BOOLEAN NOT NULL DEFAULT false,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (processing_run_id, sequence_number)
);
CREATE INDEX utterances_episode_sequence_idx ON utterances(episode_id, sequence_number);
CREATE INDEX utterances_episode_start_idx ON utterances(episode_id, start_seconds);
CREATE INDEX utterances_person_idx ON utterances(person_id);
CREATE INDEX utterances_search_idx ON utterances USING GIN(search_vector);

CREATE TABLE speaker_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_run_id UUID NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  speaker_cluster_id UUID REFERENCES speaker_clusters(id) ON DELETE CASCADE,
  utterance_id UUID REFERENCES utterances(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  model_version TEXT,
  embedding VECTOR(512) NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = 512),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('cluster_centroid', 'utterance', 'manual_reference', 'verified_cluster')
  ),
  audio_quality DOUBLE PRECISION,
  duration_seconds DOUBLE PRECISION,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX speaker_embeddings_person_idx ON speaker_embeddings(person_id) WHERE is_verified;

CREATE TABLE content_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  processing_run_id UUID NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  start_seconds DOUBLE PRECISION NOT NULL,
  end_seconds DOUBLE PRECISION NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  embedding VECTOR(384),
  embedding_model TEXT,
  embedding_version TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_chunks_search_idx ON content_chunks USING GIN(search_vector);
CREATE INDEX content_chunks_episode_time_idx ON content_chunks(episode_id, start_seconds);

CREATE TABLE content_chunk_utterances (
  content_chunk_id UUID NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  utterance_id UUID NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (content_chunk_id, utterance_id)
);

CREATE TABLE claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  claim TEXT NOT NULL,
  stance TEXT,
  certainty TEXT,
  start_seconds DOUBLE PRECISION NOT NULL,
  end_seconds DOUBLE PRECISION NOT NULL,
  extraction_confidence DOUBLE PRECISION,
  model_name TEXT,
  model_version TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE claim_utterances (
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  utterance_id UUID NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, utterance_id)
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX jobs_claim_idx ON jobs(status, available_at, priority DESC, created_at)
  WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX jobs_active_entity_type_idx ON jobs(type, entity_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE processing_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  processing_run_id UUID REFERENCES processing_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  byte_size BIGINT,
  sha256 TEXT,
  model_name TEXT,
  model_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, processing_run_id, artifact_type, storage_path)
);

CREATE TABLE speaker_identity_candidates (
  speaker_cluster_id UUID NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  voice_similarity DOUBLE PRECISION,
  metadata_score DOUBLE PRECISION,
  direct_address_score DOUBLE PRECISION,
  combined_score DOUBLE PRECISION NOT NULL,
  rank INTEGER NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (speaker_cluster_id, person_id)
);
