import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "jsonc-parser";
import standIn from "../ops/staging-edge/catchup-standin/index.mjs";
import { validateCloudflareWriterFencePlan } from "./cloudflare-writer-fence.mjs";
import { edgeModeOverlaySha256 } from "./edge-mode-configuration.mjs";
import { renderProductionLiveConfig, verifyProductionLiveConfig } from "./production-live-config.mjs";
import {
  STAGING_DRY_RUN_PRODUCTION_CATCHUP_ID,
  stagingDryRunProductionFencePlan,
} from "./staging-edge-dry-run.mjs";
import {
  STAGING_EDGE_D1_ROLES,
  STAGING_EDGE_GENESIS_VERSION_ID,
  STAGING_EDGE_INPUTS_EXAMPLE_PATH,
  STAGING_EDGE_TEMPLATE_PATH,
  STAGING_EDGE_WORKER_DIRECTORY,
  assertStagingEdgeTarget,
  assertStagingOperationTarget,
  buildStagingFencePlan,
  buildStagingGcpPlan,
  createStagingGenesisSnapshot,
  parseStagingEdgeInputs,
  parseStagingEdgeTemplate,
  renderStagingEdgeTarget,
  renderStagingEdgeTemplate,
  resolveStagingEdgeIsolation,
  stagingEdgeInventoryOf,
} from "./staging-edge-target.mjs";

// Synthetic inputs only: the committed example, EP-9's synthetic production
// snapshot and a synthetic production fence plan that matches it. Nothing
// here reads a secret or reaches a network.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/edge-mode-live-snapshot.synthetic.json", import.meta.url), "utf8"));
const TEMPLATE_TEXT = readFileSync(STAGING_EDGE_TEMPLATE_PATH, "utf8");
const RAW_INPUTS = JSON.parse(readFileSync(STAGING_EDGE_INPUTS_EXAMPLE_PATH, "utf8"));
const SOURCE = "c".repeat(40);

function tracked(file) {
  const errors = [];
  const value = parse(readFileSync(join(STAGING_EDGE_WORKER_DIRECTORY, file), "utf8"), errors);
  assert.deepEqual(errors, []);
  return value;
}
const TRACKED = [tracked("wrangler.jsonc"), tracked("wrangler.dogfood.jsonc")];

function template() {
  return parseStagingEdgeTemplate(TEMPLATE_TEXT);
}

function raw(change = (value) => value) {
  return change(structuredClone(RAW_INPUTS));
}

function refused(fn, code) {
  assert.throws(fn, (error) => error?.code === code, code);
}

/** The production isolation inputs: a production capture, its matching fence plan, no production gcp plan. */
function isolation({ production = FIXTURE, baseline, ...options } = {}) {
  return {
    productionInventory: stagingEdgeInventoryOf(production),
    ...(baseline === undefined ? {} : { productionBaselineInventory: stagingEdgeInventoryOf(baseline) }),
    productionPlan: null,
    productionFencePlan: stagingDryRunProductionFencePlan(baseline ?? production),
    ...options,
  };
}

function target(change, options = {}) {
  return assertStagingEdgeTarget({ inputs: raw(change), template: template(), trackedConfigs: TRACKED, ...isolation(options) });
}

function references(options = {}) {
  return resolveStagingEdgeIsolation({ inputs: raw(), trackedConfigs: TRACKED, ...isolation(options) }).references;
}

/** The production Worker after its gcp switch: the data D1s and buckets gone, the guard D1 and origin values bound. */
const PRODUCTION_GUARD = Object.freeze({ id: "7a000005-0000-4000-8000-0000000000aa", name: "tibotattle-release-guard" });
const PRODUCTION_PLAN = Object.freeze({
  upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app",
  originAudience: "synthetic-production-audience",
  invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
  releaseGuardDatabase: PRODUCTION_GUARD,
});
const DATA_BINDINGS = new Set(["USAGE_MONITOR_DB", "ANALYTICS_DB", "DELETION_LEDGER", "QUARANTINE"]);
const PRODUCTION_GCP = Object.freeze({ ...FIXTURE, versionId: "0e000000-0000-4000-8000-000000000999", bindings: [
  ...FIXTURE.bindings.filter((binding) => !DATA_BINDINGS.has(binding.name)),
  { name: "RELEASE_GUARD_DB", type: "d1", database_id: PRODUCTION_GUARD.id, database_name: PRODUCTION_GUARD.name },
  { name: "EDGE_UPSTREAM_MODE", type: "plain_text", text: "gcp" },
  { name: "EDGE_UPSTREAM_ORIGIN", type: "plain_text", text: PRODUCTION_PLAN.upstreamOrigin },
  { name: "EDGE_ORIGIN_AUDIENCE", type: "plain_text", text: PRODUCTION_PLAN.originAudience },
  { name: "EDGE_INVOKER_SERVICE_ACCOUNT", type: "plain_text", text: PRODUCTION_PLAN.invokerServiceAccount },
] });

/** Another Worker's capture in production's place: the old staging Worker, its own D1s, no domains. */
function otherWorker(snapshot = FIXTURE, workerName = "app-usagemonitor-staging") {
  let index = 0;
  return {
    ...snapshot,
    workerName,
    domains: [],
    namespaces: snapshot.namespaces.map((namespace) => ({ ...namespace, name: `${workerName}_${namespace.class}`, script: workerName })),
    bindings: snapshot.bindings.map((binding) => {
      if (binding.type !== "d1") return binding;
      index += 1;
      return { ...binding, database_id: `6b00000${index}-0000-4000-8000-00000000000${index}`, database_name: `other-${index}` };
    }),
  };
}

test("the template keeps env.staging's vars and changes only the plan's section 3.2", () => {
  const environment = template().edgeWorker.env.production;
  const staging = TRACKED[0].env.staging.vars;
  const added = ["ACCESS_ADMIN_EMAIL", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "SPARKLE_APPCAST_GUARD_MODE"];
  assert.deepEqual(
    Object.keys(environment.vars).sort(),
    [...Object.keys(staging).filter((name) => name !== "TELEMETRY_STORAGE_NAMESPACE"), ...added].sort(),
  );
  for (const [name, value] of Object.entries(staging)) {
    if (["PUBLIC_ORIGIN", "IDENTITY_LINK_SECRET_VERSION", "TELEMETRY_STORAGE_NAMESPACE"].includes(name)) continue;
    assert.equal(environment.vars[name], value, name);
  }
  assert.equal(environment.vars.IDENTITY_LINK_SECRET_VERSION, "staging-edge-v1");
  assert.equal(environment.vars.SPARKLE_APPCAST_GUARD_MODE, "disabled");
  assert.equal(environment.vars.TELEMETRY_STORAGE_MODE, "json");
  assert.equal(environment.vars.EDGE_UPSTREAM_MODE, undefined, "the overlay sets the mode, never the template");
  assert.deepEqual(environment.secrets.required, TRACKED[0].env.staging.secrets.required);
  assert.equal(environment.workers_dev, false);
  assert.equal(environment.preview_urls, false);
  assert.deepEqual(environment.assets, { ...TRACKED[0].env.production.assets });
  assert.ok(environment.d1_databases.every((entry) => entry.migrations_dir === undefined));
  assert.ok(!TEMPLATE_TEXT.includes("tibotattle.com"), "no hostname is committed");
});

test("both rate-limit profiles use their own namespaces; load raises only the ingress limits", () => {
  const { rehearsal, load } = template().rateLimitProfiles;
  const taken = new Set(TRACKED.flatMap((config) => [config, ...Object.values(config.env ?? {})])
    .flatMap((environment) => environment.ratelimits ?? []).map((entry) => String(entry.namespace_id)));
  for (const profile of [rehearsal, load]) {
    assert.deepEqual(profile.map((entry) => entry.namespace_id), ["4001", "4002", "4003", "4004", "4005", "4006", "4007", "4008", "4009", "4010", "4012"]);
    assert.ok(profile.every((entry) => !taken.has(entry.namespace_id)));
  }
  const production = new Map(TRACKED[0].env.production.ratelimits.map((entry) => [entry.name, entry.simple]));
  for (const entry of rehearsal) assert.deepEqual(entry.simple, production.get(entry.name), entry.name);
  for (const [index, entry] of load.entries()) {
    const ingress = entry.name.startsWith("UPLOAD_INGRESS_");
    assert.equal(entry.simple.limit, ingress ? 4 * rehearsal[index].simple.limit : rehearsal[index].simple.limit, entry.name);
  }
});

test("the example inputs render a complete staging target with no placeholder left", () => {
  const rendered = renderStagingEdgeTemplate({ template: template(), inputs: raw() });
  const text = JSON.stringify(rendered);
  assert.ok(!text.includes("{{"));
  const environment = rendered.edgeTracked.env.production;
  assert.equal(environment.name, "app-usagemonitor-staging-edge");
  assert.equal(environment.vars.PUBLIC_ORIGIN, `https://${RAW_INPUTS.publicHostname}`);
  assert.deepEqual(environment.routes.map((route) => route.pattern),
    [RAW_INPUTS.publicHostname, `admin.${RAW_INPUTS.publicHostname}`]);
  assert.equal(environment.ratelimits.length, 11);
  assert.ok(isAbsolute(rendered.standIn.main) && existsSync(rendered.standIn.main));
  assert.equal(rendered.standIn.d1_databases.length, 1);
  assert.deepEqual(rendered.standIn.triggers.crons, [RAW_INPUTS.standInCron]);
  // Wrangler configs for the Wrangler-ledger roles only; analytics is a storage-runner target.
  assert.deepEqual(rendered.migrationConfigs.map((entry) => entry.binding),
    ["USAGE_MONITOR_DB", "DELETION_LEDGER", "STORAGE_ANALYTICS_CATCHUP_CONTROL_DB", "RELEASE_GUARD_DB"]);
  assert.deepEqual(rendered.storageTargets, [{ role: "analytics", storageRole: "analytics", binding: "ANALYTICS_DB",
    databaseName: RAW_INPUTS.d1.analytics.name, ledger: "d1_storage_migrations" }]);
  assert.equal(JSON.stringify(rendered).includes("analytics-migrations"), false);
  for (const entry of rendered.migrationConfigs) {
    const [database] = entry.config.d1_databases;
    assert.ok(isAbsolute(database.migrations_dir) && existsSync(database.migrations_dir), entry.role);
    assert.ok(entry.config.name.includes("staging"));
  }
  const load = renderStagingEdgeTemplate({ template: template(), inputs: raw((value) => ({ ...value, rateLimitProfile: "load" })) });
  assert.equal(load.edgeTracked.env.production.ratelimits.find((entry) => entry.name === "UPLOAD_INGRESS_CLIENT_RATE_LIMIT")
    .simple.limit, 12000);
});

test("both staging profiles require each operational guard at its unchanged cap", () => {
  const operational = { PUBLIC_PROBE_RATE_LIMIT: 60, PUBLIC_PROBE_CLIENT_RATE_LIMIT: 12, SPARKLE_APPCAST_GUARD_RATE_LIMIT: 60 };
  for (const profileName of ["rehearsal", "load"]) {
    for (const [name, limit] of Object.entries(operational)) {
      assert.deepEqual(template().rateLimitProfiles[profileName].find((binding) => binding.name === name).simple,
        { limit, period: 60 });
      for (const mutate of [
        (profile) => profile.filter((binding) => binding.name !== name),
        (profile) => profile.map((binding) => binding.name === name ? { ...binding, name: "UNREVIEWED_RATE_LIMIT" } : binding),
        (profile) => profile.map((binding) => binding.name === name ? { ...binding, namespace_id: "4001" } : binding),
        (profile) => profile.map((binding) => binding.name === name ? { ...binding, simple: { limit: limit + 1, period: 60 } } : binding),
        (profile) => profile.map((binding) => binding.name === name ? { ...binding, simple: { limit, period: 10 } } : binding),
      ]) {
        const invalid = template();
        invalid.rateLimitProfiles[profileName] = mutate(invalid.rateLimitProfiles[profileName]);
        refused(() => parseStagingEdgeTemplate(JSON.stringify(invalid)), "STAGING_EDGE_TEMPLATE_INVALID");
      }
    }
  }
});

test("the genesis snapshot is exactly what the rendered config declares", () => {
  const inputs = parseStagingEdgeInputs(raw());
  const rendered = renderStagingEdgeTemplate({ template: template(), inputs });
  const genesis = createStagingGenesisSnapshot({ edgeTracked: rendered.edgeTracked, inputs });
  assert.equal(genesis.versionId, STAGING_EDGE_GENESIS_VERSION_ID);
  assert.equal(genesis.sourceCommit, null);
  assert.equal(genesis.bindings.some((binding) => binding.name === "EDGE_UPSTREAM_MODE"), false);
  assert.deepEqual(genesis.domains.map((domain) => domain.hostname), [inputs.adminHostname, inputs.publicHostname]);
  const config = renderProductionLiveConfig({ trackedConfig: rendered.edgeTracked, snapshot: genesis, sourceCommit: SOURCE });
  assert.equal(verifyProductionLiveConfig({ snapshot: genesis, candidateConfig: config, sourceCommit: SOURCE }).ok, true);
  assert.deepEqual(stagingEdgeInventoryOf(genesis).workerName, inputs.edgeWorkerName);
});

test("the inputs schema is closed and requires staging names", () => {
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, extra: 1 }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, adminHostname: "admin.x" }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => { delete value.origin; return value; })), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, accountId: "A".repeat(32) }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, edgeWorkerName: "app-usagemonitor" }))),
    "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "tibotattle.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "www.tibotattle.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, publicHostname: "staging.com" }))),
    "STAGING_EDGE_HOSTNAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => {
    value.d1.releaseGuard.name = "tibotattle-release-guard";
    return value;
  })), "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, r2: { ...value.r2, sparkleReleases: "tibotattle-updates" } }))),
    "STAGING_EDGE_NAME_NOT_STAGING");
  refused(() => parseStagingEdgeInputs(raw((value) => {
    value.d1.analytics.id = value.d1.ingestion.id;
    return value;
  })), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, quietWindowMinutes: 14 }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, rateLimitProfile: "production" }))), "STAGING_EDGE_INPUTS_INVALID");
  refused(() => parseStagingEdgeInputs(raw((value) => ({ ...value, access: { ...value.access, teamDomain: "evil.example" } }))),
    "STAGING_EDGE_INPUTS_INVALID");
});

test("every production Worker name is refused", () => {
  refused(() => target((value) => ({ ...value, edgeWorkerName: "app-usagemonitor-staging" })), "STAGING_EDGE_PRODUCTION_WORKER");
  refused(() => target((value) => ({ ...value, standInWorkerName: "app-usagemonitor-staging" })), "STAGING_EDGE_PRODUCTION_WORKER");
  const refusedNames = references().workerNames;
  for (const name of ["app-usagemonitor", "app-usagemonitor-staging", "app-usagemonitor-synthetic",
    "tibotattle-dogfood-release-guard", "tibotattle-analytics-catchup-synthetic"]) {
    assert.ok(refusedNames.has(name), name);
  }
  // Every script the production fence plan names is refused, here an out-of-scope one with a staging-like name.
  const fence = stagingDryRunProductionFencePlan(FIXTURE);
  fence.outOfScopeScripts = [{ name: RAW_INPUTS.standInWorkerName, reason: "synthetic production consumer" }];
  refused(() => target(undefined, { productionFencePlan: fence }), "STAGING_EDGE_PRODUCTION_WORKER");
});

test("every production hostname is refused", () => {
  const hostnames = references().hostnames;
  for (const host of ["tibotattle.com", "www.tibotattle.com", "admin.tibotattle.com", "updates.tibotattle.com",
    "dogfood-release.tibotattle.com"]) {
    assert.ok(hostnames.has(host), host);
  }
  const zoned = { ...FIXTURE, domains: [...FIXTURE.domains, { hostname: RAW_INPUTS.publicHostname }] };
  refused(() => target(undefined, { production: zoned }), "STAGING_EDGE_PRODUCTION_HOSTNAME");
  const admin = { ...FIXTURE, routes: [{ pattern: `admin.${RAW_INPUTS.publicHostname}/*` }] };
  refused(() => target(undefined, { production: admin }), "STAGING_EDGE_PRODUCTION_HOSTNAME");
});

test("every production D1 id or name is refused", () => {
  const withD1 = (role, entry) => (value) => {
    value.d1[role] = { ...value.d1[role], ...entry };
    return value;
  };
  const productionPrimary = TRACKED[0].env.production.d1_databases[0].database_id;
  const stagingPrimary = TRACKED[0].env.staging.d1_databases[0];
  const dogfood = TRACKED[1].d1_databases[0].database_id;
  const fixturePrimary = FIXTURE.bindings.find((binding) => binding.name === "USAGE_MONITOR_DB").database_id;
  for (const [role, entry] of [
    ["ingestion", { id: productionPrimary }],
    ["analytics", { id: fixturePrimary }],
    ["deletionLedger", { id: stagingPrimary.database_id }],
    ["catchupControl", { name: stagingPrimary.database_name }],
    ["releaseGuard", { id: dogfood }],
  ]) {
    refused(() => target(withD1(role, entry)), "STAGING_EDGE_PRODUCTION_DATABASE");
  }
  const productionPlan = { ...PRODUCTION_PLAN, releaseGuardDatabase: { id: RAW_INPUTS.d1.releaseGuard.id, name: "tibotattle-release-guard" } };
  refused(() => target(undefined, { productionPlan }), "STAGING_EDGE_PRODUCTION_DATABASE");
  refused(() => target(undefined, { productionPlan: { invalid: true } }), "EDGE_MODE_STAGING_INPUT_INVALID");
  // The catch-up control D1 only another production Worker binds, from the production fence plan.
  refused(() => target(withD1("catchupControl", { id: STAGING_DRY_RUN_PRODUCTION_CATCHUP_ID })), "STAGING_EDGE_PRODUCTION_DATABASE");
  assert.ok(references().databaseIds.has(STAGING_DRY_RUN_PRODUCTION_CATCHUP_ID));
});

test("every production bucket and rate-limit namespace is refused", () => {
  refused(() => target((value) => ({ ...value, r2: { ...value.r2, quarantine: "app-usagemonitor-staging-quarantine" } })),
    "STAGING_EDGE_PRODUCTION_BUCKET");
  const bucket = { ...FIXTURE, bindings: [...FIXTURE.bindings.filter((binding) => binding.name !== "QUARANTINE"),
    { name: "QUARANTINE", type: "r2_bucket", bucket_name: RAW_INPUTS.r2.quarantine }] };
  refused(() => target(undefined, { production: bucket }), "STAGING_EDGE_PRODUCTION_BUCKET");
  const clashing = template();
  clashing.rateLimitProfiles.rehearsal[0] = { ...clashing.rateLimitProfiles.rehearsal[0], namespace_id: "3001" };
  refused(() => assertStagingEdgeTarget({ inputs: raw(), template: clashing, trackedConfigs: TRACKED, ...isolation() }),
    "STAGING_EDGE_PRODUCTION_RATE_LIMIT");
});

test("the production inventory must be the production Worker's own, in the shared account", () => {
  const analytics = FIXTURE.bindings.find((binding) => binding.name === "ANALYTICS_DB").database_id;
  const leaking = (value) => {
    value.d1.analytics.id = analytics;
    return value;
  };
  refused(() => target(leaking), "STAGING_EDGE_PRODUCTION_DATABASE");
  // Another Worker's capture in production's place would drop the production ANALYTICS_DB from the refused set.
  for (const production of [otherWorker(), otherWorker(FIXTURE, RAW_INPUTS.edgeWorkerName)]) {
    refused(() => target(leaking, { production, productionFencePlan: stagingDryRunProductionFencePlan(FIXTURE) }),
      "STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION");
    refused(() => target(leaking, { production: PRODUCTION_GCP, productionPlan: PRODUCTION_PLAN, baseline: production,
      productionFencePlan: stagingDryRunProductionFencePlan(FIXTURE) }), "STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION");
  }
  const otherAccount = { ...FIXTURE, accountId: "0b".repeat(16) };
  refused(() => target(undefined, { production: otherAccount }), "STAGING_EDGE_PRODUCTION_ACCOUNT_MISMATCH");
  refused(() => target(undefined, { production: PRODUCTION_GCP, productionPlan: PRODUCTION_PLAN, baseline: otherAccount }),
    "STAGING_EDGE_PRODUCTION_ACCOUNT_MISMATCH");
  refused(() => target(undefined, { productionInventory: undefined }), "STAGING_EDGE_PRODUCTION_INPUT_INVALID");
  refused(() => target(undefined, { productionPlan: undefined }), "STAGING_EDGE_PRODUCTION_INPUT_INVALID");
});

test("after the production gcp switch the pre-gcp baseline keeps every data D1 refused", () => {
  const analytics = FIXTURE.bindings.find((binding) => binding.name === "ANALYTICS_DB").database_id;
  const leaking = (value) => {
    value.d1.analytics.id = analytics;
    return value;
  };
  // EP-9's rules: the live gcp capture alone no longer binds the data D1s, and it binds gcp values, so the plan is required.
  refused(() => target(leaking, { production: PRODUCTION_GCP, productionPlan: PRODUCTION_PLAN }), "EDGE_MODE_STAGING_INPUT_INVALID");
  refused(() => target(leaking, { production: PRODUCTION_GCP, baseline: FIXTURE }), "EDGE_MODE_STAGING_INPUT_INVALID");
  const afterSwitch = { production: PRODUCTION_GCP, productionPlan: PRODUCTION_PLAN, baseline: FIXTURE };
  assert.equal(target(undefined, afterSwitch).target.edgeWorkerName, RAW_INPUTS.edgeWorkerName);
  refused(() => target(leaking, afterSwitch), "STAGING_EDGE_PRODUCTION_DATABASE");
  refused(() => target((value) => {
    value.d1.releaseGuard.id = PRODUCTION_GUARD.id;
    return value;
  }, afterSwitch), "STAGING_EDGE_PRODUCTION_DATABASE");
  for (const key of ["upstreamOrigin", "originAudience", "invokerServiceAccount"]) {
    refused(() => target((value) => ({ ...value, origin: { ...value.origin, [key]: PRODUCTION_PLAN[key] } }), afterSwitch),
      "STAGING_EDGE_PRODUCTION_ORIGIN");
  }
});

test("the production fence plan is validated by EP-8 and bound to the production capture", () => {
  const fence = () => stagingDryRunProductionFencePlan(FIXTURE);
  refused(() => target(undefined, { productionFencePlan: undefined }), "STAGING_EDGE_PRODUCTION_FENCE_PLAN_INVALID");
  refused(() => target(undefined, { productionFencePlan: { ...fence(), extra: true } }), "STAGING_EDGE_PRODUCTION_FENCE_PLAN_INVALID");
  // The staging fence plan in production's place, another account, or ids production does not bind.
  refused(() => target(undefined, { productionFencePlan: buildStagingFencePlan(raw()).plan }), "STAGING_EDGE_PRODUCTION_FENCE_PLAN_MISMATCH");
  refused(() => target(undefined, { productionFencePlan: { ...fence(), accountId: "0b".repeat(16) } }),
    "STAGING_EDGE_PRODUCTION_FENCE_PLAN_MISMATCH");
  for (const [index, change] of [
    [0, { id: "6b000001-0000-4000-8000-000000000001" }],
    [1, { id: "6b000002-0000-4000-8000-000000000002" }],
    [4, { bucket: "synthetic-other-quarantine" }],
  ]) {
    const plan = fence();
    plan.dataResources[index] = { ...plan.dataResources[index], ...change };
    refused(() => target(undefined, { productionFencePlan: plan }), "STAGING_EDGE_PRODUCTION_FENCE_PLAN_MISMATCH");
  }
  // After the switch the baseline is what proves the plan's labels.
  assert.ok(target(undefined, { production: PRODUCTION_GCP, productionPlan: PRODUCTION_PLAN, baseline: FIXTURE }));
});

test("render runs the same isolation as deploy, then EP-9 on the rendered edge config", () => {
  const resolved = target();
  const rendered = renderStagingEdgeTarget({ template: template(), isolation: resolved, trackedConfigs: TRACKED });
  assert.equal(rendered.edgeTracked.env.production.name, RAW_INPUTS.edgeWorkerName);
  // A template whose edge config names a production host passes the target checks but not EP-9's.
  const hosted = template();
  hosted.edgeWorker.env.production.vars.PUBLIC_ORIGIN = "https://tibotattle.com";
  refused(() => renderStagingEdgeTarget({ template: hosted, isolation: resolved, trackedConfigs: TRACKED }),
    "EDGE_MODE_STAGING_PRODUCTION_REFERENCE");
});

test("an operation's target.json must name the staging Worker and staging domains only", () => {
  const good = { accountId: RAW_INPUTS.accountId, edgeWorkerName: RAW_INPUTS.edgeWorkerName,
    expectedDomains: [`admin.${RAW_INPUTS.publicHostname}`, RAW_INPUTS.publicHostname] };
  assert.deepEqual(assertStagingOperationTarget({ target: good, trackedConfigs: TRACKED }), good);
  for (const [change, code] of [
    [{ edgeWorkerName: "app-usagemonitor" }, "STAGING_EDGE_NAME_NOT_STAGING"],
    [{ edgeWorkerName: "app-usagemonitor-staging" }, "STAGING_EDGE_PRODUCTION_WORKER"],
    [{ expectedDomains: ["tibotattle.com"] }, "STAGING_EDGE_HOSTNAME_NOT_STAGING"],
    [{ accountId: "x" }, "STAGING_EDGE_OPERATION_TARGET_INVALID"],
    [{ extra: true }, "STAGING_EDGE_OPERATION_TARGET_INVALID"],
  ]) {
    refused(() => assertStagingOperationTarget({ target: { ...good, ...change }, trackedConfigs: TRACKED }), code);
  }
});

test("the EP-8 fence plan is the staging Worker, its stand-in and the staging resources", () => {
  const { plan, planSha256 } = buildStagingFencePlan(raw());
  const validated = validateCloudflareWriterFencePlan(plan);
  assert.equal(validated.planSha256, planSha256);
  assert.equal(plan.productionWorker, RAW_INPUTS.edgeWorkerName);
  assert.deepEqual(plan.fencedScripts, [{ name: RAW_INPUTS.standInWorkerName, kind: "cron", expectedCrons: [RAW_INPUTS.standInCron] }]);
  assert.deepEqual(validated.d1, {
    ingestion: RAW_INPUTS.d1.ingestion.id,
    analytics: RAW_INPUTS.d1.analytics.id,
    "deletion-ledger": RAW_INPUTS.d1.deletionLedger.id,
    "catchup-control": RAW_INPUTS.d1.catchupControl.id,
  });
  assert.deepEqual(validated.r2, { bucket: RAW_INPUTS.r2.quarantine });
  assert.equal(plan.dataResources.some((entry) => entry.id === RAW_INPUTS.d1.releaseGuard.id), false);
});

test("the gcp plan is EP-9's closed plan, and null until the staging origin exists", () => {
  const gcp = buildStagingGcpPlan(raw());
  assert.deepEqual(Object.keys(gcp.plan).sort(),
    ["invokerServiceAccount", "originAudience", "releaseGuardDatabase", "upstreamOrigin"]);
  assert.deepEqual(gcp.plan.releaseGuardDatabase, RAW_INPUTS.d1.releaseGuard);
  assert.equal(gcp.overlaySha256, edgeModeOverlaySha256({ mode: "gcp", plan: gcp.plan }));
  assert.equal(buildStagingGcpPlan(raw((value) => ({ ...value, origin: null }))), null);
  refused(() => buildStagingGcpPlan(raw((value) => ({ ...value, origin: { ...value.origin, upstreamOrigin: "https://example.com" } }))),
    "STAGING_EDGE_GCP_PLAN_INVALID");
  const timed = buildStagingGcpPlan(raw((value) => ({ ...value, origin: { ...value.origin, upstreamHeadersTimeoutSeconds: 30 } })));
  assert.equal(timed.plan.upstreamHeadersTimeoutSeconds, 30);
});

test("the stand-in writes one heartbeat per run and reads nothing else", async () => {
  const calls = [];
  const database = {
    prepare(sql) {
      calls.push({ sql });
      return { bind: (...values) => ({ run: async () => { calls.push({ values }); return { success: true }; } }) };
    },
  };
  const env = new Proxy({ STORAGE_ANALYTICS_CATCHUP_CONTROL_DB: database }, {
    get(targetObject, name) {
      if (name !== "STORAGE_ANALYTICS_CATCHUP_CONTROL_DB") throw new Error(`unexpected binding ${String(name)}`);
      return targetObject[name];
    },
  });
  await standIn.scheduled({ scheduledTime: 1_700_000_000_000, cron: "*/5 * * * *" }, env);
  assert.deepEqual(calls, [
    { sql: "INSERT INTO staging_edge_heartbeat (scheduled_at_ms, cron) VALUES (?1, ?2)" },
    { values: [1_700_000_000_000, "*/5 * * * *"] },
  ]);
  assert.deepEqual(Object.keys(standIn), ["scheduled"]);
  const migration = readFileSync(join(STAGING_EDGE_WORKER_DIRECTORY, "ops", "staging-edge", "catchup-standin", "migrations",
    "0001_staging_edge_heartbeat.sql"), "utf8");
  assert.match(migration, /CREATE TABLE staging_edge_heartbeat/u);
  assert.equal((migration.match(/CREATE /gu) ?? []).length, 1);
});
