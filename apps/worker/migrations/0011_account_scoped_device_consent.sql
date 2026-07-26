PRAGMA foreign_keys = ON;

-- Preserve the original consent_version column and its v0.1 CHECK for backward
-- compatibility. This forward-only column records the actual ongoing transport
-- disclosure accepted by newly paired devices.
ALTER TABLE device_pairings
  ADD COLUMN transport_consent_version TEXT NOT NULL
  DEFAULT 'ongoing-privacy-safe-telemetry-v0.1'
  CHECK (
    transport_consent_version IN (
      'ongoing-privacy-safe-telemetry-v0.1',
      'ongoing-privacy-safe-telemetry-v0.2'
    )
  );
