import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearAdminAccessJwksCacheForTests } from "../src/admin-access";
import { adminHostname } from "../src/admin-ui";
import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const PUBLIC_ORIGIN = "https://example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const ACCESS_TEAM_DOMAIN = "tibotattle.cloudflareaccess.com";
const ACCESS_ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
const ACCESS_AUD = "a".repeat(64);
const ACCESS_KEY_ID = "access-signing-key-1";

let accessKeyPair: CryptoKeyPair;
let accessJwksJson = "";

function base64UrlBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedAccessJwt(
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  signingKey: CryptoKey = accessKeyPair.privateKey,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    kid: ACCESS_KEY_ID,
    typ: "JWT",
    ...headerOverrides,
  };
  const claims = {
    aud: [ACCESS_AUD],
    email: "adamallcock@gmail.com",
    iss: ACCESS_ISSUER,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    sub: "access-subject",
    ...claimOverrides,
  };
  const signedInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(signedInput),
  ));
  return `${signedInput}.${base64UrlBytes(signature)}`;
}

function testBindings(overrides: Record<string, unknown> = {}): Env {
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
  } as unknown as Env;
}

function adminSurfaceBindings(overrides: Record<string, unknown> = {}): Env {
  return testBindings({
    PUBLIC_ORIGIN,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    // The owner pin the admin host authenticates against; the default signed
    // JWT (signedAccessJwt) carries this same email. Tests that exercise the
    // unset/wrong-owner branches override it.
    ACCESS_ADMIN_EMAIL: "adamallcock@gmail.com",
    ACCESS_TEST_JWKS_JSON: accessJwksJson,
    ...overrides,
  });
}

beforeAll(async () => {
  const pairResult = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pairResult)) throw new Error("expected an RSA key pair");
  accessKeyPair = pairResult;
  const publicJwk = await crypto.subtle.exportKey("jwk", pairResult.publicKey);
  accessJwksJson = JSON.stringify({
    keys: [{ ...publicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }],
  });
});

beforeEach(async () => {
  await reset();
  clearAdminAccessJwksCacheForTests();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings.DELETION_LEDGER,
    bindings.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("admin hostname derivation", () => {
  it("derives the admin hostname only from a pinned canonical origin", () => {
    expect(adminHostname(testBindings())).toBeNull();
    expect(adminHostname(testBindings({ PUBLIC_ORIGIN }))).toBe(
      "admin.example.test",
    );
    expect(adminHostname(testBindings({
      PUBLIC_ORIGIN: "https://tibotattle.com",
    }))).toBe("admin.tibotattle.com");
    for (const hostile of [
      "http://example.test",
      "https://example.test/path",
      "not-a-url",
      "",
    ]) {
      expect(adminHostname(testBindings({ PUBLIC_ORIGIN: hostile })), hostile)
        .toBeNull();
    }
  });
});

describe("admin surface hostname gating", () => {
  it("keeps the public origin's deliberate 404 for every admin path", async () => {
    const runtimeEnv = adminSurfaceBindings();
    for (const path of [
      "/admin",
      "/admin.html",
      "/admin.js",
      "/admin-client.js",
      "/admin.css",
    ]) {
      const response = await handleRequest(
        new Request(`${PUBLIC_ORIGIN}${path}`),
        runtimeEnv,
      );
      expect(response.status, path).toBe(404);
    }

    const adminApi = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/v1/admin/overview`),
      runtimeEnv,
    );
    expect(adminApi.status).toBe(404);
    await expect(adminApi.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const adminAction = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/v1/admin/action`, {
        method: "POST",
        headers: {
          origin: PUBLIC_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "run_maintenance" }),
      }),
      runtimeEnv,
    );
    expect(adminAction.status).toBe(404);

    // The rest of the public origin is untouched by the hostname split.
    const health = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/health`),
      runtimeEnv,
    );
    expect(health.status).toBe(200);
  });

  it("keeps single-origin development behaviour when no public origin is pinned", async () => {
    // Without PUBLIC_ORIGIN there is no admin hostname; the admin API stays
    // on its existing fail-closed refusal instead of a hostname 404.
    const response = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/v1/admin/overview`),
      testBindings(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_NOT_CONFIGURED" },
    });
  });

  it("rejects admin-host requests without an Access assertion", async () => {
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/admin.html`),
      adminSurfaceBindings(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ACCESS_REQUIRED" },
    });
  });

  it("rejects invalid Access assertions with 403 and no detail", async () => {
    const runtimeEnv = adminSurfaceBindings();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const foreignKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    if (!("privateKey" in foreignKeyPair)) throw new Error("expected key pair");
    const invalidTokens: Array<[string, string]> = [
      ["malformed", "not-a-jwt"],
      ["two segments", "abc.def"],
      ["unknown kid", await signedAccessJwt({}, { kid: "unknown-key" })],
      [
        "foreign signature",
        await signedAccessJwt({}, {}, foreignKeyPair.privateKey),
      ],
      ["wrong issuer", await signedAccessJwt({ iss: "https://evil.example" })],
      ["wrong audience", await signedAccessJwt({ aud: ["b".repeat(64)] })],
      ["expired", await signedAccessJwt({ exp: nowSeconds - 3600 })],
      ["not yet valid", await signedAccessJwt({ nbf: nowSeconds + 3600 })],
      ["missing expiry", await signedAccessJwt({ exp: undefined })],
      [
        "wrong algorithm",
        await signedAccessJwt({}, { alg: "none" }),
      ],
    ];
    for (const [label, token] of invalidTokens) {
      const response = await handleRequest(
        new Request(`${ADMIN_ORIGIN}/admin.html`, {
          headers: { "cf-access-jwt-assertion": token },
        }),
        runtimeEnv,
      );
      expect(response.status, label).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ACCESS_REQUIRED" },
      });
    }
  });

  it("serves the embedded admin UI on the admin host for a valid assertion", async () => {
    const runtimeEnv = adminSurfaceBindings();
    const token = await signedAccessJwt();
    const expectations: Array<[string, string, RegExp]> = [
      ["/admin.html", "text/html; charset=utf-8", /TiboTattle operations/u],
      ["/admin", "text/html; charset=utf-8", /TiboTattle operations/u],
      ["/admin.js", "text/javascript; charset=utf-8", /admin-client\.js/u],
      [
        "/admin-client.js",
        "text/javascript; charset=utf-8",
        /projectAdminOverview|adminResponseError/u,
      ],
      ["/admin.css", "text/css; charset=utf-8", /admin/u],
    ];
    for (const [path, contentType, marker] of expectations) {
      const response = await handleRequest(
        new Request(`${ADMIN_ORIGIN}${path}`, {
          headers: { "cf-access-jwt-assertion": token },
        }),
        runtimeEnv,
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(contentType);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("x-robots-tag"), path)
        .toBe("noindex, nofollow");
      expect(await response.text(), path).toMatch(marker);
    }
  });

  it("accepts a plain string audience claim from Access", async () => {
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/admin.html`, {
        headers: {
          "cf-access-jwt-assertion": await signedAccessJwt({
            aud: ACCESS_AUD,
          }),
        },
      }),
      adminSurfaceBindings(),
    );
    expect(response.status).toBe(200);
  });

  it("accepts the token from the CF_Authorization cookie when the header is absent", async () => {
    // A Worker on a Custom Domain does not always receive the
    // Cf-Access-Jwt-Assertion header; Access always sets CF_Authorization.
    // The same JWT must verify from the cookie (owner-reported 2026-08-09).
    const token = await signedAccessJwt();
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/admin.html`, {
        headers: { cookie: `CF_Authorization=${token}; other=1` },
      }),
      adminSurfaceBindings(),
    );
    expect(response.status).toBe(200);
    // A cookie without the token is still refused.
    const refused = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/admin.html`, {
        headers: { cookie: "other=1" },
      }),
      adminSurfaceBindings(),
    );
    expect(refused.status).toBe(403);
  });

  it("authenticates the owner from the Access identity and serves the overview", async () => {
    // The first-ever green admin API path: a verified Access JWT whose email is
    // the configured owner reaches the overview with no app __Host- session.
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/overview`, {
        headers: { "cf-access-jwt-assertion": await signedAccessJwt() },
      }),
      adminSurfaceBindings(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "admin-overview-v0.2",
    });
  });

  it("refuses a verified Access identity that is not the configured owner", async () => {
    // Defense in depth beneath the Access allow-policy: a valid JWT for a
    // different email is refused at the router, for the UI and the API alike.
    const token = await signedAccessJwt({ email: "attacker@example.test" });
    const overview = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/overview`, {
        headers: { "cf-access-jwt-assertion": token },
      }),
      adminSurfaceBindings(),
    );
    expect(overview.status).toBe(403);
    await expect(overview.json()).resolves.toMatchObject({
      error: { code: "ADMIN_REQUIRED" },
    });
    const ui = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/admin.html`, {
        headers: { "cf-access-jwt-assertion": token },
      }),
      adminSurfaceBindings(),
    );
    expect(ui.status).toBe(403);
  });

  it("fails closed on the admin host when ACCESS_ADMIN_EMAIL is unset", async () => {
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/overview`, {
        headers: { "cf-access-jwt-assertion": await signedAccessJwt() },
      }),
      adminSurfaceBindings({ ACCESS_ADMIN_EMAIL: undefined }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_NOT_CONFIGURED" },
    });
  });

  it("guards admin actions with a session-independent CSRF check", async () => {
    const token = await signedAccessJwt();
    const body = JSON.stringify({
      action: "set_collection_controls",
      expectedRevision: 1,
      enrollment: true,
      uploadRegistration: true,
      processing: true,
      publication: false,
      reasonCode: "maintenance",
    });
    // Missing the mandatory custom header -> 403 CSRF_INVALID (before any action).
    const noHeader = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": token,
          "content-type": "application/json",
          origin: ADMIN_ORIGIN,
        },
        body,
      }),
      adminSurfaceBindings(),
    );
    expect(noHeader.status).toBe(403);
    await expect(noHeader.json()).resolves.toMatchObject({
      error: { code: "CSRF_INVALID" },
    });
    // A cross-site Origin is refused even with the header (cookie-borne CSRF).
    const crossOrigin = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": token,
          "content-type": "application/json",
          origin: "https://evil.test",
          "x-usage-monitor-admin": "1",
        },
        body,
      }),
      adminSurfaceBindings(),
    );
    expect(crossOrigin.status).toBe(403);
    // Same-origin + the custom header from the real admin page -> succeeds.
    const ok = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": token,
          "content-type": "application/json",
          origin: ADMIN_ORIGIN,
          "x-usage-monitor-admin": "1",
        },
        body,
      }),
      adminSurfaceBindings(),
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      action: "set_collection_controls",
    });
  });

  it("fails closed on the admin host while the Access binding is a placeholder", async () => {
    // Production ships ACCESS_TEAM_DOMAIN/ACCESS_AUD as empty placeholders
    // until the owner creates the Access application; the admin host must
    // refuse everything rather than serve the surface unprotected.
    for (const overrides of [
      { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined },
      { ACCESS_TEAM_DOMAIN: "not-a-team-domain", ACCESS_AUD },
      { ACCESS_TEAM_DOMAIN, ACCESS_AUD: "tooshort" },
    ]) {
      const response = await handleRequest(
        new Request(`${ADMIN_ORIGIN}/admin.html`, {
          headers: { "cf-access-jwt-assertion": await signedAccessJwt() },
        }),
        adminSurfaceBindings(overrides),
      );
      expect(response.status, JSON.stringify(overrides)).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ADMIN_NOT_CONFIGURED" },
      });
    }
  });
});
