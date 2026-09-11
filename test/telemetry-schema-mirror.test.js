import test from "node:test";
import assert from "node:assert/strict";

import {
  checkTelemetrySchemaMirrors,
} from "../packages/telemetry-contract/scripts/sync-json-schemas.mjs";

test("legacy and staged successor schema mirrors exactly match the package-owned sources", async () => {
  assert.deepEqual(
    await checkTelemetrySchemaMirrors(),
    { schemaCount: 20 },
  );
});
