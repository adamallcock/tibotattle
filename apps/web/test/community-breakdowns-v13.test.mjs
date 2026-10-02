import assert from "node:assert/strict";
import test from "node:test";
import { buildCommunityAllowanceChartModel, renderCommunityAllowanceSection } from "../public/community-view.js";
import {
  COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS, COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
  normalizeCommunityDailySeries, projectCommunityDailyPayloadForCache,
} from "../public/community-data.js";
import { createLastKnownGoodStore } from "../public/last-known-good.js";
import { translate } from "../public/localization.js";
import { publicAllowanceFixture } from "./fixtures/public-allowance.js";

// Community allowance breakdowns v1.3 is v1.1's meaning (the Pro 20x basis, with
// `combined`) plus one closed model-metadata block. The block below is the six
// models the public page is meant to chart, in the page's card order, as the
// producer publishes it. Synthetic public wire data only: the "canary" id stands
// for a model neither this build's catalog nor the block has ever named.
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const V13 = "community-allowance-breakdowns-v1.3";
const CANARY = "private-model-canary-7f3a";
const SIX_MODELS = Object.freeze([
  { id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", family: "sol", order: 1 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", family: "luna", order: 2 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", family: "terra", order: 3 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", family: "sol", order: 4 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", family: "luna", order: 5 },
]);

// The shared fixture is the current v1.2 publication. v1.3 carries the legacy
// Pro 20x basis and its three plans, so rebuild exactly that, as the v1.1 test
// in public-allowance-views does, then relabel it and append the block last.
function legacyFixture(version, block = SIX_MODELS.map(model => ({ ...model }))) {
  const payload = publicAllowanceFixture(NOW);
  const legacy = {
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
    normalization: "pro_x1_prolite_x4_plus_x20",
  };
  for (const day of payload.days) Object.assign(day.payload.allowance, legacy);
  const breakdowns = payload.allowanceBreakdowns;
  Object.assign(breakdowns, legacy, {
    schemaVersion: version,
    modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition",
  });
  for (const day of breakdowns.days) delete day.byPlanType.promax;
  if (block !== null) breakdowns.modelConfig = block;
  return payload;
}
const v13 = block => legacyFixture(V13, block);
// The v1.0 row shape: the same publication with `combined` removed from every
// breakdown day. A newer version that happens to carry this shape is the one
// payload the row check cannot refuse, so only the accepted-version list can.
function withoutCombined(payload) {
  for (const day of payload.allowanceBreakdowns.days) delete day.combined;
  return payload;
}
// The same publication, as v1.1 served it before the block was added.
const v11 = () => legacyFixture("community-allowance-breakdowns-v1.1", null);

// The fixture carries estimates on its last ten days. Add tuples to the last
// five so counts are exact and the earlier days stay untouched.
function withTuples(payload, tuples) {
  for (const day of payload.allowanceBreakdowns.days.slice(-5)) day.models = [...day.models, ...tuples];
  return payload;
}
const series = payload => normalizeCommunityDailySeries(payload, { nowMs: NOW });
const modelsChart = payload => buildCommunityAllowanceChartModel(series(payload), { view: "models" });

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
function render(payload, view, cache = null) {
  const container = new Element("div");
  const state = renderCommunityAllowanceSection({ documentRef: documentRef(), container, payload, view, cache });
  return { container, state, text: container.text };
}
const everyAttribute = element => element.descendants().flatMap(node => [...node.attributes.values()].map(String));
const RETAINED = Object.freeze({ fetchedAt: "2026-09-07T10:00:00.000Z", ageMs: 7_200_000 });
const NOTICE = translate("community.allowance.unrecognizedModels", {}, "en-US");
const UNAVAILABLE = translate("community.allowance.breakdownsUnavailable", {}, "en-US");

test("a v1.3 breakdown block is accepted, read on the legacy basis and carrying combined", () => {
  assert.ok(COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS.includes(V13));
  const normalized = series(v13());
  assert.equal(normalized.state, "published");
  const { breakdowns } = normalized;
  assert.notEqual(breakdowns, null, "v1.3 must not be refused whole");
  assert.equal(breakdowns.hasCombined, true);
  assert.equal(breakdowns.isCurrent, false, "only v1.2 is the current basis");
  assert.equal(breakdowns.normalization, "pro_x1_prolite_x4_plus_x20");
  assert.deepEqual(breakdowns.planIds, ["pro", "prolite", "plus"]);
  assert.equal(breakdowns.modelMetadata, "applied");
  assert.equal(breakdowns.unrecognizedModelTuples, 0);
  assert.ok(breakdowns.days.every(day => day.combined !== undefined && day.combined !== null));
  // v1.2 stays the one current version, and v1.1 is unchanged beside it.
  assert.equal(series(publicAllowanceFixture(NOW)).breakdowns.isCurrent, true);
  assert.equal(series(v11()).breakdowns.isCurrent, false);
  assert.equal(series(v11()).breakdowns.hasCombined, true);
});

test("a v1.3 block carries exactly v1.1's values, and the block only adds names and order", () => {
  const live = series(v13()).breakdowns;
  const base = series(v11()).breakdowns;
  assert.deepEqual(live.days, base.days, "the two edits, relabel and block, change no value");
  assert.equal(base.modelMetadata, "absent");
  assert.equal(live.generatedAt, base.generatedAt);
  assert.deepEqual(live.modelConfig.filter(model => model.order !== undefined).map(model => model.modelId),
    SIX_MODELS.map(model => model.id));
});

test("a v1.3 payload draws every view, and the model view charts the block's models in published order", () => {
  const normalized = series(v13());
  for (const view of ["aggregate", "plans", "models"]) {
    assert.ok(buildCommunityAllowanceChartModel(normalized, { view }).dots.length > 0, view);
  }
  const chart = modelsChart(v13());
  assert.deepEqual(chart.legendSeries.map(item => item.key),
    ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"], "published order leads");
  assert.deepEqual(chart.legendSeries.map(item => item.label),
    ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Sol"]);
  const models = render(v13(), "models");
  assert.equal(models.state, "published");
  for (const label of ["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Sol"]) assert.ok(models.text.includes(label), label);
  assert.ok(!models.text.includes(NOTICE), "nothing was left out");
  // The legacy basis is stated as the legacy basis, never as the current one.
  assert.ok(render(v13(), "plans").text.includes("Pro 20×"));
  assert.ok(!render(v13(), "plans").text.includes("Pro 10×"));
});

test("a v1.3 model the block does not name and the page keeps off stays unrendered, and its tuples are kept", () => {
  // The fixture carries GPT-5.5 estimates. The catalog knows GPT-5.5 and the
  // owner's selection leaves it off the page; the six-model block never names it.
  const normalized = series(v13());
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 0, "known to the catalog, so not unrecognized");
  assert.ok(normalized.breakdowns.days.at(-1).models.some(([id]) => id === "gpt-5.5"), "its valid tuples are kept");
  assert.ok(!modelsChart(v13()).legendSeries.some(item => item.key === "gpt-5.5"));
  assert.ok(!modelsChart(v13()).cardSeries.some(item => item.key === "gpt-5.5"));
  const models = render(v13(), "models");
  assert.ok(!models.text.includes("GPT-5.5"));
  assert.ok(everyAttribute(models.container).every(value => !value.includes("gpt-5.5")));
});

test("an unknown model name outside the catalog is not shown publicly under v1.3, only counted and stated", () => {
  const payload = withTuples(v13(), [[CANARY, 4321, 2]]);
  const normalized = series(payload);
  const { breakdowns } = normalized;
  assert.notEqual(breakdowns, null, "one unknown model must not null every breakdown");
  assert.equal(breakdowns.modelMetadata, "applied");
  assert.equal(breakdowns.unrecognizedModelTuples, 5);
  assert.equal(breakdowns.unrecognizedModelCount, 1);
  assert.deepEqual(breakdowns.days, series(v13()).breakdowns.days, "every known value is untouched");
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(CANARY, "u"), "the name is never retained");
  assert.deepEqual(modelsChart(payload).legendSeries.map(item => item.key), modelsChart(v13()).legendSeries.map(item => item.key));
  for (const view of ["aggregate", "plans", "models"]) {
    const shown = render(payload, view);
    assert.equal(shown.state, "published", view);
    assert.doesNotMatch(shown.text, new RegExp(CANARY, "u"), view);
    assert.ok(everyAttribute(shown.container).every(value => !value.includes(CANARY)), view);
  }
  const models = render(payload, "models");
  assert.ok(models.text.includes(NOTICE), "the gap is stated, not silent");
  assert.ok(models.text.includes("GPT-6 Astra"), "named models still draw");
  assert.ok(!render(payload, "plans").text.includes(NOTICE));
  // The stored copy drops the tuple, keeps a content-free count, and says the same.
  const stored = projectCommunityDailyPayloadForCache(payload, { nowMs: NOW });
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(CANARY, "u"));
  assert.deepEqual(stored.allowanceBreakdowns.retainedUnrecognizedModels, { tuples: 5, models: 1 });
  assert.ok(render(stored, "models", RETAINED).text.includes(NOTICE));
  assert.doesNotMatch(render(stored, "models", RETAINED).text, new RegExp(CANARY, "u"));
});

test("a model is drawn only once the published block adds it, under its published label", () => {
  const added = { id: CANARY, label: "GPT-7 Nova", family: "nova", order: 6 };
  const payload = withTuples(v13([...SIX_MODELS.map(model => ({ ...model })), added]), [[CANARY, 4321, 2]]);
  const { breakdowns } = series(payload);
  assert.equal(breakdowns.unrecognizedModelTuples, 0);
  const chart = modelsChart(payload);
  const nova = chart.legendSeries.find(item => item.key === CANARY);
  assert.equal(nova.label, "GPT-7 Nova", "the printed name is the validated label, never the id");
  assert.ok(render(payload, "models").text.includes("GPT-7 Nova"));
  assert.ok(!render(payload, "models").text.includes(CANARY));
});

test("a malformed v1.3 block is ignored whole and reported, and the rest of the breakdowns still draw", () => {
  const bad = [
    ["extra entry key", [{ ...SIX_MODELS[0], tone: "warm" }]],
    ["a catalog manifest version beside the entries", [{ ...SIX_MODELS[0], catalogManifestVersion: 1 }]],
    ["negative order", [{ ...SIX_MODELS[0], order: -1 }]],
    ["not an array", "gpt-6-astra"],
  ];
  for (const [name, block] of bad) {
    const normalized = series(v13(block));
    assert.notEqual(normalized.breakdowns, null, name);
    assert.equal(normalized.breakdowns.modelMetadata, "rejected", name);
    assert.equal(normalized.breakdowns.hasCombined, true, name);
    assert.deepEqual(normalized.breakdowns.days, series(v13()).breakdowns.days, name);
  }
});

test("a newer breakdown version is refused whole, v1.4 included, and activity is never hidden", () => {
  // v1.4 is the post-cutover release (a new normalization plus metadata). It
  // needs a reader change first, so this reader must not guess at it, whichever
  // basis it claims.
  const current = () => {
    const payload = publicAllowanceFixture(NOW);
    payload.allowanceBreakdowns.modelConfig = SIX_MODELS.map(model => ({ ...model }));
    return payload;
  };
  const refused = [
    ["v1.4 on the v1.3 legacy basis", () => legacyFixture("community-allowance-breakdowns-v1.4")],
    ["v1.4 on the current basis", () => { const p = current(); p.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.4"; return p; }],
    ["v1.5", () => legacyFixture("community-allowance-breakdowns-v1.5")],
    // These carry the v1.0 row shape, so the row check would accept them. Only
    // the accepted-version list refuses them, which is what they pin.
    ["v1.4 in the v1.0 row shape, without combined", () => withoutCombined(legacyFixture("community-allowance-breakdowns-v1.4"))],
    ["v1.4 in the v1.0 row shape, without combined or block", () => withoutCombined(legacyFixture("community-allowance-breakdowns-v1.4", null))],
    ["v1.5 in the v1.0 row shape, without combined", () => withoutCombined(legacyFixture("community-allowance-breakdowns-v1.5"))],
    ["v1.13, which is not v1.1 or v1.3", () => legacyFixture("community-allowance-breakdowns-v1.13")],
    ["v2.0", () => legacyFixture("community-allowance-breakdowns-v2.0")],
    ["v1.3.1", () => legacyFixture(`${V13}.1`)],
    ["trailing space", () => legacyFixture(`${V13} `)],
    ["wrong case", () => legacyFixture(V13.replace("community", "Community"))],
    ["an empty version", () => legacyFixture("")],
    ["a non-string version", () => legacyFixture(13)],
  ];
  for (const [name, build] of refused) {
    const normalized = series(build());
    assert.equal(normalized.breakdowns, null, name);
    assert.equal(normalized.state, "published", `${name}: activity is never hidden by an unreadable breakdown`);
    assert.ok(normalized.days.length > 0, name);
    assert.equal(render(build(), "models").state, "breakdowns_unavailable", name);
    assert.ok(render(build(), "models").text.includes(UNAVAILABLE), name);
  }
});

test("the accepted-version list is exactly v1.0 to v1.3, and the v1.0 row shape is accepted only as v1.0", () => {
  // Pinned at the list itself, so adding a version without reading it cannot
  // pass on the side effect of a row shape.
  assert.deepEqual([...COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS], [
    "community-allowance-breakdowns-v1.0",
    "community-allowance-breakdowns-v1.1",
    "community-allowance-breakdowns-v1.2",
    "community-allowance-breakdowns-v1.3",
  ]);
  assert.ok(Object.isFrozen(COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS));
  // Control: the shape the refused cases use is a readable v1.0 payload, so those
  // cases are refused for their version and for nothing else.
  const v10 = series(withoutCombined(legacyFixture("community-allowance-breakdowns-v1.0", null)));
  assert.notEqual(v10.breakdowns, null);
  assert.equal(v10.breakdowns.hasCombined, false);
  assert.equal(v10.breakdowns.modelMetadata, "absent");
});

test("v1.3 is still checked on v1.1's basis, so a v1.3 that claims the current basis or plans is refused", () => {
  const refused = [
    ["the current Pro 10x basis", payload => {
      Object.assign(payload.allowanceBreakdowns, {
        basis: "seven_day_codex_pro10x_equivalent_personal_plans_trailing_30d_promax25",
        normalization: "pro_x1_prolite_x2_promax_x0_4_plus_x10",
        modelBasis: "seven_day_codex_pro10x_equivalent_per_model_composition",
      });
    }],
    ["the current model basis alone", payload => {
      payload.allowanceBreakdowns.modelBasis = "seven_day_codex_pro10x_equivalent_per_model_composition";
    }],
    ["a promax plan the legacy basis has none of", payload => {
      for (const day of payload.allowanceBreakdowns.days) day.byPlanType.promax = day.byPlanType.pro;
    }],
    ["a day without combined", payload => { delete payload.allowanceBreakdowns.days[0].combined; }],
    ["an unknown envelope key", payload => { payload.allowanceBreakdowns.participant_id = "PRIVATE_CANARY"; }],
    ["a different reference plan", payload => { payload.allowanceBreakdowns.referencePlanType = "plus"; }],
  ];
  for (const [name, mutate] of refused) {
    const payload = v13();
    mutate(payload);
    const normalized = series(payload);
    assert.equal(normalized.breakdowns, null, name);
    assert.equal(normalized.state, "published", name);
    assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_CANARY/u, name);
  }
});

test("a retained v1.3 payload re-reads as the same series, and the cache identity names v1.3", () => {
  const payload = withTuples(v13(), [[CANARY, 4321, 2]]);
  const live = series(payload);
  const stored = projectCommunityDailyPayloadForCache(payload, { nowMs: NOW });
  assert.deepEqual(stored.allowanceBreakdowns.modelConfig, SIX_MODELS.map(model => ({ ...model })));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(CANARY, "u"));
  const reread = normalizeCommunityDailySeries(stored, { nowMs: NOW, retained: true });
  assert.deepEqual(reread, live, "omission counts included");
  assert.deepEqual(buildCommunityAllowanceChartModel(reread, { view: "models" }),
    buildCommunityAllowanceChartModel(live, { view: "models" }));
  // Widening the accepted versions changes the identity, so a payload retained
  // by the previous deploy is refused instead of being read under new meanings.
  assert.ok(COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY.includes(V13));
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); } };
  const open = schemaVersion => createLastKnownGoodStore({
    key: "community-daily", schemaVersion, storage, now: () => NOW,
    project: value => projectCommunityDailyPayloadForCache(value, { nowMs: NOW }),
  });
  const before = COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY.replace(`|${V13}`, "");
  assert.notEqual(before, COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY);
  assert.equal(open(before).resolve({ payload: v11(), failure: null }).state, "live");
  const failure = Object.assign(new Error("down"), { status: 503 });
  assert.equal(open(before).resolve({ payload: null, failure }).state, "cached", "the same deploy still serves its copy");
  assert.equal(open(COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY).resolve({ payload: null, failure }).state, "unavailable",
    "the previous deploy's copy is not served under this deploy's meanings");
});

// GPT-6.1 Sol (owner round 11) is the seventh roster model. It is on the OpenAI
// release-line catalog only, so until a served publication carries an estimate
// for it the page shows exactly the six-model comparison and never names it.
const SOL_61 = "gpt-6.1-sol";
const SIX_LABELS = Object.freeze(["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Terra", "GPT-5.6 Sol", "GPT-5.6 Luna"]);
const SEVEN_MODELS = Object.freeze([
  { id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 },
  { id: SOL_61, label: "GPT-6.1 Sol", family: "sol", order: 1 },
  ...SIX_MODELS.slice(1).map(model => ({ ...model, order: model.order + 1 })),
]);
const cardTitles = container => container.descendants().filter(element => element.tag === "article")
  .map(card => card.descendants().find(element => element.tag === "h3")?.text);

test("with no GPT-6.1 Sol estimate, the six-model block renders exactly six cards and never names it", () => {
  for (const [name, payload] of [["v1.3 six-entry block", v13], ["v1.1 without a block", v11]]) {
    const normalized = series(payload());
    assert.ok(normalized.breakdowns.days.every(day => day.models.every(([id]) => id !== SOL_61)), name);
    const chart = modelsChart(payload());
    assert.ok(!chart.cardSeries.some(card => card.key === SOL_61), name);
    assert.ok(!chart.legendSeries.some(item => item.key === SOL_61), name);
    const models = render(payload(), "models");
    assert.equal(models.state, "published", name);
    assert.deepEqual(cardTitles(models.container), SIX_LABELS, name);
    assert.doesNotMatch(models.text, /GPT-6\.1 Sol/u, name);
    assert.ok(everyAttribute(models.container).every(value => !value.includes(SOL_61)), name);
  }
});

test("a block that names GPT-6.1 Sol but carries no estimate for it still shows no card for it", () => {
  const models = render(v13(SEVEN_MODELS.map(model => ({ ...model }))), "models");
  assert.equal(models.state, "published");
  assert.deepEqual(cardTitles(models.container), SIX_LABELS);
  assert.doesNotMatch(models.text, /GPT-6\.1 Sol/u);
});

test("a seven-entry block with a GPT-6.1 Sol estimate draws it second, and the six are unchanged", () => {
  const without = modelsChart(v13());
  const payload = withTuples(v13(SEVEN_MODELS.map(model => ({ ...model }))), [[SOL_61, 4321, 2]]);
  const normalized = series(payload);
  assert.equal(normalized.breakdowns.modelMetadata, "applied");
  assert.equal(normalized.breakdowns.unrecognizedModelTuples, 0, "a roster model is never unrecognized");
  const chart = modelsChart(payload);
  assert.deepEqual(chart.legendSeries.map(item => item.key),
    ["gpt-6-astra", SOL_61, "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]);
  const sol61 = chart.legendSeries.find(item => item.key === SOL_61);
  assert.equal(sol61.label, "GPT-6.1 Sol");
  for (const item of without.legendSeries) {
    const same = chart.legendSeries.find(entry => entry.key === item.key);
    assert.equal(same.label, item.label, item.key);
    assert.ok(item.dots.length > 0, item.key);
    assert.deepEqual(same.dots.map(dot => [dot.day, dot.centralUsd]),
      item.dots.map(dot => [dot.day, dot.centralUsd]), `${item.key} values unchanged`);
  }
  const models = render(payload, "models");
  assert.deepEqual(cardTitles(models.container), [SIX_LABELS[0], "GPT-6.1 Sol", ...SIX_LABELS.slice(1)]);
  assert.ok(!models.text.includes(NOTICE));
});

test("without a block, a GPT-6.1 Sol estimate draws at its roster slot, second", () => {
  const payload = withTuples(v11(), [[SOL_61, 4321, 2]]);
  assert.equal(series(payload).breakdowns.unrecognizedModelTuples, 0);
  const models = render(payload, "models");
  assert.deepEqual(cardTitles(models.container), [SIX_LABELS[0], "GPT-6.1 Sol", ...SIX_LABELS.slice(1)]);
});
