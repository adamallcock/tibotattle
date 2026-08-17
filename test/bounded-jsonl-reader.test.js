import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedUtf8LineEntries } from "../src/platform/bounded-jsonl-reader.js";

test("bounded reader preserves lines across reused FileHandle scratch-buffer boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-bounded-reader-"));
  const path = join(root, "records.jsonl");
  const value = "first-crosses-boundaries\nsecond\r\nthird-crosses-too\n";
  await writeFile(path, value, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    const entries = [];
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      highWaterMark: 7,
      maximumLineBytes: 64,
      maximumTotalBytes: Buffer.byteLength(value),
    })) entries.push(entry);
    assert.deepEqual(entries.map((entry) => entry.line), [
      "first-crosses-boundaries", "second", "third-crosses-too",
    ]);
    assert.deepEqual(entries.map((entry) => entry.lineOrdinal), [1, 2, 3]);
    assert.deepEqual(entries.map((entry) => entry.endByteExclusive), [
      Buffer.byteLength("first-crosses-boundaries\n"),
      Buffer.byteLength("first-crosses-boundaries\nsecond\r\n"),
      Buffer.byteLength(value),
    ]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded reader resumes a FileHandle from an exact byte and line cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-bounded-reader-resume-"));
  const path = join(root, "records.jsonl");
  const prefix = "ignored-one\nignored-two\n";
  const value = `${prefix}selected-crosses-scratch\nlast\n`;
  await writeFile(path, value, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    const entries = [];
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      highWaterMark: 5,
      maximumLineBytes: 64,
      maximumTotalBytes: Buffer.byteLength(value),
      startByte: Buffer.byteLength(prefix),
      startLineOrdinal: 3,
    })) entries.push(entry);
    assert.deepEqual(entries.map(({ line, lineOrdinal }) => ({ line, lineOrdinal })), [
      { line: "selected-crosses-scratch", lineOrdinal: 3 },
      { line: "last", lineOrdinal: 4 },
    ]);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
