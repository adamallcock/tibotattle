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
}

/** Run one exact UTC day, then verify the same immutable revision through the public reader. */
export async function runPostgresCommunityDailyTest({
  env = process.env,
  dependencies = {},
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
    assertPublishedReadback(read, config.day, publication.revision);
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
    });
  } catch (error) {
    const code = safeErrorCode(error, `POSTGRES_COMMUNITY_DAILY_TEST_${phase.toUpperCase()}_FAILED`);
    throw Object.assign(new Error(code), { code, phase });
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
    if (args.length !== 0) fail("CLOUD_RUN_COMMUNITY_DAILY_TEST_ARGUMENT_INVALID");
    const receipt = await runPostgresCommunityDailyTest();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "postgres-community-daily-test-v1",
      status: "failed",
      code: safeErrorCode(error),
      phase: typeof error?.phase === "string" ? error.phase : "configuration",
    })}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
