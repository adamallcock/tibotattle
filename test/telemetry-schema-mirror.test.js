import test from "node:test";
import assert from "node:assert/strict";

import {
  checkTelemetrySchemaMirrors,
} from "../packages/telemetry-contract/scripts/sync-json-schemas.mjs";

test("legacy and staged successor schema mirrors exactly match the package-owned sources", async () => {
  const result = await checkTelemetrySchemaMirrors();
  // Four v0.2 upload schemas plus eight package/root mirrors for each of the
  // staged v1.1 and v1.2 families, and four performance package/root mirrors.
  assert.deepEqual(result, {
    schemaCount: 4 + (8 * 2) + (8 * 2) + (2 * 2),
  });
});
