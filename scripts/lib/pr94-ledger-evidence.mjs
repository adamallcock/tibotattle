import { createHmac, timingSafeEqual } from "node:crypto";
import { addUsdStrings } from "@app-usagemonitor/accounting";

// This is an evidence comparator, not a reader or pricing implementation. Feed
// each admitted reader occurrence exactly once, with its public accounting
// result. Never feed overlapping calibration slices back into this ledger.
// Public finishes contain aggregates only. PRIVATE frames are ephemeral,
// owner-only transport between isolated revision processes, never a receipt.
export const PR94_LEDGER_COMPONENTS = Object.freeze([
  "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens",
  "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens",
]);
const COVERAGE = ["fully_priced", "partially_priced", "unpriced"];
const WARNING_CODES = Object.freeze([
  "unknown_provider", "unknown_surface", "unknown_model", "price_not_found",
  "component_unpriced", "tool_component_unpriced", "source_capability_unsupported",
  "service_tier_unsupported", "long_context_rule_missing", "historical_price_missing",
  "historical_price_timestamp_missing", "pricing_period_required",
  "pricing_period_unsupported", "billing_schedule_unsupported",
  "duplicate_component_conflict", "unknown_zero_component", "unknown_component",
  "unsupported_provider", "service_tier_exact_card_missing", "component_price_missing",
  "component_observation_unavailable", "alias_inferred", "price_stale",
  "usage_field_ignored", "usage_missing", "inclusive_usage_ambiguous",
  "discount_not_applied", "provider_reported_cost_mismatch", "provider_reported_cost_used",
  "price_source_disagreement",
]);
const VERSION = "pr94-ledger-evidence-v1";
const PRIVATE_VERSION = "pr94-ledger-evidence-private-v1";
const MAX_ROWS = 10_000_000;
const DEFAULT_MAX_ROWS = 2_000_000;
const FINISHES = new WeakMap();
const COUNTERS = ["observedEvents", "missingEvents", "unavailableEvents", "zeroEvents"];
const COMPONENT_COUNTERS = [...COUNTERS, "pricedEvents", "unpricedEvents", "unavailablePricingEvents"];
const COMPONENT_DECIMALS = ["quantity", "pricedQuantity", "unpricedQuantity", "costUsd"];
const ID_FIELDS = ["sourceLocal", "sourceRolloutOrdinal", "sourceRecordOrdinal"];
const OPTIONAL_ORDER_FIELDS = ["sourceOrdinal", "sourceOffset", "sequence"];
const SURFACE_FIELDS = ["surface", "threadSource", "agentScope", "lineageDisposition"];
const TIER_FIELDS = ["billingSurface", "codexSpeedMode", "apiServiceTier", "tierSource", "tierObservedAt"];
const ATTRIBUTION_FIELDS = ["planAttribution", "usageIntervalStartedAt", "usageIntervalBasis"];

function fail(code = "invalid") {
  // Fixed errors must not interpolate private field names, values, paths or IDs.
  const error = new TypeError(`pr94_ledger_${code}`);
  error.code = `pr94_ledger_${code}`;
  throw error;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) fail();
  return value;
}

function closed(value, required, optional = []) {
  record(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) fail();
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail();
  return value;
}

function sumCount(...values) { return count(values.reduce((sum, value) => sum + count(value), 0)); }
function member(value, values) { if (!values.includes(value)) fail(); return value; }
function atom(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) fail();
  return value;
}

function decimal(value, integer = false) {
  if (typeof value !== "string" || value.length > 128
      || !(integer ? /^(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/).test(value)) fail();
  return value;
}

function add(...values) { return decimal(addUsdStrings(...values)); }
function decimalGreaterThanInteger(value, limit) {
  const [whole, fraction = ""] = decimal(value).split(".");
  return BigInt(whole + fraction) > limit * 10n ** BigInt(fraction.length);
}
function instant(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) fail();
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function keyed(key, domain, value) {
  return createHmac("sha256", key).update(`${VERSION}\0${domain}\0`).update(canonical(value)).digest("hex");
}

function digest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; }
function sameDigest(left, right) {
  return timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));
}

function options(value) {
  closed(value, ["hmacKey"], ["maxRows"]);
  if (!(value.hmacKey instanceof Uint8Array) || value.hmacKey.byteLength !== 32) fail();
  const maxRows = count(Object.hasOwn(value, "maxRows") ? value.maxRows : DEFAULT_MAX_ROWS);
  if (maxRows < 1 || maxRows > MAX_ROWS) fail();
  return { key: Buffer.from(value.hmacKey), maxRows };
}

function identity(row, quota = false) {
  if (!(row.sourceLocal instanceof Uint8Array) || row.sourceLocal.byteLength !== 32) fail();
  count(row.sourceRolloutOrdinal);
  count(row.sourceRecordOrdinal);
  if (Object.hasOwn(row, "sourceOrdinal") && count(row.sourceOrdinal) !== row.sourceRolloutOrdinal) fail();
  if (Object.hasOwn(row, "sourceOffset") && count(row.sourceOffset) !== row.sourceRecordOrdinal) fail();
  if (Object.hasOwn(row, "sequence")) count(row.sequence);
  return [Buffer.from(row.sourceLocal).toString("hex"), row.sourceRolloutOrdinal,
    row.sourceRecordOrdinal, ...(quota ? [count(row.slotOrder)] : [])];
}

function semantics(row) {
  instant(row.timestamp);
  if (!Number.isSafeInteger(row.timestampMs) || Date.parse(row.timestamp) !== row.timestampMs) fail();
  closed(row.surfaceClassification, SURFACE_FIELDS);
  SURFACE_FIELDS.forEach((key) => atom(row.surfaceClassification[key]));
  return { timestamp: row.timestamp, surfaceClassification: { ...row.surfaceClassification } };
}

function observation(values, name, availability = {}) {
  const present = Object.hasOwn(values, name);
  const value = present ? values[name] : null;
  if (present && value !== null) count(value);
  const available = Object.hasOwn(availability, name) ? availability[name] : null;
  if (available !== null && typeof available !== "boolean") fail();
  return { state: available === false || (present && value === null)
    ? "unavailable" : present ? "observed" : "missing", present, value, availability: available };
}

function rawUsage(row) {
  closed(row, ["timestamp", "timestampMs", "model", "components", "tierSemantics",
    "surfaceClassification", ...ID_FIELDS],
  [...OPTIONAL_ORDER_FIELDS, ...ATTRIBUTION_FIELDS, "totalInputContextTokens", "componentAvailability"]);
  const semantic = semantics(row);
  atom(row.model);
  closed(row.components, [], PR94_LEDGER_COMPONENTS);
  if (Object.hasOwn(row, "componentAvailability")) closed(row.componentAvailability, [], PR94_LEDGER_COMPONENTS);
  const components = Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name) =>
    [name, observation(row.components, name, row.componentAvailability)]));
  const context = observation(row, "totalInputContextTokens");
  closed(row.tierSemantics, TIER_FIELDS);
  TIER_FIELDS.filter((key) => key !== "tierObservedAt").forEach((key) => atom(row.tierSemantics[key]));
  instant(row.tierSemantics.tierObservedAt, true);
  // These are the intentional PR94 attribution delta, not conserved usage.
  if (Object.hasOwn(row, "planAttribution")) {
    closed(row.planAttribution, ["basis", "planType", "planVariant"]);
    member(row.planAttribution.basis, ["unavailable", "same_record", "conflicted"]);
    atom(row.planAttribution.planType, true);
    atom(row.planAttribution.planVariant, true);
  }
  if (Object.hasOwn(row, "usageIntervalStartedAt")) instant(row.usageIntervalStartedAt, true);
  if (Object.hasOwn(row, "usageIntervalBasis")) {
    member(row.usageIntervalBasis, ["unavailable", "previous_session_record", "previous_source_record"]);
  }
  return { identity: identity(row), semantic: { ...semantic, model: row.model,
    components, context, tierSemantics: { ...row.tierSemantics } } };
}

function pricedUsage(result, raw) {
  closed(result, ["schemaVersion", "basis", "provider", "model", "surface", "pricingContext",
    "coverageStatus", "coverageCounts", "totalUsd", "components", "priceCardBreakdown",
    "selectedPriceCardId", "selectedPriceCardIds", "warnings", "ledger"], ["methodVersion", "registry"]);
  if (result.schemaVersion !== "0.1" || result.basis !== "api_price_equivalent_not_subscription_allowance"
      || result.provider !== "openai" || result.surface !== "openai.responses" || result.model !== raw.model) fail();
  closed(result.pricingContext, ["serviceTier", "tierSource", "pricedAt", "region", "priceEpochBasis"],
    ["historicalPriceReasonCode"]);
  const context = result.pricingContext;
  atom(context.serviceTier); atom(context.tierSource); atom(context.priceEpochBasis);
  atom(context.region, true); instant(context.pricedAt, true);
  if (Object.hasOwn(context, "historicalPriceReasonCode")) member(context.historicalPriceReasonCode, WARNING_CODES);
  member(result.coverageStatus, COVERAGE);
  decimal(result.totalUsd);
  closed(result.coverageCounts, ["pricedComponents", "unpricedComponents", "unavailableComponents"]);
  Object.values(result.coverageCounts).forEach(count);
  if (!Array.isArray(result.components) || result.components.length > PR94_LEDGER_COMPONENTS.length) fail();
  const components = {};
  const coverage = { pricedComponents: 0, unpricedComponents: 0, unavailableComponents: 0 };
  const cards = new Map();
  let total = "0";
  for (const component of result.components) {
    closed(component, ["name", "pricedAs", "quantity", "unit", "pricingStatus", "unitPriceUsd", "costUsd", "priceCardId"],
      ["reasonCode", "metadata"]);
    const name = member(component.name, PR94_LEDGER_COMPONENTS);
    if (Object.hasOwn(components, name) || component.unit !== "token") fail();
    const status = member(component.pricingStatus, ["priced", "unpriced", "unavailable"]);
    const observed = raw.components[name];
    if (status === "unavailable") {
      if (observed.state !== "unavailable" || component.quantity !== null) fail();
      coverage.unavailableComponents += 1;
    } else {
      decimal(component.quantity, true);
      if (observed.state !== "observed" || component.quantity !== String(observed.value) || observed.value === 0) fail();
      coverage[status === "priced" ? "pricedComponents" : "unpricedComponents"] += 1;
    }
    if (status === "priced") {
      if (component.pricedAs !== name || Object.hasOwn(component, "reasonCode")) fail();
      decimal(component.unitPriceUsd); decimal(component.costUsd); atom(component.priceCardId);
      total = add(total, component.costUsd);
      cards.set(component.priceCardId, add(cards.get(component.priceCardId) ?? "0", component.costUsd));
    } else {
      if (component.unitPriceUsd !== null || component.costUsd !== null || component.priceCardId !== null) fail();
      if (component.pricedAs !== null && component.pricedAs !== name) fail();
      member(component.reasonCode, WARNING_CODES);
      if (status === "unavailable" && component.reasonCode !== "component_observation_unavailable") fail();
    }
    // Deliberately omit accounting diagnostic messages and arbitrary metadata.
    components[name] = { name, pricedAs: component.pricedAs, quantity: component.quantity,
      pricingStatus: status, unitPriceUsd: component.unitPriceUsd, costUsd: component.costUsd,
      priceCardId: component.priceCardId, reasonCode: component.reasonCode ?? null };
  }
  for (const name of PR94_LEDGER_COMPONENTS) {
    const observed = raw.components[name];
    // OpenAI's public kernel has no combined-output unavailable mapping. It
    // remains explicitly unavailable in raw evidence, not an invented zero.
    const expected = (observed.state === "observed" && observed.value > 0)
      || (observed.state === "unavailable" && name !== "output_combined_tokens");
    if (Object.hasOwn(components, name) !== expected) fail();
  }
  const status = coverage.unpricedComponents === 0 && coverage.unavailableComponents === 0
    ? "fully_priced" : coverage.pricedComponents > 0 ? "partially_priced" : "unpriced";
  if (canonical(coverage) !== canonical(result.coverageCounts) || result.totalUsd !== total
      || result.coverageStatus !== status) fail("cost_conservation");
  if (!Array.isArray(result.selectedPriceCardIds) || !Array.isArray(result.priceCardBreakdown)
      || result.selectedPriceCardIds.length > 6 || result.priceCardBreakdown.length > 6) fail();
  const selected = [...cards.keys()].sort();
  if (canonical(result.selectedPriceCardIds) !== canonical(selected)
      || result.selectedPriceCardId !== (selected.length === 1 ? selected[0] : null)) fail();
  const breakdown = result.priceCardBreakdown.map((item) => {
    closed(item, ["priceCardId", "events", "costUsd"]);
    atom(item.priceCardId); decimal(item.costUsd);
    if (item.events !== 1) fail();
    return item;
  });
  if (canonical(breakdown) !== canonical(selected.map((priceCardId) => ({ priceCardId, events: 1, costUsd: cards.get(priceCardId) })))) fail();
  closed(result.warnings, ["coverage", "informational"]);
  const warnings = {};
  for (const kind of ["coverage", "informational"]) {
    if (!Array.isArray(result.warnings[kind]) || result.warnings[kind].length > 128) fail();
    warnings[kind] = result.warnings[kind].map((item) => {
      closed(item, ["code", "message", "metadata"]);
      return member(item.code, WARNING_CODES);
    }).sort();
  }
  let registry = null;
  if (Object.hasOwn(result, "registry")) {
    closed(result.registry, ["version", "sha256", "observedAt", "priceBasis", "historicalDefault", "sources"]);
    registry = { version: atom(result.registry.version), sha256: result.registry.sha256 === null ? null : digest(result.registry.sha256) };
  }
  const methodVersion = Object.hasOwn(result, "methodVersion") ? atom(result.methodVersion) : null;
  return { components, coverageStatus: result.coverageStatus, totalUsd: total,
    pricingContext: { ...context }, warnings, registry, methodVersion };
}

function emptyObservation() { return { observedEvents: 0, missingEvents: 0, unavailableEvents: 0, zeroEvents: 0, quantity: "0" }; }
function emptyAggregate() {
  return { schemaVersion: VERSION, usage: { events: 0, totalUsd: "0",
    components: Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name) => [name, {
      ...emptyObservation(), pricedEvents: 0, unpricedEvents: 0, unavailablePricingEvents: 0,
      pricedQuantity: "0", unpricedQuantity: "0", costUsd: "0",
    }])), context: emptyObservation(), coverage: Object.fromEntries(COVERAGE.map((status) => [status, 0])),
    warnings: Object.fromEntries(["coverage", "informational"].map((kind) => [kind,
      Object.fromEntries(WARNING_CODES.map((code) => [code, 0]))])) },
  quota: { events: 0, slots: { primary: 0, secondary: 0 }, usedPercentTotal: "0", windowDurationMinsTotal: "0" } };
}

function accumulateObservation(target, observation) {
  const field = `${observation.state}Events`;
  target[field] = sumCount(target[field], 1);
  if (observation.state === "observed") {
    target.quantity = add(target.quantity, String(observation.value));
    if (observation.value === 0) target.zeroEvents = sumCount(target.zeroEvents, 1);
  }
}

function validateObservation(value, events, component = false) {
  closed(value, component ? [...COMPONENT_COUNTERS, ...COMPONENT_DECIMALS] : [...COUNTERS, "quantity"]);
  (component ? COMPONENT_COUNTERS : COUNTERS).forEach((key) => count(value[key]));
  decimal(value.quantity, true);
  if (sumCount(value.observedEvents, value.missingEvents, value.unavailableEvents) !== events
      || value.zeroEvents > value.observedEvents
      || (value.observedEvents === value.zeroEvents && value.quantity !== "0")
      || BigInt(value.quantity) > BigInt(value.observedEvents) * BigInt(Number.MAX_SAFE_INTEGER)
      || (value.observedEvents > value.zeroEvents && BigInt(value.quantity) < BigInt(value.observedEvents - value.zeroEvents))) fail();
  if (component) {
    decimal(value.pricedQuantity, true); decimal(value.unpricedQuantity, true); decimal(value.costUsd);
    if (sumCount(value.pricedEvents, value.unpricedEvents, value.zeroEvents) !== value.observedEvents
        || value.unavailablePricingEvents > value.unavailableEvents
        || add(value.pricedQuantity, value.unpricedQuantity) !== value.quantity
        || (value.pricedEvents === 0 && (value.pricedQuantity !== "0" || value.costUsd !== "0"))
        || (value.unpricedEvents === 0 && value.unpricedQuantity !== "0")
        || BigInt(value.pricedQuantity) < BigInt(value.pricedEvents)
        || BigInt(value.unpricedQuantity) < BigInt(value.unpricedEvents)
        || BigInt(value.pricedQuantity) > BigInt(value.pricedEvents) * BigInt(Number.MAX_SAFE_INTEGER)
        || BigInt(value.unpricedQuantity) > BigInt(value.unpricedEvents) * BigInt(Number.MAX_SAFE_INTEGER)) fail();
  }
}

/** Validate the complete PUBLIC schema. A valid aggregate alone is not row proof. */
export function validatePr94LedgerEvidenceAggregate(value) {
  closed(value, ["schemaVersion", "usage", "quota"]);
  if (value.schemaVersion !== VERSION) fail();
  const { usage, quota } = value;
  closed(usage, ["events", "totalUsd", "components", "context", "coverage", "warnings"]);
  count(usage.events); decimal(usage.totalUsd);
  closed(usage.components, PR94_LEDGER_COMPONENTS);
  for (const name of PR94_LEDGER_COMPONENTS) {
    const component = usage.components[name];
    validateObservation(component, usage.events, true);
    if (component.unavailablePricingEvents !== (name === "output_combined_tokens" ? 0 : component.unavailableEvents)) fail();
  }
  validateObservation(usage.context, usage.events);
  if (add(...PR94_LEDGER_COMPONENTS.map((name) => usage.components[name].costUsd)) !== usage.totalUsd) fail();
  closed(usage.coverage, COVERAGE);
  if (sumCount(...Object.values(usage.coverage)) !== usage.events) fail();
  closed(usage.warnings, ["coverage", "informational"]);
  for (const kind of ["coverage", "informational"]) {
    closed(usage.warnings[kind], WARNING_CODES);
    for (const value of Object.values(usage.warnings[kind])) {
      if (BigInt(count(value)) > BigInt(usage.events) * 128n) fail();
    }
  }
  closed(quota, ["events", "slots", "usedPercentTotal", "windowDurationMinsTotal"]);
  count(quota.events); decimal(quota.usedPercentTotal); decimal(quota.windowDurationMinsTotal, true);
  closed(quota.slots, ["primary", "secondary"]);
  if (sumCount(quota.slots.primary, quota.slots.secondary) !== quota.events
      || (quota.events === 0 && (quota.usedPercentTotal !== "0" || quota.windowDurationMinsTotal !== "0"))
      || decimalGreaterThanInteger(quota.usedPercentTotal, BigInt(quota.events) * 100n)
      || BigInt(quota.windowDurationMinsTotal) > BigInt(quota.events) * BigInt(Number.MAX_SAFE_INTEGER)
      || BigInt(quota.windowDurationMinsTotal) < BigInt(quota.events)) fail();
  return value;
}

function finish(aggregate, state) {
  validatePr94LedgerEvidenceAggregate(aggregate);
  freeze(aggregate);
  FINISHES.set(aggregate, state);
  return aggregate;
}

/** All errors poison the accumulator; a caught invalid row cannot become a pass. */
export function createPr94LedgerEvidence(configuration) {
  const { key, maxRows } = options(configuration);
  const state = { key, keyCheck: keyed(key, "same-key", null), usage: new Map(), quota: new Map() };
  const aggregate = emptyAggregate();
  let phase = "open";
  function consume(kind, callback) {
    if (phase !== "open") fail("state");
    try {
      if (state.usage.size + state.quota.size >= maxRows) fail("row_limit");
      const { id, semantic, apply } = callback();
      const rowIdentity = keyed(key, `${kind}-identity`, id);
      if (state[kind].has(rowIdentity)) fail("duplicate");
      const fingerprint = keyed(key, `${kind}-semantic`, semantic);
      apply();
      state[kind].set(rowIdentity, fingerprint);
    } catch {
      phase = "failed";
      state.usage.clear(); state.quota.clear(); key.fill(0);
      fail("row_rejected");
    }
  }
  return Object.freeze({
    consumeUsage(row, priced) {
      consume("usage", () => {
        const raw = rawUsage(row);
        const price = pricedUsage(priced, raw.semantic);
        return { id: raw.identity, semantic: { ...raw.semantic, price }, apply() {
          aggregate.usage.events = sumCount(aggregate.usage.events, 1);
          aggregate.usage.totalUsd = add(aggregate.usage.totalUsd, price.totalUsd);
          accumulateObservation(aggregate.usage.context, raw.semantic.context);
          for (const name of PR94_LEDGER_COMPONENTS) {
            const target = aggregate.usage.components[name];
            accumulateObservation(target, raw.semantic.components[name]);
            const component = price.components[name];
            if (!component) continue;
            const status = component.pricingStatus;
            const counter = status === "unavailable" ? "unavailablePricingEvents" : `${status}Events`;
            target[counter] = sumCount(target[counter], 1);
            if (status !== "unavailable") target[`${status}Quantity`] = add(target[`${status}Quantity`], component.quantity);
            if (status === "priced") target.costUsd = add(target.costUsd, component.costUsd);
          }
          aggregate.usage.coverage[price.coverageStatus] = sumCount(aggregate.usage.coverage[price.coverageStatus], 1);
          for (const kind of ["coverage", "informational"]) for (const code of price.warnings[kind]) {
            aggregate.usage.warnings[kind][code] = sumCount(aggregate.usage.warnings[kind][code], 1);
          }
        } };
      });
    },
    consumeQuota(row) {
      consume("quota", () => {
        closed(row, ["timestamp", "timestampMs", "window", "surfaceClassification", "slotOrder", ...ID_FIELDS], OPTIONAL_ORDER_FIELDS);
        const semantic = semantics(row);
        closed(row.window, ["provider", "planType", "limitId", "slot", "usedPercent", "windowDurationMins", "resetsAt"]);
        const window = row.window;
        atom(window.provider); atom(window.planType, true); atom(window.limitId);
        member(window.slot, ["primary", "secondary"]);
        if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)
            || window.usedPercent < 0 || window.usedPercent > 100 || Object.is(window.usedPercent, -0)
            || count(window.windowDurationMins) === 0 || count(window.resetsAt) === 0) fail();
        return { id: identity(row, true), semantic: { ...semantic, window: { ...window } }, apply() {
          aggregate.quota.events = sumCount(aggregate.quota.events, 1);
          aggregate.quota.slots[window.slot] = sumCount(aggregate.quota.slots[window.slot], 1);
          aggregate.quota.usedPercentTotal = add(aggregate.quota.usedPercentTotal, String(window.usedPercent));
          aggregate.quota.windowDurationMinsTotal = add(aggregate.quota.windowDurationMinsTotal, String(window.windowDurationMins));
        } };
      });
    },
    finish() {
      if (phase !== "open") fail("state");
      phase = "finished";
      return finish(aggregate, state);
    },
  });
}

function authentic(value) {
  const state = FINISHES.get(value);
  if (!state) fail("private_evidence_required");
  return state;
}

/** Release private memory/key after comparison and transport have completed. */
export function disposePr94LedgerEvidencePrivate(value) {
  const state = authentic(value);
  state.key.fill(0);
  state.usage.clear();
  state.quota.clear();
  FINISHES.delete(value);
}

/** PRIVATE streaming frames: never include these in public JSON or diagnostics. */
export function* iteratePr94LedgerEvidencePrivate(value) {
  const state = authentic(value);
  const mac = createHmac("sha256", state.key).update(`${PRIVATE_VERSION}\0stream\0`);
  const header = { type: "header", schemaVersion: PRIVATE_VERSION, keyCheck: state.keyCheck, aggregate: value };
  mac.update(canonical(header)).update("\n");
  yield header;
  for (const type of ["usage", "quota"]) for (const [identity, fingerprint] of state[type]) {
    authentic(value);
    const frame = { type, identity, fingerprint };
    mac.update(canonical(frame)).update("\n");
    yield frame;
  }
  authentic(value);
  yield { type: "seal", hmac: mac.digest("hex") };
}

/** Import parsed PRIVATE frames from a bounded owner-only NDJSON reader. */
export async function importPr94LedgerEvidencePrivate(frames, configuration) {
  const { key, maxRows } = options(configuration);
  const state = { key, keyCheck: keyed(key, "same-key", null), usage: new Map(), quota: new Map() };
  const mac = createHmac("sha256", key).update(`${PRIVATE_VERSION}\0stream\0`);
  let aggregate;
  let sealed = false;
  try {
    for await (const frame of frames) {
      if (sealed) fail();
      if (!aggregate) {
        closed(frame, ["type", "schemaVersion", "keyCheck", "aggregate"]);
        if (frame.type !== "header" || frame.schemaVersion !== PRIVATE_VERSION || !sameDigest(frame.keyCheck, state.keyCheck)) fail();
        validatePr94LedgerEvidenceAggregate(frame.aggregate);
        if (sumCount(frame.aggregate.usage.events, frame.aggregate.quota.events) > maxRows) fail();
        aggregate = JSON.parse(canonical(frame.aggregate));
      } else if (frame?.type === "seal") {
        closed(frame, ["type", "hmac"]);
        if (!sameDigest(frame.hmac, mac.digest("hex")) || state.usage.size !== aggregate.usage.events
            || state.quota.size !== aggregate.quota.events) fail();
        sealed = true;
        continue;
      } else {
        closed(frame, ["type", "identity", "fingerprint"]);
        member(frame.type, ["usage", "quota"]);
        digest(frame.identity); digest(frame.fingerprint);
        if (state.usage.size + state.quota.size >= maxRows || state[frame.type].has(frame.identity)) fail();
        state[frame.type].set(frame.identity, frame.fingerprint);
      }
      mac.update(canonical(frame)).update("\n");
    }
    if (!sealed) fail();
    return finish(aggregate, state);
  } catch {
    state.usage.clear(); state.quota.clear(); key.fill(0);
    fail("private_evidence_rejected");
  }
}

/** Aggregate equality is necessary but never sufficient for conservation. */
export function comparePr94LedgerEvidence(before, after) {
  const left = authentic(before);
  const right = authentic(after);
  if (!sameDigest(left.keyCheck, right.keyCheck)) fail("key_mismatch");
  const rows = {};
  for (const kind of ["usage", "quota"]) {
    const result = { before: left[kind].size, after: right[kind].size, unchanged: 0, changed: 0, missing: 0, added: 0 };
    for (const [id, fingerprint] of left[kind]) {
      const counterpart = right[kind].get(id);
      result[counterpart === undefined ? "missing" : fingerprint === counterpart ? "unchanged" : "changed"] += 1;
    }
    for (const id of right[kind].keys()) if (!left[kind].has(id)) result.added += 1;
    rows[kind] = result;
  }
  const aggregateEqual = canonical(before) === canonical(after);
  const equal = aggregateEqual && Object.values(rows).every((row) => row.changed === 0 && row.missing === 0 && row.added === 0);
  return freeze({ schemaVersion: "pr94-ledger-comparison-v1", status: equal ? "equal" : "different", aggregateEqual, rows });
}
