import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest } from "../src/index";

const ORIGIN = "https://example.test";
const EXCHANGE_PATH = "/api/v1/identity/google/exchange";
const CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-installed-client-secret";
const GOOGLE_ID_TOKEN = "header.payload.signature";
const LOOPBACK_REDIRECT = "http://127.0.0.1:53127/oauth/google/callback";
const CODE_VERIFIER = "a".repeat(64);

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
  const runtime = env as Env;
  return {
    ASSETS: runtime.ASSETS,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    ENROLLMENT_MODE: runtime.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: runtime.ENROLLMENT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: "",
    ENVELOPE_PUBLIC_JWK: "",
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: runtime.QUARANTINE,
    RECOVERY_RATE_LIMIT: runtime.RECOVERY_RATE_LIMIT,
    USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
    GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as unknown as Env;
}

async function exchange(
  body: unknown,
  runtimeEnv: Env = bindings(),
): Promise<Response> {
  return handleRequest(
    new Request(`${ORIGIN}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
  );
}

function exchangeBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: "google-one-time-code",
    codeVerifier: CODE_VERIFIER,
    redirectUri: LOOPBACK_REDIRECT,
    ...overrides,
  };
}

beforeEach(() => {
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

describe("Google authorization-code exchange", () => {
  it("sends the installed-client secret with the PKCE verifier and returns only the id token", async () => {
    const response = await exchange(exchangeBody());
    expect(response.status).toBe(200);

    expect(tokenCalls).toHaveLength(1);
    const call = tokenCalls[0]!;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    // Google's Desktop/installed client type rejects the exchange without
    // client_secret even though the request carries a PKCE verifier.
    expect(Object.fromEntries(call.parameters)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "google-one-time-code",
      code_verifier: CODE_VERIFIER,
      redirect_uri: LOOPBACK_REDIRECT,
    });

    const payload = await response.json();
    expect(payload).toEqual({
      schemaVersion: "identity-google-exchange-v0.1",
      provider: "google",
      idToken: GOOGLE_ID_TOKEN,
    });
    // The secret and Google's other tokens stay inside the request.
    const serialized = JSON.stringify(payload);
    for (const leak of [
      CLIENT_SECRET,
      "google-access-token",
      "google-refresh-token",
    ]) {
      expect(serialized.includes(leak), leak).toBe(false);
    }
  });

  it("fails closed and exchanges nothing when identity configuration is incomplete", async () => {
    for (const overrides of [
      { GOOGLE_OIDC_CLIENT_SECRET: undefined },
      { GOOGLE_OIDC_CLIENT_SECRET: "" },
      { GOOGLE_OIDC_CLIENT_ID: "" },
    ]) {
      const response = await exchange(exchangeBody(), bindings(overrides));
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
    expect(tokenCalls).toHaveLength(0);
  });

  it("never reaches Google with a malformed or non-loopback exchange", async () => {
    for (const body of [
      exchangeBody({ redirectUri: "https://attacker.example/callback" }),
      exchangeBody({ codeVerifier: "short" }),
      exchangeBody({ code: "" }),
      exchangeBody({ extra: true }),
      [exchangeBody()],
    ]) {
      const rejected = await exchange(body);
      expect(rejected.status, JSON.stringify(body)).toBe(400);
    }

    const crossSite = await handleRequest(
      new Request(`${ORIGIN}${EXCHANGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify(exchangeBody()),
      }),
      bindings(),
    );
    expect(crossSite.status).toBe(403);

    const wrongMethod = await handleRequest(
      new Request(`${ORIGIN}${EXCHANGE_PATH}`, { method: "GET" }),
      bindings(),
    );
    expect(wrongMethod.status).toBe(405);

    expect(tokenCalls).toHaveLength(0);
  });

  it("reports an unusable Google response as an invalid token, not a server fault", async () => {
    tokenResponder = () => new Response("invalid_client", { status: 401 });
    const rejected = await exchange(exchangeBody());
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });

    tokenResponder = () => Response.json({ access_token: "no-id-token" });
    const missingIdToken = await exchange(exchangeBody());
    expect(missingIdToken.status).toBe(401);
    expect(await missingIdToken.json()).toMatchObject({
      error: { code: "IDENTITY_TOKEN_INVALID" },
    });
    expect(tokenCalls).toHaveLength(2);
  });
});
