import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectLocalBackendState } from "./inspect-local-backend-state.mjs";

const workerDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wrangler = resolve(
  workerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const node = process.execPath;

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function boundedPort(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("--port requires an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--port must be between 1024 and 65535");
  }
  return port;
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
    env: process.env,
    stdio: visible ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (!visible) {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  return child;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The local Worker exited before health");
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
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
}

const args = process.argv.slice(2);
const allowed = new Set(["--port", "--state-directory"]);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`);
  index += 1;
  if (!args[index] || args[index].startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
}

const port = boundedPort(optionValue(args, "--port", "8792"));
const labDirectory = createLabDirectory(optionValue(args, "--state-directory"));
const stateDirectory = join(labDirectory, "state");
const invitationDirectory = join(labDirectory, "redeemed-invitations");
const participantAccessFile = join(labDirectory, "participant-access.json");
const receiptFile = join(labDirectory, "lab-receipt.json");
mkdirSync(stateDirectory, { mode: 0o700 });
mkdirSync(invitationDirectory, { mode: 0o700 });
assertLocalSecrets();

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

const origin = `http://127.0.0.1:${port}`;
let worker = startWorker(port, stateDirectory);
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  await stopWorker(worker);
  process.stdout.write(`${JSON.stringify({
    status: "stopped",
    signal,
    stateDirectory: labDirectory,
    dataDeleted: false,
  })}\n`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await waitForHealth(origin, worker);
  const smokeOutput = run(node, [
    resolve(workerDirectory, "scripts", "smoke-http-backend.mjs"),
    "--origin",
    origin,
    "--generated-content-free-fixture",
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
  worker = startWorker(port, stateDirectory, { visible: true });
  const health = await waitForHealth(origin, worker);
  const receipt = {
    schemaVersion: "local-backend-lab-receipt-v0.1",
    status: "ready",
    createdAt: new Date().toISOString(),
    origin,
    portalUrl: `${origin}/`,
    stateDirectory: labDirectory,
    participantAccessFile,
    participantAccessFileContainsSecret: true,
    redeemedInvitationDirectory: invitationDirectory,
    redeemedInvitationFilesRetained: invitationFiles.length,
    smoke: {
      participants: smoke.participants,
      acceptedRecordsPerParticipant: smoke.acceptedRecordsPerParticipant,
      idempotentReplay: smoke.idempotentReplay,
      privacyCanaryRejected: smoke.privacyCanaryRejected,
      serverValidation: smoke.serverValidation,
      personalStatisticsRecomputed: smoke.personalStatisticsRecomputed,
      aggregatePublishedAtTwenty: smoke.aggregatePublishedAtTwenty,
      authenticatedWeeklyComparison: smoke.authenticatedWeeklyComparison,
      participantExportVerified: smoke.participantExportVerified,
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
    cleanup: {
      automaticOnShutdown: false,
      instruction:
        "Stop the lab, inspect the exact stateDirectory, then move that directory to Trash.",
    },
  };
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    portalUrl: receipt.portalUrl,
    stateDirectory: labDirectory,
    participantAccessFile,
    receiptFile,
    participants: receipt.smoke.participants,
    acceptedContributions: receipt.storage.acceptedContributions,
    canonicalRecords: receipt.storage.canonicalRecords,
    publishedSnapshots: receipt.storage.publishedSnapshots,
    encryptedQuarantineObjects: receipt.encryptedQuarantine.directLocalR2ObjectCount,
    privacyCanaryRejected: receipt.smoke.privacyCanaryRejected,
    note: "The recovery code is only in the owner-only participant access file.",
  }, null, 2)}\n`);
} catch (error) {
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
