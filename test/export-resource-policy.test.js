import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedJsonLines, readBoundedUtf8Lines } from "../src/bounded-jsonl.js";
import {
  ExportResourceLimitError,
  createExportResourceGuard,
  normalizeExportResourceLimits,
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
  discovery.observeSourceFile(5);
  assert.throws(() => discovery.observeSourceFile(0), (error) => error.code === "export_resource_source_files");
  const entries = createExportResourceGuard({
    limits: { maximumDirectoryEntries: 1 },
    clock: () => 0,
    rss: () => 0,
  });
  entries.observeDirectoryEntry();
  assert.throws(() => entries.observeDirectoryEntry(), (error) => error.code === "export_resource_source_files");
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
    await writeFile(relevant, '1234"token_count"5678\n');
    await assert.rejects(async () => {
      for await (const line of readBoundedUtf8Lines(relevant, {
        maximumLineBytes: 5,
        highWaterMark: 2,
        oversizedIrrelevantNeedles: ['"token_count"'],
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
