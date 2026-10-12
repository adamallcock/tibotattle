-- Ready v1.2 manifests are retained source, not a mutable staging workspace.
-- Reuse the v1.2 completeness validator as an upgrade audit before protecting
-- the rows, so an already-inconsistent ready day cannot silently inherit this
-- migration's new retention guarantee.
CREATE TEMP TABLE telemetry_v12_ready_retention_audit (
  id text,
  state text,
  manifest_json text,
  chunk_day date,
  expected_chunk_count integer
) ON COMMIT DROP;
CREATE TRIGGER telemetry_v12_ready_retention_audit_guard
BEFORE INSERT ON telemetry_v12_ready_retention_audit
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_manifest_ready_integrity_guard();
INSERT INTO telemetry_v12_ready_retention_audit (
  id, state, manifest_json, chunk_day, expected_chunk_count
)
SELECT id, state, manifest_json, chunk_day, expected_chunk_count
  FROM telemetry_v12_day_manifests
 WHERE state = 'ready';
DROP TABLE telemetry_v12_ready_retention_audit;

-- All guarded tables use one predicate. A row whose ready manifest still has
-- a participant row cannot be changed, even after that participant is marked
-- deleting: the existing owner-erasure implementation only creates terminal
-- proof in the BEFORE DELETE participant trigger. During that FK cascade the
-- participant row (or an intermediate source parent) is already gone and the
-- nested trigger depth identifies the cascade. Every direct v1.2 source root
-- is guarded here, so deleting a ready parent directly cannot use this narrow
-- descendant-cascade exception. A linkless v1.2 participant intentionally
-- fails closed at terminal deletion because no established owner-erasure
-- receipt can authorize its ready-source cascade.
-- Refuse deletion before any FK cascade begins unless this participant's own
-- owner link transitioned to erased in this transaction and its joined
-- receipt was created in the same transaction. The descendant guards cannot
-- always recover a participant id after PostgreSQL has removed an intermediate
-- parent, so an older erased link/receipt must not borrow another owner's
-- current receipt as proof.
CREATE FUNCTION telemetry_v12_ready_participant_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM telemetry_v12_day_manifests manifest
     WHERE manifest.participant_id = OLD.id AND manifest.state = 'ready'
  ) AND NOT EXISTS (
    SELECT 1
      FROM storage_v11_owner_links owner_link
      JOIN storage_owner_erasure_receipts receipt
        ON receipt.owner_digest = owner_link.owner_digest
     WHERE owner_link.participant_id = OLD.id
       AND owner_link.state = 'erased'
       AND owner_link.xmin = pg_current_xact_id()::xid
       AND receipt.xmin = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'telemetry_v12_ready_owner_erasure_proof_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER telemetry_v12_ready_participant_delete_guard
BEFORE DELETE ON participants
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_participant_delete_guard();

CREATE FUNCTION telemetry_v12_ready_source_retention_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  old_manifest_id text;
  new_manifest_id text;
  manifest_id_value text;
  manifest_state text;
  manifest_owner_id text;
  row_owner_id text;
  saw_ready boolean := false;
  missing_parent boolean := false;
  erasure_cascade boolean;
BEGIN
  erasure_cascade := pg_trigger_depth() > 1 AND EXISTS (
    SELECT 1 FROM storage_owner_erasure_receipts receipt
     WHERE receipt.xmin = pg_current_xact_id()::xid
  );

  IF TG_TABLE_NAME = 'telemetry_v12_day_manifests' THEN
    IF TG_OP = 'INSERT' THEN
      -- New ready headers still pass through 0028's complete-day validator.
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.state = 'ready' THEN
        RAISE EXCEPTION 'telemetry_v12_ready_manifest_immutable' USING ERRCODE = 'P1005';
      END IF;
      IF NEW.state = 'ready' AND (
        OLD.state <> 'staged'
        OR NEW.ready_at IS NULL
        OR (to_jsonb(OLD) - ARRAY['state', 'ready_at'])
             IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state', 'ready_at'])
      ) THEN
        RAISE EXCEPTION 'telemetry_v12_ready_manifest_transition_invalid' USING ERRCODE = 'P1005';
      END IF;
      RETURN NEW;
    ELSE
      IF OLD.state <> 'ready' THEN
        RETURN OLD;
      END IF;
      row_owner_id := OLD.participant_id;
      IF EXISTS (SELECT 1 FROM participants participant WHERE participant.id = row_owner_id)
         OR NOT erasure_cascade THEN
        RAISE EXCEPTION 'telemetry_v12_ready_manifest_retained' USING ERRCODE = 'P1005';
      END IF;
      RETURN OLD;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'telemetry_v12_chunks' THEN
    IF TG_OP <> 'INSERT' THEN old_manifest_id := OLD.manifest_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_manifest_id := NEW.manifest_id; END IF;
    row_owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  ELSIF TG_TABLE_NAME IN ('telemetry_v12_records', 'telemetry_v12_typed_records') THEN
    IF TG_OP <> 'INSERT' THEN old_manifest_id := OLD.manifest_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_manifest_id := NEW.manifest_id; END IF;
  ELSIF TG_TABLE_NAME IN (
    'telemetry_v12_typed_usage', 'telemetry_v12_typed_quota',
    'telemetry_v12_typed_session_tools'
  ) THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT record.manifest_id INTO old_manifest_id
        FROM telemetry_v12_typed_records record
       WHERE record.id = OLD.record_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT record.manifest_id INTO new_manifest_id
        FROM telemetry_v12_typed_records record
       WHERE record.id = NEW.record_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'telemetry_v12_ready_guard_table_invalid' USING ERRCODE = 'P1005';
  END IF;

  -- Lock referenced headers while checking state. This serializes later child
  -- writes against the staged -> ready transition and keeps exact replay safe.
  FOREACH manifest_id_value IN ARRAY ARRAY[old_manifest_id, new_manifest_id] LOOP
    IF manifest_id_value IS NULL THEN
      CONTINUE;
    END IF;
    SELECT manifest.state, manifest.participant_id
      INTO manifest_state, manifest_owner_id
      FROM telemetry_v12_day_manifests manifest
     WHERE manifest.id = manifest_id_value
     FOR UPDATE;
    IF NOT FOUND THEN
      missing_parent := true;
      CONTINUE;
    END IF;
    IF row_owner_id IS NOT NULL AND row_owner_id <> manifest_owner_id THEN
      RAISE EXCEPTION 'telemetry_v12_ready_owner_mismatch' USING ERRCODE = 'P1005';
    END IF;
    IF manifest_state = 'ready' THEN
      saw_ready := true;
      row_owner_id := manifest_owner_id;
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' AND missing_parent THEN
    -- Typed child rows can lose their typed-record/header lookup before this
    -- cascading trigger runs. The protected record/chunk/header roots reject
    -- direct deletes, leaving participant FK erasure as the only such path.
    IF erasure_cascade THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'telemetry_v12_ready_source_retained' USING ERRCODE = 'P1005';
  END IF;

  IF saw_ready THEN
    IF TG_OP <> 'DELETE'
       OR row_owner_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM participants participant WHERE participant.id = row_owner_id
       )
       OR NOT erasure_cascade THEN
      RAISE EXCEPTION 'telemetry_v12_ready_source_retained' USING ERRCODE = 'P1005';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER telemetry_v12_day_manifest_retention_guard
BEFORE UPDATE OR DELETE ON telemetry_v12_day_manifests
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_chunk_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_chunks
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_record_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_records
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_typed_record_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_records
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_typed_usage_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_usage
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_typed_quota_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_quota
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
CREATE TRIGGER telemetry_v12_typed_session_retention_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_session_tools
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_ready_source_retention_guard();
