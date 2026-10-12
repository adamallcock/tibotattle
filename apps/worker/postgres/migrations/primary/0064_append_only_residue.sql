-- PostgreSQL primary migration 0064: append-only residue (LEAD-SIMP).
--
-- Name and number are final (owner decision OD-1, 2026-10-02). OPS-10's
-- ordering guard keys on the '_append_only_residue.sql' suffix numbered after
-- 0053 and 0063.
--
-- The accepted 2026-09-26 append-only decision record removes, for the GCP
-- line, the machinery that only served withdrawal, online erasure, erasure
-- fences and the separate deletion ledger:
--   D1  upload revocation never withdraws an accepted contribution;
--   D2  erasure is a rare, manual, offline owner procedure (Variant B), so the
--       running service has no fence, erasure ledger or retirement;
--   D4  there is no separate deletion-ledger instance;
--   D6  simplify the GCP line: remove what exists only for the above.
--
-- This forward migration supersedes these parts of the promoted 0053
-- (community publication authority) without editing it:
--   (3) analytics_storage_erasure_fences and _receipts;
--   (4) community_terminal_watermarks and its legacy floor;
--   (6) the erasure-fence half of the daily and preview authority fences
--       (community_publication_erasure_floor). The pin checks stay.
-- It also drops the AA-0 participant-erasure lease index (0050), the
-- re-enrollment cooldowns (0002, written only by online erasure) and the
-- readiness sweeps (0013, 0017; no reader), pins the RD-1 retention flags
-- that nothing writes, and removes the ledger half of the PT-1 contract
-- (0056).
--
-- Fail-closed: D2 and D6 import no fence history, so a row in any dropped
-- table is unexpected erasure or ledger evidence. Such a row, a non-zero
-- watermark, a retention row outside the pins, or a contract registered under
-- the dual-role shape aborts this migration and leaves every object and the
-- history unchanged. Every RAISE carries a constant message and ERRCODE.
-- Nothing here edits a promoted migration.

-- (0) Residue guard. Zero watermark rows are the old floor's per-source lock
-- placeholders (0053 (6)) and carry no evidence; every other residue refuses.
DO $residue$
BEGIN
  IF EXISTS (SELECT 1 FROM analytics_storage_erasure_fences)
     OR EXISTS (SELECT 1 FROM analytics_storage_erasure_receipts)
     OR EXISTS (SELECT 1 FROM community_terminal_watermarks watermark
                 WHERE watermark.terminal_public_authority_epoch <> 0
                    OR watermark.terminal_sequence <> 0
                    OR watermark.legacy_terminal_floor_epoch IS NOT NULL)
     OR EXISTS (SELECT 1 FROM identity_reenrollment_cooldowns)
     OR EXISTS (SELECT 1 FROM postgres_readiness_sweeps) THEN
    RAISE EXCEPTION 'append_only_residue_retained_rows' USING ERRCODE = 'P1005';
  END IF;
END;
$residue$;

-- (1) The daily and preview authority fences without the erasure floor. The
-- bodies are 0053's minus the community_publication_erasure_floor comparison;
-- the triggers that call them stay and still enforce the authority pin.
CREATE OR REPLACE FUNCTION community_daily_authority_fence()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- JSON-mode revisions carry no authority pin; their fence is 0037's
  -- terminal withdrawal.
  IF NEW.provenance IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT community_authority_pin_matches(NEW.authority_json,
        ARRAY['sourceId', 'sourceNamespace', 'publicAuthorityEpoch', 'policyRevision',
              'collectionRevision', 'graphInvalidationEpoch', 'sourceEpoch', 'sequence',
              'dailyDeviceMethod'],
        NEW.source_id, NEW.source_namespace, NEW.public_authority_epoch, NEW.policy_revision,
        NEW.collection_revision, NEW.graph_invalidation_epoch, NEW.source_mutation_epoch,
        NEW.journal_sequence) THEN
    RAISE EXCEPTION 'community_publication_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  -- The pin check above proved the text is a JSON object.
  IF jsonb_typeof(NEW.authority_json::jsonb -> 'dailyDeviceMethod') IS DISTINCT FROM
       (CASE WHEN NEW.daily_device_method IS NULL THEN NULL ELSE 'string' END)
     OR (NEW.authority_json::jsonb ->> 'dailyDeviceMethod') IS DISTINCT FROM NEW.daily_device_method THEN
    RAISE EXCEPTION 'community_publication_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION community_graph_preview_authority_fence()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT community_authority_pin_matches(NEW.authority_json,
        ARRAY['sourceId', 'sourceNamespace', 'publicAuthorityEpoch', 'policyRevision',
              'collectionRevision', 'graphInvalidationEpoch', 'sourceEpoch', 'sequence'],
        NEW.source_id, NEW.source_namespace, NEW.public_authority_epoch, NEW.policy_revision,
        NEW.collection_revision, NEW.graph_invalidation_epoch, NEW.source_mutation_epoch,
        NEW.journal_sequence) THEN
    RAISE EXCEPTION 'community_publication_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION community_publication_erasure_floor(text);

-- (2) Erasure fences, their receipts and the terminal watermarks. Dropping a
-- table drops its triggers and indexes. community_publication_proof_no_truncate
-- stays: community_daily_head_no_truncate still uses it.
DROP TABLE analytics_storage_erasure_receipts;
DROP TABLE analytics_storage_erasure_fences;
DROP FUNCTION analytics_storage_erasure_fence_guard();
DROP FUNCTION analytics_storage_erasure_receipt_guard();
DROP FUNCTION community_terminal_watermark_fenced();
DROP TABLE community_terminal_watermarks;
DROP FUNCTION community_terminal_watermark_guard();
DROP INDEX storage_ingestion_terminal_epoch;
DROP INDEX analytics_applied_terminal_epoch;

-- (3) The AA-0 participant-erasure lease index: no online erasure takes it.
DROP INDEX admin_action_audit_started_participant;

-- (4) RD-1 pins. Nothing on PostgreSQL replays a restore or suppresses a
-- restored participant, and no writer sets either column, so the singleton
-- stays at its 0049 seed. A row outside the pins aborts with 23514, as 0049's
-- added checks do.
ALTER TABLE retention_state
  DROP CONSTRAINT retention_state_restored_participants_suppressed_check,
  ADD CONSTRAINT retention_state_restored_participants_suppressed_check
    CHECK (restored_participants_suppressed = 0),
  ADD CONSTRAINT retention_state_restore_replay_complete_check
    CHECK (restore_replay_complete);

-- (5) Re-enrollment cooldowns (written only by online erasure) and the
-- readiness sweep checkpoint (no reader or writer). The participants column
-- identity_cooldown_digest stays: enrollment writes it and the identity
-- importer carries it.
DROP TABLE identity_reenrollment_cooldowns;
DROP TABLE postgres_readiness_sweeps;

-- (6) The PT-1 contract without its ledger half. The control schema is
-- database-scoped and shared by every application schema in the database, so
-- this takes 0056's install lock, refuses a control schema owned by another
-- role (0056's test), refuses a contract registered under the dual-role shape
-- (it must be re-registered on a fresh database) and drops the columns only
-- if a previous application schema has not already done so. The ledger
-- mirror table and the 'ledger' installation component, which only the
-- frozen ledger migrations create, are left alone.
SELECT pg_advisory_xact_lock(hashtextextended('tibotattle_transfer:control-schema', 0));

DO $contract$
BEGIN
  IF (SELECT pg_get_userbyid(namespace.nspowner) FROM pg_catalog.pg_namespace namespace
       WHERE namespace.nspname = 'tibotattle_transfer') IS DISTINCT FROM current_user
     OR to_regclass('tibotattle_transfer.transfer_control_installations') IS NULL
     OR to_regclass('tibotattle_transfer.transfer_target_contract') IS NULL THEN
    RAISE EXCEPTION 'TRANSFER_CONTROL_SCHEMA_FOREIGN' USING ERRCODE = 'P1005';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute attribute
              WHERE attribute.attrelid = 'tibotattle_transfer.transfer_target_contract'::regclass
                AND attribute.attname = 'ledger_schema_name'
                AND NOT attribute.attisdropped)
     AND EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_target_contract) THEN
    RAISE EXCEPTION 'transfer_target_contract_registered_with_ledger' USING ERRCODE = 'P1005';
  END IF;
END;
$contract$;

ALTER TABLE tibotattle_transfer.transfer_target_contract
  DROP COLUMN IF EXISTS ledger_instance_connection_name,
  DROP COLUMN IF EXISTS ledger_database_name,
  DROP COLUMN IF EXISTS ledger_schema_name;
