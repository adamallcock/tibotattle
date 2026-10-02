import {env,reset} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import * as canonical from '../src/storage-canonical-analytics-input';
import * as cachePairs from '../src/storage-canonical-cache-pairs';
import {advanceAnalyticsCacheWork} from '../src/storage-analytics-cache-work';
import {captureAnalyticsManifestWorkProof,captureAnalyticsManifestGroupProof} from '../src/storage-analytics-work-proof';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {captureAnalyticsManifestWorkProofReference} from './helpers/analytics-manifest-work-proof-reference';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import {materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartition} from '../src/storage-canonical-feature-contributions';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,readAnalyticsPartitionWork,completeAnalyticsPartitionWork} from '../src/storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {readStorageCanonicalSourceMembership} from '../src/storage-community-daily-devices';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-manifest-context',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
async function fixture(stage:'features'|'cache'='features') {
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:2,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
  participantId:corpus.participantId,maxSteps:64,maxRows:128})).status==='complete')break;
 const scope:canonical.CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
  participantId:corpus.participantId,day:corpus.equivalentDay,stream:'usage',selectionMethod:'effective-union-v1'};
 let sealed=false;
 for(let n=0;n<32;n++) {
  const p=await canonical.advanceCanonicalInputWork(source(),target(),{...scope,
   budget:{meter:createD1InvocationBudget(950),maxSteps:1,deadlineMs:Date.now()+60000,now:Date.now}});
  if(p.state==='complete'){sealed=true;break;}
 }
 expect(sealed).toBe(true);
 const key=await target().prepare('SELECT partition_key FROM analytics_canonical_facts WHERE source_id=? AND observed_day=? AND stream=? ORDER BY revision LIMIT 1')
  .bind(sourceId,scope.day,scope.stream).first<string>('partition_key');expect(key).toBeTruthy();
 const partition=await materializeCanonicalPartition(target(),key!);if(partition.state!=='complete')throw Error('unexpected split');
 const request={sourceId,ownerDigest:null,stage,lane:'new' as const,partitionKey:key!,headKey:'d'.repeat(64),
  inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day:scope.day,stream:scope.stream,
  selectionMethod:scope.selectionMethod,residentBytes:4*1024*1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target(),[request]);
 const [lease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});expect(lease).toBeTruthy();
 const work=await readAnalyticsPartitionWork(target(),lease!,Date.now());expect(work).toBeTruthy();
 return {scope,manifest:partition.manifest,lease:lease!,work:work!};
}
function invocation(f:Awaited<ReturnType<typeof fixture>>,queries=950) {
 const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(queries);
 const database=meter.wrap(profileAnalyticsDatabase(source(),'source',profile,()=> 'proof'));
 const db=meter.wrap(profileAnalyticsDatabase(target(),'target',profile,()=> 'proof'));
 return {profile,database,input:{...f,target:db,sources:[{sourceId,sourceNamespace:sourceId,database}],
  budget:{meter,now:Date.now,deadlineMs:Date.now()+60000,remainingQueries:()=>meter.remainingQueries}}};
}
it('reuses proof-owned tokens with exact prepared output and membership under full fresh seals',async({annotate})=>{
 const f=await fixture();
 const seeded=await materializeCanonicalFeaturePartition({target:target(),partitionKey:f.manifest.partitionKey,
  budget:{remainingQueries:()=>950,now:Date.now,deadlineMs:Date.now()+60000},stillCurrent:async()=>true});
 expect(seeded.state).toBe('complete');
 const observations=[];let expected:unknown;
 for(const mode of ['reference','context'] as const) {
  const {profile,database,input}=invocation(f);
  const proof=mode==='reference'?await captureAnalyticsManifestWorkProofReference(input):await captureAnalyticsManifestWorkProof(input);
  if(proof.state!=='complete')throw Error('proof not complete');
  const owned=mode==='context'?proof as Extract<Awaited<ReturnType<typeof captureAnalyticsManifestWorkProof>>,{state:'complete'}>:null;
  try {
   const context=owned?.contextFor(database,input.target,f.scope);
   if(mode==='context')expect(context).toBeTruthy();
   const membership=await canonical.readCanonicalInputMembership(database,input.target,f.scope,readStorageCanonicalSourceMembership,context??undefined);
   expect(membership.state).toBe('complete');
   const feature=await materializeCanonicalFeaturePartition({target:input.target,partitionKey:f.manifest.partitionKey,
    budget:input.budget,stillCurrent:proof.stillCurrent});
   expect(feature.state).toBe('complete');expect(await proof.stillCurrent()).toBe(true);
   const output={membership,feature};if(mode==='reference')expected=output;else expect(output).toEqual(expected);
   observations.push({mode,...summarizeAnalyticsProfile(profile)});
  }finally{owned?.close();}
  expect(input.budget.meter.queriesUsed).toBeLessThanOrEqual(950);
 }
 const [reference,current]=observations;
 expect(current!.statements).toBeLessThan(reference!.statements);
 expect(current!.rowsRead).toBeLessThan(reference!.rowsRead);
 await annotate(JSON.stringify(observations.map(v=>({mode:v.mode,statements:v.statements,rowsRead:v.rowsRead,rowsWritten:v.rowsWritten}))),
  'manifest-context-full-proof-component-cost');
},120000);
it('refuses foreign, schema-lost, mutated and closed contexts while retaining full seal checks',async()=>{
 const f=await fixture(),{database,input}=invocation(f),proof=await captureAnalyticsManifestWorkProof(input);
 if(proof.state!=='complete')throw Error('proof not complete');
 const context=proof.contextFor(database,input.target,f.scope);expect(context).toBeTruthy();
 try {
  expect(proof.contextFor(source(),input.target,f.scope)).toBeNull();
  expect(proof.contextFor(database,target(),f.scope)).toBeNull();
  expect(proof.contextFor(database,input.target,{...f.scope,ownerDigest:'f'.repeat(64)})).toBeNull();
  expect(proof.contextFor(database,input.target,{...f.scope,selectionMethod:'legacy-selected-v1'})).toBeNull();
  for(const [db,name] of [[source(),'storage_effective_selective_sequence_guard'],[target(),'analytics_canonical_input_seal']] as const) {
   const sql=await db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").bind(name).first<string>('sql');expect(sql).toBeTruthy();
   await db.prepare('DROP TRIGGER '+name).run();
   try {expect(await proof.stillCurrent()).toBe(false);}finally{await db.prepare(sql!).run();}
   expect(await proof.stillCurrent()).toBe(true);
  }
  await source().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1').run();
  expect(await proof.stillCurrent()).toBe(false);
 }finally{proof.close();proof.close();}
 expect(proof.contextFor(database,input.target,f.scope)).toBeNull();expect(await proof.canCommit()).toBe(false);
 expect(await canonical.readCanonicalInputSeal(database,input.target,f.scope,context!)).toBeNull();
},120000);
it('closes an acquired context on failed initial seal and synchronous budget exhaustion',async()=>{
 const f=await fixture();
 for(const failure of ['deferred','budget'] as const) {
  const {input}=invocation(f),created:canonical.CanonicalInputReadContext[]=[];
  const create=canonical.createCanonicalInputReadContext,seal=canonical.readCanonicalInputSeal;
  const capture=vi.spyOn(canonical,'createCanonicalInputReadContext').mockImplementation(async(...args)=>{
   const value=await create(...args);if(value)created.push(value);return value;});
  const rejected=vi.spyOn(canonical,'readCanonicalInputSeal').mockImplementation(async()=>{
   if(failure==='budget')throw new D1InvocationBudgetExceededError();return null;});
  try {
   if(failure==='budget')await expect(captureAnalyticsManifestWorkProof(input)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
   else expect(await captureAnalyticsManifestWorkProof(input)).toEqual({state:'deferred',reason:'canonical_input_unsealed'});
   expect(created).toHaveLength(1);
  }finally{capture.mockRestore();rejected.mockRestore();}
  expect(await seal(input.sources[0]!.database,input.target,f.scope,created[0]!)).toBeNull();
 }
},120000);

it('closes concrete cache consumer contexts on deferral, error and complete output',async()=>{
 const f=await fixture('cache');
 for(const mode of ['deferred','error','complete'] as const) {
  const {input}=invocation(f),created:canonical.CanonicalInputReadContext[]=[];
  const create=canonical.createCanonicalInputReadContext,materialize=cachePairs.materializeCanonicalCachePartition;
  const capture=vi.spyOn(canonical,'createCanonicalInputReadContext').mockImplementation(async(...args)=>{
   const context=await create(...args);if(context)created.push(context);return context;});
  const execution=vi.spyOn(cachePairs,'materializeCanonicalCachePartition').mockImplementation(async options=>{
   if(mode==='error')throw new Error('synthetic consumer failure');
   if(mode==='complete')return materialize(options);
   return {state:'deferred',reason:'query_budget',metrics:{slotsWritten:0,logicalRepairs:0,pairRepairs:0,pairEvaluations:0,sourceRecordDecodes:0}};
  });
  try {
   if(mode==='error')await expect(advanceAnalyticsCacheWork(input)).rejects.toThrow('synthetic consumer failure');
   else expect(await advanceAnalyticsCacheWork(input)).toMatchObject({outcome:mode==='complete'?'complete':'deferred'});
   expect(created).toHaveLength(1);
  }finally{capture.mockRestore();execution.mockRestore();}
  expect(await canonical.readCanonicalInputSeal(input.sources[0]!.database,input.target,f.scope,created[0]!)).toBeNull();
 }
},120000);
it('expires a real bounded proof context without changing the operational clock',async()=>{
 const f=await fixture(),{input}=invocation(f);input.budget.deadlineMs=Date.now()+1000;
 const proof=await captureAnalyticsManifestWorkProof(input);if(proof.state!=='complete')throw Error('proof not complete');
 try {
  expect(await proof.stillCurrent()).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,Math.max(1,input.budget.deadlineMs-Date.now()+5)));
  expect(await proof.stillCurrent()).toBe(false);
 }finally{proof.close();}
},120000);

async function groupFixture(mixedOwner=false) {
 const f=await fixture();
 let otherScope:canonical.CanonicalInputScope={...f.scope,day:new Date(Date.parse(f.scope.day+'T00:00:00Z')-86400000).toISOString().slice(0,10)};
 if(mixedOwner) {
  const owner=(await readStorageCommunityOwnerPage(source())).find(owner=>owner.ownerDigest&&owner.ownerDigest!==f.scope.ownerDigest)!;
  expect(owner).toBeTruthy();
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')")
   .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128})).status==='complete')break;
  otherScope={...f.scope,ownerDigest:owner.ownerDigest!,participantId:owner.participantId};
 }
 let sealed=false;
 for(let n=0;n<32;n++)if((await canonical.advanceCanonicalInputWork(source(),target(),{...otherScope,
  budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60000}})).state==='complete'){sealed=true;break;}
 expect(sealed).toBe(true);
 const second=await target().prepare('SELECT partition_key FROM analytics_canonical_facts WHERE source_id=? AND observed_day=? AND stream=? AND owner_digest=? AND partition_key!=? ORDER BY partition_key LIMIT 1')
  .bind(sourceId,otherScope.day,otherScope.stream,otherScope.ownerDigest,f.manifest.partitionKey).first<string>('partition_key');
 expect(second).toBeTruthy();
 const initial=await materializeCanonicalPartition(target(),f.manifest.partitionKey);if(initial.state!=='complete')throw Error('split');
 const partition=await materializeCanonicalPartition(target(),second!);if(partition.state!=='complete')throw Error('split');
 const {workKey:_key,attempts:_attempts,...request}=f.work;
 await admitAnalyticsPartitionWork(target(),[{...request,partitionKey:second!,day:otherScope.day,headKey:'e'.repeat(64),inputRevision:partition.manifest.contentRevision}]);
 const [lease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});expect(lease).toBeTruthy();
 const work=await readAnalyticsPartitionWork(target(),lease!,Date.now());expect(work).toBeTruthy();
 return {...f,otherScope,members:[{lease:f.lease,work:f.work,manifest:initial.manifest},{lease:lease!,work:work!,manifest:partition.manifest}]};
}
it('shares group contexts yet requires exact complete receipts and each adopting member live',async()=>{
 const f=await groupFixture(),{input}=invocation(f);
 const proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});
 if(proof.state!=='complete')throw Error('group proof not complete');
 const first=proof.forMember(f.members[0]!.work.workKey)!,second=proof.forMember(f.members[1]!.work.workKey)!;
 try {
  expect(proof.forMember('f'.repeat(64))).toBeNull();expect(await proof.canCommit()).toBe(true);expect(await proof.stillCurrent()).toBe(true);
  for(const member of f.members) {
   const own=proof.forMember(member.work.workKey)!;
   expect(await own.stillCurrent()).toBe(true);
   const feature=await materializeCanonicalFeaturePartition({target:input.target,partitionKey:member.manifest.partitionKey,
    budget:input.budget,stillCurrent:own.stillCurrent});
   expect(feature.state).toBe('complete');
   expect(await completeAnalyticsPartitionWork(input.target,member.lease,[],Date.now())).toBe(true);
   expect(await own.canCommit()).toBe(false);expect(await own.stillCurrent()).toBe(false);
   expect(await proof.canCommit()).toBe(true);expect(await proof.stillCurrent()).toBe(true);
  }
  expect(await first.canCommit()).toBe(false);expect(await second.canCommit()).toBe(false);
  await target().prepare("UPDATE analytics_partition_work SET revision=revision+1,updated_ms=? WHERE work_key=?")
   .bind(Date.now(),f.members[0]!.work.workKey).run();
  expect(await proof.canCommit()).toBe(false);expect(await proof.stillCurrent()).toBe(false);
 }finally{proof.close();}
 expect(await proof.canCommit()).toBe(false);
 expect(proof.forMember(f.members[0]!.work.workKey)).toBeNull();
 expect(await captureAnalyticsManifestGroupProof({...input,members:f.members})).toEqual({state:'deferred',reason:'lease_changed'});
},120000);
it('separates two owner contexts on one binding and refuses cross-owner reuse or source mutation',async()=>{
 const f=await groupFixture(true),{input,database}=invocation(f),created:canonical.CanonicalInputReadContext[]=[];
 const create=canonical.createCanonicalInputReadContext;
 const capture=vi.spyOn(canonical,'createCanonicalInputReadContext').mockImplementation(async(...args)=>{
  const context=await create(...args);if(context)created.push(context);return context;});
 let proof:Awaited<ReturnType<typeof captureAnalyticsManifestGroupProof>>;
 try {proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});}finally{capture.mockRestore();}
 if(proof.state!=='complete')throw Error('mixed group proof not complete');
 try {
  expect(created).toHaveLength(2);
  const primary=proof.contextFor(database,input.target,f.scope),other=proof.contextFor(database,input.target,f.otherScope!);
  expect(primary).toBeTruthy();expect(other).toBeTruthy();expect(primary).not.toBe(other);
  expect(await canonical.readCanonicalInputSeal(database,input.target,f.otherScope!,primary!)).toBeNull();
  expect(await proof.stillCurrent()).toBe(true);
  await source().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1').run();
  expect(await proof.stillCurrent()).toBe(false);
 }finally{proof.close();}
 for(const context of created)expect(await canonical.readCanonicalInputSeal(database,input.target,f.scope,context)).toBeNull();
},120000);

it('refuses group capacity, expired member leases and changed original partition generations',async()=>{
 const f=await groupFixture(),{input}=invocation(f);
 expect(await captureAnalyticsManifestGroupProof({...input,members:[]})).toEqual({state:'refused',reason:'group_capacity'});
 expect(await captureAnalyticsManifestGroupProof({...input,members:Array(9).fill(f.members[0]!)})).toEqual({state:'refused',reason:'group_capacity'});
 expect(await captureAnalyticsManifestGroupProof({...input,members:[f.members[0]!,f.members[0]!]})).toEqual({state:'refused',reason:'group_capacity'});
 const oversized={...f.members[0]!,manifest:{...f.members[0]!.manifest,rowCount:17,
  rows:Array.from({length:17},(_,i)=>({...f.members[0]!.manifest.rows[0]!,revision:i.toString(16).padStart(64,'0')}))}};
 expect(await captureAnalyticsManifestGroupProof({...input,members:[oversized]})).toEqual({state:'refused',reason:'group_capacity'});
 for(const field of ['revision','occurrenceKey'] as const) {
  const duplicate={...f.members[1]!,manifest:{...f.members[1]!.manifest,
   rows:f.members[1]!.manifest.rows.map((row,index)=>index===0?{...row,[field]:f.members[0]!.manifest.rows[0]![field]}:row)}};
  expect(await captureAnalyticsManifestGroupProof({...input,members:[f.members[0]!,duplicate]})).toEqual({state:'refused',reason:'group_capacity'});
 }
 const proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});
 if(proof.state!=='complete')throw Error('group proof not complete');
 try {
  expect(await proof.stillCurrent()).toBe(true);
  const now=input.budget.now;input.budget.now=()=>Math.max(...f.members.map(member=>member.lease.expiresAtMs))+1;
  expect(await proof.forMember(f.members[0]!.work.workKey)!.canCommit()).toBe(false);expect(await proof.canCommit()).toBe(false);
  expect(await proof.stillCurrent()).toBe(false);input.budget.now=now;
  expect(await proof.stillCurrent()).toBe(true);
  await target().prepare(`UPDATE analytics_canonical_dirty_partitions SET generation=generation+1 WHERE partition_key=
   (SELECT root_partition_key FROM analytics_canonical_manifests WHERE content_revision=?)`)
   .bind(f.members[0]!.manifest.contentRevision).run();
  expect(await proof.stillCurrent()).toBe(false);
  expect(await proof.canCommit()).toBe(false);expect(await proof.forMember(f.members[1]!.work.workKey)!.stillCurrent()).toBe(false);
 }finally{proof.close();}
},120000);

it('keeps the private joint predicate target-only and refuses physical erasure without masking the full source fence',async()=>{
 const f=await groupFixture(true),{input,profile}=invocation(f);
 const proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});
 if(proof.state!=='complete')throw Error('group proof not complete');
 try {
  const sourceStatements=()=>Object.entries(profile.costs).filter(([key])=>key.includes('.source.')).reduce((sum,[,value])=>sum+value.statements,0);
  const before=summarizeAnalyticsProfile(profile),sourceBefore=sourceStatements();
  expect(await proof.canCommit()).toBe(true);
  const after=summarizeAnalyticsProfile(profile);expect(after.statements-before.statements).toBe(1);
  expect(sourceStatements()).toBe(sourceBefore);
  await source().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1').run();
  expect(await proof.canCommit()).toBe(true);expect(await proof.stillCurrent()).toBe(false);
  await target().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
   .bind(sourceId,f.scope.ownerDigest).run();
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?').bind(f.scope.ownerDigest).first<number>('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?').bind(f.otherScope.ownerDigest).first<number>('n')).toBeGreaterThan(0);
  expect(await proof.canCommit()).toBe(false);
 }finally{proof.close();}
},120000);
it('refuses private preparation after original head removal or exact member lease replacement',async()=>{
 const f=await groupFixture(),{input}=invocation(f);
 const proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});
 if(proof.state!=='complete')throw Error('group proof not complete');
 try {
  expect(await proof.canCommit()).toBe(true);
  const member=f.members[0]!;
  await target().prepare('DELETE FROM analytics_canonical_partition_heads WHERE partition_key=?').bind(member.manifest.partitionKey).run();
  expect(await proof.canCommit()).toBe(false);
  await target().prepare('INSERT INTO analytics_canonical_partition_heads(partition_key,content_revision) VALUES(?,?)')
   .bind(member.manifest.partitionKey,member.manifest.contentRevision).run();
  expect(await proof.canCommit()).toBe(true);
  await target().prepare("UPDATE analytics_partition_work SET revision=revision+1,claim_token=? WHERE work_key=? AND state='leased'")
   .bind(crypto.randomUUID(),member.work.workKey).run();
  expect(await proof.canCommit()).toBe(false);expect(await proof.forMember(member.work.workKey)!.canCommit()).toBe(false);
 }finally{proof.close();}
},120000);
it('expires the private joint predicate with its real bounded context deadline',async()=>{
 const f=await groupFixture(),{input}=invocation(f);input.budget.deadlineMs=Date.now()+1000;
 const proof=await captureAnalyticsManifestGroupProof({...input,members:f.members});
 if(proof.state!=='complete')throw Error('group proof not complete');
 try {
  expect(await proof.canCommit()).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,Math.max(1,input.budget.deadlineMs-Date.now()+5)));
  expect(await proof.canCommit()).toBe(false);expect(await proof.stillCurrent()).toBe(false);
 }finally{proof.close();}
},120000);
