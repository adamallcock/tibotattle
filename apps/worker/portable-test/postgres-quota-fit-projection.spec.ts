import { describe, expect, it, vi } from "vitest";
import {
  backfillPostgresV1QuotaFitProjection,
  createPostgresV1QuotaPageReader,
  POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL,
  POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL,
} from "../src/postgres-quota-fit-projection";
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryResult,
} from "../src/postgres-client";

function result(rows: Record<string, unknown>[]): PostgresQueryResult {
  return { rows, rowCount: rows.length };
}

function state(through: string, last: string, complete: number): PostgresQueryResult {
  return result([{ through_record_id: through, last_record_id: last, is_complete: complete }]);
}

function mockPool(
  query: (text: string, values?: unknown[]) => Promise<PostgresQueryResult>,
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const releases: boolean[] = [];
  const client: PostgresClient = {
    async query<Row extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<PostgresQueryResult<Row>> {
      calls.push({ text, values });
      const response = await query(text, values);
      return response as unknown as PostgresQueryResult<Row>;
    },
    release(discard = false) { releases.push(discard); },
  };
  const pool: PostgresPool = { connect: vi.fn(async () => client) };
  return { pool, calls, releases };
}

describe("experimental PostgreSQL quota-fit projection", () => {
  it("resumes bounded backfill pages and reports the D1 logical query budget", async () => {
    const mocked = mockPool(async (text) => {
      if (text === "BEGIN" || text.startsWith("SET LOCAL")
          || text === POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL
          || text === POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL
          || text === "COMMIT") return result([]);
      if (text.includes("FROM tibotattle_v1_test.telemetry_v1_quota_fit_backfill")) {
        const stateCalls = mocked.calls.filter(call => call.text.includes("FROM tibotattle_v1_test.telemetry_v1_quota_fit_backfill"));
        return stateCalls.length === 1 ? state("8", "0", 0) : state("8", "3", 0);
      }
      throw new Error("unexpected SQL");
    });

    await expect(backfillPostgresV1QuotaFitProjection(mocked.pool, { maxPages: 1, pageSize: 3 }))
      .resolves.toEqual({ status: "deferred", pagesRun: 1, queriesUsed: 4, lastRecordId: 3, throughRecordId: 8 });
    expect(mocked.calls.find(call => call.text === POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL)?.values)
      .toEqual([0, 8, 3]);
    expect(mocked.releases).toEqual([false, false]);
  });

  it.each([{ maxPages: 17 }, { maxPages: 0 }, { pageSize: 4097 }, { pageSize: 0 }])
  ("rejects invalid bounds before acquiring a connection: %o", async options => {
    const connect = vi.fn(async () => { throw new Error("must not connect"); });
    await expect(backfillPostgresV1QuotaFitProjection({ connect }, options)).rejects
      .toThrow("backfill bound invalid");
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires completed active-participant readiness and reads bounded plan/fit pages", async () => {
    const planRow = {
      id: "1", stream: "quota", observed_at: "2026-08-01T00:00:00.000Z", observed_day: "2026-08-01",
      device_id: "device-1", provider: null, limit_id: "other", plan_type: null, plan_variant: null,
    };
    const fitRow = {
      id: "1", projection_resets_at: "2026-08-08T00:00:00.000Z",
      projection_observed_at: "2026-08-01T00:00:00.000Z", source_participant_id: "participant-1",
      observed_at: "2026-08-01T00:00:00.000Z", observed_day: "2026-08-01", device_id: "device-1",
      provider: "openai_codex", limit_id: "codex", plan_type: "pro", plan_variant: "pro-20x",
      occurrence_id: "occurrence-0001", slot: "seven_day", used_percent: 20,
      window_duration_minutes: 10080, resets_at: "2026-08-08T00:00:00.000Z", stream: "quota",
    };
    const mocked = mockPool(async (text) => {
      if (text.includes("JOIN tibotattle_v1_test.participants")) return state("8", "8", 1);
      if (text.includes("same_time AS MATERIALIZED")) return result([planRow]);
      if (text.includes("same_key AS MATERIALIZED")) return result([fitRow]);
      throw new Error("unexpected SQL");
    });
    const reader = await createPostgresV1QuotaPageReader(mocked.pool, "participant-1");
    await expect(reader.readPlanPage({ observedAt: "", id: 0 }, 128)).resolves.toEqual([{
      id: 1, observed_at: planRow.observed_at, observed_day: planRow.observed_day, device_id: planRow.device_id,
      provider: null, limit_id: "other", plan_type: null, plan_variant: null,
    }]);
    await expect(reader.readFitPage({ resetsAt: "", observedAt: "", id: 0 }, 128)).resolves.toEqual([{
      id: 1, observed_at: fitRow.observed_at, observed_day: fitRow.observed_day, device_id: fitRow.device_id,
      provider: fitRow.provider, limit_id: fitRow.limit_id, plan_type: fitRow.plan_type,
      plan_variant: fitRow.plan_variant, occurrence_id: fitRow.occurrence_id, slot: fitRow.slot,
      used_percent: fitRow.used_percent, window_duration_minutes: fitRow.window_duration_minutes,
      resets_at: fitRow.resets_at,
    }]);
    expect(mocked.calls).toHaveLength(3);
    expect(mocked.calls[1]?.values).toEqual(["participant-1", "", 0, 128]);
  });

  it("fails closed on incomplete readiness, corrupt fit identity, and provider errors", async () => {
    const incomplete = mockPool(async text => text.includes("JOIN tibotattle_v1_test.participants")
      ? state("8", "3", 0) : result([]));
    await expect(createPostgresV1QuotaPageReader(incomplete.pool, "participant-1"))
      .rejects.toMatchObject({ code: "V1_QUOTA_FIT_PROJECTION_UNAVAILABLE" });

    const corrupt = mockPool(async text => {
      if (text.includes("JOIN tibotattle_v1_test.participants")) return state("8", "8", 1);
      if (text.includes("same_key AS MATERIALIZED")) return result([{
        id: "1", projection_resets_at: "2026-08-08T00:00:00.000Z",
        projection_observed_at: "2026-08-01T00:00:00.000Z", source_participant_id: "other",
        observed_at: "2026-08-01T00:00:00.000Z", observed_day: "2026-08-01", device_id: "device-1",
        provider: "openai_codex", limit_id: "codex", plan_type: "pro", plan_variant: "pro-20x",
        occurrence_id: "occurrence-0001", slot: "seven_day", used_percent: 20,
        window_duration_minutes: 10080, resets_at: "2026-08-08T00:00:00.000Z", stream: "quota",
      }]);
      throw new Error("synthetic provider details");
    });
    const reader = await createPostgresV1QuotaPageReader(corrupt.pool, "participant-1");
    const error = await reader.readFitPage({ resetsAt: "", observedAt: "", id: 0 }, 128).catch(value => value);
    expect(error).toMatchObject({ code: "V1_QUOTA_FIT_PROJECTION_UNAVAILABLE" });
    expect(String(error)).not.toContain("synthetic provider details");
  });
});
