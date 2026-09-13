import test from "node:test";
import assert from "node:assert/strict";
import { observationFreshness } from "../public/dashboard-ui.js";
const fresh = { latestObservedAt: "2026-09-13T12:00:00Z", ageSeconds: 60, staleAfterSeconds: 1800 };
test("observation freshness stays independent of accounting and running jobs", () => {
  for (const state of ["live", "stale", "updating", "insufficient"]) {
    assert.equal(observationFreshness({ state, freshness: { ...fresh, accountingStatus: "stale" } }), "current");
  }
  assert.equal(observationFreshness({ freshness: { ...fresh, ageSeconds: 1800 } }), "current");
  assert.equal(observationFreshness({ freshness: { ...fresh, ageSeconds: 1801 } }), "stale");
});
test("missing or invalid observation evidence never claims current", () => {
  for (const replacement of [{ latestObservedAt: null }, { latestObservedAt: "bad" }, { ageSeconds: null }, { ageSeconds: -1 }, { ageSeconds: "60" }, { staleAfterSeconds: undefined }, { staleAfterSeconds: -1 }]) {
    assert.equal(observationFreshness({ freshness: { ...fresh, ...replacement } }), "unknown");
  }
  assert.equal(observationFreshness(null), "unknown");
  assert.equal(observationFreshness({ mode: "demo", freshness: fresh }), "demo");
});
