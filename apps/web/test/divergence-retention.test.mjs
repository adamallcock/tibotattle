import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("let nextDivergenceBreakdownId = 0;");
const end = source.indexOf("\n/**\n * Whether a series draws its data points", start);
assert.ok(start >= 0 && end > start);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const period = (startMs = 100) => ({
  startMs, endMs: startMs + 100, startAt: "start", endAt: "end",
  durationMs: 100, direction: "under_costed", absPeakDriftPp: 2,
  peakDriftPp: 2, signedAucPpHours: 1,
  contributors: { costUsd: 2, totalTokens: 100, usageEvents: 1,
    unpricedEventShare: 0, unpricedEvents: 0 },
});
const snapshot = (generation = "1", planType = "pro", mode = "local") => ({
  mode, accounting: { generation }, allowancePlanSelection: { planType },
  timeline: { usage: [], planScoped: { planScope: {
    planType, cohortId: "synthetic", methodVersion: "plan-era-v1", basisFamilyId: "basis",
    sourceGeneration: generation, sourceGenerationFingerprint: `fingerprint-${generation}`,
  } } },
});
const result = (model = "gpt-6-astra") => ({
  status: "available", costUsd: 2, byModel: [{ model, costUsd: 2 }],
  bySpeed: {}, fastCostUsd: 0, unpricedShare: 0,
});

function harness() {
  const document = { activeElement: null };
  class Element {
    constructor(tag, className = "", text = "") {
      this.tag = tag; this.className = className; this.text = text;
      this.children = []; this.attributes = new Map(); this.listeners = new Map();
    }
    append(...items) { this.children.push(...items); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key); }
    addEventListener(key, listener) { this.listeners.set(key, listener); }
    click() { this.listeners.get("click")(); }
    focus() { document.activeElement = this; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  }
  const elements = new Map(["list", "empty", "summary", "caveat"]
    .map((key) => [`#divergence-${key}`, new Element("div")]));
  const requests = [];
  const focusedPeriods = [];
  const node = (...args) => new Element(...args);
  const translate = (key, values = {}) => `${key} ${Object.values(values).join(" ")}`;
  const dependencies = {
    document, node, rawNode: node,
    localizedNode: (tag, cls, key, values) => node(tag, cls, translate(key, values)),
    setLocalizedText: (element, key, values) => { element.text = translate(key, values); },
    setLocalizedPluralText: () => {},
    clear: (element) => { element.children = []; element.text = ""; },
    $: (id) => elements.get(id), t: translate,
    detectDeviationPeriods: (periods) => ({ periods, totalFound: periods.length }),
    accountingPeriod: () => null,
    focusTrendsPeriod: period => focusedPeriods.push(period),
    localClient: { windowBreakdown(from, to) {
      const request = { from, to, ...deferred() }; requests.push(request); return request.promise;
    } },
  };
  for (const name of ["formatChartTimestamp", "formatSpanLength", "formatPp",
    "formatSignedPp", "formatSignedPpHours", "formatApiMoney", "compact",
    "formatPercent", "formatNumber", "formatModelName"]) dependencies[name] = String;
  const api = Function(...Object.keys(dependencies), `${source.slice(start, end)}
    return { render: renderDivergencePeriods, state: divergenceDetails };`
  )(...Object.values(dependencies));
  return { ...api, requests, document, focusedPeriods,
    card: () => elements.get("#divergence-list").children[0],
    toggle: () => elements.get("#divergence-list").children[0].children.at(-2),
    panel: () => elements.get("#divergence-list").children[0].children.at(-1),
  };
}

test("divergence cards lead with the signed peak gap and focus the exact period without fetching details", () => {
  for (const direction of ["under_costed", "over_costed"]) {
    const h = harness(), selected = { ...period(), direction, peakDriftPp: direction === "under_costed" ? 2 : -2 };
    h.render(snapshot(), [selected]);
    const card = h.card();
    assert.equal(card.children[1].children[0].textContent, String(selected.peakDriftPp));
    assert.match(card.children[1].getAttribute("title"), /trends.gapExplanation/);
    assert.match(card.children[2].textContent, direction === "under_costed" ? /trends.faster/ : /trends.slower/);
    card.children.find(child => child.className.includes("divergence-focus")).click();
    assert.deepEqual(h.focusedPeriods, [selected]);
    assert.equal(h.requests.length, 0);
    assert.equal(h.panel().hidden, true);
  }
});

test("expanded details and keyboard focus survive unchanged snapshots without another request", async () => {
  const h = harness();
  h.render(snapshot(), [period()]);
  h.toggle().click(); h.toggle().focus();
  h.requests[0].resolve(result()); await settle();
  assert.match(h.panel().textContent, /gpt-6-astra/);
  h.render(snapshot(), [period()]);
  assert.equal(h.toggle().getAttribute("aria-expanded"), "true");
  assert.equal(h.document.activeElement, h.toggle());
  assert.equal(h.panel().hidden, false);
  assert.match(h.panel().textContent, /gpt-6-astra/);
  assert.equal(h.requests.length, 1);
});

test("period breakdowns use the keyed speed contract and explain their purpose", async () => {
  const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
  h.requests[0].resolve({ ...result(), bySpeed: {
    standard: { costUsd: 1, events: 2 }, fast: { costUsd: .8, events: 1 }, unknown: { costUsd: .2, events: 1 },
  } });
  await settle();
  assert.match(h.panel().textContent, /trends.mixPurpose/);
  assert.match(h.panel().textContent, /divergence.speed.standard/);
  assert.match(h.panel().textContent, /divergence.speed.fast/);
  assert.equal(h.panel().textContent.match(/divergence.speed.unknown/g).length, 1);
  assert.equal(h.panel().children.some(child => child.className.includes("divergence-retry")), false);
});

test("failed initial and retained breakdowns offer a bounded retry without closing the panel", async () => {
  const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
  h.requests[0].resolve(null); await settle();
  let retry = h.panel().children.find(child => child.className.includes("divergence-retry"));
  assert.ok(retry);
  retry.click(); retry.click();
  assert.equal(h.requests.length, 2, "pending retries cannot duplicate a request");
  assert.equal(h.document.activeElement, h.toggle(), "loading must not discard keyboard focus with the retry button");
  assert.equal(h.panel().hidden, false);
  h.requests[1].resolve(result()); await settle();
  assert.match(h.panel().textContent, /gpt-6-astra/);
  h.render(snapshot("2"), [period()]);
  h.requests[2].resolve(null); await settle();
  assert.match(h.panel().textContent, /gpt-6-astra/);
  assert.match(h.panel().textContent, /trends.mixRetained/);
  retry = h.panel().children.find(child => child.className.includes("divergence-retry"));
  retry.click(); h.requests[3].resolve(result("updated")); await settle();
  assert.match(h.panel().textContent, /updated/);
  assert.doesNotMatch(h.panel().textContent, /trends.mixRetained/);
});

test("new revisions refresh behind retained details and failed refreshes can retry", async () => {
  const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
  h.requests[0].resolve(result()); await settle();
  h.render(snapshot("2"), [period()]);
  assert.match(h.panel().textContent, /gpt-6-astra/);
  h.requests[1].resolve({ status: "unavailable" }); await settle();
  assert.match(h.panel().textContent, /gpt-6-astra/);
  h.toggle().click(); h.toggle().click();
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve(result("gpt-5.6-sol")); await settle();
  assert.match(h.panel().textContent, /gpt-5.6-sol/);
});

test("initial failure retries and a superseded response cannot replace the current revision", async () => {
  const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
  h.requests[0].resolve(null); await settle();
  assert.match(h.panel().textContent, /unavailablePlain/);
  h.toggle().click(); h.toggle().click();
  h.render(snapshot("2"), [period()]);
  assert.equal(h.requests.length, 2, "one pending request per window");
  h.requests[1].resolve(result("old")); await settle();
  assert.equal(h.requests.length, 3);
  assert.doesNotMatch(h.panel().textContent, /old/);
  h.requests[2].resolve(result("current")); await settle();
  assert.match(h.panel().textContent, /current/);
});

test("different windows, evidence, plan cohorts and demo do not inherit pending or successful details", async () => {
  for (const change of [
    { data: snapshot(), periods: [period(200)] },
    { data: snapshot(), periods: [{ ...period(), contributors: { ...period().contributors, costUsd: 3 } }] },
    { data: snapshot("1", "plus"), periods: [period()] },
    { data: { ...snapshot(), timeline: { planScoped: { planScope: { ...snapshot().timeline.planScoped.planScope, cohortId: "another" } } } }, periods: [period()] },
    { data: snapshot("1", "pro", "demo"), periods: [period()] },
  ]) {
    const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
    h.render(change.data, change.periods);
    h.requests[0].resolve(result("old")); await settle();
    assert.equal(h.toggle().getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(h.panel().textContent, /old/);
    if (change.data.mode === "demo") {
      h.toggle().click(); assert.equal(h.requests.length, 1);
    }
  }
});

test("retention is bounded to displayed windows and discarded when no periods remain", () => {
  const h = harness();
  h.render(snapshot(), Array.from({ length: 25 }, (_, i) => period(100 * i)));
  assert.equal(h.state.size, 20);
  h.render(snapshot(), [period(999)]);
  assert.equal(h.state.size, 1);
  h.render(snapshot(), []);
  assert.equal(h.state.size, 0);
});


test("installed companion real-local mode loads details and changed accounting fingerprint refreshes", async () => {
  const h = harness();
  const data = snapshot("1", "pro", "real_local_evidence");
  data.accounting.generationFingerprint = "first";
  h.render(data, [period()]); h.toggle().click();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(result("original")); await settle();
  h.render({ ...data, accounting: { ...data.accounting, generationFingerprint: "second" } }, [period()]);
  assert.equal(h.requests.length, 2);
  assert.match(h.panel().textContent, /original/);
  h.requests[1].resolve(result("updated")); await settle();
  assert.match(h.panel().textContent, /updated/);
});

test("collapsing a pending superseded revision keeps the reopened window retryable", async () => {
  const h = harness(); h.render(snapshot(), [period()]); h.toggle().click();
  h.render(snapshot("2"), [period()]);
  h.toggle().click();
  h.requests[0].resolve(result("superseded")); await settle();
  assert.equal(h.requests.length, 1);
  h.toggle().click();
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(h.panel().textContent, /superseded/);
  h.requests[1].resolve(result("current")); await settle();
  assert.match(h.panel().textContent, /current/);
});
