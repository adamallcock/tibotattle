import test from "node:test";
import assert from "node:assert/strict";
import { createInitialPlanTimeline, resolvePlanContext, upsertPlanProfile, validatePlanTimeline } from "../src/plan-timeline.js";

const SCOPE = "openai-account:v1:0123456789abcdef0123456789abcdef0123456789a";

test("initial plan timeline preserves the reported 20x default and unresolved 5x episode", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, alias: "account-a", effectiveAt: "2026-07-23T00:00:00Z" });
  const resolved = resolvePlanContext({ timeline, scopeId: SCOPE, at: "2026-07-24T00:00:00Z", providerPlanType: "pro" });
  assert.equal(resolved.planVariant, "pro-20x");
  assert.equal(resolved.localAlias, "account-a");
  assert.deepEqual(resolved.ambiguity, [{
    planVariant: "pro-5x",
    startAtKnown: false,
    endAtKnown: false,
    scopeKnown: false,
    reason: "unresolved_user_reported_plan_episode",
  }]);
});

test("dated periods override a default only inside their half-open interval", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-01-01T00:00:00Z" });
  timeline.profiles[0].periods.push({
    planVariant: "pro-5x",
    startAt: "2026-06-01T00:00:00Z",
    endAt: "2026-06-10T00:00:00Z",
  });
  assert.equal(resolvePlanContext({ timeline, scopeId: SCOPE, at: "2026-06-05T00:00:00Z" }).planVariant, "pro-5x");
  assert.equal(resolvePlanContext({ timeline, scopeId: SCOPE, at: "2026-06-10T00:00:00Z" }).planVariant, "pro-20x");
});

test("plan timeline rejects raw-looking aliases and overlapping periods", () => {
  assert.throws(() => createInitialPlanTimeline({ scopeId: SCOPE, alias: "person@example.com", effectiveAt: "2026-01-01T00:00:00Z" }), /alias/);
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-01-01T00:00:00Z" });
  timeline.profiles[0].periods = [
    { planVariant: "pro-5x", startAt: "2026-06-01T00:00:00Z", endAt: "2026-06-10T00:00:00Z" },
    { planVariant: "pro-20x", startAt: "2026-06-05T00:00:00Z", endAt: null },
  ];
  assert.throws(() => validatePlanTimeline(timeline), /overlap/);
});

test("undated defaults never leak backward before their effective timestamp", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-24T04:00:00Z" });
  const before = resolvePlanContext({ timeline, scopeId: SCOPE, at: "2026-07-24T03:59:59Z" });
  const after = resolvePlanContext({ timeline, scopeId: SCOPE, at: "2026-07-24T04:00:00Z" });
  assert.equal(before.planVariant, "unknown");
  assert.equal(before.source, "before_default_effective_date");
  assert.equal(after.planVariant, "pro-20x");
});

test("account registration adds a distinct dated pseudonymous profile", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-24T04:00:00Z" });
  const secondScope = "openai-account:v1:abcdef0123456789abcdef0123456789abcdef01234";
  const registered = upsertPlanProfile({
    timeline,
    scopeId: secondScope,
    alias: "account-secondary",
    defaultPlanVariant: "pro-20x",
    effectiveAt: "2026-07-25T00:00:00Z",
  });
  assert.equal(registered.profiles.length, 2);
  assert.equal(registered.profiles[1].scopeId, secondScope);
  assert.equal(registered.profiles[1].defaultEffectiveAt, "2026-07-25T00:00:00Z");
});

test("re-registering an account never moves its effective date or rewrites its default plan", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, alias: "account-primary", effectiveAt: "2026-07-24T04:00:00Z" });
  const registered = upsertPlanProfile({
    timeline,
    scopeId: SCOPE,
    alias: "account-main",
    defaultPlanVariant: "pro-20x",
    effectiveAt: "2026-07-25T00:00:00Z",
  });
  assert.equal(registered.profiles[0].alias, "account-main");
  assert.equal(registered.profiles[0].defaultEffectiveAt, "2026-07-24T04:00:00Z");
  assert.throws(() => upsertPlanProfile({
    timeline,
    scopeId: SCOPE,
    alias: "account-primary",
    defaultPlanVariant: "pro-5x",
    effectiveAt: "2026-07-25T00:00:00Z",
  }), /dated plan period/);
});

test("plan timeline rejects corrupted collection fields", () => {
  assert.throws(() => validatePlanTimeline({ schemaVersion: "0.1", profiles: {}, unresolvedEpisodes: [] }), /profiles must be an array/);
  assert.throws(() => validatePlanTimeline({ schemaVersion: "0.1", profiles: [], unresolvedEpisodes: {} }), /unresolvedEpisodes must be an array/);
});
