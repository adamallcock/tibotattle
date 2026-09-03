import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY } from "../src/replay-safe-accounting-cache.js";
import * as readerModule from "../src/local-unified-accounting-source.js";
import { openLocalUnifiedIndex } from "../src/local-unified-index.js";
import {
  assertPr94ProductionCacheContext,
  PR94_PRODUCTION_ERROR_CODES,
  buildPr94ProductionResourceRequest,
  collectPr94AttributionQueryPlans,
  projectPr94ProductionCache,
  runPr94ProductionResourceWorker,
  validatePr94AttributionQueryPlans,
  validatePr94ProductionResourceEvidence,
  validatePr94ProductionResourceOutcome,
} from "../scripts/lib/pr94-production-resource-worker.mjs";

// All orchestration adapters below are synthetic. No revision child, real
// private database, corpus, native app, credentials or external process is used.
// The query-plan integration test creates its own empty synthetic SQLite index.
const START = "2025-08-01T00:00:00.000Z";
const END = "2026-08-01T00:00:00.000Z";
const REVISION = "a".repeat(40);
const BEFORE_REVISION = "a3c850360bc83c0e27bef2171aeb4a302b72f472";
const AFTER_REVISION = "20f449ff5c222989029fe343f219f02b497ae1d4";
const QUERY_ROLES = ["membership", "same_record_plans", "source_predecessor", "session_predecessor"];
const SHA = "b".repeat(64);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const POLICY = Object.freeze({ maximumRssBytes: 6_442_450_944, rssDeltaBudgetBytes: 5_637_144_576,
  rebuildChildOldSpaceMib: 6144, archiveMaximumRssBytes: 3_221_225_472, archiveRssDeltaBudgetBytes: 805_306_368 });
const GENERATION = Object.freeze({ id: 44, fingerprint: `generation-v2-${SHA}`, status: "partial",
  blockReason: "tool_provenance_incomplete", toolProvenanceComplete: false, discoveryComplete: true,
  diagnosticsComplete: true, usageProvenanceComplete: true, sourceOrderComplete: true, quotaProvenanceComplete: true,
  indexedSourceCount: 3, indexedSourceBytes: 1000, skippedSourceCount: 0, skippedSourceBytes: 0,
  skippedThreadCount: 0, usageEvents: 2, quotaOccurrences: 1, toolFacts: 0 });
function queryPlans(revision = REVISION) {
  return { schema: "pr94-attribution-query-plans-v1", scope: "attribution_point_queries_explain_only", binding: "synthetic",
    status: revision === BEFORE_REVISION ? "feature_absent" : "observed",
    statements: revision === BEFORE_REVISION ? null : Object.fromEntries(QUERY_ROLES.map((role) => [role,
      { steps: 1, search: 1, scan: 0, tempSort: 0, other: 0 }])) };
}
const METADATA = Object.freeze({ policy: POLICY, generation: GENERATION,
  requestVersion: "replay-safe-accounting-rebuild-request-v1", queryPlans: queryPlans() });
const SOURCE = Object.freeze({ revision: REVISION,
  dependencies: { sourceSha256: SHA, runtimeSha256: SHA, lockSha256: SHA, identitySha256: SHA } });
const CONTEXT = Object.freeze({ startAt: START, endAt: END, generationId: 44, generationFingerprint: GENERATION.fingerprint });
const RUNTIME = Object.freeze({ version: "v26.2.0", platform: "darwin", arch: "arm64" });

function cache(encoding = "accounting_compact_v3") {
  return { schemaVersion: encoding === "accounting_compact_v2" ? "local-replay-safe-accounting-v0.13" : "local-replay-safe-accounting-v0.15",
    generatedAt: END, coveredAt: { startAt: START, endAt: END },
    sourceDescriptor: { mode: "unified", contextBehavior: "legacy_zero", generation: "44",
      generationFingerprint: GENERATION.fingerprint, coverageStatus: "complete", generationMatched: true,
      capabilities: { readsRawSources: false } },
    weeklyCalibrationInput: { status: "complete", encoding, source: "unified_index",
      coveredAt: { startAt: START, endAt: END }, retainedUsageEvents: 2, retainedWeeklySnapshots: 1,
      estimatedRetainedBytes: encoding === "accounting_compact_v2" ? 704 : 896,
      limits: { usageEvents: 1_000_000, weeklySnapshots: 1_000_000, combinedInputs: 2_000_000, retainedBytes: 335_544_320 } },
    periods: [{ private: "SYNTHETIC_PRIVATE" }], timeline: [], sparkUsageTimeline: [], quotaTimeline: [], sparkQuotaTimeline: [],
    extraDiagnostic: "SYNTHETIC_PRIVATE" };
}

async function fixture(action, { encoding = "accounting_compact_v3", revision = REVISION } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pr94-production-resource-test-")));
  try {
    const inputDirectory = join(directory, "input");
    await mkdir(inputDirectory, { mode: 0o700 });
    const indexFile = join(inputDirectory, "synthetic.sqlite");
    const input = "synthetic offline index bytes, not SQLite";
    await writeFile(indexFile, input, { mode: 0o400 });
    const options = { privateOperationApproved: true, root: join(directory, "synthetic-source"), expectedRevision: revision,
      indexFile, expectedIndex: { sha256: hash(input), bytes: Buffer.byteLength(input), generationId: 44 },
      outputDirectory: join(directory, "output"), startAt: START, endAt: END, timeoutSeconds: 30 };
    const calls = []; const probes = []; const identities = [];
    const artifact = JSON.stringify(cache(encoding));
    const adapters = {
      runtime: RUNTIME,
      inspectSource: async (root) => { identities.push(root); return { ...clone(SOURCE), revision }; },
      probe: async (request) => {
        probes.push(request);
        return request.stage === "metadata" ? { ...clone(METADATA), queryPlans: queryPlans(revision) }
          : projectPr94ProductionCache(JSON.parse(await readFile(request.path, "utf8")), request.context);
      },
      command: async (command, args, configuration) => {
        calls.push({ command, args, configuration });
        await writeFile(args.at(-1), artifact, { mode: 0o600, flag: "wx" });
        return { stdout: JSON.stringify({ status: "ok", resultBytes: Buffer.byteLength(artifact), resultSha256: hash(artifact) }),
          stderr: "SYNTHETIC_PRIVATE\n 1.25 real 1.01 user 0.04 sys\n 123456789 maximum resident set size\n" };
      },
    };
    await action({ directory, indexFile, options, adapters, calls, probes, identities, artifact });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("production request pins exact child options and rejects unsupported windows without widening", () => {
  const input = { startAt: START, endAt: END, indexFile: "/synthetic/index.sqlite", codexHome: "/synthetic/empty", ...METADATA };
  assert.deepEqual(buildPr94ProductionResourceRequest(input), {
    version: "replay-safe-accounting-rebuild-request-v1", nowMs: Date.parse(END), windowDays: 365,
    codexHome: "/synthetic/empty", sourceMode: "unified", contextBehavior: "legacy_zero",
    expectedGeneration: GENERATION, unifiedIndexFile: "/synthetic/index.sqlite", declaredSpeedBaselines: [],
    transitionResourceLimits: null, maximumRssBytes: POLICY.maximumRssBytes,
  });
  for (const change of [{ startAt: "2026-07-01T00:00:00.000Z" }, { startAt: "2025-08-01T00:00:00.001Z" },
    { endAt: START }, { startAt: "2025-08-01" }, { indexFile: "relative.sqlite" },
    { requestVersion: "other" }, { policy: { ...POLICY, maximumRssBytes: POLICY.maximumRssBytes + 1 } },
    { generation: { ...GENERATION, usageProvenanceComplete: false } }]) {
    assert.throws(() => buildPr94ProductionResourceRequest({ ...input, ...change }));
  }
});

test("production request preserves the reviewed first-parent and current native heap/RSS policy", () => {
  // First-parent a3c8503 and current source both declare 6 GiB absolute,
  // 5.25 GiB delta and ceil(absolute/MiB) child old space. This is the shipped
  // relationship, not a tighter comparator-specific allocation policy.
  assert.equal(REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.maximumRssBytes, POLICY.maximumRssBytes);
  assert.equal(REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.rebuildChildOldSpaceMib, 6144);
  for (const policy of [POLICY, REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY]) {
    const request = buildPr94ProductionResourceRequest({ startAt: START, endAt: END,
      indexFile: "/synthetic/index.sqlite", codexHome: "/synthetic/empty", ...METADATA, policy });
    assert.equal(request.maximumRssBytes, policy.maximumRssBytes);
    assert.equal(policy.rebuildChildOldSpaceMib * 1024 * 1024, request.maximumRssBytes);
    assert.equal(request.transitionResourceLimits, null);
  }
});

test("projection preserves both production compact encodings and reports no raw row material", () => {
  for (const encoding of ["accounting_compact_v2", "accounting_compact_v3"]) {
    const projected = projectPr94ProductionCache(cache(encoding), CONTEXT);
    assert.equal(projected.weeklyInput.encoding, encoding);
    assert.equal(projected.weeklyInput.estimatedRetainedBytes, encoding === "accounting_compact_v2" ? 704 : 896);
    assert.equal(projected.rows.periods, 1);
    assert.equal(projected.source.readsRawSources, false);
    assert.ok(!JSON.stringify(projected).includes("SYNTHETIC_PRIVATE"));
    assert.ok(!JSON.stringify(projected).includes("generationFingerprint"));
  }
});

test("projection rejects wrong clock/generation/source and out-of-budget input counts", () => {
  for (const mutate of [
    (value) => { value.generatedAt = START; },
    (value) => { value.coveredAt.startAt = "2025-07-31T00:00:00.000Z"; },
    (value) => { value.sourceDescriptor.generation = "45"; },
    (value) => { value.sourceDescriptor.generationFingerprint = `generation-v2-${"c".repeat(64)}`; },
    (value) => { value.sourceDescriptor.generationMatched = false; },
    (value) => { value.sourceDescriptor.capabilities.readsRawSources = true; },
    (value) => { value.sourceDescriptor.coverageStatus = "partial"; },
    (value) => { value.weeklyCalibrationInput.retainedUsageEvents = 1_000_001; },
    (value) => { value.weeklyCalibrationInput.retainedWeeklySnapshots = -1; },
    (value) => { value.weeklyCalibrationInput.estimatedRetainedBytes = 335_544_321; },
    (value) => { value.weeklyCalibrationInput.limits.combinedInputs = 2; },
    (value) => { value.weeklyCalibrationInput.limits.retainedBytes = NaN; },
    (value) => { value.weeklyCalibrationInput.encoding = "unknown"; },
    (value) => { value.timeline = null; },
    (value) => { value.schemaVersion = "SYNTHETIC_PRIVATE"; },
  ]) { const value = cache(); mutate(value); assert.throws(() => projectPr94ProductionCache(value, CONTEXT)); }
});

test("historical refusal context guard binds clock and generation without projecting an invalid cache", () => {
  const full = cache();
  const invalid = { generatedAt: full.generatedAt, coveredAt: full.coveredAt,
    sourceDescriptor: full.sourceDescriptor };
  assert.equal(assertPr94ProductionCacheContext(invalid, CONTEXT), undefined);
  assert.throws(() => projectPr94ProductionCache(invalid, CONTEXT));
  for (const mutate of [
    (value) => { value.generatedAt = START; },
    (value) => { value.coveredAt.startAt = END; },
    (value) => { value.coveredAt.endAt = START; },
    (value) => { value.sourceDescriptor.generation = "45"; },
    (value) => { value.sourceDescriptor.generationFingerprint = `generation-v2-${"c".repeat(64)}`; },
    (value) => { delete value.sourceDescriptor; },
  ]) {
    const value = clone(invalid); mutate(value);
    assert.throws(() => assertPr94ProductionCacheContext(value, CONTEXT),
      { code: "pr94_production_cache_context_mismatch" });
  }
});

test("orchestration times only two unmodified production child processes, with exact identical requests", async () => {
  await fixture(async ({ options, adapters, calls, probes, identities, directory }) => {
    const receipt = await runPr94ProductionResourceWorker(options, adapters);
    assert.equal(validatePr94ProductionResourceEvidence(receipt), receipt);
    assert.equal(receipt.schema, "pr94-production-resource-v2");
    assert.equal(receipt.scope, "isolated_child_repeatability");
    assert.equal(receipt.exactRepeatOutput, true);
    assert.equal(calls.length, 2);
    assert.equal(probes.length, 4);
    assert.deepEqual(probes.filter(({ stage }) => stage === "metadata").map(({ context }) => context),
      [{ revision: REVISION, observedAtMs: Date.parse(END) }, { revision: REVISION, observedAtMs: Date.parse(END) }]);
    assert.deepEqual(receipt.queryPlans, queryPlans());
    assert.equal(identities.length, 2);
    const requests = [];
    for (const { command, args, configuration } of calls) {
      assert.equal(command, "/usr/bin/time");
      assert.deepEqual(args.slice(0, 4), ["-l", process.execPath, "--max-old-space-size=6144",
        join(options.root, "src/replay-safe-accounting-rebuild-child.js")]);
      assert.equal(configuration.timeoutMs, 30_000);
      assert.deepEqual(Object.keys(configuration.env).sort(), ["LC_ALL", "TMPDIR"]);
      assert.equal(configuration.env.LC_ALL, "C");
      requests.push(JSON.parse(await readFile(args.at(-2), "utf8")));
    }
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(receipt.runs.map((run) => run.kind), ["primary", "fresh_process_repeat"]);
    assert.deepEqual(receipt.runs[0].metrics, { wallMs: 1250, userCpuMs: 1010, systemCpuMs: 40, peakRssBytes: 123456789 });
    assert.equal(receipt.runs[0].cache.weeklyInput.retainedUsageEvents, 2);
    assert.equal(receipt.generation.publicationStatus, "partial");
    assert.equal(receipt.generation.toolProvenanceComplete, false);
    const output = JSON.stringify(receipt);
    for (const privateText of [directory, "SYNTHETIC_PRIVATE", "sourceLocal", "request.json", "result.json"]) {
      assert.ok(!output.includes(privateText));
    }
    assert.deepEqual(receipt.notMeasured, ["app_no_change_cache_hit", "app_relaunch", "end_to_end_refresh", "cancellation", "evidence_observer_overhead"]);
  });
});

test("baseline compact-v2 child artifacts remain valid in their own lane", async () => {
  await fixture(async ({ options, adapters }) => {
    const receipt = await runPr94ProductionResourceWorker(options, adapters);
    assert.equal(receipt.runs[0].cache.schemaVersion, "local-replay-safe-accounting-v0.13");
    assert.equal(receipt.runs[0].cache.weeklyInput.encoding, "accounting_compact_v2");
    assert.deepEqual(receipt.queryPlans, queryPlans(BEFORE_REVISION));
  }, { encoding: "accounting_compact_v2", revision: BEFORE_REVISION });
});

test("exact historical after may report two deterministic strict cache-invalid assertions without a projection", async () => {
  await fixture(async ({ options, adapters, calls, probes, artifact }) => {
    const original = adapters.probe;
    adapters.probe = async (request) => request.stage === "artifact"
      ? (probes.push(request), { status: "refused", code: "cache_invalid" })
      : original(request);
    const receipt = await runPr94ProductionResourceWorker(options, adapters);
    assert.equal(validatePr94ProductionResourceOutcome(receipt), receipt);
    assert.throws(() => validatePr94ProductionResourceEvidence(receipt));
    assert.equal(receipt.status, "historical_artifact_refused");
    assert.equal(receipt.schema, "pr94-production-resource-v2");
    assert.equal(receipt.revision, AFTER_REVISION);
    assert.equal(calls.length, 2);
    assert.equal(probes.filter(({ stage }) => stage === "artifact").length, 2);
    assert.deepEqual(probes.filter(({ stage }) => stage === "artifact").map(({ context }) => context.revision),
      [AFTER_REVISION, AFTER_REVISION]);
    assert.deepEqual(receipt.runs.map((run) => run.cacheAssertion), [
      { status: "refused", code: "cache_invalid" },
      { status: "refused", code: "cache_invalid" },
    ]);
    assert.ok(receipt.runs.every((run) => !Object.hasOwn(run, "cache")));
    assert.deepEqual(receipt.runs[0].artifact, receipt.runs[1].artifact);
    assert.deepEqual(receipt.runs[0].envelope, receipt.runs[1].envelope);
    assert.equal(receipt.runs[0].artifact.sha256, hash(artifact));
    for (const mutate of [
      (value) => { value.status = "passed"; },
      (value) => { value.revision = REVISION; },
      (value) => { value.runs[0].cacheAssertion.code = "other"; },
      (value) => { value.runs[0].cache = { projected: true }; },
      (value) => { value.runs[1].envelope.resultSha256 = SHA; },
      (value) => { value.raw = "SYNTHETIC_PRIVATE"; },
    ]) {
      const changed = clone(receipt); mutate(changed);
      assert.throws(() => validatePr94ProductionResourceOutcome(changed));
    }
  }, { revision: AFTER_REVISION });
});

test("historical refusal is rejected for other revisions, other codes, mixed runs and nondeterministic artifacts", async () => {
  for (const scenario of ["before_revision", "other_revision", "wrong_code", "mixed", "changed_artifact"]) {
    await fixture(async ({ options, adapters, calls }) => {
      const originalProbe = adapters.probe;
      let artifactProbes = 0;
      adapters.probe = async (request) => {
        if (request.stage !== "artifact") return originalProbe(request);
        artifactProbes += 1;
        if (scenario === "wrong_code") return { status: "refused", code: "accounting_cache_invalid" };
        if (scenario === "mixed" && artifactProbes === 2) return originalProbe(request);
        return { status: "refused", code: "cache_invalid" };
      };
      if (scenario === "changed_artifact") {
        const originalCommand = adapters.command;
        adapters.command = async (...args) => {
          const output = await originalCommand(...args);
          if (calls.length === 2) {
            const changed = `${await readFile(args[1].at(-1), "utf8")} `;
            await writeFile(args[1].at(-1), changed, { mode: 0o600 });
            output.stdout = JSON.stringify({ status: "ok", resultBytes: Buffer.byteLength(changed), resultSha256: hash(changed) });
          }
          return output;
        };
      }
      await assert.rejects(runPr94ProductionResourceWorker(options, adapters));
      assert.equal(calls.length, ["before_revision", "other_revision", "wrong_code"].includes(scenario) ? 1 : 2);
    }, { revision: scenario === "before_revision" ? BEFORE_REVISION
      : scenario === "other_revision" ? REVISION : AFTER_REVISION });
  }
});

test("ordinary strict evidence remains valid for before, after and final revisions", async () => {
  for (const revision of [BEFORE_REVISION, AFTER_REVISION, REVISION]) {
    await fixture(async ({ options, adapters }) => {
      const receipt = await runPr94ProductionResourceWorker(options, adapters);
      assert.equal(Object.hasOwn(receipt, "status"), false);
      assert.equal(validatePr94ProductionResourceEvidence(receipt), receipt);
      assert.equal(validatePr94ProductionResourceOutcome(receipt), receipt);
      assert.ok(receipt.runs.every((run) => Object.hasOwn(run, "cache")
        && !Object.hasOwn(run, "cacheAssertion")));
    }, { revision });
  }
});

test("approval, pinned revision, runtime and expected copied-index identity fail before child execution", async () => {
  for (const mutate of [
    (options) => { options.privateOperationApproved = false; },
    (options) => { options.expectedRevision = "d".repeat(40); },
    (options) => { options.expectedIndex.sha256 = "c".repeat(64); },
    (options) => { options.expectedIndex.bytes += 1; },
    (options) => { options.expectedIndex.generationId += 1; },
    (options) => { options.extra = true; },
    (options) => { options.timeoutSeconds = Infinity; },
  ]) await fixture(async ({ options, adapters, calls }) => {
    mutate(options);
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters));
    assert.equal(calls.length, 0);
  });
  await fixture(async ({ options, adapters, calls }) => {
    await assert.rejects(runPr94ProductionResourceWorker(options, { ...adapters, runtime: { ...RUNTIME, platform: "linux" } }),
      { code: "pr94_production_runtime_invalid" });
    assert.equal(calls.length, 0);
  });
});

test("immutable owner-only copied index and no-clobber output requirements remain enforced", async () => {
  for (const setup of [
    async ({ indexFile }) => chmod(indexFile, 0o600),
    async ({ indexFile }) => chmod(indexFile, 0o444),
    async ({ indexFile }) => writeFile(`${indexFile}-wal`, "synthetic", { mode: 0o600 }),
    async ({ indexFile, directory }) => link(indexFile, join(directory, "hard-link")),
    async ({ indexFile, directory, options }) => { const path = join(directory, "symbolic"); await symlink(indexFile, path); options.indexFile = path; },
    async ({ options }) => mkdir(options.outputDirectory, { mode: 0o700 }),
    async ({ options }) => chmod(dirname(options.outputDirectory), 0o755),
  ]) await fixture(async (context) => {
    await setup(context);
    await assert.rejects(runPr94ProductionResourceWorker(context.options, context.adapters));
    assert.equal(context.calls.length, 0);
  });
});

test("typed child refusal, invalid envelope, peak RSS and artifact mismatch are not success", async () => {
  for (const mutate of [
    (output) => { output.stdout = JSON.stringify({ status: "error", code: "synthetic_budget_miss" }); },
    (output) => { output.stdout = JSON.stringify({ status: "ok", resultBytes: 2, resultSha256: SHA, extra: true }); },
    (output) => { output.stderr = "missing metrics"; },
    (output) => { output.stderr = ` 1 real 1 user 0 sys\n ${POLICY.maximumRssBytes + 1} maximum resident set size\n`; },
    (output) => { const envelope = JSON.parse(output.stdout); envelope.resultSha256 = SHA; output.stdout = JSON.stringify(envelope); },
  ]) await fixture(async ({ options, adapters, calls }) => {
    const original = adapters.command;
    adapters.command = async (...args) => { const output = await original(...args); mutate(output); return output; };
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters));
    assert.equal(calls.length, 1);
  });
});

test("fresh-process repeat must match exact bytes within the lane", async () => {
  await fixture(async ({ options, adapters, calls }) => {
    const original = adapters.command;
    adapters.command = async (...args) => {
      const output = await original(...args);
      if (calls.length === 2) {
        const payload = JSON.stringify({ ...cache(), harmlessSyntheticDifference: true });
        await writeFile(args[1].at(-1), payload, { mode: 0o600 });
        output.stdout = JSON.stringify({ status: "ok", resultBytes: Buffer.byteLength(payload), resultSha256: hash(payload) });
      }
      return output;
    };
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters), { code: "pr94_production_repeat_mismatch" });
  });
});

test("post-run source, dependency, generation and copied-index drift cannot yield a receipt", async () => {
  for (const change of ["source", "dependency", "generation", "index"]) await fixture(async ({ options, adapters }) => {
    if (change === "source" || change === "dependency") {
      let calls = 0;
      adapters.inspectSource = async () => {
        const value = clone(SOURCE);
        if (++calls === 2) {
          if (change === "source") value.revision = "e".repeat(40);
          else value.dependencies.runtimeSha256 = "e".repeat(64);
        }
        return value;
      };
    } else if (change === "generation") {
      const original = adapters.probe; let metadataCalls = 0;
      adapters.probe = async (request) => {
        const value = await original(request);
        if (request.stage === "metadata" && ++metadataCalls === 2) value.generation.id += 1;
        return value;
      };
    } else {
      const original = adapters.command;
      adapters.command = async (...args) => {
        const output = await original(...args);
        await chmod(options.indexFile, 0o600);
        await writeFile(options.indexFile, "synthetic changed index");
        await chmod(options.indexFile, 0o400);
        return output;
      };
    }
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters));
  });
});

test("cancelled work and private exceptions are bounded failures, not cancellation qualification", async () => {
  assert.ok(Object.isFrozen(PR94_PRODUCTION_ERROR_CODES));
  assert.equal(new Set(PR94_PRODUCTION_ERROR_CODES).size, PR94_PRODUCTION_ERROR_CODES.length);
  assert.ok(PR94_PRODUCTION_ERROR_CODES.every((code) => /^pr94_production_[a-z_]+$/u.test(code)));
  assert.ok(PR94_PRODUCTION_ERROR_CODES.includes("pr94_production_index_changed"));
  assert.ok(PR94_PRODUCTION_ERROR_CODES.includes("pr94_production_refused"));
  assert.throws(() => PR94_PRODUCTION_ERROR_CODES.push("pr94_production_private"), TypeError);
  await fixture(async ({ options, adapters, calls }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runPr94ProductionResourceWorker(options, { ...adapters, signal: controller.signal }),
      { code: "pr94_production_cancelled", message: "pr94_production_cancelled" });
    assert.equal(calls.length, 0);
  });
  await fixture(async ({ options, adapters }) => {
    adapters.inspectSource = async () => { throw new Error("SYNTHETIC_PRIVATE_PATH_OR_DIAGNOSTIC"); };
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters),
      { code: "pr94_production_refused", message: "pr94_production_refused" });
  });
  for (const code of ["command_timeout", "command_output_limit", "command_termination_unconfirmed", "dependency_changed"]) {
    assert.ok(PR94_PRODUCTION_ERROR_CODES.includes(`pr94_production_${code}`));
    await fixture(async ({ options, adapters }) => {
      adapters.inspectSource = async () => { throw Object.assign(new Error("SYNTHETIC_PRIVATE"), { code }); };
      await assert.rejects(runPr94ProductionResourceWorker(options, adapters),
        { code: `pr94_production_${code}`, message: `pr94_production_${code}` });
    });
  }
});

test("closed resource receipt rejects unknown keys, fabricated scope, unsafe values and repeat mismatches", async () => {
  await fixture(async ({ options, adapters }) => {
    const good = await runPr94ProductionResourceWorker(options, adapters);
    for (const mutate of [
      (value) => { value.raw = "SYNTHETIC_PRIVATE"; },
      (value) => { value.scope = "end_to_end_refresh"; },
      (value) => { value.runs[0].metrics.sampledRss = true; },
      (value) => { value.runs[0].metrics.peakRssBytes = 0; },
      (value) => { value.runs[0].metrics.wallMs = NaN; },
      (value) => { value.runs[0].artifact.bytes = 16 * 1024 * 1024 + 1; },
      (value) => { value.runs[0].cache.weeklyInput.limits.extra = 1; },
      (value) => { value.runs[0].cache.weeklyInput.retainedUsageEvents = Number.MAX_SAFE_INTEGER + 1; },
      (value) => { value.runs[1].artifact.sha256 = SHA; },
      (value) => { value.runs.pop(); },
      (value) => { value.exactRepeatOutput = false; },
      (value) => { value.indexUnchanged = false; },
      (value) => { value.notMeasured = []; },
      (value) => { value.generation.toolProvenanceComplete = "true"; },
      (value) => { delete value.queryPlans; },
      (value) => { value.queryPlans = queryPlans(BEFORE_REVISION); },
      (value) => { value.queryPlans.statements.membership.sql = "SYNTHETIC_PRIVATE"; },
    ]) { const changed = clone(good); mutate(changed); assert.throws(() => validatePr94ProductionResourceEvidence(changed)); }
  });
});

function explainFixture(details = ["SEARCH synthetic USING INDEX synthetic (key=?)"]) {
  const calls = [];
  return {
    calls,
    options: { readerModule, generationId: 44, observedAtMs: Date.parse(END), revision: REVISION,
      database: { prepare(sql) {
        assert.match(sql, /^EXPLAIN QUERY PLAN\s+SELECT\b/u, "no data SELECT is executed");
        return { *iterate(...parameters) {
          calls.push({ sql, parameters });
          for (const [index, detail] of details.entries()) yield { id: index + 1, parent: 0, notused: 0, detail };
        } };
      } },
    },
  };
}

test("EXPLAIN adapter drives exactly four original public-reader queries using synthetic bindings", () => {
  const fixture = explainFixture(["SEARCH SYNTHETIC_PRIVATE_SEARCH", "SCAN SYNTHETIC_PRIVATE_SCAN",
    "USE TEMP B-TREE FOR ORDER BY SYNTHETIC_PRIVATE_SORT", "SYNTHETIC_PRIVATE_FUTURE_OPERATION"]);
  const evidence = collectPr94AttributionQueryPlans(fixture.options);
  assert.equal(validatePr94AttributionQueryPlans(evidence, REVISION), evidence);
  assert.equal(fixture.calls.length, 4);
  assert.deepEqual(fixture.calls.map(({ parameters }) => parameters.length), [2, 5, 3, 5]);
  assert.deepEqual(Object.keys(evidence.statements), QUERY_ROLES);
  for (const counts of Object.values(evidence.statements)) {
    assert.deepEqual(counts, { steps: 4, search: 1, scan: 1, tempSort: 1, other: 1 });
  }
  assert.ok(fixture.calls.every(({ parameters }) => parameters[0] === 44));
  assert.equal(fixture.calls[1].parameters.at(-1), Date.parse(END));
  assert.equal(fixture.calls[3].parameters.at(-1), Date.parse(END));
  const serialized = JSON.stringify(evidence);
  for (const excluded of ["SYNTHETIC_PRIVATE", "SELECT", "EXPLAIN", "source_local", "source_ordinal",
    "source_offset", "session_local", "parameters", "detail", "index", String(Date.parse(END))]) {
    assert.ok(!serialized.includes(excluded));
  }
});

test("actual SQLite plans compile from the unchanged reader against an immutable synthetic schema-11 index", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pr94-explain-only-test-")));
  const indexFile = join(directory, "synthetic.sqlite");
  let database;
  try {
    openLocalUnifiedIndex(indexFile, { create: true }).close();
    await chmod(indexFile, 0o400);
    const before = await readFile(indexFile);
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    let explained = 0;
    const evidence = collectPr94AttributionQueryPlans({ readerModule, generationId: 44,
      observedAtMs: Date.parse(END), revision: REVISION, database: { prepare(sql) {
        assert.match(sql, /^EXPLAIN QUERY PLAN\s+SELECT\b/u);
        explained += 1;
        return database.prepare(sql);
      } } });
    assert.equal(explained, 4);
    assert.equal(evidence.status, "observed");
    assert.deepEqual(Object.keys(evidence.statements), QUERY_ROLES);
    assert.ok(Object.values(evidence.statements).every((counts) => counts.steps > 0));
    database.close(); database = null;
    assert.deepEqual(await readFile(indexFile), before);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("feature absence is null evidence only at the exact first parent, never after/final zero counters", () => {
  const fixture = explainFixture();
  const evidence = collectPr94AttributionQueryPlans({ ...fixture.options, revision: BEFORE_REVISION, readerModule: {} });
  assert.deepEqual(evidence, queryPlans(BEFORE_REVISION));
  assert.equal(fixture.calls.length, 0);
  assert.equal(validatePr94AttributionQueryPlans(evidence, BEFORE_REVISION), evidence);
  for (const revision of [AFTER_REVISION, REVISION]) {
    assert.throws(() => collectPr94AttributionQueryPlans({ ...fixture.options, revision, readerModule: {} }),
      { code: "pr94_production_query_plan_invalid" });
    assert.throws(() => validatePr94AttributionQueryPlans(evidence, revision));
  }
  assert.throws(() => collectPr94AttributionQueryPlans({ ...fixture.options, revision: BEFORE_REVISION }),
    { code: "pr94_production_query_plan_invalid" });
  assert.throws(() => validatePr94AttributionQueryPlans(queryPlans(), BEFORE_REVISION));
});

test("query-plan shape drift, data-query attempts and private SQLite exceptions refuse with a fixed code", () => {
  for (const mutate of [
    (options) => { options.revision = "unknown"; },
    (options) => { options.generationId = 0; },
    (options) => { options.observedAtMs = NaN; },
    (options) => { options.database.prepare = () => { throw new Error("SYNTHETIC_PRIVATE_SQL_OR_PATH"); }; },
    (options) => { options.database.prepare = () => ({ *iterate() { yield { detail: "SEARCH private" }; } }); },
    (options) => { options.database.prepare = () => ({ *iterate() {} }); },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader({ database }) {
      database.prepare("DELETE FROM synthetic");
    } }; },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader({ database }) {
      for (let index = 0; index < 5; index += 1) database.prepare("SELECT 1");
    } }; },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader({ database }) {
      const statement = database.prepare("SELECT 1");
      return { read() { statement.all(44, Buffer.alloc(32)); } };
    } }; },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader({ database }) {
      const statement = database.prepare("SELECT 1");
      return { read() { statement.get(44); } };
    } }; },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader() { return { read() {} }; } }; },
    (options) => { options.readerModule = { createLocalUnifiedUsageAttributionReader(args) {
      const original = readerModule.createLocalUnifiedUsageAttributionReader(args);
      return { read(row) { original.read(row); original.read(row); } };
    } }; },
  ]) {
    const fixture = explainFixture(); mutate(fixture.options);
    assert.throws(() => collectPr94AttributionQueryPlans(fixture.options),
      { code: "pr94_production_query_plan_invalid", message: "pr94_production_query_plan_invalid" });
  }
});

test("query-plan validator rejects unknown keys, unsafe counts, missing statements and false absence", () => {
  for (const mutate of [
    (value) => { value.raw = "SYNTHETIC_PRIVATE"; },
    (value) => { value.scope = "all_accounting_queries"; },
    (value) => { value.binding = "real_rows"; },
    (value) => { value.status = "feature_absent"; },
    (value) => { value.statements = null; },
    (value) => { delete value.statements.source_predecessor; },
    (value) => { value.statements.full_scan = clone(value.statements.membership); },
    (value) => { value.statements.membership.detail = "SYNTHETIC_PRIVATE"; },
    (value) => { value.statements.membership.steps = 0; },
    (value) => { value.statements.membership.scan = NaN; },
    (value) => { value.statements.membership.scan = Infinity; },
    (value) => { value.statements.membership.scan = -0; },
    (value) => { value.statements.membership.scan = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.statements.membership.steps = 2; },
    (value) => { Object.defineProperty(value.statements.membership, "search", { enumerable: true,
      get() { assert.fail("getter invoked"); } }); },
  ]) {
    const value = queryPlans(); mutate(value);
    assert.throws(() => validatePr94AttributionQueryPlans(value, REVISION));
  }
});

test("query plans are required before timed work and must match the untimed post-run observation", async () => {
  for (const phase of ["initial", "final"]) await fixture(async ({ options, adapters, calls }) => {
    const original = adapters.probe; let metadataCalls = 0;
    adapters.probe = async (request) => {
      const value = await original(request);
      if (request.stage === "metadata") {
        metadataCalls += 1;
        if (phase === "initial") delete value.queryPlans;
        else if (metadataCalls === 2) {
          value.queryPlans.statements.membership.search = 0;
          value.queryPlans.statements.membership.scan = 1;
        }
      }
      return value;
    };
    await assert.rejects(runPr94ProductionResourceWorker(options, adapters),
      { code: phase === "initial" ? "pr94_production_invalid" : "pr94_production_query_plan_changed" });
    assert.equal(calls.length, phase === "initial" ? 0 : 2);
  });
});
