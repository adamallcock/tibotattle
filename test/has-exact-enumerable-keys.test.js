import assert from "node:assert/strict";
import { test } from "node:test";

import { hasExactEnumerableKeys } from "../src/has-exact-enumerable-keys.js";

test("matches the exact enumerable own string-key set regardless of order", () => {
  assert.equal(
    hasExactEnumerableKeys({ recordedAt: "now", mode: "fast", schemaVersion: "v1" }, [
      "schemaVersion",
      "mode",
      "recordedAt",
    ]),
    true,
  );
});

test("rejects null, arrays, missing keys, and extra enumerable keys", () => {
  assert.equal(hasExactEnumerableKeys(null, ["mode"]), false);
  assert.equal(hasExactEnumerableKeys(["mode"], ["mode"]), false);
  assert.equal(hasExactEnumerableKeys({ mode: "fast" }, ["mode", "recordedAt"]), false);
  assert.equal(hasExactEnumerableKeys({ mode: "fast", extra: true }, ["mode"]), false);
  assert.equal(
    hasExactEnumerableKeys({ "a\0b": true, c: true }, ["a", "b\0c"]),
    false,
  );
});

test("uses enumerable own string-key semantics", () => {
  const inherited = Object.create({ inherited: true });
  Object.defineProperty(inherited, "nonEnumerable", {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(inherited, Symbol("nonString"), {
    value: true,
    enumerable: true,
  });
  inherited.mode = "fast";

  assert.equal(hasExactEnumerableKeys(inherited, ["mode"]), true);
  inherited.extra = true;
  assert.equal(hasExactEnumerableKeys(inherited, ["mode"]), false);
});
