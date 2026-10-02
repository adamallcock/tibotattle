import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  canonicalTelemetryV12Json, telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput, telemetryV12RequiredConsent,
  MAX_TELEMETRY_V12_CHUNK_RECORDS, MAX_TELEMETRY_V12_DAY_CHUNKS,
  type TelemetryV12Chunk, type TelemetryV12DayManifest,
  type TelemetryV12QuotaObservation,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { canonicalJson } from "../src/canonical-json";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { sha256Hex } from "../src/crypto";
import {
  authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization,
} from "../src/device-auth";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import {
  createEffectiveHistoryDayDependencyReader, effectiveHistoryDependency,
} from "../src/storage-effective-history";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../src/telemetry-v12-repository";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";

type Bindings = Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
};
const bindings = env as Bindings;
const source = () => bindings.USAGE_MONITOR_DB;
const namespace = "synthetic-v12-dependency-plan";
const firstDay = "2026-09-01";
const outsideDay = "2026-09-02";
const days = Array.from({ length: 16 }, (_, index) =>
  new Date(Date.parse(`${firstDay}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));
const densities = [1, 32, 128, 512] as const;
type Device = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type AcceptedDay = Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>;
type Owner = Awaited<ReturnType<typeof readStorageCommunityOwnerPage>>[number];

function occurrence(index: number): string {
  return `quota:v12:${index.toString(16).padStart(64, "0")}`;
}
function quota(day: string, index: number, repeatId?: string): TelemetryV12QuotaObservation {
  return {
    schemaVersion: "quota-observation-v1.2", observationId: repeatId ?? occurrence(index),
    observedTime: `${day}T12:05:00.000Z`, provider: "openai_codex",
    planType: "pro", planVariant: "unknown", limitId: "codex", slot: "seven_day",
    usedPercent: 20, windowDurationMinutes: 10_080,
    resetsAt: "2026-09-25T12:05:00.000Z",
    accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    },
  };
}

async function preparedDay(day: string, chunks: number, idBase: number,
  repeatedId?: string, foreignId?: string): Promise<{
    manifest: TelemetryV12DayManifest; chunks: number; idBase: number;
    repeatedId?: string; foreignId?: string;
  }> {
  const consent = telemetryV12RequiredConsent();
  const descriptors: TelemetryV12DayManifest["chunks"] = [];
  for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
    const records = chunkRecords(day, chunkIndex, idBase, repeatedId, foreignId);
    descriptors.push({chunkId: `quota:${day}:${chunkIndex}`,
      chunkDigest: await sha256Hex(canonicalTelemetryV12Json(records)),
      recordCount: records.length});
  }
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day,
    parserVersion: "synthetic-v12-dependency-plan", consent,
    chunks: descriptors,
    excluded: {quota: 0, session: 0, usage: 0}, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  return {manifest, chunks, idBase, repeatedId, foreignId};
}
function chunkRecords(day: string, chunkIndex: number, idBase: number,
  repeatedId?: string, foreignId?: string): TelemetryV12QuotaObservation[] {
  return Array.from({length: MAX_TELEMETRY_V12_CHUNK_RECORDS}, (_, recordIndex) =>
    quota(day, idBase + chunkIndex * MAX_TELEMETRY_V12_CHUNK_RECORDS + recordIndex,
      chunkIndex === 0 && recordIndex === 0 ? repeatedId
        : chunkIndex === 0 && recordIndex === 1 ? foreignId : undefined));
}

async function stageDay(device: Device, prepared: Awaited<ReturnType<typeof preparedDay>>,
  chunkLimit = prepared.chunks): Promise<AcceptedDay> {
  const accepted = await registerTelemetryV12DayManifest(source(), device, prepared.manifest);
  for (let chunkIndex = 0; chunkIndex < chunkLimit; chunkIndex++) {
    const descriptor = prepared.manifest.chunks[chunkIndex]!;
    const chunk: TelemetryV12Chunk = {
      schemaVersion: "telemetry-contribution-v1.2",
      manifestDigest: prepared.manifest.manifestDigest,
      chunkId: descriptor.chunkId, chunkRevision: 1,
      parserVersion: prepared.manifest.parserVersion,
      consent: prepared.manifest.consent,
      records: chunkRecords(prepared.manifest.day, chunkIndex,
        prepared.idBase, prepared.repeatedId, prepared.foreignId),
      chunkDigest: descriptor.chunkDigest,
    };
    const principal = await authenticateDevice(source(), device.authorization);
    const envelopeDigest = await sha256Hex(`synthetic-plan-envelope:${crypto.randomUUID()}`);
    const upload = await createDeviceUploadAuthorization(source(), principal, envelopeDigest, 4096);
    const claimed = await claimDeviceUploadAuthorization(source(),
      `Upload ${upload.uploadAuthorization}`, {
        envelopeDigest, bodyBytes: 4096, contentType: "application/json",
      });
    await persistTelemetryV12StagedChunk(source(), device, chunk, {
      chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/v12-dependency-plan/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return accepted;
}

async function activate(device: Device, accepted: readonly AcceptedDay[]): Promise<void> {
  const ordered = [...accepted].sort((left, right) => left.day.localeCompare(right.day));
  const predecessor = await createTelemetryV12DomainPredecessor(source(), device, Date.now());
  const domain = {
    schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: {token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint},
    days: ordered.map(day => ({day: day.day, manifestId: day.manifestId,
      manifestDigest: day.manifestDigest})),
    manifestDigest: "0".repeat(64),
  };
  domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  const result = await activateTelemetryV12Domain(source(), device, domain, Date.now());
  expect(result.replay).toBe(false);
}

async function attachOwner(participantId: string, ordinal: number): Promise<void> {
  const digest = (ordinal + 1).toString(16).repeat(64);
  await source().prepare(`INSERT INTO storage_v11_owner_links
    (participant_id,owner_digest,state,object_digest,manifest_digest)
    VALUES(?,?,'active',?,?)`).bind(participantId, digest, digest, digest).run();
  await source().prepare(`INSERT INTO storage_owner_revisions
    (owner_digest,revision,authority_epoch,state) VALUES(?,1,1,'active')`)
    .bind(digest).run();
}

type Captured = {sql: string; values: readonly unknown[]; rowsRead: number; rowsWritten: number};
function observeDependency(database: D1Database): {database: D1Database; captures: Captured[]} {
  const captures: Captured[] = [];
  const observed = new Proxy(database, {get(target, property) {
    if (property !== "prepare") {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql: string) => {
      const relevant = sql.includes("retained_v12_chunks AS MATERIALIZED");
      const wrap = (statement: D1PreparedStatement, values: readonly unknown[] = []): D1PreparedStatement =>
        new Proxy(statement, {get(inner, method) {
          if (method === "bind") return (...bound: unknown[]) => wrap(inner.bind(...bound), bound);
          if (method === "all") return async () => {
            const result = await inner.all();
            if (relevant) captures.push({sql, values,
              rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written});
            return result;
          };
          const value = Reflect.get(inner, method);
          return typeof value === "function" ? value.bind(inner) : value;
        }});
      return wrap(target.prepare(sql));
    };
  }});
  return {database: observed, captures};
}

function hex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function jsonWithBlobs(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => current instanceof ArrayBuffer
    ? {blob: hex(new Uint8Array(current))}
    : current instanceof Uint8Array ? {blob: hex(current)} : current);
}
const dataTables = [
  "participants", "telemetry_v12_device_capabilities", "accountless_v12_device_authorizations",
  "storage_v11_owner_links", "storage_owner_revisions", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
  "telemetry_v12_records", "storage_effective_source_days", "telemetry_v12_runtime",
] as const;
const FINGERPRINT_PAGE_ROWS = 256;
async function relevantSourceFingerprint(): Promise<{
  digest: string; rowsRead: number;
  counts: readonly {table: string; rows: number; pages: number}[];
}> {
  let rowsRead = 0;
  const schema = await source().prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type,name`).all();
  rowsRead += schema.meta.rows_read;
  // Keep only a bounded page at once. The 512-chunk case has over 100,000
  // physical record rows; no full record array or concatenated JSON is held.
  const tables: {table: string; rows: number; pages: {
    rows: number; firstKey: string | null; lastKey: string | null; digest: string;
  }[]}[] = [];
  for (const table of dataTables) {
    const info = await source().prepare(`PRAGMA table_info(${table})`).all<{
      name: string; type: string; pk: number;
    }>();
    rowsRead += info.meta.rows_read;
    expect(info.results.length).toBeGreaterThan(0);
    const primary = info.results.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk);
    expect(primary.every(row => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.name))).toBe(true);
    const order = primary.length ? primary.map(row => `"${row.name}"`).join(",") : "rowid";
    const pages: {rows: number; firstKey: string | null; lastKey: string | null;
      digest: string}[] = [];
    const integerId = primary.length === 1 && primary[0]!.name === "id"
      && info.results.find(row => row.name === "id")?.type.toUpperCase() === "INTEGER";
    let lastId = 0;
    let totalRows = 0;
    for (let offset = 0; ; offset += FINGERPRINT_PAGE_ROWS) {
      expect(offset).toBeLessThan(2_000_000);
      const result = integerId
        ? await source().prepare(`SELECT * FROM ${table} WHERE id>? ORDER BY id LIMIT ${FINGERPRINT_PAGE_ROWS}`)
          .bind(lastId).all<Record<string, unknown>>()
        : await source().prepare(`SELECT ${primary.length ? "*" : "rowid AS __rowid,*"}
            FROM ${table} ORDER BY ${order} LIMIT ${FINGERPRINT_PAGE_ROWS} OFFSET ?`)
          .bind(offset).all<Record<string, unknown>>();
      rowsRead += result.meta.rows_read;
      totalRows += result.results.length;
      const key = (row: Record<string, unknown>) => primary.length
        ? primary.map(column => row[column.name]) : [row.__rowid];
      const first = result.results[0], last = result.results.at(-1);
      pages.push({rows: result.results.length,
        firstKey: first ? await sha256Hex(jsonWithBlobs(key(first))) : null,
        lastKey: last ? await sha256Hex(jsonWithBlobs(key(last))) : null,
        digest: await sha256Hex(jsonWithBlobs(result.results))});
      if (integerId && result.results.length) {
        const value = last?.id;
        expect(typeof value).toBe("number");
        expect(value as number).toBeGreaterThan(lastId);
        lastId = value as number;
      }
      if (result.results.length < FINGERPRINT_PAGE_ROWS) break;
    }
    tables.push({table, rows: totalRows, pages});
  }
  return {digest: await sha256Hex(jsonWithBlobs({schema: schema.results, tables})), rowsRead,
    counts: tables.map(({table, rows, pages}) => ({table, rows, pages: pages.length}))};
}

async function queryPlan(capture: Captured): Promise<{details: string[]; rowsRead: number}> {
  const explained = await source().prepare(`EXPLAIN QUERY PLAN ${capture.sql}`)
    .bind(...capture.values).all<{detail: string}>();
  return {details: explained.results.map(row => row.detail), rowsRead: explained.meta.rows_read};
}

async function readMeasured(owner: Owner) {
  const singleton = observeDependency(source());
  const exact = await effectiveHistoryDependency(singleton.database, owner, namespace,
    firstDay, firstDay, {includeSessions: false});
  expect(singleton.captures).toHaveLength(1);
  expect(singleton.captures[0]!.sql).not.toContain("/* batched occurrence links */");
  const batched = observeDependency(source());
  const reader = await createEffectiveHistoryDayDependencyReader(batched.database,
    owner, namespace, days, {occurrenceLinks: "batched"});
  expect(reader).toBeDefined();
  const digests: string[] = [];
  for (const day of days) {
    const digest = await reader!.readDigest(day);
    expect(typeof digest).toBe("string");
    digests.push(digest!);
  }
  expect(batched.captures).toHaveLength(1);
  expect(batched.captures[0]!.sql).toContain("/* batched occurrence links */");
  expect(digests[0]).toBe(await sha256Hex(canonicalJson(exact)));
  const plans = await Promise.all([singleton.captures[0]!, batched.captures[0]!].map(queryPlan));
  for (const [index, plan] of plans.entries()) {
    // Retain the literal physical plan and charged read count even if the
    // indexed-access regression below refuses this current source shape.
    console.log("v12-dependency-query-plan", JSON.stringify({
      mode: index === 0 ? "singleton" : "batched16",
      rowsRead: index === 0 ? singleton.captures[0]!.rowsRead : batched.captures[0]!.rowsRead,
      planRowsRead: plan.rowsRead, details: plan.details,
    }));
    expect(plan.details.some(detail => detail.includes("telemetry_v12_records"))).toBe(true);
    expect(plan.details.some(detail => /(?:SEARCH|SCAN) (?:r|v12_record|complete)\b/u.test(detail)))
      .toBe(true);
  }
  return {exactDigest: await sha256Hex(canonicalJson(exact)),
    links: exact.occurrenceLinks, digests,
    captures: [singleton.captures[0]!, batched.captures[0]!] as const, plans};
}

it("records no-statistics and local ANALYZE plans for native dense v1.2 dependency links", async ({annotate}) => {
  expect(MAX_TELEMETRY_V12_DAY_CHUNKS).toBeGreaterThanOrEqual(512);
  expect(MAX_TELEMETRY_V12_CHUNK_RECORDS).toBe(200);
  await reset();
  for (const migrations of [bindings.TEST_MIGRATIONS, bindings.TEST_TYPED_INGESTION_MIGRATIONS,
    bindings.TEST_INGESTION_BRIDGE_MIGRATIONS, bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS, bindings.TEST_INGESTION_ISOLATION_MIGRATIONS])
    await applyD1Migrations(source(), migrations);
  await initializeStorageSource(source(), namespace);
  await initializeTypedV1Admission(source(), namespace);
  await initializeTypedV11Admission(source(), namespace);
  await drainCommunityPublicSourceBootstrap(source());
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
    .bind(new Date().toISOString()).run();
  expect((await source().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'")
    .first<{n: number}>())!.n).toBe(0);

  const admissionStarted = performance.now();
  const participants: string[] = [];
  const activeDevices: string[] = [];
  const selectedIds = densities.map((_density, ordinal) =>
    occurrence(ordinal === 0 ? 1 : 1_000_000 * (ordinal + 1)));
  for (const [ordinal, chunkCount] of densities.entries()) {
    const device = await createV11DeviceFixture(source());
    participants.push(device.participantId);
    activeDevices.push(device.deviceId);
    await grantTelemetryV12Consent(source(), device, telemetryV12RequiredConsent(), Date.now());
    await attachOwner(device.participantId, ordinal);
    const selected = await stageDay(device, await preparedDay(firstDay, 1,
      ordinal === 0 ? 1 : 1_000_000 * (ordinal + 1)));
    const outside = await stageDay(device, await preparedDay(outsideDay, chunkCount,
      10_000_000 * (ordinal + 1), selectedIds[ordinal], ordinal === 1 ? selectedIds[0] : undefined));
    await activate(device, [selected, outside]);
  }
  const partial = await createV11DeviceFixture(source(), {participantId: participants[3]!});
  await grantTelemetryV12Consent(source(), partial, telemetryV12RequiredConsent(), Date.now());
  const incomplete = await preparedDay(outsideDay, 2, 90_000_000, selectedIds[3]);
  await stageDay(partial, incomplete, 1);
  expect((await source().prepare(`SELECT state FROM telemetry_v12_day_manifests
    WHERE participant_id=? AND device_id=? AND chunk_day=?`)
    .bind(partial.participantId, partial.deviceId, outsideDay)
    .first<string>("state"))).toBe("staged");
  const admissionWallMs = performance.now() - admissionStarted;
  const activeChunkKeys: string[] = [];
  for (const [index, participantId] of participants.entries()) {
    const key = await source().prepare(`SELECT id FROM telemetry_v12_chunks
      WHERE participant_id=? AND device_id=? AND chunk_day=? AND stream='quota' AND chunk_seq=0`)
      .bind(participantId, activeDevices[index], outsideDay).first<string>("id");
    expect(typeof key).toBe("string");
    activeChunkKeys.push(key!);
  }
  const stagedChunkKey = await source().prepare(`SELECT id FROM telemetry_v12_chunks
    WHERE participant_id=? AND device_id=? AND chunk_day=? AND stream='quota' AND chunk_seq=0`)
    .bind(partial.participantId, partial.deviceId, outsideDay).first<string>("id");
  expect(typeof stagedChunkKey).toBe("string");
  const owners = await readStorageCommunityOwnerPage(source());
  const selectedOwners = participants.map(id => {
    const owner = owners.find(row => row.participantId === id);
    expect(owner?.hasV12).toBe(true);
    return owner!;
  });
  const beforeFingerprint = await relevantSourceFingerprint();
  const before: Awaited<ReturnType<typeof readMeasured>>[] = [];
  for (const owner of selectedOwners) before.push(await readMeasured(owner));
  for (const [index, row] of before.entries()) {
    expect(row.links).toHaveLength(1);
    expect(row.links[0]).toEqual(expect.objectContaining({family: "v12",
      source_day: outsideDay, source_key: activeChunkKeys[index]}));
    expect(row.links.every(link => link.source_key !== stagedChunkKey)).toBe(true);
    expect(row.captures.every(capture => capture.rowsWritten === 0)).toBe(true);
  }
  const analyzeStarted = performance.now();
  const analyzed = await source().prepare("ANALYZE").run();
  const analyzeWallMs = performance.now() - analyzeStarted;
  expect((await source().prepare("SELECT count(*) AS n FROM sqlite_stat1")
    .first<{n: number}>())!.n).toBeGreaterThan(0);
  const afterFingerprint = await relevantSourceFingerprint();
  expect(afterFingerprint.counts).toEqual(beforeFingerprint.counts);
  expect(afterFingerprint.digest).toBe(beforeFingerprint.digest);
  const after: Awaited<ReturnType<typeof readMeasured>>[] = [];
  for (const owner of selectedOwners) after.push(await readMeasured(owner));
  for (const [index, row] of after.entries()) {
    expect(row.exactDigest).toBe(before[index]!.exactDigest);
    expect(row.links).toEqual(before[index]!.links);
    expect(row.digests).toEqual(before[index]!.digests);
    for (const [kind, capture] of row.captures.entries()) {
      const original = before[index]!.captures[kind]!;
      expect(capture.sql).toBe(original.sql);
      expect(jsonWithBlobs(capture.values)).toBe(jsonWithBlobs(original.values));
      expect(capture.rowsWritten).toBe(0);
    }
  }
  const concise = (value: Awaited<ReturnType<typeof readMeasured>>) => value.captures.map((capture, index) => ({
    mode: index === 0 ? "singleton" : "batched16", rowsRead: capture.rowsRead,
    rowsWritten: capture.rowsWritten, resultRows: index === 0 ? value.links.length : value.digests.length,
    planRowsRead: value.plans[index]!.rowsRead,
    v12RecordAccess: value.plans[index]!.details.filter(detail =>
      detail.includes("telemetry_v12_records")),
    plan: value.plans[index]!.details,
  }));
  const report = {schemaVersion: "synthetic-v12-dependency-plan-v1", admission: {
    acceptedChunks: densities.reduce((sum, value) => sum + value + 1, 0),
    acceptedRecords: densities.reduce((sum, value) => sum + (value + 1) * 200, 0),
    stagedIncompletePhysicalChunks: 1, stagedIncompleteRecords: 200,
    wallMs: admissionWallMs,
  }, fingerprint: {before: beforeFingerprint, after: afterFingerprint},
  analyze: {rowsRead: analyzed.meta.rows_read, rowsWritten: analyzed.meta.rows_written,
    wallMs: analyzeWallMs},
  density: densities.map((chunks, index) => ({chunks,
    digest: before[index]!.exactDigest, all16Digests: before[index]!.digests,
    crossDayLinkCount: before[index]!.links.length,
    foreignAndStagedExcluded: before[index]!.links[0]?.source_key === activeChunkKeys[index]
      && before[index]!.links.every(link => link.source_key !== stagedChunkKey),
    noStatistics: concise(before[index]!), analyzed: concise(after[index]!)}))};
  await annotate(JSON.stringify(report), "v12-dependency-native-planner-reference");
  console.log("v12-dependency-native-planner-reference", JSON.stringify(report));
  // A 16-day dependency query has fixed acquisition work, but each admitted
  // v1.2 chunk contains at most 200 records. Allow generous indexed proof
  // overhead per record without allowing a chunk-by-chunk day-record scan.
  for (const [index, chunks] of densities.entries()) {
    const indexedReadCeiling = 600_000 + 20 * (chunks + 1) * MAX_TELEMETRY_V12_CHUNK_RECORDS;
    for (const capture of after[index]!.captures)
      expect(capture.rowsRead).toBeLessThanOrEqual(indexedReadCeiling);
    for (const capture of before[index]!.captures)
      expect(capture.rowsRead).toBeLessThanOrEqual(indexedReadCeiling);
  }
}, 600_000);
