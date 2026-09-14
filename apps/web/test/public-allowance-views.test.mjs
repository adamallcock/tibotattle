import assert from "node:assert/strict";
import test from "node:test";
import { buildCommunityAllowanceChartModel, renderCommunityAllowanceSection } from "../public/community-view.js";
import { normalizeCommunityDailySeries, normalizePublicAllowanceBreakdowns, planWeeklyApiEquivalentUsd } from "../public/community-data.js";
import { translate, translatePlural } from "../public/localization.js";
import { publicAllowanceFixture } from "./fixtures/public-allowance.js";

// Synthetic presentation data only; never served by a production client.
const summary = (centralUsd, participants = 2) => ({
  centralUsd, participantCount: centralUsd === null ? 0 : participants,
  fitCount: centralUsd === null ? 0 : 4,
  band80Usd: centralUsd === null ? null : { lowerUsd: centralUsd * .8, upperUsd: centralUsd * 1.2 },
});
function series() {
  return {
    state: "published", allowanceState: "ready",
    days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map(day => ({
      day, allowance: summary(1500),
    })),
    breakdowns: {
      modelConfig: [
        { modelId: "gpt-5.5", label: "GPT-5.5" },
        { modelId: "gpt-6-astra", label: "GPT-6 Astra" },
      ],
      days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map((day, index) => ({
        day,
        byPlanType: { pro: summary(2000), prolite: summary(index === 2 ? null : 1000), plus: summary(3000) },
        models: index === 3 ? [["gpt-5.5", 4500, 2], ["gpt-6-astra", 6000, 3]]
          : index === 4 ? [["gpt-6-astra", 6500, 3]] : [],
      })),
    },
  };
}

test("30-day comparisons use identical date and dollar axes", () => {
  const models = ["aggregate", "plans", "models"].map(view => buildCommunityAllowanceChartModel(series(), { view, rangeDays: 30 }));
  for (const model of models) {
    assert.ok(model);
    assert.deepEqual(model.dayTicks, models[0].dayTicks);
    assert.deepEqual(model.dollarTicks, models[0].dollarTicks);
    assert.deepEqual(model.plot, models[0].plot);
    assert.ok(model.dollarTicks.at(-1).value >= 6500);
  }
  assert.equal(models[1].legendSeries.length, 3);
  assert.deepEqual(models[2].legendSeries.map(item => item.label), ["GPT-6 Astra", "GPT-5.5"]);
});

test("All fits the selected view's evidence dates without changing dollar scales", () => {
  const data = series();
  const aggregate = buildCommunityAllowanceChartModel(data);
  const model = buildCommunityAllowanceChartModel(data, { view: "models" });
  assert.deepEqual(model.dayTicks.map(tick => tick.day), ["2026-09-04", "2026-09-05"]);
  assert.equal(model.dots[0].x, model.plot.left);
  assert.equal(model.dots.at(-1).x, model.plot.right);
  assert.equal(aggregate.dayTicks[0].day, "2026-09-01");
  assert.deepEqual(model.dollarTicks, aggregate.dollarTicks);
});

test("preferred model order is stable for cards, legend and same-day inspection without hiding other models", () => {
  const data = series();
  const preferred = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
  const ids = ["gpt-5.4", ...preferred.toReversed()];
  data.breakdowns.modelConfig = ids.map(modelId => ({ modelId, label: modelId }));
  data.breakdowns.days.at(-1).models = ids.map(id => [id, 1500, 1]);
  const model = buildCommunityAllowanceChartModel(data, { view: "models" });
  const expected = [...preferred, "gpt-5.4"];
  assert.deepEqual(model.legendSeries.map(item => item.key), expected);
  assert.deepEqual(model.latestSummaries.map(item => item.seriesKey), expected);
  assert.deepEqual(model.dots.filter(dot => dot.day === "2026-09-05").map(dot => dot.seriesKey), expected);
  assert.deepEqual(model.legendSeries.slice(0, 5).map(item => item.theme), ["astra", "sol", "terra", "luna", "classic"]);
  assert.deepEqual(data.breakdowns.modelConfig.map(item => item.modelId), ids, "catalog is never reordered in place");
});

test("dense history thins permanent markers but retains all observations and gap endpoints", () => {
  const data = series();
  data.days = Array.from({ length: 120 }, (_, index) => ({
    day: new Date(Date.parse("2026-05-01") + index * 86400000).toISOString().slice(0, 10), allowance: summary(1500),
  }));
  data.breakdowns.days = data.days.map(({ day }, index) => ({ day,
    byPlanType: { pro: summary(index === 60 ? null : 2000), prolite: summary(null), plus: summary(null) }, models: [],
  }));
  const model = buildCommunityAllowanceChartModel(data, { view: "plans" });
  assert.equal(model.dots.length, 119);
  assert.deepEqual(model.centralSegments.map(segment => segment.length), [60, 59]);
  assert.deepEqual(model.markerDots.map(dot => dot.day), [0, 59, 61, 119].map(index => data.days[index].day));
  const daySpacing = (model.plot.right - model.plot.left) / 119;
  assert.ok(model.dots.every(dot => 2 * dot.radius < daySpacing), "adjacent markers cannot overlap");
  assert.ok(model.dots[60].x - model.dots[59].x > model.dots[1].x - model.dots[0].x, "the missing date keeps its elapsed space");
});

test("model points start with observed evidence and never acquire a fabricated band or reset-fit count", () => {
  const model = buildCommunityAllowanceChartModel(series(), { view: "models" });
  const astra = model.legendSeries.find(item => item.key === "gpt-6-astra");
  assert.deepEqual(astra.dots.map(dot => dot.day), ["2026-09-04", "2026-09-05"]);
  assert.ok(astra.dots.every(dot => dot.fitCount === null && dot.participantCount === 3));
  assert.deepEqual(model.bandSegments, []);
  assert.equal(model.sparse, true);
  assert.equal(model.latestSummaries.length, 2);
});

test("plan lines and uncertainty bands break at missing evidence", () => {
  const model = buildCommunityAllowanceChartModel(series(), { view: "plans" });
  const plan = model.legendSeries.find(item => item.key === "prolite");
  assert.deepEqual(plan.centralSegments.map(points => points.map(point => point.day)), [
    ["2026-09-01", "2026-09-02"], ["2026-09-04", "2026-09-05"],
  ]);
  assert.deepEqual(plan.bandSegments.map(points => points.map(point => point.day)), [
    ["2026-09-01", "2026-09-02"], ["2026-09-04", "2026-09-05"],
  ]);
  assert.equal(plan.dots.some(dot => dot.centralUsd === 0), false);
});

test("date range and absent public breakdowns fail honestly without affecting aggregate", () => {
  const data = series();
  const ranged = buildCommunityAllowanceChartModel(data, { view: "models", rangeDays: 1 });
  assert.deepEqual(ranged.dots.map(dot => dot.day), ["2026-09-05"]);
  assert.ok(ranged.dots.every(dot => Number.isFinite(dot.x) && Number.isFinite(dot.y)));
  const absent = { ...data, breakdowns: null };
  assert.ok(buildCommunityAllowanceChartModel(absent));
  assert.equal(buildCommunityAllowanceChartModel(absent, { view: "models" }), null);
  assert.equal(buildCommunityAllowanceChartModel(data, { view: "unknown" }), null);
  data.breakdowns.days.forEach(day => { day.models = []; });
  assert.equal(buildCommunityAllowanceChartModel(data, { view: "models" }), null);
});

test("public view controls and method caveats are translated in every shipped language", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    for (const suffix of ["viewLabel", "viewAggregate", "viewPlans", "viewModels", "smallSampleDisclosure", "breakdownsUnavailable", "modelsAccumulating", "planMethod", "modelMethod", "planChartLabel", "modelChartLabel", "planChartDescription", "modelChartDescription", "cardsCaption", "legendFocus"]) {
      const key = `community.allowance.${suffix}`;
      const value = translate(key, {}, locale);
      assert.notEqual(value, key);
      if (locale !== "en-US") assert.notEqual(value, translate(key, {}, "en-US"));
    }
    for (const count of [1, 3]) assert.match(translatePlural("community.allowance.shortAccountCount", count, {}, locale), new RegExp(String(count)));
  }
});

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
test("actual plan values invert only the supported reference scaling without rounding or inventing missing values", () => {
  assert.equal(planWeeklyApiEquivalentUsd(2011, "pro"), 2011);
  assert.equal(planWeeklyApiEquivalentUsd(1916, "prolite"), 479);
  assert.equal(planWeeklyApiEquivalentUsd(2257, "plus"), 112.85);
  assert.equal(planWeeklyApiEquivalentUsd(0, "plus"), 0);
  for (const value of [null, undefined, NaN, Infinity, -1, "2257"]) {
    assert.equal(planWeeklyApiEquivalentUsd(value, "plus"), null);
  }
  for (const plan of ["free", "team", "constructor", "toString", "__proto__", null, undefined, ["plus"], {}]) {
    assert.equal(planWeeklyApiEquivalentUsd(2257, plan), null);
  }
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    const copy = translate("community.allowance.actualPlanValue", { value: "$479" }, locale);
    assert.ok(copy.includes("$479"));
    assert.ok(!copy.includes("{value}"));
  }
});
test("the closed public wire survives normalization into all three chart views", () => {
  const payload = publicAllowanceFixture(NOW);
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.state, "published");
  assert.equal(normalized.breakdowns.days.length, 35);
  assert.ok(normalized.breakdowns.modelConfig.some(model => model.modelId === "gpt-6-astra"));
  assert.ok(normalized.breakdowns.modelConfig.every(model => model.modelId !== "gpt-5.3-codex-spark"));
  for (const view of ["aggregate", "plans", "models"]) {
    assert.ok(buildCommunityAllowanceChartModel(normalized, { view }).dots.length > 0);
  }
  payload.allowanceBreakdowns.days[0].byPlanType.pro.centralUsd = 9999;
  assert.equal(normalized.breakdowns.days[0].byPlanType.pro.centralUsd, 2000, "fresh copied allowlist");
});

test("v1.1 keeps all graph views on one publication while daily revisions update independently", () => {
  const payload = publicAllowanceFixture(NOW);
  payload.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.1";
  for (const [index, day] of payload.allowanceBreakdowns.days.entries()) {
    const { centralUsd, participantCount, fitCount, band80Usd } = payload.days[index].payload.allowance;
    day.combined = { centralUsd, participantCount, fitCount, band80Usd };
    delete payload.days[index].payload.allowance;
  }
  const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
  assert.equal(normalized.breakdowns.hasCombined, true);
  const oldChart = buildCommunityAllowanceChartModel(normalized, { view: "aggregate" });
  assert.equal(oldChart.latest.centralUsd, 1908);
  payload.days.at(-1).payload.allowance = { ...publicAllowanceFixture(NOW).days.at(-1).payload.allowance, centralUsd: 9999 };
  const later = normalizeCommunityDailySeries(payload, { nowMs: NOW + 3 * 86400000 });
  assert.deepEqual(buildCommunityAllowanceChartModel(later, { view: "aggregate" }), oldChart);
  for (const view of ["plans", "models"]) assert.ok(buildCommunityAllowanceChartModel(later, { view }));
  delete payload.allowanceBreakdowns.days[0].combined;
  assert.equal(normalizeCommunityDailySeries(payload, { nowMs: NOW }).breakdowns, null);
});

test("optional public breakdown rejects private extras and invalid evidence without hiding activity", () => {
  const invalid = [
    value => { value.participant_id = "PRIVATE_CANARY"; },
    value => { value.days[0].coverage = { raw: "PRIVATE_CANARY" }; },
    value => { value.days[0].byPlanType.pro.identity = "PRIVATE_CANARY"; },
    value => { value.days[0].byPlanType.pro.band80Usd.raw = "PRIVATE_CANARY"; },
    value => { value.days[0].byPlanType.team = value.days[0].byPlanType.pro; },
    value => { value.days[0].models = [["private-model-canary", 1234, 1]]; },
    value => { value.days[0].models = [["gpt-5.3-codex-spark", 1234, 1]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 1, "PRIVATE_CANARY"]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 1], ["gpt-6-astra", 1234, 1]]; },
    value => { value.days[0].models = [["gpt-6-astra", 1234, 0]]; },
    value => { value.days[0].models = [["gpt-6-astra", "1234", 1]]; },
    value => { value.days[0].byPlanType.pro.participantCount = 5; },
    value => { value.days[0].byPlanType.pro.centralUsd = Infinity; },
    value => { value.days[0].byPlanType.pro.fitCount = 2; },
    value => { value.days[0].byPlanType.pro.band80Usd.lowerUsd = 9000; },
    value => { value.days.reverse(); },
    value => { value.days.push(value.days.at(-1)); },
    value => { value.schemaVersion = "private-admin-preview"; },
    value => { value.modelGate = "unchecked"; },
  ];
  for (const mutate of invalid) {
    const payload = publicAllowanceFixture(NOW);
    mutate(payload.allowanceBreakdowns);
    const normalized = normalizeCommunityDailySeries(payload, { nowMs: NOW });
    assert.equal(normalized.breakdowns, null, mutate.toString());
    assert.equal(normalized.state, "published");
    assert.equal(normalized.days.length, 35);
    assert.equal(buildCommunityAllowanceChartModel(normalized).latest.centralUsd, 1908);
    assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_CANARY|private-model-canary/u);
  }
});

test("public breakdown dates persist while publication and clock boundaries fail closed", () => {
  const payload = publicAllowanceFixture(NOW);
  const decode = (value, days = payload.days.map(day => day.day), nowMs = NOW) =>
    normalizePublicAllowanceBreakdowns(value, days, nowMs);
  assert.ok(decode(payload.allowanceBreakdowns));
  assert.equal(decode(payload.allowanceBreakdowns, []), null);
  assert.deepEqual(decode(payload.allowanceBreakdowns, undefined, NOW + 3 * 86400000), decode(payload.allowanceBreakdowns));
  assert.ok(decode(payload.allowanceBreakdowns, undefined, NOW + 125 * 60000));
  assert.equal(decode(payload.allowanceBreakdowns, undefined, NOW - 5 * 60000 - 1), null);
  assert.equal(decode(payload.allowanceBreakdowns, undefined, NaN), null);
  for (const day of ["2026-09-07", "2026-09-08", "2026-06-01", "2026-02-30"]) {
    const value = structuredClone(payload.allowanceBreakdowns);
    value.days = [{ ...value.days[0], day }];
    assert.equal(decode(value, [day]), null, day);
  }
  const midnight = Date.parse("2026-09-08T00:01:00.000Z");
  const previousSnapshot = publicAllowanceFixture(midnight - 120000).allowanceBreakdowns;
  previousSnapshot.days = [{ ...previousSnapshot.days[0], day: "2026-09-07" }];
  assert.equal(decode(previousSnapshot, ["2026-09-07"], midnight), null, "snapshot's open day stays withheld after midnight");
  payload.allowanceState = "updating";
  assert.equal(normalizeCommunityDailySeries(payload, { nowMs: NOW }).breakdowns, null);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = new Map(); this.textContent = ""; this.className = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].join(" "); }
}

function interactiveDocument() {
  const documentRef = { documentElement: { lang: "en-US" }, activeElement: null };
  class InteractiveElement extends Element {
    constructor(tag) { super(tag); this.listeners = new Map(); this.style = { setProperty() {} }; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 260 }; }
    fire(type, fields = {}) { this.listeners.get(type)?.({ preventDefault() {}, ...fields }); }
    contains(element) { return element === this || this.descendants().includes(element); }
    replaceChildren() {
      if (this.descendants().includes(documentRef.activeElement)) documentRef.activeElement = null;
      super.replaceChildren();
    }
    focus(options) {
      documentRef.activeElement?.fire("blur");
      documentRef.activeElement = this;
      this.focusOptions = options;
      this.fire("focus");
    }
  }
  documentRef.createElement = tag => new InteractiveElement(tag);
  documentRef.createElementNS = (_, tag) => new InteractiveElement(tag);
  return documentRef;
}

function chartParts(container) {
  const all = container.descendants();
  return { buttons: all.filter(element => element.tag === "button"),
    astra: all.find(element => element.tag === "button" && element.text.includes("Astra")),
    svg: all.find(element => element.tag === "svg" && element.attributes.has("aria-label")),
    tooltip: all.find(element => element.className === "allowance-tooltip") };
}
test("real public render shows model sample semantics, per-view labels and disclosure", () => {
  const documentRef = { documentElement: { lang: "en-US" }, createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag) };
  for (const view of ["aggregate", "plans", "models"]) {
    const container = new Element("div");
    assert.equal(renderCommunityAllowanceSection({ documentRef, container,
      payload: publicAllowanceFixture(), view }), "published");
    assert.match(container.text, /single source.*estimated capacity/u);
    assert.match(container.text, view === "aggregate" ? /per 7 days, API-price equivalent/u : /API-equivalent USD \/ Pro 20× week/u);
    const svg = container.descendants().find(element => element.tag === "svg" && element.attributes.has("aria-label"));
    assert.ok(svg);
    if (view === "models") {
      assert.doesNotMatch(container.text, /This plan:/u);
      assert.match(container.text, /GPT-6 Astra/u);
      assert.match(container.text, /1 source/u);
      const cards = container.descendants().filter(element => element.tag === "article");
      assert.match(cards[0].text.trim(), /^GPT-6 Astra/u);
      assert.match(cards[0].className, /allowance-model-astra/u);
      assert.ok(cards.every(card => !card.text.includes("per 7 days")), "one shared unit caption replaces repeated card prose");
      assert.ok(cards.every(card => card.descendants().some(element => element.attributes.get("aria-hidden") === "true")));
      assert.equal(svg.attributes.get("aria-label"), "Community allowance by model");
      assert.match(svg.attributes.get("aria-description"), /contribution sources, not reset fits/u);
      assert.equal(svg.descendants().filter(element => element.attributes.get("class")?.includes("allowance-band-area")).length, 0);
    } else if (view === "plans") {
      assert.match(container.text, /Pro 5× ×4, Plus ×20/u);
      assert.equal(svg.attributes.get("aria-label"), "Community allowance by plan");
      const normalized = normalizeCommunityDailySeries(publicAllowanceFixture());
      const summaries = buildCommunityAllowanceChartModel(normalized, { view: "plans" }).latestSummaries;
      const cards = container.descendants().filter(element => element.tag === "article");
      assert.equal(cards.length, 3);
      cards.forEach((card, index) => {
        const planValue = planWeeklyApiEquivalentUsd(summaries[index].centralUsd, summaries[index].seriesKey);
        const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(planValue);
        assert.ok(card.text.includes(`This plan: ${formatted}/week at API prices`));
      });
    } else {
      assert.doesNotMatch(container.text, /This plan:/u);
    }
  }
  const emptyModels = publicAllowanceFixture();
  emptyModels.allowanceBreakdowns.days.forEach(day => { day.models = []; });
  const container = new Element("div");
  assert.equal(renderCommunityAllowanceSection({ documentRef, container, payload: emptyModels, view: "models" }), "estimates_accumulating");
  assert.match(container.text, /No identified model estimates/u);
  assert.doesNotMatch(container.text, /no reset fit has qualified/u);
});

test("legend focus dims other series without discarding data and limits keyboard inspection to that series", () => {
  const documentRef = interactiveDocument();
  const container = documentRef.createElement("div");
  renderCommunityAllowanceSection({ documentRef, container, payload: publicAllowanceFixture(), view: "models" });
  const all = container.descendants();
  const buttons = all.filter(element => element.tag === "button");
  const astra = buttons.find(button => button.text.includes("Astra"));
  const svg = all.find(element => element.attributes.get("aria-label") === "Community allowance by model");
  const tooltip = all.find(element => element.className === "allowance-tooltip");
  const before = svg.descendants().length;
  astra.fire("click");
  assert.equal(astra.attributes.get("aria-pressed"), "true");
  assert.ok(svg.descendants().some(element => element.attributes.get("data-muted") === "true"));
  assert.equal(svg.descendants().length, before, "all chart evidence is retained");
  for (const key of ["Home", "ArrowRight", "End", "ArrowLeft"]) {
    svg.fire("keydown", { key });
    assert.match(tooltip.text, /GPT-6 Astra/u);
    assert.doesNotMatch(tooltip.text, /GPT-5/u);
  }
  astra.fire("click");
  assert.equal(astra.attributes.get("aria-pressed"), "false");
  assert.ok(svg.descendants().every(element => element.attributes.get("data-muted") !== "true"));
  svg.fire("keydown", { key: "End" });
  assert.match(tooltip.text, /GPT-5.5/u);
});

test("a changed publication preserves selected legend, inspected date and chart focus using only new point values", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  before.svg.fire("keydown", { key: "ArrowRight" });
  const date = before.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text;
  const points = buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload), { view: "models" })
    .dots.filter(dot => dot.seriesKey === "gpt-6-astra");
  for (const day of payload.allowanceBreakdowns.days) for (const row of day.models) {
    if (row[0] === "gpt-6-astra") row[1] += 1000;
  }
  render(); const after = chartParts(container);
  assert.notEqual(after.svg, before.svg);
  assert.equal(documentRef.activeElement, after.svg);
  assert.deepEqual(after.svg.focusOptions, { preventScroll: true });
  assert.equal(after.astra.attributes.get("aria-pressed"), "true");
  assert.ok(after.svg.descendants().some(element => element.attributes.get("data-muted") === "true"));
  assert.equal(after.tooltip.attributes.get("data-visible"), "true");
  assert.equal(after.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text, date);
  const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  assert.ok(after.tooltip.text.includes(dollars.format(points[1].centralUsd + 1000)));
  assert.ok(!after.tooltip.text.includes(dollars.format(points[1].centralUsd)));
  after.svg.fire("keydown", { key: "ArrowRight" });
  assert.ok(after.tooltip.text.includes(dollars.format(points[2].centralUsd + 1000)));
});

test("refresh restores a focused legend but never steals focus from another control or another chart", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); let chart = chartParts(container);
  chart.astra.focus(); chart.astra.fire("click"); render(); chart = chartParts(container);
  assert.equal(documentRef.activeElement, chart.astra);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "true");
  const outside = documentRef.createElement("button"); outside.focus();
  render(); chart = chartParts(container);
  assert.equal(documentRef.activeElement, outside);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "true");
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  const other = documentRef.createElement("div");
  renderCommunityAllowanceSection({ documentRef, container: other, payload, view: "models" });
  assert.equal(chartParts(other).astra.attributes.get("aria-pressed"), "false");
  assert.equal(documentRef.activeElement, outside);
});

test("refresh retains keyboard position and an Escape-dismissed tooltip without reopening it", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  before.svg.fire("keydown", { key: "Escape" }); render(); const after = chartParts(container);
  assert.equal(documentRef.activeElement, after.svg);
  assert.equal(after.tooltip.attributes.get("data-visible"), "false");
  after.svg.fire("keydown", { key: "ArrowRight" });
  assert.match(after.tooltip.text, /GPT-6 Astra/u);
  const points = buildCommunityAllowanceChartModel(normalizeCommunityDailySeries(payload), { view: "models" })
    .dots.filter(dot => dot.seriesKey === "gpt-6-astra");
  assert.ok(after.tooltip.text.includes(new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(points[1].centralUsd)));
});

test("removed series or invalidated graph state cannot carry old inspection evidence into a replacement", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = data => renderCommunityAllowanceSection({ documentRef, container, payload: data, view: "models" });
  render(payload); let chart = chartParts(container);
  chart.astra.fire("click"); chart.svg.focus(); chart.svg.fire("keydown", { key: "Home" });
  chart.astra.focus();
  const withoutAstra = structuredClone(payload);
  withoutAstra.allowanceBreakdowns.days.forEach(day => { day.models = day.models.filter(row => row[0] !== "gpt-6-astra"); });
  render(withoutAstra); chart = chartParts(container);
  assert.equal(chart.astra, undefined);
  assert.ok(chart.buttons.every(button => button.attributes.get("aria-pressed") === "false"));
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  assert.doesNotMatch(chart.tooltip.text, /Astra/u);
  assert.equal(documentRef.activeElement, chart.svg);
  render(payload); chart = chartParts(container);
  chart.astra.fire("click"); chart.svg.focus(); chart.svg.fire("keydown", { key: "Home" });
  assert.equal(render({ ...payload, allowanceState: "updating" }), "allowance_updating");
  assert.equal(chartParts(container).svg, undefined);
  assert.equal(documentRef.activeElement, null);
  render(payload); chart = chartParts(container);
  assert.equal(chart.astra.attributes.get("aria-pressed"), "false");
  assert.equal(chart.tooltip.attributes.get("data-visible"), "false");
  assert.equal(documentRef.activeElement, null);
});

test("a removed inspected day clears its tooltip without dropping a still-supported legend selection", () => {
  const documentRef = interactiveDocument(), container = documentRef.createElement("div");
  const payload = publicAllowanceFixture(NOW);
  const render = () => renderCommunityAllowanceSection({ documentRef, container, payload, view: "models" });
  render(); const before = chartParts(container);
  before.astra.fire("click"); before.svg.focus(); before.svg.fire("keydown", { key: "Home" });
  const removedDay = payload.allowanceBreakdowns.days.find(day => day.models.some(row => row[0] === "gpt-6-astra"));
  removedDay.models = removedDay.models.filter(row => row[0] !== "gpt-6-astra");
  render(); const after = chartParts(container);
  assert.equal(after.astra.attributes.get("aria-pressed"), "true");
  assert.equal(after.tooltip.attributes.get("data-visible"), "false");
  assert.equal(after.tooltip.text.trim(), "");
  assert.equal(documentRef.activeElement, after.svg);
  after.svg.fire("keydown", { key: "Home" });
  assert.match(after.tooltip.text, /GPT-6 Astra/u);
  assert.equal(after.tooltip.attributes.get("data-visible"), "true");
  assert.notEqual(after.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text,
    before.tooltip.descendants().find(element => element.className === "allowance-tooltip-date").text);
});
