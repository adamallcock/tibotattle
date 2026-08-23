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
          pro: allowanceSummary(1_900 + index * 2, 2, 2),
          prolite: allowanceSummary(2_150 + index, 2, 2),
          plus: allowanceSummary(1_750 + index * 3, 2, 1),
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
  assert.equal(plans.bandSegments.length, 0);
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
