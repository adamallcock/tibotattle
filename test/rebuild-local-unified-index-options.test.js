import assert from "node:assert/strict";
import test from "node:test";

import { parseRebuildLocalUnifiedIndexOptions } from
  "../scripts/rebuild-local-unified-index-options.mjs";

const defaults = Object.freeze({
  defaultIndexFile: "/tmp/index.sqlite",
  defaultCodexHome: "/tmp/codex-home",
  defaultWorkers: 4,
});

test("rebuild options use explicit defaults and parse every supported option", () => {
  assert.deepEqual(parseRebuildLocalUnifiedIndexOptions([], defaults), {
    indexFile: "/tmp/index.sqlite",
    codexHome: "/tmp/codex-home",
    workers: 4,
  });
  assert.deepEqual(parseRebuildLocalUnifiedIndexOptions([
    "--workers", "7",
    "--codex-home", "/tmp/other-codex",
    "--index", "/tmp/other-index.sqlite",
  ], defaults), {
    indexFile: "/tmp/other-index.sqlite",
    codexHome: "/tmp/other-codex",
    workers: 7,
  });
});

test("rebuild options reject the formerly advertised dry run before mutation", () => {
  assert.throws(
    () => parseRebuildLocalUnifiedIndexOptions(["--dry-run"], defaults),
    /Unknown rebuild option: --dry-run/u,
  );
});

test("rebuild options reject malformed, missing, duplicate, and unknown input", () => {
  for (const arguments_ of [
    ["--workers"],
    ["--workers", "0"],
    ["--workers", "1.5"],
    ["--workers", "2", "--workers", "3"],
    ["--index", "--workers", "2"],
    ["index.sqlite"],
    ["--unknown", "value"],
    ["toString", "value"],
    ["__proto__", "value"],
  ]) {
    assert.throws(
      () => parseRebuildLocalUnifiedIndexOptions(arguments_, defaults),
    );
  }
});

test("rebuild options reject invalid parser inputs and defaults", () => {
  assert.throws(
    () => parseRebuildLocalUnifiedIndexOptions(null, defaults),
    /array of strings/u,
  );
  assert.throws(
    () => parseRebuildLocalUnifiedIndexOptions([], {
      ...defaults,
      defaultIndexFile: "",
    }),
    /Invalid index file default/u,
  );
  assert.throws(
    () => parseRebuildLocalUnifiedIndexOptions([], {
      ...defaults,
      defaultWorkers: Number.MAX_SAFE_INTEGER + 1,
    }),
    /safe positive integer/u,
  );
});
