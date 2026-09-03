import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  digestDetailedAccountingBenchmarkFile, inspectDetailedAccountingBenchmarkIndex,
  parseMacOsTimeMetrics, runBoundedBenchmarkCommand, snapshotDetailedAccountingDependencies,
} from "./benchmark-detailed-accounting.mjs";
import {
  importPr94LedgerEvidencePrivate, comparePr94LedgerEvidence,
  disposePr94LedgerEvidencePrivate,
} from "./lib/pr94-ledger-evidence.mjs";
import {
  importPr94CalibrationEvidence, comparePr94CalibrationEvidence,
  disposePr94CalibrationEvidencePrivate,
} from "./lib/pr94-calibration-evidence.mjs";
import { runPr94ProductionResourceWorker, PR94_PRODUCTION_ERROR_CODES } from "./lib/pr94-production-resource-worker.mjs";
import { validatePr94AnalysisResult, validatePr94ComparisonReceipt } from "./lib/pr94-receipt-validation.mjs";
import { PR94_ANALYSIS_ERROR_CODES } from "./lib/pr94-analysis-worker.mjs";

export const PR94_COMPARISON_REVISIONS = Object.freeze({
  before: "a3c850360bc83c0e27bef2171aeb4a302b72f472",
  after: "20f449ff5c222989029fe343f219f02b497ae1d4",
});
const HASH = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_RSS = 6_442_450_944;
const WORKER = fileURLToPath(new URL("./lib/pr94-analysis-worker.mjs", import.meta.url));
const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const KEYS = ["beforeRoot", "afterRoot", "finalRoot", "indexFile", "outputDirectory", "startAt", "endAt"];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function cancelled(signal) { if (signal?.aborted) fail("pr94_cancelled"); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function parsePr94QualificationArguments(argv) {
  const flags = new Map([
    ["--before-root", "beforeRoot"], ["--after-root", "afterRoot"], ["--final-root", "finalRoot"],
    ["--index", "indexFile"], ["--output-dir", "outputDirectory"],
    ["--start-at", "startAt"], ["--end-at", "endAt"], ["--timeout-seconds", "timeoutSeconds"],
  ]);
  const options = { timeoutSeconds: 1800 }; const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) fail("pr94_arguments_invalid");
    seen.add(flag);
    if (flag === "--allow-private-attribution-comparison") continue;
    const key = flags.get(flag); const value = argv[++i];
    if (!key || !value || value.startsWith("--")) fail("pr94_arguments_invalid");
    options[key] = key === "timeoutSeconds" ? Number(value) : value;
  }
  if (!seen.has("--allow-private-attribution-comparison")) fail("pr94_approval_required");
  if (!KEYS.every((key) => typeof options[key] === "string" && options[key].length > 0)
      || !Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds < 1
      || options.timeoutSeconds > 3600) fail("pr94_arguments_invalid");
  for (const key of ["startAt", "endAt"]) {
    if (!Number.isSafeInteger(Date.parse(options[key]))
        || new Date(options[key]).toISOString() !== options[key]) fail("pr94_arguments_invalid");
  }
  if (options.endAt <= options.startAt) fail("pr94_arguments_invalid");
  for (const key of KEYS.filter((key) => key.endsWith("Root") || key.endsWith("File") || key.endsWith("Directory"))) {
    options[key] = resolve(options[key]);
  }
  return { ...options, privateOperationApproved: true };
}

async function privateDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o077) !== 0 || await realpath(path) !== path) fail("pr94_path_invalid");
}
async function privateFile(path, maximumBytes) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0
      || metadata.size < 1 || metadata.size > maximumBytes) fail("pr94_path_invalid");
  return metadata;
}
async function sourceIdentity(root, signal) {
  const command = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root, ...args], { signal });
  if (await realpath(root) !== root) fail("pr94_source_invalid");
  const revision = (await command(["rev-parse", "HEAD"])).stdout.trim();
  if (!REVISION.test(revision)
      || (await command(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") {
    fail("pr94_source_invalid");
  }
  return { revision, dependencies: await snapshotDetailedAccountingDependencies(root, { signal }) };
}

export async function* readPr94PrivateFrames(path, signal) {
  const initial = await privateFile(path, 512 * 1024 * 1024);
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  const abort = () => stream.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  let pending = Buffer.alloc(0);
  let frames = 0;
  let bytes = 0;
  try {
    cancelled(signal);
    for await (const chunk of stream) {
      cancelled(signal);
      bytes += chunk.length;
      if (bytes > initial.size) fail("pr94_private_frames_invalid");
      const combined = Buffer.concat([pending, chunk]);
      let start = 0;
      for (let end = combined.indexOf(10, start); end >= 0; end = combined.indexOf(10, start)) {
        cancelled(signal);
        if (++frames > 2_000_010 || end - start < 1 || end - start > 1024 * 1024) {
          fail("pr94_private_frames_invalid");
        }
        let frame;
        try { frame = JSON.parse(combined.subarray(start, end).toString("utf8")); }
        catch { fail("pr94_private_frames_invalid"); }
        yield frame;
        start = end + 1;
      }
      pending = Buffer.from(combined.subarray(start));
      if (pending.length > 1024 * 1024) fail("pr94_private_frames_invalid");
    }
    cancelled(signal);
    if (pending.length !== 0 || bytes !== initial.size) fail("pr94_private_frames_invalid");
    const final = await privateFile(path, 512 * 1024 * 1024);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      if (initial[key] !== final[key]) fail("pr94_private_frames_invalid");
    }
  } finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
}

// Exclusive final link is the commit point. The temporary file is fsynced
// first; a canceled/error path revokes only the exact file created by this run.
// Existing receipts are never replaced, including races at publication.
export async function publishPr94Receipt(directory, receipt, {
  signal = null, closeFile = (file) => file.close(),
} = {}) {
  cancelled(signal);
  await privateDirectory(directory);
  const temporary = join(directory, "comparison.partial.json");
  const destination = join(directory, "comparison.json");
  const body = Buffer.from(JSON.stringify(receipt));
  if (body.length > 4 * 1024 * 1024) fail("pr94_artifact_invalid");
  const file = await open(temporary, "wx", 0o600);
  let identity;
  let committed = false;
  let closed = false;
  try {
    identity = await file.stat();
    await file.writeFile(body);
    await file.sync();
    cancelled(signal);
    await link(temporary, destination);
    committed = true;
    cancelled(signal);
    await unlink(temporary);
    await closeFile(file);
    closed = true;
    const folder = await open(directory, "r");
    try { await folder.sync(); } finally { await folder.close(); }
    cancelled(signal);
  } catch (error) {
    if (committed) {
      const current = await lstat(destination).catch(() => null);
      if (identity && current?.dev === identity.dev && current?.ino === identity.ino) await unlink(destination);
    }
    if (!closed) await file.close();
    const current = await lstat(temporary).catch(() => null);
    if (identity && current?.dev === identity.dev && current?.ino === identity.ino) await unlink(temporary);
    throw error;
  }
}

export function parsePr94AnalysisEnvelope(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail("pr94_envelope_invalid"); }
  if (value?.status === "error") {
    // Fixed worker codes only; never relay arbitrary subprocess diagnostics.
    if (!exact(value, ["status", "code"]) || !PR94_ANALYSIS_ERROR_CODES.includes(value.code)) fail("pr94_envelope_invalid");
    fail(value.code);
  }
  if (!exact(value, ["status", "resultBytes", "resultSha256"]) || value.status !== "ok"
      || !Number.isSafeInteger(value.resultBytes) || value.resultBytes < 1
      || value.resultBytes > 4 * 1024 * 1024 || !HASH.test(value.resultSha256)) fail("pr94_envelope_invalid");
  return value;
}

async function readAnalysis(directory, envelope, signal) {
  cancelled(signal);
  const path = join(directory, "analysis.json");
  const metadata = await privateFile(path, 4 * 1024 * 1024);
  const bytes = await readFile(path);
  if (metadata.size !== envelope.resultBytes || bytes.length !== envelope.resultBytes
      || hash(bytes) !== envelope.resultSha256) fail("pr94_artifact_mismatch");
  let analysis;
  try { analysis = JSON.parse(bytes); } catch { fail("pr94_artifact_invalid"); }
  return validatePr94AnalysisResult(analysis);
}

// The public receipt is constructed anew: private row fingerprints, report
// objects, identifiers, filenames, absolute paths and HMAC keys never enter it.
export async function runPr94Qualification(options, { signal = null } = {}) {
  if (options?.privateOperationApproved !== true) fail("pr94_approval_required");
  if (process.version !== "v26.2.0" || process.platform !== "darwin" || process.arch !== "arm64") {
    fail("pr94_runtime_invalid");
  }
  if (options.finalRoot !== await realpath(HARNESS_ROOT)) fail("pr94_source_invalid");
  cancelled(signal);
  const roots = { before: options.beforeRoot, after: options.afterRoot, final: options.finalRoot };
  const sources = {};
  for (const side of Object.keys(roots)) sources[side] = await sourceIdentity(roots[side], signal);
  for (const side of ["before", "after"]) {
    if (sources[side].revision !== PR94_COMPARISON_REVISIONS[side]) fail("pr94_revision_mismatch");
  }
  if (sources.before.dependencies.runtimeSha256 !== sources.after.dependencies.runtimeSha256
      || sources.before.dependencies.lockSha256 !== sources.after.dependencies.lockSha256) {
    fail("pr94_dependency_mismatch");
  }
  const indexStat = await inspectDetailedAccountingBenchmarkIndex(options.indexFile);
  const indexSha256 = await digestDetailedAccountingBenchmarkFile(options.indexFile, indexStat, { signal });
  await privateDirectory(dirname(options.outputDirectory));
  await mkdir(options.outputDirectory, { mode: 0o700 });
  await privateDirectory(options.outputDirectory);
  const key = randomBytes(32);
  const evidence = {}; const measurements = {};
  let privateEvidenceDisposed = false;
  try {
    for (const side of ["before", "after", "final"]) {
      cancelled(signal);
      const directory = join(options.outputDirectory, side);
      await mkdir(directory, { mode: 0o700 });
      const request = Buffer.from(JSON.stringify({ root: roots[side], indexFile: options.indexFile,
        outputDirectory: directory, revisionKind: side, startAt: options.startAt, endAt: options.endAt,
        hmacKey: key.toString("hex") }));
      let output;
      try { output = await runBoundedBenchmarkCommand("/usr/bin/time", ["-l", process.execPath,
        "--max-old-space-size=6144", WORKER], {
        cwd: directory, env: { LC_ALL: "C", TMPDIR: directory }, signal,
        timeoutMs: options.timeoutSeconds * 1000,
        spawnCommand(command, args, settings) {
          const child = spawn(command, args, settings);
          child.stdin.end(request);
          return child;
        },
      }); } finally { request.fill(0); }
      const envelope = parsePr94AnalysisEnvelope(output.stdout);
      measurements[side] = parseMacOsTimeMetrics(output.stderr);
      if (measurements[side].peakRssBytes > MAX_RSS) fail("pr94_resource_limit");
      const analysis = await readAnalysis(directory, envelope, signal);
      if (analysis.revisionKind !== side) fail("pr94_artifact_invalid");
      const ledger = await importPr94LedgerEvidencePrivate(
        readPr94PrivateFrames(join(directory, "ledger.ndjson"), signal), { hmacKey: key, maxRows: 2_000_000 });
      evidence[side] = { analysis, ledger, calibration: null };
      // Sealed transport canonicalizes object keys. Property insertion order is
      // not accounting evidence and must not make an otherwise exact fold fail.
      if (!isDeepStrictEqual(ledger, analysis.ledger)) fail("pr94_artifact_mismatch");
      const calibration = await importPr94CalibrationEvidence({ aggregate: analysis.calibration,
        frames: readPr94PrivateFrames(join(directory, "calibration.ndjson"), signal), hmacKey: key });
      evidence[side].calibration = calibration;
    }
    const comparison = {
      attributionLedger: comparePr94LedgerEvidence(evidence.before.ledger, evidence.after.ledger),
      finalLedger: comparePr94LedgerEvidence(evidence.after.ledger, evidence.final.ledger),
      attributionCalibration: comparePr94CalibrationEvidence(evidence.before.calibration, evidence.after.calibration),
      finalCalibration: comparePr94CalibrationEvidence(evidence.after.calibration, evidence.final.calibration),
      readerEvidenceUnchanged: ["inventory", "coverage", "generation"].every((key) =>
        ["after", "final"].every((side) => isDeepStrictEqual(evidence.before.analysis[key], evidence[side].analysis[key]))),
    };
    if (comparison.attributionLedger.status !== "equal" || comparison.finalLedger.status !== "equal"
        || comparison.attributionCalibration.status !== "pass" || comparison.finalCalibration.status !== "pass"
        || !comparison.readerEvidenceUnchanged
        || Object.values(evidence).some((value) => value.analysis.populationEvidence.unknownAccountOnlyWithheldEvents !== 0)) {
      fail("pr94_comparison_not_passed");
    }
    for (const value of Object.values(evidence)) {
      disposePr94LedgerEvidencePrivate(value.ledger);
      if (value.calibration !== null) disposePr94CalibrationEvidencePrivate(value.calibration);
    }
    privateEvidenceDisposed = true;
    const productionResources = {};
    for (const side of ["before", "after", "final"]) {
      cancelled(signal);
      productionResources[side] = await runPr94ProductionResourceWorker({
        privateOperationApproved: true, root: roots[side], expectedRevision: sources[side].revision,
        indexFile: options.indexFile,
        expectedIndex: { sha256: indexSha256, bytes: indexStat.size,
          generationId: evidence[side].analysis.generation.id },
        outputDirectory: join(options.outputDirectory, `production-${side}`),
        startAt: options.startAt, endAt: options.endAt, timeoutSeconds: options.timeoutSeconds,
      }, { signal });
    }
    for (const side of Object.keys(roots)) {
      if (!isDeepStrictEqual(await sourceIdentity(roots[side], signal), sources[side])) {
        fail("pr94_source_changed");
      }
    }
    if (await digestDetailedAccountingBenchmarkFile(options.indexFile,
      await inspectDetailedAccountingBenchmarkIndex(options.indexFile), { signal }) !== indexSha256) {
      fail("pr94_index_changed");
    }
    cancelled(signal);
    const receipt = {
      schema: "pr94-admitted-index-comparison-v2",
      status: productionResources.after.status === "historical_artifact_refused"
        ? "passed_with_historical_artifact_refusal" : "passed",
      scope: "fixed_admitted_index_analysis_not_raw_ingestion_or_hosted_activation",
      sources, index: { sha256: indexSha256, bytes: indexStat.size },
      window: { startAt: options.startAt, endAt: options.endAt }, comparison,
      measurements, productionResources,
      evidence: Object.fromEntries(Object.entries(evidence).map(([side, value]) => [side, value.analysis])),
    };
    validatePr94ComparisonReceipt(receipt);
    await publishPr94Receipt(options.outputDirectory, receipt, { signal });
    return receipt;
  } finally {
    key.fill(0);
    for (const value of privateEvidenceDisposed ? [] : Object.values(evidence)) {
      disposePr94LedgerEvidencePrivate(value.ledger);
      if (value.calibration !== null) disposePr94CalibrationEvidencePrivate(value.calibration);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    const receipt = await runPr94Qualification(parsePr94QualificationArguments(process.argv.slice(2)),
      { signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ status: receipt.status })}\n`);
  } catch (error) {
    const known = new Set(["pr94_approval_required", "pr94_arguments_invalid", "pr94_runtime_invalid",
      "pr94_path_invalid", "pr94_source_invalid", "pr94_revision_mismatch", "pr94_dependency_mismatch",
      "pr94_artifact_invalid", "pr94_artifact_mismatch", "pr94_envelope_invalid", "pr94_analysis_refused",
      "pr94_private_frames_invalid", "pr94_resource_limit", "pr94_comparison_not_passed",
      "pr94_receipt_analysis_invalid", "pr94_receipt_comparison_invalid",
      "pr94_source_changed", "pr94_index_changed", "pr94_cancelled", ...PR94_ANALYSIS_ERROR_CODES,
      ...PR94_PRODUCTION_ERROR_CODES]);
    process.stdout.write(`${JSON.stringify({ status: "failed", code: known.has(error?.code)
      ? error.code : "pr94_qualification_failed" })}\n`);
    process.exitCode = 1;
  }
}
