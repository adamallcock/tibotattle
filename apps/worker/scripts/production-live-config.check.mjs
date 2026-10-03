import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS,
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
  productionObservabilityMatchesLive,
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
    observability: { enabled: true, head_sampling_rate: 1, redact_query_string: false },
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

test("the API root asset base path is equivalent to its absent form", () => {
  const before = baseline();
  const withRootBasePath = inventory();
  withRootBasePath.version.resources.script_runtime = {
    ...runtime,
    assets: { ...runtime.assets, base_path: "/" },
  };
  const after = createProductionLiveConfigSnapshot(withRootBasePath);
  assert.deepEqual(after.runtime.assets, before.runtime.assets);
  assert.equal(after.fingerprint, before.fingerprint);
});

test("non-root and unknown asset runtime fields fail closed", () => {
  const nonRoot = inventory();
  nonRoot.version.resources.script_runtime = {
    ...runtime,
    assets: { ...runtime.assets, base_path: "/assets" },
  };
  assert.throws(() => createProductionLiveConfigSnapshot(nonRoot), { code: "PRODUCTION_LIVE_CONFIG_RUNTIME_INVALID" });

  const unknown = inventory();
  unknown.version.resources.script_runtime = {
    ...runtime,
    assets: { ...runtime.assets, unexpected: true },
  };
  assert.throws(() => createProductionLiveConfigSnapshot(unknown), { code: "PRODUCTION_LIVE_CONFIG_RUNTIME_INVALID" });
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

test("a candidate D1 migrations_dir is accepted only as the release guard's own directory", () => {
  assert.deepEqual(PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS, { RELEASE_GUARD_DB: "release-guard-migrations" });
  assert.equal(Object.isFrozen(PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS), true);
  const guard = "55555555-5555-4555-8555-555555555555";
  const value = inventory();
  value.version.resources.bindings.push({ name: "RELEASE_GUARD_DB", type: "d1", id: guard, database_id: guard });
  value.settings.bindings = value.version.resources.bindings;
  const snapshot = createProductionLiveConfigSnapshot(value);
  const verify = (binding, directory) => {
    const candidate = renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot, sourceCommit: NEXT_SOURCE });
    if (binding !== undefined) {
      candidate.env.production.d1_databases.find((entry) => entry.binding === binding).migrations_dir = directory;
    }
    return verifyProductionLiveConfig({ snapshot, candidateConfig: candidate, sourceCommit: NEXT_SOURCE });
  };
  assert.equal(verify().ok, true);
  // Config-only: Wrangler reads it for `d1 migrations`, the live inventory never reports it.
  assert.equal(verify("RELEASE_GUARD_DB", "release-guard-migrations").ok, true);
  for (const [binding, directory] of [
    ["RELEASE_GUARD_DB", "migrations"],
    ["RELEASE_GUARD_DB", "./release-guard-migrations"],
    ["USAGE_MONITOR_DB", "migrations"],
    ["USAGE_MONITOR_DB", "release-guard-migrations"],
    ["ANALYTICS_DB", "release-guard-migrations"],
    ["DELETION_LEDGER", "deletion-ledger-migrations"],
  ]) {
    const result = verify(binding, directory);
    assert.equal(result.code, "PRODUCTION_LIVE_CONFIG_BINDING_INVALID", `${binding} ${directory}`);
    assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  }
});

// The settings API's observability object as captured read-only on
// 2026-10-03 for the staging edge Worker and the production Worker, each
// deployed from a config declaring only { enabled: true, head_sampling_rate: 1 }.
const LIVE_OBSERVABILITY = Object.freeze({
  staging: {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: false,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 },
  },
  production: {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: false,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 },
  },
});
const DECLARED_OBSERVABILITY = Object.freeze({ enabled: true, head_sampling_rate: 1 });

function liveSnapshot(observability) {
  const value = inventory();
  value.settings.observability = structuredClone(observability);
  return createProductionLiveConfigSnapshot(value);
}

function verifyDeclared(snapshot, observability) {
  const candidate = renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot: baseline(), sourceCommit: NEXT_SOURCE });
  candidate.env.production.observability = structuredClone(observability);
  return verifyProductionLiveConfig({ snapshot, candidateConfig: candidate, sourceCommit: NEXT_SOURCE });
}

test("the captured staging and production observability shapes match a config that declares only enabled and sampling", () => {
  for (const [name, observability] of Object.entries(LIVE_OBSERVABILITY)) {
    const snapshot = liveSnapshot(observability);
    assert.equal(snapshot.settings.observability.redact_query_string, undefined, name);
    assert.deepEqual(snapshot.settings.placement, {}, name);
    // A candidate declared from the tracked config (the genesis path) ...
    const declared = verifyDeclared(snapshot, DECLARED_OBSERVABILITY);
    assert.equal(declared.ok, true, `${name}: ${declared.code}`);
    assert.equal(declared.actualFingerprint, snapshot.fingerprint, name);
    // ... and one rendered from the live snapshot (the typed redeploy path).
    const rendered = renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot, sourceCommit: NEXT_SOURCE });
    assert.equal(Object.hasOwn(rendered.env.production.observability, "redact_query_string"), false, name);
    // Live placement {} is the absent form: the candidate does not declare it.
    assert.equal(Object.hasOwn(rendered.env.production, "placement"), false, name);
    assert.equal(verifyProductionLiveConfig({ snapshot, candidateConfig: rendered, sourceCommit: NEXT_SOURCE }).ok, true, name);
  }
});

test("a live observability value other than the pinned default is drift for an undeclared field", () => {
  const mutations = [
    ["traces.enabled", (value) => { value.traces.enabled = true; }],
    ["traces.persist", (value) => { value.traces.persist = false; }],
    ["traces.head_sampling_rate", (value) => { value.traces.head_sampling_rate = 0.5; }],
    ["logs.persist", (value) => { value.logs.persist = false; }],
    ["logs.enabled", (value) => { value.logs.enabled = false; }],
    ["logs.invocation_logs", (value) => { value.logs.invocation_logs = false; }],
    ["logs.head_sampling_rate", (value) => { value.logs.head_sampling_rate = 0.25; }],
    ["logs.destinations", (value) => { value.logs.destinations = ["synthetic-destination"]; }],
    ["traces.destinations", (value) => { value.traces.destinations = []; }],
    ["redact_query_string", (value) => { value.redact_query_string = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const observability = structuredClone(LIVE_OBSERVABILITY.production);
    mutate(observability);
    const snapshot = liveSnapshot(observability);
    const result = verifyDeclared(snapshot, DECLARED_OBSERVABILITY);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT", name);
    assert.deepEqual(Object.keys(result).sort(), ["code", "ok"], name);
  }
  // Wrangler cannot carry the API-only key, so a non-default value is not rendered away.
  const redacted = liveSnapshot({ ...LIVE_OBSERVABILITY.production, redact_query_string: true });
  assert.equal(redacted.settings.observability.redact_query_string, true);
  assert.throws(() => renderProductionLiveConfig({ trackedConfig: trackedConfig(), snapshot: redacted, sourceCommit: NEXT_SOURCE }),
    { code: "PRODUCTION_LIVE_CONFIG_CONFIG_CONFIG_SETTINGS_DRIFT" });
});

test("pinned defaults apply only to the observed enabled, full-sampling declaration", () => {
  for (const declaration of [{ enabled: true }, { enabled: true, head_sampling_rate: 0.5 }, { enabled: false, head_sampling_rate: 1 }]) {
    const snapshot = liveSnapshot({ ...LIVE_OBSERVABILITY.production, ...declaration });
    const result = verifyDeclared(snapshot, declaration);
    assert.equal(result.code, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT", JSON.stringify(declaration));
  }
});

test("unknown observability keys fail closed in the live inventory and the candidate config", () => {
  for (const mutate of [
    (value) => { value.unexpected = true; },
    (value) => { value.logs.unexpected = true; },
    (value) => { value.traces.unexpected = true; },
    // Wrangler's schema gives traces no invocation_logs; only logs carries it.
    (value) => { value.traces.invocation_logs = true; },
    (value) => { value.redact_query_string = "false"; },
  ]) {
    const observability = structuredClone(LIVE_OBSERVABILITY.production);
    mutate(observability);
    assert.throws(() => liveSnapshot(observability), { code: "PRODUCTION_LIVE_CONFIG_SETTINGS_INVALID" });
  }
  const snapshot = liveSnapshot(LIVE_OBSERVABILITY.production);
  for (const declaration of [
    { ...DECLARED_OBSERVABILITY, unexpected: true },
    { ...DECLARED_OBSERVABILITY, redact_query_string: false },
    { ...DECLARED_OBSERVABILITY, logs: { unexpected: true } },
    { ...DECLARED_OBSERVABILITY, traces: { invocation_logs: true } },
  ]) {
    assert.equal(verifyDeclared(snapshot, declaration).code, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_INVALID");
  }
});

test("the exported observability comparator applies the same closed pinned-defaults rule", () => {
  const match = productionObservabilityMatchesLive;
  for (const [name, live] of Object.entries(LIVE_OBSERVABILITY)) {
    assert.equal(match(DECLARED_OBSERVABILITY, live), true, name);
    // A config copied verbatim from the capture compares exactly, API-only key included.
    assert.equal(match(structuredClone(live), live), true, name);
  }
  assert.equal(match(undefined, undefined), true);
  assert.equal(match(null, undefined), true);
  assert.equal(match(undefined, LIVE_OBSERVABILITY.production), false);
  assert.equal(match(DECLARED_OBSERVABILITY, undefined), false);
  assert.equal(match({ enabled: true }, { enabled: true }), true);
  for (const mutate of [
    (value) => { value.traces.enabled = true; },
    (value) => { value.logs.persist = false; },
    (value) => { value.logs.destinations = []; },
    (value) => { value.redact_query_string = true; },
    (value) => { value.enabled = false; },
  ]) {
    const live = structuredClone(LIVE_OBSERVABILITY.production);
    mutate(live);
    assert.equal(match(DECLARED_OBSERVABILITY, live), false, JSON.stringify(live));
  }
  // Defaults apply only to the observed declaration.
  assert.equal(match({ enabled: true }, { ...LIVE_OBSERVABILITY.production, head_sampling_rate: undefined }), false);
  // A declared redact_query_string other than the live value is drift both ways.
  assert.equal(match({ ...DECLARED_OBSERVABILITY, redact_query_string: true }, LIVE_OBSERVABILITY.production), false);
  assert.equal(match(DECLARED_OBSERVABILITY, { ...LIVE_OBSERVABILITY.production, redact_query_string: true }), false);
  assert.equal(match({ ...LIVE_OBSERVABILITY.production, redact_query_string: true },
    { ...LIVE_OBSERVABILITY.production, redact_query_string: true }), true);
  for (const live of [
    { ...LIVE_OBSERVABILITY.production, unexpected: true },
    { ...LIVE_OBSERVABILITY.production, traces: { ...LIVE_OBSERVABILITY.production.traces, invocation_logs: true } },
  ]) {
    assert.throws(() => match(DECLARED_OBSERVABILITY, live), { code: "PRODUCTION_LIVE_CONFIG_SETTINGS_INVALID" });
  }
  for (const declared of [{ ...DECLARED_OBSERVABILITY, unexpected: true }, { ...DECLARED_OBSERVABILITY, traces: { invocation_logs: true } }]) {
    assert.throws(() => match(declared, LIVE_OBSERVABILITY.production), { code: "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_INVALID" });
  }
});

test("observability fields a config declares compare exactly", () => {
  const snapshot = liveSnapshot(LIVE_OBSERVABILITY.production);
  const exact = structuredClone(LIVE_OBSERVABILITY.production);
  delete exact.redact_query_string;
  for (const declaration of [
    exact,
    { ...DECLARED_OBSERVABILITY, logs: { persist: true } },
    { ...DECLARED_OBSERVABILITY, traces: { enabled: false } },
  ]) {
    assert.equal(verifyDeclared(snapshot, declaration).ok, true, JSON.stringify(declaration));
  }
  for (const declaration of [
    { ...DECLARED_OBSERVABILITY, logs: { persist: false } },
    { ...DECLARED_OBSERVABILITY, logs: { invocation_logs: false } },
    { ...DECLARED_OBSERVABILITY, traces: { enabled: true } },
    { ...DECLARED_OBSERVABILITY, traces: { destinations: [] } },
  ]) {
    assert.equal(verifyDeclared(snapshot, declaration).code, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT", JSON.stringify(declaration));
  }
  // A declared field the live response omits is still drift.
  const sparse = liveSnapshot(DECLARED_OBSERVABILITY);
  assert.equal(verifyDeclared(sparse, { ...DECLARED_OBSERVABILITY, logs: { persist: true } }).code,
    "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT");
  assert.equal(verifyDeclared(sparse, DECLARED_OBSERVABILITY).ok, true);
});
