#!/usr/bin/env node
// Rebuild the unified local index from the Codex rollout corpus, in one run.
//
// This is deliberately not budgeted per run. The collector's 1.5 GiB
// source-byte ceiling exists to stop a background daemon monopolising the
// machine; applied to a 78.99 GiB corpus it needs ~53 runs to reach coverage,
// which is why a complete index had never been produced. Peak memory here is a
// function of the 64 KiB bounded-line cap and the commit batch size, not of
// corpus size, so a single pass is safe.
//
// Usage:
//   node scripts/rebuild-local-unified-index.mjs [--index <file>] [--workers N]
//                                                [--codex-home <dir>] [--dry-run]

import { homedir } from "node:os";
import { join } from "node:path";

import {
  defaultRebuildWorkerCount,
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  inspectLocalUnifiedIndex,
  defaultLocalUnifiedIndexPath,
} from "../src/local-unified-index.js";
import { TELEMETRY_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";

function option(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 || at + 1 >= process.argv.length ? fallback : process.argv[at + 1];
}

const indexFile = option("index", defaultLocalUnifiedIndexPath());
const codexHome = option("codex-home", process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const workers = Number(option("workers", String(defaultRebuildWorkerCount())));

let peakRss = 0;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 250);
sample.unref?.();

const result = await rebuildLocalUnifiedIndex({
  codexHome,
  indexFile,
  contractVersion: TELEMETRY_SCHEMA_VERSION,
  workerCount: Number.isSafeInteger(workers) ? workers : 1,
  onProgress: process.stdout.isTTY
    ? (progress) => {
      process.stdout.write(
        `\r${progress.sourcesScanned}/${progress.sources} sources, `
        + `${(progress.bytesScanned / 1024 ** 3).toFixed(1)} GiB, `
        + `${progress.usageEvents} events   `,
      );
    }
    : null,
});
clearInterval(sample);
peakRss = Math.max(peakRss, process.memoryUsage.rss());
if (process.stdout.isTTY) process.stdout.write("\n");

console.log(JSON.stringify({
  ...result,
  peakRssMib: +(peakRss / 1024 ** 2).toFixed(1),
  wallSeconds: +(result.wallMs / 1000).toFixed(2),
  inspection: await inspectLocalUnifiedIndex({ indexFile }),
}, null, 2));
