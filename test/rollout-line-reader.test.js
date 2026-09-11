import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  forEachRolloutLine,
  ROLLOUT_LINE_BYTES,
} from "../src/rollout-line-reader.js";

async function fixture(contents) {
  const root = await mkdtemp(join(tmpdir(), "rollout-line-reader-"));
  const path = join(root, "rollout.jsonl");
  await writeFile(path, contents);
  return { root, path, size: Buffer.byteLength(contents) };
}

async function readAll(path, size, options = {}) {
  const lines = [];
  const result = await forEachRolloutLine(path, {
    end: size,
    ...options,
    onLine: (line, lineEndOffset, partial) => {
      lines.push({ text: line.toString("utf8"), lineEndOffset, partial });
    },
  });
  return { lines, result };
}

test("complete lines are delivered with their end offsets and no trailing partial", async () => {
  const contents = "alpha\nbeta\ngamma";
  const { root, path, size } = await fixture(contents);
  try {
    const { lines, result } = await readAll(path, size);
    assert.deepEqual(lines.map((entry) => entry.text), ["alpha", "beta"]);
    assert.deepEqual(lines.map((entry) => entry.lineEndOffset), [6, 11]);
    assert.equal(result.nextOffset, 11);
    assert.equal(result.partialDeferred, true);
    assert.equal(result.completeLines, 2);
    assert.equal(result.oversizedLines, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a line straddling many read chunks is reassembled byte-for-byte", async () => {
  // The chunk tail must be copied, not viewed: the stream refills its buffer,
  // so a retained view would join the next chunk's bytes instead.
  const long = "x".repeat(40_000);
  const contents = `${long}\nshort\n`;
  const { root, path, size } = await fixture(contents);
  try {
    const { lines } = await readAll(path, size, { highWaterMark: 1_024 });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].text, long);
    assert.equal(lines[0].partial, false);
    assert.equal(lines[1].text, "short");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a caller-owned FileHandle preserves a line across scratch-buffer refills", async () => {
  const contents = "first-record-crosses-buffer\nsecond\n";
  const { root, path, size } = await fixture(contents);
  const handle = await open(path, "r");
  try {
    const lines = [];
    const result = await forEachRolloutLine(handle, {
      end: size,
      highWaterMark: 5,
      onLine(line, lineEndOffset, partial) {
        lines.push({ text: line.toString("utf8"), lineEndOffset, partial });
      },
    });

    assert.deepEqual(lines, [
      {
        text: "first-record-crosses-buffer",
        lineEndOffset: 28,
        partial: false,
      },
      { text: "second", lineEndOffset: size, partial: false },
    ]);
    assert.equal(result.nextOffset, size);
    assert.equal(result.completeLines, 2);
    // Passing a FileHandle transfers no ownership to the reader.
    assert.equal((await handle.stat()).size, size);
  } finally {
    await handle.close();
    await rm(root, { recursive: true });
  }
});

test("an oversized line is truncated to its prefix and marked partial rather than dropped", async () => {
  const huge = `{"type":"turn_context","payload":{"model":"gpt-5.6-sol","pad":"${"y".repeat(5_000)}"}}`;
  const contents = `${huge}\nkept\n`;
  const { root, path, size } = await fixture(contents);
  try {
    const { lines, result } = await readAll(path, size, {
      maximumLineBytes: 64,
      highWaterMark: 512,
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].partial, true);
    assert.equal(lines[0].text.length, 64);
    assert.equal(lines[0].text, huge.slice(0, 64));
    // The record after the oversized one must still arrive intact.
    assert.equal(lines[1].text, "kept");
    assert.equal(lines[1].partial, false);
    assert.equal(result.oversizedLines, 1);
    assert.equal(result.completeLines, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an oversized line does not retain more than the cap even across chunk boundaries", async () => {
  const contents = `${"z".repeat(3_000_000)}\ntail\n`;
  const { root, path, size } = await fixture(contents);
  try {
    let widest = 0;
    const result = await forEachRolloutLine(path, {
      end: size,
      maximumLineBytes: 1_024,
      highWaterMark: 8 * 1_024,
      onLine: (line) => {
        widest = Math.max(widest, line.length);
      },
    });
    assert.equal(widest, 1_024);
    assert.equal(result.oversizedLines, 1);
    assert.equal(result.completeLines, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("reading resumes exactly at a prior next offset", async () => {
  const contents = "one\ntwo\nthree\n";
  const { root, path, size } = await fixture(contents);
  try {
    const first = await readAll(path, 8);
    assert.deepEqual(first.lines.map((entry) => entry.text), ["one", "two"]);
    const second = await readAll(path, size, { start: first.result.nextOffset });
    assert.deepEqual(second.lines.map((entry) => entry.text), ["three"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an already-aborted signal reads nothing and reports the abort", async () => {
  const { root, path, size } = await fixture("one\ntwo\n");
  try {
    const controller = new AbortController();
    controller.abort();
    const { lines, result } = await readAll(path, size, { signal: controller.signal });
    assert.deepEqual(lines, []);
    assert.equal(result.aborted, true);
    assert.equal(result.nextOffset, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an empty range is a no-op", async () => {
  const { root, path } = await fixture("one\n");
  try {
    const { lines, result } = await readAll(path, 0);
    assert.deepEqual(lines, []);
    assert.equal(result.nextOffset, 0);
    assert.equal(result.partialDeferred, false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the default cap leaves 32x headroom over the largest observed relevant line", async () => {
  // Measured worst case for a record this product parses is a 2 KiB
  // `turn_context`. The cap must stay comfortably above it while remaining
  // far below the 80 MiB content records it exists to step over.
  assert.equal(ROLLOUT_LINE_BYTES, 64 * 1024);
  assert.ok(ROLLOUT_LINE_BYTES >= 32 * 2 * 1024);
});

test("the callback is rejected when it is not a function", async () => {
  const { root, path, size } = await fixture("one\n");
  try {
    await assert.rejects(
      () => forEachRolloutLine(path, { end: size, onLine: null }),
      TypeError,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
