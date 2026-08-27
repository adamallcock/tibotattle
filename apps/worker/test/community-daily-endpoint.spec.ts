import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleRequest } from "../src/index";
import {
  readPublishedCommunityDailyAggregates,
  rebuildPendingCommunityDailyAggregates,
} from "../src/community-daily-aggregates";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

function testBindings(overrides: Partial<Env> = {}): Env {
  const bindings = env as TestBindings;
  return {
    ASSETS: bindings.ASSETS,
    DELETION_LEDGER: bindings.DELETION_LEDGER,
    ENROLLMENT_MODE: bindings.ENROLLMENT_MODE,
    SIGN_IN_START_MAX_PER_MINUTE: "1200",
    ENROLLMENT_RATE_LIMIT: bindings.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: bindings.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: "",
    ENVELOPE_PUBLIC_JWK: "",
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: bindings.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: bindings.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: bindings.RECOVERY_RATE_LIMIT,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: bindings.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    UPLOAD_PRINCIPAL_RATE_LIMIT: bindings.UPLOAD_PRINCIPAL_RATE_LIMIT,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT:
      bindings.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT:
      bindings.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    UPLOAD_INGRESS_BUDGET: bindings.UPLOAD_INGRESS_BUDGET,
    UPLOAD_INGRESS_QUEUE_MODE: bindings.UPLOAD_INGRESS_QUEUE_MODE,
    UPLOAD_INGRESS_MAX_CONCURRENT: bindings.UPLOAD_INGRESS_MAX_CONCURRENT,
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE:
      bindings.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE,
    UPLOAD_INGRESS_BURST: bindings.UPLOAD_INGRESS_BURST,
    UPLOAD_INGRESS_LEASE_SECONDS: bindings.UPLOAD_INGRESS_LEASE_SECONDS,
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    USAGE_MONITOR_DB: bindings.USAGE_MONITOR_DB,
    ...overrides,
  } as Env;
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = testBindings(),
): Promise<Response> {
  return handleRequest(
    new Request(`https://example.test${path}`, init),
    runtimeEnv,
  );
}

interface SeededRevision {
  day: string;
  revision: number;
  state?: "published" | "withdrawn";
  usageEvents?: number;
  releasedAt?: string;
  payload?: Record<string, unknown>;
}

function dailyPayload(seed: SeededRevision): Record<string, unknown> {
  return {
    schemaVersion: "community-daily-aggregate-v1.0",
    aggregateId: `community-daily:${seed.day}:r${seed.revision}`,
    day: seed.day,
    revision: seed.revision,
    releasedAt: seed.releasedAt ?? "2026-08-08T01:00:00.000Z",
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: "community-daily-v1.0",
    suppression: "none_daily_grain_by_owner_decision",
    totals: {
      contributingParticipants: 1,
      contributingDevices: 1,
      usageEvents: seed.usageEvents ?? 1,
      quotaObservations: 0,
      sessionDimensions: 0,
      inputUncachedTokens: 10,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 5,
      outputReasoningTokens: 0,
      outputCombinedTokens: 5,
    },
    cellsTruncated: false,
    cells: [],
    ...seed.payload,
  };
}

async function seedDailyRevision(seed: SeededRevision): Promise<void> {
  const state = seed.state ?? "published";
  await db().prepare(
    `INSERT INTO community_daily_aggregates (
      aggregate_id, day, revision, source_mutation_epoch, policy_version,
      payload_json, payload_sha256, release_state, released_at, withdrawn_at
    ) VALUES (?, ?, ?, 0, 'community-daily-v1.0', ?, ?, ?, ?, ?)`,
  ).bind(
    `community-daily:${seed.day}:r${seed.revision}`,
    seed.day,
    seed.revision,
    JSON.stringify(dailyPayload(seed)),
    "0".repeat(64),
    state,
    seed.releasedAt ?? "2026-08-08T01:00:00.000Z",
    state === "withdrawn" ? "2026-08-08T02:00:00.000Z" : null,
  ).run();
}

beforeEach(async () => {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings.DELETION_LEDGER,
    bindings.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("GET /api/v1/community/daily", () => {
  it("returns the latest published revision per day and omits withdrawn-only days", async () => {
    // Day 1: two published revisions — only r2 is current.
    await seedDailyRevision({ day: "2026-08-01", revision: 1, usageEvents: 1 });
    await seedDailyRevision({ day: "2026-08-01", revision: 2, usageEvents: 2 });
    // Day 2: every revision withdrawn — the day must not appear at all.
    await seedDailyRevision({
      day: "2026-08-02",
      revision: 1,
      state: "withdrawn",
    });
    // Day 3: r1 withdrawn, r2 republished after the withdrawal — r2 wins.
    await seedDailyRevision({
      day: "2026-08-03",
      revision: 1,
      state: "withdrawn",
    });
    await seedDailyRevision({ day: "2026-08-03", revision: 2, usageEvents: 7 });
    // Outside the requested range: never returned.
    await seedDailyRevision({ day: "2026-09-01", revision: 1 });

    const response = await api(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-31",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await response.json<{
      schemaVersion: string;
      from: string;
      to: string;
      days: Array<{
        day: string;
        revision: number;
        releasedAt: string;
        payload: { totals: { usageEvents: number } };
      }>;
    }>();
    expect(body.schemaVersion).toBe("community-daily-read-v1.0");
    expect(body.from).toBe("2026-08-01");
    expect(body.to).toBe("2026-08-31");
    expect(body.days.map(({ day, revision }) => ({ day, revision }))).toEqual([
      { day: "2026-08-01", revision: 2 },
      { day: "2026-08-03", revision: 2 },
    ]);
    expect(body.days[0]?.payload.totals.usageEvents).toBe(2);
    expect(body.days[1]?.payload.totals.usageEvents).toBe(7);
    expect(body.days[0]?.releasedAt).toBe("2026-08-08T01:00:00.000Z");

    // The repository read the endpoint uses agrees with the HTTP projection.
    const rows = await readPublishedCommunityDailyAggregates(
      db(),
      "2026-08-01",
      "2026-08-31",
    );
    expect(rows.map((row) => `${row.day}:r${row.revision}`)).toEqual([
      "2026-08-01:r2",
      "2026-08-03:r2",
    ]);
  });

  it("returns an empty series when nothing in range is published", async () => {
    const response = await api(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-02",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "community-daily-read-v1.0",
      allowanceState: "updating",
      days: [],
    });
  });

  it("gates merged publication on the whole current safe history and strips plan diagnostics", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const priorDay = new Date(
      Date.parse(`${today}T00:00:00.000Z`) - 24 * 60 * 60 * 1_000,
    ).toISOString().slice(0, 10);
    const missingDay = new Date(
      Date.parse(`${today}T00:00:00.000Z`) - 2 * 24 * 60 * 60 * 1_000,
    ).toISOString().slice(0, 10);
    await seedDailyRevision({ day: missingDay, revision: 1 });
    await seedDailyRevision({
      day: priorDay,
      revision: 1,
      payload: {
        allowance: {
          basis: "seven_day_codex_pro20x_trailing_30d",
          planType: "pro",
          fitCount: 3,
          participantCount: 1,
          centralUsd: 2_000,
        },
        capacityByPlanType: {
          pro: { fitCount: 3, participantCount: 1, medianCapacityNanousd: 1 },
        },
      },
    });
    const updating = await api(
      `/api/v1/community/daily?from=${priorDay}&to=${priorDay}`,
    );
    const updatingBody = await updating.json<{
      allowanceState: string;
      days: Array<{ payload: Record<string, unknown> }>;
    }>();
    expect(updatingBody.allowanceState).toBe("updating");
    expect(updatingBody.days[0]?.payload).not.toHaveProperty("allowance");
    expect(updatingBody.days[0]?.payload)
      .not.toHaveProperty("capacityByPlanType");

    const mergedAllowance = {
      basis:
        "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
      limitId: "codex",
      referencePlanType: "pro",
      normalization: "pro_x1_prolite_x4_plus_x20",
      windowDurationMinutes: 10_080,
      trailingDays: 30,
      qualification: "shared_reset_fit_gates_40pp_span_floor",
      spanFloorPp: 40,
      fitCount: 8,
      participantCount: 4,
      centralUsd: 2_232,
      band80Usd: { lowerUsd: 1_900, upperUsd: 2_700 },
    };
    await seedDailyRevision({
      day: today,
      revision: 1,
      payload: { allowance: mergedAllowance },
    });

    const scheduledTime = Date.parse(`${today}T12:00:00.000Z`);
    const reconciled = await rebuildPendingCommunityDailyAggregates(
      db(),
      scheduledTime,
    );
    expect(reconciled).toMatchObject({ processed: 3, remaining: false });
    const updatingState = await db().prepare(
      `SELECT publication_state, expected_basis, safe_to_day
         FROM community_allowance_publication_state
        WHERE singleton = 1`,
    ).first<{
      publication_state: string;
      expected_basis: string;
      safe_to_day: string;
    }>();
    expect(updatingState).toMatchObject({
      publication_state: "updating",
      expected_basis:
        "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
      safe_to_day: today,
    });

    // Even though the requested day is already on the merged basis, the
    // scheduled singleton remains updating because the same global scan found
    // old and missing blocks elsewhere in the current safe window. The public
    // request reads that singleton and its one requested day only.
    const mixed = await api(
      `/api/v1/community/daily?from=${today}&to=${today}`,
    );
    const mixedBody = await mixed.json<{
      allowanceState: string;
      days: Array<{ payload: Record<string, unknown> }>;
    }>();
    expect(mixedBody.allowanceState).toBe("updating");
    expect(mixedBody.days).toHaveLength(1);
    expect(mixedBody.days[0]?.payload).not.toHaveProperty("allowance");

    // The next scheduled pass observes the revisions rebuilt by the first
    // pass, finds no global drift, and moves the singleton to ready.
    const settled = await rebuildPendingCommunityDailyAggregates(
      db(),
      scheduledTime + 60 * 60 * 1_000,
    );
    expect(settled).toMatchObject({ processed: 0, remaining: false });
    const readyState = await db().prepare(
      `SELECT publication_state FROM community_allowance_publication_state
        WHERE singleton = 1`,
    ).first<{ publication_state: string }>();
    expect(readyState?.publication_state).toBe("ready");

    const ready = await api(
      `/api/v1/community/daily?from=${today}&to=${today}`,
    );
    const readyBody = await ready.json<{
      allowanceState: string;
      days: Array<{ payload: Record<string, unknown> }>;
    }>();
    expect(readyBody.allowanceState).toBe("ready");
    expect(readyBody.days[0]?.payload.allowance).toMatchObject({
      basis:
        "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
    });
    expect(readyBody.days[0]?.payload).not.toHaveProperty("capacityByPlanType");

    const stateBefore = await db().prepare(
      `SELECT changed_at FROM community_allowance_publication_state
        WHERE singleton = 1`,
    ).first<{ changed_at: string }>();
    await rebuildPendingCommunityDailyAggregates(
      db(),
      scheduledTime + 2 * 60 * 60 * 1_000,
    );
    const stateAfter = await db().prepare(
      `SELECT changed_at FROM community_allowance_publication_state
        WHERE singleton = 1`,
    ).first<{ changed_at: string }>();
    expect(stateAfter?.changed_at).toBe(stateBefore?.changed_at);
  });

  it("bounds the range to valid calendar days spanning at most 366 days", async () => {
    const invalidRanges = [
      "",
      "?from=2026-08-01",
      "?to=2026-08-01",
      "?from=2026-08-01&to=2026-07-31",
      "?from=2026-8-1&to=2026-08-02",
      "?from=2026-02-31&to=2026-03-01",
      "?from=not-a-day&to=2026-08-02",
      "?from=2025-01-01&to=2026-01-02",
      "?from=2026-08-01&to=2026-08-02&extra=1",
    ];
    for (const query of invalidRanges) {
      const response = await api(`/api/v1/community/daily${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control"), query).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "BODY_INVALID" },
      });
    }

    // Exactly 366 inclusive days (a leap-safe year window) is accepted.
    const yearWindow = await api(
      "/api/v1/community/daily?from=2025-01-01&to=2026-01-01",
    );
    expect(yearWindow.status).toBe(200);
    const singleDay = await api(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-01",
    );
    expect(singleDay.status).toBe(200);
  });

  it("refuses non-GET methods", async () => {
    const response = await api("/api/v1/community/daily?from=2026-08-01&to=2026-08-02", {
      method: "POST",
      headers: { origin: "https://example.test" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("applies the public aggregate read rate limit", async () => {
    const limitedKeys: string[] = [];
    const blockedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limitedKeys.push(input.key);
        return { success: false };
      },
    } satisfies RateLimit;
    const response = await api(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-02",
      {},
      testBindings({ PUBLIC_READ_RATE_LIMIT: blockedLimiter }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ATTEMPT_LIMIT_REACHED" },
    });
    expect(limitedKeys).toEqual([
      expect.stringMatching(
        /^usage-monitor:public_aggregate_read:client:[0-9a-f]{64}$/u,
      ),
    ]);
  });

  it("stays behind the publication collection control", async () => {
    await db().prepare(`
      UPDATE collection_controls
         SET publication_enabled = 0,
             control_state = 'degraded',
             revision = revision + 1
       WHERE singleton = 1
    `).run();
    const response = await api(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-02",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PUBLICATION_DISABLED" },
    });
  });
});
