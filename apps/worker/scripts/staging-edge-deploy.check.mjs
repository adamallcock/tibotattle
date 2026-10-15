import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edgeModeForbiddenPathClass } from "./check-deployment-endpoints.mjs";
import { EDGE_MODE_TRANSITIONS } from "./edge-mode-configuration.mjs";
import { recheckProductionEdgeHealth } from "./production-deploy.mjs";
import {
  PRODUCTION_EDGE_MODE_OVERLAY,
  createEdgeModeConfigTools,
  prepareEdgeModeDeployment,
} from "./production-edge-mode.mjs";
import {
  createProductionLiveConfigSnapshot,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";
import {
  STAGING_DRY_RUN_FIXTURE,
  STAGING_DRY_RUN_ORIGIN_COMMIT,
  STAGING_DRY_RUN_READERS,
  STAGING_DRY_RUN_SOURCE,
  stagingDryRunAdvance,
  stagingDryRunInputs,
  stagingDryRunLedgerSpawn,
  stagingDryRunLedgers,
  stagingDryRunProductionFencePlan,
  stagingDryRunWithGcpSecrets,
  writeStagingDryRunSite,
} from "./staging-edge-dry-run.mjs";
import {
  CLOUDFLARE_WORKER_NOT_FOUND,
  STAGING_EDGE_CANDIDATE_FILE,
  STAGING_EDGE_DEPLOY_CONFIRMATION,
  assertPrivateSecretsFile,
  createStagingOutputDirectory,
  parseStagingEdgeArguments,
  prepareStagingEdgeDeployment,
  probeStagingWorkerExistence,
  reconcileStagingEdgeDeployment,
  rehearsalStepAgreesWithMatrix,
  runStagingEdgeDeployment,
  serializeStagingEdgeCandidate,
  stagingEdgeEndpointMatrix,
  stagingEdgeRehearsalSequence,
  stagingWranglerEnvironment,
  verifyStagingEdgeEndpoints,
} from "./staging-edge-deploy.mjs";
import {
  STAGING_EDGE_WORKER_DIRECTORY,
  readStagingEdgeTemplate,
  readStagingEdgeTrackedConfigs,
  stagingEdgeInventoryOf,
} from "./staging-edge-target.mjs";

// Synthetic inputs, fake providers and a fake Wrangler only. The synthetic
// token below must never appear in any file, result or code this suite sees.
const SYNTHETIC_API_TOKEN = "synthetic-cloudflare-token-0123456789";
const SECRETS_SENTINEL = "SYNTHETIC_SECRET_VALUE_NEVER_READ";
const PRODUCTION_SNAPSHOT = JSON.parse(readFileSync(STAGING_DRY_RUN_FIXTURE, "utf8"));
const PRODUCTION_INVENTORY = stagingEdgeInventoryOf(PRODUCTION_SNAPSHOT);
const PRODUCTION_FENCE_PLAN = stagingDryRunProductionFencePlan(PRODUCTION_SNAPSHOT);
const DRIVER = new URL("./staging-edge-deploy.mjs", import.meta.url).pathname;
const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

async function tempDirectory(prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

let shared;
async function context() {
  if (shared) return shared;
  const directory = await tempDirectory("staging-edge-deploy-check-");
  shared = {
    directory,
    inputs: await stagingDryRunInputs(),
    template: await readStagingEdgeTemplate(),
    trackedConfigs: await readStagingEdgeTrackedConfigs(),
    unmarked: await writeStagingDryRunSite(join(directory, "site-unmarked"), false),
    marked: await writeStagingDryRunSite(join(directory, "site-marked"), true),
  };
  return shared;
}

async function base(overrides = {}) {
  const ctx = await context();
  return {
    inputs: ctx.inputs["<inputs.json>"],
    template: ctx.template,
    trackedConfigs: ctx.trackedConfigs,
    productionInventory: PRODUCTION_INVENTORY,
    productionPlan: null,
    productionFencePlan: PRODUCTION_FENCE_PLAN,
    siteDirectory: ctx.unmarked,
    sourceCommit: STAGING_DRY_RUN_SOURCE,
    readBlob: STAGING_DRY_RUN_READERS.readBlob,
    isAncestor: STAGING_DRY_RUN_READERS.isAncestor,
    verifyOrigin: STAGING_DRY_RUN_READERS.verifyOrigin,
    ...overrides,
  };
}

let versions = 100;
/** Prepare a step and return the simulated next live snapshot. */
async function deployTo(live, mode, overrides = {}) {
  const prepared = await prepareStagingEdgeDeployment(await base({
    mode,
    ...(live === null
      ? { genesis: true }
      : { stagingInventory: stagingEdgeInventoryOf(live), expectedPreviousSourceCommit: live.sourceCommit }),
    ...overrides,
  }));
  assert.equal(prepared.ok, true, prepared.code);
  return { prepared, live: stagingDryRunAdvance(prepared.expected, ++versions) };
}

async function states() {
  const worker = (await deployTo(null, "worker")).live;
  const fenced = (await deployTo(worker, "fenced")).live;
  const secrets = stagingDryRunWithGcpSecrets(fenced, ++versions);
  const ctx = await context();
  const gcp = (await deployTo(secrets, "gcp", {
    siteDirectory: ctx.marked,
    candidatePublicManifestSha256: "a".repeat(64),
    originCommit: STAGING_DRY_RUN_ORIGIN_COMMIT,
    obtainOriginIdentityToken: STAGING_DRY_RUN_READERS.obtainOriginIdentityToken,
  })).live;
  return { worker, fenced, gcp };
}

async function outputDirectory() {
  const directory = join(await tempDirectory("staging-edge-out-"), "operation");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function fakeProvider(captures) {
  const calls = { capture: 0, identity: null };
  return {
    calls,
    create: (identity) => {
      calls.identity = { accountId: identity.accountId, workerName: identity.workerName };
      return {
        async capture() {
          const next = captures[calls.capture++];
          if (next instanceof Error) throw next;
          if (next === undefined) throw new Error("unexpected capture");
          return structuredClone(next);
        },
      };
    },
  };
}

function fakeSpawn(status = 0) {
  const calls = [];
  return { calls, spawn: (command, args, options) => { calls.push({ command, args, options }); return { status, stdout: "", stderr: "" }; } };
}

const ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/home/synthetic", CLOUDFLARE_API_TOKEN: SYNTHETIC_API_TOKEN });

/** The old staging Worker's inventory, with its own D1 ids and no domains, in production's place. */
function otherWorkerInventory() {
  const other = structuredClone(PRODUCTION_INVENTORY);
  other.workerName = "app-usagemonitor-staging";
  for (const namespace of other.namespaces) {
    namespace.script = other.workerName;
    namespace.name = `${other.workerName}_${namespace.class}`;
  }
  other.domains = [];
  for (const list of [other.version.resources.bindings, other.settings.bindings]) {
    for (const [index, binding] of list.filter((entry) => entry.type === "d1").entries()) {
      binding.id = `6b00000${index + 1}-0000-4000-8000-00000000000${index + 1}`;
      binding.database_id = binding.id;
      binding.database_name = `other-${binding.name.toLowerCase()}`;
    }
  }
  return other;
}

/** A fake Cloudflare API answering the deployments read only. */
function fakeApi(respond) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return respond(url, init);
    },
  };
}

const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else out.push(path);
  }
  return out;
}

async function assertPrivateAndTokenFree(directory, result) {
  for (const path of await filesUnder(directory)) {
    const info = await lstat(path);
    assert.equal(info.mode & 0o777, 0o600, path);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(SYNTHETIC_API_TOKEN), path);
    assert.ok(!text.includes(SECRETS_SENTINEL), path);
  }
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_API_TOKEN));
  assert.ok(!JSON.stringify(result).includes(SECRETS_SENTINEL));
}

test("E10 takes the staging overlay and keeps production as its default", async () => {
  const tracked = (await context()).trackedConfigs[0];
  const typed = { createSnapshot: createProductionLiveConfigSnapshot, render: renderProductionLiveConfig, verify: verifyProductionLiveConfig };
  assert.equal(PRODUCTION_EDGE_MODE_OVERLAY.target, "production");
  assert.throws(() => createEdgeModeConfigTools({ mode: "worker", trackedConfig: tracked, base: typed, overlay: {} }),
    (error) => error.code === "EDGE_MODE_INPUT_INVALID");
  const prepared = await prepareEdgeModeDeployment({
    edgeMode: "worker", inventory: PRODUCTION_INVENTORY, baseConfigTools: typed, workerDirectory: STAGING_EDGE_WORKER_DIRECTORY,
    sourceCommit: STAGING_DRY_RUN_SOURCE, overlay: { config: null },
  });
  assert.deepEqual(prepared, { ok: false, code: "EDGE_MODE_INPUT_INVALID" });
});

test("the staging deploy refuses production inputs and a production inventory", async () => {
  const { worker } = await states();
  const ctx = await context();
  const prepare = async (overrides) => prepareStagingEdgeDeployment(await base({
    mode: "worker", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit, ...overrides,
  }));
  assert.equal((await prepare({})).ok, true);
  // The production Worker's own inventory is never a staging baseline.
  assert.deepEqual(await prepare({ stagingInventory: PRODUCTION_INVENTORY }),
    { ok: false, code: "STAGING_EDGE_INVENTORY_TARGET_MISMATCH" });
  assert.deepEqual(await prepare({ productionPlan: undefined }), { ok: false, code: "STAGING_EDGE_PRODUCTION_INPUT_INVALID" });
  assert.deepEqual(await prepare({ productionInventory: { workerName: "app-usagemonitor" } }),
    { ok: false, code: "STAGING_EDGE_PRODUCTION_INPUT_INVALID" });
  assert.deepEqual(await prepare({ productionFencePlan: undefined }), { ok: false, code: "STAGING_EDGE_PRODUCTION_FENCE_PLAN_INVALID" });
  // Another Worker's inventory as the production inventory (the reviewer's case: the old staging
  // Worker's, its own D1s, no domains) no longer drops production's ANALYTICS_DB from the refused set.
  const analytics = PRODUCTION_INVENTORY.version.resources.bindings.find((binding) => binding.name === "ANALYTICS_DB");
  const leakingInputs = structuredClone(JSON.parse(readFileSync(new URL("../ops/staging-edge/staging-edge-inputs.example.json", import.meta.url), "utf8")));
  leakingInputs.d1.analytics.id = analytics.database_id;
  const other = otherWorkerInventory();
  for (const genesis of [true, false]) {
    const live = genesis ? { genesis: true, stagingInventory: undefined, expectedPreviousSourceCommit: null } : {};
    assert.deepEqual(await prepare({ ...live, inputs: leakingInputs }), { ok: false, code: "STAGING_EDGE_PRODUCTION_DATABASE" });
    assert.deepEqual(await prepare({ ...live, inputs: leakingInputs, productionInventory: other }),
      { ok: false, code: "STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION" });
  }
  assert.deepEqual(await prepare({ productionInventory: { ...structuredClone(PRODUCTION_INVENTORY), accountId: "0b".repeat(16) } }),
    { ok: false, code: "STAGING_EDGE_PRODUCTION_ACCOUNT_MISMATCH" });
  // A live staging version that binds a production D1 is refused by EP-9's isolation guard.
  const primary = PRODUCTION_INVENTORY.version.resources.bindings.find((binding) => binding.name === "USAGE_MONITOR_DB");
  const leaking = structuredClone(stagingEdgeInventoryOf(worker));
  for (const list of [leaking.version.resources.bindings, leaking.settings.bindings]) {
    const binding = list.find((entry) => entry.name === "USAGE_MONITOR_DB");
    binding.id = primary.id;
    binding.database_id = primary.database_id;
  }
  assert.deepEqual(await prepare({ stagingInventory: leaking }), { ok: false, code: "EDGE_MODE_STAGING_PRODUCTION_REFERENCE" });
  const renamedInputs = { ...structuredClone(JSON.parse(readFileSync(new URL("../ops/staging-edge/staging-edge-inputs.example.json", import.meta.url), "utf8"))),
    edgeWorkerName: "app-usagemonitor-staging" };
  assert.deepEqual(await prepare({ inputs: renamedInputs }), { ok: false, code: "STAGING_EDGE_PRODUCTION_WORKER" });
  assert.equal(ctx.inputs["<inputs.json>"].edgeWorkerName, "app-usagemonitor-staging-edge");
});

test("genesis is worker only, takes no live inputs, and names the edge entry", async () => {
  const genesis = await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true }));
  assert.equal(genesis.ok, true);
  assert.equal(genesis.liveMode, null);
  assert.equal(genesis.candidateConfig.env.production.main, "src/edge-entry.ts");
  assert.equal(genesis.candidateConfig.env.production.vars.EDGE_UPSTREAM_MODE, "worker");
  assert.equal(genesis.candidateConfig.env.production.vars.DEPLOYMENT_SOURCE_COMMIT, STAGING_DRY_RUN_SOURCE);
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "fenced", genesis: true })),
    { ok: false, code: "STAGING_EDGE_GENESIS_MODE_INVALID" });
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true, expectedPreviousSourceCommit: "a".repeat(40) })),
    { ok: false, code: "STAGING_EDGE_GENESIS_INPUT_INVALID" });
  assert.deepEqual(await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true, readBlob: () => null })),
    { ok: false, code: "EDGE_MODE_ENTRY_UNAVAILABLE" });
});

test("the candidate is written with absolute entry and assets, and the dry run never deploys", async () => {
  const ctx = await context();
  const directory = await outputDirectory();
  const provider = fakeProvider([]);
  const wrangler = fakeSpawn();
  const result = await runStagingEdgeDeployment({
    ...(await base({ mode: "worker", genesis: true })),
    outputDirectory: directory,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: false }),
    spawn: wrangler.spawn,
    createProvider: provider.create,
    environment: ENVIRONMENT,
  });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.sourceTreeClean, false);
  assert.equal(result.plan.typedSchemaInspection, "not_applicable_staging_json_topology");
  assert.equal(wrangler.calls.length, 0);
  assert.equal(provider.calls.capture, 0);
  const candidate = JSON.parse(await readFile(join(directory, STAGING_EDGE_CANDIDATE_FILE), "utf8"));
  assert.equal(candidate.env.production.main, join(STAGING_EDGE_WORKER_DIRECTORY, "src", "edge-entry.ts"));
  assert.equal(candidate.env.production.assets.directory, ctx.unmarked);
  assert.deepEqual((await readdir(directory)).sort(),
    ["baseline-snapshot.json", "candidate.wrangler.json", "expected-snapshot.json", "plan.json", "target.json"]);
  await assertPrivateAndTokenFree(directory, result);
  const bytes = serializeStagingEdgeCandidate({ candidateConfig: (await prepareStagingEdgeDeployment(await base({ mode: "worker", genesis: true }))).candidateConfig,
    siteDirectory: ctx.unmarked });
  assert.equal(result.plan.candidateConfigSha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
});

test("execute needs the confirmation, a clean source and the dry run's candidate", async () => {
  const run = async (overrides) => runStagingEdgeDeployment({
    ...(await base({ mode: "worker", genesis: true })),
    outputDirectory: await outputDirectory(),
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
    spawn: fakeSpawn().spawn,
    createProvider: fakeProvider([]).create,
    environment: ENVIRONMENT,
    ...overrides,
  });
  assert.equal((await run({ execute: true })).code, "STAGING_EDGE_CONFIRMATION_REQUIRED");
  assert.equal((await run({ confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION })).code, "STAGING_EDGE_CONFIRMATION_REQUIRED");
  assert.equal((await run({ execute: true, confirmation: "DEPLOY_PRODUCTION", expectedCandidateSha256: "a".repeat(64) })).code,
    "STAGING_EDGE_CONFIRMATION_REQUIRED");
  const confirmed = { execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION, expectedCandidateSha256: "a".repeat(64) };
  assert.equal((await run({ ...confirmed, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: false }) })).code,
    "STAGING_EDGE_SOURCE_DIRTY");
  assert.equal((await run(confirmed)).code, "STAGING_EDGE_SECRETS_FILE_INVALID");
  const secrets = join(await tempDirectory("staging-edge-secrets-"), "secrets.env");
  await writeFile(secrets, `${SECRETS_SENTINEL}\n`, { mode: 0o644 });
  assert.equal((await run({ ...confirmed, secretsFile: secrets })).code, "STAGING_EDGE_SECRETS_FILE_INVALID");
  await chmod(secrets, 0o600);
  assert.equal(await assertPrivateSecretsFile(secrets), secrets);
  assert.equal((await run({ ...confirmed, secretsFile: secrets })).code, "STAGING_EDGE_CANDIDATE_CHANGED");
});

test("an executed genesis deploys the reviewed candidate with the secrets file by path and verifies it", async () => {
  const directory = await outputDirectory();
  const options = { ...(await base({ mode: "worker", genesis: true })), outputDirectory: directory };
  const dry = await runStagingEdgeDeployment({ ...options, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }) });
  const secrets = join(await tempDirectory("staging-edge-secrets-"), "secrets.env");
  await writeFile(secrets, `${SECRETS_SENTINEL}\n`, { mode: 0o600 });
  const live = stagingDryRunAdvance(JSON.parse(await readFile(join(directory, "expected-snapshot.json"), "utf8")), ++versions);
  const execute = async (overrides) => runStagingEdgeDeployment({
    ...options, outputDirectory: await outputDirectory(), execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION,
    expectedCandidateSha256: dry.plan.candidateConfigSha256, secretsFile: secrets,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }), environment: ENVIRONMENT,
    checkWorkspacePackages: async () => {}, ...overrides,
  });
  // Only a positive not-found lets genesis run. A Worker that exists, or one whose existence
  // could not be read (refused, rate-limited, unreachable), never reaches Wrangler.
  for (const [probe, code] of [
    [async () => "present", "STAGING_EDGE_GENESIS_WORKER_EXISTS"],
    [async () => { throw Object.assign(new Error("x"), { code: "STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN" }); },
      "STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN"],
    [async () => { throw new Error("not found"); }, "STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN"],
    [async () => undefined, "STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN"],
  ]) {
    const refusedSpawn = fakeSpawn();
    const provider = fakeProvider([]);
    const refusedRun = await execute({ probeExistence: probe, spawn: refusedSpawn.spawn, createProvider: provider.create });
    assert.equal(refusedRun.code, code);
    assert.equal(refusedSpawn.calls.length, 0, code);
    assert.equal(provider.calls.capture, 0, code);
  }

  const provider = fakeProvider([stagingEdgeInventoryOf(live)]);
  const wrangler = fakeSpawn();
  const third = await outputDirectory();
  const probed = [];
  const result = await runStagingEdgeDeployment({
    ...options, outputDirectory: third, execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION,
    expectedCandidateSha256: dry.plan.candidateConfigSha256, secretsFile: secrets,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }), spawn: wrangler.spawn,
    createProvider: provider.create, environment: ENVIRONMENT, checkWorkspacePackages: async () => {},
    probeExistence: async (identity) => { probed.push({ accountId: identity.accountId, workerName: identity.workerName }); return "absent"; },
  });
  assert.deepEqual(probed, [{ accountId: options.inputs.accountId, workerName: "app-usagemonitor-staging-edge" }]);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.outcome, "verified");
  assert.deepEqual(provider.calls.identity, { accountId: options.inputs.accountId, workerName: "app-usagemonitor-staging-edge" });
  assert.equal(wrangler.calls.length, 1);
  const [call] = wrangler.calls;
  assert.deepEqual(call.args, ["deploy", "--config", join(third, STAGING_EDGE_CANDIDATE_FILE), "--env", "production", "--strict",
    "--secrets-file", secrets]);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["CI", "CLOUDFLARE_API_TOKEN", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
  assert.equal(call.options.cwd, STAGING_EDGE_WORKER_DIRECTORY);
  const operation = JSON.parse(await readFile(join(third, "operation.json"), "utf8"));
  assert.equal(operation.outcome, "verified");
  assert.ok((await readdir(third)).includes("post-deploy-inventory.json"));
  await assertPrivateAndTokenFree(third, result);
});

// Cloudflare's settings API expands a declared { enabled: true, head_sampling_rate: 1 }
// (the 2026-10-03 staging-edge genesis capture). Only the pinned defaults compare equal.
const CAPTURED_OBSERVABILITY = Object.freeze({
  enabled: true,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
});

test("a genesis verifies against Cloudflare's expanded observability and refuses a changed default", async () => {
  const directory = await outputDirectory();
  const options = { ...(await base({ mode: "worker", genesis: true })), outputDirectory: directory };
  const dry = await runStagingEdgeDeployment({ ...options, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }) });
  assert.equal(dry.ok, true, dry.code);
  const secrets = join(await tempDirectory("staging-edge-secrets-"), "secrets.env");
  await writeFile(secrets, `${SECRETS_SENTINEL}\n`, { mode: 0o600 });
  const live = stagingDryRunAdvance(JSON.parse(await readFile(join(directory, "expected-snapshot.json"), "utf8")), ++versions);
  const captured = (mutate = () => {}) => {
    const inventory = stagingEdgeInventoryOf(live);
    inventory.settings.observability = structuredClone(CAPTURED_OBSERVABILITY);
    mutate(inventory.settings.observability);
    return inventory;
  };
  const execute = async (inventory) => runStagingEdgeDeployment({
    ...options, outputDirectory: await outputDirectory(), execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION,
    expectedCandidateSha256: dry.plan.candidateConfigSha256, secretsFile: secrets,
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }), spawn: fakeSpawn().spawn,
    createProvider: fakeProvider([inventory]).create, environment: ENVIRONMENT, checkWorkspacePackages: async () => {},
    probeExistence: async () => "absent",
  });
  const verified = await execute(captured());
  assert.equal(verified.ok, true, verified.code);
  assert.equal(verified.outcome, "verified");
  for (const mutate of [
    (value) => { value.traces.enabled = true; },
    (value) => { value.logs.persist = false; },
    (value) => { value.redact_query_string = true; },
  ]) {
    const refused = await execute(captured(mutate));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "PRODUCTION_LIVE_CONFIG_CONFIG_SETTINGS_DRIFT");
    assert.equal(refused.outcome, "deployed_unverified");
  }
  const unknown = await execute(captured((value) => { value.traces.unexpected = true; }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "PRODUCTION_LIVE_CONFIG_SETTINGS_INVALID");
});

test("an executed redeploy checks the predecessor before Wrangler and the live version after it", async () => {
  const { worker } = await states();
  const options = {
    ...(await base({ mode: "fenced", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit })),
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
    environment: ENVIRONMENT,
    checkWorkspacePackages: async () => {},
  };
  const dryDirectory = await outputDirectory();
  const dry = await runStagingEdgeDeployment({ ...options, outputDirectory: dryDirectory });
  assert.equal(dry.ok, true, dry.code);
  assert.equal(dry.plan.liveMode, "worker");
  assert.equal(dry.plan.identity, "binding");
  const expected = JSON.parse(await readFile(join(dryDirectory, "expected-snapshot.json"), "utf8"));
  const confirmed = { execute: true, confirmation: STAGING_EDGE_DEPLOY_CONFIRMATION, expectedCandidateSha256: dry.plan.candidateConfigSha256 };

  const moved = stagingDryRunAdvance(expected, ++versions);
  const changed = fakeSpawn();
  const refused = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: changed.spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(moved)]).create });
  assert.equal(refused.code, "STAGING_EDGE_PREDECESSOR_CHANGED");
  assert.equal(changed.calls.length, 0);

  const failing = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: fakeSpawn(1).spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker)]).create });
  assert.equal(failing.code, "STAGING_EDGE_WRANGLER_FAILED");
  assert.equal(failing.outcome, "outcome_unknown");

  const drift = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: await outputDirectory(),
    spawn: fakeSpawn().spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker), stagingEdgeInventoryOf(worker)]).create });
  assert.equal(drift.code, "STAGING_EDGE_LIVE_DRIFT");
  assert.equal(drift.outcome, "deployed_unverified");

  const directory = await outputDirectory();
  const deployed = stagingDryRunAdvance(expected, ++versions);
  const verified = await runStagingEdgeDeployment({ ...options, ...confirmed, outputDirectory: directory,
    spawn: fakeSpawn().spawn, createProvider: fakeProvider([stagingEdgeInventoryOf(worker), stagingEdgeInventoryOf(deployed)]).create });
  assert.equal(verified.ok, true, verified.code);
  await assertPrivateAndTokenFree(directory, verified);
});

test("reconcile reads a captured inventory against the deploy's plan", async () => {
  const { worker } = await states();
  const directory = await outputDirectory();
  const dry = await runStagingEdgeDeployment({
    ...(await base({ mode: "fenced", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit })),
    outputDirectory: directory, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
  });
  assert.equal(dry.ok, true);
  const expected = JSON.parse(await readFile(join(directory, "expected-snapshot.json"), "utf8"));
  const reconcile = (inventory) => reconcileStagingEdgeDeployment({ operationDirectory: directory, inventory });
  assert.equal((await reconcile(stagingEdgeInventoryOf(worker))).state, "not_deployed");
  const verified = await reconcile(stagingEdgeInventoryOf(stagingDryRunAdvance(expected, ++versions)));
  assert.equal(verified.state, "verified");
  assert.equal(verified.ok, true);
  const other = stagingEdgeInventoryOf(stagingDryRunAdvance(worker, ++versions));
  assert.equal((await reconcile(other)).state, "drift");
  assert.equal((await reconcile(PRODUCTION_INVENTORY)).code, "STAGING_EDGE_INVENTORY_TARGET_MISMATCH");
});

test("the genesis existence read is absent only on Cloudflare's script-not-found", async () => {
  const identity = { accountId: "0a".repeat(16), workerName: "app-usagemonitor-staging-edge", environment: ENVIRONMENT };
  const probe = (respond) => {
    const api = fakeApi(respond);
    return { api, result: probeStagingWorkerExistence({ ...identity, fetchImpl: api.fetchImpl }) };
  };
  const absent = probe(() => json(404, { success: false, errors: [{ code: CLOUDFLARE_WORKER_NOT_FOUND, message: "not found" }] }));
  assert.equal(await absent.result, "absent");
  const [request] = absent.api.requests;
  assert.equal(request.url,
    `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/workers/scripts/${identity.workerName}/deployments`);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, `Bearer ${SYNTHETIC_API_TOKEN}`);
  assert.equal(await probe(() => json(200, { success: true, result: { deployments: [] } })).result, "present");
  // A split deployment (the provider's DEPLOYMENT_AMBIGUOUS) is a Worker that exists.
  assert.equal(await probe(() => json(200, { success: true, result: { deployments: [{ versions: [
    { version_id: "5e000000-0000-4000-8000-000000000001", percentage: 50 },
    { version_id: "5e000000-0000-4000-8000-000000000002", percentage: 50 }] }] } })).result, "present");
  for (const respond of [
    () => json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
    () => json(429, { success: false, errors: [{ code: 971, message: "rate limited" }] }),
    () => json(404, { success: false, errors: [{ code: 7003, message: "no route" }] }),
    () => json(404, { success: false, errors: [{ code: CLOUDFLARE_WORKER_NOT_FOUND }, { code: 10000 }] }),
    () => json(404, { success: false, errors: [] }),
    () => json(404, { success: true, errors: [{ code: CLOUDFLARE_WORKER_NOT_FOUND }] }),
    () => json(500, { success: false, errors: [{ code: CLOUDFLARE_WORKER_NOT_FOUND }] }),
    () => ({ status: 404, text: async () => "<html>not json</html>" }),
    () => { throw new TypeError("synthetic network failure"); },
  ]) {
    await assert.rejects(probe(respond).result, (error) => error.code === "STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN");
  }
  await assert.rejects(probeStagingWorkerExistence({ ...identity, environment: { PATH: "/bin" } }),
    (error) => error.code === "STAGING_EDGE_CREDENTIAL_REQUIRED");
  await assert.rejects(probeStagingWorkerExistence({ ...identity, workerName: "../x" }),
    (error) => error.code === "STAGING_EDGE_INPUT_INVALID");
});

test("the release-guard gate refuses a pending ledger and an absent one, as Wrangler reports them", async () => {
  const { fenced } = await states();
  const ctx = await context();
  const secrets = stagingDryRunWithGcpSecrets(fenced, ++versions);
  const run = async (inputs, ledgers) => runStagingEdgeDeployment({
    ...(await base({
      mode: "gcp", inputs, stagingInventory: stagingEdgeInventoryOf(secrets), expectedPreviousSourceCommit: secrets.sourceCommit,
      siteDirectory: ctx.marked, candidatePublicManifestSha256: "a".repeat(64), originCommit: STAGING_DRY_RUN_ORIGIN_COMMIT,
      obtainOriginIdentityToken: STAGING_DRY_RUN_READERS.obtainOriginIdentityToken,
    })),
    outputDirectory: await outputDirectory(),
    sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
    spawn: stagingDryRunLedgerSpawn(ledgers),
  });
  const migrated = ctx.inputs["<inputs.json>"];
  const throwaway = ctx.inputs["<inputs naming the throwaway guard D1>"];
  const ledgers = stagingDryRunLedgers(migrated);
  const ok = await run(migrated, ledgers);
  assert.equal(ok.ok, true, ok.code);
  assert.equal(ok.plan.releaseGuardPendingMigrations, 0);
  // N2 as rehearsed: the throwaway's ledger exists (phase B ran `d1 migrations list`) and is empty.
  assert.equal((await run(throwaway, ledgers)).code, "EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING");
  // A guard D1 whose ledger was never created: Wrangler exits 1 with "no such table: d1_migrations".
  const uninitialised = new Map([...ledgers].filter(([name]) => name !== throwaway.d1.releaseGuard.name));
  assert.equal((await run(throwaway, uninitialised)).code, "PRODUCTION_MIGRATION_STATE_UNKNOWN");
});

test("reconcile refuses an operation target that is not the staging Worker before any read", async () => {
  const { worker } = await states();
  const directory = await outputDirectory();
  const dry = await runStagingEdgeDeployment({
    ...(await base({ mode: "fenced", stagingInventory: stagingEdgeInventoryOf(worker), expectedPreviousSourceCommit: worker.sourceCommit })),
    outputDirectory: directory, sourceState: () => ({ commit: STAGING_DRY_RUN_SOURCE, clean: true }),
  });
  assert.equal(dry.ok, true, dry.code);
  const targetPath = join(directory, "target.json");
  const target = JSON.parse(await readFile(targetPath, "utf8"));
  await rm(targetPath);
  await writeFile(targetPath, `${JSON.stringify({ ...target, edgeWorkerName: "app-usagemonitor" })}\n`, { mode: 0o600 });
  assert.equal((await reconcileStagingEdgeDeployment({ operationDirectory: directory, inventory: PRODUCTION_INVENTORY })).code,
    "STAGING_EDGE_NAME_NOT_STAGING");
  // The CLI's --execute refuses the same target.json before it builds a provider or reads a token.
  const cli = runDriver(["reconcile", "--operation", directory, "--execute"]);
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).code, "STAGING_EDGE_NAME_NOT_STAGING");
  await rm(targetPath);
  await writeFile(targetPath, `${JSON.stringify({ ...target, edgeWorkerName: "app-usagemonitor-staging" })}\n`, { mode: 0o600 });
  assert.equal(JSON.parse(runDriver(["reconcile", "--operation", directory, "--execute"]).stdout).code,
    "STAGING_EDGE_PRODUCTION_WORKER");
});

/** Run the driver CLI with PATH and HOME only: no token, so any remote read would fail on its credential. */
function runDriver(args) {
  return spawnSync(process.execPath, [DRIVER, ...args], {
    cwd: STAGING_EDGE_WORKER_DIRECTORY, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

async function privateJson(directory, name, value) {
  const path = join(directory, name);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("render takes deploy's isolation inputs and refuses what deploy refuses before writing", async () => {
  const directory = await tempDirectory("staging-edge-render-");
  const raw = JSON.parse(readFileSync(new URL("../ops/staging-edge/staging-edge-inputs.example.json", import.meta.url), "utf8"));
  const inputs = await privateJson(directory, "inputs.json", raw);
  const production = await privateJson(directory, "production.json", PRODUCTION_INVENTORY);
  const fence = await privateJson(directory, "production-fence-plan.json", PRODUCTION_FENCE_PLAN);
  const isolation = (inventory = production) => ["--production-inventory", inventory.path, "--production-inventory-sha256",
    inventory.sha256, "--production-plan-absent", "--production-fence-plan", fence.path, "--production-fence-plan-sha256",
    fence.sha256];
  const render = (args) => {
    const result = runDriver(["render", ...args]);
    return { status: result.status, output: JSON.parse(result.stdout) };
  };
  const dry = render(["--inputs", inputs.path, ...isolation()]);
  assert.equal(dry.status, 0, JSON.stringify(dry.output));
  assert.equal(dry.output.productionIsolation.productionPlan, false);
  const out = join(directory, "rendered");
  assert.equal(render(["--inputs", inputs.path, ...isolation(), "--write", "--output-directory", out]).status, 0);
  const written = await readdir(out);
  assert.ok(written.includes("migrations-ingestion.wrangler.json"));
  // Analytics takes production's storage ledger: no Wrangler migration config, and a storage-runner command.
  assert.equal(written.includes("migrations-analytics.wrangler.json"), false);
  const analyticsMigration = dry.output.migrations.find((entry) => entry.role === "analytics");
  assert.equal(analyticsMigration.ledger, "d1_storage_migrations");
  assert.deepEqual(analyticsMigration.command.slice(0, 5), ["npm", "run", "staging-edge", "--", "storage-apply"]);
  assert.ok(dry.output.migrations.filter((entry) => entry.command[0] === "wrangler").every((entry) => entry.ledger === "d1_migrations"
    && entry.role !== "analytics"));
  // Without the isolation inputs render does not run.
  assert.equal(runDriver(["render", "--inputs", inputs.path]).status, 2);
  assert.equal(runDriver(["render", "--inputs", inputs.path, ...isolation().slice(0, 5)]).status, 2);

  // The production ANALYTICS_DB id in the inputs, with the true production inventory and with another Worker's.
  const analytics = PRODUCTION_INVENTORY.version.resources.bindings.find((binding) => binding.name === "ANALYTICS_DB");
  const leaking = await privateJson(directory, "leaking.json", { ...raw, d1: { ...raw.d1, analytics: { ...raw.d1.analytics, id: analytics.database_id } } });
  const other = await privateJson(directory, "other.json", otherWorkerInventory());
  const leakOut = join(directory, "leak");
  assert.deepEqual(render(["--inputs", leaking.path, ...isolation(), "--write", "--output-directory", leakOut]),
    { status: 1, output: { ok: false, code: "STAGING_EDGE_PRODUCTION_DATABASE" } });
  assert.deepEqual(render(["--inputs", leaking.path, ...isolation(other), "--write", "--output-directory", leakOut]),
    { status: 1, output: { ok: false, code: "STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION" } });
  // The production catch-up control D1, known only from the production fence plan.
  const catchup = await privateJson(directory, "catchup.json", { ...raw, d1: { ...raw.d1,
    catchupControl: { ...raw.d1.catchupControl, id: PRODUCTION_FENCE_PLAN.dataResources[3].id } } });
  assert.deepEqual(render(["--inputs", catchup.path, ...isolation(), "--write", "--output-directory", leakOut]),
    { status: 1, output: { ok: false, code: "STAGING_EDGE_PRODUCTION_DATABASE" } });
  // The production gcp plan's guard D1, which only the plan names before production binds it.
  const plan = await privateJson(directory, "production-plan.json", {
    upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app", originAudience: "synthetic-production-audience",
    invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
    releaseGuardDatabase: { id: raw.d1.releaseGuard.id, name: "tibotattle-release-guard" },
  });
  const withPlan = isolation().map((value) => (value === "--production-plan-absent" ? "--production-plan" : value));
  withPlan.splice(withPlan.indexOf("--production-plan") + 1, 0, plan.path);
  assert.deepEqual(render(["--inputs", inputs.path, ...withPlan, "--write", "--output-directory", leakOut]),
    { status: 1, output: { ok: false, code: "STAGING_EDGE_PRODUCTION_DATABASE" } });
  await assert.rejects(lstat(leakOut));
});

test("Wrangler gets the token only through its environment, never an endpoint override", () => {
  assert.throws(() => stagingWranglerEnvironment({ PATH: "/bin" }), (error) => error.code === "STAGING_EDGE_CREDENTIAL_REQUIRED");
  assert.throws(() => stagingWranglerEnvironment({ ...ENVIRONMENT, CLOUDFLARE_API_BASE_URL: "https://example.invalid" }),
    (error) => error.code === "STAGING_EDGE_ENVIRONMENT_OVERRIDE");
  const env = stagingWranglerEnvironment({ ...ENVIRONMENT, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), OTHER: "x" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CLOUDFLARE_API_TOKEN", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
});

test("the output directory must be new, private and outside the repository", async () => {
  await assert.rejects(createStagingOutputDirectory(join(STAGING_EDGE_WORKER_DIRECTORY, ".staging-edge-out")),
    (error) => error.code === "STAGING_EDGE_OUTPUT_INSIDE_REPOSITORY");
  const parent = await tempDirectory("staging-edge-parent-");
  const created = await createStagingOutputDirectory(join(parent, "run"));
  assert.equal((await lstat(created)).mode & 0o777, 0o700);
  await assert.rejects(createStagingOutputDirectory(join(parent, "run")));
});

test("the argument parser accepts exactly each subcommand's combinations", () => {
  const hex = (n) => "a".repeat(n);
  const isolation = ["--production-inventory", "p.json", "--production-inventory-sha256", hex(64), "--production-plan-absent",
    "--production-fence-plan", "f.json", "--production-fence-plan-sha256", hex(64)];
  const deploy = ["deploy", "--edge-mode", "worker", "--inputs", "i.json", ...isolation, "--site", "site",
    "--output-directory", "out"];
  const live = ["--inventory", "s.json", "--inventory-sha256", hex(64), "--expected-previous-source", hex(40)];
  const ok = (argv) => assert.equal(parseStagingEdgeArguments(argv).subcommand, argv[0]);
  const bad = (argv) => assert.throws(() => parseStagingEdgeArguments(argv), (error) => error.code === "STAGING_EDGE_ARGUMENTS_INVALID", argv.join(" "));
  ok([...deploy, "--genesis"]);
  ok([...deploy, "--genesis", "--secrets-file", "s.env", "--execute", "--confirm", "DEPLOY_STAGING_EDGE", "--expected-candidate-sha256", hex(64)]);
  ok([...deploy, ...live]);
  ok([...deploy, ...live, "--fence-receipt", "f.json", "--fence-receipt-sha256", hex(64)]);
  ok([...deploy.map((value) => (value === "worker" ? "gcp" : value)), ...live, "--origin-commit", hex(40),
    "--origin-verifier-account", "v@p.iam.gserviceaccount.com", "--candidate-site"]);
  bad([...deploy]);
  bad([...deploy, "--genesis", ...live]);
  bad([...deploy, "--genesis", "--execute", "--confirm", "DEPLOY_STAGING_EDGE", "--expected-candidate-sha256", hex(64)]);
  bad([...deploy, "--genesis", "--secrets-file", "s.env"]);
  bad([...deploy, ...live, "--secrets-file", "s.env"]);
  bad([...deploy, ...live, "--confirm", "DEPLOY_STAGING_EDGE"]);
  bad([...deploy, ...live, "--execute"]);
  bad([...deploy, ...live, "--production-plan", "plan.json"]);
  bad([...deploy, ...live, "--fence-receipt", "f.json"]);
  bad([...deploy.map((value) => (value === "worker" ? "fenced" : value)), ...live, "--fence-receipt", "f.json",
    "--fence-receipt-sha256", hex(64)]);
  bad([...deploy.map((value) => (value === "worker" ? "gcp" : value)), ...live]);
  bad([...deploy, ...live, "--origin-commit", hex(40), "--origin-verifier-account", "v@p.iam.gserviceaccount.com"]);
  bad([...deploy, ...live, "--edge-mode", "fenced"]);
  bad([...deploy, ...live, "--expected-previous-source", "HEAD"]);
  bad([...deploy, ...live, "--env", "production"]);
  bad(["deploy", "--edge-mode", "auto", "--inputs", "i"]);
  bad(["publish"]);
  const withoutFencePlan = deploy.filter((value) => !["--production-fence-plan", "f.json", "--production-fence-plan-sha256"].includes(value)
    && value !== hex(64));
  assert.equal(withoutFencePlan.includes("--production-inventory-sha256"), true);
  bad([...withoutFencePlan.flatMap((value) => (value === "--production-inventory-sha256" ? [value, hex(64)] : [value])), "--genesis"]);
  ok([...deploy, "--genesis"]);
  bad([...deploy.map((value, index) => (deploy[index - 1] === "--production-fence-plan-sha256" ? "HEAD" : value)), "--genesis"]);
  ok(["render", "--inputs", "i.json", ...isolation]);
  ok(["render", "--inputs", "i.json", ...isolation, "--write", "--output-directory", "out"]);
  ok(["render", "--inputs", "i.json", ...isolation, "--production-baseline-inventory", "b.json",
    "--production-baseline-inventory-sha256", hex(64)]);
  ok(["render", "--inputs", "i.json", ...isolation.map((value) => (value === "--production-plan-absent" ? "--production-plan" : value))
    .flatMap((value) => (value === "--production-plan" ? [value, "plan.json"] : [value]))]);
  bad(["render", "--inputs", "i.json"]);
  bad(["render", "--inputs", "i.json", "--write", "--output-directory", "out"]);
  bad(["render", "--inputs", "i.json", ...isolation.slice(0, 5)]);
  bad(["render", "--inputs", "i.json", ...isolation, "--production-plan", "plan.json"]);
  bad(["render", "--inputs", "i.json", ...isolation, "--production-baseline-inventory", "b.json"]);
  bad(["render", "--inputs", "i.json", ...isolation, "--write"]);
  bad(["render", "--inputs", "i.json", ...isolation, "--execute"]);
  ok(["reconcile", "--operation", "op", "--inventory", "s.json", "--inventory-sha256", hex(64)]);
  ok(["reconcile", "--operation", "op", "--execute"]);
  bad(["reconcile", "--operation", "op"]);
  bad(["reconcile", "--operation", "op", "--execute", "--inventory", "s.json", "--inventory-sha256", hex(64)]);
  ok(["endpoints", "--edge-mode", "fenced", "--inputs", "i.json", "--expected-source", hex(40)]);
  ok(["endpoints", "--edge-mode", "gcp", "--inputs", "i.json", "--expected-source", hex(40), "--origin-commit", hex(40), "--execute"]);
  bad(["endpoints", "--edge-mode", "gcp", "--inputs", "i.json", "--expected-source", hex(40)]);
  ok(["rehearsal"]);
  bad(["rehearsal", "--execute"]);
});

test("every rehearsal command parses and every expected outcome agrees with the matrix", () => {
  const sequence = stagingEdgeRehearsalSequence();
  const sha256Flags = new Set(["--production-inventory-sha256", "--production-fence-plan-sha256", "--inventory-sha256",
    "--fence-receipt-sha256", "--expected-candidate-sha256"]);
  const shaFlags = new Set(["--expected-previous-source", "--origin-commit"]);
  for (const step of sequence) {
    assert.ok(rehearsalStepAgreesWithMatrix(step), step.id);
    if (step.kind !== "deploy") {
      assert.equal(step.command[2], step.subcommand);
      continue;
    }
    const argv = step.command.slice(step.command.indexOf("--") + 1).map((value, index, list) => {
      if (!value.startsWith("<")) return value;
      if (sha256Flags.has(list[index - 1])) return "b".repeat(64);
      if (shaFlags.has(list[index - 1])) return "c".repeat(40);
      return "/private/synthetic";
    });
    const parsed = parseStagingEdgeArguments(argv);
    assert.equal(parsed.edgeMode, step.to, step.id);
    if (step.expect.ok && step.from !== null) {
      assert.ok(EDGE_MODE_TRANSITIONS.some((entry) => entry.from === step.from && entry.to === step.to), step.id);
    }
  }
  const okModes = sequence.filter((step) => step.kind === "deploy" && step.expect.ok).map((step) => step.to);
  assert.deepEqual(okModes, ["worker", "worker", "fenced", "fenced", "worker", "fenced", "gcp", "gcp", "fenced", "gcp", "fenced"]);
  assert.equal(sequence.at(-1).to, "fenced");
});

test("the endpoint matrix follows the mode table and is read without credentials", async () => {
  const { inputs } = await context();
  const target = inputs["<inputs.json>"];
  const source = "d".repeat(40);
  const fenced = stagingEdgeEndpointMatrix({ mode: "fenced", inputs: target, expectedSourceCommit: source });
  assert.equal(fenced.origin, `https://${target.publicHostname}`);
  assert.ok(fenced.checks.some((check) => check.id === "ready" && check.expect.status === 503));
  assert.ok(fenced.checks.every((check) => new URL(check.url).hostname.endsWith(target.publicHostname)));
  assert.equal(fenced.checks.find((check) => check.id === "admin-access").expect.locationHost, target.access.teamDomain);
  assert.throws(() => stagingEdgeEndpointMatrix({ mode: "gcp", inputs: target, expectedSourceCommit: source }));
  const worker = stagingEdgeEndpointMatrix({ mode: "worker", inputs: target, expectedSourceCommit: source });
  assert.equal(worker.checks.some((check) => check.id === "ready"), false);

  const requests = [];
  const respond = (status, body, headers) => ({ status, url: null, headers: new Headers(headers), text: async () => body });
  const secure = { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff" };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const host = new URL(url).hostname;
    let response;
    if (host.startsWith("admin.")) {
      response = respond(302, "", { location: `https://${target.access.teamDomain}/cdn-cgi/access/login/${host}` });
    } else if (path === "/api/health") {
      response = respond(200, JSON.stringify({ status: "ok", mode: "migration-mutation-barrier",
        maintenance: { state: "fenced", storageQualified: false }, deployment: { sourceCommit: source } }), secure);
    } else if (path === "/release-site-manifest.json") {
      response = respond(200, "{}", { "content-type": "application/json" });
    } else if (path === "/") {
      response = respond(200, "<!doctype html><title>site</title>", { "content-type": "text/html" });
    } else if (path === "/api/ready" || edgeModeForbiddenPathClass(path) !== "public-asset") {
      response = respond(503, JSON.stringify({ error: { code: "MUTATION_BARRIER_ACTIVE" } }),
        { "content-type": "application/json", "cache-control": "no-store", "retry-after": "300" });
    } else {
      response = respond(404, "", {});
    }
    response.url = url;
    return response;
  };
  const result = await verifyStagingEdgeEndpoints({ mode: "fenced", inputs: target, expectedSourceCommit: source, fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  assert.ok(requests.every((request) => request.init.method === "GET" && request.init.credentials === "omit"
    && request.init.headers?.authorization === undefined));
  const wrong = await verifyStagingEdgeEndpoints({ mode: "worker", inputs: target, expectedSourceCommit: source, fetchImpl });
  assert.equal(wrong.ok, false);
});

test("the edge health recheck takes a staging origin and refuses a non-canonical one", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); throw new Error("offline"); };
  const staging = await recheckProductionEdgeHealth({ fetchImpl, mode: "worker", expectedSourceCommit: "a".repeat(40),
    origin: "https://staging.synthetic-edge.example" });
  assert.equal(staging.code, "PRODUCTION_EDGE_HEALTH_UNREACHABLE");
  assert.deepEqual(seen, ["https://staging.synthetic-edge.example/api/health"]);
  for (const origin of ["http://staging.synthetic-edge.example", "https://staging.synthetic-edge.example/path", "not a url",
    "https://staging.synthetic-edge.example/", "https://staging.synthetic-edge.example?query=1",
    "https://staging.synthetic-edge.example#fragment", "https://user:password@staging.synthetic-edge.example"]) {
    assert.equal((await recheckProductionEdgeHealth({ fetchImpl, mode: "worker", expectedSourceCommit: "a".repeat(40), origin })).code,
      "PRODUCTION_EDGE_HEALTH_INPUT_INVALID", origin);
  }
  assert.deepEqual(seen, ["https://staging.synthetic-edge.example/api/health"]);
});
