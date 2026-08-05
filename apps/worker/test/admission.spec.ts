import { describe, expect, it } from "vitest";

import {
  assertAttemptAllowed,
  assertPublicAggregateReadAllowed,
} from "../src/admission";

const request = new Request("https://example.test/api", {
  headers: { "cf-connecting-ip": "203.0.113.7" },
});
const environment = { ENVIRONMENT: "synthetic-development" } as unknown as Env;

describe("rate-limit admission failure contract", () => {
  it("returns a retryable unavailable error when an attempt limiter backend fails", async () => {
    const unavailable = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error("rate binding unavailable");
      },
    } satisfies RateLimit;
    const allowed = {
      async limit(): Promise<{ success: boolean }> {
        return { success: true };
      },
    } satisfies RateLimit;

    await expect(assertAttemptAllowed(
      unavailable,
      allowed,
      request,
      environment,
      "enrollment",
    )).rejects.toMatchObject({
      status: 503,
      code: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
      responseHeaders: { "retry-after": "60" },
    });
  });

  it("preserves Retry-After on attempt and aggregate 429 responses", async () => {
    const blocked = {
      async limit(): Promise<{ success: boolean }> {
        return { success: false };
      },
    } satisfies RateLimit;
    const allowed = {
      async limit(): Promise<{ success: boolean }> {
        return { success: true };
      },
    } satisfies RateLimit;

    await expect(assertAttemptAllowed(
      blocked,
      allowed,
      request,
      environment,
      "enrollment",
    )).rejects.toMatchObject({
      status: 429,
      code: "ATTEMPT_LIMIT_REACHED",
      responseHeaders: { "retry-after": "60" },
    });

    await expect(assertPublicAggregateReadAllowed(
      blocked,
      request,
      environment,
    )).rejects.toMatchObject({
      status: 429,
      code: "ATTEMPT_LIMIT_REACHED",
      responseHeaders: { "retry-after": "60" },
    });
  });

  it("maps an aggregate rate-limit backend failure to the same unavailable contract", async () => {
    const unavailable = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error("rate binding unavailable");
      },
    } satisfies RateLimit;

    await expect(assertPublicAggregateReadAllowed(
      unavailable,
      request,
      environment,
    )).rejects.toMatchObject({
      status: 503,
      code: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
      responseHeaders: { "retry-after": "60" },
    });
  });
});
