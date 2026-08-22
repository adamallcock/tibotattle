// Growth & activity section: functional tests of the exported series/geometry
// math, plus source pins for the wiring the DOM harness cannot cheaply reach
// (the admin-site suite runs with isAdminPage=false, which correctly gates the
// growth loader off).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

class InitNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.className = "";
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }
  setAttribute() {}
  getAttribute() {
    return null;
  }
}

// Module-scope initialization touches the page chrome; every selector admin.js
// asks for during import must resolve. The ids mirror the admin-site harness.
function initDocument() {
  const byId = new Map([
    "notice", "operator-attention-badge", "operator-attention", "counts",
    "quarantine-status-badge", "quarantine-counts", "quarantine-status",
    "distribution-status", "distribution-counts", "distribution-version-rows",
    "distribution-version-empty", "distribution-source-status",
    "github-release-rows", "github-release-empty", "service-state",
    "ingress-status", "lifecycle-status", "snapshot-rows", "snapshot-empty",
    "error-groups", "error-empty", "recent-diagnostic-rows",
    "recent-diagnostic-empty", "diagnostic-lookup", "diagnostic-reference",
    "audit-rows", "audit-empty", "last-refresh", "refresh", "diagnostic-form",
    "controls-form", "run-maintenance", "maintenance-result",
    "growth-cards", "growth-status",
  ].map((id) => [id, new InitNode("div")]));
  byId.get("diagnostic-reference").value = "";
  return {
    byId,
    createElement: (tag) => new InitNode(tag),
    createElementNS: (_namespace, tag) => new InitNode(tag),
    createTextNode(value) {
      const node = new InitNode("#text");
      node.textContent = value;
      return node;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) return byId.get(selector.slice(1)) ?? null;
      return null;
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
    json: async () => null,
  });
  globalThis.window = { innerHeight: 844, innerWidth: 390 };
  try {
    const moduleUrl = new URL("../public/admin.js", import.meta.url);
    moduleUrl.search = `?admin-growth-test=${process.hrtime.bigint()}`;
    return await import(moduleUrl.href);
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
}

test("calendar series fills quiet days as zero and cumulative days by carry", async () => {
  const { calendarSeries } = await importAdminModule();
  const byDay = [
    { day: "2026-08-01", count: 3 },
    { day: "2026-08-04", count: 2 },
  ];
  // Per-day counts: a quiet calendar day is a real zero, not a skipped point.
  assert.deepEqual(
    calendarSeries(byDay, "2026-08-06", 0),
    [3, 0, 0, 2, 0, 0],
  );
  // Cumulative counters: a day with no sample keeps the previous total.
  assert.deepEqual(
    calendarSeries(byDay, "2026-08-06", "carry"),
    [3, 3, 3, 2, 2, 2],
  );
  assert.deepEqual(calendarSeries([], "2026-08-06", 0), []);
  // A month boundary is one calendar day, not a gap.
  assert.deepEqual(
    calendarSeries(
      [{ day: "2026-07-31", count: 1 }, { day: "2026-08-01", count: 2 }],
      "2026-08-01",
      0,
    ),
    [1, 2],
  );
});

test("sparkline geometry normalizes into the viewBox and refuses one point", async () => {
  const { sparklineGeometry } = await importAdminModule();
  assert.equal(sparklineGeometry([5]), null);
  assert.equal(sparklineGeometry([]), null);
  const geometry = sparklineGeometry([0, 10]);
  // First point at the left/bottom pad, last at the right/top pad.
  assert.equal(geometry.points, "2.0,26.0 118.0,2.0");
  assert.equal(geometry.endX, "118.0");
  assert.equal(geometry.endY, "2.0");
  // A flat series draws a level line rather than dividing by zero.
  const flat = sparklineGeometry([4, 4, 4]);
  assert.ok(flat.points.split(" ").every((point) => point.endsWith(",26.0")));
});

test("the growth loader wiring stays pinned to the metrics-history contract", async () => {
  const source = await readFile(
    new URL("../public/admin.js", import.meta.url),
    "utf8",
  );
  // The loader fetches the registered route, validates the schema version,
  // and stays gated off outside the admin page.
  assert.match(source, /request\("\/api\/v1\/admin\/metrics\/history"\)/u);
  assert.match(
    source,
    /GROWTH_SCHEMA_VERSION = "admin-metrics-history-v0\.1"/u,
  );
  assert.match(
    source,
    /async function loadGrowthHistory\(\) \{\n  if \(!isAdminPage\) return;/u,
  );
  // Every growth card label carries an operator tooltip: a label missing from
  // INFO_HINTS renders silently without one, so the coverage is pinned here.
  const hintKeys = new Set(
    [...source.matchAll(/^ {2}"([^"]+)":/gmu)].map((match) => match[1]),
  );
  const growthLabels = [
    ...[...source.matchAll(/eventGrowthCard\("([^"]+)"/gu)].map((m) => m[1]),
    ...[...source.matchAll(/growthCard\(\{\s*\n\s*label: "([^"]+)"/gu)]
      .map((m) => m[1]),
  ];
  assert.ok(growthLabels.length >= 10, "growth card labels are discoverable");
  for (const label of growthLabels) {
    assert.ok(hintKeys.has(label), `INFO_HINTS is missing: ${label}`);
  }

  // The dedicated per-plan card is built directly (not via growthCard), so its
  // label and hint are pinned explicitly.
  assert.match(source, /function growthPlanCohortCard\(snapshots\)/u);
  assert.match(source, /labelWithInfo\("Plan cohorts"\)/u);
  assert.ok(hintKeys.has("Plan cohorts"), "INFO_HINTS is missing: Plan cohorts");
  // It reads both gauge families and attributes each person once.
  assert.match(source, /cohortParticipants_/u);
  assert.match(source, /cohortMedianUsd_/u);
});
