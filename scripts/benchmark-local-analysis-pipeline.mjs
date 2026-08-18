import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import {
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import {
  deriveSupportedAccountingWindow,
  LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT,
  LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT,
} from "./benchmark-local-index-retirement.mjs";

function options(argv) {
  const result = {
    codexHome: null,
    stateDirectory: null,
    startAt: LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT,
    endAt: LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT,
    workers: 1,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} needs a value`);
    if (name === "--codex-home") result.codexHome = resolve(value);
    else if (name === "--state") result.stateDirectory = resolve(value);
    else if (name === "--start-at") result.startAt = value;
    else if (name === "--end-at") result.endAt = value;
    else if (name === "--workers") result.workers = Number(value);
    else throw new TypeError(`Unknown option: ${name}`);
  }
  if (result.codexHome === null
      || result.stateDirectory === null
      || !Number.isSafeInteger(result.workers)
      || result.workers < 1
      || result.workers > 10) {
    throw new TypeError(
      "Required: --codex-home PATH --state EMPTY_DIR "
      + "[--start-at ISO] --end-at ISO [--workers 1..10]",
    );
  }
  result.accountingWindow = deriveSupportedAccountingWindow(
    result.startAt,
    result.endAt,
  );
  return result;
}

function normalizeLegacyRefreshResult(result) {
  if (result?.status === "accounting_rebuild_deferred") {
    throw new Error("legacy_accounting_refresh_deferred");
  }
  const cache = result?.cache ?? result;
  if (cache === null || typeof cache !== "object"
      || Array.isArray(cache) || !Array.isArray(cache.periods)) {
    throw new Error("legacy_accounting_cache_invalid");
  }
  if (cache.sourceDescriptor?.mode !== "legacy") {
    throw new Error("legacy_accounting_source_mode_invalid");
  }
  const all = cache.periods.find((period) => period?.id === "all");
  if (all === undefined) {
    throw new Error("legacy_accounting_cache_missing_all_period");
  }
  return { all, cache };
}

const selected = options(process.argv.slice(2));
await mkdir(selected.stateDirectory, { recursive: true, mode: 0o700 });
if ((await readdir(selected.stateDirectory)).length !== 0) {
  throw new Error("Benchmark state directory must be empty");
}

const stateFile = join(
  selected.stateDirectory,
  "local-collector-state-v1.sqlite",
);
const indexFile = join(
  selected.stateDirectory,
  "local-analysis-index-v2.sqlite",
);
const secretFile = join(
  selected.stateDirectory,
  "local-analysis-index-secret-v2",
);
const fixedEndMs = Date.parse(selected.accountingWindow.endAt);
const startedAt = performance.now();
const refreshed = await refreshReplaySafeAccountingCache({
  stateFile,
  // This retained benchmark intentionally measures the rollback pipeline.
  // Production refresh no longer infers legacy authority from old index
  // paths, so the comparison must select it explicitly.
  sourceMode: "legacy",
  indexFile,
  indexSecretFile: secretFile,
  codexHome: selected.codexHome,
  now: () => fixedEndMs,
  indexWorkerCount: selected.workers,
  windowDays: selected.accountingWindow.durationDays,
});
const { all, cache } = normalizeLegacyRefreshResult(refreshed);
const index = await inspectLocalAnalysisIndex({ indexFile });
if (index.coveredAt?.startAt !== selected.accountingWindow.startAt
    || index.coveredAt?.endAt !== selected.accountingWindow.endAt) {
  throw new Error("legacy_benchmark_window_mismatch");
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "local-analysis-performance-receipt-v2",
  node: process.version,
  elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
  workers: selected.workers,
  accountingWindow: selected.accountingWindow,
  coveredAt: index.coveredAt,
  sourceCount: index.sourceCount,
  sourceBytes: index.lastScan.bytes,
  indexBytes: index.indexBytes,
  indexWallMs: index.lastScan.wallMs,
  phaseWallMs: index.lastScan.phases,
  accounting: {
    sourceMode: cache.sourceDescriptor.mode,
    events: all.events,
    totalTokens: all.totalTokens,
    apiPriceEquivalentUsd: all.apiPriceEquivalentUsd,
    weeklyStatus: cache.weeklyCalibration.status,
  },
  diagnostics: cache.diagnostics,
  privacy: index.privacy,
})}\n`);
