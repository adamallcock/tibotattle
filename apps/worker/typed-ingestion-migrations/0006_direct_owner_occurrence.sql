-- Resolve retained v1/v1.1 variants by owner and exact reversible occurrence
-- bytes, without probing every device or manifest for each selected occurrence.
-- This non-unique index retains every format/stream/day variant. Admission,
-- source authority and complete-chunk proofs remain in the reader query.
-- SQLite maintains it atomically on admission, replacement and erasure.
CREATE INDEX typed_telemetry_owner_occurrence
  ON typed_telemetry_records(owner_id, occurrence_id, format, stream, observed_day);
