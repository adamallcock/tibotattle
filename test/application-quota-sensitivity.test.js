import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";
import * as application from "../src/application/index.js";
import * as implementation from "../src/application/subscription-speed-sensitivity.js";
import * as providerLogs from "../src/providers/codex/logs.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const QUOTA_SENSITIVITY_EXPORTS = [
  "fastQuotaMultiplier",
  "subscriptionSpeedSensitivity",
];
const APPLICATION_PUBLIC_EXPORTS = [
  ...QUOTA_SENSITIVITY_EXPORTS,
  "ClaudeCallbackCapabilityError",
  "createClaudeCallbackCapabilityContext",
  "createExportCompatibilityContext",
  "createLocalContributionSyncQueueContext",
  "createLocalExportArtifactStorageContext",
  "createLocalExportDeletion",
  "createLocalExportSetVerificationContext",
  "createLocalExportSetController",
  "createLocalExportSetMaterialization",
  "createLocalExportSetMaterializationContext",
  "createLocalExportSourcePipelineContext",
  "createLocalExportWorkspaceContext",
  "createLocalExportWorkspaceDiscard",
  "createLocalExportWorkspaceLeaseContext",
  "createLocalExportWorkspaceRuntimeContext",
  "createLocalCodexLogScanner",
  "createLocalExportResourceContext",
  "createLocalMetadataExportContext",
  "createLocalMetadataBundleVerificationContext",
  "selectProductionParticipantIdentity",
  "selectProductionClaudeCallbackBackend",
].sort();
const PRODUCTION_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".release-build",
  ".release-deps",
  ".wrangler",
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "scripts",
  "test",
  "tests",
]);
const NON_PRODUCTION_FILE_PATTERN =
  /\.(?:check|config|spec|test)\.(?:js|jsx|mjs|mts|ts|tsx)$/u;

async function productionSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionSourceFiles(path));
    } else if (
      entry.isFile()
      && PRODUCTION_EXTENSIONS.has(extname(entry.name))
      && !NON_PRODUCTION_FILE_PATTERN.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

test("application quota sensitivity exposes only its reviewed public API", () => {
  assert.deepEqual(
    Object.keys(application).sort(),
    APPLICATION_PUBLIC_EXPORTS,
  );
  assert.deepEqual(
    Object.keys(implementation).sort(),
    QUOTA_SENSITIVITY_EXPORTS,
  );
  assert.equal(
    application.fastQuotaMultiplier,
    implementation.fastQuotaMultiplier,
  );
  assert.equal(
    application.subscriptionSpeedSensitivity,
    implementation.subscriptionSpeedSensitivity,
  );
});

test("application quota sensitivity preserves the model multiplier policy", () => {
  assert.equal(application.fastQuotaMultiplier("gpt-5.6"), 2.5);
  assert.equal(application.fastQuotaMultiplier("gpt-5.6-sol"), 2.5);
  assert.equal(application.fastQuotaMultiplier("gpt-5.5-codex"), 2.5);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4"), 2);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4-codex"), 2);
  assert.equal(application.fastQuotaMultiplier("gpt-5.60"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4future"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-4.1"), null);
  assert.equal(application.fastQuotaMultiplier(null), null);
});

test("application quota sensitivity preserves complete, incomplete, rounding, and selection semantics", () => {
  assert.deepEqual(
    application.subscriptionSpeedSensitivity({
      "future-model": { costUsd: 0.3 },
      "gpt-5.4": { costUsd: 0.2 },
      "gpt-5.6-sol": { costUsd: 0.1 },
      "ignored-infinite": { costUsd: Number.POSITIVE_INFINITY },
      "ignored-negative": { costUsd: -1 },
      "ignored-nonnumeric": { costUsd: "not-a-number" },
    }, "fast"),
    {
      basis:
        "codex_subscription_speed_multiplier_applied_to_standard_api_equivalent_not_api_cost",
      modelMultipliers: {
        "future-model": null,
        "gpt-5.4": 2,
        "gpt-5.6-sol": 2.5,
      },
      observedSpeedMode: "fast",
      scenarios: {
        fast: {
          complete: false,
          relativeQuotaWeight: "model_specific",
          supportedWeightedStandardApiEquivalentUsd: 0.65,
          unsupportedStandardApiEquivalentUsd: 0.3,
          weightedStandardApiEquivalentUsd: null,
        },
        standard: {
          complete: true,
          relativeQuotaWeight: 1,
          weightedStandardApiEquivalentUsd: 0.6,
        },
      },
      selectedScenario: "fast",
    },
  );

  assert.deepEqual(
    application.subscriptionSpeedSensitivity(null),
    {
      basis:
        "codex_subscription_speed_multiplier_applied_to_standard_api_equivalent_not_api_cost",
      modelMultipliers: {},
      observedSpeedMode: "unknown",
      scenarios: {
        fast: {
          complete: true,
          relativeQuotaWeight: "model_specific",
          supportedWeightedStandardApiEquivalentUsd: 0,
          unsupportedStandardApiEquivalentUsd: 0,
          weightedStandardApiEquivalentUsd: 0,
        },
        standard: {
          complete: true,
          relativeQuotaWeight: 1,
          weightedStandardApiEquivalentUsd: 0,
        },
      },
      selectedScenario: null,
    },
  );
  assert.throws(
    () => application.subscriptionSpeedSensitivity({}, "priority"),
    /^Error: observedSpeedMode is invalid$/u,
  );
});

test("production modules no longer depend on the legacy tier shim", async () => {
  const productionRoots = ["apps", "packages", "src"].map((directory) =>
    resolve(REPOSITORY_ROOT, directory)
  );
  const importsOfLegacyShim = [];

  for (const root of productionRoots) {
    for (const file of await productionSourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const { specifier } of await extractEsmImports(source)) {
        if (
          typeof specifier === "string"
          && /(?:^|\/)tier-semantics(?:\.js)?$/u.test(specifier)
        ) {
          importsOfLegacyShim.push({
            file,
            specifier,
          });
        }
      }
    }
  }

  assert.deepEqual(importsOfLegacyShim, []);
});
