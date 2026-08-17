import { createHmac, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { openClaudeDesktopIncrementalCanonicalizer } from "./claude-desktop-incremental-canonicalizer.js";
import { openClaudeDesktopLedgerPrototype } from "./claude-desktop-ledger-prototype.js";
import { readClaudeDesktopPlanHistory } from "./claude-desktop-plan-history.js";
import { inventoryClaudeDesktopSources } from "./claude-desktop-source-inventory.js";
import { runR7WorkerWatchdog } from "./r7-worker-watchdog.js";
import { createClaudeDesktopLedgerCandidate } from "./claude-desktop-incremental-refresh.js";

export const CLAUDE_DESKTOP_INCREMENTAL_BENCHMARK_VERSION =
  "claude-desktop-incremental-benchmark-v0.1";

export const CLAUDE_DESKTOP_SYNTHETIC_APPEND_BENCHMARK_VERSION =
  "claude-desktop-synthetic-scaled-append-benchmark-v0.1";

const SYNTHETIC_SESSION_ID = "synthetic-session-000000000000000000000000000000";
const SYNTHETIC_CLI_SESSION_ID = "synthetic-cli-session-000000000000000000000000";
const SYNTHETIC_MODEL = "claude-sonnet-fixture";
const SYNTHETIC_CORPUS_VERSION = "generated-claude-jsonl-v1";
const DEFAULT_SYNTHETIC_START_AT = "2026-07-24T12:00:00.000Z";
const DEFAULT_SYNTHETIC_END_AT = "2026-07-24T13:00:00.000Z";
const MAXIMUM_SYNTHETIC_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

const WORKER_PATH = fileURLToPath(new URL(
  "../scripts/claude-desktop-incremental-benchmark-worker.js", import.meta.url,
));

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function quotaSourceKey(secret, path) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-desktop-incremental-quota-source/v1\0", "utf8")
    .update(path, "utf8")
    .digest("hex");
}

function normalizeSecret(secret) {
  if (secret === undefined) return randomBytes(32);
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new TypeError("Claude Desktop incremental benchmark secret is invalid");
  }
  return Buffer.from(secret);
}

function memoryReading() {
  const value = process.memoryUsage();
  return {
    rssBytes: value.rss,
    heapUsedBytes: value.heapUsed,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function updatePeak(target, value) {
  for (const key of Object.keys(value)) target[key] = Math.max(target[key] ?? 0, value[key]);
}

async function databaseBytes(root) {
  let total = 0;
  for (const name of await readdir(root)) {
    const value = await lstat(join(root, name));
    if (value.isFile()) total += value.size;
  }
  return total;
}

function safeBenchmarkNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function syntheticTranscriptRow(ordinal, timestampMs, outputTokens = 3) {
  return {
    type: "assistant",
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: SYNTHETIC_SESSION_ID,
    isSidechain: false,
    message: {
      id: `synthetic-message-${String(ordinal).padStart(8, "0")}`,
      model: SYNTHETIC_MODEL,
      content: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 10,
        },
        output_tokens: outputTokens,
        speed: "standard",
      },
    },
  };
}

function syntheticTranscriptLine(ordinal, timestampMs, outputTokens = 3) {
  return `${JSON.stringify(syntheticTranscriptRow(ordinal, timestampMs, outputTokens))}\n`;
}

function projectSyntheticWorkerResult(result, databaseByteCount) {
  const canonical = result.canonical ?? {};
  const merge = result.merge ?? {};
  const quotaMerge = result.quotaMerge ?? {};
  const peakMemory = result.peakMemory ?? {};
  return {
    status: result.status,
    elapsedMs: safeBenchmarkNumber(result.elapsedMs),
    inventoryMs: safeBenchmarkNumber(result.inventoryMs),
    canonicalizationMs: safeBenchmarkNumber(result.canonicalizationMs),
    canonical: {
      sourceCount: safeBenchmarkNumber(canonical.sourceCount),
      unchangedSources: safeBenchmarkNumber(canonical.unchangedSources),
      appendedSources: safeBenchmarkNumber(canonical.appendedSources),
      rebuiltSources: safeBenchmarkNumber(canonical.rebuiltSources),
      missingSources: safeBenchmarkNumber(canonical.missingSources),
      parsedBytes: safeBenchmarkNumber(canonical.parsedBytes),
      observedSourceBytes: safeBenchmarkNumber(canonical.observedSourceBytes),
      parsedLines: safeBenchmarkNumber(canonical.parsedLines),
      assistantOccurrences: safeBenchmarkNumber(canonical.assistantOccurrences),
      dirtyGroupCount: safeBenchmarkNumber(canonical.dirtyGroupCount),
      candidateCount: safeBenchmarkNumber(canonical.candidateCount),
    },
    merge: {
      inserted: safeBenchmarkNumber(merge.inserted),
      superseded: safeBenchmarkNumber(merge.superseded),
      tombstoned: safeBenchmarkNumber(merge.tombstoned),
    },
    quotaMerge: {
      inserted: safeBenchmarkNumber(quotaMerge.inserted),
      duplicates: safeBenchmarkNumber(quotaMerge.duplicates),
      superseded: safeBenchmarkNumber(quotaMerge.superseded),
    },
    projectionPublished: result.projection !== null && result.projection !== undefined,
    projectionGeneration: result.projection?.generation ?? null,
    pricing: result.pricingSummary ? {
      eventCount: safeBenchmarkNumber(result.pricingSummary.eventCount),
      coverageStatus: result.pricingSummary.coverageStatus,
      payloadSha256: result.pricingSummary.payloadSha256,
      cacheStatus: result.pricingCachePublication?.status ?? null,
      cacheGeneration: result.pricingCachePublication?.publicationGeneration ?? null,
    } : null,
    databaseBytes: databaseByteCount,
    peakRssBytes: safeBenchmarkNumber(result.lifetimePeakRssBytes ?? peakMemory.rssBytes),
  };
}

function validateSyntheticAppendConfiguration({ lineCount, startAt, endAt } = {}) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 500_000
      || typeof startAt !== "string" || typeof endAt !== "string") {
    throw new TypeError("Claude Desktop synthetic append benchmark configuration is invalid");
  }
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new TypeError("Claude Desktop synthetic append benchmark interval is invalid");
  }
  return { startMs, endMs };
}

async function materializeSyntheticAppendCorpus(root, { lineCount, startMs, endMs }) {
  const metadataDirectory = join(root, "metadata");
  const projectsDirectory = join(root, "projects");
  const transcriptDirectory = join(projectsDirectory, "project");
  const transcriptPath = join(transcriptDirectory, `${SYNTHETIC_CLI_SESSION_ID}.jsonl`);
  const cleanupMarkerPath = join(root, ".last-cleanup");
  const quotaHistoryPath = join(root, "plan-usage-history.json");
  await mkdir(metadataDirectory, { mode: 0o700 });
  await mkdir(projectsDirectory, { mode: 0o700 });
  await mkdir(transcriptDirectory, { mode: 0o700 });
  const metadata = {
    sessionId: SYNTHETIC_SESSION_ID,
    cliSessionId: SYNTHETIC_CLI_SESSION_ID,
    createdAt: startMs,
    lastActivityAt: endMs,
    isArchived: false,
  };
  await writeFile(join(metadataDirectory, "local_synthetic.json"), JSON.stringify(metadata), {
    mode: 0o600,
  });
  await writeFile(transcriptPath, "", { mode: 0o600 });
  const lines = [];
  for (let ordinal = 1; ordinal <= lineCount; ordinal += 1) {
    const timestampMs = startMs + Math.floor(
      ((endMs - startMs) * ordinal) / (lineCount + 2),
    );
    lines.push(syntheticTranscriptLine(ordinal, timestampMs));
    if (lines.length >= 512 || ordinal === lineCount) {
      await appendFile(transcriptPath, lines.join(""));
      lines.length = 0;
    }
  }
  await writeFile(cleanupMarkerPath, "generated-cleanup-marker-v1\n", { mode: 0o600 });
  await writeFile(quotaHistoryPath, JSON.stringify({
    version: 2,
    samples: [{ t: startMs + 1_000, org: "synthetic-organization", u: { fh: 42 } }],
  }), { mode: 0o600 });
  return {
    metadataDirectory,
    projectsDirectory,
    transcriptPath,
    cleanupMarkerPath,
    quotaHistoryPath,
    initialSourceBytes: (await stat(transcriptPath)).size,
  };
}

async function appendSyntheticRow(transcriptPath, { lineCount, startMs, endMs }) {
  const timestampMs = startMs + Math.floor(
    ((endMs - startMs) * (lineCount + 1)) / (lineCount + 2),
  );
  const line = syntheticTranscriptLine(lineCount + 1, timestampMs);
  await appendFile(transcriptPath, line);
  return Buffer.byteLength(line, "utf8");
}

async function mutateSyntheticPrefix(transcriptPath) {
  const original = await readFile(transcriptPath);
  const needle = Buffer.from('"output_tokens":3', "utf8");
  const replacement = Buffer.from('"output_tokens":4', "utf8");
  const offset = original.indexOf(needle);
  if (offset < 0) throw new Error("Synthetic append benchmark mutation target is absent");
  const mutated = Buffer.from(original);
  replacement.copy(mutated, offset);
  let contentBytesChanged = 0;
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== mutated[index]) contentBytesChanged += 1;
  }
  const before = await stat(transcriptPath);
  await writeFile(transcriptPath, mutated, { mode: 0o600 });
  const after = await stat(transcriptPath);
  const mtimeMs = Math.max(after.mtimeMs, before.mtimeMs + 1);
  await utimes(transcriptPath, after.atime, new Date(mtimeMs));
  return {
    contentBytesChanged,
    sourceLengthDeltaBytes: mutated.length - original.length,
    sourceBytes: after.size,
  };
}

async function runIsolatedWorker(configuration, maximumRssBytes) {
  let parsed = null;
  const watchdog = await runR7WorkerWatchdog({
    runtimeExecutable: process.execPath,
    workerPath: WORKER_PATH,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    input: JSON.stringify(configuration),
    maximumRssBytes,
    timeoutMs: 10 * 60 * 1_000,
    requireLifetimePeakRss: true,
    consumeStdout(value) {
      parsed = JSON.parse(value.toString("utf8"));
      return parsed.lifetimePeakRssBytes;
    },
  });
  if (watchdog.outcome !== "completed" || !parsed) {
    throw new Error(`Claude incremental worker watchdog stopped (${watchdog.outcome})`);
  }
  return { ...parsed, watchdog };
}

export async function benchmarkClaudeDesktopIncrementalIsolated({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  quotaHistoryPath,
  startAt,
  endAt,
  secret,
  temporaryRoot = tmpdir(),
} = {}) {
  const key = normalizeSecret(secret);
  let root;
  try {
    root = await mkdtemp(join(temporaryRoot, "tibotattle-claude-incremental-isolated-"));
    await chmod(root, 0o700);
    const configuration = {
      metadataDirectory,
      projectsDirectory,
      cleanupMarkerPath,
      quotaHistoryPath,
      canonicalPath: join(root, "canonical.sqlite"),
      ledgerPath: join(root, "ledger.sqlite"),
      // Exercise the bounded production-shaped pricing lane. The row-rich
      // projection is retained only as a small-fixture/debug surface and
      // materially distorts the memory profile at realistic history sizes.
      pricingCachePath: join(root, "pricing.sqlite"),
      startAt,
      endAt,
      secretBase64: key.toString("base64"),
    };
    const initial = await runIsolatedWorker(configuration, 768 * 1024 * 1024);
    const unchanged = await runIsolatedWorker(configuration, 256 * 1024 * 1024);
    return {
      schemaVersion: "claude-desktop-incremental-isolated-benchmark-v0.1",
      status: initial.status,
      interval: { startAt, endAt },
      initial,
      unchanged,
      databaseBytes: await databaseBytes(root),
      peakRssBytes: Math.max(initial.peakMemory.rssBytes, unchanged.peakMemory.rssBytes),
      unchangedPeakRssBytes: unchanged.peakMemory.rssBytes,
    };
  } finally {
    key.fill(0);
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export async function benchmarkClaudeDesktopIncremental({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  quotaHistoryPath,
  startAt,
  endAt,
  secret,
  temporaryRoot = tmpdir(),
} = {}) {
  if (typeof quotaHistoryPath !== "string" || quotaHistoryPath.length === 0
      || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
    throw new TypeError("Claude Desktop incremental benchmark configuration is invalid");
  }
  const key = normalizeSecret(secret);
  let stage = "setup";
  const peakMemory = {};
  const peakMemoryByStage = {};
  const sample = () => {
    const reading = memoryReading();
    updatePeak(peakMemory, reading);
    peakMemoryByStage[stage] ??= {};
    updatePeak(peakMemoryByStage[stage], reading);
  };
  sample();
  const sampler = setInterval(sample, 5);
  sampler.unref?.();
  let root;
  let canonicalizer;
  let ledger;
  try {
    root = await mkdtemp(join(temporaryRoot, "tibotattle-claude-incremental-"));
    await chmod(root, 0o700);
    const canonicalPath = join(root, "canonical.sqlite");
    const ledgerPath = join(root, "ledger.sqlite");
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(canonicalPath, { secret: key });
    ledger = openClaudeDesktopLedgerPrototype(ledgerPath);

    async function inventory() {
      const startedAt = performance.now();
      const value = await inventoryClaudeDesktopSources({
        metadataDirectory,
        projectsDirectory,
        cleanupMarkerPath,
        secret: key,
        includePrivatePlan: true,
      });
      return { value, elapsedMs: elapsed(startedAt) };
    }

    function mergeCandidates(values) {
      const startedAt = performance.now();
      let inserted = 0;
      let superseded = 0;
      let tombstoned = 0;
      for (let offset = 0; offset < values.length; offset += 1_000) {
        const merged = ledger.mergeUsageCandidates(
          values.slice(offset, offset + 1_000).map(createClaudeDesktopLedgerCandidate),
          { acceptedAtMs: Date.parse(endAt) },
        );
        inserted += merged.inserted;
        superseded += merged.superseded;
        tombstoned += merged.tombstoned;
      }
      return { inserted, superseded, tombstoned, elapsedMs: elapsed(startedAt) };
    }

    stage = "initial_inventory";
    let initialInventory = await inventory();
    const initialInventoryMs = initialInventory.elapsedMs;
    const inventoryStatus = initialInventory.value.status;
    stage = "initial_canonicalization";
    let startedAt = performance.now();
    let initialCanonical = await canonicalizer.refresh({
      sourcePaths: initialInventory.value.privatePlan.sourcePaths,
      startAt,
      endAt,
      observedAtMs: Date.parse(endAt),
    });
    const initialCanonicalMs = elapsed(startedAt);
    const initialCanonicalSummary = {
      sourceCount: initialCanonical.sourceCount,
      parsedBytes: initialCanonical.parsedBytes,
      parsedLines: initialCanonical.parsedLines,
      assistantOccurrences: initialCanonical.assistantOccurrences,
      dirtyGroupCount: initialCanonical.dirtyGroupCount,
      candidateCount: initialCanonical.candidates.length,
    };
    stage = "initial_merge";
    const initialMerge = mergeCandidates(initialCanonical.candidates);
    canonicalizer.acknowledgeDirty(initialCanonical.dirtyKeys);
    initialCanonical = null;
    initialInventory = null;

    stage = "initial_quota";
    startedAt = performance.now();
    let initialQuota = await readClaudeDesktopPlanHistory(quotaHistoryPath, { secret: key });
    const initialQuotaParseMs = elapsed(startedAt);
    startedAt = performance.now();
    const initialQuotaMerge = ledger.mergeQuotaObservations(initialQuota.observations, {
      sourceKey: quotaSourceKey(key, quotaHistoryPath),
      acceptedAtMs: Date.parse(endAt),
    });
    initialQuotaMerge.elapsedMs = elapsed(startedAt);
    initialQuota = null;
    startedAt = performance.now();
    const initialProjection = ledger.publishProjection("anthropic_claude_code", {
      publishedAtMs: Date.parse(endAt),
    });
    initialProjection.elapsedMs = elapsed(startedAt);

    canonicalizer.close();
    ledger.close();
    canonicalizer = null;
    ledger = null;
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(canonicalPath, { secret: key });
    ledger = openClaudeDesktopLedgerPrototype(ledgerPath);

    stage = "unchanged_inventory";
    const unchangedStartedAt = performance.now();
    let unchangedInventory = await inventory();
    const unchangedInventoryMs = unchangedInventory.elapsedMs;
    stage = "unchanged_canonicalization";
    startedAt = performance.now();
    let unchangedCanonical = await canonicalizer.refresh({
      sourcePaths: unchangedInventory.value.privatePlan.sourcePaths,
      startAt,
      endAt,
      observedAtMs: Date.parse(endAt),
    });
    const unchangedCanonicalMs = elapsed(startedAt);
    const unchangedCanonicalSummary = {
      sourceCount: unchangedCanonical.sourceCount,
      unchangedSources: unchangedCanonical.unchangedSources,
      appendedSources: unchangedCanonical.appendedSources,
      rebuiltSources: unchangedCanonical.rebuiltSources,
      parsedBytes: unchangedCanonical.parsedBytes,
      parsedLines: unchangedCanonical.parsedLines,
      dirtyGroupCount: unchangedCanonical.dirtyGroupCount,
      candidateCount: unchangedCanonical.candidates.length,
    };
    stage = "unchanged_merge";
    const unchangedMerge = mergeCandidates(unchangedCanonical.candidates);
    canonicalizer.acknowledgeDirty(unchangedCanonical.dirtyKeys);
    unchangedCanonical = null;
    unchangedInventory = null;
    stage = "unchanged_quota";
    startedAt = performance.now();
    let unchangedQuota = await readClaudeDesktopPlanHistory(quotaHistoryPath, { secret: key });
    const unchangedQuotaParseMs = elapsed(startedAt);
    startedAt = performance.now();
    const unchangedQuotaMerge = ledger.mergeQuotaObservations(unchangedQuota.observations, {
      sourceKey: quotaSourceKey(key, quotaHistoryPath),
      acceptedAtMs: Date.parse(endAt),
    });
    unchangedQuotaMerge.elapsedMs = elapsed(startedAt);
    unchangedQuota = null;
    const unchangedTotalMs = elapsed(unchangedStartedAt);

    stage = "finalize";
    sample();
    return {
      schemaVersion: CLAUDE_DESKTOP_INCREMENTAL_BENCHMARK_VERSION,
      status: inventoryStatus === "complete" ? "completed" : "partial_inventory",
      interval: { startAt, endAt },
      initial: {
        inventoryMs: initialInventoryMs,
        canonicalizationMs: initialCanonicalMs,
        canonical: initialCanonicalSummary,
        merge: initialMerge,
        quotaParseMs: initialQuotaParseMs,
        quotaMerge: initialQuotaMerge,
        projection: initialProjection,
      },
      unchanged: {
        elapsedMs: unchangedTotalMs,
        inventoryMs: unchangedInventoryMs,
        canonicalizationMs: unchangedCanonicalMs,
        canonical: unchangedCanonicalSummary,
        merge: unchangedMerge,
        quotaParseMs: unchangedQuotaParseMs,
        quotaMerge: unchangedQuotaMerge,
      },
      canonicalSnapshot: canonicalizer.snapshot(),
      ledgerSnapshot: ledger.providerSummary("anthropic_claude_code"),
      databaseBytes: await databaseBytes(root),
      peakRssBytes: peakMemory.rssBytes,
      peakMemory,
      peakMemoryByStage,
    };
  } finally {
    clearInterval(sampler);
    canonicalizer?.close();
    ledger?.close();
    key.fill(0);
    if (root) await rm(root, { recursive: true, force: true });
  }
}

/**
 * Exercise the incremental source cursor against a generated JSONL source.
 *
 * This deliberately never reads a user transcript. The corpus is generated in
 * a private temporary directory and the returned value is an aggregate-only
 * receipt: no source paths, identifiers, model strings, or transcript bytes
 * are returned. `lineCount` is the scale knob for a local performance run.
 */
export async function benchmarkClaudeDesktopSyntheticScaledAppend({
  lineCount = 2_000,
  startAt = DEFAULT_SYNTHETIC_START_AT,
  endAt = DEFAULT_SYNTHETIC_END_AT,
  secret,
  temporaryRoot = tmpdir(),
  maximumRssBytes = 768 * 1024 * 1024,
} = {}) {
  const { startMs, endMs } = validateSyntheticAppendConfiguration({
    lineCount,
    startAt,
    endAt,
  });
  if (!Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 64 * 1024 * 1024
      || maximumRssBytes > MAXIMUM_SYNTHETIC_RSS_BYTES) {
    throw new TypeError("Claude Desktop synthetic append benchmark RSS ceiling is invalid");
  }
  const key = normalizeSecret(secret);
  let root;
  try {
    root = await mkdtemp(join(temporaryRoot, "tibotattle-claude-synthetic-append-"));
    await chmod(root, 0o700);
    const corpus = await materializeSyntheticAppendCorpus(root, { lineCount, startMs, endMs });
    const configuration = {
      metadataDirectory: corpus.metadataDirectory,
      projectsDirectory: corpus.projectsDirectory,
      cleanupMarkerPath: corpus.cleanupMarkerPath,
      quotaHistoryPath: corpus.quotaHistoryPath,
      canonicalPath: join(root, "canonical.sqlite"),
      ledgerPath: join(root, "ledger.sqlite"),
      pricingCachePath: join(root, "pricing.sqlite"),
      startAt,
      endAt,
      aggregateOnly: true,
      secretBase64: key.toString("base64"),
    };
    async function phase() {
      const worker = await runIsolatedWorker(configuration, maximumRssBytes);
      return projectSyntheticWorkerResult(worker, await databaseBytes(root));
    }

    const firstImport = await phase();
    const unchanged = await phase();
    const appendBytes = await appendSyntheticRow(corpus.transcriptPath, { lineCount, startMs, endMs });
    const appendSourceBytes = (await stat(corpus.transcriptPath)).size;
    const append = await phase();
    // Each phase is an independent process, so this pass also proves that the
    // suffix cursor survives a close/reopen after the append.
    const restartAfterAppend = await phase();
    const mutation = await mutateSyntheticPrefix(corpus.transcriptPath);
    const mutated = await phase();
    const phases = {
      firstImport,
      unchanged,
      append,
      restartAfterAppend,
      mutation: {
        ...mutated,
        contentBytesChanged: mutation.contentBytesChanged,
        sourceLengthDeltaBytes: mutation.sourceLengthDeltaBytes,
      },
    };
    return {
      schemaVersion: CLAUDE_DESKTOP_SYNTHETIC_APPEND_BENCHMARK_VERSION,
      status: Object.values(phases).every((value) => value.status === "completed")
        ? "completed" : "partial_inventory",
      contentFree: true,
      corpusVersion: SYNTHETIC_CORPUS_VERSION,
      interval: { startAt, endAt },
      scale: {
        sourceCount: 1,
        initialLineCount: lineCount,
        finalLineCount: lineCount + 1,
        initialSourceBytes: corpus.initialSourceBytes,
        appendBytes,
        appendSourceBytes,
        mutationContentBytesChanged: mutation.contentBytesChanged,
        mutationSourceLengthDeltaBytes: mutation.sourceLengthDeltaBytes,
        mutationSourceBytes: mutation.sourceBytes,
      },
      rssCeilingBytes: maximumRssBytes,
      phases,
      invariants: {
        firstImportParsedAllLines: firstImport.canonical.parsedLines === lineCount,
        unchangedReadZeroLines: unchanged.canonical.parsedLines === 0
          && unchanged.canonical.unchangedSources === 1,
        appendReadOneSuffixLine: append.canonical.parsedLines === 1
          && append.canonical.appendedSources === 1,
        restartReadZeroLines: restartAfterAppend.canonical.parsedLines === 0
          && restartAfterAppend.canonical.unchangedSources === 1,
        mutationRebuiltSource: mutated.canonical.rebuiltSources === 1
          && mutated.canonical.parsedLines === lineCount + 1,
      },
    };
  } finally {
    key.fill(0);
    if (root) await rm(root, { recursive: true, force: true });
  }
}
