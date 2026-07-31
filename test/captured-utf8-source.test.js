import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureStableUtf8Source,
} from "../scripts/lib/captured-utf8-source.mjs";

test("descriptor-bound UTF-8 capture preserves a stable zero-length file", async () => {
  const root = await mkdtemp(join(tmpdir(), "captured-utf8-zero-"));
  const path = join(root, "empty.js");
  try {
    await writeFile(path, Buffer.alloc(0));
    assert.deepEqual(await captureStableUtf8Source(path), {
      byteLength: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb924"
        + "27ae41e4649b934ca495991b7852b855",
      sourceText: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor-bound UTF-8 capture rejects growth beyond its pre-open bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "captured-utf8-growth-"));
  const path = join(root, "source.js");
  try {
    await writeFile(path, "export {};\n");
    let failpointCalls = 0;
    await assert.rejects(
      captureStableUtf8Source(path, {
        failureMessage: "Fixed source capture failure",
        maximumBytes: 1024 * 1024,
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          failpointCalls += 1;
          await appendFile(path, Buffer.alloc(128 * 1024, 0x61));
        },
      }),
      (error) => error?.code === "CAPTURED_UTF8_SOURCE_INVALID"
        && error.message === "Fixed source capture failure",
    );
    assert.equal(failpointCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
