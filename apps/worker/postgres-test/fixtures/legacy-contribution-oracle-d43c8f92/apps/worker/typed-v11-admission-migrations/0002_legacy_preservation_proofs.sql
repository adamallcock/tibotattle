-- Optional new-target compatibility input. Does not convert or rewrite v1.
-- Only the ECMAScript codec prepares digests, conditional on exact original
-- evidence in the same INSERT statement; no duplicate canonical JSON persists.
CREATE TABLE typed_v1_preservation_proofs (
  source_row_id INTEGER PRIMARY KEY REFERENCES telemetry_v1_records(id) ON DELETE CASCADE,
  canonical_digest BLOB NOT NULL CHECK(length(canonical_digest)=32)
) STRICT;
CREATE TRIGGER typed_v1_preservation_proof_immutable BEFORE UPDATE ON typed_v1_preservation_proofs
WHEN OLD.source_row_id IS NOT NEW.source_row_id OR OLD.canonical_digest IS NOT NEW.canonical_digest
BEGIN SELECT RAISE(ABORT,'typed_v1_preservation_proof_immutable'); END;
CREATE TRIGGER typed_v1_preservation_record_changed BEFORE UPDATE ON telemetry_v1_records
BEGIN DELETE FROM typed_v1_preservation_proofs WHERE source_row_id=OLD.id; END;
-- Parent membership is part of the original snapshot, too. Original chunks are
-- admission-bounded to 200 records and the child lookup uses its chunk index.
CREATE TRIGGER typed_v1_preservation_chunk_changed BEFORE UPDATE ON telemetry_v1_chunks
BEGIN DELETE FROM typed_v1_preservation_proofs WHERE source_row_id IN
  (SELECT id FROM telemetry_v1_records WHERE chunk_row_id=OLD.id); END;
