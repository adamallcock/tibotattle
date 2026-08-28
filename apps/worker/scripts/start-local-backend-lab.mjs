import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkLocalWorkspacePackages,
} from "./check-local-workspace-packages.mjs";
import { inspectLocalBackendState } from "./inspect-local-backend-state.mjs";
import {
  backendSmokeSourceArguments,
  localCompanionEnvironment,
  parseLocalBackendLabArguments,
  projectLocalBackendLabReceipt,
} from "./start-local-backend-lab-lib.mjs";

const workerDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(workerDirectory, "..", "..");
const wrangler = resolve(
  workerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const node = process.execPath;
const localCompanionEntry = resolve(
  repositoryRoot,
  "apps",
  "local",
  "server.js",
);

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", () => {
      rejectPromise(
        new Error(`Loopback port ${port} is already in use; choose another --port.`),
      );
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  });
}

function createLabDirectory(value) {
  if (value) {
    const path = resolve(value);
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
  const path = mkdtempSync(join(tmpdir(), "app-usagemonitor-backend-lab."));
  chmodSync(path, 0o700);
  return path;
}

function assertLocalSecrets() {
  const path = resolve(workerDirectory, ".dev.vars");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("apps/worker/.dev.vars must be a real owner-only file");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("apps/worker/.dev.vars must be owner-only");
  }
}

function run(command, args, label, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: workerDirectory,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? "")
      .replace(/um_[A-Za-z0-9._-]+/gu, "[redacted-authority]")
      .trim()
      .slice(-1_000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function startWorker(port, stateDirectory, { visible = false } = {}) {
  const child = spawn(wrangler, [
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--test-scheduled",
    "--persist-to",
    stateDirectory,
    "--var",
    "ENROLLMENT_MODE:invite_only",
    "--var",
    "ENVIRONMENT:local-development",
    "--var",
    "ACCOUNT_SCOPED_INGEST_MODE:disabled",
  ], {
    cwd: workerDirectory,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: visible ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (!visible) {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  return child;
}

function startLocalCompanion(port, centralOrigin, stateRoot) {
  return spawn(node, [localCompanionEntry], {
    cwd: repositoryRoot,
    env: localCompanionEnvironment({
      environment: process.env,
      port,
      centralOrigin,
      stateRoot,
    }),
    stdio: "inherit",
  });
}

function childExited(child) {
  return child?.exitCode !== null || child?.signalCode !== null;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (childExited(child)) throw new Error("The local Worker exited before health");
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok
          && body?.checks?.database === "ok"
          && body?.checks?.deletionLedger === "ok"
          && body?.checks?.encryptedObjectStore === "reachable"
          && body?.enrollmentMode === "invite_only") {
        return body;
      }
    } catch {
      // A bounded retry is expected while Wrangler initializes.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("The local Worker did not become healthy within 30 seconds");
}

async function waitForLocalCompanion(origin, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (childExited(child)) {
      throw new Error("The local companion exited before becoming ready");
    }
    try {
      const response = await fetch(`${origin}/api/local/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok
          && body?.status === "ready"
          && body?.capabilities?.localDashboard === true
          && body?.capabilities?.centralServiceProxy === true
          && body?.capabilities?.centralParticipantRelay === true) {
        return body;
      }
    } catch {
      // A bounded retry is expected while local artifacts initialize.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("The local companion did not become healthy within 30 seconds");
}

async function inspectLocalR2ObjectCount(origin) {
  const response = await fetch(
    `${origin}/cdn-cgi/explorer/api/r2/buckets/`
      + "app-usagemonitor-synthetic-quarantine/objects",
    { signal: AbortSignal.timeout(5_000) },
  );
  const body = await response.json();
  const truncated = body?.result_info?.is_truncated;
  if (!response.ok
      || body?.success !== true
      || !Array.isArray(body?.result)
      || ![false, "false"].includes(truncated)) {
    throw new Error("The local R2 explorer did not return a complete bounded object list");
  }
  return body.result.length;
}

async function stopWorker(child) {
  if (!child || childExited(child)) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (!childExited(child)) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
  }
  if (!childExited(child)) {
    throw new Error("The local Worker did not stop within 10 seconds");
  }
}

async function stopLocalCompanion(child) {
  if (!child || childExited(child)) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (!childExited(child)) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
  }
  if (!childExited(child)) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
  }
  if (!childExited(child)) {
    throw new Error("The local companion did not stop within 15 seconds");
  }
}

function prepareState(stateDirectory, invitationDirectory) {
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(invitationDirectory, { mode: 0o700 });
  run(node, [
    resolve(workerDirectory, "scripts", "migrate-local.mjs"),
    "--persist-to",
    stateDirectory,
  ], "Local D1 migration", { capture: true });

  const invitationFiles = [];
  for (let index = 0; index < 20; index += 1) {
    const invitationFile = join(
      invitationDirectory,
      `participant-${String(index + 1).padStart(2, "0")}.secret`,
    );
    run(node, [
      resolve(workerDirectory, "scripts", "issue-enrollment-grant.mjs"),
      "--persist-to",
      stateDirectory,
      "--output-file",
      invitationFile,
    ], "Local invitation issuance", { capture: true });
    invitationFiles.push(invitationFile);
  }
  return invitationFiles;
}

function assertDeletedLifecycle(storage, r2ObjectCount) {
  const database = storage.database;
  if (database.activeParticipants !== 0
      || database.deletingParticipants !== 0
      || database.acceptedContributions !== 0
      || database.canonicalRecords !== 0
      || database.contributionOccurrences !== 0
      || database.retainedQuarantineReferences !== 0
      || database.activeSessions !== 0
      || database.activeDevices !== 0
      || database.suppressedSnapshots < 1
      || database.withdrawnSnapshots < 1
      || storage.deletionLedger.tombstones !== 20
      || r2ObjectCount !== 0) {
    throw new Error("The destructive lifecycle left unexpected D1 or R2 state");
  }
}

async function probePersistedParticipant(origin, participantAccessFile) {
  const access = JSON.parse(readFileSync(participantAccessFile, "utf8"));
  if (access?.origin !== origin
      || access?.schemaVersion !== "local-backend-lab-access-v0.2"
      || typeof access?.sessionCookie !== "string"
      || !access.sessionCookie.startsWith("__Host-usage_monitor_session=")
      || typeof access?.csrfToken !== "string") {
    throw new Error("The retained participant access file was invalid");
  }
  const exportResponse = await fetch(`${origin}/api/v1/me/export`, {
    headers: {
      Accept: "application/json",
      Cookie: access.sessionCookie,
    },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const participantExport = await exportResponse.json();
  const records = participantExport?.contributions?.[0]?.records;
  if (!exportResponse.ok
      || participantExport?.schemaVersion !== "participant-export-v0.2"
      || participantExport?.contributions?.length !== 1
      || !Array.isArray(records)
      || records.length < 1) {
    throw new Error("The participant export did not survive restart");
  }
  return {
    participantSessionRestored: true,
    participantExportRestored: true,
    contributions: participantExport.contributions.length,
    records: records.length,
    sessionCapabilityStoredOwnerOnly: true,
  };
}

await checkLocalWorkspacePackages();
const options = parseLocalBackendLabArguments(process.argv.slice(2));
const port = options.port;
const companionPort = options.companionPort;
const exitAfterReceipt = options.exitAfterReceipt;
const smokeSourceArguments = backendSmokeSourceArguments(options.source);
await assertPortAvailable(port);
if (options.startCompanion) await assertPortAvailable(companionPort);
const labDirectory = createLabDirectory(options.stateDirectory);
const stateDirectory = join(labDirectory, "state");
const companionStateDirectory = join(labDirectory, "companion-state");
const invitationDirectory = join(labDirectory, "redeemed-invitations");
const lifecycleStateDirectory = join(labDirectory, "lifecycle-state");
const lifecycleInvitationDirectory = join(
  labDirectory,
  "lifecycle-redeemed-invitations",
);
const participantAccessFile = join(labDirectory, "participant-access.json");
const receiptFile = join(labDirectory, "lab-receipt.json");
assertLocalSecrets();
mkdirSync(companionStateDirectory, { mode: 0o700 });
const lifecycleInvitationFiles = prepareState(
  lifecycleStateDirectory,
  lifecycleInvitationDirectory,
);
const invitationFiles = prepareState(stateDirectory, invitationDirectory);

const origin = `http://127.0.0.1:${port}`;
const companionOrigin = options.startCompanion
  ? `http://127.0.0.1:${companionPort}`
  : null;
let worker = startWorker(port, lifecycleStateDirectory);
let companion = null;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  await stopLocalCompanion(companion);
  await stopWorker(worker);
  const stopped = options.source.mode === "prepared_contribution"
    ? {
        status: "stopped",
        signal,
        dataDeleted: false,
        privateWorkspaceRetained: true,
      }
    : {
        status: "stopped",
        signal,
        stateDirectory: labDirectory,
        dataDeleted: false,
      };
  process.stdout.write(`${JSON.stringify(stopped)}\n`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await waitForHealth(origin, worker);
  const lifecycleSmokeOutput = run(node, [
    resolve(workerDirectory, "scripts", "smoke-http-backend.mjs"),
    "--origin",
    origin,
    ...smokeSourceArguments,
    ...lifecycleInvitationFiles.flatMap((path) => ["--invite-file", path]),
  ], "Destructive lifecycle HTTP acceptance", { capture: true });
  const lifecycleSmoke = JSON.parse(lifecycleSmokeOutput);
  const lifecycleR2ObjectCount = await inspectLocalR2ObjectCount(origin);
  await stopWorker(worker);
  const lifecycleStorage = inspectLocalBackendState({
    persistTo: lifecycleStateDirectory,
    workerDirectory,
  });
  assertDeletedLifecycle(lifecycleStorage, lifecycleR2ObjectCount);

  worker = startWorker(port, stateDirectory);
  await waitForHealth(origin, worker);
  const smokeOutput = run(node, [
    resolve(workerDirectory, "scripts", "smoke-http-backend.mjs"),
    "--origin",
    origin,
    ...smokeSourceArguments,
    "--retain-inspection-state",
    "--participant-access-file",
    participantAccessFile,
    ...invitationFiles.flatMap((path) => ["--invite-file", path]),
  ], "Inspectable HTTP seed", { capture: true });
  const smoke = JSON.parse(smokeOutput);
  const r2ObjectCount = await inspectLocalR2ObjectCount(origin);
  await stopWorker(worker);
  const storage = inspectLocalBackendState({
    persistTo: stateDirectory,
    workerDirectory,
  });
  if (r2ObjectCount !== storage.database.retainedQuarantineReferences) {
    throw new Error(
      "The retained R2 object count did not match canonical retention state",
    );
  }
  worker = startWorker(port, stateDirectory, { visible: !exitAfterReceipt });
  const health = await waitForHealth(origin, worker);
  const restartedR2ObjectCount = await inspectLocalR2ObjectCount(origin);
  if (restartedR2ObjectCount !== r2ObjectCount) {
    throw new Error("The retained R2 object count changed across restart");
  }
  const persistedRestart = await probePersistedParticipant(
    origin,
    participantAccessFile,
  );
  if (options.startCompanion) {
    companion = startLocalCompanion(
      companionPort,
      origin,
      companionStateDirectory,
    );
    await waitForLocalCompanion(companionOrigin, companion);
  }
  const receipt = projectLocalBackendLabReceipt({
    receipt: {
      schemaVersion: "local-backend-lab-receipt-v0.3",
      status: "ready",
      createdAt: new Date().toISOString(),
      origin,
      backendOrigin: origin,
      portalUrl: companionOrigin === null ? null : `${companionOrigin}/`,
      localCompanion: companionOrigin === null
        ? {
            status: "not_started",
            reason: exitAfterReceipt ? "exit_after_receipt" : "backend_only",
          }
        : {
            status: "ready",
            origin: companionOrigin,
            realLocalDataApi: true,
            centralBackendRelay: true,
          },
      smoke: {
        participants: smoke.participants,
        acceptedRecordsPerParticipant: smoke.acceptedRecordsPerParticipant,
        idempotentReplay: smoke.idempotentReplay,
        uploadScopeConflictRejected: smoke.uploadScopeConflictRejected,
        privacyCanaryRejected: smoke.privacyCanaryRejected,
        invalidSchemaRejected: smoke.invalidSchemaRejected,
        oversizedRequestRejected: smoke.oversizedRequestRejected,
        overCountRejected: smoke.overCountRejected,
        outOfRangeTimestampRejected: smoke.outOfRangeTimestampRejected,
        serverValidation: smoke.serverValidation,
        canonicalServerRepricing: smoke.canonicalServerRepricing,
        atomicEnrollmentPairing: smoke.devicePairingAndUpload,
        deviceRevocation: smoke.deviceRevocation,
        communityDailyVerified: smoke.communityDailyVerified,
        participantExportVerified: smoke.participantExportVerified,
      },
      destructiveLifecycle: {
        fullParticipantDeletion:
          lifecycleSmoke.participantsDeleted === lifecycleSmoke.participants,
        d1: lifecycleStorage.database,
        deletionLedger: lifecycleStorage.deletionLedger,
        directLocalR2ObjectCount: lifecycleR2ObjectCount,
      },
      persistedRestart: {
        workerRestartedAgainstSameStateDirectory: true,
        r2ObjectCountBeforeRestart: r2ObjectCount,
        r2ObjectCountAfterRestart: restartedR2ObjectCount,
        ...persistedRestart,
      },
      storage: storage.database,
      encryptedQuarantine: {
        directLocalR2ObjectCount: r2ObjectCount,
        canonicalRetainedReferenceCount:
          storage.database.retainedQuarantineReferences,
        lifecycleMayDeleteAcceptedObjectsBeforeInspection: true,
        explorerResponseIncludedObjectKeys: false,
      },
      deletionLedger: storage.deletionLedger,
      health: {
        database: health.checks.database,
        deletionLedger: health.checks.deletionLedger,
        encryptedQuarantine: health.checks.encryptedObjectStore,
        enrollmentMode: health.enrollmentMode,
      },
      acceptance: {
        safeFileAcceptance: true,
        forbiddenContentRejected: smoke.privacyCanaryRejected,
        invalidSchemaRejected: smoke.invalidSchemaRejected,
        oversizedRequestRejected: smoke.oversizedRequestRejected,
        overCountRejected: smoke.overCountRejected,
        outOfRangeTimestampRejected: smoke.outOfRangeTimestampRejected,
        idempotentDeduplication: smoke.idempotentReplay,
        conflictSafeCanonicalState: smoke.uploadScopeConflictRejected,
        canonicalServerRepricing: smoke.canonicalServerRepricing,
        atomicEnrollmentPairingVerified: smoke.devicePairingAndUpload,
        deviceRevocationVerified: smoke.deviceRevocation,
        d1LifecycleVerified: true,
        r2LifecycleVerified: lifecycleR2ObjectCount === 0
          && restartedR2ObjectCount === r2ObjectCount,
        communityDailyVerified: smoke.communityDailyVerified,
        participantExportVerified: smoke.participantExportVerified,
        fullParticipantDeletionVerified:
          lifecycleSmoke.participantsDeleted === lifecycleSmoke.participants,
        persistedRestartVerified:
          persistedRestart.participantSessionRestored
          && persistedRestart.participantExportRestored,
      },
    },
    sourceMode: options.source.mode,
    locations: {
      stateDirectory: labDirectory,
      participantAccessFile,
      redeemedInvitationDirectory: invitationDirectory,
      redeemedInvitationFilesRetained: invitationFiles.length,
    },
  });
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const publicOutput = options.source.mode === "prepared_contribution"
    ? receipt
    : {
        ...receipt,
        receiptFile,
        note: "The session capability is only in the owner-only participant access file.",
  };
  process.stdout.write(`${JSON.stringify(publicOutput, null, 2)}\n`);
  if (exitAfterReceipt) {
    await stopWorker(worker);
  } else {
    worker.once("exit", () => {
      if (!stopping) void shutdown("backend_exit");
    });
    if (childExited(worker) && !stopping) void shutdown("backend_exit");
  }
} catch (error) {
  await stopLocalCompanion(companion);
  await stopWorker(worker);
  process.stderr.write("The inspectable backend laboratory failed at a bounded setup or verification step.\n");
  const detail = error instanceof Error
    ? error.message
      .replace(/um_[A-Za-z0-9._-]+/gu, "[redacted-authority]")
      .slice(0, 1_000)
    : "unknown failure";
  process.stderr.write(`${detail}\n`);
  process.stderr.write(`State retained for inspection: ${labDirectory}\n`);
  process.exitCode = 1;
}
