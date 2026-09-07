import { addUsdStrings } from "@app-usagemonitor/accounting";
import { PR94_LEDGER_COMPONENTS } from "./pr94-ledger-evidence.mjs";

const PLANS = ["free", "plus", "pro", "pro_lite", "team", "business", "enterprise", "edu", "unknown", "other"];
const BASIS = ["not_recorded", "unavailable", "same_record", "conflicted"];
const DISPOSITIONS = ["legacy_unseparated", "compatible", "legacy_conditional", "unresolved", "incompatible"];
const REASONS = ["legacy_unseparated", "no_plan_evidence", "usage_interval_unresolved", "outside_observed_history",
  "plan_transition_interval", "conflicting_quota_evidence", "usage_plan_conflict", "usage_quantity_plan_unresolved",
  "account_unresolved", "plan_unresolved", "different_context", "different_account", "different_plan", "different_era",
  "explicit_usage_attribution", "source_record_conflicted"];
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;
function fail() { throw Object.assign(new Error("pr94_population_invalid"), { code: "pr94_population_invalid" }); }
function count(value) { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(); return value; }
function decimal(value) { if (typeof value !== "string" || value.length > 100 || !DECIMAL.test(value)) fail(); return value; }
function closed(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], "value"))) fail();
}
function empty() {
  return { events: 0, totalUsd: "0", components: Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name) => [name,
    { quantity: "0", observedEvents: 0, missingEvents: 0, unavailableEvents: 0 }])) };
}
function sum(target, source) {
  target.events = count(target.events + count(source.events));
  target.totalUsd = addUsdStrings(target.totalUsd, decimal(source.totalUsd));
  for (const name of PR94_LEDGER_COMPONENTS) {
    const item = source.components[name]; const out = target.components[name];
    out.quantity = addUsdStrings(out.quantity, decimal(item.quantity));
    for (const key of ["observedEvents", "missingEvents", "unavailableEvents"]) out[key] = count(out[key] + count(item[key]));
  }
}
function checkTotals(value) {
  closed(value, ["events", "totalUsd", "components"]); count(value.events); decimal(value.totalUsd);
  closed(value.components, PR94_LEDGER_COMPONENTS);
  for (const item of Object.values(value.components)) {
    closed(item, ["quantity", "observedEvents", "missingEvents", "unavailableEvents"]);
    decimal(item.quantity);
    if (count(item.observedEvents) + count(item.missingEvents) + count(item.unavailableEvents) !== value.events) fail();
    if (!/^(?:0|[1-9]\d*)$/u.test(item.quantity)
        || BigInt(item.quantity) > BigInt(item.observedEvents) * BigInt(Number.MAX_SAFE_INTEGER)) fail();
  }
}
export function validatePr94PopulationEvidence(value) {
  closed(value, ["schema", "context", "revisionKind", "totals", "populations", "unknownAccountOnlyWithheldEvents"]);
  if (value.schema !== "pr94-population-evidence-v1" || value.context !== "openai_codex|codex"
      || !["before", "after", "final"].includes(value.revisionKind)) fail();
  checkTotals(value.totals); count(value.unknownAccountOnlyWithheldEvents);
  if (!Array.isArray(value.populations) || value.populations.length > 2000) fail();
  const sumOfPopulations = empty(); const keys = new Set();
  for (const item of value.populations) {
    closed(item, ["planType", "basis", "disposition", "reason", "accountKnown", "totals"]);
    if (!PLANS.includes(item.planType) || !BASIS.includes(item.basis)
        || !DISPOSITIONS.includes(item.disposition) || !REASONS.includes(item.reason)
        || typeof item.accountKnown !== "boolean") fail();
    const key = JSON.stringify([item.planType, item.basis, item.disposition, item.reason, item.accountKnown]);
    if (keys.has(key)) fail(); keys.add(key);
    checkTotals(item.totals); sum(sumOfPopulations, item.totals);
  }
  if (JSON.stringify(sumOfPopulations) !== JSON.stringify(value.totals)) fail();
  const withheld = value.populations.filter((item) => !item.accountKnown && item.disposition === "unresolved"
    && item.reason === "account_unresolved").reduce((total, item) => total + item.totals.events, 0);
  if (withheld !== value.unknownAccountOnlyWithheldEvents) fail();
  return value;
}

// Each admitted usage event is classified once with the same public arguments
// as the original transition miner. This is a disjoint diagnostic projection,
// never a second priced ledger or a per-reset sum of overlapping usage slices.
export function buildPr94PopulationEvidence({ usage, costs, ledger, quota, attribution, revisionKind, resourceCheck = () => {} }) {
  if (!Array.isArray(usage) || usage.length > 1_000_000 || !Array.isArray(costs)
      || costs.length !== usage.length || ledger?.usage?.events !== usage.length) fail();
  const populations = new Map(); const totals = empty();
  for (let at = 0; at < usage.length; at += 1) {
    if (at % 2048 === 0) resourceCheck();
    const event = usage[at]; const scope = event.accountScopeId;
    const accountKnown = typeof scope === "string" && scope.length <= 512
      && !["", "unknown", "unattributed", "unavailable"].includes(scope);
    const basis = event.planAttribution?.basis ?? "not_recorded";
    let classification = { disposition: "legacy_unseparated", reason: "legacy_unseparated", planType: "unknown" };
    if (revisionKind !== "before") {
      const intervalStartMs = Date.parse(event.usageIntervalStartedAt ?? "");
      classification = quota.classifyUsageAttribution(attribution, {
        contextKey: quota.planAttributionContextKey("openai_codex", "codex"), observedAtMs: event.timestampMs,
        ...(Number.isSafeInteger(intervalStartMs) ? { intervalStartMs } : {}),
        observedPlanType: basis === "same_record" ? event.planAttribution.planType : null,
        observedPlanVariant: event.planAttribution?.planVariant ?? "unknown", accountScopeId: scope ?? null,
      });
      if (basis === "conflicted") classification = { ...classification, disposition: "unresolved", reason: "source_record_conflicted" };
      if (classification.disposition !== "unresolved" && !classification.era) fail();
    }
    const planType = classification.planType == null ? "unknown"
      : PLANS.includes(classification.planType) ? classification.planType : "other";
    const metadata = { planType, basis, disposition: classification.disposition, reason: classification.reason, accountKnown };
    const key = JSON.stringify(metadata);
    if (!populations.has(key)) populations.set(key, { ...metadata, totals: empty() });
    const item = empty(); item.events = 1; item.totalUsd = decimal(costs[at]);
    for (const name of PR94_LEDGER_COMPONENTS) {
      const present = Object.hasOwn(event.components, name); const value = event.components[name];
      const unavailable = event.componentAvailability?.[name] === false || (present && value === null);
      const component = item.components[name];
      if (unavailable) component.unavailableEvents = 1;
      else if (!present) component.missingEvents = 1;
      else { component.observedEvents = 1; component.quantity = String(count(value)); }
    }
    sum(populations.get(key).totals, item); sum(totals, item);
  }
  const expected = { events: ledger.usage.events, totalUsd: ledger.usage.totalUsd,
    components: Object.fromEntries(PR94_LEDGER_COMPONENTS.map((name) => [name,
      Object.fromEntries(["quantity", "observedEvents", "missingEvents", "unavailableEvents"].map((key) => [key, ledger.usage.components[name][key]]))])) };
  if (JSON.stringify(totals) !== JSON.stringify(expected)) fail();
  const rows = [...populations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  return validatePr94PopulationEvidence({ schema: "pr94-population-evidence-v1", context: "openai_codex|codex", revisionKind,
    totals, populations: rows, unknownAccountOnlyWithheldEvents: rows.filter((item) => !item.accountKnown
      && item.disposition === "unresolved" && item.reason === "account_unresolved").reduce((n, item) => n + item.totals.events, 0) });
}
