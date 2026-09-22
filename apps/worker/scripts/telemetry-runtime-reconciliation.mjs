import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { link, lstat, open, unlink } from "node:fs/promises";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { createProductionLiveProvider } from "./production-live-provider.mjs";
import { createProductionDeploymentLock } from "./production-deployment-lock.mjs";
import {
  PRODUCTION_LIVE_CONFIG_SCHEMA,
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
} from "./production-live-config.mjs";
import { storageSchemaDigest } from "./d1-storage-plan.mjs";
import { TYPED_PRODUCTION_QUERIES } from "./production-typed-preflight.mjs";
import {
  durablePrivateJson,
  identityDigest,
  openOperation,
} from "../../../scripts/lib/release-operation.mjs";

export const TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA =
  "typed-forward-post-deploy-reconciliation-v1";
export const TELEMETRY_RUNTIME_DEPLOYMENT_ATTESTATION_SCHEMA =
  "typed-forward-live-deployment-attestation-v1";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ADMIN_SESSION_SCHEMA = "telemetry-runtime-admin-session-v1";
const OPERATION_SCHEMA = "telemetry-runtime-activation-operation-v1";
const MAX_JSON_BYTES = 1_024 * 1_024;

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

function deploymentAttestation(identity, capturedAt) {
  if (!exactIso(capturedAt)) fail("LIVE_CONFIG_INVALID");
  const unsigned = {
    schema: TELEMETRY_RUNTIME_DEPLOYMENT_ATTESTATION_SCHEMA,
    capturedAt,
    sourceCommit: identity.sourceCommit,
    versionId: identity.versionId,
    configSha256: identity.configSha256,
  };
  return {
    ...unsigned,
    attestationSha256: identityDigest(unsigned),
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

/**
 * Publish a receipt with exclusive destination creation.  The initial
 * lstat() in captureTelemetryRuntimeReconciliation is a useful fast refusal,
 * but it cannot close a concurrent create race.  A private same-directory
 * hard-link is the no-clobber commit point: exactly one writer can claim the
 * requested destination and neither writer can replace an existing receipt.
 */
async function writePrivateJsonNoClobber(path, value) {
  const temporary = join(dirname(path), `.telemetry-reconciliation-${randomUUID()}.json`);
  await durablePrivateJson(temporary, value);
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS");
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function exactKeys(value, expected) {
  return object(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validateDeploymentAttestation(value) {
  if (!exactKeys(value, [
    "attestationSha256", "capturedAt", "configSha256", "schema", "sourceCommit", "versionId",
  ])
      || value.schema !== TELEMETRY_RUNTIME_DEPLOYMENT_ATTESTATION_SCHEMA
      || !exactIso(value.capturedAt)
      || !COMMIT.test(value.sourceCommit ?? "")
      || !UUID_V4.test(value.versionId ?? "")
      || !SHA256.test(value.configSha256 ?? "")
      || !SHA256.test(value.attestationSha256 ?? "")) {
    fail("PROOF_INVALID");
  }
  const { attestationSha256, ...unsigned } = value;
  if (identityDigest(unsigned) !== attestationSha256) fail("PROOF_INVALID");
  return value;
}

/** Validate a receipt before it becomes an activation input.  This mirrors
 * the Worker value-level proof checks without importing product TypeScript
 * into the operator runtime. */
export function validateTelemetryRuntimeReconciliationProof(value) {
  if (!exactKeys(value, [
    "analytics", "capturedAt", "configSha256", "deploymentAttestation", "primary",
    "proofSha256", "schema", "sourceCommit", "versionId",
  ])
      || value.schema !== TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA
      || !exactIso(value.capturedAt)
      || !COMMIT.test(value.sourceCommit ?? "")
      || !UUID_V4.test(value.versionId ?? "")
      || !SHA256.test(value.configSha256 ?? "")
      || !SHA256.test(value.proofSha256 ?? "")
      || !exactKeys(value.primary, ["ledgerSha256", "schemaSha256"])
      || !exactKeys(value.analytics, ["ledgerSha256", "schemaSha256"])
      || !SHA256.test(value.primary.schemaSha256 ?? "")
      || !SHA256.test(value.primary.ledgerSha256 ?? "")
      || !SHA256.test(value.analytics.schemaSha256 ?? "")
      || !SHA256.test(value.analytics.ledgerSha256 ?? "")) {
    fail("PROOF_INVALID");
  }
  const attestation = validateDeploymentAttestation(value.deploymentAttestation);
  const { proofSha256, ...unsigned } = value;
  if (identityDigest(unsigned) !== proofSha256
      || attestation.sourceCommit !== value.sourceCommit
      || attestation.versionId !== value.versionId
      || attestation.configSha256 !== value.configSha256
      || Date.parse(attestation.capturedAt) > Date.parse(value.capturedAt)) {
    fail("PROOF_INVALID");
  }
  return value;
}

function validateActivationRequest(value) {
  if (!exactKeys(value, ["action", "telemetryRuntimeActivation"])
      || value.action !== "run_maintenance") fail("REQUEST_INVALID");
  const activation = value.telemetryRuntimeActivation;
  if (!exactKeys(activation, [
    "confirmation", "expectedRevision", "idempotencyKey", "reconciliation", "target",
  ])
      || !["usage_v12", "performance"].includes(activation.target)
      || !UUID_V4.test(activation.idempotencyKey ?? "")
      || !Number.isSafeInteger(activation.expectedRevision)
      || activation.expectedRevision < 1
      || activation.confirmation !== (activation.target === "usage_v12"
        ? "activate_telemetry_v12_runtime"
        : "activate_telemetry_performance_runtime")) {
    fail("REQUEST_INVALID");
  }
  validateTelemetryRuntimeReconciliationProof(activation.reconciliation);
  return value;
}

function deploymentIdentity(inventory) {
  const identity = configIdentity(inventory);
  if (!exactIso(inventory?.capturedAt)) fail("LIVE_CONFIG_INVALID");
  return identity;
}

function assertDeploymentMatchesProof(identity, proof) {
  const attestation = proof.deploymentAttestation;
  if (identity.sourceCommit !== attestation.sourceCommit
      || identity.versionId !== attestation.versionId
      || identity.configSha256 !== attestation.configSha256) {
    fail("LIVE_DEPLOYMENT_DRIFT");
  }
}

function assertDeploymentStable(before, after) {
  if (before.sourceCommit !== after.sourceCommit
      || before.versionId !== after.versionId
      || before.configSha256 !== after.configSha256) {
    fail("LIVE_DEPLOYMENT_DRIFT_AFTER_MUTATION");
  }
}

function validateAdminOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("ADMIN_SESSION_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.origin !== value
      || parsed.pathname !== "/" || parsed.search || parsed.hash
      || value !== DEPLOYMENT_ENDPOINTS.admin.origin) {
    fail("ADMIN_SESSION_INVALID");
  }
  return value;
}

function validateAdminSession(value) {
  if (!exactKeys(value, ["accessJwt", "cookie", "csrfToken", "origin", "schema"])
      || value.schema !== ADMIN_SESSION_SCHEMA
      || typeof value.cookie !== "string"
      || value.cookie.length > 16_384
      || /[\0\r\n]/u.test(value.cookie)
      || (value.csrfToken !== null
        && (typeof value.csrfToken !== "string"
          || value.csrfToken.length < 1 || value.csrfToken.length > 96
          || /[\0\r\n]/u.test(value.csrfToken)))
      || (value.accessJwt !== null
        && (typeof value.accessJwt !== "string"
          || value.accessJwt.length < 1 || value.accessJwt.length > 16_384
          || /[\0\r\n]/u.test(value.accessJwt)))
      || (value.accessJwt === null
        && !/(?:^|;\s*)CF_Authorization=[^;]+/u.test(value.cookie))) {
    fail("ADMIN_SESSION_INVALID");
  }
  validateAdminOrigin(value.origin);
  return value;
}

async function readOwnerPrivateJson(path) {
  if (!isAbsolute(path ?? "")) fail("PRIVATE_FILE_INVALID");
  let info;
  try { info = await lstat(path); } catch { fail("PRIVATE_FILE_INVALID"); }
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())
      || info.size < 1 || info.size > MAX_JSON_BYTES) {
    fail("PRIVATE_FILE_INVALID");
  }
  let bytes;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1
        || current.size !== info.size) fail("PRIVATE_FILE_INVALID");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length !== info.size) fail("PRIVATE_FILE_INVALID");
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail("PRIVATE_FILE_INVALID"); }
}

async function postTelemetryRuntimeAdminAction({ session, request, fetchImpl = globalThis.fetch }) {
  validateAdminSession(session);
  if (typeof fetchImpl !== "function") fail("ADMIN_RESPONSE_UNCERTAIN");
  let response;
  try {
    response = await fetchImpl(`${session.origin}/api/v1/admin/action`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        cookie: session.cookie,
        origin: session.origin,
        "sec-fetch-site": "same-origin",
        "x-usage-monitor-admin": "1",
        ...(session.csrfToken === null ? {} : { "x-usage-monitor-csrf": session.csrfToken }),
        ...(session.accessJwt === null ? {} : { "cf-access-jwt-assertion": session.accessJwt }),
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("ADMIN_RESPONSE_UNCERTAIN");
  }
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    fail("ADMIN_RESPONSE_UNCERTAIN");
  }
  if (bytes.length > MAX_JSON_BYTES) fail("ADMIN_RESPONSE_UNCERTAIN");
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("ADMIN_RESPONSE_UNCERTAIN"); }
  if (!response.ok) fail("ADMIN_RESPONSE_REFUSED");
  if (!exactKeys(body, ["action", "result", "schemaVersion"])
      || body.schemaVersion !== "admin-action-v0.1"
      || body.action !== "run_maintenance"
      || !object(body.result)) fail("ADMIN_RESPONSE_INVALID");
  return body.result;
}

function lockOwnerSource(proof) {
  return proof.deploymentAttestation.sourceCommit;
}

function operationBinding({ accountId, workerName, request }) {
  const activation = request.telemetryRuntimeActivation;
  return {
    schema: OPERATION_SCHEMA,
    accountId,
    workerName,
    target: activation.target,
    idempotencyKey: activation.idempotencyKey,
    expectedRevision: activation.expectedRevision,
    proofSha256: activation.reconciliation.proofSha256,
    adminOrigin: DEPLOYMENT_ENDPOINTS.admin.origin,
  };
}

function deploymentIdentityShape(value) {
  return exactKeys(value, ["configSha256", "sourceCommit", "versionId"])
    && COMMIT.test(value.sourceCommit ?? "")
    && UUID_V4.test(value.versionId ?? "")
    && SHA256.test(value.configSha256 ?? "");
}

function activationResultShape(value, activation) {
  return exactKeys(value, [
    "fromRevision", "operationId", "revision", "state", "target", "task", "toRevision",
  ])
    && value.task === "telemetry_runtime_activation"
    && value.operationId === activation.idempotencyKey
    && value.target === activation.target
    && value.state === "active"
    && value.fromRevision === activation.expectedRevision
    && value.toRevision === activation.expectedRevision + 1
    && value.revision === activation.expectedRevision + 1;
}

function assertOperationState(state, activation) {
  if (!object(state)
      || !["lock_intent", "held", "admin_intent", "release_intent", "completed"].includes(state.status)
      || !COMMIT.test(state.owner ?? "")) {
    fail("OPERATION_STATE_INVALID");
  }
  if (["lock_intent", "held"].includes(state.status)
      && !exactKeys(state, ["owner", "status"])) fail("OPERATION_STATE_INVALID");
  if (state.status === "admin_intent"
      && (!exactKeys(state, ["beforeIdentity", "owner", "status"])
        || !deploymentIdentityShape(state.beforeIdentity))) fail("OPERATION_STATE_INVALID");
  if (state.status === "release_intent"
      && exactKeys(state, ["owner", "result", "status"])
      && exactKeys(state.result, ["status"])
      && state.result.status === "refused") return;
  if (["release_intent", "completed"].includes(state.status)
      && (!Object.hasOwn(state, "result") || !activationResultShape(state.result, activation)
        || !deploymentIdentityShape(state.beforeIdentity))) {
    if (state.status === "completed"
        && exactKeys(state, ["owner", "result", "status"])
        && exactKeys(state.result, ["status"])
        && state.result.status === "refused") return;
    fail("OPERATION_STATE_INVALID");
  }
}

/**
 * Run the owner-only activation transaction.  The operator, rather than the
 * Worker request body, is the trust boundary for version/config identity: it
 * acquires the shared production lock, captures the current live Worker just
 * before POST, and captures it again before releasing the lock.  A receipt
 * that no longer describes the live deployment never reaches the admin route.
 */
export async function runProtectedTelemetryRuntimeActivation({
  accountId,
  workerName,
  repositoryRoot,
  operationDirectory,
  request,
  session,
  resume = false,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  provider = null,
  liveProviderFactory = createProductionLiveProvider,
  lockFactory = ({ repositoryRoot: root }) => createProductionDeploymentLock({ repositoryRoot: root }),
  operationFactory = openOperation,
  postAdmin = postTelemetryRuntimeAdminAction,
} = {}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "")
      || !/^[A-Za-z0-9_-]{1,63}$/u.test(workerName ?? "")
      || !isAbsolute(repositoryRoot ?? "")
      || !isAbsolute(operationDirectory ?? "")) fail("ARGUMENTS_INVALID");
  validateActivationRequest(request);
  validateAdminSession(session);
  const activation = request.telemetryRuntimeActivation;
  const proof = activation.reconciliation;
  const binding = operationBinding({ accountId, workerName, request });
  const operation = await operationFactory({
    directory: operationDirectory,
    kind: "production",
    binding,
    resume,
  });
  let state = operation.record.state;
  const newOperation = Object.keys(state).length === 0;
  if (!newOperation || resume) assertOperationState(state, activation);
  if (state.status === "completed") {
    if (!activationResultShape(state.result, activation)
        && !(exactKeys(state.result, ["status"]) && state.result.status === "refused")) {
      fail("OPERATION_STATE_INVALID");
    }
    operation.close();
    return state.result;
  }
  const live = provider ?? liveProviderFactory({
    accountId,
    workerName,
    environment,
    fetchImpl,
    now,
  });
  const lock = lockFactory({ repositoryRoot });
  let lockHeld = false;
  let adminAttempted = state.status === "admin_intent";
  let acquisitionPending = newOperation;
  const releaseBeforeMutation = async () => {
    if (!lockHeld) return;
    state = { ...state, status: "release_intent", result: { status: "refused" } };
    await operation.save(state);
    await lock.release(state.owner);
    lockHeld = false;
    state = { ...state, status: "completed", result: { status: "refused" } };
    await operation.save(state);
  };
  try {
    if (state.status === "release_intent") {
      if (!object(state.result)) fail("OPERATION_STATE_INVALID");
      const ownerState = await lock.status();
      if (ownerState === null) {
        state = { ...state, status: "completed" };
        await operation.save(state);
        return state.result;
      }
      await lock.assertOwned(state.owner);
      lockHeld = true;
      await lock.release(state.owner);
      lockHeld = false;
      state = { ...state, status: "completed" };
      await operation.save(state);
      return state.result;
    }
    if (state.owner === undefined) {
      const owner = await lock.createOwner({
        id: operation.record.id,
        sourceCommit: lockOwnerSource(proof),
        previousSourceCommit: lockOwnerSource(proof),
      });
      state = { status: "lock_intent", owner };
      acquisitionPending = true;
      await operation.save(state);
    }
    if (!lockHeld) {
      const lockIntent = state.status === "lock_intent";
      if (acquisitionPending || lockIntent) {
        const observedOwner = await lock.status();
        if (observedOwner === state.owner) {
          lockHeld = true;
        } else if (observedOwner === null) {
          await lock.acquire(state.owner);
          lockHeld = true;
        } else {
          fail("LOCK_BUSY");
        }
      } else {
        await lock.assertOwned(state.owner);
        lockHeld = true;
      }
      if (lockIntent) {
        state = { owner: state.owner, status: "held" };
        await operation.save(state);
      }
    }
    const beforeInventory = await live.capture();
    const beforeIdentity = deploymentIdentity(beforeInventory);
    assertDeploymentMatchesProof(beforeIdentity, proof);
    // From this point onward the durable owner has crossed the admin mutation
    // boundary. If the intent save itself loses its response, retain the lock
    // and require an exact resume rather than releasing a possibly committed
    // operation.
    adminAttempted = true;
    if (state.status === "held") {
      state = { ...state, status: "admin_intent", beforeIdentity };
      await operation.save(state);
    }
    const result = await postAdmin({ session, request, fetchImpl });
    if (!activationResultShape(result, activation)) fail("ADMIN_RESPONSE_INVALID");
    const afterInventory = await live.capture();
    const afterIdentity = deploymentIdentity(afterInventory);
    assertDeploymentStable(beforeIdentity, afterIdentity);
    state = { ...state, status: "release_intent", result };
    await operation.save(state);
    await lock.release(state.owner);
    lockHeld = false;
    state = { ...state, status: "completed" };
    await operation.save(state);
    return result;
  } catch (error) {
    // A pre-POST receipt/deployment mismatch is deterministic and safe to
    // release. Once the route was attempted, preserve the owner and intent so
    // an exact resume can retry the Worker idempotency key under the lock.
    if (!adminAttempted && lockHeld) {
      try { await releaseBeforeMutation(); } catch { /* retain the original refusal */ }
    }
    if (typeof error?.code === "string"
        && error.code.startsWith("TELEMETRY_RUNTIME_RECONCILIATION_")) throw error;
    fail(adminAttempted ? "ACTIVATION_RESULT_UNCERTAIN" : "ACTIVATION_UNAVAILABLE");
  } finally {
    operation.close();
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

export function parseTelemetryRuntimeActivationOperatorArguments(argv) {
  const result = { resume: false };
  const allowed = new Set([
    "--account-id", "--worker-name", "--repository-root", "--operation-directory",
    "--request-file", "--admin-session-file",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--resume") {
      if (result.resume) fail("ARGUMENTS_INVALID");
      result.resume = true;
      continue;
    }
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || value.startsWith("--")
        || Object.hasOwn(result, key)) fail("ARGUMENTS_INVALID");
    result[key] = value;
    index += 1;
  }
  if (!/^[a-f0-9]{32}$/u.test(result["--account-id"] ?? "")
      || !/^[A-Za-z0-9_-]{1,63}$/u.test(result["--worker-name"] ?? "")
      || !isAbsolute(result["--repository-root"] ?? "")
      || !isAbsolute(result["--operation-directory"] ?? "")
      || !isAbsolute(result["--request-file"] ?? "")
      || !isAbsolute(result["--admin-session-file"] ?? "")) {
    fail("ARGUMENTS_INVALID");
  }
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
    const beforeAttestation = deploymentAttestation(beforeIdentity, before.capturedAt);
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
      deploymentAttestation: beforeAttestation,
      primary,
      analytics,
    };
    const proof = Object.freeze({
      ...unsigned,
      proofSha256: identityDigest(unsigned),
    });
    await writePrivateJsonNoClobber(output, proof);
    return proof;
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("TELEMETRY_RUNTIME_RECONCILIATION_")) throw error;
    fail("READ_FAILED");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--mode") {
    if (argv[1] !== "activate") fail("ARGUMENTS_INVALID");
    const args = parseTelemetryRuntimeActivationOperatorArguments(argv.slice(2));
    const request = await readOwnerPrivateJson(args["--request-file"]);
    const session = await readOwnerPrivateJson(args["--admin-session-file"]);
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: args["--account-id"],
      workerName: args["--worker-name"],
      repositoryRoot: args["--repository-root"],
      operationDirectory: args["--operation-directory"],
      request,
      session,
      resume: args.resume,
    });
    process.stdout.write(`${JSON.stringify({ status: "completed", result })}\n`);
    return;
  }
  const args = parseTelemetryRuntimeReconciliationArguments(argv);
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
    deploymentAttestation: proof.deploymentAttestation,
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
