import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { currentTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage } from "../src/telemetry-usage-effective-reader";

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
  // v1.2 transport migration is being qualified separately; this reader is
  // intentionally exercised against the frozen v1/v1.1 tables plus 0006. The
  // successor's own follow-up migrations depend on 0008 and stay out too.
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS
    .filter((migration) => !/^(0008|0010|0011|0012)_/u.test(migration.name)));
  await initializeStorageSource(db(), "synthetic-effective-usage-journal");
  await initializeTypedV1Admission(db(), sourceNamespace);
});

async function makeInsert(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  revision: number,
  eventIds: readonly string[],
  totals: boolean,
  supersedes: Awaited<ReturnType<typeof currentTelemetryV1Chunk>> = null,
) {
  const records = eventIds.map((eventId, index) => {
    const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
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
  const envelopeDigest = await sha256Hex(`synthetic-effective-reader-envelope:${revision}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:0`, chunkRevision: revision,
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
