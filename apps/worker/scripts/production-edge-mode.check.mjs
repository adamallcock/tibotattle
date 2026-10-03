import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { identityDigest, openOperation, readOperation } from "../../../scripts/lib/release-operation.mjs";
import { EDGE_FENCE_RETRY_AFTER_SECONDS } from "../src/edge-origin-contract.ts";
import {
  EDGE_MODE_FENCE_RETRY_AFTER,
  EDGE_MODE_FORBIDDEN_PATH_EXPECTATIONS,
  checkDeploymentEndpointConsumers,
  edgeModeForbiddenPathClass,
  validateEdgeModePublicSurface,
} from "./check-deployment-endpoints.mjs";
import {
  EDGE_MODE_ENTRY_MAIN,
  EDGE_MODE_GCP_REQUIRED_SECRETS,
  applyEdgeModeSnapshotDelta,
  edgeModeOverlaySha256,
} from "./edge-mode-configuration.mjs";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  PRODUCTION_MIGRATION_LEDGER_SQL,
  PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS,
  determinePendingD1Migrations,
  parseProductionDeploymentArgs,
  recheckFencedPublicSurface,
  recheckProductionEdgeHealth,
  reconcileTypedProductionDeployment,
  resolveProductionCandidateSite,
  runProductionDeployment,
} from "./production-deploy.mjs";
import {
  EDGE_MODE_ADMISSION_BINDINGS,
  EDGE_ORIGIN_CONTRACT_PATH,
  EDGE_PRIVACY_TOPOLOGY_MARKER,
  PRODUCTION_EDGE_MODE_PIN_SCHEMA,
  createFenceHistorySource,
  createGcloudIdentityTokenSource,
  createProductionDeploymentHistoryReader,
  gcpDeployedSinceFence,
  gitIsAncestor,
  prepareEdgeModeDeployment,
  readEdgeModePlan,
  readGitBlob,
  resolvePinnedEdgeMode,
  verifyEdgeOriginBeforeGcp,
} from "./production-edge-mode.mjs";
import {
  createProductionLiveConfigSnapshot,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";
import { parseProductionReconciliationArgs, reconcileProductionCandidate } from "./production-reconcile.mjs";

// Synthetic, content-free inputs only: fake ids, a fake token and fake
// service accounts. Nothing here reaches Cloudflare, GCP or the network.
const FIXTURE_URL = new URL("./fixtures/edge-mode-live-snapshot.synthetic.json", import.meta.url);
const TRACKED_URL = new URL("../wrangler.jsonc", import.meta.url);
const ORIGIN = DEPLOYMENT_ENDPOINTS.public.origin;
const HEALTH_URL = `${ORIGIN}/api/health`;
const sha = (digit) => digit.repeat(40);
const LIVE = JSON.parse(readFileSync(FIXTURE_URL, "utf8")).sourceCommit;
const SOURCE = sha("c");
const ORIGIN_COMMIT = sha("d");
const CONTRACT_BLOB = sha("e");
const ENTRY_BLOB = sha("f");
const DIGEST = "f".repeat(64);
const GUARD_ID = "77777777-7777-4777-8777-777777777777";
const GUARD_MIGRATION = "0001_sparkle_appcast_guard_nonces.sql";
const SYNTHETIC_TOKEN = "eyJzeW50aGV0aWMiOiJoZWFkZXIifQ.eyJzeW50aGV0aWMiOiJjbGFpbXMifQ.c3ludGhldGljLXNpZ25hdHVyZQ";
const VERIFIER = "edge-verifier@synthetic-project.iam.gserviceaccount.com";
const CLIENT_ADDRESS = "203.0.113.7";
const GCP_PLAN = Object.freeze({
  upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app",
  originAudience: "https://synthetic-origin-audience.example",
  invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
  releaseGuardDatabase: Object.freeze({ id: GUARD_ID, name: "synthetic-release-guard" }),
});
const EDGE_SECRETS = [
  { name: "EDGE_CLIENT_KEY_SECRET", type: "secret_text" },
  { name: "EDGE_INVOKER_KEY_JSON", type: "secret_text" },
];
const SCHEMAS = Object.freeze({
  schema: "production-typed-schema-v1",
  inputSha256: { primary: "1".repeat(64), analytics: "2".repeat(64), ledger: "3".repeat(64) },
  expectedSchemas: {
    primary: { schemaSha256: "4".repeat(64) },
    analytics: { schemaSha256: "5".repeat(64) },
    ledger: { schemaSha256: "6".repeat(64) },
  },
  operatorSchemaSourceSha256: "7".repeat(64),
});
const SECURE_JSON = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

// Every receipt, journal, log line and error this file observes; the last
// test scans them all for the synthetic secrets above.
const observed = [];
const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

async function tempDirectory(prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
}

function tracked() {
  const errors = [];
  const config = parse(readFileSync(TRACKED_URL, "utf8"), errors);
  assert.deepEqual(errors, []);
  return config;
}

function inventoryOf(snapshot) {
  const bindings = snapshot.bindings.map((binding) => binding.type === "d1"
    ? { ...binding, id: binding.database_id }
    : binding);
  return {
    accountId: snapshot.accountId,
    workerName: snapshot.workerName,
    version: { id: snapshot.versionId, resources: { script_runtime: snapshot.runtime, bindings } },
    settings: {
      ...snapshot.settings,
      compatibility_date: snapshot.runtime.compatibility_date,
      compatibility_flags: snapshot.runtime.compatibility_flags,
      usage_model: snapshot.runtime.usage_model,
      limits: snapshot.runtime.limits,
      cache_options: snapshot.runtime.cache_options,
      bindings,
    },
    schedules: { schedules: snapshot.crons.map((cron) => ({ cron })) },
    subdomain: snapshot.subdomain,
    routes: snapshot.routes,
    domains: snapshot.domains,
    namespaces: snapshot.namespaces,
  };
}

const resnapshot = (snapshot, overrides = {}) => createProductionLiveConfigSnapshot(inventoryOf({ ...snapshot, ...overrides }));
const addBindings = (snapshot, extra) => resnapshot(snapshot, { bindings: [...snapshot.bindings, ...extra] });
const dropBindings = (snapshot, names) => resnapshot(snapshot, {
  bindings: snapshot.bindings.filter((binding) => !names.includes(binding.name)),
});
const setText = (snapshot, name, text) => resnapshot(snapshot, {
  bindings: snapshot.bindings.map((binding) => binding.name === name ? { ...binding, text } : binding),
});
const versionId = (index) => `0e000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const delta = (snapshot, mode, plan) => applyEdgeModeSnapshotDelta({ snapshot, mode, plan, trackedConfig: tracked() });
const deployed = (expected, sourceCommit, id) => resnapshot(setText(expected, "DEPLOYMENT_SOURCE_COMMIT", sourceCommit), { versionId: id });

/** The live states of the roll-forward chain, each at source LIVE. */
const preEdgeLive = () => addBindings(fixture(), EDGE_SECRETS);
const workerLive = () => deployed(delta(preEdgeLive(), "worker"), LIVE, versionId(153));
const fencedLive = () => deployed(delta(workerLive(), "fenced"), LIVE, versionId(154));
const gcpLive = () => deployed(delta(fencedLive(), "gcp", GCP_PLAN), LIVE, versionId(155));

function coordinationFixture() {
  let owner = null;
  const events = [];
  return {
    events,
    createOwner: () => sha("b"),
    isAncestor: () => true,
    acquire(value) { assert.equal(owner, null); owner = value; events.push("acquire"); },
    assertOwned(value) { assert.equal(value, owner); },
    release(value) { assert.equal(value, owner); owner = null; events.push("release"); },
  };
}

function headersOf(values) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function jsonResponse(url, body, { status = 200, headers = SECURE_JSON } = {}) {
  return { url, status, ok: status >= 200 && status < 300, headers: headersOf(headers), text: async () => JSON.stringify(body) };
}

function textResponse(url, body, { status = 200, headers = {} } = {}) {
  return { url, status, ok: status >= 200 && status < 300, headers: headersOf(headers), text: async () => body };
}

const ROOT_URL = `${ORIGIN}/`;
const WWW_URL = `https://www.${new URL(ORIGIN).host}/`;
const MANIFEST_URL = `${ORIGIN}/release-site-manifest.json`;

/** A fenced apex as the edge answers it, with optional defects for the negative cases. */
function fencedSurfaceFetch({ adminStatus = 503, retryAfter = "300", cacheControl = "no-store", assetStatus = 404 } = {}) {
  return async (url) => {
    const href = String(url);
    if (href === WWW_URL) return textResponse(href, "", { status: 308, headers: { location: ROOT_URL } });
    if (href === MANIFEST_URL) return jsonResponse(href, { schemaVersion: "synthetic" }, { headers: { "content-type": "application/json" } });
    if (href === ROOT_URL) return textResponse(href, "<!doctype html><main>public</main>", { headers: { "content-type": "text/html; charset=utf-8" } });
    const path = new URL(href).pathname;
    if (PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS.includes(path)) {
      if (edgeModeForbiddenPathClass(path) === "public-asset") {
        return textResponse(href, "not found", { status: assetStatus, headers: { "content-type": "text/plain" } });
      }
      if (adminStatus === 404) {
        return jsonResponse(href, { error: { code: "NOT_FOUND", requestId: "synthetic" } }, { status: 404 });
      }
      return jsonResponse(href, { error: { code: "MUTATION_BARRIER_ACTIVE", requestId: "synthetic" } }, {
        status: adminStatus,
        headers: {
          ...SECURE_JSON,
          "cache-control": cacheControl,
          ...(retryAfter === null ? {} : { "retry-after": retryAfter }),
        },
      });
    }
    throw new Error("unexpected synthetic request");
  };
}

function barrierHealth(sourceCommit) {
  return {
    status: "ok",
    mode: "migration-mutation-barrier",
    maintenance: { state: "fenced", storageQualified: false },
    deployment: { sourceCommit },
  };
}

function workerHealth(sourceCommit) {
  return { status: "ok", mode: "synthetic-and-private-telemetry", deployment: { sourceCommit } };
}

/**
 * The test health body createPostgresTestHealthDispatch
 * (cloud-run/postgres-test-dispatch.mjs) serves: gcp-postgres-test-health-v2,
 * the primary receipt only. Since D-CRB only the legacy
 * health-only and health-and-v12-day-manifest modes serve it (fastpath-test,
 * edge-test and HOST_MODE serve RD-3); it must never pass a gcp gate.
 */
const FASTPATH_TEST_HEALTH = Object.freeze({
  schemaVersion: "gcp-postgres-test-health-v2",
  scope: "postgres_schema_and_migrations_only",
  status: "ready",
  workerApplicationReady: false,
  checks: Object.freeze({
    postgresMajor: 17,
    primaryMigrationReceipt: Object.freeze({ status: "current", version: 64 }),
  }),
});

function originFetch({ health = workerHealth(ORIGIN_COMMIT), ready = { status: "ready" }, marked = true, seen = [] } = {}) {
  return async (url, init = {}) => {
    const href = String(url);
    seen.push({ href, token: init.headers?.["x-serverless-authorization"] });
    const headers = { ...SECURE_JSON, ...(marked ? { "x-tibotattle-origin": "1" } : {}) };
    if (href === `${GCP_PLAN.upstreamOrigin}/api/health`) return jsonResponse(href, health, { headers });
    if (href === `${GCP_PLAN.upstreamOrigin}/api/ready`) return jsonResponse(href, ready, { headers });
    throw new Error("unexpected synthetic origin request");
  };
}

const blobs = (overrides = {}) => (commit, path) => {
  const key = `${commit}:${path}`;
  if (Object.hasOwn(overrides, key)) return overrides[key];
  if (path === EDGE_ORIGIN_CONTRACT_PATH) return CONTRACT_BLOB;
  if (path === "apps/worker/src/edge-entry.ts") return ENTRY_BLOB;
  return null;
};

/**
 * One typed deploy through runProductionDeployment with synthetic seams: a
 * fake provider over the live snapshot (the expected post-deploy snapshot once
 * Wrangler ran), a disposable checkout and source snapshot holding the real
 * wrangler.jsonc, a fake Wrangler that records its calls and the installed
 * config, and fake public endpoints.
 */
async function deployHarness({
  baseline,
  mode,
  plan,
  candidate = null,
  privacyMarked = false,
  ledgerRows = [{ id: 1, name: GUARD_MIGRATION }],
  postDeployHealth = null,
  overrides = {},
} = {}) {
  const root = await tempDirectory("edge-mode-deploy-");
  const checkout = join(root, "checkout");
  const snapshotRoot = join(root, "snapshot");
  for (const directory of [checkout, snapshotRoot]) {
    await mkdir(join(directory, "apps", "worker", "release-guard-migrations"), { recursive: true });
    await copyFile(TRACKED_URL, join(directory, "apps", "worker", "wrangler.jsonc"));
    await writeFile(
      join(directory, "apps", "worker", "release-guard-migrations", GUARD_MIGRATION),
      "CREATE TABLE IF NOT EXISTS sparkle_appcast_guard_nonces (nonce TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL);\n",
    );
  }
  const site = join(snapshotRoot, ".release-build", "public-release-site");
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "privacy.html"), privacyMarked
    ? `<!doctype html><main ${EDGE_PRIVACY_TOPOLOGY_MARKER}>privacy</main>\n`
    : "<!doctype html><main>privacy</main>\n");
  const operationDirectory = await tempDirectory("edge-mode-operation-");
  // Without a mode the typed deploy keeps the live configuration. A forbidden
  // transition has no expected snapshot; the deploy must refuse it.
  let expected = null;
  try {
    expected = mode === undefined ? baseline : delta(baseline, mode, plan);
  } catch {
    expected = null;
  }
  const afterDeploy = expected === null ? baseline : deployed(expected, SOURCE, versionId(999));
  const calls = { captures: 0, queries: 0, inspected: 0, wrangler: [], installed: null, snapshots: 0, logs: [], origin: [] };
  let isDeployed = false;
  const lock = coordinationFixture();
  const configPath = join(snapshotRoot, "apps", "worker", "wrangler.jsonc");
  const fenced = fencedSurfaceFetch();
  const origin = originFetch({ seen: calls.origin });
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(GCP_PLAN.upstreamOrigin)) return origin(url, init);
    if (href === HEALTH_URL) {
      const body = postDeployHealth?.(isDeployed)
        ?? (mode === "fenced" ? barrierHealth(SOURCE) : workerHealth(mode === "gcp" ? ORIGIN_COMMIT : SOURCE));
      return jsonResponse(href, body);
    }
    return fenced(url, init);
  };
  const options = {
    confirmation: PRODUCTION_DEPLOY_CONFIRMATION,
    wrangler: "/synthetic/wrangler",
    workerDirectory: join(checkout, "apps", "worker"),
    expectedSourceCommit: SOURCE,
    expectedPreviousSourceCommit: LIVE,
    sourceCommitCheck: () => SOURCE,
    sourceTreeCleanCheck: () => true,
    operationDirectory,
    coordinationFactory: () => lock,
    createSourceSnapshot: async () => {
      calls.snapshots += 1;
      return {
        repositoryRoot: snapshotRoot,
        workerDirectory: join(snapshotRoot, "apps", "worker"),
        dependencyDigest: DIGEST,
        dependencyPath: "/synthetic/node_modules",
        git: () => "",
        cleanup: async () => {},
      };
    },
    dependencyDigestCheck: async () => DIGEST,
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    log: (line) => calls.logs.push(line),
    typedProduction: {
      inventory: inventoryOf(baseline),
      provider: {
        capture: async () => {
          calls.captures += 1;
          return inventoryOf(isDeployed ? afterDeploy : baseline);
        },
        query: async () => {
          calls.queries += 1;
          return { success: true, results: [] };
        },
      },
      buildSchemas: async () => SCHEMAS,
      inspectTyped: async () => {
        calls.inspected += 1;
        return { ok: true, code: "TYPED_PRODUCTION_PREFLIGHT_PASSED" };
      },
    },
    retainedPublicSourceCommit: LIVE,
    expectedLiveManifestSha256: "1".repeat(64),
    candidatePublicManifestSha256: candidate,
    publicReleaseManifestRecheck: async () => ({ ok: true, code: null }),
    // A changed site proves its replaced source against the live manifest
    // bytes (stage-production-assets.check.mjs covers the real proof).
    replacedPublicSourceCheck: async ({ sourceCommit }) => {
      calls.replacedSources = [...(calls.replacedSources ?? []), sourceCommit];
      return { publicSourceCommit: sourceCommit };
    },
    healthRecheck: async () => ({ ok: true, code: null, sourceCommit: isDeployed ? SOURCE : LIVE }),
    publicSurfaceRecheck: async () => ({ ok: true, code: null }),
    fetchImpl,
    spawn: (command, args) => {
      calls.wrangler.push(args);
      if (args[0] === "deploy") {
        calls.installed = JSON.parse(readFileSync(configPath, "utf8"));
        isDeployed = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "d1") return { status: 0, stdout: JSON.stringify([{ results: ledgerRows }]), stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    },
    ...(mode === undefined ? {} : { edgeMode: mode, edgeTools: { readBlob: blobs(), isAncestor: () => true } }),
    ...(plan === undefined ? {} : { edgePlan: plan }),
    ...(mode === "gcp" ? { originCommit: ORIGIN_COMMIT, obtainOriginIdentityToken: async () => SYNTHETIC_TOKEN } : {}),
    ...overrides,
  };
  return { options, calls, expected, afterDeploy, lock, operationDirectory, configPath, root, checkout };
}

async function observeDeployment(harness) {
  const result = await runProductionDeployment(harness.options);
  observed.push(JSON.stringify(result), ...harness.calls.logs);
  const entries = await readdir(harness.operationDirectory);
  if (entries.includes("operation.json")) {
    observed.push(await readFile(join(harness.operationDirectory, "operation.json"), "utf8"));
  }
  return result;
}

/** Undo exactly the declared worker/fenced change; anything left over is drift. */
function withoutDeclaredChange(overlaid, plain) {
  const copy = structuredClone(overlaid);
  const environment = copy.env.production;
  const original = plain.env.production;
  if (original.main === undefined) delete environment.main;
  else environment.main = original.main;
  if (original.vars.EDGE_UPSTREAM_MODE === undefined) delete environment.vars.EDGE_UPSTREAM_MODE;
  else environment.vars.EDGE_UPSTREAM_MODE = original.vars.EDGE_UPSTREAM_MODE;
  return copy;
}

function assertNotStarted(result, harness, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.deepEqual(harness.calls.wrangler.filter((args) => args[0] === "deploy"), []);
}

// ---------------------------------------------------------------------------
// Worker mode, the overlay and the receipt

test("a worker-mode edge deploy installs the typed render with only main and EDGE_UPSTREAM_MODE changed and pins the overlay", async () => {
  const baseline = preEdgeLive();
  const harness = await deployHarness({ baseline, mode: "worker" });
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, "PRODUCTION_DEPLOYED");
  assert.deepEqual(result.edge, {
    edgeMode: "worker",
    liveMode: null,
    edgeOverlaySha256: edgeModeOverlaySha256({ mode: "worker" }),
    contractBlobSha: CONTRACT_BLOB,
    originCommit: null,
    releaseGuardPendingMigrations: null,
  });
  const plain = renderProductionLiveConfig({ trackedConfig: tracked(), snapshot: baseline, sourceCommit: SOURCE });
  assert.equal(harness.calls.installed.env.production.main, EDGE_MODE_ENTRY_MAIN);
  assert.equal(harness.calls.installed.env.production.vars.EDGE_UPSTREAM_MODE, "worker");
  assert.deepEqual(withoutDeclaredChange(harness.calls.installed, plain), plain);
  assert.deepEqual(harness.calls.wrangler, [
    ["deploy", "--env", "production", "--strict", "--var", `DEPLOYMENT_SOURCE_COMMIT:${SOURCE}`],
  ]);
  // Health identity (null -> worker): today's predecessor and post-deploy checks,
  // plus the typed reads before and after Wrangler; no release-guard read.
  assert.equal(harness.calls.captures, 4);
  assert.equal(harness.calls.inspected, 3);
  assert.deepEqual(harness.calls.wrangler.map((args) => args[0]), ["deploy"]);
  const record = await readOperation(harness.operationDirectory);
  assert.deepEqual(record.state.typed.edge, {
    schema: PRODUCTION_EDGE_MODE_PIN_SCHEMA,
    mode: "worker",
    liveMode: null,
    overlaySha256: edgeModeOverlaySha256({ mode: "worker" }),
    expectedLiveConfigurationFingerprint: harness.expected.fingerprint,
    contractBlobSha: CONTRACT_BLOB,
    originCommit: null,
  });
  assert.equal(record.state.typed.liveConfigurationFingerprint, baseline.fingerprint);
  assert.equal(record.state.outcome, "verified");
  assert.deepEqual(harness.lock.events, ["acquire", "release"]);
});

test("the same typed deploy without --edge-mode installs the plain render with no edge pin or receipt", async () => {
  const baseline = preEdgeLive();
  const harness = await deployHarness({ baseline });
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.equal(Object.hasOwn(result, "edge"), false);
  assert.deepEqual(harness.calls.installed,
    renderProductionLiveConfig({ trackedConfig: tracked(), snapshot: baseline, sourceCommit: SOURCE }));
  assert.deepEqual(harness.calls.wrangler, [
    ["deploy", "--env", "production", "--strict", "--var", `DEPLOYMENT_SOURCE_COMMIT:${SOURCE}`],
  ]);
  assert.equal(harness.calls.captures, 4);
  assert.equal(Object.hasOwn((await readOperation(harness.operationDirectory)).state.typed, "edge"), false);
});

test("a typed deploy without --edge-mode is refused over a live edge, so the entry and the edge gates cannot be skipped", async () => {
  for (const baseline of [workerLive(), fencedLive(), gcpLive()]) {
    const harness = await deployHarness({ baseline, privacyMarked: true, candidate: "2".repeat(64) });
    const result = await observeDeployment(harness);
    assert.deepEqual(result, { ok: false, code: "EDGE_MODE_REQUIRED_FOR_EDGE_LIVE" });
    assert.deepEqual(harness.calls.wrangler, []);
    assert.equal(harness.calls.snapshots, 0);
    assert.deepEqual(await readdir(harness.operationDirectory), []);
  }
});

test("forbidden transitions refuse before any snapshot, journal or upload", async () => {
  const cases = [
    { name: "worker -> gcp", baseline: workerLive(), mode: "gcp", plan: GCP_PLAN, candidate: "2".repeat(64) },
    { name: "gcp -> worker", baseline: gcpLive(), mode: "worker" },
    { name: "null -> fenced", baseline: preEdgeLive(), mode: "fenced" },
    { name: "fenced -> worker without fence history", baseline: fencedLive(), mode: "worker" },
    {
      name: "fenced -> worker after a gcp version",
      baseline: fencedLive(),
      mode: "worker",
      edgeHistory: async () => ({
        fenceDeploymentId: "fence-deployment",
        deployments: [
          { deploymentId: "after-abort", modes: ["fenced"] },
          { deploymentId: "gcp-flip", modes: ["gcp"] },
          { deploymentId: "fence-deployment", modes: ["fenced"] },
        ],
      }),
    },
  ];
  for (const entry of cases) {
    const harness = await deployHarness({
      baseline: entry.baseline,
      mode: entry.mode,
      plan: entry.plan,
      candidate: entry.candidate ?? null,
      privacyMarked: entry.mode === "gcp",
      overrides: entry.edgeHistory ? { edgeHistory: entry.edgeHistory } : {},
    });
    const result = await observeDeployment(harness);
    assert.deepEqual(result, { ok: false, code: "EDGE_MODE_TRANSITION_FORBIDDEN" }, entry.name);
    assert.equal(harness.calls.snapshots, 0, entry.name);
    assert.equal(harness.calls.captures, 0, entry.name);
    assert.deepEqual(harness.calls.wrangler, [], entry.name);
    assert.deepEqual(await readdir(harness.operationDirectory), [], entry.name);
    assert.deepEqual(harness.lock.events, [], entry.name);
  }
});

test("fenced -> worker with a gcp-free history since the fence deploys under the binding identity", async () => {
  const harness = await deployHarness({
    baseline: fencedLive(),
    mode: "worker",
    overrides: {
      edgeHistory: async () => ({
        fenceDeploymentId: "fence-deployment",
        deployments: [{ deploymentId: "fence-deployment", modes: ["fenced"] }],
      }),
      // Binding identity: public health only has to be up before Wrangler; a
      // source it reports is never the predecessor check.
      healthRecheck: async () => ({ ok: true, code: null, sourceCommit: sha("9") }),
    },
  });
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.edge.liveMode, "fenced");
  assert.equal(harness.calls.installed.env.production.vars.EDGE_UPSTREAM_MODE, "worker");
  // prepare, two before-phase reads, the final predecessor binding read, after.
  assert.equal(harness.calls.captures, 5);
});

test("an edge mode requires the typed path and closes its own inputs", async () => {
  const harness = await deployHarness({ baseline: preEdgeLive(), mode: "worker" });
  const {
    typedProduction: ignored,
    retainedPublicSourceCommit: ignoredRetained,
    expectedLiveManifestSha256: ignoredManifest,
    candidatePublicManifestSha256: ignoredCandidate,
    publicReleaseManifestRecheck: ignoredRecheck,
    ...legacy
  } = harness.options;
  assert.deepEqual(await runProductionDeployment(legacy), { ok: false, code: "EDGE_MODE_REQUIRES_TYPED" });
  const { edgeMode: ignoredMode, ...withoutMode } = harness.options;
  assert.deepEqual(await runProductionDeployment(withoutMode), { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
  assert.deepEqual(await runProductionDeployment({ ...harness.options, edgeMode: "proxy" }),
    { ok: false, code: "EDGE_MODE_INVALID" });
  assert.deepEqual(await runProductionDeployment({ ...harness.options, edgeTools: { relax: () => true } }),
    { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
  assert.deepEqual(await runProductionDeployment({ ...harness.options, originCommit: ORIGIN_COMMIT }),
    { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
  assert.deepEqual(await runProductionDeployment({ ...harness.options, edgeMode: "gcp", edgePlan: undefined }),
    { ok: false, code: "EDGE_MODE_PLAN_REQUIRED" });
  assert.deepEqual(await runProductionDeployment({ ...harness.options, edgePlan: GCP_PLAN }),
    { ok: false, code: "EDGE_MODE_PLAN_INVALID" });
  assert.equal(harness.calls.snapshots, 0);
  assert.deepEqual(harness.calls.wrangler, []);
});

test("the edge entry and contract must exist at the source commit", async () => {
  for (const [missing, code] of [
    ["apps/worker/src/edge-entry.ts", "EDGE_MODE_ENTRY_UNAVAILABLE"],
    [EDGE_ORIGIN_CONTRACT_PATH, "EDGE_CONTRACT_UNAVAILABLE"],
  ]) {
    const harness = await deployHarness({
      baseline: preEdgeLive(),
      mode: "worker",
      overrides: { edgeTools: { readBlob: blobs({ [`${SOURCE}:${missing}`]: null }), isAncestor: () => true } },
    });
    assertNotStarted(await observeDeployment(harness), harness, code);
    assert.equal(harness.calls.snapshots, 0);
  }
});

// ---------------------------------------------------------------------------
// Source descent and the contract blob, against a synthetic git repository

function git(root, args) {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function syntheticRepository() {
  const root = await tempDirectory("edge-mode-repository-");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Edge mode synthetic repository"]);
  const write = async (path, text) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const commit = (message) => {
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  await write(EDGE_ORIGIN_CONTRACT_PATH, "export const CONTRACT = 1;\n");
  await write("apps/worker/src/edge-entry.ts", "export default {};\n");
  const live = commit("live");
  await write("apps/worker/src/other.ts", "export const other = 1;\n");
  const source = commit("edge source");
  git(root, ["checkout", "--quiet", "-b", "origin-same", live]);
  await write("apps/worker/cloud-run/origin.mjs", "export const origin = 1;\n");
  const originSame = commit("origin with the same contract");
  git(root, ["checkout", "--quiet", "-b", "origin-drift", live]);
  await write(EDGE_ORIGIN_CONTRACT_PATH, "export const CONTRACT = 2;\n");
  const originDrift = commit("origin with a one-byte contract change");
  git(root, ["checkout", "--quiet", "--orphan", "other-line"]);
  git(root, ["rm", "-r", "--quiet", "--cached", "."]);
  await write("unrelated.txt", "another line\n");
  git(root, ["add", "unrelated.txt"]);
  const other = commit("unrelated line");
  return { root, live, source, originSame, originDrift, other };
}

async function trackedCheckout() {
  const directory = await tempDirectory("edge-mode-checkout-");
  await copyFile(TRACKED_URL, join(directory, "wrangler.jsonc"));
  return directory;
}

function prepareInput({ repository, workerDirectory, baseline, mode, sourceCommit, originCommit, plan }) {
  return {
    edgeMode: mode,
    ...(plan === undefined ? {} : { edgePlan: plan }),
    ...(mode === "gcp" ? { originCommit, obtainOriginIdentityToken: async () => SYNTHETIC_TOKEN } : {}),
    inventory: inventoryOf(baseline),
    baseConfigTools: {
      createSnapshot: createProductionLiveConfigSnapshot,
      render: renderProductionLiveConfig,
      verify: () => assert.fail("preparation does not verify"),
    },
    inspectTyped: async () => assert.fail("preparation does not inspect"),
    workerDirectory,
    sourceCommit,
    expectedPreviousSourceCommit: baseline.sourceCommit,
    candidatePublicManifestSha256: mode === "gcp" ? "2".repeat(64) : null,
    fetchImpl: originFetch({ health: workerHealth(originCommit ?? ORIGIN_COMMIT) }),
    readBlob: (commit, path) => readGitBlob({ repositoryDirectory: repository.root, commit, path }),
    isAncestor: (previous, candidate) => gitIsAncestor({ repositoryDirectory: repository.root, previous, candidate }),
  };
}

test("an edge deploy's source must descend from the live DEPLOYMENT_SOURCE_COMMIT (local git)", async () => {
  const repository = await syntheticRepository();
  const workerDirectory = await trackedCheckout();
  const baseline = setText(workerLive(), "DEPLOYMENT_SOURCE_COMMIT", repository.live);
  const descendant = await prepareEdgeModeDeployment(prepareInput({
    repository, workerDirectory, baseline, mode: "worker", sourceCommit: repository.source,
  }));
  assert.equal(descendant.ok, true, descendant.code);
  assert.equal(descendant.identity, "health");
  const unrelated = await prepareEdgeModeDeployment(prepareInput({
    repository, workerDirectory, baseline, mode: "worker", sourceCommit: repository.other,
  }));
  assert.deepEqual(unrelated, { ok: false, code: "EDGE_MODE_SOURCE_NOT_DESCENDANT" });
  const sibling = await prepareEdgeModeDeployment(prepareInput({
    repository, workerDirectory, baseline, mode: "worker", sourceCommit: repository.originSame,
  }));
  assert.equal(sibling.ok, true, "a sibling that contains the live commit descends from it");
  observed.push(JSON.stringify([descendant.receipt, descendant.pin, unrelated]));
});

test("gcp identity binds the edge and origin by the contract blob, not by commit", async () => {
  const repository = await syntheticRepository();
  const workerDirectory = await trackedCheckout();
  const baseline = setText(fencedLive(), "DEPLOYMENT_SOURCE_COMMIT", repository.live);
  const same = await prepareEdgeModeDeployment(prepareInput({
    repository, workerDirectory, baseline, mode: "gcp", plan: GCP_PLAN,
    sourceCommit: repository.source, originCommit: repository.originSame,
  }));
  assert.equal(same.ok, true, same.code);
  assert.notEqual(same.originCommit, repository.source);
  assert.equal(same.pin.originCommit, repository.originSame);
  assert.equal(same.identity, "binding");
  assert.equal(same.pin.contractBlobSha, git(repository.root, ["rev-parse", `${repository.source}:${EDGE_ORIGIN_CONTRACT_PATH}`]));
  const drift = await prepareEdgeModeDeployment(prepareInput({
    repository, workerDirectory, baseline, mode: "gcp", plan: GCP_PLAN,
    sourceCommit: repository.source, originCommit: repository.originDrift,
  }));
  assert.deepEqual(drift, { ok: false, code: "EDGE_CONTRACT_DRIFT" });
  observed.push(JSON.stringify([same.receipt, same.pin, drift]));
});

// ---------------------------------------------------------------------------
// Fenced mode

test("a fenced deploy proves its version binding, barrier health and the fenced public surface", async () => {
  const harness = await deployHarness({
    baseline: workerLive(),
    mode: "fenced",
    overrides: { healthRecheck: async () => ({ ok: true, code: null, sourceCommit: LIVE }) },
  });
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.edge.edgeMode, "fenced");
  assert.equal(result.edge.liveMode, "worker");
  assert.equal(harness.calls.installed.env.production.vars.EDGE_UPSTREAM_MODE, "fenced");
  assert.equal(harness.calls.captures, 5);
  assert.equal(harness.calls.inspected, 3);

  const notBarrier = await deployHarness({
    baseline: workerLive(),
    mode: "fenced",
    postDeployHealth: () => workerHealth(SOURCE),
  });
  const refused = await observeDeployment(notBarrier);
  assert.equal(refused.code, "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_MODE_MISMATCH");
  assert.equal(refused.outcome, "deployed_unverified");
  assert.equal(refused.coordination, "held");
});

test("the fenced public surface accepts 503 MUTATION_BARRIER_ACTIVE with retry-after 300 and refuses a 404 or a missing retry-after", async () => {
  assert.deepEqual(await recheckFencedPublicSurface({ fetchImpl: fencedSurfaceFetch() }), { ok: true, code: null });
  for (const [defect, code] of [
    [{ adminStatus: 404 }, "PRODUCTION_PUBLIC_SURFACE_FENCE_INVALID"],
    [{ retryAfter: null }, "PRODUCTION_PUBLIC_SURFACE_FENCE_INVALID"],
    [{ retryAfter: "60" }, "PRODUCTION_PUBLIC_SURFACE_FENCE_INVALID"],
    [{ cacheControl: "public, max-age=60" }, "PRODUCTION_PUBLIC_SURFACE_FENCE_INVALID"],
    [{ assetStatus: 200 }, "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED"],
  ]) {
    assert.deepEqual(await recheckFencedPublicSurface({ fetchImpl: fencedSurfaceFetch(defect) }), { ok: false, code });
  }
  const fenced = fencedSurfaceFetch();
  const noRedirect = async (url, init) => String(url) === WWW_URL ? textResponse(WWW_URL, "", { status: 200 }) : fenced(url, init);
  assert.equal((await recheckFencedPublicSurface({ fetchImpl: noRedirect })).code, "PRODUCTION_PUBLIC_SURFACE_WWW_REDIRECT_INVALID");
  const noManifest = async (url, init) => String(url) === MANIFEST_URL ? textResponse(MANIFEST_URL, "", { status: 404 }) : fenced(url, init);
  assert.equal((await recheckFencedPublicSurface({ fetchImpl: noManifest })).code, "PRODUCTION_PUBLIC_SURFACE_RELEASE_MANIFEST_INVALID");
  const dashboard = async (url, init) => String(url) === ROOT_URL
    ? textResponse(ROOT_URL, '<script src="./app.js"></script>', { headers: { "content-type": "text/html" } })
    : fenced(url, init);
  assert.equal((await recheckFencedPublicSurface({ fetchImpl: dashboard })).code, "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED");
});

test("the fenced table classifies every forbidden apex path by the mutation barrier's predicate", () => {
  const classes = Object.fromEntries(PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS.map((path) => [path, edgeModeForbiddenPathClass(path)]));
  assert.deepEqual(
    Object.entries(classes).filter(([, pathClass]) => pathClass === "public-asset").map(([path]) => path),
    ["/app.js", "/data-client.js", "/navigation.js"],
  );
  assert.equal(classes["/admin"], "admin-surface");
  assert.deepEqual(
    Object.entries(classes).filter(([, pathClass]) => pathClass === "api").map(([path]) => path),
    PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS.filter((path) => path.startsWith("/api/v1/admin/")),
  );
  // The admin surface mirrors src/admin-ui.ts ADMIN_SURFACE_PATHS: /admin plus the embedded UI assets.
  const generated = readFileSync(new URL("../src/admin-ui.generated.ts", import.meta.url), "utf8");
  for (const [path, pathClass] of Object.entries(classes)) {
    if (pathClass === "admin-surface" && path !== "/admin") assert.ok(generated.includes(`"${path}"`), path);
  }
  const surface = validateEdgeModePublicSurface();
  assert.deepEqual(surface.modeIndependent, [
    { url: WWW_URL, status: 308, location: ROOT_URL },
    { url: MANIFEST_URL, status: 200, contentType: "application/json" },
  ]);
  for (const modes of Object.values(EDGE_MODE_FORBIDDEN_PATH_EXPECTATIONS)) assert.deepEqual(modes.worker, modes.gcp);
  assert.equal(EDGE_MODE_FENCE_RETRY_AFTER, String(EDGE_FENCE_RETRY_AFTER_SECONDS));
});

test("the endpoint checker carries the edge expectations without a live probe", async () => {
  const checked = await checkDeploymentEndpointConsumers();
  assert.deepEqual(checked.edgeModePublicSurface, validateEdgeModePublicSurface());
});

// ---------------------------------------------------------------------------
// gcp mode

function gcpHarness(options = {}) {
  return deployHarness({
    baseline: fencedLive(),
    mode: "gcp",
    plan: GCP_PLAN,
    candidate: "2".repeat(64),
    privacyMarked: true,
    ...options,
  });
}

test("a fenced -> gcp deploy passes with an origin commit other than the source when bindings and contract blobs match", async () => {
  const harness = await gcpHarness();
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.edge, {
    edgeMode: "gcp",
    liveMode: "fenced",
    edgeOverlaySha256: edgeModeOverlaySha256({ mode: "gcp", plan: GCP_PLAN }),
    contractBlobSha: CONTRACT_BLOB,
    originCommit: ORIGIN_COMMIT,
    releaseGuardPendingMigrations: [],
  });
  assert.notEqual(ORIGIN_COMMIT, SOURCE);
  const production = harness.calls.installed.env.production;
  assert.deepEqual(production.d1_databases.map((entry) => entry.binding), ["RELEASE_GUARD_DB"]);
  assert.deepEqual(production.triggers.crons, []);
  // No typed role is bound in gcp mode, so no storage query is made.
  assert.equal(harness.calls.inspected, 0);
  assert.equal(harness.calls.queries, 0);
  // The release-guard gate reads only the d1_migrations ledger through the installed overlay config.
  assert.deepEqual(harness.calls.wrangler[0], [
    "d1", "execute", "RELEASE_GUARD_DB", "--remote", "--config", harness.configPath,
    "--env", "production", "--command", PRODUCTION_MIGRATION_LEDGER_SQL, "--json",
  ]);
  assert.deepEqual(harness.calls.wrangler.map((args) => args[0]), ["d1", "deploy"]);
  // The pre-gcp verifier read health and readiness with the in-memory token.
  assert.deepEqual(harness.calls.origin.map((entry) => entry.href), [
    `${GCP_PLAN.upstreamOrigin}/api/health`,
    `${GCP_PLAN.upstreamOrigin}/api/ready`,
  ]);
  assert.ok(harness.calls.origin.every((entry) => entry.token === `Bearer ${SYNTHETIC_TOKEN}`));
  const record = await readOperation(harness.operationDirectory);
  assert.equal(record.state.typed.edge.originCommit, ORIGIN_COMMIT);
  assert.equal(record.state.typed.edge.expectedLiveConfigurationFingerprint, harness.expected.fingerprint);
});

test("gcp refuses public health without deployment.sourceCommit, the fast-path test health shape", async () => {
  for (const [health, code] of [
    [FASTPATH_TEST_HEALTH, "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_UNHEALTHY"],
    [{ status: "ok", mode: "synthetic-and-private-telemetry" }, "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_SOURCE_MISMATCH"],
    [workerHealth(SOURCE), "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_SOURCE_MISMATCH"],
    [barrierHealth(ORIGIN_COMMIT), "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_MODE_MISMATCH"],
  ]) {
    const harness = await gcpHarness({ postDeployHealth: () => health });
    const result = await observeDeployment(harness);
    assert.equal(result.code, code);
    assert.equal(result.outcome, "deployed_unverified");
  }
  assert.deepEqual(await recheckProductionEdgeHealth({
    mode: "gcp",
    expectedSourceCommit: ORIGIN_COMMIT,
    fetchImpl: async (url) => jsonResponse(String(url), FASTPATH_TEST_HEALTH, { status: 200 }),
  }), { ok: false, code: "PRODUCTION_EDGE_HEALTH_UNHEALTHY" });
});

test("the pre-gcp verifier requires marked, secure, healthy and ready origin responses and the operator's origin commit", async () => {
  assert.deepEqual(await verifyEdgeOriginBeforeGcp({
    upstreamOrigin: GCP_PLAN.upstreamOrigin,
    identityToken: SYNTHETIC_TOKEN,
    fetchImpl: originFetch(),
  }), { ok: true, code: null, originCommit: ORIGIN_COMMIT });
  for (const [fetchImpl, code] of [
    [originFetch({ marked: false }), "EDGE_ORIGIN_VERIFIER_INVALID"],
    [originFetch({ health: FASTPATH_TEST_HEALTH }), "EDGE_ORIGIN_VERIFIER_UNHEALTHY"],
    [originFetch({ health: { status: "ok" } }), "EDGE_ORIGIN_VERIFIER_SOURCE_MISSING"],
    [originFetch({ ready: { status: "not_ready" } }), "EDGE_ORIGIN_VERIFIER_NOT_READY"],
    [async () => { throw new Error(`unreachable ${SYNTHETIC_TOKEN}`); }, "EDGE_ORIGIN_VERIFIER_UNREACHABLE"],
  ]) {
    const result = await verifyEdgeOriginBeforeGcp({ upstreamOrigin: GCP_PLAN.upstreamOrigin, identityToken: SYNTHETIC_TOKEN, fetchImpl });
    assert.deepEqual(result, { ok: false, code, originCommit: null });
    observed.push(JSON.stringify(result));
  }
  assert.equal((await verifyEdgeOriginBeforeGcp({
    upstreamOrigin: "https://origin.example", identityToken: SYNTHETIC_TOKEN, fetchImpl: originFetch(),
  })).code, "EDGE_ORIGIN_VERIFIER_INPUT_INVALID");

  const mismatch = await gcpHarness({ overrides: { originCommit: sha("9") } });
  assertNotStarted(await observeDeployment(mismatch), mismatch, "EDGE_ORIGIN_COMMIT_MISMATCH");
  const tokenless = await gcpHarness({ overrides: { obtainOriginIdentityToken: async () => { throw new Error(SYNTHETIC_TOKEN); } } });
  assertNotStarted(await observeDeployment(tokenless), tokenless, "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
  const drift = await gcpHarness({
    overrides: { edgeTools: { readBlob: blobs({ [`${ORIGIN_COMMIT}:${EDGE_ORIGIN_CONTRACT_PATH}`]: sha("0") }), isAncestor: () => true } },
  });
  const drifted = await observeDeployment(drift);
  assertNotStarted(drifted, drift, "EDGE_CONTRACT_DRIFT");
  assert.equal(drift.calls.snapshots, 0);
});

test("gcp refuses a pending release-guard migration before any upload", async () => {
  const harness = await gcpHarness({ ledgerRows: [] });
  const result = await observeDeployment(harness);
  assertNotStarted(result, harness, "EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING");
  assert.deepEqual(result.releaseGuardPendingMigrations, [`RELEASE_GUARD_DB:${GUARD_MIGRATION}`]);
  assert.equal(result.outcome, "not_started");
  assert.equal(result.coordination, "not_acquired");
  const unknown = await gcpHarness({ ledgerRows: [{ id: 1, name: "0001_other.sql" }] });
  assertNotStarted(await observeDeployment(unknown), unknown, "PRODUCTION_MIGRATION_LEDGER_DRIFT");
});

test("gcp refuses a live baseline missing any of the six edge-tier Rate Limiting bindings", async () => {
  for (const name of EDGE_MODE_ADMISSION_BINDINGS) {
    const harness = await gcpHarness({ baseline: dropBindings(fencedLive(), [name]) });
    const result = await observeDeployment(harness);
    assertNotStarted(result, harness, "EDGE_MODE_ADMISSION_BINDING_MISSING");
    assert.equal(harness.calls.snapshots, 0, name);
    assert.deepEqual(harness.calls.origin, [], name);
  }
});

test("gcp refuses a live baseline missing any edge secret", async () => {
  assert.deepEqual([...EDGE_MODE_GCP_REQUIRED_SECRETS].sort(), [
    "DISTRIBUTION_ANALYTICS_API_TOKEN",
    "EDGE_CLIENT_KEY_SECRET",
    "EDGE_INVOKER_KEY_JSON",
    "SPARKLE_APPCAST_GUARD_TOKEN",
  ]);
  for (const name of EDGE_MODE_GCP_REQUIRED_SECRETS) {
    const harness = await gcpHarness({ baseline: dropBindings(fencedLive(), [name]) });
    assertNotStarted(await observeDeployment(harness), harness, "EDGE_MODE_SECRET_MISSING");
    assert.equal(harness.calls.snapshots, 0, name);
  }
});

test("the privacy-page marker is required for gcp and refused for worker and fenced", async () => {
  const unmarked = await gcpHarness({ privacyMarked: false });
  const unmarkedResult = await observeDeployment(unmarked);
  assertNotStarted(unmarkedResult, unmarked, "EDGE_PRIVACY_PAGE_NOT_CUTOVER");
  assert.equal(unmarkedResult.outcome, "not_started");
  const retained = await gcpHarness({ candidate: null });
  assertNotStarted(await observeDeployment(retained), retained, "EDGE_PRIVACY_PAGE_NOT_CUTOVER");
  assert.equal(retained.calls.snapshots, 0);
  for (const [baseline, mode] of [[preEdgeLive(), "worker"], [workerLive(), "fenced"], [fencedLive(), "fenced"]]) {
    const premature = await deployHarness({ baseline, mode, privacyMarked: true });
    const result = await observeDeployment(premature);
    assertNotStarted(result, premature, "EDGE_PRIVACY_PAGE_PREMATURE");
    assert.equal(result.coordination, "not_acquired");
  }
});

test("after the cutover a gcp redeploy may retain the marked site and gcp -> fenced keeps the marked page", async () => {
  const redeploy = await gcpHarness({ baseline: gcpLive(), candidate: null });
  const redeployed = await observeDeployment(redeploy);
  assert.equal(redeployed.ok, true, redeployed.code);
  assert.equal(redeployed.edge.liveMode, "gcp");
  assert.equal(redeploy.calls.inspected, 0);
  const unmarked = await gcpHarness({ baseline: gcpLive(), candidate: null, privacyMarked: false });
  assertNotStarted(await observeDeployment(unmarked), unmarked, "EDGE_PRIVACY_PAGE_NOT_CUTOVER");
  const fence = await deployHarness({
    baseline: gcpLive(),
    mode: "fenced",
    privacyMarked: true,
    overrides: { healthRecheck: async () => ({ ok: true, code: null, sourceCommit: ORIGIN_COMMIT }) },
  });
  const fenced = await observeDeployment(fence);
  assert.equal(fenced.ok, true, fenced.code);
  assert.equal(fenced.edge.liveMode, "gcp");
  // gcp -> fenced keeps the guard D1 and origin settings, so it can never go back to worker.
  assert.deepEqual(fence.calls.installed.env.production.d1_databases.map((entry) => entry.binding), ["RELEASE_GUARD_DB"]);
});

// ---------------------------------------------------------------------------
// A changed site from the CLI (--candidate-public-manifest-sha256)

const RELEASED_SITE = sha("9");

/** The operation record a verified forward release of RELEASED_SITE left. */
function releasedSiteJournal() {
  const typed = {
    schema: "production-typed-operation-v1",
    liveConfigurationFingerprint: "f".repeat(64),
    predecessorSourceCommit: sha("8"),
    retainedPublicSourceCommit: sha("8"),
    expectedLiveManifestSha256: "7".repeat(64),
    candidatePublicManifestSha256: "2".repeat(64),
    expectedSchemaIdentity: { schema: "production-typed-schema-v1" },
  };
  const binding = { sourceCommit: RELEASED_SITE, previousSourceCommit: sha("8"), confirmedMigrations: null, typed };
  return {
    schema: 1,
    kind: "production",
    binding: identityDigest(binding),
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    state: { owner: sha("b"), ...binding, stage: "verified", outcome: "verified", code: "PRODUCTION_DEPLOYED", lock: "released" },
  };
}

/**
 * The deploy options the CLI would produce for a candidate site: the parsed
 * arguments, resolved against a synthetic web-release receipt. Only the site
 * and source pins reach the harness; its own seams replace the plan file, the
 * inventory file and the verifier account.
 */
async function cliCandidateSite({ mode, rollback = false, liveManifest = "1".repeat(64) } = {}) {
  const parsed = parseProductionDeploymentArgs([
    "--confirm", PRODUCTION_DEPLOY_CONFIRMATION,
    "--expected-previous-source", LIVE,
    "--inventory", "/synthetic/inventory.json", "--inventory-sha256", "a".repeat(64),
    "--candidate-public-manifest-sha256", "2".repeat(64),
    rollback ? "--rollback-web-release-receipt" : "--web-release-receipt", "/synthetic/.release-build/web-release-receipt.json",
    ...(rollback ? ["--rollback-release-operation", "/synthetic/release-operation"] : []),
    "--replaced-public-source", LIVE,
    "--replaced-live-manifest-sha256", liveManifest,
    `--edge-mode=${mode}`,
    ...(mode === "gcp"
      ? ["--edge-plan=/synthetic/plan.json", `--origin-commit=${ORIGIN_COMMIT}`, `--origin-verifier-account=${VERIFIER}`]
      : []),
  ]);
  const resolved = await resolveProductionCandidateSite({
    options: parsed,
    workerDirectory: "/synthetic/checkout/apps/worker",
    headCommit: () => SOURCE,
    isAncestor: async (previous, candidate) => previous === RELEASED_SITE && candidate === LIVE,
    verifyReceipt: async () => ({
      receipt: { sourceCommit: rollback ? RELEASED_SITE : SOURCE, baseCommit: LIVE, site: { manifestSha256: "2".repeat(64) } },
    }),
    // The verified journal of the release that left the site live.
    readReleaseOperation: async () => releasedSiteJournal(),
  });
  assert.equal(resolved.ok, true, resolved.code);
  const pins = ["expectedSourceCommit", "expectedPreviousSourceCommit", "retainedPublicSourceCommit",
    "expectedLiveManifestSha256", "candidatePublicManifestSha256", "candidatePublicSourceCommit", "edgeMode"];
  return Object.fromEntries(pins.filter((name) => resolved.options[name] !== undefined)
    .map((name) => [name, resolved.options[name]]));
}

test("the H.6 switch ships the marked candidate site from the CLI and pins the replaced live site", async () => {
  const cli = await cliCandidateSite({ mode: "gcp" });
  const harness = await gcpHarness({ overrides: cli });
  const result = await observeDeployment(harness);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.edge.liveMode, "fenced");
  const record = await readOperation(harness.operationDirectory);
  assert.equal(record.state.typed.candidatePublicManifestSha256, "2".repeat(64));
  assert.equal(record.state.typed.expectedLiveManifestSha256, "1".repeat(64));
  assert.equal(record.state.typed.retainedPublicSourceCommit, LIVE);
  assert.equal(record.state.typed.candidatePublicSourceCommit, undefined);
  // The replaced source is proven against the live manifest, not taken on trust.
  assert.deepEqual(harness.calls.replacedSources, [LIVE]);
  const unproven = await gcpHarness({ overrides: {
    ...cli,
    replacedPublicSourceCheck: async () => { throw new Error("provenance does not match"); },
  } });
  const refused = await observeDeployment(unproven);
  assertNotStarted(refused, unproven, "PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN");
  assert.equal(refused.coordination, "not_acquired");
});

test("a CLI candidate site keeps the privacy-page rule: marker refused before the switch, required in gcp", async () => {
  // The marker before the switch: a worker-mode web release, a rollback, or P1.
  for (const [baseline, rollback] of [[workerLive(), false], [workerLive(), true], [preEdgeLive(), false]]) {
    const cli = await cliCandidateSite({ mode: "worker", rollback });
    const harness = await deployHarness({ baseline, mode: "worker", privacyMarked: true, overrides: cli });
    const result = await observeDeployment(harness);
    assertNotStarted(result, harness, "EDGE_PRIVACY_PAGE_PREMATURE");
    assert.equal(result.coordination, "not_acquired");
  }
  // The gcp mode with the old site: the first switch, and a gcp-era rollback past the cutover.
  const switchCli = await cliCandidateSite({ mode: "gcp" });
  const oldSite = await gcpHarness({ privacyMarked: false, overrides: switchCli });
  assertNotStarted(await observeDeployment(oldSite), oldSite, "EDGE_PRIVACY_PAGE_NOT_CUTOVER");
  const rollbackCli = await cliCandidateSite({ mode: "gcp", rollback: true });
  const pastCutover = await gcpHarness({ baseline: gcpLive(), privacyMarked: false, overrides: rollbackCli });
  assertNotStarted(await observeDeployment(pastCutover), pastCutover, "EDGE_PRIVACY_PAGE_NOT_CUTOVER");
});

test("after the switch a web-only release and a rollback go through the gcp deploy with their candidate sites", async () => {
  const release = await gcpHarness({ baseline: gcpLive(), overrides: await cliCandidateSite({ mode: "gcp" }) });
  const released = await observeDeployment(release);
  assert.equal(released.ok, true, released.code);
  assert.equal(released.edge.liveMode, "gcp");
  const rollback = await gcpHarness({ baseline: gcpLive(), overrides: await cliCandidateSite({ mode: "gcp", rollback: true }) });
  const rolledBack = await observeDeployment(rollback);
  assert.equal(rolledBack.ok, true, rolledBack.code);
  const record = await readOperation(rollback.operationDirectory);
  assert.equal(record.state.typed.candidatePublicSourceCommit, RELEASED_SITE);
  assert.equal(record.state.typed.candidatePublicManifestSha256, "2".repeat(64));
});

// ---------------------------------------------------------------------------
// Reconciliation

test("typed reconciliation of a gcp operation re-renders the pinned overlay and requires its plan", async () => {
  // Leave a gcp deploy deployed_unverified (stale public health), then recover it.
  const harness = await gcpHarness({ postDeployHealth: (isDeployed) => workerHealth(isDeployed ? LIVE : ORIGIN_COMMIT) });
  const deployedResult = await observeDeployment(harness);
  assert.equal(deployedResult.code, "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_SOURCE_MISMATCH");
  assert.equal(deployedResult.coordination, "held");
  const live = harness.afterDeploy;
  let captures = 0;
  let edgeHealthCalls = 0;
  const reconcile = (overrides = {}) => reconcileTypedProductionDeployment({
    confirmation: "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT",
    executorStopped: true,
    operationDirectory: harness.operationDirectory,
    workerDirectory: harness.options.workerDirectory,
    typedProduction: {
      inventory: inventoryOf(live),
      provider: {
        capture: async () => { captures += 1; return inventoryOf(live); },
        query: async () => assert.fail("a gcp reconcile reads no typed storage"),
      },
    },
    coordinationFactory: () => harness.lock,
    buildSchemas: async () => SCHEMAS,
    inspectTyped: async () => assert.fail("a gcp reconcile inspects no typed role"),
    healthRecheck: async () => assert.fail("a gcp reconcile uses the edge identity"),
    publicSurfaceRecheck: async () => ({ ok: true, code: null }),
    publicReleaseManifestRecheck: async () => ({ ok: true, code: null }),
    edgeTools: {
      readBlob: blobs(),
      healthRecheck: async ({ mode, expectedSourceCommit }) => {
        edgeHealthCalls += 1;
        assert.equal(mode, "gcp");
        assert.equal(expectedSourceCommit, ORIGIN_COMMIT);
        return { ok: true, code: null, sourceCommit: ORIGIN_COMMIT };
      },
    },
    ...overrides,
  });
  const withoutPlan = await reconcile();
  assert.deepEqual(withoutPlan, { ok: false, code: "EDGE_MODE_PLAN_REQUIRED" });
  const otherPlan = await reconcile({ edgePlan: { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 30 } });
  assert.deepEqual(otherPlan, { ok: false, code: "EDGE_MODE_PLAN_MISMATCH" });
  const drifted = await reconcile({
    edgePlan: GCP_PLAN,
    edgeTools: { readBlob: blobs({ [`${ORIGIN_COMMIT}:${EDGE_ORIGIN_CONTRACT_PATH}`]: sha("0") }) },
  });
  assert.deepEqual(drifted, { ok: false, code: "EDGE_CONTRACT_DRIFT" });
  assert.equal(captures, 0);
  assert.deepEqual(harness.lock.events, ["acquire"]);
  // The reconcile verifies the overlaid candidate (edge entry, release-guard
  // migrations directory) against the pinned expected snapshot.
  const verified = [];
  const reconciled = await reconcile({
    edgePlan: GCP_PLAN,
    configTools: {
      createSnapshot: createProductionLiveConfigSnapshot,
      render: renderProductionLiveConfig,
      verify: (input) => {
        verified.push(input);
        return verifyProductionLiveConfig(input);
      },
    },
  });
  observed.push(JSON.stringify([withoutPlan, otherPlan, drifted, reconciled]));
  assert.equal(verified.length, 1);
  assert.equal(verified[0].snapshot.fingerprint, harness.expected.fingerprint);
  assert.equal(verified[0].candidateConfig.env.production.main, EDGE_MODE_ENTRY_MAIN);
  assert.deepEqual(verified[0].candidateConfig.env.production.d1_databases, [{
    binding: "RELEASE_GUARD_DB",
    database_id: GUARD_ID,
    database_name: GCP_PLAN.releaseGuardDatabase.name,
    migrations_dir: "release-guard-migrations",
  }]);
  assert.deepEqual(reconciled, {
    ok: true,
    code: "PRODUCTION_TYPED_RECONCILED",
    outcome: "verified",
    coordination: "released",
  });
  assert.equal(edgeHealthCalls, 1);
  assert.deepEqual(harness.lock.events, ["acquire", "release"]);
  observed.push(await readFile(join(harness.operationDirectory, "operation.json"), "utf8"));
});

test("typed reconciliation of a fenced operation needs no plan and checks the fenced surface", async () => {
  const harness = await deployHarness({
    baseline: workerLive(),
    mode: "fenced",
    postDeployHealth: (isDeployed) => barrierHealth(isDeployed ? LIVE : SOURCE),
    overrides: { healthRecheck: async () => ({ ok: true, code: null, sourceCommit: LIVE }) },
  });
  const unverified = await observeDeployment(harness);
  assert.equal(unverified.code, "PRODUCTION_POST_DEPLOY_EDGE_HEALTH_SOURCE_MISMATCH");
  let surfaces = 0;
  const reconciled = await reconcileTypedProductionDeployment({
    confirmation: "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT",
    executorStopped: true,
    operationDirectory: harness.operationDirectory,
    workerDirectory: harness.options.workerDirectory,
    typedProduction: {
      inventory: inventoryOf(harness.afterDeploy),
      provider: { capture: async () => inventoryOf(harness.afterDeploy), query: async () => ({ success: true, results: [] }) },
    },
    coordinationFactory: () => harness.lock,
    buildSchemas: async () => SCHEMAS,
    inspectTyped: async () => ({ ok: true }),
    publicSurfaceRecheck: async () => assert.fail("a fenced reconcile checks the fenced surface"),
    publicReleaseManifestRecheck: async () => ({ ok: true }),
    fetchImpl: async (url, init) => String(url) === HEALTH_URL
      ? jsonResponse(HEALTH_URL, barrierHealth(SOURCE))
      : fencedSurfaceFetch()(url, init),
    edgeTools: {
      readBlob: blobs(),
      fencedSurfaceRecheck: async (input) => { surfaces += 1; return recheckFencedPublicSurface(input); },
    },
  });
  assert.equal(reconciled.code, "PRODUCTION_TYPED_RECONCILED");
  assert.equal(surfaces, 1);
  const pinned = await readOperation(harness.operationDirectory);
  assert.equal(resolvePinnedEdgeMode({ pin: pinned.state.typed }).identity, "binding");
  assert.throws(() => resolvePinnedEdgeMode({ pin: { schema: "production-typed-operation-v1" }, edgePlan: GCP_PLAN }),
    { code: "EDGE_MODE_INPUT_INVALID" });
});

test("a typed reconcile of an operation without an edge pin is unchanged and refuses an edge plan", async () => {
  const directory = await tempDirectory("edge-mode-legacy-operation-");
  const pin = {
    schema: "production-typed-operation-v1",
    liveConfigurationFingerprint: "8".repeat(64),
    predecessorSourceCommit: LIVE,
    retainedPublicSourceCommit: LIVE,
    expectedLiveManifestSha256: "9".repeat(64),
    expectedSchemaIdentity: {},
  };
  const binding = { sourceCommit: SOURCE, previousSourceCommit: LIVE, confirmedMigrations: null, typed: pin };
  const operation = await openOperation({ directory, kind: "production", binding });
  await operation.save({ ...binding, owner: sha("b"), stage: "failed", outcome: "deployed_unverified", code: null, lock: "held" });
  operation.close();
  const result = await reconcileTypedProductionDeployment({
    confirmation: "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT",
    executorStopped: true,
    operationDirectory: directory,
    workerDirectory: "/synthetic/worker",
    typedProduction: { inventory: {}, provider: { capture: async () => assert.fail("refused first"), query: async () => {} } },
    edgePlan: GCP_PLAN,
  });
  assert.deepEqual(result, { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
});

test("candidate inspection (production-reconcile.mjs) renders the edge overlay and reads no storage for gcp", async () => {
  const run = async (baseline, edge) => {
    let queries = 0;
    const output = await reconcileProductionCandidate({
      inventory: inventoryOf(baseline),
      trackedConfig: tracked(),
      sourceCommit: SOURCE,
      expectedPreviousSourceCommit: LIVE,
      workerDirectory: "/synthetic/worker",
      sourceClean: true,
      provider: {
        capture: async () => inventoryOf(baseline),
        query: async () => { queries += 1; return { success: true, results: [] }; },
      },
      buildSchemas: async () => SCHEMAS,
      inspectTyped: async ({ runQuery }) => { await runQuery("USAGE_MONITOR_DB", "synthetic"); return { ok: true, code: null }; },
      ...edge,
    });
    observed.push(JSON.stringify(output.report));
    return { ...output, queries };
  };
  const fenced = await run(workerLive(), { edgeMode: "fenced" });
  assert.equal(fenced.report.state, "compatible");
  assert.deepEqual(fenced.report.edge, {
    edgeMode: "fenced",
    edgeOverlaySha256: edgeModeOverlaySha256({ mode: "fenced" }),
    expectedLiveConfigurationFingerprint: delta(workerLive(), "fenced").fingerprint,
  });
  const plain = renderProductionLiveConfig({ trackedConfig: tracked(), snapshot: workerLive(), sourceCommit: SOURCE });
  assert.deepEqual(withoutDeclaredChange(fenced.candidateConfig, plain), plain);
  assert.equal(fenced.queries, 1);
  const gcp = await run(fencedLive(), { edgeMode: "gcp", edgePlan: GCP_PLAN });
  assert.equal(gcp.report.typed.code, "EDGE_MODE_GCP_TYPED_ROLES_UNBOUND");
  assert.equal(gcp.queries, 0);
  assert.deepEqual(gcp.candidateConfig.env.production.d1_databases.map((entry) => entry.binding), ["RELEASE_GUARD_DB"]);
  await assert.rejects(run(fencedLive(), { edgeMode: "gcp" }), { code: "EDGE_MODE_PLAN_REQUIRED" });
  await assert.rejects(run(workerLive(), { edgeMode: "gcp", edgePlan: GCP_PLAN }), { code: "EDGE_MODE_TRANSITION_FORBIDDEN" });
  const plainReport = await run(workerLive(), {});
  assert.equal(plainReport.report.edge, undefined);

  const args = ["--inventory", "/synthetic/inventory.json", "--inventory-sha256", "a".repeat(64),
    "--expected-previous-source", LIVE, "--output-directory", "/synthetic/output"];
  assert.deepEqual(parseProductionReconciliationArgs(args).edgeMode, undefined);
  assert.equal(parseProductionReconciliationArgs([...args, "--edge-mode", "fenced"]).edgeMode, "fenced");
  assert.equal(parseProductionReconciliationArgs([...args, "--edge-mode", "gcp", "--edge-plan", "/synthetic/plan.json"]).edgePlanPath,
    "/synthetic/plan.json");
  for (const invalid of [[...args, "--edge-mode", "gcp"], [...args, "--edge-plan", "/synthetic/plan.json"],
    [...args, "--edge-mode", "fenced", "--edge-plan", "/synthetic/plan.json"], [...args, "--edge-mode", "proxy"],
    [...args.slice(0, -2), "--edge-mode", "fenced"]]) {
    assert.throws(() => parseProductionReconciliationArgs(invalid), { code: "PRODUCTION_RECONCILE_ARGUMENTS_INVALID" });
  }
});

// ---------------------------------------------------------------------------
// Migration listing, history, token source and arguments

test("determinePendingD1Migrations reads the named ledger through the given config and environment", async () => {
  const workerDirectory = await tempDirectory("edge-mode-ledger-");
  await mkdir(join(workerDirectory, "release-guard-migrations"));
  await writeFile(join(workerDirectory, "release-guard-migrations", GUARD_MIGRATION), "SELECT 1;\n");
  const configPath = join(workerDirectory, "wrangler.jsonc");
  const spawned = [];
  const run = (rows) => determinePendingD1Migrations({
    wrangler: "/synthetic/wrangler",
    workerDirectory,
    configPath,
    databases: [{ binding: "RELEASE_GUARD_DB", migrationsDir: "release-guard-migrations" }],
    spawn: (command, args, spawnOptions) => {
      spawned.push({ command, args, cwd: spawnOptions.cwd });
      return { status: 0, stdout: JSON.stringify([{ results: rows }]), stderr: "" };
    },
  });
  assert.deepEqual(await run([]), { ok: true, code: null, pending: [`RELEASE_GUARD_DB:${GUARD_MIGRATION}`] });
  assert.deepEqual(await run([{ id: 1, name: GUARD_MIGRATION }]), { ok: true, code: null, pending: [] });
  assert.equal((await run([{ id: 1, name: "0001_unknown.sql" }])).code, "PRODUCTION_MIGRATION_LEDGER_DRIFT");
  assert.deepEqual(spawned[0], {
    command: "/synthetic/wrangler",
    args: ["d1", "execute", "RELEASE_GUARD_DB", "--remote", "--config", configPath, "--env", "production",
      "--command", PRODUCTION_MIGRATION_LEDGER_SQL, "--json"],
    cwd: workerDirectory,
  });
  for (const input of [
    { databases: [] },
    { databases: [{ binding: "RELEASE_GUARD_DB", migrationsDir: "../migrations" }] },
    { databases: [{ binding: "RELEASE_GUARD_DB", migrationsDir: "release-guard-migrations" }], configPath: "relative.jsonc" },
    { databases: [{ binding: "RELEASE_GUARD_DB", migrationsDir: "release-guard-migrations" }], environment: "--remote" },
  ]) {
    const result = await determinePendingD1Migrations({ wrangler: "/synthetic/wrangler", workerDirectory, spawn: () => assert.fail("refused first"), ...input });
    assert.equal(result.code, "PRODUCTION_MIGRATION_STATE_UNKNOWN");
  }
});

test("the gcp history check counts any non-null, non-worker, non-fenced version since the fence and refuses an incomplete history", () => {
  const deployments = [
    { deploymentId: "newest", modes: ["worker"] },
    { deploymentId: "middle", modes: [null, "fenced"] },
    { deploymentId: "fence-deployment", modes: ["fenced"] },
    { deploymentId: "older", modes: ["gcp"] },
  ];
  assert.equal(gcpDeployedSinceFence({ deployments, fenceDeploymentId: "fence-deployment" }), false);
  assert.equal(gcpDeployedSinceFence({ deployments, fenceDeploymentId: "older" }), true);
  assert.equal(gcpDeployedSinceFence({
    deployments: [{ deploymentId: "split", modes: ["fenced", "invalid"] }, ...deployments],
    fenceDeploymentId: "fence-deployment",
  }), true);
  assert.throws(() => gcpDeployedSinceFence({ deployments, fenceDeploymentId: "missing" }), { code: "EDGE_MODE_FENCE_HISTORY_INCOMPLETE" });
});

test("the deployment history reader is read-only, bounded and keeps its token out of every code", async () => {
  const token = "synthetic-cloudflare-token-0123456789";
  const requests = [];
  const versions = {
    [versionId(201)]: [{ name: "EDGE_UPSTREAM_MODE", type: "plain_text", text: "fenced" }],
    [versionId(202)]: [{ name: "EDGE_UPSTREAM_MODE", type: "plain_text", text: "gcp" }],
    [versionId(203)]: [],
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, redirect: init.redirect });
    const path = new URL(url).pathname;
    if (path.endsWith("/deployments")) {
      return textResponse(String(url), JSON.stringify({ success: true, result: { deployments: [
        { id: "dep-3", versions: [{ version_id: versionId(201), percentage: 100 }] },
        { id: "dep-2", versions: [{ version_id: versionId(202), percentage: 100 }] },
        { id: "dep-1", versions: [{ version_id: versionId(203), percentage: 100 }] },
      ] } }));
    }
    const id = path.split("/").at(-1);
    return textResponse(String(url), JSON.stringify({ success: true, result: { id, resources: { bindings: versions[id] } } }));
  };
  const read = createProductionDeploymentHistoryReader({
    accountId: "a".repeat(32), workerName: "app-usagemonitor", environment: { CLOUDFLARE_API_TOKEN: token }, fetchImpl,
  });
  assert.deepEqual(await read("dep-2"), [
    { deploymentId: "dep-3", modes: ["fenced"] },
    { deploymentId: "dep-2", modes: ["gcp"] },
  ]);
  assert.ok(requests.every((request) => request.method === "GET" && request.redirect === "error"));
  await assert.rejects(read("dep-0"), { code: "EDGE_MODE_FENCE_HISTORY_INCOMPLETE" });
  const failing = createProductionDeploymentHistoryReader({
    accountId: "a".repeat(32), workerName: "app-usagemonitor", environment: { CLOUDFLARE_API_TOKEN: token },
    fetchImpl: async () => { throw new Error(`refused ${token}`); },
  });
  await assert.rejects(failing("dep-2"), (error) => {
    assert.equal(error.code, "EDGE_MODE_HISTORY_READ_FAILED");
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.throws(() => createProductionDeploymentHistoryReader({
    accountId: "a".repeat(32), workerName: "app-usagemonitor", environment: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_API_BASE_URL: "x" },
  }), { code: "EDGE_MODE_HISTORY_ENVIRONMENT_OVERRIDE" });
});

test("the CLI reads an owner-private plan and anchors the history at the EP-8 fence receipt", async () => {
  const directory = await tempDirectory("edge-mode-plan-");
  const path = join(directory, "plan.json");
  await writeFile(path, JSON.stringify(GCP_PLAN), { mode: 0o600 });
  assert.deepEqual(await readEdgeModePlan(path), GCP_PLAN);
  await writeFile(join(directory, "public.json"), JSON.stringify(GCP_PLAN), { mode: 0o644 });
  await assert.rejects(readEdgeModePlan(join(directory, "public.json")), { code: "EDGE_MODE_PLAN_UNREADABLE" });
  await writeFile(join(directory, "list.json"), "[]", { mode: 0o600 });
  await assert.rejects(readEdgeModePlan(join(directory, "list.json")), { code: "EDGE_MODE_PLAN_INVALID" });

  const reads = [];
  const history = createFenceHistorySource({
    receiptPath: "/synthetic/fence.json",
    receiptSha256: "c".repeat(64),
    accountId: "a".repeat(32),
    workerName: "app-usagemonitor",
    readFenceReceipt: async (receiptPath, receiptSha256) => {
      reads.push([receiptPath, receiptSha256]);
      return { productionWorker: { deploymentId: "fence-deployment", mode: "fenced" } };
    },
    createReader: ({ accountId, workerName }) => async (fenceDeploymentId) => {
      reads.push([accountId, workerName, fenceDeploymentId]);
      return [{ deploymentId: "fence-deployment", modes: ["fenced"] }];
    },
  });
  assert.deepEqual(await history(), {
    fenceDeploymentId: "fence-deployment",
    deployments: [{ deploymentId: "fence-deployment", modes: ["fenced"] }],
  });
  assert.deepEqual(reads, [["/synthetic/fence.json", "c".repeat(64)], ["a".repeat(32), "app-usagemonitor", "fence-deployment"]]);
  const released = createFenceHistorySource({
    readFenceReceipt: async () => { throw Object.assign(new Error("FENCE_RELEASED"), { code: "FENCE_RELEASED" }); },
  });
  await assert.rejects(released(), { code: "EDGE_MODE_FENCE_RECEIPT_INVALID" });
});

test("the gcloud verifier token source impersonates the verifier for the plan audience and keeps the token in memory", async () => {
  const calls = [];
  const source = createGcloudIdentityTokenSource({
    verifierAccount: VERIFIER,
    audience: GCP_PLAN.originAudience,
    execFile: (command, args, options) => {
      calls.push({ command, args, stdio: options.stdio });
      return `${SYNTHETIC_TOKEN}\n`;
    },
  });
  assert.equal(await source(), SYNTHETIC_TOKEN);
  assert.deepEqual(calls, [{
    command: "gcloud",
    args: ["auth", "print-identity-token", `--impersonate-service-account=${VERIFIER}`,
      `--audiences=${GCP_PLAN.originAudience}`, "--include-email"],
    stdio: ["ignore", "pipe", "ignore"],
  }]);
  const failing = createGcloudIdentityTokenSource({
    verifierAccount: VERIFIER,
    audience: GCP_PLAN.originAudience,
    execFile: () => { throw new Error(`gcloud failed ${SYNTHETIC_TOKEN}`); },
  });
  await assert.rejects(failing(), (error) => {
    assert.equal(error.code, "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
    assert.equal(error.message.includes(SYNTHETIC_TOKEN), false);
    return true;
  });
  assert.throws(() => createGcloudIdentityTokenSource({ verifierAccount: "not-an-account", audience: GCP_PLAN.originAudience }),
    { code: "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE" });
});

test("deploy arguments accept the edge flags only with their mode and leave today's arguments unchanged", () => {
  const base = ["--confirm", PRODUCTION_DEPLOY_CONFIRMATION, "--expected-previous-source", LIVE,
    "--inventory", "/synthetic/inventory.json", "--inventory-sha256", "a".repeat(64),
    "--retained-public-source", LIVE, "--expected-live-manifest-sha256", "b".repeat(64)];
  assert.deepEqual(Object.keys(parseProductionDeploymentArgs(base)).sort(), [
    "confirmation", "expectedLiveManifestSha256", "expectedPreviousSourceCommit", "inventoryPath",
    "inventorySha256", "retainedPublicSourceCommit",
  ]);
  assert.equal(parseProductionDeploymentArgs([...base, "--edge-mode=worker"]).edgeMode, "worker");
  assert.equal(parseProductionDeploymentArgs([...base, "--edge-mode", "fenced"]).edgeMode, "fenced");
  const gcp = parseProductionDeploymentArgs([...base, "--edge-mode=gcp", "--edge-plan=/synthetic/plan.json",
    `--origin-commit=${ORIGIN_COMMIT}`, `--origin-verifier-account=${VERIFIER}`]);
  assert.deepEqual([gcp.edgeMode, gcp.edgePlanPath, gcp.originCommit, gcp.originVerifierAccount],
    ["gcp", "/synthetic/plan.json", ORIGIN_COMMIT, VERIFIER]);
  assert.equal(parseProductionDeploymentArgs([...base, "--edge-mode", "worker", "--fence-receipt", "/synthetic/fence.json",
    "--fence-receipt-sha256", "c".repeat(64)]).fenceReceiptPath, "/synthetic/fence.json");
  const reconcile = ["--confirm", "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT", "--operation", "/synthetic/operation",
    "--executor-stopped", "--inventory", "/synthetic/inventory.json", "--inventory-sha256", "a".repeat(64)];
  assert.equal(parseProductionDeploymentArgs([...reconcile, "--edge-plan", "/synthetic/plan.json"]).edgePlanPath, "/synthetic/plan.json");
  for (const invalid of [
    [...base, "--edge-mode=proxy"],
    [...base, "--edge-plan", "/synthetic/plan.json"],
    [...base, "--edge-mode", "gcp", "--edge-plan", "/synthetic/plan.json", "--origin-commit", ORIGIN_COMMIT],
    [...base, "--edge-mode", "gcp", "--edge-plan", "/synthetic/plan.json", "--origin-commit", "short",
      "--origin-verifier-account", VERIFIER],
    [...base, "--edge-mode", "worker", "--origin-commit", ORIGIN_COMMIT],
    [...base, "--edge-mode", "fenced", "--fence-receipt", "/synthetic/fence.json", "--fence-receipt-sha256", "c".repeat(64)],
    [...base, "--edge-mode", "worker", "--fence-receipt", "/synthetic/fence.json"],
    [...base, "--edge-mode", "worker", "--edge-mode", "fenced"],
    [...reconcile, "--edge-mode", "gcp"],
    ["--confirm", "RECONCILE_PRODUCTION_DEPLOYMENT", "--operation", "/synthetic/operation", "--executor-stopped",
      "--edge-plan", "/synthetic/plan.json"],
  ]) {
    assert.throws(() => parseProductionDeploymentArgs(invalid), { code: "PRODUCTION_ARGUMENTS_INVALID" }, invalid.join(" "));
  }
});

test("the edge-tier binding list mirrors EP-1's EDGE_ADMISSION_BINDINGS", () => {
  const source = readFileSync(new URL("../src/edge-admission-policy.ts", import.meta.url), "utf8");
  const declaration = source.match(/export const EDGE_ADMISSION_BINDINGS = Object\.freeze\(\[([^\]]*)\]/u);
  assert.ok(declaration);
  assert.deepEqual([...declaration[1].matchAll(/"([A-Z_]+)"/gu)].map((match) => match[1]), [...EDGE_MODE_ADMISSION_BINDINGS]);
});

// ---------------------------------------------------------------------------
// Privacy

test("no receipt, journal, log or error observed here carries a token, key, email, plan value or client address", () => {
  assert.ok(observed.length > 40);
  const forbidden = [
    SYNTHETIC_TOKEN,
    "synthetic-cloudflare-token",
    VERIFIER,
    GCP_PLAN.invokerServiceAccount,
    GCP_PLAN.upstreamOrigin,
    new URL(GCP_PLAN.upstreamOrigin).host,
    GCP_PLAN.originAudience,
    GUARD_ID,
    GCP_PLAN.releaseGuardDatabase.name,
    fixture().accountId,
    "owner@example.invalid",
    "PRIVATE KEY",
    "private_key",
    CLIENT_ADDRESS,
  ];
  for (const text of observed) {
    for (const value of forbidden) assert.equal(text.includes(value), false, `observed output carries ${value}`);
    assert.equal(/@[a-z0-9-]+\.iam\.gserviceaccount\.com/u.test(text), false);
    assert.equal(/\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(text), false);
  }
});
