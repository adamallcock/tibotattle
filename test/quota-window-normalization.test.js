import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatQuotaWindowDuration,
  quotaWindowLabel,
  selectPrimaryQuotaWindow,
} from "@app-usagemonitor/quota-analysis";
import {
  canonicalRateLimitSnapshot,
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
  assert.equal(windows[0].limitName, "Codex allowance");
  assert.equal(windows[1].limitName, "Codex allowance");

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

test("windowless Codex snapshots remain valid while malformed windows fail closed", () => {
  const windowless = {
    limit_id: "codex",
    limit_name: "Codex allowance",
    primary: null,
    secondary: null,
    credits: { has_credits: true, unlimited: false, balance: null },
    individual_limit: null,
    spend_control_reached: false,
    plan_type: "plus",
    rate_limit_reached_type: null,
  };
  assert.deepEqual(canonicalRateLimitSnapshot(windowless), { windows: [] });
  assert.deepEqual(canonicalRateLimitWindows(windowless), []);
  assert.equal(canonicalRateLimitSnapshot({}), null);
  assert.equal(canonicalRateLimitSnapshot({
    limit_id: "codex",
    primary: { used_percent: 10, window_minutes: 0, resets_at: 1_785_456_360 },
  }), null);
});

test("provider plan normalization is bounded and never infers a Pro multiplier", () => {
  assert.equal(sanitizeProviderPlanLabel(" Pro "), "pro");
  assert.equal(sanitizeProviderPlanLabel("business-preview"), "business-preview");
  assert.equal(sanitizeProviderPlanLabel("private owner@example.test"), null);
  assert.equal(normalizeProviderPlanType("pro"), "pro");
  assert.equal(normalizeProviderPlanType("edu_plus"), "edu_plus");
  assert.equal(normalizeProviderPlanType("edu_pro"), "edu_pro");
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
