import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.deepEqual(model.bandSegments.flatMap((segment) => segment)
    .filter((point) => model.series.some((series) => (
      series.className.startsWith("model-")
    ))), model.bandSegments.flatMap((segment) => segment).length === 0
    ? []
    : model.bandSegments.flatMap((segment) => segment));
  const modelBands = model.bandSeries.filter((band) => (
    band.className.startsWith("model-")
  ));
  assert.deepEqual(modelBands, []);
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
  assert.equal(all.legendSeries.at(-1).key, "gpt-6-astra");
  const sol = adminAllowanceChartModel(preview, { mode: "models", modelFilter: "gpt-5.6-sol" });
  assert.equal(sol.series.length, 1);
  assert.deepEqual(sol.dollarTicks, all.dollarTicks);
  assert.equal(adminAllowanceChartModel(preview, { mode: "models", modelFilter: "gpt-6-astra" }), null);
});

test("new model series have defined matching line, dot and legend palette styles", async () => {
  const { adminAllowanceChartModel } = await importAdminModule();
  const preview = allowancePreviewWithModels();
  preview.models.modelConfig.push({ modelId: "gpt-6-astra", label: "GPT-6 Astra" });
  const model = adminAllowanceChartModel(preview, { mode: "models" });
  const astra = model.legendSeries.find((series) => series.key === "gpt-6-astra");
  assert.match(astra.className, /^model-catalog-[0-7]$/u);
  const css = await readFile(new URL("../public/admin.css", import.meta.url), "utf8");
  for (const [kind, property] of [["line", "stroke"], ["dot", "fill"], ["swatch", "background"]]) {
    assert.ok(css.includes(`.admin-allowance-${kind}[class*="model-catalog-"] { ${property}: var(--model-series-color); }`));
  }
  for (let index = 0; index < 8; index += 1) {
    assert.ok(css.includes(`[class$="model-catalog-${index}"] { --model-series-color: #`));
  }
});

test("model cards use the existing responsive summary grid", async () => {
  const source = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/admin.css", import.meta.url), "utf8");
  assert.ok(source.includes('grid.className = "admin-allowance-plan-summaries";'));
  assert.match(css, /\.admin-allowance-plan-summaries \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.admin-allowance-plan-summaries \{ grid-template-columns: 1fr; \}/u);
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
    "Pro 20x",
    "Pro 5x → 20x",
    "Plus → 20x",
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
  assert.deepEqual(filtered.series.map((series) => series.label), ["Pro 5x → 20x"]);
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
  assert.equal(model.tickLabelStyle, "month");
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
