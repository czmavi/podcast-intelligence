ALTER TABLE content_chunks
  ADD COLUMN normalized_search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      translate(
        lower(coalesce(text, '')),
        'áčďéěíňóřšťúůýž',
        'acdeeinorstuuyz'
      )
    )
  ) STORED;

CREATE INDEX content_chunks_normalized_search_idx
  ON content_chunks USING GIN(normalized_search_vector);
