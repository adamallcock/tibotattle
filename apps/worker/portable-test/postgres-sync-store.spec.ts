import { describe, expect, it } from "vitest";
import {
  createExperimentalPostgresTelemetryV1SyncStore,
} from "../src/postgres-telemetry-v1-sync-store";
import type {
  PostgresTelemetryV1Client,
  PostgresTelemetryV1Pool,
  PostgresTelemetryV1QueryResult,
} from "../src/postgres-telemetry-v1-contribution-store";
import { sha256Hex } from "../src/content-digest";

const first = {
  chunk_day: "2026-09-01", stream: "quota", chunk_seq: 0,
  chunk_digest: "a".repeat(64), revision: 1, record_count: 2,
};
const second = {
  chunk_day: "2026-09-01", stream: "usage", chunk_seq: 0,
  chunk_digest: "b".repeat(64), revision: 1, record_count: 1,
};
const third = {
  chunk_day: "2026-09-03", stream: "session", chunk_seq: 0,
  chunk_digest: "c".repeat(64), revision: 2, record_count: 3,
};

function fixture(
  result: PostgresTelemetryV1QueryResult = { rows: [first, second, third], rowCount: 3 },
  failAt: string | null = null,
  rollbackFails = false,
  admissionResult: PostgresTelemetryV1QueryResult = {
    rows: [{
      accepted_count: 4,
      device_issued_at: "2026-09-14T00:00:00.000Z",
    }],
    rowCount: 1,
  },
) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const releases: boolean[] = [];
  const client: PostgresTelemetryV1Client = {
    async query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql === failAt || (sql === "ROLLBACK" && rollbackFails)) {
        throw new Error("synthetic-private-driver-details");
      }
      const response = sql.startsWith("SELECT")
        ? sql.includes("admission_windows") ? admissionResult : result
        : { rows: [], rowCount: null };
      return response as unknown as { readonly rows: readonly Row[]; readonly rowCount: number | null };
    },
    release(discard = false) {
      releases.push(discard);
    },
  };
  const pool: PostgresTelemetryV1Pool = {
    async connect() { return client; },
  };
  return { pool, queries, releases };
}

describe("experimental PostgreSQL telemetry v1 sync store", () => {
  it("preserves D1 ordering and digest construction for state", async () => {
    const f = fixture();
    const store = createExperimentalPostgresTelemetryV1SyncStore(f.pool);
    const dayOne = await sha256Hex(first.chunk_digest + second.chunk_digest);
    const dayThree = await sha256Hex(third.chunk_digest);
    const state = await store.state("synthetic-participant", "synthetic-device");
    expect(state).toEqual({
      schemaVersion: "device-sync-state-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      acknowledgedThroughDay: "2026-09-03",
      historyDigest: await sha256Hex(dayOne + dayThree),
      dayCount: 2,
      chunkCount: 3,
    });
    expect(f.queries.slice(0, 3).map(({ sql }) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout='10000ms'",
      "SET LOCAL lock_timeout='5000ms'",
    ]);
    expect(f.queries[3]?.values).toEqual([
      "synthetic-participant",
      "synthetic-device",
      100_001,
    ]);
    expect(f.queries[3]?.sql).toContain("ORDER BY chunk_day ASC, stream ASC, chunk_seq ASC");
    expect(f.queries.at(-1)?.sql).toBe("COMMIT");
    expect(f.releases).toEqual([false]);
  });

  it("preserves inclusive manifest ranges and chunk metadata", async () => {
    const f = fixture({ rows: [second, third], rowCount: 2 });
    const manifest = await createExperimentalPostgresTelemetryV1SyncStore(f.pool)
      .manifest("synthetic-participant", "synthetic-device", "2026-09-01", "2026-09-03");
    expect(manifest).toEqual({
      schemaVersion: "device-sync-manifest-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      fromDay: "2026-09-01",
      toDay: "2026-09-03",
      days: [
        {
          day: "2026-09-01",
          dayDigest: await sha256Hex(second.chunk_digest),
          chunks: [{
            chunkId: "usage:2026-09-01:0",
            revision: 1,
            chunkDigest: second.chunk_digest,
            recordCount: 1,
          }],
        },
        {
          day: "2026-09-03",
          dayDigest: await sha256Hex(third.chunk_digest),
          chunks: [{
            chunkId: "session:2026-09-03:0",
            revision: 2,
            chunkDigest: third.chunk_digest,
            recordCount: 3,
          }],
        },
      ],
    });
    expect(f.queries[3]?.values).toEqual([
      "synthetic-participant",
      "synthetic-device",
      "2026-09-01",
      "2026-09-03",
      10_001,
    ]);
    expect(f.queries[3]?.sql).toContain("LIMIT $5");
  });

  it("fails closed at the max-plus-one bound and does not commit", async () => {
    const rows = Array.from({ length: 100_001 }, () => first);
    const f = fixture({ rows, rowCount: rows.length });
    await expect(createExperimentalPostgresTelemetryV1SyncStore(f.pool)
      .state("synthetic-participant", "synthetic-device"))
      .rejects.toMatchObject({ code: "LIFECYCLE_BOUNDS_EXCEEDED" });
    expect(f.queries.map(({ sql }) => sql)).not.toContain("COMMIT");
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.releases).toEqual([false]);
  });

  it("sanitizes malformed rows and transaction failures", async () => {
    const malformed = fixture({
      rows: [{ ...first, chunk_digest: "invalid" }],
      rowCount: 1,
    });
    await expect(createExperimentalPostgresTelemetryV1SyncStore(malformed.pool)
      .state("synthetic-participant", "synthetic-device"))
      .rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(malformed.releases).toEqual([false]);

    const commitFailure = fixture(undefined, "COMMIT");
    await expect(createExperimentalPostgresTelemetryV1SyncStore(commitFailure.pool)
      .state("synthetic-participant", "synthetic-device"))
      .rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(commitFailure.releases).toEqual([true]);

    const rollbackFailure = fixture({
      rows: [{ ...first, chunk_digest: "invalid" }],
      rowCount: 1,
    }, null, true);
    await expect(createExperimentalPostgresTelemetryV1SyncStore(rollbackFailure.pool)
      .state("synthetic-participant", "synthetic-device"))
      .rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(rollbackFailure.releases).toEqual([true]);
  });

  it("shares launch-week and steady-state admission calculation with D1", async () => {
    const launch = fixture();
    await expect(createExperimentalPostgresTelemetryV1SyncStore(launch.pool)
      .admission(
        "synthetic-participant",
        "synthetic-device",
        Date.parse("2026-09-15T12:00:00.000Z"),
      )).resolves.toEqual({
      schemaVersion: "telemetry-chunk-admission-v1.0",
      state: "available",
      windowDay: "2026-09-15",
      budget: "launch_week",
      acceptedChunks: 4,
      remainingChunks: 19_996,
      maximumChunks: 20_000,
      retryAt: "2026-09-16T00:00:00.000Z",
    });
    expect(launch.queries[3]?.values).toEqual([
      "synthetic-participant",
      "synthetic-device",
      "2026-09-15",
    ]);
    expect(launch.releases).toEqual([false]);

    const steady = fixture(
      undefined,
      null,
      false,
      {
        rows: [{
          accepted_count: 2_000,
          device_issued_at: "2026-08-01T00:00:00.000Z",
        }],
        rowCount: 1,
      },
    );
    await expect(createExperimentalPostgresTelemetryV1SyncStore(steady.pool)
      .admission(
        "synthetic-participant",
        "synthetic-device",
        Date.parse("2026-09-15T12:00:00.000Z"),
      )).resolves.toMatchObject({
      state: "exhausted",
      budget: "steady_state",
      acceptedChunks: 2_000,
      remainingChunks: 0,
      maximumChunks: 2_000,
    });
  });

  it("preserves missing-device auth and sanitizes malformed admission metadata", async () => {
    const missing = fixture(
      undefined,
      null,
      false,
      { rows: [], rowCount: 0 },
    );
    await expect(createExperimentalPostgresTelemetryV1SyncStore(missing.pool)
      .admission("synthetic-participant", "synthetic-device", Date.now()))
      .rejects.toMatchObject({ status: 401, code: "UPLOAD_AUTH_INVALID" });
    expect(missing.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(missing.releases).toEqual([false]);

    const malformed = fixture(
      undefined,
      null,
      false,
      {
        rows: [{ accepted_count: "four", device_issued_at: "not-a-date" }],
        rowCount: 1,
      },
    );
    await expect(createExperimentalPostgresTelemetryV1SyncStore(malformed.pool)
      .admission("synthetic-participant", "synthetic-device", Date.now()))
      .rejects.toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(malformed.releases).toEqual([false]);
  });
});
