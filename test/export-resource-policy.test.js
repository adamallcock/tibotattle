import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBoundedJsonLines,
  readBoundedUtf8LineEntries,
  readBoundedUtf8Lines,
} from "../src/bounded-jsonl.js";
import {
  ExportResourceLimitError,
  createExportResourceGuard,
  normalizeExportResourceLimits,
  readBoundedDirectoryEntries,
} from "../src/export-resource-policy.js";

test("resource policy rejects unknown or invalid limits", () => {
  assert.throws(() => normalizeExportResourceLimits({ surprise: 1 }), /Unknown export resource limit/);
  assert.throws(() => normalizeExportResourceLimits({ maximumSourceFiles: 0 }), /positive safe integer/);
  assert.throws(() => normalizeExportResourceLimits({ maximumSourceFiles: 5_001 }), /cannot exceed/);
});

test("resource guard enforces source, record, byte, elapsed, and RSS ceilings with safe codes", () => {
  let now = 100;
  let currentRss = 10;
  const guard = createExportResourceGuard({
    limits: {
      maximumCoveredDurationMs: 10,
      maximumSourceFiles: 2,
      maximumSourceBytes: 20,
      maximumLineBytes: 5,
      maximumOutputRecords: 2,
      maximumExpandedRecordBytes: 10,
      maximumCanonicalBundleBytes: 20,
      maximumElapsedMs: 5,
      maximumRssBytes: 20,
    },
    clock: () => now,
    rss: () => currentRss,
  });
  guard.assertCoveredInterval(0, 10);
  guard.observeSourcePlan(2, 20);
  guard.observeLine(5);
  guard.observeOutputRecord(5);
  guard.observeOutputRecord(5);
  guard.observeCanonicalBundle(20);
  guard.observeEncodedArtifact(20);
  guard.observeExportSetBytes(20, 20);
  assert.equal(guard.snapshot().counters.outputRecords, 2);
  assert.throws(() => guard.observeOutputRecord(0), (error) => error.code === "export_resource_output_records");

  const elapsed = createExportResourceGuard({ limits: { maximumElapsedMs: 1 }, clock: () => now, rss: () => 0 });
  now += 2;
  assert.throws(() => elapsed.checkRuntime(), (error) => error.code === "export_resource_elapsed_time");

  now = 100;
  currentRss = 21;
  const rss = createExportResourceGuard({ limits: { maximumRssBytes: 20 }, clock: () => now, rss: () => currentRss });
  assert.throws(() => rss.checkRuntime(), (error) => error.code === "export_resource_rss");

  const discovery = createExportResourceGuard({
    limits: { maximumSourceFiles: 1, maximumSourceBytes: 5 },
    clock: () => 0,
    rss: () => 0,
  });
  discovery.assertSourceSelection(1, 5);
  assert.equal(discovery.snapshot().counters.sourceFiles, 0);
  assert.equal(discovery.snapshot().counters.sourceBytes, 0);
  assert.throws(
    () => discovery.assertSourceSelection(1, 6),
    (error) => error.code === "export_resource_source_bytes",
  );
  discovery.observeSourceFile(5);
  assert.throws(() => discovery.observeSourceFile(0), (error) => error.code === "export_resource_source_files");
  const entries = createExportResourceGuard({
    limits: { maximumDirectoryEntries: 1 },
    clock: () => 0,
    rss: () => 0,
  });
  entries.observeDirectoryEntry();
  assert.throws(
    () => entries.observeDirectoryEntry(),
    (error) => error.code === "export_resource_directory_entries",
  );
});

test("streaming directory enumeration stops before retaining entry limit plus one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-directory-bound-"));
  try {
    await writeFile(join(directory, "one"), "1");
    await writeFile(join(directory, "two"), "2");
    assert.deepEqual(
      await readBoundedDirectoryEntries(directory, { maximumEntries: 2, sort: true }),
      ["one", "two"],
    );
    await assert.rejects(
      readBoundedDirectoryEntries(directory, { maximumEntries: 1 }),
      (error) => error instanceof ExportResourceLimitError
        && error.code === "export_resource_directory_entries"
        && !error.message.includes(directory),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("export-set and destructive paths do not call array-returning readdir directly", async () => {
  for (const path of [
    "../src/export-set-materializer.js",
    "../src/export-set-verifier.js",
    "../src/export-deletion.js",
    "../src/export-deletion-executor.js",
    "../src/platform/owner-only-export-deletion-preflight.js",
    "../src/platform/owner-only-export-deletion-storage.js",
    "../src/export-workspace-discard.js",
    "../src/export-workspace-discard-executor.js",
    "../src/application/local-export-workspace-discard.js",
    "../src/export-workspace-discard-compatibility-internal.js",
    "../src/platform/owner-only-export-workspace-discard-preflight.js",
    "../src/platform/owner-only-export-workspace-discard-storage.js",
    "../src/storage.js",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\breaddir\s*\(/u, path);
  }
});

test("resource guard independently bounds encoded artifacts and decoded and encoded sets", () => {
  const artifact = createExportResourceGuard({
    scope: "export_set",
    limits: { maximumEncodedArtifactBytes: 10 },
    clock: () => 0,
    rss: () => 0,
  });
  artifact.observeEncodedArtifact(10);
  assert.throws(
    () => artifact.observeEncodedArtifact(11),
    (error) => error.code === "export_resource_encoded_artifact_bytes",
  );

  const set = createExportResourceGuard({
    scope: "export_set",
    limits: { maximumExportSetDecodedBytes: 20, maximumExportSetEncodedBytes: 10 },
    clock: () => 0,
    rss: () => 0,
  });
  set.observeExportSetBytes(20, 10);
  assert.throws(
    () => set.observeExportSetBytes(21, 10),
    (error) => error.code === "export_resource_export_set_decoded_bytes",
  );
  assert.throws(
    () => set.observeExportSetBytes(20, 11),
    (error) => error.code === "export_resource_export_set_encoded_bytes",
  );
});

test("bounded line reader preserves CRLF/final lines and stops before oversized allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-lines-"));
  try {
    const normal = join(directory, "normal.jsonl");
    await writeFile(normal, "one\r\ntwo\nthree");
    const lines = [];
    for await (const line of readBoundedUtf8Lines(normal, { maximumLineBytes: 5, highWaterMark: 2 })) lines.push(line);
    assert.deepEqual(lines, ["one", "two", "three"]);

    const oversized = join(directory, "oversized.jsonl");
    await writeFile(oversized, "123456\n");
    await assert.rejects(async () => {
      for await (const line of readBoundedUtf8Lines(oversized, { maximumLineBytes: 5, highWaterMark: 2 })) void line;
    }, (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_line_bytes");

    const irrelevant = [];
    for await (const line of readBoundedUtf8Lines(oversized, {
      maximumLineBytes: 5,
      highWaterMark: 2,
      oversizedIrrelevantNeedles: ['"token_count"'],
    })) irrelevant.push(line);
    assert.deepEqual(irrelevant, [null]);

    const relevant = join(directory, "relevant.jsonl");
    await writeFile(relevant, '1234"type":"token_count"5678\n');
    await assert.rejects(async () => {
      for await (const line of readBoundedUtf8Lines(relevant, {
        maximumLineBytes: 5,
        highWaterMark: 2,
        oversizedIrrelevantNeedles: ['"type":"token_count"'],
      })) void line;
    }, (error) => error.code === "export_resource_line_bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSONL reader caps input bytes and records before exporter allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-jsonl-"));
  try {
    const path = join(directory, "markers.jsonl");
    await writeFile(path, '{"one":1}\n{"two":2}\n');
    assert.deepEqual(await readBoundedJsonLines(path, {
      maximumFileBytes: 32,
      maximumLineBytes: 16,
      maximumRecords: 2,
    }), [{ one: 1 }, { two: 2 }]);
    await assert.rejects(
      readBoundedJsonLines(path, { maximumFileBytes: 4, maximumLineBytes: 16, maximumRecords: 2 }),
      (error) => error.code === "export_resource_source_bytes",
    );
    await assert.rejects(
      readBoundedJsonLines(path, { maximumFileBytes: 32, maximumLineBytes: 16, maximumRecords: 1 }),
      (error) => error.code === "export_resource_output_records",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("positioned bounded lines resume at an exact completed-line boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-positioned-lines-"));
  try {
    const path = join(directory, "resume.jsonl");
    const text = "one\r\ntwo\nthree\nfour";
    await writeFile(path, text);
    const complete = [];
    for await (const entry of readBoundedUtf8LineEntries(path, {
      maximumLineBytes: 8,
      highWaterMark: 3,
      maximumTotalBytes: Buffer.byteLength(text),
    })) complete.push(entry);
    assert.deepEqual(complete, [
      { line: "one", startByte: 0, endByteExclusive: 5, lineOrdinal: 1 },
      { line: "two", startByte: 5, endByteExclusive: 9, lineOrdinal: 2 },
      { line: "three", startByte: 9, endByteExclusive: 15, lineOrdinal: 3 },
      { line: "four", startByte: 15, endByteExclusive: 19, lineOrdinal: 4 },
    ]);
    const resumed = [];
    for await (const entry of readBoundedUtf8LineEntries(path, {
      maximumLineBytes: 8,
      highWaterMark: 2,
      maximumTotalBytes: Buffer.byteLength(text),
      startByte: complete[1].endByteExclusive,
      startLineOrdinal: complete[1].lineOrdinal + 1,
    })) resumed.push(entry);
    assert.deepEqual(resumed, complete.slice(2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller-owned positioned handles survive bounded-reader exceptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-positioned-error-"));
  let handle;
  try {
    const path = join(directory, "relevant-oversized.jsonl");
    const text = '1234"type":"token_count"5678\n';
    await writeFile(path, text);
    handle = await open(path, "r");
    await assert.rejects(async () => {
      for await (const entry of readBoundedUtf8LineEntries(handle, {
        maximumLineBytes: 5,
        highWaterMark: 2,
        maximumTotalBytes: Buffer.byteLength(text),
        oversizedIrrelevantNeedles: ['"type":"token_count"'],
      })) void entry;
    }, (error) => error.code === "export_resource_line_bytes");
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, 0);
    assert.equal(bytesRead, 1);
    assert.equal(byte.toString("utf8"), "1");
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
