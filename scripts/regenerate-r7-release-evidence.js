import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runR7RealHistoryBenchmark } from "../src/r7-real-history-benchmark.js";
import { buildR7ReleaseDecisionReceipt } from "../src/r7-release-decision.js";
import {
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
  validateR7ReleaseEvidenceReceipt,
} from "../src/r7-release-evidence-schema.js";
import {
  stableJson,
  syncDirectory,
  writeJsonOwnerOnlyAtomic,
} from "../src/storage.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "src", "cli.js");
const PROFILE_FILES = Object.freeze({
  release_synthetic_semantics: "synthetic-semantics",
  release_synthetic_pressure: "synthetic-pressure",
  release_materialized_boundaries: "materialized-boundaries",
});
const INPUT_FILES = Object.freeze({
  syntheticSemantics: "synthetic-semantics",
  syntheticPressure: "synthetic-pressure",
  materializedBoundaries: "materialized-boundaries",
  realLocalHistory: "real-local-history",
});
const RUNTIMES = Object.freeze({
  node24: Object.freeze({
    version: "24.14.0",
    runtimeClass: "pinned_candidate",
    sha256: "20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55",
  }),
  node26: Object.freeze({
    version: "26.2.0",
    runtimeClass: "compatibility_crosscheck",
    sha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
  }),
});
const INSTALL_JOURNAL_NAME = ".r7-release-evidence-install-v1.json";
const INSTALL_JOURNAL_SCHEMA = "usage-monitor-r7-release-evidence-install-v1";
const GENERATION_MARKER_NAME = ".r7-release-evidence-generation-v1.json";
const GENERATION_MARKER_SCHEMA = "usage-monitor-r7-release-evidence-generation-v1";
const JOURNAL_CREATION_PREFIX = `${INSTALL_JOURNAL_NAME}.creating-`;
const MAXIMUM_CONTROL_FILE_BYTES = 64 * 1024;
const RETAINED_INTERVAL = Object.freeze({
  startAt: "2026-06-24T09:00:00.000Z",
  endAt: "2026-07-25T09:00:00.000Z",
});

function usage() {
  process.stderr.write(
    "Usage: node scripts/regenerate-r7-release-evidence.js "
      + "--node24 ABSOLUTE_PATH --node26 ABSOLUTE_PATH "
      + "--start-at ISO --end-at ISO [--destination DIR] --replace\n"
      + "   or: node scripts/regenerate-r7-release-evidence.js "
      + "--destination DIR --recover\n",
  );
}

function parseArgs(argv) {
  const options = {
    destination: join(ROOT, "generated"),
    replace: false,
    recover: false,
    decisionChild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--replace") {
      options.replace = true;
      continue;
    }
    if (name === "--recover") {
      options.recover = true;
      continue;
    }
    if (name === "--decision-child") {
      options.decisionChild = true;
      continue;
    }
    if (![
      "--node24",
      "--node26",
      "--start-at",
      "--end-at",
      "--destination",
      "--staging",
      "--runtime-key",
    ].includes(name)) {
      throw new TypeError("Unknown R7 regeneration argument");
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("R7 regeneration argument value is missing");
    }
    options[name.slice(2).replaceAll("-", "")] = value;
    index += 1;
  }
  return options;
}

function exactIso(value, name) {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${name} must be an exact ISO timestamp`);
  }
  return parsed;
}

function receiptFilename(profile, runtimeKey) {
  const shortProfile = profile.startsWith("release_")
    ? profile.slice("release_".length).replaceAll("_", "-")
    : profile;
  return `r7-release-${shortProfile}-node${RUNTIMES[runtimeKey].version}-v0.1.json`;
}

function expectedFilenames() {
  return Object.keys(RUNTIMES).flatMap((runtimeKey) => [
    ...Object.keys(PROFILE_FILES).map((profile) => receiptFilename(profile, runtimeKey)),
    receiptFilename("real-local-history", runtimeKey),
    receiptFilename("decision", runtimeKey),
  ]).sort();
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertSafeDirectory(path, { create = false } = {}) {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("R7 evidence directory must be an absolute path");
  }
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || stats.uid !== process.getuid()
      || (stats.mode & 0o022) !== 0) {
    throw new Error("R7 evidence directory is unsafe");
  }
  return path;
}

async function assertSafeReceipt(path, {
  maximumBytes = Number.MAX_SAFE_INTEGER,
  allowedLinkCounts = [1],
  requiredMode = 0o600,
} = {}) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()
      || stats.uid !== process.getuid()
      || !allowedLinkCounts.includes(stats.nlink)
      || (stats.mode & 0o022) !== 0
      || (requiredMode !== null && (stats.mode & 0o777) !== requiredMode)
      || stats.size > maximumBytes) {
    throw new Error(`R7 destination receipt is unsafe: ${basename(path)}`);
  }
  return stats;
}

function fileIdentity(stats) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
  };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryIdentity(stats, { generationId, role }) {
  return {
    ...fileIdentity(stats),
    generationId,
    role,
  };
}

function validGenerationId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function expectedOwnedDirectoryName(role, generationId) {
  return `.r7-release-evidence-${role}-${generationId}`;
}

function assertOwnedDirectoryPath(path, parent, role, generationId) {
  if (!isAbsolute(path)
      || dirname(path) !== parent
      || basename(path) !== expectedOwnedDirectoryName(role, generationId)) {
    throw new Error(`R7 ${role} directory path is invalid`);
  }
}

async function writeGenerationMarker(directory, { generationId, role }) {
  const markerPath = join(directory, GENERATION_MARKER_NAME);
  let handle;
  try {
    handle = await open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(stableJson({
      schemaVersion: GENERATION_MARKER_SCHEMA,
      generationId,
      role,
    }), "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncDirectory(directory);
}

async function readGenerationMarker(directory, { generationId, role }) {
  const markerPath = join(directory, GENERATION_MARKER_NAME);
  await assertSafeReceipt(markerPath, { maximumBytes: MAXIMUM_CONTROL_FILE_BYTES });
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (stableJson(marker) !== stableJson({
    schemaVersion: GENERATION_MARKER_SCHEMA,
    generationId,
    role,
  })) {
    throw new Error(`R7 ${role} generation marker is invalid`);
  }
  return marker;
}

async function createOwnedDirectory(path, { generationId, role }) {
  await mkdir(path, { mode: 0o700 });
  await syncDirectory(dirname(path));
  try {
    await writeGenerationMarker(path, { generationId, role });
  } catch (error) {
    // The durable journal remains authoritative. Recovery accepts an empty or
    // partial-marker directory only while its phase is still "creating".
    throw error;
  }
  const stats = await lstat(path);
  await assertSafeDirectory(path);
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`R7 ${role} directory mode is not owner-only`);
  }
  return directoryIdentity(stats, { generationId, role });
}

async function assertOwnedDirectoryIdentity(path, identity, {
  exactNames = null,
  allowedReceiptNames = null,
  allowAtomicTemps = false,
  allowEmptyWithoutMarker = false,
} = {}) {
  if (!identity || !validGenerationId(identity.generationId)
      || !["staging", "backup"].includes(identity.role)) {
    throw new Error("R7 owned-directory identity is invalid");
  }
  await assertSafeDirectory(path);
  const stats = await lstat(path);
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`R7 ${identity.role} directory mode is not owner-only`);
  }
  if (!sameFileIdentity(fileIdentity(stats), identity)) {
    throw new Error(`R7 ${identity.role} directory identity changed`);
  }
  const actual = (await readdir(path)).sort();
  if (allowEmptyWithoutMarker && actual.length === 0) {
    return { stats, names: actual };
  }
  if (!actual.includes(GENERATION_MARKER_NAME)) {
    throw new Error(`R7 ${identity.role} directory generation marker is missing`);
  }
  await readGenerationMarker(path, identity);
  if (exactNames !== null) {
    const expected = [GENERATION_MARKER_NAME, ...exactNames].sort();
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error(`R7 ${identity.role} directory inventory is not exact`);
    }
  } else if (allowedReceiptNames !== null) {
    const allowed = new Set(allowedReceiptNames);
    const seenBases = new Set();
    for (const name of actual) {
      if (name === GENERATION_MARKER_NAME) continue;
      let base = allowed.has(name) ? name : null;
      if (base === null && allowAtomicTemps) {
        base = allowedReceiptNames.find((candidate) => {
          const prefix = `${candidate}.`;
          if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
          const pid = name.slice(prefix.length, -".tmp".length);
          return /^[1-9][0-9]*$/u.test(pid);
        }) ?? null;
      }
      if (base === null || seenBases.has(base)) {
        throw new Error(`R7 ${identity.role} directory inventory contains unexpected entries`);
      }
      seenBases.add(base);
    }
  }
  for (const name of actual) {
    await assertSafeReceipt(join(path, name), {
      maximumBytes: name === GENERATION_MARKER_NAME
        ? MAXIMUM_CONTROL_FILE_BYTES
        : Number.MAX_SAFE_INTEGER,
      requiredMode: 0o600,
    });
  }
  return { stats, names: actual };
}

function removalPath(path, generationId) {
  return `${path}.removing-${generationId}`;
}

async function removeBoundOwnedDirectory(path, identity, inventory) {
  const quarantine = removalPath(path, identity.generationId);
  const sourceExists = await pathExists(path);
  const quarantineExists = await pathExists(quarantine);
  if (sourceExists && quarantineExists) {
    throw new Error(`R7 ${identity.role} cleanup found ambiguous directory paths`);
  }
  if (!sourceExists && !quarantineExists) return;
  let candidate = sourceExists ? path : quarantine;
  if (candidate === path) {
    await assertOwnedDirectoryIdentity(candidate, identity, inventory);
  } else {
    await assertOwnedDirectoryIdentity(candidate, identity, {
      allowedReceiptNames: inventory.exactNames ?? inventory.allowedReceiptNames,
      allowAtomicTemps: inventory.allowAtomicTemps ?? false,
      allowEmptyWithoutMarker: true,
    });
  }
  if (candidate === path) {
    await rename(path, quarantine);
    await syncDirectory(dirname(path));
    candidate = quarantine;
    // Revalidate after the atomic quarantine rename. If the pathname was
    // swapped between the first check and rename, refuse deletion.
    await assertOwnedDirectoryIdentity(candidate, identity, {
      allowedReceiptNames: inventory.exactNames ?? inventory.allowedReceiptNames,
      allowAtomicTemps: inventory.allowAtomicTemps ?? false,
      allowEmptyWithoutMarker: true,
    });
  }
  const retryInventory = {
    allowedReceiptNames: inventory.exactNames ?? inventory.allowedReceiptNames,
    allowAtomicTemps: inventory.allowAtomicTemps ?? false,
    allowEmptyWithoutMarker: true,
  };
  let state = await assertOwnedDirectoryIdentity(candidate, identity, retryInventory);
  for (const name of state.names.filter((entry) => entry !== GENERATION_MARKER_NAME)) {
    const entryPath = join(candidate, name);
    const entryStats = await assertSafeReceipt(entryPath);
    const entryIdentity = fileIdentity(entryStats);
    const beforeUnlink = await assertSafeReceipt(entryPath);
    if (!sameFileIdentity(entryIdentity, fileIdentity(beforeUnlink))) {
      throw new Error(`R7 ${identity.role} cleanup entry identity changed`);
    }
    await unlink(entryPath);
    await syncDirectory(candidate);
    state = await assertOwnedDirectoryIdentity(candidate, identity, retryInventory);
  }
  if (state.names.includes(GENERATION_MARKER_NAME)) {
    await readGenerationMarker(candidate, identity);
    const markerPath = join(candidate, GENERATION_MARKER_NAME);
    const markerStats = await assertSafeReceipt(markerPath, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    const markerIdentity = fileIdentity(markerStats);
    const markerBeforeUnlink = await assertSafeReceipt(markerPath, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    if (!sameFileIdentity(markerIdentity, fileIdentity(markerBeforeUnlink))) {
      throw new Error(`R7 ${identity.role} cleanup marker identity changed`);
    }
    await unlink(markerPath);
    await syncDirectory(candidate);
  }
  const finalStats = await lstat(candidate);
  if (!sameFileIdentity(fileIdentity(finalStats), identity)
      || (finalStats.mode & 0o777) !== 0o700
      || (await readdir(candidate)).length !== 0) {
    throw new Error(`R7 ${identity.role} cleanup directory changed before removal`);
  }
  await rmdir(candidate);
  await syncDirectory(dirname(path));
}

async function removeCreatingOwnedDirectory(path, { generationId, role }) {
  const quarantine = removalPath(path, generationId);
  const sourceExists = await pathExists(path);
  const quarantineExists = await pathExists(quarantine);
  if (sourceExists && quarantineExists) {
    throw new Error(`R7 partial ${role} cleanup found ambiguous directory paths`);
  }
  if (!sourceExists && !quarantineExists) return;
  let candidate = sourceExists ? path : quarantine;
  await assertSafeDirectory(candidate);
  const candidateStats = await lstat(candidate);
  if ((candidateStats.mode & 0o777) !== 0o700) {
    throw new Error(`R7 partial ${role} directory mode is not owner-only`);
  }
  let names = (await readdir(candidate)).sort();
  if (names.length > 1
      || (names.length === 1 && names[0] !== GENERATION_MARKER_NAME)) {
    throw new Error(`R7 partial ${role} directory contains unexpected entries`);
  }
  if (names.length === 1) {
    // A crash may leave a partial marker, so only its safe file shape is
    // required while the journal has not yet recorded a bound identity.
    await assertSafeReceipt(join(candidate, GENERATION_MARKER_NAME), {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
      requiredMode: 0o600,
    });
  }
  const originalStats = await lstat(candidate);
  const originalIdentity = fileIdentity(originalStats);
  if (candidate === path) {
    await rename(path, quarantine);
    await syncDirectory(dirname(path));
    candidate = quarantine;
    const renamedStats = await lstat(candidate);
    if (!sameFileIdentity(originalIdentity, fileIdentity(renamedStats))) {
      throw new Error(`R7 partial ${role} directory identity changed`);
    }
    names = (await readdir(candidate)).sort();
    if (names.length > 1
        || (names.length === 1 && names[0] !== GENERATION_MARKER_NAME)) {
      throw new Error(`R7 partial ${role} directory inventory changed`);
    }
  }
  if (names.includes(GENERATION_MARKER_NAME)) {
    const markerPath = join(candidate, GENERATION_MARKER_NAME);
    const markerStats = await assertSafeReceipt(markerPath, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    const markerIdentity = fileIdentity(markerStats);
    const markerBeforeUnlink = await assertSafeReceipt(markerPath, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    if (!sameFileIdentity(markerIdentity, fileIdentity(markerBeforeUnlink))) {
      throw new Error(`R7 partial ${role} marker identity changed`);
    }
    await unlink(markerPath);
    await syncDirectory(candidate);
  }
  const finalStats = await lstat(candidate);
  if (!sameFileIdentity(originalIdentity, fileIdentity(finalStats))
      || (finalStats.mode & 0o777) !== 0o700
      || (await readdir(candidate)).length !== 0) {
    throw new Error(`R7 partial ${role} cleanup directory changed before removal`);
  }
  await rmdir(candidate);
  await syncDirectory(dirname(path));
}

async function assertDestinationInventory(destination) {
  const expected = new Set(expectedFilenames());
  const releaseReceipts = (await readdir(destination))
    .filter((name) => name.startsWith("r7-release-") && name.endsWith(".json"));
  if (releaseReceipts.length !== expected.size
      || releaseReceipts.some((name) => !expected.has(name))) {
    throw new Error("R7 destination release-receipt inventory is not exact");
  }
  for (const name of expected) {
    await assertSafeReceipt(join(destination, name));
  }
}

function runtimeStatIdentity(stats, executable) {
  return {
    path: executable,
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: String(stats.size),
    mode: Number(stats.mode & 0o777n),
    uid: String(stats.uid),
    gid: String(stats.gid),
    nlink: String(stats.nlink),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

function runtimeFileIdentityProjection(value) {
  return {
    path: value?.path,
    dev: value?.dev,
    ino: value?.ino,
    size: value?.size,
    mode: value?.mode,
    uid: value?.uid,
    gid: value?.gid,
    nlink: value?.nlink,
    mtimeNs: value?.mtimeNs,
    ctimeNs: value?.ctimeNs,
    sha256: value?.sha256,
  };
}

function assertRuntimeStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink()
      || Number(stats.uid) !== process.getuid()
      || stats.nlink !== 1n
      || (stats.mode & 0o777n) !== 0o755n) {
    throw new Error("R7 runtime path must be an owner-controlled regular executable");
  }
}

async function captureRuntimeFileIdentity(executable) {
  if (typeof executable !== "string" || !isAbsolute(executable)
      || executable.includes("\0")) {
    throw new TypeError("R7 runtime executable must be an absolute path");
  }
  const before = await lstat(executable, { bigint: true });
  assertRuntimeStats(before);
  const handle = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let digest;
  try {
    const opened = await handle.stat({ bigint: true });
    assertRuntimeStats(opened);
    const beforeIdentity = runtimeStatIdentity(before, executable);
    if (stableJson(runtimeStatIdentity(opened, executable))
        !== stableJson(beforeIdentity)) {
      throw new Error("R7 runtime identity changed while it was opened");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    digest = hash.digest("hex");
    const afterRead = await handle.stat({ bigint: true });
    if (stableJson(runtimeStatIdentity(afterRead, executable))
        !== stableJson(beforeIdentity)) {
      throw new Error("R7 runtime identity changed while it was hashed");
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(executable, { bigint: true });
  const identity = runtimeStatIdentity(before, executable);
  if (stableJson(runtimeStatIdentity(after, executable)) !== stableJson(identity)) {
    throw new Error("R7 runtime path changed while its identity was captured");
  }
  return {
    ...identity,
    sha256: digest,
  };
}

export async function assertRuntimeIdentity(identity) {
  if (!Object.values(RUNTIMES).some((runtime) => runtime.sha256 === identity?.sha256)) {
    throw new Error("R7 runtime executable does not match an approved immutable digest");
  }
  const current = await captureRuntimeFileIdentity(identity?.path);
  if (stableJson(current)
      !== stableJson(runtimeFileIdentityProjection(identity))) {
    throw new Error("R7 runtime executable identity changed");
  }
  return identity;
}

async function invokeRuntime(identity, arguments_, options) {
  await assertRuntimeIdentity(identity);
  const result = await execFileAsync(identity.path, arguments_, options);
  await assertRuntimeIdentity(identity);
  return result;
}

export async function runtimeDetails(executable, runtimeKey) {
  if (!Object.hasOwn(RUNTIMES, runtimeKey)) {
    throw new TypeError("R7 runtime key is invalid");
  }
  const identity = await captureRuntimeFileIdentity(executable);
  if (identity.sha256 !== RUNTIMES[runtimeKey].sha256) {
    throw new Error(`R7 ${runtimeKey} executable does not match the approved immutable digest`);
  }
  const { stdout } = await invokeRuntime(
    identity,
    [
      "-p",
      "JSON.stringify({version:process.versions.node,platform:process.platform,"
        + "arch:process.arch,execPath:process.execPath})",
    ],
    {
      cwd: ROOT,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4_096,
    },
  );
  const value = JSON.parse(stdout.trim());
  if (value.version !== RUNTIMES[runtimeKey].version
      || value.platform !== "darwin"
      || value.arch !== "arm64"
      || value.execPath !== executable) {
    throw new Error(`R7 ${runtimeKey} executable is not the exact qualified macOS arm64 runtime`);
  }
  return {
    ...identity,
    version: value.version,
    platform: value.platform,
    arch: value.arch,
  };
}

async function readReceipt(directory, name) {
  const value = JSON.parse(await readFile(join(directory, name), "utf8"));
  const validation = validateR7ReleaseEvidenceReceipt(value);
  if (!validation.valid) {
    throw new Error(`R7 staged receipt failed validation: ${name}`);
  }
  if (value.contractProvenance.workloadCodeSha256
        !== R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256
      || value.contractProvenance.workloadCodeFileCount
        !== R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT) {
    throw new Error(`R7 staged receipt has stale source provenance: ${name}`);
  }
  return value;
}

async function writeDecisionChild(options) {
  if (process.env.USAGE_MONITOR_R7_DECISION_CHILD !== "1") {
    throw new Error("R7 decision child is internal to complete regeneration");
  }
  const runtimeKey = options.runtimekey;
  if (!Object.hasOwn(RUNTIMES, runtimeKey)) {
    throw new TypeError("R7 decision child runtime key is invalid");
  }
  const staging = await assertSafeDirectory(resolve(options.staging));
  const inputReceiptPairs = {};
  for (const [inputKey, profile] of Object.entries(INPUT_FILES)) {
    inputReceiptPairs[inputKey] = {
      node24: await readReceipt(staging, receiptFilename(profile, "node24")),
      node26: await readReceipt(staging, receiptFilename(profile, "node26")),
    };
  }
  const receipt = buildR7ReleaseDecisionReceipt({ inputReceiptPairs });
  if (receipt.runtimeProvenance.runtimeClass !== RUNTIMES[runtimeKey].runtimeClass) {
    throw new Error("R7 decision child ran under the wrong qualified runtime");
  }
  await writeJsonOwnerOnlyAtomic(
    join(staging, receiptFilename("decision", runtimeKey)),
    receipt,
  );
}

async function runProfile(runtimeIdentity, profile, output) {
  await invokeRuntime(
    runtimeIdentity,
    [CLI, "benchmark-r7", "--profile", profile, "--output", output],
    {
      cwd: ROOT,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      encoding: "utf8",
      timeout: 11 * 60 * 1_000,
      maxBuffer: 64 * 1024,
    },
  );
}

async function writeRealHistoryReceipts({
  node24,
  node26,
  startAt,
  endAt,
  staging,
}) {
  // The real-history module freezes one shared private plan before using both
  // runtimes. Revalidate both exact path identities immediately before handing
  // them to that bounded multi-runtime operation, and again after it returns.
  await assertRuntimeIdentity(node24);
  await assertRuntimeIdentity(node26);
  const receipts = await runR7RealHistoryBenchmark({
    startAt,
    endAt,
    runtimeExecutables: [node24.path, node26.path],
    temporaryRoot: tmpdir(),
  });
  await assertRuntimeIdentity(node24);
  await assertRuntimeIdentity(node26);
  if (receipts.length !== 2) {
    throw new Error("R7 real-history benchmark did not return both qualified runtimes");
  }
  for (const receipt of receipts) {
    const runtimeKey = receipt.runtimeProvenance.runtimeClass === "pinned_candidate"
      ? "node24"
      : receipt.runtimeProvenance.runtimeClass === "compatibility_crosscheck"
        ? "node26"
        : null;
    if (runtimeKey === null) {
      throw new Error("R7 real-history benchmark returned an unqualified runtime");
    }
    await writeJsonOwnerOnlyAtomic(
      join(staging, receiptFilename("real-local-history", runtimeKey)),
      receipt,
    );
  }
}

export async function validateCompleteStaging(staging, stagingIdentity) {
  const expected = expectedFilenames();
  await assertOwnedDirectoryIdentity(staging, stagingIdentity, {
    exactNames: expected,
  });
  for (const name of expected) await readReceipt(staging, name);
}

function journalPath(destination) {
  return join(dirname(destination), INSTALL_JOURNAL_NAME);
}

function journalCreationPath(destination, generationId) {
  return join(dirname(destination), `${JOURNAL_CREATION_PREFIX}${generationId}`);
}

function validDirectoryIdentity(value, role, generationId) {
  return value
    && typeof value.dev === "string"
    && typeof value.ino === "string"
    && value.role === role
    && value.generationId === generationId;
}

function validJournalRuntimeIdentities(value) {
  return value
    && stableJson(Object.keys(value).sort())
      === stableJson(Object.keys(RUNTIMES).sort())
    && new Set(Object.values(value).map((identity) => identity?.path)).size === 2
    && Object.keys(RUNTIMES).every((key) => {
      const identity = value[key];
      return identity
        && identity.path && isAbsolute(identity.path)
        && typeof identity.dev === "string"
        && typeof identity.ino === "string"
        && typeof identity.size === "string"
        && identity.mode === 0o755
        && identity.uid === String(process.getuid())
        && identity.nlink === "1"
        && identity.sha256 === RUNTIMES[key].sha256
        && identity.version === RUNTIMES[key].version
        && identity.platform === "darwin"
        && identity.arch === "arm64";
    });
}

async function readInstallJournal(destination) {
  const path = journalPath(destination);
  const pathStats = await assertSafeReceipt(path, {
    maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    allowedLinkCounts: [1, 2],
  });
  const journal = JSON.parse(await readFile(path, "utf8"));
  const parent = dirname(destination);
  if (journal?.schemaVersion !== INSTALL_JOURNAL_SCHEMA
      || ![
        "creating",
        "generating",
        "creating_backup",
        "installing",
        "installed",
      ].includes(journal.phase)
      || !validGenerationId(journal.generationId)
      || journal.destination !== destination
      || !validJournalRuntimeIdentities(journal.runtimeIdentities)
      || stableJson(journal.expected) !== stableJson(expectedFilenames())) {
    throw new Error("R7 evidence install journal is invalid");
  }
  assertOwnedDirectoryPath(
    journal.staging,
    parent,
    "staging",
    journal.generationId,
  );
  const stagingBound = ["generating", "creating_backup", "installing", "installed"]
    .includes(journal.phase);
  if (stagingBound
      ? !validDirectoryIdentity(
        journal.stagingIdentity,
        "staging",
        journal.generationId,
      )
      : journal.stagingIdentity !== null) {
    throw new Error("R7 evidence install journal has an invalid staging identity");
  }
  const hasBackup = ["creating_backup", "installing", "installed"].includes(journal.phase);
  if (hasBackup) {
    assertOwnedDirectoryPath(
      journal.backup,
      parent,
      "backup",
      journal.generationId,
    );
  } else if (journal.backup !== null) {
    throw new Error("R7 evidence install journal has an unexpected backup path");
  }
  const backupBound = ["installing", "installed"].includes(journal.phase);
  if (backupBound
      ? !validDirectoryIdentity(
        journal.backupIdentity,
        "backup",
        journal.generationId,
      )
      : journal.backupIdentity !== null) {
    throw new Error("R7 evidence install journal has an invalid backup identity");
  }
  if (journal.creationDraft !== null) {
    if (journal.phase !== "creating"
        || journal.creationDraft
          !== journalCreationPath(destination, journal.generationId)) {
      throw new Error("R7 evidence install journal has an invalid creation draft");
    }
  }
  if (pathStats.nlink === 2) {
    if (journal.creationDraft === null || !(await pathExists(journal.creationDraft))) {
      throw new Error("R7 journal has an unbound hard link");
    }
    const draftStats = await assertSafeReceipt(journal.creationDraft, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
      allowedLinkCounts: [2],
    });
    if (!sameFileIdentity(fileIdentity(pathStats), fileIdentity(draftStats))) {
      throw new Error("R7 journal creation hard-link identity changed");
    }
  }
  return {
    ...journal,
    path,
    pathIdentity: fileIdentity(pathStats),
  };
}

async function unlinkDurable(path) {
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function unlinkBoundReceipt(path, identity, {
  allowedLinkCounts = [1],
} = {}) {
  const stats = await assertSafeReceipt(path, {
    maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    allowedLinkCounts,
  });
  if (!sameFileIdentity(fileIdentity(stats), identity)) {
    throw new Error(`R7 control-file identity changed: ${basename(path)}`);
  }
  await unlinkDurable(path);
}

async function writeInstallJournalDurable(destination, value) {
  const path = journalPath(destination);
  await writeJsonOwnerOnlyAtomic(path, value);
  const stats = await assertSafeReceipt(path, {
    maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
  });
  return fileIdentity(stats);
}

async function createInstallJournalExclusive({
  destination,
  staging,
  generationId,
  runtimeIdentities,
}) {
  const path = journalPath(destination);
  const creationDraft = journalCreationPath(destination, generationId);
  const journal = {
    schemaVersion: INSTALL_JOURNAL_SCHEMA,
    phase: "creating",
    generationId,
    destination,
    staging,
    stagingIdentity: null,
    backup: null,
    backupIdentity: null,
    creationDraft,
    expected: expectedFilenames(),
    runtimeIdentities,
  };
  let handle;
  let draftCreated = false;
  try {
    handle = await open(
      creationDraft,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    draftCreated = true;
    await handle.writeFile(stableJson(journal), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(dirname(path));
    // A hard-link publication is both atomic and no-clobber. No observer can
    // ever see a partially-written journal at the authoritative pathname.
    await link(creationDraft, path);
    await syncDirectory(dirname(path));
    const pathStats = await lstat(path);
    const draftStats = await lstat(creationDraft);
    for (const stats of [pathStats, draftStats]) {
      if (!stats.isFile() || stats.isSymbolicLink()
          || stats.uid !== process.getuid()
          || stats.nlink !== 2
          || (stats.mode & 0o777) !== 0o600
          || stats.size > MAXIMUM_CONTROL_FILE_BYTES) {
        throw new Error("R7 journal publication hard link was unsafe");
      }
    }
    if (!sameFileIdentity(fileIdentity(pathStats), fileIdentity(draftStats))) {
      throw new Error("R7 journal publication identity did not match its durable draft");
    }
    await unlinkDurable(creationDraft);
    await assertSafeReceipt(path, { maximumBytes: MAXIMUM_CONTROL_FILE_BYTES });
    const durable = {
      ...journal,
      creationDraft: null,
    };
    const pathIdentity = await writeInstallJournalDurable(destination, durable);
    return { ...durable, path, pathIdentity };
  } catch (error) {
    await handle?.close().catch(() => {});
    // Leave a created draft in place. `--recover` recognizes that exact
    // owner-only prefix and can safely clear either a partial or full draft.
    if (!draftCreated) {
      await unlink(creationDraft).catch(() => {});
    }
    throw new Error(
      error?.code === "EEXIST"
        ? "Another or interrupted R7 evidence regeneration must be recovered first"
        : "R7 evidence regeneration lock could not be created",
    );
  }
}

async function partialJournalDrafts(destination) {
  const parent = dirname(destination);
  return (await readdir(parent))
    .filter((name) => name.startsWith(JOURNAL_CREATION_PREFIX))
    .map((name) => join(parent, name))
    .sort();
}

async function recoverPartialJournalCreation(destination) {
  const drafts = await partialJournalDrafts(destination);
  if (drafts.length === 0) {
    throw new Error("No interrupted R7 evidence install is available to recover");
  }
  for (const draft of drafts) {
    const suffix = basename(draft).slice(JOURNAL_CREATION_PREFIX.length);
    if (!validGenerationId(suffix)) {
      throw new Error("R7 partial journal draft name is invalid");
    }
    const stats = await assertSafeReceipt(draft, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    await unlinkBoundReceipt(draft, fileIdentity(stats));
  }
  return "discarded_partial_journal_creation";
}

async function recoverInterruptedInstall(destination) {
  if (!(await pathExists(journalPath(destination)))) {
    return recoverPartialJournalCreation(destination);
  }
  const journal = await readInstallJournal(destination);
  if (journal.creationDraft !== null && await pathExists(journal.creationDraft)) {
    const draftStats = await assertSafeReceipt(journal.creationDraft, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
      allowedLinkCounts: [2],
    });
    if (!sameFileIdentity(journal.pathIdentity, fileIdentity(draftStats))) {
      throw new Error("R7 journal creation draft identity changed");
    }
    await unlinkBoundReceipt(
      journal.creationDraft,
      fileIdentity(draftStats),
      { allowedLinkCounts: [2] },
    );
  }
  if (journal.phase === "creating") {
    await removeCreatingOwnedDirectory(journal.staging, {
      generationId: journal.generationId,
      role: "staging",
    });
    await unlinkBoundReceipt(journal.path, journal.pathIdentity);
    return "discarded_partial_creation";
  }
  if (journal.phase === "generating") {
    await removeBoundOwnedDirectory(
      journal.staging,
      journal.stagingIdentity,
      {
        allowedReceiptNames: journal.expected,
        allowAtomicTemps: true,
      },
    );
    await unlinkBoundReceipt(journal.path, journal.pathIdentity);
    return "discarded_incomplete_generation";
  }
  if (journal.phase === "creating_backup") {
    await removeCreatingOwnedDirectory(journal.backup, {
      generationId: journal.generationId,
      role: "backup",
    });
    await removeBoundOwnedDirectory(
      journal.staging,
      journal.stagingIdentity,
      { exactNames: journal.expected },
    );
    await unlinkBoundReceipt(journal.path, journal.pathIdentity);
    return "discarded_incomplete_install";
  }
  if (journal.phase === "installed") {
    await assertDestinationInventory(destination);
    // "installed" is written only after the complete destination matrix has
    // validated against the then-current source contract. Recovery trusts that
    // durable commit marker even if source files changed after a machine crash;
    // the ordinary retained-evidence test will then require regeneration.
    await removeBoundOwnedDirectory(
      journal.backup,
      journal.backupIdentity,
      { exactNames: journal.expected },
    );
    await removeBoundOwnedDirectory(
      journal.staging,
      journal.stagingIdentity,
      { exactNames: [] },
    );
    await recoverPartialJournalDraftsAfterJournal(destination);
    const refreshed = await readInstallJournal(destination);
    await unlinkBoundReceipt(refreshed.path, refreshed.pathIdentity);
    return "completed";
  }
  await assertOwnedDirectoryIdentity(journal.backup, journal.backupIdentity, {
    allowedReceiptNames: journal.expected,
  });
  await assertOwnedDirectoryIdentity(journal.staging, journal.stagingIdentity, {
    allowedReceiptNames: journal.expected,
  });
  for (const name of journal.expected) {
    const backupFile = join(journal.backup, name);
    if (!(await pathExists(backupFile))) continue;
    await assertSafeReceipt(backupFile);
    const destinationFile = join(destination, name);
    const stagingFile = join(journal.staging, name);
    if (await pathExists(destinationFile)) {
      await assertSafeReceipt(destinationFile);
      if (await pathExists(stagingFile)) {
        throw new Error("R7 evidence recovery found an ambiguous staged receipt");
      }
      await rename(destinationFile, stagingFile);
    }
    await rename(backupFile, destinationFile);
  }
  await syncDirectory(destination);
  await syncDirectory(journal.backup);
  await syncDirectory(journal.staging);
  await assertDestinationInventory(destination);
  await removeBoundOwnedDirectory(
    journal.backup,
    journal.backupIdentity,
    { exactNames: [] },
  );
  await removeBoundOwnedDirectory(
    journal.staging,
    journal.stagingIdentity,
    { exactNames: journal.expected },
  );
  await recoverPartialJournalDraftsAfterJournal(destination);
  const refreshed = await readInstallJournal(destination);
  await unlinkBoundReceipt(refreshed.path, refreshed.pathIdentity);
  return "rolled_back";
}

async function recoverPartialJournalDraftsAfterJournal(destination) {
  const drafts = await partialJournalDrafts(destination);
  for (const draft of drafts) {
    const suffix = basename(draft).slice(JOURNAL_CREATION_PREFIX.length);
    if (!validGenerationId(suffix)) {
      throw new Error("R7 partial journal draft name is invalid");
    }
    const stats = await assertSafeReceipt(draft, {
      maximumBytes: MAXIMUM_CONTROL_FILE_BYTES,
    });
    await unlinkBoundReceipt(draft, fileIdentity(stats));
  }
}

async function installReceipts(staging, destination) {
  const expected = expectedFilenames();
  const active = await readInstallJournal(destination);
  if (active.phase !== "generating" || active.staging !== staging) {
    throw new Error("R7 evidence generation lock does not match the staged matrix");
  }
  await validateCompleteStaging(staging, active.stagingIdentity);
  await assertDestinationInventory(destination);
  const backup = join(
    dirname(destination),
    expectedOwnedDirectoryName("backup", active.generationId),
  );
  await writeInstallJournalDurable(destination, {
    ...active,
    path: undefined,
    pathIdentity: undefined,
    phase: "creating_backup",
    backup,
    backupIdentity: null,
  });
  const backupIdentity = await createOwnedDirectory(backup, {
    generationId: active.generationId,
    role: "backup",
  });
  const journal = {
    ...active,
    path: undefined,
    pathIdentity: undefined,
    phase: "installing",
    backup,
    backupIdentity,
    creationDraft: null,
  };
  await writeInstallJournalDurable(destination, journal);
  try {
    for (const name of expected) {
      await assertSafeReceipt(join(destination, name));
      await rename(join(destination, name), join(backup, name));
    }
    await syncDirectory(destination);
    await syncDirectory(backup);
    for (const name of expected) {
      await assertSafeReceipt(join(staging, name));
      await rename(join(staging, name), join(destination, name));
    }
    await syncDirectory(staging);
    await syncDirectory(destination);
    await assertDestinationInventory(destination);
    for (const name of expected) await readReceipt(destination, name);
    await writeInstallJournalDurable(destination, {
      ...journal,
      phase: "installed",
    });
    await removeBoundOwnedDirectory(
      backup,
      backupIdentity,
      { exactNames: expected },
    );
    await removeBoundOwnedDirectory(
      staging,
      active.stagingIdentity,
      { exactNames: [] },
    );
    await recoverPartialJournalDraftsAfterJournal(destination);
    const completed = await readInstallJournal(destination);
    await unlinkBoundReceipt(completed.path, completed.pathIdentity);
  } catch (error) {
    try {
      await recoverInterruptedInstall(destination);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `R7 evidence install failed; run --destination ${destination} --recover`,
      );
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.decisionChild) {
    await writeDecisionChild(options);
    return;
  }
  if (process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.version !== "v26.2.0") {
    throw new Error("R7 regeneration driver must be exact Node 26.2.0 on macOS arm64");
  }
  const destination = await assertSafeDirectory(resolve(options.destination));
  await assertSafeDirectory(dirname(destination));
  if (options.recover) {
    if (options.replace || options.node24 || options.node26
        || options.startat || options.endat) {
      throw new Error("--recover accepts only an optional --destination");
    }
    const outcome = await recoverInterruptedInstall(destination);
    process.stdout.write(`R7 release evidence recovery: ${outcome}\n`);
    return;
  }
  if (!options.replace) {
    throw new Error("R7 retained evidence replacement requires --replace");
  }
  const startMs = exactIso(options.startat, "--start-at");
  const endMs = exactIso(options.endat, "--end-at");
  if (endMs - startMs !== 31 * 24 * 60 * 60 * 1_000) {
    throw new Error("R7 retained real-history evidence requires exactly 31 days");
  }
  if (options.startat !== RETAINED_INTERVAL.startAt
      || options.endat !== RETAINED_INTERVAL.endAt) {
    throw new Error("R7 retained evidence requires the preregistered frozen interval");
  }
  const node24 = await runtimeDetails(options.node24, "node24");
  const node26 = await runtimeDetails(options.node26, "node26");
  await assertDestinationInventory(destination);
  if (await pathExists(journalPath(destination))
      || (await partialJournalDrafts(destination)).length > 0) {
    throw new Error(
      "Another or interrupted R7 evidence regeneration must be recovered first",
    );
  }
  const generationId = randomUUID();
  const staging = join(
    dirname(destination),
    expectedOwnedDirectoryName("staging", generationId),
  );
  await createInstallJournalExclusive({
    destination,
    staging,
    generationId,
    runtimeIdentities: { node24, node26 },
  });
  let installed = false;
  try {
    const stagingIdentity = await createOwnedDirectory(staging, {
      generationId,
      role: "staging",
    });
    const creatingJournal = await readInstallJournal(destination);
    await writeInstallJournalDurable(destination, {
      ...creatingJournal,
      path: undefined,
      pathIdentity: undefined,
      phase: "generating",
      stagingIdentity,
      creationDraft: null,
    });
    for (const [runtimeKey, executable] of Object.entries({ node24, node26 })) {
      for (const profile of Object.keys(PROFILE_FILES)) {
        await runProfile(
          executable,
          profile,
          join(staging, receiptFilename(profile, runtimeKey)),
        );
      }
    }
    await writeRealHistoryReceipts({
      node24,
      node26,
      startAt: options.startat,
      endAt: options.endat,
      staging,
    });
    for (const [runtimeKey, executable] of Object.entries({ node24, node26 })) {
      await invokeRuntime(
        executable,
        [
          fileURLToPath(import.meta.url),
          "--decision-child",
          "--staging",
          staging,
          "--runtime-key",
          runtimeKey,
        ],
        {
          cwd: ROOT,
          env: {
            LANG: "C",
            LC_ALL: "C",
            TZ: "UTC",
            USAGE_MONITOR_R7_DECISION_CHILD: "1",
          },
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        },
      );
    }
    await validateCompleteStaging(staging, stagingIdentity);
    await installReceipts(staging, destination);
    installed = true;
  } catch (error) {
    if (await pathExists(journalPath(destination))) {
      try {
        await recoverInterruptedInstall(destination);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `R7 regeneration failed; run --destination ${destination} --recover`,
        );
      }
    }
    throw error;
  }
  if (!installed) throw new Error("R7 release evidence was not installed");
  process.stdout.write(
    `R7 release evidence: regenerated ${expectedFilenames().length} validated receipts; `
      + `source files ${R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT}; `
      + `source SHA-256 ${R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256}\n`,
  );
}

const DIRECT_ENTRY_PATH = process.argv[1] ? resolve(process.argv[1]) : null;
if (DIRECT_ENTRY_PATH === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    usage();
    process.stderr.write(`${error instanceof Error ? error.message : "R7 regeneration failed"}\n`);
    process.exitCode = 1;
  });
}
