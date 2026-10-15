import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation, type TelemetryV11SessionDimension } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { currentTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { grantTelemetryV11Consent } from "../src/telemetry-transport-policy";
import { MAX_EFFECTIVE_USAGE_SOURCE_ROWS, readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays } from "../src/telemetry-usage-effective-reader";

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
const sourceNamespace = "synthetic-effective-usage-reader";
const day = "2026-09-20";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  // v1.2 transport 0008 and its successor migrations (0010 renewal, 0011
  // public eligibility, 0012 empty-day manifest rebuild, 0014 quarantine
  // admission, 0015 v1.2 retained-history transfer) all depend on 0008
  // tables. This reader is exercised against the frozen v1/v1.1 tables plus
  // 0006, so the whole v1.2 chain and 0013's performance upgrade stay out.
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS
    .filter((migration) => !/^(0008|0010|0011|0012|0013|0014|0015)_/u.test(migration.name)));
  await initializeStorageSource(db(), "synthetic-effective-usage-journal");
  await initializeTypedV1Admission(db(), sourceNamespace);
});

async function makeInsert(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  revision: number,
  eventIds: readonly string[],
  totals: boolean,
  supersedes: Awaited<ReturnType<typeof currentTelemetryV1Chunk>> = null,
  recordDay = day,
) {
  const records = eventIds.map((eventId, index) => {
    const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(recordDay, "a", {
      eventId,
      totalInputContextTokens: totals ? 150 : null,
      components: {
        inputUncachedTokens: 100, inputCacheReadTokens: null, inputCacheWriteTokens: null,
        outputTextTokens: 50, outputReasoningTokens: 25,
        outputCombinedTokens: totals ? 75 : null,
      },
      modelId: index === 0 ? "gpt-5.6-sol" : `synthetic-model-${index}`,
    }));
    if (!projected) throw new Error("synthetic effective projection missing");
    return JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
  });
  const envelopeDigest = await sha256Hex(`synthetic-effective-reader-envelope:${fixture.deviceId}:${recordDay}:${revision}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${recordDay}:0`, chunkRevision: revision,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-effective-reader-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records,
  });
  return {
    chunkRowId: `chunk:synthetic-effective-${revision}-${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId, chunk, envelopeDigest,
    r2Key: `synthetic/effective-reader-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes,
  };
}

async function ownerFor(participantId: string) {
  const owner = await db().prepare(`
    SELECT link.owner_digest,revision_row.revision,revision_row.authority_epoch
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions revision_row ON revision_row.owner_digest=link.owner_digest
     WHERE link.participant_id=? LIMIT 2
  `).bind(participantId).first<{ owner_digest: string; revision: number; authority_epoch: number }>();
  if (!owner) throw new Error("synthetic effective owner missing");
  return owner;
}

function countSemanticVariantQueries(database: D1Database): { database: D1Database; count: () => number } {
  let queries = 0;
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("WITH representatives AS MATERIALIZED")) queries += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, count: () => queries };
}

function captureCandidateStatement(database: D1Database): {
  database: D1Database;
  candidate: () => { sql: string; values: (string | number | null | ArrayBuffer)[] } | null;
} {
  let captured: { sql: string; values: (string | number | null | ArrayBuffer)[] } | null = null;
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("v1_scoped_records AS MATERIALIZED")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === "bind") {
                return (...values: (string | number | null | ArrayBuffer)[]) => {
                  captured = { sql, values };
                  return statementTarget.bind(...values);
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, candidate: () => captured };
}

interface CapturedSourceQuery {
  sql: string;
  values: (string | number | null | ArrayBuffer)[];
}

function captureDirectSourceStatement(database: D1Database): {
  database: D1Database;
  direct: () => CapturedSourceQuery | null;
} {
  let captured: CapturedSourceQuery | null = null;
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("WITH requested(occurrence_id) AS MATERIALIZED")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === "bind") {
                return (...values: (string | number | null | ArrayBuffer)[]) => {
                  captured = { sql, values };
                  return statementTarget.bind(...values);
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, direct: () => captured };
}

async function runCapturedSourceQuery(database: D1Database, query: CapturedSourceQuery) {
  return (await database.prepare(query.sql).bind(...query.values)
    .all<{ storage_row_id: number; source_namespace: string; participant_id: string; occurrence_id: string }>()).results;
}

function readerQuota(day: string): TelemetryV11QuotaObservation {
  return { schemaVersion: "quota-observation-v1.1", observationId: `quota-occurrence:v1:${"b".repeat(64)}`,
    observedTime: `${day}T12:05:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
    limitId: "codex", slot: "seven_day", usedPercent: 12.5, windowDurationMinutes: 10080,
    resetsAt: `${day}T23:00:00.000Z`, accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null } };
}

function readerSession(day: string): TelemetryV11SessionDimension {
  return { schemaVersion: "session-dimension-v1.1", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    firstEventTime: `${day}T12:05:00.000Z`, provider: "openai_codex", toolClassCounts: { browser: 1, shell: 2 } };
}

async function stageReaderV11Day(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  prepared: Awaited<ReturnType<typeof makeV11Day>>) {
  await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-effective-reader-v11:${chunk.chunkDigest}:${crypto.randomUUID()}`);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: 1000, contentType: "application/json",
    });
    await persistTypedV11StagedChunk(db(), principal, chunk, {
      sourceNamespace, chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/effective-reader-v11-${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
}

async function activateReaderV11Days(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  preparedDays: readonly Awaited<ReturnType<typeof makeV11Day>>[], nowEpoch?: number) {
  const stagedDays: Array<Awaited<ReturnType<typeof stageReaderV11Day>>> = [];
  for (const prepared of preparedDays) stagedDays.push(await stageReaderV11Day(fixture, prepared));
  const predecessor = await createTelemetryV11DomainPredecessor(db(), fixture, nowEpoch);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: stagedDays[0]!.day, throughDay: stagedDays.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: stagedDays.map((staged) => ({ day: staged.day, manifestId: staged.manifestId,
      manifestDigest: staged.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db(), fixture, manifest, nowEpoch);
}

describe("effective mixed v1 usage reader", () => {
  it("folds current known totals with archived null totals and retains a late unique occurrence", async () => {
    const fixture = await createV11DeviceFixture(db());
    const knownEventId = `event:v2:${"e".repeat(64)}`;
    const uniqueEventId = `event:v2:${"f".repeat(64)}`;
    const first = await makeInsert(fixture, 1, [knownEventId], false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const prior = await currentTelemetryV1Chunk(db(), fixture.participantId, fixture.deviceId, "usage", day, 0);
    if (!prior) throw new Error("synthetic effective predecessor missing");
    const replacement = await makeInsert(fixture, 2, [knownEventId, uniqueEventId], true, prior);
    await expect(insertTypedTelemetryV1Chunk(db(), replacement, sourceNamespace)).resolves.toMatchObject({
      acceptedRecords: 2, replay: false,
    });
    const owner = await ownerFor(fixture.participantId);
    const page = await readEffectiveUsageOwnerDayPage(db(), {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day, limit: 200,
    });
    expect(page.next).toBeNull();
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((row) => row.occurrenceId)).toEqual([knownEventId, uniqueEventId]);
    const known = page.rows.find((row) => row.occurrenceId === knownEventId);
    const unique = page.rows.find((row) => row.occurrenceId === uniqueEventId);
    expect(known).toMatchObject({ status: "compatible", sourceCount: 2, sourceFormats: ["v1"] });
    expect(known?.correctionHistoryIds).toHaveLength(1);
    expect(JSON.parse(known?.recordJson ?? "null")).toMatchObject({
      totalInputContextTokens: 150,
      components: { outputCombinedTokens: 75 },
    });
    expect(unique).toMatchObject({ status: "compatible", sourceCount: 1, sourceFormats: ["v1"] });
    expect(unique?.correctionHistoryIds).toEqual([]);
    const analytical = await readEffectiveTelemetryOwnerDayPage(db(), {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day, stream: "usage", limit: 200,
    });
    expect(JSON.parse(analytical.rows[0]!.recordJson!)).toMatchObject({
      schemaVersion: "usage-event-v1.1", totalInputContextTokens: 150,
      accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
        planBasis: "unavailable", planType: "unknown", planEraId: null },
    });
  });

  it("uses an occurrence cursor and never splits a page group", async () => {
    const fixture = await createV11DeviceFixture(db());
    const eventIds = ["a", "b", "c"].map((suffix) => `event:v2:${suffix.repeat(64)}`);
    const first = await makeInsert(fixture, 1, eventIds, true);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const owner = await ownerFor(fixture.participantId);
    const firstPage = await readEffectiveUsageOwnerDayPage(db(), {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day, limit: 2,
    });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.next).toEqual({
      observedAtMs: Date.parse(`${day}T12:05:00.000Z`), occurrenceId: eventIds[1],
    });
    const secondPage = await readEffectiveUsageOwnerDayPage(db(), {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day, after: firstPage.next!, limit: 2,
    });
    expect(secondPage.rows.map((row) => row.occurrenceId)).toEqual([eventIds[2]]);
    expect(secondPage.next).toBeNull();
  });

  it("uses the indexed stored-day fence and still expands a cross-day occurrence conflict", async () => {
    const nextDay = "2026-09-21";
    const shared = `event:v2:${"a".repeat(64)}`;
    const dayOneOnly = `event:v2:${"b".repeat(64)}`;
    const dayTwoOnly = `event:v2:${"c".repeat(64)}`;
    const firstDevice = await createV11DeviceFixture(db());
    const first = await makeInsert(firstDevice, 1, [shared, dayOneOnly], true);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    const secondDevice = await createV11DeviceFixture(db(), { participantId: firstDevice.participantId });
    const second = await makeInsert(secondDevice, 1, [shared, dayTwoOnly], true, null, nextDay);
    await insertTypedTelemetryV1Chunk(db(), second, sourceNamespace);

    const firstSource = await db().prepare(`SELECT storage_row_id FROM typed_telemetry_compatibility_records
      WHERE participant_id=? AND device_id=? AND format_code=10 AND occurrence_id=? LIMIT 2`)
      .bind(firstDevice.participantId, firstDevice.deviceId, shared).first<{ storage_row_id: number }>();
    if (!firstSource) throw new Error("synthetic cross-day typed source missing");
    const immutableTrigger = await db().prepare(`SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name='typed_telemetry_record_immutable'`).first<{ sql: string }>();
    if (!immutableTrigger) throw new Error("typed evidence immutability trigger missing");
    await db().prepare("DROP TRIGGER typed_telemetry_record_immutable").run();
    try {
      await db().prepare("UPDATE typed_telemetry_records SET observed_day=? WHERE id=?")
        .bind(Date.parse(`${nextDay}T00:00:00.000Z`) / 86_400_000, firstSource.storage_row_id).run();
    } finally {
      await db().prepare(immutableTrigger.sql).run();
    }

    const owner = await ownerFor(firstDevice.participantId);
    const captured = captureCandidateStatement(db());
    const page = await readEffectiveUsageOwnerDayPage(captured.database, {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day: nextDay, limit: 200,
    });
    expect(page.rows.map((row) => row.occurrenceId)).toEqual([shared, dayTwoOnly]);
    expect(page.rows[0]).toMatchObject({ status: "base_conflict", eventTime: null,
      eventTimeConflict: true, sourceCount: 2 });
    expect(page.rows[1]).toMatchObject({ status: "compatible", eventTimeConflict: false, sourceCount: 1 });

    const query = captured.candidate();
    if (!query) throw new Error("indexed physical candidate query was not captured");
    const plan = (await db().prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values)
      .all<{ detail: string }>()).results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH physical_record USING (?:COVERING )?INDEX typed_telemetry_day \([^)]*observed_day>\?[^)]*observed_day<\?/u);

    expect(await readEffectiveTelemetryOwnerDays(db(), {
      sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, stream: "usage", fromDay: day, throughDay: nextDay,
    })).toEqual([day, nextDay]);
  });

  it("factors direct v11 completeness per chunk and preserves source variants and generic binds", async () => {
    // Pin the captured clock and contiguous two-day fixture to prior-day and UTC-today bounds.
    const regressionNowEpoch = Date.now();
    const regressionDay = new Date(regressionNowEpoch).toISOString().slice(0, 10);
    const priorDay = new Date(regressionNowEpoch - 86_400_000).toISOString().slice(0, 10);
    await initializeTypedV11Admission(db(), sourceNamespace);
    const firstFixture = await createV11DeviceFixture(db(), { nowEpoch: regressionNowEpoch });
    const secondFixture = await createV11DeviceFixture(db(), {
      participantId: firstFixture.participantId, nowEpoch: regressionNowEpoch,
    });
    // Same-time legacy election breaks ties by device ID; keep the queried cross-day row on the nonwinner.
    const fixture = firstFixture.deviceId > secondFixture.deviceId ? firstFixture : secondFixture;
    const nonwinningFixture = fixture === firstFixture ? secondFixture : firstFixture;
    const baseRecords = Array.from({ length: 63 }, (_, index) => {
      const eventId = `event:v2:${(index + 1).toString(16).padStart(64, "0")}`;
      return v11UsageRecord(regressionDay, "a", { eventId });
    });
    const sharedId = baseRecords[0]!.eventId;
    const winnerLegacyId = `event:v2:${"d".repeat(64)}`;
    const addedId = `event:v2:${"f".repeat(64)}`;
    const crossDayInsert = await makeInsert(nonwinningFixture, 1, [sharedId], true, null, priorDay);
    const winnerInsert = await makeInsert(fixture, 1, [winnerLegacyId], true, null, priorDay);
    const commonV1CreatedAt = new Date().toISOString();
    crossDayInsert.createdAt = commonV1CreatedAt;
    winnerInsert.createdAt = commonV1CreatedAt;
    await insertTypedTelemetryV1Chunk(db(), crossDayInsert, sourceNamespace);
    await insertTypedTelemetryV1Chunk(db(), winnerInsert, sourceNamespace);
    await db().prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'").run();
    await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent(), regressionNowEpoch);

    const winnerLegacyRecord = v11UsageRecord(priorDay, "d", { eventId: winnerLegacyId,
      totalInputContextTokens: 150, components: { inputUncachedTokens: 100, inputCacheReadTokens: null,
        inputCacheWriteTokens: null, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75 },
      modelId: "gpt-5.6-sol" });
    const quota = readerQuota(regressionDay);
    const session = readerSession(regressionDay);
    await activateReaderV11Days(fixture, [
      await makeV11Day(priorDay, { usage: [winnerLegacyRecord] }, "synthetic-effective-reader-v11-witness-r1"),
      await makeV11Day(regressionDay,
        { usage: baseRecords, quota: [quota], session: [session] }, "synthetic-effective-reader-v11-r1"),
    ], regressionNowEpoch);
    await activateReaderV11Days(fixture, [
      await makeV11Day(priorDay, { usage: [winnerLegacyRecord] }, "synthetic-effective-reader-v11-witness-r2"),
      await makeV11Day(regressionDay,
        { usage: [...baseRecords, v11UsageRecord(regressionDay, "f", { eventId: addedId })],
          quota: [quota], session: [session] }, "synthetic-effective-reader-v11-r2"),
    ], regressionNowEpoch);
    const owner = await ownerFor(fixture.participantId);
    const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day: regressionDay, limit: 200 };
    const captured = captureDirectSourceStatement(db());
    const page = await readEffectiveUsageOwnerDayPage(captured.database, options);
    const expectedIds = [...baseRecords.map(record => record.eventId), addedId].sort();
    expect(page.rows.map(row => row.occurrenceId)).toEqual(expectedIds);
    expect(page.next).toBeNull();
    expect(page.rows.find(row => row.occurrenceId === sharedId)).toMatchObject({
      status: "base_conflict", eventTime: null, eventTimeConflict: true, sourceCount: 2, sourceFormats: ["v1", "v11"],
    });
    expect(page.rows.find(row => row.occurrenceId === addedId)).toMatchObject({
      status: "compatible", sourceCount: 1, sourceFormats: ["v11"],
    });

    const direct = captured.direct();
    if (!direct) throw new Error("direct source query was not captured");
    expect(direct.values).toEqual([JSON.stringify(expectedIds), sourceNamespace, owner.owner_digest, fixture.participantId,
      owner.owner_digest, fixture.participantId, sourceNamespace, fixture.participantId, MAX_EFFECTIVE_USAGE_SOURCE_ROWS + 1]);
    expect(direct.sql).toContain("v11_direct AS MATERIALIZED");
    expect(direct.sql).toContain("v11_candidate_chunks AS MATERIALIZED (\n    SELECT DISTINCT candidate.chunk_id\n      FROM v11_direct candidate");
    const distinctChunkOffset = direct.sql.indexOf("v11_candidate_chunks AS MATERIALIZED");
    const proofCountOffset = direct.sql.indexOf("WHERE allocation.chunk_id=chunk.id");
    expect(distinctChunkOffset).toBeGreaterThan(-1);
    expect(proofCountOffset).toBeGreaterThan(distinctChunkOffset);
    expect(direct.sql).toContain("complete_v11_chunks AS MATERIALIZED");
    expect(direct.sql.match(/WHERE allocation.chunk_id=chunk.id/gu)).toHaveLength(1);
    const completeRows = await runCapturedSourceQuery(db(), direct);
    expect(completeRows).toHaveLength(expectedIds.length + 1);
    expect(completeRows.filter(row => row.occurrence_id === sharedId)).toHaveLength(2);
    expect(completeRows.filter(row => row.occurrence_id === baseRecords[1]!.eventId)).toHaveLength(1);
    expect(completeRows.filter(row => row.occurrence_id === addedId)).toHaveLength(1);
    const legacySource = await db().prepare(`SELECT storage_row_id FROM typed_telemetry_compatibility_records
      WHERE participant_id=? AND format_code=10 AND occurrence_id=?`).bind(fixture.participantId, sharedId)
      .first<{ storage_row_id: number }>();
    if (!legacySource) throw new Error("synthetic cross-day v1 source missing");
    expect(completeRows.some(row => row.storage_row_id === legacySource.storage_row_id)).toBe(true);
    const sharedMetadata = await db().prepare(`SELECT format_code,observed_day FROM typed_telemetry_compatibility_records
      WHERE storage_row_id IN (?,?) ORDER BY format_code`).bind(...completeRows
        .filter(row => row.occurrence_id === sharedId).map(row => row.storage_row_id))
      .all<{ format_code: number; observed_day: string }>();
    expect(sharedMetadata.results.map(row => row.format_code)).toEqual([10, 11]);
    expect(sharedMetadata.results.find(row => row.format_code === 10)?.observed_day).toBe(priorDay);
    const duplicatePhysicalRows = await db().prepare(`SELECT count(*) AS total FROM typed_telemetry_compatibility_records
      WHERE participant_id=? AND format_code=11 AND occurrence_id=?`).bind(fixture.participantId, baseRecords[1]!.eventId)
      .first<{ total: number }>();
    expect(duplicatePhysicalRows?.total).toBe(2);

    for (const [positions, replacement] of [
      [[1, 6], "synthetic-foreign-source-namespace"],
      [[2, 4], owner.owner_digest === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64)],
      [[3, 5, 7], "participant:synthetic-foreign-owner"],
    ] as const) {
      const wrong = [...direct.values];
      for (const index of positions) wrong[index] = replacement;
      expect((await db().prepare(direct.sql).bind(...wrong)
        .all<{ storage_row_id: number }>()).results).toHaveLength(0);
    }

    const activeEvent = await db().prepare(`SELECT event.event_digest,event.manifest_digest,event.input_revision
      FROM storage_v11_event_sources event JOIN telemetry_v11_domain_heads head
        ON head.generation_id=event.generation_id
      WHERE event.owner_digest=? AND head.participant_id=? LIMIT 1`)
      .bind(owner.owner_digest, fixture.participantId)
      .first<{ event_digest: string; manifest_digest: string; input_revision: number }>();
    const eventGuard = await db().prepare(`SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name='storage_v11_event_immutable'`).first<{ sql: string }>();
    if (!activeEvent || !eventGuard) throw new Error("synthetic active generation evidence missing");
    // Keep this corruption confined to the synthetic D1 fixture and restore the exact trigger and row below.
    await db().prepare("DROP TRIGGER storage_v11_event_immutable").run();
    try {
      const wrongDigest = activeEvent.manifest_digest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      await db().prepare("UPDATE storage_v11_event_sources SET manifest_digest=? WHERE event_digest=?")
        .bind(wrongDigest, activeEvent.event_digest).run();
      let mismatched = await runCapturedSourceQuery(db(), direct);
      expect(mismatched.some(row => row.occurrence_id === addedId)).toBe(false);
      expect(mismatched.some(row => row.occurrence_id === baseRecords[1]!.eventId)).toBe(true);
      await db().prepare("UPDATE storage_v11_event_sources SET manifest_digest=? WHERE event_digest=?")
        .bind(activeEvent.manifest_digest, activeEvent.event_digest).run();
      await db().prepare("UPDATE storage_v11_event_sources SET input_revision=? WHERE event_digest=?")
        .bind(activeEvent.input_revision + 1, activeEvent.event_digest).run();
      mismatched = await runCapturedSourceQuery(db(), direct);
      expect(mismatched.some(row => row.occurrence_id === addedId)).toBe(false);
      expect(mismatched.some(row => row.occurrence_id === baseRecords[1]!.eventId)).toBe(true);
    } finally {
      await db().prepare(`UPDATE storage_v11_event_sources SET manifest_digest=?,input_revision=? WHERE event_digest=?`)
        .bind(activeEvent.manifest_digest, activeEvent.input_revision, activeEvent.event_digest).run();
      await db().prepare(eventGuard.sql).run();
    }

    for (const stream of ["quota", "session"] as const) {
      const genericCapture = captureDirectSourceStatement(db());
      const genericPage = await readEffectiveTelemetryOwnerDayPage(genericCapture.database, { ...options, stream });
      const genericQuery = genericCapture.direct();
      if (!genericQuery) throw new Error(`${stream} direct source query was not captured`);
      const occurrenceId = stream === "quota" ? quota.observationId : session.sessionUuid;
      expect(genericPage.rows.map(row => row.occurrenceId)).toEqual([occurrenceId]);
      expect(genericQuery.values).toEqual([JSON.stringify([occurrenceId]), sourceNamespace, stream, owner.owner_digest,
        fixture.participantId, stream, stream, owner.owner_digest, fixture.participantId, sourceNamespace,
        fixture.participantId, stream, MAX_EFFECTIVE_USAGE_SOURCE_ROWS + 1]);
      expect((await runCapturedSourceQuery(db(), genericQuery)).map(row => row.occurrence_id)).toEqual([occurrenceId]);
    }

    const currentDomain = await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id=?")
      .bind(fixture.participantId).first<{ generation_id: string }>();
    if (!currentDomain) throw new Error("synthetic current domain missing");
    const chunks = await db().prepare(`SELECT chunk.id,domain.id AS generation_id
      FROM telemetry_v11_chunks chunk JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=chunk.manifest_id
      JOIN telemetry_v11_domains domain ON domain.id=domain_day.generation_id
      WHERE domain.participant_id=? AND chunk.stream='usage' AND chunk.chunk_day=?`)
      .bind(fixture.participantId, regressionDay).all<{ id: string; generation_id: string }>();
    expect(chunks.results).toHaveLength(2);
    const oldChunk = chunks.results.find(row => row.generation_id !== currentDomain.generation_id);
    const currentChunk = chunks.results.find(row => row.generation_id === currentDomain.generation_id);
    if (!oldChunk || !currentChunk) throw new Error("synthetic source revision chunks missing");
    const typedChunks = await db().prepare(`SELECT allocation.chunk_id,physical.id AS typed_chunk_id
      FROM typed_v11_chunk_allocations allocation JOIN typed_telemetry_chunks physical
        ON physical.namespace_id=allocation.namespace_id AND physical.original_id=allocation.chunk_original
      WHERE allocation.chunk_id IN (?,?)`).bind(oldChunk.id, currentChunk.id)
      .all<{ chunk_id: string; typed_chunk_id: number }>();
    expect(typedChunks.results).toHaveLength(2);
    const deleteGuards = await db().prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND name IN ('typed_v11_active_proof_delete_guard','typed_v11_retained_proof_delete_guard')`)
      .all<{ name: string; sql: string }>();
    expect(deleteGuards.results.map(row => row.name).sort()).toEqual([
      "typed_v11_active_proof_delete_guard", "typed_v11_retained_proof_delete_guard",
    ]);
    // Remove retained-proof guards only to construct malformed synthetic proof states; restore both exact trigger bodies below.
    await db().prepare("DROP TRIGGER typed_v11_active_proof_delete_guard").run();
    await db().prepare("DROP TRIGGER typed_v11_retained_proof_delete_guard").run();
    try {
      const partialProof = await db().prepare(`SELECT proof.typed_record_id FROM typed_v11_record_proofs proof
        JOIN typed_telemetry_compatibility_records record ON record.storage_row_id=proof.typed_record_id
        WHERE record.chunk_row_id=? AND record.occurrence_id=? AND record.format_code=11`)
        .bind(currentChunk.id, addedId).first<{ typed_record_id: number }>();
      if (!partialProof) throw new Error("synthetic proof for current-generation-only source missing");
      await db().prepare("DELETE FROM typed_v11_record_proofs WHERE typed_record_id=?")
        .bind(partialProof.typed_record_id).run();
      const partialRows = await runCapturedSourceQuery(db(), direct);
      expect(partialRows.some(row => row.occurrence_id === addedId)).toBe(false);
      expect(partialRows.filter(row => row.occurrence_id === baseRecords[1]!.eventId)).toHaveLength(1);

      const oldTypedChunk = typedChunks.results.find(row => row.chunk_id === oldChunk.id)!.typed_chunk_id;
      await db().prepare("DELETE FROM typed_v11_record_proofs WHERE chunk_key=?").bind(oldTypedChunk).run();
      const absentRows = await runCapturedSourceQuery(db(), direct);
      expect(absentRows.map(row => row.occurrence_id)).toEqual([sharedId]);
      expect(absentRows.some(row => row.storage_row_id === legacySource.storage_row_id)).toBe(true);
    } finally {
      for (const guard of deleteGuards.results) await db().prepare(guard.sql).run();
    }
  });

  it("preserves pre-compact v11 reader refusal", async () => {
    await reset();
    await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
    await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
    await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS
      .filter((migration) => !/^0006_compact_admission_proofs\.sql$/u.test(migration.name)));
    await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS
      .filter((migration) => !/^(0008|0010|0011|0012|0013|0014|0015)_/u.test(migration.name)));
    await initializeStorageSource(db(), "synthetic-effective-usage-reader-legacy-layout");
    await initializeTypedV1Admission(db(), sourceNamespace);

    const fixture = await createV11DeviceFixture(db());
    await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1,
      [`event:v2:${"d".repeat(64)}`], true), sourceNamespace);
    const owner = await ownerFor(fixture.participantId);
    const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day, limit: 200 };
    // The baseline reader already statically joins compact manifest membership,
    // so this schema has always been unavailable; the proof-count optimization
    // must not introduce a legacy fallback or a new pre-compact contract.
    await expect(readEffectiveUsageOwnerDayPage(db(), options))
      .rejects.toMatchObject({ code: "EFFECTIVE_USAGE_UNAVAILABLE" });
  });
});

it('pages a dense correction archive without materializing the whole day',async()=>{
 const fixture=await createV11DeviceFixture(db());
 await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 for(let revision=1;revision<=18;revision++){
   const ids=Array.from({length:200},(_,index)=>`synthetic:archive:${String((revision-1)*200+index).padStart(5,'0')}`);
   const prior=await currentTelemetryV1Chunk(db(),fixture.participantId,fixture.deviceId,'usage',day,0);
   await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,revision,ids,true,prior),sourceNamespace);
 }
 expect(await db().prepare('SELECT count(*) n FROM telemetry_usage_correction_facts').first<number>('n')).toBe(3400);
 const owner=await ownerFor(fixture.participantId);
 const options={sourceNamespace,ownerDigest:owner.owner_digest,ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,day,limit:5};
 const first=await readEffectiveUsageOwnerDayPage(db(),options);
 expect(first.rows.map(row=>row.occurrenceId)).toEqual(Array.from({length:5},(_,index)=>`synthetic:archive:${String(index).padStart(5,'0')}`));
 expect(first.rows.every(row=>row.sourceCount===1&&row.correctionHistoryIds.length===1)).toBe(true);
 expect(first.next).not.toBeNull();
 const next=await readEffectiveUsageOwnerDayPage(db(),{...options,after:first.next!});
 expect(next.rows.map(row=>row.occurrenceId)).toEqual(Array.from({length:5},(_,index)=>`synthetic:archive:${String(index+5).padStart(5,'0')}`));
},90000);

it('groups repeated legacy revisions before the bounded source expansion',async()=>{
 const fixture=await createV11DeviceFixture(db());
 await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const ids=Array.from({length:200},(_,index)=>`event:v2:${index.toString(16).padStart(2,'0')}${'d'.repeat(62)}`);
 for(let revision=1;revision<=18;revision++){
   const prior=await currentTelemetryV1Chunk(db(),fixture.participantId,fixture.deviceId,'usage',day,0);
   await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,revision,ids,true,prior),sourceNamespace);
 }
 expect(await db().prepare('SELECT count(*) n FROM telemetry_usage_correction_facts').first<number>('n')).toBe(3400);
 const owner=await ownerFor(fixture.participantId);
 const counted=countSemanticVariantQueries(db());
 const page=await readEffectiveUsageOwnerDayPage(counted.database,{
   sourceNamespace,ownerDigest:owner.owner_digest,ownerRevision:owner.revision,
   authorityEpoch:owner.authority_epoch,day,limit:200,
 });
 expect(page.rows).toHaveLength(200);
 expect(page.next).toBeNull();
 expect(page.rows.every(row=>row.sourceCount===2&&row.correctionHistoryIds.length===1)).toBe(true);
 expect(counted.count()).toBe(1);
},90000);
