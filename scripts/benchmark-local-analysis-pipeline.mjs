import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import {
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";

function options(argv) {
  const result = {
    codexHome: null,
    stateDirectory: null,
    endAt: null,
    workers: 10,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} needs a value`);
    if (name === "--codex-home") result.codexHome = resolve(value);
    else if (name === "--state") result.stateDirectory = resolve(value);
    else if (name === "--end-at") result.endAt = value;
    else if (name === "--workers") result.workers = Number(value);
    else throw new TypeError(`Unknown option: ${name}`);
  }
  if (result.codexHome === null
      || result.stateDirectory === null
      || !Number.isFinite(Date.parse(result.endAt))
      || !Number.isSafeInteger(result.workers)
      || result.workers < 1
      || result.workers > 10) {
    throw new TypeError(
      "Required: --codex-home PATH --state EMPTY_DIR "
      + "--end-at ISO [--workers 1..10]",
    );
  }
  return result;
}

const selected = options(process.argv.slice(2));
await mkdir(selected.stateDirectory, { recursive: true, mode: 0o700 });
if ((await readdir(selected.stateDirectory)).length !== 0) {
  throw new Error("Benchmark state directory must be empty");
}

const cacheFile = join(
  selected.stateDirectory,
  "local-replay-safe-accounting-v0.1.json",
);
const indexFile = join(
  selected.stateDirectory,
  "local-analysis-index-v2.sqlite",
);
const secretFile = join(
  selected.stateDirectory,
  "local-analysis-index-secret-v2",
);
const fixedEndMs = Date.parse(selected.endAt);
const startedAt = performance.now();
const cache = await refreshReplaySafeAccountingCache({
  cacheFile,
  indexFile,
  indexSecretFile: secretFile,
  codexHome: selected.codexHome,
  now: () => fixedEndMs,
  indexWorkerCount: selected.workers,
});
const index = await inspectLocalAnalysisIndex({ indexFile });
const all = cache.periods.find((period) => period.id === "all");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "local-analysis-performance-receipt-v1",
  node: process.version,
  elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
  workers: selected.workers,
  coveredAt: index.coveredAt,
  sourceCount: index.sourceCount,
  sourceBytes: index.lastScan.bytes,
  indexBytes: index.indexBytes,
  indexWallMs: index.lastScan.wallMs,
  phaseWallMs: index.lastScan.phases,
  accounting: {
    events: all.events,
    totalTokens: all.totalTokens,
    apiPriceEquivalentUsd: all.apiPriceEquivalentUsd,
    weeklyStatus: cache.weeklyCalibration.status,
  },
  diagnostics: cache.diagnostics,
  privacy: index.privacy,
})}\n`);
