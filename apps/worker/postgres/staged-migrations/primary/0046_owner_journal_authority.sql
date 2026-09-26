-- PostgreSQL primary migration 0046 (staged): owner-journal authority.
--
-- D1 derives every exact (version-1) journal tuple from one owner revision
-- row per owner and refuses any tuple that does not continue it
-- (typed-ingestion 0002:33-63). PostgreSQL stored the same tuple since 0038
-- but kept no per-owner authority, so any producer could invent revisions and
-- epochs. This migration adds that authority:
--
--   * storage_owner_revisions: one retained head per (source, owner), derived
--     from existing exact rows (fail-closed backfill) and afterwards by an
--     AFTER INSERT derivation trigger that is never bypassed;
--   * storage_journal_append: the single live producer, D1-exact;
--   * storage_owner_link_ensure and storage_journal_transfer_session: the
--     shared owner-link mint and superuser-safe transfer predicate;
--   * community_public_source_owners: a line-by-line port of the five-branch
--     D1 eligibility view (ingestion-isolation 0011:16-193);
--   * storage_v12_event_sources: D1's per-head v1.2 publication receipt with
--     a published-chain membership guard;
--   * telemetry_emit_source_event: an owner with a head no longer receives
--     unqualified version-0 rows (D1 legacy bridge: raw rows only advance
--     exact input metadata).
--
-- Every RAISE carries a constant message and ERRCODE; no value, digest or
-- identifier is interpolated. Lock order on every path: participant, owner
-- link, v1.1/v1.2 domain head, storage_source_state, owner revision head.

-- (1) Owner revision heads. A head always names the exact journal row it
-- summarizes and is a retained tombstone: never deleted, never out of
-- 'erased', and its revision, epoch and sequence never decrease.
CREATE TABLE storage_owner_revisions (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  state text NOT NULL CHECK (state IN ('active', 'withdrawn', 'erased')),
  last_sequence bigint NOT NULL CHECK (last_sequence > 0),
  object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  seeded_partial boolean NOT NULL,
  PRIMARY KEY (source_id, owner_digest)
);
COMMENT ON COLUMN storage_owner_revisions.seeded_partial IS
  'True when the first exact row for this owner was not a D1-first owner-active revision 1 epoch 1 row; imported history must prove such heads before cutover.';

-- (2) Fail-closed backfill validation. Existing exact rows are imported D1
-- history or were written before this authority existed. Validate every
-- owner chain and the per-source public epoch before any index or trigger is
-- installed; one violation aborts the migration and leaves the schema at the
-- previous version. Version-0 rows are legacy scheduler history and are not
-- touched here.
DO $$
DECLARE
  singleton_source text;
  invalid_rows bigint;
BEGIN
  SELECT source_id INTO singleton_source FROM storage_source_state WHERE singleton = 1;
  -- The derivation trigger below accepts exact rows only for the singleton
  -- source. Hold existing history to the same rule.
  IF EXISTS (
    SELECT 1 FROM storage_ingestion_changes change
     WHERE change.event_tuple_version = 1
       AND (singleton_source IS NULL OR change.source_id <> singleton_source)
  ) THEN
    RAISE EXCEPTION 'storage_owner_revision_backfill_invalid' USING ERRCODE = 'P1005';
  END IF;
  WITH ordered AS (
    SELECT change.kind, change.revision, change.authority_epoch, change.public_authority_epoch,
           lag(change.kind) OVER owner_chain AS prior_kind,
           lag(change.revision) OVER owner_chain AS prior_revision,
           lag(change.authority_epoch) OVER owner_chain AS prior_authority_epoch,
           lag(change.public_authority_epoch) OVER source_chain AS prior_public_authority_epoch
      FROM storage_ingestion_changes change
     WHERE change.event_tuple_version = 1
    WINDOW owner_chain AS (PARTITION BY change.source_id, change.owner_digest ORDER BY change.sequence),
           source_chain AS (PARTITION BY change.source_id ORDER BY change.sequence)
  )
  SELECT count(*) INTO invalid_rows
    FROM ordered
   WHERE (prior_kind IS NOT NULL AND (
            revision <> prior_revision + 1
         OR authority_epoch <> prior_authority_epoch
              + CASE WHEN kind = 'source-updated' THEN 0 ELSE 1 END
         OR prior_kind = 'owner-erased'
         OR (kind = 'source-updated' AND prior_kind = 'owner-withdrawn')))
      OR (prior_public_authority_epoch IS NOT NULL
          AND public_authority_epoch < prior_public_authority_epoch);
  IF invalid_rows <> 0 THEN
    RAISE EXCEPTION 'storage_owner_revision_backfill_invalid' USING ERRCODE = 'P1005';
  END IF;
END;
$$;

-- (3) Journal indexes. The partial unique index makes a duplicate exact
-- revision impossible; the other two serve owner and previous-epoch reads.
CREATE UNIQUE INDEX storage_ingestion_owner_revision
  ON storage_ingestion_changes(source_id, owner_digest, revision)
  WHERE event_tuple_version = 1;
CREATE INDEX storage_ingestion_owner_sequence
  ON storage_ingestion_changes(source_id, owner_digest, sequence);
CREATE INDEX storage_ingestion_exact_sequence
  ON storage_ingestion_changes(source_id, sequence)
  WHERE event_tuple_version = 1;

-- (4) Seed heads from the validated history: the last exact row of each
-- owner, flagged partial when its first row was not a D1-first owner-active.
INSERT INTO storage_owner_revisions (
  source_id, owner_digest, revision, authority_epoch, state, last_sequence,
  object_digest, content_digest, seeded_partial
)
SELECT last_row.source_id, last_row.owner_digest, last_row.revision, last_row.authority_epoch,
       CASE last_row.kind WHEN 'owner-withdrawn' THEN 'withdrawn'
                          WHEN 'owner-erased' THEN 'erased' ELSE 'active' END,
       last_row.sequence, last_row.object_digest, last_row.content_digest,
       NOT (first_row.kind = 'owner-active' AND first_row.revision = 1
            AND first_row.authority_epoch = 1)
  FROM (
    SELECT DISTINCT ON (change.source_id, change.owner_digest)
           change.source_id, change.owner_digest, change.revision, change.authority_epoch,
           change.kind, change.sequence, change.object_digest, change.content_digest
      FROM storage_ingestion_changes change
     WHERE change.event_tuple_version = 1
     ORDER BY change.source_id, change.owner_digest, change.sequence DESC
  ) last_row
  JOIN (
    SELECT DISTINCT ON (change.source_id, change.owner_digest)
           change.source_id, change.owner_digest, change.kind, change.revision, change.authority_epoch
      FROM storage_ingestion_changes change
     WHERE change.event_tuple_version = 1
     ORDER BY change.source_id, change.owner_digest, change.sequence ASC
  ) first_row
    ON first_row.source_id = last_row.source_id AND first_row.owner_digest = last_row.owner_digest;

UPDATE storage_source_state source
   SET authority_epoch = GREATEST(source.authority_epoch, history.max_public_authority_epoch)
  FROM (
    SELECT change.source_id, max(change.public_authority_epoch) AS max_public_authority_epoch
      FROM storage_ingestion_changes change
     WHERE change.event_tuple_version = 1
     GROUP BY change.source_id
  ) history
 WHERE source.singleton = 1 AND history.source_id = source.source_id;

-- (5) Head retention guard.
CREATE FUNCTION storage_owner_revision_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage_owner_revision_retained' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       OLD.state = 'erased'
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.owner_digest IS DISTINCT FROM OLD.owner_digest
    OR NEW.seeded_partial IS DISTINCT FROM OLD.seeded_partial
    OR NEW.revision <= OLD.revision
    OR NEW.last_sequence <= OLD.last_sequence
    OR NEW.authority_epoch < OLD.authority_epoch
  ) THEN
    RAISE EXCEPTION 'storage_owner_revision_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage_ingestion_changes change
     WHERE change.source_id = NEW.source_id
       AND change.sequence = NEW.last_sequence
       AND change.owner_digest = NEW.owner_digest
       AND change.event_tuple_version = 1
       AND change.revision = NEW.revision
       AND change.authority_epoch = NEW.authority_epoch
       AND change.object_digest = NEW.object_digest
       AND change.content_digest = NEW.content_digest
       AND NEW.state = CASE change.kind WHEN 'owner-withdrawn' THEN 'withdrawn'
                                        WHEN 'owner-erased' THEN 'erased' ELSE 'active' END
  ) THEN
    RAISE EXCEPTION 'storage_owner_revision_unproven' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_owner_revision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storage_owner_revisions
  FOR EACH ROW EXECUTE FUNCTION storage_owner_revision_guard();

CREATE FUNCTION storage_owner_revision_no_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'storage_owner_revision_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER storage_owner_revision_no_truncate
  BEFORE TRUNCATE ON storage_owner_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION storage_owner_revision_no_truncate();

-- Exact rows are the evidence heads summarize. Match D1's journal guards
-- (typed-ingestion 0002:65-70) for them; version-0 rows keep their existing
-- behaviour.
CREATE FUNCTION storage_ingestion_exact_event_retained()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'storage_event_immutable' USING ERRCODE = 'P1005';
  END IF;
  RAISE EXCEPTION 'storage_event_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER storage_ingestion_exact_event_retained
  BEFORE UPDATE OR DELETE ON storage_ingestion_changes
  FOR EACH ROW WHEN (OLD.event_tuple_version = 1)
  EXECUTE FUNCTION storage_ingestion_exact_event_retained();

-- (6) Derivation trigger. AFTER ROW so a multi-row import page advances each
-- head in insertion order. It validates chain continuity only: D1's
-- first-row rules live in storage_journal_append, and imported chains are
-- proved separately. A first row seeds its head from whatever it carries and
-- is flagged partial unless it is owner-active revision 1 epoch 1.
CREATE FUNCTION storage_owner_revision_advance()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  source_id_value text;
  head storage_owner_revisions%ROWTYPE;
  neighbour_public_epoch bigint;
  epoch_delta bigint;
BEGIN
  SELECT source.source_id INTO source_id_value
    FROM storage_source_state source
   WHERE source.singleton = 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage_source_uninitialized' USING ERRCODE = 'P1005';
  END IF;
  IF source_id_value <> NEW.source_id THEN
    RAISE EXCEPTION 'storage_source_mismatch' USING ERRCODE = 'P1005';
  END IF;
  epoch_delta := CASE WHEN NEW.kind = 'source-updated' THEN 0 ELSE 1 END;

  SELECT * INTO head
    FROM storage_owner_revisions current_head
   WHERE current_head.source_id = NEW.source_id AND current_head.owner_digest = NEW.owner_digest
   FOR UPDATE;
  IF FOUND THEN
    IF head.state = 'erased' THEN
      RAISE EXCEPTION 'storage_owner_erased' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.revision <> head.revision + 1 OR NEW.sequence <= head.last_sequence THEN
      RAISE EXCEPTION 'storage_owner_revision_conflict' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.kind = 'source-updated' AND head.state <> 'active' THEN
      RAISE EXCEPTION 'storage_owner_ineligible' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.authority_epoch <> head.authority_epoch + epoch_delta THEN
      RAISE EXCEPTION 'storage_authority_conflict' USING ERRCODE = 'P1005';
    END IF;
  END IF;

  -- The public epoch never decreases along the source's exact rows.
  SELECT change.public_authority_epoch INTO neighbour_public_epoch
    FROM storage_ingestion_changes change
   WHERE change.source_id = NEW.source_id AND change.event_tuple_version = 1
     AND change.sequence < NEW.sequence
   ORDER BY change.sequence DESC
   LIMIT 1;
  IF neighbour_public_epoch IS NOT NULL AND NEW.public_authority_epoch < neighbour_public_epoch THEN
    RAISE EXCEPTION 'storage_public_authority_regressed' USING ERRCODE = 'P1005';
  END IF;
  neighbour_public_epoch := NULL;
  SELECT change.public_authority_epoch INTO neighbour_public_epoch
    FROM storage_ingestion_changes change
   WHERE change.source_id = NEW.source_id AND change.event_tuple_version = 1
     AND change.sequence > NEW.sequence
   ORDER BY change.sequence ASC
   LIMIT 1;
  IF neighbour_public_epoch IS NOT NULL AND NEW.public_authority_epoch > neighbour_public_epoch THEN
    RAISE EXCEPTION 'storage_public_authority_regressed' USING ERRCODE = 'P1005';
  END IF;
  -- A version-0 row after this exact row, even from the same statement,
  -- would mix tuple versions for a headed owner.
  IF EXISTS (
    SELECT 1 FROM storage_ingestion_changes change
     WHERE change.source_id = NEW.source_id AND change.owner_digest = NEW.owner_digest
       AND change.event_tuple_version = 0 AND change.sequence > NEW.sequence
  ) THEN
    RAISE EXCEPTION 'storage_owner_tuple_mixed' USING ERRCODE = 'P1005';
  END IF;

  IF head.owner_digest IS NULL THEN
    INSERT INTO storage_owner_revisions (
      source_id, owner_digest, revision, authority_epoch, state, last_sequence,
      object_digest, content_digest, seeded_partial
    ) VALUES (
      NEW.source_id, NEW.owner_digest, NEW.revision, NEW.authority_epoch,
      CASE NEW.kind WHEN 'owner-withdrawn' THEN 'withdrawn'
                    WHEN 'owner-erased' THEN 'erased' ELSE 'active' END,
      NEW.sequence, NEW.object_digest, NEW.content_digest,
      NOT (NEW.kind = 'owner-active' AND NEW.revision = 1 AND NEW.authority_epoch = 1)
    );
  ELSE
    UPDATE storage_owner_revisions
       SET revision = NEW.revision,
           authority_epoch = NEW.authority_epoch,
           state = CASE NEW.kind WHEN 'owner-withdrawn' THEN 'withdrawn'
                                 WHEN 'owner-erased' THEN 'erased' ELSE 'active' END,
           last_sequence = NEW.sequence,
           object_digest = NEW.object_digest,
           content_digest = NEW.content_digest
     WHERE source_id = NEW.source_id AND owner_digest = NEW.owner_digest;
  END IF;
  -- The journal transfer presets the final source epoch before its pages;
  -- live appends raise it by exactly their delta.
  UPDATE storage_source_state
     SET authority_epoch = GREATEST(authority_epoch, NEW.public_authority_epoch)
   WHERE singleton = 1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER storage_owner_revision_advance
  AFTER INSERT ON storage_ingestion_changes
  FOR EACH ROW WHEN (NEW.event_tuple_version = 1)
  EXECUTE FUNCTION storage_owner_revision_advance();

-- (7) Tuple-mixing guard: once an owner has a head, it never again receives
-- an unqualified version-0 row.
CREATE FUNCTION storage_ingestion_tuple_mixing_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage_owner_revisions head
     WHERE head.source_id = NEW.source_id AND head.owner_digest = NEW.owner_digest
  ) THEN
    RAISE EXCEPTION 'storage_owner_tuple_mixed' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_ingestion_tuple_mixing_guard
  BEFORE INSERT ON storage_ingestion_changes
  FOR EACH ROW WHEN (NEW.event_tuple_version = 0)
  EXECUTE FUNCTION storage_ingestion_tuple_mixing_guard();

-- (8) The single live producer of exact journal rows, D1-exact to
-- typed-ingestion 0002:33-63. Checks run in D1's order, so 'source-updated'
-- for an owner without an active head is ineligible (including an owner with
-- no head at all), and any other first kind is uninitialized. owner_revision
-- carries the exact revision; imported rows keep the transfer's 0.
CREATE FUNCTION storage_journal_append(
  kind_value text,
  owner_digest_value text,
  event_digest_value text,
  object_digest_value text,
  content_digest_value text
)
RETURNS bigint
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  source_row storage_source_state%ROWTYPE;
  head storage_owner_revisions%ROWTYPE;
  head_found boolean;
  epoch_delta bigint;
  next_revision bigint;
  next_sequence bigint;
BEGIN
  IF kind_value IS NULL
     OR kind_value NOT IN ('source-updated', 'owner-active', 'owner-withdrawn', 'owner-erased') THEN
    RAISE EXCEPTION 'storage_journal_kind_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF owner_digest_value IS NULL OR owner_digest_value !~ '^[0-9a-f]{64}$'
     OR event_digest_value IS NULL OR event_digest_value !~ '^[0-9a-f]{64}$'
     OR object_digest_value IS NULL OR object_digest_value !~ '^[0-9a-f]{64}$'
     OR content_digest_value IS NULL OR content_digest_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'storage_journal_digest_invalid' USING ERRCODE = 'P1005';
  END IF;

  SELECT * INTO source_row FROM storage_source_state WHERE singleton = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage_source_uninitialized' USING ERRCODE = 'P1005';
  END IF;
  SELECT * INTO head
    FROM storage_owner_revisions current_head
   WHERE current_head.source_id = source_row.source_id
     AND current_head.owner_digest = owner_digest_value
   FOR UPDATE;
  head_found := FOUND;
  IF head_found AND head.state = 'erased' THEN
    RAISE EXCEPTION 'storage_owner_erased' USING ERRCODE = 'P1005';
  END IF;
  IF kind_value = 'source-updated' AND (NOT head_found OR head.state <> 'active') THEN
    RAISE EXCEPTION 'storage_owner_ineligible' USING ERRCODE = 'P1005';
  END IF;
  IF NOT head_found AND kind_value <> 'owner-active' THEN
    RAISE EXCEPTION 'storage_owner_uninitialized' USING ERRCODE = 'P1005';
  END IF;

  -- A replayed event digest is refused with a constant code rather than a
  -- driver uniqueness error that would describe the conflicting key.
  IF EXISTS (
    SELECT 1 FROM storage_ingestion_changes change
     WHERE change.source_id = source_row.source_id AND change.event_digest = event_digest_value
  ) THEN
    RAISE EXCEPTION 'storage_journal_event_conflict' USING ERRCODE = 'P1005';
  END IF;

  epoch_delta := CASE WHEN kind_value = 'source-updated' THEN 0 ELSE 1 END;
  next_revision := CASE WHEN head_found THEN head.revision ELSE 0 END + 1;
  SELECT COALESCE(max(change.sequence), 0) + 1 INTO next_sequence
    FROM storage_ingestion_changes change
   WHERE change.source_id = source_row.source_id;
  INSERT INTO storage_ingestion_changes (
    source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch,
    kind, recorded_ms, event_tuple_version, revision, object_digest, content_digest,
    public_authority_epoch
  ) VALUES (
    source_row.source_id, next_sequence, event_digest_value, owner_digest_value, next_revision,
    CASE WHEN head_found THEN head.authority_epoch ELSE 0 END + epoch_delta,
    kind_value, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, 1, next_revision,
    object_digest_value, content_digest_value, source_row.authority_epoch + epoch_delta
  );
  RETURN next_sequence;
END;
$$;
REVOKE ALL ON FUNCTION storage_journal_append(text, text, text, text, text) FROM PUBLIC;

-- (9) Shared owner-link mint: idempotent, concurrency-safe, never 'erased'.
-- The digest is random and opaque, like D1's lower(hex(randomblob(32))).
CREATE FUNCTION storage_owner_link_ensure(participant_id_value text, initial_state text)
RETURNS text
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  digest text;
BEGIN
  IF initial_state IS NULL OR initial_state NOT IN ('active', 'withdrawn') THEN
    RAISE EXCEPTION 'storage_owner_link_state_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM participants participant WHERE participant.id = participant_id_value FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage_owner_link_participant_unavailable' USING ERRCODE = 'P1005';
  END IF;
  INSERT INTO storage_v11_owner_links (participant_id, owner_digest, state)
  VALUES (
    participant_id_value,
    encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
    initial_state
  )
  ON CONFLICT (participant_id) DO NOTHING;
  SELECT owner_link.owner_digest INTO digest
    FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = participant_id_value;
  IF digest IS NULL THEN
    RAISE EXCEPTION 'storage_owner_link_unavailable' USING ERRCODE = 'P1005';
  END IF;
  RETURN digest;
END;
$$;
REVOKE ALL ON FUNCTION storage_owner_link_ensure(text, text) FROM PUBLIC;

-- (10) Transfer-session predicate shared by every producer bypass. The role
-- is created by the transfer operator, never by a migration. pg_has_role is
-- true for superusers, so a superuser session is explicitly excluded.
CREATE FUNCTION storage_journal_transfer_session()
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tibotattle_source_transfer') THEN
    RETURN false;
  END IF;
  IF COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), true) THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.pg_has_role(session_user, 'tibotattle_source_transfer', 'MEMBER');
END;
$$;

-- (11) Public contribution-source eligibility: a line-by-line port of D1
-- ingestion-isolation 0011:16-193. Five disjoint branches: social; v1.1
-- active; v1.1 retained; v1.2 active; v1.2 retained. Like D1 the lease is
-- proved by equal expiries, not by a clock. The v1.2 predicates are the
-- exact text of primary 0045:74-131.
CREATE VIEW community_public_source_owners(participant_id, owner_kind, device_id) AS
SELECT p.id, p.owner_kind, NULL::text
FROM participants p WHERE p.owner_kind = 'social' AND p.state = 'active'
UNION ALL
SELECT p.id, p.owner_kind, device.id
FROM accountless_upload_owners owner
JOIN participants p ON p.id = owner.participant_id
JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
JOIN device_credentials device ON device.id = owner.device_credential_id
JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = owner.enrollment_device_id
 AND grant_row.participant_id = owner.participant_id
 AND grant_row.device_credential_id = owner.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
  AND device.state = 'active' AND device.revoked_at IS NULL
  AND grant_row.state = 'active' AND grant_row.revoked_at IS NULL AND grant_row.revocation_reason IS NULL
  AND device.participant_id = p.id AND device.authority_kind = 'accountless'
  AND device.id = ledger.device_id AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
  AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
  AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND grant_row.expires_at = ledger.expires_at
  AND EXISTS (SELECT 1 FROM telemetry_v11_domain_heads head
    JOIN telemetry_v11_domains domain ON domain.id = head.generation_id
    WHERE head.participant_id = p.id AND domain.participant_id = p.id
      AND domain.device_id = device.id)
UNION ALL
SELECT p.id, p.owner_kind, device.id
FROM accountless_public_history_retention retained
JOIN participants p ON p.id = retained.participant_id
JOIN accountless_upload_owners owner
  ON owner.participant_id = retained.participant_id
 AND owner.enrollment_device_id = retained.enrollment_device_id
 AND owner.device_credential_id = retained.device_credential_id
JOIN accountless_enrollment_ledger ledger
  ON ledger.device_id = retained.enrollment_device_id
JOIN device_credentials device
  ON device.id = retained.device_credential_id
 AND device.participant_id = retained.participant_id
JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = retained.enrollment_device_id
 AND grant_row.participant_id = retained.participant_id
 AND grant_row.device_credential_id = retained.device_credential_id
JOIN telemetry_v11_domain_heads head
  ON head.participant_id = retained.participant_id
 AND head.generation_id = retained.generation_id
 AND head.revision = retained.head_revision
JOIN telemetry_v11_domains domain
  ON domain.id = retained.generation_id
 AND domain.participant_id = retained.participant_id
 AND domain.device_id = retained.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
  AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
  AND grant_row.state = 'revoked' AND grant_row.revocation_reason = 'user_opt_out'
  AND device.state = 'revoked' AND device.authority_kind = 'accountless'
  AND ledger.revoked_at = retained.retained_at
  AND owner.revoked_at = retained.retained_at
  AND grant_row.revoked_at = retained.retained_at
  AND device.revoked_at = retained.retained_at
  AND device.id = ledger.device_id
  AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
  AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
  AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND grant_row.expires_at = ledger.expires_at
UNION ALL
-- Accountless v1.2 successor installs. The same active lease graph as the
-- v1.1 branch, proved by the separate v1.2 grant and an accepted v1.2 head for
-- this exact device. A device with any v1.1 domain stays on the branches
-- above, so no participant/device pair can match twice and no leftover v1.1
-- head becomes eligible through the successor grant.
SELECT p.id, p.owner_kind, device.id
FROM accountless_upload_owners owner
JOIN participants p ON p.id = owner.participant_id
JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
JOIN device_credentials device ON device.id = owner.device_credential_id
JOIN accountless_v12_device_authorizations successor
  ON successor.enrollment_device_id = owner.enrollment_device_id
 AND successor.participant_id = owner.participant_id
 AND successor.device_credential_id = owner.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
  AND device.state = 'active' AND device.revoked_at IS NULL
  AND successor.state = 'active' AND successor.revoked_at IS NULL AND successor.revocation_reason IS NULL
  AND device.participant_id = p.id AND device.authority_kind = 'accountless'
  AND device.id = ledger.device_id AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND successor.schema_version = 'accountless-upload-owner-v1.2'
  AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
  AND successor.authorization_basis = 'accountless-policy-v1.2'
  AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
  AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
  AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND successor.expires_at = ledger.expires_at
  AND EXISTS (SELECT 1 FROM telemetry_v12_domain_heads head
    JOIN telemetry_v12_domains domain ON domain.id = head.generation_id
    WHERE head.participant_id = p.id AND domain.participant_id = p.id
      AND domain.device_id = device.id)
  AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains legacy_domain
    WHERE legacy_domain.participant_id = p.id AND legacy_domain.device_id = device.id)
UNION ALL
-- The v1.2 counterpart of the retained-history branch: an ordinary opt-out
-- whose exact prospective marker names this device's accepted v1.2 head.
SELECT p.id, p.owner_kind, device.id
FROM accountless_public_history_retention retained
JOIN participants p ON p.id = retained.participant_id
JOIN accountless_upload_owners owner
  ON owner.participant_id = retained.participant_id
 AND owner.enrollment_device_id = retained.enrollment_device_id
 AND owner.device_credential_id = retained.device_credential_id
JOIN accountless_enrollment_ledger ledger
  ON ledger.device_id = retained.enrollment_device_id
JOIN device_credentials device
  ON device.id = retained.device_credential_id
 AND device.participant_id = retained.participant_id
JOIN accountless_v12_device_authorizations successor
  ON successor.enrollment_device_id = retained.enrollment_device_id
 AND successor.participant_id = retained.participant_id
 AND successor.device_credential_id = retained.device_credential_id
JOIN telemetry_v12_domain_heads head
  ON head.participant_id = retained.participant_id
 AND head.generation_id = retained.generation_id
 AND head.revision = retained.head_revision
JOIN telemetry_v12_domains domain
  ON domain.id = retained.generation_id
 AND domain.participant_id = retained.participant_id
 AND domain.device_id = retained.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
  AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
  AND successor.state = 'revoked' AND successor.revocation_reason = 'user_opt_out'
  AND device.state = 'revoked' AND device.authority_kind = 'accountless'
  AND ledger.revoked_at = retained.retained_at
  AND owner.revoked_at = retained.retained_at
  AND successor.revoked_at = retained.retained_at
  AND device.revoked_at = retained.retained_at
  AND device.id = ledger.device_id
  AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND successor.schema_version = 'accountless-upload-owner-v1.2'
  AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
  AND successor.authorization_basis = 'accountless-policy-v1.2'
  AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
  AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
  AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND successor.expires_at = ledger.expires_at
  AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains legacy_domain
    WHERE legacy_domain.participant_id = p.id AND legacy_domain.device_id = device.id);

-- (12) v1.2 publication receipts (D1 isolation 0011:262-275): one row per
-- bridged head change. The receipt survives while its owner is not erased.
CREATE TABLE storage_v12_event_sources (
  event_digest text PRIMARY KEY CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  generation_id text NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  previous_generation_id text,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  head_revision bigint NOT NULL CHECK (head_revision > 0),
  recorded_ms bigint NOT NULL CHECK (recorded_ms >= 0),
  UNIQUE (participant_id, generation_id, head_revision)
);
CREATE INDEX storage_v12_event_owner
  ON storage_v12_event_sources(owner_digest, event_digest);
CREATE INDEX storage_v12_event_generation
  ON storage_v12_event_sources(generation_id, owner_digest);

-- A receipt must describe a generation on the participant's published v1.2
-- chain: the current head, then each predecessor at one revision lower. This
-- is the 0029 storage_v11_event_source_membership_guard walk, so historical
-- D1 receipts for earlier heads import exactly.
CREATE FUNCTION storage_v12_event_source_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
     AND owner_link.owner_digest = NEW.owner_digest
     AND owner_link.state <> 'erased'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM telemetry_v12_domain_heads head
   WHERE head.participant_id = NEW.participant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM telemetry_v12_domains domain
     WHERE domain.id = NEW.generation_id
       AND domain.participant_id = NEW.participant_id
       AND domain.device_id = NEW.device_id
       AND domain.manifest_digest = NEW.manifest_digest
       AND domain.previous_generation_id IS NOT DISTINCT FROM NEW.previous_generation_id
  ) OR NOT EXISTS (
    WITH RECURSIVE published(generation_id, head_revision) AS (
      SELECT head.generation_id, head.revision::bigint
        FROM telemetry_v12_domain_heads head
       WHERE head.participant_id = NEW.participant_id
      UNION ALL
      SELECT prior.id, published.head_revision - 1
        FROM published
        JOIN telemetry_v12_domains current_generation
          ON current_generation.id = published.generation_id
        JOIN telemetry_v12_domains prior
          ON prior.id = current_generation.previous_generation_id
         AND prior.participant_id = current_generation.participant_id
       WHERE published.head_revision > 1
    )
    SELECT 1 FROM published
     WHERE generation_id = NEW.generation_id
       AND head_revision = NEW.head_revision
  ) THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_v12_event_source_membership_guard
  BEFORE INSERT ON storage_v12_event_sources
  FOR EACH ROW EXECUTE FUNCTION storage_v12_event_source_membership_guard();
CREATE TRIGGER storage_v12_event_source_retention_guard
  BEFORE UPDATE OR DELETE ON storage_v12_event_sources
  FOR EACH ROW EXECUTE FUNCTION telemetry_effective_membership_retention_guard();

-- (13) Raw-row parity with the D1 legacy bridge: an owner that already has
-- an exact head receives no scheduler row from raw telemetry changes; its
-- producers journal through storage_journal_append after writing an
-- event-source receipt. The calling 0014 triggers still advance
-- input_versions and input_source_digests exactly as before. An owner
-- without a head keeps the 0014 version-0 body verbatim.
CREATE OR REPLACE FUNCTION telemetry_emit_source_event(
  event_owner_id text,
  event_key_value text,
  input_revision_value bigint
)
RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source_id_value text;
        event_digest_value text;
        source_authority_epoch bigint;
        event_sequence bigint;
        event_owner_digest text;
        event_owner_revision bigint;
        event_owner_epoch bigint;
BEGIN
  IF event_owner_id IS NULL OR input_revision_value IS NULL THEN
    RETURN;
  END IF;
  -- Lock the source authority before reading its sequence so every producer
  -- serializes with the analytics worker and other source mutations.
  SELECT state.source_id,state.authority_epoch
    INTO source_id_value,source_authority_epoch
    FROM storage_source_state state
   WHERE state.singleton=1
   FOR UPDATE;
  IF source_id_value IS NOT NULL AND EXISTS (
    SELECT 1
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions head
        ON head.source_id=source_id_value AND head.owner_digest=link.owner_digest
     WHERE link.participant_id=event_owner_id
  ) THEN
    RETURN;
  END IF;
  SELECT link.owner_digest,owner.revision,owner.authority_epoch
    INTO event_owner_digest,event_owner_revision,event_owner_epoch
    FROM storage_v11_owner_links link
    JOIN analytics_owner_state owner
      ON owner.source_id=source_id_value AND owner.owner_digest=link.owner_digest
   WHERE link.participant_id=event_owner_id
     AND link.state='active' AND owner.state='active';
  IF source_id_value IS NULL
     OR event_owner_digest IS NULL
     OR event_owner_revision IS NULL
     OR event_owner_epoch IS NULL THEN
    RETURN;
  END IF;
  event_digest_value := md5(event_key_value || ':' || input_revision_value::text)
    || md5(event_owner_id || ':' || event_key_value || ':' || input_revision_value::text);
  SELECT COALESCE(MAX(changes.sequence),0)+1
    INTO event_sequence
    FROM storage_ingestion_changes changes
   WHERE changes.source_id=source_id_value;
  INSERT INTO storage_ingestion_changes
    (source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
  VALUES (source_id_value,event_sequence,event_digest_value,event_owner_digest,event_owner_revision,
    event_owner_epoch,'source-updated',floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
  ON CONFLICT (source_id,event_digest) DO NOTHING;
END;
$$;
