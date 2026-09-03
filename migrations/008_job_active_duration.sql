ALTER TABLE jobs
  ADD COLUMN active_started_at TIMESTAMPTZ,
  ADD COLUMN processing_duration_ms BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT jobs_processing_duration_nonnegative CHECK (processing_duration_ms >= 0);

-- U dokončených historických úloh je started_at nejpřesnější dostupný začátek práce.
UPDATE jobs
SET processing_duration_ms = GREATEST(
  0,
  round(extract(epoch FROM (completed_at - started_at)) * 1000)::bigint
)
WHERE status IN ('completed', 'failed', 'cancelled')
  AND started_at IS NOT NULL
  AND completed_at IS NOT NULL;

-- U běžících úloh použijeme začátek aktuálního claimu. Čekání uvnitř audio ML se nepočítá.
UPDATE jobs
SET active_started_at = CASE
  WHEN progress_phase = 'waiting_for_slot' OR right(coalesce(progress_phase, ''), 5) = '_wait'
    THEN NULL
  ELSE coalesce(locked_at, started_at, now())
END
WHERE status = 'running';

CREATE FUNCTION job_progress_is_waiting(phase TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(phase = 'waiting_for_slot', false)
    OR right(coalesce(phase, ''), 5) = '_wait'
$$;

CREATE FUNCTION track_job_active_duration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  active_end TIMESTAMPTZ;
BEGIN
  IF OLD.status <> 'running' AND NEW.status = 'running' THEN
    NEW.active_started_at = now();
  ELSIF OLD.status = 'running' AND NEW.status = 'running' AND NEW.attempts > OLD.attempts THEN
    IF OLD.active_started_at IS NOT NULL THEN
      active_end = greatest(OLD.active_started_at, coalesce(OLD.heartbeat_at, now()));
      NEW.processing_duration_ms = OLD.processing_duration_ms +
        round(extract(epoch FROM (active_end - OLD.active_started_at)) * 1000)::bigint;
    END IF;
    NEW.active_started_at = now();
  ELSIF OLD.status = 'running' AND NEW.status <> 'running' THEN
    IF OLD.active_started_at IS NOT NULL THEN
      NEW.processing_duration_ms = OLD.processing_duration_ms + greatest(
        0,
        round(extract(epoch FROM (now() - OLD.active_started_at)) * 1000)::bigint
      );
    END IF;
    NEW.active_started_at = NULL;
  ELSIF NEW.status = 'running' THEN
    IF NOT job_progress_is_waiting(OLD.progress_phase)
      AND job_progress_is_waiting(NEW.progress_phase)
      AND OLD.active_started_at IS NOT NULL THEN
      NEW.processing_duration_ms = OLD.processing_duration_ms + greatest(
        0,
        round(extract(epoch FROM (now() - OLD.active_started_at)) * 1000)::bigint
      );
      NEW.active_started_at = NULL;
    ELSIF job_progress_is_waiting(OLD.progress_phase)
      AND NOT job_progress_is_waiting(NEW.progress_phase) THEN
      NEW.active_started_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_track_active_duration
BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION track_job_active_duration();
