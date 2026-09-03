import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detailedAccountingBenchmarkFailure,
  digestDetailedAccountingBenchmarkFile,
  inspectDetailedAccountingBenchmarkIndex,
  parseDetailedAccountingBenchmarkArguments,
  parseMacOsTimeMetrics,
  parseSuccessfulAccountingEnvelope,
  projectDetailedAccountingBenchmarkGeneration,
  publishDetailedAccountingBenchmarkReceipt,
  runBoundedBenchmarkCommand,
  runDetailedAccountingBenchmark,
  snapshotDetailedAccountingDependencies,
  validateDetailedAccountingDependencyPair,
  validateDetailedAccountingBenchmarkReceipt,
  verifyAccountingBenchmarkArtifact,
} from "../scripts/benchmark-detailed-accounting.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const approvedArgs = ["--allow-private-index-benchmark", "--baseline-root", "/synthetic/baseline",
  "--candidate-root", "/synthetic/candidate", "--index", "/synthetic/input.sqlite",
  "--output-dir", "/synthetic/output", "--now", "2026-09-02T00:00:00.000Z", "--window-days", "365"];
const codeIs = (code) => (error) => error.code === code && error.message === code;

test("private operation is explicit and argument parsing pins an exact clock and window", async () => {
  assert.throws(() => parseDetailedAccountingBenchmarkArguments([]), codeIs("approval_required"));
  await assert.rejects(runDetailedAccountingBenchmark({}), codeIs("approval_required"));
  const parsed = parseDetailedAccountingBenchmarkArguments(approvedArgs);
  assert.equal(parsed.privateOperationApproved, true);
  assert.equal(parsed.runs, 3);
  assert.equal(parsed.timeoutSeconds, 900);
  assert.equal(parsed.nowMs, Date.parse("2026-09-02T00:00:00.000Z"));
  for (const extra of [["--runs", "0"], ["--runs", "1.5"], ["--runs", "11"],
    ["--timeout-seconds", "3601"], ["--unknown", "secret"], ["--allow-private-index-benchmark"]]) {
    assert.throws(() => parseDetailedAccountingBenchmarkArguments([...approvedArgs, ...extra]), codeIs("arguments_invalid"));
  }
  const withoutWindow = approvedArgs.slice(0, -2);
  for (const value of ["364", "3654", "NaN"]) {
    assert.throws(() => parseDetailedAccountingBenchmarkArguments([...withoutWindow, "--window-days", value]), codeIs("arguments_invalid"));
  }
  const noncanonical = approvedArgs.map((value) => value === "2026-09-02T00:00:00.000Z" ? "2026-09-02" : value);
  assert.throws(() => parseDetailedAccountingBenchmarkArguments(noncanonical), codeIs("arguments_invalid"));
});

test("exit-zero error envelopes and unbounded/noncanonical protocol values are not success", () => {
  assert.throws(() => parseSuccessfulAccountingEnvelope('{"status":"error","code":"budget_miss"}'), codeIs("child_refused"));
  const valid = { status: "ok", resultBytes: 2, resultSha256: hash("{}") };
  assert.deepEqual(parseSuccessfulAccountingEnvelope(`${JSON.stringify(valid)}\n`), valid);
  for (const value of [{ ...valid, path: "private" }, { ...valid, resultBytes: 0 },
    { ...valid, resultBytes: 64 * 1024 * 1024 + 1 }, { ...valid, resultSha256: "secret" }, null]) {
    assert.throws(() => parseSuccessfulAccountingEnvelope(JSON.stringify(value)), codeIs("envelope_invalid"));
  }
  assert.throws(() => parseSuccessfulAccountingEnvelope(`progress\n${JSON.stringify(valid)}`), codeIs("envelope_invalid"));
});

test("macOS time records are parsed without copying other stderr content", () => {
  const input = "private-warning-do-not-emit\n 38.71 real 37.13 user 1.23 sys\n 2400497664 maximum resident set size\n";
  assert.deepEqual(parseMacOsTimeMetrics(input), {
    wallMs: 38710, userCpuMs: 37130, systemCpuMs: 1230, peakRssBytes: 2400497664,
  });
  for (const invalid of ["", input + input, input.replace("38.71", "-1"),
    input.replace("2400497664", "0"), input.replace("2400497664", "9007199254740992")]) {
    assert.throws(() => parseMacOsTimeMetrics(invalid), codeIs("metrics_invalid"));
  }
  assert.doesNotMatch(JSON.stringify(parseMacOsTimeMetrics(input)), /private|warning/u);
});

test("artifact verification hashes independently and refuses links, permissions, size and digest drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-artifact-test-"));
  try {
    const artifact = join(directory, "synthetic.json");
    const envelope = { status: "ok", resultBytes: 2, resultSha256: hash("{}") };
    await writeFile(artifact, "{}", { mode: 0o600 });
    assert.deepEqual(await verifyAccountingBenchmarkArtifact(artifact, envelope), { sha256: hash("{}"), bytes: 2 });
    await assert.rejects(verifyAccountingBenchmarkArtifact(artifact, { ...envelope, resultSha256: hash("[]") }), codeIs("artifact_mismatch"));
    await assert.rejects(verifyAccountingBenchmarkArtifact(artifact, { ...envelope, resultBytes: 3 }), codeIs("artifact_mismatch"));
    const symbolic = join(directory, "symbolic");
    await symlink(artifact, symbolic);
    await assert.rejects(verifyAccountingBenchmarkArtifact(symbolic, envelope), codeIs("path_invalid"));
    const hard = join(directory, "hard");
    await link(artifact, hard);
    await assert.rejects(verifyAccountingBenchmarkArtifact(artifact, envelope), codeIs("path_invalid"));
    await rm(hard);
    await chmod(artifact, 0o644);
    await assert.rejects(verifyAccountingBenchmarkArtifact(artifact, envelope), codeIs("path_invalid"));
    const oversized = join(directory, "oversized.json");
    const handle = await open(oversized, "wx", 0o600);
    try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(verifyAccountingBenchmarkArtifact(oversized, {
      ...envelope, resultBytes: 16 * 1024 * 1024 + 1,
    }), codeIs("resource_limit_exceeded"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("index preflight accepts only owner-only immutable regular snapshots with no SQLite sidecars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-index-test-"));
  try {
    const index = join(directory, "synthetic.sqlite");
    await writeFile(index, "synthetic-not-a-real-index", { mode: 0o400 });
    assert.equal((await inspectDetailedAccountingBenchmarkIndex(index)).size, 26);
    await chmod(index, 0o600);
    await assert.rejects(inspectDetailedAccountingBenchmarkIndex(index), codeIs("path_invalid"));
    await chmod(index, 0o400);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await writeFile(`${index}${suffix}`, "", { mode: 0o600 });
      await assert.rejects(inspectDetailedAccountingBenchmarkIndex(index), codeIs("index_invalid"));
      await rm(`${index}${suffix}`);
    }
    await chmod(directory, 0o755);
    await assert.rejects(inspectDetailedAccountingBenchmarkIndex(index), codeIs("path_invalid"));
    await chmod(directory, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounded command leaves stdin open until the child completes", async () => {
  const output = await runBoundedBenchmarkCommand(process.execPath, ["--input-type=module", "--eval",
    "process.stdin.resume(); process.stdin.on('end', () => process.exit(17)); setTimeout(() => { process.stdout.write('ok'); process.exit(0); }, 20);"],
  { timeoutMs: 5000, killGraceMs: 20 });
  assert.equal(output.stdout, "ok");
});

test("bounded command refuses zero-exit error envelope at the protocol boundary", async () => {
  const output = await runBoundedBenchmarkCommand(process.execPath, ["--eval",
    "process.stdout.write(JSON.stringify({status:'error',code:'synthetic_refusal'}));"], { timeoutMs: 5000 });
  assert.throws(() => parseSuccessfulAccountingEnvelope(output.stdout), codeIs("child_refused"));
});

test("bounded command enforces both stdout and stderr limits and redacts failure details", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(runBoundedBenchmarkCommand(process.execPath, ["--eval",
      `process.${stream}.write('private-secret'.repeat(2000)); setInterval(() => {}, 1000);`],
    { stdoutLimit: 128, stderrLimit: 128, timeoutMs: 5000, killGraceMs: 20 }), codeIs("command_output_limit"));
  }
  await assert.rejects(runBoundedBenchmarkCommand(process.execPath, ["--eval",
    "process.stderr.write('private-secret'); process.exit(42);"], { timeoutMs: 5000 }), codeIs("command_failed"));
  assert.deepEqual(detailedAccountingBenchmarkFailure(new Error("private-secret")), {
    schema: "detailed-accounting-child-benchmark-v2", status: "failed", code: "command_failed",
  });
});

test("bounded command times out an uncooperative child and honors cancellation", async () => {
  await assert.rejects(runBoundedBenchmarkCommand(process.execPath, ["--eval",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { timeoutMs: 80, killGraceMs: 20 }), codeIs("command_timeout"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runBoundedBenchmarkCommand(process.execPath, [], { signal: controller.signal }), codeIs("command_aborted"));
});

test("hash cancellation stops on the first observed chunk rather than finishing the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-hash-abort-test-"));
  try {
    const file = join(directory, "synthetic-bytes");
    await writeFile(file, Buffer.alloc(256 * 1024, 7), { mode: 0o600 });
    const controller = new AbortController();
    let chunks = 0;
    await assert.rejects(digestDetailedAccountingBenchmarkFile(file, null, {
      signal: controller.signal,
      onChunk: () => { chunks += 1; controller.abort(); },
    }), codeIs("command_aborted"));
    assert.equal(chunks, 1);
    assert.equal(await digestDetailedAccountingBenchmarkFile(file), hash(Buffer.alloc(256 * 1024, 7)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation of a live command terminates the child before the test ends", async () => {
  const controller = new AbortController();
  let closed;
  let closeObserved = false;
  await assert.rejects(runBoundedBenchmarkCommand(process.execPath, ["--eval",
    "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], {
    signal: controller.signal, timeoutMs: 5000, killGraceMs: 20,
    spawnCommand: (...args) => {
      const child = spawn(...args);
      closed = new Promise((resolveClosed) => child.once("close", (code, signal) => {
        closeObserved = true;
        resolveClosed({ code, signal });
      }));
      child.stdout.once("data", () => controller.abort());
      return child;
    },
  }), (error) => {
    assert.equal(closeObserved, true, "command must not settle before its direct child's close event");
    return codeIs("command_aborted")(error);
  });
  assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
});

test("a missing close after escalation is reported as unconfirmed termination, not successful cancellation", async () => {
  const child = new EventEmitter();
  child.stdin = { on() {}, destroy() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => false;
  await assert.rejects(runBoundedBenchmarkCommand("synthetic-never-spawned", [], {
    spawnCommand: () => child, timeoutMs: 1, killGraceMs: 1,
  }), codeIs("command_termination_unconfirmed"));
  assert.equal(detailedAccountingBenchmarkFailure({ code: "command_termination_unconfirmed" }).code,
    "command_termination_unconfirmed");
});

test("late cancellation cannot publish a success receipt or overwrite an existing receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-publish-abort-test-"));
  try {
    const controller = new AbortController();
    await assert.rejects(publishDetailedAccountingBenchmarkReceipt(directory, syntheticReceipt(), {
      signal: controller.signal, beforePublish: () => controller.abort(),
    }), codeIs("command_aborted"));
    await assert.rejects(readFile(join(directory, "receipt.json")), (error) => error.code === "ENOENT");
    const duringWrite = new AbortController();
    await assert.rejects(publishDetailedAccountingBenchmarkReceipt(directory, syntheticReceipt(), {
      signal: duringWrite.signal, afterWrite: () => duringWrite.abort(),
    }), codeIs("command_aborted"));
    await assert.rejects(readFile(join(directory, "receipt.json")), (error) => error.code === "ENOENT");
    await publishDetailedAccountingBenchmarkReceipt(directory, syntheticReceipt());
    const original = await readFile(join(directory, "receipt.json"));
    await assert.rejects(publishDetailedAccountingBenchmarkReceipt(directory, syntheticReceipt()),
      (error) => error.code === "EEXIST");
    assert.deepEqual(await readFile(join(directory, "receipt.json")), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function syntheticDependencyRevision(directory, side) {
  const root = join(directory, side);
  const runtime = join(root, "node_modules/.pnpm/synthetic-runtime@1.0.0/node_modules/synthetic-runtime");
  const git = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root, ...args], {
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  for (const child of ["src", "packages/accounting", "node_modules/@app-usagemonitor",
    "node_modules/.pnpm/synthetic-runtime@1.0.0/node_modules/synthetic-runtime"]) {
    await mkdir(join(root, child), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(root, ".gitignore"), "node_modules/\n", { mode: 0o600 });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "synthetic-benchmark", type: "module",
    dependencies: { "@app-usagemonitor/accounting": "workspace:*", "synthetic-runtime": "1.0.0" } }), { mode: 0o600 });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  synthetic-runtime@1.0.0:\n    resolution: {}\nsnapshots:\n  synthetic-runtime@1.0.0: {}\n", { mode: 0o600 });
  await writeFile(join(root, "src/replay-safe-accounting-rebuild-child.js"),
    "import '@app-usagemonitor/accounting'; import 'synthetic-runtime'; throw new Error('must not execute product modules');\n", { mode: 0o600 });
  await writeFile(join(root, "packages/accounting/package.json"), JSON.stringify({ name: "@app-usagemonitor/accounting",
    version: "1.0.0", type: "module", exports: { ".": { import: "./index.js", default: "./index.js" } } }), { mode: 0o600 });
  await writeFile(join(root, "packages/accounting/index.js"),
    "export const synthetic = true; throw new Error('must not execute workspace modules');\n", { mode: 0o600 });
  await symlink("../../packages/accounting", join(root, "node_modules/@app-usagemonitor/accounting"));
  await symlink(".pnpm/synthetic-runtime@1.0.0/node_modules/synthetic-runtime", join(root, "node_modules/synthetic-runtime"));
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "synthetic-runtime", version: "1.0.0",
    type: "module", exports: { import: "./index.js", require: "./require.cjs" } }), { mode: 0o600 });
  await writeFile(join(runtime, "index.js"), "throw new Error('must not execute installed modules');\n", { mode: 0o600 });
  await writeFile(join(runtime, "require.cjs"), "throw new Error('must not execute CJS modules');\n", { mode: 0o600 });
  await git(["init", "--quiet"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic dependency fixture"]);
  return { root, runtime, git };
}

test("dependency snapshots bind own tracked workspace bytes and resolved pnpm package sources without executing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-dependency-test-"));
  try {
    const baseline = await syntheticDependencyRevision(directory, "baseline");
    const candidate = await syntheticDependencyRevision(directory, "candidate");
    const before = { baseline: await snapshotDetailedAccountingDependencies(baseline.root),
      candidate: await snapshotDetailedAccountingDependencies(candidate.root) };
    assert.equal(before.baseline.sourceSha256, before.candidate.sourceSha256);
    assert.equal(before.baseline.runtimeSha256, before.candidate.runtimeSha256);
    assert.match(validateDetailedAccountingDependencyPair(before), /^[a-f0-9]{64}$/u);
    assert.deepEqual(await snapshotDetailedAccountingDependencies(candidate.root), before.candidate);
    assert.doesNotMatch(JSON.stringify(before), /\/tmp|private|node_modules|accounting|synthetic|\.js/u);
    const entry = join(candidate.runtime, "index.js");
    const original = await readFile(entry);
    await writeFile(entry, "throw new Error('different installed bytes');\n");
    const changed = { ...before, candidate: await snapshotDetailedAccountingDependencies(candidate.root) };
    assert.throws(() => validateDetailedAccountingDependencyPair(changed), codeIs("dependency_mismatch"));
    await writeFile(entry, original);
    await utimes(entry, new Date(0), new Date(0));
    const restored = { ...before, candidate: await snapshotDetailedAccountingDependencies(candidate.root) };
    assert.equal(restored.candidate.runtimeSha256, before.candidate.runtimeSha256);
    assert.throws(() => validateDetailedAccountingDependencyPair(restored, before), codeIs("dependency_changed"));
    const manifestFile = join(candidate.runtime, "package.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, version: "2.0.0" }));
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root), codeIs("dependency_invalid"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dependency inspection rejects cross-root workspace links, hidden tracked edits, surprising package links and bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-dependency-refusal-test-"));
  try {
    const baseline = await syntheticDependencyRevision(directory, "baseline");
    const candidate = await syntheticDependencyRevision(directory, "candidate");
    const workspaceLink = join(candidate.root, "node_modules/@app-usagemonitor/accounting");
    await rm(workspaceLink);
    await symlink(join(baseline.root, "packages/accounting"), workspaceLink);
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root), codeIs("dependency_invalid"));
    await rm(workspaceLink);
    await symlink("../../packages/accounting", workspaceLink);
    const alias = join(candidate.runtime, "alias.js");
    await symlink("index.js", alias);
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root), codeIs("dependency_invalid"));
    await rm(alias);
    for (const limits of [{ maximumFiles: 1 }, { maximumEntries: 1 }, { maximumBytes: 1 }, { maximumFileBytes: 1 }]) {
      await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root, { limits }), codeIs("dependency_limit_exceeded"));
    }
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root, { limits: { maximumFiles: 1025 } }), codeIs("dependency_invalid"));
    await candidate.git(["update-index", "--assume-unchanged", "packages/accounting/index.js"]);
    await writeFile(join(candidate.root, "packages/accounting/index.js"), "export const changed = true;\n");
    assert.equal((await candidate.git(["status", "--porcelain=v1"])).stdout, "");
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root), codeIs("dependency_invalid"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(snapshotDetailedAccountingDependencies(candidate.root, { signal: controller.signal }), codeIs("command_aborted"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function syntheticReceipt() {
  const numericGeneration = Object.fromEntries(["id", "indexedSourceCount", "indexedSourceBytes",
    "skippedSourceCount", "skippedSourceBytes", "skippedThreadCount", "usageEvents", "quotaOccurrences", "toolFacts"]
    .map((key) => [key, key === "id" ? 1 : 0]));
  return {
    schema: "detailed-accounting-child-benchmark-v2", scope: "isolated_accounting_child_only",
    runtime: { version: "v26.2.0", platform: "darwin", arch: "arm64", sha256: "a".repeat(64) },
    baselineRevision: "b".repeat(40), candidateRevision: "c".repeat(40),
    index: { sha256: "d".repeat(64), bytes: 4096 }, generation: { ...numericGeneration, fingerprintSha256: "e".repeat(64),
      publicationStatus: "complete", publicationBlockReason: null, toolProvenanceComplete: true },
    clock: { nowMs: Date.parse("2026-09-02T00:00:00.000Z"), windowDays: 365 },
    policy: { maximumRssBytes: 1024, rebuildChildOldSpaceMib: 1 },
    warmupsPerRevision: 1, measuredRunsPerRevision: 1, artifact: { sha256: hash("{}"), bytes: 2 },
    runs: [0, 1].flatMap((run) => ["baseline", "candidate"].map((side) => ({ side, run, warmup: run === 0,
      wallMs: 20, userCpuMs: 10, systemCpuMs: 5, peakRssBytes: 512 }))),
    exactOutputMatch: true, indexUnchanged: true, sourceUnchanged: true,
    dependenciesSha256: "f".repeat(64),
  };
}

test("receipt schema is closed recursively, complete by revision/run, and content-free", () => {
  const receipt = syntheticReceipt();
  assert.equal(validateDetailedAccountingBenchmarkReceipt(receipt), receipt);
  for (const mutate of [
    (value) => { value.path = "private"; },
    (value) => { value.runtime.environment = "private"; },
    (value) => { value.generation.account = "private"; },
    (value) => { value.clock.sourcePath = "private"; },
    (value) => { value.runs[0].stderr = "private"; },
    (value) => { value.runs[0].peakRssBytes = NaN; },
    (value) => { value.runs[0].peakRssBytes = 1025; },
    (value) => { value.artifact.bytes = 16 * 1024 * 1024 + 1; },
    (value) => { value.runs[1] = value.runs[0]; },
    (value) => { value.indexUnchanged = false; },
    (value) => { value.exactOutputMatch = false; },
    (value) => { value.dependenciesSha256 = "private-path"; },
    (value) => { value.schema = "detailed-accounting-child-benchmark-v1"; delete value.dependenciesSha256; },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => validateDetailedAccountingBenchmarkReceipt(changed), codeIs("receipt_invalid"));
  }
  assert.doesNotMatch(JSON.stringify(receipt), /private|path|filename|account_id|session|\.jsonl|\.sqlite/iu);
});

test("tool-only partial publication remains partial rather than being relabeled or rejected as incomplete accounting", () => {
  const generation = { ...syntheticReceipt().generation, fingerprint: `generation-v2-${"e".repeat(64)}`,
    status: "partial", blockReason: "tool_provenance_incomplete", toolProvenanceComplete: false,
    discoveryComplete: true, diagnosticsComplete: true,
    usageProvenanceComplete: true, sourceOrderComplete: true, quotaProvenanceComplete: true };
  const projected = projectDetailedAccountingBenchmarkGeneration(generation);
  assert.equal(projected.publicationStatus, "partial");
  assert.equal(projected.publicationBlockReason, "tool_provenance_incomplete");
  assert.equal(projected.toolProvenanceComplete, false);
  for (const flag of ["discoveryComplete", "diagnosticsComplete", "usageProvenanceComplete", "sourceOrderComplete", "quotaProvenanceComplete"]) {
    assert.throws(() => projectDetailedAccountingBenchmarkGeneration({ ...generation, [flag]: false }), codeIs("generation_invalid"));
  }
});

test("synthetic substitute revisions exercise the complete private runner without reading real history", {
  skip: process.platform !== "darwin" || process.arch !== "arm64" || process.version !== "v26.2.0",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-benchmark-runner-test-"));
  try {
    const generation = { id: 1, fingerprint: `generation-v2-${"f".repeat(64)}`, status: "partial",
      blockReason: "tool_provenance_incomplete", discoveryComplete: true, diagnosticsComplete: true,
      usageProvenanceComplete: true, sourceOrderComplete: true, quotaProvenanceComplete: true,
      toolProvenanceComplete: false, indexedSourceCount: 1, indexedSourceBytes: 1,
      skippedSourceCount: 0, skippedSourceBytes: 0, skippedThreadCount: 0,
      usageEvents: 0, quotaOccurrences: 0, toolFacts: 0 };
    for (const side of ["baseline", "candidate"]) {
      const root = join(directory, side);
      await mkdir(join(root, "src"), { recursive: true, mode: 0o700 });
      await mkdir(join(root, "node_modules/synthetic-runtime"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, ".gitignore"), "node_modules/\n", { mode: 0o600 });
      await writeFile(join(root, "package.json"), '{"type":"module","dependencies":{"synthetic-runtime":"1.0.0"}}', { mode: 0o600 });
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  synthetic-runtime@1.0.0:\n    resolution: {}\n", { mode: 0o600 });
      await writeFile(join(root, "node_modules/synthetic-runtime/package.json"),
        '{"name":"synthetic-runtime","version":"1.0.0","type":"module","exports":"./index.js"}', { mode: 0o600 });
      await writeFile(join(root, "node_modules/synthetic-runtime/index.js"), "export const synthetic = true;\n", { mode: 0o600 });
      await writeFile(join(root, "src/local-unified-index.js"),
        `export const openLocalUnifiedIndex = () => ({ close() {} }); export const readUnifiedIndexGenerationDescriptor = () => (${JSON.stringify(generation)});`, { mode: 0o600 });
      await writeFile(join(root, "src/replay-safe-accounting-cache.js"),
        "export const REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY = { maximumRssBytes: 6442450944, rebuildChildOldSpaceMib: 6144 };\n"
        + "export const REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION = 'replay-safe-accounting-rebuild-request-v1';\n"
        + "export function assertReplaySafeAccountingCache(value) { if(value.synthetic !== true) throw new Error('invalid'); return value; }", { mode: 0o600 });
      await writeFile(join(root, "src/replay-safe-accounting-rebuild-child.js"),
        "import { readFile, writeFile } from 'node:fs/promises'; import { createHash } from 'node:crypto'; import 'synthetic-runtime';\n"
        + "process.stdin.resume(); process.stdin.on('end', () => process.exit(9));\n"
        + "const request = JSON.parse(await readFile(process.argv[2], 'utf8')); const payload = JSON.stringify({ synthetic: true, nowMs: request.nowMs });\n"
        + "await writeFile(process.argv[3], payload, { mode: 0o600, flag: 'wx' });\n"
        + "process.stdout.write(JSON.stringify({ status: 'ok', resultBytes: Buffer.byteLength(payload), resultSha256: createHash('sha256').update(payload).digest('hex') }), () => process.exit(0));", { mode: 0o600 });
      const git = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root, ...args], {
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      await git(["init", "--quiet"]);
      await git(["add", "."]);
      await git(["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic benchmark fixture"]);
    }
    const index = join(directory, "input.sqlite");
    await writeFile(index, "synthetic-only-not-sqlite", { mode: 0o400 });
    const options = parseDetailedAccountingBenchmarkArguments([
      "--allow-private-index-benchmark", "--baseline-root", join(directory, "baseline"),
      "--candidate-root", join(directory, "candidate"), "--index", index,
      "--output-dir", join(directory, "output"), "--now", "2026-09-02T00:00:00.000Z",
      "--window-days", "365", "--runs", "1",
    ]);
    const receipt = await runDetailedAccountingBenchmark(options);
    assert.equal(receipt.exactOutputMatch, true);
    assert.equal(receipt.indexUnchanged, true);
    assert.equal(receipt.sourceUnchanged, true);
    assert.match(receipt.dependenciesSha256, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.generation.publicationStatus, "partial");
    assert.deepEqual(receipt.runs.map(({ side, run }) => [side, run]), [
      ["baseline", 0], ["candidate", 0], ["candidate", 1], ["baseline", 1],
    ]);
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-only|private|input\.sqlite|\/tmp|account_id/iu);
    await assert.rejects(runDetailedAccountingBenchmark(options), (error) => error.code === "EEXIST");
    const candidateRoot = join(directory, "candidate");
    const lateAbortDirectory = join(directory, "late-abort-output");
    const controller = new AbortController();
    await assert.rejects(runDetailedAccountingBenchmark({ ...options, outputDirectory: lateAbortDirectory }, {
      signal: controller.signal, beforeReceiptPublication: () => controller.abort(),
    }), codeIs("command_aborted"));
    await assert.rejects(readFile(join(lateAbortDirectory, "receipt.json")), (error) => error.code === "ENOENT");
    const mutatedDirectory = join(directory, "changed-dependency-output");
    const runtimeFile = join(candidateRoot, "node_modules/synthetic-runtime/index.js");
    const originalRuntime = await readFile(runtimeFile);
    await assert.rejects(runDetailedAccountingBenchmark({ ...options, outputDirectory: mutatedDirectory }, {
      afterAccountingRun: async ({ side, run }) => {
        if (side === "baseline" && run === 0) await writeFile(runtimeFile, "export const synthetic = false;\n");
      },
    }), codeIs("dependency_mismatch"));
    await assert.rejects(readFile(join(mutatedDirectory, "receipt.json")), (error) => error.code === "ENOENT");
    await writeFile(runtimeFile, originalRuntime);
    const commitCandidate = async () => {
      const git = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", candidateRoot, ...args], {
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      await git(["add", "."]);
      await git(["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic negative fixture"]);
    };
    const childFile = join(candidateRoot, "src/replay-safe-accounting-rebuild-child.js");
    await writeFile(childFile, (await readFile(childFile, "utf8"))
      .replace("{ synthetic: true, nowMs:", "{ synthetic: true, changed: true, nowMs:"));
    await commitCandidate();
    await assert.rejects(runDetailedAccountingBenchmark({ ...options,
      outputDirectory: join(directory, "mismatched-output") }), codeIs("artifact_mismatch"));
    const validatorFile = join(candidateRoot, "src/replay-safe-accounting-cache.js");
    await writeFile(validatorFile, (await readFile(validatorFile, "utf8"))
      .replace("if(value.synthetic !== true)", "if(true)"));
    await commitCandidate();
    await assert.rejects(runDetailedAccountingBenchmark({ ...options,
      outputDirectory: join(directory, "invalid-output") }), codeIs("artifact_invalid"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
