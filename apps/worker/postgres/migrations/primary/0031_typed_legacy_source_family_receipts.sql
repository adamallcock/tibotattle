-- A legacy reader must distinguish an empty source family from one that has
-- not yet been transferred. This compact receipt is written only after the
-- source-family copy and parity reconciliation have completed.
--
-- The receipt contains no participant, owner, record, or object identifiers.
-- It may be written only after the sealed v1/v1.1 table transfer is reconciled
-- against its source and the source-owner lineage is reconciled. It does not
-- attest to record-admission, preservation-proof, or usage-correction families;
-- these remain independent prerequisites for an effective usage lane. The
-- owner-aware reader also rechecks current active source authority. A later
-- complete transfer advances generation and replaces the digest; a reader
-- pins both values across pagination and rechecks them before use.
CREATE TABLE typed_telemetry_source_family_receipts (
  source_namespace text NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 256),
  source_format smallint NOT NULL CHECK (source_format IN (10, 11)),
  generation bigint NOT NULL CHECK (generation >= 1),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
  membership_row_count bigint NOT NULL CHECK (membership_row_count >= 0),
  reconciled_at timestamptz NOT NULL,
  PRIMARY KEY (source_namespace, source_format)
);

CREATE FUNCTION typed_telemetry_source_family_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'typed_telemetry_source_family_receipt_retained' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.source_namespace IS DISTINCT FROM NEW.source_namespace
    OR OLD.source_format IS DISTINCT FROM NEW.source_format
    OR NEW.generation <= OLD.generation
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_source_family_receipt_generation' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_source_family_receipt_guard
  BEFORE UPDATE OR DELETE ON typed_telemetry_source_family_receipts
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_family_receipt_guard();
