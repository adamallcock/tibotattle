import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
  readBoundedDirectoryEntries,
} from "./export-resource-policy.js";

export const R7_FILESYSTEM_HIGH_WATER_VERSION = "g1-r7-filesystem-high-water-v0.2";
export const R7_FILESYSTEM_SAMPLE_INTERVAL_MS = 100;

export const R7_FILESYSTEM_HIGH_WATER_OUTCOMES = Object.freeze([
  "completed",
  "root_unsafe",
  "root_replaced",
  "symlink_rejected",
  "hardlink_rejected",
  "hardlink_unowned_rejected",
  "hardlink_zero_rejected",
  "hardlink_many_rejected",
  "unsupported_entry_rejected",
  "directory_limit_exceeded",
  "deadline_exceeded",
  "sampling_failed",
  "operation_failed",
]);

const SAFE_FAILURES = new Set(R7_FILESYSTEM_HIGH_WATER_OUTCOMES.slice(1, -1));
const BINDINGS = new WeakMap();
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const ALLOWED_TRANSIENT_SYMLINK_NAMES = new Set([".app-usagemonitor-export.lock"]);

export class R7FilesystemHighWaterError extends Error {
  constructor(reason) {
    if (!SAFE_FAILURES.has(reason)) {
      throw new TypeError("Unknown R7 filesystem sampling failure");
    }
    super(`R7 filesystem sampling stopped: ${reason}`);
    this.name = "R7FilesystemHighWaterError";
    this.code = `r7_filesystem_${reason}`;
    this.reason = reason;
  }
}

function fail(reason) {
  throw new R7FilesystemHighWaterError(reason);
}

function safeIdentity(stat) {
  return stat?.isDirectory?.() === true
    && stat.isSymbolicLink() === false
    && Number.isSafeInteger(stat.dev)
    && stat.dev >= 0
    && Number.isSafeInteger(stat.ino)
    && stat.ino >= 0;
}

function sameIdentity(stat, identity) {
  return safeIdentity(stat) && stat.dev === identity.dev && stat.ino === identity.ino;
}

function safeRegularIdentity(stat) {
  return stat?.isFile?.() === true
    && stat.isSymbolicLink() === false
    && Number.isSafeInteger(stat.dev) && stat.dev >= 0
    && Number.isSafeInteger(stat.ino) && stat.ino >= 0;
}

function countRegularFile(totals, stat) {
  if (!Number.isSafeInteger(stat.size) || stat.size < 0
      || totals.bytes > Number.MAX_SAFE_INTEGER - stat.size) {
    fail("sampling_failed");
  }
  totals.bytes += stat.size;
  totals.fileCount += 1;
}

function normalizeMaximumEntries(value) {
  if (!Number.isSafeInteger(value) || value < 1
      || value > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries) {
    throw new TypeError("maximumDirectoryEntries is outside the R7 resource-policy range");
  }
  return value;
}

function normalizeTransientSymlinkNames(value = []) {
  if (!Array.isArray(value) || value.some(
    (name) => typeof name !== "string" || !ALLOWED_TRANSIENT_SYMLINK_NAMES.has(name),
  )) {
    throw new TypeError("R7 transient symlink exclusion is unsupported");
  }
  return new Set(value);
}

function monotonic(dependencies) {
  try {
    const value = dependencies.monotonicNow();
    if (typeof value !== "bigint" || value < 0n) fail("sampling_failed");
    return value;
  } catch (error) {
    if (error instanceof R7FilesystemHighWaterError) throw error;
    fail("sampling_failed");
  }
}

function emptyMeasurements() {
  return { before: null, highWater: null, after: null };
}

function fixedResult({
  outcome,
  measurements = emptyMeasurements(),
  sampleCount = 0,
  periodicSampleCount = 0,
  elapsedMs = 0,
}) {
  return {
    filesystemHighWaterVersion: R7_FILESYSTEM_HIGH_WATER_VERSION,
    outcome,
    samplingIntervalMs: R7_FILESYSTEM_SAMPLE_INTERVAL_MS,
    elapsedMs,
    sampleCount,
    periodicSampleCount,
    measurements,
  };
}

function elapsedMilliseconds(startedAtNs, nowNs) {
  if (nowNs < startedAtNs) fail("sampling_failed");
  const elapsedNs = nowNs - startedAtNs;
  const rounded = (elapsedNs + NANOSECONDS_PER_MILLISECOND - 1n)
    / NANOSECONDS_PER_MILLISECOND;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail("sampling_failed");
  return Number(rounded);
}

function classify(error) {
  if (error instanceof R7FilesystemHighWaterError) return error.reason;
  if (error instanceof ExportResourceLimitError
      && error.code === "export_resource_directory_entries") {
    return "directory_limit_exceeded";
  }
  return "sampling_failed";
}

function preferredHighWater(current, candidate) {
  if (current === null) return candidate;
  if (candidate.bytes !== current.bytes) return candidate.bytes > current.bytes ? candidate : current;
  if (candidate.entryCount !== current.entryCount) {
    return candidate.entryCount > current.entryCount ? candidate : current;
  }
  if (candidate.fileCount !== current.fileCount) {
    return candidate.fileCount > current.fileCount ? candidate : current;
  }
  return candidate.directoryCount > current.directoryCount ? candidate : current;
}

function dependencies(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("R7 filesystem sampler dependencies must be an object");
  }
  return {
    lstatPath: lstat,
    realpathPath: realpath,
    readDirectoryEntries: readBoundedDirectoryEntries,
    monotonicNow: process.hrtime.bigint,
    scheduleInterval: setInterval,
    cancelInterval: clearInterval,
    ...overrides,
  };
}

async function rootStillBound(state, deps) {
  try {
    const [requestedStat, canonical, canonicalStat] = await Promise.all([
      deps.lstatPath(state.requested),
      deps.realpathPath(state.requested),
      deps.lstatPath(state.canonical),
    ]);
    if (canonical !== state.canonical
        || !sameIdentity(requestedStat, state.identity)
        || !sameIdentity(canonicalStat, state.identity)) {
      fail("root_replaced");
    }
  } catch (error) {
    if (error instanceof R7FilesystemHighWaterError) throw error;
    fail("root_replaced");
  }
}

async function assertDirectoryIdentity(path, expectedIdentity, state, deps, { allowMissing = false } = {}) {
  await rootStillBound(state, deps);
  try {
    const [canonical, stat] = await Promise.all([
      deps.realpathPath(path),
      deps.lstatPath(path),
    ]);
    if (canonical !== path || !sameIdentity(stat, expectedIdentity)) fail("sampling_failed");
    return true;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      await rootStillBound(state, deps);
      return false;
    }
    if (error instanceof R7FilesystemHighWaterError) {
      if (error.reason !== "root_replaced") {
        try {
          await rootStillBound(state, deps);
        } catch {
          fail("root_replaced");
        }
      }
      throw error;
    }
    fail("sampling_failed");
  }
}

async function bindRoot(root, deps) {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
    throw new TypeError("R7 filesystem root must be a non-empty absolute path");
  }
  const requested = resolve(root);
  try {
    const suppliedStat = await deps.lstatPath(requested);
    if (!safeIdentity(suppliedStat)) fail("root_unsafe");
    const canonical = await deps.realpathPath(requested);
    const canonicalStat = await deps.lstatPath(canonical);
    if (!sameIdentity(canonicalStat, suppliedStat)) fail("root_unsafe");
    return {
      requested,
      canonical,
      identity: { dev: canonicalStat.dev, ino: canonicalStat.ino },
    };
  } catch (error) {
    if (error instanceof R7FilesystemHighWaterError) throw error;
    fail("root_unsafe");
  }
}

/**
 * Bind an opaque capability to one exact real directory. The resolved path and
 * device/inode identity stay module-private and therefore cannot enter a
 * receipt or an arbitrary error projection.
 */
export async function createR7FilesystemRootBinding(root, overrides = {}) {
  const deps = dependencies(overrides);
  const state = await bindRoot(root, deps);
  const binding = Object.freeze({
    bindingVersion: R7_FILESYSTEM_HIGH_WATER_VERSION,
  });
  BINDINGS.set(binding, state);
  return binding;
}

/**
 * Measure apparent regular-file bytes beneath an exact bound root. The root is
 * not counted as an entry; child directories are counted but contribute no
 * bytes. No names, paths, identities, timestamps, or content leave this call.
 */
export async function measureR7FilesystemRoot(binding, {
  maximumDirectoryEntries = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
  allowedTransientSymlinkNames = [],
  allowTransientOwnedHardlinks = false,
} = {}, overrides = {}) {
  const state = BINDINGS.get(binding);
  if (!state) throw new TypeError("R7 filesystem root binding is invalid");
  const maximumEntries = normalizeMaximumEntries(maximumDirectoryEntries);
  const allowedTransientSymlinks = normalizeTransientSymlinkNames(allowedTransientSymlinkNames);
  if (typeof allowTransientOwnedHardlinks !== "boolean") {
    throw new TypeError("R7 transient hardlink option must be boolean");
  }
  const deps = dependencies(overrides);
  const totals = { bytes: 0, entryCount: 0, fileCount: 0, directoryCount: 0 };
  const stack = [{ path: state.canonical, identity: state.identity }];

  try {
    await rootStillBound(state, deps);
    while (stack.length > 0) {
      const directory = stack.pop();
      const exists = await assertDirectoryIdentity(
        directory.path,
        directory.identity,
        state,
        deps,
        { allowMissing: directory.path !== state.canonical },
      );
      if (!exists) continue;
      const remaining = maximumEntries - totals.entryCount;
      let names;
      try {
        names = await deps.readDirectoryEntries(directory.path, {
          maximumEntries: Math.max(1, remaining),
          sort: true,
        });
      } catch (error) {
        if (directory.path !== state.canonical && error?.code === "ENOENT") {
          await rootStillBound(state, deps);
          continue;
        }
        throw error;
      }
      if (names.length > remaining) fail("directory_limit_exceeded");
      for (const name of names) {
        if (!await assertDirectoryIdentity(
          directory.path,
          directory.identity,
          state,
          deps,
          { allowMissing: directory.path !== state.canonical },
        )) break;
        const path = join(directory.path, name);
        let stat;
        try {
          stat = await deps.lstatPath(path);
        } catch (error) {
          if (error?.code === "ENOENT") {
            await rootStillBound(state, deps);
            continue;
          }
          fail("sampling_failed");
        }
        totals.entryCount += 1;
        if (stat.isSymbolicLink()) {
          const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
          if (!allowedTransientSymlinks.has(name) || !owned || stat.nlink < 1 || stat.nlink > 2) {
            fail("symlink_rejected");
          }
          continue;
        }
        if (stat.isDirectory()) {
          if (!safeIdentity(stat)) fail("unsupported_entry_rejected");
          totals.directoryCount += 1;
          stack.push({ path, identity: { dev: stat.dev, ino: stat.ino } });
          continue;
        }
        if (!stat.isFile()) fail("unsupported_entry_rejected");
        let replacement = null;
        if (stat.nlink !== 1) {
          const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
          let confirmedTerminalUnlink = false;
          if (!allowTransientOwnedHardlinks) fail("hardlink_rejected");
          if (!owned) fail("hardlink_unowned_rejected");
          if (stat.nlink === 0) {
            if (!safeRegularIdentity(stat)) fail("hardlink_zero_rejected");
            // SQLite DELETE-mode journals can be unlinked and recreated between
            // path lookups. Recheck once: disappearance or a distinct, owned,
            // singly-linked regular inode in the still-bound parent is safe to
            // measure. Persistent zero links and ambiguous replacements fail.
            try {
              replacement = await deps.lstatPath(path);
            } catch (error) {
              if (error?.code === "ENOENT") {
                await rootStillBound(state, deps);
                confirmedTerminalUnlink = true;
              } else {
                fail("sampling_failed");
              }
            }
            // A confirmed disappearance retains removable-parent tolerance;
            // every resolving replacement requires the exact parent to remain.
            await assertDirectoryIdentity(
              directory.path,
              directory.identity,
              state,
              deps,
              { allowMissing: confirmedTerminalUnlink && directory.path !== state.canonical },
            );
            if (replacement !== null) {
              if (!safeRegularIdentity(replacement)
                  || replacement.dev !== stat.dev || replacement.ino === stat.ino
                  || replacement.uid !== stat.uid || replacement.nlink !== 1) {
                fail("hardlink_zero_rejected");
              }
              confirmedTerminalUnlink = true;
            }
            if (!confirmedTerminalUnlink) fail("hardlink_zero_rejected");
          }
          if (stat.nlink !== 2 && !confirmedTerminalUnlink) fail("hardlink_many_rejected");
        }
        countRegularFile(totals, stat);
        // Keep both observed inode sizes: this is a conservative mutable-tree
        // high-water sample, not a claim that they coexisted at one instant.
        // entryCount counts enumerated paths; fileCount counts observed inodes.
        if (replacement !== null) countRegularFile(totals, replacement);
      }
      await assertDirectoryIdentity(
        directory.path,
        directory.identity,
        state,
        deps,
        { allowMissing: directory.path !== state.canonical },
      );
    }
    await rootStillBound(state, deps);
    return totals;
  } catch (error) {
    if (error instanceof R7FilesystemHighWaterError) {
      if (error.reason !== "root_replaced") {
        try {
          await rootStillBound(state, deps);
        } catch {
          fail("root_replaced");
        }
      }
      throw error;
    }
    if (error instanceof ExportResourceLimitError
        && error.code === "export_resource_directory_entries") {
      fail("directory_limit_exceeded");
    }
    try {
      await rootStillBound(state, deps);
    } catch {
      fail("root_replaced");
    }
    fail("sampling_failed");
  }
}

/**
 * Run one operation while periodically sampling its exact task-owned root.
 * The operation's return value and any thrown error are discarded. Sampling
 * uses a fixed 100 ms interval and a bigint monotonic deadline; the deadline is
 * classification-only because this module does not own or kill worker state.
 */
export async function runR7FilesystemHighWaterSampler({
  root,
  operation,
  maximumElapsedMs = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumElapsedMs,
  maximumDirectoryEntries = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
  allowedTransientSymlinkNames = [],
  allowTransientOwnedHardlinks = false,
}, overrides = {}) {
  if (typeof operation !== "function") throw new TypeError("R7 filesystem operation must be a function");
  if (!Number.isSafeInteger(maximumElapsedMs) || maximumElapsedMs < 1
      || maximumElapsedMs > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumElapsedMs) {
    throw new TypeError("maximumElapsedMs is outside the R7 resource-policy range");
  }
  normalizeMaximumEntries(maximumDirectoryEntries);
  normalizeTransientSymlinkNames(allowedTransientSymlinkNames);
  if (typeof allowTransientOwnedHardlinks !== "boolean") {
    throw new TypeError("R7 transient hardlink option must be boolean");
  }
  const deps = dependencies(overrides);
  const startedAtNs = monotonic(deps);
  const deadlineNs = startedAtNs + (BigInt(maximumElapsedMs) * NANOSECONDS_PER_MILLISECOND);
  let binding;
  let before;
  try {
    binding = await createR7FilesystemRootBinding(root, deps);
    before = await measureR7FilesystemRoot(binding, {
      maximumDirectoryEntries,
      allowedTransientSymlinkNames,
      allowTransientOwnedHardlinks,
    }, deps);
  } catch (error) {
    return fixedResult({
      outcome: classify(error),
      elapsedMs: elapsedMilliseconds(startedAtNs, monotonic(deps)),
    });
  }
  const afterBeforeNs = monotonic(deps);
  if (afterBeforeNs >= deadlineNs) {
    return fixedResult({
      outcome: "deadline_exceeded",
      measurements: { before, highWater: before, after: before },
      sampleCount: 1,
      elapsedMs: elapsedMilliseconds(startedAtNs, afterBeforeNs),
    });
  }

  let highWater = before;
  let after = null;
  let sampleCount = 1;
  let periodicSampleCount = 0;
  let samplingFailure = null;
  let deadlineExceeded = false;
  let stopped = false;
  let sampleInFlight = null;

  const periodicSample = async () => {
    if (stopped || samplingFailure) return;
    const nowNs = monotonic(deps);
    if (nowNs >= deadlineNs) {
      deadlineExceeded = true;
      return;
    }
    const sample = await measureR7FilesystemRoot(binding, {
      maximumDirectoryEntries,
      allowedTransientSymlinkNames,
      allowTransientOwnedHardlinks,
    }, deps);
    highWater = preferredHighWater(highWater, sample);
    sampleCount += 1;
    periodicSampleCount += 1;
  };

  let intervalHandle;
  try {
    intervalHandle = deps.scheduleInterval(() => {
      if (sampleInFlight !== null) return sampleInFlight;
      sampleInFlight = periodicSample()
        .catch((error) => {
          samplingFailure = classify(error);
        })
        .finally(() => {
          sampleInFlight = null;
        });
      return sampleInFlight;
    }, R7_FILESYSTEM_SAMPLE_INTERVAL_MS);
  } catch {
    samplingFailure = "sampling_failed";
  }

  let operationFailed = false;
  try {
    await operation();
  } catch {
    operationFailed = true;
  }
  stopped = true;
  if (intervalHandle !== undefined) {
    try {
      deps.cancelInterval(intervalHandle);
    } catch {
      samplingFailure ??= "sampling_failed";
    }
  }
  if (sampleInFlight !== null) await sampleInFlight;

  try {
    after = await measureR7FilesystemRoot(binding, {
      maximumDirectoryEntries,
      allowedTransientSymlinkNames,
      allowTransientOwnedHardlinks,
    }, deps);
    highWater = preferredHighWater(highWater, after);
    sampleCount += 1;
  } catch (error) {
    samplingFailure ??= classify(error);
  }

  const finishedAtNs = monotonic(deps);
  if (finishedAtNs >= deadlineNs) deadlineExceeded = true;
  const outcome = samplingFailure
    ?? (deadlineExceeded ? "deadline_exceeded" : null)
    ?? (operationFailed ? "operation_failed" : "completed");
  return fixedResult({
    outcome,
    measurements: { before, highWater, after },
    sampleCount,
    periodicSampleCount,
    elapsedMs: elapsedMilliseconds(startedAtNs, finishedAtNs),
  });
}
