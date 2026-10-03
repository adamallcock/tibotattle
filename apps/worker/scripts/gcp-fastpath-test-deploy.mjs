#!/usr/bin/env node

/**
 * GCP fast-path test deployment (plan package D-1).
 *
 * Builds one commit through the reviewed Cloud Run source-archive tooling,
 * then creates or updates only `tibotattle-fastpath-test-*` resources in the
 * test project: the migrate Job, the analytics-refresh Job, an IAM-private
 * origin service, its bucket and the runtime account's one conditional
 * binding on that bucket. Every gcloud call carries --project=tibotattle; the shared
 * test services and schemas used by other lines are read, never written.
 *
 * Credentials: none are read, printed or stored. Database access uses Cloud
 * SQL IAM authentication; the verifier's ID token is minted by impersonating
 * the journey service account and held only in this process's memory.
 *
 *   node scripts/gcp-fastpath-test-deploy.mjs all --commit=<ref> [--now=<ISO>] [--dry-run]
 *   node scripts/gcp-fastpath-test-deploy.mjs <step> [options]
 *
 * Steps: build, database, migrate, verify-database, refresh, origin, verify,
 * protected, all. Run with --help for options.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

import { FASTPATH_TEST_CLOUD_TARGET } from "../cloud-run/origin-fastpath-mode.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");

// The origin and analytics-refresh accept exactly FASTPATH_TEST_CLOUD_TARGET
// (cloud-run/origin-fastpath-mode.mjs); the shared names come from it.
export const FASTPATH_TEST = Object.freeze({
  project: FASTPATH_TEST_CLOUD_TARGET.project,
  projectNumber: "806510610397",
  region: "us-east1",
  instance: "tibotattle-test-primary-20260922",
  instanceConnectionName: FASTPATH_TEST_CLOUD_TARGET.instanceConnectionName,
  database: FASTPATH_TEST_CLOUD_TARGET.database,
  primarySchema: FASTPATH_TEST_CLOUD_TARGET.primarySchema,
  imageRepository: "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host",
  buildBucket: "tibotattle-gcs-test-build-20260922",
  migrateJob: "tibotattle-fastpath-test-migrate",
  refreshJob: FASTPATH_TEST_CLOUD_TARGET.refreshJob,
  originService: FASTPATH_TEST_CLOUD_TARGET.originService,
  originUrl: "https://tibotattle-fastpath-test-origin-806510610397.us-east1.run.app",
  originBucket: "tibotattle-fastpath-test-20261001",
  migratorServiceAccount: "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com",
  runtimeServiceAccount: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
  journeyServiceAccount: "tibotattle-test-journey@tibotattle.iam.gserviceaccount.com",
  migratorIamUser: "tibotattle-test-migrator@tibotattle.iam",
  runtimeIamUser: FASTPATH_TEST_CLOUD_TARGET.iamUser,
  // Read before and after every run; this script never writes them.
  protectedServices: Object.freeze(["tibotattle-test-app", "tibotattle-test-oauth-gateway"]),
  // Existing test-only Secret Manager entries, referenced by name for the
  // origin container. Their values are never read by this script.
  originSecretRefs: Object.freeze({
    ENVELOPE_PUBLIC_JWK: "tibotattle-test-envelope-public-jwk-20260922",
    ENVELOPE_PRIVATE_JWK: "tibotattle-test-envelope-private-jwk-20260922",
    POSTGRES_RATE_LIMIT_SECRET: "tibotattle-test-rate-limit-secret-20260922",
  }),
  labels: Object.freeze({ app: "tibotattle", environment: "test", "managed-by": "claude-fastpath" }),
  // The edge sidecar forwards only these exact GET paths to the loopback origin.
  edgeGetPaths: Object.freeze(["/api/health", "/api/ready", "/api/v1/community/daily"]),
  originLoopbackPort: 8080,
  edgeIngressPort: 8081,
});

/**
 * The runtime service account's one binding on the origin bucket: the test
 * project's cleanup-storage custom role, conditioned to the bucket itself and
 * its telemetry/ objects. The account's only other storage grant is the same
 * role conditioned to the A2 bucket, so without this binding every origin
 * write answers 503 BACKEND_STORAGE_UNAVAILABLE (live edge write tier,
 * 2026-10-01). The expression holds no comma, so it renders as one
 * gcloud --condition value.
 */
export const ORIGIN_BUCKET_RUNTIME_BINDING = Object.freeze({
  role: "projects/tibotattle/roles/tibotattleTestCleanupStorage",
  member: `serviceAccount:${FASTPATH_TEST.runtimeServiceAccount}`,
  condition: Object.freeze({
    title: "TiboTattleFastpathTelemetry",
    expression: `(resource.type == "storage.googleapis.com/Bucket" && resource.name == "projects/_/buckets/${
      FASTPATH_TEST.originBucket}") || (resource.type == "storage.googleapis.com/Object" && resource.name.startsWith(`
      + `"projects/_/buckets/${FASTPATH_TEST.originBucket}/objects/telemetry/"))`,
  }),
});

const IMAGE_REFERENCE =
  /^us-east1-docker\.pkg\.dev\/tibotattle\/tibotattle-test\/tibotattle-host@sha256:([a-f0-9]{64})$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MIGRATION_FILE = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
// Refresh/origin read the pinned primary schema or a rehearsal target seeded
// into the same fast-path database by scripts/gcp-fastpath-seed.mjs (the
// local rehearsal's schema name: the fast-path target prefix and 8 hex).
const SCHEMA_OVERRIDE = /^(?:tibotattle_fastpath_20261001|typed_legacy_transfer_rehearsal_target_fastpath_[0-9a-f]{8})$/u;
/** The origin's injected route clock (cloud-run/origin-fastpath-mode.mjs analyticsV2TestClock). */
export const ORIGIN_TEST_CLOCK_ENV = "ANALYTICS_V2_TEST_NOW_MS";
/** cloud-run/origin-edge-test-mode.mjs EDGE_TEST_ORIGIN_MODE (its check pins them equal). */
export const EDGE_TEST_ORIGIN_MODE = "edge-test";
/**
 * The settings the fastpath-test origin's admission env reads
 * (cloud-run/server.mjs originAdmissionEnv) that wrangler.jsonc
 * env.production fixes. An edge-test origin serves the participant write
 * routes behind the edge, so it runs them at production's values, read from
 * the checked-in config, instead of the composition's closed defaults
 * (disabled, 120).
 */
export const EDGE_TEST_PRODUCTION_SETTINGS = Object.freeze([
  "ENROLLMENT_MODE", "ACCOUNTLESS_ENROLLMENT_MODE", "ACCOUNTLESS_OWNERSHIP_MODE", "SIGN_IN_START_MAX_PER_MINUTE",
  "PUBLIC_ANALYTICS_MODE",
  // The upload-ingress policy (D-CRB): the lease budget and the 60 s / 15 s
  // body read at production's values, as E12's origin runs them.
  "UPLOAD_INGRESS_MAX_CONCURRENT", "UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE", "UPLOAD_INGRESS_BURST",
  "UPLOAD_INGRESS_LEASE_SECONDS", "UPLOAD_INGRESS_BODY_TOTAL_SECONDS", "UPLOAD_INGRESS_BODY_IDLE_SECONDS",
]);
/** The rest of that admission env, and why an edge-test origin does not take production's value. */
export const EDGE_TEST_UNMIRRORED_SETTINGS = Object.freeze({
  ENVIRONMENT: "production's value makes every client rate-limit key need IDENTITY_LINK_SECRET, a production "
    + "secret this test origin never holds (src/admission.ts); it keeps its synthetic-development label",
  IDENTITY_LINK_SECRET: "a production secret, for the Google enrollment routes, which no test host mode composes "
    + "(the cloud-run-iam mode is retired, OD-6)",
  IDENTITY_LINK_SECRET_VERSION: "names that secret; Google enrollment routes only, not composed by any test mode",
  GOOGLE_OIDC_CLIENT_ID: "production's OAuth client, for the Google sign-in routes, which no test host mode composes",
  GOOGLE_OIDC_CLIENT_SECRET: "a production secret; Google sign-in routes only, not composed by any test mode",
  DEPLOYMENT_SOURCE_COMMIT: "not a wrangler.jsonc setting: production's comes from its deploy; unset, this test "
    + "origin's /api/health reports deployment.sourceCommit null, so the release verifier never accepts it",
});
/** A source id or typed-storage namespace the origin and an env flag both accept. */
const SOURCE_IDENTITY = /^[A-Za-z0-9._:-]{1,200}$/u;
const STEPS = Object.freeze([
  "build", "database", "migrate", "verify-database", "seed", "refresh", "origin", "verify", "protected", "all",
]);
const BUILD_TERMINAL = new Set(["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

function assertFastpathName(name) {
  if (typeof name !== "string" || !name.startsWith("tibotattle-fastpath-")
      || FASTPATH_TEST.protectedServices.includes(name)) {
    fail("FASTPATH_DEPLOY_TARGET_NOT_FASTPATH", String(name));
  }
  return name;
}

/** Shell-quote one argument for display only. */
export function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

function render(command) {
  return command.map(shellQuote).join(" ");
}

function gcloudArgs(args) {
  if (!args.includes(`--project=${FASTPATH_TEST.project}`)) fail("FASTPATH_DEPLOY_PROJECT_FLAG_MISSING");
  return ["gcloud", ...args];
}

function envFlag(entries) {
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key) || /[,\n]/u.test(String(value))) fail("FASTPATH_DEPLOY_ENV_INVALID", key);
  }
  return "--set-env-vars=" + entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function labelsFlag() {
  return "--labels=" + Object.entries(FASTPATH_TEST.labels).map(([k, v]) => `${k}=${v}`).join(",");
}

export function primarySchemaOf(schema = FASTPATH_TEST.primarySchema) {
  if (!SCHEMA_OVERRIDE.test(schema ?? "")) fail("FASTPATH_DEPLOY_SCHEMA_INVALID", String(schema));
  return schema;
}

function databaseEnv(schema) {
  return [
    ["GOOGLE_CLOUD_PROJECT", FASTPATH_TEST.project],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", FASTPATH_TEST.instanceConnectionName],
    ["PRIMARY_DATABASE", FASTPATH_TEST.database],
    ["PRIMARY_SCHEMA", primarySchemaOf(schema)],
  ];
}

function mergeEnv(base, overrides) {
  const merged = new Map(base);
  for (const [key, value] of overrides) merged.set(key, value);
  return [...merged.entries()];
}

/** EDGE_TEST_PRODUCTION_SETTINGS at wrangler.jsonc env.production's values, as env pairs. */
export function edgeTestProductionEnv(configText = readFileSync(join(WORKER_ROOT, "wrangler.jsonc"), "utf8")) {
  const errors = [];
  const vars = parseJsonc(configText, errors)?.env?.production?.vars;
  if (errors.length > 0 || vars === null || typeof vars !== "object") fail("FASTPATH_DEPLOY_PRODUCTION_CONFIG_INVALID");
  return EDGE_TEST_PRODUCTION_SETTINGS.map((name) => {
    if (typeof vars[name] !== "string" || vars[name].length === 0) fail("FASTPATH_DEPLOY_PRODUCTION_CONFIG_INVALID", name);
    return [name, vars[name]];
  });
}

/**
 * POSTGRES_SOURCE_ID and POSTGRES_SOURCE_NAMESPACE for the typed-storage
 * source a schema pins (scripts/gcp-fastpath-seed.mjs goldenSourceIdentity for
 * a seeded schema). The origin's typed routes refuse any other source with
 * 503 BACKEND_STORAGE_UNAVAILABLE, and an unset pair means the composition's
 * default source, which no seeded schema holds.
 */
export function originSourceEnv(sourceIdentity) {
  if (!SOURCE_IDENTITY.test(sourceIdentity?.sourceId ?? "")
      || !SOURCE_IDENTITY.test(sourceIdentity?.sourceNamespace ?? "")) {
    fail("FASTPATH_DEPLOY_SOURCE_IDENTITY_INVALID");
  }
  return [["POSTGRES_SOURCE_ID", sourceIdentity.sourceId], ["POSTGRES_SOURCE_NAMESPACE", sourceIdentity.sourceNamespace]];
}

/** gcloud command that creates or updates the fast-path migrate Job. */
export function migrateJobCommand({ image, expectedCounts }) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  // Primary only: the deletion ledger and its migration role are retired
  // (decisions D2, D4 and D6), and a counts record naming any other role is
  // a stale caller.
  if (expectedCounts === null || typeof expectedCounts !== "object"
      || Object.keys(expectedCounts).join(",") !== "primary"
      || !Number.isSafeInteger(expectedCounts.primary) || expectedCounts.primary < 1) {
    fail("FASTPATH_DEPLOY_EXPECTED_COUNTS_INVALID");
  }
  return gcloudArgs([
    "run", "jobs", "deploy", assertFastpathName(FASTPATH_TEST.migrateJob),
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`,
    `--image=${image}`,
    `--service-account=${FASTPATH_TEST.migratorServiceAccount}`,
    "--command=node", "--args=dist/test-migrations.mjs,--profile=fastpath",
    envFlag([
      ...databaseEnv(FASTPATH_TEST.primarySchema),
      ["POSTGRES_MIGRATOR_IAM_USER", FASTPATH_TEST.migratorIamUser],
      ["PRIMARY_EXPECTED_MIGRATIONS", String(expectedCounts.primary)],
    ]),
    "--tasks=1", "--parallelism=1", "--max-retries=0", "--task-timeout=1200s",
    "--cpu=1", "--memory=512Mi", labelsFlag(),
  ]);
}

/**
 * The analytics-refresh Job's task sizes (--refresh-profile).
 *
 * standard: the job's default per-owner memory budget (4,608 MiB,
 * cloud-run/analytics-refresh.mjs) plus its reserve needs a 6,144 MiB Node
 * heap, which an 8 GiB task holds with room for the runtime and native
 * buffers; Cloud Run allows 8 GiB with 2 vCPU (more memory needs 4 vCPU). One
 * owner's cold recompute is single-threaded and can take tens of minutes, so
 * the task timeout is two hours.
 *
 * dense: the dense-owner measurement profile (receipt
 * docs/receipts/2026-10-01-gcp-dense-owner-parity.md), which is the
 * production profile (OPS-2's ANALYTICS_REFRESH_TASK_PROFILE pins the two
 * equal). A 16 GiB task (Cloud Run needs 4 vCPU for it) with a 12,288 MiB
 * heap and a 10,752 MiB budget, which the memory model says admits the
 * largest real owner (about 2.52 million records) even when every record
 * falls in the 170 analysis days. Compute stays inline (one owner at a time);
 * the extra vCPUs are Cloud Run's minimum for the memory and serve the
 * garbage collector and the database driver. Four hours of task time cover
 * the local dense run several times over.
 *
 * dense-workers: the same task and budget with four compute Workers (K-PAR,
 * one per vCPU, the largest owner alone) and a 3,072 MiB main heap (runtime,
 * one read chunk, the output account). It is the MEAS-3 measurement of the
 * Workers' heap peaks on real owners, which the production profile waits for
 * (K-CORE-A review); it is not the production profile.
 */
export const REFRESH_JOB_PROFILES = Object.freeze({
  standard: Object.freeze({ cpu: 2, memory: "8Gi", heapMiB: 6_144, workers: 1, taskTimeoutSeconds: 7_200,
    env: Object.freeze([]) }),
  dense: Object.freeze({ cpu: 4, memory: "16Gi", heapMiB: 12_288, workers: 1, taskTimeoutSeconds: 14_400,
    env: Object.freeze([Object.freeze(["ANALYTICS_V2_MEMORY_BUDGET_MIB", "10752"])]) }),
  "dense-workers": Object.freeze({ cpu: 4, memory: "16Gi", heapMiB: 3_072, workers: 4, taskTimeoutSeconds: 14_400,
    env: Object.freeze([Object.freeze(["ANALYTICS_V2_MEMORY_BUDGET_MIB", "10752"])]) }),
});
/** The default (standard) profile; the local rehearsal runs its heap. */
export const REFRESH_JOB_RESOURCES = REFRESH_JOB_PROFILES.standard;
/** --corpus: the committed golden and the refresh profile each corpus seeds and sizes by default. */
export const FASTPATH_CORPORA = Object.freeze({
  q1: Object.freeze({ golden: "apps/worker/analytics-v2-test/golden", refreshProfile: "standard" }),
  dense: Object.freeze({ golden: "apps/worker/analytics-v2-test/golden-dense", refreshProfile: "dense" }),
});

function refreshProfile(name) {
  if (!Object.hasOwn(REFRESH_JOB_PROFILES, name ?? "")) fail("FASTPATH_DEPLOY_REFRESH_PROFILE_INVALID", String(name));
  return REFRESH_JOB_PROFILES[name];
}

/** gcloud command that creates or updates the analytics-refresh Job. */
export function refreshJobCommand({ image, now, schema, extraEnv = [], extraArgs = [], profile = "standard" }) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  if (now !== undefined && !ISO_INSTANT.test(now)) fail("FASTPATH_DEPLOY_NOW_INVALID");
  const resources = refreshProfile(profile);
  const args = [
    `--max-old-space-size=${resources.heapMiB}`,
    "dist/analytics-refresh.mjs", "--mode=full", `--schema=${primarySchemaOf(schema)}`,
    ...(now === undefined ? [] : [`--now=${now}`]),
    ...(resources.workers > 1 ? [`--workers=${resources.workers}`] : []),
    ...extraArgs,
  ];
  if (args.some((arg) => /[,\s]/u.test(arg))) fail("FASTPATH_DEPLOY_ARGS_INVALID");
  return gcloudArgs([
    "run", "jobs", "deploy", assertFastpathName(FASTPATH_TEST.refreshJob),
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`,
    `--image=${image}`,
    `--service-account=${FASTPATH_TEST.runtimeServiceAccount}`,
    "--command=node", `--args=${args.join(",")}`,
    envFlag(mergeEnv([
      ...databaseEnv(schema),
      ["POSTGRES_IAM_USER", FASTPATH_TEST.runtimeIamUser],
      ...(now === undefined ? [] : [["ANALYTICS_V2_TEST_CLOCK", "1"]]),
      ...resources.env,
    ], extraEnv)),
    "--tasks=1", "--parallelism=1", "--max-retries=0", `--task-timeout=${resources.taskTimeoutSeconds}s`,
    `--cpu=${resources.cpu}`, `--memory=${resources.memory}`, labelsFlag(),
  ]);
}

export function executeJobCommand(job) {
  return gcloudArgs([
    "run", "jobs", "execute", assertFastpathName(job),
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`,
    "--wait", "--format=json",
  ]);
}

/**
 * Minimal edge for the IAM-private test origin. Cloud Run's front end has
 * already enforced the invoker binding; the edge forwards only allowlisted
 * GET/HEAD paths to the loopback-only origin, rewrites Host to the loopback
 * origin, and strips IAM and forwarding headers.
 */
export const EDGE_PROXY_SOURCE = `
import http from "node:http";
const target = Number(process.env.ORIGIN_PORT);
const listen = Number(process.env.PORT);
const allowed = new Set(String(process.env.EDGE_GET_PATHS ?? "").split(",").filter(Boolean));
const dropped = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization",
  "x-serverless-authorization", "forwarded", "via"]);
function clean(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!dropped.has(key) && !key.startsWith("x-forwarded-")) out[key] = value;
  }
  return out;
}
import net from "node:net";
function originReady() {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port: target });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
  });
}
// Listen only after the loopback origin accepts connections, so Cloud Run's
// startup probe on the edge port also proves the origin started.
const deadline = Date.now() + 230000;
while (!(await originReady())) {
  if (Date.now() > deadline) process.exit(1);
  await new Promise((wait) => setTimeout(wait, 500));
}
http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://edge.invalid"); } catch { res.writeHead(400).end(); return; }
  if ((req.method !== "GET" && req.method !== "HEAD") || !allowed.has(url.pathname)) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"EDGE_ROUTE_CLOSED"}');
    return;
  }
  const headers = clean(req.headers);
  headers.host = "127.0.0.1:" + target;
  const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method,
    path: url.pathname + url.search, headers }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, clean(reply.headers));
    reply.pipe(res);
  });
  upstream.setTimeout(240000, () => upstream.destroy());
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
  upstream.end();
}).listen(listen, "0.0.0.0");
`;

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlLabels(indent) {
  return Object.entries(FASTPATH_TEST.labels)
    .map(([key, value]) => `${" ".repeat(indent)}${key}: ${yamlString(value)}`).join("\n");
}

/**
 * Knative service document for the origin. `sidecar` runs the image's
 * loopback-only test mode unchanged behind the edge container; `direct`
 * expects a Cloud Run listen-host variant of the test mode in the image.
 * A seeded schema needs its `sourceIdentity` (or both POSTGRES_SOURCE_*
 * values in originEnv); with EDGE_ORIGIN_MODE=edge-test in originEnv the
 * origin also takes `productionEnv` (default: edgeTestProductionEnv()).
 * originEnv overrides everything.
 */
export function renderOriginService({
  image,
  variant = "sidecar",
  mode = "fastpath-test",
  originEnv = [],
  bucketHistoryProof,
  schema,
  sourceIdentity = null,
  productionEnv,
}) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  if (!["sidecar", "direct"].includes(variant)) fail("FASTPATH_DEPLOY_ORIGIN_VARIANT_INVALID");
  if (typeof bucketHistoryProof !== "string" || bucketHistoryProof.length === 0) {
    fail("FASTPATH_DEPLOY_BUCKET_HISTORY_PROOF_REQUIRED");
  }
  const explicit = new Map(originEnv);
  const sourceEnv = sourceIdentity === null ? [] : originSourceEnv(sourceIdentity);
  if (primarySchemaOf(schema).startsWith(FASTPATH_TEST_CLOUD_TARGET.seededSchemaPrefix) && sourceEnv.length === 0
      && !(explicit.has("POSTGRES_SOURCE_ID") && explicit.has("POSTGRES_SOURCE_NAMESPACE"))) {
    fail("FASTPATH_DEPLOY_SOURCE_IDENTITY_REQUIRED", String(schema));
  }
  const edgeTest = explicit.get("EDGE_ORIGIN_MODE") === EDGE_TEST_ORIGIN_MODE;
  const loopbackOrigin = `http://127.0.0.1:${FASTPATH_TEST.originLoopbackPort}`;
  const env = mergeEnv([
    ...databaseEnv(schema),
    ["POSTGRES_IAM_USER", FASTPATH_TEST.runtimeIamUser],
    ["POSTGRES_TEST_HTTP_MODE", mode],
    ["ENVIRONMENT", "synthetic-development"],
    ["ANALYTICS_V2_ENABLED", "1"],
    ["GCS_BUCKET_NAME", FASTPATH_TEST.originBucket],
    // OD-2: the quarantine bucket's birth proof under its own name.
    ["GCS_QUARANTINE_BUCKET_HISTORY_PROOF", bucketHistoryProof],
    ...(variant === "sidecar"
      ? [["HOST", "127.0.0.1"], ["HOST_ORIGIN", loopbackOrigin]]
      : [["HOST", "0.0.0.0"], ["HOST_ORIGIN", FASTPATH_TEST.originUrl]]),
    ...sourceEnv,
    ...(edgeTest ? productionEnv ?? edgeTestProductionEnv() : []),
  ], originEnv);
  for (const [key] of env) {
    if (!ENV_KEY.test(key) || key === "PORT" || key.startsWith("K_")) fail("FASTPATH_DEPLOY_ENV_INVALID", key);
  }
  const envLines = [
    ...env.map(([key, value]) => `        - name: ${key}\n          value: ${yamlString(value)}`),
    ...Object.entries(FASTPATH_TEST.originSecretRefs).map(([key, secret]) =>
      `        - name: ${key}\n          valueFrom:\n            secretKeyRef:\n`
      + `              key: "1"\n              name: ${secret}`),
  ].join("\n");
  // The sidecar origin pins its loopback port through env(1) because PORT is
  // reserved in Cloud Run container env; it has no probe (loopback only).
  const originContainer = [
    "      - name: origin",
    `        image: ${image}`,
    ...(variant === "sidecar"
      ? ["        command: [\"env\"]",
        `        args: [\"PORT=${FASTPATH_TEST.originLoopbackPort}\", \"node\", \"dist/server.mjs\"]`]
      : ["        command: [\"node\"]", "        args: [\"dist/server.mjs\"]",
        "        ports:", "        - name: http1", "          containerPort: 8080"]),
    "        env:",
    envLines,
    "        resources:",
    "          limits:",
    "            cpu: \"1\"",
    "            memory: 1Gi",
    ...(variant === "direct" ? [
      "        startupProbe:",
      "          tcpSocket:",
      "            port: 8080",
      "          periodSeconds: 10",
      "          timeoutSeconds: 5",
      "          failureThreshold: 24",
    ] : []),
  ];
  const edgeContainer = variant === "sidecar" ? [
    "      - name: edge",
    `        image: ${image}`,
    "        command: [\"node\"]",
    `        args: ["--input-type=module", "--eval", ${yamlString(EDGE_PROXY_SOURCE)}]`,
    "        ports:",
    "        - name: http1",
    `          containerPort: ${FASTPATH_TEST.edgeIngressPort}`,
    "        env:",
    "        - name: ORIGIN_PORT",
    `          value: ${yamlString(FASTPATH_TEST.originLoopbackPort)}`,
    "        - name: EDGE_GET_PATHS",
    `          value: ${yamlString(FASTPATH_TEST.edgeGetPaths.join(","))}`,
    "        resources:",
    "          limits:",
    "            cpu: \"1\"",
    "            memory: 512Mi",
    "        startupProbe:",
    "          tcpSocket:",
    `            port: ${FASTPATH_TEST.edgeIngressPort}`,
    "          periodSeconds: 10",
    "          timeoutSeconds: 5",
    "          failureThreshold: 24",
  ] : [];
  return [
    "apiVersion: serving.knative.dev/v1",
    "kind: Service",
    "metadata:",
    `  name: ${assertFastpathName(FASTPATH_TEST.originService)}`,
    "  labels:",
    yamlLabels(4),
    "  annotations:",
    "    run.googleapis.com/ingress: all",
    "spec:",
    "  template:",
    "    metadata:",
    "      labels:",
    yamlLabels(8),
    "      annotations:",
    "        autoscaling.knative.dev/maxScale: \"1\"",
    "        run.googleapis.com/execution-environment: gen2",
    "        run.googleapis.com/startup-cpu-boost: \"true\"",
    "    spec:",
    `      serviceAccountName: ${FASTPATH_TEST.runtimeServiceAccount}`,
    "      timeoutSeconds: 300",
    "      containerConcurrency: 8",
    "      containers:",
    ...edgeContainer,
    ...originContainer,
    "",
  ].join("\n");
}

/**
 * The origin env with the injected test clock: the composition root reads
 * ANALYTICS_V2_TEST_NOW_MS (epoch milliseconds, fastpath-test only), so a
 * --now instant becomes exactly that variable. An explicit --origin-env
 * value for it wins.
 */
export function originClockEnv(originEnv, now) {
  const env = [...originEnv];
  if (now === undefined || env.some(([key]) => key === ORIGIN_TEST_CLOCK_ENV)) return env;
  if (!ISO_INSTANT.test(now)) fail("FASTPATH_DEPLOY_NOW_INVALID");
  env.push([ORIGIN_TEST_CLOCK_ENV, String(Date.parse(now))]);
  return env;
}

export function originInvokerCommand() {
  return gcloudArgs([
    "run", "services", "add-iam-policy-binding", assertFastpathName(FASTPATH_TEST.originService),
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`,
    `--member=serviceAccount:${FASTPATH_TEST.journeyServiceAccount}`,
    "--role=roles/run.invoker", "--format=json",
  ]);
}

/** Only the journey service account may hold run.invoker on the origin. */
export function validateOriginPolicy(policy) {
  const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
  for (const binding of bindings) {
    for (const member of binding.members ?? []) {
      if (member === "allUsers" || member === "allAuthenticatedUsers") {
        fail("FASTPATH_DEPLOY_ORIGIN_PUBLIC_INVOKER");
      }
    }
  }
  const invokers = bindings.filter(({ role }) => role === "roles/run.invoker")
    .flatMap(({ members }) => members ?? []).sort();
  if (invokers.length !== 1 || invokers[0] !== `serviceAccount:${FASTPATH_TEST.journeyServiceAccount}`) {
    fail("FASTPATH_DEPLOY_ORIGIN_INVOKER_UNEXPECTED", invokers.join(","));
  }
  return Object.freeze({ invokers });
}

/** Read-only gcloud command for the origin bucket's IAM policy. */
export function originBucketPolicyCommand() {
  return gcloudArgs([
    "storage", "buckets", "get-iam-policy", `gs://${assertFastpathName(FASTPATH_TEST.originBucket)}`,
    `--project=${FASTPATH_TEST.project}`, "--format=json",
  ]);
}

/** gcloud command that adds ORIGIN_BUCKET_RUNTIME_BINDING to the origin bucket. */
export function originBucketBindingCommand() {
  const { role, member, condition } = ORIGIN_BUCKET_RUNTIME_BINDING;
  if ([condition.title, condition.expression].some((value) => /[,\n]/u.test(value))) {
    fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_CONDITION_INVALID");
  }
  return gcloudArgs([
    "storage", "buckets", "add-iam-policy-binding", `gs://${assertFastpathName(FASTPATH_TEST.originBucket)}`,
    `--project=${FASTPATH_TEST.project}`, `--member=${member}`, `--role=${role}`,
    `--condition=expression=${condition.expression},title=${condition.title}`, "--format=json",
  ]);
}

/**
 * Check an origin bucket IAM policy: no public member anywhere, and the
 * runtime service account in at most one binding, which must be exactly
 * ORIGIN_BUCKET_RUNTIME_BINDING with no other member. Any other binding of
 * that account (another role, no or another condition, a second binding) is
 * refused, never repaired. Returns whether the binding is present; with
 * requirePresent its absence is refused too.
 */
export function validateOriginBucketPolicy(policy, { requirePresent = false } = {}) {
  const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
  for (const binding of bindings) {
    for (const member of binding?.members ?? []) {
      if (member === "allUsers" || member === "allAuthenticatedUsers") fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_PUBLIC");
    }
  }
  const { role, member, condition } = ORIGIN_BUCKET_RUNTIME_BINDING;
  const runtime = bindings.filter((binding) => (binding?.members ?? []).includes(member));
  const exact = (binding) => binding.role === role
    && binding.members.length === 1
    && binding.condition?.title === condition.title
    && binding.condition?.expression === condition.expression;
  if (runtime.length > 1 || (runtime.length === 1 && !exact(runtime[0]))) {
    fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_UNEXPECTED");
  }
  if (requirePresent && runtime.length === 0) fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_MISSING");
  return runtime.length === 1;
}

/**
 * Ensure ORIGIN_BUCKET_RUNTIME_BINDING on the origin bucket: read the policy,
 * add the binding only when the runtime account holds none, then read the
 * policy back and require exactly that binding. Dry-run prints all three.
 */
export function ensureOriginBucketRuntimeBinding(runner) {
  const read = originBucketPolicyCommand();
  const present = validateOriginBucketPolicy(runner.json(read, { read: true, placeholderJson: { bindings: [] } }));
  if (!present) runner.exec(originBucketBindingCommand());
  const { role, member, condition } = ORIGIN_BUCKET_RUNTIME_BINDING;
  validateOriginBucketPolicy(runner.json(read, { read: true,
    placeholderJson: { bindings: [{ role, members: [member], condition: { ...condition } }] } }),
  { requirePresent: true });
  return Object.freeze({ role, member, conditionTitle: condition.title, added: !present && !runner.dryRun });
}

/** Count promoted primary migrations in one commit's tree (there is no ledger role). */
export function countMigrationsAtCommit(commit, spawn = spawnSync) {
  const counts = {};
  for (const role of ["primary"]) {
    const listed = spawn("git", [
      "-C", REPOSITORY_ROOT, "ls-tree", "--name-only", commit, `apps/worker/postgres/migrations/${role}/`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (listed.status !== 0) fail("FASTPATH_DEPLOY_MIGRATION_LIST_FAILED", role);
    const names = listed.stdout.split("\n").filter(Boolean).map((path) => path.split("/").at(-1));
    const sql = names.filter((name) => MIGRATION_FILE.test(name)).sort();
    sql.forEach((name, index) => {
      if (Number(name.slice(0, 4)) !== index + 1) fail("FASTPATH_DEPLOY_MIGRATION_NUMBERING_GAP", `${role}/${name}`);
    });
    counts[role] = sql.length;
  }
  return Object.freeze(counts);
}

function parseArgs(argv) {
  const [step = "--help", ...rest] = argv;
  if (step === "--help" || step === "-h") return { step: "help" };
  if (!STEPS.includes(step)) fail("FASTPATH_DEPLOY_STEP_INVALID", step);
  const options = {
    step, dryRun: false, commit: undefined, image: undefined, now: undefined, out: undefined,
    variant: "sidecar", mode: "fastpath-test", refreshEnv: [], refreshArgs: [], originEnv: [],
    query: "from=2026-04-15&to=2026-10-01", skip: new Set(), noExecute: false,
    schema: undefined, golden: undefined, schemaSuffix: undefined, replaceSeed: false, sourceIdentity: undefined,
    corpus: undefined, dump: undefined, refreshProfile: undefined, resolvedGolden: undefined,
  };
  for (const argument of rest) {
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (argument === "--no-execute") { options.noExecute = true; continue; }
    if (argument === "--replace-seed") { options.replaceSeed = true; continue; }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", argument);
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0) fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", argument);
    if (key === "commit") options.commit = value;
    else if (key === "image") options.image = value;
    else if (key === "now") options.now = value;
    else if (key === "out") options.out = resolve(value);
    else if (key === "origin-variant") options.variant = value;
    else if (key === "origin-mode") options.mode = value;
    else if (key === "query") options.query = value;
    else if (key === "schema") options.schema = primarySchemaOf(value);
    else if (key === "golden") options.golden = value;
    else if (key === "corpus") options.corpus = value;
    else if (key === "dump") options.dump = resolve(value);
    else if (key === "refresh-profile") options.refreshProfile = value;
    else if (key === "schema-suffix") options.schemaSuffix = value;
    else if (key === "skip") value.split(",").forEach((item) => options.skip.add(item));
    else if (key === "refresh-arg") options.refreshArgs.push(value);
    else if (["refresh-env", "origin-env"].includes(key)) {
      const split = value.indexOf("=");
      if (split < 1) fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", argument);
      (key === "refresh-env" ? options.refreshEnv : options.originEnv)
        .push([value.slice(0, split), value.slice(split + 1)]);
    } else fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", argument);
  }
  if (options.image !== undefined && !IMAGE_REFERENCE.test(options.image)) {
    fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  }
  if (options.now !== undefined && !ISO_INSTANT.test(options.now)) fail("FASTPATH_DEPLOY_NOW_INVALID");
  if (!/^[A-Za-z0-9=&_.-]{0,256}$/u.test(options.query)) fail("FASTPATH_DEPLOY_QUERY_INVALID");
  if (options.schemaSuffix !== undefined && !/^[0-9a-f]{8}$/u.test(options.schemaSuffix)) {
    fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", "--schema-suffix is 8 lower-case hex digits");
  }
  if (options.corpus !== undefined) {
    if (!Object.hasOwn(FASTPATH_CORPORA, options.corpus)) fail("FASTPATH_DEPLOY_CORPUS_INVALID", options.corpus);
    if (options.golden !== undefined) fail("FASTPATH_DEPLOY_ARGUMENT_INVALID", "--corpus and --golden are exclusive");
    options.golden = FASTPATH_CORPORA[options.corpus].golden;
    options.refreshProfile ??= FASTPATH_CORPORA[options.corpus].refreshProfile;
  }
  options.refreshProfile ??= "standard";
  refreshProfile(options.refreshProfile);
  return options;
}

const HELP = `Usage: node scripts/gcp-fastpath-test-deploy.mjs <step> [options]
Steps:
  build            archive --commit through the reviewed tooling, Cloud Build it, tag fastpath-<sha12>
  database         create database ${FASTPATH_TEST.database} on ${FASTPATH_TEST.instance} if absent
  migrate          deploy + execute ${FASTPATH_TEST.migrateJob} (counts read from --commit's tree)
  verify-database  read-only receipt counts via the migrator IAM user (impersonated, Cloud SQL connector)
  seed             seed a typed_legacy_transfer_rehearsal_target_fastpath_<8 hex> schema in ${FASTPATH_TEST.database}
                   from the golden through the local rehearsal's own importer chain (scripts/gcp-fastpath-seed.mjs);
                   skips with its reason when a chain stage is absent at --commit; refresh and origin then read
                   that schema at the golden's clock unless --schema/--now say otherwise
  refresh          deploy + execute ${FASTPATH_TEST.refreshJob} (--refresh-profile: standard 2 vCPU, 8 GiB,
                   heap 6,144 MiB, 2 h; dense 4 vCPU, 16 GiB, heap 12,288 MiB, budget 10,752 MiB, 4 h;
                   dense-workers: dense with four compute Workers and a 3,072 MiB main heap, for MEAS-3)
  origin           create/verify gs://${FASTPATH_TEST.originBucket}; ensure the runtime SA's one binding on it
                   (condition ${ORIGIN_BUCKET_RUNTIME_BINDING.condition.title}, read back; any other runtime binding is
                   refused); deploy IAM-private ${FASTPATH_TEST.originService}; journey SA is the only invoker; a seeded
                   schema's origin gets the golden's POSTGRES_SOURCE_ID/POSTGRES_SOURCE_NAMESPACE, and
                   --origin-env=EDGE_ORIGIN_MODE=edge-test adds wrangler.jsonc env.production's
                   ${EDGE_TEST_PRODUCTION_SETTINGS.join(", ")}
  verify           GET /api/health and /api/v1/community/daily with a journey-SA ID token; save body
  protected        read the shared test services' revisions (never written)
  all              build, database, migrate, verify-database, seed, refresh, origin, verify, protected
Options:
  --commit=<ref>          commit to build (required for build, migrate and all)
  --image=<repo@sha256:>  use an existing image digest instead of building
  --now=<ISO instant>     injected clock (refresh --now + ANALYTICS_V2_TEST_CLOCK=1; origin ANALYTICS_V2_TEST_NOW_MS)
  --out=<dir>             receipt directory (default: $TMPDIR/tibotattle-fastpath-d1)
  --origin-variant=sidecar|direct   default sidecar (loopback origin behind an edge container)
  --origin-mode=<mode>    POSTGRES_TEST_HTTP_MODE for the origin (default fastpath-test)
  --origin-env=K=V        extra/override origin env (repeatable)
  --refresh-env=K=V       extra/override refresh env (repeatable)
  --refresh-arg=<arg>     extra refresh argument (repeatable)
  --query=<qs>            community/daily query (default from=2026-04-15&to=2026-10-01)
  --golden=<dir>          golden to seed from (default apps/worker/analytics-v2-test/golden)
  --corpus=q1|dense       seed a committed golden by name instead of --golden: q1 (the default) or dense
                          (golden-dense, which needs --dump); also picks the refresh profile unless given
  --dump=<path>           the golden's source dump when the golden commits only its digest (golden-dense);
                          refused unless its sha256 equals the golden manifest's sourceDump.jsonSha256;
                          seed, and origin over a seeded schema, refuse without it before any remote command
  --refresh-profile=standard|dense|dense-workers   the refresh Job's task size (default: the corpus's,
                          else standard)
  --schema-suffix=<hex8>  seeded schema suffix (default: from the commit and the golden dump digest)
  --replace-seed          drop and re-seed a seeded schema that lacks its completion marker
  --schema=<schema>       primary schema for refresh/origin: ${FASTPATH_TEST.primarySchema}
                          or typed_legacy_transfer_rehearsal_target_fastpath_<8 hex> (default: the seeded schema)
  --skip=a,b              skip steps inside "all"
  --no-execute            create/update Jobs without executing them
  --dry-run               print every command; run nothing remote and write nothing remote
`;

class Runner {
  constructor({ dryRun, out }) {
    this.dryRun = dryRun;
    this.out = out;
    this.log = [];
  }

  print(command, note) {
    const line = render(command);
    this.log.push(line);
    console.error(`${this.dryRun ? "[dry-run] " : "$ "}${line}${note ? `   # ${note}` : ""}`);
  }

  /** Remote write or read. Dry-run prints and returns the placeholder. */
  exec(command, { placeholder = "", input, read = false, allowFailure = false, quiet = false } = {}) {
    if (!quiet) this.print(command, read ? "read-only" : undefined);
    if (this.dryRun && !read) return { status: 0, stdout: placeholder, stderr: "", dry: true };
    if (this.dryRun && read) return { status: 0, stdout: placeholder, stderr: "", dry: true };
    const result = spawnSync(command[0], command.slice(1), {
      encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0 && !allowFailure) {
      const tail = String(result.stderr ?? "").split("\n").filter(Boolean).slice(-6).join(" | ");
      fail("FASTPATH_DEPLOY_COMMAND_FAILED", `${command.slice(0, 4).join(" ")} :: ${tail}`);
    }
    return result;
  }

  json(command, options = {}) {
    const result = this.exec(command, options);
    if (result.dry) return options.placeholderJson ?? null;
    if (result.status !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { fail("FASTPATH_DEPLOY_JSON_INVALID", command[1]); }
  }

  async receipt(name, value) {
    await mkdir(this.out, { recursive: true, mode: 0o700 });
    const path = join(this.out, name);
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    return path;
  }
}

function resolveCommit(ref) {
  if (typeof ref !== "string" || ref.length === 0) fail("FASTPATH_DEPLOY_COMMIT_REQUIRED");
  const resolved = spawnSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const commit = resolved.stdout?.trim();
  if (resolved.status !== 0 || !COMMIT.test(commit ?? "")) fail("FASTPATH_DEPLOY_COMMIT_UNRESOLVED", ref);
  return commit;
}

function commitHasRefreshEntry(commit) {
  const shown = spawnSync("git", ["-C", REPOSITORY_ROOT, "show", `${commit}:apps/worker/cloud-run/build.mjs`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return shown.status === 0 && shown.stdout.includes("\"analytics-refresh\"");
}

async function stepBuild(runner, options) {
  const commit = resolveCommit(options.commit);
  const short = commit.slice(0, 12);
  // realpath: the reviewed tools compare import.meta.url with argv[1], and
  // macOS tmpdir() is a symlink (/var -> /private/var).
  const work = await realpath(await mkdtemp(join(tmpdir(), `tibotattle-fastpath-src-${short}-`)));
  try {
    const tree = join(work, "tree");
    await mkdir(tree);
    const tarPath = join(work, "source.tar");
    // Export the exact commit; never the (possibly dirty) checkout.
    runner.exec(["git", "-C", REPOSITORY_ROOT, "archive", "--format=tar", `--output=${tarPath}`, commit,
      "--", "apps/worker", "apps/web/public", "packages"], { read: true });
    if (!runner.dryRun) runner.exec(["tar", "-xf", tarPath, "-C", tree], { read: true, quiet: true });
    const archivePath = join(runner.out, `source-${short}.tar.gz`);
    await rm(archivePath, { force: true });
    await rm(archivePath + ".cloudbuild.yaml", { force: true });
    await mkdir(runner.out, { recursive: true, mode: 0o700 });
    const archiveTool = join(tree, "apps/worker/scripts/cloud-run-build-archive.mjs");
    let archive;
    if (runner.dryRun) {
      runner.print([process.execPath, archiveTool, `--output=${archivePath}`], "local archive");
      archive = {
        sourceContentDigest: "<source-content-digest>", sourceArchiveSha256: "<archive-sha256>",
        suggestedSourceObject: "source/cloud-run-host-<digest>-<sha>.tar.gz",
        buildConfigSha256: "<cloudbuild-sha256>", buildConfigPath: archivePath + ".cloudbuild.yaml",
      };
    } else {
      const created = runner.exec([process.execPath, archiveTool, `--output=${archivePath}`], { read: true });
      try { archive = JSON.parse(created.stdout); } catch { fail("FASTPATH_DEPLOY_ARCHIVE_RECEIPT_MISSING"); }
      if (archive.status !== "ok") fail("FASTPATH_DEPLOY_ARCHIVE_FAILED");
    }
    const sourceUri = `gs://${FASTPATH_TEST.buildBucket}/${archive.suggestedSourceObject}`;
    const existing = runner.exec(gcloudArgs(["storage", "objects", "describe", sourceUri,
      `--project=${FASTPATH_TEST.project}`, "--format=value(generation)"]),
    { read: true, allowFailure: true, placeholder: "" });
    if (existing.status !== 0 || String(existing.stdout).trim() === "") {
      runner.exec(gcloudArgs(["storage", "cp", archivePath, sourceUri,
        `--project=${FASTPATH_TEST.project}`, "--if-generation-match=0"]));
    }
    const generation = String(runner.exec(gcloudArgs(["storage", "objects", "describe", sourceUri,
      `--project=${FASTPATH_TEST.project}`, "--format=value(generation)"]),
    { read: true, placeholder: "<generation>" }).stdout).trim();
    const submitTool = join(tree, "apps/worker/scripts/cloud-run-source-build-submit.mjs");
    const submitted = runner.exec([process.execPath, submitTool,
      `--archive=${archivePath}`, `--archive-sha256=${archive.sourceArchiveSha256}`,
      `--source-digest=${archive.sourceContentDigest}`, `--source-bucket=${FASTPATH_TEST.buildBucket}`,
      `--source-object=${archive.suggestedSourceObject}`, `--source-generation=${generation}`,
      `--build-config=${archive.buildConfigPath}`, `--build-config-sha256=${archive.buildConfigSha256}`],
    { placeholder: JSON.stringify({ status: "submitted", buildId: "<build-id>" }) });
    const buildId = JSON.parse(submitted.stdout).buildId;
    if (!runner.dryRun && !BUILD_ID.test(buildId ?? "")) fail("FASTPATH_DEPLOY_BUILD_ID_INVALID");
    const describe = gcloudArgs(["builds", "describe", buildId, `--project=${FASTPATH_TEST.project}`,
      `--region=${FASTPATH_TEST.region}`, "--format=json"]);
    let build = null;
    const started = Date.now();
    if (runner.dryRun) runner.print(describe, "poll until terminal");
    while (!runner.dryRun) {
      build = runner.json(describe, { read: true, quiet: true });
      if (BUILD_TERMINAL.has(build?.status)) break;
      if (Date.now() - started > 25 * 60_000) fail("FASTPATH_DEPLOY_BUILD_TIMEOUT", buildId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
    }
    if (!runner.dryRun && build.status !== "SUCCESS") fail("FASTPATH_DEPLOY_BUILD_FAILED", `${buildId} ${build.status}`);
    const digest = runner.dryRun ? "sha256:<digest>" : build.results?.images?.[0]?.digest;
    if (!runner.dryRun && (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? "")
        || build.source?.storageSource?.object !== archive.suggestedSourceObject
        || String(build.source?.storageSource?.generation) !== generation)) {
      fail("FASTPATH_DEPLOY_BUILD_PROVENANCE_UNEXPECTED", buildId);
    }
    const image = `${FASTPATH_TEST.imageRepository}@${digest}`;
    const tag = `${FASTPATH_TEST.imageRepository}:fastpath-${short}`;
    runner.exec(gcloudArgs(["artifacts", "docker", "tags", "add", image, tag,
      `--project=${FASTPATH_TEST.project}`]));
    const receipt = {
      step: "build", commit, image, tag, buildId, sourceUri, generation,
      sourceContentDigest: archive.sourceContentDigest, sourceArchiveSha256: archive.sourceArchiveSha256,
      buildStatus: build?.status ?? "dry-run", buildStartTime: build?.startTime, buildFinishTime: build?.finishTime,
      migrations: countMigrationsAtCommit(commit), refreshEntry: commitHasRefreshEntry(commit),
    };
    if (!runner.dryRun) receipt.path = await runner.receipt(`build-${short}.json`, receipt);
    return receipt;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function stepDatabase(runner) {
  const describe = runner.exec(gcloudArgs(["sql", "databases", "describe", FASTPATH_TEST.database,
    `--instance=${FASTPATH_TEST.instance}`, `--project=${FASTPATH_TEST.project}`, "--format=value(name)"]),
  { read: true, allowFailure: true, placeholder: "" });
  const exists = describe.status === 0 && String(describe.stdout).trim() === FASTPATH_TEST.database;
  if (!exists) {
    runner.exec(gcloudArgs(["sql", "databases", "create", FASTPATH_TEST.database,
      `--instance=${FASTPATH_TEST.instance}`, `--project=${FASTPATH_TEST.project}`]));
  }
  return { step: "database", database: FASTPATH_TEST.database, created: !exists && !runner.dryRun };
}

async function jobExecutionResult(runner, job, execution) {
  const filter = [
    "resource.type=\"cloud_run_job\"",
    `resource.labels.job_name="${job}"`,
    `labels."run.googleapis.com/execution_name"="${execution.metadata?.name}"`,
  ].join(" AND ");
  const read = gcloudArgs(["logging", "read", filter, `--project=${FASTPATH_TEST.project}`,
    "--format=json", "--limit=200", "--freshness=2h"]);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const entries = runner.json(read, { read: true, quiet: attempt > 0 }) ?? [];
    const lines = entries.map((entry) => entry.jsonPayload ?? (() => {
      try { return JSON.parse(entry.textPayload ?? ""); } catch { return null; }
    })()).filter((value) => value && typeof value === "object" && typeof value.status === "string");
    if (lines.length > 0) return lines;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
  return [];
}

async function deployAndExecuteJob(runner, options, job, deployCommand) {
  runner.exec(deployCommand);
  if (options.noExecute) return { job, executed: false };
  let execution = runner.json(executeJobCommand(job), {
    allowFailure: true, placeholderJson: { metadata: { name: "<execution>" }, status: {} },
  });
  if (runner.dryRun) return { job, executed: "dry-run" };
  if (!execution?.metadata?.name) {
    // A failed execution makes `execute --wait` exit non-zero without JSON.
    execution = (runner.json(gcloudArgs(["run", "jobs", "executions", "list", `--job=${job}`,
      `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`, "--limit=1", "--format=json"]),
    { read: true }) ?? [])[0] ?? null;
  }
  const status = execution?.status ?? {};
  const succeeded = Number(status.succeededCount ?? 0) === 1 && Number(status.failedCount ?? 0) === 0;
  const lines = execution?.metadata?.name ? await jobExecutionResult(runner, job, execution) : [];
  return {
    job,
    execution: execution?.metadata?.name ?? null,
    succeeded,
    startTime: status.startTime ?? null,
    completionTime: status.completionTime ?? null,
    durationSeconds: status.startTime && status.completionTime
      ? (Date.parse(status.completionTime) - Date.parse(status.startTime)) / 1000 : null,
    results: lines,
  };
}

async function stepMigrate(runner, options, image) {
  const commit = resolveCommit(options.commit);
  const expectedCounts = countMigrationsAtCommit(commit);
  const result = await deployAndExecuteJob(runner, options, FASTPATH_TEST.migrateJob,
    migrateJobCommand({ image, expectedCounts }));
  const ok = result.results?.find((line) => line.status === "ok");
  const receipt = { step: "migrate", commit, image, expectedCounts, ...result,
    applied: ok ? { primary: ok.migrations?.primary?.applied } : null };
  if (!runner.dryRun && !options.noExecute) {
    receipt.path = await runner.receipt(`migrate-${commit.slice(0, 12)}.json`, receipt);
    if (!result.succeeded || ok === undefined
        || ok.migrations?.primary?.applied !== expectedCounts.primary
        || Object.keys(ok.migrations ?? {}).join(",") !== "primary") {
      fail("FASTPATH_DEPLOY_MIGRATE_FAILED", JSON.stringify(result.results?.at(-1) ?? null));
    }
  }
  return receipt;
}

/** Read-only check, as the impersonated migrator, of the receipt chains. */
async function stepVerifyDatabase(runner) {
  const command = gcloudArgs(["auth", "print-access-token",
    `--impersonate-service-account=${FASTPATH_TEST.migratorServiceAccount}`, `--project=${FASTPATH_TEST.project}`]);
  runner.print(command, "token kept in memory; Cloud SQL connector, BEGIN READ ONLY");
  if (runner.dryRun) return { step: "verify-database", dryRun: true };
  const minted = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (minted.status !== 0) fail("FASTPATH_DEPLOY_IMPERSONATION_FAILED", "migrator");
  const cloudRunRequire = createRequire(join(WORKER_ROOT, "cloud-run/package.json"));
  const { Connector } = await import(pathToFileURL(cloudRunRequire.resolve("@google-cloud/cloud-sql-connector")).href);
  const { OAuth2Client } = cloudRunRequire("google-auth-library");
  const pg = cloudRunRequire("pg");
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: minted.stdout.trim(), expiry_date: Date.now() + 30 * 60_000 });
  const connector = new Connector({ auth });
  let pool;
  try {
    const options = await connector.getOptions({
      instanceConnectionName: FASTPATH_TEST.instanceConnectionName, authType: "IAM", ipType: "PUBLIC",
    });
    pool = new pg.Pool({ ...options, user: FASTPATH_TEST.migratorIamUser, database: FASTPATH_TEST.database,
      max: 1, application_name: "tibotattle-fastpath-d1-verify" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const row = async (sql, params) => (await client.query(sql, params)).rows;
      const result = { step: "verify-database", database: FASTPATH_TEST.database };
      for (const [role, schema] of [["primary", FASTPATH_TEST.primarySchema]]) {
        const [history] = await row(`SELECT count(*)::int AS applied, max(version)::int AS latest
          FROM "${schema}"."_tibotattle_migration_history"`);
        const [tables] = await row(`SELECT count(*)::int AS relations FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')`, [schema]);
        result[role] = { schema, ...history, ...tables };
      }
      result.schemas = await row(`SELECT nspname AS schema, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`);
      await client.query("ROLLBACK");
      result.path = await runner.receipt("verify-database.json", result);
      return result;
    } finally {
      client.release();
    }
  } finally {
    await pool?.end().catch(() => {});
    connector.close();
  }
}

function isSeededSchema(schema) {
  return primarySchemaOf(schema).startsWith(FASTPATH_TEST_CLOUD_TARGET.seededSchemaPrefix);
}

/** The golden's manifest, dump digest, clock and source, read once per run (read-only). */
async function seedGolden(options) {
  if (options.resolvedGolden === undefined) {
    const seedModule = await import("./gcp-fastpath-seed.mjs");
    options.resolvedGolden = await seedModule.readSeedGolden(options.golden, { dump: options.dump });
  }
  return options.resolvedGolden;
}

/**
 * Whether a selected step reads the golden: the seed, and an origin over a
 * seeded schema, which is configured with the source the golden's dump pins.
 */
export function stepsReadGolden(steps, options) {
  return steps.includes("seed") || (steps.includes("origin") && isSeededSchema(options.schema));
}

async function stepSeed(runner, options) {
  const commit = resolveCommit(options.commit);
  const seedModule = await import("./gcp-fastpath-seed.mjs");
  const plan = seedModule.planSeed(commit, { golden: options.golden });
  runner.print([process.execPath, join(WORKER_ROOT, "scripts/gcp-fastpath-seed.mjs"), "seed",
    "--target=gcp-fastpath", `--commit=${commit}`, `--golden=${plan.golden}`,
    ...(options.dump === undefined ? [] : [`--dump=${options.dump}`]),
    ...(options.schemaSuffix === undefined ? [] : [`--schema-suffix=${options.schemaSuffix}`]),
    ...(options.replaceSeed ? ["--replace"] : [])],
  `plan: ${plan.decision}; stages ${plan.stages.map(({ name, status }) => `${name}=${status}`).join(", ")}`);
  if (runner.dryRun) {
    // Read-only: name the schema and clock the seed would hand to refresh and origin.
    if (plan.decision === "run") {
      const golden = await seedGolden(options);
      const schema = seedModule.seededSchemas(options.schemaSuffix
        ?? seedModule.defaultSuffix(commit, golden.dumpSha256)).target;
      if (options.schema === undefined) options.schema = schema;
      if (options.now === undefined) options.now = golden.nowIso;
      if (options.schema === schema) options.sourceIdentity ??= golden.sourceIdentity;
      return { step: "seed", dryRun: true, schema, nowIso: golden.nowIso, dumpSha256: golden.dumpSha256,
        sourceIdentity: golden.sourceIdentity, plan };
    }
    return { step: "seed", dryRun: true, plan };
  }
  const result = await seedModule.runGcpFastpathSeed({ commit, golden: options.golden, dump: options.dump,
    schemaSuffix: options.schemaSuffix, replace: options.replaceSeed });
  if (result.status !== "skipped") {
    // Refresh and origin read the seeded schema at the golden's clock unless
    // told otherwise, so they serve what the local rehearsal serves.
    if (options.schema === undefined) options.schema = result.schema;
    if (options.now === undefined) options.now = result.nowIso;
    // The origin over this schema is told the source it pins (read back by the seed).
    if (options.schema === result.schema) options.sourceIdentity ??= result.sourceIdentity;
  }
  const receipt = { ...result, path: await runner.receipt(`seed-${commit.slice(0, 12)}.json`, result) };
  return receipt;
}

async function stepRefresh(runner, options, image) {
  if (options.commit !== undefined && !commitHasRefreshEntry(resolveCommit(options.commit))) {
    fail("FASTPATH_DEPLOY_REFRESH_ENTRY_ABSENT", "cloud-run/build.mjs has no analytics-refresh entry at --commit");
  }
  const result = await deployAndExecuteJob(runner, options, FASTPATH_TEST.refreshJob,
    refreshJobCommand({ image, now: options.now, schema: options.schema, extraEnv: options.refreshEnv,
      extraArgs: options.refreshArgs, profile: options.refreshProfile }));
  const receipt = { step: "refresh", image, schema: primarySchemaOf(options.schema), now: options.now ?? null,
    profile: options.refreshProfile, resources: REFRESH_JOB_PROFILES[options.refreshProfile], ...result };
  if (!runner.dryRun && !options.noExecute) {
    receipt.path = await runner.receipt("refresh.json", receipt);
    if (!result.succeeded) fail("FASTPATH_DEPLOY_REFRESH_FAILED", JSON.stringify(result.results?.at(-1) ?? null));
  }
  return receipt;
}

function ensureOriginBucket(runner) {
  const uri = `gs://${FASTPATH_TEST.originBucket}`;
  const describe = gcloudArgs(["storage", "buckets", "describe", uri, `--project=${FASTPATH_TEST.project}`, "--format=json"]);
  let bucket = runner.json(describe, { read: true, allowFailure: true, placeholderJson: null });
  if (bucket === null) {
    runner.exec(gcloudArgs(["storage", "buckets", "create", uri, `--project=${FASTPATH_TEST.project}`,
      `--location=${FASTPATH_TEST.region}`, "--uniform-bucket-level-access", "--public-access-prevention",
      "--soft-delete-duration=0", "--default-storage-class=STANDARD"]));
    bucket = runner.json(describe, { read: true, placeholderJson: null });
  }
  let proof;
  if (runner.dryRun) {
    proof = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "<generation>",
      bucketMetageneration: "<metageneration>", softDeleteRetentionDurationSeconds: "0" });
  } else {
    const retention = String(bucket?.soft_delete_policy?.retentionDurationSeconds ?? "0");
    if (bucket?.name !== FASTPATH_TEST.originBucket || retention !== "0"
        || !/^\d+$/u.test(String(bucket?.generation ?? "")) || !/^\d+$/u.test(String(bucket?.metageneration ?? ""))) {
      fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_UNEXPECTED");
    }
    proof = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: String(bucket.generation),
      bucketMetageneration: String(bucket.metageneration), softDeleteRetentionDurationSeconds: "0" });
  }
  // Before the origin is deployed or used: the runtime account's bucket binding.
  return { proof, binding: ensureOriginBucketRuntimeBinding(runner) };
}

async function stepOrigin(runner, options, image) {
  // Resolved before the bucket write: without the seed step in this run, a seeded
  // schema holds the golden's source (a golden that commits only its dump digest
  // needs the same --dump the seed used), so its refusal precedes every write.
  let sourceIdentity = options.sourceIdentity ?? null;
  if (sourceIdentity === null && isSeededSchema(options.schema)) {
    sourceIdentity = (await seedGolden(options)).sourceIdentity;
  }
  const { proof: bucketHistoryProof, binding: bucketBinding } = ensureOriginBucket(runner);
  const originEnv = originClockEnv(options.originEnv, options.now);
  const yaml = renderOriginService({ image, variant: options.variant, mode: options.mode, originEnv,
    bucketHistoryProof, schema: options.schema, sourceIdentity });
  await mkdir(runner.out, { recursive: true, mode: 0o700 });
  const yamlPath = join(runner.out, "origin-service.yaml");
  await writeFile(yamlPath, yaml, { mode: 0o600 });
  runner.exec(gcloudArgs(["run", "services", "replace", yamlPath, `--project=${FASTPATH_TEST.project}`,
    `--region=${FASTPATH_TEST.region}`, "--format=json"]));
  runner.exec(originInvokerCommand());
  const policy = runner.json(gcloudArgs(["run", "services", "get-iam-policy", FASTPATH_TEST.originService,
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`, "--format=json"]),
  { read: true, placeholderJson: { bindings: [{ role: "roles/run.invoker",
    members: [`serviceAccount:${FASTPATH_TEST.journeyServiceAccount}`] }] } });
  const invokers = validateOriginPolicy(policy);
  const service = runner.json(gcloudArgs(["run", "services", "describe", FASTPATH_TEST.originService,
    `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`, "--format=json"]),
  { read: true, placeholderJson: {} });
  const receipt = { step: "origin", image, schema: primarySchemaOf(options.schema), variant: options.variant,
    mode: options.mode, sourceIdentity, yamlPath, bucketBinding, ...invokers,
    revision: service?.status?.latestReadyRevisionName ?? null, url: service?.status?.url ?? null };
  if (!runner.dryRun) receipt.path = await runner.receipt("origin.json", receipt);
  return receipt;
}

async function stepVerify(runner, options) {
  const command = gcloudArgs(["auth", "print-identity-token",
    `--impersonate-service-account=${FASTPATH_TEST.journeyServiceAccount}`,
    `--audiences=${FASTPATH_TEST.originUrl}`, "--include-email", `--project=${FASTPATH_TEST.project}`]);
  runner.print(command, "token kept in memory");
  const targets = [`/api/health`, `/api/v1/community/daily?${options.query}`];
  for (const path of targets) runner.print(["GET", FASTPATH_TEST.originUrl + path], "Authorization: Bearer <journey ID token>");
  if (runner.dryRun) return { step: "verify", dryRun: true };
  const minted = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (minted.status !== 0) fail("FASTPATH_DEPLOY_IMPERSONATION_FAILED", "journey");
  let token = minted.stdout.trim();
  const responses = [];
  try {
    for (const path of targets) {
      let response;
      // A fresh invoker binding can take a few minutes to reach the front end;
      // retry only the front end's 403, bounded, then record what it returned.
      for (let attempt = 0; attempt < 18; attempt += 1) {
        response = await fetch(FASTPATH_TEST.originUrl + path, {
          method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(300_000),
        });
        if (response.status !== 403) break;
        await response.arrayBuffer();
        await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
      }
      const body = Buffer.from(await response.arrayBuffer());
      const name = path.startsWith("/api/health") ? "health" : "community-daily";
      const bodyPath = join(runner.out, `${name}-response.body`);
      await mkdir(runner.out, { recursive: true, mode: 0o700 });
      await writeFile(bodyPath, body, { mode: 0o600 });
      responses.push({ path, status: response.status, contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"), bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"), bodyPath });
    }
  } finally {
    token = "";
  }
  const receipt = { step: "verify", origin: FASTPATH_TEST.originUrl, responses };
  receipt.path = await runner.receipt("verify.json", receipt);
  return receipt;
}

function stepProtected(runner) {
  const services = {};
  for (const name of FASTPATH_TEST.protectedServices) {
    const described = runner.json(gcloudArgs(["run", "services", "describe", name,
      `--project=${FASTPATH_TEST.project}`, `--region=${FASTPATH_TEST.region}`, "--format=json"]),
    { read: true, placeholderJson: {} });
    services[name] = {
      latestReadyRevision: described?.status?.latestReadyRevisionName ?? null,
      image: described?.spec?.template?.spec?.containers?.[0]?.image ?? null,
    };
  }
  return { step: "protected", services };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.step === "help") {
    console.log(HELP);
    return null;
  }
  const out = options.out ?? join(tmpdir(), "tibotattle-fastpath-d1");
  if (!isAbsolute(out) || out === REPOSITORY_ROOT || out.startsWith(REPOSITORY_ROOT + "/")) {
    fail("FASTPATH_DEPLOY_OUTPUT_INVALID");
  }
  const runner = new Runner({ dryRun: options.dryRun, out });
  const steps = options.step === "all"
    ? ["protected", "build", "database", "migrate", "verify-database", "seed", "refresh", "origin", "verify",
      "protected"]
      .filter((step) => !options.skip.has(step))
    : [options.step];
  // Before the first remote command: a golden that a selected step reads must
  // resolve here (one that commits only its dump digest needs --dump, of that
  // digest), so its refusal never follows a build, migration or bucket write.
  if (stepsReadGolden(steps, options)) await seedGolden(options);
  const report = { project: FASTPATH_TEST.project, dryRun: options.dryRun, out, steps: [] };
  let image = options.image;
  let protectedBefore = null;
  for (const step of steps) {
    if (["migrate", "refresh", "origin"].includes(step) && image === undefined) {
      if (!options.dryRun) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED", step);
      image = `${FASTPATH_TEST.imageRepository}@sha256:${"0".repeat(64)}`;
    }
    let result;
    if (step === "build") {
      result = await stepBuild(runner, options);
      image = result.image.includes("<") ? image : result.image;
      if (options.step === "all" && !result.refreshEntry && !options.skip.has("refresh")) {
        console.error("# refresh skipped: the built commit has no analytics-refresh build entry");
        options.skip.add("refresh");
      }
    } else if (step === "database") result = stepDatabase(runner);
    else if (step === "migrate") result = await stepMigrate(runner, options, image);
    else if (step === "verify-database") result = await stepVerifyDatabase(runner);
    else if (step === "seed") result = await stepSeed(runner, options);
    else if (step === "refresh") {
      if (options.skip.has("refresh")) continue;
      result = await stepRefresh(runner, options, image);
    } else if (step === "origin") result = await stepOrigin(runner, options, image);
    else if (step === "verify") result = await stepVerify(runner, options);
    else if (step === "protected") result = stepProtected(runner);
    report.steps.push(result);
    if (step === "protected" && !options.dryRun) {
      if (protectedBefore === null) protectedBefore = result.services;
      else {
        for (const name of FASTPATH_TEST.protectedServices) {
          if (protectedBefore[name].latestReadyRevision !== result.services[name].latestReadyRevision
              || protectedBefore[name].image !== result.services[name].image) {
            fail("FASTPATH_DEPLOY_PROTECTED_SERVICE_CHANGED", name);
          }
        }
      }
    }
  }
  if (!options.dryRun) report.path = await runner.receipt(`run-${Date.now()}.json`, report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      code: typeof error?.code === "string" ? error.code : "FASTPATH_DEPLOY_FAILED",
      message: String(error?.message ?? ""),
    }));
    process.exitCode = 1;
  }
}
