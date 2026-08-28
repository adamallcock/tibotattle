// Deep-dive coverage for the speed-mode resolution order in
// packages/accounting/src/subscription-speed.js and the Fast credit
// multipliers it publishes, on top of the end-to-end coverage already in
// test/fast-mode-accounting.test.js.
//
// The documented order, strongest evidence first, is:
//   observed > declared_codex_config > assumed_from_preference > inferred > unknown
// This file proves the FULL cascade holds together (not just adjacent
// pairs), that observation is undefeated even under unanimous disagreement
// from every other signal, that "unknown" is never silently promoted to
// Standard, and that the published Fast multipliers are exact rather than
// defaulting to 1x for anything unrecognised.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAST_MODE_QUOTA_MULTIPLIERS,
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
  resolveEffectiveSpeedMode,
} from "@app-usagemonitor/accounting";
import {
  SPEED_MODE_PROVENANCE_VALUES,
  fastModeModelFamily,
} from "../packages/accounting/src/subscription-speed.js";

test("the provenance vocabulary matches the documented five-step order", () => {
  assert.deepEqual([...SPEED_MODE_PROVENANCE_VALUES], [
    "observed",
    "declared_codex_config",
    "assumed_from_preference",
    "inferred",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(SPEED_MODE_PROVENANCE_VALUES), true);
});

test("the full waterfall resolves to the strongest signal actually present", () => {
  const scenarios = [
    {
      label: "observed beats declared, preference, and inference all at once",
      input: {
        observedMode: "fast",
        declaredMode: "standard",
        preference: "standard",
        inferredMode: "standard",
      },
      expected: { mode: "fast", provenance: "observed" },
    },
    {
      label: "declared wins once observed is absent, beating preference and inference",
      input: {
        observedMode: "unknown",
        declaredMode: "fast",
        preference: "standard",
        inferredMode: "standard",
      },
      expected: { mode: "fast", provenance: "declared_codex_config" },
    },
    {
      label: "preference wins once observed and declared are both absent",
      input: {
        observedMode: "unknown",
        declaredMode: "unknown",
        preference: "fast",
        inferredMode: "standard",
      },
      expected: { mode: "fast", provenance: "assumed_from_preference" },
    },
    {
      label: "inference is reached only once the preference is mixed_unknown",
      input: {
        observedMode: "unknown",
        declaredMode: "unknown",
        preference: "mixed_unknown",
        inferredMode: "fast",
      },
      expected: { mode: "fast", provenance: "inferred" },
    },
    {
      label: "nothing legitimate to say resolves to an explicit unknown",
      input: {
        observedMode: "unknown",
        declaredMode: "unknown",
        preference: "mixed_unknown",
        inferredMode: "unknown",
      },
      expected: { mode: "unknown", provenance: "unknown" },
    },
  ];
  for (const { label, input, expected } of scenarios) {
    assert.deepEqual({ ...resolveEffectiveSpeedMode(input) }, expected, label);
  }
});

test("declared beats both preference and inference simultaneously, not just preference alone", () => {
  // Every signal below "declared" disagrees with it, in both directions.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "fast",
      preference: "standard",
      inferredMode: "standard",
    }) },
    { mode: "fast", provenance: "declared_codex_config" },
  );
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "standard",
      preference: "fast",
      inferredMode: "fast",
    }) },
    { mode: "standard", provenance: "declared_codex_config" },
  );
});

test("an observation is undefeated even under unanimous disagreement from every other signal", () => {
  // Declared, preference, and inferred all say "fast"; the log says
  // "standard" and must still win outright.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "standard",
      declaredMode: "fast",
      preference: "fast",
      inferredMode: "fast",
    }) },
    { mode: "standard", provenance: "observed" },
  );
  // And the mirror image: everything else says "standard", the log says
  // "fast".
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "fast",
      declaredMode: "standard",
      preference: "standard",
      inferredMode: "standard",
    }) },
    { mode: "fast", provenance: "observed" },
  );
});

test("unknown is never silently promoted to Standard, at any level", () => {
  // The all-unknown/all-absent case: an explicit unknown, not a default
  // Standard reading, even though the *preference* parameter's own default
  // is Standard - that default only applies once it's actually consulted.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "unknown",
      preference: "mixed_unknown",
      inferredMode: "unknown",
    }) },
    { mode: "unknown", provenance: "unknown" },
  );
  // Garbage in the observed slot must not be treated as if it said
  // "standard" - it must fall through to the next tier exactly like
  // "unknown" would, never short-circuit as an observation.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "some-future-tier-name",
      preference: "fast",
    }) },
    { mode: "fast", provenance: "assumed_from_preference" },
  );
  // Garbage in the preference slot must not be coerced into "standard"
  // either; it must fall through to inference/unknown like any other
  // non-"standard"/"fast" value.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "unknown",
      preference: "eco-mode",
      inferredMode: "fast",
    }) },
    { mode: "fast", provenance: "inferred" },
  );
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "unknown",
      preference: "eco-mode",
      inferredMode: "unknown",
    }) },
    { mode: "unknown", provenance: "unknown" },
  );
  // Garbage in the declared slot must not be treated as a real declaration.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "priority", // the raw provider token, not a mapped mode
      preference: "standard",
    }) },
    { mode: "standard", provenance: "assumed_from_preference" },
  );
});

// ---------------------------------------------------------------------------
// Fast credit multipliers: exact values, exact family membership, and an
// explicit null - never a silent 1x - for anything outside the three
// published families.
// ---------------------------------------------------------------------------

test("the bare published family names each resolve to their exact multiplier", () => {
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.6"), 2.5), true);
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.5"), 2.5), true);
  assert.equal(Object.is(fastModeQuotaMultiplier("gpt-5.4"), 2), true);
  assert.equal(fastModeModelFamily("gpt-5.6"), "gpt-5.6");
  assert.equal(fastModeModelFamily("gpt-5.5"), "gpt-5.5");
  assert.equal(fastModeModelFamily("gpt-5.4"), "gpt-5.4");
});

test("a model outside the three published families is an explicit null, never 1x", () => {
  for (const model of [
    "gpt-5.6future",
    "gpt-5.60",
    "gpt-5.40",
    "gpt-4.1",
    "gpt-4o",
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
  // A "-" suffixed variant of a real family DOES count as a member, however
  // the suffix continues, because family matching is "exact name, then
  // end-of-string or a '-' boundary" - the suffix content itself is not
  // validated further.
  assert.equal(fastModeQuotaMultiplier("gpt-5.6-sol"), 2.5);
  assert.equal(fastModeQuotaMultiplier("gpt-5.4-turbo-preview-not-real"), 2);
  // ...but a bare numeric continuation of the family name does not, because
  // it is a different, unpublished model, not a "-" suffix of "gpt-5.6" -
  // there is no boundary character between the family name and the extra
  // digit.
  assert.equal(fastModeQuotaMultiplier("gpt-5.60"), null);
});

test("fastModeModelFamilyKey buckets unsupported models explicitly rather than dropping them", () => {
  assert.equal(fastModeModelFamilyKey("gpt-5.6"), "gpt-5.6");
  assert.equal(fastModeModelFamilyKey("gpt-5.5-codex"), "gpt-5.5");
  assert.equal(fastModeModelFamilyKey("gpt-5.4-codex"), "gpt-5.4");
  assert.equal(fastModeModelFamilyKey("gpt-4.1"), "unsupported");
  assert.equal(fastModeModelFamilyKey(null), "unsupported");
});

test("the published multiplier map holds exactly the three documented rates", () => {
  assert.deepEqual({ ...FAST_MODE_QUOTA_MULTIPLIERS }, {
    "gpt-5.6": 2.5,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
  });
  // Every multiplier is strictly greater than 1x: Fast never costs less
  // quota than Standard, and is never accidentally recorded as 1x (which
  // would make it indistinguishable from "unknown treated as Standard").
  for (const multiplier of Object.values(FAST_MODE_QUOTA_MULTIPLIERS)) {
    assert.equal(multiplier > 1, true);
  }
});
