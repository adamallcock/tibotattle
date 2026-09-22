import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";

const ACCOUNT = "a".repeat(32);
const SOURCE = "b".repeat(40);
const NEXT_SOURCE = "c".repeat(40);
const DATABASE = "11111111-1111-4111-8111-111111111111";
const ANALYTICS = "22222222-2222-4222-8222-222222222222";
const LEDGER = "33333333-3333-4333-8333-333333333333";
const DO_NAMESPACE = "44444444-4444-4444-8444-444444444444";

const runtime = {
  migration_tag: "upload-ingress-budget-v1",
  assets: {
    not_found_handling: "404-page",
    raw_run_worker_first: true,
    serve_directly: false,
  },
  compatibility_date: "2026-07-26",
  compatibility_flags: ["nodejs_compat"],
  usage_model: "standard",
  limits: { cpu_ms: 300000 },
  cache_options: { enabled: true, cross_version_cache: false },
};

function bindings(source = SOURCE) {
  return [
    { name: "USAGE_MONITOR_DB", type: "d1", id: DATABASE, database_id: DATABASE },
    { name: "ANALYTICS_DB", type: "d1", id: ANALYTICS, database_id: ANALYTICS },
    { name: "DELETION_LEDGER", type: "d1", id: LEDGER, database_id: LEDGER },
    { name: "QUARANTINE", type: "r2_bucket", bucket_name: "synthetic-quarantine" },
    { name: "UPLOAD_INGRESS_BUDGET", type: "durable_object_namespace", namespace_id: DO_NAMESPACE, class_name: "UploadIngressBudget" },
    { name: "PUBLIC_READ_RATE_LIMIT", type: "ratelimit", namespace_id: "3004", simple: { limit: 120, period: 60 } },
    { name: "ASSETS", type: "assets" },
    { name: "PUBLIC_ORIGIN", type: "plain_text", text: "https://synthetic.example" },
    { name: "DEPLOYMENT_SOURCE_COMMIT", type: "plain_text", text: source },
    { name: "ENVELOPE_PRIVATE_JWK", type: "secret_text" },
  ];
}

function settings(source = SOURCE) {
  return {
    placement: {},
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags,
    usage_model: runtime.usage_model,
    tags: [],
    tail_consumers: [],
    logpush: false,
    limits: runtime.limits,
    observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
    annotations: { "workers/message": "synthetic" },
    cache_options: runtime.cache_options,
    bindings: bindings(source),
  };
}

function inventory(source = SOURCE) {
  return {
    capturedAt: "2026-09-21T00:00:00.000Z",
    accountId: ACCOUNT,
    workerName: "synthetic-worker",
    version: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      number: 7,
      metadata: { author_email: "private@example.invalid" },
      resources: { script_runtime: runtime, bindings: bindings(source) },
    },
    settings: settings(source),
    schedules: { schedules: [{ cron: "* * * * *", created_on: "private", modified_on: "private" }] },
    subdomain: { enabled: false, previews_enabled: false },
    routes: [],
    domains: [
      { hostname: "synthetic.example", service: "synthetic-worker", environment: "production", enabled: true, previews_enabled: false },
      { hostname: "www.synthetic.example", service: "synthetic-worker", environment: "production", enabled: true, previews_enabled: false },
    ],
    namespaces: [{
      id: DO_NAMESPACE,
      name: "synthetic-worker_UploadIngressBudget",
      script: "synthetic-worker",
      class: "UploadIngressBudget",
      use_sqlite: true,
    }],
  };
}

function trackedConfig() {
  return {
    name: "synthetic-root",
    main: "src/index.ts",
    compatibility_date: "2026-07-26",
    migrations: [{ tag: "upload-ingress-budget-v1", new_sqlite_classes: ["UploadIngressBudget"] }],
    env: {
      production: {
        name: "synthetic-worker",
        main: "src/index.ts",
        workers_dev: false,
        preview_urls: false,
        compatibility_date: "2026-07-26",
        compatibility_flags: ["nodejs_compat"],
        limits: { cpu_ms: 300000 },
        cache: { enabled: true, cross_version_cache: false },
        observability: { enabled: true },
        routes: [{ pattern: "synthetic.example", custom_domain: true }],
        triggers: { crons: ["* * * * *"] },
        vars: { PUBLIC_ORIGIN: "https://synthetic.example" },
        secrets: { required: ["ENVELOPE_PRIVATE_JWK"] },
        d1_databases: [
          { binding: "USAGE_MONITOR_DB", database_id: DATABASE, database_name: "synthetic", migrations_dir: "migrations" },
          { binding: "DELETION_LEDGER", database_id: LEDGER, database_name: "synthetic-ledger", migrations_dir: "deletion-ledger-migrations" },
        ],
        r2_buckets: [{ binding: "QUARANTINE", bucket_name: "synthetic-quarantine" }],
        ratelimits: [{ name: "PUBLIC_READ_RATE_LIMIT", namespace_id: 3004, simple: { limit: 120, period: 60 } }],
        durable_objects: { bindings: [{ name: "UPLOAD_INGRESS_BUDGET", class_name: "UploadIngressBudget" }] },
        assets: { binding: "ASSETS", directory: "../../.release-build/public-release-site", not_found_handling: "404-page", run_worker_first: true },
      },
      staging: { name: "synthetic-staging" },
    },
  };
}

function baseline() {
  return createProductionLiveConfigSnapshot(inventory());
}

test("snapshot and effective config preserve typed bindings, runtime, routes and cron", () => {
  const snapshot = baseline();
  const candidate = renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot, sourceCommit: NEXT_SOURCE });
  const production = candidate.env.production;
  assert.equal(snapshot.bindings.length, 10);
  assert.equal(candidate.account_id, ACCOUNT);
  assert.equal(production.account_id, ACCOUNT);
  assert.equal(production.d1_databases.length, 3);
  assert.equal(production.d1_databases.find((entry) => entry.binding === "ANALYTICS_DB")?.database_id, ANALYTICS);
  assert.equal(production.d1_databases.find((entry) => entry.binding === "USAGE_MONITOR_DB")?.database_name, "synthetic");
  assert.equal(production.d1_databases.some((entry) => Object.hasOwn(entry, "migrations_dir")), false);
  assert.equal(production.vars.DEPLOYMENT_SOURCE_COMMIT, NEXT_SOURCE);
  assert.equal(production.vars.PUBLIC_ORIGIN, "https://synthetic.example");
  assert.deepEqual(production.triggers.crons, ["* * * * *"]);
  assert.deepEqual(production.routes, [
    { pattern: "synthetic.example", custom_domain: true },
    { pattern: "www.synthetic.example", custom_domain: true },
  ]);
  assert.deepEqual(production.migrations, [{
    tag: "upload-ingress-budget-v1",
    new_sqlite_classes: ["UploadIngressBudget"],
  }]);
  assert.deepEqual(verifyProductionLiveConfig({ snapshot, candidateConfig: candidate, sourceCommit: NEXT_SOURCE }), {
    ok: true,
    code: null,
    expectedFingerprint: snapshot.fingerprint,
    actualFingerprint: snapshot.fingerprint,
  });
  assert.equal(candidate.env.staging.name, "synthetic-staging");
});

test("a source-only version change does not change the deployment fingerprint", () => {
  const before = baseline();
  const after = createProductionLiveConfigSnapshot(inventory(NEXT_SOURCE));
  assert.equal(productionLiveConfigFingerprint(before), productionLiveConfigFingerprint(after));
  assert.notEqual(before.sourceCommit, after.sourceCommit);
  assert.equal(before.versionId, after.versionId);
});

test("unknown binding types fail closed without exposing private values", () => {
  const value = inventory();
  value.version.resources.bindings.push({ name: "PRIVATE_SENTINEL", type: "unknown_binding", text: "private-value" });
  value.settings.bindings = value.version.resources.bindings;
  assert.throws(() => createProductionLiveConfigSnapshot(value), (error) => {
    assert.equal(error.code, "PRODUCTION_LIVE_CONFIG_BINDING_TYPE_UNSUPPORTED");
    assert.equal(error.message.includes("private-value"), false);
    assert.equal(error.message.includes("PRIVATE_SENTINEL"), false);
    return true;
  });
});

test("missing settings, missing namespace evidence and settings binding drift fail closed", () => {
  const missing = inventory();
  delete missing.settings;
  assert.throws(() => createProductionLiveConfigSnapshot(missing), { code: "PRODUCTION_LIVE_CONFIG_SETTINGS_MISSING" });

  const namespaceMissing = inventory();
  namespaceMissing.namespaces = [];
  assert.throws(() => createProductionLiveConfigSnapshot(namespaceMissing), { code: "PRODUCTION_LIVE_CONFIG_NAMESPACE_BINDING_DRIFT" });

  const drift = inventory();
  drift.settings.bindings = drift.settings.bindings.filter((binding) => binding.name !== "ANALYTICS_DB");
  assert.throws(() => createProductionLiveConfigSnapshot(drift), { code: "PRODUCTION_LIVE_CONFIG_SETTINGS_BINDINGS_DRIFT" });
});

test("candidate binding, runtime, route, cron and settings drift are refused", () => {
  const snapshot = baseline();
  const cases = [
    ["vars", (config) => { config.env.production.vars.PUBLIC_ORIGIN = "https://drift.example"; }, "PRODUCTION_LIVE_CONFIG_CONFIG_BINDING_DRIFT"],
    ["runtime", (config) => { config.env.production.limits.cpu_ms = 1; }, "PRODUCTION_LIVE_CONFIG_CONFIG_RUNTIME_DRIFT"],
    ["routes", (config) => { config.env.production.routes = []; }, "PRODUCTION_LIVE_CONFIG_CONFIG_ROUTE_DRIFT"],
    ["cron", (config) => { config.env.production.triggers.crons = []; }, "PRODUCTION_LIVE_CONFIG_CONFIG_CRON_DRIFT"],
    ["settings", (config) => { config.env.production.observability.enabled = false; }, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT"],
    ["root account", (config) => { config.account_id = "d".repeat(32); }, "PRODUCTION_LIVE_CONFIG_CONFIG_ACCOUNT_DRIFT"],
    ["environment account", (config) => { config.env.production.account_id = "d".repeat(32); }, "PRODUCTION_LIVE_CONFIG_CONFIG_ACCOUNT_DRIFT"],
    ["migration deletion", (config) => { config.env.production.migrations[0].deleted_classes = ["UploadIngressBudget"]; }, "PRODUCTION_LIVE_CONFIG_CONFIG_MIGRATIONS_INVALID"],
    ["migration class", (config) => { config.env.production.migrations[0].new_sqlite_classes = ["UnexpectedClass"]; }, "PRODUCTION_LIVE_CONFIG_CONFIG_MIGRATIONS_INVALID"],
    ["migration history", (config) => { config.env.production.migrations.unshift({ tag: "unexpected", new_sqlite_classes: [] }); }, "PRODUCTION_LIVE_CONFIG_CONFIG_MIGRATIONS_INVALID"],
    ["source", (config) => { config.env.production.vars.DEPLOYMENT_SOURCE_COMMIT = "d".repeat(40); }, "PRODUCTION_LIVE_CONFIG_CONFIG_SOURCE_INVALID"],
  ];
  for (const [, mutate, expected] of cases) {
    const candidate = renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot, sourceCommit: NEXT_SOURCE });
    mutate(candidate);
    const result = verifyProductionLiveConfig({ snapshot, candidateConfig: candidate, sourceCommit: NEXT_SOURCE });
    assert.equal(result.ok, false);
    assert.equal(result.code, expected);
    assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  }
});

test("alias and resource-shape changes are rejected before rendering", () => {
  const value = inventory();
  value.version.resources.bindings[0].database_id = ANALYTICS;
  value.settings.bindings = value.version.resources.bindings;
  assert.throws(() => createProductionLiveConfigSnapshot(value), { code: "PRODUCTION_LIVE_CONFIG_BINDING_INVALID" });

  const extraBindingField = inventory();
  extraBindingField.version.resources.bindings[0].unexpected = true;
  extraBindingField.settings.bindings = extraBindingField.version.resources.bindings;
  assert.throws(() => createProductionLiveConfigSnapshot(extraBindingField), { code: "PRODUCTION_LIVE_CONFIG_BINDING_INVALID" });

  const config = trackedConfig();
  config.env.production.queues = { producers: [] };
  assert.throws(() => renderProductionLiveConfig({ trackedConfig: config, snapshot: baseline(), sourceCommit: NEXT_SOURCE }), { code: "PRODUCTION_LIVE_CONFIG_CONFIG_RESOURCE_UNSUPPORTED" });

  for (const key of ["annotations", "tags", "usage_model"]) {
    const unsupported = trackedConfig();
    unsupported.env.production[key] = key === "tags" ? [] : key === "annotations" ? {} : "standard";
    assert.throws(() => renderProductionLiveConfig({ trackedConfig: unsupported, snapshot: baseline(), sourceCommit: NEXT_SOURCE }), { code: "PRODUCTION_LIVE_CONFIG_CONFIG_SETTING_UNSUPPORTED" });
  }
});
