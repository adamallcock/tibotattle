import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY } from "../src/replay-safe-accounting-cache.js";
import {
  PR94_PRODUCTION_ERROR_CODES,
  buildPr94ProductionResourceRequest,
  projectPr94ProductionCache,
  runPr94ProductionResourceWorker,
  validatePr94ProductionResourceEvidence,
} from "../scripts/lib/pr94-production-resource-worker.mjs";

// All orchestration adapters below are synthetic. No revision child, real
// database, corpus, native app, credentials or external process is executed.
const START = "2025-08-01T00:00:00.000Z";
const END = "2026-08-01T00:00:00.000Z";
const REVISION = "a".repeat(40);
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
const METADATA = Object.freeze({ policy: POLICY, generation: GENERATION, requestVersion: "replay-safe-accounting-rebuild-request-v1" });
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

async function fixture(action, { encoding = "accounting_compact_v3" } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pr94-production-resource-test-")));
  try {
    const inputDirectory = join(directory, "input");
    await mkdir(inputDirectory, { mode: 0o700 });
    const indexFile = join(inputDirectory, "synthetic.sqlite");
    const input = "synthetic offline index bytes, not SQLite";
    await writeFile(indexFile, input, { mode: 0o400 });
    const options = { privateOperationApproved: true, root: join(directory, "synthetic-source"), expectedRevision: REVISION,
      indexFile, expectedIndex: { sha256: hash(input), bytes: Buffer.byteLength(input), generationId: 44 },
      outputDirectory: join(directory, "output"), startAt: START, endAt: END, timeoutSeconds: 30 };
    const calls = []; const probes = []; const identities = [];
    const artifact = JSON.stringify(cache(encoding));
    const adapters = {
      runtime: RUNTIME,
      inspectSource: async (root) => { identities.push(root); return clone(SOURCE); },
      probe: async (request) => {
        probes.push(request);
        return request.stage === "metadata" ? clone(METADATA)
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

test("orchestration times only two unmodified production child processes, with exact identical requests", async () => {
  await fixture(async ({ options, adapters, calls, probes, identities, directory }) => {
    const receipt = await runPr94ProductionResourceWorker(options, adapters);
    assert.equal(validatePr94ProductionResourceEvidence(receipt), receipt);
    assert.equal(receipt.scope, "isolated_child_repeatability");
    assert.equal(receipt.exactRepeatOutput, true);
    assert.equal(calls.length, 2);
    assert.equal(probes.length, 4);
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
  }, { encoding: "accounting_compact_v2" });
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
    ]) { const changed = clone(good); mutate(changed); assert.throws(() => validatePr94ProductionResourceEvidence(changed)); }
  });
});
