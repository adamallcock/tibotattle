import {
  createHash,
  createHmac,
  createSecretKey,
  randomBytes,
} from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The one local index.
//
// Everything the product needs in order to show a figure or to upload a
// contribution lives here, in typed columns. There is no JSON payload: the
// previous record shape spent 345 bytes per row re-encoding seven values that
// were byte-identical on all 662,454 rows, and re-parsed JSON on every read.
//
// Privacy invariants, enforced by construction rather than by review:
//
//   * No prompt, reply, reasoning or file content is read, parsed, retained or
//     logged. Only `turn_context`, `token_count` and `thread_settings_applied`
//     records are parsed, and only their metadata fields are projected. A
//     top-level `compacted` boundary is recognised from its bounded header;
//     its payload is never parsed. There is no column in this schema that can
//     hold free text from a rollout.
//   * `session_local` is HMAC(device_salt, codex_session_id) — 32 raw bytes,
//     irreversible, never leaves the Mac, never rotates. The upload pseudonym
//     stays HMAC(export_secret, session_local), computed at send time, and is
//     never stored here. Rotating the export secret therefore costs nothing;
//     under the old shape each rotation invalidated the whole index.
//   * `scope_local` is the same construction over the local account scope id.

export const LOCAL_UNIFIED_INDEX_SCHEMA_VERSION = "local-unified-index-v2";
export const LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION =
  "local-unified-index-v1";

// Stamped onto every row. A parser change re-scans only the affected rows'
// source files; rows whose rollout files have rotated away keep their
// last-good values and stay visibly marked as older-parser output.
//
// v2 (2026-08-08): the delta derivation now recognises interleaved cumulative
// counter streams and mid-file counter resets — a counter regression
// re-anchors without charging, and a cumulative delta that materially exceeds
// the co-reported per-turn `last_token_usage` charges the per-turn value
// instead of the inter-stream gap. Rows derived under v1 can carry phantom
// spend (measured: 13.02B phantom tokens in one session), so the incremental
// ingest forces a whole-file rescan of any source whose cursor was stamped by
// an older parser version.
//
// v3 (2026-08-10): session-lineage speed carry-forward. A fork/lineage
// descendant with no `thread_settings_applied` of its own now seeds its
// initial tier from the most-recent observed tier of its ancestor chain,
// recorded under the new `lineage_inherited` tier_source (never masquerading
// as `rollout_thread_settings`). Strictly lineage-scoped — a session's own
// resume segments plus its fork/parent chain, never concurrent unrelated
// threads. Rows derived under v2 label such turns `unobserved` (priced
// Standard even when the reachable ancestor declaration was Fast), so the
// incremental ingest forces a whole-file rescan of v2-stamped sources.
//
// v4 (2026-08-16): top-level turn and compaction boundaries are attached to
// the next accepted positive-input usage row. Compaction is recognised from
// the bounded record header. The parser bump is intentional: every
// still-present source is re-scanned once so the new table does not silently
// mean "no boundary" for files indexed under earlier parsers.
//
// v5 (2026-08-16): every usage row also records its content-free source byte
// order. Event keys are HMACs, so they are deliberately random and cannot
// break real same-millisecond timestamp ties.
//
// v6 (2026-08-16): exact order is stored compactly as an interned integer
// source id plus source offset directly on the usage fact. The initial
// pre-release relation duplicated two 32-byte HMACs and indexes per event.
// This parser bump also forces still-present development-v5 sources to
// re-scan and backfill those fields instead of leaving a current-looking
// cursor over NULL order state. Rows retained from rotated older-parser
// sources remain distinguishable by provenance and are withheld from
// adjacency analysis rather than guessed into an order.
//
// v7 (2026-08-17): every current usage and quota fact is bound to a staged,
// attested publication generation with exact source-local ordering and
// source-scoped quota admission. This composes the v6 boundary/order contract
// with the unified accounting cutover's provenance contract.
// v8 (2026-08-17): typed response-item tool observations are source-scoped and
// generation-bound. Existing v7 cursors must rescan so a complete generation
// cannot silently publish an empty tool projection for already indexed files.
//
// v9 (2026-08-23): stable thread identity and immutable rollout identity are
// separate. Source and event keys are now rollout-scoped, and paginated
// history-base counters are seeded at their exact byte/ordinal boundary. This
// changes primary-key semantics, so incremental ingest performs a cold staged
// rebuild instead of mixing v8 and v9 facts.
//
// v10 (2026-08-23): every scan is bound to one opened physical source
// snapshot. Malformed accounting and unfinished JSONL tails are quarantined,
// with physical identity and the quarantine reason persisted in the cursor so
// an unchanged damaged rollout terminates cheaply and a changed one retries
// from byte zero.
export const LOCAL_UNIFIED_INDEX_PARSER_VERSION = "unified-rollout-typed-v10";
export const LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION =
  "codex-immutable-rollout-v1";

// A row salvaged from a line that exceeded the bounded-line cap carries this
// parser version instead. The agreed schema has no "partial" column and the
// `outcome` enum is fixed by the telemetry contract, so the row-level parser
// stamp — which decision 4 of the design exists to provide — is where a
// degraded row is recorded. Kept in lockstep with the main constant: salvaged
// rows run the same delta derivation.
export const LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION =
  "unified-rollout-typed-v10-partial";

export const LOCAL_UNIFIED_INDEX_APPLICATION_ID = 0x554d5549;
const INDEX_APPLICATION_ID = LOCAL_UNIFIED_INDEX_APPLICATION_ID;
// Version 2 (2026-08-07) widens version 1 with the two incremental-ingest
// tables below: `source_cursor` and `lineage_snapshot`. Version 3 (2026-08-07)
// adds `session_identity`, the raw provider-issued session UUID beside its
// local join key: the owner ruled that session identifiers travel raw in
// telemetry-contribution-v1.0, and the HMAC join key cannot be inverted, so
// the raw identifier has to be recorded at ingest time. Version 4 (2026-08-16)
// adds local-only, content-free usage-boundary state and relation tables.
// Version 5 (2026-08-16) adds the exact content-free source order of each
// usage event. Version 6 stores that order compactly as two nullable integer
// columns on usage_event plus one interned local-source dimension. Version 7
// adds generation-bound usage/quota provenance. Version 8 adds source-scoped,
// generation-bound tool facts and widens the closed diagnostic vocabulary.
// Each widening is additive except that closed diagnostic CHECK widening,
// which is rebuilt transactionally while preserving every existing row.
export const LOCAL_UNIFIED_INDEX_USER_VERSION = 10;
const INDEX_USER_VERSION = LOCAL_UNIFIED_INDEX_USER_VERSION;
const MIGRATABLE_USER_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
// Compatibility is persisted separately from PRAGMA user_version so a newer
// writer can describe the oldest reader and writer that understand its
// semantics.  The current format intentionally requires v10 for both: the v9
// to v10 widening changes source-snapshot and quarantine authority, not just
// optional columns.
export const LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION = 10;
export const LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION = 10;
const COMPATIBILITY_META_KEYS = Object.freeze({
  formatUserVersion: "compatibility_format_user_version",
  minimumReaderUserVersion: "compatibility_minimum_reader_user_version",
  minimumWriterUserVersion: "compatibility_minimum_writer_user_version",
});
const SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 256;
const DEFAULT_COMMIT_ROWS = 10_000;
const LOCAL_DIGEST_KEYS = new WeakMap();
const DIAGNOSTIC_CODES = new Set([
  "relevantLines",
  "malformedLines",
  "malformedTimestamps",
  "malformedAccountingRecords",
  "malformedUsageRecords",
  "malformedRateLimitRecords",
  "partialLines",
  "salvagedRecords",
  "turnContexts",
  "tokenCounts",
  "forkReplayEventsSkipped",
  "unattributedForkReplayEventsSkipped",
  "cumulativeCounterRegressions",
  "tierEvents",
  "modelSeededFromLineage",
  "tierSeededFromLineage",
  "modelMissing",
  "oversizedLines",
  "contradictedLeadingSnapshotsSkipped",
  "toolRecords",
  "toolEvents",
  "toolRecordsSkipped",
  "toolSourceHistoryUnavailable",
]);
const GENERATION_ISSUE_CODES = new Set([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
]);
// The one shape a stored raw session identity may take: the provider-issued
// UUID. Deliberately narrower than the transport regex so a filename-shaped
// rollout-key fallback can never be recorded as an identity.
export const RAW_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Both enums are ordinals into the telemetry contract's fixed member lists.
// Their order is part of the on-disk format: append only, never reorder.
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "unknown",
]);
export const OUTCOMES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "retry",
  "unknown",
]);
const REASONING_EFFORT_ORDINALS = new Map(
  REASONING_EFFORTS.map((value, index) => [value, index]),
);
const OUTCOME_ORDINALS = new Map(OUTCOMES.map((value, index) => [value, index]));
export const REASONING_EFFORT_UNKNOWN = REASONING_EFFORT_ORDINALS.get("unknown");
export const OUTCOME_UNKNOWN = OUTCOME_ORDINALS.get("unknown");

export function reasoningEffortOrdinal(value) {
  return REASONING_EFFORT_ORDINALS.get(value) ?? REASONING_EFFORT_UNKNOWN;
}

export function outcomeOrdinal(value) {
  return OUTCOME_ORDINALS.get(value) ?? OUTCOME_UNKNOWN;
}

export function reasoningEffortName(ordinal) {
  return REASONING_EFFORTS[ordinal] ?? "unknown";
}

export function outcomeName(ordinal) {
  return OUTCOMES[ordinal] ?? "unknown";
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL) STRICT;

  -- Dimensions. Small, deduplicated, joined by integer id.
  CREATE TABLE IF NOT EXISTS parser_version(
    id INTEGER PRIMARY KEY,
    parser_version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    UNIQUE(parser_version, contract_version)) STRICT;

  CREATE TABLE IF NOT EXISTS ingest_run(
    id INTEGER PRIMARY KEY,
    received_at_ms INTEGER NOT NULL,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version) STRICT;

  -- A generation is the publication unit. Facts may be committed in batches,
  -- but only a generation whose final transaction says complete may become
  -- the reader's current publication.
  CREATE TABLE IF NOT EXISTS index_generation(
    id INTEGER PRIMARY KEY,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version,
    contract_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN
      ('in_progress', 'complete', 'partial', 'failed')),
    block_reason TEXT,
    discovered_source_count INTEGER,
    discovered_source_bytes INTEGER,
    indexed_source_count INTEGER,
    indexed_source_bytes INTEGER,
    skipped_source_count INTEGER,
    skipped_source_bytes INTEGER,
    skipped_thread_count INTEGER,
    usage_events INTEGER,
    quota_occurrences INTEGER,
    covered_start_ms INTEGER,
    covered_end_ms INTEGER,
    discovery_complete INTEGER NOT NULL DEFAULT 0
      CHECK(discovery_complete IN (0, 1)),
    diagnostics_complete INTEGER NOT NULL DEFAULT 0
      CHECK(diagnostics_complete IN (0, 1)),
    usage_provenance_complete INTEGER NOT NULL DEFAULT 0
      CHECK(usage_provenance_complete IN (0, 1)),
    source_order_complete INTEGER NOT NULL DEFAULT 0
      CHECK(source_order_complete IN (0, 1)),
    quota_provenance_complete INTEGER NOT NULL DEFAULT 0
      CHECK(quota_provenance_complete IN (0, 1)),
    tool_facts INTEGER,
    tool_fact_fingerprint TEXT,
    tool_provenance_complete INTEGER NOT NULL DEFAULT 0
      CHECK(tool_provenance_complete IN (0, 1))) STRICT;

  CREATE TABLE IF NOT EXISTS model(
    id INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL UNIQUE,
    recognition TEXT NOT NULL) STRICT;

  CREATE TABLE IF NOT EXISTS tier_semantics(
    id INTEGER PRIMARY KEY,
    api_service_tier TEXT NOT NULL,
    billing_surface TEXT NOT NULL,
    codex_speed_mode TEXT NOT NULL,
    tier_source TEXT NOT NULL,
    provider_tier_raw TEXT,
    UNIQUE(api_service_tier, billing_surface, codex_speed_mode,
           tier_source, provider_tier_raw)) STRICT;

  CREATE TABLE IF NOT EXISTS surface_class(
    id INTEGER PRIMARY KEY,
    agent_scope TEXT NOT NULL,
    surface TEXT NOT NULL,
    thread_source TEXT NOT NULL,
    lineage_disposition TEXT NOT NULL,
    UNIQUE(agent_scope, surface, thread_source, lineage_disposition)) STRICT;

  CREATE TABLE IF NOT EXISTS account_scope(
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    plan_type TEXT,
    scope_local BLOB,
    UNIQUE(status, reason, plan_type, scope_local)) STRICT;

  -- One HMAC per rollout source, interned once. Usage facts reference its
  -- small integer id rather than duplicating a 32-byte local digest per row.
  CREATE TABLE IF NOT EXISTS source_dimension(
    id INTEGER PRIMARY KEY,
    source_local BLOB NOT NULL UNIQUE) STRICT;

  -- Quota observations as their own series, referenced by usage events. Quota
  -- is re-observed every few minutes while turns fire continuously, so this
  -- deduplicates heavily while preserving the exact event-to-quota pairing the
  -- calibration depends on.
  CREATE TABLE IF NOT EXISTS quota_observation(
    id INTEGER PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    limit_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    plan_type TEXT,
    used_percent REAL,
    resets_at_ms INTEGER,
    duration_mins INTEGER,
    UNIQUE(observed_at_ms, limit_id, slot)) STRICT;

  -- Source-scoped quota occurrences preserve the readings that canonical
  -- quota_observation deliberately deduplicates. admission is the closed
  -- leading-window gate result; readers emit only admitted rows.
  CREATE TABLE IF NOT EXISTS quota_occurrence(
    id INTEGER PRIMARY KEY,
    generation_id INTEGER REFERENCES index_generation,
    source_local BLOB NOT NULL CHECK(length(source_local) = 32),
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 0),
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    canonical_observation_id INTEGER NOT NULL REFERENCES quota_observation,
    observed_at_ms INTEGER NOT NULL,
    provider TEXT NOT NULL,
    plan_type TEXT,
    limit_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    slot_order INTEGER NOT NULL CHECK(slot_order >= 0),
    used_percent REAL NOT NULL CHECK(used_percent >= 0 AND used_percent <= 100),
    resets_at_ms INTEGER,
    duration_mins INTEGER NOT NULL CHECK(duration_mins >= 1),
    admission TEXT NOT NULL CHECK(admission IN
      ('admitted', 'held', 'suppressed')),
    UNIQUE(source_local, source_offset, slot_order)) STRICT;

  -- Facts. Fixed width, typed, no JSON.
  CREATE TABLE IF NOT EXISTS usage_event(
    event_key BLOB PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    generation_id INTEGER REFERENCES index_generation,
    ingest_run_id INTEGER NOT NULL REFERENCES ingest_run,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version,
    -- NULL only on retained rows from a parser/schema that predates exact
    -- source ordering. Current-parser writers always set both fields.
    source_id INTEGER REFERENCES source_dimension,
    session_local BLOB NOT NULL,
    account_scope_id INTEGER NOT NULL REFERENCES account_scope,
    model_id INTEGER NOT NULL REFERENCES model,
    tier_id INTEGER NOT NULL REFERENCES tier_semantics,
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    quota_observation_id INTEGER REFERENCES quota_observation,
    source_local BLOB CHECK(source_local IS NULL OR length(source_local) = 32),
    source_offset INTEGER CHECK(source_offset IS NULL OR source_offset >= 0),
    source_ordinal INTEGER CHECK(source_ordinal IS NULL OR source_ordinal >= 0),
    tier_observed_at_ms INTEGER,
    reasoning_effort INTEGER NOT NULL,
    outcome INTEGER NOT NULL,
    -- Token counts. Integers only. No prompt, reply, reasoning or file content
    -- is read, parsed or stored anywhere in this schema.
    tokens_in_uncached INTEGER,
    tokens_in_cache_read INTEGER,
    tokens_in_cache_write INTEGER,
    tokens_in_cache_write_5m INTEGER,
    tokens_in_cache_write_1h INTEGER,
    tokens_out_text INTEGER,
    tokens_out_reasoning INTEGER,
    tokens_out_combined INTEGER,
    total_input_context INTEGER) STRICT;

  -- Local-only continuity boundary, attached to the exact next accepted
  -- positive-input usage event. Timestamps can tie in real rollout files, so
  -- a timestamp-range join is not sufficient. The source payload and
  -- replacement history are never parsed and have nowhere to be stored.
  -- Parser and run provenance are explicit so an analyzer can distinguish
  -- boundaries backfilled by v3 from history retained under an older parser.
  CREATE TABLE IF NOT EXISTS usage_event_boundary(
    current_event_key BLOB PRIMARY KEY
      REFERENCES usage_event(event_key) ON DELETE CASCADE,
    compaction_before INTEGER NOT NULL CHECK(compaction_before IN (0, 1)),
    turn_context_before INTEGER NOT NULL CHECK(turn_context_before IN (0, 1)),
    compacted_at_ms INTEGER,
    ingest_run_id INTEGER NOT NULL REFERENCES ingest_run,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version,
    session_local BLOB NOT NULL,
    CHECK(compaction_before = (compacted_at_ms IS NOT NULL)),
    CHECK(compaction_before = 1 OR turn_context_before = 1)) STRICT;

  CREATE TABLE IF NOT EXISTS tool_class_count(
    session_local BLOB NOT NULL,
    tool_class TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY(session_local, tool_class)) STRICT, WITHOUT ROWID;

  -- Source-scoped, generation-bound tool observations. The compatibility
  -- aggregate above remains for older contribution readers, but this table is
  -- the authoritative unified projection: one deterministic fact per typed
  -- response item and no raw tool name or input.
  CREATE TABLE IF NOT EXISTS tool_class_fact(
    event_key BLOB PRIMARY KEY CHECK(length(event_key) = 32),
    generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
    source_local BLOB NOT NULL CHECK(length(source_local) = 32),
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 0),
    session_local BLOB NOT NULL CHECK(length(session_local) = 32),
    observed_at_ms INTEGER NOT NULL,
    tool_ordinal INTEGER NOT NULL CHECK(tool_ordinal >= 0),
    tool_class TEXT NOT NULL CHECK(length(tool_class) BETWEEN 1 AND 64),
    source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
    UNIQUE(source_local, source_offset, tool_ordinal)) STRICT;

  -- Incremental ingest state (schema widening of 2026-08-07).
  --
  -- One row per rollout source: how far it has been scanned and the carried
  -- extractor state needed to resume mid-file. Everything here is typed
  -- metadata — a model identifier, an effort label, a provider tier token and
  -- six cumulative token counters. No path, no content.
  CREATE TABLE IF NOT EXISTS source_cursor(
    source_local BLOB PRIMARY KEY,     -- HMAC(device_salt, rollout key)
    source_ordinal INTEGER CHECK(source_ordinal IS NULL OR source_ordinal >= 0),
    session_local BLOB,
    scanned_bytes INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    source_dev INTEGER,
    source_ino INTEGER,
    source_birthtime_ms INTEGER,
    source_ctime_ms INTEGER,
    source_identity_token TEXT,
    source_state_token TEXT,
    quarantine_code TEXT CHECK(quarantine_code IS NULL OR quarantine_code IN (
      'codex_rollout_content_invalid',
      'codex_rollout_tail_incomplete',
      'codex_rollout_lineage_invalid')),
    -- 1 when this source's whole fork-replay snapshot set is durably in
    -- lineage_snapshot. A source scanned before anything forked from it was
    -- never asked to collect one; when a fork of it later appears, the
    -- incremental pass re-scans it once to build the set, then flips this.
    snapshots_persisted INTEGER NOT NULL,
    turn_context_seen INTEGER NOT NULL,
    carry_model TEXT,
    carry_effort TEXT,
    carry_tier_raw TEXT,
    carry_tier_observed_at_ms INTEGER, -- NULL means no tier state carried
    carry_total_input INTEGER,
    carry_total_cached INTEGER,
    carry_total_cache_write INTEGER,
    carry_total_output INTEGER,
    carry_total_reasoning INTEGER,
    carry_total_total INTEGER,
    ingest_run_id INTEGER NOT NULL REFERENCES ingest_run) STRICT;

  -- A turn or compaction can be the final complete line in the current scan.
  -- Preserve those bounded markers until an appended positive-input request
  -- arrives.
  -- This separate v4 table keeps the schema widening additive: older
  -- source_cursor rows need no ALTER TABLE rewrite.
  CREATE TABLE IF NOT EXISTS source_boundary_state(
    source_local BLOB PRIMARY KEY
      REFERENCES source_cursor(source_local) ON DELETE CASCADE,
    compacted_at_ms INTEGER,
    source_offset INTEGER,
    turn_context_pending INTEGER NOT NULL
      CHECK(turn_context_pending IN (0, 1)),
    ingest_run_id INTEGER NOT NULL REFERENCES ingest_run,
    CHECK((compacted_at_ms IS NULL) = (source_offset IS NULL)),
    CHECK(compacted_at_ms IS NOT NULL OR turn_context_pending = 1)) STRICT;

  -- Persisted fork-replay boundary. The in-memory-only snapshot sets were
  -- recorded as valid strictly for one-pass rebuilds; the moment ingest became
  -- incremental, an ancestor's set has to outlive the pass that built it so a
  -- later-ingested fork can still recognise replayed turns. Keys are stored as
  -- salted digests: membership is all the boundary check needs.
  CREATE TABLE IF NOT EXISTS lineage_snapshot(
    session_local BLOB NOT NULL,
    snapshot_local BLOB NOT NULL,
    PRIMARY KEY(session_local, snapshot_local)) STRICT, WITHOUT ROWID;

  -- Raw provider-issued session identity beside its local join key (schema
  -- widening of 2026-08-07, version 3). Owner decision: session identifiers
  -- travel RAW in telemetry-contribution-v1.0 — the UUID is a provider-issued
  -- pseudonymous identifier already sitting in filenames on this disk, so the
  -- hash defends nothing. Only a strictly UUID-shaped lineage session id is
  -- ever recorded here: a rollout-key fallback is filename-shaped and must
  -- never be stored. Sessions indexed before this widening whose sources have
  -- rotated away simply have no row.
  CREATE TABLE IF NOT EXISTS session_identity(
    session_local BLOB PRIMARY KEY,
    session_uuid TEXT NOT NULL) STRICT;

  -- One row per discovered source in a generation. No path or rollout text is
  -- retained; source_local is the device-local HMAC of the rollout key.
  CREATE TABLE IF NOT EXISTS generation_source(
    generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
    source_local BLOB NOT NULL CHECK(length(source_local) = 32),
    source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 0),
    session_local BLOB,
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    status TEXT NOT NULL CHECK(status IN
      ('pending', 'skipped', 'touched', 'resumed', 'rescanned', 'complete', 'failed')),
    discovered_size_bytes INTEGER NOT NULL CHECK(discovered_size_bytes >= 0),
    scanned_bytes INTEGER NOT NULL CHECK(scanned_bytes >= 0),
    mtime_ms INTEGER NOT NULL,
    diagnostics_complete INTEGER NOT NULL DEFAULT 0
      CHECK(diagnostics_complete IN (0, 1)),
    PRIMARY KEY(generation_id, source_local)) STRICT, WITHOUT ROWID;

  -- One bounded row per quarantine reason in a publication. Counts only: no
  -- path, thread id, rollout id, basename, message text or payload crosses
  -- this boundary. Owner-directed diagnostics use the separately salted
  -- discovery receipt before publication.
  CREATE TABLE IF NOT EXISTS generation_issue(
    generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
    code TEXT NOT NULL CHECK(code IN (
      'codex_rollout_compression_unsupported',
      'codex_rollout_filename_identity_mismatch',
      'codex_rollout_generation_ambiguous',
      'codex_rollout_lineage_invalid',
      'codex_rollout_content_invalid',
      'codex_rollout_tail_incomplete')),
    thread_count INTEGER NOT NULL CHECK(thread_count >= 0),
    source_count INTEGER NOT NULL CHECK(source_count >= 0),
    source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
    PRIMARY KEY(generation_id, code)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS generation_issue_group(
    generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
    group_local BLOB NOT NULL CHECK(length(group_local) = 32),
    code TEXT NOT NULL CHECK(code IN (
      'codex_rollout_compression_unsupported',
      'codex_rollout_filename_identity_mismatch',
      'codex_rollout_generation_ambiguous',
      'codex_rollout_lineage_invalid',
      'codex_rollout_content_invalid',
      'codex_rollout_tail_incomplete')),
    source_count INTEGER NOT NULL CHECK(source_count >= 0),
    source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
    PRIMARY KEY(generation_id, group_local, code)) STRICT, WITHOUT ROWID;

  -- Diagnostic names are deliberately a closed set. Counts contain no source
  -- path, message or content and are only meaningful when the owning source
  -- row says diagnostics_complete=1.
  CREATE TABLE IF NOT EXISTS source_diagnostic(
    generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
    source_local BLOB NOT NULL CHECK(length(source_local) = 32),
    code TEXT NOT NULL CHECK(code IN (
      'relevantLines', 'malformedLines', 'malformedTimestamps',
      'malformedAccountingRecords', 'malformedUsageRecords',
      'malformedRateLimitRecords',
      'partialLines', 'salvagedRecords', 'turnContexts', 'tokenCounts',
      'forkReplayEventsSkipped', 'unattributedForkReplayEventsSkipped',
      'cumulativeCounterRegressions', 'tierEvents', 'modelSeededFromLineage',
      'tierSeededFromLineage', 'modelMissing', 'oversizedLines',
      'contradictedLeadingSnapshotsSkipped', 'toolRecords', 'toolEvents',
      'toolRecordsSkipped', 'toolSourceHistoryUnavailable')),
    count INTEGER NOT NULL CHECK(count >= 0),
    PRIMARY KEY(generation_id, source_local, code)) STRICT, WITHOUT ROWID;

`;

// These indexes accelerate readers or generation attestation but are not
// needed by the writer's primary/UNIQUE conflict paths. A cold rebuild may
// omit them while loading facts and build them once, after the load, so
// SQLite does not maintain these secondary b-trees for every inserted row.
// Keep this list fixed and ordered: it is part of the staged-publication
// contract, not a caller-provided SQL surface. In particular,
// quota_occurrence_canonical must exist before finalizeGeneration runs its
// quota-observation coverage proof.
const SECONDARY_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS usage_event_observed
    ON usage_event(observed_at_ms);
  CREATE INDEX IF NOT EXISTS usage_event_session
    ON usage_event(session_local);
  CREATE INDEX IF NOT EXISTS usage_event_boundary_session
    ON usage_event_boundary(session_local);
  CREATE INDEX IF NOT EXISTS usage_event_replay_order
    ON usage_event(observed_at_ms, source_ordinal, source_local,
                   source_offset, event_key);
  CREATE INDEX IF NOT EXISTS quota_occurrence_canonical
    ON quota_occurrence(canonical_observation_id);
  CREATE INDEX IF NOT EXISTS quota_occurrence_replay_order
    ON quota_occurrence(observed_at_ms, source_ordinal, source_local,
                        source_offset, slot_order, id);
  CREATE INDEX IF NOT EXISTS tool_class_fact_generation
    ON tool_class_fact(generation_id, event_key);
  CREATE INDEX IF NOT EXISTS tool_class_fact_source
    ON tool_class_fact(source_local);
`;

const SECONDARY_INDEX_NAMES = Object.freeze([
  "usage_event_observed",
  "usage_event_session",
  "usage_event_boundary_session",
  "usage_event_replay_order",
  "quota_occurrence_canonical",
  "quota_occurrence_replay_order",
  "tool_class_fact_generation",
  "tool_class_fact_source",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function schemaNewerError(compatibility, { readOnly = false } = {}) {
  const accessRequirement = readOnly
    ? compatibility.minimumReaderUserVersion
    : compatibility.minimumWriterUserVersion;
  const requirements = [
    ["pragma_user_version", compatibility.userVersion],
    ["format_user_version", compatibility.formatUserVersion],
    [readOnly ? "minimum_reader_user_version" : "minimum_writer_user_version",
      accessRequirement],
  ].filter(([, version]) => Number.isSafeInteger(version)
    && version > INDEX_USER_VERSION);
  const error = fixedError("local_unified_index_schema_newer");
  error.compatibility = Object.freeze({
    accessMode: readOnly ? "read" : "write",
    databaseUserVersion: compatibility.userVersion,
    formatUserVersion: compatibility.formatUserVersion,
    supportedUserVersion: INDEX_USER_VERSION,
    minimumReaderUserVersion: compatibility.minimumReaderUserVersion,
    minimumWriterUserVersion: compatibility.minimumWriterUserVersion,
    requiredUserVersion: Math.max(...requirements.map(([, version]) => version)),
    requirements: Object.freeze(requirements.map(([requirement, version]) => (
      Object.freeze({ requirement, version })
    ))),
  });
  return error;
}

export function defaultLocalUnifiedIndexPath(root = process.cwd()) {
  return resolve(root, ".usage-monitor", "local-unified-index-v1.sqlite");
}

export function defaultLocalUnifiedIndexSecretPath(
  indexFile = defaultLocalUnifiedIndexPath(),
) {
  return resolve(dirname(resolve(indexFile)), "local-unified-index-device-salt-v1");
}

export function defaultLocalUnifiedIndexRecoveryLockPath(indexFile) {
  return `${resolve(indexFile)}.recovery.lock`;
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function safeDirectoryComponent(metadata, { trustedBoundary = false } = {}) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
  if (typeof process.getuid !== "function" || process.platform === "win32") {
    return true;
  }
  const currentUid = process.getuid();
  if (metadata.uid === currentUid) {
    // Read/execute sharing is harmless; only the owner may replace children.
    return (metadata.mode & 0o022) === 0;
  }
  if (!trustedBoundary || metadata.uid !== 0) return false;
  // Root-owned ancestors are a trust boundary. A sticky root-owned temporary
  // directory is also safe because other users cannot replace our child.
  return (metadata.mode & 0o022) === 0 || (metadata.mode & 0o1000) !== 0;
}

function captureSafeLocalUnifiedIndexDirectoryChain(indexFile) {
  const chain = [];
  let directory = dirname(resolve(indexFile));
  while (true) {
    let metadata;
    try {
      metadata = lstatSync(directory);
    } catch {
      throw fixedError("local_unified_index_file_invalid");
    }
    const ownedByCurrentUser = typeof process.getuid !== "function"
      || metadata.uid === process.getuid();
    const parent = dirname(directory);
    const trustedBoundary = !ownedByCurrentUser || parent === directory;
    if (!safeDirectoryComponent(metadata, { trustedBoundary })) {
      throw fixedError("local_unified_index_file_invalid");
    }
    chain.push(Object.freeze({
      path: directory,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    }));
    if (trustedBoundary) break;
    directory = parent;
  }
  return Object.freeze(chain);
}

function sameLocalUnifiedIndexDirectoryChain(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
      && entry.dev === right[index].dev
      && entry.ino === right[index].ino
      && entry.uid === right[index].uid
      && entry.mode === right[index].mode
  ));
}

function recheckLocalUnifiedIndexDirectoryChain(indexFile, expected) {
  const current = captureSafeLocalUnifiedIndexDirectoryChain(indexFile);
  if (!sameLocalUnifiedIndexDirectoryChain(expected, current)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  return current;
}

export function assertSafeLocalUnifiedIndexParentPath(
  indexFile,
  expectedDirectoryChain = null,
) {
  const current = captureSafeLocalUnifiedIndexDirectoryChain(indexFile);
  if (expectedDirectoryChain !== null
      && !sameLocalUnifiedIndexDirectoryChain(expectedDirectoryChain, current)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  return current;
}

function safeLocalUnifiedIndexTargetSync(indexFile, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = lstatSync(resolve(indexFile));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_unavailable");
  }
  if (!ownerOnlyRegularFile(metadata)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  return metadata;
}

function sameLocalUnifiedIndexTarget(left, right) {
  return ownerOnlyRegularFile(left)
    && ownerOnlyRegularFile(right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function reserveNewLocalUnifiedIndexTarget(indexFile, expectedDirectoryChain) {
  recheckLocalUnifiedIndexDirectoryChain(indexFile, expectedDirectoryChain);
  let descriptor;
  try {
    descriptor = openSync(
      resolve(indexFile),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw fixedError("local_unified_index_file_invalid");
    }
    throw fixedError("local_unified_index_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const directoryChain = recheckLocalUnifiedIndexDirectoryChain(
    indexFile,
    expectedDirectoryChain,
  );
  return Object.freeze({
    metadata: safeLocalUnifiedIndexTargetSync(indexFile),
    directoryChain,
  });
}

export async function assertSafeLocalUnifiedIndexTarget(
  indexFile,
  { allowMissing = true } = {},
) {
  const directoryChain = captureSafeLocalUnifiedIndexDirectoryChain(indexFile);
  let metadata;
  try {
    metadata = await lstat(resolve(indexFile));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      recheckLocalUnifiedIndexDirectoryChain(indexFile, directoryChain);
      return null;
    }
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_unavailable");
  }
  if (!ownerOnlyRegularFile(metadata)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  recheckLocalUnifiedIndexDirectoryChain(indexFile, directoryChain);
  return metadata;
}

/**
 * The device salt. 32 random bytes, owner-only, created once and never
 * rotated: it is the key for `session_local`, which is the join key of the
 * whole index. Rotation is deliberately not offered — the value it protects
 * never leaves this machine, and rotating it would orphan every stored row.
 */
export async function readOrCreateDeviceSalt(
  secretFile = defaultLocalUnifiedIndexSecretPath(),
) {
  await mkdir(dirname(resolve(secretFile)), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(
      secretFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const secret = randomBytes(SECRET_BYTES);
    await handle.writeFile(secret);
    await handle.sync();
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw fixedError("local_unified_index_secret_unavailable");
    }
  } finally {
    await handle?.close();
  }
  const secret = await readExistingDeviceSalt(secretFile);
  await chmod(secretFile, 0o600);
  return secret;
}

/**
 * Read an existing device salt without creating directories, changing mode,
 * or otherwise mutating the path. Recovery preparation uses this stricter
 * operation so a missing or damaged live identity cannot be silently repaired
 * while constructing a candidate.
 */
export async function readExistingDeviceSalt(
  secretFile = defaultLocalUnifiedIndexSecretPath(),
) {
  const directoryChain = captureSafeLocalUnifiedIndexDirectoryChain(secretFile);
  let readHandle;
  try {
    readHandle = await open(
      secretFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await readHandle.stat();
    if (!ownerOnlyRegularFile(metadata)
        || metadata.size < SECRET_BYTES
        || metadata.size > MAX_SECRET_BYTES) {
      throw fixedError("local_unified_index_secret_invalid");
    }
    const buffer = await readHandle.readFile();
    const finalMetadata = await readHandle.stat();
    if (buffer.length !== metadata.size
        || finalMetadata.dev !== metadata.dev
        || finalMetadata.ino !== metadata.ino
        || finalMetadata.size !== metadata.size
        || finalMetadata.mtimeMs !== metadata.mtimeMs
        || finalMetadata.ctimeMs !== metadata.ctimeMs) {
      throw fixedError("local_unified_index_secret_invalid");
    }
    recheckLocalUnifiedIndexDirectoryChain(secretFile, directoryChain);
    return buffer;
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_secret_unavailable");
  } finally {
    await readHandle?.close();
  }
}

function reusableLocalDigestKey(deviceSalt) {
  const bytes = Buffer.isBuffer(deviceSalt)
    ? deviceSalt
    : new Uint8Array(
      deviceSalt.buffer,
      deviceSalt.byteOffset,
      deviceSalt.byteLength,
    );
  // `localDigest` remains a general byte-buffer API. Only retain key material
  // inside the same bound enforced for an on-disk device secret; unusually
  // large caller-owned buffers keep the one-shot behavior.
  if (bytes.byteLength > MAX_SECRET_BYTES) return deviceSalt;
  let cached = LOCAL_DIGEST_KEYS.get(deviceSalt);
  if (cached === undefined || !cached.bytes.equals(bytes)) {
    cached = {
      // Keep a comparison copy so a caller that mutates a supplied view gets a
      // freshly keyed digest, exactly as it did before this cache existed.
      bytes: Buffer.from(bytes),
      key: createSecretKey(bytes),
    };
    LOCAL_DIGEST_KEYS.set(deviceSalt, cached);
  }
  return cached.key;
}

/**
 * The single local one-way derivation used by this index.
 *
 * Domain-separated exactly as the rest of the product does it: a
 * NUL-terminated `app-usagemonitor/<domain>/v1\0` label is committed before the
 * subject, so a session id can never collide with an account scope id.
 * Returns 32 raw bytes; the old shape stored 64 hex characters for the same
 * information.
 */
export function localDigest(deviceSalt, domain, subject) {
  if (!Buffer.isBuffer(deviceSalt) && !ArrayBuffer.isView(deviceSalt)) {
    throw new TypeError("deviceSalt must be a byte buffer");
  }
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(domain)) {
    throw new TypeError("domain must be a short lowercase label");
  }
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 4096) {
    throw new TypeError("subject must be a bounded string");
  }
  return createHmac("sha256", reusableLocalDigestKey(deviceSalt))
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest();
}

export function sessionLocal(deviceSalt, codexSessionId) {
  return localDigest(deviceSalt, "unified-index-session", codexSessionId);
}

export function scopeLocal(deviceSalt, accountScopeId) {
  return localDigest(deviceSalt, "unified-index-scope", accountScopeId);
}

export function sourceLocal(deviceSalt, rolloutKey) {
  return localDigest(deviceSalt, "unified-index-source", rolloutKey);
}

/**
 * A persisted fork-replay snapshot key. The raw key is a "|"-joined tuple of
 * cumulative token counters; membership is the only question the boundary
 * check ever asks, so what is stored is a salted digest of it.
 */
export function snapshotLocal(deviceSalt, snapshotKey) {
  return localDigest(deviceSalt, "unified-index-snapshot", snapshotKey);
}

function configureDatabase(database, { readOnly = false, staging = false } = {}) {
  if (!readOnly) {
    // WAL measured slower than DELETE+FULL on this store. During a rebuild the
    // target is a staging file that is discarded on failure and published by
    // atomic rename after an explicit fsync, so durability there is bought
    // once at the end rather than on every batch.
    // `journal_mode` returns a row, and setting it through `exec()` leaves the
    // mode unchanged — verified by reading it back. It has to be stepped as a
    // statement.
    //
    // The durable mode is DELETE: WAL measured slower than DELETE+FULL on this
    // store. A staging build asks for MEMORY instead, which keeps the rollback
    // journal bounded by one commit batch rather than writing it to disk.
    // (`OFF` is refused outright by the SQLite this runtime bundles — it
    // returns `delete` — so it is not requested.) Whatever mode SQLite grants
    // is recorded rather than assumed, because a staging build that silently
    // keeps a disk journal is only slower, never wrong.
    const journalMode = database
      .prepare(`PRAGMA journal_mode = ${staging ? "MEMORY" : "DELETE"}`)
      .get()?.journal_mode ?? "unknown";
    if (!staging && journalMode !== "delete") {
      throw fixedError("local_unified_index_journal_mode_refused");
    }
    database.exec(staging
      ? `
        PRAGMA synchronous=OFF;
        PRAGMA locking_mode=EXCLUSIVE;
      `
      : "PRAGMA synchronous=FULL;");
  }
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive?.(true);
}

function schemaSql({ deferSecondaryIndexes = false } = {}) {
  return deferSecondaryIndexes
    ? SCHEMA
    : `${SCHEMA}\n${SECONDARY_INDEX_SCHEMA}`;
}

function assertSecondaryIndexes(database) {
  const placeholders = SECONDARY_INDEX_NAMES.map(() => "?").join(", ");
  const present = new Set(database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'index' AND name IN (${placeholders})`,
  ).all(...SECONDARY_INDEX_NAMES).map((row) => row.name));
  const missing = SECONDARY_INDEX_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw fixedError("local_unified_index_secondary_indexes_missing");
  }
}

/**
 * Build the reader-only secondary indexes on a fully loaded staging database.
 * The transaction makes a partial index set invisible to any caller that
 * keeps the stage open, and the caller publishes only after this succeeds.
 */
export function createLocalUnifiedIndexSecondaryIndexes(database) {
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(SECONDARY_INDEX_SCHEMA);
    assertSecondaryIndexes(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the index-creation failure; the staging owner discards the
      // connection and file below.
    }
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_secondary_indexes_failed");
  }
}

function initializeSchema(database, { deferSecondaryIndexes = false } = {}) {
  database.exec(`
    PRAGMA application_id=${INDEX_APPLICATION_ID};
    PRAGMA user_version=${INDEX_USER_VERSION};
    ${schemaSql({ deferSecondaryIndexes })}
  `);
  database.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
    .run("schema_version", LOCAL_UNIFIED_INDEX_SCHEMA_VERSION);
  stampDatabaseCompatibility(database);
}

function tableColumns(database, tableName) {
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((row) => row.name));
}

function tableExists(database, tableName) {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) !== undefined;
}

function compatibilityInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Read the bounded compatibility header without changing the database.
 * Missing metadata is accepted only as a transitional state for v10 files
 * created before these explicit keys shipped; the next writable open stamps
 * all three keys atomically.
 */
export function readLocalUnifiedIndexCompatibility(database) {
  const applicationId = Number(
    database.prepare("PRAGMA application_id").get()?.application_id,
  );
  const userVersion = Number(
    database.prepare("PRAGMA user_version").get()?.user_version,
  );
  const values = new Map();
  try {
    if (tableExists(database, "meta")) {
      for (const row of database.prepare(`
        SELECT key, value FROM meta
        WHERE key IN (?, ?, ?)
      `).all(
        COMPATIBILITY_META_KEYS.formatUserVersion,
        COMPATIBILITY_META_KEYS.minimumReaderUserVersion,
        COMPATIBILITY_META_KEYS.minimumWriterUserVersion,
      )) {
        values.set(row.key, row.value);
      }
    }
  } catch {
    // A future schema may reshape metadata. PRAGMA application_id and
    // user_version remain sufficient to make the conservative typed refusal;
    // current-version validation below still rejects a malformed meta table.
  }
  const formatUserVersion = compatibilityInteger(
    values.get(COMPATIBILITY_META_KEYS.formatUserVersion),
  );
  const minimumReaderUserVersion = compatibilityInteger(
    values.get(COMPATIBILITY_META_KEYS.minimumReaderUserVersion),
  );
  const minimumWriterUserVersion = compatibilityInteger(
    values.get(COMPATIBILITY_META_KEYS.minimumWriterUserVersion),
  );
  const metadataPartial = values.size > 0 && values.size < 3;
  const metadataMalformed = values.size === 3
    && [formatUserVersion, minimumReaderUserVersion, minimumWriterUserVersion]
      .some((value) => value === null);
  return Object.freeze({
    applicationId,
    userVersion,
    formatUserVersion,
    minimumReaderUserVersion: minimumReaderUserVersion ?? userVersion,
    minimumWriterUserVersion: minimumWriterUserVersion ?? userVersion,
    metadataPresent: values.size === 3,
    metadataPartial,
    metadataMalformed,
  });
}

function stampDatabaseCompatibility(database) {
  const upsert = database.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  upsert.run(
    COMPATIBILITY_META_KEYS.formatUserVersion,
    String(INDEX_USER_VERSION),
  );
  upsert.run(
    COMPATIBILITY_META_KEYS.minimumReaderUserVersion,
    String(LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION),
  );
  upsert.run(
    COMPATIBILITY_META_KEYS.minimumWriterUserVersion,
    String(LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION),
  );
}

/**
 * Reject a database produced by a newer writer before a writable connection
 * changes journal/header state.  The application id gate prevents an
 * unrelated SQLite file with a high user_version being misdiagnosed as one of
 * our indexes.
 */
export function assertLocalUnifiedIndexNotNewer(
  database,
  { readOnly = false } = {},
) {
  const compatibility = readLocalUnifiedIndexCompatibility(database);
  if (compatibility.applicationId === INDEX_APPLICATION_ID
      && (compatibility.metadataPartial || compatibility.metadataMalformed)) {
    throw fixedError("local_unified_index_schema_invalid");
  }
  const accessRequirement = readOnly
    ? compatibility.minimumReaderUserVersion
    : compatibility.minimumWriterUserVersion;
  if (compatibility.applicationId === INDEX_APPLICATION_ID
      && (compatibility.userVersion > INDEX_USER_VERSION
        || compatibility.formatUserVersion > INDEX_USER_VERSION
        || accessRequirement > INDEX_USER_VERSION)) {
    throw schemaNewerError(compatibility, { readOnly });
  }
  return compatibility;
}

function currentCompatibilityIsSupported(compatibility) {
  return !compatibility.metadataPartial
    && (!compatibility.metadataPresent
      || (compatibility.formatUserVersion === INDEX_USER_VERSION
        && compatibility.minimumReaderUserVersion
          === LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION
        && compatibility.minimumWriterUserVersion
          === LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION));
}

/**
 * A writable SQLite connection can alter journal/header bytes before schema
 * validation. Existing files therefore have to prove that they are one of our
 * recognized current or migratable schemas through this read-only handle.
 */
function assertWritableLocalUnifiedIndexPreflight(database) {
  const compatibility = assertLocalUnifiedIndexNotNewer(database, {
    readOnly: false,
  });
  if (compatibility.applicationId !== INDEX_APPLICATION_ID) {
    throw fixedError("local_unified_index_schema_invalid");
  }
  let schemaVersion;
  try {
    schemaVersion = database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get()?.value ?? null;
  } catch {
    throw fixedError("local_unified_index_schema_invalid");
  }
  const legacy = MIGRATABLE_USER_VERSIONS.has(compatibility.userVersion)
    && compatibility.userVersion < INDEX_USER_VERSION
    // Pre-release v7-v9 databases already carried the v2 schema marker while
    // their physical tables were still widened transactionally by later user
    // versions. Both known markers are therefore legitimate migration roots.
    && [
      LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
      LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    ].includes(schemaVersion);
  const current = compatibility.userVersion === INDEX_USER_VERSION
    && schemaVersion === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
    && currentCompatibilityIsSupported(compatibility);
  if (!legacy && !current) {
    throw fixedError("local_unified_index_schema_invalid");
  }
  return compatibility;
}

export function assertLocalUnifiedIndexRecoveryUnlocked(indexFile) {
  try {
    const metadata = lstatSync(defaultLocalUnifiedIndexRecoveryLockPath(indexFile));
    if (!ownerOnlyRegularFile(metadata)) {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
    throw fixedError("local_unified_index_recovery_in_progress");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_lock_invalid");
  }
}

function addColumnIfMissing(database, tableName, columnName, definition) {
  if (tableColumns(database, tableName).has(columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function ensureGenerationAttestationColumns(database) {
  addColumnIfMissing(database, "index_generation", "skipped_source_count",
    "INTEGER");
  addColumnIfMissing(database, "index_generation", "skipped_source_bytes",
    "INTEGER");
  addColumnIfMissing(database, "index_generation", "skipped_thread_count",
    "INTEGER");
  addColumnIfMissing(database, "index_generation", "usage_provenance_complete",
    "INTEGER NOT NULL DEFAULT 0 CHECK(usage_provenance_complete IN (0, 1))");
  addColumnIfMissing(database, "index_generation", "source_order_complete",
    "INTEGER NOT NULL DEFAULT 0 CHECK(source_order_complete IN (0, 1))");
  addColumnIfMissing(database, "index_generation", "quota_provenance_complete",
    "INTEGER NOT NULL DEFAULT 0 CHECK(quota_provenance_complete IN (0, 1))");
  addColumnIfMissing(database, "index_generation", "tool_facts", "INTEGER");
  addColumnIfMissing(database, "index_generation", "tool_fact_fingerprint", "TEXT");
  addColumnIfMissing(database, "index_generation", "tool_provenance_complete",
    "INTEGER NOT NULL DEFAULT 0 CHECK(tool_provenance_complete IN (0, 1))");
}

function ensureDiagnosticCodes(database) {
  const sql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_diagnostic'",
  ).get()?.sql;
  if (typeof sql !== "string"
      || (sql.includes("toolRecordsSkipped")
        && sql.includes("toolSourceHistoryUnavailable")
        && sql.includes("malformedAccountingRecords")
        && sql.includes("malformedUsageRecords")
        && sql.includes("malformedRateLimitRecords"))) return;
  // SQLite cannot widen a CHECK constraint in place. Rebuild this small,
  // content-free count table inside the caller's migration transaction so a
  // v7 index either retains every diagnostic row under the v8 vocabulary or
  // remains wholly v7 after rollback.
  database.exec(`
    ALTER TABLE source_diagnostic RENAME TO source_diagnostic_v7;
    CREATE TABLE source_diagnostic(
      generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
      source_local BLOB NOT NULL CHECK(length(source_local) = 32),
      code TEXT NOT NULL CHECK(code IN (
        'relevantLines', 'malformedLines', 'malformedTimestamps',
        'malformedAccountingRecords', 'malformedUsageRecords',
        'malformedRateLimitRecords',
        'partialLines', 'salvagedRecords', 'turnContexts', 'tokenCounts',
        'forkReplayEventsSkipped', 'unattributedForkReplayEventsSkipped',
        'cumulativeCounterRegressions', 'tierEvents', 'modelSeededFromLineage',
        'tierSeededFromLineage', 'modelMissing', 'oversizedLines',
        'contradictedLeadingSnapshotsSkipped', 'toolRecords', 'toolEvents',
        'toolRecordsSkipped', 'toolSourceHistoryUnavailable')),
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(generation_id, source_local, code)) STRICT, WITHOUT ROWID;
    INSERT INTO source_diagnostic(generation_id, source_local, code, count)
      SELECT generation_id, source_local, code, count
      FROM source_diagnostic_v7;
    DROP TABLE source_diagnostic_v7;
  `);
}

function ensureGenerationIssueCodes(database) {
  const sql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_issue'",
  ).get()?.sql;
  if (typeof sql !== "string"
      || (sql.includes("codex_rollout_content_invalid")
        && sql.includes("codex_rollout_tail_incomplete"))) return;
  database.exec(`
    ALTER TABLE generation_issue RENAME TO generation_issue_v9;
    CREATE TABLE generation_issue(
      generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
      code TEXT NOT NULL CHECK(code IN (
        'codex_rollout_compression_unsupported',
        'codex_rollout_filename_identity_mismatch',
        'codex_rollout_generation_ambiguous',
        'codex_rollout_lineage_invalid',
        'codex_rollout_content_invalid',
        'codex_rollout_tail_incomplete')),
      thread_count INTEGER NOT NULL CHECK(thread_count >= 0),
      source_count INTEGER NOT NULL CHECK(source_count >= 0),
      source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
      PRIMARY KEY(generation_id, code)) STRICT, WITHOUT ROWID;
    INSERT INTO generation_issue(
      generation_id, code, thread_count, source_count, source_bytes)
      SELECT generation_id, code, thread_count, source_count, source_bytes
      FROM generation_issue_v9;
    DROP TABLE generation_issue_v9;

    ALTER TABLE generation_issue_group RENAME TO generation_issue_group_v9;
    CREATE TABLE generation_issue_group(
      generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
      group_local BLOB NOT NULL CHECK(length(group_local) = 32),
      code TEXT NOT NULL CHECK(code IN (
        'codex_rollout_compression_unsupported',
        'codex_rollout_filename_identity_mismatch',
        'codex_rollout_generation_ambiguous',
        'codex_rollout_lineage_invalid',
        'codex_rollout_content_invalid',
        'codex_rollout_tail_incomplete')),
      source_count INTEGER NOT NULL CHECK(source_count >= 0),
      source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
      PRIMARY KEY(generation_id, group_local, code)) STRICT, WITHOUT ROWID;
    INSERT INTO generation_issue_group(
      generation_id, group_local, code, source_count, source_bytes)
      SELECT generation_id, group_local, code, source_count, source_bytes
      FROM generation_issue_group_v9;
    DROP TABLE generation_issue_group_v9;
  `);
}

function validateDatabase(database, {
  readOnly = false,
  deferSecondaryIndexes = false,
} = {}) {
  const compatibility = assertLocalUnifiedIndexNotNewer(database, { readOnly });
  const { applicationId, userVersion } = compatibility;
  const schema = database.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).get();
  // Read-only connections may inspect a pre-v4 file, but it is explicitly a
  // legacy partial source. Writable opens must migrate it before use.
  const legacy = MIGRATABLE_USER_VERSIONS.has(userVersion)
    && userVersion < INDEX_USER_VERSION
    && schema?.value === LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION;
  const current = userVersion === INDEX_USER_VERSION
    && schema?.value === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION;
  const compatibilityCurrent = currentCompatibilityIsSupported(compatibility);
  const acceptable = readOnly ? (legacy || current) : current;
  if (applicationId !== INDEX_APPLICATION_ID || !acceptable
      || (current && !compatibilityCurrent)) {
    throw fixedError("local_unified_index_schema_invalid");
  }
  if (current && !deferSecondaryIndexes) assertSecondaryIndexes(database);
  return {
    ...compatibility,
    schemaVersion: schema?.value ?? null,
    legacy,
  };
}

function migrateDatabase(database, { deferSecondaryIndexes = false } = {}) {
  const { userVersion } = assertLocalUnifiedIndexNotNewer(database, {
    readOnly: false,
  });
  if (!MIGRATABLE_USER_VERSIONS.has(userVersion)) {
    throw fixedError("local_unified_index_schema_invalid");
  }
  // Every migration is additive and transactional: existing rows are left
  // untouched, while old rows receive NULL generation/provenance by
  // construction. A subsequent ingest sees the incomplete attestation and
  // performs the staged rebuild before those rows can become authoritative.
  database.exec("BEGIN IMMEDIATE");
  try {
    // Create every missing table first, then widen pre-existing tables before
    // creating indexes that refer to the new columns.
    database.exec(SCHEMA);
    addColumnIfMissing(database, "usage_event", "source_id",
      "INTEGER REFERENCES source_dimension");
    addColumnIfMissing(database, "usage_event", "generation_id",
      "INTEGER REFERENCES index_generation");
    addColumnIfMissing(database, "usage_event", "source_local",
      "BLOB CHECK(source_local IS NULL OR length(source_local) = 32)");
    addColumnIfMissing(database, "usage_event", "source_offset",
      "INTEGER CHECK(source_offset IS NULL OR source_offset >= 0)");
    addColumnIfMissing(database, "usage_event", "source_ordinal",
      "INTEGER CHECK(source_ordinal IS NULL OR source_ordinal >= 0)");
    addColumnIfMissing(database, "usage_event", "tier_observed_at_ms", "INTEGER");
    addColumnIfMissing(database, "source_cursor", "source_ordinal",
      "INTEGER CHECK(source_ordinal IS NULL OR source_ordinal >= 0)");
    addColumnIfMissing(database, "source_cursor", "source_dev", "INTEGER");
    addColumnIfMissing(database, "source_cursor", "source_ino", "INTEGER");
    addColumnIfMissing(database, "source_cursor", "source_birthtime_ms", "INTEGER");
    addColumnIfMissing(database, "source_cursor", "source_ctime_ms", "INTEGER");
    addColumnIfMissing(database, "source_cursor", "source_identity_token", "TEXT");
    addColumnIfMissing(database, "source_cursor", "source_state_token", "TEXT");
    addColumnIfMissing(database, "source_cursor", "quarantine_code",
      "TEXT CHECK(quarantine_code IS NULL OR quarantine_code IN "
        + "('codex_rollout_content_invalid', 'codex_rollout_tail_incomplete', "
        + "'codex_rollout_lineage_invalid'))");
    ensureDiagnosticCodes(database);
    ensureGenerationIssueCodes(database);
    if (!deferSecondaryIndexes) database.exec(SECONDARY_INDEX_SCHEMA);
    ensureGenerationAttestationColumns(database);
    database.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("schema_version", LOCAL_UNIFIED_INDEX_SCHEMA_VERSION);
    stampDatabaseCompatibility(database);
    database.exec(`PRAGMA user_version=${INDEX_USER_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export function openLocalUnifiedIndex(indexFile, {
  readOnly = false,
  create = false,
  staging = false,
  deferSecondaryIndexes = false,
  allowRecoveryLock = false,
} = {}) {
  const resolvedIndexFile = resolve(indexFile);
  let directoryChain = captureSafeLocalUnifiedIndexDirectoryChain(
    resolvedIndexFile,
  );
  if (deferSecondaryIndexes && (readOnly || !create || !staging)) {
    throw fixedError("local_unified_index_deferred_indexes_invalid");
  }
  if (deferSecondaryIndexes) {
    const existingStage = safeLocalUnifiedIndexTargetSync(resolvedIndexFile, {
      allowMissing: true,
    });
    if (existingStage !== null) {
      throw fixedError("local_unified_index_deferred_indexes_requires_new_stage");
    }
  }
  let database;
  let preflight;
  let existedBeforeOpen = false;
  let targetMetadata = null;
  try {
    if (!allowRecoveryLock) {
      assertLocalUnifiedIndexRecoveryUnlocked(resolvedIndexFile);
    }
    // Refuse symlinks, hard links, non-owner files and shared modes before any
    // SQLite handle is opened. Missing writable/create targets are atomically
    // reserved as owner-only regular files, closing the creation substitution
    // window within the cooperative same-user boundary.
    targetMetadata = safeLocalUnifiedIndexTargetSync(resolvedIndexFile, {
      allowMissing: true,
    });
    directoryChain = recheckLocalUnifiedIndexDirectoryChain(
      resolvedIndexFile,
      directoryChain,
    );
    existedBeforeOpen = targetMetadata !== null;
    if (deferSecondaryIndexes && existedBeforeOpen) {
      throw fixedError("local_unified_index_deferred_indexes_requires_new_stage");
    }
    // SQLite may rewrite journal/header state as soon as a writable connection
    // is configured. Inspect an existing file through a separate read-only
    // handle first so an older binary's refusal of N+1 state is byte-for-byte
    // non-mutating.
    if (!readOnly) {
      if (existedBeforeOpen) {
        directoryChain = recheckLocalUnifiedIndexDirectoryChain(
          resolvedIndexFile,
          directoryChain,
        );
        preflight = new DatabaseSync(resolvedIndexFile, {
          readOnly: true,
          timeout: 5_000,
        });
        const preflightMetadata = safeLocalUnifiedIndexTargetSync(
          resolvedIndexFile,
        );
        directoryChain = recheckLocalUnifiedIndexDirectoryChain(
          resolvedIndexFile,
          directoryChain,
        );
        if (!sameLocalUnifiedIndexTarget(targetMetadata, preflightMetadata)) {
          throw fixedError("local_unified_index_file_invalid");
        }
        assertWritableLocalUnifiedIndexPreflight(preflight);
        const validatedMetadata = safeLocalUnifiedIndexTargetSync(
          resolvedIndexFile,
        );
        directoryChain = recheckLocalUnifiedIndexDirectoryChain(
          resolvedIndexFile,
          directoryChain,
        );
        if (!sameLocalUnifiedIndexTarget(
          preflightMetadata,
          validatedMetadata,
        )) {
          throw fixedError("local_unified_index_file_invalid");
        }
        preflight.close();
        preflight = null;
        targetMetadata = validatedMetadata;
      } else if (!create) {
        throw fixedError("local_unified_index_unavailable");
      } else {
        const reservation = reserveNewLocalUnifiedIndexTarget(
          resolvedIndexFile,
          directoryChain,
        );
        targetMetadata = reservation.metadata;
        directoryChain = reservation.directoryChain;
      }
    } else if (!existedBeforeOpen) {
      throw fixedError("local_unified_index_unavailable");
    }
    directoryChain = recheckLocalUnifiedIndexDirectoryChain(
      resolvedIndexFile,
      directoryChain,
    );
    database = new DatabaseSync(resolvedIndexFile, { readOnly, timeout: 5_000 });
    const openedMetadata = safeLocalUnifiedIndexTargetSync(resolvedIndexFile);
    directoryChain = recheckLocalUnifiedIndexDirectoryChain(
      resolvedIndexFile,
      directoryChain,
    );
    if (!sameLocalUnifiedIndexTarget(targetMetadata, openedMetadata)) {
      throw fixedError("local_unified_index_file_invalid");
    }
    if (!allowRecoveryLock) {
      assertLocalUnifiedIndexRecoveryUnlocked(resolvedIndexFile);
    }
    configureDatabase(database, { readOnly, staging });
    if (create && !existedBeforeOpen) {
      initializeSchema(database, { deferSecondaryIndexes });
    }
    if (!readOnly) migrateDatabase(database, { deferSecondaryIndexes });
    validateDatabase(database, { readOnly, deferSecondaryIndexes });
    return database;
  } catch (error) {
    if (preflight?.isOpen) preflight.close();
    if (database?.isOpen) database.close();
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_unavailable");
  }
}

/**
 * Mark abandoned writer generations before starting a new publication. A
 * reader treats in_progress as partial, so this is recovery bookkeeping, not
 * an attempt to make an interrupted pass appear complete.
 */
export function recoverUnifiedIndexGenerations(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare(`
      UPDATE index_generation
      SET status = 'partial', block_reason = 'crash_recovered',
          completed_at_ms = COALESCE(completed_at_ms, ?)
      WHERE status = 'in_progress'`).run(Date.now());
    database.exec("COMMIT");
    return Number(result.changes ?? 0);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve original failure.
    }
    throw error;
  }
}

/** Begin a durable generation before any source facts are changed. */
export function beginUnifiedIndexGeneration(database, {
  parserVersion = LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  contractVersion,
  receivedAtMs = Date.now(),
  discoveredSourceCount = null,
  discoveredSourceBytes = null,
} = {}) {
  if (typeof contractVersion !== "string" || contractVersion.length < 1) {
    throw new TypeError("contractVersion must be a non-empty string");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO parser_version(parser_version, contract_version)
      VALUES (?, ?) ON CONFLICT DO NOTHING`).run(parserVersion, contractVersion);
    const parserVersionId = Number(database.prepare(`
      SELECT id FROM parser_version
      WHERE parser_version = ? AND contract_version = ?
    `).get(parserVersion, contractVersion).id);
    const ingestRunId = Number(database.prepare(`
      INSERT INTO ingest_run(received_at_ms, parser_version_id)
      VALUES (?, ?)
    `).run(receivedAtMs, parserVersionId).lastInsertRowid);
    const generationId = Number(database.prepare(`
      INSERT INTO index_generation(
        started_at_ms, parser_version_id, contract_version, status,
        discovered_source_count, discovered_source_bytes)
      VALUES (?, ?, ?, 'in_progress', ?, ?)
    `).run(
      receivedAtMs,
      parserVersionId,
      contractVersion,
      discoveredSourceCount,
      discoveredSourceBytes,
    ).lastInsertRowid);
    database.exec("COMMIT");
    return { generationId, parserVersionId, ingestRunId };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve original failure.
    }
    throw error;
  }
}

/** A bounded publication descriptor safe to hand to a downstream reader. */
export function readUnifiedIndexGenerationDescriptor(database, generationId = null) {
  const meta = Object.fromEntries(database.prepare(
    "SELECT key, value FROM meta",
  ).all().map((row) => [row.key, row.value]));
  const id = generationId === null
    ? Number(meta.current_generation_id)
    : Number(generationId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = database.prepare(`
    SELECT id, started_at_ms, completed_at_ms, parser_version_id,
           contract_version, status, block_reason,
           discovered_source_count, discovered_source_bytes,
           indexed_source_count, indexed_source_bytes,
           skipped_source_count, skipped_source_bytes, skipped_thread_count,
           usage_events,
           quota_occurrences, covered_start_ms, covered_end_ms,
           discovery_complete, diagnostics_complete,
           usage_provenance_complete, source_order_complete,
           quota_provenance_complete, tool_facts, tool_fact_fingerprint,
           tool_provenance_complete
    FROM index_generation WHERE id = ?
  `).get(id);
  if (row === undefined) return null;
  const parser = database.prepare(
    "SELECT parser_version FROM parser_version WHERE id = ?",
  ).get(row.parser_version_id)?.parser_version ?? null;
  const material = [
    row.id, row.started_at_ms, row.completed_at_ms, row.parser_version_id,
    row.contract_version, row.status, row.block_reason,
    row.discovered_source_count, row.discovered_source_bytes,
    row.indexed_source_count, row.indexed_source_bytes,
    row.skipped_source_count, row.skipped_source_bytes,
    row.skipped_thread_count, row.usage_events,
    row.quota_occurrences, row.covered_start_ms, row.covered_end_ms,
    row.discovery_complete, row.diagnostics_complete,
    row.usage_provenance_complete, row.source_order_complete,
    row.quota_provenance_complete, row.tool_facts, row.tool_fact_fingerprint,
    row.tool_provenance_complete,
  ].map((value) => value === null || value === undefined ? "" : String(value));
  const first = row.covered_start_ms === null ? null : Number(row.covered_start_ms);
  const last = row.covered_end_ms === null ? null : Number(row.covered_end_ms);
  const issueCounts = Object.fromEntries(database.prepare(`
    SELECT code, thread_count, source_count, source_bytes
    FROM generation_issue WHERE generation_id = ? ORDER BY code
  `).all(id).map((issue) => [issue.code, Object.freeze({
    threadCount: Number(issue.thread_count),
    sourceCount: Number(issue.source_count),
    sourceBytes: Number(issue.source_bytes),
  })]));
  return {
    id,
    fingerprint: `generation-v2-${createHash("sha256")
      .update(material.join("\u001f"), "utf8").digest("hex")}`,
    status: row.status,
    blockReason: row.block_reason ?? null,
    schemaVersion: meta.schema_version ?? null,
    parserVersion: parser,
    contractVersion: row.contract_version,
    startedAtMs: Number(row.started_at_ms),
    completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
    discoveredSourceCount: row.discovered_source_count === null
      ? null : Number(row.discovered_source_count),
    discoveredSourceBytes: row.discovered_source_bytes === null
      ? null : Number(row.discovered_source_bytes),
    indexedSourceCount: row.indexed_source_count === null
      ? null : Number(row.indexed_source_count),
    indexedSourceBytes: row.indexed_source_bytes === null
      ? null : Number(row.indexed_source_bytes),
    skippedSourceCount: row.skipped_source_count === null
      ? 0 : Number(row.skipped_source_count),
    skippedSourceBytes: row.skipped_source_bytes === null
      ? 0 : Number(row.skipped_source_bytes),
    skippedThreadCount: row.skipped_thread_count === null
      ? 0 : Number(row.skipped_thread_count),
    issueCounts: Object.freeze(issueCounts),
    usageEvents: row.usage_events === null ? null : Number(row.usage_events),
    quotaOccurrences: row.quota_occurrences === null
      ? null : Number(row.quota_occurrences),
    coveredStartMs: first,
    coveredEndMs: last,
    discoveryComplete: Number(row.discovery_complete) === 1,
    diagnosticsComplete: Number(row.diagnostics_complete) === 1,
    usageProvenanceComplete: Number(row.usage_provenance_complete) === 1,
    sourceOrderComplete: Number(row.source_order_complete) === 1,
    quotaProvenanceComplete: Number(row.quota_provenance_complete) === 1,
    toolFacts: row.tool_facts === null ? null : Number(row.tool_facts),
    toolFactFingerprint: row.tool_fact_fingerprint ?? null,
    toolProvenanceComplete: Number(row.tool_provenance_complete) === 1,
  };
}

/**
 * Return a deterministic digest over one generation's typed tool facts. The
 * digest is content-free: it commits only to local HMACs, offsets, ordinals,
 * timestamps and fixed classifications. Readers use it to detect a fact row
 * edited or appended after publication without retaining any raw tool data.
 */
export function createUnifiedIndexToolFactFingerprintAccumulator() {
  const hash = createHash("sha256");
  let settled = false;
  return {
    add(row) {
      if (settled) throw new TypeError("tool fact fingerprint is settled");
      hash.update([
        Buffer.from(row.event_key).toString("hex"),
        Buffer.from(row.source_local).toString("hex"),
        row.source_offset,
        row.source_ordinal,
        Buffer.from(row.session_local).toString("hex"),
        row.observed_at_ms,
        row.tool_ordinal,
        row.tool_class,
        row.source_kind,
      ].map((value) => String(value)).join("\u001f"), "utf8");
      hash.update("\n", "utf8");
    },
    digest() {
      if (settled) throw new TypeError("tool fact fingerprint is settled");
      settled = true;
      return `tool-facts-v1-${hash.digest("hex")}`;
    },
  };
}

export function readUnifiedIndexToolFactFingerprint(database, generationId) {
  if (!Number.isSafeInteger(Number(generationId)) || Number(generationId) < 1) {
    return null;
  }
  const present = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tool_class_fact'",
  ).get();
  if (present === undefined) return null;
  const fingerprint = createUnifiedIndexToolFactFingerprintAccumulator();
  for (const row of database.prepare(`
    SELECT event_key, source_local, source_offset, source_ordinal,
           session_local, observed_at_ms, tool_ordinal, tool_class, source_kind
    FROM tool_class_fact
    WHERE generation_id = ?
    ORDER BY event_key`).iterate(Number(generationId))) {
    fingerprint.add(row);
  }
  return fingerprint.digest();
}

async function syncFile(path) {
  const handle = await open(
    path,
    process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryPath(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error?.code === "local_unified_index_directory_sync_failed") {
      throw error;
    }
    throw fixedError("local_unified_index_directory_sync_failed");
  } finally {
    await handle?.close();
  }
}

/**
 * A bulk writer over one persistent connection.
 *
 * The measured reason this exists: the previous write path ran
 * `PRAGMA quick_check` on every 1,000-record batch. quick_check reads every
 * page, so its cost scales with database size — 636-663 ms of a 754 ms batch,
 * 84% of the write path, growing as the store grew. It now runs exactly once,
 * at `close()`, together with one `PRAGMA optimize` and one fsync. A
 * 642,609-record rebuild went from 308.6s to 95.0s on that change alone, and
 * to 36.3s with 10,000-row batches and this persistent connection.
 */
export function createUnifiedIndexWriter(database, {
  commitRows = DEFAULT_COMMIT_ROWS,
  receivedAtMs = Date.now(),
  parserVersion = LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  contractVersion,
  generationId = null,
  parserVersionId = null,
  ingestRunId: suppliedIngestRunId = null,
} = {}) {
  if (!Number.isSafeInteger(commitRows) || commitRows < 1) {
    throw new TypeError("commitRows must be a positive safe integer");
  }
  if (typeof contractVersion !== "string" || contractVersion.length < 1) {
    throw new TypeError("contractVersion must be a non-empty string");
  }

  const statements = {
    parserVersion: database.prepare(`
      INSERT INTO parser_version(parser_version, contract_version)
      VALUES (?, ?) ON CONFLICT DO NOTHING`),
    selectParserVersion: database.prepare(`
      SELECT id FROM parser_version
      WHERE parser_version = ? AND contract_version = ?`),
    ingestRun: database.prepare(`
      INSERT INTO ingest_run(received_at_ms, parser_version_id) VALUES (?, ?)`),
    model: database.prepare(`
      INSERT INTO model(model_id, recognition) VALUES (?, ?)
      ON CONFLICT(model_id) DO NOTHING`),
    selectModel: database.prepare("SELECT id FROM model WHERE model_id = ?"),
    tier: database.prepare(`
      INSERT INTO tier_semantics(api_service_tier, billing_surface,
        codex_speed_mode, tier_source, provider_tier_raw)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectTier: database.prepare(`
      SELECT id FROM tier_semantics
      WHERE api_service_tier = ? AND billing_surface = ?
        AND codex_speed_mode = ? AND tier_source = ?
        AND provider_tier_raw IS ?`),
    surface: database.prepare(`
      INSERT INTO surface_class(agent_scope, surface, thread_source,
        lineage_disposition)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectSurface: database.prepare(`
      SELECT id FROM surface_class
      WHERE agent_scope = ? AND surface = ? AND thread_source = ?
        AND lineage_disposition = ?`),
    accountScope: database.prepare(`
      INSERT INTO account_scope(status, reason, plan_type, scope_local)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectAccountScope: database.prepare(`
      SELECT id FROM account_scope
      WHERE status = ? AND reason IS ? AND plan_type IS ? AND scope_local IS ?`),
    sourceDimension: database.prepare(`
      INSERT INTO source_dimension(source_local)
      VALUES (?) ON CONFLICT(source_local) DO NOTHING`),
    selectSourceDimension: database.prepare(`
      SELECT id FROM source_dimension WHERE source_local = ?`),
    // Two rollout files genuinely report the same (observed_at_ms, limit_id,
    // slot) with different readings — a fork replays the parent's older
    // percentage stamped with the fork's own timestamp, alongside the live
    // one. `DO NOTHING` would resolve that by arrival order, which differs
    // between a single-threaded and a worker rebuild: measured at 180 of
    // 1,934,526 rows.
    //
    // The tie-break keeps one whole observed tuple rather than mixing fields
    // from two, and the ordering is total, so the outcome is the same under
    // any arrival order. Higher `used_percent` wins because a quota gauge that
    // reached a level did reach it; a later `resets_at_ms` breaks an exact
    // tie, since it names the newer allowance window.
    quota: database.prepare(`
      INSERT INTO quota_observation(observed_at_ms, limit_id, slot, plan_type,
        used_percent, resets_at_ms, duration_mins)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observed_at_ms, limit_id, slot) DO UPDATE SET
        plan_type = excluded.plan_type,
        used_percent = excluded.used_percent,
        resets_at_ms = excluded.resets_at_ms,
        duration_mins = excluded.duration_mins
      WHERE excluded.used_percent > quota_observation.used_percent
        OR (excluded.used_percent IS quota_observation.used_percent
            AND COALESCE(excluded.resets_at_ms, -1)
                > COALESCE(quota_observation.resets_at_ms, -1))`),
    selectQuota: database.prepare(`
      SELECT id FROM quota_observation
      WHERE observed_at_ms = ? AND limit_id = ? AND slot = ?`),
    quotaOccurrence: database.prepare(`
      INSERT INTO quota_occurrence(
        generation_id, source_local, source_offset, source_ordinal, surface_id,
        canonical_observation_id, observed_at_ms, provider, plan_type,
        limit_id, slot, slot_order, used_percent, resets_at_ms,
        duration_mins, admission)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_local, source_offset, slot_order) DO UPDATE SET
        generation_id = excluded.generation_id,
        source_ordinal = excluded.source_ordinal,
        surface_id = excluded.surface_id,
        canonical_observation_id = excluded.canonical_observation_id,
        observed_at_ms = excluded.observed_at_ms,
        provider = excluded.provider,
        plan_type = excluded.plan_type,
        limit_id = excluded.limit_id,
        slot = excluded.slot,
        used_percent = excluded.used_percent,
        resets_at_ms = excluded.resets_at_ms,
        duration_mins = excluded.duration_mins,
        admission = excluded.admission`),
    selectSettledQuota: database.prepare(`
      SELECT provider, plan_type AS planType, limit_id AS limitId,
             slot, used_percent AS usedPercent,
             resets_at_ms AS resetsAt, duration_mins AS windowDurationMins
      FROM quota_occurrence
      WHERE source_local = ? AND admission = 'admitted'
      GROUP BY provider, plan_type, limit_id, slot, used_percent,
               resets_at_ms, duration_mins`),
    usage: database.prepare(`
      INSERT INTO usage_event(
        event_key, observed_at_ms, generation_id, ingest_run_id,
        parser_version_id, source_id, source_offset,
        session_local, account_scope_id, model_id, tier_id, surface_id,
        quota_observation_id, source_local, source_ordinal,
        tier_observed_at_ms, reasoning_effort, outcome,
        tokens_in_uncached, tokens_in_cache_read, tokens_in_cache_write,
        tokens_in_cache_write_5m, tokens_in_cache_write_1h,
        tokens_out_text, tokens_out_reasoning, tokens_out_combined,
        total_input_context)
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING`),
    boundary: database.prepare(`
      INSERT INTO usage_event_boundary(
        current_event_key, compaction_before, turn_context_before,
        compacted_at_ms, ingest_run_id, parser_version_id, session_local)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(current_event_key) DO NOTHING`),
    toolClass: database.prepare(`
      INSERT INTO tool_class_count(session_local, tool_class, count)
      VALUES (?, ?, ?)
      ON CONFLICT(session_local, tool_class)
      DO UPDATE SET count = count + excluded.count`),
    toolFact: database.prepare(`
      INSERT INTO tool_class_fact(
        event_key, generation_id, source_local, source_offset, source_ordinal,
        session_local, observed_at_ms, tool_ordinal, tool_class, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING`),
    deleteToolFactsForSource: database.prepare(
      "DELETE FROM tool_class_fact WHERE source_local = ?",
    ),
    affectedQuotaForSource: database.prepare(`
      SELECT DISTINCT canonical_observation_id AS id
      FROM quota_occurrence WHERE source_local = ?`),
    deleteUsageForSource: database.prepare(
      "DELETE FROM usage_event WHERE source_local = ?",
    ),
    deleteQuotaForSource: database.prepare(
      "DELETE FROM quota_occurrence WHERE source_local = ?",
    ),
    replacementQuota: database.prepare(`
      SELECT plan_type, used_percent, resets_at_ms, duration_mins
      FROM quota_occurrence WHERE canonical_observation_id = ?
      ORDER BY used_percent DESC, COALESCE(resets_at_ms, -1) DESC, id ASC
      LIMIT 1`),
    updateCanonicalQuota: database.prepare(`
      UPDATE quota_observation SET plan_type = ?, used_percent = ?,
        resets_at_ms = ?, duration_mins = ? WHERE id = ?`),
    deleteOrphanQuota: database.prepare(`
      DELETE FROM quota_observation WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM quota_occurrence WHERE canonical_observation_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM usage_event WHERE quota_observation_id = ?)`),
    deleteSourceCursor: database.prepare(
      "DELETE FROM source_cursor WHERE source_local = ?",
    ),
    rebindToolFactsForSource: database.prepare(`
      UPDATE tool_class_fact SET generation_id = ? WHERE source_local = ?`),
    clearToolClasses: database.prepare("DELETE FROM tool_class_count"),
    rebuildToolClasses: database.prepare(`
      INSERT INTO tool_class_count(session_local, tool_class, count)
      SELECT session_local, tool_class, COUNT(*)
      FROM tool_class_fact
      GROUP BY session_local, tool_class`),
    sourceCursor: database.prepare(`
      INSERT INTO source_cursor(
        source_local, source_ordinal, session_local, scanned_bytes, size_bytes, mtime_ms,
        source_dev, source_ino, source_birthtime_ms, source_ctime_ms,
        source_identity_token, source_state_token,
        quarantine_code,
        snapshots_persisted, turn_context_seen, carry_model, carry_effort,
        carry_tier_raw, carry_tier_observed_at_ms, carry_total_input,
        carry_total_cached, carry_total_cache_write, carry_total_output,
        carry_total_reasoning, carry_total_total, ingest_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_local) DO UPDATE SET
        source_ordinal = excluded.source_ordinal,
        session_local = excluded.session_local,
        scanned_bytes = excluded.scanned_bytes,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        source_dev = excluded.source_dev,
        source_ino = excluded.source_ino,
        source_birthtime_ms = excluded.source_birthtime_ms,
        source_ctime_ms = excluded.source_ctime_ms,
        source_identity_token = excluded.source_identity_token,
        source_state_token = excluded.source_state_token,
        quarantine_code = excluded.quarantine_code,
        snapshots_persisted = excluded.snapshots_persisted,
        turn_context_seen = excluded.turn_context_seen,
        carry_model = excluded.carry_model,
        carry_effort = excluded.carry_effort,
        carry_tier_raw = excluded.carry_tier_raw,
        carry_tier_observed_at_ms = excluded.carry_tier_observed_at_ms,
        carry_total_input = excluded.carry_total_input,
        carry_total_cached = excluded.carry_total_cached,
        carry_total_cache_write = excluded.carry_total_cache_write,
        carry_total_output = excluded.carry_total_output,
        carry_total_reasoning = excluded.carry_total_reasoning,
        carry_total_total = excluded.carry_total_total,
        ingest_run_id = excluded.ingest_run_id`),
    sourceBoundary: database.prepare(`
      INSERT INTO source_boundary_state(
        source_local, compacted_at_ms, source_offset, turn_context_pending,
        ingest_run_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_local) DO UPDATE SET
        compacted_at_ms = excluded.compacted_at_ms,
        source_offset = excluded.source_offset,
        turn_context_pending = excluded.turn_context_pending,
        ingest_run_id = excluded.ingest_run_id`),
    deleteSourceBoundary: database.prepare(`
      DELETE FROM source_boundary_state WHERE source_local = ?`),
    lineageSnapshot: database.prepare(`
      INSERT INTO lineage_snapshot(session_local, snapshot_local)
      VALUES (?, ?) ON CONFLICT DO NOTHING`),
    deleteLineageSnapshots: database.prepare(`
      DELETE FROM lineage_snapshot WHERE session_local = ?`),
    sessionIdentity: database.prepare(`
      INSERT INTO session_identity(session_local, session_uuid)
      VALUES (?, ?) ON CONFLICT DO NOTHING`),
    generationSource: database.prepare(`
      INSERT INTO generation_source(
        generation_id, source_local, source_ordinal, session_local, surface_id,
        status, discovered_size_bytes, scanned_bytes, mtime_ms,
        diagnostics_complete)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, source_local) DO UPDATE SET
        source_ordinal = excluded.source_ordinal,
        session_local = excluded.session_local,
        surface_id = excluded.surface_id,
        status = excluded.status,
        discovered_size_bytes = excluded.discovered_size_bytes,
        scanned_bytes = excluded.scanned_bytes,
        mtime_ms = excluded.mtime_ms,
        diagnostics_complete = excluded.diagnostics_complete`),
    sourceDiagnostic: database.prepare(`
      INSERT INTO source_diagnostic(generation_id, source_local, code, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(generation_id, source_local, code)
      DO UPDATE SET count = excluded.count`),
    generationIssue: database.prepare(`
      INSERT INTO generation_issue(
        generation_id, code, thread_count, source_count, source_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, code) DO UPDATE SET
        thread_count = excluded.thread_count,
        source_count = excluded.source_count,
        source_bytes = excluded.source_bytes`),
    generationIssueGroup: database.prepare(`
      INSERT INTO generation_issue_group(
        generation_id, group_local, code, source_count, source_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, group_local, code) DO UPDATE SET
        source_count = excluded.source_count,
        source_bytes = excluded.source_bytes`),
    copySourceDiagnostics: database.prepare(`
      INSERT INTO source_diagnostic(generation_id, source_local, code, count)
      SELECT ?, source_local, code, count
      FROM source_diagnostic
      WHERE generation_id = ? AND source_local = ?
      ON CONFLICT(generation_id, source_local, code)
      DO UPDATE SET count = excluded.count`),
    selectGenerationSource: database.prepare(`
      SELECT diagnostics_complete, scanned_bytes, status
      FROM generation_source
      WHERE generation_id = ? AND source_local = ?`),
    generation: database.prepare(`
      UPDATE index_generation SET
        completed_at_ms = ?, status = ?, block_reason = ?,
        indexed_source_count = ?, indexed_source_bytes = ?,
        skipped_source_count = ?, skipped_source_bytes = ?,
        skipped_thread_count = ?,
        usage_events = ?, quota_occurrences = ?,
        covered_start_ms = ?, covered_end_ms = ?,
        discovery_complete = ?, diagnostics_complete = ?,
        usage_provenance_complete = ?, source_order_complete = ?,
        quota_provenance_complete = ?, tool_facts = ?,
        tool_fact_fingerprint = ?, tool_provenance_complete = ?
      WHERE id = ?`),
    meta: database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  // Interning caches. Every dimension in this schema has at most a few
  // thousand distinct rows across the whole corpus (`surfaceClassification`
  // had six distinct values across 662,454 records, `accountScope` one), so
  // these are bounded by the data's own cardinality, not by row count.
  const parserVersionIds = new Map();
  const modelIds = new Map();
  const tierIds = new Map();
  const surfaceIds = new Map();
  const accountScopeIds = new Map();
  const sourceIds = new Map();
  const quotaIds = new Map();

  let open = false;
  let pending = 0;
  let usageRows = 0;
  let boundaryRows = 0;
  let toolRows = 0;
  let quotaOccurrenceRows = 0;
  let batches = 0;

  function begin() {
    if (open) return;
    database.exec("BEGIN IMMEDIATE");
    open = true;
  }

  function commit() {
    if (!open) return;
    database.exec("COMMIT");
    open = false;
    pending = 0;
    batches += 1;
  }

  function step() {
    pending += 1;
    if (pending >= commitRows) commit();
  }

  function internParserVersion(version) {
    const cached = parserVersionIds.get(version);
    if (cached !== undefined) return cached;
    begin();
    statements.parserVersion.run(version, contractVersion);
    const id = Number(statements.selectParserVersion.get(version, contractVersion).id);
    parserVersionIds.set(version, id);
    return id;
  }

  const defaultParserVersionId = parserVersionId === null
    ? (() => {
      begin();
      return internParserVersion(parserVersion);
    })()
    : Number(parserVersionId);
  const ingestRunId = suppliedIngestRunId === null
    ? (() => {
      begin();
      return Number(
        statements.ingestRun.run(receivedAtMs, defaultParserVersionId).lastInsertRowid,
      );
    })()
    : Number(suppliedIngestRunId);

  function internModel(modelId, recognition) {
    const cached = modelIds.get(modelId);
    if (cached !== undefined) return cached;
    begin();
    statements.model.run(modelId, recognition);
    const id = Number(statements.selectModel.get(modelId).id);
    modelIds.set(modelId, id);
    return id;
  }

  function internTier(tier) {
    const key = `${tier.apiServiceTier}\0${tier.billingSurface}\0${tier.codexSpeedMode}\0${tier.tierSource}\0${tier.providerTierRaw ?? ""}\0${tier.providerTierRaw === null ? "n" : "s"}`;
    const cached = tierIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.tier.run(
      tier.apiServiceTier,
      tier.billingSurface,
      tier.codexSpeedMode,
      tier.tierSource,
      tier.providerTierRaw,
    );
    const id = Number(statements.selectTier.get(
      tier.apiServiceTier,
      tier.billingSurface,
      tier.codexSpeedMode,
      tier.tierSource,
      tier.providerTierRaw,
    ).id);
    tierIds.set(key, id);
    return id;
  }

  function internSurface(surface) {
    const key = `${surface.agentScope}\0${surface.surface}\0${surface.threadSource}\0${surface.lineageDisposition}`;
    const cached = surfaceIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.surface.run(
      surface.agentScope,
      surface.surface,
      surface.threadSource,
      surface.lineageDisposition,
    );
    const id = Number(statements.selectSurface.get(
      surface.agentScope,
      surface.surface,
      surface.threadSource,
      surface.lineageDisposition,
    ).id);
    surfaceIds.set(key, id);
    return id;
  }

  function internAccountScope(scope) {
    const scopeBlob = scope.scopeLocal ?? null;
    const key = `${scope.status}\0${scope.reason ?? ""}\0${scope.reason === null ? "n" : "s"}\0${scope.planType ?? ""}\0${scope.planType === null ? "n" : "s"}\0${scopeBlob === null ? "" : Buffer.from(scopeBlob).toString("base64")}`;
    const cached = accountScopeIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.accountScope.run(
      scope.status,
      scope.reason ?? null,
      scope.planType ?? null,
      scopeBlob,
    );
    const id = Number(statements.selectAccountScope.get(
      scope.status,
      scope.reason ?? null,
      scope.planType ?? null,
      scopeBlob,
    ).id);
    accountScopeIds.set(key, id);
    return id;
  }

  function internSource(sourceLocalKey) {
    const sourceBlob = Buffer.from(sourceLocalKey);
    const key = sourceBlob.toString("base64");
    const cached = sourceIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.sourceDimension.run(sourceBlob);
    const id = Number(statements.selectSourceDimension.get(sourceBlob).id);
    sourceIds.set(key, id);
    return id;
  }

  function internQuota(observation) {
    // The cache key is the whole observation, not just its uniqueness key.
    // Caching on the uniqueness key alone would let the first arrival suppress
    // a genuinely different reading for the same millisecond, reintroducing the
    // arrival-order dependence the upsert above exists to remove.
    const key = `${observation.observedAtMs}\0${observation.limitId}\0${observation.slot}`
      + `\0${observation.planType ?? ""}\0${observation.usedPercent ?? ""}`
      + `\0${observation.resetsAtMs ?? ""}\0${observation.durationMins ?? ""}`;
    const cached = quotaIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.quota.run(
      observation.observedAtMs,
      observation.limitId,
      observation.slot,
      observation.planType ?? null,
      observation.usedPercent ?? null,
      observation.resetsAtMs ?? null,
      observation.durationMins ?? null,
    );
    const id = Number(statements.selectQuota.get(
      observation.observedAtMs,
      observation.limitId,
      observation.slot,
    ).id);
    quotaIds.set(key, id);
    // The cache would otherwise grow with the quota series. Quota is observed
    // every few minutes, so this stays small over any real history, but keep
    // an explicit ceiling rather than an implicit one.
    if (quotaIds.size > 200_000) quotaIds.clear();
    return id;
  }

  return {
    get usageRows() { return usageRows; },
    get boundaryRows() { return boundaryRows; },
    get toolRows() { return toolRows; },
    get quotaOccurrenceRows() { return quotaOccurrenceRows; },
    get batches() { return batches; },
    ingestRunId,
    generationId,

    internModel,
    internTier,
    internSurface,
    internAccountScope,
    internSource,
    internQuota,
    internParserVersion,

    loadSettledQuotaWindows(sourceLocalKey) {
      begin();
      return statements.selectSettledQuota.all(sourceLocalKey).map((row) => ({
        provider: row.provider,
        planType: row.planType,
        limitId: row.limitId,
        slot: row.slot,
        usedPercent: Number(row.usedPercent),
        resetsAt: row.resetsAt === null ? null : Number(row.resetsAt),
        windowDurationMins: Number(row.windowDurationMins),
      }));
    },

    writeQuotaOccurrence(occurrence) {
      begin();
      const result = statements.quotaOccurrence.run(
        occurrence.generationId ?? generationId,
        occurrence.sourceLocal,
        occurrence.sourceOffset,
        occurrence.sourceOrdinal,
        occurrence.surfaceId,
        occurrence.canonicalObservationId,
        occurrence.observedAtMs,
        occurrence.provider,
        occurrence.planType ?? null,
        occurrence.limitId,
        occurrence.slot,
        occurrence.slotOrder,
        occurrence.usedPercent,
        occurrence.resetsAtMs ?? null,
        occurrence.durationMins,
        occurrence.admission,
      );
      quotaOccurrenceRows += Number(result.changes ?? 0);
      step();
      return Number(result.changes ?? 0);
    },

    writeUsageEvent(event) {
      begin();
      const changes = statements.usage.run(
        event.eventKey,
        event.observedAtMs,
        event.generationId ?? generationId,
        ingestRunId,
        event.partial
          ? internParserVersion(LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION)
          : defaultParserVersionId,
        event.sourceId ?? null,
        event.sourceOffset ?? null,
        event.sessionLocal,
        event.accountScopeId,
        event.modelId,
        event.tierId,
        event.surfaceId,
        event.quotaObservationId ?? null,
        event.sourceLocal ?? null,
        event.sourceOrdinal ?? null,
        event.tierObservedAtMs ?? null,
        event.reasoningEffort,
        event.outcome,
        event.tokensInUncached ?? null,
        event.tokensInCacheRead ?? null,
        event.tokensInCacheWrite ?? null,
        event.tokensInCacheWrite5m ?? null,
        event.tokensInCacheWrite1h ?? null,
        event.tokensOutText ?? null,
        event.tokensOutReasoning ?? null,
        event.tokensOutCombined ?? null,
        event.totalInputContext ?? null,
      );
      const inserted = Number(changes.changes ?? 0);
      usageRows += inserted;
      step();
      return inserted;
    },

    writeUsageEventBoundary(event) {
      begin();
      const changes = statements.boundary.run(
        event.currentEventKey,
        event.compactionBefore ? 1 : 0,
        event.turnContextBefore ? 1 : 0,
        event.compactedAtMs ?? null,
        ingestRunId,
        defaultParserVersionId,
        event.sessionLocal,
      );
      const inserted = Number(changes.changes ?? 0);
      boundaryRows += inserted;
      step();
      return inserted;
    },

    addToolClassCount(sessionLocalKey, toolClass, count) {
      if (count <= 0) return;
      begin();
      statements.toolClass.run(sessionLocalKey, toolClass, count);
      toolRows += 1;
      step();
    },

    writeToolClassFact(fact) {
      if (generationId === null && fact.generationId === undefined) {
        throw fixedError("local_unified_index_generation_required");
      }
      begin();
      const result = statements.toolFact.run(
        fact.eventKey,
        fact.generationId ?? generationId,
        fact.sourceLocal,
        fact.sourceOffset,
        fact.sourceOrdinal,
        fact.sessionLocal,
        fact.observedAtMs,
        fact.toolOrdinal,
        fact.toolClass,
        fact.sourceKind,
      );
      const inserted = Number(result.changes ?? 0);
      if (inserted > 0) {
        // Keep the pre-cutover aggregate populated for rollback/compatibility
        // consumers, but only after the source-scoped fact's UNIQUE key says
        // this observation is new. A crash/re-scan therefore cannot inflate
        // the compatibility count.
        statements.toolClass.run(fact.sessionLocal, fact.toolClass, 1);
        toolRows += 1;
      }
      step();
      return inserted;
    },

    deleteToolFactsForSource(sourceLocalKey) {
      begin();
      const result = statements.deleteToolFactsForSource.run(sourceLocalKey);
      step();
      return Number(result.changes ?? 0);
    },

    deleteSourceFacts(sourceLocalKey, sessionLocalKey = null) {
      begin();
      const affectedQuotaIds = statements.affectedQuotaForSource
        .all(sourceLocalKey).map((row) => Number(row.id));
      const usageEvents = Number(
        statements.deleteUsageForSource.run(sourceLocalKey).changes ?? 0,
      );
      const quotaOccurrences = Number(
        statements.deleteQuotaForSource.run(sourceLocalKey).changes ?? 0,
      );
      const toolFacts = Number(
        statements.deleteToolFactsForSource.run(sourceLocalKey).changes ?? 0,
      );
      statements.deleteSourceCursor.run(sourceLocalKey);
      if (sessionLocalKey !== null) {
        statements.deleteLineageSnapshots.run(sessionLocalKey);
      }
      for (const quotaId of affectedQuotaIds) {
        const replacement = statements.replacementQuota.get(quotaId);
        if (replacement === undefined) {
          statements.deleteOrphanQuota.run(quotaId, quotaId, quotaId);
        } else {
          statements.updateCanonicalQuota.run(
            replacement.plan_type,
            replacement.used_percent,
            replacement.resets_at_ms,
            replacement.duration_mins,
            quotaId,
          );
        }
      }
      step();
      return { usageEvents, quotaOccurrences, toolFacts };
    },

    rebindToolFactsForSource(sourceLocalKey, targetGenerationId = generationId) {
      if (targetGenerationId === null || targetGenerationId === undefined) {
        throw fixedError("local_unified_index_generation_required");
      }
      begin();
      const result = statements.rebindToolFactsForSource.run(
        targetGenerationId,
        sourceLocalKey,
      );
      step();
      return Number(result.changes ?? 0);
    },

    writeSourceCursor(cursor) {
      begin();
      statements.sourceCursor.run(
        cursor.sourceLocal,
        cursor.sourceOrdinal ?? null,
        cursor.sessionLocal ?? null,
        cursor.scannedBytes,
        cursor.sizeBytes,
        cursor.mtimeMs,
        cursor.sourceDev ?? null,
        cursor.sourceIno ?? null,
        cursor.sourceBirthtimeMs ?? null,
        cursor.sourceCtimeMs ?? null,
        cursor.sourceIdentityToken ?? null,
        cursor.sourceStateToken ?? null,
        cursor.quarantineCode ?? null,
        cursor.snapshotsPersisted ? 1 : 0,
        cursor.turnContextSeen ? 1 : 0,
        cursor.carryModel ?? null,
        cursor.carryEffort ?? null,
        cursor.carryTierRaw ?? null,
        cursor.carryTierObservedAtMs ?? null,
        cursor.carryTotals?.input_tokens ?? null,
        cursor.carryTotals?.cached_input_tokens ?? null,
        cursor.carryTotals?.cache_write_input_tokens ?? null,
        cursor.carryTotals?.output_tokens ?? null,
        cursor.carryTotals?.reasoning_output_tokens ?? null,
        cursor.carryTotals?.total_tokens ?? null,
        ingestRunId,
      );
      if ((cursor.compactionPending === null
            || cursor.compactionPending === undefined)
          && cursor.turnContextPending !== true) {
        statements.deleteSourceBoundary.run(cursor.sourceLocal);
      } else {
        statements.sourceBoundary.run(
          cursor.sourceLocal,
          cursor.compactionPending?.observedAtMs ?? null,
          cursor.compactionPending?.sourceOffset ?? null,
          cursor.turnContextPending ? 1 : 0,
          ingestRunId,
        );
      }
      step();
    },

    writeGenerationSource(source) {
      if (generationId === null && source.generationId === undefined) {
        throw fixedError("local_unified_index_generation_required");
      }
      begin();
      statements.generationSource.run(
        source.generationId ?? generationId,
        source.sourceLocal,
        source.sourceOrdinal,
        source.sessionLocal ?? null,
        source.surfaceId,
        source.status,
        source.discoveredSizeBytes,
        source.scannedBytes,
        source.mtimeMs,
        source.diagnosticsComplete ? 1 : 0,
      );
      step();
    },

    writeGenerationIssue(code, {
      threadCount = 0,
      sourceCount = 0,
      sourceBytes = 0,
    } = {}) {
      if (generationId === null || !GENERATION_ISSUE_CODES.has(code)) {
        throw fixedError("local_unified_index_generation_invalid");
      }
      for (const value of [threadCount, sourceCount, sourceBytes]) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw fixedError("local_unified_index_generation_invalid");
        }
      }
      begin();
      statements.generationIssue.run(
        generationId,
        code,
        threadCount,
        sourceCount,
        sourceBytes,
      );
      step();
    },

    writeGenerationIssueGroup(groupLocal, code, {
      sourceCount = 0,
      sourceBytes = 0,
    } = {}) {
      if (generationId === null || !GENERATION_ISSUE_CODES.has(code)
          || !Buffer.isBuffer(groupLocal) || groupLocal.length !== 32
          || !Number.isSafeInteger(sourceCount) || sourceCount < 0
          || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
        throw fixedError("local_unified_index_generation_invalid");
      }
      begin();
      statements.generationIssueGroup.run(
        generationId,
        groupLocal,
        code,
        sourceCount,
        sourceBytes,
      );
      step();
    },

    writeSourceDiagnostics(sourceLocalKey, diagnostics, {
      generationId: sourceGenerationId = generationId,
    } = {}) {
      if (sourceGenerationId === null) {
        throw fixedError("local_unified_index_generation_required");
      }
      begin();
      for (const [code, value] of Object.entries(diagnostics ?? {})) {
        if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) continue;
        if (!DIAGNOSTIC_CODES.has(code)) continue;
        statements.sourceDiagnostic.run(
          sourceGenerationId,
          sourceLocalKey,
          code,
          Number(value),
        );
      }
      step();
    },

    copySourceDiagnostics(sourceLocalKey, fromGenerationId, {
      toGenerationId = generationId,
    } = {}) {
      if (toGenerationId === null || fromGenerationId === null) return false;
      begin();
      const result = statements.copySourceDiagnostics.run(
        toGenerationId,
        fromGenerationId,
        sourceLocalKey,
      );
      step();
      return Number(result.changes ?? 0) > 0;
    },

    previousGenerationSource(sourceLocalKey, previousGenerationId) {
      if (previousGenerationId === null || previousGenerationId === undefined) {
        return null;
      }
      const row = statements.selectGenerationSource.get(
        previousGenerationId,
        sourceLocalKey,
      );
      return row === undefined ? null : {
        diagnosticsComplete: Number(row.diagnostics_complete) === 1,
        scannedBytes: Number(row.scanned_bytes),
        status: row.status,
      };
    },

    addLineageSnapshot(sessionLocalKey, snapshotLocalKey) {
      begin();
      statements.lineageSnapshot.run(sessionLocalKey, snapshotLocalKey);
      step();
    },

    clearLineageSnapshots(sessionLocalKey) {
      begin();
      statements.deleteLineageSnapshots.run(sessionLocalKey);
      step();
    },

    /**
     * Record the raw provider-issued session UUID beside its local join key.
     * Only a strictly UUID-shaped identifier is accepted: the ingest paths
     * fall back to the rollout key when a source declares no session id, and
     * that fallback is filename-shaped, which must never be stored — this
     * store is the transport source for `sessionUuid` under
     * telemetry-contribution-v1.0. Returns whether a row was recorded.
     */
    recordSessionIdentity(sessionLocalKey, sessionUuid) {
      if (typeof sessionUuid !== "string"
          || !RAW_SESSION_UUID.test(sessionUuid)) {
        return false;
      }
      begin();
      statements.sessionIdentity.run(sessionLocalKey, sessionUuid);
      step();
      return true;
    },

    writeMeta(key, value) {
      begin();
      statements.meta.run(key, String(value));
      step();
    },

    finalizeGeneration({
      status = "complete",
      blockReason = null,
      discoveredSourceCount = null,
      discoveredSourceBytes = null,
      indexedSourceCount = null,
      indexedSourceBytes = null,
      skippedSourceCount = 0,
      skippedSourceBytes = 0,
      skippedThreadCount = 0,
      coveredStartMs = null,
      coveredEndMs = null,
      discoveryComplete = status === "complete",
      diagnosticsComplete = status === "complete",
      completedAtMs = Date.now(),
    } = {}) {
      if (generationId === null) return;
      if (!["complete", "partial", "failed"].includes(status)) {
        throw new TypeError("invalid generation status");
      }
      begin();
      // `tool_class_count` remains a rollback/transport compatibility table.
      // Re-derive it from the source-scoped facts before every publication so
      // rescanning one source cannot erase or double-count a same-session
      // sibling's aggregate.
      statements.clearToolClasses.run();
      statements.rebuildToolClasses.run();
      // A generation publishes the complete clone, not only rows inserted by
      // this pass. Include retained and legacy rows in the durable totals and
      // covered interval.
      const counts = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM usage_event) AS usage_events,
          (SELECT COUNT(*) FROM quota_occurrence) AS quota_occurrences,
          (SELECT MIN(observed_at_ms) FROM usage_event) AS usage_first_ms,
          (SELECT MAX(observed_at_ms) FROM usage_event) AS usage_last_ms,
          (SELECT MIN(observed_at_ms) FROM quota_occurrence) AS quota_first_ms,
          (SELECT MAX(observed_at_ms) FROM quota_occurrence) AS quota_last_ms
      `).get();
      const starts = [counts?.usage_first_ms, counts?.quota_first_ms]
        .filter((value) => value !== null && value !== undefined)
        .map(Number);
      const ends = [counts?.usage_last_ms, counts?.quota_last_ms]
        .filter((value) => value !== null && value !== undefined)
        .map(Number);
      const sourceCompleteness = database.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN diagnostics_complete <> 1
                          OR status = 'pending'
                        THEN 1 ELSE 0 END) AS incomplete
        FROM generation_source
        WHERE generation_id = ?
      `).get(generationId);
      const actualDiagnosticsComplete = diagnosticsComplete
        && Number(sourceCompleteness?.incomplete ?? 0) === 0;
      const usageProvenanceComplete = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM usage_event
        WHERE source_local IS NULL OR source_offset IS NULL
          OR source_ordinal IS NULL
      `).get()?.count ?? 0) === 0;
      const sourceOrderMissing = Number(database.prepare(`
        SELECT (
          (SELECT COUNT(*) FROM generation_source
           WHERE generation_id = ? AND source_ordinal IS NULL)
          +
          (SELECT COUNT(*) FROM (
             SELECT source_ordinal FROM generation_source
             WHERE generation_id = ?
             GROUP BY source_ordinal HAVING COUNT(*) > 1
           ))
          +
          (SELECT COUNT(*) FROM usage_event
           WHERE source_local IS NOT NULL AND source_ordinal IS NULL)
          +
          (SELECT COUNT(*) FROM quota_occurrence
           WHERE source_local IS NOT NULL AND source_ordinal IS NULL)
          +
          (SELECT COUNT(*) FROM source_cursor sc
           WHERE NOT EXISTS (
             SELECT 1 FROM generation_source gs
             WHERE gs.generation_id = ?
               AND gs.source_local = sc.source_local))
          +
          (SELECT COUNT(*) FROM usage_event u
           WHERE u.source_local IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM generation_source gs
             WHERE gs.generation_id = ?
               AND gs.source_local = u.source_local
               AND gs.source_ordinal = u.source_ordinal))
          +
          (SELECT COUNT(*) FROM quota_occurrence q
           WHERE NOT EXISTS (
             SELECT 1 FROM generation_source gs
               WHERE gs.generation_id = ?
                 AND gs.source_local = q.source_local
                 AND gs.source_ordinal = q.source_ordinal))
          +
          -- A source cursor is the durable owner of the source ordinal. A
          -- generation that merely has a non-NULL ordinal on its source row
          -- is not attested if the cursor is missing, NULL, or disagrees.
          (SELECT COUNT(*) FROM generation_source gs
           LEFT JOIN source_cursor sc ON sc.source_local = gs.source_local
           WHERE gs.generation_id = ?
             AND gs.status <> 'failed'
             AND (sc.source_local IS NULL OR sc.source_ordinal IS NULL
               OR sc.source_ordinal != gs.source_ordinal))
        ) AS count
      `).get(
        generationId,
        generationId,
        generationId,
        generationId,
        generationId,
        generationId,
      )?.count ?? 0);
      const quotaProvenanceMissing = Number(database.prepare(`
        SELECT (
          (SELECT COUNT(*) FROM quota_occurrence
           WHERE source_local IS NULL OR source_offset IS NULL
             OR source_ordinal IS NULL OR slot_order IS NULL
             OR surface_id IS NULL OR admission IS NULL)
          +
          (SELECT COUNT(*) FROM quota_observation q
           WHERE NOT EXISTS (
             SELECT 1 FROM quota_occurrence o
             WHERE o.canonical_observation_id = q.id))
        ) AS count
      `).get()?.count ?? 0);
      const toolFacts = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM tool_class_fact
        WHERE generation_id = ?
      `).get(generationId)?.count ?? 0);
      const toolProvenanceMissing = Number(database.prepare(`
        SELECT (
          (SELECT COUNT(*) FROM tool_class_fact f
           WHERE f.generation_id = ?
             AND (f.source_local IS NULL OR f.source_offset IS NULL
               OR f.source_ordinal IS NULL OR f.session_local IS NULL
               OR f.tool_class IS NULL OR f.source_kind IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = f.source_local
                   AND gs.source_ordinal = f.source_ordinal)))
          +
          (SELECT COUNT(*) FROM source_diagnostic
           WHERE generation_id = ?
             AND code IN ('toolRecordsSkipped', 'toolSourceHistoryUnavailable')
             AND count > 0)
        ) AS count
      `).get(generationId, generationId, generationId)?.count ?? 0);
      const toolProvenanceComplete = toolProvenanceMissing === 0;
      const toolFactFingerprint = readUnifiedIndexToolFactFingerprint(
        database,
        generationId,
      );
      const sourceOrderComplete = sourceOrderMissing === 0;
      const quotaProvenanceComplete = quotaProvenanceMissing === 0;
      let publishedStatus = status;
      let publishedReason = blockReason;
      if (publishedStatus === "complete" && !usageProvenanceComplete) {
        publishedStatus = "partial";
        publishedReason = "legacy_nullable_rows";
      } else if (publishedStatus === "complete" && !sourceOrderComplete) {
        publishedStatus = "partial";
        publishedReason = "source_order_incomplete";
      } else if (publishedStatus === "complete" && !quotaProvenanceComplete) {
        publishedStatus = "partial";
        publishedReason = "quota_occurrences_incomplete";
      } else if (publishedStatus === "complete" && !actualDiagnosticsComplete) {
        publishedStatus = "partial";
        publishedReason = "source_diagnostics_incomplete";
      } else if (publishedStatus === "complete" && !toolProvenanceComplete) {
        publishedStatus = "partial";
        publishedReason = "tool_provenance_incomplete";
      }
      statements.generation.run(
        completedAtMs,
        publishedStatus,
        publishedReason,
        indexedSourceCount ?? discoveredSourceCount,
        indexedSourceBytes ?? discoveredSourceBytes,
        skippedSourceCount,
        skippedSourceBytes,
        skippedThreadCount,
        Number(counts?.usage_events ?? 0),
        Number(counts?.quota_occurrences ?? 0),
        starts.length === 0 ? coveredStartMs : Math.min(...starts),
        ends.length === 0 ? coveredEndMs : Math.max(...ends),
        discoveryComplete ? 1 : 0,
        actualDiagnosticsComplete ? 1 : 0,
        usageProvenanceComplete ? 1 : 0,
        sourceOrderComplete ? 1 : 0,
        quotaProvenanceComplete ? 1 : 0,
        toolFacts,
        toolFactFingerprint,
        toolProvenanceComplete ? 1 : 0,
        generationId,
      );
      if (publishedStatus === "complete" || publishedStatus === "partial") {
        statements.meta.run("current_generation_id", generationId);
        statements.meta.run("status", publishedStatus);
      }
      commit();
    },

    failGeneration(blockReason = "exception") {
      if (generationId === null) return;
      begin();
      statements.generation.run(
        Date.now(), "failed", blockReason,
        null, null, null, null, null, null, null, null, null, 0, 0, 0, 0, 0,
        null, null, 0, generationId,
      );
      commit();
    },

    flush() {
      commit();
    },

    /**
     * Settle the whole run: one optimize, one integrity check, one fsync.
     */
    async close({ integrityCheck = true, fsyncPath = null } = {}) {
      commit();
      database.exec("PRAGMA optimize");
      if (integrityCheck) {
        const result = database.prepare("PRAGMA quick_check").get();
        if (result?.quick_check !== "ok") {
          throw fixedError("local_unified_index_integrity_failed");
        }
      }
      database.close();
      if (fsyncPath !== null) {
        await chmod(fsyncPath, 0o600);
        await syncFile(fsyncPath);
      }
      return {
        usageRows,
        boundaryRows,
        toolRows,
        quotaOccurrenceRows,
        batches,
      };
    },
  };
}

/**
 * Publish a staged index over the live one by atomic rename. The staged file is
 * fsynced first, so a crash mid-publish leaves either the old index or the new
 * one, never a torn mixture.
 */
export async function publishStagedUnifiedIndex(
  stageFile,
  indexFile,
  { allowRecoveryLock = false, signal = null } = {},
) {
  if (signal !== null
      && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (signal?.aborted) throw fixedError("local_unified_index_aborted");
  if (!allowRecoveryLock) assertLocalUnifiedIndexRecoveryUnlocked(indexFile);
  await chmod(stageFile, 0o600);
  await syncFile(stageFile);
  // A rebuild close can be entirely synchronous. Yield once after the durable
  // stage fsync so an already-queued cancellation becomes observable before
  // final target validation; never yield after validation or the signal check.
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  if (signal?.aborted) throw fixedError("local_unified_index_aborted");
  if (!allowRecoveryLock) assertLocalUnifiedIndexRecoveryUnlocked(indexFile);
  await assertSafeLocalUnifiedIndexTarget(indexFile, { allowMissing: true });
  // Target validation yields to the event loop. Recovery can acquire its lock
  // while that validation is in flight, so re-check exclusion after the await
  // and adjacent to the atomic rename. No asynchronous boundary remains after
  // this cancellation/lock pair; neither an abort nor a newly acquired recovery
  // lock can therefore be missed because target verification was suspended.
  if (signal?.aborted) throw fixedError("local_unified_index_aborted");
  if (!allowRecoveryLock) assertLocalUnifiedIndexRecoveryUnlocked(indexFile);
  await rename(stageFile, indexFile);
  try {
    await syncDirectoryPath(dirname(resolve(indexFile)));
    await syncFile(indexFile);
  } catch {
    // The rename has already happened. Report that exact bounded state so the
    // caller retains its last generation-bound cache and retries inspection;
    // never pretend the old file is still live or attempt a destructive undo.
    const error = fixedError(
      "local_unified_index_publication_durability_uncertain",
    );
    error.published = true;
    throw error;
  }
}

export async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// Cooperative abort removes its own stage. A hard worker termination cannot
// run that catch path, so a bounded scanner reclaims only old, exact stage
// names whose process/attempt owner is proven inactive.
export const LOCAL_UNIFIED_INDEX_ABANDONED_STAGE_MIN_AGE_MS =
  2 * 60 * 60_000;
export const LOCAL_UNIFIED_INDEX_ABANDONED_STAGE_SCAN_LIMIT = 64;
const LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

function localUnifiedIndexStageOwner(name, indexName) {
  for (const kind of ["building", "incremental"]) {
    const prefix = `${indexName}.${kind}-`;
    if (!name.startsWith(prefix)) continue;
    const match = /^([1-9][0-9]*)-([0-9a-z]+)$/u.exec(
      name.slice(prefix.length),
    );
    if (match === null) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid)
      ? {
        pid,
        attemptToken: LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN.test(match[2])
          ? match[2]
          : null,
      }
      : null;
  }
  return null;
}

function processAppearsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

// A filename cursor must re-enumerate from the beginning to discover that its
// remembered entry was deleted. Retain the bounded directory stream itself so
// every pass performs at most scanLimit raw reads and resumes at the next OS
// directory entry. The product owns one index; the cap only contains injected
// callers/tests and every handle is closed at EOF or eviction.
const abandonedStageDirectoryScans = new Map();
const MAX_ABANDONED_STAGE_DIRECTORY_SCANS = 64;

async function closeAbandonedStageDirectoryScan(indexFile, state) {
  if (abandonedStageDirectoryScans.get(indexFile) === state) {
    abandonedStageDirectoryScans.delete(indexFile);
  }
  try {
    await state.handle.close();
  } catch {
    // A directory stream can already be closed after an iteration/read error.
  }
}

async function abandonedStageDirectoryScan(
  directory,
  indexFile,
  scanLimit,
  openDirectory,
  directoryChain,
) {
  let state = abandonedStageDirectoryScans.get(indexFile) ?? null;
  if (state !== null
      && (state.directory !== directory
        || state.openDirectory !== openDirectory
        || !sameLocalUnifiedIndexDirectoryChain(
          state.directoryChain,
          directoryChain,
        ))) {
    await closeAbandonedStageDirectoryScan(indexFile, state);
    state = null;
  }
  if (state === null) {
    let handle;
    try {
      handle = await openDirectory(directory, {
        bufferSize: Math.min(scanLimit, 32),
      });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    state = { directory, directoryChain, handle, openDirectory };
    abandonedStageDirectoryScans.set(indexFile, state);
    while (abandonedStageDirectoryScans.size
        > MAX_ABANDONED_STAGE_DIRECTORY_SCANS) {
      const oldestIndexFile = abandonedStageDirectoryScans.keys().next().value;
      const oldest = abandonedStageDirectoryScans.get(oldestIndexFile);
      await closeAbandonedStageDirectoryScan(oldestIndexFile, oldest);
    }
  } else {
    // Map insertion order is the eviction order; touching a live scan keeps it
    // from being evicted by unrelated injected index paths.
    abandonedStageDirectoryScans.delete(indexFile);
    abandonedStageDirectoryScans.set(indexFile, state);
  }
  return state;
}

async function rotatingLocalUnifiedIndexStageNames(
  directory,
  indexFile,
  indexName,
  scanLimit,
  openDirectory,
  directoryChain,
) {
  const state = await abandonedStageDirectoryScan(
    directory,
    indexFile,
    scanLimit,
    openDirectory,
    directoryChain,
  );
  if (state === null) return null;
  const selected = [];
  for (let enumerated = 0; enumerated < scanLimit; enumerated += 1) {
    let entry;
    try {
      entry = await state.handle.read();
    } catch (error) {
      await closeAbandonedStageDirectoryScan(indexFile, state);
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (entry === null) {
      await closeAbandonedStageDirectoryScan(indexFile, state);
      break;
    }
    const name = entry.name;
    if (localUnifiedIndexStageOwner(name, indexName) === null) continue;
    selected.push(name);
  }
  return selected;
}

/**
 * Remove only the two stage names an exact, confirmed-terminated off-main
 * attempt could own. The unguessable token, current PID, safe directory chain,
 * and owner-only single-link file checks make this narrower than an abandoned
 * stage scan; anything uncertain is retained for later diagnosis.
 */
export async function removeExactLocalUnifiedIndexAttemptStages(
  indexFile,
  attemptToken,
) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (typeof attemptToken !== "string"
      || !LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN.test(attemptToken)) {
    throw new TypeError("attemptToken must be a 32-character hex token");
  }
  const resolvedIndexFile = resolve(indexFile);
  const directoryChain = assertSafeLocalUnifiedIndexParentPath(
    resolvedIndexFile,
  );
  let inspected = 0;
  let removed = 0;
  let skipped = 0;
  for (const kind of ["building", "incremental"]) {
    const candidate = `${resolvedIndexFile}.${kind}-${process.pid}-${attemptToken}`;
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      skipped += 1;
      continue;
    }
    inspected += 1;
    if (!ownerOnlyRegularFile(metadata)) {
      skipped += 1;
      continue;
    }
    let verified;
    try {
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
      verified = await lstat(candidate);
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
    } catch {
      skipped += 1;
      continue;
    }
    if (!sameLocalUnifiedIndexTarget(metadata, verified)) {
      skipped += 1;
      continue;
    }
    try {
      await unlink(candidate);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") skipped += 1;
    }
  }
  return Object.freeze({ inspected, removed, skipped });
}

export async function removeAbandonedLocalUnifiedIndexStages(
  indexFile,
  {
    nowMs = Date.now(),
    minimumAgeMs = LOCAL_UNIFIED_INDEX_ABANDONED_STAGE_MIN_AGE_MS,
    scanLimit = LOCAL_UNIFIED_INDEX_ABANDONED_STAGE_SCAN_LIMIT,
    platform = process.platform,
    isProcessAlive = processAppearsAlive,
    activeAttemptToken = null,
    openDirectory = opendir,
  } = {},
) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(minimumAgeMs)
      || minimumAgeMs < 60_000) {
    throw new TypeError("abandoned stage age is invalid");
  }
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 256) {
    throw new TypeError("abandoned stage scan limit is invalid");
  }
  if (typeof isProcessAlive !== "function") {
    throw new TypeError("isProcessAlive must be a function");
  }
  if (typeof openDirectory !== "function") {
    throw new TypeError("openDirectory must be a function");
  }
  if (activeAttemptToken !== null
      && (typeof activeAttemptToken !== "string"
        || !LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN.test(activeAttemptToken))) {
    throw new TypeError(
      "activeAttemptToken must be null or a 32-character hex token",
    );
  }
  // Windows state remains behind its separately qualified native capability.
  if (platform === "win32") {
    return Object.freeze({ inspected: 0, removed: 0, skipped: 0 });
  }

  const resolvedIndexFile = resolve(indexFile);
  const directory = dirname(resolvedIndexFile);
  const indexName = basename(resolvedIndexFile);
  const directoryChain = assertSafeLocalUnifiedIndexParentPath(
    resolvedIndexFile,
  );
  const names = await rotatingLocalUnifiedIndexStageNames(
    directory,
    resolvedIndexFile,
    indexName,
    scanLimit,
    openDirectory,
    directoryChain,
  );
  if (names === null) {
    return Object.freeze({ inspected: 0, removed: 0, skipped: 0 });
  }

  let inspected = 0;
  let removed = 0;
  let skipped = 0;
  for (const name of names) {
    inspected += 1;
    const owner = localUnifiedIndexStageOwner(name, indexName);
    const pid = owner?.pid ?? null;
    const candidate = resolve(directory, name);
    if (pid === null || dirname(candidate) !== directory) {
      skipped += 1;
      continue;
    }
    let metadata;
    try {
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
      metadata = await lstat(candidate);
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      skipped += 1;
      continue;
    }
    if (!ownerOnlyRegularFile(metadata)
        || !Number.isFinite(metadata.mtimeMs)
        || nowMs - metadata.mtimeMs < minimumAgeMs) {
      skipped += 1;
      continue;
    }
    const ownerIsAlive = owner.attemptToken !== null
      && pid === process.pid
      && activeAttemptToken !== null
      ? owner.attemptToken === activeAttemptToken
      : isProcessAlive(pid);
    if (ownerIsAlive) {
      skipped += 1;
      continue;
    }
    let verified;
    try {
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
      verified = await lstat(candidate);
      recheckLocalUnifiedIndexDirectoryChain(
        resolvedIndexFile,
        directoryChain,
      );
    } catch {
      skipped += 1;
      continue;
    }
    if (!sameLocalUnifiedIndexTarget(metadata, verified)) {
      skipped += 1;
      continue;
    }
    try {
      await unlink(candidate);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") skipped += 1;
    }
  }
  return Object.freeze({ inspected, removed, skipped });
}

const EMPTY_INSPECTION = Object.freeze({
  status: "missing",
  schemaVersion: null,
  userVersion: null,
  compatibility: null,
  usageEvents: 0,
  quotaObservations: 0,
  toolClassRows: 0,
  sessions: 0,
  models: [],
  firstObservedAtMs: null,
  lastObservedAtMs: null,
  indexBytes: 0,
});

export async function inspectLocalUnifiedIndex({
  indexFile = defaultLocalUnifiedIndexPath(),
} = {}) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch (error) {
    if (error?.code === "ENOENT") return EMPTY_INSPECTION;
    throw fixedError("local_unified_index_unavailable");
  }
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    const compatibility = readLocalUnifiedIndexCompatibility(database);
    const usage = database.prepare(`
      SELECT COUNT(*) AS events,
             COUNT(DISTINCT session_local) AS sessions,
             MIN(observed_at_ms) AS first_ms,
             MAX(observed_at_ms) AS last_ms
      FROM usage_event`).get();
    const models = database.prepare(`
      SELECT m.model_id AS model_id, m.recognition AS recognition,
             COUNT(*) AS events
      FROM usage_event u JOIN model m ON m.id = u.model_id
      GROUP BY m.model_id, m.recognition
      ORDER BY events DESC`).all().map((row) => ({
        modelId: row.model_id,
        recognition: row.recognition,
        events: Number(row.events),
      }));
    return {
      status: "available",
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
      userVersion: compatibility.userVersion,
      compatibility,
      usageEvents: Number(usage?.events ?? 0),
      quotaObservations: Number(
        database.prepare("SELECT COUNT(*) AS c FROM quota_observation").get()?.c ?? 0,
      ),
      toolClassRows: Number(
        database.prepare(`SELECT COUNT(*) AS c FROM ${
          database.prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tool_class_fact'",
          ).get() === undefined ? "tool_class_count" : "tool_class_fact"
        }`).get()?.c ?? 0,
      ),
      sessions: Number(usage?.sessions ?? 0),
      models,
      firstObservedAtMs: usage?.first_ms === null ? null : Number(usage.first_ms),
      lastObservedAtMs: usage?.last_ms === null ? null : Number(usage.last_ms),
      indexBytes: metadata.size,
    };
  } finally {
    database?.close();
  }
}

/**
 * The aggregate used to prove that a rebuild changed nothing observable. It is
 * deliberately computed in SQLite rather than by replaying rows in JavaScript,
 * so it can be run against a 190 MB index without allocating.
 */
export function readUnifiedIndexAggregate(database) {
  const totals = database.prepare(`
    SELECT COUNT(*) AS events,
           COALESCE(SUM(tokens_in_uncached), 0) AS in_uncached,
           COALESCE(SUM(tokens_in_cache_read), 0) AS in_cache_read,
           COALESCE(SUM(tokens_in_cache_write), 0) AS in_cache_write,
           COALESCE(SUM(tokens_out_text), 0) AS out_text,
           COALESCE(SUM(tokens_out_reasoning), 0) AS out_reasoning,
           MIN(observed_at_ms) AS first_ms,
           MAX(observed_at_ms) AS last_ms
    FROM usage_event`).get();
  return {
    events: Number(totals?.events ?? 0),
    inputUncachedTokens: Number(totals?.in_uncached ?? 0),
    inputCacheReadTokens: Number(totals?.in_cache_read ?? 0),
    inputCacheWriteTokens: Number(totals?.in_cache_write ?? 0),
    outputTextTokens: Number(totals?.out_text ?? 0),
    outputReasoningTokens: Number(totals?.out_reasoning ?? 0),
    firstObservedAtMs: totals?.first_ms === null ? null : Number(totals.first_ms),
    lastObservedAtMs: totals?.last_ms === null ? null : Number(totals.last_ms),
  };
}
