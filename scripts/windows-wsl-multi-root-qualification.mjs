#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalCollectorRefreshRunner } from "../src/local-companion-refresh.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { openLocalUnifiedIndex } from "../src/local-unified-index.js";

const DISTRIBUTION = "Ubuntu-24.04";
const CONTRACT_VERSION = "usage-event-v0.2";
const COMMAND_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 45_000;
const REFRESH_ABORT_GRACE_MS = 5_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 64 * 1024;
const TEMPORARY_CLEANUP_UNSAFE = Symbol("temporary-cleanup-unsafe");

export const FIXED_WSL_QUALIFICATION_STATUS = Object.freeze({
  passed: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_PASSED",
  flagRequired: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_FLAG_REQUIRED",
  nativeWindowsRequired: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_NATIVE_WINDOWS_REQUIRED",
  architectureRequired: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_X64_REQUIRED",
  hostedEnvironmentRequired: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_HOSTED_ENVIRONMENT_REQUIRED",
  revisionInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_REVISION_INVALID",
  temporaryRootInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_TEMP_ROOT_INVALID",
  commandFailed: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_COMMAND_FAILED",
  commandTimedOut: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_COMMAND_TIMED_OUT",
  commandOutputExceeded: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_COMMAND_OUTPUT_EXCEEDED",
  distroUnavailable: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_DISTRO_UNAVAILABLE",
  distroVersionInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_WSL2_REQUIRED",
  distroStateInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_DISTRO_STATE_INVALID",
  refreshTimedOut: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_REFRESH_TIMED_OUT",
  cleanupFailed: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_TEMP_CLEANUP_FAILED",
  phaseInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_PHASE_INVALID",
  publicReceiptInvalid: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_PUBLIC_RECEIPT_INVALID",
  ownerRebound: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_OWNER_REBOUND",
  unexpected: "WINDOWS_WSL_MULTI_ROOT_QUALIFICATION_FAILED",
});

class WslQualificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "WslQualificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new WslQualificationError(code);
}

export function validateWslQualificationEnvironment({
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
} = {}) {
  if (environment.USAGE_MONITOR_WSL_QUALIFICATION !== "1") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.flagRequired);
  }
  if (platform !== "win32") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.nativeWindowsRequired);
  }
  if (architecture !== "x64") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.architectureRequired);
  }
  if (environment.GITHUB_ACTIONS !== "true"
      || environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.hostedEnvironmentRequired);
  }
  const revision = environment.TIBOTATTLE_WSL_QUALIFICATION_REVISION;
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.revisionInvalid);
  }
  const temporaryRoot = environment.RUNNER_TEMP;
  if (typeof temporaryRoot !== "string" || temporaryRoot.length < 1
      || !isAbsolute(temporaryRoot)) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.temporaryRootInvalid);
  }
  return Object.freeze({ revision, temporaryRoot: resolve(temporaryRoot) });
}

export function wslCodexHome(distribution = DISTRIBUTION) {
  if (distribution !== DISTRIBUTION) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.distroUnavailable);
  }
  // Deliberately use the legacy \\wsl$ share for the stopped-distribution
  // canary. \\wsl.localhost may activate a distribution on Windows 11 and
  // therefore cannot establish the product's no-auto-start requirement.
  return `\\\\wsl$\\${distribution}\\root\\.codex`;
}

function normalizeWslOutput(value) {
  return String(value ?? "")
    .replaceAll("\0", "")
    .replaceAll("\uFEFF", "")
    .replaceAll("\r", "")
    .replace(/^\s*\*\s*/gmu, "")
    .trim();
}

export function parseRunningWslDistributions(value) {
  const normalized = normalizeWslOutput(value);
  if (normalized.length === 0) return [];
  return normalized.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseWslVerboseDistribution(value, distribution = DISTRIBUTION) {
  const normalized = normalizeWslOutput(value);
  for (const line of normalized.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== distribution) continue;
    const version = Number(fields.at(-1));
    const state = fields.length >= 3 ? fields.at(-2) : null;
    return Object.freeze({ state, version });
  }
  return null;
}

export function fixedQualificationErrorCode(error) {
  const allowed = new Set(Object.values(FIXED_WSL_QUALIFICATION_STATUS));
  return allowed.has(error?.code)
    ? error.code
    : FIXED_WSL_QUALIFICATION_STATUS.unexpected;
}

export async function runBoundedCommand(command, args, {
  timeoutMs = COMMAND_TIMEOUT_MS,
  maximumOutputBytes = MAXIMUM_COMMAND_OUTPUT_BYTES,
  spawnProcess = spawn,
} = {}) {
  if (typeof command !== "string" || command.length < 1
      || !Array.isArray(args)
      || args.some((arg) => typeof arg !== "string")
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(maximumOutputBytes)
      || maximumOutputBytes < 1 || maximumOutputBytes > 1024 * 1024) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.commandFailed);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let outputBytes = 0;
    let timeout = null;
    const stdout = [];
    const stderr = [];
    let child;
    try {
      child = spawnProcess(command, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectPromise(new WslQualificationError(
        FIXED_WSL_QUALIFICATION_STATUS.commandFailed,
      ));
      return;
    }
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      callback(value);
    };
    const capture = (chunks) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        settle(
          rejectPromise,
          new WslQualificationError(
            FIXED_WSL_QUALIFICATION_STATUS.commandOutputExceeded,
          ),
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));
    child.once("error", () => settle(
      rejectPromise,
      new WslQualificationError(FIXED_WSL_QUALIFICATION_STATUS.commandFailed),
    ));
    child.once("close", (code) => {
      if (code !== 0) {
        settle(
          rejectPromise,
          new WslQualificationError(FIXED_WSL_QUALIFICATION_STATUS.commandFailed),
        );
        return;
      }
      settle(resolvePromise, Object.freeze({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      settle(
        rejectPromise,
        new WslQualificationError(FIXED_WSL_QUALIFICATION_STATUS.commandTimedOut),
      );
    }, timeoutMs);
    timeout.unref?.();
  });
}

export async function runWithAbortTimeout(operation, {
  timeoutMs = REFRESH_TIMEOUT_MS,
  abortGraceMs = REFRESH_ABORT_GRACE_MS,
} = {}) {
  if (typeof operation !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(abortGraceMs)
      || abortGraceMs < 1 || abortGraceMs > 10_000) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  const controller = new AbortController();
  const observed = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value) => Object.freeze({ kind: "fulfilled", value }),
      (error) => Object.freeze({ kind: "rejected", error }),
    );
  const timeoutMarker = Object.freeze({ kind: "timeout" });
  let timeout = null;
  const expired = new Promise((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise(timeoutMarker), timeoutMs);
  });
  const first = await Promise.race([observed, expired]);
  if (timeout !== null) clearTimeout(timeout);
  if (first.kind === "fulfilled") return first.value;
  if (first.kind === "rejected") throw first.error;

  // The deadline is authoritative, but cleanup must not race a cooperative
  // refresh that is still closing SQLite/filesystem handles. Abort first,
  // then consume the in-flight settlement for a separately bounded grace.
  controller.abort();
  let graceTimeout = null;
  const graceExpired = new Promise((resolvePromise) => {
    graceTimeout = setTimeout(
      () => resolvePromise(Object.freeze({ kind: "grace_expired" })),
      abortGraceMs,
    );
  });
  const afterAbort = await Promise.race([observed, graceExpired]);
  if (graceTimeout !== null) clearTimeout(graceTimeout);
  const timeoutError = new WslQualificationError(
    FIXED_WSL_QUALIFICATION_STATUS.refreshTimedOut,
  );
  if (afterAbort.kind === "grace_expired") {
    // A non-cooperative refresh may still own SQLite or source handles. The
    // runner is disposable; preserve its temp tree instead of racing removal.
    timeoutError[TEMPORARY_CLEANUP_UNSAFE] = true;
  }
  throw timeoutError;
}

export async function runWithTemporaryCleanup(operation, cleanup) {
  if (typeof operation !== "function" || typeof cleanup !== "function") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  let result;
  let primaryError = null;
  try {
    result = await operation();
  } catch (error) {
    primaryError = error;
  }
  if (primaryError?.[TEMPORARY_CLEANUP_UNSAFE] !== true) {
    try {
      await cleanup();
    } catch {
      if (primaryError === null) {
        fail(FIXED_WSL_QUALIFICATION_STATUS.cleanupFailed);
      }
    }
  }
  if (primaryError !== null) throw primaryError;
  return result;
}

async function runningDistributions(runCommand) {
  const result = await runCommand("wsl.exe", ["--list", "--running", "--quiet"]);
  return parseRunningWslDistributions(result.stdout);
}

async function waitForDistroRunning(runCommand, running, timeoutMs = COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const distributions = await runningDistributions(runCommand);
    if (distributions.includes(DISTRIBUTION) === running) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  fail(FIXED_WSL_QUALIFICATION_STATUS.distroStateInvalid);
}

function syntheticRollout({ sessionId, timestamp, inputTokens, model }) {
  return `${[
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id: sessionId,
        session_id: sessionId,
        thread_source: "user",
        originator: "codex_cli_rs",
        cwd: "C:\\synthetic-qualification",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: "qualification-turn",
        cwd: "C:\\synthetic-qualification",
        model,
        effort: "high",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: inputTokens + 10,
          },
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: inputTokens + 10,
          },
        },
      },
    }),
  ].join("\n")}\n`;
}

function assertPublicReceiptPathFree(value, privateValues) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (privateValues.some((privateValue) => (
        typeof privateValue === "string"
          && privateValue.length > 0
          && current.includes(privateValue)
      )) || /(?:\\\\wsl\$|\\\\wsl\.localhost|\.codex|rollout-|\.jsonl)/iu.test(current)) {
        fail(FIXED_WSL_QUALIFICATION_STATUS.publicReceiptInvalid);
      }
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      pending.push(key, nested);
    }
  }
}

function assertRootCoverage(actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
}

function ownerSnapshot(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT hex(source_local) AS source, hex(owner_local) AS owner
      FROM source_cursor
      ORDER BY source`).all();
    const usage = database.prepare(`
      SELECT COUNT(*) AS events,
             COALESCE(SUM(tokens_in_uncached), 0) AS input_tokens
      FROM usage_event`).get();
    if (rows.length !== 2
        || rows.some((row) => typeof row.owner !== "string" || row.owner.length !== 64)
        || new Set(rows.map((row) => row.owner)).size !== 2
        || Number(usage.events) !== 2
        || Number(usage.input_tokens) !== 300) {
      fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
    }
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  } finally {
    database.close();
  }
}

function assertOwnersUnchanged(expected, actual) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(FIXED_WSL_QUALIFICATION_STATUS.ownerRebound);
  }
}

async function refreshWithPrimaryAndActivityRoots({
  codexHomes,
  primaryCodexHome,
  indexFile,
  secretFile,
}) {
  let primaryObserved = false;
  let activityRootsObserved = false;
  const runner = createLocalCollectorRefreshRunner({
    accountingSourceMode: "unified",
    codexHomes,
    primaryCodexHome,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async (options) => {
      primaryObserved = options.codexHome === primaryCodexHome
        && options.skipRolloutIngestion === true;
      return {
        rolloutRecordsWritten: 1,
        filesDiscovered: 1,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      };
    },
    refreshUnifiedIndex: async (options) => {
      activityRootsObserved = Array.isArray(options.codexHomes)
        && options.codexHomes.length === 2
        && options.codexHomes[0] === codexHomes[0]
        && options.codexHomes[1] === codexHomes[1]
        && !Object.hasOwn(options, "codexHome")
        && !Object.hasOwn(options, "primaryCodexHome");
      return ingestLocalUnifiedIndexIncrement({
        codexHomes: options.codexHomes,
        indexFile,
        secretFile,
        contractVersion: CONTRACT_VERSION,
        signal: options.signal,
      });
    },
  });
  const result = await runWithAbortTimeout((signal) => runner({ signal }));
  if (!primaryObserved || !activityRootsObserved) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  return result;
}

function assertInsideTemporaryRoot(candidate, temporaryRoot) {
  const relation = relative(temporaryRoot, candidate);
  if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.temporaryRootInvalid);
  }
}

export async function runWslQualificationLifecycle({
  codexHomes,
  primaryCodexHome,
  privateValues,
  refresh,
  readOwners,
  runCommand,
  listRunning,
  waitForDistroState,
}) {
  if (!Array.isArray(codexHomes) || codexHomes.length !== 2
      || typeof primaryCodexHome !== "string"
      || primaryCodexHome !== codexHomes[0]
      || !Array.isArray(privateValues)
      || typeof refresh !== "function"
      || typeof readOwners !== "function"
      || typeof runCommand !== "function"
      || typeof listRunning !== "function"
      || typeof waitForDistroState !== "function") {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  const refreshPhase = (phase) => refresh({
    phase,
    codexHomes,
    primaryCodexHome,
  });

  const initial = await refreshPhase("initial");
  if (initial.unifiedIndex?.totalUsageEvents !== 2) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  assertRootCoverage(initial.unifiedIndex?.rootCoverage, {
    status: "ready",
    configuredRoots: 2,
    availableRoots: 2,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  });
  assertPublicReceiptPathFree(initial, privateValues);
  const initialOwners = readOwners();

  await runCommand("wsl.exe", ["--terminate", DISTRIBUTION]);
  await waitForDistroState(false);
  if ((await listRunning()).includes(DISTRIBUTION)) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.distroStateInvalid);
  }

  const partial = await refreshPhase("stopped");
  if ((await listRunning()).includes(DISTRIBUTION)) {
    // Do not mask a runner where touching the legacy \\wsl$ share starts the
    // distribution: that environment has not qualified no-auto-start.
    fail(FIXED_WSL_QUALIFICATION_STATUS.distroStateInvalid);
  }
  if (partial.unifiedIndex?.totalUsageEvents !== 2) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  assertRootCoverage(partial.unifiedIndex?.rootCoverage, {
    status: "partial",
    configuredRoots: 2,
    availableRoots: 1,
    emptyRoots: 0,
    unavailableRoots: 1,
    retainedHistory: true,
    unavailableOwnerSources: 1,
    ambiguousSources: 0,
  });
  assertPublicReceiptPathFree(partial, privateValues);
  assertOwnersUnchanged(initialOwners, readOwners());

  await runCommand("wsl.exe", [
    "--distribution", DISTRIBUTION,
    "--user", "root",
    "--", "true",
  ]);
  await waitForDistroState(true);
  const recovered = await refreshPhase("recovered");
  if (recovered.unifiedIndex?.totalUsageEvents !== 2) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
  }
  assertRootCoverage(recovered.unifiedIndex?.rootCoverage, {
    status: "ready",
    configuredRoots: 2,
    availableRoots: 2,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  });
  assertPublicReceiptPathFree(recovered, privateValues);
  assertOwnersUnchanged(initialOwners, readOwners());
  return FIXED_WSL_QUALIFICATION_STATUS.passed;
}

export async function runWslMultiRootQualification({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  runCommand = runBoundedCommand,
} = {}) {
  const validated = validateWslQualificationEnvironment({
    platform,
    architecture,
    environment,
  });
  const verbose = await runCommand("wsl.exe", ["--list", "--verbose"]);
  const distro = parseWslVerboseDistribution(verbose.stdout);
  if (distro === null) fail(FIXED_WSL_QUALIFICATION_STATUS.distroUnavailable);
  if (distro.version !== 2) {
    fail(FIXED_WSL_QUALIFICATION_STATUS.distroVersionInvalid);
  }

  const base = await mkdtemp(join(validated.temporaryRoot, "tibotattle-wsl2-"));
  const windowsRoot = join(base, "windows-codex");
  const indexFile = join(base, "state", "unified.sqlite");
  const secretFile = join(base, "state", "unified.secret");
  const wslRoot = wslCodexHome();
  const codexHomes = [windowsRoot, wslRoot];
  return runWithTemporaryCleanup(async () => {
    try {
      assertInsideTemporaryRoot(base, validated.temporaryRoot);
      await mkdir(join(windowsRoot, "sessions"), { recursive: true });
      await mkdir(join(base, "state"), { recursive: true });
      await runCommand("wsl.exe", [
        "--distribution", DISTRIBUTION,
        "--user", "root",
        "--", "mkdir", "-p", "/root/.codex/sessions",
      ]);
      await waitForDistroRunning(runCommand, true);
      await writeFile(
        join(windowsRoot, "sessions", "rollout-2026-08-23T00-00-00-windows.jsonl"),
        syntheticRollout({
          sessionId: "10000000-0000-4000-8000-000000000051",
          timestamp: "2026-08-23T00:00:00.000Z",
          inputTokens: 100,
          model: "gpt-5.6-sol",
        }),
      );
      await writeFile(
        join(wslRoot, "sessions", "rollout-2026-08-23T00-01-00-wsl.jsonl"),
        syntheticRollout({
          sessionId: "20000000-0000-4000-8000-000000000051",
          timestamp: "2026-08-23T00:01:00.000Z",
          inputTokens: 200,
          model: "gpt-5.6-terra",
        }),
      );

      return await runWslQualificationLifecycle({
        codexHomes,
        primaryCodexHome: windowsRoot,
        privateValues: [base, windowsRoot, wslRoot],
        refresh: () => refreshWithPrimaryAndActivityRoots({
          codexHomes,
          primaryCodexHome: windowsRoot,
          indexFile,
          secretFile,
        }),
        readOwners: () => ownerSnapshot(indexFile),
        runCommand,
        listRunning: () => runningDistributions(runCommand),
        waitForDistroState: (running) => waitForDistroRunning(
          runCommand,
          running,
        ),
      });
    } catch (error) {
      if (error instanceof WslQualificationError) throw error;
      fail(FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid);
    }
  }, () => rm(base, { recursive: true, force: true }));
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === invokedPath) {
  try {
    const status = await runWslMultiRootQualification();
    process.stdout.write(`${status}\n`);
  } catch (error) {
    process.stderr.write(`${fixedQualificationErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
