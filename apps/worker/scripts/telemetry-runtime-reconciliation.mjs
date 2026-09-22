import { isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import { createProductionLiveProvider } from "./production-live-provider.mjs";
import {
  PRODUCTION_LIVE_CONFIG_SCHEMA,
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
} from "./production-live-config.mjs";
import { storageSchemaDigest } from "./d1-storage-plan.mjs";
import { TYPED_PRODUCTION_QUERIES } from "./production-typed-preflight.mjs";
import { durablePrivateJson, identityDigest } from "../../../scripts/lib/release-operation.mjs";

export const TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA =
  "typed-forward-post-deploy-reconciliation-v1";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function fail(code) {
  const error = new Error(`TELEMETRY_RUNTIME_RECONCILIATION_${code}`);
  error.code = error.message;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function queryRows(value, maximum) {
  const entry = Array.isArray(value)
    ? value.length === 1 ? value[0] : null
    : value;
  if (!object(entry) || entry.success !== true || !Array.isArray(entry.results)
      || entry.results.length > maximum) fail("QUERY_RESULT_INVALID");
  return entry.results;
}

function schemaRows(value) {
  const rows = queryRows(value, 4096);
  const seen = new Set();
  for (const row of rows) {
    if (!object(row)
        || Object.keys(row).sort().join(",") !== "name,sql,tbl_name,type"
        || !["table", "index", "trigger", "view"].includes(row.type)
        || typeof row.name !== "string" || typeof row.tbl_name !== "string"
        || !(typeof row.sql === "string" || row.sql === null)) {
      fail("SCHEMA_RESULT_INVALID");
    }
    const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
    if (seen.has(key)) fail("SCHEMA_RESULT_INVALID");
    seen.add(key);
  }
  if (rows.length < 1) fail("SCHEMA_RESULT_INVALID");
  return rows;
}

function ledgerRows(value) {
  const rows = queryRows(value, 129);
  for (const row of rows) {
    if (!object(row)
        || Object.keys(row).sort().join(",") !== "name,sha256"
        || typeof row.name !== "string" || !SHA256.test(row.sha256)) {
      fail("LEDGER_RESULT_INVALID");
    }
  }
  if (rows.length < 1) fail("LEDGER_RESULT_INVALID");
  return rows;
}

function exactIso(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function configIdentity(inventory) {
  let snapshot;
  try {
    snapshot = createProductionLiveConfigSnapshot(inventory);
  } catch {
    fail("LIVE_CONFIG_INVALID");
  }
  if (snapshot.schema !== PRODUCTION_LIVE_CONFIG_SCHEMA
      || !UUID_V4.test(snapshot.versionId)
      || !COMMIT.test(snapshot.sourceCommit ?? "")
      || !SHA256.test(productionLiveConfigFingerprint(snapshot))) {
    fail("LIVE_CONFIG_INVALID");
  }
  return {
    versionId: snapshot.versionId,
    sourceCommit: snapshot.sourceCommit,
    configSha256: productionLiveConfigFingerprint(snapshot),
  };
}

async function roleDigests(provider, inventory, binding) {
  const schema = schemaRows(await provider.query(
    inventory,
    binding,
    TYPED_PRODUCTION_QUERIES.schema,
  ));
  const ledger = ledgerRows(await provider.query(
    inventory,
    binding,
    TYPED_PRODUCTION_QUERIES.ledger,
  ));
  let schemaSha256;
  try {
    schemaSha256 = storageSchemaDigest(schema);
  } catch {
    fail("SCHEMA_DIGEST_INVALID");
  }
  return {
    schemaSha256,
    ledgerSha256: identityDigest(ledger),
  };
}

async function assertOutputAbsent(output) {
  try {
    await lstat(output);
    fail("OUTPUT_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function parseTelemetryRuntimeReconciliationArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("ARGUMENTS_INVALID");
    }
    if (!["--account-id", "--worker-name", "--output"].includes(key)
        || Object.hasOwn(result, key)) fail("ARGUMENTS_INVALID");
    result[key] = value;
    index += 1;
  }
  if (!/^[a-f0-9]{32}$/u.test(result["--account-id"] ?? "")
      || !/^[A-Za-z0-9_-]{1,63}$/u.test(result["--worker-name"] ?? "")
      || !isAbsolute(result["--output"] ?? "")) {
    fail("ARGUMENTS_INVALID");
  }
  // Keep the account identity check explicit so malformed account IDs never
  // reach the API.
  if (!/^[a-f0-9]{32}$/u.test(result["--account-id"])) fail("ARGUMENTS_INVALID");
  return result;
}

export async function captureTelemetryRuntimeReconciliation({
  accountId,
  workerName,
  output,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "")
      || !/^[A-Za-z0-9_-]{1,63}$/u.test(workerName ?? "")
      || !isAbsolute(output ?? "")) fail("ARGUMENTS_INVALID");
  // The parent directory must already be owner-private. durablePrivateJson
  // checks its owner/mode and performs an atomic 0600 replacement.
  await assertOutputAbsent(output);

  const provider = createProductionLiveProvider({
    accountId,
    workerName,
    environment,
    fetchImpl,
    now,
  });
  let before;
  let after;
  try {
    before = await provider.capture();
    const beforeIdentity = configIdentity(before);
    const primaryBefore = await roleDigests(provider, before, "USAGE_MONITOR_DB");
    const analyticsBefore = await roleDigests(provider, before, "ANALYTICS_DB");
    after = await provider.capture();
    const afterIdentity = configIdentity(after);
    if (beforeIdentity.versionId !== afterIdentity.versionId
        || beforeIdentity.sourceCommit !== afterIdentity.sourceCommit
        || beforeIdentity.configSha256 !== afterIdentity.configSha256) {
      fail("PREDECESSOR_CHANGED");
    }
    const primary = await roleDigests(provider, after, "USAGE_MONITOR_DB");
    const analytics = await roleDigests(provider, after, "ANALYTICS_DB");
    if (JSON.stringify(primaryBefore) !== JSON.stringify(primary)
        || JSON.stringify(analyticsBefore) !== JSON.stringify(analytics)) {
      fail("ROLE_CHANGED");
    }
    if (!exactIso(after.capturedAt)) fail("CAPTURE_TIME_INVALID");
    const unsigned = {
      schema: TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA,
      capturedAt: after.capturedAt,
      sourceCommit: afterIdentity.sourceCommit,
      versionId: afterIdentity.versionId,
      configSha256: afterIdentity.configSha256,
      primary,
      analytics,
    };
    const proof = Object.freeze({
      ...unsigned,
      proofSha256: identityDigest(unsigned),
    });
    await durablePrivateJson(output, proof);
    return proof;
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("TELEMETRY_RUNTIME_RECONCILIATION_")) throw error;
    fail("READ_FAILED");
  }
}

async function main() {
  const args = parseTelemetryRuntimeReconciliationArguments(process.argv.slice(2));
  const proof = await captureTelemetryRuntimeReconciliation({
    accountId: args["--account-id"],
    workerName: args["--worker-name"],
    output: args["--output"],
  });
  process.stdout.write(`${JSON.stringify({
    schema: proof.schema,
    output: args["--output"],
    sourceCommit: proof.sourceCommit,
    versionId: proof.versionId,
    configSha256: proof.configSha256,
    primary: proof.primary,
    analytics: proof.analytics,
    proofSha256: proof.proofSha256,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${typeof error?.code === "string"
      ? error.code
      : "TELEMETRY_RUNTIME_RECONCILIATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
