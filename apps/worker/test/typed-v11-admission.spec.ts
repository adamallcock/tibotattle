import { readTypedV11ManifestPage, TYPED_V11_MANIFEST_PAGE_SQL } from '../src/typed-v11-record-reader';
import { encodeTypedTelemetryId } from '../src/typed-telemetry-codec';
import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, type TelemetryV11QuotaObservation, type TelemetryV11SessionDimension } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeTypedV11Admission, persistTypedV11StagedChunk, type TypedV11ChunkMetadata } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { initializeStorageSource } from "../src/analytics-delivery";
import { readTypedTelemetryRowsByStorageIds } from "../src/typed-telemetry-compatibility";
import { sha256Hex } from "../src/crypto";
const b = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const db = () => b.USAGE_MONITOR_DB, namespace = "synthetic-original-admission";
const today = () => new Date().toISOString().slice(0, 10);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
async function setup() {
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-admission-journal");
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
}
beforeEach(async () => { await reset(); await setup(); });
async function metadata(fixture: Fixture): Promise<TypedV11ChunkMetadata> {
  const envelopeDigest = await sha256Hex(`synthetic:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  return { sourceNamespace: namespace, chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
    envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
}
async function prepared(count = 1) {
  const fixture = await createV11DeviceFixture(db(), { grant: true });
  const day = await makeV11Day(today(), { usage: Array.from({ length: count }, (_, n) =>
    v11UsageRecord(today(), "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) });
  const manifest = await registerTelemetryV11DayManifest(db(), fixture, day.manifest);
  return { fixture, day, manifest };
}
function batchDatabase(batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  return new Proxy(db(), { get(target, key) {
    if (key === "batch") return batch;
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}
const count = async (table: string) => db().prepare(`SELECT count(*) n FROM ${table}`).first<number>("n");
const nextId = async () => db().prepare("SELECT next_source_row_id FROM typed_v11_admission_state").first<number>("next_source_row_id");
function quota(value: number | null): TelemetryV11QuotaObservation {
  return { schemaVersion: "quota-observation-v1.1", observationId: `quota:synthetic-${value === null ? "null" : "number"}`,
    observedTime: `${today()}T12:00:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown", limitId: "codex",
    slot: "seven_day", usedPercent: value, windowDurationMinutes: value === null ? null : 10080,
    resetsAt: value === null ? null : `${today()}T23:00:00.000Z`, accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null } };
}
function session(): TelemetryV11SessionDimension {
  return { schemaVersion: "session-dimension-v1.1", sessionUuid: "session:synthetic-admission",
    firstEventTime: `${today()}T12:00:00.000Z`, provider: "openai_codex", toolClassCounts: { shell: 0, browser: 2 } };
}
describe("atomic typed v1.1 staged admission", () => {
  it.each(['current','legacy'] as const)('rejects a noncanonical %s codec alias and rolls the complete admission back',async kind=>{
    const {fixture,day}=await prepared(),meta=await metadata(fixture);
    const text=`event:v2:${'0'.repeat(64)}`;
    const rawAlias='00'+Array.from(new TextEncoder().encode(text),byte=>byte.toString(16).padStart(2,'0')).join('');
    let changed=false;
    const database=new Proxy(db(),{get(target,key){if(key==='prepare')return (sql:string)=>{
      if(sql.includes('INSERT INTO typed_v11_record_proofs')){changed=true;sql=kind==='current'
        ?sql.replace('r.occurrence_id,p.base_digest',`X'${rawAlias}',p.base_digest`)
        :sql.replace('p.base_digest,p.legacy_occurrence_id',`p.base_digest,X'${rawAlias}'`);}
      return target.prepare(sql);
    };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    await expect(persistTypedV11StagedChunk(database,fixture,day.chunks[0],meta)).rejects.toThrow();expect(changed).toBe(true);
    expect(await count('typed_v11_record_proofs')).toBe(0);expect(await count('typed_telemetry_records')).toBe(0);
    expect(await count('telemetry_v11_chunks')).toBe(0);expect(await nextId()).toBe(1);
    expect(await db().prepare('SELECT state FROM device_upload_authorizations WHERE id=?').bind(meta.deviceUploadAuthorizationId).first('state')).toBe('consuming');
  });

  it("stores compact proof references while preserving mixed-codec lexical keysets and scoped duplicates", async()=>{
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const occurrences=['event:Z0000000','event:a0000000',`event:v2:${'b'.repeat(64)}`,'a'.repeat(64),
      '0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b','event:unknown000'];
    const preparedDay=await makeV11Day(today(),{usage:occurrences.map(eventId=>v11UsageRecord(today(),'a',{eventId}))});
    const manifest=await registerTelemetryV11DayManifest(db(),fixture,preparedDay.manifest);
    for(const chunk of preparedDay.chunks)await persistTypedV11StagedChunk(db(),fixture,chunk,await metadata(fixture));
    const physical=(await db().prepare(`SELECT p.chunk_key,p.manifest_key,p.stream_code,p.occurrence_blob,p.occurrence_id,
      p.legacy_occurrence_blob,p.legacy_occurrence_id,typeof(p.chunk_key) key_type,typeof(p.occurrence_blob) blob_type
      FROM typed_v11_record_proofs p ORDER BY occurrence_id`).all<{
        chunk_key:number;manifest_key:number;stream_code:number;occurrence_blob:number[];occurrence_id:string;
        legacy_occurrence_blob:number[]|null;legacy_occurrence_id:string|null;key_type:string;blob_type:string}>()).results;
    expect(physical.map(row=>row.occurrence_id)).toEqual([...occurrences].sort());
    for(const row of physical){expect(row.key_type).toBe('integer');expect(row.blob_type).toBe('blob');
      expect(row.occurrence_blob).toEqual(Array.from(encodeTypedTelemetryId(row.occurrence_id)));
      if(row.legacy_occurrence_id)expect(row.legacy_occurrence_blob).toEqual(Array.from(encodeTypedTelemetryId(row.legacy_occurrence_id)));}
    expect(await db().prepare('SELECT count(*) n FROM typed_v11_manifest_memberships').first('n')).toBe(1);
    let afterStream='',afterOccurrence='';const read:string[]=[];
    for(let n=0;n<10;n++){
      const page=await readTypedV11ManifestPage(db(),{sourceNamespace:namespace,participantId:fixture.participantId,
        deviceId:fixture.deviceId,manifestId:manifest.manifestId,afterStream,afterOccurrence,limit:2});
      read.push(...page.map(row=>row.occurrence_id));if(page.length<2)break;
      afterStream=page.at(-1)!.stream;afterOccurrence=page.at(-1)!.occurrence_id;
    }
    expect(read).toEqual([...occurrences].sort());
    const plan=JSON.stringify((await db().prepare('EXPLAIN QUERY PLAN '+TYPED_V11_MANIFEST_PAGE_SQL)
      .bind(manifest.manifestId,'usage',read[0],2).all()).results);
    expect(plan).toContain('typed_v11_proof_manifest');expect(plan).not.toMatch(/SCAN p(?:"|\b)|USE TEMP B-TREE/);
    expect((await db().prepare("PRAGMA index_list('typed_v11_record_proofs')").all<{unique:number}>()).results.every(row=>row.unique===0)).toBe(true);
    await expect(db().prepare('UPDATE typed_v11_record_proofs SET chunk_key=chunk_key+1').run()).rejects.toThrow('typed_v11_record_proof_immutable');
    await expect(db().prepare('DELETE FROM typed_v11_manifest_memberships').run()).rejects.toThrow('typed_v11_manifest_membership_retained');
  });

  it("stores all streams exactly, seals subtype rows and preserves parent erasure", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const day = await makeV11Day(today(), { usage: [v11UsageRecord(today())], quota: [quota(99.99999999999999), quota(null)], session: [session()] });
    const manifest = await registerTelemetryV11DayManifest(db(), fixture, day.manifest);
    for (const chunk of day.chunks) {
      const meta = await metadata(fixture);
      expect(await persistTypedV11StagedChunk(db(), fixture, chunk, meta)).toMatchObject({ contributionId: meta.chunkRowId, replay: false });
      expect(await db().prepare("SELECT state FROM device_upload_authorizations WHERE id=?").bind(meta.deviceUploadAuthorizationId).first("state")).toBe("consumed");
    }
    expect(await count("telemetry_v11_records")).toBe(0); expect(await count("typed_v11_record_admissions")).toBe(4); expect(await nextId()).toBe(5);
    expect(await db().prepare("SELECT state FROM telemetry_v11_day_manifests WHERE id=?").bind(manifest.manifestId).first("state")).toBe("ready");
    const ids = (await db().prepare("SELECT id FROM typed_telemetry_records ORDER BY id").all<{ id: number }>()).results.map(r => r.id);
    const rows = await readTypedTelemetryRowsByStorageIds(db(), { sourceNamespace: namespace, participantId: fixture.participantId, storageRowIds: ids });
    expect(rows.map(r => r.record_json).sort()).toEqual(day.chunks.flatMap(c => c.records).map(r => canonicalTelemetryV11Json(r)).sort());
    for (const row of rows) {
      const record = row.record as unknown as Record<string, unknown>, base = { ...record }; delete base.accountPlanAttribution;
      const proof = await db().prepare("SELECT stream,lower(hex(base_digest)) base,legacy_occurrence_id,lower(hex(legacy_digest)) legacy FROM typed_v11_record_admissions WHERE occurrence_id=?")
        .bind(record.eventId ?? record.observationId ?? record.sessionUuid).first<{ stream: "usage" | "quota" | "session"; base: string; legacy_occurrence_id: string | null; legacy: string }>();
      expect(proof!.base).toBe(await sha256Hex(canonicalTelemetryV11Json(base)));
      const legacy = telemetryV11LegacyProjection(proof!.stream, row.record as never);
      expect(proof!.legacy_occurrence_id).toBe(legacy?.occurrenceId ?? null); expect(proof!.legacy).toBe(legacy ? await sha256Hex(legacy.canonicalRecord) : "");
    }
    for (const table of ["typed_telemetry_usage", "typed_telemetry_quota", "typed_telemetry_session_tools"])
      await expect(db().prepare(`DELETE FROM ${table}`).run()).rejects.toThrow("typed_v11_admitted_record_retained");
    await db().prepare("INSERT INTO typed_telemetry_dictionary(value) VALUES('other') ON CONFLICT DO NOTHING").run();
    await expect(db().prepare(`INSERT INTO typed_telemetry_session_tools(record_id,tool_class_id,count)
      SELECT r.id,d.id,1 FROM typed_telemetry_records r CROSS JOIN typed_telemetry_dictionary d WHERE r.stream=3 AND d.value='other'`).run()).rejects.toThrow("typed_v11_admitted_record_retained");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    for (const table of ["typed_telemetry_records", "typed_v11_record_admissions", "typed_telemetry_owners", "typed_telemetry_devices", "typed_telemetry_quota_dimensions", "typed_telemetry_attributions"])
      expect(await count(table)).toBe(0);
  });
  it("replays complete membership and reconciles a lost committed response", async () => {
    const { fixture, day } = await prepared(2), meta = await metadata(fixture);
    const lost = batchDatabase(async statements => { await db().batch(statements); throw new Error("synthetic lost response"); });
    expect(await persistTypedV11StagedChunk(lost, fixture, day.chunks[0], meta)).toMatchObject({ replay: true, contributionId: meta.chunkRowId });
    expect(await persistTypedV11StagedChunk(db(), fixture, day.chunks[0], meta)).toMatchObject({ replay: true });
    expect(await nextId()).toBe(3); expect(await count("telemetry_v11_chunks")).toBe(1); expect(await count("typed_v11_record_admissions")).toBe(2);
    await db().prepare("DELETE FROM typed_v11_record_admissions WHERE typed_record_id=(SELECT min(typed_record_id) FROM typed_v11_record_admissions)").run();
    await expect(persistTypedV11StagedChunk(db(), fixture, day.chunks[0], meta)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_INCOMPLETE" });
  });
  it("rolls back authorization, IDs, headers and records after a late transaction failure", async () => {
    const { fixture, day } = await prepared(), meta = await metadata(fixture);
    await db().prepare("CREATE TRIGGER synthetic_late_abort BEFORE INSERT ON typed_v11_record_proofs BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END").run();
    await expect(persistTypedV11StagedChunk(db(), fixture, day.chunks[0], meta)).rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
    for (const table of ["telemetry_v11_chunks", "typed_v11_chunk_allocations", "typed_v11_record_admissions", "typed_telemetry_records", "typed_v11_owner_memberships"])
      expect(await count(table)).toBe(0);
    expect(await nextId()).toBe(1);
    expect(await db().prepare("SELECT state FROM device_upload_authorizations WHERE id=?").bind(meta.deviceUploadAuthorizationId).first("state")).toBe("consuming");
    await db().prepare("DROP TRIGGER synthetic_late_abort").run();
    expect(await persistTypedV11StagedChunk(db(), fixture, day.chunks[0], meta)).toMatchObject({ replay: false });
  });
  it("aborts stale allocator ranges and accepts an ordinary retry without reused IDs", async () => {
    const { fixture, day } = await prepared(201), first = await metadata(fixture), second = await metadata(fixture);
    let release!: () => void; let calls = 0; const barrier = new Promise<void>(resolve => { release = resolve; });
    const concurrent = batchDatabase(async statements => { calls++; if (calls === 2) release(); await barrier; return db().batch(statements); });
    const outcomes = await Promise.allSettled([persistTypedV11StagedChunk(concurrent, fixture, day.chunks[0], first), persistTypedV11StagedChunk(concurrent, fixture, day.chunks[1], second)]);
    expect(outcomes.filter(v => v.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.findIndex(v => v.status === "rejected");
    expect((outcomes[loser] as PromiseRejectedResult).reason).toMatchObject({ code: "UPLOAD_IN_PROGRESS", status: 409 });
    const retry = [first, second][loser]!;
    expect(await db().prepare("SELECT state FROM device_upload_authorizations WHERE id=?").bind(retry.deviceUploadAuthorizationId).first("state")).toBe("consuming");
    expect(await persistTypedV11StagedChunk(db(), fixture, day.chunks[loser], retry)).toMatchObject({ replay: false });
    expect(await nextId()).toBe(202); expect(await count("typed_v11_record_admissions")).toBe(201);
    expect(await db().prepare("SELECT count(DISTINCT source_row_id) n FROM typed_telemetry_records").first("n")).toBe(201);
  });
  it("rechecks device authority inside the final transaction", async () => {
    const { fixture, day } = await prepared(), meta = await metadata(fixture);
    const revoked = batchDatabase(async statements => {
      await db().prepare("UPDATE device_credentials SET state='revoked',revoked_at=? WHERE id=?").bind(new Date().toISOString(), fixture.deviceId).run(); return db().batch(statements);
    });
    await expect(persistTypedV11StagedChunk(revoked, fixture, day.chunks[0], meta)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
    expect(await nextId()).toBe(1); expect(await count("typed_telemetry_records")).toBe(0); expect(await count("telemetry_v11_chunks")).toBe(0);
  });
  it("accepts 200 unique sessions and attributions within 900 statements", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const day = await makeV11Day(today(), { usage: Array.from({ length: 200 }, (_, n) => v11UsageRecord(today(), "a", {
      eventId: `event:v2:${n.toString(16).padStart(64, "0")}`, sessionUuid: crypto.randomUUID(),
      accountPlanAttribution: { accountBasis: "same_source", accountTrackId: `account-track:v2:${n.toString(16).padStart(64, "0")}`,
        planBasis: "same_source_occurrence", planType: "pro", planEraId: `plan-era:v1:${n.toString(16).padStart(64, "0")}` },
    })) });
    await registerTelemetryV11DayManifest(db(), fixture, day.manifest); let size = 0;
    const measured = batchDatabase(async statements => { size = statements.length; return db().batch(statements); });
    expect(await persistTypedV11StagedChunk(measured, fixture, day.chunks[0], await metadata(fixture))).toMatchObject({ replay: false });
    expect(size).toBeLessThanOrEqual(900); expect(size).toBeGreaterThan(800);
    expect(await count("typed_v11_record_admissions")).toBe(200); expect(await count("typed_telemetry_identifiers")).toBe(200); expect(await count("typed_telemetry_attributions")).toBe(200);
  });
  it("cleans staged rows before allocation cascade, then erases even empty owner dictionaries", async () => {
    const { fixture, day } = await prepared(), meta = await metadata(fixture);
    await persistTypedV11StagedChunk(db(), fixture, day.chunks[0], meta);
    await db().prepare("DELETE FROM telemetry_v11_chunks WHERE id=?").bind(meta.chunkRowId).run();
    for (const table of ["typed_v11_chunk_allocations", "typed_telemetry_chunks", "typed_telemetry_records", "typed_v11_record_admissions"]) expect(await count(table)).toBe(0);
    expect(await count("typed_v11_owner_memberships")).toBe(1); expect(await count("typed_telemetry_identifiers")).toBe(1);
    await expect(db().prepare("DELETE FROM typed_v11_owner_memberships").run()).rejects.toThrow("typed_v11_owner_membership_retained");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    for (const table of ["typed_v11_owner_memberships", "typed_telemetry_owners", "typed_telemetry_devices", "typed_telemetry_manifests", "typed_telemetry_identifiers", "typed_telemetry_attributions"]) expect(await count(table)).toBe(0);
    expect(await nextId()).toBe(2);
  });
  it("never resets allocated IDs, changes namespaces, or silently admits old v11 history", async () => {
    const { fixture, day } = await prepared(); await persistTypedV11StagedChunk(db(), fixture, day.chunks[0], await metadata(fixture));
    await initializeTypedV11Admission(db(), namespace); expect(await nextId()).toBe(2);
    await expect(initializeTypedV11Admission(db(), "synthetic-other")).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" }); expect(await nextId()).toBe(2);
    await reset(); await applyD1Migrations(db(), b.TEST_MIGRATIONS);
    const oldFixture = await createV11DeviceFixture(db(), { grant: true });
    await stageV11Day(db(), oldFixture, await makeV11Day(today(), { usage: [v11UsageRecord(today())] }));
    await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS); await initializeStorageSource(db(), "synthetic-old-source");
    await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS); await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await expect(initializeTypedV11Admission(db(), namespace)).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    expect(await count("telemetry_v11_records")).toBe(1); expect(await count("typed_v11_admission_state")).toBe(0);
  });
});
