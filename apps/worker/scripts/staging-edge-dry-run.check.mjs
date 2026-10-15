import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_MODULE_EXPORTS } from "./edge-mode-dry-run.mjs";
import {
  STAGING_DRY_RUN_BUNDLES,
  simulateStagingEdgeRehearsal,
  stagingDryRunViolations,
} from "./staging-edge-dry-run.mjs";
import { stagingEdgeRehearsalSequence } from "./staging-edge-deploy.mjs";

const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

let simulation;
async function simulate() {
  if (simulation) return simulation;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "staging-edge-dry-run-check-")));
  temporary.push(directory);
  simulation = await simulateStagingEdgeRehearsal({ directory });
  return simulation;
}

const RATE_LIMITS = Object.freeze([
  "CLIENT_ATTEMPT_RATE_LIMIT", "ENROLLMENT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT", "RECOVERY_RATE_LIMIT",
  "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
  "PUBLIC_PROBE_RATE_LIMIT", "PUBLIC_PROBE_CLIENT_RATE_LIMIT", "SPARKLE_APPCAST_GUARD_RATE_LIMIT",
]);

function passingBundles() {
  const common = {
    main: "src/edge-entry.ts", mainIsEdgeEntry: true, worker: "app-usagemonitor-staging-edge",
    ratelimits: [...RATE_LIMITS], durableObjects: ["UPLOAD_INGRESS_BUDGET"], exports: [...MAIN_MODULE_EXPORTS],
    domains: ["admin.staging.synthetic-edge.example", "staging.synthetic-edge.example"],
  };
  const data = { d1: ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"], r2: ["QUARANTINE", "SPARKLE_RELEASES"], crons: ["* * * * *"] };
  const gcp = { d1: ["RELEASE_GUARD_DB"], r2: ["SPARKLE_RELEASES"], crons: [] };
  return [
    { ...common, ...data, mode: "worker", bundle: "worker", modeVar: "worker" },
    { ...common, ...data, mode: "fenced", bundle: "fenced", modeVar: "fenced" },
    { ...common, ...gcp, mode: "gcp", bundle: "gcp", modeVar: "gcp" },
    { ...common, ...gcp, mode: "fenced", bundle: "brake", modeVar: "fenced" },
    { bundle: "standin", worker: "app-usagemonitor-staging-edge-catchup", d1: ["STORAGE_ANALYTICS_CATCHUP_CONTROL_DB"],
      crons: ["*/5 * * * *"], exports: ["default"] },
  ];
}

test("the whole rehearsal sequence gives every expected outcome through the driver's dry run", async () => {
  const { results, candidates } = await simulate();
  const deploys = results.filter((result) => result.kind === "deploy");
  assert.equal(deploys.length, stagingEdgeRehearsalSequence().filter((step) => step.kind === "deploy").length);
  for (const result of deploys) assert.equal(result.matched, true, `${result.id}: ${JSON.stringify(result.actual)}`);
  assert.deepEqual(stagingDryRunViolations({ steps: results, bundles: passingBundles() }), []);
  for (const step of Object.values(STAGING_DRY_RUN_BUNDLES)) assert.ok(candidates[step], step);
});

test("the gcp candidate is reduced to the staging guard D1 and keeps the staging domains", async () => {
  const { candidates } = await simulate();
  const gcp = JSON.parse(await readFile(candidates[STAGING_DRY_RUN_BUNDLES.gcp], "utf8")).env.production;
  assert.equal(gcp.vars.EDGE_UPSTREAM_MODE, "gcp");
  assert.deepEqual(gcp.d1_databases.map((entry) => [entry.binding, entry.database_name]),
    [["RELEASE_GUARD_DB", "tibotattle-staging-release-guard"]]);
  assert.deepEqual(gcp.triggers.crons, []);
  assert.equal(gcp.vars.EDGE_ORIGIN_AUDIENCE, "tibotattle-staging-edge-origin");
  assert.ok(!JSON.stringify(gcp).includes("tibotattle.com"));
  const brake = JSON.parse(await readFile(candidates[STAGING_DRY_RUN_BUNDLES.brake], "utf8")).env.production;
  assert.equal(brake.vars.EDGE_UPSTREAM_MODE, "fenced");
  assert.equal(brake.vars.EDGE_UPSTREAM_ORIGIN, gcp.vars.EDGE_UPSTREAM_ORIGIN);
});

test("the rehearsal runs on Cloudflare's expanded observability after genesis", async () => {
  const { candidates, live } = await simulate();
  const declared = { enabled: true, head_sampling_rate: 1 };
  const expanded = {
    ...declared,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
    traces: { enabled: false, head_sampling_rate: 1, persist: true },
  };
  // The genesis candidate is the tracked declaration; every later step renders
  // from the simulated live capture, which carries the expanded sections.
  assert.deepEqual(JSON.parse(await readFile(candidates["R1.0"], "utf8")).env.production.observability, declared);
  for (const step of ["R1.1", STAGING_DRY_RUN_BUNDLES.fenced, STAGING_DRY_RUN_BUNDLES.gcp, STAGING_DRY_RUN_BUNDLES.brake]) {
    assert.deepEqual(JSON.parse(await readFile(candidates[step], "utf8")).env.production.observability, expanded, step);
  }
  assert.deepEqual(live.settings.observability, expanded);
});

test("each broken property is reported", async () => {
  const { results } = await simulate();
  const cases = [
    [({ steps }) => { steps.find((step) => step.id === "R1.2").matched = false; }, "R1.2:"],
    [({ bundles }) => { bundles[0].mainIsEdgeEntry = false; }, "worker: main is not the edge entry"],
    [({ bundles }) => { bundles[2].d1.push("USAGE_MONITOR_DB"); }, "gcp: a data binding survives"],
    [({ bundles }) => { bundles[3].d1 = ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"]; },
      "brake: the gcp storage reduction is not kept"],
    [({ bundles }) => { bundles[1].worker = "app-usagemonitor"; }, "fenced: production worker name"],
    [({ bundles }) => { bundles[0].domains = ["staging.synthetic-edge.example"]; }, "worker: custom domains"],
    [({ bundles }) => { bundles[4].exports = ["STAND_IN_SQL", "default"]; }, "standin: binding, cron or default export"],
    [({ bundles }) => { bundles[2] = { mode: "gcp", bundle: "gcp", step: "R2.7", missing: true }; }, "gcp: no candidate from R2.7"],
  ];
  for (const [mutate, expected] of cases) {
    const input = { steps: structuredClone(results), bundles: passingBundles() };
    mutate(input);
    assert.ok(stagingDryRunViolations(input).some((violation) => violation.startsWith(expected)), expected);
  }
});
