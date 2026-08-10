import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  APPLE_SIGNIN_NONCE_PATTERN,
  appleClientSecret,
  exchangeAppleAuthorizationCode,
  hashAppleSignInNonce,
} from "../src/identity-apple";
import {
  completeAppleSignInHandoff,
  deliverAppleSignInHandoff,
  insertAppleSignInHandoff,
  readPendingAppleSignInHandoff,
} from "../src/identity-handoff-repository";
import { sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";

// The initiating client generates an unguessable verifier and sends only its
// SHA-256 digest to the start route; it re-presents the raw verifier to collect
// and to consume the result. These helpers model that client.
function newSignInVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

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
    SIGN_IN_START_MAX_PER_MINUTE: "1200",
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

async function startSignIn(): Promise<
  { state: string; authorizeUrl: string; verifier: string }
> {
  const verifier = newSignInVerifier();
  const binding = await sha256Hex(verifier);
  const response = await json("/api/v1/identity/apple/start", { binding });
  expect(response.status).toBe(200);
  const payload = await response.json<{ state: string; authorizeUrl: string }>();
  return { ...payload, verifier };
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
  it("keeps handoff storage digest-only and enforces callback/result one-use predicates", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const state = "repository-test-state";
    const nonceHash = "a".repeat(64);
    const linkKey = "b".repeat(64);
    const proof = "c".repeat(64);
    const bindingHash = "e".repeat(64);
    await insertAppleSignInHandoff(db, {
      state,
      nonceHash,
      bindingHash,
      createdAt: nowIso,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    });
    expect(await readPendingAppleSignInHandoff(db, state, nowIso)).toEqual({
      state,
      nonceHash,
    });
    // The binding gates the pending read: a wrong verifier digest cannot even
    // learn that a sign-in is pending.
    expect(
      await readPendingAppleSignInHandoff(db, state, nowIso, "f".repeat(64)),
    ).toBeNull();
    expect(
      await readPendingAppleSignInHandoff(db, state, nowIso, bindingHash),
    ).toEqual({ state, nonceHash });
    // The row was inserted with a 60s authorization window that is nearly
    // spent; filling it hands the freshly minted proof its own window.
    const deliveryExpiresAt = new Date(nowMs + 300_000).toISOString();
    expect(await completeAppleSignInHandoff(
      db,
      state,
      linkKey,
      proof,
      nowIso,
      deliveryExpiresAt,
    )).toBe(true);
    expect(await db.prepare(
      "SELECT expires_at AS expiresAt FROM apple_signin_handoffs WHERE state = ?",
    ).bind(state).first<{ expiresAt: string }>()).toEqual({
      expiresAt: deliveryExpiresAt,
    });
    expect(await completeAppleSignInHandoff(
      db,
      state,
      linkKey,
      "d".repeat(64),
      nowIso,
      deliveryExpiresAt,
    )).toBe(false);
    // A deadline that is not strictly after the mint would let a proof exist
    // that was never collectable, so the storage boundary refuses it outright.
    await expect(completeAppleSignInHandoff(
      db,
      `${state}-backdated`,
      linkKey,
      "f".repeat(64),
      nowIso,
      nowIso,
    )).rejects.toThrow();
    // A wrong verifier digest neither delivers the proof nor marks the row
    // consumed, so the correct binding can still collect it exactly once.
    expect(
      await deliverAppleSignInHandoff(db, state, nowIso, "f".repeat(64)),
    ).toBeNull();
    expect(await deliverAppleSignInHandoff(db, state, nowIso, bindingHash))
      .toEqual({ proof });
    expect(await deliverAppleSignInHandoff(db, state, nowIso, bindingHash))
      .toBeNull();

    const stored = await db.prepare(
      "SELECT nonce_hash AS nonceHash, identity_link_key AS linkKey, proof FROM apple_signin_handoffs WHERE state = ?",
    ).bind(state).first<{ nonceHash: string; linkKey: string; proof: string }>();
    expect(stored).toEqual({ nonceHash, linkKey, proof });
    expect(JSON.stringify(stored)).not.toContain("repository-test-raw-nonce");

    // A pre-nonce handoff shape cannot be reintroduced after migration: rows
    // without the digest fail at the storage boundary and must be restarted.
    await expect(db.prepare(
      `INSERT INTO apple_signin_handoffs
         (state, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(
      "legacy-shape",
      linkKey,
      "e".repeat(64),
      nowIso,
      new Date(nowMs + 60_000).toISOString(),
    ).run()).rejects.toThrow();
  });

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

  it("fails closed and aborts a token exchange that outlives the callback budget", async () => {
    let aborted = false;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    await expect(exchangeAppleAuthorizationCode(
      bindings(),
      "apple-hung-provider-code",
      CALLBACK_URL,
      Date.now(),
      { timeoutMilliseconds: 1 },
    )).rejects.toMatchObject({
      status: 401,
      code: "IDENTITY_TOKEN_INVALID",
    });
    expect(aborted).toBe(true);
  });

  it("carries a start, an Apple callback, and a single-use result end to end", async () => {
    const started = await startSignIn();
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin + authorize.pathname)
      .toBe("https://appleid.apple.com/auth/authorize");
    const nonce = authorize.searchParams.get("nonce");
    expect(nonce).toMatch(APPLE_SIGNIN_NONCE_PATTERN);
    expect(nonce).toHaveLength(43);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      client_id: SERVICES_ID,
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: "",
      response_mode: "form_post",
      state: started.state,
      nonce,
    });

    const pending = await json("/api/v1/identity/apple/result", {
      state: started.state,
      verifier: started.verifier,
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
      nonce!,
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
      verifier: started.verifier,
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
      verifier: started.verifier,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });

    // Neither Apple's optional user payload, raw provider credential, nor raw
    // nonce is persisted anywhere. The short-lived row contains only the
    // nonce digest, verified link key, and opaque proof needed for handoff.
    const stored = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT state, nonce_hash AS nonceHash, identity_link_key AS linkKey, proof, delivered_at AS deliveredAt
         FROM apple_signin_handoffs`,
    ).all<{
      state: string;
      nonceHash: string;
      linkKey: string;
      proof: string;
      deliveredAt: string | null;
    }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]?.nonceHash).toBe(await hashAppleSignInNonce(nonce!));
    expect(stored.results[0]?.nonceHash).not.toContain(nonce!);
    expect(stored.results[0]?.linkKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.results[0]?.proof).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(stored.results[0]?.deliveredAt).not.toBeNull();
    const serializedStored = JSON.stringify(stored.results);
    expect(serializedStored).not.toContain("Real");
    expect(serializedStored).not.toContain(APPLE_ID_TOKEN);
    expect(serializedStored).not.toContain(nonce!);
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
      verifier: started.verifier,
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
      verifier: started.verifier,
    });
    // A completed-but-stale handoff must read as invalid, not as still
    // pending — a client must never be told to keep polling for a result
    // that can no longer be delivered.
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
  });

  it("gives a proof minted at the end of a slow round trip its own collectable window", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const started = await startSignIn();
    // Model an OAuth round trip that consumed all but three seconds of the
    // authorization window: a cold-starting browser plus somebody who actually
    // reads Apple's consent screen. Ageing the row is exactly equivalent to
    // advancing the clock from every handler's point of view.
    const startedAtMs = Date.now() - 297_000;
    await db.prepare(
      "UPDATE apple_signin_handoffs SET created_at = ?, expires_at = ? WHERE state = ?",
    ).bind(
      new Date(startedAtMs).toISOString(),
      new Date(startedAtMs + 300_000).toISOString(),
      started.state,
    ).run();

    const filledAtMs = Date.now();
    const landed = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Signed in");

    // The proof's deadline is measured from the mint, not from what was left
    // of the authorization window. Before this was fixed the row still carried
    // the start-based deadline and the measured window here was 3s.
    const row = await db.prepare(
      "SELECT expires_at AS expiresAt FROM apple_signin_handoffs WHERE state = ?",
    ).bind(started.state).first<{ expiresAt: string }>();
    expect(Date.parse(row!.expiresAt) - filledAtMs).toBeGreaterThan(270_000);

    // Not merely a stored number: a dashboard poll landing after the old
    // start-based deadline had passed still collects the proof. This slept
    // interval is what turned an entirely correct sign-in into a 401.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
      verifier: started.verifier,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      schemaVersion: "identity-apple-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
  }, 30_000);

  it("still refuses a callback that arrives after the authorization window", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const started = await startSignIn();
    // The authorization window is longer than it was, but it is still a window,
    // and it is still measured from the instant the state was minted.
    const startedAtMs = Date.now() - 601_000;
    await db.prepare(
      "UPDATE apple_signin_handoffs SET created_at = ?, expires_at = ? WHERE state = ?",
    ).bind(
      new Date(startedAtMs).toISOString(),
      new Date(startedAtMs + 600_000).toISOString(),
      started.state,
    ).run();

    const late = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state: started.state,
    }).toString());
    expect(await late.text()).toContain("Sign-in was not completed.");
    // No exchange was attempted, so no proof exists to be delivered.
    expect(tokenCalls).toHaveLength(0);
    const result = await json("/api/v1/identity/apple/result", {
      state: started.state,
      verifier: started.verifier,
    });
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
      verifier: started.verifier,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      schemaVersion: "identity-apple-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
  });

  it("ignores an unknown, malformed, or replayed callback", async () => {
    const started = await startSignIn();

    for (const body of [
      new URLSearchParams({ code: "c", state: "A".repeat(64) }).toString(),
      new URLSearchParams({ code: "c", state: "short" }).toString(),
      new URLSearchParams({ code: "c", state: `bad state ${"x".repeat(60)}` })
        .toString(),
      new URLSearchParams({ state: started.state }).toString(),
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

  it("ends only the cancelled Apple handoff instead of leaving the app polling", async () => {
    const cancelled = await startSignIn();
    const stillPending = await startSignIn();

    const landed = await callback(new URLSearchParams({
      state: cancelled.state,
      error: "user_cancelled_authorize",
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Sign-in was not completed.");
    expect(tokenCalls).toHaveLength(0);

    const cancelledResult = await json("/api/v1/identity/apple/result", {
      state: cancelled.state,
      verifier: cancelled.verifier,
    });
    expect(cancelledResult.status).toBe(401);
    expect(await cancelledResult.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const cancelledRow = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM apple_signin_handoffs WHERE state = ?",
    ).bind(cancelled.state).first<{ state: string }>();
    expect(cancelledRow).toBeNull();

    // Cancellation is terminal only for that state. A fresh start must be
    // usable immediately rather than inheriting a stale "signing in" marker.
    const reentered = await startSignIn();
    expect(reentered.state).not.toBe(cancelled.state);
    const reenteredResult = await json("/api/v1/identity/apple/result", {
      state: reentered.state,
      verifier: reentered.verifier,
    });
    expect(reenteredResult.status).toBe(404);
    expect(await reenteredResult.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });

    const pendingResult = await json("/api/v1/identity/apple/result", {
      state: stillPending.state,
      verifier: stillPending.verifier,
    });
    expect(pendingResult.status).toBe(404);
    expect(await pendingResult.json()).toMatchObject({
      error: { code: "IDENTITY_RESULT_PENDING" },
    });
  });

  it("ends an unusable Apple handoff after its exchange fails", async () => {
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
      verifier: started.verifier,
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    const failedRow = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM apple_signin_handoffs WHERE state = ?",
    ).bind(started.state).first<{ state: string }>();
    expect(failedRow).toBeNull();
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

  it("keeps the Apple ceremony open while enrollment mode is disabled", async () => {
    // Disabled mode pauses new sign-ups at the enrollment write; the ceremony
    // stays open because an existing participant reattaches through it.
    const response = await json(
      "/api/v1/identity/apple/start",
      { binding: "a".repeat(64) },
      bindings({ ENROLLMENT_MODE: "disabled" }),
    );
    expect(response.status).toBe(200);
    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM apple_signin_handoffs",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(1);
    expect(tokenCalls).toHaveLength(0);
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

  // csf_b814237b: the proof was delivered to whoever held the state. The state
  // necessarily transits the provider round-trip, the victim's browser, the
  // referrer, and any log, so it is not a possession secret. These cases pin the
  // independent client binding that now gates delivery and consumption.
  it("binds Apple sign-in delivery to the initiating client's verifier", async () => {
    const verifier = newSignInVerifier();
    const binding = await sha256Hex(verifier);
    const start = await json("/api/v1/identity/apple/start", { binding });
    expect(start.status).toBe(200);
    const startedPayload = await start.json<Record<string, unknown>>();
    const state = startedPayload.state as string;
    // The client binding is never returned in JSON: neither the raw verifier nor
    // its digest appears, and the response shape is unchanged.
    expect(Object.keys(startedPayload).sort())
      .toEqual(["authorizeUrl", "schemaVersion", "state"]);
    const serializedStart = JSON.stringify(startedPayload);
    expect(serializedStart.includes(verifier)).toBe(false);
    expect(serializedStart.includes(binding)).toBe(false);

    // A caller holding the state but not the verifier cannot even learn that the
    // sign-in is pending.
    const wrongVerifier = newSignInVerifier();
    const probedPending = await json("/api/v1/identity/apple/result", {
      state,
      verifier: wrongVerifier,
    });
    expect(probedPending.status).toBe(401);

    // Apple's callback fills the row exactly as a victim completing the attacker's
    // authorize URL would: the completing browser carries no verifier.
    const landed = await callback(new URLSearchParams({
      code: "apple-one-time-code",
      state,
    }).toString());
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Signed in");

    // The attacker browser — holding the state but a different verifier — cannot
    // retrieve the proof, and the failed attempt must not consume it.
    const stolen = await json("/api/v1/identity/apple/result", {
      state,
      verifier: wrongVerifier,
    });
    expect(stolen.status).toBe(401);
    expect(await stolen.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    // A missing verifier is a malformed body, never a delivery.
    const missingVerifier = await json("/api/v1/identity/apple/result", { state });
    expect(missingVerifier.status).toBe(400);

    // The initiator, holding the verifier, still collects the one proof exactly
    // once — the attacker's probes neither stole nor spoiled it.
    const collected = await json("/api/v1/identity/apple/result", {
      state,
      verifier,
    });
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      schemaVersion: "identity-apple-result-v0.1",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
    });
  });
});
