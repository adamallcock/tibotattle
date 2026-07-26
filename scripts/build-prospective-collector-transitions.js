#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedUtf8LineEntries } from "../src/bounded-jsonl.js";
import { buildProspectiveCollectorTransitions } from "../src/prospective-collector-transitions.js";
import { priceCodexUsageEvent } from "../src/local-api-pricing.js";
import { writeJsonOwnerOnlyAtomic } from "../src/storage.js";

const MAXIMUM_SOURCE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_SOURCE_LINES = 300_000;
const MAXIMUM_LINE_BYTES = 1024 * 1024;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function fixedFailure(error) {
  if (error?.code === "ENOENT") return "prospective source is missing";
  if (error?.code === "EACCES") return "prospective source is unavailable";
  return error instanceof Error && /^prospective /u.test(error.message)
    ? error.message
    : "prospective transition build failed";
}

function assertOwnerOnlySourceStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("prospective source must be a single-link regular file");
  }
  if (stats.size > MAXIMUM_SOURCE_BYTES) {
    throw new Error("prospective source exceeds the bounded size policy");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("prospective source must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("prospective source must be owner-only");
  }
}

async function openOwnerOnlySource(path) {
  const pathStats = await lstat(path);
  assertOwnerOnlySourceStats(pathStats);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptorStats = await handle.stat();
    assertOwnerOnlySourceStats(descriptorStats);
    if (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) {
      throw new Error("prospective source changed while it was being opened");
    }
    return { handle, stats: descriptorStats };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readCollectorRecords(path) {
  const source = await openOwnerOnlySource(path);
  const records = [];
  let lineCount = 0;
  try {
    for await (const entry of readBoundedUtf8LineEntries(source.handle, {
      maximumLineBytes: MAXIMUM_LINE_BYTES,
      maximumTotalBytes: source.stats.size,
      highWaterMark: 256 * 1024,
    })) {
      lineCount += 1;
      if (lineCount > MAXIMUM_SOURCE_LINES) {
        throw new Error("prospective source exceeds the bounded line policy");
      }
      const { line } = entry;
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // The pure builder records malformed safe objects; malformed JSON
        // cannot safely be represented and is counted without retaining text.
        records.push(null);
      }
    }
    const after = await source.handle.stat();
    assertOwnerOnlySourceStats(after);
    if (after.dev !== source.stats.dev
        || after.ino !== source.stats.ino
        || after.size !== source.stats.size
        || after.mtimeMs !== source.stats.mtimeMs
        || after.ctimeMs !== source.stats.ctimeMs) {
      throw new Error("prospective source changed while it was being read");
    }
  } finally {
    await source.handle.close();
  }
  return records;
}

function standardApiPriceEquivalent(record) {
  const priced = priceCodexUsageEvent({
    ...record,
    timestamp: record.observedAt,
  }, {
    apiServiceTier: "standard",
  });
  if (priced.coverageStatus !== "fully_priced") return Number.NaN;
  const value = Number(priced.totalUsd);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

async function main() {
  const inputFile = resolve(option(
    "--input",
    ".usage-monitor/collector-events.jsonl",
  ));
  const outputFile = resolve(option(
    "--output",
    ".usage-monitor/prospective-account-transitions-v0.1.json",
  ));
  const records = await readCollectorRecords(inputFile);
  const result = buildProspectiveCollectorTransitions(records, {
    priceUsage: standardApiPriceEquivalent,
  });
  await writeJsonOwnerOnlyAtomic(outputFile, {
    ...result,
    materializedAt: result.scope.endAt,
    priceBasis: "standard_api_price_equivalent_current_registry",
  });
  process.stdout.write(
    `Built ${result.transitions.length} account-partitioned prospective transitions`
      + ` from ${result.diagnostics.eligibleRecords} eligible safe records.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${fixedFailure(error)}\n`);
  process.exitCode = 1;
});
