import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageSource } from '../src/analytics-delivery';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { initializeStorageAnalyticsRuntime, advanceStorageAnalytics } from '../src/storage-analytics-runtime';
import { drainCommunityPublicSourceBootstrap } from '../src/community-daily-aggregates';
import { readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { captureStorageGraphScope, storageGraphV11CheckpointMethod } from '../src/storage-community-graph';
import { advanceStorageCommunityGraphWork } from '../src/storage-community-graph-work';
import { claimStorageGraphWorkSelection, completeStorageGraphWorkSelection, discardStorageGraphWorkSelection,
  ensureStorageGraphWorkSelection, loadLiveStorageGraphWorkSelection, readStorageGraphWorkSelection,
  releaseStorageGraphWorkSelection, type StorageGraphEffectiveWorkEnvelope,
  type StorageGraphV11WorkEnvelope, type StorageGraphWorkEnvelope,
  type StorageGraphWorkSelection } from '../src/storage-community-graph-selection';
import { loadTypedV11GenerationSnapshot } from '../src/typed-v11-quota-reader';
import { storageHistoryKeyDigest } from '../src/storage-history-checkpoint';
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';

const b=env as Env & {STORAGE_INGESTION_A:D1Database;STORAGE_ANALYTICS_DB:D1Database;
  TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
  TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.STORAGE_INGESTION_A,target=()=>b.STORAGE_ANALYTICS_DB;
const namespace='synthetic-effective-selection',participantId='participant:synthetic-effective-selection';
const today=()=>new Date().toISOString().slice(0,10),yesterday=()=>new Date(Date.now()-86_400_000).toISOString().slice(0,10);
const bindings=()=>({source:source(),target:target(),sourceId:namespace,sourceNamespace:namespace});
const currentFit=()=>target().prepare(`INSERT INTO analytics_community_graph_scan
  (source_id,revision,tick,current_position,history_position) VALUES(?,1,0,0,0)
  ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=0,current_position=0`).bind(namespace).run();

beforeEach(async()=>{
  await reset();
  for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
    b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
  await initializeStorageSource(source(),namespace);
  await initializeTypedV1Admission(source(),namespace);await initializeTypedV11Admission(source(),namespace);
  await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
  await drainCommunityPublicSourceBootstrap(source());await initializeStorageAnalyticsRuntime(bindings());
});

async function fixture(effective=true,quotaCount=9){
  const device=await createV11DeviceFixture(source(),{participantId,grant:true});
  const start=Date.parse(`${yesterday()}T01:00:00.000Z`);
  const attribution={accountBasis:'same_source' as const,accountTrackId:`account-track:v2:${'a'.repeat(64)}`,
    planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};
  const interval=Math.min(300_000,Math.floor(12*3_600_000/quotaCount));
  const quota:TelemetryV11QuotaObservation[]=Array.from({length:quotaCount},(_,index)=>({schemaVersion:'quota-observation-v1.1',
    observationId:`quota:synthetic:${index}`,observedTime:new Date(start+index*interval).toISOString(),provider:'openai_codex',
    planType:'pro',planVariant:'unknown',limitId:'codex',slot:'seven_day',usedPercent:10+index*40/(quotaCount-1),
    windowDurationMinutes:10080,resetsAt:new Date(start+7*86_400_000).toISOString(),accountPlanAttribution:{...attribution}}));
  const usage=Array.from({length:8},(_,index)=>v11UsageRecord(yesterday(),'a',{
    eventId:`event:synthetic:${index}`,eventTime:new Date(start+index*300_000+150_000).toISOString(),
    accountPlanAttribution:{...attribution}}));
  const days=[];
  for(const prepared of [await makeV11Day(yesterday(),{quota,usage}),await makeV11Day(today(),{})]){
    await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
    for(const chunk of prepared.chunks){
      const digest=await sha256Hex(`synthetic:${crypto.randomUUID()}`),principal=await authenticateDevice(source(),device.authorization);
      const grant=await createDeviceUploadAuthorization(source(),principal,digest,200);
      const claim=await claimDeviceUploadAuthorization(source(),`Upload ${grant.uploadAuthorization}`,
        {envelopeDigest:digest,bodyBytes:200,contentType:'application/json'});
      await persistTypedV11StagedChunk(source(),device,chunk,{sourceNamespace:namespace,chunkRowId:`chunk:${crypto.randomUUID()}`,
        r2Key:`synthetic/${crypto.randomUUID()}`,envelopeDigest:digest,deviceUploadAuthorizationId:claim.authorizationId});
    }
    const registered=await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
    days.push({day:prepared.manifest.day,manifestId:registered.manifestId,manifestDigest:registered.manifestDigest});
  }
  const prior=await createTelemetryV11DomainPredecessor(source(),device);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:yesterday(),throughDay:today(),
    predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
    days,manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(),device,manifest);
  for(let pass=0;pass<32;pass++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
  if(effective)await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
  expect(owner).toMatchObject({hasV11:true,hasEffective:effective});return owner;
}

async function effectiveEnvelope():Promise<StorageGraphEffectiveWorkEnvelope>{
  const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
  const scope=await captureStorageGraphScope(source(),{owner,day:today(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
  expect(scope.source).toBe('effective');
  return {version:2,source:'effective',sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,
    participantId:owner.participantId,ownerRevision:owner.ownerRevision,targetAuthorityEpoch:owner.authorityEpoch,
    day:scope.day,metric:scope.metric,fixedNow:scope.fixedNow,dependencyDigest:scope.dependencyDigest,
    checkpointDependencyDigest:scope.checkpointDependencyDigest};
}

async function v11Envelope():Promise<StorageGraphV11WorkEnvelope>{
  const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
  const scope=await captureStorageGraphScope(source(),{owner,day:today(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
  if(scope.source!=='v1.1'||!('source'in scope.pin))throw new Error('synthetic v1.1 scope missing');
  const snapshot=await loadTypedV11GenerationSnapshot(source(),{sourceNamespace:namespace,pin:scope.pin});
  const method=storageGraphV11CheckpointMethod('fits',false);
  return {version:1,source:'v1.1',sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,
    targetAuthorityEpoch:owner.authorityEpoch,day:scope.day,metric:scope.metric,fixedNow:scope.fixedNow,
    dependencyDigest:scope.dependencyDigest,checkpointDependencyDigest:scope.checkpointDependencyDigest,
    checkpointMethod:method,checkpointKeyDigest:await storageHistoryKeyDigest({sourceId:namespace,sourceNamespace:namespace,
      ownerDigest:owner.ownerDigest!,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,method}),snapshot};
}

const key=(envelope:StorageGraphWorkEnvelope)=>({sourceId:envelope.sourceId,ownerDigest:envelope.ownerDigest,
  day:envelope.day,metric:envelope.metric});
function selected(value:{selection?:StorageGraphWorkSelection|null}):StorageGraphWorkSelection{
  if(!value.selection)throw new Error('synthetic selection missing');return value.selection;
}
async function ensure(envelope:StorageGraphWorkEnvelope,nowMs=10){
  const result=await ensureStorageGraphWorkSelection({...bindings(),envelope,nowMs});
  expect(result.status).toBe('created');return selected(result);
}
async function fence(envelope:StorageGraphWorkEnvelope){
  await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
    .bind(namespace,envelope.ownerDigest,'e'.repeat(64),1,1,envelope.targetAuthorityEpoch,1).run();
}

/** Observe real D1 statements and pause at a deterministic boundary. The source
 * and target still execute their maintained SQL against Miniflare D1. */
function observe(database:D1Database,hook:(sql:string,bound:unknown[],when:'before'|'after')=>void|Promise<void>){
  const wrap=(statement:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>new Proxy(statement,{get(value,property){
    if(property==='bind')return(...args:unknown[])=>wrap(value.bind(...args),sql,args);
    if(['all','first','run','raw'].includes(String(property)))return async(...args:unknown[])=>{
      await hook(sql,bound,'before');const result=await Reflect.apply(Reflect.get(value,property) as Function,value,args);
      await hook(sql,bound,'after');return result;};
    const member=Reflect.get(value,property);return typeof member==='function'?member.bind(value):member;
  }});
  return new Proxy(database,{get(value,property){
    if(property==='prepare')return(sql:string)=>wrap(value.prepare(sql),sql);
    const member=Reflect.get(value,property);return typeof member==='function'?member.bind(value):member;
  }});
}
const quotaPage=(sql:string,bound:unknown[])=>sql.includes('SELECT occurrence_id,observed_at_ms FROM grouped')
  &&sql.includes('chunk.stream=?')&&bound.includes('quota');

describe('effective graph work selection',()=>{
  it('reuses an exact completed head before opening another selection, but retains pending selection recovery',async()=>{
    const owner=await fixture(),request={ownerDigest:owner.ownerDigest!,day:today(),metric:'fits' as const};
    const first=await advanceStorageCommunityGraphWork({...bindings(),request,deadlineMs:Date.now()+60_000});
    expect(first).toMatchObject({state:'complete',metric:'fits',day:today()});
    const envelope=await effectiveEnvelope();
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    const retained=await target().prepare(`SELECT dependency_digest,payload_json,payload_sha256,computed_ms
      FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`)
      .bind(namespace,owner.ownerDigest,today()).first();
    expect(retained).not.toBeNull();
    let selectionWrites=0;
    const observedTarget=observe(target(),(sql,_bound,when)=>{
      if(when==='after'&&/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)
        &&sql.includes('analytics_community_graph_work_selection'))selectionWrites++;
    });
    expect(await advanceStorageCommunityGraphWork({...bindings(),target:observedTarget,request,
      deadlineMs:Date.now()+60_000})).toMatchObject({state:'reused',metric:'fits',day:today()});
    expect(selectionWrites).toBe(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    expect(await target().prepare(`SELECT dependency_digest,payload_json,payload_sha256,computed_ms
      FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`)
      .bind(namespace,owner.ownerDigest,today()).first()).toEqual(retained);

    let demandChecks=0;
    await expect(advanceStorageCommunityGraphWork({...bindings(),target:observedTarget,request,
      deadlineMs:Date.now()+60_000,assertCurrent:async()=>{
        if(++demandChecks===2)throw new Error('synthetic graph demand changed');
      }})).rejects.toThrow('synthetic graph demand changed');
    expect(demandChecks).toBe(2);
    expect(selectionWrites).toBe(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();

    await ensure(envelope);selectionWrites=0;
    expect(await advanceStorageCommunityGraphWork({...bindings(),target:observedTarget,request,
      deadlineMs:Date.now()+60_000})).toMatchObject({state:'reused',metric:'fits',day:today()});
    expect(selectionWrites).toBeGreaterThan(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
  });

  it('does not fall through to selection or computation on a forced canonical capability refusal',async()=>{
    const owner=await fixture(),request={ownerDigest:owner.ownerDigest!,day:today(),metric:'fits' as const};
    expect(await advanceStorageCommunityGraphWork({...bindings(),request,deadlineMs:Date.now()+60_000}))
      .toMatchObject({state:'complete'});
    const envelope=await effectiveEnvelope();
    await source().prepare('DROP TRIGGER storage_effective_selective_runtime_retained').run();
    let writes=0;
    const observedTarget=observe(target(),(sql,_bound,when)=>{
      if(when==='after'&&/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)
        &&(sql.includes('analytics_community_graph_work_selection')
          ||sql.includes('analytics_community_graph_results')))writes++;
    });
    expect(await advanceStorageCommunityGraphWork({...bindings(),target:observedTarget,request,canonicalPipeline:true,
      deadlineMs:Date.now()+60_000})).toMatchObject({state:'deferred',reason:'migration_required'});
    expect(writes).toBe(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
  });

  it('does not reuse a completed head after target erasure',async()=>{
    const owner=await fixture(),request={ownerDigest:owner.ownerDigest!,day:today(),metric:'fits' as const};
    expect(await advanceStorageCommunityGraphWork({...bindings(),request,deadlineMs:Date.now()+60_000}))
      .toMatchObject({state:'complete'});
    const envelope=await effectiveEnvelope();
    await fence(envelope);
    expect(await advanceStorageCommunityGraphWork({...bindings(),request,deadlineMs:Date.now()+60_000}))
      .not.toMatchObject({state:'reused'});
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
  });

  it('admits one overlapping scheduler and keeps the busy contender out of effective quota pages',async()=>{
    await fixture();const envelope=await effectiveEnvelope();await currentFit();
    const winnerMeter=createD1InvocationBudget(950),contenderMeter=createD1InvocationBudget(950);
    let release!:()=>void,entered!:()=>void,winnerPages=0,contenderPages=0;
    const barrier=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{entered=resolve;});
    const observedSource=observe(source(),async(sql,bound,when)=>{
      if(when==='after'&&quotaPage(sql,bound)&&++winnerPages===1){entered();await barrier;}
    });
    const started=Date.parse(`${today()}T12:00:00.000Z`);
    const winner=advanceStorageCommunityGraphWork({...bindings(),source:winnerMeter.wrap(observedSource),target:winnerMeter.wrap(target()),
      get remainingQueries(){return winnerMeter.remainingQueries;},nowMs:started,leaseMs:570_000});
    try{
      await Promise.race([arrived,winner.then(result=>{throw new Error(`winner ended before quota page: ${JSON.stringify(result)}`);})]);
      const claimed=await readStorageGraphWorkSelection(target(),key(envelope));
      expect(claimed).toMatchObject({state:'claimed',claimExpiresMs:started+570_000,envelope:{version:2,source:'effective'}});
      await currentFit();
      const contenderSource=observe(source(),(sql,bound,when)=>{if(when==='after'&&quotaPage(sql,bound))contenderPages++;});
      const contender=await advanceStorageCommunityGraphWork({...bindings(),source:contenderMeter.wrap(contenderSource),
        target:contenderMeter.wrap(target()),get remainingQueries(){return contenderMeter.remainingQueries;},nowMs:started+300_001});
      expect(contender).toEqual({state:'deferred',metric:'fits',day:today(),reason:'selection_busy'});
      expect(contenderPages).toBe(0);
      // The calculation-method probe also runs before a busy selection yields.
      expect(contenderMeter.queriesUsed).toBe(10);
      expect(await readStorageGraphWorkSelection(target(),key(envelope))).toEqual(claimed);
    }finally{release();}
    expect(await winner).toMatchObject({state:'complete',metric:'fits',day:today()});
    expect(winnerPages).toBeGreaterThan(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    console.info('effective selection statements',JSON.stringify({winner:winnerMeter.queriesUsed,busyContender:contenderMeter.queriesUsed,
      winnerQuotaPages:winnerPages,contenderQuotaPages:contenderPages}));
  });

  it('uses a bounded claim/release lifecycle and recovers the exact effective envelope after lease expiry',async()=>{
    await fixture();const envelope=await effectiveEnvelope(),meter=createD1InvocationBudget(950);
    const metered={source:meter.wrap(source()),target:meter.wrap(target())};
    const pending=selected(await ensureStorageGraphWorkSelection({...metered,envelope,nowMs:10}));
    const ensuredQueries=meter.queriesUsed;
    const first=selected(await claimStorageGraphWorkSelection({...metered,selection:pending,claimToken:'synthetic-effective-claim-a',nowMs:11,leaseMs:570_000}));
    const claimQueries=meter.queriesUsed-ensuredQueries;
    const released=await releaseStorageGraphWorkSelection({target:metered.target,selection:first,claimToken:first.claimToken!,nowMs:12});
    const releaseQueries=meter.queriesUsed-ensuredQueries-claimQueries;
    expect(released.status).toBe('released');expect({ensuredQueries,claimQueries,releaseQueries}).toEqual({ensuredQueries:5,claimQueries:4,releaseQueries:2});
    console.info('effective selection lifecycle statements',JSON.stringify({ensure:ensuredQueries,claim:claimQueries,release:releaseQueries}));
    const second=selected(await claimStorageGraphWorkSelection({...bindings(),selection:selected(released),
      claimToken:'synthetic-effective-claim-b',nowMs:13,leaseMs:570_000}));
    expect(await loadLiveStorageGraphWorkSelection({...bindings(),key:key(envelope),nowMs:300_014})).toMatchObject({state:'claimed'});
    const recovered=await loadLiveStorageGraphWorkSelection({...bindings(),key:key(envelope),nowMs:570_013});
    expect(recovered).toMatchObject({state:'pending',envelopeSha256:pending.envelopeSha256,claimToken:null});
    const third=selected(await claimStorageGraphWorkSelection({...bindings(),selection:recovered!,
      claimToken:'synthetic-effective-claim-c',nowMs:570_014}));
    expect((await releaseStorageGraphWorkSelection({target:target(),selection:second,claimToken:second.claimToken!,nowMs:570_015})).status).toBe('conflict');
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toEqual(third);
    expect((await completeStorageGraphWorkSelection({target:target(),selection:third,claimToken:third.claimToken!,nowMs:570_016})).status).toBe('completed');
  });

  it.each([950,560])('saves progress and releases the effective lease within an actual %i-statement allocation',async(cap)=>{
    await fixture(true,1200);const envelope=await effectiveEnvelope(),meter=createD1InvocationBudget(cap);
    let preludeQueries:number|undefined,pages=0;
    const observedSource=observe(source(),(sql,bound,when)=>{if(when==='after'&&quotaPage(sql,bound))pages++;});
    const observedTarget=observe(target(),(sql,_bound,when)=>{
      if(when==='before'&&preludeQueries===undefined&&sql.includes('SELECT 1 FROM analytics_runtime_sources WHERE source_id=?'))
        preludeQueries=meter.queriesUsed-1;
    });
    const result=await advanceStorageCommunityGraphWork({...bindings(),source:meter.wrap(observedSource),target:meter.wrap(observedTarget),
      get remainingQueries(){return meter.remainingQueries;},deadlineMs:Date.now()+60_000,leaseMs:570_000,preparedFold:false});
    // The exact-head miss adds one indexed read. Both scope captures also
    // check the authority-restore marker before their source authority read.
    expect(preludeQueries).toBe(44);expect(pages).toBeGreaterThan(0);
    expect(result.failure).toBeUndefined();
    if(cap===560)expect(result.state).toBe('deferred');else expect(['complete','deferred']).toContain(result.state);
    expect(meter.remainingQueries).toBeGreaterThanOrEqual(38);
    const remaining=await readStorageGraphWorkSelection(target(),key(envelope));
    if(result.state==='complete')expect(remaining).toBeNull();
    else expect(remaining).toMatchObject({state:'pending',claimToken:null,claimExpiresMs:null});
    expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=0').first('n')).toBeGreaterThan(0);
    console.info('effective selection bounded allocation',JSON.stringify({cap,queries:meter.queriesUsed,
      remaining:meter.remainingQueries,prelude:preludeQueries,pages,state:result.state,reason:result.reason}));
  });

  it('releases the claim when the invocation deadline ends during its scope recapture',async()=>{
    await fixture();const envelope=await effectiveEnvelope();let claimed=false,pages=0;
    const observedTarget=observe(target(),(sql,_bound,when)=>{
      if(when==='after'&&sql.includes("SET state='claimed',selection_revision=selection_revision+1"))claimed=true;
    });
    const observedSource=observe(source(),(sql,bound,when)=>{if(when==='after'&&quotaPage(sql,bound))pages++;});
    expect(await advanceStorageCommunityGraphWork({...bindings(),source:observedSource,target:observedTarget,
      get deadlineMs(){return claimed?0:Date.now()+60_000;}})).toMatchObject({state:'deferred',reason:'budget'});
    expect(claimed).toBe(true);expect(pages).toBe(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toMatchObject({state:'pending',claimToken:null});
  });

  it('leaves a pending selection unclaimed when setup consumes the claim and release headroom',async()=>{
    await fixture();const envelope=await effectiveEnvelope(),meter=createD1InvocationBudget(60);
    expect(await advanceStorageCommunityGraphWork({...bindings(),source:meter.wrap(source()),target:meter.wrap(target()),
      get remainingQueries(){return meter.remainingQueries;},admissionQueries:1})).toMatchObject({state:'deferred',reason:'budget'});
    expect(meter.remainingQueries).toBeGreaterThan(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toMatchObject({revision:1,state:'pending',claimToken:null});
  });

  it('releases a claim when the owner changes between the claim and authoritative recapture',async()=>{
    await fixture();const envelope=await effectiveEnvelope();let changed=false,pages=0;
    const racedTarget=observe(target(),async(sql,_bound,when)=>{
      if(!changed&&when==='after'&&sql.includes("SET state='claimed',selection_revision=selection_revision+1")){
        changed=true;await source().prepare('UPDATE storage_owner_revisions SET revision=revision+1 WHERE owner_digest=?')
          .bind(envelope.ownerDigest).run();
      }
    });
    const observedSource=observe(source(),(sql,bound,when)=>{if(when==='after'&&quotaPage(sql,bound))pages++;});
    // The existing effective-owner fence uses the closed graph_scope/application
    // classification. Its rejection must still release the claim on this path.
    await expect(advanceStorageCommunityGraphWork({...bindings(),source:observedSource,target:racedTarget}))
      .rejects.toMatchObject({stage:'graph_scope',reason:'application'});
    expect(changed).toBe(true);expect(pages).toBe(0);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toMatchObject({state:'pending',claimToken:null});
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
  });

  it('invalidates changed owner revisions and authority epochs without admitting stale work',async()=>{
    await fixture();const envelope=await effectiveEnvelope(),pending=await ensure(envelope);
    await source().prepare('UPDATE storage_owner_revisions SET revision=revision+1 WHERE owner_digest=?').bind(envelope.ownerDigest).run();
    expect((await claimStorageGraphWorkSelection({...bindings(),selection:pending,claimToken:'synthetic-stale-revision',nowMs:11})).status).toBe('blocked');
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    const fresh=await effectiveEnvelope(),next=await ensure(fresh);
    await source().prepare('UPDATE storage_owner_revisions SET authority_epoch=authority_epoch+1 WHERE owner_digest=?').bind(envelope.ownerDigest).run();
    expect(await loadLiveStorageGraphWorkSelection({...bindings(),key:next.key,nowMs:12})).toBeNull();
    expect((await ensureStorageGraphWorkSelection({...bindings(),envelope:fresh,nowMs:13})).status).toBe('blocked');
  });

  it('recaptures effective dependencies after claiming and discards a superseded scope before quota pages',async()=>{
    await fixture();const envelope=await effectiveEnvelope();
    await ensure({...envelope,dependencyDigest:'b'.repeat(64),checkpointDependencyDigest:'c'.repeat(64)});
    await currentFit();let pages=0;
    const observed=observe(source(),(sql,bound,when)=>{if(when==='after'&&quotaPage(sql,bound))pages++;});
    expect(await advanceStorageCommunityGraphWork({...bindings(),source:observed})).toMatchObject({state:'deferred',reason:'selection_changed'});
    expect(pages).toBe(0);expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
    await currentFit();expect(await advanceStorageCommunityGraphWork(bindings())).toMatchObject({state:'complete',metric:'fits'});
  });

  it('discards an old v1.1 selection once an owner moves to effective history and then makes progress',async()=>{
    await fixture(false);const envelope=await v11Envelope();await ensure(envelope);
    await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    await currentFit();expect(await advanceStorageCommunityGraphWork(bindings())).toMatchObject({state:'deferred',reason:'selection_changed'});
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    await currentFit();expect(await advanceStorageCommunityGraphWork(bindings())).toMatchObject({state:'complete',metric:'fits'});
    expect(await target().prepare("SELECT source_kind FROM analytics_community_graph_results WHERE metric='fits'").first('source_kind')).toBe('effective');
  });

  it('rejects malformed effective envelopes and blocks mismatched source namespaces and target epochs',async()=>{
    await fixture();const envelope=await effectiveEnvelope();
    for(const invalid of [{...envelope,extra:true},{...envelope,version:1},{...envelope,source:'v1.1'},
      {...envelope,ownerDigest:[envelope.ownerDigest]},{...envelope,dependencyDigest:[envelope.dependencyDigest]},
      {...envelope,checkpointDependencyDigest:[envelope.checkpointDependencyDigest]},{...envelope,metric:['fits']},
      {...envelope,ownerRevision:'1'},{...envelope,participantId:[]},{...envelope,targetAuthorityEpoch:NaN}]){
      await expect(ensureStorageGraphWorkSelection({...bindings(),envelope:invalid as unknown as StorageGraphWorkEnvelope,nowMs:10}))
        .rejects.toThrow('STORAGE_GRAPH_SELECTION_INVALID');
    }
    for(const blocked of [{...envelope,sourceNamespace:'synthetic-other-source'},
      {...envelope,targetAuthorityEpoch:envelope.targetAuthorityEpoch+1}]){
      expect((await ensureStorageGraphWorkSelection({...bindings(),envelope:blocked,nowMs:10})).status).toBe('blocked');
    }
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
  });

  it('cannot insert participant metadata when an erasure fence arrives after live proofs',async()=>{
    await fixture();const envelope=await effectiveEnvelope();let fenced=false;
    const racedTarget=observe(target(),async(sql,_bound,when)=>{
      if(!fenced&&when==='before'&&sql.includes('INSERT INTO analytics_community_graph_work_selection')){fenced=true;await fence(envelope);}
    });
    expect((await ensureStorageGraphWorkSelection({...bindings(),target:racedTarget,envelope,nowMs:10})).status).toBe('blocked');
    expect(fenced).toBe(true);expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    expect(await target().prepare('SELECT state FROM analytics_owner_state WHERE owner_digest=?').bind(envelope.ownerDigest).first('state')).toBe('active');
  });

  it('erasure removes an active effective claim and neither release nor re-ensure can restore it',async()=>{
    await fixture();const envelope=await effectiveEnvelope(),pending=await ensure(envelope);
    const claimed=selected(await claimStorageGraphWorkSelection({...bindings(),selection:pending,claimToken:'synthetic-erasure-claim',nowMs:11}));
    await fence(envelope);expect(await readStorageGraphWorkSelection(target(),key(envelope))).toBeNull();
    expect((await releaseStorageGraphWorkSelection({target:target(),selection:claimed,claimToken:claimed.claimToken!,nowMs:12})).status).toBe('conflict');
    expect((await ensureStorageGraphWorkSelection({...bindings(),envelope,nowMs:13})).status).toBe('blocked');
  });

  it('does not let stale selections claim or remove a replacement whose revision counter restarted',async()=>{
    await fixture();const envelope=await effectiveEnvelope(),oldPending=await ensure(envelope);
    const oldClaim=selected(await claimStorageGraphWorkSelection({...bindings(),selection:oldPending,
      claimToken:'synthetic-original-claim',nowMs:11}));
    await discardStorageGraphWorkSelection(target(),oldClaim);
    const replacement=await ensure({...envelope,dependencyDigest:'f'.repeat(64)},12);
    expect(replacement.revision).toBe(oldPending.revision);
    expect((await claimStorageGraphWorkSelection({...bindings(),selection:oldPending,
      claimToken:'synthetic-stale-pending',nowMs:13})).status).toBe('conflict');
    const replacementClaim=selected(await claimStorageGraphWorkSelection({...bindings(),selection:replacement,
      claimToken:'synthetic-replacement-claim',nowMs:14}));
    expect(replacementClaim.revision).toBe(oldClaim.revision);
    await discardStorageGraphWorkSelection(target(),oldClaim);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toEqual(replacementClaim);
    // Even an identical envelope can be deleted/recreated at the same revision;
    // its new claim token, not just its envelope digest, distinguishes the row.
    await discardStorageGraphWorkSelection(target(),replacementClaim);
    const identical=await ensure(envelope,15);
    const identicalClaim=selected(await claimStorageGraphWorkSelection({...bindings(),selection:identical,
      claimToken:'synthetic-identical-new-claim',nowMs:16}));
    expect(identicalClaim.revision).toBe(oldClaim.revision);
    await discardStorageGraphWorkSelection(target(),oldClaim);
    expect(await readStorageGraphWorkSelection(target(),key(envelope))).toEqual(identicalClaim);
  });
});
