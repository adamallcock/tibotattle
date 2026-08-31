import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_ATTRIBUTION_POLICY,
  buildPlanAttributionIndex,
  classifyUsageAttribution,
  planAttributionContextKey,
  planAttributionObservationFromSnapshot,
  planEraForInterval,
} from "../packages/quota-analysis/index.js";

const contextKey = planAttributionContextKey("openai_codex", "codex");
const observation = (observedAtMs, planType = "pro", overrides = {}) => ({
  contextKey, observedAtMs, planType, planVariant: "unknown", ...overrides,
});
const usage = (observedAtMs, overrides = {}) => ({ contextKey, observedAtMs, ...overrides });

test("single-plan legacy history remains conditional, including before the first observation", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200)]);
  for (const time of [1, 100, 150, 200, 900]) {
    const result = classifyUsageAttribution(index, usage(time), { planType: "pro" });
    assert.equal(result.disposition, "legacy_conditional");
    assert.equal(result.era.planType, "pro");
    assert.equal(result.reason, "account_unresolved");
  }
  assert.deepEqual(index.eras.map((era) => [era.lowerBoundMs, era.upperBoundMs]), [[null, null]]);
  assert.equal(planEraForInterval(index, usage(1)).reason, "legacy_single_plan_history");
});

test("unknown plans do not create switches or erase usable legacy history", () => {
  const index = buildPlanAttributionIndex([
    observation(100), observation(150, "unknown"), observation(160, null),
    observation(200, "unavailable"), observation(300),
  ]);
  assert.equal(index.eras.length, 1);
  assert.equal(index.ignoredObservationCount, 3);
  assert.equal(classifyUsageAttribution(index, usage(180)).disposition, "legacy_conditional");
});

test("wholly unknown-plan history remains explicitly unknown and conditional", () => {
  const index = buildPlanAttributionIndex([observation(100, "unknown"), observation(200, null), observation(300, "unavailable")]);
  assert.equal(index.eras.length, 1);
  assert.equal(index.eras[0].planType, "unknown");
  for (const time of [50, 200, 400]) {
    const result = classifyUsageAttribution(index, usage(time));
    assert.equal(result.disposition, "legacy_conditional");
    assert.equal(result.planType, "unknown");
    assert.equal(classifyUsageAttribution(index, usage(time), { planType: "pro" }).disposition, "unresolved");
  }
});

test("explicit unknown-plan conflicts split known history instead of disappearing as missing evidence", () => {
  const rows = [observation(100), observation(200), observation(250, "unknown", { conflicted: true }),
    observation(300), observation(400)];
  const index = buildPlanAttributionIndex(rows);
  assert.equal(index.eras.length, 2);
  assert.notEqual(index.eras[0].eraKey, index.eras[1].eraKey);
  assert.equal(index.conflicts.length, 1);
  assert.equal(planEraForInterval(index, usage(250)).reason, "conflicting_quota_evidence");
  assert.equal(planEraForInterval(index, usage(350, { intervalStartMs: 150 })).status, "conflicted");
  assert.equal(classifyUsageAttribution(index, usage(350)).disposition, "legacy_conditional");
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).eras, index.eras);
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).conflicts, index.conflicts);
  const tied = buildPlanAttributionIndex([observation(100), observation(100, "unknown", { conflicted: true })]);
  assert.equal(tied.eras.length, 0);
  assert.equal(planEraForInterval(tied, usage(100)).status, "conflicted");
});

test("ordinary unknown history on either side of explicit conflicts remains useful and unknown", () => {
  const rows = [observation(100, "unknown"), observation(200, null),
    observation(250, "unknown", { conflicted: true }), observation(300, "unknown"),
    observation(400, "unavailable"), observation(450, "unknown", { conflicted: true }),
    observation(500, null), observation(600, "unknown")];
  const index = buildPlanAttributionIndex(rows);
  assert.deepEqual(index.eras.map((era) => [era.planType, era.firstObservedAtMs, era.lastObservedAtMs]), [
    ["unknown", 100, 200], ["unknown", 300, 400], ["unknown", 500, 600],
  ]);
  for (const time of [150, 350, 550]) {
    assert.equal(classifyUsageAttribution(index, usage(time)).disposition, "legacy_conditional");
  }
  assert.equal(planEraForInterval(index, usage(550, { intervalStartMs: 350 })).status, "conflicted");
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).eras, index.eras);
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).conflicts, index.conflicts);
});

test("the explicit conflict flag is typed and absent or false leaves legacy era identities unchanged", () => {
  for (const value of [null, "true", 1, {}]) {
    assert.throws(() => buildPlanAttributionIndex([observation(100, "unknown", { conflicted: value })]),
      /conflicted must be a boolean/u);
  }
  const legacy = buildPlanAttributionIndex([observation(100), observation(200)]);
  const explicitFalse = buildPlanAttributionIndex([observation(100, "pro", { conflicted: false }), observation(200)]);
  assert.deepEqual(explicitFalse.eras, legacy.eras);
  assert.equal(legacy.eras[0].eraKey, JSON.stringify([contextKey, null, "pro", "unknown", 100]));
  assert.equal(planAttributionObservationFromSnapshot({ observedAtMs: 100, planType: "unknown", conflicted: true },
    { contextKey }).conflicted, true);
});

test("Pro to Plus to Pro produces distinct eras even if reset labels are reused", () => {
  const index = buildPlanAttributionIndex([
    observation(100), observation(200), observation(300, "plus"),
    observation(400, "plus"), observation(500), observation(600),
  ]);
  assert.deepEqual(index.eras.map((era) => [era.planType, era.lowerBoundMs, era.upperBoundMs]), [
    ["pro", 100, 200], ["plus", 300, 400], ["pro", 500, null],
  ]);
  assert.notEqual(index.eras[0].eraKey, index.eras[2].eraKey);
  for (const time of [250, 450]) {
    assert.equal(classifyUsageAttribution(index, usage(time)).disposition, "unresolved");
  }
  assert.equal(planEraForInterval(index, usage(50)).reason, "outside_observed_history");
  assert.equal(classifyUsageAttribution(index, usage(700)).disposition, "legacy_conditional");
});

test("declared same-plan continuity changes and returns create distinct eras without account proof", () => {
  const rows = [
    observation(100, "pro", { continuityId: "era-a" }), observation(200, "pro", { continuityId: "era-a" }),
    observation(300, "pro", { continuityId: "era-b" }), observation(400, "pro", { continuityId: "era-b" }),
    observation(500, "pro", { continuityId: "era-a" }), observation(600, "pro", { continuityId: "era-a" }),
  ];
  const index = buildPlanAttributionIndex(rows);
  assert.deepEqual(index.eras.map((era) => era.continuityId), ["era-a", "era-b", "era-a"]);
  assert.notEqual(index.eras[0].eraKey, index.eras[2].eraKey);
  assert.equal(planEraForInterval(index, usage(350, { intervalStartMs: 150 })).status, "conflicted");
  assert.equal(classifyUsageAttribution(index, usage(550)).disposition, "legacy_conditional");
  assert.equal(index.eras[2].accountScopeId, null);
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).eras, index.eras);
});

test("tied continuity contradictions are deterministic and malformed continuity is rejected", () => {
  const rows = [observation(100, "pro", { continuityId: "era-a" }),
    observation(100, "pro", { continuityId: "era-b" }),
    observation(200, "pro", { continuityId: "era-b" })];
  const index = buildPlanAttributionIndex(rows);
  assert.equal(planEraForInterval(index, usage(100)).status, "conflicted");
  assert.deepEqual(buildPlanAttributionIndex([...rows].reverse()).conflicts, index.conflicts);
  for (const value of ["", "private path/record", "x".repeat(257), 42, {}]) {
    assert.throws(() => buildPlanAttributionIndex([observation(100, "pro", { continuityId: value })]),
      /bounded opaque token/u);
  }
  const legacy = buildPlanAttributionIndex([observation(100), observation(200)]);
  assert.equal(legacy.eras[0].continuityId, null);
  assert.equal(legacy.eras[0].eraKey, JSON.stringify([contextKey, null, "pro", "unknown", 100]));
});

test("switch anchors support point increments but not deltas spanning the uncertain gap", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200), observation(300, "plus"), observation(400, "plus")]);
  assert.equal(planEraForInterval(index, usage(200)).era.planType, "pro");
  assert.equal(planEraForInterval(index, usage(300)).era.planType, "plus");
  assert.equal(planEraForInterval(index, usage(300, { intervalStartMs: 200 })).reason, "plan_transition_interval");
  assert.equal(planEraForInterval(index, usage(400, { intervalStartMs: 300 })).era.planType, "plus");
  assert.equal(classifyUsageAttribution(index, usage(350, { intervalStartMs: 150 })).disposition, "unresolved");
});

test("same-time contradictions are deterministic and never choose the first input plan", () => {
  const rows = [observation(100), observation(200, "plus"), observation(200), observation(300), observation(400)];
  const forward = buildPlanAttributionIndex(rows);
  const reversed = buildPlanAttributionIndex([...rows].reverse());
  assert.deepEqual(forward.eras, reversed.eras);
  assert.deepEqual(forward.conflicts, reversed.conflicts);
  for (const time of [150, 200, 250]) {
    assert.equal(classifyUsageAttribution(forward, usage(time)).disposition, "unresolved");
  }
  assert.equal(planEraForInterval(forward, usage(300)).status, "matched");
  assert.equal(planEraForInterval(forward, usage(400, { intervalStartMs: 200 })).status, "conflicted");
  assert.equal(planEraForInterval(forward, usage(400, { intervalStartMs: 300 })).status, "matched");
});

test("duplicate evidence and input permutation do not create extra eras", () => {
  const rows = [observation(100), observation(200), observation(300, "plus"), observation(400, "plus")];
  const expected = buildPlanAttributionIndex(rows);
  for (const candidate of [[...rows, ...rows], [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    const actual = buildPlanAttributionIndex(candidate);
    assert.deepEqual(actual.eras, expected.eras);
    assert.deepEqual(actual.conflicts, expected.conflicts);
  }
});

test("all quota durations feed one plan-family context, but separate limit families do not conflict", () => {
  const snapshot = (time, plan, duration, limit = "codex") => planAttributionObservationFromSnapshot({
    provider: "openai_codex", limitId: limit, observedAtMs: time, planType: plan,
    windowDurationMinutes: duration, accountTrackId: "synthetic-provider-track",
  });
  const index = buildPlanAttributionIndex([
    snapshot(100, "pro", 10080), snapshot(200, "plus", 300), snapshot(300, "plus", 10080),
    snapshot(200, "pro", 300, "codex_bengalfox"),
  ]);
  assert.equal(index.eras.length, 3);
  assert.equal(planEraForInterval(index, usage(250)).era.planType, "plus");
  assert.equal(planEraForInterval(index, usage(250, { contextKey: "openai_codex|codex_bengalfox" })).era.planType, "pro");
  assert.equal(index.eras[0].accountScopeId, null);
});

test("only explicit comparable account scope can produce compatible attribution", () => {
  const index = buildPlanAttributionIndex([observation(100, "pro", { accountScopeId: "account-a" }), observation(200, "pro", { accountScopeId: "account-a" })]);
  const point = usage(150, { accountScopeId: "account-a", observedPlanType: "pro", quantityBasis: "reported-increment" });
  assert.equal(classifyUsageAttribution(index, point, { accountScopeId: "account-a", planType: "pro" }).disposition, "compatible");
  assert.equal(classifyUsageAttribution(index, { ...point, quantityBasis: "legacy-unknown" }).disposition, "legacy_conditional");
  assert.equal(classifyUsageAttribution(index, { ...point, quantityBasis: "reconstructed-counter-delta", intervalStartMs: 100 }).disposition, "compatible");
  assert.equal(classifyUsageAttribution(index, { ...point, quantityBasis: "reconstructed-counter-delta", intervalStartMs: 10 }).disposition, "legacy_conditional");
  assert.equal(classifyUsageAttribution(index, { ...point, quantityBasis: "reconstructed-counter-delta" }).disposition, "legacy_conditional");
});

test("positively excluded other-account activity does not poison scoped A, even at conflicting times", () => {
  const index = buildPlanAttributionIndex([
    observation(100, "pro", { accountScopeId: "account-a" }), observation(200, "pro", { accountScopeId: "account-a" }),
    observation(100, "plus", { accountScopeId: "account-b" }), observation(150, "pro", { accountScopeId: "account-b" }),
  ]);
  const target = { accountScopeId: "account-a", planType: "pro" };
  const excluded = classifyUsageAttribution(index, usage(125, { accountScopeId: "account-b" }), target);
  assert.equal(excluded.disposition, "incompatible");
  assert.equal(excluded.reason, "different_account");
  const admitted = classifyUsageAttribution(index, usage(125, {
    accountScopeId: "account-a", observedPlanType: "pro", quantityBasis: "reported-increment",
  }), target);
  assert.equal(admitted.disposition, "compatible");
});

test("unknown possible account quantities stay unresolved for a scoped numerator", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200)]);
  const result = classifyUsageAttribution(index, usage(150), { accountScopeId: "account-a", planType: "pro" });
  assert.equal(result.disposition, "unresolved");
  assert.equal(result.reason, "account_unresolved");
  assert.equal(classifyUsageAttribution(index, usage(150), { planType: "pro" }).disposition, "legacy_conditional");
});

test("an ending plan label cannot exclude an unbounded delta's possible other-plan quantity", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200)]);
  const target = { planType: "pro" };
  const unknown = classifyUsageAttribution(index, usage(150, { observedPlanType: "plus", quantityBasis: "legacy-unknown" }), target);
  assert.equal(unknown.disposition, "unresolved");
  assert.equal(unknown.reason, "usage_quantity_plan_unresolved");
  assert.equal(classifyUsageAttribution(index, usage(150, { observedPlanType: "plus", quantityBasis: "reported-increment" }), target).disposition, "incompatible");
  assert.equal(classifyUsageAttribution(index, usage(150, { observedPlanType: "plus", quantityBasis: "reconstructed-counter-delta", intervalStartMs: 100 }), target).disposition, "unresolved");
});

test("the second Pro era cannot copy usage from the first Pro era", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200), observation(300, "plus"), observation(400, "plus"), observation(500), observation(600)]);
  const target = { planType: "pro", eraKey: index.eras[2].eraKey };
  const result = classifyUsageAttribution(index, usage(150), target);
  assert.equal(result.disposition, "incompatible");
  assert.equal(result.reason, "different_era");
  assert.equal(classifyUsageAttribution(index, usage(550), target).disposition, "legacy_conditional");
});

test("an observation-only conflict is retained even when no fit could be built for it", () => {
  const index = buildPlanAttributionIndex([observation(100), observation(200), observation(250, "plus"), observation(300), observation(400)]);
  assert.equal(index.eras.length, 3);
  assert.equal(planEraForInterval(index, usage(350, { intervalStartMs: 150 })).reason, "plan_transition_interval");
});

test("invalid intervals fail without interpreting missing quantity as zero", () => {
  const index = buildPlanAttributionIndex([observation(100)]);
  for (const value of [usage(NaN), usage(Infinity), usage(100.5), usage(100, { intervalStartMs: 101 }), usage(100, { intervalStartMs: NaN })]) {
    assert.equal(classifyUsageAttribution(index, value).disposition, "unresolved");
  }
});

test("input, context, and era caps refuse the entire index instead of fitting a truncated prefix", () => {
  const rows = [observation(100), observation(200, "plus"), observation(300)];
  for (const [input, options] of [
    [rows, { maxObservations: 2 }], [rows, { maxEras: 2 }],
    [[...rows, observation(100, "pro", { contextKey: "other|codex" })], { maxContexts: 1 }],
  ]) {
    const index = buildPlanAttributionIndex(input, options);
    assert.equal(index.status, "limit_exceeded");
    assert.deepEqual(index.eras, []);
    assert.equal(index.contexts.size, 0);
    assert.equal(classifyUsageAttribution(index, usage(100)).disposition, "unresolved");
  }
  assert.equal(PLAN_ATTRIBUTION_POLICY.methodVersion, "plan-attribution-v1");
  assert.throws(() => buildPlanAttributionIndex([], { maxEras: 0 }), /positive safe integers/u);
});

test("snapshot conversion never promotes a legacy transport track to account evidence", () => {
  const converted = planAttributionObservationFromSnapshot({ provider: "openai_codex", limitId: "codex", observedAt: "2026-01-01T00:00:00.000Z", planType: "pro", accountTrackId: "synthetic-track" });
  assert.equal(converted.accountScopeId, null);
  assert.equal(converted.observedAtMs, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(planAttributionObservationFromSnapshot({ observedAtMs: 100, planType: "pro" }, { contextKey, accountScopeId: "account-a" }).accountScopeId, "account-a");
  assert.equal(planAttributionObservationFromSnapshot({}), null);
  assert.throws(() => planAttributionContextKey("private field with spaces", "codex"), /bounded quota tokens/u);
});
