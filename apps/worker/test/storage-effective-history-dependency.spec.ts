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
  type TelemetryV12QuotaObservation,
  type TelemetryV12Record,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { currentTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { createEffectiveHistoryDayDependencyReader, effectiveHistoryDependency,
  effectiveHistoryPin } from "../src/storage-effective-history";
import { readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays } from "../src/telemetry-usage-effective-reader";
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
import { createStorageEffectiveQuotaPreparation } from "../src/storage-effective-quota-days";
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow } from "../src/effective-quota-day";
import { createV11QuotaAcquisitionIdentity } from "../src/quota-analysis-v11";
import { advanceV11QuotaAcquisition, V11_QUOTA_ACQUISITION_PAGE_SIZE,
  type V11QuotaPageReader } from "../src/quota-analysis-v11-reader";
import type { StorageCommunityOwner } from "../src/storage-community-authority";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";

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

async function insertV1HistoryDay(fixture: Fixture, selectedDay: string, revision: number,
  supersedes: Awaited<ReturnType<typeof currentTelemetryV1Chunk>> = null) {
  const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(selectedDay, "a", {
    eventId: `event:v2:synthetic-v1-${selectedDay}`,
    totalInputContextTokens: revision > 1 ? 150 : null,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: null, inputCacheWriteTokens: null,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: revision > 1 ? 75 : null },
  }));
  if (!projected) throw new Error("synthetic history v1 projection missing");
  const records = [JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent];
  const envelopeDigest = await sha256Hex(`synthetic-history-v1:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${selectedDay}:0`, chunkRevision: revision,
    chunkDigest: await sha256Hex(canonicalJson(records)), parserVersion: "synthetic-history-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records,
  });
  return insertTypedTelemetryV1Chunk(db(), { chunkRowId: `chunk:${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId, chunk, envelopeDigest,
    r2Key: `synthetic/history-v1/${crypto.randomUUID()}`, deviceUploadAuthorizationId: claimed.authorizationId,
    createdAt: new Date().toISOString(), supersedes }, namespace);
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
  records: readonly TelemetryV12Record[]): Promise<V12Uploaded> {
  const consent = telemetryV12RequiredConsent();
  const chunks: TelemetryV12Chunk[] = [];
  for (const stream of ["quota", "session", "usage"] as const) {
    const selected = records.filter(record => record.schemaVersion.startsWith(`${stream}-`));
    for (let offset = 0; offset < selected.length; offset += 200) {
      const chunkRecords = selected.slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${observedDay}:${offset / 200}`, chunkRevision: 1,
        parserVersion: "synthetic-effective-history-v12", consent, records: chunkRecords,
        chunkDigest: await sha256Hex(canonicalTelemetryV12Json(chunkRecords)) });
    }
  }
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day: observedDay,
    parserVersion: "synthetic-effective-history-v12", consent,
    chunks: chunks.map(chunk => ({ chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest);
  for (const chunk of chunks) {
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
  }
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
  it("keeps occurrence-link reads scoped to the owner while retaining outside-day conflicts", async () => {
    const selectedDay = day(), outsideDay = dayAfter(selectedDay);
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
    const fixture = await createV11DeviceFixture(db());
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent());
    await prepareOwner(fixture.participantId);
    const occurrence = `event:v2:${"a".repeat(64)}`;
    const selected = await stageV12Day(fixture, selectedDay, [v12UsageRecord(selectedDay, occurrence)]);
    const outside = await stageV12Day(fixture, outsideDay, [v12UsageRecord(outsideDay, occurrence)]);
    await activateV12(fixture, [selected, outside]);

    const measure = async () => {
      let rowsRead = 0;
      const source = new Proxy(db(), { get(target, key) {
        if (key === "prepare") return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
            get(inner, member) {
              if (member === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
              if (member === "all") return async () => {
                const result = await inner.all();
                if (sql.includes("selected(occurrence_id)") || sql.includes("direct AS (")) {
                  rowsRead += result.meta.rows_read;
                }
                return result;
              };
              const value = Reflect.get(inner, member);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
          return wrap(target.prepare(sql));
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const owner = (await readStorageCommunityOwnerPage(db()))
        .find(value => value.participantId === fixture.participantId)!;
      const dependency = await effectiveHistoryDependency(source, owner, namespace, selectedDay, selectedDay);
      for (const stream of ["usage", "quota", "session"] as const) {
        const scope = { sourceNamespace: namespace, ownerDigest: owner.ownerDigest!,
          ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch, stream };
        const page = await readEffectiveTelemetryOwnerDayPage(source, { ...scope, day: selectedDay, limit: 1 });
        expect(page.rows).toHaveLength(stream === "usage" ? 1 : 0);
        if (stream === "usage") expect(page.rows[0]).toMatchObject({ status: "conflict", eventTimeConflict: true });
        const days = await readEffectiveTelemetryOwnerDays(source,
          { ...scope, fromDay: selectedDay, throughDay: outsideDay });
        expect(days).toEqual(stream === "usage" ? [selectedDay, outsideDay] : []);
      }
      expect(rowsRead).toBeGreaterThan(0);
      return { dependency, rowsRead };
    };
    const before = await measure();
    expect(before.dependency.occurrenceLinks).toEqual([
      expect.objectContaining({ family: "v12", source_day: outsideDay, source_digest: outside.manifestDigest }),
    ]);

    const unrelated = await createV11DeviceFixture(db(), { grant: true });
    const records = Array.from({ length: 600 }, (_, index) => v11UsageRecord(selectedDay, "b", {
      eventId: `event:v2:${index.toString(16).padStart(64, "0")}`,
    }));
    await activate(unrelated, [await stage(unrelated, await makeV11Day(selectedDay, { usage: records }))]);
    const after = await measure();
    expect(after.dependency).toEqual(before.dependency);
    // Native D1 read counts catch a namespace-wide SEARCH as well as a SCAN.
    // Unrelated records must not be decoded or have their chunk proofs counted.
    expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 200);
  }, 60_000);

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

type DependencyQuery = { sql: string; values: readonly unknown[] };
function observeDependencyQueries(source: D1Database, options: {
  rows?: (query: DependencyQuery, rows: Record<string, unknown>[]) => Record<string, unknown>[];
  afterQuery?: (query: DependencyQuery) => void;
} = {}) {
  const queries: DependencyQuery[] = [];
  const database = new Proxy(source, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement, values: readonly unknown[] = []): D1PreparedStatement =>
        new Proxy(statement, { get(inner, member) {
          if (member === "bind") return (...bound: unknown[]) => wrap(inner.bind(...bound), bound);
          if (member === "all") return async () => {
            const query = { sql, values };
            const result = await inner.all<Record<string, unknown>>();
            queries.push(query);
            const rows = options.rows?.(query, result.results) ?? result.results;
            options.afterQuery?.(query);
            return { ...result, results: rows };
          };
          const value = Reflect.get(inner, member);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      return wrap(target.prepare(sql));
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, queries };
}

const emptyDependencyOwner: StorageCommunityOwner = {
  participantId: "participant:synthetic-empty-history", ownerDigest: "a".repeat(64),
  inputRevision: 1, ownerRevision: 1, authorityEpoch: 1,
  hasV1: false, hasV11: false, hasV12: false, hasLegacy: false, hasEffective: true,
};

describe("bounded shared effective day dependencies", () => {
  it("seeks typed occurrence links by owner and stream before decoding compatibility rows", async () => {
    const observed = observeDependencyQueries(db());
    await effectiveHistoryDependency(observed.database, emptyDependencyOwner, namespace, day(), day());
    const query = observed.queries.find(value => value.sql.includes("selected(occurrence_id)"))!;
    const plan = (await db().prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values)
      .all<{ detail: string }>()).results;
    const typedSeeks = plan.filter(row => row.detail.includes("scoped_record"));
    expect(typedSeeks).toHaveLength(4);
    for (const row of typedSeeks) {
      expect(row.detail).toContain("SEARCH scoped_record");
      expect(row.detail).toContain("owner_id=? AND stream=?");
    }
  });

  it("matches exact singleton digests across v1, v1.1, v1.2, sessions, corrections, and selected-day links", async () => {
    const days = [day(), dayAfter(day())];
    const legacy = await createV11DeviceFixture(db());
    for (const selectedDay of days) await insertV1HistoryDay(legacy, selectedDay, 1);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    for (const selectedDay of days) {
      const previous = await currentTelemetryV1Chunk(db(), legacy.participantId, legacy.deviceId, "usage", selectedDay, 0);
      expect(previous).not.toBeNull();
      await insertV1HistoryDay(legacy, selectedDay, 2, previous);
    }
    const v11 = await createV11DeviceFixture(db(), { grant: true });
    const v11Days: Staged[] = [];
    for (const selectedDay of days) v11Days.push(await stage(v11, await makeV11Day(selectedDay, {
      usage: [v11UsageRecord(selectedDay, "b", { eventId: `event:v2:synthetic-v11-${selectedDay}` })],
      session: [{ schemaVersion: "session-dimension-v1.1", sessionUuid: `session:synthetic-history-${selectedDay}`,
        firstEventTime: `${selectedDay}T12:00:00.000Z`, provider: "openai_codex",
        toolClassCounts: { shell: 1, other: 0 } }],
    })));
    await activate(v11, v11Days);
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
    const v12 = await createV11DeviceFixture(db());
    await grantTelemetryV12Consent(db(), v12, telemetryV12RequiredConsent());
    await prepareOwner(v12.participantId);
    const v12Days: V12Uploaded[] = [];
    for (const selectedDay of days) v12Days.push(await stageV12Day(v12, selectedDay,
      [v12UsageRecord(selectedDay, `event:v2:${"c".repeat(64)}`)]));
    await activateV12(v12, v12Days);
    const owners = await readStorageCommunityOwnerPage(db());

    for (const [family, fixture] of [["v1", legacy], ["v11", v11], ["v12", v12]] as const) {
      const owner = owners.find(value => value.participantId === fixture.participantId)!;
      expect(owner).toBeDefined();
      for (const includeSessions of [false, true]) {
        const observed = observeDependencyQueries(db());
        const reader = await createEffectiveHistoryDayDependencyReader(observed.database, owner, namespace,
          days, { includeSessions });
        expect(reader).toBeDefined();
        expect(observed.queries).toHaveLength(5);
        for (const [index, selectedDay] of days.entries()) {
          const exact = await effectiveHistoryDependency(db(), owner, namespace, selectedDay, selectedDay,
            { includeSessions });
          for (const vector of ["v1", "v11", "v12"] as const) expect(exact[vector]).toHaveLength(vector === family ? 1 : 0);
          expect(exact.corrections).toEqual(family === "v1"
            ? [expect.objectContaining({ event_day: selectedDay, history_fact_count: 1 })] : []);
          if (family === "v12") expect(exact.occurrenceLinks).toEqual(expect.arrayContaining([
            expect.objectContaining({ family: "v12", source_day: days[1 - index] }),
          ]));
          expect(await reader!.readDigest(selectedDay)).toBe(await sha256Hex(canonicalJson(exact)));
          expect(observed.queries).toHaveLength(6 + index);
        }
        const wholeWindow = await effectiveHistoryDependency(db(), owner, namespace, days[0]!, days[1]!,
          { includeSessions });
        expect(wholeWindow.occurrenceLinks).toEqual([]);
        // Each v1.2 singleton still links the other selected day. A partition
        // of the whole-window result would silently omit that evidence.
        expect(observed.queries.filter(query => query.sql.includes("selected(occurrence_id)"))).toHaveLength(2);
        expect(observed.queries.some(query => query.sql.includes("q.used_percent")
          || query.sql.includes("payload_json"))).toBe(false);
      }
    }
  }, 60_000);

  it("stops after six source statements when only the first of 101 digests is needed", async () => {
    const first = Date.parse("2026-05-01T00:00:00.000Z");
    const days = Array.from({ length: 101 }, (_, index) => new Date(first + index * 86_400_000).toISOString().slice(0, 10));
    const observed = observeDependencyQueries(db());
    const reader = await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner, namespace, days);
    expect(observed.queries).toHaveLength(5);
    const exact = await effectiveHistoryDependency(db(), emptyDependencyOwner, namespace, days[0]!, days[0]!);
    expect(await reader!.readDigest(days[0]!)).toBe(await sha256Hex(canonicalJson(exact)));
    expect(observed.queries).toHaveLength(6);
    expect(observed.queries.filter(query => query.sql.includes("selected(occurrence_id)"))).toHaveLength(1);
    expect(observed.queries.some(query => query.sql.includes("payload_json") || query.sql.includes("q.used_percent"))).toBe(false);
  });

  it.each(["schema", "v1", "v11", "v12", "corrections"] as const)(
    "stops optional work when the deadline expires after the %s query", async (phase) => {
      const selectedDay = day();
      let now = 0;
      const queryCounts = { schema: 1, v1: 2, v11: 3, v12: 4, corrections: 5 };
      const observed = observeDependencyQueries(db(), { afterQuery() {
        if (observed.queries.length === queryCounts[phase]) now = 10;
      } });
      const reader = await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
        namespace, [selectedDay], { canContinue: () => now < 10 });
      if (phase === "corrections") {
        expect(reader).toBeDefined();
        expect(await reader!.readDigest(selectedDay)).toBeUndefined();
      } else expect(reader).toBeUndefined();
      expect(observed.queries).toHaveLength(queryCounts[phase]);
      expect(observed.queries.some(query => query.sql.includes("selected(occurrence_id)"))).toBe(false);
    });

  it("rejects invalid scopes and unselected reads before querying, and honors an already elapsed deadline", async () => {
    const observed = observeDependencyQueries(db());
    const first = "2026-05-01", second = "2026-05-02";
    for (const days of [[second, first], [first, first], ["2026-02-30"], [first, "2026-08-10"],
      Array.from({ length: 102 }, (_, index) => new Date(Date.parse(first) + index * 86_400_000).toISOString().slice(0, 10))]) {
      await expect(createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner, namespace, days))
        .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
    }
    expect(await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
      namespace, [first, second], { canContinue: () => false })).toBeUndefined();
    expect(observed.queries).toHaveLength(0);
    const reader = await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
      namespace, [first]);
    await expect(reader!.readDigest(second)).rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
    expect(observed.queries).toHaveLength(5);
  });

  it.each(["rows", "bytes"] as const)("declines aggregate %s overflow while preserving exact single-day fallback", async (kind) => {
    const days = ["2026-05-01", "2026-05-02"];
    const rowsByFamily = {
      v1: Array.from({ length: kind === "rows" ? 15_000 : 20_000 }, (_, index) => ({
        id: `chunk:${index.toString().padStart(5, "0")}`, device_id: "device:synthetic", stream: "usage",
        chunk_day: days[index < (kind === "rows" ? 7_500 : 10_000) ? 0 : 1], chunk_seq: index, revision: 1,
        chunk_digest: "b".repeat(64), accepted_record_count: 1,
      })),
      v11: kind === "rows" ? Array.from({ length: 15_001 }, (_, index) => ({
        device_id: "device:synthetic-v11", observed_day: days[index < 7_500 ? 0 : 1],
        manifest_id: `manifest:${index.toString().padStart(5, "0")}`, manifest_digest: "c".repeat(64),
      })) : [],
    };
    const v1Bytes = new TextEncoder().encode(canonicalJson(rowsByFamily.v1)).byteLength;
    expect(rowsByFamily.v1.length).toBeLessThanOrEqual(30_000);
    expect(rowsByFamily.v11.length).toBeLessThanOrEqual(30_000);
    if (kind === "rows") expect(v1Bytes).toBeLessThan(4 * 1024 * 1024);
    else expect(v1Bytes).toBeGreaterThan(4 * 1024 * 1024);
    const observed = observeDependencyQueries(db(), { rows(query, original) {
      if (query.sql.startsWith("SELECT c.id,c.device_id,c.stream,c.chunk_day")) {
        return rowsByFamily.v1.filter(row => row.chunk_day! >= String(query.values[3])
          && row.chunk_day! <= String(query.values[4])).slice(0, Number(query.values.at(-1)));
      }
      if (query.sql.startsWith("SELECT DISTINCT event.device_id,domain_day.observed_day")) {
        return rowsByFamily.v11.filter(row => row.observed_day! >= String(query.values[2])
          && row.observed_day! <= String(query.values[3])).slice(0, Number(query.values.at(-1)));
      }
      return original;
    } });
    expect(await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
      namespace, days)).toBeUndefined();
    expect(observed.queries).toHaveLength(kind === "rows" ? 3 : 2);
    if (kind === "rows") expect(observed.queries[2]!.values.at(-1)).toBe(15_001);
    expect(observed.queries.some(query => query.sql.includes("selected(occurrence_id)"))).toBe(false);
    for (const selectedDay of days) {
      const exact = await effectiveHistoryDependency(observed.database, emptyDependencyOwner,
        namespace, selectedDay, selectedDay);
      const reader = await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
        namespace, [selectedDay]);
      expect(reader).toBeDefined();
      expect(await reader!.readDigest(selectedDay)).toBe(await sha256Hex(canonicalJson(exact)));
      expect(exact.v1.length).toBe(kind === "rows" ? 7_500 : 10_000);
    }
  }, 60_000);

  it("supports an absent v1.2 schema and keeps partial-schema or provider errors visible", async () => {
    await reset();
    for (const migrations of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS,
      b.TEST_INGESTION_BRIDGE_MIGRATIONS, b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
      b.TEST_TYPED_V11_ADMISSION_MIGRATIONS]) await applyD1Migrations(db(), migrations);
    await applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS
      .filter(migration => !/^(0008|0010|0011|0012)_/u.test(migration.name)));
    const selectedDay = day();
    const observed = observeDependencyQueries(db());
    const reader = await createEffectiveHistoryDayDependencyReader(observed.database, emptyDependencyOwner,
      namespace, [selectedDay]);
    expect(reader).toBeDefined();
    expect(observed.queries).toHaveLength(4);
    const exact = await effectiveHistoryDependency(db(), emptyDependencyOwner, namespace, selectedDay, selectedDay);
    expect(exact.v12).toEqual([]);
    expect(await reader!.readDigest(selectedDay)).toBe(await sha256Hex(canonicalJson(exact)));
    expect(observed.queries).toHaveLength(5);

    const providerError = new Error("synthetic D1 provider unavailable");
    const failing = observeDependencyQueries(db(), { rows(query, rows) {
      if (query.sql.startsWith("SELECT c.id,c.device_id,c.stream,c.chunk_day")) throw providerError;
      return rows;
    } });
    await expect(createEffectiveHistoryDayDependencyReader(failing.database, emptyDependencyOwner,
      namespace, [selectedDay])).rejects.toBe(providerError);
    await db().prepare("CREATE TABLE telemetry_v12_runtime (id INTEGER PRIMARY KEY)").run();
    await expect(createEffectiveHistoryDayDependencyReader(db(), emptyDependencyOwner, namespace, [selectedDay]))
      .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
    await expect(effectiveHistoryDependency(db(), emptyDependencyOwner, namespace, selectedDay, selectedDay))
      .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  });
});

function v12QuotaRecords(selectedDay: string): TelemetryV12QuotaObservation[] {
  const start = Date.parse(`${selectedDay}T01:00:00.000Z`);
  return Array.from({ length: 9 }, (_, index) => ({
    schemaVersion: "quota-observation-v1.2", observationId: `quota:v12:${index.toString(16).padStart(64, "0")}`,
    observedTime: new Date(start + index * 20 * 60_000).toISOString(),
    provider: "openai_codex", planType: "pro", planVariant: "unknown", limitId: "codex",
    slot: "seven_day", usedPercent: 10 + index * 5, windowDurationMinutes: 10_080,
    resetsAt: new Date(start + 7 * 86_400_000).toISOString(),
    accountPlanAttribution: { accountBasis: "same_source", accountTrackId: `account-track:v2:${"f".repeat(64)}`,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
  }));
}

async function quotaCacheFor(owner: StorageCommunityOwner, source = db(), target = b.STORAGE_ANALYTICS_DB) {
  if (!owner.ownerDigest) throw new Error("effective quota fixture owner missing");
  const meter = createD1InvocationBudget(950);
  const cache = await createStorageEffectiveQuotaPreparation({
    source: meter.wrap(source), target: meter.wrap(target),
    sourceId: namespace, sourceNamespace: namespace,
    owner: { ...owner, ownerDigest: owner.ownerDigest },
    remainingQueries: () => meter.remainingQueries, deadlineMs: Date.now() + 60_000, now: Date.now,
  });
  expect(cache).toBeDefined();
  return { cache: cache!, meter };
}

function observeQuotaPayloadReads(source: D1Database) {
  let payloadReads = 0;
  const database = new Proxy(source, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      // Source dependency SQL reads immutable headers. The actual effective
      // quota decoder joins the typed value columns named here.
      if (sql.includes("q.used_percent") && sql.includes("q.resets_at_ms")) payloadReads += 1;
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, reads: () => payloadReads, clear: () => { payloadReads = 0; } };
}

async function quotaCacheFixture() {
  const selectedDay = new Date(Date.parse(`${day()}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  const fixture = await createV11DeviceFixture(db());
  await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent());
  await prepareOwner(fixture.participantId);
  const records = v12QuotaRecords(selectedDay);
  const selected = await stageV12Day(fixture, selectedDay, records);
  await activateV12(fixture, [selected]);
  const initial = await readDependencyAt(selectedDay);
  expect(initial.owner.hasV12).toBe(true);
  await b.STORAGE_ANALYTICS_DB.prepare(`INSERT INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
    .bind(namespace, initial.owner.ownerDigest, initial.owner.ownerRevision,
      initial.owner.authorityEpoch, "active").run();
  const dependencyDigest = await sha256Hex(canonicalJson(await effectiveHistoryDependency(db(),
    initial.owner, namespace, selectedDay, selectedDay, { includeSessions: true })));
  const dailyFingerprint = canonicalJson({ method: "effective-daily-cursor-v2", dependencyDigest,
    streams: { quota: null, session: null, usage: null } });
  await b.STORAGE_ANALYTICS_DB.prepare(`INSERT INTO analytics_community_daily_owners
    (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,
      next_index,fingerprint,complete,values_json) VALUES(?,?,?,?,?,'effective','synthetic',1,0,?,1,'{}')`)
    .bind(namespace, selectedDay, initial.owner.ownerDigest, initial.owner.inputRevision,
      initial.owner.ownerRevision, dailyFingerprint).run();
  const observed = observeQuotaPayloadReads(db());
  const page = await readEffectiveTelemetryOwnerDayPage(observed.database, {
    sourceNamespace: namespace, ownerDigest: initial.owner.ownerDigest!,
    ownerRevision: initial.owner.ownerRevision, authorityEpoch: initial.owner.authorityEpoch,
    day: selectedDay, stream: "quota", limit: 200,
  });
  expect(page.next).toBeNull();
  expect(page.rows).toHaveLength(records.length);
  expect(observed.reads()).toBeGreaterThan(0);
  const rows = page.rows.map((entry, index) => mapEffectiveQuotaPageRow(entry, selectedDay, index + 1));
  const pending = appendEffectiveQuotaDay(null, selectedDay, rows, 10_080);
  expect(pending).not.toBeNull();
  const prepared = finishEffectiveQuotaDay(pending!)!;
  expect(prepared).toBeDefined();
  const { cache, meter } = await quotaCacheFor(initial.owner, observed.database);
  await cache.store(prepared);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  const identity = createV11QuotaAcquisitionIdentity(initial.pin, Date.parse(`${selectedDay}T23:00:00.000Z`));
  return { fixture, selectedDay, records, selected, initial, prepared, rows, identity,
    dailyFingerprint, observed };
}

async function retainedDailyFingerprint(selectedDay: string): Promise<string | null> {
  return b.STORAGE_ANALYTICS_DB.prepare(`SELECT fingerprint FROM analytics_community_daily_owners
    WHERE source_id=? AND day=?`).bind(namespace, selectedDay).first<string>("fingerprint");
}

describe("effective quota preparation source fences", () => {
  it("skips exact cached days in an incomplete window without decoding or preparing them again", async () => {
    const fixture = await quotaCacheFixture();
    fixture.observed.clear();
    const { cache, meter } = await quotaCacheFor(fixture.initial.owner, fixture.observed.database);
    const missingDay = dayAfter(fixture.selectedDay);
    expect(await cache.load([fixture.selectedDay, missingDay], fixture.identity)).toBeUndefined();
    const before = meter.queriesUsed;
    expect(await cache.shouldPrepare!(fixture.selectedDay)).toBe(false);
    const validated = meter.queriesUsed;
    expect(validated - before).toBe(6);
    expect(await cache.shouldPrepare!(fixture.selectedDay)).toBe(false);
    expect(await cache.shouldPrepare!(missingDay)).toBe(true);
    expect(meter.queriesUsed).toBe(validated);
    expect(fixture.observed.reads()).toBe(0);
  }, 60_000);

  it("prepares a changed day again even when its previous cached head remains", async () => {
    const fixture = await quotaCacheFixture();
    const changed = fixture.records.map((record, index) => index === 4 ? { ...record, usedPercent: 37 } : record);
    const replacement = await stageV12Day(fixture.fixture, fixture.selectedDay, changed);
    await activateV12(fixture.fixture, [replacement]);
    const current = await readDependencyAt(fixture.selectedDay);
    const { cache } = await quotaCacheFor(current.owner);
    expect(await cache.load([fixture.selectedDay, dayAfter(fixture.selectedDay)], fixture.identity)).toBeUndefined();
    expect(await cache.shouldPrepare!(fixture.selectedDay)).toBe(true);
    expect(await retainedDailyFingerprint(fixture.selectedDay)).toBe(fixture.dailyFingerprint);
  }, 60_000);

  it("loads real v1.2 quota without decoding it again and folds the same acquisition", async () => {
    const fixture = await quotaCacheFixture();
    fixture.observed.clear();
    const { cache, meter } = await quotaCacheFor(fixture.initial.owner, fixture.observed.database);
    const loaded = await cache.load([fixture.selectedDay], fixture.identity);
    expect(canonicalJson(loaded)).toBe(canonicalJson([fixture.prepared]));
    expect(fixture.observed.reads()).toBe(0);
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    const reader: V11QuotaPageReader = { pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
      async readPage(cursor, limit) {
        return fixture.rows.filter(row => row.observedAtMs > cursor.observedAtMs
          || row.observedAtMs === cursor.observedAtMs && row.sourceRowId > cursor.sourceRowId).slice(0, limit);
      } };
    const paged = await advanceV11QuotaAcquisition(reader, fixture.identity,
      { remainingQueries: 100, deadlineMs: 1, now: () => 0 });
    expect(paged.status).toBe("complete");
    if (paged.status !== "complete") throw new Error("quota oracle must complete");
    expect(paged.quotaRows.length).toBeGreaterThan(0);
    expect(canonicalJson(foldEffectiveQuotaDays(fixture.identity, loaded!, [fixture.selectedDay])))
      .toBe(canonicalJson(paged));
  }, 60_000);

  it("reuses a prepared day after an unrelated later-day append advances the owner revision", async () => {
    const fixture = await quotaCacheFixture();
    const outsideDay = dayAfter(fixture.selectedDay);
    const appended = await stageV12Day(fixture.fixture, outsideDay,
      [v12UsageRecord(outsideDay, `event:v2:${"e".repeat(64)}`)]);
    await activateV12(fixture.fixture, [fixture.selected, appended]);
    const current = await readDependencyAt(fixture.selectedDay);
    expect(current.owner.ownerRevision).toBeGreaterThan(fixture.initial.owner.ownerRevision);
    expect(current.pin.fingerprint).toBe(fixture.initial.pin.fingerprint);
    expect(await retainedDailyFingerprint(fixture.selectedDay)).toBe(fixture.dailyFingerprint);
    const { cache } = await quotaCacheFor(current.owner);
    expect(canonicalJson(await cache.load([fixture.selectedDay], fixture.identity)))
      .toBe(canonicalJson([fixture.prepared]));
  }, 60_000);

  it("misses an in-day replacement while the published daily fingerprint still names the old input", async () => {
    const fixture = await quotaCacheFixture();
    const changed = fixture.records.map((record, index) => index === 4 ? { ...record, usedPercent: 37 } : record);
    const replacement = await stageV12Day(fixture.fixture, fixture.selectedDay, changed);
    await activateV12(fixture.fixture, [replacement]);
    const current = await readDependencyAt(fixture.selectedDay);
    expect(current.pin.fingerprint).not.toBe(fixture.initial.pin.fingerprint);
    expect(await retainedDailyFingerprint(fixture.selectedDay)).toBe(fixture.dailyFingerprint);
    const { cache } = await quotaCacheFor(current.owner);
    expect(await cache.load([fixture.selectedDay], fixture.identity)).toBeUndefined();
  }, 60_000);

  it("misses a linked outside-day occurrence change while daily publication lags", async () => {
    const fixture = await quotaCacheFixture();
    const outsideDay = dayAfter(fixture.selectedDay);
    const linked: TelemetryV12QuotaObservation = { ...fixture.records[0]!,
      observedTime: `${outsideDay}T01:00:00.000Z` };
    const appended = await stageV12Day(fixture.fixture, outsideDay, [linked]);
    await activateV12(fixture.fixture, [fixture.selected, appended]);
    const current = await readDependencyAt(fixture.selectedDay);
    expect(current.dependency.occurrenceLinks).toEqual([
      expect.objectContaining({ family: "v12", source_day: outsideDay, source_digest: appended.manifestDigest }),
    ]);
    expect(current.pin.fingerprint).not.toBe(fixture.initial.pin.fingerprint);
    expect(await retainedDailyFingerprint(fixture.selectedDay)).toBe(fixture.dailyFingerprint);
    const { cache } = await quotaCacheFor(current.owner);
    expect(await cache.load([fixture.selectedDay], fixture.identity)).toBeUndefined();
  }, 60_000);

  it("refuses stale owner revision and authority on both cache reads and writes", async () => {
    const fixture = await quotaCacheFixture();
    for (const column of ["revision", "authority_epoch"] as const) {
      const stale = (await readDependencyAt(fixture.selectedDay)).owner;
      await db().prepare(`UPDATE storage_owner_revisions SET ${column}=${column}+1 WHERE owner_digest=?`)
        .bind(stale.ownerDigest).run();
      const load = await quotaCacheFor(stale);
      await expect(load.cache.load([fixture.selectedDay], fixture.identity))
        .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
      const write = await quotaCacheFor(stale);
      await expect(write.cache.store(fixture.prepared)).rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
    }
  }, 60_000);

  it("loads 101 prepared days within one 950-statement invocation and retains checkpoint headroom", async () => {
    const fixture = await quotaCacheFixture();
    const through = Date.parse(`${fixture.selectedDay}T00:00:00.000Z`);
    const days = Array.from({ length: 101 }, (_, index) => new Date(through - (100 - index) * 86_400_000)
      .toISOString().slice(0, 10));
    // Empty dates still carry an exact source dependency and a validated
    // prepared value. Store each under its own invocation before measuring
    // the one warm window; the final date is the real v1.2 quota fixture.
    for (const selectedDay of days.slice(0, -1)) {
      const pending = appendEffectiveQuotaDay(null, selectedDay, [], 10_080)!;
      const empty = finishEffectiveQuotaDay(pending)!;
      const prepared = await quotaCacheFor(fixture.initial.owner);
      await prepared.cache.store(empty);
      expect(prepared.meter.queriesUsed).toBeLessThanOrEqual(950);
    }
    const dependency = await effectiveHistoryDependency(db(), fixture.initial.owner, namespace,
      days[0]!, fixture.selectedDay);
    const pin = await effectiveHistoryPin(fixture.initial.owner, days[0]!, fixture.selectedDay, dependency);
    const identity = createV11QuotaAcquisitionIdentity(pin, Date.parse(`${fixture.selectedDay}T23:00:00.000Z`));
    fixture.observed.clear();
    const measured = await quotaCacheFor(fixture.initial.owner, fixture.observed.database);
    const loaded = await measured.cache.load(days, identity);
    expect(loaded).toBeDefined();
    expect(loaded!.map(value => value.projection.day)).toEqual(days);
    expect(loaded!.slice(0, -1).every(value => value.quotaRowsRead === 0
      && value.projection.runEndpoints.endpoints.length === 0)).toBe(true);
    expect(canonicalJson(loaded!.at(-1))).toBe(canonicalJson(fixture.prepared));
    expect(fixture.observed.reads()).toBe(0);
    expect(measured.meter.queriesUsed).toBeLessThanOrEqual(230);
    expect(measured.meter.remainingQueries).toBeGreaterThanOrEqual(720);

    // The last source day changes only after the first 100 dependencies still
    // match. A loader that interleaves validation and payload reads wastes its
    // invocation before discovering this miss and cannot advance pagination.
    const replacement = await stageV12Day(fixture.fixture, fixture.selectedDay, [
      ...fixture.records, { ...fixture.records.at(-1)!, observationId: "quota:v12:late-unique-input",
        observedTime: `${fixture.selectedDay}T05:00:00.000Z`, usedPercent: 55,
        accountPlanAttribution: { ...fixture.records.at(-1)!.accountPlanAttribution } },
    ]);
    await activateV12(fixture.fixture, [replacement]);
    const current = await readDependencyAt(fixture.selectedDay);
    const currentDependency = await effectiveHistoryDependency(db(), current.owner, namespace,
      days[0]!, fixture.selectedDay);
    const currentPin = await effectiveHistoryPin(current.owner, days[0]!, fixture.selectedDay, currentDependency);
    const currentIdentity = createV11QuotaAcquisitionIdentity(currentPin,
      Date.parse(`${fixture.selectedDay}T23:00:00.000Z`));
    let cachedPayloadReads = 0;
    const target = new Proxy(b.STORAGE_ANALYTICS_DB, { get(database, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT part_index,component,entry_count,part_digest,payload_json")) cachedPayloadReads += 1;
        return database.prepare(sql);
      };
      const value = Reflect.get(database, key);
      return typeof value === "function" ? value.bind(database) : value;
    } });
    fixture.observed.clear();
    const missed = await quotaCacheFor(current.owner, fixture.observed.database, target);
    expect(await missed.cache.load(days, currentIdentity)).toBeUndefined();
    expect(cachedPayloadReads).toBe(0);
    expect(fixture.observed.reads()).toBe(0);
    expect(missed.meter.queriesUsed).toBeLessThanOrEqual(120);
    expect(missed.meter.remainingQueries).toBeGreaterThanOrEqual(830);

    // Rebuild that day from its now-current effective occurrences. Both
    // immutable cache heads remain, so loading must select the matching
    // dependency without charging or decoding both candidate payloads.
    const currentPage = await readEffectiveTelemetryOwnerDayPage(db(), {
      sourceNamespace: namespace, ownerDigest: current.owner.ownerDigest!,
      ownerRevision: current.owner.ownerRevision, authorityEpoch: current.owner.authorityEpoch,
      day: fixture.selectedDay, stream: "quota", limit: 200,
    });
    expect(currentPage.next).toBeNull();
    expect(currentPage.rows).toHaveLength(fixture.records.length + 1);
    const currentPending = appendEffectiveQuotaDay(null, fixture.selectedDay,
      currentPage.rows.map((row, index) => mapEffectiveQuotaPageRow(row, fixture.selectedDay, index + 1)), 10_080)!;
    const currentPrepared = finishEffectiveQuotaDay(currentPending)!;
    // Model acknowledgement of the newly accepted owner authority before a
    // fresh cache write; the daily publication fingerprint still remains old.
    await b.STORAGE_ANALYTICS_DB.prepare(`UPDATE analytics_owner_state
      SET revision=?,authority_epoch=? WHERE source_id=? AND owner_digest=?`)
      .bind(current.owner.ownerRevision, current.owner.authorityEpoch, namespace, current.owner.ownerDigest).run();
    const writer = await quotaCacheFor(current.owner);
    await writer.cache.store(currentPrepared);
    expect(await b.STORAGE_ANALYTICS_DB.prepare(`SELECT COUNT(*) AS n FROM analytics_graph_day_values
      WHERE source_id=? AND owner_digest=? AND source_layout='effective' AND day=?`)
      .bind(namespace, current.owner.ownerDigest, fixture.selectedDay).first<number>("n")).toBe(2);
    fixture.observed.clear();
    const retained = await quotaCacheFor(current.owner, fixture.observed.database);
    const reloaded = await retained.cache.load(days, currentIdentity);
    expect(reloaded!.map(value => value.projection.day)).toEqual(days);
    expect(canonicalJson(reloaded!.at(-1))).toBe(canonicalJson(currentPrepared));
    expect(fixture.observed.reads()).toBe(0);
    expect(retained.meter.queriesUsed).toBeLessThanOrEqual(230);
    expect(retained.meter.remainingQueries).toBeGreaterThanOrEqual(720);
    console.info("effective quota prepared window resource probe", {
      days: days.length, warmStatements: measured.meter.queriesUsed,
      warmRemaining: measured.meter.remainingQueries, lateMissStatements: missed.meter.queriesUsed,
      lateMissRemaining: missed.meter.remainingQueries, retainedWarmStatements: retained.meter.queriesUsed,
      retainedWarmRemaining: retained.meter.remainingQueries,
    });
  }, 120_000);

  it.each(["payload", "clusters"] as const)(
    "declines oversized %s metadata before source dependencies or cached payload decoding", async (kind) => {
      const fixture = await quotaCacheFixture();
      let dependencyReads = 0, cachedPayloadReads = 0, headReads = 0;
      const source = new Proxy(fixture.observed.database, { get(target, key) {
        if (key === "prepare") return (sql: string) => {
          // This is the first query in every exact effective day dependency.
          if (sql.includes("SELECT name,type FROM sqlite_master")) dependencyReads += 1;
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const target = new Proxy(b.STORAGE_ANALYTICS_DB, { get(database, key) {
        if (key === "prepare") return (sql: string) => {
          if (sql.includes("SELECT part_index,component,entry_count,part_digest,payload_json")) cachedPayloadReads += 1;
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
            get(inner, member) {
              if (member === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
              if (member === "all" && sql.includes("AS fit_fragment_count") && sql.includes("AS payload_bytes")) {
                return async () => {
                  headReads += 1;
                  const result = await inner.all<Record<string, unknown>>();
                  // Inject only validated header counters at the D1 boundary.
                  // This represents a large cache entry without allocating its
                  // payload; reaching the payload reader would fail the test.
                  return { ...result, results: result.results.map(row => kind === "payload"
                    ? { ...row, part_count: 33, payload_bytes: 8 * 1024 * 1024 + 1 }
                    : { ...row, part_count: 16, record_count: 4_097, quota_rows_read: 4_097,
                      fit_fragment_count: 4_097, payload_bytes: 2_000_000 }) };
                };
              }
              const value = Reflect.get(inner, member);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
          return wrap(database.prepare(sql));
        };
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      } });
      fixture.observed.clear();
      const measured = await quotaCacheFor(fixture.initial.owner, source, target);
      expect(await measured.cache.load([fixture.selectedDay], fixture.identity)).toBeUndefined();
      expect(headReads).toBe(1);
      expect(dependencyReads).toBe(0);
      expect(cachedPayloadReads).toBe(0);
      expect(fixture.observed.reads()).toBe(0);
      expect(measured.meter.remainingQueries).toBeGreaterThanOrEqual(120);
    }, 60_000);
});
