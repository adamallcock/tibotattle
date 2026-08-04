import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://example.test";
const CALLBACK_URL = `${ORIGIN}/api/v1/identity/google/callback`;
const CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-web-client-secret";
const GOOGLE_ID_TOKEN = "header.payload.signature";

interface TokenCall {
  url: string;
  parameters: URLSearchParams;
}

let tokenCalls: TokenCall[] = [];
let tokenResponder: () => Response = () => Response.json({
  access_token: "google-access-token",
  refresh_token: "google-refresh-token",
  id_token: GOOGLE_ID_TOKEN,
});
const realFetch = globalThis.fetch;

// Overrides are deliberately untyped: `wrangler types` narrows the configured
// identity variables to their production literal values, and these cases need
// to model unconfigured and wrong ones.
function bindings(overrides: Record<string, unknown> = {}): Env {
  const runtime = env as TestBindings;
  return {
    ASSETS: runtime.ASSETS,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    ENROLLMENT_MODE: runtime.ENROLLMENT_MODE,
    SIGN_IN_START_MAX_PER_MINUTE: "1200",
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
    GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
    GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as unknown as Env;
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
  query: string,
  runtimeEnv: Env = bindings(),
): Promise<Response> {
  return handleRequest(
    // Deliberately no origin/sec-fetch-site rewriting: this is exactly what a
    // cross-site top-level redirect from accounts.google.com looks like.
    new Request(`${CALLBACK_URL}?${query}`, {
      headers: {
        origin: "https://accounts.google.com",
        "sec-fetch-site": "cross-site",
      },
    }),
    runtimeEnv,
  );
}

async function startSignIn(): Promise<{ state: string; authorizeUrl: string }> {
  const response = await json("/api/v1/identity/google/start", {});
  expect(response.status).toBe(200);
  return response.json<{ state: string; authorizeUrl: string }>();
}

function storedVerifier(state: string): Promise<{ verifier: string } | null> {
  return bindings().USAGE_MONITOR_DB.prepare(
    "SELECT code_verifier AS verifier FROM google_signin_handoffs WHERE state = ?",
  ).bind(state).first<{ verifier: string }>();
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

beforeEach(async () => {
  await reset();
  const runtime = env as TestBindings;
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
  await applyD1Migrations(
    runtime.DELETION_LEDGER,
    runtime.TEST_DELETION_LEDGER_MIGRATIONS,
  );
  tokenCalls = [];
  tokenResponder = () => Response.json({
    access_token: "google-access-token",
    refresh_token: "google-refresh-token",
    id_token: GOOGLE_ID_TOKEN,
  });
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.startsWith("https://oauth2.googleapis.com/")) {
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

describe("hosted Google sign-in", () => {
  it("carries a start, a Google redirect, and a single-use result end to end", async () => {
    const started = await startSignIn();
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin + authorize.pathname)
      .toBe("https://accounts.google.com/o/oauth2/v2/auth");

    // The PKCE verifier is the service's own secret: it stays in the handoff
    // row, and only its S256 challenge travels to Google.
    const stored = await storedVerifier(started.state);
    expect(stored?.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/u);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      // Minimal scope: no email, name, or profile is ever requested.
      scope: "openid",
      code_challenge: await sha256Base64Url(stored!.verifier),
      code_challenge_method: "S256",
      state: started.state,
    });
    expect(started.authorizeUrl.includes(stored!.verifier)).toBe(false);
    expect(JSON.stringify(started).includes(CLIENT_SECRET)).toBe(false);

    const pending = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(pending.status).toBe(404);
    expect(await pending.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });

    const landed = await callback(new URLSearchParams({
      code: "google-one-time-code",
      state: started.state,
      scope: "openid",
      authuser: "0",
      prompt: "consent",
    }).toString());
    expect(landed.status).toBe(200);
    expect(landed.headers.get("content-type"))
      .toBe("text/html; charset=utf-8");
    expect(landed.headers.get("content-security-policy"))
      .toContain("default-src 'none'");
    const page = await landed.text();
    expect(page).toContain("Signed in — return to TiboTattle.");
    expect(page).toContain('content="0; url=usagemonitor://open"');
    expect(page).toContain('href="usagemonitor://open"');
    expect(page).toContain("Open TiboTattle");
    expect(page).not.toContain("<script");
    for (const secret of [
      "google-one-time-code",
      GOOGLE_ID_TOKEN,
      started.state,
      stored!.verifier,
      CLIENT_SECRET,
    ]) {
      expect(page.includes(secret), secret).toBe(false);
    }

    expect(tokenCalls).toHaveLength(1);
    const exchange = tokenCalls[0]!;
    expect(exchange.url).toBe("https://oauth2.googleapis.com/token");
    // Google's Web application client type rejects the exchange without
    // client_secret even though the request carries a PKCE verifier.
    expect(Object.fromEntries(exchange.parameters)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "google-one-time-code",
      code_verifier: stored!.verifier,
      redirect_uri: CALLBACK_URL,
    });

    const result = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(result.status).toBe(200);
    const payload = await result.json();
    expect(payload).toMatchObject({
      schemaVersion: "identity-google-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
    // Google's raw credentials and the client secret stay inside the request.
    const serialized = JSON.stringify(payload);
    for (const leak of [
      CLIENT_SECRET,
      "google-access-token",
      "google-refresh-token",
      GOOGLE_ID_TOKEN,
    ]) {
      expect(serialized.includes(leak), leak).toBe(false);
    }

    // Single use: the winning read consumed the row, so a replay is
    // indistinguishable from an expired handoff.
    const replay = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });

    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM google_signin_handoffs`,
    ).all<{
      linkKey: string;
      proof: string;
      deliveredAt: string | null;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.linkKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows.results[0]?.proof).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(rows.results[0]?.deliveredAt).not.toBeNull();
    expect(JSON.stringify(rows.results)).not.toContain(GOOGLE_ID_TOKEN);
  });

  it("expires an unread handoff and refuses the expired state", async () => {
    const started = await startSignIn();
    await bindings().USAGE_MONITOR_DB.prepare(
      "UPDATE google_signin_handoffs SET expires_at = ? WHERE state = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), started.state).run();

    // An expired state stops the callback before any token exchange happens,
    // so the PKCE verifier on that row is never spent.
    const late = await callback(new URLSearchParams({
      code: "google-one-time-code",
      state: started.state,
    }).toString());
    expect(late.status).toBe(200);
    const page = await late.text();
    expect(page).toContain("Sign-in was not completed.");
    expect(page).toContain('content="2; url=usagemonitor://open"');
    expect(tokenCalls).toHaveLength(0);

    const result = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const remaining = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM google_signin_handoffs",
    ).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it("expires a successfully filled handoff that nobody collected in time", async () => {
    const started = await startSignIn();
    const landed = await callback(new URLSearchParams({
      code: "google-one-time-code",
      state: started.state,
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Signed in");

    // The token exchange completed and the row was filled, but the dashboard
    // that started the flow never came back to collect it before the
    // five-minute handoff window closed.
    await bindings().USAGE_MONITOR_DB.prepare(
      "UPDATE google_signin_handoffs SET expires_at = ? WHERE state = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), started.state).run();

    const result = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    // A completed-but-stale handoff must read as invalid, not as still
    // pending — a client must never be told to keep polling for a result that
    // can no longer be delivered.
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
  });

  it("refuses a second callback against an already-filled handoff, without a second Google exchange", async () => {
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
    // The already-filled row short-circuits before a second token exchange is
    // ever attempted, so Google's one-time code is never spent twice.
    expect(tokenCalls).toHaveLength(1);

    const stored = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM google_signin_handoffs WHERE state = ?`,
    ).bind(started.state).first<{
      linkKey: string;
      proof: string;
      deliveredAt: string | null;
    }>();
    expect(stored?.linkKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.proof).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(stored?.deliveredAt).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(GOOGLE_ID_TOKEN);

    const result = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      schemaVersion: "identity-google-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
  });

  it("ignores an unknown, malformed, or oversized callback", async () => {
    const started = await startSignIn();

    for (const query of [
      new URLSearchParams({ code: "c", state: "A".repeat(64) }).toString(),
      new URLSearchParams({ code: "c", state: "short" }).toString(),
      new URLSearchParams({ code: "c", state: `bad state ${"x".repeat(60)}` })
        .toString(),
      new URLSearchParams({ state: started.state }).toString(),
      `code=${"a".repeat(9_000)}&state=${started.state}`,
      "",
    ]) {
      const ignored = await callback(query);
      expect(ignored.status, query.slice(0, 60)).toBe(200);
      expect(await ignored.text()).toContain("Sign-in was not completed.");
    }
    expect(tokenCalls).toHaveLength(0);

    const wrongMethod = await handleRequest(
      new Request(CALLBACK_URL, { method: "POST" }),
      bindings(),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");

    // The pending handoff survived every ignored callback untouched.
    const row = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM google_signin_handoffs WHERE state = ?`,
    ).bind(started.state).first<{
      linkKey: string | null;
      proof: string | null;
      deliveredAt: string | null;
    }>();
    expect(row?.linkKey ?? null).toBeNull();
    expect(row?.proof ?? null).toBeNull();
    expect(row?.deliveredAt ?? null).toBeNull();
  });

  it("ends only the cancelled Google handoff instead of leaving the app polling", async () => {
    const cancelled = await startSignIn();
    const stillPending = await startSignIn();

    const landed = await callback(new URLSearchParams({
      state: cancelled.state,
      error: "access_denied",
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Sign-in was not completed.");
    expect(tokenCalls).toHaveLength(0);

    const cancelledResult = await json("/api/v1/identity/google/result", {
      state: cancelled.state,
    });
    expect(cancelledResult.status).toBe(401);
    expect(await cancelledResult.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const cancelledRow = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM google_signin_handoffs WHERE state = ?",
    ).bind(cancelled.state).first<{ state: string }>();
    expect(cancelledRow).toBeNull();
    const pendingResult = await json("/api/v1/identity/google/result", {
      state: stillPending.state,
    });
    expect(pendingResult.status).toBe(404);
    expect(await pendingResult.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });
  });

  it("ends an unusable Google handoff after its exchange fails", async () => {
    const started = await startSignIn();
    tokenResponder = () => new Response("invalid_grant", { status: 400 });
    const failed = await callback(new URLSearchParams({
      code: "google-one-time-code",
      state: started.state,
    }).toString());
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain("Sign-in was not completed.");
    expect(tokenCalls).toHaveLength(1);

    const result = await json("/api/v1/identity/google/result", {
      state: started.state,
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const failedRow = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM google_signin_handoffs WHERE state = ?",
    ).bind(started.state).first<{ state: string }>();
    expect(failedRow).toBeNull();

    // A fresh handoff also stops after a response with no id_token: its code
    // is spent and therefore cannot be retried under the old state.
    const retry = await startSignIn();
    tokenResponder = () => Response.json({ access_token: "no-id-token" });
    const missingIdToken = await callback(new URLSearchParams({
      code: "google-one-time-code",
      state: retry.state,
    }).toString());
    expect(missingIdToken.status).toBe(200);
    expect(await missingIdToken.text()).toContain("Sign-in was not completed.");
    expect(tokenCalls).toHaveLength(2);
    const retryResult = await json("/api/v1/identity/google/result", {
      state: retry.state,
    });
    expect(retryResult.status).toBe(401);
    expect(await retryResult.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const missingIdTokenRow = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM google_signin_handoffs WHERE state = ?",
    ).bind(retry.state).first<{ state: string }>();
    expect(missingIdTokenRow).toBeNull();
  });

  it("requires same-origin starts, reads, and a well-formed result body", async () => {
    const started = await startSignIn();
    for (const path of [
      "/api/v1/identity/google/start",
      "/api/v1/identity/google/result",
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
      const rejected = await json("/api/v1/identity/google/result", body);
      expect(rejected.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing about the redirect may be supplied by a caller.
    const nonEmptyStart = await json("/api/v1/identity/google/start", {
      redirectUri: "https://attacker.example/callback",
    });
    expect(nonEmptyStart.status).toBe(400);
    const wrongMethod = await handleRequest(
      new Request(`${ORIGIN}/api/v1/identity/google/start`, { method: "GET" }),
      bindings(),
    );
    expect(wrongMethod.status).toBe(405);
    expect(tokenCalls).toHaveLength(0);
  });

  it("fails closed and mints no handoff when Google sign-in is not configured", async () => {
    for (const overrides of [
      { GOOGLE_OIDC_CLIENT_SECRET: undefined },
      { GOOGLE_OIDC_CLIENT_SECRET: "" },
      { GOOGLE_OIDC_CLIENT_ID: "" },
      { GOOGLE_OIDC_CLIENT_ID: undefined },
    ]) {
      const response = await json(
        "/api/v1/identity/google/start",
        {},
        bindings(overrides),
      );
      expect(response.status, JSON.stringify(overrides)).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({
        error: { code: "IDENTITY_CONFIGURATION_INVALID" },
      });
      // The failure names neither the missing value nor the configured one.
      const serialized = JSON.stringify(body);
      expect(serialized.includes(CLIENT_SECRET)).toBe(false);
      expect(serialized.includes("SECRET")).toBe(false);
    }
    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM google_signin_handoffs",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);
    expect(tokenCalls).toHaveLength(0);
  });

  it("does not allocate a Google handoff while enrollment is contained", async () => {
    const disabled = await json(
      "/api/v1/identity/google/start",
      {},
      bindings({ ENROLLMENT_MODE: "disabled" }),
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({
      error: { code: "ENROLLMENT_DISABLED" },
    });

    await bindings().USAGE_MONITOR_DB.prepare(
      `UPDATE collection_controls
          SET enrollment_enabled = 0,
              control_state = 'degraded',
              revision = revision + 1
        WHERE singleton = 1`,
    ).run();
    const paused = await json("/api/v1/identity/google/start", {});
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({
      error: { code: "COLLECTION_ENROLLMENT_DISABLED" },
    });

    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM google_signin_handoffs",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);
    expect(tokenCalls).toHaveLength(0);
  });

  it("no longer exposes the client-side authorization-code exchange", async () => {
    // The old route completed a sign-in from a code the caller supplied. It is
    // gone rather than deprecated: with the service owning the redirect there
    // is no second way to turn a code into an identity token.
    const removed = await handleRequest(
      new Request(`${ORIGIN}/api/v1/identity/google/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          code: "google-one-time-code",
          codeVerifier: "a".repeat(64),
          redirectUri: "http://127.0.0.1:53127/oauth/google/callback",
        }),
      }),
      bindings(),
    );
    expect(removed.status).toBe(404);
    expect(tokenCalls).toHaveLength(0);
  });
});
