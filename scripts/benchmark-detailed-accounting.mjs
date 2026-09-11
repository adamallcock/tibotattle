import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractEsmImports } from "./lib/esm-imports.mjs";

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
// v1 receipts remain historical evidence; they did not enforce this dependency
// snapshot and must never be accepted as proof of the v2 contract.
const SCHEMA = "detailed-accounting-child-benchmark-v2";
const DEPENDENCY_LIMITS = Object.freeze({ maximumFiles: 1024, maximumEntries: 4096,
  maximumBytes: 32 * 1024 * 1024, maximumFileBytes: 4 * 1024 * 1024, maximumPackages: 16 });
const ERROR_CODES = new Set([
  "approval_required", "arguments_invalid", "runtime_invalid", "path_invalid",
  "source_not_clean", "source_changed", "index_invalid", "index_changed",
  "generation_invalid", "policy_mismatch", "command_failed", "command_timeout",
  "command_output_limit", "command_aborted", "metrics_invalid", "envelope_invalid",
  "child_refused", "artifact_invalid", "artifact_mismatch", "receipt_invalid", "resource_limit_exceeded",
  "dependency_invalid", "dependency_changed", "dependency_mismatch", "dependency_limit_exceeded",
  "command_termination_unconfirmed",
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

function checkCancelled(signal) {
  if (signal?.aborted) throw fail("command_aborted");
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
    let terminationTimer = null;
    let escalated = false;
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
      if (terminationTimer !== null) clearTimeout(terminationTimer);
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
      graceTimer = setTimeout(() => {
        escalated = true;
        killGroup("SIGKILL");
        if (closed !== null) finish();
        else {
          // Sending a signal is not a close receipt. Bound a missing close
          // separately and do not describe that escape as confirmed abortion.
          terminationTimer = setTimeout(() => {
            stopped = "command_termination_unconfirmed";
            finish();
          }, 1000);
        }
      }, killGraceMs);
    };
    const abort = () => stop("command_aborted");
    const timeout = setTimeout(() => stop("command_timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
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
      if (stopped === null || escalated) finish();
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

export async function digestDetailedAccountingBenchmarkFile(path, expectedStat = null, {
  signal = null, onChunk = null,
} = {}) {
  checkCancelled(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    checkCancelled(signal);
    const before = await handle.stat();
    if (expectedStat !== null && !sameFile(before, expectedStat)) throw fail("path_invalid");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, signal: signal ?? undefined })) {
      checkCancelled(signal);
      hash.update(chunk);
      // Deterministic characterization seam; private CLI inputs cannot set it.
      if (onChunk !== null) await onChunk();
      checkCancelled(signal);
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))) {
      throw fail("path_invalid");
    }
    checkCancelled(signal);
    return hash.digest("hex");
  } catch (error) {
    checkCancelled(signal);
    throw error;
  } finally { await handle.close(); }
}

export async function verifyAccountingBenchmarkArtifact(path, envelope, { signal = null } = {}) {
  checkCancelled(signal);
  const stat = await privateRegularFile(path, { maximumBytes: MAX_RESULT_BYTES });
  if (stat.size > MAX_DURABLE_CACHE_BYTES) throw fail("resource_limit_exceeded");
  if (stat.size !== envelope.resultBytes) throw fail("artifact_mismatch");
  const sha256 = await digestDetailedAccountingBenchmarkFile(path, stat, { signal });
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

async function revisionAt(root, { signal = null } = {}) {
  checkCancelled(signal);
  const command = (args) => runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root, ...args], { signal });
  const revision = (await command(["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (!REVISION.test(revision)) throw fail("source_not_clean");
  if ((await command(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") {
    throw fail("source_not_clean");
  }
  return revision;
}

function within(root, path) {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`));
}

function aggregateDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dependencyLimits(requested = {}) {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)
      || Object.keys(requested).some((key) => !Object.hasOwn(DEPENDENCY_LIMITS, key))) {
    throw fail("dependency_invalid");
  }
  const limits = { ...DEPENDENCY_LIMITS, ...requested };
  for (const [key, value] of Object.entries(limits)) {
    if (!integer(value, 1, DEPENDENCY_LIMITS[key])) throw fail("dependency_invalid");
  }
  return limits;
}

function validDependencySnapshot(value) {
  return exactKeys(value, ["sourceSha256", "runtimeSha256", "lockSha256", "identitySha256"])
    && Object.values(value).every((digest) => SHA256.test(digest));
}

/** Inspects source only. The bounded wrapper enables Node's parent-aware ESM
 * resolver; no accounting, package entrypoint, or private input is executed. */
export async function inspectDetailedAccountingDependencySources(root, {
  signal = null, limits: requestedLimits = {},
} = {}) {
  if (!process.execArgv.includes("--experimental-import-meta-resolve")) throw fail("dependency_invalid");
  const limits = dependencyLimits(requestedLimits);
  root = await realpath(root);
  const revision = await revisionAt(root, { signal });
  const listing = await runBoundedBenchmarkCommand("/usr/bin/git", ["-C", root,
    "ls-tree", "-r", "-z", "HEAD", "--", "src", "packages", "schemas", "package.json", "pnpm-lock.yaml"],
  { signal, stdoutLimit: 1024 * 1024 });
  const tracked = new Map();
  for (const line of listing.stdout.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    // Nonregular tracked entries cannot be hidden inside the inspected owners.
    if (!match) throw fail("dependency_invalid");
    if (tracked.size >= limits.maximumEntries) throw fail("dependency_limit_exceeded");
    tracked.set(match[3], match[2]);
  }
  const files = new Map();
  const source = new Map();
  const identities = new Map();
  let bytesRead = 0;
  let entriesRead = 0;
  const record = async (path, name) => {
    checkCancelled(signal);
    if (files.has(path)) return files.get(path);
    if (files.size >= limits.maximumFiles) throw fail("dependency_limit_exceeded");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || await realpath(path) !== path || !integer(stat.size)
        || stat.size > limits.maximumFileBytes || bytesRead + stat.size > limits.maximumBytes) {
      throw fail(stat.size > limits.maximumFileBytes || bytesRead + stat.size > limits.maximumBytes
        ? "dependency_limit_exceeded" : "dependency_invalid");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks = [];
    let size = 0;
    try {
      if (!sameFile(stat, await handle.stat())) throw fail("dependency_changed");
      for await (const chunk of handle.createReadStream({ autoClose: false, signal: signal ?? undefined })) {
        checkCancelled(signal);
        size += chunk.length;
        if (size > limits.maximumFileBytes || bytesRead + size > limits.maximumBytes) {
          throw fail("dependency_limit_exceeded");
        }
        chunks.push(chunk);
      }
      if (!sameFile(stat, await handle.stat()) || !sameFile(stat, await lstat(path))) {
        throw fail("dependency_changed");
      }
    } catch (error) {
      checkCancelled(signal);
      throw error;
    } finally { await handle.close(); }
    const bytes = Buffer.concat(chunks, size);
    bytesRead += size;
    const value = { bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
      blob: createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex") };
    identities.set(name, [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid, stat.nlink]);
    files.set(path, value);
    return value;
  };
  const trackedFile = async (path) => {
    if (!within(root, path)) throw fail("dependency_invalid");
    const name = relative(root, path).split(sep).join("/");
    if (!tracked.has(name)) throw fail("dependency_invalid");
    const value = await record(path, `source:${name}`);
    if (value.blob !== tracked.get(name)) throw fail("dependency_invalid");
    source.set(name, value.sha256);
    return value.bytes.toString("utf8");
  };
  await trackedFile(join(root, "package.json"));
  const lock = await trackedFile(join(root, "pnpm-lock.yaml"));
  const queue = [join(root, "src/replay-safe-accounting-rebuild-child.js")];
  const visited = new Set();
  const workspacePackages = new Set();
  const runtimeQueue = [];
  const packageName = (specifier) => {
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name)) throw fail("dependency_invalid");
    return name;
  };
  while (queue.length > 0) {
    checkCancelled(signal);
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = await trackedFile(file);
    if (relative(root, file).startsWith(`packages${sep}`)) workspacePackages.add(relative(root, file).split(sep)[1]);
    if (file.endsWith(".json")) continue;
    const imports = await extractEsmImports(text);
    for (const edge of imports) {
      if (++entriesRead > limits.maximumEntries) throw fail("dependency_limit_exceeded");
      const specifier = edge.specifier;
      if (typeof specifier !== "string") throw fail("dependency_invalid");
      if (isBuiltin(specifier)) continue;
      const targetUrl = import.meta.resolve(specifier, pathToFileURL(file));
      if (!targetUrl.startsWith("file:")) throw fail("dependency_invalid");
      const target = fileURLToPath(targetUrl);
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const lexical = resolve(dirname(file), specifier);
        if (!within(root, lexical) || await realpath(lexical) !== lexical) throw fail("dependency_invalid");
        queue.push(target);
      } else if (specifier.startsWith("@app-usagemonitor/")) {
        const name = packageName(specifier).slice("@app-usagemonitor/".length);
        if (!within(join(root, "packages", name), target)) throw fail("dependency_invalid");
        workspacePackages.add(name);
        queue.push(target);
      } else {
        runtimeQueue.push({ name: packageName(specifier), entry: target });
      }
    }
  }
  // Manifests and all tracked package bytes bind export maps and any packaged
  // resources too, not only the entrypoint selected during this traversal.
  for (const name of [...workspacePackages].sort()) {
    const prefix = `packages/${name}/`;
    for (const path of [...tracked.keys()].filter((key) => key.startsWith(prefix)).sort()) {
      await trackedFile(join(root, path));
    }
  }
  const runtime = new Map();
  const runtimeRoot = join(root, "node_modules");
  while (runtimeQueue.length > 0) {
    checkCancelled(signal);
    const item = runtimeQueue.shift();
    const entry = await realpath(item.entry);
    if (!within(runtimeRoot, entry)) throw fail("dependency_invalid");
    let directory = dirname(entry);
    let manifest;
    while (within(runtimeRoot, directory) && directory !== runtimeRoot) {
      try {
        const data = await record(join(directory, "package.json"), `runtime:${item.name}:manifest:${relative(runtimeRoot, directory)}`);
        const candidate = JSON.parse(data.bytes.toString("utf8"));
        if (candidate.name === item.name) { manifest = candidate; break; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      directory = dirname(directory);
    }
    if (!manifest || typeof manifest.version !== "string") throw fail("dependency_invalid");
    if (runtime.has(item.name)) {
      if (runtime.get(item.name).directory !== directory) throw fail("dependency_invalid");
      continue;
    }
    if (runtime.size >= limits.maximumPackages) throw fail("dependency_limit_exceeded");
    const locked = new Set();
    for (const line of lock.split("\n")) {
      const match = /^  ['"]?(.+?)['"]?:\s*$/u.exec(line);
      if (match?.[1].startsWith(`${item.name}@`)) locked.add(match[1].slice(item.name.length + 1));
    }
    // Ambiguous multiple locked versions require a reviewed resolver extension,
    // not a guess about which installed copy the measurement ought to use.
    if (locked.size !== 1 || !locked.has(manifest.version)) throw fail("dependency_invalid");
    const packageFiles = [];
    const walk = async (path) => {
      checkCancelled(signal);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || await realpath(path) !== path) throw fail("dependency_invalid");
      identities.set(`runtime:${item.name}:directory:${relative(directory, path)}`,
        [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid]);
      for await (const child of await opendir(path)) {
        checkCancelled(signal);
        if (++entriesRead > limits.maximumEntries) throw fail("dependency_limit_exceeded");
        if (child.isSymbolicLink() || child.name === "node_modules") throw fail("dependency_invalid");
        const childPath = join(path, child.name);
        if (child.isDirectory()) await walk(childPath);
        else if (!child.isFile()) throw fail("dependency_invalid");
        else if (/\.(?:js|cjs|mjs|json)$/u.test(child.name)) {
          const name = relative(directory, childPath).split(sep).join("/");
          const value = await record(childPath, `runtime:${item.name}:${name}`);
          packageFiles.push([name, value.sha256]);
        }
      }
      if (!sameFile(stat, await lstat(path))) throw fail("dependency_changed");
    };
    await walk(directory);
    const dependencies = manifest.dependencies ?? {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
        || Object.keys(manifest.optionalDependencies ?? {}).length > 0
        || Object.keys(manifest.peerDependencies ?? {}).length > 0) throw fail("dependency_invalid");
    for (const name of Object.keys(dependencies).sort()) {
      if (packageName(name) !== name || typeof dependencies[name] !== "string") throw fail("dependency_invalid");
      runtimeQueue.push({ name, entry: createRequire(join(directory, "package.json")).resolve(name) });
    }
    runtime.set(item.name, { directory, version: manifest.version, files: packageFiles.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      dependencies: Object.keys(dependencies).sort() });
  }
  checkCancelled(signal);
  if (await revisionAt(root, { signal }) !== revision) throw fail("source_changed");
  const sorted = (map) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { sourceSha256: aggregateDigest(sorted(source)),
    runtimeSha256: aggregateDigest(sorted(runtime).map(([name, value]) => [name, value.version, value.files, value.dependencies])),
    lockSha256: createHash("sha256").update(lock).digest("hex"),
    identitySha256: aggregateDigest(sorted(identities)) };
}

export async function snapshotDetailedAccountingDependencies(root, { signal = null, limits = {} } = {}) {
  dependencyLimits(limits);
  const program = `import { inspectDetailedAccountingDependencySources, detailedAccountingBenchmarkFailure } from ${JSON.stringify(import.meta.url)};
const controller = new AbortController(); process.once('SIGTERM', () => controller.abort());
try { const value = await inspectDetailedAccountingDependencySources(process.argv[1], { signal: controller.signal, limits: JSON.parse(process.argv[2]) });
process.stdout.write(JSON.stringify({ ok: value })); }
catch (error) { process.stdout.write(JSON.stringify({ error: detailedAccountingBenchmarkFailure(error).code })); }`;
  const output = await runBoundedBenchmarkCommand(process.execPath,
    ["--experimental-import-meta-resolve", "--input-type=module", "--eval", program, root, JSON.stringify(limits)],
    { signal, timeoutMs: 30_000 });
  let value;
  try { value = JSON.parse(output.stdout); } catch { throw fail("dependency_invalid"); }
  if (exactKeys(value, ["error"]) && ERROR_CODES.has(value.error)) throw fail(value.error);
  if (!exactKeys(value, ["ok"]) || !validDependencySnapshot(value.ok)) throw fail("dependency_invalid");
  return value.ok;
}

export function validateDetailedAccountingDependencyPair(pair, expected = null) {
  if (!exactKeys(pair, ["baseline", "candidate"])
      || !validDependencySnapshot(pair.baseline) || !validDependencySnapshot(pair.candidate)) throw fail("dependency_invalid");
  if (pair.baseline.runtimeSha256 !== pair.candidate.runtimeSha256
      || pair.baseline.lockSha256 !== pair.candidate.lockSha256) throw fail("dependency_mismatch");
  if (expected !== null && JSON.stringify(pair) !== JSON.stringify(expected)) throw fail("dependency_changed");
  return aggregateDigest(pair);
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
    "artifact", "runs", "exactOutputMatch", "indexUnchanged", "sourceUnchanged", "dependenciesSha256"];
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
      || !SHA256.test(receipt.dependenciesSha256)
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

export async function publishDetailedAccountingBenchmarkReceipt(directory, receipt, {
  signal = null, beforePublish = null, afterWrite = null,
} = {}) {
  validateDetailedAccountingBenchmarkReceipt(receipt);
  checkCancelled(signal);
  if (beforePublish !== null) await beforePublish();
  checkCancelled(signal);
  const path = join(directory, "receipt.json");
  let handle = null;
  let created = null;
  try {
    handle = await open(path, "wx", 0o600);
    created = await handle.stat();
    checkCancelled(signal);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, { signal: signal ?? undefined });
    if (afterWrite !== null) await afterWrite();
    await handle.close();
    handle = null;
    checkCancelled(signal);
  } catch (error) {
    if (handle !== null) { await handle.close(); handle = null; }
    // Only remove the exact no-clobber file this invocation created. An abort
    // during/after writing must not leave a valid-looking success receipt.
    if (created !== null) {
      try {
        const current = await lstat(path);
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1
            && current.dev === created.dev && current.ino === created.ino) await unlink(path);
      } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw fail("path_invalid"); }
    }
    checkCancelled(signal);
    throw error;
  }
}

export async function runDetailedAccountingBenchmark(options, {
  signal = null, beforeReceiptPublication = null, afterAccountingRun = null,
} = {}) {
  if (options?.privateOperationApproved !== true) throw fail("approval_required");
  checkCancelled(signal);
  if (process.version !== "v26.2.0" || process.platform !== "darwin" || process.arch !== "arm64") {
    throw fail("runtime_invalid");
  }
  const roots = { baseline: await realpath(options.baselineRoot), candidate: await realpath(options.candidateRoot) };
  const revisions = { baseline: await revisionAt(roots.baseline, { signal }), candidate: await revisionAt(roots.candidate, { signal }) };
  const dependencies = {};
  for (const side of ["baseline", "candidate"]) dependencies[side] = await snapshotDetailedAccountingDependencies(roots[side], { signal });
  const dependenciesSha256 = validateDetailedAccountingDependencyPair(dependencies);
  const runtimePath = await realpath(process.execPath);
  const runtimeSha256 = await digestDetailedAccountingBenchmarkFile(runtimePath, null, { signal });
  const inputStat = await inspectDetailedAccountingBenchmarkIndex(options.indexFile);
  const indexSha256 = await digestDetailedAccountingBenchmarkFile(options.indexFile, inputStat, { signal });
  await privateDirectory(dirname(options.outputDirectory));
  checkCancelled(signal);
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
      checkCancelled(signal);
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
      const artifact = await verifyAccountingBenchmarkArtifact(resultFile, envelope, { signal });
      const validation = await probe(roots[side], resultFile, true, probeOptions);
      if (!exactKeys(validation, ["valid"]) || validation.valid !== true) throw fail("artifact_invalid");
      if (commonArtifact !== null && JSON.stringify(commonArtifact) !== JSON.stringify(artifact)) {
        throw fail("artifact_mismatch");
      }
      commonArtifact = artifact;
      rows.push({ side, run, warmup: run === 0, ...metrics });
      // Test-only coordination seam; the CLI never injects behavior here.
      if (afterAccountingRun !== null) await afterAccountingRun({ side, run });
    }
  }
  if (!sameFile(inputStat, await inspectDetailedAccountingBenchmarkIndex(options.indexFile))
      || await digestDetailedAccountingBenchmarkFile(options.indexFile, inputStat, { signal }) !== indexSha256) throw fail("index_changed");
  if (await digestDetailedAccountingBenchmarkFile(runtimePath, null, { signal }) !== runtimeSha256) throw fail("runtime_invalid");
  const finalDependencies = {};
  for (const side of ["baseline", "candidate"]) {
    if (await revisionAt(roots[side], { signal }) !== revisions[side]) throw fail("source_changed");
    finalDependencies[side] = await snapshotDetailedAccountingDependencies(roots[side], { signal });
    if (JSON.stringify(await probe(roots[side], options.indexFile, false, probeOptions))
        !== JSON.stringify(initial[side])) throw fail("index_changed");
  }
  validateDetailedAccountingDependencyPair(finalDependencies, dependencies);
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
    runs: rows, exactOutputMatch: true, indexUnchanged: true, sourceUnchanged: true, dependenciesSha256,
  });
  await publishDetailedAccountingBenchmarkReceipt(options.outputDirectory, receipt,
    { signal, beforePublish: beforeReceiptPublication });
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
