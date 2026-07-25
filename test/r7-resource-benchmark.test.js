import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  R7_BENCHMARK_PROTOCOL_VERSION,
  R7_SELECTION_RULE_VERSION,
  cleanupR7OwnedTree,
  inventoryR7OwnedTree,
  runR7BenchmarkWorker,
  runR7SmokeBenchmark,
  runR7SmokeEvidence,
} from "../src/r7-resource-benchmark.js";
import { R7_WORKER_MAXIMUM_STDIN_BYTES } from "../src/r7-worker-watchdog.js";
import { validateR7ResourceBenchmarkReceipt } from "../src/r7-resource-benchmark-schema.js";
import { R7_FIXTURE_VERSION } from "../src/r7-resource-benchmark-fixture.js";
import { runR7ResourceBoundaryMatrix } from "../src/r7-resource-boundaries.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, EXPORT_RESOURCE_POLICY_VERSION } from "../src/export-resource-policy.js";
import {
  fixedOperationFailureCode,
  runR7WorkerOperation,
} from "../scripts/r7-resource-benchmark-worker.js";

test("the supported default suite keeps resource evidence serial", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.test, "node --test --test-concurrency=1");
});

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

test("R7 worker retains allow-listed subsystem codes and discards arbitrary errors", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-fixed-code-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await runR7WorkerOperation({
    operation: "export_set_materialize",
    secretHex: "11".repeat(32),
    workspaceDirectory: join(parent, "missing-workspace"),
    outputDirectory: join(parent, "output"),
    resourceLimits: {},
  });
  assert.equal(result.status, "failed");
  assert.match(result.failureCode, /^export_workspace_[a-z_]+$/u);
  assert.equal(JSON.stringify(result).includes(parent), false);
  assert.equal(
    fixedOperationFailureCode(new Error("Privacy export-set manifest failed validation (private)")),
    "internal_export_set_manifest_validation",
  );
  assert.equal(
    fixedOperationFailureCode(new Error(
      "Privacy verification failed closed (schema_allowlist, provider_adapter_compatibility; sensitive=web_url)",
    )),
    "internal_bundle_privacy_schema_allowlist_and_provider_adapter_compatibility_sensitive_web_url",
  );
  assert.equal(
    fixedOperationFailureCode(new Error("PRIVATE_ARBITRARY_FAILURE")),
    "operation_failed",
  );
});

test("R7 boundary matrix proves every guard ceiling or labels the unexercised SQLite batch limit", () => {
  const value = runR7ResourceBoundaryMatrix();
  assert.equal(value.resourcePolicyVersion, EXPORT_RESOURCE_POLICY_VERSION);
  assert.equal(value.rows.length, Object.keys(DEFAULT_EXPORT_RESOURCE_LIMITS).length);
  assert.equal(new Set(value.rows.map((row) => row.dimension)).size, value.rows.length);
  for (const row of value.rows) {
    assert.equal(row.policyLimit > 0, true);
    if (row.dimension === "sqlite_batch_records") {
      assert.deepEqual(
        [row.atLimit, row.plusOne, row.producer, row.identificationStatus],
        ["not_run", "not_run", "not_run", "not_identified"],
      );
      continue;
    }
    assert.equal(row.producer, "not_run", row.dimension);
    assert.equal(row.verifier, "not_run", row.dimension);
    assert.equal(row.atLimit, "passed", row.dimension);
    assert.equal(row.plusOne, "rejected", row.dimension);
    assert.match(row.failureCode, /^export_resource_[a-z_]+$/);
  }
});

test("R7 isolated lifecycle smoke is two-pass deterministic and content-free", { timeout: 30_000 }, async () => {
  const value = await runR7SmokeEvidence();
  assert.equal(value.benchmarkProtocolVersion, R7_BENCHMARK_PROTOCOL_VERSION);
  assert.equal(value.selectionRuleVersion, R7_SELECTION_RULE_VERSION);
  assert.equal(value.fixtureVersion, R7_FIXTURE_VERSION);
  assert.match(value.fixtureManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.determinism.runCount, 2);
  assert.equal(value.determinism.passed, true);
  assert.equal(value.determinism.status, "passed");
  assert.deepEqual(value.determinism.runProjectionSha256es, [
    value.first.deterministicProjectionSha256,
    value.second.deterministicProjectionSha256,
  ]);
  assert.equal(Object.values(value.determinism.checks).every((status) => status === "matched"), true);
  assert.equal(value.cleanup.exhausted, true);
  assert.deepEqual(value.first.operations.map((row) => row.operation), EXPECTED_OPERATIONS);
  assert.deepEqual(value.second.operations.map((row) => row.operation), EXPECTED_OPERATIONS);
  for (const pass of [value.first, value.second]) {
    assert.equal(pass.fixturePreserved, true);
    for (const operation of pass.operations) {
      assert.equal(operation.status, "completed", operation.operation);
      assert.equal(operation.failureCode, null);
      assert.equal(Number.isSafeInteger(operation.wallTimeMicros), true);
      assert.equal(Number.isSafeInteger(operation.cpuUserMicros), true);
      assert.equal(Number.isSafeInteger(operation.cpuSystemMicros), true);
      assert.equal(Number.isSafeInteger(operation.peakRssBytes), true);
      assert.equal(Number.isSafeInteger(operation.parentElapsedMs), true);
      assert.equal(operation.parentElapsedMs >= 0, true);
      assert.equal(Number.isSafeInteger(operation.externalPeakRssBytes), true);
      assert.equal(Number.isSafeInteger(operation.rssSampleCount), true);
      assert.equal(Number.isSafeInteger(operation.rssSampleFailureCount), true);
      assert.match(operation.evidence.operationEvidenceSha256, /^[a-f0-9]{64}$/);
    }
  }
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT"), false);
  assert.equal(serialized.includes("codex-home"), false);
  assert.equal(serialized.includes("claude-projects"), false);
  assert.equal(serialized.includes("workspace-complete"), false);
  assert.equal(serialized.includes(process.env.USER ?? "__missing_user__"), false);
});

test("R7 cleanup refuses a replaced task root instead of inventorying the replacement", { timeout: 30_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-root-race-"));
  try {
    await assert.rejects(
      runR7SmokeEvidence({
        temporaryRoot: parent,
        async cleanupFailpoint(created) {
          await rename(created, `${created}-displaced`);
          await mkdir(created, { mode: 0o700 });
        },
      }),
      /temporary root identity changed/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("R7 exact cleanup rejects same-content file identity replacement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-file-race-"));
  const root = join(parent, "task-root");
  try {
    await mkdir(root, { mode: 0o700 });
    const rootStats = await lstat(root);
    const path = join(root, "large-derived-file");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const expected = await inventoryR7OwnedTree(root);
    await rename(path, join(parent, "displaced"));
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    await assert.rejects(
      cleanupR7OwnedTree(root, expected, { dev: rootStats.dev, ino: rootStats.ino }),
      /inventory changed before cleanup/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("extended worker stdin is restricted to frozen real source-plan scans", async () => {
  for (const config of [
    { operation: "export_set_verify", sourcePlanBundle: {} },
    { operation: "source_scan" },
  ]) {
    await assert.rejects(
      runR7BenchmarkWorker(config, { maximumStdinBytes: R7_WORKER_MAXIMUM_STDIN_BYTES }),
      /restricted to real source-plan scans/,
    );
  }
});

test("R7 benchmark worker enforces its terminal lifetime RSS high-water mark", { timeout: 10_000 }, async () => {
  await assert.rejects(
    runR7BenchmarkWorker({
      operation: "export_set_materialize",
      secretHex: "11".repeat(32),
      workspaceDirectory: join(tmpdir(), "usage-monitor-r7-missing-workspace"),
      outputDirectory: join(tmpdir(), "usage-monitor-r7-unused-output"),
      resourceLimits: {},
    }, { maximumRssBytes: 1 }),
    /R7 operation worker stopped: rss_limit_exceeded/,
  );
});

test("R7 smoke benchmark emits a strict self-hashed honest receipt", { timeout: 30_000 }, async () => {
  const receipt = await runR7SmokeBenchmark();
  assert.deepEqual(validateR7ResourceBenchmarkReceipt(receipt), { valid: true, errors: [] });
  assert.equal(receipt.profile, "smoke");
  assert.equal(receipt.classification, "synthetic_lifecycle");
  assert.equal(receipt.networkActivity, "not_measured");
  assert.equal(receipt.runtimeProvenance.rssMeasurementMethod, "external_sampling");
  assert.equal(receipt.runtimeProvenance.rssSamplingIntervalMs, 100);
  assert.equal(receipt.operations.every((row) => row.metrics.parentElapsedMs > 0), true);
  assert.equal(receipt.determinismEvidence.status, "passed");
  assert.equal(receipt.operations.filter((row) => row.status === "completed").length, 7);
  assert.equal(receipt.operations.filter((row) => row.status === "interrupted_recovered").length, 3);
  assert.equal(receipt.operations.filter((row) => row.status === "not_run").length, 0);
  assert.equal(receipt.operations.every((row) => row.evidenceSha256.length === 2), true);
  assert.equal(receipt.boundaryEvidence.filter((row) => row.identification === "identified").length, 0);
  assert.equal(receipt.boundaryEvidence.filter((row) => row.identification === "not_identified").length, 18);
  assert.equal(receipt.boundaryEvidence.filter((row) => row.identification === "not_run").length, 1);
  assert.equal(receipt.boundaryEvidence.every((row) => row.producer.status === "not_run"), true);
  assert.equal(receipt.boundaryEvidence.every((row) => row.verifier.status === "not_run"), true);
  assert.equal(receipt.callbackSettingsPreserved, true);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
});
