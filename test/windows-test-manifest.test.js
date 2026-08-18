import test from "node:test";
import assert from "node:assert/strict";

import {
  PORTABLE_TEST_FILES,
  WINDOWS_DEFERRED_TESTS,
  WINDOWS_PORTABLE_TEST_FILES,
} from "../scripts/portable-test-manifest.mjs";

test("Windows portable test deferrals are explicit, unique, and bounded", () => {
  assert.equal(WINDOWS_DEFERRED_TESTS.length, 1);
  const deferred = new Set();
  for (const entry of WINDOWS_DEFERRED_TESTS) {
    assert.deepEqual(Object.keys(entry).sort(), ["file", "reason"]);
    assert.equal(PORTABLE_TEST_FILES.includes(entry.file), true, entry.file);
    assert.equal(WINDOWS_PORTABLE_TEST_FILES.includes(entry.file), false, entry.file);
    assert.equal(deferred.has(entry.file), false, entry.file);
    assert.match(entry.reason, /Windows/u);
    assert.equal(entry.reason.length <= 160, true, entry.file);
    deferred.add(entry.file);
  }
  assert.deepEqual(
    WINDOWS_PORTABLE_TEST_FILES,
    PORTABLE_TEST_FILES.filter((file) => !deferred.has(file)),
  );
});
