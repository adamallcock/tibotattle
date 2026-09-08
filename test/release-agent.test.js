import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRelease, validateReleasePlan, parseReleaseAgentArgs, releaseOperationStatus } from "../scripts/release-agent.mjs";
import { openOperation } from "../scripts/lib/release-operation.mjs";

const commit = "a".repeat(40);
const base = "b".repeat(40);
const plan = () => ({ schema: 1, sourceCommit: commit, baseCommit: base, channel: "stable", targets: [{ architecture: "arm64", output: "candidate.dmg" }, { architecture: "x64", output: "intel.dmg" }] });
const git = (command, args) => {
  assert.equal(command, "git");
  assert.ok(["rev-parse", "status", "merge-base", "rev-list"].includes(args[0]), "doctor invokes only local read-only Git");
  return { status: 0, stdout: args[0] === "rev-parse" ? commit : args[0] === "rev-list" ? "8\t48\n" : "" };
};
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-doctor-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("doctor is side-effect-free, collects blockers and never certifies unexercised gates", async (t) => {
  const root = await fixture(t);
  const result = await inspectRelease({ repositoryRoot: root, plan: plan(), spawn: git,
    platform: "darwin", architecture: "arm64", nodeVersion: "26.2.0",
    environment: { USAGE_MONITOR_DEVELOPER_ID_APPLICATION: "Developer ID Application: Secret Canary (AAAAAAAAAA)", USAGE_MONITOR_NOTARY_PROFILE: "secret-canary" },
    sourceProvenance: () => ({ commit }), buildConfiguration: () => ({}), receiptCheck: async () => true });
  assert.deepEqual(await readdir(root), []);
  assert.equal(result.readyToRelease, false);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.localTrackingDivergence, { mainOnly: 8, checkoutOnly: 48, remoteFetched: false });
  const checks = Object.fromEntries(result.checks.map((check) => [check.name, check.state]));
  assert.equal(checks.requested_source, "passed");
  assert.equal(checks.developer_id_reference, "configured_not_exercised");
  assert.equal(checks.arm64_candidate, "blocked");
  assert.equal(checks.x64_runtime, "blocked");
  assert.equal(checks.arm64_physical_hardware, "not_exercised");
  assert.equal(checks.hosted_lineage, "not_exercised");
  assert.equal(JSON.stringify(result).includes("Canary"), false);
  assert.equal(JSON.stringify(result).includes("secret-canary"), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("doctor reports stale source, dirty checkout, unavailable tags, runtime and receipts together", async (t) => {
  const root = await fixture(t);
  const result = await inspectRelease({ repositoryRoot: root, plan: plan(), environment: {},
    spawn: () => ({ status: 1 }), platform: "linux", architecture: "x64", nodeVersion: "22.13.0",
    sourceProvenance: () => { throw new Error("private-path"); }, buildConfiguration: () => { throw new Error("secret"); }, receiptCheck: async () => false });
  for (const name of ["requested_source", "clean_checkout", "reviewed_base", "annotated_source_tag", "pinned_builder", "r7_receipt_contract"]) {
    assert.equal(result.checks.find((check) => check.name === name).state, "blocked");
  }
  assert.equal(JSON.stringify(result).includes("private-path"), false);
  assert.deepEqual(await readdir(root), []);
});

test("doctor detects occupied outputs and reads manifests without qualifying signed artifacts", async (t) => {
  const root = await fixture(t);
  const selected = plan(); selected.targets = [{ architecture: "x64", app: "App", nodeRuntime: "node", previousManifest: "previous.json", output: "candidate.dmg" }];
  await mkdir(join(root, "App/Contents/Resources"), { recursive: true });
  await writeFile(join(root, "App/Contents/Resources/build-manifest.json"), JSON.stringify({ application: { architecture: "x64" }, release: { source: { commit } } }));
  await writeFile(join(root, "node"), "synthetic-never-executed");
  await writeFile(join(root, "candidate.dmg"), "occupied");
  const result = await inspectRelease({ repositoryRoot: root, plan: selected, spawn: git, environment: {},
    sourceProvenance: () => ({}), buildConfiguration: () => ({}), previousManifestReader: async () => ({ application: { architecture: "x64" } }), receiptCheck: async () => true });
  const checks = Object.fromEntries(result.checks.map((check) => [check.name, check.state]));
  assert.equal(checks.x64_candidate, "present_unverified");
  assert.equal(checks.x64_runtime, "present_unverified");
  assert.equal(checks.x64_previous_release, "present_unverified");
  assert.equal(checks.x64_output, "blocked");
});

test("closed plan and CLI separate inspection from any mutation", () => {
  for (const value of [{ ...plan(), extra: true }, { ...plan(), targets: [] }, { ...plan(), sourceCommit: "main" },
    { ...plan(), targets: [{ architecture: "arm64" }, { architecture: "arm64" }] }]) assert.throws(() => validateReleasePlan(value));
  for (const argv of [["deploy"], ["doctor", "--publish"], ["doctor", "--operation", "x"], ["status"], ["doctor", "--json", "--json"]]) assert.throws(() => parseReleaseAgentArgs(argv));
  assert.equal(parseReleaseAgentArgs(["doctor", "--json"]).json, true);
});

test("status never emits private IDs or treats recorded remote success as a live check", async (t) => {
  const root = await fixture(t);
  const operation = await openOperation({ directory: join(root, "operation"), kind: "production", binding: {} });
  await operation.save({ outcome: "verified", lock: "released", owner: "private-owner", raw: "private-secret" });
  operation.close();
  const status = await releaseOperationStatus(join(root, "operation"));
  assert.equal(status.outcome, "verified");
  assert.equal(status.remoteState, "not_rechecked");
  assert.equal(JSON.stringify(status).includes("private-"), false);
});

test("status distinguishes safe preflight retry from retained uncertain ownership", async (t) => {
  const root = await fixture(t);
  const operation = await openOperation({ directory: join(root, "operation"), kind: "production", binding: {} });
  for (const lock of ["not_acquired", "released", "held", "uncertain"]) {
    await operation.save({ outcome: "not_started", lock });
    const status = await releaseOperationStatus(join(root, "operation"));
    assert.equal(status.nextAction, ["not_acquired", "released"].includes(lock)
      ? "inspect_preflight_failure_then_start_reviewed_new_operation" : "reconcile_existing_deployment_do_not_redeploy");
  }
  operation.close();
});
