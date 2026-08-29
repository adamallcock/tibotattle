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
//                                                [--codex-home <dir>]
//
// This command publishes a rebuilt index atomically. It has no dry-run mode;
// unknown and duplicate options fail before any source or destination is opened.

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
import { parseRebuildLocalUnifiedIndexOptions } from "./rebuild-local-unified-index-options.mjs";

const {
  indexFile,
  codexHome,
  workers,
} = parseRebuildLocalUnifiedIndexOptions(process.argv.slice(2), {
  defaultIndexFile: defaultLocalUnifiedIndexPath(),
  defaultCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  defaultWorkers: defaultRebuildWorkerCount(),
});

let peakRss = 0;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 250);
sample.unref?.();

const result = await rebuildLocalUnifiedIndex({
  codexHome,
  indexFile,
  contractVersion: TELEMETRY_SCHEMA_VERSION,
  workerCount: workers,
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
