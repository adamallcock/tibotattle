import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../src/errors";
import {
  SIGN_IN_START_ADMISSION_RETENTION_MILLISECONDS,
  assertSignInStartAdmission,
  assertSignInStartAdmissionConfiguration,
  purgeExpiredSignInStartAdmissions,
} from "../src/signin-admission";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

function policy(maximumStartsPerMinute: string): Env {
  return { SIGN_IN_START_MAX_PER_MINUTE: maximumStartsPerMinute } as unknown as Env;
}

beforeEach(async () => {
  await reset();
  const runtime = env as TestBindings;
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
});

describe("globally coordinated hosted sign-in admission", () => {
  it("atomically admits only the configured number of starts in a UTC minute", async () => {
    const now = Date.parse("2026-08-04T12:34:22.000Z");
    const configured = policy("2");

    await assertSignInStartAdmission(db(), configured, now);
    await assertSignInStartAdmission(db(), configured, now + 20_000);

    let error: unknown;
    try {
      await assertSignInStartAdmission(db(), configured, now + 25_000);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "SIGN_IN_START_LIMIT_REACHED",
    });
    expect(new Headers((error as ApiError).responseHeaders ?? undefined).get("retry-after"))
      .toBe("13");

    const row = await db().prepare(
      `SELECT accepted_count, window_started_at
         FROM sign_in_start_admission_windows`,
    ).first<{ accepted_count: number; window_started_at: string }>();
    expect(row).toEqual({
      accepted_count: 2,
      window_started_at: "2026-08-04T12:34:00.000Z",
    });
  });

  it("does not over-admit concurrent starts", async () => {
    const configured = policy("3");
    const now = Date.parse("2026-08-04T12:35:10.000Z");
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        assertSignInStartAdmission(db(), configured, now)
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    for (const outcome of outcomes.filter((candidate) => candidate.status === "rejected")) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: "SIGN_IN_START_LIMIT_REACHED",
      });
    }
  });

  it("fails closed for missing or malformed deployment configuration", () => {
    for (const configured of [
      {} as Env,
      policy("0"),
      policy("1201"),
      policy("12.5"),
      policy("unexpected"),
    ]) {
      let error: unknown;
      try {
        assertSignInStartAdmissionConfiguration(configured);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        status: 503,
        code: "ADMISSION_CONFIGURATION_INVALID",
      });
    }
  });

  it("keeps aggregate counters only for the bounded retention window", async () => {
    const now = Date.parse("2026-08-04T12:40:00.000Z");
    const old = now - SIGN_IN_START_ADMISSION_RETENTION_MILLISECONDS - 1_000;
    await assertSignInStartAdmission(db(), policy("10"), old);
    await assertSignInStartAdmission(db(), policy("10"), now);

    expect(await purgeExpiredSignInStartAdmissions(db(), now)).toEqual({
      purged: 1,
      complete: true,
    });
    const remaining = await db().prepare(
      "SELECT accepted_count FROM sign_in_start_admission_windows",
    ).all<{ accepted_count: number }>();
    expect(remaining.results).toEqual([{ accepted_count: 1 }]);
  });
});
