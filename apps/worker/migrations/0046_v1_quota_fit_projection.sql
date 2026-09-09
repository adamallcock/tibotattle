-- Index an initially empty projection, then fill it in separate bounded,
-- resumable batches. Never sort the complete retained quota corpus here.
-- Readers must require the completed backfill before using this read path.
CREATE TABLE telemetry_v1_quota_fit_rows (
  record_id INTEGER PRIMARY KEY
    REFERENCES telemetry_v1_records(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  resets_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX telemetry_v1_quota_fit_rows_cursor
  ON telemetry_v1_quota_fit_rows(participant_id, resets_at, observed_at);

CREATE TABLE telemetry_v1_quota_fit_backfill (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  through_record_id INTEGER NOT NULL CHECK (through_record_id >= 0),
  last_record_id INTEGER NOT NULL DEFAULT 0 CHECK (last_record_id >= 0),
  is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  CHECK (last_record_id <= through_record_id)
) STRICT;

CREATE TRIGGER telemetry_v1_quota_fit_rows_insert
AFTER INSERT ON telemetry_v1_records
WHEN NEW.stream = 'quota' AND NEW.limit_id = 'codex'
  AND NEW.window_duration_minutes = 10080
  AND NEW.provider IS NOT NULL AND NEW.plan_type IS NOT NULL
  AND NEW.plan_variant IS NOT NULL AND NEW.resets_at IS NOT NULL
  AND NEW.slot IS NOT NULL AND NEW.used_percent IS NOT NULL
BEGIN
  INSERT INTO telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at);
END;

CREATE TRIGGER telemetry_v1_quota_fit_rows_update
AFTER UPDATE OF id, participant_id, stream, limit_id, window_duration_minutes,
  provider, plan_type, plan_variant, resets_at, slot, used_percent, observed_at
ON telemetry_v1_records
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
  INSERT INTO telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  SELECT NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at
  WHERE NEW.stream = 'quota' AND NEW.limit_id = 'codex'
    AND NEW.window_duration_minutes = 10080
    AND NEW.provider IS NOT NULL AND NEW.plan_type IS NOT NULL
    AND NEW.plan_variant IS NOT NULL AND NEW.resets_at IS NOT NULL
    AND NEW.slot IS NOT NULL AND NEW.used_percent IS NOT NULL;
END;

-- Keep direct canonical deletion safe even in local maintenance paths where
-- foreign-key enforcement is temporarily disabled. Source records are intact.
CREATE TRIGGER telemetry_v1_quota_fit_rows_delete
AFTER DELETE ON telemetry_v1_records
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
END;

-- This uses the INTEGER PRIMARY KEY's last-entry seek. Later inserts are
-- maintained by the trigger and do not move the finite backfill boundary.
INSERT INTO telemetry_v1_quota_fit_backfill
  (singleton_id, through_record_id, last_record_id, is_complete)
SELECT 1, COALESCE(MAX(id), 0), 0, CASE WHEN MAX(id) IS NULL THEN 1 ELSE 0 END
FROM telemetry_v1_records;
