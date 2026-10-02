// L-LOADTEST: the OPS-11 load generator (scripts/gcp-load-test.mjs), proved
// locally against the edge e2e harness's local origin, with PostgreSQL.
//
//   runLoadTest (synthetic accountless devices, the shipped v1.2 client)
//     -> the edge bundle in workerd (Miniflare), EDGE_UPSTREAM_MODE=gcp
//     -> scripts/edge-e2e/google-front-end.mjs (token issuer and Cloud Run IAM)
//     -> cloud-run/dist/server.mjs in fastpath-test mode behind EP-6
//        (EDGE_ORIGIN_MODE=edge-test) on 127.0.0.1
//     -> PostgreSQL 17 (a fresh tibotattle_fastpath_l_loadtest_* schema, dropped after; no deletion
//        ledger: D4, SIMP-4)
//
// Run 1, at a low rate with per-device client addresses and generous edge
// limits, drives enrollment, v1.2 authorization, day manifests, uploads and
// activation, with a local migrate-and-roll drill under load: "migrate"
// appends a synthetic migration-history row, so the running revision's
// storage gate answers 503 BACKEND_STORAGE_UNAVAILABLE (the accepted write
// outage, OD-ROLL); "roll" starts a new revision on a new port, removes the
// row (standing in for a new image whose manifest includes the migration; the
// local revision is the same build), moves the front end to it and drains the
// old one. Run 2 sends a small load from ONE client address through an edge
// with the checked-in staging edge-tier limits and records the refusals by
// code.
//
// The fixture mirrors edge-origin-e2e.spec.mjs's startOrigin and seedSchema.
// Local only: nothing is deployed and nothing reaches Cloudflare or Google;
// every key, token, account, address and row is synthetic and content-free.
//
//   cd apps/worker && node cloud-run/build.mjs
//   PG_TEST_SOCKET=... PG_TEST_PORT=... ~/.nvm/versions/node/v22.16.0/bin/node \
//     --test --test-concurrency=1 postgres-test/gcp-load-test.spec.mjs
// GCP_LOAD_TEST_SPEC_RECEIPTS=<private directory> keeps the two receipts.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { buildEdgeBundle } from "../scripts/edge-e2e/edge-bundle.mjs";
import {
  EDGE_E2E_AUDIENCE,
  EDGE_E2E_INVOKER,
  EDGE_E2E_PUBLIC_ORIGIN,
  EDGE_E2E_UPSTREAM_ORIGIN,
  EDGE_E2E_VERIFIER,
  EDGE_TIER_BINDINGS,
  createAccessFixture,
  createEdgeInstance,
  createFixtureAssets,
  createSparkleFixture,
} from "../scripts/edge-e2e/edge-instances.mjs";
import {
  createGoogleFrontEnd,
  createSyntheticServiceAccountKey,
  loopbackOrigin,
} from "../scripts/edge-e2e/google-front-end.mjs";
import { parseLoadTestArguments, runLoadTest } from "../scripts/gcp-load-test.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SKIP = !PG_TEST_SOCKET;
const RECEIPTS = process.env.GCP_LOAD_TEST_SPEC_RECEIPTS ? resolve(process.env.GCP_LOAD_TEST_SPEC_RECEIPTS) : null;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_SERVER = join(WORKER_ROOT, "cloud-run", "dist", "server.mjs");
const SCHEMA_PREFIX = "tibotattle_fastpath_l_loadtest_";
const SOURCE_ID = "synthetic-l-loadtest-journal";
const NAMESPACE = "synthetic-l-loadtest-namespace";
const KEY_ID = "key:synthetic-l-loadtest";
const HISTORY_TABLE = "_tibotattle_migration_history";
const LONG = 900_000;
const TARGET_HOST = new URL(EDGE_E2E_PUBLIC_ORIGIN).hostname;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN",
  "K_SERVICE", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "PRIMARY_INSTANCE_CONNECTION_NAME",
  "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER",
  "POSTGRES_SOURCE_ID", "POSTGRES_SOURCE_NAMESPACE", "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK", "GCS_BUCKET_NAME", "GCS_QUARANTINE_BUCKET_HISTORY_PROOF",
  "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  "ENVIRONMENT", "ENROLLMENT_MODE", "IDENTITY_LINK_SECRET", "IDENTITY_LINK_SECRET_VERSION",
  "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET", "SIGN_IN_START_MAX_PER_MINUTE",
  "ACCOUNTLESS_ENROLLMENT_MODE", "ACCOUNTLESS_OWNERSHIP_MODE", "SOURCE_CONTENT_DIGEST",
  "ANALYTICS_V2_ENABLED", "ANALYTICS_V2_TEST_NOW_MS",
  "EDGE_ORIGIN_MODE", "EDGE_ORIGIN_AUDIENCE", "EDGE_INVOKER_SERVICE_ACCOUNT",
  "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS",
]);

let vite;
let fixturePromise = null;
const disposers = [];

after(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {});
  await vite?.close();
});

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

function poolOptions(socket, max, applicationName) {
  return {
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: applicationName,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  };
}

async function envelopeKeys() {
  const pair = await webcrypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  return {
    publicText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: KEY_ID }),
    privateText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.privateKey), kid: KEY_ID }),
  };
}

async function withEnvironment(environment, work) {
  const saved = new Map(RUNTIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENVIRONMENT_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** A migrated rehearsal schema with the state E12's seedSchema gives (no deletion ledger: D4, SIMP-4). */
async function seedSchema(base, codec, schema) {
  await applyPostgresMigrations({ role: "primary", schema, pool: base });
  const t = (name) => `"${schema}"."${name}"`;
  const now = new Date().toISOString();
  await base.query(`UPDATE ${t("collection_controls")}
      SET revision=2, control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
          processing_enabled=true, publication_enabled=true, updated_at=$1
    WHERE singleton=1`, [now]);
  await base.query(`INSERT INTO ${t("storage_source_state")} (singleton, source_id, authority_epoch)
    VALUES (1, $1, 0)`, [SOURCE_ID]);
  const namespace = await base.query(`INSERT INTO ${t("typed_telemetry_namespaces")} (original_id)
    VALUES ($1) RETURNING id`, [Buffer.from(codec.encodeTypedTelemetryId(NAMESPACE))]);
  for (const family of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
    await base.query(`INSERT INTO ${t(family)}
        (id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id)
      VALUES (1, $1, $2, 1, 1)`, [NAMESPACE, namespace.rows[0].id]);
  }
  await base.query(`UPDATE ${t("telemetry_transport_formats")} SET lifecycle='accepted'
    WHERE schema_version='telemetry-contribution-v1.1'`);
  await base.query(`UPDATE ${t("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  await base.query(`UPDATE ${t("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  return t;
}

let serverModule = null;

/** One origin revision: cloud-run/dist/server.mjs as E12's startOrigin composes it, behind EP-6. */
async function startOrigin({ socket, schema, keys, rateLimitSecret }) {
  serverModule ??= await import(pathToFileURL(DIST_SERVER).href);
  const port = await freePort();
  const hostOrigin = `http://127.0.0.1:${port}`;
  const bucket = "synthetic-l-loadtest-bucket";
  const pools = [];
  const env = {
    POSTGRES_TEST_HTTP_MODE: "fastpath-test",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOST_ORIGIN: hostOrigin,
    PRIMARY_SCHEMA: schema,
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-l-loadtest-primary",
    POSTGRES_IAM_USER: "synthetic-l-loadtest-runtime@synthetic.iam",
    POSTGRES_SOURCE_ID: SOURCE_ID,
    POSTGRES_SOURCE_NAMESPACE: NAMESPACE,
    POSTGRES_RATE_LIMIT_SECRET: rateLimitSecret,
    ENVELOPE_PUBLIC_JWK: keys.publicText,
    ENVELOPE_PRIVATE_JWK: keys.privateText,
    GCS_BUCKET_NAME: bucket,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({
      bucket, bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
    }),
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ANALYTICS_V2_ENABLED: "1",
    EDGE_ORIGIN_MODE: "edge-test",
    EDGE_ORIGIN_AUDIENCE: EDGE_E2E_AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: EDGE_E2E_INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: EDGE_E2E_VERIFIER,
  };
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  const { runtime, close } = await withEnvironment(env, async () => {
    const created = await serverModule.createRuntime({
      dependencies: {
        ...serverModule.originCompositionDependencies(env),
        createConnector: () => ({ close() {} }),
        async createIamPool(options) {
          const pool = new pg.Pool(poolOptions(socket, options.max ?? 3, `l-loadtest-origin-${options.role}`));
          pool.on("error", () => {});
          pools.push(pool);
          return pool;
        },
        async createGoogleAccessTokenProvider() { return async () => "synthetic-access-token"; },
        createGcsQuarantineObjectStore: () => ({ async put() {}, async delete() {} }),
      },
    });
    return { runtime: created, close: await serverModule.serve(created) };
  });
  assert.equal(runtime.postgresTestHostMode, "fastpath-test");
  return {
    port,
    async close() {
      await close().catch(() => {});
      for (const pool of pools) await pool.end().catch(() => {});
      for (const listener of process.listeners("SIGTERM")) {
        if (!sigterm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
      for (const listener of process.listeners("SIGINT")) {
        if (!sigint.includes(listener)) process.removeListener("SIGINT", listener);
      }
    },
  };
}

async function fixture() {
  fixturePromise ??= (async () => {
    assert.ok(existsSync(DIST_SERVER), "run `node cloud-run/build.mjs` first");
    vite = await createServer({ root: WORKER_ROOT, configFile: false, appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false } });
    const codec = await vite.ssrLoadModule("/src/typed-telemetry-codec.ts");
    const bundle = await buildEdgeBundle({ workerRoot: WORKER_ROOT });
    disposers.push(() => bundle.cleanup());
    const socket = await localSocket();
    const base = new pg.Pool(poolOptions(socket, 4, "l-loadtest-spec"));
    base.on("error", () => {});
    const version = await base.query("SELECT current_setting('server_version_num')::integer AS version, "
      + "inet_server_addr() AS address");
    assert.equal(version.rows[0].address, null, "the local Unix socket only");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "PostgreSQL 17");
    const schema = `${SCHEMA_PREFIX}${randomBytes(4).toString("hex")}`;
    const created = [];
    disposers.push(async () => {
      for (const name of [...created].reverse()) await base.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await base.end();
    });
    for (const name of [schema]) {
      await base.query(`CREATE SCHEMA "${name}"`);
      created.push(name);
    }
    const t = await seedSchema(base, codec, schema);
    const keys = await envelopeKeys();
    const rateLimitSecret = randomBytes(32).toString("hex");
    const originSettings = { socket, schema, keys, rateLimitSecret };
    const state = { origin: await startOrigin(originSettings) };
    disposers.push(() => state.origin.close());
    const invoker = createSyntheticServiceAccountKey(EDGE_E2E_INVOKER);
    const frontEnd = createGoogleFrontEnd({ invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
      upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(state.origin.port) });
    const common = { bundle, access: createAccessFixture(), sparkle: await createSparkleFixture(WORKER_ROOT),
      assets: await createFixtureAssets(WORKER_ROOT) };
    const edgeFor = async (limits) => {
      const edge = await createEdgeInstance({ ...common, mode: "gcp", frontEnd, invokerKeyJson: invoker.keyJson,
        ...(limits === undefined ? {} : { limits }) });
      disposers.push(() => edge.dispose());
      return edge;
    };
    return { base, t, schema, state, frontEnd, originSettings, edgeFor };
  })();
  return fixturePromise;
}

/** The local migrate-and-roll drill (see the header). */
function localDrill(f, { startAfterMs, holdMs }) {
  const history = `"${f.schema}"."${HISTORY_TABLE}"`;
  let row = null;
  return {
    startAfterMs,
    steps: [
      {
        id: "migrate",
        async run() {
          const max = (await f.base.query(`SELECT max(version)::int AS version FROM ${history}`)).rows[0].version;
          row = { version: max + 1, name: `${String(max + 1).padStart(4, "0")}_l_loadtest_drill.sql` };
          await f.base.query(`INSERT INTO ${history} (version, name, checksum_sha256, applied_at)
            VALUES ($1, $2, $3, now())`, [row.version, row.name, "0".repeat(64)]);
          await delay(holdMs);
          return { exitCode: 0 };
        },
      },
      {
        id: "roll",
        async run() {
          const next = await startOrigin(f.originSettings);
          await f.base.query(`DELETE FROM ${history} WHERE version = $1 AND name = $2`, [row.version, row.name]);
          f.frontEnd.setOrigin(loopbackOrigin(next.port));
          const previous = f.state.origin;
          f.state.origin = next;
          await previous.close();
          await delay(1_000);
          return { exitCode: 0 };
        },
      },
    ],
  };
}

async function keepReceipt(name, receipt) {
  if (RECEIPTS === null) return;
  await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
  await writeFile(join(RECEIPTS, `${name}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

/** The receipt holds no device id, secret, bearer, client address, envelope or record. */
function assertContentFree(receipt) {
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, UUID, "no device or event identifier");
  for (const forbidden of ["um_device", "Device ", "Upload ", "203.0.113.", "198.51.100.", "ciphertext", "wrappedKey",
    "publicJwk", "event:v2:", KEY_ID, "synthetic-access-token", "deviceSecretHash"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
}

function count(mix, prefix) {
  return Object.entries(mix ?? {}).filter(([label]) => label.startsWith(prefix))
    .reduce((total, [, value]) => total + value, 0);
}

const SERVER_ERROR = /^5\d\d(?::|$)/u;

/** Every 5xx answer in a status mix, bare ('503') or labelled ('503:CODE'). */
function serverErrors(mix) {
  return Object.entries(mix ?? {}).filter(([label]) => SERVER_ERROR.test(label))
    .reduce((total, [, value]) => total + value, 0);
}

test("run 1: enrollment, v1.2 uploads and activation through the edge, with a migrate-and-roll drill under load", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const edge = await f.edgeFor();
  const options = parseLoadTestArguments([`--target=${EDGE_E2E_PUBLIC_ORIGIN}`, "--execute",
    `--authorize=GCP_LOAD_TEST:${TARGET_HOST}`, "--out=/nonexistent-spec-receipts", "--devices=6", "--rate=60",
    "--duration=60", "--uploads-per-device=6", "--enroll-rate=600", "--pass-budget-ms=40000",
    "--request-timeout-ms=15000"]);
  assert.equal(options.target.class, "other");
  const receipt = await runLoadTest(options, {
    fetchFor: (index) => edge.clientFetch(index < 0 ? "203.0.113.250" : `203.0.113.${10 + index}`),
    clientAddresses: 6,
    drill: localDrill(f, { startAfterMs: 12_000, holdMs: 5_000 }),
  });
  await keepReceipt("run-1-drill", receipt);
  assertContentFree(receipt);

  assert.equal(receipt.schemaVersion, "gcp-load-test-receipt-v1");
  assert.deepEqual(receipt.target, { class: "other", hostname: TARGET_HOST });
  assert.equal(receipt.preflight.health.status, 200);
  assert.equal(receipt.preflight.envelopeKey.status, 200);
  // Every device enrolled through the three public admission routes.
  assert.equal(receipt.enrollment.enrolled, 6);
  assert.deepEqual(receipt.statusMixByPhase.enrollment, { 201: 18 });
  for (const route of ["accountless_enrollment", "accountless_ownership", "accountless_v12_authorization"]) {
    assert.equal(receipt.routes[route].statusMix["201"], 6, route);
  }
  // The v1.2 flow: manifests, uploads and activations, with latency percentiles.
  for (const route of ["v12_capabilities", "v12_predecessor", "v12_day_manifests", "upload_authorization",
    "contribution", "v12_activate"]) {
    assert.ok(receipt.routes[route]?.count > 0, route);
    const latency = receipt.routes[route].latencyMs;
    assert.ok(latency.p50 > 0 && latency.p50 <= latency.p95 && latency.p95 <= latency.p99 && latency.p99 <= latency.max,
      route);
  }
  assert.equal(receipt.load.devices.completed, 6, JSON.stringify(receipt.load.passes));
  assert.equal(receipt.load.accepted, 36);
  assert.ok(receipt.load.perMinute.length === 1 && receipt.load.perMinute[0] === receipt.load.acceptedInWindow);
  // The drill: the storage gate's 503s fall inside the drill window only, and the load resumes after the roll.
  assert.deepEqual(receipt.drill.steps.map((step) => [step.id, step.outcome]), [["migrate", "completed"],
    ["roll", "completed"]]);
  assert.ok(count(receipt.drill.during.statusMix, "503:BACKEND_STORAGE_UNAVAILABLE") > 0,
    JSON.stringify(receipt.drill.during.statusMix));
  assert.equal(serverErrors(receipt.drill.before.statusMix), 0, JSON.stringify(receipt.drill.before.statusMix));
  assert.equal(serverErrors(receipt.drill.after.statusMix), 0, JSON.stringify(receipt.drill.after.statusMix));
  assert.ok(receipt.drill.after.contributionsAccepted > 0, "uploads resumed on the new revision");
  assert.ok(receipt.refusalsByCode.BACKEND_STORAGE_UNAVAILABLE > 0);
  // Every route the load uses is ported: the storage gate is the only 5xx under
  // load. An unported route would show as 503:POSTGRES_TEST_ROUTE_UNSUPPORTED
  // (today's flat body) or 503:POSTGRES_ROUTE_NOT_PORTED, and an unlabelled
  // body as a bare '503'; none may appear.
  assert.deepEqual(Object.keys(receipt.statusMixByPhase.load).filter((label) => SERVER_ERROR.test(label)),
    ["503:BACKEND_STORAGE_UNAVAILABLE"], JSON.stringify(receipt.statusMixByPhase.load));
  assert.deepEqual(receipt.transportFailures, {}, "the roll drained the old revision without dropping a request");
  // Each upload counted as paced reached its upload authorization; no pass
  // failed on a pacer artifact.
  assert.equal(receipt.load.paced, receipt.routes.upload_authorization.count);
  assert.equal(receipt.load.discardedAtPassEnd, 0);
  assert.equal(receipt.load.passes.byFailureCode.index_unavailable, undefined, JSON.stringify(receipt.load.passes));

  // PostgreSQL agrees with the receipt: one stored chunk per accepted upload,
  // one activated domain per completed device, nothing else in the schema.
  const stored = (await f.base.query(`SELECT
      (SELECT count(*)::int FROM ${f.t("telemetry_v12_chunks")}) AS chunks,
      (SELECT count(DISTINCT participant_id)::int FROM ${f.t("telemetry_v12_chunks")}) AS participants,
      (SELECT count(*)::int FROM ${f.t("telemetry_v12_domain_heads")}) AS heads`)).rows[0];
  assert.deepEqual(stored, { chunks: receipt.load.accepted, participants: 6, heads: receipt.load.devices.completed });
});

test("run 2: one client address through the checked-in staging edge-tier limits is refused by code", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const config = parseJsonc(await readFile(join(WORKER_ROOT, "wrangler.jsonc"), "utf8"));
  const staging = Object.fromEntries(config.env.staging.ratelimits.map((entry) => [entry.name, entry.simple.limit]));
  for (const name of EDGE_TIER_BINDINGS) assert.ok(Number.isSafeInteger(staging[name]), name);
  const edge = await f.edgeFor(staging);
  // Miniflare's limiter counts in fixed wall-clock minutes; start early in one
  // so this short run (a few seconds) is counted in a single window.
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 30_000) await delay(60_000 - intoMinute + 500);
  const options = parseLoadTestArguments([`--target=${EDGE_E2E_PUBLIC_ORIGIN}`, "--execute",
    `--authorize=GCP_LOAD_TEST:${TARGET_HOST}`, "--out=/nonexistent-spec-receipts", "--devices=3", "--rate=60",
    "--duration=20", "--uploads-per-device=3", "--enroll-rate=600", "--enroll-timeout=10",
    "--pass-budget-ms=15000", "--request-timeout-ms=10000"]);
  const receipt = await runLoadTest(options, { fetchFor: () => edge.clientFetch("198.51.100.20"), clientAddresses: 1 });
  await keepReceipt("run-2-staging-edge-limits", receipt);
  assertContentFree(receipt);
  // CLIENT_ATTEMPT_RATE_LIMIT (5 a minute per client address and purpose):
  // six accountless_ownership requests for three devices, so one device is
  // refused and cannot enroll inside the enrollment window.
  assert.equal(receipt.enrollment.enrolled, 2);
  assert.equal(Object.values(receipt.enrollment.failedByCode).reduce((total, value) => total + value, 0), 1);
  assert.match(Object.keys(receipt.enrollment.failedByCode)[0], /^accountless-(?:ownership|v12-authorization):429$/u);
  assert.ok(count(receipt.statusMixByPhase.enrollment, "429:ATTEMPT_LIMIT_REACHED") >= 1);
  // Two devices' passes need more than five device_sync requests from one address.
  assert.ok(count(receipt.statusMixByPhase.load, "429:ATTEMPT_LIMIT_REACHED") >= 1,
    JSON.stringify(receipt.statusMixByPhase.load));
  assert.ok(receipt.refusalsByCode.ATTEMPT_LIMIT_REACHED >= 2);
  assert.equal(receipt.refusalsByCode.HTTP_503, undefined, "the preflight's not-ready answer is not a refusal");
  assert.equal(serverErrors(receipt.statusMixByPhase.load), 0, JSON.stringify(receipt.statusMixByPhase.load));
  assert.equal(receipt.load.passes.byFailureCode.index_unavailable, undefined, JSON.stringify(receipt.load.passes));
  assert.equal(receipt.load.targetMet, false);
});
