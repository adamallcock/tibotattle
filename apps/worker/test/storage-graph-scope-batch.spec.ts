import {env,reset} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {captureStorageGraphScope,createStorageGraphScopeBatch} from '../src/storage-community-graph';
import {withMaintainedEffectiveDependencies} from '../src/storage-effective-dependency-summaries';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
import {sha256Hex,encodeBase64Url} from '../src/crypto';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {enrollAccountlessDevice,parseAccountlessEnrollmentRequest,ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS} from '../src/accountless-enrollment';
import {createAccountlessUploadOwner,parseAccountlessOwnershipRequest,ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION} from '../src/accountless-ownership';
import {grantTelemetryV12AccountlessAuthorization,parseTelemetryV12AccountlessAuthorizationRequest,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS} from '../src/telemetry-transport-policy';
import {telemetryV12RequiredConsent,telemetryV12DayManifestDigestInput,telemetryV12DomainManifestDigestInput} from '@app-usagemonitor/telemetry-contract';
import {registerTelemetryV12DayManifest} from '../src/telemetry-v12-repository';
import {activateTelemetryV12Domain,createTelemetryV12DomainPredecessor} from '../src/telemetry-v12-domain';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-graph-scope-batch',sourceNamespace=sourceId;
let corpus:SharedAnalyticsCorpus,days:string[];
async function drain(owner=corpus.owner){
  for(let pass=0;pass<48;pass++){
    const value=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace,
      participantId:owner.participantId,maxSteps:64,maxRows:128});
    if(value.status==='complete')return;expect(value.status).not.toBe('unavailable');
  }
  throw Error('synthetic coverage incomplete');
}
beforeEach(async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
  corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,
    calendarDays:14,graphDays:3,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  days=corpus.historyDates.slice(-3);await drain();
});
function options(){return {target:target(),owner:corpus.owner,days,metric:'model' as const,
  sourceId,sourceNamespace,preparedFold:true,deadlineMs:Date.now()+60_000};}
function attached(db=source(),t=target()){return withMaintainedEffectiveDependencies(db,t,sourceId,sourceNamespace);}
const memoCount=()=>target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries').first<number>('n');
async function native(day:string){return captureStorageGraphScope(source(),{...options(),day});}
async function warm(){for(const day of days)await captureStorageGraphScope(attached(),{...options(),day});}

it('returns exact three-date native scopes with full seals and lower warmed proof work',async()=>{
  const expected=await Promise.all(days.map(native));await warm();
  const measured=async(batchMode:boolean)=>{
    const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
    const rawSource=profileAnalyticsDatabase(source(),'source',profile,()=> 'scope');
    const rawTarget=profileAnalyticsDatabase(target(),'target',profile,()=> 'scope');
    const db=meter.wrap(attached(rawSource,rawTarget)),t=meter.wrap(rawTarget),scopes=[];
    if(batchMode){
      const batch=await createStorageGraphScopeBatch(db,{...options(),target:t,remainingQueries:()=>meter.remainingQueries});
      expect(batch).toBeDefined();
      try{for(const day of days){const scope=await batch!.readScope(day);await batch!.assertCurrent();scopes.push(scope);}}
      finally{batch!.close();}
    }else for(const day of days)scopes.push(await captureStorageGraphScope(db,{...options(),day}));
    expect(scopes).toEqual(expected);
    const cost=summarizeAnalyticsProfile(profile);expect(cost.statements).toBe(meter.queriesUsed);
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(cost.rowsWritten).toBe(0);
    return {statements:cost.statements,rowsRead:cost.rowsRead,rowsWritten:cost.rowsWritten};
  };
  const before=await measured(false),after=await measured(true);
  expect(after.statements).toBeLessThan(before.statements);expect(after.rowsRead).toBeLessThan(before.rowsRead);
  console.log('P11_GRAPH_SCOPE_BATCH_PROOF',JSON.stringify({dates:days.length,before,after}));
},120_000);

it('creates a cold batch without memo writes and acquires only its requested selected date',async()=>{
  expect(await memoCount()).toBe(0);const expected=await native(days[2]!);
  const meter=createD1InvocationBudget(950),db=meter.wrap(attached()),t=meter.wrap(target());
  const batch=await createStorageGraphScopeBatch(db,{...options(),target:t});expect(batch).toBeDefined();
  try{
    expect(await memoCount()).toBe(0);
    expect(await batch!.readScope(days[2]!)).toEqual(expected);await batch!.assertCurrent();
    expect(await memoCount()).toBe(1);
    expect((await target().prepare('SELECT through_day FROM analytics_effective_dependency_summaries')
      .all<{through_day:string}>()).results.map(row=>row.through_day)).toEqual([days[2]]);
  }finally{batch!.close();}
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},120_000);

it.each(['source','target'] as const)('freshly refuses dropped %s capability and recaptures after exact restoration on the same handles',async side=>{
  await warm();const db=attached(),batch=await createStorageGraphScopeBatch(db,options());expect(batch).toBeDefined();
  const database=side==='source'?source():target(),name=side==='source'
    ?'storage_effective_selective_correction_fact_insert':'analytics_effective_dependency_contract_v1';
  const ddl=await database.prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?').bind(name).first<string>('sql');
  expect(ddl).toBeTruthy();
  try{
    await database.prepare(`DROP TRIGGER ${name}`).run();
    await expect(batch!.assertCurrent()).rejects.toThrow();
    await database.prepare(ddl!).run();
  }finally{batch!.close();}
  const next=await createStorageGraphScopeBatch(db,options());expect(next).toBeDefined();
  try{expect(await next!.readScope(days[0]!)).toEqual(await native(days[0]!));await next!.assertCurrent();}
  finally{next!.close();}
},120_000);

it.each(['source_owner','target_owner','terminal'] as const)('refuses a held batch after %s changes',async change=>{
  await warm();const batch=await createStorageGraphScopeBatch(attached(),options());expect(batch).toBeDefined();
  try{
    if(change==='source_owner')await corpus.mutateCorrection();
    else if(change==='target_owner')await target().prepare('UPDATE analytics_owner_state SET authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?')
      .bind(sourceId,corpus.owner.ownerDigest).run();
    else await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
      .bind(sourceId,corpus.owner.ownerDigest,'c'.repeat(64),1,1,corpus.owner.authorityEpoch,corpus.owner.authorityEpoch).run();
    await expect(batch!.assertCurrent()).rejects.toThrow();
    await expect(batch!.readScope(days[0]!)).rejects.toThrow();
  }finally{batch!.close();}
},120_000);

it('rejects foreign wrapped handles, namespace, closed membership and oversized union without widening the meter',async()=>{
  const meter=createD1InvocationBudget(950),db=meter.wrap(attached()),t=meter.wrap(target());
  await expect(createStorageGraphScopeBatch(db,{...options(),target:target()})).rejects.toThrow();
  await expect(createStorageGraphScopeBatch(db,{...options(),target:t,sourceNamespace:'foreign'})).rejects.toThrow();
  await expect(createStorageGraphScopeBatch(db,{...options(),target:t,days:[days[0]!,days[0]!]})).rejects.toThrow();
  await expect(createStorageGraphScopeBatch(db,{...options(),target:t,days:Array.from({length:17},(_,i)=>new Date(Date.parse(days[0]!)+i*86_400_000).toISOString().slice(0,10))})).rejects.toThrow();
  await expect(createStorageGraphScopeBatch(db,{...options(),target:t,days:[days[0]!,'2027-09-01']})).rejects.toThrow();
  const batch=await createStorageGraphScopeBatch(db,{...options(),target:t});expect(batch).toBeDefined();
  await expect(batch!.readScope('2026-01-01')).rejects.toThrow();batch!.close();
  await expect(batch!.readScope(days[0]!)).rejects.toThrow();await expect(batch!.assertCurrent()).rejects.toThrow();
  const tiny=createD1InvocationBudget(1),small=tiny.wrap(attached());
  await expect(createStorageGraphScopeBatch(small,{...options(),target:tiny.wrap(target())})).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},120_000);

it('enforces real caller deadline and fixed SQL member/aggregate transfer bounds',async()=>{
  await warm();let transferChecks=0,clock=Date.now();
  const observedTarget=new Proxy(target(),{get(db,key){
    if(key==='prepare')return(sql:string)=>{
      const statement=db.prepare(sql);
      if(!sql.includes('WITH requested AS MATERIALIZED'))return statement;
      expect(sql).toContain('sum(length(CAST(payload AS BLOB)))');expect(sql).toContain('max(length(CAST(payload AS BLOB)))');
      expect(sql).toContain('LIMIT 17');
      return new Proxy(statement,{get(inner,method){
        if(method==='bind')return(...values:unknown[])=>{expect(values.slice(-2)).toEqual([4*1024*1024,256*1024]);transferChecks++;return inner.bind(...values);};
        const value=Reflect.get(inner,method);return typeof value==='function'?value.bind(inner):value;
      }});
    };
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
  }});
  const deadline=clock+60_000,batch=await createStorageGraphScopeBatch(attached(source(),observedTarget),
    {...options(),target:observedTarget,deadlineMs:deadline,now:()=>clock});
  expect(batch).toBeDefined();expect(transferChecks).toBe(1);
  clock=deadline;
  try{await expect(batch!.readScope(days[0]!)).rejects.toThrow();await expect(batch!.assertCurrent()).rejects.toThrow();}
  finally{batch!.close();}
  // The actual schema independently enforces the same per-member byte ceiling.
  await expect(target().prepare('UPDATE analytics_effective_dependency_summaries SET payload=?')
    .bind('x'.repeat(256*1024+1)).run()).rejects.toThrow();
},120_000);

it('refuses at actual accountless authorization expiry without changing the source generation or global clock',async()=>{
  const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
  const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`),payload=new Uint8Array(prefix.length+secret.length);
  payload.set(prefix);payload.set(secret,prefix.length);
  const deviceSecretHash=await sha256Hex(payload),authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  payload.fill(0);secret.fill(0);
  const expiresMs=Date.now()+5_000,enrolledMs=expiresMs-ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS;
  await enrollAccountlessDevice(source(),parseAccountlessEnrollmentRequest({schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,deviceId,deviceSecretHash}),enrolledMs);
  await createAccountlessUploadOwner(source(),authorization,parseAccountlessOwnershipRequest({schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION}),enrolledMs);
  const participantId=(await source().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?').bind(deviceId).first<string>('participant_id'))!;
  await grantTelemetryV12AccountlessAuthorization(source(),{participantId,deviceId},parseTelemetryV12AccountlessAuthorizationRequest({
    schemaVersion:ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
    authorizationBasis:ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,telemetrySchemaVersion:'telemetry-contribution-v1.2'}),enrolledMs);
  const principal={participantId,deviceId},day=days[0]!;
  const manifest={schemaVersion:'telemetry-day-manifest-v1.2' as const,day,parserVersion:'synthetic-graph-batch-expiry',
    consent:telemetryV12RequiredConsent(),chunks:[],excluded:{quota:0,session:0,usage:0},manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const ready=await registerTelemetryV12DayManifest(source(),principal,manifest),previous=await createTelemetryV12DomainPredecessor(source(),principal);
  const domain={schemaVersion:'telemetry-domain-manifest-v1.2' as const,fromDay:day,throughDay:day,
    predecessor:{token:previous.token,previousGenerationId:previous.previousGenerationId,legacyFingerprint:previous.legacyFingerprint},
    days:[{day,manifestId:ready.manifestId,manifestDigest:ready.manifestDigest}],manifestDigest:'0'.repeat(64)};
  domain.manifestDigest=await sha256Hex(telemetryV12DomainManifestDigestInput(domain));await activateTelemetryV12Domain(source(),principal,domain);
  const owner=(await readStorageCommunityOwnerPage(source())).find(value=>value.participantId===participantId)!;
  expect(owner?.ownerDigest).toBeTruthy();
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')")
    .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  await drain(owner as typeof corpus.owner);
  const generation=()=>source().prepare('SELECT sequence FROM storage_effective_selective_runtime WHERE id=1').first<number>('sequence');
  const before=await generation(),batch=await createStorageGraphScopeBatch(attached(),{...options(),owner,days:[day]});
  expect(batch).toBeDefined();
  try{
    await batch!.readScope(day);await batch!.assertCurrent();
    expect(await target().prepare('SELECT min(valid_until_ms) n FROM analytics_effective_dependency_summaries WHERE owner_digest=?')
      .bind(owner.ownerDigest).first<number>('n')).toBe(expiresMs);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresMs+5-Date.now())));
    await expect(batch!.assertCurrent()).rejects.toThrow();await expect(batch!.readScope(day)).rejects.toThrow();
    expect(await generation()).toBe(before);
  }finally{batch!.close();}
},120_000);
