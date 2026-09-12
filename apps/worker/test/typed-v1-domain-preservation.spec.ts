import { advanceV1DailyProjection,readV1ProjectedChunkPage } from '../src/v1-daily-projection';
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
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

const b = env as Env & { STORAGE_ANALYTICS_DB:D1Database; TEST_ANALYTICS_MIGRATIONS:D1Migration[]; TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
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
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS.filter(m=>m.name!=='0002_typed_v1_domain_preservation.sql'));
  await initializeTypedV11Admission(db(), namespace);
  await initializeTypedV1Admission(db(), namespace);
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
  await insertTypedTelemetryV1Chunk(db(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/legacy-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null },namespace);
}
async function enable(fixture: Fixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}

const qualify=()=>applyD1Migrations(db(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
describe('typed v1 to v1.1 same-source preservation',()=>{
 it('refuses before the forward migration, then preserves all streams and attribution-only refinement',async()=>{
  const f=await createV11DeviceFixture(db());
  const u=v11UsageRecord(today());const q=quota(0.30000000000000004);const ss=session({shell:0,other:3});
  for(const [stream,record] of [['usage',u],['quota',q],['session',ss]] as const)await legacy(f,stream,record);
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
  for(let i=0;i<3;i++)await advanceV1DailyProjection({source:db(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace});
  const ownerDigest=(await db().prepare('SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?').bind(f.participantId).first<string>('owner_digest'))!;
  const projected=()=>readV1ProjectedChunkPage({source:db(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace,ownerDigest,day:today()});
  expect((await projected())!.totalChunks).toBe(3);
  await enable(f);
  const attribution={accountBasis:'same_source' as const,accountTrackId:`account-track:v2:${'c'.repeat(64)}`,planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};
  const candidate=await stage(f,await makeV11Day(today(),{usage:[{...u,accountPlanAttribution:attribution}],quota:[{...q,accountPlanAttribution:attribution}],session:[ss]}));
  const manifest=await domain(f,[candidate]);
  await expect(activateTelemetryV11Domain(db(),f,manifest)).rejects.toMatchObject(compatibility);
  await qualify();
  const result=await activateTelemetryV11Domain(db(),f,manifest);
  expect(result.replay).toBe(false);
  expect(await projected()).toBeNull();
  expect((await activateTelemetryV11Domain(db(),f,manifest)).replay).toBe(true);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_v1_records').first('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM typed_v1_record_admissions').first('n')).toBe(3);
  expect(await db().prepare('SELECT count(*) n FROM typed_v11_record_admissions').first('n')).toBe(3);
 });
 it.each(['float','null','tools','missing','occurrence'])('refuses changed %s evidence with no activated head',async kind=>{
  await qualify();const f=await createV11DeviceFixture(db());
  const q=quota(0.30000000000000004);const ss=session({shell:0,other:3});
  const u=v11UsageRecord(today());if(kind==='null')u.components.outputReasoningTokens=null;
  await legacy(f,'quota',q);await legacy(f,'session',ss);await legacy(f,'usage',u);await enable(f);
  const candidate=await stage(f,await makeV11Day(today(),{
   quota:kind==='missing'?[]:[{...q,usedPercent:kind==='float'?0.3:q.usedPercent}],
   usage:[{...u,eventId:kind==='occurrence'?`event:v2:${'d'.repeat(64)}`:u.eventId,components:{...u.components,outputReasoningTokens:kind==='null'?0:u.components.outputReasoningTokens}}],
   session:[kind==='tools'?session({shell:0,other:4}):ss]
  }));
  await expect(activateTelemetryV11Domain(db(),f,await domain(f,[candidate]))).rejects.toMatchObject(compatibility);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_domain_heads').first('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM typed_v1_record_admissions').first('n')).toBe(3);
 });
 it('uses the same elected current device and never substitutes a losing device digest',async()=>{
  await qualify();const old=await createV11DeviceFixture(db());await legacy(old,'quota',quota(12));
  await db().prepare("UPDATE telemetry_v1_chunks SET created_at=? WHERE participant_id=?")
   .bind(`${today()}T00:00:00.000Z`,old.participantId).run();
  const current=await createV11DeviceFixture(db(),{participantId:old.participantId});
  await legacy(current,'quota',quota(14));await enable(current);
  const wrong=await stage(current,await makeV11Day(today(),{quota:[quota(12)]}));
  await expect(activateTelemetryV11Domain(db(),current,await domain(current,[wrong]))).rejects.toMatchObject(compatibility);
  const accepted=await activate(current,await makeV11Day(today(),{quota:[quota(14)]}));
  expect(accepted.replay).toBe(false);
  expect(await db().prepare('SELECT count(*) n FROM typed_v1_record_admissions').first('n')).toBe(2);
 });
 it('retains the original header source pin and refuses a header source revision changed after preparation',async()=>{
  await qualify();const old=await createV11DeviceFixture(db());const q=quota();
  await legacy(old,'quota',q);
  const f=await createV11DeviceFixture(db(),{participantId:old.participantId});await enable(f);
  const candidate=await stage(f,await makeV11Day(today(),{quota:[q]}));const manifest=await domain(f,[candidate]);
  await db().prepare("UPDATE telemetry_v1_chunks SET parser_version=? WHERE participant_id=?").bind("synthetic-corrected-parser",old.participantId).run();
  await expect(activateTelemetryV11Domain(db(),f,manifest)).rejects.toMatchObject({code:'TELEMETRY_MANIFEST_CONFLICT'});
  expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_domain_heads').first('n')).toBe(0);
 });
});
