import { telemetryV12RequiredConsent,telemetryV12DayManifestDigestInput,telemetryV12DomainManifestDigestInput } from '@app-usagemonitor/telemetry-contract';
import { registerTelemetryV12DayManifest } from '../src/telemetry-v12-repository';
import { activateTelemetryV12Domain,createTelemetryV12DomainPredecessor } from '../src/telemetry-v12-domain';
import { env, reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex, encodeBase64Url } from '../src/crypto';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { createEffectiveHistoryDayDependencyReader, effectiveHistoryDependency } from '../src/storage-effective-history';
import { maintainedEffectiveHistoryDependency, withMaintainedEffectiveDependencies } from '../src/storage-effective-dependency-summaries';
import {EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA,readEffectiveDependencyMutationToken} from '../src/storage-effective-dependency-mutations';
import { readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { grantTelemetryV12AccountlessAuthorization,parseTelemetryV12AccountlessAuthorizationRequest,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS } from '../src/telemetry-transport-policy';
import { enrollAccountlessDevice,parseAccountlessEnrollmentRequest,ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS } from '../src/accountless-enrollment';
import { createAccountlessUploadOwner,parseAccountlessOwnershipRequest,ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION } from '../src/accountless-ownership';
import { advanceEffectiveDependencyCoverage } from '../src/storage-effective-selective-dependencies';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpus, type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';

const bindings = env as Env & SharedAnalyticsCorpusMigrations & {STORAGE_ANALYTICS_DB:D1Database};
const sourceId = 'synthetic-dependency-summary';
const source = () => bindings.USAGE_MONITOR_DB, target = () => bindings.STORAGE_ANALYTICS_DB;
let corpus: SharedAnalyticsCorpus;
let owner: SharedAnalyticsCorpus['owner'];
async function drain() {
  for (let n = 0; n < 48; n++) {
    const result = await advanceEffectiveDependencyCoverage(source(), {sourceId, sourceNamespace:sourceId,
      participantId:owner.participantId, maxSteps:64, maxRows:128});
    if (result.status === 'complete') return;
    expect(result.status).not.toBe('unavailable');
  }
  throw new Error('synthetic coverage did not seal');
}
function attached(database = source(), ledger = target()) {
  return withMaintainedEffectiveDependencies(database, ledger, sourceId, sourceId);
}
async function reference(day: string, includeSessions = false) {
  return effectiveHistoryDependency(source(), owner, sourceId, day, day, {includeSessions});
}
beforeEach(async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId);
  corpus = await seedSharedAnalyticsCorpus({source:source(), target:target(), sourceId, sourceNamespace:sourceId,
    calendarDays:25, graphDays:3, anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  owner = corpus.owner;
  await drain();
});

type SchemaCost={lookup:'full'|'rowid';rowsRead:number;rowsWritten:number;databaseMs:number};
function schemaObserver(database:D1Database) {
 const costs:SchemaCost[]=[];
 const db=new Proxy(database,{get(inner,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(prepared,method){
    if(method==='bind')return(...values:unknown[])=>wrap(prepared.bind(...values));
    if(method==='all')return async()=>{
     const result=await prepared.all();
     if(sql.includes('FROM sqlite_schema')){
      expect(result.meta.rows_read).toBeGreaterThanOrEqual(0);expect(result.meta.rows_written).toBe(0);
      costs.push({lookup:sql.includes('WHERE rowid IN')?'rowid':'full',rowsRead:result.meta.rows_read,
       rowsWritten:result.meta.rows_written,databaseMs:result.meta.duration});
     }
     return result;
    };
    const value:unknown=Reflect.get(prepared,method);return typeof value==='function'?value.bind(prepared):value;
   }});
   return wrap(inner.prepare(sql));
  };
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
 return {db,costs};
}
const originalMutationSchema=`SELECT count(*) AS present FROM sqlite_schema s WHERE (s.type,s.name) IN(
 SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`;
const summaryTriggers=['insert','update','owner_update','owner_delete','runtime_update','runtime_delete',
 'terminal_insert','terminal_update','contract_v1'].map(suffix=>`analytics_effective_dependency_${suffix}`);
const originalSummarySchema=`SELECT name,type FROM sqlite_master WHERE
 (type='table' AND name=?) OR (type='trigger' AND name IN (${summaryTriggers.map(()=>'?').join(',')}))
 OR (type='index' AND name='analytics_effective_dependency_owner')`;
const mutationScope=()=>({participantId:owner.participantId,ownerDigest:owner.ownerDigest!,sourceId,sourceNamespace:sourceId});

it('profiles only the fresh mutation and summary schema component against both original inventories',async()=>{
 expect(EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA).toHaveLength(143);
 expect(new Set(EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA.map(pair=>JSON.stringify(pair))).size)
  .toBe(EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA.length);
 const oldSource=await source().prepare(originalMutationSchema).bind(JSON.stringify(EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA))
  .all<{present:number}>();
 expect(oldSource.results).toEqual([{present:EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA.length}]);
 const oldTarget=await target().prepare(originalSummarySchema).bind('analytics_effective_dependency_summaries',...summaryTriggers)
  .all<{name:string;type:string}>();
 const required=[['table','analytics_effective_dependency_summaries'],...summaryTriggers.map(name=>['trigger',name]),
  ['index','analytics_effective_dependency_owner']];
 expect(new Set(required.map(pair=>JSON.stringify(pair))).size).toBe(11);
 expect(oldTarget.results.map(row=>JSON.stringify([row.type,row.name])).sort())
  .toEqual(required.map(pair=>JSON.stringify(pair)).sort());
 const expected=await readEffectiveDependencyMutationToken(source(),mutationScope());expect(expected).toBeDefined();
 const sourceObservation=schemaObserver(source()),sourceOuter=createD1InvocationBudget(950),sourceInner=createD1InvocationBudget(950),
  sourceDb=sourceInner.wrap(sourceOuter.wrap(sourceObservation.db));
 for(let n=0;n<3;n++)expect(await readEffectiveDependencyMutationToken(sourceDb,mutationScope())).toEqual(expected);
 expect(sourceObservation.costs.map(cost=>cost.lookup)).toEqual(['full','rowid','rowid']);
 expect([sourceOuter.queriesUsed,sourceInner.queriesUsed]).toEqual([6,6]);
 const day=corpus.correctionDay,dependency=await reference(day),native=vi.fn(async()=>dependency),
  targetObservation=schemaObserver(target()),outer=createD1InvocationBudget(950),inner=createD1InvocationBudget(950),
  database=inner.wrap(outer.wrap(attached(source(),targetObservation.db)));
 for(let n=0;n<3;n++)expect(await maintainedEffectiveHistoryDependency(database,owner,sourceId,day,day,false,native)).toEqual(dependency);
 expect(native).toHaveBeenCalledTimes(1);
 expect(targetObservation.costs.map(cost=>cost.lookup)).toEqual(['full','rowid','rowid']);
 expect(outer.queriesUsed).toBe(inner.queriesUsed);expect(outer.queriesUsed).toBeLessThanOrEqual(950);
 expect(oldSource.meta.rows_written).toBe(0);expect(oldTarget.meta.rows_written).toBe(0);
 console.log('effective dependency schema component',JSON.stringify({
  contract:'fresh-exact-schema-component-v1',scope:'schema lookup only; setup, native dependency and source seals are not inferred whole savings',
  required:{source:EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA.length,target:11},
  original:{source:{statements:1,rowsRead:oldSource.meta.rows_read,databaseMs:oldSource.meta.duration},
   target:{statements:1,rowsRead:oldTarget.meta.rows_read,databaseMs:oldTarget.meta.duration}},
  observed:{source:sourceObservation.costs,target:targetObservation.costs},
  invocationStatements:{sourceTokenCalls:sourceOuter.queriesUsed,summaryCalls:outer.queriesUsed},
 }));
},120_000);

it('refuses partial mutation and summary schemas on the same metered handles and restores native-equivalent memo reuse',async()=>{
 const sourceMeter=createD1InvocationBudget(950),sourceDb=sourceMeter.wrap(source()),scope=mutationScope(),
  token=await readEffectiveDependencyMutationToken(sourceDb,scope);
 expect(token).toBeDefined();
 const triggerName='storage_effective_mutation_runtime_guard',triggerSql=await source().prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?')
  .bind(triggerName).first<string>('sql');expect(typeof triggerSql).toBe('string');
 await source().prepare('DROP TRIGGER storage_effective_mutation_runtime_guard').run();
 let before=sourceMeter.queriesUsed;
 expect(await readEffectiveDependencyMutationToken(sourceDb,scope)).toBeUndefined();expect(sourceMeter.queriesUsed-before).toBe(2);
 before=sourceMeter.queriesUsed;
 expect(await readEffectiveDependencyMutationToken(sourceDb,scope)).toBeUndefined();expect(sourceMeter.queriesUsed-before).toBe(1);
 await source().prepare('CREATE VIEW storage_effective_mutation_runtime_guard AS SELECT 1 AS id').run();
 expect(await readEffectiveDependencyMutationToken(sourceDb,scope)).toBeUndefined();
 await source().prepare('DROP VIEW storage_effective_mutation_runtime_guard').run();await source().prepare(triggerSql!).run();
 expect(await readEffectiveDependencyMutationToken(sourceDb,scope)).toEqual(token);

 const day=corpus.correctionDay,expected=await reference(day),native=vi.fn(async()=>expected),
  outer=createD1InvocationBudget(950),inner=createD1InvocationBudget(950),database=inner.wrap(outer.wrap(attached()));
 const read=()=>maintainedEffectiveHistoryDependency(database,owner,sourceId,day,day,false,native);
 expect(await read()).toEqual(expected);expect(native).toHaveBeenCalledTimes(1);
 const indexSql=await target().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='analytics_effective_dependency_owner'")
  .first<string>('sql');expect(typeof indexSql).toBe('string');
 await target().prepare('DROP INDEX analytics_effective_dependency_owner').run();
 before=outer.queriesUsed;
 expect(await read()).toEqual(expected);expect(outer.queriesUsed-before).toBe(2);expect(native).toHaveBeenCalledTimes(2);
 before=outer.queriesUsed;
 expect(await read()).toEqual(expected);expect(outer.queriesUsed-before).toBe(1);expect(native).toHaveBeenCalledTimes(3);
 await target().prepare('CREATE INDEX synthetic_foreign_dependency_owner ON analytics_effective_dependency_summaries(source_id,owner_digest)').run();
 expect(await read()).toEqual(expected);expect(native).toHaveBeenCalledTimes(4);
 await target().prepare('DROP INDEX synthetic_foreign_dependency_owner').run();await target().prepare(indexSql!).run();
 expect(await read()).toEqual(expected);expect(native).toHaveBeenCalledTimes(4);
 const targetTriggerSql=await target().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='analytics_effective_dependency_contract_v1'")
  .first<string>('sql');expect(typeof targetTriggerSql).toBe('string');
 await target().prepare('DROP TRIGGER analytics_effective_dependency_contract_v1').run();
 await target().prepare('CREATE VIEW analytics_effective_dependency_contract_v1 AS SELECT 1 AS id').run();
 expect(await read()).toEqual(expected);expect(native).toHaveBeenCalledTimes(5);
 await target().prepare('DROP VIEW analytics_effective_dependency_contract_v1').run();await target().prepare(targetTriggerSql!).run();
 expect(await read()).toEqual(expected);expect(native).toHaveBeenCalledTimes(5);
 expect(outer.queriesUsed).toBe(inner.queriesUsed);expect(outer.queriesUsed).toBeLessThanOrEqual(950);
 expect(await target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries').first<number>('n')).toBe(1);
},120_000);

it('retains exact native range bytes and distinguishes session-inclusive scopes', async () => {
  const day = corpus.correctionDay;
  for (const includeSessions of [false, true]) {
    const expected = await reference(day, includeSessions);
    const native = vi.fn(async () => expected);
    const cold = await maintainedEffectiveHistoryDependency(attached(), owner, sourceId, day, day, includeSessions, native);
    expect(cold).toEqual(expected);
    const profile = createAnalyticsProfile();
    const measured = attached(profileAnalyticsDatabase(source(),'source',profile,()=> 'warm'),
      profileAnalyticsDatabase(target(),'target',profile,()=> 'warm'));
    expect(await maintainedEffectiveHistoryDependency(measured, owner, sourceId, day, day, includeSessions, native)).toEqual(expected);
    expect(native).toHaveBeenCalledTimes(1);
    expect(summarizeAnalyticsProfile(profile).rawHistoryAccessStatements).toBe(0);
    expect(summarizeAnalyticsProfile(profile).rowsWritten).toBe(0);
  }
  expect(await target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries').first<number>('n')).toBe(2);
}, 120_000);

it('bulk-loads exact singleton identities and performs no warmed history acquisition', async () => {
  const days = corpus.historyDates.slice(0,8);
  const cold = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, days, {includeSessions:true});
  expect(cold).toBeDefined();
  const expected: string[] = [];
  for (const day of days) {
    const digest = await sha256Hex(canonicalJson(await reference(day,true)));
    expected.push(digest);
    expect(await cold!.readDigest(day)).toBe(digest);
  }
  const profile = createAnalyticsProfile(), outer = createD1InvocationBudget(950), inner = createD1InvocationBudget(100);
  const measured = inner.wrap(outer.wrap(attached(profileAnalyticsDatabase(source(),'source',profile,()=> 'warm'),
    profileAnalyticsDatabase(target(),'target',profile,()=> 'warm'))));
  const warm = await createEffectiveHistoryDayDependencyReader(measured, owner, sourceId, days, {includeSessions:true});
  for (let i=0;i<days.length;i++) expect(await warm!.readDigest(days[i]!)).toBe(expected[i]);
  const result = summarizeAnalyticsProfile(profile);
  expect(result.rawHistoryAccessStatements).toBe(0);
  expect(result.rowsWritten).toBe(0);
  expect(result.statements).toBe(outer.queriesUsed);
  expect(inner.queriesUsed).toBe(outer.queriesUsed);
  expect(result.statements).toBeLessThan(40);
}, 120_000);

it('keeps unchanged arithmetic after an unrelated upload advances the owner revision', async () => {
  const day = corpus.equivalentDay;
  const expected = await reference(day);
  const native = vi.fn(async () => reference(day));
  await maintainedEffectiveHistoryDependency(attached(), owner, sourceId, day, day, false, native);
  const stored = await target().prepare('SELECT scope_key,dependency_digest FROM analytics_effective_dependency_summaries').all();
  const previous = owner;
  owner = await corpus.appendOutsideV11();
  expect(owner.ownerRevision).toBeGreaterThan(previous.ownerRevision);
  expect((await target().prepare('SELECT scope_key,dependency_digest FROM analytics_effective_dependency_summaries').all()).results).toEqual(stored.results);
  await drain();
  expect(await reference(day)).toEqual(expected);
  expect(await maintainedEffectiveHistoryDependency(attached(), owner, sourceId, day, day, false, native)).toEqual(expected);
  expect(native).toHaveBeenCalledTimes(1);
}, 120_000);

it('invalidates corrected evidence while preserving unrelated singleton stamps', async () => {
  const days = [corpus.equivalentDay, corpus.correctionDay].sort();
  const cold = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, days);
  const before = new Map<string,string|undefined>();
  for (const day of days) before.set(day, await cold!.readDigest(day));
  owner = await corpus.mutateCorrection();
  await drain();
  const next = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, days);
  for (const day of days) expect(await next!.readDigest(day)).toBe(await sha256Hex(canonicalJson(await reference(day))));
  expect(await next!.readDigest(corpus.equivalentDay)).toBe(before.get(corpus.equivalentDay));
  expect(await next!.readDigest(corpus.correctionDay)).not.toBe(before.get(corpus.correctionDay));
}, 120_000);

it('retains exact fallback when source or target migrations are incomplete', async () => {
  const day = corpus.correctionDay, expected = await reference(day);
  await target().prepare('DROP TRIGGER analytics_effective_dependency_contract_v1').run();
  const native = vi.fn(async () => expected);
  expect(await maintainedEffectiveHistoryDependency(attached(), owner, sourceId, day, day, false, native)).toEqual(expected);
  expect(native).toHaveBeenCalledTimes(1);
  await source().prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
  expect(await maintainedEffectiveHistoryDependency(attached(), owner, sourceId, day, day, false, native)).toEqual(expected);
  expect(native).toHaveBeenCalledTimes(2);
}, 120_000);

it('honours cancellation and rechecks source capability, target terminal fences and every binding budget', async () => {
  const day = corpus.correctionDay;
  const cold = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, [day]);
  expect(await cold!.readDigest(day)).toBeTruthy();
  let continuing = true;
  const cancellable = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, [day], {canContinue:()=>continuing});
  continuing = false;
  expect(await cancellable!.readDigest(day)).toBeUndefined();
  const reader = await createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, [day]);
  await source().prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
  expect(await reader!.readDigest(day)).toBeUndefined();
  await target().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,owner.ownerDigest).run();
  expect(await target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries').first<number>('n')).toBe(0);
  const small = createD1InvocationBudget(1);
  await expect(maintainedEffectiveHistoryDependency(small.wrap(attached()),owner,sourceId,day,day,false,
    ()=>reference(day))).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
}, 120_000);

it('preserves memo payloads across active authority bookkeeping and removes them at withdrawal', async () => {
  const day = corpus.correctionDay;
  await effectiveHistoryDependency(attached(), owner, sourceId, day, day);
  const before = (await target().prepare('SELECT scope_key,mutation_stamp,dependency_digest,payload FROM analytics_effective_dependency_summaries').all()).results;
  expect(before).toHaveLength(1);
  await target().prepare("UPDATE analytics_owner_state SET authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,owner.ownerDigest).run();
  expect((await target().prepare('SELECT scope_key,mutation_stamp,dependency_digest,payload FROM analytics_effective_dependency_summaries').all()).results).toEqual(before);
  // The pure memo survives, but the old target authority pin cannot consume it.
  await expect(createEffectiveHistoryDayDependencyReader(attached(), owner, sourceId, [day]))
    .rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  await target().prepare("UPDATE analytics_owner_state SET state='withdrawn',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,owner.ownerDigest).run();
  expect(await target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries').first<number>('n')).toBe(0);
}, 120_000);

function observeSource(onCheapRead?:()=>Promise<void>) {
  let capabilities=0,cheapReads=0;
  const database=new Proxy(source(),{get(db,key){
    if(key==='prepare')return(sql:string)=>{
      if(/sqlite_schema|sqlite_master/u.test(sql))capabilities++;
      const cheap=sql.includes('sequence AS generation,method AS capabilityVersion')&&!sql.includes('sqlite_schema');
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,member){
        if(member==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
        if(member==='first'||member==='all')return async(...args:unknown[])=>{
          const result=await Reflect.apply(inner[member],inner,args);
          if(cheap&&++cheapReads===1)await onCheapRead?.();
          return result;
        };
        const value=Reflect.get(inner,member);return typeof value==='function'?value.bind(inner):value;
      }});
      return wrap(db.prepare(sql));
    };
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
  }});
  return {database,counts:()=>({capabilities,cheapReads})};
}

it('returns an exact sealed batch with constant capability scans and no warm native acquisition',async({annotate})=>{
  const days=corpus.historyDates,expected:string[]=[];
  for(const day of days)expected.push(await sha256Hex(canonicalJson(await reference(day,true))));
  const cold=await createEffectiveHistoryDayDependencyReader(attached(),owner,sourceId,days,{includeSessions:true,occurrenceLinks:'batched'});
  expect(await cold!.readDigests!()).toEqual(expected);
  const measured=async(batch:boolean)=>{
    const observed=observeSource(),profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
    const database=meter.wrap(attached(profileAnalyticsDatabase(observed.database,'source',profile,()=> 'warm'),
      profileAnalyticsDatabase(target(),'target',profile,()=> 'warm')));
    const reader=await createEffectiveHistoryDayDependencyReader(database,owner,sourceId,days,{includeSessions:true});
    const digests=batch?await reader!.readDigests!():await Promise.all(days.map(day=>reader!.readDigest(day)));
    expect(digests).toEqual(expected);
    const costs=summarizeAnalyticsProfile(profile);
    expect(costs.rawHistoryAccessStatements).toBe(0);expect(costs.rowsWritten).toBe(0);
    expect(costs.statements).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    return {...observed.counts(),statements:costs.statements,rowsRead:costs.rowsRead};
  };
  const individual=await measured(false),batch=await measured(true);
  expect(batch.cheapReads).toBe(Math.ceil(days.length/16));
  expect(batch.statements).toBeLessThan(individual.statements/2);
  expect(batch.capabilities).toBeLessThan(individual.capabilities/2);
  expect(batch.rowsRead).toBeLessThan(individual.rowsRead/2);
  await annotate(JSON.stringify({days:days.length,individual,batch}),'sealed-batch-local-cost');
  console.info('sealed-batch-local-cost',JSON.stringify({days:days.length,individual,batch}));
},120_000);

for(const change of ['capability','cold_capability','target','source'] as const)it(`refuses a batch when ${change} changes during cheap intermediate reads`,async()=>{
  const days=corpus.historyDates.slice(0,3);
  if(change!=='cold_capability'){
    const cold=await createEffectiveHistoryDayDependencyReader(attached(),owner,sourceId,days);
    expect(await cold!.readDigests!()).toHaveLength(days.length);
  }
  const observed=observeSource(async()=>{
    if(change==='capability'||change==='cold_capability')await source().prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
    if(change==='target')await target().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
      .bind(sourceId,owner.ownerDigest).run();
    if(change==='source')await corpus.appendOutsideV11();
  });
  const meter=createD1InvocationBudget(950);
  const reader=await createEffectiveHistoryDayDependencyReader(meter.wrap(attached(observed.database)),owner,sourceId,days);
  expect(await reader!.readDigests!()).toBeUndefined();
  expect(observed.counts().cheapReads).toBeGreaterThan(0);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(change==='capability')expect(await reader!.readDigest(days[0]!)).toBeUndefined();
  if(change==='cold_capability')expect(await target().prepare('SELECT count(*) AS n FROM analytics_effective_dependency_summaries').first<number>('n')).toBe(0);
},120_000);

it('rejects the held batch at a real accountless authorization expiry without a source mutation',async()=>{
  const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
  const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const payload=new Uint8Array(prefix.length+secret.length);payload.set(prefix);payload.set(secret,prefix.length);
  const deviceSecretHash=await sha256Hex(payload),authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  payload.fill(0);secret.fill(0);
  const expiresMs=Date.now()+60_000,enrolledMs=expiresMs-ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS;
  await enrollAccountlessDevice(source(),parseAccountlessEnrollmentRequest({schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    deviceId,deviceSecretHash}),enrolledMs);
  await createAccountlessUploadOwner(source(),authorization,parseAccountlessOwnershipRequest({
    schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION}),enrolledMs);
  const participantId=(await source().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?')
    .bind(deviceId).first<string>('participant_id'))!;
  await grantTelemetryV12AccountlessAuthorization(source(),{participantId,deviceId},
    parseTelemetryV12AccountlessAuthorizationRequest({schemaVersion:ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
      policyVersion:ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
      telemetrySchemaVersion:'telemetry-contribution-v1.2'}),enrolledMs);
  const principal={participantId,deviceId},day=corpus.historyDates[0]!;
  const manifest={schemaVersion:'telemetry-day-manifest-v1.2' as const,day,parserVersion:'synthetic-batch-expiry',
    consent:telemetryV12RequiredConsent(),chunks:[],excluded:{quota:0,session:0,usage:0},manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const ready=await registerTelemetryV12DayManifest(source(),principal,manifest);
  const predecessor=await createTelemetryV12DomainPredecessor(source(),principal);
  const domain={schemaVersion:'telemetry-domain-manifest-v1.2' as const,fromDay:day,throughDay:day,
    predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},
    days:[{day,manifestId:ready.manifestId,manifestDigest:ready.manifestDigest}],manifestDigest:'0'.repeat(64)};
  domain.manifestDigest=await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  await activateTelemetryV12Domain(source(),principal,domain);
  const selected=(await readStorageCommunityOwnerPage(source())).find(value=>value.participantId===participantId);
  expect(selected?.ownerDigest).toBeTruthy();owner=selected as typeof owner;
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')")
    .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  await drain();const days=corpus.historyDates.slice(0,2);
  const cold=await createEffectiveHistoryDayDependencyReader(attached(),owner,sourceId,days);
  expect(await cold!.readDigests!()).toHaveLength(days.length);
  const expires=await target().prepare('SELECT min(valid_until_ms) AS expiry FROM analytics_effective_dependency_summaries WHERE owner_digest=?')
    .bind(owner.ownerDigest).first<number>('expiry');
  expect(expires).toBe(expiresMs);
  const generation=()=>source().prepare('SELECT sequence FROM storage_effective_selective_runtime WHERE id=1').first<number>('sequence');
  const before=await generation();let clock:ReturnType<typeof vi.spyOn>|undefined;
  const observed=observeSource(async()=>{clock=vi.spyOn(Date,'now').mockReturnValue(expiresMs+1);});
  const meter=createD1InvocationBudget(950);
  const reader=await createEffectiveHistoryDayDependencyReader(meter.wrap(attached(observed.database)),owner,sourceId,days);
  try {expect(await reader!.readDigests!()).toBeUndefined();expect(clock).toBeDefined();}
  finally{clock?.mockRestore();}
  expect(await generation()).toBe(before);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},120_000);
