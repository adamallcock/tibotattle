import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
  COMPRESSED_ROLLOUT_LIMITS,
  compressedRolloutHandle,
  createLocalCodexLogPorts,
  inspectCompressedRollout,
  readBoundedUtf8LineEntries,
  readCompressedRolloutBytes,
  supportsCompressedRollouts,
} from "../src/platform/index.js";
import { createLocalCodexLogScanner } from "../src/application/local-codex-log-scanner.js";
import { forEachRolloutLine } from "../src/rollout-line-reader.js";
import { withStableRolloutSource } from "../src/rollout-source-snapshot.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { openLocalUnifiedIndex } from "../src/local-unified-index.js";
import { createCodexExportSourcePlan, openVerifiedCodexExportSource,
  verifyCodexExportSourcePlan } from "../src/export-source-plan.js";
import { discoverCollectorRollouts, ingestRolloutUpdates } from "../src/passive-collector.js";

const supported = supportsCompressedRollouts();
const nativeTest = (name, fn) => test(name, { skip: !supported && "Native Zstd requires Node 22.15 or newer" }, fn);
const scanner = createLocalCodexLogScanner(createLocalCodexLogPorts());
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const START = "2026-07-30T00:00:00.000Z";
const END = "2026-07-31T00:00:00.000Z";
const timestamp = "2026-07-30T12:00:00.000Z";
const name = (id, suffix = ".jsonl.zst") => `rollout-2026-07-30T12-00-00-${id}${suffix}`;
const jsonl = (records) => `${records.map((value) => JSON.stringify(value)).join("\n")}\n`;
const meta = (id, extra = {}, ordinal = 0) => ({ timestamp, ordinal, type: "session_meta", payload: { id, ...extra } });
const context = () => ({ timestamp, type: "turn_context", payload: { model: "gpt-5.5", effort: "high" } });
function tokens(input, total = input) {
  const usage = (value) => ({ input_tokens: value, cached_input_tokens: 0,
    cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0,
    total_tokens: value + 1 });
  return { timestamp, type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: usage(total), last_token_usage: usage(input) } } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-compressed-test-"));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sessions, path: (id, suffix) => join(sessions, name(id, suffix)) };
}
async function compressed(path, text) {
  await writeFile(path, zlib.zstdCompressSync(Buffer.from(text)), { mode: 0o600 });
}
async function discover(root, selectedScanner = scanner) {
  return selectedScanner.discoverCodexRolloutInfos({ codexHome: root, startAt: START, endAt: END });
}
async function consume(source, options) {
  const chunks = [];
  for await (const chunk of readCompressedRolloutBytes(source, options)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function safeCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message.includes("DO_NOT_LEAK"), false);
    assert.equal(error.message.includes("codex-compressed-test-"), false);
    return true;
  };
}

test("a runtime without native Zstd keeps explicit unsupported discovery coverage", async (t) => {
  const value = await fixture(t);
  await writeFile(value.path(A), "DO_NOT_LEAK malformed bytes");
  const ports = createLocalCodexLogPorts();
  const unavailable = createLocalCodexLogScanner({ ...ports, lineReader: {
    ...ports.lineReader, supportsCompressedRollouts: () => false,
    inspectCompressedRollout: () => assert.fail("unsupported decoder must not run"),
  } });
  const infos = await discover(value.root, unavailable);
  assert.equal(infos.length, 0);
  assert.deepEqual(unavailable.codexRolloutDiscoveryReceipt(infos).reasonCounts,
    { codex_rollout_compression_unsupported: 1 });
});

nativeTest("streaming Zstd readers retain exact logical bytes, cursors, and caller-owned descriptors", async (t) => {
  const value = await fixture(t);
  const text = jsonl([meta(A), context(), tokens(100)]);
  await compressed(value.path(A), text);
  const original = await readFile(value.path(A));
  const inspection = await inspectCompressedRollout(value.path(A));
  assert.equal(inspection.size, Buffer.byteLength(text));
  assert.equal(inspection.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(inspection.lastByte, 10);
  const handle = await open(value.path(A), "r");
  try {
    const source = compressedRolloutHandle(handle);
    const entries = [];
    for await (const entry of readBoundedUtf8LineEntries(source, {
      highWaterMark: 73, maximumTotalBytes: inspection.size,
    })) entries.push(entry);
    assert.deepEqual(entries.map((entry) => entry.line), text.trimEnd().split("\n"));
    const lines = [];
    const read = await forEachRolloutLine(source, {
      start: entries[0].endByteExclusive, end: inspection.size, highWaterMark: 67,
      onLine: (line, offset) => lines.push([line.toString(), offset]),
    });
    assert.deepEqual(lines.map(([line]) => line), text.trimEnd().split("\n").slice(1));
    assert.equal(read.nextOffset, inspection.size);
    assert.equal(read.partialDeferred, false);
    assert.equal((await handle.stat()).size, original.length);
  } finally { await handle.close(); }
  assert.deepEqual(await readFile(value.path(A)), original);
});

nativeTest("compressed paginated parents and children use uncompressed history cutoffs in scanner and index workers", async (t) => {
  const value = await fixture(t);
  const parent = jsonl([meta(A), context(), tokens(100)]);
  const child = jsonl([meta(B, { forked_from_id: A, history_mode: "paginated", history_base: {
    thread_id: A, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(parent),
  } }, 3), context(), tokens(50, 150)]);
  await compressed(value.path(A), parent);
  await compressed(value.path(B), child);
  const infos = await discover(value.root);
  assert.deepEqual(infos.map((info) => info.threadId), [A, B]);
  assert.equal(infos[0].size, Buffer.byteLength(parent));
  assert.equal(infos[0].physicalSize, (await stat(value.path(A))).size);
  assert.equal(infos[1].lineage.historyBase.endByteOffset, Buffer.byteLength(parent));
  const events = [];
  await scanner.scanCodexLogEvents({ codexHome: value.root, startAt: START, endAt: END,
    onUsage: (event) => events.push(event) });
  assert.equal(events.length, 2);
  const snapshots = [];
  for (const workerCount of [1, 2]) {
    const indexFile = join(value.root, `index-${workerCount}.sqlite`);
    await rebuildLocalUnifiedIndex({ codexHome: value.root, indexFile,
      secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2", workerCount });
    const db = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      snapshots.push(db.prepare("SELECT tokens_in_uncached, tokens_in_cache_read FROM usage_event ORDER BY tokens_in_uncached").all());
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 2);
      assert.deepEqual(db.prepare("SELECT size_bytes, scanned_bytes FROM source_cursor ORDER BY size_bytes").all()
        .map((row) => [row.size_bytes, row.scanned_bytes]),
      [Buffer.byteLength(parent), Buffer.byteLength(child)].sort((a, b) => a - b).map((size) => [size, size]));
    } finally { db.close(); }
    await ingestLocalUnifiedIndexIncrement({ codexHome: value.root, indexFile,
      secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2" });
    const replayed = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try { assert.equal(replayed.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 2); }
    finally { replayed.close(); }
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});

nativeTest("equal compressed/plain siblings deduplicate by logical content; divergent siblings quarantine", async (t) => {
  const value = await fixture(t);
  const text = jsonl([meta(A), context(), tokens(100)]);
  await compressed(value.path(A), text);
  await writeFile(value.path(A, ".jsonl"), text);
  let infos = await discover(value.root);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].compressed, false);
  assert.equal(scanner.codexRolloutDiscoveryReceipt(infos).duplicateRepresentationCount, 1);
  await compressed(value.path(A), jsonl([meta(A), context(), tokens(101)]));
  infos = await discover(value.root);
  assert.equal(infos.length, 0);
  assert.deepEqual(scanner.codexRolloutDiscoveryReceipt(infos).reasonCounts,
    { codex_rollout_generation_ambiguous: 1 });
});

nativeTest("compressed/plain representation transitions rescan without replay overcount", async (t) => {
  const value = await fixture(t);
  const text = jsonl([meta(A), context(), tokens(100)]);
  const plain = value.path(A, ".jsonl");
  await writeFile(plain, text);
  const options = { codexHome: value.root, indexFile: join(value.root, "index.sqlite"),
    secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2" };
  await rebuildLocalUnifiedIndex({ ...options, workerCount: 1 });
  await compressed(value.path(A), text);
  await rename(plain, join(value.root, "retained-plain-source"));
  await ingestLocalUnifiedIndexIncrement(options);
  await ingestLocalUnifiedIndexIncrement(options);
  const db = openLocalUnifiedIndex(options.indexFile, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1); }
  finally { db.close(); }
});

nativeTest("malformed frames, incomplete frames, and incomplete JSONL tails quarantine affected lineage only", async (t) => {
  const value = await fixture(t);
  const text = jsonl([meta(A), context(), tokens(100)]);
  const full = zlib.zstdCompressSync(Buffer.from(text));
  await compressed(value.path(C), jsonl([meta(C), context(), tokens(5)]));
  for (const [bytes, code] of [[Buffer.from("DO_NOT_LEAK"), "codex_rollout_content_invalid"],
    [full.subarray(0, full.length - 1), "codex_rollout_content_invalid"],
    [zlib.zstdCompressSync(Buffer.from(text.trimEnd())), "codex_rollout_tail_incomplete"]]) {
    await writeFile(value.path(A), bytes);
    await compressed(value.path(B), jsonl([meta(B, { forked_from_id: A }), context(), tokens(10)]));
    const infos = await discover(value.root);
    assert.deepEqual(infos.map((info) => info.threadId), [C]);
    const receipt = scanner.codexRolloutDiscoveryReceipt(infos);
    assert.deepEqual(receipt.reasonCounts, { [code]: 1, codex_rollout_lineage_invalid: 1 });
    assert.equal(JSON.stringify(receipt.diagnosticGroups).includes("DO_NOT_LEAK"), false);
  }
});

nativeTest("compressed reads enforce expansion, physical bytes, line limits, aborts, and symlink refusal", async (t) => {
  const value = await fixture(t);
  const text = `${"x".repeat(16384)}\n`;
  await compressed(value.path(A), text);
  const limits = (override) => ({ ...COMPRESSED_ROLLOUT_LIMITS, ...override });
  await assert.rejects(consume(value.path(A), { limits: limits({ maximumDecompressedBytes: 1000 }) }), safeCode("export_resource_source_bytes"));
  await assert.rejects(consume(value.path(A), { limits: limits({ maximumCompressedBytes: 1 }) }), safeCode("export_resource_source_bytes"));
  await assert.rejects(consume(value.path(A), { limits: limits({ maximumExpansionRatio: 1, minimumExpansionAllowance: 1 }) }), safeCode("export_resource_source_bytes"));
  await assert.rejects(async () => {
    for await (const entry of readBoundedUtf8LineEntries(value.path(A), { maximumLineBytes: 100 })) void entry;
  }, safeCode("export_resource_line_bytes"));
  const controller = new AbortController();
  let chunks = 0;
  await assert.rejects(async () => {
    for await (const chunk of readCompressedRolloutBytes(value.path(A), { highWaterMark: 128, signal: controller.signal })) {
      chunks += 1;
      assert.ok(chunk.length <= 128);
      controller.abort();
    }
  }, (error) => error.name === "AbortError");
  assert.equal(chunks, 1);
  await symlink(value.path(A), value.path(B));
  await assert.rejects(consume(value.path(B)), safeCode("codex_rollout_content_invalid"));
});

nativeTest("compressed immutable snapshots reject changes and checkpoint plans retain logical prefix identity", async (t) => {
  const value = await fixture(t);
  const text = jsonl([meta(A), context(), tokens(100)]);
  await compressed(value.path(A), text);
  const [info] = await discover(value.root);
  const plan = await createCodexExportSourcePlan({ codexHome: value.root, startAt: START, endAt: END });
  assert.equal(plan.sources[0].prefixBytes, Buffer.byteLength(text));
  assert.equal(plan.sources[0].prefixSha256, createHash("sha256").update(text).digest("hex"));
  const handle = await openVerifiedCodexExportSource(plan.sources[0]);
  try { assert.equal((await consume(handle)).toString(), text); }
  finally { await handle.close(); }
  await verifyCodexExportSourcePlan(plan);
  await assert.rejects(withStableRolloutSource(info, async (source) => {
    assert.equal((await consume(source)).toString(), text);
    await compressed(value.path(A), jsonl([meta(A), context(), tokens(123)]));
  }), safeCode("codex_rollout_source_changed"));
  await assert.rejects(verifyCodexExportSourcePlan(plan), safeCode("export_source_source_changed"));
});

nativeTest("frame validation rejects every truncated prefix and checks concatenated, raw, RLE, and checksummed frames", async (t) => {
  const value = await fixture(t);
  const text = Buffer.from("synthetic-complete-line\n");
  const frame = zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
  for (let length = 0; length < frame.length; length += 1) {
    await writeFile(value.path(A), frame.subarray(0, length));
    await assert.rejects(consume(value.path(A)), safeCode("codex_rollout_content_invalid"));
  }
  const corrupt = Buffer.from(frame);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(value.path(A), corrupt);
  await assert.rejects(consume(value.path(A)), safeCode("codex_rollout_content_invalid"));
  const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
  const raw = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 97, 98, 99]);
  const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 43, 0, 0, 65]);
  await writeFile(value.path(A), Buffer.concat([skippable, frame, raw, rle, frame]));
  assert.equal((await consume(value.path(A), { highWaterMark: 1 })).toString(),
    `${text}abcAAAAA${text}`);
  await writeFile(value.path(A), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xf8]));
  await assert.rejects(consume(value.path(A)), safeCode("export_resource_source_bytes"));
});

nativeTest("live passive discovery leaves already-accounted plain-source history intact after compression", async (t) => {
  const value = await fixture(t);
  await compressed(value.path(A), jsonl([meta(A), context(), tokens(100)]));
  const checkpoint = { diagnostics: { filesDiscovered: 1 }, recentEventKeys: ["retained-event"],
    files: { "retained-source": { offset: 123, currentModel: "gpt-5.5", previousTotals: { input_tokens: 100 } } } };
  const before = structuredClone(checkpoint);
  assert.deepEqual(await discoverCollectorRollouts(value.root), []);
  const result = await ingestRolloutUpdates({ codexHome: value.root, checkpoint,
    commitRecordBatch: () => assert.fail("cold compressed source must not rewrite live records") });
  assert.equal(result.changed, false);
  assert.equal(result.recordsWritten, 0);
  assert.deepEqual(checkpoint, before);
});
