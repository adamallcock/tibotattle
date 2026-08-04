import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANONICAL_PRODUCTION_DEPLOYMENT_PROOF,
  DEPLOYMENT_PROOF_SCHEMA_VERSION,
  PRODUCTION_CONTAINMENT_PROOF_OPERATION,
  PRODUCTION_OBSERVATION_CHANNEL,
  validateDeploymentProof,
} from "./deployment-proof.mjs";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  runProductionDeployment,
} from "./production-deploy.mjs";

const NOW = Date.parse("2026-08-04T20:00:00.000Z");

function proofCheck(overrides = {}) {
  const proof = {
    schemaVersion: DEPLOYMENT_PROOF_SCHEMA_VERSION,
    operation: PRODUCTION_CONTAINMENT_PROOF_OPERATION,
    environment: "production",
    channel: "stable",
    observationChannel: PRODUCTION_OBSERVATION_CHANNEL,
    status: "remote_containment_observed",
    observedAt: new Date(NOW - 1_000).toISOString(),
    target: {
      origin: CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifest.publicOrigin,
      endpointManifest: {
        ...CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifest,
        sha256: CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifestSha256,
      },
    },
    worker: {
      revision: "production-revision-0001",
      sourceCommit: "c26823c",
      enrollmentMode: "disabled",
      collectionControls: "contained",
    },
    evidence: {
      ownerObservedRemoteRevision: true,
      ownerObservedDisabledMode: true,
      ownerObservedContainment: true,
      ownerObservedCanonicalTarget: true,
    },
    ...overrides,
  };
  return validateDeploymentProof({ proof, kind: "production", now: NOW });
}

function options(overrides = {}) {
  return {
    confirmation: PRODUCTION_DEPLOY_CONFIRMATION,
    receiptFile: "/owner-only/production-proof.json",
    now: NOW,
    wrangler: "/fake/wrangler",
    workerDirectory: "/worker",
    ...overrides,
  };
}

test("production deployment requires scoped confirmation and a receipt before local gates or Wrangler", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    confirmation: "DEPLOY_SOMETHING",
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(result, { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);

  const absent = await runProductionDeployment(options({
    receiptFile: null,
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(absent, { ok: false, code: "DEPLOYMENT_PROOF_REQUIRED" });
  assert.deepEqual(calls, []);
});

test("production deployment refuses invalid or stale proof before Wrangler", async () => {
  const calls = [];
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-production-proof-"));
  try {
    const valid = proofCheck().proof;
    const cases = [
      ["malformed", "not-json\n"],
      ["stale", JSON.stringify({
        ...valid,
        observedAt: new Date(
          NOW - 15 * 60 * 1000 - 1,
        ).toISOString(),
      })],
      ["mismatched", JSON.stringify({
        ...valid,
        target: {
          ...valid.target,
          origin: "https://wrong.example.test",
        },
      })],
    ];
    for (const [name, contents] of cases) {
      const receiptFile = join(root, `${name}.json`);
      await writeFile(receiptFile, contents, { mode: 0o600 });
      const result = await runProductionDeployment(options({
        receiptFile,
        checkWorkspacePackages: async () => calls.push("workspace"),
        checkEndpoints: async () => calls.push("endpoints"),
        stageAssets: async () => calls.push("assets"),
        spawn: () => calls.push("deploy"),
      }));
      assert.equal(result.ok, false, name);
      assert.equal(
        result.code,
        name === "mismatched"
          ? "PRODUCTION_CONTAINMENT_PROOF_MISMATCH"
          : "DEPLOYMENT_PROOF_MALFORMED",
        name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const code of [
    "DEPLOYMENT_PROOF_MALFORMED",
    "PRODUCTION_CONTAINMENT_PROOF_MISMATCH",
  ]) {
    const result = await runProductionDeployment(options({
      proofCheck: { ok: false, code },
      checkWorkspacePackages: async () => calls.push("workspace"),
      checkEndpoints: async () => calls.push("endpoints"),
      stageAssets: async () => calls.push("assets"),
      spawn: () => calls.push("deploy"),
    }));
    assert.deepEqual(result, { ok: false, code });
  }
  assert.deepEqual(calls, []);
});

test("valid production proof routes through local checks and then the exact production Wrangler deploy", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "workspace",
    "endpoints",
    "assets",
    ["deploy", "--env", "production", "--strict"],
  ]);
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.containmentProof.workerRevision, "production-revision-0001");
});
