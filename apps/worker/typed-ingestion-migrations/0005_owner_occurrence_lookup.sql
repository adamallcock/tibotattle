-- Cross-day effective dependencies expand selected occurrences across all
-- retained v1/v1.1 variants. Time bounds would omit correction/conflict links;
-- this index seeks only matching owner, format, stream and canonical BLOB ID.
CREATE INDEX typed_telemetry_owner_occurrence
  ON typed_telemetry_records(owner_id, format, stream, occurrence_id);
