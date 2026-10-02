import { normalizeNativeEffectiveOccurrence, canonicalFieldPresence } from '../src/canonical-analytics-facts';
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
import { EffectiveUsageReaderError, readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage,
  readEffectiveTelemetryOwnerDays } from "../src/telemetry-usage-effective-reader";
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from "../src/d1-invocation-budget";

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
  // successor's follow-ups and the source-day catalog depend on 0008 and stay out too.
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS
    .filter((migration) => !/^(0008|0010|0011|0012|0013|0014|0015|0016)_/u.test(migration.name)));
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
  chunkSeq = 0,
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
  const envelopeDigest = await sha256Hex(`synthetic-effective-reader-envelope:${observedDay}:${revision}:${chunkSeq}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${observedDay}:${chunkSeq}`, chunkRevision: revision,
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
  expect(page.rows[0]!.canonicalEvidence?.linkedDays).toHaveLength(2);
  const canonical = await normalizeNativeEffectiveOccurrence({sourceNamespace,ownerDigest:page.ownerDigest,
    selectionMethod:'effective-union-v1'},page.rows[0]!,0);
  expect(canonical.status).toBe('base_conflict');
  expect(canonical.location.observedAtMs).toBeNull();
  expect(canonicalFieldPresence(canonical,'outputCombinedTokens')).toBe('conflict');


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
    // Reached-chunk acquisition and direct selection each make one indexed
    // physical seek per format. Neither traversal may become an owner scan.
    expect(physical).toHaveLength(4);
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
  // The narrowed window now also limits the chunks whose complete admission
  // proof is checked. The comparison retains the same source predicates.
  expect(current.meta.rows_read).toBeLessThan(prior.meta.rows_read / 2);
  console.info("effective-reader-window-rows", { current: current.meta.rows_read, prior: prior.meta.rows_read });

  const sources = observed.queries.filter(value => value.sql.includes("selected_stream("));
  expect(sources).toHaveLength(1);
  const sourcePlan = await db().prepare(`EXPLAIN QUERY PLAN ${sources[0]!.sql}`)
    .bind(...sources[0]!.values).all<{ detail: string }>();
  const sourcePhysical = sourcePlan.results.filter(row => row.detail.includes("scoped_record"));
  expect(sourcePhysical).toHaveLength(4);
  expect(sourcePhysical.filter(row => row.detail.includes("typed_telemetry_v1_occurrence"))).toHaveLength(2);
  expect(sourcePhysical.filter(row => row.detail.includes("typed_telemetry_v11_occurrence"))).toHaveLength(2);
  for (const row of sourcePhysical.filter(row => row.detail.includes("typed_telemetry_v1_occurrence")))
    expect(row.detail).toContain("device_id=? AND stream=? AND occurrence_id=?");
  for (const row of sourcePhysical.filter(row => row.detail.includes("typed_telemetry_v11_occurrence")))
    expect(row.detail).toContain("manifest_id=? AND stream=? AND occurrence_id=?");
  expect(sourcePlan.results.find(row => row.detail.includes("scoped_device"))?.detail)
    .toContain("USING COVERING INDEX typed_telemetry_device_owner (owner_id=?)");
  expect(sourcePlan.results.find(row => row.detail.includes("scoped_manifest"))?.detail)
    .toContain("USING COVERING INDEX typed_telemetry_manifest_owner (owner_id=?)");
  expect(sources[0]!.values[1]).toBeInstanceOf(ArrayBuffer);
  expect(sources[0]!.sql).not.toContain("json_each(?)");
  const sourceResult = await db().prepare(sources[0]!.sql).bind(...sources[0]!.values).all();
  expect(sourceResult.results).toHaveLength(2);
  const priorSourceSql = sources[0]!.sql
    .replace(/      CROSS JOIN typed_telemetry_devices scoped_device INDEXED BY typed_telemetry_device_owner\n       ON scoped_device.owner_id=(?:owner_membership|membership).typed_owner_id\n/gu, "")
    .replace(/      CROSS JOIN typed_telemetry_manifests scoped_manifest INDEXED BY typed_telemetry_manifest_owner\n       ON scoped_manifest.owner_id=(?:owner_membership|membership).typed_owner_id\n/gu, "")
    .replaceAll("ON scoped_record.device_id=scoped_device.id AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replaceAll("ON scoped_record.manifest_id=scoped_manifest.id AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replaceAll("ON scoped_record.device_id=scoped_device.id\n        AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replaceAll("ON scoped_record.manifest_id=scoped_manifest.id\n        AND scoped_record.owner_id", "ON scoped_record.owner_id")
    .replaceAll("INDEXED BY typed_telemetry_v1_occurrence", "INDEXED BY typed_telemetry_owner_time")
    .replaceAll("INDEXED BY typed_telemetry_v11_occurrence", "INDEXED BY typed_telemetry_owner_time");
  expect(priorSourceSql).not.toContain("scoped_device");
  expect(priorSourceSql).not.toContain("scoped_manifest");
  const priorSource = await db().prepare(priorSourceSql).bind(...sources[0]!.values).all();
  expect(sourceResult.results).toEqual(priorSource.results);
  // Both plans retain immutable completeness proof; the prior plan traverses
  // unrelated retained rows in occurrence expansion and reached-chunk lookup.
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

it("proves only reached complete chunks while keeping cross-day links within the exact owner", async () => {
  const fixture = await createV11DeviceFixture(db());
  const sameOwnerOtherDevice = await createV11DeviceFixture(db(), { participantId: fixture.participantId });
  const foreign = await createV11DeviceFixture(db());
  const occurrence = `event:v2:${"d".repeat(64)}`;
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, [occurrence], true), sourceNamespace);
  await insertTypedTelemetryV1Chunk(db(),
    await makeInsert(sameOwnerOtherDevice, 1, [occurrence], true, null, "2026-09-21"), sourceNamespace);
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(foreign, 1, [occurrence], true), sourceNamespace);
  const owner = await ownerFor(fixture.participantId);
  const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch, day, limit: 1 };
  const complete = await readEffectiveUsageOwnerDayPage(db(), options);
  expect(complete.rows).toHaveLength(1);
  expect(complete.rows[0]).toMatchObject({ occurrenceId: occurrence, sourceCount: 2,
    eventTimeConflict: true, status: "base_conflict" });
  expect(complete.rows[0]?.canonicalEvidence?.linkedDays).toHaveLength(2);
  // Native admission cannot produce a partial current chunk. A synthetic
  // corrupted header checks that the reader still proves the exact reached
  // chunk's admission count rather than trusting its selected physical row.
  await db().prepare(`UPDATE telemetry_v1_chunks SET record_count=2,accepted_record_count=2
    WHERE participant_id=? AND chunk_day=? AND superseded_at IS NULL`).bind(fixture.participantId, day).run();
  expect((await readEffectiveUsageOwnerDayPage(db(), options)).rows).toEqual([]);
  expect((await readEffectiveTelemetryOwnerDayPage(db(), { ...options, stream: "usage" })).rows).toEqual([]);
}, 30_000);

it("bounds sparse and 200-ID page proofs by reached chunks, not unrelated complete owner chunks", async () => {
  const fixture = await createV11DeviceFixture(db());
  const selected = Array.from({ length: 200 }, (_, index) =>
    `event:v2:${(index + 1).toString(16).padStart(64, "0")}`);
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, selected, true), sourceNamespace);
  const unrelatedDay = "2026-09-21";
  const snapshots: { chunks: number; sparseCandidate: number; sparseSource: number;
    denseCandidate: number; denseSource: number }[] = [];
  let expectedSparse: unknown;
  let expectedDense: unknown;
  const measure = async (chunks: number) => {
    const owner = await ownerFor(fixture.participantId);
    const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
      authorityEpoch: owner.authority_epoch, day };
    const reads: { kind: "candidate" | "source"; rows: number }[] = [];
    const observed = new Proxy(db(), { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const kind = sql.includes("selected_window(") ? "candidate"
          : sql.includes("selected_stream(") ? "source" : null;
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
          get(inner, member) {
            if (member === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
            if (member === "all") return async () => {
              const result = await inner.all();
              if (kind) {
                expect(Number.isSafeInteger(result.meta.rows_read)).toBe(true);
                reads.push({ kind, rows: result.meta.rows_read });
              }
              return result;
            };
            const value = Reflect.get(inner, member);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
        return wrap(target.prepare(sql));
      };
    } });
    const sparse = {
      usage: await readEffectiveUsageOwnerDayPage(observed, { ...options, limit: 1 }),
      generic: await readEffectiveTelemetryOwnerDayPage(observed, { ...options, stream: "usage", limit: 1 }),
    };
    const dense = {
      usage: await readEffectiveUsageOwnerDayPage(observed, { ...options, limit: 200 }),
      generic: await readEffectiveTelemetryOwnerDayPage(observed, { ...options, stream: "usage", limit: 200 }),
    };
    expect(sparse.usage.rows).toHaveLength(1);
    expect(sparse.generic.rows).toHaveLength(1);
    expect(dense.usage.rows.map(row => row.occurrenceId)).toEqual(selected);
    expect(dense.generic.rows.map(row => row.occurrenceId)).toEqual(selected);
    if (chunks === 0) { expectedSparse = sparse; expectedDense = dense; }
    else { expect(sparse).toEqual(expectedSparse); expect(dense).toEqual(expectedDense); }
    expect(reads.filter(read => read.kind === "candidate")).toHaveLength(4);
    expect(reads.filter(read => read.kind === "source")).toHaveLength(8);
    const total = (kind: "candidate" | "source", from: number, count: number) =>
      reads.filter(read => read.kind === kind).slice(from, from + count).reduce((sum, read) => sum + read.rows, 0);
    snapshots.push({ chunks, sparseCandidate: total("candidate", 0, 2), sparseSource: total("source", 0, 2),
      denseCandidate: total("candidate", 2, 2), denseSource: total("source", 2, 6) });
  };
  await measure(0);
  for (let ordinal = 1; ordinal <= 1_024; ordinal++) {
    const unrelated = `event:v2:${(ordinal + 1_000).toString(16).padStart(64, "0")}`;
    const inserted = await insertTypedTelemetryV1Chunk(db(),
      await makeInsert(fixture, 1, [unrelated], true, null, unrelatedDay, ordinal), sourceNamespace);
    expect(inserted).toMatchObject({ acceptedRecords: 1, replay: false });
    if (ordinal === 128 || ordinal === 1_024) await measure(ordinal);
  }
  console.info("effective-reader-reached-chunk-scaling", snapshots);
  const [base, medium, large] = snapshots;
  expect([base?.chunks, medium?.chunks, large?.chunks]).toEqual([0, 128, 1_024]);
  for (const sample of [medium!, large!]) {
    expect(sample.sparseCandidate - base!.sparseCandidate).toBeLessThanOrEqual(128);
    expect(sample.sparseSource - base!.sparseSource).toBeLessThanOrEqual(256);
    expect(sample.denseCandidate - base!.denseCandidate).toBeLessThanOrEqual(256);
    expect(sample.denseSource - base!.denseSource).toBeLessThanOrEqual(512);
  }
}, 180_000);

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

it("retains a private D1 cause when the bounded occurrence source read fails", async () => {
  const fixture = await createV11DeviceFixture(db());
  const occurrence = `event:v2:${"1".repeat(64)}`;
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, [occurrence], true), sourceNamespace);
  const owner = await ownerFor(fixture.participantId);
  const cause = new Error("D1_ERROR: query timed out SELECT private_column WHERE owner=synthetic-owner");
  const failing = new Proxy(db(), { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (!sql.includes("requested(occurrence_id) AS MATERIALIZED")) return target.prepare(sql);
      return { bind: () => ({ all: async () => { throw cause; } }) } as unknown as D1PreparedStatement;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const error = await readEffectiveUsageOwnerDayPage(failing, {
    sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch, day, limit: 1,
  }).catch(error => error);
  expect(error).toBeInstanceOf(EffectiveUsageReaderError);
  expect(error).toMatchObject({ code: "EFFECTIVE_USAGE_UNAVAILABLE" });
  expect(error.cause).toBe(cause);
  expect(JSON.stringify(error)).not.toMatch(/private_column|synthetic-owner|SELECT/u);
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
    const canonical = await normalizeNativeEffectiveOccurrence({sourceNamespace,ownerDigest:owner.owner_digest,
      selectionMethod:'effective-union-v1'},known!,0);
    expect(canonical.values.totalInputContextTokens).toBe(150);
    expect(canonical.values.outputCombinedTokens).toBe(75);
    expect(canonicalFieldPresence(canonical,'inputCacheReadTokens')).toBe('unknown');
    expect(canonical.provenance.variants).toHaveLength(2);
    expect(canonical.provenance.coverage).toBe('complete');
    expect(canonical.provenance.linkedDays).toEqual([day]);

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

it("propagates actual invocation-budget exhaustion at every effective-reader D1 boundary", async () => {
  const fixture = await createV11DeviceFixture(db());
  const occurrence = `event:v2:${"a".repeat(64)}`;
  await insertTypedTelemetryV1Chunk(db(), await makeInsert(fixture, 1, [occurrence], true), sourceNamespace);

  // Admit a real quota chunk through the same native authorization and typed
  // writer. Generic candidate/source tests must not rely on fabricated rows.
  const quota = [{ schemaVersion: "quota-observation-v1.0", observationId: `quota-occurrence:v1:${"b".repeat(64)}`,
    observedTime: `${day}T12:00:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
    limitId: "codex", slot: "secondary", usedPercent: 0.3, windowDurationMinutes: 10080,
    resetsAt: `${day}T13:00:00.000Z` }];
  const envelopeDigest = await sha256Hex("synthetic-effective-reader-quota-budget");
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const quotaChunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `quota:${day}:0`, chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json(quota)), parserVersion: "synthetic-effective-reader-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" },
    records: quota,
  });
  expect(await insertTypedTelemetryV1Chunk(db(), {
    chunkRowId: `chunk:synthetic-quota-budget-${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId, chunk: quotaChunk, envelopeDigest,
    r2Key: `synthetic/quota-budget-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null,
  }, sourceNamespace)).toMatchObject({ acceptedRecords: 1, replay: false });

  const owner = await ownerFor(fixture.participantId);
  const options = { sourceNamespace, ownerDigest: owner.owner_digest, ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch, day, limit: 1 };
  const unchanged = async () => ({
    rows: (await db().prepare("SELECT * FROM typed_telemetry_records ORDER BY id").all()).results,
    chunks: (await db().prepare("SELECT * FROM telemetry_v1_chunks ORDER BY id").all()).results,
    owner: (await db().prepare("SELECT * FROM storage_owner_revisions ORDER BY owner_digest").all()).results,
    admission: (await db().prepare("SELECT * FROM typed_v1_admission_state ORDER BY id").all()).results,
  });
  const sourceBefore = await unchanged();
  const stages = [
    { name: "capability", sql: (value: string) => value.includes("SELECT name FROM sqlite_master"), stream: "usage", empty: false },
    { name: "owner", sql: (value: string) => value.includes("v1.source_namespace AS v1_namespace"), stream: "usage", empty: false },
    { name: "candidate", sql: (value: string) => value.includes("selected_window("), stream: "usage", empty: false },
    { name: "source", sql: (value: string) => value.includes("selected_stream("), stream: "usage", empty: false },
    { name: "typed-schema", sql: (value: string) => value.includes("SELECT version FROM typed_telemetry_schema WHERE id=1"), stream: "usage", empty: false },
    { name: "typed-decode", sql: (value: string) => value.includes("SELECT * FROM typed_telemetry_compatibility_records"), stream: "usage", empty: false },
    { name: "final-owner", sql: (value: string) => value.includes("correction.state AS correction_state")
      && !value.includes("v1.source_namespace AS v1_namespace"), stream: "usage", empty: false },
    { name: "empty-final-owner", sql: (value: string) => value.includes("correction.state AS correction_state")
      && !value.includes("v1.source_namespace AS v1_namespace"), stream: "usage", empty: true },
    { name: "quota-candidate", sql: (value: string) => value.includes("selected_window("), stream: "quota", empty: false },
    { name: "quota-source", sql: (value: string) => value.includes("selected_stream("), stream: "quota", empty: false },
  ] as const;
  const failures: string[] = [];
  for (const stage of stages) {
    const budget = createD1InvocationBudget(32);
    const metered = budget.wrap(db());
    let reached = 0;
    const observing = new Proxy(metered, { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(inner, member) {
          if (member === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
          if (["first", "all", "run", "raw"].includes(String(member))) return async (...args: unknown[]) => {
            if (stage.sql(sql)) {
              reached += 1;
              if (reached === 1) {
                while (budget.remainingQueries > 0) await metered.prepare("SELECT 1").first();
              }
            }
            const method = Reflect.get(inner, member) as (...values: unknown[]) => unknown;
            return method.apply(inner, args);
          };
          const value = Reflect.get(inner, member);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
        return wrap(target.prepare(sql));
      };
    } });
    const read = stage.stream === "usage"
      ? readEffectiveUsageOwnerDayPage(observing, { ...options, day: stage.empty ? "2026-09-22" : day })
      : readEffectiveTelemetryOwnerDayPage(observing, { ...options, stream: "quota" });
    const error = await read.catch((value: unknown) => value);
    if (!(error instanceof D1InvocationBudgetExceededError)) failures.push(stage.name);
    expect(reached, stage.name).toBe(1);
    expect(budget.queriesUsed, stage.name).toBe(32);
    expect(budget.remainingQueries, stage.name).toBe(0);
    expect(await unchanged(), stage.name).toEqual(sourceBefore);
  }
  expect(failures).toEqual([]);
}, 90_000);

// Additive native inventory regression controls. Existing beforeEach deliberately
// omits selective dependencies0014/15: no maintained coverage can license reuse.
import nativeInventoryBaseline from './fixtures/native-day-inventory-a1535f2a.json';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';

function measuredInventory(database:D1Database){
  const charges:number[]=[],queries:{sql:string;values:unknown[]}[]=[];
  return {charges,queries,database:new Proxy(database,{get(target,key){
    if(key==='prepare')return(sql:string)=>{
      const original=target.prepare(sql);
      if(!sql.includes('direct AS (')||!sql.includes('observed_day'))return original;
      const query={sql,values:[] as unknown[]};queries.push(query);
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,member){
        if(member==='bind')return(...values:unknown[])=>{query.values=values;return wrap(inner.bind(...values));};
        if(member==='all')return async()=>{const result=await inner.all();
          expect(Number.isSafeInteger(result.meta.rows_read)).toBe(true);
          expect(result.meta.rows_read).toBeGreaterThan(0);charges.push(result.meta.rows_read);return result;};
        const value:unknown=Reflect.get(inner,member);return typeof value==='function'?value.bind(inner):value;
      }});return wrap(original);
    };
    const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }})};
}

it('halves physical native inventory reads while preserving the exact old SQL day set',async({annotate,task})=>{
  const fixture=await createV11DeviceFixture(db());
  const days=Array.from({length:9},(_,index)=>new Date(Date.parse(day)+index*86_400_000).toISOString().slice(0,10));
  for(const selectedDay of days)await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    Array.from({length:200},(_,index)=>`synthetic:inventory:read-bound:${selectedDay}:${index}`),true,null,selectedDay),sourceNamespace);
  const owner=await ownerFor(fixture.participantId);
  const invocation=createD1InvocationBudget(950),profile=createAnalyticsProfile();
  const measured=measuredInventory(profileAnalyticsDatabase(invocation.wrap(db()),'source',profile,()=> 'inventory'));
  const options={sourceNamespace,stream:'usage' as const,ownerDigest:owner.owner_digest,ownerRevision:owner.revision,
    authorityEpoch:owner.authority_epoch,fromDay:days[0]!,throughDay:days.at(-1)!};
  const currentStarted=performance.now();
  const current=await readEffectiveTelemetryOwnerDays(measured.database,options);
  const currentWallMs=performance.now()-currentStarted;
  expect(measured.charges).toHaveLength(1);
  expect(current).toEqual(days);
  expect(nativeInventoryBaseline.sqlSha256).toBe('d3c18c117b38faf4a5d75bf68b97da7cd3d9cb3e6aed25feac4b0bd7741dd076');
  expect(await sha256Hex(nativeInventoryBaseline.sql)).toBe(nativeInventoryBaseline.sqlSha256);
  const oldValues=[
    fixture.participantId,1,Date.parse(options.fromDay),Date.parse(options.throughDay)+86_400_000,
    sourceNamespace,'usage',owner.owner_digest,fixture.participantId,'usage',options.fromDay,options.throughDay,
    'usage',owner.owner_digest,fixture.participantId,sourceNamespace,fixture.participantId,
    'usage',options.fromDay,options.throughDay];
  const oracleMeter=createD1InvocationBudget(950),priorStarted=performance.now();
  const prior=await oracleMeter.wrap(db()).prepare(nativeInventoryBaseline.sql).bind(...oldValues).all<{observed_day:string}>();
  const priorWallMs=performance.now()-priorStarted;
  expect(current).toEqual(prior.results.map(row=>row.observed_day));
  expect(Number.isSafeInteger(prior.meta.rows_read)).toBe(true);
  expect(prior.meta.rows_read).toBeGreaterThan(0);
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
  expect(profile.measurementFailures).toBe(0);
  const outer=Object.values(profile.costs).reduce((sum,cost)=>({statements:sum.statements+cost.statements,
    failedStatements:sum.failedStatements+cost.failedStatements,rowsRead:sum.rowsRead+cost.rowsRead,
    rowsWritten:sum.rowsWritten+cost.rowsWritten,databaseMs:sum.databaseMs+cost.databaseMs,
    metadataSamples:sum.metadataSamples+cost.metadataSamples,statementCallWallMs:sum.statementCallWallMs+cost.statementCallWallMs}),
    {statements:0,failedStatements:0,rowsRead:0,rowsWritten:0,databaseMs:0,metadataSamples:0,statementCallWallMs:0});
  expect(outer.statements).toBe(invocation.queriesUsed);expect(outer.failedStatements).toBe(0);
  expect(outer.metadataSamples).toBe(outer.statements);expect(outer.rowsWritten).toBe(0);
  const costs={days:9,admittedUsageRows:1800,current:measured.charges[0],prior:prior.meta.rows_read,
    outer:{...outer,wallMs:currentWallMs},measurementFailures:profile.measurementFailures,
    invocationStatements:invocation.queriesUsed,invocationHeadroom:invocation.remainingQueries,
    oracleProof:{statements:oracleMeter.queriesUsed,rowsRead:prior.meta.rows_read,rowsWritten:prior.meta.rows_written,
      databaseMs:prior.meta.duration,wallMs:priorWallMs,headroom:oracleMeter.remainingQueries}};
  await annotate(JSON.stringify(costs),'native-inventory-physical-read-bound');
  // Plans are bounded post-measurement proof work. Raw SQL/binds/details stay
  // in memory; the persisted report contains only closed categories and hashes.
  expect(measured.queries).toHaveLength(1);
  const explainMeter=createD1InvocationBudget(950),plans=[];
  for(const [name,query] of [['current',measured.queries[0]!],
    ['prior',{sql:nativeInventoryBaseline.sql,values:oldValues}]] as const){
    const planStarted=performance.now();
    const result=await explainMeter.wrap(db()).prepare('EXPLAIN QUERY PLAN '+query.sql)
      .bind(...query.values).all<{detail:string}>();
    const planWallMs=performance.now()-planStarted;
    const categories:Record<string,number>={};
    for(const row of result.results){
      const kind=/CORRELATED/u.test(row.detail)?'correlated_subquery':/MATERIALIZE/u.test(row.detail)?'materialize':
        /^SCAN /u.test(row.detail)?'scan':/^SEARCH /u.test(row.detail)?'search':/TEMP B-TREE/u.test(row.detail)?'temporary_btree':
        /CO-ROUTINE/u.test(row.detail)?'coroutine':/COMPOUND|UNION/u.test(row.detail)?'compound':
        /SUBQUERY/u.test(row.detail)?'subquery':'other';
      categories[kind]=(categories[kind]??0)+1;
    }
    plans.push({name,sqlSha256:await sha256Hex(query.sql),categories,nodeCount:result.results.length,
      nodesSha256:await sha256Hex(JSON.stringify(result.results)),proofReads:result.meta.rows_read,
      proofWrites:result.meta.rows_written,databaseMs:result.meta.duration,wallMs:planWallMs});
  }
  const report={costs,plans,proofStatements:explainMeter.queriesUsed,proofHeadroom:explainMeter.remainingQueries,
    exclusions:{fixtureSetup:'unmeasured setup; excluded from current invocation and proof totals',
      sourceFamilyControls:'separate semantic tests; excluded from read-cost comparison',
      dense101:'not executed by this narrow gate',originalAssertions:'unchanged; narrow gate selects additive cases only'}};
  Object.assign(task.meta,{nativeInventorySemijoin:report});
  await annotate(JSON.stringify(report),'native-inventory-actual-explain');
  // This deliberately fails the original query against its identical oracle.
  // Preserve this threshold if the proposed global-window semijoin is slower.
  expect(measured.charges[0]).toBeLessThanOrEqual(prior.meta.rows_read/2);
},90_000);

it('requires real rows for each inventory day and discovers a newly admitted empty-gap day', async () => {
  const fixture=await createV11DeviceFixture(db()),other=await createV11DeviceFixture(db());
  const secondDevice=await createV11DeviceFixture(db(),{participantId:fixture.participantId});
  const gap='2026-09-21',last='2026-09-22',outside='2026-09-23';
  const duplicate=`event:v2:${'9'.repeat(64)}`;
  for(const selectedDay of [day,last])await insertTypedTelemetryV1Chunk(db(),
    await makeInsert(selectedDay===day?fixture:secondDevice,1,[duplicate,...Array.from({length:39},(_,index)=>
      `synthetic:inventory:${selectedDay}:${index}`)],true,null,selectedDay),sourceNamespace);
  // An unrelated owner's physical row and this owner's outside row must not
  // turn the middle calendar candidate into positive source evidence.
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(other,1,
    ['synthetic:inventory:unrelated'],true,null,gap),sourceNamespace);
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    ['synthetic:inventory:outside'],true,null,outside),sourceNamespace);
  const before=await ownerFor(fixture.participantId);
  const options={sourceNamespace,stream:'usage' as const,ownerDigest:before.owner_digest,ownerRevision:before.revision,
    authorityEpoch:before.authority_epoch,fromDay:day,throughDay:last};
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,stream:'usage'})).toEqual([day,last]);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,stream:'quota'})).toEqual([]);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,stream:'session'})).toEqual([]);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,fromDay:gap,throughDay:gap})).toEqual([]);
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    ['synthetic:inventory:new-gap'],true,null,gap),sourceNamespace);
  const after=await ownerFor(fixture.participantId);
  expect(after.revision).toBeGreaterThan(before.revision);
  await expect(readEffectiveTelemetryOwnerDays(db(),options)).rejects.toMatchObject({code:'EFFECTIVE_USAGE_CAS_MISMATCH'});
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,ownerRevision:after.revision,
    authorityEpoch:after.authority_epoch})).toEqual([day,gap,last]);
});

function afterInventoryQuery(database:D1Database,mutate:()=>Promise<void>){
  let mutations=0;
  return {count:()=>mutations,database:new Proxy(database,{get(target,key){
    if(key==='prepare')return(sql:string)=>{
      const original=target.prepare(sql);
      if(!sql.includes('direct AS (')||!sql.includes('observed_day'))return original;
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,member){
        if(member==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
        if(member==='all')return async()=>{const result=await inner.all();
          if(mutations===0){mutations++;await mutate();}return result;};
        const value:unknown=Reflect.get(inner,member);return typeof value==='function'?value.bind(inner):value;
      }});
      return wrap(original);
    };
    const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }})};
}

it('keeps the final inventory owner proof after a real new-day admission commits',async()=>{
  const fixture=await createV11DeviceFixture(db()),gap='2026-09-21';
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    ['synthetic:inventory:initial'],true),sourceNamespace);
  const owner=await ownerFor(fixture.participantId),options={sourceNamespace,stream:'usage' as const,ownerDigest:owner.owner_digest,
    ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,fromDay:day,throughDay:gap};
  const observed=afterInventoryQuery(db(),async()=>{await insertTypedTelemetryV1Chunk(db(),
    await makeInsert(fixture,1,['synthetic:inventory:concurrent'],true,null,gap),sourceNamespace);});
  await expect(readEffectiveTelemetryOwnerDays(observed.database,options))
    .rejects.toMatchObject({code:'EFFECTIVE_USAGE_CAS_MISMATCH'});
  expect(observed.count()).toBe(1);
  const fresh=await ownerFor(fixture.participantId);
  expect(fresh.revision).toBeGreaterThan(owner.revision);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,ownerRevision:fresh.revision,
    authorityEpoch:fresh.authority_epoch})).toEqual([day,gap]);
});

it('keeps correction runtime fencing when owner revision does not change during inventory',async()=>{
  const fixture=await createV11DeviceFixture(db());
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    ['synthetic:inventory:correction-fence'],true),sourceNamespace);
  expect(await db().prepare('SELECT state FROM telemetry_usage_correction_runtime WHERE id=1')
    .first<string>('state')).toBe('staged');
  const owner=await ownerFor(fixture.participantId),options={sourceNamespace,stream:'usage' as const,ownerDigest:owner.owner_digest,
    ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,fromDay:day,throughDay:day};
  const observed=afterInventoryQuery(db(),async()=>{
    const result=await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1 AND state='staged'").run();
    expect(result.meta.changes).toBe(1);
  });
  await expect(readEffectiveTelemetryOwnerDays(observed.database,options))
    .rejects.toMatchObject({code:'EFFECTIVE_USAGE_CAS_MISMATCH'});
  expect(observed.count()).toBe(1);expect(await ownerFor(fixture.participantId)).toEqual(owner);
  expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([day]);
});

it('preserves the original global timestamp range after deliberate trigger-loss corruption and restoration',async()=>{
  const fixture=await createV11DeviceFixture(db()),shiftedDay='2026-09-21';
  await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    ['synthetic:inventory:restored-mismatch'],true),sourceNamespace);
  const owner=await ownerFor(fixture.participantId),options={sourceNamespace,stream:'usage' as const,
    ownerDigest:owner.owner_digest,ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,
    fromDay:day,throughDay:shiftedDay};
  expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([day]);
  const row=await db().prepare(`SELECT r.id,r.observed_day FROM typed_telemetry_records r
    JOIN typed_v1_record_admissions p ON p.typed_record_id=r.id
    JOIN telemetry_v1_chunks c ON c.id=p.chunk_id WHERE c.participant_id=?`)
    .bind(fixture.participantId).first<{id:number;observed_day:number}>();
  expect(row).not.toBeNull();
  const guard=await db().prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='typed_telemetry_record_immutable'`).first<string>('sql');
  expect(guard).toEqual(expect.any(String));
  // Deliberately model a damaged/restored local store. This is not an admitted
  // positive fixture and is not evidence that the normal writer permits it.
  await db().prepare('DROP TRIGGER typed_telemetry_record_immutable').run();
  try{
    const mutation=await db().prepare('UPDATE typed_telemetry_records SET observed_at_ms=? WHERE id=?')
      .bind(Date.parse(shiftedDay)+3_600_000,row!.id).run();
    expect(mutation.meta.changes).toBe(1);
  }finally{await db().prepare(guard!).run();}
  const persisted=await db().prepare('SELECT observed_day,observed_at_ms FROM typed_telemetry_records WHERE id=?')
    .bind(row!.id).first<{observed_day:number;observed_at_ms:number}>();
  expect(persisted).toEqual({observed_day:row!.observed_day,observed_at_ms:Date.parse(shiftedDay)+3_600_000});
  expect(await db().prepare(`SELECT count(*) AS n FROM sqlite_schema
    WHERE type='trigger' AND name='typed_telemetry_record_immutable'`).first<number>('n')).toBe(1);
  expect(await ownerFor(fixture.participantId)).toEqual(owner);
  // Old global-window membership includes the stored observed day only when
  // both coordinates lie in the requested range. Day-specific seeks lose it.
  expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([day]);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,throughDay:day})).toEqual([]);
  expect(await readEffectiveTelemetryOwnerDays(db(),{...options,fromDay:shiftedDay})).toEqual([]);
});

// Additive regressions for the measured global-range scan reversal. The original
// 9-day fixed twofold gate, all original tests, and source-family controls remain.
it('halves physical native inventory reads across 101 days with 99 empty candidates',async({annotate,task})=>{
  const fixture=await createV11DeviceFixture(db());
  // Same real-clock historical extent as the unchanged dense101 corpus.
  const todayMs=Date.parse(new Date().toISOString().slice(0,10));
  const days=Array.from({length:101},(_,index)=>new Date(todayMs-(101-index)*86_400_000).toISOString().slice(0,10));
  for(const selectedDay of [days[0]!,days.at(-1)!])await insertTypedTelemetryV1Chunk(db(),await makeInsert(fixture,1,
    Array.from({length:200},(_,index)=>`synthetic:inventory:sparse101:${selectedDay}:${index}`),true,null,selectedDay),sourceNamespace);
  const owner=await ownerFor(fixture.participantId);
  const invocation=createD1InvocationBudget(950),profile=createAnalyticsProfile();
  const measured=measuredInventory(profileAnalyticsDatabase(invocation.wrap(db()),'source',profile,()=> 'inventory'));
  const options={sourceNamespace,stream:'usage' as const,ownerDigest:owner.owner_digest,ownerRevision:owner.revision,
    authorityEpoch:owner.authority_epoch,fromDay:days[0]!,throughDay:days.at(-1)!};
  const currentStarted=performance.now();
  const current=await readEffectiveTelemetryOwnerDays(measured.database,options);
  const currentWallMs=performance.now()-currentStarted;
  expect(measured.charges).toHaveLength(1);
  expect(current).toEqual([days[0]!,days.at(-1)!]);
  expect(nativeInventoryBaseline.sqlSha256).toBe('d3c18c117b38faf4a5d75bf68b97da7cd3d9cb3e6aed25feac4b0bd7741dd076');
  expect(await sha256Hex(nativeInventoryBaseline.sql)).toBe(nativeInventoryBaseline.sqlSha256);
  const oldValues=[
    fixture.participantId,1,Date.parse(options.fromDay),Date.parse(options.throughDay)+86_400_000,
    sourceNamespace,'usage',owner.owner_digest,fixture.participantId,'usage',options.fromDay,options.throughDay,
    'usage',owner.owner_digest,fixture.participantId,sourceNamespace,fixture.participantId,
    'usage',options.fromDay,options.throughDay];
  const oracleMeter=createD1InvocationBudget(950),priorStarted=performance.now();
  const prior=await oracleMeter.wrap(db()).prepare(nativeInventoryBaseline.sql).bind(...oldValues).all<{observed_day:string}>();
  const priorWallMs=performance.now()-priorStarted;
  expect(current).toEqual(prior.results.map(row=>row.observed_day));
  expect(Number.isSafeInteger(prior.meta.rows_read)).toBe(true);
  expect(prior.meta.rows_read).toBeGreaterThan(0);
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
  expect(profile.measurementFailures).toBe(0);
  const outer=Object.values(profile.costs).reduce((sum,cost)=>({statements:sum.statements+cost.statements,
    failedStatements:sum.failedStatements+cost.failedStatements,rowsRead:sum.rowsRead+cost.rowsRead,
    rowsWritten:sum.rowsWritten+cost.rowsWritten,databaseMs:sum.databaseMs+cost.databaseMs,
    metadataSamples:sum.metadataSamples+cost.metadataSamples,statementCallWallMs:sum.statementCallWallMs+cost.statementCallWallMs}),
    {statements:0,failedStatements:0,rowsRead:0,rowsWritten:0,databaseMs:0,metadataSamples:0,statementCallWallMs:0});
  expect(outer.statements).toBe(invocation.queriesUsed);expect(outer.failedStatements).toBe(0);
  expect(outer.metadataSamples).toBe(outer.statements);expect(outer.rowsWritten).toBe(0);
  const costs={days:101,emptyCandidateDays:99,admittedUsageRows:400,current:measured.charges[0],prior:prior.meta.rows_read,
    outer:{...outer,wallMs:currentWallMs},measurementFailures:profile.measurementFailures,
    invocationStatements:invocation.queriesUsed,invocationHeadroom:invocation.remainingQueries,
    oracleProof:{statements:oracleMeter.queriesUsed,rowsRead:prior.meta.rows_read,rowsWritten:prior.meta.rows_written,
      databaseMs:prior.meta.duration,wallMs:priorWallMs,headroom:oracleMeter.remainingQueries}};
  await annotate(JSON.stringify(costs),'native-inventory-sparse101-physical-read-bound');
  // Plans are bounded post-measurement proof work. Raw SQL/binds/details stay
  // in memory; the persisted report contains only closed categories and hashes.
  expect(measured.queries).toHaveLength(1);
  const explainMeter=createD1InvocationBudget(950),plans=[];
  for(const [name,query] of [['current',measured.queries[0]!],
    ['prior',{sql:nativeInventoryBaseline.sql,values:oldValues}]] as const){
    const planStarted=performance.now();
    const result=await explainMeter.wrap(db()).prepare('EXPLAIN QUERY PLAN '+query.sql)
      .bind(...query.values).all<{detail:string}>();
    const planWallMs=performance.now()-planStarted;
    const categories:Record<string,number>={};
    for(const row of result.results){
      const kind=/CORRELATED/u.test(row.detail)?'correlated_subquery':/MATERIALIZE/u.test(row.detail)?'materialize':
        /^SCAN /u.test(row.detail)?'scan':/^SEARCH /u.test(row.detail)?'search':/TEMP B-TREE/u.test(row.detail)?'temporary_btree':
        /CO-ROUTINE/u.test(row.detail)?'coroutine':/COMPOUND|UNION/u.test(row.detail)?'compound':
        /SUBQUERY/u.test(row.detail)?'subquery':'other';
      categories[kind]=(categories[kind]??0)+1;
    }
    plans.push({name,sqlSha256:await sha256Hex(query.sql),categories,nodeCount:result.results.length,
      nodesSha256:await sha256Hex(JSON.stringify(result.results)),proofReads:result.meta.rows_read,
      proofWrites:result.meta.rows_written,databaseMs:result.meta.duration,wallMs:planWallMs});
  }
  const report={costs,plans,proofStatements:explainMeter.queriesUsed,proofHeadroom:explainMeter.remainingQueries,
    exclusions:{fixtureSetup:'unmeasured setup; excluded from current invocation and proof totals',
      sourceFamilyControls:'separate semantic tests; excluded from read-cost comparison',
      dense101:'unchanged original dense corpus is a separate required gate',originalAssertions:'unchanged; narrow gate selects additive cases only'}};
  Object.assign(task.meta,{nativeInventorySparse101:report});
  await annotate(JSON.stringify(report),'native-inventory-sparse101-actual-explain');
  // This deliberately fails the original query against its identical oracle.
  // Preserve this threshold if the proposed materialized-header query is slower.
  expect(measured.charges[0]).toBeLessThanOrEqual(prior.meta.rows_read/2);
},90_000);

it('keeps exact inventory completeness after a deliberately corrupted current chunk header',async()=>{
  const fixture=await createV11DeviceFixture(db()),last='2026-09-21';
  for(const selectedDay of [day,last])await insertTypedTelemetryV1Chunk(db(),
    await makeInsert(fixture,1,[`synthetic:inventory:complete:${selectedDay}`],true,null,selectedDay),sourceNamespace);
  const owner=await ownerFor(fixture.participantId),options={sourceNamespace,stream:'usage' as const,
    ownerDigest:owner.owner_digest,ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,
    fromDay:day,throughDay:last};
  const prior=async()=> (await db().prepare(nativeInventoryBaseline.sql).bind(
    fixture.participantId,1,Date.parse(day),Date.parse(last)+86_400_000,
    sourceNamespace,'usage',owner.owner_digest,fixture.participantId,'usage',day,last,
    'usage',owner.owner_digest,fixture.participantId,sourceNamespace,fixture.participantId,
    'usage',day,last).all<{observed_day:string}>()).results.map(row=>row.observed_day);
  expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([day,last]);
  expect(await prior()).toEqual([day,last]);
  // Native admission cannot produce this partial count. Reproduce the owning
  // reader's existing corrupt-header control, retain the real physical row and
  // source event, and require old/new exact exclusion until the count is repaired.
  const readHeaders=async()=> (await db().prepare(`SELECT id,chunk_day,record_count,accepted_record_count,
    superseded_at FROM telemetry_v1_chunks WHERE participant_id=? ORDER BY chunk_day,id`)
    .bind(fixture.participantId).all<{id:string;chunk_day:string;record_count:number;
      accepted_record_count:number;superseded_at:string|null}>()).results;
  const originalHeaders=await readHeaders();
  expect(originalHeaders).toHaveLength(2);
  expect(originalHeaders.map(({chunk_day,record_count,accepted_record_count,superseded_at})=>
    ({chunk_day,record_count,accepted_record_count,superseded_at}))).toEqual([
      {chunk_day:day,record_count:1,accepted_record_count:1,superseded_at:null},
      {chunk_day:last,record_count:1,accepted_record_count:1,superseded_at:null}]);
  try{
    const mutation=await db().prepare(`UPDATE telemetry_v1_chunks SET record_count=2,accepted_record_count=2
      WHERE participant_id=? AND chunk_day=? AND superseded_at IS NULL`).bind(fixture.participantId,day).run();
    expect(mutation.success).toBe(true);
    // D1 metadata includes trigger effects. Verify the exact physical header
    // mutation and untouched sibling instead of assuming outer changes=1.
    expect(await readHeaders()).toEqual(originalHeaders.map(header=>header.chunk_day===day
      ?{...header,record_count:2,accepted_record_count:2}:header));
    expect(await ownerFor(fixture.participantId)).toEqual(owner);
    expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([last]);
    expect(await prior()).toEqual([last]);
  }finally{
    const repaired=await db().prepare(`UPDATE telemetry_v1_chunks SET record_count=1,accepted_record_count=1
      WHERE participant_id=? AND chunk_day=? AND superseded_at IS NULL`).bind(fixture.participantId,day).run();
    expect(repaired.success).toBe(true);
    expect(await readHeaders()).toEqual(originalHeaders);
  }
  expect(await ownerFor(fixture.participantId)).toEqual(owner);
  expect(await readEffectiveTelemetryOwnerDays(db(),options)).toEqual([day,last]);
  expect(await prior()).toEqual([day,last]);
});
