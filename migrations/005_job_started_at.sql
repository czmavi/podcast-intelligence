ALTER TABLE jobs
  ADD COLUMN started_at TIMESTAMPTZ;

-- U existujících úloh je locked_at nejpřesnější dostupný začátek posledního běhu.
-- U starších neúspěšných úloh už byl lock uvolněn, proto použijeme alespoň created_at.
UPDATE jobs
SET started_at = COALESCE(locked_at, created_at)
WHERE attempts > 0;

CREATE FUNCTION set_job_started_at_on_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'running' AND OLD.status <> 'running' AND NEW.started_at IS NULL THEN
    NEW.started_at = now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_set_started_at_on_claim
BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION set_job_started_at_on_claim();
