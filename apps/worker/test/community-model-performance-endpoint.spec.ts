import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearAdminAccessJwksCacheForTests } from "../src/admin-access";
import { handleRequest } from "../src/index";

// The D1 Worker's answers for the two owner-decided routes of 2026-10-10
// (docs/decisions/2026-10-10-community-model-speed.md, GATE-Q 4 and 5):
// GET /api/v1/community/model-performance and GET /api/v1/admin/performance-intake.
// This Worker holds neither the analytics_v2 performance heads nor the
// telemetry_performance_* tables, so a valid public read is 404
// COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED (the origin's unpublished state,
// never a 5xx) and the admin view is 503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE.
// Every value here is synthetic.

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const PUBLIC_ORIGIN = "https://example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const PATH = "/api/v1/community/model-performance";
const ADMIN_PATH = "/api/v1/admin/performance-intake";
const VALID_QUERY = "?period=7&speedMode=fast";
const ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
const ACCESS_ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
const ACCESS_AUD = "c".repeat(64);
const ACCESS_KEY_ID = "synthetic-performance-access-key";
const OWNER_EMAIL = "owner@example.test";

let accessKeyPair: CryptoKeyPair;
let accessJwksJson = "";

function testBindings(overrides: Record<string, unknown> = {}): Env {
  const bindings = env as TestBindings;
  return {
    PUBLIC_ANALYTICS_MODE: "enabled",
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
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: bindings.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT: bindings.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    UPLOAD_INGRESS_BUDGET: bindings.UPLOAD_INGRESS_BUDGET,
    UPLOAD_INGRESS_QUEUE_MODE: bindings.UPLOAD_INGRESS_QUEUE_MODE,
    UPLOAD_INGRESS_MAX_CONCURRENT: bindings.UPLOAD_INGRESS_MAX_CONCURRENT,
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: bindings.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE,
    UPLOAD_INGRESS_BURST: bindings.UPLOAD_INGRESS_BURST,
    UPLOAD_INGRESS_LEASE_SECONDS: bindings.UPLOAD_INGRESS_LEASE_SECONDS,
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    USAGE_MONITOR_DB: bindings.USAGE_MONITOR_DB,
    ...overrides,
  } as unknown as Env;
}

function adminBindings(overrides: Record<string, unknown> = {}): Env {
  return testBindings({
    PUBLIC_ORIGIN,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
    ACCESS_TEST_JWKS_JSON: accessJwksJson,
    ...overrides,
  });
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

async function api(path: string, init: RequestInit = {}, runtimeEnv = testBindings()): Promise<Response> {
  return handleRequest(new Request(`${PUBLIC_ORIGIN}${path}`, init), runtimeEnv);
}

function base64UrlBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedAccessJwt(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" };
  const claims = {
    aud: [ACCESS_AUD],
    email: OWNER_EMAIL,
    iss: ACCESS_ISSUER,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    sub: "synthetic-access-subject",
  };
  const signedInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessKeyPair.privateKey,
    new TextEncoder().encode(signedInput),
  ));
  return `${signedInput}.${base64UrlBytes(signature)}`;
}

function countingLimiter(success = true): { limiter: RateLimit; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limiter: {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        keys.push(input.key);
        return { success };
      },
    } satisfies RateLimit,
  };
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new Error("expected an RSA key pair");
  accessKeyPair = pair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  accessJwksJson = JSON.stringify({ keys: [{ ...publicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }] });
});

beforeEach(async () => {
  await reset();
  clearAdminAccessJwksCacheForTests();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
});

describe("GET /api/v1/community/model-performance on the D1 Worker", () => {
  it("answers every valid slot 404 unpublished with no-store, after one public-read admission", async () => {
    for (const period of ["1", "7", "30", "all"]) {
      for (const speedMode of ["standard", "fast", "ultrafast"]) {
        const { limiter, keys } = countingLimiter();
        // Key order is free; each key appears exactly once.
        for (const query of [`?period=${period}&speedMode=${speedMode}`, `?speedMode=${speedMode}&period=${period}`]) {
          const response = await api(`${PATH}${query}`, {}, testBindings({ PUBLIC_READ_RATE_LIMIT: limiter }));
          expect(response.status, query).toBe(404);
          expect(response.headers.get("cache-control"), query).toBe("no-store");
          expect(response.headers.get("retry-after"), query).toBeNull();
          await expect(response.json()).resolves.toMatchObject({
            error: { code: "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED" },
          });
        }
        expect(keys).toEqual([
          expect.stringMatching(/^usage-monitor:public_aggregate_read:client:[0-9a-f]{64}$/u),
          expect.stringMatching(/^usage-monitor:public_aggregate_read:client:[0-9a-f]{64}$/u),
        ]);
      }
    }
  });

  it("refuses each bad parameter with 400 BODY_INVALID and no-store", async () => {
    for (const query of [
      "",
      "?",
      "?period=7",
      "?speedMode=fast",
      "?period=7&speedMode=fast&extra=1",
      "?period=7&speedMode=fast&from=2026-10-01",
      "?period=7&period=7&speedMode=fast",
      "?period=7&speedMode=fast&speedMode=fast",
      "?period=14&speedMode=fast",
      "?period=0&speedMode=fast",
      "?period=ALL&speedMode=fast",
      "?period=%207&speedMode=fast",
      "?period=&speedMode=fast",
      "?period=7&speedMode=Fast",
      "?period=7&speedMode=priority",
      "?period=7&speedMode=other",
      "?period=7&speedMode=",
      "?Period=7&speedMode=fast",
      "?period=7&speedmode=fast",
      "?=x&period=7&speedMode=fast",
    ]) {
      const response = await api(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control"), query).toBe("no-store");
      await expect(response.json(), query).resolves.toMatchObject({ error: { code: "BODY_INVALID" } });
    }
  });

  it("refuses every other method with 405 and Allow: GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const response = await api(`${PATH}${VALID_QUERY}`, {
        method,
        ...(method === "HEAD" ? {} : { body: "{}" }),
        headers: { origin: PUBLIC_ORIGIN },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET");
      expect(response.headers.get("cache-control"), method).toBe("no-store");
    }
  });

  it("answers 503 PUBLICATION_DISABLED at the deployment gate, before any database or limiter read", async () => {
    const calls: string[] = [];
    const { limiter } = countingLimiter();
    const countedLimiter = {
      async limit(input: { key: string }) {
        calls.push("rate-limit");
        return limiter.limit(input);
      },
    } satisfies RateLimit;
    const unavailable = {
      prepare(): never {
        calls.push("database");
        throw new Error("database must not be read");
      },
    } as unknown as D1Database;
    for (const mode of [undefined, "disabled", "unexpected"] as const) {
      for (const query of [VALID_QUERY, "?period=14"]) {
        const response = await api(`${PATH}${query}`, {}, testBindings({
          PUBLIC_ANALYTICS_MODE: mode,
          PUBLIC_READ_RATE_LIMIT: countedLimiter,
          USAGE_MONITOR_DB: unavailable,
        }));
        expect(response.status, `${mode} ${query}`).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toMatchObject({ error: { code: "PUBLICATION_DISABLED" } });
      }
    }
    expect(calls).toEqual([]);
  });

  it("stays behind the publication collection control, before the limiter", async () => {
    await db().prepare(`
      UPDATE collection_controls
         SET publication_enabled = 0,
             control_state = 'degraded',
             revision = revision + 1
       WHERE singleton = 1
    `).run();
    const { limiter, keys } = countingLimiter();
    const response = await api(`${PATH}${VALID_QUERY}`, {}, testBindings({ PUBLIC_READ_RATE_LIMIT: limiter }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PUBLICATION_DISABLED" } });
    expect(keys).toEqual([]);
  });

  it("applies the public aggregate read limit before validating the query", async () => {
    for (const query of [VALID_QUERY, "?period=14&speedMode=fast"]) {
      const { limiter, keys } = countingLimiter(false);
      const response = await api(`${PATH}${query}`, {}, testBindings({ PUBLIC_READ_RATE_LIMIT: limiter }));
      expect(response.status, query).toBe(429);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("60");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "ATTEMPT_LIMIT_REACHED" } });
      expect(keys).toHaveLength(1);
    }
  });

  it("spends the same per-client budget as community/daily", async () => {
    const { limiter, keys } = countingLimiter();
    const bindings = testBindings({ PUBLIC_READ_RATE_LIMIT: limiter });
    const headers = { "cf-connecting-ip": "198.51.100.23" };
    await api("/api/v1/community/daily?from=2026-08-01&to=2026-08-01", { headers }, bindings);
    await api(`${PATH}${VALID_QUERY}`, { headers }, bindings);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("GET /api/v1/admin/performance-intake on the D1 Worker", () => {
  it("answers 503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE on the admin host, with no-store", async () => {
    const response = await handleRequest(new Request(`${ADMIN_ORIGIN}${ADMIN_PATH}`, {
      headers: { "cf-access-jwt-assertion": await signedAccessJwt() },
    }), adminBindings());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE" } });
  });

  it("keeps the Access chokepoint first and the public origin's 404", async () => {
    const missing = await handleRequest(new Request(`${ADMIN_ORIGIN}${ADMIN_PATH}`), adminBindings());
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "ACCESS_REQUIRED" } });
    const apex = await handleRequest(new Request(`${PUBLIC_ORIGIN}${ADMIN_PATH}`), adminBindings());
    expect(apex.status).toBe(404);
    await expect(apex.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("refuses a wrong method with 405 and a query with 400 before the unavailable answer", async () => {
    const token = await signedAccessJwt();
    const post = await handleRequest(new Request(`${ADMIN_ORIGIN}${ADMIN_PATH}`, {
      method: "POST",
      body: "{}",
      headers: { "cf-access-jwt-assertion": token },
    }), adminBindings());
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const query = await handleRequest(new Request(`${ADMIN_ORIGIN}${ADMIN_PATH}?window=7`, {
      headers: { "cf-access-jwt-assertion": token },
    }), adminBindings());
    expect(query.status).toBe(400);
    await expect(query.json()).resolves.toMatchObject({ error: { code: "BODY_INVALID" } });
  });

  it("keeps the single-origin development refusal when no admin host is configured", async () => {
    const response = await api(ADMIN_PATH);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_NOT_CONFIGURED" } });
  });
});
