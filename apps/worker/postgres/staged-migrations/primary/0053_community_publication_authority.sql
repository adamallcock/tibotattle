-- PostgreSQL primary migration 0053 (staged): community publication authority.
--
-- The typed Worker stamps every public community aggregate with a
-- StorageCommunityAuthority captured from the source database
-- (src/storage-community-authority.ts) and fences its writes against owner
-- erasure (D1 analytics 0007, 0011, 0014, 0015 and 0018). PostgreSQL had only
-- the JSON-mode daily tables of 0037. This migration adds the authority-bearing
-- schema that the publisher, reader, graph, erasure and import items share:
--
--   (1) community_public_source_bootstrap: the D1 0060 singleton, seeded by a
--       PostgreSQL discovery predicate instead of D1's accountless rule;
--   (2) community_v12_retained_authorization_scope: D1's
--       V12_RETAINED_AUTHORIZATION_SCOPE;
--   (3) analytics_storage_erasure_fences and _receipts (D1 analytics 0015);
--   (4) community_terminal_watermarks (D1 analytics 0018) plus a legacy floor;
--   (5) community_daily_heads with D1's revision = head + 1 order (0007);
--   (6) nullable authority columns and the erasure fence on
--       community_daily_aggregates (D1 analytics 0014);
--   (7) community_graph_previews (D1 analytics 0011 and 0014).
--
-- community_public_source_owners is OJ-1's (0046) and is only read here.
--
-- Safety boundary: this DDL defines target-side guards only. It does not
-- import Cloudflare D1 erasure fences, receipts or terminal watermarks, prove
-- that their source history was reconciled, or make the transfer/cutover
-- ready. Exact source-row accounting remains a separate fail-closed gate;
-- empty target proof tables do not mean that no prior erasure occurred.
-- Every RAISE carries a constant message and ERRCODE; no value, digest or
-- identifier is interpolated. Retained proof tables refuse DELETE and
-- TRUNCATE.

-- (1) Public contribution-source bootstrap. D1 0060:1066-1078 shape: a plain
-- singleton. Authority capture requires completed = 1 (D1
-- storage-community-authority.ts:41,127). PostgreSQL ports no walk, so both
-- cursors are always empty: D1's JSON-mode walk leaves the last participant
-- id in participant_cursor when it completes, and no participant inventory or
-- eraser scans this table. An importer writes '' for both cursors of a
-- completed D1 row; a row that carries a cursor is refused here instead of
-- being stored (the violation names the constraint, so a caller can map it
-- to a constant code without echoing the row).
CREATE TABLE community_public_source_bootstrap (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  policy_version text NOT NULL CHECK (policy_version = 'community-public-sources-v1'),
  participant_cursor text NOT NULL DEFAULT '',
  source_day_cursor text NOT NULL DEFAULT '',
  completed integer NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  CONSTRAINT community_public_source_bootstrap_cursors_empty
    CHECK (participant_cursor = '' AND source_day_cursor = '')
);

-- Journal-producing evidence of an eligible public source that has no
-- journal source row yet. D1 completes the bootstrap only through the
-- authority-restore walk (authority-restore-bootstrap.ts:52-109), which for
-- each eligible owner journals its v1.1 head, or, when it has none, every
-- current accepted v1 chunk, and fails closed otherwise. The v1.2 head is
-- journaled by the D1 delivery bridge when it is eligible for its device.
-- PostgreSQL receives those journal rows by transfer and ports no walk, so
-- the same three families are counted here:
--   * a current v1 chunk (superseded_at NULL, accepted_record_count > 0) of an
--     eligible owner without a v1.1 head, with no typed_v1_event_sources row;
--   * the v1.1 head of an eligible owner with no storage_v11_event_sources
--     row for its generation;
--   * a v1.2 head eligible for its domain device with no
--     storage_v12_event_sources row at (generation, head revision).
-- Legacy v0.x-only owners have no PostgreSQL head and are outside it.
-- Each family is counted up to 10000 rows, so a call stays bounded; zero is
-- exact.
CREATE FUNCTION community_public_source_bootstrap_pending()
RETURNS bigint
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT
    (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v1_chunks chunk
        WHERE chunk.superseded_at IS NULL AND chunk.accepted_record_count > 0
          AND EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = chunk.participant_id)
          AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads head
                           WHERE head.participant_id = chunk.participant_id)
          AND NOT EXISTS (SELECT 1 FROM typed_v1_event_sources source
                           WHERE source.chunk_id = chunk.id)
        LIMIT 10000) v1)
  + (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v11_domain_heads head
        WHERE EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = head.participant_id)
          AND NOT EXISTS (SELECT 1 FROM storage_v11_event_sources source
                           WHERE source.participant_id = head.participant_id
                             AND source.generation_id = head.generation_id)
        LIMIT 10000) v11)
  + (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v12_domain_heads head
         JOIN telemetry_v12_domains domain
           ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
        WHERE EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = head.participant_id
                         AND (eligible.device_id IS NULL OR eligible.device_id = domain.device_id))
          AND NOT EXISTS (SELECT 1 FROM storage_v12_event_sources source
                           WHERE source.participant_id = head.participant_id
                             AND source.generation_id = head.generation_id
                             AND source.head_revision = head.revision)
        LIMIT 10000) v12)
$$;

-- An empty schema therefore seeds complete, as D1 0060's seed does.
INSERT INTO community_public_source_bootstrap
  (singleton, policy_version, participant_cursor, source_day_cursor, completed)
SELECT 1, 'community-public-sources-v1', '', '',
       CASE WHEN community_public_source_bootstrap_pending() = 0 THEN 1 ELSE 0 END;

-- Completion step for scheduled maintenance: lock the singleton, re-evaluate
-- the predicate while incomplete and set completed only from 0 to 1. Once
-- complete it is a single locked read and never reverts. A transfer session
-- imports the sealed row instead and may not run it.
--
-- Invoker rights, default PUBLIC EXECUTE and no function grant: scheduled
-- maintenance runs it as the non-owner runtime login (POSTGRES_IAM_USER),
-- which holds table DML and no function grants beyond the ingest producers.
-- Every step is checked against the caller's own table privileges (UPDATE on
-- the singleton for the row lock, SELECT on the evidence and the eligibility
-- view), so a role without them is refused by the tables with 42501, and a
-- role with them could already set the flag directly. Unlike the producer
-- functions (insert_telemetry_v1_contribution, storage_journal_append,
-- storage_owner_link_ensure), revoking EXECUTE here would protect nothing and
-- would add a runtime grant to every environment.
CREATE FUNCTION community_public_source_bootstrap_advance()
RETURNS TABLE (completed integer, pending bigint)
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  current_completed integer;
  pending_count bigint;
BEGIN
  IF storage_journal_transfer_session() THEN
    RAISE EXCEPTION 'community_public_source_bootstrap_transfer_session' USING ERRCODE = 'P1005';
  END IF;
  SELECT bootstrap.completed INTO current_completed
    FROM community_public_source_bootstrap bootstrap
   WHERE bootstrap.singleton = 1 AND bootstrap.policy_version = 'community-public-sources-v1'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community_public_source_bootstrap_unavailable' USING ERRCODE = 'P1005';
  END IF;
  IF current_completed = 1 THEN
    RETURN QUERY SELECT 1, 0::bigint;
    RETURN;
  END IF;
  pending_count := community_public_source_bootstrap_pending();
  IF pending_count = 0 THEN
    UPDATE community_public_source_bootstrap bootstrap
       SET completed = 1
     WHERE bootstrap.singleton = 1 AND bootstrap.completed = 0
       AND bootstrap.policy_version = 'community-public-sources-v1';
    RETURN QUERY SELECT 1, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT 0, pending_count;
END;
$$;

-- (2) Retained v1.2 authorization scope: D1 V12_RETAINED_AUTHORIZATION_SCOPE
-- (storage-community-authority.ts:171-189). The first branch is the write
-- authority without an owner-link join; PostgreSQL's port of D1's
-- telemetry_v12_active_authorizations is 0025's typed view (D1's
-- telemetry_v12_runtime is PostgreSQL's telemetry_v12_typed_runtime). Not
-- 0025's retained view, which joins the owner link on that branch.
-- "authorization" is reserved in PostgreSQL and is quoted; D1's strftime
-- clock is now().
CREATE VIEW community_v12_retained_authorization_scope(participant_id, device_id) AS
      SELECT participant_id,device_id FROM telemetry_v12_typed_active_authorizations
      UNION
      SELECT capability.participant_id,capability.device_id
        FROM telemetry_v12_device_capabilities capability
        JOIN participants participant ON participant.id=capability.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link
          ON owner_link.participant_id=capability.participant_id AND owner_link.state='active'
       WHERE capability.state IN ('accepted','revoked')
         AND capability.telemetry_schema_version='telemetry-contribution-v1.2'
      UNION
      SELECT "authorization".participant_id,"authorization".device_credential_id
        FROM accountless_v12_device_authorizations "authorization"
        JOIN participants participant ON participant.id="authorization".participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link
          ON owner_link.participant_id="authorization".participant_id AND owner_link.state='active'
       WHERE ("authorization".state='active'
          AND "authorization".expires_at <= now())
          OR ("authorization".state='revoked' AND "authorization".revocation_reason='user_opt_out');

-- (3) Source-proven erasure fences and their payload receipts (D1 analytics
-- 0015). Both are retained proof: immutable, never deleted.
CREATE TABLE analytics_storage_erasure_fences (
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  terminal_event_digest text NOT NULL CHECK (terminal_event_digest ~ '^[0-9a-f]{64}$'),
  terminal_sequence bigint NOT NULL CHECK (terminal_sequence > 0),
  terminal_revision bigint NOT NULL CHECK (terminal_revision > 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  public_authority_epoch bigint NOT NULL CHECK (public_authority_epoch > 0),
  PRIMARY KEY (source_id, owner_digest)
);
CREATE INDEX analytics_storage_erasure_public_epoch
  ON analytics_storage_erasure_fences(source_id, public_authority_epoch DESC);

CREATE TABLE analytics_storage_erasure_receipts (
  source_id text NOT NULL,
  owner_digest text NOT NULL,
  terminal_event_digest text NOT NULL,
  payload_contract integer NOT NULL CHECK (payload_contract = 1),
  PRIMARY KEY (source_id, owner_digest),
  FOREIGN KEY (source_id, owner_digest)
    REFERENCES analytics_storage_erasure_fences(source_id, owner_digest)
);

CREATE FUNCTION analytics_storage_erasure_fence_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'storage_erasure_fence_conflict' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'storage_erasure_fence_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_storage_erasure_fence_guard
  BEFORE UPDATE OR DELETE ON analytics_storage_erasure_fences
  FOR EACH ROW EXECUTE FUNCTION analytics_storage_erasure_fence_guard();

CREATE FUNCTION analytics_storage_erasure_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'storage_erasure_receipt_immutable' USING ERRCODE = 'P1005';
  END IF;
  RAISE EXCEPTION 'storage_erasure_receipt_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_storage_erasure_receipt_guard
  BEFORE UPDATE OR DELETE ON analytics_storage_erasure_receipts
  FOR EACH ROW EXECUTE FUNCTION analytics_storage_erasure_receipt_guard();

CREATE FUNCTION community_publication_proof_no_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_publication_proof_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_storage_erasure_fence_no_truncate
  BEFORE TRUNCATE ON analytics_storage_erasure_fences
  FOR EACH STATEMENT EXECUTE FUNCTION community_publication_proof_no_truncate();
CREATE TRIGGER analytics_storage_erasure_receipt_no_truncate
  BEFORE TRUNCATE ON analytics_storage_erasure_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION community_publication_proof_no_truncate();

-- (4) Terminal containment watermark (D1 analytics 0018): the highest fenced
-- epoch, maintained in the fence's own transaction, or an imported D1
-- watermark. Version-0 journal terminals carry no public epoch;
-- legacy_terminal_floor_epoch is the explicit bound readers use for them,
-- and without it they fail closed. Every value is monotonic; a floor is set
-- once and only raised. The row is also the per-source lock of the write-side
-- erasure fence (6): the first authority write of a source may create it at
-- zero, so an import raises an existing row monotonically and never assumes
-- the table is empty.
CREATE TABLE community_terminal_watermarks (
  source_id text PRIMARY KEY CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  terminal_public_authority_epoch bigint NOT NULL CHECK (terminal_public_authority_epoch >= 0),
  terminal_sequence bigint NOT NULL CHECK (terminal_sequence >= 0),
  legacy_terminal_floor_epoch bigint CHECK (legacy_terminal_floor_epoch >= 0)
);

CREATE FUNCTION community_terminal_watermark_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community_terminal_watermark_retained' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.terminal_public_authority_epoch < OLD.terminal_public_authority_epoch
     OR NEW.terminal_sequence < OLD.terminal_sequence
     OR (OLD.legacy_terminal_floor_epoch IS NOT NULL
         AND (NEW.legacy_terminal_floor_epoch IS NULL
              OR NEW.legacy_terminal_floor_epoch < OLD.legacy_terminal_floor_epoch)) THEN
    RAISE EXCEPTION 'community_terminal_watermark_regression' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_terminal_watermark_guard
  BEFORE UPDATE OR DELETE ON community_terminal_watermarks
  FOR EACH ROW EXECUTE FUNCTION community_terminal_watermark_guard();
CREATE TRIGGER community_terminal_watermark_no_truncate
  BEFORE TRUNCATE ON community_terminal_watermarks
  FOR EACH STATEMENT EXECUTE FUNCTION community_publication_proof_no_truncate();

CREATE FUNCTION community_terminal_watermark_fenced()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO community_terminal_watermarks AS watermark
    (source_id, terminal_public_authority_epoch, terminal_sequence)
  VALUES (NEW.source_id, NEW.public_authority_epoch, NEW.terminal_sequence)
  ON CONFLICT (source_id) DO UPDATE SET
    terminal_public_authority_epoch = GREATEST(watermark.terminal_public_authority_epoch,
                                               EXCLUDED.terminal_public_authority_epoch),
    terminal_sequence = GREATEST(watermark.terminal_sequence, EXCLUDED.terminal_sequence);
  RETURN NULL;
END;
$$;
CREATE TRIGGER community_terminal_watermark_fenced
  AFTER INSERT ON analytics_storage_erasure_fences
  FOR EACH ROW EXECUTE FUNCTION community_terminal_watermark_fenced();

-- Delivered exact terminals are read from their retained applied receipts
-- (analytics_applied_events is append-only and never deleted; version-0
-- receipts carry no kind), so the applied-event import keeps a trigger-free
-- target. Readers take the greater of those and this row.

-- Terminal reads (MAX exact epoch, any legacy row) stay bounded.
CREATE INDEX storage_ingestion_terminal_epoch
  ON storage_ingestion_changes(source_id, public_authority_epoch)
  WHERE kind IN ('owner-withdrawn', 'owner-erased');
CREATE INDEX analytics_applied_terminal_epoch
  ON analytics_applied_events(source_id, public_authority_epoch)
  WHERE kind IN ('owner-withdrawn', 'owner-erased');

-- (5)/(6) Authority columns on the immutable daily revisions. All are
-- nullable so the JSON-mode publisher keeps writing its rows unchanged: a
-- row without provenance carries none of them. A row with provenance carries
-- the full D1 pin, its verbatim D1 authority text and ISO release time;
-- daily_device_method NULL means the device count must be recounted.
ALTER TABLE community_daily_aggregates
  ADD COLUMN public_authority_epoch bigint CHECK (public_authority_epoch >= 0),
  ADD COLUMN source_mutation_epoch bigint CHECK (source_mutation_epoch >= 0),
  ADD COLUMN journal_sequence bigint CHECK (journal_sequence >= 0),
  ADD COLUMN graph_invalidation_epoch bigint CHECK (graph_invalidation_epoch >= 0),
  ADD COLUMN cohort_digest text CHECK (cohort_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN provenance text CHECK (provenance IN ('gcp', 'd1_import')),
  ADD COLUMN import_receipt_id uuid,
  ADD COLUMN released_at_iso text
    CHECK (released_at_iso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  ADD COLUMN authority_json text
    CHECK (octet_length(convert_to(authority_json, 'UTF8')) <= 4096 AND authority_json IS JSON OBJECT),
  ADD COLUMN daily_device_method text CHECK (daily_device_method ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT community_daily_aggregates_authority_shape CHECK (
    (provenance IS NULL
      AND public_authority_epoch IS NULL AND source_mutation_epoch IS NULL
      AND journal_sequence IS NULL AND graph_invalidation_epoch IS NULL
      AND cohort_digest IS NULL AND import_receipt_id IS NULL AND released_at_iso IS NULL
      AND authority_json IS NULL AND daily_device_method IS NULL)
    OR
    (provenance IS NOT NULL
      AND public_authority_epoch IS NOT NULL AND source_mutation_epoch IS NOT NULL
      AND journal_sequence IS NOT NULL AND graph_invalidation_epoch IS NOT NULL
      AND cohort_digest IS NOT NULL AND released_at_iso IS NOT NULL AND authority_json IS NOT NULL
      AND (provenance = 'd1_import') = (import_receipt_id IS NOT NULL)
      AND released_at_iso = to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  );

-- (5) Per-day revision heads (D1 analytics 0007): a new revision must be
-- exactly head + 1, and the head then advances in the same transaction.
-- Existing JSON-mode revisions seed their day's head; heads are never
-- deleted and only ever advance by one.
CREATE TABLE community_daily_heads (
  source_id text NOT NULL,
  day date NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  cohort_digest text CHECK (cohort_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, day)
);
INSERT INTO community_daily_heads (source_id, day, revision, cohort_digest)
SELECT DISTINCT ON (aggregate.source_id, aggregate.day)
       aggregate.source_id, aggregate.day, aggregate.revision, aggregate.cohort_digest
  FROM community_daily_aggregates aggregate
 ORDER BY aggregate.source_id, aggregate.day, aggregate.revision DESC;

CREATE FUNCTION community_daily_head_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community_daily_head_retained' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.day IS DISTINCT FROM OLD.day
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'community_daily_head_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_head_guard
  BEFORE UPDATE OR DELETE ON community_daily_heads
  FOR EACH ROW EXECUTE FUNCTION community_daily_head_guard();
CREATE TRIGGER community_daily_head_no_truncate
  BEFORE TRUNCATE ON community_daily_heads
  FOR EACH STATEMENT EXECUTE FUNCTION community_publication_proof_no_truncate();

CREATE FUNCTION community_daily_revision_order()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  head_revision bigint;
BEGIN
  SELECT head.revision INTO head_revision
    FROM community_daily_heads head
   WHERE head.source_id = NEW.source_id AND head.day = NEW.day
   FOR UPDATE;
  IF NEW.revision IS DISTINCT FROM COALESCE(head_revision, 0) + 1 THEN
    RAISE EXCEPTION 'community_daily_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_revision_order
  BEFORE INSERT ON community_daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION community_daily_revision_order();

CREATE FUNCTION community_daily_head_advance()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO community_daily_heads AS head (source_id, day, revision, cohort_digest)
  VALUES (NEW.source_id, NEW.day, NEW.revision, NEW.cohort_digest)
  ON CONFLICT (source_id, day) DO UPDATE
    SET revision = EXCLUDED.revision, cohort_digest = EXCLUDED.cohort_digest;
  RETURN NULL;
END;
$$;
CREATE TRIGGER community_daily_head_advance
  AFTER INSERT ON community_daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION community_daily_head_advance();

-- (6) Pin consistency and the write-side erasure fence (D1 analytics
-- 0014:14-50). The verbatim authority text must be exactly the Worker's
-- StorageCommunityAuthority (plus dailyDeviceMethod on a daily row) and
-- agree with the pin columns; the pinned public epoch must not be below the
-- delivered cursor epoch or any erasure fence of the source, so a writer
-- captured before an erasure cannot recreate an aggregate after it.
--
-- D1 gets that ordering from its single writer. PostgreSQL writers run
-- concurrently (the daily publisher at REPEATABLE READ), so the floor is read
-- under row locks that every advance of it must also take:
--   * the source cursor row, FOR SHARE: a cursor advance updates that row;
--   * the source's terminal watermark row, FOR SHARE: every fence insert
--     upserts it in the fence's own transaction (the trigger below), and the
--     writer creates a zero row first when the source has none, so the lock
--     always has a row to hold.
-- A fence or cursor advance that commits after the writer's snapshot then
-- fails the writer with 40001 under REPEATABLE READ (the locked row, or the
-- zero row's conflict, is newer than the snapshot), or is waited for and
-- re-read under READ COMMITTED. One that starts later waits for the writer
-- to commit, so the publication orders before it and stays that erasure's
-- to contain. A zero watermark row reads exactly like no row, and a source
-- without a cursor row reads 0 as in D1 (activation creates cursors at 0;
-- only the fenced transfer imports them).
CREATE FUNCTION community_authority_integer_matches(document jsonb, key text, expected bigint)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT COALESCE(
    expected IS NOT NULL
      AND jsonb_typeof(document -> key) = 'number'
      AND (document ->> key) ~ '^(0|[1-9][0-9]{0,18})$'
      AND (document ->> key)::numeric = expected,
    false)
$$;

CREATE FUNCTION community_authority_pin_matches(
  authority_text text,
  allowed_keys text[],
  source_id_value text,
  source_namespace_value text,
  public_authority_epoch_value bigint,
  policy_revision_value bigint,
  collection_revision_value bigint,
  graph_invalidation_epoch_value bigint,
  source_epoch_value bigint,
  sequence_value bigint
)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE
  document jsonb;
BEGIN
  IF authority_text IS NULL OR NOT (authority_text IS JSON OBJECT) THEN
    RETURN false;
  END IF;
  document := authority_text::jsonb;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(document) key WHERE key <> ALL (allowed_keys))
    AND jsonb_typeof(document -> 'sourceId') = 'string'
    AND document ->> 'sourceId' = source_id_value
    AND jsonb_typeof(document -> 'sourceNamespace') = 'string'
    AND document ->> 'sourceNamespace' = source_namespace_value
    AND community_authority_integer_matches(document, 'publicAuthorityEpoch', public_authority_epoch_value)
    AND community_authority_integer_matches(document, 'policyRevision', policy_revision_value)
    AND community_authority_integer_matches(document, 'collectionRevision', collection_revision_value)
    AND community_authority_integer_matches(document, 'graphInvalidationEpoch', graph_invalidation_epoch_value)
    AND community_authority_integer_matches(document, 'sourceEpoch', source_epoch_value)
    AND community_authority_integer_matches(document, 'sequence', sequence_value);
END;
$$;

CREATE FUNCTION community_publication_erasure_floor(source_id_value text)
RETURNS bigint
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  cursor_epoch bigint;
  fence_epoch bigint;
BEGIN
  SELECT source_cursor.authority_epoch INTO cursor_epoch
    FROM analytics_source_cursors source_cursor
   WHERE source_cursor.source_id = source_id_value
   FOR SHARE;
  INSERT INTO community_terminal_watermarks (source_id, terminal_public_authority_epoch, terminal_sequence)
  VALUES (source_id_value, 0, 0)
  ON CONFLICT (source_id) DO NOTHING;
  PERFORM 1 FROM community_terminal_watermarks watermark
    WHERE watermark.source_id = source_id_value
    FOR SHARE;
  -- A new statement: under READ COMMITTED it sees every fence committed
  -- before the locks were granted.
  SELECT max(fence.public_authority_epoch) INTO fence_epoch
    FROM analytics_storage_erasure_fences fence
   WHERE fence.source_id = source_id_value;
  RETURN GREATEST(COALESCE(cursor_epoch, 0), COALESCE(fence_epoch, 0));
END;
$$;

CREATE FUNCTION community_daily_authority_fence()
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
  IF NEW.public_authority_epoch < community_publication_erasure_floor(NEW.source_id) THEN
    RAISE EXCEPTION 'analytics_publication_authority_stale' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_authority_fence
  BEFORE INSERT ON community_daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION community_daily_authority_fence();

-- (7) Graph preview snapshot (D1 analytics 0011) with the full pin, freshness
-- fields and provenance; replaced in place, fenced on insert and update.
CREATE TABLE community_graph_previews (
  source_id text PRIMARY KEY CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  source_namespace text NOT NULL
    CHECK (length(source_namespace) BETWEEN 1 AND 200 AND source_namespace !~ '[[:cntrl:]]'),
  revision bigint NOT NULL CHECK (revision > 0),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 128 AND method !~ '[[:cntrl:]]'),
  cohort_digest text NOT NULL CHECK (cohort_digest ~ '^[0-9a-f]{64}$'),
  authority_json text NOT NULL
    CHECK (octet_length(convert_to(authority_json, 'UTF8')) <= 4096 AND authority_json IS JSON OBJECT),
  public_authority_epoch bigint NOT NULL CHECK (public_authority_epoch >= 0),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 1),
  source_mutation_epoch bigint NOT NULL CHECK (source_mutation_epoch >= 0),
  journal_sequence bigint NOT NULL CHECK (journal_sequence >= 0),
  graph_invalidation_epoch bigint NOT NULL CHECK (graph_invalidation_epoch >= 0),
  model_revision bigint NOT NULL CHECK (model_revision >= 0),
  payload_json text NOT NULL
    CHECK (octet_length(convert_to(payload_json, 'UTF8')) <= 262144 AND payload_json IS JSON),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at text NOT NULL
    CHECK (generated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  snapshot_source_epoch bigint NOT NULL CHECK (snapshot_source_epoch >= 0),
  inputs_current integer NOT NULL CHECK (inputs_current IN (0, 1)),
  oldest_computed_ms bigint,
  newest_computed_ms bigint,
  provenance text NOT NULL CHECK (provenance IN ('gcp', 'd1_import')),
  import_receipt_id uuid,
  CHECK (payload_sha256 = encode(sha256(convert_to(payload_json, 'UTF8')), 'hex')),
  CHECK ((oldest_computed_ms IS NULL AND newest_computed_ms IS NULL)
      OR (oldest_computed_ms IS NOT NULL AND newest_computed_ms IS NOT NULL
          AND oldest_computed_ms >= 0 AND newest_computed_ms >= oldest_computed_ms)),
  CHECK ((provenance = 'd1_import') = (import_receipt_id IS NOT NULL))
);

CREATE FUNCTION community_graph_preview_authority_fence()
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
  IF NEW.public_authority_epoch < community_publication_erasure_floor(NEW.source_id) THEN
    RAISE EXCEPTION 'analytics_publication_authority_stale' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_graph_preview_authority_fence
  BEFORE INSERT OR UPDATE ON community_graph_previews
  FOR EACH ROW EXECUTE FUNCTION community_graph_preview_authority_fence();
