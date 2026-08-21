#!/usr/bin/env node

/**
 * Run the reviewed Windows portable test manifest one file at a time.
 *
 * The ordinary lane is intentionally a single Node process. That is useful
 * for local development, but it leaves a Windows CI timeout without a safe
 * file-level boundary. This runner keeps the same manifest and test command,
 * while making each child process an independently bounded, content-free
 * diagnostic.
 */

import { spawn } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOWS_PORTABLE_TEST_FILES } from "./portable-test-manifest.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const MAXIMUM_TEST_FILES = 256;
export const WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS = 64;
export const WINDOWS_PORTABLE_MAXIMUM_FAILURE_UNIT_METADATA_ITEMS = 64;
export const WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS = 1_024;
const TERMINATION_TIMEOUT_MS = 10_000;
const ORDINARY_TEST_FAILURE = Symbol("ordinary-test-failure");

export const WINDOWS_PORTABLE_TEST_TIMEOUT_MS = 60_000;
// Keep the diagnostic pre-step bounded well below the workflow's 45-minute
// job ceiling. The authoritative monolithic lane still runs after this gate.
export const WINDOWS_PORTABLE_SUITE_TIMEOUT_MS = 5 * 60 * 1_000;

// These are mode markers, not the qualification-only binding path used by a
// few native hook tests. The child must load the ordinary production binding
// and must not enter the credential/Electron qualification modes. The hook
// path remains available for tests that explicitly load that separate binary.
export const WINDOWS_PORTABLE_QUALIFICATION_ENVIRONMENT_KEYS = Object.freeze([
  "USAGE_MONITOR_WINDOWS_QUALIFICATION",
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION",
  "USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID",
  "TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT",
  "USAGE_MONITOR_TEST_LANE",
]);

export const WINDOWS_PORTABLE_STATUS = Object.freeze({
  passed: "WINDOWS_PORTABLE_DIAGNOSTIC_PASSED",
  unsupported: "WINDOWS_PORTABLE_DIAGNOSTIC_NATIVE_WINDOWS_REQUIRED",
  invalid: "WINDOWS_PORTABLE_DIAGNOSTIC_INVALID",
  failed: "WINDOWS_PORTABLE_DIAGNOSTIC_TEST_FAILED",
  timedOut: "WINDOWS_PORTABLE_DIAGNOSTIC_TEST_TIMED_OUT",
  suiteTimedOut: "WINDOWS_PORTABLE_DIAGNOSTIC_SUITE_TIMED_OUT",
  terminationFailed: "WINDOWS_PORTABLE_DIAGNOSTIC_TERMINATION_FAILED",
});

function fixedError(code, metadata = {}) {
  const error = new Error(code);
  error.code = code;
  if (typeof metadata.file === "string") error.file = metadata.file;
  if (Number.isSafeInteger(metadata.ordinal)) error.ordinal = metadata.ordinal;
  if (Number.isSafeInteger(metadata.elapsedMs)) error.elapsedMs = metadata.elapsedMs;
  if (Number.isSafeInteger(metadata.progressUnits)
      && metadata.progressUnits >= 0
      && metadata.progressUnits <= WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS) {
    error.progressUnits = metadata.progressUnits;
  }
  if (Array.isArray(metadata.failureUnitOrdinals)
      && metadata.failureUnitOrdinals.length
        <= WINDOWS_PORTABLE_MAXIMUM_FAILURE_UNIT_METADATA_ITEMS
      && metadata.failureUnitOrdinals.every((unit, index, units) =>
        Number.isSafeInteger(unit)
          && unit >= 1
          && unit <= WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS
          && (index === 0 || unit > units[index - 1]))
      && typeof metadata.failureUnitsTruncated === "boolean") {
    error.failureUnitOrdinals = Object.freeze([
      ...metadata.failureUnitOrdinals,
    ]);
    error.failureUnitsTruncated = metadata.failureUnitsTruncated;
  }
  return error;
}

function markOrdinaryTestFailure(error) {
  Object.defineProperty(error, ORDINARY_TEST_FAILURE, {
    value: true,
    enumerable: false,
  });
  return error;
}

function boundedElapsed(startedAt, timeoutMs) {
  const elapsed = Date.now() - startedAt;
  return Math.min(timeoutMs, Math.max(0, Number.isSafeInteger(elapsed) ? elapsed : timeoutMs));
}

function canonicalRepositoryPath(candidate, cwd) {
  if (typeof candidate !== "string"
      || candidate.length === 0
      || candidate.includes("\0")
      || candidate.includes("\\")
      || candidate.startsWith("/")) {
    return null;
  }
  const selected = resolve(cwd, candidate);
  const selectedRelative = relative(cwd, selected);
  if (selectedRelative === ""
      || selectedRelative === ".."
      || selectedRelative.startsWith(`..${sep}`)) {
    return null;
  }
  const normalized = selectedRelative.split(sep).join("/");
  return normalized === candidate ? normalized : null;
}

function validateTestFiles(files, cwd) {
  if (!Array.isArray(files)
      || files.length < 1
      || files.length > MAXIMUM_TEST_FILES) {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  for (const file of files) {
    if (canonicalRepositoryPath(file, cwd) === null) {
      throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
    }
  }
  return Object.freeze([...files]);
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > WINDOWS_PORTABLE_TEST_TIMEOUT_MS) {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  return timeoutMs;
}

function validateSuiteTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > WINDOWS_PORTABLE_SUITE_TIMEOUT_MS) {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  return timeoutMs;
}

function productionPortableEnvironment(environment) {
  if (environment === null
      || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  const childEnvironment = { ...environment };
  for (const key of WINDOWS_PORTABLE_QUALIFICATION_ENVIRONMENT_KEYS) {
    delete childEnvironment[key];
  }
  for (const [key, value] of Object.entries(childEnvironment)) {
    if (value !== undefined && typeof value !== "string") {
      throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
    }
  }
  return childEnvironment;
}

function childIsRunning(child) {
  return child !== null
    && typeof child === "object"
    && child.exitCode === null
    && child.signalCode === null;
}

function childIsClosed(child) {
  return child !== null
    && typeof child === "object"
    && !childIsRunning(child)
    && (Number.isSafeInteger(child.exitCode)
      || typeof child.signalCode === "string");
}

function observeProgressUnits(chunk, state) {
  if (state.count >= WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS) return;
  const visit = (code) => {
    if (state.count >= WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS) return;
    if (code !== 0x2e && code !== 0x58) return;
    state.count += 1;
    if (code !== 0x58) return;
    if (state.failureUnitOrdinals.length
        < WINDOWS_PORTABLE_MAXIMUM_FAILURE_UNIT_METADATA_ITEMS) {
      state.failureUnitOrdinals.push(state.count);
    } else {
      state.failureUnitsTruncated = true;
    }
  };
  if (typeof chunk === "string") {
    for (let index = 0; index < chunk.length; index += 1) {
      visit(chunk.charCodeAt(index));
    }
    return;
  }
  if (!(chunk instanceof Uint8Array)) return;
  for (const byte of chunk) visit(byte);
}

/**
 * Kill only the process tree rooted at the child spawned by this runner.
 * Checking the live child before invoking taskkill avoids targeting a reused
 * PID after the owned process has already exited.
 */
export async function terminateWindowsPortableProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    timeoutMs = TERMINATION_TIMEOUT_MS,
  } = {},
) {
  if (!childIsRunning(child)) return false;
  if (platform !== "win32") {
    return typeof child.kill === "function" && child.kill("SIGKILL");
  }
  if (!Number.isSafeInteger(child.pid) || child.pid < 1
      || typeof spawnProcess !== "function"
      || typeof child.once !== "function"
      || typeof child.removeListener !== "function"
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1) {
    return false;
  }
  const targetPid = child.pid;
  return new Promise((resolveTermination) => {
    let settled = false;
    let childClosed = false;
    let killerSucceeded = false;
    let timer;
    let killer;
    const onChildClose = () => {
      if (!childIsClosed(child)) {
        finish(false);
        return;
      }
      childClosed = true;
      maybeFinish();
    };
    const onChildError = () => finish(false);
    const onKillerError = () => finish(false);
    const onKillerClose = (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      killerSucceeded = true;
      maybeFinish();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onChildClose);
      child.removeListener("error", onChildError);
      if (killer && typeof killer.removeListener === "function") {
        killer.removeListener("error", onKillerError);
        killer.removeListener("close", onKillerClose);
      }
    };
    const finish = (success) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveTermination(success);
    };
    const maybeFinish = () => {
      if (killerSucceeded && childClosed) finish(true);
    };
    try {
      // Register the close proof before invoking taskkill so a fast child
      // shutdown cannot be mistaken for a still-owned PID.
      child.once("close", onChildClose);
      child.once("error", onChildError);
      if (settled || !childIsRunning(child)) {
        finish(false);
        return;
      }
      timer = setTimeout(() => finish(false), timeoutMs);
      killer = spawnProcess("taskkill.exe", [
        "/pid",
        String(targetPid),
        "/t",
        "/f",
      ], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      if (!killer
          || typeof killer.once !== "function"
          || typeof killer.removeListener !== "function") {
        finish(false);
        return;
      }
      killer.once("error", onKillerError);
      killer.once("close", onKillerClose);
    } catch {
      finish(false);
      return;
    }
  });
}

function runPortableTestFile(
  file,
  ordinal,
  {
    cwd,
    environment,
    timeoutMs,
    platform,
    spawnProcess,
    terminateProcessTree,
  },
) {
  const startedAt = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      const arguments_ = [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=dot",
        file,
      ];
      child = spawnProcess(process.execPath, arguments_, {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (!child || typeof child.once !== "function") throw new Error("invalid child");
    } catch {
      rejectRun(fixedError(WINDOWS_PORTABLE_STATUS.failed, {
        file,
        ordinal,
        elapsedMs: boundedElapsed(startedAt, timeoutMs),
      }));
      return;
    }

    const stdout = child.stdout;
    const baseMetadata = {
      file,
      ordinal,
      elapsedMs: boundedElapsed(startedAt, timeoutMs),
    };
    const failMalformedChild = (status) => {
      rejectRun(fixedError(status, status === WINDOWS_PORTABLE_STATUS.terminationFailed
        ? { ...baseMetadata, progressUnits: 0 }
        : baseMetadata));
    };
    if (!stdout
        || typeof stdout.on !== "function"
        || typeof stdout.once !== "function"
        || typeof stdout.removeListener !== "function"
        || typeof child.removeListener !== "function") {
      if (!childIsRunning(child)) {
        failMalformedChild(WINDOWS_PORTABLE_STATUS.failed);
        return;
      }
      let termination;
      try {
        termination = Promise.resolve(terminateProcessTree(child, { platform }));
      } catch {
        failMalformedChild(WINDOWS_PORTABLE_STATUS.terminationFailed);
        return;
      }
      void termination.then(
        (terminated) => failMalformedChild(
          terminated
            ? WINDOWS_PORTABLE_STATUS.failed
            : WINDOWS_PORTABLE_STATUS.terminationFailed,
        ),
        () => failMalformedChild(WINDOWS_PORTABLE_STATUS.terminationFailed),
      );
      return;
    }

    let settled = false;
    let terminationRequested = false;
    const progress = {
      count: 0,
      failureUnitOrdinals: [],
      failureUnitsTruncated: false,
    };
    let timeoutHandle;
    const onStdoutData = (chunk) => {
      observeProgressUnits(chunk, progress);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      stdout.removeListener("data", onStdoutData);
      stdout.removeListener("error", onStdoutError);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
      callback(value);
    };
    const fail = (status, { ordinaryTestFailure = false } = {}) => {
      const metadata = {
        file,
        ordinal,
        elapsedMs: boundedElapsed(startedAt, timeoutMs),
      };
      if (status === WINDOWS_PORTABLE_STATUS.timedOut
          || status === WINDOWS_PORTABLE_STATUS.terminationFailed) {
        metadata.progressUnits = progress.count;
      }
      if (ordinaryTestFailure) {
        metadata.progressUnits = progress.count;
        metadata.failureUnitOrdinals = progress.failureUnitOrdinals;
        metadata.failureUnitsTruncated = progress.failureUnitsTruncated;
      }
      const error = fixedError(status, metadata);
      settle(
        rejectRun,
        ordinaryTestFailure ? markOrdinaryTestFailure(error) : error,
      );
    };
    const terminateWith = async (status) => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      let terminated = false;
      try {
        terminated = await Promise.resolve(
          terminateProcessTree(child, { platform }),
        );
      } catch {
        terminated = false;
      }
      fail(terminated ? status : WINDOWS_PORTABLE_STATUS.terminationFailed);
    };
    const onStdoutError = () => {
      void terminateWith(WINDOWS_PORTABLE_STATUS.failed);
    };
    const onChildError = () => {
      if (terminationRequested) return;
      fail(WINDOWS_PORTABLE_STATUS.failed);
    };
    const onChildClose = (code) => {
      if (terminationRequested) return;
      if (code === 0 && child.signalCode === null) {
        settle(resolveRun, undefined);
        return;
      }
      if (Number.isSafeInteger(code) && code > 0 && child.signalCode === null) {
        fail(WINDOWS_PORTABLE_STATUS.failed, { ordinaryTestFailure: true });
        return;
      }
      // A signal, malformed close result, or other child lifecycle failure is
      // not an ordinary test assertion. Stop the diagnostic immediately.
      fail(WINDOWS_PORTABLE_STATUS.failed);
    };
    timeoutHandle = setTimeout(() => {
      void terminateWith(WINDOWS_PORTABLE_STATUS.timedOut);
    }, timeoutMs);

    stdout.on("data", onStdoutData);
    stdout.once("error", onStdoutError);
    child.once("error", onChildError);
    child.once("close", onChildClose);
  });
}

/**
 * Test seam for the file runner. The CLI below calls this only with the exact
 * reviewed manifest. Callers must supply repository-relative files; arbitrary
 * paths and non-string environment values fail closed.
 */
export async function runWindowsPortableTestFiles(
  files,
  {
    platform = process.platform,
    architecture = process.arch,
    cwd = REPOSITORY_ROOT,
    environment = process.env,
    timeoutMs = WINDOWS_PORTABLE_TEST_TIMEOUT_MS,
    globalTimeoutMs = WINDOWS_PORTABLE_SUITE_TIMEOUT_MS,
    spawnProcess = spawn,
    terminateProcessTree = terminateWindowsPortableProcessTree,
    now = Date.now,
  } = {},
) {
  if (platform !== "win32" || architecture !== "x64") {
    throw fixedError(WINDOWS_PORTABLE_STATUS.unsupported);
  }
  if (typeof cwd !== "string"
      || typeof spawnProcess !== "function"
      || typeof terminateProcessTree !== "function"
      || typeof now !== "function") {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  const selectedFiles = validateTestFiles(files, cwd);
  const selectedTimeoutMs = validateTimeout(timeoutMs);
  const selectedGlobalTimeoutMs = validateSuiteTimeout(globalTimeoutMs);
  const childEnvironment = productionPortableEnvironment(environment);
  const terminate = terminateProcessTree === terminateWindowsPortableProcessTree
    ? (child, options) => terminateWindowsPortableProcessTree(child, {
      ...options,
      spawnProcess,
    })
    : terminateProcessTree;
  const suiteStartedAt = now();
  if (!Number.isSafeInteger(suiteStartedAt)) {
    throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
  }
  let failureCount = 0;
  const failures = [];
  for (let index = 0; index < selectedFiles.length; index += 1) {
    const suiteNow = now();
    if (!Number.isSafeInteger(suiteNow)) {
      throw fixedError(WINDOWS_PORTABLE_STATUS.invalid);
    }
    const suiteElapsed = suiteNow - suiteStartedAt;
    const remainingSuiteMs = selectedGlobalTimeoutMs - Math.max(0, suiteElapsed);
    if (remainingSuiteMs < 1) {
      throw fixedError(WINDOWS_PORTABLE_STATUS.suiteTimedOut, {
        file: selectedFiles[index],
        ordinal: index + 1,
        elapsedMs: selectedGlobalTimeoutMs,
      });
    }
    try {
      await runPortableTestFile(
        selectedFiles[index],
        index + 1,
        {
          cwd,
          environment: childEnvironment,
          timeoutMs: Math.min(selectedTimeoutMs, remainingSuiteMs),
          platform,
          spawnProcess,
          terminateProcessTree: terminate,
        },
      );
    } catch (error) {
      if (error?.[ORDINARY_TEST_FAILURE] !== true) throw error;
      failureCount += 1;
      if (failures.length < WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS) {
        failures.push(Object.freeze({
          file: selectedFiles[index],
          failureUnitOrdinals: Object.freeze([
            ...(error.failureUnitOrdinals ?? []),
          ]),
          failureUnitsTruncated: error.failureUnitsTruncated === true,
          ordinal: index + 1,
          status: WINDOWS_PORTABLE_STATUS.failed,
        }));
      }
    }
  }
  if (failureCount > 0) {
    const aggregate = fixedError(WINDOWS_PORTABLE_STATUS.failed);
    aggregate.failureCount = failureCount;
    aggregate.failures = Object.freeze(failures);
    aggregate.failuresTruncated = failureCount > failures.length;
    throw Object.freeze(aggregate);
  }
  return Object.freeze({
    fileCount: selectedFiles.length,
    timeoutMs: selectedTimeoutMs,
    globalTimeoutMs: selectedGlobalTimeoutMs,
  });
}

export function runWindowsPortableQualification(options = {}) {
  return runWindowsPortableTestFiles(WINDOWS_PORTABLE_TEST_FILES, options);
}

function safeFailureStatus(error) {
  return error?.code && Object.values(WINDOWS_PORTABLE_STATUS).includes(error.code)
    ? error.code
    : WINDOWS_PORTABLE_STATUS.failed;
}

function safeFailureElapsed(error) {
  return Number.isSafeInteger(error?.elapsedMs)
    ? Math.min(WINDOWS_PORTABLE_SUITE_TIMEOUT_MS, Math.max(0, error.elapsedMs))
    : "unavailable";
}

function safeFailureProgress(error, status) {
  if (status !== WINDOWS_PORTABLE_STATUS.timedOut
      && status !== WINDOWS_PORTABLE_STATUS.terminationFailed) {
    return null;
  }
  return Number.isSafeInteger(error?.progressUnits)
      && error.progressUnits >= 0
      && error.progressUnits <= WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS
    ? error.progressUnits
    : "unavailable";
}

function safeFailureLocation(error) {
  if (typeof error?.file !== "string"
      || !Number.isSafeInteger(error.ordinal)
      || error.ordinal < 1
      || error.ordinal > WINDOWS_PORTABLE_TEST_FILES.length
      || WINDOWS_PORTABLE_TEST_FILES[error.ordinal - 1] !== error.file) {
    return null;
  }
  return Object.freeze({ file: error.file, ordinal: error.ordinal });
}

function safeFailureMetadata(error) {
  if (!Number.isSafeInteger(error?.failureCount)
      || error.failureCount < 1
      || error.failureCount > WINDOWS_PORTABLE_TEST_FILES.length
      || !Array.isArray(error.failures)
      || error.failures.length > WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS
      || error.failures.length
        !== Math.min(error.failureCount, WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS)
      || typeof error.failuresTruncated !== "boolean"
      || error.failuresTruncated !== (error.failureCount > error.failures.length)) {
    return null;
  }
  const seenOrdinals = new Set();
  const failures = [];
  for (const failure of error.failures) {
    if (failure === null
        || typeof failure !== "object"
        || typeof failure.file !== "string"
        || !Number.isSafeInteger(failure.ordinal)
        || failure.ordinal < 1
        || failure.ordinal > WINDOWS_PORTABLE_TEST_FILES.length
        || WINDOWS_PORTABLE_TEST_FILES[failure.ordinal - 1] !== failure.file
        || failure.status !== WINDOWS_PORTABLE_STATUS.failed
        || !Array.isArray(failure.failureUnitOrdinals)
        || failure.failureUnitOrdinals.length
          > WINDOWS_PORTABLE_MAXIMUM_FAILURE_UNIT_METADATA_ITEMS
        || failure.failureUnitOrdinals.some((unit, index, units) =>
          !Number.isSafeInteger(unit)
            || unit < 1
            || unit > WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS
            || (index > 0 && unit <= units[index - 1]))
        || typeof failure.failureUnitsTruncated !== "boolean"
        || seenOrdinals.has(failure.ordinal)) {
      return null;
    }
    seenOrdinals.add(failure.ordinal);
    failures.push(Object.freeze({
      file: failure.file,
      failureUnitOrdinals: Object.freeze([
        ...failure.failureUnitOrdinals,
      ]),
      failureUnitsTruncated: failure.failureUnitsTruncated,
      ordinal: failure.ordinal,
      status: WINDOWS_PORTABLE_STATUS.failed,
    }));
  }
  return Object.freeze({
    failureCount: error.failureCount,
    failures: Object.freeze(failures),
    failuresTruncated: error.failuresTruncated,
  });
}

export function formatWindowsPortableDiagnosticFailure(error) {
  const status = safeFailureStatus(error);
  const aggregate = safeFailureMetadata(error);
  if (aggregate !== null) {
    return [
      `${"WINDOWS_PORTABLE_DIAGNOSTIC_FAILED"}`
        + ` failure_count=${aggregate.failureCount}`
        + ` recorded_failures=${aggregate.failures.length}`
        + ` truncated=${aggregate.failuresTruncated ? 1 : 0}`,
      ...aggregate.failures.map((failure) =>
        `WINDOWS_PORTABLE_DIAGNOSTIC_FAILURE file=${failure.file}`
          + ` ordinal=${failure.ordinal} status=${failure.status}`
          + ` unit_ordinals=${failure.failureUnitOrdinals.length > 0
            ? failure.failureUnitOrdinals.join(":")
            : "unavailable"}`
          + ` units_truncated=${failure.failureUnitsTruncated ? 1 : 0}`),
    ].join("\n");
  }
  const location = safeFailureLocation(error);
  if (location !== null) {
    const progress = safeFailureProgress(error, status);
    const progressMetadata = progress === null
      ? ""
      : ` progress_units=${progress}`;
    return `WINDOWS_PORTABLE_DIAGNOSTIC_FAILED file=${location.file}`
      + ` ordinal=${location.ordinal} status=${status}`
      + ` elapsed_ms=${safeFailureElapsed(error)}`
      + `${progressMetadata}`;
  }
  return status;
}

export async function main() {
  try {
    const result = await runWindowsPortableQualification();
    console.log(`${WINDOWS_PORTABLE_STATUS.passed} files=${result.fileCount}`);
  } catch (error) {
    console.error(formatWindowsPortableDiagnosticFailure(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
