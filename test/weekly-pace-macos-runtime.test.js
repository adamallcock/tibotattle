import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_QUOTA_ANALYSIS_FILES,
} from "../scripts/lib/runtime-closure.mjs";
import {
  CLIENT_RUNTIME_FILES,
  CLIENT_PACKAGE_FILES,
} from "../scripts/export-tibotattle.mjs";

test("pace analysis ships in both the macOS bundle and client export", () => {
  assert.equal(
    RUNTIME_QUOTA_ANALYSIS_FILES.includes("src/quota-pace-forecast.js"),
    true,
  );
  assert.equal(
    CLIENT_PACKAGE_FILES.includes(
      "packages/quota-analysis/src/quota-pace-forecast.js",
    ),
    true,
  );
  assert.equal(
    CLIENT_RUNTIME_FILES.includes("src/weekly-pace-projection.js"),
    true,
  );
});
