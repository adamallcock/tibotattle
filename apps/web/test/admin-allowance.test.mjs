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

function fittedModelSummary(
  centralUsd,
  contributingParticipantCount = 3,
  eligibleParticipantCount = 4,
  apiCostShare = 0.5,
) {
  return {
    status: "fitted",
    contributingParticipantCount,
    eligibleParticipantCount,
    observationCount: 500,
    apiCostShare,
    centralUsd,
    band80Usd: null,
  };
}

function unavailableModelSummary() {
  return {
    status: "insufficient_evidence",
    contributingParticipantCount: 0,
    eligibleParticipantCount: 2,
    observationCount: 37,
    apiCostShare: 0.008,
    centralUsd: null,
    band80Usd: null,
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
    models: [
      { modelId: "gpt-5.6-sol" },
      { modelId: "gpt-5.6-terra" },
      { modelId: "gpt-5.6-luna" },
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
        byModelId: {
          "gpt-5.6-sol": fittedModelSummary(2_400 + index * 2),
          "gpt-5.6-terra": fittedModelSummary(
            1_080 + index,
            2,
            3,
            0.19,
          ),
          "gpt-5.6-luna": unavailableModelSummary(),
        },
      };
    }),
  };
}

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
  const models = adminAllowanceChartModel(preview, {
    mode: "model",
    rangeDays: 30,
  });

  assert.equal(combined.series.length, 1);
  assert.equal(combined.series[0].label, "Combined");
  assert.equal(combined.series[0].points.length, 30);
  assert.equal(combined.bandSegments.length, 1);
  assert.equal(combined.bandSegments[0].length, 30);

  assert.deepEqual(plans.series.map((series) => series.label), [
    "Pro 20x",
    "ProLite → Pro 20x",
    "Plus → 20x",
  ]);
  assert.ok(plans.series.every((series) => series.points.length === 30));
  assert.deepEqual(plans.dollarTicks, combined.dollarTicks);
  assert.deepEqual(plans.dayTicks, combined.dayTicks);
  assert.deepEqual(plans.plot, combined.plot);
  assert.equal(plans.bandSeries.length, 3);
  assert.ok(plans.bandSeries.every((band) => band.segments[0].length === 30));
  assert.equal(plans.bandSegments.length, 3);
  assert.deepEqual(models.series.map((series) => series.label), [
    "GPT-5.6 Sol",
    "GPT-5.6 Terra",
    "GPT-5.6 Luna",
  ]);
  assert.deepEqual(models.series.map((series) => series.className), [
    "model-0",
    "model-1",
    "model-2",
  ]);
  assert.deepEqual(models.series.map((series) => series.points.length), [30, 30, 0]);
  assert.deepEqual(
    Object.keys(models.series[0].points[0]).sort(),
    ["day", "value", "x", "y"],
  );
  assert.deepEqual(models.dollarTicks, combined.dollarTicks);
  assert.deepEqual(models.dollarTicks, plans.dollarTicks);
  assert.deepEqual(models.dayTicks, combined.dayTicks);
  assert.deepEqual(models.plot, combined.plot);
  assert.deepEqual(models.bandSeries, []);
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
  assert.deepEqual(
    filtered.series.map((series) => series.label),
    ["ProLite → Pro 20x"],
  );
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

test("allowance model filter is separate and keeps unavailable models honest", async () => {
  const {
    adminAllowanceChartModel,
    toggleAdminAllowanceModelFilter,
  } = await importAdminModule();
  const preview = allowancePreview();
  const allModels = adminAllowanceChartModel(preview, {
    mode: "model",
    rangeDays: 30,
  });
  const luna = adminAllowanceChartModel(preview, {
    mode: "model",
    modelFilter: "gpt-5.6-luna",
    planFilter: "pro",
    rangeDays: 30,
  });

  assert.equal(luna.activeModelFilter, "gpt-5.6-luna");
  assert.equal(luna.activePlanFilter, null);
  assert.equal(luna.visibleValueCount, 0);
  assert.equal(luna.series.length, 1);
  assert.deepEqual(luna.series[0].points, []);
  assert.deepEqual(luna.legendSeries.map((series) => series.key), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  assert.deepEqual(luna.dollarTicks, allModels.dollarTicks);
  assert.equal(
    toggleAdminAllowanceModelFilter(null, "gpt-5.6-sol", preview.models),
    "gpt-5.6-sol",
  );
  assert.equal(
    toggleAdminAllowanceModelFilter("gpt-5.6-sol", "gpt-5.6-sol", preview.models),
    null,
  );
  assert.equal(
    toggleAdminAllowanceModelFilter("gpt-5.6-sol", "unknown", preview.models),
    null,
  );
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

test("allowance preview keeps model values concise and names plan normalization", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../public/admin.js", import.meta.url), "utf8"),
    readFile(new URL("../public/admin.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /label\.textContent = "Middle 80% of fitted windows";/u);
  assert.doesNotMatch(source, /label\.textContent = "Plausible range";/u);
  assert.match(
    source,
    /Equivalent Pro 20x API value if all usage were \$\{modelName\}\./u,
  );
  assert.match(
    source,
    /Each point is the Pro 20x-equivalent API value if all usage were that model\./u,
  );
  assert.match(
    source,
    /Plan normalization: Pro ×1 · ProLite ×4 · Plus ×20\./u,
  );
  assert.match(source, /state\.allowanceMode === "model"\s*\? "Unavailable"/u);
  assert.match(source, /empty\.textContent = "Unavailable";/u);
  assert.doesNotMatch(source, /Qualification:/u);
  assert.doesNotMatch(source, /Aggregation:/u);
  assert.doesNotMatch(source, /evidence halves/u);
  assert.doesNotMatch(source, /observations?/iu);
  assert.doesNotMatch(source, /contributing account/u);
  assert.doesNotMatch(source, /model-using account/u);
  assert.doesNotMatch(source, /API-cost share/u);
  assert.doesNotMatch(source, /Sensitivity band/u);
  assert.doesNotMatch(source, /Source corpus:/u);
  assert.doesNotMatch(source, /Speed: Model values/u);
  assert.doesNotMatch(source, /ADMIN_ALLOWANCE_MODEL_STATUS_REASONS/u);
  assert.match(styles, /\.admin-allowance-line-model-1[^}]*stroke-dasharray: 8 5/u);
  assert.match(styles, /\.admin-allowance-line-model-2[^}]*stroke-dasharray: 2 5/u);
});
