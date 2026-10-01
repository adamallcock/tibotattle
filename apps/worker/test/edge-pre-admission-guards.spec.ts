import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDGE_ADMISSION_BINDINGS, EDGE_ADMISSION_POLICY } from "../src/edge-admission-policy";
import { EDGE_MAX_FORWARD_BODY_BYTES, parseEdgeOriginConfiguration } from "../src/edge-origin-contract";
import { EDGE_PRE_ADMISSION_GUARDS, createEdgeOriginProxy } from "../src/edge-origin-proxy";
import { contributionRequestPreflight, handleRequest } from "../src/index";
import { MAX_REQUEST_BYTES } from "../src/constants";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import type { WorkerRouteDefinition } from "../src/route-registry";

/**
 * Holds the edge's pre-admission guards (EDGE_PRE_ADMISSION_GUARDS) to the
 * unchanged Worker.
 *
 * For every EP-1 policy route, every registry method and a matrix of request
 * variants, the Worker's handleRequest runs with spy limiters that refuse the
 * first call, under a permissive configuration and freshly migrated storage,
 * so any refusal it gives before its limiter is caused by the request alone.
 * The edge proxy runs the same request with admitting limiters. Then:
 * - when the Worker refused before any limiter call, the edge must answer
 *   the same status, headers and envelope locally, with no limiter call and
 *   no forward;
 * - when the Worker reached its limiter, the edge must charge its own
 *   limiters and forward, except that a forwarded body declared above
 *   EDGE_MAX_FORWARD_BODY_BYTES gets the edge's own 413 without a limiter call
 *   (the decision record's deviation 3).
 * A guard the edge lacks, or one it applies where the Worker does not, fails
 * here naming the route and variant.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

// Synthetic, content-free fixtures.
const ORIGIN = "https://example.test";
const CLIENT_ADDRESS = "203.0.113.7";
const SECRET = "edge-pre-admission-spec-synthetic-secret-000000";
const UPSTREAM_ORIGIN = "https://edge-guard-synthetic-abc123-uc.a.run.app";
const UPLOAD_AUTHORIZATION = `Upload um_device_upload_00000000-0000-4000-8000-000000000002.${"B".repeat(43)}`;
const SESSION_COOKIE = "__Host-usage_monitor_session=synthetic-session-value-0002";
const NINE_MIB = 9 * 1024 * 1024;
const REQUEST_ID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;

const ALL_RATE_LIMIT_BINDINGS = [
  ...EDGE_ADMISSION_BINDINGS,
  "UPLOAD_AUTHORIZATION_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
] as const;

function spyLimiters(admit: (callNumber: number) => boolean): {
  calls: string[];
  limiters: Record<string, RateLimit>;
} {
  const calls: string[] = [];
  const limiters: Record<string, RateLimit> = {};
  for (const binding of ALL_RATE_LIMIT_BINDINGS) {
    limiters[binding] = {
      async limit(): Promise<RateLimitOutcome> {
        calls.push(binding);
        return { success: admit(calls.length) };
      },
    };
  }
  return { calls, limiters };
}

/** The Worker under a permissive configuration (the EP-1 probe's env). */
function workerEnv(limiters: Record<string, RateLimit>): Env {
  return {
    ...(env as TestBindings),
    ENVIRONMENT: "synthetic-development",
    IDENTITY_LINK_SECRET: SECRET,
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    PUBLIC_ANALYTICS_MODE: "enabled",
    ...limiters,
  } as unknown as Env;
}

const EDGE_LOCAL_ENV = Object.freeze({
  ENVIRONMENT: "production",
  PUBLIC_ORIGIN: ORIGIN,
  PUBLIC_ANALYTICS_MODE: "enabled",
}) as unknown as Env;

function edgeConfiguration() {
  const settings: Record<string, string> = {
    EDGE_UPSTREAM_ORIGIN: UPSTREAM_ORIGIN,
    EDGE_ORIGIN_AUDIENCE: "tibotattle-edge-guard-synthetic-audience",
    EDGE_INVOKER_SERVICE_ACCOUNT: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
  };
  const parsed = parseEdgeOriginConfiguration((name) => settings[name]);
  if (parsed === null) throw new Error("synthetic configuration must parse");
  return parsed;
}

const CONFIG = edgeConfiguration();

interface Variant {
  readonly name: string;
  /** null removes the base header. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly noBody?: true;
}

const VARIANTS: readonly Variant[] = [
  { name: "admitted" },
  { name: "session cookie", headers: { cookie: SESSION_COOKIE } },
  { name: "session cookie among others", headers: { cookie: `a=1; ${SESSION_COOKIE}` } },
  { name: "unrelated cookie", headers: { cookie: "unrelated=1" } },
  { name: "foreign origin", headers: { origin: "https://evil.example" } },
  { name: "no origin", headers: { origin: null } },
  { name: "cross-site fetch", headers: { "sec-fetch-site": "cross-site" } },
  { name: "same-origin fetch", headers: { "sec-fetch-site": "same-origin" } },
  { name: "text/plain", headers: { "content-type": "text/plain" } },
  { name: "cased JSON type", headers: { "content-type": "Application/JSON" } },
  { name: "JSON with charset", headers: { "content-type": "application/json; charset=utf-8" } },
  { name: "no content type", headers: { "content-type": null } },
  { name: "declared 9 MiB", headers: { "content-length": String(NINE_MIB) } },
  { name: "declared over the Worker cap", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } },
  { name: "malformed declared length", headers: { "content-length": "12abc" } },
  { name: "no authorization", headers: { authorization: null } },
  { name: "device bearer", headers: { authorization: "Bearer synthetic-device-bearer-0002" } },
  { name: "session cookie, 9 MiB", headers: { cookie: SESSION_COOKIE, "content-length": String(NINE_MIB) } },
  { name: "text/plain, 9 MiB", headers: { "content-type": "text/plain", "content-length": String(NINE_MIB) } },
  { name: "foreign origin, 9 MiB", headers: { origin: "https://evil.example", "content-length": String(NINE_MIB) } },
  { name: "no body", noBody: true },
];

function variantRequest(route: Readonly<WorkerRouteDefinition>, method: string, variant: Variant): Request {
  const headers = new Headers({
    "cf-connecting-ip": CLIENT_ADDRESS,
    origin: ORIGIN,
    "content-type": "application/json",
    authorization: UPLOAD_AUTHORIZATION,
  });
  for (const [name, value] of Object.entries(variant.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const bodied = method !== "GET" && method !== "HEAD" && variant.noBody !== true;
  return new Request(`${ORIGIN}${route.pathname}`, {
    method,
    headers,
    ...(bodied ? { body: "{}" } : {}),
  });
}

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

async function answer(response: Response): Promise<Answer> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: (await response.text()).replaceAll(REQUEST_ID, "<request-id>"),
  };
}

async function migrate(): Promise<void> {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
}

function policyRoutes(): readonly Readonly<WorkerRouteDefinition>[] {
  return WORKER_ROUTE_POLICY.filter((route) => Object.hasOwn(EDGE_ADMISSION_POLICY, route.id));
}

function registryMethods(route: Readonly<WorkerRouteDefinition>): readonly string[] {
  return route.methods === "all" ? ["GET", "POST"] : route.methods;
}

describe("edge pre-admission guards against handleRequest", () => {
  beforeEach(async () => {
    await migrate();
    // handleRequest logs one request_failed line per refusal; none matters here.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers exactly the Worker's request-only refusals before admission, and forwards the rest", async () => {
    const mismatches: string[] = [];
    const guardedLocal = new Map<string, Set<string>>();
    let comparisons = 0;
    for (const route of policyRoutes()) {
      for (const method of registryMethods(route)) {
        for (const variant of VARIANTS) {
          const label = `${method} ${route.id} [${variant.name}]`;
          const worker = spyLimiters(() => false);
          const workerAnswer = await answer(
            await handleRequest(variantRequest(route, method, variant), workerEnv(worker.limiters)),
          );

          const edge = spyLimiters(() => true);
          const forwarded: Request[] = [];
          const proxy = createEdgeOriginProxy({
            config: CONFIG,
            handleRequest,
            contributionRequestPreflight,
            idTokenSource: { getToken: async () => "eyJh.eyJi.c2ln" },
            clientKeySecret: SECRET,
            limiters: edge.limiters,
            distribution: null,
            fetcher: async (request) => {
              forwarded.push(request);
              await request.body?.cancel();
              return new Response("{}", {
                headers: { "content-type": "application/json", "x-tibotattle-origin": "1" },
              });
            },
            logger: { warn: () => undefined, error: () => undefined },
          });
          const request = variantRequest(route, method, variant);
          const declared = Number(request.headers.get("content-length"));
          const edgeAnswer = await answer(await proxy(request, EDGE_LOCAL_ENV, EDGE_LOCAL_ENV));
          comparisons += 1;

          if (worker.calls.length === 0) {
            // The Worker refused from the request alone, before its limiter.
            if (edge.calls.length !== 0 || forwarded.length !== 0) {
              mismatches.push(`${label}: Worker ${workerAnswer.status} before its limiter, edge charged or forwarded`);
            } else if (JSON.stringify(edgeAnswer) !== JSON.stringify(workerAnswer)) {
              mismatches.push(`${label}: Worker ${JSON.stringify(workerAnswer)} != edge ${JSON.stringify(edgeAnswer)}`);
            } else {
              const guard = EDGE_PRE_ADMISSION_GUARDS[route.id as keyof typeof EDGE_PRE_ADMISSION_GUARDS] ?? "none";
              if (!guardedLocal.has(guard)) guardedLocal.set(guard, new Set());
              guardedLocal.get(guard)!.add(variant.name);
            }
            continue;
          }
          const forwardsBody = method !== "GET" && method !== "HEAD";
          if (forwardsBody && Number.isSafeInteger(declared) && declared > EDGE_MAX_FORWARD_BODY_BYTES) {
            // Deviation 3: the edge's own forward cap.
            if (edgeAnswer.status !== 413 || edge.calls.length !== 0 || forwarded.length !== 0) {
              mismatches.push(`${label}: expected the edge's own 413 without a limiter`);
            }
            continue;
          }
          if (forwarded.length !== 1 || edge.calls.length === 0) {
            mismatches.push(`${label}: Worker reached its limiter, edge answered ${edgeAnswer.status} locally`);
          }
        }
      }
    }
    expect(mismatches).toStrictEqual([]);
    // 24 routes; performance reports and both day-manifest routes have two methods.
    expect(comparisons).toBe(27 * VARIANTS.length);
    // Every guard kind refused something, and nothing outside the map did.
    expect([...guardedLocal.keys()].sort())
      .toStrictEqual(["contribution_preflight", "same_origin", "session_cookie"]);
    expect([...guardedLocal.get("session_cookie")!].sort()).toStrictEqual([
      "session cookie",
      "session cookie among others",
      "session cookie, 9 MiB",
    ]);
    expect([...guardedLocal.get("same_origin")!].sort()).toStrictEqual([
      "cross-site fetch",
      "foreign origin",
      "foreign origin, 9 MiB",
      "no origin",
    ]);
    expect([...guardedLocal.get("contribution_preflight")!].sort()).toStrictEqual([
      "cased JSON type",
      "declared 9 MiB",
      "declared over the Worker cap",
      "device bearer",
      "foreign origin, 9 MiB",
      "malformed declared length",
      "no authorization",
      "no body",
      "no content type",
      "session cookie",
      "session cookie among others",
      "session cookie, 9 MiB",
      "text/plain",
      "text/plain, 9 MiB",
    ]);
  });

  it("detects a guard the edge lacks and a guard it applies where the Worker does not", async () => {
    const contributions = WORKER_ROUTE_POLICY.find((route) => route.id === "contributions")!;
    const deviceDisconnect = WORKER_ROUTE_POLICY.find((route) => route.id === "device_disconnect")!;
    async function edgeAnswer(
      preflight: (request: Request) => unknown,
      route: Readonly<WorkerRouteDefinition>,
      variant: Variant,
    ): Promise<{ status: number; charged: number; forwarded: number }> {
      const edge = spyLimiters(() => true);
      let forwarded = 0;
      const proxy = createEdgeOriginProxy({
        config: CONFIG,
        handleRequest,
        contributionRequestPreflight: preflight,
        idTokenSource: { getToken: async () => "eyJh.eyJi.c2ln" },
        clientKeySecret: SECRET,
        limiters: edge.limiters,
        distribution: null,
        fetcher: async (request) => {
          forwarded += 1;
          await request.body?.cancel();
          return new Response("{}", { headers: { "x-tibotattle-origin": "1" } });
        },
        logger: { warn: () => undefined, error: () => undefined },
      });
      const response = await proxy(variantRequest(route, "POST", variant), EDGE_LOCAL_ENV, EDGE_LOCAL_ENV);
      await response.body?.cancel();
      return { status: response.status, charged: edge.calls.length, forwarded };
    }
    // A preflight that admits everything: the Worker refuses, the edge charges.
    const missing = await edgeAnswer(() => "admitted", contributions, { name: "no authorization", headers: { authorization: null } });
    expect(missing).toStrictEqual({ status: 200, charged: 2, forwarded: 1 });
    const worker = spyLimiters(() => false);
    const refused = await handleRequest(
      variantRequest(contributions, "POST", { name: "no authorization", headers: { authorization: null } }),
      workerEnv(worker.limiters),
    );
    expect(refused.status).toBe(401);
    expect(worker.calls).toStrictEqual([]);
    // The real preflight on a route the Worker does not guard is never run.
    const unguarded = await edgeAnswer(contributionRequestPreflight, deviceDisconnect, { name: "no authorization", headers: { authorization: null } });
    expect(unguarded).toStrictEqual({ status: 200, charged: 2, forwarded: 1 });
  });
});
