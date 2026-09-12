import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent,
  type TelemetryV11DomainManifest, type TelemetryV11QuotaObservation, type TelemetryV11SessionDimension,
  type TelemetryV11Record, type TelemetryV11Stream } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { grantTelemetryV11Consent } from "../src/telemetry-transport-policy";
import { insertTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { readLegacyTelemetryCopyPage } from "../src/typed-telemetry-copy";
import { prepareTypedV1PreservationProofs } from "../src/typed-v1-preservation-proof";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

const b = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const db = () => b.USAGE_MONITOR_DB;
const namespace = "synthetic-original-ingestion";
const today = () => new Date().toISOString().slice(0, 10);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type PreparedDay = Awaited<ReturnType<typeof makeV11Day>>;
type StagedDay = Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;
const compatibility = { code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(db(), namespace);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
  // This fixture qualifies v11 only; v1 classification requires its own admission schema.
  await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^(0001|0002)_/.test(m.name)));
});

async function stage(fixture: Fixture, prepared: PreparedDay): Promise<StagedDay> {
  await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-envelope:${crypto.randomUUID()}`);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(db(), fixture, chunk, { sourceNamespace: namespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  }
  return registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
}
async function domain(fixture: Fixture, days: StagedDay[]): Promise<TelemetryV11DomainManifest> {
  const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
  const ordered = [...days].sort((a, c) => a.day.localeCompare(c.day));
  const value: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: ordered.map(day => ({ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  value.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(value));
  return value;
}
async function activate(fixture: Fixture, prepared: PreparedDay) {
  const day = await stage(fixture, prepared);
  return activateTelemetryV11Domain(db(), fixture, await domain(fixture, [day]));
}
function quota(usedPercent: number | null = 12.345678901234567): TelemetryV11QuotaObservation {
  return { schemaVersion: "quota-observation-v1.1", observationId: `quota-occurrence:v1:${"b".repeat(64)}`,
    observedTime: `${today()}T12:05:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
    limitId: "codex", slot: "seven_day", usedPercent, windowDurationMinutes: 10080,
    resetsAt: `${today()}T23:00:00.000Z`, accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null } };
}
function session(tools: Record<string, number> = { shell: 2, browser: 1 }): TelemetryV11SessionDimension {
  return { schemaVersion: "session-dimension-v1.1", sessionUuid: "session:synthetic-closure",
    firstEventTime: `${today()}T12:05:00.000Z`, provider: "openai_codex", toolClassCounts: tools };
}
async function legacy(fixture: Fixture, stream: TelemetryV11Stream, record: TelemetryV11Record) {
  const projected = telemetryV11LegacyProjection(stream, record);
  if (!projected) throw new Error("synthetic legacy counterpart required");
  const records = [JSON.parse(projected.canonicalRecord)];
  const envelopeDigest = await sha256Hex(`synthetic-legacy:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `${stream}:${today()}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  await insertTelemetryV1Chunk(db(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/legacy-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null });
}
async function enable(fixture: Fixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}

const stamp=()=>db().prepare('SELECT m.mutation_epoch,m.graph_invalidation_epoch,s.authority_epoch FROM community_snapshot_mutation_control m CROSS JOIN storage_source_state s').first<{mutation_epoch:number;graph_invalidation_epoch:number;authority_epoch:number}>();
const last=()=>db().prepare('SELECT kind FROM storage_ingestion_changes ORDER BY sequence DESC LIMIT 1').first<string>('kind');
describe('bounded isolated v11 append classification',()=>{
 it('keeps active and journal-retained proof deletion guarded through the compact compatibility view',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true}),record=v11UsageRecord(today(),'a');
  await activate(fixture,await makeV11Day(today(),{usage:[record]}));
  const oldId=await db().prepare('SELECT min(typed_record_id) id FROM typed_v11_record_admissions').first<number>('id');
  await expect(db().prepare('DELETE FROM typed_v11_record_admissions WHERE typed_record_id=?').bind(oldId).run()).rejects.toThrow(/telemetry_domain_active|storage_v11_source_retained/);
  await activate(fixture,await makeV11Day(today(),{usage:[record,v11UsageRecord(today(),'b')]}));
  await expect(db().prepare('DELETE FROM typed_v11_record_admissions WHERE typed_record_id=?').bind(oldId).run()).rejects.toThrow('storage_v11_source_retained');
  await db().prepare('DELETE FROM participants WHERE id=?').bind(fixture.participantId).run();
  for(const table of ['typed_v11_record_proofs','typed_v11_record_admissions','typed_v11_manifest_memberships','typed_telemetry_records'])
   expect(await db().prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
 });

 it('scopes append proof to the replaced owner with another active owner on the same day',async()=>{
  const owners=[await createV11DeviceFixture(db(),{grant:true}),await createV11DeviceFixture(db(),{grant:true})];
  const records=[v11UsageRecord(today(),'a'),v11UsageRecord(today(),'b')];
  for(let i=0;i<2;i++)await activate(owners[i]!,await makeV11Day(today(),{usage:[records[i]!]}));
  const before=await stamp();
  await activate(owners[0]!,await makeV11Day(today(),{usage:[records[0]!,v11UsageRecord(today(),'c')]}));
  expect(await last()).toBe('source-updated');
  expect(await stamp()).toMatchObject({authority_epoch:before!.authority_epoch,graph_invalidation_epoch:before!.graph_invalidation_epoch});
  expect(await db().prepare('SELECT is_append,compared_records FROM storage_v11_append_transitions WHERE participant_id=?')
   .bind(owners[0]!.participantId).first()).toEqual({is_append:1,compared_records:1});
  const refined={...records[1]!,accountPlanAttribution:{accountBasis:'same_source' as const,accountTrackId:`account-track:v2:${'d'.repeat(64)}`,
   planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null}};
  await activate(owners[1]!,await makeV11Day(today(),{usage:[refined]}));
  expect(await last()).toBe('owner-active');
  expect((await stamp())!.authority_epoch).toBe(before!.authority_epoch+1);
  expect(await db().prepare('SELECT is_append,compared_records FROM storage_v11_append_transitions WHERE participant_id=?')
   .bind(owners[1]!.participantId).first()).toEqual({is_append:0,compared_records:1});
 });

 it('keeps hard epochs across actual empty-day and same-day appends while preserving exact old records',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true}),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const old=await stage(fixture,await makeV11Day(yesterday,{usage:[v11UsageRecord(yesterday)]}));
  const empty=await stage(fixture,await makeV11Day(today(),{}));
  await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[old,empty]));const before=await stamp();
  const current=await stage(fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today(),'b')]}));
  await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[old,current]));
  expect(await last()).toBe('source-updated');expect(await stamp()).toMatchObject({graph_invalidation_epoch:before!.graph_invalidation_epoch,authority_epoch:before!.authority_epoch});
  const appended=await stage(fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today(),'b'),v11UsageRecord(today(),'c')]}));
  await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[old,appended]));
  expect(await last()).toBe('source-updated');expect(await stamp()).toMatchObject({graph_invalidation_epoch:before!.graph_invalidation_epoch,authority_epoch:before!.authority_epoch});
  expect(await db().prepare('SELECT max(compared_records) n FROM storage_v11_append_transitions').first('n')).toBe(1);
 });
 it('hard-invalidates attribution-only corrections despite identical base proof',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true}),usage=v11UsageRecord(today());
  await activate(fixture,await makeV11Day(today(),{usage:[usage]}));const before=await stamp();
  const refined={...usage,accountPlanAttribution:{accountBasis:'same_source' as const,accountTrackId:`account-track:v2:${'c'.repeat(64)}`,planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null}};
  await activate(fixture,await makeV11Day(today(),{usage:[refined]}));expect(await last()).toBe('owner-active');
  const after=await stamp();expect(after!.graph_invalidation_epoch).toBeGreaterThan(before!.graph_invalidation_epoch);expect(after!.authority_epoch).toBe(before!.authority_epoch+1);
 });
 it('uses unchanged chunk metadata to avoid rescanning a large retained day',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true});
  const records=Array.from({length:401},(_,i)=>v11UsageRecord(today(),'a',{eventId:`event:v2:${i.toString(16).padStart(64,'0')}`}));
  await activate(fixture,await makeV11Day(today(),{usage:records}));const before=await stamp();
  await activate(fixture,await makeV11Day(today(),{usage:[...records,v11UsageRecord(today(),'f')]}));
  expect(await last()).toBe('source-updated');expect(await stamp()).toMatchObject({authority_epoch:before!.authority_epoch,graph_invalidation_epoch:before!.graph_invalidation_epoch});
  expect(await db().prepare('SELECT compared_records FROM storage_v11_append_transitions').first('compared_records')).toBe(1);
 });
 it('conservatively hard-invalidates more than200 unmatched rows, even when repacking is lossless',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true});
  const records=Array.from({length:201},(_,i)=>v11UsageRecord(today(),'a',{eventId:`event:v2:${i.toString(16).padStart(64,'0')}`}));
  await activate(fixture,await makeV11Day(today(),{usage:records}));const before=await stamp();
  await activate(fixture,await makeV11Day(today(),{usage:[...records].reverse()}));
  expect(await last()).toBe('owner-active');expect((await stamp())!.authority_epoch).toBe(before!.authority_epoch+1);
  expect(await db().prepare('SELECT compared_records FROM storage_v11_append_transitions').first('compared_records')).toBe(201);
 });
 it('hard-invalidates changed parser metadata without claiming a canonical row correction',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true}),usage=v11UsageRecord(today());
  await activate(fixture,await makeV11Day(today(),{usage:[usage]}));const before=await stamp();
  await activate(fixture,await makeV11Day(today(),{usage:[usage]},'synthetic-v11-new'));
  expect(await last()).toBe('owner-active');expect((await stamp())!.graph_invalidation_epoch).toBeGreaterThan(before!.graph_invalidation_epoch);
 });
 it('never treats missing old evidence as append and leaves failed activation unchanged',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true});await activate(fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today())]}));const before=await stamp();
  const empty=await stage(fixture,await makeV11Day(today(),{}));
  await expect(activateTelemetryV11Domain(db(),fixture,await domain(fixture,[empty]))).rejects.toMatchObject(compatibility);
  expect(await stamp()).toEqual(before);expect(await db().prepare('SELECT count(*) n FROM storage_v11_append_transitions').first('n')).toBe(0);
 });
});
