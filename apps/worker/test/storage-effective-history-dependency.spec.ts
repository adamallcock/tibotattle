import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import {
  canonicalTelemetryV12Json,
  telemetryV11DomainManifestDigestInput,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV11DomainManifest,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { effectiveHistoryDependency, effectiveHistoryPin } from "../src/storage-effective-history";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../src/telemetry-v12-repository";
import { canonicalJson } from "../src/canonical-json";
import { sha256Hex } from "../src/crypto";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { captureStorageGraphScope, computeStorageGraphResult } from "../src/storage-community-graph";

const b = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  STORAGE_ANALYTICS_DB: D1Database;
};
const db = () => b.USAGE_MONITOR_DB;
const namespace = "synthetic-effective-history";
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
  .toISOString().slice(0, 10);
const day = () => new Date().toISOString().slice(0, 10);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Prepared = Awaited<ReturnType<typeof makeV11Day>>;
type Staged = Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;
type V12Uploaded = Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>;

async function stage(fixture: Fixture, prepared: Prepared): Promise<Staged> {
  await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const raw = canonicalJson({ syntheticTestEnvelope: chunk.chunkDigest,
      manifestDigest: chunk.manifestDigest, nonce: crypto.randomUUID() });
    const envelopeDigest = await sha256Hex(raw);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest,
      new TextEncoder().encode(raw).byteLength);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: new TextEncoder().encode(raw).byteLength, contentType: "application/json",
    });
    await persistTypedV11StagedChunk(db(), fixture, chunk, {
      sourceNamespace: namespace, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/effective-history/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
}

beforeEach(async () => {
  await reset();
  for (const migrations of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS,
    b.TEST_INGESTION_BRIDGE_MIGRATIONS, b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    b.TEST_TYPED_V11_ADMISSION_MIGRATIONS]) await applyD1Migrations(db(), migrations);
  await initializeStorageSource(db(), namespace);
  await initializeTypedV1Admission(db(), namespace);
  await initializeTypedV11Admission(db(), namespace);
  await applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await drainCommunityPublicSourceBootstrap(db());
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB, b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({source: db(), target: b.STORAGE_ANALYTICS_DB,
    sourceId: namespace, sourceNamespace: namespace});
});

async function activate(fixture: Fixture, candidates: Staged[]) {
  const predecessor = await createTelemetryV11DomainPredecessor(db(), fixture);
  const ordered = [...candidates].sort((left, right) => left.day.localeCompare(right.day));
  const manifest: TelemetryV11DomainManifest = {
    schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0]!.day,
    throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(value => ({ day: value.day, manifestId: value.manifestId, manifestDigest: value.manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db(), fixture, manifest);
}

function v12UsageRecord(observedDay: string, eventId: string): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2", eventId,
    eventTime: `${observedDay}T12:05:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard",
    apiServiceTier: "default", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root",
    outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

async function stageV12Day(fixture: Fixture, observedDay: string,
  records: readonly TelemetryV12UsageEvent[]): Promise<V12Uploaded> {
  const consent = telemetryV12RequiredConsent();
  const chunkRecords = [...records];
  const chunk: TelemetryV12Chunk = {
    schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${observedDay}:0`, chunkRevision: 1,
    parserVersion: "synthetic-effective-history-v12", consent, records: chunkRecords,
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json(chunkRecords)),
  };
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day: observedDay,
    parserVersion: "synthetic-effective-history-v12", consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest);
  chunk.manifestDigest = manifest.manifestDigest;
  const principal = await authenticateDevice(db(), fixture.authorization);
  const envelopeDigest = await sha256Hex(`synthetic-v12-effective-history:${crypto.randomUUID()}`);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 4096);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 4096, contentType: "application/json",
  });
  await persistTelemetryV12StagedChunk(db(), fixture, chunk, {
    chunkRowId: `chunk:${crypto.randomUUID()}`,
    r2Key: `synthetic/effective-history-v12/${crypto.randomUUID()}`,
    envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
  });
  return registerTelemetryV12DayManifest(db(), fixture, manifest);
}

async function activateV12(fixture: Fixture, candidates: readonly V12Uploaded[], nowEpoch = Date.now()) {
  const predecessor = await createTelemetryV12DomainPredecessor(db(), fixture, nowEpoch);
  const ordered = [...candidates].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(value => ({ day: value.day, manifestId: value.manifestId, manifestDigest: value.manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return activateTelemetryV12Domain(db(), fixture, manifest, nowEpoch);
}

async function prepareOwner(participantId: string): Promise<void> {
  const ownerDigest = "a".repeat(64);
  await db().prepare(`INSERT INTO storage_v11_owner_links
    (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,?,?,?)`)
    .bind(participantId, ownerDigest, "active", ownerDigest, ownerDigest).run();
  await db().prepare(`INSERT INTO storage_owner_revisions
    (owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?)`)
    .bind(ownerDigest, 1, 1, "active").run();
}

async function readDependencyAt(selectedDay = day(), options: { includeSessions?: boolean } = {}) {
  const owner = (await readStorageCommunityOwnerPage(db()))[0]!;
  if (!owner.ownerDigest || !owner.hasEffective) throw new Error("effective owner fixture unavailable");
  const dependency = await effectiveHistoryDependency(db(), owner, namespace, selectedDay, selectedDay, options);
  const pin = await effectiveHistoryPin(owner, selectedDay, selectedDay, dependency);
  return { owner, dependency, pin };
}

async function readDependency(options: { includeSessions?: boolean } = {}) {
  return readDependencyAt(day(), options);
}

describe("closed effective history dependency", () => {
  it("reuses the selected-window identity across outside-day appends and changes it for late in-window evidence", async () => {
    const selectedDay = day();
    const outsideDay = dayAfter(selectedDay);
    const first = await createV11DeviceFixture(db(), { grant: true });
    const original = v11UsageRecord(selectedDay, "a", { eventId: `event:v2:${"o".repeat(64)}` });
    const firstTarget = await stage(first, await makeV11Day(selectedDay, { usage: [original] }));
    const firstOutside = await stage(first, await makeV11Day(outsideDay, {}));
    await activate(first, [firstTarget, firstOutside]);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const initial = await readDependency();
    expect(initial.dependency.v11).toHaveLength(1);

    // Replacing an already retained manifest outside the closed window must not
    // change the target-day identity or its resumable pin.
    const outsideAppend = await stage(first,
      await makeV11Day(outsideDay, { usage: [v11UsageRecord(outsideDay, "c", { eventId: `event:v2:${"x".repeat(64)}` })] }));
    await activate(first, [firstTarget, outsideAppend]);
    const outside = await readDependency();
    expect(outside.dependency).toEqual(initial.dependency);
    expect(outside.pin.fingerprint).toBe(initial.pin.fingerprint);
    expect(outside.owner.ownerRevision).not.toBe(initial.owner.ownerRevision);

    // A late unique occurrence on the selected day changes the selected
    // manifest and must invalidate the closed-window identity.
    const late = await stage(first, await makeV11Day(selectedDay, {
      usage: [original, v11UsageRecord(selectedDay, "d", { eventId: `event:v2:${"l".repeat(64)}` })],
    }));
    await activate(first, [late, outsideAppend]);
    const changed = await readDependency();
    expect(changed.dependency).not.toEqual(initial.dependency);
    expect(changed.pin.fingerprint).not.toBe(initial.pin.fingerprint);
  }, 60_000);

  it("makes session-inclusive closed identities explicit", async () => {
    const selectedDay = day();
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const session = {
      schemaVersion: "session-dimension-v1.1" as const,
      sessionUuid: "session:effective-history",
      firstEventTime: `${selectedDay}T12:00:00.000Z`, provider: "openai_codex",
      toolClassCounts: { shell: 1, other: 0 },
    };
    const candidate = await stage(fixture, await makeV11Day(selectedDay, {
      usage: [v11UsageRecord(selectedDay, "s")], session: [session],
    }));
    await activate(fixture, [candidate]);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();

    const usageOnly = await readDependencyAt(selectedDay);
    const withSessions = await readDependencyAt(selectedDay, { includeSessions: true });
    expect(usageOnly.dependency.streams).toEqual(["quota", "usage"]);
    expect(withSessions.dependency.streams).toEqual(["quota", "session", "usage"]);
    expect(withSessions.pin.fingerprint).not.toBe(usageOnly.pin.fingerprint);
  }, 60_000);

  it("retains accepted and revoked v1.2 social generations and reuses a graph result after an outside-day append", async () => {
    const outsideDay = day();
    const selectedDay = new Date(Date.parse(`${outsideDay}T00:00:00.000Z`) - 86_400_000)
      .toISOString().slice(0, 10);
    const nowEpoch = Date.now();
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const first = await createV11DeviceFixture(db(), { nowEpoch });
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId, nowEpoch });
    await grantTelemetryV12Consent(db(), first, telemetryV12RequiredConsent(), nowEpoch);
    await grantTelemetryV12Consent(db(), second, telemetryV12RequiredConsent(), nowEpoch);
    await prepareOwner(first.participantId);

    const firstSelected = await stageV12Day(first, selectedDay,
      [v12UsageRecord(selectedDay, `event:v2:${"a".repeat(64)}`)]);
    const secondSelected = await stageV12Day(second, selectedDay,
      [v12UsageRecord(selectedDay, `event:v2:${"b".repeat(64)}`)]);
    await activateV12(first, [firstSelected], nowEpoch);
    await activateV12(second, [secondSelected], nowEpoch);
    await db().prepare(`UPDATE telemetry_v12_device_capabilities
      SET state='revoked',revoked_at=? WHERE participant_id=? AND device_id=?`)
      .bind(new Date(nowEpoch + 1_000).toISOString(), first.participantId, second.deviceId).run();
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();

    const initial = await readDependencyAt(selectedDay);
    expect(initial.owner.hasV12).toBe(true);
    expect(initial.owner.hasEffective).toBe(true);
    expect(initial.dependency.v12).toHaveLength(2);
    expect(new Set(initial.dependency.v12.map(row => row.device_id)).size).toBe(2);

    const analyticsBindings = { source: db(), target: b.STORAGE_ANALYTICS_DB,
      sourceId: namespace, sourceNamespace: namespace };
    await b.STORAGE_ANALYTICS_DB.prepare(`INSERT INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
      .bind(namespace, initial.owner.ownerDigest, initial.owner.ownerRevision,
        initial.owner.authorityEpoch, "active").run();
    const firstScope = await captureStorageGraphScope(db(), { owner: initial.owner,
      day: selectedDay, metric: "fits", sourceId: namespace, sourceNamespace: namespace });
    const firstResult = await computeStorageGraphResult(analyticsBindings, firstScope,
      { maxQueries: 900, deadlineMs: Date.now() + 20_000 });
    expect(firstResult.state).toBe("complete");

    const firstOutside = await stageV12Day(first, outsideDay,
      [v12UsageRecord(outsideDay, `event:v2:${"c".repeat(64)}`)]);
    await activateV12(first, [firstSelected, firstOutside], nowEpoch + 2_000);
    const outside = await readDependencyAt(selectedDay);
    expect(outside.dependency).toEqual(initial.dependency);
    expect(outside.pin.fingerprint).toBe(initial.pin.fingerprint);
    const secondScope = await captureStorageGraphScope(db(), { owner: outside.owner,
      day: selectedDay, metric: "fits", sourceId: namespace, sourceNamespace: namespace });
    expect(secondScope.checkpointDependencyDigest).toBe(firstScope.checkpointDependencyDigest);
    const reused = await computeStorageGraphResult(analyticsBindings, secondScope,
      { maxQueries: 900, deadlineMs: Date.now() + 20_000 });
    expect(reused).toMatchObject({ state: "complete", reused: true });
  }, 120_000);
});
