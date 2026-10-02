import assert from "node:assert/strict";
import test from "node:test";
import { buildCommunityAllowanceChartModel, renderCommunityAllowanceSection } from "../public/community-view.js";
import {
  PUBLIC_ALLOWANCE_MODEL_CONFIG, PUBLIC_MODEL_METADATA_MAX_ENTRIES,
  normalizeCommunityDailySeries, normalizePublicAllowanceBreakdowns,
  projectCommunityDailyPayloadForCache, publicAllowanceModels,
} from "../public/community-data.js";
import { REVIEWED_MODEL_CATALOG } from "../public/model-catalog.generated.js";
import { translate } from "../public/localization.js";
import { publicAllowanceFixture } from "./fixtures/public-allowance.js";

// Synthetic public wire data only. The "canary" ids stand for a model this
// page has never heard of; none of them may ever be retained or rendered.
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const CANARY = "private-model-canary-7f3a";
const SECOND_CANARY = "next-generation-canary-91c2";
const NEWER = { id: "gpt-7-nova", label: "GPT-7 Nova", family: "sol", order: 0 };

// The fixture carries estimates on its last ten days. Add tuples to the last
// five so counts are exact and the earlier days stay untouched.
function withTuples(payload, tuples) {
  for (const day of payload.allowanceBreakdowns.days.slice(-5)) day.models = [...day.models, ...tuples];
  return payload;
}
const withMetadata = (payload, entries) => {
  payload.allowanceBreakdowns.modelConfig = entries;
  return payload;
};
const modelsChart = (payload, nowMs = NOW) =>
  buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload, { nowMs }), { view: "models" });

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = new Map(); this.textContent = ""; this.className = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].join(" "); }
}
const documentRef = () => ({ documentElement: { lang: "en-US" }, createElement: tag => new Element(tag),
  createElementNS: (_, tag) => new Element(tag) });
function render(payload, view) {
  const container = new Element("div");
  const state = renderCommunityAllowanceSection({ documentRef: documentRef(), container, payload, view });
  return { container, state, text: container.text };
}
const everyAttribute = element => element.descendants().flatMap(node => [...node.attributes.values()].map(String));

test("an unknown model tuple is dropped and counted while every other breakdown survives", () => {
  const payload = withTuples(publicAllowanceFixture(NOW), [
    [CANARY, 4321, 2], [SECOND_CANARY, 99, 1], ["gpt-5.3-codex-spark", 800, 1], ["claude-opus-5", 700, 1],
  ]);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  const { breakdowns } = normalized;
  assert.notEqual(breakdowns, null, "one unknown model must not null every breakdown");
  assert.equal(breakdowns.unrecognizedModelTuples, 20, "four tuples on each of five days");
  assert.equal(breakdowns.unrecognizedModelCount, 4, "distinct ids, counted without being kept");
  assert.equal(breakdowns.modelMetadata, "absent");
  // Known tuples are untouched, and nothing unknown was kept anywhere.
  const clean = normalizeCommunityDailySeries(publicAllowanceFixture(NOW), { nowMs: NOW }).breakdowns;
  assert.deepEqual(breakdowns.days, clean.days);
  assert.deepEqual(breakdowns.modelConfig, clean.modelConfig);
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(`${CANARY}|${SECOND_CANARY}|claude-opus-5|spark`, "u"));
  assert.ok(breakdowns.modelConfig.every(model => model.modelId !== "gpt-5.3-codex-spark"));
  // All three views still draw, and the model view draws only known models.
  for (const view of ["aggregate", "plans", "models"]) {
    assert.ok(buildCommunityAllowanceChartModel(normalized, { view }).dots.length > 0, view);
  }
  assert.deepEqual(modelsChart(payload).legendSeries.map(series => series.key),
    modelsChart(publicAllowanceFixture(NOW)).legendSeries.map(series => series.key));
});

test("the tuple's numbers and shape stay closed, even when its id is unknown", () => {
  const invalid = [
    [CANARY, "1234", 1], [CANARY, 1234, 0], [CANARY, 1234, 1.5], [CANARY, -1, 1], [CANARY, 0, 1],
    [CANARY, Infinity, 1], [CANARY, NaN, 1], [CANARY, 1234, 1, "extra"], [CANARY, 1234],
    [null, 1234, 1], [7, 1234, 1], [["nested"], 1234, 1], { id: CANARY }, CANARY, null,
  ];
  for (const tuple of invalid) {
    const payload = withTuples(publicAllowanceFixture(NOW), [tuple]);
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(normalized.breakdowns, null, JSON.stringify(tuple));
    assert.equal(normalized.state, "published", "activity is never hidden by an invalid breakdown");
    assert.doesNotMatch(JSON.stringify(normalized), new RegExp(CANARY, "u"));
  }
  // A duplicated KNOWN id is still a producer fault. A repeated unknown id is
  // not retained, so it is only counted twice.
  const duplicate = withTuples(publicAllowanceFixture(NOW), [["gpt-6-astra", 1, 1], ["gpt-6-astra", 1, 1]]);
  assert.equal(normalizeCommunityDailySeries(duplicate, { nowMs: NOW }).breakdowns, null);
  const repeated = withTuples(publicAllowanceFixture(NOW), [[CANARY, 1, 1], [CANARY, 2, 1]]);
  const counted = normalizeCommunityDailySeries(repeated, { nowMs: NOW }).breakdowns;
  assert.equal(counted.unrecognizedModelTuples, 10);
  assert.equal(counted.unrecognizedModelCount, 1);
  // Everything outside the model tuples is as closed as before.
  for (const mutate of [
    value => { value.participant_id = "PRIVATE_CANARY"; },
    value => { value.days[0].coverage = { raw: "PRIVATE_CANARY" }; },
    value => { value.days[0].byPlanType.team = value.days[0].byPlanType.pro; },
    value => { value.days[0].models = Array.from({ length: 257 }, (_, index) => [`next-${index}`, 1, 1]); },
  ]) {
    const payload = publicAllowanceFixture(NOW);
    mutate(payload.allowanceBreakdowns);
    assert.equal(normalizeCommunityDailySeries(payload, { nowMs: NOW }).breakdowns, null, mutate.toString());
  }
  const atCap = publicAllowanceFixture(NOW);
  atCap.allowanceBreakdowns.days[0].models = Array.from({ length: 256 }, (_, index) => [`next-${index}`, 1, 1]);
  assert.equal(normalizeCommunityDailySeries(atCap, { nowMs: NOW }).breakdowns.unrecognizedModelTuples, 256);
});

test("a model with no known identity is never rendered, and the model view says its estimates are left out", () => {
  const payload = withTuples(publicAllowanceFixture(), [[CANARY, 4321, 2], [SECOND_CANARY, 99, 1]]);
  const notice = translate("community.allowance.unrecognizedModels", {}, "en-US");
  assert.notEqual(notice, "community.allowance.unrecognizedModels");
  const models = render(payload, "models");
  assert.equal(models.state, "published");
  assert.ok(models.text.includes(notice), "the gap is stated, not silent");
  assert.ok(models.text.includes("GPT-6 Astra"), "known models still draw");
  assert.doesNotMatch(models.text, new RegExp(`${CANARY}|${SECOND_CANARY}`, "u"));
  assert.ok(everyAttribute(models.container).every(value => !value.includes(CANARY) && !value.includes(SECOND_CANARY)));
  // The plan and aggregate views never depended on the dropped tuples.
  for (const view of ["aggregate", "plans"]) {
    const other = render(payload, view);
    assert.equal(other.state, "published");
    assert.ok(!other.text.includes(notice), view);
  }
  // No unknown tuples, no notice.
  assert.ok(!render(publicAllowanceFixture(), "models").text.includes(notice));
  // Nothing but unknown tuples: the accumulating state states the gap too.
  const onlyUnknown = publicAllowanceFixture();
  onlyUnknown.allowanceBreakdowns.days.forEach(day => { day.models = [[CANARY, 10, 1]]; });
  const empty = render(onlyUnknown, "models");
  assert.equal(empty.state, "estimates_accumulating");
  assert.ok(empty.text.includes(notice));
  assert.doesNotMatch(empty.text, new RegExp(CANARY, "u"));
  for (const locale of ["zh-Hans", "es"]) {
    assert.notEqual(translate("community.allowance.unrecognizedModels", {}, locale), notice);
  }
});

test("published model metadata names and orders models this build has never seen", () => {
  const payload = withMetadata(withTuples(publicAllowanceFixture(NOW), [[NEWER.id, 5000, 2]]), [
    NEWER,
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (renamed)", family: "sol", order: 1 },
  ]);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.breakdowns.modelMetadata, "applied");
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 0);
  const chart = buildCommunityAllowanceChartModel(normalized, { view: "models" });
  const keys = chart.legendSeries.map(series => series.key);
  // Published order leads; the page's own order follows, unchanged.
  const baseline = modelsChart(publicAllowanceFixture(NOW)).legendSeries.map(series => series.key);
  assert.ok(baseline.includes("gpt-5.6-sol") && baseline.includes("gpt-6-astra"));
  assert.deepEqual(keys, [NEWER.id, "gpt-5.6-sol", ...baseline.filter(key => key !== "gpt-5.6-sol")]);
  assert.equal(chart.legendSeries[0].label, "GPT-7 Nova");
  assert.equal(chart.legendSeries[1].label, "GPT-5.6 Sol (renamed)", "metadata replaces the catalog label");
  assert.equal(chart.legendSeries[0].theme, "sol", "a known family reuses its identity");
  assert.match(chart.legendSeries[0].className, /allowance-model-sol/u);
  assert.equal(chart.legendSeries.find(series => series.key === "gpt-6-astra").label, "GPT-6 Astra");
  assert.ok(chart.dots.some(dot => dot.seriesKey === NEWER.id && dot.centralUsd === 5000));
  // The same payload WITHOUT the block behaves exactly as the page did before.
  const bare = publicAllowanceFixture(NOW);
  withTuples(bare, [[NEWER.id, 5000, 2]]);
  const plain = normalizeCommunityDailySeries(bare, { nowMs: NOW });
  assert.equal(plain.breakdowns.modelMetadata, "absent");
  assert.equal(plain.breakdowns.unrecognizedModelTuples, 5);
  assert.deepEqual(buildCommunityAllowanceChartModel(plain, { view: "models" }).legendSeries.map(series => series.key),
    baseline);
  // Reviewed catalog entries are never removed or reordered in place.
  assert.deepEqual(normalized.breakdowns.modelConfig.slice(0, PUBLIC_ALLOWANCE_MODEL_CONFIG.length).map(model => model.modelId),
    PUBLIC_ALLOWANCE_MODEL_CONFIG.map(model => model.modelId));
  assert.ok(PUBLIC_ALLOWANCE_MODEL_CONFIG.every(model => model.family === undefined && model.order === undefined));
});

test("a family outside the closed theme set draws with the generic series colours, and the rendered label is escaped text", () => {
  const entry = { id: "gpt-7-nova", label: "GPT-7 Nova (preview) 1/2", family: "nova", order: 3 };
  const payload = withMetadata(withTuples(publicAllowanceFixture(), [[entry.id, 5000, 2]]), [entry]);
  const chart = buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload), { view: "models" });
  const nova = chart.legendSeries.find(series => series.key === entry.id);
  assert.equal(nova.theme, null);
  assert.match(nova.className, /^allowance-series-\d$/u);
  const models = render(payload, "models");
  assert.ok(models.text.includes(entry.label));
  assert.ok(!models.text.includes(translate("community.allowance.unrecognizedModels", {}, "en-US")));
});

test("a malformed metadata block is ignored whole and reported, never partly trusted", () => {
  const bad = [
    ["not an array", () => "gpt-7-nova"],
    ["extra entry key", () => [{ ...NEWER, raw: "PRIVATE_CANARY" }]],
    ["missing family", () => [{ id: NEWER.id, label: NEWER.label, order: 0 }]],
    ["null family", () => [{ ...NEWER, family: null }]],
    ["markup in the label", () => [{ ...NEWER, label: "<img src=x onerror=alert(1)>" }]],
    ["control character in the label", () => [{ ...NEWER, label: "GPT-7\u0007Nova" }]],
    ["blank label", () => [{ ...NEWER, label: "" }]],
    ["oversized label", () => [{ ...NEWER, label: "N".repeat(81) }]],
    ["id with a space", () => [{ ...NEWER, id: "gpt 7 nova" }]],
    ["id with a quote", () => [{ ...NEWER, id: 'gpt-7"nova' }]],
    ["oversized id", () => [{ ...NEWER, id: `g${"x".repeat(128)}` }]],
    ["uppercase family", () => [{ ...NEWER, family: "Sol" }]],
    ["oversized family", () => [{ ...NEWER, family: "f".repeat(25) }]],
    ["negative order", () => [{ ...NEWER, order: -1 }]],
    ["fractional order", () => [{ ...NEWER, order: 1.5 }]],
    ["string order", () => [{ ...NEWER, order: "1" }]],
    ["order above the cap", () => [{ ...NEWER, order: 10_000 }]],
    ["duplicate id", () => [NEWER, { ...NEWER, label: "GPT-7 Nova Two" }]],
    ["Spark promoted onto the primary comparison", () => [{ ...NEWER, id: "gpt-5.3-codex-spark" }]],
    ["another provider's model", () => [{ ...NEWER, id: "claude-opus-5" }]],
    ["one bad entry beside a good one", () => [NEWER, { ...NEWER, id: "gpt-7-nova-two", order: -2 }]],
    ["too many entries", () => Array.from({ length: PUBLIC_MODEL_METADATA_MAX_ENTRIES + 1 },
      (_, index) => ({ id: `gpt-7-n${index}`, label: `Model ${index}`, family: "sol", order: index }))],
  ];
  for (const [name, entries] of bad) {
    const payload = withMetadata(withTuples(publicAllowanceFixture(NOW), [[NEWER.id, 5000, 2]]), entries());
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    const { breakdowns } = normalized;
    assert.notEqual(breakdowns, null, name);
    assert.equal(breakdowns.modelMetadata, "rejected", name);
    // Behaves as if the block were absent: its model is simply unrecognized.
    assert.equal(breakdowns.unrecognizedModelTuples, 5, name);
    assert.deepEqual(breakdowns.modelConfig, PUBLIC_ALLOWANCE_MODEL_CONFIG, name);
    assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_CANARY|onerror|gpt-7-nova/u, name);
  }
  // The block is only an optional extra key on a closed envelope.
  const extra = withMetadata(publicAllowanceFixture(NOW), [NEWER]);
  extra.allowanceBreakdowns.participant_id = "PRIVATE_CANARY";
  assert.equal(normalizeCommunityDailySeries(extra, { nowMs: NOW }).breakdowns, null);
  // An empty block is valid and adds nothing.
  const empty = normalizeCommunityDailySeries(withMetadata(publicAllowanceFixture(NOW), []), { nowMs: NOW });
  assert.equal(empty.breakdowns.modelMetadata, "applied");
  assert.deepEqual(empty.breakdowns.modelConfig, PUBLIC_ALLOWANCE_MODEL_CONFIG);
  // The count cap itself is accepted exactly at the limit, and its size is bounded.
  const full = Array.from({ length: PUBLIC_MODEL_METADATA_MAX_ENTRIES }, (_, index) => ({
    id: `${"i".repeat(120)}-${String(index).padStart(3, "0")}`, label: "L".repeat(80),
    family: "f".repeat(24), order: 9999,
  }));
  assert.equal(normalizeCommunityDailySeries(withMetadata(publicAllowanceFixture(NOW), full), { nowMs: NOW })
    .breakdowns.modelMetadata, "applied");
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < 40 * 1024, "even a maximal metadata block has a bounded wire size");
});

test("the stored copy keeps an applied block, drops every unrecognized tuple, and re-reads as the same series", () => {
  const payload = withMetadata(withTuples(publicAllowanceFixture(NOW), [[NEWER.id, 5000, 2], [CANARY, 1, 1]]), [NEWER]);
  const live = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  const stored = projectCommunityDailyPayloadForCache(payload, { nowMs: NOW });
  assert.deepEqual(stored.allowanceBreakdowns.modelConfig, [NEWER]);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(CANARY, "u"));
  const reread = normalizeCommunityDailySeries(stored, { nowMs: NOW });
  assert.equal(reread.breakdowns.modelMetadata, "applied");
  assert.deepEqual(reread.breakdowns.days, live.breakdowns.days);
  assert.deepEqual(reread.breakdowns.modelConfig, live.breakdowns.modelConfig);
  assert.equal(reread.breakdowns.unrecognizedModelTuples, 0, "the dropped tuples are not in the stored copy");
  assert.deepEqual(buildCommunityAllowanceChartModel(reread, { view: "models" }),
    buildCommunityAllowanceChartModel(live, { view: "models" }));
  // Without a block there is no stored block, exactly as before.
  const bare = projectCommunityDailyPayloadForCache(withTuples(publicAllowanceFixture(NOW), [[CANARY, 1, 1]]), { nowMs: NOW });
  assert.equal("modelConfig" in bare.allowanceBreakdowns, false);
  assert.doesNotMatch(JSON.stringify(bare), new RegExp(CANARY, "u"));
  // A rejected block is not stored either.
  const rejected = projectCommunityDailyPayloadForCache(
    withMetadata(publicAllowanceFixture(NOW), [{ ...NEWER, order: -1 }]), { nowMs: NOW });
  assert.equal("modelConfig" in rejected.allowanceBreakdowns, false);
});

// The page charts a selected roster (2d6cfbc8, "six requested public allowance
// models") and keeps older generations off it with an explicit, frozen hide
// list. Everything else the catalog names is charted, so a model appended later
// needs no page edit.
test("a catalog model on the hide list is recognized and kept but never charted, and is not counted as unrecognized", () => {
  // The fixture already carries GPT-5.5 estimates, which the owner's selection also leaves off.
  const hidden = [["gpt-5.4", 700, 2], ["gpt-4.1", 300, 1], ["o3", 250, 1]];
  const normalized = normalizeCommunityDailySeries(withTuples(publicAllowanceFixture(NOW), hidden), { nowMs: NOW });
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 0, "the catalog knows them");
  assert.ok(normalized.breakdowns.days.at(-1).models.some(([id]) => id === "gpt-5.4"), "valid tuples are kept");
  const keys = buildCommunityAllowanceChartModel(normalized, { view: "models" }).legendSeries.map(series => series.key);
  for (const [id] of [...hidden, ["gpt-5.5"]]) assert.ok(!keys.includes(id), `${id} stays off the page`);
  assert.deepEqual(normalized.breakdowns.modelConfig, PUBLIC_ALLOWANCE_MODEL_CONFIG);
  assert.ok(!render(withTuples(publicAllowanceFixture(), hidden), "models").text.includes("GPT-5.4"));
  // The stored copy keeps what was valid, exactly as before this change.
  const stored = projectCommunityDailyPayloadForCache(withTuples(publicAllowanceFixture(NOW), hidden), { nowMs: NOW });
  assert.ok(stored.allowanceBreakdowns.days.at(-1).models.some(([id]) => id === "gpt-5.4"));
});

test("a model appended to the catalog after the hide list was frozen is charted automatically, after the pinned roster", () => {
  const appended = { id: "gpt-9-appended", label: "GPT-9 Appended", provider: "openai_codex",
    allowanceTrack: "primary", pricingStatus: "published", priceModelId: "gpt-9-appended" };
  const before = publicAllowanceModels();
  const after = publicAllowanceModels([...REVIEWED_MODEL_CATALOG, appended]);
  assert.deepEqual(before.charted.map(model => model.modelId), PUBLIC_ALLOWANCE_MODEL_CONFIG.map(model => model.modelId));
  assert.ok(before.charted.length >= 7 && before.charted.slice(0, 7).every(model => model.pinned === true),
    "the roster leads and is pinned");
  assert.ok(before.charted.slice(7).every(model => model.pinned === undefined));
  assert.deepEqual(after.charted.slice(0, before.charted.length), before.charted);
  assert.deepEqual(after.charted.slice(before.charted.length), [{ modelId: appended.id, label: appended.label }]);
  assert.ok(after.known.has(appended.id) && !before.known.has(appended.id));
  // Every reviewed primary Codex model is known; the hide list can only hide, never invent.
  for (const model of REVIEWED_MODEL_CATALOG) {
    if (model.provider === "openai_codex" && model.allowanceTrack === "primary") assert.ok(before.known.has(model.id), model.id);
    else assert.ok(!before.known.has(model.id), `${model.id} is not a primary Codex model`);
  }
  // Charted extras appear only once they have an estimate; the roster keeps its cards.
  const chart = modelsChart(withTuples(publicAllowanceFixture(NOW), []));
  assert.deepEqual(chart.cardSeries.filter(card => card.latest === null).map(card => card.key).sort(),
    PUBLIC_ALLOWANCE_MODEL_CONFIG.filter(model => model.pinned && !chart.legendSeries.some(series => series.key === model.modelId))
      .map(model => model.modelId).sort());
  assert.ok(chart.cardSeries.every(card => PUBLIC_ALLOWANCE_MODEL_CONFIG.find(model => model.modelId === card.key)?.pinned === true
    || card.latest !== null));
});

test("published metadata charts a model the hide list keeps off, with the published label", () => {
  const entry = { id: "gpt-5.4", label: "GPT-5.4 (published)", family: "classic", order: 2 };
  const payload = withMetadata(withTuples(publicAllowanceFixture(NOW), [[entry.id, 700, 2]]), [entry]);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.breakdowns.modelMetadata, "applied");
  const chart = buildCommunityAllowanceChartModel(normalized, { view: "models" });
  const shown = chart.legendSeries.find(series => series.key === entry.id);
  assert.equal(shown.label, entry.label);
  assert.equal(shown.theme, "classic");
  assert.ok(chart.cardSeries.some(card => card.key === entry.id));
});

test("breakdown normalization is a pure function of its inputs", () => {
  const payload = withMetadata(withTuples(publicAllowanceFixture(NOW), [[NEWER.id, 5000, 2], [CANARY, 1, 1]]), [NEWER]);
  const days = payload.days.map(day => day.day);
  const first = normalizePublicAllowanceBreakdowns(payload.allowanceBreakdowns, days, NOW);
  const second = normalizePublicAllowanceBreakdowns(payload.allowanceBreakdowns, days, NOW);
  assert.deepEqual(first, second);
  first.modelConfig.push({ modelId: "mutated", label: "mutated" });
  assert.equal(normalizePublicAllowanceBreakdowns(payload.allowanceBreakdowns, days, NOW).modelConfig.length,
    second.modelConfig.length, "a caller cannot grow the next result");
  assert.equal(PUBLIC_ALLOWANCE_MODEL_CONFIG.length, PUBLIC_ALLOWANCE_MODEL_CONFIG.filter(model => Object.isFrozen(model)).length);
});
