PRAGMA foreign_keys = ON;

CREATE TABLE collection_controls (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'collection-controls-v0.1'),
  enrollment_enabled INTEGER NOT NULL CHECK (enrollment_enabled IN (0, 1)),
  upload_registration_enabled INTEGER NOT NULL
    CHECK (upload_registration_enabled IN (0, 1)),
  processing_enabled INTEGER NOT NULL CHECK (processing_enabled IN (0, 1)),
  publication_enabled INTEGER NOT NULL CHECK (publication_enabled IN (0, 1)),
  control_state TEXT NOT NULL
    CHECK (control_state IN ('operational', 'degraded', 'contained')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'initial',
      'drill_containment',
      'drill_restore',
      'privacy_incident',
      'security_incident',
      'abuse_or_cost',
      'maintenance'
    )
  ),
  updated_at TEXT NOT NULL,
  CHECK (
    (control_state = 'operational'
      AND enrollment_enabled = 1
      AND upload_registration_enabled = 1
      AND processing_enabled = 1
      AND publication_enabled = 1)
    OR
    (control_state = 'contained'
      AND enrollment_enabled = 0
      AND upload_registration_enabled = 0
      AND processing_enabled = 0
      AND publication_enabled = 0)
    OR
    (control_state = 'degraded'
      AND NOT (
        enrollment_enabled = 1
        AND upload_registration_enabled = 1
        AND processing_enabled = 1
        AND publication_enabled = 1
      )
      AND NOT (
        enrollment_enabled = 0
        AND upload_registration_enabled = 0
        AND processing_enabled = 0
        AND publication_enabled = 0
      ))
  )
) STRICT;

INSERT INTO collection_controls (
  singleton,
  schema_version,
  enrollment_enabled,
  upload_registration_enabled,
  processing_enabled,
  publication_enabled,
  control_state,
  revision,
  reason_code,
  updated_at
) VALUES (
  1,
  'collection-controls-v0.1',
  1,
  1,
  1,
  1,
  'operational',
  1,
  'initial',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
