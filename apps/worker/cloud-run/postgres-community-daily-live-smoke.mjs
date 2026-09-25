#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";
import {
  POSTGRES_COMMUNITY_DAILY_TEST_JOB,
  POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
} from "./postgres-community-daily-contract.mjs";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RECEIPT_BYTES = 8_192;
const MAX_RESPONSE_BYTES = 262_144;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validDay(value) {
  return typeof value === "string" && DAY_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function validateJobReceipt(receipt) {
  if (!exactKeys(receipt, [
    "schemaVersion", "status", "job", "project", "execution", "day",
    "publicationState", "revision", "readback", "projectionScope",
    "activityState", "usageEvents", "allowanceState",
  ])
      || receipt.schemaVersion !== "postgres-community-daily-test-v1"
      || receipt.status !== "ok"
      || receipt.job !== POSTGRES_COMMUNITY_DAILY_TEST_JOB
      || receipt.project !== CLOUD_RUN_IAM_TEST_TARGET.project
      || typeof receipt.execution !== "string"
      || !/^[a-z][a-z0-9-]{0,62}$/u.test(receipt.execution)
      || !validDay(receipt.day)
      || !["published", "unchanged"].includes(receipt.publicationState)
      || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1
      || receipt.readback !== "exact_revision_verified"
      || receipt.projectionScope !== POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE
      || !Number.isSafeInteger(receipt.usageEvents) || receipt.usageEvents < 0
      || receipt.activityState !== (receipt.usageEvents === 0 ? "empty" : "partial_v1_v1_1_only")
      || receipt.allowanceState !== "updating") {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RECEIPT_INVALID");
  }
  return receipt;
}

async function readBoundedJson(response) {
  let text;
  try { text = await response.text(); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_BODY_UNAVAILABLE");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_BODY_INVALID");
  }
  try { return JSON.parse(text); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_BODY_INVALID");
  }
}

function hasSourceIdentityField(value) {
  if (Array.isArray(value)) return value.some(hasSourceIdentityField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key === "sourceId" || key === "sourceNamespace" || hasSourceIdentityField(child));
}

function validateDailyReadback(body, receipt) {
  if (!exactKeys(body, ["schemaVersion", "from", "to", "allowanceState", "allowanceReadState", "days"])
      || body.schemaVersion !== "community-daily-read-v1.0"
      || body.from !== receipt.day || body.to !== receipt.day
      || body.allowanceState !== "updating"
      || !["confirmed", "temporarily_unavailable"].includes(body.allowanceReadState)
      || !Array.isArray(body.days) || body.days.length !== 1) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_READBACK_INVALID");
  }
  const [entry] = body.days;
  if (!exactKeys(entry, ["day", "revision", "releasedAt", "payload"])
      || entry.day !== receipt.day || entry.revision !== receipt.revision
      || typeof entry.releasedAt !== "string" || !Number.isFinite(Date.parse(entry.releasedAt))
      || entry.payload === null || typeof entry.payload !== "object" || Array.isArray(entry.payload)
      || entry.payload.day !== receipt.day || entry.payload.revision !== receipt.revision
      || entry.payload.totals?.usageEvents !== receipt.usageEvents
      || Object.hasOwn(entry.payload, "allowance")
      || Object.hasOwn(entry.payload, "capacityByPlanType")
      || hasSourceIdentityField(body)) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_READBACK_INVALID");
  }
  return Object.freeze({
    activityState: receipt.activityState,
    allowanceReadState: body.allowanceReadState,
    allowanceState: body.allowanceState,
    day: receipt.day,
    revision: receipt.revision,
    usageEvents: receipt.usageEvents,
  });
}

/** Verify the exact private A2 HTTP day/revision using a receipt from the Job. */
export async function runPostgresCommunityDailyLiveSmoke({
  receipt,
  dependencies = {},
} = {}) {
  const jobReceipt = validateJobReceipt(receipt);
  const origin = CLOUD_RUN_IAM_TEST_TARGET.origin;
  let token;
  try { token = await (dependencies.getIdToken ?? getDefaultIdToken)(origin); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_TOKEN_UNAVAILABLE");
  }
  if (typeof token !== "string" || token.length < 1 || token.length > 8192
      || /[\r\n]/u.test(token)) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_TOKEN_UNAVAILABLE");
  }
  const url = new URL("/api/v1/community/daily", origin);
  url.searchParams.set("from", jobReceipt.day);
  url.searchParams.set("to", jobReceipt.day);
  let response;
  try {
    response = await (dependencies.fetchImpl ?? globalThis.fetch)(url, {
      method: "GET",
      headers: {
        "x-serverless-authorization": `Bearer ${token}`,
        accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_HTTP_UNAVAILABLE");
  }
  const contentType = response?.headers?.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (response?.status !== 200 || response.redirected === true
      || response.headers?.get("cache-control") !== "no-store"
      || response.headers?.get("referrer-policy") !== "no-referrer"
      || response.headers?.get("x-content-type-options") !== "nosniff"
      || contentType !== "application/json") {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RESPONSE_INVALID");
  }
  const body = await readBoundedJson(response);
  const readback = validateDailyReadback(body, jobReceipt);
  return Object.freeze({
    schemaVersion: "postgres-community-daily-live-smoke-v1",
    status: "ok",
    project: CLOUD_RUN_IAM_TEST_TARGET.project,
    service: CLOUD_RUN_IAM_TEST_TARGET.service,
    route: "private_http_get",
    readback: "exact_day_revision_verified",
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
    ...readback,
  });
}

async function getDefaultIdToken(audience) {
  if (audience !== CLOUD_RUN_IAM_TEST_TARGET.origin) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_AUDIENCE_INVALID");
  }
  try {
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders(audience);
    const authorization = headers.get?.("authorization") ?? headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_TOKEN_UNAVAILABLE");
    }
    return authorization.slice("Bearer ".length);
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_TOKEN_UNAVAILABLE");
  }
}

async function readJobReceipt(path) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 1 || metadata.size > MAX_RECEIPT_BYTES) {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RECEIPT_INVALID");
  }
  let text;
  try { text = await readFile(path, "utf8"); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RECEIPT_INVALID");
  }
  try { return JSON.parse(text); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RECEIPT_INVALID");
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0].startsWith("--receipt=")
        || args[0].slice("--receipt=".length).length === 0) {
      fail("POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_ARGUMENT_INVALID");
    }
    const receipt = await readJobReceipt(resolve(args[0].slice("--receipt=".length)));
    const result = await runPostgresCommunityDailyLiveSmoke({ receipt });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "postgres-community-daily-live-smoke-v1",
      status: "failed",
      code: typeof error?.code === "string"
        && /^POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_[A-Z0-9_]+$/u.test(error.code)
        ? error.code : "POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_FAILED",
    })}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
