import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { modelThemeIcon } from "../public/model-visuals.js";
import { translate } from "../public/localization.js";
import {
  isPrimaryCodexQuotaWindow, isPrimaryCodexWeeklyQuotaWindow, selectPrimaryCodexQuotaWindow,
  isSparkQuotaLimitId, isValidQuotaWindowDuration,
} from "../public/data-client.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const match = source.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`, "u"));
  assert.ok(match, `${name} is present in shipped code`);
  return match[0];
}
class Element {
  constructor(tag = "div", className = "", text = "") {
    this.tagName = tag; this.className = className; this.children = [];
    this.text = text; this.attributes = {}; this.dataset = {}; this.events = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.hidden = false;
    this.classList = { toggle: (name, enabled) => {
      const values = new Set(this.className.split(" "));
      if (enabled) values.add(name); else values.delete(name);
      this.className = [...values].join(" ");
    } };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  append(...children) { for (const c of children) { c.parentNode = this; this.children.push(c); } }
  replaceChildren(...children) { this.text = ""; this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.events[key] = handler; }
}
function find(element, className) {
  return [element, ...element.children.flatMap(c => find(c, className))]
    .filter(e => e.className.split(" ").includes(className));
}
function harness(locale = "en-US") {
  const quota = new Element(); const card = new Element(); const context = new Element();
  const node = (...args) => new Element(...args);
  const document = { createElementNS: (_namespace, tag) => node(tag), createTextNode: text => node("text", "", text), activeElement: null };
  const constants = ["PACE_ON_TRACK_LOWER_RATIO", "PACE_ON_TRACK_UPPER_RATIO", "PACE_CRITICAL_RATIO", "PACE_AVERAGE_MINIMUM_HOURS", "PACE_STATE_LABELS"]
    .map(name => source.match(new RegExp(`\\nconst ${name} = [^;]+;`, "u"))[0]).join("\n");
  const functions = ["formatAllowanceDuration", "allowanceTimestamp", "formatForecastDuration", "forecastTimestamp", "firstFiniteForecastNumber", "weeklyPaceRates", "weeklyPaceStanding", "formatPaceRatio", "weeklyPaceTrack", "renderWeeklyPaceWaiting", "renderWeeklyPaceForecast", "renderQuotaCards", "providerReportedPlanEvidence", "renderDashboardSkeleton"]
    .map(declaration).join("\n");
  const factory = new Function("node", "document", "modelThemeIcon", "$", "t", "setLocalizedText", "isPrimaryCodexQuotaWindow", "isPrimaryCodexWeeklyQuotaWindow", "selectPrimaryCodexQuotaWindow", "isSparkQuotaLimitId", "isValidQuotaWindowDuration", "card", `
    const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
    const clear = element => element.replaceChildren();
    const formatDecimal = (value, digits = 0) => value.toFixed(digits);
    const formatPercent = value => value + "%";
    const CODEX_FIVE_HOUR_ALLOWANCE_MINUTES = 300;
    const USER_TIME_ZONE = "UTC";
    const dateTimeFormatter = () => ({ format: value => value.toISOString() });
    const localizedQuotaWindowLabel = w => w.limitId + " " + w.durationMinutes;
    const localizedQuotaWindowDuration = value => value + " minutes";
    let activeInformationPopover = null;
    let weeklyPaceDetailsOpen = false;
    let allowanceTankView = null;
    const closeInformationPopover = () => { activeInformationPopover = null; };
    const openInformationPopover = button => { activeInformationPopover = { button }; };
    const ensureWeeklyPaceForecastCard = () => card;
    ${constants}
    ${functions}
    return { renderQuotaCards, renderWeeklyPaceForecast, weeklyPaceTrack, formatAllowanceDuration,
      allowanceTimestamp, renderDashboardSkeleton, setTankView: view => { allowanceTankView = view; },
      popover: () => activeInformationPopover };
  `);
  const api = factory(node, document, modelThemeIcon, selector => ({ "#quota-cards": quota, "#allowance-context": context, "#weekly-pace-forecast": card })[selector],
    (key, values = {}) => translate(key, values, locale),
    (element, key) => { element.textContent = translate(key, {}, locale); },
    isPrimaryCodexQuotaWindow, isPrimaryCodexWeeklyQuotaWindow, selectPrimaryCodexQuotaWindow, isSparkQuotaLimitId, isValidQuotaWindowDuration, card);
  return { ...api, quota, card, context, document };
}
const now = Date.now();
const observedAt = new Date(now).toISOString();
function window(overrides = {}) {
  return { limitId: "codex", durationMinutes: 10_080, remainingPercent: 67, usedPercent: 33,
    status: "live", planType: "pro", resetAt: new Date(now + 114 * 3_600_000).toISOString(), observedAt, ...overrides };
}
function payload(windows) { return { quotaWindows: windows, freshness: { latestObservedAt: observedAt } }; }
function forecast(overrides = {}) {
  return { status: "available", remainingPercent: 67,
    resetsAt: new Date(now + 114 * 3_600_000).toISOString(),
    etaAt: new Date(now + 42 * 3_600_000).toISOString(), observationCount: 5,
    pace: { overallPercentagePointsPerHour: 67 / 42, activePercentagePointsPerHour: 3,
      sampleCount: 4, elapsedHours: 16 }, ...overrides };
}

test("tanks retain one, two and many pools, with the current Codex pool first", () => {
  for (const count of [1, 2, 4, 7]) {
    const h = harness();
    const windows = Array.from({ length: count }, (_, i) => window({ limitId: i ? `future_${i}` : "codex", limitName: i ? `Future ${i}` : null }));
    h.renderQuotaCards(payload(windows.reverse()));
    assert.equal(h.quota.children.length, count);
    assert.equal(h.quota.children[0].attributes["aria-label"], "codex 10080");
    assert.equal(find(h.quota, "quota-tank-fuel").length, count);
    assert.equal(h.quota.textContent.includes("Observation time"), false);
    assert.equal(h.context.textContent, "");
    assert.equal(h.context.hidden, true);
  }
});
test("unknown capacity has no fill; zero is a real empty tank; stale evidence stays explicit", () => {
  const h = harness();
  h.renderQuotaCards(payload([window({ remainingPercent: null }), window({ remainingPercent: 0 }), window({ status: "stale" })]));
  assert.equal(find(h.quota.children[0], "quota-tank-fuel").length, 0);
  assert.match(h.quota.children[0].textContent, /unknown/u);
  assert.equal(find(h.quota.children[1], "quota-tank-fuel")[0].style.blockSize, "0%");
  assert.match(h.quota.children[2].textContent, /Stale observation/u);
  assert.match(h.quota.children[2].textContent, /Observation time/u);
  h.renderQuotaCards(payload([]));
  assert.equal(h.context.hidden, true);
  assert.equal(h.quota.children.length, 1);
});
test("an elapsed reset never becomes a fresh full tank or a negative countdown", () => {
  const h = harness();
  h.renderQuotaCards(payload([window({ resetAt: new Date(now - 1000).toISOString() })]));
  assert.match(h.quota.textContent, /Reset time passed/u);
  assert.equal(find(h.quota, "quota-tank-fuel")[0].style.blockSize, "67%");
});
test("relative durations retain sub-hour precision honestly and translate", () => {
  const h = harness();
  assert.equal(h.formatAllowanceDuration(null), null);
  assert.equal(h.formatAllowanceDuration(-1), null);
  assert.equal(h.formatAllowanceDuration(.01), "<1h");
  assert.equal(h.formatAllowanceDuration(42), "1d 18h");
  assert.equal(h.formatAllowanceDuration(2.5), "2h");
  assert.equal(harness("es").formatAllowanceDuration(42), "1 d 18 h");
  assert.equal(harness("zh-Hans").formatAllowanceDuration(42), "1 天 18 小时");
});
test("timestamp controls expose exact times on hover, focus and tap, and close on blur", () => {
  const h = harness(); const button = h.allowanceTimestamp("1d 18h", now);
  assert.equal(button.tagName, "button");
  assert.equal(button.dataset.informationExplanation, observedAt);
  assert.match(button.attributes["aria-label"], /1d 18h/u);
  button.events.mouseenter(); assert.equal(h.popover().button, button);
  button.events.mouseleave(); assert.equal(h.popover(), null);
  button.events.focus(); assert.equal(h.popover().button, button);
  button.events.blur(); assert.equal(h.popover(), null);
  button.events.click({ stopPropagation() {} }); assert.equal(h.popover().button, button);
});
test("the labelled timeline uses the headline run-out, not the active-use edge", () => {
  const h = harness(); const resetAt = now + 114 * 3_600_000;
  const track = h.weeklyPaceTrack({ coveredHours: 42, dryHours: 72 }, 114, resetAt);
  assert.equal(track.style["--pace-covered"], "36.84%");
  assert.equal(find(track, "weekly-pace-track-mark")[0].style.insetInlineStart, "36.84%");
  const time = find(track, "allowance-timestamp");
  assert.equal(time[0].textContent, "In 1d 18h");
  assert.equal(time[0].dataset.informationExplanation, new Date(now + 42 * 3_600_000).toISOString());
  assert.equal(time[1].textContent, "In 4d 18h");
  assert.match(track.textContent, /Nothing left for 3d 0h/u);
  for (const coveredHours of [1, 113]) {
    const edge = h.weeklyPaceTrack({ coveredHours, dryHours: 114 - coveredHours }, 114, resetAt);
    assert.match(edge.className, /is-edge/u);
  }
  const full = h.weeklyPaceTrack({ coveredHours: 114, dryHours: 0 }, 114, resetAt);
  assert.equal(find(full, "weekly-pace-track-runout").length, 0);
  assert.match(full.textContent, /Lasts until reset/u);
});
test("one forecast preserves pace, evidence and early/unknown gates across refreshes", () => {
  const h = harness();
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast() } });
  assert.equal(h.card.hidden, false);
  assert.match(h.card.textContent, /Way over pace/u);
  assert.match(h.card.textContent, /2.7×/u);
  assert.match(h.card.textContent, /overall.*while active/u);
  assert.equal(find(h.card, "weekly-pace-track-mark").length, 1);
  assert.equal(find(h.card, "weekly-pace-details")[0].open, false);
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast({ status: "insufficient_observations", observationCount: 1, etaAt: null, pace: {} }) } });
  assert.equal(h.card.hidden, false);
  assert.match(h.card.textContent, /one more refresh/u);
  assert.equal(find(h.card, "weekly-pace-track").length, 0);
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: null } });
  assert.equal(h.card.hidden, true);
  assert.equal(h.card.children.length, 0);
});
test("the Overview owns current pace independently of historical plan selection", () => {
  assert.match(declaration("renderDashboard"), /renderQuotaCards\(data\);\s+renderWeeklyPaceForecast\(data\);/u);
  assert.doesNotMatch(declaration("renderWeekly"), /renderWeeklyPaceForecast/u);
  assert.match(declaration("ensureWeeklyPaceForecastCard"), /#quota-cards/u);
  assert.match(declaration("renderDashboardSkeleton"), /forecast.hidden = true; clear\(forecast\)/u);
});

test("under-pace and near-reset forecasts preserve their distinct gap semantics", () => {
  const h = harness();
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast({
    status: "will_reach_reset_first", etaAt: null,
    pace: { overallPercentagePointsPerHour: .2, activePercentagePointsPerHour: .4, elapsedHours: 16 },
  }) } });
  assert.match(h.card.className, /is-under-pace/u);
  assert.match(h.card.textContent, /Under pace/u);
  assert.equal(find(h.card, "weekly-pace-track-runout").length, 0);
  assert.match(h.card.textContent, /Spare at reset/u);
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast({
    pace: { overallPercentagePointsPerHour: 67 / 110, elapsedHours: 16 },
  }) } });
  assert.match(h.card.className, /is-on-pace/u);
  assert.equal(find(h.card, "weekly-pace-track-runout").length, 1);
  assert.match(h.card.textContent, /Nothing left for/u);
  h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast({ resetsAt: observedAt }) } });
  assert.equal(h.card.hidden, true);
});

test("all forecast states translate without changing their observed values", () => {
  for (const locale of ["es", "zh-Hans"]) {
    const h = harness(locale);
    h.renderWeeklyPaceForecast({ weekly: { paceForecast: forecast() } });
    assert.match(h.card.textContent, /67%/u);
    assert.equal(h.card.textContent.includes("Recent use"), false);
    assert.equal(h.card.textContent.includes("allowance."), false);
    assert.equal(h.card.textContent.includes("{duration}"), false);
  }
});

test("five-hour tanks are narrow and Spark uses its shared model identity", () => {
  const h = harness();
  h.renderQuotaCards(payload([
    window(),
    window({ durationMinutes: 300 }),
    window({ limitId: "codex_bengalfox", durationMinutes: 300 }),
  ]));
  assert.deepEqual(h.quota.children.map(card => card.dataset.shortWindow), ["false", "true", "true"]);
  const spark = h.quota.children[2];
  assert.match(spark.textContent, /GPT-5\.3 Codex Spark/);
  const family = find(spark, "quota-tank-family")[0];
  assert.equal(family.children[0].attributes.class, "allowance-model-icon");
  assert.equal(family.children[0].attributes["aria-hidden"], "true");
});


test("Codex tanks use the bundled logo and demo evidence remains labelled", () => {
  const h = harness();
  h.renderQuotaCards({ ...payload([window()]), mode: "demo" });
  const family = find(h.quota, "quota-tank-family")[0];
  assert.equal(family.children[0].attributes.src, "./codex-color.svg");
  assert.equal(family.children[0].attributes.alt, "");
  assert.equal(family.textContent, "Codex");
  assert.equal(h.context.hidden, false);
  assert.notEqual(h.context.textContent, "");
});

test("animated forecast coverage retains absolute positioning and a non-collapsing fill", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/\.weekly-pace-track-covered\s*\{([^}]+)\}/gu)];
  const positions = rules.flatMap(rule => [...rule[1].matchAll(/position:\s*([^;]+);/gu)].map(value => value[1]));
  assert.equal(positions.at(-1), "absolute");
  assert.ok(rules.some(rule => /inset-block:\s*0;/.test(rule[1])));
});


test("unavailable dashboard disposes tank observers before removing their DOM", () => {
  const h = harness();
  h.renderQuotaCards(payload([window()]));
  h.card.append(new Element());
  let disposals = 0;
  h.setTankView({ dispose() {
    assert.equal(find(h.quota, "quota-tank").length, 1, "dispose while the observed card still exists");
    disposals++;
  } });
  h.renderDashboardSkeleton();
  assert.equal(disposals, 1);
  assert.equal(find(h.quota, "quota-tank").length, 0);
  assert.equal(h.card.hidden, true);
  assert.equal(h.card.children.length, 0);
  h.renderDashboardSkeleton();
  assert.equal(disposals, 1, "repeated unavailable renders do not retain or dispose an old manager");
});


test("primary weekly allowance keeps a neutral forecast panel when pace evidence is unavailable", () => {
  const h = harness();
  for (const paceForecast of [null, {}, [], { status: "insufficient_observations" },
    forecast({ status: "unbounded" }), forecast({ resetsAt: "invalid" }),
    forecast({ resetsAt: observedAt }), forecast({ etaAt: "invalid" }),
    forecast({ etaAt: new Date(now - 1000).toISOString() }),
    forecast({ etaAt: new Date(now + 200 * 3_600_000).toISOString() })]) {
    h.renderWeeklyPaceForecast({ ...payload([window()]), weekly: { paceForecast } });
    assert.equal(h.card.hidden, false, JSON.stringify(paceForecast));
    assert.match(h.card.className, /is-waiting/u);
    assert.match(h.card.textContent, /More valid allowance observations/u);
    assert.doesNotMatch(h.card.textContent, /out of date|refreshing|runs out in/iu);
    assert.equal(find(h.card, "weekly-pace-track").length, 0);
    assert.equal(find(h.card, "allowance-timestamp").length, 0);
    assert.equal(h.card.dataset.tankRatio, undefined);
  }
  for (const windows of [[], [window({ durationMinutes: 300 })], [window({ limitId: "codex_bengalfox" })]]) {
    h.renderWeeklyPaceForecast({ ...payload(windows), weekly: { paceForecast: null } });
    assert.equal(h.card.hidden, true, "waiting applies only to the primary weekly pool");
  }
});

test("stale allowance cannot retain a confident forecast and a fresh single observation keeps collecting", () => {
  const h = harness();
  h.renderWeeklyPaceForecast({ ...payload([window()]), weekly: { paceForecast: forecast() } });
  assert.ok(h.card.dataset.tankRatio);
  h.renderWeeklyPaceForecast({ ...payload([window({ status: "stale" })]), weekly: { paceForecast: forecast() } });
  assert.equal(h.card.hidden, false);
  assert.match(h.card.textContent, /Fresh allowance evidence needed/u);
  assert.match(h.card.textContent, /observation is out of date/u);
  assert.equal(h.card.dataset.tankRatio, undefined);
  assert.equal(find(h.card, "weekly-pace-track").length, 0);
  h.renderWeeklyPaceForecast({ ...payload([window()]), weekly: { paceForecast: forecast({
    status: "insufficient_observations", observationCount: 1, etaAt: null, pace: {},
  }) } });
  assert.match(h.card.textContent, /one more refresh/u);
  assert.doesNotMatch(h.card.className, /is-waiting/u);
});

test("waiting forecast copy translates without inventing dates or progress", () => {
  for (const locale of ["es", "zh-Hans"]) {
    const h = harness(locale);
    for (const status of ["live", "stale"]) {
      h.renderWeeklyPaceForecast(payload([window({ status })]));
      assert.equal(h.card.hidden, false);
      assert.doesNotMatch(h.card.textContent, /allowance\.|Waiting|Fresh allowance|Your pace/iu);
      assert.equal(find(h.card, "allowance-timestamp").length, 0);
      assert.equal(find(h.card, "weekly-pace-track").length, 0);
    }
  }
});
