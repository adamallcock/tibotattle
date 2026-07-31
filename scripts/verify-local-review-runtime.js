#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { buildLocalReviewArtifact } from "./build-local-review-artifact.js";
import {
  filesAreByteIdentical,
  safeExtractLocalReviewArchive,
  sha256File,
  validateExtractedLocalReviewArtifact,
  validateLocalReviewBuildCandidate,
} from "./lib/local-review-artifact-archive.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = dirname(SCRIPT_FILE);
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const NATIVE_AUDIT_BUILDER = join(
  SCRIPT_DIRECTORY,
  "build-native-network-audit.js",
);
const SMOKE_RUNNER = join(
  SCRIPT_DIRECTORY,
  "smoke-local-review-artifact.js",
);
const ARCHIVE_HELPER = join(
  SCRIPT_DIRECTORY,
  "lib",
  "local-review-artifact-archive.mjs",
);
const OUTPUT_MARKER = ".usage-monitor-local-review-runtime-root-v0.1";
const OUTPUT_MARKER_BYTES =
  "usage monitor generated local-review runtime root v0.1\n";
const RECEIPT_SCHEMA = "usage-monitor-local-review-runtime-v0.1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_LIFECYCLE_INVOCATIONS = Object.freeze([
  "inspect-artifact",
  "install",
  "doctor",
  "inspect-export",
  "export-local",
  "verify-bundle",
  "export-set",
  "verify-export-set",
  "delete-local-export-preflight",
  "delete-local-export-confirmed",
  "uninstall-preflight",
  "uninstall-confirmed",
]);

function fail(message, code = "LOCAL_REVIEW_RUNTIME_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256Value(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function prepareOutputRoot(output) {
  const canonical = resolve(output);
  const repositoryRelativePath = relative(REPOSITORY_ROOT, canonical);
  const parts = repositoryRelativePath.split(sep);
  if (
    parts.length !== 2
    || ![".release-build", ".release-repro"].includes(parts[0])
    || parts[1] === ""
    || parts[1] === "."
    || parts[1] === ".."
  ) {
    fail(
      "Runtime output must be one named directory directly inside "
      + ".release-build or .release-repro",
    );
  }
  const reservedRoot = join(REPOSITORY_ROOT, parts[0]);
  await mkdir(reservedRoot, { recursive: true, mode: 0o700 });
  const reservedMetadata = await lstat(reservedRoot);
  if (
    !reservedMetadata.isDirectory()
    || reservedMetadata.isSymbolicLink()
    || await realpath(reservedRoot) !== reservedRoot
  ) {
    fail("Reserved release root must be a real directory");
  }

  const marker = join(canonical, OUTPUT_MARKER);
  try {
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("Runtime output exists and is not a regular directory");
    }
    if (await realpath(canonical) !== canonical) {
      fail("Runtime output must not traverse a symbolic link");
    }
    const markerMetadata = await lstat(marker).catch((error) => {
      if (error?.code === "ENOENT") {
        fail("Refusing to replace an unmarked runtime output");
      }
      throw error;
    });
    if (
      !markerMetadata.isFile()
      || markerMetadata.isSymbolicLink()
      || await readFile(marker, "utf8") !== OUTPUT_MARKER_BYTES
    ) {
      fail("Refusing to replace a runtime output with an invalid marker");
    }
    await rm(canonical, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(canonical, { mode: 0o700 });
  await chmod(canonical, 0o700);
  await writeFile(marker, OUTPUT_MARKER_BYTES, {
    flag: "wx",
    mode: 0o600,
  });
  return canonical;
}

function parseSourceEpoch(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("Source date epoch must be a non-negative safe integer");
  }
  return parsed;
}

function defaultSourceEpoch() {
  if (process.env.SOURCE_DATE_EPOCH !== undefined) {
    return parseSourceEpoch(process.env.SOURCE_DATE_EPOCH);
  }
  return parseSourceEpoch(execFileSync(
    "git",
    ["show", "-s", "--format=%ct", "HEAD"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  ).trim());
}

function parseArgs(argv) {
  let output = null;
  let sourceEpoch = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--output", "--source-date-epoch"].includes(argument)) {
      fail(`Unknown argument: ${argument}`);
    }
    if (!value || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    if (argument === "--output") output = resolve(value);
    if (argument === "--source-date-epoch") {
      sourceEpoch = parseSourceEpoch(value);
    }
    index += 1;
  }
  if (!output) fail("--output is required");
  return {
    output,
    sourceEpoch: sourceEpoch ?? defaultSourceEpoch(),
  };
}

function runNodeScript(script, args, label, timeout) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message)
      .trim()
      .slice(0, 4096);
    fail(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function boundedOwnerOnlyFile(path, label, maximumBytes) {
  const metadata = await lstat(path).catch(() => fail(`${label} is missing`));
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size <= 0
    || metadata.size > maximumBytes
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    fail(`${label} must be a bounded owner-only regular file`);
  }
  return metadata;
}

async function readBoundedJson(path, label, maximumBytes) {
  await boundedOwnerOnlyFile(path, label, maximumBytes);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

export function validateRuntimeSmokeReceipt(smoke, {
  archiveBytes,
  archiveSha256,
  manifestSha256,
  nativeAuditLibrarySha256,
}) {
  if (
    smoke?.schemaVersion
      !== "usage-monitor-local-review-artifact-smoke-v0.1"
    || smoke?.artifactArchiveBytes !== archiveBytes
    || smoke?.artifactArchiveSha256 !== archiveSha256
    || smoke?.artifactManifestSha256 !== manifestSha256
    || smoke?.nativeAuditLibrarySha256 !== nativeAuditLibrarySha256
    || smoke?.denyNetwork !== true
    || smoke?.auditedProcessCount !== 12
    || smoke?.javascriptNetworkAttempts !== 0
    || smoke?.nativeAuditedProcessCount !== 12
    || smoke?.nativeNetworkLibcAttempts !== 0
    || smoke?.nativeNetworkEnforcement !== "sandbox-exec_deny_network"
    || smoke?.launcherParityVerified !== true
    || smoke?.commandCount !== 12
    || !Array.isArray(smoke?.commands)
    || JSON.stringify(smoke.commands)
      !== JSON.stringify(REQUIRED_LIFECYCLE_INVOCATIONS)
    || smoke?.localBundleVerified !== true
    || smoke?.exportSetVerified !== true
    || smoke?.completeSetDeletionVerified !== true
    || smoke?.privateCanaryHits !== 0
    || smoke?.installVerified !== true
    || smoke?.uninstallVerified !== true
    || smoke?.participantIdentityPreserved !== true
    || smoke?.secureErasureClaimed !== false
    || smoke?.result !== "passed"
  ) {
    fail("Runtime smoke receipt did not match its closed release contract");
  }
  return {
    javascriptNetworkAttempts: 0,
    lifecycleInvocations: 12,
    nativeNetworkLibcAttempts: 0,
    privateCanaryHits: 0,
  };
}

async function writeReceipt(path, value) {
  const handle = await open(path, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") {
      fail("Runtime receipt already exists", "LOCAL_REVIEW_RUNTIME_OUTPUT_EXISTS");
    }
    throw error;
  });
  try {
    await handle.writeFile(stableJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyLocalReviewRuntime({ output, sourceEpoch }, {
  buildArtifact = buildLocalReviewArtifact,
  compareFiles = filesAreByteIdentical,
  extractArchive = safeExtractLocalReviewArchive,
  hashFile = sha256File,
  runScript = runNodeScript,
  validateBuildCandidate = validateLocalReviewBuildCandidate,
  validateExtractedArtifact = validateExtractedLocalReviewArtifact,
} = {}) {
  sourceEpoch = parseSourceEpoch(sourceEpoch);
  const runtimeRoot = await prepareOutputRoot(output);
  const first = await buildArtifact({
    buildRoot: join(runtimeRoot, "build-a"),
    sourceEpoch,
  });
  const second = await buildArtifact({
    buildRoot: join(runtimeRoot, "build-b"),
    sourceEpoch,
  });
  const firstReceiptPath = join(
    dirname(first.artifactRoot),
    `${basename(first.artifactRoot)}.build-receipt.json`,
  );
  const secondReceiptPath = join(
    dirname(second.artifactRoot),
    `${basename(second.artifactRoot)}.build-receipt.json`,
  );
  const [firstCandidate, secondCandidate] = await Promise.all([
    validateBuildCandidate({
      archivePath: first.archivePath,
      buildReceiptPath: firstReceiptPath,
    }),
    validateBuildCandidate({
      archivePath: second.archivePath,
      buildReceiptPath: secondReceiptPath,
    }),
  ]);
  const firstManifest = join(first.artifactRoot, "artifact-manifest.json");
  const secondManifest = join(second.artifactRoot, "artifact-manifest.json");
  const [archivesIdentical, manifestsIdentical] = await Promise.all([
    compareFiles(first.archivePath, second.archivePath),
    compareFiles(firstManifest, secondManifest),
  ]);
  const buildReceiptsIdentical = await compareFiles(
    firstReceiptPath,
    secondReceiptPath,
  );
  if (
    !archivesIdentical
    || !manifestsIdentical
    || !buildReceiptsIdentical
    || firstCandidate.archiveSha256 !== secondCandidate.archiveSha256
    || firstCandidate.buildReceipt.manifestSha256
      !== secondCandidate.buildReceipt.manifestSha256
    || firstCandidate.buildReceipt.sourceInputSha256
      !== secondCandidate.buildReceipt.sourceInputSha256
    || JSON.stringify(firstCandidate.buildReceipt.components)
      !== JSON.stringify(secondCandidate.buildReceipt.components)
  ) {
    fail("Two same-epoch local-review builds were not byte-identical");
  }

  const extractedParent = join(runtimeRoot, "extracted");
  await mkdir(extractedParent, { mode: 0o700 });
  await chmod(extractedParent, 0o700);
  const extractedArchive = join(
    extractedParent,
    basename(first.archivePath),
  );
  await copyFile(
    first.archivePath,
    extractedArchive,
    constants.COPYFILE_EXCL,
  );
  await chmod(extractedArchive, 0o600);
  const extraction = await extractArchive({
    archivePath: extractedArchive,
    destinationParent: extractedParent,
    expectedRootName: firstCandidate.buildReceipt.rootName,
  });
  if (
    extraction.archiveBytes !== firstCandidate.archiveBytes
    || extraction.archiveSha256 !== firstCandidate.archiveSha256
  ) {
    fail("Extracted archive bytes did not match the validated build candidate");
  }
  const extractedValidation = await validateExtractedArtifact({
    artifactRoot: extraction.artifactRoot,
    buildReceipt: firstCandidate.buildReceipt,
  });

  const nativeAuditLibrary = join(
    runtimeRoot,
    "native",
    "libusage_monitor_network_audit.dylib",
  );
  runScript(
    NATIVE_AUDIT_BUILDER,
    ["--output", nativeAuditLibrary],
    "Native network audit build",
    120_000,
  );
  await boundedOwnerOnlyFile(
    nativeAuditLibrary,
    "Native network audit library",
    4 * 1024 * 1024,
  );
  const nativeAuditLibrarySha256 = await hashFile(nativeAuditLibrary);

  const receiptDirectory = join(runtimeRoot, "receipts");
  await mkdir(receiptDirectory, { mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  const smokeReceiptPath = join(receiptDirectory, "artifact-smoke.json");
  runScript(
    SMOKE_RUNNER,
    [
      "--artifact-root",
      extraction.artifactRoot,
      "--archive",
      extractedArchive,
      "--native-audit-library",
      nativeAuditLibrary,
      "--output",
      smokeReceiptPath,
    ],
    "Extracted local-review runtime smoke",
    15 * 60_000,
  );
  const smoke = await readBoundedJson(
    smokeReceiptPath,
    "Runtime smoke receipt",
    512 * 1024,
  );
  const smokeSummary = validateRuntimeSmokeReceipt(smoke, {
    archiveBytes: firstCandidate.archiveBytes,
    archiveSha256: firstCandidate.archiveSha256,
    manifestSha256: firstCandidate.buildReceipt.manifestSha256,
    nativeAuditLibrarySha256,
  });

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    sourceDateEpoch: sourceEpoch,
    sourceInputSha256: firstCandidate.buildReceipt.sourceInputSha256,
    verificationSources: {
      archiveHelperSha256: await hashFile(ARCHIVE_HELPER),
      artifactBuilderSha256: await hashFile(
        join(SCRIPT_DIRECTORY, "build-local-review-artifact.js"),
      ),
      nativeAuditBuilderSha256: await hashFile(NATIVE_AUDIT_BUILDER),
      runtimeVerifierSha256: await hashFile(SCRIPT_FILE),
      smokeRunnerSha256: await hashFile(SMOKE_RUNNER),
    },
    reproducibility: {
      archiveBytes: firstCandidate.archiveBytes,
      archiveSha256: firstCandidate.archiveSha256,
      archivesByteIdentical: true,
      buildCount: 2,
      buildReceiptsByteIdentical: true,
      buildReceiptSha256: firstCandidate.buildReceiptSha256,
      componentSetSha256: sha256Value(
        firstCandidate.buildReceipt.components,
      ),
      manifestSha256: firstCandidate.buildReceipt.manifestSha256,
      manifestsByteIdentical: true,
      secondBuildReceiptSha256: secondCandidate.buildReceiptSha256,
    },
    extraction: {
      entryCount: extraction.entryCount,
      extractedBytes: extraction.extractedBytes,
      extractedInventorySha256: sha256Value(extraction.entries),
      ownerOnly: extraction.ownerOnly,
      runCostPayloadFiles: extractedValidation.runCostPayloadFiles,
      validatedFileCount: extractedValidation.fileCount,
    },
    nativeAuditLibrarySha256,
    smoke: {
      ...smokeSummary,
      receiptSha256: await hashFile(smokeReceiptPath),
    },
    privateContentIncluded: false,
    signing: "unsigned",
    notarization: "not_notarized",
    externalParticipantsAuthorized: false,
    result: "passed",
  };
  const runtimeReceiptPath = join(
    receiptDirectory,
    "local-review-runtime.json",
  );
  await writeReceipt(runtimeReceiptPath, receipt);
  return {
    receipt,
    runtimeReceiptPath,
    runtimeRoot,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  const options = parseArgs(process.argv.slice(2));
  verifyLocalReviewRuntime(options).then(({ receipt, runtimeReceiptPath }) => {
    console.log("Local-review runtime qualification: passed");
    console.log(`Receipt: ${runtimeReceiptPath}`);
    console.log(`Archive SHA-256: ${receipt.reproducibility.archiveSha256}`);
    console.log("Same-epoch builds byte-identical: true");
    console.log("Required lifecycle invocations: 12");
    console.log("JavaScript and native covered network attempts: 0");
    console.log("Private content included: false");
  }).catch((error) => {
    console.error(`verify-local-review-runtime: ${error.message}`);
    process.exitCode = 1;
  });
}
