import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture } from './helpers/telemetry-v11';
import { currentTelemetryV1Chunk, type TelemetryV1ChunkInsert } from '../src/telemetry-v1-repository';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-repository';
import { parseTelemetryV1Chunk, type TelemetryV1Record } from '../src/telemetry-v1';
import { insertTypedTelemetryV1Chunk } from '../src/typed-v1-admission';
import { advanceStorageCommunityDaily, advanceNextStorageCommunityDaily, readPublishedStorageCommunityDaily, retireStorageCommunityDailyPage } from "../src/storage-community-daily";
import { captureStorageCommunityAuthority, storageCommunityAuthorityIsCurrent, readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeStorageSource, readIngestionChanges } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { advanceV11DailyProjection, readV11ProjectedOwnerDays, retireV11DailyProjectionPage } from "../src/v11-daily-projection";
import { revokeAccountlessEnrollment } from "../src/accountless-enrollment";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { readTypedV11ManifestPage, TYPED_V11_MANIFEST_PAGE_SQL } from "../src/typed-v11-record-reader";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass, advanceStorageAnalytics } from "../src/storage-analytics-runtime";
import { runStorageAnalyticsSchedule } from "../src/storage-analytics-worker";

interface Bindings extends Env { STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[] }
const b = env as Bindings, source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-typed-source", namespace = "synthetic-original-typed-source";
const sourceLayout = { kind: "typed-v11" as const, sourceNamespace: namespace };
const today = () => new Date().toISOString().slice(0, 10);
const runtime = () => ({ ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
const step = (db = target()) => advanceV11DailyProjection({ source: source(), target: db, sourceId, sourceLayout });
const read = (ownerDigest: string) => readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId,
  ownerDigest, fromDay: today(), throughDay: today() });
async function drain() {
  for (let n = 0; n < 20; n++) {
    const result = await step(), retired = await retireV11DailyProjectionPage(target(), sourceId);
    if (result.state === "idle" && retired.state === "idle") return;
  }
  throw new Error("synthetic drain limit");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(source(), namespace);
  await initializeTypedV1Admission(source(), namespace);
  await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
});

async function fixture(count = 1, overrides: (n: number)=>Partial<import("@app-usagemonitor/telemetry-contract").TelemetryV11UsageEvent> = ()=>({})) {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length); bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes), authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = "") => handleRequest(new Request(`https://typed.example.test${path}`, {
    method: "POST", headers: { origin: "https://typed.example.test", "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  }), runtime());
  expect((await request("/api/v1/accountless/enrollment", { schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" })).status).toBe(201);
  expect((await request("/api/v1/accountless/ownership", { schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }, authorization)).status).toBe(201);
  const participantId = (await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first<string>("participant_id"))!;
  const principal = { participantId, deviceId };
  const prepared = await makeV11Day(today(), { usage: Array.from({ length: count }, (_, n) =>
    v11UsageRecord(today(), "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}`, ...overrides(n) })) });
  const day = await registerTelemetryV11DayManifest(source(), principal, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const device = await authenticateDevice(source(), authorization);
    const upload = await createDeviceUploadAuthorization(source(), device, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(source(), principal, chunk, { sourceNamespace: namespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId });
  }
  const prior = await createTelemetryV11DomainPredecessor(source(), principal);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day.day, throughDay: day.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: [{ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest }], manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), principal, manifest);
  const event = (await readIngestionChanges(source(), sourceId, 0)).at(-1)!;
  return { participantId, deviceId, event, manifest };
}

const options=()=>({source:source(),target:target(),sourceId,sourceNamespace:namespace,day:today()});
const publish=()=>advanceStorageCommunityDaily(options());
const publicRead=()=>readPublishedStorageCommunityDaily({...options(),fromDay:today(),throughDay:today()});
async function ready(){
  for(let n=0;n<64;n++){if((await drainCommunityPublicSourceBootstrap(source())).completed)break;}
  for(let n=0;n<256;n++){if((await advanceStorageAnalytics(options())).state==='idle')return;}
  throw new Error('synthetic delivery drain limit');
}
function publicEnv(targetDb=target()){
  const configured=runtime();Reflect.set(configured,'TELEMETRY_STORAGE_MODE','typed');
  Reflect.set(configured,'TELEMETRY_STORAGE_NAMESPACE',namespace);Reflect.set(configured,'ANALYTICS_DB',targetDb);return configured;
}
const api=(configured=publicEnv())=>handleRequest(new Request(`https://typed.example.test/api/v1/community/daily?from=${today()}&to=${today()}`),configured);
function targetBatch(batch:D1Database['batch']):D1Database{return new Proxy(target(),{get(db,key){if(key==='batch')return batch;
  const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});}

async function seedV1(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1, fixture = undefined as Awaited<ReturnType<typeof createV11DeviceFixture>> | undefined, revision=1, seq=0) {
  fixture ??= await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(today(), 'a', { eventId: `event:v2:${(seq*200+i).toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${(seq*200+i).toString(16).padStart(64, '0')}`,
      observedTime: `${today()}T12:00:00.000Z`, provider: 'openai_codex', planType: 'pro', planVariant: 'unknown',
      limitId: 'codex', slot: 'secondary', usedPercent: 0.30000000000000004, windowDurationMinutes: 10080,
      resetsAt: `${today()}T13:00:00.000Z` }
    : { schemaVersion: 'session-dimension-v1.0', sessionUuid: '0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
      firstEventTime: `${today()}T12:00:00.000Z`, provider: 'openai_codex', toolClassCounts: { shell: 0, other: 3 } }) as TelemetryV1Record[];
  const envelopeDigest = await sha256Hex(`synthetic-proof-${crypto.randomUUID()}`);
  const auth = await authenticateDevice(source(), fixture.authorization);
  const uploaded = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${uploaded.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: 'application/json' });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: 'telemetry-contribution-v1.0', chunkId: `${stream}:${today()}:${seq}`,
    chunkRevision: revision, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: 'synthetic-proof-v1',
    consent: { telemetrySchemaVersion: 'telemetry-contribution-v1.0', fieldDictionaryVersion: 'telemetry-v1.0-registry-2026-08-07.1',
      privacyContractVersion: 'ongoing-privacy-safe-telemetry-v1.0' }, records });
  return { fixture, insert: { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/proof-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null } as TelemetryV1ChunkInsert };
}

describe('independent public daily publication',()=>{
  it('runs the real accountless projection and public route, keeping graph unavailable and IDs private',async()=>{
    const value=await fixture(203);await drainCommunityPublicSourceBootstrap(source());
    expect(await publish()).toMatchObject({state:'deferred',reason:'projection_pending'});
    expect((await publicRead()).rows).toEqual([]);await ready();
    expect(await publish()).toEqual({state:'published',ownersAdvanced:1});
    const response=await api();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    const text=await response.text(),body=JSON.parse(text);
    expect(body).toMatchObject({schemaVersion:'community-daily-read-v1.0',allowanceState:'updating',
      allowanceReadState:'temporarily_unavailable',days:[{revision:1,payload:{
        schemaVersion:'community-daily-aggregate-v1.0',immutableRevision:true,recomputesOnLateData:true,
        suppression:'none_daily_grain_by_owner_decision',totals:{contributingParticipants:1,contributingDevices:1,
          usageEvents:203,quotaObservations:0,sessionDimensions:0,inputUncachedTokens:20_300,
          inputCacheReadTokens:182_700,outputCombinedTokens:15_225},apiEquivalentSpend:{coverage:'complete',usageEvents:203}}}]});
    expect(body).not.toHaveProperty('allowanceBreakdowns');expect(body.days[0].payload).not.toHaveProperty('allowance');
    for(const id of [value.participantId,value.deviceId,value.event.ownerDigest,value.event.eventDigest,namespace,sourceId])expect(text).not.toContain(id);
    expect(await source().prepare('SELECT count(*) n FROM community_daily_aggregates').first('n')).toBe(0);
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_queue').first('n')).toBe(0);
    expect(await publish()).toEqual({state:'unchanged',ownersAdvanced:0});
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first('n')).toBe(1);
  });
  it('hides stale policy/control snapshots and preserves monotonic revisions after retirement',async()=>{
    await fixture();await ready();await publish();const before=await captureStorageCommunityAuthority(source());
    await source().prepare('UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1').run();
    expect(await storageCommunityAuthorityIsCurrent(source(),before)).toBe(false);expect((await publicRead()).rows).toEqual([]);
    await retireStorageCommunityDailyPage(options());
    expect(await publish()).toEqual({state:'published',ownersAdvanced:0});expect((await publicRead()).rows[0]!.revision).toBe(2);
    await source().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    expect((await api()).status).toBe(503);
    await source().prepare("UPDATE collection_controls SET publication_enabled=1,control_state='operational',revision=revision+1 WHERE singleton=1").run();
    expect((await publicRead()).rows).toEqual([]);expect((await publish()).state).toBe('published');
    expect((await publicRead()).rows[0]!.revision).toBe(3);
  });
  it('fences opt-out before delivery and publishes zero only after the surviving cohort is verified',async()=>{
    const value=await fixture();await ready();await publish();
    await revokeAccountlessEnrollment(source(),value.deviceId,'user_opt_out',Date.now());
    expect((await publicRead()).rows).toEqual([]);await ready();
    expect((await publish()).state).toBe('published');const rows=(await publicRead()).rows;
    expect(JSON.parse(rows[0]!.payload_json).totals).toMatchObject({contributingParticipants:0,contributingDevices:0,usageEvents:0});
    expect(JSON.parse(rows[0]!.payload_json).apiEquivalentSpend).toMatchObject({coverage:'complete',knownCostUsd:0});
  });
  it('acknowledges only an exact committed publication after response loss',async()=>{
    await fixture();await ready();let lost=false;
    const db=targetBatch(async <T>(statements:D1PreparedStatement[])=>{const result=await target().batch<T>(statements);
      // Owner writes use run; the first batch is a read, the second commits.
      if(result.some(r=>r.meta.changes>0)&&!lost){lost=true;throw new Error('synthetic lost response');}return result;});
    expect((await advanceStorageCommunityDaily({...options(),target:db})).state).toBe('published');expect(lost).toBe(true);
    expect((await publish()).state).toBe('unchanged');
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first('n')).toBe(1);
  });
  it('recreates a removed payload and refuses a failed repair of a corrupt same-cohort payload',async()=>{
    await fixture();await ready();await publish();
    await target().prepare('DELETE FROM analytics_community_daily_publications').run();
    expect((await publicRead()).rows).toEqual([]);
    expect((await publish()).state).toBe('published');
    expect((await publicRead()).rows[0]!.revision).toBe(2);
    // This synthetic corruption tests the receipt boundary, not admission of
    // malformed source evidence. Publication rows are immutable in ordinary use.
    await target().prepare('DROP TRIGGER analytics_community_daily_revision_immutable').run();
    await target().prepare('UPDATE analytics_community_daily_publications SET payload_sha256=?').bind('0'.repeat(64)).run();
    const blocked=targetBatch(async<T>(statements:D1PreparedStatement[])=>{
      if(statements.length===2)throw new Error('synthetic target write unavailable');
      return target().batch<T>(statements);
    });
    expect((await advanceStorageCommunityDaily({...options(),target:blocked})).state).toBe('deferred');
    expect((await publish()).state).toBe('published');
    expect((await publicRead()).rows[0]!.revision).toBe(3);
  });
  it('never falls back to the ingestion publication table when the analytics role is missing',async()=>{
    const configured=publicEnv();Reflect.set(configured,'ANALYTICS_DB',undefined);
    expect((await api(configured)).status).toBe(503);
    expect((await api(publicEnv(source()))).status).toBe(503);
  });
  it('resumes a v1 owner beyond fifty chunks and publishes all streams exactly once',async()=>{
    const first=await seedV1();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
    for(let n=1;n<51;n++){
      const next=await seedV1('usage',1,first.fixture,1,n);await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
    }
    const quota=await seedV1('quota',1,first.fixture),session=await seedV1('session',1,first.fixture);
    await insertTypedTelemetryV1Chunk(source(),quota.insert,namespace);await insertTypedTelemetryV1Chunk(source(),session.insert,namespace);
    await ready();
    expect(await advanceStorageCommunityDaily({...options(),maxOwners:1})).toMatchObject({state:'progress',ownersAdvanced:1});
    expect((await publicRead()).rows).toEqual([]);
    expect(await target().prepare('SELECT next_index FROM analytics_community_daily_owners').first('next_index')).toBe(50);
    expect((await advanceNextStorageCommunityDaily(options())).state).toBe('published');
    const payload=JSON.parse((await publicRead()).rows[0]!.payload_json);
    expect(payload.totals).toMatchObject({contributingParticipants:1,contributingDevices:1,
      usageEvents:51,quotaObservations:1,sessionDimensions:1,inputUncachedTokens:5100,outputCombinedTokens:3825});
    expect(payload.apiEquivalentSpend).toMatchObject({usageEvents:51,fullyPricedUsageEvents:51});
    expect((await advanceNextStorageCommunityDaily(options())).state).toBe('idle');
  });
  it('reuses unchanged owners after a correction without restarting their completed folds',async()=>{
    const a=await seedV1(),b=await seedV1();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
    await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);await ready();await publish();
    const before=(await target().prepare('SELECT owner_digest,progress_revision FROM analytics_community_daily_owners ORDER BY owner_digest').all()).results;
    const changed=await seedV1('usage',2,a.fixture,2);
    changed.insert.supersedes=await currentTelemetryV1Chunk(source(),a.fixture.participantId,a.fixture.deviceId,'usage',today(),0);
    await insertTypedTelemetryV1Chunk(source(),changed.insert,namespace);
    // A corrected existing source is a hard invalidation, not append-only freshness.
    expect((await publicRead()).rows).toEqual([]);
    await ready();expect(await publish()).toEqual({state:'published',ownersAdvanced:1});
    expect(JSON.parse((await publicRead()).rows[0]!.payload_json).totals.usageEvents).toBe(3);
    const after=(await target().prepare('SELECT owner_digest,progress_revision FROM analytics_community_daily_owners ORDER BY owner_digest').all()).results;
    expect(after.map((row,i)=>Number(row.progress_revision)-Number(before[i]!.progress_revision)).sort()).toEqual([0,1]);
  });
  it('keeps complete totals and unknown-price counts when more than a hundred model cells are displayed',async()=>{
    await fixture(101,n=>({modelId:`unknown-a-${String(n).padStart(3,'0')}`}));
    await fixture(101,n=>({modelId:`unknown-b-${String(n).padStart(3,'0')}`}));await ready();await publish();
    const payload=JSON.parse((await publicRead()).rows[0]!.payload_json);
    expect(payload.cellsTruncated).toBe(true);expect(payload.cells).toHaveLength(100);
    expect(payload.cells[0].modelId).toBe('unknown-a-000');expect(payload.cells[99].modelId).toBe('unknown-a-099');
    expect(payload.totals).toMatchObject({contributingParticipants:2,contributingDevices:2,usageEvents:202,inputUncachedTokens:20200});
    expect(payload.apiEquivalentSpend).toMatchObject({coverage:'unavailable',knownCostUsd:null,unpricedUsageEvents:202});
  });
  it('publishes full totals for one multi-chunk owner whose day exceeds the checkpoint model-cell page',async()=>{
    await fixture(401,n=>({modelId:`unknown-${String(n).padStart(3,'0')}`}));await ready();await publish();
    const payload=JSON.parse((await publicRead()).rows[0]!.payload_json);
    expect(payload.cellsTruncated).toBe(true);expect(payload.cells).toHaveLength(100);
    expect(payload.cells[0].modelId).toBe('unknown-000');expect(payload.cells[99].modelId).toBe('unknown-099');
    expect(payload.totals).toMatchObject({contributingParticipants:1,contributingDevices:1,usageEvents:401,
      inputUncachedTokens:40100,inputCacheReadTokens:360900,outputCombinedTokens:30075});
    expect(payload.apiEquivalentSpend).toMatchObject({coverage:'unavailable',knownCostUsd:null,unpricedUsageEvents:401});
    const summary=JSON.parse((await target().prepare('SELECT values_json FROM analytics_community_daily_owners').first<string>('values_json'))!);
    expect(summary.omitted.usageEvents).toBe(201);
    expect(await target().prepare('SELECT sum(record_count) n FROM analytics_v11_value_pages').first('n')).toBe(401);
  });
  it('uses combined zero rather than split output and preserves unknown input as a known subtotal',async()=>{
    await fixture(1,()=>({components:{inputUncachedTokens:null,inputCacheReadTokens:900,inputCacheWriteTokens:0,
      outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:0}}));await ready();await publish();
    const payload=JSON.parse((await publicRead()).rows[0]!.payload_json);
    expect(payload.totals).toMatchObject({inputUncachedTokens:0,inputCacheReadTokens:900,outputTextTokens:50,
      outputReasoningTokens:25,outputCombinedTokens:0});
    expect(payload.apiEquivalentSpend).toMatchObject({coverage:'partial',partiallyPricedUsageEvents:1});
  });
  it('hides a publication when opt-out races between source authorization and the target commit',async()=>{
    const value=await fixture();await ready();let raced=false;
    const db=targetBatch(async <T>(statements:D1PreparedStatement[])=>{
      // The first batch is read-only. Inject after it, before the builder's
      // authoritative recheck, so no stale cohort is allowed to commit.
      const result=await target().batch<T>(statements);
      if(!raced){raced=true;await revokeAccountlessEnrollment(source(),value.deviceId,'user_opt_out',Date.now());}
      return result;
    });
    expect(await advanceStorageCommunityDaily({...options(),target:db})).toMatchObject({state:'deferred',reason:'source_changed'});
    expect((await publicRead()).rows).toEqual([]);
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first('n')).toBe(0);
  });
  it('keeps the public route read-only and fails closed if revocation happens during the target read',async()=>{
    const value=await fixture();await ready();await publish();let raced=false;
    const db=new Proxy(target(),{get(original,key){
      if(key==='prepare')return (sql:string)=>{
        expect(sql).toMatch(/^\s*(SELECT|WITH)\b/i);
        const statement=original.prepare(sql);
        if(!sql.includes('SELECT p.*'))return statement;
        return new Proxy(statement,{get(s,member){
          if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{
            const bound=s.bind(...args);return new Proxy(bound,{get(b,k){
              if(k==='all')return async()=>{const result=await b.all();
                if(!raced){raced=true;await revokeAccountlessEnrollment(source(),value.deviceId,'user_opt_out',Date.now());}return result;};
              const v=Reflect.get(b,k);return typeof v==='function'?v.bind(b):v;}});};
          const v=Reflect.get(s,member);return typeof v==='function'?v.bind(s):v;}});
      };
      const v=Reflect.get(original,key);return typeof v==='function'?v.bind(original):v;
    }});
    expect((await api(publicEnv(db))).status).toBe(503);expect(raced).toBe(true);
  });
  it('removes derived owner data after the real independent-ledger erasure operation',async()=>{
    const value=await fixture();await ready();await publish();
    expect(await eraseParticipantAsOwner(runtime(),'e'.repeat(64),value.participantId)).toMatchObject({deleted:true});
    expect((await publicRead()).rows).toEqual([]);await ready();
    await retireStorageCommunityDailyPage(options());
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_owners').first('n')).toBe(0);
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first('n')).toBe(0);
    expect(await target().prepare('SELECT revision FROM analytics_community_daily_heads').first('revision')).toBe(1);
    expect((await publish()).state).toBe('published');expect((await publicRead()).rows[0]!.revision).toBe(2);
  });
  it('blocks late owner folds and old-authority publications after a prioritized terminal fence',async()=>{
    const value=await fixture();await ready();await publish();
    const owner=(await target().prepare('SELECT * FROM analytics_community_daily_owners').first<Record<string,unknown>>())!;
    const publication=(await target().prepare('SELECT * FROM analytics_community_daily_publications').first<Record<string,unknown>>())!;
    const cursor=await target().prepare('SELECT sequence FROM analytics_source_cursors').first('sequence');
    await eraseParticipantAsOwner(runtime(),'e'.repeat(64),value.participantId);
    const terminal=(await readIngestionChanges(source(),sourceId,0)).at(-1)!;expect(terminal.kind).toBe('owner-erased');
    await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
      .bind(sourceId,terminal.ownerDigest,terminal.eventDigest,terminal.sequence,terminal.revision,
        terminal.authorityEpoch,terminal.publicAuthorityEpoch).run();
    expect(await target().prepare('SELECT sequence FROM analytics_source_cursors').first('sequence')).toBe(cursor);
    await expect(target().prepare('UPDATE analytics_community_daily_owners SET next_index=next_index+1').run())
      .rejects.toThrow('analytics_daily_owner_erased');
    await source().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    await source().prepare('UPDATE community_public_source_bootstrap SET completed=0 WHERE singleton=1').run();
    await expect(publish()).rejects.toThrow('STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE');
    expect((await api()).status).toBe(503);
    await retireStorageCommunityDailyPage(options());
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_owners').first('n')).toBe(0);
    await expect(target().prepare(`INSERT INTO analytics_community_daily_owners (${Object.keys(owner).join(',')})
      VALUES(${Object.keys(owner).map(()=>'?').join(',')})`).bind(...Object.values(owner)).run())
      .rejects.toThrow('analytics_daily_owner_erased');
    const stale={...publication,revision:Number(publication.revision)+1};
    await expect(target().prepare(`INSERT INTO analytics_community_daily_publications (${Object.keys(stale).join(',')})
      VALUES(${Object.keys(stale).map(()=>'?').join(',')})`).bind(...Object.values(stale)).run())
      .rejects.toThrow('analytics_publication_authority_stale');
    await source().prepare("UPDATE collection_controls SET publication_enabled=1,control_state='operational',revision=revision+1 WHERE singleton=1").run();
    await source().prepare('UPDATE community_public_source_bootstrap SET completed=1 WHERE singleton=1').run();
    expect((await publish()).state).toBe('published');
    expect(JSON.parse((await publicRead()).rows[0]!.payload_json).totals.usageEvents).toBe(0);
  });
  it('uses indexed owner/day and latest-revision reads with no raw telemetry read on the public route',async()=>{
    await fixture();await ready();await publish();
    const captured:string[]=[];
    const db=new Proxy(target(),{get(original,key){if(key==='prepare')return(sql:string)=>{captured.push(sql);return original.prepare(sql);};
      const v=Reflect.get(original,key);return typeof v==='function'?v.bind(original):v;}});
    expect((await api(publicEnv(db))).status).toBe(200);
    const sql=captured.find(s=>s.includes('SELECT p.*'))!;
    const plan=JSON.stringify((await target().prepare('EXPLAIN QUERY PLAN '+sql).bind(sourceId,today(),today()).all()).results);
    expect(plan).toContain('SEARCH p USING PRIMARY KEY');expect(plan).toContain('SEARCH n USING PRIMARY KEY');
    expect(plan).not.toMatch(/SCAN (p|n)\b/);
    expect(captured.join('\n')).not.toMatch(/telemetry_(v1|v11)_records|typed_telemetry_records|community_analysis_work|INSERT|UPDATE|DELETE/i);
  });
});
