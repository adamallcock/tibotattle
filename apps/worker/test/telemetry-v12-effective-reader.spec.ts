import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
  type TelemetryV12Record,
} from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import {
  persistTelemetryV12StagedChunk,
  registerTelemetryV12DayManifest,
} from "../src/telemetry-v12-repository";
import {
  activateTelemetryV12Domain,
  createTelemetryV12DomainPredecessor,
} from "../src/telemetry-v12-domain";
import {
  readTelemetryV12EffectiveDays,
  readTelemetryV12EffectiveOccurrences,
  readTelemetryV12EffectivePage,
} from "../src/telemetry-v12-effective-reader";
import { readEffectiveTelemetryOwnerDayPage, readEffectiveUsageOwnerDayPage } from "../src/telemetry-usage-effective-reader";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const bindings = env as Bindings;
const db = () => bindings.USAGE_MONITOR_DB;
const day = "2026-09-20";
// The admission trigger compares expiry against SQLite's wall clock. Keep the
// synthetic caller timestamp current so this test remains valid after the
// fixed fixture timestamp would have crossed the predecessor TTL.
const nowEpoch = Date.now();

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v12-reader-source");
});

function usageRecord(eventId: string, fill: string, eventTime = day + "T12:05:00.000Z"): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

async function uploadDay(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  records: readonly TelemetryV12Record[],
  chunkSize = 200,
  revision = 1,
): Promise<{ manifestId: string; manifestDigest: string }> {
  const consent = telemetryV12RequiredConsent();
  const parserVersion = `synthetic-v12-effective-reader-${revision}`;
  const chunks: TelemetryV12Chunk[] = [];
  for (const stream of ["quota", "session", "usage"] as const) {
    const selected = records.filter(row => row.schemaVersion.startsWith(stream + "-"));
    for (let offset = 0; offset < selected.length; offset += chunkSize) {
      const chunkRecords = selected.slice(offset, offset + chunkSize);
      chunks.push({
        schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: stream + ":" + day + ":" + offset / chunkSize, chunkRevision: 1,
        parserVersion, consent,
        records: [...chunkRecords], chunkDigest: await sha256Hex(canonicalTelemetryV12Json(chunkRecords)),
      });
    }
  }
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day,
    parserVersion, consent,
    chunks: chunks.map(chunk => ({chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length})),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    const principal = await authenticateDevice(db(), fixture.authorization);
    const envelopeDigest = await sha256Hex("synthetic-v12-reader-envelope-" + crypto.randomUUID());
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 4096);
    const claimed = await claimDeviceUploadAuthorization(db(), "Upload " + upload.uploadAuthorization, {
      envelopeDigest, bodyBytes: 4096, contentType: "application/json",
    });
    await persistTelemetryV12StagedChunk(db(), fixture, chunk, {
      chunkRowId: "chunk:" + crypto.randomUUID(), r2Key: "synthetic/v12-reader/" + crypto.randomUUID(),
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return { manifestId: candidate.manifestId, manifestDigest: manifest.manifestDigest };
}

async function activate(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  uploaded: { manifestId: string; manifestDigest: string },
): Promise<string> {
  const predecessor = await createTelemetryV12DomainPredecessor(db(), fixture, nowEpoch);
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: day,
    throughDay: day,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: [{ day, manifestId: uploaded.manifestId, manifestDigest: uploaded.manifestDigest }],
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return (await activateTelemetryV12Domain(db(), fixture, manifest, nowEpoch)).generationId;
}

async function prepareOwner(participantId: string): Promise<{
  ownerDigest: string;
  ownerRevision: number;
  authorityEpoch: number;
}> {
  const ownerDigest = "a".repeat(64);
  const ownerRevision = 1;
  const authorityEpoch = 1;
  await db().prepare(
    "INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,?,?,?)",
  ).bind(participantId, ownerDigest, "active", ownerDigest, ownerDigest).run();
  await db().prepare(
    "INSERT INTO storage_owner_revisions(owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?)",
  ).bind(ownerDigest, ownerRevision, authorityEpoch, "active").run();
  return { ownerDigest, ownerRevision, authorityEpoch };
}

describe("typed v1.2 effective reader", () => {
  it("reads disjoint and overlapping observations from both retained device generations", async () => {
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    await grantTelemetryV12Consent(db(), first, telemetryV12RequiredConsent(), nowEpoch);
    await grantTelemetryV12Consent(db(), second, telemetryV12RequiredConsent(), nowEpoch);
    await prepareOwner(first.participantId);

    const shared = "event:v2:" + "1".repeat(64);
    const firstOnly = "event:v2:" + "2".repeat(64);
    const secondOnly = "event:v2:" + "3".repeat(64);
    const firstUpload = await uploadDay(first, [
      usageRecord(shared, "shared"),
      usageRecord(firstOnly, "first"),
    ], 1);
    const secondUpload = await uploadDay(second, [
      usageRecord(shared, "shared"),
      usageRecord(secondOnly, "second"),
    ], 1);
    const firstGeneration = await activate(first, firstUpload);
    const secondGeneration = await activate(second, secondUpload);
    expect(firstGeneration).not.toBe(secondGeneration);
    expect(await db().prepare("SELECT generation_id FROM telemetry_v12_domain_heads WHERE participant_id=?")
      .bind(first.participantId).first<string>("generation_id")).toBe(secondGeneration);

    const page = await readTelemetryV12EffectivePage(db(), {
      participantId: first.participantId, day, stream: "usage", limit: 10,
    });
    expect(page.available).toBe(true);
    expect(page.records).toHaveLength(4);
    expect(page.records.map((row) => row.occurrenceId)).toEqual([
      shared, shared, firstOnly, secondOnly,
    ]);
    expect(page.records.every((row) => row.recordJson.includes("usage-event-v1.1"))).toBe(true);
    expect(new Set(page.records.map((row) => row.sourceRecordKey)).size).toBe(4);

    const occurrences = await readTelemetryV12EffectiveOccurrences(db(), {
      participantId: first.participantId, stream: "usage",
      occurrenceIds: [shared, firstOnly, secondOnly],
    });
    expect(occurrences.available).toBe(true);
    expect(occurrences.records).toHaveLength(4);
    expect(occurrences.records.filter((row) => row.occurrenceId === shared)).toHaveLength(2);
    expect(occurrences.records.filter((row) => row.occurrenceId === firstOnly)).toHaveLength(1);
    expect(occurrences.records.filter((row) => row.occurrenceId === secondOnly)).toHaveLength(1);

    await expect(readTelemetryV12EffectiveDays(db(), {
      participantId: first.participantId, fromDay: day, throughDay: day, stream: "usage",
    })).resolves.toEqual([day]);
  });

  it("decodes typed quota attribution and session tool counts through both effective entrypoints", async () => {
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const fixture = await createV11DeviceFixture(db());
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), nowEpoch);
    const owner = await prepareOwner(fixture.participantId);
    const quota: TelemetryV12Record = {
      schemaVersion: "quota-observation-v1.2", observationId: "quota:v12:typed-reader-1",
      observedTime: day + "T12:05:00.000Z", provider: "openai_codex", planType: "pro",
      planVariant: "unknown", limitId: "codex", slot: "primary", usedPercent: 20,
      windowDurationMinutes: 10_080, resetsAt: day + "T13:05:00.000Z",
      accountPlanAttribution: {accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "pro", planEraId: null},
    };
    const session: TelemetryV12Record = {
      schemaVersion: "session-dimension-v1.2", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      firstEventTime: day + "T12:05:00.000Z", provider: "openai_codex",
      toolClassCounts: {localShell: 3, web: 1},
    };
    await activate(fixture, await uploadDay(fixture, [quota, session]));
    for (const [stream, record, occurrenceId] of [["quota", quota, quota.observationId],
      ["session", session, session.sessionUuid]] as const) {
      const page = await readTelemetryV12EffectivePage(db(), {participantId: fixture.participantId,
        day, stream, limit: 10});
      expect(page.records).toHaveLength(1);
      expect(JSON.parse(page.records[0]!.sourceRecordJson)).toEqual(record);
      expect(JSON.parse(page.records[0]!.recordJson)).toEqual({...record,
        schemaVersion: record.schemaVersion.replace("v1.2", "v1.1")});
      const byOccurrence = await readTelemetryV12EffectiveOccurrences(db(), {
        participantId: fixture.participantId, stream, occurrenceIds: [occurrenceId]});
      expect(byOccurrence.records).toEqual(page.records);
      const effective = await readEffectiveTelemetryOwnerDayPage(db(), {
        sourceNamespace: "synthetic-v12-reader-source", ...owner, day, stream, limit: 10,
      });
      expect(effective.rows).toHaveLength(1);
      expect(effective.rows[0]).toMatchObject({status: "compatible", sourceCount: 1,
        sourceFormats: ["v12"], occurrenceId});
      expect(JSON.parse(effective.rows[0]!.recordJson!)).toEqual({...record,
        schemaVersion: record.schemaVersion.replace("v1.2", "v1.1")});
    }
  });

  it("does not resurrect a typed source after its owner erasure fence", async () => {
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const fixture = await createV11DeviceFixture(db());
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), nowEpoch);
    await prepareOwner(fixture.participantId);
    const eventId = "event:v2:" + "4".repeat(64);
    const uploaded = await uploadDay(fixture, [usageRecord(eventId, "erasure")]);
    await activate(fixture, uploaded);
    await db().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?")
      .bind(fixture.participantId).run();
    const page = await readTelemetryV12EffectivePage(db(), {
      participantId: fixture.participantId, day, stream: "usage", limit: 10,
    });
    expect(page.available).toBe(true);
    expect(page.records).toEqual([]);
    await expect(readTelemetryV12EffectiveDays(db(), {
      participantId: fixture.participantId, fromDay: day, throughDay: day, stream: "usage",
    })).resolves.toEqual([]);
  });

  it("continues past a duplicate physical prefix when paging effective usage", async () => {
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    await grantTelemetryV12Consent(db(), first, telemetryV12RequiredConsent(), nowEpoch);
    await grantTelemetryV12Consent(db(), second, telemetryV12RequiredConsent(), nowEpoch);
    const owner = await prepareOwner(first.participantId);

    const sharedA = "event:v2:" + "a".repeat(64);
    const sharedB = "event:v2:" + "b".repeat(64);
    const firstOnly = "event:v2:" + "c".repeat(64);
    const secondOnly = "event:v2:" + "d".repeat(64);
    const firstUpload = await uploadDay(first, [
      usageRecord(sharedA, "shared-a"), usageRecord(sharedB, "shared-b"), usageRecord(firstOnly, "first-only"),
    ]);
    const secondUpload = await uploadDay(second, [
      usageRecord(sharedA, "shared-a"), usageRecord(sharedB, "shared-b"), usageRecord(secondOnly, "second-only"),
    ]);
    await activate(first, firstUpload);
    await activate(second, secondUpload);

    const options = {
      sourceNamespace: "synthetic-v12-reader-source",
      ownerDigest: owner.ownerDigest,
      ownerRevision: owner.ownerRevision,
      authorityEpoch: owner.authorityEpoch,
      day,
      limit: 2,
    } as const;
    const firstPage = await readEffectiveUsageOwnerDayPage(db(), options);
    expect(firstPage.rows.map((row) => row.occurrenceId)).toEqual([sharedA, sharedB]);
    expect(firstPage.next).toEqual({
      observedAtMs: Date.parse(`${day}T12:05:00.000Z`), occurrenceId: sharedB,
    });

    const secondPage = await readEffectiveUsageOwnerDayPage(db(), {
      ...options, after: firstPage.next!,
    });
    expect(secondPage.rows.map((row) => row.occurrenceId)).toEqual([firstOnly, secondOnly]);
    expect(secondPage.next).toBeNull();
  });

  it("groups repeated same-day revisions while retaining a contradictory typed variant", async () => {
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(nowEpoch).toISOString()).run();
    const fixture = await createV11DeviceFixture(db());
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), nowEpoch);
    const owner = await prepareOwner(fixture.participantId);
    const eventIds = Array.from({length: 200}, (_, index) =>
      `event:v2:${index.toString(16).padStart(2, "0")}${"e".repeat(62)}`);
    const stable = eventIds.map((eventId) => usageRecord(eventId, "stable"));

    // Each activation has a distinct manifest/parser revision but repeats the
    // same canonical event bytes. The final revision changes boundary evidence
    // for one occurrence, which must remain a separate source variant.
    for (let revision = 1; revision <= 18; revision += 1) {
      const records = revision === 18
        ? stable.map((record, index) => index === 7 ? {...record, boundaryFlags: 1 as const} : record)
        : stable;
      await activate(fixture, await uploadDay(fixture, records, 200, revision));
    }

    const physical = await readTelemetryV12EffectivePage(db(), {
      participantId: fixture.participantId, day, stream: "usage", limit: 200,
    });
    expect(physical.records).toHaveLength(200);
    expect(physical.next).not.toBeNull();

    const expanded = await readTelemetryV12EffectiveOccurrences(db(), {
      participantId: fixture.participantId, stream: "usage", occurrenceIds: eventIds,
    });
    expect(expanded.available).toBe(true);
    expect(expanded.records).toHaveLength(201);
    expect(expanded.records.filter((row) => row.occurrenceId === eventIds[7]).map((row) => row.sourceRecordKey))
      .toHaveLength(2);
    expect(new Set(expanded.records.map((row) => row.sourceRecordKey)).size).toBe(201);
    expect(expanded.records.some((row) => row.sourceRecordJson.includes('"boundaryFlags":1'))).toBe(true);

    const effective = await readEffectiveUsageOwnerDayPage(db(), {
      sourceNamespace: "synthetic-v12-reader-source", ...owner, day, limit: 200,
    });
    expect(effective.rows).toHaveLength(200);
    expect(effective.rows.find((row) => row.occurrenceId === eventIds[7])).toMatchObject({
      sourceCount: 2, sourceFormats: ["v12"], status: "compatible",
    });
  }, 120_000);
});
