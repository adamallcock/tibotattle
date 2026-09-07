import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { planWeeklyApiEquivalentUsd } from "../public/community-data.js";
import { allowanceModelPresentation } from "../public/community-view.js";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

class InitNode {
  constructor() {
    this.children = [];
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  setAttribute() {}
}

function initDocument() {
  const byId = new Map([
    "notice",
    "refresh",
    "diagnostic-reference",
    "diagnostic-form",
    "controls-form",
    "run-maintenance",
    "maintenance-result",
  ].map((id) => [id, new InitNode()]));
  return {
    body: null,
    createElement: () => new InitNode(),
    createElementNS: () => new InitNode(),
    createTextNode(value) {
      const node = new InitNode();
      node.textContent = value;
      return node;
    },
    querySelector(selector) {
      return selector.startsWith("#") ? byId.get(selector.slice(1)) ?? null : null;
    },
  };
}

async function importAdminModule() {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    window: globalThis.window,
  };
  globalThis.document = initDocument();
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { code: "ADMIN_NOT_CONFIGURED" } }),
  });
  globalThis.window = { innerHeight: 844, innerWidth: 390 };
  try {
    const moduleUrl = new URL("../public/admin.js", import.meta.url);
    moduleUrl.search = `?admin-allowance-test=${process.hrtime.bigint()}`;
    const loaded = await import(moduleUrl.href);
    await new Promise((resolve) => setImmediate(resolve));
    return loaded;
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
}

function allowanceSummary(centralUsd, fitCount = 4, participantCount = 3) {
  return {
    fitCount,
    participantCount,
    centralUsd,
    band80Usd: fitCount >= 3
      ? { lowerUsd: centralUsd - 180, upperUsd: centralUsd + 220 }
      : null,
  };
}

function emptyAllowanceSummary() {
  return { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
}

function allowancePreview() {
  const fromMs = Date.parse("2026-06-15T00:00:00.000Z");
  return {
    plans: [
      { planType: "pro", label: "Pro 20x", multiplier: 1 },
      { planType: "prolite", label: "Pro 5x", multiplier: 4 },
      { planType: "plus", label: "Plus", multiplier: 20 },
    ],
    days: Array.from({ length: 70 }, (_, index) => {
      const day = new Date(fromMs + index * DAY_MILLISECONDS)
        .toISOString()
        .slice(0, 10);
      return {
        day,
        combined: allowanceSummary(2_000 + index * 2),
        byPlanType: {
          pro: allowanceSummary(1_900 + index * 2, 5, 2),
          prolite: allowanceSummary(2_150 + index, 4, 2),
          plus: allowanceSummary(1_750 + index * 3, 3, 1),
        },
      };
    }),
  };
}

function allowancePreviewWithModels() {
  const preview = allowancePreview();
  const lastDays = preview.days.slice(-3).map((day) => day.day);
  preview.models = {
    modelConfig: [
      { modelId: "gpt-5.6-sol", label: "Sol" },
      { modelId: "gpt-5.6-terra", label: "Terra" },
      { modelId: "gpt-5.6-luna", label: "Luna" },
      { modelId: "gpt-5.5", label: "GPT-5.5" },
    ],
    basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
    gate: "shared_composition_kernel_identification",
    days: lastDays.map((day, index) => ({
      day,
      byModel: {
        "gpt-5.6-sol": { capacityUsd: 2_400 + index * 10, participantCount: 1 },
        "gpt-5.6-terra": { capacityUsd: 1_100 + index * 5, participantCount: 1 },
        "gpt-5.6-luna": { capacityUsd: null, participantCount: 0 },
        "gpt-5.5": { capacityUsd: 2_100, participantCount: 1 },
      },
      fittedParticipantCount: 1,
      unstableParticipantCount: 0,
      staleParticipantCount: 0,
      refusedParticipantCount: 0,
      v1ParticipantCount: 1,
      unsupportedSourceParticipantCount: 2,
    })),
  };
  return preview;
}

test("the models mode draws per-model series from the sparse day history", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  const model = adminAllowanceChartModel(preview, { mode: "models", rangeDays: 30 });
  assert.notEqual(model, null);
  assert.equal(model.mode, "models");
  assert.deepEqual(model.legendSeries.map((series) => series.key), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
  const sol = model.series.find((series) => series.key === "gpt-5.6-sol");
  assert.equal(sol.points.length, 3);
  assert.equal(sol.points.at(-1).value, 2_420);
  assert.equal(sol.points.at(-1).participantCount, 1);
  const luna = model.series.find((series) => series.key === "gpt-5.6-luna");
  assert.equal(luna.points.length, 0);
  // The composition basis carries no q10-q90 band.
  assert.deepEqual(model.bandSegments, []);
  assert.deepEqual(model.bandSeries, []);
});

test("the numerical axis is identical across all three modes", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  const axes = ["combined", "plans", "models"].map((mode) => (
    adminAllowanceChartModel(preview, { mode, rangeDays: 30 })
      .dollarTicks.map((tick) => tick.value)
  ));
  assert.deepEqual(axes[1], axes[0]);
  assert.deepEqual(axes[2], axes[0]);
});

test("model filtering preserves catalog visibility without manufacturing evidence", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  preview.models.modelConfig.push({ modelId: "gpt-6-astra", label: "GPT-6 Astra" });
  const all = adminAllowanceChartModel(preview, { mode: "models" });
  const observed = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "observed" });
  assert.deepEqual(observed.legendSeries.map((series) => series.key), [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5",
  ]);
  assert.deepEqual(all.legendSeries.map((series) => series.key), [
    "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  ]);
  const sol = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "gpt-5.6-sol" });
  assert.equal(sol.series.length, 1);
  assert.deepEqual(sol.dollarTicks, all.dollarTicks);
  assert.equal(adminAllowanceChartModel(preview, { mode: "models", modelFilter: "gpt-6-astra" }), null);
});

test("admin model order and themes match the public presentation, including catalog fallbacks", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  preview.models.modelConfig.push({ modelId: "gpt-6-astra", label: "GPT-6 Astra" });
  preview.models.modelConfig.push({ modelId: "gpt-5.4-mini", label: "GPT-5.4 mini" });
  const model = adminAllowanceChartModel(preview, { mode: "models" });
  assert.deepEqual(model.legendSeries.map(({ key, theme, className }) => [key, theme, className]), [
    ["gpt-6-astra", "astra", "allowance-model-astra"],
    ["gpt-5.6-sol", "sol", "allowance-model-sol"],
    ["gpt-5.6-terra", "terra", "allowance-model-terra"],
    ["gpt-5.6-luna", "luna", "allowance-model-luna"],
    ["gpt-5.5", "classic", "allowance-model-classic"],
    ["gpt-5.4-mini", null, "allowance-series-5"],
  ]);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const definition of model.legendSeries) {
    const index = preview.models.modelConfig.findIndex(({ modelId }) => modelId === definition.key);
    assert.deepEqual({ order: definition.order, theme: definition.theme, className: definition.className },
      allowanceModelPresentation(definition.key, index));
    assert.ok(css.includes(`.${definition.className} { --allowance-color: #`));
  }
  for (let index = 0; index < 8; index += 1) {
    assert.ok(css.includes(`.allowance-series-${index} { --allowance-color: #`));
  }
});

test("model cards use the compact shared summary grid while retaining narrow-screen layout", async () => {
  const source = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/admin.css", import.meta.url), "utf8");
  const sharedCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(source.includes('grid.className = "admin-allowance-plan-summaries allowance-summary-cards";'));
  assert.match(sharedCss, /\.allowance-summary-cards \{\s+display: grid;/u);
  assert.match(css, /\.admin-allowance-plan-summaries \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 190px\), 1fr\)\); \}/u);
  assert.match(css, /\.admin-allowance-plan-summary \.allowance-summary-value \{[^}]*font-size: 2rem;/u);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.admin-allowance-plan-summaries \{ grid-template-columns: 1fr; \}/u);
});

test("reconstructed model history keeps missing days and later model introductions as gaps", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  preview.models.modelConfig.push({ modelId: "gpt-6-astra", label: "GPT-6 Astra" });
  const template = preview.models.days[0];
  preview.models.days = preview.days.slice(-30).map((day, index) => ({
    ...template,
    day: day.day,
    byModel: {
      ...template.byModel,
      "gpt-5.6-sol": { capacityUsd: index === 12 ? null : 2_000 + index * 10, participantCount: index === 12 ? 0 : 1 },
      "gpt-6-astra": { capacityUsd: index < 27 ? null : 1_500 + index * 5, participantCount: index < 27 ? 0 : 1 },
    },
  }));
  const model = adminAllowanceChartModel(preview, { mode: "models", rangeDays: 30 });
  const sol = model.series.find(series => series.key === "gpt-5.6-sol");
  const astra = model.series.find(series => series.key === "gpt-6-astra");
  assert.equal(sol.points.length, 29);
  assert.deepEqual(sol.segments.map(segment => segment.length), [12, 17]);
  assert.equal(astra.points.length, 3);
  assert.deepEqual(astra.points.map(point => point.day), preview.models.days.slice(-3).map(day => day.day));
  assert.ok(astra.points.every(point => point.value > 0));
});

test("model history explains its retrospective cutoff without promising complete evidence", async () => {
  const source = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.ok(source.includes("same 100-day lookback and only observations through each UTC day"));
  assert.ok(source.includes("retrospective estimates, not a record of what was displayed then"));
  assert.ok(source.includes("later model usage is not carried backward"));
  assert.ok(!source.includes("The series accrues from the first day"));
});

test("allowance preview switches series without changing its numerical axes", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreview();
  const combined = adminAllowanceChartModel(preview, {
    mode: "combined",
    rangeDays: 30,
  });
  const plans = adminAllowanceChartModel(preview, {
    mode: "plans",
    rangeDays: 30,
  });

  assert.equal(combined.series.length, 1);
  assert.equal(combined.series[0].label, "Combined");
  assert.equal(combined.series[0].points.length, 30);
  assert.equal(combined.bandSegments.length, 1);
  assert.equal(combined.bandSegments[0].length, 30);

  assert.deepEqual(plans.series.map((series) => series.label), [
    "Pro 20×",
    "Pro 5×",
    "Plus",
  ]);
  assert.ok(plans.series.every((series) => series.points.length === 30));
  assert.deepEqual(plans.dollarTicks, combined.dollarTicks);
  assert.deepEqual(plans.dayTicks, combined.dayTicks);
  assert.deepEqual(plans.plot, combined.plot);
  assert.equal(plans.bandSeries.length, 3);
  assert.ok(plans.bandSeries.every((band) => band.segments[0].length === 30));
  assert.equal(plans.bandSegments.length, 3);
});

test("allowance preview filters one plan without rescaling or hiding legend choices", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreview();
  const allPlans = adminAllowanceChartModel(preview, {
    mode: "plans",
    rangeDays: 30,
  });
  const filtered = adminAllowanceChartModel(preview, {
    mode: "plans",
    planFilter: "prolite",
    rangeDays: 30,
  });

  assert.equal(filtered.activePlanFilter, "prolite");
  assert.deepEqual(filtered.series.map((series) => series.label), ["Pro 5×"]);
  assert.deepEqual(filtered.bandSeries.map((band) => band.key), ["prolite"]);
  assert.deepEqual(filtered.legendSeries.map((series) => series.key), [
    "pro",
    "prolite",
    "plus",
  ]);
  assert.deepEqual(filtered.dollarTicks, allPlans.dollarTicks);
  assert.deepEqual(filtered.dayTicks, allPlans.dayTicks);
  assert.deepEqual(filtered.plot, allPlans.plot);
});

test("allowance plan filter toggles the selected plan and rejects unknown plans", async () => {
  const { toggleAdminAllowancePlanFilter } = await importAdminModule();
  const plans = allowancePreview().plans;

  assert.equal(toggleAdminAllowancePlanFilter(null, "pro", plans), "pro");
  assert.equal(toggleAdminAllowancePlanFilter("pro", "pro", plans), null);
  assert.equal(toggleAdminAllowancePlanFilter("pro", "plus", plans), "plus");
  assert.equal(toggleAdminAllowancePlanFilter("pro", "unknown", plans), null);
});

test("allowance preview exposes the complete honest 70-day range", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const model = adminAllowanceChartModel(allowancePreview(), {
    mode: "combined",
    rangeDays: null,
  });
  assert.equal(model.series[0].points.length, 70);
  assert.equal(model.series[0].points[0].day, "2026-06-15");
  assert.equal(model.series[0].points.at(-1).day, "2026-08-23");
  assert.equal(model.tickLabelStyle, "day");
});

test("actual-plan weekly dollars invert the canonical basis before rounding and preserve zero", () => {
  assert.equal(planWeeklyApiEquivalentUsd(2_050.75, "pro"), 2_050.75);
  assert.equal(planWeeklyApiEquivalentUsd(1_917.9, "prolite"), 479.475);
  assert.equal(planWeeklyApiEquivalentUsd(1_900, "plus"), 95);
  for (const plan of ["pro", "prolite", "plus"]) {
    assert.equal(planWeeklyApiEquivalentUsd(0, plan), 0);
  }
  for (const value of [null, undefined, "1917.9", NaN, Infinity, -Infinity, -1]) {
    assert.equal(planWeeklyApiEquivalentUsd(value, "prolite"), null);
  }
  for (const plan of [null, undefined, "unknown", "team", "__proto__", "constructor"]) {
    assert.equal(planWeeklyApiEquivalentUsd(1_900, plan), null);
  }
});

test("All fits each view to its evidence without dropping interior model gaps or rescaling dollars", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  const template = preview.models.days[0];
  preview.models.days = [10, 11, 13, 14].map((index) => ({ ...template, day: preview.days[index].day }));
  preview.days[0].combined = allowanceSummary(20_000);
  const combined = adminAllowanceChartModel(preview, { mode: "combined", rangeDays: null });
  const models = adminAllowanceChartModel(preview, { mode: "models", rangeDays: null });
  assert.deepEqual(models.dayTicks.map(({ day }) => day), preview.days.slice(10, 15).map(({ day }) => day));
  assert.deepEqual(models.dollarTicks, combined.dollarTicks);
  assert.equal(models.series[0].points[0].x, models.plot.left);
  assert.equal(models.series[0].points.at(-1).x, models.plot.right);
  assert.deepEqual(models.series[0].segments.map((segment) => segment.map(({ day }) => day)), [
    [preview.days[10].day, preview.days[11].day],
    [preview.days[13].day, preview.days[14].day],
  ]);
  assert.equal(models.series[0].points.some(({ day }) => day === preview.days[12].day), false);
  assert.equal(combined.dayTicks[0].day, preview.days[0].day);
  assert.equal(combined.dayTicks.at(-1).day, preview.days.at(-1).day);
});

test("All plan focus and model focus retain their unfocused dates, axes and legend choices", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  for (const [index, day] of preview.days.entries()) {
    for (const plan of preview.plans) {
      if (index < 10 || index > 30 || (plan.planType === "prolite" && (index < 15 || index > 20))) {
        day.byPlanType[plan.planType] = emptyAllowanceSummary();
      }
    }
  }
  const allPlans = adminAllowanceChartModel(preview, { mode: "plans", rangeDays: null });
  const focusedPlan = adminAllowanceChartModel(preview, {
    mode: "plans", planFilter: "prolite", rangeDays: null,
  });
  assert.equal(allPlans.dayTicks[0].day, preview.days[10].day);
  assert.equal(allPlans.dayTicks.at(-1).day, preview.days[30].day);
  assert.deepEqual(focusedPlan.dayTicks, allPlans.dayTicks);
  assert.deepEqual(focusedPlan.dollarTicks, allPlans.dollarTicks);
  assert.equal(focusedPlan.activeSeriesKey, "prolite");
  assert.equal(focusedPlan.series[0].points.length, 6);
  assert.ok(focusedPlan.series[0].points[0].x > focusedPlan.plot.left);
  assert.ok(focusedPlan.series[0].points.at(-1).x < focusedPlan.plot.right);

  preview.models.modelConfig.push({ modelId: "gpt-6-astra", label: "GPT-6 Astra" });
  preview.models.days.at(-1).byModel["gpt-6-astra"] = { capacityUsd: 1_500, participantCount: 1 };
  const allModels = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "observed", rangeDays: null });
  const focusedModel = adminAllowanceChartModel(preview, {
    mode: "models", modelFilter: "observed", modelFocus: "gpt-6-astra", rangeDays: null,
  });
  assert.equal(focusedModel.activeModelFocus, "gpt-6-astra");
  assert.equal(focusedModel.activeSeriesKey, "gpt-6-astra");
  assert.deepEqual(focusedModel.series.map(({ key }) => key), ["gpt-6-astra"]);
  assert.deepEqual(focusedModel.legendSeries, allModels.legendSeries);
  assert.deepEqual(focusedModel.dayTicks, allModels.dayTicks);
  assert.deepEqual(focusedModel.dollarTicks, allModels.dollarTicks);
  assert.deepEqual(focusedModel.plot, allModels.plot);
  assert.equal(focusedModel.series[0].points[0].x, focusedModel.plot.right);
  const unrelatedFocus = adminAllowanceChartModel(preview, {
    mode: "models", modelFilter: "gpt-5.6-sol", modelFocus: "gpt-6-astra", rangeDays: null,
  });
  assert.equal(unrelatedFocus.activeModelFocus, null);
  assert.deepEqual(unrelatedFocus.series.map(({ key }) => key), ["gpt-5.6-sol"]);
  for (const modelFocus of ["unknown", "gpt-5.6-luna"]) {
    const invalidFocus = adminAllowanceChartModel(preview, {
      mode: "models", modelFilter: "all", modelFocus, rangeDays: null,
    });
    const unfiltered = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "all", rangeDays: null });
    assert.equal(invalidFocus.activeModelFocus, null);
    assert.equal(invalidFocus.activeSeriesKey, null);
    assert.deepEqual(invalidFocus.series, unfiltered.series);
    assert.deepEqual(invalidFocus.dayTicks, unfiltered.dayTicks);
    assert.deepEqual(invalidFocus.dollarTicks, unfiltered.dollarTicks);
  }
  const unidentified = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "all" })
    .legendSeries.find(({ key }) => key === "gpt-5.6-luna");
  assert.equal(unidentified.hasEvidence, false);
});

test("dense chart markers are thinned but every fitted point and gap remains available for inspection", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreview();
  preview.days[20].combined = emptyAllowanceSummary();
  preview.days[22].combined = emptyAllowanceSummary();
  const model = adminAllowanceChartModel(preview, { mode: "combined", rangeDays: null });
  const series = model.series[0];
  assert.equal(series.points.length, 68);
  assert.deepEqual(series.segments.map((segment) => segment.length), [20, 1, 47]);
  assert.deepEqual(series.markerPoints.map(({ day }) => day), [0, 19, 21, 23, 69].map((index) => preview.days[index].day));
  assert.equal(series.points[1].day, preview.days[1].day);
  assert.equal(series.markerPoints.includes(series.points[1]), false);
  assert.ok(series.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.radius >= 1.6 && point.radius <= 5));
  assert.ok(series.markerPoints.every((point) => series.points.includes(point)));
  const sparse = adminAllowanceChartModel(allowancePreviewWithModels(), { mode: "models", rangeDays: null });
  assert.deepEqual(sparse.series[0].markerPoints, sparse.series[0].points);
});

test("320px chart geometry retains the dollar scale and keeps points, markers and ticks inside its plot", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreview();
  const desktop = adminAllowanceChartModel(preview, { rangeDays: null });
  const narrow = adminAllowanceChartModel(preview, { rangeDays: null, width: 320 });
  assert.equal(narrow.width, 320);
  assert.equal(narrow.height, 300);
  assert.deepEqual(narrow.plot, { top: 16, right: 296, bottom: 266, left: 64 });
  assert.equal(narrow.tickLabelStyle, "day");
  assert.deepEqual(narrow.dollarTicks, desktop.dollarTicks);
  assert.deepEqual(narrow.dayTicks.map(({ day }) => day), ["2026-06-15", "2026-07-08", "2026-07-31", "2026-08-23"]);
  assert.equal(desktop.dayTicks.length, 6);
  assert.equal(narrow.dayTicks[0].day, desktop.dayTicks[0].day);
  assert.equal(narrow.dayTicks.at(-1).day, desktop.dayTicks.at(-1).day);
  assert.equal(narrow.series[0].points.length, 70);
  assert.equal(narrow.series[0].markerPoints.length, 2);
  assert.ok(narrow.dayTicks.every(({ x }) => Number.isFinite(x) && x >= narrow.plot.left && x <= narrow.plot.right));
  assert.ok(narrow.series[0].points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)
    && x >= narrow.plot.left && x <= narrow.plot.right && y >= narrow.plot.top && y <= narrow.plot.bottom));
});

test("allowance preview refuses invalid modes and empty visible evidence", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreview();
  assert.equal(adminAllowanceChartModel(preview, { mode: "other" }), null);
  for (const day of preview.days) {
    for (const plan of preview.plans) {
      day.byPlanType[plan.planType] = {
        fitCount: 0,
        participantCount: 0,
        centralUsd: null,
        band80Usd: null,
      };
    }
  }
  assert.equal(adminAllowanceChartModel(preview, { mode: "plans" }), null);
});

test("allowance preview names the combined uncertainty band precisely", async () => {
  const source = await readFile(
    new URL("../public/admin.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /label\.textContent = "Middle 80% of fitted windows";/u);
  assert.doesNotMatch(source, /label\.textContent = "Plausible range";/u);
});
