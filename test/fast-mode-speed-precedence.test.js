// Deep-dive coverage for the speed-mode resolution order in
// packages/accounting/src/subscription-speed.js and the Priority (Fast)
// price ratios it publishes, on top of the end-to-end coverage already in
// test/fast-mode-accounting.test.js.
//
// The documented order, strongest evidence first, is:
//   observed > declared_codex_config > scenario default
// where the scenario default attributes turns with no evidence to Standard
// (or to Fast under the explicit unresolved-as-Fast sensitivity scenario).
// This file proves the FULL cascade holds together (not just adjacent
// pairs), that observation is undefeated even under unanimous disagreement
// from every other signal, that garbage values are never coerced into a
// mode, and that the published Priority (Fast) price ratios are exact rather
// than defaulting to 1x for anything unrecognised.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_UNRESOLVED_SPEED_SCENARIO,
  FAST_MODE_ASSUMED_MULTIPLIER,
  FAST_MODE_QUOTA_MULTIPLIERS,
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
  resolveEffectiveSpeedMode,
} from "@app-usagemonitor/accounting";
import {
  SPEED_MODE_PROVENANCE_VALUES,
  UNRESOLVED_SPEED_SCENARIOS,
  fastModeModelFamily,
} from "../packages/accounting/src/subscription-speed.js";

test("the provenance vocabulary matches the documented order", () => {
  assert.deepEqual([...SPEED_MODE_PROVENANCE_VALUES], [
    "observed",
    "declared_codex_config",
    "assumed_standard_default",
    "assumed_fast_scenario",
    "inferred",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(SPEED_MODE_PROVENANCE_VALUES), true);
  assert.deepEqual([...UNRESOLVED_SPEED_SCENARIOS], [
    "unresolved_as_standard",
    "unresolved_as_fast",
  ]);
  assert.equal(DEFAULT_UNRESOLVED_SPEED_SCENARIO, "unresolved_as_standard");
});

test("the full waterfall resolves to the strongest signal actually present", () => {
  const scenarios = [
    {
      label: "observed beats declared and the fast scenario all at once",
      input: {
        observedMode: "fast",
        declaredMode: "standard",
        unresolvedScenario: "unresolved_as_standard",
      },
      expected: { mode: "fast", provenance: "observed" },
    },
    {
      label: "declared wins once observed is absent, beating the scenario",
      input: {
        observedMode: "unknown",
        declaredMode: "fast",
        unresolvedScenario: "unresolved_as_standard",
      },
      expected: { mode: "fast", provenance: "declared_codex_config" },
    },
    {
      label: "the default scenario attributes the residual to Standard",
      input: {
        observedMode: "unknown",
        declaredMode: "unknown",
      },
      expected: { mode: "standard", provenance: "assumed_standard_default" },
    },
    {
      label: "the fast sensitivity scenario re-attributes the same residual",
      input: {
        observedMode: "unknown",
        declaredMode: "unknown",
        unresolvedScenario: "unresolved_as_fast",
      },
      expected: { mode: "fast", provenance: "assumed_fast_scenario" },
    },
  ];
  for (const { label, input, expected } of scenarios) {
    assert.deepEqual({ ...resolveEffectiveSpeedMode(input) }, expected, label);
  }
});

test("declared beats the scenario in both directions, not just one", () => {
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "fast",
      unresolvedScenario: "unresolved_as_standard",
    }) },
    { mode: "fast", provenance: "declared_codex_config" },
  );
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "standard",
      unresolvedScenario: "unresolved_as_fast",
    }) },
    { mode: "standard", provenance: "declared_codex_config" },
  );
});

test("an observation is undefeated even under unanimous disagreement from every other signal", () => {
  // Declared and the scenario both say "fast"; the log says "standard" and
  // must still win outright.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "standard",
      declaredMode: "fast",
      unresolvedScenario: "unresolved_as_fast",
    }) },
    { mode: "standard", provenance: "observed" },
  );
  // And the mirror image: everything else says "standard", the log says
  // "fast".
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "fast",
      declaredMode: "standard",
      unresolvedScenario: "unresolved_as_standard",
    }) },
    { mode: "fast", provenance: "observed" },
  );
});

test("garbage values are never coerced into a mode or a scenario", () => {
  // Garbage in the observed slot must not be treated as if it said
  // "standard" - it must fall through to the next tier exactly like
  // "unknown" would, never short-circuit as an observation.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "some-future-tier-name",
      declaredMode: "fast",
    }) },
    { mode: "fast", provenance: "declared_codex_config" },
  );
  // Garbage in the declared slot must not be treated as a real declaration.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "priority", // the raw provider token, not a mapped mode
    }) },
    { mode: "standard", provenance: "assumed_standard_default" },
  );
  // Garbage in the scenario slot degrades to the default Standard scenario
  // rather than inventing a Fast attribution.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "unknown",
      unresolvedScenario: "eco-mode",
    }) },
    { mode: "standard", provenance: "assumed_standard_default" },
  );
});

// ---------------------------------------------------------------------------
// Priority (Fast) price ratios: exact values, exact family membership, and an
// explicit null - never a silent published claim - for anything outside the
// registered Priority models. The weighting layers apply the disclosed assumed
// multiplier to those instead.
// ---------------------------------------------------------------------------

test("the bare published family names each resolve to their exact ratio", () => {
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.6-sol"), 2), true);
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.5"), 2.5), true);
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.4"), 2), true);
  assert.equal(fastModeModelFamily("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(fastModeModelFamily("gpt-5.5"), "gpt-5.5");
  assert.equal(fastModeModelFamily("gpt-5.4"), "gpt-5.4");
});

test("an unregistered model or missing Priority model is an explicit null, never 1x", () => {
  for (const model of [
    "gpt-5.6future",
    "gpt-5.60",
    "gpt-5.40",
    "gpt-5.6",
    "gpt-5.5-pro",
    "o3",
    "",
    "GPT-5.6",
    null,
    undefined,
    42,
  ]) {
    const multiplier = fastModeQuotaMultiplier(model);
    assert.equal(multiplier, null, `expected null for ${JSON.stringify(model)}`);
    assert.notEqual(multiplier, 1, `must not silently default to 1x for ${JSON.stringify(model)}`);
  }
  // A suffix is eligible only if its exact model or reviewed alias has a
  // Priority card. Invented variants must not borrow a nearby model's rate.
  assert.equal(fastModeQuotaMultiplier("gpt-5.6-sol"), 2);
  assert.equal(fastModeQuotaMultiplier("gpt-5.4-turbo-preview-not-real"), null);
  assert.equal(fastModeQuotaMultiplier("gpt-4.1"), 1.75);
  assert.equal(fastModeQuotaMultiplier("gpt-4o"), 1.7);
  // ...but a bare numeric continuation of the family name does not, because
  // it is a different, unpublished model, not a "-" suffix of "gpt-5.6-sol" -
  // there is no boundary character between the family name and the extra
  // digit.
  assert.equal(fastModeQuotaMultiplier("gpt-5.60"), null);
});

test("fastModeModelFamilyKey buckets unsupported models explicitly rather than dropping them", () => {
  assert.equal(fastModeModelFamilyKey("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(fastModeModelFamilyKey("gpt-5.5-codex"), "gpt-5.5");
  assert.equal(fastModeModelFamilyKey("gpt-5.4-codex"), "unsupported");
  assert.equal(fastModeModelFamilyKey("gpt-4.1"), "gpt-4.1");
  assert.equal(fastModeModelFamilyKey(null), "unsupported");
});

test("the ratio map holds every registered published Priority model", () => {
  assert.deepEqual({ ...FAST_MODE_QUOTA_MULTIPLIERS }, {
    "gpt-4.1": 1.75,
    "gpt-4.1-mini": 1.75,
    "gpt-4.1-nano": 2,
    "gpt-4o": 1.7,
    "gpt-5": 2,
    "gpt-5-mini": 1.8,
    "gpt-5.1": 2,
    "gpt-5.1-codex": 2,
    "gpt-5.2": 2,
    "gpt-5.4-mini": 2,
    "gpt-5.6-luna": 2,
    "gpt-5.6-sol": 2,
    "gpt-5.6-terra": 2,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
  });
  // Every ratio is strictly greater than 1x: Fast never costs less quota
  // than Standard, and is never accidentally recorded as 1x (which would
  // make it indistinguishable from "unknown treated as Standard"). The
  // assumed multiplier for unlisted models obeys the same rule.
  for (const multiplier of Object.values(FAST_MODE_QUOTA_MULTIPLIERS)) {
    assert.equal(multiplier > 1, true);
  }
  assert.equal(FAST_MODE_ASSUMED_MULTIPLIER > 1, true);
});
