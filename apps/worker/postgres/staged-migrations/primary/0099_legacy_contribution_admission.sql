-- PostgreSQL primary migration (staged, PROVISIONAL number 0099; the lead
-- assigns the real number at landing): legacy contribution admission (IN-3).
--
-- The telemetry-envelope-v0.1 contribution path (handleTelemetryContribution
-- at d43c8f92) bounds admission by a fixed Monday-anchored UTC week of 100
-- accepted contributions per participant (D1 migrations/0014). PostgreSQL
-- 0011 ported the earlier D1 0002 lifetime cap of 100 contributions
-- instead, which D1 0014 dropped. This migration makes PostgreSQL match D1:
--
--   * telemetry_contribution_admission_windows, the D1 0014 counter table
--     (content-free: participant, window start, count, last accepted time),
--     backfilled from existing contributions exactly as D1 0014 backfilled
--     it. A transferred schema should copy D1's own window rows instead:
--     D1 never refunds a slot when a contribution is deleted
--     ("not_refunded_by_contribution_deletion"), so a backfill from the
--     retained contributions can only undercount.
--   * the lifetime trigger telemetry_contributions_participant_limit and its
--     function are dropped;
--   * BEFORE/AFTER INSERT triggers enforce and record the weekly window as
--     D1's telemetry_contributions_enforce_admission_window and
--     telemetry_contributions_record_admission_window do.
--
-- The window start is D1's: floor((epoch seconds + 259200) / 604800) *
-- 604800 - 259200, in whole seconds (strftime('%s')), as UTC. Every RAISE
-- carries a constant message and ERRCODE; no value is interpolated. On
-- promotion, add telemetry_contribution_admission_windows to the
-- participant-table inventories that enumerate participant-owned tables.

CREATE FUNCTION telemetry_contribution_admission_window_start(created timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT pg_catalog.to_timestamp(
    ((pg_catalog.floor(pg_catalog.date_part('epoch', created))::bigint + 259200) / 604800) * 604800 - 259200
  )
$$;

CREATE TABLE telemetry_contribution_admission_windows (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  accepted_count integer NOT NULL CHECK (accepted_count BETWEEN 1 AND 100),
  last_accepted_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, window_started_at)
);

INSERT INTO telemetry_contribution_admission_windows (
  participant_id, window_started_at, accepted_count, last_accepted_at
)
SELECT participant_id, telemetry_contribution_admission_window_start(created_at),
       count(*), max(created_at)
  FROM telemetry_contributions
 GROUP BY participant_id, telemetry_contribution_admission_window_start(created_at);

DROP TRIGGER telemetry_contributions_participant_limit ON telemetry_contributions;
DROP FUNCTION telemetry_contributions_enforce_participant_limit();

CREATE FUNCTION telemetry_contributions_enforce_admission_window()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- The row lock serializes concurrent admissions of one participant-week;
  -- D1 serializes them by its single writer.
  IF COALESCE((
    SELECT window_row.accepted_count
      FROM telemetry_contribution_admission_windows window_row
     WHERE window_row.participant_id = NEW.participant_id
       AND window_row.window_started_at = telemetry_contribution_admission_window_start(NEW.created_at)
     FOR UPDATE
  ), 0) >= 100 THEN
    RAISE EXCEPTION 'contribution admission window exhausted' USING ERRCODE = 'P1003';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_contributions_enforce_admission_window
  BEFORE INSERT ON telemetry_contributions
  FOR EACH ROW EXECUTE FUNCTION telemetry_contributions_enforce_admission_window();

CREATE FUNCTION telemetry_contributions_record_admission_window()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO telemetry_contribution_admission_windows (
    participant_id, window_started_at, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id, telemetry_contribution_admission_window_start(NEW.created_at), 1, NEW.created_at
  )
  ON CONFLICT (participant_id, window_started_at)
  DO UPDATE SET accepted_count = telemetry_contribution_admission_windows.accepted_count + 1,
                last_accepted_at = EXCLUDED.last_accepted_at;
  RETURN NULL;
END;
$$;
CREATE TRIGGER telemetry_contributions_record_admission_window
  AFTER INSERT ON telemetry_contributions
  FOR EACH ROW EXECUTE FUNCTION telemetry_contributions_record_admission_window();
