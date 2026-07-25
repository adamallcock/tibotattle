import test from "node:test";
import assert from "node:assert/strict";
import {
  buildR7ReleaseSyntheticReceipt,
  R7_RELEASE_SYNTHETIC_EVIDENCE_VERSION,
  runR7ReleaseSyntheticEvidence,
} from "../src/r7-release-synthetic-evidence.js";
import { validateR7ReleaseEvidenceReceipt } from "../src/r7-release-evidence-schema.js";

const EXPECTED_OPERATIONS = [
  "source_scan",
  "checkpoint_resume",
  "export_set_materialize",
  "export_set_verify",
  "workspace_discard",
  "workspace_discard_recovery",
  "claude_callback_uninstall",
  "claude_callback_recovery",
  "complete_set_delete_recovery",
  "complete_set_delete",
];

test("R7 release semantics evidence is two-pass deterministic, bounded, and content-free", {
  timeout: 60_000,
}, async () => {
  const value = await runR7ReleaseSyntheticEvidence({
    profile: "release_synthetic_semantics",
  });
  assert.equal(value.version, R7_RELEASE_SYNTHETIC_EVIDENCE_VERSION);
  assert.equal(value.profile, "release_synthetic_semantics");
  assert.equal(value.determinism.status, "passed");
  assert.equal(value.passes.length, 2);
  assert.equal(value.passes.every((pass) => pass.operations.length === 10), true);
  for (const pass of value.passes) {
    assert.deepEqual(pass.operations.map((operation) => operation.name), EXPECTED_OPERATIONS);
  }
  assert.equal(value.passes.every((pass) => pass.operations.every(
    (operation) => operation.status === "completed"
      && operation.parentElapsedMs > 0
      && operation.rssSampleCount > 0
      && operation.filesystem.sampledHighWaterBytes >= operation.filesystem.beforeBytes
      && operation.filesystem.sampledHighWaterBytes >= operation.filesystem.afterBytes,
  )), true);
  assert.equal(value.passes.every((pass) => pass.producedChunks <= 16), true);
  assert.equal(value.passes.every(
    (pass) => Object.values(pass.semanticOutcomes.cases).every(Boolean),
  ), true);
  assert.equal(value.passes.every(
    (pass) => /^[a-f0-9]{64}$/u.test(pass.semanticOutcomes.projectionSha256),
  ), true);
  assert.equal(value.passes.every(
    (pass) => Object.values(pass.preservation).every(Boolean),
  ), true);
  assert.equal(value.cleanup.exhausted, true);
  assert.equal(value.sourceLogsPreserved, true);
  assert.equal(value.transportReady, false);
  const receipt = await buildR7ReleaseSyntheticReceipt(value);
  assert.deepEqual(validateR7ReleaseEvidenceReceipt(receipt), { valid: true, errors: [] });
  assert.equal(receipt.profile, "release_synthetic_semantics");
  assert.equal(receipt.outcome, "partial");
  assert.equal(receipt.network.activity, "not_measured");
  assert.equal(receipt.operations.filter((row) => row.status === "completed").length, 7);
  assert.equal(receipt.operations.filter((row) => row.status === "interrupted_recovered").length, 3);
  assert.equal(receipt.operations.filter((row) => row.status === "not_run").length, 0);
  assert.equal(receipt.operations.filter(
    (row) => row.status === "interrupted_recovered"
      && row.failureCode === "interruption_injected",
  ).length, 3);
  assert.equal(Object.values(receipt.profileEvidence.cases).every(Boolean), true);
  assert.equal(receipt.determinism.status, "passed");
  const serialized = JSON.stringify(value);
  for (const prohibited of [
    "R7_RELEASE_SYNTHETIC_CONTENT_NEVER_EXPORT",
    "sessionId",
    "modelFingerprint",
    "/Users/",
    "/var/",
    "/tmp/",
  ]) assert.equal(serialized.includes(prohibited), false, prohibited);
});

test("R7 release synthetic evidence refuses unsupported profiles and unsafe timeouts", async () => {
  await assert.rejects(
    runR7ReleaseSyntheticEvidence({ profile: "release_real_local_history" }),
    /profile is unsupported/,
  );
  await assert.rejects(
    runR7ReleaseSyntheticEvidence({ profile: "release_synthetic_semantics", timeoutMs: 0 }),
    /outside its fixed range/,
  );
});
