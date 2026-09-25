#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { publishPostgresCommunityDailyDay } from "../src/postgres-community-daily-publisher.ts";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const POSTGRES_COMMUNITY_DAILY_TEST_JOB = "tibotattle-community-daily-publish-test";
export const POSTGRES_COMMUNITY_DAILY_TEST_PROJECT = CLOUD_RUN_IAM_TEST_TARGET.project;
export const POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER = CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser;
export const POSTGRES_COMMUNITY_DAILY_TEST_TARGET = CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;
export const POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE =
  "v1_v1_1_only_v1_2_excluded";

const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";

function fail(code, phase = undefined) {
  throw Object.assign(new Error(code), { code, ...(phase === undefined ? {} : { phase }) });
}

function validDay(value) {
  return typeof value === "string" && DAY_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

/** Reject any non-test Job target before metadata or database access. */
export function parsePostgresCommunityDailyTestConfig(env, attachedServiceAccountEmail) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== POSTGRES_COMMUNITY_DAILY_TEST_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== POSTGRES_COMMUNITY_DAILY_TEST_PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_JOB_CONTEXT_INVALID");
  }
  if (env.CLOUD_RUN_TEST_SERVICE !== CLOUD_RUN_IAM_TEST_TARGET.service
      || env.HOST_ORIGIN !== CLOUD_RUN_IAM_TEST_TARGET.origin) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_SERVICE_INVALID");
  }
  let iamUser;
  try { iamUser = normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER"); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER_INVALID");
  }
  if (iamUser !== POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER_INVALID");
  }
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== POSTGRES_COMMUNITY_DAILY_TEST_TARGET.instanceConnectionName
      || env.PRIMARY_DATABASE !== POSTGRES_COMMUNITY_DAILY_TEST_TARGET.database
      || env.PRIMARY_SCHEMA !== POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_TARGET_INVALID");
  }
  if (!validDay(env.COMMUNITY_DAILY_SYNTHETIC_DAY)) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_DAY_INVALID");
  }
  if (!SOURCE_ID_PATTERN.test(env.POSTGRES_SOURCE_ID ?? "")
      || !SOURCE_ID_PATTERN.test(env.POSTGRES_SOURCE_NAMESPACE ?? "")) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_SOURCE_IDENTITY_INVALID");
  }
  if (attachedServiceAccountEmail !== POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT_INVALID");
  }
  return Object.freeze({
    job: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    project: POSTGRES_COMMUNITY_DAILY_TEST_PROJECT,
    execution: env.CLOUD_RUN_EXECUTION,
    service: CLOUD_RUN_IAM_TEST_TARGET.service,
    origin: CLOUD_RUN_IAM_TEST_TARGET.origin,
    instanceConnectionName: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.instanceConnectionName,
    database: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.database,
    schema: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema,
    iamUser,
    sourceId: env.POSTGRES_SOURCE_ID,
    sourceNamespace: env.POSTGRES_SOURCE_NAMESPACE,
    day: env.COMMUNITY_DAILY_SYNTHETIC_DAY,
  });
}

export async function readAttachedPostgresCommunityDailyTestServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200 || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_METADATA_UNAVAILABLE");
  }
  if (email !== POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function safeErrorCode(error, fallback = "POSTGRES_COMMUNITY_DAILY_TEST_FAILED") {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_COMMUNITY_DAILY_TEST_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : fallback;
}

function assertPublishedReadback(read, day, revision) {
  if (read === null || typeof read !== "object" || !Array.isArray(read.rows)
      || read.rows.length !== 1) fail("POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID");
  const row = read.rows[0];
  if (row?.day !== day || row.revision !== revision || typeof row.payload_json !== "string") {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID");
  }
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
      || payload.day !== day || payload.revision !== revision
      || Object.hasOwn(payload, "capacityByPlanType")) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID");
  }
  const usageEvents = payload.totals?.usageEvents;
  if (!Number.isSafeInteger(usageEvents) || usageEvents < 0) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID");
  }
  return usageEvents;
}

const PREFLIGHT_BLOCKERS = new Set([
  "POSTGRES_MAJOR_VERSION_UNSUPPORTED",
  "SOURCE_FENCE_UNAVAILABLE",
  "SOURCE_IDENTITY_MISMATCH",
  "V1_ADMISSION_NOT_CURRENT",
  "V11_ADMISSION_NOT_CURRENT",
  "PUBLICATION_POLICY_UNAVAILABLE",
  "PUBLICATION_CONTROLS_DISABLED",
  "ANALYTICS_CURSOR_AUTHORITY_MISMATCH",
  "ANALYTICS_CURSOR_BEHIND_JOURNAL",
  "TERMINAL_EVENT_BEHIND_CURSOR",
]);

function parseNonNegativeBigInt(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

/**
 * Read the publisher fence in one read-only snapshot. This deliberately does
 * not activate controls or advance the analytics cursor; the publisher repeats
 * its fence inside the write transaction before it can publish.
 */
export async function readPostgresCommunityDailyTestPreflight(pool, config) {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
      || config === null || typeof config !== "object"
      || typeof config.schema !== "string"
      || !/^[a-z_][a-z0-9_]{0,62}$/u.test(config.schema)
      || config.schema.startsWith("pg_") || config.schema === "information_schema"
      || typeof config.sourceId !== "string" || !/^[\x21-\x7e]{1,200}$/u.test(config.sourceId)
      || typeof config.sourceNamespace !== "string"
      || !/^[\x21-\x7e]{1,200}$/u.test(config.sourceNamespace)) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_CONFIGURATION_INVALID");
  }
  const schema = `"${config.schema}"`;
  const client = await pool.connect();
  let transactionOpen = false;
  let result;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    result = await client.query(
      `SELECT current_setting('server_version_num')::integer AS server_version_num,
              source.source_id, source.authority_epoch AS source_authority_epoch,
              cursor.sequence AS cursor_sequence,
              cursor.authority_epoch AS cursor_authority_epoch,
              v1.source_namespace AS v1_source_namespace,
              v1.runtime_contract_version AS v1_runtime_contract_version,
              v11.source_namespace AS v11_source_namespace,
              v11.runtime_contract_version AS v11_runtime_contract_version,
              policy.policy_revision, controls.revision AS collection_revision,
              controls.control_state, controls.publication_enabled,
              COALESCE((SELECT max(change.sequence)
                FROM ${schema}.storage_ingestion_changes change
                WHERE change.source_id=source.source_id), 0)::text AS latest_sequence,
              COALESCE((SELECT max(change.sequence)
                FROM ${schema}.storage_ingestion_changes change
                WHERE change.source_id=source.source_id
                  AND change.kind IN ('owner-withdrawn', 'owner-erased')), 0)::text
                AS terminal_sequence
         FROM ${schema}.storage_source_state source
         JOIN ${schema}.analytics_source_cursors cursor
           ON cursor.source_id=source.source_id
         JOIN ${schema}.typed_v1_admission_state v1 ON v1.id=1
         JOIN ${schema}.typed_v11_admission_state v11 ON v11.id=1
         JOIN ${schema}.publication_state policy ON policy.singleton=1
         JOIN ${schema}.collection_controls controls ON controls.singleton=1
        WHERE source.singleton=1 AND source.source_id=$1`,
      [config.sourceId],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* preserve safe failure */ }
    }
    fail("POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_UNAVAILABLE");
  } finally {
    client.release();
  }

  const row = result?.rows?.[0];
  const blockers = [];
  if (!Array.isArray(result?.rows) || result.rows.length !== 1
      || row === null || typeof row !== "object") {
    blockers.push("SOURCE_FENCE_UNAVAILABLE");
  } else {
    if (Math.floor(Number(row.server_version_num) / 10_000) !== 17) {
      blockers.push("POSTGRES_MAJOR_VERSION_UNSUPPORTED");
    }
    if (row.source_id !== config.sourceId) blockers.push("SOURCE_IDENTITY_MISMATCH");
    if (row.v1_source_namespace !== config.sourceNamespace
        || Number(row.v1_runtime_contract_version) !== 1) {
      blockers.push("V1_ADMISSION_NOT_CURRENT");
    }
    if (row.v11_source_namespace !== config.sourceNamespace
        || Number(row.v11_runtime_contract_version) !== 1) {
      blockers.push("V11_ADMISSION_NOT_CURRENT");
    }
    const policyRevision = Number(row.policy_revision);
    const collectionRevision = Number(row.collection_revision);
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 1
        || !Number.isSafeInteger(collectionRevision) || collectionRevision < 1) {
      blockers.push("PUBLICATION_POLICY_UNAVAILABLE");
    }
    if (row.control_state !== "operational" || row.publication_enabled !== true) {
      blockers.push("PUBLICATION_CONTROLS_DISABLED");
    }
    const sourceEpoch = parseNonNegativeBigInt(row.source_authority_epoch);
    const cursorEpoch = parseNonNegativeBigInt(row.cursor_authority_epoch);
    const cursorSequence = parseNonNegativeBigInt(row.cursor_sequence);
    const latestSequence = parseNonNegativeBigInt(row.latest_sequence);
    const terminalSequence = parseNonNegativeBigInt(row.terminal_sequence);
    if (sourceEpoch === null || cursorEpoch === null || sourceEpoch !== cursorEpoch) {
      blockers.push("ANALYTICS_CURSOR_AUTHORITY_MISMATCH");
    }
    if (cursorSequence === null || latestSequence === null || cursorSequence < latestSequence) {
      blockers.push("ANALYTICS_CURSOR_BEHIND_JOURNAL");
    }
    if (cursorSequence === null || terminalSequence === null || cursorSequence < terminalSequence) {
      blockers.push("TERMINAL_EVENT_BEHIND_CURSOR");
    }
  }
  return Object.freeze({
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers: Object.freeze(blockers),
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
  });
}

function validatePreflightResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
      || !["ready", "blocked"].includes(result.status)
      || !Array.isArray(result.blockers)
      || result.blockers.some((code) => !PREFLIGHT_BLOCKERS.has(code))
      || result.projectionScope !== POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE
      || (result.status === "ready" && result.blockers.length !== 0)
      || (result.status === "blocked" && result.blockers.length === 0)) {
    fail("POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_INVALID");
  }
  return result;
}

/** Run one exact UTC day, then verify the same immutable revision through the public reader. */
export async function runPostgresCommunityDailyTest({
  env = process.env,
  dependencies = {},
  preflightOnly = false,
} = {}) {
  let phase = "configuration";
  let connector;
  let pool;
  let receipt;
  let closeFailure = null;
  try {
    // Reject wrong project/job/day/target configuration before querying the
    // metadata server for the attached runtime identity.
    parsePostgresCommunityDailyTestConfig(env, POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT);
    const attachedEmail = dependencies.attachedServiceAccountEmail
      ?? await (dependencies.readAttachedServiceAccount
        ?? readAttachedPostgresCommunityDailyTestServiceAccount)({ fetchImpl: dependencies.fetchImpl });
    const config = parsePostgresCommunityDailyTestConfig(env, attachedEmail);
    phase = "connection";
    connector = dependencies.createConnector?.() ?? new Connector();
    pool = await (dependencies.createIamPool ?? createCloudSqlIamPool)({
      connector,
      instanceConnectionName: config.instanceConnectionName,
      database: config.database,
      user: config.iamUser,
      max: 1,
      applicationName: "tibotattle-community-daily-test",
    });
    phase = "preflight";
    const preflight = validatePreflightResult(await (dependencies.preflight
      ?? readPostgresCommunityDailyTestPreflight)(pool, config));
    if (preflightOnly) {
      receipt = Object.freeze({
        schemaVersion: "postgres-community-daily-test-preflight-v1",
        status: preflight.status,
        job: config.job,
        project: config.project,
        execution: config.execution,
        day: config.day,
        readOnly: true,
        projectionScope: preflight.projectionScope,
        blockers: preflight.blockers,
      });
    } else {
      if (preflight.status !== "ready") {
        throw Object.assign(new Error("POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_BLOCKED"), {
          code: "POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_BLOCKED",
          preflightBlockers: preflight.blockers,
        });
      }
      phase = "publication";
      const publication = await (dependencies.publish ?? publishPostgresCommunityDailyDay)(pool, {
        sourceId: config.sourceId,
        sourceNamespace: config.sourceNamespace,
        day: config.day,
        schema: { primarySchema: config.schema },
      });
      if (publication === null || typeof publication !== "object"
          || !["published", "unchanged"].includes(publication.state)
          || publication.day !== config.day
          || !Number.isSafeInteger(publication.revision) || publication.revision < 1) {
        fail("POSTGRES_COMMUNITY_DAILY_TEST_PUBLICATION_INVALID");
      }
      phase = "readback";
      const read = await (dependencies.readPublished ?? readPostgresPublishedCommunityDaily)(pool, {
        sourceId: config.sourceId,
        sourceNamespace: config.sourceNamespace,
        fromDay: config.day,
        throughDay: config.day,
        schema: { primarySchema: config.schema },
      });
      const usageEvents = assertPublishedReadback(read, config.day, publication.revision);
      receipt = Object.freeze({
        schemaVersion: "postgres-community-daily-test-v1",
        status: "ok",
        job: config.job,
        project: config.project,
        execution: config.execution,
        day: config.day,
        publicationState: publication.state,
        revision: publication.revision,
        readback: "exact_revision_verified",
        projectionScope: preflight.projectionScope,
        activityState: usageEvents === 0 ? "empty" : "partial_v1_v1_1_only",
        usageEvents,
        allowanceState: "updating",
      });
    }
  } catch (error) {
    const code = safeErrorCode(error, `POSTGRES_COMMUNITY_DAILY_TEST_${phase.toUpperCase()}_FAILED`);
    throw Object.assign(new Error(code), {
      code,
      phase,
      ...(Array.isArray(error?.preflightBlockers)
        ? { preflightBlockers: error.preflightBlockers }
        : {}),
    });
  } finally {
    if (pool !== undefined || connector !== undefined) {
      try { await (dependencies.closeResources ?? closeCloudSqlResources)({ pools: [pool], connector }); }
      catch (error) { closeFailure = safeErrorCode(error, "POSTGRES_COMMUNITY_DAILY_TEST_CLOSE_FAILED"); }
    }
  }
  if (closeFailure !== null) fail(closeFailure, "cleanup");
  return receipt;
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--preflight")) {
      fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_ARGUMENT_INVALID");
    }
    const receipt = await runPostgresCommunityDailyTest({ preflightOnly: args[0] === "--preflight" });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.status === "blocked") process.exitCode = 2;
  } catch (error) {
    const blocked = error?.code === "POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_BLOCKED";
    process.stderr.write(`${JSON.stringify({
      schemaVersion: blocked
        ? "postgres-community-daily-test-preflight-v1"
        : "postgres-community-daily-test-v1",
      status: blocked ? "blocked" : "failed",
      code: safeErrorCode(error),
      phase: typeof error?.phase === "string" ? error.phase : "configuration",
      ...(Array.isArray(error?.preflightBlockers)
        ? { blockers: error.preflightBlockers }
        : {}),
    })}\n`);
    process.exitCode = blocked ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
