import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appleClientSecret } from "../src/identity-apple";
import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://example.test";
const CALLBACK_URL = `${ORIGIN}/api/v1/identity/apple/callback`;
const SERVICES_ID = "com.tibotattle.web";
const TEAM_ID = "AB12CD34EF";
const KEY_ID = "ZZ99YY88XX";
const APPLE_ID_TOKEN = "header.payload.signature";

let privateKeyPem = "";
let privateKeyBase64 = "";

interface AppleTokenCall {
  url: string;
  parameters: URLSearchParams;
}

let tokenCalls: AppleTokenCall[] = [];
let tokenResponder: () => Response = () => Response.json({
  id_token: APPLE_ID_TOKEN,
});
const realFetch = globalThis.fetch;

// Overrides are deliberately untyped: `wrangler types` narrows the configured
// Apple variables to their production literal values, and these cases need to
// model unconfigured, empty, and malformed ones.
function bindings(overrides: Record<string, unknown> = {}): Env {
  const runtime = env as TestBindings;
  return {
    ASSETS: runtime.ASSETS,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    ENROLLMENT_MODE: runtime.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: runtime.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: runtime.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: "",
    ENVELOPE_PUBLIC_JWK: "",
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: runtime.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: runtime.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: runtime.RECOVERY_RATE_LIMIT,
    USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    APPLE_SERVICES_ID: SERVICES_ID,
    APPLE_TEAM_ID: TEAM_ID,
    APPLE_KEY_ID: KEY_ID,
    APPLE_PRIVATE_KEY: privateKeyPem,
    ...overrides,
  } as unknown as Env;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function json(
  path: string,
  body: unknown,
  runtimeEnv: Env = bindings(),
): Promise<Response> {
  return handleRequest(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
  );
}

async function callback(
  body: string,
  {
    contentType = "application/x-www-form-urlencoded",
    runtimeEnv = bindings(),
  }: { contentType?: string; runtimeEnv?: Env } = {},
): Promise<Response> {
  return handleRequest(
    new Request(CALLBACK_URL, {
      method: "POST",
      // Deliberately no origin/sec-fetch-site rewriting: this is exactly what
      // a cross-site top-level form post from appleid.apple.com looks like.
      headers: {
        "content-type": contentType,
        origin: "https://appleid.apple.com",
        "sec-fetch-site": "cross-site",
      },
      body,
    }),
    runtimeEnv,
  );
}

async function startSignIn(): Promise<{ state: string; authorizeUrl: string }> {
  const response = await json("/api/v1/identity/apple/start", {});
  expect(response.status).toBe(200);
  return response.json<{ state: string; authorizeUrl: string }>();
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  privateKeyBase64 = btoa(binary);
  privateKeyPem = [
    "-----BEGIN PRIVATE KEY-----",
    ...(privateKeyBase64.match(/.{1,64}/gu) ?? []),
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
});

beforeEach(async () => {
  await reset();
  const runtime = env as TestBindings;
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
  await applyD1Migrations(
    runtime.DELETION_LEDGER,
    runtime.TEST_DELETION_LEDGER_MIGRATIONS,
  );
  tokenCalls = [];
  tokenResponder = () => Response.json({ id_token: APPLE_ID_TOKEN });
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.startsWith("https://appleid.apple.com/")) {
      throw new Error(`Unexpected outbound request to ${url}`);
    }
    const body = typeof init?.body === "string"
      ? init.body
      : String(init?.body ?? "");
    tokenCalls.push({ url, parameters: new URLSearchParams(body) });
    return tokenResponder();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("web Sign in with Apple", () => {
  it("mints an ES256 client secret with Apple's required claims and leaks no key", async () => {
    const secret = await appleClientSecret(bindings(), 1_800_000_000_000);
    const [headerSegment, claimSegment, signatureSegment] = secret.split(".");
    expect(signatureSegment).toMatch(/^[A-Za-z0-9_-]+$/u);
    // ES256 signs to a raw r||s pair: 64 bytes, 86 base64url characters.
    expect(signatureSegment).toHaveLength(86);
    expect(decodeSegment(headerSegment!)).toEqual({
      alg: "ES256",
      kid: KEY_ID,
      typ: "JWT",
    });
    expect(decodeSegment(claimSegment!)).toEqual({
      iss: TEAM_ID,
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      aud: "https://appleid.apple.com",
      sub: SERVICES_ID,
    });
    expect(secret.includes(privateKeyBase64)).toBe(false);
    expect(secret.includes(privateKeyBase64.slice(0, 32))).toBe(false);
    expect(secret.includes("PRIVATE KEY")).toBe(false);
  });

  it("carries a start, an Apple callback, and a single-use result end to end", async () => {
    const started = await startSignIn();
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin + authorize.pathname)
      .toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      client_id: SERVICES_ID,
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: "",
      response_mode: "form_post",
      state: started.state,
    });

    const pending = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(pending.status).toBe(404);
    expect(await pending.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });

    const landed = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
      user: JSON.stringify({ name: { firstName: "Real", lastName: "Name" } }),
    }).toString());
    expect(landed.status).toBe(200);
    expect(landed.headers.get("content-type"))
      .toBe("text/html; charset=utf-8");
    expect(landed.headers.get("content-security-policy"))
      .toContain("default-src 'none'");
    const page = await landed.text();
    // The copy names no surface: the dashboard that started the sign-in
    // collects the result itself, whether it is a browser tab or the macOS
    // app's own window, so nobody is asked to carry anything back.
    expect(page).toContain("Signed in — return to TiboTattle.");
    expect(page).toContain('content="0; url=usagemonitor://open"');
    expect(page).toContain('href="usagemonitor://open"');
    expect(page).toContain("Open TiboTattle");
    expect(page).not.toContain("<script");
    for (const secret of [
      "apple-one-time-code",
      APPLE_ID_TOKEN,
      started.state,
      "Real",
      "Name",
    ]) {
      expect(page.includes(secret), secret).toBe(false);
    }

    expect(tokenCalls).toHaveLength(1);
    const exchange = tokenCalls[0]!;
    expect(exchange.url).toBe("https://appleid.apple.com/auth/token");
    expect(exchange.parameters.get("grant_type")).toBe("authorization_code");
    expect(exchange.parameters.get("client_id")).toBe(SERVICES_ID);
    expect(exchange.parameters.get("code")).toBe("apple-one-time-code");
    expect(exchange.parameters.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(exchange.parameters.get("client_secret")?.split(".")).toHaveLength(3);

    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(result.status).toBe(200);
    const resultPayload = await result.json();
    expect(resultPayload).toMatchObject({
      schemaVersion: "identity-apple-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
    expect(JSON.stringify(resultPayload)).not.toContain(APPLE_ID_TOKEN);

    // Single use: the winning read consumed the row, so a replay is
    // indistinguishable from an expired handoff.
    const replay = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });

    // Neither Apple's optional user payload nor the raw provider credential is
    // persisted anywhere. The short-lived row contains an opaque proof only.
    const stored = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT state, identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM apple_signin_handoffs`,
    ).all<{
      state: string;
      linkKey: string;
      proof: string;
      deliveredAt: string | null;
    }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]?.linkKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.results[0]?.proof).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(stored.results[0]?.deliveredAt).not.toBeNull();
    const serializedStored = JSON.stringify(stored.results);
    expect(serializedStored).not.toContain("Real");
    expect(serializedStored).not.toContain(APPLE_ID_TOKEN);
  });

  it("expires an unread handoff and refuses the expired state", async () => {
    const started = await startSignIn();
    await bindings().USAGE_MONITOR_DB.prepare(
      "UPDATE apple_signin_handoffs SET expires_at = ? WHERE state = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), started.state).run();

    // An expired state stops the callback before any token exchange happens.
    const late = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
    }).toString());
    expect(late.status).toBe(200);
    const page = await late.text();
    expect(page).toContain("Sign-in was not completed.");
    expect(page).toContain('content="2; url=usagemonitor://open"');
    expect(tokenCalls).toHaveLength(0);

    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const remaining = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM apple_signin_handoffs",
    ).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it("expires a successfully filled handoff that nobody collected in time", async () => {
    const started = await startSignIn();
    const landed = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Signed in");

    // The token exchange completed and the row was filled, but the page
    // that started the flow never came back to collect it before the
    // five-minute handoff window closed.
    await bindings().USAGE_MONITOR_DB.prepare(
      "UPDATE apple_signin_handoffs SET expires_at = ? WHERE state = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), started.state).run();

    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    // A completed-but-stale handoff must read as invalid, not as still
    // pending — a client must never be told to keep polling for a result
    // that can no longer be delivered.
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
  });

  it("refuses a second callback against an already-filled handoff, without a second Apple exchange", async () => {
    const started = await startSignIn();
    const first = await callback(new URLSearchParams({
      code: "first-one-time-code",
      state: started.state,
    }).toString());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Signed in");
    expect(tokenCalls).toHaveLength(1);

    const second = await callback(new URLSearchParams({
      code: "second-one-time-code",
      state: started.state,
    }).toString());
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Sign-in was not completed.");
    // The already-filled row short-circuits before a second token exchange
    // is ever attempted, so Apple's one-time code is never spent twice.
    expect(tokenCalls).toHaveLength(1);

    const stored = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM apple_signin_handoffs WHERE state = ?`,
    ).bind(started.state).first<{
      linkKey: string;
      proof: string;
      deliveredAt: string | null;
    }>();
    expect(stored?.linkKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.proof).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(stored?.deliveredAt).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(APPLE_ID_TOKEN);

    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      schemaVersion: "identity-apple-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
  });

  it("ignores an unknown, malformed, errored, or replayed callback", async () => {
    const started = await startSignIn();

    for (const body of [
      new URLSearchParams({ code: "c", state: "A".repeat(64) }).toString(),
      new URLSearchParams({ code: "c", state: "short" }).toString(),
      new URLSearchParams({ code: "c", state: `bad state ${"x".repeat(60)}` })
        .toString(),
      new URLSearchParams({ state: started.state }).toString(),
      new URLSearchParams({
        state: started.state,
        error: "user_cancelled_authorize",
      }).toString(),
      "",
    ]) {
      const ignored = await callback(body);
      expect(ignored.status, body).toBe(200);
      expect(await ignored.text()).toContain("Sign-in was not completed.");
    }
    expect(tokenCalls).toHaveLength(0);

    const wrongContentType = await callback(
      JSON.stringify({ code: "c", state: started.state }),
      { contentType: "application/json" },
    );
    expect(wrongContentType.status).toBe(415);
    expect(await wrongContentType.json()).toMatchObject({
      error: { code: "CONTENT_TYPE_INVALID" },
    });

    const oversized = await callback(
      `code=${"a".repeat(17_000)}&state=${started.state}`,
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });

    const wrongMethod = await handleRequest(
      new Request(CALLBACK_URL, { method: "GET" }),
      bindings(),
    );
    expect(wrongMethod.status).toBe(405);

    // The pending handoff survived every ignored callback untouched.
    const row = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM apple_signin_handoffs WHERE state = ?`,
    ).bind(started.state).first<{
      linkKey: string | null;
      proof: string | null;
      deliveredAt: string | null;
    }>();
    expect(row?.linkKey ?? null).toBeNull();
    expect(row?.proof ?? null).toBeNull();
    expect(row?.deliveredAt ?? null).toBeNull();
  });

  it("keeps a failed Apple exchange from filling the handoff", async () => {
    const started = await startSignIn();
    tokenResponder = () => new Response("invalid_client", { status: 400 });
    const failed = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
    }).toString());
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain("Sign-in was not completed.");
    expect(tokenCalls).toHaveLength(1);

    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
    });
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });
  });

  it("requires same-origin starts, reads, and a well-formed result body", async () => {
    const started = await startSignIn();
    for (const path of [
      "/api/v1/identity/apple/start",
      "/api/v1/identity/apple/result",
    ]) {
      const crossSite = await handleRequest(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          body: JSON.stringify({ state: started.state }),
        }),
        bindings(),
      );
      expect(crossSite.status, path).toBe(403);
    }
    for (const body of [
      { state: started.state, extra: true },
      { state: "short" },
      { state: 42 },
      {},
      [started.state],
    ]) {
      const rejected = await json("/api/v1/identity/apple/result", body);
      expect(rejected.status, JSON.stringify(body)).toBe(400);
    }
    const nonEmptyStart = await json("/api/v1/identity/apple/start", {
      redirectUri: "https://attacker.example/callback",
    });
    expect(nonEmptyStart.status).toBe(400);
  });

  it("fails closed when Apple sign-in is not configured", async () => {
    for (const overrides of [
      { APPLE_SERVICES_ID: "" },
      { APPLE_TEAM_ID: "" },
      { APPLE_TEAM_ID: "lowercase1" },
      { APPLE_KEY_ID: "TOO-SHORT" },
      { APPLE_PRIVATE_KEY: "" },
      { APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" },
    ]) {
      const response = await json(
        "/api/v1/identity/apple/start",
        {},
        bindings(overrides),
      );
      expect(response.status, JSON.stringify(overrides)).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "IDENTITY_CONFIGURATION_INVALID" },
      });
    }
    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM apple_signin_handoffs",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });

  it("keeps the retired Apple association filename out of the SPA fallback", async () => {
    const path = "/.well-known/apple-developer-domain-association.txt";
    for (const method of ["GET", "POST"]) {
      const response = await handleRequest(
        new Request(`${ORIGIN}${path}`, { method }),
        bindings(),
      );
      expect(response.status, method).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "NOT_FOUND" },
      });
    }
  });

  it("accepts a private key whose newlines were flattened by a secret store", async () => {
    const flattened = bindings({
      APPLE_PRIVATE_KEY: privateKeyPem.replaceAll("\n", "\\n"),
    });
    const secret = await appleClientSecret(flattened, 1_800_000_000_000);
    expect(secret.split(".")).toHaveLength(3);
  });
});
