#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const RECEIPT_SCHEMA =
  "usage-monitor-local-review-signing-readiness-v0.1";
const EXPECTED_ARTIFACT =
  "usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64";
const KEYTAR_RELATIVE_PATH =
  "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node";

function fail(message, code = "SIGNING_READINESS_FAILED") {
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

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runTool(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

export function parseDeveloperIdentitySummary(output) {
  const lines = String(output).split(/\r?\n/u);
  return {
    developerIdApplication: lines.filter(
      (line) => /"Developer ID Application:/u.test(line),
    ).length,
    thirdPartyMacDeveloperApplication: lines.filter(
      (line) => /"3rd Party Mac Developer Application:/u.test(line),
    ).length,
    identityDetailsIncluded: false,
  };
}

export function classifyCodeSignature(output) {
  const text = String(output);
  const adHoc = /Signature=adhoc|flags=.*\badhoc\b/u.test(text);
  const developerId = /Authority=Developer ID Application:/u.test(text);
  const hardenedRuntime = /flags=.*\bruntime\b/u.test(text);
  const origin = /Authority=Developer ID Application: Node\.js Foundation/u
    .test(text)
    ? "upstream_node_foundation"
    : developerId
      ? "other_developer_id"
      : adHoc
        ? "adhoc"
        : "unknown";
  return {
    origin,
    developerId,
    hardenedRuntime,
    adHoc,
    authorityDetailsIncluded: false,
  };
}

function commandSucceeded(result) {
  return result?.error === undefined && result?.status === 0;
}

async function assertRegularFile(path, label, maximumBytes) {
  const metadata = await lstat(path).catch(() => fail(`${label} is missing`));
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size <= 0
      || metadata.size > maximumBytes) {
    fail(`${label} must be a bounded regular file`);
  }
  return metadata;
}

async function writeOwnerOnlyNoClobber(path, value) {
  const parent = dirname(path);
  if (await realpath(parent) !== parent) {
    fail("Readiness receipt parent must resolve without symlink traversal");
  }
  const handle = await open(path, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") {
      fail("Readiness receipt already exists", "SIGNING_READINESS_OUTPUT_EXISTS");
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

function parseArgs(argv) {
  let artifactRoot = null;
  let archive = null;
  let expectedArchiveSha256 = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--artifact-root", "--archive", "--expected-archive-sha256", "--output"]
      .includes(argument)) {
      fail(`Unknown argument: ${argument}`);
    }
    if (!value || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    if (argument === "--artifact-root") artifactRoot = resolve(value);
    if (argument === "--archive") archive = resolve(value);
    if (argument === "--expected-archive-sha256") {
      expectedArchiveSha256 = value.toLowerCase();
    }
    if (argument === "--output") output = resolve(value);
    index += 1;
  }
  if (!artifactRoot || !archive || !expectedArchiveSha256 || !output) {
    fail(
      "--artifact-root, --archive, --expected-archive-sha256, and --output are required",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedArchiveSha256)) {
    fail("--expected-archive-sha256 must be a lowercase SHA-256");
  }
  return { artifactRoot, archive, expectedArchiveSha256, output };
}

export async function inspectSigningReadiness({
  artifactRoot,
  archive,
  expectedArchiveSha256,
  toolRunner = runTool,
}) {
  const canonicalArtifactRoot = await realpath(artifactRoot);
  if (canonicalArtifactRoot !== artifactRoot
      || basename(artifactRoot) !== EXPECTED_ARTIFACT) {
    fail("Artifact root must be the exact canonical local-review candidate");
  }
  const artifactMetadata = await lstat(artifactRoot);
  if (!artifactMetadata.isDirectory() || artifactMetadata.isSymbolicLink()) {
    fail("Artifact root must be a regular directory");
  }
  if (dirname(archive) !== dirname(artifactRoot)
      || basename(archive) !== `${EXPECTED_ARTIFACT}.tar`) {
    fail("Archive must be the artifact root's sibling deterministic tar");
  }
  const archiveMetadata = await assertRegularFile(
    archive,
    "Artifact archive",
    512 * 1024 * 1024,
  );
  const archiveSha256 = await sha256File(archive);
  if (archiveSha256 !== expectedArchiveSha256) {
    fail("Artifact archive digest did not match the expected release candidate");
  }

  const manifestPath = join(artifactRoot, "artifact-manifest.json");
  await assertRegularFile(manifestPath, "Artifact manifest", 2 * 1024 * 1024);
  const manifestSha256 = await sha256File(manifestPath);
  const buildReceiptPath = join(
    dirname(artifactRoot),
    `${EXPECTED_ARTIFACT}.build-receipt.json`,
  );
  await assertRegularFile(
    buildReceiptPath,
    "Artifact build receipt",
    256 * 1024,
  );
  const buildReceipt = JSON.parse(await readFile(buildReceiptPath, "utf8"));
  if (buildReceipt?.archive?.sha256 !== archiveSha256
      || buildReceipt?.archive?.bytes !== archiveMetadata.size
      || buildReceipt?.manifestSha256 !== manifestSha256
      || buildReceipt?.signing !== "unsigned"
      || buildReceipt?.notarization !== "not_notarized"
      || buildReceipt?.externalParticipantsAuthorized !== false) {
    fail("Artifact build receipt did not bind the exact unsigned candidate");
  }

  const launcher = join(artifactRoot, "bin", "usage-monitor-local");
  const selfVerification = toolRunner(launcher, ["inspect-artifact"]);
  if (!commandSucceeded(selfVerification)) {
    fail("Artifact self-verification failed");
  }

  const toolChecks = {
    codesign: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "codesign"])),
    spctl: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "spctl"])),
    notarytool: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "notarytool"])),
    stapler: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "stapler"])),
    hdiutil: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "hdiutil"])),
    ditto: commandSucceeded(toolRunner("/usr/bin/xcrun", ["--find", "ditto"])),
  };

  const identitiesResult = toolRunner(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
  );
  const identitySummary = commandSucceeded(identitiesResult)
    ? parseDeveloperIdentitySummary(identitiesResult.stdout)
    : {
      developerIdApplication: 0,
      thirdPartyMacDeveloperApplication: 0,
      identityDetailsIncluded: false,
    };

  const nodeBinary = join(artifactRoot, "runtime", "bin", "node");
  const keytarBinary = join(artifactRoot, KEYTAR_RELATIVE_PATH);
  await assertRegularFile(nodeBinary, "Bundled Node runtime", 256 * 1024 * 1024);
  await assertRegularFile(keytarBinary, "Keytar native addon", 4 * 1024 * 1024);
  const nodeDetails = toolRunner(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", nodeBinary],
  );
  const keytarDetails = toolRunner(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", keytarBinary],
  );
  const nodeSignature = classifyCodeSignature(
    `${nodeDetails.stdout ?? ""}\n${nodeDetails.stderr ?? ""}`,
  );
  const keytarSignature = classifyCodeSignature(
    `${keytarDetails.stdout ?? ""}\n${keytarDetails.stderr ?? ""}`,
  );
  const nodeStrict = commandSucceeded(toolRunner(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", nodeBinary],
  ));
  const keytarStrict = commandSucceeded(toolRunner(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", keytarBinary],
  ));

  const technicalReady = process.platform === "darwin"
    && process.arch === "arm64"
    && Object.values(toolChecks).every(Boolean)
    && identitySummary.developerIdApplication === 1
    && nodeSignature.origin === "upstream_node_foundation"
    && nodeSignature.developerId
    && nodeSignature.hardenedRuntime
    && nodeStrict
    && keytarSignature.adHoc
    && keytarStrict;
  const blockers = [];
  if (process.platform !== "darwin") blockers.push("PLATFORM_NOT_DARWIN");
  if (process.arch !== "arm64") blockers.push("HOST_ARCHITECTURE_NOT_ARM64");
  if (!Object.values(toolChecks).every(Boolean)) {
    blockers.push("APPLE_TOOLCHAIN_INCOMPLETE");
  }
  if (identitySummary.developerIdApplication === 0) {
    blockers.push("DEVELOPER_ID_APPLICATION_IDENTITY_MISSING");
  } else if (identitySummary.developerIdApplication > 1) {
    blockers.push("DEVELOPER_ID_APPLICATION_IDENTITY_AMBIGUOUS");
  }
  if (nodeSignature.origin !== "upstream_node_foundation"
      || !nodeSignature.developerId
      || !nodeSignature.hardenedRuntime
      || !nodeStrict) {
    blockers.push("UPSTREAM_NODE_SIGNATURE_INVALID");
  }
  if (!keytarSignature.adHoc || !keytarStrict) {
    blockers.push("KEYTAR_UNSIGNED_BASELINE_UNEXPECTED");
  }
  if (technicalReady) {
    blockers.push(
      "OWNER_SIGNING_AUTHORIZATION_REQUIRED",
      "NOTARY_CREDENTIAL_NOT_VERIFIED",
      "SIGNED_SUCCESSOR_NOT_BUILT",
    );
  }

  return {
    schemaVersion: RECEIPT_SCHEMA,
    state: technicalReady ? "owner_authorization_required" : "blocked",
    createdAt: new Date().toISOString(),
    artifact: {
      name: EXPECTED_ARTIFACT,
      archiveBytes: archiveMetadata.size,
      archiveSha256,
      manifestSha256,
      unsignedBuildReceiptVerified: true,
      selfVerificationPassed: true,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
    },
    tools: toolChecks,
    signing: {
      developerIdApplicationIdentityCount:
        identitySummary.developerIdApplication,
      identityDetailsIncluded: false,
      bundledNode: {
        origin: nodeSignature.origin,
        developerId: nodeSignature.developerId,
        hardenedRuntime: nodeSignature.hardenedRuntime,
        strictVerification: nodeStrict,
        authorityDetailsIncluded: false,
      },
      keytarAddon: {
        state: keytarSignature.adHoc
          ? "adhoc_requires_developer_id_signing"
          : keytarSignature.developerId
            ? "developer_id_signed"
            : "unexpected_signature",
        strictVerification: keytarStrict,
        authorityDetailsIncluded: false,
      },
    },
    notarization: {
      credentialVerified: false,
      submissionPerformed: false,
      accepted: false,
      ticketStapled: false,
    },
    authorization: {
      ownerSigningAuthorizationRecorded: false,
      externalParticipantsAuthorized: false,
    },
    readyForOwnerAuthorizedSigning: technicalReady,
    blockers,
    sensitiveDetailsIncluded: false,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const receipt = await inspectSigningReadiness(options);
  await writeOwnerOnlyNoClobber(options.output, receipt);
  console.log(`Signing readiness: ${receipt.state}`);
  console.log(
    `Technical signing path ready: ${receipt.readyForOwnerAuthorizedSigning}`,
  );
  console.log(`Blockers: ${receipt.blockers.join(",")}`);
  console.log("Identity details included: false");
  console.log("External participants authorized: false");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`check-local-review-signing-readiness: ${error.message}`);
    process.exitCode = 1;
  });
}
