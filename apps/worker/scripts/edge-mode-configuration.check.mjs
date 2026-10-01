import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import {
  EDGE_MODE_ENTRY_MAIN,
  EDGE_MODE_GCP_REQUIRED_SECRETS,
  EDGE_MODE_OVERLAY_SCHEMA,
  EDGE_MODE_PRODUCTION_HOSTNAMES,
  EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME,
  EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
  EDGE_MODE_RETIRED_SECRETS,
  EDGE_MODE_TRANSITIONS,
  applyEdgeModeOverlay,
  applyEdgeModeSnapshotDelta,
  applyEdgeModeStagingOverlay,
  applyEdgeModeStagingSnapshotDelta,
  assertEdgeModeTransition,
  edgeModeOverlaySha256,
  liveEdgeMode,
  normalizeEdgeModePlan,
  serializeEdgeModeConfig,
  verifyEdgeModeLiveSnapshot,
} from "./edge-mode-configuration.mjs";
import {
  PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS,
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";

const TRACKED_FILES = ["../wrangler.jsonc", "../worker-configuration.d.ts", "../.dev.vars.example"]
  .map((path) => new URL(path, import.meta.url))
  .filter((url) => existsSync(url));
const trackedDigests = TRACKED_FILES.map((url) => createHash("sha256").update(readFileSync(url)).digest("hex"));
const FIXTURE_URL = new URL("./fixtures/edge-mode-live-snapshot.synthetic.json", import.meta.url);
const MODULE_URL = new URL("./edge-mode-configuration.mjs", import.meta.url);

const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const ANALYTICS_ID = "22222222-2222-4222-8222-222222222222";
const LEDGER_ID = "33333333-3333-4333-8333-333333333333";
const GUARD_ID = "77777777-7777-4777-8777-777777777777";
const EXTRA_ID = "88888888-8888-4888-8888-888888888888";
const DATA_BINDINGS = ["USAGE_MONITOR_DB", "ANALYTICS_DB", "DELETION_LEDGER", "QUARANTINE"];
const EDGE_SECRETS = [
  { name: "EDGE_CLIENT_KEY_SECRET", type: "secret_text" },
  { name: "EDGE_INVOKER_KEY_JSON", type: "secret_text" },
];
const GCP_PLAN = Object.freeze({
  upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app",
  originAudience: "https://synthetic-origin-audience.example",
  invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
  releaseGuardDatabase: Object.freeze({ id: GUARD_ID, name: "synthetic-release-guard" }),
});
const PINNED_OVERLAY_SHA256 = {
  worker: "3e72fae57581cf3e84bacaab7c60a1b1e6554d9b2770413b1e727dc3f829ecb1",
  fenced: "98904b291c87dbfbd3e2bb0759a1314201c91bfd70eaa9dfefc3ad68ba61fb27",
  gcp: "31b01bcf0b266a3a42cdc21a2761827112f3c9ad1f731d37a7ca196cd1402327",
};

const sha = (digit) => digit.repeat(40);
const versionId = (index) => `0e000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const single = (id) => ({ versions: [{ version_id: id, percentage: 100 }] });

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
}

function tracked() {
  const errors = [];
  const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), errors);
  assert.deepEqual(errors, []);
  return config;
}

/** The checked-in staging target as an environment-less config, the typed staging render input. */
function stagingTracked() {
  const { env, ...root } = tracked();
  return { ...root, ...env.staging };
}

function inventoryOf(snapshot, overrides = {}) {
  const value = { ...snapshot, ...overrides };
  const bindings = value.bindings.map((binding) => binding.type === "d1"
    ? { ...binding, id: binding.database_id }
    : binding);
  return {
    accountId: value.accountId,
    workerName: value.workerName,
    version: { id: value.versionId, resources: { script_runtime: value.runtime, bindings } },
    settings: {
      ...value.settings,
      compatibility_date: value.runtime.compatibility_date,
      compatibility_flags: value.runtime.compatibility_flags,
      usage_model: value.runtime.usage_model,
      limits: value.runtime.limits,
      cache_options: value.runtime.cache_options,
      bindings,
    },
    schedules: { schedules: value.crons.map((cron) => ({ cron })) },
    subdomain: value.subdomain,
    routes: value.routes,
    domains: value.domains,
    namespaces: value.namespaces,
  };
}

const resnapshot = (snapshot, overrides) => createProductionLiveConfigSnapshot(inventoryOf(snapshot, overrides));
const addBindings = (snapshot, extra) => resnapshot(snapshot, { bindings: [...snapshot.bindings, ...extra] });
const dropBindings = (snapshot, names) => resnapshot(snapshot, {
  bindings: snapshot.bindings.filter((binding) => !names.includes(binding.name)),
});
const setText = (snapshot, name, text) => resnapshot(snapshot, {
  bindings: snapshot.bindings.map((binding) => binding.name === name ? { ...binding, text } : binding),
});

/** What the live inventory reads after a successful deploy of `expected`. */
function deployed(expected, sourceCommit, id) {
  return resnapshot(setText(expected, "DEPLOYMENT_SOURCE_COMMIT", sourceCommit), { versionId: id });
}

function render(live, sourceCommit, trackedConfig = tracked()) {
  return renderProductionLiveConfig({ trackedConfig, snapshot: live, sourceCommit });
}

/** The production entry points as a typed deploy calls them: with the checked-in config the render used. */
const overlay = (input) => applyEdgeModeOverlay({ trackedConfig: tracked(), ...input });
const delta = (input) => applyEdgeModeSnapshotDelta({ trackedConfig: tracked(), ...input });
const withGuard = (id, name = GCP_PLAN.releaseGuardDatabase.name) => ({ ...GCP_PLAN, releaseGuardDatabase: { id, name } });

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

/** Undo exactly the declared worker/fenced change; anything left over is drift. */
function withoutDeclaredChange(overlaid, plain) {
  const copy = structuredClone(overlaid);
  const environment = copy.env?.production ?? copy;
  const original = plain.env?.production ?? plain;
  if (original.main === undefined) delete environment.main;
  else environment.main = original.main;
  if (original.vars.EDGE_UPSTREAM_MODE === undefined) delete environment.vars.EDGE_UPSTREAM_MODE;
  else environment.vars.EDGE_UPSTREAM_MODE = original.vars.EDGE_UPSTREAM_MODE;
  return copy;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

/** A fenced live state with the edge secrets put: the pre-edge fixture rolled
 * through worker mode to fenced by the deltas themselves. */
function fencedWithEdgeSecrets() {
  const worker = delta({ snapshot: addBindings(fixture(), EDGE_SECRETS), mode: "worker" });
  return delta({ snapshot: worker, mode: "fenced" });
}

test("the synthetic fixture is a canonical, version-152-shaped typed snapshot with fake ids", () => {
  const snapshot = fixture();
  assert.equal(`${JSON.stringify(resnapshot(snapshot), null, 2)}\n`, readFileSync(FIXTURE_URL, "utf8"));
  assert.equal(productionLiveConfigFingerprint({ ...snapshot, fingerprint: undefined }), snapshot.fingerprint);
  assert.equal(liveEdgeMode(snapshot), null);
  const trackedProduction = tracked().env.production;
  assert.equal(snapshot.workerName, trackedProduction.name);
  const byName = new Map(snapshot.bindings.map((binding) => [binding.name, binding]));
  assert.equal(byName.get("USAGE_MONITOR_DB").database_id, INGESTION_ID);
  assert.equal(byName.get("ANALYTICS_DB").database_id, ANALYTICS_ID);
  assert.equal(byName.get("TELEMETRY_STORAGE_MODE").text, "typed");
  const text = readFileSync(FIXTURE_URL, "utf8");
  for (const entry of [...trackedProduction.d1_databases, ...trackedProduction.r2_buckets]) {
    assert.equal(text.includes(entry.database_id ?? entry.bucket_name), false);
  }
  assert.deepEqual(text.match(/[^\s"]+@[^\s"]+/gu), ["owner@example.invalid"]);
});

test("the worker overlay on the real wrangler.jsonc binds only snapshot ids and changes only main and the mode var", () => {
  const trackedConfig = tracked();
  const trackedProduction = trackedConfig.env.production;
  const legacyPrimary = trackedProduction.d1_databases.find((entry) => entry.binding === "USAGE_MONITOR_DB");
  // Why the checked-in env.production is never a source: a legacy D1 and JSON mode.
  assert.notEqual(legacyPrimary.database_id, INGESTION_ID);
  assert.equal(trackedProduction.vars.TELEMETRY_STORAGE_MODE, "json");

  const snapshot = fixture();
  const plain = render(snapshot, sha("c"), trackedConfig);
  const { config, overlaySha256 } = applyEdgeModeOverlay({ renderedConfig: plain, mode: "worker", trackedConfig });
  const production = config.env.production;
  assert.equal(production.main, EDGE_MODE_ENTRY_MAIN);
  assert.equal(production.vars.EDGE_UPSTREAM_MODE, "worker");
  assert.equal(plain.env.production.main, undefined);
  assert.equal(plain.env.production.vars.EDGE_UPSTREAM_MODE, undefined);
  assert.deepEqual(
    Object.fromEntries(production.d1_databases.map((entry) => [entry.binding, entry.database_id])),
    { ANALYTICS_DB: ANALYTICS_ID, DELETION_LEDGER: LEDGER_ID, USAGE_MONITOR_DB: INGESTION_ID },
  );
  assert.deepEqual(
    production.r2_buckets.map((entry) => entry.bucket_name).sort(),
    snapshot.bindings.filter((binding) => binding.type === "r2_bucket").map((binding) => binding.bucket_name).sort(),
  );
  assert.equal(JSON.stringify(config).includes(legacyPrimary.database_id), false);
  assert.equal(production.vars.TELEMETRY_STORAGE_MODE, "typed");
  assert.deepEqual(withoutDeclaredChange(config, plain), plain);
  assert.equal(overlaySha256, edgeModeOverlaySha256({ mode: "worker" }));

  const workerLive = deployed(applyEdgeModeSnapshotDelta({ snapshot, mode: "worker", trackedConfig }), sha("d"), versionId(153));
  const workerPlain = render(workerLive, sha("e"), trackedConfig);
  const fenced = applyEdgeModeOverlay({ renderedConfig: workerPlain, mode: "fenced", trackedConfig }).config;
  assert.equal(workerPlain.env.production.vars.EDGE_UPSTREAM_MODE, "worker");
  assert.equal(fenced.env.production.vars.EDGE_UPSTREAM_MODE, "fenced");
  assert.equal(fenced.env.production.main, EDGE_MODE_ENTRY_MAIN);
  assert.deepEqual(withoutDeclaredChange(fenced, workerPlain), workerPlain);
});

test("verifyProductionLiveConfig accepts each overlay against its delta through the roll-forward chain", () => {
  let live = fixture();
  let gcpEverDeployedSinceFence = false;
  let index = 153;
  const deploy = (mode, plan = undefined) => {
    const liveMode = liveEdgeMode(live);
    assertEdgeModeTransition({ liveMode, targetMode: mode, gcpEverDeployedSinceFence });
    const sourceCommit = sha(String(index % 10));
    const plain = render(live, sourceCommit);
    const { config } = overlay({ renderedConfig: plain, mode, plan });
    const expected = delta({ snapshot: live, mode, plan });
    assert.deepEqual(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }), {
      ok: true,
      code: null,
      expectedFingerprint: expected.fingerprint,
      actualFingerprint: expected.fingerprint,
    });
    // A mode change against the unmodified live snapshot is drift; a same-mode,
    // same-plan redeploy is no change at all.
    const unchanged = verifyProductionLiveConfig({ snapshot: live, candidateConfig: config, sourceCommit });
    assert.equal(unchanged.ok, expected.fingerprint === live.fingerprint);
    if (liveMode !== mode) assert.equal(unchanged.ok, false);

    const extraVar = structuredClone(config);
    extraVar.env.production.vars.EDGE_EXTRA_SETTING = "unexpected";
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: extraVar, sourceCommit }).code,
      "PRODUCTION_LIVE_CONFIG_CONFIG_VARS_DRIFT");

    const id = versionId(index);
    const after = deployed(expected, sourceCommit, id);
    assert.equal(after.fingerprint, expected.fingerprint);
    assert.deepEqual(
      verifyEdgeModeLiveSnapshot({ snapshot: after, mode, deployment: single(id), sourceCommit }).ok,
      true,
    );
    if (mode === "gcp") gcpEverDeployedSinceFence = true;
    index += 1;
    live = after;
    return { config, expected };
  };

  deploy("worker");
  deploy("worker");
  live = addBindings(live, EDGE_SECRETS); // owner puts the edge secrets and recaptures the baseline
  deploy("fenced");
  deploy("fenced");
  const abortLive = live;
  deploy("gcp", GCP_PLAN);
  deploy("gcp", GCP_PLAN);
  deploy("gcp", { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 120 });
  deploy("fenced");
  throwsCode(() => assertEdgeModeTransition({ liveMode: "fenced", targetMode: "worker", gcpEverDeployedSinceFence }),
    "EDGE_MODE_TRANSITION_FORBIDDEN");
  deploy("gcp", GCP_PLAN);

  live = abortLive; // abort before any gcp version: fenced -> worker is a var flip
  gcpEverDeployedSinceFence = false;
  const { config } = deploy("worker");
  assert.equal(config.env.production.d1_databases.length, 3);
});

test("gcp output drops every data binding, keeps the declared surface, and fails closed on unknown storage or missing secrets", () => {
  const live = fencedWithEdgeSecrets();
  const sourceCommit = sha("f");
  const plain = render(live, sourceCommit);
  const { config } = overlay({ renderedConfig: plain, mode: "gcp", plan: GCP_PLAN });
  const expected = delta({ snapshot: live, mode: "gcp", plan: GCP_PLAN });
  const production = config.env.production;
  const before = plain.env.production;
  assert.deepEqual(production.d1_databases, [{
    binding: "RELEASE_GUARD_DB",
    database_id: GUARD_ID,
    database_name: "synthetic-release-guard",
    migrations_dir: EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
  }]);
  assert.equal(EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR, "release-guard-migrations");
  assert.deepEqual(production.r2_buckets, before.r2_buckets.filter((entry) => entry.binding === "SPARKLE_RELEASES"));
  assert.equal(production.r2_buckets.length, 1);
  assert.deepEqual(production.triggers, { crons: [] });
  assert.notDeepEqual(before.triggers.crons, []);
  for (const name of DATA_BINDINGS) {
    assert.equal([...production.d1_databases, ...production.r2_buckets].some((entry) => entry.binding === name), false);
    assert.equal(expected.bindings.some((binding) => binding.name === name), false);
  }
  assert.deepEqual(expected.crons, []);
  assert.deepEqual(production.routes, before.routes);
  assert.deepEqual(production.routes.map((route) => route.pattern).sort(),
    ["admin.tibotattle.com", "tibotattle.com", "www.tibotattle.com"]);
  assert.deepEqual(expected.domains, live.domains);
  for (const key of ["assets", "ratelimits", "durable_objects", "migrations", "secrets", "name", "account_id",
    "compatibility_date", "compatibility_flags", "limits", "cache", "observability"]) {
    assert.deepEqual(production[key], before[key], key);
  }
  assert.deepEqual(production.vars, {
    ...before.vars,
    EDGE_UPSTREAM_MODE: "gcp",
    EDGE_UPSTREAM_ORIGIN: GCP_PLAN.upstreamOrigin,
    EDGE_ORIGIN_AUDIENCE: GCP_PLAN.originAudience,
    EDGE_INVOKER_SERVICE_ACCOUNT: GCP_PLAN.invokerServiceAccount,
    EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "100",
  });
  assert.deepEqual(Object.keys(production).sort(), [...new Set([...Object.keys(before), "main"])].sort());
  const { env: overlaidEnv, ...overlaidRoot } = config;
  const { env: plainEnv, ...plainRoot } = plain;
  assert.deepEqual(overlaidRoot, plainRoot);
  assert.deepEqual(overlaidEnv.staging, plainEnv.staging);
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true);
  const fencedExpected = delta({ snapshot: live, mode: "fenced" });
  assert.equal(verifyProductionLiveConfig({ snapshot: fencedExpected, candidateConfig: config, sourceCommit }).ok, false);
  const fencedConfig = overlay({ renderedConfig: plain, mode: "fenced" }).config;
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: fencedConfig, sourceCommit }).ok, false);

  const both = (snapshot, code, plan = GCP_PLAN) => {
    throwsCode(() => overlay({ renderedConfig: render(snapshot, sourceCommit), mode: "gcp", plan }), code);
    throwsCode(() => delta({ snapshot, mode: "gcp", plan }), code);
  };
  both(addBindings(live, [{ name: "EXTRA_DB", type: "d1", database_id: EXTRA_ID }]), "EDGE_MODE_UNKNOWN_STORAGE_BINDING");
  both(addBindings(live, [{ name: "EXTRA_BUCKET", type: "r2_bucket", bucket_name: "synthetic-extra" }]),
    "EDGE_MODE_UNKNOWN_STORAGE_BINDING");
  both(addBindings(dropBindings(live, ["QUARANTINE"]), [{ name: "QUARANTINE", type: "d1", database_id: EXTRA_ID }]),
    "EDGE_MODE_UNKNOWN_STORAGE_BINDING");
  for (const secret of EDGE_MODE_GCP_REQUIRED_SECRETS) both(dropBindings(live, [secret]), "EDGE_MODE_SECRET_MISSING");
  assert.deepEqual([...EDGE_MODE_GCP_REQUIRED_SECRETS].sort(), [
    "DISTRIBUTION_ANALYTICS_API_TOKEN", "EDGE_CLIENT_KEY_SECRET", "EDGE_INVOKER_KEY_JSON", "SPARKLE_APPCAST_GUARD_TOKEN",
  ]);
  both(dropBindings(live, ["SPARKLE_RELEASES"]), "EDGE_MODE_RETAINED_BINDING_MISSING");
  both(live, "EDGE_MODE_PLAN_INVALID", { ...GCP_PLAN, releaseGuardDatabase: { id: INGESTION_ID, name: "synthetic" } });
  both(live, "EDGE_MODE_PLAN_INVALID", { ...GCP_PLAN, releaseGuardDatabase: { id: ANALYTICS_ID, name: "synthetic" } });

  // A declared edge name may only ever be a plain var: never a secret the
  // overlay would shadow (config) or silently drop (snapshot).
  const originSecret = addBindings(live, [{ name: "EDGE_UPSTREAM_ORIGIN", type: "secret_text" }]);
  throwsCode(() => overlay({ renderedConfig: render(originSecret, sourceCommit), mode: "gcp", plan: GCP_PLAN }),
    "EDGE_MODE_CONFIG_INVALID");
  throwsCode(() => delta({ snapshot: originSecret, mode: "gcp", plan: GCP_PLAN }), "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => delta({ snapshot: addBindings(fixture(), [{ name: "EDGE_UPSTREAM_MODE", type: "secret_text" }]), mode: "fenced" }),
    "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => liveEdgeMode(addBindings(fixture(), [{ name: "EDGE_UPSTREAM_MODE", type: "secret_text" }])),
    "EDGE_MODE_LIVE_INVALID");
});

test("the release guard D1 is never a tracked or retired data D1 and stays pinned once bound", () => {
  const trackedConfig = tracked();
  const legacyPrimary = trackedConfig.env.production.d1_databases.find((entry) => entry.binding === "USAGE_MONITOR_DB");
  const legacyLedger = trackedConfig.env.production.d1_databases.find((entry) => entry.binding === "DELETION_LEDGER");
  const stagingPrimary = trackedConfig.env.staging.d1_databases.find((entry) => entry.binding === "USAGE_MONITOR_DB");
  const sourceCommit = sha("7");
  const gcpInputs = (live, plan, input) => [
    () => applyEdgeModeOverlay({ renderedConfig: render(live, sourceCommit), mode: "gcp", plan, trackedConfig, ...input }),
    () => applyEdgeModeSnapshotDelta({ snapshot: live, mode: "gcp", plan, trackedConfig, ...input }),
  ];
  const refusedBoth = (live, plan, code = "EDGE_MODE_PLAN_INVALID", input = {}) => {
    for (const attempt of gcpInputs(live, plan, input)) throwsCode(attempt, code);
  };
  const acceptedBoth = (live, plan, input = {}) => {
    const { config } = applyEdgeModeOverlay({ renderedConfig: render(live, sourceCommit), mode: "gcp", plan, trackedConfig, ...input });
    const expected = applyEdgeModeSnapshotDelta({ snapshot: live, mode: "gcp", plan, trackedConfig, ...input });
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true);
    return expected;
  };

  // The first switch: the unbound legacy primary and ledger and the staging D1s
  // are refused by id and by name, as well as the live data D1s.
  const fenced = fencedWithEdgeSecrets();
  refusedBoth(fenced, withGuard(legacyPrimary.database_id));
  refusedBoth(fenced, withGuard(legacyLedger.database_id));
  refusedBoth(fenced, withGuard(GUARD_ID, legacyPrimary.database_name));
  refusedBoth(fenced, withGuard(stagingPrimary.database_id));
  refusedBoth(fenced, withGuard(GUARD_ID, stagingPrimary.database_name));
  refusedBoth(fenced, withGuard(LEDGER_ID));
  // Every mode needs the tracked production config, so a caller wired without
  // it fails on its first worker deploy rather than at the gcp switch.
  refusedBoth(fenced, GCP_PLAN, "EDGE_MODE_INPUT_INVALID", { trackedConfig: undefined });
  refusedBoth(fenced, GCP_PLAN, "EDGE_MODE_INPUT_INVALID", { trackedConfig: stagingTracked() });
  for (const mode of ["worker", "fenced"]) {
    for (const input of [{}, { trackedConfig: undefined }, { trackedConfig: [] }, { trackedConfig: stagingTracked() }]) {
      throwsCode(() => applyEdgeModeOverlay({ renderedConfig: render(fenced, sourceCommit), mode, ...input }),
        "EDGE_MODE_INPUT_INVALID");
      throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot: fenced, mode, ...input }), "EDGE_MODE_INPUT_INVALID");
    }
  }
  // A tracked RELEASE_GUARD_DB entry (a later checked-in config) names the guard itself.
  const trackedWithGuard = structuredClone(trackedConfig);
  trackedWithGuard.env.production.d1_databases.push({
    binding: "RELEASE_GUARD_DB", database_id: GUARD_ID, database_name: GCP_PLAN.releaseGuardDatabase.name,
    migrations_dir: "release-guard-migrations",
  });
  acceptedBoth(fenced, GCP_PLAN, { trackedConfig: trackedWithGuard });

  const gcpLive = deployed(acceptedBoth(fenced, GCP_PLAN), sourceCommit, versionId(500));
  const braked = deployed(applyEdgeModeSnapshotDelta({ snapshot: gcpLive, mode: "fenced", trackedConfig }), sourceCommit, versionId(501));
  assert.equal(liveEdgeMode(braked), "fenced");
  for (const live of [gcpLive, braked]) {
    // The data D1s are no longer bound, but the bound guard pins the plan.
    assert.equal(live.bindings.some((binding) => binding.name === "USAGE_MONITOR_DB"), false);
    refusedBoth(live, withGuard(INGESTION_ID));
    refusedBoth(live, withGuard(ANALYTICS_ID));
    refusedBoth(live, withGuard(legacyPrimary.database_id));
    refusedBoth(live, withGuard(EXTRA_ID)); // a new, empty nonce table
    acceptedBoth(live, GCP_PLAN);
    acceptedBoth(live, { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 120 });
  }
});

test("worker mode is refused on any live state only a gcp deploy produces", () => {
  const sourceCommit = sha("6");
  const fenced = fencedWithEdgeSecrets();
  const gcpLive = deployed(delta({ snapshot: fenced, mode: "gcp", plan: GCP_PLAN }), sourceCommit, versionId(510));
  const braked = deployed(delta({ snapshot: gcpLive, mode: "fenced" }), sourceCommit, versionId(511));
  // A deployment-history read that wrongly reports no gcp version since the fence.
  assert.equal(assertEdgeModeTransition({
    liveMode: liveEdgeMode(braked), targetMode: "worker", gcpEverDeployedSinceFence: false,
  }).to, "worker");
  const refuseWorker = (live) => {
    throwsCode(() => overlay({ renderedConfig: render(live, sourceCommit), mode: "worker" }), "EDGE_MODE_TRANSITION_FORBIDDEN");
    throwsCode(() => delta({ snapshot: live, mode: "worker" }), "EDGE_MODE_TRANSITION_FORBIDDEN");
  };
  refuseWorker(braked);
  refuseWorker(dropBindings(fenced, ["USAGE_MONITOR_DB"]));
  refuseWorker(addBindings(fenced, [{ name: "RELEASE_GUARD_DB", type: "d1", database_id: GUARD_ID }]));
  for (const name of ["EDGE_UPSTREAM_ORIGIN", "EDGE_ORIGIN_AUDIENCE", "EDGE_INVOKER_SERVICE_ACCOUNT",
    "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS"]) {
    refuseWorker(addBindings(fenced, [{ name, type: "plain_text", text: "100" }]));
  }
  // A gcp-shaped version without the mode var is not a pre-edge version.
  throwsCode(() => liveEdgeMode(dropBindings(braked, ["EDGE_UPSTREAM_MODE"])), "EDGE_MODE_LIVE_INVALID");
  throwsCode(() => liveEdgeMode(addBindings(fixture(), [{ name: "EDGE_ORIGIN_AUDIENCE", type: "plain_text", text: "x" }])),
    "EDGE_MODE_LIVE_INVALID");
  // The abort before any gcp version stays a var flip.
  const aborted = delta({ snapshot: fenced, mode: "worker" });
  const { config } = overlay({ renderedConfig: render(fenced, sourceCommit), mode: "worker" });
  assert.equal(verifyProductionLiveConfig({ snapshot: aborted, candidateConfig: config, sourceCommit }).ok, true);
});

test("the overlay and delta refuse any target the live mode cannot reach, whatever the caller's transition check", () => {
  const sourceCommit = sha("5");
  const preEdge = addBindings(fixture(), EDGE_SECRETS);
  const worker = deployed(delta({ snapshot: preEdge, mode: "worker" }), sourceCommit, versionId(520));
  const fenced = deployed(delta({ snapshot: worker, mode: "fenced" }), sourceCommit, versionId(521));
  const gcpLive = deployed(delta({ snapshot: fenced, mode: "gcp", plan: GCP_PLAN }), sourceCommit, versionId(522));
  const states = { null: preEdge, worker, fenced, gcp: gcpLive };
  assert.deepEqual(Object.entries(states).map(([, live]) => liveEdgeMode(live)), [null, "worker", "fenced", "gcp"]);
  const reachable = new Set(EDGE_MODE_TRANSITIONS.map((entry) => `${entry.from}->${entry.to}`));
  for (const [liveMode, live] of Object.entries(states)) {
    for (const [mode, plan] of [["worker"], ["fenced"], ["gcp", GCP_PLAN]]) {
      const pair = `${liveMode}->${mode}`;
      const attempts = [
        () => overlay({ renderedConfig: render(live, sourceCommit), mode, plan }),
        () => delta({ snapshot: live, mode, plan }),
      ];
      if (reachable.has(pair)) {
        const { config } = attempts[0]();
        assert.equal(verifyProductionLiveConfig({ snapshot: attempts[1](), candidateConfig: config, sourceCommit }).ok, true, pair);
      } else {
        // null -> fenced, null -> gcp, worker -> gcp and gcp -> worker. A gcp
        // switch without the fence would strand post-export writes in D1.
        for (const attempt of attempts) throwsCode(attempt, "EDGE_MODE_TRANSITION_FORBIDDEN");
      }
    }
  }
  assert.deepEqual([...reachable].filter((pair) => pair.endsWith("->gcp")).sort(), ["fenced->gcp", "gcp->gcp"]);
  // A render or snapshot whose live mode var is unreadable is refused, not read as pre-edge.
  const unreadable = setText(worker, "EDGE_UPSTREAM_MODE", "Fenced");
  throwsCode(() => overlay({ renderedConfig: render(unreadable, sourceCommit), mode: "fenced" }), "EDGE_MODE_LIVE_INVALID");
  throwsCode(() => delta({ snapshot: unreadable, mode: "fenced" }), "EDGE_MODE_LIVE_INVALID");
  const unmarked = render(dropBindings(gcpLive, ["EDGE_UPSTREAM_MODE"]), sourceCommit);
  throwsCode(() => overlay({ renderedConfig: unmarked, mode: "gcp", plan: GCP_PLAN }), "EDGE_MODE_LIVE_INVALID");
  throwsCode(() => delta({ snapshot: dropBindings(gcpLive, ["EDGE_UPSTREAM_MODE"]), mode: "gcp", plan: GCP_PLAN }),
    "EDGE_MODE_LIVE_INVALID");
});

test("plans, modes and inputs are closed and fail with content-free codes", () => {
  const snapshot = fixture();
  const plain = render(snapshot, sha("c"));
  const invalidPlans = [
    ["worker", GCP_PLAN],
    ["worker", { upstreamOrigin: GCP_PLAN.upstreamOrigin }],
    ["fenced", { upstreamHeadersTimeoutSeconds: 100 }],
    ["gcp", null],
    ["gcp", undefined],
    ["gcp", {}],
    ["gcp", { ...GCP_PLAN, extra: true }],
    ["gcp", { ...GCP_PLAN, upstreamOrigin: "https://origin.example.com" }],
    ["gcp", { ...GCP_PLAN, upstreamOrigin: `${GCP_PLAN.upstreamOrigin}/` }],
    ["gcp", { ...GCP_PLAN, upstreamOrigin: "http://tibotattle-origin-synthetic.a.run.app" }],
    ["gcp", { ...GCP_PLAN, originAudience: " padded" }],
    ["gcp", { ...GCP_PLAN, invokerServiceAccount: "edge-invoker@example.com" }],
    ["gcp", { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 4 }],
    ["gcp", { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 301 }],
    ["gcp", { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: "100" }],
    ["gcp", { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 1.5 }],
    ["gcp", { ...GCP_PLAN, releaseGuardDatabase: { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", name: "synthetic" } }],
    ["gcp", { ...GCP_PLAN, releaseGuardDatabase: { id: GUARD_ID } }],
    ["gcp", { ...GCP_PLAN, releaseGuardDatabase: { id: GUARD_ID, name: "Synthetic Guard" } }],
    ["gcp", { ...GCP_PLAN, releaseGuardDatabase: { id: GUARD_ID, name: "synthetic", extra: 1 } }],
  ];
  for (const [mode, plan] of invalidPlans) {
    throwsCode(() => normalizeEdgeModePlan({ mode, plan }), "EDGE_MODE_PLAN_INVALID");
    throwsCode(() => overlay({ renderedConfig: plain, mode, plan }), "EDGE_MODE_PLAN_INVALID");
    throwsCode(() => delta({ snapshot, mode, plan }), "EDGE_MODE_PLAN_INVALID");
  }
  for (const mode of [undefined, null, "", "Worker", "gcp ", "json"]) {
    throwsCode(() => overlay({ renderedConfig: plain, mode }), "EDGE_MODE_INVALID");
    throwsCode(() => delta({ snapshot, mode }), "EDGE_MODE_INVALID");
  }
  for (const mode of ["worker", "fenced"]) {
    for (const plan of [undefined, null, {}]) assert.equal(normalizeEdgeModePlan({ mode, plan }), null);
  }
  assert.deepEqual(normalizeEdgeModePlan({ mode: "gcp", plan: GCP_PLAN }), { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 100 });

  const flat = structuredClone(plain.env.production);
  throwsCode(() => overlay({ renderedConfig: flat, mode: "worker" }), "EDGE_MODE_CONFIG_INVALID");
  const secretClash = structuredClone(plain);
  secretClash.env.production.secrets.required.push("EDGE_UPSTREAM_MODE");
  throwsCode(() => overlay({ renderedConfig: secretClash, mode: "worker" }), "EDGE_MODE_CONFIG_INVALID");

  const tampered = structuredClone(snapshot);
  tampered.bindings.find((binding) => binding.name === "TELEMETRY_STORAGE_MODE").text = "json";
  throwsCode(() => delta({ snapshot: tampered, mode: "worker" }), "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => delta({ snapshot: inventoryOf(snapshot), mode: "worker" }), "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => liveEdgeMode(setText(delta({ snapshot, mode: "worker" }), "EDGE_UPSTREAM_MODE", "Worker")),
    "EDGE_MODE_LIVE_INVALID");
});

test("the typed verifier accepts only the release guard's own migrations directory", () => {
  const live = fencedWithEdgeSecrets();
  const sourceCommit = sha("f");
  const plain = render(live, sourceCommit);
  const { config } = overlay({ renderedConfig: plain, mode: "gcp", plan: GCP_PLAN });
  const expected = delta({ snapshot: live, mode: "gcp", plan: GCP_PLAN });
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true);
  assert.deepEqual(PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS, { RELEASE_GUARD_DB: EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR });

  const legacyDirectory = structuredClone(config);
  legacyDirectory.env.production.d1_databases[0].migrations_dir = "migrations";
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: legacyDirectory, sourceCommit }).code,
    "PRODUCTION_LIVE_CONFIG_BINDING_INVALID");
  const dataDirectory = structuredClone(plain);
  dataDirectory.env.production.d1_databases[0].migrations_dir = "migrations";
  assert.equal(verifyProductionLiveConfig({ snapshot: live, candidateConfig: dataDirectory, sourceCommit }).code,
    "PRODUCTION_LIVE_CONFIG_BINDING_INVALID");
  const guardDirectoryOnData = structuredClone(plain);
  guardDirectoryOnData.env.production.d1_databases[0].migrations_dir = "release-guard-migrations";
  assert.equal(verifyProductionLiveConfig({ snapshot: live, candidateConfig: guardDirectoryOnData, sourceCommit }).code,
    "PRODUCTION_LIVE_CONFIG_BINDING_INVALID");
});

test("verifyEdgeModeLiveSnapshot checks the active version, mode, domains and the gcp storage allowlist", () => {
  const sourceCommit = sha("a");
  const id = versionId(200);
  const gcpLive = deployed(delta({ snapshot: fencedWithEdgeSecrets(), mode: "gcp", plan: GCP_PLAN }), sourceCommit, id);
  const check = (snapshot, overrides = {}) => verifyEdgeModeLiveSnapshot({
    snapshot, mode: "gcp", deployment: single(id), sourceCommit, ...overrides,
  });
  const retired = [{ code: "RETIRED_SECRET_PRESENT", names: [...EDGE_MODE_RETIRED_SECRETS].sort() }];
  assert.deepEqual(check(gcpLive), { ok: true, code: null, warnings: retired });
  assert.deepEqual(check(addBindings(gcpLive, [{ name: "ANALYTICS_DB", type: "d1", database_id: ANALYTICS_ID }])),
    { ok: false, code: "EDGE_MODE_GCP_STORAGE_BINDING_PRESENT", warnings: retired });
  assert.equal(check(addBindings(gcpLive, [{ name: "QUARANTINE", type: "r2_bucket", bucket_name: "synthetic-q" }])).code,
    "EDGE_MODE_GCP_STORAGE_BINDING_PRESENT");
  assert.equal(check(resnapshot(gcpLive, { crons: ["* * * * *"] })).code, "EDGE_MODE_GCP_CRONS_PRESENT");
  assert.equal(check(dropBindings(gcpLive, ["EDGE_INVOKER_KEY_JSON"])).code, "EDGE_MODE_SECRET_MISSING");
  assert.equal(check(dropBindings(gcpLive, ["RELEASE_GUARD_DB"])).code, "EDGE_MODE_RETAINED_BINDING_MISSING");
  assert.equal(check(dropBindings(gcpLive, ["SPARKLE_RELEASES"])).code, "EDGE_MODE_RETAINED_BINDING_MISSING");
  assert.equal(check(setText(gcpLive, "EDGE_UPSTREAM_ORIGIN", "https://origin.example.com")).code,
    "EDGE_MODE_GCP_CONFIGURATION_INVALID");
  assert.deepEqual(check(dropBindings(gcpLive, EDGE_MODE_RETIRED_SECRETS)), { ok: true, code: null, warnings: [] });

  assert.equal(check(gcpLive, { mode: "fenced" }).code, "EDGE_MODE_MISMATCH");
  assert.equal(check(gcpLive, { deployment: { versions: [
    { version_id: id, percentage: 50 }, { version_id: versionId(199), percentage: 50 },
  ] } }).code, "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  assert.equal(check(gcpLive, { deployment: single(versionId(199)) }).code, "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  assert.equal(check(gcpLive, { deployment: { versions: [{ version_id: id, percentage: 99.9 }] } }).code,
    "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  assert.equal(check(gcpLive, { deployment: undefined }).code, "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  // The live version at 100% is not enough: it must be the only version listed.
  for (const versions of [
    [{ version_id: id, percentage: 100 }, { version_id: versionId(199), percentage: 0 }],
    [{ version_id: id, percentage: 100 }, { version_id: id, percentage: 100 }],
    [{ version_id: id, percentage: 100 }, { version_id: id, percentage: 0 }],
    [],
  ]) {
    assert.equal(check(gcpLive, { deployment: { versions } }).code, "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  }
  // The brief's bare {snapshot, mode} call is unverified, not a mode reading.
  assert.equal(verifyEdgeModeLiveSnapshot({ snapshot: gcpLive, mode: "gcp" }).code, "EDGE_MODE_INPUT_INVALID");
  assert.equal(verifyEdgeModeLiveSnapshot({ snapshot: gcpLive, mode: "gcp", sourceCommit }).code,
    "EDGE_MODE_DEPLOYMENT_NOT_SINGLE");
  assert.equal(liveEdgeMode(gcpLive), "gcp");
  assert.equal(check(gcpLive, { sourceCommit: sha("b") }).code, "EDGE_MODE_SOURCE_MISMATCH");
  assert.equal(check(gcpLive, { sourceCommit: "HEAD" }).code, "EDGE_MODE_INPUT_INVALID");
  assert.equal(check(gcpLive, { mode: "GCP" }).code, "EDGE_MODE_INVALID");
  for (const expectedDomains of [["tibotattle.com", "tibotattle.com"], "tibotattle.com", ["Tibotattle.com"], [null]]) {
    assert.equal(check(gcpLive, { expectedDomains }).code, "EDGE_MODE_INPUT_INVALID");
  }

  const workerLive = deployed(delta({ snapshot: fixture(), mode: "worker" }), sourceCommit, id);
  const worker = (snapshot) => check(snapshot, { mode: "worker" });
  assert.deepEqual(worker(workerLive), { ok: true, code: null, warnings: [] });
  assert.equal(check(deployed(fixture(), sourceCommit, id), { mode: "worker" }).code, "EDGE_MODE_MISMATCH");
  const domains = workerLive.domains;
  assert.equal(worker(resnapshot(workerLive, { domains: domains.filter((domain) => !domain.hostname.startsWith("admin.")) })).code,
    "EDGE_MODE_DOMAINS_CHANGED");
  assert.equal(worker(resnapshot(workerLive, { domains: [...domains, { hostname: "extra.tibotattle.com" }] })).code,
    "EDGE_MODE_DOMAINS_CHANGED");
  assert.equal(worker(setText(workerLive, "EDGE_UPSTREAM_MODE", "Worker")).code, "EDGE_MODE_LIVE_INVALID");
});

test("output is byte-identical across runs and the overlay sha is pinned", () => {
  const live = fencedWithEdgeSecrets();
  const plain = render(live, sha("c"));
  for (const [mode, plan] of [["worker"], ["fenced"], ["gcp", GCP_PLAN]]) {
    const first = overlay({ renderedConfig: plain, mode, plan });
    const second = overlay({ renderedConfig: render(live, sha("c")), mode, plan: reverseKeys(plan) });
    const bytes = serializeEdgeModeConfig(first.config);
    assert.equal(bytes, serializeEdgeModeConfig(second.config));
    assert.equal(bytes, `${JSON.stringify(first.config, null, 2)}\n`);
    // The bytes a typed deploy writes read back as the same verified config.
    const expected = delta({ snapshot: live, mode, plan });
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: parse(bytes), sourceCommit: sha("c") }).ok, true);
    assert.equal(first.overlaySha256, second.overlaySha256);
    assert.equal(first.overlaySha256, PINNED_OVERLAY_SHA256[mode]);
    assert.equal(first.overlaySha256, edgeModeOverlaySha256({ mode, plan }));
    const deltaA = delta({ snapshot: live, mode, plan });
    const deltaB = delta({ snapshot: reverseKeys(structuredClone(live)), mode, plan });
    assert.equal(JSON.stringify(deltaA), JSON.stringify(deltaB));
  }
  assert.equal(EDGE_MODE_OVERLAY_SCHEMA, "edge-mode-overlay-v1");
  assert.equal(edgeModeOverlaySha256({ mode: "worker", plan: {} }), PINNED_OVERLAY_SHA256.worker);
  assert.equal(edgeModeOverlaySha256({ mode: "gcp", plan: { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 100 } }),
    PINNED_OVERLAY_SHA256.gcp);
  assert.notEqual(edgeModeOverlaySha256({ mode: "gcp", plan: { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 120 } }),
    PINNED_OVERLAY_SHA256.gcp);
  assert.notEqual(edgeModeOverlaySha256({ mode: "gcp", plan: { ...GCP_PLAN, originAudience: "other" } }),
    PINNED_OVERLAY_SHA256.gcp);
});

test("the transition matrix allows exactly the roll-forward pairs", () => {
  const allowed = new Set([
    "null->worker", "worker->worker", "worker->fenced", "fenced->fenced",
    "fenced->gcp", "gcp->gcp", "gcp->fenced",
  ]);
  for (const liveMode of [null, "worker", "fenced", "gcp"]) {
    for (const targetMode of ["worker", "fenced", "gcp"]) {
      for (const gcpEverDeployedSinceFence of [false, true, undefined]) {
        const pair = `${liveMode}->${targetMode}`;
        const expected = allowed.has(pair) || (pair === "fenced->worker" && gcpEverDeployedSinceFence === false);
        const attempt = () => assertEdgeModeTransition({ liveMode, targetMode, gcpEverDeployedSinceFence });
        if (expected) assert.equal(attempt().to, targetMode, pair);
        else throwsCode(attempt, "EDGE_MODE_TRANSITION_FORBIDDEN");
      }
    }
  }
  for (const [liveMode, targetMode] of [[undefined, "worker"], ["bogus", "worker"], ["worker", null], ["worker", "Worker"],
    [null, "fenced"], [null, "gcp"], ["worker", "gcp"], ["gcp", "worker"]]) {
    throwsCode(() => assertEdgeModeTransition({ liveMode, targetMode, gcpEverDeployedSinceFence: false }),
      "EDGE_MODE_TRANSITION_FORBIDDEN");
  }
  assert.equal(Object.isFrozen(EDGE_MODE_TRANSITIONS), true);
  assert.equal(EDGE_MODE_TRANSITIONS.every(Object.isFrozen), true);
});

const STAGING_PLAN = Object.freeze({
  upstreamOrigin: "https://tibotattle-origin-staging.a.run.app",
  originAudience: "https://synthetic-staging-audience.example",
  invokerServiceAccount: "edge-invoker@synthetic-staging.iam.gserviceaccount.com",
  releaseGuardDatabase: Object.freeze({ id: "a7777777-7777-4777-8777-777777777777", name: "synthetic-staging-release-guard" }),
});

/**
 * A staging Worker shaped like the checked-in env.staging: its own name, D1s,
 * buckets and rate-limit namespaces, served on workers.dev with no custom
 * domain. It carries the gcp prerequisites (a Sparkle bucket and the edge
 * secrets) that the owner provisions before the staging gcp step.
 */
function stagingSnapshot() {
  const production = fixture();
  const stagingRateLimits = new Map(tracked().env.staging.ratelimits.map((entry) => [entry.name, entry.namespace_id]));
  const stagingIds = new Map([
    ["USAGE_MONITOR_DB", "a1111111-1111-4111-8111-111111111111"],
    ["ANALYTICS_DB", "a2222222-2222-4222-8222-222222222222"],
    ["DELETION_LEDGER", "a3333333-3333-4333-8333-333333333333"],
  ]);
  const stagingBuckets = new Map([
    ["QUARANTINE", "synthetic-staging-quarantine"],
    ["SPARKLE_RELEASES", "synthetic-staging-updates"],
  ]);
  const stagingTexts = new Map([
    ["ENVIRONMENT", "staging"],
    ["PUBLIC_ORIGIN", "https://app-usagemonitor-staging.synthetic.workers.dev"],
    ["SPARKLE_APPCAST_GUARD_BUCKET", "synthetic-staging-updates"],
  ]);
  return resnapshot(production, {
    workerName: "app-usagemonitor-staging",
    bindings: [...production.bindings.map((binding) => {
      if (stagingIds.has(binding.name)) return { ...binding, database_id: stagingIds.get(binding.name) };
      if (stagingBuckets.has(binding.name)) return { ...binding, bucket_name: stagingBuckets.get(binding.name) };
      if (stagingTexts.has(binding.name)) return { ...binding, text: stagingTexts.get(binding.name) };
      if (binding.type === "ratelimit") return { ...binding, namespace_id: stagingRateLimits.get(binding.name) };
      return binding;
    }), ...EDGE_SECRETS],
    domains: [],
    subdomain: { enabled: true, previews_enabled: false },
    namespaces: production.namespaces.map((namespace) => ({
      ...namespace, name: "app-usagemonitor-staging_UploadIngressBudget", script: "app-usagemonitor-staging",
    })),
  });
}

function stagingRename(snapshot, workerName) {
  return resnapshot(snapshot, {
    workerName,
    namespaces: snapshot.namespaces.map((namespace) => ({
      ...namespace, name: `${workerName}_UploadIngressBudget`, script: workerName,
    })),
  });
}

/** The staging Worker after its worker and fenced rehearsal steps, where its gcp step starts. */
function fencedStaging(snapshot = stagingSnapshot()) {
  return addBindings(snapshot, [{ name: "EDGE_UPSTREAM_MODE", type: "plain_text", text: "fenced" }]);
}

test("the staging variant rehearses every mode on a workers.dev-only staging Worker", () => {
  const production = fixture();
  const trackedConfig = tracked();
  const staging = stagingSnapshot();
  const productionRateLimits = production.bindings.filter((binding) => binding.type === "ratelimit")
    .map((binding) => binding.namespace_id);
  assert.equal(staging.bindings.some((binding) => binding.type === "ratelimit"
    && productionRateLimits.includes(binding.namespace_id)), false);
  const sourceCommit = sha("9");
  // Before the owner creates the production origin and guard D1 there is no
  // production gcp plan (P0); from then on the rehearsal passes it.
  for (const productionPlan of [null, GCP_PLAN]) {
    const common = { productionSnapshot: production, trackedConfig, productionPlan };
    let live = staging;
    let index = 300;
    for (const [mode, modePlan] of [["worker"], ["worker"], ["fenced"], ["gcp", STAGING_PLAN], ["gcp", STAGING_PLAN],
      ["fenced"], ["gcp", STAGING_PLAN]]) {
      const plain = render(live, sourceCommit, stagingTracked());
      assert.equal(plain.env, undefined);
      const { config } = applyEdgeModeStagingOverlay({ renderedConfig: plain, snapshot: live, mode, plan: modePlan, ...common });
      const expected = applyEdgeModeStagingSnapshotDelta({ snapshot: live, mode, plan: modePlan, ...common });
      assert.equal(config.main, EDGE_MODE_ENTRY_MAIN);
      assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true, mode);
      const id = versionId(index);
      index += 1;
      live = deployed(expected, sourceCommit, id);
      const verify = (overrides) => verifyEdgeModeLiveSnapshot({ snapshot: live, mode, deployment: single(id), sourceCommit, ...overrides });
      assert.equal(verify({ expectedDomains: [] }).ok, true, mode);
      assert.equal(verify({}).code, "EDGE_MODE_DOMAINS_CHANGED", mode);
      assert.equal(verify({ expectedDomains: ["staging.synthetic.example"] }).code, "EDGE_MODE_DOMAINS_CHANGED", mode);
    }
  }
  const common = { productionSnapshot: production, trackedConfig, productionPlan: null };

  // Staging may use its own names under the production zone.
  const zoned = resnapshot(setText(staging, "PUBLIC_ORIGIN", "https://staging.tibotattle.com"), {
    domains: [{ hostname: "staging.tibotattle.com" }],
  });
  let zonedLive = zoned;
  let index = 400;
  for (const mode of ["worker", "fenced"]) {
    const { config } = applyEdgeModeStagingOverlay({
      renderedConfig: render(zonedLive, sourceCommit, stagingTracked()), snapshot: zonedLive, mode, ...common,
    });
    const expected = applyEdgeModeStagingSnapshotDelta({ snapshot: zonedLive, mode, ...common });
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true, mode);
    const id = versionId(index);
    index += 1;
    zonedLive = deployed(expected, sourceCommit, id);
    assert.equal(verifyEdgeModeLiveSnapshot({
      snapshot: zonedLive, mode, deployment: single(id), sourceCommit, expectedDomains: ["staging.tibotattle.com"],
    }).ok, true, mode);
  }
  applyEdgeModeStagingSnapshotDelta({
    snapshot: zonedLive, mode: "gcp", ...common,
    plan: { ...STAGING_PLAN, upstreamOrigin: "https://staging-origin.a.run.app", originAudience: "https://staging.tibotattle.com" },
  });

  // A nested render (the staging Worker as its config's env.production)
  // changes only env.production; its root and other environments come back as rendered.
  const { env: trackedEnv, ...trackedRoot } = tracked();
  const nestedTracked = { ...trackedRoot, env: { production: structuredClone(trackedEnv.staging), staging: trackedEnv.staging } };
  const nestedPlain = render(staging, sourceCommit, nestedTracked);
  assert.equal(nestedPlain.env.production.name, staging.workerName);
  const nested = applyEdgeModeStagingOverlay({ renderedConfig: nestedPlain, snapshot: staging, mode: "worker", ...common });
  const { env: nestedEnv, ...nestedRoot } = nested.config;
  const { env: nestedPlainEnv, ...nestedPlainRoot } = nestedPlain;
  assert.deepEqual(nestedRoot, nestedPlainRoot);
  assert.deepEqual(Object.keys(nestedEnv).sort(), ["production", "staging"]);
  assert.deepEqual(nestedEnv.staging, nestedPlainEnv.staging);
  assert.equal(nestedEnv.production.main, EDGE_MODE_ENTRY_MAIN);
  assert.deepEqual(withoutDeclaredChange(nested.config, nestedPlain), nestedPlain);
  assert.equal(verifyProductionLiveConfig({
    snapshot: applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "worker", ...common }),
    candidateConfig: nested.config,
    sourceCommit,
  }).ok, true);
});

test("the staging variant refuses every production reference and no other", () => {
  const production = fixture();
  const trackedConfig = tracked();
  const trackedProduction = trackedConfig.env.production;
  const legacyPrimary = trackedProduction.d1_databases[0].database_id;
  const staging = fencedStaging();
  const sourceCommit = sha("9");
  const common = { productionSnapshot: production, trackedConfig, productionPlan: null };
  const refused = (snapshot, overrides = {}) => {
    const input = { snapshot, mode: "gcp", plan: STAGING_PLAN, ...common, ...overrides };
    throwsCode(() => applyEdgeModeStagingSnapshotDelta(input), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
    const renderedConfig = overrides.renderedConfig ?? render(snapshot, sourceCommit, stagingTracked());
    throwsCode(() => applyEdgeModeStagingOverlay({ ...input, renderedConfig }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  };
  /** A reference only a rendered staging environment can carry: the delta has no config to refuse. */
  const refusedRender = (edit) => {
    const renderedConfig = render(staging, sourceCommit, stagingTracked());
    edit(renderedConfig);
    throwsCode(() => applyEdgeModeStagingOverlay({
      renderedConfig, snapshot: staging, mode: "worker", ...common,
    }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  };
  const replace = (name, field, value) => resnapshot(staging, {
    bindings: staging.bindings.map((binding) => binding.name === name ? { ...binding, [field]: value } : binding),
  });

  // The unmodified staging Worker is accepted in every mode.
  for (const [mode, plan] of [["worker"], ["fenced"], ["gcp", STAGING_PLAN]]) {
    applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode, plan, ...common });
    applyEdgeModeStagingOverlay({
      renderedConfig: render(staging, sourceCommit, stagingTracked()), snapshot: staging, mode, plan, ...common,
    });
  }

  // D1 databases, by id, by name and as var text.
  refused(replace("USAGE_MONITOR_DB", "database_id", INGESTION_ID));
  refused(replace("ANALYTICS_DB", "database_id", ANALYTICS_ID));
  refused(replace("DELETION_LEDGER", "database_id", legacyPrimary));
  refused(replace("DELETION_LEDGER", "database_name", trackedProduction.d1_databases[1].database_name));
  refused(replace("TELEMETRY_STORAGE_NAMESPACE", "text", INGESTION_ID));
  refusedRender((config) => { config.d1_databases[0].database_id = INGESTION_ID; });
  refused(staging, { plan: { ...STAGING_PLAN, releaseGuardDatabase: { id: INGESTION_ID, name: "synthetic-staging-release-guard" } } });
  // The production guard D1's fixed name, whatever production evidence exists.
  refused(staging, { plan: { ...STAGING_PLAN, releaseGuardDatabase: {
    id: STAGING_PLAN.releaseGuardDatabase.id, name: EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME,
  } } });
  assert.equal(EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME, "tibotattle-release-guard");
  // R2 buckets, as bindings, in the rendered environment and as var text.
  refused(replace("SPARKLE_RELEASES", "bucket_name", "synthetic-production-updates"));
  refused(replace("QUARANTINE", "bucket_name", trackedProduction.r2_buckets[0].bucket_name));
  refused(replace("SPARKLE_APPCAST_GUARD_BUCKET", "text", "synthetic-production-updates"));
  refusedRender((config) => {
    config.r2_buckets.find((entry) => entry.binding === "QUARANTINE").bucket_name = "synthetic-production-quarantine";
  });
  // Rate-limit namespaces, from the production snapshot and the tracked config.
  refused(replace("PUBLIC_READ_RATE_LIMIT", "namespace_id", "9004"));
  refused(replace("CLIENT_ATTEMPT_RATE_LIMIT", "namespace_id",
    trackedProduction.ratelimits.find((entry) => entry.name === "CLIENT_ATTEMPT_RATE_LIMIT").namespace_id));
  refusedRender((config) => { config.ratelimits[0].namespace_id = "9001"; });
  refusedRender((config) => { config.ratelimits[0].namespace_id = 9001; });
  const numericTracked = structuredClone(trackedConfig);
  numericTracked.env.production.ratelimits[0].namespace_id = 3999;
  refused(replace("ENROLLMENT_RATE_LIMIT", "namespace_id", "3999"), { trackedConfig: numericTracked });
  // Production hostnames, as custom domains, routes and var text (in the
  // snapshot or only in the rendered environment); other names under the zone
  // are accepted by the rehearsal test above.
  for (const hostname of EDGE_MODE_PRODUCTION_HOSTNAMES) {
    refused(resnapshot(staging, { domains: [{ hostname }] }));
    refused(setText(staging, "PUBLIC_ORIGIN", `https://${hostname}/path`));
  }
  refused(resnapshot(staging, { routes: [{ pattern: "tibotattle.com/*" }] }));
  refused(resnapshot(staging, { routes: [{ pattern: "*.tibotattle.com/*" }] }));
  refused(staging, { plan: { ...STAGING_PLAN, originAudience: "https://tibotattle.com" } });
  refusedRender((config) => { config.routes = [{ pattern: "www.tibotattle.com", custom_domain: true }]; });
  refusedRender((config) => { config.vars.PUBLIC_ORIGIN = "https://tibotattle.com"; });
  // The live production domains and routes join the refused hostnames.
  const productionWithHosts = resnapshot(production, {
    domains: [...production.domains, { hostname: "status.synthetic-production.example" }],
    routes: [{ pattern: "api.synthetic-production.example/v1/*" }],
  });
  // A route's path is not a hostname.
  applyEdgeModeStagingSnapshotDelta({
    snapshot: setText(staging, "PUBLIC_ORIGIN", "https://app-usagemonitor-staging.synthetic.workers.dev/v1"),
    mode: "worker", ...common, productionSnapshot: productionWithHosts,
  });
  refused(resnapshot(staging, { domains: [{ hostname: "status.synthetic-production.example" }] }),
    { productionSnapshot: productionWithHosts });
  refused(setText(staging, "PUBLIC_ORIGIN", "https://api.synthetic-production.example"),
    { productionSnapshot: productionWithHosts });
  // So do the tracked production routes, which no live snapshot need carry.
  const trackedHosted = resnapshot(staging, { domains: [{ hostname: "legacy.synthetic-tracked.example" }] });
  applyEdgeModeStagingSnapshotDelta({ snapshot: trackedHosted, mode: "gcp", plan: STAGING_PLAN, ...common });
  for (const route of [{ pattern: "legacy.synthetic-tracked.example", custom_domain: true }, "legacy.synthetic-tracked.example/*"]) {
    const routedTracked = structuredClone(trackedConfig);
    routedTracked.env.production.routes.push(route);
    refused(trackedHosted, { trackedConfig: routedTracked });
  }
  // Worker names: the snapshot, a Durable Object script, the rendered
  // environment, var text, and a tracked name.
  const asProduction = stagingRename(staging, "app-usagemonitor");
  refused(asProduction, { renderedConfig: render(asProduction, sourceCommit, { ...stagingTracked(), name: "app-usagemonitor" }) });
  refused(replace("UPLOAD_INGRESS_BUDGET", "script_name", "app-usagemonitor"));
  refused(setText(staging, "ENVIRONMENT", "app-usagemonitor"));
  refusedRender((config) => { config.durable_objects.bindings[0].script_name = "app-usagemonitor"; });
  refusedRender((config) => { config.name = "app-usagemonitor"; });
  const alias = "app-usagemonitor-tracked-alias";
  const aliasTracked = structuredClone(trackedConfig);
  aliasTracked.env.production.name = alias;
  const asAlias = stagingRename(staging, alias);
  const aliasRender = render(asAlias, sourceCommit, { ...stagingTracked(), name: alias });
  refused(asAlias, { trackedConfig: aliasTracked, renderedConfig: aliasRender });
  applyEdgeModeStagingOverlay({ renderedConfig: aliasRender, snapshot: asAlias, mode: "worker", ...common });
  // The production snapshot and render passed off as staging.
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: production, mode: "worker", ...common }),
    "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  throwsCode(() => applyEdgeModeStagingOverlay({
    renderedConfig: render(production, sourceCommit), snapshot: staging, mode: "worker", ...common,
  }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
});

test("before production binds its gcp values, the production plan is what the staging variant refuses", () => {
  const production = fixture();
  const trackedConfig = tracked();
  const staging = fencedStaging();
  const sourceCommit = sha("9");
  const common = { productionSnapshot: production, trackedConfig };
  const planned = { ...common, productionPlan: GCP_PLAN };
  const refused = (snapshot, plan, input = planned) => {
    throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot, mode: "gcp", plan, ...input }),
      "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
    throwsCode(() => applyEdgeModeStagingOverlay({
      renderedConfig: render(snapshot, sourceCommit, stagingTracked()), snapshot, mode: "gcp", plan, ...input,
    }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  };
  // Between P1 and the production gcp switch the production guard D1 and
  // origin exist, but the production snapshot (worker or fenced) binds neither.
  assert.equal(production.bindings.some((binding) => binding.name === "RELEASE_GUARD_DB"), false);
  // Declared as absent, a copy of the production plan has nothing to be refused against ...
  applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "gcp", plan: GCP_PLAN, ...common, productionPlan: null });
  // ... and with the production plan supplied it is refused, value by value.
  refused(staging, GCP_PLAN);
  refused(staging, { ...STAGING_PLAN, releaseGuardDatabase: { id: GUARD_ID, name: STAGING_PLAN.releaseGuardDatabase.name } });
  refused(staging, { ...STAGING_PLAN, releaseGuardDatabase: {
    id: STAGING_PLAN.releaseGuardDatabase.id, name: GCP_PLAN.releaseGuardDatabase.name,
  } });
  for (const key of ["upstreamOrigin", "originAudience", "invokerServiceAccount"]) {
    refused(staging, { ...STAGING_PLAN, [key]: GCP_PLAN[key] });
  }
  // A staging binding or var naming the production guard or origin, in any mode.
  const guardBound = resnapshot(staging, {
    bindings: staging.bindings.map((binding) => binding.name === "USAGE_MONITOR_DB" ? { ...binding, database_id: GUARD_ID } : binding),
  });
  refused(guardBound, STAGING_PLAN);
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: guardBound, mode: "worker", ...planned }),
    "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({
    snapshot: setText(staging, "PUBLIC_ORIGIN", GCP_PLAN.upstreamOrigin), mode: "fenced", ...planned,
  }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  // The rehearsal's own plan is accepted beside it.
  const { config } = applyEdgeModeStagingOverlay({
    renderedConfig: render(staging, sourceCommit, stagingTracked()), snapshot: staging, mode: "gcp", plan: STAGING_PLAN, ...planned,
  });
  const expected = applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "gcp", plan: STAGING_PLAN, ...planned });
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true);
});

test("the staging variant needs its inputs, a pre-gcp production baseline after the switch, and the gcp prerequisites", () => {
  const production = fixture();
  const trackedConfig = tracked();
  const staging = fencedStaging();
  const common = { productionSnapshot: production, trackedConfig, productionPlan: null };
  const invalid = (input) => {
    throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "worker", ...input }),
      "EDGE_MODE_STAGING_INPUT_INVALID");
    throwsCode(() => applyEdgeModeStagingOverlay({
      renderedConfig: render(staging, sha("9"), stagingTracked()), snapshot: staging, mode: "worker", ...input,
    }), "EDGE_MODE_STAGING_INPUT_INVALID");
  };
  invalid({ trackedConfig, productionPlan: null });
  invalid({ productionSnapshot: production, productionPlan: null });
  invalid({ productionSnapshot: production, trackedConfig: stagingTracked(), productionPlan: null });
  // The production plan is required in every mode: a gcp plan, or null before
  // the production gcp resources exist. A malformed plan is refused.
  invalid({ productionSnapshot: production, trackedConfig });
  invalid({ ...common, productionPlan: undefined });
  for (const productionPlan of [{}, [], "gcp", { ...GCP_PLAN, upstreamOrigin: "https://origin.example.com" },
    { ...GCP_PLAN, releaseGuardDatabase: { id: GUARD_ID } }]) {
    invalid({ ...common, productionPlan });
  }

  // After the gcp switch the live production snapshot no longer names the data
  // D1s and buckets, so a pre-gcp baseline must supply them.
  const productionGcp = deployed(delta({ snapshot: fencedWithEdgeSecrets(), mode: "gcp", plan: GCP_PLAN }), sha("8"), versionId(400));
  invalid({ ...common, productionPlan: GCP_PLAN, productionSnapshot: productionGcp });
  invalid({ ...common, productionPlan: GCP_PLAN, productionBaselineSnapshot: staging });
  const afterSwitch = { ...common, productionSnapshot: productionGcp, productionBaselineSnapshot: production, productionPlan: GCP_PLAN };
  // A production snapshot that binds gcp values contradicts "no production plan".
  invalid({ ...afterSwitch, productionPlan: null });
  applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "gcp", plan: STAGING_PLAN, ...afterSwitch });
  const refused = (snapshot, overrides) => throwsCode(() => applyEdgeModeStagingSnapshotDelta({
    snapshot, mode: "gcp", plan: STAGING_PLAN, ...afterSwitch, ...overrides,
  }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  refused(resnapshot(staging, {
    bindings: staging.bindings.map((binding) => binding.name === "USAGE_MONITOR_DB" ? { ...binding, database_id: INGESTION_ID } : binding),
  }));
  refused(staging, { plan: { ...STAGING_PLAN, upstreamOrigin: GCP_PLAN.upstreamOrigin } });
  refused(staging, { plan: { ...STAGING_PLAN, releaseGuardDatabase: GCP_PLAN.releaseGuardDatabase } });
  // The live production values are refused even when the supplied plan has moved on.
  const nextProductionPlan = { ...GCP_PLAN, upstreamOrigin: "https://tibotattle-origin-next.a.run.app", originAudience: "https://next.example" };
  for (const key of ["upstreamOrigin", "originAudience"]) {
    refused(staging, { productionPlan: nextProductionPlan, plan: { ...STAGING_PLAN, [key]: GCP_PLAN[key] } });
    refused(staging, { productionPlan: nextProductionPlan, plan: { ...STAGING_PLAN, [key]: nextProductionPlan[key] } });
  }
  refused(staging, { productionPlan: nextProductionPlan, plan: { ...STAGING_PLAN, releaseGuardDatabase: {
    id: STAGING_PLAN.releaseGuardDatabase.id, name: GCP_PLAN.releaseGuardDatabase.name,
  } } });

  // The checked-in staging Worker has no Sparkle bucket, guard token or
  // distribution token: worker and fenced rehearse, gcp refuses until the owner
  // provisions them.
  const checkedInShape = dropBindings(staging, ["SPARKLE_RELEASES", "SPARKLE_APPCAST_GUARD_TOKEN", "DISTRIBUTION_ANALYTICS_API_TOKEN"]);
  for (const mode of ["worker", "fenced"]) applyEdgeModeStagingSnapshotDelta({ snapshot: checkedInShape, mode, ...common });
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: checkedInShape, mode: "gcp", plan: STAGING_PLAN, ...common }),
    "EDGE_MODE_SECRET_MISSING");
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({
    snapshot: dropBindings(staging, ["SPARKLE_RELEASES"]), mode: "gcp", plan: STAGING_PLAN, ...common,
  }), "EDGE_MODE_RETAINED_BINDING_MISSING");
  // The staging guard is never one of the staging Worker's own tracked D1s.
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({
    snapshot: staging, mode: "gcp", ...common,
    plan: { ...STAGING_PLAN, releaseGuardDatabase: { id: trackedConfig.env.staging.d1_databases[0].database_id, name: "synthetic-staging-release-guard" } },
  }), "EDGE_MODE_PLAN_INVALID");
  // The staging variant enforces the same live-mode sources as production.
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: stagingSnapshot(), mode: "gcp", plan: STAGING_PLAN, ...common }),
    "EDGE_MODE_TRANSITION_FORBIDDEN");
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: stagingSnapshot(), mode: "fenced", ...common }),
    "EDGE_MODE_TRANSITION_FORBIDDEN");
});

test("the module never writes the tracked configuration or local secret templates", () => {
  const source = readFileSync(MODULE_URL, "utf8");
  assert.doesNotMatch(source, /from\s+["']node:(?:fs|child_process)/u);
  assert.doesNotMatch(source, /\bconsole\./u);
  assert.doesNotMatch(source, /jsonc-parser/u);
  assert.deepEqual(
    TRACKED_FILES.map((url) => createHash("sha256").update(readFileSync(url)).digest("hex")),
    trackedDigests,
  );
  assert.equal(TRACKED_FILES.length >= 1, true);
});
