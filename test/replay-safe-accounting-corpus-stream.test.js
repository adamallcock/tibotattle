import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReplaySafeAccountingCache } from "../src/replay-safe-accounting-cache.js";
import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";

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

test("a corpus far larger than one derivation batch completes in ONE pass under a scaled-down whole-process RSS budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-corpus-stream-budget-"));
  try {
    // 300k usage rows across six reset windows. Under the pre-streaming
    // reader this corpus materialized ~190 MiB of compact rows (measured
    // ~635 real bytes per row) plus its stamped/sorted copies BEFORE any
    // derivation ran — past the budget below on retention alone — and a
    // deferred pass would have re-run the identical materialization forever.
    // The streamed corpus holds at most one <=50k-row batch slice instead,
    // so its peak stays batch-bounded no matter how large the history grows.
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

    // The scaled-down budget: the real process RSS at test start plus a
    // margin far below the old design's resident corpus. The guard runs
    // against genuine process.memoryUsage().rss readings, so a regression
    // back to O(corpus) residency trips accounting_transition_rss_limit_
    // exceeded and rejects this build.
    // Margin calibration (2026-08-19, measured): the streamed build peaked at
    // ~354 MiB growth on a 200k corpus — batch working sets and GC lag, all
    // corpus-size-independent — while the retired resident reader would add
    // ~190 MiB of corpus retention on top for THIS corpus. 512 MiB therefore
    // sits with real headroom above the streamed peak and below any design
    // that holds the corpus resident again.
    const baselineRss = process.memoryUsage().rss;
    const budgetBytes = Number(process.env.CORPUS_STREAM_BUDGET_MIB ?? 512)
      * 1024 * 1024;
    let peakRss = baselineRss;
    let rssReadings = 0;
    const cache = await buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: indexFile,
      declaredSpeedBaselines: DECLARED_SPEED_BASELINES,
      scan: async () => ({ diagnostics: {} }),
      rss: () => {
        rssReadings += 1;
        const current = process.memoryUsage().rss;
        if (current > peakRss) peakRss = current;
        return current;
      },
      maximumRssBytes: baselineRss + budgetBytes,
    });

    t.diagnostic(
      `peak RSS growth ${((peakRss - baselineRss) / 1024 / 1024).toFixed(1)} MiB `
        + `of the ${(budgetBytes / 1024 / 1024).toFixed(0)} MiB budget`,
    );
    assert.ok(
      rssReadings > 50,
      `the RSS guard must meter the streamed corpus (saw ${rssReadings} readings)`,
    );
    assert.equal(cache.weeklyCalibrationInput.source, "unified_index");
    assert.equal(cache.weeklyCalibrationInput.retainedUsageEvents, 300_000);
    // 999 percent changes per reset window x 6 windows: the whole series was
    // derived, none of it discarded to fit the budget.
    assert.equal(
      cache.weeklyCalibration.sourceCounts.weeklyTransitions,
      5_994,
    );
    assert.ok(
      peakRss - baselineRss <= budgetBytes,
      `peak RSS growth ${((peakRss - baselineRss) / 1024 / 1024).toFixed(1)} MiB exceeded the scaled budget`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
