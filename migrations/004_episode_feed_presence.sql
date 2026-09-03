ALTER TABLE episodes
  ADD COLUMN is_present_in_feed BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN last_seen_in_feed_at TIMESTAMPTZ,
  ADD COLUMN missing_from_feed_since TIMESTAMPTZ;

UPDATE episodes episode
SET last_seen_in_feed_at = COALESCE(podcast.last_imported_at, episode.created_at)
FROM podcasts podcast
WHERE podcast.id = episode.podcast_id;

CREATE INDEX episodes_missing_from_feed_idx
  ON episodes(podcast_id, published_at DESC)
  WHERE is_present_in_feed = false;
