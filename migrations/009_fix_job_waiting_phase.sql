CREATE OR REPLACE FUNCTION job_progress_is_waiting(phase TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(phase = 'waiting_for_slot', false)
    OR right(coalesce(phase, ''), 5) = '_wait'
$$;
