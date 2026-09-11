import assert from "node:assert/strict";
import test from "node:test";
import { addUsdStrings, priceCodexUsageEvent } from "@app-usagemonitor/accounting";
import * as quota from "@app-usagemonitor/quota-analysis";
import {
  PR94_LEDGER_COMPONENTS,
  createPr94LedgerEvidence,
  disposePr94LedgerEvidencePrivate,
} from "../scripts/lib/pr94-ledger-evidence.mjs";
import {
  buildPr94PopulationEvidence,
  validatePr94PopulationEvidence,
} from "../scripts/lib/pr94-population-evidence.mjs";

// Synthetic, content-free events only. Pricing, conservation and classification
// use their real public APIs; no corpus, database, app or child process runs.
const TIME = Date.parse("2026-08-01T00:00:00.000Z");
const CONTEXT = quota.planAttributionContextKey("openai_codex", "codex");
const ERROR = { code: "pr94_population_invalid", message: "pr94_population_invalid" };
const clone = (value) => structuredClone(value);
const at = (offset) => TIME + offset;
const observation = (offset, planType = "pro", overrides = {}) => ({
  contextKey: CONTEXT, observedAtMs: at(offset), planType, planVariant: "unknown", ...overrides,
});
function usage(ordinal, offset = 150, overrides = {}) {
  return {
    timestamp: new Date(at(offset)).toISOString(), timestampMs: at(offset), model: "gpt-5.6-sol",
    sourceLocal: Buffer.alloc(32, 17), sourceRolloutOrdinal: 0, sourceRecordOrdinal: ordinal,
    components: { input_uncached_tokens: ordinal * 20_000, input_cache_read_tokens: ordinal * 2_000,
      input_cache_write_tokens: ordinal * 3_000, output_text_tokens: ordinal * 4_000,
      output_reasoning_tokens: ordinal * 5_000, output_combined_tokens: ordinal * 6_000 },
    totalInputContextTokens: 100,
    tierSemantics: { billingSurface: "chatgpt_subscription", codexSpeedMode: "standard",
      apiServiceTier: "unknown", tierSource: "rollout_thread_settings", tierObservedAt: null },
    surfaceClassification: { surface: "cli_exec", threadSource: "user", agentScope: "root", lineageDisposition: "standalone" },
    ...overrides,
  };
}
function input(rows = [], observations = [observation(100), observation(200)], revisionKind = "after") {
  const accumulator = createPr94LedgerEvidence({ hmacKey: Buffer.alloc(32, 81) });
  const costs = rows.map((row) => {
    const priced = priceCodexUsageEvent(row);
    accumulator.consumeUsage(row, priced);
    return priced.totalUsd;
  });
  const ledger = accumulator.finish();
  disposePr94LedgerEvidencePrivate(ledger);
  return { usage: rows, costs, ledger, quota, attribution: quota.buildPlanAttributionIndex(observations), revisionKind };
}
function ledgerTotals(ledger) {
  return { events: ledger.usage.events, totalUsd: ledger.usage.totalUsd,
    components: Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name) => [name,
      Object.fromEntries(["quantity", "observedEvents", "missingEvents", "unavailableEvents"]
        .map((key) => [key, ledger.usage.components[name][key]]))])) };
}
function build(options) {
  const result = buildPr94PopulationEvidence(options);
  assert.equal(validatePr94PopulationEvidence(result), result);
  assert.deepEqual(result.totals, ledgerTotals(options.ledger));
  return result;
}
function costFor(options, ordinals) {
  return ordinals.reduce((sum, ordinal) => addUsdStrings(sum, options.costs[ordinal - 1]), "0");
}

test("empty before, after and final populations are closed explicit zero-event evidence", () => {
  for (const revisionKind of ["before", "after", "final"]) {
    const evidence = build(input([], [], revisionKind));
    assert.equal(evidence.schema, "pr94-population-evidence-v1");
    assert.equal(evidence.context, CONTEXT);
    assert.equal(evidence.revisionKind, revisionKind);
    assert.deepEqual(evidence.populations, []);
    assert.equal(evidence.unknownAccountOnlyWithheldEvents, 0);
    assert.deepEqual(Object.keys(evidence.totals.components), PR94_LEDGER_COMPONENTS);
  }
});

test("Pro to Plus to Pro is a disjoint exact six-component and cost partition including gaps", () => {
  const options = input([50, 150, 250, 350, 450, 550, 650].map((time, index) => usage(index + 1, time)),
    [observation(100), observation(200), observation(300, "plus"), observation(400, "plus"),
      observation(500), observation(600)]);
  const evidence = build(options);
  assert.equal(evidence.totals.events, 7);
  assert.equal(evidence.totals.components.input_uncached_tokens.quantity, "560000");
  assert.equal(evidence.totals.components.output_combined_tokens.quantity, "168000");
  assert.equal(evidence.unknownAccountOnlyWithheldEvents, 0);
  const pro = evidence.populations.find((row) => row.planType === "pro");
  const plus = evidence.populations.find((row) => row.planType === "plus");
  const gap = evidence.populations.find((row) => row.reason === "plan_transition_interval");
  const outside = evidence.populations.find((row) => row.reason === "outside_observed_history");
  assert.equal(evidence.populations.length, 4);
  for (const [row, ordinals] of [[pro, [2, 6, 7]], [plus, [4]], [gap, [3, 5]], [outside, [1]]]) {
    assert.equal(row.totals.events, ordinals.length);
    assert.equal(row.totals.totalUsd, costFor(options, ordinals));
    assert.ok(Number(row.totals.totalUsd) > 0);
    for (const name of PR94_LEDGER_COMPONENTS) {
      assert.equal(row.totals.components[name].quantity,
        ordinals.reduce((sum, ordinal) => addUsdStrings(sum, String(options.usage[ordinal - 1].components[name])), "0"));
      assert.equal(row.totals.components[name].observedEvents, ordinals.length);
    }
  }
  for (const row of [pro, plus]) {
    assert.equal(row.disposition, "legacy_conditional");
    assert.equal(row.reason, "account_unresolved");
    assert.equal(row.accountKnown, false);
  }
  for (const row of [gap, outside]) {
    assert.equal(row.planType, "unknown");
    assert.equal(row.disposition, "unresolved");
  }
});

test("recorded basis remains separate and a conflicted source retains all quantities and cost", () => {
  const options = input([
    usage(1),
    usage(2, 150, { planAttribution: { basis: "unavailable", planType: null, planVariant: null } }),
    usage(3, 150, { planAttribution: { basis: "same_record", planType: "pro", planVariant: "unknown" } }),
    usage(4, 150, { planAttribution: { basis: "conflicted", planType: "pro", planVariant: "unknown" } }),
  ]);
  const evidence = build(options);
  assert.deepEqual(evidence.populations.map((row) => row.basis).sort(), ["conflicted", "not_recorded", "same_record", "unavailable"]);
  const conflict = evidence.populations.find((row) => row.basis === "conflicted");
  assert.equal(conflict.disposition, "unresolved");
  assert.equal(conflict.reason, "source_record_conflicted");
  assert.equal(conflict.totals.totalUsd, options.costs[3]);
  assert.equal(conflict.totals.components.output_combined_tokens.quantity, "24000");
  assert.equal(evidence.unknownAccountOnlyWithheldEvents, 0);
});

test("unknown account is conditional, not withheld, using the public classifier's bounded account policy", () => {
  for (const scope of [undefined, null, "", "unknown", "unattributed", "unavailable", 42, "x".repeat(513)]) {
    const options = input([usage(1)]);
    // The current unified reader supplies no account IDs. This decoration is
    // only a synthetic classifier boundary test, not positive real coverage.
    options.usage = options.usage.map((row) => ({ ...row, accountScopeId: scope }));
    const evidence = build(options);
    assert.equal(evidence.populations[0].accountKnown, false);
    assert.equal(evidence.populations[0].disposition, "legacy_conditional");
    assert.equal(evidence.populations[0].reason, "account_unresolved");
    assert.equal(evidence.unknownAccountOnlyWithheldEvents, 0);
  }
  const scope = "x".repeat(512);
  const options = input([usage(1)], [observation(100, "pro", { accountScopeId: scope }),
    observation(200, "pro", { accountScopeId: scope })]);
  options.usage = options.usage.map((row) => ({ ...row, accountScopeId: scope }));
  const evidence = build(options);
  assert.equal(evidence.populations[0].accountKnown, true);
  assert.equal(evidence.populations[0].disposition, "legacy_conditional");
  assert.equal(evidence.populations[0].reason, "plan_unresolved");
});

test("unknown-plan history remains conditional and no-plan evidence remains an explicit nonzero gap", () => {
  for (const [observations, disposition, reason] of [
    [[observation(100, "unknown"), observation(200, "unavailable")], "legacy_conditional", "account_unresolved"],
    [[], "unresolved", "no_plan_evidence"],
  ]) {
    const options = input([usage(1)], observations);
    const evidence = build(options);
    assert.equal(evidence.populations[0].planType, "unknown");
    assert.equal(evidence.populations[0].disposition, disposition);
    assert.equal(evidence.populations[0].reason, reason);
    assert.equal(evidence.populations[0].totals.totalUsd, options.costs[0]);
    assert.equal(evidence.populations[0].totals.components.input_uncached_tokens.quantity, "20000");
    assert.equal(evidence.unknownAccountOnlyWithheldEvents, 0);
  }
});

test("interval-spanning deltas and same-record plan conflicts remain unresolved without losing the ledger", () => {
  const options = input([
    usage(1, 350, { usageIntervalStartedAt: new Date(at(150)).toISOString(), usageIntervalBasis: "previous_source_record" }),
    usage(2, 350, { planAttribution: { basis: "same_record", planType: "pro", planVariant: "unknown" } }),
    usage(3, 150, { usageIntervalStartedAt: new Date(at(200)).toISOString(), usageIntervalBasis: "previous_source_record" }),
  ], [observation(100), observation(200), observation(300, "plus"), observation(400, "plus")]);
  const evidence = build(options);
  assert.deepEqual(evidence.populations.map((row) => row.reason).sort(),
    ["plan_transition_interval", "usage_interval_unresolved", "usage_plan_conflict"]);
  assert.ok(evidence.populations.every((row) => row.disposition === "unresolved" && Number(row.totals.totalUsd) > 0));
});

test("tied contradictory quota evidence is unresolved, not input-order-selected", () => {
  const observations = [observation(100), observation(150, "plus"), observation(150), observation(200)];
  const evidence = build(input([usage(1)], observations));
  assert.equal(evidence.populations[0].disposition, "unresolved");
  assert.equal(evidence.populations[0].reason, "conflicting_quota_evidence");
  assert.deepEqual(build(input([usage(1)], observations.toReversed())), evidence);
});

test("baseline is explicitly unseparated and never invents a classifier result", () => {
  const options = input([usage(1), usage(2)], [], "before");
  options.quota = { classifyUsageAttribution() { assert.fail("baseline called after-only attribution"); } };
  const evidence = build(options);
  assert.equal(evidence.populations.length, 1);
  assert.equal(evidence.populations[0].planType, "unknown");
  assert.equal(evidence.populations[0].disposition, "legacy_unseparated");
  assert.equal(evidence.populations[0].reason, "legacy_unseparated");
});

test("missing, unavailable and observed zero stay distinct even when all three have quantity zero", () => {
  const missing = usage(1); delete missing.components.input_cache_read_tokens;
  const unavailable = usage(2); unavailable.components.input_cache_read_tokens = null;
  const flagged = usage(3, 150, { componentAvailability: { input_cache_read_tokens: false } });
  const zero = usage(4); zero.components.input_cache_read_tokens = 0;
  const absentFlagged = usage(5, 150, { componentAvailability: { input_cache_read_tokens: false } });
  delete absentFlagged.components.input_cache_read_tokens;
  const evidence = build(input([missing, unavailable, flagged, zero, absentFlagged]));
  assert.deepEqual(evidence.totals.components.input_cache_read_tokens,
    { quantity: "0", observedEvents: 1, missingEvents: 1, unavailableEvents: 3 });
  assert.equal(evidence.totals.components.output_combined_tokens.quantity, "90000");
});

test("unpriced quantities stay nonzero and unknown private labels map to a finite public other label", () => {
  const label = "synthetic-private-plan";
  const options = input([usage(1, 150, { model: "synthetic-private-model",
    planAttribution: { basis: "same_record", planType: label, planVariant: "unknown" } })],
  [observation(100, label), observation(200, label)]);
  const evidence = build(options);
  assert.equal(options.ledger.usage.coverage.unpriced, 1);
  assert.equal(evidence.totals.totalUsd, "0");
  assert.equal(evidence.totals.components.input_uncached_tokens.quantity, "20000");
  assert.equal(evidence.populations[0].planType, "other");
  const serialized = JSON.stringify(evidence);
  for (const excluded of [label, "synthetic-private-model", "sourceLocal", "sourceRecordOrdinal", "accountScopeId",
    "timestamp", "2026-08-01", "eraKey", "planVariant", "hmac", "digest"]) assert.ok(!serialized.includes(excluded));
});

test("aggregate token strings stay exact beyond numeric safe-integer range", () => {
  const options = input([1, 2].map((ordinal) => usage(ordinal, 150,
    { components: { output_combined_tokens: Number.MAX_SAFE_INTEGER } })));
  const evidence = build(options);
  assert.equal(evidence.totals.components.output_combined_tokens.quantity, "18014398509481982");
  assert.equal(evidence.totals.components.output_combined_tokens.observedEvents, 2);
  assert.equal(evidence.totals.components.output_text_tokens.missingEvents, 2);
  assert.equal(evidence.totals.totalUsd, "0");
});

test("admission cardinality, priced total and every ledger component/state must reconcile", () => {
  for (const mutate of [
    (options) => { options.costs.pop(); },
    (options) => { options.costs.push("0"); },
    (options) => { options.costs[0] = "0"; },
    (options) => { options.costs[0] = "NaN"; },
    (options) => { options.costs[0] = "-1"; },
    (options) => { options.costs[0] = 0; },
    (options) => { options.ledger.usage.events = 2; },
    (options) => { options.ledger.usage.components.output_combined_tokens.quantity = "1"; },
    (options) => { options.ledger.usage.components.output_combined_tokens.missingEvents = 1; },
    (options) => { options.usage[0].planAttribution = { basis: "unchecked-label" }; },
    (options) => { options.revisionKind = "unchecked-revision"; },
  ]) {
    const options = input([usage(1)]); options.ledger = clone(options.ledger); mutate(options);
    assert.throws(() => buildPr94PopulationEvidence(options), ERROR);
  }
});

test("validator rejects unknown fields, malformed metadata, counts, decimals and population mismatches", () => {
  const good = build(input([usage(1)]));
  for (const mutate of [
    (value) => { value.raw = "synthetic-private"; },
    (value) => { value.schema = "other"; },
    (value) => { value.context = "other"; },
    (value) => { value.revisionKind = "other"; },
    (value) => { value.populations[0].planType = "synthetic-private"; },
    (value) => { value.populations[0].basis = "synthetic-private"; },
    (value) => { value.populations[0].disposition = "synthetic-private"; },
    (value) => { value.populations[0].reason = "synthetic-private"; },
    (value) => { value.populations[0].accountKnown = "false"; },
    (value) => { value.populations[0].accountScopeId = "synthetic-private"; },
    (value) => { value.totals.totalUsd = "1e3"; },
    (value) => { value.totals.totalUsd = "1.00"; },
    (value) => { value.totals.totalUsd = "-1"; },
    (value) => { value.totals.totalUsd = "NaN"; },
    (value) => { value.totals.totalUsd = "1".repeat(101); },
    (value) => { value.totals.events = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.totals.events = NaN; },
    (value) => { value.totals.events = Infinity; },
    (value) => { value.totals.events = -0; },
    (value) => { value.totals.components.output_combined_tokens.extra = 0; },
    (value) => { delete value.totals.components.output_combined_tokens; },
    (value) => { value.totals.components.output_combined_tokens.missingEvents = 1; },
    (value) => { value.populations[0].totals.components.output_combined_tokens.quantity = "0"; },
    (value) => { value.unknownAccountOnlyWithheldEvents = 1; },
    (value) => { value.populations.push(clone(value.populations[0])); },
    (value) => { value.populations = Array(2001).fill(value.populations[0]); },
    (value) => { value.populations = []; },
    (value) => { value.totals[Symbol("private")] = 1; },
    (value) => { Object.setPrototypeOf(value, { private: true }); },
    (value) => { Object.defineProperty(value.totals, "events", { enumerable: true, get() { assert.fail("getter invoked"); } }); },
  ]) {
    const changed = clone(good); mutate(changed);
    assert.throws(() => validatePr94PopulationEvidence(changed), ERROR);
  }
});

test("validator rejects impossible fractional or over-safe per-event token quantities even in balanced totals", () => {
  const good = build(input([usage(1)]));
  for (const quantity of ["0.5", "9007199254740992", "9".repeat(100)]) {
    const changed = clone(good);
    changed.totals.components.output_combined_tokens.quantity = quantity;
    changed.populations[0].totals.components.output_combined_tokens.quantity = quantity;
    assert.throws(() => validatePr94PopulationEvidence(changed), ERROR);
  }
  const changed = clone(good);
  for (const totals of [changed.totals, changed.populations[0].totals]) {
    Object.assign(totals.components.output_combined_tokens, { observedEvents: 0, missingEvents: 1 });
  }
  assert.throws(() => validatePr94PopulationEvidence(changed), ERROR);
});

test("population ordering is deterministic and source/input objects are not mutated", () => {
  const observations = [observation(100), observation(200), observation(300, "plus"), observation(400, "plus")];
  const options = input([usage(1, 150), usage(2, 250), usage(3, 350)], observations);
  const priorUsage = options.usage.map((row) => ({ ...clone(row), sourceLocal: Buffer.from(row.sourceLocal) }));
  const priorCosts = clone(options.costs);
  const evidence = build(options);
  assert.deepEqual(options.usage, priorUsage);
  assert.deepEqual(options.costs, priorCosts);
  const reversed = { ...options, usage: options.usage.toReversed(), costs: options.costs.toReversed(),
    attribution: quota.buildPlanAttributionIndex(observations.toReversed()) };
  assert.deepEqual(build(reversed), evidence);
});

test("resource refusal stops before classification and an incomplete attribution index cannot look successful", () => {
  const options = input([usage(1)]);
  const marker = Object.assign(new Error("synthetic resource limit"), { code: "synthetic_limit" });
  let called = 0;
  assert.throws(() => buildPr94PopulationEvidence({ ...options, resourceCheck() { called += 1; throw marker; } }),
    (error) => error === marker);
  assert.equal(called, 1);
  assert.throws(() => buildPr94PopulationEvidence({ ...options,
    attribution: quota.buildPlanAttributionIndex([observation(100), observation(200)], { maxObservations: 1 }) }), ERROR);
});
