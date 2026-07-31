import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import * as accounting from "@app-usagemonitor/accounting";
import {
  CURRENT_ARCHITECTURE_BOUNDARY_BASELINE,
} from "../scripts/check-architecture-boundaries.mjs";

const COST_EXPORTS = Object.freeze([
  "addUsdStrings",
  "aggregateCostResults",
  "priceUsageEvent",
]);
const REGISTRY_EXPORTS = Object.freeze([
  "ANTHROPIC_OFFICIAL_PRICE_CARDS",
  "APP_OFFICIAL_PRICE_CARDS",
  "APP_PRICE_REGISTRY_MANIFEST",
  "APP_PRICE_REGISTRY_OBSERVED_AT",
  "APP_PRICE_REGISTRY_SHA256",
  "APP_PRICE_REGISTRY_VERSION",
  "NORMALIZED_PRICE_EVIDENCE_ROWS",
  "OFFICIAL_PRICE_SOURCE_URLS",
  "OPENAI_LONG_CONTEXT_SOURCE_URLS",
  "OPENAI_OFFICIAL_PRICE_CARDS",
  "PROVIDER_TOOL_PRICE_CARDS",
  "addOfficialPriceRegistry",
  "validateOfficialPriceRegistry",
]);
const LOCAL_EXPORTS = Object.freeze([
  "LOCAL_API_PRICING_METHOD_VERSION",
  "aggregateLocalApiPriceResults",
  "apiPriceResolutionSummary",
  "codexProviderBillableToolUnits",
  "costWarningCodes",
  "priceClaudeUsageRecord",
  "priceCodexProviderToolUnits",
  "priceCodexUsageEvent",
  "summarizeClaudeApiPriceRecords",
]);

test("the accounting package has one reviewed public export and an exact dependency", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../packages/accounting/package.json", import.meta.url)),
  );
  assert.equal(manifest.name, "@app-usagemonitor/accounting");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.exports["."], {
    types: "./index.d.ts",
    import: "./index.js",
    default: "./index.js",
  });
  assert.deepEqual(manifest.dependencies, { runcost: "0.2.0" });
  assert.equal(Object.hasOwn(manifest, "sideEffects"), false);
  const [workspace, lockfile] = await Promise.all([
    readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
    readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /^packages:\n  - packages\/\*/u);
  assert.match(
    lockfile,
    /\n  packages\/accounting:\n    dependencies:\n      runcost:/u,
  );
});

test("the accounting package exposes its reviewed combined runtime API", () => {
  assert.deepEqual(
    Object.keys(accounting).sort(),
    [...COST_EXPORTS, ...REGISTRY_EXPORTS, ...LOCAL_EXPORTS].sort(),
  );
});

test("the Worker consumes only the typed accounting package boundary", async () => {
  const source = await readFile(
    new URL("../apps/worker/src/server-pricing.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /from "@app-usagemonitor\/accounting"/u,
  );
  assert.doesNotMatch(source, /packages\/accounting/u);
  assert.doesNotMatch(source, /@app-usagemonitor\/accounting\//u);
  assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/src\//u);
  assert.doesNotMatch(source, /@ts-ignore/u);
  assert.deepEqual(
    CURRENT_ARCHITECTURE_BOUNDARY_BASELINE.filter(
      ({ importer, target }) =>
        importer.startsWith("apps/worker/")
        || [
          "src/cost-ledger.js",
          "src/local-api-pricing.js",
          "src/price-registry.js",
        ].includes(target),
    ),
    [],
  );
});
