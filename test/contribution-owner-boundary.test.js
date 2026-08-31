import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";
import * as contribution from "../src/contribution/index.js";
import * as localPreparationApplication from
  "../src/application/local-contribution-preparation.js";
import * as localPreparedApplication from
  "../src/application/local-prepared-contribution.js";
import * as accountCompatibility from "../src/telemetry-account-track.js";
import * as builderCompatibility from "../src/telemetry-contribution-builder.js";
import * as localPreparationCompatibility from
  "../src/local-contribution-preparation.js";
import { preparedContributionContext } from
  "../src/prepared-contribution-compatibility-internal.js";
import * as v02Compatibility from "../src/telemetry-contribution-v0.2.js";
import * as preparedCompatibility from "../src/telemetry-prepared-set.js";

const CONTRIBUTION_PUBLIC_EXPORTS = Object.freeze([
  "MAX_PREPARED_CONTRIBUTION_BATCHES",
  "PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA",
  "PREPARED_CONTRIBUTION_LIMITS",
  "PREPARED_CONTRIBUTION_SET_MANIFEST",
  "PREPARED_CONTRIBUTION_SET_VERSION",
  "PreparedContributionSetError",
  "TELEMETRY_ACCOUNT_TRACK_VERSION",
  "TELEMETRY_ACCOUNT_TRACK_V2_VERSION",
  "TELEMETRY_CONTRIBUTION_BUILDER_VERSION",
  "TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION",
  "TELEMETRY_CONTRIBUTION_V02_STATUS",
  "TELEMETRY_CONTRIBUTION_V02_VERSION",
  "TELEMETRY_CONTRIBUTION_VERSION",
  "UNATTRIBUTED_ACCOUNT_TRACK_ID",
  "buildTelemetryContributionsFromBundle",
  "buildTelemetryContributionsV02",
  "createTelemetryV11Day",
  "deriveTelemetryAccountTrackId",
  "deriveTelemetryAccountTrackIdV2",
  "deriveTelemetryPlanEraIdV1",
  "deriveTelemetryV11Attribution",
  "deriveTelemetryV11QuotaOccurrenceId",
  "deriveTelemetryDatasetIdV02",
  "isPreparedContributionBasename",
  "isTelemetryAccountTrackId",
  "isTelemetryAccountTrackIdV2",
  "preparedContributionBasename",
  "preparedContributionRecordCounts",
  "preparedContributionSetId",
  "readTelemetryV11Capabilities",
  "runTelemetryV11Sync",
  "sanitizeTelemetryAttributionBinding",
  "telemetryV11FieldInventory",
  "validatePreparedContributionFileEntry",
  "validatePreparedContributionManifest",
  "validatePreparedTelemetryContributionV01",
  "validateTelemetryContributionDatasetV02",
  "validateTelemetryContributionV02",
]);
const ACCOUNT_COMPATIBILITY_EXPORTS = Object.freeze([
  "TELEMETRY_ACCOUNT_TRACK_VERSION",
  "TELEMETRY_ACCOUNT_TRACK_V2_VERSION",
  "UNATTRIBUTED_ACCOUNT_TRACK_ID",
  "deriveTelemetryAccountTrackId",
  "deriveTelemetryAccountTrackIdV2",
  "deriveTelemetryPlanEraIdV1",
  "isTelemetryAccountTrackId",
  "isTelemetryAccountTrackIdV2",
  "sanitizeTelemetryAttributionBinding",
]);
const BUILDER_COMPATIBILITY_EXPORTS = Object.freeze([
  "TELEMETRY_CONTRIBUTION_BUILDER_VERSION",
  "TELEMETRY_CONTRIBUTION_VERSION",
  "buildTelemetryContributionsFromBundle",
  "materializeTelemetryContributions",
]);
const V02_COMPATIBILITY_EXPORTS = Object.freeze([
  "TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION",
  "TELEMETRY_CONTRIBUTION_V02_STATUS",
  "TELEMETRY_CONTRIBUTION_V02_VERSION",
  "buildTelemetryContributionsV02",
  "deriveTelemetryDatasetIdV02",
  "validateTelemetryContributionDatasetV02",
  "validateTelemetryContributionV02",
]);
const PREPARED_COMPATIBILITY_EXPORTS = Object.freeze([
  "MAX_PREPARED_CONTRIBUTION_BATCHES",
  "PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA",
  "PREPARED_CONTRIBUTION_SET_MANIFEST",
  "PREPARED_CONTRIBUTION_SET_VERSION",
  "PreparedContributionSetError",
  "loadVerifiedPreparedContribution",
  "preparedContributionSetId",
  "publishPreparedContributionFile",
  "publishPreparedContributionManifest",
  "validatePreparedTelemetryContributionV01",
  "verifyPreparedContributionFiles",
  "verifyPreparedContributionSet",
]);
const LOCAL_PREPARATION_APPLICATION_EXPORTS = Object.freeze([
  "LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS",
  "LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS",
  "LOCAL_CONTRIBUTION_PREPARATION_DETAIL_CODES",
  "LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION",
  "LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS",
  "LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS",
  "LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION",
  "LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS",
  "LocalContributionPreparationError",
  "createLocalContributionPreparationContext",
  "projectLocalContributionPreparationError",
]);
const LOCAL_PREPARATION_COMPATIBILITY_EXPORTS = Object.freeze([
  ...LOCAL_PREPARATION_APPLICATION_EXPORTS.filter((name) =>
    name !== "createLocalContributionPreparationContext"),
  "createLocalContributionPreparationRunner",
  "defaultLocalContributionPreparationDirectories",
  "prepareLatestHourLocalContribution",
  "prepareRecentLocalContribution",
]);

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function assertAliases(compatibility, names) {
  for (const name of names) {
    assert.strictEqual(compatibility[name], contribution[name], name);
  }
}

test("contribution publishes one exact reviewed domain API", () => {
  assert.deepEqual(
    Object.keys(contribution).sort(),
    [...CONTRIBUTION_PUBLIC_EXPORTS].sort(),
  );
  assert.deepEqual(contribution.PREPARED_CONTRIBUTION_LIMITS, {
    maximumActivityMarkersPerBatch: 100,
    maximumBatches: 100,
    maximumContributionBytes: 1_310_720,
    maximumManifestBytes: 262_144,
    maximumRecordsPerBatch: 200,
  });
  assert.equal(Object.isFrozen(contribution.PREPARED_CONTRIBUTION_LIMITS), true);
});

test("historical contribution roots retain exact alias identities", () => {
  assert.deepEqual(
    Object.keys(accountCompatibility).sort(),
    [...ACCOUNT_COMPATIBILITY_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(builderCompatibility).sort(),
    [...BUILDER_COMPATIBILITY_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(v02Compatibility).sort(),
    [...V02_COMPATIBILITY_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(preparedCompatibility).sort(),
    [...PREPARED_COMPATIBILITY_EXPORTS].sort(),
  );
  assertAliases(accountCompatibility, ACCOUNT_COMPATIBILITY_EXPORTS);
  assertAliases(
    builderCompatibility,
    BUILDER_COMPATIBILITY_EXPORTS.filter((name) =>
      name !== "materializeTelemetryContributions"),
  );
  assertAliases(v02Compatibility, V02_COMPATIBILITY_EXPORTS);
  assertAliases(
    preparedCompatibility,
    PREPARED_COMPATIBILITY_EXPORTS.filter((name) =>
      !new Set([
        "loadVerifiedPreparedContribution",
        "publishPreparedContributionFile",
        "publishPreparedContributionManifest",
        "verifyPreparedContributionFiles",
        "verifyPreparedContributionSet",
      ]).has(name)),
  );
  for (const name of PREPARED_COMPATIBILITY_EXPORTS.filter((value) =>
    new Set([
      "loadVerifiedPreparedContribution",
      "publishPreparedContributionFile",
      "publishPreparedContributionManifest",
      "verifyPreparedContributionFiles",
      "verifyPreparedContributionSet",
    ]).has(value))) {
    assert.strictEqual(
      preparedCompatibility[name],
      preparedContributionContext[name],
      name,
    );
  }
});

test("local preparation keeps its exact compatibility surface", () => {
  assert.deepEqual(
    Object.keys(localPreparedApplication),
    ["createLocalPreparedContributionContext"],
  );
  assert.deepEqual(
    Object.keys(localPreparationApplication).sort(),
    [...LOCAL_PREPARATION_APPLICATION_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(localPreparationCompatibility).sort(),
    [...LOCAL_PREPARATION_COMPATIBILITY_EXPORTS].sort(),
  );
  for (const name of LOCAL_PREPARATION_APPLICATION_EXPORTS.filter((value) =>
    value !== "createLocalContributionPreparationContext")) {
    assert.strictEqual(
      localPreparationCompatibility[name],
      localPreparationApplication[name],
      name,
    );
  }
});

test("prepared manifest rules are centralized and exact", () => {
  const recordCounts = contribution.preparedContributionRecordCounts({
    usageEvents: [{}],
    quotaSnapshots: [{}, {}],
    activityMarkers: [],
  });
  assert.deepEqual(recordCounts, {
    usageEvents: 1,
    quotaSnapshots: 2,
    activityMarkers: 0,
  });
  const manifest = {
    schemaVersion: contribution.PREPARED_CONTRIBUTION_SET_VERSION,
    builderVersion: contribution.TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    eligibleSchemaVersion:
      contribution.PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
    batchCount: 1,
    files: [{
      basename: contribution.preparedContributionBasename(1),
      sha256: "a".repeat(64),
      bytes: 1,
      recordCounts,
    }],
  };
  assert.strictEqual(
    contribution.validatePreparedContributionManifest(
      manifest,
      contribution.TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    ),
    manifest,
  );
  for (const mutate of [
    (value) => { value.files[0].basename = "telemetry-contribution-000002.json"; },
    (value) => { value.files[0].recordCounts.usageEvents = 201; },
    (value) => { value.files[0].bytes = 1_310_721; },
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(
      () => contribution.validatePreparedContributionManifest(
        invalid,
        contribution.TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
      ),
      (error) => error?.code
        === "prepared_contribution_set_manifest_invalid",
    );
  }
});

test("contribution implementations use only reviewed package and owner edges", async () => {
  const implementationImports = new Map();
  for (const relativePath of [
    "src/contribution/account-track.js",
    "src/contribution/prepared-set-contract.js",
    "src/contribution/telemetry-v01-projection.js",
    "src/contribution/telemetry-v02-projection.js",
  ]) {
    implementationImports.set(
      relativePath,
      await extractEsmImports(await source(relativePath), {
        sourceName: relativePath,
      }),
    );
  }
  assert.deepEqual(
    implementationImports.get("src/contribution/account-track.js")
      .map(({ specifier }) => specifier),
    ["@app-usagemonitor/identity-core"],
  );
  for (const imports of implementationImports.values()) {
    for (const { specifier } of imports) {
      assert.equal(typeof specifier, "string");
      assert.doesNotMatch(specifier, /@app-usagemonitor\/(?:accounting|telemetry-contract)\//u);
      assert.doesNotMatch(specifier, /(?:platform|application|providers)\//u);
    }
  }
  assert.doesNotMatch(
    await source("src/telemetry-contribution-builder.js"),
    /from "\.\/storage\.js"/u,
  );
  assert.match(
    await source("src/telemetry-contribution-builder.js"),
    /from "\.\/export\/index\.js"/u,
  );
  for (const relativePath of [
    "src/application/local-contribution-preparation.js",
    "src/application/local-prepared-contribution.js",
  ]) {
    const imports = await extractEsmImports(await source(relativePath), {
      sourceName: relativePath,
    });
    assert.deepEqual(
      imports.map(({ specifier }) => specifier).sort(),
      ["../contribution/index.js", "../export/index.js"],
      relativePath,
    );
  }
  assert.doesNotMatch(
    await source("src/telemetry-prepared-set.js"),
    /from "node:|\.\/storage\.js/u,
  );
  assert.doesNotMatch(
    await source("src/local-contribution-preparation.js"),
    /\.\/storage\.js/u,
  );
  const automaticStorageImports = await extractEsmImports(
    await source(
      "src/platform/owner-only-automatic-contribution-storage.js",
    ),
    {
      sourceName:
        "src/platform/owner-only-automatic-contribution-storage.js",
    },
  );
  assert.deepEqual(
    automaticStorageImports.map(({ specifier }) => specifier).sort(),
    [
      "./owner-only-filesystem.js",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
    ],
  );
  const localRuntimeImports = await extractEsmImports(
    await source("src/local-node-runtime.js"),
    { sourceName: "src/local-node-runtime.js" },
  );
  assert.deepEqual(
    localRuntimeImports.map(({ specifier }) => specifier).sort(),
    [
      "./application/index.js",
      "./contribution-device-sync.js",
      "./export/index.js",
      "./export/set-materialization-runtime.js",
      "./platform/index.js",
      "./providers/claude/statusline.js",
      "./telemetry-prepared-set.js",
      "node:crypto",
      "node:path",
      "node:util/types",
    ],
  );
  assert.doesNotMatch(
    await source("src/local-node-runtime.js"),
    /node:fs|node:sqlite|\.\/storage\.js/u,
  );
  const queueApplicationImports = await extractEsmImports(
    await source("src/application/local-contribution-sync-queue.js"),
    { sourceName: "src/application/local-contribution-sync-queue.js" },
  );
  assert.deepEqual(
    queueApplicationImports.map(({ specifier }) => specifier).sort(),
    ["../contribution/index.js", "../export/index.js"],
  );
  assert.doesNotMatch(
    await source("src/application/local-contribution-sync-queue.js"),
    /from "node:|\.\.\/platform\/|\.\.\/storage\.js/u,
  );
  const queueStorageImports = await extractEsmImports(
    await source("src/platform/local-contribution-sync-queue-storage.js"),
    { sourceName: "src/platform/local-contribution-sync-queue-storage.js" },
  );
  assert.deepEqual(
    queueStorageImports.map(({ specifier }) => specifier).sort(),
    [
      "./bounded-directory-reader.js",
      "./owner-only-filesystem.js",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:sqlite",
    ],
  );
  assert.match(
    await source("src/telemetry-contribution-builder.js"),
    /prepared-contribution-compatibility-internal\.js/u,
  );
});
