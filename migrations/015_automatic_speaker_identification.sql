ALTER TABLE episode_participants
  DROP CONSTRAINT episode_participants_source_check;

ALTER TABLE episode_participants
  ADD CONSTRAINT episode_participants_source_check
  CHECK (source IN ('manual', 'rss', 'title', 'description', 'llm', 'voice_match'));
