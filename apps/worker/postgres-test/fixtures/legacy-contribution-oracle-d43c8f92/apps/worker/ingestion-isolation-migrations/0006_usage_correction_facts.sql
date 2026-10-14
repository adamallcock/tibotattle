-- Source-side correction evidence with an inactive default. When activated,
-- the typed-v1 writer captures each prior usage source in the same transaction
-- as replacement, and the retirement guards also fence older workers.
-- v1.1/v1.2 capture remains refused
-- until their current-authority proof is separately qualified. The runtime row
-- remains staged until a separately reviewed activation changes it to active.
CREATE TABLE telemetry_usage_correction_runtime (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version TEXT NOT NULL CHECK(schema_version = 'telemetry-usage-correction-v1'),
  method_version TEXT NOT NULL CHECK(method_version = 'usage-total-correction-v1'),
  state TEXT NOT NULL CHECK(state IN ('staged', 'active')),
  max_capture_rows INTEGER NOT NULL CHECK(max_capture_rows BETWEEN 1 AND 200),
  max_history_page INTEGER NOT NULL CHECK(max_history_page BETWEEN 1 AND 200)
) STRICT;
INSERT INTO telemetry_usage_correction_runtime
  (id, schema_version, method_version, state, max_capture_rows, max_history_page)
VALUES (1, 'telemetry-usage-correction-v1', 'usage-total-correction-v1', 'staged', 200, 200);

-- A one-row trigger gate gives the D1 batch a real CAS assertion. SQLite's
-- RAISE() is only legal inside a trigger program, so this row is inserted and
-- consumed inside the same transaction immediately before source retirement.
CREATE TABLE telemetry_usage_correction_cas_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  participant_id TEXT NOT NULL,
  owner_digest BLOB NOT NULL CHECK(length(owner_digest) = 32),
  owner_revision INTEGER NOT NULL CHECK(owner_revision > 0),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
  runtime_state TEXT NOT NULL CHECK(runtime_state IN ('staged', 'active'))
) STRICT;
CREATE TRIGGER telemetry_usage_correction_cas_guard_validate
BEFORE INSERT ON telemetry_usage_correction_cas_guard
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM telemetry_usage_correction_runtime
     WHERE id=1 AND schema_version='telemetry-usage-correction-v1'
       AND method_version='usage-total-correction-v1'
       AND state=NEW.runtime_state
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_unavailable') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM storage_v11_owner_links link
    JOIN storage_owner_revisions owner ON owner.owner_digest=lower(hex(NEW.owner_digest))
     WHERE link.participant_id=NEW.participant_id
       AND link.owner_digest=lower(hex(NEW.owner_digest))
       AND link.state='active' AND owner.state='active'
       AND owner.revision=NEW.owner_revision
       AND owner.authority_epoch=NEW.authority_epoch
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_owner_conflict') END;
END;
CREATE TRIGGER telemetry_usage_correction_cas_guard_consume
AFTER INSERT ON telemetry_usage_correction_cas_guard
BEGIN DELETE FROM telemetry_usage_correction_cas_guard WHERE id=NEW.id; END;

-- Typed references are kept as integer IDs, not repeated text. The occurrence
-- and digests remain the original reversible/cryptographic bytes. Counters are
-- copied once so a superseded source row can be reconstructed after its chunk
-- is deleted; no JSON history payload is stored.
CREATE TABLE telemetry_usage_correction_history (
  id INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  owner_digest BLOB NOT NULL CHECK(length(owner_digest) = 32),
  owner_revision INTEGER NOT NULL CHECK(owner_revision > 0),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
  -- This first staged archive is current v1 only. v1.1 generations already
  -- retain their canonical source bytes; a separate qualified v1.1 bridge can
  -- extend this table without pretending that staged rows are authority.
  source_format INTEGER NOT NULL CHECK(source_format = 10),
  namespace_id INTEGER NOT NULL CHECK(namespace_id > 0),
  owner_id INTEGER NOT NULL CHECK(owner_id > 0),
  device_id INTEGER NOT NULL CHECK(device_id > 0),
  chunk_id INTEGER NOT NULL CHECK(chunk_id > 0),
  manifest_id INTEGER CHECK(manifest_id IS NULL OR manifest_id > 0),
  source_storage_row_id INTEGER NOT NULL CHECK(source_storage_row_id BETWEEN 1 AND 9007199254740991),
  source_row_id INTEGER NOT NULL CHECK(source_row_id BETWEEN 1 AND 9007199254740991),
  occurrence_id BLOB NOT NULL CHECK(length(occurrence_id) BETWEEN 2 AND 257),
  event_time_ms INTEGER NOT NULL CHECK(event_time_ms BETWEEN -8640000000000000 AND 8640000000000000),
  provider_id INTEGER NOT NULL CHECK(provider_id > 0),
  session_id INTEGER NOT NULL CHECK(session_id > 0),
  model_id INTEGER NOT NULL CHECK(model_id > 0),
  speed_mode_id INTEGER NOT NULL CHECK(speed_mode_id > 0),
  api_service_tier_id INTEGER NOT NULL CHECK(api_service_tier_id > 0),
  surface_id INTEGER NOT NULL CHECK(surface_id > 0),
  billing_surface_id INTEGER NOT NULL CHECK(billing_surface_id > 0),
  reasoning_effort_id INTEGER NOT NULL CHECK(reasoning_effort_id > 0),
  agent_scope_id INTEGER NOT NULL CHECK(agent_scope_id > 0),
  outcome_id INTEGER NOT NULL CHECK(outcome_id > 0),
  attribution_id INTEGER,
  total_input_context_tokens INTEGER CHECK(total_input_context_tokens BETWEEN 0 AND 1000000000000),
  input_uncached_tokens INTEGER CHECK(input_uncached_tokens BETWEEN 0 AND 1000000000000),
  input_cache_read_tokens INTEGER CHECK(input_cache_read_tokens BETWEEN 0 AND 1000000000000),
  input_cache_write_tokens INTEGER CHECK(input_cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_text_tokens INTEGER CHECK(output_text_tokens BETWEEN 0 AND 1000000000000),
  output_reasoning_tokens INTEGER CHECK(output_reasoning_tokens BETWEEN 0 AND 1000000000000),
  output_combined_tokens INTEGER CHECK(output_combined_tokens BETWEEN 0 AND 1000000000000),
  source_chunk_digest BLOB NOT NULL CHECK(length(source_chunk_digest) = 32),
  source_event_digest BLOB NOT NULL CHECK(length(source_event_digest) = 32),
  record_digest BLOB NOT NULL CHECK(length(record_digest) = 32),
  base_digest BLOB NOT NULL CHECK(length(base_digest) = 32),
  captured_at_ms INTEGER NOT NULL CHECK(captured_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(source_format = 10 AND manifest_id IS NULL)
) STRICT;
-- The physical typed row id is only a lookup hint. A source replacement may
-- allocate a different destination row id for the same immutable chunk/manifest
-- identity, so replay identity is scoped to durable typed references, the
-- original v1 chunk/event digests, and the source row/digest instead.
CREATE UNIQUE INDEX telemetry_usage_correction_history_identity
  ON telemetry_usage_correction_history(
    participant_id, owner_digest, source_format, namespace_id, owner_id, device_id,
    chunk_id, coalesce(manifest_id, 0), source_chunk_digest, source_event_digest,
    source_row_id, record_digest
  );
CREATE INDEX telemetry_usage_correction_history_owner_time
  ON telemetry_usage_correction_history(owner_digest, occurrence_id, event_time_ms, id);
CREATE INDEX telemetry_usage_correction_history_source
  ON telemetry_usage_correction_history(participant_id, source_format, source_storage_row_id, id);

-- A fact is a thin, replay-safe method application over one immutable source
-- proof. The effective-facts view below expands the compact history only when
-- a reader explicitly asks for it; totals are not duplicated here.
CREATE TABLE telemetry_usage_correction_facts (
  id INTEGER PRIMARY KEY,
  history_id INTEGER NOT NULL REFERENCES telemetry_usage_correction_history(id) ON DELETE CASCADE,
  method_version INTEGER NOT NULL CHECK(method_version = 1),
  captured_at_ms INTEGER NOT NULL CHECK(captured_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE(history_id, method_version)
) STRICT;
CREATE INDEX telemetry_usage_correction_facts_history ON telemetry_usage_correction_facts(history_id, id);
CREATE VIEW telemetry_usage_correction_effective_facts AS
SELECT f.id, f.history_id, f.method_version, f.captured_at_ms,
  h.participant_id, h.owner_digest, h.owner_revision, h.authority_epoch,
  h.source_format, h.namespace_id, h.owner_id, h.device_id, h.chunk_id, h.manifest_id,
  h.source_storage_row_id, h.source_row_id, h.occurrence_id, h.event_time_ms,
  h.total_input_context_tokens, h.output_combined_tokens, h.source_chunk_digest,
  h.source_event_digest, h.record_digest, h.base_digest
FROM telemetry_usage_correction_facts f
JOIN telemetry_usage_correction_history h ON h.id = f.history_id;

CREATE TRIGGER telemetry_usage_correction_runtime_immutable
BEFORE UPDATE ON telemetry_usage_correction_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.method_version IS NOT OLD.method_version
  OR NEW.max_capture_rows IS NOT OLD.max_capture_rows
  OR NEW.max_history_page IS NOT OLD.max_history_page
  OR (OLD.state = 'active' AND NEW.state IS NOT 'active')
  OR NEW.state NOT IN ('staged', 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_runtime_immutable'); END;
CREATE TRIGGER telemetry_usage_correction_runtime_retained
BEFORE DELETE ON telemetry_usage_correction_runtime
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_runtime_retained'); END;

-- D1 cascades child rows while the parent DELETE is in progress. Mark the
-- owner link terminal in this migration-owned BEFORE trigger so the history
-- and fact erasure fences observe the same owner-erasure proof during that
-- cascade, even when trigger ordering changes across the retained bridge.
CREATE TRIGGER telemetry_usage_correction_participant_erasure
BEFORE DELETE ON participants
BEGIN
  UPDATE storage_v11_owner_links SET state='erased'
   WHERE participant_id=OLD.id AND state!='erased';
  -- The owner-link row is itself an ON DELETE CASCADE child of participants.
  -- SQLite may cascade that row before it reaches correction children, so
  -- release our children explicitly while the terminal owner proof is still
  -- visible. The later FK cascade then has no correction rows left to visit.
  DELETE FROM telemetry_usage_correction_facts
   WHERE history_id IN (
     SELECT id FROM telemetry_usage_correction_history WHERE participant_id=OLD.id
   );
  DELETE FROM telemetry_usage_correction_history WHERE participant_id=OLD.id;
END;

-- Direct SQL cannot manufacture history: the exact typed row, owner CAS and
-- source authority must all be present while the source row still exists.
CREATE TRIGGER telemetry_usage_correction_history_provenance
BEFORE INSERT ON telemetry_usage_correction_history
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM telemetry_usage_correction_runtime
     WHERE id = 1 AND schema_version='telemetry-usage-correction-v1'
       AND state IN ('staged', 'active')
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_unavailable') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM storage_v11_owner_links link
    JOIN storage_owner_revisions owner ON owner.owner_digest = lower(hex(NEW.owner_digest))
     WHERE link.participant_id = NEW.participant_id
       AND link.owner_digest = lower(hex(NEW.owner_digest))
       AND link.state = 'active' AND owner.state = 'active'
       AND owner.revision = NEW.owner_revision
       AND owner.authority_epoch = NEW.authority_epoch
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_owner_conflict') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
      FROM typed_telemetry_records source
      JOIN typed_telemetry_usage usage ON usage.record_id = source.id
      JOIN typed_telemetry_compatibility_records decoded ON decoded.storage_row_id = source.id
     WHERE source.id = NEW.source_storage_row_id
       AND source.namespace_id = NEW.namespace_id AND source.format = NEW.source_format
       AND source.source_row_id = NEW.source_row_id AND source.owner_id = NEW.owner_id
       AND source.device_id = NEW.device_id AND source.chunk_id = NEW.chunk_id
       AND source.manifest_id IS NEW.manifest_id
       AND source.occurrence_id IS NEW.occurrence_id
       AND source.observed_at_ms = NEW.event_time_ms
       AND source.provider_id = NEW.provider_id
       AND usage.session_id = NEW.session_id AND usage.model_id = NEW.model_id
       AND usage.speed_mode_id = NEW.speed_mode_id
       AND usage.api_service_tier_id = NEW.api_service_tier_id
       AND usage.surface_id = NEW.surface_id AND usage.billing_surface_id = NEW.billing_surface_id
       AND usage.reasoning_effort_id = NEW.reasoning_effort_id
       AND usage.agent_scope_id = NEW.agent_scope_id AND usage.outcome_id = NEW.outcome_id
       AND usage.attribution_id IS NEW.attribution_id
       AND usage.total_input_context_tokens IS NEW.total_input_context_tokens
       AND usage.input_uncached_tokens IS NEW.input_uncached_tokens
       AND usage.input_cache_read_tokens IS NEW.input_cache_read_tokens
       AND usage.input_cache_write_tokens IS NEW.input_cache_write_tokens
       AND usage.output_text_tokens IS NEW.output_text_tokens
       AND usage.output_reasoning_tokens IS NEW.output_reasoning_tokens
       AND usage.output_combined_tokens IS NEW.output_combined_tokens
       AND source.canonical_digest IS NEW.record_digest
       AND decoded.stream = 'usage' AND decoded.participant_id = NEW.participant_id
       AND decoded.format_code = NEW.source_format
       AND (
         (NEW.source_format = 10 AND EXISTS (
           SELECT 1
             FROM typed_v1_record_admissions admission
             JOIN telemetry_v1_chunks current_chunk ON current_chunk.id = admission.chunk_id
             JOIN typed_v1_admission_state current_state
               ON current_state.id = 1 AND current_state.runtime_contract_version = 1
             JOIN typed_v1_event_sources current_event ON current_event.chunk_id = current_chunk.id
             JOIN storage_v11_owner_links current_link
               ON current_link.participant_id = current_chunk.participant_id
              AND current_link.owner_digest = lower(hex(NEW.owner_digest))
              AND current_link.state = 'active'
            WHERE admission.typed_record_id = source.id
              AND current_chunk.id = decoded.chunk_row_id
              AND current_chunk.participant_id = NEW.participant_id
              AND current_chunk.device_id = decoded.device_id
              AND current_chunk.stream = 'usage'
              AND current_chunk.superseded_at IS NULL
              AND current_chunk.accepted_record_count = current_chunk.record_count
              AND current_chunk.record_count = (
                SELECT count(*) FROM typed_v1_record_admissions current_admission
                 WHERE current_admission.chunk_id = current_chunk.id
              )
               AND current_state.source_namespace = decoded.source_namespace
               AND current_chunk.chunk_digest = lower(hex(NEW.source_chunk_digest))
               AND current_event.event_digest = lower(hex(NEW.source_event_digest))
               AND current_event.owner_digest = lower(hex(NEW.owner_digest))
              AND current_event.source_namespace = decoded.source_namespace
              -- The owner head may point to a newer chunk; it is not the
              -- authority digest for every admitted unsuperseded chunk.
         ))
       )
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_source_proof') END;
END;

-- Once the correction runtime is active, a typed-v1 replacement must archive
-- every admitted usage row before the typed chunk disappears. This guard is
-- intentionally on the typed target tables: an older worker can bypass the
-- new JavaScript hook, but cannot bypass the active database fence. The
-- physical typed row id is not part of the proof because a retry/restore may
-- relocate it; immutable chunk/event/source-row/canonical identities are.
CREATE TRIGGER telemetry_usage_correction_chunk_retirement
BEFORE DELETE ON typed_telemetry_chunks
WHEN OLD.format=10 AND OLD.stream=1
 AND EXISTS(
   SELECT 1 FROM telemetry_usage_correction_runtime
    WHERE id=1 AND schema_version='telemetry-usage-correction-v1' AND state='active'
 )
BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1
      FROM typed_v1_chunk_allocations allocation
      JOIN typed_v1_record_admissions admission ON admission.chunk_id=allocation.chunk_id
      JOIN typed_telemetry_records source ON source.id=admission.typed_record_id
      JOIN telemetry_v1_chunks v1 ON v1.id=allocation.chunk_id
      JOIN typed_v1_event_sources event ON event.chunk_id=v1.id
     WHERE allocation.namespace_id=OLD.namespace_id
       AND allocation.chunk_original=OLD.original_id
       AND NOT EXISTS(
         SELECT 1 FROM storage_v11_owner_links erased
          WHERE erased.participant_id=event.participant_id
            AND erased.owner_digest=event.owner_digest AND erased.state='erased'
       )
       AND NOT EXISTS(
         SELECT 1
           FROM telemetry_usage_correction_history history
           JOIN telemetry_usage_correction_facts fact
             ON fact.history_id=history.id AND fact.method_version=1
          WHERE history.participant_id=event.participant_id
            AND lower(hex(history.owner_digest))=event.owner_digest
            AND history.source_format=10
            AND history.namespace_id=source.namespace_id
            AND history.owner_id=source.owner_id
            AND history.device_id=source.device_id
            AND history.chunk_id=source.chunk_id
            AND history.manifest_id IS source.manifest_id
            AND history.source_row_id=source.source_row_id
            AND lower(hex(history.source_chunk_digest))=lower(v1.chunk_digest)
            AND lower(hex(history.source_event_digest))=event.event_digest
            AND history.record_digest IS source.canonical_digest
       )
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_archive_required') END;
END;

-- The v1 allocation is the remaining metadata anchor after a superseded
-- header no longer protects its admissions. A normal guarded retirement first
-- deletes the matching typed chunk (the trigger above proves its archive), and
-- only then does the parent FK cascade delete this allocation. Refuse a direct
-- allocation delete while that typed chunk still exists; an absent parent or
-- event during the later FK cascade is not treated as proof or as a bypass.
CREATE TRIGGER telemetry_usage_correction_allocation_retirement
BEFORE DELETE ON typed_v1_chunk_allocations
WHEN EXISTS(
   SELECT 1 FROM telemetry_usage_correction_runtime
    WHERE id=1 AND schema_version='telemetry-usage-correction-v1' AND state='active'
 )
BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM typed_telemetry_chunks typed
     WHERE typed.namespace_id=OLD.namespace_id
       AND typed.original_id=OLD.chunk_original
       AND typed.format=10 AND typed.stream=1
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_archive_required') END;
END;

-- Supersession marks the v1 header before its typed children are removed, so
-- the older current-record trigger no longer protects an admission row. Keep
-- membership itself fenced until the same immutable archive proof exists.
CREATE TRIGGER telemetry_usage_correction_admission_retirement
BEFORE DELETE ON typed_v1_record_admissions
WHEN EXISTS(
   SELECT 1 FROM telemetry_usage_correction_runtime
    WHERE id=1 AND schema_version='telemetry-usage-correction-v1' AND state='active'
 )
BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1
      FROM typed_telemetry_records source
      JOIN typed_telemetry_chunks chunk ON chunk.id=source.chunk_id
      JOIN typed_v1_chunk_allocations allocation
        ON allocation.namespace_id=chunk.namespace_id AND allocation.chunk_original=chunk.original_id
       AND allocation.chunk_id=OLD.chunk_id
      JOIN telemetry_v1_chunks v1 ON v1.id=allocation.chunk_id
      JOIN typed_v1_event_sources event ON event.chunk_id=v1.id
     WHERE source.id=OLD.typed_record_id
       AND NOT EXISTS(
         SELECT 1 FROM storage_v11_owner_links erased
          WHERE erased.participant_id=event.participant_id
            AND erased.owner_digest=event.owner_digest AND erased.state='erased'
       )
       AND NOT EXISTS(
         SELECT 1
           FROM telemetry_usage_correction_history history
           JOIN telemetry_usage_correction_facts fact
             ON fact.history_id=history.id AND fact.method_version=1
          WHERE history.participant_id=event.participant_id
            AND lower(hex(history.owner_digest))=event.owner_digest
            AND history.source_format=10
            AND history.namespace_id=source.namespace_id
            AND history.owner_id=source.owner_id
            AND history.device_id=source.device_id
            AND history.chunk_id=source.chunk_id
            AND history.manifest_id IS source.manifest_id
            AND history.source_row_id=source.source_row_id
            AND lower(hex(history.source_chunk_digest))=lower(v1.chunk_digest)
            AND lower(hex(history.source_event_digest))=event.event_digest
            AND history.record_digest IS source.canonical_digest
       )
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_archive_required') END;
END;

-- Keep the direct-record path fenced as well. The chunk guard normally runs
-- first during ON DELETE CASCADE, while this trigger closes a hand-written
-- DELETE FROM typed_telemetry_records bypass.
CREATE TRIGGER telemetry_usage_correction_record_retirement
BEFORE DELETE ON typed_telemetry_records
WHEN OLD.format=10 AND OLD.stream=1
 AND EXISTS(
   SELECT 1 FROM telemetry_usage_correction_runtime
    WHERE id=1 AND schema_version='telemetry-usage-correction-v1' AND state='active'
 )
BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1
      FROM typed_v1_record_admissions admission
      JOIN typed_v1_chunk_allocations allocation ON allocation.chunk_id=admission.chunk_id
      JOIN telemetry_v1_chunks v1 ON v1.id=allocation.chunk_id
      JOIN typed_v1_event_sources event ON event.chunk_id=v1.id
      JOIN typed_telemetry_chunks chunk ON chunk.id=OLD.chunk_id
     WHERE admission.typed_record_id=OLD.id
       AND allocation.namespace_id=chunk.namespace_id
       AND allocation.chunk_original=chunk.original_id
       AND NOT EXISTS(
         SELECT 1 FROM storage_v11_owner_links erased
          WHERE erased.participant_id=event.participant_id
            AND erased.owner_digest=event.owner_digest AND erased.state='erased'
       )
       AND NOT EXISTS(
         SELECT 1
           FROM telemetry_usage_correction_history history
           JOIN telemetry_usage_correction_facts fact
             ON fact.history_id=history.id AND fact.method_version=1
          WHERE history.participant_id=event.participant_id
            AND lower(hex(history.owner_digest))=event.owner_digest
            AND history.source_format=10
            AND history.namespace_id=OLD.namespace_id
            AND history.owner_id=OLD.owner_id
            AND history.device_id=OLD.device_id
            AND history.chunk_id=OLD.chunk_id
            AND history.manifest_id IS OLD.manifest_id
            AND history.source_row_id=OLD.source_row_id
            AND lower(hex(history.source_chunk_digest))=lower(v1.chunk_digest)
            AND lower(hex(history.source_event_digest))=event.event_digest
            AND history.record_digest IS OLD.canonical_digest
       )
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_archive_required') END;
END;

CREATE TRIGGER telemetry_usage_correction_history_immutable
BEFORE UPDATE ON telemetry_usage_correction_history
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_history_immutable'); END;
CREATE TRIGGER telemetry_usage_correction_history_erasure
BEFORE DELETE ON telemetry_usage_correction_history
WHEN NOT EXISTS(
  SELECT 1 FROM storage_owner_revisions owner
   WHERE owner.owner_digest = lower(hex(OLD.owner_digest)) AND owner.state = 'erased'
)
AND NOT EXISTS(
  SELECT 1 FROM storage_v11_owner_links link
   WHERE link.participant_id = OLD.participant_id
     AND link.owner_digest = lower(hex(OLD.owner_digest)) AND link.state = 'erased'
)
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_history_retained'); END;

CREATE TRIGGER telemetry_usage_correction_fact_provenance
BEFORE INSERT ON telemetry_usage_correction_facts
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM telemetry_usage_correction_runtime
     WHERE id = 1 AND schema_version='telemetry-usage-correction-v1'
       AND state IN ('staged', 'active')
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_unavailable') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM telemetry_usage_correction_history history
    JOIN storage_owner_revisions owner ON owner.owner_digest = lower(hex(history.owner_digest))
     WHERE history.id = NEW.history_id AND owner.state = 'active'
       AND history.owner_revision = owner.revision
       AND history.authority_epoch = owner.authority_epoch
  ) THEN RAISE(ABORT, 'telemetry_usage_correction_fact_proof') END;
END;
-- A valid archive row always gets its v1 method fact in the same SQLite
-- statement transaction. This closes the history-only half-batch path even
-- for an internal SQL caller; the public repository still batches retirement
-- after this trigger has succeeded.
CREATE TRIGGER telemetry_usage_correction_history_fact
AFTER INSERT ON telemetry_usage_correction_history
BEGIN
  INSERT INTO telemetry_usage_correction_facts(history_id,method_version,captured_at_ms)
    VALUES(NEW.id,1,NEW.captured_at_ms) ON CONFLICT(history_id,method_version) DO NOTHING;
END;
CREATE TRIGGER telemetry_usage_correction_fact_immutable
BEFORE UPDATE ON telemetry_usage_correction_facts
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_fact_immutable'); END;
CREATE TRIGGER telemetry_usage_correction_fact_erasure
BEFORE DELETE ON telemetry_usage_correction_facts
WHEN NOT EXISTS(
  SELECT 1 FROM telemetry_usage_correction_history history
  JOIN storage_owner_revisions owner ON owner.owner_digest = lower(hex(history.owner_digest))
   WHERE history.id = OLD.history_id AND owner.state = 'erased'
)
AND NOT EXISTS(
  SELECT 1 FROM telemetry_usage_correction_history history
  JOIN storage_v11_owner_links link ON link.participant_id = history.participant_id
   WHERE history.id = OLD.history_id AND link.owner_digest = lower(hex(history.owner_digest))
     AND link.state = 'erased'
)
BEGIN SELECT RAISE(ABORT, 'telemetry_usage_correction_fact_retained'); END;
