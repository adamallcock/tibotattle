-- Qualification-only PostgreSQL port of migration 0046's bounded quota-fit
-- index. The canonical source remains records; no quota rows are copied into
-- this projection until the resumable high-water backfill advances.
SET search_path = tibotattle_v1_test, pg_catalog;

CREATE TABLE telemetry_v1_quota_fit_rows (
  record_id bigint PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  resets_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL
);

CREATE INDEX telemetry_v1_quota_fit_rows_cursor
  ON telemetry_v1_quota_fit_rows(participant_id, resets_at, observed_at, record_id);

CREATE TABLE telemetry_v1_quota_fit_backfill (
  singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
  through_record_id bigint NOT NULL CHECK (through_record_id >= 0),
  last_record_id bigint NOT NULL DEFAULT 0 CHECK (last_record_id >= 0),
  is_complete integer NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  CHECK (last_record_id <= through_record_id)
);

-- PostgreSQL receives the source columns through the qualification schema
-- extension owned by the harness. This index is the raw-page seek boundary;
-- the LIMIT remains before eligibility filtering.
CREATE INDEX records_participant_stream_observed
  ON records(participant_id, stream, observed_at, id);

CREATE FUNCTION telemetry_v1_quota_fit_is_eligible(
  record_row records
) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = tibotattle_v1_test, pg_catalog AS $$
  SELECT record_row.stream = 'quota'
    AND record_row.limit_id = 'codex'
    AND record_row.window_duration_minutes = 10080
    AND record_row.provider IS NOT NULL
    AND record_row.plan_type IS NOT NULL
    AND record_row.plan_variant IS NOT NULL
    AND record_row.resets_at IS NOT NULL
    AND record_row.slot IS NOT NULL
    AND record_row.used_percent IS NOT NULL
$$;

CREATE FUNCTION telemetry_v1_quota_fit_rows_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = tibotattle_v1_test, pg_catalog AS $$
BEGIN
  IF telemetry_v1_quota_fit_is_eligible(NEW) THEN
    INSERT INTO telemetry_v1_quota_fit_rows(record_id, participant_id, resets_at, observed_at)
      VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at)
      ON CONFLICT(record_id) DO UPDATE SET participant_id=EXCLUDED.participant_id,
        resets_at=EXCLUDED.resets_at, observed_at=EXCLUDED.observed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_insert
AFTER INSERT ON records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_insert();

CREATE FUNCTION telemetry_v1_quota_fit_rows_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = tibotattle_v1_test, pg_catalog AS $$
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows
   WHERE record_id = OLD.id OR record_id = NEW.id;
  IF telemetry_v1_quota_fit_is_eligible(NEW) THEN
    INSERT INTO telemetry_v1_quota_fit_rows(record_id, participant_id, resets_at, observed_at)
      VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at)
      ON CONFLICT(record_id) DO UPDATE SET participant_id=EXCLUDED.participant_id,
        resets_at=EXCLUDED.resets_at, observed_at=EXCLUDED.observed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_update
AFTER UPDATE OF id, participant_id, stream, limit_id, window_duration_minutes,
  provider, plan_type, plan_variant, resets_at, slot, used_percent, observed_at
ON records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_update();

CREATE FUNCTION telemetry_v1_quota_fit_rows_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = tibotattle_v1_test, pg_catalog AS $$
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_delete
AFTER DELETE ON records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_delete();

-- This uses the source BIGINT high-water seek. Later inserts are maintained by
-- the trigger and never move the finite backfill boundary.
INSERT INTO telemetry_v1_quota_fit_backfill(singleton_id, through_record_id, last_record_id, is_complete)
SELECT 1, COALESCE(MAX(id), 0), 0, CASE WHEN MAX(id) IS NULL THEN 1 ELSE 0 END
FROM records;

RESET search_path;
