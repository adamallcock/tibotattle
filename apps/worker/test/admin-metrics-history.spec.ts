import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
  captureAdminMetricSnapshot,
  readAdminMetricsHistory,
} from "../src/admin-metrics-history";

interface TestBindings {
  USAGE_MONITOR_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
});

describe("admin metric snapshots", () => {
  it("captures hourly and refuses to double-write inside the interval", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    const first = await captureAdminMetricSnapshot(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    );
    expect(first.code).toBe("SNAPSHOT_CAPTURED");
    // Ten minutes later the capture stands aside; 56 minutes later it runs.
    const early = await captureAdminMetricSnapshot(
      bindings.USAGE_MONITOR_DB,
      nowEpoch + 10 * 60 * 1_000,
    );
    expect(early.code).toBe("SNAPSHOT_CURRENT");
    const due = await captureAdminMetricSnapshot(
      bindings.USAGE_MONITOR_DB,
      nowEpoch + 56 * 60 * 1_000,
    );
    expect(due.code).toBe("SNAPSHOT_CAPTURED");
    const rows = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM admin_metric_snapshots",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it("stores content-free numeric gauges for an empty service", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    await captureAdminMetricSnapshot(bindings.USAGE_MONITOR_DB, nowEpoch);
    const row = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT metrics_json FROM admin_metric_snapshots",
    ).first<{ metrics_json: string }>();
    const metrics = JSON.parse(row?.metrics_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      quarantinePendingObjects: 0,
      corpusChunks: 0,
      corpusCurrentChunks: 0,
      corpusCurrentRecords: 0,
      participantsTotal: 0,
      participantsActive: 0,
    });
    for (const value of Object.values(metrics)) {
      expect(typeof value).toBe("number");
    }
  });
});

describe("admin metrics history read", () => {
  it("serves the full shape on an empty service", async () => {
    const history = await readAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      Date.parse("2026-08-21T12:00:00.000Z"),
    );
    expect(history.schemaVersion).toBe(ADMIN_METRICS_HISTORY_SCHEMA_VERSION);
    for (const series of Object.values(history.events)) {
      expect(series).toMatchObject({
        total: 0,
        last24Hours: 0,
        previous24Hours: 0,
        byDay: [],
      });
    }
    // Migration 0037 exists in the test database, so the download series is
    // available and empty rather than absent.
    expect(history.downloads).toEqual({ available: true, byDay: [] });
    expect(history.gauges.snapshots).toEqual([]);
  });

  it("round-trips gauge snapshots and drops non-numeric values", async () => {
    await bindings.USAGE_MONITOR_DB.prepare(
      `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
       VALUES (?, ?)`,
    ).bind(
      "2026-08-21T11:00:00.000Z",
      JSON.stringify({
        bandParticipantCount: 1,
        cohortParticipants_pro: 1,
        smuggled: "not-a-number",
      }),
    ).run();
    const history = await readAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      Date.parse("2026-08-21T12:00:00.000Z"),
    );
    expect(history.gauges.snapshots).toEqual([{
      capturedAt: "2026-08-21T11:00:00.000Z",
      metrics: { bandParticipantCount: 1, cohortParticipants_pro: 1 },
    }]);
  });

  it("keeps full-span history while downsampling old snapshots to daily", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1_000;
    const insert = bindings.USAGE_MONITOR_DB.prepare(
      `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
       VALUES (?, ?)`,
    );
    // Two snapshots on an old day, two inside the full-resolution horizon.
    const oldDay = new Date(nowEpoch - 20 * day);
    const recent = new Date(nowEpoch - 2 * 60 * 60 * 1_000);
    const stamps = [
      new Date(oldDay.getTime() - 60 * 60 * 1_000).toISOString(),
      oldDay.toISOString(),
      new Date(recent.getTime() - 60 * 60 * 1_000).toISOString(),
      recent.toISOString(),
    ];
    for (const [index, capturedAt] of stamps.entries()) {
      await insert.bind(capturedAt, JSON.stringify({ value: index })).run();
    }
    const history = await readAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    );
    // The old day keeps only its last snapshot; the recent hours keep both.
    expect(history.gauges.snapshots.map((snapshot) => snapshot.capturedAt))
      .toEqual([stamps[1], stamps[2], stamps[3]]);
  });
});
