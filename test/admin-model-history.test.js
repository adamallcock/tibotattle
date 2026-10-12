import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay, expandAdminModelHistoryDay,
} from "@app-usagemonitor/telemetry-contract";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";

function counts() {
  return { fittedParticipantCount: 2, unstableParticipantCount: 1,
    staleParticipantCount: 1, refusedParticipantCount: 1,
    v1ParticipantCount: 5, unsupportedSourceParticipantCount: 3 };
}
function current() {
  return { day: "2026-09-03", catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-astra", 2_000, 2]], ...counts() };
}

test("admin compact history preserves legacy coverage, new models and separate Spark", () => {
  const legacy = { day: "2026-09-02", byModel: Object.fromEntries([
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  ].map((id) => [id, { capacityUsd: null, participantCount: 0 }])), ...counts() };
  legacy.byModel["gpt-5.6-sol"] = { capacityUsd: 900, participantCount: 2 };
  const wire = projectAdminModelHistoryDay(legacy);
  assert.equal(wire.catalogVersion, LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION);
  assert.deepEqual(wire.values, [["gpt-5.6-sol", 900, 2]]);
  assert.equal("byModel" in wire, false);
  const old = expandAdminModelHistoryDay(wire);
  assert.deepEqual(old.byModel["gpt-6-astra"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(old.byModel["gpt-5.6-luna"], { capacityUsd: null, participantCount: 0 });
  const fresh = expandAdminModelHistoryDay(current());
  assert.deepEqual(fresh.byModel["gpt-6-astra"], { capacityUsd: 2_000, participantCount: 2 });
  assert.deepEqual(fresh.byModel["gpt-5.4"], { capacityUsd: null, participantCount: 0 });
  assert.deepEqual(fresh.byModel["gpt-5.3-codex-spark"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(browser.expandAdminModelHistoryDay(wire), old);
  assert.deepEqual(browser.expandAdminModelHistoryDay(current()), fresh);
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "o1"));
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "gpt-5.5-codex"));
});

test("admin model history fails closed on extra fields, raw IDs, invalid tuples and counters", () => {
  const bad = [
    { ...current(), privatePath: "/private/canary" },
    { ...current(), catalogVersion: "unreviewed" },
    { ...current(), day: "2026-02-30" },
    { ...current(), fittedParticipantCount: 0 },
    { ...current(), values: [["private-model-canary", 1, 1]] },
    { ...current(), values: [["gpt-5.3-codex-spark", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1], ["gpt-6-astra", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1, "private-canary"]] },
    { ...current(), values: [["gpt-6-astra", null, 0]] },
    ...[0, -1, NaN, Infinity, "1"].map((value) => ({ ...current(), values: [["gpt-6-astra", value, 1]] })),
    ...[0, -1, 3, 0.5, WIDEST_ACCEPTED_HISTORY_COUNT + 1, Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ ...current(), values: [["gpt-6-astra", 1, value]] })),
  ];
  for (const value of bad) {
    assert.equal(projectAdminModelHistoryDay(value), null);
    assert.equal(browser.projectAdminModelHistoryDay(value), null);
  }
});

test("GPT-6.1 Sol preserves prior catalog coverage and stays separate from GPT-6 Sol", () => {
  const prior = { ...current(), catalogVersion: "reviewed-model-catalog-2026-09-23.1",
    values: [["gpt-6-sol", 1_000, 2]] };
  const old = expandAdminModelHistoryDay(prior);
  assert.equal(old.catalogVersion, prior.catalogVersion);
  assert.deepEqual(old.byModel["gpt-6-sol"], { capacityUsd: 1_000, participantCount: 2 });
  assert.deepEqual(old.byModel["gpt-6.1-astra"], { capacityUsd: null, participantCount: 0 });
  assert.deepEqual(old.byModel["gpt-6.1-sol"], { capacityUsd: null, participantCount: null });
  assert.equal(projectAdminModelHistoryDay({ ...prior, values: [["gpt-6.1-sol", 1_000, 1]] }), null);
  const fresh = expandAdminModelHistoryDay({ ...current(),
    values: [["gpt-6-sol", 1_000, 2], ["gpt-6.1-sol", 1_200, 1]] });
  assert.deepEqual(fresh.byModel["gpt-6-sol"], { capacityUsd: 1_000, participantCount: 2 });
  assert.deepEqual(fresh.byModel["gpt-6.1-sol"], { capacityUsd: 1_200, participantCount: 1 });
  assert.deepEqual(browser.expandAdminModelHistoryDay(prior), old);
});

// The current GCP producer emits fixed reviewed strings and has bounded owner
// and fit output counts. Scalar validation and byte admission are independent:
// extreme scalar-valid previews can exceed the serving/storage byte guard.
// Worker constants have no runtime-neutral JS facade; closed source resolution
// fails if their declarations or the count/resource enforcement shapes change.
const WIDEST_DOLLARS = 0.0000010000000000000002; // 24 JSON characters; MAX_VALUE has 23.
const MILLISECONDS_PER_DAY = 86_400_000;
const WORKER_PATH = "apps/worker/src/admin-community-allowance.ts";
const ALLOWANCE_PATH = "apps/worker/src/community-allowance.ts";
const HISTORY_PATH = "packages/telemetry-contract/src/admin-model-history.js";
const WINDOW_PATH = "apps/worker/src/model-history-window.ts";
const RESOURCES_PATH = "apps/worker/src/analytics-v2/resources.ts";
const repositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

function constantExpression(source, name) {
  const declarations = [...source.matchAll(new RegExp(`(?:^|\\n)(?:export )?const ${name} =\\s*([^;]+);`, "gu"))];
  assert.equal(declarations.length, 1, `${name} must have one readable closed declaration`);
  return declarations[0][1].trim();
}
function closedConstant(source, name, bindings = {}) {
  const expression = constantExpression(source, name);
  if (/^"(?:[^"\\]|\\.)*"$/u.test(expression)) return JSON.parse(expression);
  if (/^[0-9][0-9_]*(?:\.[0-9]+)?$/u.test(expression)) return Number(expression.replaceAll("_", ""));
  if (Object.hasOwn(bindings, expression)) return bindings[expression];
  const product = /^([0-9][0-9_]*) \* ([0-9][0-9_]*)$/u.exec(expression);
  if (product) return Number(product[1].replaceAll("_", "")) * Number(product[2].replaceAll("_", ""));
  const difference = /^([A-Z0-9_]+) - ([A-Z0-9_]+)$/u.exec(expression);
  if (difference && difference.slice(1).every((key) => Object.hasOwn(bindings, key))) return bindings[difference[1]] - bindings[difference[2]];
  assert.fail(`${name} changed to an expression not accounted for by this gate`);
}
function closedKeys(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `${label} must retain its readable closed key list`);
  const keys = [...match[1].matchAll(/"([A-Za-z0-9]+)"/gu)].map((entry) => entry[1]);
  assert.equal(match[1].replace(/"[A-Za-z0-9]+"/gu, "").replace(/[\s,]/gu, ""), "", `${label} has unaccounted keys/expressions`);
  assert.ok(keys.length > 0 && new Set(keys).size === keys.length, `${label} keys must be distinct`);
  return keys;
}
function currentPreviewContract(overrides = {}) {
  const read = (path) => overrides[path] ?? repositoryFile(path);
  const worker = read(WORKER_PATH), allowance = read(ALLOWANCE_PATH), history = read(HISTORY_PATH);
  const analysisWindow = closedConstant(read(WINDOW_PATH), "V1_ANALYSIS_WINDOW_DAYS");
  assert.match(read("apps/worker/src/quota-analysis-v1.ts"), /export \{ V1_ANALYSIS_WINDOW_DAYS \} from "\.\/model-history-window";/u);
  const trailingDays = closedConstant(allowance, "COMMUNITY_ALLOWANCE_TRAILING_DAYS");
  const reconstructable = closedConstant(allowance, "COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS", {
    V1_ANALYSIS_WINDOW_DAYS: analysisWindow, COMMUNITY_ALLOWANCE_TRAILING_DAYS: trailingDays,
  });
  const days = closedConstant(worker, "ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS", { COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS: reconstructable });
  assert.ok(Number.isSafeInteger(days) && days > 0);
  assert.equal(constantExpression(worker, "ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG"), "COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG");
  assert.equal(constantExpression(worker, "ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG"), "ADMIN_MODEL_CONFIG");
  assert.match(worker, /const CURRENT_PREVIEW_CONTRACT:[^=]+ = Object\.freeze\(\{\s*schemaVersion: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION,\s*basis: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS,\s*modelsBasis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,\s*plans: ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG,\s*\}\);/u);
  const roster = /COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG = Object\.freeze\(\[([\s\S]*?)\] as const\)/u.exec(allowance);
  assert.ok(roster, "the current plan roster must retain its readable closed shape");
  const planPattern = /Object\.freeze\(\{ planType: ("[^"\n]+"), label: ("[^"\n]+"), multiplier: ([0-9]+(?:\.[0-9]+)?) \}\)/gu;
  const plans = [...roster[1].matchAll(planPattern)].map((match) => ({ planType: JSON.parse(match[1]), label: JSON.parse(match[2]), multiplier: Number(match[3]) }));
  assert.equal(roster[1].replace(planPattern, "").replace(/[\s,]/gu, ""), "", "every plan field must be measured");
  assert.ok(plans.length >= 4 && new Set(plans.map((plan) => plan.planType)).size === plans.length);
  assert.match(worker, /function validCount\(value: unknown\): value is number \{\s*return Number\.isSafeInteger\(value\) && \(value as number\) >= 0;\s*\}/u);
  assert.match(history, /function adminHistoryCount\(value\) \{\s*return Number\.isSafeInteger\(value\) && value >= 0 && value <= ADMIN_PREVIEW_COUNT_MAX;\s*\}/u);
  const labelLimit = /model\.label\.length < 1 \|\| model\.label\.length > ([0-9]+)/u.exec(worker);
  assert.ok(labelLimit, "accepted model-label bounds must remain readable");
  return { read, worker, history, days, plans, trailingDays, countMax: Number.MAX_SAFE_INTEGER,
    historyCountMax: closedConstant(history, "ADMIN_PREVIEW_COUNT_MAX"), modelLabelMax: Number(labelLimit[1]),
    schemaVersion: closedConstant(worker, "ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION"),
    basis: closedConstant(worker, "ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS"),
    modelsBasis: closedConstant(worker, "ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS"),
    modelsGate: closedConstant(worker, "ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE"),
    qualification: closedConstant(allowance, "COMMUNITY_ALLOWANCE_QUALIFICATION"),
    spanFloorPp: closedConstant(allowance, "COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP"),
  };
}
const WIDEST_ACCEPTED_HISTORY_COUNT = currentPreviewContract().historyCountMax;

function producerLimits(contract) {
  const owners = contract.read("apps/worker/src/analytics-v2/owners.ts");
  const ownerMax = closedConstant(owners, "MAX_ANALYTICS_V2_OWNERS");
  assert.match(owners, /\[now, MAX_ANALYTICS_V2_OWNERS \+ 1\][\s\S]*?result\.rows\.length > MAX_ANALYTICS_V2_OWNERS\) sourceFail\("ANALYTICS_V2_SOURCE_LIMIT"\)/u);
  const fold = contract.read("apps/worker/src/analytics-v2/compute-community.ts");
  assert.match(fold, /v1ParticipantCount: refused,\s*unsupportedSourceParticipantCount: 0, refusedParticipantCount: refused/u);
  assert.match(fold, /collection\.v1ParticipantCount\+\+/u);
  assert.match(fold, /cohortOwners = computedOwners\.filter/u);
  assert.match(fold, /cohortOwners\.map\(\(owner\) => owner\.ownerDigest\), models/u);
  const resources = contract.read(RESOURCES_PATH);
  const resourceMaximum = (name) => {
    const match = new RegExp(`${name}: Object\\.freeze\\(\\{ minimum: [^,]+, maximum: ([0-9_]+) \\* MIB,`, "u").exec(resources);
    assert.ok(match, `${name}'s enforced maximum must remain readable`);
    return Number(match[1].replaceAll("_", "")) * closedConstant(resources, "MIB");
  };
  assert.match(resources, /entry! > bound\.maximum/u);
  assert.match(resources, /return reclaim \? resources\.outputBudgetBytes \+ resources\.memoryBudgetBytes - largestAdmittedEstimateBytes\s*: resources\.outputBudgetBytes/u);
  assert.match(resources, /rowBaseBytes: 128,\s*bytesPerJsonCharacter: 2,/u);
  assert.match(resources, /return ANALYTICS_V2_OUTPUT_MODEL\.rowBaseBytes \+ text\.length \* ANALYTICS_V2_OUTPUT_MODEL\.bytesPerJsonCharacter/u);
  const compute = contract.read("apps/worker/src/analytics-v2/compute.ts");
  assert.match(compute, /accountBytes \+= bytes;[\s\S]*?if \(accountBytes > outputBudgetBytes\) \{\s*throw new AnalyticsV2OutputBudgetExceeded/u);
  assert.match(compute, /const chargeRow = \(row: unknown\): void => charge\(analyticsV2OutputRowBytes\(row\)\)/u);
  assert.match(compute, /case "fits": ownerFits\.push\(emission\.row\); break;[\s\S]*?chargeRow\(emission\.row\)/u);
  assert.ok(compute.indexOf("chargeRow(emission.row)") < compute.indexOf('timed("community"'), "fits must be charged before community construction");
  assert.match(contract.read("apps/worker/vendor/analytics-d43c8f92/apps/worker/src/community-allowance.ts"),
    /fit: \{ participantId, planType, capacityNanousd: reset\.capacityNanousd,\s*lastObservedAt: reset\.lastObservedAt \}/u);
  // A deliberately loose minimum: every fit contains its 64-character owner
  // digest as one quoted value (66 JSON characters), charged at two bytes per
  // character. Ignore the other keys/values, wrappers and all other output.
  const minimumFitCharacters = JSON.stringify("0".repeat(64)).length;
  const budget = resourceMaximum("memoryBudgetBytes") + resourceMaximum("outputBudgetBytes");
  const fitMax = Math.floor(budget / (2 * minimumFitCharacters));
  assert.ok(Number.isSafeInteger(ownerMax) && ownerMax > 0 && Number.isSafeInteger(fitMax) && fitMax >= ownerMax);
  return { ownerMax, fitMax, budget, minimumFitCharacters };
}
function storageCeilingBytes(contract) {
  const guard = closedConstant(contract.worker, "PREVIEW_CACHE_JSON_LIMIT_BYTES");
  const checks = [
    ["apps/worker/analytics-migrations/0011_community_graph_publication.sql", "analytics_community_graph_previews", /length\(CAST\(payload_json AS BLOB\)\)<=(\d+)/u, true],
    ["apps/worker/postgres/migrations/primary/0053_community_publication_authority.sql", "community_graph_previews", /octet_length\(convert_to\(payload_json, 'UTF8'\)\) <= (\d+)/u, false],
  ].flatMap(([path, table, pattern, required]) => {
    if (!required && !existsSync(new URL(`../${path}`, import.meta.url))) return [];
    const source = repositoryFile(path), start = source.indexOf(`CREATE TABLE ${table} (`);
    assert.notEqual(start, -1, `${path} no longer creates ${table}`);
    const next = source.indexOf("CREATE ", start + 1), match = pattern.exec(source.slice(start, next === -1 ? undefined : next));
    assert.ok(match, `${path} no longer carries the measured payload CHECK`);
    return [Number(match[1])];
  });
  assert.equal(guard, Math.min(...checks), "Worker and retained-store CHECK limits must agree");
  // analytics_v2_preview is jsonb without that CHECK; its current GCP readers
  // enforce this same limit. Do not imply the legacy table is its write guard.
  assert.match(contract.read("apps/worker/src/postgres-admin-allowance-preview.ts"), /encode\(payloadJson\)\.byteLength > PREVIEW_CACHE_JSON_LIMIT_BYTES\) return null/u);
  return guard;
}
function partitionCount(total, parts) {
  return Array.from({ length: parts }, (_, index) => Math.floor(total / parts) + (index < total % parts ? 1 : 0));
}
function widestPreview(contract, fitCount = contract.countMax, participants = fitCount,
  historyCount = Math.min(participants, contract.historyCountMax), acceptedLabels = false, unsupportedCount = historyCount) {
  const toEpoch = Date.parse("2026-09-03T00:00:00.000Z");
  const dates = Array.from({ length: contract.days }, (_, index) => new Date(toEpoch - (contract.days - 1 - index) * MILLISECONDS_PER_DAY).toISOString().slice(0, 10));
  const summary = (fits, people) => ({ fitCount: fits, participantCount: people, centralUsd: WIDEST_DOLLARS,
    band80Usd: { lowerUsd: WIDEST_DOLLARS, upperUsd: WIDEST_DOLLARS } });
  const planFits = partitionCount(fitCount, contract.plans.length), coverageParts = partitionCount(participants, 4);
  const eligible = coverageParts[0], unsupported = coverageParts[1], noQualifying = coverageParts[2], noRecent = coverageParts[3];
  const [fitted, unstable, stale, refused] = partitionCount(historyCount, 4);
  const modelDay = projectAdminModelHistoryDay({ day: dates[0], catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: ADMIN_MODEL_CONFIG.filter((model) => model.allowanceTrack === "primary").map((model) => [model.modelId, WIDEST_DOLLARS, fitted]),
    fittedParticipantCount: fitted, unstableParticipantCount: unstable, staleParticipantCount: stale,
    refusedParticipantCount: refused, v1ParticipantCount: historyCount, unsupportedSourceParticipantCount: unsupportedCount });
  assert.notEqual(modelDay, null, "the measured compact history must be accepted by the public projector");
  return { schemaVersion: contract.schemaVersion, generatedAt: new Date(toEpoch).toISOString(), from: dates[0], to: dates.at(-1),
    basis: contract.basis, referencePlanType: "pro", trailingDays: contract.trailingDays,
    qualification: contract.qualification, spanFloorPp: contract.spanFloorPp, plans: contract.plans,
    coverage: { uploadingParticipantCount: participants, cachedParticipantCount: participants, recentFittedParticipantCount: eligible + unsupported,
      mergeEligibleParticipantCount: eligible, noQualifyingFitParticipantCount: noQualifying, noRecentFitParticipantCount: noRecent,
      unsupportedPlanParticipantCount: unsupported },
    days: dates.map((day, index) => ({ day, combined: summary(fitCount, index === dates.length - 1 ? eligible : participants),
      byPlanType: Object.fromEntries(contract.plans.map((plan, planIndex) => [plan.planType,
        summary(planFits[planIndex], index === dates.length - 1 ? Math.min(eligible, planFits[planIndex]) : Math.min(participants, planFits[planIndex]))])) })),
    models: { modelConfig: acceptedLabels ? ADMIN_MODEL_CONFIG.map((model) => ({ ...model, label: "\u0001".repeat(contract.modelLabelMax) })) : ADMIN_MODEL_CONFIG,
      basis: contract.modelsBasis, gate: contract.modelsGate, days: dates.map((day) => ({ ...modelDay, day })) },
  };
}
function producerEnvelope(contract) {
  const limits = producerLimits(contract);
  const preview = widestPreview(contract, limits.fitMax, limits.ownerMax, limits.ownerMax, false, 0);
  // The conserved fixture cannot maximize every count's decimal width at once.
  // Pad each field to its independent producer maximum instead. This is a
  // conservative byte envelope, not a claim every combination is reachable.
  const padding = (value, maximum) => String(maximum).length - String(value).length;
  let extra = Object.values(preview.coverage).reduce((sum, value) => sum + padding(value, limits.ownerMax), 0);
  for (const day of preview.days) for (const summary of [day.combined, ...Object.values(day.byPlanType)]) {
    extra += padding(summary.fitCount, limits.fitMax) + padding(summary.participantCount, limits.ownerMax);
  }
  for (const day of preview.models.days) {
    for (const [key, value] of Object.entries(day)) if (key.endsWith("ParticipantCount")) extra += padding(value, key === "unsupportedSourceParticipantCount" ? 0 : limits.ownerMax);
    for (const tuple of day.values) extra += padding(tuple[2], limits.ownerMax);
  }
  assert.ok(extra >= 0);
  return { preview, bytes: jsonBytes(preview) + extra, paddingBytes: extra, ...limits };
}
function assertKeys(value, source, pattern, label) {
  assert.deepEqual(Object.keys(value).sort(), closedKeys(source, pattern, label).sort(), `${label} key coverage`);
}

test("the current preview and every nested closed key list are accounted for by the size gate", () => {
  const contract = currentPreviewContract(), preview = widestPreview(contract);
  for (const [value, name] of [[preview, "preview"], [preview.plans[0], "plan"], [preview.days[0], "day"],
    [preview.days[0].combined, "summary"], [preview.days[0].combined.band80Usd, "band"], [preview.models, "models"], [preview.models.modelConfig[0], "model"]]) {
    assertKeys(value, contract.worker, new RegExp(`exactKeys\\(${name}, \\[([^\\]]*)\\]`, "u"), name);
  }
  assertKeys(preview.coverage, contract.worker, /const coverageKeys = \[([^\]]*)\] as const/u, "coverage");
  assert.deepEqual(Object.keys(preview.days[0].byPlanType), contract.plans.map((plan) => plan.planType));
  const counts = closedKeys(contract.history, /const adminHistoryCountKeys = Object\.freeze\(\[([^\]]*)\]/u, "history counters");
  assert.match(contract.history, /adminHistoryExactKeys\(input, \["day", "catalogVersion", "values", \.\.\.adminHistoryCountKeys\]\)/u);
  assert.deepEqual(Object.keys(preview.models.days[0]).sort(), ["day", "catalogVersion", "values", ...counts].sort());
  assert.ok(preview.models.days.every((day) => day.values.every((tuple) => tuple.length === 3)));
  assert.equal(JSON.stringify(WIDEST_DOLLARS).length, 24);
});

test("the bounded current GCP producer envelope fits the complete preview byte guard", (t) => {
  const contract = currentPreviewContract(), envelope = producerEnvelope(contract), ceiling = storageCeilingBytes(contract);
  t.diagnostic(`${contract.schemaVersion}: ${contract.days} days, ${contract.plans.length} plans, ${ADMIN_MODEL_CONFIG.length} models; `
    + `owners <= ${envelope.ownerMax}, fits <= ${envelope.fitMax}; conserved fixture ${jsonBytes(envelope.preview)} B + `
    + `${envelope.paddingBytes} B independent count-width padding = ${envelope.bytes} B of ${ceiling} B (${ceiling - envelope.bytes} B margin)`);
  assert.ok(envelope.bytes < ceiling, `the source-bounded current GCP envelope is ${envelope.bytes} B of ${ceiling} B`);
});

test("source-resolved horizon and resource growth change the measured producer envelope", () => {
  const current = currentPreviewContract(), base = producerEnvelope(current);
  const longer = currentPreviewContract({ [WINDOW_PATH]: repositoryFile(WINDOW_PATH).replace(
    "V1_ANALYSIS_WINDOW_DAYS = 100;", "V1_ANALYSIS_WINDOW_DAYS = 140;") });
  assert.equal(longer.days, current.days + 40, "the horizon mutation must affect its real dependency chain");
  assert.ok(producerEnvelope(longer).bytes > storageCeilingBytes(longer), "horizon growth must exhaust the actual margin");
  const expanded = currentPreviewContract({ [RESOURCES_PATH]: repositoryFile(RESOURCES_PATH).replaceAll("maximum: 30_720 * MIB", "maximum: 3_072_000 * MIB") });
  const resourceGrowth = producerEnvelope(expanded);
  assert.ok(resourceGrowth.fitMax > base.fitMax && resourceGrowth.bytes > base.bytes, "accepted resource growth must change count widths and bytes");
  const narrowerHistory = currentPreviewContract({ [HISTORY_PATH]: repositoryFile(HISTORY_PATH).replace(
    "const ADMIN_PREVIEW_COUNT_MAX = 99_999_999_999_999;", "const ADMIN_PREVIEW_COUNT_MAX = 9_999_999_999_999;") });
  assert.equal(String(narrowerHistory.historyCountMax).length, 13, "the count mutation must change the canonical source bound");
  assert.ok(jsonBytes(widestPreview(narrowerHistory)) < storageCeilingBytes(narrowerHistory));
  assert.ok(jsonBytes(widestPreview(current)) > storageCeilingBytes(current), "accepted-count widening must cross byte admission independently of producer admission");
  const widerHistory = currentPreviewContract({ [HISTORY_PATH]: repositoryFile(HISTORY_PATH).replace(
    "const ADMIN_PREVIEW_COUNT_MAX = 99_999_999_999_999;", "const ADMIN_PREVIEW_COUNT_MAX = 999_999_999_999_999;") });
  assert.equal(String(widerHistory.historyCountMax).length, String(current.historyCountMax).length + 1,
    "the scalar accepted-count ceiling must stay source-bound even though the producer limit is lower");
});

test("scalar-valid extreme widths exceed the independent byte-admission contract", (t) => {
  const contract = currentPreviewContract(), ceiling = storageCeilingBytes(contract);
  const scalar = widestPreview(contract), labels = widestPreview(contract, contract.countMax, contract.countMax,
    contract.historyCountMax, true);
  const canonicalBytes = jsonBytes(scalar), acceptedLabelBytes = jsonBytes(labels);
  t.diagnostic(`scalar-valid count maxima with canonical labels ${canonicalBytes} B (${canonicalBytes - ceiling} B over); `
    + `accepted 80-unit escaped labels ${acceptedLabelBytes} B (${acceptedLabelBytes - ceiling} B over)`);
  assert.ok(canonicalBytes > ceiling && acceptedLabelBytes > canonicalBytes);
  // Actual byte refusal is covered by Worker admin-community-allowance.spec.ts
  // "preserves old evidence dates but fails closed for ... oversized ... rows".
  // Pin that live read boundary here; do not replicate its validator or claim
  // that scalar acceptance authorizes persistence/serving of an oversized row.
  assert.match(contract.worker, /encode\(row\.payload_json\)\.byteLength\s*> PREVIEW_CACHE_JSON_LIMIT_BYTES\) \{\s*return previewCacheUnavailable\(\)/u);
  assert.match(contract.worker, /encode\(payloadJson\)\.byteLength\s*> PREVIEW_CACHE_JSON_LIMIT_BYTES[\s\S]*?return \{ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" \}/u);
});
