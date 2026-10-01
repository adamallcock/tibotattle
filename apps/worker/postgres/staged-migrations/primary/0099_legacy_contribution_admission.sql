-- PostgreSQL primary migration (staged, PROVISIONAL number 0099; the lead
-- assigns the real number at landing): legacy contribution admission (IN-3).
-- Two parts: the v0.1 weekly admission window (below) and, at the end, the
-- typed-row retention allowance a v1.0 correction needs.
--
-- The telemetry-envelope-v0.1 contribution path (handleTelemetryContribution
-- at d43c8f92) bounds admission by a fixed Monday-anchored UTC week of 100
-- accepted contributions per participant (D1 migrations/0014). PostgreSQL
-- 0011 ported the earlier D1 0002 lifetime cap of 100 contributions
-- instead, which D1 0014 dropped. This migration makes PostgreSQL match D1:
--
--   * telemetry_contribution_admission_windows, the D1 0014 counter table
--     (content-free: participant, window start, count, last accepted time),
--     backfilled from existing contributions exactly as D1 0014 backfilled
--     it. A transferred schema should copy D1's own window rows instead:
--     D1 never refunds a slot when a contribution is deleted
--     ("not_refunded_by_contribution_deletion"), so a backfill from the
--     retained contributions can only undercount.
--   * the lifetime trigger telemetry_contributions_participant_limit and its
--     function are dropped;
--   * BEFORE/AFTER INSERT triggers enforce and record the weekly window as
--     D1's telemetry_contributions_enforce_admission_window and
--     telemetry_contributions_record_admission_window do.
--
-- The window start is D1's: floor((epoch seconds + 259200) / 604800) *
-- 604800 - 259200, in whole seconds (strftime('%s')), as UTC. Every RAISE
-- carries a constant message and ERRCODE; no value is interpolated. On
-- promotion, add telemetry_contribution_admission_windows to the
-- participant-table inventories that enumerate participant-owned tables.

CREATE FUNCTION telemetry_contribution_admission_window_start(created timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT pg_catalog.to_timestamp(
    ((pg_catalog.floor(pg_catalog.date_part('epoch', created))::bigint + 259200) / 604800) * 604800 - 259200
  )
$$;

CREATE TABLE telemetry_contribution_admission_windows (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  accepted_count integer NOT NULL CHECK (accepted_count BETWEEN 1 AND 100),
  last_accepted_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, window_started_at)
);

INSERT INTO telemetry_contribution_admission_windows (
  participant_id, window_started_at, accepted_count, last_accepted_at
)
SELECT participant_id, telemetry_contribution_admission_window_start(created_at),
       count(*), max(created_at)
  FROM telemetry_contributions
 GROUP BY participant_id, telemetry_contribution_admission_window_start(created_at);

DROP TRIGGER telemetry_contributions_participant_limit ON telemetry_contributions;
DROP FUNCTION telemetry_contributions_enforce_participant_limit();

CREATE FUNCTION telemetry_contributions_enforce_admission_window()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- The row lock serializes concurrent admissions of one participant-week;
  -- D1 serializes them by its single writer.
  IF COALESCE((
    SELECT window_row.accepted_count
      FROM telemetry_contribution_admission_windows window_row
     WHERE window_row.participant_id = NEW.participant_id
       AND window_row.window_started_at = telemetry_contribution_admission_window_start(NEW.created_at)
     FOR UPDATE
  ), 0) >= 100 THEN
    RAISE EXCEPTION 'contribution admission window exhausted' USING ERRCODE = 'P1003';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_contributions_enforce_admission_window
  BEFORE INSERT ON telemetry_contributions
  FOR EACH ROW EXECUTE FUNCTION telemetry_contributions_enforce_admission_window();

CREATE FUNCTION telemetry_contributions_record_admission_window()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO telemetry_contribution_admission_windows (
    participant_id, window_started_at, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id, telemetry_contribution_admission_window_start(NEW.created_at), 1, NEW.created_at
  )
  ON CONFLICT (participant_id, window_started_at)
  DO UPDATE SET accepted_count = telemetry_contribution_admission_windows.accepted_count + 1,
                last_accepted_at = EXCLUDED.last_accepted_at;
  RETURN NULL;
END;
$$;
CREATE TRIGGER telemetry_contributions_record_admission_window
  AFTER INSERT ON telemetry_contributions
  FOR EACH ROW EXECUTE FUNCTION telemetry_contributions_record_admission_window();

-- telemetry-envelope-v1.0 corrections. The Worker's typed v1 admission
-- (typed-v1-admission.ts at d43c8f92) supersedes the current chunk of a
-- slot and deletes that chunk's typed rows in the same batch (the old
-- header, allocation and event receipt stay). 0030's retention guard
-- refuses every typed-row delete short of a proven owner erasure, so this
-- replacement adds exactly one allowance and keeps the 0030 body otherwise
-- verbatim: a format-10 typed chunk, or a format-10 typed record inside a
-- chunk allocation, whose source telemetry_v1_chunks row in the pinned
-- typed v1 namespace is already superseded. The chunk delete cascades to
-- records, children and record admissions; a child row reached through
-- that cascade finds its record gone and is admitted by the 0030 branch.
-- Every other delete (a current chunk, format 11, owners, devices, shared
-- dimensions) still needs the terminal erasure proof.
CREATE OR REPLACE FUNCTION typed_telemetry_source_owner_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  namespace_value bigint;
  owner_value bigint;
  format_value smallint;
BEGIN
  IF TG_TABLE_NAME = 'typed_telemetry_owner_memberships' THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.owner_id;
    format_value := OLD.source_format;
  ELSIF TG_TABLE_NAME = 'typed_telemetry_owners' THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.id;
  ELSIF TG_TABLE_NAME IN ('typed_telemetry_devices', 'typed_telemetry_manifests',
      'typed_telemetry_chunks', 'typed_telemetry_records', 'typed_telemetry_identifiers',
      'typed_telemetry_attributions', 'typed_telemetry_quota_dimensions') THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.owner_id;
    IF TG_TABLE_NAME = 'typed_telemetry_chunks' OR TG_TABLE_NAME = 'typed_telemetry_records' THEN
      format_value := OLD.format;
    END IF;
  ELSE
    SELECT record.namespace_id, record.owner_id, record.format
      INTO namespace_value, owner_value, format_value
      FROM typed_telemetry_records record WHERE record.id = OLD.record_id;
  END IF;

  IF namespace_value IS NULL OR owner_value IS NULL THEN
    RETURN OLD;
  END IF;

  -- The v1.0 correction allowance. Separate statements: OLD.original_id
  -- and OLD.source_row_id exist only on their own tables.
  IF format_value = 10 AND TG_TABLE_NAME = 'typed_telemetry_chunks' THEN
    IF EXISTS (
      SELECT 1
        FROM typed_v1_admission_state state
        JOIN typed_v1_chunk_allocations allocation ON allocation.namespace_id = state.namespace_id
        JOIN telemetry_v1_chunks source_chunk ON source_chunk.id = allocation.chunk_id
       WHERE state.id = 1 AND state.runtime_contract_version = 1
         AND state.namespace_id = namespace_value
         AND allocation.chunk_original = OLD.original_id
         AND source_chunk.superseded_at IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
  ELSIF format_value = 10 AND TG_TABLE_NAME = 'typed_telemetry_records' THEN
    IF EXISTS (
      SELECT 1
        FROM typed_v1_admission_state state
        JOIN typed_v1_chunk_allocations allocation ON allocation.namespace_id = state.namespace_id
        JOIN telemetry_v1_chunks source_chunk ON source_chunk.id = allocation.chunk_id
       WHERE state.id = 1 AND state.runtime_contract_version = 1
         AND state.namespace_id = namespace_value
         AND OLD.source_row_id >= allocation.first_source_row_id
         AND OLD.source_row_id < allocation.first_source_row_id + allocation.record_count
         AND source_chunk.superseded_at IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  -- Shared source rows can be referenced by v1 and v1.1 memberships at once.
  -- Require terminal proof for every applicable membership; one linked format
  -- must not authorize deletion of a linkless or still-live sibling format.
  IF EXISTS (
    SELECT 1
      FROM typed_telemetry_owner_memberships membership
      LEFT JOIN storage_v11_owner_links owner_link
        ON owner_link.participant_id = membership.participant_id
      LEFT JOIN storage_owner_erasure_receipts receipt
        ON receipt.owner_digest = owner_link.owner_digest
     WHERE membership.namespace_id = namespace_value
       AND membership.owner_id = owner_value
       AND (format_value IS NULL OR membership.source_format = format_value)
       AND (owner_link.owner_digest IS NULL OR owner_link.state <> 'erased'
         OR receipt.owner_digest IS NULL)
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_source_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
