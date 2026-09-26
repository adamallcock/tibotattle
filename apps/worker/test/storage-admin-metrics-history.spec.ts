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
      "SELECT COUNT(*) AS n FROM analytics_admin_metrics_history_publications",
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
    expect(targetQueries[0]).toContain("FROM analytics_admin_metrics_history_publications");
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

  it("refuses fresh v0.2 totals because they omit v1.2 uploads", async () => {
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const current = await readCachedStorageAdminMetricsHistory(storage(), now);
    const older = JSON.stringify({
      ...current,
      schemaVersion: "admin-metrics-history-v0.2",
    });
    await target().prepare(
      "DELETE FROM analytics_admin_metrics_history_publications WHERE source_id=?",
    ).bind(sourceId).run();
    await target().batch([
      target().prepare(
        `INSERT INTO analytics_admin_metrics_history_publications(
           source_id,schema_version,generated_at,payload_json
         ) VALUES(?1,?2,?3,?4)`,
      ).bind(sourceId, "admin-metrics-history-v0.2", current.generatedAt, older),
      target().prepare(
        `INSERT INTO analytics_admin_metrics_history_cache(
           source_id,generated_at,payload_json
         ) VALUES(?1,?2,?3)`,
      ).bind(sourceId, current.generatedAt, older),
    ]);
    await expect(readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .rejects.toMatchObject({ code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now + 1_000))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    expect((await readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .schemaVersion).toBe("admin-metrics-history-v0.3");
  });

  it("keeps other contracts' publications and serves only its own", async () => {
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const current = await readCachedStorageAdminMetricsHistory(storage(), now);
    // Rows an older scheduler and a newer one (then rolled back) left behind.
    for (const schemaVersion of [
      "admin-metrics-history-v0.2",
      "admin-metrics-history-v0.4",
    ]) {
      await target().prepare(
        `INSERT INTO analytics_admin_metrics_history_publications(
           source_id,schema_version,generated_at,payload_json
         ) VALUES(?1,?2,?3,?4)`,
      ).bind(
        sourceId,
        schemaVersion,
        current.generatedAt,
        JSON.stringify({ ...current, schemaVersion }),
      ).run();
    }
    const otherContracts = async () => (await target().prepare(
      `SELECT schema_version,generated_at,payload_json
         FROM analytics_admin_metrics_history_publications
        WHERE source_id=? AND schema_version<>'admin-metrics-history-v0.3'
        ORDER BY schema_version`,
    ).bind(sourceId).all()).results;
    const before = await otherContracts();
    expect(before).toHaveLength(2);

    const due = now + 56 * 60 * 1_000;
    expect(await warmStorageAdminMetricsHistoryCache(storage(), due))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    expect(await otherContracts()).toEqual(before);
    expect(await readCachedStorageAdminMetricsHistory(storage(), due))
      .toMatchObject({
        schemaVersion: "admin-metrics-history-v0.3",
        generatedAt: new Date(due).toISOString(),
      });

    // Without its own publication the reader refuses the other contracts.
    await target().prepare(
      `DELETE FROM analytics_admin_metrics_history_publications
        WHERE source_id=? AND schema_version='admin-metrics-history-v0.3'`,
    ).bind(sourceId).run();
    await expect(readCachedStorageAdminMetricsHistory(storage(), due))
      .rejects.toMatchObject({
        status: 503,
        code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
      });
  });

  it("serves the 0016 row only while it carries this reader's contract", async () => {
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const current = await readCachedStorageAdminMetricsHistory(storage(), now);
    // A reader deployed before its writer finds only the source-keyed row.
    await target().prepare(
      "DELETE FROM analytics_admin_metrics_history_publications WHERE source_id=?",
    ).bind(sourceId).run();
    const writeSourceKeyedRow = (payload: object) => target().prepare(
      `INSERT INTO analytics_admin_metrics_history_cache(
         source_id,generated_at,payload_json
       ) VALUES(?1,?2,?3)
       ON CONFLICT(source_id) DO UPDATE SET
         generated_at=excluded.generated_at,payload_json=excluded.payload_json`,
    ).bind(sourceId, current.generatedAt, JSON.stringify(payload)).run();

    await writeSourceKeyedRow(current);
    expect(await readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .toEqual(current);
    await writeSourceKeyedRow({
      ...current,
      schemaVersion: "admin-metrics-history-v0.2",
    });
    await expect(readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .rejects.toMatchObject({
        status: 503,
        code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
      });

    // Once this contract's publication exists it wins over the fallback.
    await writeSourceKeyedRow(current);
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now + 1_000))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    expect((await readCachedStorageAdminMetricsHistory(storage(), now + 1_000))
      .generatedAt).toBe(new Date(now + 1_000).toISOString());
  });

  it("binds each publication row to the contract and time its payload declares", async () => {
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const current = await readCachedStorageAdminMetricsHistory(storage(), now);
    const insert = (schemaVersion: string, generatedAt: string, payloadJson: string) =>
      target().prepare(
        `INSERT INTO analytics_admin_metrics_history_publications(
           source_id,schema_version,generated_at,payload_json
         ) VALUES(?1,?2,?3,?4)`,
      ).bind(sourceId, schemaVersion, generatedAt, payloadJson).run();
    const payload = JSON.stringify(current);
    await expect(insert("admin-metrics-history-v0.2", current.generatedAt, payload))
      .rejects.toThrow(/CHECK constraint failed/u);
    await expect(insert("admin-metrics-history-v0.4", new Date(now + 1).toISOString(),
      JSON.stringify({ ...current, schemaVersion: "admin-metrics-history-v0.4" })))
      .rejects.toThrow(/CHECK constraint failed/u);
    await expect(insert("admin-metrics-history-v0.4", current.generatedAt, "{"))
      .rejects.toThrow(/CHECK constraint failed/u);
    await expect(target().prepare(
      `INSERT INTO analytics_admin_metrics_history_publications(
         source_id,schema_version,generated_at,payload_json
       ) VALUES('unregistered-source',?1,?2,?3)`,
    ).bind(current.schemaVersion, current.generatedAt, payload).run())
      .rejects.toThrow(/FOREIGN KEY constraint failed/u);
  });

  it("leaves the row an older reader serves untouched when the writer upgrades", async () => {
    // Production, 2026-09-25: the scheduler began writing v0.3 while the main
    // Worker still read only v0.2. Replacing the single source-keyed row left
    // that reader with nothing it accepted until the main Worker was deployed.
    expect(await captureStorageAdminMetricSnapshot(storage(), now))
      .toEqual({ code: "SNAPSHOT_CAPTURED" });
    expect(await warmStorageAdminMetricsHistoryCache(storage(), now))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const current = await readCachedStorageAdminMetricsHistory(storage(), now);
    const olderReaderRow = {
      generated_at: current.generatedAt,
      payload_json: JSON.stringify({
        ...current,
        schemaVersion: "admin-metrics-history-v0.2",
      }),
    };
    // The state an upgraded scheduler meets on its first pass: only the
    // older contract's source-keyed row exists.
    await target().prepare(
      "DELETE FROM analytics_admin_metrics_history_publications WHERE source_id=?",
    ).bind(sourceId).run();
    await target().prepare(
      `INSERT INTO analytics_admin_metrics_history_cache(
         source_id,generated_at,payload_json
       ) VALUES(?1,?2,?3)
       ON CONFLICT(source_id) DO UPDATE SET
         generated_at=excluded.generated_at,payload_json=excluded.payload_json`,
    ).bind(sourceId, olderReaderRow.generated_at, olderReaderRow.payload_json).run();

    expect(await warmStorageAdminMetricsHistoryCache(storage(), now + 1_000))
      .toEqual({ code: "HISTORY_CACHE_REFRESHED" });

    expect(await target().prepare(
      "SELECT generated_at,payload_json FROM analytics_admin_metrics_history_cache WHERE source_id=?",
    ).bind(sourceId).first()).toEqual(olderReaderRow);
    const upgraded = await readCachedStorageAdminMetricsHistory(storage(), now + 1_000);
    expect(upgraded.schemaVersion).toBe("admin-metrics-history-v0.3");
    expect(upgraded.generatedAt).toBe(new Date(now + 1_000).toISOString());
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

    const publication = () => target().prepare(
      `SELECT generated_at,payload_json FROM analytics_admin_metrics_history_publications
        WHERE source_id=? AND schema_version='admin-metrics-history-v0.3'`,
    ).bind(sourceId).first<{ generated_at: string; payload_json: string }>();
    const before = await publication();
    expect(before).not.toBeNull();
    const failedSource = { prepare() { throw new Error("synthetic source failure"); } } as unknown as D1Database;
    expect(await warmStorageAdminMetricsHistoryCache(
      { ...storage(), source: failedSource },
      now + 56 * 60 * 1_000,
    )).toEqual({ code: "HISTORY_CACHE_UNAVAILABLE" });
    await expect(publication()).resolves.toEqual(before);
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
