import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeStorageSource } from "../src/analytics-delivery";
import {
  captureStorageAdminMetricSnapshot,
  readCachedStorageAdminMetricsHistory,
  warmStorageAdminMetricsHistoryCache,
} from "../src/admin-metrics-history";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { readStorageAdminOverview } from "../src/storage-admin-overview";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";

interface Bindings extends Env {
  STORAGE_ANALYTICS_DB: D1Database;
  STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
}

const bindings = env as Bindings;
const source = () => bindings.USAGE_MONITOR_DB;
const target = () => bindings.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-admin-history-source";
const sourceNamespace = "synthetic-admin-history-namespace";
const storage = () => ({
  source: source(),
  target: target(),
  sourceId,
  sourceNamespace,
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await initializeTypedV1Admission(source(), sourceNamespace);
  await initializeTypedV11Admission(source(), sourceNamespace);
  await initializeStorageAnalyticsRuntime(storage());
});

async function insertParticipant(id: string, createdAt: string): Promise<void> {
  await source().prepare(
    `INSERT INTO participants(
       id,access_token_id,access_token_hash,recovery_token_id,
       recovery_token_hash,state,consent_version,consented_at,created_at
     ) VALUES(?,?,?,?,?,'active',?,?,?)`,
  ).bind(
    id,
    `${id}-access`,
    new Uint8Array(32),
    `${id}-recovery`,
    new Uint8Array(32),
    "privacy-safe-telemetry-v0.1",
    createdAt,
    createdAt,
  ).run();
}

describe("typed-storage admin metrics history", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");

  it("keeps a fresh target unavailable until a real typed snapshot exists", async () => {
    await expect(readCachedStorageAdminMetricsHistory(
      { ...storage(), target: bindings.STORAGE_INGESTION_A },
      now,
    )).rejects.toMatchObject({
      status: 503,
      code: "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE",
    });
    await expect(readCachedStorageAdminMetricsHistory(storage(), now))
      .rejects.toMatchObject({
        status: 503,
        code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
      });
    await expect(warmStorageAdminMetricsHistoryCache(storage(), now))
      .resolves.toEqual({ code: "HISTORY_CACHE_UNAVAILABLE" });
    expect(await target().prepare(
      "SELECT COUNT(*) AS n FROM analytics_admin_metrics_history_cache",
    ).first<number>("n")).toBe(0);
  });

  it("writes source-keyed target aggregates and reconstructs retained events", async () => {
    await insertParticipant("typed-history-owner", "2026-09-14T10:00:00.000Z");
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });

    expect(await source().prepare(
      "SELECT COUNT(*) AS n FROM admin_metric_snapshots",
    ).first<number>("n")).toBe(0);
    expect(await source().prepare(
      "SELECT COUNT(*) AS n FROM admin_metrics_history_cache",
    ).first<number>("n")).toBe(0);
    expect(await target().prepare(
      "SELECT COUNT(*) AS n FROM analytics_admin_metric_snapshots WHERE source_id=?",
    ).bind(sourceId).first<number>("n")).toBe(1);

    const history = await readCachedStorageAdminMetricsHistory(storage(), now + 1_000);
    expect(history.events.participants).toMatchObject({
      total: 1,
      last24Hours: 1,
      byDay: [{ day: "2026-09-14", count: 1 }],
    });
    expect(history.gauges.snapshots).toEqual([expect.objectContaining({
      capturedAt: "2026-09-14T12:00:00.000Z",
      metrics: expect.objectContaining({ participantsTotal: 1 }),
    })]);
    const targetQueries: string[] = [];
    const cacheOnlyTarget = new Proxy(target(), {
      get(base, property) {
        if (property === "prepare") return (sql: string) => {
          targetQueries.push(sql);
          return base.prepare(sql);
        };
        const value: unknown = Reflect.get(base, property);
        return typeof value === "function" ? value.bind(base) : value;
      },
    });
    await readCachedStorageAdminMetricsHistory(
      { ...storage(), target: cacheOnlyTarget },
      now + 1_000,
    );
    expect(targetQueries).toHaveLength(1);
    expect(targetQueries[0]).toContain("FROM analytics_admin_metrics_history_cache");
    expect(targetQueries[0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/iu);
  });

  it("self-throttles before source scans and isolates registered sources", async () => {
    expect((await captureStorageAdminMetricSnapshot(storage(), now)).code)
      .toBe("SNAPSHOT_CAPTURED");
    const sourceQueries: string[] = [];
    const observedSource = new Proxy(source(), {
      get(base, property) {
        if (property === "prepare") return (sql: string) => {
          sourceQueries.push(sql);
          return base.prepare(sql);
        };
        const value: unknown = Reflect.get(base, property);
        return typeof value === "function" ? value.bind(base) : value;
      },
    });
    expect(await captureStorageAdminMetricSnapshot(
      { ...storage(), source: observedSource },
      now + 10 * 60 * 1_000,
    )).toEqual({ code: "SNAPSHOT_CURRENT" });
    expect(sourceQueries).toHaveLength(1);
    expect(sourceQueries[0]).toContain("FROM storage_source_state");
    expect(sourceQueries[0]).not.toMatch(
      /FROM (?:participants|telemetry_v1_chunks|telemetry_contributions)/u,
    );

    await expect(readCachedStorageAdminMetricsHistory(
      { ...storage(), sourceId: "other-registered-source" },
      now,
    )).rejects.toMatchObject({
      status: 503,
      code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
    });
  });

  it("rebuilds a fresh v0.2 cache because it omits v1.2 uploads", async () => {
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const row = await target().prepare(
      "SELECT payload_json FROM analytics_admin_metrics_history_cache WHERE source_id=?",
    ).bind(sourceId).first<string>("payload_json");
    const old = JSON.parse(row ?? "null") as { schemaVersion: string };
    old.schemaVersion = "admin-metrics-history-v0.2";
    await target().prepare(
      "UPDATE analytics_admin_metrics_history_cache SET payload_json=? WHERE source_id=?",
    ).bind(JSON.stringify(old), sourceId).run();
    await expect(readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .rejects.toMatchObject({ code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now + 1_000))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
  });

  it("keeps bounded source SQL and preserves an older cache on refresh failure", async () => {
    const statements: string[] = [];
    const observedSource = new Proxy(source(), {
      get(base, property) {
        if (property === "prepare") return (sql: string) => {
          statements.push(sql);
          return base.prepare(sql);
        };
        const value: unknown = Reflect.get(base, property);
        return typeof value === "function" ? value.bind(base) : value;
      },
    });
    const observed = { ...storage(), source: observedSource };
    expect((await captureStorageAdminMetricSnapshot(observed, now)).code)
      .toBe("SNAPSHOT_CAPTURED");
    expect(await warmStorageAdminMetricsHistoryCache(observed, now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const compactHeaderStatements = statements.filter(sql => (
      sql.includes("FROM telemetry_v11_chunks")
      && sql.includes("FROM telemetry_v1_chunks")
    ));
    expect(compactHeaderStatements.length).toBeGreaterThan(0);
    expect(compactHeaderStatements.every(sql => (
      !sql.includes("typed_telemetry_records")
    ))).toBe(true);
    const boundedStatements = statements.filter(sql => (
      /FROM (?:participants|web_sessions|device_pairings|device_credentials|telemetry_contributions)/u.test(sql)
      && !sql.includes("FROM telemetry_v11_chunks")
    ));
    expect(boundedStatements.length).toBeGreaterThan(0);
    expect(boundedStatements.every(sql => sql.includes("LIMIT 10001"))).toBe(true);

    const before = await target().prepare(
      "SELECT generated_at,payload_json FROM analytics_admin_metrics_history_cache WHERE source_id=?",
    ).bind(sourceId).first<{ generated_at: string; payload_json: string }>();
    const failedSource = { prepare() { throw new Error("synthetic source failure"); } } as unknown as D1Database;
    expect(await warmStorageAdminMetricsHistoryCache(
      { ...storage(), source: failedSource },
      now + 56 * 60 * 1_000,
    )).toEqual({ code: "HISTORY_CACHE_UNAVAILABLE" });
    await expect(target().prepare(
      "SELECT generated_at,payload_json FROM analytics_admin_metrics_history_cache WHERE source_id=?",
    ).bind(sourceId).first()).resolves.toEqual(before);
  });

  it("refuses an exact gauge when the operational source bound is exceeded", async () => {
    await source().prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<10001
       )
       INSERT INTO participants(
         id,access_token_id,access_token_hash,recovery_token_id,
         recovery_token_hash,state,consent_version,consented_at,created_at
       )
       SELECT 'bounded-'||value,'access-'||value,zeroblob(32),
              'recovery-'||value,zeroblob(32),'active',
              'privacy-safe-telemetry-v0.1','2026-09-14T10:00:00.000Z',
              '2026-09-14T10:00:00.000Z'
         FROM sequence`,
    ).run();
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_UNAVAILABLE" });
    expect(await target().prepare(
      "SELECT COUNT(*) AS n FROM analytics_admin_metric_snapshots",
    ).first<number>("n")).toBe(0);
  });

  it("refuses incomplete v1.2 schema rather than showing a partial zero", async () => {
    await source().prepare("CREATE TABLE telemetry_v12_runtime (id INTEGER PRIMARY KEY)").run();
    await expect(readStorageAdminOverview(storage(), now)).rejects.toMatchObject({
      status: 503, code: "BACKEND_STORAGE_UNAVAILABLE",
    });
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_UNAVAILABLE" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_UNAVAILABLE" });
  });
});
