-- PostgreSQL primary migration 0095 (staged): fail-closed daily source
-- generation. This is a transaction fence, not a backfill: old immutable
-- daily rows retain NULL and therefore cannot be reused as `unchanged`.
--
-- The singleton covers the mutable rows read by the public daily projection
-- and its eligibility/policy fence, including v1/v1.1 source precedence and
-- the v1.2 authorization/runtime inputs. Publishers take FOR SHARE on it
-- before reading those inputs. BEFORE STATEMENT triggers take the conflicting
-- row lock before source DML, so a change either precedes the publisher's
-- snapshot or waits until after its commit. Statement triggers deliberately
-- invalidate on no-op/zero-row DML as a safe conservative false positive.

ALTER TABLE community_daily_aggregates
  ADD COLUMN public_source_generation bigint
    CHECK (public_source_generation IS NULL OR public_source_generation >= 1);

CREATE TABLE community_daily_v12_authority_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL CHECK (revision >= 1)
);
INSERT INTO community_daily_v12_authority_state(id, revision) VALUES (1, 1);

CREATE FUNCTION community_daily_v12_authority_state_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'community_daily_v12_authority_revision_step_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_daily_v12_authority_state_revision_guard
BEFORE UPDATE ON community_daily_v12_authority_state
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_authority_state_guard();

CREATE FUNCTION community_daily_v12_authority_state_no_removal()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_daily_v12_authority_state_retained' USING ERRCODE = 'P1005';
END;
$$;

CREATE TRIGGER community_daily_v12_authority_state_no_delete
BEFORE DELETE ON community_daily_v12_authority_state
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_authority_state_no_removal();
CREATE TRIGGER community_daily_v12_authority_state_no_truncate
BEFORE TRUNCATE ON community_daily_v12_authority_state
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_state_no_removal();

CREATE FUNCTION community_daily_v12_authority_advance()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE community_daily_v12_authority_state
     SET revision = revision + 1
   WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community_daily_v12_authority_state_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NULL;
END;
$$;

-- `a_` orders these BEFORE STATEMENT triggers ahead of existing same-relation
-- triggers. Acquiring the singleton before any row operation is important:
-- row-level triggers could hold an authority row first, which creates a
-- publisher/writer lock inversion when the writer has already pinned a source
-- journal row. The publisher takes no row locks on generation-covered inputs.
CREATE TRIGGER a_community_daily_authority_participants
BEFORE INSERT OR UPDATE OR DELETE ON participants
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_accountless_owners
BEFORE INSERT OR UPDATE OR DELETE ON accountless_upload_owners
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_accountless_ledger
BEFORE INSERT OR UPDATE OR DELETE ON accountless_enrollment_ledger
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_devices
BEFORE INSERT OR UPDATE OR DELETE ON device_credentials
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_grants
BEFORE INSERT OR UPDATE OR DELETE ON accountless_v11_device_authorizations
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_grants
BEFORE INSERT OR UPDATE OR DELETE ON accountless_v12_device_authorizations
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_retention_markers
BEFORE INSERT OR UPDATE OR DELETE ON accountless_public_history_retention
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_social_capabilities
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_device_capabilities
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_owner_links
BEFORE INSERT OR UPDATE OR DELETE ON storage_v11_owner_links
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_domains
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_domains
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_domains
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_domains
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_heads
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_domain_heads
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_heads
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_heads
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_domain_days
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_domain_days
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_domain_days
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_days
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v1_chunks
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v1_chunks
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v1_records
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v1_records
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_chunks
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_chunks
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_records
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_records
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_manifests
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_day_manifests
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_chunks
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_chunks
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_typed_records
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_records
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_typed_usage
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_usage
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_typed_quota
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_quota
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_session_tools
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_session_tools
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_attributions
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_attributions
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_dictionary
BEFORE INSERT OR UPDATE OR DELETE ON typed_telemetry_dictionary
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_source_state
BEFORE INSERT OR UPDATE OR DELETE ON storage_source_state
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_source_cursor
BEFORE INSERT OR UPDATE OR DELETE ON analytics_source_cursors
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_ingestion_changes
BEFORE INSERT OR UPDATE OR DELETE ON storage_ingestion_changes
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v1_admission
BEFORE INSERT OR UPDATE OR DELETE ON typed_v1_admission_state
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v11_admission
BEFORE INSERT OR UPDATE OR DELETE ON typed_v11_admission_state
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_publication_policy
BEFORE INSERT OR UPDATE OR DELETE ON publication_state
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_collection_controls
BEFORE INSERT OR UPDATE OR DELETE ON collection_controls
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_runtime
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_runtime
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();
CREATE TRIGGER a_community_daily_authority_v12_typed_runtime
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_typed_runtime
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_advance();

CREATE FUNCTION community_daily_v12_authority_truncate_refused()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_daily_public_source_truncate_refused' USING ERRCODE = 'P1005';
END;
$$;

-- PostgreSQL obtains ACCESS EXCLUSIVE before a TRUNCATE trigger fires. Refuse
-- truncation without touching the generation row; otherwise a publisher that
-- holds FOR SHARE and then reads the relation could deadlock with that lock.
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'participants', 'accountless_upload_owners', 'accountless_enrollment_ledger',
    'device_credentials', 'accountless_v11_device_authorizations',
    'accountless_v12_device_authorizations', 'accountless_public_history_retention',
    'telemetry_v12_device_capabilities', 'storage_v11_owner_links',
    'telemetry_v11_domains', 'telemetry_v12_domains', 'telemetry_v11_domain_heads',
    'telemetry_v12_domain_heads', 'telemetry_v11_domain_days', 'telemetry_v12_domain_days',
    'telemetry_v1_chunks', 'telemetry_v1_records', 'telemetry_v11_chunks',
    'telemetry_v11_records', 'telemetry_v12_day_manifests', 'telemetry_v12_chunks',
    'telemetry_v12_typed_records', 'telemetry_v12_typed_usage', 'telemetry_v12_typed_quota',
    'telemetry_v12_typed_session_tools', 'telemetry_v12_typed_attributions',
    'typed_telemetry_dictionary', 'storage_source_state', 'analytics_source_cursors',
    'storage_ingestion_changes', 'typed_v1_admission_state', 'typed_v11_admission_state',
    'publication_state', 'collection_controls', 'telemetry_v12_runtime',
    'telemetry_v12_typed_runtime'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_authority_truncate_refused()',
      'b_community_daily_authority_no_truncate_' || relation_name,
      relation_name
    );
  END LOOP;
END;
$$;
