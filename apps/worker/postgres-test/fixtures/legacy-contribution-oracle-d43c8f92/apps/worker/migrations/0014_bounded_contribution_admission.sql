PRAGMA foreign_keys = ON;

-- Admission is intentionally bounded by a coarse fixed window, not by a
-- participant's lifetime. The counter contains no content, digest, model, or
-- account field. Windows start Monday at 00:00:00 UTC.
CREATE TABLE telemetry_contribution_admission_windows (
  participant_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  accepted_count INTEGER NOT NULL
    CHECK (accepted_count >= 1 AND accepted_count <= 100),
  last_accepted_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, window_started_at),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) STRICT;

INSERT INTO telemetry_contribution_admission_windows (
  participant_id, window_started_at, accepted_count, last_accepted_at
)
SELECT
  participant_id,
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    (
      (
        CAST(strftime('%s', created_at) AS INTEGER) + 259200
      ) / 604800
    ) * 604800 - 259200,
    'unixepoch'
  ) AS window_started_at,
  COUNT(*) AS accepted_count,
  MAX(created_at) AS last_accepted_at
FROM telemetry_contributions
GROUP BY participant_id, window_started_at;

DROP TRIGGER telemetry_contributions_enforce_participant_limit;

CREATE TRIGGER telemetry_contributions_enforce_admission_window
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN COALESCE((
  SELECT accepted_count
    FROM telemetry_contribution_admission_windows
   WHERE participant_id = NEW.participant_id
     AND window_started_at = strftime(
       '%Y-%m-%dT%H:%M:%fZ',
       (
         (
           CAST(strftime('%s', NEW.created_at) AS INTEGER) + 259200
         ) / 604800
       ) * 604800 - 259200,
       'unixepoch'
     )
), 0) >= 100
BEGIN
  SELECT RAISE(ABORT, 'contribution admission window exhausted');
END;

CREATE TRIGGER telemetry_contributions_record_admission_window
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
BEGIN
  INSERT INTO telemetry_contribution_admission_windows (
    participant_id, window_started_at, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      (
        (
          CAST(strftime('%s', NEW.created_at) AS INTEGER) + 259200
        ) / 604800
      ) * 604800 - 259200,
      'unixepoch'
    ),
    1,
    NEW.created_at
  )
  ON CONFLICT (participant_id, window_started_at)
  DO UPDATE SET
    accepted_count = accepted_count + 1,
    last_accepted_at = excluded.last_accepted_at;
END;
