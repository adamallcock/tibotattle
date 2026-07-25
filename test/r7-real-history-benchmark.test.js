import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertR7RealHistorySourcePlanEligibility,
  R7RealHistoryEligibilityError,
  R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES,
  runR7RealHistoryBenchmark,
} from "../src/r7-real-history-benchmark.js";
import { createExportSourcePlanBundle } from "../src/export-source-plan-bundle.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { runR7BenchmarkWorker } from "../src/r7-resource-benchmark.js";
import {
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
  validateR7ReleaseEvidenceReceipt,
} from "../src/r7-release-evidence-schema.js";
import {
  createR7StructuralFixture,
  R7_FIXTURE_END_AT,
  R7_FIXTURE_START_AT,
} from "../src/r7-resource-benchmark-fixture.js";

test("real-history private-plan eligibility fails before worker handoff with a fixed code", () => {
  assert.deepEqual(
    assertR7RealHistorySourcePlanEligibility({
      canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES,
    }),
    { canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES },
  );
  assert.throws(
    () => assertR7RealHistorySourcePlanEligibility({
      canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES + 1,
    }),
    (error) => {
      assert.ok(error instanceof R7RealHistoryEligibilityError);
      assert.equal(error.code, "r7_real_history_source_plan_input");
      assert.equal(/\d{4,}/.test(error.message), false);
      return true;
    },
  );
});

test("one frozen real-history plan drives two content-free passes on the exact child runtime", {
  timeout: 120_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-r7-real-history-test-")));
  const canary = "R7_PRIVATE_POST_FREEZE_APPEND_NEVER_RETAIN";
  try {
    const fixture = await createR7StructuralFixture(root);
    const receipts = await runR7RealHistoryBenchmark({
      startAt: R7_FIXTURE_START_AT,
      endAt: R7_FIXTURE_END_AT,
      runtimeExecutables: [process.execPath],
      temporaryRoot: root,
      timeoutMs: 60_000,
      ...fixture.paths,
      async afterSourcePlanFreeze() {
        await appendFile(fixture.paths.collectorPath, `${JSON.stringify({ canary })}\n`);
        await writeFile(
          join(
            fixture.paths.codexHome,
            "sessions",
            "rollout-2026-07-24T12-59-00-post-freeze.jsonl",
          ),
          `${JSON.stringify({ canary })}\n`,
          { mode: 0o600 },
        );
      },
    });

    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert.equal(validateR7ReleaseEvidenceReceipt(receipt).valid, true);
    assert.equal(receipt.profile, "release_real_local_history");
    assert.equal(receipt.outcome, "partial");
    assert.equal(receipt.network.activity, "not_measured");
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    assert.deepEqual(receipt.runtimeProvenance.runtimeVersion, { major, minor, patch });
    assert.equal(
      receipt.runtimeProvenance.runtimeClass,
      major === 24 ? "pinned_candidate" : "compatibility_crosscheck",
    );
    assert.equal(receipt.operations.length, 10);
    assert.equal(receipt.operations.filter((row) => row.status === "completed").length, 4);
    assert.deepEqual(
      receipt.operations.filter((row) => row.status === "completed").map((row) => row.name),
      ["source_scan", "export_set_materialize", "export_set_verify", "complete_set_delete"],
    );
    assert.equal(receipt.operations.filter((row) => row.status === "not_run").length, 6);
    assert.equal(receipt.boundaries.length, 19);
    assert.equal(receipt.boundaries.every((row) => row.identification === "not_run"), true);
    assert.equal(receipt.determinism.runCount, 2);
    assert.equal(receipt.determinism.status, "passed");
    assert.equal(
      Object.values(receipt.determinism.comparisons).every((value) => value === "matched"),
      true,
    );
    assert.equal(receipt.determinism.runProjectionSha256es[0], receipt.determinism.runProjectionSha256es[1]);
    assert.equal(receipt.profileEvidence.frozenPlanPasses, 2);
    assert.equal(receipt.profileEvidence.rawDurableCopyCreated, false);
    assert.equal(receipt.profileEvidence.prefixMutationResult, "passed");
    assert.equal(receipt.contractProvenance.workloadCodeSha256, R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256);
    assert.equal(receipt.contractProvenance.workloadCodeFileCount, R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT);

    const serialized = JSON.stringify(receipt);
    for (const privateValue of [root, canary, ...Object.values(fixture.paths)]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(serialized), false);
    assert.equal((await readdir(root)).some(
      (name) => name.startsWith("usage-monitor-r7-real-history-"),
    ), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker reports one fixed source-integrity code for prefix mutation, truncation, and replacement", async (t) => {
  for (const scenario of ["mutation", "truncation", "replacement"]) {
    await t.test(scenario, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-r7-integrity-test-")));
      const secret = Buffer.alloc(32, 0x6f);
      try {
        const fixture = await createR7StructuralFixture(root);
        const sourcePlanBundle = await createExportSourcePlanBundle({
          startAt: R7_FIXTURE_START_AT,
          endAt: R7_FIXTURE_END_AT,
          secret,
          resourceGuard: createExportResourceGuard({ scope: "export_set" }),
          ...fixture.paths,
        });
        if (scenario === "mutation") {
          const bytes = await readFile(fixture.paths.collectorPath);
          bytes[0] ^= 0x01;
          await writeFile(fixture.paths.collectorPath, bytes, { mode: 0o600 });
        } else if (scenario === "truncation") {
          await writeFile(fixture.paths.collectorPath, "", { mode: 0o600 });
        } else {
          const replacement = join(root, "replacement-ledger");
          await writeFile(replacement, await readFile(fixture.paths.collectorPath), { mode: 0o600 });
          await rename(replacement, fixture.paths.collectorPath);
        }
        const result = await runR7BenchmarkWorker({
          operation: "source_scan",
          secretHex: secret.toString("hex"),
          startAt: R7_FIXTURE_START_AT,
          endAt: R7_FIXTURE_END_AT,
          createdAt: R7_FIXTURE_END_AT,
          resourceLimits: {},
          workspaceDirectory: join(root, "mutated-workspace"),
          sourcePlanBundle,
        }, { timeoutMs: 60_000 });
        assert.equal(result.status, "failed");
        assert.equal(result.failureCode, "source_integrity");
        assert.equal(JSON.stringify(result).includes(root), false);
      } finally {
        secret.fill(0);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
