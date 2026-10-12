import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { clearAdminAccessJwksCacheForTests } from "../src/admin-access";
import { ADMIN_SURFACE_PATHS } from "../src/admin-ui";
import { initializeStorageSource } from "../src/analytics-delivery";
import { handleRequest } from "../src/index";
import {
  POSTGRES_HEALTH_OMITTED_WORKER_KEYS,
  buildPostgresHealthBody,
  postgresDeploymentSourceCommit,
  validatePostgresHealthBody,
  type PostgresHealthCapabilityFlags,
} from "../src/postgres-health";
import {
  buildPostgresReadinessBody,
  validatePostgresReadinessBody,
  type PostgresReadinessState,
} from "../src/postgres-readiness";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
// @ts-expect-error -- plain ESM Cloud Run module without declarations; Vite resolves it.
import * as hostDispatch from "../cloud-run/postgres-host-dispatch.mjs";
// @ts-expect-error -- plain ESM Cloud Run module without declarations; Vite resolves it.
import * as productionRegistry from "../cloud-run/postgres-production-registry.mjs";
// @ts-expect-error -- plain ESM Cloud Run module without declarations; Vite resolves it.
import { createRequestContextStore } from "../cloud-run/postgres-request-context.mjs";
import { createPostgresAdminAccessChokepoint } from "../src/postgres-admin-access";

/**
 * CR-6/RD-2/RD-3 request-path parity (W3-CRA phase A), in the Workers pool
 * against the Worker's own handleRequest (src/index.ts: the d43c8f92 handler
 * plus the wave-2 POSTGRES_WORKER_BACKEND guard, which these envs never set).
 *
 * (A) Pipeline cells: every request the Worker answers before any route
 *     handler (www, admin host and admin paths, wrong methods, unknown_api,
 *     the two root routes, publication disabled) gets the same status, code,
 *     Allow, cache-control and Location from createProductionRequestHandler,
 *     whose stub families are never called.
 * (B) DTOs: buildPostgresReadinessBody and buildPostgresHealthBody over the
 *     same logical state equal the Worker's /api/ready and /api/health
 *     bodies (health minus the two keys the append-only decision removes).
 * (F) The documented deviations, each asserted explicitly. The unported
 *     retry-after is OD-CR-6(iv), injected with no default; F runs both the
 *     brief's proposed 60 and the no-header answer.
 * Sections C to E (served-route replay, log redaction, no-store) run in
 * cloud-run/postgres-host-dispatch.check.mjs, the E12 rows
 * (postgres-test/edge-origin-e2e.spec.mjs) and, for the composed
 * HOST_MODE origin over PostgreSQL 17, postgres-test/postgres-production-host.spec.mjs.
 * Phase B (D-CRB) pinned the composition root's answers; round 12 opened the
 * production admin host (OD-CR-3 'chokepoint', ADMIN-R12; the 'refuse' cells
 * here run the switch's other position, which the edge-test origin keeps), and
 * there is no unported retry-after (OD-CR-6(iv)). Round 12 also answers the
 * accountless performance authorization with production's definite 403;
 * round 19 runs production's earlier answers first, through an injected
 * preamble (stubbed to pass here; the real one is proved by
 * cloud-run/retired-performance-authorization.check.mjs and over PostgreSQL).
 */

interface TestBindings extends Env {
  STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
}

interface ResolvedRoute {
  readonly disposition: string;
  readonly handler: ((request: Request) => Promise<Response>) | null;
  readonly answer: { readonly status: number; readonly code: string } | null;
}
interface ProductionRegistry {
  readonly unportedRouteIds: readonly string[];
  readonly portedRouteIds: readonly string[];
  resolve(id: string): ResolvedRoute;
}
type RequestHandler = (request: Request) => Promise<Response>;

const b = env as TestBindings;
const PUBLIC_ORIGIN = "https://tibotattle.test";
const ADMIN_ORIGIN = "https://admin.tibotattle.test";
const WWW_ORIGIN = "https://www.tibotattle.test";
const NAMESPACE = "synthetic-parity-source";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OWNER_EMAIL = "owner@synthetic.example";
const ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
const ACCESS_AUD = "b".repeat(64);
const ACCESS_KID = "synthetic-parity-access-key";
const ALL_METHODS = Object.freeze(["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD"]);
const ADMIN_IDS: readonly string[] = hostDispatch.ORIGIN_ADMIN_ROUTE_IDS;
const SCOPE: readonly string[] = productionRegistry.POSTGRES_SCOPE_ROUTE_IDS;
const CONTESTED: readonly string[] = productionRegistry.OD_CR_1_CONTESTED_ROUTE_IDS;

function workerEnv(overrides: Record<string, unknown> = {}): Env {
  // A synthetic PUBLIC_ORIGIN the generated Env literal union does not list.
  return { ...b, PUBLIC_ORIGIN, PUBLIC_ANALYTICS_MODE: "enabled", ...overrides } as unknown as Env;
}

interface Origin {
  readonly handler: RequestHandler;
  readonly calls: string[];
  readonly registry: ProductionRegistry;
}

function origin(
  workerSettings: Env,
  adminHostPolicy: "refuse" | "chokepoint",
  ported: readonly string[] = [...SCOPE, ...CONTESTED],
  // OD-CR-6(iv) is open and the handler has no default; this spec uses the
  // brief's proposed 60 and proves the no-header answer in section F.
  unportedRetryAfterSeconds: number | null = 60,
): Origin {
  const calls: string[] = [];
  const handlers = new Map<string, () => Promise<Response | null>>(ported.map((id) => [id, async () => {
    calls.push(id);
    return Response.json({ served: id });
  }]));
  // Round 19: each retired-definite route takes its preamble; this one passes.
  for (const id of productionRegistry.RETIRED_DEFINITE_ROUTE_IDS) {
    handlers.set(id, async () => {
      calls.push(`preamble:${id}`);
      return null;
    });
  }
  const registry: ProductionRegistry = productionRegistry.createProductionRouteRegistry({
    routePolicy: WORKER_ROUTE_POLICY,
    handlers,
    portedRouteIds: ported,
  });
  const handler: RequestHandler = hostDispatch.createProductionRequestHandler({
    registry,
    env: Object.freeze({ ...workerSettings }),
    requestContextStore: createRequestContextStore(),
    requestContext: () => undefined,
    storageGate: { async assertCurrent() {} },
    recordDiagnostic: async () => {},
    logger: () => {},
    adminHostPolicy,
    // The chokepoint is built once over the env (C-ADMIN); this test env may
    // carry the Access test keys, which only a test origin honours.
    ...(adminHostPolicy === "chokepoint"
      ? { adminAccess: createPostgresAdminAccessChokepoint(workerSettings, { allowTestJwks: true }) }
      : {}),
    unportedRetryAfterSeconds,
  });
  return { handler, calls, registry };
}

interface Snapshot {
  readonly status: number;
  readonly code: string | null;
  readonly allow: string | null;
  readonly cacheControl: string | null;
  readonly location: string | null;
}

async function snapshot(response: Response): Promise<Snapshot> {
  const text = await response.text();
  let code: string | null = null;
  try {
    const body: unknown = JSON.parse(text);
    const error = body !== null && typeof body === "object" ? Reflect.get(body, "error") : undefined;
    const value = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    code = typeof value === "string" ? value : null;
  } catch {
    code = null;
  }
  return {
    status: response.status,
    code,
    allow: response.headers.get("allow"),
    cacheControl: response.headers.get("cache-control"),
    location: response.headers.get("location"),
  };
}

interface Cell {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
}

function cellRequest(cell: Cell, headers: Record<string, string> = {}): Request {
  return new Request(cell.origin + cell.path, { method: cell.method, headers });
}

async function compareCells(
  cells: readonly Cell[],
  settings: Env,
  production: Origin,
  headers: Record<string, string> = {},
): Promise<Snapshot[]> {
  const seen: Snapshot[] = [];
  for (const cell of cells) {
    const label = `${cell.method} ${cell.origin}${cell.path}`;
    const worker = await snapshot(await handleRequest(cellRequest(cell, headers), settings));
    const port = await snapshot(await production.handler(cellRequest(cell, headers)));
    expect(port, label).toStrictEqual(worker);
    seen.push(worker);
  }
  expect(production.calls).toStrictEqual([]);
  return seen;
}

function routeMethods(id: string): readonly string[] {
  const route = WORKER_ROUTE_POLICY.find((entry) => entry.id === id)!;
  return route.methods === "all" ? ALL_METHODS : route.methods;
}

function wrongMethodCells(originUrl: string, includeAdmin: boolean): Cell[] {
  const cells: Cell[] = [];
  for (const route of WORKER_ROUTE_POLICY) {
    if (route.methods === "all" || (!includeAdmin && ADMIN_IDS.includes(route.id))) continue;
    for (const method of ALL_METHODS) {
      if (!(route.methods as readonly string[]).includes(method)) {
        cells.push({ origin: originUrl, path: route.pathname, method });
      }
    }
  }
  return cells;
}

function base64UrlBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function accessSettings(): Promise<{ settings: Env; token: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey), kid: ACCESS_KID, alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64UrlJson({ alg: "RS256", kid: ACCESS_KID, typ: "JWT" })}.${base64UrlJson({
    aud: [ACCESS_AUD], email: OWNER_EMAIL, iss: `https://${ACCESS_TEAM_DOMAIN}`, iat: now, nbf: now,
    exp: now + 600, sub: "synthetic-access-subject",
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey,
    new TextEncoder().encode(input)));
  return {
    settings: workerEnv({
      ACCESS_TEAM_DOMAIN,
      ACCESS_AUD,
      ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
      ACCESS_TEST_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    }),
    token: `${input}.${base64UrlBytes(signature)}`,
  };
}

beforeEach(async () => {
  await reset();
  clearAdminAccessJwksCacheForTests();
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
});

// ---------------------------------------------------------------------------
// (A) Pipeline cells

describe("(A) the Worker pipeline before any route handler", () => {
  it("pins coverage: the registry table is WORKER_ROUTE_POLICY, 51 routes in order", () => {
    const table: readonly { id: string }[] = productionRegistry.PRODUCTION_ROUTE_TABLE;
    expect(table.map((route) => route.id)).toStrictEqual(WORKER_ROUTE_POLICY.map((route) => route.id));
    expect(WORKER_ROUTE_POLICY).toHaveLength(51);
  });

  it("apex: www, admin paths and ids, wrong methods, unknown_api and the root routes match", async () => {
    const settings = workerEnv();
    for (const policy of ["refuse", "chokepoint"] as const) {
      const production = origin(settings, policy);
      const cells: Cell[] = [
        ...["/", "/api/health", "/api/v1/contributions?x=1", "/admin", "//evil.example/x"]
          .map((path) => ({ origin: WWW_ORIGIN, path, method: "GET" })),
        ...ADMIN_SURFACE_PATHS.flatMap((path) => ["GET", "POST", "HEAD"].map((method) => ({
          origin: PUBLIC_ORIGIN, path, method }))),
        ...ADMIN_IDS.flatMap((id) => ALL_METHODS.map((method) => ({
          origin: PUBLIC_ORIGIN, path: WORKER_ROUTE_POLICY.find((route) => route.id === id)!.pathname, method }))),
        ...wrongMethodCells(PUBLIC_ORIGIN, false),
        ...["/api/v1/nope", "/api/", "/api/v1/me"].flatMap((path) => ["GET", "POST", "DELETE"].map((method) => ({
          origin: PUBLIC_ORIGIN, path, method }))),
        ...ALL_METHODS.map((method) => ({
          origin: PUBLIC_ORIGIN, path: "/.well-known/apple-developer-domain-association.txt", method })),
        { origin: PUBLIC_ORIGIN, path: "/api/v1/internal/release/appcast", method: "POST" },
      ];
      const seen = await compareCells(cells, settings, production);
      expect(seen.filter((cell) => cell.status === 308)).toHaveLength(5);
      expect(seen.filter((cell) => cell.status === 405).length).toBeGreaterThan(100);
      // Every 4xx/5xx answer here is the Worker envelope with no-store.
      for (const cell of seen.filter((entry) => entry.status >= 400)) expect(cell.cacheControl).toBe("no-store");
    }
  });

  it("publication disabled: community_daily is the unlogged 503, after the method envelope", async () => {
    for (const mode of ["disabled", undefined]) {
      const settings = workerEnv({ PUBLIC_ANALYTICS_MODE: mode });
      const production = origin(settings, "refuse");
      const seen = await compareCells([
        { origin: PUBLIC_ORIGIN, path: "/api/v1/community/daily", method: "GET" },
        { origin: PUBLIC_ORIGIN, path: "/api/v1/community/daily?date=2026-10-01", method: "GET" },
        { origin: PUBLIC_ORIGIN, path: "/api/v1/community/daily", method: "POST" },
      ], settings, production);
      expect(seen.map((cell) => [cell.status, cell.code])).toStrictEqual([
        [503, "PUBLICATION_DISABLED"], [503, "PUBLICATION_DISABLED"], [405, "METHOD_NOT_ALLOWED"]]);
    }
  });

  it("admin host, OD-CR-3 'chokepoint': unconfigured Access and a missing token refuse as the Worker does", async () => {
    const everyRoute: Cell[] = [
      ...WORKER_ROUTE_POLICY.flatMap((route) => ALL_METHODS.map((method) => ({
        origin: ADMIN_ORIGIN, path: route.pathname, method }))),
      { origin: ADMIN_ORIGIN, path: "/api/v1/nope", method: "GET" },
      { origin: ADMIN_ORIGIN, path: "/admin", method: "GET" },
      { origin: ADMIN_ORIGIN, path: "/", method: "GET" },
    ];
    const unconfigured = workerEnv();
    const seen = await compareCells(everyRoute, unconfigured, origin(unconfigured, "chokepoint"));
    expect(new Set(seen.map((cell) => `${cell.status} ${cell.code}`))).toStrictEqual(new Set(["503 ADMIN_NOT_CONFIGURED"]));
    const { settings } = await accessSettings();
    const denied = await compareCells(everyRoute, settings, origin(settings, "chokepoint"));
    expect(new Set(denied.map((cell) => `${cell.status} ${cell.code}`))).toStrictEqual(new Set(["403 ACCESS_REQUIRED"]));
  });

  it("admin host, OD-CR-3 'chokepoint' with the owner's Access token: wrong methods and unknown_api match", async () => {
    const { settings, token } = await accessSettings();
    const cells: Cell[] = [
      ...wrongMethodCells(ADMIN_ORIGIN, true),
      { origin: ADMIN_ORIGIN, path: "/api/v1/nope", method: "GET" },
      { origin: ADMIN_ORIGIN, path: "/api/v1/me", method: "DELETE" },
    ];
    const seen = await compareCells(cells, settings, origin(settings, "chokepoint"),
      { "cf-access-jwt-assertion": token });
    expect(seen.filter((cell) => cell.status === 405).length).toBeGreaterThan(100);
    expect(seen.filter((cell) => cell.status === 404)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (B) DTO parity

const typed = () => b.STORAGE_INGESTION_A;

async function prepareTyped(): Promise<Env> {
  await applyD1Migrations(typed(), b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(typed(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(typed(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(typed(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeStorageSource(typed(), NAMESPACE);
  await initializeTypedV11Admission(typed(), NAMESPACE);
  await initializeTypedV1Admission(typed(), NAMESPACE);
  return workerEnv({
    USAGE_MONITOR_DB: typed(),
    TELEMETRY_STORAGE_MODE: "typed",
    TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
  });
}

interface LifecycleSeed {
  readonly state?: string;
  readonly lastCompletedAt?: string | null;
  readonly maintenanceRunAt?: string | null;
  readonly quarantineRetentionComplete?: 0 | 1;
  readonly restoreReplayComplete?: 0 | 1;
  readonly reconciliation?: string;
  readonly reconciliationRunAt?: string | null;
  readonly reconciliationComplete?: 0 | 1;
}

async function seedLifecycle(db: D1Database, seed: LifecycleSeed): Promise<void> {
  const state = seed.state ?? "completed";
  await db.prepare(`UPDATE retention_state
      SET state = ?, last_completed_at = ?, maintenance_run_at = ?,
          quarantine_retention_complete = ?, restore_replay_complete = ?, failure_code = ?
    WHERE singleton = 1`).bind(
    state,
    seed.lastCompletedAt === undefined ? null : seed.lastCompletedAt,
    seed.maintenanceRunAt === undefined ? null : seed.maintenanceRunAt,
    seed.quarantineRetentionComplete ?? 1,
    seed.restoreReplayComplete ?? 1,
    state === "failed" ? "LIFECYCLE_PASS_FAILED" : null,
  ).run();
  const reconciliation = seed.reconciliation ?? "completed";
  await db.prepare(`UPDATE quarantine_reconciliation_state
      SET state = ?, maintenance_run_at = ?, reconciliation_complete = ?, lease_id = ?, failure_code = ?
    WHERE singleton = 1`).bind(
    reconciliation,
    seed.reconciliationRunAt === undefined ? null : seed.reconciliationRunAt,
    seed.reconciliationComplete ?? 1,
    reconciliation === "running" ? "synthetic-lease" : null,
    reconciliation === "failed" ? "QUARANTINE_RECONCILIATION_FAILED" : null,
  ).run();
}

/** The same logical rows, in the PostgreSQL reader shapes (readPostgres*State). */
async function readinessStateOf(db: D1Database): Promise<PostgresReadinessState> {
  const retention = await db.prepare(`SELECT state, last_completed_at, maintenance_run_at,
      quarantine_retention_complete, restore_replay_complete FROM retention_state WHERE singleton = 1`)
    .first<{ state: "never_run" | "running" | "completed" | "failed"; last_completed_at: string | null;
      maintenance_run_at: string | null; quarantine_retention_complete: number; restore_replay_complete: number }>();
  const reconciliation = await db.prepare(`SELECT state, maintenance_run_at, reconciliation_complete
      FROM quarantine_reconciliation_state WHERE singleton = 1`)
    .first<{ state: "never_run" | "running" | "completed" | "failed"; maintenance_run_at: string | null;
      reconciliation_complete: number }>();
  if (!retention || !reconciliation) throw new Error("synthetic lifecycle rows missing");
  return {
    retention: {
      state: retention.state,
      lastCompletedAtMs: retention.last_completed_at === null ? null : Date.parse(retention.last_completed_at),
      maintenanceRunAtIso: retention.maintenance_run_at,
      quarantineRetentionComplete: retention.quarantine_retention_complete === 1,
      restoreReplayComplete: retention.restore_replay_complete === 1,
    },
    reconciliation: {
      state: reconciliation.state,
      maintenanceRunAtIso: reconciliation.maintenance_run_at,
      reconciliationComplete: reconciliation.reconciliation_complete === 1,
    },
  };
}

/** release-readiness-lib.mjs validReadyBody, restated (it is not exported). */
function releaseValidReadyBody(body: Record<string, unknown>, status: number): boolean {
  const checks = body.checks as Record<string, unknown> | undefined;
  const policy = body.policy as Record<string, unknown> | undefined;
  return [200, 503].includes(status)
    && body.status === (status === 200 ? "ready" : "not_ready")
    && typeof checks === "object" && checks !== null
    && ["lifecycleFresh", "quarantineRetentionComplete", "restoreReplayComplete", "aggregateRebuildComplete",
      "maintenanceCycleMatched", "quarantineReconciliationComplete"].every((key) => typeof checks[key] === "boolean")
    && policy?.lifecycleStaleAfterMilliseconds === 2 * 60 * 60 * 1000;
}

describe("(B) RD-2 /api/ready DTO parity in typed storage mode", () => {
  it("equals the Worker's handleReady body and status in every lifecycle state", async () => {
    const settings = await prepareTyped();
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const cycle = at(-30 * 60_000);
    const fresh = at(-60 * 60_000);
    const cases: readonly [string, LifecycleSeed | null, number][] = [
      ["never_run (fresh database)", null, 503],
      ["ready", { lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle }, 200],
      ["stale (older than 7200000 ms)", { lastCompletedAt: at(-3 * 60 * 60_000), maintenanceRunAt: cycle,
        reconciliationRunAt: cycle }, 503],
      ["completed in the future", { lastCompletedAt: at(60 * 60_000), maintenanceRunAt: cycle,
        reconciliationRunAt: cycle }, 503],
      ["completed without a completion time", { lastCompletedAt: null, maintenanceRunAt: cycle,
        reconciliationRunAt: cycle }, 503],
      ["incomplete quarantine retention", { lastCompletedAt: fresh, maintenanceRunAt: cycle,
        reconciliationRunAt: cycle, quarantineRetentionComplete: 0 }, 503],
      ["incomplete restore replay", { lastCompletedAt: fresh, maintenanceRunAt: cycle,
        reconciliationRunAt: cycle, restoreReplayComplete: 0 }, 503],
      ["running", { state: "running", lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle }, 503],
      ["failed", { state: "failed", lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle }, 503],
      ["cycle mismatch", { lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: at(-20 * 60_000) }, 503],
      ["no maintenance markers", { lastCompletedAt: fresh, maintenanceRunAt: null, reconciliationRunAt: null }, 503],
      ["reconciliation running", { lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle,
        reconciliation: "running", reconciliationComplete: 0 }, 503],
      ["reconciliation failed", { lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle,
        reconciliation: "failed", reconciliationComplete: 0 }, 503],
      ["reconciliation incomplete", { lastCompletedAt: fresh, maintenanceRunAt: cycle, reconciliationRunAt: cycle,
        reconciliationComplete: 0 }, 503],
    ];
    for (const [label, seed, expectedStatus] of cases) {
      if (seed !== null) await seedLifecycle(typed(), seed);
      const response = await handleRequest(new Request(`${PUBLIC_ORIGIN}/api/ready`), settings);
      const workerBody = await response.json<Record<string, unknown>>();
      const built = buildPostgresReadinessBody(await readinessStateOf(typed()), Date.now(), { semantics: "worker-exact" });
      expect(response.status, label).toBe(expectedStatus);
      expect(built.httpStatus, label).toBe(response.status);
      expect(JSON.parse(JSON.stringify(built.body)), label).toStrictEqual(workerBody);
      expect(Object.keys(built.body.checks), label).toStrictEqual(Object.keys(workerBody.checks as object));
      expect(validatePostgresReadinessBody(workerBody, response.status), label).toStrictEqual([]);
      expect(releaseValidReadyBody(workerBody, response.status), label).toBe(true);
      expect(releaseValidReadyBody(JSON.parse(JSON.stringify(built.body)), built.httpStatus), label).toBe(true);
    }
  });

  it("refuses an undecided OD-CR-4 semantics and the Worker's json-mode body", async () => {
    const settings = workerEnv();
    const response = await handleRequest(new Request(`${PUBLIC_ORIGIN}/api/ready`), settings);
    const jsonModeBody = await response.json<Record<string, unknown>>();
    // json storage mode has no aggregateRebuildDelegated: never the GCP contract.
    expect(validatePostgresReadinessBody(jsonModeBody, response.status)).toContain("checks:keys");
    const state = await readinessStateOf(b.USAGE_MONITOR_DB);
    expect(() => buildPostgresReadinessBody(state, Date.now(), {} as never))
      .toThrow("POSTGRES_READINESS_SEMANTICS_UNDECIDED");
  });
});

async function seedControls(state: "operational" | "degraded" | "contained", flags: readonly [number, number, number, number]) {
  await b.USAGE_MONITOR_DB.prepare(`UPDATE collection_controls
      SET control_state = ?, enrollment_enabled = ?, upload_registration_enabled = ?,
          processing_enabled = ?, publication_enabled = ?, revision = revision + 1
    WHERE singleton = 1`).bind(state, ...flags).run();
}

function withoutOmittedKeys(body: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, Record<string, unknown>>;
  for (const path of POSTGRES_HEALTH_OMITTED_WORKER_KEYS) {
    const [section, key] = path.split(".") as [string, string];
    expect(Object.hasOwn(copy[section]!, key), path).toBe(true);
    delete copy[section]![key];
  }
  return copy;
}

describe("(B) RD-3 /api/health DTO parity", () => {
  const WORKER_FLAGS: PostgresHealthCapabilityFlags = { participantExport: true, coordinatedSignInAdmission: true };

  it("equals the Worker body minus the two ledger keys, in operational, degraded and contained states", async () => {
    const cases: readonly [string, "operational" | "degraded" | "contained", readonly [number, number, number, number],
      Record<string, unknown>][] = [
      ["operational", "operational", [1, 1, 1, 1], {}],
      ["operational, publication not configured", "operational", [1, 1, 1, 1], { PUBLIC_ANALYTICS_MODE: "disabled" }],
      ["degraded, publication off", "degraded", [1, 1, 1, 0], {}],
      ["degraded, uploads off", "degraded", [1, 0, 1, 1], { INCREMENTAL_EXTERNAL_PARTICIPANTS: "authorized" }],
      ["contained", "contained", [0, 0, 0, 0], { ENROLLMENT_MODE: "disabled" }],
      ["operational, enrollment mode disabled", "operational", [1, 1, 1, 1], { ENROLLMENT_MODE: "disabled" }],
      ["operational, invite-only enrollment", "operational", [1, 1, 1, 1], { ENROLLMENT_MODE: "invite_only" }],
      ["local preview contract", "operational", [1, 1, 1, 1], { ACCOUNT_SCOPED_INGEST_MODE: "local_preview",
        ENVIRONMENT: "synthetic-development", ENROLLMENT_MODE: "local_open" }],
    ];
    for (const [label, state, flags, overrides] of cases) {
      await seedControls(state, flags);
      await b.USAGE_MONITOR_DB.prepare(`UPDATE retention_state SET state = 'completed',
          quarantine_retention_complete = 1, restore_replay_complete = 1 WHERE singleton = 1`).run();
      const settings = workerEnv({ DEPLOYMENT_SOURCE_COMMIT: COMMIT, ...overrides });
      const response = await handleRequest(new Request(`${PUBLIC_ORIGIN}/api/health`), settings);
      expect(response.status, label).toBe(200);
      const workerBody = await response.json<Record<string, unknown>>();
      const controls = await b.USAGE_MONITOR_DB.prepare(`SELECT control_state, enrollment_enabled,
          upload_registration_enabled, processing_enabled, publication_enabled FROM collection_controls`)
        .first<Record<string, string | number>>();
      const built = buildPostgresHealthBody({
        env: settings,
        enrollmentMode: settings.ENROLLMENT_MODE as "local_open" | "open" | "invite_only" | "disabled",
        controls: {
          state: controls!.control_state as "operational" | "degraded" | "contained",
          enrollment: controls!.enrollment_enabled === 1,
          uploadRegistration: controls!.upload_registration_enabled === 1,
          processing: controls!.processing_enabled === 1,
          publication: controls!.publication_enabled === 1,
        },
        retention: { state: "completed", quarantineRetentionComplete: true, restoreReplayComplete: true },
        sourceCommit: postgresDeploymentSourceCommit(settings),
        capabilityFlags: WORKER_FLAGS,
      });
      const expected = withoutOmittedKeys(workerBody);
      expect(JSON.parse(JSON.stringify(built)), label).toStrictEqual(expected);
      expect(JSON.stringify(built), label).toBe(JSON.stringify(expected));
      expect(validatePostgresHealthBody(built), label).toStrictEqual([]);
      // The Worker's own body is not the GCP contract: it still carries the ledger keys.
      expect(validatePostgresHealthBody(workerBody).length, label).toBeGreaterThan(0);
    }
  });

  it("OD-CR-5 flags change exactly their two capabilities; undecided flags are refused", () => {
    const input = {
      env: workerEnv(),
      enrollmentMode: "open" as const,
      controls: { state: "operational" as const, enrollment: true, uploadRegistration: true, processing: true, publication: true },
      retention: { state: "never_run" as const, quarantineRetentionComplete: true, restoreReplayComplete: true },
      sourceCommit: COMMIT,
    };
    const worker = buildPostgresHealthBody({ ...input, capabilityFlags: WORKER_FLAGS });
    const derived = buildPostgresHealthBody({ ...input,
      capabilityFlags: { participantExport: false, coordinatedSignInAdmission: false } });
    expect({ ...derived.capabilities, participantExport: true, coordinatedSignInAdmission: true })
      .toStrictEqual(worker.capabilities);
    expect(validatePostgresHealthBody(derived)).toStrictEqual([]);
    for (const capabilityFlags of [undefined, {}, { participantExport: true },
      { participantExport: true, coordinatedSignInAdmission: "yes" },
      { ...WORKER_FLAGS, deletionSafeRestoreReplay: true }]) {
      expect(() => buildPostgresHealthBody({ ...input, capabilityFlags } as never))
        .toThrow("POSTGRES_HEALTH_CAPABILITY_FLAGS_UNDECIDED");
    }
  });

  it("the source commit port: absent omits deployment, malformed is the Worker's 503", async () => {
    expect(postgresDeploymentSourceCommit(workerEnv())).toBeNull();
    expect(postgresDeploymentSourceCommit(workerEnv({ DEPLOYMENT_SOURCE_COMMIT: COMMIT }))).toBe(COMMIT);
    for (const value of ["", "XYZ", "abc", "g".repeat(40), 7]) {
      const settings = workerEnv({ DEPLOYMENT_SOURCE_COMMIT: value });
      expect(() => postgresDeploymentSourceCommit(settings)).toThrow("DEPLOYMENT_SOURCE_COMMIT_INVALID");
      const response = await handleRequest(new Request(`${PUBLIC_ORIGIN}/api/health`), settings);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "DEPLOYMENT_SOURCE_COMMIT_INVALID" } });
    }
    const withoutCommit = buildPostgresHealthBody({
      env: workerEnv(), enrollmentMode: "open",
      controls: { state: "operational", enrollment: true, uploadRegistration: true, processing: true, publication: true },
      retention: { state: "never_run", quarantineRetentionComplete: true, restoreReplayComplete: true },
      sourceCommit: null, capabilityFlags: WORKER_FLAGS,
    });
    expect(Object.hasOwn(withoutCommit, "deployment")).toBe(false);
    expect(validatePostgresHealthBody(withoutCommit)).toContain("deployment");
  });
});

// ---------------------------------------------------------------------------
// (F) Documented deviations

describe("(F) documented deviations from the Worker", () => {
  it("an unported route answers 503 POSTGRES_ROUTE_NOT_PORTED with the OD-CR-6(iv) retry-after, never a family",
    async () => {
      for (const [retryAfterSeconds, expected] of [[60, "60"], [null, null]] as const) {
        const production = origin(workerEnv(), "refuse", SCOPE, retryAfterSeconds);
        for (const id of production.registry.unportedRouteIds) {
          if (ADMIN_IDS.includes(id)) continue;
          const route = WORKER_ROUTE_POLICY.find((entry) => entry.id === id)!;
          const response = await production.handler(new Request(PUBLIC_ORIGIN + route.pathname,
            { method: routeMethods(id)[0]! }));
          expect(response.status, id).toBe(503);
          expect(response.headers.get("retry-after"), id).toBe(expected);
          expect(response.headers.get("cache-control"), id).toBe("no-store");
          expect(await response.json(), id).toMatchObject({ error: { code: "POSTGRES_ROUTE_NOT_PORTED" } });
        }
        expect(production.calls).toStrictEqual([]);
      }
    });

  it("round 19: once its preamble passes, the accountless performance authorization is production's definite 403, never the 503", async () => {
    for (const retryAfterSeconds of [60, null] as const) {
      const production = origin(workerEnv(), "refuse", undefined, retryAfterSeconds);
      const id = "accountless_telemetry_performance_authorization";
      expect(production.registry.resolve(id).disposition).toBe("definite");
      expect(production.registry.unportedRouteIds).not.toContain(id);
      const route = WORKER_ROUTE_POLICY.find((entry) => entry.id === id)!;
      const response = await production.handler(new Request(PUBLIC_ORIGIN + route.pathname, { method: "POST" }));
      expect(await snapshot(response)).toStrictEqual({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", allow: null,
        cacheControl: "no-store", location: null });
      expect(response.headers.get("retry-after")).toBeNull();
      expect(production.calls).toStrictEqual([`preamble:${id}`]);
    }
  });

  it("assets are a JSON 404 (the edge serves the site); the admin host under 'refuse' is the unported 503", async () => {
    const production = origin(workerEnv(), "refuse");
    for (const path of ["/", "/index.html", "/privacy.html"]) {
      const response = await production.handler(new Request(PUBLIC_ORIGIN + path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(await response.json(), path).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    const worker = await handleRequest(new Request(`${ADMIN_ORIGIN}/api/health`), workerEnv());
    const refused = await production.handler(new Request(`${ADMIN_ORIGIN}/api/health`));
    expect((await snapshot(worker)).code).toBe("ADMIN_NOT_CONFIGURED");
    expect(await snapshot(refused)).toStrictEqual({ status: 503, code: "POSTGRES_ROUTE_NOT_PORTED", allow: null,
      cacheControl: "no-store", location: null });
    expect(refused.headers.get("retry-after")).toBe("60");
    const withoutRetryAfter = origin(workerEnv(), "refuse", undefined, null);
    const bare = await withoutRetryAfter.handler(new Request(`${ADMIN_ORIGIN}/api/health`));
    expect((await snapshot(bare)).code).toBe("POSTGRES_ROUTE_NOT_PORTED");
    expect(bare.headers.get("retry-after")).toBeNull();
  });

  it("the migration mutation barrier is not consulted at the origin (the edge's fenced mode owns it)", async () => {
    const settings = workerEnv({ DEPLOYMENT_SOURCE_COMMIT: COMMIT });
    const fenced = await handleRequest(new Request(`${PUBLIC_ORIGIN}/api/health`), settings, true);
    expect(await fenced.json()).toMatchObject({ mode: "migration-mutation-barrier" });
    const production = origin(settings, "refuse");
    const served = await production.handler(new Request(`${PUBLIC_ORIGIN}/api/health`));
    expect(served.status).toBe(200);
    expect(production.calls).toStrictEqual(["health"]);
  });
});
