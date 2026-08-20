import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatQuotaWindowDuration,
  quotaWindowLabel,
  selectPrimaryQuotaWindow,
} from "@app-usagemonitor/quota-analysis";
import {
  canonicalRateLimitWindows,
  createLeadingRateLimitGate,
} from "../src/providers/codex/log-normalization.js";
import {
  normalizeProviderPlanType,
  sanitizeProviderPlanLabel,
} from "../src/providers/codex/plan-normalization.js";
import { normalizeProviderQuotaWindow } from "../src/providers/codex/quota-normalization.js";

const FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/provider-quota-windows-v1.json", import.meta.url),
  "utf8",
));

test("provider fixtures retain exact named durations and admit a 30-day-like window", () => {
  const windows = FIXTURE.rateLimits.flatMap((rateLimits) => (
    canonicalRateLimitWindows(rateLimits)
  ));

  assert.deepEqual(
    windows.map((window) => [window.limitId, window.slot, window.planType, window.windowDurationMins]),
    [
      ["codex", "primary", "pro", 300],
      ["codex", "secondary", "pro", 10_080],
      ["codex", "primary", "unknown", 43_200],
      ["codex_bengalfox", "primary", "unknown", 525_600],
      // The Spark limit's re-introduced shape, exactly as observed on the
      // wire 2026-08-19: the 5-hour window in the limit's primary slot with
      // the Spark seven-day window alongside in secondary. Both durations
      // survive normalization verbatim so display code can name them.
      ["codex_bengalfox", "primary", "pro", 300],
      ["codex_bengalfox", "secondary", "pro", 10_080],
    ],
  );
  assert.equal(Object.hasOwn(windows[2], "planVariant"), false);
  assert.equal(Object.hasOwn(windows[2], "multiplier"), false);

  const primary = selectPrimaryQuotaWindow(windows);
  // The Spark limit's 300-minute window never joins the normal Codex
  // allowance selection even from a primary slot: selection is bound to the
  // "codex" limit id, not to slot names or durations.
  assert.equal(primary?.limitId, "codex");
  assert.equal(primary?.windowDurationMins, 43_200);
  assert.equal(formatQuotaWindowDuration(primary.windowDurationMins), "30-day");
  assert.equal(
    quotaWindowLabel("codex", primary.windowDurationMins),
    "Provider-reported 30-day window",
  );
  assert.doesNotMatch(quotaWindowLabel("codex", primary.windowDurationMins), /month/iu);
});

test("provider plan normalization is bounded and never infers a Pro multiplier", () => {
  assert.equal(sanitizeProviderPlanLabel(" Pro "), "pro");
  assert.equal(sanitizeProviderPlanLabel("business-preview"), "business-preview");
  assert.equal(sanitizeProviderPlanLabel("private owner@example.test"), null);
  assert.equal(normalizeProviderPlanType("pro"), "pro");
  assert.equal(normalizeProviderPlanType("pro-20x"), "unknown");
  assert.equal(normalizeProviderPlanType("provider-private-plan"), "unknown");
  assert.equal(normalizeProviderPlanType(null), "unknown");
});

test("invalid provider durations and resets fail closed", () => {
  for (const rateLimits of FIXTURE.invalidRateLimits) {
    assert.deepEqual(canonicalRateLimitWindows(rateLimits), []);
  }
  assert.equal(normalizeProviderQuotaWindow({
    usedPercent: 10,
    windowDurationMins: 43_200,
    resetsAt: 0,
  }), null);
});

test("leading-window identities retain duration and keep provider windows independent", () => {
  const window = (windowDurationMins, usedPercent) => ({
    provider: "openai_codex",
    limitId: "codex",
    slot: "primary",
    windowDurationMins,
    usedPercent,
    resetsAt: 1_785_456_360,
  });
  const gate = createLeadingRateLimitGate();

  assert.deepEqual(gate.offer(window(300, 10), 0, "five-hour-old"), {
    released: [],
    withheld: [],
  });
  assert.deepEqual(gate.offer(window(43_200, 20), 1, "provider-30-day"), {
    released: [],
    withheld: [],
  });
  assert.deepEqual(gate.offer(window(300, 30), 2, "five-hour-new"), {
    released: [],
    withheld: ["five-hour-old"],
  });
  assert.deepEqual(gate.flush().sort(), ["five-hour-new", "provider-30-day"]);
});
