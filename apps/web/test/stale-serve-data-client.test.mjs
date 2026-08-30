import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDashboardPayload } from "../public/data-client.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

// Serve-stale-labeled (2026-08-19): projections computed by the previous app
// version are served during the post-update recalculation, each carrying an
// explicit staleness provenance block. These tests pin the data-client side
// of that contract: the provenance survives normalization on every surface
// that can serve stale (cost view, weekly allowance, trends capacity), and an
// unlabeled block is dropped rather than rendered as current.

const ALLOWANCE_BASIS_FAMILY =
  "codex_primary:speed_priced_api_equivalent:v2:priority_price_ratio_2026_08_30:event_time:observed_declared_scenario";
const allowanceBasisId = (scenario) =>
  `${ALLOWANCE_BASIS_FAMILY}:${scenario}`;

const STALE_PROVENANCE = {
  stale: true,
  reason: "cache_accounting_semantics_outdated",
  schemaVersion: "local-replay-safe-accounting-v0.11",
  computedAt: "2026-08-19T11:00:00.000Z",
  coveredAt: {
    startAt: "2026-05-07T00:00:00.000Z",
    endAt: "2026-08-19T11:00:00.000Z",
  },
};

function capacityScenario(scenario, medianCapacityUsd) {
  return {
    basisId: allowanceBasisId(scenario),
    medianCapacityUsd,
    plausibleRangeUsd: {
      lower: medianCapacityUsd * 0.8,
      upper: medianCapacityUsd * 1.2,
    },
    qualifyingResets: 10,
    cohortId:
      "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
    validation: {
      sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 2,
      priorResetMeanAbsoluteErrorPercentagePoints: 3,
      priorResetAbsoluteBiasPercentagePoints: 1,
      forecastErrorP80PercentagePoints: 5,
      scoredPriorResets: 8,
      scoredPriorPoints: 40,
    },
  };
}

function staleCapacity(stale = STALE_PROVENANCE) {
  return {
    status: "available",
    reason: null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY,
    selectedScenario: "unresolved_as_standard",
    scenarios: {
      unresolved_as_standard: capacityScenario("unresolved_as_standard", 100),
      unresolved_as_fast: capacityScenario("unresolved_as_fast", 250),
    },
    stale,
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  };
}

test("the stale cost-view serve survives normalization with its provenance, and unlabeled blocks are dropped", () => {
  const normalized = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      accountingCacheStatus: "unavailable",
      staleServe: {
        ...STALE_PROVENANCE,
        periods: [
          {
            periodId: "all",
            periodLabel: "Cached 365-day window",
            events: 4_242,
            totalTokens: 987_654,
            apiPriceEquivalentUsd: 1234.56,
          },
          // A row whose identity fails the closed period vocabulary is
          // refused; it never renders as an unlabeled figure.
          {
            periodId: "made-up",
            periodLabel: "Nope",
            events: 1,
            totalTokens: 1,
            apiPriceEquivalentUsd: 1,
          },
        ],
      },
    },
  });
  assert.deepEqual(normalized.accounting.staleServe, {
    ...STALE_PROVENANCE,
    periods: [{
      periodId: "all",
      periodLabel: "Cached 365-day window",
      events: 4_242,
      totalTokens: 987_654,
      apiPriceEquivalentUsd: 1234.56,
    }],
  });

  // Provenance is the admission ticket: a serve without its semantic version
  // is dropped entirely rather than shown as current.
  const unlabeled = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      staleServe: {
        stale: true,
        computedAt: "2026-08-19T11:00:00.000Z",
        periods: [{
          periodId: "all",
          periodLabel: "Cached 365-day window",
          events: 1,
          totalTokens: 1,
          apiPriceEquivalentUsd: 1,
        }],
      },
    },
  });
  assert.equal(unlabeled.accounting.staleServe, null);
  // Absent entirely on a current serve.
  const current = normalizeDashboardPayload({ mode: "real_local_evidence" });
  assert.equal(current.accounting.staleServe, null);
});

test("the trends capacity keeps its staleness provenance through normalization", () => {
  const normalized = normalizeDashboardPayload({
    mode: "real_local_evidence",
    timeline: { allowanceCapacity: staleCapacity() },
  });
  const capacity = normalized.timeline.allowanceCapacity;
  assert.equal(capacity.status, "available");
  assert.deepEqual(capacity.stale, STALE_PROVENANCE);
  assert.equal(
    capacity.scenarios.unresolved_as_standard.medianCapacityUsd,
    100,
  );

  const unmarked = normalizeDashboardPayload({
    mode: "real_local_evidence",
    timeline: { allowanceCapacity: staleCapacity(null) },
  });
  assert.equal(unmarked.timeline.allowanceCapacity.stale, null);
});

test("the weekly allowance keeps its staleness provenance through normalization", () => {
  const normalized = normalizeDashboardPayload({
    mode: "real_local_evidence",
    weekly: {
      status: "available",
      dataClass: "live_replay_safe_cache",
      stale: STALE_PROVENANCE,
      datasets: {
        summary: [{ median_weekly_value_usd: 112, qualifying_resets: 8 }],
      },
    },
  });
  assert.deepEqual(normalized.weekly.stale, STALE_PROVENANCE);
  assert.equal(normalized.weekly.summary.median_weekly_value_usd, 112);

  const current = normalizeDashboardPayload({
    mode: "real_local_evidence",
    weekly: {
      status: "available",
      dataClass: "live_replay_safe_cache",
      datasets: { summary: [{ median_weekly_value_usd: 112 }] },
    },
  });
  assert.equal(current.weekly.stale, null);
});

test("the recalculating label ships in all three dashboard languages", () => {
  for (const key of [
    "accounting.staleServe.recalculating",
    "accounting.staleServe.retrying",
    "accounting.staleServe.metricLabel",
  ]) {
    const localized = SUPPORTED_LOCALES.map(
      (locale) => translate(key, {}, locale),
    );
    for (const value of localized) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.trim().length > 0, key);
      // A locale falling back to the key itself means the entry is missing.
      assert.notEqual(value, key);
    }
    assert.equal(new Set(localized).size, SUPPORTED_LOCALES.length, key);
  }
});
