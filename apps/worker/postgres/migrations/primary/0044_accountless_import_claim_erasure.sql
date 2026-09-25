-- A completed history-import claim contains a source credential hash. The
-- participant FK must erase that claim with its accountless owner, while the
-- import's direct-delete and update immutability guarantees remain intact.
-- The participant's terminal erasure trigger creates the durable owner receipt
-- before PostgreSQL runs the claim FK cascade in the same transaction.

CREATE OR REPLACE FUNCTION telemetry_participant_owner_erasure_proof()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  erased_owner_digest text;
  owner_count bigint;
BEGIN
  UPDATE storage_v11_owner_links
     SET state = 'erased'
   WHERE participant_id = OLD.id AND state <> 'erased';

  IF OLD.owner_kind = 'accountless' AND EXISTS (
    SELECT 1 FROM accountless_public_history_import_claims claim
     WHERE claim.target_participant_id = OLD.id
  ) THEN
    SELECT count(*), min(link.owner_digest)
      INTO owner_count, erased_owner_digest
      FROM storage_v11_owner_links link
      JOIN storage_owner_erasure_receipts receipt
        ON receipt.owner_digest = link.owner_digest
     WHERE link.participant_id = OLD.id AND link.state = 'erased';
    IF owner_count <> 1 OR erased_owner_digest IS NULL THEN
      RAISE EXCEPTION 'accountless_history_import_owner_erasure_proof_missing'
        USING ERRCODE = 'P1005';
    END IF;
    PERFORM set_config('tibotattle.accountless_owner_erasure',
      OLD.id || E'\n' || erased_owner_digest, true);
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION accountless_public_history_import_claim_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run_id text;
  expected_rows bigint;
  claim_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT run.transfer_id, run.source_row_count INTO run_id, expected_rows
      FROM accountless_public_history_import_runs run
     WHERE run.transfer_id = NEW.transfer_id
       AND run.status = 'importing'
       AND run.target_schema = current_schema()
       AND current_setting('tibotattle.accountless_history_import', true) = run.transfer_id
     FOR UPDATE;
    IF run_id IS NULL THEN
      RAISE EXCEPTION 'accountless_history_import_claim_refused' USING ERRCODE = 'P1005';
    END IF;
    SELECT count(*) INTO claim_count FROM accountless_public_history_import_claims claim
     WHERE claim.transfer_id = NEW.transfer_id;
    IF claim_count >= expected_rows THEN
      RAISE EXCEPTION 'accountless_history_import_claim_count_exceeded' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND current_setting('tibotattle.accountless_history_import_consuming', true) =
       OLD.transfer_id || E'\n' || OLD.source_participant_id
     AND (to_jsonb(NEW) - 'consumed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1 FROM participants participant
        WHERE participant.id = OLD.target_participant_id
     )
     AND EXISTS (
       SELECT 1 FROM storage_owner_erasure_receipts receipt
        WHERE current_setting('tibotattle.accountless_owner_erasure', true) =
          OLD.target_participant_id || E'\n' || receipt.owner_digest
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'accountless_history_import_claim_immutable' USING ERRCODE = 'P1005';
END;
$$;
