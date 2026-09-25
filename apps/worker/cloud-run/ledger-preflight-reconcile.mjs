#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
} from "./cloud-sql.mjs";

export const LEDGER_PREFLIGHT_RECONCILE_JOB =
  "tibotattle-test-ledger-preflight-reconcile";
export const LEDGER_PREFLIGHT_RECONCILE_PROJECT = "tibotattle";
export const LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT =
  "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com";
export const LEDGER_PREFLIGHT_RECONCILE_IAM_USER =
  "tibotattle-test-migrator@tibotattle.iam";
export const LEDGER_PREFLIGHT_RECONCILE_MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
// Pinned from the named synthetic-development maintenance Job's configured
// POSTGRES_SOURCE_ID and POSTGRES_SOURCE_NAMESPACE, without recording either
// raw identifier in this image or its receipt.
export const LEDGER_PREFLIGHT_RECONCILE_SOURCE_PIN_SHA256 =
  "04788696fd8ad7482ace2f9d3950f75bb56e7bc7e5389c47466db231dfe2be8a";
export const LEDGER_PREFLIGHT_RECONCILE_TARGETS = Object.freeze({
  primary: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle",
  }),
  ledger: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
    database: "tibotattle_ledger",
    schema: "tibotattle_ledger",
  }),
});

const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIGRATION_HISTORY = "_tibotattle_migration_history";
const EXPECTED_LEDGER_MIGRATION_COUNT = 6;
const EXPECTED_MIGRATION_RECEIPTS_BEFORE = 5;
const EXPECTED_UNPROVEN_JOB_COUNT = 15;
const MIGRATOR_APPLICATION_NAME = "tibotattle-test-ledger-preflight-reconcile";
const MIGRATION_LOCK_KEY = "tibotattle:ledger:tibotattle_ledger";

const JOB_PREFLIGHT_SQL = (schema) => `
  SELECT count(*)::text AS total_rows,
         count(*) FILTER (WHERE job.state = 'complete'
           AND job.terminal_json IS NULL AND job.completed_at IS NOT NULL)::text AS complete_unproven,
         count(*) FILTER (WHERE job.state = 'pending'
           AND job.terminal_json IS NULL AND job.completed_at IS NULL)::text AS pending_unverified,
         count(*) FILTER (WHERE job.state NOT IN ('pending', 'complete')
           OR (job.state = 'pending' AND job.completed_at IS NOT NULL)
           OR (job.state = 'complete' AND job.completed_at IS NULL))::text AS invalid_state_timestamp,
         count(*) FILTER (WHERE length(job.source_namespace) NOT BETWEEN 1 AND 256)::text AS invalid_source_namespace,
         count(*) FILTER (WHERE job.source_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$')::text AS invalid_source_id,
         count(*) FILTER (WHERE job.terminal_json IS NOT NULL AND (
           length(job.terminal_json) > 65536 OR NOT pg_input_is_valid(job.terminal_json, 'json')
         ))::text AS invalid_terminal_json,
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM ${schema}.deletion_tombstones tombstone
            WHERE tombstone.participant_digest = job.participant_digest
         ))::text AS missing_tombstone_parent
    FROM ${schema}.storage_erasure_jobs job
`;

const LEDGER_METADATA_PREFLIGHT_SQL = (schema) => `
  SELECT
    (SELECT count(*)::text FROM ${schema}.deletion_tombstones
      WHERE schema_version <> 'participant-deletion-tombstone-v0.1'
         OR retain_until <= deleted_at) AS invalid_tombstones,
    (SELECT count(*)::text FROM ${schema}.identity_reenrollment_cooldowns
      WHERE schema_version <> 'identity-reenrollment-cooldown-v0.1'
         OR retain_until <= deleted_at) AS invalid_cooldowns
`;

const JOB_ROWS_SQL = (schema) => `
  SELECT participant_digest, source_id, owner_digest, state,
         terminal_json IS NULL AS terminal_is_null,
         CASE WHEN completed_at IS NULL THEN NULL
           ELSE to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS completed_at_utc
    FROM ${schema}.storage_erasure_jobs
   ORDER BY participant_digest, source_id, owner_digest
`;

const SYNTHETIC_RECEIPTS_SQL = (schema) => `
  SELECT participant_digest, operation_id, outcome, details_json,
         completed_at IS NOT NULL AS has_completion_time
    FROM ${schema}.participant_erasure_receipts
   ORDER BY participant_digest, operation_id
`;

const SAFE_DIAGNOSTIC_COUNT_KEYS = new Set([
  "migrationReceiptsMatched",
  "sourcePinRows",
  "v1AdmissionRows",
  "v11AdmissionRows",
  "jobsTotal",
  "jobsSourceMismatched",
  "ledgerNamespaceCount",
  "syntheticReceiptMatches",
  "completeUnproven",
  "pendingUnverified",
  "invalidStateTimestamp",
  "invalidSourceNamespace",
  "invalidSourceId",
  "invalidTerminalJson",
  "missingTombstoneParent",
  "invalidTombstones",
  "invalidCooldowns",
]);

function fail(code, safeCounts) {
  const error = Object.assign(new Error(code), { code });
  if (safeCounts !== undefined && safeCounts !== null && typeof safeCounts === "object") {
    const diagnostics = Object.create(null);
    for (const [key, value] of Object.entries(safeCounts)) {
      if (SAFE_DIAGNOSTIC_COUNT_KEYS.has(key)
          && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) {
        diagnostics[key] = value;
      }
    }
    if (Object.keys(diagnostics).length > 0) error.safeCounts = Object.freeze(diagnostics);
  }
  throw error;
}

function quoteSchema(value) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SCHEMA_INVALID");
  }
  return `"${value}"`;
}

function validateContext(env) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== LEDGER_PREFLIGHT_RECONCILE_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== LEDGER_PREFLIGHT_RECONCILE_PROJECT
      || !["inspect", "apply"].includes(env.LEDGER_RECONCILE_MODE)
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_JOB_CONTEXT_INVALID");
  }
  if (env.POSTGRES_MIGRATOR_IAM_USER !== LEDGER_PREFLIGHT_RECONCILE_IAM_USER) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_IAM_USER_INVALID");
  }
  for (const role of ["primary", "ledger"]) {
    const target = LEDGER_PREFLIGHT_RECONCILE_TARGETS[role];
    const prefix = role === "primary" ? "PRIMARY" : "LEDGER";
    if (env[`${prefix}_INSTANCE_CONNECTION_NAME`] !== target.instanceConnectionName
        || env[`${prefix}_DATABASE`] !== target.database
        || env[`${prefix}_SCHEMA`] !== target.schema) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_TARGET_INVALID");
    }
  }
  return Object.freeze({
    job: LEDGER_PREFLIGHT_RECONCILE_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    mode: env.LEDGER_RECONCILE_MODE,
    project: LEDGER_PREFLIGHT_RECONCILE_PROJECT,
    iamUser: LEDGER_PREFLIGHT_RECONCILE_IAM_USER,
    primary: LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary,
    ledger: LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger,
  });
}

export function parseLedgerPreflightReconcileConfig(env, attachedServiceAccountEmail) {
  const config = validateContext(env);
  if (attachedServiceAccountEmail !== LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

export async function readAttachedLedgerReconcileServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_METADATA_UNAVAILABLE");
  }
  let response;
  try {
    response = await fetchImpl(METADATA_EMAIL_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_METADATA_UNAVAILABLE");
  }
  if (email !== LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_LEDGER_RECONCILE_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function rowsFrom(result, code) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail(code);
  }
  return result.rows;
}

function parseCount(value, code = "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID") {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
}

function expectedReceiptRows(migrations) {
  if (!Array.isArray(migrations) || migrations.length !== EXPECTED_LEDGER_MIGRATION_COUNT) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_MANIFEST_INVALID");
  }
  const firstFive = migrations.slice(0, EXPECTED_MIGRATION_RECEIPTS_BEFORE);
  for (let index = 0; index < firstFive.length; index += 1) {
    const migration = firstFive[index];
    if (migration === null || typeof migration !== "object"
        || migration.role !== "ledger"
        || migration.version !== index + 1
        || typeof migration.name !== "string"
        || !/^\d{4}_[a-z][a-z0-9_-]*\.sql$/u.test(migration.name)
        || !SHA256_PATTERN.test(migration.sha256 ?? "")) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_MANIFEST_INVALID");
    }
  }
  return firstFive.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
}

function validateMigrationReceipts(rows, expected) {
  if (rows.length !== EXPECTED_MIGRATION_RECEIPTS_BEFORE
      || expected.length !== EXPECTED_MIGRATION_RECEIPTS_BEFORE) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_MIGRATION_RECEIPTS_INVALID", {
      migrationReceiptsMatched: 0,
    });
  }
  let matched = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = rows[index];
    const wanted = expected[index];
    if (actual?.version === wanted.version
        && actual?.name === wanted.name
        && actual?.checksum_sha256 === wanted.sha256) {
      matched += 1;
    }
  }
  if (matched !== EXPECTED_MIGRATION_RECEIPTS_BEFORE) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_MIGRATION_RECEIPTS_INVALID", {
      migrationReceiptsMatched: matched,
    });
  }
}

function stableOperationId(participantDigest) {
  if (!SHA256_PATTERN.test(participantDigest ?? "")) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID");
  }
  const source = participantDigest.slice(0, 32).split("");
  source[12] = "4";
  source[16] = ((Number.parseInt(source[16], 16) & 0x3) | 0x8).toString(16);
  const hex = source.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function countSyntheticReceiptMatches(jobRows, receiptRows) {
  const receiptsByParticipant = new Map();
  for (const receipt of receiptRows) {
    if (receipt === null || typeof receipt !== "object"
        || typeof receipt.participant_digest !== "string") {
      continue;
    }
    const rows = receiptsByParticipant.get(receipt.participant_digest) ?? [];
    rows.push(receipt);
    receiptsByParticipant.set(receipt.participant_digest, rows);
  }
  let matches = 0;
  for (const job of jobRows) {
    let operationId;
    try { operationId = stableOperationId(job.participant_digest); } catch { continue; }
    const receipt = (receiptsByParticipant.get(job.participant_digest) ?? [])
      .find((candidate) => candidate.operation_id === operationId);
    let details;
    try { details = JSON.parse(receipt?.details_json); } catch { continue; }
    const exactKeys = details !== null && typeof details === "object" && !Array.isArray(details)
      && Object.keys(details).sort().join(",") === "objectCount,ownerDigest,phase,schemaVersion";
    if (receipt && receipt.outcome === "completed" && receipt.has_completion_time === true
        && exactKeys
        && details.schemaVersion === "postgres-synthetic-owner-erasure-v1"
        && details.phase === "completed"
        && details.ownerDigest === job.owner_digest
        && Number.isSafeInteger(details.objectCount) && details.objectCount >= 0) {
      matches += 1;
    }
  }
  return matches;
}

function assertLegacyCohortHasNoOwnerCompletionProof(jobRows, receiptRows) {
  const matches = countSyntheticReceiptMatches(jobRows, receiptRows);
  // The named test ledger has no synthetic v1.2 owner-erasure receipt for these
  // unproven jobs. A matching receipt changes the provenance question; stop rather
  // than silently treating a proven and an unproven job as the same cohort.
  if (matches !== 0 || jobRows.length !== EXPECTED_UNPROVEN_JOB_COUNT) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID", {
      jobsTotal: jobRows.length,
      syntheticReceiptMatches: matches,
    });
  }
  return matches;
}

function validateJobPreflight(row) {
  if (row === null || typeof row !== "object") {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
  }
  const counts = Object.freeze({
    totalRows: parseCount(row.total_rows),
    completeUnproven: parseCount(row.complete_unproven),
    pendingUnverified: parseCount(row.pending_unverified),
    invalidStateTimestamp: parseCount(row.invalid_state_timestamp),
    invalidSourceNamespace: parseCount(row.invalid_source_namespace),
    invalidSourceId: parseCount(row.invalid_source_id),
    invalidTerminalJson: parseCount(row.invalid_terminal_json),
    missingTombstoneParent: parseCount(row.missing_tombstone_parent),
  });
  return counts;
}

function allOtherMigrationViolationsAreZero(jobCounts, metadataCounts) {
  return jobCounts.invalidStateTimestamp === 0
    && jobCounts.invalidSourceNamespace === 0
    && jobCounts.invalidSourceId === 0
    && jobCounts.invalidTerminalJson === 0
    && jobCounts.missingTombstoneParent === 0
    && metadataCounts.invalidTombstones === 0
    && metadataCounts.invalidCooldowns === 0;
}

function digestExactRows(rows) {
  const normalized = rows.map((row) => {
    if (typeof row.participant_digest !== "string" || !SHA256_PATTERN.test(row.participant_digest)
        || typeof row.source_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(row.source_id)
        || typeof row.owner_digest !== "string" || !SHA256_PATTERN.test(row.owner_digest)
        || row.completed_at_utc !== null && typeof row.completed_at_utc !== "string") {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    }
    return [row.participant_digest, row.source_id, row.owner_digest, row.completed_at_utc];
  });
  normalized.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const order = left[index].localeCompare(right[index]);
      if (order !== 0) return order;
    }
    return 0;
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function readSourcePinResult(rows) {
  if (rows.length !== 1) fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID", { sourcePinRows: rows.length });
  const row = rows[0];
  const sourcePinRows = parseCount(row?.source_pin_rows, "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
  const v1AdmissionRows = parseCount(row?.v1_admission_rows, "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
  const v11AdmissionRows = parseCount(row?.v11_admission_rows, "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
  // This named test primary has v1.2-only authority. A newly populated legacy
  // admission state changes the provenance question and must stop this repair.
  if (Math.floor(Number(row?.server_version_num) / 10_000) !== 17
      || sourcePinRows !== 1 || v1AdmissionRows !== 0 || v11AdmissionRows !== 0
      || typeof row?.source_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(row.source_id)) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID", {
      sourcePinRows,
      v1AdmissionRows,
      v11AdmissionRows,
    });
  }
  return Object.freeze({ sourceId: row.source_id });
}

async function readPinnedTestSource(primaryPool, schema) {
  const qualifiedSchema = quoteSchema(schema);
  let client;
  let transactionOpen = false;
  try {
    client = await primaryPool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const rows = rowsFrom(await client.query(`
      SELECT
        (SELECT count(*)::text FROM ${qualifiedSchema}.storage_source_state WHERE singleton = 1) AS source_pin_rows,
        (SELECT count(*)::text FROM ${qualifiedSchema}.typed_v1_admission_state) AS v1_admission_rows,
        (SELECT count(*)::text FROM ${qualifiedSchema}.typed_v11_admission_state) AS v11_admission_rows,
        (SELECT source_id FROM ${qualifiedSchema}.storage_source_state WHERE singleton = 1) AS source_id,
        current_setting('server_version_num')::integer AS server_version_num
    `), "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
    const pin = readSourcePinResult(rows);
    await client.query("COMMIT");
    transactionOpen = false;
    return pin;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* retain a static failure */ }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_LEDGER_RECONCILE_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_READ_FAILED");
  } finally {
    try { client?.release(); } catch { /* no database details in cleanup errors */ }
  }
}

function buildReceipt({ actionMode, resultMode, beforeRows, afterRows, sourcePinSha256, syntheticReceiptMatches }) {
  const alreadyApplied = resultMode === "already_reconciled";
  const inspectOnly = actionMode === "inspect";
  return Object.freeze({
    schemaVersion: "ledger-erasure-incomplete-reconciliation-v1",
    status: inspectOnly && !alreadyApplied ? "inspection_only" : "pending_unverified",
    mode: resultMode,
    action: actionMode,
    migrationReceiptsVerified: EXPECTED_MIGRATION_RECEIPTS_BEFORE,
    ownerCompletionReceiptsMatched: syntheticReceiptMatches,
    sourceIdNamespaceMatches: EXPECTED_UNPROVEN_JOB_COUNT,
    jobsBefore: beforeRows.length,
    jobsAfter: afterRows.length,
    jobsReopened: resultMode === "reconciled" ? EXPECTED_UNPROVEN_JOB_COUNT : 0,
    jobsThatWouldReopen: inspectOnly && !alreadyApplied ? EXPECTED_UNPROVEN_JOB_COUNT : 0,
    jobsPendingUnverified: afterRows.length,
    tombstoneParentsPreserved: afterRows.length,
    prestateSha256: digestExactRows(beforeRows),
    poststateSha256: digestExactRows(afterRows),
    sourcePinSha256,
    terminalProofCreated: false,
    terminalJsonChanged: false,
    tombstonesDeleted: 0,
    payloadDeletionAttempted: false,
    legacyAnalyticsCompletionClaimed: false,
  });
}

/**
 * Test-only, receipt-guarded recovery for precisely the 15 unproven complete
 * jobs blocking ledger migration 0006. It only reopens work: it neither creates
 * terminal proof nor claims source/analytics erasure completion.
 */
export async function reconcileUnprovenCompleteLedgerJobs({
  primaryPool,
  ledgerPool,
  primarySchema = LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary.schema,
  ledgerSchema = LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger.schema,
  expectedLedgerMigrations,
  expectedSourcePinSha256 = LEDGER_PREFLIGHT_RECONCILE_SOURCE_PIN_SHA256,
  mode = "inspect",
} = {}) {
  if (primaryPool === null || typeof primaryPool !== "object" || typeof primaryPool.connect !== "function"
      || ledgerPool === null || typeof ledgerPool !== "object" || typeof ledgerPool.connect !== "function"
      || primaryPool === ledgerPool) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_POOLS_INVALID");
  }
  const primary = quoteSchema(primarySchema);
  const ledger = quoteSchema(ledgerSchema);
  if (mode !== "inspect" && mode !== "apply") {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_MODE_INVALID");
  }
  if (!SHA256_PATTERN.test(expectedSourcePinSha256)
      || (primarySchema === LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary.schema
        && ledgerSchema === LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger.schema
        && expectedSourcePinSha256 !== LEDGER_PREFLIGHT_RECONCILE_SOURCE_PIN_SHA256)) {
    fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
  }
  const expectedReceipts = expectedReceiptRows(expectedLedgerMigrations);
  const sourcePin = await readPinnedTestSource(primaryPool, primarySchema);

  let client;
  let advisoryLockHeld = false;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await ledgerPool.connect();
    const lockRows = rowsFrom(await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [MIGRATION_LOCK_KEY],
    ), "POSTGRES_TEST_LEDGER_RECONCILE_LOCK_FAILED");
    if (lockRows.length !== 1 || lockRows[0]?.acquired !== true) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_MIGRATION_BUSY");
    }
    advisoryLockHeld = true;
    await client.query(mode === "inspect"
      ? "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE"
      : "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '30000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    if (mode === "apply") {
      await client.query(`LOCK TABLE ${ledger}.${MIGRATION_HISTORY}, ${ledger}.storage_erasure_jobs,
        ${ledger}.deletion_tombstones, ${ledger}.identity_reenrollment_cooldowns
        IN SHARE ROW EXCLUSIVE MODE`);
    }
    const versionRows = rowsFrom(await client.query(
      "SELECT current_setting('server_version_num')::integer AS server_version_num",
    ), "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    if (versionRows.length !== 1
        || Math.floor(Number(versionRows[0]?.server_version_num) / 10_000) !== 17) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_POSTGRES_VERSION_UNSUPPORTED");
    }

    const migrationRows = rowsFrom(await client.query(
      `SELECT version, name, checksum_sha256 FROM ${ledger}.${MIGRATION_HISTORY} ORDER BY version`,
    ), "POSTGRES_TEST_LEDGER_RECONCILE_MIGRATION_RECEIPTS_INVALID");
    validateMigrationReceipts(migrationRows, expectedReceipts);

    const namespaceRows = rowsFrom(await client.query(
      `SELECT count(DISTINCT source_namespace)::text AS namespace_count,
              min(source_namespace) AS namespace
         FROM ${ledger}.storage_erasure_jobs`,
    ), "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
    const ledgerNamespaceCount = namespaceRows.length === 1
      ? parseCount(namespaceRows[0]?.namespace_count)
      : 0;
    const namespace = namespaceRows[0]?.namespace;
    if (ledgerNamespaceCount !== 1 || typeof namespace !== "string"
        || namespace.length < 1 || namespace.length > 256) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID", { ledgerNamespaceCount });
    }
    const sourcePinSha256 = createHash("sha256")
      .update(JSON.stringify({ sourceId: sourcePin.sourceId, namespace }))
      .digest("hex");
    if (sourcePinSha256 !== expectedSourcePinSha256) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID", { ledgerNamespaceCount });
    }

    const sourceMismatchRows = rowsFrom(await client.query(
      `SELECT count(*)::text AS mismatches
         FROM ${ledger}.storage_erasure_jobs job
        WHERE job.source_id <> $1 OR job.source_namespace <> $2`,
      [sourcePin.sourceId, namespace],
    ), "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
    const sourceMismatches = sourceMismatchRows.length === 1
      ? parseCount(sourceMismatchRows[0]?.mismatches)
      : EXPECTED_UNPROVEN_JOB_COUNT;
    if (sourceMismatchRows.length !== 1 || sourceMismatches !== 0) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID", {
        jobsSourceMismatched: sourceMismatches,
      });
    }

    const initialJobs = rowsFrom(await client.query(JOB_ROWS_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    const syntheticReceipts = rowsFrom(await client.query(SYNTHETIC_RECEIPTS_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID");
    const syntheticReceiptMatches = assertLegacyCohortHasNoOwnerCompletionProof(initialJobs, syntheticReceipts);

    const preflightRows = rowsFrom(await client.query(JOB_PREFLIGHT_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_PREFLIGHT_FAILED");
    const metadataRows = rowsFrom(await client.query(LEDGER_METADATA_PREFLIGHT_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_PREFLIGHT_FAILED");
    if (preflightRows.length !== 1 || metadataRows.length !== 1) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_PREFLIGHT_FAILED");
    }
    const beforeCounts = validateJobPreflight(preflightRows[0]);
    const metadataCounts = Object.freeze({
      invalidTombstones: parseCount(metadataRows[0]?.invalid_tombstones),
      invalidCooldowns: parseCount(metadataRows[0]?.invalid_cooldowns),
    });
    if (!allOtherMigrationViolationsAreZero(beforeCounts, metadataCounts)
        || initialJobs.length !== EXPECTED_UNPROVEN_JOB_COUNT
        || beforeCounts.totalRows !== EXPECTED_UNPROVEN_JOB_COUNT) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_PRESTATE_UNEXPECTED", {
        jobsTotal: beforeCounts.totalRows,
        completeUnproven: beforeCounts.completeUnproven,
        pendingUnverified: beforeCounts.pendingUnverified,
        invalidStateTimestamp: beforeCounts.invalidStateTimestamp,
        invalidSourceNamespace: beforeCounts.invalidSourceNamespace,
        invalidSourceId: beforeCounts.invalidSourceId,
        invalidTerminalJson: beforeCounts.invalidTerminalJson,
        missingTombstoneParent: beforeCounts.missingTombstoneParent,
        invalidTombstones: metadataCounts.invalidTombstones,
        invalidCooldowns: metadataCounts.invalidCooldowns,
      });
    }
    const prestateSha256 = digestExactRows(initialJobs);
    const isPrestate = beforeCounts.completeUnproven === EXPECTED_UNPROVEN_JOB_COUNT
      && beforeCounts.pendingUnverified === 0
      && initialJobs.every((row) => row.state === "complete" && row.terminal_is_null === true
        && typeof row.completed_at_utc === "string");
    const isPoststate = beforeCounts.completeUnproven === 0
      && beforeCounts.pendingUnverified === EXPECTED_UNPROVEN_JOB_COUNT
      && initialJobs.every((row) => row.state === "pending" && row.terminal_is_null === true
        && row.completed_at_utc === null);
    if (!isPrestate && !isPoststate) fail("POSTGRES_TEST_LEDGER_RECONCILE_PRESTATE_UNEXPECTED");

    let resultMode;
    if (isPrestate && mode === "apply") {
      const updated = rowsFrom(await client.query(`
        UPDATE ${ledger}.storage_erasure_jobs
           SET state = 'pending', completed_at = NULL
         WHERE state = 'complete' AND terminal_json IS NULL
         RETURNING 1 AS changed
      `), "POSTGRES_TEST_LEDGER_RECONCILE_UPDATE_FAILED");
      if (updated.length !== EXPECTED_UNPROVEN_JOB_COUNT) {
        fail("POSTGRES_TEST_LEDGER_RECONCILE_UPDATE_COUNT_INVALID");
      }
      resultMode = "reconciled";
    } else if (isPrestate) {
      resultMode = "prestate_qualified";
    } else {
      resultMode = "already_reconciled";
    }

    const afterJobs = rowsFrom(await client.query(JOB_ROWS_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    const afterRows = rowsFrom(await client.query(JOB_PREFLIGHT_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    const afterMetadataRows = rowsFrom(await client.query(LEDGER_METADATA_PREFLIGHT_SQL(ledger)),
      "POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    if (afterRows.length !== 1 || afterMetadataRows.length !== 1
        || afterJobs.length !== EXPECTED_UNPROVEN_JOB_COUNT) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    }
    const afterCounts = validateJobPreflight(afterRows[0]);
    const afterMetadataCounts = Object.freeze({
      invalidTombstones: parseCount(afterMetadataRows[0]?.invalid_tombstones),
      invalidCooldowns: parseCount(afterMetadataRows[0]?.invalid_cooldowns),
    });
    const expectedAfterPrestate = mode === "inspect" && isPrestate;
    const afterIsExpectedPrestate = afterCounts.completeUnproven === EXPECTED_UNPROVEN_JOB_COUNT
      && afterCounts.pendingUnverified === 0
      && afterJobs.every((row) => row.state === "complete" && row.terminal_is_null === true
        && typeof row.completed_at_utc === "string");
    const afterIsExpectedPoststate = afterCounts.completeUnproven === 0
      && afterCounts.pendingUnverified === EXPECTED_UNPROVEN_JOB_COUNT
      && afterJobs.every((row) => row.state === "pending" && row.terminal_is_null === true
        && row.completed_at_utc === null);
    if (!allOtherMigrationViolationsAreZero(afterCounts, afterMetadataCounts)
        || afterCounts.totalRows !== EXPECTED_UNPROVEN_JOB_COUNT
        || (expectedAfterPrestate ? !afterIsExpectedPrestate : !afterIsExpectedPoststate)) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    }
    const receipt = buildReceipt({
      actionMode: mode,
      resultMode,
      beforeRows: initialJobs,
      afterRows: afterJobs,
      sourcePinSha256,
      syntheticReceiptMatches,
    });
    if (receipt.prestateSha256 !== prestateSha256) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_READBACK_INVALID");
    }
    if (receipt.ownerCompletionReceiptsMatched !== syntheticReceiptMatches) {
      fail("POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID");
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return receipt;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_LEDGER_RECONCILE_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail("POSTGRES_TEST_LEDGER_RECONCILE_FAILED");
  } finally {
    if (client !== undefined && advisoryLockHeld) {
      try {
        const unlocked = rowsFrom(await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [MIGRATION_LOCK_KEY],
        ), "POSTGRES_TEST_LEDGER_RECONCILE_UNLOCK_FAILED");
        if (unlocked.length !== 1 || unlocked[0]?.released !== true) discard = true;
      } catch { discard = true; }
    }
    try { await client?.release(discard); } catch { /* never surface provider details */ }
  }
}

export async function buildLedgerPreflightReconcileManifest({
  rootDirectory = LEDGER_PREFLIGHT_RECONCILE_MIGRATION_ROOT,
} = {}) {
  return buildPostgresMigrationManifest({ rootDirectory });
}

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_TEST_LEDGER_RECONCILE_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "POSTGRES_TEST_LEDGER_RECONCILE_FAILED";
}

function safeErrorCounts(error) {
  const counts = Object.create(null);
  for (const [key, value] of Object.entries(error?.safeCounts ?? {})) {
    if (SAFE_DIAGNOSTIC_COUNT_KEYS.has(key)
        && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) {
      counts[key] = value;
    }
  }
  return Object.keys(counts).length > 0 ? Object.freeze(counts) : undefined;
}

export async function runLedgerPreflightReconcile({ env = process.env, dependencies = {} } = {}) {
  validateContext(env);
  const attachedServiceAccountEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedLedgerReconcileServiceAccount)({ fetchImpl: dependencies.fetchImpl });
  const config = parseLedgerPreflightReconcileConfig(env, attachedServiceAccountEmail);
  let connector;
  let primaryPool;
  let ledgerPool;
  let result;
  let operationError;
  try {
    connector = await (dependencies.createConnector ?? (() => new Connector()))();
    primaryPool = await (dependencies.createPool ?? createCloudSqlIamPool)({
      connector,
      instanceConnectionName: config.primary.instanceConnectionName,
      database: config.primary.database,
      user: config.iamUser,
      max: 1,
      applicationName: MIGRATOR_APPLICATION_NAME,
    });
    ledgerPool = await (dependencies.createPool ?? createCloudSqlIamPool)({
      connector,
      instanceConnectionName: config.ledger.instanceConnectionName,
      database: config.ledger.database,
      user: config.iamUser,
      max: 1,
      applicationName: MIGRATOR_APPLICATION_NAME,
    });
    const manifest = await (dependencies.buildManifest ?? buildLedgerPreflightReconcileManifest)({
      rootDirectory: LEDGER_PREFLIGHT_RECONCILE_MIGRATION_ROOT,
    });
    result = await (dependencies.reconcile ?? reconcileUnprovenCompleteLedgerJobs)({
      primaryPool,
      ledgerPool,
      primarySchema: config.primary.schema,
      ledgerSchema: config.ledger.schema,
      expectedLedgerMigrations: manifest.roles?.ledger,
      mode: config.mode,
    });
  } catch (error) {
    operationError = Object.assign(new Error(safeErrorCode(error)), {
      code: safeErrorCode(error),
      safeCounts: safeErrorCounts(error),
    });
  }
  try {
    await (dependencies.closeResources ?? closeCloudSqlResources)({
      pools: [primaryPool, ledgerPool].filter(Boolean),
      connector,
    });
  } catch {
    operationError ??= Object.assign(new Error("CLOUD_SQL_TEST_LEDGER_RECONCILE_CLEANUP_FAILED"), {
      code: "CLOUD_SQL_TEST_LEDGER_RECONCILE_CLEANUP_FAILED",
    });
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

async function main() {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "error", code: "CLOUD_RUN_TEST_LEDGER_RECONCILE_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await runLedgerPreflightReconcile()));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: safeErrorCode(error), ...(safeErrorCounts(error) ?? {}) }));
    process.exitCode = 1;
  }
}

if (typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
