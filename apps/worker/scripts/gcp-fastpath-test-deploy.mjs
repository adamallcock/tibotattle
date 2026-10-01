#!/usr/bin/env node

/**
 * GCP fast-path test deployment (plan package D-1).
 *
 * Builds one commit through the reviewed Cloud Run source-archive tooling,
 * then creates or updates only `tibotattle-fastpath-test-*` resources in the
 * test project: the migrate Job, the analytics-refresh Job and an IAM-private
 * origin service. Every gcloud call carries --project=tibotattle; the shared
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
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");

export const FASTPATH_TEST = Object.freeze({
  project: "tibotattle",
  projectNumber: "806510610397",
  region: "us-east1",
  instance: "tibotattle-test-primary-20260922",
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  database: "tibotattle_fastpath",
  primarySchema: "tibotattle_fastpath_20261001",
  ledgerSchema: "tibotattle_fastpath_ledger_20261001",
  imageRepository: "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host",
  buildBucket: "tibotattle-gcs-test-build-20260922",
  migrateJob: "tibotattle-fastpath-test-migrate",
  refreshJob: "tibotattle-fastpath-test-analytics-refresh",
  originService: "tibotattle-fastpath-test-origin",
  originUrl: "https://tibotattle-fastpath-test-origin-806510610397.us-east1.run.app",
  originBucket: "tibotattle-fastpath-test-20261001",
  migratorServiceAccount: "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com",
  runtimeServiceAccount: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
  journeyServiceAccount: "tibotattle-test-journey@tibotattle.iam.gserviceaccount.com",
  migratorIamUser: "tibotattle-test-migrator@tibotattle.iam",
  runtimeIamUser: "tibotattle-test-runtime@tibotattle.iam",
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

const IMAGE_REFERENCE =
  /^us-east1-docker\.pkg\.dev\/tibotattle\/tibotattle-test\/tibotattle-host@sha256:([a-f0-9]{64})$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MIGRATION_FILE = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
// Refresh/origin read the pinned primary schema or a rehearsal target seeded
// into the same fast-path database by scripts/gcp-fastpath-seed.mjs.
const SCHEMA_OVERRIDE = /^(?:tibotattle_fastpath_20261001|typed_legacy_transfer_rehearsal_target_[a-z][a-z0-9_]{7,23})$/u;
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
    ["LEDGER_INSTANCE_CONNECTION_NAME", FASTPATH_TEST.instanceConnectionName],
    ["LEDGER_DATABASE", FASTPATH_TEST.database],
    ["LEDGER_SCHEMA", FASTPATH_TEST.ledgerSchema],
  ];
}

function mergeEnv(base, overrides) {
  const merged = new Map(base);
  for (const [key, value] of overrides) merged.set(key, value);
  return [...merged.entries()];
}

/** gcloud command that creates or updates the fast-path migrate Job. */
export function migrateJobCommand({ image, expectedCounts }) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  for (const role of ["primary", "ledger"]) {
    if (!Number.isSafeInteger(expectedCounts?.[role]) || expectedCounts[role] < 1) {
      fail("FASTPATH_DEPLOY_EXPECTED_COUNTS_INVALID");
    }
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
      ["LEDGER_EXPECTED_MIGRATIONS", String(expectedCounts.ledger)],
    ]),
    "--tasks=1", "--parallelism=1", "--max-retries=0", "--task-timeout=1200s",
    "--cpu=1", "--memory=512Mi", labelsFlag(),
  ]);
}

/** gcloud command that creates or updates the analytics-refresh Job. */
export function refreshJobCommand({ image, now, schema, extraEnv = [], extraArgs = [] }) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  if (now !== undefined && !ISO_INSTANT.test(now)) fail("FASTPATH_DEPLOY_NOW_INVALID");
  const args = [
    "dist/analytics-refresh.mjs", "--mode=full", `--schema=${primarySchemaOf(schema)}`,
    ...(now === undefined ? [] : [`--now=${now}`]),
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
    ], extraEnv)),
    "--tasks=1", "--parallelism=1", "--max-retries=0", "--task-timeout=3600s",
    "--cpu=2", "--memory=4Gi", labelsFlag(),
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
 */
export function renderOriginService({
  image,
  variant = "sidecar",
  mode = "fastpath-test",
  originEnv = [],
  bucketHistoryProof,
  schema,
}) {
  if (!IMAGE_REFERENCE.test(image ?? "")) fail("FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  if (!["sidecar", "direct"].includes(variant)) fail("FASTPATH_DEPLOY_ORIGIN_VARIANT_INVALID");
  if (typeof bucketHistoryProof !== "string" || bucketHistoryProof.length === 0) {
    fail("FASTPATH_DEPLOY_BUCKET_HISTORY_PROOF_REQUIRED");
  }
  const loopbackOrigin = `http://127.0.0.1:${FASTPATH_TEST.originLoopbackPort}`;
  const env = mergeEnv([
    ...databaseEnv(schema),
    ["POSTGRES_IAM_USER", FASTPATH_TEST.runtimeIamUser],
    ["POSTGRES_TEST_HTTP_MODE", mode],
    ["ENVIRONMENT", "synthetic-development"],
    ["ANALYTICS_V2_ENABLED", "1"],
    ["GCS_BUCKET_NAME", FASTPATH_TEST.originBucket],
    ["GCS_ERASURE_BUCKET_HISTORY_PROOF", bucketHistoryProof],
    ...(variant === "sidecar"
      ? [["HOST", "127.0.0.1"], ["HOST_ORIGIN", loopbackOrigin]]
      : [["HOST", "0.0.0.0"], ["HOST_ORIGIN", FASTPATH_TEST.originUrl]]),
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

/** Count promoted migrations per role in one commit's tree. */
export function countMigrationsAtCommit(commit, spawn = spawnSync) {
  const counts = {};
  for (const role of ["primary", "ledger"]) {
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
    schema: undefined, sqlitePath: undefined, sqliteSha256: undefined, schemaSuffix: undefined,
  };
  for (const argument of rest) {
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (argument === "--no-execute") { options.noExecute = true; continue; }
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
    else if (key === "sqlite") options.sqlitePath = resolve(value);
    else if (key === "sqlite-sha256") options.sqliteSha256 = value;
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
  if ((options.sqlitePath === undefined) !== (options.sqliteSha256 === undefined)
      || (options.sqliteSha256 !== undefined && !SHA256.test(options.sqliteSha256))) {
    fail("FASTPATH_DEPLOY_SQLITE_ARGUMENTS_INVALID", "--sqlite and --sqlite-sha256 go together");
  }
  return options;
}

const HELP = `Usage: node scripts/gcp-fastpath-test-deploy.mjs <step> [options]
Steps:
  build            archive --commit through the reviewed tooling, Cloud Build it, tag fastpath-<sha12>
  database         create database ${FASTPATH_TEST.database} on ${FASTPATH_TEST.instance} if absent
  migrate          deploy + execute ${FASTPATH_TEST.migrateJob} (counts read from --commit's tree)
  verify-database  read-only receipt counts via the migrator IAM user (impersonated, Cloud SQL connector)
  seed             seed a typed_legacy_transfer_rehearsal_target_* schema in ${FASTPATH_TEST.database} from
                   --sqlite through the importers present at --commit (scripts/gcp-fastpath-seed.mjs);
                   skips with its reason when a required importer is absent; later steps use that schema
  refresh          deploy + execute ${FASTPATH_TEST.refreshJob} (2 vCPU, 4 GiB, 1 h)
  origin           deploy IAM-private ${FASTPATH_TEST.originService}; journey SA is the only invoker
  verify           GET /api/health and /api/v1/community/daily with a journey-SA ID token; save body
  protected        read the shared test services' revisions (never written)
  all              build, database, migrate, verify-database, seed, refresh, origin, verify, protected
Options:
  --commit=<ref>          commit to build (required for build, migrate and all)
  --image=<repo@sha256:>  use an existing image digest instead of building
  --now=<ISO instant>     injected clock (refresh --now + ANALYTICS_V2_TEST_CLOCK=1; origin test clock env)
  --out=<dir>             receipt directory (default: $TMPDIR/tibotattle-fastpath-d1)
  --origin-variant=sidecar|direct   default sidecar (loopback origin behind an edge container)
  --origin-mode=<mode>    POSTGRES_TEST_HTTP_MODE for the origin (default fastpath-test)
  --origin-env=K=V        extra/override origin env (repeatable)
  --refresh-env=K=V       extra/override refresh env (repeatable)
  --refresh-arg=<arg>     extra refresh argument (repeatable)
  --query=<qs>            community/daily query (default from=2026-04-15&to=2026-10-01)
  --sqlite=<path> --sqlite-sha256=<hex>   sealed SQLite dump to seed from (seed runs only with these)
  --schema-suffix=<s>     seeded schema suffix (default fp_<commit8>_<dump8>)
  --schema=<schema>       primary schema for refresh/origin: ${FASTPATH_TEST.primarySchema}
                          or typed_legacy_transfer_rehearsal_target_* (default: the seeded schema, else pinned)
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
    applied: ok ? { primary: ok.migrations?.primary?.applied, ledger: ok.migrations?.ledger?.applied } : null };
  if (!runner.dryRun && !options.noExecute) {
    receipt.path = await runner.receipt(`migrate-${commit.slice(0, 12)}.json`, receipt);
    if (!result.succeeded || ok === undefined
        || ok.migrations?.primary?.applied !== expectedCounts.primary
        || ok.migrations?.ledger?.applied !== expectedCounts.ledger) {
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
      for (const [role, schema] of [["primary", FASTPATH_TEST.primarySchema], ["ledger", FASTPATH_TEST.ledgerSchema]]) {
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

async function stepSeed(runner, options) {
  if (options.sqlitePath === undefined) {
    const reason = "no --sqlite/--sqlite-sha256 given; refresh and origin read the empty pinned schema";
    console.error(`# seed skipped: ${reason}`);
    return { step: "seed", status: "skipped", reason };
  }
  const commit = resolveCommit(options.commit);
  const seedModule = await import("./gcp-fastpath-seed.mjs");
  const plan = seedModule.planSeed(commit);
  const suffix = options.schemaSuffix ?? seedModule.defaultSuffix(commit, options.sqliteSha256);
  const schema = seedModule.seededSchemas(suffix).target;
  runner.print([process.execPath, join(WORKER_ROOT, "scripts/gcp-fastpath-seed.mjs"), "seed",
    "--target=gcp-fastpath", `--commit=${commit}`, `--sqlite=${options.sqlitePath}`,
    `--sqlite-sha256=${options.sqliteSha256}`, `--schema-suffix=${suffix}`],
  `plan: ${plan.decision}; stages ${plan.stages.map(({ name, status }) => `${name}=${status}`).join(", ")}`);
  if (runner.dryRun) {
    if (plan.decision === "run" && options.schema === undefined) options.schema = schema;
    return { step: "seed", dryRun: true, schema, plan };
  }
  const result = await seedModule.runGcpFastpathSeed({ commit, sqlitePath: options.sqlitePath,
    sqliteSha256: options.sqliteSha256, schemaSuffix: suffix });
  if (result.status !== "skipped" && options.schema === undefined) options.schema = result.schema;
  const receipt = { ...result, path: await runner.receipt(`seed-${commit.slice(0, 12)}.json`, result) };
  return receipt;
}

async function stepRefresh(runner, options, image) {
  if (options.commit !== undefined && !commitHasRefreshEntry(resolveCommit(options.commit))) {
    fail("FASTPATH_DEPLOY_REFRESH_ENTRY_ABSENT", "cloud-run/build.mjs has no analytics-refresh entry at --commit");
  }
  const result = await deployAndExecuteJob(runner, options, FASTPATH_TEST.refreshJob,
    refreshJobCommand({ image, now: options.now, schema: options.schema, extraEnv: options.refreshEnv,
      extraArgs: options.refreshArgs }));
  const receipt = { step: "refresh", image, schema: primarySchemaOf(options.schema), now: options.now ?? null, ...result };
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
  if (runner.dryRun) return JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "<generation>",
    bucketMetageneration: "<metageneration>", softDeleteRetentionDurationSeconds: "0" });
  const retention = String(bucket?.soft_delete_policy?.retentionDurationSeconds ?? "0");
  if (bucket?.name !== FASTPATH_TEST.originBucket || retention !== "0"
      || !/^\d+$/u.test(String(bucket?.generation ?? "")) || !/^\d+$/u.test(String(bucket?.metageneration ?? ""))) {
    fail("FASTPATH_DEPLOY_ORIGIN_BUCKET_UNEXPECTED");
  }
  return JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: String(bucket.generation),
    bucketMetageneration: String(bucket.metageneration), softDeleteRetentionDurationSeconds: "0" });
}

async function stepOrigin(runner, options, image) {
  const bucketHistoryProof = ensureOriginBucket(runner);
  const originEnv = [...options.originEnv];
  if (options.now !== undefined && !originEnv.some(([key]) => key === "ANALYTICS_V2_TEST_NOW")) {
    // Name agreed with A-4/IN-1 at integration; override with --origin-env if it differs.
    originEnv.push(["ANALYTICS_V2_TEST_CLOCK", "1"], ["ANALYTICS_V2_TEST_NOW", options.now]);
  }
  const yaml = renderOriginService({ image, variant: options.variant, mode: options.mode, originEnv,
    bucketHistoryProof, schema: options.schema });
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
    mode: options.mode, yamlPath, ...invokers,
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
