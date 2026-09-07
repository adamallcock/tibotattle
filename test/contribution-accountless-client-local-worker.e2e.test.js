import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAccountlessContributionSyncOnce } from "../src/contribution-accountless-client.js";
import { withContributionDeviceSecret } from "../src/contribution-device-capability.js";
import {
  ATTRIBUTION_FIXTURE_DEVICE_ID,
  writeAttributionFixture,
} from "./helpers/local-attribution-fixture.js";
import { createAttributionFixtureDevice } from "./helpers/attribution-transport-fixture.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerDirectory = resolve(repositoryRoot, "apps", "worker");
const node = process.execPath;
const wrangler = resolve(
  workerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

function runBounded(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: workerDirectory,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    killSignal: "SIGTERM",
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`${label} failed`);
  }
  return result.stdout;
}

function enableSyntheticV11Cutover(stateDirectory) {
  // The migrated schema intentionally starts v1.1 staged. This explicit
  // cutover is confined to the disposable local D1 used by this proof; it is
  // not a migration edit or authority shortcut, and the real Worker still
  // enforces the accountless owner and authorization rows below.
  runBounded(wrangler, [
    "d1",
    "execute",
    "USAGE_MONITOR_DB",
    "--local",
    "--persist-to",
    stateDirectory,
    "--command",
    "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1';",
    "--json",
  ], "local synthetic v1.1 cutover");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  if (!Number.isSafeInteger(port) || port < 1024) {
    throw new Error("Could not allocate a loopback port for the local Worker");
  }
  return port;
}

function childExited(child) {
  return child?.exitCode !== null || child?.signalCode !== null;
}

function workerGroupAlive(child) {
  if (process.platform === "win32" || !Number.isSafeInteger(child?.pid) || child.pid < 1) {
    return !childExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalWorker(child, signal) {
  if (process.platform !== "win32" && Number.isSafeInteger(child?.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try { child.kill(signal); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function startWorker({ port, stateDirectory, ownerFixture }) {
  return spawn(wrangler, [
    "dev",
    "--local",
    "--env",
    "",
    "--config",
    ownerFixture.configFile,
    "--env-file",
    ownerFixture.varsFile,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--test-scheduled",
    "--persist-to",
    stateDirectory,
    "--var",
    "ENROLLMENT_MODE:local_open",
    "--var",
    "ENVIRONMENT:local-development",
    "--var",
    "ACCOUNT_SCOPED_INGEST_MODE:disabled",
    "--var",
    "ACCOUNTLESS_ENROLLMENT_MODE:enabled",
    "--var",
    "ACCOUNTLESS_OWNERSHIP_MODE:enabled",
  ], {
    cwd: workerDirectory,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (childExited(child)) throw new Error("The local Worker exited before health");
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1_000),
        redirect: "error",
      });
      const body = await response.json();
      if (response.ok
          && body?.checks?.database === "ok"
          && body?.checks?.encryptedObjectStore === "reachable") {
        return body;
      }
    } catch {
      // Wrangler needs a bounded startup window before the first health read.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("The local Worker did not become healthy within 30 seconds");
}

async function stopWorker(child) {
  if (!child) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  if (!childExited(child)) signalWorker(child, "SIGINT");
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (!childExited(child) || workerGroupAlive(child)) signalWorker(child, "SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (!childExited(child) || workerGroupAlive(child)) signalWorker(child, "SIGKILL");
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (!childExited(child) || workerGroupAlive(child)) {
    throw new Error("The local Worker process group did not stop within 15 seconds");
  }
}

function d1Rows(stateDirectory, sql) {
  const stdout = runBounded(wrangler, [
    "d1",
    "execute",
    "USAGE_MONITOR_DB",
    "--local",
    "--persist-to",
    stateDirectory,
    "--command",
    sql,
    "--json",
  ], "bounded local D1 query");
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("The local D1 count receipt was invalid");
  }
  const rows = payload?.[0]?.results;
  if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== "object")) {
    throw new Error("The local D1 count receipt had no bounded rows");
  }
  return rows;
}

function accountlessCounts(stateDirectory) {
  const rows = d1Rows(stateDirectory, `
    SELECT
      (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS enrollments,
      (SELECT COUNT(*) FROM accountless_enrollment_ledger WHERE state = 'active') AS active_enrollments,
      (SELECT COUNT(*) FROM accountless_upload_owners) AS upload_owners,
      (SELECT COUNT(*) FROM accountless_upload_owners WHERE state = 'active') AS active_upload_owners,
      (SELECT COUNT(*) FROM accountless_v11_device_authorizations) AS v11_authorizations,
      (SELECT COUNT(*) FROM accountless_v11_device_authorizations WHERE state = 'active') AS active_v11_authorizations,
      (SELECT COUNT(*) FROM participants WHERE owner_kind = 'accountless') AS accountless_participants,
      (SELECT COUNT(*) FROM device_credentials WHERE authority_kind = 'accountless') AS accountless_devices,
      (SELECT COUNT(*) FROM device_credentials WHERE authority_kind = 'accountless' AND state = 'active') AS active_accountless_devices,
      (SELECT COUNT(*) FROM telemetry_v11_chunks) AS v11_chunks,
      (SELECT COUNT(*) FROM telemetry_v11_chunks WHERE length(r2_key) > 0) AS encrypted_v11_objects,
      (SELECT COUNT(*) FROM telemetry_v11_records) AS v11_records,
      (SELECT COUNT(*) FROM telemetry_v11_records WHERE stream = 'usage') AS usage_records,
      (SELECT COUNT(*) FROM telemetry_v11_records WHERE stream = 'quota') AS quota_records,
      (SELECT COUNT(*) FROM telemetry_v11_records WHERE stream = 'session') AS session_records,
      (SELECT COUNT(*) FROM telemetry_contributions) AS contributions,
      (SELECT COUNT(*) FROM telemetry_contributions WHERE status = 'accepted') AS accepted_contributions,
      (SELECT COUNT(*) FROM device_upload_authorizations) AS upload_authorizations
  `);
  if (rows.length !== 1) throw new Error("Expected one local D1 count row");
  return rows[0];
}

async function writePreference(file, origin, enabled) {
  await writeFile(file, `${JSON.stringify({
    available: true,
    current: enabled,
    destinationOrigin: origin,
    enabled,
    policyVersion: "accountless-opt-out-v1",
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

const runLocalWorkerE2E = process.env.TIBOTATTLE_RUN_LOCAL_WORKER_E2E === "1";

test("accountless client reaches a migrated local Worker and fences retry, disconnect, and opt-out", {
  timeout: 180_000,
  skip: runLocalWorkerE2E ? false : "set TIBOTATTLE_RUN_LOCAL_WORKER_E2E=1 to run the disposable loopback Worker proof",
}, async () => {
  const { createLocalOwnerFixture } = await import("../apps/worker/scripts/local-owner-fixture.mjs");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-accountless-client-e2e-"));
  const stateDirectory = join(root, "worker-state");
  const ownerDirectory = join(root, "owner-fixture");
  const indexFile = join(root, "index.sqlite");
  const stateFile = join(root, "device-binding.json");
  const preferenceFile = join(root, "accountless-preference.json");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let worker = null;

  try {
    runBounded(node, [
      resolve(workerDirectory, "scripts", "migrate-local.mjs"),
      "--persist-to",
      stateDirectory,
    ], "local Worker migration");
    enableSyntheticV11Cutover(stateDirectory);
    const ownerFixture = createLocalOwnerFixture({
      origin,
      persistTo: stateDirectory,
      directory: ownerDirectory,
      workerDirectory,
    });
    await writeAttributionFixture(indexFile, {
      plans: ["pro", "plus"],
      observedAtMs: Date.now(),
    });
    const backend = await createAttributionFixtureDevice(stateFile, origin);
    await writePreference(preferenceFile, origin, true);
    const readPreference = async () => JSON.parse(await readFile(preferenceFile, "utf8"));
    const requests = [];
    const fetchImpl = async (url, request = {}) => {
      const response = await fetch(url, request);
      const receipt = {
        method: request.method ?? "GET",
        path: new URL(url).pathname,
        status: response.status,
      };
      if (receipt.path === "/api/v1/device/sync-capabilities" || !response.ok) {
        const body = await response.clone().json();
        if (!response.ok) receipt.errorCode = body?.error?.code;
        if (receipt.path !== "/api/v1/device/sync-capabilities") {
          requests.push(receipt);
          return response;
        }
        receipt.capabilities = {
          authorityKind: body.authorityKind,
          authorizationCurrent: body.authorizationCurrent,
          consentCurrent: body.consentCurrent,
          minimumWriteRank: body.minimumWriteRank,
          v11Lifecycle: body.formats?.find(({ schemaVersion }) => schemaVersion === "telemetry-contribution-v1.1")?.lifecycle,
        };
      }
      requests.push(receipt);
      return response;
    };
    const run = () => runAccountlessContributionSyncOnce({
      laboratory: true,
      origin,
      readPreference,
      backend,
      stateFile,
      indexFile,
      fetchImpl,
      maximumChunks: 20,
      maximumDurationMilliseconds: 60_000,
      requestTimeoutMilliseconds: 10_000,
    });

    worker = startWorker({ port, stateDirectory, ownerFixture });
    await waitForHealth(origin, worker);

    const first = await run();
    assert.equal(first.status, "complete", JSON.stringify({ failure: first.failure, requests }));
    assert.equal(first.failure, null);
    assert.equal(first.daysSynced, first.daysTotal);
    assert.ok(first.daysTotal >= 1);
    assert.ok(first.recordsUploaded >= 5);
    assert.equal(requests.filter(({ path }) => path === "/api/v1/accountless/enrollment").length, 1);
    assert.equal(requests.find(({ path }) => path === "/api/v1/accountless/enrollment")?.status, 201);
    assert.equal(requests.find(({ path }) => path === "/api/v1/accountless/ownership")?.status, 201);
    assert.ok(requests.filter(({ path }) => path === "/api/v1/device/sync-capabilities").length >= 2);
    assert.deepEqual(
      requests.find(({ path }) => path === "/api/v1/device/sync-capabilities")?.capabilities,
      {
        authorityKind: "accountless",
        authorizationCurrent: true,
        consentCurrent: false,
        minimumWriteRank: 11,
        v11Lifecycle: "accepted",
      },
    );
    assert.ok(requests.some(({ path }) => path === "/api/v1/contributions"));

    await stopWorker(worker);
    worker = null;
    const afterFirst = accountlessCounts(stateDirectory);
    assert.equal(afterFirst.enrollments, 1);
    assert.equal(afterFirst.active_enrollments, 1);
    assert.equal(afterFirst.upload_owners, 1);
    assert.equal(afterFirst.active_upload_owners, 1);
    assert.equal(afterFirst.v11_authorizations, 1);
    assert.equal(afterFirst.active_v11_authorizations, 1);
    assert.equal(afterFirst.accountless_participants, 1);
    assert.equal(afterFirst.accountless_devices, 1);
    assert.equal(afterFirst.active_accountless_devices, 1);
    assert.equal(afterFirst.v11_chunks, 3);
    assert.equal(afterFirst.encrypted_v11_objects, 3);
    assert.equal(afterFirst.v11_records, 5);
    assert.equal(afterFirst.usage_records, 2);
    assert.equal(afterFirst.quota_records, 2);
    assert.equal(afterFirst.session_records, 1);
    assert.equal(afterFirst.upload_authorizations, 3);

    worker = startWorker({ port, stateDirectory, ownerFixture });
    await waitForHealth(origin, worker);
    requests.length = 0;
    const retry = await run();
    assert.equal(retry.status, "complete");
    assert.equal(retry.failure, null);
    assert.equal(retry.recordsUploaded, 0);
    assert.ok(retry.chunksSkipped >= 3);
    assert.equal(requests.find(({ path }) => path === "/api/v1/accountless/enrollment")?.status, 200);
    assert.equal(requests.find(({ path }) => path === "/api/v1/accountless/ownership")?.status, 200);
    assert.equal(requests.some(({ path }) => path === "/api/v1/contributions"), false);

    await stopWorker(worker);
    worker = null;
    const afterRetry = accountlessCounts(stateDirectory);
    for (const key of [
      "enrollments", "upload_owners", "v11_authorizations", "accountless_participants",
      "accountless_devices", "v11_chunks", "encrypted_v11_objects", "v11_records", "usage_records", "quota_records",
      "session_records", "contributions", "accepted_contributions", "upload_authorizations",
    ]) assert.equal(afterRetry[key], afterFirst[key], `retry changed ${key}`);

    worker = startWorker({ port, stateDirectory, ownerFixture });
    await waitForHealth(origin, worker);
    await withContributionDeviceSecret({
      backend,
      stateFile,
      expectedOrigin: origin,
      operation: async (secret, device) => {
        const response = await fetch(`${origin}/api/v1/device/disconnect`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
          },
          credentials: "omit",
          redirect: "error",
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body, {
          schemaVersion: "device-disconnect-v0.1",
          disconnected: true,
          deviceId: ATTRIBUTION_FIXTURE_DEVICE_ID,
        });
        return { disconnected: true };
      },
    });

    requests.length = 0;
    const stale = await run();
    assert.equal(stale.status, "failed");
    assert.deepEqual(stale.failure, {
      code: "device_unavailable",
      retryable: false,
      deviceUnavailable: true,
      retryAfterMilliseconds: null,
    });
    assert.deepEqual(requests.map(({ path }) => path), ["/api/v1/accountless/enrollment"]);

    await stopWorker(worker);
    worker = null;
    const afterDisconnect = accountlessCounts(stateDirectory);
    assert.equal(afterDisconnect.active_enrollments, 0);
    assert.equal(afterDisconnect.active_upload_owners, 0);
    assert.equal(afterDisconnect.active_v11_authorizations, 0);
    assert.equal(afterDisconnect.active_accountless_devices, 0);
    assert.equal(afterDisconnect.enrollments, afterFirst.enrollments);
    assert.equal(afterDisconnect.v11_records, afterFirst.v11_records);

    await withContributionDeviceSecret({
      backend,
      stateFile,
      expectedOrigin: origin,
      operation: async (secret) => {
        const deleted = await backend.deleteExact({}, secret);
        assert.equal(deleted, "deleted");
        return { deleted: true };
      },
    });
    await writePreference(preferenceFile, origin, false);
    requests.length = 0;
    const optedOut = await run();
    assert.equal(optedOut.status, "failed");
    assert.deepEqual(optedOut.failure, {
      code: "preference_ineligible",
      retryable: false,
      deviceUnavailable: false,
      retryAfterMilliseconds: null,
    });
    assert.deepEqual(requests, []);
    assert.equal((await readPreference()).enabled, false);
  } finally {
    await stopWorker(worker);
    await rm(root, { recursive: true, force: true });
  }
});
