import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import * as accounting from "@app-usagemonitor/accounting";
import {
  CURRENT_ARCHITECTURE_BOUNDARY_BASELINE,
} from "../scripts/check-architecture-boundaries.mjs";

const COST_EXPORTS = Object.freeze([
  "addUsdStrings",
  "priceUsageEvent",
]);
const REGISTRY_EXPORTS = Object.freeze([
  "APP_OFFICIAL_PRICE_CARDS",
  "APP_PRICE_REGISTRY_MANIFEST",
  "OPENAI_PRICE_EVIDENCE_START_DATE",
]);
const SUBSCRIPTION_SPEED_EXPORTS = Object.freeze([
  "CODEX_SPEED_MODE_DECLARATION",
  "CODEX_SPEED_MODE_OBSERVABILITY",
  "DEFAULT_UNRESOLVED_SPEED_SCENARIO",
  "FAST_MODE_ASSUMED_MULTIPLIER",
  "FAST_MODE_ASSUMED_MULTIPLIER_SOURCE",
  "FAST_MODE_MODEL_FAMILY_KEYS",
  "FAST_MODE_MULTIPLIER_SOURCE",
  "FAST_MODE_QUOTA_MULTIPLIERS",
  "OBSERVED_SPEED_MODE_KEYS",
  "QUOTA_WEIGHTED_API_PRICE_METRIC",
  "emptySpeedWeightingCrossing",
  "fastModeModelFamilyKey",
  "fastModeQuotaMultiplier",
  "inferFastModeFromCalibrationWindows",
  "resolveEffectiveSpeedMode",
  "summarizeQuotaWeightedAccounting",
]);
const LOCAL_EXPORTS = Object.freeze([
  "aggregateLocalApiPriceResults",
  "apiPriceResolutionSummary",
  "costWarningCodes",
  "priceClaudeUsageRecord",
  "priceCodexProviderToolUnits",
  "priceCodexUsageEvent",
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
  assert.deepEqual(manifest.dependencies, { runcost: "0.2.1" });
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
    [
      ...COST_EXPORTS,
      ...REGISTRY_EXPORTS,
      ...SUBSCRIPTION_SPEED_EXPORTS,
      ...LOCAL_EXPORTS,
    ].sort(),
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
