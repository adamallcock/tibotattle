import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
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
  recheckProductionContainment,
} from "./production-deploy.mjs";

const NOW = Date.parse("2026-08-04T20:00:00.000Z");
const HEALTH_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/api/health`;

function containedHealth() {
  return {
    status: "ok",
    enrollmentMode: "disabled",
    collectionControls: {
      state: "contained",
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    },
    contracts: {
      accountScopedContribution: {
        externalParticipantsAuthorized: false,
      },
    },
  };
}

function jsonHealthResponse(value = containedHealth(), status = 200) {
  return {
    url: HEALTH_URL,
    status,
    headers: {
      get(name) {
        return {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        }[name];
      },
    },
    text: async () => JSON.stringify(value),
  };
}

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
    expectedSourceCommit: "c26823c",
    sourceCommitCheck: () => "c26823c",
    sourceTreeCleanCheck: () => true,
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      cleanup: async () => {},
    }),
    releasePreflight: async () => ({
      state: "ready",
      blockers: [],
    }),
    fetchImpl: async (url) => {
      assert.equal(String(url), HEALTH_URL);
      return jsonHealthResponse();
    },
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

test("production deployment fails closed when immutable source snapshot setup or cleanup fails", async () => {
  let spawned = false;
  const creationFailure = await runProductionDeployment(options({
    createSourceSnapshot: async () => {
      throw new Error("snapshot creation failed");
    },
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(creationFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
  });
  assert.equal(spawned, false);

  const cleanupFailure = await runProductionDeployment(options({
    proofCheck: { ok: false, code: "DEPLOYMENT_PROOF_REQUIRED" },
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      cleanup: async () => {
        throw new Error("snapshot cleanup failed");
      },
    }),
  }));
  assert.deepEqual(cleanupFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
  });
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
  const healthCalls = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    releasePreflight: async () => {
      calls.push("preflight");
      return { state: "ready", blockers: [] };
    },
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    fetchImpl: async (url, request) => {
      healthCalls.push({ url: String(url), request });
      return jsonHealthResponse();
    },
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "preflight",
    "workspace",
    "endpoints",
    "assets",
    ["deploy", "--env", "production", "--strict"],
  ]);
  assert.equal(healthCalls.length, 1);
  assert.equal(healthCalls[0].url, HEALTH_URL);
  assert.equal(healthCalls[0].request.method, "GET");
  assert.equal(healthCalls[0].request.credentials, "omit");
  assert.equal(healthCalls[0].request.redirect, "error");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.immediateHealthRecheck, "contained");
  assert.equal(result.containmentProof.workerRevision, "production-revision-0001");
});

test("production deployment treats release preflight as a hard gate", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    releasePreflight: async () => ({
      state: "blocked",
      blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
    }),
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "RELEASE_PREFLIGHT_BLOCKED",
    blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
  });
  assert.deepEqual(calls, []);
});

test("production deployment does not spawn Wrangler when immediate health recheck fails", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("network");
    },
    async () => jsonHealthResponse({
      ...containedHealth(),
      enrollmentMode: "open",
    }),
    async () => ({
      ...jsonHealthResponse(),
      url: "https://redirected.example.test/api/health",
    }),
    async () => ({
      ...jsonHealthResponse(),
      headers: {
        get(name) {
          return name === "cache-control" ? "public" : "nosniff";
        },
      },
    }),
  ]) {
    let spawned = false;
    const result = await runProductionDeployment(options({
      proofCheck: proofCheck(),
      fetchImpl,
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    }));
    assert.equal(spawned, false);
    assert.equal(result.ok, false);
    assert.match(result.code, /^PRODUCTION_HEALTH_RECHECK_/u);
  }
});

test("production deployment stops before Wrangler on a proof source revision mismatch", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck({
      worker: { ...proofCheck().proof.worker, sourceCommit: "deadbee" },
    }),
    checkWorkspacePackages: async () => {
      throw new Error("must not run");
    },
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_CONTAINMENT_PROOF_MISMATCH",
  });
  assert.equal(spawned, false);
});

test("production deployment stops if the checked-out source revision changes before Wrangler", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    sourceCommitCheck: () => "deadbee",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, false);
});

test("production deployment rejects source revision movement across the Wrangler boundary", async () => {
  let spawned = false;
  let sourceMoved = false;
  const spawnCwds = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    sourceCommitCheck: () => sourceMoved ? "deadbee" : "c26823c",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: (_command, _args, spawnOptions) => {
      spawned = true;
      sourceMoved = true;
      spawnCwds.push(spawnOptions.cwd);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, true);
  assert.deepEqual(spawnCwds, ["/immutable/repository/apps/worker"]);
});

test("production health recheck requires the canonical URL and security headers", async () => {
  const calls = [];
  const result = await recheckProductionContainment({
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return jsonHealthResponse();
    },
  });
  assert.deepEqual(result, { ok: true, code: null });
  assert.deepEqual(calls.map((call) => call.url), [HEALTH_URL]);
  assert.equal(calls[0].request.headers.accept, "application/json");
});
