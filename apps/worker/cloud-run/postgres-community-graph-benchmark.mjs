#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { canonicalJson } from "../src/canonical-json.ts";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11.ts";
import {
  publishPostgresCommunityModelDayStream,
  readPostgresCommunityModelDay,
} from "../src/postgres-community-graph.ts";
import { withPostgresMutation, withPostgresRead } from "../src/postgres-client.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { readPostgresMigrations } from "./postgres-migrations.mjs";

export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_JOB = "tibotattle-public-graph-benchmark";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROJECT = "tibotattle";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER = "tibotattle-test-runtime@tibotattle.iam";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER = "tibotattle-test-migrator@tibotattle.iam";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_UNUSED_LEDGER_SCHEMA =
  "tibotattle_graph_benchmark_ledger_unused";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET = Object.freeze({
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  database: "tibotattle",
});
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES = Object.freeze({
  "10k": Object.freeze({
    members: 10_000,
    schema: "tibotattle_graph_benchmark_10k_20260925",
    workloadDigest: "5ee009572207747c95c45d2e86c9db6bceec740cac0210aa4fa31d749c9efed1",
    sourceDigest: "dcab757ec3e6be58ca2a881586f9a73642ddb6e66e161445587369f288500056",
    outputDigest: "6064494b04f89cd02c2039a83dd669cca435715759278b93785db99c33b7d0ce",
  }),
  "100k": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
  "100k-insights": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_insights_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
  "100k-paged": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_paged_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
  "100k-readpaged": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_readpaged_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
  "100k-readindexed": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_readindexed_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
  "100k-batched": Object.freeze({
    members: 100_000,
    schema: "tibotattle_graph_benchmark_100k_batched_20260925",
    workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
    sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
    outputDigest: "4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f",
  }),
});

const MIGRATION_COUNT = 46;
const MIGRATION_TAIL = "0046_owner_journal_authority.sql";
export const POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_ROOT =
  "/app/apps/worker/postgres/migrations";
const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
const MIGRATION_PROFILE_VERSION = "postgres-primary-migrations-v1";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const DAY = "2026-09-23";
const FINGERPRINT = "a".repeat(64);
const COMPUTED_AT_MS = 1_790_294_400_000;
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const APPLICATION_NAME = "tibotattle-public-graph-benchmark";
const EMPTY_TABLES = Object.freeze([
  "storage_source_state",
  "analytics_source_cursors",
  "storage_ingestion_changes",
  "participants",
  "analytics_owner_state",
  "storage_v11_owner_links",
  "input_versions",
  "analytics_owner_results",
  "analytics_publications",
  "analytics_publication_captures",
  "analytics_publication_owner_members",
  "analytics_publication_invalidations",
  "accountless_v12_device_authorizations",
  "community_daily_aggregates",
  "community_daily_allowance_publication_state",
  "community_daily_allowance_preview_cache",
]);
const TABLE_DML_PRIVILEGES = Object.freeze([
  ["participants", "INSERT"],
  ["analytics_owner_state", "INSERT"],
  ["storage_v11_owner_links", "INSERT"],
  ["input_versions", "INSERT"],
  ["analytics_owner_results", "INSERT"],
  ["storage_source_state", "INSERT"],
  ["analytics_source_cursors", "INSERT"],
  ["publication_state", "UPDATE"],
  ["collection_controls", "UPDATE"],
  ["telemetry_v12_runtime", "UPDATE"],
  ["telemetry_v12_typed_runtime", "UPDATE"],
]);
const TABLE_REQUIRED_PRIVILEGES = Object.freeze([
  ...TABLE_DML_PRIVILEGES,
  ...[
    "storage_source_state",
    "analytics_source_cursors",
    "storage_ingestion_changes",
    "participants",
    "analytics_owner_state",
    "storage_v11_owner_links",
    "input_versions",
    "analytics_owner_results",
    "analytics_publications",
    "analytics_publication_captures",
    "analytics_publication_owner_members",
    "analytics_publication_invalidations",
    "accountless_v12_device_authorizations",
    "publication_state",
    "collection_controls",
    "telemetry_v12_runtime",
    "telemetry_v12_typed_runtime",
    "community_daily_aggregates",
    "community_daily_allowance_publication_state",
    "community_daily_allowance_preview_cache",
  ].map((table) => [table, "SELECT"]),
  ["analytics_publication_captures", "INSERT"],
  ["analytics_publication_owner_members", "INSERT"],
  ["analytics_publications", "INSERT"],
  ["analytics_publications", "UPDATE"],
]);

const SOURCE_PIN = Object.freeze({
  sourceId: SOURCE_ID,
  sourceNamespace: SOURCE_NAMESPACE,
  sourceAuthorityEpoch: 0,
  analyticsAuthorityEpoch: 0,
  sequence: 0,
  policyRevision: 1,
  collectionRevision: 2,
  telemetryV12RuntimeState: "active",
  telemetryV12RuntimeRevision: 0,
  telemetryV12TypedRuntimeState: "active",
  telemetryV12TypedRuntimePolicyRevision: 1,
  accountlessAuthorizationCount: 0,
  nextAccountlessAuthorizationExpiry: null,
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireRows(result, code, expectedCount) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length
      || expectedCount !== undefined && result.rows.length !== expectedCount) {
    fail(code);
  }
  return result.rows;
}

function parseCount(value, code) {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) fail(code);
  return count;
}

function quoteSchema(value) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_INVALID");
  }
  return `"${value}"`;
}

function readyComposition(fingerprint) {
  return {
    status: "ready",
    planType: "pro",
    fit: {
      status: "fitted",
      observationCount: 30,
      totalCostUsd: 120,
      modelCostShares: { "gpt-6-astra": 1 },
      capacityUsdByModel: { "gpt-6-astra": 1000 },
      singleConstantUsd: 1000,
      r2: 0.99,
      singleConstantR2: 0.5,
      solverConverged: true,
      identification: {
        adjustedR2: 0.98,
        singleConstantAdjustedR2: 0.4,
        splitHalfIdentified: true,
        splitHalfMaxCapacityDriftFraction: 0,
      },
    },
    voidedBinCount: 0,
    poolCount: 1,
    quotaRowCount: 31,
    usageEventCount: 30,
    unpricedUsageEventCount: 0,
    poisonedBinCount: 0,
    latestQuotaObservedAt: "2026-09-22T12:00:00.000Z",
    attributionStatus: "legacy_conditional",
    attributionMethod: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: fingerprint,
  };
}

function sourceResultPayload() {
  const payloadJson = JSON.stringify(readyComposition(FINGERPRINT));
  return Object.freeze({ payloadJson, payloadSha256: sha256(payloadJson) });
}

/** Reproduce the exact synthetic source/workload receipt used by the local PG17 profile. */
export function computePostgresCommunityGraphBenchmarkDigests(profileName) {
  const profile = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES[profileName];
  if (!profile) fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILE_INVALID");
  const { payloadSha256 } = sourceResultPayload();
  const workload = {
    schemaVersion: "synthetic-public-graph-cohort-workload-v1",
    day: DAY,
    sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_NAMESPACE,
    memberCount: profile.members,
    computedAtMs: COMPUTED_AT_MS,
    sourcePin: SOURCE_PIN,
    syntheticGeneration: {
      ownerDigest: "lowercase-hex(index), left padded to 64 characters",
      participantId: "synthetic-stream-index",
      sourceKind: "effective",
      inputRevision: 0,
      ownerRevision: 1,
      authorityEpoch: 0,
      inputFingerprint: FINGERPRINT,
      payloadSha256,
    },
  };
  const source = createHash("sha256");
  const updateSource = (record) => {
    const serialized = canonicalJson(record);
    source.update(`${Buffer.byteLength(serialized)}:${serialized}\n`);
  };
  updateSource(workload);
  for (let index = 1; index <= profile.members; index += 1) {
    const ownerDigest = index.toString(16).padStart(64, "0");
    const participantId = `synthetic-stream-${index}`;
    updateSource({
      schemaVersion: "synthetic-community-graph-owner-v1",
      participant: { id: participantId, ownerKind: "social", state: "active" },
      owner: { sourceId: SOURCE_ID, ownerDigest, revision: 1, authorityEpoch: 0, state: "active" },
      link: { participantId, ownerDigest, state: "active" },
      inputVersion: { participantId, revision: 0 },
      graphMember: {
        participantId,
        ownerDigest,
        inputRevision: 0,
        ownerRevision: 1,
        authorityEpoch: 0,
        sourceKind: "effective",
        inputFingerprint: FINGERPRINT,
      },
      ownerResult: {
        sourceId: SOURCE_ID,
        sourceNamespace: SOURCE_NAMESPACE,
        observedDay: DAY,
        metric: "model",
        ownerDigest,
        inputRevision: 0,
        ownerRevision: 1,
        authorityEpoch: 0,
        publicAuthorityEpoch: 0,
        sourceEpoch: 0,
        sequence: 0,
        method: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
        status: "ready",
        reason: null,
        payloadSha256,
        computedAtMs: COMPUTED_AT_MS,
      },
    });
  }
  return Object.freeze({
    workloadDigest: sha256(canonicalJson(workload)),
    sourceDigest: source.digest("hex"),
  });
}

function validateBenchmarkContext(env) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_CONTEXT_INVALID");
  }
  const profileName = env.POSTGRES_GRAPH_BENCHMARK_PROFILE;
  const profile = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES[profileName];
  if (!profile) fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILE_INVALID");
  if (env.POSTGRES_IAM_USER !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER
      || normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER")
        !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER_INVALID");
  }
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME
        !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.instanceConnectionName
      || env.PRIMARY_DATABASE !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.database
      || env.PRIMARY_SCHEMA !== profile.schema) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  }
  if (env.LEDGER_INSTANCE_CONNECTION_NAME !== undefined
      || env.LEDGER_DATABASE !== undefined || env.LEDGER_SCHEMA !== undefined) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_LEDGER_TARGET_FORBIDDEN");
  }
  return Object.freeze({
    job: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    project: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROJECT,
    serviceAccount: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
    profile: profileName,
    members: profile.members,
    schema: profile.schema,
    instanceConnectionName: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.instanceConnectionName,
    database: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.database,
    iamUser: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER,
  });
}

export function parsePostgresCommunityGraphBenchmarkConfig(env, attachedServiceAccountEmail) {
  const config = validateBenchmarkContext(env);
  if (attachedServiceAccountEmail !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

export async function readAttachedCommunityGraphBenchmarkServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200 || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_METADATA_UNAVAILABLE");
  }
  if (email !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function migrationManifestReceipt(migrations) {
  if (!Array.isArray(migrations) || migrations.length !== MIGRATION_COUNT
      || migrations.at(-1)?.name !== MIGRATION_TAIL) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_SOURCE_INVALID");
  }
  const receipt = migrations.map(({ version, name, sha256: checksum }) => {
    if (!Number.isSafeInteger(version) || typeof name !== "string"
        || !SHA256_PATTERN.test(checksum ?? "")) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_SOURCE_INVALID");
    }
    return { version, name, checksumSha256: checksum };
  });
  if (receipt.some((entry, index) => entry.version !== index + 1)) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_SOURCE_INVALID");
  }
  return Object.freeze({
    count: receipt.length,
    tail: MIGRATION_TAIL,
    sha256: sha256(canonicalJson({ schemaVersion: MIGRATION_PROFILE_VERSION, receipts: receipt })),
    expected: Object.freeze(receipt),
  });
}

/** Check that a named isolated test schema has precisely the bundled primary migration history. */
export async function verifyPostgresCommunityGraphBenchmarkMigrationReceipt(pool, schema, migrations) {
  const quotedSchema = quoteSchema(schema);
  const expected = migrationManifestReceipt(migrations);
  const rows = await withPostgresRead(pool, async (client) => requireRows(await client.query(
    `SELECT version, name, checksum_sha256
       FROM ${quotedSchema}."${MIGRATION_HISTORY_TABLE}"
      ORDER BY version`,
  ), "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID"));
  if (rows.length !== expected.count) fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID");
  const observed = rows.map((row, index) => {
    if (parseCount(row.version, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID")
          !== expected.expected[index]?.version
        || row.name !== expected.expected[index]?.name
        || row.checksum_sha256 !== expected.expected[index]?.checksumSha256) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID");
    }
    return { version: Number(row.version), name: row.name, checksumSha256: row.checksum_sha256 };
  });
  return Object.freeze({
    count: observed.length,
    tail: MIGRATION_TAIL,
    sha256: sha256(canonicalJson({ schemaVersion: MIGRATION_PROFILE_VERSION, receipts: observed })),
  });
}

export async function readPostgresCommunityGraphBenchmarkMigrations({
  readMigrations = readPostgresMigrations,
} = {}) {
  return readMigrations({
    role: "primary",
    rootDirectory: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_ROOT,
  });
}

function benchmarkPreflightSql(schema) {
  const quotedSchema = quoteSchema(schema);
  const emptyCounts = EMPTY_TABLES.map((table) =>
    `(SELECT count(*)::text FROM ${quotedSchema}."${table}") AS "${table}_count"`).join(",\n");
  const privileges = TABLE_REQUIRED_PRIVILEGES.map(([table, privilege]) =>
    `has_table_privilege(current_user, format('%I.%I', $1, '${table}'), '${privilege}') AS "${table}_${privilege.toLowerCase()}"`).join(",\n");
  return `SELECT current_database() AS database_name,
                 current_user AS database_user,
                 current_setting('server_version_num')::integer AS server_version_num,
                 pg_get_userbyid(namespace.nspowner) AS schema_owner,
                 has_schema_privilege(current_user, namespace.oid, 'CREATE') AS runtime_can_create_schema,
                 has_schema_privilege(current_user, namespace.oid, 'USAGE') AS runtime_can_use_schema,
                 pg_has_role(current_user, namespace.nspowner, 'MEMBER') AS runtime_is_schema_owner_member,
                 has_database_privilege(current_user, current_database(), 'TEMP') AS runtime_can_create_temp,
                 (SELECT pg_get_userbyid(relation.relowner)
                    FROM pg_class relation
                    JOIN pg_namespace history_namespace ON history_namespace.oid=relation.relnamespace
                   WHERE history_namespace.nspname=$1 AND relation.relname='${MIGRATION_HISTORY_TABLE}')
                   AS migration_history_owner,
                 has_table_privilege(current_user, format('%I.%I', $1, '${MIGRATION_HISTORY_TABLE}'), 'SELECT')
                   AS runtime_can_read_migration_history,
                 has_table_privilege(current_user, format('%I.%I', $1, '${MIGRATION_HISTORY_TABLE}'), 'INSERT')
                   AS runtime_can_insert_migration_history,
                 has_table_privilege(current_user, format('%I.%I', $1, '${MIGRATION_HISTORY_TABLE}'), 'UPDATE')
                   AS runtime_can_update_migration_history,
                 has_table_privilege(current_user, format('%I.%I', $1, '${MIGRATION_HISTORY_TABLE}'), 'DELETE')
                   AS runtime_can_delete_migration_history,
                 ${privileges},
                 ${emptyCounts},
                 (SELECT publication_state FROM ${quotedSchema}.publication_state WHERE singleton=1)
                   AS publication_state,
                 (SELECT policy_revision::text FROM ${quotedSchema}.publication_state WHERE singleton=1)
                   AS policy_revision,
                 (SELECT revision::text FROM ${quotedSchema}.collection_controls WHERE singleton=1)
                   AS collection_revision,
                 (SELECT control_state FROM ${quotedSchema}.collection_controls WHERE singleton=1)
                   AS control_state,
                 (SELECT bool_and(NOT enabled) FROM (
                    SELECT enrollment_enabled AS enabled FROM ${quotedSchema}.collection_controls WHERE singleton=1
                    UNION ALL SELECT upload_registration_enabled FROM ${quotedSchema}.collection_controls WHERE singleton=1
                    UNION ALL SELECT processing_enabled FROM ${quotedSchema}.collection_controls WHERE singleton=1
                    UNION ALL SELECT publication_enabled FROM ${quotedSchema}.collection_controls WHERE singleton=1
                  ) AS flags) AS collection_flags_disabled,
                 (SELECT reason_code IS NULL FROM ${quotedSchema}.collection_controls WHERE singleton=1)
                   AS collection_reason_empty,
                 (SELECT state FROM ${quotedSchema}.telemetry_v12_runtime WHERE id=1)
                   AS telemetry_v12_state,
                 (SELECT revision::text FROM ${quotedSchema}.telemetry_v12_runtime WHERE id=1)
                   AS telemetry_v12_revision,
                 (SELECT state FROM ${quotedSchema}.telemetry_v12_typed_runtime WHERE id=1)
                   AS telemetry_v12_typed_state,
                 (SELECT policy_revision::text FROM ${quotedSchema}.telemetry_v12_typed_runtime WHERE id=1)
                   AS telemetry_v12_typed_policy_revision
            FROM pg_namespace namespace
           WHERE namespace.nspname=$1`;
}

export function validatePostgresCommunityGraphBenchmarkPreflight(row, config) {
  if (row === null || typeof row !== "object"
      || row.database_name !== config.database
      || row.database_user !== config.iamUser
      || Math.floor(Number(row.server_version_num) / 10_000) !== 17
      || row.schema_owner !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER
      || row.migration_history_owner !== POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER
      || row.runtime_can_create_schema !== false
      || row.runtime_can_use_schema !== true
      || row.runtime_is_schema_owner_member !== false
      || row.runtime_can_create_temp !== true
      || row.runtime_can_read_migration_history !== true
      || row.runtime_can_insert_migration_history !== false
      || row.runtime_can_update_migration_history !== false
      || row.runtime_can_delete_migration_history !== false) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_DATABASE_IDENTITY_INVALID");
  }
  for (const [table, privilege] of TABLE_REQUIRED_PRIVILEGES) {
    if (row[`${table}_${privilege.toLowerCase()}`] !== true) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_RUNTIME_GRANT_INVALID");
    }
  }
  for (const table of EMPTY_TABLES) {
    if (parseCount(row[`${table}_count`], "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE") !== 0) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE");
    }
  }
  if (row.publication_state !== "ready" || parseCount(row.policy_revision,
    "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE") !== 1
      || parseCount(row.collection_revision, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE") !== 1
      || row.control_state !== "contained" || row.collection_flags_disabled !== true
      || row.collection_reason_empty !== true || row.telemetry_v12_state !== "staged"
      || parseCount(row.telemetry_v12_revision, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE") !== 0
      || row.telemetry_v12_typed_state !== "staged"
      || parseCount(row.telemetry_v12_typed_policy_revision,
        "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE") !== 1) {
    fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_NOT_PRISTINE");
  }
  return Object.freeze({ pristine: true, serverMajor: 17 });
}

async function verifyTargetPreflight(pool, config) {
  const rows = await withPostgresRead(pool, async (client) => requireRows(await client.query(
    benchmarkPreflightSql(config.schema), [config.schema],
  ), "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PREFLIGHT_INVALID", 1));
  return validatePostgresCommunityGraphBenchmarkPreflight(rows[0], config);
}

function checkedMutation(result, expectedRows, code) {
  if (result === null || typeof result !== "object"
      || result.rowCount !== expectedRows) fail(code);
}

export async function seedPostgresCommunityGraphBenchmark(pool, config) {
  const profile = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES[config.profile];
  const schema = quoteSchema(config.schema);
  const { payloadJson, payloadSha256 } = sourceResultPayload();
  await withPostgresMutation(pool, async (client) => {
    const lockRows = requireRows(await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [`tibotattle:community-graph-benchmark:${config.schema}`],
    ), "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_LOCK_FAILED", 1);
    if (lockRows[0]?.acquired !== true) fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_LOCK_FAILED");
    const preflightRows = requireRows(await client.query(
      benchmarkPreflightSql(config.schema), [config.schema],
    ), "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PREFLIGHT_INVALID", 1);
    validatePostgresCommunityGraphBenchmarkPreflight(preflightRows[0], config);

    checkedMutation(await client.query(
      `INSERT INTO ${schema}.storage_source_state(singleton, source_id, authority_epoch) VALUES (1, $1, 0)`,
      [SOURCE_ID],
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `INSERT INTO ${schema}.analytics_source_cursors(source_id, sequence, authority_epoch) VALUES ($1, 0, 0)`,
      [SOURCE_ID],
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `UPDATE ${schema}.publication_state SET publication_state='ready' WHERE singleton=1`,
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `UPDATE ${schema}.collection_controls SET revision=revision+1, control_state='operational',
        enrollment_enabled=true, upload_registration_enabled=true, processing_enabled=true,
        publication_enabled=true, reason_code=NULL, updated_at=clock_timestamp() WHERE singleton=1`,
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `UPDATE ${schema}.telemetry_v12_runtime SET state='active' WHERE id=1`,
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `UPDATE ${schema}.telemetry_v12_typed_runtime SET state='active' WHERE id=1`,
    ), 1, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `INSERT INTO ${schema}.participants(id, owner_kind, state, created_at)
       SELECT 'synthetic-stream-'||index, 'social', 'active', clock_timestamp()
         FROM generate_series(1, $1::integer) AS generated(index)`,
      [profile.members],
    ), profile.members, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `INSERT INTO ${schema}.analytics_owner_state(source_id, owner_digest, revision, authority_epoch, state)
       SELECT $1, lpad(to_hex(index), 64, '0'), 1, 0, 'active'
         FROM generate_series(1, $2::integer) AS generated(index)`,
      [SOURCE_ID, profile.members],
    ), profile.members, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `INSERT INTO ${schema}.storage_v11_owner_links(participant_id, owner_digest, state)
       SELECT 'synthetic-stream-'||index, lpad(to_hex(index), 64, '0'), 'active'
         FROM generate_series(1, $1::integer) AS generated(index)`,
      [profile.members],
    ), profile.members, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
    checkedMutation(await client.query(
      `INSERT INTO ${schema}.analytics_owner_results(
         source_id, source_namespace, observed_day, metric, owner_digest, input_revision,
         owner_revision, authority_epoch, public_authority_epoch, source_epoch, sequence,
         method, status, reason, payload_json, payload_sha256, computed_at_ms
       ) SELECT $1, $2, $3::date, 'model', lpad(to_hex(index), 64, '0'), 0, 1, 0, 0, 0, 0,
                $4, 'ready', NULL, $5, $6, $7
           FROM generate_series(1, $8::integer) AS generated(index)`,
      [SOURCE_ID, SOURCE_NAMESPACE, DAY, V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
        payloadJson, payloadSha256, COMPUTED_AT_MS, profile.members],
    ), profile.members, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SEED_FAILED");
  }, {
    statementTimeoutMilliseconds: 120_000,
    lockTimeoutMilliseconds: 5_000,
    operation: "postgres.community_graph_benchmark.seed",
  });
}

async function* syntheticMembers(memberCount) {
  for (let index = 1; index <= memberCount; index += 1) {
    yield {
      participantId: `synthetic-stream-${index}`,
      ownerDigest: index.toString(16).padStart(64, "0"),
      inputRevision: 0,
      ownerRevision: 1,
      authorityEpoch: 0,
      sourceKind: "effective",
      inputFingerprint: FINGERPRINT,
    };
  }
}

function textByteEstimate(result) {
  if (!Array.isArray(result?.rows)) return 0;
  let bytes = 0;
  for (const row of result.rows) {
    if (row === null || typeof row !== "object") continue;
    for (const value of Object.values(row)) {
      if (typeof value === "string") bytes += Buffer.byteLength(value);
      else if (typeof value === "number") bytes += Buffer.byteLength(String(value));
      else if (typeof value === "boolean") bytes += 1;
      else if (value instanceof Date) bytes += Buffer.byteLength(value.toISOString());
    }
  }
  return bytes;
}

function statementKind(statement) {
  const sql = typeof statement === "string" ? statement.trimStart().toUpperCase()
    : typeof statement?.text === "string" ? statement.text.trimStart().toUpperCase() : "";
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/u.test(sql)) return "transaction_control";
  if (/^DECLARE\s+/u.test(sql)) return "cursor_declare";
  if (/^FETCH FORWARD\b/u.test(sql)) return "cursor_page_fetch";
  if (/^CLOSE\s+/u.test(sql)) return "cursor_close";
  if (/^CREATE TEMP TABLE\s+PG_COMMUNITY_GRAPH_MEMBERS/u.test(sql)) return "member_temp_table";
  if (/^CREATE TEMP TABLE\s+PG_COMMUNITY_GRAPH_CAPACITIES/u.test(sql)) return "capacity_temp_table";
  if (/^CREATE INDEX\s+PG_COMMUNITY_GRAPH_MEMBERS_OWNER_DIGEST_C/u.test(sql)) return "member_page_index";
  if (/^ANALYZE\s+PG_TEMP\.PG_COMMUNITY_GRAPH_MEMBERS/u.test(sql)) return "member_table_analyze";
  if (/^INSERT INTO PG_TEMP\.PG_COMMUNITY_GRAPH_MEMBERS/u.test(sql)) return "member_stage_page";
  if (/ANALYTICS_OWNER_RESULTS/u.test(sql) && /\bLIMIT\b/u.test(sql)) return "owner_result_page";
  if (/^INSERT INTO .*ANALYTICS_PUBLICATION_OWNER_MEMBERS/u.test(sql)
      || (/^WITH\b/u.test(sql) && /\bINSERT INTO\b/u.test(sql)
        && /ANALYTICS_PUBLICATION_OWNER_MEMBERS/u.test(sql))) return "publication_member_write";
  if (/^WITH PAGE AS MATERIALIZED\b/u.test(sql)
      && /\.ANALYTICS_PUBLICATION_OWNER_MEMBERS MEMBER\b/u.test(sql)
      && /MEMBER\.OWNER_DIGEST > \$4::TEXT\b/u.test(sql)) return "member_readback_page";
  if (/^WITH GRAPH_RESULT_PAGE AS MATERIALIZED\b/u.test(sql)
      && /UPDATE PG_TEMP\.PG_COMMUNITY_GRAPH_MEMBERS/u.test(sql)
      && /INSERT INTO PG_TEMP\.PG_COMMUNITY_GRAPH_CAPACITIES/u.test(sql)) return "result_page_apply";
  if (/ANALYTICS_PUBLICATION_OWNER_MEMBERS/u.test(sql)) return "publication_member_read";
  if (/ANALYTICS_PUBLICATION_CAPTURES/u.test(sql)) return "publication_capture";
  if (/ANALYTICS_PUBLICATIONS/u.test(sql)) return "publication_row";
  if (/^SELECT/u.test(sql)) return "select_other";
  if (/^INSERT/u.test(sql)) return "insert_other";
  if (/^UPDATE/u.test(sql)) return "update_other";
  return "other";
}

/** Wrap a structural pool with content-free SQL, page and connection counters. */
export function createPostgresCommunityGraphBenchmarkMetrics(pool) {
  const categories = new Map();
  let phase = "setup";
  let checkouts = 0;
  let checkoutCalls = 0;
  let maxCheckouts = 0;
  let queryCalls = 0;
  let rowsRead = 0;
  let rowsAffected = 0;
  let textBytesReadEstimate = 0;
  const record = (statement, elapsedMilliseconds, result) => {
    const kind = statementKind(statement);
    const key = `${phase}.${kind}`;
    const entry = categories.get(key) ?? {
      calls: 0, elapsedMilliseconds: 0, rowsRead: 0, rowsAffected: 0, textBytesReadEstimate: 0,
    };
    const returned = Array.isArray(result?.rows) ? result.rows.length : 0;
    const affected = Number.isSafeInteger(result?.rowCount) && result.rowCount > 0 ? result.rowCount : 0;
    const bytes = textByteEstimate(result);
    entry.calls += 1;
    entry.elapsedMilliseconds += elapsedMilliseconds;
    entry.rowsRead += returned;
    entry.rowsAffected += affected;
    entry.textBytesReadEstimate += bytes;
    categories.set(key, entry);
    queryCalls += 1;
    rowsRead += returned;
    rowsAffected += affected;
    textBytesReadEstimate += bytes;
  };
  const wrapClient = (client) => new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args) => {
          const start = performance.now();
          try {
            const result = await Reflect.apply(target.query, target, args);
            record(args[0], performance.now() - start, result);
            return result;
          } catch (error) {
            const key = `${phase}.${statementKind(args[0])}`;
            const entry = categories.get(key) ?? {
              calls: 0, elapsedMilliseconds: 0, rowsRead: 0, rowsAffected: 0, textBytesReadEstimate: 0,
            };
            entry.calls += 1;
            entry.elapsedMilliseconds += performance.now() - start;
            categories.set(key, entry);
            queryCalls += 1;
            throw error;
          }
        };
      }
      if (property === "release") {
        return (...args) => Reflect.apply(target.release, target, args);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const measuredPool = new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async (...args) => {
          checkoutCalls += 1;
          const client = await Reflect.apply(target.connect, target, args);
          checkouts += 1;
          maxCheckouts = Math.max(maxCheckouts, checkouts);
          let released = false;
          const wrapped = wrapClient(client);
          return new Proxy(wrapped, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== "release") return Reflect.get(clientTarget, clientProperty, clientTarget);
              return (...releaseArgs) => {
                if (!released) {
                  released = true;
                  checkouts = Math.max(0, checkouts - 1);
                }
                return Reflect.apply(clientTarget.release, clientTarget, releaseArgs);
              };
            },
          });
        };
      }
      if (property === "query") {
        return async (...args) => {
          const start = performance.now();
          try {
            const result = await Reflect.apply(target.query, target, args);
            record(args[0], performance.now() - start, result);
            return result;
          } catch (error) {
            const key = `${phase}.${statementKind(args[0])}`;
            const entry = categories.get(key) ?? {
              calls: 0, elapsedMilliseconds: 0, rowsRead: 0, rowsAffected: 0, textBytesReadEstimate: 0,
            };
            entry.calls += 1;
            entry.elapsedMilliseconds += performance.now() - start;
            categories.set(key, entry);
            queryCalls += 1;
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    pool: measuredPool,
    setPhase(nextPhase) { phase = nextPhase; },
    snapshot() {
      const queries = Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Object.freeze({
          calls: value.calls,
          elapsedMilliseconds: Math.round(value.elapsedMilliseconds * 100) / 100,
          rowsRead: value.rowsRead,
          rowsAffected: value.rowsAffected,
          textBytesReadEstimate: value.textBytesReadEstimate,
        })]));
      const countedCalls = (kind) => Object.entries(queries)
        .filter(([key]) => key.endsWith(`.${kind}`))
        .reduce((sum, [, value]) => sum + value.calls, 0);
      return Object.freeze({
        queryCalls,
        rowsRead,
        rowsAffected,
        textBytesReadEstimate,
        connections: Object.freeze({
          poolMax: 1,
          poolTotalCreated: Number.isSafeInteger(pool.totalCount) ? pool.totalCount : null,
          poolCheckouts: checkoutCalls,
          checkedOutAtEnd: checkouts,
          maxCheckedOut: maxCheckouts,
        }),
        pages: Object.freeze({
          stagedMemberPages: countedCalls("member_stage_page"),
          ownerResultPages: countedCalls("owner_result_page"),
          resultPageApplyQueries: countedCalls("result_page_apply"),
          publicationMemberReadPages: countedCalls("member_readback_page"),
          publicationMemberWriteQueries: countedCalls("publication_member_write"),
        }),
        queries: Object.freeze(queries),
      });
    },
  });
}

function cpuMilliseconds(usage) {
  return Object.freeze({
    user: Math.round(usage.user / 1000),
    system: Math.round(usage.system / 1000),
    total: Math.round((usage.user + usage.system) / 1000),
  });
}

function memorySnapshot() {
  const { rss, heapUsed, external } = process.memoryUsage();
  return Object.freeze({ rssBytes: rss, heapUsedBytes: heapUsed, externalBytes: external });
}

function durationMilliseconds(start) {
  return Math.round((performance.now() - start) * 100) / 100;
}

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_COMMUNITY_GRAPH_BENCHMARK_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_FAILED";
}

const FAILURE_PHASES = new Set([
  "configuration", "identity", "connection", "migration_source", "preflight",
  "seed", "publish", "readback", "verification", "cleanup", "entrypoint",
]);

function safeFailurePhase(value) {
  return FAILURE_PHASES.has(value) ? value : "entrypoint";
}

export async function runPostgresCommunityGraphBenchmark({ env = process.env, dependencies = {} } = {}) {
  const runStarted = performance.now();
  const cpuStart = process.cpuUsage();
  const memoryStart = memorySnapshot();
  const readServiceAccountEmail = dependencies.readServiceAccountEmail
    ?? readAttachedCommunityGraphBenchmarkServiceAccount;
  const createConnector = dependencies.createConnector ?? (() => new Connector());
  const createPool = dependencies.createPool ?? createCloudSqlIamPool;
  const closeResources = dependencies.closeResources ?? closeCloudSqlResources;
    const readMigrations = dependencies.readMigrations ?? readPostgresMigrations;
  let connector;
  let pool;
  let closeFailure = null;
  let phase = "configuration";
  try {
    const profileName = env?.POSTGRES_GRAPH_BENCHMARK_PROFILE;
    const profile = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES[profileName];
    const digests = computePostgresCommunityGraphBenchmarkDigests(profileName);
    if (digests.workloadDigest !== profile.workloadDigest || digests.sourceDigest !== profile.sourceDigest) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SOURCE_DIGEST_INVALID");
    }
    phase = "identity";
    const serviceAccountEmail = await readServiceAccountEmail();
    const config = parsePostgresCommunityGraphBenchmarkConfig(env, serviceAccountEmail);
    phase = "connection";
    const setupStart = performance.now();
    connector = createConnector();
    if (!connector || typeof connector.getOptions !== "function") {
      fail("CLOUD_SQL_COMMUNITY_GRAPH_BENCHMARK_CONNECTOR_INVALID");
    }
    pool = await createPool({
      connector,
      instanceConnectionName: config.instanceConnectionName,
      database: config.database,
      user: config.iamUser,
      max: 1,
      applicationName: APPLICATION_NAME,
    });
    if (!pool || typeof pool.connect !== "function") {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_POOL_INVALID");
    }
    const connectionSetupMilliseconds = durationMilliseconds(setupStart);
    const metrics = createPostgresCommunityGraphBenchmarkMetrics(pool);
    phase = "migration_source";
    const migrations = await readPostgresCommunityGraphBenchmarkMigrations({ readMigrations });
    const migrationExpected = migrationManifestReceipt(migrations);

    phase = "preflight";
    metrics.setPhase("target_preflight");
    const preflightStart = performance.now();
    await verifyTargetPreflight(metrics.pool, config);
    const migrationReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
      metrics.pool, config.schema, migrations,
    );
    if (migrationReceipt.count !== migrationExpected.count
        || migrationReceipt.tail !== migrationExpected.tail
        || migrationReceipt.sha256 !== migrationExpected.sha256) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID");
    }
    const preflightMilliseconds = durationMilliseconds(preflightStart);

    phase = "seed";
    metrics.setPhase("seed");
    const seedStart = performance.now();
    await seedPostgresCommunityGraphBenchmark(metrics.pool, config);
    const seedMilliseconds = durationMilliseconds(seedStart);

    const schema = Object.freeze({
      primarySchema: config.schema,
      ledgerSchema: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_UNUSED_LEDGER_SCHEMA,
    });
    phase = "publish";
    metrics.setPhase("publish");
    const publishCpuStart = process.cpuUsage();
    const publishStart = performance.now();
    const publication = await publishPostgresCommunityModelDayStream(metrics.pool, {
      sourcePin: SOURCE_PIN,
      members: syntheticMembers(profile.members),
      day: DAY,
      nowMs: COMPUTED_AT_MS,
      schema,
    });
    const publishMilliseconds = durationMilliseconds(publishStart);
    const publishCpu = cpuMilliseconds(process.cpuUsage(publishCpuStart));
    if (publication?.state !== "published" || publication.memberCount !== profile.members) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PUBLICATION_INVALID");
    }

    phase = "readback";
    metrics.setPhase("readback");
    const readCpuStart = process.cpuUsage();
    const readStart = performance.now();
    const readback = await readPostgresCommunityModelDay(metrics.pool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      day: DAY,
      schema,
    });
    const readbackMilliseconds = durationMilliseconds(readStart);
    const readbackCpu = cpuMilliseconds(process.cpuUsage(readCpuStart));
    if (!readback || readback.day !== DAY
        || readback.fittedParticipantCount !== profile.members
        || readback.v1ParticipantCount !== profile.members
        || readback.unsupportedSourceParticipantCount !== 0
        || !Array.isArray(readback.values)
        || canonicalJson(readback.values) !== canonicalJson([["gpt-6-astra", 1000, profile.members]])) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_READBACK_INVALID");
    }
    phase = "verification";
    const outputDigest = sha256(canonicalJson(readback));
    if (outputDigest !== profile.outputDigest) fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_OUTPUT_DIGEST_INVALID");
    const metricsSnapshot = metrics.snapshot();
    if (metricsSnapshot.connections.checkedOutAtEnd !== 0
        || metricsSnapshot.connections.poolMax !== 1
        || metricsSnapshot.pages.stagedMemberPages !== Math.ceil(profile.members / 4_000)
        || metricsSnapshot.pages.ownerResultPages !== Math.ceil(profile.members / 1_024)
        || metricsSnapshot.pages.resultPageApplyQueries !== metricsSnapshot.pages.ownerResultPages
        || metricsSnapshot.pages.publicationMemberWriteQueries !== Math.ceil(profile.members / 4_000)
        || metricsSnapshot.pages.publicationMemberReadPages < 1) {
      fail("POSTGRES_COMMUNITY_GRAPH_BENCHMARK_METRICS_INVALID");
    }
    const memoryEnd = memorySnapshot();
    const cpu = cpuMilliseconds(process.cpuUsage(cpuStart));
    return Object.freeze({
      schemaVersion: "postgres-community-graph-cloud-run-benchmark-v1",
      status: "ok",
      job: config.job,
      project: config.project,
      execution: config.execution,
      profile: config.profile,
      members: profile.members,
      workloadDigest: digests.workloadDigest,
      sourceDigest: digests.sourceDigest,
      outputDigest,
      migrationReceipt: Object.freeze({
        count: migrationReceipt.count,
        tail: migrationReceipt.tail,
        sha256: migrationReceipt.sha256,
      }),
      timingMilliseconds: Object.freeze({
        setup: connectionSetupMilliseconds,
        preflight: preflightMilliseconds,
        seed: seedMilliseconds,
        publish: publishMilliseconds,
        readback: readbackMilliseconds,
        total: durationMilliseconds(runStarted),
      }),
      cpuMilliseconds: Object.freeze({
        total: cpu,
        publish: publishCpu,
        readback: readbackCpu,
      }),
      memoryBytes: Object.freeze({
        start: memoryStart,
        end: memoryEnd,
        maxObservedRssBytes: Math.max(memoryStart.rssBytes, memoryEnd.rssBytes),
      }),
      peakRssKilobytes: process.resourceUsage().maxRSS,
      sql: Object.freeze({
        bootstrapCalls: 1,
        benchmarkCalls: metricsSnapshot.queryCalls,
        totalCalls: metricsSnapshot.queryCalls + 1,
        rowsRead: metricsSnapshot.rowsRead,
        rowsAffected: metricsSnapshot.rowsAffected,
        resultTextBytesEstimate: metricsSnapshot.textBytesReadEstimate,
        connections: metricsSnapshot.connections,
        pages: metricsSnapshot.pages,
        categories: metricsSnapshot.queries,
      }),
      claims: Object.freeze({ hostedTenfoldClaimQualified: false }),
    });
  } catch (error) {
    const code = safeErrorCode(error);
    throw Object.assign(new Error(code), { code, phase: safeFailurePhase(phase) });
  } finally {
    phase = "cleanup";
    try {
      await closeResources({ pools: [pool], connector });
    } catch (error) {
      closeFailure = safeErrorCode(error);
    }
    if (closeFailure !== null) {
      throw Object.assign(new Error(closeFailure), { code: closeFailure, phase: "cleanup" });
    }
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check-source") {
      const migrations = await readPostgresCommunityGraphBenchmarkMigrations();
      const manifest = migrationManifestReceipt(migrations);
      process.stdout.write(`${JSON.stringify({
        schemaVersion: "postgres-community-graph-cloud-run-benchmark-build-check-v1",
        status: "ok",
        migrationCount: manifest.count,
        migrationTail: manifest.tail,
        migrationDigest: manifest.sha256,
      })}\n`);
      return;
    }
    if (args.length !== 0) fail("CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_ARGUMENT_INVALID");
    const receipt = await runPostgresCommunityGraphBenchmark();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "postgres-community-graph-cloud-run-benchmark-v1",
      status: "failed",
      code: safeErrorCode(error),
      phase: safeFailurePhase(error?.phase),
    })}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
