-- Cross-day effective dependencies expand selected occurrences across all
-- retained v1/v1.1 variants. Scope the small device/manifest dictionaries by
-- owner, then seek the existing format-specific stream/canonical-ID indexes.
-- Time bounds would omit correction/conflict links. No record index is built.
CREATE INDEX typed_telemetry_device_owner
  ON typed_telemetry_devices(owner_id, id);
CREATE INDEX typed_telemetry_manifest_owner
  ON typed_telemetry_manifests(owner_id, id);
