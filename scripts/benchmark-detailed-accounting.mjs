import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Protected, local optimization qualification ONLY. This is neither the PR94
// attribution comparator nor an ingestion/companion/end-to-end refresh gate.
// The input must be an offline, checkpointed, read-only private index copy.
// Never discover a corpus, collector state, credentials, or a live app here.
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
// The production parent's publication limit is tighter than child transport.
const MAX_DURABLE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const DAY_MS = 86_400_000;
const SCHEMA = "detailed-accounting-child-benchmark-v1";
const ERROR_CODES = new Set([
  "approval_required", "arguments_invalid", "runtime_invalid", "path_invalid",
  "source_not_clean", "source_changed", "index_invalid", "index_changed",
  "generation_invalid", "policy_mismatch", "command_failed", "command_timeout",
  "command_output_limit", "command_aborted", "metrics_invalid", "envelope_invalid",
  "child_refused", "artifact_invalid", "artifact_mismatch", "receipt_invalid", "resource_limit_exceeded",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function parseDetailedAccountingBenchmarkArguments(argv) {
  if (!argv.includes("--allow-private-index-benchmark")) throw fail("approval_required");
  const flags = new Map([
    ["--baseline-root", "baselineRoot"], ["--candidate-root", "candidateRoot"],
    ["--index", "indexFile"], ["--output-dir", "outputDirectory"],
    ["--now", "now"], ["--window-days", "windowDays"],
    ["--runs", "runs"], ["--timeout-seconds", "timeoutSeconds"],
  ]);
  const parsed = { runs: 3, timeoutSeconds: 900 };
  const seen = new Set();
  for (let offset = 0; offset < argv.length; offset += 1) {
    const flag = argv[offset];
    if (seen.has(flag)) throw fail("arguments_invalid");
    seen.add(flag);
    if (flag === "--allow-private-index-benchmark") continue;
    const key = flags.get(flag);
    const value = argv[++offset];
    if (!key || typeof value !== "string" || value.startsWith("--")) {
      throw fail("arguments_invalid");
    }
    parsed[key] = ["runs", "windowDays", "timeoutSeconds"].includes(key)
      ? (/^[0-9]+$/u.test(value) ? Number(value) : NaN) : value;
  }
  if (!["baselineRoot", "candidateRoot", "indexFile", "outputDirectory", "now"]
    .every((key) => typeof parsed[key] === "string" && parsed[key].length > 0)
      || !integer(parsed.runs, 1, 10) || !integer(parsed.windowDays, 365, 3653)
      || !integer(parsed.timeoutSeconds, 1, 3600)
      || !integer(Date.parse(parsed.now), DAY_MS)
      || new Date(parsed.now).toISOString() !== parsed.now) throw fail("arguments_invalid");
  return {
    ...parsed,
    privateOperationApproved: true,
    baselineRoot: resolve(parsed.baselineRoot), candidateRoot: resolve(parsed.candidateRoot),
    indexFile: resolve(parsed.indexFile), outputDirectory: resolve(parsed.outputDirectory),
    nowMs: Date.parse(parsed.now),
  };
}

/** Bounded capture; raw stderr is private in-memory data, never a diagnostic. */
export function runBoundedBenchmarkCommand(command, args, {
  cwd, env = {}, timeoutMs = 30_000, killGraceMs = 5_000,
  stdoutLimit = MAX_STDOUT_BYTES, stderrLimit = MAX_STDERR_BYTES,
  signal = null, spawnCommand = spawn,
} = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    if (signal?.aborted) return rejectCommand(fail("command_aborted"));
    let child;
    try {
      child = spawnCommand(command, args, {
        cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { return rejectCommand(fail("command_failed")); }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stopped = null;
    let closed = null;
    let graceTimer = null;
    let settled = false;
    const killGroup = (killSignal) => {
      // /usr/bin/time owns a process group containing the production child;
      // terminating time alone could leave accounting running without a bound.
      try { process.kill(-child.pid, killSignal); }
      catch { try { child.kill(killSignal); } catch { /* Already gone. */ } }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer !== null) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", abort);
      child.stdin?.destroy();
      if (stopped !== null) rejectCommand(fail(stopped));
      else if (closed?.code !== 0 || closed?.signal !== null) rejectCommand(fail("command_failed"));
      else resolveCommand({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    };
    const stop = (code) => {
      if (stopped !== null || settled) return;
      stopped = code;
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
      killGroup("SIGTERM");
      // Even when time exits before its child, retain the group kill timer.
      graceTimer = setTimeout(() => { killGroup("SIGKILL"); finish(); }, killGraceMs);
    };
    const abort = () => stop("command_aborted");
    const timeout = setTimeout(() => stop("command_timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin?.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (stopped !== null) return;
      const bytes = Buffer.from(chunk);
      if (stdout.length + bytes.length > stdoutLimit) return stop("command_output_limit");
      stdout = Buffer.concat([stdout, bytes]);
    });
    child.stderr.on("data", (chunk) => {
      if (stopped !== null) return;
      const bytes = Buffer.from(chunk);
      if (stderr.length + bytes.length > stderrLimit) return stop("command_output_limit");
      stderr = Buffer.concat([stderr, bytes]);
    });
    child.once("error", () => stop("command_failed"));
    child.once("close", (code, childSignal) => {
      closed = { code, signal: childSignal };
      if (stopped === null) finish();
    });
  });
}

export function parseMacOsTimeMetrics(stderr) {
  const times = [...stderr.matchAll(/^\s*(\d+(?:\.\d{1,6})?) real\s+(\d+(?:\.\d{1,6})?) user\s+(\d+(?:\.\d{1,6})?) sys\s*$/gmu)];
  const rss = [...stderr.matchAll(/^\s*(\d+)\s+maximum resident set size\s*$/gmu)];
  if (times.length !== 1 || rss.length !== 1) throw fail("metrics_invalid");
  const result = {
    wallMs: Math.round(Number(times[0][1]) * 1000),
    userCpuMs: Math.round(Number(times[0][2]) * 1000),
    systemCpuMs: Math.round(Number(times[0][3]) * 1000),
    peakRssBytes: Number(rss[0][1]),
  };
  if (!Object.values(result).every((value) => integer(value)) || result.peakRssBytes < 1) {
    throw fail("metrics_invalid");
  }
  return result;
}

export function parseSuccessfulAccountingEnvelope(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout.trim()); }
  catch { throw fail("envelope_invalid"); }
  // The production child intentionally exits zero even for a typed refusal.
  if (envelope?.status === "error") throw fail("child_refused");
  if (!exactKeys(envelope, ["status", "resultBytes", "resultSha256"])
      || envelope.status !== "ok" || !integer(envelope.resultBytes, 2, MAX_RESULT_BYTES)
      || !SHA256.test(envelope.resultSha256)) throw fail("envelope_invalid");
  return envelope;
}

async function privateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0) throw fail("path_invalid");
  return stat;
}

async function privateRegularFile(path, { immutable = false, maximumBytes = Infinity } = {}) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (immutable && (stat.mode & 0o222) !== 0)
      || !integer(stat.size, 1) || stat.size > maximumBytes) throw fail("path_invalid");
  return stat;
}

function sameFile(before, after) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid", "nlink"]
    .every((key) => before[key] === after[key]);
}

async function digestFile(path, expectedStat = null) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (expectedStat !== null && !sameFile(before, expectedStat)) throw fail("path_invalid");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))) {
      throw fail("path_invalid");
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}

export async function verifyAccountingBenchmarkArtifact(path, envelope) {
  const stat = await privateRegularFile(path, { maximumBytes: MAX_RESULT_BYTES });
  if (stat.size > MAX_DURABLE_CACHE_BYTES) throw fail("resource_limit_exceeded");
  if (stat.size !== envelope.resultBytes) throw fail("artifact_mismatch");
  const sha256 = await digestFile(path, stat);
  if (sha256 !== envelope.resultSha256) throw fail("artifact_mismatch");
  return { sha256, bytes: stat.size };
}

export async function inspectDetailedAccountingBenchmarkIndex(indexFile) {
  await privateDirectory(dirname(indexFile));
  const stat = await privateRegularFile(indexFile, { immutable: true });
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await lstat(`${indexFile}${suffix}`); throw fail("index_invalid"); }
    catch (error) { if (error.code !== "ENOENT") throw fail("index_invalid"); }
  }
  return stat;
}

async function revisionAt(root) {
  const command = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root, ...args]);
  const revision = (await command(["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (!REVISION.test(revision)) throw fail("source_not_clean");
  if ((await command(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") {
    throw fail("source_not_clean");
  }
  return revision;
}

// Static imports in the spawned module select ONLY two fixed public owners
// below a clean revision root. No source is copied or modified, and no eval
// payload is derived from private data (all private values cross argv).
function probeSource(root, validateArtifact) {
  const accounting = JSON.stringify(pathToFileURL(join(root, "src/replay-safe-accounting-cache.js")).href);
  const index = JSON.stringify(pathToFileURL(join(root, "src/local-unified-index.js")).href);
  return `import { readFile } from 'node:fs/promises';
import { REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY as policy,
 REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION as requestVersion,
 assertReplaySafeAccountingCache } from ${accounting};
import { openLocalUnifiedIndex, readUnifiedIndexGenerationDescriptor } from ${index};
try {
 ${validateArtifact
    ? "assertReplaySafeAccountingCache(JSON.parse(await readFile(process.argv[1], 'utf8'))); process.stdout.write(JSON.stringify({ valid: true }));"
    : "const db = openLocalUnifiedIndex(process.argv[1], { readOnly: true }); try { const generation = readUnifiedIndexGenerationDescriptor(db); process.stdout.write(JSON.stringify({ policy, requestVersion, generation })); } finally { db.close(); }"}
} catch { process.exitCode = 1; }`;
}

async function probe(root, path, validateArtifact, options) {
  let output;
  try {
    output = await runBoundedBenchmarkCommand(process.execPath,
      ["--input-type=module", "--eval", probeSource(root, validateArtifact), path], options);
  } catch (error) {
    if (error.code === "command_failed") throw fail(validateArtifact ? "artifact_invalid" : "generation_invalid");
    throw error;
  }
  try { return JSON.parse(output.stdout); }
  catch { throw fail(validateArtifact ? "artifact_invalid" : "generation_invalid"); }
}

export function projectDetailedAccountingBenchmarkGeneration(generation) {
  // This projection is NOT an accounting-readiness validator. For example,
  // production accepts a tool-only partial publication for accounting. Keep
  // that partial state visible and let the unmodified production child prove
  // accounting coverage; never relabel the database or broaden its reader.
  if (!generation || !["complete", "partial"].includes(generation.status)
      || generation.discoveryComplete !== true || generation.diagnosticsComplete !== true
      || generation.usageProvenanceComplete !== true || generation.sourceOrderComplete !== true
      || generation.quotaProvenanceComplete !== true
      || typeof generation.toolProvenanceComplete !== "boolean"
      || ![null, "tool_provenance_incomplete", "codex_rollout_sources_quarantined"].includes(generation.blockReason)
      || !integer(generation.id, 1)
      || !/^generation-v2-[a-f0-9]{64}$/u.test(generation.fingerprint)) throw fail("generation_invalid");
  const keys = ["indexedSourceCount", "indexedSourceBytes", "skippedSourceCount",
    "skippedSourceBytes", "skippedThreadCount", "usageEvents", "quotaOccurrences", "toolFacts"];
  const result = { id: generation.id, fingerprintSha256: generation.fingerprint.slice(14),
    publicationStatus: generation.status, publicationBlockReason: generation.blockReason,
    toolProvenanceComplete: generation.toolProvenanceComplete };
  for (const key of keys) {
    if (!integer(generation[key])) throw fail("generation_invalid");
    result[key] = generation[key];
  }
  return result;
}

export function validateDetailedAccountingBenchmarkReceipt(receipt) {
  const keys = ["schema", "scope", "runtime", "baselineRevision", "candidateRevision",
    "index", "generation", "clock", "policy", "warmupsPerRevision", "measuredRunsPerRevision",
    "artifact", "runs", "exactOutputMatch", "indexUnchanged", "sourceUnchanged"];
  if (!exactKeys(receipt, keys) || receipt.schema !== SCHEMA
      || receipt.scope !== "isolated_accounting_child_only"
      || !REVISION.test(receipt.baselineRevision) || !REVISION.test(receipt.candidateRevision)
      || !exactKeys(receipt.runtime, ["version", "platform", "arch", "sha256"])
      || receipt.runtime.version !== "v26.2.0" || receipt.runtime.platform !== "darwin"
      || receipt.runtime.arch !== "arm64" || !SHA256.test(receipt.runtime.sha256)
      || !exactKeys(receipt.index, ["sha256", "bytes"]) || !SHA256.test(receipt.index.sha256)
      || !integer(receipt.index.bytes, 1)
      || !exactKeys(receipt.clock, ["nowMs", "windowDays"])
      || !integer(receipt.clock.nowMs, DAY_MS) || !integer(receipt.clock.windowDays, 365, 3653)
      || !exactKeys(receipt.policy, ["maximumRssBytes", "rebuildChildOldSpaceMib"])
      || !integer(receipt.policy.maximumRssBytes, 1) || !integer(receipt.policy.rebuildChildOldSpaceMib, 1)
      || receipt.warmupsPerRevision !== 1 || !integer(receipt.measuredRunsPerRevision, 1, 10)
      || !exactKeys(receipt.artifact, ["sha256", "bytes"]) || !SHA256.test(receipt.artifact.sha256)
      || !integer(receipt.artifact.bytes, 2, MAX_DURABLE_CACHE_BYTES)
      || receipt.exactOutputMatch !== true || receipt.indexUnchanged !== true
      || receipt.sourceUnchanged !== true) throw fail("receipt_invalid");
  const generationKeys = ["id", "fingerprintSha256", "indexedSourceCount", "indexedSourceBytes",
    "skippedSourceCount", "skippedSourceBytes", "skippedThreadCount", "usageEvents", "quotaOccurrences", "toolFacts",
    "publicationStatus", "publicationBlockReason", "toolProvenanceComplete"];
  if (!exactKeys(receipt.generation, generationKeys) || !SHA256.test(receipt.generation.fingerprintSha256)
      || !["complete", "partial"].includes(receipt.generation.publicationStatus)
      || ![null, "tool_provenance_incomplete", "codex_rollout_sources_quarantined"].includes(receipt.generation.publicationBlockReason)
      || typeof receipt.generation.toolProvenanceComplete !== "boolean"
      || !generationKeys.filter((key) => !["fingerprintSha256", "publicationStatus", "publicationBlockReason", "toolProvenanceComplete"].includes(key))
        .every((key) => integer(receipt.generation[key], key === "id" ? 1 : 0))
      || !Array.isArray(receipt.runs) || receipt.runs.length !== 2 * (receipt.measuredRunsPerRevision + 1)) {
    throw fail("receipt_invalid");
  }
  const seen = new Set();
  for (const row of receipt.runs) {
    if (!exactKeys(row, ["side", "run", "warmup", "wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes"])
        || !["baseline", "candidate"].includes(row.side)
        || !integer(row.run, 0, receipt.measuredRunsPerRevision) || row.warmup !== (row.run === 0)
        || !["wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes"].every((key) => integer(row[key]))
        || row.peakRssBytes < 1 || row.peakRssBytes > receipt.policy.maximumRssBytes
        || seen.has(`${row.side}:${row.run}`)) throw fail("receipt_invalid");
    seen.add(`${row.side}:${row.run}`);
  }
  return receipt;
}

export async function runDetailedAccountingBenchmark(options, { signal = null } = {}) {
  if (options?.privateOperationApproved !== true) throw fail("approval_required");
  if (process.version !== "v26.2.0" || process.platform !== "darwin" || process.arch !== "arm64") {
    throw fail("runtime_invalid");
  }
  const roots = { baseline: await realpath(options.baselineRoot), candidate: await realpath(options.candidateRoot) };
  const revisions = { baseline: await revisionAt(roots.baseline), candidate: await revisionAt(roots.candidate) };
  const runtimePath = await realpath(process.execPath);
  const runtimeSha256 = await digestFile(runtimePath);
  const inputStat = await inspectDetailedAccountingBenchmarkIndex(options.indexFile);
  const indexSha256 = await digestFile(options.indexFile, inputStat);
  await privateDirectory(dirname(options.outputDirectory));
  // mkdir, without recursive mode, is the no-clobber reservation.
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const directoryStat = await privateDirectory(options.outputDirectory);
  const emptyCodexHome = join(options.outputDirectory, "empty-codex-home");
  const temporaryDirectory = join(options.outputDirectory, "temporary");
  await mkdir(emptyCodexHome, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const env = { TMPDIR: temporaryDirectory, LC_ALL: "C" };
  const probeOptions = { cwd: options.outputDirectory, env, signal };
  const initial = {};
  for (const side of ["baseline", "candidate"]) {
    initial[side] = await probe(roots[side], options.indexFile, false, probeOptions);
    projectDetailedAccountingBenchmarkGeneration(initial[side].generation);
  }
  if (JSON.stringify(initial.baseline) !== JSON.stringify(initial.candidate)) throw fail("policy_mismatch");
  const { policy, requestVersion, generation } = initial.baseline;
  if (!integer(policy?.rebuildChildOldSpaceMib, 1) || !integer(policy?.maximumRssBytes, 1)
      || requestVersion !== "replay-safe-accounting-rebuild-request-v1") throw fail("policy_mismatch");
  const rows = [];
  let commonArtifact = null;
  for (let run = 0; run <= options.runs; run += 1) {
    // One equal warmup per side; alternate order for measured pairs.
    const sides = run % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const side of sides) {
      if (!sameFile(inputStat, await inspectDetailedAccountingBenchmarkIndex(options.indexFile))) throw fail("index_changed");
      const runDirectory = join(options.outputDirectory, `${side}-${run}`);
      await mkdir(runDirectory, { mode: 0o700 });
      const requestFile = join(runDirectory, "request.json");
      const resultFile = join(runDirectory, "result.json");
      const request = {
        version: requestVersion, nowMs: options.nowMs, windowDays: options.windowDays,
        codexHome: emptyCodexHome, sourceMode: "unified", contextBehavior: "legacy_zero",
        expectedGeneration: generation, unifiedIndexFile: options.indexFile,
        declaredSpeedBaselines: [], transitionResourceLimits: null, maximumRssBytes: policy.maximumRssBytes,
      };
      await writeFile(requestFile, JSON.stringify(request), { mode: 0o600, flag: "wx" });
      const output = await runBoundedBenchmarkCommand("/usr/bin/time", ["-l", process.execPath,
        `--max-old-space-size=${policy.rebuildChildOldSpaceMib}`,
        join(roots[side], "src/replay-safe-accounting-rebuild-child.js"), requestFile, resultFile], {
        cwd: runDirectory, env, signal, timeoutMs: options.timeoutSeconds * 1000,
      });
      const envelope = parseSuccessfulAccountingEnvelope(output.stdout);
      const metrics = parseMacOsTimeMetrics(output.stderr);
      if (metrics.peakRssBytes > policy.maximumRssBytes) throw fail("resource_limit_exceeded");
      const artifact = await verifyAccountingBenchmarkArtifact(resultFile, envelope);
      const validation = await probe(roots[side], resultFile, true, probeOptions);
      if (!exactKeys(validation, ["valid"]) || validation.valid !== true) throw fail("artifact_invalid");
      if (commonArtifact !== null && JSON.stringify(commonArtifact) !== JSON.stringify(artifact)) {
        throw fail("artifact_mismatch");
      }
      commonArtifact = artifact;
      rows.push({ side, run, warmup: run === 0, ...metrics });
    }
  }
  if (!sameFile(inputStat, await inspectDetailedAccountingBenchmarkIndex(options.indexFile))
      || await digestFile(options.indexFile, inputStat) !== indexSha256) throw fail("index_changed");
  if (await digestFile(runtimePath) !== runtimeSha256) throw fail("runtime_invalid");
  for (const side of ["baseline", "candidate"]) {
    if (await revisionAt(roots[side]) !== revisions[side]) throw fail("source_changed");
    if (JSON.stringify(await probe(roots[side], options.indexFile, false, probeOptions))
        !== JSON.stringify(initial[side])) throw fail("index_changed");
  }
  const finalDirectory = await privateDirectory(options.outputDirectory);
  if (finalDirectory.ino !== directoryStat.ino || finalDirectory.dev !== directoryStat.dev) throw fail("path_invalid");
  const receipt = validateDetailedAccountingBenchmarkReceipt({
    schema: SCHEMA, scope: "isolated_accounting_child_only",
    runtime: { version: process.version, platform: process.platform, arch: process.arch,
      sha256: runtimeSha256 },
    baselineRevision: revisions.baseline, candidateRevision: revisions.candidate,
    index: { sha256: indexSha256, bytes: inputStat.size }, generation: projectDetailedAccountingBenchmarkGeneration(generation),
    clock: { nowMs: options.nowMs, windowDays: options.windowDays },
    policy: { maximumRssBytes: policy.maximumRssBytes, rebuildChildOldSpaceMib: policy.rebuildChildOldSpaceMib },
    warmupsPerRevision: 1, measuredRunsPerRevision: options.runs, artifact: commonArtifact,
    runs: rows, exactOutputMatch: true, indexUnchanged: true, sourceUnchanged: true,
  });
  await writeFile(join(options.outputDirectory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600, flag: "wx",
  });
  return receipt;
}

export function detailedAccountingBenchmarkFailure(error) {
  return { schema: SCHEMA, status: "failed",
    code: ERROR_CODES.has(error?.code) ? error.code : "command_failed" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const options = parseDetailedAccountingBenchmarkArguments(process.argv.slice(2));
    const receipt = await runDetailedAccountingBenchmark(options, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(detailedAccountingBenchmarkFailure(error))}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
