import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  createExportSourcePlanBundle,
  ExportSourcePlanBundleError,
  summarizeExportSourcePlanBundle,
} from "../src/export-source-plan-bundle.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import {
  createR7StructuralFixture,
  R7_FIXTURE_END_AT,
  R7_FIXTURE_SECRET,
  R7_FIXTURE_START_AT,
} from "../src/r7-resource-benchmark-fixture.js";
import { stableJson } from "../src/storage.js";

function guard() {
  return createExportResourceGuard({ scope: "export_set" });
}

async function frozenFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-frozen-bundle-private-")));
  const fixture = await createR7StructuralFixture(root);
  const planningGuard = guard();
  const bundle = await createExportSourcePlanBundle({
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    secret: R7_FIXTURE_SECRET,
    resourceGuard: planningGuard,
    ...fixture.paths,
  });
  return { root, ...fixture, bundle, planningUsage: planningGuard.snapshot() };
}

function workspaceOptions(value, name) {
  return {
    directory: join(value.root, name),
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_END_AT,
    secret: R7_FIXTURE_SECRET,
    sourcePlanBundle: value.bundle,
  };
}

test("one private bundle creates two fresh workspaces from the same frozen prefixes", async () => {
  const value = await frozenFixture();
  try {
    const bundleSummary = summarizeExportSourcePlanBundle(value.bundle);
    assert.equal(bundleSummary.canonicalBytes, Buffer.byteLength(stableJson(value.bundle), "utf8"));
    assert.equal("sourcePlanBundleSha256" in bundleSummary, false);
    assert.equal(bundleSummary.codex.sourceFiles + bundleSummary.claude.sourceFiles, 5);
    assert.equal(
      bundleSummary.codex.sourceBytes + bundleSummary.claude.sourceBytes,
      bundleSummary.sourceBytes,
    );
    assert.equal("prefixPlanSha256" in bundleSummary.codex, false);
    assert.equal("prefixPlanSha256" in bundleSummary.claude, false);
    assert.ok(
      bundleSummary.canonicalBytes < 1024 * 1024,
      "the representative bundle must fit the fixed watchdog stdin limit",
    );
    assert.equal(value.planningUsage.counters.sourceFiles, 5);
    assert.ok(value.planningUsage.counters.sourceBytes > 0);

    // Every enabled surface grows after the single planning pass. New files
    // and bytes are deliberately outside the frozen inventories/prefixes.
    await appendFile(value.paths.collectorPath, "{\"private\":\"POST_FREEZE_COLLECTOR\"}\n");
    await appendFile(value.bundle.codexPlan.sources[0].path, "{\"private\":\"POST_FREEZE_CODEX\"}\n");
    await appendFile(value.bundle.claudeTranscriptPlan.sources[0].path, "{\"private\":\"POST_FREEZE_CLAUDE\"}\n");
    await writeFile(
      join(value.paths.codexHome, "sessions", "rollout-2026-07-24T12-40-00-post-freeze.jsonl"),
      "{\"private\":\"NEW_UNDISCOVERED_CODEX_SOURCE\"}\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(value.paths.claudeProjectsDirectory, "post-freeze.jsonl"),
      "{\"private\":\"NEW_UNDISCOVERED_CLAUDE_SOURCE\"}\n",
      { mode: 0o600 },
    );

    const first = await createLocalExportWorkspace(workspaceOptions(value, "workspace-a"));
    const second = await createLocalExportWorkspace(workspaceOptions(value, "workspace-b"));
    assert.deepEqual(second.status.recordCounts, first.status.recordCounts);
    assert.equal(first.status.scanComplete, true);
    assert.equal(second.status.scanComplete, true);
    assert.equal(first.resourceUsage.counters.sourceFiles, 5);
    assert.equal(second.resourceUsage.counters.sourceFiles, 5);
    assert.equal(first.resourceUsage.counters.sourceBytes, value.planningUsage.counters.sourceBytes);
    assert.equal(second.resourceUsage.counters.sourceBytes, value.planningUsage.counters.sourceBytes);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bundle rejects a mutation inside a frozen prefix with one content-free code", async () => {
  const value = await frozenFixture();
  try {
    const source = value.bundle.codexPlan.sources[0].path;
    const handle = await open(source, "r+");
    try {
      await handle.write(Buffer.from("X"), 0, 1, 0);
    } finally {
      await handle.close();
    }
    await assert.rejects(
      createLocalExportWorkspace(workspaceOptions(value, "mutated-workspace")),
      (error) => error instanceof ExportSourcePlanBundleError
        && error.code === "export_source_plan_bundle_integrity"
        && !error.message.includes(value.root),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bundle rejects wrong interval, hash, and mixed discovery configuration without private details", async () => {
  const value = await frozenFixture();
  try {
    const cases = [
      {
        options: { ...workspaceOptions(value, "wrong-interval"), endAt: "2026-07-24T12:59:59.000Z" },
        code: "export_source_plan_bundle_interval",
      },
      {
        options: {
          ...workspaceOptions(value, "wrong-hash"),
          sourcePlanBundle: { ...value.bundle, sourcePlanBundleSha256: "0".repeat(64) },
        },
        code: "export_source_plan_bundle_hash",
      },
      {
        options: {
          ...workspaceOptions(value, "mixed-config"),
          codexHome: join(value.root, "PRIVATE_SOURCE_CONFIGURATION_CANARY"),
        },
        code: "export_source_plan_bundle_configuration",
      },
    ];
    for (const item of cases) {
      await assert.rejects(createLocalExportWorkspace(item.options), (error) => {
        assert.equal(error.code, item.code);
        assert.equal(error.message.includes(value.root), false);
        assert.equal(error.message.includes("PRIVATE_SOURCE_CONFIGURATION_CANARY"), false);
        assert.equal(error.message.includes(value.syntheticCanary), false);
        return true;
      });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
