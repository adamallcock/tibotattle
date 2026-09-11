import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";
import {
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { normalizeDashboardPayload, selectAllowancePlanPopulation } from "../apps/web/public/data-client.js";

// Serve-stale-labeled (2026-08-19). A cache whose semantic identity mismatches
// the current code — the exact state every updater enters, because a schema
// bump is how an accounting-semantics change announces itself — used to be
// withheld outright: "$0.00 / Historical event-time accounting changed" until
// the local rebuild landed, which takes a while at large-history scale. The
// prior artifact is now returned on an explicitly stale channel and served
// with provenance (the semantic version it was computed under and when),
// while the current-cache contract stays null so nothing can mistake it for
// current. These tests pin the read channel, the snapshot projections and
// their provenance, the banner replacement, the fresh-account non-regression,
// and the retention/atomic-swap lifecycle around the rebuild.

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const OUTDATED_SCHEMA_VERSION = "local-replay-safe-accounting-v0.11";
const WITHHELD_SENTENCE =
  "Historical event-time accounting changed. The prior cache is withheld until the next local replay rebuilds it.";

// An estimator-worthy corpus scan: four weekly reset windows whose displayed
// percent advances a whole point per hourly boundary, with usage rows between
// boundaries. Small enough for an in-process refresh, rich enough that the
// weekly calibration reaches "estimated" and every allowance scenario fits —
// so the stale serve below carries REAL projections, not empty summaries.
function estimatorWorthyScan({
  resetStarts = Array.from(
    { length: 4 },
    (_, week) => Date.parse("2026-05-07T00:00:00.000Z") + week * WEEK_MS,
  ),
  boundariesPerReset = 100,
  usagePerBoundary = 2,
} = {}) {
  return async ({ onUsage, onRateLimitSnapshot }) => {
    for (const [resetIndex, resetStartMs] of resetStarts.entries()) {
      const slot = resetIndex * 2 < resetStarts.length
        ? "secondary"
        : "primary";
      for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
        const observedAtMs = resetStartMs + boundary * 60 * 60_000;
        onRateLimitSnapshot({
          timestamp: new Date(observedAtMs).toISOString(),
          timestampMs: observedAtMs,
          window: {
            provider: "openai_codex",
            planType: "pro",
            limitId: "codex",
            slot,
            windowDurationMins: 10_080,
            resetsAt: Math.floor((resetStartMs + WEEK_MS) / 1_000),
            usedPercent: boundary,
          },
        });
        for (let step = 0; step < usagePerBoundary; step += 1) {
          onUsage({
            timestamp: new Date(
              observedAtMs + 10_000 + step * 5_000,
            ).toISOString(),
            model: step % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
            components: {
              input_uncached_tokens: 400_000 + boundary * 1_000,
              input_cache_read_tokens: 20_000,
              input_cache_write_tokens: 0,
              output_text_tokens: 900,
              output_reasoning_tokens: 1_200,
              output_combined_tokens: 0,
            },
            tierSemantics: {
              codexSpeedMode: step % 2 === 0 ? "standard" : "fast",
              apiServiceTier: "unknown",
            },
          });
        }
      }
    }
    return { diagnostics: {} };
  };
}

// A real current cache, built through the production refresh, then re-stored
// with only its semantic version flipped to a prior release's tag. Every
// projection inside stays exactly what the estimator produced, which is what
// an updater's on-disk cache looks like: sound content, outdated identity.
async function writeOutdatedPriorCache(stateFile) {
  const current = await refreshReplaySafeAccountingCache({
    stateFile,
    now: () => NOW - 60 * 60_000,
    scan: estimatorWorthyScan(),
  });
  assert.equal(current.weeklyCalibration.status, "estimated");
  const outdated = {
    ...structuredClone(current),
    schemaVersion: OUTDATED_SCHEMA_VERSION,
  };
  await writeLocalCollectorAccountingCache({ stateFile, cache: outdated });
  return outdated;
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-stale-serve-"));
  await mkdir(join(root, ".usage-monitor"), { recursive: true });
  return root;
}

function snapshotOptions(root, stateFile) {
  return {
    root,
    collectorStateFile: stateFile,
    allowDevelopmentArtifactFallback: true,
    now: () => NOW,
  };
}

test("a semantics-outdated cache is returned on the explicit stale channel with provenance", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const outdated = await writeOutdatedPriorCache(stateFile);
    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "unavailable");
    assert.equal(read.errorCode, "cache_accounting_semantics_outdated");
    // The current-cache contract stays null: no caller can mistake the stale
    // artifact for a current one.
    assert.equal(read.cache, null);
    assert.equal(read.staleCache.stale, true);
    assert.equal(read.staleCache.schemaVersion, OUTDATED_SCHEMA_VERSION);
    assert.equal(read.staleCache.computedAt, outdated.generatedAt);
    assert.deepEqual(read.staleCache.coveredAt, outdated.coveredAt);
    assert.deepEqual(read.staleCache.cache, outdated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a price-registry-outdated cache stays fully withheld: no stale channel", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const current = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW - 60 * 60_000,
      scan: estimatorWorthyScan(),
    });
    await writeLocalCollectorAccountingCache({
      stateFile,
      cache: {
        ...structuredClone(current),
        priceRegistryVersion: "price-registry-superseded-test",
      },
    });
    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "unavailable");
    assert.equal(read.errorCode, "cache_price_registry_outdated");
    assert.equal(read.cache, null);
    // Outdated prices are wrong figures, not merely differently derived ones;
    // they are never served, stale-labeled or otherwise.
    assert.equal(Object.hasOwn(read, "staleCache"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the snapshot serves stale-labeled cost, allowance, and capacity projections instead of empty panels", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const outdated = await writeOutdatedPriorCache(stateFile);
    const snapshot = await buildLocalCompanionSnapshot(
      snapshotOptions(root, stateFile),
    );
    // The machine-readable verdict on the CURRENT cache stays honest.
    assert.equal(
      snapshot.overview.freshness.accountingStatus,
      "unavailable",
    );
    // Cost view: the prior-version per-period headline scalars, labeled.
    const staleServe = snapshot.overview.accounting.staleServe;
    assert.equal(staleServe.stale, true);
    assert.equal(staleServe.schemaVersion, OUTDATED_SCHEMA_VERSION);
    assert.equal(staleServe.computedAt, outdated.generatedAt);
    assert.deepEqual(staleServe.coveredAt, outdated.coveredAt);
    const staleAll = staleServe.periods.find(
      (period) => period.periodId === "all",
    );
    const priorAll = outdated.periods.find((period) => period.id === "all");
    assert.deepEqual(staleAll, {
      periodId: "all",
      periodLabel: priorAll.label,
      events: priorAll.events,
      totalTokens: priorAll.totalTokens,
      apiPriceEquivalentUsd: priorAll.apiPriceEquivalentUsd,
    });
    assert.ok(staleAll.events > 0);
    assert.ok(staleAll.apiPriceEquivalentUsd > 0);
    // Allowance estimate: served from the stale calibration with provenance,
    // not "insufficient evidence".
    assert.equal(snapshot.weekly.status, "available");
    assert.equal(snapshot.weekly.stale.stale, true);
    assert.equal(snapshot.weekly.stale.schemaVersion, OUTDATED_SCHEMA_VERSION);
    // The weekly panel serves the forced allowance scenario, not the
    // diagnostic model-selection summary — same as a current cache.
    assert.equal(
      snapshot.weekly.datasets.summary[0].median_weekly_value_usd,
      outdated.allowanceCapacityByScenario.scenarios.unresolved_as_standard
        .calibration.estimate.medianApiPriceEquivalentUsd,
    );
    // Trends comparability: the capacity behind the expected line is served
    // from the stale calibration with the same provenance.
    const capacity = snapshot.overview.timeline.allowanceCapacity;
    assert.equal(capacity.status, "available");
    assert.equal(capacity.planScope, null, "a stale scalar cannot claim a current plan/generation scope");
    assert.equal(capacity.stale.stale, true);
    assert.equal(capacity.stale.schemaVersion, OUTDATED_SCHEMA_VERSION);
    assert.ok(
      capacity.scenarios.unresolved_as_standard.medianCapacityUsd > 0,
    );
    const dashboard = normalizeDashboardPayload({
      ...snapshot.overview, weekly: snapshot.weekly,
    });
    assert.equal(dashboard.timeline.allowanceCapacity.status, "available");
    assert.equal(dashboard.timeline.allowanceCapacity.stale.stale, true);
    assert.equal(dashboard.timeline.allowanceCapacity.planScope, null);
    assert.equal(selectAllowancePlanPopulation(dashboard).allowancePlanSelection.comparisonAvailable, false,
      "a legacy stale scalar must not supply a current selected-plan comparison");
    // The alert-styled withheld banner is replaced by the quiet label.
    assert.ok(!snapshot.overview.warnings.includes(WITHHELD_SENTENCE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale capacity accepts absent legacy scope but rejects contradictory supplied scope", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const outdated = await writeOutdatedPriorCache(stateFile);
    const unscoped = structuredClone(outdated);
    delete unscoped.allowanceCapacityByScenario.planScope;
    await writeLocalCollectorAccountingCache({ stateFile, cache: unscoped });
    const legacy = await buildLocalCompanionSnapshot(snapshotOptions(root, stateFile));
    assert.equal(legacy.overview.timeline.allowanceCapacity.status, "available");
    assert.equal(legacy.overview.timeline.allowanceCapacity.planScope, null);
    assert.equal(legacy.overview.timeline.allowanceCapacity.stale.stale, true);
    const conflicting = structuredClone(outdated);
    conflicting.allowanceCapacityByScenario.planScope.cohortId = "f".repeat(64);
    await writeLocalCollectorAccountingCache({ stateFile, cache: conflicting });
    const refused = await buildLocalCompanionSnapshot(snapshotOptions(root, stateFile));
    assert.equal(refused.overview.timeline.allowanceCapacity.status, "unavailable");
    assert.equal(refused.overview.timeline.allowanceCapacity.planScope, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh account with no prior cache keeps today's honest empty states", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const snapshot = await buildLocalCompanionSnapshot(
      snapshotOptions(root, stateFile),
    );
    assert.equal(snapshot.overview.accounting.staleServe, null);
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(Object.hasOwn(snapshot.weekly, "stale"), false);
    assert.equal(
      snapshot.overview.timeline.allowanceCapacity.status,
      "unavailable",
    );
    assert.equal(
      Object.hasOwn(snapshot.overview.timeline.allowanceCapacity, "stale"),
      false,
    );
    assert.ok(!snapshot.overview.warnings.includes(WITHHELD_SENTENCE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the stale cache survives a failed rebuild and is atomically replaced by a successful one", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const outdated = await writeOutdatedPriorCache(stateFile);
    // A rebuild that misses its memory budget defers; control never reaches
    // the write, so the stale artifact must survive byte-for-byte and the
    // stale-labeled serve must remain in place.
    const deferred = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW,
      maximumRssBytes: 100,
      rss: (() => {
        const samples = [50, 50];
        return () => samples.shift() ?? 101;
      })(),
      scan: estimatorWorthyScan(),
    });
    assert.equal(deferred.status, "accounting_rebuild_deferred");
    const retained = await readLocalCollectorAccountingCache({ stateFile });
    assert.deepEqual(retained.cache, outdated);
    const staleSnapshot = await buildLocalCompanionSnapshot(
      snapshotOptions(root, stateFile),
    );
    assert.equal(
      staleSnapshot.overview.accounting.staleServe.schemaVersion,
      OUTDATED_SCHEMA_VERSION,
    );
    assert.equal(staleSnapshot.weekly.stale.stale, true);
    // The successful rebuild publishes the new artifact in one transactional
    // replace: the stale copy exists until the commit and not after it, and
    // the served projections flip from stale-labeled to current.
    const rebuilt = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW,
      scan: estimatorWorthyScan(),
    });
    assert.equal(rebuilt.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
    const swapped = await readLocalCollectorAccountingCache({ stateFile });
    assert.deepEqual(swapped.cache, rebuilt);
    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "available");
    assert.equal(Object.hasOwn(read, "staleCache"), false);
    const currentSnapshot = await buildLocalCompanionSnapshot(
      snapshotOptions(root, stateFile),
    );
    assert.equal(currentSnapshot.overview.accounting.staleServe, null);
    assert.equal(currentSnapshot.weekly.status, "available");
    assert.equal(Object.hasOwn(currentSnapshot.weekly, "stale"), false);
    assert.equal(
      Object.hasOwn(
        currentSnapshot.overview.timeline.allowanceCapacity,
        "stale",
      ),
      false,
    );
    assert.equal(
      currentSnapshot.overview.freshness.accountingStatus,
      "available",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
