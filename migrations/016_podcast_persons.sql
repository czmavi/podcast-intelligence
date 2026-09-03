CREATE TABLE podcast_persons (
  podcast_id UUID NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('moderator', 'guest')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (podcast_id, person_id)
);

CREATE INDEX podcast_persons_person_idx ON podcast_persons(person_id);

WITH observed_associations AS (
  SELECT episode.podcast_id, participant.person_id, participant.role AS episode_role
  FROM episode_participants participant
  JOIN episodes episode ON episode.id = participant.episode_id

  UNION ALL

  SELECT episode.podcast_id, cluster.assigned_person_id, NULL::text
  FROM speaker_clusters cluster
  JOIN episodes episode ON episode.id = cluster.episode_id
  WHERE cluster.assigned_person_id IS NOT NULL

  UNION ALL

  SELECT episode.podcast_id, utterance.person_id, NULL::text
  FROM utterances utterance
  JOIN episodes episode ON episode.id = utterance.episode_id
  WHERE utterance.person_id IS NOT NULL

  UNION ALL

  SELECT episode.podcast_id, embedding.person_id, NULL::text
  FROM speaker_embeddings embedding
  JOIN processing_runs run ON run.id = embedding.processing_run_id
  JOIN episodes episode ON episode.id = run.episode_id
  WHERE embedding.person_id IS NOT NULL

  UNION ALL

  SELECT episode.podcast_id, claim.person_id, NULL::text
  FROM claims claim
  JOIN episodes episode ON episode.id = claim.episode_id
), resolved_associations AS (
  SELECT association.podcast_id, association.person_id,
    CASE
      WHEN bool_or(association.episode_role = 'moderator') THEN 'moderator'
      WHEN bool_or(association.episode_role = 'guest') THEN 'guest'
      WHEN bool_or(person.is_regular_host) THEN 'moderator'
      ELSE 'guest'
    END AS role
  FROM observed_associations association
  JOIN persons person ON person.id = association.person_id
  GROUP BY association.podcast_id, association.person_id
)
INSERT INTO podcast_persons (podcast_id, person_id, role)
SELECT podcast_id, person_id, role
FROM resolved_associations;
