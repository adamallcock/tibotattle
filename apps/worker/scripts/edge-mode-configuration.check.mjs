import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import {
  EDGE_MODE_ENTRY_MAIN,
  EDGE_MODE_GCP_REQUIRED_SECRETS,
  EDGE_MODE_OVERLAY_SCHEMA,
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

/** A fenced live state with the edge secrets put, built directly as a starting
 * point; the transition path to it is covered by the roll-forward chain. */
function fencedWithEdgeSecrets() {
  return applyEdgeModeSnapshotDelta({ snapshot: addBindings(fixture(), EDGE_SECRETS), mode: "fenced" });
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
  const { config, overlaySha256 } = applyEdgeModeOverlay({ renderedConfig: plain, mode: "worker" });
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

  const workerLive = deployed(applyEdgeModeSnapshotDelta({ snapshot, mode: "worker" }), sha("d"), versionId(153));
  const workerPlain = render(workerLive, sha("e"), trackedConfig);
  const fenced = applyEdgeModeOverlay({ renderedConfig: workerPlain, mode: "fenced" }).config;
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
    const { config } = applyEdgeModeOverlay({ renderedConfig: plain, mode, plan });
    const expected = applyEdgeModeSnapshotDelta({ snapshot: live, mode, plan });
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
  const { config } = applyEdgeModeOverlay({ renderedConfig: plain, mode: "gcp", plan: GCP_PLAN });
  const expected = applyEdgeModeSnapshotDelta({ snapshot: live, mode: "gcp", plan: GCP_PLAN });
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
  const fencedExpected = applyEdgeModeSnapshotDelta({ snapshot: live, mode: "fenced" });
  assert.equal(verifyProductionLiveConfig({ snapshot: fencedExpected, candidateConfig: config, sourceCommit }).ok, false);
  const fencedConfig = applyEdgeModeOverlay({ renderedConfig: plain, mode: "fenced" }).config;
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: fencedConfig, sourceCommit }).ok, false);

  const both = (snapshot, code, plan = GCP_PLAN) => {
    throwsCode(() => applyEdgeModeOverlay({ renderedConfig: render(snapshot, sourceCommit), mode: "gcp", plan }), code);
    throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot, mode: "gcp", plan }), code);
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
    throwsCode(() => applyEdgeModeOverlay({ renderedConfig: plain, mode, plan }), "EDGE_MODE_PLAN_INVALID");
    throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot, mode, plan }), "EDGE_MODE_PLAN_INVALID");
  }
  for (const mode of [undefined, null, "", "Worker", "gcp ", "json"]) {
    throwsCode(() => applyEdgeModeOverlay({ renderedConfig: plain, mode }), "EDGE_MODE_INVALID");
    throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot, mode }), "EDGE_MODE_INVALID");
  }
  for (const mode of ["worker", "fenced"]) {
    for (const plan of [undefined, null, {}]) assert.equal(normalizeEdgeModePlan({ mode, plan }), null);
  }
  assert.deepEqual(normalizeEdgeModePlan({ mode: "gcp", plan: GCP_PLAN }), { ...GCP_PLAN, upstreamHeadersTimeoutSeconds: 100 });

  const flat = structuredClone(plain.env.production);
  throwsCode(() => applyEdgeModeOverlay({ renderedConfig: flat, mode: "worker" }), "EDGE_MODE_CONFIG_INVALID");
  const secretClash = structuredClone(plain);
  secretClash.env.production.secrets.required.push("EDGE_UPSTREAM_MODE");
  throwsCode(() => applyEdgeModeOverlay({ renderedConfig: secretClash, mode: "worker" }), "EDGE_MODE_CONFIG_INVALID");

  const tampered = structuredClone(snapshot);
  tampered.bindings.find((binding) => binding.name === "TELEMETRY_STORAGE_MODE").text = "json";
  throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot: tampered, mode: "worker" }), "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => applyEdgeModeSnapshotDelta({ snapshot: inventoryOf(snapshot), mode: "worker" }), "EDGE_MODE_SNAPSHOT_INVALID");
  throwsCode(() => liveEdgeMode(setText(applyEdgeModeSnapshotDelta({ snapshot, mode: "worker" }), "EDGE_UPSTREAM_MODE", "Worker")),
    "EDGE_MODE_LIVE_INVALID");
});

test("the typed verifier accepts only the release guard's own migrations directory", () => {
  const live = fencedWithEdgeSecrets();
  const sourceCommit = sha("f");
  const plain = render(live, sourceCommit);
  const { config } = applyEdgeModeOverlay({ renderedConfig: plain, mode: "gcp", plan: GCP_PLAN });
  const expected = applyEdgeModeSnapshotDelta({ snapshot: live, mode: "gcp", plan: GCP_PLAN });
  assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true);

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
  const gcpLive = deployed(applyEdgeModeSnapshotDelta({ snapshot: fencedWithEdgeSecrets(), mode: "gcp", plan: GCP_PLAN }),
    sourceCommit, id);
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
  assert.equal(check(gcpLive, { sourceCommit: sha("b") }).code, "EDGE_MODE_SOURCE_MISMATCH");
  assert.equal(check(gcpLive, { sourceCommit: "HEAD" }).code, "EDGE_MODE_INPUT_INVALID");
  assert.equal(check(gcpLive, { mode: "GCP" }).code, "EDGE_MODE_INVALID");

  const workerLive = deployed(applyEdgeModeSnapshotDelta({ snapshot: fixture(), mode: "worker" }), sourceCommit, id);
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
    const first = applyEdgeModeOverlay({ renderedConfig: plain, mode, plan });
    const second = applyEdgeModeOverlay({ renderedConfig: render(live, sha("c")), mode, plan: reverseKeys(plan) });
    const bytes = serializeEdgeModeConfig(first.config);
    assert.equal(bytes, serializeEdgeModeConfig(second.config));
    assert.equal(bytes, `${JSON.stringify(first.config, null, 2)}\n`);
    // The bytes a typed deploy writes read back as the same verified config.
    const expected = applyEdgeModeSnapshotDelta({ snapshot: live, mode, plan });
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: parse(bytes), sourceCommit: sha("c") }).ok, true);
    assert.equal(first.overlaySha256, second.overlaySha256);
    assert.equal(first.overlaySha256, PINNED_OVERLAY_SHA256[mode]);
    assert.equal(first.overlaySha256, edgeModeOverlaySha256({ mode, plan }));
    const deltaA = applyEdgeModeSnapshotDelta({ snapshot: live, mode, plan });
    const deltaB = applyEdgeModeSnapshotDelta({ snapshot: reverseKeys(structuredClone(live)), mode, plan });
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

test("the staging variant rehearses every mode and refuses production references", () => {
  const production = fixture();
  const trackedConfig = tracked();
  const legacyPrimary = trackedConfig.env.production.d1_databases[0].database_id;
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
    ["PUBLIC_ORIGIN", "https://staging.synthetic.example"],
    ["SPARKLE_APPCAST_GUARD_BUCKET", "synthetic-staging-updates"],
  ]);
  const staging = resnapshot(production, {
    workerName: "app-usagemonitor-staging",
    bindings: [...production.bindings.map((binding) => {
      if (stagingIds.has(binding.name)) return { ...binding, database_id: stagingIds.get(binding.name) };
      if (stagingBuckets.has(binding.name)) return { ...binding, bucket_name: stagingBuckets.get(binding.name) };
      if (stagingTexts.has(binding.name)) return { ...binding, text: stagingTexts.get(binding.name) };
      return binding;
    }), ...EDGE_SECRETS],
    domains: [{ hostname: "staging.synthetic.example" }],
    subdomain: { enabled: true, previews_enabled: false },
    namespaces: production.namespaces.map((namespace) => ({
      ...namespace, name: "app-usagemonitor-staging_UploadIngressBudget", script: "app-usagemonitor-staging",
    })),
  });
  const plan = {
    upstreamOrigin: "https://tibotattle-origin-staging.a.run.app",
    originAudience: "https://synthetic-staging-audience.example",
    invokerServiceAccount: "edge-invoker@synthetic-staging.iam.gserviceaccount.com",
    releaseGuardDatabase: { id: "a7777777-7777-4777-8777-777777777777", name: "synthetic-staging-release-guard" },
  };
  const sourceCommit = sha("9");
  const common = { productionSnapshot: production, trackedConfig };
  let live = staging;
  let index = 300;
  for (const [mode, modePlan] of [["worker"], ["fenced"], ["gcp", plan], ["fenced"]]) {
    const plain = render(live, sourceCommit, stagingTracked());
    assert.equal(plain.env, undefined);
    const { config } = applyEdgeModeStagingOverlay({ renderedConfig: plain, snapshot: live, mode, plan: modePlan, ...common });
    const expected = applyEdgeModeStagingSnapshotDelta({ snapshot: live, mode, plan: modePlan, ...common });
    assert.equal(config.main, EDGE_MODE_ENTRY_MAIN);
    assert.equal(verifyProductionLiveConfig({ snapshot: expected, candidateConfig: config, sourceCommit }).ok, true, mode);
    const id = versionId(index);
    index += 1;
    live = deployed(expected, sourceCommit, id);
    assert.equal(verifyEdgeModeLiveSnapshot({
      snapshot: live, mode, deployment: single(id), sourceCommit, expectedDomains: ["staging.synthetic.example"],
    }).ok, true, mode);
  }

  const refused = (snapshot, overrides = {}) => {
    const input = { snapshot, mode: "gcp", plan, ...common, ...overrides };
    throwsCode(() => applyEdgeModeStagingSnapshotDelta(input), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
    const renderedConfig = overrides.renderedConfig ?? render(snapshot, sourceCommit, stagingTracked());
    throwsCode(() => applyEdgeModeStagingOverlay({ ...input, renderedConfig }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  };
  const replace = (name, field, value) => resnapshot(staging, {
    bindings: staging.bindings.map((binding) => binding.name === name ? { ...binding, [field]: value } : binding),
  });
  refused(replace("USAGE_MONITOR_DB", "database_id", INGESTION_ID));
  refused(replace("ANALYTICS_DB", "database_id", ANALYTICS_ID));
  refused(replace("DELETION_LEDGER", "database_id", legacyPrimary));
  refused(replace("SPARKLE_RELEASES", "bucket_name", "synthetic-production-updates"));
  refused(replace("QUARANTINE", "bucket_name", trackedConfig.env.production.r2_buckets[0].bucket_name));
  refused(replace("SPARKLE_APPCAST_GUARD_BUCKET", "text", "synthetic-production-updates"));
  refused(replace("PUBLIC_ORIGIN", "text", "https://tibotattle.com"));
  refused(resnapshot(staging, { domains: [{ hostname: "staging.tibotattle.com" }] }));
  refused(staging, { plan: { ...plan, releaseGuardDatabase: { id: INGESTION_ID, name: "synthetic-staging-release-guard" } } });
  refused(staging, { plan: { ...plan, originAudience: "https://tibotattle.com" } });
  const productionGcp = deployed(applyEdgeModeSnapshotDelta({ snapshot: fencedWithEdgeSecrets(), mode: "gcp", plan: GCP_PLAN }),
    sha("8"), versionId(400));
  refused(staging, { plan: { ...plan, upstreamOrigin: GCP_PLAN.upstreamOrigin }, productionSnapshot: productionGcp });
  refused(staging, { plan: { ...plan, releaseGuardDatabase: GCP_PLAN.releaseGuardDatabase }, productionSnapshot: productionGcp });
  // The production snapshot and render passed off as staging.
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: production, mode: "worker", ...common }),
    "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  throwsCode(() => applyEdgeModeStagingOverlay({
    renderedConfig: render(production, sourceCommit), snapshot: staging, mode: "worker", ...common,
  }), "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
  throwsCode(() => applyEdgeModeStagingSnapshotDelta({ snapshot: staging, mode: "worker", trackedConfig }),
    "EDGE_MODE_STAGING_INPUT_INVALID");
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
