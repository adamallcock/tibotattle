import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { createSourcePlanBundleContext } from "../src/application/export-sources/source-plan-bundle.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  createExportSourcePlanBundle,
  ExportSourcePlanBundleError,
  exportSourcePlanBundleFailureContext,
  resolveExportSourcePlanBundle,
  summarizeExportSourcePlanBundle,
} from "../src/export-source-plan-bundle.js";
import { createExportResourceGuard, ExportResourceLimitError } from "../src/export-resource-policy.js";
import { localExportSourcePipeline as pipeline } from "../src/local-node-runtime.js";
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

function isolatedBundleContext(overrides = {}) {
  const owners = [
    "codexSourcePlan", "codexCollectorExport", "codexCollectorWorkspace",
    "claudeStatusExport", "claudeStatusWorkspace", "claudeTranscriptExport", "claudeTranscriptWorkspace",
  ];
  return createSourcePlanBundleContext({
    bufferByteLength: Buffer.byteLength,
    createHash,
    isProxy,
    resolvePath: resolve,
    normalizeExportBounds(startAt, endAt) {
      return { startAt, endAt, startMs: Date.parse(startAt), endMs: Date.parse(endAt) };
    },
    ...Object.fromEntries(owners.map((owner) => [owner, { ...pipeline[owner], ...overrides[owner] }])),
    ...overrides.ports,
  });
}

function planningOptions(paths, resourceGuard = guard()) {
  return {
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    secret: R7_FIXTURE_SECRET,
    resourceGuard,
    ...paths,
  };
}

function rehashBundle(bundle) {
  const { sourcePlanBundleSha256: ignored, ...payload } = bundle;
  bundle.sourcePlanBundleSha256 = createHash("sha256")
    .update("app-usagemonitor/export-source-plan-bundle/v0.1\0")
    .update(stableJson(payload)).digest("hex");
  return bundle;
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
    const originalBundle = stableJson(value.bundle);
    assert.deepEqual(Object.keys(value.bundle).sort(), [
      "schemaVersion", "startAt", "endAt", "codexPlan", "collectorPlan", "claudeStatusPlan",
      "claudeTranscriptPlan", "sourcePlanBundleSha256",
    ].sort());
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
    assert.deepEqual(Object.keys(bundleSummary).sort(), [
      "schemaVersion", "canonicalBytes", "sourceFiles", "sourceBytes", "codex", "claude",
    ].sort());
    assert.equal(value.bundle.sourcePlanBundleSha256, rehashBundle(structuredClone(value.bundle)).sourcePlanBundleSha256);
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
    assert.equal(stableJson(value.bundle), originalBundle, "diagnostics must not change the frozen capability");
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
      (error) => {
        assert.ok(error instanceof ExportSourcePlanBundleError);
        assert.equal(error.code, "export_source_plan_bundle_integrity");
        assert.equal(error.message, "Local export source-plan bundle failed (integrity)");
        assert.deepEqual(exportSourcePlanBundleFailureContext(error), {
          operation: "verify", source: "codex", reason: "export_source_source_changed",
        });
        assert.equal(error.message.includes(value.root), false);
        return true;
      },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bundle final verification still rejects a mutated prefix after successful lifecycle passes", async () => {
  const value = await frozenFixture();
  try {
    await createLocalExportWorkspace(workspaceOptions(value, "before-final-check-a"));
    await createLocalExportWorkspace(workspaceOptions(value, "before-final-check-b"));
    const handle = await open(value.bundle.codexPlan.sources[0].path, "r+");
    try { await handle.write(Buffer.from("X"), 0, 1, 0); } finally { await handle.close(); }
    await assert.rejects(
      resolveExportSourcePlanBundle(value.bundle, planningOptions(value.paths)),
      (error) => {
        assert.equal(error.code, "export_source_plan_bundle_integrity");
        assert.deepEqual(exportSourcePlanBundleFailureContext(error), {
          operation: "verify", source: "codex", reason: "export_source_source_changed",
        });
        assert.equal(JSON.stringify(exportSourcePlanBundleFailureContext(error)).includes(value.root), false);
        return true;
      },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bundle create and verify contexts identify the actual owning catch stage", async (t) => {
  const value = await frozenFixture();
  const cases = [
    ["codex", "codexSourcePlan", "createCodexExportSourcePlan", "codexSourcePlan",
      "verifyCodexExportSourcePlan", pipeline.codexSourcePlan.ExportSourcePlanError, "source_changed"],
    ["collector", "codexCollectorWorkspace", "createCodexCollectorWorkspaceSource", "codexCollectorExport",
      "verifyCodexCollectorExportSourcePlan", pipeline.codexCollectorExport.CodexCollectorExportSourceError, "source_prefix"],
    ["claude_status", "claudeStatusWorkspace", "createClaudeStatusWorkspaceSource", "claudeStatusExport",
      "verifyClaudeStatusLedgerExportSourcePlan", pipeline.claudeStatusExport.ClaudeStatusLedgerExportSourceError, "record_changed"],
    ["claude_transcript", "claudeTranscriptWorkspace", "createClaudeTranscriptWorkspaceSource", "claudeTranscriptExport",
      "verifyClaudeTranscriptExportSource", pipeline.claudeTranscriptExport.ClaudeTranscriptExportSourceError, "source_changed"],
  ];
  try {
    for (const [source, createOwner, createMethod, verifyOwner, verifyMethod, Owner, reason] of cases) {
      for (const operation of ["create", "verify"]) {
        await t.test(`${operation}:${source}`, async () => {
          const original = new Owner(reason);
          const context = isolatedBundleContext({
            [operation === "create" ? createOwner : verifyOwner]: {
              [operation === "create" ? createMethod : verifyMethod]: async () => { throw original; },
            },
          });
          const pending = operation === "create"
            ? context.createExportSourcePlanBundle(planningOptions(value.paths))
            : context.resolveExportSourcePlanBundle(value.bundle, planningOptions(value.paths));
          await assert.rejects(pending, (error) => {
            assert.ok(error instanceof context.ExportSourcePlanBundleError);
            assert.equal(error.code, "export_source_plan_bundle_integrity");
            assert.equal(error.message, "Local export source-plan bundle failed (integrity)");
            assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
              operation, source, reason: original.code,
            });
            assert.equal(Object.hasOwn(error, "cause"), false);
            return true;
          });
        });
      }
    }
    await t.test("verify:workspace_projection", async () => {
      const original = new pipeline.codexCollectorWorkspace.CodexCollectorWorkspaceSourceError("configuration");
      const context = isolatedBundleContext({
        codexCollectorWorkspace: { appendCodexCollectorWorkspaceSource() { throw original; } },
      });
      await assert.rejects(context.resolveExportSourcePlanBundle(value.bundle, planningOptions(value.paths)), (error) => {
        assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
          operation: "verify", source: "workspace_projection", reason: original.code,
        });
        return true;
      });
    });
    await t.test("summarize:totals", () => {
      const bundle = structuredClone(value.bundle);
      bundle.codexPlan.sources[0].prefixBytes = Number.MAX_SAFE_INTEGER;
      rehashBundle(bundle);
      assert.throws(() => summarizeExportSourcePlanBundle(bundle), (error) => {
        assert.ok(error instanceof ExportSourcePlanBundleError);
        assert.equal(error.code, "export_source_plan_bundle_integrity");
        assert.deepEqual(exportSourcePlanBundleFailureContext(error), {
          operation: "summarize", source: "totals", reason: "export_source_plan_bundle_integrity",
        });
        return true;
      });
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bundle failures never evaluate foreign error getters or Proxies and redact unknown reasons", async () => {
  const canary = "PRIVATE_ERROR_CONTENT_PATH_SECRET_CANARY";
  let touched = 0;
  const hostile = {};
  for (const key of ["name", "code", "message", "stack", "cause", "context"]) {
    Object.defineProperty(hostile, key, { get() { touched += 1; throw new Error(canary); } });
  }
  const codeGetter = new pipeline.codexSourcePlan.ExportSourcePlanError("source_prefix");
  Object.defineProperty(codeGetter, "code", { get() { touched += 1; throw new Error(canary); } });
  const poisonedCode = new pipeline.codexSourcePlan.ExportSourcePlanError("source_prefix");
  poisonedCode.code = canary;
  const foreignNamed = Object.assign(new Error(canary), {
    name: "ExportResourceLimitError", code: "export_resource_elapsed_time",
  });
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error(canary); },
    getPrototypeOf() { touched += 1; throw new Error(canary); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error(canary); },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let deepPrototype = null;
  for (let depth = 0; depth < 128; depth += 1) deepPrototype = Object.create(deepPrototype);
  for (const original of [new Error(canary), canary, null, hostile, proxy, revoked.proxy, codeGetter, poisonedCode, foreignNamed, deepPrototype]) {
    const context = isolatedBundleContext({
      codexSourcePlan: { async createCodexExportSourcePlan() { throw original; } },
    });
    await assert.rejects(context.createExportSourcePlanBundle(planningOptions({ codexHome: "/synthetic-unused" })), (error) => {
      assert.equal(error.code, "export_source_plan_bundle_integrity");
      assert.equal(error.message, "Local export source-plan bundle failed (integrity)");
      assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
        operation: "create", source: "codex", reason: "unknown",
      });
      assert.equal(JSON.stringify(error).includes(canary), false);
      assert.equal(JSON.stringify(context.exportSourcePlanBundleFailureContext(error)).includes(canary), false);
      return true;
    });
  }
  assert.equal(touched, 0);
});

test("summary preserves its existing resource-error wrapping and fixed primary message", async () => {
  const value = await frozenFixture();
  try {
    const original = new ExportResourceLimitError("elapsed_time", { observed: 11, limit: 10 });
    const context = isolatedBundleContext({ ports: { bufferByteLength() { throw original; } } });
    assert.throws(() => context.summarizeExportSourcePlanBundle(value.bundle), (error) => {
      assert.notEqual(error, original);
      assert.ok(error instanceof context.ExportSourcePlanBundleError);
      assert.equal(error.code, "export_source_plan_bundle_integrity");
      assert.equal(error.message, "Local export source-plan bundle failed (integrity)");
      assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
        operation: "summarize", source: "totals", reason: "export_resource_elapsed_time",
      });
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("context readers ignore forged mutable properties and expose only immutable observed context", async () => {
  let touched = 0;
  const forged = new ExportSourcePlanBundleError("integrity", {
    get operation() { touched += 1; throw new Error("PRIVATE_CONTEXT_CANARY"); },
  });
  Object.defineProperty(forged, "context", { get() { touched += 1; throw new Error("PRIVATE_CONTEXT_CANARY"); } });
  assert.equal(exportSourcePlanBundleFailureContext(forged), null);
  assert.equal(exportSourcePlanBundleFailureContext({ context: { operation: "private", source: "private", reason: "private" } }), null);
  assert.equal(exportSourcePlanBundleFailureContext(new Proxy({}, {
    get() { touched += 1; throw new Error("PRIVATE_CONTEXT_CANARY"); },
  })), null);
  const context = isolatedBundleContext({
    codexSourcePlan: { async createCodexExportSourcePlan() { throw new Error("PRIVATE_CONTEXT_CANARY"); } },
  });
  await assert.rejects(context.createExportSourcePlanBundle(planningOptions({ codexHome: "/synthetic-unused" })), (error) => {
    const originalContext = context.exportSourcePlanBundleFailureContext(error);
    error.context = { operation: "private", source: "private", reason: "private" };
    assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
      operation: "create", source: "codex", reason: "unknown",
    });
    assert.equal(Object.isFrozen(originalContext), true);
    assert.throws(() => { originalContext.reason = "private"; }, TypeError);
    assert.equal(exportSourcePlanBundleFailureContext(error), null, "a separate owner cannot claim another context's error");
    return true;
  });
  assert.equal(touched, 0);
});

test("create and verify preserve genuine resource errors and totals provenance without wrapping", async () => {
  const value = await frozenFixture();
  try {
    for (const operation of ["create", "verify"]) {
      for (const source of ["codex", "totals"]) {
        const original = new ExportResourceLimitError("elapsed_time", { observed: 11, limit: 10 });
        const context = isolatedBundleContext(source === "codex" ? {
          codexSourcePlan: {
            [operation === "create" ? "createCodexExportSourcePlan" : "verifyCodexExportSourcePlan"]: async () => { throw original; },
          },
        } : {});
        const resourceGuard = guard();
        if (source === "totals") resourceGuard.observeSourcePlan = () => { throw original; };
        const options = planningOptions(value.paths, resourceGuard);
        await assert.rejects(operation === "create"
          ? context.createExportSourcePlanBundle(options)
          : context.resolveExportSourcePlanBundle(value.bundle, options), (error) => {
          assert.equal(error, original);
          assert.equal(error.code, "export_resource_elapsed_time");
          assert.equal(error.message, "Local export stopped at the elapsed_time resource limit");
          assert.equal(error.observed, 11);
          assert.equal(error.limit, 10);
          assert.deepEqual(context.exportSourcePlanBundleFailureContext(error), {
            operation, source, reason: "export_resource_elapsed_time",
          });
          return true;
        });
      }
    }
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
