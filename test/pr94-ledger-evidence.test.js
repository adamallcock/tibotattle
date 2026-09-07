import test from "node:test";
import assert from "node:assert/strict";
import { addUsdStrings, priceCodexUsageEvent } from "@app-usagemonitor/accounting";
import {
  PR94_LEDGER_COMPONENTS,
  comparePr94LedgerEvidence,
  createPr94LedgerEvidence,
  disposePr94LedgerEvidencePrivate,
  importPr94LedgerEvidencePrivate,
  iteratePr94LedgerEvidencePrivate,
  validatePr94LedgerEvidenceAggregate,
} from "../scripts/lib/pr94-ledger-evidence.mjs";

// Only synthetic, content-free data. These tests never open a corpus, database,
// application, Keychain, or private transport file.
const KEY = Buffer.alloc(32, 71);
const TIME = "2026-08-01T00:00:00.000Z";
const SURFACE = { surface: "cli_exec", threadSource: "user", agentScope: "root", lineageDisposition: "standalone" };
const clone = (value) => structuredClone(value);
function usage(offset = 1, overrides = {}) {
  return { timestamp: TIME, timestampMs: Date.parse(TIME), model: "gpt-5.6-sol",
    sourceLocal: Buffer.alloc(32, 3), sourceRolloutOrdinal: 0, sourceOrdinal: 0,
    sourceRecordOrdinal: offset, sourceOffset: offset, sequence: offset,
    components: { input_uncached_tokens: 20_000, input_cache_read_tokens: 0,
      input_cache_write_tokens: 0, output_text_tokens: 0, output_reasoning_tokens: 0, output_combined_tokens: 0 },
    totalInputContextTokens: 100,
    tierSemantics: { billingSurface: "chatgpt_subscription", codexSpeedMode: "standard",
      apiServiceTier: "unknown", tierSource: "rollout_thread_settings", tierObservedAt: null },
    surfaceClassification: { ...SURFACE }, ...overrides };
}
function quota(offset = 5, overrides = {}) {
  return { timestamp: TIME, timestampMs: Date.parse(TIME), sourceLocal: Buffer.alloc(32, 3),
    sourceRolloutOrdinal: 0, sourceOrdinal: 0, sourceRecordOrdinal: offset, sourceOffset: offset,
    sequence: offset, slotOrder: 0, surfaceClassification: { ...SURFACE },
    window: { provider: "openai_codex", planType: "unknown", limitId: "codex", slot: "primary",
      usedPercent: 12.5, windowDurationMins: 300, resetsAt: Date.parse(TIME) / 1_000 + 300 * 60 }, ...overrides };
}
function accumulate(usages = [], quotas = [], configuration = {}) {
  const ledger = createPr94LedgerEvidence({ hmacKey: KEY, ...configuration });
  usages.forEach((row) => ledger.consumeUsage(row, priceCodexUsageEvent(row)));
  quotas.forEach((row) => ledger.consumeQuota(row));
  return ledger.finish();
}
function frames(value) { return [...iteratePr94LedgerEvidencePrivate(value)].map(clone); }
function rejectedUsage(mutateRaw, mutatePrice = () => {}) {
  const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
  const row = usage();
  const price = priceCodexUsageEvent(row);
  mutateRaw(row); mutatePrice(price);
  assert.throws(() => ledger.consumeUsage(row, price), { code: "pr94_ledger_row_rejected" });
  assert.throws(() => ledger.finish(), { code: "pr94_ledger_state" });
}

test("empty evidence is explicit, closed, deeply frozen, and compares only with authentic evidence", () => {
  const before = accumulate();
  assert.equal(validatePr94LedgerEvidenceAggregate(before), before);
  assert.equal(before.usage.events, 0);
  assert.equal(before.quota.events, 0);
  assert.equal(before.usage.totalUsd, "0");
  assert.deepEqual(Object.keys(before.usage.components), PR94_LEDGER_COMPONENTS);
  assert.ok(Object.isFrozen(before.usage.components.input_uncached_tokens));
  assert.throws(() => { before.usage.events = 1; }, TypeError);
  assert.equal(comparePr94LedgerEvidence(before, accumulate()).status, "equal");
  assert.throws(() => comparePr94LedgerEvidence(before, clone(before)), { code: "pr94_ledger_private_evidence_required" });
  assert.throws(() => [...iteratePr94LedgerEvidencePrivate(clone(before))], { code: "pr94_ledger_private_evidence_required" });
});

test("streaming usage conserves six components, exact decimal event costs and component subtotal", () => {
  const first = usage(1);
  const second = usage(2);
  second.components.input_uncached_tokens = 40_000;
  const evidence = accumulate([first, second], [quota()]);
  assert.equal(priceCodexUsageEvent(first).totalUsd, "0.1");
  assert.equal(priceCodexUsageEvent(second).totalUsd, "0.2");
  assert.equal(evidence.usage.totalUsd, "0.3");
  assert.equal(evidence.usage.components.input_uncached_tokens.quantity, "60000");
  assert.equal(evidence.usage.components.input_uncached_tokens.costUsd, "0.3");
  assert.equal(evidence.usage.components.output_combined_tokens.zeroEvents, 2);
  assert.equal(evidence.usage.warnings.informational.unknown_zero_component, 2);
  assert.equal(evidence.quota.usedPercentTotal, "12.5");
  assert.equal(evidence.quota.windowDurationMinsTotal, "300");
  assert.equal(comparePr94LedgerEvidence(evidence, accumulate([second, first], [quota()])).status, "equal");
});

test("totals beyond safe integer precision are exact strings, not unsafe numeric counters", () => {
  const first = usage(1, { components: { output_combined_tokens: Number.MAX_SAFE_INTEGER } });
  const second = usage(2, { components: { output_combined_tokens: Number.MAX_SAFE_INTEGER } });
  const evidence = accumulate([first, second]);
  assert.equal(evidence.usage.components.output_combined_tokens.quantity, "18014398509481982");
  assert.equal(evidence.usage.components.output_combined_tokens.unpricedQuantity, "18014398509481982");
  assert.equal(evidence.usage.totalUsd, "0");
  assert.equal(evidence.usage.coverage.unpriced, 2);
});

test("missing, unavailable and observed zero components/context never collapse", () => {
  const missing = usage();
  delete missing.components.input_cache_read_tokens;
  delete missing.totalInputContextTokens;
  const unavailable = usage();
  unavailable.components.input_cache_read_tokens = null;
  unavailable.totalInputContextTokens = null;
  const zero = usage();
  zero.totalInputContextTokens = 0;
  const missingEvidence = accumulate([missing]);
  const unavailableEvidence = accumulate([unavailable]);
  const zeroEvidence = accumulate([zero]);
  assert.equal(missingEvidence.usage.components.input_cache_read_tokens.missingEvents, 1);
  assert.equal(unavailableEvidence.usage.components.input_cache_read_tokens.unavailableEvents, 1);
  assert.equal(unavailableEvidence.usage.components.input_cache_read_tokens.unavailablePricingEvents, 1);
  assert.equal(zeroEvidence.usage.components.input_cache_read_tokens.zeroEvents, 1);
  assert.equal(missingEvidence.usage.context.missingEvents, 1);
  assert.equal(unavailableEvidence.usage.context.unavailableEvents, 1);
  assert.equal(zeroEvidence.usage.context.zeroEvents, 1);
  assert.equal(comparePr94LedgerEvidence(missingEvidence, zeroEvidence).status, "different");
  assert.equal(comparePr94LedgerEvidence(unavailableEvidence, zeroEvidence).status, "different");
});

test("component availability preserves the raw value privately without pricing unavailable quantity", () => {
  const row = usage(1, { componentAvailability: { input_uncached_tokens: false, output_combined_tokens: false } });
  const evidence = accumulate([row]);
  assert.equal(evidence.usage.components.input_uncached_tokens.unavailableEvents, 1);
  assert.equal(evidence.usage.components.input_uncached_tokens.quantity, "0");
  assert.equal(evidence.usage.components.output_combined_tokens.unavailableEvents, 1);
  assert.equal(evidence.usage.components.output_combined_tokens.unavailablePricingEvents, 0);
  const changed = clone(row);
  changed.components.input_uncached_tokens = 1;
  const comparison = comparePr94LedgerEvidence(evidence, accumulate([changed]));
  assert.equal(comparison.aggregateEqual, true);
  assert.equal(comparison.rows.usage.changed, 1);
  const absent = usage(1, { componentAvailability: { input_cache_read_tokens: false } });
  delete absent.components.input_cache_read_tokens;
  const explicitNull = clone(absent);
  explicitNull.components.input_cache_read_tokens = null;
  const presenceComparison = comparePr94LedgerEvidence(accumulate([absent]), accumulate([explicitNull]));
  assert.equal(presenceComparison.aggregateEqual, true);
  assert.equal(presenceComparison.rows.usage.changed, 1);
});

test("equal aggregate totals do not prove conservation when event quantities or costs are reassigned", () => {
  const small = usage(1);
  const large = usage(2);
  large.components.input_uncached_tokens = 40_000;
  const reversedSmall = usage(1);
  reversedSmall.components.input_uncached_tokens = 40_000;
  const comparison = comparePr94LedgerEvidence(accumulate([small, large]), accumulate([reversedSmall, usage(2)]));
  assert.equal(comparison.aggregateEqual, true);
  assert.equal(comparison.status, "different");
  assert.deepEqual(comparison.rows.usage, { before: 2, after: 2, unchanged: 0, changed: 2, missing: 0, added: 0 });
});

test("source identity includes rollout ordinal, record ordinal and quota slot order", () => {
  const before = accumulate([usage()], [quota()]);
  const usageChanged = usage(2);
  const quotaChanged = quota(5, { slotOrder: 1 });
  let comparison = comparePr94LedgerEvidence(before, accumulate([usageChanged], [quotaChanged]));
  assert.equal(comparison.aggregateEqual, true);
  assert.equal(comparison.rows.usage.missing, 1);
  assert.equal(comparison.rows.usage.added, 1);
  assert.equal(comparison.rows.quota.missing, 1);
  comparison = comparePr94LedgerEvidence(before, accumulate([usage(1, { sourceRolloutOrdinal: 1, sourceOrdinal: 1 })], [quota()]));
  assert.equal(comparison.rows.usage.missing, 1);
  assert.equal(comparison.rows.usage.added, 1);
  assert.equal(accumulate([], [quota(), quota(5, { slotOrder: 1 })]).quota.events, 2);
});

test("same semantic quota windows in distinct raw occurrences remain distinct conserved rows", () => {
  const before = accumulate([], [quota(1), quota(2)]);
  const after = accumulate([], [quota(1)]);
  const comparison = comparePr94LedgerEvidence(before, after);
  assert.equal(before.quota.events, 2);
  assert.equal(comparison.rows.quota.missing, 1);
  const changed = quota(1);
  changed.window.resetsAt += 1;
  const resetComparison = comparePr94LedgerEvidence(accumulate([], [quota(1)]), accumulate([], [changed]));
  assert.equal(resetComparison.aggregateEqual, true);
  assert.equal(resetComparison.rows.quota.changed, 1);
});

test("only documented PR94 attribution fields and callback sequence are excluded from row fingerprints", () => {
  const row = usage(1, { sequence: 999, planAttribution: { basis: "same_record", planType: "pro", planVariant: null },
    usageIntervalStartedAt: "2026-07-31T23:59:00.000Z", usageIntervalBasis: "previous_source_record" });
  assert.equal(comparePr94LedgerEvidence(accumulate([usage()]), accumulate([row])).status, "equal");
  for (const mutate of [
    (value) => { value.tierSemantics.codexSpeedMode = "fast"; },
    (value) => { value.surfaceClassification.agentScope = "subagent"; },
    (value) => { value.timestamp = "2026-08-01T00:00:01.000Z"; value.timestampMs += 1000; },
    (value) => { value.totalInputContextTokens += 1; },
    (value) => { value.componentAvailability = { input_uncached_tokens: true }; },
  ]) {
    const changed = usage(); mutate(changed);
    assert.equal(comparePr94LedgerEvidence(accumulate([usage()]), accumulate([changed])).rows.usage.changed, 1);
  }
});

test("unknown models and warning diagnostics cannot become dynamic public output", () => {
  const row = usage(1, { model: "synthetic-unknown-model" });
  const price = priceCodexUsageEvent(row);
  for (const warning of [...price.warnings.coverage, ...price.warnings.informational]) {
    warning.message = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
    warning.metadata = { source: "SYNTHETIC_PRIVATE_DIAGNOSTIC" };
  }
  const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
  ledger.consumeUsage(row, price);
  const evidence = ledger.finish();
  assert.equal(evidence.usage.coverage.unpriced, 1);
  assert.equal(evidence.usage.warnings.coverage.unknown_model, 1);
  const output = JSON.stringify(evidence);
  assert.ok(!output.includes(row.model));
  assert.ok(!output.includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
  assert.ok(!output.includes("identity"));
  assert.ok(!output.includes("fingerprint"));
  assert.ok(!output.includes("sourceLocal"));
  assert.ok(!output.includes(KEY.toString("hex")));
});

test("unknown model substitutions remain detectable despite identical unpriced totals", () => {
  const comparison = comparePr94LedgerEvidence(
    accumulate([usage(1, { model: "synthetic-unknown-one" })]),
    accumulate([usage(1, { model: "synthetic-unknown-two" })]),
  );
  assert.equal(comparison.aggregateEqual, true);
  assert.equal(comparison.rows.usage.changed, 1);
});

test("duplicate usage/quota occurrence poisons the accumulator instead of overwriting", () => {
  for (const kind of ["usage", "quota"]) {
    const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
    const consume = () => kind === "usage"
      ? ledger.consumeUsage(usage(), priceCodexUsageEvent(usage())) : ledger.consumeQuota(quota());
    consume();
    assert.throws(consume, { code: "pr94_ledger_row_rejected" });
    assert.throws(() => ledger.finish(), { code: "pr94_ledger_state" });
    assert.throws(consume, { code: "pr94_ledger_state" });
  }
});

test("bounded row budget covers both streams, finalization is single-use and copies caller key", () => {
  const key = Buffer.from(KEY);
  const ledger = createPr94LedgerEvidence({ hmacKey: key, maxRows: 1 });
  key.fill(0);
  ledger.consumeQuota(quota());
  const evidence = ledger.finish();
  assert.equal(comparePr94LedgerEvidence(evidence, accumulate([], [quota()])).status, "equal");
  assert.throws(() => ledger.finish(), { code: "pr94_ledger_state" });
  assert.throws(() => ledger.consumeQuota(quota(2)), { code: "pr94_ledger_state" });
  const bounded = createPr94LedgerEvidence({ hmacKey: KEY, maxRows: 1 });
  bounded.consumeQuota(quota());
  assert.throws(() => bounded.consumeUsage(usage(), priceCodexUsageEvent(usage())), { code: "pr94_ledger_row_rejected" });
  assert.throws(() => bounded.finish(), { code: "pr94_ledger_state" });
});

test("private disposal releases comparison/transport authority but preserves the immutable public aggregate", () => {
  const evidence = accumulate([usage()]);
  const inFlight = iteratePr94LedgerEvidencePrivate(evidence);
  assert.equal(inFlight.next().value.type, "header");
  disposePr94LedgerEvidencePrivate(evidence);
  assert.equal(validatePr94LedgerEvidenceAggregate(evidence), evidence);
  assert.equal(evidence.usage.totalUsd, "0.1");
  assert.throws(() => [...iteratePr94LedgerEvidencePrivate(evidence)], { code: "pr94_ledger_private_evidence_required" });
  assert.throws(() => comparePr94LedgerEvidence(evidence, accumulate([usage()])), { code: "pr94_ledger_private_evidence_required" });
  assert.throws(() => disposePr94LedgerEvidencePrivate(evidence), { code: "pr94_ledger_private_evidence_required" });
  assert.throws(() => inFlight.next(), { code: "pr94_ledger_private_evidence_required" });
});

test("unknown/raw diagnostic keys and unsafe/nonfinite/negative counts are rejected without leaking values", () => {
  for (const mutate of [
    (row) => { row.secret = "SYNTHETIC_PRIVATE"; },
    (row) => { row.components.other_tokens = 1; },
    (row) => { row.tierSemantics.extra = 1; },
    (row) => { row.surfaceClassification.extra = 1; },
    (row) => { row.componentAvailability = { other_tokens: true }; },
    (row) => { row.componentAvailability = { input_uncached_tokens: "false" }; },
    (row) => { row.sourceOffset += 1; },
    (row) => { row.sourceOrdinal += 1; },
    (row) => { row.sourceLocal = Buffer.alloc(31); },
    (row) => { row.timestampMs += 1; },
    (row) => { delete row.timestamp; },
    (row) => { row.components.input_uncached_tokens = undefined; },
    (row) => { row.planAttribution = { basis: "same_record", planType: "pro", planVariant: null, extra: 1 }; },
  ]) rejectedUsage(mutate);
  for (const invalid of [-1, -0, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    rejectedUsage((row) => { row.sourceRecordOrdinal = invalid; });
    if (invalid !== null) rejectedUsage((row) => { row.components.input_uncached_tokens = invalid; });
  }
});

test("component quantities, coverage, monetary subtotals and card provenance must reconcile per event", () => {
  for (const mutate of [
    (price) => { price.totalUsd = "0.2"; },
    (price) => { price.totalUsd = "0.10"; },
    (price) => { price.totalUsd = 0.1; },
    (price) => { price.components[0].quantity = "20001"; },
    (price) => { price.components[0].costUsd = null; },
    (price) => { price.components[0].unitPriceUsd = "-1"; },
    (price) => { price.components[0].name = "other_tokens"; },
    (price) => { price.components.push(clone(price.components[0])); },
    (price) => { price.components = []; },
    (price) => { price.coverageStatus = "unpriced"; },
    (price) => { price.coverageCounts.pricedComponents = 0; },
    (price) => { price.coverageCounts.extra = 0; },
    (price) => { price.model = "synthetic-unknown"; },
    (price) => { price.selectedPriceCardIds = []; },
    (price) => { price.selectedPriceCardId = null; },
    (price) => { price.priceCardBreakdown[0].costUsd = "0.2"; },
    (price) => { price.priceCardBreakdown.push(clone(price.priceCardBreakdown[0])); },
    (price) => { price.warnings.informational[0].code = "SYNTHETIC_PRIVATE_UNKNOWN_WARNING"; },
    (price) => { price.extra = "SYNTHETIC_PRIVATE"; },
  ]) rejectedUsage(() => {}, mutate);
});

test("unpriced and unavailable components cannot substitute missing price with monetary zero", () => {
  for (const mode of ["unpriced", "unavailable"]) {
    const row = mode === "unpriced" ? usage(1, { model: "synthetic-unknown" })
      : usage(1, { componentAvailability: { input_uncached_tokens: false } });
    const price = priceCodexUsageEvent(row);
    const component = price.components.find((item) => item.name === "input_uncached_tokens");
    assert.equal(component.pricingStatus, mode);
    component.costUsd = "0";
    const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
    assert.throws(() => ledger.consumeUsage(row, price), { code: "pr94_ledger_row_rejected" });
  }
});

test("quota validation rejects invalid windows, unknown keys and missing observations", () => {
  for (const mutate of [
    (row) => { row.window.usedPercent = null; },
    (row) => { row.window.usedPercent = NaN; },
    (row) => { row.window.usedPercent = Infinity; },
    (row) => { row.window.usedPercent = -1; },
    (row) => { row.window.usedPercent = 101; },
    (row) => { row.window.windowDurationMins = 0; },
    (row) => { row.window.windowDurationMins = Number.MAX_SAFE_INTEGER + 1; },
    (row) => { row.window.resetsAt = 0; },
    (row) => { row.window.slot = "tertiary"; },
    (row) => { row.window.extra = "SYNTHETIC_PRIVATE"; },
    (row) => { row.sourceOffset += 1; },
    (row) => { delete row.slotOrder; },
  ]) {
    const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
    const row = quota(); mutate(row);
    assert.throws(() => ledger.consumeQuota(row), { code: "pr94_ledger_row_rejected" });
    assert.throws(() => ledger.finish(), { code: "pr94_ledger_state" });
  }
  assert.equal(accumulate([], [quota(1, { window: { ...quota().window, usedPercent: 0 } })]).quota.usedPercentTotal, "0");
});

test("closed public validator rejects extras, missing counters, unsafe counts and false subtotal consistency", () => {
  const good = accumulate([usage()], [quota()]);
  for (const mutate of [
    (value) => { value.privateRows = []; },
    (value) => { value.usage.extra = 1; },
    (value) => { delete value.usage.events; },
    (value) => { value.usage.events = Infinity; },
    (value) => { value.usage.events = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.usage.events = -1; },
    (value) => { value.usage.coverage.fully_priced = 0; },
    (value) => { value.usage.components.input_uncached_tokens.quantity = "0"; },
    (value) => { value.usage.components.input_uncached_tokens.pricedQuantity = "99999999999999999999999"; },
    (value) => { value.usage.components.output_combined_tokens.missingEvents = 1; },
    (value) => { value.usage.components.output_combined_tokens.unavailablePricingEvents = 1; },
    (value) => { value.usage.totalUsd = "0"; },
    (value) => { value.usage.warnings.coverage.unknown_new_warning = 0; },
    (value) => { delete value.usage.warnings.coverage.unknown_model; },
    (value) => { value.usage.warnings.coverage.unknown_model = NaN; },
    (value) => { value.usage.warnings.coverage.unknown_model = 129; },
    (value) => { value.quota.slots.primary = 0; },
    (value) => { value.quota.usedPercentTotal = null; },
    (value) => { value.quota.usedPercentTotal = "100.0000000000000000001"; },
    (value) => { value.quota.windowDurationMinsTotal = "9007199254740992"; },
  ]) {
    const changed = clone(good); mutate(changed);
    assert.throws(() => validatePr94LedgerEvidenceAggregate(changed), { code: "pr94_ledger_invalid" });
  }
});

test("closed validators reject accessors, symbol channels and prototype-bearing records", () => {
  const evidence = clone(accumulate());
  Object.defineProperty(evidence, "extra", { get() { throw new Error("SYNTHETIC_PRIVATE"); }, enumerable: true });
  assert.throws(() => validatePr94LedgerEvidenceAggregate(evidence), { code: "pr94_ledger_invalid" });
  const symbol = clone(accumulate()); symbol[Symbol("private")] = 1;
  assert.throws(() => validatePr94LedgerEvidenceAggregate(symbol), { code: "pr94_ledger_invalid" });
  const prototype = Object.assign(Object.create({ private: true }), accumulate());
  assert.throws(() => validatePr94LedgerEvidenceAggregate(prototype), { code: "pr94_ledger_invalid" });
});

test("private streaming transport round-trips without materializing raw rows or exposing the HMAC key", async () => {
  const original = accumulate([usage()], [quota()]);
  const output = frames(original);
  assert.deepEqual(output.map((frame) => frame.type), ["header", "usage", "quota", "seal"]);
  assert.deepEqual(Object.keys(output[1]).sort(), ["fingerprint", "identity", "type"]);
  assert.match(output[1].identity, /^[a-f0-9]{64}$/);
  assert.match(output[1].fingerprint, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(output);
  for (const forbidden of [KEY.toString("hex"), Buffer.alloc(32, 3).toString("hex"), "sourceLocal", "sourceOffset", TIME, "gpt-5.6-sol"]) {
    assert.ok(!serialized.includes(forbidden));
  }
  async function* stream() { for (const frame of output) yield JSON.parse(JSON.stringify(frame)); }
  const restored = await importPr94LedgerEvidencePrivate(stream(), { hmacKey: KEY });
  assert.equal(comparePr94LedgerEvidence(original, restored).status, "equal");
  assert.deepEqual(restored, original);
  assert.deepEqual(frames(restored), frames(original));
});

test("private transport rejects tampered frames, aggregate spoofing, truncation and appended data", async () => {
  const original = accumulate([usage()], [quota()]);
  for (const mutate of [
    (rows) => { rows[0].aggregate.usage.totalUsd = "0"; },
    (rows) => { rows[0].keyCheck = "0".repeat(64); },
    (rows) => { rows[0].extra = true; },
    (rows) => { rows[1].identity = "1".repeat(64); },
    (rows) => { rows[1].fingerprint = "2".repeat(64); },
    (rows) => { rows[1].fingerprint = "bad"; },
    (rows) => { rows[1].type = "other"; },
    (rows) => { rows[1].raw = "SYNTHETIC_PRIVATE"; },
    (rows) => { rows.splice(1, 0, clone(rows[1])); },
    (rows) => { rows.splice(1, 1); },
    (rows) => { rows.pop(); },
    (rows) => { rows.push(clone(rows.at(-1))); },
    (rows) => { rows.at(-1).hmac = "f".repeat(64); },
    (rows) => { rows[0].aggregate = clone(accumulate([], [quota()])); },
  ]) {
    const output = frames(original); mutate(output);
    await assert.rejects(importPr94LedgerEvidencePrivate(output, { hmacKey: KEY }), { code: "pr94_ledger_private_evidence_rejected" });
  }
  await assert.rejects(importPr94LedgerEvidencePrivate([], { hmacKey: KEY }), { code: "pr94_ledger_private_evidence_rejected" });
});

test("private import validates key consistency and row budget; public booleans cannot authorize comparison", async () => {
  const original = accumulate([usage()], [quota()]);
  await assert.rejects(importPr94LedgerEvidencePrivate(frames(original), { hmacKey: Buffer.alloc(32, 9) }), { code: "pr94_ledger_private_evidence_rejected" });
  await assert.rejects(importPr94LedgerEvidencePrivate(frames(original), { hmacKey: KEY, maxRows: 1 }), { code: "pr94_ledger_private_evidence_rejected" });
  assert.throws(() => comparePr94LedgerEvidence(original, accumulate([usage()], [quota()], { hmacKey: Buffer.alloc(32, 9) })), { code: "pr94_ledger_key_mismatch" });
  const forged = { ...clone(original), authentic: true };
  assert.throws(() => comparePr94LedgerEvidence(original, forged), { code: "pr94_ledger_private_evidence_required" });
  for (const config of [{}, { hmacKey: "secret" }, { hmacKey: Buffer.alloc(31) },
    { hmacKey: KEY, maxRows: 0 }, { hmacKey: KEY, maxRows: null },
    { hmacKey: KEY, maxRows: Number.MAX_SAFE_INTEGER },
    { hmacKey: KEY, extra: true }]) assert.throws(() => createPr94LedgerEvidence(config), { code: "pr94_ledger_invalid" });
});

test("per-event private proof detects priced card provenance even when public aggregates are unchanged", () => {
  const before = accumulate([usage()]);
  const row = usage();
  const price = priceCodexUsageEvent(row);
  price.components[0].priceCardId = "synthetic:other-card";
  price.selectedPriceCardId = "synthetic:other-card";
  price.selectedPriceCardIds = ["synthetic:other-card"];
  price.priceCardBreakdown[0].priceCardId = "synthetic:other-card";
  const ledger = createPr94LedgerEvidence({ hmacKey: KEY });
  ledger.consumeUsage(row, price);
  const comparison = comparePr94LedgerEvidence(before, ledger.finish());
  assert.equal(comparison.aggregateEqual, true);
  assert.equal(comparison.rows.usage.changed, 1);
});

test("deterministic mixed-component stream conserves exact sums under reversed callback order", () => {
  const rows = Array.from({ length: 40 }, (_, index) => usage(index + 1, {
    components: Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name, component) => [name, (index * 19 + component * 7) % 53])),
  }));
  const evidence = accumulate(rows);
  assert.equal(evidence.usage.totalUsd, addUsdStrings(...rows.map((row) => priceCodexUsageEvent(row).totalUsd)));
  for (const name of PR94_LEDGER_COMPONENTS) {
    assert.equal(evidence.usage.components[name].quantity,
      rows.reduce((sum, row) => sum + BigInt(row.components[name]), 0n).toString());
  }
  assert.equal(comparePr94LedgerEvidence(evidence, accumulate([...rows].reverse())).status, "equal");
});
