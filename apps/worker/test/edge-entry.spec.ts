import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Vite's ?raw query hands these checks the unchanged texts. They are left
// untyped on purpose (see edge-admission-policy.spec.ts): a program-wide
// `vite/client` reference would leak Vite-only ambient types into src/**.
// @ts-expect-error -- test-only Vite ?raw import, checked by rawText below.
import rawEdgeEntrySource from "../src/edge-entry.ts?raw";
// @ts-expect-error -- test-only Vite ?raw import, checked by rawText below.
import rawReleaseGuardMigration from "../release-guard-migrations/0001_sparkle_appcast_guard_nonces.sql?raw";
// @ts-expect-error -- test-only Vite ?raw import, checked by rawText below.
import rawWorkerNonceMigration from "../migrations/0029_sparkle_appcast_guard_nonces.sql?raw";
import { ADMIN_SURFACE_PATHS } from "../src/admin-ui";
import { JSON_HEADERS } from "../src/constants";
import { EDGE_ADMISSION_BINDINGS } from "../src/edge-admission-policy";
import edgeEntry, * as edgeEntryModule from "../src/edge-entry";
import {
  EDGE_GUARD_DB_STATEMENT_REFUSED,
  EDGE_GUARD_NONCE_TABLE_PATTERN,
  EDGE_LOCAL_ENV_KEYS,
  buildEdgeGuardEnv,
  buildEdgeLocalEnv,
  createReleaseGuardDatabase,
} from "../src/edge-entry";
import { EDGE_HEADERS } from "../src/edge-origin-contract";
import * as indexModule from "../src/index";
import worker, { handleRequest } from "../src/index";
import { UploadIngressBudget } from "../src/ingress-budget";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import type { WorkerRouteMethod } from "../src/route-registry";
import {
  SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL,
  SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE,
  SPARKLE_APPCAST_GUARD_BUCKET,
  SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
  SPARKLE_APPCAST_GUARD_CHANNEL,
  SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
  SPARKLE_APPCAST_GUARD_KEY,
  SPARKLE_APPCAST_GUARD_OBJECT_PREFIX,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV,
  SPARKLE_APPCAST_GUARD_ROUTE,
  SPARKLE_APPCAST_GUARD_SCHEMA,
} from "../src/sparkle-appcast-guard";

interface TestBindings extends Env {
  STORAGE_INGESTION_A: D1Database;
  STORAGE_INGESTION_B: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const runtime = env as TestBindings;

function rawText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a Vite ?raw text");
  return value;
}

const edgeEntrySource = rawText(rawEdgeEntrySource);

// ---------------------------------------------------------------------------
// Synthetic, content-free fixtures. Nothing here is a real host, account,
// address, key or token.

const PUBLIC_ORIGIN = "https://tibotattle.test";
const ADMIN_ORIGIN = "https://admin.tibotattle.test";
const WWW_ORIGIN = "https://www.tibotattle.test";
const UPSTREAM_ORIGIN = "https://edge-entry-synthetic-abc123-uc.a.run.app";
const AUDIENCE = "tibotattle-edge-entry-synthetic-audience";
const INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLIENT_KEY_SECRET = "edge-entry-spec-synthetic-client-key-secret-0000";
const ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
const ACCESS_AUD = "c".repeat(64);
const ACCESS_KEY_ID = "edge-entry-spec-access-key";
const OWNER_EMAIL = "owner@example.test";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GUARD_TOKEN = "edge-entry-synthetic-release-guard-token-0123456789";
const SAMPLED_REQUEST_ID = "5f0c2a7e-1b3d-4c5e-9f00-0a1b2c3d4e00";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;
const UUID_PATTERN_ANCHORED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();

/** Env names the edge must never read outside worker mode. */
const FORBIDDEN_ENV_NAMES = Object.freeze([
  "USAGE_MONITOR_DB",
  "ANALYTICS_DB",
  "DELETION_LEDGER",
  "QUARANTINE",
  "UPLOAD_INGRESS_BUDGET",
  "IDENTITY_LINK_SECRET",
  "APPLE_PRIVATE_KEY",
  "GOOGLE_OIDC_CLIENT_SECRET",
]);

function forbiddenEnvName(name: PropertyKey): boolean {
  return typeof name === "string"
    && (FORBIDDEN_ENV_NAMES.includes(name) || name.startsWith("ENVELOPE_"));
}

// ---------------------------------------------------------------------------
// Encoding helpers

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function jsonSegment(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pem(label: string, der: ArrayBuffer): string {
  const body = base64(new Uint8Array(der)).match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${body.join("\n")}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// Synthetic keys: the edge invoker key, the Access signing key and the
// Sparkle signing key. Generated per run, never persisted.

let invokerPrivateKeyPem = "";
let accessKeyPair: CryptoKeyPair;
let accessJwksJson = "";
let sparkleKeyPair: CryptoKeyPair;
let sparklePublicEdKey = "";
let sparklePublicEdKeySha256 = "";

function invokerKeyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "synthetic-project",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    private_key: invokerPrivateKeyPem,
    client_email: INVOKER,
    client_id: "100000000000000000001",
    token_uri: GOOGLE_TOKEN_URL,
    ...overrides,
  });
}

/** PEM-shaped, so the key reaches crypto.subtle.importKey, which refuses it. */
function truncatedDerKeyJson(): string {
  const lines = invokerPrivateKeyPem.split("\n");
  const truncated = lines.filter((_, index) => index < 4 || index >= lines.length - 2).join("\n");
  return invokerKeyJson({ private_key: truncated });
}

async function accessJwt(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signedInput = `${jsonSegment({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" })}.${jsonSegment({
    aud: [ACCESS_AUD],
    email: OWNER_EMAIL,
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    sub: "synthetic-access-subject",
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessKeyPair.privateKey,
    encoder.encode(signedInput),
  ));
  return `${signedInput}.${base64Url(signature)}`;
}

function syntheticIdToken(audience = AUDIENCE): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return `${jsonSegment({ alg: "RS256", typ: "JWT" })}.${jsonSegment({
    aud: audience,
    email: INVOKER,
    email_verified: true,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}

beforeAll(async () => {
  const rsa = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const invoker = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]) as CryptoKeyPair;
  invokerPrivateKeyPem = pem(
    "PRIVATE KEY",
    await crypto.subtle.exportKey("pkcs8", invoker.privateKey) as ArrayBuffer,
  );
  accessKeyPair = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]) as CryptoKeyPair;
  const accessPublicJwk = await crypto.subtle.exportKey("jwk", accessKeyPair.publicKey);
  accessJwksJson = JSON.stringify({
    keys: [{ ...accessPublicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }],
  });
  sparkleKeyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const sparklePublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", sparkleKeyPair.publicKey) as ArrayBuffer,
  );
  sparklePublicEdKey = base64(sparklePublic);
  sparklePublicEdKeySha256 = await sha256Hex(sparklePublic);
});

// ---------------------------------------------------------------------------
// Environments

const syntheticAssets = {
  async fetch(request: Request): Promise<Response> {
    return new Response(`<!doctype html><p>synthetic asset ${new URL(request.url).pathname}</p>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  },
};

function guardSettings(): Record<string, unknown> {
  return {
    SPARKLE_RELEASES: runtime.QUARANTINE,
    SPARKLE_APPCAST_GUARD_MODE: "enabled",
    SPARKLE_APPCAST_GUARD_CHANNEL: SPARKLE_APPCAST_GUARD_CHANNEL,
    SPARKLE_APPCAST_GUARD_BUCKET: SPARKLE_APPCAST_GUARD_BUCKET,
    SPARKLE_APPCAST_GUARD_APPCAST_KEY: SPARKLE_APPCAST_GUARD_KEY,
    SPARKLE_APPCAST_GUARD_ENDPOINT_PATH: SPARKLE_APPCAST_GUARD_ROUTE,
    SPARKLE_APPCAST_GUARD_CONTENT_TYPE: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    SPARKLE_APPCAST_GUARD_CACHE_CONTROL: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    SPARKLE_APPCAST_GUARD_MAX_XML_BYTES: "1048576",
    SPARKLE_APPCAST_GUARD_TOKEN: GUARD_TOKEN,
    [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV]: sparklePublicEdKey,
    [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV]: sparklePublicEdKeySha256,
  };
}

function limiterBindings(): Record<string, unknown> {
  const limiters: Record<string, unknown> = {};
  for (const name of EDGE_ADMISSION_BINDINGS) limiters[name] = Reflect.get(runtime, name);
  return limiters;
}

/** A complete, valid gcp-mode env; each call is a distinct env object. */
function gcpValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    EDGE_UPSTREAM_MODE: "gcp",
    ENVIRONMENT: "production",
    PUBLIC_ORIGIN,
    PUBLIC_ANALYTICS_MODE: "enabled",
    ASSETS: syntheticAssets,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
    DEPLOYMENT_SOURCE_COMMIT: SOURCE_COMMIT,
    ...guardSettings(),
    EDGE_UPSTREAM_ORIGIN: UPSTREAM_ORIGIN,
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "30",
    EDGE_INVOKER_KEY_JSON: invokerKeyJson(),
    EDGE_CLIENT_KEY_SECRET: CLIENT_KEY_SECRET,
    RELEASE_GUARD_DB: runtime.STORAGE_INGESTION_B,
    ...limiterBindings(),
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete values[name];
  }
  return values;
}

function gcpEnv(overrides: Record<string, unknown> = {}): Env {
  return gcpValues(overrides) as unknown as Env;
}

interface GuardedEnv {
  readonly env: Env;
  readonly violations: string[];
  /** Every string key read, presence-checked or described on the env. */
  readonly reads: Set<string>;
}

/**
 * An env that also holds every storage binding and Worker secret, and records
 * (and throws on) any read of one, any presence check of one, and any
 * enumeration. A throw alone is not enough evidence: handleRequest's
 * catch-all would turn it into a 500, so the spec asserts the record. It
 * also records every key touched, for the allowlist checks below.
 */
function guardedEnv(values: Record<string, unknown>): GuardedEnv {
  const violations: string[] = [];
  const reads = new Set<string>();
  const target: Record<string, unknown> = {
    ...values,
    USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    ANALYTICS_DB: runtime.STORAGE_INGESTION_A,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    QUARANTINE: runtime.QUARANTINE,
    UPLOAD_INGRESS_BUDGET: runtime.UPLOAD_INGRESS_BUDGET,
    ENVELOPE_PRIVATE_JWK: "synthetic-envelope-private-jwk",
    ENVELOPE_PUBLIC_JWK: "synthetic-envelope-public-jwk",
    IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-000000000000",
    APPLE_PRIVATE_KEY: "synthetic-apple-private-key",
    GOOGLE_OIDC_CLIENT_SECRET: "synthetic-google-oidc-client-secret",
    // A key only a full-env reader would act on (handleRequest's own check).
    POSTGRES_WORKER_BACKEND: "synthetic",
  };
  function touch(kind: string, name: PropertyKey): void {
    if (typeof name === "string") reads.add(name);
    if (forbiddenEnvName(name)) {
      violations.push(`${kind}:${String(name)}`);
      throw new Error(`edge-entry spec: forbidden env ${kind}`);
    }
  }
  const proxy = new Proxy(target, {
    get(object, name, receiver) {
      touch("get", name);
      return Reflect.get(object, name, receiver);
    },
    has(object, name) {
      touch("has", name);
      return Reflect.has(object, name);
    },
    getOwnPropertyDescriptor(object, name) {
      touch("descriptor", name);
      return Reflect.getOwnPropertyDescriptor(object, name);
    },
    ownKeys() {
      violations.push("ownKeys:*");
      throw new Error("edge-entry spec: forbidden env enumeration");
    },
  });
  return { env: proxy as unknown as Env, violations, reads };
}

/** The deployed env keys each mode may touch. */
const FENCED_ENV_READS: ReadonlySet<string> = new Set([
  "EDGE_UPSTREAM_MODE",
  ...EDGE_LOCAL_ENV_KEYS,
]);
const GCP_ENV_READS: ReadonlySet<string> = new Set([
  ...FENCED_ENV_READS,
  "EDGE_UPSTREAM_ORIGIN",
  "EDGE_ORIGIN_AUDIENCE",
  "EDGE_INVOKER_SERVICE_ACCOUNT",
  "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS",
  "EDGE_INVOKER_KEY_JSON",
  "EDGE_CLIENT_KEY_SECRET",
  "RELEASE_GUARD_DB",
  ...EDGE_ADMISSION_BINDINGS,
  "DISTRIBUTION_ANALYTICS_ZONE_ID",
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
]);

function unexpectedReads(reads: ReadonlySet<string>, allowed: ReadonlySet<string>): string[] {
  return [...reads].filter((name) => !allowed.has(name)).sort();
}

// ---------------------------------------------------------------------------
// Network stub: Google's token endpoint, the run.app origin, the synthetic
// Access certs and Cloudflare's analytics API (always unavailable) only.

const ACCESS_CERTS_URL = `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const ANALYTICS_HOSTNAME = "api.cloudflare.com";
const ORIGIN_OVERVIEW_PLACEHOLDER = Object.freeze({ state: "origin-placeholder" });

/**
 * Every ID token the stub has issued in this file. The token source caches a
 * token per isolate, so a forward may carry one minted by an earlier test.
 */
const issuedIdTokens = new Set<string>();

interface NetworkStub {
  readonly requests: Request[];
  upstream(): Request[];
  analyticsReads(): number;
}

function stubNetwork(): NetworkStub {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === GOOGLE_TOKEN_URL) {
      const body = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const idToken = syntheticIdToken();
      issuedIdTokens.add(idToken);
      return Response.json({ id_token: idToken });
    }
    if (request.url === ACCESS_CERTS_URL) return Response.json(JSON.parse(accessJwksJson));
    const url = new URL(request.url);
    if (url.hostname === ANALYTICS_HOSTNAME) return new Response("unavailable", { status: 503 });
    if (url.origin === UPSTREAM_ORIGIN) {
      const body = url.pathname === "/api/v1/admin/overview"
        ? { distribution: { cloudflare: ORIGIN_OVERVIEW_PLACEHOLDER, github: { release: null } } }
        : { synthetic: "origin", path: url.pathname };
      return Response.json(body, {
        headers: { [EDGE_HEADERS.originMarker]: "1", "cache-control": "no-store" },
      });
    }
    throw new Error("edge-entry spec: unexpected network destination");
  });
  return {
    requests,
    upstream: () => requests.filter((request) => new URL(request.url).origin === UPSTREAM_ORIGIN),
    analyticsReads: () => requests.filter((request) =>
      new URL(request.url).hostname === ANALYTICS_HOSTNAME).length,
  };
}

// ---------------------------------------------------------------------------
// Calling the entry

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** A runtime-delivered request's type; the spec builds plain Requests. */
function incoming(request: Request): IncomingRequest {
  return request as IncomingRequest;
}

async function edgeFetch(request: Request, edgeEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await edgeEntry.fetch(incoming(request), edgeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function get(url: string, headers: HeadersInit = {}): Request {
  return new Request(url, { headers });
}

interface Snapshot {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

async function snapshot(response: Response): Promise<Snapshot> {
  return {
    status: response.status,
    headers: [...response.headers].sort(),
    body: (await response.text()).replaceAll(UUID_PATTERN, "<request-id>"),
  };
}

async function expectBarrier(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(503);
  expect(response.headers.get("cache-control"), label).toBe("no-store");
  expect(response.headers.get("retry-after"), label).toBe("300");
  const body = await response.json<{ error: { code: string; requestId: string } }>();
  expect(body.error.code, label).toBe("MUTATION_BARRIER_ACTIVE");
}

async function expectNotConfigured(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(503);
  for (const [name, value] of Object.entries(JSON_HEADERS)) {
    expect(response.headers.get(name), `${label} ${name}`).toBe(value);
  }
  expect(response.headers.get("retry-after"), label).toBe("60");
  const body = await response.json<{ error: { code: string; requestId: string } }>();
  expect(Object.keys(body), label).toEqual(["error"]);
  expect(Object.keys(body.error), label).toEqual(["code", "requestId"]);
  expect(body.error.code, label).toBe("EDGE_NOT_CONFIGURED");
  expect(body.error.requestId, label).toMatch(UUID_PATTERN_ANCHORED);
}

function routeMethods(methods: readonly WorkerRouteMethod[] | "all"): readonly WorkerRouteMethod[] {
  return methods === "all" ? ["GET", "POST", "DELETE"] : methods;
}

// ---------------------------------------------------------------------------
// Release guard D1 stand-ins

function sqlStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter((statement) => statement.length > 0);
}

async function applyReleaseGuardMigration(db: D1Database): Promise<void> {
  await db.batch(sqlStatements(rawText(rawReleaseGuardMigration)).map((sql) => db.prepare(sql)));
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

async function schema(db: D1Database): Promise<readonly SchemaRow[]> {
  const rows = await db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
  ).all<SchemaRow>();
  return rows.results;
}

/** Every user table's full contents, by table name. */
async function tableContents(db: D1Database): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const row of await schema(db)) {
    if (row.type !== "table" || row.name.startsWith("sqlite_") || row.name.startsWith("_cf_")) continue;
    const rows = await db.prepare(`SELECT * FROM "${row.name}"`).all();
    contents[row.name] = JSON.stringify(rows.results.map((value) => JSON.stringify(value)).sort());
  }
  return contents;
}

async function nonceRows(db: D1Database): Promise<readonly { nonce: string }[]> {
  return (await db.prepare(
    "SELECT nonce FROM sparkle_appcast_guard_nonces ORDER BY nonce",
  ).all<{ nonce: string }>()).results;
}

// ---------------------------------------------------------------------------
// Sparkle guard requests (mirrors sparkle-appcast-guard.spec.ts)

async function sparkleSignature(value: Uint8Array): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    sparkleKeyPair.privateKey,
    value,
  )));
}

function artifactKey(version: string, digest: string): string {
  return `${SPARKLE_APPCAST_GUARD_OBJECT_PREFIX}/${version}/${digest}/TiboTattle.dmg`;
}

const ARTIFACT_BYTES = encoder.encode("edge-entry-synthetic-signed-dmg-artifact");

async function installArtifact(version: string): Promise<void> {
  const digest = await sha256Hex(ARTIFACT_BYTES);
  await runtime.QUARANTINE.put(artifactKey(version, digest), ARTIFACT_BYTES, {
    httpMetadata: {
      contentType: SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE,
      cacheControl: SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL,
    },
  });
}

async function appcastBytes(version: string): Promise<Uint8Array> {
  const digest = await sha256Hex(ARTIFACT_BYTES);
  const signature = await sparkleSignature(ARTIFACT_BYTES);
  return encoder.encode(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<enclosure url="https://updates.tibotattle.com/${artifactKey(version, digest)}" length="${ARTIFACT_BYTES.byteLength}" sparkle:version="${version}" sparkle:edSignature="${signature}" />
</item></channel></rss>`);
}

async function guardBody(): Promise<string> {
  const candidate = await appcastBytes("1");
  return JSON.stringify({
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    channel: SPARKLE_APPCAST_GUARD_CHANNEL,
    bucket: SPARKLE_APPCAST_GUARD_BUCKET,
    key: SPARKLE_APPCAST_GUARD_KEY,
    contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    expectedCurrent: { state: "empty", bytes: 0, sha256: null, etag: null },
    candidate: {
      bytes: candidate.byteLength,
      sha256: await sha256Hex(candidate),
      base64: base64Url(candidate),
    },
  });
}

async function signedGuardRequest(body: string, nonce: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = `${SPARKLE_APPCAST_GUARD_SCHEMA}\0POST\0${SPARKLE_APPCAST_GUARD_ROUTE}`
    + `\0${timestamp}\0${nonce}\0${await sha256Hex(encoder.encode(body))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(GUARD_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
  return new Request(`${PUBLIC_ORIGIN}${SPARKLE_APPCAST_GUARD_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usage-monitor-release-timestamp": String(timestamp),
      "x-usage-monitor-release-nonce": nonce,
      "x-usage-monitor-release-signature": base64Url(signature),
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle

let warnings: string[] = [];

beforeEach(async () => {
  await reset();
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
  await applyD1Migrations(runtime.DELETION_LEDGER, runtime.TEST_DELETION_LEDGER_MIGRATIONS);
  await applyReleaseGuardMigration(runtime.STORAGE_INGESTION_B);
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("edge entry module surface", () => {
  it("exports the edge default handler, the Worker's named exports and the Durable Object class", () => {
    expect(typeof edgeEntry.fetch).toBe("function");
    expect(typeof edgeEntry.scheduled).toBe("function");
    expect(edgeEntry).not.toBe(worker);
    expect(edgeEntryModule.handleRequest).toBe(handleRequest);
    expect(edgeEntryModule.UploadIngressBudget).toBe(UploadIngressBudget);
    for (const [name, value] of Object.entries(indexModule)) {
      if (name === "default") continue;
      expect(Reflect.get(edgeEntryModule, name), name).toBe(value);
    }
  });

  it("imports the Worker through ./index and the Durable Object through ./ingress-budget, never ./cloudflare-entry", () => {
    const specifiers = [...edgeEntrySource.matchAll(/\bfrom\s+"([^"]+)"/gu)].map((match) => match[1]);
    expect(specifiers).toContain("./index");
    expect(specifiers).toContain("./ingress-budget");
    expect(specifiers.some((specifier) => specifier?.includes("cloudflare-entry"))).toBe(false);
    expect(specifiers.every((specifier) => specifier?.startsWith("./"))).toBe(true);
    expect(edgeEntrySource).toContain("export * from \"./index\";");
    expect(edgeEntrySource).toContain("export { UploadIngressBudget } from \"./ingress-budget\";");
    expect(edgeEntrySource).toMatch(/^import worker, \{ handleRequest \} from "\.\/index";$/mu);
  });

  it("reads the deployed env only by name and never spreads it", () => {
    expect(edgeEntrySource).not.toMatch(/\.\.\.\s*env\b/u);
    expect(edgeEntrySource).not.toMatch(/Object\.(?:keys|values|entries|assign)\(\s*env\b/u);
    const literalReads = new Set(
      [...edgeEntrySource.matchAll(/Reflect\.get\(env, "([A-Z0-9_]+)"\)/gu)].map((match) => match[1]),
    );
    expect([...literalReads].sort()).toEqual([
      ...EDGE_ADMISSION_BINDINGS,
      "DISTRIBUTION_ANALYTICS_API_TOKEN",
      "DISTRIBUTION_ANALYTICS_ZONE_ID",
      "EDGE_CLIENT_KEY_SECRET",
      "EDGE_INVOKER_KEY_JSON",
      "EDGE_UPSTREAM_MODE",
      "ENVIRONMENT",
      "RELEASE_GUARD_DB",
    ].sort());
    // The two reviewed dynamic reads: the named-key copy and the contract's
    // own configuration getter.
    const dynamicReads = [...edgeEntrySource.matchAll(/Reflect\.get\(env, ([^")][^)]*)\)/gu)]
      .map((match) => match[0]);
    expect(dynamicReads).toEqual(["Reflect.get(env, name)", "Reflect.get(env, name)"]);
    expect(edgeEntrySource).toContain("const value: unknown = Reflect.get(env, name);");
    expect(edgeEntrySource).toContain(
      "parseEdgeOriginConfiguration((name) => Reflect.get(env, name))",
    );
  });
});

describe("named-key env builders", () => {
  it("lists the local keys sorted, unique and free of storage, secrets and EDGE_* settings", () => {
    expect(Object.isFrozen(EDGE_LOCAL_ENV_KEYS)).toBe(true);
    expect([...EDGE_LOCAL_ENV_KEYS]).toEqual([...EDGE_LOCAL_ENV_KEYS].sort());
    expect(new Set(EDGE_LOCAL_ENV_KEYS).size).toBe(EDGE_LOCAL_ENV_KEYS.length);
    expect([...EDGE_LOCAL_ENV_KEYS]).toEqual([
      "ACCESS_ADMIN_EMAIL",
      "ACCESS_AUD",
      "ACCESS_TEAM_DOMAIN",
      "ASSETS",
      "DEPLOYMENT_SOURCE_COMMIT",
      "ENVIRONMENT",
      "PUBLIC_ANALYTICS_MODE",
      "PUBLIC_ORIGIN",
      "SPARKLE_APPCAST_GUARD_APPCAST_KEY",
      "SPARKLE_APPCAST_GUARD_BUCKET",
      "SPARKLE_APPCAST_GUARD_CACHE_CONTROL",
      "SPARKLE_APPCAST_GUARD_CHANNEL",
      "SPARKLE_APPCAST_GUARD_CONTENT_TYPE",
      "SPARKLE_APPCAST_GUARD_ENDPOINT_PATH",
      "SPARKLE_APPCAST_GUARD_MAX_XML_BYTES",
      "SPARKLE_APPCAST_GUARD_MODE",
      "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY",
      "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256",
      "SPARKLE_APPCAST_GUARD_TOKEN",
      "SPARKLE_RELEASES",
    ]);
    for (const name of EDGE_LOCAL_ENV_KEYS) {
      expect(forbiddenEnvName(name), name).toBe(false);
      expect(name.startsWith("EDGE_"), name).toBe(false);
      expect(name.endsWith("_RATE_LIMIT"), name).toBe(false);
    }
  });

  it("copies exactly the named keys, frozen, with identical values", () => {
    const { env: edgeEnv, violations } = guardedEnv(gcpValues({ ACCESS_TEST_JWKS_JSON: accessJwksJson }));
    const local = buildEdgeLocalEnv(edgeEnv);
    expect(Object.isFrozen(local)).toBe(true);
    // Production ENVIRONMENT: the test JWKS is never passed on.
    expect(Object.keys(local)).toEqual([...EDGE_LOCAL_ENV_KEYS]);
    for (const name of EDGE_LOCAL_ENV_KEYS) {
      expect(Reflect.get(local, name), name).toBe(Reflect.get(edgeEnv, name));
    }
    expect(violations).toEqual([]);
  });

  it("adds ACCESS_TEST_JWKS_JSON only in a development ENVIRONMENT", () => {
    for (const environment of ["synthetic-development", "development", "local-development", "test"]) {
      const local = buildEdgeLocalEnv(gcpEnv({
        ENVIRONMENT: environment,
        ACCESS_TEST_JWKS_JSON: accessJwksJson,
      }));
      expect(Object.keys(local), environment)
        .toEqual([...EDGE_LOCAL_ENV_KEYS, "ACCESS_TEST_JWKS_JSON"].sort());
      expect(Reflect.get(local, "ACCESS_TEST_JWKS_JSON")).toBe(accessJwksJson);
    }
    for (const environment of ["production", "staging", "Development", undefined]) {
      const local = buildEdgeLocalEnv(gcpEnv({
        ENVIRONMENT: environment,
        ACCESS_TEST_JWKS_JSON: accessJwksJson,
      }));
      expect(Object.hasOwn(local, "ACCESS_TEST_JWKS_JSON"), String(environment)).toBe(false);
    }
  });

  it("omits absent keys and never copies anything else", () => {
    const sparse = buildEdgeLocalEnv({
      PUBLIC_ORIGIN,
      ASSETS: undefined,
      USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
      EDGE_CLIENT_KEY_SECRET: CLIENT_KEY_SECRET,
      ENROLLMENT_RATE_LIMIT: runtime.ENROLLMENT_RATE_LIMIT,
    } as unknown as Env);
    expect(Object.keys(sparse)).toEqual(["PUBLIC_ORIGIN"]);
  });

  it("builds the guard env from the named keys plus the nonce-only facade", () => {
    const local = buildEdgeLocalEnv(gcpEnv());
    const guard = buildEdgeGuardEnv(local, runtime.STORAGE_INGESTION_B);
    expect(Object.isFrozen(guard)).toBe(true);
    expect(Object.keys(guard)).toEqual([...EDGE_LOCAL_ENV_KEYS, "USAGE_MONITOR_DB"]);
    expect(guard.USAGE_MONITOR_DB).not.toBe(runtime.STORAGE_INGESTION_B);
    expect(() => guard.USAGE_MONITOR_DB.prepare("SELECT 1")).toThrow(EDGE_GUARD_DB_STATEMENT_REFUSED);
    // Handed a whole Worker env by mistake, it still copies named keys only.
    const fromRaw = buildEdgeGuardEnv(gcpEnv(), runtime.STORAGE_INGESTION_B);
    expect(Object.keys(fromRaw)).toEqual([...EDGE_LOCAL_ENV_KEYS, "USAGE_MONITOR_DB"]);
  });
});

describe("worker mode", () => {
  function workerEnv(): Env {
    return {
      ...(runtime as unknown as Record<string, unknown>),
      EDGE_UPSTREAM_MODE: "worker",
      PUBLIC_ORIGIN,
      ASSETS: syntheticAssets,
      ACCESS_TEAM_DOMAIN,
      ACCESS_AUD,
      ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
      ACCESS_TEST_JWKS_JSON: accessJwksJson,
    } as unknown as Env;
  }

  it("answers exactly as the Worker's default export, with the same env and context", async () => {
    const workerModeEnv = workerEnv();
    const jwt = await accessJwt();
    const samples: readonly (readonly [string, () => Request])[] = [
      ["www", () => get(`${WWW_ORIGIN}/downloads?ref=synthetic`)],
      ["asset", () => get(`${PUBLIC_ORIGIN}/`)],
      ["health", () => get(`${PUBLIC_ORIGIN}/api/health`)],
      ["admin-host asset", () => get(`${ADMIN_ORIGIN}/admin`, { "cf-access-jwt-assertion": jwt })],
      ["unknown_api", () => get(`${PUBLIC_ORIGIN}/api/v1/does-not-exist`)],
      ["405", () => new Request(`${PUBLIC_ORIGIN}/api/health`, { method: "DELETE" })],
      ["D1-backed ready", () => get(`${PUBLIC_ORIGIN}/api/ready`)],
      ["disabled guard", () => new Request(`${PUBLIC_ORIGIN}${SPARKLE_APPCAST_GUARD_ROUTE}`, {
        method: "POST",
        body: "{}",
      })],
    ];
    const network = stubNetwork();
    const fetchSpy = vi.spyOn(worker, "fetch");
    for (const [label, request] of samples) {
      const expected = await snapshot(await worker.fetch(incoming(request()), workerModeEnv));
      const ctx = createExecutionContext();
      const edgeRequest = request();
      const actual = await snapshot(await edgeEntry.fetch(incoming(edgeRequest), workerModeEnv, ctx));
      await waitOnExecutionContext(ctx);
      expect(actual, label).toEqual(expected);
      const call = fetchSpy.mock.calls.at(-1) as unknown[] | undefined;
      expect(call?.[0], label).toBe(edgeRequest);
      expect(call?.[1], label).toBe(workerModeEnv);
      expect(call?.[2], label).toBe(ctx);
    }
    const statuses = await Promise.all(samples.map(async ([, request]) =>
      (await edgeFetch(request(), workerModeEnv)).status));
    expect(statuses).toEqual([308, 200, 200, 200, 404, 405, 503, 404]);
    expect(network.requests).toHaveLength(0);
  });

  it("delegates scheduled exactly once in worker mode and never otherwise", async () => {
    const scheduledSpy = vi.spyOn(worker, "scheduled").mockImplementation(() => undefined);
    const workerModeEnv = workerEnv();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "* * * * *" });
    const ctx = createExecutionContext();
    await edgeEntry.scheduled(controller, workerModeEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(scheduledSpy).toHaveBeenCalledTimes(1);
    const call = scheduledSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe(controller);
    expect(call[1]).toBe(workerModeEnv);
    expect(call[2]).toBe(ctx);

    for (const mode of ["fenced", "gcp", undefined, "", "GCP", " gcp", "Worker", "worker "]) {
      const otherCtx = createExecutionContext();
      const modeEnv = { ...workerEnv(), EDGE_UPSTREAM_MODE: mode } as unknown as Env;
      await edgeEntry.scheduled(controller, modeEnv, otherCtx);
      await waitOnExecutionContext(otherCtx);
    }
    expect(scheduledSpy).toHaveBeenCalledTimes(1);
  });
});

describe("fenced mode", () => {
  function fencedValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const values: Record<string, unknown> = {
      EDGE_UPSTREAM_MODE: "fenced",
      ENVIRONMENT: "production",
      PUBLIC_ORIGIN,
      PUBLIC_ANALYTICS_MODE: "enabled",
      ASSETS: syntheticAssets,
      ACCESS_TEAM_DOMAIN,
      ACCESS_AUD,
      ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
      DEPLOYMENT_SOURCE_COMMIT: SOURCE_COMMIT,
      ...guardSettings(),
      ...limiterBindings(),
      ...overrides,
    };
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete values[name];
    }
    return values;
  }

  it("serves only the barrier health, public assets and the www redirect, with no storage", async () => {
    const { env: fencedEnv, violations, reads } = guardedEnv(fencedValues());
    const network = stubNetwork();
    const jwt = await accessJwt();

    const health = await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), fencedEnv);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("retry-after")).toBeNull();
    expect(await health.json()).toEqual({
      status: "ok",
      mode: "migration-mutation-barrier",
      maintenance: { state: "fenced", storageQualified: false },
      deployment: { sourceCommit: SOURCE_COMMIT },
    });

    const asset = await edgeFetch(get(`${PUBLIC_ORIGIN}/downloads`), fencedEnv);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("retry-after")).toBeNull();
    expect(await asset.text()).toContain("synthetic asset /downloads");

    for (const path of ["/", "/downloads", "/assets/app.css"]) {
      const redirect = await edgeFetch(get(`${WWW_ORIGIN}${path}?ref=synthetic`), fencedEnv);
      expect(redirect.status, path).toBe(308);
      expect(redirect.headers.get("location"), path).toBe(`${PUBLIC_ORIGIN}${path}?ref=synthetic`);
      expect(redirect.headers.get("retry-after"), path).toBeNull();
    }

    const fencedRequests: Request[] = [];
    for (const route of WORKER_ROUTE_POLICY) {
      for (const method of routeMethods(route.methods)) {
        if (route.id === "health" && method === "GET") continue;
        fencedRequests.push(new Request(`${PUBLIC_ORIGIN}${route.pathname}`, { method }));
      }
    }
    fencedRequests.push(
      new Request(`${PUBLIC_ORIGIN}/api/health`, { method: "POST" }),
      get(`${PUBLIC_ORIGIN}/api/v1/does-not-exist`),
      await signedGuardRequest(await guardBody(), "fenced-guard-nonce-0001"),
      ...ADMIN_SURFACE_PATHS.map((path) => get(`${PUBLIC_ORIGIN}${path}`)),
      get(`${ADMIN_ORIGIN}/admin`, { "cf-access-jwt-assertion": jwt }),
      get(`${ADMIN_ORIGIN}/`, { "cf-access-jwt-assertion": jwt }),
      get(`${ADMIN_ORIGIN}/api/health`, { "cf-access-jwt-assertion": jwt }),
      get(`${ADMIN_ORIGIN}/api/v1/admin/overview`, { "cf-access-jwt-assertion": jwt }),
      new Request(`${WWW_ORIGIN}/api/v1/enroll`, { method: "POST" }),
      get(`${WWW_ORIGIN}/api/v1/community/daily`),
      get(`${WWW_ORIGIN}/api/v1/does-not-exist`),
    );
    expect(fencedRequests.length).toBeGreaterThan(WORKER_ROUTE_POLICY.length);
    for (const request of fencedRequests) {
      const label = `${request.method} ${request.url}`;
      await expectBarrier(await edgeFetch(request, fencedEnv), label);
    }

    // handleRequest's own rule: GET /api/health on any non-admin host is the
    // public barrier health, so the www host answers it too.
    const wwwHealth = await edgeFetch(get(`${WWW_ORIGIN}/api/health`), fencedEnv);
    expect(wwwHealth.status).toBe(200);
    expect(wwwHealth.headers.get("retry-after")).toBeNull();

    expect(violations).toEqual([]);
    expect(unexpectedReads(reads, FENCED_ENV_READS)).toEqual([]);
    expect(network.requests).toHaveLength(0);
    expect(await nonceRows(runtime.USAGE_MONITOR_DB)).toEqual([]);
    expect(await nonceRows(runtime.STORAGE_INGESTION_B)).toEqual([]);
  });

  it("adds retry-after only to the barrier's own 503, not to an asset's", async () => {
    const unavailableAssets = {
      async fetch(): Promise<Response> {
        return new Response("synthetic asset outage", { status: 503 });
      },
    };
    const { env: fencedEnv, violations } = guardedEnv(fencedValues({ ASSETS: unavailableAssets }));
    const asset = await edgeFetch(get(`${PUBLIC_ORIGIN}/downloads`), fencedEnv);
    expect(asset.status).toBe(503);
    expect(asset.headers.get("retry-after")).toBeNull();
    expect(await asset.text()).toBe("synthetic asset outage");
    await expectBarrier(await edgeFetch(get(`${PUBLIC_ORIGIN}/admin`), fencedEnv), "admin surface");
    expect(violations).toEqual([]);
  });

  it("keeps the unqualified barrier health 503 without a retry-after", async () => {
    const { env: fencedEnv, violations } = guardedEnv(fencedValues({ DEPLOYMENT_SOURCE_COMMIT: undefined }));
    const health = await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), fencedEnv);
    expect(health.status).toBe(503);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("retry-after")).toBeNull();
    expect(await health.json()).toEqual({
      status: "unavailable",
      mode: "migration-mutation-barrier",
      maintenance: { state: "fenced", storageQualified: false },
    });
    await expectBarrier(await edgeFetch(get(`${PUBLIC_ORIGIN}/api/ready`), fencedEnv), "ready");
    expect(violations).toEqual([]);
  });
});

describe("unconfigured modes", () => {
  interface Case {
    readonly label: string;
    readonly overrides: Record<string, unknown>;
    readonly wwwRecognised?: false;
    /** Only a key that reaches crypto.subtle.importKey is ever imported. */
    readonly importsKey?: true;
  }

  function cases(): readonly Case[] {
    const modeCases: Case[] = [undefined, "GCP", " gcp", "gcp ", "", "Fenced", "Worker", "proxy"]
      .map((mode) => ({ label: `mode ${JSON.stringify(mode)}`, overrides: { EDGE_UPSTREAM_MODE: mode } }));
    const gcpCases: Case[] = [
      { label: "EDGE_UPSTREAM_ORIGIN absent", overrides: { EDGE_UPSTREAM_ORIGIN: undefined } },
      { label: "EDGE_UPSTREAM_ORIGIN http", overrides: { EDGE_UPSTREAM_ORIGIN: "http://edge-entry-synthetic-abc123-uc.a.run.app" } },
      { label: "EDGE_UPSTREAM_ORIGIN off run.app", overrides: { EDGE_UPSTREAM_ORIGIN: "https://origin.tibotattle.test" } },
      { label: "EDGE_UPSTREAM_ORIGIN with a path", overrides: { EDGE_UPSTREAM_ORIGIN: `${UPSTREAM_ORIGIN}/api` } },
      { label: "EDGE_ORIGIN_AUDIENCE absent", overrides: { EDGE_ORIGIN_AUDIENCE: undefined } },
      { label: "EDGE_ORIGIN_AUDIENCE empty", overrides: { EDGE_ORIGIN_AUDIENCE: "" } },
      { label: "EDGE_ORIGIN_AUDIENCE padded", overrides: { EDGE_ORIGIN_AUDIENCE: ` ${AUDIENCE}` } },
      { label: "EDGE_INVOKER_SERVICE_ACCOUNT absent", overrides: { EDGE_INVOKER_SERVICE_ACCOUNT: undefined } },
      { label: "EDGE_INVOKER_SERVICE_ACCOUNT default compute", overrides: { EDGE_INVOKER_SERVICE_ACCOUNT: "123456789-compute@developer.gserviceaccount.com" } },
      { label: "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS 4", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "4" } },
      { label: "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS 301", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "301" } },
      { label: "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS 30s", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "30s" } },
      { label: "EDGE_CLIENT_KEY_SECRET of 31 characters", overrides: { EDGE_CLIENT_KEY_SECRET: "s".repeat(31) } },
      { label: "EDGE_CLIENT_KEY_SECRET absent", overrides: { EDGE_CLIENT_KEY_SECRET: undefined } },
      { label: "EDGE_INVOKER_KEY_JSON absent", overrides: { EDGE_INVOKER_KEY_JSON: undefined } },
      { label: "EDGE_INVOKER_KEY_JSON empty", overrides: { EDGE_INVOKER_KEY_JSON: "" } },
      { label: "EDGE_INVOKER_KEY_JSON malformed JSON", overrides: { EDGE_INVOKER_KEY_JSON: "{\"type\":\"service_account\"" } },
      { label: "EDGE_INVOKER_KEY_JSON for another account", overrides: { EDGE_INVOKER_KEY_JSON: invokerKeyJson({ client_email: "other-invoker@synthetic-project.iam.gserviceaccount.com" }) } },
      { label: "EDGE_INVOKER_KEY_JSON with a truncated key", overrides: { EDGE_INVOKER_KEY_JSON: truncatedDerKeyJson() }, importsKey: true },
      { label: "RELEASE_GUARD_DB absent", overrides: { RELEASE_GUARD_DB: undefined } },
      { label: "RELEASE_GUARD_DB not a database", overrides: { RELEASE_GUARD_DB: { prepare: "SELECT 1" } } },
      ...EDGE_ADMISSION_BINDINGS.map((name) => ({ label: `${name} absent`, overrides: { [name]: undefined } })),
      ...EDGE_ADMISSION_BINDINGS.map((name) => ({ label: `${name} without limit()`, overrides: { [name]: {} } })),
      { label: "PUBLIC_ORIGIN absent", overrides: { PUBLIC_ORIGIN: undefined }, wwwRecognised: false },
      { label: "PUBLIC_ORIGIN not canonical", overrides: { PUBLIC_ORIGIN: `${PUBLIC_ORIGIN}/` }, wwwRecognised: false },
    ];
    return [...modeCases, ...gcpCases];
  }

  it("serves www and assets and refuses everything else with 503 EDGE_NOT_CONFIGURED, without a network call", async () => {
    const network = stubNetwork();
    const jwt = await accessJwt();
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const pkcs8Imports = () => importKey.mock.calls.filter((call) => call[0] === "pkcs8").length;
    const allCases = cases();
    expect(allCases.length).toBeGreaterThan(30);
    for (const testCase of allCases) {
      const { env: edgeEnv, violations, reads } = guardedEnv(gcpValues(testCase.overrides));
      const before = warnings.length;
      const importsBefore = pkcs8Imports();

      const www = await edgeFetch(get(`${WWW_ORIGIN}/downloads?ref=synthetic`), edgeEnv);
      if (testCase.wwwRecognised === false) {
        expect(www.status, testCase.label).toBe(200);
      } else {
        expect(www.status, testCase.label).toBe(308);
        expect(www.headers.get("location"), testCase.label).toBe(`${PUBLIC_ORIGIN}/downloads?ref=synthetic`);
      }
      const asset = await edgeFetch(get(`${PUBLIC_ORIGIN}/`), edgeEnv);
      expect(asset.status, testCase.label).toBe(200);
      expect(await asset.text(), testCase.label).toContain("synthetic asset /");

      const refused: readonly Request[] = [
        get(`${PUBLIC_ORIGIN}/api/health`),
        get(`${PUBLIC_ORIGIN}/api/ready`),
        new Request(`${PUBLIC_ORIGIN}/api/v1/enroll`, { method: "POST", body: "{}" }),
        get(`${PUBLIC_ORIGIN}/api/v1/community/daily`),
        get(`${PUBLIC_ORIGIN}/api/v1/does-not-exist`),
        get(`${PUBLIC_ORIGIN}/.well-known/apple-developer-domain-association.txt`),
        get(`${ADMIN_ORIGIN}/api/v1/admin/overview`, { "cf-access-jwt-assertion": jwt }),
        await signedGuardRequest(await guardBody(), "unconfigured-guard-nonce-01"),
      ];
      for (const request of refused) {
        await expectNotConfigured(await edgeFetch(request, edgeEnv), `${testCase.label}: ${request.method} ${request.url}`);
      }
      expect(warnings.slice(before), testCase.label)
        .toEqual(refused.map(() => "{\"level\":\"warn\",\"code\":\"EDGE_NOT_CONFIGURED\"}"));
      expect(violations, testCase.label).toEqual([]);
      expect(unexpectedReads(reads, GCP_ENV_READS), testCase.label).toEqual([]);
      // A defective setting is refused before the invoker key is touched; a
      // failed construction is attempted once for the env, never per request.
      expect(pkcs8Imports() - importsBefore, testCase.label).toBe(testCase.importsKey === true ? 1 : 0);
    }
    expect(network.requests).toHaveLength(0);
    expect(await nonceRows(runtime.STORAGE_INGESTION_B)).toEqual([]);
    expect(await nonceRows(runtime.USAGE_MONITOR_DB)).toEqual([]);
  });
});

describe("gcp mode", () => {
  it("never reads storage bindings or Worker secrets while serving local, forwarded and guard requests", async () => {
    const { env: edgeEnv, violations, reads } = guardedEnv(gcpValues());
    const network = stubNetwork();

    const unknownApi = await edgeFetch(get(`${PUBLIC_ORIGIN}/api/v1/does-not-exist`), edgeEnv);
    expect(unknownApi.status).toBe(404);
    expect((await unknownApi.json<{ error: { code: string } }>()).error.code).toBe("NOT_FOUND");
    const asset = await edgeFetch(get(`${PUBLIC_ORIGIN}/`), edgeEnv);
    expect(asset.status).toBe(200);
    const www = await edgeFetch(get(`${WWW_ORIGIN}/downloads`), edgeEnv);
    expect(www.status).toBe(308);
    expect(network.requests).toHaveLength(0);

    const health = await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), edgeEnv);
    expect(health.status).toBe(200);
    expect(health.headers.get(EDGE_HEADERS.originMarker)).toBeNull();
    expect(await health.json()).toEqual({ synthetic: "origin", path: "/api/health" });
    const daily = await edgeFetch(get(`${PUBLIC_ORIGIN}/api/v1/community/daily`), edgeEnv);
    expect(daily.status).toBe(200);

    const upstream = network.upstream();
    expect(upstream.map((request) => request.url)).toEqual([
      `${UPSTREAM_ORIGIN}/api/health`,
      `${UPSTREAM_ORIGIN}/api/v1/community/daily`,
    ]);
    for (const request of upstream) {
      const invokerToken = request.headers.get(EDGE_HEADERS.invokerToken) ?? "";
      expect(invokerToken.startsWith("Bearer ")).toBe(true);
      expect(issuedIdTokens.has(invokerToken.slice("Bearer ".length))).toBe(true);
      expect(request.headers.get(EDGE_HEADERS.host)).toBe("apex");
    }
    expect(upstream[0]?.headers.get(EDGE_HEADERS.admission)).toBeNull();
    // The six named bindings reached EP-1's admission through the proxy.
    expect(upstream[1]?.headers.get(EDGE_HEADERS.admission)).toBe("v1;public_aggregate_read;allowed");

    await installArtifact("1");
    const guard = await edgeFetch(
      await signedGuardRequest(await guardBody(), "gcp-isolation-nonce-0001"),
      edgeEnv,
    );
    expect(guard.status).toBe(200);
    expect(await guard.json()).toMatchObject({ status: "committed" });
    expect(await nonceRows(runtime.STORAGE_INGESTION_B)).toEqual([{ nonce: "gcp-isolation-nonce-0001" }]);
    expect(network.upstream()).toHaveLength(2);

    expect(Object.keys(buildEdgeLocalEnv(edgeEnv))).toEqual([...EDGE_LOCAL_ENV_KEYS]);
    expect(violations).toEqual([]);
    expect(unexpectedReads(reads, GCP_ENV_READS)).toEqual([]);
    expect(reads.has("POSTGRES_WORKER_BACKEND")).toBe(false);
    // Only handleRequest's own content-free line for the local 404.
    expect(warnings.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([{
      level: "warn",
      event: "request_failed",
      requestId: expect.stringMatching(UUID_PATTERN_ANCHORED),
      method: "GET",
      routeClass: "unknown_api",
      code: "NOT_FOUND",
      status: 404,
    }]);
  });

  it("builds one proxy per env and never retries a failed construction within the isolate", async () => {
    const network = stubNetwork();
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const pkcs8Imports = () => importKey.mock.calls.filter((call) => call[0] === "pkcs8").length;

    const first = gcpEnv();
    expect((await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), first)).status).toBe(200);
    expect(pkcs8Imports()).toBe(1);
    expect((await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), first)).status).toBe(200);
    expect((await edgeFetch(get(`${PUBLIC_ORIGIN}/api/v1/community/daily`), first)).status).toBe(200);
    expect(pkcs8Imports()).toBe(1);
    // Concurrent first requests on a fresh env share one construction.
    const concurrent = gcpEnv();
    const statuses = await Promise.all([1, 2, 3].map(async () =>
      (await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), concurrent)).status));
    expect(statuses).toEqual([200, 200, 200]);
    expect(pkcs8Imports()).toBe(2);

    const broken = gcpEnv({ EDGE_INVOKER_KEY_JSON: truncatedDerKeyJson() });
    const upstreamBefore = network.upstream().length;
    await expectNotConfigured(await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), broken), "first");
    expect(pkcs8Imports()).toBe(3);
    await expectNotConfigured(await edgeFetch(get(`${PUBLIC_ORIGIN}/api/health`), broken), "second");
    await expectNotConfigured(
      await edgeFetch(await signedGuardRequest(await guardBody(), "broken-proxy-nonce-0001"), broken),
      "guard",
    );
    expect(pkcs8Imports()).toBe(3);
    expect(network.upstream()).toHaveLength(upstreamBefore);
    expect((await edgeFetch(get(`${PUBLIC_ORIGIN}/`), broken)).status).toBe(200);
    expect(await nonceRows(runtime.STORAGE_INGESTION_B)).toEqual([]);
  });

  it("merges distribution analytics only where the Worker reads them", async () => {
    // The merge itself is E4's. Here: the analytics API is read, and the
    // origin's cloudflare section replaced, only in a production ENVIRONMENT
    // with both settings present (index.ts handleAdminOverview).
    const network = stubNetwork();
    const jwt = await accessJwt();
    const zone = "0123456789abcdef0123456789abcdef";
    const token = "synthetic-distribution-api-token-0001";
    const cases: readonly (readonly [string, Record<string, unknown>, boolean])[] = [
      ["production with both", { DISTRIBUTION_ANALYTICS_ZONE_ID: zone, DISTRIBUTION_ANALYTICS_API_TOKEN: token }, true],
      ["production without a token", { DISTRIBUTION_ANALYTICS_ZONE_ID: zone }, false],
      ["production with an empty zone", { DISTRIBUTION_ANALYTICS_ZONE_ID: "", DISTRIBUTION_ANALYTICS_API_TOKEN: token }, false],
      ["staging with both", {
        ENVIRONMENT: "staging",
        DISTRIBUTION_ANALYTICS_ZONE_ID: zone,
        DISTRIBUTION_ANALYTICS_API_TOKEN: token,
      }, false],
      ["development with both", {
        ENVIRONMENT: "synthetic-development",
        ACCESS_TEST_JWKS_JSON: accessJwksJson,
        DISTRIBUTION_ANALYTICS_ZONE_ID: zone,
        DISTRIBUTION_ANALYTICS_API_TOKEN: token,
      }, false],
    ];
    for (const [label, overrides, merged] of cases) {
      const readsBefore = network.analyticsReads();
      const response = await edgeFetch(
        get(`${ADMIN_ORIGIN}/api/v1/admin/overview`, { "cf-access-jwt-assertion": jwt }),
        gcpEnv(overrides),
      );
      expect(response.status, label).toBe(200);
      const body = await response.json<{ distribution: { cloudflare: unknown } }>();
      if (merged) {
        expect(network.analyticsReads() - readsBefore, label).toBeGreaterThan(0);
        expect(body.distribution.cloudflare, label).not.toEqual(ORIGIN_OVERVIEW_PLACEHOLDER);
        expect(body.distribution.cloudflare, label).toMatchObject({ status: "unavailable" });
      } else {
        expect(network.analyticsReads() - readsBefore, label).toBe(0);
        expect(body.distribution.cloudflare, label).toEqual(ORIGIN_OVERVIEW_PLACEHOLDER);
      }
    }
    expect(network.upstream()).toHaveLength(cases.length);
  });
});

describe("release guard in gcp mode", () => {
  it("writes only nonce rows to the release guard D1 and refuses a replay as worker mode does", async () => {
    const network = stubNetwork();
    await installArtifact("1");
    const guardDb = runtime.STORAGE_INGESTION_B;
    const schemaBefore = await schema(guardDb);
    expect(schemaBefore.filter((row) => !row.name.startsWith("_cf_")).map((row) => row.name).sort()).toEqual([
      "idx_sparkle_appcast_guard_nonces_expires_at",
      "sparkle_appcast_guard_nonces",
      "sqlite_autoindex_sparkle_appcast_guard_nonces_1",
    ]);
    const mainBefore = await tableContents(runtime.USAGE_MONITOR_DB);

    const body = await guardBody();
    const committed = await edgeFetch(await signedGuardRequest(body, "gcp-guard-nonce-000001"), gcpEnv());
    expect(committed.status).toBe(200);
    expect(committed.headers.get("cache-control")).toBe("no-store");
    expect(await committed.json()).toMatchObject({ status: "committed" });
    expect(await runtime.QUARANTINE.head(SPARKLE_APPCAST_GUARD_KEY)).not.toBeNull();

    const replay = await snapshot(
      await edgeFetch(await signedGuardRequest(body, "gcp-guard-nonce-000001"), gcpEnv()),
    );
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toMatchObject({ error: { code: "SPARKLE_APPCAST_GUARD_REPLAY_INVALID" } });

    expect(await schema(guardDb)).toEqual(schemaBefore);
    expect(await nonceRows(guardDb)).toEqual([{ nonce: "gcp-guard-nonce-000001" }]);
    // The Worker's own database is out of the edge's reach.
    expect(await tableContents(runtime.USAGE_MONITOR_DB)).toEqual(mainBefore);
    expect(network.requests).toHaveLength(0);

    // Worker mode on the Worker's database: the same replay answer.
    const workerModeEnv = {
      ...gcpValues({ EDGE_UPSTREAM_MODE: "worker" }),
      USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    } as unknown as Env;
    const workerFirst = await edgeFetch(await signedGuardRequest(body, "worker-guard-nonce-01"), workerModeEnv);
    // The appcast now exists, so the empty expectation conflicts after the
    // nonce is consumed.
    expect(workerFirst.status).toBe(409);
    const workerReplay = await snapshot(
      await edgeFetch(await signedGuardRequest(body, "worker-guard-nonce-01"), workerModeEnv),
    );
    expect(replay).toEqual(workerReplay);
  });

  it("keeps a sampled guard 5xx from writing anything but the nonce, even into a full Worker schema", async () => {
    stubNetwork();
    await installArtifact("1");
    // A stand-in that holds every Worker table, including
    // diagnostic_error_events, so a leaked diagnostic write would land.
    const fullSchemaDb = runtime.STORAGE_INGESTION_A;
    await applyD1Migrations(fullSchemaDb, runtime.TEST_MIGRATIONS);
    const schemaBefore = await schema(fullSchemaDb);
    const contentsBefore = await tableContents(fullSchemaDb);
    expect(Object.keys(contentsBefore)).toContain("diagnostic_error_events");
    expect(Object.keys(contentsBefore).length).toBeGreaterThan(20);

    const forced5xx = { [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV]: "0".repeat(64) };
    const randomUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(SAMPLED_REQUEST_ID);
    const body = await guardBody();

    const gcpResponse = await edgeFetch(
      await signedGuardRequest(body, "sampled-gcp-nonce-0001"),
      gcpEnv({ ...forced5xx, RELEASE_GUARD_DB: fullSchemaDb }),
    );
    expect(gcpResponse.status).toBe(503);
    expect(await gcpResponse.json()).toEqual({
      error: { code: "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID", requestId: SAMPLED_REQUEST_ID },
    });
    expect(randomUuid).toHaveBeenCalled();
    expect(await schema(fullSchemaDb)).toEqual(schemaBefore);
    const contentsAfter = await tableContents(fullSchemaDb);
    for (const [table, contents] of Object.entries(contentsBefore)) {
      if (table === "sparkle_appcast_guard_nonces") continue;
      expect(contentsAfter[table], table).toBe(contents);
    }
    expect(await nonceRows(fullSchemaDb)).toEqual([{ nonce: "sampled-gcp-nonce-0001" }]);

    // Control: the unchanged Worker on the same database records the sampled
    // failure, so the gcp run above really did reach recordDiagnosticError.
    const workerResponse = await edgeFetch(
      await signedGuardRequest(body, "sampled-worker-nonce-01"),
      gcpEnv({ ...forced5xx, EDGE_UPSTREAM_MODE: "worker", USAGE_MONITOR_DB: fullSchemaDb }),
    );
    expect(workerResponse.status).toBe(503);
    const diagnostics = await fullSchemaDb.prepare(
      "SELECT request_id, route_class, error_code, status FROM diagnostic_error_events",
    ).all();
    expect(diagnostics.results).toEqual([{
      request_id: SAMPLED_REQUEST_ID,
      route_class: "sparkle_appcast_guard",
      error_code: "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID",
      status: 503,
    }]);
  });
});

describe("release guard database facade", () => {
  function expectRefused(action: () => unknown, label: string): void {
    let thrown: unknown;
    try {
      action();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, label).toBeInstanceOf(Error);
    expect((thrown as Error).message, label).toBe(EDGE_GUARD_DB_STATEMENT_REFUSED);
    expect(Reflect.get(thrown as Error, "code"), label).toBe(EDGE_GUARD_DB_STATEMENT_REFUSED);
  }

  it("runs nonce-table SQL and refuses everything else before touching the database", async () => {
    const db = runtime.STORAGE_INGESTION_B;
    const touched: string[] = [];
    const observed = new Proxy(db, {
      get(target, property) {
        touched.push(String(property));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const facade = createReleaseGuardDatabase(observed);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(["batch", "dump", "exec", "prepare", "withSession"]);

    for (const sql of [
      "SELECT 1",
      "INSERT INTO diagnostic_error_events (request_id) VALUES (?)",
      "DELETE FROM sparkle_appcast_guard_nonces_archive",
      "SELECT * FROM idx_sparkle_appcast_guard_nonces_expires_at",
      "",
    ]) {
      expectRefused(() => facade.prepare(sql), `prepare ${sql}`);
      expectRefused(() => facade.exec(sql), `exec ${sql}`);
    }
    expectRefused(() => facade.prepare(42 as unknown as string), "prepare non-string");
    expectRefused(() => facade.withSession(), "withSession");
    expectRefused(() => facade.withSession("first-primary"), "withSession constraint");
    expectRefused(() => facade.dump(), "dump");
    expectRefused(() => facade.batch("SELECT 1" as unknown as D1PreparedStatement[]), "batch non-array");
    expectRefused(
      () => facade.batch([db.prepare("DELETE FROM sparkle_appcast_guard_nonces")]),
      "batch with a statement the facade did not prepare",
    );
    const otherFacade = createReleaseGuardDatabase(db);
    expectRefused(
      () => facade.batch([otherFacade.prepare("DELETE FROM sparkle_appcast_guard_nonces")]),
      "batch with another facade's statement",
    );
    expect(touched).toEqual([]);

    const insert = facade.prepare(
      "INSERT INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)",
    );
    await insert.bind("facade-nonce-000000001", 100).run();
    const select = facade.prepare(
      "SELECT nonce, expires_at FROM sparkle_appcast_guard_nonces ORDER BY nonce",
    );
    expect(await select.first()).toEqual({ nonce: "facade-nonce-000000001", expires_at: 100 });
    expect(await select.first("nonce")).toBe("facade-nonce-000000001");
    expect((await select.all()).results).toEqual([{ nonce: "facade-nonce-000000001", expires_at: 100 }]);
    expect(await select.raw()).toEqual([["facade-nonce-000000001", 100]]);
    expect(await select.raw({ columnNames: true })).toEqual([["nonce", "expires_at"], ["facade-nonce-000000001", 100]]);
    await facade.batch([
      insert.bind("facade-nonce-000000002", 200),
      facade.prepare("DELETE FROM sparkle_appcast_guard_nonces WHERE expires_at <= ?").bind(100),
    ]);
    expect(await nonceRows(db)).toEqual([{ nonce: "facade-nonce-000000002" }]);
    await facade.exec("DELETE FROM sparkle_appcast_guard_nonces");
    expect(await nonceRows(db)).toEqual([]);
    expect(touched.every((name) => ["prepare", "batch", "exec"].includes(name))).toBe(true);
  });

  it("matches only the nonce table name as a whole word", () => {
    expect(EDGE_GUARD_NONCE_TABLE_PATTERN.test("DELETE FROM sparkle_appcast_guard_nonces WHERE expires_at <= ?")).toBe(true);
    expect(EDGE_GUARD_NONCE_TABLE_PATTERN.test("INSERT OR IGNORE INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)")).toBe(true);
    expect(EDGE_GUARD_NONCE_TABLE_PATTERN.test("SELECT * FROM sparkle_appcast_guard_nonces_v2")).toBe(false);
    expect(EDGE_GUARD_NONCE_TABLE_PATTERN.test("SELECT * FROM xsparkle_appcast_guard_nonces")).toBe(false);
    expect(EDGE_GUARD_NONCE_TABLE_PATTERN.flags).toBe("u");
  });
});

describe("release guard migration", () => {
  it("carries exactly the CREATE statements of the Worker's 0029", () => {
    const guardStatements = sqlStatements(rawText(rawReleaseGuardMigration));
    const workerStatements = sqlStatements(rawText(rawWorkerNonceMigration));
    expect(guardStatements).toHaveLength(2);
    expect(guardStatements.every((statement) => statement.startsWith("CREATE "))).toBe(true);
    expect(guardStatements).toEqual(workerStatements);
  });
});
