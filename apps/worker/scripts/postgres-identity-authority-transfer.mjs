// PT-3: the identity and authority importer, the 'identity-authority' stage
// on PT-1's production transfer target (scripts/postgres-transfer-target.mjs)
// over the sealed ingestion D1 of a PT-2-lite seal (cutover-source-seal.mjs).
//
// Fast-path re-scope (decisions D1, D2, D4 and the 2026-10-01 plan):
//   * Imported verbatim, credential and rotation hashes included (unlike the
//     T-1 rehearsal copy, nothing in PARTICIPANT_CREDENTIAL_OMISSIONS is
//     dropped) so devices, sessions, pairings and handoffs authenticate after
//     the flip without re-sign-in. Revoked ledger, owner, grant and device
//     rows carry over verbatim: they are the upload block.
//   * Not imported: identity_reenrollment_cooldowns (D2: written only by
//     online erasure), every deletion-ledger table (the ledger contributes
//     only its digest projection) and the accountless_public_history_*
//     retention markers (the landed retention importer owns them while OA-2
//     keeps the OD-3 parity view). The two performance-consent tables have no
//     PostgreSQL target at the promoted level and are recorded target-missing.
//   * Collection controls are recorded and degraded (PT-1), never copied; the
//     public-source bootstrap singleton replaces the seeded row after
//     policy_version 'community-public-sources-v1' and completed = 1 are
//     asserted (cursors written '' as primary 0053 directs).
//
// Contract:
//   * The handle's run must be 'importing' and its seal id must be the seal
//     manifest's; the sealed file's sha256 is checked before and after.
//   * Every check that can refuse runs before the first write: the frozen
//     COLUMN_MAP closure (CUTOVER_COLUMN_UNMAPPED), the frozen COUNTER_MAPPING
//     over sqlite_sequence (CUTOVER_COUNTER_UNMAPPED), the identity-link pin
//     against the configured fingerprint (CUTOVER_IDENTITY_LINK_SECRET_MISMATCH),
//     erasure quiescence: every sealed participant 'active' with no
//     deletion fence (CUTOVER_PARTICIPANT_ERASURE_PENDING; an interrupted
//     Cloudflare erasure is never completed in PostgreSQL, which has no
//     online erasure, so the owner finishes it and re-seals), the
//     do-not-restore rule (decision D2): no sealed participant, whatever its
//     state, hashes to a deletion digest of the same seal's deletion ledger
//     (CUTOVER_ERASED_PARTICIPANT_PRESENT, through PT-2-lite's
//     assertNoSealedParticipantDeletionMatches, so the rule holds whether or
//     not PT-8-lite composes this stage), the bootstrap
//     (CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE), the accountless authority
//     chain (CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID),
//     the import transfer session, the reviewed trigger policy coverage and
//     the frozen FK-topological order against the target's foreign keys.
//   * Tables import in pages of at most 256 rows and 4 MiB. Each page is one
//     transaction under SET LOCAL ROLE (withTransferTransaction): a pending
//     checkpoint (row count and prefix chain, never a key) and the rows,
//     with the reviewed triggers suppressed for that page only
//     (withTriggerPolicy). A killed run resumes at the last committed page:
//     the sealed prefix must reproduce the checkpoint's chain.
//   * A table completes only when its target digest equals the sealed
//     digest; then applyIdentityHighWater and instant round trips run, and
//     the stage receipt completes. Receipts hold names, counts and digests.

import { createHash } from "node:crypto";
import { readCutoverSeal, openSealedSourceFromSeal, CutoverSourceError } from "./cutover-source-seal.mjs";
import { assertNoSealedParticipantDeletionMatches, readSealedDeletionDigests } from "./cutover-source-projections.mjs";
import {
  FASTPATH_IDENTITY_COMPLETED_WALK_RULE,
  POSTGRES_FASTPATH_IDENTITY_TABLE_SPECS,
  POSTGRES_FASTPATH_IDENTITY_TARGET_TYPES,
  POSTGRES_FASTPATH_TRANSPORT_TABLE_SPECS,
  PostgresFastpathIdentityCopyError,
  fastpathIdentityColumn as c,
  fastpathIdentitySourceValue,
  fastpathIdentityTable as t,
  fastpathIdentityTargetExpression,
  fastpathIdentityTargetValue,
} from "./postgres-fastpath-identity-copy.mjs";
import {
  EMPTY_PREFIX_CHAIN,
  PostgresTransferTargetError,
  advancePrefixChain,
  applyIdentityHighWater,
  assertCollectionControlsDegradedForImport,
  assertInstantRoundTrip,
  assertTriggerPolicyCoverage,
  createRowsDigest,
  degradeCollectionControlsForImport,
  productionTransferId,
  readCheckpoint,
  recordCheckpoint,
  recordSealedCollectionControls,
  requireImportingRun,
  sealedCollectionControlsSha256,
  stageReceipt,
  tableReceipt,
  withTransferTransaction,
  withTriggerPolicy,
} from "./postgres-transfer-target.mjs";

export const IDENTITY_AUTHORITY_TRANSFER_SCHEMA = "tibotattle-identity-authority-transfer-v1";
export const IDENTITY_AUTHORITY_STAGE = "identity-authority";
export const IDENTITY_AUTHORITY_MAX_PAGE_ROWS = 256;
export const IDENTITY_AUTHORITY_MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const PUBLIC_SOURCE_BOOTSTRAP_POLICY = "community-public-sources-v1";

export const IDENTITY_AUTHORITY_ERROR_CODES = Object.freeze([
  "CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID",
  "CUTOVER_CHECKPOINT_DIVERGED",
  "CUTOVER_COLUMN_UNMAPPED",
  "CUTOVER_COUNTER_UNMAPPED",
  "CUTOVER_IDENTITY_ARGUMENT_INVALID",
  "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH",
  "CUTOVER_IDENTITY_TABLE_DIGEST_MISMATCH",
  "CUTOVER_IDENTITY_TRANSFER_FAILED",
  "CUTOVER_IMPORT_ORDER_INVALID",
  "CUTOVER_PAGE_ROW_TOO_LARGE",
  "CUTOVER_PARTICIPANT_ERASURE_PENDING",
  "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE",
  "CUTOVER_SEEDED_ROW_UNMATCHED",
  "CUTOVER_SOURCE_SINGLETON_INVALID",
  "CUTOVER_SOURCE_TABLE_MISSING",
  "CUTOVER_SOURCE_VALUE_INVALID",
  "CUTOVER_TARGET_COLUMN_MISMATCH",
  "CUTOVER_TARGET_ROW_COUNT_DIVERGED",
  "CUTOVER_TARGET_WRITE_REFUSED",
  "CUTOVER_TRANSFER_SESSION_REQUIRED",
]);
const ERROR_CODES = new Set(IDENTITY_AUTHORITY_ERROR_CODES);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HASH = value => createHash("sha256").update(value).digest("hex");

export class IdentityAuthorityTransferError extends Error {
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
    this.name = "IdentityAuthorityTransferError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_IDENTITY_TRANSFER_FAILED";
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new IdentityAuthorityTransferError(code, details);
}

function quote(name) {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  return `"${name}"`;
}

function sqlStateOf(error) {
  return typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : undefined;
}

async function q(client, text, values, table = undefined) {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof IdentityAuthorityTransferError || error instanceof PostgresTransferTargetError) throw error;
    return fail("CUTOVER_TARGET_WRITE_REFUSED", { table, sqlState: sqlStateOf(error) });
  }
}

// ---------------------------------------------------------------------------
// The frozen COLUMN_MAP: T-1's reviewed specs (by additive export) where they
// exist, with every column imported (no credential omissions, every row
// selected), and the reviewed additions in the same type vocabulary.

const T1 = new Map(POSTGRES_FASTPATH_IDENTITY_TABLE_SPECS.map(spec => [spec.name, spec]));
const T1_TRANSPORT = new Map(Object.values(POSTGRES_FASTPATH_TRANSPORT_TABLE_SPECS).flat().map(spec => [spec.name, spec]));

function fromT1(name, family, { extraColumns = [], source = T1 } = {}) {
  const spec = source.get(name);
  if (spec === undefined) throw new TypeError("identity authority T-1 spec missing");
  return t(name, family, spec.key, [...spec.columns, ...extraColumns]);
}

const instant = name => c(name, "instant");
const text = name => c(name, "text");
const int = name => c(name, "int");
const bytes = name => c(name, "bytes");

// mode: 'insert' rows into an empty table; 'replace-singleton' updates the
// migration-seeded singleton to the sealed row; 'merge-seeded' updates the
// seeded rows whose keys the seal carries (PostgreSQL's extra seed rows stay).
function entry(group, mode, spec, { suppress = {}, fire = {}, derived = null, matchColumns = null } = {}) {
  return Object.freeze({ group, mode, spec, name: spec.name, suppress: Object.freeze(suppress),
    fire: Object.freeze(fire), derived, matchColumns: matchColumns === null ? null : Object.freeze([...matchColumns]) });
}

const UPDATE_ONLY = "Fires only on UPDATE or DELETE; the import inserts.";

const ENTRIES = Object.freeze([
  // Group 1.
  entry(1, "replace-singleton", t("accountless_enrollment_issuance", "identity", ["singleton"], [
    int("singleton"), c("budget_day", "day"), int("daily_issued"), int("lifetime_issued"), text("last_issue_token"),
    instant("updated_at"),
  ])),
  entry(1, "insert", fromT1("participants", "identity", { extraColumns: [
    text("access_token_id"), bytes("access_token_hash"), text("recovery_token_id"), bytes("recovery_token_hash"),
    text("deletion_session_id"), text("identity_link_key"), text("identity_cooldown_digest"),
  ] }), {
    suppress: {
      attribution_enrollment_created: "TA-1 auto-creation: the sealed attribution_enrollments rows are imported verbatim.",
      community_analytical_input_participant_insert: "The sealed community_analytical_input_versions rows are imported verbatim.",
      participant_input_created: "Replaced by the set-based input_versions insert of the same page.",
      telemetry_transport_floor_created: "TA-1 auto-creation: the sealed participant floors are imported verbatim.",
    },
    fire: {
      community_analytical_input_participant_state: UPDATE_ONLY,
      participant_input_state: UPDATE_ONLY,
      participant_projection_delete: UPDATE_ONLY,
      participant_withdrawal: UPDATE_ONLY,
      telemetry_participant_owner_erasure_proof: UPDATE_ONLY,
      telemetry_v12_ready_participant_delete_guard: UPDATE_ONLY,
    },
    derived: "input_versions",
  }),
  entry(1, "insert", fromT1("community_analytical_input_versions", "identity")),
  entry(1, "insert", t("identity_link_secret_configuration", "identity", ["singleton"], [
    int("singleton"), text("key_version"), text("secret_fingerprint"), instant("recorded_at"),
  ])),
  entry(1, "insert", t("attribution_enrollments", "identity", ["participant_id"], [
    text("participant_id"), text("namespace"), instant("created_at"),
  ]), { fire: { attribution_enrollment_immutable: UPDATE_ONLY } }),
  entry(1, "merge-seeded", t("telemetry_transport_formats", "identity", ["schema_version"], [
    text("schema_version"), int("format_rank"), text("lifecycle"),
  ]), {
    fire: { telemetry_transport_format_identity_immutable: "Guards schema_version and format_rank; the merge updates lifecycle only." },
    matchColumns: ["schema_version", "format_rank"],
  }),
  // Group 2.
  entry(2, "insert", fromT1("accountless_enrollment_ledger", "identity")),
  entry(2, "insert", fromT1("web_sessions", "identity")),
  entry(2, "insert", fromT1("device_pairings", "identity")),
  entry(2, "insert", t("device_pairing_events", "identity", ["id"], [
    text("id"), text("pairing_id"), text("participant_id"), text("kind"), instant("occurred_at"),
  ])),
  entry(2, "insert", fromT1("device_credentials", "identity"), {
    suppress: { telemetry_transport_device_floor_created: "TA-1 auto-creation: the sealed device floors are imported verbatim." },
  }),
  entry(2, "insert", t("device_credential_rotations", "identity", ["id"], [
    text("id"), text("device_id"), text("participant_id"), bytes("prior_secret_hash"), bytes("replacement_secret_hash"),
    text("attempt_id"), int("generation"), instant("rotated_at"), instant("retire_at"), bytes("recovery_proof_hash"),
  ])),
  entry(2, "insert", t("upload_authorizations", "identity", ["id"], [
    text("id"), text("participant_id"), text("issued_by_session_id"), bytes("secret_hash"), text("envelope_digest"),
    int("body_bytes"), text("content_type"), text("state"), instant("issued_at"), instant("expires_at"),
    instant("consumed_at"), instant("revoked_at"), instant("consume_lease_expires_at"), text("consumed_contribution_id"),
  ])),
  entry(2, "insert", fromT1("device_upload_authorizations", "identity", { source: T1_TRANSPORT })),
  entry(2, "insert", t("enrollment_grants", "identity", ["id"], [
    text("id"), bytes("secret_hash"), text("state"), instant("issued_at"), instant("expires_at"), instant("redeemed_at"),
    text("redeemed_participant_id"),
  ]), { fire: { enrollment_grants_redeemer_required: "Primary 0063: admits an erased redeemer only for this transfer session." } }),
  entry(2, "insert", t("participant_community_eligibility", "identity", ["id"], [
    text("id"), text("participant_id"), text("grant_id"), instant("created_at"),
  ]), { fire: { participant_community_eligibility_requires_redeemed_grant: "Guard: the redeemed grant is imported first." } }),
  entry(2, "insert", t("recovery_retry_receipts", "identity", ["old_recovery_token_id"], [
    text("old_recovery_token_id"), bytes("old_recovery_token_hash"), bytes("recovery_attempt_hash"), text("participant_id"),
    text("derivation_nonce"), text("replacement_recovery_token_id"), text("replacement_session_id"), instant("issued_at"),
    instant("expires_at"), int("replay_count"),
  ])),
  // Group 3: the audit rows precede the floor rollbacks that reference them.
  entry(3, "insert", t("admin_action_audit", "authority", ["id"], [
    int("id"), text("operation_id"), text("action"), text("actor_identity_digest"), text("outcome"), text("details_json"),
    instant("created_at"),
  ]), { fire: { admin_action_audit_lifecycle_guard: UPDATE_ONLY, admin_action_audit_no_truncate: "TRUNCATE only." } }),
  entry(3, "insert", fromT1("accountless_upload_owners", "authority")),
  entry(3, "insert", fromT1("accountless_v11_device_authorizations", "authority")),
  entry(3, "insert", fromT1("accountless_v12_device_authorizations", "authority")),
  entry(3, "insert", t("telemetry_transport_participant_floors", "authority", ["participant_id"], [
    text("participant_id"), int("minimum_rank"), int("revision"), instant("changed_at"),
  ]), { fire: { telemetry_transport_participant_floor_guard: UPDATE_ONLY } }),
  entry(3, "insert", t("telemetry_transport_device_floors", "authority", ["participant_id", "device_id"], [
    text("participant_id"), text("device_id"), int("minimum_rank"), int("revision"), instant("changed_at"),
  ]), { fire: { telemetry_transport_device_floor_guard: UPDATE_ONLY } }),
  entry(3, "insert", t("telemetry_transport_floor_rollbacks", "authority", ["operation_id"], [
    text("operation_id"), text("participant_id"), text("participant_digest"), int("expected_revision"), int("from_rank"),
    int("to_rank"), instant("created_at"),
  ]), { suppress: { telemetry_transport_rollback_owner_only: "Live admission of a started rollback; the sealed rows are completed history." } }),
  entry(3, "insert", fromT1("telemetry_v1_device_consents", "authority")),
  entry(3, "insert", fromT1("telemetry_v11_device_consents", "authority"), {
    suppress: {
      telemetry_v11_consent_admission: "V11-A live consent admission; the sealed consents were admitted by D1.",
      telemetry_v11_consent_floor: "Live floor raise; the sealed floors are imported verbatim.",
    },
    fire: { telemetry_v11_consent_immutable: UPDATE_ONLY },
  }),
  entry(3, "insert", fromT1("telemetry_v12_device_capabilities", "authority")),
  // Group 4.
  entry(4, "insert", t("apple_signin_handoffs", "signin", ["state"], [
    text("state"), text("nonce_hash"), text("identity_link_key"), text("proof"), instant("created_at"), instant("expires_at"),
    instant("delivered_at"), text("binding_hash"), text("claim_id"), instant("claimed_at"),
  ])),
  entry(4, "insert", t("google_signin_handoffs", "signin", ["state"], [
    text("state"), text("code_verifier"), text("identity_link_key"), text("proof"), instant("created_at"),
    instant("expires_at"), instant("delivered_at"), text("binding_hash"), text("claim_id"), instant("claimed_at"),
  ])),
  entry(4, "insert", t("sign_in_start_admission_windows", "signin", ["window_started_at"], [
    instant("window_started_at"), int("accepted_count"), instant("last_accepted_at"),
  ])),
  entry(4, "replace-singleton", t("github_distribution_sync_state", "distribution", ["singleton"], [
    int("singleton"), instant("last_attempted_at"), instant("last_success_at"), text("last_failure_code"),
    instant("last_observed_at"), text("lease_token"), instant("lease_expires_at"),
  ])),
  entry(4, "insert", t("github_distribution_snapshots", "distribution", ["observed_at"], [
    instant("observed_at"), instant("completed_at"),
  ])),
  entry(4, "insert", t("github_release_snapshots", "distribution", ["observed_at", "release_id"], [
    instant("observed_at"), int("release_id"), text("release_tag"), instant("release_published_at"),
    c("release_prerelease", "bool01"),
  ])),
  entry(4, "insert", t("github_release_asset_snapshots", "distribution", ["observed_at", "asset_id"], [
    instant("observed_at"), int("release_id"), text("release_tag"), instant("release_published_at"),
    c("release_prerelease", "bool01"), int("asset_id"), text("asset_name"), text("asset_digest"),
    int("asset_download_count"), c("is_dmg", "bool01"),
  ])),
  entry(4, "insert", fromT1("storage_v11_owner_links", "identity"), {
    suppress: {
      storage_v11_owner_link_terminal_guard: "0029 terminal guard refuses an erased link on INSERT; sealed links carry over.",
      storage_v11_owner_erasure_receipt_create: "0029 receipt trigger; the import creates no erasure receipt.",
    },
    fire: {
      erased_owner_link_publication_invalidation: UPDATE_ONLY,
      typed_telemetry_owner_link_delete_guard: UPDATE_ONLY,
    },
  }),
]);

/** The frozen FK-topological import order (asserted against the target's foreign keys). */
export const IDENTITY_AUTHORITY_FROZEN_ORDER = Object.freeze([
  "accountless_enrollment_issuance", "participants", "community_analytical_input_versions",
  "identity_link_secret_configuration", "attribution_enrollments", "telemetry_transport_formats",
  "accountless_enrollment_ledger", "web_sessions", "device_pairings", "device_pairing_events", "device_credentials",
  "device_credential_rotations", "upload_authorizations", "device_upload_authorizations", "enrollment_grants",
  "participant_community_eligibility", "recovery_retry_receipts",
  "admin_action_audit", "accountless_upload_owners", "accountless_v11_device_authorizations",
  "accountless_v12_device_authorizations", "telemetry_transport_participant_floors",
  "telemetry_transport_device_floors", "telemetry_transport_floor_rollbacks", "telemetry_v1_device_consents",
  "telemetry_v11_device_consents", "telemetry_v12_device_capabilities",
  "apple_signin_handoffs", "google_signin_handoffs", "sign_in_start_admission_windows",
  "github_distribution_sync_state", "github_distribution_snapshots", "github_release_snapshots",
  "github_release_asset_snapshots", "storage_v11_owner_links",
]);
if (JSON.stringify(ENTRIES.map(item => item.name)) !== JSON.stringify(IDENTITY_AUTHORITY_FROZEN_ORDER)) {
  throw new TypeError("identity authority entries drifted from the frozen order");
}

const BOOTSTRAP_SPEC = T1.get("community_public_source_bootstrap");
const CONTROLS_COLUMNS = Object.freeze(["singleton", "schema_version", "control_state", "enrollment_enabled",
  "upload_registration_enabled", "processing_enabled", "publication_enabled", "revision", "reason_code", "updated_at"]);

/** The frozen COLUMN_MAP: table -> [[source, target, type], ...] and reviewed omissions. */
export const IDENTITY_AUTHORITY_COLUMN_MAP = Object.freeze(Object.fromEntries([
  ...ENTRIES.map(item => [item.name, Object.freeze({
    mode: item.mode,
    group: item.group,
    key: item.spec.key,
    columns: Object.freeze(item.spec.columns.map(column => Object.freeze([column.source, column.target, column.type]))),
    omitted: Object.freeze([]),
  })]),
  ["collection_controls", Object.freeze({ mode: "record-and-degrade", group: 0, key: Object.freeze(["singleton"]),
    columns: Object.freeze(CONTROLS_COLUMNS.map(name => Object.freeze([name, name, "sealed-controls"]))),
    omitted: Object.freeze([]) })],
  ["community_public_source_bootstrap", Object.freeze({ mode: "replace-bootstrap", group: 0, key: BOOTSTRAP_SPEC.key,
    columns: Object.freeze(BOOTSTRAP_SPEC.columns.map(column => Object.freeze([column.source, column.target, column.type]))),
    omitted: Object.freeze([]) })],
]));

/** Sealed sqlite_sequence counters and where each one lands. */
export const IDENTITY_AUTHORITY_COUNTER_MAPPING = Object.freeze({
  admin_action_audit: Object.freeze({ target: "admin_action_audit" }),
  diagnostic_error_events: Object.freeze({ target: "diagnostic_error_events" }),
  telemetry_records: Object.freeze({ target: "telemetry_records" }),
  telemetry_v1_records: Object.freeze({ target: "telemetry_v1_records" }),
  community_current_analysis_queue: Object.freeze({ target: null, reason: "analytics-recomputed" }),
  d1_migrations: Object.freeze({ target: null, reason: "migration-ledger" }),
});

/** Sealed tables this stage never writes, with the owner of each. */
export const IDENTITY_AUTHORITY_EXCLUDED_TABLES = Object.freeze({
  identity_reenrollment_cooldowns: "decision-d2: written only by online erasure; never imported",
  accountless_public_history_retention: "claimed-by:accountless-retention while OA-2 keeps the OD-3 parity view",
});

/** Sealed identity tables with no PostgreSQL target at the promoted level. */
export const IDENTITY_AUTHORITY_TARGET_MISSING = Object.freeze([
  "accountless_telemetry_performance_authorizations",
  "telemetry_performance_device_capabilities",
]);

/** The reviewed trigger policy for every table the stage writes. */
export const IDENTITY_TRIGGER_POLICY = Object.freeze(Object.fromEntries([
  ...ENTRIES.map(item => [item.name, Object.freeze({
    ...Object.fromEntries(Object.entries(item.suppress).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "suppress", reason })])),
    ...Object.fromEntries(Object.entries(item.fire).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "fire", reason })])),
  })]),
  ["collection_controls", Object.freeze({
    accountless_public_history_d1_fence_controls_guard: Object.freeze({ policy: "fire", reason: "Controls guard: fires on the degrade UPDATE." }),
    accountless_public_history_import_controls_guard: Object.freeze({ policy: "fire", reason: "Controls guard: fires on the degrade UPDATE." }),
  })],
  ["community_public_source_bootstrap", Object.freeze({})],
  ["input_versions", Object.freeze({})],
]));

export function identityAuthorityPolicySha256() {
  return HASH(JSON.stringify([IDENTITY_AUTHORITY_TRANSFER_SCHEMA, IDENTITY_AUTHORITY_FROZEN_ORDER,
    IDENTITY_AUTHORITY_COLUMN_MAP, IDENTITY_AUTHORITY_COUNTER_MAPPING, IDENTITY_TRIGGER_POLICY,
    IDENTITY_AUTHORITY_EXCLUDED_TABLES, IDENTITY_AUTHORITY_TARGET_MISSING]));
}

// ---------------------------------------------------------------------------
// Sealed source reads.

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
function assertSourceColumnMap(database, name, mappedSources, omitted = []) {
  const actual = sourceColumns(database, name);
  for (const column of actual) {
    if (!mappedSources.includes(column) && !omitted.includes(column)) {
      fail("CUTOVER_COLUMN_UNMAPPED", { table: name, column: IDENTIFIER.test(column) ? column : undefined });
    }
  }
  for (const column of mappedSources) {
    if (!actual.includes(column)) fail("CUTOVER_COLUMN_UNMAPPED", { table: name, column });
  }
}

function canonicalRow(spec, row) {
  const values = [];
  const parameters = [];
  let size = 0;
  for (const column of spec.columns) {
    let pair;
    try {
      pair = fastpathIdentitySourceValue(column.type, row[column.source], spec.name, column.source);
    } catch (error) {
      if (error instanceof PostgresFastpathIdentityCopyError) fail("CUTOVER_SOURCE_VALUE_INVALID", { table: spec.name, column: column.source });
      throw error;
    }
    values.push(pair[0]);
    parameters.push(pair[1]);
    const value = pair[1];
    size += value === null ? 0 : Buffer.isBuffer(value) ? value.length : typeof value === "string" ? Buffer.byteLength(value) : 8;
  }
  return { values, parameters, size };
}

function keyOrderSql(spec) {
  return spec.key.map(key => quote(key)).join(", ");
}

/** One keyset page of sealed rows after `after` (raw key values), in key order. */
function readSourcePage(database, spec, after, limit) {
  const list = spec.columns.map(column => quote(column.source)).join(", ");
  const keys = spec.key.map(key => spec.columns.find(column => column.target === key).source);
  const where = after === null ? "" : ` WHERE (${keys.map(quote).join(", ")}) > (${keys.map(() => "?").join(", ")})`;
  const rows = sourceAll(database, `SELECT ${list} FROM ${quote(spec.name)}${where} ORDER BY ${keys.map(quote).join(", ")} LIMIT ?`,
    [...(after ?? []), limit], spec.name);
  return rows.map(row => ({ row, key: keys.map(key => row[key]) }));
}

function pageOf(database, spec, after, maxRows, maxBytes) {
  const candidates = readSourcePage(database, spec, after, maxRows);
  const page = [];
  let bytesTotal = 0;
  for (const candidate of candidates) {
    const canonical = canonicalRow(spec, candidate.row);
    if (canonical.size > maxBytes) fail("CUTOVER_PAGE_ROW_TOO_LARGE", { table: spec.name });
    if (page.length > 0 && bytesTotal + canonical.size > maxBytes) break;
    page.push({ ...canonical, key: candidate.key });
    bytesTotal += canonical.size;
  }
  return { rows: page, bytes: bytesTotal };
}

/** Stream the whole sealed table once: count, bytes, digest and final prefix chain. */
function sourceTableFacts(database, spec, maxRows) {
  const digest = createRowsDigest();
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let rows = 0;
  let bytesTotal = 0;
  for (;;) {
    const page = readSourcePage(database, spec, after, maxRows);
    for (const { row, key } of page) {
      const canonical = canonicalRow(spec, row);
      digest.update(canonical.values);
      chain = advancePrefixChain(chain, canonical.values);
      rows += 1;
      bytesTotal += canonical.size;
      after = key;
    }
    if (page.length < maxRows) break;
  }
  return { rows, bytes: bytesTotal, sha256: digest.digest(), chain };
}

/** Replay the first `count` sealed rows: their prefix chain and the key after them. */
function sourcePrefix(database, spec, count, maxRows) {
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let seen = 0;
  while (seen < count) {
    const page = readSourcePage(database, spec, after, Math.min(maxRows, count - seen));
    if (page.length === 0) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.name });
    for (const { row, key } of page) {
      chain = advancePrefixChain(chain, canonicalRow(spec, row).values);
      after = key;
      seen += 1;
    }
  }
  return { chain, after };
}

// ---------------------------------------------------------------------------
// Preflight (read-only; refuses before any write).

function readSingleton(database, table, columns) {
  const rows = sourceAll(database, `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`, [], table);
  return rows;
}

function sealedControlsRow(database) {
  assertSourceColumnMap(database, "collection_controls", CONTROLS_COLUMNS);
  const rows = readSingleton(database, "collection_controls", CONTROLS_COLUMNS);
  if (rows.length !== 1) fail("CUTOVER_SOURCE_SINGLETON_INVALID", { table: "collection_controls" });
  const row = rows[0];
  return Object.freeze({
    singleton: row.singleton,
    schema_version: row.schema_version,
    control_state: row.control_state,
    enrollment_enabled: row.enrollment_enabled,
    upload_registration_enabled: row.upload_registration_enabled,
    processing_enabled: row.processing_enabled,
    publication_enabled: row.publication_enabled,
    revision: row.revision,
    reason_code: row.reason_code,
    updated_at: row.updated_at,
  });
}

function sealedBootstrap(database) {
  assertSourceColumnMap(database, "community_public_source_bootstrap", BOOTSTRAP_SPEC.columns.map(column => column.source));
  const rows = readSingleton(database, "community_public_source_bootstrap", BOOTSTRAP_SPEC.columns.map(column => column.source));
  if (rows.length !== 1 || rows[0].singleton !== 1n || rows[0].policy_version !== PUBLIC_SOURCE_BOOTSTRAP_POLICY
      || rows[0].completed !== 1n) {
    fail("CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE");
  }
  const [ruled, cursorsCleared] = FASTPATH_IDENTITY_COMPLETED_WALK_RULE.apply(rows[0], "community_public_source_bootstrap");
  const canonical = canonicalRow(BOOTSTRAP_SPEC, ruled);
  return Object.freeze({ canonical, cursorsCleared, sha256: HASH(JSON.stringify([canonical.values])) });
}

function assertIdentityLinkPin(database, pin) {
  if (pin === null || typeof pin !== "object" || typeof pin.keyVersion !== "string" || !VERSION.test(pin.keyVersion)
      || typeof pin.secretFingerprint !== "string" || !SHA256.test(pin.secretFingerprint)) {
    fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  }
  const rows = sourceAll(database, "SELECT singleton, key_version, secret_fingerprint FROM identity_link_secret_configuration",
    [], "identity_link_secret_configuration");
  if (rows.length !== 1 || rows[0].singleton !== 1n || rows[0].key_version !== pin.keyVersion
      || rows[0].secret_fingerprint !== pin.secretFingerprint) {
    fail("CUTOVER_IDENTITY_LINK_SECRET_MISMATCH");
  }
}

/**
 * The participants PT-3 refuses, as SQL over the D1 `participants` table, in
 * two disjuncts and their union. The read-only pre-fence quiescence check
 * (cutover-quiescence-check.mjs, E-QUIESCE) imports these so that it finds,
 * before the fence, exactly the rows this stage would refuse after the seal.
 * Change them only here.
 */
export const PARTICIPANT_NOT_ACTIVE_PREDICATE = "state IS NOT 'active'";
export const PARTICIPANT_DELETION_FENCED_PREDICATE = "deletion_session_id IS NOT NULL";
export const PARTICIPANT_NOT_QUIESCENT_PREDICATE =
  `${PARTICIPANT_NOT_ACTIVE_PREDICATE} OR ${PARTICIPANT_DELETION_FENCED_PREDICATE}`;

/**
 * Erasure quiescence (PT-8): no sealed participant may be mid-erasure. A
 * 'deleting' row, or any row still carrying a deletion fence, is an
 * interrupted Cloudflare erasure whose tombstone may already be recorded.
 * PostgreSQL has no online erasure (SIMP-1), so nothing would ever finish
 * it there; it is refused before any write. Only a count leaves here.
 */
function assertParticipantsQuiescent(database) {
  const [row] = sourceAll(database, `SELECT count(*) AS n FROM participants
    WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE}`, [], "participants");
  if (row?.n !== 0n) fail("CUTOVER_PARTICIPANT_ERASURE_PENDING", { table: "participants" });
}

/**
 * The do-not-restore rule (decision D2), enforced by this stage itself and
 * not only by PT-8-lite: no sealed participant, whatever its state, may hash
 * to a deletion digest recorded in the same seal's deletion ledger (for
 * example an erased participant whose rows came back through a D1 restore).
 * The digests come from the verified seal, so no caller can supply a stale
 * or empty list. Refuses CUTOVER_ERASED_PARTICIPANT_PRESENT; only counts and
 * the projection's sha256 leave here.
 */
async function assertNoErasedParticipantRestored(seal, sealedIngestion) {
  const ledger = await openSealedSourceFromSeal(seal, "deletion-ledger");
  try {
    const projection = await readSealedDeletionDigests({ sealedLedger: ledger });
    const result = await assertNoSealedParticipantDeletionMatches({ sealedIngestion, digests: projection.digests });
    return Object.freeze({ deletionDigests: projection.count, deletionDigestsSha256: projection.sha256,
      participants: result.participants, matches: result.matches });
  } finally {
    ledger.close();
  }
}

function assertCounters(database) {
  const present = sourceAll(database, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").length === 1;
  const counters = present ? sourceAll(database, "SELECT name, seq FROM sqlite_sequence ORDER BY name") : [];
  const sealed = {};
  for (const counter of counters) {
    if (typeof counter.name !== "string" || !Object.hasOwn(IDENTITY_AUTHORITY_COUNTER_MAPPING, counter.name)) {
      fail("CUTOVER_COUNTER_UNMAPPED", { table: IDENTIFIER.test(String(counter.name)) ? String(counter.name) : undefined });
    }
    // sqlite_sequence.seq is untyped: SQLite writes INTEGER, a restored copy
    // may hold an integral REAL. Anything else is not a counter.
    const seq = typeof counter.seq === "bigint" ? counter.seq
      : Number.isSafeInteger(counter.seq) ? BigInt(counter.seq) : -1n;
    if (seq < 0n || seq > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table: "sqlite_sequence" });
    sealed[counter.name] = Number(seq);
  }
  return Object.freeze(sealed);
}

// The accountless chain: every owner names its ledger row and the device
// credential minted for it under the same policy; every v1.1 and v1.2 grant
// names exactly one owner triple. State is not part of the chain (revoked
// rows are the upload block and carry over verbatim).
const CHAIN_VIOLATIONS = Object.freeze([
  `SELECT count(*) AS n FROM accountless_upload_owners owner
     LEFT JOIN participants p ON p.id = owner.participant_id
     LEFT JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
     LEFT JOIN device_credentials device ON device.id = owner.device_credential_id
    WHERE p.id IS NULL OR p.owner_kind IS NOT 'accountless' OR ledger.device_id IS NULL OR device.id IS NULL
       OR device.participant_id IS NOT owner.participant_id OR device.authority_kind IS NOT 'accountless'
       OR device.accountless_enrollment_device_id IS NOT owner.enrollment_device_id
       OR device.id IS NOT ledger.device_id OR device.paired_via_pairing_id IS NOT NULL
       OR owner.policy_version IS NOT ledger.policy_version
       OR owner.authorization_basis IS NOT ledger.authorization_basis`,
  `SELECT count(*) AS n FROM accountless_v11_device_authorizations grant_row
    WHERE NOT EXISTS (SELECT 1 FROM accountless_upload_owners owner
      WHERE owner.enrollment_device_id = grant_row.enrollment_device_id
        AND owner.participant_id = grant_row.participant_id
        AND owner.device_credential_id = grant_row.device_credential_id)`,
  `SELECT count(*) AS n FROM accountless_v12_device_authorizations grant_row
    WHERE NOT EXISTS (SELECT 1 FROM accountless_upload_owners owner
      WHERE owner.enrollment_device_id = grant_row.enrollment_device_id
        AND owner.participant_id = grant_row.participant_id
        AND owner.device_credential_id = grant_row.device_credential_id)`,
  `SELECT count(*) AS n FROM device_credentials device
     LEFT JOIN accountless_enrollment_ledger ledger ON ledger.device_id = device.accountless_enrollment_device_id
    WHERE device.authority_kind = 'accountless'
      AND (ledger.device_id IS NULL OR device.id IS NOT ledger.device_id)`,
]);

function accountlessChain(database) {
  for (const sql of CHAIN_VIOLATIONS) {
    const [row] = sourceAll(database, sql);
    if (row?.n !== 0n) fail("CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID");
  }
  const count = (sql) => Number(sourceAll(database, sql)[0].n);
  return Object.freeze({
    owners: count("SELECT count(*) AS n FROM accountless_upload_owners"),
    revokedOwners: count("SELECT count(*) AS n FROM accountless_upload_owners WHERE state = 'revoked'"),
    v11Grants: count("SELECT count(*) AS n FROM accountless_v11_device_authorizations"),
    v12Grants: count("SELECT count(*) AS n FROM accountless_v12_device_authorizations"),
    revokedLedgerRows: count("SELECT count(*) AS n FROM accountless_enrollment_ledger WHERE state = 'revoked'"),
  });
}

/** A content-free digest of a sealed table this stage cannot import, ordered by every column. */
function genericTableDigest(database, table) {
  const digest = createRowsDigest();
  const columns = sourceColumns(database, table);
  const statement = database.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}
    ORDER BY ${columns.map((_, index) => String(index + 1)).join(", ")}`);
  statement.setReadBigInts(true);
  let rows = 0;
  for (const row of statement.iterate()) {
    digest.update(Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value])));
    rows += 1;
  }
  return { rows, sha256: digest.digest() };
}

async function assertTargetLayout(client, schema, item) {
  const { rows } = await q(client, `SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, item.name], item.name);
  if (rows.length === 0) fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: item.name });
  const byName = new Map(rows.map(row => [row.column_name, row]));
  for (const column of item.spec.columns) {
    const row = byName.get(column.target);
    if (!row || !POSTGRES_FASTPATH_IDENTITY_TARGET_TYPES[column.type].includes(row.data_type) || row.is_generated === "ALWAYS") {
      fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: item.name, column: column.target });
    }
  }
  const mapped = new Set(item.spec.columns.map(column => column.target));
  for (const row of rows) {
    if (mapped.has(row.column_name)) continue;
    if (row.is_nullable === "NO" && row.column_default === null && row.is_identity !== "YES") {
      fail("CUTOVER_COLUMN_UNMAPPED", { table: item.name, column: IDENTIFIER.test(row.column_name) ? row.column_name : undefined });
    }
  }
}

async function assertFrozenOrder(client, schema) {
  const { rows } = await q(client, `SELECT child.relname::text AS child, parent.relname::text AS parent
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
      JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
     WHERE con.contype = 'f' AND child_ns.nspname = $1 AND child.relname = ANY($2::text[])`,
  [schema, [...IDENTITY_AUTHORITY_FROZEN_ORDER]]);
  for (const { child, parent } of rows) {
    if (child === parent) continue;
    const parentIndex = IDENTITY_AUTHORITY_FROZEN_ORDER.indexOf(parent);
    const childIndex = IDENTITY_AUTHORITY_FROZEN_ORDER.indexOf(child);
    // A parent outside the stage must already hold its rows (it never does
    // here: every referenced identity table is in the frozen order).
    if (parentIndex < 0 || parentIndex > childIndex) fail("CUTOVER_IMPORT_ORDER_INVALID", { table: child });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Target writes.

async function insertPage(client, schema, spec, rows) {
  const columns = spec.columns.map(column => quote(column.target)).join(", ");
  const width = spec.columns.length;
  const values = rows.map((_, rowIndex) => `(${spec.columns.map((__, columnIndex) =>
    `$${rowIndex * width + columnIndex + 1}`).join(", ")})`).join(", ");
  const result = await q(client, `INSERT INTO ${quote(schema)}.${quote(spec.name)} (${columns}) VALUES ${values}`,
    rows.flatMap(row => row.parameters), spec.name);
  if (result.rowCount !== rows.length) fail("CUTOVER_TARGET_WRITE_REFUSED", { table: spec.name });
}

/**
 * Rewrite one seeded row to its sealed values. The row is matched on the key
 * (or on matchColumns, which then stay untouched: a seeded identity such as
 * a transport format's rank must already equal the seal) and every other
 * column is set.
 */
async function updateByKey(client, schema, spec, row, { matchColumns = null, requireMatch = true } = {}) {
  const match = matchColumns ?? spec.key;
  const keyIndexes = match.map(key => spec.columns.findIndex(column => column.target === key));
  const assignments = spec.columns.map((column, index) => (match.includes(column.target) ? null
    : `${quote(column.target)} = $${index + 1}`)).filter(Boolean).join(", ");
  const where = keyIndexes.map(index => `${quote(spec.columns[index].target)} = $${index + 1}`).join(" AND ");
  const result = await q(client, `UPDATE ${quote(schema)}.${quote(spec.name)} SET ${assignments} WHERE ${where}`,
    row.parameters, spec.name);
  if (requireMatch && result.rowCount !== 1) fail("CUTOVER_SEEDED_ROW_UNMATCHED", { table: spec.name });
}

async function targetCount(client, schema, table) {
  const { rows } = await q(client, `SELECT count(*)::text AS n FROM ${quote(schema)}.${quote(table)}`, [], table);
  return Number(rows[0].n);
}

const TARGET_KEY_CASTS = Object.freeze({ text: "text", int: "bigint", instant: "timestamptz", day: "date" });
const TARGET_PAGE_ROWS = 2000;

/**
 * Digest of the target rows (restricted to the sealed keys for merged
 * seeds), read in keyset pages in the sealed key order: text keys compare
 * under COLLATE "C", which is SQLite's BINARY order for UTF-8.
 */
async function targetTableFacts(client, schema, item, keys = null) {
  const spec = item.spec;
  const keyColumns = spec.key.map(key => spec.columns.find(candidate => candidate.target === key));
  if (keyColumns.some(column => !Object.hasOwn(TARGET_KEY_CASTS, column.type))) fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  const collate = column => (column.type === "text" ? ` COLLATE "C"` : "");
  const list = [
    ...spec.columns.map(column => `${fastpathIdentityTargetExpression(column)} AS ${quote(column.target)}`),
    ...keyColumns.map((column, index) => `${quote(column.target)} AS "__key_${index}"`),
  ].join(", ");
  const order = keyColumns.map(column => `${quote(column.target)}${collate(column)}`).join(", ");
  const restrictionValues = keys === null ? [] : [keys];
  const restriction = keys === null ? [] : [`${quote(spec.key[0])} = ANY($1::text[])`];
  const digest = createRowsDigest();
  let rows = 0;
  let after = null;
  for (;;) {
    const conditions = [...restriction];
    const values = [...restrictionValues];
    if (after !== null) {
      const placeholders = keyColumns.map((column, index) =>
        `$${values.length + index + 1}::${TARGET_KEY_CASTS[column.type]}${collate(column)}`);
      conditions.push(`(${keyColumns.map(column => `${quote(column.target)}${collate(column)}`).join(", ")}) > (${placeholders.join(", ")})`);
      values.push(...after);
    }
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const result = await q(client, `SELECT ${list} FROM ${quote(schema)}.${quote(spec.name)}${where}
      ORDER BY ${order} LIMIT ${TARGET_PAGE_ROWS}`, values, spec.name);
    for (const row of result.rows) {
      digest.update(spec.columns.map(column => fastpathIdentityTargetValue(column.type, row[column.target], spec.name, column.target)));
      rows += 1;
    }
    if (result.rows.length < TARGET_PAGE_ROWS) break;
    const last = result.rows.at(-1);
    after = keyColumns.map((_, index) => last[`__key_${index}`]);
  }
  return { rows, sha256: digest.digest() };
}

function disposition(item) {
  return item.mode === "insert" ? `imported:${IDENTITY_AUTHORITY_STAGE}` : `mapped:${IDENTITY_AUTHORITY_STAGE}`;
}

function suppressList(item) {
  return Object.keys(item.suppress);
}

async function importTable({ handle, database, item, maxRows, maxBytes, onPage, sealed }) {
  const spec = item.spec;
  const schema = handle.primarySchema;
  const name = `table:${spec.name}`;
  const checkpoint = await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    return readCheckpoint(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, name });
  }, { readOnly: true });
  if (checkpoint?.state === "complete") {
    const present = await withTransferTransaction(handle, "primary",
      client => targetCount(client, schema, spec.name), { readOnly: true });
    if (item.mode === "insert" && present !== checkpoint.rowCount) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: spec.name });
    return { resumed: true, pages: 0 };
  }

  let pages = 0;
  if (item.mode !== "insert") {
    // Mapped seeds: one small page that rewrites the seeded rows.
    const facts = sourceTableFacts(database, spec, maxRows);
    const rows = [];
    let after = null;
    for (;;) {
      const page = readSourcePage(database, spec, after, maxRows);
      for (const { row, key } of page) {
        rows.push(canonicalRow(spec, row));
        after = key;
      }
      if (page.length < maxRows) break;
    }
    if (item.mode === "replace-singleton" && rows.length !== 1) fail("CUTOVER_SOURCE_SINGLETON_INVALID", { table: spec.name });
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await tableReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, sourceRole: "ingestion",
        sourceTable: spec.name, disposition: disposition(item), targetTable: spec.name, state: "started" });
      await recordCheckpoint(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, name, state: "pending",
        rowCount: rows.length, prefixChainSha256: facts.chain });
      for (const row of rows) await updateByKey(client, schema, spec, row, { matchColumns: item.matchColumns });
    });
    pages = 1;
    await onPage?.({ table: spec.name, page: pages, rows: rows.length });
    return { resumed: false, pages };
  }

  let committed = checkpoint?.rowCount ?? 0;
  let chain = checkpoint?.prefixChainSha256 ?? EMPTY_PREFIX_CHAIN;
  let after = null;
  if (committed > 0) {
    const prefix = sourcePrefix(database, spec, committed, maxRows);
    if (prefix.chain !== chain) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.name });
    after = prefix.after;
  }
  const present = await withTransferTransaction(handle, "primary",
    client => targetCount(client, schema, spec.name), { readOnly: true });
  if (present !== committed) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: spec.name });
  await sealed.verify();
  for (;;) {
    const page = pageOf(database, spec, after, maxRows, maxBytes);
    if (page.rows.length === 0) break;
    let nextChain = chain;
    for (const row of page.rows) nextChain = advancePrefixChain(nextChain, row.values);
    const expectedPrior = committed;
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      const current = await readCheckpoint(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, name });
      if ((current?.rowCount ?? 0) !== expectedPrior) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.name });
      if (expectedPrior === 0) {
        await tableReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, sourceRole: "ingestion",
          sourceTable: spec.name, disposition: disposition(item), targetTable: spec.name, state: "started" });
      }
      await recordCheckpoint(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, name, state: "pending",
        rowCount: expectedPrior + page.rows.length, prefixChainSha256: nextChain });
      const write = async () => {
        await insertPage(client, schema, spec, page.rows);
        if (item.derived === "input_versions") {
          const ids = page.rows.map(row => row.parameters[spec.columns.findIndex(column => column.target === "id")]);
          await q(client, `INSERT INTO ${quote(schema)}."input_versions"(participant_id, revision)
            SELECT participant_id, 0 FROM unnest($1::text[]) AS imported(participant_id)
            ON CONFLICT (participant_id) DO NOTHING`, [ids], "input_versions");
        }
      };
      const suppress = suppressList(item);
      if (suppress.length > 0) {
        await withTriggerPolicy(client, { schema, table: spec.name, suppress }, write);
      } else {
        await write();
      }
    });
    committed += page.rows.length;
    chain = nextChain;
    after = page.rows.at(-1).key;
    pages += 1;
    await onPage?.({ table: spec.name, page: pages, rows: page.rows.length });
  }
  return { resumed: committed > 0 && (checkpoint?.rowCount ?? 0) > 0, pages };
}

async function completeTable({ handle, database, item, source }) {
  const spec = item.spec;
  const schema = handle.primarySchema;
  const keys = item.mode === "merge-seeded"
    ? sourceAll(database, `SELECT ${quote(spec.key[0])} AS k FROM ${quote(spec.name)}`, [], spec.name).map(row => String(row.k))
    : null;
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    const target = await targetTableFacts(client, schema, item, keys);
    if (target.rows !== source.rows || target.sha256 !== source.sha256) {
      fail("CUTOVER_IDENTITY_TABLE_DIGEST_MISMATCH", { table: spec.name });
    }
    await recordCheckpoint(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, name: `table:${spec.name}`,
      state: "complete", rowCount: source.rows, prefixChainSha256: source.chain });
    await tableReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, sourceRole: "ingestion", sourceTable: spec.name,
      disposition: disposition(item), targetTable: spec.name, state: "complete", sourceRowCount: source.rows,
      sourceSha256: source.sha256, targetRowCount: target.rows, targetSha256: target.sha256 });
    return Object.freeze({ group: item.group, mode: item.mode, sourceRows: source.rows, targetRows: target.rows,
      bytes: source.bytes, sha256: source.sha256 });
  });
}

// ---------------------------------------------------------------------------
// The stage.

async function targetPreflight(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    const { rows } = await q(client, "SELECT storage_journal_transfer_session() AS transfer");
    if (rows[0]?.transfer !== true) fail("CUTOVER_TRANSFER_SESSION_REQUIRED");
    const coverage = await assertTriggerPolicyCoverage(client, handle.primarySchema, IDENTITY_TRIGGER_POLICY);
    const foreignKeys = await assertFrozenOrder(client, handle.primarySchema);
    for (const item of ENTRIES) await assertTargetLayout(client, handle.primarySchema, item);
    await assertTargetLayout(client, handle.primarySchema, { name: BOOTSTRAP_SPEC.name, spec: BOOTSTRAP_SPEC });
    return Object.freeze({ coverage, foreignKeys });
  }, { readOnly: true });
}

function validatePaging(pageRows, pageBytes) {
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > IDENTITY_AUTHORITY_MAX_PAGE_ROWS
      || !Number.isSafeInteger(pageBytes) || pageBytes < 1024 || pageBytes > IDENTITY_AUTHORITY_MAX_PAGE_BYTES) {
    fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  }
}

async function highWaterSequences(client, schema, counters) {
  const { rows } = await q(client, `SELECT DISTINCT c.relname::text AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
     ORDER BY 1`, [schema]);
  const byTarget = new Map(Object.entries(IDENTITY_AUTHORITY_COUNTER_MAPPING)
    .filter(([, mapping]) => mapping.target !== null).map(([counter, mapping]) => [mapping.target, counter]));
  return Object.fromEntries(rows.map(({ table_name: table }) => {
    const counter = byTarget.get(table);
    return [table, counter !== undefined && Object.hasOwn(counters, counter) ? counters[counter] : null];
  }));
}

/**
 * Run the identity-authority stage. `identityLinkPin` is the configured
 * {keyVersion, secretFingerprint} (the fingerprint of the deployed
 * IDENTITY_LINK_SECRET, computed by the owner; this tool never reads the
 * secret). `onPage` is a test hook called after each committed page.
 */
export async function runIdentityAuthorityTransfer({
  handle,
  sealManifestPath,
  identityLinkPin,
  pageRows = IDENTITY_AUTHORITY_MAX_PAGE_ROWS,
  pageBytes = IDENTITY_AUTHORITY_MAX_PAGE_BYTES,
  onPage = null,
} = {}) {
  validatePaging(pageRows, pageBytes);
  if (handle === null || typeof handle !== "object" || typeof handle.sealManifestSha256 !== "string") {
    fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  }
  if (onPage !== null && typeof onPage !== "function") fail("CUTOVER_IDENTITY_ARGUMENT_INVALID");
  const seal = await readCutoverSeal({ manifestPath: sealManifestPath, expectedSealId: handle.sealManifestSha256 });
  const sealed = await openSealedSourceFromSeal(seal, "ingestion");
  try {
    await sealed.verify();
    const database = sealed.database();
    // Preflight: everything that can refuse, before the first write.
    for (const item of ENTRIES) {
      assertSourceColumnMap(database, item.name, item.spec.columns.map(column => column.source));
    }
    for (const table of IDENTITY_AUTHORITY_TARGET_MISSING) {
      if (!sourceTablePresent(database, table)) fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
    }
    assertParticipantsQuiescent(database);
    const doNotRestore = await assertNoErasedParticipantRestored(seal, sealed);
    // Every sealed value is canonicalized (and the table digest taken) now,
    // so an invalid value refuses here rather than after earlier pages.
    const sourceFacts = new Map(ENTRIES.map(item => [item.name, sourceTableFacts(database, item.spec, pageRows)]));
    const counters = assertCounters(database);
    assertIdentityLinkPin(database, identityLinkPin);
    const bootstrap = sealedBootstrap(database);
    const controls = sealedControlsRow(database);
    const chain = accountlessChain(database);
    const target = await targetPreflight(handle);
    await sealed.verify();

    // Stage start: receipts, controls and the bootstrap singleton, in one
    // transaction (an invalid sealed controls row rolls it all back). A
    // replay of a completed stage writes no application row: it only proves
    // the controls are still degraded at the sealed revision and the
    // bootstrap still equals the seal (the receipt helpers are no-ops on
    // equal complete rows and refuse a conflicting one).
    const controlsRecord = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      const started = await stageReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, state: "started" });
      const recorded = await recordSealedCollectionControls(client, handle, controls);
      if (started.state === "complete") {
        await assertCollectionControlsDegradedForImport(client, handle);
      } else {
        await degradeCollectionControlsForImport(client, handle);
        const updated = await q(client, `UPDATE ${quote(handle.primarySchema)}."community_public_source_bootstrap"
            SET policy_version = $2, participant_cursor = $3, source_day_cursor = $4, completed = $5
          WHERE singleton = $1`, bootstrap.canonical.parameters, "community_public_source_bootstrap");
        if (updated.rowCount !== 1) fail("CUTOVER_SEEDED_ROW_UNMATCHED", { table: "community_public_source_bootstrap" });
      }
      const bootstrapTarget = await targetTableFacts(client, handle.primarySchema,
        { name: BOOTSTRAP_SPEC.name, spec: BOOTSTRAP_SPEC });
      const sourceDigest = createRowsDigest();
      sourceDigest.update(bootstrap.canonical.values);
      const bootstrapSha256 = sourceDigest.digest();
      if (bootstrapTarget.rows !== 1 || bootstrapTarget.sha256 !== bootstrapSha256) {
        fail("CUTOVER_IDENTITY_TABLE_DIGEST_MISMATCH", { table: "community_public_source_bootstrap" });
      }
      await tableReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, sourceRole: "ingestion",
        sourceTable: "community_public_source_bootstrap", disposition: `mapped:${IDENTITY_AUTHORITY_STAGE}`,
        targetTable: "community_public_source_bootstrap", state: "complete", sourceRowCount: 1,
        sourceSha256: bootstrapSha256, targetRowCount: 1, targetSha256: bootstrapTarget.sha256 });
      await tableReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, sourceRole: "ingestion",
        sourceTable: "collection_controls", disposition: `mapped:${IDENTITY_AUTHORITY_STAGE}`,
        targetTable: "collection_controls", state: "complete", sourceRowCount: 1,
        sourceSha256: recorded.sealedRowSha256 });
      return Object.freeze({ ...recorded, bootstrapSha256 });
    });

    const tables = {};
    const pages = {};
    for (const item of ENTRIES) {
      const imported = await importTable({ handle, database, item, maxRows: pageRows, maxBytes: pageBytes, onPage, sealed });
      pages[item.name] = imported.pages;
      tables[item.name] = await completeTable({ handle, database, item, source: sourceFacts.get(item.name) });
    }
    const targetMissing = Object.fromEntries(IDENTITY_AUTHORITY_TARGET_MISSING.map(table => {
      const facts = genericTableDigest(database, table);
      return [table, Object.freeze({ sourceRows: facts.rows, sha256: facts.sha256 })];
    }));
    await sealed.verify();

    const summary = {
      schema: IDENTITY_AUTHORITY_TRANSFER_SCHEMA,
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: identityAuthorityPolicySha256(),
      order: IDENTITY_AUTHORITY_FROZEN_ORDER,
      tables: Object.fromEntries(Object.entries(tables).map(([name, facts]) => [name, { rows: facts.sourceRows, sha256: facts.sha256 }])),
      controls: controlsRecord.sealedRowSha256,
      bootstrap: controlsRecord.bootstrapSha256,
      targetMissing,
      doNotRestore: { deletionDigests: doNotRestore.deletionDigests,
        deletionDigestsSha256: doNotRestore.deletionDigestsSha256 },
    };
    const receiptSha256 = HASH(JSON.stringify(summary));
    const rowCount = Object.values(tables).reduce((total, facts) => total + facts.sourceRows, 0) + 2;
    const byteCount = Object.values(tables).reduce((total, facts) => total + facts.bytes, 0);
    const finish = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      const sealedSequences = await highWaterSequences(client, handle.primarySchema, counters);
      const highWater = await applyIdentityHighWater(client, handle, { sealedSequences });
      for (const item of ENTRIES) {
        const columns = item.spec.columns.filter(column => column.type === "instant").map(column => column.target);
        if (columns.length > 0) await assertInstantRoundTrip(client, { schema: handle.primarySchema, table: item.name, columns });
      }
      const inputVersions = await targetCount(client, handle.primarySchema, "input_versions");
      await stageReceipt(client, handle, { stage: IDENTITY_AUTHORITY_STAGE, state: "complete", rowCount, byteCount,
        receiptSha256 });
      return { highWater, inputVersions };
    });
    await sealed.verify();
    return Object.freeze({
      schema: IDENTITY_AUTHORITY_TRANSFER_SCHEMA,
      stage: IDENTITY_AUTHORITY_STAGE,
      transferId: productionTransferId(IDENTITY_AUTHORITY_STAGE, seal.manifest.sealId),
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: summary.policySha256,
      receiptSha256,
      order: IDENTITY_AUTHORITY_FROZEN_ORDER,
      tables: Object.freeze(tables),
      pages: Object.freeze(pages),
      derived: Object.freeze({ input_versions: Object.freeze({ rows: finish.inputVersions }) }),
      controls: Object.freeze({ sealedRowSha256: controlsRecord.sealedRowSha256, revision: controlsRecord.revision,
        degraded: true }),
      bootstrap: Object.freeze({ sha256: controlsRecord.bootstrapSha256, cursorsCleared: bootstrap.cursorsCleared }),
      counters: Object.freeze(Object.fromEntries(Object.entries(counters).map(([counter, seq]) => [counter, Object.freeze({
        seq, target: IDENTITY_AUTHORITY_COUNTER_MAPPING[counter].target })]))),
      highWater: Object.freeze(finish.highWater.map(row => Object.freeze({ table: row.table, highWater: row.highWater }))),
      accountlessChain: chain,
      triggerPolicy: target.coverage,
      foreignKeysChecked: target.foreignKeys,
      targetMissing: Object.freeze(targetMissing),
      doNotRestore,
      excluded: IDENTITY_AUTHORITY_EXCLUDED_TABLES,
      rowCount,
      byteCount,
    });
  } catch (error) {
    if (error instanceof IdentityAuthorityTransferError || error instanceof PostgresTransferTargetError
        || error instanceof CutoverSourceError) {
      throw error;
    }
    return fail("CUTOVER_IDENTITY_TRANSFER_FAILED");
  } finally {
    sealed.close();
  }
}
