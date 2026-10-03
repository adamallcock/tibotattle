// PT-8-lite coverage and policy (PT8-A of design/pt8-lite-design-2026-10-02.md
// section 3 and 4): one disposition per sealed table, the closed stage plan,
// the waivable stages, the merged trigger policy and the staging registry
// every importer of the Cloudflare -> GCP cutover contributes.
//
// The dispositions are not restated where an importer already owns them:
//   * PT-3 ('identity-authority'): IDENTITY_AUTHORITY_COLUMN_MAP, the token
//     being exactly what PT-3 writes ('imported:' for an insert, 'mapped:'
//     for the controls, the bootstrap and the merged seeds).
//   * D-PT5A (the eight telemetry stages): TELEMETRY_PRODUCTION_DISPOSITIONS.
//   * D-PT4X (v0.x history, pending registrations, admin metric history and
//     the aggregate exclusions): LEGACY_TRANSFER_DISPOSITIONS.
// This module adds the tables no importer writes. The orchestrator
// (postgres-production-transfer.mjs) writes their table receipts, and the
// coverage finalize then requires exactly one complete receipt, with exactly
// this token and stage, for every sealed table.
//
// Rules, evaluated on the sealed files before any target write:
//   'any'                       no row-count rule;
//   'empty'                     CUTOVER_COVERAGE_NOT_EMPTY (table name and count);
//   'flag:<owner flag>'         non-empty only under that recorded owner flag,
//                               else CUTOVER_COVERAGE_DECISION_MISSING;
//   'no-pending-erasure-jobs'   storage_erasure_jobs holds no 'pending' row,
//                               else CUTOVER_PARTICIPANT_ERASURE_PENDING.
// The sealed catalog of each role must equal the dispositions of that role in
// both directions (CUTOVER_COVERAGE_TABLE_UNKNOWN / _MISSING); the two
// migration ledgers are 'optional' because the inventory's ledger layout
// decides which one a source carries and the seal has already checked them.
//
// Errors carry a closed code and at most a table, stage or flag name and a
// count. No sealed value ever leaves this module.

import { createHash } from "node:crypto";
import providerSchemas from "../src/d1-provider-schema.json" with { type: "json" };
import { CUTOVER_LEDGER_TABLES } from "./cutover-source-seal.mjs";
import {
  IDENTITY_AUTHORITY_COLUMN_MAP,
  IDENTITY_AUTHORITY_STAGE,
  IDENTITY_AUTHORITY_TARGET_MISSING,
  IDENTITY_TRIGGER_POLICY,
} from "./postgres-identity-authority-transfer.mjs";
import {
  LEGACY_TRANSFER_DISPOSITIONS,
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  PRODUCTION_RETAINED_RELATIONS as LEGACY_RETAINED_RELATIONS,
  PRODUCTION_STAGING_RELATIONS as LEGACY_STAGING_RELATIONS,
  TRIGGER_POLICY as LEGACY_TRIGGER_POLICY,
} from "./postgres-legacy-contribution-transfer.mjs";
import {
  PRODUCTION_RETAINED_RELATIONS as TELEMETRY_RETAINED_RELATIONS,
  PRODUCTION_STAGING_RELATIONS as TELEMETRY_STAGING_RELATIONS,
  TELEMETRY_PRODUCTION_DISPOSITIONS,
  TELEMETRY_PRODUCTION_STAGES,
  TRIGGER_POLICY as TELEMETRY_TRIGGER_POLICY,
} from "./postgres-production-telemetry-modes.mjs";
import { TRANSFER_STAGES } from "./postgres-transfer-target.mjs";

export const TRANSFER_COVERAGE_SCHEMA = "tibotattle-pt8-lite-coverage-v1";
export const STAGE_WAIVER_SCHEMA = "tibotattle-pt8-lite-stage-waiver-v1";

export const TRANSFER_COVERAGE_ERROR_CODES = Object.freeze([
  "CUTOVER_COVERAGE_ARGUMENT_INVALID",
  "CUTOVER_COVERAGE_DECISION_MISSING",
  "CUTOVER_COVERAGE_NOT_EMPTY",
  "CUTOVER_COVERAGE_TABLE_MISSING",
  "CUTOVER_COVERAGE_TABLE_UNKNOWN",
  "CUTOVER_PARTICIPANT_ERASURE_PENDING",
  "CUTOVER_STAGE_WAIVER_REFUSED",
]);
const ERROR_CODES = new Set(TRANSFER_COVERAGE_ERROR_CODES);
const SOURCE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HASH = value => createHash("sha256").update(value).digest("hex");

export class TransferCoverageError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      if (typeof details.table === "string" && SOURCE_TABLE.test(details.table)) safe.table = details.table;
      if (typeof details.role === "string" && SOURCE_ROLES.includes(details.role)) safe.role = details.role;
      if (typeof details.stage === "string" && TRANSFER_STAGES.includes(details.stage)) safe.stage = details.stage;
      if (typeof details.flag === "string" && OWNER_FLAGS.includes(details.flag)) safe.flag = details.flag;
      if (Number.isSafeInteger(details.count) && details.count >= 0) safe.count = details.count;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix.length > 0 ? `${code} [${suffix}]` : code);
    this.name = "TransferCoverageError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_COVERAGE_ARGUMENT_INVALID";
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new TransferCoverageError(code, details);
}

/** The sealed source roles PT-8-lite covers (the analytics D1 is never sealed: decision D3). */
export const SOURCE_ROLES = Object.freeze(["ingestion", "deletion-ledger"]);

/** The closed owner flags (design section 3, P13 and P16). */
export const OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED = "performance-routes-retired";
/**
 * REV-SEED (round 14): the run is the dress rehearsal, so P16 and the
 * 'analytics-community-history' stage admit its synthetic revision floor
 * (cutover-revision-floor.mjs synthetic). Without it they admit only a floor
 * the capture took inside this fence, and with it they refuse a captured
 * floor (REVISION_FLOOR_PROVENANCE_REFUSED).
 */
export const OWNER_FLAG_DRESS_REHEARSAL_SYNTHETIC_REVISION_FLOOR = "dress-rehearsal-synthetic-revision-floor";
export const OWNER_FLAGS = Object.freeze([
  OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED,
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  OWNER_FLAG_DRESS_REHEARSAL_SYNTHETIC_REVISION_FLOOR,
]);

// ---------------------------------------------------------------------------
// The stage plan (design section 4): execution order, runner or waiver.

/**
 * The PT-8-lite execution order. Each stage requires every earlier stage of
 * this list to be complete (PT-1 does not order stages, so PT-8 asserts it).
 * kind: 'runner' (an importer writes it), 'orchestrator' (PT-8 writes it
 * itself) or 'waiver' (a closed waiver receipt, section 4).
 */
export const STAGE_PLAN = Object.freeze([
  Object.freeze({ stage: "identity-authority", kind: "runner" }),
  // Round 16: the identity-link pin rotation (a recorded no-op unless the
  // inputs declare a rotation); PT-8 writes its stage and checkpoint receipts.
  Object.freeze({ stage: "identity-link-rotation", kind: "orchestrator" }),
  Object.freeze({ stage: "legacy-contributions", kind: "runner" }),
  Object.freeze({ stage: "telemetry-v1-v11", kind: "runner" }),
  Object.freeze({ stage: "typed-legacy", kind: "runner" }),
  Object.freeze({ stage: "legacy-admission", kind: "runner" }),
  Object.freeze({ stage: "header-promotion", kind: "runner" }),
  Object.freeze({ stage: "telemetry-v12", kind: "runner" }),
  Object.freeze({ stage: "v12-event-sources", kind: "runner" }),
  Object.freeze({ stage: "usage-correction", kind: "runner" }),
  Object.freeze({ stage: "performance", kind: "waiver", reason: "target-missing:performance-routes-retired" }),
  Object.freeze({ stage: "pending-registrations", kind: "runner" }),
  Object.freeze({ stage: "accountless-retention", kind: "waiver", reason: "retention-empty:pt8-g-not-needed" }),
  Object.freeze({ stage: "ingestion-journal", kind: "runner" }),
  Object.freeze({ stage: "owner-lifecycle-verify", kind: "orchestrator" }),
  Object.freeze({ stage: "objects", kind: "waiver", reason: "deferred-post-flip:pt-7" }),
  Object.freeze({ stage: "analytics-expectation", kind: "waiver", reason: "analytics-recomputed:d3" }),
  Object.freeze({ stage: "analytics-history", kind: "waiver", reason: "analytics-recomputed:d3" }),
  // REV-SEED (round 14): Cloudflare's per-day revision floor, loaded before
  // markLive so GCP's publications continue above it
  // (cutover-revision-floor.mjs). The analytics D1 is never sealed, so this
  // stage writes no table receipt; its stage receipt digests the floor.
  Object.freeze({ stage: "analytics-community-history", kind: "runner" }),
  Object.freeze({ stage: "post-import", kind: "orchestrator" }),
]);

/** The closed map of waivable stages and the one reason each admits. */
export const WAIVABLE = Object.freeze(Object.fromEntries(STAGE_PLAN.filter(entry => entry.kind === "waiver")
  .map(entry => [entry.stage, Object.freeze([entry.reason])])));

if (JSON.stringify([...STAGE_PLAN.map(entry => entry.stage)].sort()) !== JSON.stringify([...TRANSFER_STAGES].sort())) {
  throw new TypeError("PT-8-lite stage plan drifted from PT-1's TRANSFER_STAGES");
}
for (const stage of TELEMETRY_PRODUCTION_STAGES) {
  if (STAGE_PLAN.find(entry => entry.stage === stage)?.kind !== "runner") {
    throw new TypeError("a D-PT5A stage is not a runner stage of the plan");
  }
}

/** The plan stages that precede `stage` (every one must be complete before it starts). */
export function stagePrerequisites(stage) {
  const index = STAGE_PLAN.findIndex(entry => entry.stage === stage);
  if (index < 0) fail("CUTOVER_COVERAGE_ARGUMENT_INVALID", { stage });
  return Object.freeze(STAGE_PLAN.slice(0, index).map(entry => entry.stage));
}

// ---------------------------------------------------------------------------
// The dispositions.

function entry(role, table, token, stage, writer, rule = "any", extra = {}) {
  return Object.freeze({ role, table, token, stage, writer, rule, optional: false, ...extra });
}

const identityDispositions = Object.entries(IDENTITY_AUTHORITY_COLUMN_MAP).map(([table, map]) =>
  entry("ingestion", table, `${map.mode === "insert" ? "imported" : "mapped"}:${IDENTITY_AUTHORITY_STAGE}`,
    IDENTITY_AUTHORITY_STAGE, "runner"));
const telemetryDispositions = TELEMETRY_PRODUCTION_DISPOSITIONS.map(item =>
  entry(item.role, item.table, item.token, item.stage, "runner"));
const legacyDispositions = Object.entries(LEGACY_TRANSFER_DISPOSITIONS).map(([table, item]) =>
  entry("ingestion", table, item.token, item.stage, "runner"));

/**
 * The performance tables: no PostgreSQL target (PF-1 is unpromoted). Round 12
 * retires the performance device and consent routes and answers accountless
 * performance authorization with a definite 4xx, so the owner flag
 * 'performance-routes-retired' is the recorded decision that lets a non-empty
 * sealed table be left behind with its count and digest. Two of them are
 * PT-3's IDENTITY_AUTHORITY_TARGET_MISSING tables, which PT-3 does not receipt.
 */
export const PERFORMANCE_TABLES = Object.freeze([
  "telemetry_performance_runtime", "telemetry_performance_buckets", "telemetry_performance_cohorts",
  "telemetry_performance_device_capabilities", "telemetry_performance_receipts", "telemetry_performance_reports",
  "accountless_telemetry_performance_authorizations",
]);
for (const table of IDENTITY_AUTHORITY_TARGET_MISSING) {
  if (!PERFORMANCE_TABLES.includes(table)) throw new TypeError("a PT-3 target-missing table has no performance disposition");
}

/** Analytics-recomputed or lifecycle state: never transferred; the same-name PostgreSQL tables stay at seed. */
export const RUNTIME_RESET_TABLES = Object.freeze([
  "admin_community_allowance_preview_cache", "admin_community_allowance_preview_refresh_state",
  "community_allowance_fit_cache", "community_allowance_publication_state",
  "community_analysis_work", "community_analysis_work_parts", "community_analysis_work_stage",
  "community_current_analysis_queue", "community_current_analysis_queue_state",
  "community_daily_aggregate_rebuilds", "community_daily_aggregates",
  "community_model_composition_cache",
  // Retired in PostgreSQL (0010's shared names): named only as list entries,
  // so the retired-readers guard reads them as inventory, not references.
  "community_model_composition_days",
  "community_model_history_dependencies",
  "community_model_history_results", "community_model_history_work",
  "community_model_history_work_parts", "community_model_history_work_stage",
  "community_preparation_progress_counters",
  "community_prepared_fit_rows", "community_prepared_plan_rows", "community_prepared_source_days",
  "community_prepared_usage_bins", "community_prepared_usage_rows",
  "community_publication_changes", "community_publication_generation", "community_publication_members",
  "community_refresh_lanes", "community_snapshot_builders", "community_weekly_snapshot_rebuilds",
  "community_weekly_snapshots", "telemetry_v1_quota_fit_backfill", "telemetry_v1_quota_fit_rows",
  "community_graph_update_scope", "community_snapshot_mutation_control", "community_snapshot_policy",
  "retention_state", "quarantine_reconciliation_state",
]);

const OWNER_LIFECYCLE = "owner-lifecycle-verify";
const orchestratorDispositions = [
  ...PERFORMANCE_TABLES.map(table => entry("ingestion", table, "target-missing", "performance", "orchestrator",
    `flag:${OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED}`)),
  // PT8-G (a production mode of the accountless retention importer) is not
  // built: a non-empty sealed table refuses before any write.
  entry("ingestion", "accountless_public_history_retention", "must-be-empty", "accountless-retention",
    "orchestrator", "empty"),
  entry("ingestion", "storage_owner_revisions", "verified-equal", OWNER_LIFECYCLE, "orchestrator"),
  // The design's rule is 'any, provably applied in the imported journal'.
  // That proof is not built, so the rule here is the stricter 'empty'.
  entry("ingestion", "storage_legacy_event_sources", `claimed-by:${OWNER_LIFECYCLE}`, OWNER_LIFECYCLE,
    "orchestrator", "empty"),
  ...["storage_legacy_revision_requests", "storage_v11_head_requests", "storage_v12_head_requests"]
    .map(table => entry("ingestion", table, "must-be-empty", OWNER_LIFECYCLE, "orchestrator", "empty")),
  ...RUNTIME_RESET_TABLES.map(table => entry("ingestion", table, "runtime-reset", "post-import", "orchestrator")),
  entry("ingestion", "ingestion_analytics_separation", "schema-marker", "post-import", "orchestrator"),
  ...CUTOVER_LEDGER_TABLES.map(table => entry("ingestion", table, "schema-marker", "post-import", "orchestrator",
    "any", { optional: true })),
  // The flip gate requires zero unexpired sealed nonces.
  entry("ingestion", "sparkle_appcast_guard_nonces", "edge-retained", "post-import", "orchestrator"),
  entry("ingestion", "storage_raw_copy_runs", "source-machinery", "post-import", "orchestrator"),
  entry("ingestion", "storage_raw_copy_pages", "source-machinery", "post-import", "orchestrator"),
  entry("ingestion", "diagnostic_error_events", "not-transferred-expiring", "post-import", "orchestrator"),
  // Decision D2 / OD-4: written only by online erasure, never imported.
  entry("ingestion", "identity_reenrollment_cooldowns", "not-transferred-expiring", "post-import", "orchestrator"),
  // The deletion ledger contributes only its digest projection (decisions D2, D4).
  entry("deletion-ledger", "deletion_tombstones", "target-missing", "post-import", "orchestrator"),
  entry("deletion-ledger", "identity_reenrollment_cooldowns", "not-transferred-expiring", "post-import", "orchestrator"),
  entry("deletion-ledger", "storage_erasure_jobs", "target-missing", "post-import", "orchestrator",
    "no-pending-erasure-jobs"),
  ...CUTOVER_LEDGER_TABLES.map(table => entry("deletion-ledger", table, "schema-marker", "post-import",
    "orchestrator", "any", { optional: true })),
];

/** One disposition per sealed table, keyed `${role}:${table}`. */
export const DISPOSITIONS = Object.freeze([
  ...identityDispositions, ...legacyDispositions, ...telemetryDispositions, ...orchestratorDispositions,
].sort((left, right) => `${left.role}:${left.table}`.localeCompare(`${right.role}:${right.table}`)));
{
  const seen = new Set();
  for (const item of DISPOSITIONS) {
    const key = `${item.role}:${item.table}`;
    if (seen.has(key)) throw new TypeError(`PT-8-lite disposition duplicated: ${key}`);
    seen.add(key);
    if (!TRANSFER_STAGES.includes(item.stage)) throw new TypeError("PT-8-lite disposition names an unknown stage");
    if (!SOURCE_ROLES.includes(item.role)) throw new TypeError("PT-8-lite disposition names an unknown role");
  }
}
export const DISPOSITION_INDEX = Object.freeze(new Map(DISPOSITIONS.map(item => [`${item.role}:${item.table}`, item])));

/**
 * Round 12 retires the native social chain (Google, Apple, legacy enroll) but
 * KEEPS the session-authority ports (session, logout, pairings, claim,
 * devices, revoke, v1.2 consent) and credential renew and disconnect. The
 * tables those routes authenticate against must stay PT-3 imports; the
 * check pins it. None of those routes reads the identity-link pin, the
 * IDENTITY_LINK_SECRET or a link key.
 */
export const KEPT_SESSION_AUTHORITY_TABLES = Object.freeze([
  "participants", "web_sessions", "device_pairings", "device_pairing_events",
  "device_credentials", "device_credential_rotations", "enrollment_grants", "telemetry_v12_device_capabilities",
]);
/**
 * The identity-link pin: imported verbatim by PT-3 as the continuity record
 * of the IDENTITY_LINK_SECRET, and moved to the rotated label only by the
 * 'identity-link-rotation' stage under its token and receipt (round 16). No
 * kept route reads it; only the retired social chain did.
 */
export const IDENTITY_LINK_PIN_TABLE = "identity_link_secret_configuration";
/** Short-lived handoff state of the retired social chain: still imported verbatim by PT-3 and inert after the switch. */
export const RETIRED_SOCIAL_CHAIN_TABLES = Object.freeze([
  "apple_signin_handoffs", "google_signin_handoffs", "sign_in_start_admission_windows",
]);

// ---------------------------------------------------------------------------
// Trigger policy and staging registry.

function mergePolicies(maps) {
  const merged = {};
  for (const map of maps) {
    for (const [table, triggers] of Object.entries(map)) {
      merged[table] ??= {};
      for (const [trigger, policy] of Object.entries(triggers)) {
        const existing = merged[table][trigger];
        if (existing !== undefined && (existing.policy !== policy.policy || existing.reason !== policy.reason)) {
          throw new TypeError(`PT-8-lite trigger policy conflict on ${table}.${trigger}`);
        }
        merged[table][trigger] = policy;
      }
    }
  }
  return Object.freeze(Object.fromEntries(Object.keys(merged).sort()
    .map(table => [table, Object.freeze(merged[table])])));
}

/**
 * The reviewed policy of every target table any stage writes: PT-3, D-PT5A
 * and D-PT4X; waived stages contribute nothing. The analytics history (HX)
 * is excluded (decision D3). Checked with PT-1's assertTriggerPolicyCoverage.
 */
export const COMPLETE_TRIGGER_POLICY = mergePolicies([IDENTITY_TRIGGER_POLICY, TELEMETRY_TRIGGER_POLICY,
  LEGACY_TRIGGER_POLICY]);

/** PT-1 dropTransferStagingRelations registry: the union of every tool's staging relations. */
export const STAGING_DROP_REGISTRY = Object.freeze([...TELEMETRY_STAGING_RELATIONS, ...LEGACY_STAGING_RELATIONS]);
/** PT-1 scrubCheckpointCursors registry: cursor columns of the same staging relations. */
export const STAGING_SCRUB_REGISTRY = Object.freeze([]);
/** Tool relations kept in tibotattle_transfer after verified: none (PT-1's allowlist admits none). */
export const RETAINED_TOOL_RELATIONS = Object.freeze([...TELEMETRY_RETAINED_RELATIONS, ...LEGACY_RETAINED_RELATIONS]);
if (RETAINED_TOOL_RELATIONS.length !== 0 || STAGING_DROP_REGISTRY.length !== 0) {
  // A tool that starts staging or retaining a relation must register it here
  // and PT-1's RETAINED_CONTROL_RELATIONS must admit a retained one; until
  // both are reviewed the orchestrator refuses to load.
  throw new TypeError("a tool declares staging or retained relations PT-8-lite has not reviewed");
}

/** sha256 of the canonical dispositions, rules, flags, stage plan and waivers. */
export function dispositionPolicySha256() {
  return HASH(JSON.stringify([TRANSFER_COVERAGE_SCHEMA, DISPOSITIONS, OWNER_FLAGS, STAGE_PLAN, WAIVABLE,
    KEPT_SESSION_AUTHORITY_TABLES, IDENTITY_LINK_PIN_TABLE, RETIRED_SOCIAL_CHAIN_TABLES, COMPLETE_TRIGGER_POLICY]));
}

// ---------------------------------------------------------------------------
// Sealed evaluation (read-only, before any target write).

function quote(name) {
  if (typeof name !== "string" || !SOURCE_TABLE.test(name)) fail("CUTOVER_COVERAGE_ARGUMENT_INVALID");
  return `"${name}"`;
}

function count(database, sql, table) {
  let row;
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    row = statement.get();
  } catch {
    fail("CUTOVER_COVERAGE_ARGUMENT_INVALID", { table });
  }
  const value = row?.n;
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUTOVER_COVERAGE_ARGUMENT_INVALID", { table });
  }
  return Number(value);
}

const PROVIDER_TABLES = new Set(providerSchemas.filter(row => row.type === "table").map(row => row.name));

/** The sealed tables of one source under the seal's own predicate (no sqlite_* and no D1 provider table). */
export function sealedCatalog(database) {
  let rows;
  try {
    rows = database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
      ORDER BY name`).all();
  } catch {
    fail("CUTOVER_COVERAGE_ARGUMENT_INVALID");
  }
  return Object.freeze(rows.map(row => String(row.name)).filter(name => !PROVIDER_TABLES.has(name)));
}

export function validateOwnerFlags(flags) {
  if (!Array.isArray(flags) || new Set(flags).size !== flags.length
      || flags.some(flag => typeof flag !== "string" || !OWNER_FLAGS.includes(flag))) {
    fail("CUTOVER_COVERAGE_ARGUMENT_INVALID");
  }
  return Object.freeze([...flags].sort());
}

/**
 * Catalog equality in both directions, then every rule. Returns content-free
 * facts per role: table counts by token, and the rows of each rule-bearing
 * table. `databases` maps each role to an open, verified sealed database.
 */
export function evaluateSealedCoverage(databases, { ownerFlags = [] } = {}) {
  const flags = validateOwnerFlags(ownerFlags);
  if (databases === null || typeof databases !== "object") fail("CUTOVER_COVERAGE_ARGUMENT_INVALID");
  const report = {};
  for (const role of SOURCE_ROLES) {
    const database = databases[role];
    if (database === undefined || database === null) fail("CUTOVER_COVERAGE_ARGUMENT_INVALID", { role });
    const catalog = sealedCatalog(database);
    const expected = DISPOSITIONS.filter(item => item.role === role);
    for (const table of catalog) {
      if (!DISPOSITION_INDEX.has(`${role}:${table}`)) fail("CUTOVER_COVERAGE_TABLE_UNKNOWN", { role, table });
    }
    const present = new Set(catalog);
    for (const item of expected) {
      if (!present.has(item.table) && !item.optional) fail("CUTOVER_COVERAGE_TABLE_MISSING", { role, table: item.table });
    }
    const ruled = {};
    for (const item of expected.filter(candidate => present.has(candidate.table) && candidate.rule !== "any")) {
      const rows = count(database, `SELECT count(*) AS n FROM ${quote(item.table)}`, item.table);
      if (item.rule === "empty") {
        if (rows !== 0) fail("CUTOVER_COVERAGE_NOT_EMPTY", { role, table: item.table, count: rows });
      } else if (item.rule.startsWith("flag:")) {
        const flag = item.rule.slice("flag:".length);
        if (rows !== 0 && !flags.includes(flag)) fail("CUTOVER_COVERAGE_DECISION_MISSING", { role, table: item.table, flag });
      } else if (item.rule === "no-pending-erasure-jobs") {
        const pending = count(database, `SELECT count(*) AS n FROM ${quote(item.table)} WHERE state = 'pending'`, item.table);
        if (pending !== 0) fail("CUTOVER_PARTICIPANT_ERASURE_PENDING", { role, table: item.table, count: pending });
      } else {
        fail("CUTOVER_COVERAGE_ARGUMENT_INVALID", { table: item.table });
      }
      ruled[item.table] = rows;
    }
    const byToken = {};
    for (const item of expected.filter(candidate => present.has(candidate.table))) {
      const token = item.token.includes(":") ? item.token.slice(0, item.token.indexOf(":")) : item.token;
      byToken[token] = (byToken[token] ?? 0) + 1;
    }
    report[role] = Object.freeze({
      tables: catalog.length,
      byToken: Object.freeze(Object.fromEntries(Object.entries(byToken).sort())),
      ruledRows: Object.freeze(Object.fromEntries(Object.entries(ruled).sort())),
    });
  }
  return Object.freeze({ schema: TRANSFER_COVERAGE_SCHEMA, policySha256: dispositionPolicySha256(), ownerFlags: flags,
    roles: Object.freeze(report) });
}

/**
 * A waiver is admitted only for a WAIVABLE stage with its closed reason, when
 * no 'imported:' or 'mapped:' disposition names the stage (the rules of the
 * tables it would own were already enforced by evaluateSealedCoverage).
 */
export function assertWaiverAllowed(stage, reason) {
  if (!Object.hasOwn(WAIVABLE, stage) || !WAIVABLE[stage].includes(reason)) {
    fail("CUTOVER_STAGE_WAIVER_REFUSED", { stage });
  }
  if (DISPOSITIONS.some(item => item.stage === stage && /^(?:imported|mapped):/u.test(item.token))) {
    fail("CUTOVER_STAGE_WAIVER_REFUSED", { stage });
  }
  return Object.freeze({ stage, reason });
}

/** The content-free waiver receipt digest of section 4. */
export function stageWaiverSha256({ sealId, stage, reason }) {
  assertWaiverAllowed(stage, reason);
  if (typeof sealId !== "string" || !/^[0-9a-f]{64}$/u.test(sealId)) fail("CUTOVER_COVERAGE_ARGUMENT_INVALID");
  return HASH(JSON.stringify({ schema: STAGE_WAIVER_SCHEMA, sealId, stage, reason,
    dispositionPolicySha256: dispositionPolicySha256() }));
}
