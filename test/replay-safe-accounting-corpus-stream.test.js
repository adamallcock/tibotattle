import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
  readReplaySafeAccountingCache,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";
import {
  beginUnifiedIndexGeneration,
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";
import { stableJson } from "../src/storage.js";

// The streaming calibration corpus (2026-08-19). The pre-streaming reader
// materialized every priced compact usage row before the fit and the
// derivation ran — ~635 real bytes per row against the 256 the byte meter
// charges — and on a large corpus that residency pushed whole-process RSS
// over the accounting ceiling on EVERY rebuild attempt. Each deferred pass
// restarted from scratch against the same corpus and an RSS baseline
// fossilized by the previous attempt, so the rebuild never landed (live
// 0.1.13 incident: accounting_rebuild_deferred /
// accounting_transition_rss_limit_exceeded recurring for hours).
//
// These tests pin the two facts the fix rests on:
//  1. the streamed corpus produces byte-identical calibration artifacts to
//     the same rows held resident (the seam the rewrite changed), and
//  2. a corpus far larger than the old resident materialization completes in
//     ONE pass under a scaled-down whole-process RSS budget, so repeated
//     passes are no longer needed at all.

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

// Model/tier/context variety so pricing bands, the composition fit, and the
// speed scenarios are all non-trivial. An unrecognized model is retained as
// "unknown" identically on both paths, so a sprinkling is included.
const MODELS = ["gpt-5.6-sol", "gpt-5.6-terra"];
const SPEEDS = ["unknown", "fast", "standard"];

function corpusUsageRow(index, observedAtMs) {
  // Pricing-warning variety (an unrecognized model, unpriced cache writes)
  // is confined to the earliest rows: a transition carrying any pricing
  // warning is ineligible for the estimate, so keeping the taint inside the
  // first reset window exercises those row shapes on both paths while the
  // remaining windows stay estimator-worthy.
  const tainted = index < 1_300;
  const model = tainted && index % 9 === 0
    ? "not-a-recognized-model"
    : MODELS[index % MODELS.length];
  const speed = SPEEDS[index % SPEEDS.length];
  return {
    observedAtMs,
    model,
    speed,
    // Every third row reports a long-context total; the rest report none, so
    // the pricer bands by summed inputs exactly as on the scan path.
    totalInputContext: index % 3 === 0 ? 300_000 : null,
    tokensInUncached: 400_000 + (index % 47) * 1_000,
    tokensInCacheRead: 20_000 + (index % 211),
    tokensInCacheWrite: tainted && index % 5 === 0 ? 3_000 : 0,
    // A slice of combined-only output rows exercises the combined
    // normalization on both paths.
    tokensOutText: index % 7 === 0 ? 0 : 800 + (index % 13),
    tokensOutReasoning: index % 7 === 0 ? 0 : 1_200,
    tokensOutCombined: index % 7 === 0 ? 2_400 : 0,
  };
}

// One synthetic corpus definition shared by the unified index build and the
// resident-array oracle build. Consecutive quota readings always differ, so
// the unified run-collapse retains every row and the windowed path (which
// never collapses) retains the identical set. Slot flips mid-window: window
// identity is slot-agnostic, so the batched planner must never split one
// window's rows on the flip.
function syntheticCorpus({
  resetStarts,
  boundariesPerReset,
  usagePerBoundary,
  boundaryStepMs = 60 * 60_000,
  percentFor = (boundary) => boundary,
}) {
  const usage = [];
  const quota = [];
  for (const [resetIndex, resetStartMs] of resetStarts.entries()) {
    for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
      const observedAtMs = resetStartMs + boundary * boundaryStepMs;
      quota.push({
        observedAtMs,
        usedPercent: percentFor(boundary),
        resetsAtMs: resetStartMs + WEEK_MS,
        // Slot is a UI role: window identity is slot-agnostic, so the batched
        // planner must keep a window whole regardless of its slot labels. The
        // first window alternates slots per boundary to pin exactly that (the
        // estimator's own simultaneous-slot guard then ignores that window);
        // the rest flip between windows, like the real corpus's server-side
        // flip, and stay estimator-worthy.
        slot: resetIndex === 0
          ? (boundary % 2 === 0 ? "secondary" : "primary")
          : resetIndex * 2 < resetStarts.length ? "secondary" : "primary",
        planType: "pro",
      });
      for (let step = 0; step < usagePerBoundary; step += 1) {
        usage.push(corpusUsageRow(
          usage.length,
          observedAtMs + 10_000 + step * 5_000,
        ));
      }
    }
  }
  return { usage, quota };
}

async function writeCorpusIndex(indexFile, { usage, quota }) {
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "unified-calibration-test-v1",
  });
  const modelIds = new Map([...MODELS, "not-a-recognized-model"].map((model) => [
    model,
    writer.internModel(model, "recognized"),
  ]));
  const tierIds = new Map(SPEEDS.map((speed) => [
    speed,
    writer.internTier({
      apiServiceTier: "unknown",
      billingSurface: "unknown",
      codexSpeedMode: speed,
      tierSource: "unknown",
      providerTierRaw: null,
    }),
  ]));
  const surfaceId = writer.internSurface({
    agentScope: "unknown",
    surface: "unknown",
    threadSource: "unknown",
    lineageDisposition: "unknown",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: null,
    planType: null,
    scopeLocal: null,
  });
  const sessionLocal = Buffer.alloc(32, 5);
  for (const [index, row] of usage.entries()) {
    writer.writeUsageEvent({
      eventKey: Buffer.from(`corpus-stream-event-${index}`),
      observedAtMs: row.observedAtMs,
      sessionLocal,
      accountScopeId,
      modelId: modelIds.get(row.model),
      tierId: tierIds.get(row.speed),
      surfaceId,
      reasoningEffort: 8,
      outcome: 5,
      tokensInUncached: row.tokensInUncached,
      tokensInCacheRead: row.tokensInCacheRead,
      tokensInCacheWrite: row.tokensInCacheWrite,
      tokensOutText: row.tokensOutText,
      tokensOutReasoning: row.tokensOutReasoning,
      tokensOutCombined: row.tokensOutCombined,
      totalInputContext: row.totalInputContext,
    });
  }
  for (const row of quota) {
    writer.internQuota({
      observedAtMs: row.observedAtMs,
      limitId: "codex",
      slot: row.slot,
      planType: row.planType,
      usedPercent: row.usedPercent,
      resetsAtMs: row.resetsAtMs,
      durationMins: 10_080,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: indexFile });
}

// The resident-array oracle: the same rows fed through the windowed scan
// path, which retains its transition inputs in memory and drives the same
// fit fold and the same batched derivation from arrays. The raw events mirror
// exactly the shape the unified corpus reader reconstructs per row.
function oracleScan({ usage, quota }) {
  return async ({ onUsage, onRateLimitSnapshot }) => {
    for (const row of usage) {
      onUsage({
        timestamp: new Date(row.observedAtMs).toISOString(),
        model: row.model,
        ...(row.totalInputContext === null
          ? {}
          : { totalInputContextTokens: row.totalInputContext }),
        components: {
          input_uncached_tokens: row.tokensInUncached,
          input_cache_read_tokens: row.tokensInCacheRead,
          input_cache_write_tokens: row.tokensInCacheWrite,
          output_text_tokens: row.tokensOutText,
          output_reasoning_tokens: row.tokensOutReasoning,
          output_combined_tokens: row.tokensOutCombined,
        },
        tierSemantics: {
          codexSpeedMode: row.speed,
          apiServiceTier: "unknown",
        },
      });
    }
    for (const row of quota) {
      onRateLimitSnapshot({
        timestamp: new Date(row.observedAtMs).toISOString(),
        timestampMs: row.observedAtMs,
        window: {
          provider: "openai_codex",
          planType: row.planType,
          limitId: "codex",
          slot: row.slot,
          windowDurationMins: 10_080,
          resetsAt: Math.floor(row.resetsAtMs / 1_000),
          usedPercent: row.usedPercent,
        },
      });
    }
    // The oracle deliberately reports no scan diagnostics: the unified
    // calibration corpus passes {} into the derivation, and the calibration
    // artifacts under comparison must not diverge on diagnostics alone.
    return { diagnostics: {} };
  };
}

const DECLARED_SPEED_BASELINES = [{
  firstSeenAt: "2026-05-01T00:00:00.000Z",
  lastSeenAt: "2026-05-20T00:00:00.000Z",
  mode: "standard",
}];

test("streamed unified calibration is byte-identical to the same corpus held resident, across the batched derivation path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-corpus-stream-equivalence-"));
  try {
    // 52,000 usage rows — past the 50k single-call usage budget — so the
    // derivation must batch and the streamed path must serve multiple
    // on-demand usage slices; 8 weekly resets x 99 whole-point changes keep
    // the corpus estimator-worthy so real estimates are compared.
    const corpus = syntheticCorpus({
      resetStarts: Array.from(
        { length: 8 },
        (_, week) => Date.parse("2026-05-07T00:00:00.000Z") + week * WEEK_MS,
      ),
      boundariesPerReset: 100,
      usagePerBoundary: 65,
    });
    assert.equal(corpus.usage.length, 52_000);
    const indexFile = join(directory, "local-unified-index-v1.sqlite");
    await writeCorpusIndex(indexFile, corpus);

    const streamed = await buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: indexFile,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      scan: async () => ({ diagnostics: {} }),
    });
    const resident = await buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: join(directory, "never-written.sqlite"),
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      scan: oracleScan(corpus),
    });

    assert.equal(streamed.weeklyCalibrationInput.source, "unified_index");
    assert.equal(resident.weeklyCalibrationInput.source, "windowed_scan");
    assert.equal(
      streamed.weeklyCalibrationInput.retainedUsageEvents,
      corpus.usage.length,
    );
    assert.equal(
      streamed.weeklyCalibrationInput.retainedUsageEvents,
      resident.weeklyCalibrationInput.retainedUsageEvents,
    );
    assert.equal(
      streamed.weeklyCalibrationInput.retainedWeeklySnapshots,
      resident.weeklyCalibrationInput.retainedWeeklySnapshots,
    );
    assert.equal(
      streamed.weeklyCalibrationInput.estimatedRetainedBytes,
      resident.weeklyCalibrationInput.estimatedRetainedBytes,
    );
    // The calibration artifacts — reset series, estimate, validation,
    // composition fit, and every allowance scenario — must be identical to
    // the resident-array build. This is the exact seam the streaming corpus
    // changed: array folds and slices versus on-demand re-reads.
    assert.deepEqual(streamed.weeklyCalibration, resident.weeklyCalibration);
    assert.deepEqual(
      streamed.allowanceCapacityByScenario,
      resident.allowanceCapacityByScenario,
    );
    // 792 transitions crossed the batched path in both builds, and the corpus
    // was estimator-worthy, so this compared real estimates rather than two
    // empty summaries.
    assert.equal(
      streamed.weeklyCalibration.sourceCounts.weeklyTransitions,
      792,
    );
    assert.equal(streamed.weeklyCalibration.status, "estimated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention trim keeps the newest rows across timestamp ties, identically to a resident corpus of those rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-corpus-stream-trim-"));
  try {
    const resetStartMs = Date.parse("2026-06-04T00:00:00.000Z");
    const tieMs = resetStartMs + 30 * 60 * 60_000;
    // Twelve usage rows share one timestamp; retention keeps the newest five
    // by insertion (rowid) order. The streamed re-reads must honor the same
    // (observedMs, rowid) cursor through the tie.
    const usage = Array.from({ length: 12 }, (_, index) => corpusUsageRow(index, tieMs));
    const quota = Array.from({ length: 6 }, (_, boundary) => ({
      observedAtMs: resetStartMs + (boundary + 30) * 60 * 60_000,
      usedPercent: boundary + 30,
      resetsAtMs: resetStartMs + WEEK_MS,
      slot: boundary % 2 === 0 ? "secondary" : "primary",
      planType: "pro",
    }));
    const indexFile = join(directory, "local-unified-index-v1.sqlite");
    await writeCorpusIndex(indexFile, { usage, quota });

    const streamed = await buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: indexFile,
      transitionResourceLimits: { usageEvents: 5 },
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      scan: async () => ({ diagnostics: {} }),
    });
    const resident = await buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: join(directory, "never-written.sqlite"),
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      // The oracle receives only the rows the trim retains: the last five
      // inserted (highest rowids) of the tied twelve.
      scan: oracleScan({ usage: usage.slice(7), quota }),
    });

    assert.equal(streamed.weeklyCalibrationInput.retainedUsageEvents, 5);
    assert.equal(
      streamed.weeklyCalibrationInput.retainedWeeklySnapshots,
      resident.weeklyCalibrationInput.retainedWeeklySnapshots,
    );
    assert.deepEqual(streamed.weeklyCalibration, resident.weeklyCalibration);
    assert.deepEqual(
      streamed.allowanceCapacityByScenario,
      resident.allowanceCapacityByScenario,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Runs the streamed build in a child whose V8 old space is deliberately
// small. The cap does two jobs the parent process cannot do deterministically:
// it forces prompt garbage collection (so the whole-process RSS budget below
// is meaningful under any machine load, where an unconstrained heap may defer
// major GC past any tight margin), and it turns a regression back to
// O(corpus) residency into a hard out-of-memory crash — a 300k-row corpus
// materialized at the measured ~635 real bytes per compact row (~190 MiB,
// before its stamped/sorted copies) cannot fit the cap at all, while the
// streamed working set (one <=50k-row batch slice plus thin stamps) lives
// comfortably inside it. Same pattern as test/export-checkpoint-heap.test.js.
const BUDGET_CHILD_OLD_SPACE_MIB = 256;
const BUDGET_CHILD_RSS_BUDGET_MIB = 512;
const BUDGET_CHILD = String.raw`
const { buildReplaySafeAccountingCache } = await import(
  process.env.CORPUS_STREAM_MODULE
);
const baselineRss = process.memoryUsage().rss;
const budgetBytes = Number(process.env.CORPUS_STREAM_BUDGET_BYTES);
let peakRss = baselineRss;
let rssReadings = 0;
const cache = await buildReplaySafeAccountingCache({
  now: () => Number(process.env.CORPUS_STREAM_NOW_MS),
  unifiedIndexFile: process.env.CORPUS_STREAM_INDEX_FILE,
  declaredSpeedBaselines: JSON.parse(process.env.CORPUS_STREAM_BASELINES),
  scan: async () => ({ diagnostics: {} }),
  rss: () => {
    rssReadings += 1;
    const current = process.memoryUsage().rss;
    if (current > peakRss) peakRss = current;
    return current;
  },
  maximumRssBytes: baselineRss + budgetBytes,
});
process.stdout.write(JSON.stringify({
  source: cache.weeklyCalibrationInput.source,
  retainedUsageEvents: cache.weeklyCalibrationInput.retainedUsageEvents,
  weeklyTransitions: cache.weeklyCalibration.sourceCounts.weeklyTransitions,
  rssReadings,
  peakGrowthMiB: Number(((peakRss - baselineRss) / 1024 / 1024).toFixed(1)),
}) + "\n");
`;

test("a corpus far larger than one derivation batch completes in ONE pass under a scaled-down RSS budget and a capped heap", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-corpus-stream-budget-"));
  try {
    // 300k usage rows across six reset windows: six times the 50k single-call
    // usage budget, so the derivation must run several on-demand slices. The
    // pre-streaming reader materialized this whole corpus before deriving,
    // and a deferred pass re-ran the identical materialization forever.
    const corpus = syntheticCorpus({
      resetStarts: Array.from(
        { length: 6 },
        (_, week) => Date.parse("2026-04-02T00:00:00.000Z") + week * WEEK_MS,
      ),
      boundariesPerReset: 1_000,
      usagePerBoundary: 50,
      boundaryStepMs: 60_000,
      percentFor: (boundary) => (boundary % 200) / 2,
    });
    assert.equal(corpus.usage.length, 300_000);
    const indexFile = join(directory, "local-unified-index-v1.sqlite");
    await writeCorpusIndex(indexFile, corpus);

    const child = spawnSync(process.execPath, [
      `--max-old-space-size=${BUDGET_CHILD_OLD_SPACE_MIB}`,
      "--input-type=module",
      "--eval",
      BUDGET_CHILD,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 150_000,
      env: {
        ...process.env,
        CORPUS_STREAM_MODULE:
          new URL("../src/replay-safe-accounting-cache.js", import.meta.url).href,
        CORPUS_STREAM_INDEX_FILE: indexFile,
        CORPUS_STREAM_NOW_MS: String(NOW),
        CORPUS_STREAM_BASELINES: JSON.stringify(DECLARED_SPEED_BASELINES),
        CORPUS_STREAM_BUDGET_BYTES:
          String(BUDGET_CHILD_RSS_BUDGET_MIB * 1024 * 1024),
      },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    // A build that holds the corpus resident again dies here: either the
    // capped heap refuses the materialization outright, or the genuine
    // process-RSS guard inside the child trips
    // accounting_transition_rss_limit_exceeded.
    assert.equal(child.status, 0, child.stderr);
    const outcome = JSON.parse(child.stdout);
    t.diagnostic(
      `peak RSS growth ${outcome.peakGrowthMiB} MiB of the `
        + `${BUDGET_CHILD_RSS_BUDGET_MIB} MiB budget under a `
        + `${BUDGET_CHILD_OLD_SPACE_MIB} MiB old-space cap`,
    );
    assert.equal(outcome.source, "unified_index");
    assert.equal(outcome.retainedUsageEvents, 300_000);
    // 999 percent changes per reset window x 6 windows: the whole series was
    // derived, none of it discarded to fit the budget.
    assert.equal(outcome.weeklyTransitions, 5_994);
    assert.ok(
      outcome.rssReadings > 50,
      `the RSS guard must meter the streamed corpus (saw ${outcome.rssReadings} readings)`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The isolated-subprocess rebuild (2026-08-19). Streaming the corpus (above)
// was necessary but insufficient at owner scale: the derived transition series
// still accumulates across batches, and the RSS guard measures the WHOLE
// process — a companion that legitimately idles near 1.9 GiB after indexing an
// ~80 GB corpus reaches the 2 GiB absolute target with no headroom for ANY
// rebuild growth, so the streamed rebuild kept deferring (dogfood 0.1.13,
// 2026-08-19, 23:21:26Z and 23:39:15Z). Production rebuilds therefore run in a
// short-lived child with a clean baseline. These tests pin the boundary:
//  1. the child's artifact is BYTE-identical to the in-process build;
//  2. a rebuild completes while the parent sits past the absolute backstop —
//     the exact state that deferred forever in-process;
//  3. a child that dies fails closed to the deferral (never a crash loop,
//     never a clobbered prior cache);
//  4. the caller's abort is an abort, not a deferral.
// ---------------------------------------------------------------------------

// A unified index with a COMPLETE published generation, accepted by the
// production unified reader (requireComplete: true) — unlike writeCorpusIndex
// above, whose rows carry no generation provenance and satisfy only the
// calibration-corpus reader. Modeled on the writer fixture the unified
// accounting source's own tests use.
async function writeCompleteGenerationIndex(indexFile, {
  resetStarts,
  boundariesPerReset,
  usagePerBoundary,
}) {
  const receivedAtMs = resetStarts[0];
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs,
    discoveredSourceCount: 1,
    discoveredSourceBytes: 4_096,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs,
    generationId: generation.generationId,
    parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
  });
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", "complete");
  writer.writeMeta("generated_at", new Date(receivedAtMs).toISOString());
  writer.writeMeta("source_count", 1);
  writer.writeMeta("source_bytes", 4_096);
  const sourceLocal = Buffer.alloc(32, 4);
  const sessionLocal = Buffer.alloc(32, 7);
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: "missing_account",
    planType: null,
    scopeLocal: null,
  });
  const modelIds = new Map(
    [...MODELS, "not-a-recognized-model"].map((model) => [
      model,
      writer.internModel(model, "recognized"),
    ]),
  );
  const tierIds = new Map(SPEEDS.map((speed) => [
    speed,
    writer.internTier({
      apiServiceTier: "unknown",
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: speed,
      tierSource: speed === "unknown" ? "unknown" : "rollout_thread_settings",
      providerTierRaw: null,
    }),
  ]));
  const surfaceId = writer.internSurface({
    agentScope: "root",
    surface: "cli_exec",
    threadSource: "user",
    lineageDisposition: "standalone",
  });
  let sourceOffset = 0;
  let usageRows = 0;
  const eventKey = (ordinal) => {
    const key = Buffer.alloc(32, 9);
    key.writeUInt32BE(ordinal, 28);
    return key;
  };
  for (const [resetIndex, resetStartMs] of resetStarts.entries()) {
    // One server-side slot flip across the corpus, like the real history;
    // window identity is slot-agnostic so the derivation must not care.
    const slot = resetIndex * 2 < resetStarts.length ? "secondary" : "primary";
    for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
      const observedAtMs = resetStartMs + boundary * 60 * 60_000;
      const quotaObservationId = writer.internQuota({
        observedAtMs,
        limitId: "codex",
        slot,
        planType: "pro",
        usedPercent: boundary,
        resetsAtMs: resetStartMs + WEEK_MS,
        durationMins: 10_080,
      });
      writer.writeQuotaOccurrence({
        generationId: generation.generationId,
        sourceLocal,
        sourceOffset,
        sourceOrdinal: 0,
        surfaceId,
        canonicalObservationId: quotaObservationId,
        observedAtMs,
        provider: "openai_codex",
        planType: "pro",
        limitId: "codex",
        slot,
        slotOrder: 0,
        usedPercent: boundary,
        resetsAtMs: resetStartMs + WEEK_MS,
        durationMins: 10_080,
        admission: "admitted",
      });
      sourceOffset += 1;
      for (let step = 0; step < usagePerBoundary; step += 1) {
        const row = corpusUsageRow(
          usageRows,
          observedAtMs + 10_000 + step * 5_000,
        );
        writer.writeUsageEvent({
          eventKey: eventKey(usageRows),
          observedAtMs: row.observedAtMs,
          generationId: generation.generationId,
          sourceLocal,
          sourceOffset,
          sourceOrdinal: 0,
          tierObservedAtMs: row.observedAtMs - 1_000,
          sessionLocal,
          accountScopeId,
          modelId: modelIds.get(row.model),
          tierId: tierIds.get(row.speed),
          surfaceId,
          quotaObservationId,
          reasoningEffort: 4,
          outcome: 5,
          tokensInUncached: row.tokensInUncached,
          tokensInCacheRead: row.tokensInCacheRead,
          tokensInCacheWrite: row.tokensInCacheWrite,
          tokensInCacheWrite5m: null,
          tokensInCacheWrite1h: null,
          tokensOutText: row.tokensOutText,
          tokensOutReasoning: row.tokensOutReasoning,
          tokensOutCombined: row.tokensOutCombined,
          totalInputContext: row.totalInputContext,
          partial: false,
        });
        usageRows += 1;
        sourceOffset += 1;
      }
    }
  }
  writer.writeSourceCursor({
    sourceLocal,
    sourceOrdinal: 0,
    sessionLocal,
    scannedBytes: 4_096,
    sizeBytes: 4_096,
    mtimeMs: receivedAtMs,
    snapshotsPersisted: true,
    turnContextSeen: true,
    carryModel: MODELS[0],
    carryEffort: "high",
    carryTierRaw: null,
    carryTierObservedAtMs: receivedAtMs,
    carryTotals: null,
  });
  writer.writeGenerationSource({
    generationId: generation.generationId,
    sourceLocal,
    sourceOrdinal: 0,
    sessionLocal,
    surfaceId,
    status: "complete",
    discoveredSizeBytes: 4_096,
    scannedBytes: 4_096,
    mtimeMs: receivedAtMs,
    diagnosticsComplete: true,
  });
  writer.writeSourceDiagnostics(sourceLocal, {}, {
    generationId: generation.generationId,
  });
  writer.finalizeGeneration({
    status: "complete",
    blockReason: null,
    discoveredSourceCount: 1,
    discoveredSourceBytes: 4_096,
    indexedSourceCount: 1,
    indexedSourceBytes: 4_096,
    discoveryComplete: true,
    diagnosticsComplete: true,
  });
  await writer.close({ integrityCheck: true, fsyncPath: indexFile });
  const readback = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try {
    const descriptor = readUnifiedIndexGenerationDescriptor(readback);
    return {
      indexFile,
      usageRows,
      expectedGeneration: {
        id: descriptor.id,
        fingerprint: descriptor.fingerprint,
      },
    };
  } finally {
    readback.close();
  }
}

// 4 reset windows x 99 whole-point changes keeps the corpus estimator-worthy,
// so the equivalence below compares real estimates, and 4x100x5 usage rows
// keep the fixture fast while exercising pricing bands, the composition fit,
// and the batched derivation on both sides of the process boundary.
const SUBPROCESS_FIXTURE_SHAPE = Object.freeze({
  resetStarts: Array.from(
    { length: 4 },
    (_, week) => Date.parse("2026-05-07T00:00:00.000Z") + week * WEEK_MS,
  ),
  boundariesPerReset: 100,
  usagePerBoundary: 5,
});
const SUBPROCESS_FIXTURE_TRANSITIONS = 4 * 99;

test("the default production rebuild is isolated in a child and byte-identical to the in-process build", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rebuild-subprocess-equivalence-"));
  try {
    const fixture = await writeCompleteGenerationIndex(
      join(directory, "local-unified-index-v1.sqlite"),
      SUBPROCESS_FIXTURE_SHAPE,
    );
    const stateFile = join(directory, "local-collector-state-v1.sqlite");
    // Production-shaped call: unified authority, no injected function seams —
    // this is exactly the shape "auto" isolates in a child (the crash test
    // below proves the default path consults the child entry).
    const viaSubprocess = await refreshReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: fixture.expectedGeneration,
      unifiedIndexFile: fixture.indexFile,
      now: () => NOW,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
    });
    const inProcess = await buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: fixture.expectedGeneration,
      unifiedIndexFile: fixture.indexFile,
      now: () => NOW,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
    });
    // Byte identity of the full serialized artifact — periods, history,
    // timelines, calibration, allowance scenarios, provenance — across the
    // process boundary, not merely calibration equality.
    assert.equal(stableJson(viaSubprocess), stableJson(inProcess));
    assert.equal(viaSubprocess.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
    assert.equal(viaSubprocess.weeklyCalibrationInput.source, "unified_index");
    assert.equal(
      viaSubprocess.weeklyCalibrationInput.retainedUsageEvents,
      fixture.usageRows,
    );
    assert.equal(viaSubprocess.history.status, "available");
    // Real estimates were compared, not two empty summaries.
    assert.equal(viaSubprocess.weeklyCalibration.status, "estimated");
    assert.equal(
      viaSubprocess.weeklyCalibration.sourceCounts.weeklyTransitions,
      SUBPROCESS_FIXTURE_TRANSITIONS,
    );
    // The child's artifact was committed to the durable state file verbatim.
    const written = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(written.status, "available");
    assert.deepEqual(written.cache, viaSubprocess);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dead or lying rebuild child fails closed to the deferral and retains the prior cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rebuild-subprocess-crash-"));
  try {
    const fixture = await writeCompleteGenerationIndex(
      join(directory, "local-unified-index-v1.sqlite"),
      {
        resetStarts: [Date.parse("2026-05-07T00:00:00.000Z")],
        boundariesPerReset: 10,
        usagePerBoundary: 2,
      },
    );
    const stateFile = join(directory, "local-collector-state-v1.sqlite");
    // A prior good cache on disk, written through the in-process
    // characterization path (injected scanner).
    const prior = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW,
      scan: async ({ onUsage }) => {
        onUsage({
          timestamp: "2026-08-19T11:00:00.000Z",
          model: "gpt-5.6-sol",
          components: { input_uncached_tokens: 1_000 },
        });
        return { diagnostics: {} };
      },
    });
    // A child that dies without an envelope: the default production path MUST
    // consult the child entry for this substitution to matter, so this also
    // proves "auto" isolation actually spawns.
    const crashingEntry = join(directory, "crashing-child.mjs");
    await writeFile(crashingEntry, "process.exit(86);\n");
    const deferredEvents = [];
    const crashed = await refreshReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: fixture.expectedGeneration,
      unifiedIndexFile: fixture.indexFile,
      now: () => NOW + 1_000,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      rebuildSubprocessEntry: crashingEntry,
      onAccountingRebuildDeferred: (event) => {
        deferredEvents.push(event);
      },
    });
    assert.equal(crashed.status, "accounting_rebuild_deferred");
    assert.equal(crashed.reason, "accounting_rebuild_subprocess_failed");
    assert.equal(crashed.retained, true);
    assert.equal(crashed.generatedAt, prior.generatedAt);
    // A child that lies about its result: ok envelope, wrong bytes. The
    // transport integrity check refuses it identically.
    const lyingEntry = join(directory, "lying-child.mjs");
    await writeFile(lyingEntry, [
      "import { writeFile } from \"node:fs/promises\";",
      "const payload = \"{\\\"not\\\":\\\"the artifact\\\"}\\n\";",
      "await writeFile(process.argv[3], payload, { mode: 0o600, flag: \"wx\" });",
      "process.stdout.write(JSON.stringify({",
      "  status: \"ok\",",
      "  resultBytes: Buffer.byteLength(payload),",
      "  resultSha256: \"0\".repeat(64),",
      "}) + \"\\n\");",
      "",
    ].join("\n"));
    const lied = await refreshReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: fixture.expectedGeneration,
      unifiedIndexFile: fixture.indexFile,
      now: () => NOW + 2_000,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      rebuildSubprocessEntry: lyingEntry,
      onAccountingRebuildDeferred: (event) => {
        deferredEvents.push(event);
      },
    });
    assert.equal(lied.status, "accounting_rebuild_deferred");
    assert.equal(lied.reason, "accounting_rebuild_subprocess_failed");
    assert.equal(lied.retained, true);
    assert.deepEqual(deferredEvents, [
      { reason: "accounting_rebuild_subprocess_failed", retained: true },
      { reason: "accounting_rebuild_subprocess_failed", retained: true },
    ]);
    // The prior cache survives both failures untouched and is still served.
    const served = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(served.status, "available");
    assert.deepEqual(served.cache, prior);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborting the refresh kills the rebuild child and reports the abort, not a deferral", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rebuild-subprocess-abort-"));
  try {
    const fixture = await writeCompleteGenerationIndex(
      join(directory, "local-unified-index-v1.sqlite"),
      {
        resetStarts: [Date.parse("2026-05-07T00:00:00.000Z")],
        boundariesPerReset: 10,
        usagePerBoundary: 2,
      },
    );
    // A child that never speaks: only the parent's SIGTERM ends it, so a
    // settled refresh proves the abort actually killed the child.
    const hangingEntry = join(directory, "hanging-child.mjs");
    await writeFile(hangingEntry, "setInterval(() => {}, 1_000);\n");
    const controller = new AbortController();
    const pending = refreshReplaySafeAccountingCache({
      stateFile: join(directory, "local-collector-state-v1.sqlite"),
      sourceMode: "unified",
      expectedGeneration: fixture.expectedGeneration,
      unifiedIndexFile: fixture.indexFile,
      now: () => NOW,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      rebuildSubprocessEntry: hangingEntry,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(pending, (error) => (
      error?.name === "AbortError"
        && error?.code === "accounting_refresh_aborted"
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolation options validate closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rebuild-isolation-options-"));
  try {
    const stateFile = join(directory, "local-collector-state-v1.sqlite");
    await assert.rejects(
      refreshReplaySafeAccountingCache({
        stateFile,
        now: () => NOW,
        rebuildIsolation: "sidecar",
      }),
      /rebuildIsolation must be auto, subprocess, or in_process/u,
    );
    // Injected function seams cannot cross a process boundary; asserting
    // isolation with one present must refuse rather than silently degrade.
    await assert.rejects(
      refreshReplaySafeAccountingCache({
        stateFile,
        now: () => NOW,
        rebuildIsolation: "subprocess",
        scan: async () => ({ diagnostics: {} }),
      }),
      /rebuildIsolation subprocess cannot carry injected scan or rss seams/u,
    );
    await assert.rejects(
      refreshReplaySafeAccountingCache({
        stateFile,
        now: () => NOW,
        rebuildSubprocessEntry: "relative/path.js",
      }),
      /rebuildSubprocessEntry must be an absolute path or null/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The decisive owner-scale regression. The parent process is inflated past the
// 2 GiB absolute accounting backstop and RETAINS that ballast — the state a
// large-history companion legitimately reaches after indexing — then runs the
// same rebuild both ways. In-process the guard's very first check must defer
// (that IS the 0.1.13 livelock: baseline past the target, zero headroom, every
// attempt deferred). The default isolated rebuild must COMPLETE against the
// same corpus while the parent stays inflated, because the guard now measures
// the child's own clean-baseline RSS. Runs in a spawned parent so the 2 GiB
// ballast never lives in the shared test-runner process.
const INFLATED_PARENT = String.raw`
const { refreshReplaySafeAccountingCache } = await import(
  process.env.REBUILD_PARENT_MODULE
);
const CHUNK = 64 * 1024 * 1024;
const ballast = Buffer.allocUnsafe(
  Number(process.env.REBUILD_PARENT_BALLAST_BYTES),
);
// Touch every page with a nonzero byte so the ballast is genuinely resident.
for (let offset = 0; offset < ballast.length; offset += CHUNK) {
  ballast.fill(0xa5, offset, Math.min(offset + CHUNK, ballast.length));
}
const parentRssBytes = process.memoryUsage().rss;
const nowMs = Number(process.env.REBUILD_PARENT_NOW_MS);
const shared = {
  stateFile: process.env.REBUILD_PARENT_STATE_FILE,
  sourceMode: "unified",
  expectedGeneration: JSON.parse(process.env.REBUILD_PARENT_EXPECTED_GENERATION),
  unifiedIndexFile: process.env.REBUILD_PARENT_INDEX_FILE,
  now: () => nowMs,
  declaredSpeedBaselines: JSON.parse(process.env.REBUILD_PARENT_BASELINES),
};
const inProcess = await refreshReplaySafeAccountingCache({
  ...shared,
  rebuildIsolation: "in_process",
});
const isolated = await refreshReplaySafeAccountingCache({ ...shared });
process.stdout.write(JSON.stringify({
  parentRssBytes,
  // Reading the ballast after both rebuilds keeps it retained throughout.
  ballastByte: ballast[ballast.length - 1],
  inProcess: {
    status: inProcess?.status ?? "rebuilt",
    reason: inProcess?.reason ?? null,
    retained: inProcess?.retained ?? null,
  },
  isolated: {
    schemaVersion: isolated?.schemaVersion ?? null,
    source: isolated?.weeklyCalibrationInput?.source ?? null,
    retainedUsageEvents:
      isolated?.weeklyCalibrationInput?.retainedUsageEvents ?? null,
    calibrationStatus: isolated?.weeklyCalibration?.status ?? null,
    weeklyTransitions:
      isolated?.weeklyCalibration?.sourceCounts?.weeklyTransitions ?? null,
    historyStatus: isolated?.history?.status ?? null,
  },
}) + "\n");
`;

test("a rebuild completes in the child while the parent sits past the absolute RSS backstop", { timeout: 240_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rebuild-inflated-parent-"));
  try {
    const fixture = await writeCompleteGenerationIndex(
      join(directory, "local-unified-index-v1.sqlite"),
      SUBPROCESS_FIXTURE_SHAPE,
    );
    // 2 GiB absolute target + 64 MiB: past the backstop, the way the owner's
    // companion idles at 1.88 GiB and crosses during any in-process attempt.
    const ballastBytes = (2 * 1024 + 64) * 1024 * 1024;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      INFLATED_PARENT,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 210_000,
      env: {
        ...process.env,
        REBUILD_PARENT_MODULE:
          new URL("../src/replay-safe-accounting-cache.js", import.meta.url).href,
        REBUILD_PARENT_STATE_FILE:
          join(directory, "local-collector-state-v1.sqlite"),
        REBUILD_PARENT_INDEX_FILE: fixture.indexFile,
        REBUILD_PARENT_EXPECTED_GENERATION:
          JSON.stringify(fixture.expectedGeneration),
        REBUILD_PARENT_NOW_MS: String(NOW),
        REBUILD_PARENT_BASELINES: JSON.stringify(DECLARED_SPEED_BASELINES),
        REBUILD_PARENT_BALLAST_BYTES: String(ballastBytes),
      },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const outcome = JSON.parse(child.stdout);
    t.diagnostic(
      `parent RSS ${(outcome.parentRssBytes / 1024 / 1024).toFixed(0)} MiB; `
        + "in-process deferred, isolated child completed",
    );
    assert.equal(outcome.ballastByte, 0xa5);
    // The parent genuinely sat past the 2 GiB absolute accounting target.
    assert.ok(
      outcome.parentRssBytes > 2 * 1024 * 1024 * 1024,
      `parent RSS ${outcome.parentRssBytes} must exceed the absolute backstop`,
    );
    // In-process: the incident, reproduced — the guard's first check defers
    // and no attempt could ever land (retained:false, nothing on disk yet).
    assert.deepEqual(outcome.inProcess, {
      status: "accounting_rebuild_deferred",
      reason: "accounting_transition_rss_limit_exceeded",
      retained: false,
    });
    // Isolated: the same rebuild against the same corpus COMPLETES, because
    // the budget now polices the child's own clean-baseline RSS.
    assert.deepEqual(outcome.isolated, {
      schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
      source: "unified_index",
      retainedUsageEvents: fixture.usageRows,
      calibrationStatus: "estimated",
      weeklyTransitions: SUBPROCESS_FIXTURE_TRANSITIONS,
      historyStatus: "available",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
