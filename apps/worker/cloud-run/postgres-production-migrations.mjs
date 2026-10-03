#!/usr/bin/env node

/**
 * OPS-10 production migration job, re-scoped for the GCP fast path.
 *
 * One manual Cloud Run Job execution migrates the PRIMARY role schema of one
 * environment and hands it to the runtime role:
 *
 *   1. validate the job context, environment and target (no metadata, no SQL);
 *   2. require the attached identity to be the configured migrator;
 *   3. read the image's primary migrations and refuse an unreviewed contract
 *      migration (CONTRACT_MIGRATIONS) or, for a non-scratch target, a
 *      manifest without the SIMP append-only residue;
 *   4. read the target's migration history read-only: a history ahead of the
 *      image is MIGRATION_STATE_NEWER_THAN_IMAGE, one that is not a prefix of
 *      it is MIGRATION_HISTORY_DIVERGED, and neither writes anything;
 *   5. ensureSchema, apply the image's primary migrations forward with the
 *      canonical runner, apply and read back the shared runtime-grant policy
 *      (postgres-runtime-grants.mjs) for a distinct DML-only runtime role,
 *      read the history back against the manifest, and check the runtime
 *      role's posture;
 *   6. print one content-free receipt, 'tibotattle-gcp-migration-v1'.
 *
 * Primary role only. Decisions D2, D4 and D6 (2026-09-26) remove the separate
 * deletion ledger: there is no ledger instance or schema in production, so
 * this job never reads, creates or migrates one and refuses any LEDGER_*
 * setting. The canonical runner and the image are primary-only (LEAD-SIMP).
 *
 * Ordering guard (D6): the promoted primary 0053 carries the analytics
 * erasure fences that the SIMP work removes with a forward migration. Until
 * an image's primary manifest contains that migration, every target that is
 * not a disposable '-rehearsal-xxxxxxxx' scratch instance is refused with
 * PRODUCTION_SIMP_RESIDUE_MISSING before any connection is opened. Its name
 * ends in SIMP_RESIDUE_MIGRATION_SUFFIX and its number comes after
 * SIMP_RESIDUE_PREDECESSOR, the last migration numbered before it (the
 * wave-2 integration promoted primary 0063, so the residue is
 * NNNN_append_only_residue.sql with NNNN >= 0064). LEAD-SIMP lands it as
 * 0064_append_only_residue.sql, the name and number the owner confirmed
 * (wave-3 SIMP OD-1, 2026-10-02).
 *
 * Expand-compatibility: the migrate step runs while the previous revision
 * still serves, so a migration that drops, renames or tightens (SET NOT NULL,
 * or a NOT NULL column without a default) is a contract change. Each one must
 * be listed, with its sha256, in the reviewed CONTRACT_MIGRATIONS map; the
 * promoted tail 0001-0072 is classified once below. That review covers the
 * SQL a previous revision issues, not its storage fence. The runtime receipt
 * fence (the one reader, src/postgres-schema-receipt.ts readSchemaReceipt,
 * behind the origin's storage gate in postgres-test-dispatch.mjs) admits a
 * migration history only when it equals the image's manifest exactly, so
 * behind it a revision built before a migration answers every storage-gated
 * route 503 BACKEND_STORAGE_UNAVAILABLE from migrate until the roll. The
 * owner accepted that short write outage on each migration, with a storage
 * gate TTL of 0 (OD-ROLL / OD-CR-10, 2026-10-02), so the production host
 * (D-CRB) keeps the exact-match fence and never admits a newer history.
 *
 * Identity: the attached identity is read through google-auth-library's
 * Application Default Credentials (the metadata server on Cloud Run, which
 * that library calls with and checks the Metadata-Flavor header). A key-file
 * identity (GOOGLE_APPLICATION_CREDENTIALS) is refused, so the identity the
 * job checks is the one the Cloud SQL connector authenticates with.
 *
 * Errors carry only a code. Nothing logs a row, a payload, a credential or a
 * driver message.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPostgresMigrations, readPostgresMigrations } from "./postgres-migrations.mjs";
import {
  ensureSchema,
  functionSignature,
  grantAndVerifyRuntimePrivileges,
  isRuntimeGrantError,
  MIGRATION_HISTORY_TABLE,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  readBackReceipts,
  RUNTIME_PRIMARY_FUNCTIONS,
  runtimeGrantPolicyDigest,
} from "./postgres-runtime-grants.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";

export const PRODUCTION_MIGRATION_RECEIPT_SCHEMA = "tibotattle-gcp-migration-v1";
export const PRODUCTION_PRIMARY_MANIFEST_SCHEMA = "tibotattle-postgres-primary-manifest-v1";
export const PRODUCTION_MIGRATIONS_ROOT = "/app/apps/worker/postgres/migrations";
export const PRODUCTION_MIGRATION_ENVIRONMENTS = Object.freeze(["production", "staging"]);
export const PRODUCTION_MIGRATIONS_CODE_PREFIX = "POSTGRES_PRODUCTION_MIGRATIONS_";

/**
 * The job definition OPS-3 renders (single-sourced here): a manual job run as
 * the migrator service account, one task, no retries, 30 minutes, one primary
 * pool of one connection.
 */
export const PRODUCTION_MIGRATION_JOB = Object.freeze({
  name: "production-migrate",
  entry: "dist/production-migrations.mjs",
  schedule: "manual",
  serviceAccount: "migrator",
  tasks: 1,
  parallelism: 1,
  maxRetries: 0,
  taskTimeoutSeconds: 1800,
  pools: Object.freeze({ primary: 1 }),
  // The operator-set env validateProductionMigrationEnvironment reads, in the
  // order OPS-2 renders it; Cloud Run supplies CLOUD_RUN_*. No LEDGER_* and no
  // GOOGLE_APPLICATION_CREDENTIALS (both refused).
  env: Object.freeze([
    "MIGRATION_ENVIRONMENT", "GOOGLE_CLOUD_PROJECT", "PRODUCTION_MIGRATOR_SERVICE_ACCOUNT",
    "POSTGRES_MIGRATOR_IAM_USER", "POSTGRES_RUNTIME_IAM_USER", "ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME",
    "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "DEPLOYMENT_SOURCE_COMMIT",
  ]),
});

/** A disposable rehearsal instance id: never a production or staging target. */
export const SCRATCH_INSTANCE_PATTERN = /-rehearsal-[a-z0-9]{8}b?$/u;
/** The SIMP forward migration that removes the 0053 erasure fences ends with this. */
export const SIMP_RESIDUE_MIGRATION_SUFFIX = "_append_only_residue.sql";
/** The promoted migration whose erasure fences the SIMP residue must follow. */
export const SIMP_FENCED_MIGRATION = "0053_community_publication_authority.sql";
/**
 * The last primary migration numbered before the SIMP residue (the wave-2
 * integration's numbering): the residue's number must come after it.
 */
export const SIMP_RESIDUE_PREDECESSOR = "0063_enrollment_grants_erased_redeemer.sql";

/** Contract operation kinds, in report order. */
export const CONTRACT_OPERATION_KINDS = Object.freeze([
  "drop",
  "rename",
  "set-not-null",
  "add-not-null-without-default",
  "alter-type",
  "add-constraint",
  "unique-index",
  "dynamic-sql",
]);

/**
 * Reviewed contract migrations of the promoted primary tail (0001-0072),
 * classified with classifyContractOperations and pinned by sha256. A
 * production, staging or scratch database receives this tail in its first
 * migrate, onto an empty schema before any revision serves it, so none of
 * them can break a serving previous revision there; each reason records what
 * the operation does, including where it tightens. A migration after the tail
 * runs between migrate and roll while the previous revision still serves, so
 * its SQL must be safe against that revision, and it (the SIMP residue
 * included) must be added here, reviewed, before any image carrying it can
 * migrate a target. A reason speaks to the SQL only: whether the previous
 * revision's receipt fence admits the longer history is CR-7's requirement
 * (module header).
 */
export const CONTRACT_MIGRATIONS = Object.freeze({
  "0008_pending_object_reconciliation.sql": Object.freeze({
    sha256: "c43fc6b4ef4b1592a60798a50eddf683973a10df6844aa42a7c88b351ea3ce7e",
    operations: Object.freeze(["dynamic-sql"]),
    reason: "EXECUTE only inside the chunk reconciliation-guard trigger function: a schema-qualified SELECT ... FOR UPDATE of the pending object at insert time; no dynamic SQL runs during the migration",
  }),
  "0010_v1_analytical_side_effects.sql": Object.freeze({
    sha256: "60a5a159610bb4e627382a0ac4ae4292e78e75bd269b67fbc91f70d0f88c62e5",
    operations: Object.freeze(["dynamic-sql"]),
    reason: "EXECUTE only inside the replaced reconciliation-guard trigger function (the same pending-object row lock, counted); no dynamic SQL runs during the migration",
  }),
  "0014_effective_source_revision.sql": Object.freeze({
    sha256: "ad124ecdc7b008e18c11a7faf45886c666b7ca42b40322089d597641a515ed3c",
    operations: Object.freeze(["drop"]),
    reason: "DROP TRIGGER IF EXISTS before re-creating the same source-revision triggers in one transaction",
  }),
  "0016_publication_authority.sql": Object.freeze({
    sha256: "a97c64175d4af12a2b06782007491c7acb9da2364003cc09110e7b5356b31b9d",
    operations: Object.freeze(["drop", "add-constraint", "unique-index"]),
    reason: "promotes the contained revision-0 collection-controls bootstrap to 1, then re-creates collection_controls_revision_check as revision >= 1 (tightened from >= 0; any other revision-0 row aborts the migration); the unique index covers pending_objects.registration_token, added here with a fresh random md5 default per row",
  }),
  "0017_readiness_sweep_fence.sql": Object.freeze({
    sha256: "96ad7866bb6083a2f0e0415c6a86a7a4efe492310a1fced1606c5c012493986c",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "replaces postgres_readiness_sweeps_state_check with the same-named check widened to admit 'ledger'",
  }),
  "0023_analytics_fit_results.sql": Object.freeze({
    sha256: "3cd6cfbdff5ed8a9c8da56f6f3b03343049655952b7169a989f8fb09cbcbd43a",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "replaces analytics_owner_results_metric_check with the same-named check widened to admit 'fits'",
  }),
  "0026_v12_domain_days_and_input_revision.sql": Object.freeze({
    sha256: "7e15b4d82b196e1ad8b6ef98c253e91f6204921d2f54207ab3346a8cf0a025e5",
    operations: Object.freeze(["drop", "add-constraint", "unique-index"]),
    reason: "re-creates the domain-day manifest foreign key under the same name, deferred; DROP NOT NULL only relaxes; the predecessor single-representation check admits every earlier row (winners_json set, the new days_json NULL); the generation unique index narrows uniqueness from (participant, device, manifest) to (participant, manifest), a tightening an earlier writer could hit",
  }),
  "0029_legacy_source_membership.sql": Object.freeze({
    sha256: "c8d9bb75659705492d3d14f23570ad3207677e75b17b27f032ccfd6c24b15c87",
    operations: Object.freeze(["add-constraint"]),
    reason: "the membership UNIQUE includes the primary key id, so every existing and future row already satisfies it; it backs a composite foreign key",
  }),
  "0035_v12_ready_manifest_retention.sql": Object.freeze({
    sha256: "a3fb5f597f7e202b7803a5345f52f4a1a2285fc56cc2c5d119c0b2a2571a0872",
    operations: Object.freeze(["drop"]),
    reason: "drops only the temporary upgrade-audit table the migration itself creates",
  }),
  "0036_streamed_publication_proofs.sql": Object.freeze({
    sha256: "136645a7a262d756813c43f305930c8cf5435ab5415ef8bad3c38a6c3e07dee8",
    operations: Object.freeze(["add-constraint"]),
    reason: "the member proof-shape check admits a row whose three new proof columns are NULL, which is every row an earlier writer makes",
  }),
  "0038_analytics_event_tuple_versions.sql": Object.freeze({
    sha256: "c20e692d07cd16ae5f870832610ce6bdf7b97eb734fe4ed96b821fdd85757b2f",
    operations: Object.freeze(["add-constraint"]),
    reason: "both tuple-version checks admit version 0 with every new column NULL, the default for every row an earlier writer makes",
  }),
  "0039_analytics_applied_projection_v1.sql": Object.freeze({
    sha256: "5750810077d5a9124e8605007b514e841136177f88db473905cec289ff833ecc",
    operations: Object.freeze(["add-constraint"]),
    reason: "relaxes projection_json to NULL only for version-1 tuples; version-0 rows, the only ones an earlier writer makes, keep projection_json",
  }),
  "0043_accountless_history_d1_import.sql": Object.freeze({
    sha256: "417709f265294a547d7585617241922bf633042a141d08dbf51f418dcd653b00",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "replaces two import-run checks with same-named checks widened to the D1 snapshot source and target version 43; the fence-state and fence-metadata checks admit the synthetic-fixture rows at the new columns' defaults",
  }),
  "0046_owner_journal_authority.sql": Object.freeze({
    sha256: "ca26390533fdc9a053319a9e128ef94a074a44037e9e581f56b2a1f4e90be062",
    operations: Object.freeze(["unique-index"]),
    reason: "the partial unique index covers only event_tuple_version = 1 rows, which no earlier writer makes; version-0 rows are outside it",
  }),
  "0049_lifecycle_readiness_state.sql": Object.freeze({
    sha256: "6f2770085b9a6b0b1e068312685e09a24594178f92327d89a98d37279a38bb22",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "converts the 'idle' retention singleton to 'never_run', then replaces the 0007 state check with the Worker vocabulary and adds failure-code, failed-cycle, lease-pair and counter checks; a row outside that contract aborts the migration, and a writer of the 0007 'idle' state would be refused",
  }),
  "0050_admin_audit_and_collection_controls.sql": Object.freeze({
    sha256: "234e455574620c19041dcd4a3ee19947b9b4db346190aaaa3a8c5406ad50cc81",
    operations: Object.freeze(["drop", "set-not-null", "add-constraint"]),
    reason: "re-keys admin_action_audit on a backfilled identity id with operation_id unique and shape-checked, and closes collection_controls.reason_code and its state flags after backfilling the bootstrap row; a non-vocabulary row aborts the migration",
  }),
  "0051_transport_floor_parity.sql": Object.freeze({
    sha256: "1f36dc7558ab85b8a90a05530efeca23abad432c9808a32a7515e7c412c591bd",
    operations: Object.freeze(["add-constraint", "unique-index"]),
    reason: "closes the transport floors to the four ranked formats and one floor per device, as the D1 isolation schema enforces; a store holding a rank-12 floor or a duplicate device floor refuses the migration; the rollback foreign key targets the operation_id 0050 made unique",
  }),
  "0052_typed_telemetry_live_allocators.sql": Object.freeze({
    sha256: "8257867f0c707a30f57f1bf16c21c2012f89108a7e4d0abe9e4926976e58a093",
    operations: Object.freeze(["dynamic-sql"]),
    reason: "the migration calls typed_telemetry_restart_identities() once: it locks the nine typed tables and restarts each id identity at max(id) + 1, never lower; the runtime role cannot execute it",
  }),
  "0053_community_publication_authority.sql": Object.freeze({
    sha256: "dd3f7f293d63295688ced56a558befa5f2018a85a61304c8cab9e0df6993ae15",
    operations: Object.freeze(["add-constraint"]),
    reason: "the daily authority-shape check admits provenance NULL with every new column NULL, which is every row an earlier writer makes",
  }),
  "0055_v12_owner_bridge.sql": Object.freeze({
    sha256: "bd6027ef988dea6c9a34a9c8fb494c33bc8d820bdd77c5e165ada3bcdd627681",
    operations: Object.freeze(["drop"]),
    reason: "replaces the v1.2 domain-head source-revision trigger with the owner bridge in one transaction",
  }),
  "0056_production_transfer_control.sql": Object.freeze({
    sha256: "bfc8637b903b33ec02b07f087f3b5345edd4fbcab7ebcb08d732b846edc0e346",
    operations: Object.freeze(["dynamic-sql"]),
    reason: "EXECUTE only inside tibotattle_transfer.install_transfer_live_lock(), which the migration defines but never calls; the transfer tool calls it on its own schema once a run is live",
  }),
  "0057_upload_path_analytics_retirement.sql": Object.freeze({
    sha256: "439cbf18d64fdcaa2ea33ab34762d99471b2214e176c8f695c8b444d69043faa",
    operations: Object.freeze(["drop"]),
    reason: "retires the upload-path analytics triggers and functions that the shipped analytics no longer read",
  }),
  "0061_legacy_contribution_admission.sql": Object.freeze({
    sha256: "9a22c0f0fa4b1dc1c0694cb2020b89546ede6c8cc6e949b4cb6e87b42465c5c8",
    operations: Object.freeze(["drop"]),
    reason: "replaces the participant-limit trigger with legacy contribution admission in one transaction",
  }),
  "0063_enrollment_grants_erased_redeemer.sql": Object.freeze({
    sha256: "0341b5a6b7165b918e7e18c11873243aff4906a81a8376a0ae46ec5f14007ce9",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "replaces 0015's enrollment_grants_check1 (aborting unless its definition is exactly 0015's) with a state-shape check that only stops requiring the redeemer of a redeemed grant, which every existing row satisfies, plus a trigger that refuses a redeemed grant without a redeemer with the same 23514 class except on an INSERT inside an import transfer session; at the SQL level every write a previous revision makes (issue with every field NULL, redeem with a redeemer, a participant delete's SET NULL) is admitted or refused as before; a previous revision behind an exact-history receipt fence still refuses the migrated schema until the roll (module header)",
  }),
  // LEAD-SIMP append-only residue; name and number final (owner decision
  // OD-1, 2026-10-02).
  "0064_append_only_residue.sql": Object.freeze({
    sha256: "74fb4aed9c0b1eef7f1433e9e0ea6501bdb8beedffefa17a928ad7774cce37be",
    operations: Object.freeze(["drop", "add-constraint"]),
    reason: "drops the 0053 erasure fences, receipts, terminal watermarks and floor (the daily and preview fence functions are replaced without the floor in the same transaction), the participant-erasure lease index, the re-enrollment cooldowns, the readiness sweeps and the PT-1 contract's ledger columns, and pins retention_state to restore_replay_complete and zero suppressed participants; a residue row, a non-zero watermark, a retention row outside the pins or a contract registered with ledger columns aborts it with nothing changed. On production, staging and scratch targets the whole tail including this migration lands in the first migrate onto an empty schema, so only test targets ever apply it under a serving revision, and there the exact-history receipt fence already makes that revision refuse every storage-gated route until the roll (module header); a previous revision reaches a dropped object in two places: the cloud-run-iam Google enrollment's cooldown read, mounted only when the cloud-run-iam dependency is present, which no fast-path, edge-test or production composition mounts, and the server.mjs --scheduled maintenance (behind POSTGRES_SCHEDULED_MAINTENANCE_ENABLED), whose identity purge deletes expired rows of the primary re-enrollment cooldown table and so, after this migration, fails closed with outcome failure and POSTGRES_MAINTENANCE_UNAVAILABLE having purged only expired sign-in handoffs and run none of its later phases; no repository tooling deploys or schedules --scheduled; the pinned retention values are the 0049 seed and no PostgreSQL writer changes them",
  }),
  // K-CORE-A's analytics_v2 run stamps (K-STAMP and N-EXCL), staged as 0911
  // and promoted as 0069 at the K-CORE-A merge (2026-10-03).
  "0069_analytics_v2_run_stamps.sql": Object.freeze({
    sha256: "97d4ef47627dec182f61eb5f94478e5cd2e5f87d6044d891f4d756155170e59d",
    operations: Object.freeze(["drop"]),
    reason: "the only DROP is DROP DEFAULT on the manifest_version columns this migration adds to the seven stamped analytics_v2 tables (the default stamps rows written before it as manifest 1 without an UPDATE, so 0059's forward-only trigger never fires); it also adds the append-only analytics_v2_kernels table, nullable kernel_id and compatibility and exclusions digest columns, and NOT VALID checks that leave earlier rows unattributed, and it aborts with nothing changed unless every stored run is mode full. After it every insert or update of a stamped row must name kernel_id and manifest_version. The only writer of those tables is the analytics refresh Job's single write transaction (src/analytics-v2/store.ts); a previous image's refresh run between migrate and roll omits both, is refused by the manifest_version NOT NULL (or the kernel check) and rolls back with nothing written, and the next run of the rolled image writes. The origin, the admin preview, the ops probe and the interim public read loader only read these tables, by named columns. On production, staging and scratch targets the whole tail including this migration lands in the first migrate onto an empty schema; a previous revision behind an exact-history receipt fence still refuses the migrated schema until the roll (module header)",
  }),
});

const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const JOB_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const REGION_PATTERN = /^[a-z]+-[a-z]+[0-9]{1,2}$/u;
const INSTANCE_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const IAM_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const SERVICE_ACCOUNT_SUFFIX = ".iam.gserviceaccount.com";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const MIGRATOR_APPLICATION_NAME = "tibotattle-production-migrator";
const RESERVED_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema", "public"]);
// Schema-name families the test deployments own (A2, fast path, graph
// benchmark, typed-legacy and identity rehearsal targets). A production or
// staging schema never starts with one.
const TEST_SCHEMA_PREFIXES = Object.freeze([
  "tibotattle_v12_a2_",
  "tibotattle_ledger_v12_a2_",
  "tibotattle_fastpath_",
  "tibotattle_graph_benchmark_",
  "typed_legacy_transfer_rehearsal_target_",
]);
const TEST_DATABASES = new Set(["tibotattle_fastpath"]);

const OWN_ERRORS = new WeakSet();

function fail(code) {
  const error = Object.assign(new Error(code), { code });
  OWN_ERRORS.add(error);
  throw error;
}

const PASS_THROUGH_CODE = /^(?:MIGRATION_STATE_NEWER_THAN_IMAGE|MIGRATION_HISTORY_DIVERGED|PRODUCTION_SIMP_RESIDUE_MISSING|PRODUCTION_MIGRATION_CONTRACT_[A-Z_]+|(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_PRODUCTION_MIGRATIONS_[A-Z0-9_]+|POSTGRES_MIGRATION_[A-Z0-9_]+)$/u;

/** The error's code when it is one of this job's content-free codes, else `fallback`. */
export function safeProductionMigrationErrorCode(error, fallback = "POSTGRES_PRODUCTION_MIGRATIONS_FAILED") {
  return typeof error?.code === "string" && PASS_THROUGH_CODE.test(error.code) ? error.code : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Sorted-key JSON, so digests do not depend on construction order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Contract classification

/**
 * The SQL with comments removed and every string literal and quoted
 * identifier blanked, keeping dollar-quoted bodies (function code) visible.
 */
function sqlKeywords(sql) {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index, index + 2);
    if (rest === "--") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      output += " ";
      continue;
    }
    if (rest === "/*") {
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith("/*", index)) { depth += 1; index += 2; continue; }
        if (sql.startsWith("*/", index)) { depth -= 1; index += 2; if (depth === 0) break; continue; }
        index += 1;
      }
      output += " ";
      continue;
    }
    const character = sql[index];
    if (character === "'") {
      const escapes = /[Ee]$/u.test(sql.slice(Math.max(0, index - 1), index))
        && !/[A-Za-z0-9_]/u.test(sql[index - 2] ?? "");
      index += 1;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") { index += 2; continue; }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      output += " '' ";
      continue;
    }
    if (character === '"') {
      const end = sql.indexOf('"', index + 1);
      index = end < 0 ? sql.length : end + 1;
      output += " _quoted_ ";
      continue;
    }
    if (character === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (tag !== undefined) {
        // A dollar-quote delimiter; the body between is function code, lexed as SQL.
        index += tag.length;
        output += " ";
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

/** The clause of an ADD at `start`: up to the next top-level comma or semicolon. */
function clauseFrom(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) return text.slice(start, index);
      depth -= 1;
    } else if (depth === 0 && (character === "," || character === ";")) {
      return text.slice(start, index);
    }
  }
  return text.slice(start);
}

const NON_COLUMN_ADD = new Set([
  "CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE", "VALUE", "GENERATED",
]);

const TABLE_NAME = String.raw`([A-Z_][A-Z0-9_]*(?:\.[A-Z_][A-Z0-9_]*)?)`;

/**
 * Tables a plain CREATE TABLE (no IF NOT EXISTS) makes in this migration: they
 * cannot exist before it, so the previous revision never writes them. A
 * blanked quoted identifier (_QUOTED_) is never a name.
 */
function tablesCreatedHere(text) {
  const names = new Set();
  for (const match of text.matchAll(new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?!IF\b)${TABLE_NAME}`, "gu"))) {
    if (!match[1].includes("_QUOTED_")) names.add(match[1]);
  }
  return names;
}

/** The table of the ALTER TABLE statement an ADD at `index` belongs to, or null. */
function alteredTable(text, index) {
  let table = null;
  for (const match of text.slice(0, index).matchAll(
    new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_NAME}`, "gu"),
  )) {
    table = { name: match[1], end: match.index + match[0].length };
  }
  return table !== null && !text.slice(table.end, index).includes(";") ? table.name : null;
}

/**
 * The contract operations one migration's SQL performs: tightening or
 * removing changes the previous revision, still serving between migrate and
 * roll, could fail on. Returned as a sorted subset of CONTRACT_OPERATION_KINDS.
 * Detection is lexical and deliberately broad:
 *   drop          every DROP of an object (DROP NOT NULL only relaxes);
 *   rename        every RENAME;
 *   set-not-null  every SET NOT NULL;
 *   add-not-null-without-default
 *                 every added column that is NOT NULL without a DEFAULT or
 *                 generation expression;
 *   alter-type    every column type change (ALTER [COLUMN] c [SET DATA] TYPE);
 *   add-constraint
 *                 every CHECK, UNIQUE, PRIMARY KEY, FOREIGN KEY or EXCLUDE
 *                 constraint added to a table by ALTER TABLE without NOT
 *                 VALID (UNIQUE, PRIMARY KEY and EXCLUDE cannot be NOT VALID),
 *                 or added outside an ALTER TABLE (a domain);
 *   unique-index  every CREATE UNIQUE INDEX;
 *   dynamic-sql   every EXECUTE of a statement (string literals are blanked
 *                 here, so dynamic SQL is never read and is reviewed instead;
 *                 GRANT EXECUTE ON and trigger EXECUTE FUNCTION/PROCEDURE are
 *                 not dynamic SQL).
 * A constraint or unique index on a table that a plain CREATE TABLE makes in
 * the same migration is not a contract operation: that table is new.
 *
 * Not detected, so left to migration review: a constraint declared inline on
 * an added column (the previous revision writes NULL or the column's default
 * there), and behaviour changes inside trigger or function bodies
 * (CREATE TRIGGER, CREATE OR REPLACE FUNCTION).
 */
export function classifyContractOperations(sql) {
  if (typeof sql !== "string") fail("PRODUCTION_MIGRATION_CONTRACT_INPUT_INVALID");
  const text = sqlKeywords(sql).toUpperCase();
  const created = tablesCreatedHere(text);
  const kinds = new Set();
  if (/\bDROP\s+(?!NOT\s+NULL\b)[A-Z]/u.test(text)) kinds.add("drop");
  if (/\bRENAME\b/u.test(text)) kinds.add("rename");
  if (/\bSET\s+NOT\s+NULL\b/u.test(text)) kinds.add("set-not-null");
  for (const match of text.matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Z_][A-Z0-9_]*)\b/gu)) {
    if (NON_COLUMN_ADD.has(match[1])) continue;
    const clause = clauseFrom(text, match.index);
    if (/\bNOT\s+NULL\b/u.test(clause) && !/\bDEFAULT\b|\bGENERATED\b/u.test(clause)) {
      kinds.add("add-not-null-without-default");
    }
  }
  if (/\bALTER\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?[A-Z_][A-Z0-9_]*\s+(?:SET\s+DATA\s+)?TYPE\b/u.test(text)) {
    kinds.add("alter-type");
  }
  for (const match of text.matchAll(
    /\bADD\s+(?:CONSTRAINT\s+[A-Z_][A-Z0-9_]*\s+)?(?:CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b/gu,
  )) {
    if (/\bNOT\s+VALID\b/u.test(clauseFrom(text, match.index))) continue;
    const table = alteredTable(text, match.index);
    if (table === null || !created.has(table)) kinds.add("add-constraint");
  }
  // A unique index whose table cannot be read is a contract operation too.
  const uniqueIndexes = [...text.matchAll(/\bCREATE\s+UNIQUE\s+INDEX\b/gu)].length;
  const indexedTables = [...text.matchAll(new RegExp(String.raw`\bCREATE\s+UNIQUE\s+INDEX(?:\s+CONCURRENTLY)?`
    + String.raw`(?:\s+IF\s+NOT\s+EXISTS)?(?:\s+(?!ON\b)[A-Z_][A-Z0-9_]*)?\s+ON\s+(?:ONLY\s+)?${TABLE_NAME}`, "gu"))]
    .map((match) => match[1]);
  if (indexedTables.length !== uniqueIndexes || indexedTables.some((table) => !created.has(table))) {
    kinds.add("unique-index");
  }
  if (/\bEXECUTE\b(?!\s+(?:ON|FUNCTION|PROCEDURE)\b)/u.test(text)) kinds.add("dynamic-sql");
  return Object.freeze(CONTRACT_OPERATION_KINDS.filter((kind) => kinds.has(kind)));
}

/**
 * Require every contract migration in `migrations` to be reviewed in
 * `contractMap` with its exact sha256 and operations, and every map entry to
 * name a migration of the manifest that still performs those operations.
 * Returns the number of reviewed contract migrations.
 */
export function assertExpandCompatible(migrations, contractMap = CONTRACT_MIGRATIONS) {
  if (!Array.isArray(migrations) || contractMap === null || typeof contractMap !== "object") {
    fail("PRODUCTION_MIGRATION_CONTRACT_INPUT_INVALID");
  }
  const names = new Set();
  let reviewed = 0;
  for (const migration of migrations) {
    names.add(migration?.name);
    const operations = classifyContractOperations(migration?.sql);
    const entry = Object.hasOwn(contractMap, migration.name) ? contractMap[migration.name] : undefined;
    if (operations.length === 0) {
      if (entry !== undefined) fail("PRODUCTION_MIGRATION_CONTRACT_MAP_STALE");
      continue;
    }
    if (entry === undefined || entry.sha256 !== migration.sha256
        || !Array.isArray(entry.operations)
        || entry.operations.join(",") !== operations.join(",")
        || typeof entry.reason !== "string" || entry.reason.length === 0) {
      fail("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED");
    }
    reviewed += 1;
  }
  if (Object.keys(contractMap).some((name) => !names.has(name))) {
    fail("PRODUCTION_MIGRATION_CONTRACT_MAP_STALE");
  }
  return reviewed;
}

// ---------------------------------------------------------------------------
// Manifest

/** sha256 of the canonical primary-only manifest ({version, name, bytes, sha256} per migration). */
export function primaryManifestSha256(migrations) {
  return sha256(canonicalJson({
    schema: PRODUCTION_PRIMARY_MANIFEST_SCHEMA,
    primary: migrations.map(({ version, name, bytes, sha256: digest }) => ({ version, name, bytes, sha256: digest })),
  }));
}

/** Validate one role's migration list as readPostgresMigrations returns it. */
export function validatePrimaryMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_MANIFEST_INVALID");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === null || typeof migration !== "object"
        || migration.role !== "primary"
        || migration.version !== index + 1
        || !MIGRATION_NAME_PATTERN.test(migration.name ?? "")
        || !migration.name.startsWith(String(index + 1).padStart(4, "0"))
        || typeof migration.sql !== "string"
        || !Number.isSafeInteger(migration.bytes)
        || Buffer.byteLength(migration.sql) !== migration.bytes
        || !SHA256_PATTERN.test(migration.sha256 ?? "")
        || sha256(migration.sql) !== migration.sha256) {
      fail("POSTGRES_PRODUCTION_MIGRATIONS_MANIFEST_INVALID");
    }
  }
  return migrations;
}

/**
 * The SIMP append-only residue migration of the manifest, or null: the first
 * migration named '*_append_only_residue.sql' that comes after both the
 * fenced 0053 and SIMP_RESIDUE_PREDECESSOR. A manifest missing either anchor
 * has no residue.
 */
export function simpResidueMigration(migrations) {
  const names = migrations.map(({ name }) => name);
  const fenced = names.indexOf(SIMP_FENCED_MIGRATION);
  const predecessor = names.indexOf(SIMP_RESIDUE_PREDECESSOR);
  if (fenced === -1 || predecessor === -1) return null;
  const floor = Math.max(fenced, predecessor);
  const residue = migrations.filter(({ name }, index) => index > floor && name.endsWith(SIMP_RESIDUE_MIGRATION_SUFFIX));
  return residue.length === 0 ? null : residue[0];
}

// ---------------------------------------------------------------------------
// Configuration

const TEST_INSTANCE_CONNECTION_NAMES = new Set([
  CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
  CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.instanceConnectionName,
]);
const TEST_SCHEMAS = new Set([
  CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema,
  CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema,
]);
const TEST_IAM_USERS = new Set([CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser]);

function tokens(value) {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/**
 * True when a value names a test deployment resource: one of its exact
 * identities, a test-token instance or IAM identity (the test estate names
 * every instance and service account tibotattle-test-*), or a test schema
 * or database family.
 */
export function isTestTargetValue(kind, value) {
  if (typeof value !== "string") return false;
  if (kind === "instance") {
    const id = value.split(":").at(-1) ?? "";
    return TEST_INSTANCE_CONNECTION_NAMES.has(value) || tokens(id).includes("test");
  }
  if (kind === "schema") {
    return TEST_SCHEMAS.has(value) || TEST_SCHEMA_PREFIXES.some((prefix) => value.startsWith(prefix));
  }
  if (kind === "database") return TEST_DATABASES.has(value);
  if (kind === "iam") {
    const local = value.split("@", 1)[0] ?? "";
    return TEST_IAM_USERS.has(value) || TEST_IAM_USERS.has(value.replace(/\.gserviceaccount\.com$/u, ""))
      || tokens(local).includes("test");
  }
  return false;
}

function required(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || !pattern.test(value)) fail(`POSTGRES_PRODUCTION_MIGRATIONS_${name}_INVALID`);
  return value;
}

function iamUserFromServiceAccount(email) {
  return email.slice(0, -".gserviceaccount.com".length);
}

function instanceParts(value) {
  const [project, region, instance, ...rest] = value.split(":");
  if (rest.length > 0 || !PROJECT_PATTERN.test(project ?? "") || !REGION_PATTERN.test(region ?? "")
      || !INSTANCE_ID_PATTERN.test(instance ?? "")) {
    return null;
  }
  return { project, region, instance };
}

/**
 * Validate the job environment without touching metadata or SQL. The target
 * is the environment's configured primary instance, or a disposable
 * '-rehearsal-xxxxxxxx' scratch instance in the same project and region;
 * never a test instance, schema, database or identity, never a ledger.
 */
export function validateProductionMigrationEnvironment(env) {
  if (env === null || typeof env !== "object") fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID");
  const job = env.CLOUD_RUN_JOB;
  if (typeof job !== "string" || !JOB_NAME_PATTERN.test(job)
      || !tokens(job).includes("migrate") || tokens(job).includes("test")
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID");
  }
  if (Object.keys(env).some((name) => name.startsWith("LEDGER_"))) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN");
  }
  if (Object.hasOwn(env, "GOOGLE_APPLICATION_CREDENTIALS")) {
    fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_KEY_CREDENTIALS_FORBIDDEN");
  }
  const environment = env.MIGRATION_ENVIRONMENT;
  if (!PRODUCTION_MIGRATION_ENVIRONMENTS.includes(environment)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INVALID");
  }
  const project = required(env, "GOOGLE_CLOUD_PROJECT", PROJECT_PATTERN);
  const migratorServiceAccount = env.PRODUCTION_MIGRATOR_SERVICE_ACCOUNT;
  if (typeof migratorServiceAccount !== "string"
      || !migratorServiceAccount.endsWith(`@${project}${SERVICE_ACCOUNT_SUFFIX}`)
      || !IAM_USER_PATTERN.test(iamUserFromServiceAccount(migratorServiceAccount))
      || Buffer.byteLength(iamUserFromServiceAccount(migratorServiceAccount), "utf8") > 63) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_MIGRATOR_SERVICE_ACCOUNT_INVALID");
  }
  const migratorIamUser = iamUserFromServiceAccount(migratorServiceAccount);
  if (env.POSTGRES_MIGRATOR_IAM_USER !== migratorIamUser) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_MIGRATOR_IAM_USER_INVALID");
  }
  const runtimeIamUser = required(env, "POSTGRES_RUNTIME_IAM_USER", IAM_USER_PATTERN);
  if (Buffer.byteLength(runtimeIamUser, "utf8") > 63 || runtimeIamUser === migratorIamUser) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_IAM_USER_INVALID");
  }
  if (isTestTargetValue("iam", migratorServiceAccount) || isTestTargetValue("iam", runtimeIamUser)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_TEST_TARGET_FORBIDDEN");
  }
  const configuredInstance = env.ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME;
  const instance = env.PRIMARY_INSTANCE_CONNECTION_NAME;
  const configured = typeof configuredInstance === "string" ? instanceParts(configuredInstance) : null;
  const target = typeof instance === "string" ? instanceParts(instance) : null;
  if (configured === null) fail("POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME_INVALID");
  if (target === null) fail("POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_INSTANCE_CONNECTION_NAME_INVALID");
  if (isTestTargetValue("instance", configuredInstance) || isTestTargetValue("instance", instance)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_TEST_TARGET_FORBIDDEN");
  }
  // The plane marker convention of postgres-production-configuration.mjs: a
  // staging resource carries the 'staging' token and never 'production'; a
  // production resource never carries 'staging'. Neither is a rehearsal.
  const configuredTokens = tokens(configured.instance);
  if (configured.project !== project || SCRATCH_INSTANCE_PATTERN.test(configured.instance)
      || configuredTokens.includes("rehearsal")
      || (environment === "staging"
        ? !configuredTokens.includes("staging") || configuredTokens.includes("production")
        : configuredTokens.includes("staging"))) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID");
  }
  let kind;
  if (instance === configuredInstance) {
    kind = "environment";
  } else if (SCRATCH_INSTANCE_PATTERN.test(target.instance)
      && target.project === configured.project && target.region === configured.region) {
    kind = "scratch";
  } else {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_TARGET_NOT_CONFIGURED");
  }
  const database = required(env, "PRIMARY_DATABASE", DATABASE_PATTERN);
  const schema = required(env, "PRIMARY_SCHEMA", SCHEMA_PATTERN);
  if (RESERVED_SCHEMAS.has(schema) || schema.startsWith("pg_")) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_SCHEMA_INVALID");
  }
  if (isTestTargetValue("schema", schema) || isTestTargetValue("database", database)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_TEST_TARGET_FORBIDDEN");
  }
  const sourceCommit = required(env, "DEPLOYMENT_SOURCE_COMMIT", COMMIT_PATTERN);
  return deepFreeze({
    job,
    execution: env.CLOUD_RUN_EXECUTION,
    environment,
    project,
    migratorServiceAccount,
    migratorIamUser,
    runtimeIamUser,
    sourceCommit,
    target: { kind, instanceConnectionName: instance, region: target.region, database, schema },
  });
}

/** The validated configuration once the attached identity is known. */
export function parseProductionMigrationConfig(env, attachedServiceAccountEmail) {
  const config = validateProductionMigrationEnvironment(env);
  if (attachedServiceAccountEmail !== config.migratorServiceAccount) {
    fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

/**
 * The attached identity through Application Default Credentials. On Cloud
 * Run that is the metadata server (google-auth-library checks its
 * Metadata-Flavor response header); a key file is refused above.
 */
export async function readAttachedServiceAccountEmail({ createAuth } = {}) {
  let credentials;
  try {
    const auth = createAuth === undefined
      ? new (await import("google-auth-library")).GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      })
      : createAuth();
    credentials = await auth.getCredentials();
  } catch {
    fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_IDENTITY_UNAVAILABLE");
  }
  const email = credentials?.client_email;
  if (typeof email !== "string" || !email.endsWith(SERVICE_ACCOUNT_SUFFIX)) {
    fail("CLOUD_RUN_PRODUCTION_MIGRATIONS_IDENTITY_UNAVAILABLE");
  }
  return email;
}

// ---------------------------------------------------------------------------
// History versus manifest (read-only)

/**
 * Compare a target's migration history with the image's primary manifest.
 * A history that is not a prefix of the manifest is diverged; a longer one
 * that is otherwise a prefix belongs to a newer image. Neither is ever
 * written to.
 */
export function compareHistoryToManifest(history, migrations) {
  if (!Array.isArray(history)) fail("MIGRATION_HISTORY_DIVERGED");
  for (let index = 0; index < history.length; index += 1) {
    const row = history[index];
    if (row === null || typeof row !== "object" || row.version !== index + 1
        || typeof row.name !== "string" || typeof row.checksum_sha256 !== "string") {
      fail("MIGRATION_HISTORY_DIVERGED");
    }
    const migration = migrations[index];
    if (migration !== undefined
        && (row.name !== migration.name || row.checksum_sha256 !== migration.sha256)) {
      fail("MIGRATION_HISTORY_DIVERGED");
    }
  }
  if (history.length > migrations.length) fail("MIGRATION_STATE_NEWER_THAN_IMAGE");
  return Object.freeze({ applied: history.length, pending: migrations.length - history.length });
}

function rowsFrom(result, code) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail(code);
  }
  return result.rows;
}

/** The schema's history in a read-only transaction; [] when schema or table is absent. */
export async function readPrimaryHistory(pool, schema) {
  if (typeof schema !== "string" || !SCHEMA_PATTERN.test(schema)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_SCHEMA_INVALID");
  }
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const presence = rowsFrom(await client.query(
      "SELECT to_regnamespace($1) IS NOT NULL AS schema_present, to_regclass($2) IS NOT NULL AS history_present",
      [schema, `${schema}.${MIGRATION_HISTORY_TABLE}`],
    ), "POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_READ_FAILED")[0];
    let history = [];
    if (presence?.schema_present === true && presence?.history_present === true) {
      history = rowsFrom(await client.query(
        `SELECT version, name, checksum_sha256
           FROM "${schema}"."${MIGRATION_HISTORY_TABLE}"
          ORDER BY version`,
      ), "POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_READ_FAILED");
    } else if (presence?.schema_present !== true && presence?.schema_present !== false) {
      fail("POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_READ_FAILED");
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return history;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail("POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_ROLLBACK_FAILED");
      }
    }
    if (OWN_ERRORS.has(error)) throw error;
    fail("POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_READ_FAILED");
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail("POSTGRES_PRODUCTION_MIGRATIONS_HISTORY_RELEASE_FAILED");
      }
    }
  }
}

/**
 * Production-only posture of the runtime role beyond the shared grant
 * read-back: it exists, holds no cluster attribute (superuser, CREATEROLE,
 * CREATEDB, REPLICATION, BYPASSRLS), is not a member of the migrator, cannot
 * create in the database, does not own the schema, and holds no TRUNCATE,
 * REFERENCES, TRIGGER or MAINTAIN privilege on any relation of it.
 */
export async function verifyRuntimeRolePosture(pool, { schema, runtimeRole, migratorRole }) {
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    const rows = rowsFrom(await client.query(
      `SELECT
         r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
         pg_has_role($1, $2, 'MEMBER') AS member_of_migrator,
         has_database_privilege($1, current_database(), 'CREATE') AS database_create,
         (SELECT pg_get_userbyid(ns.nspowner) = $1 FROM pg_namespace ns WHERE ns.nspname = $3) AS owns_schema,
         (SELECT count(*)::integer
            FROM pg_class rel
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $3 AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (has_table_privilege($1, rel.oid, 'TRUNCATE')
               OR has_table_privilege($1, rel.oid, 'REFERENCES')
               OR has_table_privilege($1, rel.oid, 'TRIGGER')
               OR has_table_privilege($1, rel.oid, 'MAINTAIN'))) AS extra_table_privileges
         FROM pg_roles r
        WHERE r.rolname = $1`,
      [runtimeRole, migratorRole, schema],
    ), "POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_READ_FAILED");
    const row = rows[0];
    if (rows.length !== 1
        || row.rolsuper !== false || row.rolcreaterole !== false || row.rolcreatedb !== false
        || row.rolreplication !== false || row.rolbypassrls !== false
        || row.member_of_migrator !== false || row.database_create !== false
        || row.owns_schema !== false || row.extra_table_privileges !== 0) {
      fail("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_INVALID");
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_ROLLBACK_FAILED");
      }
    }
    if (OWN_ERRORS.has(error)) throw error;
    fail("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_READ_FAILED");
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_RELEASE_FAILED");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt

const RECEIPT_KEYS = Object.freeze([
  "schema", "status", "environment", "job", "sourceCommit", "target", "migrations", "roles",
  "runtimeGrants", "ledger", "digest",
]);
const TARGET_KEYS = Object.freeze(["kind", "instanceConnectionName", "database", "schema"]);
const MIGRATIONS_KEYS = Object.freeze([
  "role", "count", "latest", "manifestSha256", "historySha256", "contractReviewed", "simpResidue",
]);
const LATEST_KEYS = Object.freeze(["version", "name", "sha256"]);
const ROLES_KEYS = Object.freeze(["migrator", "runtime"]);
const GRANTS_KEYS = Object.freeze(["policySha256", "executableFunctions", "operatorOnlyClosed"]);

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** sha256 of the canonical receipt without its digest. */
export function productionMigrationReceiptDigest(receipt) {
  const { digest: _ignored, ...body } = receipt;
  return sha256(canonicalJson(body));
}

function historySha256(history) {
  return sha256(canonicalJson(history.map(({ version, name, sha256: digest }) => ({ version, name, sha256: digest }))));
}

function buildReceipt({ config, migrations, contractReviewed, residue }) {
  const latest = migrations.at(-1);
  const body = {
    schema: PRODUCTION_MIGRATION_RECEIPT_SCHEMA,
    status: "ok",
    environment: config.environment,
    job: config.job,
    sourceCommit: config.sourceCommit,
    target: {
      kind: config.target.kind,
      instanceConnectionName: config.target.instanceConnectionName,
      database: config.target.database,
      schema: config.target.schema,
    },
    migrations: {
      role: "primary",
      count: migrations.length,
      latest: { version: latest.version, name: latest.name, sha256: latest.sha256 },
      manifestSha256: primaryManifestSha256(migrations),
      historySha256: historySha256(migrations),
      contractReviewed,
      simpResidue: residue?.name ?? null,
    },
    roles: { migrator: config.migratorIamUser, runtime: config.runtimeIamUser },
    runtimeGrants: {
      policySha256: runtimeGrantPolicyDigest(),
      executableFunctions: RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature),
      operatorOnlyClosed: OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature),
    },
    ledger: "not-migrated",
  };
  return deepFreeze({ ...body, digest: productionMigrationReceiptDigest(body) });
}

/**
 * Validate a 'tibotattle-gcp-migration-v1' receipt (for example one read
 * back from the job's log) against the closed schema and its digest.
 * Returns the frozen receipt or throws POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID.
 */
export function verifyProductionMigrationReceipt(receipt) {
  const ok = hasExactKeys(receipt, RECEIPT_KEYS)
    && receipt.schema === PRODUCTION_MIGRATION_RECEIPT_SCHEMA
    && receipt.status === "ok"
    && PRODUCTION_MIGRATION_ENVIRONMENTS.includes(receipt.environment)
    && typeof receipt.job === "string" && JOB_NAME_PATTERN.test(receipt.job)
    && typeof receipt.sourceCommit === "string" && COMMIT_PATTERN.test(receipt.sourceCommit)
    && hasExactKeys(receipt.target, TARGET_KEYS)
    && (receipt.target.kind === "environment" || receipt.target.kind === "scratch")
    && typeof receipt.target.instanceConnectionName === "string"
    && instanceParts(receipt.target.instanceConnectionName) !== null
    // A scratch target is exactly a '-rehearsal-xxxxxxxx' instance and an
    // environment target never is (validateProductionMigrationEnvironment),
    // so the kind cannot be relabelled now that every manifest carries the
    // SIMP residue.
    && (receipt.target.kind === "scratch")
      === SCRATCH_INSTANCE_PATTERN.test(instanceParts(receipt.target.instanceConnectionName).instance)
    && typeof receipt.target.database === "string" && DATABASE_PATTERN.test(receipt.target.database)
    && typeof receipt.target.schema === "string" && SCHEMA_PATTERN.test(receipt.target.schema)
    && hasExactKeys(receipt.migrations, MIGRATIONS_KEYS)
    && receipt.migrations.role === "primary"
    && Number.isSafeInteger(receipt.migrations.count) && receipt.migrations.count > 0
    && hasExactKeys(receipt.migrations.latest, LATEST_KEYS)
    && receipt.migrations.latest.version === receipt.migrations.count
    && MIGRATION_NAME_PATTERN.test(receipt.migrations.latest.name ?? "")
    && SHA256_PATTERN.test(receipt.migrations.latest.sha256 ?? "")
    && SHA256_PATTERN.test(receipt.migrations.manifestSha256 ?? "")
    && SHA256_PATTERN.test(receipt.migrations.historySha256 ?? "")
    && Number.isSafeInteger(receipt.migrations.contractReviewed) && receipt.migrations.contractReviewed >= 0
    && (receipt.migrations.simpResidue === null
      || (typeof receipt.migrations.simpResidue === "string"
        && receipt.migrations.simpResidue.endsWith(SIMP_RESIDUE_MIGRATION_SUFFIX)))
    && (receipt.target.kind === "scratch" || receipt.migrations.simpResidue !== null)
    && hasExactKeys(receipt.roles, ROLES_KEYS)
    && typeof receipt.roles.migrator === "string" && IAM_USER_PATTERN.test(receipt.roles.migrator)
    && typeof receipt.roles.runtime === "string" && IAM_USER_PATTERN.test(receipt.roles.runtime)
    && receipt.roles.migrator !== receipt.roles.runtime
    && hasExactKeys(receipt.runtimeGrants, GRANTS_KEYS)
    && receipt.runtimeGrants.policySha256 === runtimeGrantPolicyDigest()
    && canonicalJson(receipt.runtimeGrants.executableFunctions)
      === canonicalJson(RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature))
    && canonicalJson(receipt.runtimeGrants.operatorOnlyClosed)
      === canonicalJson(OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature))
    && receipt.ledger === "not-migrated"
    && typeof receipt.digest === "string" && SHA256_PATTERN.test(receipt.digest)
    && receipt.digest === productionMigrationReceiptDigest(receipt);
  if (!ok) fail("POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID");
  return deepFreeze(structuredClone(receipt));
}

// ---------------------------------------------------------------------------
// Job

function validateApplyResult(result, schema, migrations) {
  if (result === null || typeof result !== "object" || result.role !== "primary"
      || result.schema !== schema || result.applied !== migrations.length
      || !Array.isArray(result.migrations) || result.migrations.length !== migrations.length
      || result.migrations.some((entry, index) => entry?.version !== migrations[index].version
        || entry?.name !== migrations[index].name || entry?.sha256 !== migrations[index].sha256)) {
    fail("POSTGRES_PRODUCTION_MIGRATIONS_APPLY_RECEIPT_INVALID");
  }
}

async function defaultCreateConnector() {
  const { Connector } = await import("@google-cloud/cloud-sql-connector");
  return new Connector();
}

async function defaultCreatePool(options) {
  const { createIamPool } = await import("./cloud-sql.mjs");
  return createIamPool(options);
}

async function defaultCloseResources(resources) {
  const { closeCloudSqlResources } = await import("./cloud-sql.mjs");
  return closeCloudSqlResources(resources);
}

/**
 * Run the job. `dependencies` replace the image's seams in tests:
 * readServiceAccountEmail, readMigrations, rootDirectory, createConnector,
 * createPool, applyMigrations, closeResources.
 */
export async function runProductionMigrations({ env = process.env, dependencies = {} } = {}) {
  // Reject wrong jobs and targets before identity, manifest or SQL access.
  validateProductionMigrationEnvironment(env);
  const attached = await (dependencies.readServiceAccountEmail ?? readAttachedServiceAccountEmail)();
  const config = parseProductionMigrationConfig(env, attached);
  const rootDirectory = dependencies.rootDirectory ?? PRODUCTION_MIGRATIONS_ROOT;
  let migrations;
  try {
    migrations = validatePrimaryMigrations(await (dependencies.readMigrations ?? readPostgresMigrations)({
      role: "primary",
      rootDirectory,
    }));
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail("POSTGRES_PRODUCTION_MIGRATIONS_MANIFEST_INVALID");
  }
  // The residue gate first: an image without it is reported as such, even
  // though CONTRACT_MIGRATIONS (which reviews the residue) would also call
  // its manifest stale.
  const residue = simpResidueMigration(migrations);
  if (config.target.kind !== "scratch" && residue === null) fail("PRODUCTION_SIMP_RESIDUE_MISSING");
  const contractReviewed = assertExpandCompatible(migrations, dependencies.contractMigrations ?? CONTRACT_MIGRATIONS);

  const createConnector = dependencies.createConnector ?? defaultCreateConnector;
  const createPool = dependencies.createPool ?? defaultCreatePool;
  const applyMigrations = dependencies.applyMigrations ?? applyPostgresMigrations;
  const closeResources = dependencies.closeResources ?? defaultCloseResources;
  let connector;
  let pool;
  let receipt;
  let operationError;
  try {
    try {
      connector = await createConnector();
    } catch {
      fail("CLOUD_SQL_PRODUCTION_MIGRATIONS_CONNECTOR_CREATE_FAILED");
    }
    try {
      pool = await createPool({
        connector,
        instanceConnectionName: config.target.instanceConnectionName,
        database: config.target.database,
        user: config.migratorIamUser,
        max: PRODUCTION_MIGRATION_JOB.pools.primary,
        applicationName: MIGRATOR_APPLICATION_NAME,
      });
    } catch {
      fail("CLOUD_SQL_PRODUCTION_MIGRATIONS_PRIMARY_CONNECT_FAILED");
    }
    const { schema } = config.target;
    compareHistoryToManifest(await readPrimaryHistory(pool, schema), migrations);
    const grantOptions = { role: "primary", schema, codePrefix: PRODUCTION_MIGRATIONS_CODE_PREFIX };
    await ensureSchema(pool, { ...grantOptions, ownerRole: config.migratorIamUser });
    let applied;
    try {
      applied = await applyMigrations({ role: "primary", schema, pool, rootDirectory });
    } catch (error) {
      fail(safeProductionMigrationErrorCode(error, "POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_APPLY_FAILED"));
    }
    validateApplyResult(applied, schema, migrations);
    await grantAndVerifyRuntimePrivileges(pool, { ...grantOptions, runtimeRole: config.runtimeIamUser });
    await readBackReceipts(pool, {
      ...grantOptions,
      expected: migrations.map(({ version, name, sha256: digest }) => ({ version, name, sha256: digest })),
    });
    await verifyRuntimeRolePosture(pool, {
      schema,
      runtimeRole: config.runtimeIamUser,
      migratorRole: config.migratorIamUser,
    });
    receipt = buildReceipt({ config, migrations, contractReviewed, residue });
  } catch (error) {
    operationError = OWN_ERRORS.has(error) || isRuntimeGrantError(error)
      ? error
      : Object.assign(new Error("POSTGRES_PRODUCTION_MIGRATIONS_FAILED"), {
        code: "POSTGRES_PRODUCTION_MIGRATIONS_FAILED",
      });
  }
  let cleanupError;
  try {
    await closeResources({ pools: pool === undefined ? [] : [pool], connector });
  } catch {
    cleanupError = Object.assign(new Error("CLOUD_SQL_PRODUCTION_MIGRATIONS_CLEANUP_FAILED"), {
      code: "CLOUD_SQL_PRODUCTION_MIGRATIONS_CLEANUP_FAILED",
    });
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return receipt;
}

function invokedDirectly() {
  return typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "error", code: "CLOUD_RUN_PRODUCTION_MIGRATIONS_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await runProductionMigrations()));
    } catch (error) {
      console.error(JSON.stringify({ status: "error", code: safeProductionMigrationErrorCode(error) }));
      process.exitCode = 1;
    }
  }
}
