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

  const timed = sparklineGeometry([
    { at: "2026-08-01", value: 0 },
    { at: "2026-08-02", value: 5 },
    { at: "2026-08-04", value: 10 },
  ]);
  assert.ok(
    timed.coordinates[1].x < 60,
    "a point one day into a three-day span uses true time, not equal spacing",
  );
});

test("audit pagination and native alert topics are bounded and independent", async () => {
  const { auditPageWindow, selectedNotificationAlerts } = await importAdminModule();
  const rows = Array.from({ length: 20 }, (_, index) => ({ index }));
  assert.deepEqual(auditPageWindow(rows, 1).rows.map((row) => row.index), [
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  ]);
  assert.equal(auditPageWindow(rows, 99).page, 1);
  const items = [
    { id: "one", topic: "collection", level: "alert" },
    { id: "two", topic: "evidence", level: "warning" },
    { id: "three", topic: "failures", level: "ok" },
  ];
  assert.deepEqual(
    selectedNotificationAlerts(items, ["evidence"]).map((item) => item.id),
    ["two"],
  );
});

test("history gaps distinguish loading, unavailable evidence, and a new series", async () => {
  const {
    gaugeHistoryIsBounded,
    historyGapLabel,
    isCurrentLoadGeneration,
  } = await importAdminModule();
  assert.equal(historyGapLabel(undefined, null), "Recent history loading…");
  assert.equal(historyGapLabel(null, null), "Recent history unavailable");
  assert.equal(
    historyGapLabel({}, [], false),
    "Recent history not yet recorded",
  );
  assert.equal(
    historyGapLabel({}, [{ at: "2026-08-23", value: 4 }]),
    "1 snapshot · history starts here",
  );
  assert.equal(
    historyGapLabel({}, [{ at: "2026-08-22", value: 3 }, { at: "2026-08-23", value: 4 }]),
    null,
  );
  assert.equal(historyGapLabel({}, [], true), "Recent history unavailable");
  assert.equal(isCurrentLoadGeneration(4, 4), true);
  assert.equal(isCurrentLoadGeneration(3, 4), false);
  assert.equal(gaugeHistoryIsBounded([
    { metrics: { contributingAccountsTotalBounded: 1 } },
    { metrics: { contributingAccountsTotalBounded: 0 } },
  ], "contributingAccountsTotalBounded"), true);
  assert.equal(gaugeHistoryIsBounded([
    { metrics: { contributingAccountsTotalBounded: 0 } },
  ], "contributingAccountsTotalBounded"), false);
});

test("accepted-account card prefers exact cached gauges over bounded upload rows", async () => {
  const { contributingAccountsCardEvidence } = await importAdminModule();
  const boundedOverview = {
    total: 10,
    bounded: true,
    acceptedLast30Days: 8,
  };
  assert.deepEqual(
    contributingAccountsCardEvidence(boundedOverview, [{
      metrics: {
        contributingAccountsTotal: 10,
        contributingAccountsTotalBounded: 0,
      },
    }]),
    {
      total: 10,
      totalBounded: false,
      exact: true,
    },
  );
  assert.deepEqual(
    contributingAccountsCardEvidence(boundedOverview, []),
    {
      total: 10,
      totalBounded: true,
      exact: false,
    },
    "loading or unavailable cache retains the truthful bounded fallback",
  );
});

test("sparkline inspection exposes dated values for pointer and keyboard input", async () => {
  const previousDocument = globalThis.document;
  const documentRef = initDocument();
  globalThis.document = documentRef;
  try {
    const { sparkline } = await importAdminModule();
    const chart = sparkline([
      { at: "2026-08-21", value: 4 },
      { at: "2026-08-22", value: 7 },
      { at: "2026-08-23", value: 9 },
    ], "Approved accounts", String);
    assert.equal(chart.tabIndex, 0, "the chart has one keyboard focus target");
    const [svg, tooltip] = chart.children;
    svg.getBoundingClientRect = () => ({ left: 0, width: 120 });
    chart.listeners.get("pointermove")({ clientX: 2 });
    assert.match(tooltip.textContent, /Aug 21, 2026 · 4/u);
    let prevented = false;
    chart.listeners.get("keydown")({
      key: "End",
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.match(tooltip.textContent, /Aug 23, 2026 · 9/u);
    chart.listeners.get("keydown")({ key: "ArrowLeft", preventDefault() {} });
    assert.match(tooltip.textContent, /Aug 22, 2026 · 7/u);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("alert migration, recurrence reset, blocked recovery, audit reset, and diagnostics classify", async () => {
  const {
    diagnosticReferenceKind,
    nextAuditPaginationState,
    notificationPermissionStatus,
    notificationPreferencesAfterResolution,
    projectNotificationPreferences,
    resetNotificationRecurrence,
  } = await importAdminModule();
  const migrated = projectNotificationPreferences({
    enabled: true,
    repeatMinutes: 15,
    lastFingerprint: "old",
    lastSentAt: 123,
  });
  assert.deepEqual(migrated.topics, ["collection", "maintenance", "evidence", "failures"]);
  assert.deepEqual(
    resetNotificationRecurrence(migrated, { topics: ["failures"] }),
    { ...migrated, topics: ["failures"], lastFingerprint: null, lastSentAt: null },
  );
  assert.deepEqual(
    notificationPreferencesAfterResolution(migrated, []),
    { ...migrated, lastFingerprint: null, lastSentAt: null },
  );
  assert.equal(
    notificationPreferencesAfterResolution(migrated, [{ id: "still-open" }]),
    migrated,
  );
  assert.match(notificationPermissionStatus({ supported: true, permission: "denied" }), /site settings/u);

  const rows = [{ createdAt: "2026-08-23", action: "run_maintenance", outcome: "success" }];
  const first = nextAuditPaginationState({ signature: null, page: 1 }, rows);
  assert.equal(nextAuditPaginationState(first, rows).page, 1, "unchanged refresh preserves page");
  assert.equal(nextAuditPaginationState(first, [...rows, { ...rows[0], createdAt: "2026-08-24" }]).page, 0);

  assert.equal(diagnosticReferenceKind("TT-7QF3K2"), "local");
  assert.equal(diagnosticReferenceKind("TT-ILLEGAL"), "invalid-local");
  assert.equal(
    diagnosticReferenceKind("0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b"),
    "retained",
  );
  assert.equal(diagnosticReferenceKind("019fc0b7-6c19-7b40-bda0-a1a1d7202100"), "invalid");
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
    /GROWTH_SCHEMA_VERSION = "admin-metrics-history-v0\.2"/u,
  );
  assert.match(
    source,
    /async function loadGrowthHistory\(loadGeneration\) \{\n  if \(!isAdminPage\) return;/u,
  );
  assert.match(
    source,
    /isCurrentLoadGeneration\(loadGeneration, state\.loadGeneration\)/u,
  );
  assert.match(
    source,
    /state\.metricsHistory = undefined;\n    render\(overview\);/u,
    "a new overview cannot temporarily reuse the prior refresh's history",
  );
  assert.match(
    source,
    /lookupGeneration = \+\+state\.diagnosticLookupGeneration/u,
    "diagnostic responses are generation-scoped",
  );
  assert.match(
    source,
    /lookupGeneration,\n\s+state\.diagnosticLookupGeneration,/u,
  );
  assert.match(
    source,
    /cloudflareHistoryUnavailable = !cloudflareAvailable[\s\S]*cloudflare\.sampled === true[\s\S]*cloudflare\.bounded === true/u,
    "unavailable or approximate activity evidence cannot look exact",
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
