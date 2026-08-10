import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createStagingDeploymentIdentity,
  DEFAULT_DEPLOYMENT_PROOF_MAX_AGE_MS,
  DEPLOYMENT_PROOF_SCHEMA_VERSION,
  STAGING_DISABLED_WORKER_PROOF_OPERATION,
  readDeploymentProof,
  readStagingDeploymentIdentity,
  validateOwnerOnlyRegularFileMetadata,
  validateDeploymentProof,
} from "./deployment-proof.mjs";

const NOW = Date.parse("2026-08-04T20:00:00.000Z");
const SOURCE_COMMIT = "c26823c";
const STAGING_ORIGIN = "https://app-usagemonitor-staging.workers.dev";

function stagingIdentity() {
  return createStagingDeploymentIdentity({
    origin: STAGING_ORIGIN,
    sourceCommit: SOURCE_COMMIT,
    generatedAt: new Date(NOW - 1_000).toISOString(),
  });
}

function workerEvidence() {
  return {
    ownerObservedRemoteRevision: true,
    ownerObservedDisabledMode: true,
    ownerObservedContainment: true,
    ownerObservedCanonicalTarget: true,
  };
}

function stagingProof(overrides = {}) {
  return {
    schemaVersion: DEPLOYMENT_PROOF_SCHEMA_VERSION,
    operation: STAGING_DISABLED_WORKER_PROOF_OPERATION,
    environment: "staging",
    channel: "staging",
    phase: "pre_migration_compatibility",
    observedAt: new Date(NOW - 1_000).toISOString(),
    target: { origin: STAGING_ORIGIN },
    worker: {
      revision: "staging-revision-0001",
      sourceCommit: SOURCE_COMMIT,
      enrollmentMode: "disabled",
      collectionControls: "contained",
    },
    evidence: workerEvidence(),
    deploymentIdentity: {
      schemaVersion: stagingIdentity().schemaVersion,
      intentId: stagingIdentity().intentId,
      sha256: stagingIdentity().sha256,
    },
    ...overrides,
  };
}

test("staging proof requires the observed compatible disabled revision", () => {
  const result = validateDeploymentProof({
    proof: stagingProof(),
    kind: "staging",
    expectedOrigin: STAGING_ORIGIN,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedDeploymentIdentity: stagingIdentity(),
    now: NOW,
  });
  assert.equal(result.ok, true);
});

test("staging proof rejects absent, stale, malformed, mismatched, or open evidence", () => {
  const cases = [
    [null, "DEPLOYMENT_PROOF_MALFORMED"],
    [stagingProof({ observedAt: new Date(NOW - DEFAULT_DEPLOYMENT_PROOF_MAX_AGE_MS - 1).toISOString() }), "DEPLOYMENT_PROOF_MALFORMED"],
    [stagingProof({ worker: { ...stagingProof().worker, enrollmentMode: "open" } }), "DEPLOYMENT_PROOF_MALFORMED"],
    [stagingProof({ target: { origin: "https://tibotattle.com" } }), "STAGING_DISABLED_WORKER_PROOF_MISMATCH"],
    [stagingProof({ worker: { ...stagingProof().worker, sourceCommit: "deadbee" } }), "STAGING_DISABLED_WORKER_PROOF_MISMATCH"],
  ];
  for (const [proof, code] of cases) {
    assert.equal(
      validateDeploymentProof({
        proof,
        kind: "staging",
        expectedOrigin: STAGING_ORIGIN,
        expectedSourceCommit: SOURCE_COMMIT,
        expectedDeploymentIdentity: stagingIdentity(),
        now: NOW,
      }).code,
      code,
    );
  }
});

// Re-pinned 2026-08-07: the production containment receipt was retired by
// docs/governance/2026-08-07-production-deploy-migration-gate.md. The
// "production" proof kind must now fail closed even for a perfectly formed
// proof, so no receipt file can ever re-authorize a production deploy path.
test("production proof kind is retired and fails closed", () => {
  const result = validateDeploymentProof({
    proof: stagingProof(),
    kind: "production",
    expectedSourceCommit: SOURCE_COMMIT,
    now: NOW,
  });
  assert.deepEqual(result, {
    ok: false,
    code: "DEPLOYMENT_PROOF_KIND_INVALID",
  });
});

// Re-pinned 2026-08-07: the owner-only local-file gate previously carried a
// production containment proof; it now guards only staging receipts
// (docs/governance/2026-08-07-production-deploy-migration-gate.md).
test("proof-file reads only a bounded regular local JSON file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, "staging-proof.json");
  await writeFile(filename, `${JSON.stringify(stagingProof())}\n`, {
    mode: 0o600,
  });
  const result = await readDeploymentProof({
    filename,
    kind: "staging",
    expectedOrigin: STAGING_ORIGIN,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedDeploymentIdentity: stagingIdentity(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("staging identity receipt binds generated origin and owner-observed revision intent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-proof-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, "identity.json");
  await writeFile(filename, `${JSON.stringify(stagingIdentity())}\n`, {
    mode: 0o600,
  });
  const result = await readStagingDeploymentIdentity({
    filename,
    expectedOrigin: STAGING_ORIGIN,
    expectedSourceCommit: SOURCE_COMMIT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.deployment.revisionObserved, false);
  assert.equal(result.identity.deployment.revision, null);
});

// Re-pinned 2026-08-07 from a production containment proof to a staging
// proof payload; the file-safety contract itself is unchanged
// (docs/governance/2026-08-07-production-deploy-migration-gate.md).
test("proof-file rejects group/world-writable files and a wrong owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-proof-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, "proof.json");
  await writeFile(filename, `${JSON.stringify(stagingProof())}\n`, {
    mode: 0o600,
  });
  for (const mode of [0o640, 0o604]) {
    await chmod(filename, mode);
    const result = await readDeploymentProof({
      filename,
      kind: "staging",
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, code: "DEPLOYMENT_PROOF_FILE_UNSAFE" });
  }
  await chmod(filename, 0o600);
  const metadata = await lstat(filename, { bigint: true });
  assert.equal(
    validateOwnerOnlyRegularFileMetadata(metadata, {
      ownerUid: metadata.uid + 1n,
    }),
    false,
  );
});

// Re-pinned 2026-08-07 from a production containment proof to a staging
// proof payload; the symlink/mutation refusals are unchanged
// (docs/governance/2026-08-07-production-deploy-migration-gate.md).
test("proof-file rejects symlinks and detects mutation after the read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-proof-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realFile = join(root, "real-proof.json");
  const linkFile = join(root, "link-proof.json");
  await writeFile(realFile, `${JSON.stringify(stagingProof())}\n`, {
    mode: 0o600,
  });
  try {
    await symlink(realFile, linkFile);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code ?? "unknown"}`);
    return;
  }
  const symlinkResult = await readDeploymentProof({
    filename: linkFile,
    kind: "staging",
    now: NOW,
  });
  assert.deepEqual(symlinkResult, {
    ok: false,
    code: "DEPLOYMENT_PROOF_FILE_UNSAFE",
  });

  const mutationResult = await readDeploymentProof({
    filename: realFile,
    kind: "staging",
    now: NOW,
    afterRead: async () => {
      await writeFile(realFile, "{}\n", { mode: 0o600 });
    },
  });
  assert.deepEqual(mutationResult, {
    ok: false,
    code: "DEPLOYMENT_PROOF_MUTATED",
  });
});
