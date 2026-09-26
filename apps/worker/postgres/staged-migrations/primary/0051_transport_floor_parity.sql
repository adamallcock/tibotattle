-- PostgreSQL primary migration 0051 (staged): transport floor parity.
--
-- Primary 0005 created the transport authority tables but none of the D1
-- triggers that maintain and guard them. This file ports the live ingestion
-- D1's effective triggers (migrations/0044:14-122, re-created by
-- 0058:539-545,1326-1351,1413-1420,1711-1720,2037-2049,2221-2237, and
-- ingestion-isolation-migrations/0008:30-138):
--
--   (a) a social participant insert creates its attribution enrollment and a
--       participant floor (rank 1, revision 0). Accountless participants are
--       created by src/postgres-accountless-enrollment.ts, which writes both
--       rows (floor rank 11) explicitly, so the triggers fire for social only;
--   (b) a device credential insert creates the device floor: accountless
--       copies the participant floor, social takes 10 when the participant
--       floor is 11 and copies it otherwise. No participant floor means no
--       device floor, and a conflicting row aborts, as in D1;
--   (c) (a) and (b) return early only inside an import transfer session,
--       decided by OJ-1's storage_journal_transfer_session() (a deliberate,
--       non-escalating member of tibotattle_source_transfer; never a
--       superuser). No inline pg_has_role predicate is used, and the role is
--       not created here. Nothing else in this file is bypassed;
--   (d) BEFORE UPDATE guards on both floor tables: immutable identity,
--       revision = OLD.revision + 1, no lowering without an owner-audited
--       rollback, and (participant floor) no raise to 11 over accepted v0.2
--       history. Each table's checks run in the order in which SQLite fires
--       the D1 triggers (the most recently created first), so a statement
--       that breaks two rules is refused with the same constant as in D1;
--   (e) a v1.1 consent insert raises that device's floor to 11 when it is
--       lower, and UNCONDITIONALLY sets the participant floor to
--       GREATEST(floor, 11) with revision + 1 (D1 0058:1413-1418);
--   (f) v1.1 consent admission (active social participant and device, an
--       attribution enrollment, v1.1 lifecycle 'accepted', no accepted v0.2
--       history) and consent immutability;
--   (g) floor rollbacks reference admin_action_audit(operation_id), carry
--       closed ranks with to_rank < from_rank, and are admitted only for a
--       started run_maintenance audit whose details match (owner-only);
--   (h) reject_v1_transport_floor() becomes device-only, as D1 isolation
--       0008:118-138: a missing device floor row fails closed, and the
--       participant floor is no longer consulted.
--
-- Also ported for parity: attribution enrollments and transport format
-- identities are immutable, and a device has at most one floor row.
--
-- Not ported here: D1's telemetry_transport_legacy_insert on
-- telemetry_contributions (the v0.x legacy floor belongs to the legacy
-- contribution family), and D1's auto-creation for accountless participants
-- (see (a)).
--
-- Every RAISE carries a constant message and an explicit ERRCODE: P1007 for
-- a transport refusal ('telemetry_transport_blocked'), P1005 for every other
-- invariant. No NEW or OLD value is ever interpolated into a message.
-- Constraint additions validate existing rows, so a store that already
-- violates a D1 rule refuses this migration instead of being rewritten.

-- (g) Rollback records: D1 0044:64-73. The foreign key uses whichever key
-- holds admin_action_audit.operation_id when this file runs: the primary key
-- on the 0046 chain, or the UNIQUE constraint once the staged admin-audit
-- hardening (0050) has re-keyed the table. 0050 must therefore run before
-- this file (its DROP of the old primary key would otherwise be refused).
ALTER TABLE telemetry_transport_floor_rollbacks
  ADD CONSTRAINT telemetry_transport_floor_rollbacks_operation_fkey
    FOREIGN KEY (operation_id) REFERENCES admin_action_audit(operation_id),
  ADD CONSTRAINT telemetry_transport_floor_rollbacks_from_rank_check
    CHECK (from_rank IN (1, 2, 10, 11)),
  ADD CONSTRAINT telemetry_transport_floor_rollbacks_to_rank_check
    CHECK (to_rank IN (1, 2, 10, 11) AND to_rank < from_rank);

-- D1 isolation 0008:45: UNIQUE (device_id). It also serves the device FK's
-- cascade lookup, which the (participant_id, device_id) key cannot.
CREATE UNIQUE INDEX telemetry_transport_device_floors_device
  ON telemetry_transport_device_floors(device_id);

-- D1 0044:30-31 / 0058:544-545.
CREATE FUNCTION attribution_enrollment_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'attribution_enrollment_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER attribution_enrollment_immutable
  BEFORE UPDATE ON attribution_enrollments
  FOR EACH ROW EXECUTE FUNCTION attribution_enrollment_immutable();

-- D1 0044:43-45 / 0058:1349-1351. Lifecycle stays owner-mutable.
CREATE FUNCTION telemetry_transport_format_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'telemetry_transport_identity_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER telemetry_transport_format_identity_immutable
  BEFORE UPDATE OF schema_version, format_rank ON telemetry_transport_formats
  FOR EACH ROW EXECUTE FUNCTION telemetry_transport_format_identity_immutable();

-- (a) D1 0058:539-543: a fresh random 64-hex namespace per enrollment
-- (gen_random_uuid and sha256 are core; pgcrypto is not required).
CREATE FUNCTION attribution_enrollment_created()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF storage_journal_transfer_session() THEN
    RETURN NULL;
  END IF;
  INSERT INTO attribution_enrollments (participant_id, namespace, created_at)
  VALUES (
    NEW.id,
    encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
    clock_timestamp()
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER attribution_enrollment_created
  AFTER INSERT ON participants
  FOR EACH ROW WHEN (NEW.owner_kind = 'social')
  EXECUTE FUNCTION attribution_enrollment_created();

-- (a) D1 0058:1711-1720, social branch (rank 1, revision 0).
CREATE FUNCTION telemetry_transport_floor_created()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF storage_journal_transfer_session() THEN
    RETURN NULL;
  END IF;
  INSERT INTO telemetry_transport_participant_floors (
    participant_id, minimum_rank, revision, changed_at
  ) VALUES (NEW.id, 1, 0, clock_timestamp());
  RETURN NULL;
END;
$$;
CREATE TRIGGER telemetry_transport_floor_created
  AFTER INSERT ON participants
  FOR EACH ROW WHEN (NEW.owner_kind = 'social')
  EXECUTE FUNCTION telemetry_transport_floor_created();

-- (b) D1 isolation 0008:66-78. The participant floor is read FOR SHARE so
-- the copy is taken from the latest committed floor, never from a raise that
-- is still in flight.
CREATE FUNCTION telemetry_transport_device_floor_created()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF storage_journal_transfer_session() THEN
    RETURN NULL;
  END IF;
  INSERT INTO telemetry_transport_device_floors (
    participant_id, device_id, minimum_rank, revision, changed_at
  )
  SELECT NEW.participant_id, NEW.id,
         CASE WHEN participant.owner_kind = 'accountless' THEN floor_row.minimum_rank
              WHEN floor_row.minimum_rank = 11 THEN 10
              ELSE floor_row.minimum_rank END,
         0, clock_timestamp()
    FROM participants participant
    JOIN telemetry_transport_participant_floors floor_row
      ON floor_row.participant_id = participant.id
   WHERE participant.id = NEW.participant_id
     FOR SHARE OF floor_row;
  RETURN NULL;
END;
$$;
CREATE TRIGGER telemetry_transport_device_floor_created
  AFTER INSERT ON device_credentials
  FOR EACH ROW EXECUTE FUNCTION telemetry_transport_device_floor_created();

-- (d) Participant floor guards: D1 0058:1326-1348. SQLite fires the three
-- triggers as successor_history_guard, revision, no_implicit_downgrade.
CREATE FUNCTION telemetry_transport_participant_floor_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.minimum_rank = 11 AND NEW.minimum_rank > OLD.minimum_rank
     AND EXISTS (
       SELECT 1 FROM telemetry_contributions legacy
        WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
          AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'
     ) THEN
    RAISE EXCEPTION 'telemetry_transport_blocked' USING ERRCODE = 'P1007';
  END IF;
  IF NEW.participant_id <> OLD.participant_id OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'telemetry_transport_floor_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.minimum_rank < OLD.minimum_rank AND NOT EXISTS (
       SELECT 1 FROM telemetry_transport_floor_rollbacks floor_rollback
         JOIN admin_action_audit audit_row ON audit_row.operation_id = floor_rollback.operation_id
        WHERE floor_rollback.participant_id = OLD.participant_id
          AND floor_rollback.expected_revision = OLD.revision
          AND floor_rollback.from_rank = OLD.minimum_rank
          AND floor_rollback.to_rank = NEW.minimum_rank
          AND audit_row.outcome = 'started'
     ) THEN
    RAISE EXCEPTION 'telemetry_transport_rollback_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_transport_participant_floor_guard
  BEFORE UPDATE ON telemetry_transport_participant_floors
  FOR EACH ROW EXECUTE FUNCTION telemetry_transport_participant_floor_guard();

-- (d) Device floor guards: D1 isolation 0008:79-98. SQLite fires them as
-- no_implicit_downgrade, then revision. Like D1, a device lowering needs an
-- audited rollback for the participant and exact ranks at any revision.
CREATE FUNCTION telemetry_transport_device_floor_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.minimum_rank < OLD.minimum_rank AND NOT EXISTS (
       SELECT 1 FROM telemetry_transport_floor_rollbacks floor_rollback
         JOIN admin_action_audit audit_row ON audit_row.operation_id = floor_rollback.operation_id
        WHERE floor_rollback.participant_id = OLD.participant_id
          AND floor_rollback.from_rank = OLD.minimum_rank
          AND floor_rollback.to_rank = NEW.minimum_rank
          AND audit_row.outcome = 'started'
     ) THEN
    RAISE EXCEPTION 'telemetry_transport_device_floor_rollback_required' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'telemetry_transport_device_floor_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_transport_device_floor_guard
  BEFORE UPDATE ON telemetry_transport_device_floors
  FOR EACH ROW EXECUTE FUNCTION telemetry_transport_device_floor_guard();

-- (f) v1.1 consent admission: D1 0058:2037-2049.
CREATE FUNCTION telemetry_v11_consent_admission()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM participants participant
      JOIN device_credentials device ON device.participant_id = participant.id
      JOIN attribution_enrollments enrollment ON enrollment.participant_id = participant.id
      JOIN telemetry_transport_formats format_row
        ON format_row.schema_version = NEW.telemetry_schema_version
     WHERE participant.id = NEW.participant_id AND participant.state = 'active'
       AND participant.owner_kind = 'social'
       AND device.id = NEW.device_id AND device.authority_kind = 'social'
       AND device.state = 'active' AND format_row.lifecycle = 'accepted'
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_contributions legacy
          WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
            AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'
       )
  ) THEN
    RAISE EXCEPTION 'telemetry_transport_blocked' USING ERRCODE = 'P1007';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_v11_consent_admission
  BEFORE INSERT ON telemetry_v11_device_consents
  FOR EACH ROW EXECUTE FUNCTION telemetry_v11_consent_admission();

-- (f) D1 0058:1419-1420.
CREATE FUNCTION telemetry_v11_consent_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'telemetry_consent_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER telemetry_v11_consent_immutable
  BEFORE UPDATE ON telemetry_v11_device_consents
  FOR EACH ROW EXECUTE FUNCTION telemetry_v11_consent_immutable();

-- (e) D1 0058:1413-1418 and isolation 0008:104-116. The participant raise is
-- unconditional: a consent on a second device still advances the policy
-- revision when the floor is already 11. SQLite runs the device update
-- first; here the participant floor is updated first, the lock order every
-- other floor writer uses. The two updates touch different rows and read
-- nothing the other writes, so the order is not observable.
CREATE FUNCTION telemetry_v11_consent_floor()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE telemetry_transport_participant_floors
     SET minimum_rank = GREATEST(minimum_rank, 11), revision = revision + 1,
         changed_at = NEW.consented_at
   WHERE participant_id = NEW.participant_id;
  UPDATE telemetry_transport_device_floors
     SET minimum_rank = 11, revision = revision + 1, changed_at = NEW.consented_at
   WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
     AND minimum_rank < 11;
  RETURN NULL;
END;
$$;
CREATE TRIGGER telemetry_v11_consent_floor
  AFTER INSERT ON telemetry_v11_device_consents
  FOR EACH ROW EXECUTE FUNCTION telemetry_v11_consent_floor();

-- (g) Owner-only rollback admission: D1 0058:2221-2237. The audit details
-- are read as SQLite's json_extract reads them: the first occurrence of a
-- duplicated key; a string compares only with text; a number compares
-- numerically (1 equals 1.0) and true/false compare as 1/0. Unparseable or
-- non-object details, like any mismatch, are refused with the constant.
CREATE FUNCTION telemetry_transport_rollback_owner_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  details_text text;
  details_value json;
  operation_value json;
  digest_value json;
  revision_value json;
  from_value json;
  to_value json;
BEGIN
  SELECT audit_row.details_json INTO details_text
    FROM admin_action_audit audit_row
   WHERE audit_row.operation_id = NEW.operation_id
     AND audit_row.action = 'run_maintenance' AND audit_row.outcome = 'started';
  IF NOT FOUND OR details_text IS NULL OR NOT pg_input_is_valid(details_text, 'json') THEN
    RAISE EXCEPTION 'telemetry_transport_rollback_denied' USING ERRCODE = 'P1005';
  END IF;
  details_value := details_text::json;
  IF json_typeof(details_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'telemetry_transport_rollback_denied' USING ERRCODE = 'P1005';
  END IF;
  SELECT
    (SELECT member.value FROM json_each(details_value) WITH ORDINALITY AS member(key, value, position)
      WHERE member.key = 'operation' ORDER BY member.position LIMIT 1),
    (SELECT member.value FROM json_each(details_value) WITH ORDINALITY AS member(key, value, position)
      WHERE member.key = 'participantDigest' ORDER BY member.position LIMIT 1),
    (SELECT member.value FROM json_each(details_value) WITH ORDINALITY AS member(key, value, position)
      WHERE member.key = 'expectedRevision' ORDER BY member.position LIMIT 1),
    (SELECT member.value FROM json_each(details_value) WITH ORDINALITY AS member(key, value, position)
      WHERE member.key = 'fromRank' ORDER BY member.position LIMIT 1),
    (SELECT member.value FROM json_each(details_value) WITH ORDINALITY AS member(key, value, position)
      WHERE member.key = 'toRank' ORDER BY member.position LIMIT 1)
  INTO operation_value, digest_value, revision_value, from_value, to_value;
  IF json_typeof(operation_value) IS DISTINCT FROM 'string'
     OR (operation_value #>> '{}') IS DISTINCT FROM 'telemetry_transport_rollback'
     OR json_typeof(digest_value) IS DISTINCT FROM 'string'
     OR (digest_value #>> '{}') IS DISTINCT FROM NEW.participant_digest
     OR (CASE json_typeof(revision_value)
           WHEN 'number' THEN CASE WHEN pg_input_is_valid(revision_value #>> '{}', 'numeric')
                                   THEN (revision_value #>> '{}')::numeric END
           WHEN 'boolean' THEN CASE WHEN (revision_value #>> '{}') = 'true' THEN 1 ELSE 0 END
         END) IS DISTINCT FROM NEW.expected_revision::numeric
     OR (CASE json_typeof(from_value)
           WHEN 'number' THEN CASE WHEN pg_input_is_valid(from_value #>> '{}', 'numeric')
                                   THEN (from_value #>> '{}')::numeric END
           WHEN 'boolean' THEN CASE WHEN (from_value #>> '{}') = 'true' THEN 1 ELSE 0 END
         END) IS DISTINCT FROM NEW.from_rank::numeric
     OR (CASE json_typeof(to_value)
           WHEN 'number' THEN CASE WHEN pg_input_is_valid(to_value #>> '{}', 'numeric')
                                   THEN (to_value #>> '{}')::numeric END
           WHEN 'boolean' THEN CASE WHEN (to_value #>> '{}') = 'true' THEN 1 ELSE 0 END
         END) IS DISTINCT FROM NEW.to_rank::numeric
     OR NOT EXISTS (
       SELECT 1 FROM telemetry_transport_participant_floors floor_row
         JOIN participants participant ON participant.id = floor_row.participant_id
        WHERE floor_row.participant_id = NEW.participant_id
          AND participant.state = 'active' AND participant.owner_kind = 'social'
          AND floor_row.revision = NEW.expected_revision
          AND floor_row.minimum_rank = NEW.from_rank
     ) THEN
    RAISE EXCEPTION 'telemetry_transport_rollback_denied' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_transport_rollback_owner_only
  BEFORE INSERT ON telemetry_transport_floor_rollbacks
  FOR EACH ROW EXECUTE FUNCTION telemetry_transport_rollback_owner_only();

-- (h) D1 isolation 0008:118-138 replaced the participant-wide v1 guard with a
-- device-scoped one: an older v1 device stays uploadable when another device
-- raised its own floor to v1.1, an upgraded device cannot silently return to
-- v1, and a missing device floor row fails closed. The trigger
-- telemetry_v1_transport_floor_guard (0010) keeps calling this function.
CREATE OR REPLACE FUNCTION reject_v1_transport_floor()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  device_minimum_rank_value integer;
  format_rank_value integer;
  lifecycle_value text;
BEGIN
  SELECT device_floor.minimum_rank
    INTO device_minimum_rank_value
    FROM telemetry_transport_device_floors device_floor
   WHERE device_floor.participant_id = NEW.participant_id
     AND device_floor.device_id = NEW.device_id
   FOR SHARE;
  IF NOT FOUND OR device_minimum_rank_value IS NULL THEN
    RAISE EXCEPTION 'telemetry_transport_blocked' USING ERRCODE = 'P1007';
  END IF;
  SELECT format_rank, lifecycle
    INTO format_rank_value, lifecycle_value
    FROM telemetry_transport_formats
   WHERE schema_version = 'telemetry-contribution-v1.0'
   FOR SHARE;
  IF lifecycle_value IS DISTINCT FROM 'accepted'
      OR format_rank_value IS NULL
      OR format_rank_value < device_minimum_rank_value THEN
    RAISE EXCEPTION 'telemetry_transport_blocked' USING ERRCODE = 'P1007';
  END IF;
  RETURN NEW;
END;
$$;
