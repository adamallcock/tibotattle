/**
 * PG17 spec for the origin public read of community model performance
 * (SPD-P4): src/analytics-v2/community-model-performance-route.ts serving
 * GET /api/v1/community/model-performance?period&speedMode from the twelve
 * community-model-performance-v1 heads in analytics_v2_published_performance
 * (primary 0079).
 *
 * It pins every status path and header:
 * - 200 for a verified head, the only publicly cacheable answer
 *   (Cache-Control `public, max-age=300`), serving the payload the store
 *   wrote (store-publication.ts writeAnalyticsV2PublishedPerformance) byte
 *   for byte in canonical key order;
 * - 404 COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED with no-store for a slot with
 *   no head, never a 5xx;
 * - 400 BODY_INVALID for the whole parameter matrix (missing, repeated and
 *   unknown keys; every invalid value), 405 for other methods;
 * - 503 PUBLICATION_DISABLED (before the limiter and the query);
 * - 503 BACKEND_STORAGE_UNAVAILABLE for a tampered digest, a whole-document
 *   digest, a generatedAt that disagrees with released_at, a payload the
 *   contract refuses, and a failed or malformed read;
 * - the public-read limiter called exactly once per request that reaches it,
 *   and its edge-replay outcomes (allowed, limited, unavailable) as 200, 429
 *   and 503 through the real replay bindings and the Worker helper.
 *
 * Each schema applies the promoted primary chain (0001-0079) into a fresh
 * random schema, dropped afterwards. Every payload, digest and identifier is
 * synthetic and content-free (the SPD-G1 fixtures in
 * postgres-test/fixtures/performance-telemetry.mjs).
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<id>/socket PG_TEST_PORT=<port> \
 *   node --test --test-concurrency=1 postgres-test/analytics-v2-community-model-performance-route.spec.mjs
 * Without PG_TEST_SOCKET/PG_TEST_HOST every case skips.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_FIXTURE_MODEL,
  PERFORMANCE_MIGRATION_NAME,
  PERFORMANCE_PUBLICATION_PERIODS,
  PERFORMANCE_PUBLICATION_SPEED_MODES,
  ensurePerformanceFixtureKernel,
  insertPerformancePublicationHead,
  performanceTable,
  syntheticCommunityModelPerformancePayload,
  syntheticPerformancePayloadSha256,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;

const ORIGIN = "http://127.0.0.1:8080";
const PATH = "/api/v1/community/model-performance";
const PUBLIC_CACHE = "public, max-age=300";
const HEADS = "analytics_v2_published_performance";
const NOW = "2026-10-11T03:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const END = "2026-10-10";
/** The Monday that opens the week bin holding END (2026-10-10 is a Saturday). */
const END_WEEK = "2026-10-05";
const SEED = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REQUEST_ID = "0b6f3c2e-8d1a-4f5b-9c7e-2a4d6e8f0a1b";
const SLOTS = PERFORMANCE_PUBLICATION_PERIODS.flatMap((period) =>
  PERFORMANCE_PUBLICATION_SPEED_MODES.map((speedMode) => ({ period, speedMode })));
const slotKey = ({ period, speedMode }) => `${period}:${speedMode}`;
const queryOf = ({ period, speedMode }) => `?period=${period}&speedMode=${speedMode}`;

let vite;
let route;
let contract;
let publication;
let canonical;
let admission;
let replay;
let telemetryContract;
let pool;
const schemas = [];
let emptySchema;
let publishedSchema;
let brokenSchema;
/** The slots the store published with a model (the others carry none). */
const MODEL_SLOTS = new Set(SLOTS.filter((_, index) => index % 2 === 0).map(slotKey));

before(async () => {
  if (PG_SKIP) return;
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    plugins: analyticsV2Config.plugins,
    resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
  });
  route = await vite.ssrLoadModule("/src/analytics-v2/community-model-performance-route.ts");
  contract = await vite.ssrLoadModule("/src/analytics-v2/performance-publication-contract.ts");
  publication = await vite.ssrLoadModule("/src/analytics-v2/store-publication.ts");
  canonical = await vite.ssrLoadModule("/src/canonical-json.ts");
  admission = await vite.ssrLoadModule("/src/admission.ts");
  replay = await vite.ssrLoadModule("/cloud-run/postgres-edge-admission-limiters.mjs");
  telemetryContract = await vite.ssrLoadModule("@app-usagemonitor/telemetry-contract");
  pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 6, connectionTimeoutMillis: 5_000,
    application_name: "analytics-v2-community-model-performance-route-spec", options: "-c search_path=pg_catalog" });
  const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
  emptySchema = await promotedSchema("empty");
  publishedSchema = await promotedSchema("published");
  await publishThroughStore(publishedSchema);
  brokenSchema = await promotedSchema("broken");
});

after(async () => {
  if (pool !== undefined) {
    for (const schema of schemas.reverse()) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Schema and heads
// ---------------------------------------------------------------------------

async function promotedSchema(label) {
  const schema = `p4_${label}_${randomBytes(5).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME, "the promoted chain ends at 0079");
  // The chain seeds publication disabled; the cases read with it enabled.
  await setControls(schema, { publication: true });
  return schema;
}

/** A median-only point (n < 5) on `day`. */
function point(day, estimate) {
  return { day, n: 1, unresolved: 0, p10: null, p25: null,
    median: { estimate, lower: Math.max(0, estimate - 5), upper: estimate + 5 }, p75: null, p90: null };
}

/**
 * A valid candidate payload for one slot as the fold emits it (placeholder
 * revision 1, generatedAt = NOW, window ending on END). `speed` > 0 adds
 * one reviewed model with one speed and one first-token sample.
 */
function payloadFor({ period, speedMode }, speed = 0, overrides = {}) {
  const day = period === "all" ? END_WEEK : END;
  const models = speed > 0 ? [{
    provider: PERFORMANCE_FIXTURE_MODEL.provider,
    modelId: PERFORMANCE_FIXTURE_MODEL.modelId,
    turns: 1, speedTurns: 1, ttftTurns: 1, timedResponses: 1, toolFreeTurns: 0, contributors: 1, devices: 1,
    speed: { unit: "tokens_per_second", points: [point(day, speed)] },
    ttft: { unit: "milliseconds", points: [point(day, 900)] },
  }] : [];
  return syntheticCommunityModelPerformancePayload({
    period, speedMode, end: END, generatedAt: NOW,
    contributors: models.length, devices: models.length, reports: models.length, models, ...overrides,
  });
}

/** All twelve slots through the real store writer, half of them with a model. */
async function publishThroughStore(schema) {
  const kernelId = await ensurePerformanceFixtureKernel(pool, { schema });
  const candidates = await Promise.all(SLOTS.map(async (slot, index) => {
    const payload = telemetryContract.parseCommunityModelPerformance(
      payloadFor(slot, MODEL_SLOTS.has(slotKey(slot)) ? 40 + index : 0));
    return { period: slot.period, speedMode: slot.speedMode, payload,
      payloadSha256: await contract.analyticsV2PerformanceContentSha256(payload) };
  }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const written = await publication.writeAnalyticsV2PublishedPerformance(client, {
      schema: `"${schema}"`, candidates, releasedAt: NOW, seed: SEED, kernelId, manifestVersion: 1,
      runId: randomUUID(),
    });
    await client.query("COMMIT");
    assert.deepEqual(written, { published: SLOTS.map(slotKey), unchanged: [], deferredEmpty: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A head written directly (bypassing the store), with the store's digest rule unless overridden. */
async function insertHead(schema, payload, { releasedAtEpoch = Date.parse(payload.generatedAt), payloadSha256 } = {}) {
  return insertPerformancePublicationHead(pool, {
    schema, payload, releasedAtEpoch,
    payloadSha256: payloadSha256 ?? await contract.analyticsV2PerformanceContentSha256(payload),
  });
}

async function storedPayloadText(schema, { period, speedMode }) {
  const result = await pool.query(`SELECT payload::text AS payload_text FROM ${performanceTable(schema, HEADS)}
    WHERE period = $1 AND speed_mode = $2`, [period, speedMode]);
  assert.equal(result.rows.length, 1);
  return result.rows[0].payload_text;
}

async function setControls(schema, { publication: enabled }) {
  await pool.query(`UPDATE ${performanceTable(schema, "collection_controls")} SET revision = revision + 1,
      control_state = $1, enrollment_enabled = true, upload_registration_enabled = true,
      processing_enabled = true, publication_enabled = $2, reason_code = 'maintenance',
      updated_at = clock_timestamp() WHERE singleton = 1`,
  [enabled ? "operational" : "degraded", enabled]);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** A counting public-read limiter that allows every read. */
function countingLimiter() {
  const limiter = async (request) => {
    assert.ok(request instanceof Request, "the limiter receives the request");
    limiter.calls += 1;
  };
  limiter.calls = 0;
  return limiter;
}

function createRoute(schema, overrides = {}) {
  const limiter = countingLimiter();
  const built = route.createAnalyticsV2CommunityModelPerformanceRoute({
    pool, schema, assertPublicReadAllowed: limiter, ...overrides,
  });
  return { route: built, limiter };
}

async function get(target, query, { method = "GET", context = {} } = {}) {
  const response = await target.handler(new Request(`${ORIGIN}${PATH}${query}`, { method }), context);
  return { response, text: await response.text() };
}

function assertErrorEnvelope({ response, text }, status, code) {
  assert.equal(response.status, status, text);
  assert.match(text, new RegExp(`^\\{"error":\\{"code":"${code}","requestId":"[0-9a-f-]{36}"\\}\\}$`, "u"));
  assert.match(JSON.parse(text).error.requestId, UUID);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function assertPublicPayload({ response, text }) {
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get("cache-control"), PUBLIC_CACHE);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return JSON.parse(text);
}

/**
 * A pool whose sessions record every statement and may answer the heads
 * statement themselves (`heads(sql, values)` returns a result, throws, or
 * returns undefined to pass through).
 */
function recordingPool({ heads } = {}) {
  const statements = [];
  return {
    statements,
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          statements.push({ text: String(text), values });
          if (heads !== undefined && String(text).includes(HEADS)) {
            const answer = await heads(text, values);
            if (answer !== undefined) return answer;
          }
          return client.query(text, values);
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test("route module: a frozen GET module for the new path, refused at construction when misconfigured", {
  skip: PG_SKIP,
}, async () => {
  const { route: built } = createRoute(emptySchema);
  assert.deepEqual(Object.keys(built).sort(), ["handler", "method", "overridesBuiltIn", "pathname"]);
  assert.equal(built.method, "GET");
  assert.equal(built.pathname, PATH);
  assert.equal(route.ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PATH, PATH);
  assert.equal(route.ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PUBLIC_CACHE_CONTROL, PUBLIC_CACHE);
  assert.equal(built.overridesBuiltIn, false, "no built-in serves this path");
  assert.ok(Object.isFrozen(built));
  const refused = (options) => assert.throws(() => route.createAnalyticsV2CommunityModelPerformanceRoute(options),
    /^Error: ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_CONFIGURATION_INVALID$/u);
  const limiter = countingLimiter();
  refused(null);
  refused([]);
  refused({ pool, schema: emptySchema });
  refused({ pool, schema: emptySchema, assertPublicReadAllowed: "allowed" });
  refused({ pool, schema: emptySchema, assertPublicReadAllowed: limiter, clock: () => NOW_MS });
  refused({ pool: {}, schema: emptySchema, assertPublicReadAllowed: limiter });
  refused({ pool, schema: "Bad-Schema", assertPublicReadAllowed: limiter });
  refused({ pool, assertPublicReadAllowed: limiter });
  assert.equal(limiter.calls, 0);
});

test("unpublished: every slot with no head is 404 COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED with no-store, never a 5xx", {
  skip: PG_SKIP,
}, async () => {
  const { route: built, limiter } = createRoute(emptySchema);
  for (const slot of SLOTS) {
    assertErrorEnvelope(await get(built, queryOf(slot)), 404, "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED");
  }
  assert.equal(limiter.calls, SLOTS.length, "the limiter runs exactly once per request");
  // One slot published elsewhere in the table: its siblings are still unpublished.
  const partial = await promotedSchema("partial");
  const head = payloadFor({ period: "7", speedMode: "standard" }, 55);
  await insertHead(partial, head);
  const { route: partialRoute } = createRoute(partial);
  assertPublicPayload(await get(partialRoute, "?period=7&speedMode=standard"));
  assertErrorEnvelope(await get(partialRoute, "?period=7&speedMode=fast"), 404, "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED");
  assertErrorEnvelope(await get(partialRoute, "?period=all&speedMode=standard"), 404,
    "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED");
});

test("verified 200: each store-written slot is served byte for byte, publicly cacheable for 300 s", {
  skip: PG_SKIP,
}, async () => {
  const { route: built, limiter } = createRoute(publishedSchema);
  for (const slot of SLOTS) {
    const served = await get(built, queryOf(slot));
    const body = assertPublicPayload(served);
    const stored = JSON.parse(await storedPayloadText(publishedSchema, slot));
    assert.equal(served.text, canonical.canonicalJson(stored), `${slotKey(slot)}: the stored payload, canonical`);
    assert.deepEqual(telemetryContract.parseCommunityModelPerformance(body), body);
    assert.equal(body.period, slot.period);
    assert.equal(body.speedMode, slot.speedMode);
    // nextPublishedRevision({ head: none, floor: null, seed: SEED }) and the run's release instant.
    assert.equal(body.revision, SEED + 1);
    assert.equal(body.generatedAt, NOW);
    assert.equal(body.end, END);
    assert.equal(body.models.length, MODEL_SLOTS.has(slotKey(slot)) ? 1 : 0,
      "an empty slot is published as a valid empty payload");
  }
  assert.equal(limiter.calls, SLOTS.length);
  // The root request id is carried into error bodies; a malformed one is replaced.
  const carried = await get(built, "?period=7", { context: { requestId: REQUEST_ID } });
  assertErrorEnvelope(carried, 400, "BODY_INVALID");
  assert.equal(JSON.parse(carried.text).error.requestId, REQUEST_ID);
  const replaced = await get(built, "?period=7", { context: { requestId: "not-a-request-id" } });
  assert.notEqual(JSON.parse(replaced.text).error.requestId, "not-a-request-id");
});

test("parameter matrix: exactly one period and one speedMode; anything else is 400 BODY_INVALID", {
  skip: PG_SKIP,
}, async () => {
  const { route: built, limiter } = createRoute(publishedSchema);
  const invalid = [
    "", "?", "?period=7", "?speedMode=fast", "?period=&speedMode=fast", "?period=7&speedMode=",
    "?period=7&period=7&speedMode=fast", "?period=7&speedMode=fast&speedMode=fast",
    "?period=7&speedMode=fast&period=30", "?period=7&speedMode=fast&from=2026-10-01",
    "?period=7&speedMode=fast&period", "?period=7&speedMode=fast&=x", "?Period=7&speedMode=fast",
    "?period=7&speed_mode=fast", "?period=7&speedmode=fast", "?period=7&speedMode=fast&callback=x",
    "?period=0&speedMode=fast", "?period=14&speedMode=fast", "?period=07&speedMode=fast",
    "?period=7.0&speedMode=fast", "?period=ALL&speedMode=fast", "?period=All&speedMode=fast",
    "?period=%207&speedMode=fast", "?period=7%20&speedMode=fast", "?period=-1&speedMode=fast",
    "?period=7&speedMode=Standard", "?period=7&speedMode=FAST", "?period=7&speedMode=priority",
    "?period=7&speedMode=other", "?period=7&speedMode=unknown", "?period=7&speedMode=fast%00",
  ];
  for (const query of invalid) assertErrorEnvelope(await get(built, query), 400, "BODY_INVALID");
  assert.equal(limiter.calls, invalid.length, "the limiter runs before the query is validated, once each");
  // Order of the two keys is free, and percent-encoding is decoded as URLSearchParams does.
  assertPublicPayload(await get(built, "?speedMode=fast&period=7"));
  assertPublicPayload(await get(built, "?period=%37&speedMode=f%61st"));
  // An empty segment names no key (URLSearchParams skips it).
  assertPublicPayload(await get(built, "?period=7&speedMode=fast&"));
});

test("methods: every non-GET is 405 METHOD_NOT_ALLOWED with allow: GET, before the limiter", {
  skip: PG_SKIP,
}, async () => {
  const { route: built, limiter } = createRoute(publishedSchema);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const answered = await get(built, "?period=7&speedMode=fast", { method });
    assert.equal(answered.response.status, 405, method);
    assert.equal(answered.response.headers.get("allow"), "GET");
    assert.equal(answered.response.headers.get("cache-control"), "no-store");
    if (method !== "HEAD") assertErrorEnvelope(answered, 405, "METHOD_NOT_ALLOWED");
  }
  assert.equal(limiter.calls, 0);
});

test("a disabled publication control is 503 PUBLICATION_DISABLED with no-store, before the limiter and the query", {
  skip: PG_SKIP,
}, async () => {
  const { route: built, limiter } = createRoute(publishedSchema);
  await setControls(publishedSchema, { publication: false });
  try {
    assertErrorEnvelope(await get(built, "?period=7&speedMode=fast"), 503, "PUBLICATION_DISABLED");
    assertErrorEnvelope(await get(built, "?period=bad"), 503, "PUBLICATION_DISABLED");
    assert.equal(limiter.calls, 0);
  } finally {
    await setControls(publishedSchema, { publication: true });
  }
  assertPublicPayload(await get(built, "?period=7&speedMode=fast"));
  assert.equal(limiter.calls, 1);
});

test("digest tamper: content changed under the stored digest is 503 BACKEND_STORAGE_UNAVAILABLE", {
  skip: PG_SKIP,
}, async () => {
  const slot = { period: "1", speedMode: "standard" };
  await insertHead(brokenSchema, payloadFor(slot, 61));
  const { route: built, limiter } = createRoute(brokenSchema);
  assertPublicPayload(await get(built, queryOf(slot)));
  // Storage-level tampering: the forward-only trigger refuses an update that
  // keeps the digest, so the spec disables it to simulate corruption.
  const heads = performanceTable(brokenSchema, HEADS);
  const trigger = '"analytics_v2_published_performance_forward_only"';
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${heads} DISABLE TRIGGER ${trigger}`);
    const changed = await client.query(`UPDATE ${heads}
        SET payload = jsonb_set(payload, '{excludedUnknownTurns}', '5'::jsonb)
      WHERE period = $1 AND speed_mode = $2`, [slot.period, slot.speedMode]);
    assert.equal(changed.rowCount, 1);
    await client.query(`ALTER TABLE ${heads} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  assertErrorEnvelope(await get(built, queryOf(slot)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // A digest over the whole document (revision and generatedAt included) is
  // not the store's content digest either.
  const whole = { period: "1", speedMode: "fast" };
  const wholePayload = payloadFor(whole, 62);
  await insertHead(brokenSchema, wholePayload, { payloadSha256: syntheticPerformancePayloadSha256(wholePayload) });
  assertErrorEnvelope(await get(built, queryOf(whole)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // A digest of other content.
  const other = { period: "30", speedMode: "fast" };
  await insertHead(brokenSchema, payloadFor(other, 63),
    { payloadSha256: await contract.analyticsV2PerformanceContentSha256(payloadFor(other, 64)) });
  assertErrorEnvelope(await get(built, queryOf(other)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  assert.equal(limiter.calls, 4);
});

test("stamp and contract refusals: a generatedAt off released_at, or a payload the contract refuses, is 503", {
  skip: PG_SKIP,
}, async () => {
  const { route: built } = createRoute(brokenSchema);
  const stamp = { period: "1", speedMode: "ultrafast" };
  await insertHead(brokenSchema, payloadFor(stamp, 65), { releasedAtEpoch: NOW_MS + 1 });
  assertErrorEnvelope(await get(built, queryOf(stamp)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // Within 0079's CHECKs and with the store's content digest, but outside the
  // closed contract: more contributors than devices.
  const closed = { period: "7", speedMode: "standard" };
  const refused = payloadFor(closed, 66, { contributors: 2, devices: 1, reports: 2 });
  assert.throws(() => telemetryContract.parseCommunityModelPerformance(refused));
  await insertHead(brokenSchema, refused);
  assertErrorEnvelope(await get(built, queryOf(closed)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // Control: a directly inserted head that meets every check is served.
  const valid = { period: "7", speedMode: "fast" };
  await insertHead(brokenSchema, payloadFor(valid, 67));
  assertPublicPayload(await get(built, queryOf(valid)));
});

test("storage: a failed or malformed head read is 503 BACKEND_STORAGE_UNAVAILABLE; the read is one keyed row in one snapshot", {
  skip: PG_SKIP,
}, async () => {
  const recorded = recordingPool();
  const { route: built } = createRoute(publishedSchema, { pool: recorded });
  assertPublicPayload(await get(built, "?period=30&speedMode=ultrafast"));
  const headStatements = recorded.statements.filter(({ text }) => text.includes(HEADS));
  assert.equal(headStatements.length, 1, "one statement reads the head");
  assert.deepEqual(headStatements[0].values, ["30", "ultrafast"]);
  assert.match(headStatements[0].text, /WHERE h\.period = \$1 AND h\.speed_mode = \$2$/u, "by the primary key");
  const index = recorded.statements.indexOf(headStatements[0]);
  const begins = recorded.statements.slice(0, index).filter(({ text }) => text.startsWith("BEGIN"));
  assert.equal(begins.at(-1)?.text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(recorded.statements.slice(index + 1).find(({ text }) => !text.startsWith("SET"))?.text, "COMMIT");
  for (const heads of [
    async () => { throw new Error("synthetic storage failure"); },
    async () => ({ rows: "not rows" }),
    async (text, values) => {
      const real = await pool.query(text, values);
      return { rows: [real.rows[0], real.rows[0]] };
    },
    async () => ({ rows: [{ period: "30", speed_mode: "ultrafast", revision: "5", released_at: NOW,
      payload_text: "{not json", payload_sha256: "a".repeat(64) }] }),
    async () => ({ rows: [{ period: "7", speed_mode: "ultrafast", revision: "5", released_at: NOW,
      payload_text: "{}", payload_sha256: "a".repeat(64) }] }),
  ]) {
    const { route: failing, limiter } = createRoute(publishedSchema, { pool: recordingPool({ heads }) });
    assertErrorEnvelope(await get(failing, "?period=30&speedMode=ultrafast"), 503, "BACKEND_STORAGE_UNAVAILABLE");
    assert.equal(limiter.calls, 1);
  }
  // A control read that fails is the control's own refusal, before the limiter.
  const { route: noControls, limiter } = createRoute(publishedSchema, {
    pool: { async connect() { throw new Error("synthetic connect failure"); } },
  });
  assertErrorEnvelope(await get(noControls, "?period=30&speedMode=ultrafast"), 503, "COLLECTION_CONTROL_UNAVAILABLE");
  assert.equal(limiter.calls, 0);
});

test("limiter replay: the edge outcome is consumed once at the Worker's call point (allowed 200, limited 429, unavailable 503)", {
  skip: PG_SKIP,
}, async () => {
  const limiters = replay.createEdgeAdmissionLimiters();
  const env = { PUBLIC_READ_RATE_LIMIT: limiters.bindings.PUBLIC_READ_RATE_LIMIT,
    IDENTITY_LINK_SECRET: randomBytes(32).toString("hex") };
  let calls = 0;
  const built = route.createAnalyticsV2CommunityModelPerformanceRoute({
    pool, schema: publishedSchema,
    assertPublicReadAllowed: (request) => {
      calls += 1;
      return admission.assertPublicAggregateReadAllowed(env.PUBLIC_READ_RATE_LIMIT, request, env);
    },
  });
  const unpublished = route.createAnalyticsV2CommunityModelPerformanceRoute({
    pool, schema: emptySchema,
    assertPublicReadAllowed: (request) => {
      calls += 1;
      return admission.assertPublicAggregateReadAllowed(env.PUBLIC_READ_RATE_LIMIT, request, env);
    },
  });
  const replayed = (outcome, target = built, query = "?period=1&speedMode=fast") => {
    const before = calls;
    const admissionOutcome = outcome === null ? null : { purpose: "public_aggregate_read", outcome };
    return limiters.run(admissionOutcome, async () => {
      const answered = await get(target, query);
      return { ...answered, calls: calls - before };
    });
  };
  // Allowed: a second binding call in the same run would be refused as a
  // sequence divergence (503), so a 200 also proves a single call.
  const allowed = await replayed("allowed");
  assertPublicPayload(allowed);
  assert.equal(allowed.calls, 1);
  const allowedUnpublished = await replayed("allowed", unpublished);
  assertErrorEnvelope(allowedUnpublished, 404, "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED");
  assert.equal(allowedUnpublished.calls, 1);
  const limited = await replayed("limited");
  assertErrorEnvelope(limited, 429, "ATTEMPT_LIMIT_REACHED");
  assert.equal(limited.response.headers.get("retry-after"), "60");
  assert.equal(limited.calls, 1);
  const unavailable = await replayed("unavailable");
  assertErrorEnvelope(unavailable, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  assert.equal(unavailable.response.headers.get("retry-after"), "60");
  assert.equal(unavailable.calls, 1);
  const missing = await replayed(null);
  assertErrorEnvelope(missing, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  assert.equal(missing.calls, 1);
  // The outcome is consumed before the query is validated, as in the Worker.
  const limitedInvalid = await replayed("limited", built, "?period=bad");
  assertErrorEnvelope(limitedInvalid, 429, "ATTEMPT_LIMIT_REACHED");
  const allowedInvalid = await replayed("allowed", built, "?period=bad");
  assertErrorEnvelope(allowedInvalid, 400, "BODY_INVALID");
  assert.equal(allowedInvalid.calls, 1);
});
