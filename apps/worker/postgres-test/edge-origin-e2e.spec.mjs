// E12: the thin edge end to end, locally.
//
//   client (dispatchFetch, synthetic CF-Connecting-IP)
//     -> the edge bundle in workerd (Miniflare), EDGE_UPSTREAM_MODE=gcp
//     -> its only network, scripts/edge-e2e/google-front-end.mjs: the token
//        issuer for the edge-minted ID token and the Cloud Run IAM front-end
//        emulator
//     -> the fastpath-test origin from cloud-run/dist/server.mjs behind the
//        EP-6 boundary (EDGE_ORIGIN_MODE=edge-test) on 127.0.0.1
//     -> PostgreSQL 17 (a fresh rehearsal-prefixed schema pair, dropped after)
//
// The unchanged Worker is the reference: the same bundle in worker mode
// (index.ts's default export, as E5's worker mode runs it) with full D1, R2,
// Durable Object and rate-limit storage. Requests that the Worker comparator
// covers are sent pairwise, edge first, with the same CF-Connecting-IP.
//
// Stages (design/edge-fastpath/E12.json): S0 modes, S1 edge-local classes,
// S2 the admin host, S3 forwarded rows and the route sweep, S4 admission under
// the checked-in production limits, S5 shipped-client flows, S6 upstream
// failures, S7 privacy on every exchange, S8 the Sparkle guard, S9 the golden
// community/daily read and the live check's write tier on the golden-seeded
// schema (EDGE_E2E_GOLDEN), S10 detector controls. The canonical Q-1 root needs
// an explicit versioned mode: current-worker-d1 keeps the existing strict v2
// gate, while current-worker-d1-d7 runs the current-source two-case v3 gate.
// Neither current mode is inferred from the golden path. Historical goldens
// retain their historical oracle and per-date qualification (OD-12).
//
// Local only: nothing is deployed, nothing reaches Cloudflare or Google, and
// every key, token, account, address and row is synthetic and content-free.
// Run it serially under the image runtime (Node 22). The fast-path test-deploy
// script this spec imports reaches src/edge-origin-contract.ts through the
// rollout tooling, so a Node 22 before 22.18 needs --experimental-strip-types
// (the origin itself still loads from the bundled cloud-run/dist):
//
//   cd apps/worker && node cloud-run/build.mjs
//   PG_TEST_SOCKET=... PG_TEST_PORT=... ~/.nvm/versions/node/v22.16.0/bin/node \
//     --experimental-strip-types --test --test-concurrency=1 postgres-test/edge-origin-e2e.spec.mjs

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV11Json,
  canonicalTelemetryV12Json,
  telemetryV11DayManifestDigestInput,
  telemetryV11RequiredConsent,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import {
  compareAnalyticsV2CurrentContract,
  compareAnalyticsV2Parity,
  perDateExpectationFor,
  withheldModelDatesOf,
} from "../scripts/analytics-v2-parity-compare.mjs";
import { compareCurrentQ1D7CaseDTOs, compareCurrentQ1D7Contract } from "../scripts/analytics-v2-current-d7-compare.mjs";
import { assessCurrentQ1D7Qualification, currentQ1D7JsonSha256, currentQ1D7PublicDays,
  CURRENT_Q1_D7_BOUNDS,
  validateCurrentQ1D7Binding, validateCurrentQ1D7CaseReference, validateCurrentQ1D7InputBinding,
  validateCurrentQ1D7PerDateExpectation, validateCurrentQ1D7PgCaseInput,
  validateCurrentQ1D7ProducerAcceptance, validateCurrentQ1D7StrictExportProof } from "./fixtures/current-q1-d7-contract.mjs";
import { assertS9ChildCompleted, captureS9ChildCompletion, observeS9ChildProgress, ownedKeptRehearsalSchemas, readS9ChildReport, s9ControllerGoldenArguments, withS9OwnedSchemaCleanup, validateS9ProgressJournal, S9_DIAGNOSTIC_BYTES, S9_REHEARSAL_DEADLINE_MS }
  from "../scripts/s9-rehearsal-diagnostics.mjs";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  assertCurrentImageRuntime,
  verifyCurrentImageRuntimePath,
} from "../scripts/gcp-fastpath-rehearsal.mjs";
import {
  assertCurrentQ1TrustedRuntime,
  assessCurrentQ1ReferenceCompleteness,
  validateCurrentQ1ReferenceBinding,
} from "./fixtures/current-q1-d1-reference.mjs";
import { buildEdgeBundle, readCompatibility } from "../scripts/edge-e2e/edge-bundle.mjs";
import {
  EDGE_E2E_ADMIN_ORIGIN,
  EDGE_E2E_AUDIENCE,
  EDGE_E2E_COMPATIBILITY,
  EDGE_E2E_INVOKER,
  EDGE_E2E_PUBLIC_ORIGIN,
  EDGE_E2E_SOURCE_COMMIT,
  EDGE_E2E_STRANGER,
  EDGE_E2E_UPSTREAM_ORIGIN,
  EDGE_E2E_VERIFIER,
  EDGE_E2E_WWW_ORIGIN,
  createAccessFixture,
  createEdgeInstance,
  createFixtureAssets,
  createReferenceInstance,
  createSparkleFixture,
  readCheckedInProductionLimits,
  readSanitizedProductionVars,
} from "../scripts/edge-e2e/edge-instances.mjs";
import {
  SIGNATURE_REMOVED,
  createGoogleFrontEnd,
  createSyntheticServiceAccountKey,
  loopbackOrigin,
} from "../scripts/edge-e2e/google-front-end.mjs";
import {
  MATRIX_VALUES,
  PUBLICATION_DISABLED_ROW,
  SAME_ORIGIN,
  UNKNOWN_DEVICE_BEARER,
  UNKNOWN_UPLOAD_BEARER,
  adminRows,
  admissionRows,
  definiteSweepAnswers,
  forwardedRows,
  localRows,
  sweepRows,
} from "../scripts/edge-e2e/request-matrix.mjs";
import { runTelemetryV11Sync } from "../test/helpers/contribution-v11-runner.js";
import { runTelemetryV12Sync } from "../test/helpers/contribution-v12-runner.js";
import {
  createTelemetryV11Envelope,
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  outcomeOrdinal,
  reasoningEffortOrdinal,
  runIncrementalContributionSyncOnce,
  syncPreparedContributionEntryOnce,
} from "../test/helpers/contribution-shipped-client.js";
import { createTelemetryV12Envelope } from "../../../src/platform/telemetry-v12-envelope.js";
import { liveWriteRows } from "../scripts/edge-live-check.mjs";
import { RETIRED_DEFINITE_PREAMBLE_STEPS } from "../cloud-run/postgres-production-registry.mjs";
import { goldenSourceIdentity } from "../scripts/gcp-fastpath-seed.mjs";
import { edgeTestProductionEnv, originSourceEnv } from "../scripts/gcp-fastpath-test-deploy.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SKIP = !PG_TEST_SOCKET;
const GOLDEN = process.env.EDGE_E2E_GOLDEN ? resolve(process.env.EDGE_E2E_GOLDEN) : null;
const EDGE_TREE = process.env.EDGE_E2E_EDGE_TREE ? resolve(process.env.EDGE_E2E_EDGE_TREE) : null;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Whether the edge tree's index.ts re-exports isPostgresWorkerRequestPathSupported. */
async function edgeIndexExportsPostgresPath() {
  const index = await readFile(join(EDGE_TREE ?? WORKER_ROOT, "src", "index.ts"), "utf8");
  return /^export \{ isPostgresWorkerRequestPathSupported \} from "\.\/backend-composition";$/mu.test(index);
}
const DIST_SERVER = join(WORKER_ROOT, "cloud-run", "dist", "server.mjs");
const SOURCE_ID = "synthetic-edge-e2e-journal";
const NAMESPACE = "synthetic-edge-e2e-namespace";
const KEY_ID = "key:synthetic-edge-e2e";
const DAY_MS = 86_400_000;
const LONG = 1_800_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Laboratory origin the shipped accountless client is configured with (see accountlessClientFetch). */
const LABORATORY_ORIGIN = "http://127.0.0.1:49111";
const RATE_LIMIT_PURPOSES = Object.freeze([
  "enrollment", "sign_in_start", "recovery", "device_disconnect", "device_credential_renew", "device_sync",
  "accountless_ownership", "accountless_renewal", "public_aggregate_read", "upload_authorization", "upload_ingress",
]);
/**
 * Headers a forwarded request may carry besides the contract's: Host, the
 * platform's CF-Worker zone header (Cloudflare adds it to every Worker
 * subrequest; its value is the zone, never client data), and the
 * cache-control/pragma pair workerd renders for the edge's cache: 'no-store'.
 * Miniflare's own mf-* transport headers never leave the harness.
 *
 * Claim boundary: this is what the edge's code and workerd send. Miniflare
 * does not add the headers Cloudflare's network adds to a production
 * subrequest; Cloudflare documents that a subrequest for a non-Cloudflare host
 * carries the client address in CF-Connecting-IP, which no Worker can change.
 * S7 cannot observe that. The owner-run probe in scripts/edge-ip-probe does
 * (decision record, section 5, OD-E6).
 */
const PLATFORM_REQUEST_HEADERS = Object.freeze({
  "cf-worker": /^[a-z0-9.-]+$/u,
  "cache-control": /^no-cache$/u,
  pragma: /^no-cache$/u,
});
/** Response headers that are transport framing, not content, on either hop. */
const TRANSPORT_RESPONSE_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "date"]);

// ---------------------------------------------------------------------------
// Fixture

let vite;
let fixturePromise = null;
const disposers = [];
const ipState = { next: 1 };

after(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {});
  await vite?.close();
});

/** A fresh client address per row: 203.0.113.0/24, then 2001:db8::/32. */
function nextIp() {
  const index = ipState.next;
  ipState.next += 1;
  if (index < 255) return `203.0.113.${index}`;
  return `2001:db8::${index.toString(16)}`;
}

async function loadModules() {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  const [registry, policy, contract, composition, session, codec, constants, subrequest, readiness, ingressBudget] =
    await Promise.all([
      load("/src/route-registry.ts"),
      load("/src/edge-admission-policy.ts"),
      load("/src/edge-origin-contract.ts"),
      load("/src/backend-composition.ts"),
      load("/src/session.ts"),
      load("/src/typed-telemetry-codec.ts"),
      load("/src/constants.ts"),
      load("/src/edge-google-subrequest.ts"),
      load("/src/postgres-readiness-contract.ts"),
      load("/src/postgres-ingress-budget.ts"),
    ]);
  return { registry, policy, contract, composition, session, codec, constants, subrequest, readiness, ingressBudget };
}

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

/**
 * The upload-ingress budget the origin takes its shared lease from (D-CRB:
 * the contributions preamble now leases as the Worker does), set to the
 * checked-in env.production values the reference Worker's Durable Object
 * runs, so both refuse at the same budget.
 */
const ORIGIN_INGRESS_VAR_NAMES = Object.freeze([
  "UPLOAD_INGRESS_MAX_CONCURRENT", "UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE", "UPLOAD_INGRESS_BURST",
  "UPLOAD_INGRESS_LEASE_SECONDS", "UPLOAD_INGRESS_BODY_TOTAL_SECONDS", "UPLOAD_INGRESS_BODY_IDLE_SECONDS",
]);

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
  "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS", ...ORIGIN_INGRESS_VAR_NAMES,
]);

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

/** A migrated rehearsal schema with the state the intake specs seed (no deletion ledger: D4, SIMP-4). */
async function seedSchema(base, m, schema) {
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
    VALUES ($1) RETURNING id`, [Buffer.from(m.codec.encodeTypedTelemetryId(NAMESPACE))]);
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

/**
 * cloud-run/dist/server.mjs composed and served as the rehearsal's startOrigin does, behind EP-6.
 * `settings` replaces env values (S9: what the deploy gives an origin over a seeded schema).
 */
async function startOrigin({ socket, schema, keys, nowMs = null, objects, settings = {} }) {
  serverModule ??= await import(pathToFileURL(DIST_SERVER).href);
  const productionVars = await readSanitizedProductionVars(WORKER_ROOT);
  const port = await freePort();
  const hostOrigin = `http://127.0.0.1:${port}`;
  const bucket = "synthetic-edge-e2e-bucket";
  const pools = [];
  const env = {
    POSTGRES_TEST_HTTP_MODE: "fastpath-test",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOST_ORIGIN: hostOrigin,
    PRIMARY_SCHEMA: schema,
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-edge-e2e-primary",
    POSTGRES_IAM_USER: "synthetic-edge-e2e-runtime@synthetic.iam",
    POSTGRES_SOURCE_ID: SOURCE_ID,
    POSTGRES_SOURCE_NAMESPACE: NAMESPACE,
    POSTGRES_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
    ENVELOPE_PUBLIC_JWK: keys.publicText,
    ENVELOPE_PRIVATE_JWK: keys.privateText,
    GCS_BUCKET_NAME: bucket,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({
      bucket, bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
    }),
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ANALYTICS_V2_ENABLED: "1",
    ...(nowMs === null ? {} : { ANALYTICS_V2_TEST_NOW_MS: String(nowMs) }),
    EDGE_ORIGIN_MODE: "edge-test",
    EDGE_ORIGIN_AUDIENCE: EDGE_E2E_AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: EDGE_E2E_INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: EDGE_E2E_VERIFIER,
    ...Object.fromEntries(ORIGIN_INGRESS_VAR_NAMES.map((name) => [name, productionVars[name]])),
    ...settings,
  };
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  const { runtime, close } = await withEnvironment(env, async () => {
    const runtime = await serverModule.createRuntime({
      dependencies: {
        ...serverModule.originCompositionDependencies(env),
        createConnector: () => ({ close() {} }),
        async createIamPool(options) {
          const pool = new pg.Pool(poolOptions(socket, options.max ?? 3, `edge-e2e-origin-${options.role}`));
          pool.on("error", () => {});
          pools.push(pool);
          return pool;
        },
        async createGoogleAccessTokenProvider() { return async () => "synthetic-access-token"; },
        createGcsQuarantineObjectStore: () => ({
          // RD-3's probe reads one key, which no upload ever writes.
          async head(key) { return objects.has(key) ? { key } : null; },
          async put(key, value) { objects.set(key, typeof value === "string" ? value : Buffer.from(value).toString()); },
          async delete(key) { objects.delete(key); },
        }),
      },
    });
    return { runtime, close: await serverModule.serve(runtime) };
  });
  assert.equal(runtime.postgresTestHostMode, "fastpath-test");
  assert.equal(runtime.edgeTestOrigin.listen.hostOrigin, hostOrigin);
  return {
    port,
    hostOrigin,
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
    const m = await loadModules();
    // With EDGE_E2E_EDGE_TREE, the checked-in settings and main are the edge
    // tree's: S0 compares worker mode with that line's own main.
    const compatibility = await readCompatibility(EDGE_TREE ?? WORKER_ROOT);
    const bundle = await buildEdgeBundle({ workerRoot: WORKER_ROOT, edgeTree: EDGE_TREE });
    disposers.push(() => bundle.cleanup());
    const socket = await localSocket();
    const base = new pg.Pool(poolOptions(socket, 4, "edge-e2e-spec"));
    base.on("error", () => {});
    const version = await base.query("SELECT current_setting('server_version_num')::integer AS version, "
      + "inet_server_addr() AS address");
    assert.equal(version.rows[0].address, null, "the local Unix socket only");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "PostgreSQL 17");
    const schema = `tibotattle_fastpath_edge_e2e_${randomBytes(4).toString("hex")}`;
    const created = [];
    disposers.push(async () => {
      for (const name of [...created].reverse()) await base.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await base.end();
    });
    for (const name of [schema]) {
      await base.query(`CREATE SCHEMA "${name}"`);
      created.push(name);
    }
    const t = await seedSchema(base, m, schema);
    const keys = await envelopeKeys();
    const objects = new Map();
    const origin = await startOrigin({ socket, schema, keys, objects });
    disposers.push(() => origin.close());
    const invoker = createSyntheticServiceAccountKey(EDGE_E2E_INVOKER);
    const frontEnd = createGoogleFrontEnd({
      invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
      upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(origin.port),
    });
    const access = createAccessFixture();
    const sparkle = await createSparkleFixture(WORKER_ROOT);
    const assets = await createFixtureAssets(WORKER_ROOT);
    const clientKeySecret = randomBytes(32).toString("hex");
    const common = { bundle, access, sparkle, assets };
    const edge = await createEdgeInstance({ ...common, mode: "gcp", frontEnd, invokerKeyJson: invoker.keyJson,
      clientKeySecret });
    disposers.push(() => edge.dispose());
    const reference = await createReferenceInstance({ ...common, envelope: keys });
    disposers.push(() => reference.dispose());
    return {
      m, compatibility, bundle, socket, base, schema, created, t, keys, objects, origin, invoker,
      frontEnd, access, sparkle, assets, clientKeySecret, edge, reference, common,
      allExchanges: [],
      rows: [],
      transportRetries: [],
    };
  })();
  return fixturePromise;
}

// ---------------------------------------------------------------------------
// Requests

const HOST_ORIGINS = Object.freeze({ apex: EDGE_E2E_PUBLIC_ORIGIN, admin: EDGE_E2E_ADMIN_ORIGIN, www: EDGE_E2E_WWW_ORIGIN });

function unknownDeviceBearer() {
  return `Device um_device_${randomUUID()}.${randomBytes(32).toString("base64url")}`;
}

function unknownUploadBearer() {
  return `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`;
}

/** The concrete request for a matrix row. */
function materialize(row, f) {
  const headers = {};
  for (const [name, value] of Object.entries(row.headers ?? {})) {
    if (value === UNKNOWN_DEVICE_BEARER) headers[name] = unknownDeviceBearer();
    else if (value === UNKNOWN_UPLOAD_BEARER) headers[name] = unknownUploadBearer();
    else if (value === SAME_ORIGIN) headers[name] = HOST_ORIGINS[row.host];
    else headers[name] = value;
  }
  if (row.accessToken !== undefined && row.accessToken !== null) {
    const token = row.accessToken === "malformed" ? "not.a-valid.access-token" : f.access[row.accessToken]();
    if (row.accessCarrier === "cookie") {
      headers.cookie = headers.cookie === undefined ? `CF_Authorization=${token}` : `${headers.cookie}; CF_Authorization=${token}`;
    } else {
      headers["cf-access-jwt-assertion"] = token;
    }
  }
  const body = row.bodyBytes === undefined ? row.body : "x".repeat(row.bodyBytes);
  return {
    url: `${HOST_ORIGINS[row.host]}${row.path}`,
    options: { method: row.method, headers, body, chunked: row.chunked === true },
  };
}

/** The production handler's closed unported code (CR-6, D-CRB). */
const UNPORTED_CODE = "POSTGRES_ROUTE_NOT_PORTED";

/**
 * The origin's closed unported answer through the edge: 503 with exactly the
 * Worker envelope keys and POSTGRES_ROUTE_NOT_PORTED, no-store, and no
 * retry-after (OD-CR-6 (iv)). The body carries a request id, so fields are
 * compared, never bytes.
 */
function assertUnported(answer, label) {
  assert.equal(answer.status, 503, `${label}: ${answer.text}`);
  assert.deepEqual(errorEnvelope(answer), { keys: ["error"], errorKeys: ["code", "requestId"], code: UNPORTED_CODE },
    label);
  assert.equal(answer.header("retry-after"), null, `${label}: no retry-after`);
  assert.equal(answer.header("cache-control"), "no-store", label);
}

/**
 * A retired-definite route's answer through the edge (round 12; round 19
 * runs production's earlier answers first): the expected step's status and
 * code in the Worker envelope, no-store, and no retry-after, never the
 * unported 503.
 */
function assertDefinite(answer, expect, label) {
  assert.equal(answer.status, expect.status, `${label}: ${answer.text}`);
  assert.deepEqual(errorEnvelope(answer), { keys: ["error"], errorKeys: ["code", "requestId"], code: expect.code },
    label);
  assert.equal(answer.header("retry-after"), null, `${label}: no retry-after`);
  assert.equal(answer.header("cache-control"), "no-store", label);
}

function errorEnvelope(answer) {
  const value = answer.json();
  if (value === null || typeof value !== "object" || value.error === null || typeof value.error !== "object") {
    return null;
  }
  return { keys: Object.keys(value).sort(), errorKeys: Object.keys(value.error).sort(), code: value.error.code };
}

/** The Worker comparator: the fields E12 names, and the bytes when the row asks. */
function workerMismatches(edgeAnswer, referenceAnswer, { bodyEqual = false } = {}) {
  const fields = (answer) => ({
    status: answer.status,
    allow: answer.header("allow"),
    location: answer.header("location"),
    cacheControl: answer.header("cache-control"),
    contentType: answer.header("content-type"),
    retryAfter: answer.header("retry-after"),
    setCookies: answer.headers.filter(([name]) => name === "set-cookie").length,
    envelope: errorEnvelope(answer),
  });
  const mismatches = [];
  const edgeFields = fields(edgeAnswer);
  const referenceFields = fields(referenceAnswer);
  for (const key of Object.keys(edgeFields)) {
    if (JSON.stringify(edgeFields[key]) !== JSON.stringify(referenceFields[key])) {
      mismatches.push(`${key}: edge ${JSON.stringify(edgeFields[key])} worker ${JSON.stringify(referenceFields[key])}`);
    }
  }
  if (bodyEqual && !edgeAnswer.body.equals(referenceAnswer.body)) mismatches.push("body bytes differ");
  return mismatches;
}

/** The admission verdict only: status, retry-after and the error envelope. */
function verdictMismatches(edgeAnswer, referenceAnswer) {
  return workerMismatches(edgeAnswer, referenceAnswer).filter((mismatch) =>
    /^(?:status|retryAfter|envelope):/u.test(mismatch));
}

function comparableHeaders(pairs, { dropContract }) {
  const dropped = new Set(dropContract);
  return pairs
    .filter(([name]) => !TRANSPORT_RESPONSE_HEADERS.has(name) && !dropped.has(name)
      && !name.startsWith("mf-"))
    .map(([name, value]) => `${name}: ${value}`)
    .sort();
}

/** The transparency comparator for one forwarded exchange and the client's answer. */
function transparencyMismatches(f, answer, exchange) {
  const mismatches = [];
  if (exchange.originStatus === undefined) return [`no origin answer (${exchange.outcome})`];
  if (answer.status !== exchange.originStatus) mismatches.push(`status ${answer.status} != origin ${exchange.originStatus}`);
  if (!answer.body.equals(exchange.originBody ?? Buffer.alloc(0))) mismatches.push("body bytes differ from the origin's");
  const contractDropped = f.m.contract.DROPPED_RESPONSE_HEADERS;
  const fromOrigin = comparableHeaders(exchange.originHeaders, { dropContract: contractDropped });
  const atClient = comparableHeaders(answer.headers, { dropContract: [] });
  if (JSON.stringify(fromOrigin) !== JSON.stringify(atClient)) {
    mismatches.push(`headers differ: origin ${JSON.stringify(fromOrigin)} client ${JSON.stringify(atClient)}`);
  }
  // transfer-encoding, connection and keep-alive at the client are the client
  // hop's own framing (workerd and Miniflare frame the response themselves);
  // every other dropped name must be gone.
  for (const name of contractDropped) {
    if (!TRANSPORT_RESPONSE_HEADERS.has(name) && answer.header(name) !== null) {
      mismatches.push(`dropped header ${name} reached the client`);
    }
  }
  return mismatches;
}

function rateLimitKeys(secret, ip) {
  const keys = [];
  for (const purpose of RATE_LIMIT_PURPOSES) {
    const material = `app-usagemonitor/rate-limit/v1\0${purpose}\0${ip.toLowerCase()}`;
    keys.push(createHmac("sha256", secret).update(material).digest("hex"));
    keys.push(createHash("sha256").update(material).digest("hex"));
  }
  return keys;
}

/** S7: the privacy assertions on one forwarded exchange. */
function privacyViolations(f, exchange, { ip, hostKind = null }) {
  const violations = [];
  const contract = f.m.contract;
  const allowed = new Set([
    ...contract.FORWARDED_REQUEST_HEADERS,
    ...contract.EDGE_CONTRACT_REQUEST_HEADERS,
    contract.EDGE_HEADERS.invokerToken,
    f.m.subrequest.EDGE_SUBREQUEST_REAL_IP_HEADER,
    "host",
    "transfer-encoding",
  ]);
  const kind = exchange.requestHeaders.find(([name]) => name === contract.EDGE_HEADERS.host)?.[1] ?? null;
  if (hostKind !== null && kind !== hostKind) violations.push(`host kind ${kind} != ${hostKind}`);
  if (kind === "admin") allowed.add("cf-access-jwt-assertion");
  const secrets = ip === null ? [] : [ip.toLowerCase(), ...rateLimitKeys(f.clientKeySecret, ip)];
  for (const [name, value] of exchange.requestHeaders) {
    if (name.startsWith("mf-")) continue;
    const platform = PLATFORM_REQUEST_HEADERS[name];
    if (!allowed.has(name)) {
      if (platform === undefined) violations.push(`header ${name} forwarded`);
      else if (!platform.test(value)) violations.push(`platform header ${name} carries a client value`);
    }
    if (/^(?:x-forwarded-|forwarded$|true-client-ip$|user-agent$)/u.test(name)) {
      violations.push(`forbidden header ${name}`);
    }
    // The edge sets x-real-ip, and only to the constant placeholder (the one
    // address header a Worker can set on a subrequest; Cloudflare fills it
    // with the client address otherwise).
    if (name === f.m.subrequest.EDGE_SUBREQUEST_REAL_IP_HEADER && value !== f.m.subrequest.EDGE_SUBREQUEST_REAL_IP) {
      violations.push(`x-real-ip is not the placeholder`);
    }
    if (name.startsWith("cf-") && name !== "cf-worker" && !(name === "cf-access-jwt-assertion" && kind === "admin")) {
      violations.push(`cf header ${name}`);
    }
    for (const secret of secrets) {
      if (value.toLowerCase().includes(secret)) violations.push(`header ${name} carries the client address or its key`);
    }
  }
  for (const secret of secrets) {
    if (exchange.url.toLowerCase().includes(secret)) violations.push("URL carries the client address or its key");
  }
  const realIps = exchange.requestHeaders.filter(([name]) => name === f.m.subrequest.EDGE_SUBREQUEST_REAL_IP_HEADER);
  if (realIps.length !== 1) violations.push(`x-real-ip sent ${realIps.length} times`);
  const requestId = exchange.requestHeaders.find(([name]) => name === contract.EDGE_HEADERS.requestId)?.[1];
  if (!UUID_V4.test(requestId ?? "")) violations.push("request id is not a UUID v4");
  const path = exchange.url.split("?")[0];
  const route = f.m.registry.matchWorkerRoute(path);
  const policy = route.kind === "exact" ? f.m.policy.edgeAdmissionPolicyFor(route.id) : null;
  const admission = exchange.requestHeaders.find(([name]) => name === contract.EDGE_HEADERS.admission)?.[1] ?? null;
  if (policy === null && admission !== null) violations.push(`admission header on ${route.id}`);
  if (policy !== null && (admission === null || contract.decodeEdgeAdmission(admission)?.purpose !== policy.purpose)) {
    violations.push(`admission header ${admission} on ${route.id}`);
  }
  if (path === contract.GOOGLE_CALLBACK_PATH && exchange.url.includes("?")) violations.push("callback query on the URL");
  const token = exchange.requestHeaders.find(([name]) => name === contract.EDGE_HEADERS.invokerToken)?.[1] ?? "";
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) violations.push("no edge ID token");
  const delivered = exchange.forwardedHeaders?.["x-serverless-authorization"] ?? "";
  if (exchange.forwardedHeaders !== undefined && !delivered.endsWith(`.${SIGNATURE_REMOVED}`)) {
    violations.push("front end did not strip the token signature");
  }
  return violations;
}

/**
 * One row against the edge (and the reference, pairwise, when the Worker
 * comparator applies). Records the exchanges, asserts the row's comparators
 * and S7, and returns the answers.
 */
/**
 * A multi-MiB body that the server refuses before reading it is answered
 * early, and workerd then closes the local client connection while
 * Miniflare's client (undici) may still be sending; undici can report that as
 * a "terminated" fetch instead of the answer. That race is in the local
 * client transport, for the Worker and the edge alike, so such a row is sent
 * again (at most twice) and the retry is recorded in the report.
 */
async function sendRow(f, instance, url, options, row, beforeAttempt = () => {}) {
  for (let attempt = 0; ; attempt += 1) {
    beforeAttempt();
    try {
      return await instance.fetch(url, options);
    } catch (error) {
      const largeBody = (row.bodyBytes ?? 0) >= 1024 * 1024;
      if (!largeBody || attempt >= 2 || !(error instanceof TypeError)) throw error;
      f.transportRetries.push({ row: row.id, attempt: attempt + 1, message: String(error.message).slice(0, 40) });
    }
  }
}

async function runRow(f, row, { edge = f.edge, reference = f.reference, ip = nextIp(), extraCheck } = {}) {
  const { url, options } = materialize(row, f);
  let mark = f.frontEnd.mark();
  const edgeAnswer = await sendRow(f, edge, url, { ...options, ip }, row, () => { mark = f.frontEnd.mark(); });
  const exchanges = f.frontEnd.since(mark);
  let referenceAnswer = null;
  if (row.comparators.includes("worker")) {
    referenceAnswer = await sendRow(f, reference, url, { ...options, ip }, row);
    assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer, row), [],
      `${row.id}: edge and Worker differ (edge ${edgeAnswer.status} ${edgeAnswer.text.slice(0, 200)}; `
      + `exchanges ${JSON.stringify(exchanges.map((exchange) => [exchange.outcome, exchange.originStatus,
        exchange.framing, exchange.requestBodyBytes ?? null]))}; edge log ${edge.warnLines().at(-1) ?? "none"})`);
  }
  if (row.comparators.includes("local")) assert.equal(exchanges.length, 0, `${row.id}: answered at the edge`);
  if (row.comparators.includes("transparency")) {
    assert.equal(exchanges.length, 1, `${row.id}: exactly one forwarded exchange`);
    assert.deepEqual(transparencyMismatches(f, edgeAnswer, exchanges[0]), [], `${row.id}: transparency`);
  }
  if (row.comparators.includes("unported")) assertUnported(edgeAnswer, row.id);
  if (row.comparators.includes("definite")) assertDefinite(edgeAnswer, row.expect, row.id);
  const expect = row.expect ?? {};
  if (expect.status !== undefined) assert.equal(edgeAnswer.status, expect.status, `${row.id}: ${edgeAnswer.text.slice(0, 300)}`);
  if (expect.code !== undefined) assert.equal(errorEnvelope(edgeAnswer)?.code, expect.code, row.id);
  if (expect.location !== undefined) assert.equal(edgeAnswer.header("location"), expect.location, row.id);
  if (expect.allow !== undefined) assert.equal(edgeAnswer.header("allow"), expect.allow, row.id);
  if (expect.served !== undefined) {
    assert.equal(errorEnvelope(edgeAnswer)?.code === UNPORTED_CODE, !expect.served,
      `${row.id}: served=${expect.served} (${edgeAnswer.status} ${edgeAnswer.text.slice(0, 160)})`);
  }
  for (const exchange of exchanges) {
    assert.deepEqual(privacyViolations(f, exchange, { ip, hostKind: expect.forwardedHostKind ?? null }), [],
      `${row.id}: S7 privacy`);
    f.allExchanges.push({ exchange, ip, row: row.id });
  }
  if (expect.forwardsAccessAssertion !== undefined) {
    const forwarded = exchanges[0].requestHeaders.some(([name]) => name === "cf-access-jwt-assertion");
    assert.equal(forwarded, expect.forwardsAccessAssertion, `${row.id}: Access assertion forwarded`);
    assert.ok(exchanges[0].requestHeaders.some(([name, value]) => name === "cookie" && value.length > 0),
      `${row.id}: cookie forwarded`);
  }
  if (expect.callbackHeader !== undefined) {
    const header = exchanges[0].requestHeaders.find(([name]) => name === f.m.contract.EDGE_HEADERS.callbackQuery);
    assert.equal(header?.[1], expect.callbackHeader, `${row.id}: callback query travels in the header`);
  }
  f.rows.push({ stage: row.stage ?? null, id: row.id, status: edgeAnswer.status, exchanges: exchanges.length,
    framing: exchanges.map((exchange) => exchange.framing) });
  if (extraCheck) await extraCheck({ edgeAnswer, referenceAnswer, exchanges });
  return { edgeAnswer, referenceAnswer, exchanges };
}

// ---------------------------------------------------------------------------
// S0: modes

test("S0 modes: fenced, absent and invalid gcp answer at the edge; worker mode equals today's main byte for byte", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  // The e2e bundle carries the checked-in compatibility settings.
  assert.equal(f.compatibility.e2e.date, f.compatibility.checkedIn.date);
  assert.deepEqual(f.compatibility.e2e.flags, f.compatibility.checkedIn.flags);
  // workerd starts the bundle only when every named export is a handler or function.
  // The production line's index.ts (d43c8f92) has no PostgreSQL request-path
  // export; an edge tree that lacks it is held to the list without it.
  assert.deepEqual([...f.bundle.exports], ["UploadIngressBudget", "contributionRequestPreflight", "default", "handleRequest",
    ...(await edgeIndexExportsPostgresPath() ? ["isPostgresWorkerRequestPathSupported"] : []),
    "runScheduledMaintenance"]);

  const fenced = await createEdgeInstance({ ...f.common, mode: "fenced", invokerKeyJson: f.invoker.keyJson });
  disposers.push(() => fenced.dispose());
  const health = await fenced.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}/api/health`, { ip: nextIp() });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), {
    status: "ok", mode: "migration-mutation-barrier",
    maintenance: { state: "fenced", storageQualified: false },
    deployment: { sourceCommit: EDGE_E2E_SOURCE_COMMIT },
  });
  for (const [url, method] of [
    [`${EDGE_E2E_PUBLIC_ORIGIN}/api/ready`, "GET"],
    [`${EDGE_E2E_PUBLIC_ORIGIN}/api/v1/contributions`, "POST"],
    [`${EDGE_E2E_PUBLIC_ORIGIN}/api/v1/community/daily${MATRIX_VALUES.dailyQuery}`, "GET"],
    [`${EDGE_E2E_PUBLIC_ORIGIN}/admin`, "GET"],
    [`${EDGE_E2E_ADMIN_ORIGIN}/api/v1/admin/overview`, "GET"],
    [`${EDGE_E2E_PUBLIC_ORIGIN}/api/v1/internal/release/appcast`, "POST"],
  ]) {
    const answer = await fenced.fetch(url, { method, ip: nextIp(), ...(method === "POST" ? { body: "{}",
      headers: { "content-type": "application/json" } } : {}) });
    assert.equal(answer.status, 503, url);
    assert.equal(errorEnvelope(answer)?.code, "MUTATION_BARRIER_ACTIVE", url);
    assert.equal(answer.header("retry-after"), "300", url);
    assert.equal(answer.header("cache-control"), "no-store", url);
  }
  const wwwApi = await fenced.fetch(`${EDGE_E2E_WWW_ORIGIN}/api/x`, { ip: nextIp() });
  assert.equal(wwwApi.status, 503);
  assert.equal(errorEnvelope(wwwApi)?.code, "MUTATION_BARRIER_ACTIVE");
  assert.equal(wwwApi.header("retry-after"), "300");
  const asset = await fenced.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}/privacy.html`, { ip: nextIp() });
  assert.equal(asset.status, 200);
  assert.equal(asset.header("retry-after"), null);
  assert.equal(fenced.refusals.length, 0, "fenced mode makes no subrequest");

  for (const [label, mode, overrides] of [
    ["absent mode", null, {}],
    ["cased mode", "GCP", {}],
    ["gcp with a short client-key secret", "gcp", { EDGE_CLIENT_KEY_SECRET: "too-short" }],
    ["gcp with an http upstream", "gcp", { EDGE_UPSTREAM_ORIGIN: "http://edge-e2e-origin-000000000000.us-east1.run.app" }],
    ["gcp without the invoker key", "gcp", { EDGE_INVOKER_KEY_JSON: undefined }],
    ["gcp without PUBLIC_ORIGIN", "gcp", { PUBLIC_ORIGIN: undefined }],
  ]) {
    const instance = await createEdgeInstance({ ...f.common, mode, frontEnd: f.frontEnd,
      invokerKeyJson: f.invoker.keyJson, overrides });
    disposers.push(() => instance.dispose());
    const mark = f.frontEnd.mark();
    const tokenMark = f.frontEnd.tokenRequests.length;
    const page = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}/privacy.html`, { ip: nextIp() });
    assert.equal(page.status, 200, `${label}: assets serve`);
    if (overrides.PUBLIC_ORIGIN === undefined && Object.hasOwn(overrides, "PUBLIC_ORIGIN")) {
      // Without a pinned origin there is no www alias to redirect.
    } else {
      const www = await instance.fetch(`${EDGE_E2E_WWW_ORIGIN}/privacy.html`, { ip: nextIp() });
      assert.equal(www.status, 308, `${label}: www redirects`);
    }
    for (const path of ["/api/health", "/api/v1/envelope-key", `/api/v1/community/daily${MATRIX_VALUES.dailyQuery}`]) {
      const answer = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}${path}`, { ip: nextIp() });
      assert.equal(answer.status, 503, `${label} ${path}`);
      assert.equal(errorEnvelope(answer)?.code, "EDGE_NOT_CONFIGURED", `${label} ${path}`);
      assert.equal(answer.header("retry-after"), "60", `${label} ${path}`);
      assert.equal(answer.header("cache-control"), "no-store", `${label} ${path}`);
    }
    assert.equal(f.frontEnd.since(mark).length, 0, `${label}: no front-end exchange`);
    assert.equal(f.frontEnd.tokenRequests.length, tokenMark, `${label}: no token request`);
    const warns = instance.warnLines().filter((line) => line.includes("EDGE_NOT_CONFIGURED"));
    assert.equal(warns.length, 3, `${label}: one warn line per refusal`);
    for (const line of warns) assert.equal(line, "{\"level\":\"warn\",\"code\":\"EDGE_NOT_CONFIGURED\"}");
  }

  // Worker mode is today's main: the edge bundle in worker mode and the
  // checked-in wrangler.jsonc main, built with the same settings, answer the
  // same requests with the same bytes (request ids aside).
  const todayBundle = await buildEdgeBundle({ workerRoot: WORKER_ROOT, edgeTree: EDGE_TREE,
    main: f.compatibility.checkedIn.main });
  disposers.push(() => todayBundle.cleanup());
  const today = await createReferenceInstance({ ...f.common, bundle: todayBundle, mode: null, envelope: f.keys });
  disposers.push(() => today.dispose());
  const workerMode = await createReferenceInstance({ ...f.common, envelope: f.keys });
  disposers.push(() => workerMode.dispose());
  const mask = (text) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, "<uuid>");
  const samples = [
    [EDGE_E2E_WWW_ORIGIN, "/x?y=1", "GET"], [EDGE_E2E_PUBLIC_ORIGIN, "/", "GET"],
    [EDGE_E2E_PUBLIC_ORIGIN, "/api/health", "GET"], [EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/envelope-key", "GET"],
    [EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/nope", "GET"], [EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/session", "POST"],
    [EDGE_E2E_PUBLIC_ORIGIN, `/api/v1/community/daily${MATRIX_VALUES.dailyQuery}`, "GET"],
    [EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/device/sync/state", "GET"],
    [EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/contributions", "POST"],
    [EDGE_E2E_ADMIN_ORIGIN, "/admin", "GET"],
  ];
  for (const [originUrl, path, method] of samples) {
    const ip = nextIp();
    const options = { method, ip, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) };
    const a = await workerMode.fetch(`${originUrl}${path}`, options);
    const b = await today.fetch(`${originUrl}${path}`, options);
    assert.equal(a.status, b.status, path);
    assert.deepEqual(a.headers.filter(([name]) => name !== "date"), b.headers.filter(([name]) => name !== "date"), path);
    assert.equal(mask(a.text), mask(b.text), path);
  }
  assert.equal(today.refusals.length + workerMode.refusals.length, 0, "the Worker made no subrequest");

  // E5 caches one proxy per env object (a WeakMap). workerd hands the same env
  // object to every request of an isolate, sequential or concurrent, so the
  // invoker key is imported once per isolate.
  const probe = new Miniflare({ modules: true, compatibilityDate: EDGE_E2E_COMPATIBILITY.date,
    compatibilityFlags: [...EDGE_E2E_COMPATIBILITY.flags], bindings: { SETTING: "1" },
    script: "const seen = new WeakSet(); export default { async fetch(request, env) {"
      + " const had = seen.has(env); seen.add(env); return new Response(String(had)); } };" });
  try {
    const sequential = [];
    for (let index = 0; index < 3; index += 1) sequential.push(await (await probe.dispatchFetch("http://probe.test/")).text());
    const concurrent = await Promise.all([1, 2, 3].map(async () => (await probe.dispatchFetch("http://probe.test/")).text()));
    assert.deepEqual([...sequential, ...concurrent], ["false", "true", "true", "true", "true", "true"]);
  } finally {
    await probe.dispose();
  }
});

// ---------------------------------------------------------------------------
// S1: edge-local classes

test("S1 local: www, assets, unknown API, admin APIs on the apex, Apple, 405s and PUBLICATION_DISABLED equal the Worker", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  for (const row of localRows({ registry: f.m.registry.WORKER_ROUTE_POLICY })) {
    await runRow(f, { ...row, stage: "S1" });
  }
  const disabledEdge = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd: f.frontEnd,
    invokerKeyJson: f.invoker.keyJson, publicAnalyticsMode: "disabled" });
  disposers.push(() => disabledEdge.dispose());
  const disabledReference = await createReferenceInstance({ ...f.common, envelope: f.keys,
    overrides: { PUBLIC_ANALYTICS_MODE: "disabled" } });
  disposers.push(() => disabledReference.dispose());
  await runRow(f, { ...PUBLICATION_DISABLED_ROW, stage: "S1" }, { edge: disabledEdge, reference: disabledReference });
});

// ---------------------------------------------------------------------------
// S2: the admin host

test("S2 admin: the Access chokepoint equals the Worker; owner admin APIs forward with the assertion and answer unported", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  for (const row of adminRows()) await runRow(f, { ...row, stage: "S2" });

  // A production-ENVIRONMENT edge: no test JWKS reaches the Worker code, so
  // the chokepoint fetches the Access JWKS over the edge's own network, and
  // with distribution analytics configured an owner overview read starts the
  // Cloudflare GraphQL reads on that same single path. The front end serves
  // the synthetic JWKS and refuses api.cloudflare.com; the overview is the
  // origin's closed unported 503 (the edge-test origin composes no admin
  // family, so its admin host stays refused, OD-CR-3; production opens it,
  // ADMIN-R12), so nothing is merged and the answer passes through.
  const jwksHost = "synthetic-edge.cloudflareaccess.com";
  const frontEnd = createGoogleFrontEnd({ invoker: f.invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
    upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(f.origin.port),
    fixtureHosts: { [jwksHost]: (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(f.access.jwksJson);
    } } });
  const production = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd, invokerKeyJson: f.invoker.keyJson,
    overrides: { ENVIRONMENT: "production", DISTRIBUTION_ANALYTICS_ZONE_ID: "0".repeat(32),
      DISTRIBUTION_ANALYTICS_API_TOKEN: "synthetic-distribution-token" } });
  disposers.push(() => production.dispose());
  const overview = await production.fetch(`${EDGE_E2E_ADMIN_ORIGIN}/api/v1/admin/overview`, { ip: nextIp(),
    headers: { "cf-access-jwt-assertion": f.access.owner() } });
  assertUnported(overview, "production-environment overview");
  assert.equal(frontEnd.exchanges.length, 1, "the overview was forwarded once");
  assert.deepEqual(transparencyMismatches(f, overview, frontEnd.exchanges[0]), []);
  assert.deepEqual(frontEnd.fixtureRequests.map((request) => request.host), [jwksHost], "the JWKS came over the edge's network");
  const graphql = frontEnd.refusals.filter((refusal) => refusal.host === "api.cloudflare.com");
  assert.ok(graphql.length > 0 && graphql.length === frontEnd.refusals.length,
    "the distribution reads used the same single path, and only they were refused");
  const nonOwner = await production.fetch(`${EDGE_E2E_ADMIN_ORIGIN}/admin`, { ip: nextIp(),
    headers: { "cf-access-jwt-assertion": f.access.nonOwner() } });
  assert.equal(nonOwner.status, 403);
  f.rows.push({ stage: "S2", id: "production-environment-overview", graphqlReads: graphql.length,
    jwksFetches: frontEnd.fixtureRequests.length });
});

// ---------------------------------------------------------------------------
// S3: forwarded rows and the route sweep

test("S3 forwarded: Worker-comparable refusals match, every forwarded pair is served or unported, verifier reads", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const registry = f.m.registry.WORKER_ROUTE_POLICY;
  for (const row of forwardedRows({ registry })) await runRow(f, { ...row, stage: "S3" });
  for (const row of sweepRows({ registry, servedRouteIds: f.m.composition.POSTGRES_PORTED_WORKER_ROUTE_IDS,
    definiteAnswers: definiteSweepAnswers(RETIRED_DEFINITE_PREAMBLE_STEPS) })) {
    await runRow(f, { ...row, stage: "S3" });
  }
  // The verifier reads health and readiness straight through the front end.
  // RD-3 health (the Worker body minus the two append-only keys) and RD-2
  // ready, Worker-exact: not_ready until a lifecycle pass ran (OD-CR-4).
  const health = await f.frontEnd.direct({ path: "/api/health", email: EDGE_E2E_VERIFIER });
  assert.equal(health.status, 200);
  assert.equal(health.headers["x-tibotattle-origin"], "1");
  assert.equal(JSON.parse(health.body.toString()).status, "ok");
  const ready = await f.frontEnd.direct({ path: "/api/ready", email: EDGE_E2E_VERIFIER });
  assert.equal(ready.status, 503);
  assert.equal(ready.headers["x-tibotattle-origin"], "1");
  const readyBody = JSON.parse(ready.body.toString());
  assert.deepEqual(f.m.readiness.validatePostgresReadinessBody(readyBody), []);
  assert.equal(readyBody.status, "not_ready");
  // Without a token Google's front end refuses before the origin, unmarked.
  const anonymous = await f.frontEnd.direct({ path: "/api/health" });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["x-tibotattle-origin"], undefined);
  const stranger = await f.frontEnd.direct({ path: "/api/health", email: EDGE_E2E_STRANGER });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.headers["x-tibotattle-origin"], undefined);
  // The edge reaches /api/ready as the invoker: RD-2's not_ready 503, passed through.
  await runRow(f, { id: "ready-through-edge", stage: "S3", routeId: "ready", host: "apex", method: "GET",
    path: "/api/ready", headers: {}, comparators: ["transparency"], expect: { status: 503, served: true } });
});

// ---------------------------------------------------------------------------
// S5: shipped clients through the edge

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const CONTRIBUTIONS_PATH = "/api/v1/contributions";
const UPLOAD_AUTHORIZATIONS_PATH = "/api/v1/device/upload-authorizations";
const V1_CONSENT = Object.freeze({
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
});
const ACCOUNTLESS_V11_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v0.1",
  policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1",
  telemetrySchemaVersion: "telemetry-contribution-v1.1",
});
const ACCOUNTLESS_V12_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v1.2",
  policyVersion: "accountless-telemetry-v1.2-policy-v1",
  authorizationBasis: "accountless-policy-v1.2",
  telemetrySchemaVersion: "telemetry-contribution-v1.2",
});
const CAPABILITY_PATHS = new Set(["/api/v1/device/sync-capabilities", "/api/v1/device/sync-capabilities-v1.2"]);

/** The client's view of an edge answer: a plain global Response, as fetch returns it. */
function toClientResponse(answer) {
  const headers = new Headers();
  for (const [name, value] of answer.headers) headers.append(name, value);
  const nullBody = [101, 204, 205, 304].includes(answer.status);
  return new Response(nullBody ? null : answer.body, { status: answer.status, headers });
}

/**
 * A fetch for shipped client code: each call goes through the edge from one
 * client address, must forward exactly once, and passes the transparency and
 * S7 checks. With laboratoryOrigin, the client is configured for the
 * loopback laboratory origin (the only accountless destination it accepts
 * besides staging and production) and the harness maps that origin to the
 * edge's public origin on the way in, and the capability answers'
 * destinationOrigin back on the way out; nothing else is touched.
 */
function edgeClientFetch(f, { ip = nextIp(), log = [], laboratoryOrigin = null } = {}) {
  const state = { log, originRewrites: 0 };
  const fetchImpl = async (input, init = {}) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (laboratoryOrigin !== null) {
      assert.ok(url.startsWith(`${laboratoryOrigin}/`), "the laboratory client only calls its origin");
      url = `${EDGE_E2E_PUBLIC_ORIGIN}${url.slice(laboratoryOrigin.length)}`;
    }
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    const method = init.method ?? "GET";
    const mark = f.frontEnd.mark();
    const answer = await f.edge.fetch(url, { method, headers, body: init.body, ip });
    const exchanges = f.frontEnd.since(mark);
    const path = new URL(url).pathname;
    assert.equal(exchanges.length, 1, `${method} ${path}: one forwarded exchange`);
    assert.deepEqual(transparencyMismatches(f, answer, exchanges[0]), [], `${method} ${path}: transparency`);
    assert.deepEqual(privacyViolations(f, exchanges[0], { ip }), [], `${method} ${path}: S7 privacy`);
    f.allExchanges.push({ exchange: exchanges[0], ip, row: `S5 ${method} ${path}` });
    log.push({ method, path, status: answer.status, body: typeof init.body === "string" ? init.body : undefined,
      framing: exchanges[0].framing });
    if (laboratoryOrigin !== null && CAPABILITY_PATHS.has(path) && answer.status === 200) {
      const value = JSON.parse(answer.text);
      assert.equal(value.destinationOrigin, EDGE_E2E_PUBLIC_ORIGIN, "the origin names the edge's public origin");
      value.destinationOrigin = laboratoryOrigin;
      state.originRewrites += 1;
      return new Response(JSON.stringify(value), { status: 200, headers: toClientResponse(answer).headers });
    }
    return toClientResponse(answer);
  };
  return Object.assign(fetchImpl, { state });
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`).update(secret).digest();
}

/** A paired, active social participant and device (the intake spec's seed). */
async function socialOwner(f, { participantId, pairingConsent }) {
  const { base, t, m } = f;
  const nowEpoch = Date.now();
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 30 * DAY_MS).toISOString();
  await base.query(`INSERT INTO ${t("participants")} (id, owner_kind, state, consent_version, created_at)
    VALUES ($1, 'social', 'active', $2, $3)`, [participantId, m.constants.TELEMETRY_CONSENT_VERSION, now]);
  const session = await m.session.createSessionMaterial(participantId, nowEpoch);
  await base.query(`INSERT INTO ${t("web_sessions")} (
      id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at
    ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $6)`,
  [session.id, participantId, session.secretHash, session.csrfHash, session.scope, session.issuedAt, session.expiresAt]);
  const deviceId = randomUUID();
  const pairingId = randomUUID();
  const secret = randomBytes(32);
  await base.query(`INSERT INTO ${t("device_pairings")} (
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7, $8, $7, $9)`,
  [pairingId, participantId, session.id, randomBytes(32), pairingConsent.consentVersion,
    pairingConsent.transportConsentVersion, now, expires, deviceId]);
  await base.query(`INSERT INTO ${t("device_credentials")} (
      id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
      state, issued_at, expires_at, last_used_at, social_verified_at
    ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
  [deviceId, participantId, pairingId, deviceSecretHash(deviceId, secret), now, expires]);
  return {
    participantId, deviceId, secret, session,
    cookie: m.session.sessionCookie(session).split(";", 1)[0],
    deviceAuthorization: `Device um_device_${deviceId}.${secret.toString("base64url")}`,
  };
}

function browserHeaders(owner) {
  return {
    origin: EDGE_E2E_PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
    cookie: owner.cookie,
    "x-usage-monitor-csrf": owner.session.csrfToken,
  };
}

function post(fetchImpl, base, path, body, headers = {}) {
  return fetchImpl(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** test/helpers/telemetry-v11.ts makeV11Day: one day's manifest and its 200-record chunks. */
function makeV11Day(day, recordsByStream, parserVersion) {
  const consent = telemetryV11RequiredConsent();
  const chunks = [];
  for (const stream of ["quota", "session", "usage"]) {
    const source = recordsByStream[stream] ?? [];
    for (let offset = 0; offset < source.length; offset += 200) {
      const records = source.slice(offset, offset + 200);
      chunks.push({
        schemaVersion: "telemetry-contribution-v1.1", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
        chunkDigest: sha256Hex(canonicalTelemetryV11Json(records)), parserVersion, consent, records,
      });
    }
  }
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.1", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV11DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function q1Day(name) {
  const fixture = JSON.parse(await readFile(resolve(WORKER_ROOT, "postgres-test/fixtures", name), "utf8"));
  return {
    day: fixture.day,
    readDay: (day) => makeV11Day(day, day === fixture.day ? fixture.records : {}, fixture.parserVersion),
    recordCount: Object.values(fixture.records).reduce((sum, records) => sum + records.length, 0),
  };
}

function envelopeFactory(fetchImpl, base, create) {
  let key;
  return async (chunk) => {
    key ??= await (await fetchImpl(new URL("/api/v1/envelope-key", base), { headers: { accept: "application/json" } })).json();
    return create({ chunk, publicJwk: key.publicJwk, keyId: key.keyId, cryptoImpl: webcrypto });
  };
}

function v12UsageRecord(eventId, eventTime) {
  return {
    schemaVersion: "usage-event-v1.2", eventId, eventTime, sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription", reasoningEffort: "high",
    agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75 },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
      planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

/** cloud-run/host.check.mjs hostV12ClientDay: one deterministic local v1.2 day. */
function makeV12Day(day, count, parserVersion) {
  const consent = telemetryV12RequiredConsent();
  const records = Array.from({ length: count }, (_, index) => v12UsageRecord(
    `event:v2:${sha256Hex(`edge-e2e-v12:${parserVersion}:${day}:${index}`)}`,
    `${day}T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
  ));
  const chunks = count === 0 ? [] : [{
    schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64), chunkId: `usage:${day}:0`,
    chunkRevision: 1, chunkDigest: sha256Hex(Buffer.from(canonicalTelemetryV12Json(records))), parserVersion,
    consent, records,
  }];
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(Buffer.from(telemetryV12DayManifestDigestInput(manifest)));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function grantStates(f, participantId) {
  return (await f.base.query(`SELECT state, count(*)::int AS n FROM ${f.t("device_upload_authorizations")}
    WHERE participant_id = $1 GROUP BY state ORDER BY state`, [participantId])).rows;
}

async function v11Counts(f, participantId) {
  const { base, t } = f;
  return (await base.query(`SELECT
      (SELECT count(*)::int FROM ${t("telemetry_v11_chunks")} WHERE participant_id = $1) AS chunks,
      (SELECT count(*)::int FROM ${t("typed_v11_record_admissions")} admission
         JOIN ${t("telemetry_v11_chunks")} chunk ON chunk.id = admission.chunk_id WHERE chunk.participant_id = $1) AS records,
      (SELECT count(*)::int FROM ${t("telemetry_v11_domains")} WHERE participant_id = $1) AS domains,
      (SELECT revision::int FROM ${t("telemetry_v11_domain_heads")} WHERE participant_id = $1) AS head`,
  [participantId])).rows[0];
}

async function v12Counts(f, participantId) {
  const { base, t } = f;
  return (await base.query(`SELECT
      (SELECT count(*)::int FROM ${t("telemetry_v12_chunks")} WHERE participant_id = $1) AS chunks,
      (SELECT count(*)::int FROM ${t("telemetry_v12_domains")} WHERE participant_id = $1) AS domains,
      (SELECT revision::int FROM ${t("telemetry_v12_domain_heads")} WHERE participant_id = $1) AS head`,
  [participantId])).rows[0];
}

/** Re-post one retained envelope under a fresh authorization: the shipped re-upload. */
async function reupload(fetchImpl, base, deviceAuthorization, raw, telemetrySchemaVersion) {
  const authorization = await post(fetchImpl, base, UPLOAD_AUTHORIZATIONS_PATH, {
    envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
    ...(telemetrySchemaVersion === undefined ? {} : { telemetrySchemaVersion }),
  }, { authorization: deviceAuthorization });
  assert.equal(authorization.status, 201);
  const { uploadAuthorization } = await authorization.json();
  return post(fetchImpl, base, CONTRIBUTIONS_PATH, raw, { authorization: `Upload ${uploadAuthorization}` });
}

async function accountlessEnroll(f, fetchImpl, base) {
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const deviceAuthorization = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const enrolled = await post(fetchImpl, base, "/api/v1/accountless/enrollment", {
    schemaVersion: "accountless-enrollment-v0.1", deviceId,
    deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex"),
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
  });
  assert.equal(enrolled.status, 201, await enrolled.clone().text());
  const owned = await post(fetchImpl, base, "/api/v1/accountless/ownership", ACCOUNTLESS_V11_AUTHORIZATION,
    { authorization: deviceAuthorization });
  assert.equal(owned.status, 201, await owned.clone().text());
  const participantId = (await f.base.query(`SELECT participant_id FROM ${f.t("accountless_upload_owners")}
    WHERE enrollment_device_id = $1`, [deviceId])).rows[0].participant_id;
  return { deviceId, secret, deviceAuthorization, participantId };
}

test("S5 v1.1: a shipped social client and a shipped accountless client sync through the edge and replay", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  // Social: consent through the real route with the web session, then sync.
  const log = [];
  const fetchImpl = edgeClientFetch(f, { log });
  const owner = await socialOwner(f, {
    participantId: `synthetic-edge-e2e-v11-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: f.m.constants.TELEMETRY_CONSENT_VERSION,
      transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
  });
  const q1 = await q1Day("telemetry-v11-live-q1-owner-a-2026-09-30.json");
  const sync = () => runTelemetryV11Sync({
    serverBaseUrl: EDGE_E2E_PUBLIC_ORIGIN, deviceAuthorization: owner.deviceAuthorization,
    consent: telemetryV11RequiredConsent(), days: [q1.day], readDay: q1.readDay,
    createEnvelope: envelopeFactory(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, createTelemetryV11Envelope), fetchImpl,
    maxDurationMs: 240_000,
  });
  const refused = await sync();
  assert.equal(refused.status, "failed");
  assert.equal(refused.failure.code, "consent_rejected");
  const consent = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/me/device-telemetry-consents",
    { deviceId: owner.deviceId, consent: telemetryV11RequiredConsent(), ongoingUpload: true }, browserHeaders(owner));
  assert.equal(consent.status, 201);
  assert.deepEqual(await consent.json(), { consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 });
  const first = await sync();
  assert.equal(first.status, "complete", JSON.stringify(first.failure));
  assert.equal(first.recordsUploaded, q1.recordCount);
  assert.ok(first.chunksUploaded >= 3);
  const paths = new Set(log.map((entry) => `${entry.method} ${entry.path}`));
  for (const expected of ["GET /api/v1/device/sync-capabilities", "POST /api/v1/me/telemetry-v11/domain-predecessor",
    "POST /api/v1/device/telemetry/v1.1/day-manifests", `POST ${UPLOAD_AUTHORIZATIONS_PATH}`, `POST ${CONTRIBUTIONS_PATH}`,
    "POST /api/v1/me/telemetry-v11/domain-activate"]) {
    assert.ok(paths.has(expected), `${expected} went through the edge`);
  }
  assert.deepEqual(await v11Counts(f, owner.participantId),
    { chunks: first.chunksUploaded, records: q1.recordCount, domains: 1, head: 1 });
  const second = await sync();
  assert.equal(second.status, "complete", JSON.stringify(second.failure));
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.domainGenerationId, first.domainGenerationId);
  const uploaded = log.find((entry) => entry.path === CONTRIBUTIONS_PATH && entry.status === 202);
  const replay = await reupload(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, owner.deviceAuthorization, uploaded.body,
    "telemetry-contribution-v1.1");
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await v11Counts(f, owner.participantId),
    { chunks: first.chunksUploaded, records: q1.recordCount, domains: 1, head: 1 });
  assert.deepEqual(await grantStates(f, owner.participantId), [{ state: "consumed", n: first.chunksUploaded + 1 }]);
  // Uploads carry a fixed-length body through the edge, as the shipped client sends it.
  assert.ok(log.filter((entry) => entry.path === CONTRIBUTIONS_PATH)
    .every((entry) => entry.framing.contentLength !== null && !entry.framing.chunked));

  // Accountless: enrollment and ownership through the edge, then the v1.1 grant chain.
  const accountlessLog = [];
  const direct = edgeClientFetch(f, { log: accountlessLog });
  const device = await accountlessEnroll(f, direct, EDGE_E2E_PUBLIC_ORIGIN);
  const laboratory = edgeClientFetch(f, { log: accountlessLog, laboratoryOrigin: LABORATORY_ORIGIN });
  const q1b = await q1Day("telemetry-v11-live-q1-owner-b-2026-09-30.json");
  const syncAccountless = () => runTelemetryV11Sync({
    serverBaseUrl: LABORATORY_ORIGIN, deviceAuthorization: device.deviceAuthorization,
    authorization: ACCOUNTLESS_V11_AUTHORIZATION, laboratory: true, days: [q1b.day], readDay: q1b.readDay,
    createEnvelope: envelopeFactory(laboratory, LABORATORY_ORIGIN, createTelemetryV11Envelope), fetchImpl: laboratory,
    maxDurationMs: 240_000,
  });
  const accountlessFirst = await syncAccountless();
  assert.equal(accountlessFirst.status, "complete", JSON.stringify(accountlessFirst.failure));
  assert.equal(accountlessFirst.recordsUploaded, q1b.recordCount);
  const accountlessSecond = await syncAccountless();
  assert.equal(accountlessSecond.status, "complete");
  assert.equal(accountlessSecond.chunksUploaded, 0);
  assert.equal(accountlessSecond.domainGenerationId, accountlessFirst.domainGenerationId);
  assert.ok(laboratory.state.originRewrites >= 2, "only the capability answers' destinationOrigin was mapped");
  assert.deepEqual(await v11Counts(f, device.participantId),
    { chunks: accountlessFirst.chunksUploaded, records: q1b.recordCount, domains: 1, head: 1 });
});

test("S5 v1.2: a shipped social client and a shipped accountless client sync through the edge and re-run idempotently", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const parser = "synthetic-edge-e2e-v12";
  const day = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
  const records = new Map([[day(-2), 2], [day(-1), 0], [day(0), 3]]);
  const days = [...records.keys()].sort();
  const readDay = (value) => makeV12Day(value, records.get(value) ?? 0, parser);

  // Social: the v1.2 consent through the real route, then sync.
  const log = [];
  const fetchImpl = edgeClientFetch(f, { log });
  const owner = await socialOwner(f, {
    participantId: `synthetic-edge-e2e-v12-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
      transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.2" },
  });
  const consent = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/me/device-telemetry-v12-consents",
    { deviceId: owner.deviceId, consent: telemetryV12RequiredConsent(), ongoingUpload: true }, browserHeaders(owner));
  assert.equal(consent.status, 201, await consent.clone().text());
  const sync = () => runTelemetryV12Sync({
    serverBaseUrl: EDGE_E2E_PUBLIC_ORIGIN, deviceAuthorization: owner.deviceAuthorization,
    consent: telemetryV12RequiredConsent(), days, readDay,
    createEnvelope: envelopeFactory(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, createTelemetryV12Envelope), fetchImpl,
    maxDurationMs: 240_000,
  });
  const first = await sync();
  assert.equal(first.status, "complete", JSON.stringify(first.failure));
  assert.equal(first.chunksUploaded, 2);
  assert.equal(first.recordsUploaded, 5);
  const paths = new Set(log.map((entry) => `${entry.method} ${entry.path}`));
  for (const expected of ["GET /api/v1/device/sync-capabilities-v1.2", "POST /api/v1/me/telemetry-v12/domain-predecessor",
    "POST /api/v1/device/telemetry/v1.2/day-manifests", `POST ${UPLOAD_AUTHORIZATIONS_PATH}`, `POST ${CONTRIBUTIONS_PATH}`,
    "POST /api/v1/me/telemetry-v12/domain-activate"]) {
    assert.ok(paths.has(expected), `${expected} went through the edge`);
  }
  const counts = await v12Counts(f, owner.participantId);
  assert.deepEqual(counts, { chunks: 2, domains: 1, head: 1 });
  const second = await sync();
  assert.equal(second.status, "complete", JSON.stringify(second.failure));
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.domainGenerationId, first.domainGenerationId);
  assert.deepEqual(await v12Counts(f, owner.participantId), counts);

  // Accountless: enrollment, ownership and the v1.2 authorization through the edge.
  const accountlessLog = [];
  const direct = edgeClientFetch(f, { log: accountlessLog });
  const device = await accountlessEnroll(f, direct, EDGE_E2E_PUBLIC_ORIGIN);
  const granted = await post(direct, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/accountless/telemetry-v1.2-authorization",
    ACCOUNTLESS_V12_AUTHORIZATION, { authorization: device.deviceAuthorization });
  assert.equal(granted.status, 201, await granted.clone().text());
  assert.deepEqual(await granted.json(), ACCOUNTLESS_V12_AUTHORIZATION);
  const laboratory = edgeClientFetch(f, { log: accountlessLog, laboratoryOrigin: LABORATORY_ORIGIN });
  const syncAccountless = () => runTelemetryV12Sync({
    serverBaseUrl: LABORATORY_ORIGIN, deviceAuthorization: device.deviceAuthorization,
    authorization: ACCOUNTLESS_V12_AUTHORIZATION, laboratory: true, days, readDay,
    createEnvelope: envelopeFactory(laboratory, LABORATORY_ORIGIN, createTelemetryV12Envelope), fetchImpl: laboratory,
    maxDurationMs: 240_000,
  });
  const accountlessFirst = await syncAccountless();
  assert.equal(accountlessFirst.status, "complete", JSON.stringify(accountlessFirst.failure));
  assert.equal(accountlessFirst.chunksUploaded, 2);
  const accountlessCounts = await v12Counts(f, device.participantId);
  assert.deepEqual(accountlessCounts, { chunks: 2, domains: 1, head: 1 });
  const accountlessSecond = await syncAccountless();
  assert.equal(accountlessSecond.status, "complete", JSON.stringify(accountlessSecond.failure));
  assert.equal(accountlessSecond.chunksUploaded, 0);
  assert.deepEqual(await v12Counts(f, device.participantId), accountlessCounts);
  assert.ok(laboratory.state.originRewrites >= 2);
});

/** root test/contribution-v1-sync-engine.test.js writeEvents: a real local unified index. */
async function writeUnifiedIndex(file, events) {
  const database = openLocalUnifiedIndex(file, { readOnly: false, create: true });
  const writer = createUnifiedIndexWriter(database, { contractVersion: "telemetry-contribution-v0.1" });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
  });
  for (const event of events) {
    writer.writeUsageEvent({
      eventKey: event.eventKey, observedAtMs: event.observedAtMs, sessionLocal: Buffer.alloc(32, 0x0c),
      accountScopeId, modelId: writer.internModel("gpt-5.6-sol", "recognized"),
      tierId: writer.internTier({
        apiServiceTier: "unknown", billingSurface: "chatgpt_subscription", codexSpeedMode: "standard",
        tierSource: "rollout_thread_settings", providerTierRaw: "default",
      }),
      surfaceId: writer.internSurface({
        agentScope: "root", surface: "extension_or_ide", threadSource: "rollout", lineageDisposition: "standalone",
      }),
      quotaObservationId: null, reasoningEffort: reasoningEffortOrdinal("medium"), outcome: outcomeOrdinal("unknown"),
      tokensInUncached: event.tokens, tokensInCacheRead: null, tokensInCacheWrite: null,
      tokensInCacheWrite5m: null, tokensInCacheWrite1h: null, tokensOutText: 1, tokensOutReasoning: null,
      tokensOutCombined: null, totalInputContext: null,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: null });
}

/** The intake spec's synthetic v0.1 contribution: one usage event, one quota snapshot. */
function v01Contribution() {
  const toolClassCounts = {
    webSearch: 1, fileSearch: 0, codeInterpreter: 0, hostedShell: 0, computerUse: 0, mcp: 0,
    applyPatch: 1, localShell: 2, subagent: 0, toolGateway: 1, other: 0, unknown: 0,
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1", synthetic: false, createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-25T12:00:00.000Z", endAt: "2026-07-25T12:30:00.000Z" },
    clientPlatform: "macos", providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1", eventTime: "2026-07-25T12:05:00.000Z", provider: "openai_codex",
      modelId: "gpt-5.6-sol", modelRecognition: "recognized", modelFingerprint: null,
      billingSurface: "chatgpt_subscription", speedMode: "fast", apiServiceTier: "priority", reasoningEffort: "xhigh",
      components: {
        inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0, inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null,
      },
      totalInputContextTokens: 1000, surface: "local_interactive_unclassified", agentScope: "root",
      lineageDisposition: "standalone", toolClassCounts, outcome: "completed", eventId: `event:v2:${"e".repeat(64)}`,
      accounting: { estimatedApiCostUsd: "1.000000", pricingCoveragePercent: 100, unknownBillableUnits: 0,
        priceBasis: "current_api_prices" },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1", observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z", provider: "openai_codex", planType: "pro", planVariant: "pro-20x",
      limitId: "codex", slot: "seven_day", usedPercent: 31, displayPrecision: 0, windowDurationMinutes: 10080,
      resetsAt: "2026-07-31T12:00:00.000Z", snapshotSource: "rollout", providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${"e".repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: { estimatedApiCostUsd: "1.000000", pricedEventCoveragePercent: 100, unknownModelEventCount: 0,
      unknownBillableUnits: 0, priceBasis: "current_api_prices" },
  };
}

test("S5 v1.0 and v0.1: the shipped backfill engine runs through the edge; the retired v0.1 uploader is the definite 403", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const { base, t } = f;
  const log = [];
  const fetchImpl = edgeClientFetch(f, { log });
  const owner = await socialOwner(f, {
    participantId: `synthetic-edge-e2e-v1-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: V1_CONSENT.privacyContractVersion,
      transportConsentVersion: V1_CONSENT.privacyContractVersion },
  });
  await base.query(`INSERT INTO ${t("telemetry_v1_device_consents")} (participant_id, device_id,
      telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [owner.participantId, owner.deviceId, V1_CONSENT.telemetrySchemaVersion,
    V1_CONSENT.fieldDictionaryVersion, V1_CONSENT.privacyContractVersion, new Date().toISOString()]);
  const directory = await mkdtemp(join(tmpdir(), "edge-e2e-v1-index-"));
  try {
    const indexFile = join(directory, "index.sqlite");
    const backfillDays = 12;
    const firstDay = Date.parse("2026-09-18T00:00:00.000Z");
    await writeUnifiedIndex(indexFile, Array.from({ length: backfillDays }, (_, index) => {
      const eventKey = Buffer.alloc(32, 0);
      eventKey.writeUInt32BE(index + 1, 28);
      return { eventKey, observedAtMs: firstDay + index * DAY_MS + 1_000, tokens: 10 + index };
    }));
    const engine = () => runIncrementalContributionSyncOnce({
      indexFile, origin: EDGE_E2E_PUBLIC_ORIGIN, backend: {}, fetchImpl,
      withDeviceSecret: async ({ expectedOrigin, operation }) =>
        operation(owner.secret, { origin: expectedOrigin, deviceId: owner.deviceId }),
    });
    const first = await engine();
    assert.equal(first.status, "complete", JSON.stringify(first.failure));
    assert.equal(first.chunksUploaded, backfillDays);
    assert.equal(first.acknowledgedThroughDay, "2026-09-29");
    const uploads = log.filter((entry) => entry.path === CONTRIBUTIONS_PATH);
    assert.equal(uploads.length, backfillDays);
    assert.ok(uploads.every((entry) => entry.status === 202
      && JSON.parse(entry.body).schemaVersion === "telemetry-envelope-v1.0"));
    const authorizations = log.filter((entry) => entry.path === UPLOAD_AUTHORIZATIONS_PATH);
    assert.ok(authorizations.every((entry) => entry.status === 201
      && Object.keys(JSON.parse(entry.body)).sort().join() === "contentLengthBytes,contentType,envelopeDigest"));
    const rows = async () => (await base.query(`SELECT
        (SELECT count(*)::int FROM ${t("telemetry_v1_chunks")} WHERE participant_id = $1) AS chunks,
        (SELECT count(*)::int FROM ${t("typed_v1_record_admissions")} admission
           JOIN ${t("telemetry_v1_chunks")} chunk ON chunk.id = admission.chunk_id WHERE chunk.participant_id = $1) AS records`,
    [owner.participantId])).rows[0];
    assert.deepEqual(await rows(), { chunks: backfillDays, records: backfillDays });
    const second = await engine();
    assert.equal(second.status, "complete", JSON.stringify(second.failure));
    assert.equal(second.chunksUploaded, 0);
    const replay = await reupload(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, owner.deviceAuthorization, uploads[0].body);
    assert.equal(replay.status, 202);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await rows(), { chunks: backfillDays, records: backfillDays });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // v0.1: owner round 12 retires v0.x uploads. The prepared contribution is
  // authorized under the default v1.0 format, claimed, then refused at the
  // transport write-authority step with d43c8f92's definite 403
  // TELEMETRY_TRANSPORT_BLOCKED (round 19) through the edge, and nothing is
  // admitted.
  const v01Log = [];
  const v01Fetch = edgeClientFetch(f, { log: v01Log });
  const v01Owner = await socialOwner(f, {
    participantId: `synthetic-edge-e2e-v01-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: V1_CONSENT.privacyContractVersion,
      transportConsentVersion: V1_CONSENT.privacyContractVersion },
  });
  const syncPrepared = () => syncPreparedContributionEntryOnce({
    directory: "synthetic-prepared-set", entry: { basename: "synthetic-v01.json" }, origin: EDGE_E2E_PUBLIC_ORIGIN,
    backend: {}, fetchImpl: v01Fetch, cryptoImpl: webcrypto, loadContribution: async () => v01Contribution(),
    withDeviceSecret: async ({ expectedOrigin, operation }) =>
      operation(v01Owner.secret, { origin: expectedOrigin, deviceId: v01Owner.deviceId }),
  });
  await assert.rejects(syncPrepared());
  const upload = v01Log.find((entry) => entry.path === CONTRIBUTIONS_PATH);
  assert.equal(upload.status, 403);
  const v01Rows = async () => (await base.query(`SELECT
      (SELECT count(*)::int FROM ${t("telemetry_contributions")} WHERE participant_id = $1) AS contributions,
      (SELECT count(*)::int FROM ${t("telemetry_records")} WHERE participant_id = $1) AS records`,
  [v01Owner.participantId])).rows[0];
  assert.deepEqual(await v01Rows(), { contributions: 0, records: 0 });
  const v01Retry = await reupload(v01Fetch, EDGE_E2E_PUBLIC_ORIGIN, v01Owner.deviceAuthorization, upload.body);
  assert.equal(v01Retry.status, 403);
  assert.equal(v01Retry.headers.get("retry-after"), null);
  assert.equal((await v01Retry.json()).error.code, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await v01Rows(), { contributions: 0, records: 0 });
});

test("S5 personal routes: session, pairing create and claim, devices, revoke, disconnect and logout through the edge", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const { base, t } = f;
  const log = [];
  const fetchImpl = edgeClientFetch(f, { log });
  const owner = await socialOwner(f, {
    participantId: `synthetic-edge-e2e-personal-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: f.m.constants.TELEMETRY_CONSENT_VERSION,
      transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
  });
  const session = await fetchImpl(new URL("/api/v1/session", EDGE_E2E_PUBLIC_ORIGIN), {
    headers: { cookie: owner.cookie },
  });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.participantId, owner.participantId);
  assert.equal(session.headers.get("vary"), "Cookie");

  const pairing = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/me/device-pairings",
    { consentVersion: "ongoing-privacy-safe-telemetry-v0.1", ongoingUpload: true }, browserHeaders(owner));
  assert.equal(pairing.status, 201, await pairing.clone().text());
  const { pairingCode } = await pairing.json();
  assert.match(pairingCode, /^um_pair_/u);
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const claim = () => post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/device-pairings/claim",
    { deviceId, deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex") },
    { authorization: `Pairing ${pairingCode}` });
  const claimed = await claim();
  assert.equal(claimed.status, 201, await claimed.clone().text());
  assert.equal((await claimed.json()).deviceId, deviceId);
  const credentials = async () => (await base.query(`SELECT count(*)::int AS n FROM ${t("device_credentials")}
    WHERE participant_id = $1`, [owner.participantId])).rows[0].n;
  assert.equal(await credentials(), 2);
  // The same claim again is a replay of the same device; another device cannot use the consumed code.
  const reclaimed = await claim();
  assert.ok(reclaimed.status < 300, `the replayed claim answers as before (${reclaimed.status})`);
  assert.equal((await reclaimed.json()).deviceId, deviceId);
  const otherDevice = randomUUID();
  const stolen = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/device-pairings/claim",
    { deviceId: otherDevice, deviceSecretHash: deviceSecretHash(otherDevice, randomBytes(32)).toString("hex") },
    { authorization: `Pairing ${pairingCode}` });
  assert.ok(stolen.status >= 400, `a consumed code does not pair another device (${stolen.status})`);
  assert.equal(await credentials(), 2, "neither re-run created a credential");

  const devices = await fetchImpl(new URL("/api/v1/me/devices", EDGE_E2E_PUBLIC_ORIGIN), {
    headers: { cookie: owner.cookie },
  });
  assert.equal(devices.status, 200);
  const listed = (await devices.json()).devices.map((device) => device.deviceId).sort();
  assert.deepEqual(listed, [owner.deviceId, deviceId].sort());

  const revoked = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/me/devices/revoke", { deviceId },
    browserHeaders(owner));
  assert.equal(revoked.status, 200, await revoked.clone().text());
  const disconnect = await fetchImpl(new URL("/api/v1/device/disconnect", EDGE_E2E_PUBLIC_ORIGIN), {
    method: "POST", headers: { authorization: owner.deviceAuthorization },
  });
  assert.equal(disconnect.status, 200, await disconnect.clone().text());
  const states = (await base.query(`SELECT id, state FROM ${t("device_credentials")} WHERE participant_id = $1
    ORDER BY id`, [owner.participantId])).rows;
  assert.equal(states.length, 2);
  assert.ok(states.every((row) => row.state !== "active"), JSON.stringify(states));

  const logout = await post(fetchImpl, EDGE_E2E_PUBLIC_ORIGIN, "/api/v1/logout", {}, browserHeaders(owner));
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.equal(logout.headers.getSetCookie().length, 1, "the Set-Cookie passes through the edge");
  const after = await fetchImpl(new URL("/api/v1/session", EDGE_E2E_PUBLIC_ORIGIN), { headers: { cookie: owner.cookie } });
  assert.equal(after.status, 401);
});

// ---------------------------------------------------------------------------
// S6: upstream failures

const UPSTREAM_LOG_KEYS = ["code", "event", "level", "method", "requestId", "routeClass"];

/** The edge's 503 for an upstream failure, and its one content-free warn line. */
function assertUpstreamUnavailable(answer, instance, code, label, { ip = null } = {}) {
  assert.equal(answer.status, 503, `${label}: ${answer.text}`);
  const envelope = answer.json();
  assert.equal(envelope?.error?.code, "EDGE_ORIGIN_UNAVAILABLE", label);
  assert.match(envelope.error.requestId, UUID_V4, label);
  assert.equal(answer.header("retry-after"), "60", label);
  assert.equal(answer.header("cache-control"), "no-store", label);
  const lines = instance.warnLines().filter((line) => line.includes(envelope.error.requestId));
  assert.equal(lines.length, 1, `${label}: one warn line`);
  const line = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(line).sort(), UPSTREAM_LOG_KEYS, label);
  assert.equal(line.event, "edge_upstream_unavailable", label);
  assert.equal(line.code, code, label);
  for (const forbidden of ["tibotattle", "run.app", "http", "Bearer", ...(ip === null ? [] : [ip])]) {
    assert.ok(!lines[0].includes(forbidden), `${label}: the log line names no ${forbidden}`);
  }
}

test("S6 failures: network, headers timeout, token failure and unmarked answers are 503 EDGE_ORIGIN_UNAVAILABLE", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const path = `${EDGE_E2E_PUBLIC_ORIGIN}/api/v1/envelope-key`;
  try {
    // The origin is gone: the front end cannot connect and the edge sees a network failure.
    f.frontEnd.setOrigin(loopbackOrigin(await freePort()));
    let ip = nextIp();
    assertUpstreamUnavailable(await f.edge.fetch(path, { ip }), f.edge, "EDGE_UPSTREAM_NETWORK", "origin stopped", { ip });
    f.frontEnd.setOrigin(loopbackOrigin(f.origin.port));

    // Headers later than EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS (5 s).
    f.frontEnd.setHooks({ delayHeadersMs: 6_500 });
    ip = nextIp();
    const started = performance.now();
    const slow = await f.edge.fetch(path, { ip });
    assert.ok(performance.now() - started < 6_400, "the edge stops waiting at its headers timeout");
    assertUpstreamUnavailable(slow, f.edge, "EDGE_UPSTREAM_TIMEOUT", "headers timeout", { ip });
    f.frontEnd.clearHooks();

    // Unmarked answers from Google's front end (or anything that is not the origin).
    for (const [status, extra] of [[401, {}], [403, {}], [429, { "retry-after": "1" }], [503, {}],
      [302, { location: "https://accounts.google.com/" }]]) {
      f.frontEnd.setHooks({ respondInstead: () => ({ status, headers: { "content-type": "text/html", ...extra },
        body: `<html>${status}</html>` }) });
      ip = nextIp();
      const answer = await f.edge.fetch(path, { ip });
      assertUpstreamUnavailable(answer, f.edge, "EDGE_UPSTREAM_UNMARKED", `unmarked ${status}`, { ip });
      assert.equal(answer.header("location"), null, `unmarked ${status}: no redirect is passed on`);
    }
    // A marked origin 500 is the origin's answer and passes through byte for byte.
    const marked = "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"requestId\":\"00000000-0000-4000-8000-000000000500\"}}";
    f.frontEnd.setHooks({ respondInstead: () => ({ status: 500, headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "x-tibotattle-origin": "1" }, body: marked }) });
    const mark = f.frontEnd.mark();
    const passed = await f.edge.fetch(path, { ip: nextIp() });
    assert.equal(passed.status, 500);
    assert.equal(passed.text, marked);
    assert.deepEqual(transparencyMismatches(f, passed, f.frontEnd.since(mark)[0]), []);
    f.frontEnd.clearHooks();
  } finally {
    f.frontEnd.clearHooks();
    f.frontEnd.setOrigin(loopbackOrigin(f.origin.port));
  }

  // A token endpoint failure, in a fresh isolate (the main edge holds a cached token).
  const tokenFrontEnd = createGoogleFrontEnd({ invoker: f.invoker, verifiers: [EDGE_E2E_VERIFIER],
    audience: EDGE_E2E_AUDIENCE, upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(f.origin.port) });
  tokenFrontEnd.setHooks({ tokenEndpointStatus: 500 });
  const tokenEdge = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd: tokenFrontEnd,
    invokerKeyJson: f.invoker.keyJson });
  disposers.push(() => tokenEdge.dispose());
  const ip = nextIp();
  assertUpstreamUnavailable(await tokenEdge.fetch(path, { ip }), tokenEdge, "EDGE_TOKEN_UNAVAILABLE", "token 500", { ip });
  assert.equal(tokenFrontEnd.exchanges.length, 0, "nothing is forwarded without a token");
  // The negative cache: a second request within ten seconds does not ask again.
  const asked = tokenFrontEnd.tokenRequests.length;
  assertUpstreamUnavailable(await tokenEdge.fetch(path, { ip: nextIp() }), tokenEdge, "EDGE_TOKEN_UNAVAILABLE",
    "token negative cache");
  assert.equal(tokenFrontEnd.tokenRequests.length, asked, "the failed exchange is not retried at once");

  // A client that goes away cancels the edge's subrequest.
  f.frontEnd.setHooks({ delayHeadersMs: 3_000 });
  try {
    const controller = new AbortController();
    const mark = f.frontEnd.mark();
    const pending = f.edge.fetch(path, { ip: nextIp(), signal: controller.signal }).catch((error) => error);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    controller.abort();
    await pending;
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_500));
    const [exchange] = f.frontEnd.since(mark);
    assert.ok(exchange !== undefined, "the request reached the front end");
    f.rows.push({ stage: "S6", id: "client-disconnect", edgeClosedEarly: exchange.edgeClosedEarly === true });
  } finally {
    f.frontEnd.clearHooks();
  }
});

// ---------------------------------------------------------------------------
// S8: the Sparkle appcast guard stays at the edge

test("S8 guard: a signed appcast POST equals the Worker's; the edge writes only nonce rows; replay refused equally", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const request = await f.sparkle.guardRequest({ version: "1" });
  const mark = f.frontEnd.mark();
  const url = `${EDGE_E2E_PUBLIC_ORIGIN}${request.path}`;
  const ip = nextIp();
  const edgeAnswer = await f.edge.fetch(url, { method: "POST", headers: request.headers, body: request.body, ip });
  const referenceAnswer = await f.reference.fetch(url, { method: "POST", headers: request.headers, body: request.body, ip });
  assert.equal(edgeAnswer.status, 200, edgeAnswer.text);
  assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer, { bodyEqual: false }), []);
  const mask = (text) => text.replace(/"(?:etag|uploaded|httpEtag|requestId)":"[^"]*"/gu, "\"<masked>\"");
  assert.equal(mask(edgeAnswer.text), mask(referenceAnswer.text));
  for (const bucket of [f.edge.sparkleBucket, f.reference.sparkleBucket]) {
    const appcast = await bucket.get(f.sparkle.contract.appcastObjectKey);
    assert.ok(appcast !== null, "the appcast was written");
  }
  const edgeAppcast = await (await f.edge.sparkleBucket.get(f.sparkle.contract.appcastObjectKey)).text();
  const referenceAppcast = await (await f.reference.sparkleBucket.get(f.sparkle.contract.appcastObjectKey)).text();
  assert.equal(edgeAppcast, referenceAppcast);
  const tables = await f.edge.guardDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' "
    + "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name").all();
  assert.deepEqual(tables.results.map((table) => table.name), ["sparkle_appcast_guard_nonces"]);
  const nonces = await f.edge.guardDb.prepare("SELECT count(*) AS n FROM sparkle_appcast_guard_nonces").first();
  assert.equal(nonces.n, 1);
  // The same signed request again is a replay on both sides.
  const edgeReplay = await f.edge.fetch(url, { method: "POST", headers: request.headers, body: request.body, ip });
  const referenceReplay = await f.reference.fetch(url, { method: "POST", headers: request.headers, body: request.body, ip });
  assert.deepEqual(workerMismatches(edgeReplay, referenceReplay, {}), []);
  assert.equal(edgeReplay.status, 401);
  assert.equal(errorEnvelope(edgeReplay)?.code, "SPARKLE_APPCAST_GUARD_REPLAY_INVALID");
  assert.equal(f.frontEnd.since(mark).length, 0, "the guard never leaves the edge");
  f.rows.push({ stage: "S8", id: "sparkle-guard", status: edgeAnswer.status, exchanges: 0 });
});

// ---------------------------------------------------------------------------
// S10: detector controls

test("S10 detectors: each injected fault is caught, and the same row passes once the fault is removed", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const upload = { "content-type": "application/json", authorization: UNKNOWN_UPLOAD_BEARER };
  const contributionRow = { id: "detector-contributions", routeId: "contributions", host: "apex", method: "POST",
    path: "/api/v1/contributions", headers: upload, body: "{\"schemaVersion\":\"telemetry-envelope-v1.1\"}",
    comparators: [] };
  const healthRow = { id: "detector-envelope-key", routeId: "envelope_key", host: "apex", method: "GET",
    path: "/api/v1/envelope-key", headers: {}, comparators: [] };
  const send = async (row) => {
    const { url, options } = materialize(row, f);
    const ip = nextIp();
    const mark = f.frontEnd.mark();
    const edgeAnswer = await f.edge.fetch(url, { ...options, ip });
    const referenceAnswer = await f.reference.fetch(url, { ...options, ip });
    return { edgeAnswer, referenceAnswer, exchanges: f.frontEnd.since(mark) };
  };
  try {
    // (a) The admission purpose is rewritten in transit: the origin refuses the
    // replay, and the Worker comparator reports the difference.
    f.frontEnd.setHooks({ requestHeaders: (headers) => {
      if (headers["x-tibotattle-edge-admission"] === "v1;upload_ingress;allowed") {
        headers["x-tibotattle-edge-admission"] = "v1;device_sync;allowed";
      }
    } });
    const rewritten = await send(contributionRow);
    assert.equal(rewritten.edgeAnswer.status, 503);
    assert.equal(errorEnvelope(rewritten.edgeAnswer)?.code, "UPLOAD_INGRESS_UNAVAILABLE");
    assert.notDeepEqual(workerMismatches(rewritten.edgeAnswer, rewritten.referenceAnswer), [],
      "the Worker comparator detects the rewritten admission");
    f.frontEnd.clearHooks();
    const clean = await send(contributionRow);
    assert.deepEqual(workerMismatches(clean.edgeAnswer, clean.referenceAnswer), []);

    // (b) The origin marker is stripped: the edge refuses the unmarked answer.
    f.frontEnd.setHooks({ responseHeaders: (pairs) => pairs.filter(([name]) => name !== "x-tibotattle-origin") });
    const stripped = await send(healthRow);
    assertUpstreamUnavailable(stripped.edgeAnswer, f.edge, "EDGE_UPSTREAM_UNMARKED", "marker stripped");
    f.frontEnd.clearHooks();
    assert.equal((await send(healthRow)).edgeAnswer.status, 200);

    // (c) A client-key header is injected: EP-6 refuses with its 421 and the edge maps it.
    f.frontEnd.setHooks({ requestHeaders: (headers) => { headers["x-tibotattle-edge-client-key"] = "0".repeat(64); } });
    const injected = await send(healthRow);
    assert.equal(injected.exchanges[0].originStatus, 421);
    assertUpstreamUnavailable(injected.edgeAnswer, f.edge, "EDGE_UPSTREAM_UNMARKED", "client key injected");
    f.frontEnd.clearHooks();
    assert.equal((await send(healthRow)).edgeAnswer.status, 200);

    // (d) The token names an account Cloud Run IAM does not admit: Google's unmarked 403.
    f.frontEnd.setHooks({ iamRemoved: [EDGE_E2E_INVOKER] });
    const unknown = await send(healthRow);
    assert.equal(unknown.exchanges[0].outcome, "front_end_403");
    assertUpstreamUnavailable(unknown.edgeAnswer, f.edge, "EDGE_UPSTREAM_UNMARKED", "unknown email");
    f.frontEnd.clearHooks();
    assert.equal((await send(healthRow)).edgeAnswer.status, 200);

    // (e) S7 flags an x-real-ip that carries the client address, a missing
    // one and a repeated one; the recorded exchange itself passes.
    const ip = nextIp();
    const { url, options } = materialize(healthRow, f);
    const mark = f.frontEnd.mark();
    assert.equal((await f.edge.fetch(url, { ...options, ip })).status, 200);
    const [recorded] = f.frontEnd.since(mark);
    assert.deepEqual(privacyViolations(f, recorded, { ip }), []);
    const realIp = f.m.subrequest.EDGE_SUBREQUEST_REAL_IP_HEADER;
    const withHeaders = (requestHeaders) => ({ ...recorded, requestHeaders });
    const others = recorded.requestHeaders.filter(([name]) => name !== realIp);
    assert.ok(privacyViolations(f, withHeaders([...others, [realIp, ip]]), { ip })
      .includes("x-real-ip is not the placeholder"));
    assert.ok(privacyViolations(f, withHeaders(others), { ip }).includes("x-real-ip sent 0 times"));
    assert.ok(privacyViolations(f, withHeaders([...recorded.requestHeaders, [realIp, f.m.subrequest.EDGE_SUBREQUEST_REAL_IP]]), { ip })
      .includes("x-real-ip sent 2 times"));
  } finally {
    f.frontEnd.clearHooks();
  }
});

// ---------------------------------------------------------------------------
// S4: admission under the checked-in production limits

const WINDOW_MS = 60_000;
const windowIndex = () => Math.floor(Date.now() / WINDOW_MS);
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

/** Starts the next fixed one-minute window when fewer than `needMs` remain in this one. */
async function windowWithRoom(needMs) {
  const remaining = WINDOW_MS - (Date.now() % WINDOW_MS);
  if (remaining < needMs) await sleep(remaining + 150);
}

const S4_CONTRIBUTION_BODY = "{\"schemaVersion\":\"telemetry-envelope-v1.1\"}";

/** One request to the edge and then the reference from the same address; checks transparency and S7. */
async function pairOnce(f, row, { edge, reference, ip, compare = true, concurrent = false }) {
  const { url, options } = materialize(row, f);
  const mark = f.frontEnd.mark();
  const edgeAnswer = await edge.fetch(url, { ...options, ip });
  // Concurrent sends share the front end: each request is matched to its own
  // exchange by its (per-request random) authorization header.
  const exchanges = concurrent
    ? f.frontEnd.since(mark).filter((exchange) => exchange.requestHeaders
      .some(([name, value]) => name === "authorization" && value === options.headers.authorization))
    : f.frontEnd.since(mark);
  if (concurrent) assert.equal(exchanges.length, 1, `${row.id}: one exchange for this request`);
  for (const exchange of exchanges) {
    assert.deepEqual(transparencyMismatches(f, edgeAnswer, exchange), [], `${row.id}: transparency`);
    assert.deepEqual(privacyViolations(f, exchange, { ip }), [], `${row.id}: S7 privacy`);
    f.allExchanges.push({ exchange, ip, row: row.id });
  }
  const referenceAnswer = compare ? await reference.fetch(url, { ...options, ip }) : null;
  return { edgeAnswer, referenceAnswer, exchanges };
}

function admissionOf(exchanges) {
  const header = exchanges[0]?.requestHeaders.find(([name]) => name === "x-tibotattle-edge-admission");
  return header?.[1] ?? null;
}

/**
 * Sends `row` pairwise from one address until the Worker answers 429 (at most
 * `bound` times). Every pair must match; the last must be the limiter's 429.
 * A run that straddles a window boundary and mismatches is retried once from
 * a fresh address in a fresh window.
 */
async function untilLimited(f, row, { edge, reference, bound, limitedCode, expectedAllowed = null }) {
  const attempt = async (ip) => {
    const startWindow = windowIndex();
    const pairs = [];
    for (let index = 1; index <= bound; index += 1) {
      const { edgeAnswer, referenceAnswer, exchanges } = await pairOnce(f, row, { edge, reference, ip });
      // A limited pair must match in full; an admitted pair must match on the
      // verdict (status, retry-after, error envelope). The admitted 200 of
      // community/daily is content from two different stores: the reference's
      // json-mode D1 reports allowanceReadState confirmed with no preview (public,
      // max-age=300), the origin and production's typed read temporarily_unavailable
      // (no-store).
      const limited = referenceAnswer.status === 429 || edgeAnswer.status === 429;
      pairs.push({ index, edgeAnswer, referenceAnswer, admission: admissionOf(exchanges),
        mismatches: limited ? workerMismatches(edgeAnswer, referenceAnswer) : verdictMismatches(edgeAnswer, referenceAnswer) });
      if (referenceAnswer.status === 429) break;
    }
    return { pairs, straddled: windowIndex() !== startWindow };
  };
  let run = await attempt(nextIp());
  const failed = (candidate) => candidate.pairs.some((pair) => pair.mismatches.length > 0)
    || candidate.pairs.at(-1).referenceAnswer.status !== 429
    || (expectedAllowed !== null && candidate.pairs.length !== expectedAllowed + 1);
  if (failed(run) && run.straddled) {
    await windowWithRoom(WINDOW_MS);
    run = await attempt(nextIp());
  }
  for (const pair of run.pairs) {
    assert.deepEqual(pair.mismatches, [], `${row.id} pair ${pair.index}`);
  }
  const last = run.pairs.at(-1);
  assert.equal(last.referenceAnswer.status, 429, `${row.id}: the Worker limits within ${bound}`);
  assert.equal(last.edgeAnswer.status, 429, `${row.id}: the edge limits on the same request`);
  assert.equal(errorEnvelope(last.edgeAnswer)?.code, limitedCode, row.id);
  assert.equal(last.edgeAnswer.header("retry-after"), "60", row.id);
  assert.equal(last.edgeAnswer.header("cache-control"), "no-store", row.id);
  if (expectedAllowed !== null) {
    assert.equal(run.pairs.length, expectedAllowed + 1, `${row.id}: limited exactly after ${expectedAllowed}`);
    assert.ok(run.pairs.slice(0, -1).every((pair) => pair.admission?.endsWith(";allowed")), `${row.id}: allowed first`);
    assert.ok(last.admission?.endsWith(";limited"), `${row.id}: the limited verdict travels to the origin`);
  }
  f.rows.push({ stage: "S4", id: row.id, pairs: run.pairs.length, retried: run.straddled });
  return run.pairs.length;
}

/** Concurrent pairwise sends of `count` requests, each from its own or a shared address. */
async function burst(f, row, { edge, reference, count, ip = null, concurrency = 24, compareFirst = count }) {
  const answers = [];
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      const { edgeAnswer, referenceAnswer } = await pairOnce(f, row, {
        edge, reference, ip: ip ?? nextIp(), compare: index < compareFirst, concurrent: concurrency > 1,
      });
      answers[index] = { edgeAnswer, referenceAnswer };
    }
  });
  await Promise.all(workers);
  return answers;
}

test("S4 admission: every EP-1 policy route the origin serves is limited exactly as the Worker at the production limits", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const limits = await readCheckedInProductionLimits(WORKER_ROOT);
  assert.deepEqual(limits, {
    ENROLLMENT_RATE_LIMIT: 20, RECOVERY_RATE_LIMIT: 20, CLIENT_ATTEMPT_RATE_LIMIT: 5, PUBLIC_READ_RATE_LIMIT: 120,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: 3000, UPLOAD_PRINCIPAL_RATE_LIMIT: 3000,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: 3000, UPLOAD_INGRESS_CLIENT_RATE_LIMIT: 3000,
  }, "the checked-in env.production limits");
  const edge = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd: f.frontEnd,
    invokerKeyJson: f.invoker.keyJson, limits });
  disposers.push(() => edge.dispose());
  const reference = await createReferenceInstance({ ...f.common, envelope: f.keys, limits });
  disposers.push(() => reference.dispose());
  const pair = { edge, reference };
  const registry = f.m.registry.WORKER_ROUTE_POLICY;
  const rows = admissionRows({ registry, policyFor: f.m.policy.edgeAdmissionPolicyFor,
    servedRouteIds: f.m.composition.POSTGRES_PORTED_WORKER_ROUTE_IDS })
    .map((row) => (row.routeId === "contributions" ? { ...row, body: S4_CONTRIBUTION_BODY } : row));
  const byRoute = (routeId, method = null) => rows.find((row) => row.routeId === routeId
    && (method === null || row.method === method));
  const attemptBound = limits.CLIENT_ATTEMPT_RATE_LIMIT + 2;

  // A. One route per purpose, in one window: the client limit trips exactly after its value.
  await windowWithRoom(30_000);
  for (const routeId of ["accountless_enrollment", "accountless_ownership", "accountless_renewal", "device_disconnect",
    "device_credential_renew", "device_sync_state"]) {
    await untilLimited(f, byRoute(routeId), { ...pair, bound: attemptBound, limitedCode: "ATTEMPT_LIMIT_REACHED",
      expectedAllowed: limits.CLIENT_ATTEMPT_RATE_LIMIT });
  }
  await untilLimited(f, byRoute("community_daily"), { ...pair, bound: limits.PUBLIC_READ_RATE_LIMIT + 2,
    limitedCode: "ATTEMPT_LIMIT_REACHED", expectedAllowed: limits.PUBLIC_READ_RATE_LIMIT });

  // B. Every other attempt-limited route: pairwise equal until the Worker limits.
  for (const row of rows) {
    if (row.purpose === "upload_ingress") continue;
    const bound = row.purpose === "public_aggregate_read" ? limits.PUBLIC_READ_RATE_LIMIT + 2 : attemptBound;
    await windowWithRoom(10_000);
    await untilLimited(f, row, { ...pair, bound, limitedCode: "ATTEMPT_LIMIT_REACHED" });
  }

  // C. The d43c8f92 order rows while limited (EORIGIN's fixes), and an upload authorization that is never limited.
  await windowWithRoom(20_000);
  const limitedIp = nextIp();
  for (let index = 0; index < limits.CLIENT_ATTEMPT_RATE_LIMIT + 1; index += 1) {
    await pairOnce(f, byRoute("device_sync_state"), { ...pair, ip: limitedIp });
  }
  for (const [label, row] of [
    ["v1.2 day manifest POST, unknown bearer, limited", byRoute("telemetry_v12_day_manifests", "POST")],
    ["v1.2 day manifest POST with a cookie, limited", { ...byRoute("telemetry_v12_day_manifests", "POST"),
      headers: { ...byRoute("telemetry_v12_day_manifests", "POST").headers, cookie: MATRIX_VALUES.unrelatedCookie } }],
  ]) {
    const { edgeAnswer, referenceAnswer } = await pairOnce(f, { ...row, id: label }, { ...pair, ip: limitedIp });
    assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer), [], label);
    assert.equal(edgeAnswer.status, 429, label);
  }
  const renewIp = nextIp();
  for (let index = 0; index < limits.CLIENT_ATTEMPT_RATE_LIMIT; index += 1) {
    await pairOnce(f, byRoute("device_credential_renew"), { ...pair, ip: renewIp });
  }
  const renew = await pairOnce(f, { ...byRoute("device_credential_renew"), id: "renew with a cookie, limited",
    headers: { ...byRoute("device_credential_renew").headers, cookie: MATRIX_VALUES.sessionCookie } }, { ...pair, ip: renewIp });
  assert.deepEqual(workerMismatches(renew.edgeAnswer, renew.referenceAnswer), []);
  assert.equal(renew.edgeAnswer.status, 429);
  const uploadAuthorizationIp = nextIp();
  for (let index = 0; index < limits.CLIENT_ATTEMPT_RATE_LIMIT * 3; index += 1) {
    const { edgeAnswer, referenceAnswer, exchanges } = await pairOnce(f, {
      id: "device upload authorization", routeId: "device_upload_authorization", host: "apex", method: "POST",
      path: "/api/v1/device/upload-authorizations",
      headers: { "content-type": "application/json", authorization: UNKNOWN_DEVICE_BEARER }, body: "{}",
      comparators: [] }, { ...pair, ip: uploadAuthorizationIp });
    assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer), []);
    assert.notEqual(edgeAnswer.status, 429, "the edge never limits upload authorization");
    assert.equal(admissionOf(exchanges), null, "upload authorization carries no admission verdict");
  }

  // D. Coarse exhaustion with many addresses, in a fresh window.
  await windowWithRoom(WINDOW_MS);
  for (const [routeId, coarse] of [["device_disconnect", limits.RECOVERY_RATE_LIMIT],
    ["accountless_enrollment", limits.ENROLLMENT_RATE_LIMIT]]) {
    const answers = [];
    for (let index = 0; index <= coarse; index += 1) {
      const { edgeAnswer, referenceAnswer } = await pairOnce(f, byRoute(routeId), { ...pair, ip: nextIp() });
      assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer), [], `${routeId} coarse ${index + 1}`);
      answers.push(edgeAnswer.status);
    }
    assert.ok(answers.slice(0, coarse).every((status) => status !== 429), `${routeId}: ${coarse} addresses admitted`);
    assert.equal(answers.at(-1), 429, `${routeId}: address ${coarse + 1} meets the coarse limit`);
    f.rows.push({ stage: "S4", id: `coarse-${routeId}`, pairs: answers.length });
  }

  // E. Upload ingress at the production limits. The Worker's own upload budget
  // (a Durable Object: 1200 starts per minute, burst 1200) refuses before its
  // 3000/60 address limiters can, and the origin now takes the same shared
  // lease over its PostgreSQL budget with the same values (D-CRB), so it
  // refuses there too. The first 1000 pairs are compared with the Worker.
  // The rest pins the origin's budget to its configured size through the
  // budget's own accounting. The burst starts on a full budget (it waits for
  // the refill first). From the first start on, each start takes one token
  // and the configured rate refills startsPerMinute / 60 000 tokens per
  // millisecond of the database clock the budget keeps, so after the burst
  //   claims = burst - tokens left + rate * (last update - first start).
  // The first start comes after the start reading, and within
  // FIRST_START_ALLOWANCE_MS of it; claims outside the range that gives mean
  // another burst size or rate. The burst must also outrun the refill, so
  // the budget refuses, and every other request is the budget's 429. A
  // missing, unlimited or wrongly sized budget fails. Then the edge's own
  // address limiter is checked alone: 3000 forwarded from one address and
  // the 3001st limited at the edge.
  const ingressVars = await readSanitizedProductionVars(WORKER_ROOT);
  const ingressBurst = Number(ingressVars.UPLOAD_INGRESS_BURST);
  const startsPerMinute = Number(ingressVars.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE);
  assert.ok(Number.isSafeInteger(ingressBurst) && ingressBurst >= 1_000 && ingressBurst < limits.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    "the checked-in burst lies between the compared pairs and the address limit");
  assert.ok(Number.isSafeInteger(startsPerMinute) && startsPerMinute > 0);
  const budgetName = f.m.ingressBudget.POSTGRES_UPLOAD_INGRESS_BUDGET_NAME;
  /** The budget's start tokens now (its own refill rule, capped at the burst) and the database clock. */
  const ingressBudgetNow = async () => {
    const clock = (await f.base.query(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now_ms")).rows[0].now_ms;
    const row = (await f.base.query(`SELECT tokens::float8 AS tokens,
        floor(extract(epoch FROM updated_at)*1000)::float8 AS updated_ms
      FROM ${f.t("upload_ingress_budget_states")} WHERE budget_name=$1`, [budgetName])).rows[0];
    // No row yet: the first acquire creates the budget full.
    const tokens = row === undefined ? ingressBurst
      : Math.min(ingressBurst, row.tokens + ((clock - row.updated_ms) * startsPerMinute) / 60_000);
    return { tokens, nowMs: clock };
  };
  const beforeRefill = await ingressBudgetNow();
  if (beforeRefill.tokens < ingressBurst) {
    await sleep(Math.ceil(((ingressBurst - beforeRefill.tokens) * 60_000) / startsPerMinute) + 250);
  }
  await windowWithRoom(WINDOW_MS);
  const ingressStart = await ingressBudgetNow();
  assert.equal(ingressStart.tokens, ingressBurst, "the burst starts on a full budget");
  const ingressIp = nextIp();
  const ingressRow = { ...byRoute("contributions"), id: "contributions at the production limit" };
  const answers = await burst(f, ingressRow, { ...pair, count: limits.UPLOAD_INGRESS_CLIENT_RATE_LIMIT, ip: ingressIp,
    compareFirst: 1_000 });
  const ingressEnd = (await f.base.query(`SELECT tokens::float8 AS tokens,
      floor(extract(epoch FROM updated_at)*1000)::float8 AS updated_ms
    FROM ${f.t("upload_ingress_budget_states")} WHERE budget_name=$1`, [budgetName])).rows[0];
  assert.ok(ingressEnd !== undefined, "the burst went through the origin's budget");
  const claimed = answers.filter(({ edgeAnswer }) => edgeAnswer.status === 401).length;
  const budgetRefused = answers.filter(({ edgeAnswer }) => edgeAnswer.status === 429
    && errorEnvelope(edgeAnswer)?.code === "UPLOAD_INGRESS_LIMIT_REACHED").length;
  assert.equal(claimed + budgetRefused, answers.length,
    "3000 forwarded: each admitted to the claim or refused by the shared ingress budget");
  assert.ok(budgetRefused >= 1, "the burst outran the budget's refill, so the budget refused");
  const FIRST_START_ALLOWANCE_MS = 2_000;
  const burstMs = ingressEnd.updated_ms - ingressStart.nowMs;
  const tokensPerMs = startsPerMinute / 60_000;
  const mostClaims = ingressBurst - ingressEnd.tokens + tokensPerMs * burstMs;
  const leastClaims = mostClaims - tokensPerMs * FIRST_START_ALLOWANCE_MS;
  // One start of slack either way for the budget's millisecond clock.
  assert.ok(claimed <= Math.floor(mostClaims) + 1 && claimed >= Math.ceil(leastClaims) - 1,
    `claimed ${claimed} in ${burstMs} ms: a ${ingressBurst} burst at ${startsPerMinute} a minute allows `
    + `${leastClaims.toFixed(1)} to ${mostClaims.toFixed(1)}`);
  for (const [index, { edgeAnswer, referenceAnswer }] of answers.slice(0, 1_000).entries()) {
    assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer), [], `ingress pair ${index + 1}`);
  }
  const over = await pairOnce(f, ingressRow, { ...pair, ip: ingressIp, compare: false });
  assert.equal(over.edgeAnswer.status, 429);
  assert.equal(errorEnvelope(over.edgeAnswer)?.code, "UPLOAD_INGRESS_LIMIT_REACHED");
  assert.equal(over.edgeAnswer.header("retry-after"), "60");
  assert.ok(admissionOf(over.exchanges)?.endsWith(";limited"));
  f.rows.push({ stage: "S4", id: "ingress-production-edge", pairs: answers.length + 1, compared: 1_000,
    claimed, budgetRefused, burstMs });

  // F. Request-only refusals spend no budget, as in the Worker, where they come
  // before its limiter: from one address, more refused requests than the
  // client limit, then a request each side admits.
  await windowWithRoom(WINDOW_MS);
  const enrollment = byRoute("accountless_enrollment");
  const cookieIp = nextIp();
  for (let index = 0; index < limits.CLIENT_ATTEMPT_RATE_LIMIT + 2; index += 1) {
    const refused = await pairOnce(f, { ...enrollment, id: "accountless enrollment with a session cookie",
      headers: { ...enrollment.headers, cookie: MATRIX_VALUES.sessionCookie } }, { ...pair, ip: cookieIp });
    assert.deepEqual(workerMismatches(refused.edgeAnswer, refused.referenceAnswer), [], `cookie ${index + 1}`);
    assert.equal(errorEnvelope(refused.edgeAnswer)?.code, "AUTH_INVALID");
    assert.equal(refused.exchanges.length, 0, "answered at the edge");
  }
  const afterCookies = await pairOnce(f, { ...enrollment, id: "accountless enrollment after refused ones" },
    { ...pair, ip: cookieIp });
  assert.deepEqual(verdictMismatches(afterCookies.edgeAnswer, afterCookies.referenceAnswer), []);
  assert.notEqual(afterCookies.edgeAnswer.status, 429);
  assert.equal(admissionOf(afterCookies.exchanges), "v1;enrollment;allowed");
  // enroll is not served by the test origin, so its admitted request is
  // checked by its admission verdict alone.
  const enroll = registry.find((route) => route.id === "enroll");
  const foreignRow = { id: "enroll from a foreign origin", routeId: "enroll", host: "apex", method: "POST",
    path: enroll.pathname, headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}",
    comparators: [] };
  const foreignIp = nextIp();
  for (let index = 0; index < limits.CLIENT_ATTEMPT_RATE_LIMIT + 2; index += 1) {
    const refused = await pairOnce(f, foreignRow, { ...pair, ip: foreignIp });
    assert.deepEqual(workerMismatches(refused.edgeAnswer, refused.referenceAnswer), [], `foreign ${index + 1}`);
    assert.equal(errorEnvelope(refused.edgeAnswer)?.code, "CSRF_INVALID");
    assert.equal(refused.exchanges.length, 0, "answered at the edge");
  }
  const sameOrigin = await pairOnce(f, { ...foreignRow, id: "enroll same-origin after refused ones",
    headers: { "content-type": "application/json", origin: SAME_ORIGIN } }, { ...pair, ip: foreignIp, compare: false });
  assert.notEqual(sameOrigin.edgeAnswer.status, 429);
  assert.equal(admissionOf(sameOrigin.exchanges), "v1;enrollment;allowed");
  f.rows.push({ stage: "S4", id: "refusals-spend-no-attempt-budget", refused: 2 * (limits.CLIENT_ATTEMPT_RATE_LIMIT + 2) });
});

test("S4 ingress: a pair with 100/60 ingress limits shows the client, coarse, preflight and held-body rows equal the Worker", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  const production = await readCheckedInProductionLimits(WORKER_ROOT);
  const limits = { ...production, UPLOAD_INGRESS_REQUEST_RATE_LIMIT: 100, UPLOAD_INGRESS_CLIENT_RATE_LIMIT: 100 };
  const edge = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd: f.frontEnd,
    invokerKeyJson: f.invoker.keyJson, limits });
  disposers.push(() => edge.dispose());
  const reference = await createReferenceInstance({ ...f.common, envelope: f.keys, limits });
  disposers.push(() => reference.dispose());
  const pair = { edge, reference };
  const row = { id: "contributions-ingress", routeId: "contributions", host: "apex", method: "POST",
    path: "/api/v1/contributions", headers: { "content-type": "application/json", authorization: UNKNOWN_UPLOAD_BEARER },
    body: S4_CONTRIBUTION_BODY, comparators: ["worker"] };
  await windowWithRoom(30_000);
  await untilLimited(f, row, { ...pair, bound: 102, limitedCode: "UPLOAD_INGRESS_LIMIT_REACHED", expectedAllowed: 100 });
  // While the address is limited, the preflight still answers first (401 for a malformed header).
  const limitedIp = nextIp();
  for (let index = 0; index < 100; index += 1) await pairOnce(f, row, { ...pair, ip: limitedIp });
  const malformed = await pairOnce(f, { ...row, id: "malformed upload, limited",
    headers: { ...row.headers, authorization: MATRIX_VALUES.malformedUpload } }, { ...pair, ip: limitedIp });
  assert.deepEqual(workerMismatches(malformed.edgeAnswer, malformed.referenceAnswer), []);
  assert.equal(malformed.edgeAnswer.status, 401);
  // A valid-shape upload while limited, with the body held open for 2 s. The
  // origin answers 429 before reading it (the front end records the answer
  // while the body is still arriving), and so does the Worker. workerd hands
  // the edge's answer to the client only once the client's body has finished
  // streaming into the subrequest, so the edge's 429 arrives after the hold.
  const holdMs = 2_000;
  const heldUpload = (instance) => {
    const held = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"schemaVersion\":"));
      setTimeout(() => { try { controller.close(); } catch { /* closed */ } }, holdMs);
    } });
    return instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}/api/v1/contributions`, { method: "POST", ip: limitedIp,
      headers: { "content-type": "application/json", authorization: `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}` },
      body: held });
  };
  const heldMark = f.frontEnd.mark();
  let started = performance.now();
  const referenceHeld = await heldUpload(reference);
  const referenceMs = performance.now() - started;
  started = performance.now();
  const edgeHeld = await heldUpload(edge);
  const edgeMs = performance.now() - started;
  const [heldExchange] = f.frontEnd.since(heldMark);
  assert.equal(referenceHeld.status, 429);
  assert.ok(referenceMs < holdMs / 2, `the Worker answers before the body ends (${Math.round(referenceMs)} ms)`);
  assert.equal(heldExchange.originStatus, 429);
  assert.equal(heldExchange.earlyAnswer, true, "the origin answered while the body was still arriving");
  assert.deepEqual(workerMismatches(edgeHeld, referenceHeld), []);
  assert.equal(errorEnvelope(edgeHeld)?.code, "UPLOAD_INGRESS_LIMIT_REACHED");
  f.rows.push({ stage: "S4", id: "held-body-limited", workerMs: Math.round(referenceMs), edgeMs: Math.round(edgeMs),
    holdMs, originAnsweredEarly: heldExchange.earlyAnswer === true });
  // Refused uploads spend no ingress budget, as in the Worker, whose preflight
  // precedes its limiter: more refusals from one address than the 100/60
  // client limit, then a well-formed upload that both sides admit.
  await windowWithRoom(WINDOW_MS);
  const refusedIp = nextIp();
  const refusals = [
    ["no Upload header", { "content-type": "application/json" }, 401],
    ["session cookie", { ...row.headers, cookie: MATRIX_VALUES.sessionCookie }, 401],
    ["text/plain", { ...row.headers, "content-type": "text/plain" }, 415],
  ];
  for (let index = 0; index < 102; index += 1) {
    const [label, headers, status] = refusals[index % refusals.length];
    const refused = await pairOnce(f, { ...row, id: `refused upload: ${label}`, headers }, { ...pair, ip: refusedIp });
    assert.deepEqual(workerMismatches(refused.edgeAnswer, refused.referenceAnswer), [], label);
    assert.equal(refused.edgeAnswer.status, status, label);
    assert.equal(refused.exchanges.length, 0, `${label}: answered at the edge`);
  }
  const afterRefusals = await pairOnce(f, { ...row, id: "upload after refused ones" }, { ...pair, ip: refusedIp });
  assert.deepEqual(workerMismatches(afterRefusals.edgeAnswer, afterRefusals.referenceAnswer), []);
  assert.notEqual(afterRefusals.edgeAnswer.status, 429);
  assert.equal(admissionOf(afterRefusals.exchanges), "v1;upload_ingress;allowed");
  f.rows.push({ stage: "S4", id: "refusals-spend-no-ingress-budget", refused: 102 });
  // Coarse: 101 addresses in a fresh window.
  await windowWithRoom(WINDOW_MS);
  const coarse = await burst(f, row, { ...pair, count: 100, concurrency: 10 });
  for (const [index, { edgeAnswer, referenceAnswer }] of coarse.entries()) {
    assert.deepEqual(workerMismatches(edgeAnswer, referenceAnswer), [], `coarse ${index + 1}`);
    assert.notEqual(edgeAnswer.status, 429);
  }
  const overCoarse = await pairOnce(f, row, { ...pair, ip: nextIp() });
  assert.deepEqual(workerMismatches(overCoarse.edgeAnswer, overCoarse.referenceAnswer), []);
  assert.equal(overCoarse.edgeAnswer.status, 429);
  f.rows.push({ stage: "S4", id: "ingress-coarse-scaled", pairs: 101 });
});

// ---------------------------------------------------------------------------
// S9: the golden community/daily read through the edge (EDGE_E2E_GOLDEN)

const execFileAsync = promisify(execFile);

function familyTable(report) {
  return Object.fromEntries(report.families.map((entry) => [entry.family,
    { expected: entry.expected, compared: entry.compared, equal: entry.equal, diffCount: entry.diffCount }]));
}

const CURRENT_GOLDEN = join(WORKER_ROOT, "analytics-v2-test", "golden");
const S9_MODE_BY_NPM_SCRIPT = Object.freeze({
  "edge:e2e:current-worker-d1": "current-worker-d1",
  "edge:e2e:current-worker-d1-d7": "current-worker-d1-d7",
});
const S9_COMPARISON_MODES = Object.freeze(["historical", "current-worker-d1", "current-worker-d1-d7"]);
export function resolveS9ComparisonMode({ requested, lifecycleEvent, golden, currentGolden = CURRENT_GOLDEN }) {
  const lifecycleMode = S9_MODE_BY_NPM_SCRIPT[lifecycleEvent] ?? null;
  assert.ok(requested === undefined || S9_COMPARISON_MODES.includes(requested),
    "EDGE_E2E_S9_COMPARISON_MODE must name one supported, versioned S9 contract");
  if (requested !== undefined && lifecycleMode !== null) {
    assert.equal(requested, lifecycleMode, "the explicit environment mode agrees with the named local gate");
  }
  const mode = requested ?? lifecycleMode ?? "historical";
  if (mode === "historical") {
    assert.notEqual(golden, currentGolden,
      "the canonical Q-1 corpus requires explicit current-worker-d1 or current-worker-d1-d7 mode");
  } else assert.equal(golden, currentGolden,
    "current Worker modes require the canonical current Q-1 corpus root");
  return mode;
}
const S9_COMPARISON_MODE = resolveS9ComparisonMode({ requested: process.env.EDGE_E2E_S9_COMPARISON_MODE,
  lifecycleEvent: process.env.npm_lifecycle_event, golden: GOLDEN });
const CURRENT_Q1 = S9_COMPARISON_MODE === "current-worker-d1";
const CURRENT_D7 = S9_COMPARISON_MODE === "current-worker-d1-d7";
function assertCurrentS9PostgresAvailable({ mode, socket }) {
  if (mode !== "historical") assert.ok(typeof socket === "string" && socket.length > 0,
    `${mode} cannot be skipped because its PostgreSQL socket profile is required`);
}
assertCurrentS9PostgresAvailable({ mode: S9_COMPARISON_MODE, socket: PG_TEST_SOCKET });
/**
 * Historical/current-v2 only. D7 v3 derives its per-date expectation from the
 * current-source two-case producer and must never inherit a saved golden file.
 */
const PER_DATE_EXPECTED = CURRENT_D7 ? null : process.env.EDGE_E2E_PER_DATE_EXPECTED
  ? resolve(process.env.EDGE_E2E_PER_DATE_EXPECTED)
  : GOLDEN === CURRENT_GOLDEN
    ? join(WORKER_ROOT, "analytics-v2-test", "golden-q1-node", "per-date-expected.json")
    : null;
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const CURRENT_HELPER_PATH = "apps/worker/postgres-test/fixtures/current-q1-d1-reference.mjs";
const CURRENT_D7_HELPER_PATH = "apps/worker/postgres-test/fixtures/current-q1-d7-reference.mjs";
const CURRENT_D7_REQUIRED_SOURCE_PATHS = Object.freeze(["apps/worker/postgres-test/fixtures/current-q1-d1-reference.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d1-recompute.mjs", CURRENT_D7_HELPER_PATH,
  "apps/worker/postgres-test/fixtures/current-q1-d7-recompute.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-contract.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-guardian.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-producer-component.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-case-output.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-case-output.check.mjs",
  "apps/worker/scripts/gcp-fastpath-current-corpus.mjs", "apps/worker/scripts/gcp-fastpath-current-corpus.check.mjs",
  "apps/worker/scripts/current-q1-conflict-proof.mjs", "apps/worker/scripts/current-q1-conflict-proof.check.mjs",
  "apps/worker/scripts/analytics-v2-current-d7-compare.mjs", "apps/worker/scripts/analytics-v2-current-d7-compare.check.mjs",
  "apps/worker/scripts/postgres-ingestion-journal-transfer.mjs",
  "apps/worker/scripts/postgres-ingestion-journal-transfer.check.mjs",
  "apps/worker/scripts/gcp-fastpath-rehearsal.mjs", "apps/worker/scripts/gcp-fastpath-rehearsal.check.mjs",
  "apps/worker/scripts/s9-rehearsal-diagnostics.mjs",
  "apps/worker/postgres-test/edge-origin-e2e.spec.mjs",
  "apps/worker/scripts/current-q1-d7-contract.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-reference.check.mjs"]);
const REHEARSAL_CONTROLLER_PATH = "apps/worker/scripts/gcp-fastpath-rehearsal.mjs";
const CURRENT_MIGRATION_ORDER = Object.freeze(["migrations", "typed-ingestion-migrations",
  "ingestion-bridge-migrations", "typed-v11-admission-migrations", "analytics-migrations",
  "deletion-ledger-migrations", "typed-v1-admission-migrations", "ingestion-isolation-migrations"]);
const CURRENT_GATES = Object.freeze(["importersCompleted", "refreshFirstComplete", "readStatus200",
  "secondRunZeroNewRevisions", "currentWorkerD1ProducerAccepted", "currentWorkerD1ReferenceComplete",
  "currentWorkerD1Equality", "currentCandidateInputsUnchanged", "immutableCorpusDailyConserved"]);
test("S9 requires explicit current modes for the canonical corpus and never infers D7 from its path", () => {
  assert.equal(resolveS9ComparisonMode({ requested: undefined, lifecycleEvent: "edge:e2e:current-worker-d1-d7",
    golden: CURRENT_GOLDEN }), "current-worker-d1-d7");
  assert.equal(resolveS9ComparisonMode({ requested: "current-worker-d1-d7", lifecycleEvent: undefined,
    golden: CURRENT_GOLDEN }), "current-worker-d1-d7");
  assert.equal(resolveS9ComparisonMode({ requested: undefined, lifecycleEvent: undefined,
    golden: "/synthetic/historical-golden" }), "historical");
  assert.throws(() => resolveS9ComparisonMode({ requested: undefined, lifecycleEvent: undefined,
    golden: CURRENT_GOLDEN }), /canonical Q-1 corpus requires explicit/u);
  assert.throws(() => resolveS9ComparisonMode({ requested: "current-worker-d1-d7", lifecycleEvent: undefined,
    golden: null }), /current Q-1 corpus root/u);
  assert.throws(() => resolveS9ComparisonMode({ requested: "historical", lifecycleEvent: undefined,
    golden: CURRENT_GOLDEN }), /canonical Q-1 corpus requires explicit/u);
  assert.throws(() => resolveS9ComparisonMode({ requested: "current-worker-d1-d7", lifecycleEvent: undefined,
    golden: "/synthetic/other-golden" }), /current Worker modes require the canonical current Q-1 corpus root/u);
  assert.throws(() => resolveS9ComparisonMode({ requested: "current-worker-d1", lifecycleEvent: "edge:e2e:current-worker-d1-d7",
    golden: CURRENT_GOLDEN }), /agrees with the named local gate/u);
  assert.throws(() => resolveS9ComparisonMode({ requested: "current-worker-d1-d8", lifecycleEvent: undefined,
    golden: CURRENT_GOLDEN }), /supported, versioned S9 contract/u);
  for (const mode of ["current-worker-d1", "current-worker-d1-d7"]) {
    assert.throws(() => assertCurrentS9PostgresAvailable({ mode, socket: undefined }), /cannot be skipped/u);
  }
  assert.doesNotThrow(() => assertCurrentS9PostgresAvailable({ mode: "historical", socket: undefined }));
});
const SHA256 = /^[a-f0-9]{64}$/u;
const jsonSha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CURRENT_D7_CASE_IDS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const CURRENT_D7_CHILD_DEADLINE_MS = 40 * 60 * 1_000;
const CURRENT_D7_QUALIFICATION_KEYS = Object.freeze(["schemaVersion", "comparisonMode", "decisionId", "caseIds",
  "inputBindingSha256", "inputBindingCaptureContentSha256", "bindingSha256", "referenceContentSha256", "producerAcceptanceContentSha256",
  "contractContentSha256", "caseReceipts", "sidecars", "cleanupPending", "qualifying",
  "establishesNativeExecution", "deadlineMs", "elapsedMs", "pgInputSnapshotsRemoved"]);
const CURRENT_D7_SIDECAR_HASH_KEYS = Object.freeze(["inputBindingCaptureSha256", "referenceSha256", "bindingSha256", "producerAcceptanceSha256",
  "conflictPreservingCaseSha256", "conflictFreePositiveCaseSha256", "contractSha256"]);
const CURRENT_D7_CASE_RECEIPT_KEYS = Object.freeze(["caseId", "schemaVersion", "referenceSha256", "expectationSha256",
  "corpusSha256", "admissionSha256", "sourceInvariantSha256", "pgInputSha256", "actualResponseSha256",
  "bootstrapPreservationSha256", "strictExportSha256", "actualPreviewSha256", "schema", "controlSchema", "currentDay",
  "retainedForS9Cleanup"]);
const CURRENT_D7_CASE_OUTPUT_KEYS = Object.freeze(["schemaVersion", "caseId", "reference", "expectation", "actualResponse",
  "actualPreview", "currentDay", "controllerReceipt"]);
const CURRENT_D7_REFERENCE_HANDOFF_KEYS = Object.freeze(["schemaVersion", "inputBinding", "reference", "binding",
  "acceptance", "cases", "expectations", "expectationSha256", "pgInputs"]);
const CURRENT_D7_INPUT_BINDING_CAPTURE_KEYS = Object.freeze(["schemaVersion", "capturedBeforeProducer", "captureOrdinal",
  "inputBindingSha256", "inputBinding"]);
const CURRENT_D7_SIDECARS = Object.freeze({
  inputBindingCaptureSha256: "current-d7-input-binding-capture",
  referenceSha256: "current-d7-reference",
  bindingSha256: "current-d7-binding",
  producerAcceptanceSha256: "current-d7-producer-acceptance",
  conflictPreservingCaseSha256: "current-d7-conflict-preserving-case",
  conflictFreePositiveCaseSha256: "current-d7-conflict-free-positive-case",
  contractSha256: "current-d7-contract",
});

function exactObjectKeys(value, keys, message) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), message);
}

function validateCurrentD7InputBindingCapture(value) {
  exactObjectKeys(value, CURRENT_D7_INPUT_BINDING_CAPTURE_KEYS,
    "the pre-producer input binding capture has a closed schema");
  assert.equal(value.schemaVersion, "current-q1-d7-input-binding-capture-v1");
  assert.equal(value.capturedBeforeProducer, true,
    "the initial source/runtime binding was captured before producer invocation");
  assert.equal(value.captureOrdinal, 1, "the initial binding is the only accepted pre-producer capture");
  assert.match(value.inputBindingSha256, SHA256);
  assert.equal(value.inputBindingSha256, currentQ1D7JsonSha256(value.inputBinding),
    "the capture receipt binds the exact initial input binding");
  return value;
}

function validateCurrentD7QueryBudget(binding) {
  assert.equal(CURRENT_Q1_D7_BOUNDS.nativeQueries, 900,
    "the retained native query allowance remains 900 per graph-result invocation");
  assert.equal(CURRENT_Q1_D7_BOUNDS.nativeQueryBudgetScope,
    "per_compute_storage_graph_result_invocation_source_plus_target",
    "the 900-query unit includes source and target for one graph-result invocation");
  assert.equal(binding?.bounds?.nativeQueries, 900,
    "the independently bound D7 input keeps the original 900-query allowance");
  assert.equal(binding?.bounds?.nativeQueryBudgetScope,
    "per_compute_storage_graph_result_invocation_source_plus_target",
    "a case-wide or two-case aggregate budget cannot substitute for the invocation limit");
}

function validateCurrentD7SidecarNames(names, out) {
  assert.ok(Array.isArray(names) && names.every((name) => typeof name === "string"),
    "the private D7 output inventory is readable");
  const prefix = `${basename(out)}.`;
  const actual = names.filter((name) => name.startsWith(`${prefix}current-d7-`)).sort();
  const expected = Object.values(CURRENT_D7_SIDECARS).map((suffix) => `${prefix}${suffix}.json`).sort();
  assert.deepEqual(actual, expected, "the controller emits exactly the seven closed D7 sidecars");
  return expected;
}

function currentD7SchemaPairsForCleanup(report) {
  const receipts = report?.currentD7Qualification?.caseReceipts;
  const declaredPairs = report?.keptSchemaPairs;
  return CURRENT_D7_CASE_IDS.flatMap((caseId) => {
    const receiptSchema = receipts?.[caseId]?.schema;
    const topMatches = Array.isArray(declaredPairs)
      ? declaredPairs.filter((entry) => entry?.caseId === caseId) : [];
    const schema = typeof receiptSchema === "string" && /^typed_legacy_transfer_rehearsal_target_fastpath_[0-9a-f]{8}$/u.test(receiptSchema)
      ? receiptSchema : topMatches.length === 1 ? topMatches[0].schema : null;
    const match = typeof schema === "string"
      ? /^typed_legacy_transfer_rehearsal_target_fastpath_([0-9a-f]{8})$/u.exec(schema) : null;
    return match ? [{ caseId, schema, controlSchema: `typed_legacy_transfer_rehearsal_ctl_${match[1]}` }] : [];
  });
}

/** Validate the exact two-case handoff while allowing finally to clean any
 * individually named generated pair if another receipt field is malformed. */
function validateCurrentD7SchemaHandoff(report, cleanupCandidates = currentD7SchemaPairsForCleanup(report)) {
  assert.equal(report?.reusedSchema, false, "current D7 S9 owns only fresh rehearsal schemas");
  const qualification = report?.currentD7Qualification;
  validateCurrentD7QualificationReport(qualification);
  exactObjectKeys(qualification?.caseReceipts, CURRENT_D7_CASE_IDS, "both current D7 case receipts are required");
  assert.deepEqual(qualification.caseIds, CURRENT_D7_CASE_IDS, "the logical case order is fixed");
  assert.equal(report.keptSchemaPairs?.length, 2, "the controller returns exactly two named schema pairs");
  assert.deepEqual(report.keptSchemaPairs, cleanupCandidates.map(({ caseId, schema, controlSchema }) =>
    ({ caseId, schema, controlSchema })), "the top-level pair projection matches the two receipts");
  const pairs = CURRENT_D7_CASE_IDS.map((caseId) => {
    const receipt = qualification.caseReceipts[caseId];
    exactObjectKeys(receipt, CURRENT_D7_CASE_RECEIPT_KEYS, `${caseId} receipt has a closed schema`);
    assert.equal(receipt.caseId, caseId);
    assert.equal(receipt.schemaVersion, "current-q1-d7-controller-case-receipt-v1");
    for (const key of ["referenceSha256", "expectationSha256", "corpusSha256", "admissionSha256", "sourceInvariantSha256",
      "pgInputSha256", "bootstrapPreservationSha256", "strictExportSha256", "actualResponseSha256", "actualPreviewSha256"])
      assert.match(receipt[key], SHA256, key);
    assert.match(receipt.currentDay, /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(receipt.retainedForS9Cleanup, true);
    const candidate = cleanupCandidates.find((entry) => entry.caseId === caseId);
    assert.ok(candidate, `${caseId} has a safely named generated target for cleanup`);
    assert.equal(receipt.controlSchema, candidate.controlSchema);
    const validated = ownedKeptRehearsalSchemas({ reusedSchema: false, schema: receipt.schema,
      keptSchemas: [receipt.schema, receipt.controlSchema] });
    assert.deepEqual(validated, [receipt.schema, receipt.controlSchema]);
    return candidate;
  });
  const names = pairs.flatMap(({ schema, controlSchema }) => [schema, controlSchema]);
  assert.equal(new Set(names).size, 4, "the two target/control pairs are disjoint");
  assert.deepEqual(report.keptSchemas, names, "the controller exposes exactly the four owned schema names");
  return pairs;
}

const CURRENT_D7_CONTROLLER_ERROR_CODES = new Set([
  "REHEARSAL_ARGUMENT_INVALID",
  "REHEARSAL_CURRENT_CANDIDATE_INPUTS_CHANGED",
  "REHEARSAL_CURRENT_CORPUS_MISMATCH",
  "REHEARSAL_CURRENT_D7_CASE_INCOMPLETE",
  "REHEARSAL_CURRENT_D7_CASE_SET_INVALID",
  "REHEARSAL_CURRENT_D7_COMPARATOR_UNAVAILABLE",
  "REHEARSAL_CURRENT_D7_CONTRACT_NOT_ACCEPTED",
  "REHEARSAL_CURRENT_D7_CONTROLLER_PIN_INVALID",
  "REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED",
  "REHEARSAL_CURRENT_D7_DEADLINE_INVALID",
  "REHEARSAL_CURRENT_D7_EVIDENCE_INCOMPLETE",
  "REHEARSAL_CURRENT_D7_EVIDENCE_INVALID",
  "REHEARSAL_CURRENT_D7_EXPECTATION_INVALID",
  "REHEARSAL_CURRENT_D7_FAILED",
  "REHEARSAL_CURRENT_D7_GOLDEN_INVALID",
  "REHEARSAL_CURRENT_D7_INPUT_BINDING_CAPTURE_CHANGED",
  "REHEARSAL_CURRENT_D7_INPUT_BINDING_INVALID",
  "REHEARSAL_CURRENT_D7_INPUT_CHANGED",
  "REHEARSAL_CURRENT_D7_INPUT_CLEANUP_FAILED",
  "REHEARSAL_CURRENT_D7_INPUT_INVALID",
  "REHEARSAL_CURRENT_D7_OUTPUT_INVALID",
  "REHEARSAL_CURRENT_D7_PG_ADAPTER_INVALID",
  "REHEARSAL_CURRENT_D7_PRODUCER_UNAVAILABLE",
  "REHEARSAL_CURRENT_D7_REFERENCE_INVALID",
  "REHEARSAL_CURRENT_D7_SCHEMA_CLEANUP_FAILED",
  "REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID",
  "REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID",
  "REHEARSAL_CURRENT_MIGRATION_BINDING_CHANGED",
  "REHEARSAL_CURRENT_OUTPUT_EXISTS",
  "REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE",
  "REHEARSAL_CURRENT_REFERENCE_INCOMPLETE",
  "REHEARSAL_CURRENT_REFERENCE_RUNTIME_INVALID",
  "REHEARSAL_DATABASE_INVALID",
  "REHEARSAL_DATABASE_UNCONFIGURED",
  "REHEARSAL_DIST_MISSING",
  "REHEARSAL_DUMP_AMBIGUOUS",
  "REHEARSAL_DUMP_DIGEST_MISMATCH",
  "REHEARSAL_DUMP_MISSING",
  "REHEARSAL_DUMP_UNPINNED",
  "REHEARSAL_GOLDEN_CLOCK_INVALID",
  "REHEARSAL_GOLDEN_REQUIRED",
  "REHEARSAL_IDENTIFIER_INVALID",
  "REHEARSAL_JOURNAL_DDL_MISSING",
  "REHEARSAL_JOURNAL_INPUT_AMBIGUOUS",
  "REHEARSAL_JOURNAL_SOURCE_MISMATCH",
  "REHEARSAL_JOURNAL_TABLE_MISSING",
  "REHEARSAL_MIGRATION_INCOMPLETE",
  "REHEARSAL_NODE22_MISSING",
  "REHEARSAL_NODE_UNSUPPORTED",
  "REHEARSAL_ORIGIN_CHILD_CLEANUP_FAILED",
  "REHEARSAL_ORIGIN_CONFIG_INVALID",
  "REHEARSAL_ORIGIN_START_FAILED",
  "REHEARSAL_ORIGIN_START_TIMEOUT",
  "REHEARSAL_PER_DATE_INVALID",
  "REHEARSAL_POSTGRES_17_REQUIRED",
  "REHEARSAL_READ_FAILED",
  "REHEARSAL_REFRESH_FAILED",
  "REHEARSAL_REFRESH_INCOMPLETE",
  "REHEARSAL_REUSE_SCHEMA_MISSING",
  "REHEARSAL_SQLITE_NOT_SEALED",
  "REHEARSAL_SUFFIX_INVALID",
  "REHEARSAL_TARGET_SCHEMA_INVALID",
]);
const CURRENT_D7_CONTROLLER_PHASES = new Set(["input_binding", "current_d1_replay", "current_d1_acceptance", "postgres",
  "migrate", "sqlite", "importers", "refresh_first", "origin", "parity", "refresh_second", "source_recheck", "cleanup", "report"]);
const CURRENT_D7_CHILD_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS"]);
const CURRENT_D7_CHILD_CODES = new Set(["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "other"]);

/** Project only closed, source-verified controller and child facts into TAP diagnostics. */
function currentD7FailureDiagnostic(report, childCompletion, lastValidatedControllerPhase) {
  const isCurrentD7Error = report?.schemaVersion === "gcp-fastpath-current-d7-rehearsal-report-v1"
    && report?.comparisonMode === "current-worker-d1-d7" && report?.decisionId === "D7"
    && report?.status === "error" && report?.qualifying === false && report?.establishesNativeExecution === false;
  const errorValue = report?.error;
  const errorKeys = errorValue !== null && typeof errorValue === "object" && !Array.isArray(errorValue)
    ? Object.keys(errorValue) : [];
  const rawControllerCode = isCurrentD7Error && errorKeys.length === 1 && errorKeys[0] === "code"
    ? errorValue.code : null;
  const controllerErrorCode = rawControllerCode === null ? "unavailable"
    : CURRENT_D7_CONTROLLER_ERROR_CODES.has(rawControllerCode) ? rawControllerCode : "unrecognized";
  const childState = childCompletion?.state === "failed" || childCompletion?.state === "completed"
    ? childCompletion.state : "unknown";
  return {
    schemaVersion: "current-q1-d7-s9-failure-diagnostic-v1",
    controllerStatus: isCurrentD7Error ? "error" : "unavailable",
    controllerErrorCode,
    childState,
    childExitCode: Number.isSafeInteger(childCompletion?.exitCode) && childCompletion.exitCode >= 0
      && childCompletion.exitCode <= 255 ? childCompletion.exitCode : null,
    childSignal: CURRENT_D7_CHILD_SIGNALS.has(childCompletion?.signal) ? childCompletion.signal : null,
    childKilled: typeof childCompletion?.killed === "boolean" ? childCompletion.killed : null,
    childCode: CURRENT_D7_CHILD_CODES.has(childCompletion?.childCode) ? childCompletion.childCode : "unrecognized",
    deadlineMs: childCompletion?.deadlineMs === S9_REHEARSAL_DEADLINE_MS ? S9_REHEARSAL_DEADLINE_MS : null,
    deadlineElapsed: typeof childCompletion?.deadlineElapsed === "boolean" ? childCompletion.deadlineElapsed : null,
    lastValidatedControllerPhase: CURRENT_D7_CONTROLLER_PHASES.has(lastValidatedControllerPhase)
      ? lastValidatedControllerPhase : null,
  };
}

async function withCurrentD7OwnedSchemaCleanup(report, childCompletion, work, cleanup) {
  const candidates = currentD7SchemaPairsForCleanup(report);
  const verifiedCandidates = candidates.filter(({ caseId, schema, controlSchema }) => {
    try {
      const verified = ownedKeptRehearsalSchemas({ reusedSchema: false, schema,
        keptSchemas: [schema, controlSchema] });
      return verified[0] === schema && verified[1] === controlSchema && CURRENT_D7_CASE_IDS.includes(caseId);
    } catch { return false; }
  });
  const names = [...new Set(verifiedCandidates.flatMap(({ schema, controlSchema }) => [schema, controlSchema]))];
  try {
    // A failed controller has no success-only qualification handoff; surface its
    // closed child outcome first, while finally still owns exact-pair cleanup.
    assertS9ChildCompleted(childCompletion);
    const pairs = validateCurrentD7SchemaHandoff(report, candidates);
    return await work(pairs, names);
  } finally {
    await cleanup(names);
  }
}

function validateCurrentD7QualificationReport(value) {
  exactObjectKeys(value, CURRENT_D7_QUALIFICATION_KEYS, "current D7 qualification has a closed handoff schema");
  assert.equal(value.schemaVersion, "current-q1-d7-controller-qualification-v1");
  assert.equal(value.comparisonMode, "current-worker-d1-d7");
  assert.equal(value.decisionId, "D7");
  assert.deepEqual(value.caseIds, CURRENT_D7_CASE_IDS);
  for (const key of ["inputBindingSha256", "bindingSha256", "referenceContentSha256",
    "inputBindingCaptureContentSha256", "producerAcceptanceContentSha256", "contractContentSha256"])
    assert.match(value[key], SHA256, key);
  assert.equal(value.pgInputSnapshotsRemoved, true, "the controller removed its sealed input snapshots");
  exactObjectKeys(value.sidecars, CURRENT_D7_SIDECAR_HASH_KEYS, "all seven D7 sidecars are bound");
  for (const digest of Object.values(value.sidecars)) assert.match(digest, SHA256);
  assert.equal(value.cleanupPending, true, "the child handoff stays pending until S9 cleans both pairs");
  assert.equal(value.qualifying, false, "the child handoff is not a qualification pass");
  assert.equal(value.establishesNativeExecution, false, "saved sidecars do not attest native execution");
  assert.equal(value.deadlineMs, CURRENT_D7_CHILD_DEADLINE_MS, "both cases share the original child deadline");
  assert.ok(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs < value.deadlineMs);
}

async function readCurrentD7PrivateSidecar(out, suffix) {
  const parentPath = dirname(out);
  const parent = await lstat(parentPath);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid()
    && (parent.mode & 0o777) === 0o700 && await realpath(parentPath) === parentPath,
  "the D7 handoff directory remains owner-only and is not a symlink");
  const path = `${out}.${suffix}.json`;
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid()
    && (info.mode & 0o777) === 0o600 && info.size <= 64 * 1024 * 1024,
  "current D7 sidecars remain bounded owner-private regular files");
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assertCurrentD7PgSnapshotsRemoved(pgInputs, out) {
  const privateRoot = await realpath(dirname(out));
  for (const caseId of CURRENT_D7_CASE_IDS) {
    for (const role of ["ingestion", "journal"]) {
      const path = pgInputs[caseId][role].path;
      const child = relative(privateRoot, path);
      assert.ok(child !== "" && child !== ".." && !child.startsWith(`..${sep}`)
        && !isAbsolute(child), "sealed PostgreSQL snapshots stay within this run's private scratch root");
      try {
        await lstat(path);
        assert.fail("the controller must remove each sealed PostgreSQL snapshot before edge assertions");
      } catch (error) {
        assert.equal(error?.code, "ENOENT", "snapshot absence, not an inaccessible or malformed path, is required");
      }
    }
  }
}

async function readCurrentD7Evidence({ out, report, runtime, imageRuntime }) {
  assert.equal(S9_REHEARSAL_DEADLINE_MS, CURRENT_D7_CHILD_DEADLINE_MS,
    "the D7 consumer preserves the original single-child 40-minute deadline");
  validateCurrentD7QualificationReport(report?.currentD7Qualification);
  assert.equal(report.schemaVersion, "gcp-fastpath-current-d7-rehearsal-report-v1");
  assert.equal(report.comparisonMode, "current-worker-d1-d7");
  assert.equal(report.status, "cleanup_pending", "the controller sidecar remains pending until edge cleanup");
  assert.equal(report.reusedSchema, false);
  assert.equal(Object.hasOwn(report, "currentPostgresInputs"), false,
    "owner-only PostgreSQL paths stay out of the public controller report");
  const qualification = report.currentD7Qualification;
  validateCurrentD7SidecarNames(await readdir(dirname(out)), out);
  const loaded = Object.create(null);
  const rawSidecarSha256 = Object.create(null);
  for (const [hashKey, suffix] of Object.entries(CURRENT_D7_SIDECARS)) {
    const sidecar = await readCurrentD7PrivateSidecar(out, suffix);
    assert.equal(sidecar.sha256, qualification.sidecars[hashKey], `${suffix} is bound by raw file bytes`);
    rawSidecarSha256[hashKey] = sidecar.sha256;
    loaded[hashKey] = sidecar.value;
  }
  const handoff = loaded.referenceSha256;
  exactObjectKeys(handoff, CURRENT_D7_REFERENCE_HANDOFF_KEYS, "the owner-only reference handoff has a closed schema");
  assert.equal(handoff.schemaVersion, "current-q1-d7-controller-reference-v1");
  exactObjectKeys(handoff.cases, CURRENT_D7_CASE_IDS, "the reference handoff contains exactly both logical cases");
  exactObjectKeys(handoff.expectations, CURRENT_D7_CASE_IDS, "the reference handoff contains both expectations");
  exactObjectKeys(handoff.expectationSha256, CURRENT_D7_CASE_IDS, "both expectations have bound digests");
  exactObjectKeys(handoff.pgInputs, CURRENT_D7_CASE_IDS, "both PostgreSQL inputs are present");

  const binding = loaded.bindingSha256;
  const acceptance = loaded.producerAcceptanceSha256;
  const contract = loaded.contractSha256;
  assert.equal(qualification.inputBindingSha256, currentQ1D7JsonSha256(handoff.inputBinding));
  const inputBindingCapture = validateCurrentD7InputBindingCapture(loaded.inputBindingCaptureSha256);
  assert.deepEqual(inputBindingCapture.inputBinding, handoff.inputBinding,
    "the post-producer handoff matches the independently preserved pre-producer capture");
  assert.equal(qualification.inputBindingSha256, inputBindingCapture.inputBindingSha256);
  assert.equal(qualification.bindingSha256, currentQ1D7JsonSha256(binding));
  // Binding fields use semantic canonical-JSON hashes. These three *Content*
  // fields intentionally alias exact sidecar-byte hashes, including newlines;
  // keep that framing distinct from receipt JSON hashes below.
  assert.equal(qualification.referenceContentSha256, rawSidecarSha256.referenceSha256);
  assert.equal(qualification.inputBindingCaptureContentSha256, rawSidecarSha256.inputBindingCaptureSha256);
  assert.equal(qualification.producerAcceptanceContentSha256, rawSidecarSha256.producerAcceptanceSha256);
  assert.equal(qualification.contractContentSha256, rawSidecarSha256.contractSha256);
  assert.deepEqual(handoff.binding, binding, "the independently bound handoff and binding sidecar are identical");
  assert.deepEqual(handoff.acceptance, acceptance, "the handoff and producer-acceptance sidecar are identical");
  validateCurrentQ1D7InputBinding(inputBindingCapture.inputBinding);
  validateCurrentQ1D7Binding(binding, inputBindingCapture.inputBinding);
  validateCurrentD7QueryBudget(binding);
  assert.equal(binding.source.head, (await execFileAsync("git", ["--no-optional-locks", "-C", REPOSITORY_ROOT,
    "rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 1_024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } })).stdout.trim(),
  "D7 source inputs were captured on this candidate head");
  for (const entry of binding.source.files) await verifyCurrentFilePin(entry);
  const pinnedPaths = new Set(binding.source.files.map(({ path }) => path));
  for (const path of CURRENT_D7_REQUIRED_SOURCE_PATHS) assert.ok(pinnedPaths.has(path),
    "the independently captured source closure pins every current D7 producer and reusable seam");
  const expectedController = binding.source.files.find((entry) => entry.path === REHEARSAL_CONTROLLER_PATH);
  assert.ok(expectedController, "the controller is in the source closure");
  assert.equal(acceptance.controller.path, expectedController.path);
  assert.equal(acceptance.controller.sha256, expectedController.sha256);
  assert.deepEqual({ version: runtime.version, platform: runtime.platform, arch: runtime.arch, binarySha256: runtime.binarySha256 },
    { version: binding.runtime.version, platform: binding.runtime.platform, arch: binding.runtime.arch,
      binarySha256: binding.runtime.binarySha256 }, "the current reference ran under its exact retained Node runtime");
  assertCurrentImageRuntime(imageRuntime);
  assert.deepEqual(await verifyCurrentImageRuntimePath(process.execPath), imageRuntime,
    "the edge and Cloud Run origin keep the original Node 22 image runtime");

  const expectations = handoff.expectations;
  const casesById = handoff.cases;
  const pgInputs = handoff.pgInputs;
  const references = Object.create(null);
  for (const caseId of CURRENT_D7_CASE_IDS) {
    references[caseId] = casesById[caseId];
    validateCurrentQ1D7PerDateExpectation(expectations[caseId], binding,
      { expectedSha256: handoff.expectationSha256[caseId] });
    validateCurrentQ1D7PgCaseInput(pgInputs[caseId], binding, caseId);
    validateCurrentQ1D7CaseReference(references[caseId], binding, {
      expectation: expectations[caseId], expectedExpectationSha256: handoff.expectationSha256[caseId],
    });
    const strictExport = references[caseId].strictExport;
    validateCurrentQ1D7StrictExportProof(strictExport, binding, caseId);
    const negative = caseId === "conflictPreserving";
    assert.equal(strictExport.actual, true, `${caseId} strict export was executed on the original oracle`);
    assert.equal(strictExport.queuedRows, negative ? 2 : 0, `${caseId} strict export preserves its exact queue outcome`);
    assert.deepEqual(strictExport.orderedQueueDays, binding.cases[caseId].conflictDays,
      `${caseId} queue days match its independently bound source conflicts`);
    assert.equal(strictExport.state, negative ? "expected_conflict_refusal" : "successful");
    assert.equal(strictExport.refusalProof !== null, negative,
      `${caseId} carries only its expected original strict-export refusal proof`);
    assert.equal(strictExport.successProof !== null, !negative,
      `${caseId} carries only its expected original successful-export proof`);
  }
  await assertCurrentD7PgSnapshotsRemoved(pgInputs, out);
  const structural = assessCurrentQ1D7Qualification({ binding, cases: references, expectations,
    expectationSha256: handoff.expectationSha256, pgInputs });
  assert.deepEqual(structural, { state: "structurally_complete", establishesNativeExecution: false, reasons: [] });
  validateCurrentQ1D7ProducerAcceptance(acceptance, { inputBinding: handoff.inputBinding, binding, cases: references, expectations,
    expectationSha256: handoff.expectationSha256, pgInputs, expectedController });

  const caseOutputs = [];
  for (const [index, caseId] of CURRENT_D7_CASE_IDS.entries()) {
    const hashKey = index === 0 ? "conflictPreservingCaseSha256" : "conflictFreePositiveCaseSha256";
    const output = loaded[hashKey];
    exactObjectKeys(output, CURRENT_D7_CASE_OUTPUT_KEYS, `${caseId} sidecar has a closed output schema`);
    assert.equal(output.schemaVersion, "current-q1-d7-controller-case-output-v1");
    assert.equal(output.caseId, caseId);
    assert.deepEqual(output.reference, references[caseId]);
    assert.deepEqual(output.expectation, expectations[caseId]);
    const receipt = qualification.caseReceipts[caseId];
    assert.deepEqual(output.controllerReceipt, receipt);
    assert.equal(receipt.referenceSha256, currentQ1D7JsonSha256(references[caseId]));
    assert.equal(receipt.expectationSha256, handoff.expectationSha256[caseId]);
    assert.equal(receipt.corpusSha256, binding.cases[caseId].corpusSha256);
    assert.equal(receipt.admissionSha256, binding.cases[caseId].admissionSha256);
    assert.equal(receipt.sourceInvariantSha256, binding.cases[caseId].sourceInvariantSha256);
    assert.equal(receipt.pgInputSha256, currentQ1D7JsonSha256(pgInputs[caseId]));
    assert.equal(receipt.bootstrapPreservationSha256,
      currentQ1D7JsonSha256(references[caseId].bootstrapPreservation));
    assert.equal(receipt.strictExportSha256, currentQ1D7JsonSha256(references[caseId].strictExport));
    assert.equal(receipt.currentDay, output.currentDay,
      `${caseId} controller and output sidecars bind the same comparison day`);
    assert.equal(receipt.actualResponseSha256, currentQ1D7JsonSha256(output.actualResponse));
    assert.equal(receipt.actualPreviewSha256, currentQ1D7JsonSha256(output.actualPreview));
    compareCurrentD7Case({ caseId, reference: output.reference, expectation: output.expectation,
      actualResponse: output.actualResponse, actualPreview: output.actualPreview, currentDay: output.currentDay });
    caseOutputs.push({ caseId, reference: output.reference, expectation: output.expectation,
      actualResponse: output.actualResponse, actualPreview: output.actualPreview, currentDay: output.currentDay });
  }

  const comparison = compareCurrentQ1D7Contract({ binding, cases: caseOutputs, expectations,
    expectationSha256: handoff.expectationSha256, pgInputs, producerAcceptance: acceptance, expectedController });
  assert.deepEqual(contract, comparison, "the aggregate contract is independently reproduced from both output sidecars");
  assert.equal(comparison.accepted, true);
  assert.deepEqual(comparison.acceptedCaseIds, CURRENT_D7_CASE_IDS);
  assert.equal(comparison.strictUnaffectedEqual, true);
  assert.equal(comparison.exactPerDateEqual, true);
  assert.equal(comparison.positive70DateEqual, true);
  assert.equal(comparison.unexpectedDiffs, 0, "accepted D7 model deltas are excluded by the contract; no unexpected diff remains");
  assert.deepEqual(comparison.nonqualifyingScopes, [], "neither case has a nonqualifying comparison scope");
  assert.equal(comparison.perCase.length, 2);
  assert.deepEqual(comparison.perCase.map(({ caseId, equal, strictUnaffectedEqual, exactPerDateEqual, diffCount, diffs }) =>
    ({ caseId, equal, strictUnaffectedEqual, exactPerDateEqual, diffCount, diffs })), CURRENT_D7_CASE_IDS.map((caseId) => ({
    caseId, equal: true, strictUnaffectedEqual: true, exactPerDateEqual: true, diffCount: 0, diffs: [],
  })), "both cases have strict equality after only the independently accepted D7 projection");
  assert.deepEqual(comparison.unresolved, []);
  const expectedD7DateSet = references.conflictPreserving.publicationInventory
    .filter(({ state }) => state === "withheld").map(({ day }) => day).sort();
  assert.ok(expectedD7DateSet.length > 0, "the negative source witness derives at least one current withheld date");
  assert.deepEqual(comparison.acceptedD7DateSet, expectedD7DateSet,
    "accepted D7 dates come from the current conflict-preserving proof");
  assert.deepEqual(references.conflictFreePositive.publicationInventory.map(({ state }) => state),
    Array(70).fill("published"), "the positive reference publishes all 70 model dates");
  assert.deepEqual(references.conflictPreserving.currentFits.map(({ owner }) => owner).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(references.conflictFreePositive.currentFits.map(({ owner }) => owner).sort(), ["a", "b", "c", "d"]);
  assert.equal(references.conflictPreserving.strictExport.state, "expected_conflict_refusal");
  assert.equal(references.conflictFreePositive.strictExport.state, "successful");
  assert.ok(references.conflictPreserving.conflictProofs.length > 0);
  assert.deepEqual(references.conflictFreePositive.conflictProofs, []);
  const currentPublicDays = currentQ1D7PublicDays(binding);
  assert.equal(currentPublicDays.length, 69, "the current public route includes only closed model days");
  for (const { caseId, actualResponse } of caseOutputs) {
    assert.deepEqual(actualResponse.allowanceBreakdowns.days.map(({ day }) => day), currentPublicDays,
      `${caseId} public response contains the exact closed current days`);
  }
  const descriptorPaths = CURRENT_D7_CASE_IDS.flatMap((caseId) => [pgInputs[caseId].ingestion.path, pgInputs[caseId].journal.path]);
  const publicReport = JSON.stringify(report);
  assert.ok(descriptorPaths.every((path) => !publicReport.includes(path)),
    "owner-only sealed input paths never enter the controller report");
  return { handoff, binding, acceptance, references, expectations, pgInputs, caseOutputs, contract, comparison };
}

function compareCurrentD7Case({ caseId, reference, expectation, actualResponse, actualPreview, currentDay }) {
  const comparison = compareCurrentQ1D7CaseDTOs({ caseId, reference, expectation, actualResponse, actualPreview, currentDay });
  assert.equal(comparison.caseId, caseId);
  assert.equal(comparison.comparedDates, 70);
  assert.equal(comparison.equal, true, `${caseId} exactly matches its accepted current-source contract`);
  assert.equal(comparison.strictUnaffectedEqual, true, `${caseId} keeps every unaffected DTO field strict`);
  assert.equal(comparison.exactPerDateEqual, true, `${caseId} has exact current per-date models`);
  assert.equal(comparison.diffCount, 0, `${caseId} has no unexpected difference outside its accepted contract`);
  assert.deepEqual(comparison.diffs, []);
  return comparison;
}

test("S9 D7 owns exactly two disjoint retained schema pairs and requires both receipts", async () => {
  const digest = "a".repeat(64);
  const caseReceipts = Object.fromEntries(CURRENT_D7_CASE_IDS.map((caseId, index) => {
    const suffix = index === 0 ? "00000001" : "00000002";
    return [caseId, { caseId, schemaVersion: "current-q1-d7-controller-case-receipt-v1",
      referenceSha256: digest, expectationSha256: digest, corpusSha256: digest, admissionSha256: digest,
      sourceInvariantSha256: digest, pgInputSha256: digest, bootstrapPreservationSha256: digest,
      strictExportSha256: digest, actualResponseSha256: digest,
      actualPreviewSha256: digest,
      schema: `typed_legacy_transfer_rehearsal_target_fastpath_${suffix}`,
      controlSchema: `typed_legacy_transfer_rehearsal_ctl_${suffix}`, currentDay: "2026-10-01",
      retainedForS9Cleanup: true }];
  }));
  const keptSchemaPairs = CURRENT_D7_CASE_IDS.map((caseId) => ({ caseId,
    schema: caseReceipts[caseId].schema, controlSchema: caseReceipts[caseId].controlSchema }));
  const report = { reusedSchema: false,
    keptSchemaPairs,
    keptSchemas: keptSchemaPairs.flatMap(({ schema, controlSchema }) => [schema, controlSchema]),
    currentD7Qualification: { schemaVersion: "current-q1-d7-controller-qualification-v1",
      comparisonMode: "current-worker-d1-d7", decisionId: "D7", caseIds: [...CURRENT_D7_CASE_IDS],
      inputBindingSha256: digest, inputBindingCaptureContentSha256: digest, bindingSha256: digest, referenceContentSha256: digest,
      producerAcceptanceContentSha256: digest, contractContentSha256: digest, caseReceipts,
      sidecars: Object.fromEntries(CURRENT_D7_SIDECAR_HASH_KEYS.map((key) => [key, digest])),
      cleanupPending: true, qualifying: false, establishesNativeExecution: false,
      deadlineMs: S9_REHEARSAL_DEADLINE_MS, elapsedMs: 1, pgInputSnapshotsRemoved: true } };
  const pairs = validateCurrentD7SchemaHandoff(report);
  assert.deepEqual(pairs, keptSchemaPairs);
  assert.throws(() => validateCurrentD7SchemaHandoff({ ...report, currentD7Qualification: {
    ...report.currentD7Qualification, caseReceipts: { conflictPreserving: caseReceipts.conflictPreserving },
  } }), /both current D7 case receipts/u);
  assert.throws(() => validateCurrentD7SchemaHandoff({ ...report,
    keptSchemas: [...report.keptSchemas, "typed_legacy_transfer_rehearsal_target_fastpath_ffffffff"],
  }), /controller exposes exactly the four owned schema names/u);
  assert.throws(() => validateCurrentD7SchemaHandoff({ ...report,
    keptSchemaPairs: [{ ...keptSchemaPairs[0] }, { ...keptSchemaPairs[1], schema: keptSchemaPairs[0].schema }],
  }), /top-level pair projection/u);
  const completedChild = (await captureS9ChildCompletion(async () => ({ stdout: "", stderr: "" }))).metadata;
  const cleaned = [];
  await assert.rejects(withCurrentD7OwnedSchemaCleanup({ ...report,
    keptSchemas: [...report.keptSchemas, "typed_legacy_transfer_rehearsal_target_fastpath_ffffffff"],
  }, completedChild, async () => assert.fail("invalid extra schema names cannot enter edge assertions"), async (names) => cleaned.push(...names)),
  /four owned schema names/u);
  assert.deepEqual(cleaned, report.keptSchemas,
    "an invalid extra name still cleans only the four independently validated owned schemas");
});

test("S9 D7 requires a closed input-binding capture made before producer invocation", () => {
  const inputBinding = { binding: "synthetic-pre-producer-binding" };
  const capture = { schemaVersion: "current-q1-d7-input-binding-capture-v1", capturedBeforeProducer: true,
    captureOrdinal: 1, inputBindingSha256: currentQ1D7JsonSha256(inputBinding), inputBinding };
  assert.equal(validateCurrentD7InputBindingCapture(capture), capture);
  assert.throws(() => validateCurrentD7InputBindingCapture({ ...capture, capturedBeforeProducer: false }),
    /captured before producer invocation/u);
  assert.throws(() => validateCurrentD7InputBindingCapture({ ...capture, captureOrdinal: 2 }), /only accepted pre-producer/u);
  assert.throws(() => validateCurrentD7InputBindingCapture({ ...capture, inputBindingSha256: "b".repeat(64) }),
    /exact initial input binding/u);
  assert.throws(() => validateCurrentD7InputBindingCapture({ ...capture, producerResponse: { private: true } }),
    /closed schema/u);
});

test("S9 D7 keeps the 900 native query limit per graph-result invocation", () => {
  const binding = { bounds: structuredClone(CURRENT_Q1_D7_BOUNDS) };
  assert.doesNotThrow(() => validateCurrentD7QueryBudget(binding));
  assert.throws(() => validateCurrentD7QueryBudget({ bounds: {
    ...binding.bounds, nativeQueries: 899,
  } }), /original 900-query allowance/u);
  assert.throws(() => validateCurrentD7QueryBudget({ bounds: {
    ...binding.bounds, nativeQueryBudgetScope: "whole_two_case_fixture",
  } }), /case-wide or two-case aggregate budget/u);
});

test("S9 D7 consumes exactly the seven named private controller sidecars", () => {
  const out = "/private/synthetic/report.json";
  const expected = Object.values(CURRENT_D7_SIDECARS).map((suffix) => `report.json.${suffix}.json`);
  assert.deepEqual(validateCurrentD7SidecarNames(expected, out), expected.sort());
  assert.throws(() => validateCurrentD7SidecarNames([...expected, "report.json.current-d7-unbound.json"], out),
    /exactly the seven closed D7 sidecars/u);
  assert.throws(() => validateCurrentD7SidecarNames(expected.slice(1), out),
    /exactly the seven closed D7 sidecars/u);
});

async function regularFileSha256(path, maximumBytes = 512 * 1024 * 1024) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumBytes,
    "a bounded regular file is required");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Verify the retained binary before executing even its version command. */
async function s9RehearsalNode() {
  if (!CURRENT_Q1 && !CURRENT_D7) return { node: process.env.EDGE_E2E_REHEARSAL_NODE || "node", runtime: null };
  assert.equal(process.version, "v22.16.0", "S9 edge and origin retain the image runtime");
  const named = process.env.EDGE_E2E_REHEARSAL_NODE;
  assert.ok(typeof named === "string" && isAbsolute(named),
    "current S9 requires the retained absolute EDGE_E2E_REHEARSAL_NODE");
  const node = await realpath(named);
  const runtime = { version: "v26.2.0", platform: process.platform, arch: process.arch,
    binarySha256: await regularFileSha256(node) };
  assertCurrentQ1TrustedRuntime(runtime);
  const { stdout } = await execFileAsync(node, ["--version"], { timeout: 10_000, maxBuffer: 1_024 });
  assert.equal(stdout.trim(), "v26.2.0", "the allowlisted retained runtime reports its exact version");
  assert.equal(await regularFileSha256(node), runtime.binarySha256, "the retained binary is unchanged after its version probe");
  return { node, runtime };
}


async function preserveS9Artifact(suffix, value) {
  if (!process.env.EDGE_E2E_REPORT) return;
  await writeFile(`${resolve(process.env.EDGE_E2E_REPORT)}.${suffix}.json`, `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
}

async function verifyCurrentFilePin(entry) {
  assert.deepEqual(Object.keys(entry).sort(), ["path", "sha256"]);
  assert.ok(typeof entry.path === "string" && entry.path.startsWith("apps/worker/")
    && !/[\0\r\n\\]/u.test(entry.path)
    && entry.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
  assert.match(entry.sha256, SHA256);
  assert.equal(await regularFileSha256(join(REPOSITORY_ROOT, entry.path), 32 * 1024 * 1024), entry.sha256,
    `the named candidate input is unchanged: ${entry.path}`);
}

/** The receipt preserves the direct invocation, rather than attesting it cryptographically.
 * Expected digests remain the controller's original pre-PG strings. */
async function verifyCurrentS9Evidence({ report, evidence, runtime, imageRuntime, staged }) {
  assert.ok(evidence, "current S9 requires all preserved producer sidecars");
  const { reference, binding, acceptance } = evidence;
  const original = report.currentReference;
  assert.ok(original && original.qualification === "complete");
  for (const field of ["sha256", "bindingSha256", "acceptanceSha256"]) assert.match(original[field], SHA256);
  assert.equal(jsonSha256(reference), original.sha256, "the reference equals its original pre-PG digest");
  assert.equal(jsonSha256(binding), original.bindingSha256, "the binding equals its original pre-PG digest");
  assert.equal(jsonSha256(acceptance), original.acceptanceSha256, "the accepted receipt is preserved");
  validateCurrentQ1ReferenceBinding({ reference, expected: binding });
  assert.equal(reference.schemaVersion, "current-q1-d1-reference-v2");
  assert.equal(binding.schemaVersion, "current-q1-d1-reference-binding-v3");
  assert.deepEqual(assessCurrentQ1ReferenceCompleteness({ reference, corpus: binding.corpusStructure,
    snapshotReadiness: { afterForcedRecompute: reference.afterForcedRecompute?.readiness,
      afterNativeProbes: reference.afterNativeProbes?.readiness } }), { state: "complete", reasons: [] },
  "the preserved current reference passes all recomputation, convergence, refusal, DTO and native gates");
  for (const field of ["recomputation", "corpusConvergence", "strictExportRefusal"]) {
    const digestField = `${field}Sha256`;
    assert.match(original[digestField], SHA256);
    assert.equal(jsonSha256(reference[field]), original[digestField], `the actual ${field} evidence is preserved`);
    assert.equal(acceptance[digestField], original[digestField], `the controller accepted this ${field} evidence`);
  }
  assert.deepEqual(Object.keys(acceptance).sort(), ["schemaVersion", "evidenceScope", "cryptographicExecutionAttestation",
    "actualHelperInvocation", "resultReturnedAfterOwnedCleanup", "accepted", "referenceSha256", "bindingSha256",
    "sourceHead", "sourceSha256", "migrationSha256", "corpusSha256", "helper", "controller", "runtime",
    "recomputationSha256", "corpusConvergenceSha256", "strictExportRefusalSha256"].sort());
  assert.equal(acceptance.schemaVersion, "current-q1-d1-producer-acceptance-v2");
  assert.equal(acceptance.evidenceScope, "direct-source-pinned-producer-controller");
  assert.equal(acceptance.cryptographicExecutionAttestation, false);
  for (const field of ["actualHelperInvocation", "resultReturnedAfterOwnedCleanup", "accepted"]) {
    assert.equal(acceptance[field], true, `the controller's ${field} gate is closed`);
  }
  assert.equal(acceptance.referenceSha256, original.sha256);
  assert.equal(acceptance.bindingSha256, original.bindingSha256);
  assert.equal(original.schemaVersion, reference.schemaVersion);
  assert.deepEqual(original.source, { head: binding.source.head, sha256: binding.source.sha256 });
  assert.equal(acceptance.sourceHead, binding.source.head);
  assert.equal(acceptance.sourceSha256, binding.source.sha256);
  assert.equal(acceptance.migrationSha256, binding.migrationSha256);
  assert.equal(original.migrationSha256, binding.migrationSha256);
  assert.equal(acceptance.corpusSha256, binding.corpus.canonicalSha256);
  assert.equal(original.corpusSha256, binding.corpus.canonicalSha256);
  assert.deepEqual(acceptance.runtime, binding.runtime);
  assert.deepEqual(original.runtime, binding.runtime);
  assertCurrentQ1TrustedRuntime(binding.runtime);
  for (const [key, value] of Object.entries(runtime)) assert.equal(binding.runtime[key], value);
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    { timeout: 10_000, maxBuffer: 1_024, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } });
  assert.match(stdout, /^[a-f0-9]{40}\n$/u);
  assert.equal(binding.source.head, stdout.trim(), "the producer was born on this candidate head");
  for (const entry of binding.source.files) await verifyCurrentFilePin(entry);
  assert.deepEqual(acceptance.helper, binding.source.files.find((entry) => entry.path === CURRENT_HELPER_PATH));
  assert.equal(acceptance.helper.path, CURRENT_HELPER_PATH);
  await verifyCurrentFilePin(acceptance.helper);
  assert.equal(acceptance.controller.path, REHEARSAL_CONTROLLER_PATH);
  await verifyCurrentFilePin(acceptance.controller);
  const migrationPaths = [];
  for (const directory of CURRENT_MIGRATION_ORDER) {
    for (const name of (await readdir(join(WORKER_ROOT, directory))).filter((name) =>
      /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort()) migrationPaths.push(`apps/worker/${directory}/${name}`);
  }
  assert.deepEqual(binding.migrations.map(({ path }) => path), migrationPaths,
    "the exact current migration set and maintained apply order are preserved");
  const corpusPaths = ["corpus.json", ...["a", "b", "c", "d"].map((key) => `corpus-owner-${key}.json`)]
    .map((name) => `apps/worker/analytics-v2-test/golden/corpus/${name}`);
  assert.deepEqual(binding.corpus.files.map(({ path }) => path), corpusPaths);
  const corpus = [];
  for (const entry of binding.corpus.files) {
    await verifyCurrentFilePin(entry);
    corpus.push(JSON.parse(await readFile(join(REPOSITORY_ROOT, entry.path), "utf8")));
  }
  assert.equal(jsonSha256(corpus), original.corpusSha256, "the immutable raw Q-1 corpus is independently bound");
  const inputs = report.currentPostgresInputs;
  assert.equal(inputs?.schemaVersion, "current-q1-postgres-input-binding-v1");
  assert.deepEqual(inputs.controller, acceptance.controller);
  assert.deepEqual(inputs.primary, (await readPostgresMigrations({ role: "primary" }))
    .map(({ name, sha256 }) => ({ name, sha256 })));
  assert.deepEqual(inputs.staged.map(({ name }) => name), staged);
  for (const entry of inputs.staged) await verifyCurrentFilePin({
    path: `apps/worker/postgres/staged-migrations/primary/${entry.name}`, sha256: entry.sha256 });
  assert.deepEqual(inputs.bundles.map(({ path }) => path), ["analytics-refresh.mjs", "server.mjs"]
    .map((name) => `apps/worker/cloud-run/dist/${name}`));
  for (const entry of inputs.bundles) await verifyCurrentFilePin(entry);
  assertCurrentImageRuntime(imageRuntime);
  assert.deepEqual(inputs.node22, { version: imageRuntime.version, sha256: imageRuntime.binarySha256 },
    "the original report preserves the independently verified pre-producer image runtime");
  assert.deepEqual(await verifyCurrentImageRuntimePath(process.execPath), imageRuntime,
    "the retained image runtime is unchanged from its pre-producer binding");
}

/** The same controller directly produces fresh D1 evidence before querying PG.
 * It retains the image Node 22.16 for PG refresh and the origin. */
async function seededRehearsal() {
  if (CURRENT_D7) assert.equal(S9_REHEARSAL_DEADLINE_MS, CURRENT_D7_CHILD_DEADLINE_MS,
    "the D7 producer keeps the original single-child 40-minute deadline");
  const imageRuntime = CURRENT_Q1 || CURRENT_D7 ? await verifyCurrentImageRuntimePath(process.execPath) : null;
  const { node, runtime } = await s9RehearsalNode();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "edge-e2e-rehearsal-")));
  await chmod(directory, 0o700);
  const out = join(directory, "report.json");
  let discardDirectory = false;
  let result = null;
  const staged = CURRENT_D7 ? [] : (await readdir(join(WORKER_ROOT, "postgres", "staged-migrations", "primary")).catch(() => []))
    .filter((name) => /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u.test(name)).sort();
  try {
    // This wx handle receives only parsed closed progress while the child runs.
    const progressFile = await open(join(directory, "child-progress.jsonl"), "wx", 0o600);
    let observer, liveProgress;
    let completion;
    try {
      completion = await captureS9ChildCompletion(() => {
        const pending = execFileAsync(node,
          [join(WORKER_ROOT, "scripts", "gcp-fastpath-rehearsal.mjs"),
            ...s9ControllerGoldenArguments({ mode: S9_COMPARISON_MODE, golden: GOLDEN, workerRoot: WORKER_ROOT }),
            "--keep-schema", "--out", out,
            "--comparison-mode", S9_COMPARISON_MODE,
            ...(PER_DATE_EXPECTED === null ? [] : ["--per-date-expected", PER_DATE_EXPECTED]),
            ...staged.flatMap((name) => ["--staged-primary", name])], {
            cwd: WORKER_ROOT, maxBuffer: 256 * 1024 * 1024, timeout: S9_REHEARSAL_DEADLINE_MS,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: directory, PG_TEST_SOCKET: process.env.PG_TEST_SOCKET,
              PG_TEST_PORT: String(PG_TEST_PORT), GCP_FASTPATH_NODE22: process.execPath,
              ...(process.env.PG_TEST_USER ? { PG_TEST_USER: process.env.PG_TEST_USER } : {}),
              ...(process.env.PG_TEST_DATABASE ? { PG_TEST_DATABASE: process.env.PG_TEST_DATABASE } : {}) },
          });
        observer = observeS9ChildProgress(pending.child, (line) => progressFile.writeFile(line),
          (line) => process.stderr.write(line));
        return pending;
      });
    } finally {
      let progressFailed = false;
      try { liveProgress = await observer?.close(); } catch { progressFailed = true; }
      try { await progressFile.close(); } catch { progressFailed = true; }
      if (progressFailed) liveProgress = { records: liveProgress?.records ?? 0, bytes: liveProgress?.bytes ?? 0,
        rejected: liveProgress?.rejected ?? 0, preserved: false };
    }
    // Raw child output remains solely in this owner-private local directory.
    // Preserve failures before attempting a report; missing sidecars keep it intact.
    let failureOutputPreserved = liveProgress?.preserved === true;
    let lastValidatedControllerPhase = null;
    if (completion.metadata.state === "failed") {
      try {
        await writeFile(join(directory, "child-completion.json"), `${JSON.stringify({ ...completion.metadata,
          stdout: { originalBytes: completion.stdout.originalBytes, truncated: completion.stdout.truncated },
          stderr: { originalBytes: completion.stderr.originalBytes, truncated: completion.stderr.truncated } })}\n`,
        { flag: "wx", mode: 0o600 });
        for (const stream of ["stdout", "stderr"]) await writeFile(join(directory, `child-${stream}.log`),
          completion[stream].bytes, { flag: "wx", mode: 0o600 });
      } catch { failureOutputPreserved = false; }
    }
    const report = await readS9ChildReport(out, completion.metadata);
    assert.ok(report && typeof report === "object" && !Array.isArray(report), "a controller report is required");
    if (!CURRENT_D7) ownedKeptRehearsalSchemas(report);
    let artifactsPreserved = failureOutputPreserved;
    // Return the parsed report even when preservation fails so the caller can
    // close this controller's exact kept schemas before failing the test.
    const preserve = async (suffix, value) => {
      try { await preserveS9Artifact(suffix, value); } catch { artifactsPreserved = false; }
    };
    if (!CURRENT_D7) await preserve("s9-rehearsal", report);
    await preserve("s9-child-completion", { schemaVersion: "s9-rehearsal-child-completion-v1",
      child: completion.metadata, liveProgress });
    try {
      const progressPath = join(directory, "child-progress.jsonl"), metadata = await lstat(progressPath);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
        && metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0 && metadata.size <= S9_DIAGNOSTIC_BYTES,
      "the bounded progress journal remains an owner-private regular file");
      const records = validateS9ProgressJournal(await readFile(progressPath), liveProgress);
      if (CURRENT_D7) lastValidatedControllerPhase = records.toReversed()
        .find((record) => record.component === "controller")?.phase ?? null;
      await preserve("s9-progress", { schemaVersion: "s9-rehearsal-progress-v1", records });
    } catch { artifactsPreserved = false; }
    let evidence = null;
    if (CURRENT_Q1) {
      // Parse and preserve the producer's original sidecars before removing the
      // owned directory. Missing evidence cannot acquire a passing receipt.
      const values = await Promise.allSettled(["current-reference", "current-reference-binding", "current-reference-acceptance"]
        .map(async (suffix) => {
          const value = JSON.parse(await readFile(`${out}.${suffix}.json`, "utf8"));
          await preserve(suffix, value);
          return value;
        }));
      if (values.every(({ status }) => status === "fulfilled")) evidence = {
        reference: values[0].value, binding: values[1].value, acceptance: values[2].value };
    }
    discardDirectory = !CURRENT_D7 && completion.metadata.state === "completed" && artifactsPreserved
      && (!CURRENT_Q1 || evidence !== null);
    result = { report, evidence, runtime, imageRuntime, staged, artifactsPreserved,
      childCompletion: completion.metadata, liveProgress, lastValidatedControllerPhase, temporaryOutputRemoved: false,
      ...(CURRENT_D7 ? { privateOutputPath: out, privateOutputDirectory: directory } : {}) };
    return result;
  } finally {
    // Keep the sole private diagnostic bytes if ownership or any required
    // sidecar is unreadable, or a requested wx preservation failed. Cleanup
    // failure returns through S9's schema cleanup rather than skipping it.
    if (discardDirectory) {
      try {
        await rm(directory, { recursive: true, force: true });
        result.temporaryOutputRemoved = true;
      } catch { /* The caller fails inside its exact schema cleanup boundary. */ }
    }
  }
}

async function removeCurrentD7PrivateOutput(seeded) {
  const directory = seeded.privateOutputDirectory;
  assert.equal(typeof directory, "string");
  assert.equal(dirname(directory), await realpath(tmpdir()));
  assert.match(basename(directory), /^edge-e2e-rehearsal-/u,
    "only the private temporary directory created by this S9 run can be removed");
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid()
    && (metadata.mode & 0o777) === 0o700 && await realpath(directory) === directory,
  "the retained owner-only output directory remains the exact owned target");
  await rm(directory, { recursive: true, force: false });
  seeded.temporaryOutputRemoved = true;
}

async function currentD7EdgeCase({ f, evidence, pair, caseOutput, dump, casesVerified }) {
  const { caseId, reference, actualResponse: controllerResponse, actualPreview: controllerPreview, currentDay } = caseOutput;
  const { schema, controlSchema } = pair;
  assert.deepEqual(evidence.references[caseId], reference);
  assert.notEqual(schema, controlSchema);
  const from = reference.graphDays[0], to = reference.graphDays.at(-1);
  const settings = Object.fromEntries([...originSourceEnv(goldenSourceIdentity(dump)), ...edgeTestProductionEnv()]);
  const origin = await startOrigin({ socket: f.socket, schema, keys: f.keys,
    nowMs: evidence.binding.runtime.pinnedNowMs, objects: new Map(), settings });
  const frontEnd = createGoogleFrontEnd({ invoker: f.invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
    upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(origin.port) });
  let instance = null;
  try {
    instance = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd, invokerKeyJson: f.invoker.keyJson });
    const path = `/api/v1/community/daily?from=${from}&to=${to}`;
    const ip = nextIp();
    const edgeMark = frontEnd.mark();
    const answer = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}${path}`, { ip });
    assert.equal(answer.status, 200, answer.text.slice(0, 300));
    const edgeExchanges = frontEnd.since(edgeMark);
    assert.equal(edgeExchanges.length, 1, `${caseId} edge read has exactly one origin exchange`);
    const [edgeExchange] = edgeExchanges;
    assert.deepEqual(transparencyMismatches(f, answer, edgeExchange), [], `${caseId} edge/origin transparency`);

    const directMark = frontEnd.mark();
    const direct = await frontEnd.direct({ path, email: EDGE_E2E_INVOKER, headers: {
      "x-tibotattle-edge-host": "apex", "x-tibotattle-edge-request-id": randomUUID(),
      "x-tibotattle-edge-admission": "v1;public_aggregate_read;allowed" } });
    assert.equal(direct.status, 200, `${caseId} direct origin read`);
    assert.ok(answer.body.equals(direct.body), `${caseId} edge bytes equal direct-origin bytes`);
    const actualResponse = JSON.parse(answer.text);
    const directResponse = JSON.parse(direct.body.toString("utf8"));
    const actualPreview = (await f.base.query(`SELECT preview FROM "${schema}".analytics_v2_preview WHERE id = 1`))
      .rows[0]?.preview ?? null;
    assert.ok(actualPreview && typeof actualPreview === "object", `${caseId} current admin preview is present`);
    compareCurrentD7Case({ caseId, reference, expectation: evidence.expectations[caseId], actualResponse,
      actualPreview, currentDay });
    compareCurrentD7Case({ caseId, reference, expectation: evidence.expectations[caseId],
      actualResponse: directResponse, actualPreview, currentDay });
    compareCurrentD7Case({ caseId, reference, expectation: evidence.expectations[caseId],
      actualResponse: controllerResponse, actualPreview: controllerPreview, currentDay });
    assert.deepEqual(actualResponse.allowanceBreakdowns.days.map(({ day }) => day), currentQ1D7PublicDays(evidence.binding),
      `${caseId} served response contains all and only closed current public days`);

    assert.deepEqual(privacyViolations(f, edgeExchange, { ip }), [], `${caseId} edge S7 privacy`);
    const directExchanges = frontEnd.since(directMark);
    assert.equal(directExchanges.length, 1, `${caseId} direct read has exactly one origin exchange`);
    assert.ok(directExchanges[0].originStatus === 200, `${caseId} direct-origin exchange completed`);
    assert.deepEqual(frontEnd.refusals, [], `${caseId} edge reached no unrelated host`);
    assert.equal(instance.refusals.length, 0, `${caseId} gcp edge had no transport refusal`);

    const row = { stage: "S9", id: "current-worker-d1-d7-case", caseId, currentDay,
      graphDays: reference.graphDays.length, currentPublicDays: currentQ1D7PublicDays(evidence.binding).length,
      controllerResponseSha256: currentQ1D7JsonSha256(controllerResponse),
      edgeResponseSha256: createHash("sha256").update(answer.body).digest("hex"),
      directResponseSha256: createHash("sha256").update(direct.body).digest("hex"),
      controllerPreviewSha256: currentQ1D7JsonSha256(controllerPreview),
      edgePreviewSha256: currentQ1D7JsonSha256(actualPreview),
      schemaPairSha256: currentQ1D7JsonSha256({ schema, controlSchema }),
      edgeDirectBytesEqual: true, publicAndAdminComparisonsEqual: true };
    casesVerified.push(row);
    f.rows.push(row);

    if (caseId === "conflictFreePositive") {
      // Preserve the existing S9 edge write tier on the independent fully
      // published case, after its read comparisons have completed.
      const writes = [];
      const writeExchangeIps = new Map();
      const writesMark = frontEnd.mark();
      await liveWriteRows({ publicOrigin: EDGE_E2E_PUBLIC_ORIGIN, send: async (id, writePath, init = {}) => {
        const ip = nextIp();
        const mark = frontEnd.mark();
        const written = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}${writePath}`, { ip, ...init });
        for (const exchange of frontEnd.since(mark)) writeExchangeIps.set(exchange, ip);
        writes.push({ id, path: new URL(writePath, EDGE_E2E_PUBLIC_ORIGIN).pathname, status: written.status });
        return { answer: written, row: writes.at(-1) };
      } });
      assert.deepEqual(writes.slice(0, 3).map(({ status }) => status), [201, 201, 201]);
      const capabilities = writes.filter(({ path }) => path === "/api/v1/device/sync-capabilities-v1.2");
      assert.ok(capabilities.length >= 1 && capabilities.every(({ status }) => status === 200));
      assert.ok(writes.some(({ path: writePath, status }) => writePath === "/api/v1/me/telemetry-v12/domain-activate" && status === 201));
      for (const exchange of frontEnd.since(writesMark)) {
        const requestId = exchange.requestHeaders.find(([name]) => name === "x-tibotattle-edge-request-id")?.[1];
        assert.ok(typeof requestId === "string" && requestId.length > 0, "each positive-case write has a request id");
        assert.deepEqual(privacyViolations(f, exchange, { ip: writeExchangeIps.get(exchange) }), [], "positive-case write S7 privacy");
      }
      f.rows.push({ stage: "S9", id: "current-worker-d1-d7-positive-write-tier", statuses: writes.map(({ id, status }) => [id, status]) });
    }
  } finally {
    await instance?.dispose().catch(() => {});
    await origin.close().catch(() => {});
  }
}

async function runCurrentD7S9(f, testContext) {
  const seeded = await seededRehearsal();
  const rehearsal = seeded.report;
  const casesVerified = [];
  const dump = JSON.parse(await readFile(join(GOLDEN, "dump", "usage-monitor-db.json"), "utf8"));
  let evidence = null;
  try {
    await withCurrentD7OwnedSchemaCleanup(rehearsal, seeded.childCompletion,
      async (pairs) => {
        evidence = await readCurrentD7Evidence({ out: seeded.privateOutputPath, report: rehearsal,
          runtime: seeded.runtime, imageRuntime: seeded.imageRuntime });
        await preserveS9Artifact("s9-rehearsal", rehearsal);
        assert.equal(seeded.artifactsPreserved, true, "bounded child progress and completion records were preserved");
        assert.equal(seeded.temporaryOutputRemoved, false, "the private sidecars remain available through edge reads and cleanup");
        assert.deepEqual(pairs.map(({ caseId }) => caseId), CURRENT_D7_CASE_IDS);
        const byCase = new Map(pairs.map((pair) => [pair.caseId, pair]));
        for (const caseOutput of evidence.caseOutputs) {
          const pair = byCase.get(caseOutput.caseId);
          assert.ok(pair, `${caseOutput.caseId} retained pair exists`);
          await currentD7EdgeCase({ f, evidence, pair, caseOutput, dump, casesVerified });
        }
        assert.deepEqual(casesVerified.map(({ caseId }) => caseId), CURRENT_D7_CASE_IDS,
          "edge, direct origin, preview, privacy and contract checks ran for both cases");
      },
      async (names) => {
        for (const name of [...names].reverse()) await f.base.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        if (names.length > 0) {
          const remaining = await f.base.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname",
            [names]);
          assert.deepEqual(remaining.rows, [], "the exact four owned generated schemas are independently absent");
        }
      });
  } catch (error) {
    // The cleanup error may replace the failed-child rejection from the wrapper's
    // finally block. Preserve the captured failure diagnostic without replacing
    // whichever error actually escaped cleanup.
    if (seeded.childCompletion?.state === "failed") {
      testContext.diagnostic(JSON.stringify(currentD7FailureDiagnostic(rehearsal, seeded.childCompletion,
        seeded.lastValidatedControllerPhase)));
    }
    throw error;
  }
  await removeCurrentD7PrivateOutput(seeded);
  assert.equal(seeded.temporaryOutputRemoved, true);
  const caseSummaries = casesVerified.map(({ caseId, currentDay, graphDays, currentPublicDays, controllerResponseSha256,
    edgeResponseSha256, directResponseSha256, controllerPreviewSha256, edgePreviewSha256, schemaPairSha256,
    edgeDirectBytesEqual, publicAndAdminComparisonsEqual }) => ({ caseId, currentDay, graphDays, currentPublicDays,
    controllerResponseSha256, edgeResponseSha256, directResponseSha256, controllerPreviewSha256, edgePreviewSha256,
    schemaPairSha256, edgeDirectBytesEqual, publicAndAdminComparisonsEqual }));
  await preserveS9Artifact("s9-current-d7-cleanup", { schemaVersion: "current-q1-d7-s9-edge-cleanup-v1",
    caseIds: [...CURRENT_D7_CASE_IDS], schemaPairs: 2, schemasDroppedAndVerifiedAbsent: 4,
    acceptedD7DateSet: evidence.contract.acceptedD7DateSet, cases: caseSummaries,
    cleanupPending: false, establishesNativeExecution: false });
  f.rows.push({ stage: "S9", id: "current-worker-d1-d7-final-cleanup", caseCount: 2,
    schemaCount: 4, absentAfterOwnedDrop: true, sidecarsRemoved: seeded.temporaryOutputRemoved });
}

test(CURRENT_D7
  ? "S9 current D7: both current-source cases reproduce through edge and direct origin, with exact owned cleanup"
  : "S9 golden: the community/daily read is byte-equal through the edge and reproduces the rehearsal's parity table; "
    + "the live check's write tier completes on the seeded schema at the deploy's origin settings", {
  skip: SKIP || GOLDEN === null, timeout: 3_600_000,
}, async (testContext) => {
  const f = await fixture();
  if (CURRENT_D7) {
    await runCurrentD7S9(f, testContext);
    return;
  }
  const golden = JSON.parse(await readFile(join(GOLDEN, "community-daily-response.json"), "utf8"));
  const goldenPreview = JSON.parse(await readFile(join(GOLDEN, "preview.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(GOLDEN, "manifest.json"), "utf8"));
  const seeded = await seededRehearsal();
  const rehearsal = seeded.report;
  let origin = null;
  let instance = null;
  await withS9OwnedSchemaCleanup(rehearsal, async (kept) => {
    assertS9ChildCompleted(seeded.childCompletion);
    assert.equal(seeded.artifactsPreserved, true, "requested evidence is preserved without overwriting an existing artifact");
    assert.equal(seeded.temporaryOutputRemoved, true, "complete producer evidence was read and owned temporary output was removed");
    assert.notEqual(rehearsal.status, "error", JSON.stringify(rehearsal.error ?? null));
    if (CURRENT_Q1) {
      assert.equal(rehearsal.schemaVersion, "gcp-fastpath-current-rehearsal-report-v1");
      assert.equal(rehearsal.comparisonMode, "current-worker-d1");
      assert.equal(rehearsal.status, "pass", "all current producer, equality, input and idempotency gates passed");
      for (const name of CURRENT_GATES) assert.equal(rehearsal.gates?.[name], true, name);
      assert.ok(Object.values(rehearsal.gates).every((value) => value === true), "every retained gate passed");
      assert.equal(rehearsal.historicalComparison?.qualifying, false);
      assert.deepEqual(rehearsal.historicalComparison.parity, rehearsal.parity);
      assert.deepEqual(rehearsal.historicalComparison.perDate, rehearsal.perDate);
      await verifyCurrentS9Evidence({ ...seeded, report: rehearsal });
    }
    assert.equal(rehearsal.steps.read.status, 200);
    assert.ok(rehearsal.parity?.families, "the rehearsal produced a parity table");
    // The rehearsal keeps its one primary schema and the importers' control
    // schema; there is no deletion-ledger schema (LEAD-SIMP).
    const [schema, controlSchema] = kept;
    assert.equal(kept.length, 2, JSON.stringify(kept));
    assert.equal(controlSchema, `typed_legacy_transfer_rehearsal_ctl_${schema.slice(-8)}`);
    assert.equal(kept.some((name) => /ledger/u.test(name)), false, "no ledger schema is created");
    // What scripts/gcp-fastpath-test-deploy.mjs gives an edge-test origin over a
    // seeded schema: the golden's source (without it every typed route of the
    // live write tier answered 503 BACKEND_STORAGE_UNAVAILABLE, 2026-10-01) and
    // env.production's enrollment, accountless and sign-in settings.
    const dump = JSON.parse(await readFile(join(GOLDEN, "dump", "usage-monitor-db.json"), "utf8"));
    const settings = Object.fromEntries([...originSourceEnv(goldenSourceIdentity(dump)), ...edgeTestProductionEnv()]);
    origin = await startOrigin({ socket: f.socket, schema, keys: f.keys, nowMs: manifest.nowMs,
      objects: new Map(), settings });
    const frontEnd = createGoogleFrontEnd({ invoker: f.invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
      upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(origin.port) });
    instance = await createEdgeInstance({ ...f.common, mode: "gcp", frontEnd, invokerKeyJson: f.invoker.keyJson });
    const path = `/api/v1/community/daily?from=${golden.from}&to=${golden.to}`;
    const ip = nextIp();
    const answer = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}${path}`, { ip });
    assert.equal(answer.status, 200, answer.text.slice(0, 300));
    assert.equal(answer.header("cache-control"), rehearsal.steps.read.cacheControl);
    assert.equal(answer.body.length, rehearsal.steps.read.bytes, "the same bytes the rehearsal read directly");
    const [exchange] = frontEnd.exchanges;
    assert.deepEqual(transparencyMismatches(f, answer, exchange), []);
    assert.deepEqual(privacyViolations(f, exchange, { ip }), []);
    const direct = await frontEnd.direct({ path, email: EDGE_E2E_INVOKER, headers: {
      "x-tibotattle-edge-host": "apex", "x-tibotattle-edge-request-id": randomUUID(),
      "x-tibotattle-edge-admission": "v1;public_aggregate_read;allowed" } });
    assert.equal(direct.status, 200);
    assert.ok(answer.body.equals(direct.body), "the edge read equals a direct origin read byte for byte");
    const actualPreview = (await f.base.query(`SELECT preview FROM "${schema}".analytics_v2_preview WHERE id = 1`))
      .rows[0]?.preview ?? null;
    const actual = JSON.parse(answer.text);
    await preserveS9Artifact("s9-response", actual);
    await preserveS9Artifact("s9-preview", actualPreview);
    // Historical comparison remains byte-strict. Current qualification records
    // its table separately and grants none of its historical waivers.
    const perDateExpected = PER_DATE_EXPECTED === null ? null
      : perDateExpectationFor(JSON.parse(await readFile(PER_DATE_EXPECTED, "utf8")), manifest);
    const parity = compareAnalyticsV2Parity({ golden, actual, goldenPreview, actualPreview,
      withheldModelDates: withheldModelDatesOf(manifest), perDateExpected });
    assert.deepEqual(familyTable(parity), familyTable(rehearsal.parity),
      "the edge read reproduces the rehearsal's parity table on this commit");
    let currentContractParity = null;
    if (CURRENT_Q1) {
      // Conserve the immutable corpus independently of current D1 equality.
      // Historical contract and cache differences retain their own diagnostics.
      assert.ok(Array.isArray(golden.days) && golden.days.length > 0, "the immutable corpus contains daily evidence");
      assert.deepEqual(parity.days, { golden: golden.days.length, actual: golden.days.length,
        missingInActual: [], extraInActual: [] }, "every immutable corpus day is covered exactly");
      for (const family of ["daily-days", "daily-totals", "daily-cells", "daily-other"]) {
        const entries = parity.families.filter((entry) => entry.family === family);
        assert.equal(entries.length, 1, `the immutable corpus has exactly one ${family} comparison`);
        const expectedCount = family === "daily-days" ? 1 : golden.days.length;
        assert.equal(entries[0].expected, false, `${family} has no historical difference waiver`);
        assert.equal(entries[0].compared, expectedCount, `${family} compares the complete immutable corpus`);
        assert.equal(entries[0].equal, expectedCount, `${family} conserves every compared value`);
        assert.equal(entries[0].diffCount, 0, `the immutable corpus conserves ${family}`);
      }
      // Current equality includes refusals in the served response and preview.
      // PG's internal run history remains separate diagnostic evidence.
      currentContractParity = compareAnalyticsV2CurrentContract({ reference: seeded.evidence.reference,
        referenceBinding: seeded.evidence.binding, referenceSha256: rehearsal.currentReference.sha256,
        actual, actualPreview });
      assert.deepEqual(familyTable(currentContractParity), familyTable(rehearsal.currentContractParity),
        "the edge read reproduces the current Worker/D1 rehearsal table");
      for (const field of ["recomputationComplete", "corpusConvergenceComplete", "strictExportRefusalVerified"]) {
        assert.equal(currentContractParity[field], true, `the current reference preserves ${field}`);
      }
      for (const field of ["recomputationSha256", "corpusConvergenceSha256", "strictExportRefusalSha256"]) {
        assert.equal(currentContractParity[field], rehearsal.currentReference[field], `the comparison binds ${field}`);
      }
      assert.equal(currentContractParity.equal, true, "the full current response and preview equal fresh D1");
      assert.equal(currentContractParity.unexpectedDiffs, 0);
    } else if (perDateExpected !== null) {
      assert.equal(parity.unexpectedDiffs, 0, "the edge read equals the golden and its per-date expectation");
    }
    f.rows.push({ stage: "S9", id: "golden", comparisonMode: S9_COMPARISON_MODE, bytes: answer.body.length,
      sha256: createHash("sha256").update(answer.body).digest("hex"), cacheControl: answer.header("cache-control"),
      unexpectedDiffs: (currentContractParity ?? parity).unexpectedDiffs,
      unexpectedFamilies: (currentContractParity ?? parity).unexpectedFamilies,
      families: familyTable(currentContractParity ?? parity), rehearsalStatus: rehearsal.status,
      ...(CURRENT_Q1 ? { historicalComparison: { qualifying: false, families: familyTable(parity),
        unexpectedDiffs: parity.unexpectedDiffs, unexpectedFamilies: parity.unexpectedFamilies },
        currentContractParity: { ...currentContractParity, families: familyTable(currentContractParity) },
        currentReference: rehearsal.currentReference } : {}) });

    // The live check's write tier, unchanged, through the same edge: accountless
    // enrollment, ownership and v1.2 authorization, then one shipped-client v1.2
    // sync (capabilities, predecessor, day manifest, upload, activation).
    const writes = [];
    await liveWriteRows({ publicOrigin: EDGE_E2E_PUBLIC_ORIGIN, send: async (id, path, init = {}) => {
      const written = await instance.fetch(`${EDGE_E2E_PUBLIC_ORIGIN}${path}`, { ip: nextIp(), ...init });
      writes.push({ id, path: new URL(path, EDGE_E2E_PUBLIC_ORIGIN).pathname, status: written.status });
      return { answer: written, row: writes.at(-1) };
    } });
    assert.deepEqual(writes.slice(0, 3).map(({ status }) => status), [201, 201, 201]);
    const capabilities = writes.filter(({ path }) => path === "/api/v1/device/sync-capabilities-v1.2");
    assert.ok(capabilities.length >= 1 && capabilities.every(({ status }) => status === 200), JSON.stringify(writes));
    assert.ok(writes.some(({ path, status }) => path === "/api/v1/me/telemetry-v12/domain-activate" && status === 201));
    f.rows.push({ stage: "S9", id: "golden-write-tier", statuses: writes.map(({ id, status }) => [id, status]) });
  }, async (kept) => {
    await instance?.dispose().catch(() => {});
    await origin?.close().catch(() => {});
    for (const name of [...kept].reverse()) await f.base.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    if (kept.length > 0) {
      const remaining = await f.base.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname",
        [kept]);
      assert.deepEqual(remaining.rows, [], "the exact owned generated schemas are independently absent");
    }
  });
});

// ---------------------------------------------------------------------------
// S7 over the whole run, and the content-free report

test("S7 privacy over every exchange of the run; the gcp edge never touched storage; the report", {
  skip: SKIP, timeout: LONG,
}, async () => {
  const f = await fixture();
  assert.ok(f.allExchanges.length > 0);
  const ids = new Set();
  for (const { exchange, ip, row } of f.allExchanges) {
    assert.deepEqual(privacyViolations(f, exchange, { ip }), [], `${row}: S7`);
    const id = exchange.requestHeaders.find(([name]) => name === "x-tibotattle-edge-request-id")?.[1];
    assert.ok(!ids.has(id), `${row}: request id reused`);
    ids.add(id);
  }
  assert.deepEqual(f.frontEnd.refusals, [], "the edge reached no host but Google's two");
  assert.equal(f.edge.refusals.length, 0);
  const decoyTables = await f.edge.decoyDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' "
    + "AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").first();
  assert.equal(decoyTables.n, 0, "the gcp edge never wrote USAGE_MONITOR_DB");
  assert.equal((await f.edge.decoyBucket.list()).objects.length, 0, "the gcp edge never wrote QUARANTINE");
  const issued = f.frontEnd.tokenRequests.filter((request) => request.verdict === "issued").length;
  assert.ok(issued >= 1 && issued <= 6, `one ID-token exchange per edge isolate (${issued})`);

  if (process.env.EDGE_E2E_REPORT) {
    const framing = { contentLength: 0, chunked: 0, none: 0 };
    for (const { exchange } of f.allExchanges) {
      if (exchange.framing.chunked) framing.chunked += 1;
      else if (exchange.framing.contentLength !== null) framing.contentLength += 1;
      else framing.none += 1;
    }
    const report = {
      schemaVersion: "edge-origin-e2e-report-v1",
      node: process.version,
      bundle: { main: f.bundle.main, sha256: f.bundle.sha256, bytes: f.bundle.bytes, exports: f.bundle.exports,
        contractSha256: f.bundle.contractSha256 },
      compatibility: f.compatibility.e2e,
      exchanges: f.allExchanges.length,
      uniqueRequestIds: ids.size,
      framing,
      tokenExchangesIssued: issued,
      transportRetries: f.transportRetries,
      rows: f.rows,
    };
    await writeFile(resolve(process.env.EDGE_E2E_REPORT), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
});
