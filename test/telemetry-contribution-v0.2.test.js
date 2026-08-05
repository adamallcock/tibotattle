import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import {
  buildTelemetryContributionsV02,
  validateTelemetryContributionDatasetV02,
  validateTelemetryContributionV02,
} from "../src/telemetry-contribution-v0.2.js";

const ACCOUNT_A = `account:v1:${"00".repeat(32)}`;
const ACCOUNT_B = `account:v1:${"01".repeat(32)}`;
const PARTICIPANT_A = "participant:123e4567-e89b-42d3-a456-426614174000";
const PARTICIPANT_B = "participant:123e4567-e89b-42d3-a456-426614174001";
const KNOWN_ACCOUNT_A_TRACK =
  "account-track:v1:4fe6a6df7e541509d6130f8f44e070a1e214fb688f4ed6be8ff7a1a0ca5d2f75";

function toolCounts() {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function usage(index, accountScopeId = "unattributed") {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: new Date(Date.parse("2026-07-24T23:00:00.000Z") + index * 1_000).toISOString(),
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 100 + index,
      inputCacheReadTokens: 200,
      inputCacheWriteTokens: 0,
      outputTextTokens: 5,
      outputReasoningTokens: 2,
    },
    totalInputContextTokens: 300 + index,
    surface: "extension_or_ide",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: toolCounts(),
    outcome: "unknown",
    eventId: `event:v2:${String(index).padStart(64, "a")}`,
    sessionScopeId: `session:v1:${"b".repeat(64)}`,
    accountScopeId,
  };
}

function quota(index, accountScopeId = ACCOUNT_A) {
  return {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime: new Date(Date.parse("2026-07-24T23:00:00.000Z") + index * 1_000).toISOString(),
    receivedTime: new Date(Date.parse("2026-07-24T23:00:00.000Z") + index * 1_000).toISOString(),
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: index % 100,
    displayPrecision: 0,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-30T20:06:21.000Z",
    snapshotSource: "rollout",
    providerSurface: "account_shared_unallocated",
    snapshotId: `snapshot:v2:${String(index).padStart(64, "c")}`,
    providerStateId: `quota-state:v1:${"d".repeat(64)}`,
    sessionScopeId: `session:v1:${"e".repeat(64)}`,
    accountScopeId,
  };
}

function marker(index, accountScopeId = ACCOUNT_A) {
  return {
    schemaVersion: "export-activity-marker-v0.1",
    observedTime: new Date(Date.parse("2026-07-24T23:00:00.000Z") + index * 1_000).toISOString(),
    surface: "controlled_experiment",
    state: "pulse",
    agenticPoolCoupling: "depends_on_experiment_surface",
    planType: "pro",
    planVariant: "unknown",
    markerId: `marker:v2:${String(index).padStart(64, "f")}`,
    accountScopeId,
  };
}

function bundle({
  usageEvents = [usage(1)],
  quotaSnapshots = [quota(2)],
  activityMarkers = [marker(3)],
} = {}) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    bundleId: `bundle:v1:${"9".repeat(64)}`,
    createdAt: "2026-07-24T23:24:52.000Z",
    coveredAt: {
      startAt: "2026-07-24T23:00:00.000Z",
      endAt: "2026-07-24T23:24:52.000Z",
    },
    clientPlatform: "macos",
    records: { usageEvents, quotaSnapshots, activityMarkers },
  };
}

async function compiledContributionValidator() {
  const directory = new URL(
    "../packages/telemetry-contract/schemas/v0.2/",
    import.meta.url,
  );
  const names = [
    "usage-event.schema.json",
    "quota-snapshot.schema.json",
    "activity-marker.schema.json",
    "contribution.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(new URL(name, directory), "utf8"))
  )));
  const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
  for (const schema of schemas.slice(0, -1)) ajv.addSchema(schema);
  return ajv.compile(schemas.at(-1));
}

test("known account tracks survive account switches while unattributed usage stays literal", () => {
  const source = bundle({
    quotaSnapshots: [quota(2, ACCOUNT_A), quota(4, ACCOUNT_B)],
    activityMarkers: [marker(3, ACCOUNT_A), marker(5, ACCOUNT_B)],
  });
  const [part] = buildTelemetryContributionsV02(source, PARTICIPANT_A);
  assert.equal(part.status, "implementation_disabled");
  assert.equal(part.consentVersion, "privacy-safe-telemetry-v0.2");
  assert.equal(part.completeness, "partial");
  assert.equal(part.usageEvents[0].accountTrackId, "unattributed");
  assert.deepEqual(
    part.quotaSnapshots.map((row) => row.accountTrackId),
    [
      KNOWN_ACCOUNT_A_TRACK,
      "account-track:v1:ade94cba52e26d4cfb107cb9e7c2aab9fb91a7556973e782c39a1e4c2becf433",
    ],
  );
  assert.deepEqual(
    part.activityMarkers.map((row) => row.accountTrackId),
    part.quotaSnapshots.map((row) => row.accountTrackId),
  );
  assert.equal(part.accountingDiagnostic.status, "untrusted_diagnostic");
  assert.equal(part.usageEvents[0].accountingDiagnostic.status, "untrusted_diagnostic");
});

test("central re-enrollment changes dataset and account tracks without leaking either scope", () => {
  const source = bundle();
  const [first] = buildTelemetryContributionsV02(source, PARTICIPANT_A);
  const [second] = buildTelemetryContributionsV02(source, PARTICIPANT_B);
  assert.notEqual(first.datasetId, second.datasetId);
  assert.notEqual(
    first.quotaSnapshots[0].accountTrackId,
    second.quotaSnapshots[0].accountTrackId,
  );
  const serialized = JSON.stringify([first, second]);
  for (const forbidden of [
    ACCOUNT_A,
    ACCOUNT_B,
    PARTICIPANT_A,
    PARTICIPANT_B,
    "accountScopeId",
    "participantId",
    "sessionScopeId",
    "providerStateId",
    "capabilities",
    "/Users/",
    "private@example.test",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("manual and JSON Schema validators enforce closed plaintext shapes", async () => {
  const [part] = buildTelemetryContributionsV02(bundle(), PARTICIPANT_A);
  const validateSchema = await compiledContributionValidator();
  assert.equal(validateSchema(part), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateTelemetryContributionV02(part).valid, true);

  const prolite = structuredClone(part);
  prolite.quotaSnapshots[0].planType = "prolite";
  prolite.activityMarkers[0].planType = "prolite";
  assert.equal(validateSchema(prolite), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateTelemetryContributionV02(prolite).valid, true);

  const arbitrary = structuredClone(part);
  arbitrary.quotaSnapshots[0].planType = "arbitrary-plan-name";
  assert.equal(validateSchema(arbitrary), false);
  assert.deepEqual(
    validateTelemetryContributionV02(arbitrary).errors,
    ["canonical_v01_invalid"],
  );

  const contaminated = structuredClone(part);
  contaminated.usageEvents[0].content = "private";
  assert.equal(validateSchema(contaminated), false);
  assert.deepEqual(
    validateTelemetryContributionV02(contaminated).errors,
    ["usage_events_invalid", "private_projection_invalid"],
  );

  const oversizedDataset = structuredClone(part);
  oversizedDataset.partCount = 101;
  assert.equal(validateSchema(oversizedDataset), false);
  assert.deepEqual(
    validateTelemetryContributionV02(oversizedDataset).errors,
    ["part_count_invalid"],
  );

  const combinedOversize = structuredClone(part);
  combinedOversize.usageEvents = Array.from(
    { length: 100 },
    () => structuredClone(part.usageEvents[0]),
  );
  combinedOversize.quotaSnapshots = Array.from(
    { length: 101 },
    () => structuredClone(part.quotaSnapshots[0]),
  );
  assert.deepEqual(
    validateTelemetryContributionV02(combinedOversize).errors,
    ["record_count_invalid"],
  );
});

test("complete datasets require explicit proof and fail validation when a part is missing", () => {
  const source = bundle({
    usageEvents: [],
    quotaSnapshots: Array.from({ length: 201 }, (_, index) => (
      quota(index + 1, index % 2 === 0 ? ACCOUNT_A : ACCOUNT_B)
    )),
    activityMarkers: [],
  });
  const partial = buildTelemetryContributionsV02(source, PARTICIPANT_A);
  assert.equal(partial.length, 2);
  assert.ok(partial.every((part) => part.completeness === "partial"));
  assert.equal(validateTelemetryContributionDatasetV02([partial[0]]).valid, true);

  const complete = buildTelemetryContributionsV02(source, PARTICIPANT_A, {
    completenessProof: { allPartsPresent: true },
  });
  assert.ok(complete.every((part) => part.completeness === "complete"));
  assert.equal(validateTelemetryContributionDatasetV02(complete).valid, true);
  assert.deepEqual(
    validateTelemetryContributionDatasetV02([complete[0]]).errors,
    ["complete_dataset_missing_parts"],
  );
  assert.equal(Object.isFrozen(complete[0].coveredAt), true);
  assert.throws(
    () => buildTelemetryContributionsV02(source, PARTICIPANT_A, {
      completenessProof: { allPartsPresent: false },
    }),
    /completeness_proof_invalid/u,
  );
});

test("batching and participant-scoped dataset identity are deterministic", () => {
  const usageEvents = Array.from({ length: 101 }, (_, index) => usage(index + 1));
  const quotaSnapshots = Array.from({ length: 102 }, (_, index) => (
    quota(index + 201, index % 2 === 0 ? ACCOUNT_A : ACCOUNT_B)
  ));
  const activityMarkers = [marker(500, ACCOUNT_B)];
  const forward = buildTelemetryContributionsV02(
    bundle({ usageEvents, quotaSnapshots, activityMarkers }),
    PARTICIPANT_A,
    { completenessProof: { allPartsPresent: true } },
  );
  const reverse = buildTelemetryContributionsV02(
    bundle({
      usageEvents: [...usageEvents].reverse(),
      quotaSnapshots: [...quotaSnapshots].reverse(),
      activityMarkers: [...activityMarkers].reverse(),
    }),
    PARTICIPANT_A,
    { completenessProof: { allPartsPresent: true } },
  );
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map((part) => part.partIndex), [1, 2]);
  assert.ok(forward.every((part) => part.partCount === 2));
});
