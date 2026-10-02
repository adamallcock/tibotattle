import { env, reset } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import * as canonicalFacts from '../src/canonical-analytics-facts';
import * as nativeReader from '../src/telemetry-usage-effective-reader';
import * as legacySource from '../src/canonical-analytics-legacy-source';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { createAnalyticsProfile, profileAnalyticsDatabase } from './helpers/analytics-profile';
import { advanceCanonicalInputWork, readCanonicalInputSeal, readCanonicalInputMembership, readCanonicalInputFactPage,
  createCanonicalInputReadContext, closeCanonicalInputReadContext, canonicalInputReadContextCurrent,
  readCanonicalInputPreparationSeal, readCanonicalInputPreparationFactPage, type CanonicalInputReadContext, type CanonicalInputFactPage,
  CANONICAL_INPUT_MEMBERSHIP_SCHEMA, CANONICAL_INPUT_MEMBERSHIP_METHOD, type CanonicalInputScope } from '../src/storage-canonical-analytics-input';
import { readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage } from '../src/telemetry-usage-effective-reader';
import { advanceEffectiveDependencyCoverage, readEffectiveScopeMutationToken } from '../src/storage-effective-selective-dependencies';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

const bindings=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-canonical-input';
const source=()=>bindings.USAGE_MONITOR_DB,target=()=>bindings.STORAGE_ANALYTICS_DB;
async function coverage(participantId:string,ownerDigest:string,day:string,includeSessions=false):Promise<void> {
  for(let attempt=0;attempt<48;attempt++) {
    const token=await readEffectiveScopeMutationToken(source(),{sourceId,sourceNamespace:sourceId,
      participantId,ownerDigest,fromDay:day,throughDay:day,includeSessions});
    if(token)return;
    const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
      participantId,maxSteps:64,maxRows:128});
    expect(progress.status).not.toBe('unavailable');
  }
  throw new Error('synthetic source coverage did not seal');
}
async function advance(scope:CanonicalInputScope,maxSteps=1) {
  return advanceCanonicalInputWork(source(),target(),{...scope,budget:{meter:createD1InvocationBudget(900),
    maxSteps,deadlineMs:Date.now()+40_000,now:Date.now}});
}
async function complete(scope:CanonicalInputScope) {
  const seen=[];
  for(let n=0;n<20;n++) {
    const progress=await advance(scope,1);seen.push(progress);
    if(progress.state==='complete')return {progress,seen};
    expect(progress.state).toBe('progress');
  }
  throw new Error('canonical input did not seal');
}

it('resumes more than one native page, seals exact membership and reuses the accepted proof',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,
    sourceNamespace:sourceId,calendarDays:25,graphDays:2,denseUsageRows:20,
    anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const day=corpus.graphDates[0]!,owner=corpus.owner;
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,day);
  const native=await readEffectiveUsageOwnerDayPage(source(),{sourceNamespace:sourceId,
    ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
    day,limit:200});
  expect(native.rows.length).toBeGreaterThan(16);
  const first=await advance(scope,1);
  expect(first.state).toBe('progress');expect(first.pages).toBe(1);
  const finished=await complete(scope);
  expect(finished.seen.length).toBeGreaterThanOrEqual(2);
  expect(finished.progress.seal).toMatchObject({empty:false,seenCount:native.rows.length,day,stream:'usage'});
  const facts=(await target().prepare(`SELECT f.occurrence_key,f.native_order FROM analytics_canonical_facts f
    JOIN analytics_canonical_heads h ON h.revision=f.revision WHERE f.source_id=? AND f.owner_digest=?
      AND f.stream='usage' AND f.observed_day=? ORDER BY f.observed_at_ms,f.native_order`)
    .bind(sourceId,owner.ownerDigest,day).all<{occurrence_key:string;native_order:number}>()).results;
  expect(facts.length).toBe(native.rows.length);
  expect(await readCanonicalInputSeal(source(),target(),scope)).toEqual(finished.progress.seal);
  const firstRefs=await readCanonicalInputFactPage(source(),target(),scope,{limit:16});
  expect(firstRefs!.refs.length).toBe(16);expect(firstRefs!.next).not.toBeNull();
  const discovered=[...firstRefs!.refs];let afterKey=firstRefs!.next;
  for(let page=0;page<20&&afterKey!==null;page++){
    const next=await readCanonicalInputFactPage(source(),target(),scope,{limit:16,afterKey});
    expect(next!.refs.length).toBeLessThanOrEqual(16);discovered.push(...next!.refs);afterKey=next!.next;
  }
  expect(afterKey).toBeNull();expect(discovered.length).toBe(native.rows.length);
  expect(new Set(discovered.map(row=>row.occurrenceKey)).size).toBe(native.rows.length);
  expect(await readCanonicalInputMembership(source(),target(),scope)).toEqual({state:'unavailable',reason:'reader_unavailable'});
  const membership=await readCanonicalInputMembership(source(),target(),scope,async(_source,identity)=>{
    expect(identity.participantId).toBe(owner.participantId);
    return {schema:CANONICAL_INPUT_MEMBERSHIP_SCHEMA,contributorKey:'a'.repeat(64),
      deviceKeys:['b'.repeat(64)],method:CANONICAL_INPUT_MEMBERSHIP_METHOD,
      dependencyRevision:'c'.repeat(64),sourceDay:day,selectionMethod:'effective-union-v1',
      sourceToken:identity.sourceStamp,coverage:'complete'};
  });
  expect(membership).toMatchObject({state:'complete',deviceKeys:['b'.repeat(64)],sourceDay:day});
  expect(JSON.stringify(membership)).not.toContain(owner.participantId);
  const receipts=await target().prepare('SELECT count(*) n FROM analytics_canonical_pages').first<number>('n');
  const replay=await advance(scope,1);
  expect(replay).toMatchObject({state:'complete',pages:0,effects:[]});
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_pages').first<number>('n')).toBe(receipts);
  const serialized=JSON.stringify((await target().prepare('SELECT * FROM analytics_canonical_input_pending').all()).results)
    +JSON.stringify((await target().prepare('SELECT * FROM analytics_canonical_input_work').all()).results);
  expect(serialized).not.toContain(native.rows[0]!.occurrenceId);
  expect(serialized).not.toContain(owner.participantId);
},120_000);

it('requires an explicit empty page, reuses unchanged narrow content under a fresh owner pin and clears terminal state',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,
    sourceNamespace:sourceId,calendarDays:14,graphDays:2,
    anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const owner=corpus.owner,emptyDay=corpus.historyDates.find(day=>!corpus.populatedDates.includes(day))!;
  expect(emptyDay).toBeTruthy();
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    participantId:owner.participantId,day:emptyDay,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,emptyDay);
  const sealed=await complete(scope);
  expect(sealed.progress.seal).toMatchObject({empty:true,seenCount:0});
  expect(await readCanonicalInputFactPage(source(),target(),scope)).toMatchObject({refs:[],next:null,seal:{empty:true}});
  expect(sealed.seen.some(value=>value.pages===1)).toBe(true);
  const legacyScope={...scope,selectionMethod:'legacy-selected-v1' as const};
  const sealedLegacy=await complete(legacyScope);
  const before=sealed.progress.seal!.ownerRevision;
  await corpus.appendV11Day(corpus.v11DomainThroughDay);
  await coverage(scope.participantId,scope.ownerDigest,emptyDay);
  const nativePage=vi.spyOn(nativeReader,'readEffectiveUsageOwnerDayPage');
  const legacyPage=vi.spyOn(legacySource,'readCanonicalLegacySourcePage');
  const normalize=vi.spyOn(canonicalFacts,'normalizeNativeEffectiveOccurrence');
  try {
    const current=await readCanonicalInputSeal(source(),target(),scope);
    expect(current!.sourceStamp).toBe(sealed.progress.seal!.sourceStamp);
    expect(current!.ownerRevision).not.toBe(before);
    let called=false;
    expect(await readCanonicalInputMembership(source(),target(),scope,async()=>{called=true;return null;}))
      .toEqual({state:'unavailable',reason:'membership_unavailable'});
    expect(called).toBe(true);
    const refreshed=await complete(scope);
    expect(refreshed.progress).toMatchObject({state:'complete',pages:0,effects:[]});
    expect(refreshed.progress.seal!.ownerRevision).not.toBe(before);
    const legacyReused=await advance(legacyScope,1);
    expect(legacyReused).toMatchObject({state:'complete',pages:0,effects:[]});
    expect(legacyReused.seal!.sourceStamp).toBe(sealedLegacy.progress.seal!.sourceStamp);
    expect(legacyReused.seal!.ownerRevision).not.toBe(before);
    expect(nativePage).not.toHaveBeenCalled();expect(legacyPage).not.toHaveBeenCalled();expect(normalize).not.toHaveBeenCalled();
  }finally{nativePage.mockRestore();legacyPage.mockRestore();normalize.mockRestore();}
  await target().prepare(`UPDATE analytics_owner_state SET state='erased',revision=revision+1,
    authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?`).bind(sourceId,owner.ownerDigest).run();
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_input_work').first<number>('n')).toBe(0);
  expect(await readCanonicalInputSeal(source(),target(),scope)).toBeNull();
  expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);

it('reconciles a late correction and withdraws a prior head absent from the new sealed day',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,
    sourceNamespace:sourceId,calendarDays:25,graphDays:2,
    anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const owner=corpus.owner,day=corpus.correctionDay;
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,day);
  const initial=await complete(scope);
  const {canonicalOccurrenceKey,normalizeNativeEffectiveOccurrence}=await import('../src/canonical-analytics-facts');
  const {canonicalTelemetryV11Json}=await import('@app-usagemonitor/telemetry-contract');
  const {v11UsageRecord}=await import('./helpers/telemetry-v11');
  const {materializeCanonicalPage,readCanonicalFacts}=await import('../src/storage-canonical-analytics-facts');
  const {sha256Hex}=await import('../src/crypto');
  const key=await canonicalOccurrenceKey({sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    selectionMethod:'effective-union-v1'},'usage',corpus.correctionOccurrenceId);
  const oldRevision=await target().prepare(`SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=?
    AND selection_method='effective-union-v1'`).bind(key).first<string>('revision');
  expect(oldRevision).toBeTruthy();
  const phantomId=`event:v2:${'f'.repeat(64)}`;
  const makePhantom=async(selectedDay:string,id:string)=>{
    const record=v11UsageRecord(selectedDay,'f',{eventId:id,eventTime:`${selectedDay}T15:00:00.000Z`});
    return normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,selectionMethod:'effective-union-v1'},
      {methodVersion:'effective-usage-owner-day-v1',participantId:owner.participantId,ownerDigest:owner.ownerDigest,
        occurrenceId:id,eventTime:record.eventTime,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],
        sourceRowIds:[9001],sourceRecordKeys:['v11:synthetic-prior'],correctionHistoryIds:[],recordJson:null,
        analyticalRecordJson:canonicalTelemetryV11Json(record),canonicalEvidence:{linkedDays:[selectedDay],
          variants:[{coordinate:'v11:synthetic-prior:'+id,format:'v11',observedAtMs:Date.parse(record.eventTime)}],
          boundaryFlags:{presence:'unknown',value:null},tieOrder:{presence:'unknown',value:null},
          cacheWriteFiveMinuteTokens:{presence:'unknown',value:null},cacheWriteOneHourTokens:{presence:'unknown',value:null}}},0);
  };
  const phantom=await makePhantom(day,phantomId),racedId=`event:v2:${'e'.repeat(64)}`,
    raceBefore=await makePhantom(day,racedId),movedDay=new Date(Date.parse(day+'T00:00:00.000Z')+86_400_000).toISOString().slice(0,10),
    raceAfter=await makePhantom(movedDay,racedId);
  await materializeCanonicalPage({db:target(),sourceId,
    scope:{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,selectionMethod:'effective-union-v1'},
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
    pageKey:await sha256Hex('synthetic-prior-page'),sourceRevision:await sha256Hex('synthetic-prior-proof'),
    stillCurrent:async()=>true,load:async()=>[phantom,raceBefore].map(fact=>({occurrenceKey:fact.occurrenceKey,
      stream:'usage' as const,expectedRevision:null,fact}))});
  const changedOwner=await corpus.mutateCorrection();
  await coverage(scope.participantId,scope.ownerDigest,day);
  expect(await readCanonicalInputSeal(source(),target(),scope)).toBeNull();
  let raced=false;const earlyProgress=[];
  const racingTarget=interceptBatches(target(),async(queries,run)=>{
    if(!raced&&queries.some(sql=>sql.includes('INSERT INTO analytics_canonical_effects'))
      &&!queries.some(sql=>sql.includes('INSERT INTO analytics_canonical_facts'))){
      raced=true;
      await materializeCanonicalPage({db:target(),sourceId,scope,ownerRevision:changedOwner.ownerRevision,
        authorityEpoch:changedOwner.authorityEpoch,pageKey:await sha256Hex('synthetic-concurrent-move'),
        sourceRevision:await sha256Hex('synthetic-concurrent-move-proof'),stillCurrent:async()=>true,
        load:async()=>[{occurrenceKey:raceAfter.occurrenceKey,stream:'usage',expectedRevision:raceBefore.revision,fact:raceAfter}]});
    }
    return run();
  });
  for(let attempt=0;attempt<20&&!raced;attempt++){
    try{earlyProgress.push(await advanceCanonicalInputWork(source(),racingTarget,{...scope,budget:{meter:createD1InvocationBudget(900),
      maxSteps:1,deadlineMs:Date.now()+40_000,now:Date.now}}));}
    catch(error){expect(raced).toBe(true);expect(error).toMatchObject({code:'CANONICAL_CONFLICT'});}
  }
  expect(raced).toBe(true);
  expect(await target().prepare('SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=?')
    .bind(phantom.occurrenceKey).first<string>('revision')).toBe(phantom.revision); // stale batch rolled back in full
  const finished=await complete(scope),changed={...finished,seen:[...earlyProgress,...finished.seen]};
  expect(await target().prepare('SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=?')
    .bind(raceAfter.occurrenceKey).first<string>('revision')).toBe(raceAfter.revision);
  const revision=await target().prepare(`SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=?
    AND selection_method='effective-union-v1'`).bind(key).first<string>('revision');
  expect(revision).toBeTruthy();expect(revision).not.toBe(oldRevision);
  const corrected=(await readCanonicalFacts(target(),[revision!]))[0]!;
  expect(corrected.values.totalInputContextTokens).toBeGreaterThan(0);
  expect(changed.seen.flatMap(value=>value.effects).some(effect=>effect.kind==='replace'
    && effect.occurrenceKey===key&&effect.old?.revision===oldRevision&&effect.new?.revision===revision)).toBe(true);
  expect(changed.seen.flatMap(value=>value.effects).some(effect=>effect.kind==='withdraw'
    && effect.occurrenceKey===phantom.occurrenceKey&&effect.old?.revision===phantom.revision)).toBe(true);
  expect(await target().prepare(`SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=?
    AND selection_method='effective-union-v1'`).bind(phantom.occurrenceKey).first<string>('revision')).toBeNull();
  expect(changed.progress.seal).toMatchObject({ownerRevision:changedOwner.ownerRevision,empty:false});
},120_000);


/** Inject failure at an actual D1 boundary without replacing database semantics. */
function interceptBatches(database:D1Database, intercept:(queries:readonly string[],run:()=>Promise<D1Result[]>)=>Promise<D1Result[]>):D1Database {
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>(),queries=new WeakMap<D1PreparedStatement,string>();
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,key){
      if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values),sql);
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});originals.set(proxy,statement);queries.set(proxy,sql);return proxy;
  };
  return new Proxy(database,{get(target,key){
    if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql),sql);
    if(key==='batch')return (statements:D1PreparedStatement[])=>intercept(statements.map(s=>queries.get(s)!),()=>target.batch(statements.map(s=>originals.get(s)!)));
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}

it('recovers a lost durable page response without repeating native normalization',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:10,graphDays:2,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
    participantId:corpus.owner.participantId,day:corpus.equivalentDay,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,scope.day);
  let interrupted=false;
  const faulty=interceptBatches(target(),async(queries,run)=>{
    const result=await run();
    if(!interrupted&&queries.some(sql=>sql.includes('INSERT INTO analytics_canonical_pages'))){interrupted=true;throw new Error('synthetic lost response');}
    return result;
  });
  await expect(advanceCanonicalInputWork(source(),faulty,{...scope,budget:{meter:createD1InvocationBudget(900),maxSteps:1,
    deadlineMs:Date.now()+40_000,now:Date.now}})).rejects.toMatchObject({code:'CANONICAL_CONFLICT'});
  expect(interrupted).toBe(true);
  expect(await target().prepare("SELECT count(*) n FROM analytics_canonical_pages WHERE state='complete'").first<number>('n')).toBe(1);
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_input_pending').first<number>('n')).toBe(1);
  const normalize=vi.spyOn(canonicalFacts,'normalizeNativeEffectiveOccurrence');
  try {
    const recovered=await advance(scope,1);
    expect(recovered).toMatchObject({state:'progress',pages:1});
    expect(normalize).not.toHaveBeenCalled();
  } finally {normalize.mockRestore();}
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_input_pending').first<number>('n')).toBe(0);
  const sealed=await complete(scope);expect(sealed.progress.seal!.seenCount).toBeGreaterThan(0);
},120_000);

it('rejects an expired lease at the atomic receipt boundary and resumes the retained pending page',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:10,graphDays:2,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
    participantId:corpus.owner.participantId,day:corpus.equivalentDay,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,scope.day);
  let expired=false;
  const faulty=interceptBatches(target(),async(queries,run)=>{
    if(!expired&&queries.some(sql=>sql.includes('INSERT INTO analytics_canonical_pages'))){expired=true;
      await target().prepare('UPDATE analytics_canonical_input_work SET claim_expires_ms=1').run();}
    return run();
  });
  await expect(advanceCanonicalInputWork(source(),faulty,{...scope,budget:{meter:createD1InvocationBudget(900),maxSteps:1,
    deadlineMs:Date.now()+40_000,now:Date.now}})).rejects.toMatchObject({code:'CANONICAL_CONFLICT'});
  expect(expired).toBe(true);
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_pages').first<number>('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_input_pending').first<number>('n')).toBe(1);
  expect((await complete(scope)).progress.seal!.seenCount).toBeGreaterThan(0);
},120_000);


it('materializes native quota/session values and isolates an admitted second subject with the same ID',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:10,graphDays:2,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const {readCanonicalFacts}=await import('../src/storage-canonical-analytics-facts');
  for(const [stream,day] of [['quota',corpus.modelFitDates[0]!],['session',corpus.sessionDay]] as const){
    const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
      participantId:corpus.owner.participantId,day,stream,selectionMethod:'effective-union-v1'};
    await coverage(scope.participantId,scope.ownerDigest,day,stream==='session');
    const native=await readEffectiveTelemetryOwnerDayPage(source(),{sourceNamespace:sourceId,
      ownerDigest:scope.ownerDigest,ownerRevision:corpus.owner.ownerRevision,authorityEpoch:corpus.owner.authorityEpoch,day,stream,limit:16});
    const completed=await complete(scope);expect(completed.progress.seal!.seenCount).toBe(native.rows.length);
    expect(native.rows.length).toBeGreaterThan(0);
    const revisions=(await target().prepare(`SELECT f.revision FROM analytics_canonical_heads h JOIN analytics_canonical_facts f
      ON f.revision=h.revision WHERE f.owner_digest=? AND f.stream=? AND f.observed_day=?`)
      .bind(scope.ownerDigest,stream,day).all<{revision:string}>()).results.map(row=>row.revision);
    const facts=await readCanonicalFacts(target(),revisions);
    expect(facts.length).toBe(native.rows.length);
    for(const row of native.rows){
      const key=await canonicalFacts.canonicalOccurrenceKey(scope,stream,row.occurrenceId);
      const fact=facts.find(f=>f.occurrenceKey===key)!;const record=JSON.parse(row.recordJson!);
      if(stream==='quota'){
        expect(fact.values.usedPercent).toBe(record.usedPercent);expect(fact.values.resetsAtMs).toBe(Date.parse(record.resetsAt));
        expect(fact.nativeScopes.accountTrackId).toBe(record.accountPlanAttribution.accountTrackId);
      }else expect(Object.fromEntries(fact.toolCounts.map(item=>[item.toolClass,item.count]))).toEqual(record.toolClassCounts);
    }
  }
  const {readStorageCommunityOwnerPage}=await import('../src/storage-community-authority');
  const owners=await readStorageCommunityOwnerPage(source());
  const other=owners.find(owner=>owner.participantId==='synthetic-shared-corpus-other')!;
  expect(other.ownerDigest).toBeTruthy();
  await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES(?,?,?,?,'active')`).bind(sourceId,other.ownerDigest,other.ownerRevision,other.authorityEpoch).run();
  const occurrenceKeys:string[]=[];
  for(const owner of [corpus.owner,other]){
    const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest!,participantId:owner.participantId,
      day:corpus.equivalentDay,stream:'usage',selectionMethod:'effective-union-v1'};
    await coverage(scope.participantId,scope.ownerDigest,scope.day);await complete(scope);
    occurrenceKeys.push(await canonicalFacts.canonicalOccurrenceKey(scope,'usage',corpus.duplicateAcrossOwnersOccurrenceId));
  }
  expect(new Set(occurrenceKeys).size).toBe(2);
  expect((await target().prepare('SELECT count(*) n FROM analytics_canonical_heads WHERE occurrence_key IN(?,?)')
    .bind(...occurrenceKeys).first<number>('n'))).toBe(2);
},120_000);


it('materializes the native v11 selected head including empty days without unioning retained v12 records',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:25,graphDays:2,denseUsageRows:20,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const {loadV11SourcePin}=await import('../src/telemetry-v11-domain');
  const {readTypedV11UsageAnalysisPage}=await import('../src/typed-v11-analysis-reader');
  const pin=(await loadV11SourcePin(source(),corpus.participantId))!;
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
    participantId:corpus.participantId,day:corpus.equivalentDay,stream:'usage',selectionMethod:'legacy-selected-v1'};
  for(const day of [scope.day,corpus.sessionDay]){
    const selectedScope={...scope,day};
    await coverage(scope.participantId,scope.ownerDigest,day);
    const native=await readTypedV11UsageAnalysisPage(source(),{sourceNamespace:sourceId,pin,day,from:day+'T00:00:00.000Z',
      to:new Date(Date.parse(day+'T00:00:00.000Z')+86_400_000).toISOString(),afterTime:day+'T00:00:00.000Z',afterOccurrence:'',pageSize:200});
    const sealed=await complete(selectedScope);expect(sealed.progress.seal).toMatchObject({seenCount:native.length,empty:native.length===0});
    const actual=(await target().prepare(`SELECT f.native_logical_occurrence_key AS occurrence_key,f.total_input_context_tokens FROM analytics_canonical_heads h
      JOIN analytics_canonical_facts f ON f.revision=h.revision WHERE f.owner_digest=? AND f.selection_method='legacy-selected-v1'
        AND f.stream='usage' AND f.observed_day=? ORDER BY f.observed_at_ms,f.native_order`)
      .bind(scope.ownerDigest,day).all<{occurrence_key:string;total_input_context_tokens:number|null}>()).results;
    expect(actual.map(row=>row.occurrence_key)).toEqual(await Promise.all(native.map(row=>canonicalFacts.canonicalOccurrenceKey(scope,'usage',row.occurrence_id))));
    expect(actual.map(row=>row.total_input_context_tokens)).toEqual(native.map(row=>JSON.parse(row.record_json).totalInputContextTokens));
  }
  const emptySessionScope={...scope,day:corpus.sessionDay,stream:'session' as const};
  await coverage(scope.participantId,scope.ownerDigest,emptySessionScope.day,true);
  const union=await readEffectiveTelemetryOwnerDayPage(source(),{sourceNamespace:sourceId,ownerDigest:scope.ownerDigest,
    ownerRevision:corpus.owner.ownerRevision,authorityEpoch:corpus.owner.authorityEpoch,day:emptySessionScope.day,stream:'session',limit:16});
  expect(union.rows.length).toBeGreaterThan(0);
  expect((await complete(emptySessionScope)).progress.seal).toMatchObject({seenCount:0,empty:true});
},120_000);

it('materializes a v1-only owner through the native elected device and ordering contract',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:10,graphDays:2,crossDayLinks:true,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const {createV11DeviceFixture,v11UsageRecord}=await import('./helpers/telemetry-v11');
  const {parseTelemetryV1Chunk}=await import('../src/telemetry-v1');
  const {telemetryV11LegacyProjection}=await import('../src/telemetry-v11-compatibility');
  const {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization}=await import('../src/device-auth');
  const {insertTypedTelemetryV1Chunk}=await import('../src/typed-v1-admission');
  const {sha256Hex}=await import('../src/crypto');
  const {canonicalJson}=await import('../src/canonical-json');
  // A later device elects twenty reverse-ID equal-time records; the prior
  // device remains retained and would incorrectly add an event under union.
  const winningDevice=await createV11DeviceFixture(source(),{participantId:'synthetic-shared-corpus-other'});
  const records=Array.from({length:20},(_,index)=>JSON.parse(telemetryV11LegacyProjection('usage',v11UsageRecord(corpus.equivalentDay,'a',
    {eventId:index===0?corpus.duplicateAcrossOwnersOccurrenceId:'event:v2:'+(5000-index).toString(16).padStart(64,'0')}))!.canonicalRecord));
  const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:'usage:'+corpus.equivalentDay+':0',
    chunkRevision:1,chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-canonical-v1-order',
    consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
      privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  const envelopeDigest=await sha256Hex('synthetic-canonical-v1-order');
  const principal=await authenticateDevice(source(),winningDevice.authorization);
  const authorization=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,4096);
  const claimed=await claimDeviceUploadAuthorization(source(),'Upload '+authorization.uploadAuthorization,
    {envelopeDigest,bodyBytes:4096,contentType:'application/json'});
  await insertTypedTelemetryV1Chunk(source(),{chunkRowId:'chunk:synthetic-canonical-v1-order',
    participantId:winningDevice.participantId,deviceId:winningDevice.deviceId,chunk,envelopeDigest,
    deviceUploadAuthorizationId:claimed.authorizationId,r2Key:'synthetic/canonical-v1-order',
    createdAt:new Date(Date.now()+1_000).toISOString(),supersedes:null},sourceId);
  const {readStorageCommunityOwnerPage}=await import('../src/storage-community-authority');
  const {loadV1SourcePin}=await import('../src/telemetry-v1-source-selection');
  const {loadTypedV1AnalysisScope,readTypedV1UsageAnalysisPage}=await import('../src/typed-v1-analysis-reader');
  const owner=(await readStorageCommunityOwnerPage(source())).find(value=>value.participantId==='synthetic-shared-corpus-other')!;
  expect(owner.hasV11).toBe(false);
  await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES(?,?,?,?,'active')`).bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest!,participantId:owner.participantId,
    day:corpus.equivalentDay,stream:'usage',selectionMethod:'legacy-selected-v1'};
  await coverage(scope.participantId,scope.ownerDigest,scope.day);
  const pin=await loadV1SourcePin(source(),{participantId:scope.participantId,fromDay:scope.day,throughDay:scope.day});
  const typed=(await loadTypedV1AnalysisScope(source(),scope.participantId))!;
  const native=await readTypedV1UsageAnalysisPage(source(),typed,pin.winnersJson,'',0,200,
    new Date(Date.parse(scope.day+'T00:00:00.000Z')+86_400_000).toISOString());
  expect(native.length).toBe(20);
  expect(native.map(row=>row.occurrence_id)).not.toEqual(native.map(row=>row.occurrence_id).sort());
  const sealed=await complete(scope);expect(sealed.progress.seal).toMatchObject({seenCount:native.length,empty:false});
  expect(sealed.seen.filter(value=>value.pages>0).length).toBeGreaterThanOrEqual(3);
  const actual=(await target().prepare(`SELECT f.native_logical_occurrence_key AS occurrence_key,f.native_occurrence_tie_order,f.native_source_family FROM analytics_canonical_heads h JOIN analytics_canonical_facts f
    ON f.revision=h.revision WHERE f.owner_digest=? AND f.selection_method='legacy-selected-v1' ORDER BY f.observed_at_ms,f.native_order`)
    .bind(scope.ownerDigest).all<{occurrence_key:string;native_occurrence_tie_order:number;native_source_family:string}>()).results;
  expect(actual.map(row=>row.occurrence_key)).toEqual(await Promise.all(native.map(row=>canonicalFacts.canonicalOccurrenceKey(scope,'usage',row.occurrence_id))));
  const lexical=native.map(row=>row.occurrence_id).sort();
  expect(actual.map(row=>row.native_occurrence_tie_order)).toEqual(native.map(row=>lexical.indexOf(row.occurrence_id)));
  expect(actual.every(row=>row.native_source_family==='v1')).toBe(true);
  const linkedScope={...scope,day:corpus.crossDayLinkDay!};
  await coverage(scope.participantId,scope.ownerDigest,linkedScope.day);
  expect((await complete(linkedScope)).progress.seal!.seenCount).toBe(1);
  const logical=await canonicalFacts.canonicalOccurrenceKey(scope,'usage',corpus.duplicateAcrossOwnersOccurrenceId);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_canonical_heads h JOIN analytics_canonical_facts f
    ON f.revision=h.revision WHERE f.selection_method='legacy-selected-v1' AND f.native_logical_occurrence_key=?`)
    .bind(logical).first<number>('n')).toBe(2);
},120_000);


async function sealedPreparationFixture(denseUsageRows=20) {
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:14,graphDays:2,denseUsageRows,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
    participantId:corpus.owner.participantId,day:corpus.graphDates[0]!,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,scope.day);
  const sealed=await complete(scope);
  return {scope,corpus,seal:sealed.progress.seal!};
}

it('reuses held metadata for four private pages with exact parity and fully metered final proof',async({annotate})=>{
  const {scope}=await sealedPreparationFixture();
  const profile=createAnalyticsProfile();let phase='initial';
  const meter=createD1InvocationBudget(950);
  const measuredSource=meter.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>phase));
  const measuredTarget=meter.wrap(profileAnalyticsDatabase(target(),'target',profile,()=>phase));
  const context=await createCanonicalInputReadContext(measuredSource,measuredTarget,[scope],Date.now()+60_000);
  expect(context).not.toBeNull();
  try {
    // Prime the identical held scope token outside both comparable phases.
    expect(await readCanonicalInputPreparationSeal(measuredSource,measuredTarget,scope,context!)).not.toBeNull();
    const pages=[];
    for(const mode of ['full','preparation'] as const) {
      phase=mode;let afterKey:string|null=null;
      const values=[];
      for(let n=0;n<4;n++) {
        const options:{limit:number;order:'native';afterKey?:string}={limit:4,order:'native',...(afterKey?{afterKey}:{})};
        const page:CanonicalInputFactPage|null=mode==='full'
          ?await readCanonicalInputFactPage(measuredSource,measuredTarget,scope,{...options,context:context!})
          :await readCanonicalInputPreparationFactPage(measuredSource,measuredTarget,scope,context!,options);
        expect(page).not.toBeNull();values.push(page);
        afterKey=page!.next;
        if(n<3)expect(afterKey).not.toBeNull();
      }
      expect(await canonicalInputReadContextCurrent(measuredSource,measuredTarget,scope,context!)).toBe(true);
      pages.push(values);
    }
    expect(pages[1]).toEqual(pages[0]);
    const costs=['full','preparation'].map(mode=>Object.entries(profile.costs)
      .filter(([key])=>key.startsWith(mode+'.')).reduce((sum,[,value])=>({
        statements:sum.statements+value.statements,rowsRead:sum.rowsRead+value.rowsRead}),{statements:0,rowsRead:0}));
    expect(costs[1]!.statements).toBeLessThan(costs[0]!.statements);
    expect(costs[1]!.rowsRead).toBeLessThan(costs[0]!.rowsRead);
    expect(profile.measurementFailures).toBe(0);
    expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.statements,0)).toBe(meter.queriesUsed);
    await annotate(JSON.stringify({component:'four-canonical-input-pages-with-final-proof',pages:4,full:costs[0],preparation:costs[1]}),
      'canonical-input-preparation-component-cost');
    console.info('canonical-input-preparation-component-cost',JSON.stringify(costs));
    for(const foreign of [{...scope,day:'2099-01-01'},{...scope,stream:'quota' as const},
      {...scope,sourceNamespace:'synthetic-foreign-source'},{...scope,ownerDigest:'f'.repeat(64)},
      {...scope,selectionMethod:'legacy-selected-v1' as const}]) {
      expect(await readCanonicalInputPreparationSeal(measuredSource,measuredTarget,foreign,context!)).toBeNull();
      expect(await canonicalInputReadContextCurrent(measuredSource,measuredTarget,foreign,context!)).toBe(false);
    }
    expect(await readCanonicalInputPreparationSeal(source(),measuredTarget,scope,context!)).toBeNull();
    expect(await readCanonicalInputPreparationSeal(measuredSource,target(),scope,context!)).toBeNull();
    expect(await readCanonicalInputPreparationFactPage(measuredSource,measuredTarget,scope,{} as CanonicalInputReadContext)).toBeNull();
    const spent=meter.queriesUsed;meter.reserveQueries=meter.remainingQueries;
    await expect(readCanonicalInputPreparationFactPage(measuredSource,measuredTarget,scope,context!))
      .rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
    expect(meter.queriesUsed).toBe(spent);meter.reserveQueries=0;
  } finally {closeCanonicalInputReadContext(context!);}
  expect(await readCanonicalInputPreparationSeal(measuredSource,measuredTarget,scope,context!)).toBeNull();
  expect(await canonicalInputReadContextCurrent(measuredSource,measuredTarget,scope,context!)).toBe(false);
  const expires=Date.now()+30_000;
  const expiring=await createCanonicalInputReadContext(source(),target(),[scope],expires);
  expect(expiring).not.toBeNull();
  const time=vi.spyOn(Date,'now').mockReturnValue(expires);
  try {
    expect(await readCanonicalInputPreparationSeal(source(),target(),scope,expiring!)).toBeNull();
    expect(await canonicalInputReadContextCurrent(source(),target(),scope,expiring!)).toBe(false);
  } finally {time.mockRestore();closeCanonicalInputReadContext(expiring!);}
},120_000);

it('keeps fresh default and full held-context schema refusal after source or target guards disappear',async()=>{
  const {scope,seal}=await sealedPreparationFixture(2);
  const context=await createCanonicalInputReadContext(source(),target(),[scope],Date.now()+60_000);
  expect(context).not.toBeNull();
  try {
    for(const [database,name] of [[source(),'storage_effective_selective_sequence_guard'],
      [target(),'analytics_canonical_input_seal']] as const) {
      const sql=await database.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").bind(name).first<string>('sql');
      expect(sql).toBeTruthy();await database.prepare('DROP TRIGGER '+name).run();
      try {
        // Private references can reuse the initially proved immutable metadata;
        // neither a default read nor a final held proof can promote them.
        expect(await readCanonicalInputPreparationSeal(source(),target(),scope,context!)).toEqual(seal);
        expect(await readCanonicalInputSeal(source(),target(),scope)).toBeNull();
        expect(await readCanonicalInputFactPage(source(),target(),scope)).toBeNull();
        expect(await readCanonicalInputSeal(source(),target(),scope,context!)).toBeNull();
        expect(await canonicalInputReadContextCurrent(source(),target(),scope,context!)).toBe(false);
      } finally {await database.prepare(sql!).run();}
      expect(await canonicalInputReadContextCurrent(source(),target(),scope,context!)).toBe(true);
    }
  } finally {closeCanonicalInputReadContext(context!);}
},120_000);

it('rejects private held reads after generation, owner revision or target erasure changes',async()=>{
  const {scope,corpus}=await sealedPreparationFixture(2);
  const create=()=>createCanonicalInputReadContext(source(),target(),[scope],Date.now()+60_000);
  const unchangedOwner=await source().prepare('SELECT revision FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(scope.ownerDigest).first<number>('revision');
  const generation=await create();expect(generation).not.toBeNull();
  try {
    await source().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1').run();
    expect(await source().prepare('SELECT revision FROM storage_owner_revisions WHERE owner_digest=?')
      .bind(scope.ownerDigest).first<number>('revision')).toBe(unchangedOwner);
    expect(await readCanonicalInputPreparationSeal(source(),target(),scope,generation!)).toBeNull();
    expect(await canonicalInputReadContextCurrent(source(),target(),scope,generation!)).toBe(false);
  } finally {closeCanonicalInputReadContext(generation!);}
  const owner=await create();expect(owner).not.toBeNull();
  try {
    await source().prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?')
      .bind(scope.participantId).run();
    expect(await readCanonicalInputPreparationSeal(source(),target(),scope,owner!)).toBeNull();
    expect(await canonicalInputReadContextCurrent(source(),target(),scope,owner!)).toBe(false);
  } finally {closeCanonicalInputReadContext(owner!);}
  await coverage(scope.participantId,scope.ownerDigest,scope.day);
  const erased=await create();expect(erased).not.toBeNull();
  try {
    await target().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,
      terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,?,?,1)`)
      .bind(sourceId,scope.ownerDigest,'e'.repeat(64),corpus.owner.ownerRevision+1,corpus.owner.authorityEpoch+1).run();
    expect(await readCanonicalInputPreparationFactPage(source(),target(),scope,erased!)).toBeNull();
    expect(await canonicalInputReadContextCurrent(source(),target(),scope,erased!)).toBe(false);
  } finally {closeCanonicalInputReadContext(erased!);}
},120_000);


it('G06 bounds interrupted stamp resets without truncating current canonical heads',async()=>{
  await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    calendarDays:10,graphDays:2,denseUsageRows:1,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const day=corpus.graphDates[0]!,owner=corpus.owner;
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1'};
  await coverage(scope.participantId,scope.ownerDigest,day);
  const sealed=(await complete(scope)).progress.seal!;
  const heads=(await target().prepare('SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key').all()).results;
  // A changed source can leave a large interrupted acquisition's seen set.
  await target().prepare("UPDATE analytics_canonical_input_work SET source_stamp=?,state='reading',seen_count=2048 WHERE scope_key=?")
    .bind('0'.repeat(64),sealed.scopeKey).run();
  await target().prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2048)
    INSERT INTO analytics_canonical_input_seen SELECT ?,printf('%064x',i) FROM n WHERE true ON CONFLICT DO NOTHING`)
    .bind(sealed.scopeKey).run();
  const count=()=>target().prepare('SELECT count(*) n FROM analytics_canonical_input_seen WHERE scope_key=?').bind(sealed.scopeKey).first<number>('n');
  const original=await count();
  await target().prepare('UPDATE analytics_canonical_input_work SET claim_token=?,claim_expires_ms=? WHERE scope_key=?')
    .bind('synthetic-active-claim',Date.now()+60_000,sealed.scopeKey).run();
  expect((await advance(scope)).state).toBe('deferred');expect(await count()).toBe(original);
  await target().prepare('UPDATE analytics_canonical_input_work SET claim_token=NULL,claim_expires_ms=0 WHERE scope_key=?').bind(sealed.scopeKey).run();
  const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(900);
  const first=await advanceCanonicalInputWork(source(),profileAnalyticsDatabase(target(),'target',profile,()=> 'reset'),
    {...scope,budget:{meter,maxSteps:1,deadlineMs:Date.now()+40_000,now:Date.now}});
  expect(first.state).toBe('progress');expect(await count()).toBe(original!-128);
  expect(await target().prepare('SELECT source_stamp,state FROM analytics_canonical_input_work WHERE scope_key=?').bind(sealed.scopeKey).first())
    .toEqual({source_stamp:'0'.repeat(64),state:'draining'});
  expect(await readCanonicalInputSeal(source(),target(),scope)).toBeNull();
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)).toBeLessThanOrEqual(512);
  let lost=true;
  const transport=new Proxy(target(),{get(database,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const result=await database.batch(statements);if(lost&&(await count())===original!-256){lost=false;throw Error('synthetic lost reset response');}return result;};
    const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  await expect(advanceCanonicalInputWork(source(),transport,{...scope,budget:{meter:createD1InvocationBudget(900),
    maxSteps:1,deadlineMs:Date.now()+40_000,now:Date.now}})).rejects.toThrow('lost reset response');
  expect(await count()).toBe(original!-256);
  expect((await advance(scope)).state).toBe('progress');expect(await count()).toBe(original!-384);
  expect((await target().prepare('SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key').all()).results).toEqual(heads);
  const finished=await complete(scope);
  expect(finished.progress.seal).toEqual(sealed);
  expect((await advance(scope)).state).toBe('complete');expect(await count()).toBe(sealed.seenCount);
  expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);
