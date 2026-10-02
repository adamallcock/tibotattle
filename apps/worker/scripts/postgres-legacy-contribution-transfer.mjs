// PT-4 production stages (D-PT4X, round 5) on PT-1's production transfer
// target (scripts/postgres-transfer-target.mjs) over the sealed ingestion D1
// of a PT-2-lite seal (cutover-source-seal.mjs). Three runners:
//
//   * runLegacyContributionsProduction, stage 'legacy-contributions' (N-V0X).
//     The sealed v0.x HISTORY: telemetry_contributions, telemetry_records,
//     telemetry_contribution_occurrences and the two admission-window tables,
//     imported verbatim whatever OD-8 decides about new v0.x uploads (round 5:
//     analytics reads v0.2 evidence). 'deleting' contributions and their
//     quarantine_deleted_at carry over. The legacy synthetic `contributions`
//     table has no PostgreSQL target and must be empty
//     (CUTOVER_TABLE_TARGET_MISSING). No pending_objects row is synthesized for
//     a contribution: both stores clear a registration when its contribution
//     row is inserted.
//   * runPendingRegistrationsProduction, stage 'pending-registrations'. The
//     single owner of D1 pending_quarantine_objects: every sealed row lands
//     exactly once in pending_objects (object_key = r2_key; contribution id,
//     kind, registered_at, state and lease verbatim; registration_token is the
//     column DEFAULT), except that a chunk-owned registration (contribution id
//     a sealed chunk's id, r2_key that chunk's key) takes its family's
//     PostgreSQL kind (telemetry_v1, telemetry_v11 or telemetry_v12), the
//     reviewed T-0 mapping the telemetry stages (D-PT5A) apply through
//     CHUNK_REGISTRATION_FAMILIES. A row a telemetry stage already mapped must be
//     equal, field by field; any other row, a missing one or an extra one
//     refuses CUTOVER_PENDING_OBJECT_CONFLICT. PostgreSQL
//     pending_quarantine_objects stays empty. With every registration it
//     writes the E-PT4 transfer HOLD (pending_object_transfer_holds), so
//     C-MAINT's reconciler cannot clear an aged orphan registration whose
//     object still lives only in R2 before PT-7 copies it.
//   * runOperationalHistoryProduction, table receipts under PT-8-lite's
//     'post-import' stage (it writes no stage receipt; PT-8 folds its
//     receiptSha256 into the post-import receipt):
//       - N-ADMINHIST: admin_metric_snapshots, plus any snapshot that only the
//         cached admin_metrics_history_cache payload still carries, mapped into
//         analytics_admin_metric_snapshots under the sealed
//         storage_source_state.source_id, so the admin charts continue;
//       - N-EXCL: community_aggregate_exclusions imported into its staged
//         PostgreSQL table, for rows whose participant is a sealed participant.
//         A row naming any other participant (D1 keeps the audit row after an
//         erasure) can never apply and is not imported: it is counted, never
//         copied, so no erased participant's id enters PostgreSQL.
//
// And checkPendingObjectTransferGuard, PT-8-lite preflight P13 (read-only).
//
// Contract (PT-8-lite design section 4, "runner contract"):
//   * Each runner refuses before any write unless 'identity-authority' is
//     complete in the handle's run; 'pending-registrations' also needs
//     'legacy-contributions', 'telemetry-v1-v11' and 'telemetry-v12'.
//   * Every check that can refuse runs before the first write: the column map
//     closure (CUTOVER_COLUMN_UNMAPPED), the canonical form of every sealed
//     value (CUTOVER_SOURCE_VALUE_INVALID), the reviewed trigger policy and the
//     target column layout.
//   * Pages of at most 256 rows and 4 MiB; each page is one transaction under
//     SET LOCAL ROLE with a pending checkpoint (count and prefix chain, never a
//     key). A killed run resumes at the last committed page; a finished stage
//     replays without writing.
//   * A table completes only when its target digest equals the expected
//     digest. Receipts hold names, counts and digests; no value read from a
//     source or target is ever placed in an error, log or receipt.

import { createHash } from "node:crypto";
import { CutoverSourceError, openSealedSourceFromSeal, readCutoverSeal } from "./cutover-source-seal.mjs";
import {
  PostgresFastpathIdentityCopyError,
  fastpathIdentitySourceValue,
  fastpathIdentityTargetExpression,
  fastpathIdentityTargetValue,
} from "./postgres-fastpath-identity-copy.mjs";
import { CHUNK_REGISTRATION_FAMILIES } from "./postgres-production-telemetry-modes.mjs";
import {
  EMPTY_PREFIX_CHAIN,
  PostgresTransferTargetError,
  advancePrefixChain,
  applyIdentityHighWater,
  assertInstantRoundTrip,
  assertStageComplete,
  assertTriggerPolicyCoverage,
  createRowsDigest,
  productionTransferId,
  readCheckpoint,
  recordCheckpoint,
  requireImportingRun,
  stageReceipt,
  tableReceipt,
  withTransferTransaction,
  withTriggerPolicy,
} from "./postgres-transfer-target.mjs";

export const LEGACY_CONTRIBUTION_TRANSFER_SCHEMA = "tibotattle-legacy-contribution-transfer-v1";
export const LEGACY_CONTRIBUTIONS_STAGE = "legacy-contributions";
export const PENDING_REGISTRATIONS_STAGE = "pending-registrations";
/** N-ADMINHIST and N-EXCL write their table receipts under PT-8-lite's post-import stage. */
export const OPERATIONAL_HISTORY_STAGE = "post-import";
export const LEGACY_TRANSFER_MAX_PAGE_ROWS = 256;
export const LEGACY_TRANSFER_MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** The owner flag PT-8-lite preflight P13 accepts in place of the transfer-hold guard. */
export const OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING = "accept-orphan-registration-clearing";
export const PENDING_OBJECT_TRANSFER_HOLD_TABLE = "pending_object_transfer_holds";
export const PENDING_OBJECT_TRANSFER_HOLD_GUARD = "pending_object_transfer_hold_guard";
export const PENDING_REGISTRATIONS_PREREQUISITE_STAGES = Object.freeze([
  "identity-authority", "legacy-contributions", "telemetry-v1-v11", "telemetry-v12",
]);
export const ADMIN_METRICS_HISTORY_SCHEMA_VERSION = "admin-metrics-history-v0.3";
/** The tools write only application tables: nothing is staged in, or kept in, tibotattle_transfer. */
export const PRODUCTION_STAGING_RELATIONS = Object.freeze([]);
export const PRODUCTION_RETAINED_RELATIONS = Object.freeze([]);

export const LEGACY_CONTRIBUTION_TRANSFER_ERROR_CODES = Object.freeze([
  "CUTOVER_CHECKPOINT_DIVERGED",
  "CUTOVER_COLUMN_UNMAPPED",
  "CUTOVER_LEGACY_ARGUMENT_INVALID",
  "CUTOVER_LEGACY_TABLE_DIGEST_MISMATCH",
  "CUTOVER_LEGACY_TRANSFER_FAILED",
  "CUTOVER_PAGE_ROW_TOO_LARGE",
  "CUTOVER_PENDING_OBJECT_CONFLICT",
  "CUTOVER_PENDING_OBJECT_GUARD_MISSING",
  "CUTOVER_PENDING_QUARANTINE_TARGET_NOT_EMPTY",
  "CUTOVER_SOURCE_IDENTITY_MISMATCH",
  "CUTOVER_SOURCE_SINGLETON_INVALID",
  "CUTOVER_SOURCE_TABLE_MISSING",
  "CUTOVER_SOURCE_VALUE_INVALID",
  "CUTOVER_TABLE_TARGET_MISSING",
  "CUTOVER_TARGET_COLUMN_MISMATCH",
  "CUTOVER_TARGET_ROW_COUNT_DIVERGED",
  "CUTOVER_TARGET_WRITE_REFUSED",
  "CUTOVER_TRANSFER_SESSION_REQUIRED",
]);
const ERROR_CODES = new Set(LEGACY_CONTRIBUTION_TRANSFER_ERROR_CODES);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,30})?$/u;
const GAUGE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const MAX_GAUGES = 128;
const MAX_SNAPSHOT_JSON = 4000;
const MAX_CACHE_JSON = 512 * 1024;
const MAX_CACHE_SNAPSHOTS = 400;
const MAX_OBJECT_KEY = 1024;
const TARGET_PAGE_ROWS = 2000;
const HASH = value => createHash("sha256").update(value).digest("hex");

export class LegacyContributionTransferError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      for (const key of ["table", "column"]) {
        if (typeof details[key] === "string" && IDENTIFIER.test(details[key])) safe[key] = details[key];
      }
      if (typeof details.sqlState === "string" && SQLSTATE.test(details.sqlState)) safe.sqlState = details.sqlState;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix ? `${code} [${suffix}]` : code);
    this.name = "LegacyContributionTransferError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_LEGACY_TRANSFER_FAILED";
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new LegacyContributionTransferError(code, details);
}

function quote(name) {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("CUTOVER_LEGACY_ARGUMENT_INVALID");
  return `"${name}"`;
}

function sqlStateOf(error) {
  return typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : undefined;
}

async function q(client, text, values, table = undefined) {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof LegacyContributionTransferError || error instanceof PostgresTransferTargetError) throw error;
    return fail("CUTOVER_TARGET_WRITE_REFUSED", { table, sqlState: sqlStateOf(error) });
  }
}

// ---------------------------------------------------------------------------
// Canonical values. text, int, instant and day reuse the reviewed T-1/PT-3
// codec; real, decimal and json are the three D1 shapes the v0.x tables add.
// Source and target rows both reduce to arrays of canonical values in column
// order, so their digests compare directly.

const TARGET_TYPES = Object.freeze({
  text: Object.freeze(["text"]),
  int: Object.freeze(["bigint", "integer", "smallint"]),
  instant: Object.freeze(["timestamp with time zone"]),
  "instant-key": Object.freeze(["timestamp with time zone"]),
  day: Object.freeze(["date"]),
  real: Object.freeze(["double precision"]),
  decimal: Object.freeze(["numeric"]),
  json: Object.freeze(["jsonb"]),
});
const KEY_CASTS = Object.freeze({ text: "text", int: "bigint", "instant-key": "timestamptz", day: "date" });

function c(source, type, target = source) {
  if (!IDENTIFIER.test(source) || !IDENTIFIER.test(target) || !Object.hasOwn(TARGET_TYPES, type)) {
    throw new TypeError("legacy contribution column definition invalid");
  }
  return Object.freeze({ source, target, type });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function canonicalJsonText(text, table, column) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
  }
  return JSON.stringify(canonicalJson(parsed));
}

function finiteReal(value, table, column) {
  const number = typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER)
      && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
  return String(number);
}

/** Returns [canonical, parameter] for one sealed cell. */
export function legacySourceValue(type, value, table, column) {
  if (value === null || value === undefined) return [null, null];
  switch (type) {
    case "real": {
      const text = finiteReal(value, table, column);
      return [text, text];
    }
    case "decimal":
      if (typeof value !== "string" || !DECIMAL.test(value)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
      return [value, value];
    case "json":
      if (typeof value !== "string" || value.includes("\0")) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
      return [canonicalJsonText(value, table, column), value];
    case "instant-key": {
      const pair = legacySourceValue("instant", value, table, column);
      // A key is compared in sealed (text) order, so it must already be canonical.
      if (pair[0] !== value) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
      return pair;
    }
    default:
      try {
        return fastpathIdentitySourceValue(type, value, table, column);
      } catch (error) {
        if (error instanceof PostgresFastpathIdentityCopyError) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
        throw error;
      }
  }
}

function targetExpression(column) {
  switch (column.type) {
    case "real":
    case "decimal":
    case "json":
      return `${quote(column.target)}::text`;
    case "instant-key":
      return fastpathIdentityTargetExpression({ ...column, type: "instant" });
    default:
      return fastpathIdentityTargetExpression(column);
  }
}

function targetValue(type, value, table, column) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("CUTOVER_LEGACY_TABLE_DIGEST_MISMATCH", { table, column });
  switch (type) {
    case "real": {
      const number = Number(value);
      if (!Number.isFinite(number)) fail("CUTOVER_LEGACY_TABLE_DIGEST_MISMATCH", { table, column });
      return String(number);
    }
    case "decimal":
      return value;
    case "json":
      try {
        return JSON.stringify(canonicalJson(JSON.parse(value)));
      } catch {
        return fail("CUTOVER_LEGACY_TABLE_DIGEST_MISMATCH", { table, column });
      }
    default:
      return fastpathIdentityTargetValue(type === "instant-key" ? "instant" : type, value, table, column);
  }
}

// ---------------------------------------------------------------------------
// The frozen table specs. Column lists are the d43c8f92 D1 shapes (closed in
// both directions against the seal and the Q-1 schema by the check file).

const text = name => c(name, "text");
const int = name => c(name, "int");
const instant = name => c(name, "instant");
const real = name => c(name, "real");
const decimal = name => c(name, "decimal");
const json = name => c(name, "json");

function spec(name, key, columns, { target = name, suppress = {}, fire = {}, where = null } = {}) {
  const frozen = Object.freeze({
    name, target, key: Object.freeze([...key]), columns: Object.freeze([...columns]),
    suppress: Object.freeze({ ...suppress }), fire: Object.freeze({ ...fire }), where,
  });
  for (const keyColumn of frozen.key) {
    const column = frozen.columns.find(candidate => candidate.target === keyColumn);
    if (column === undefined || !Object.hasOwn(KEY_CASTS, column.type)) throw new TypeError("legacy key column invalid");
  }
  return frozen;
}

const SOURCE_REVISION = "0014 telemetry_legacy_source_revision: bumps input_versions and input_source_digests and emits"
  + " journal events; the sealed journal is imported verbatim (ingestion-journal) and analytics is recomputed.";

const TELEMETRY_CONTRIBUTIONS = spec("telemetry_contributions", ["id"], [
  text("id"), text("participant_id"), text("plaintext_digest"), text("envelope_digest"), text("r2_key"),
  text("status"), text("schema_version"), instant("range_start"), instant("range_end"), text("client_platform"),
  text("provider_policy_epoch"), decimal("estimated_api_cost_usd"), real("priced_event_coverage_percent"),
  int("unknown_model_event_count"), int("unknown_billable_units"), text("price_basis"), int("declared_record_count"),
  instant("created_at"), text("upload_authorization_id"), int("server_cost_nanousd"), int("server_priced_event_count"),
  int("server_partially_priced_event_count"), int("server_unpriced_event_count"), text("server_pricing_method_version"),
  text("server_price_registry_version"), text("server_price_registry_sha256"), text("transport_schema_version"),
  text("dataset_id"), int("dataset_part_index"), int("dataset_part_count"), text("dataset_completeness"),
  instant("dataset_range_start"), instant("dataset_range_end"), text("device_upload_authorization_id"),
  instant("quarantine_deleted_at"), int("accepted_record_count"), text("server_price_basis"),
  text("server_price_epoch_basis"), instant("server_price_event_time_start"), instant("server_price_event_time_end"),
], {
  suppress: {
    telemetry_contributions_enforce_admission_window: "0061 weekly admission cap: sealed rows were admitted on D1; their sealed windows are imported verbatim.",
    telemetry_contributions_record_admission_window: "0061 window counter: would double count the sealed windows imported verbatim.",
    telemetry_retained_source_revision: SOURCE_REVISION,
  },
  fire: {
    telemetry_contributions_active_participant: "0011 check: PT-3 imported every sealed participant 'active' (erasure quiescence), so it passes.",
  },
});

const TELEMETRY_RECORDS = spec("telemetry_records", ["id"], [
  int("id"), text("origin_contribution_id"), text("participant_id"), text("record_kind"), text("occurrence_id"),
  instant("observed_at"), text("provider"), text("model_id"), text("model_fingerprint"), text("speed_mode"),
  text("api_service_tier"), text("surface"), text("plan_type"), text("plan_variant"), text("limit_id"), text("slot"),
  real("used_percent"), int("window_duration_minutes"), instant("resets_at"), int("input_uncached_tokens"),
  int("input_cache_read_tokens"), int("input_cache_write_tokens"), int("output_text_tokens"),
  int("output_reasoning_tokens"), int("output_combined_tokens"), int("tool_units"), decimal("estimated_api_cost_usd"),
  real("pricing_coverage_percent"), int("unknown_billable_units"), json("record_json"), text("billing_surface"),
  int("total_input_context_tokens"), text("reasoning_effort"), text("agent_scope"), decimal("server_cost_usd"),
  int("server_cost_nanousd"), real("server_pricing_coverage_percent"), int("server_unknown_billable_units"),
  text("server_pricing_status"), text("server_pricing_method_version"), text("server_price_registry_version"),
  text("server_price_registry_sha256"), json("server_price_card_ids"), json("server_unpriced_reason_codes"),
  text("server_price_epoch_basis"), text("server_tier_basis"), text("server_api_service_tier"),
  text("account_track_id"), text("dataset_id"), text("policy_epoch"), text("server_price_basis"),
  instant("server_price_event_time"),
], { suppress: { telemetry_retained_record_source_revision: SOURCE_REVISION } });

const TELEMETRY_CONTRIBUTION_OCCURRENCES = spec("telemetry_contribution_occurrences",
  ["contribution_id", "record_kind", "occurrence_id"], [
    text("contribution_id"), text("participant_id"), text("record_kind"), text("occurrence_id"), text("dataset_id"),
    text("account_track_id"), text("policy_epoch"),
  ]);

const TELEMETRY_CONTRIBUTION_ADMISSION_WINDOWS = spec("telemetry_contribution_admission_windows",
  ["participant_id", "window_started_at"], [
    text("participant_id"), c("window_started_at", "instant-key"), int("accepted_count"), instant("last_accepted_at"),
  ]);

const TELEMETRY_V1_CHUNK_ADMISSION_WINDOWS = spec("telemetry_v1_chunk_admission_windows",
  ["participant_id", "device_id", "window_day"], [
    text("participant_id"), text("device_id"), c("window_day", "day"), int("accepted_count"), instant("last_accepted_at"),
  ]);

/** The frozen FK-topological order of the 'legacy-contributions' stage. */
export const LEGACY_CONTRIBUTIONS_ORDER = Object.freeze([
  "telemetry_contributions", "telemetry_records", "telemetry_contribution_occurrences",
  "telemetry_contribution_admission_windows", "telemetry_v1_chunk_admission_windows",
]);
const LEGACY_SPECS = Object.freeze([TELEMETRY_CONTRIBUTIONS, TELEMETRY_RECORDS, TELEMETRY_CONTRIBUTION_OCCURRENCES,
  TELEMETRY_CONTRIBUTION_ADMISSION_WINDOWS, TELEMETRY_V1_CHUNK_ADMISSION_WINDOWS]);
if (JSON.stringify(LEGACY_SPECS.map(item => item.name)) !== JSON.stringify(LEGACY_CONTRIBUTIONS_ORDER)) {
  throw new TypeError("legacy contribution specs drifted from the frozen order");
}
/** The legacy synthetic table with no PostgreSQL target: it must be empty. */
export const LEGACY_MUST_BE_EMPTY = Object.freeze(["contributions"]);

const PENDING_SOURCE = spec("pending_quarantine_objects", ["object_key"], [
  c("r2_key", "text", "object_key"), text("contribution_id"), text("object_kind"), instant("registered_at"),
  text("reconciliation_state"), text("reconciliation_lease_id"),
], { target: "pending_objects" });

const ADMIN_SNAPSHOTS = spec("admin_metric_snapshots", ["captured_at"], [
  c("captured_at", "instant-key"), text("metrics_json"),
], { target: "analytics_admin_metric_snapshots" });
const ADMIN_CACHE_COLUMNS = Object.freeze(["singleton", "generated_at", "payload_json"]);

const EXCLUSIONS = spec("community_aggregate_exclusions", ["exclusion_id"], [
  text("exclusion_id"), text("participant_id"), text("scope"), text("reason_code"), text("state"),
  instant("effective_at"), instant("expires_at"), instant("created_at"), text("created_by_digest"),
  instant("revoked_at"), text("revoked_by_digest"),
], {
  fire: { community_aggregate_exclusion_no_delete: "Append-only guard: fires on DELETE only; the import inserts." },
  where: `"participant_id" IN (SELECT "id" FROM "participants")`,
});

const HOLD_POLICY = Object.freeze({
  [PENDING_OBJECT_TRANSFER_HOLD_GUARD]: Object.freeze({ policy: "fire",
    reason: "Hold guard: fires on UPDATE or DELETE only; the import inserts." }),
});

function policyOf(item) {
  return Object.freeze({
    ...Object.fromEntries(Object.entries(item.suppress).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "suppress", reason })])),
    ...Object.fromEntries(Object.entries(item.fire).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "fire", reason })])),
  });
}

/** The reviewed trigger policy for every table the three runners write. */
export const LEGACY_TRIGGER_POLICY = Object.freeze({
  ...Object.fromEntries(LEGACY_SPECS.map(item => [item.target, policyOf(item)])),
  pending_objects: Object.freeze({}),
  [PENDING_OBJECT_TRANSFER_HOLD_TABLE]: HOLD_POLICY,
  analytics_admin_metric_snapshots: Object.freeze({}),
  community_aggregate_exclusions: policyOf(EXCLUSIONS),
});
export const TRIGGER_POLICY = LEGACY_TRIGGER_POLICY;

function policySubset(tables) {
  return Object.freeze(Object.fromEntries(tables.map(table => [table, LEGACY_TRIGGER_POLICY[table]])));
}

/** One disposition per sealed table these runners own (PT-8-lite section 3). */
export const LEGACY_TRANSFER_DISPOSITIONS = Object.freeze({
  telemetry_contributions: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "imported:legacy-contributions", target: "telemetry_contributions" }),
  telemetry_records: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "imported:legacy-contributions", target: "telemetry_records" }),
  telemetry_contribution_occurrences: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "imported:legacy-contributions", target: "telemetry_contribution_occurrences" }),
  telemetry_contribution_admission_windows: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "imported:legacy-contributions", target: "telemetry_contribution_admission_windows" }),
  telemetry_v1_chunk_admission_windows: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "imported:legacy-contributions", target: "telemetry_v1_chunk_admission_windows" }),
  contributions: Object.freeze({ stage: LEGACY_CONTRIBUTIONS_STAGE, token: "must-be-empty", target: null }),
  pending_quarantine_objects: Object.freeze({ stage: PENDING_REGISTRATIONS_STAGE, token: "mapped:pending-registrations", target: "pending_objects" }),
  admin_metric_snapshots: Object.freeze({ stage: OPERATIONAL_HISTORY_STAGE, token: "mapped:admin-metrics-history", target: "analytics_admin_metric_snapshots" }),
  admin_metrics_history_cache: Object.freeze({ stage: OPERATIONAL_HISTORY_STAGE, token: "mapped:admin-metrics-history", target: "analytics_admin_metric_snapshots" }),
  community_aggregate_exclusions: Object.freeze({ stage: OPERATIONAL_HISTORY_STAGE, token: "imported:community-aggregate-exclusions", target: "community_aggregate_exclusions" }),
});

/** The frozen COLUMN_MAP: source table -> [[source, target, type], ...]. */
export const LEGACY_TRANSFER_COLUMN_MAP = Object.freeze(Object.fromEntries([
  ...[...LEGACY_SPECS, PENDING_SOURCE, ADMIN_SNAPSHOTS, EXCLUSIONS].map(item => [item.name, Object.freeze({
    target: item.target,
    key: item.key,
    columns: Object.freeze(item.columns.map(column => Object.freeze([column.source, column.target, column.type]))),
  })]),
  ["admin_metrics_history_cache", Object.freeze({ target: "analytics_admin_metric_snapshots", key: Object.freeze(["singleton"]),
    columns: Object.freeze(ADMIN_CACHE_COLUMNS.map(name => Object.freeze([name, "gauges.snapshots", "cache"]))) })],
  ["contributions", Object.freeze({ target: null, key: Object.freeze([]), columns: Object.freeze([]) })],
]));

export function legacyContributionPolicySha256() {
  return HASH(JSON.stringify([LEGACY_CONTRIBUTION_TRANSFER_SCHEMA, LEGACY_CONTRIBUTIONS_ORDER, LEGACY_TRANSFER_COLUMN_MAP,
    LEGACY_TRIGGER_POLICY, LEGACY_TRANSFER_DISPOSITIONS, PENDING_REGISTRATIONS_PREREQUISITE_STAGES,
    LEGACY_MUST_BE_EMPTY, EXCLUSIONS.where, CHUNK_REGISTRATION_FAMILIES]));
}

// ---------------------------------------------------------------------------
// Sealed sources.

function sourceAll(database, sql, values = [], table = undefined) {
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...values);
  } catch {
    return fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
  }
}

function sourceTablePresent(database, table) {
  return sourceAll(database, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [table], table).length === 1;
}

function sourceColumns(database, table) {
  if (!sourceTablePresent(database, table)) fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
  return sourceAll(database, `PRAGMA table_xinfo(${quote(table)})`, [], table)
    .filter(column => Number(column.hidden) === 0).map(column => String(column.name));
}

/** COLUMN_MAP closure: every sealed column is mapped and every mapped column exists. */
function assertSourceColumnMap(database, table, mapped) {
  const actual = sourceColumns(database, table);
  for (const column of actual) {
    if (!mapped.includes(column)) fail("CUTOVER_COLUMN_UNMAPPED", { table, column: IDENTIFIER.test(column) ? column : undefined });
  }
  for (const column of mapped) {
    if (!actual.includes(column)) fail("CUTOVER_COLUMN_UNMAPPED", { table, column });
  }
}

function sourceCount(database, table, where = null) {
  const [row] = sourceAll(database, `SELECT count(*) AS n FROM ${quote(table)}${where ? ` WHERE ${where}` : ""}`, [], table);
  return Number(row.n);
}

function canonicalRow(item, row) {
  const values = [];
  const parameters = [];
  let size = 0;
  for (const column of item.columns) {
    const [canonical, parameter] = legacySourceValue(column.type, row[column.source], item.name, column.source);
    values.push(canonical);
    parameters.push(parameter);
    size += parameter === null ? 0 : typeof parameter === "string" ? Buffer.byteLength(parameter) : 8;
  }
  return { values, parameters, size };
}

/** A keyset-paged view of one sealed table (optionally filtered), in sealed key order. */
function tableSource(database, item) {
  const keys = item.key.map(key => item.columns.find(column => column.target === key).source);
  const list = item.columns.map(column => quote(column.source)).join(", ");
  const order = keys.map(quote).join(", ");
  return Object.freeze({
    item,
    page(after, limit) {
      const conditions = [];
      if (item.where !== null) conditions.push(`(${item.where})`);
      if (after !== null) conditions.push(`(${keys.map(quote).join(", ")}) > (${keys.map(() => "?").join(", ")})`);
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      return sourceAll(database, `SELECT ${list} FROM ${quote(item.name)}${where} ORDER BY ${order} LIMIT ?`,
        [...(after ?? []), limit], item.name).map(row => ({ ...canonicalRow(item, row), key: keys.map(key => row[key]) }));
    },
  });
}

/** An in-memory list of canonical rows (already in key order) presented as a source. */
function listSource(item, rows) {
  return Object.freeze({
    item,
    page(after, limit) {
      const start = after ?? 0;
      return rows.slice(start, start + limit).map((row, index) => ({ ...row, key: start + index + 1 }));
    },
  });
}

/** Stream the whole source once: count, bytes, digest and final prefix chain. */
function sourceFacts(source, maxRows) {
  const digest = createRowsDigest();
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let rows = 0;
  let bytes = 0;
  for (;;) {
    const page = source.page(after, maxRows);
    for (const row of page) {
      digest.update(row.values);
      chain = advancePrefixChain(chain, row.values);
      rows += 1;
      bytes += row.size;
      after = row.key;
    }
    if (page.length < maxRows) break;
  }
  return Object.freeze({ rows, bytes, sha256: digest.digest(), chain });
}

function sourcePrefix(source, count, maxRows) {
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let seen = 0;
  while (seen < count) {
    const page = source.page(after, Math.min(maxRows, count - seen));
    if (page.length === 0) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: source.item.name });
    for (const row of page) {
      chain = advancePrefixChain(chain, row.values);
      after = row.key;
      seen += 1;
    }
  }
  return { chain, after };
}

function pageOf(source, after, maxRows, maxBytes) {
  const page = [];
  let bytes = 0;
  for (const row of source.page(after, maxRows)) {
    if (row.size > maxBytes) fail("CUTOVER_PAGE_ROW_TOO_LARGE", { table: source.item.name });
    if (page.length > 0 && bytes + row.size > maxBytes) break;
    page.push(row);
    bytes += row.size;
  }
  return page;
}

// ---------------------------------------------------------------------------
// Target reads and writes.

async function assertTargetLayout(client, schema, item, constants = []) {
  const { rows } = await q(client, `SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, item.target], item.target);
  if (rows.length === 0) fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: item.target });
  const byName = new Map(rows.map(row => [row.column_name, row]));
  const mapped = [...item.columns.map(column => [column.target, column.type]), ...constants.map(([name]) => [name, "text"])];
  for (const [name, type] of mapped) {
    const row = byName.get(name);
    if (!row || !TARGET_TYPES[type].includes(row.data_type) || row.is_generated === "ALWAYS") {
      fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: item.target, column: name });
    }
  }
  const names = new Set(mapped.map(([name]) => name));
  for (const row of rows) {
    if (names.has(row.column_name)) continue;
    if (row.is_nullable === "NO" && row.column_default === null && row.is_identity !== "YES") {
      fail("CUTOVER_COLUMN_UNMAPPED", { table: item.target, column: IDENTIFIER.test(row.column_name) ? row.column_name : undefined });
    }
  }
}

async function targetCount(client, schema, table, constants = []) {
  const where = constants.length === 0 ? "" : ` WHERE ${constants.map(([name], index) => `${quote(name)} = $${index + 1}`).join(" AND ")}`;
  const { rows } = await q(client, `SELECT count(*)::text AS n FROM ${quote(schema)}.${quote(table)}${where}`,
    constants.map(([, value]) => value), table);
  return Number(rows[0].n);
}

async function insertPage(client, schema, item, rows, constants = []) {
  const columns = [...item.columns.map(column => quote(column.target)), ...constants.map(([name]) => quote(name))].join(", ");
  const width = item.columns.length + constants.length;
  const values = rows.map((_, rowIndex) => `(${Array.from({ length: width }, (__, columnIndex) =>
    `$${rowIndex * width + columnIndex + 1}`).join(", ")})`).join(", ");
  const result = await q(client, `INSERT INTO ${quote(schema)}.${quote(item.target)} (${columns}) VALUES ${values}`,
    rows.flatMap(row => [...row.parameters, ...constants.map(([, value]) => value)]), item.target);
  if (result.rowCount !== rows.length) fail("CUTOVER_TARGET_WRITE_REFUSED", { table: item.target });
}

/**
 * Digest of the target rows in the sealed key order (restricted to the
 * constant columns, if any), read in keyset pages. Keys round-trip as text
 * within the session; text keys compare under COLLATE "C", which is SQLite's
 * BINARY order for UTF-8.
 */
async function targetFacts(client, schema, item, constants = []) {
  const keyColumns = item.key.map(key => item.columns.find(column => column.target === key));
  const collate = column => (column.type === "text" ? ` COLLATE "C"` : "");
  const list = [
    ...item.columns.map(column => `${targetExpression(column)} AS ${quote(column.target)}`),
    ...keyColumns.map((column, index) => `${quote(column.target)}::text AS "__key_${index}"`),
  ].join(", ");
  const order = keyColumns.map(column => `${quote(column.target)}${collate(column)}`).join(", ");
  const digest = createRowsDigest();
  let rows = 0;
  let after = null;
  for (;;) {
    const values = constants.map(([, value]) => value);
    const conditions = constants.map(([name], index) => `${quote(name)} = $${index + 1}`);
    if (after !== null) {
      const placeholders = keyColumns.map((column, index) =>
        `$${values.length + index + 1}::${KEY_CASTS[column.type]}${collate(column)}`);
      conditions.push(`(${keyColumns.map(column => `${quote(column.target)}${collate(column)}`).join(", ")}) > (${placeholders.join(", ")})`);
      values.push(...after);
    }
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const result = await q(client, `SELECT ${list} FROM ${quote(schema)}.${quote(item.target)}${where}
      ORDER BY ${order} LIMIT ${TARGET_PAGE_ROWS}`, values, item.target);
    for (const row of result.rows) {
      digest.update(item.columns.map(column => targetValue(column.type, row[column.target], item.target, column.target)));
      rows += 1;
    }
    if (result.rows.length < TARGET_PAGE_ROWS) break;
    const last = result.rows.at(-1);
    after = keyColumns.map((_, index) => last[`__key_${index}`]);
  }
  return Object.freeze({ rows, sha256: digest.digest() });
}

async function readImportCheckpoint(handle, stage, name) {
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    return readCheckpoint(client, handle, { stage, name });
  }, { readOnly: true });
}

/**
 * Copy one source into its target in checkpointed pages. A complete
 * checkpoint replays without writing; a pending one resumes after proving
 * the sealed prefix reproduces its chain and the target holds exactly that
 * many rows.
 */
async function importSource({ handle, stage, source, disposition, maxRows, maxBytes, onPage, sealed, constants = [] }) {
  const item = source.item;
  const schema = handle.primarySchema;
  const name = `table:${item.name}`;
  const checkpoint = await readImportCheckpoint(handle, stage, name);
  const present = () => withTransferTransaction(handle, "primary",
    client => targetCount(client, schema, item.target, constants), { readOnly: true });
  if (checkpoint?.state === "complete") return { pages: 0 };
  let committed = checkpoint?.rowCount ?? 0;
  let chain = checkpoint?.prefixChainSha256 ?? EMPTY_PREFIX_CHAIN;
  let after = null;
  if (committed > 0) {
    const prefix = sourcePrefix(source, committed, maxRows);
    if (prefix.chain !== chain) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: item.name });
    after = prefix.after;
  }
  if (await present() !== committed) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: item.target });
  await sealed.verify();
  let pages = 0;
  for (;;) {
    const page = pageOf(source, after, maxRows, maxBytes);
    if (page.length === 0) break;
    let nextChain = chain;
    for (const row of page) nextChain = advancePrefixChain(nextChain, row.values);
    const expectedPrior = committed;
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      const current = await readCheckpoint(client, handle, { stage, name });
      if ((current?.rowCount ?? 0) !== expectedPrior) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: item.name });
      if (expectedPrior === 0) {
        await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: item.name, disposition,
          targetTable: item.target, state: "started" });
      }
      await recordCheckpoint(client, handle, { stage, name, state: "pending",
        rowCount: expectedPrior + page.length, prefixChainSha256: nextChain });
      const suppress = Object.keys(item.suppress);
      const write = () => insertPage(client, schema, item, page, constants);
      if (suppress.length > 0) await withTriggerPolicy(client, { schema, table: item.target, suppress }, write);
      else await write();
    });
    committed += page.length;
    chain = nextChain;
    after = page.at(-1).key;
    pages += 1;
    await onPage?.({ table: item.name, page: pages, rows: page.length });
  }
  return { pages };
}

async function completeSource({ handle, stage, source, facts, receiptSource = facts, disposition, constants = [] }) {
  const item = source.item;
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    const target = await targetFacts(client, handle.primarySchema, item, constants);
    if (target.rows !== facts.rows || target.sha256 !== facts.sha256) {
      fail("CUTOVER_LEGACY_TABLE_DIGEST_MISMATCH", { table: item.target });
    }
    await recordCheckpoint(client, handle, { stage, name: `table:${item.name}`, state: "complete",
      rowCount: facts.rows, prefixChainSha256: facts.chain });
    await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: item.name, disposition,
      targetTable: item.target, state: "complete", sourceRowCount: receiptSource.rows, sourceSha256: receiptSource.sha256,
      targetRowCount: target.rows, targetSha256: target.sha256 });
    return Object.freeze({ sourceRows: receiptSource.rows, targetRows: target.rows, bytes: facts.bytes,
      sha256: facts.sha256 });
  });
}

// ---------------------------------------------------------------------------
// Shared argument and target checks.

function validatePaging(pageRows, pageBytes, onPage) {
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > LEGACY_TRANSFER_MAX_PAGE_ROWS
      || !Number.isSafeInteger(pageBytes) || pageBytes < 1024 || pageBytes > LEGACY_TRANSFER_MAX_PAGE_BYTES
      || (onPage !== null && typeof onPage !== "function")) {
    fail("CUTOVER_LEGACY_ARGUMENT_INVALID");
  }
}

function validateHandle(handle) {
  if (handle === null || typeof handle !== "object" || typeof handle.sealManifestSha256 !== "string") {
    fail("CUTOVER_LEGACY_ARGUMENT_INVALID");
  }
}

async function transferSession(client) {
  const { rows } = await q(client, "SELECT storage_journal_transfer_session() AS transfer");
  if (rows[0]?.transfer !== true) fail("CUTOVER_TRANSFER_SESSION_REQUIRED");
}

async function relationPresent(client, schema, table) {
  const { rows } = await q(client, "SELECT to_regclass($1) IS NOT NULL AS present", [`${quote(schema)}.${quote(table)}`], table);
  return rows[0]?.present === true;
}

async function withSealed(handle, sealManifestPath, fn) {
  const seal = await readCutoverSeal({ manifestPath: sealManifestPath, expectedSealId: handle.sealManifestSha256 });
  const sealed = await openSealedSourceFromSeal(seal, "ingestion");
  try {
    await sealed.verify();
    return await fn(seal, sealed, sealed.database());
  } catch (error) {
    if (error instanceof LegacyContributionTransferError || error instanceof PostgresTransferTargetError
        || error instanceof CutoverSourceError) {
      throw error;
    }
    return fail("CUTOVER_LEGACY_TRANSFER_FAILED");
  } finally {
    sealed.close();
  }
}

function emptyDigest() {
  return createRowsDigest().digest();
}

// ---------------------------------------------------------------------------
// Stage 'legacy-contributions' (N-V0X).

/**
 * Import the sealed v0.x history. `onPage` is a test hook called after each
 * committed page.
 */
export async function runLegacyContributionsProduction({
  handle,
  sealManifestPath,
  pageRows = LEGACY_TRANSFER_MAX_PAGE_ROWS,
  pageBytes = LEGACY_TRANSFER_MAX_PAGE_BYTES,
  onPage = null,
} = {}) {
  validatePaging(pageRows, pageBytes, onPage);
  validateHandle(handle);
  return withSealed(handle, sealManifestPath, async (seal, sealed, database) => {
    const stage = LEGACY_CONTRIBUTIONS_STAGE;
    const disposition = LEGACY_TRANSFER_DISPOSITIONS.telemetry_contributions.token;
    // Preflight: everything that can refuse, before the first write.
    for (const item of LEGACY_SPECS) assertSourceColumnMap(database, item.name, item.columns.map(column => column.source));
    for (const table of LEGACY_MUST_BE_EMPTY) {
      if (!sourceTablePresent(database, table)) fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
      if (sourceCount(database, table) !== 0) fail("CUTOVER_TABLE_TARGET_MISSING", { table });
    }
    const sources = LEGACY_SPECS.map(item => tableSource(database, item));
    const facts = new Map(sources.map(source => [source.item.name, sourceFacts(source, pageRows)]));
    const sequence = sealedRecordSequence(database);
    const coverage = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await assertStageComplete(handle, "identity-authority", client);
      await transferSession(client);
      const policy = await assertTriggerPolicyCoverage(client, handle.primarySchema, policySubset(LEGACY_CONTRIBUTIONS_ORDER));
      for (const item of LEGACY_SPECS) await assertTargetLayout(client, handle.primarySchema, item);
      return policy;
    }, { readOnly: true });
    await sealed.verify();

    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await stageReceipt(client, handle, { stage, state: "started" });
    });
    const tables = {};
    const pages = {};
    for (const source of sources) {
      const imported = await importSource({ handle, stage, source, disposition, maxRows: pageRows, maxBytes: pageBytes,
        onPage, sealed });
      pages[source.item.name] = imported.pages;
      tables[source.item.name] = await completeSource({ handle, stage, source, facts: facts.get(source.item.name),
        disposition });
    }
    await sealed.verify();

    const empty = emptyDigest();
    const summary = {
      schema: LEGACY_CONTRIBUTION_TRANSFER_SCHEMA,
      stage,
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: legacyContributionPolicySha256(),
      tables: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, { rows: table.sourceRows, sha256: table.sha256 }])),
      mustBeEmpty: Object.fromEntries(LEGACY_MUST_BE_EMPTY.map(table => [table, { rows: 0, sha256: empty }])),
    };
    const receiptSha256 = HASH(JSON.stringify(summary));
    const rowCount = Object.values(tables).reduce((total, table) => total + table.sourceRows, 0);
    const byteCount = Object.values(tables).reduce((total, table) => total + table.bytes, 0);
    const highWater = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const table of LEGACY_MUST_BE_EMPTY) {
        await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: table,
          disposition: LEGACY_TRANSFER_DISPOSITIONS[table].token, state: "complete", sourceRowCount: 0, sourceSha256: empty });
      }
      const applied = await applyIdentityHighWater(client, handle, {
        sealedSequences: await highWaterSequences(client, handle.primarySchema,
          sequence === null ? {} : { telemetry_records: Number(sequence) }),
      });
      for (const item of LEGACY_SPECS) {
        const columns = item.columns.filter(column => column.type.startsWith("instant")).map(column => column.target);
        if (columns.length > 0) await assertInstantRoundTrip(client, { schema: handle.primarySchema, table: item.target, columns });
      }
      await stageReceipt(client, handle, { stage, state: "complete", rowCount, byteCount, receiptSha256 });
      return applied.filter(row => row.table === "telemetry_records")
        .map(row => Object.freeze({ table: row.table, highWater: row.highWater }));
    });
    await sealed.verify();
    return Object.freeze({
      schema: LEGACY_CONTRIBUTION_TRANSFER_SCHEMA,
      stage,
      transferId: productionTransferId(stage, seal.manifest.sealId),
      sealId: seal.manifest.sealId,
      policySha256: summary.policySha256,
      receiptSha256,
      order: LEGACY_CONTRIBUTIONS_ORDER,
      tables: Object.freeze(tables),
      pages: Object.freeze(pages),
      mustBeEmpty: Object.freeze(summary.mustBeEmpty),
      highWater: Object.freeze(highWater),
      triggerPolicy: coverage,
      rowCount,
      byteCount,
    });
  });
}

/**
 * The sealed AUTOINCREMENT counter of telemetry_records, or null when the seal
 * has none. sqlite_sequence.seq is untyped: SQLite writes INTEGER, a restored
 * copy may hold an integral REAL (as PT-3 reads it). Anything else refuses.
 */
function sealedRecordSequence(database) {
  if (!sourceTablePresent(database, "sqlite_sequence")) return null;
  const rows = sourceAll(database, "SELECT seq FROM sqlite_sequence WHERE name = 'telemetry_records'", [], "sqlite_sequence");
  if (rows.length === 0) return null;
  const value = rows[0].seq;
  const seq = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : -1n;
  if (rows.length !== 1 || seq < 0n || seq > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUTOVER_SOURCE_VALUE_INVALID", { table: "sqlite_sequence" });
  }
  return seq;
}

async function highWaterSequences(client, schema, sealed) {
  const { rows } = await q(client, `SELECT DISTINCT c.relname::text AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
     ORDER BY 1`, [schema]);
  return Object.fromEntries(rows.map(({ table_name: table }) => [table, Object.hasOwn(sealed, table) ? sealed[table] : null]));
}

// ---------------------------------------------------------------------------
// Stage 'pending-registrations' and the E-PT4 transfer holds.

function validateOwnerFlags(ownerFlags) {
  if (!Array.isArray(ownerFlags) || new Set(ownerFlags).size !== ownerFlags.length
      || ownerFlags.some(flag => flag !== OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING)) {
    fail("CUTOVER_LEGACY_ARGUMENT_INVALID");
  }
  return ownerFlags;
}

async function holdGuardState(client, schema) {
  if (!await relationPresent(client, schema, PENDING_OBJECT_TRANSFER_HOLD_TABLE)) return "absent";
  const { rows } = await q(client, `SELECT t.tgenabled::text AS enabled,
        p.proname::text AS function_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal`,
  [schema, PENDING_OBJECT_TRANSFER_HOLD_TABLE, PENDING_OBJECT_TRANSFER_HOLD_GUARD], PENDING_OBJECT_TRANSFER_HOLD_TABLE);
  if (rows.length !== 1 || rows[0].enabled !== "O" || rows[0].function_name !== PENDING_OBJECT_TRANSFER_HOLD_GUARD) {
    return "invalid";
  }
  return "present";
}

function guardMode(state, ownerFlags) {
  if (state === "present") return "transfer-holds-v1";
  if (state === "absent" && ownerFlags.includes(OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING)) {
    return "owner-accepted-clearing";
  }
  return fail("CUTOVER_PENDING_OBJECT_GUARD_MISSING", { table: PENDING_OBJECT_TRANSFER_HOLD_TABLE });
}

/**
 * PT-8-lite preflight P13, read-only and runnable before beginRun: the E-PT4
 * transfer-hold guard (table and enabled guard trigger) is present, or the
 * owner recorded accept-orphan-registration-clearing. A present but altered
 * guard is never excused by the flag.
 */
export async function checkPendingObjectTransferGuard(handle, { ownerFlags = [] } = {}) {
  validateHandle(handle);
  validateOwnerFlags(ownerFlags);
  const state = await withTransferTransaction(handle, "primary",
    client => holdGuardState(client, handle.primarySchema), { readOnly: true });
  return Object.freeze({ check: "P13", guard: guardMode(state, ownerFlags), holdTable: state });
}

const PENDING_KINDS = new Map([["synthetic", "synthetic/"], ["telemetry", "telemetry/"]]);

/** The D1 CHECKs of pending_quarantine_objects, re-asserted on each sealed row before any write. */
function assertPendingRow(row) {
  const [key, contributionId, kind, , state, lease] = row.values;
  const prefix = PENDING_KINDS.get(kind);
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_OBJECT_KEY || /[\u0000-\u001f\u007f]/u.test(key)
      || prefix === undefined || !key.startsWith(prefix)
      || typeof contributionId !== "string" || contributionId.length === 0 || contributionId.length > 200
      || !((state === "registered" && lease === null) || (state === "deleting" && typeof lease === "string" && lease.length > 0))) {
    fail("CUTOVER_SOURCE_VALUE_INVALID", { table: PENDING_SOURCE.name });
  }
}

const SEALED_TELEMETRY_KIND = "telemetry";

/**
 * The family of each chunk-owned registration on a page: contribution id ->
 * { key, kind } for every sealed 'telemetry' registration whose contribution
 * id is a sealed chunk's id (CHUNK_REGISTRATION_FAMILIES, shared with D-PT5A).
 */
function chunkFamilies(database, page) {
  const ids = page.filter(row => row.values[2] === SEALED_TELEMETRY_KIND).map(row => row.values[1]);
  const families = new Map();
  if (ids.length === 0) return families;
  const marks = ids.map(() => "?").join(", ");
  for (const [chunkTable, kind] of CHUNK_REGISTRATION_FAMILIES) {
    for (const chunk of sourceAll(database, `SELECT id, r2_key FROM ${quote(chunkTable)} WHERE id IN (${marks})`, ids, chunkTable)) {
      if (families.has(chunk.id)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table: PENDING_SOURCE.name });
      families.set(chunk.id, { key: chunk.r2_key, kind });
    }
  }
  return families;
}

/**
 * The sealed registrations, each re-asserted against D1's CHECKs and mapped:
 * verbatim, except that a chunk-owned one takes its family's PostgreSQL kind
 * (the reviewed T-0 mapping D-PT5A's chunk stages applied to the rows they
 * wrote). A chunk-owned registration under another object key refuses; the
 * telemetry stages, which are prerequisites, already refuse it.
 */
function pendingSource(database) {
  const base = tableSource(database, PENDING_SOURCE);
  return Object.freeze({
    item: PENDING_SOURCE,
    page(after, limit) {
      const page = base.page(after, limit);
      for (const row of page) assertPendingRow(row);
      const families = chunkFamilies(database, page);
      return page.map(row => {
        const family = families.get(row.values[1]);
        if (family === undefined) return row;
        if (family.key !== row.values[0]) fail("CUTOVER_SOURCE_VALUE_INVALID", { table: PENDING_SOURCE.name });
        const values = [...row.values];
        const parameters = [...row.parameters];
        values[2] = family.kind;
        parameters[2] = family.kind;
        return { ...row, values, parameters,
          size: row.size - Buffer.byteLength(SEALED_TELEMETRY_KIND) + Buffer.byteLength(family.kind) };
      });
    },
  });
}

const PENDING_COLUMNS = PENDING_SOURCE.columns.map(column => quote(column.target)).join(", ");

async function writePendingPage(client, handle, page, holds) {
  const schema = handle.primarySchema;
  const keys = page.map(row => row.parameters[0]);
  const contributions = page.map(row => row.parameters[1]);
  const { rows: existing } = await q(client, `SELECT ${PENDING_SOURCE.columns.map(column =>
      `${targetExpression(column)} AS ${quote(column.target)}`).join(", ")}
      FROM ${quote(schema)}."pending_objects" WHERE object_key = ANY($1::text[]) OR contribution_id = ANY($2::text[])`,
  [keys, contributions], "pending_objects");
  const byKey = new Map(existing.map(row => [row.object_key, row]));
  const missing = [];
  let premapped = 0;
  for (const row of page) {
    const present = byKey.get(row.parameters[0]);
    if (present === undefined) {
      missing.push(row);
      continue;
    }
    const values = PENDING_SOURCE.columns.map(column =>
      targetValue(column.type, present[column.target], "pending_objects", column.target));
    if (JSON.stringify(values) !== JSON.stringify(row.values)) fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: "pending_objects" });
    premapped += 1;
  }
  // A row keyed by a sealed contribution id under another object key collides.
  if (existing.length !== premapped) fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: "pending_objects" });
  if (missing.length > 0) {
    const width = PENDING_SOURCE.columns.length;
    const values = missing.map((_, rowIndex) => `(${Array.from({ length: width }, (__, columnIndex) =>
      `$${rowIndex * width + columnIndex + 1}`).join(", ")})`).join(", ");
    const result = await q(client, `INSERT INTO ${quote(schema)}."pending_objects" (${PENDING_COLUMNS}) VALUES ${values}
      ON CONFLICT DO NOTHING RETURNING object_key`, missing.flatMap(row => row.parameters), "pending_objects");
    if (result.rows.length !== missing.length) fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: "pending_objects" });
  }
  if (holds) {
    const result = await q(client, `INSERT INTO ${quote(schema)}.${quote(PENDING_OBJECT_TRANSFER_HOLD_TABLE)}
        (object_key, contribution_id, seal_sha256)
      SELECT key, contribution, $3 FROM unnest($1::text[], $2::text[]) AS sealed(key, contribution)
      ON CONFLICT DO NOTHING RETURNING object_key`, [keys, contributions, handle.sealManifestSha256],
    PENDING_OBJECT_TRANSFER_HOLD_TABLE);
    if (result.rows.length !== page.length) fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: PENDING_OBJECT_TRANSFER_HOLD_TABLE });
  }
  return { premapped, inserted: missing.length };
}

/** Digest of every hold, in sealed key order: [object_key, contribution_id, seal_sha256, released]. */
async function holdFacts(client, schema) {
  const digest = createRowsDigest();
  let rows = 0;
  let after = null;
  for (;;) {
    const values = after === null ? [] : [after];
    const where = after === null ? "" : ` WHERE object_key COLLATE "C" > $1::text COLLATE "C"`;
    const result = await q(client, `SELECT object_key, contribution_id, seal_sha256, released_at IS NOT NULL AS released
        FROM ${quote(schema)}.${quote(PENDING_OBJECT_TRANSFER_HOLD_TABLE)}${where}
       ORDER BY object_key COLLATE "C" LIMIT ${TARGET_PAGE_ROWS}`, values, PENDING_OBJECT_TRANSFER_HOLD_TABLE);
    for (const row of result.rows) {
      digest.update([row.object_key, row.contribution_id, row.seal_sha256, row.released]);
      rows += 1;
    }
    if (result.rows.length < TARGET_PAGE_ROWS) break;
    after = result.rows.at(-1).object_key;
  }
  return Object.freeze({ rows, sha256: digest.digest() });
}

function expectedHoldFacts(source, sealId, maxRows) {
  const digest = createRowsDigest();
  let rows = 0;
  let after = null;
  for (;;) {
    const page = source.page(after, maxRows);
    for (const row of page) {
      digest.update([row.values[0], row.values[1], sealId, false]);
      rows += 1;
      after = row.key;
    }
    if (page.length < maxRows) break;
  }
  return Object.freeze({ rows, sha256: digest.digest() });
}

/**
 * Map every sealed pending_quarantine_objects row into pending_objects with
 * its transfer hold. `ownerFlags` may carry accept-orphan-registration-
 * clearing, which is honoured only when the hold table is absent.
 */
export async function runPendingRegistrationsProduction({
  handle,
  sealManifestPath,
  ownerFlags = [],
  pageRows = LEGACY_TRANSFER_MAX_PAGE_ROWS,
  pageBytes = LEGACY_TRANSFER_MAX_PAGE_BYTES,
  onPage = null,
} = {}) {
  validatePaging(pageRows, pageBytes, onPage);
  validateHandle(handle);
  validateOwnerFlags(ownerFlags);
  return withSealed(handle, sealManifestPath, async (seal, sealed, database) => {
    const stage = PENDING_REGISTRATIONS_STAGE;
    const disposition = LEGACY_TRANSFER_DISPOSITIONS.pending_quarantine_objects.token;
    const schema = handle.primarySchema;
    assertSourceColumnMap(database, PENDING_SOURCE.name, PENDING_SOURCE.columns.map(column => column.source));
    const source = pendingSource(database);
    const facts = sourceFacts(source, pageRows);
    const holdsExpected = expectedHoldFacts(source, seal.manifest.sealId, pageRows);
    const preflight = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const prerequisite of PENDING_REGISTRATIONS_PREREQUISITE_STAGES) {
        await assertStageComplete(handle, prerequisite, client);
      }
      if (await targetCount(client, schema, "pending_quarantine_objects") !== 0) {
        fail("CUTOVER_PENDING_QUARANTINE_TARGET_NOT_EMPTY", { table: "pending_quarantine_objects" });
      }
      const mode = guardMode(await holdGuardState(client, schema), ownerFlags);
      const tables = mode === "transfer-holds-v1" ? ["pending_objects", PENDING_OBJECT_TRANSFER_HOLD_TABLE] : ["pending_objects"];
      const policy = await assertTriggerPolicyCoverage(client, schema, policySubset(tables));
      await assertTargetLayout(client, schema, PENDING_SOURCE);
      return { mode, policy };
    }, { readOnly: true });
    const holds = preflight.mode === "transfer-holds-v1";
    await sealed.verify();

    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await stageReceipt(client, handle, { stage, state: "started" });
    });
    const name = `table:${PENDING_SOURCE.name}`;
    const checkpoint = await readImportCheckpoint(handle, stage, name);
    let pages = 0;
    let premapped = 0;
    let inserted = 0;
    if (checkpoint?.state !== "complete") {
      let committed = checkpoint?.rowCount ?? 0;
      let chain = checkpoint?.prefixChainSha256 ?? EMPTY_PREFIX_CHAIN;
      let after = null;
      if (committed > 0) {
        const prefix = sourcePrefix(source, committed, pageRows);
        if (prefix.chain !== chain) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: PENDING_SOURCE.name });
        after = prefix.after;
      }
      await sealed.verify();
      for (;;) {
        const page = pageOf(source, after, pageRows, pageBytes);
        if (page.length === 0) break;
        let nextChain = chain;
        for (const row of page) nextChain = advancePrefixChain(nextChain, row.values);
        const expectedPrior = committed;
        const written = await withTransferTransaction(handle, "primary", async client => {
          await requireImportingRun(client, handle);
          const current = await readCheckpoint(client, handle, { stage, name });
          if ((current?.rowCount ?? 0) !== expectedPrior) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: PENDING_SOURCE.name });
          if (expectedPrior === 0) {
            await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: PENDING_SOURCE.name,
              disposition, targetTable: PENDING_SOURCE.target, state: "started" });
          }
          await recordCheckpoint(client, handle, { stage, name, state: "pending",
            rowCount: expectedPrior + page.length, prefixChainSha256: nextChain });
          return writePendingPage(client, handle, page, holds);
        });
        premapped += written.premapped;
        inserted += written.inserted;
        committed += page.length;
        chain = nextChain;
        after = page.at(-1).key;
        pages += 1;
        await onPage?.({ table: PENDING_SOURCE.name, page: pages, rows: page.length });
      }
    }
    await sealed.verify();

    const summary = {
      schema: LEGACY_CONTRIBUTION_TRANSFER_SCHEMA,
      stage,
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: legacyContributionPolicySha256(),
      registrations: { rows: facts.rows, sha256: facts.sha256 },
      guard: preflight.mode,
      holds: holds ? { rows: holdsExpected.rows, sha256: holdsExpected.sha256 } : null,
    };
    const receiptSha256 = HASH(JSON.stringify(summary));
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      // The mapping proof: pending_objects holds exactly the sealed set (no
      // extra, missing or different row), and pending_quarantine_objects is empty.
      const target = await targetFacts(client, schema, PENDING_SOURCE);
      if (target.rows !== facts.rows || target.sha256 !== facts.sha256) {
        fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: "pending_objects" });
      }
      if (await targetCount(client, schema, "pending_quarantine_objects") !== 0) {
        fail("CUTOVER_PENDING_QUARANTINE_TARGET_NOT_EMPTY", { table: "pending_quarantine_objects" });
      }
      if (holds) {
        const held = await holdFacts(client, schema);
        if (held.rows !== holdsExpected.rows || held.sha256 !== holdsExpected.sha256) {
          fail("CUTOVER_PENDING_OBJECT_CONFLICT", { table: PENDING_OBJECT_TRANSFER_HOLD_TABLE });
        }
      }
      await assertInstantRoundTrip(client, { schema, table: "pending_objects", columns: ["registered_at"] });
      await recordCheckpoint(client, handle, { stage, name, state: "complete", rowCount: facts.rows,
        prefixChainSha256: facts.chain });
      await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: PENDING_SOURCE.name,
        disposition, targetTable: PENDING_SOURCE.target, state: "complete", sourceRowCount: facts.rows,
        sourceSha256: facts.sha256, targetRowCount: target.rows, targetSha256: target.sha256 });
      await stageReceipt(client, handle, { stage, state: "complete", rowCount: facts.rows, byteCount: facts.bytes,
        receiptSha256 });
    });
    await sealed.verify();
    return Object.freeze({
      schema: LEGACY_CONTRIBUTION_TRANSFER_SCHEMA,
      stage,
      transferId: productionTransferId(stage, seal.manifest.sealId),
      sealId: seal.manifest.sealId,
      policySha256: summary.policySha256,
      receiptSha256,
      registrations: Object.freeze({ rows: facts.rows, sha256: facts.sha256 }),
      // Informational only (not in the receipt digest), for this invocation:
      // rows a telemetry stage had already mapped (verified equal) and rows
      // this stage inserted. A replay reports 0 and 0.
      premapped,
      inserted,
      guard: preflight.mode,
      holds: summary.holds === null ? null : Object.freeze(summary.holds),
      pages,
      triggerPolicy: preflight.policy,
    });
  });
}

// ---------------------------------------------------------------------------
// N-ADMINHIST and N-EXCL (table receipts under 'post-import').

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/**
 * A gauge snapshot is a flat JSON object of at most 128 gauges, each a
 * structural name and a non-negative safe integer: aggregate counts only.
 */
function validGaugeMetrics(metrics) {
  const object = plainObject(metrics);
  if (object === null) return false;
  const entries = Object.entries(object);
  return entries.length <= MAX_GAUGES
    && entries.every(([key, value]) => GAUGE_KEY.test(key) && Number.isSafeInteger(value) && value >= 0);
}

function snapshotRow(capturedAt, metricsJson) {
  return { values: [capturedAt, metricsJson], parameters: [capturedAt, metricsJson],
    size: Buffer.byteLength(capturedAt) + Buffer.byteLength(metricsJson) };
}

function sealedSourceId(database) {
  if (!sourceTablePresent(database, "storage_source_state")) fail("CUTOVER_SOURCE_TABLE_MISSING", { table: "storage_source_state" });
  const rows = sourceAll(database, "SELECT singleton, source_id FROM storage_source_state", [], "storage_source_state");
  if (rows.length !== 1 || rows[0].singleton !== 1n || typeof rows[0].source_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(rows[0].source_id)) {
    fail("CUTOVER_SOURCE_SINGLETON_INVALID", { table: "storage_source_state" });
  }
  return rows[0].source_id;
}

/**
 * The snapshots to map: every sealed admin_metric_snapshots row (a canonical
 * instant key and a valid gauge object, verbatim text), plus each snapshot
 * that only the cached history payload still carries. An invalid or absent
 * cache contributes nothing and is reported as such.
 */
function adminSnapshotPlan(database, pageRows) {
  assertSourceColumnMap(database, ADMIN_SNAPSHOTS.name, ADMIN_SNAPSHOTS.columns.map(column => column.source));
  assertSourceColumnMap(database, "admin_metrics_history_cache", [...ADMIN_CACHE_COLUMNS]);
  const sealedSource = tableSource(database, ADMIN_SNAPSHOTS);
  const rows = [];
  const captured = new Set();
  let after = null;
  for (;;) {
    const page = sealedSource.page(after, pageRows);
    for (const row of page) {
      const [capturedAt, metricsJson] = row.values;
      let metrics;
      try {
        metrics = JSON.parse(metricsJson);
      } catch {
        metrics = null;
      }
      if (metricsJson.length > MAX_SNAPSHOT_JSON || !validGaugeMetrics(metrics)) {
        fail("CUTOVER_SOURCE_VALUE_INVALID", { table: ADMIN_SNAPSHOTS.name, column: "metrics_json" });
      }
      rows.push(snapshotRow(capturedAt, metricsJson));
      captured.add(capturedAt);
      after = row.key;
    }
    if (page.length < pageRows) break;
  }
  const sealedFacts = sourceFacts(sealedSource, pageRows);
  const cacheRows = sourceAll(database, "SELECT singleton, generated_at, payload_json FROM admin_metrics_history_cache",
    [], "admin_metrics_history_cache");
  const cacheDigest = createRowsDigest();
  let cacheState = "absent";
  const cacheOnly = [];
  if (cacheRows.length > 1) fail("CUTOVER_SOURCE_SINGLETON_INVALID", { table: "admin_metrics_history_cache" });
  if (cacheRows.length === 1) {
    const row = cacheRows[0];
    if (typeof row.payload_json !== "string" || typeof row.generated_at !== "string" || row.singleton !== 1n) {
      fail("CUTOVER_SOURCE_SINGLETON_INVALID", { table: "admin_metrics_history_cache" });
    }
    cacheDigest.update(["1", row.generated_at, row.payload_json]);
    let payload = null;
    try {
      payload = row.payload_json.length <= MAX_CACHE_JSON ? JSON.parse(row.payload_json) : null;
    } catch {
      payload = null;
    }
    const snapshots = plainObject(plainObject(plainObject(payload)?.gauges))?.snapshots;
    const valid = plainObject(payload)?.schemaVersion === ADMIN_METRICS_HISTORY_SCHEMA_VERSION
      && Array.isArray(snapshots) && snapshots.length <= MAX_CACHE_SNAPSHOTS
      && snapshots.every(entry => plainObject(entry) !== null && Object.keys(entry).sort().join() === "capturedAt,metrics"
        && isCanonicalInstant(entry.capturedAt) && validGaugeMetrics(entry.metrics)
        && JSON.stringify(entry.metrics).length <= MAX_SNAPSHOT_JSON);
    cacheState = valid ? "valid" : "invalid";
    if (valid) {
      for (const entry of snapshots) {
        if (captured.has(entry.capturedAt)) continue;
        captured.add(entry.capturedAt);
        cacheOnly.push(snapshotRow(entry.capturedAt, JSON.stringify(entry.metrics)));
      }
    }
  }
  const all = [...rows, ...cacheOnly].sort((left, right) => (left.values[0] < right.values[0] ? -1 : 1));
  const cacheOnlyDigest = createRowsDigest();
  for (const row of [...cacheOnly].sort((left, right) => (left.values[0] < right.values[0] ? -1 : 1))) {
    cacheOnlyDigest.update(row.values);
  }
  return {
    source: listSource(ADMIN_SNAPSHOTS, all),
    sealedFacts,
    cache: Object.freeze({ state: cacheState, rows: cacheRows.length, sha256: cacheDigest.digest(),
      snapshotsAdded: cacheOnly.length, snapshotsAddedSha256: cacheOnlyDigest.digest() }),
  };
}

/**
 * Map the admin metric history (N-ADMINHIST) and import the aggregate
 * exclusions (N-EXCL). Writes table receipts under 'post-import' and no stage
 * receipt: PT-8-lite folds the returned receiptSha256 into its post-import
 * receipt. Needs 'identity-authority' complete; replays without writing.
 */
export async function runOperationalHistoryProduction({
  handle,
  sealManifestPath,
  pageRows = LEGACY_TRANSFER_MAX_PAGE_ROWS,
  pageBytes = LEGACY_TRANSFER_MAX_PAGE_BYTES,
  onPage = null,
} = {}) {
  validatePaging(pageRows, pageBytes, onPage);
  validateHandle(handle);
  return withSealed(handle, sealManifestPath, async (seal, sealed, database) => {
    const stage = OPERATIONAL_HISTORY_STAGE;
    const schema = handle.primarySchema;
    const sourceId = sealedSourceId(database);
    const constants = [["source_id", sourceId]];
    const admin = adminSnapshotPlan(database, pageRows);
    const adminFacts = sourceFacts(admin.source, pageRows);
    assertSourceColumnMap(database, EXCLUSIONS.name, EXCLUSIONS.columns.map(column => column.source));
    const exclusionSource = tableSource(database, EXCLUSIONS);
    const exclusionFacts = sourceFacts(exclusionSource, pageRows);
    const exclusionAll = sourceFacts(tableSource(database, { ...EXCLUSIONS, where: null }), pageRows);
    const preflight = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await assertStageComplete(handle, "identity-authority", client);
      if (await relationPresent(client, schema, "storage_source_state")) {
        const { rows } = await q(client, `SELECT source_id FROM ${quote(schema)}."storage_source_state"`, [], "storage_source_state");
        if (rows.some(row => row.source_id !== sourceId)) fail("CUTOVER_SOURCE_IDENTITY_MISMATCH", { table: "storage_source_state" });
      }
      if (!await relationPresent(client, schema, EXCLUSIONS.target)) fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: EXCLUSIONS.target });
      const policy = await assertTriggerPolicyCoverage(client, schema,
        policySubset(["analytics_admin_metric_snapshots", "community_aggregate_exclusions"]));
      await assertTargetLayout(client, schema, ADMIN_SNAPSHOTS, constants);
      await assertTargetLayout(client, schema, EXCLUSIONS);
      return policy;
    }, { readOnly: true });
    await sealed.verify();

    const adminDisposition = LEGACY_TRANSFER_DISPOSITIONS.admin_metric_snapshots.token;
    const exclusionDisposition = LEGACY_TRANSFER_DISPOSITIONS.community_aggregate_exclusions.token;
    const adminPages = await importSource({ handle, stage, source: admin.source, disposition: adminDisposition,
      maxRows: pageRows, maxBytes: pageBytes, onPage, sealed, constants });
    const adminTable = await completeSource({ handle, stage, source: admin.source, facts: adminFacts,
      receiptSource: admin.sealedFacts, disposition: adminDisposition, constants });
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: "admin_metrics_history_cache",
        disposition: LEGACY_TRANSFER_DISPOSITIONS.admin_metrics_history_cache.token,
        targetTable: "analytics_admin_metric_snapshots", state: "complete", sourceRowCount: admin.cache.rows,
        sourceSha256: admin.cache.sha256, targetRowCount: admin.cache.snapshotsAdded,
        targetSha256: admin.cache.snapshotsAddedSha256 });
    });
    const exclusionPages = await importSource({ handle, stage, source: exclusionSource, disposition: exclusionDisposition,
      maxRows: pageRows, maxBytes: pageBytes, onPage, sealed });
    const exclusionTable = await completeSource({ handle, stage, source: exclusionSource, facts: exclusionFacts,
      receiptSource: exclusionAll, disposition: exclusionDisposition });
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await assertInstantRoundTrip(client, { schema, table: "analytics_admin_metric_snapshots", columns: ["captured_at"] });
      await assertInstantRoundTrip(client, { schema, table: EXCLUSIONS.target,
        columns: ["effective_at", "expires_at", "created_at", "revoked_at"] });
    }, { readOnly: true });
    await sealed.verify();

    const summary = {
      schema: LEGACY_CONTRIBUTION_TRANSFER_SCHEMA,
      stage,
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: legacyContributionPolicySha256(),
      adminMetricHistory: {
        sourceIdSha256: HASH(sourceId),
        sealedSnapshots: { rows: admin.sealedFacts.rows, sha256: admin.sealedFacts.sha256 },
        cache: { state: admin.cache.state, rows: admin.cache.rows, sha256: admin.cache.sha256,
          snapshotsAdded: admin.cache.snapshotsAdded, snapshotsAddedSha256: admin.cache.snapshotsAddedSha256 },
        mapped: { rows: adminTable.targetRows, sha256: adminFacts.sha256 },
      },
      exclusions: {
        sealed: { rows: exclusionAll.rows, sha256: exclusionAll.sha256 },
        imported: { rows: exclusionTable.targetRows, sha256: exclusionFacts.sha256 },
        participantAbsent: exclusionAll.rows - exclusionFacts.rows,
      },
    };
    const receiptSha256 = HASH(JSON.stringify(summary));
    return Object.freeze({
      ...summary,
      adminMetricHistory: Object.freeze(summary.adminMetricHistory),
      exclusions: Object.freeze(summary.exclusions),
      receiptSha256,
      pages: Object.freeze({ admin_metric_snapshots: adminPages.pages, community_aggregate_exclusions: exclusionPages.pages }),
      triggerPolicy: preflight,
    });
  });
}
