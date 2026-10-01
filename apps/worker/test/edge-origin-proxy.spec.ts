import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_SURFACE_PATHS } from "../src/admin-ui";
import { JSON_HEADERS } from "../src/constants";
import {
  cloudflareDistributionFromSegments,
  readCloudflareDistributionSegments,
} from "../src/distribution-analytics";
import {
  EDGE_ADMISSION_BINDINGS,
  EDGE_ADMISSION_POLICY,
  evaluateEdgeAdmission,
} from "../src/edge-admission-policy";
import {
  ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  DROPPED_RESPONSE_HEADERS,
  EDGE_ADMISSION_PURPOSES,
  EDGE_HEADERS,
  EDGE_MAX_FORWARD_BODY_BYTES,
  EDGE_MAX_OVERVIEW_MERGE_BYTES,
  FORWARDED_REQUEST_HEADERS,
  GOOGLE_CALLBACK_PATH,
  MAX_GOOGLE_CALLBACK_URL_LENGTH,
  encodeEdgeAdmission,
  isEdgeRequestId,
  parseEdgeOriginConfiguration,
} from "../src/edge-origin-contract";
import type { EdgeOriginConfiguration } from "../src/edge-origin-contract";
import { EDGE_SUBREQUEST_REAL_IP, EDGE_SUBREQUEST_REAL_IP_HEADER } from "../src/edge-google-subrequest";
import {
  EDGE_ADMIN_API_ROUTE_IDS,
  EDGE_DISTRIBUTION_MERGE_SKIP_REASONS,
  EDGE_PROXY_LOG_EVENTS,
  EDGE_PROXY_OPTIONS_INVALID,
  EDGE_PROXY_UPSTREAM_FAILURE_CODES,
  EDGE_PRE_ADMISSION_GUARDS,
  classifyEdgeRequest,
  createEdgeOriginProxy,
} from "../src/edge-origin-proxy";
import type {
  EdgeOriginProxy,
  EdgeOriginProxyOptions,
  EdgeRequestClass,
} from "../src/edge-origin-proxy";
import { contributionRequestPreflight, handleRequest } from "../src/index";
import { MAX_REQUEST_BYTES } from "../src/constants";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import type { WorkerRouteDefinition } from "../src/route-registry";

// ---------------------------------------------------------------------------
// Synthetic, content-free fixtures. Nothing here is a real host, account,
// address, key or token.

const PUBLIC_ORIGIN = "https://tibotattle.test";
const ADMIN_ORIGIN = "https://admin.tibotattle.test";
const WWW_ORIGIN = "https://www.tibotattle.test";
const UPSTREAM_ORIGIN = "https://edge-origin-synthetic-abc123-uc.a.run.app";
const AUDIENCE = "tibotattle-edge-synthetic-audience";
const INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const CLIENT_ADDRESS = "203.0.113.7";
const CLIENT_KEY_SECRET = "edge-proxy-spec-synthetic-client-key-secret-0000";
const ID_TOKEN = "eyJzeW50aGV0aWMiOiJoZWFkZXIifQ.eyJzeW50aGV0aWMiOiJjbGFpbXMifQ.c3ludGhldGljLXNpZ25hdHVyZQ";
const COOKIE_VALUE = "um_session=synthetic-cookie-value-0001";
const AUTHORIZATION_VALUE = "Bearer synthetic-device-bearer-value-0001";
/** The shape index.ts's contribution preflight accepts; a synthetic credential. */
const UPLOAD_AUTHORIZATION_VALUE = `Upload um_device_upload_00000000-0000-4000-8000-000000000001.${"A".repeat(43)}`;
const SESSION_COOKIE = "__Host-usage_monitor_session=synthetic-session-value-0001";
const BODY_MARKER = "synthetic-body-marker-0001";
const ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
const ACCESS_AUD = "b".repeat(64);
const ACCESS_KEY_ID = "edge-proxy-spec-access-key";
const OWNER_EMAIL = "owner@example.test";
const DISTRIBUTION_ZONE_ID = "0123456789abcdef0123456789abcdef";
const DISTRIBUTION_API_TOKEN = "synthetic-distribution-api-token-0001";
const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const ANALYTICS_CLIENT_ADDRESS = "198.51.100.23";
const ANALYTICS_USER_AGENT = "Sparkle TiboTattle/0.1.23 synthetic-agent";
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;

function configuration(timeoutSeconds = "100"): EdgeOriginConfiguration {
  const settings: Record<string, string> = {
    EDGE_UPSTREAM_ORIGIN: UPSTREAM_ORIGIN,
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: timeoutSeconds,
  };
  const parsed = parseEdgeOriginConfiguration((name) => settings[name]);
  if (parsed === null) throw new Error("synthetic configuration must parse");
  return parsed;
}

const CONFIG = configuration();

// ---------------------------------------------------------------------------
// Access tokens (ACCESS_TEST_JWKS_JSON path of admin-access.ts)

let accessKeyPair: CryptoKeyPair;
let accessJwksJson = "";
const issuedSecrets = new Set<string>([
  ID_TOKEN,
  CLIENT_KEY_SECRET,
  DISTRIBUTION_API_TOKEN,
  "synthetic-cookie-value-0001",
  "synthetic-device-bearer-value-0001",
  UPLOAD_AUTHORIZATION_VALUE,
  "synthetic-session-value-0001",
]);

function base64UrlBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function accessJwt(claimOverrides: Record<string, unknown> = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" };
  const claims = {
    aud: [ACCESS_AUD],
    email: OWNER_EMAIL,
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    sub: "synthetic-access-subject",
    ...claimOverrides,
  };
  const signedInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessKeyPair.privateKey,
    new TextEncoder().encode(signedInput),
  ));
  const token = `${signedInput}.${base64UrlBytes(signature)}`;
  issuedSecrets.add(token);
  return token;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new Error("expected an RSA key pair");
  accessKeyPair = pair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  accessJwksJson = JSON.stringify({
    keys: [{ ...publicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }],
  });
});

// ---------------------------------------------------------------------------
// Environments

const syntheticAssets = {
  async fetch(): Promise<Response> {
    return new Response("<!doctype html><p>synthetic public asset</p>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  },
};

function localEnv(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    ENVIRONMENT: "production",
    PUBLIC_ORIGIN,
    PUBLIC_ANALYTICS_MODE: "enabled",
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
    ACCESS_TEST_JWKS_JSON: accessJwksJson,
    ASSETS: syntheticAssets,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete values[name];
  }
  return Object.freeze(values) as unknown as Env;
}

function guardEnv(): Env {
  // The guard env is a distinct object; its contents are E5's concern.
  return Object.freeze({ ...localEnv(), SPARKLE_APPCAST_GUARD_MODE: "disabled" }) as unknown as Env;
}

// ---------------------------------------------------------------------------
// Harness

/** Every line any proxy in this file logged, checked once at the end. */
const ALL_LOG_LINES: string[] = [];

interface LimiterCall {
  readonly binding: string;
  readonly key: string;
}

type LimiterAnswer = boolean | "throw";

const ALL_RATE_LIMIT_BINDINGS = [
  ...EDGE_ADMISSION_BINDINGS,
  "UPLOAD_AUTHORIZATION_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
] as const;

function recordingLimiters(
  answer: (callNumber: number) => LimiterAnswer = () => true,
): { calls: LimiterCall[]; limiters: Record<string, RateLimit> } {
  const calls: LimiterCall[] = [];
  const limiters: Record<string, RateLimit> = {};
  for (const binding of ALL_RATE_LIMIT_BINDINGS) {
    limiters[binding] = {
      async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
        calls.push({ binding, key });
        const result = answer(calls.length);
        if (result === "throw") throw new Error("synthetic limiter failure");
        return { success: result };
      },
    };
  }
  return { calls, limiters };
}

type Fetcher = (request: Request) => Promise<Response>;

interface HarnessOptions {
  readonly fetcher?: Fetcher;
  readonly getToken?: () => Promise<string>;
  readonly limiterAnswer?: (callNumber: number) => LimiterAnswer;
  readonly distribution?: { zoneId: string; apiToken: string } | null;
  readonly clock?: () => number;
  readonly handle?: (request: Request, env: Env) => Promise<Response>;
  readonly config?: EdgeOriginConfiguration;
}

interface Harness {
  readonly proxy: EdgeOriginProxy;
  readonly fetched: Request[];
  readonly tokenCalls: () => number;
  readonly limiterCalls: LimiterCall[];
  readonly logs: string[];
  readonly handled: Env[];
}

function markedResponse(body: BodyInit | null = "{\"ok\":true}", init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set(EDGE_HEADERS.originMarker, "1");
  return new Response(body, { ...init, headers });
}

function harness(options: HarnessOptions = {}): Harness {
  const fetched: Request[] = [];
  const logs: string[] = [];
  const handled: Env[] = [];
  let tokens = 0;
  const { calls, limiters } = recordingLimiters(options.limiterAnswer);
  const record = (line: string) => {
    logs.push(line);
    ALL_LOG_LINES.push(line);
  };
  const fetcher = options.fetcher ?? (async () => markedResponse());
  const proxy = createEdgeOriginProxy({
    config: options.config ?? CONFIG,
    handleRequest: async (request, env) => {
      handled.push(env);
      return (options.handle ?? handleRequest)(request, env);
    },
    contributionRequestPreflight,
    idTokenSource: {
      getToken: () => {
        tokens += 1;
        return options.getToken === undefined ? Promise.resolve(ID_TOKEN) : options.getToken();
      },
    },
    clientKeySecret: CLIENT_KEY_SECRET,
    limiters,
    distribution: options.distribution ?? null,
    fetcher: async (request) => {
      fetched.push(request);
      return fetcher(request);
    },
    logger: { warn: record, error: record },
    clock: options.clock ?? (() => NOW),
  });
  return { proxy, fetched, tokenCalls: () => tokens, limiterCalls: calls, logs, handled };
}

function upstreamOnly(h: Harness): Request[] {
  return h.fetched.filter((request) => new URL(request.url).origin === UPSTREAM_ORIGIN);
}

function onlyUpstream(h: Harness): Request {
  const requests = upstreamOnly(h);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

interface Snapshot {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly setCookies: readonly string[];
  readonly body: string;
}

async function snapshot(response: Response): Promise<Snapshot> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers].filter(([name]) => name !== "set-cookie").sort(),
    setCookies: response.headers.getSetCookie(),
    body: (await response.text()).replaceAll(UUID_PATTERN, "<request-id>"),
  };
}

function exactRoute(id: string): WorkerRouteDefinition {
  const route = WORKER_ROUTE_POLICY.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`unknown route ${id}`);
  return route;
}

function routeMethod(route: WorkerRouteDefinition): string {
  return route.methods === "all" ? "GET" : route.methods[0]!;
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
}

function requestFor(
  origin: string,
  route: WorkerRouteDefinition,
  init: RequestOptions = {},
): Request {
  const method = init.method ?? routeMethod(route);
  const bodied = method !== "GET" && method !== "HEAD";
  return new Request(`${origin}${route.pathname}`, {
    method,
    headers: {
      "cf-connecting-ip": CLIENT_ADDRESS,
      ...(bodied ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: bodied ? (init.body ?? `{"marker":"${BODY_MARKER}"}`) : null,
  });
}

/**
 * requestFor plus what every pre-admission guard admits: the request's own
 * origin (assertSameOrigin) and a well-formed upload bearer (the contribution
 * preflight). No session cookie.
 */
function admittedRequestFor(
  origin: string,
  route: WorkerRouteDefinition,
  init: RequestOptions = {},
): Request {
  return requestFor(origin, route, {
    ...init,
    headers: { origin, authorization: UPLOAD_AUTHORIZATION_VALUE, ...init.headers },
  });
}

async function envelope(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** admission.ts's keyed client subject, recomputed independently. */
async function clientSubjectKey(purpose: string, subject = CLIENT_ADDRESS): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CLIENT_KEY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`app-usagemonitor/rate-limit/v1\0${purpose}\0${subject}`),
  ));
}

function expectNoUpstreamCalls(h: Harness): void {
  expect(h.fetched).toHaveLength(0);
  expect(h.tokenCalls()).toBe(0);
  expect(h.limiterCalls).toHaveLength(0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("classifyEdgeRequest", () => {
  it("names the six admin API ids exactly as the registry's admin authority", () => {
    expect([...EDGE_ADMIN_API_ROUTE_IDS].sort()).toStrictEqual(
      WORKER_ROUTE_POLICY.filter((route) => route.authority === "admin")
        .map((route) => route.id).sort(),
    );
    expect(Object.isFrozen(EDGE_ADMIN_API_ROUTE_IDS)).toBe(true);
    expect(EDGE_PROXY_UPSTREAM_FAILURE_CODES).toStrictEqual([
      "EDGE_TOKEN_UNAVAILABLE",
      "EDGE_UPSTREAM_TIMEOUT",
      "EDGE_UPSTREAM_NETWORK",
      "EDGE_UPSTREAM_UNMARKED",
    ]);
    expect(EDGE_PROXY_LOG_EVENTS).toStrictEqual([
      "edge_upstream_unavailable",
      "edge_admin_chokepoint_refused",
      "edge_distribution_merge_skipped",
    ]);
    expect(Object.isFrozen(EDGE_PROXY_UPSTREAM_FAILURE_CODES)).toBe(true);
    expect(Object.isFrozen(EDGE_PROXY_LOG_EVENTS)).toBe(true);
  });

  it("forwards exactly the registry (route, method) pairs that are not edge-local", () => {
    const env = localEnv();
    for (const route of WORKER_ROUTE_POLICY) {
      if (route.methods === "all") continue;
      for (const method of route.methods) {
        const apex = classifyEdgeRequest(new Request(`${PUBLIC_ORIGIN}${route.pathname}`, { method }), env);
        const admin = classifyEdgeRequest(new Request(`${ADMIN_ORIGIN}${route.pathname}`, { method }), env);
        const adminApi = (EDGE_ADMIN_API_ROUTE_IDS as readonly string[]).includes(route.id);
        if (route.id === "sparkle_appcast_guard") {
          expect(apex).toStrictEqual({ kind: "guard", routeId: route.id });
          expect(admin).toStrictEqual({ kind: "guard", routeId: route.id });
        } else if (adminApi) {
          expect(apex).toStrictEqual({ kind: "local", reason: "admin_api_on_apex", routeId: route.id });
          expect(admin).toStrictEqual({ kind: "forward", routeId: route.id, hostKind: "admin" });
        } else {
          expect(apex).toStrictEqual({ kind: "forward", routeId: route.id, hostKind: "apex" });
          expect(admin).toStrictEqual({ kind: "forward", routeId: route.id, hostKind: "admin" });
        }
      }
    }
  });

  it("keeps every method of the admin API ids on the admin host for the origin", () => {
    for (const id of EDGE_ADMIN_API_ROUTE_IDS) {
      const route = exactRoute(id);
      for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
        expect(classifyEdgeRequest(
          new Request(`${ADMIN_ORIGIN}${route.pathname}`, { method }),
          localEnv(),
        )).toStrictEqual({ kind: "forward", routeId: id, hostKind: "admin" });
      }
    }
  });

  it("is pure: it reads only the request URL, method and the edge-local env", () => {
    const env = localEnv({ PUBLIC_ANALYTICS_MODE: "disabled" });
    const request = new Request(`${PUBLIC_ORIGIN}/api/v1/community/daily`, {
      headers: { cookie: COOKIE_VALUE },
    });
    const expected: EdgeRequestClass = {
      kind: "local",
      reason: "publication_mode_disabled",
      routeId: "community_daily",
    };
    expect(classifyEdgeRequest(request, env)).toStrictEqual(expected);
    expect(classifyEdgeRequest(request, env)).toStrictEqual(expected);
    expect(request.bodyUsed).toBe(false);
  });
});

describe("createEdgeOriginProxy options", () => {
  function options(overrides: Partial<Record<keyof EdgeOriginProxyOptions, unknown>>): EdgeOriginProxyOptions {
    return {
      config: CONFIG,
      handleRequest,
      contributionRequestPreflight,
      idTokenSource: { getToken: async () => ID_TOKEN },
      clientKeySecret: CLIENT_KEY_SECRET,
      limiters: {},
      distribution: null,
      ...overrides,
    } as unknown as EdgeOriginProxyOptions;
  }

  it("refuses malformed options with one content-free error", () => {
    const invalid: Partial<Record<keyof EdgeOriginProxyOptions, unknown>>[] = [
      { config: null },
      { config: { ...CONFIG, upstreamHeadersTimeoutSeconds: 1 } },
      { config: { ...CONFIG, upstreamOrigin: "https://origin.example.test" } },
      { config: { ...CONFIG, invokerServiceAccount: "someone@example.test" } },
      { handleRequest: undefined },
      { contributionRequestPreflight: undefined },
      { contributionRequestPreflight: "preflight" },
      { idTokenSource: {} },
      { clientKeySecret: "x".repeat(31) },
      { limiters: null },
      { distribution: { zoneId: "", apiToken: DISTRIBUTION_API_TOKEN } },
      { distribution: { zoneId: DISTRIBUTION_ZONE_ID } },
      { fetcher: "fetch" },
      { logger: { warn: () => undefined } },
      { clock: 0 },
    ];
    for (const override of invalid) {
      expect(() => createEdgeOriginProxy(options(override)), JSON.stringify(Object.keys(override)))
        .toThrowError(new TypeError(EDGE_PROXY_OPTIONS_INVALID));
    }
    expect(() => createEdgeOriginProxy(options({}))).not.toThrow();
  });

  it("defaults to the global fetch, resolved at call time and called unbound", async () => {
    const seen: { request: Request; self: unknown }[] = [];
    const proxy = createEdgeOriginProxy(options({
      limiters: recordingLimiters().limiters,
      logger: { warn: (line: string) => ALL_LOG_LINES.push(line), error: (line: string) => ALL_LOG_LINES.push(line) },
    }));
    vi.stubGlobal("fetch", function (this: unknown, request: Request) {
      seen.push({ request, self: this });
      return Promise.resolve(markedResponse("{\"health\":true}"));
    });
    const response = await proxy(new Request(`${PUBLIC_ORIGIN}/api/health`), localEnv(), guardEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{\"health\":true}");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.self).toBeUndefined();
    expect(seen[0]!.request.url).toBe(`${UPSTREAM_ORIGIN}/api/health`);
  });
});

describe("edge-local classes", () => {
  interface LocalRow {
    readonly name: string;
    readonly request: () => Promise<Request> | Request;
    readonly env?: () => Env;
    readonly reason: string;
    readonly status: number;
    readonly expect?: (response: Snapshot) => void;
  }

  const adminUiPath = ADMIN_SURFACE_PATHS.find((path) => path !== "/admin");
  if (adminUiPath === undefined) throw new Error("expected an admin UI asset path");

  const rows: LocalRow[] = [
    {
      name: "www GET",
      request: () => new Request(`${WWW_ORIGIN}/privacy?ref=1`),
      reason: "www",
      status: 308,
      expect: (response) => expect(response.headers).toContainEqual(["location", `${PUBLIC_ORIGIN}/privacy?ref=1`]),
    },
    {
      name: "www POST of an API route",
      request: () => requestFor(WWW_ORIGIN, exactRoute("contributions")),
      reason: "www",
      status: 308,
    },
    {
      name: "www unknown API path",
      request: () => new Request(`${WWW_ORIGIN}/api/x`),
      reason: "www",
      status: 308,
    },
    {
      name: "www network-path reference",
      request: () => new Request(`${WWW_ORIGIN}//evil.example/x`),
      reason: "www",
      status: 308,
      expect: (response) => expect(response.headers).toContainEqual(["location", `${PUBLIC_ORIGIN}/evil.example/x`]),
    },
    { name: "apex /admin", request: () => new Request(`${PUBLIC_ORIGIN}/admin`), reason: "asset", status: 404 },
    { name: "apex admin UI path", request: () => new Request(`${PUBLIC_ORIGIN}${adminUiPath}`), reason: "asset", status: 404 },
    { name: "apex public asset", request: () => new Request(`${PUBLIC_ORIGIN}/index.html`), reason: "asset", status: 200 },
    ...EDGE_ADMIN_API_ROUTE_IDS.map((id): LocalRow => ({
      name: `apex ${id}`,
      request: () => requestFor(PUBLIC_ORIGIN, exactRoute(id)),
      reason: "admin_api_on_apex",
      status: 404,
    })),
    {
      name: "Apple path GET",
      request: () => new Request(`${PUBLIC_ORIGIN}/.well-known/apple-developer-domain-association.txt`),
      reason: "apple_domain_association",
      status: 404,
    },
    {
      name: "Apple path POST",
      request: () => new Request(`${PUBLIC_ORIGIN}/.well-known/apple-developer-domain-association.txt`, { method: "POST", body: "x" }),
      reason: "apple_domain_association",
      status: 404,
    },
    { name: "unknown API path", request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/nope`), reason: "unknown_api", status: 404 },
    {
      name: "retired DELETE /api/v1/me",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/me`, { method: "DELETE", headers: { cookie: COOKIE_VALUE } }),
      reason: "unknown_api",
      status: 404,
    },
    {
      name: "POST /api/v1/session",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/session`, { method: "POST", body: "{}" }),
      reason: "method_not_allowed",
      status: 405,
      expect: (response) => expect(response.headers).toContainEqual(["allow", "GET"]),
    },
    {
      name: "PUT v1.2 day manifests",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/device/telemetry/v1.2/day-manifests`, { method: "PUT", body: "{}" }),
      reason: "method_not_allowed",
      status: 405,
      expect: (response) => expect(response.headers).toContainEqual(["allow", "GET, POST"]),
    },
    {
      name: "HEAD /api/health",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/health`, { method: "HEAD" }),
      reason: "method_not_allowed",
      status: 405,
      expect: (response) => expect(response.headers).toContainEqual(["allow", "GET"]),
    },
    {
      name: "OPTIONS /api/v1/contributions",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/contributions`, { method: "OPTIONS" }),
      reason: "method_not_allowed",
      status: 405,
      expect: (response) => expect(response.headers).toContainEqual(["allow", "POST"]),
    },
    {
      name: "community/daily on the apex while publication is disabled",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/community/daily?from=2026-09-01`),
      env: () => localEnv({ PUBLIC_ANALYTICS_MODE: "disabled" }),
      reason: "publication_mode_disabled",
      status: 503,
      expect: (response) => {
        expect(response.headers).toContainEqual(["cache-control", "no-store"]);
        expect(response.body).toContain("\"PUBLICATION_DISABLED\"");
      },
    },
    {
      name: "community/daily on the apex while publication is unset",
      request: () => new Request(`${PUBLIC_ORIGIN}/api/v1/community/daily`),
      env: () => localEnv({ PUBLIC_ANALYTICS_MODE: undefined }),
      reason: "publication_mode_disabled",
      status: 503,
    },
    {
      name: "community/daily on the admin host while publication is disabled",
      request: async () => new Request(`${ADMIN_ORIGIN}/api/v1/community/daily`, {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      env: () => localEnv({ PUBLIC_ANALYTICS_MODE: "disabled" }),
      reason: "publication_mode_disabled",
      status: 503,
      expect: (response) => {
        expect(response.headers).toContainEqual(["cache-control", "no-store"]);
        expect(response.body).toContain("\"PUBLICATION_DISABLED\"");
      },
    },
    {
      name: "admin-host UI without an Access token",
      request: () => new Request(`${ADMIN_ORIGIN}/admin`),
      reason: "asset",
      status: 403,
    },
    {
      name: "admin-host UI with the owner's Access token",
      request: async () => new Request(`${ADMIN_ORIGIN}/admin`, {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      reason: "asset",
      status: 200,
    },
    {
      name: "admin-host non-UI asset with the owner's Access token",
      request: async () => new Request(`${ADMIN_ORIGIN}/index.html`, {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      reason: "asset",
      status: 200,
    },
    {
      name: "admin-host unknown API path with a non-owner token",
      request: async () => new Request(`${ADMIN_ORIGIN}/api/v1/nope`, {
        headers: { "cf-access-jwt-assertion": await accessJwt({ email: "other@example.test" }) },
      }),
      reason: "unknown_api",
      status: 403,
    },
  ];

  for (const row of rows) {
    it(`${row.name}: equals handleRequest and touches nothing upstream`, async () => {
      const env = row.env?.() ?? localEnv();
      const original = await row.request();
      const twin = original.clone();
      const classification = classifyEdgeRequest(original, env);
      expect(classification.kind).toBe("local");
      expect(classification.kind === "local" ? classification.reason : null).toBe(row.reason);
      const h = harness();
      const edge = await snapshot(await h.proxy(original, env, guardEnv()));
      const worker = await snapshot(await handleRequest(twin, env));
      expect(edge).toStrictEqual(worker);
      expect(edge.status).toBe(row.status);
      row.expect?.(edge);
      expectNoUpstreamCalls(h);
      expect(h.handled).toHaveLength(1);
      expect(h.handled[0]).toBe(env);
      expect(h.logs).toStrictEqual([]);
    });
  }

  it("serves the Sparkle guard with guardEnv and never forwards it", async () => {
    const route = exactRoute("sparkle_appcast_guard");
    const env = localEnv();
    const guard = guardEnv();
    const original = requestFor(PUBLIC_ORIGIN, route, {
      headers: {
        "x-usage-monitor-release-timestamp": "1790000000",
        "x-usage-monitor-release-nonce": "synthetic-nonce",
        "x-usage-monitor-release-signature": "synthetic-signature",
      },
    });
    const twin = original.clone();
    const h = harness();
    const edge = await snapshot(await h.proxy(original, env, guard));
    const worker = await snapshot(await handleRequest(twin, guard));
    expect(edge).toStrictEqual(worker);
    expect(h.handled).toHaveLength(1);
    expect(h.handled[0]).toBe(guard);
    expectNoUpstreamCalls(h);

    // A method outside the registry stays an ordinary local 405 on localEnv.
    const wrongMethod = harness();
    const refused = await wrongMethod.proxy(
      new Request(`${PUBLIC_ORIGIN}${route.pathname}`),
      env,
      guard,
    );
    expect(refused.status).toBe(405);
    expect(wrongMethod.handled[0]).toBe(env);
    expectNoUpstreamCalls(wrongMethod);
  });
});

describe("admin-host chokepoint", () => {
  const overview = exactRoute("admin_overview");

  const refusals: { name: string; request: () => Promise<Request>; env?: () => Env; status: number; level: string }[] = [
    { name: "no token", request: async () => requestFor(ADMIN_ORIGIN, overview), status: 403, level: "warn" },
    {
      name: "malformed token",
      request: async () => requestFor(ADMIN_ORIGIN, overview, { headers: { "cf-access-jwt-assertion": "not.a.jwt" } }),
      status: 403,
      level: "warn",
    },
    {
      name: "wrong audience",
      request: async () => requestFor(ADMIN_ORIGIN, overview, {
        headers: { "cf-access-jwt-assertion": await accessJwt({ aud: ["c".repeat(64)] }) },
      }),
      status: 403,
      level: "warn",
    },
    {
      name: "non-owner",
      request: async () => requestFor(ADMIN_ORIGIN, overview, {
        headers: { "cf-access-jwt-assertion": await accessJwt({ email: "other@example.test" }) },
      }),
      status: 403,
      level: "warn",
    },
    {
      name: "missing ACCESS_ADMIN_EMAIL",
      request: async () => requestFor(ADMIN_ORIGIN, overview, {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      env: () => localEnv({ ACCESS_ADMIN_EMAIL: undefined }),
      status: 503,
      level: "error",
    },
  ];

  for (const row of refusals) {
    it(`${row.name}: renders handleRequest's refusal without forwarding`, async () => {
      const env = row.env?.() ?? localEnv();
      const original = await row.request();
      const twin = original.clone();
      const h = harness();
      const edge = await snapshot(await h.proxy(original, env, guardEnv()));
      const worker = await snapshot(await handleRequest(twin, env));
      expect(edge).toStrictEqual(worker);
      expect(edge.status).toBe(row.status);
      expect(edge.headers.map(([name]) => name)).not.toContain("allow");
      expectNoUpstreamCalls(h);
      expect(h.handled).toHaveLength(0);
      expect(h.logs).toHaveLength(1);
      const line = JSON.parse(h.logs[0]!) as Record<string, unknown>;
      expect(line).toMatchObject({
        level: row.level,
        event: "edge_admin_chokepoint_refused",
        method: "GET",
        routeClass: "admin_overview",
        status: row.status,
      });
    });
  }

  it("forwards the owner with the Access assertion and cookie; the apex never forwards the assertion", async () => {
    const token = await accessJwt();
    const h = harness();
    const response = await h.proxy(
      requestFor(ADMIN_ORIGIN, exactRoute("admin_metrics_history"), {
        headers: { "cf-access-jwt-assertion": token, cookie: COOKIE_VALUE },
      }),
      localEnv(),
      guardEnv(),
    );
    expect(response.status).toBe(200);
    const upstream = onlyUpstream(h);
    expect(upstream.headers.get("cf-access-jwt-assertion")).toBe(token);
    expect(upstream.headers.get("cookie")).toBe(COOKIE_VALUE);
    expect(upstream.headers.get(EDGE_HEADERS.host)).toBe("admin");

    const viaCookie = harness();
    const cookieToken = await accessJwt();
    expect((await viaCookie.proxy(
      requestFor(ADMIN_ORIGIN, exactRoute("admin_database_health"), {
        headers: { cookie: `CF_Authorization=${cookieToken}` },
      }),
      localEnv(),
      guardEnv(),
    )).status).toBe(200);
    expect(onlyUpstream(viaCookie).headers.get("cookie")).toBe(`CF_Authorization=${cookieToken}`);

    const apex = harness();
    await apex.proxy(
      requestFor(PUBLIC_ORIGIN, exactRoute("session"), {
        headers: { "cf-access-jwt-assertion": token, cookie: COOKIE_VALUE },
      }),
      localEnv(),
      guardEnv(),
    );
    const apexUpstream = onlyUpstream(apex);
    expect(apexUpstream.headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(apexUpstream.headers.get("cookie")).toBe(COOKIE_VALUE);
    expect(apexUpstream.headers.get(EDGE_HEADERS.host)).toBe("apex");
  });

  it("forwards a non-registry method of an admin API id after the chokepoint", async () => {
    const h = harness();
    await h.proxy(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
        method: "GET",
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      localEnv(),
      guardEnv(),
    );
    expect(onlyUpstream(h).method).toBe("GET");

    const refused = harness();
    const response = await refused.proxy(
      new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, { method: "GET" }),
      localEnv(),
      guardEnv(),
    );
    expect(response.status).toBe(403);
    expectNoUpstreamCalls(refused);
  });
});

describe("admission", () => {
  const policyRoutes = Object.keys(EDGE_ADMISSION_POLICY);

  const scenarios: { name: string; answer: (callNumber: number) => LimiterAnswer; outcome: string }[] = [
    { name: "allowed", answer: () => true, outcome: "allowed" },
    { name: "first limiter limited", answer: (callNumber) => callNumber !== 1, outcome: "limited" },
    { name: "second limiter limited", answer: (callNumber) => callNumber !== 2, outcome: "limited" },
    { name: "throwing limiter", answer: () => "throw", outcome: "unavailable" },
  ];

  it("covers all 24 EP-1 policy routes", () => {
    expect(policyRoutes).toHaveLength(24);
  });

  for (const scenario of scenarios) {
    it(`forwards the encoded edge evaluation for every policy route (${scenario.name})`, async () => {
      for (const routeId of policyRoutes) {
        const route = exactRoute(routeId);
        const policy = EDGE_ADMISSION_POLICY[routeId as keyof typeof EDGE_ADMISSION_POLICY]!;
        // A single-binding policy has no second call: its first call decides.
        const singleCall = policy.coarseBinding === null;
        const expectedOutcome = singleCall && scenario.name === "second limiter limited"
          ? "allowed"
          : scenario.outcome;
        const reference = recordingLimiters(scenario.answer);
        const expected = await evaluateEdgeAdmission({
          routeId,
          request: admittedRequestFor(PUBLIC_ORIGIN, route),
          limiters: reference.limiters,
          clientKeySecret: CLIENT_KEY_SECRET,
        });
        expect(expected).not.toBeNull();
        expect(expected!.outcome).toBe(expectedOutcome);

        const h = harness({ limiterAnswer: scenario.answer });
        await h.proxy(admittedRequestFor(PUBLIC_ORIGIN, route), localEnv(), guardEnv());
        const upstream = onlyUpstream(h);
        expect(upstream.headers.get(EDGE_HEADERS.admission), routeId)
          .toBe(encodeEdgeAdmission(expected!));
        expect(upstream.headers.get(EDGE_HEADERS.admission))
          .toBe(`v1;${policy.purpose};${expectedOutcome}`);
        expect(h.limiterCalls, routeId).toStrictEqual(reference.calls);
      }
    });
  }

  it("sends no admission header and touches no limiter for every other forwarded route", async () => {
    const owner = await accessJwt();
    const checked: string[] = [];
    for (const route of WORKER_ROUTE_POLICY) {
      if (Object.hasOwn(EDGE_ADMISSION_POLICY, route.id) || route.methods === "all"
          || route.id === "sparkle_appcast_guard") continue;
      const adminApi = (EDGE_ADMIN_API_ROUTE_IDS as readonly string[]).includes(route.id);
      const request = adminApi
        ? requestFor(ADMIN_ORIGIN, route, { headers: { "cf-access-jwt-assertion": owner } })
        : requestFor(PUBLIC_ORIGIN, route);
      const h = harness();
      await h.proxy(request, localEnv(), guardEnv());
      const upstream = onlyUpstream(h);
      expect(upstream.headers.has(EDGE_HEADERS.admission), route.id).toBe(false);
      expect(h.limiterCalls, route.id).toStrictEqual([]);
      checked.push(route.id);
    }
    expect(checked).toContain("device_upload_authorization");
    expect(checked).toContain("health");
    expect(checked).toContain("admin_action");
    expect(checked).toHaveLength(WORKER_ROUTE_POLICY.length - 24 - 2);
  });
});

describe("request bodies", () => {
  const contributions = exactRoute("contributions");
  // A body route with no pre-admission guard, so only the edge's own forward
  // cap stands between the request and admission.
  const deviceDisconnect = exactRoute("device_disconnect");

  it("has no pre-admission guard on the cap's reference route", () => {
    expect(Object.hasOwn(EDGE_PRE_ADMISSION_GUARDS, deviceDisconnect.id)).toBe(false);
    expect(deviceDisconnect.methods).toStrictEqual(["POST"]);
  });

  it("refuses a declared length above 8 MiB locally, before any limiter", async () => {
    const h = harness();
    const response = await h.proxy(
      requestFor(PUBLIC_ORIGIN, deviceDisconnect, {
        headers: { "content-length": String(EDGE_MAX_FORWARD_BODY_BYTES + 1) },
      }),
      localEnv(),
      guardEnv(),
    );
    expect(response.status).toBe(413);
    expect(Object.fromEntries(response.headers)).toStrictEqual({ ...JSON_HEADERS });
    const body = await envelope(response) as { error: { code: string; requestId: string } };
    expect(Object.keys(body)).toStrictEqual(["error"]);
    expect(Object.keys(body.error)).toStrictEqual(["code", "requestId"]);
    expect(body.error.code).toBe("BODY_TOO_LARGE");
    expect(isEdgeRequestId(body.error.requestId)).toBe(true);
    expectNoUpstreamCalls(h);
  });

  it("forwards a declared length of exactly 8 MiB, and a malformed one untouched", async () => {
    for (const declared of [String(EDGE_MAX_FORWARD_BODY_BYTES), "12abc", "-1", "1e3"]) {
      const h = harness();
      await h.proxy(
        requestFor(PUBLIC_ORIGIN, deviceDisconnect, { headers: { "content-length": declared } }),
        localEnv(),
        guardEnv(),
      );
      expect(onlyUpstream(h).headers.get("content-length"), declared).toBe(declared);
      expect(h.limiterCalls.length, declared).toBe(2);
    }
  });

  it("never checks or forwards a declared length on a bodyless GET", async () => {
    const h = harness();
    const response = await h.proxy(
      requestFor(PUBLIC_ORIGIN, exactRoute("device_sync_state"), {
        headers: { "content-length": String(EDGE_MAX_FORWARD_BODY_BYTES * 4) },
      }),
      localEnv(),
      guardEnv(),
    );
    expect(response.status).toBe(200);
    const upstream = onlyUpstream(h);
    expect(upstream.headers.has("content-length")).toBe(false);
    expect(upstream.body).toBeNull();
  });

  it("streams an undeclared body without buffering it", async () => {
    let clientController!: ReadableStreamDefaultController<Uint8Array>;
    const clientBody = new ReadableStream<Uint8Array>({
      start(controller) {
        clientController = controller;
      },
    });
    const h = harness({
      // The fake origin echoes the request body as it arrives.
      fetcher: async (request) => markedResponse(request.body, {
        headers: { "content-type": "application/octet-stream" },
      }),
    });
    const responsePromise = h.proxy(
      new Request(`${PUBLIC_ORIGIN}${contributions.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: UPLOAD_AUTHORIZATION_VALUE },
        body: clientBody,
      }),
      localEnv(),
      guardEnv(),
    );
    // The proxy returns headers while the client body is still open.
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("proxy buffered the body")), 2_000)),
    ]);
    expect(response.status).toBe(200);
    expect(onlyUpstream(h).headers.has("content-length")).toBe(false);
    const encoder = new TextEncoder();
    clientController.enqueue(encoder.encode("{\"first\":"));
    clientController.enqueue(encoder.encode(`"${BODY_MARKER}"}`));
    clientController.close();
    expect(await response.text()).toBe(`{"first":"${BODY_MARKER}"}`);
  });
});

describe("pre-admission guards", () => {
  const contributions = exactRoute("contributions");
  const NINE_MIB = String(9 * 1024 * 1024);

  async function expectLocalRefusal(
    h: Harness,
    response: Response,
    status: number,
    code: string,
    label: string,
  ): Promise<void> {
    expect(response.status, label).toBe(status);
    expect(Object.fromEntries(response.headers), label).toStrictEqual({ ...JSON_HEADERS });
    const body = await envelope(response) as { error: { code: string; requestId: string } };
    expect(Object.keys(body.error), label).toStrictEqual(["code", "requestId"]);
    expect(body.error.code, label).toBe(code);
    expect(isEdgeRequestId(body.error.requestId), label).toBe(true);
    expect(h.fetched, label).toHaveLength(0);
    expect(h.tokenCalls(), label).toBe(0);
    expect(h.limiterCalls, label).toStrictEqual([]);
    expect(h.handled, label).toHaveLength(0);
  }

  it("guards only EP-1 policy routes, from a frozen prototype-free map", () => {
    expect(Object.isFrozen(EDGE_PRE_ADMISSION_GUARDS)).toBe(true);
    expect(Object.getPrototypeOf(EDGE_PRE_ADMISSION_GUARDS)).toBeNull();
    expect(Object.hasOwn(EDGE_PRE_ADMISSION_GUARDS, "constructor")).toBe(false);
    for (const routeId of Object.keys(EDGE_PRE_ADMISSION_GUARDS)) {
      expect(Object.hasOwn(EDGE_ADMISSION_POLICY, routeId), routeId).toBe(true);
    }
    expect({ ...EDGE_PRE_ADMISSION_GUARDS }).toStrictEqual({
      accountless_enrollment: "session_cookie",
      accountless_ownership: "session_cookie",
      accountless_telemetry_v12_authorization: "session_cookie",
      accountless_telemetry_performance_authorization: "session_cookie",
      accountless_renewal: "session_cookie",
      enroll: "same_origin",
      identity_google_start: "same_origin",
      identity_apple_start: "same_origin",
      contributions: "contribution_preflight",
    });
  });

  it("answers the contribution preflight in the Worker's order, before the 8 MiB cap and any limiter", async () => {
    const rows: { name: string; headers: Record<string, string>; status: number; code: string }[] = [
      // d43c8f92 index.ts:621-644: session cookie, content type, declared
      // length, body, then the Upload bearer.
      { name: "9 MiB, text/plain", headers: { "content-type": "text/plain", "content-length": NINE_MIB }, status: 415, code: "CONTENT_TYPE_INVALID" },
      { name: "9 MiB, session cookie", headers: { cookie: SESSION_COOKIE, "content-length": NINE_MIB }, status: 401, code: "UPLOAD_AUTH_INVALID" },
      { name: "session cookie and text/plain", headers: { cookie: SESSION_COOKIE, "content-type": "text/plain" }, status: 401, code: "UPLOAD_AUTH_INVALID" },
      { name: "content type is case-sensitive", headers: { "content-type": "Application/JSON" }, status: 415, code: "CONTENT_TYPE_INVALID" },
      { name: "9 MiB, JSON", headers: { "content-length": NINE_MIB }, status: 413, code: "BODY_TOO_LARGE" },
      { name: "one byte over the Worker cap", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) }, status: 413, code: "BODY_TOO_LARGE" },
      { name: "malformed declared length", headers: { "content-length": "12abc" }, status: 400, code: "BODY_INVALID" },
      { name: "no Upload bearer", headers: { authorization: AUTHORIZATION_VALUE }, status: 401, code: "UPLOAD_AUTH_INVALID" },
    ];
    for (const row of rows) {
      const h = harness();
      const response = await h.proxy(
        admittedRequestFor(PUBLIC_ORIGIN, contributions, { headers: row.headers }),
        localEnv(),
        guardEnv(),
      );
      await expectLocalRefusal(h, response, row.status, row.code, row.name);
    }
    const noBody = harness();
    await expectLocalRefusal(
      noBody,
      await noBody.proxy(
        new Request(`${PUBLIC_ORIGIN}${contributions.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: UPLOAD_AUTHORIZATION_VALUE },
        }),
        localEnv(),
        guardEnv(),
      ),
      400,
      "BODY_INVALID",
      "no body",
    );
  });

  it("forwards a contribution the preflight admits, with its admission", async () => {
    const admitted: Record<string, string>[] = [
      {},
      { cookie: "unrelated=1" },
      { "content-type": "application/json; charset=utf-8" },
      { "content-length": String(MAX_REQUEST_BYTES) },
    ];
    for (const headers of admitted) {
      const h = harness();
      await h.proxy(admittedRequestFor(PUBLIC_ORIGIN, contributions, { headers }), localEnv(), guardEnv());
      expect(onlyUpstream(h).headers.get(EDGE_HEADERS.admission), JSON.stringify(headers))
        .toBe("v1;upload_ingress;allowed");
      expect(h.limiterCalls, JSON.stringify(headers)).toHaveLength(2);
    }
  });

  it("refuses a session cookie on every accountless route before any limiter, whatever the body size", async () => {
    const accountless = Object.entries(EDGE_PRE_ADMISSION_GUARDS)
      .filter(([, guard]) => guard === "session_cookie")
      .map(([routeId]) => routeId);
    expect(accountless).toHaveLength(5);
    for (const routeId of accountless) {
      const extras: Record<string, string>[] = [{}, { "content-length": NINE_MIB }];
      for (const extra of extras) {
        const h = harness();
        const response = await h.proxy(
          admittedRequestFor(PUBLIC_ORIGIN, exactRoute(routeId), {
            headers: { cookie: `other=1; ${SESSION_COOKIE}`, ...extra },
          }),
          localEnv(),
          guardEnv(),
        );
        await expectLocalRefusal(h, response, 401, "AUTH_INVALID", `${routeId} ${JSON.stringify(extra)}`);
      }
      const admitted = harness();
      await admitted.proxy(
        admittedRequestFor(PUBLIC_ORIGIN, exactRoute(routeId), { headers: { cookie: "other=1" } }),
        localEnv(),
        guardEnv(),
      );
      expect(upstreamOnly(admitted), routeId).toHaveLength(1);
      expect(admitted.limiterCalls, routeId).toHaveLength(2);
    }
  });

  it("refuses a cross-origin enrollment or sign-in start before any limiter", async () => {
    const sameOrigin = Object.entries(EDGE_PRE_ADMISSION_GUARDS)
      .filter(([, guard]) => guard === "same_origin")
      .map(([routeId]) => routeId);
    expect(sameOrigin.sort()).toStrictEqual(["enroll", "identity_apple_start", "identity_google_start"]);
    for (const routeId of sameOrigin) {
      const route = exactRoute(routeId);
      const crossOrigin: Record<string, string>[] = [
        { origin: "https://evil.example" },
        { origin: ADMIN_ORIGIN },
        { "sec-fetch-site": "cross-site" },
        { origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-site" },
      ];
      for (const headers of crossOrigin) {
        const h = harness();
        const response = await h.proxy(admittedRequestFor(PUBLIC_ORIGIN, route, { headers }), localEnv(), guardEnv());
        await expectLocalRefusal(h, response, 403, "CSRF_INVALID", `${routeId} ${JSON.stringify(headers)}`);
      }
      const missing = harness();
      await expectLocalRefusal(
        missing,
        await missing.proxy(requestFor(PUBLIC_ORIGIN, route), localEnv(), guardEnv()),
        403,
        "CSRF_INVALID",
        `${routeId} without origin`,
      );
      const admitted = harness();
      await admitted.proxy(
        admittedRequestFor(PUBLIC_ORIGIN, route, { headers: { "sec-fetch-site": "same-origin" } }),
        localEnv(),
        guardEnv(),
      );
      expect(upstreamOnly(admitted), routeId).toHaveLength(1);
    }
  });

  it("runs the admin-host chokepoint before a guard", async () => {
    const refused = harness();
    const response = await refused.proxy(
      admittedRequestFor(ADMIN_ORIGIN, contributions, { headers: { cookie: SESSION_COOKIE } }),
      localEnv(),
      guardEnv(),
    );
    expect(response.status).toBe(403);
    expect((await envelope(response) as { error: { code: string } }).error.code).toBe("ACCESS_REQUIRED");
    expectNoUpstreamCalls(refused);
    const owner = harness();
    await expectLocalRefusal(
      owner,
      await owner.proxy(
        admittedRequestFor(ADMIN_ORIGIN, contributions, {
          headers: { cookie: SESSION_COOKIE, "cf-access-jwt-assertion": await accessJwt() },
        }),
        localEnv(),
        guardEnv(),
      ),
      401,
      "UPLOAD_AUTH_INVALID",
      "owner on the admin host",
    );
  });

  it("renders a preflight failure that is not an ApiError as handleRequest does, 500 INTERNAL_ERROR", async () => {
    const fetched: Request[] = [];
    const { calls, limiters } = recordingLimiters();
    const proxy = createEdgeOriginProxy({
      config: CONFIG,
      handleRequest,
      contributionRequestPreflight: () => {
        throw new TypeError("synthetic preflight failure");
      },
      idTokenSource: { getToken: async () => ID_TOKEN },
      clientKeySecret: CLIENT_KEY_SECRET,
      limiters,
      distribution: null,
      fetcher: async (request) => {
        fetched.push(request);
        return markedResponse();
      },
      logger: { warn: (line: string) => ALL_LOG_LINES.push(line), error: (line: string) => ALL_LOG_LINES.push(line) },
    });
    const response = await proxy(admittedRequestFor(PUBLIC_ORIGIN, contributions), localEnv(), guardEnv());
    expect(response.status).toBe(500);
    expect((await envelope(response) as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    expect(fetched).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("upstream request headers", () => {
  const hostile = {
    "cf-connecting-ip": CLIENT_ADDRESS,
    "cf-ray": "synthetic-ray",
    "cf-ipcountry": "XX",
    "cf-visitor": "{\"scheme\":\"https\"}",
    "x-forwarded-for": CLIENT_ADDRESS,
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example",
    forwarded: `for=${CLIENT_ADDRESS}`,
    "x-real-ip": CLIENT_ADDRESS,
    "true-client-ip": CLIENT_ADDRESS,
    "user-agent": "synthetic-agent/1.0",
    "accept-language": "en",
    [EDGE_HEADERS.admission]: "v1;public_aggregate_read;allowed",
    [EDGE_HEADERS.host]: "admin",
    [EDGE_HEADERS.requestId]: "00000000-0000-4000-8000-000000000000",
    [EDGE_HEADERS.callbackQuery]: "?code=forged",
    [EDGE_HEADERS.originMarker]: "1",
    "x-tibotattle-anything": "forged",
    "x-serverless-authorization": "Bearer forged",
  };
  const allowlisted: Record<string, string> = {
    "content-type": "application/json",
    authorization: AUTHORIZATION_VALUE,
    cookie: COOKIE_VALUE,
    origin: PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-usage-monitor-csrf": "synthetic-csrf",
    "x-usage-monitor-admin": "1",
    "x-previous-device-authorization": "Bearer synthetic-previous-device-0001",
  };

  async function forbiddenValues(): Promise<string[]> {
    const purposes = [...EDGE_ADMISSION_PURPOSES, "upload_authorization", "public_aggregate_read"];
    const keys = await Promise.all(purposes.map((purpose) => clientSubjectKey(purpose)));
    return [CLIENT_ADDRESS, CLIENT_KEY_SECRET, ...keys, ...keys.map((key) => `client:${key}`)];
  }

  it("sends exactly the allowlist plus the contract headers on the apex", async () => {
    const h = harness();
    await h.proxy(
      requestFor(PUBLIC_ORIGIN, exactRoute("telemetry_v12_day_manifests"), {
        method: "POST",
        headers: { ...hostile, ...allowlisted },
        body: `{"marker":"${BODY_MARKER}"}`,
      }),
      localEnv(),
      guardEnv(),
    );
    const upstream = onlyUpstream(h);
    const names = [...upstream.headers.keys()].sort();
    expect(names).toStrictEqual([
      ...FORWARDED_REQUEST_HEADERS.filter((name) => name !== "content-length"),
      EDGE_HEADERS.admission,
      EDGE_HEADERS.host,
      EDGE_HEADERS.requestId,
      EDGE_HEADERS.invokerToken,
      EDGE_SUBREQUEST_REAL_IP_HEADER,
    ].sort());
    expect(upstream.headers.get(EDGE_SUBREQUEST_REAL_IP_HEADER)).toBe(EDGE_SUBREQUEST_REAL_IP);
    for (const [name, value] of Object.entries(allowlisted)) {
      expect(upstream.headers.get(name), name).toBe(value);
    }
    expect(upstream.headers.get(EDGE_HEADERS.host)).toBe("apex");
    expect(upstream.headers.get(EDGE_HEADERS.admission)).toBe("v1;device_sync;allowed");
    expect(upstream.headers.get(EDGE_HEADERS.invokerToken)).toBe(`Bearer ${ID_TOKEN}`);
    const requestId = upstream.headers.get(EDGE_HEADERS.requestId);
    expect(isEdgeRequestId(requestId)).toBe(true);
    expect(requestId).not.toBe(hostile[EDGE_HEADERS.requestId]);
    expect(await upstream.text()).toBe(`{"marker":"${BODY_MARKER}"}`);
    const forbidden = await forbiddenValues();
    for (const [name, value] of upstream.headers) {
      for (const candidate of forbidden) {
        expect(value.includes(candidate), `${name} carries a client-derived value`).toBe(false);
      }
    }
    expect(upstream.url.includes(CLIENT_ADDRESS)).toBe(false);
  });

  it("adds only the Access assertion on the admin host", async () => {
    const token = await accessJwt();
    const h = harness();
    await h.proxy(
      requestFor(ADMIN_ORIGIN, exactRoute("admin_action"), {
        headers: { ...hostile, ...allowlisted, "cf-access-jwt-assertion": token },
      }),
      localEnv(),
      guardEnv(),
    );
    const upstream = onlyUpstream(h);
    expect([...upstream.headers.keys()].sort()).toStrictEqual([
      ...FORWARDED_REQUEST_HEADERS.filter((name) => name !== "content-length"),
      ...ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
      EDGE_HEADERS.host,
      EDGE_HEADERS.requestId,
      EDGE_HEADERS.invokerToken,
      EDGE_SUBREQUEST_REAL_IP_HEADER,
    ].sort());
    expect(upstream.headers.get(EDGE_SUBREQUEST_REAL_IP_HEADER)).toBe(EDGE_SUBREQUEST_REAL_IP);
    expect(upstream.headers.get("cf-access-jwt-assertion")).toBe(token);
    const forbidden = await forbiddenValues();
    for (const [name, value] of upstream.headers) {
      for (const candidate of forbidden) {
        expect(value.includes(candidate), `${name} carries a client-derived value`).toBe(false);
      }
    }
  });

  it("sets x-real-ip to the constant, once, on every forwarded route of both hosts", async () => {
    // Cloudflare fills x-real-ip of a subrequest for a non-Cloudflare host
    // with the client address unless the Worker sets it, and only x-real-ip
    // can be set (CF-Connecting-IP cannot); see edge-google-subrequest.ts.
    expect(EDGE_SUBREQUEST_REAL_IP_HEADER).toBe("x-real-ip");
    expect(EDGE_SUBREQUEST_REAL_IP).toBe("2a06:98c0:3600::103");
    const owner = await accessJwt();
    let checked = 0;
    for (const route of WORKER_ROUTE_POLICY) {
      for (const origin of [PUBLIC_ORIGIN, ADMIN_ORIGIN]) {
        const request = admittedRequestFor(origin, route, {
          headers: {
            "x-real-ip": CLIENT_ADDRESS,
            "cf-connecting-ip": CLIENT_ADDRESS,
            ...(origin === ADMIN_ORIGIN ? { "cf-access-jwt-assertion": owner } : {}),
          },
        });
        if (classifyEdgeRequest(request, localEnv()).kind !== "forward") continue;
        const h = harness();
        await h.proxy(request, localEnv(), guardEnv());
        const forwarded = upstreamOnly(h);
        expect(forwarded, `${origin} ${route.id}`).toHaveLength(1);
        expect(forwarded[0]!.headers.get("x-real-ip"), `${origin} ${route.id}`).toBe(EDGE_SUBREQUEST_REAL_IP);
        expect(forwarded[0]!.headers.has("cf-connecting-ip"), `${origin} ${route.id}`).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("builds the upstream URL on the configured origin with the request path and query", async () => {
    const h = harness();
    await h.proxy(
      new Request(`${PUBLIC_ORIGIN}/api/v1/community/daily?from=2026-09-01&to=2026-09-30`),
      localEnv(),
      guardEnv(),
    );
    const upstream = onlyUpstream(h);
    expect(upstream.url).toBe(`${UPSTREAM_ORIGIN}/api/v1/community/daily?from=2026-09-01&to=2026-09-30`);
    expect(upstream.redirect).toBe("manual");
    expect(upstream.method).toBe("GET");
  });
});

describe("Google callback", () => {
  const base = `${PUBLIC_ORIGIN}${GOOGLE_CALLBACK_PATH}`;

  async function forwarded(url: string, headers: Record<string, string> = {}): Promise<Request> {
    const h = harness();
    await h.proxy(new Request(url, { headers }), localEnv(), guardEnv());
    const upstream = onlyUpstream(h);
    expect(new URL(upstream.url).search).toBe("");
    expect(upstream.url).toBe(`${UPSTREAM_ORIGIN}${GOOGLE_CALLBACK_PATH}`);
    return upstream;
  }

  it("carries a valid apex query only in the callback header", async () => {
    const upstream = await forwarded(`${base}?state=synthetic-state&code=synthetic-code`);
    expect(upstream.headers.get(EDGE_HEADERS.callbackQuery))
      .toBe("?state=synthetic-state&code=synthetic-code");
  });

  it("drops an oversized, invalid, fragmented or admin-host query entirely", async () => {
    const padding = "a".repeat(MAX_GOOGLE_CALLBACK_URL_LENGTH);
    const oversized = `${base}?code=${padding}`.slice(0, MAX_GOOGLE_CALLBACK_URL_LENGTH + 1);
    expect(oversized.length).toBe(MAX_GOOGLE_CALLBACK_URL_LENGTH + 1);
    const atLimit = `${base}?code=${padding}`.slice(0, MAX_GOOGLE_CALLBACK_URL_LENGTH);
    expect((await forwarded(atLimit)).headers.has(EDGE_HEADERS.callbackQuery)).toBe(true);
    for (const url of [
      oversized,
      `${base}?code=synthetic\\code`,
      `${base}?code=synthetic-code#fragment`,
      `${base}?`,
      `${base}`,
    ]) {
      expect((await forwarded(url)).headers.has(EDGE_HEADERS.callbackQuery), url).toBe(false);
    }
    const admin = await forwarded(
      `${ADMIN_ORIGIN}${GOOGLE_CALLBACK_PATH}?state=synthetic-state&code=synthetic-code`,
      { "cf-access-jwt-assertion": await accessJwt() },
    );
    expect(admin.headers.has(EDGE_HEADERS.callbackQuery)).toBe(false);
    expect(admin.headers.get(EDGE_HEADERS.host)).toBe("admin");
  });
});

describe("upstream failure mapping", () => {
  const health = () => new Request(`${PUBLIC_ORIGIN}/api/health`);

  async function expectUnavailable(
    h: Harness,
    response: Response,
    code: string,
  ): Promise<void> {
    expect(response.status).toBe(503);
    expect(Object.fromEntries(response.headers)).toStrictEqual({
      ...JSON_HEADERS,
      "retry-after": "60",
    });
    const body = await envelope(response) as { error: { code: string; requestId: string } };
    expect(Object.keys(body.error)).toStrictEqual(["code", "requestId"]);
    expect(body.error.code).toBe("EDGE_ORIGIN_UNAVAILABLE");
    expect(isEdgeRequestId(body.error.requestId)).toBe(true);
    const upstream = upstreamOnly(h);
    if (upstream.length > 0) {
      expect(upstream).toHaveLength(1);
      expect(upstream[0]!.headers.get(EDGE_HEADERS.requestId)).toBe(body.error.requestId);
    }
    expect(h.logs).toHaveLength(1);
    expect(JSON.parse(h.logs[0]!)).toStrictEqual({
      level: "warn",
      event: "edge_upstream_unavailable",
      requestId: body.error.requestId,
      method: "GET",
      routeClass: "health",
      code,
    });
  }

  it("maps a network or TLS error once, without retrying", async () => {
    const h = harness({ fetcher: async () => { throw new TypeError("synthetic network failure"); } });
    await expectUnavailable(h, await h.proxy(health(), localEnv(), guardEnv()), "EDGE_UPSTREAM_NETWORK");
    expect(h.fetched).toHaveLength(1);
  });

  it("maps a token failure without calling the upstream", async () => {
    const h = harness({ getToken: async () => { throw new Error("EDGE_TOKEN_UNAVAILABLE"); } });
    await expectUnavailable(h, await h.proxy(health(), localEnv(), guardEnv()), "EDGE_TOKEN_UNAVAILABLE");
    expect(h.fetched).toHaveLength(0);
  });

  it("maps a headers timeout and aborts the subrequest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const seen: { signal?: AbortSignal } = {};
    const h = harness({
      fetcher: (request) => new Promise<Response>((_, reject) => {
        seen.signal = request.signal;
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        started();
      }),
    });
    const pending = h.proxy(health(), localEnv(), guardEnv());
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(CONFIG.upstreamHeadersTimeoutSeconds * 1_000 - 1);
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal?.aborted).toBe(true);
    await expectUnavailable(h, await pending, "EDGE_UPSTREAM_TIMEOUT");
  });

  it("never cuts a streaming body once headers have arrived", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness({
      fetcher: async () => markedResponse(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      })),
    });
    const response = await h.proxy(health(), localEnv(), guardEnv());
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(CONFIG.upstreamHeadersTimeoutSeconds * 2_000);
    bodyController.enqueue(new TextEncoder().encode("{\"late\":true}"));
    bodyController.close();
    expect(await response.text()).toBe("{\"late\":true}");
    expect(h.logs).toStrictEqual([]);
  });

  it("cancels the subrequest when the client goes away", async () => {
    const client = new AbortController();
    const seen: { signal?: AbortSignal } = {};
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const h = harness({
      fetcher: (request) => new Promise<Response>((_, reject) => {
        seen.signal = request.signal;
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        started();
      }),
    });
    const pending = h.proxy(
      new Request(`${PUBLIC_ORIGIN}/api/health`, { signal: client.signal }),
      localEnv(),
      guardEnv(),
    );
    await fetchStarted;
    expect(seen.signal?.aborted).toBe(false);
    client.abort();
    expect(seen.signal?.aborted).toBe(true);
    expect((await pending).status).toBe(503);
  });

  for (const status of [401, 403, 421, 429, 503, 302, 200]) {
    it(`maps an unmarked ${status} to 503 and cancels its body`, async () => {
      let cancelled = false;
      const h = harness({
        fetcher: async () => new Response(new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(`{"marker":"${BODY_MARKER}"}`));
          },
          cancel() {
            cancelled = true;
          },
        }), {
          status,
          headers: status === 302 ? { location: "https://accounts.example.test/" } : {},
        }),
      });
      await expectUnavailable(h, await h.proxy(health(), localEnv(), guardEnv()), "EDGE_UPSTREAM_UNMARKED");
      expect(cancelled).toBe(true);
    });
  }

  it("treats a marker other than exactly '1' as unmarked", async () => {
    // Header values are trimmed by the platform, so only these differ from "1".
    for (const marker of ["0", "true", "1, 1", "01", ""]) {
      const h = harness({
        fetcher: async () => new Response("{}", { headers: { [EDGE_HEADERS.originMarker]: marker } }),
      });
      expect((await h.proxy(health(), localEnv(), guardEnv())).status, marker).toBe(503);
    }
  });

  for (const status of [500, 302]) {
    it(`passes a marked ${status} through byte-equal`, async () => {
      const body = `{"error":{"code":"SYNTHETIC","marker":"${BODY_MARKER}"}}`;
      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      if (status === 302) headers.location = "https://accounts.example.test/o/oauth2/v2/auth?client_id=synthetic";
      const h = harness({ fetcher: async () => markedResponse(body, { status, headers }) });
      const response = await h.proxy(health(), localEnv(), guardEnv());
      expect(response.status).toBe(status);
      expect(Object.fromEntries(response.headers)).toStrictEqual(headers);
      expect(await response.text()).toBe(body);
      expect(h.logs).toStrictEqual([]);
    });
  }
});

describe("response pass-through", () => {
  it("drops exactly the contract's dropped headers and keeps the rest byte-exact", async () => {
    const kept: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, max-age=0, no-store",
      allow: "GET, POST",
      "retry-after": "17",
      vary: "Cookie, Origin",
      location: "/api/v1/session?next=%2Fdashboard",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=()",
      "x-synthetic-extension": "kept as sent",
    };
    const cookies = [
      "__Host-um_session=synthetic-a; Path=/; Secure; HttpOnly; SameSite=Lax",
      "um_csrf=synthetic-b; Path=/; Secure; SameSite=Strict; Expires=Wed, 01 Oct 2026 00:00:00 GMT",
      "um_flag=synthetic-c; Path=/; Max-Age=0",
    ];
    const h = harness({
      fetcher: async () => {
        const headers = new Headers(kept);
        for (const name of DROPPED_RESPONSE_HEADERS) headers.set(name, "synthetic-dropped");
        headers.set(EDGE_HEADERS.originMarker, "1");
        for (const cookie of cookies) headers.append("set-cookie", cookie);
        return new Response("{\"created\":true}", { status: 201, statusText: "Synthetic Created", headers });
      },
    });
    const response = await h.proxy(new Request(`${PUBLIC_ORIGIN}/api/health`), localEnv(), guardEnv());
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Synthetic Created");
    for (const name of DROPPED_RESPONSE_HEADERS) expect(response.headers.has(name), name).toBe(false);
    expect(response.headers.getSetCookie()).toStrictEqual(cookies);
    const others = Object.fromEntries([...response.headers].filter(([name]) => name !== "set-cookie"));
    expect(others).toStrictEqual(kept);
    expect(await response.text()).toBe("{\"created\":true}");
  });
});

describe("distribution merge", () => {
  const overview = exactRoute("admin_overview");
  const distribution = { zoneId: DISTRIBUTION_ZONE_ID, apiToken: DISTRIBUTION_API_TOKEN };

  function analyticsRow(count: number): Record<string, unknown> {
    return {
      count,
      avg: { sampleInterval: 1 },
      dimensions: {
        clientIP: ANALYTICS_CLIENT_ADDRESS,
        userAgent: ANALYTICS_USER_AGENT,
        edgeResponseStatus: 200,
      },
    };
  }

  function analyticsResponse(): Response {
    return Response.json({
      data: {
        viewer: {
          zones: [{
            nativeArm64: [analyticsRow(3)],
            nativeX64: [],
            electronMacArm64: [analyticsRow(2)],
            electronMacX64: [],
            electronWindowsX64: [],
            electronLinuxX64: [],
            releases: [analyticsRow(1)],
            intelReleases: [],
          }],
        },
      },
    });
  }

  function originOverview(): Record<string, unknown> {
    return {
      schemaVersion: "synthetic-admin-overview",
      participants: { total: 3 },
      ingress: { state: "operational" },
      distribution: {
        methodology: {
          unit: "distinct_source_ip_addresses",
          lookbackDays: 7,
          storesRawAddresses: false,
        },
        cloudflare: { status: "not_configured", reasonCode: "ANALYTICS_NOT_CONFIGURED" },
        github: { status: "available", release: { tag: "v0.1.23", publishedAt: "2026-09-20T00:00:00.000Z" } },
      },
      reconstruction: { status: "unavailable" },
      marker: BODY_MARKER,
    };
  }

  const overviewHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    vary: "Cookie",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };

  function routedFetcher(
    origin: () => Response,
    analytics: () => Response | Promise<Response> = analyticsResponse,
  ): Fetcher {
    return async (request) => {
      if (request.url === ANALYTICS_ENDPOINT) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${DISTRIBUTION_API_TOKEN}`);
        return analytics();
      }
      expect(new URL(request.url).origin).toBe(UPSTREAM_ORIGIN);
      return origin();
    };
  }

  function analyticsCalls(h: Harness): number {
    return h.fetched.filter((request) => request.url === ANALYTICS_ENDPOINT).length;
  }

  async function ownerOverview(h: Harness): Promise<Response> {
    return h.proxy(
      requestFor(ADMIN_ORIGIN, overview, { headers: { "cf-access-jwt-assertion": await accessJwt() } }),
      localEnv(),
      guardEnv(),
    );
  }

  async function expectedCloudflare(tag: string | null): Promise<unknown> {
    const segments = await readCloudflareDistributionSegments(
      DISTRIBUTION_ZONE_ID,
      DISTRIBUTION_API_TOKEN,
      NOW,
      (async () => analyticsResponse()) as unknown as typeof fetch,
    );
    return cloudflareDistributionFromSegments(segments, tag);
  }

  it("replaces only distribution.cloudflare on a marked 200 JSON overview", async () => {
    const body = JSON.stringify(originOverview());
    const h = harness({
      distribution,
      fetcher: routedFetcher(() => markedResponse(body, {
        headers: { ...overviewHeaders, "content-length": String(new TextEncoder().encode(body).byteLength) },
      })),
    });
    const response = await ownerOverview(h);
    expect(response.status).toBe(200);
    const cloudflare = await expectedCloudflare("v0.1.23");
    expect((cloudflare as { status: string }).status).toBe("available");
    const expected = originOverview();
    (expected.distribution as Record<string, unknown>).cloudflare = cloudflare;
    const text = await response.text();
    expect(text).toBe(JSON.stringify(expected));
    expect(text).not.toContain(ANALYTICS_CLIENT_ADDRESS);
    expect(text).not.toContain(ANALYTICS_USER_AGENT);
    expect(Object.fromEntries(response.headers)).toStrictEqual(overviewHeaders);
    expect(analyticsCalls(h)).toBe(7);
    expect(upstreamOnly(h)).toHaveLength(1);
    expect(upstreamOnly(h)[0]!.headers.get("authorization")).toBeNull();
    expect(h.logs).toStrictEqual([]);
  });

  it("uses the body's own release tag, or null without a release", async () => {
    const withoutRelease = originOverview();
    ((withoutRelease.distribution as Record<string, unknown>).github as Record<string, unknown>).release = null;
    const h = harness({
      distribution,
      fetcher: routedFetcher(() => markedResponse(JSON.stringify(withoutRelease), { headers: overviewHeaders })),
    });
    const merged = JSON.parse(await (await ownerOverview(h)).text()) as Record<string, Record<string, unknown>>;
    expect(merged.distribution!.cloudflare).toStrictEqual(await expectedCloudflare(null));
  });

  it("reports unavailable analytics as production does when the windows cannot be read", async () => {
    const h = harness({
      distribution,
      fetcher: routedFetcher(
        () => markedResponse(JSON.stringify(originOverview()), { headers: overviewHeaders }),
        () => new Response("synthetic upstream failure", { status: 502 }),
      ),
    });
    const merged = JSON.parse(await (await ownerOverview(h)).text()) as Record<string, Record<string, Record<string, unknown>>>;
    expect(merged.distribution!.cloudflare!.status).toBe("unavailable");
    expect(merged.distribution!.cloudflare).toStrictEqual(cloudflareDistributionFromSegments([], "v0.1.23"));
  });

  const passthroughCases: {
    name: string;
    origin: () => Response;
    clock?: () => number;
    reason: string | null;
  }[] = [
    {
      name: "a marked 503",
      origin: () => markedResponse(JSON.stringify(originOverview()), { status: 503, headers: overviewHeaders }),
      reason: null,
    },
    {
      name: "a non-JSON body",
      origin: () => markedResponse(`plain ${BODY_MARKER}`, { headers: { "content-type": "text/plain" } }),
      reason: "content_type",
    },
    {
      name: "invalid JSON",
      origin: () => markedResponse(`{"distribution": ${BODY_MARKER}`, { headers: overviewHeaders }),
      reason: "invalid_json",
    },
    {
      name: "a body without the overview's distribution shape",
      origin: () => markedResponse(JSON.stringify({ marker: BODY_MARKER, distribution: { github: {} } }), { headers: overviewHeaders }),
      reason: "shape",
    },
    {
      name: "a segments error",
      origin: () => markedResponse(JSON.stringify(originOverview()), { headers: overviewHeaders }),
      clock: () => Number.NaN,
      reason: "segments_unavailable",
    },
  ];

  for (const row of passthroughCases) {
    it(`passes the original bytes for ${row.name}`, async () => {
      let originalBytes = "";
      const h = harness({
        distribution,
        ...(row.clock === undefined ? {} : { clock: row.clock }),
        fetcher: routedFetcher(() => {
          const response = row.origin();
          return response;
        }),
      });
      const reference = row.origin();
      originalBytes = await reference.text();
      const response = await ownerOverview(h);
      expect(response.status).toBe(reference.status);
      expect(await response.text()).toBe(originalBytes);
      if (row.reason === null) {
        expect(h.logs).toStrictEqual([]);
      } else {
        expect(h.logs).toHaveLength(1);
        expect(JSON.parse(h.logs[0]!)).toMatchObject({
          level: "warn",
          event: "edge_distribution_merge_skipped",
          reason: row.reason,
        });
      }
    });
  }

  it("passes a body over 4 MiB through unchanged, declared or streamed", async () => {
    const filler = "x".repeat(EDGE_MAX_OVERVIEW_MERGE_BYTES);
    const large = JSON.stringify({ ...originOverview(), filler });
    const bytes = new TextEncoder().encode(large);
    expect(bytes.byteLength).toBeGreaterThan(EDGE_MAX_OVERVIEW_MERGE_BYTES);
    for (const declared of [true, false]) {
      const h = harness({
        distribution,
        fetcher: routedFetcher(() => {
          // Small chunks so the overrun happens mid-stream.
          let offset = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.byteLength) {
                controller.close();
                return;
              }
              controller.enqueue(bytes.slice(offset, offset + 65_536));
              offset += 65_536;
            },
          });
          return markedResponse(stream, {
            headers: declared
              ? { ...overviewHeaders, "content-length": String(bytes.byteLength) }
              : overviewHeaders,
          });
        }),
      });
      const response = await ownerOverview(h);
      const received = new Uint8Array(await response.arrayBuffer());
      expect(received.byteLength, String(declared)).toBe(bytes.byteLength);
      expect(received.every((byte, index) => byte === bytes[index]), String(declared)).toBe(true);
      expect(JSON.parse(h.logs[0]!)).toMatchObject({ reason: "too_large" });
    }
  });

  it("never reads analytics without configuration, on the apex, or for other admin routes", async () => {
    const unconfigured = harness({
      fetcher: routedFetcher(() => markedResponse(JSON.stringify(originOverview()), { headers: overviewHeaders })),
    });
    expect(await (await ownerOverview(unconfigured)).text()).toBe(JSON.stringify(originOverview()));
    expect(analyticsCalls(unconfigured)).toBe(0);

    const apex = harness({ distribution });
    const apexResponse = await apex.proxy(requestFor(PUBLIC_ORIGIN, overview), localEnv(), guardEnv());
    expect(apexResponse.status).toBe(404);
    expect(apex.fetched).toHaveLength(0);

    const history = harness({
      distribution,
      fetcher: routedFetcher(() => markedResponse(JSON.stringify(originOverview()), { headers: overviewHeaders })),
    });
    const historyResponse = await history.proxy(
      requestFor(ADMIN_ORIGIN, exactRoute("admin_metrics_history"), {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }),
      localEnv(),
      guardEnv(),
    );
    expect(await historyResponse.text()).toBe(JSON.stringify(originOverview()));
    expect(analyticsCalls(history)).toBe(0);

    const refused = harness({ distribution });
    expect((await refused.proxy(requestFor(ADMIN_ORIGIN, overview), localEnv(), guardEnv())).status).toBe(403);
    expect(refused.fetched).toHaveLength(0);
  });
});

describe("content-free logs", () => {
  // The last test in this file: every block above has logged by now.
  it("logs only content-free lines across the whole suite", () => {
    expect(ALL_LOG_LINES.length).toBeGreaterThan(10);
    const events = new Set<string>();
    const forbidden = [
      "http", "tibotattle.test", "run.app", "example", "?", "code=", "state=", "/api/",
      CLIENT_ADDRESS, ANALYTICS_CLIENT_ADDRESS, ANALYTICS_USER_AGENT, BODY_MARKER, OWNER_EMAIL,
      ...issuedSecrets,
    ];
    for (const line of ALL_LOG_LINES) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(["level", "event", "requestId", "method", "routeClass", "code", "status", "reason"])
          .toContain(key);
      }
      expect(EDGE_PROXY_LOG_EVENTS as readonly unknown[]).toContain(parsed.event);
      events.add(String(parsed.event));
      expect(isEdgeRequestId(parsed.requestId)).toBe(true);
      if (parsed.event === "edge_upstream_unavailable") {
        expect(EDGE_PROXY_UPSTREAM_FAILURE_CODES as readonly unknown[]).toContain(parsed.code);
      }
      if (parsed.event === "edge_distribution_merge_skipped") {
        expect(EDGE_DISTRIBUTION_MERGE_SKIP_REASONS as readonly unknown[]).toContain(parsed.reason);
      }
      for (const value of forbidden) {
        expect(line.includes(value), `a log line carries ${value.slice(0, 12)}`).toBe(false);
      }
    }
    expect([...events].sort()).toStrictEqual([...EDGE_PROXY_LOG_EVENTS].sort());
  });
});
