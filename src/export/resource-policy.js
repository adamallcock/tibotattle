export const EXPORT_RESOURCE_POLICY_VERSION = "g1-r3-candidate-0.5";

export const DEFAULT_EXPORT_RESOURCE_LIMITS = Object.freeze({
  maximumCoveredDurationMs: 31 * 24 * 60 * 60 * 1_000,
  maximumDirectoryEntries: 100_000,
  maximumSourceFiles: 100_000,
  maximumSourceBytes: 32 * 1024 * 1024 * 1024,
  maximumLineBytes: 16 * 1024 * 1024,
  maximumOutputRecords: 100_000,
  maximumExpandedRecordBytes: 32 * 1024 * 1024,
  maximumCanonicalBundleBytes: 32 * 1024 * 1024,
  maximumEncodedArtifactBytes: 34 * 1024 * 1024,
  maximumExportSetRecords: 2_000_000,
  maximumExportSetExpandedRecordBytes: 2 * 1024 * 1024 * 1024,
  maximumExportSetDecodedBytes: 4 * 1024 * 1024 * 1024,
  maximumExportSetEncodedBytes: 4 * 1024 * 1024 * 1024,
  maximumWorkspaceBytes: 4 * 1024 * 1024 * 1024,
  maximumSqliteBatchRecords: 1_000,
  maximumManifestBytes: 1024 * 1024,
  maximumChunks: 512,
  maximumElapsedMs: 10 * 60 * 1_000,
  maximumRssBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
});

const SAFE_CODES = new Set([
  "covered_duration",
  "directory_entries",
  "source_files",
  "source_bytes",
  "line_bytes",
  "output_records",
  "expanded_record_bytes",
  "canonical_bundle_bytes",
  "encoded_artifact_bytes",
  "export_set_decoded_bytes",
  "export_set_encoded_bytes",
  "workspace_bytes",
  "manifest_bytes",
  "chunk_count",
  "elapsed_time",
  "rss",
]);

/**
 * The complete, closed vocabulary of `error.code` values this policy can raise.
 * Downstream allowlists derive their membership test from this rather than
 * restating it, so a new bound cannot be added here and silently fail to be
 * relayable by the surfaces that report it.
 */
export const EXPORT_RESOURCE_FAILURE_CODES = Object.freeze(
  [...SAFE_CODES].map((code) => `export_resource_${code}`).sort(),
);

const TRUSTED_RESOURCE_LIMIT_ERRORS = new WeakSet();

function measurement(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Export resource ${name} must be a non-negative safe integer`);
  }
  return value;
}

export class ExportResourceLimitError extends Error {
  constructor(code, { observed = null, limit = null } = {}) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export resource failure code");
    super(`Local export stopped at the ${code} resource limit`);
    this.name = "ExportResourceLimitError";
    this.code = `export_resource_${code}`;
    // The bare code and the two counts are the whole of what this error knows.
    // No path, no source content, and no identifier can reach them, so a
    // caller may relay them into a diagnostics receipt verbatim.
    this.resourceCode = code;
    this.observed = measurement(observed, "observed value");
    this.limit = measurement(limit, "limit");
    if (new.target === ExportResourceLimitError) TRUSTED_RESOURCE_LIMIT_ERRORS.add(this);
  }

  static isTrustedExact(error) {
    return Boolean(error && TRUSTED_RESOURCE_LIMIT_ERRORS.has(error)
      && Object.getPrototypeOf(error) === ExportResourceLimitError.prototype);
  }
}

Object.defineProperty(ExportResourceLimitError, "isTrustedExact", {
  ...Object.getOwnPropertyDescriptor(ExportResourceLimitError, "isTrustedExact"),
  writable: false,
  configurable: false,
});

/**
 * Every bound in this module is a comparison of one count against one ceiling.
 * Raising the failure through here keeps both numbers attached to the code.
 *
 * `observed` is the counter's value at the moment the bound was crossed, not
 * the total the run would eventually have reached: an accumulating counter
 * stops on its first increment past the ceiling, so the two numbers are
 * normally close together however far over the whole selection would have gone.
 * They identify the bound and prove the crossing; they do not size the overage.
 */
function exceeded(code, observed, limit) {
  return new ExportResourceLimitError(code, { observed, limit });
}

function boundedInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

const DURABLE_USAGE_KEYS = Object.freeze([
  "policyVersion",
  "sourceFiles",
  "sourceBytes",
  "directoryEntries",
  "lines",
  "oversizedIrrelevantLines",
  "outputRecords",
  "expandedRecordBytes",
  "cumulativeElapsedMs",
  "peakRssBytes",
  "workspaceHighWaterBytes",
  "recoveryReservations",
]);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function outputLimitsForScope(limits, scope) {
  return scope === "export_set"
    ? {
      maximumRecords: limits.maximumExportSetRecords,
      maximumBytes: limits.maximumExportSetExpandedRecordBytes,
    }
    : {
      maximumRecords: limits.maximumOutputRecords,
      maximumBytes: limits.maximumExpandedRecordBytes,
    };
}

/**
 * Validate the compact, privacy-safe resource state persisted by an export
 * workspace.  This deliberately has the same shape as workspace.resourceUsage().
 * Stable selection gauges, additive work totals, and high-water values remain
 * distinct so a resumed run cannot make previous work disappear.
 */
function normalizeInitialUsage(value, limits, scope) {
  if (value === undefined || value === null) {
    return Object.fromEntries(DURABLE_USAGE_KEYS.map((key) => [
      key,
      key === "policyVersion" ? EXPORT_RESOURCE_POLICY_VERSION : 0,
    ]));
  }
  if (!exactKeys(value, DURABLE_USAGE_KEYS)) {
    throw new TypeError("Initial export resource usage must have the exact durable usage shape");
  }
  if (value.policyVersion !== EXPORT_RESOURCE_POLICY_VERSION) {
    throw new TypeError("Initial export resource usage policy version does not match");
  }
  const normalized = { policyVersion: EXPORT_RESOURCE_POLICY_VERSION };
  for (const key of DURABLE_USAGE_KEYS) {
    if (key === "policyVersion") continue;
    normalized[key] = boundedInteger(value[key], `initial usage ${key}`, { allowZero: true });
  }
  if (normalized.oversizedIrrelevantLines > normalized.lines) {
    throw new TypeError("Initial oversized irrelevant line count cannot exceed line count");
  }
  const { maximumRecords, maximumBytes } = outputLimitsForScope(limits, scope);
  if (normalized.sourceFiles > limits.maximumSourceFiles) {
    throw exceeded("source_files", normalized.sourceFiles, limits.maximumSourceFiles);
  }
  if (normalized.sourceBytes > limits.maximumSourceBytes) {
    throw exceeded("source_bytes", normalized.sourceBytes, limits.maximumSourceBytes);
  }
  if (normalized.directoryEntries > limits.maximumDirectoryEntries) {
    throw exceeded("directory_entries", normalized.directoryEntries, limits.maximumDirectoryEntries);
  }
  if (normalized.outputRecords > maximumRecords) {
    throw exceeded("output_records", normalized.outputRecords, maximumRecords);
  }
  if (normalized.expandedRecordBytes > maximumBytes) {
    throw exceeded("expanded_record_bytes", normalized.expandedRecordBytes, maximumBytes);
  }
  if (normalized.cumulativeElapsedMs > limits.maximumElapsedMs) {
    throw exceeded("elapsed_time", normalized.cumulativeElapsedMs, limits.maximumElapsedMs);
  }
  if (normalized.peakRssBytes > limits.maximumRssBytes) {
    throw exceeded("rss", normalized.peakRssBytes, limits.maximumRssBytes);
  }
  if (normalized.workspaceHighWaterBytes > limits.maximumWorkspaceBytes) {
    throw exceeded("workspace_bytes", normalized.workspaceHighWaterBytes, limits.maximumWorkspaceBytes);
  }
  return normalized;
}

export function normalizeExportResourceLimits(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Export resource limits must be an object");
  }
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(DEFAULT_EXPORT_RESOURCE_LIMITS, key));
  if (unknown.length > 0) throw new TypeError("Unknown export resource limit");
  const limits = { ...DEFAULT_EXPORT_RESOURCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    boundedInteger(value, name);
    if (value > DEFAULT_EXPORT_RESOURCE_LIMITS[name]) {
      throw new TypeError(`${name} cannot exceed the compatibility-bound candidate ceiling`);
    }
  }
  return Object.freeze(limits);
}

export function createExportResourceGuard({
  limits: limitOverrides = {},
  clock,
  rss,
  scope = "single_bundle",
  initialUsage = undefined,
} = {}) {
  if (scope !== "single_bundle" && scope !== "export_set") {
    throw new TypeError("Export resource scope must be single_bundle or export_set");
  }
  if (typeof clock !== "function") {
    throw new TypeError("Export resource clock must be a function");
  }
  if (typeof rss !== "function") {
    throw new TypeError("Export resource RSS reader must be a function");
  }
  const limits = normalizeExportResourceLimits(limitOverrides);
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) throw new TypeError("Export resource clock must return a finite timestamp");
  const initial = normalizeInitialUsage(initialUsage, limits, scope);
  const outputLimits = outputLimitsForScope(limits, scope);
  const counters = {
    sourceFiles: initial.sourceFiles,
    sourceBytes: initial.sourceBytes,
    directoryEntries: initial.directoryEntries,
    lines: initial.lines,
    oversizedIrrelevantLines: initial.oversizedIrrelevantLines,
    outputRecords: initial.outputRecords,
    expandedRecordBytes: initial.expandedRecordBytes,
    canonicalBundleBytes: 0,
    encodedArtifactBytes: 0,
    exportSetDecodedBytes: 0,
    exportSetEncodedBytes: 0,
    workspaceBytes: initial.workspaceHighWaterBytes,
    manifestBytes: 0,
  };
  let peakRssBytes = initial.peakRssBytes;
  let workspaceHighWaterBytes = initial.workspaceHighWaterBytes;
  let recoveryReservations = initial.recoveryReservations;
  // A supplied durable snapshot means the selection was already frozen.  A
  // subsequent source plan must match it exactly rather than being added again.
  let sourcePlanObserved = initialUsage !== undefined && initialUsage !== null;

  function activeElapsedMs() {
    const elapsed = clock() - startedAtMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new ExportResourceLimitError("elapsed_time");
    return Math.ceil(elapsed);
  }

  function cumulativeElapsedMs() {
    return initial.cumulativeElapsedMs + activeElapsedMs();
  }

  function checkRuntime() {
    const elapsed = cumulativeElapsedMs();
    if (elapsed > limits.maximumElapsedMs) {
      throw exceeded("elapsed_time", elapsed, limits.maximumElapsedMs);
    }
    const currentRss = rss();
    if (!Number.isFinite(currentRss) || currentRss < 0) throw new ExportResourceLimitError("rss");
    if (currentRss > limits.maximumRssBytes) {
      const observed = Math.ceil(currentRss);
      // An unrepresentable reading still stops the run; it just cannot say how far over.
      throw Number.isSafeInteger(observed)
        ? exceeded("rss", observed, limits.maximumRssBytes)
        : new ExportResourceLimitError("rss");
    }
    peakRssBytes = Math.max(peakRssBytes, Math.ceil(currentRss));
  }

  function assertSourceSelection(fileCount, byteCount) {
    boundedInteger(fileCount, "source file count", { allowZero: true });
    boundedInteger(byteCount, "source byte count", { allowZero: true });
    if (fileCount > limits.maximumSourceFiles) {
      throw exceeded("source_files", fileCount, limits.maximumSourceFiles);
    }
    if (byteCount > limits.maximumSourceBytes) {
      throw exceeded("source_bytes", byteCount, limits.maximumSourceBytes);
    }
    checkRuntime();
  }

  return {
    policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
    limits,
    counters,
    assertCoveredInterval(startMs, endMs) {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        throw new ExportResourceLimitError("covered_duration");
      }
      const durationMs = endMs - startMs;
      if (durationMs > limits.maximumCoveredDurationMs) {
        throw Number.isSafeInteger(durationMs)
          ? exceeded("covered_duration", durationMs, limits.maximumCoveredDurationMs)
          : new ExportResourceLimitError("covered_duration");
      }
      checkRuntime();
    },
    assertSourceSelection,
    observeSourcePlan(fileCount, byteCount) {
      boundedInteger(fileCount, "source file count", { allowZero: true });
      boundedInteger(byteCount, "source byte count", { allowZero: true });
      if (sourcePlanObserved && (fileCount !== counters.sourceFiles || byteCount !== counters.sourceBytes)) {
        throw new TypeError("Export source plan does not match the durable selection totals");
      }
      assertSourceSelection(fileCount, byteCount);
      counters.sourceFiles = fileCount;
      counters.sourceBytes = byteCount;
      sourcePlanObserved = true;
    },
    observeDirectoryEntry() {
      counters.directoryEntries += 1;
      if (counters.directoryEntries > limits.maximumDirectoryEntries) {
        throw exceeded("directory_entries", counters.directoryEntries, limits.maximumDirectoryEntries);
      }
      checkRuntime();
    },
    observeSourceFile(byteCount) {
      boundedInteger(byteCount, "source file byte count", { allowZero: true });
      // Source discovery is a transient pass.  Once a workspace has a frozen
      // selection, re-discovery verifies that selection but must not consume it
      // a second time on every restart.
      if (sourcePlanObserved) {
        checkRuntime();
        return;
      }
      counters.sourceFiles += 1;
      counters.sourceBytes += byteCount;
      if (counters.sourceFiles > limits.maximumSourceFiles) {
        throw exceeded("source_files", counters.sourceFiles, limits.maximumSourceFiles);
      }
      if (counters.sourceBytes > limits.maximumSourceBytes) {
        throw exceeded("source_bytes", counters.sourceBytes, limits.maximumSourceBytes);
      }
      checkRuntime();
    },
    observeLine(byteCount, { oversizedIrrelevant = false } = {}) {
      boundedInteger(byteCount, "line byte count", { allowZero: true });
      if (byteCount > limits.maximumLineBytes && !oversizedIrrelevant) {
        throw exceeded("line_bytes", byteCount, limits.maximumLineBytes);
      }
      counters.lines += 1;
      if (oversizedIrrelevant) counters.oversizedIrrelevantLines += 1;
      checkRuntime();
    },
    observeOutputRecord(byteCount) {
      boundedInteger(byteCount, "record byte count", { allowZero: true });
      counters.outputRecords += 1;
      counters.expandedRecordBytes += byteCount;
      if (counters.outputRecords > outputLimits.maximumRecords) {
        throw exceeded("output_records", counters.outputRecords, outputLimits.maximumRecords);
      }
      if (counters.expandedRecordBytes > outputLimits.maximumBytes) {
        throw exceeded("expanded_record_bytes", counters.expandedRecordBytes, outputLimits.maximumBytes);
      }
      checkRuntime();
    },
    observeOutputTotals(recordCount, byteCount) {
      boundedInteger(recordCount, "record count", { allowZero: true });
      boundedInteger(byteCount, "record byte count", { allowZero: true });
      if (recordCount < initial.outputRecords || byteCount < initial.expandedRecordBytes) {
        throw new TypeError("Durable output totals cannot decrease on resume");
      }
      counters.outputRecords = recordCount;
      counters.expandedRecordBytes = byteCount;
      if (recordCount > outputLimits.maximumRecords) {
        throw exceeded("output_records", recordCount, outputLimits.maximumRecords);
      }
      if (byteCount > outputLimits.maximumBytes) {
        throw exceeded("expanded_record_bytes", byteCount, outputLimits.maximumBytes);
      }
      checkRuntime();
    },
    observeCanonicalBundle(byteCount) {
      boundedInteger(byteCount, "canonical bundle byte count");
      counters.canonicalBundleBytes = byteCount;
      if (byteCount > limits.maximumCanonicalBundleBytes) {
        throw exceeded("canonical_bundle_bytes", byteCount, limits.maximumCanonicalBundleBytes);
      }
      checkRuntime();
    },
    observeEncodedArtifact(byteCount) {
      boundedInteger(byteCount, "encoded artifact byte count");
      counters.encodedArtifactBytes = byteCount;
      if (byteCount > limits.maximumEncodedArtifactBytes) {
        throw exceeded("encoded_artifact_bytes", byteCount, limits.maximumEncodedArtifactBytes);
      }
      checkRuntime();
    },
    observeExportSetBytes(decodedByteCount, encodedByteCount) {
      boundedInteger(decodedByteCount, "export-set decoded byte count", { allowZero: true });
      boundedInteger(encodedByteCount, "export-set encoded byte count", { allowZero: true });
      counters.exportSetDecodedBytes = decodedByteCount;
      counters.exportSetEncodedBytes = encodedByteCount;
      if (decodedByteCount > limits.maximumExportSetDecodedBytes) {
        throw exceeded("export_set_decoded_bytes", decodedByteCount, limits.maximumExportSetDecodedBytes);
      }
      if (encodedByteCount > limits.maximumExportSetEncodedBytes) {
        throw exceeded("export_set_encoded_bytes", encodedByteCount, limits.maximumExportSetEncodedBytes);
      }
      checkRuntime();
    },
    observeWorkspace(byteCount) {
      boundedInteger(byteCount, "workspace byte count", { allowZero: true });
      workspaceHighWaterBytes = Math.max(workspaceHighWaterBytes, byteCount);
      counters.workspaceBytes = workspaceHighWaterBytes;
      if (workspaceHighWaterBytes > limits.maximumWorkspaceBytes) {
        throw exceeded("workspace_bytes", workspaceHighWaterBytes, limits.maximumWorkspaceBytes);
      }
      checkRuntime();
    },
    reserveRecovery(count = 1) {
      boundedInteger(count, "recovery reservation count", { allowZero: true });
      if (recoveryReservations > Number.MAX_SAFE_INTEGER - count) {
        throw new TypeError("Recovery reservation count exceeds safe integer range");
      }
      recoveryReservations += count;
      checkRuntime();
    },
    observeManifest(byteCount) {
      boundedInteger(byteCount, "manifest byte count");
      counters.manifestBytes = byteCount;
      if (byteCount > limits.maximumManifestBytes) {
        throw exceeded("manifest_bytes", byteCount, limits.maximumManifestBytes);
      }
      checkRuntime();
    },
    observeChunkCount(count) {
      boundedInteger(count, "chunk count", { allowZero: true });
      if (count > limits.maximumChunks) throw exceeded("chunk_count", count, limits.maximumChunks);
      checkRuntime();
    },
    checkRuntime,
    /**
     * Return the exact durable state for workspace.resourceUsage().  Source
     * gauges are fixed selection totals; directory/line/output/elapsed and
     * recovery values are cumulative; RSS and workspace values are high-water
     * maxima.  It is intentionally an absolute snapshot, never an ambiguous
     * mixture of deltas and totals.
     */
    durableSnapshot() {
      checkRuntime();
      return {
        policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
        sourceFiles: counters.sourceFiles,
        sourceBytes: counters.sourceBytes,
        directoryEntries: counters.directoryEntries,
        lines: counters.lines,
        oversizedIrrelevantLines: counters.oversizedIrrelevantLines,
        outputRecords: counters.outputRecords,
        expandedRecordBytes: counters.expandedRecordBytes,
        cumulativeElapsedMs: cumulativeElapsedMs(),
        peakRssBytes,
        workspaceHighWaterBytes,
        recoveryReservations,
      };
    },
    snapshot() {
      const durable = this.durableSnapshot();
      return {
        policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
        scope,
        limits: { ...limits },
        counters: { ...counters },
        // Preserve the original public meaning: active time in this process.
        elapsedMs: activeElapsedMs(),
        cumulativeElapsedMs: durable.cumulativeElapsedMs,
        peakRssBytes: durable.peakRssBytes,
        workspaceHighWaterBytes: durable.workspaceHighWaterBytes,
      };
    },
  };
}
