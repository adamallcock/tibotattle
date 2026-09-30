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
import { decodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage,
  readEffectiveTelemetryOwnerDays } from "../src/telemetry-usage-effective-reader";

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
  observedDay = day,
) {
  const records = eventIds.map((eventId, index) => {
    const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(observedDay, "a", {
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
  const envelopeDigest = await sha256Hex(`synthetic-effective-reader-envelope:${observedDay}:${revision}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${observedDay}:0`, chunkRevision: revision,
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

function recordDirectQueries(database: D1Database) {
  const queries: { sql: string; values: unknown[] }[] = [];
  return { queries, database: new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (!sql.includes("direct AS (")) return target.prepare(sql);
      const query = { sql, values: [] as unknown[] };
      queries.push(query);
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(inner, member) {
          if (member === "bind") return (...values: unknown[]) => {
            query.values = values;
            return wrap(inner.bind(...values));
          };
          const value = Reflect.get(inner, member);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
      return wrap(target.prepare(sql));
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

it("bounds candidate decoding to the indexed owner stream and UTC window without losing cross-day conflicts", async () => {
  const fixture = await createV11DeviceFixture(db());
  const otherDevice = await createV11DeviceFixture(db(), { participantId: fixture.participantId });
  const occurrence = `event:v2:${"c".repeat(64)}`;
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, [occurrence], true), sourceNamespace);
  const outsideDay = "2026-09-21";
  const outside = [occurrence, ...Array.from({ length: 199 }, (_, index) =>
    `synthetic:outside:${String(index).padStart(4, "0")}`)];
  await insertTypedTelemetryV1Chunk(db(),
    await makeInsert(otherDevice, 1, outside, true, null, outsideDay), sourceNamespace);
  const owner = await ownerFor(fixture.participantId);
  const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch };
  const observed = recordDirectQueries(db());
  const page = await readEffectiveUsageOwnerDayPage(observed.database, { ...options, day, limit: 1 });
  expect(page.next).toBeNull();
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({ occurrenceId: occurrence, eventTimeConflict: true, status: "base_conflict" });
  expect(page.rows[0]!.sourceCount).toBe(2);

  for (const stream of ["usage", "quota", "session"] as const) {
    if (stream !== "usage") {
      const empty = await readEffectiveTelemetryOwnerDayPage(observed.database,
        { ...options, stream, day, limit: 1 });
      expect(empty.rows).toEqual([]);
      expect(empty.next).toBeNull();
    }
    expect(await readEffectiveTelemetryOwnerDays(observed.database,
      { ...options, stream, fromDay: day, throughDay: outsideDay }))
      .toEqual(stream === "usage" ? [day, outsideDay] : []);
  }

  const candidates = observed.queries.filter(query => query.sql.includes("selected_window("));
  expect(candidates).toHaveLength(6);
  for (const query of candidates) {
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all<{ detail: string }>();
    const physical = plan.results.filter(row => row.detail.includes("scoped_record"));
    expect(physical).toHaveLength(2);
    for (const row of physical) expect(row.detail).toMatch(
      /SEARCH scoped_record USING (?:COVERING )?INDEX typed_telemetry_owner_time \(owner_id=\? AND stream=\? AND observed_at_ms>\? AND observed_at_ms<\?\)/u);
  }
  const query = candidates[0]!;
  const priorSql = query.sql.replaceAll("        AND scoped_record.stream=window.stream_code\n", "")
    .replaceAll("        AND scoped_record.observed_at_ms>=window.from_ms AND scoped_record.observed_at_ms<window.through_ms\n", "");
  const current = await db().prepare(query.sql).bind(...query.values).all();
  const prior = await db().prepare(priorSql).bind(...query.values).all();
  expect(current.results).toEqual(prior.results);
  // Identical synthetic evidence, query, and complete-chunk checks. Only the
  // physical index predicates differ; unrelated same-owner days stay undecoded.
  // Owner-wide completeness still costs one proof read per admitted record.
  // The added range removes the extra physical/compatibility reads, not that
  // invariant check; this fixture measures 225 versus 626 reads.
  expect(current.meta.rows_read).toBeLessThan(prior.meta.rows_read / 2);
  console.info("effective-reader-window-rows", { current: current.meta.rows_read, prior: prior.meta.rows_read });

  const sources = observed.queries.filter(value => value.sql.includes("selected_stream("));
  expect(sources).toHaveLength(1);
  const sourcePlan = await db().prepare(`EXPLAIN QUERY PLAN ${sources[0]!.sql}`)
    .bind(...sources[0]!.values).all<{ detail: string }>();
  const sourcePhysical = sourcePlan.results.filter(row => row.detail.includes("scoped_record"));
  expect(sourcePhysical).toHaveLength(2);
  expect(sourcePhysical.find(row => row.detail.includes("typed_telemetry_v1_occurrence"))?.detail)
    .toContain("device_id=? AND stream=? AND occurrence_id=?");
  expect(sourcePhysical.find(row => row.detail.includes("typed_telemetry_v11_occurrence"))?.detail)
    .toContain("manifest_id=? AND stream=? AND occurrence_id=?");
  expect(sourcePlan.results.find(row => row.detail.includes("scoped_device"))?.detail)
    .toContain("USING COVERING INDEX typed_telemetry_device_owner (owner_id=?)");
  expect(sourcePlan.results.find(row => row.detail.includes("scoped_manifest"))?.detail)
    .toContain("USING COVERING INDEX typed_telemetry_manifest_owner (owner_id=?)");
  expect(sources[0]!.values[1]).toBeInstanceOf(ArrayBuffer);
  expect(sources[0]!.sql).not.toContain("json_each(?)");
  const sourceResult = await db().prepare(sources[0]!.sql).bind(...sources[0]!.values).all();
  expect(sourceResult.results).toHaveLength(2);
  const priorSourceSql = sources[0]!.sql
    .replace(/      CROSS JOIN typed_telemetry_devices scoped_device INDEXED BY typed_telemetry_device_owner\n       ON scoped_device.owner_id=owner_membership.typed_owner_id\n/u, "")
    .replace(/      CROSS JOIN typed_telemetry_manifests scoped_manifest INDEXED BY typed_telemetry_manifest_owner\n       ON scoped_manifest.owner_id=owner_membership.typed_owner_id\n/u, "")
    .replace("ON scoped_record.device_id=scoped_device.id\n        AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replace("ON scoped_record.manifest_id=scoped_manifest.id\n        AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replaceAll("INDEXED BY typed_telemetry_v1_occurrence", "INDEXED BY typed_telemetry_owner_time")
    .replaceAll("INDEXED BY typed_telemetry_v11_occurrence", "INDEXED BY typed_telemetry_owner_time");
  expect(priorSourceSql).not.toContain("scoped_device");
  expect(priorSourceSql).not.toContain("scoped_manifest");
  const priorSource = await db().prepare(priorSourceSql).bind(...sources[0]!.values).all();
  expect(sourceResult.results).toEqual(priorSource.results);
  // Both plans pay for the same immutable completeness proof. The difference
  // isolates the owner's 200 unrelated retained rows from source expansion.
  expect(sourceResult.meta.rows_read).toBeLessThan(priorSource.meta.rows_read * 0.6);
  console.info("effective-reader-source-rows", {
    current: sourceResult.meta.rows_read, prior: priorSource.meta.rows_read,
  });
}, 30_000);

it("batches the maximum selected page as canonical BLOB seeks and keeps cross-day variants in both readers", async () => {
  const fixture = await createV11DeviceFixture(db());
  const otherDevice = await createV11DeviceFixture(db(), { participantId: fixture.participantId });
  const occurrences = Array.from({ length: 200 }, (_, index) =>
    `event:v2:${(index + 1).toString(16).padStart(64, "0")}`);
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, occurrences, true), sourceNamespace);
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(otherDevice, 1,
    [occurrences[199]!], true, null, "2026-09-21"), sourceNamespace);
  const owner = await ownerFor(fixture.participantId);
  const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch, day, limit: 200 };
  const observed = recordDirectQueries(db());
  const usage = await readEffectiveUsageOwnerDayPage(observed.database, options);
  expect(usage.next).toBeNull();
  expect(usage.rows.map(row => row.occurrenceId)).toEqual(occurrences);
  expect(usage.rows[199]).toMatchObject({ eventTimeConflict: true, status: "base_conflict", sourceCount: 2 });
  const generic = await readEffectiveTelemetryOwnerDayPage(observed.database,
    { ...options, stream: "usage" });
  expect(generic.next).toBeNull();
  expect(generic.rows.map(row => row.occurrenceId)).toEqual(occurrences);
  expect(generic.rows[199]).toMatchObject({ eventTimeConflict: true, status: "conflict" });
  const sourceQueries = observed.queries.filter(query => query.sql.includes("selected_stream("));
  expect(sourceQueries).toHaveLength(6);
  for (const query of sourceQueries) {
    expect(query.values.length).toBeLessThan(100);
    expect(query.values[1]).toBeInstanceOf(ArrayBuffer);
    expect(query.sql).toContain("requested(occurrence_id) AS MATERIALIZED (VALUES");
  }
  // Three individually bounded batches can still exceed the whole-page
  // source-variant cap. Inflate only this synthetic source result and require
  // the public reader to refuse before decoding a partial page.
  let sourceBatches = 0;
  const inflated = new Proxy(db(), { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (!sql.includes("requested(occurrence_id) AS MATERIALIZED")) return target.prepare(sql);
      return { bind: (...values: unknown[]) => ({ all: async () => {
        sourceBatches += 1;
        const occurrenceId = decodeTypedTelemetryId(new Uint8Array(values[1] as ArrayBuffer));
        const count = sourceBatches < 3 ? 1_600 : 1;
        return { results: Array.from({ length: count }, (_, index) => ({
          storage_row_id: index + 1, source_namespace: sourceNamespace,
          participant_id: fixture.participantId, occurrence_id: occurrenceId,
        })) };
      } }) } as unknown as D1PreparedStatement;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(readEffectiveUsageOwnerDayPage(inflated, options))
    .rejects.toMatchObject({ code: "EFFECTIVE_USAGE_LIMIT" });
  expect(sourceBatches).toBe(3);
}, 30_000);

it("fails closed when either additive owner metadata index is absent", async () => {
  const fixture = await createV11DeviceFixture(db());
  const occurrence = `event:v2:${"1".repeat(64)}`;
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, [occurrence], true), sourceNamespace);
  const owner = await ownerFor(fixture.participantId);
  const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch, day, limit: 1 };
  for (const [index, table] of [
    ["typed_telemetry_device_owner", "typed_telemetry_devices"],
    ["typed_telemetry_manifest_owner", "typed_telemetry_manifests"],
  ] as const) {
    await db().prepare(`DROP INDEX ${index}`).run();
    await expect(readEffectiveUsageOwnerDayPage(db(), options))
      .rejects.toMatchObject({ code: "EFFECTIVE_USAGE_UNAVAILABLE" });
    await db().prepare(`CREATE INDEX ${index} ON ${table}(owner_id,id)`).run();
  }
  expect((await readEffectiveUsageOwnerDayPage(db(), options)).rows).toHaveLength(1);
}, 30_000);

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
