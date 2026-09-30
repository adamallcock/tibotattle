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
  "CONTRIBUTION_PREFERENCE_SCHEMA_VERSION",
  "USAGE_EXPLAINER_SCHEMA_VERSION",
  "accountlessTransportOrigin",
  "createAccountlessContributionScheduler",
  "createClaudeCallbackCapabilityContext",
  "createExportCompatibilityContext",
  "createLocalContributionSyncQueueContext",
  "createLocalContributionPreference",
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
  "createModelPerformanceContext",
  "createTelemetryPerformanceClient",
  "createTelemetryPerformanceDayRunner",
  "createTelemetryPerformanceScheduler",
  "TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION",
  "TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION",
  "TELEMETRY_PERFORMANCE_METHOD_VERSION",
  "TELEMETRY_PERFORMANCE_PRIVACY_CONTRACT_VERSION",
  "TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION",
  "TELEMETRY_PERFORMANCE_SCOPE",
  "TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS",
  "TELEMETRY_PERFORMANCE_SYNC_STATE_VERSION",
  "initialTelemetryPerformanceSyncState",
  "parseTelemetryPerformanceSyncState",
  "resumeTelemetryPerformanceSyncAfterAuthorization",
  "createUsageExplainerService",
  "createWorkUsageService",
  "createWorkUsageSnapshotStore",
  "validateWorkUsageQuery",
  "fitUsageExplanationEnvelope",
  "prepareTelemetryPerformanceDay",
  "projectTelemetryPerformanceDay",
  "selectProductionParticipantIdentity",
  "selectProductionClaudeCallbackBackend",
  "usageExplanationCatalog",
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
  assert.equal(application.fastQuotaMultiplier("gpt-5.6"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-5.6-sol"), 2);
  assert.equal(application.fastQuotaMultiplier("gpt-5.5-codex"), 2.5);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4"), 2);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4-codex"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-5.60"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-5.4future"), null);
  assert.equal(application.fastQuotaMultiplier("gpt-4.1"), 1.75);
  assert.equal(application.fastQuotaMultiplier(null), null);
});

test("application quota sensitivity preserves complete, incomplete, rounding, and selection semantics", () => {
  assert.deepEqual(
    application.subscriptionSpeedSensitivity({
      "future-model": { costUsd: 0.3 },
      "gpt-5.4": { costUsd: 0.2, priceEvidence: {
        eventTime: "2026-08-30T00:00:00.000Z", totalInputContextTokens: 1_000,
      } },
      "gpt-5.6-sol": { costUsd: 0.1, priceEvidence: {
        eventTime: "2026-08-30T00:00:00.000Z", totalInputContextTokens: 1_000,
      } },
      "ignored-infinite": { costUsd: Number.POSITIVE_INFINITY },
      "ignored-negative": { costUsd: -1 },
      "ignored-nonnumeric": { costUsd: "not-a-number" },
    }, "fast"),
    {
      basis:
        "codex_subscription_priority_price_ratio_applied_to_standard_api_equivalent",
      modelMultipliers: {
        "future-model": null,
        "gpt-5.4": 2,
        "gpt-5.6-sol": 2,
      },
      observedSpeedMode: "fast",
      scenarios: {
        fast: {
          complete: true,
          relativeQuotaWeight: "model_specific",
          // 0.3 x 2 assumed + 0.2 x 2 + 0.1 x 2 published.
          weightedStandardApiEquivalentUsd: 1.2,
          assumedRatioStandardApiEquivalentUsd: 0.3,
          assumedRatioMultiplier: 2,
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
        "codex_subscription_priority_price_ratio_applied_to_standard_api_equivalent",
      modelMultipliers: {},
      observedSpeedMode: "unknown",
      scenarios: {
        fast: {
          complete: true,
          relativeQuotaWeight: "model_specific",
          weightedStandardApiEquivalentUsd: 0,
          assumedRatioStandardApiEquivalentUsd: 0,
          assumedRatioMultiplier: 2,
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

test("application sensitivity retains event-qualified model/context mixtures and discloses missing evidence", () => {
  const byModel = {
    "gpt-5.5": { costUsd: 3 },
    "gpt-4.1": { costUsd: 1 },
  };
  const result = application.subscriptionSpeedSensitivity(byModel, "fast", {
    speedWeightingByModel: {
      "gpt-5.5": { unknown: {
        "gpt-5.5": { events: 1, apiPriceEquivalentUsd: 1 },
        unsupported: { events: 1, apiPriceEquivalentUsd: 2 },
      } },
      "gpt-4.1": { unknown: {
        "gpt-4.1": { events: 1, apiPriceEquivalentUsd: 1 },
      } },
    },
  });
  assert.equal(result.scenarios.standard.weightedStandardApiEquivalentUsd, 4);
  assert.equal(result.scenarios.fast.weightedStandardApiEquivalentUsd, 8.25);
  assert.equal(result.scenarios.fast.assumedRatioStandardApiEquivalentUsd, 2);
  assert.deepEqual(result.modelMultipliers, { "gpt-5.5": null, "gpt-4.1": 1.75 });

  const missing = application.subscriptionSpeedSensitivity(byModel, "fast");
  assert.equal(missing.scenarios.fast.weightedStandardApiEquivalentUsd, 8);
  assert.equal(missing.scenarios.fast.assumedRatioStandardApiEquivalentUsd, 4);
  assert.deepEqual(missing.modelMultipliers, { "gpt-5.5": null, "gpt-4.1": null });

  for (const crossing of [
    { unknown: { "gpt-4.1": { events: 1, apiPriceEquivalentUsd: 3 } } },
    { fast: { "gpt-5.5": { events: 1, apiPriceEquivalentUsd: 3 } } },
    { unknown: { "gpt-5.5": { events: 1, apiPriceEquivalentUsd: 2 } } },
  ]) {
    const invalid = application.subscriptionSpeedSensitivity({ "gpt-5.5": { costUsd: 3 } }, "fast", {
      speedWeightingByModel: { "gpt-5.5": crossing },
    });
    assert.equal(invalid.scenarios.fast.weightedStandardApiEquivalentUsd, 6);
    assert.equal(invalid.scenarios.fast.assumedRatioStandardApiEquivalentUsd, 3);
    assert.equal(invalid.modelMultipliers["gpt-5.5"], null);
  }
});

test("observed Ultrafast selects an exact API-price scenario without changing unknown-mode sensitivities", () => {
  const byModel = { "gpt-6-astra": { costUsd: 3, priceEvidence: {
    eventTime: "2026-09-29T12:00:00.000Z", totalInputContextTokens: 300_000,
  } } };
  const result = application.subscriptionSpeedSensitivity(byModel, "ultrafast");
  assert.equal(result.selectedScenario, "ultrafast");
  assert.equal(result.basis, "codex_speed_api_price_ratio_applied_to_standard_api_equivalent");
  assert.deepEqual(result.scenarios.ultrafast, {
    relativeQuotaWeight: "model_specific",
    weightedStandardApiEquivalentUsd: 18,
    unweightedStandardApiEquivalentUsd: 0,
    complete: true,
    modelMultipliers: { "gpt-6-astra": 6 },
  });
  // The API comparison is 2x/6x, never the included-allowance weights 2.5x/8x.
  assert.equal(result.scenarios.fast.weightedStandardApiEquivalentUsd, 6);
  assert.equal(result.scenarios.standard.weightedStandardApiEquivalentUsd, 3);
  for (const mode of ["unknown", "other"]) {
    const unresolved = application.subscriptionSpeedSensitivity(byModel, mode);
    assert.equal(unresolved.selectedScenario, null);
    assert.deepEqual(Object.keys(unresolved.scenarios), ["standard", "fast"]);
  }
});

test("Ultrafast remains unavailable for unsupported models or incomplete event evidence, including zero cost", () => {
  const evidence = { eventTime: "2026-09-29T12:00:00.000Z", totalInputContextTokens: 1_000 };
  for (const [model, priceEvidence, costUsd] of [
    ["gpt-6.1-sol", evidence, 2],
    ["gpt-6-astra-future", evidence, 2],
    ["gpt-6-astra", undefined, 2],
    ["gpt-6-astra", { eventTime: evidence.eventTime }, 2],
    ["gpt-6-astra", { ...evidence, eventTime: "2026-09-28T12:00:00.000Z" }, 2],
    ["gpt-6-astra", { ...evidence, totalInputContextTokens: -1 }, 2],
    ["gpt-6.1-sol", evidence, 0],
  ]) {
    const result = application.subscriptionSpeedSensitivity({ [model]: { costUsd, priceEvidence } }, "ultrafast", {
      // Even a wholly Fast-qualified crossing cannot prove Ultra eligibility.
      speedWeightingByModel: { [model]: { unknown: { [model]: { events: 1, apiPriceEquivalentUsd: costUsd } } } },
    });
    assert.equal(result.selectedScenario, "ultrafast");
    assert.equal(result.scenarios.ultrafast.complete, false);
    assert.equal(result.scenarios.ultrafast.weightedStandardApiEquivalentUsd, null);
    assert.equal(result.scenarios.ultrafast.unweightedStandardApiEquivalentUsd, costUsd);
    assert.equal(result.scenarios.ultrafast.modelMultipliers[model], null);
  }
  const mixed = application.subscriptionSpeedSensitivity({
    "gpt-6-astra": { costUsd: 3, priceEvidence: evidence },
    "gpt-6.1-sol": { costUsd: 2, priceEvidence: evidence },
  }, "ultrafast");
  assert.equal(mixed.scenarios.ultrafast.complete, false);
  assert.equal(mixed.scenarios.ultrafast.weightedStandardApiEquivalentUsd, null);
  assert.equal(mixed.scenarios.ultrafast.unweightedStandardApiEquivalentUsd, 2);
  assert.deepEqual(mixed.scenarios.ultrafast.modelMultipliers, { "gpt-6-astra": 6, "gpt-6.1-sol": null });
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
