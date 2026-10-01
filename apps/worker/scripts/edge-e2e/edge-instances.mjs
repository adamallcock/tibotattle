// E12 local end-to-end: Miniflare instances of the edge bundle.
//
// Every instance runs the bundle edge-bundle.mjs built, in workerd, through
// the Miniflare API. Nothing listens on a public interface and nothing reaches
// Cloudflare: each instance's only network is its outboundService (the Google
// front-end emulator for an edge, a recording refusal for a reference).
//
// - createEdgeInstance: the thin edge in one EDGE_UPSTREAM_MODE (gcp, fenced,
//   absent or invalid), with exactly the bindings the EP-9 gcp overlay keeps
//   (the edge settings, the edge secrets, the six edge-tier rate limits, the
//   release-guard D1, the Sparkle bucket, ASSETS, the Access and Sparkle
//   settings) plus decoy USAGE_MONITOR_DB and QUARANTINE bindings that a
//   gcp-mode edge must never touch.
// - createReferenceInstance: the same bundle in worker mode (index.ts's
//   default export unchanged, as E5's worker mode runs it) or another main
//   built with the same settings, with full Worker storage: USAGE_MONITOR_DB
//   and DELETION_LEDGER migrated from ./migrations and
//   ./deletion-ledger-migrations, QUARANTINE and SPARKLE_RELEASES, the
//   UploadIngressBudget Durable Object, all eight rate limits, and the
//   checked-in env.production vars with every identifier replaced by a
//   synthetic one.
//
// Requests go through dispatchFetch with an explicit CF-Connecting-IP (the
// address Cloudflare would supply) and, for a fixed-length body, an explicit
// Content-Length: Miniflare's dispatchFetch otherwise presents every body to
// workerd chunked, which no HTTP client that knows its body length sends.

import { createHash, generateKeyPairSync, randomBytes, sign as signBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { parse } from "jsonc-parser";
import { Miniflare } from "miniflare";
import { EDGE_E2E_WORKER_ROOT } from "./edge-bundle.mjs";

export const EDGE_E2E_PUBLIC_ORIGIN = "https://tibotattle.test";
export const EDGE_E2E_ADMIN_ORIGIN = "https://admin.tibotattle.test";
export const EDGE_E2E_WWW_ORIGIN = "https://www.tibotattle.test";
export const EDGE_E2E_UPSTREAM_ORIGIN = "https://edge-e2e-origin-000000000000.us-east1.run.app";
export const EDGE_E2E_AUDIENCE = EDGE_E2E_UPSTREAM_ORIGIN;
export const EDGE_E2E_INVOKER = "edge-e2e-invoker@synthetic-edge-0.iam.gserviceaccount.com";
export const EDGE_E2E_VERIFIER = "edge-e2e-verifier@synthetic-edge-0.iam.gserviceaccount.com";
export const EDGE_E2E_STRANGER = "edge-e2e-stranger@synthetic-edge-0.iam.gserviceaccount.com";
export const EDGE_E2E_ACCESS_TEAM_DOMAIN = "synthetic-edge.cloudflareaccess.com";
export const EDGE_E2E_ACCESS_AUD = "e".repeat(64);
export const EDGE_E2E_OWNER_EMAIL = "owner@tibotattle.test";
export const EDGE_E2E_SOURCE_COMMIT = "e12e12e12e12e12e12e12e12e12e12e12e12e12e";
export const EDGE_E2E_COMPATIBILITY = Object.freeze({ date: "2026-07-26", flags: Object.freeze(["nodejs_compat"]) });
/** Miniflare's own response transport header; never part of a Worker answer. */
export const MINIFLARE_RESPONSE_HEADER_PREFIX = "mf-";

export const EDGE_TIER_BINDINGS = Object.freeze([
  "ENROLLMENT_RATE_LIMIT",
  "RECOVERY_RATE_LIMIT",
  "CLIENT_ATTEMPT_RATE_LIMIT",
  "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
]);
export const ORIGIN_TIER_BINDINGS = Object.freeze([
  "UPLOAD_AUTHORIZATION_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
]);
const ALL_BINDINGS = Object.freeze([...EDGE_TIER_BINDINGS, ...ORIGIN_TIER_BINDINGS]);

/** 10000 per 60 s on every binding: no stage except S4 is limited by accident. */
export const GENEROUS_LIMITS = Object.freeze(Object.fromEntries(ALL_BINDINGS.map((name) => [name, 10_000])));

/** The env.production rate limits checked in at this commit, by binding name. */
export async function readCheckedInProductionLimits(workerRoot = EDGE_E2E_WORKER_ROOT) {
  const config = parse(await readFile(join(workerRoot, "wrangler.jsonc"), "utf8"));
  const limits = {};
  for (const entry of config.env.production.ratelimits) {
    if (entry.simple.period !== 60) throw new Error("EDGE_E2E_PRODUCTION_PERIOD_UNEXPECTED");
    limits[entry.name] = entry.simple.limit;
  }
  return Object.freeze(limits);
}

/** The checked-in env.production vars, with every identifier replaced. */
export async function readSanitizedProductionVars(workerRoot = EDGE_E2E_WORKER_ROOT) {
  const config = parse(await readFile(join(workerRoot, "wrangler.jsonc"), "utf8"));
  const vars = { ...config.env.production.vars };
  for (const name of Object.keys(vars)) {
    if (/^(?:ACCESS_|APPLE_|GOOGLE_|DISTRIBUTION_|SPARKLE_)/u.test(name) || name === "PUBLIC_ORIGIN") {
      delete vars[name];
    }
  }
  return vars;
}

function rateLimits(limits) {
  const result = {};
  let namespace = 7_000;
  for (const [name, limit] of Object.entries(limits)) {
    namespace += 1;
    result[name] = { namespace_id: String(namespace), simple: { limit, period: 60 } };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fixture assets

const FIXTURE_ASSETS = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/privacy.html": ["privacy.html", "text/html; charset=utf-8"],
  "/release-site-manifest.json": ["release-site-manifest.json", "application/json; charset=utf-8"],
});
const NOT_FOUND_PAGE = "<!doctype html><title>Not found</title><p>Not found.</p>\n";

/** The ASSETS service binding: the three fixture files and a 404 page. */
export async function createFixtureAssets(workerRoot = EDGE_E2E_WORKER_ROOT) {
  const directory = join(workerRoot, "scripts", "edge-e2e", "fixtures", "assets");
  const files = {};
  for (const [path, [file, type]] of Object.entries(FIXTURE_ASSETS)) {
    files[path] = { bytes: await readFile(join(directory, file)), type };
  }
  const requests = [];
  async function assets(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, host: url.hostname, path: url.pathname });
    const file = files[url.pathname];
    if (file === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
      return new Response(request.method === "HEAD" ? null : NOT_FOUND_PAGE, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
      });
    }
    return new Response(request.method === "HEAD" ? null : file.bytes, {
      status: 200,
      headers: {
        "content-type": file.type,
        "cache-control": "public, max-age=0, must-revalidate",
        etag: `"${createHash("sha256").update(file.bytes).digest("hex").slice(0, 32)}"`,
      },
    });
  }
  return Object.freeze({ fetch: assets, requests });
}

// ---------------------------------------------------------------------------
// Synthetic Access and Sparkle material

/** A synthetic Cloudflare Access signer and its JWKS (ACCESS_TEST_JWKS_JSON). */
export function createAccessFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = `edge-e2e-access-${randomBytes(4).toString("hex")}`;
  const jwk = publicKey.export({ format: "jwk" });
  const jwksJson = JSON.stringify({ keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  function token({ email = EDGE_E2E_OWNER_EMAIL, aud = EDGE_E2E_ACCESS_AUD, signer = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1_000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      aud: [aud], email, iss: `https://${EDGE_E2E_ACCESS_TEAM_DOMAIN}`, iat: now, nbf: now, exp: now + 600,
      sub: "synthetic-access-subject",
    })).toString("base64url");
    const signature = signBytes("RSA-SHA256", Buffer.from(`${header}.${claims}`), signer).toString("base64url");
    return `${header}.${claims}.${signature}`;
  }
  return Object.freeze({
    jwksJson,
    owner: () => token(),
    nonOwner: () => token({ email: "someone-else@tibotattle.test" }),
    wrongAudience: () => token({ aud: "f".repeat(64) }),
    wrongKey: () => token({ signer: otherKey }),
  });
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** A synthetic Sparkle release key, guard token and the guard's settings. */
export async function createSparkleFixture(workerRoot = EDGE_E2E_WORKER_ROOT) {
  const contract = JSON.parse(await readFile(join(workerRoot, "src", "sparkle-release-contract.json"), "utf8"));
  const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const token = `edge-e2e-synthetic-release-guard-token-${randomBytes(12).toString("hex")}`;
  const artifact = new TextEncoder().encode(`edge-e2e-synthetic-signed-dmg-${randomBytes(4).toString("hex")}`);
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  const settings = Object.freeze({
    SPARKLE_APPCAST_GUARD_MODE: "enabled",
    SPARKLE_APPCAST_GUARD_CHANNEL: contract.channel,
    SPARKLE_APPCAST_GUARD_BUCKET: contract.r2Bucket,
    SPARKLE_APPCAST_GUARD_APPCAST_KEY: contract.appcastObjectKey,
    SPARKLE_APPCAST_GUARD_ENDPOINT_PATH: contract.guardRoute,
    SPARKLE_APPCAST_GUARD_CONTENT_TYPE: contract.appcastContentType,
    SPARKLE_APPCAST_GUARD_CACHE_CONTROL: contract.appcastCacheControl,
    SPARKLE_APPCAST_GUARD_MAX_XML_BYTES: "1048576",
    SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY: base64(publicRaw),
    SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256: createHash("sha256").update(publicRaw).digest("hex"),
    SPARKLE_APPCAST_GUARD_TOKEN: token,
  });
  const artifactKey = (version) => `${contract.objectPrefix}/${version}/${artifactDigest}/TiboTattle.dmg`;
  async function appcast(version) {
    const signature = base64(new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, artifact)));
    return new TextEncoder().encode(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<enclosure url="${contract.updateOrigin}/${artifactKey(version)}" length="${artifact.byteLength}" sparkle:version="${version}" sparkle:edSignature="${signature}" />
</item></channel></rss>`);
  }
  /** The signed guard POST for publishing `version` over an empty appcast. */
  async function guardRequest({ version = "1", nonce = randomBytes(16).toString("hex") } = {}) {
    const candidate = await appcast(version);
    const body = JSON.stringify({
      schemaVersion: contract.guardSchema,
      channel: contract.channel,
      bucket: contract.r2Bucket,
      key: contract.appcastObjectKey,
      contentType: contract.appcastContentType,
      cacheControl: contract.appcastCacheControl,
      expectedCurrent: { state: "empty", bytes: 0, sha256: null, etag: null },
      candidate: {
        bytes: candidate.byteLength,
        sha256: createHash("sha256").update(candidate).digest("hex"),
        base64: Buffer.from(candidate).toString("base64url"),
      },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const canonical = `${contract.guardSchema}\0POST\0${contract.guardRoute}\0${timestamp}\0${nonce}\0`
      + createHash("sha256").update(body).digest("hex");
    const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
    return {
      path: contract.guardRoute,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-usage-monitor-release-timestamp": String(timestamp),
        "x-usage-monitor-release-nonce": nonce,
        "x-usage-monitor-release-signature": Buffer.from(signature).toString("base64url"),
      },
      body,
    };
  }
  async function installArtifact(bucket) {
    await bucket.put(artifactKey("1"), artifact, {
      httpMetadata: { contentType: contract.artifactContentType, cacheControl: contract.artifactCacheControl },
    });
  }
  return Object.freeze({ contract, settings, guardRequest, installArtifact });
}

// ---------------------------------------------------------------------------
// Instances

function normalizeResponse(response, body) {
  const headers = [];
  for (const [name, value] of response.headers) {
    if (name === "set-cookie" || name.startsWith(MINIFLARE_RESPONSE_HEADER_PREFIX)) continue;
    headers.push([name, value]);
  }
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  return Object.freeze({
    status: response.status,
    headers: Object.freeze(headers),
    header(name) {
      const values = headers.filter(([key]) => key === name).map(([, value]) => value);
      return values.length === 0 ? null : values.join(", ");
    },
    body,
    text: body.toString("utf8"),
    json() {
      try { return JSON.parse(body.toString("utf8")); } catch { return null; }
    },
  });
}

function requestInit({ method = "GET", headers = {}, body, ip, chunked = false, signal }) {
  const init = { method, redirect: "manual", headers: { ...headers } };
  if (ip !== null && ip !== undefined) init.headers["cf-connecting-ip"] = ip;
  if (body !== undefined && body !== null) {
    if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
      const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
      const declared = Object.keys(init.headers).some((name) => name.toLowerCase() === "content-length");
      if (!chunked && !declared) init.headers["content-length"] = String(bytes.byteLength);
      init.body = chunked
        ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })
        : bytes;
      if (chunked) init.duplex = "half";
    } else {
      init.body = body;
      init.duplex = "half";
    }
  }
  if (signal !== undefined) init.signal = signal;
  return init;
}

async function startMiniflare({ bundle, bindings, d1Databases = [], r2Buckets = [], limits, assets, outbound,
  durableObjects = {}, logs }) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: bundle.modulePath,
    modulesRoot: bundle.directory,
    compatibilityDate: EDGE_E2E_COMPATIBILITY.date,
    compatibilityFlags: [...EDGE_E2E_COMPATIBILITY.flags],
    bindings,
    d1Databases,
    r2Buckets,
    durableObjects,
    ratelimits: rateLimits(limits),
    serviceBindings: { ASSETS: assets.fetch },
    outboundService: outbound,
    structuredWorkerdLogs: true,
    handleStructuredLogs: ({ level, message }) => { logs.push({ level, message }); },
  });
  await mf.ready;
  return mf;
}

function instanceApi(mf, logs, extra) {
  return Object.freeze({
    mf,
    logs,
    async fetch(url, options = {}) {
      const response = await mf.dispatchFetch(url, requestInit(options));
      const body = Buffer.from(await response.arrayBuffer());
      return normalizeResponse(response, body);
    },
    /** For shipped clients: a fetch-shaped function over dispatchFetch. */
    clientFetch(ip) {
      return async (input, init = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = Object.fromEntries(new Headers(init.headers ?? {}));
        return mf.dispatchFetch(url, requestInit({ method: init.method, headers, body: init.body, ip }));
      };
    },
    warnLines() {
      return logs.filter((line) => line.level === "warn").map((line) => line.message);
    },
    ...extra,
    async dispose() { await mf.dispose(); },
  });
}

async function applyMigrations(db, migrations) {
  for (const migration of migrations) {
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  }
}

/**
 * The edge in `mode` ('gcp', 'fenced', 'worker' without storage, or null for
 * an absent mode). frontEnd is createGoogleFrontEnd's result (gcp) or null;
 * `overrides` replaces or (with undefined) removes bindings.
 */
export async function createEdgeInstance({
  bundle,
  mode,
  frontEnd = null,
  invokerKeyJson,
  clientKeySecret = randomBytes(32).toString("hex"),
  limits = GENEROUS_LIMITS,
  access,
  sparkle,
  assets,
  overrides = {},
  omitLimits = [],
  publicAnalyticsMode = "enabled",
}) {
  const logs = [];
  const bindings = {
    PUBLIC_ORIGIN: EDGE_E2E_PUBLIC_ORIGIN,
    ENVIRONMENT: "development",
    PUBLIC_ANALYTICS_MODE: publicAnalyticsMode,
    DEPLOYMENT_SOURCE_COMMIT: EDGE_E2E_SOURCE_COMMIT,
    EDGE_UPSTREAM_ORIGIN: EDGE_E2E_UPSTREAM_ORIGIN,
    EDGE_ORIGIN_AUDIENCE: EDGE_E2E_AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: EDGE_E2E_INVOKER,
    EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "5",
    EDGE_INVOKER_KEY_JSON: invokerKeyJson,
    EDGE_CLIENT_KEY_SECRET: clientKeySecret,
    ACCESS_TEAM_DOMAIN: EDGE_E2E_ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: EDGE_E2E_ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: EDGE_E2E_OWNER_EMAIL,
    ACCESS_TEST_JWKS_JSON: access.jwksJson,
    ...sparkle.settings,
  };
  if (mode !== null) bindings.EDGE_UPSTREAM_MODE = mode;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete bindings[name];
    else bindings[name] = value;
  }
  const edgeTierLimits = Object.fromEntries(EDGE_TIER_BINDINGS.map((name) => [name, limits[name]]));
  for (const name of omitLimits) delete edgeTierLimits[name];
  const refusals = [];
  const outbound = frontEnd === null
    ? { node: (req, res) => { refusals.push({ host: req.headers.host ?? null }); req.resume(); res.destroy(); } }
    : { node: frontEnd.node };
  const mf = await startMiniflare({
    bundle,
    bindings,
    d1Databases: ["RELEASE_GUARD_DB", "USAGE_MONITOR_DB"],
    r2Buckets: ["SPARKLE_RELEASES", "QUARANTINE"],
    limits: edgeTierLimits,
    assets,
    outbound,
    durableObjects: { UPLOAD_INGRESS_BUDGET: "UploadIngressBudget" },
    logs,
  });
  const guardDb = await mf.getD1Database("RELEASE_GUARD_DB");
  const guardMigrations = await readD1Migrations(join(EDGE_E2E_WORKER_ROOT, "release-guard-migrations"));
  await applyMigrations(guardDb, guardMigrations);
  const sparkleBucket = await mf.getR2Bucket("SPARKLE_RELEASES");
  await sparkle.installArtifact(sparkleBucket);
  return instanceApi(mf, logs, {
    mode,
    refusals,
    guardDb,
    sparkleBucket,
    decoyDb: await mf.getD1Database("USAGE_MONITOR_DB"),
    decoyBucket: await mf.getR2Bucket("QUARANTINE"),
  });
}

/**
 * The unchanged Worker with full storage: the edge bundle in worker mode, or
 * `bundle` built from another main with the same settings.
 */
export async function createReferenceInstance({
  bundle,
  mode = "worker",
  limits = GENEROUS_LIMITS,
  access,
  sparkle,
  assets,
  envelope,
  identityLinkSecret = randomBytes(32).toString("hex"),
  overrides = {},
}) {
  const logs = [];
  const bindings = {
    ...await readSanitizedProductionVars(),
    ENVIRONMENT: "development",
    PUBLIC_ORIGIN: EDGE_E2E_PUBLIC_ORIGIN,
    DEPLOYMENT_SOURCE_COMMIT: EDGE_E2E_SOURCE_COMMIT,
    GOOGLE_OIDC_CLIENT_ID: "000000000000-synthetic.apps.googleusercontent.com",
    IDENTITY_LINK_SECRET: identityLinkSecret,
    ENVELOPE_PUBLIC_JWK: envelope.publicText,
    ENVELOPE_PRIVATE_JWK: envelope.privateText,
    ACCESS_TEAM_DOMAIN: EDGE_E2E_ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: EDGE_E2E_ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: EDGE_E2E_OWNER_EMAIL,
    ACCESS_TEST_JWKS_JSON: access.jwksJson,
    ...sparkle.settings,
  };
  if (mode !== null) bindings.EDGE_UPSTREAM_MODE = mode;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete bindings[name];
    else bindings[name] = value;
  }
  const refusals = [];
  const mf = await startMiniflare({
    bundle,
    bindings,
    d1Databases: ["USAGE_MONITOR_DB", "DELETION_LEDGER"],
    r2Buckets: ["QUARANTINE", "SPARKLE_RELEASES"],
    limits,
    assets,
    outbound: { node: (req, res) => { refusals.push({ host: req.headers.host ?? null }); req.resume(); res.destroy(); } },
    durableObjects: { UPLOAD_INGRESS_BUDGET: "UploadIngressBudget" },
    logs,
  });
  const db = await mf.getD1Database("USAGE_MONITOR_DB");
  await applyMigrations(db, await readD1Migrations(join(EDGE_E2E_WORKER_ROOT, "migrations")));
  const ledger = await mf.getD1Database("DELETION_LEDGER");
  await applyMigrations(ledger, await readD1Migrations(join(EDGE_E2E_WORKER_ROOT, "deletion-ledger-migrations")));
  const sparkleBucket = await mf.getR2Bucket("SPARKLE_RELEASES");
  await sparkle.installArtifact(sparkleBucket);
  return instanceApi(mf, logs, { mode, refusals, db, ledger, sparkleBucket });
}
