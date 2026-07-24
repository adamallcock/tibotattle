export const EXPORT_RESOURCE_POLICY_VERSION = "g1-r3-candidate-0.3";

export const DEFAULT_EXPORT_RESOURCE_LIMITS = Object.freeze({
  maximumCoveredDurationMs: 31 * 24 * 60 * 60 * 1_000,
  maximumDirectoryEntries: 20_000,
  maximumSourceFiles: 5_000,
  maximumSourceBytes: 32 * 1024 * 1024 * 1024,
  maximumLineBytes: 16 * 1024 * 1024,
  maximumOutputRecords: 100_000,
  maximumExpandedRecordBytes: 32 * 1024 * 1024,
  maximumCanonicalBundleBytes: 32 * 1024 * 1024,
  maximumExportSetRecords: 2_000_000,
  maximumExportSetExpandedRecordBytes: 2 * 1024 * 1024 * 1024,
  maximumWorkspaceBytes: 4 * 1024 * 1024 * 1024,
  maximumSqliteBatchRecords: 1_000,
  maximumManifestBytes: 1024 * 1024,
  maximumChunks: 512,
  maximumElapsedMs: 10 * 60 * 1_000,
  maximumRssBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
});

const SAFE_CODES = new Set([
  "covered_duration",
  "source_files",
  "source_bytes",
  "line_bytes",
  "output_records",
  "expanded_record_bytes",
  "canonical_bundle_bytes",
  "workspace_bytes",
  "manifest_bytes",
  "chunk_count",
  "elapsed_time",
  "rss",
]);

export class ExportResourceLimitError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export resource failure code");
    super(`Local export stopped at the ${code} resource limit`);
    this.name = "ExportResourceLimitError";
    this.code = `export_resource_${code}`;
  }
}

function boundedInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
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
  clock = () => Date.now(),
  rss = () => process.memoryUsage().rss,
  scope = "single_bundle",
} = {}) {
  if (scope !== "single_bundle" && scope !== "export_set") {
    throw new TypeError("Export resource scope must be single_bundle or export_set");
  }
  const limits = normalizeExportResourceLimits(limitOverrides);
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) throw new TypeError("Export resource clock must return a finite timestamp");
  const counters = {
    sourceFiles: 0,
    sourceBytes: 0,
    directoryEntries: 0,
    lines: 0,
    oversizedIrrelevantLines: 0,
    outputRecords: 0,
    expandedRecordBytes: 0,
    canonicalBundleBytes: 0,
    workspaceBytes: 0,
    manifestBytes: 0,
  };

  function checkRuntime() {
    const elapsed = clock() - startedAtMs;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > limits.maximumElapsedMs) {
      throw new ExportResourceLimitError("elapsed_time");
    }
    const currentRss = rss();
    if (!Number.isFinite(currentRss) || currentRss < 0 || currentRss > limits.maximumRssBytes) {
      throw new ExportResourceLimitError("rss");
    }
  }

  return {
    policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
    limits,
    counters,
    assertCoveredInterval(startMs, endMs) {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs
          || endMs - startMs > limits.maximumCoveredDurationMs) {
        throw new ExportResourceLimitError("covered_duration");
      }
      checkRuntime();
    },
    observeSourcePlan(fileCount, byteCount) {
      boundedInteger(fileCount, "source file count", { allowZero: true });
      boundedInteger(byteCount, "source byte count", { allowZero: true });
      counters.sourceFiles = fileCount;
      counters.sourceBytes = byteCount;
      if (fileCount > limits.maximumSourceFiles) throw new ExportResourceLimitError("source_files");
      if (byteCount > limits.maximumSourceBytes) throw new ExportResourceLimitError("source_bytes");
      checkRuntime();
    },
    observeDirectoryEntry() {
      counters.directoryEntries += 1;
      if (counters.directoryEntries > limits.maximumDirectoryEntries) {
        throw new ExportResourceLimitError("source_files");
      }
      checkRuntime();
    },
    observeSourceFile(byteCount) {
      boundedInteger(byteCount, "source file byte count", { allowZero: true });
      counters.sourceFiles += 1;
      counters.sourceBytes += byteCount;
      if (counters.sourceFiles > limits.maximumSourceFiles) throw new ExportResourceLimitError("source_files");
      if (counters.sourceBytes > limits.maximumSourceBytes) throw new ExportResourceLimitError("source_bytes");
      checkRuntime();
    },
    observeLine(byteCount, { oversizedIrrelevant = false } = {}) {
      boundedInteger(byteCount, "line byte count", { allowZero: true });
      if (byteCount > limits.maximumLineBytes && !oversizedIrrelevant) {
        throw new ExportResourceLimitError("line_bytes");
      }
      counters.lines += 1;
      if (oversizedIrrelevant) counters.oversizedIrrelevantLines += 1;
      checkRuntime();
    },
    observeOutputRecord(byteCount) {
      boundedInteger(byteCount, "record byte count", { allowZero: true });
      counters.outputRecords += 1;
      counters.expandedRecordBytes += byteCount;
      const maximumRecords = scope === "export_set"
        ? limits.maximumExportSetRecords
        : limits.maximumOutputRecords;
      const maximumBytes = scope === "export_set"
        ? limits.maximumExportSetExpandedRecordBytes
        : limits.maximumExpandedRecordBytes;
      if (counters.outputRecords > maximumRecords) {
        throw new ExportResourceLimitError("output_records");
      }
      if (counters.expandedRecordBytes > maximumBytes) {
        throw new ExportResourceLimitError("expanded_record_bytes");
      }
      checkRuntime();
    },
    observeOutputTotals(recordCount, byteCount) {
      boundedInteger(recordCount, "record count", { allowZero: true });
      boundedInteger(byteCount, "record byte count", { allowZero: true });
      counters.outputRecords = recordCount;
      counters.expandedRecordBytes = byteCount;
      const maximumRecords = scope === "export_set"
        ? limits.maximumExportSetRecords
        : limits.maximumOutputRecords;
      const maximumBytes = scope === "export_set"
        ? limits.maximumExportSetExpandedRecordBytes
        : limits.maximumExpandedRecordBytes;
      if (recordCount > maximumRecords) throw new ExportResourceLimitError("output_records");
      if (byteCount > maximumBytes) throw new ExportResourceLimitError("expanded_record_bytes");
      checkRuntime();
    },
    observeCanonicalBundle(byteCount) {
      boundedInteger(byteCount, "canonical bundle byte count");
      counters.canonicalBundleBytes = byteCount;
      if (byteCount > limits.maximumCanonicalBundleBytes) {
        throw new ExportResourceLimitError("canonical_bundle_bytes");
      }
      checkRuntime();
    },
    observeWorkspace(byteCount) {
      boundedInteger(byteCount, "workspace byte count", { allowZero: true });
      counters.workspaceBytes = byteCount;
      if (byteCount > limits.maximumWorkspaceBytes) throw new ExportResourceLimitError("workspace_bytes");
      checkRuntime();
    },
    observeManifest(byteCount) {
      boundedInteger(byteCount, "manifest byte count");
      counters.manifestBytes = byteCount;
      if (byteCount > limits.maximumManifestBytes) throw new ExportResourceLimitError("manifest_bytes");
      checkRuntime();
    },
    observeChunkCount(count) {
      boundedInteger(count, "chunk count", { allowZero: true });
      if (count > limits.maximumChunks) throw new ExportResourceLimitError("chunk_count");
      checkRuntime();
    },
    checkRuntime,
    snapshot() {
      checkRuntime();
      return {
        policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
        scope,
        limits: { ...limits },
        counters: { ...counters },
        elapsedMs: clock() - startedAtMs,
      };
    },
  };
}
