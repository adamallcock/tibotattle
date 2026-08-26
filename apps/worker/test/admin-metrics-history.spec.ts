import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
  captureAdminMetricSnapshot,
  computeCohortGauges,
  readAdminMetricsHistory,
  readCachedAdminMetricsHistory,
  warmAdminMetricsHistoryCache,
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

async function insertParticipant(
  id: string,
  createdAt: string,
): Promise<void> {
  await bindings.USAGE_MONITOR_DB.prepare(
    `INSERT INTO participants (
       id, access_token_id, access_token_hash, recovery_token_id,
       recovery_token_hash, state, consent_version, consented_at, created_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
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
      contributingAccountsTotal: 0,
      contributingAccountsTotalBounded: 0,
      quarantinePendingObjectsBounded: 0,
      quarantineWithinGrace: 0,
      quarantineDueReferenced: 0,
      quarantineDueUnreferenced: 0,
    });
    for (const value of Object.values(metrics)) {
      expect(typeof value).toBe("number");
    }
  });

  it("marks capped quarantine gauges instead of storing false exact counts", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    const db = bindings.USAGE_MONITOR_DB;
    await db.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 10001
       )
       INSERT INTO pending_quarantine_objects (
         r2_key, contribution_id, object_kind, registered_at
       )
       SELECT 'telemetry/bounded-' || value,
              'bounded-' || value,
              'telemetry',
              '2026-08-21T11:30:00.000Z'
         FROM sequence`,
    ).run();

    expect((await captureAdminMetricSnapshot(db, nowEpoch)).code)
      .toBe("SNAPSHOT_CAPTURED");
    const row = await db.prepare(
      "SELECT metrics_json FROM admin_metric_snapshots",
    ).first<{ metrics_json: string }>();
    expect(JSON.parse(row?.metrics_json ?? "{}")).toMatchObject({
      quarantinePendingObjects: 10000,
      quarantineWithinGrace: 10000,
      quarantinePendingObjectsBounded: 1,
    });
  });

  it("captures participant and quarantine card states in the shared snapshot", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    const db = bindings.USAGE_MONITOR_DB;
    await db.batch([
      db.prepare(
        `INSERT INTO participants (
          id, access_token_id, access_token_hash, recovery_token_id,
          recovery_token_hash, state, consent_version, consented_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(
        "history-participant",
        "history-access",
        new Uint8Array(32),
        "history-recovery",
        new Uint8Array(32),
        "privacy-safe-telemetry-v0.1",
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ),
      db.prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES (?, ?, 'telemetry', ?)`,
      ).bind(
        "telemetry/history-recent",
        "history-recent",
        "2026-08-21T11:30:00.000Z",
      ),
      db.prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES (?, ?, 'telemetry', ?)`,
      ).bind(
        "telemetry/history-due",
        "history-due",
        "2026-08-21T09:00:00.000Z",
      ),
    ]);

    expect((await captureAdminMetricSnapshot(db, nowEpoch)).code)
      .toBe("SNAPSHOT_CAPTURED");
    const row = await db.prepare(
      "SELECT metrics_json FROM admin_metric_snapshots",
    ).first<{ metrics_json: string }>();
    expect(JSON.parse(row?.metrics_json ?? "{}")).toMatchObject({
      participantsTotal: 1,
      participantsActive: 1,
      contributingAccountsTotal: 0,
      quarantinePendingObjects: 2,
      quarantineWithinGrace: 1,
      quarantineDueReferenced: 0,
      quarantineDueUnreferenced: 1,
    });
  });
});

describe("cohort gauges", () => {
  const nowEpoch = Date.parse("2026-08-21T20:00:00.000Z");
  const nano = (usd: number) => usd * 1e9;

  it("attributes a plan-switcher to one cohort, not one per label", () => {
    // The real 2026-08-21 shape: one account whose retained history carries
    // plus, prolite, and unknown fits (plan evolution + unstamped records).
    // Their most recent qualifying fit is prolite, so they are one prolite
    // person — never counted three times.
    const switcher = JSON.stringify([
      { planType: "unknown", capacityNanousd: nano(150), lastObservedAt: "2026-07-31T00:00:00.000Z" },
      { planType: "plus", capacityNanousd: nano(122), lastObservedAt: "2026-08-05T00:00:00.000Z" },
      { planType: "prolite", capacityNanousd: nano(684), lastObservedAt: "2026-08-21T06:00:00.000Z" },
    ]);
    // A pure pro account (the owner).
    const pro = JSON.stringify([
      { planType: "pro", capacityNanousd: nano(2043), lastObservedAt: "2026-08-19T00:00:00.000Z" },
    ]);
    const gauges = computeCohortGauges([switcher, pro], nowEpoch);
    // Two people, each under exactly one plan: prolite (current) and pro.
    expect(gauges.cohortParticipants_prolite).toBe(1);
    expect(gauges.cohortParticipants_pro).toBe(1);
    expect(gauges.cohortParticipants_plus).toBeUndefined();
    expect(gauges.cohortParticipants_unknown).toBeUndefined();
    // Median capacity pools by label regardless of who is "on" the plan, so
    // every era the switcher observed still reports its own window size.
    expect(gauges.cohortMedianUsd_plus).toBe(122);
    expect(gauges.cohortMedianUsd_prolite).toBe(684);
    expect(gauges.cohortMedianUsd_unknown).toBe(150);
    expect(gauges.cohortMedianUsd_pro).toBe(2043);
  });

  it("drops fits observed before the trailing window", () => {
    const stale = JSON.stringify([
      { planType: "pro", capacityNanousd: nano(2000), lastObservedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(computeCohortGauges([stale], nowEpoch)).toEqual({});
  });

  it("survives corrupt and empty rows", () => {
    const good = JSON.stringify([
      { planType: "pro", capacityNanousd: nano(2000), lastObservedAt: "2026-08-20T00:00:00.000Z" },
    ]);
    const gauges = computeCohortGauges(["not json", "[]", good], nowEpoch);
    expect(gauges.cohortParticipants_pro).toBe(1);
  });
});

describe("admin metrics history read", () => {
  it("keeps the scheduled history builder at 16 read-only SELECTs", async () => {
    const statements: string[] = [];
    const database = {
      prepare(statement: string) {
        statements.push(statement);
        return bindings.USAGE_MONITOR_DB.prepare(statement);
      },
    } as unknown as D1Database;

    const history = await readAdminMetricsHistory(
      database,
      Date.parse("2026-08-21T12:00:00.000Z"),
    );
    expect(history.events.acceptedUploads).toEqual({
      total: 0,
      last24Hours: 0,
      previous24Hours: 0,
      byDayStartsAt: "2026-07-23",
      byDay: [],
    });
    // Before acceptedUploads, the builder prepared 18 SELECTs. Consolidating
    // the three v1 series into two scans leaves the richer scheduled build at
    // 16; the interactive endpoint never invokes this function.
    expect(statements).toHaveLength(16);
    expect(statements.every((statement) => (
      /^(?:SELECT|WITH)\b/u.test(statement.trimStart())
      && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ))).toBe(true);
  });

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
    expect(history.downloads).toEqual({
      available: true,
      byDayStartsAt: "2026-07-23",
      byDay: [],
    });
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

  it("bounds snapshots to 30 days and downsamples older retained days", async () => {
    const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1_000;
    const insert = bindings.USAGE_MONITOR_DB.prepare(
      `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
       VALUES (?, ?)`,
    );
    // Two snapshots on an old retained day, two inside the full-resolution
    // horizon, and one outside the complete 30-day response boundary.
    const oldDay = new Date(nowEpoch - 20 * day);
    const expired = new Date(nowEpoch - 31 * day).toISOString();
    const recent = new Date(nowEpoch - 2 * 60 * 60 * 1_000);
    const stamps = [
      expired,
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
    // The >30d point is gone, the old retained day keeps only its last
    // snapshot, and the recent hours keep both.
    expect(history.gauges.snapshots.map((snapshot) => snapshot.capturedAt))
      .toEqual([stamps[2], stamps[3], stamps[4]]);
  });
});

describe("admin metrics history aggregate cache", () => {
  const nowEpoch = Date.parse("2026-08-21T12:00:00.000Z");

  it("warms actual bounded history, then serves exactly one cache SELECT", async () => {
    await insertParticipant("recent-account", "2026-08-20T08:00:00.000Z");
    await insertParticipant("older-account", "2026-06-01T08:00:00.000Z");
    const db = bindings.USAGE_MONITOR_DB;
    await db.batch([
      db.prepare(
        `INSERT INTO github_distribution_snapshots (observed_at, completed_at)
         VALUES (?, ?)`,
      ).bind("2026-06-01T09:00:00.000Z", "2026-06-01T09:00:01.000Z"),
      db.prepare(
        `INSERT INTO github_release_asset_snapshots (
           observed_at, release_id, release_tag, release_published_at,
           release_prerelease, asset_id, asset_name, asset_digest,
           asset_download_count, is_dmg
         ) VALUES (?, 1, 'v-old', ?, 0, 1, 'old.dmg', NULL, 4, 1)`,
      ).bind("2026-06-01T09:00:00.000Z", "2026-05-31T09:00:00.000Z"),
      db.prepare(
        `INSERT INTO github_distribution_snapshots (observed_at, completed_at)
         VALUES (?, ?)`,
      ).bind("2026-08-20T09:00:00.000Z", "2026-08-20T09:00:01.000Z"),
      db.prepare(
        `INSERT INTO github_release_asset_snapshots (
           observed_at, release_id, release_tag, release_published_at,
           release_prerelease, asset_id, asset_name, asset_digest,
           asset_download_count, is_dmg
         ) VALUES (?, 1, 'v-new', ?, 0, 1, 'new.dmg', NULL, 12, 1)`,
      ).bind("2026-08-20T09:00:00.000Z", "2026-08-19T09:00:00.000Z"),
      db.prepare(
        `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
         VALUES (?, ?)`,
      ).bind(
        "2026-07-01T10:00:00.000Z",
        JSON.stringify({ participantsTotal: 1 }),
      ),
      db.prepare(
        `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
         VALUES (?, ?)`,
      ).bind(
        "2026-08-20T10:00:00.000Z",
        JSON.stringify({ participantsTotal: 2 }),
      ),
    ]);

    expect(await warmAdminMetricsHistoryCache(db, nowEpoch)).toEqual({
      code: "HISTORY_CACHE_REFRESHED",
    });
    const stored = await db.prepare(
      `SELECT generated_at, payload_json FROM admin_metrics_history_cache
        WHERE singleton = 1`,
    ).first<{ generated_at: string; payload_json: string }>();
    expect(stored?.generated_at).toBe("2026-08-21T12:00:00.000Z");
    expect(stored?.payload_json).not.toContain("recent-account");
    expect(stored?.payload_json).not.toContain("older-account");

    const statements: string[] = [];
    const cacheOnlyDb = {
      prepare(statement: string) {
        statements.push(statement);
        return db.prepare(statement);
      },
    } as unknown as D1Database;
    const history = await readCachedAdminMetricsHistory(
      cacheOnlyDb,
      nowEpoch + 1_000,
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^\s*SELECT generated_at, payload_json\s+FROM admin_metrics_history_cache/u,
    );
    expect(statements[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(history.schemaVersion).toBe("admin-metrics-history-v0.2");
    expect(history.events.participants).toMatchObject({
      total: 2,
      byDayStartsAt: "2026-07-23",
      byDay: [{ day: "2026-08-20", count: 1 }],
    });
    expect(history.downloads).toEqual({
      available: true,
      byDayStartsAt: "2026-07-23",
      byDay: [{ day: "2026-08-20", cumulativeDmgDownloads: 12 }],
    });
    expect(history.gauges.snapshots).toEqual([{
      capturedAt: "2026-08-20T10:00:00.000Z",
      metrics: { participantsTotal: 2 },
    }]);
  });

  it("fails closed for a missing, stale, or corrupt cache", async () => {
    const unavailable = {
      status: 503,
      code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
    };
    await expect(readCachedAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).rejects.toMatchObject(unavailable);
    expect(await warmAdminMetricsHistoryCache(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const row = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT payload_json FROM admin_metrics_history_cache WHERE singleton = 1",
    ).first<{ payload_json: string }>();
    const staleAt = "2026-08-21T09:00:00.000Z";
    const stalePayload = JSON.parse(row?.payload_json ?? "{}") as {
      generatedAt?: string;
    };
    stalePayload.generatedAt = staleAt;
    await bindings.USAGE_MONITOR_DB.prepare(
      `UPDATE admin_metrics_history_cache
          SET generated_at = ?, payload_json = ?
        WHERE singleton = 1`,
    ).bind(staleAt, JSON.stringify(stalePayload)).run();
    await expect(readCachedAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).rejects.toMatchObject(unavailable);

    await bindings.USAGE_MONITOR_DB.prepare(
      `UPDATE admin_metrics_history_cache
          SET generated_at = ?, payload_json = '{'
        WHERE singleton = 1`,
    ).bind(new Date(nowEpoch).toISOString()).run();
    await expect(readCachedAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).rejects.toMatchObject(unavailable);
    expect(await warmAdminMetricsHistoryCache(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    await expect(readCachedAdminMetricsHistory(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).resolves.toMatchObject({
      schemaVersion: "admin-metrics-history-v0.2",
    });
  });

  it("self-throttles scheduled warming before the raw history builder", async () => {
    expect(await warmAdminMetricsHistoryCache(
      bindings.USAGE_MONITOR_DB,
      nowEpoch,
    )).toEqual({ code: "HISTORY_CACHE_REFRESHED" });
    const statements: string[] = [];
    const observedDb = {
      prepare(statement: string) {
        statements.push(statement);
        return bindings.USAGE_MONITOR_DB.prepare(statement);
      },
    } as unknown as D1Database;
    expect(await warmAdminMetricsHistoryCache(
      observedDb,
      nowEpoch + 10 * 60 * 1_000,
    )).toEqual({ code: "HISTORY_CACHE_CURRENT" });
    expect(statements).toEqual([
      expect.stringMatching(
        /^\s*SELECT generated_at, payload_json FROM admin_metrics_history_cache/u,
      ),
    ]);
  });

  it("reports cache warming failure without throwing into maintenance", async () => {
    const unavailableDb = {
      prepare() {
        throw new Error("cache storage unavailable");
      },
    } as unknown as D1Database;
    await expect(warmAdminMetricsHistoryCache(unavailableDb, nowEpoch))
      .resolves.toEqual({ code: "HISTORY_CACHE_UNAVAILABLE" });
  });
});
