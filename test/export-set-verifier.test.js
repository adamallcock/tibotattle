import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  materializeLocalExportSet,
} from "../src/export-set-materializer.js";
import { exportSetChunkBasenames } from "../src/export-set-schema.js";
import { ExportSetVerificationError, verifyLocalExportSet } from "../src/export-set-verifier.js";
import { stableJson } from "../src/storage.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ExportResourceLimitError } from "../src/export-resource-policy.js";

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
  return stableJson({
    schemaVersion: "export-set-manifest-receipt-v0.1",
    manifestSha256: createHash("sha256").update(text).digest("hex"),
    manifestBytes: Buffer.byteLength(text),
    transportReady: false,
  });
}

test("set verifier accepts a complete deterministic multi-chunk set", async () => {
  const value = await localSet();
  try {
    const result = await verifyLocalExportSet({ directory: value.output });
    assert.equal(result.verdict, "passed");
    assert.equal(result.chunkCount, 2);
    assert.deepEqual(result.recordCounts, { usageEvents: 2, quotaSnapshots: 0, activityMarkers: 0 });
    assert.equal(result.transportReady, false);
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
      assert.equal(error.name, "BundleVerificationError");
      assert.equal(error.message.includes(value.output), false);
      return true;
    });
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
    const firstNames = exportSetChunkBasenames(0);
    const secondNames = exportSetChunkBasenames(1);
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
