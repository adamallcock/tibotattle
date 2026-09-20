import { CATALOGS } from "../public/i18n.generated.js";
import { translate, SUPPORTED_LOCALES } from "../public/localization.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_REUSE_MATRIX_STACK_CAPACITY, cacheReuseMatrixBuckets, cacheReuseMatrixLights,
  chooseCacheReuseMatrixUnit, createCacheReuseMatrix } from "../public/cache-reuse-matrix.js";

const DEFINITIONS = [
  ["under_one_minute", 0, 60], ["one_to_two_minutes", 60, 120],
  ["two_to_five_minutes", 120, 300], ["five_to_ten_minutes", 300, 600],
  ["ten_to_thirty_minutes", 600, 1800], ["thirty_minutes_to_one_hour", 1800, 3600],
  // One bucket covered one to six hours. It is split because that is where the
  // curve bends, and a single bucket averaged the two halves into one rate.
  ["one_to_two_hours", 3600, 7200], ["two_to_six_hours", 7200, 21600],
  // The tail is CLOSED at the hosted lane's seven-day lookback. A longer gap is
  // not measured at all, so the old unbounded end claimed coverage that never
  // existed, and the two day-scale buckets it needed are now one.
  ["six_to_twenty_four_hours", 21600, 86400], ["over_twenty_four_hours", 86400, 604800],
];
function bucket(n = 0, yes = n) {
  const no = n - yes;
  return { comparableReturns: n, reusedMoreThanHalfReturns: yes, reusedHalfOrLessReturns: no,
    matchedOrExceededReturns: yes, reusedBetweenHalfAndPreviousReturns: 0,
    cacheReadDrops: no, lostCacheTokens: no * 100, pricedDrops: no, unpricedDrops: 0,
    coverageStatus: "complete", estimatedPremiumUsd: no / 100,
    coveredSubtotal: { standardApiPremiumUsd: no / 100 } };
}
function impact(values = [], byModel = []) {
  const byOutcomeBucket = Object.fromEntries(DEFINITIONS.map(([id, startSeconds, endSeconds], i) =>
    [id, { ...bucket(...(values[i] ?? [])), startSeconds, endSeconds }]));
  const result = { status: "available", ...bucket(), byOutcomeBucket, byModel };
  for (const field of Object.keys(bucket()).filter((field) => typeof result[field] === "number")) {
    result[field] = Object.values(byOutcomeBucket).reduce((sum, row) => sum + row[field], 0);
  }
  return result;
}

// Tiny DOM boundary: renders and events are exercised, without adding a browser
// dependency to the offline unit lane. Visual layout is separately browser-tested.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.children = []; this.style = {};
    this.attributes = {}; this.listeners = {}; this.hidden = false; this.className = "";
    this.classList = { add: (...names) => { this.className += ` ${names.join(" ")}`; },
      remove: (name) => { this.className = this.className.split(" ").filter((item) => item !== name).join(" "); } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return (this._text ?? "") + this.children.map((child) => child.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === "class") this.className = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  append(...children) { children.forEach((child) => { child.parent = this; this.children.push(child); }); }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  replaceChildren(...children) { this._text = ""; this.children = []; this.append(...children); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  focus() { this.ownerDocument.activeElement = this; this.dispatch("focus"); }
  getBoundingClientRect() { return { width: this.ownerDocument.width }; }
}
const findAll = (root, cls) => [root, ...root.children.flatMap((child) => findAll(child, cls))]
  .filter((item) => item.className.split(" ").includes(cls));
function mount({ width = 850, ...options } = {}) {
  const document = { width, activeElement: null, createElement: (tag) => new Element(tag, document),
    createElementNS: (_, tag) => new Element(tag, document) };
  const container = document.createElement("div");
  const t = (key, values = {}) => `${key.split(".").at(-1)}${Object.values(values).length ? `:${Object.values(values).join("|")}` : ""}`;
  const matrix = createCacheReuseMatrix({ container, t, formatNumber: (n) => String(n),
    formatPercent: (n) => `${n.toFixed(1)}%`, formatModelName: (id) => `Name ${id}`, ...options });
  return { matrix, container, document, find: (cls) => findAll(container, cls)[0], all: (cls) => findAll(container, cls) };
}

test("every bucket is drawn as measured, over a closed tail, without mutating evidence", () => {
  const value = impact([[], [], [], [], [], [], [], [], [13, 7], [27, 3]]);
  const before = structuredClone(value);
  const rows = cacheReuseMatrixBuckets(value);
  // Ten rows, not nine. The two day-scale buckets used to be summed into one
  // synthetic `24h+` row for display; the evidence is now already cut into the
  // bucket the chart draws, so nothing is collapsed and no displayed count is
  // assembled from parts that were measured separately.
  assert.equal(rows.length, 10);
  assert.equal(rows[8].id, "six_to_twenty_four_hours");
  assert.equal(rows[8].comparableReturns, 13);
  assert.equal(rows[8].reusedMoreThanHalfReturns, 7);
  assert.equal(rows[8].reusedHalfOrLessReturns, 6);
  assert.equal(rows[8].estimatedPremiumUsd, .06);
  assert.equal(rows[8].lostCacheTokens, 600);
  assert.equal(rows[9].id, "over_twenty_four_hours");
  assert.equal(rows[9].comparableReturns, 27);
  assert.equal(rows[9].reusedMoreThanHalfReturns, 3);
  assert.equal(rows[9].reusedHalfOrLessReturns, 24);
  assert.equal(rows[9].estimatedPremiumUsd, .24);
  assert.equal(rows[9].lostCacheTokens, 2400);
  assert.equal(rows[9].startSeconds, 86400);
  // Seven days, never null: the hosted lane looks back exactly that far, and an
  // unbounded end would present gaps nothing measured as if they had been.
  assert.equal(rows[9].endSeconds, 604800);
  assert.deepEqual(value, before);
});

test("a partly unpriced tail stays partial while covered subtotals remain visible", () => {
  const value = impact([[], [], [], [], [], [], [], [], [10, 5], [10, 5]]);
  const tail = value.byOutcomeBucket.over_twenty_four_hours;
  tail.coverageStatus = "incomplete";
  tail.estimatedPremiumUsd = null;
  tail.pricedDrops = 3;
  tail.unpricedDrops = 2;
  tail.coveredSubtotal.standardApiPremiumUsd = .03;
  value.pricedDrops -= 2;
  value.unpricedDrops += 2;
  const rows = cacheReuseMatrixBuckets(value);
  assert.equal(rows[9].coverageStatus, "incomplete");
  // Absent, never zero: two of these five drops carry no price at all, and a
  // partial premium must not read as a measured one.
  assert.equal(rows[9].estimatedPremiumUsd, null);
  assert.equal(rows[9].coveredSubtotal.standardApiPremiumUsd, .03);
  // Partial coverage no longer spreads across a merge boundary in either
  // direction: the priced neighbour keeps its own complete figure, and the
  // partial bucket keeps only what was actually covered in it.
  assert.equal(rows[8].coverageStatus, "complete");
  assert.equal(rows[8].estimatedPremiumUsd, .05);
  assert.equal(rows[8].coveredSubtotal.standardApiPremiumUsd, .05);
  tail.coveredSubtotal.standardApiPremiumUsd = null;
  assert.equal(cacheReuseMatrixBuckets(value)[9].coveredSubtotal.standardApiPremiumUsd, null);
});

test("missing or inconsistent bucket evidence fails closed", () => {
  const value = impact([[20, 12]]);
  value.byOutcomeBucket.under_one_minute.reusedMoreThanHalfReturns = 13;
  assert.equal(cacheReuseMatrixBuckets(value), null);
  const missingTail = impact([[20, 12]]);
  delete missingTail.byOutcomeBucket.over_twenty_four_hours;
  assert.equal(cacheReuseMatrixBuckets(missingTail), null);
  // An otherwise consistent snapshot whose tail still declares an unbounded end
  // is a different measurement wearing this shape, and is refused rather than
  // drawn as though gaps past the lookback had been counted.
  const unbounded = impact([[20, 12]]);
  unbounded.byOutcomeBucket.over_twenty_four_hours.endSeconds = null;
  assert.equal(cacheReuseMatrixBuckets(unbounded), null);
});

test("one common bounded unit preserves evidence volume and partial light proportions", () => {
  // The unit is derived from what can physically be drawn -- the stack capacity
  // at the smallest legible cell -- not from fitting the tallest bucket at the
  // base cell size. On a real corpus the old rule left every bucket past ten
  // minutes with a fraction of one light; the tall bucket now draws SMALLER
  // lights instead, so one unit still means the same count everywhere.
  const value = impact([[880_000, 700_000], [1000, 960], [950, 900], [550, 500], [450, 380],
    [160, 120], [120, 30], [40, 2], [4, 0]]);
  assert.equal(chooseCacheReuseMatrixUnit(value), 200);
  assert.equal(chooseCacheReuseMatrixUnit(value, 1000), 1000,
    "the drawable capacity, not the tallest bucket's own height, sets the unit");
  // The busiest bucket is DRAWN, at exactly the capacity the chooser targets.
  // The lights cap and the chooser used to be independent numbers, and a bucket
  // past the cap returned no lights at all -- so the bucket with the most
  // evidence in the corpus rendered exactly like one with none.
  const busiest = cacheReuseMatrixLights(bucket(880_000, 700_000), 200);
  assert.equal(busiest.length, CACHE_REUSE_MATRIX_STACK_CAPACITY);
  const lights = cacheReuseMatrixLights(bucket(27, 16), 10);
  assert.equal(lights.length, 3);
  assert.ok(Math.abs(lights.reduce((n, light) => n + light.more, 0) * 10 - 16) < 1e-9);
  assert.ok(Math.abs(lights.reduce((n, light) => n + light.less, 0) * 10 - 11) < 1e-9);
  const huge = impact([[5_000_000, 4_000_000]]);
  const chosen = cacheReuseMatrixLights(huge, chooseCacheReuseMatrixUnit(huge));
  assert.ok(chosen.length > 0 && chosen.length <= CACHE_REUSE_MATRIX_STACK_CAPACITY);
  assert.deepEqual(cacheReuseMatrixLights(huge, 1), [], "unbounded direct requests cannot allocate millions of nodes");
});

test("all ten time groups are accessible and distinguish zero reuse from no evidence", () => {
  const ui = mount();
  ui.matrix.render({ impact: impact([[20, 0], [0, 0], [], [], [], [], [1000, 380], [1000, 137]]) });
  assert.equal(ui.all("cache-matrix-hit").length, 10);
  const rates = ui.all("cache-matrix-rate").map((node) => node.textContent);
  // Measured at zero reuse, and never confusable with a bucket in which nothing
  // was measured at all. This is the distinction the whole metric turns on.
  assert.equal(rates[0], "0.0%");
  assert.equal(rates[1], "missing");
  // The reason the hour-scale bucket was split: one 1-6h column averaged these
  // two rates into ~26% and hid the bend the chart exists to show.
  assert.equal(rates[6], "38.0%");
  assert.equal(rates[7], "13.7%");
  const gaps = ui.all("cache-matrix-gap").map((node) => node.textContent);
  assert.equal(gaps[6], "oneToTwoHours");
  assert.equal(gaps[7], "twoToSixHours");
  assert.equal(gaps.at(-1), "twentyFourHoursPlus");
  assert.equal(ui.all("cache-matrix-muted")[0].textContent, "n:20");
  // Accessible also means on the canvas. The wide layout laid columns out on a
  // fixed nine-column pitch, which put the tenth bucket -- labels, lights and
  // hit target -- entirely past the right edge of the plot, where a measured
  // bucket cannot be told from one with no evidence.
  const plotWidth = Number(ui.find("cache-matrix-plot").getAttribute("viewBox").split(" ")[2]);
  for (const hit of ui.all("cache-matrix-hit")) {
    assert.ok(parseFloat(hit.style.left) + parseFloat(hit.style.width) <= plotWidth,
      `column at ${hit.style.left} overflows the ${plotWidth} wide plot`);
  }
  assert.ok(Number(ui.all("cache-matrix-gap").at(-1).getAttribute("x")) < plotWidth);
});

test("hover details lead with percentages, retain exact denominator and pricing callback", () => {
  const seen = [];
  const ui = mount({ formatMetric: (summary) => { seen.push(summary); return [`lost:${summary.lostCacheTokens}`]; } });
  ui.matrix.render({ impact: impact([[436, 366], [20, 0]]) });
  assert.equal(seen.at(-1).comparableReturns, 456, "initial detail is the whole period");
  ui.all("cache-matrix-hit")[0].dispatch("pointerenter");
  assert.equal(seen.at(-1).comparableReturns, 436);
  const values = ui.all("cache-matrix-detail-value");
  assert.equal(values[1].children[0].textContent, "16.1%");
  assert.equal(values[1].children[1].textContent, "fraction:70|436");
  assert.match(ui.find("cache-matrix-metrics").textContent, /lost:7000/);
});

test("model selection refreshes data, keeps the global unit, and persists when model disappears", () => {
  const changes = [];
  const ui = mount({ onModelChange: (change) => changes.push(change) });
  const all = impact([[3500, 3000]], [{ ...impact([[100, 80]]), model: "gpt-6-astra" }]);
  ui.matrix.render({ impact: all });
  const unit = ui.find("cache-matrix-unit").textContent;
  // A unit of exactly one is a real state on a corpus this size, and the legend
  // says so in the singular rather than "1 light = 1 checked follow-ups".
  assert.equal(unit, "unitOne");
  const picker = ui.find("cache-matrix-model-picker");
  picker.value = "gpt-6-astra";
  picker.dispatch("change");
  assert.equal(ui.matrix.selectedModel, "gpt-6-astra");
  assert.equal(ui.all("cache-matrix-rate")[0].textContent, "80.0%");
  assert.equal(ui.find("cache-matrix-unit").textContent, unit);
  ui.matrix.render({ impact: impact([[600, 400]], []) });
  assert.equal(picker.value, "gpt-6-astra");
  assert.equal(ui.find("cache-matrix-empty").textContent, "modelUnavailable");
  assert.equal(ui.all("cache-matrix-hit").length, 0);
  assert.equal(changes.at(-1).impact, null);
  ui.matrix.render({ impact: { ...all, byModel: null } });
  assert.equal(ui.find("cache-matrix-empty").textContent, "modelBreakdownUnavailable");
  assert.equal(picker.disabled, false, "retained selection can still escape to All models");
  picker.value = "";
  picker.dispatch("change");
  assert.equal(ui.all("cache-matrix-rate")[0].textContent, "85.7%");
});

test("a model cannot exceed its period cohort and render a misleading or unbounded volume", () => {
  const ui = mount();
  ui.matrix.render({ impact: impact([[10, 5]], [{ ...impact([[1_000_000, 500_000]]), model: "gpt-6-astra" }]) });
  const picker = ui.find("cache-matrix-model-picker");
  picker.value = "gpt-6-astra";
  picker.dispatch("change");
  assert.equal(ui.all("cache-matrix-hit").length, 0);
  assert.equal(ui.find("cache-matrix-empty").textContent, "modelUnavailable");
});

test("keyboard navigation and narrow layout retain all groups; destroy disconnects observers", () => {
  let disconnected = false;
  const ui = mount({ width: 390, windowRef: { ResizeObserver: class { observe() {} disconnect() { disconnected = true; } } } });
  ui.matrix.render({ impact: impact([[20, 10]]) });
  const buttons = ui.all("cache-matrix-hit");
  buttons[0].focus();
  let prevented = false;
  buttons[0].dispatch("keydown", { key: "End", preventDefault() { prevented = true; } });
  assert.equal(ui.document.activeElement, buttons[9]);
  assert.equal(prevented, true);
  assert.equal(ui.all("cache-matrix-gap").length, 10);
  buttons[9].dispatch("keydown", { key: "Escape" });
  assert.match(ui.find("cache-matrix-detail-identity").textContent, /^allGaps/);
  ui.matrix.destroy();
  assert.equal(disconnected, true);
  assert.equal(ui.container.children.length, 0);
  ui.matrix.render({ impact: impact([[20, 10]]) });
  assert.equal(ui.container.children.length, 0);
});


test("older combined snapshots explain unavailable model breakdown before interaction", () => {
  const ui = mount();
  const combined = impact([[100, 80]], null);
  ui.matrix.render({ impact: combined });
  assert.equal(ui.find("cache-matrix-model-note").hidden, false);
  assert.equal(ui.find("cache-matrix-model-note").textContent, "modelBreakdownUnavailable");
  assert.equal(ui.find("cache-matrix-model-picker").disabled, true);
  assert.equal(ui.all("cache-matrix-rate")[0].textContent, "80.0%");
  ui.matrix.render({ impact: { ...combined, byModel: [] } });
  assert.equal(ui.find("cache-matrix-model-note").hidden, true);
  assert.equal(ui.find("cache-matrix-model-picker").disabled, false);
});

test("every matrix message reaches the browser translator in all supported locales", () => {
  const prefix = "accounting.cacheContinuity.matrix.";
  const keys = Object.keys(CATALOGS["en-US"]).filter((key) => key.startsWith(prefix));
  assert.ok(keys.length >= 30);
  for (const locale of SUPPORTED_LOCALES) for (const key of keys) {
    const text = translate(key, { count: "3", total: "7", gap: "1h", percent: "42.9%" }, locale);
    assert.notEqual(text, key);
    assert.doesNotMatch(text, /\{(?:count|total|gap|percent)\}/u);
    assert.ok(CATALOGS[locale][key]);
  }
});

test("model details inherit availability so their ordering coverage remains visible", () => {
  const model = { ...impact([[10, 5]]), model: "gpt-6-astra", orderingCoverageGaps: 2, coverageStatus: "incomplete" };
  delete model.status;
  const changes = [];
  const ui = mount({ onModelChange: (change) => changes.push(change) });
  ui.matrix.render({ impact: impact([[10, 5]], [model]) });
  ui.find("cache-matrix-model-picker").value = model.model;
  ui.find("cache-matrix-model-picker").dispatch("change");
  assert.equal(changes.at(-1).impact.status, "available");
  assert.equal(changes.at(-1).impact.orderingCoverageGaps, 2);
});
