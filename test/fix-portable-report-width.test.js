import assert from "node:assert/strict";
import test from "node:test";

import { applyPortableWidthFix } from "../src/fix-portable-report-width.js";

test("portable width fix is idempotent and covers desktop and narrow viewports", () => {
  const input = "<html><head></head><body></body></html>";
  const once = applyPortableWidthFix(input);
  const twice = applyPortableWidthFix(once);

  assert.equal(twice, once);
  assert.match(once, /@media screen\{/);
  assert.doesNotMatch(once, /@media[^\{]*min-width/);
  assert.match(once, /\.analytics-top-bar\{width:100%!important/);
});

test("portable width fix rejects non-report input", () => {
  assert.throws(() => applyPortableWidthFix("<html></html>"), /closing head/);
});
