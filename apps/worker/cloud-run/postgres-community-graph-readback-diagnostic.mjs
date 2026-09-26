#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { quotePostgresIdentifier, withPostgresRead } from "../src/postgres-client.ts";
import { postgresCommunityGraphMemberReadbackPageSelect } from "../src/postgres-community-graph-readback-query.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { readPostgresMigrations } from "./postgres-migrations.mjs";

export { postgresCommunityGraphMemberReadbackPageSelect };

export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB =
  "tibotattle-public-graph-readback-diagnostic";
export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE = "100k-readindexed";
export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA =
  "tibotattle_graph_benchmark_100k_readindexed_20260925";
export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER =
  "tibotattle-test-runtime@tibotattle.iam";
export const POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET = Object.freeze({
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  database: "tibotattle",
});

const PROJECT = "tibotattle";
const SCHEMA_OWNER = "tibotattle-test-migrator@tibotattle.iam";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const SOURCE_ID = "synthetic-community-source";
const DAY = "2026-09-23";
const MIGRATION_COUNT = 45;
const MIGRATION_TAIL = "0045_accountless_v12_history_retention.sql";
const MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
const EXPLAIN_TIMEOUT_MS = 15_000;
const MAX_PLAN_NODES = 64;
const MAX_PLAN_DEPTH = 12;
const APPLICATION_NAME = "tibotattle-public-graph-readback-diagnostic";
const STATEMENT_SCHEMA_VERSION = "postgres-community-graph-readback-explain-v1";

function fail(code, phase = undefined) {
  throw Object.assign(new Error(code), { code, ...(phase === undefined ? {} : { phase }) });
}

export async function readAttachedCommunityGraphReadbackDiagnosticServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200 || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (email !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function validateContext(env) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_CONTEXT_INVALID");
  }
  let iamUser;
  try { iamUser = normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER"); } catch {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER_INVALID");
  }
  if (iamUser !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER
      || env.POSTGRES_GRAPH_BENCHMARK_PROFILE !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE
      || env.PRIMARY_INSTANCE_CONNECTION_NAME !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.instanceConnectionName
      || env.PRIMARY_DATABASE !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.database
      || env.PRIMARY_SCHEMA !== POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA
      || env.LEDGER_INSTANCE_CONNECTION_NAME !== undefined
      || env.LEDGER_DATABASE !== undefined || env.LEDGER_SCHEMA !== undefined) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET_INVALID");
  }
  return Object.freeze({
    job: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB,
    profile: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE,
    schema: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA,
    project: PROJECT,
    serviceAccount: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT,
    iamUser,
    instanceConnectionName: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.instanceConnectionName,
    database: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.database,
  });
}

export function parsePostgresCommunityGraphReadbackDiagnosticConfig(env, attachedServiceAccountEmail) {
  const config = validateContext(env);
  if (attachedServiceAccountEmail !== config.serviceAccount) {
    fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

async function verifyMigrationReceipt(pool, migrations, schema) {
  if (!Array.isArray(migrations) || migrations.length !== MIGRATION_COUNT
      || migrations.at(-1)?.name !== MIGRATION_TAIL
      || migrations.some((migration, index) => migration?.version !== index + 1
        || typeof migration.name !== "string" || !/^[a-f0-9]{64}$/u.test(migration.sha256 ?? ""))) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_MIGRATION_SOURCE_INVALID", "migration_source");
  }
  const quoted = quotePostgresIdentifier(schema);
  const rows = await withPostgresRead(pool, async (client) => {
    const result = await client.query(`SELECT version, name, checksum_sha256
      FROM ${quoted}."${MIGRATION_HISTORY_TABLE}" ORDER BY version`);
    if (!Array.isArray(result?.rows)) {
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_MIGRATION_RECEIPT_INVALID", "migration_receipt");
    }
    return result.rows;
  }, {
    statementTimeoutMilliseconds: EXPLAIN_TIMEOUT_MS,
    operation: "postgres.community_graph_readback_diagnostic.migrations",
  });
  if (rows.length !== migrations.length || rows.some((row, index) =>
    safeCount(row.version) !== migrations[index].version
      || row.name !== migrations[index].name
      || row.checksum_sha256 !== migrations[index].sha256)) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_MIGRATION_RECEIPT_INVALID", "migration_receipt");
  }
  return Object.freeze({ count: rows.length, tail: MIGRATION_TAIL });
}

function safeCount(value) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET_INVALID", "target");
  }
  return result;
}

function readTargetSql(schema) {
  const quoted = quotePostgresIdentifier(schema);
  return `SELECT current_database() AS database_name,
                 current_user AS database_user,
                 current_setting('server_version_num')::integer AS server_version_num,
                 pg_get_userbyid(namespace.nspowner) AS schema_owner,
                 publication.generation,
                 publication.cohort_digest,
                 publication.payload_sha256,
                 capture.expected_members::text AS expected_members
            FROM pg_namespace namespace
            JOIN ${quoted}.analytics_publications publication
              ON publication.source_id = $2 AND publication.day = $3::date AND publication.metric = 'model'
            JOIN ${quoted}.analytics_publication_captures capture
              ON capture.source_id = publication.source_id AND capture.day = publication.day
             AND capture.metric = publication.metric AND capture.generation = publication.generation
             AND capture.cohort_digest = publication.cohort_digest
           WHERE namespace.nspname = $1`;
}

function validateTarget(row, config) {
  if (!row || typeof row !== "object"
      || row.database_name !== config.database || row.database_user !== config.iamUser
      || Math.floor(Number(row.server_version_num) / 10_000) !== 17
      || row.schema_owner !== SCHEMA_OWNER
      || safeCount(row.expected_members) !== 100_000
      || typeof row.generation !== "string" || !/^[a-f0-9]{64}$/u.test(row.generation)
      || row.cohort_digest !== row.generation
      || typeof row.payload_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.payload_sha256)) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET_INVALID", "target");
  }
  return row.generation;
}

function explainSql(schema) {
  const statement = postgresCommunityGraphMemberReadbackPageSelect(schema);
  return `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE, SETTINGS TRUE) ${statement}`;
}

function finiteNonnegative(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(code, "explain");
  return value;
}

function summarizePlanNode(node, state, depth = 0) {
  if (depth > MAX_PLAN_DEPTH || state.count >= MAX_PLAN_NODES
      || node === null || typeof node !== "object" || Array.isArray(node)
      || typeof node["Node Type"] !== "string" || !/^[A-Za-z ]{1,48}$/u.test(node["Node Type"])) {
    fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID", "explain");
  }
  state.count += 1;
  if (node["Node Type"] === "Sort") state.sortCount += 1;
  if (node["Node Type"].includes("Index")) state.indexScanCount += 1;
  const summary = {
    nodeType: node["Node Type"],
    planRows: safeCount(node["Plan Rows"]),
    planWidth: safeCount(node["Plan Width"]),
    startupCost: finiteNonnegative(node["Startup Cost"], "POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID"),
    totalCost: finiteNonnegative(node["Total Cost"], "POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID"),
  };
  if (node["Join Type"] !== undefined) {
    if (!["Inner", "Left", "Right", "Full", "Semi", "Anti"].includes(node["Join Type"])) {
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID", "explain");
    }
    summary.joinType = node["Join Type"];
  }
  if (node.Plans !== undefined) {
    if (!Array.isArray(node.Plans)) fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID", "explain");
    summary.children = node.Plans.map((child) => summarizePlanNode(child, state, depth + 1));
  }
  return summary;
}

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_FAILED";
}

const FAILURE_PHASES = new Set([
  "configuration", "identity", "connection", "migration_source", "migration_receipt", "target", "explain", "cleanup",
]);

function safeFailurePhase(value) {
  return FAILURE_PHASES.has(value) ? value : "configuration";
}

export async function runPostgresCommunityGraphReadbackDiagnostic({ env = process.env, dependencies = {} } = {}) {
  const readServiceAccountEmail = dependencies.readServiceAccountEmail
    ?? readAttachedCommunityGraphReadbackDiagnosticServiceAccount;
  const createConnector = dependencies.createConnector ?? (() => new Connector());
  const createPool = dependencies.createPool ?? createCloudSqlIamPool;
  const closeResources = dependencies.closeResources ?? closeCloudSqlResources;
  const readMigrations = dependencies.readMigrations ?? readPostgresMigrations;
  let connector;
  let pool;
  let phase = "configuration";
  try {
    const config = validateContext(env);
    phase = "identity";
    const attachedServiceAccountEmail = await readServiceAccountEmail();
    parsePostgresCommunityGraphReadbackDiagnosticConfig(env, attachedServiceAccountEmail);

    phase = "connection";
    connector = createConnector();
    if (!connector || typeof connector.getOptions !== "function") {
      fail("CLOUD_SQL_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_CONNECTOR_INVALID");
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
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_POOL_INVALID");
    }

    phase = "migration_source";
    const migrations = await readMigrations({ role: "primary", rootDirectory: MIGRATION_ROOT });

    phase = "migration_receipt";
    const migrationReceipt = await verifyMigrationReceipt(pool, migrations, config.schema);
    if (migrationReceipt.count !== MIGRATION_COUNT || migrationReceipt.tail !== MIGRATION_TAIL) {
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_MIGRATION_RECEIPT_INVALID");
    }

    phase = "target";
    const targetRows = await withPostgresRead(pool, async (client) => {
      const result = await client.query(readTargetSql(config.schema), [config.schema, SOURCE_ID, DAY]);
      if (!Array.isArray(result?.rows) || result.rows.length !== 1) {
        fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET_INVALID", "target");
      }
      return result.rows;
    }, {
      statementTimeoutMilliseconds: EXPLAIN_TIMEOUT_MS,
      operation: "postgres.community_graph_readback_diagnostic.target",
    });
    const generation = validateTarget(targetRows[0], config);

    phase = "explain";
    const sql = explainSql(config.schema);
    const explainStarted = performance.now();
    const explainRows = await withPostgresRead(pool, async (client) => {
      const result = await client.query(sql, [SOURCE_ID, DAY, generation, "", 4_096]);
      if (!Array.isArray(result?.rows) || result.rows.length !== 1) {
        fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID", "explain");
      }
      return result.rows;
    }, {
      statementTimeoutMilliseconds: EXPLAIN_TIMEOUT_MS,
      operation: "postgres.community_graph_readback_diagnostic.explain",
    });
    const explainElapsedMilliseconds = Math.round(performance.now() - explainStarted);
    const explainDocument = explainRows[0]?.["QUERY PLAN"];
    if (!Array.isArray(explainDocument) || explainDocument.length !== 1
        || !explainDocument[0]?.Plan) {
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PLAN_INVALID", "explain");
    }
    const planState = { count: 0, sortCount: 0, indexScanCount: 0 };
    const plan = summarizePlanNode(explainDocument[0].Plan, planState);
    return Object.freeze({
      schemaVersion: STATEMENT_SCHEMA_VERSION,
      status: "ok",
      profile: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE,
      memberCount: 100_000,
      migrationReceipt: Object.freeze({ count: migrationReceipt.count, tail: migrationReceipt.tail }),
      explainElapsedMilliseconds,
      statementSha256: createHash("sha256").update(sql).digest("hex"),
      planSummary: Object.freeze({
        nodeCount: planState.count,
        sortNodeCount: planState.sortCount,
        indexNodeCount: planState.indexScanCount,
        root: plan,
      }),
    });
  } catch (error) {
    const code = safeErrorCode(error);
    throw Object.assign(new Error(code), { code, phase: safeFailurePhase(error?.phase ?? phase) });
  } finally {
    phase = "cleanup";
    try {
      await closeResources({ pools: [pool], connector });
    } catch {
      fail("POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_CLEANUP_FAILED", "cleanup");
    }
  }
}

async function main() {
  try {
    if (process.argv.length !== 2) fail("CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_ARGUMENT_INVALID");
    const receipt = await runPostgresCommunityGraphReadbackDiagnostic();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: STATEMENT_SCHEMA_VERSION,
      status: "failed",
      code: safeErrorCode(error),
      phase: safeFailurePhase(error?.phase),
    })}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
