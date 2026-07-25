import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2,
  EXPORT_SET_CONTRACT_VERSION_V0_1,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1,
  EXPORT_SET_MANIFEST_VERSION_V0_1,
  EXPORT_SET_MANIFEST_VERSION_V0_2,
  EXPORT_SET_PACKING_VERSION_V0_1,
  exportSetChunkBasenames,
} from "../src/export-set-schema.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  materializeLocalExportSet,
} from "../src/export-set-materializer.js";
import { ExportSetVerificationError, verifyLocalExportSet } from "../src/export-set-verifier.js";
import { stableJson } from "../src/storage.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ExportResourceLimitError } from "../src/export-resource-policy.js";
import {
  compressExportBytes,
  decompressExportBytes,
  ExportCompressionError,
} from "../src/export-compression.js";

const SECRET = Buffer.alloc(32, 67);

function usage(input, output) {
  return {
    input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
  };
}

async function localSet() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-set-verifier-"));
  const home = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const first = usage(100, 20);
  const second = usage(150, 30);
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first }, rate_limits: null } }),
    JSON.stringify({ timestamp: "2026-07-24T12:04:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: second, last_token_usage: usage(50, 10) }, rate_limits: null } }),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-verifier.jsonl"), `${lines.join("\n")}\n`);
  await createLocalExportWorkspace({
    directory: workspace,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome: home,
    secret: SECRET,
  });
  const materialized = await materializeLocalExportSet({
    workspaceDirectory: workspace,
    outputDirectory: output,
    secret: SECRET,
    maximumRecordsPerChunk: 1,
  });
  return { root, home, workspace, output, ...materialized };
}

function receiptForManifest(text) {
  const manifest = JSON.parse(text);
  return stableJson({
    schemaVersion: manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
      ? EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2
      : EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1,
    manifestSha256: createHash("sha256").update(text).digest("hex"),
    manifestBytes: Buffer.byteLength(text),
    transportReady: false,
  });
}

async function rewriteManifest(value, mutate) {
  const manifestPath = join(value.output, EXPORT_SET_MANIFEST_BASENAME);
  const receiptPath = join(value.output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mutate(manifest);
  const text = stableJson(manifest);
  await writeFile(manifestPath, text, { mode: 0o600 });
  await writeFile(receiptPath, receiptForManifest(text), { mode: 0o600 });
  return manifest;
}

async function convertToPlainV01(value) {
  return rewriteManifest(value, async (manifest) => {
    for (const entry of manifest.chunks) {
      const compressed = exportSetChunkBasenames(entry.index, EXPORT_SET_MANIFEST_VERSION_V0_2);
      const plain = exportSetChunkBasenames(entry.index, EXPORT_SET_MANIFEST_VERSION_V0_1);
      const artifact = await readFile(join(value.output, compressed.bundle));
      const bundle = decompressExportBytes(artifact, {
        maximumEncodedBytes: entry.artifactBytes,
        maximumDecodedBytes: entry.bundleBytes,
      });
      await writeFile(join(value.output, plain.bundle), bundle, { mode: 0o600 });
      await unlink(join(value.output, compressed.bundle));
      delete entry.contentEncoding;
      delete entry.compressionProfile;
      delete entry.artifactSha256;
      delete entry.artifactBytes;
    }
    manifest.schemaVersion = EXPORT_SET_MANIFEST_VERSION_V0_1;
    manifest.manifestContract.version = EXPORT_SET_CONTRACT_VERSION_V0_1;
    manifest.manifestContract.schemaSha256 = EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1;
    manifest.chunking.packingVersion = EXPORT_SET_PACKING_VERSION_V0_1;
    delete manifest.chunking.maximumEncodedArtifactBytes;
    delete manifest.compressionRuntime;
    manifest.totals = {
      recordCounts: manifest.totals.recordCounts,
      logicalRecordsSha256: manifest.totals.logicalRecordsSha256,
      bundleBytes: manifest.totals.decodedBundleBytes,
      receiptBytes: manifest.totals.receiptBytes,
    };
  });
}

test("set verifier accepts a complete deterministic multi-chunk set", async () => {
  const value = await localSet();
  try {
    const result = await verifyLocalExportSet({ directory: value.output });
    assert.equal(result.verdict, "passed");
    assert.equal(result.schemaVersion, EXPORT_SET_MANIFEST_VERSION_V0_2);
    assert.equal(result.chunkCount, 2);
    assert.deepEqual(result.recordCounts, { usageEvents: 2, quotaSnapshots: 0, activityMarkers: 0 });
    assert.equal(result.bundleBytes, value.manifest.totals.decodedBundleBytes);
    assert.equal(result.decodedBundleBytes, value.manifest.totals.decodedBundleBytes);
    assert.equal(result.encodedArtifactBytes, value.manifest.totals.encodedArtifactBytes);
    assert.equal((await readdir(value.output)).filter((name) => name.endsWith(".bundle.json.gz")).length, 2);
    assert.equal(result.transportReady, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier bounds directory enumeration using the requested resource policy", async () => {
  const value = await localSet();
  try {
    await assert.rejects(
      verifyLocalExportSet({
        directory: value.output,
        resourceLimits: { maximumDirectoryEntries: 5 },
      }),
      (error) => error instanceof ExportResourceLimitError
        && error.code === "export_resource_directory_entries"
        && !error.message.includes(value.output),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier accepts a freshly regenerated plain v0.1 representation under the current compatibility tuple", async () => {
  const value = await localSet();
  try {
    const manifest = await convertToPlainV01(value);
    const result = await verifyLocalExportSet({ directory: value.output });
    assert.equal(result.verdict, "passed");
    assert.equal(result.schemaVersion, EXPORT_SET_MANIFEST_VERSION_V0_1);
    assert.equal(result.bundleBytes, manifest.totals.bundleBytes);
    assert.equal(result.encodedArtifactBytes, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier intentionally rejects an old-policy v0.1 local artifact", async () => {
  const value = await localSet();
  try {
    await convertToPlainV01(value);
    await rewriteManifest(value, (manifest) => {
      assert.equal(manifest.compatibility.contract.backwardCompatibility, "none_regenerate_local_review_artifacts");
      manifest.compatibility.implementation.resourcePolicyVersion = "g1-r3-candidate-0.3";
    });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_manifest_schema",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verify-export-set CLI emits only a bounded content-free summary", async () => {
  const value = await localSet();
  try {
    const result = spawnSync(process.execPath, [
      "./src/cli.js", "verify-export-set", "--directory", value.output,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /export-set verification: passed/);
    assert.match(result.stdout, /Chunks: 2/);
    assert.equal(result.stdout.includes(value.output), false);
    assert.equal(result.stdout.includes("PRIVATE_SESSION"), false);
    assert.equal(result.stdout.includes(value.manifest.exportSetId), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier rejects a missing chunk with a content-free error", async () => {
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(1);
    await unlink(join(value.output, names.bundle));
    await assert.rejects(verifyLocalExportSet({ directory: value.output }), (error) => {
      assert.ok(error instanceof ExportSetVerificationError);
      assert.equal(error.code, "export_set_verify_chunk_artifact_missing");
      assert.equal(error.message.includes(value.output), false);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier rejects a directory containing the opposite plain representation", async () => {
  const value = await localSet();
  try {
    const opposite = join(value.output, "chunk-000000.bundle.json");
    await writeFile(opposite, "{}", { mode: 0o600 });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_mixed_representation"
        && !error.message.includes(value.output),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier rejects encoded tampering before decompression", async () => {
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const path = join(value.output, names.bundle);
    const artifact = await readFile(path);
    artifact[Math.floor(artifact.length / 2)] ^= 0xff;
    await writeFile(path, artifact, { mode: 0o600 });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_chunk_artifact_digest",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verify-export-set CLI reports corruption without content, paths, IDs, or hashes", async () => {
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const path = join(value.output, names.bundle);
    const artifact = await readFile(path);
    artifact[Math.floor(artifact.length / 2)] ^= 0xff;
    await writeFile(path, artifact, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "./src/cli.js", "verify-export-set", "--directory", value.output,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Export-set verification failed \(chunk_artifact_digest\)/);
    for (const privateValue of [
      value.output,
      "PRIVATE_SESSION",
      value.manifest.exportSetId,
      value.manifest.chunks[0].artifactSha256,
    ]) {
      assert.equal(result.stderr.includes(privateValue), false);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier classifies checksum corruption after the encoded hash passes", async () => {
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const path = join(value.output, names.bundle);
    const artifact = await readFile(path);
    artifact[artifact.length - 1] ^= 0xff;
    await writeFile(path, artifact, { mode: 0o600 });
    await rewriteManifest(value, (manifest) => {
      manifest.chunks[0].artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportCompressionError
        && error.code === "export_compression_gzip"
        && !error.message.includes("PRIVATE_SESSION"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier bounds a tiny decoded-output bomb at the declared bundle size", async () => {
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const path = join(value.output, names.bundle);
    const bomb = compressExportBytes(Buffer.alloc(64 * 1024, 0x61), {
      maximumDecodedBytes: 64 * 1024,
      maximumEncodedBytes: 1024,
    });
    await writeFile(path, bomb, { mode: 0o600 });
    await rewriteManifest(value, (manifest) => {
      manifest.chunks[0].artifactSha256 = createHash("sha256").update(bomb).digest("hex");
      manifest.chunks[0].artifactBytes = bomb.length;
      manifest.totals.encodedArtifactBytes = manifest.chunks
        .reduce((sum, chunk) => sum + chunk.artifactBytes, 0);
    });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportCompressionError
        && error.code === "export_compression_decoded_bytes",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier checks the decoded hash before canonical bundle parsing", async () => {
  const value = await localSet();
  try {
    const entry = value.manifest.chunks[0];
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const path = join(value.output, names.bundle);
    const original = await readFile(path);
    const decoded = decompressExportBytes(original, {
      maximumEncodedBytes: entry.artifactBytes,
      maximumDecodedBytes: entry.bundleBytes,
    });
    decoded[Math.floor(decoded.length / 2)] ^= 0x01;
    const artifact = compressExportBytes(decoded, {
      maximumDecodedBytes: entry.bundleBytes,
      maximumEncodedBytes: value.manifest.chunking.maximumEncodedArtifactBytes,
    });
    await writeFile(path, artifact, { mode: 0o600 });
    await rewriteManifest(value, (manifest) => {
      manifest.chunks[0].artifactSha256 = createHash("sha256").update(artifact).digest("hex");
      manifest.chunks[0].artifactBytes = artifact.length;
      manifest.totals.encodedArtifactBytes = manifest.chunks
        .reduce((sum, chunk) => sum + chunk.artifactBytes, 0);
    });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_chunk_metadata",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier enforces owner-only artifact permissions", async () => {
  if (process.platform === "win32") return;
  const value = await localSet();
  try {
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    await chmod(join(value.output, names.bundle), 0o644);
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_chunk_artifact_permissions",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("compressed verifier rejects an actually oversized on-disk artifact before decompression", async () => {
  const value = await localSet();
  try {
    const entry = value.manifest.chunks[0];
    const names = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_2);
    const artifactPath = join(value.output, names.bundle);
    const artifact = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.concat([artifact, Buffer.alloc(1024, 0x61)]), { mode: 0o600 });
    await assert.rejects(
      verifyLocalExportSet({
        directory: value.output,
        resourceLimits: { maximumEncodedArtifactBytes: entry.artifactBytes },
      }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_chunk_artifact_size",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier rejects a non-maximal intermediate chunk", async () => {
  const value = await localSet();
  try {
    const manifestPath = join(value.output, EXPORT_SET_MANIFEST_BASENAME);
    const receiptPath = join(value.output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.chunking.maximumRecordsPerChunk = 2;
    const text = stableJson(manifest);
    await writeFile(manifestPath, text, { mode: 0o600 });
    await writeFile(receiptPath, receiptForManifest(text), { mode: 0o600 });
    await assert.rejects(
      verifyLocalExportSet({ directory: value.output }),
      (error) => error instanceof ExportSetVerificationError
        && error.code === "export_set_verify_chunk_nonmaximal",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier rejects a cross-chunk duplicate occurrence ID", async () => {
  const value = await localSet();
  try {
    await convertToPlainV01(value);
    const firstNames = exportSetChunkBasenames(0, EXPORT_SET_MANIFEST_VERSION_V0_1);
    const secondNames = exportSetChunkBasenames(1, EXPORT_SET_MANIFEST_VERSION_V0_1);
    const firstBundle = JSON.parse(await readFile(join(value.output, firstNames.bundle), "utf8"));
    const secondBundlePath = join(value.output, secondNames.bundle);
    const secondReceiptPath = join(value.output, secondNames.receipt);
    const secondBundle = JSON.parse(await readFile(secondBundlePath, "utf8"));
    secondBundle.records.usageEvents[0].eventId = firstBundle.records.usageEvents[0].eventId;
    const secondBundleText = stableJson(secondBundle);
    const secondReceipt = verifyPrivacySafeBundle(secondBundle, { createdAt: secondBundle.createdAt });
    await writeFile(secondBundlePath, secondBundleText, { mode: 0o600 });
    await writeFile(secondReceiptPath, stableJson(secondReceipt), { mode: 0o600 });

    const manifestPath = join(value.output, EXPORT_SET_MANIFEST_BASENAME);
    const manifestReceiptPath = join(value.output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.chunks[1].bundleSha256 = createHash("sha256").update(secondBundleText).digest("hex");
    manifest.chunks[1].bundleBytes = Buffer.byteLength(secondBundleText);
    const receiptText = stableJson(secondReceipt);
    manifest.chunks[1].receiptSha256 = createHash("sha256").update(receiptText).digest("hex");
    manifest.chunks[1].receiptBytes = Buffer.byteLength(receiptText);
    manifest.totals.bundleBytes = manifest.chunks.reduce((sum, chunk) => sum + chunk.bundleBytes, 0);
    manifest.totals.receiptBytes = manifest.chunks.reduce((sum, chunk) => sum + chunk.receiptBytes, 0);
    const manifestText = stableJson(manifest);
    await writeFile(manifestPath, manifestText, { mode: 0o600 });
    await writeFile(manifestReceiptPath, receiptForManifest(manifestText), { mode: 0o600 });
    await assert.rejects(verifyLocalExportSet({ directory: value.output }), (error) => {
      assert.ok(error instanceof ExportSetVerificationError);
      assert.match(error.code, /^export_set_verify_chunk_(?:duplicate|order)$/);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier rejects manifest-receipt tampering without exposing local data", async () => {
  const value = await localSet();
  try {
    const receiptPath = join(value.output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.manifestSha256 = "0".repeat(64);
    await writeFile(receiptPath, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(verifyLocalExportSet({ directory: value.output }), (error) => {
      assert.ok(error instanceof ExportSetVerificationError);
      assert.equal(error.code, "export_set_verify_manifest_receipt");
      assert.equal(error.message.includes(value.output), false);
      assert.equal(error.message.includes("PRIVATE_SESSION"), false);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("set verifier never follows a substituted manifest symlink", async () => {
  const value = await localSet();
  try {
    const manifestPath = join(value.output, EXPORT_SET_MANIFEST_BASENAME);
    const target = join(value.output, "private-manifest-target.json");
    await rename(manifestPath, target);
    await symlink(target, manifestPath);
    await assert.rejects(verifyLocalExportSet({ directory: value.output }), (error) => {
      assert.ok(error instanceof ExportSetVerificationError);
      assert.match(error.code, /^export_set_verify_manifest_(?:type|links|changed)$/);
      assert.equal(error.message.includes(value.output), false);
      return true;
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verification-index resource failure removes its temporary SQLite state", async () => {
  const value = await localSet();
  const temporaryRoot = join(value.root, "verification-temp");
  await mkdir(temporaryRoot, { mode: 0o700 });
  try {
    await assert.rejects(
      verifyLocalExportSet({
        directory: value.output,
        maximumVerificationIndexBytes: 1,
        verificationTemporaryRoot: temporaryRoot,
      }),
      (error) => error instanceof ExportResourceLimitError
        && error.code === "export_resource_workspace_bytes",
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
