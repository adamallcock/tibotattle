import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateRuntimeSmokeReceipt,
  verifyLocalReviewRuntime,
} from "../scripts/verify-local-review-runtime.js";
import {
  LOCAL_REVIEW_ARTIFACT_ROOT,
} from "../scripts/lib/local-review-artifact-archive.mjs";

function fixture() {
  const binding = {
    archiveBytes: 1024,
    archiveSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    nativeAuditLibrarySha256: "c".repeat(64),
  };
  const smoke = {
    schemaVersion: "usage-monitor-local-review-artifact-smoke-v0.1",
    artifactArchiveBytes: binding.archiveBytes,
    artifactArchiveSha256: binding.archiveSha256,
    artifactManifestSha256: binding.manifestSha256,
    nativeAuditLibrarySha256: binding.nativeAuditLibrarySha256,
    denyNetwork: true,
    auditedProcessCount: 12,
    javascriptNetworkAttempts: 0,
    nativeAuditedProcessCount: 12,
    nativeNetworkLibcAttempts: 0,
    nativeNetworkEnforcement: "sandbox-exec_deny_network",
    launcherParityVerified: true,
    commandCount: 12,
    commands: [
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
    ],
    localBundleVerified: true,
    exportSetVerified: true,
    completeSetDeletionVerified: true,
    privateCanaryHits: 0,
    installVerified: true,
    uninstallVerified: true,
    participantIdentityPreserved: true,
    secureErasureClaimed: false,
    result: "passed",
  };
  return { binding, smoke };
}

test("runtime gate accepts only the exact extracted-tree smoke contract", () => {
  const { binding, smoke } = fixture();
  assert.deepEqual(validateRuntimeSmokeReceipt(smoke, binding), {
    javascriptNetworkAttempts: 0,
    lifecycleInvocations: 12,
    nativeNetworkLibcAttempts: 0,
    privateCanaryHits: 0,
  });
});

test("runtime gate rejects missing coverage, attempts, and digest drift", () => {
  for (const mutate of [
    (smoke) => { smoke.commandCount = 11; },
    (smoke) => { smoke.commands.pop(); },
    (smoke) => { smoke.commands[1] = "inspect-artifact"; },
    (smoke) => { smoke.commands.reverse(); },
    (smoke) => { smoke.javascriptNetworkAttempts = 1; },
    (smoke) => { smoke.nativeNetworkLibcAttempts = 1; },
    (smoke) => { smoke.privateCanaryHits = 1; },
    (smoke) => { smoke.participantIdentityPreserved = false; },
    (smoke) => { smoke.artifactArchiveSha256 = "d".repeat(64); },
    (smoke) => { smoke.nativeNetworkEnforcement = "not_enabled"; },
  ]) {
    const { binding, smoke } = fixture();
    mutate(smoke);
    assert.throws(
      () => validateRuntimeSmokeReceipt(smoke, binding),
      { code: "LOCAL_REVIEW_RUNTIME_FAILED" },
    );
  }
});

test("release aliases supply bounded outputs and expose the aggregate gate", async () => {
  const packageManifest = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    packageManifest.scripts["product:native-network-audit:build"],
    "node ./scripts/build-native-network-audit.js --output "
      + "\".release-build/native-network-audit/"
      + "libusage_monitor_network_audit.dylib\"",
  );
  assert.equal(
    packageManifest.scripts["product:local-review:runtime"],
    "node ./scripts/verify-local-review-runtime.js --output "
      + "\".release-build/local-review-runtime\"",
  );
  assert.match(
    packageManifest.scripts["product:check"],
    /&& npm run product:local-review:runtime$/u,
  );
});

test("aggregate gate composes two builds, extraction, native audit, and smoke", async () => {
  const unique = `runtime-gate-test-${process.pid}-${Date.now()}`;
  const output = fileURLToPath(new URL(
    `../.release-build/${unique}`,
    import.meta.url,
  ));
  const archiveBytes = Buffer.from("fixture archive\n");
  const manifestBytes = Buffer.from("fixture manifest\n");
  const archiveSha256 = "a".repeat(64);
  const manifestSha256 = "b".repeat(64);
  const sourceInputSha256 = "c".repeat(64);
  const injectedSha256 = "d".repeat(64);
  const calls = [];
  const buildReceipt = {
    components: [{
      name: "fixture",
      version: "1.0.0",
      sha256: "e".repeat(64),
    }],
    manifestSha256,
    rootName: LOCAL_REVIEW_ARTIFACT_ROOT,
    sourceInputSha256,
  };
  let buildCount = 0;
  const dependencies = {
    async buildArtifact({ buildRoot, sourceEpoch }) {
      buildCount += 1;
      calls.push(`build-${buildCount}`);
      assert.equal(sourceEpoch, 1_780_000_000);
      const artifactRoot = join(buildRoot, LOCAL_REVIEW_ARTIFACT_ROOT);
      const archivePath = join(
        buildRoot,
        `${LOCAL_REVIEW_ARTIFACT_ROOT}.tar`,
      );
      await mkdir(artifactRoot, { mode: 0o700, recursive: true });
      await writeFile(
        join(artifactRoot, "artifact-manifest.json"),
        manifestBytes,
        { mode: 0o600 },
      );
      await writeFile(archivePath, archiveBytes, { mode: 0o600 });
      await writeFile(
        join(buildRoot, `${LOCAL_REVIEW_ARTIFACT_ROOT}.build-receipt.json`),
        "same build receipt\n",
        { mode: 0o600 },
      );
      return { archivePath, artifactRoot, receipt: buildReceipt };
    },
    async extractArchive({ archivePath, destinationParent }) {
      calls.push("extract");
      await access(archivePath);
      const artifactRoot = join(
        destinationParent,
        LOCAL_REVIEW_ARTIFACT_ROOT,
      );
      await mkdir(artifactRoot, { mode: 0o700 });
      return {
        archiveBytes: archiveBytes.length,
        archiveSha256,
        artifactRoot,
        entries: [{ bytes: 1, path: "fixture", sha256: "f".repeat(64) }],
        entryCount: 1,
        extractedBytes: 1,
        ownerOnly: true,
      };
    },
    async hashFile() {
      return injectedSha256;
    },
    runScript(_script, args, label) {
      calls.push(label);
      const outputIndex = args.indexOf("--output");
      assert.notEqual(outputIndex, -1);
      const path = args[outputIndex + 1];
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      if (label === "Native network audit build") {
        writeFileSync(path, "native fixture\n", { mode: 0o500 });
        chmodSync(path, 0o500);
        return;
      }
      const { smoke } = fixture();
      smoke.artifactArchiveBytes = archiveBytes.length;
      smoke.artifactArchiveSha256 = archiveSha256;
      smoke.artifactManifestSha256 = manifestSha256;
      smoke.nativeAuditLibrarySha256 = injectedSha256;
      writeFileSync(path, `${JSON.stringify(smoke)}\n`, { mode: 0o600 });
    },
    async validateBuildCandidate({ archivePath, buildReceiptPath }) {
      calls.push("validate-build");
      await Promise.all([access(archivePath), access(buildReceiptPath)]);
      return {
        archiveBytes: archiveBytes.length,
        archiveSha256,
        buildReceipt,
        buildReceiptSha256: "f".repeat(64),
      };
    },
    async validateExtractedArtifact({ artifactRoot, buildReceipt: receipt }) {
      calls.push("validate-extracted");
      await access(artifactRoot);
      assert.equal(receipt, buildReceipt);
      return {
        fileCount: 1,
        runCostPayloadFiles: 0,
      };
    },
  };
  try {
    const result = await verifyLocalReviewRuntime({
      output,
      sourceEpoch: 1_780_000_000,
    }, dependencies);
    assert.equal(result.receipt.schemaVersion, "usage-monitor-local-review-runtime-v0.1");
    assert.equal(result.receipt.result, "passed");
    assert.equal(result.receipt.reproducibility.buildCount, 2);
    assert.equal(result.receipt.reproducibility.buildReceiptsByteIdentical, true);
    assert.equal(result.receipt.extraction.runCostPayloadFiles, 0);
    assert.deepEqual(calls, [
      "build-1",
      "build-2",
      "validate-build",
      "validate-build",
      "extract",
      "validate-extracted",
      "Native network audit build",
      "Extracted local-review runtime smoke",
    ]);
    const persisted = JSON.parse(await readFile(
      result.runtimeReceiptPath,
      "utf8",
    ));
    assert.equal(persisted.result, "passed");
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
