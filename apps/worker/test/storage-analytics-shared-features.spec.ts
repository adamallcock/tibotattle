import { env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import * as dependencySummaries from '../src/storage-effective-dependency-summaries';
import { withMaintainedEffectiveDependencies } from '../src/storage-effective-dependency-summaries';
import { advanceEffectiveDependencyCoverage } from '../src/storage-effective-selective-dependencies';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import { prepareSharedAnalyticsDay } from '../src/analytics-shared-reducers';
import { appendSharedAnalyticsFeaturePage, createSharedAnalyticsFeaturePending,
  SHARED_ANALYTICS_FEATURE_METHOD, SharedFeatureRefused } from '../src/analytics-shared-features';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { finalizeV11DailyProjectionValues } from '../src/v11-daily-projection-values';
import { readEffectiveTelemetryOwnerDayPage, type EffectiveTelemetryOccurrence,
  type EffectiveTelemetryStream } from '../src/telemetry-usage-effective-reader';
import { advanceSharedAnalyticsFeatureDay, readSharedAnalyticsFeatureDay,
  readSharedAnalyticsFeatureWindow, retireSharedAnalyticsFeatureDay,
  retireSharedAnalyticsFeaturePage, type SharedAnalyticsFeatureInput } from '../src/storage-analytics-shared-features';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';

type Bindings = Env & { STORAGE_ANALYTICS_DB:D1Database; TEST_MIGRATIONS:D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]; TEST_ANALYTICS_MIGRATIONS:D1Migration[] };
const b=env as Bindings, source=()=>b.USAGE_MONITOR_DB, target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-shared-feature',sourceNamespace=sourceId;
async function setup(dense=false) {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
  const anchorDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,
    anchorDay,calendarDays:14,graphDays:2,...(dense?{denseUsageRows:401}:{})});
  return corpus;
}
function input(owner: Awaited<ReturnType<typeof setup>>['owner'],day:string) {
  const meter=createD1InvocationBudget(950);
  const value:SharedAnalyticsFeatureInput={source:meter.wrap(source()),target:meter.wrap(target()),
    sourceId,sourceNamespace,owner,day,budget:{remainingQueries:()=>meter.remainingQueries,
      deadlineMs:Date.now()+60_000,now:Date.now}};
  return {value,meter};
}

it('keeps shared-feature work and its statement cap when optional timing observers fail',async()=>{
  const corpus=await setup(),day=corpus.graphDates[0]!;
  const first=input(corpus.owner,day);
  const thrown=await advanceSharedAnalyticsFeatureDay({...first.value,budget:{...first.value.budget,
    statementCount:()=>first.meter.queriesUsed,observePhase:()=>{throw new Error('private observer');}}});
  expect(['deferred','complete']).toContain(thrown.state);
  expect(first.meter.queriesUsed).toBeGreaterThan(0);
  expect(first.meter.queriesUsed).toBeLessThanOrEqual(950);
  const second=input(corpus.owner,day);
  const budget=Object.defineProperties({...second.value.budget},{
    observePhase:{get(){throw new Error('private observer getter');}},
    statementCount:{get(){throw new Error('private counter getter');}},
  }) as SharedAnalyticsFeatureInput['budget'];
  const continued=await advanceSharedAnalyticsFeatureDay({...second.value,budget});
  expect(['deferred','complete']).toContain(continued.state);
  expect(second.meter.queriesUsed).toBeLessThanOrEqual(950);
},30_000);
async function finish(owner:Awaited<ReturnType<typeof setup>>['owner'],day:string,clock:()=>number=Date.now) {
  let deferred=0;
  for (let attempt=0;attempt<24;attempt++) {
    const {value,meter}=input(owner,day);
    const result=await advanceSharedAnalyticsFeatureDay({...value,
      budget:{...value.budget,now:clock,deadlineMs:clock()+60_000}});
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    if(result.state==='complete') return {result,deferred};
    expect(result.state,JSON.stringify(result)).toBe('deferred');
    deferred++;
  }
  throw new Error('shared feature did not complete');
}
async function completeSourceDay(owner:Awaited<ReturnType<typeof setup>>['owner'],day:string) {
  const streams:{usage:EffectiveTelemetryOccurrence[];quota:EffectiveTelemetryOccurrence[];
    session:EffectiveTelemetryOccurrence[]}={usage:[],quota:[],session:[]};
  for(const stream of ['usage','quota','session'] as const satisfies readonly EffectiveTelemetryStream[]) {
    let after: {observedAtMs:number;occurrenceId:string}|undefined;
    for(;;) {
      const page=await readEffectiveTelemetryOwnerDayPage(source(),{sourceNamespace,
        ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
        day,stream,limit:200,...(after?{after}:{})});
      streams[stream].push(...page.rows);
      if(!page.next)break;
      after=page.next;
    }
  }
  return prepareSharedAnalyticsDay({day,ownerDigest:owner.ownerDigest,...streams});
}

it('resumes a multi-page day from durable source-free parts, reuses it and bulk-loads exact windows',async()=>{
  const corpus=await setup(true),day=corpus.graphDates[0]!;
  const {result,deferred}=await finish(corpus.owner,day);
  expect(deferred).toBeGreaterThan(0);
  expect(result.reused).toBe(false);
  const reference=await completeSourceDay(corpus.owner,day);
  expect(finalizeV11DailyProjectionValues(result.value.daily)).toEqual(reference.daily);
  expect(result.value.quota).toEqual(reference.quota);
  expect(result.value.modelUsage).toEqual(reference.modelUsage);
  const ordinals=new Map(reference.usageRows.map((row,index)=>
    [row.occurrence_id,`ord:${String(index+1).padStart(6,'0')}`]));
  expect(result.value.cacheItems).toEqual(reference.cacheItems.map(item=>
    ({...item,orderKey:ordinals.get(item.orderKey)})));
  expect(result.value.cacheEventsRead).toBe(reference.cacheEventsRead);
  expect(result.value.scalarUsage).toHaveLength(reference.usageRows.length);
  expect(result.value.scalarUsage.map(row=>row.occurrenceId))
    .toEqual(reference.usageRows.map((_,index)=>`ord:${String(index+1).padStart(6,'0')}`));
  const parts=(await target().prepare(`SELECT payload FROM analytics_shared_feature_parts
    ORDER BY job_key,revision,part_index`).all<{payload:string}>()).results;
  expect(parts.length).toBeGreaterThan(0);
  const stored=parts.map(row=>row.payload).join('');
  expect(stored).not.toContain('recordJson');
  expect(stored).not.toContain('record_json');
  expect(stored).not.toContain('sessionUuid');
  expect(stored).not.toContain('session_uuid');
  const completeParts=(await target().prepare(`SELECT p.payload FROM analytics_shared_feature_parts p
    JOIN analytics_shared_feature_days h ON h.job_key=p.job_key AND h.head_revision=p.revision
    WHERE h.source_id=? AND h.owner_digest=? AND h.day=? ORDER BY p.part_index`)
    .bind(sourceId,corpus.owner.ownerDigest,day).all<{payload:string}>()).results;
  const completeJson=completeParts.map(row=>row.payload).join('');
  for(const row of reference.usageRows) expect(completeJson).not.toContain(row.occurrence_id);
  const leftovers=await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts p
    JOIN analytics_shared_feature_days h ON h.job_key=p.job_key
    WHERE h.source_id=? AND h.owner_digest=? AND h.day=? AND p.revision<>h.head_revision`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('n');
  expect(leftovers).toBe(0);
  const {value:readInput}=input(corpus.owner,day);
  expect(await readSharedAnalyticsFeatureDay(readInput))
    .toMatchObject({state:'complete',dependencyDigest:result.dependencyDigest});
  const otherDay=corpus.graphDates[1]!;
  expect(await readSharedAnalyticsFeatureWindow({...input(corpus.owner,day).value,
    days:[day,otherDay]})).toEqual({state:'missing',day:otherDay});
  await finish(corpus.owner,otherDay);
  const window=await readSharedAnalyticsFeatureWindow({...input(corpus.owner,day).value,
    days:[day,otherDay]});
  expect(window.state).toBe('complete');
  if(window.state==='complete') {
    expect(window.values.map(value=>value.day)).toEqual([day,otherDay]);
    expect(window.dependencyDigests).toHaveLength(2);
  }
},180_000);

it('reuses an unchanged old day, replaces a corrected day, and physically erases owner features',async()=>{
  const corpus=await setup(),oldDay=corpus.sessionDay,changedDay=corpus.correctionDay;
  const old=await finish(corpus.owner,oldDay),changed=await finish(corpus.owner,changedDay);
  const corrected=await corpus.mutateCorrection();
  const reused=await advanceSharedAnalyticsFeatureDay(input(corrected,oldDay).value);
  expect(reused).toMatchObject({state:'complete',reused:true,
    dependencyDigest:old.result.dependencyDigest});
  const replacement=await finish(corrected,changedDay);
  expect(replacement.result.dependencyDigest).not.toBe(changed.result.dependencyDigest);
  expect(replacement.result.reused).toBe(false);
  const stale=await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=?`)
    .bind(sourceId,corrected.ownerDigest,changedDay,changed.result.dependencyDigest).first<number>('n');
  expect(stale).toBe(0);
  const priorHeads=await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corrected.ownerDigest).first<number>('n');
  expect(priorHeads).toBeGreaterThan(0);
  await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
    .bind(sourceId,corrected.ownerDigest,'c'.repeat(64),1,1,
      corrected.authorityEpoch,corrected.authorityEpoch).run();
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corrected.ownerDigest).first<number>('n')).toBe(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corrected.ownerDigest).first<number>('n')).toBe(0);
},180_000);

it('bounds source capacity cleanup, passes live claims, and reclaims an expired private part',async()=>{
  const corpus=await setup(),day=corpus.sessionDay;
  await finish(corpus.owner,day);
  const method=await sha256Hex(canonicalJson(SHARED_ANALYTICS_FEATURE_METHOD));
  const now=Date.now(),oldMethod='a'.repeat(64),dependency='b'.repeat(64);
  const insert=async(label:string,methodDigest:string)=>{
    const key=await sha256Hex(`synthetic:${label}`);
    await target().prepare(`INSERT INTO analytics_shared_feature_days
      (job_key,source_id,source_namespace,owner_digest,day,method_digest,dependency_digest,
        owner_revision,authority_epoch,input_revision,updated_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(key,sourceId,sourceNamespace,corpus.owner.ownerDigest,day,methodDigest,dependency,
        corpus.owner.ownerRevision,corpus.owner.authorityEpoch,corpus.owner.inputRevision,now).run();
    return key;
  };
  const stale=await insert('stale',oldMethod);
  const leased=await insert('leased',oldMethod);
  await target().prepare(`UPDATE analytics_shared_feature_days SET claim_token=?,claim_expires_ms=?,updated_ms=?
    WHERE job_key=?`).bind(crypto.randomUUID(),now+60_000,now,leased).run();
  const pending=await insert('pending',method);
  const claim=crypto.randomUUID();
  await target().prepare(`UPDATE analytics_shared_feature_days SET claim_token=?,claim_expires_ms=?,updated_ms=?
    WHERE job_key=?`).bind(claim,now+60_000,now,pending).run();
  const payload='private checkpoint fragment';
  await target().prepare(`INSERT INTO analytics_shared_feature_parts
    (job_key,source_id,owner_digest,revision,part_index,payload,payload_bytes,payload_digest,claim_token,saved_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(pending,sourceId,corpus.owner.ownerDigest,1,0,payload,
      new TextEncoder().encode(payload).byteLength,await sha256Hex(payload),claim,now).run();
  const sweep=async(at:number)=>retireSharedAnalyticsFeaturePage({target:target(),sourceId,
    budget:{remainingQueries:()=>950,deadlineMs:at+60_000,now:()=>at}});
  let scanned=0;
  for(let index=0;index<4;index++) {
    const result=await sweep(now);
    expect(result.state).toBe('complete');
    if(result.state==='complete') {expect(result.scanned).toBeLessThanOrEqual(4);scanned+=result.scanned;}
  }
  expect(scanned).toBeGreaterThan(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days WHERE job_key=?`)
    .bind(stale).first<number>('n')).toBe(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days WHERE job_key=?`)
    .bind(leased).first<number>('n')).toBe(1);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts WHERE job_key=?`)
    .bind(pending).first<number>('n')).toBe(1);
  for(let index=0;index<4;index++) await sweep(now+70_000);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days WHERE job_key=?`)
    .bind(leased).first<number>('n')).toBe(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts WHERE job_key=?`)
    .bind(pending).first<number>('n')).toBe(0);
  expect(await readSharedAnalyticsFeatureDay(input(corpus.owner,day).value))
    .toMatchObject({state:'complete'});
  await insert('obsolete-day',oldMethod);
  const retired=await retireSharedAnalyticsFeatureDay(input(corpus.owner,day).value);
  expect(retired).toMatchObject({state:'complete',headsRemoved:1});
},180_000);

it('refuses an over-cap day before committing a source row',async()=>{
  const corpus=await setup(),day=corpus.graphDates[0]!;
  const page=await readEffectiveTelemetryOwnerDayPage(source(),{sourceNamespace,
    ownerDigest:corpus.owner.ownerDigest,ownerRevision:corpus.owner.ownerRevision,
    authorityEpoch:corpus.owner.authorityEpoch,day,stream:'usage',limit:1});
  expect(page.rows).toHaveLength(1);
  const pending={...createSharedAnalyticsFeaturePending(day,corpus.owner.ownerDigest),sourceRowsRead:6000};
  await expect(appendSharedAnalyticsFeaturePage(pending,'usage',page.rows,null))
    .rejects.toMatchObject({reason:'day_row_limit'} satisfies Partial<SharedFeatureRefused>);
},180_000);

it('reuses an exact old day after an accepted outside-day source append',async()=>{
  const corpus=await setup(),day=corpus.sessionDay;
  const initial=await finish(corpus.owner,day);
  const appended=await corpus.appendOutsideV11();
  expect(appended.ownerRevision).toBeGreaterThan(corpus.owner.ownerRevision);
  expect(appended.authorityEpoch).toBe(corpus.owner.authorityEpoch);
  const replay=await advanceSharedAnalyticsFeatureDay(input(appended,day).value);
  expect(replay).toMatchObject({state:'complete',reused:true,
    dependencyDigest:initial.result.dependencyDigest});
},180_000);

it('bulk-loads a complete 101-day window within one 950-query pass',async()=>{
  const corpus=await setup(),end=Date.parse(`${corpus.graphDates[0]}T00:00:00.000Z`);
  const days=Array.from({length:101},(_,index)=>
    new Date(end-(100-index)*86_400_000).toISOString().slice(0,10));
  for(const day of days) await finish(corpus.owner,day);
  const {value,meter}=input(corpus.owner,days[0]!);
  const window=await readSharedAnalyticsFeatureWindow({...value,days});
  expect(window.state).toBe('complete');
  if(window.state==='complete') expect(window.values.map(day=>day.day)).toEqual(days);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},180_000);

it('refuses cleanly with a pre-0032 target and leaves native fallback available',async()=>{
  await reset();
  const prior={...b,TEST_ANALYTICS_MIGRATIONS:b.TEST_ANALYTICS_MIGRATIONS
    .filter(migration=>migration.name<'0032_')};
  await initializeSharedAnalyticsCorpusDatabases(source(),target(),prior,sourceId,sourceNamespace);
  const anchorDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,
    anchorDay,calendarDays:14,graphDays:2});
  const result=await advanceSharedAnalyticsFeatureDay(input(corpus.owner,corpus.graphDates[0]!).value);
  expect(result).toEqual({state:'refused',reason:'migration_required'});
  const count=await target().prepare(`SELECT count(*) n FROM sqlite_schema
    WHERE name='analytics_shared_feature_days'`).first<number>('n');
  expect(count).toBe(0);
},180_000);

it('recovers a complete generation after its committed batch response is lost',async()=>{
  const corpus=await setup(),day=corpus.correctionDay;
  const {value,meter}=input(corpus.owner,day);
  let lost=false;
  const delegate=value.target;
  const uncertain=new Proxy(delegate,{get(object,key){
    if(key==='batch') return async(statements:D1PreparedStatement[])=>{
      const committed=await object.batch(statements);
      if(!lost) {lost=true;throw new Error('synthetic committed response lost');}
      return committed;
    };
    const member=Reflect.get(object,key);
    return typeof member==='function'?member.bind(object):member;
  }}) as D1Database;
  const first=await advanceSharedAnalyticsFeatureDay({...value,target:uncertain});
  expect(lost).toBe(true);
  expect(first).toMatchObject({state:'deferred',reason:'source_changed_or_budget'});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  const replay=await advanceSharedAnalyticsFeatureDay(input(corpus.owner,day).value);
  expect(replay).toMatchObject({state:'complete',reused:true});
  const heads=(await target().prepare(`SELECT head_revision,part_count FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,corpus.owner.ownerDigest,day)
    .all<{head_revision:number;part_count:number}>()).results;
  expect(heads).toHaveLength(1);
  expect(heads[0]!.head_revision).toBe(1);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts p
    JOIN analytics_shared_feature_days h ON h.job_key=p.job_key
    WHERE h.source_id=? AND h.owner_digest=? AND h.day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('n')).toBe(heads[0]!.part_count);
},180_000);

it('ignores a complete prior-pricing-method artifact and rebuilds the current value',async()=>{
  const corpus=await setup(),day=corpus.correctionDay;
  const initial=(await finish(corpus.owner,day)).result;
  const head=await target().prepare(`SELECT * FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first<Record<string,unknown>>();
  expect(head).not.toBeNull();
  const parts=(await target().prepare(`SELECT part_index,payload,payload_bytes,payload_digest
    FROM analytics_shared_feature_parts WHERE job_key=? AND revision=? ORDER BY part_index`)
    .bind(head!.job_key,head!.head_revision)
    .all<{part_index:number;payload:string;payload_bytes:number;payload_digest:string}>()).results;
  const priorMethod=await sha256Hex(canonicalJson({...SHARED_ANALYTICS_FEATURE_METHOD,
    dailyRegistry:'0'.repeat(64)}));
  const currentMethod=await sha256Hex(canonicalJson(SHARED_ANALYTICS_FEATURE_METHOD));
  expect(priorMethod).not.toBe(currentMethod);
  const priorKey=await sha256Hex(canonicalJson([sourceId,sourceNamespace,corpus.owner.ownerDigest,
    day,priorMethod,initial.dependencyDigest]));
  await target().prepare(`DELETE FROM analytics_shared_feature_days WHERE job_key=?`)
    .bind(head!.job_key).run();
  const now=Date.now(),claim=crypto.randomUUID();
  await target().prepare(`INSERT INTO analytics_shared_feature_days
    (job_key,source_id,source_namespace,owner_digest,day,method_digest,dependency_digest,
      owner_revision,authority_epoch,input_revision,updated_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(priorKey,sourceId,sourceNamespace,corpus.owner.ownerDigest,
      day,priorMethod,initial.dependencyDigest,corpus.owner.ownerRevision,
      corpus.owner.authorityEpoch,corpus.owner.inputRevision,now).run();
  await target().prepare(`UPDATE analytics_shared_feature_days SET claim_token=?,claim_expires_ms=?,updated_ms=?
    WHERE job_key=?`).bind(claim,now+60_000,now,priorKey).run();
  for(const part of parts) await target().prepare(`INSERT INTO analytics_shared_feature_parts
    (job_key,source_id,owner_digest,revision,part_index,payload,payload_bytes,payload_digest,claim_token,saved_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(priorKey,sourceId,corpus.owner.ownerDigest,1,
      part.part_index,part.payload,part.payload_bytes,part.payload_digest,claim,now).run();
  await target().prepare(`UPDATE analytics_shared_feature_days SET head_revision=1,state='complete',
    payload_digest=?,payload_bytes=?,part_count=?,claim_token=NULL,claim_expires_ms=NULL,updated_ms=?
    WHERE job_key=?`).bind(head!.payload_digest,head!.payload_bytes,head!.part_count,now,priorKey).run();
  expect(await readSharedAnalyticsFeatureDay(input(corpus.owner,day).value)).toEqual({state:'absent'});
  const current=await finish(corpus.owner,day);
  expect(current.result.reused).toBe(false);
  expect(current.result.dependencyDigest).toBe(initial.dependencyDigest);
  expect(current.result.value).toEqual(initial.value);
  const heads=(await target().prepare(`SELECT method_digest FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day).all<{method_digest:string}>()).results;
  expect(heads).toEqual([{method_digest:currentMethod}]);
},180_000);

it('does not publish a feature if its source day changes at the save boundary',async()=>{
  const corpus=await setup(),day=corpus.correctionDay;
  const {value,meter}=input(corpus.owner,day);
  let corrected:Awaited<ReturnType<typeof corpus.mutateCorrection>>|null=null;
  const delegate=value.target;
  const racing=new Proxy(delegate,{get(object,key){
    if(key==='batch') return async(statements:D1PreparedStatement[])=>{
      if(!corrected) corrected=await corpus.mutateCorrection();
      return object.batch(statements);
    };
    const member=Reflect.get(object,key);
    return typeof member==='function'?member.bind(object):member;
  }}) as D1Database;
  const first=await advanceSharedAnalyticsFeatureDay({...value,target:racing});
  expect(corrected).not.toBeNull();
  expect(first.state).toBe('deferred');
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  const oldHead=await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND input_revision=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day,corpus.owner.inputRevision).first<number>('n');
  expect(oldHead).toBe(0);
  const current=await finish(corrected!,day);
  expect(current.result.reused).toBe(false);
  const reference=await completeSourceDay(corrected!,day);
  expect(finalizeV11DailyProjectionValues(current.result.value.daily)).toEqual(reference.daily);
},180_000);

it('saves resumable pages within a slow dependency budget without repeating its initial proof',async()=>{
  const corpus=await setup(true),day=corpus.graphDates[0]!;
  let firstReads=0,now=Date.now();
  for(let attempt=0;attempt<2;attempt++) {
    const {value,meter}=input(corpus.owner,day);
    let dependencies=0,pages=0;
    const budget={...value.budget,now:()=>now,deadlineMs:now+55_000,
      statementCount:()=>meter.queriesUsed,observePhase:(phase:string)=>{
        if(phase==='feature_dependency') {dependencies++;now+=22_000;}
        if(phase==='feature_source_page') {pages++;now+=4_000;}
      }};
    const result=await advanceSharedAnalyticsFeatureDay({...value,budget});
    expect(result).toMatchObject({state:'deferred',reason:'incomplete'});
    expect(dependencies).toBe(2); // Initial identity and fresh final save proof.
    expect(pages).toBe(2);
    expect(now).toBeLessThan(budget.deadlineMs);
    const head=await target().prepare(`SELECT head_revision,payload_bytes FROM analytics_shared_feature_days
      WHERE source_id=? AND owner_digest=? AND day=?`)
      .bind(sourceId,corpus.owner.ownerDigest,day).first<{head_revision:number;payload_bytes:number}>();
    expect(head?.head_revision).toBe(attempt+1);
    expect(head!.payload_bytes).toBeGreaterThan(firstReads);
    firstReads=head!.payload_bytes;
  }
  const completed=await finish(corpus.owner,day,()=>now);
  const reference=await completeSourceDay(corpus.owner,day);
  expect(finalizeV11DailyProjectionValues(completed.result.value.daily)).toEqual(reference.daily);
},180_000);

it('rejects an advancing cache miss whose source changes after its initial proof',async()=>{
  const corpus=await setup(),day=corpus.correctionDay;
  const {value}=input(corpus.owner,day);
  let corrected:Awaited<ReturnType<typeof corpus.mutateCorrection>>|null=null;
  const delegate=value.target;
  let mutate=false;
  const racing=new Proxy(delegate,{get(object,key){
    if(key==='prepare') return (sql:string)=>{
      const statement=object.prepare(sql);
      if(!sql.startsWith('SELECT * FROM analytics_shared_feature_days WHERE job_key=?')) return statement;
      return new Proxy(statement,{get(prepared,member){
        if(member==='bind') return (...params:unknown[])=>{
          const bound=prepared.bind(...params);
          return new Proxy(bound,{get(operation,method){
            if(method==='first') return async()=>{
              const result=await operation.first();
              if(!mutate) {mutate=true;corrected=await corpus.mutateCorrection();}
              return result;
            };
            const fn=Reflect.get(operation,method);
            return typeof fn==='function'?fn.bind(operation):fn;
          }});
        };
        const fn=Reflect.get(prepared,member);
        return typeof fn==='function'?fn.bind(prepared):fn;
      }});
    };
    const fn=Reflect.get(object,key);
    return typeof fn==='function'?fn.bind(object):fn;
  }}) as D1Database;
  await expect(advanceSharedAnalyticsFeatureDay({...value,target:racing}))
    .rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  expect(corrected).not.toBeNull();
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND head_revision>0`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('n')).toBe(0);
  const replacement=await finish(corrected!,day);
  expect(finalizeV11DailyProjectionValues(replacement.result.value.daily))
    .toEqual((await completeSourceDay(corrected!,day)).daily);
},180_000);

it.each(['deadline','lease'] as const)('does not promote after final validation exceeds its %s',async boundary=>{
  const corpus=await setup(),day=corpus.correctionDay;
  const {value,meter}=input(corpus.owner,day);
  let now=Date.now(),dependencies=0;
  const budget={...value.budget,now:()=>now,deadlineMs:now+(boundary==='deadline'?55_000:180_000),
    statementCount:()=>meter.queriesUsed,observePhase:(phase:string)=>{
      if(phase==='feature_dependency'&&++dependencies===2)
        now=boundary==='deadline'?budget.deadlineMs:now+60_001;
    }};
  expect(await advanceSharedAnalyticsFeatureDay({...value,budget}))
    .toEqual({state:'deferred',reason:'source_changed_or_budget'});
  expect(dependencies).toBe(2);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND head_revision>0`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('n')).toBe(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_parts
    WHERE source_id=? AND owner_digest=?`)
    .bind(sourceId,corpus.owner.ownerDigest).first<number>('n')).toBe(0);
},180_000);

it('uses two sealed digest batches to read an exact maintained shared window within950 statements',async()=>{
  const corpus=await setup(),days=corpus.historyDates.slice(0,12),expected=[];
  for(const day of days)expected.push((await finish(corpus.owner,day)).result.value);
  for(let turn=0;turn<48;turn++){
    const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace,
      participantId:corpus.owner.participantId,maxSteps:64,maxRows:128});
    if(progress.status==='complete')break;
    expect(progress.status).not.toBe('unavailable');
  }
  const original=dependencySummaries.maintainedEffectiveHistoryDayReader;
  let batches=0,individual=0,acquisitions=0,reacquireOnVerification=false;
  const readerSpy=vi.spyOn(dependencySummaries,'maintainedEffectiveHistoryDayReader').mockImplementation(async(...args)=>{
    acquisitions++;
    const reader=await original(...args);if(!reader)return;
    expect(reader.readDigests).toBeTypeOf('function');
    let reads=0;
    return {readDigest:async day=>{individual++;return reader.readDigest(day);},
      readDigests:async()=>{
        batches++;
        // Retain the prior production acquisition path for a same-state cost
        // comparison. Both branches still execute actual sealed batch reads.
        if(reacquireOnVerification&&++reads===2){acquisitions++;return (await original(...args))?.readDigests?.();}
        return reader.readDigests!();
      }};
  });
  try{
    for(const warm of [false,true]){
      const {value,meter}=input(corpus.owner,days[0]!);
      const window=await readSharedAnalyticsFeatureWindow({...value,
        source:meter.wrap(withMaintainedEffectiveDependencies(source(),target(),sourceId,sourceNamespace)),days});
      expect(window).toMatchObject({state:'complete',values:expected});
      expect(meter.queriesUsed).toBeLessThanOrEqual(950);
      if(warm)expect(meter.queriesUsed).toBeLessThan(80);
    }
    expect(batches).toBe(4);expect(individual).toBe(0);expect(acquisitions).toBe(2);
    const measurements=[];
    for(const freshVerification of [true,false]){
      reacquireOnVerification=freshVerification;
      const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
      const profiledSource=profileAnalyticsDatabase(source(),'source',profile,()=> 'shared_window');
      const profiledTarget=profileAnalyticsDatabase(target(),'target',profile,()=> 'shared_window');
      const window=await readSharedAnalyticsFeatureWindow({source:meter.wrap(withMaintainedEffectiveDependencies(
        profiledSource,profiledTarget,sourceId,sourceNamespace)),target:meter.wrap(profiledTarget),
        sourceId,sourceNamespace,owner:corpus.owner,days,budget:{remainingQueries:()=>meter.remainingQueries,
          deadlineMs:Date.now()+60_000,now:Date.now}});
      expect(window).toMatchObject({state:'complete',values:expected});
      const summary=summarizeAnalyticsProfile(profile);
      expect(summary.statements).toBe(meter.queriesUsed);expect(summary.statements).toBeLessThanOrEqual(950);
      expect(summary.rowsWritten).toBe(0);
      measurements.push({statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten});
    }
    expect(measurements[1]!.statements).toBeLessThan(measurements[0]!.statements);
    expect(measurements[1]!.rowsRead).toBeLessThan(measurements[0]!.rowsRead);
    console.log('P11_SHARED_WINDOW_PROOF_REUSE',JSON.stringify({days:days.length,before:measurements[0],after:measurements[1]}));
  }finally{readerSpy.mockRestore();}
},120_000);


it('releases an unsaved feature-day claim before its lease expires',async()=>{
  const corpus=await setup(),day=corpus.graphDates[0]!;
  const first=input(corpus.owner,day);
  const profile=createAnalyticsProfile();
  const value={...first.value,target:first.meter.wrap(profileAnalyticsDatabase(target(),'target',profile,()=> 'claim_release'))};
  let producerCalls=0;
  const result=await advanceSharedAnalyticsFeatureDay({...value,canonicalPreparation:async()=>{
    producerCalls++;
    // This producer spends real statements on the same invocation meter.
    // Forty remain: enough to release a claim, too few for the fresh save proof.
    const statements=first.meter.remainingQueries-40;
    expect(statements).toBeGreaterThan(0);
    await value.target.batch(Array.from({length:statements},()=>value.target.prepare('SELECT 1')));
    return {state:'deferred' as const,reason:'query_budget'};
  }});
  expect(producerCalls).toBe(1);
  expect(result).toEqual({state:'deferred',reason:'source_changed_or_budget'});
  expect(first.meter.queriesUsed).toBeLessThanOrEqual(950);
  const before=await target().prepare(`SELECT head_revision,state,claim_token,claim_expires_ms
    FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first();
  expect(before).toEqual({head_revision:0,state:'building',claim_token:null,claim_expires_ms:null});
  const second=input(corpus.owner,day);
  const resumed=await advanceSharedAnalyticsFeatureDay({...second.value,canonicalPreparation:async()=>{
    producerCalls++;return {state:'deferred' as const,reason:'query_budget'};
  }});
  expect(producerCalls).toBe(2);
  expect(resumed).toEqual({state:'deferred',reason:'query_budget'});
  expect(second.meter.queriesUsed).toBeLessThanOrEqual(950);
  expect(await target().prepare(`SELECT head_revision,state,claim_token,claim_expires_ms
    FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,day).first())
    .toEqual({head_revision:1,state:'building',claim_token:null,claim_expires_ms:null});
  expect((await target().prepare(`SELECT count(*) n FROM analytics_community_daily_publications WHERE source_id=?`)
    .bind(sourceId).first<number>('n'))).toBe(0);
},60_000);

function observeSharedFeatureClaim(database:D1Database,after:()=>Promise<void>):D1Database {
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(value,key){
    if(key==='bind')return (...args:unknown[])=>wrap(value.bind(...args));
    if(key==='run')return async()=>{const result=await value.run();if(result.meta.changes===1)await after();return result;};
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }});
  return new Proxy(database,{get(value,key){
    if(key==='prepare')return (sql:string)=>/^UPDATE analytics_shared_feature_days SET\s+claim_token=\?/u.test(sql)
      ?wrap(value.prepare(sql)):value.prepare(sql);
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }});
}
async function currentSharedFeatureHead(owner:Awaited<ReturnType<typeof setup>>['owner'],day:string) {
  return target().prepare(`SELECT * FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=?`)
    .bind(sourceId,owner.ownerDigest,day).first<Record<string,unknown>>();
}

it.each(['canonical','ordinary'] as const)('releases exact feature leases after a %s producer error',async path=>{
  const corpus=await setup(path==='ordinary'),day=corpus.graphDates[0]!;
  const seed=input(corpus.owner,day);
  const checkpoint=await advanceSharedAnalyticsFeatureDay({...seed.value,
    ...(path==='canonical'?{canonicalPreparation:async()=>({state:'deferred' as const,reason:'query_budget'})}:{})});
  expect(checkpoint.state).toBe('deferred');expect(seed.meter.queriesUsed).toBeLessThanOrEqual(950);
  expect((await currentSharedFeatureHead(corpus.owner,day))?.head_revision).toBe(1);
  const savedParts=(await target().prepare('SELECT * FROM analytics_shared_feature_parts ORDER BY job_key,revision,part_index').all()).results;
  const {value,meter}=input(corpus.owner,day);
  let claimed=false,readFailed=false;
  const claimedHead:{value:Record<string,unknown>|null}={value:null};
  const observed=observeSharedFeatureClaim(value.target,async()=>{
    claimed=true;claimedHead.value=await currentSharedFeatureHead(corpus.owner,day);
  });
  const wrapRead=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(db,key){
    if(key==='bind')return (...args:unknown[])=>wrapRead(db.bind(...args));
    if(key==='first')return async(...args:unknown[])=>{
      const result=await Reflect.apply(db.first,db,args);
      if(claimed&&!readFailed){readFailed=true;throw new Error('synthetic source read response failed');}
      return result;
    };
    const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
  }});
  const sourceObserved=new Proxy(value.source,{get(db,key){
    if(key==='prepare')return (sql:string)=>sql.startsWith('SELECT v.revision AS input_revision,o.revision AS owner_revision')
      ?wrapRead(db.prepare(sql)):db.prepare(sql);
    const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
  }});
  await expect(advanceSharedAnalyticsFeatureDay({...value,target:observed,
    ...(path==='canonical'?{canonicalPreparation:async()=>{throw new Error('synthetic canonical producer failed');}}
      :{source:sourceObserved})})).rejects.toThrow(path==='canonical'?'synthetic canonical producer failed':'synthetic source read response failed');
  expect(claimed).toBe(true);expect(path==='ordinary'?readFailed:true).toBe(true);
  expect(claimedHead.value?.claim_token).not.toBeNull();
  expect(await currentSharedFeatureHead(corpus.owner,day)).toEqual({...claimedHead.value,claim_token:null,claim_expires_ms:null});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  expect((await target().prepare('SELECT * FROM analytics_shared_feature_parts ORDER BY job_key,revision,part_index').all()).results).toEqual(savedParts);
},60_000);

it.each(['deferred','error'] as const)('holds a real final query across captured handles and nested meters after %s',async boundary=>{
  const corpus=await setup(),day=corpus.graphDates[0]!,outer=input(corpus.owner,day);
  const phase=createD1InvocationBudget(950);
  const captured={...outer.value,source:phase.wrap(outer.value.source),target:phase.wrap(outer.value.target)};
  const claimedHead:{value:Record<string,unknown>|null}={value:null};
  const operation=advanceSharedAnalyticsFeatureDay({...captured,canonicalPreparation:async()=>{
    claimedHead.value=await currentSharedFeatureHead(corpus.owner,day);
    // Execute native metadata reads through the callback's original captured
    // target. Neither a replacement local handle nor a synthetic counter can
    // protect this path. Every actual statement is charged to both meters.
    const count=outer.meter.remainingQueries;
    expect(count).toBe(phase.remainingQueries);expect(count).toBeGreaterThan(0);
    await captured.target.batch(Array.from({length:count},()=>captured.target.prepare(
      'SELECT head_revision FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=?')
      .bind(sourceId,corpus.owner.ownerDigest,day)));
    expect(outer.meter.remainingQueries).toBe(0);expect(phase.remainingQueries).toBe(0);
    if(boundary==='error')await captured.target.prepare('SELECT 1').first();
    return {state:'deferred' as const,reason:'query_budget'};
  }});
  if(boundary==='error')await expect(operation).rejects.toThrow('invocation budget');
  else expect(await operation).toEqual({state:'deferred',reason:'source_changed_or_budget'});
  expect([outer.meter.queriesUsed,phase.queriesUsed]).toEqual([950,950]);
  expect([outer.meter.remainingQueries,phase.remainingQueries]).toEqual([0,0]);
  expect(await currentSharedFeatureHead(corpus.owner,day)).toEqual({...claimedHead.value,claim_token:null,claim_expires_ms:null});
},60_000);

it('releases an exact committed claim when its response is lost',async()=>{
  const corpus=await setup(),day=corpus.graphDates[0]!,{value,meter}=input(corpus.owner,day);
  let lost=false;
  const claimedHead:{value:Record<string,unknown>|null}={value:null};
  const observed=observeSharedFeatureClaim(value.target,async()=>{
    if(lost)return;lost=true;claimedHead.value=await currentSharedFeatureHead(corpus.owner,day);
    throw new Error('synthetic committed claim response lost');
  });
  expect(await advanceSharedAnalyticsFeatureDay({...value,target:observed,
    canonicalPreparation:async()=>({state:'deferred' as const,reason:'query_budget'})}))
    .toEqual({state:'deferred',reason:'source_changed'});
  expect(lost).toBe(true);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  expect(await currentSharedFeatureHead(corpus.owner,day)).toEqual({...claimedHead.value,claim_token:null,claim_expires_ms:null});
  const retry=input(corpus.owner,day);
  expect(await advanceSharedAnalyticsFeatureDay({...retry.value,
    canonicalPreparation:async()=>({state:'deferred' as const,reason:'query_budget'})}))
    .toEqual({state:'deferred',reason:'query_budget'});
  expect((await currentSharedFeatureHead(corpus.owner,day))?.head_revision).toBe(1);
  expect(retry.meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('preserves the replacement public claimant when old feature cleanup is delayed',async()=>{
  const corpus=await setup(),day=corpus.graphDates[0]!,first=input(corpus.owner,day),second=input(corpus.owner,day);
  let entered!:()=>void,finishReplacement!:()=>void;
  const replacementEntered=new Promise<void>(resolve=>{entered=resolve;});
  const replacementFinish=new Promise<void>(resolve=>{finishReplacement=resolve;});
  let replacement:Promise<Awaited<ReturnType<typeof advanceSharedAnalyticsFeatureDay>>>|undefined;
  let replacementHead:Record<string,unknown>|null=null;
  let firstResult:Awaited<ReturnType<typeof advanceSharedAnalyticsFeatureDay>>;
  try {
  firstResult=await advanceSharedAnalyticsFeatureDay({...first.value,canonicalPreparation:async()=>{
    const old=await currentSharedFeatureHead(corpus.owner,day);
    expect(old?.claim_token).not.toBeNull();
    // Native exact release enables the genuine public next claimant. No
    // fabricated token/head or expiry/clock override is used.
    await first.value.target.prepare(`UPDATE analytics_shared_feature_days SET claim_token=NULL,claim_expires_ms=NULL
      WHERE job_key=? AND head_revision=? AND claim_token=?`)
      .bind(old!.job_key,old!.head_revision,old!.claim_token).run();
    replacement=advanceSharedAnalyticsFeatureDay({...second.value,canonicalPreparation:async()=>{
      replacementHead=await currentSharedFeatureHead(corpus.owner,day);entered();await replacementFinish;
      return {state:'deferred' as const,reason:'query_budget'};
    }});
    await Promise.race([replacementEntered,replacement.then(()=>{throw new Error('replacement returned before barrier');})]);
    expect(replacementHead?.claim_token).not.toBe(old?.claim_token);
    return {state:'deferred' as const,reason:'query_budget'};
  }});
    expect(firstResult).toEqual({state:'deferred',reason:'source_changed_or_budget'});
    expect(await currentSharedFeatureHead(corpus.owner,day)).toEqual(replacementHead);
  }finally{finishReplacement();}
  expect(await replacement).toEqual({state:'deferred',reason:'query_budget'});
  const final=await currentSharedFeatureHead(corpus.owner,day);
  expect(final).toMatchObject({head_revision:1,state:'building',claim_token:null,claim_expires_ms:null});
  expect([first.meter.queriesUsed,second.meter.queriesUsed].every(count=>count<=950)).toBe(true);
},60_000);

it.each(['analytics_shared_feature_release_v1','analytics_shared_feature_day_update'] as const)(
 'refuses new claims without %s while preserving legacy completed reads',async name=>{
  const corpus=await setup(),completeDay=corpus.graphDates[0]!,newDay=corpus.graphDates[1]!;
  const completed=(await finish(corpus.owner,completeDay)).result;
  const ddl=await target().prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?').bind(name).first<string>('sql');
  expect(ddl).toBeTruthy();
  await target().exec(`DROP TRIGGER ${name}`);
  try {
    const fresh=input(corpus.owner,newDay);
    expect(await advanceSharedAnalyticsFeatureDay(fresh.value)).toEqual({state:'refused',reason:'migration_required'});
    expect(fresh.meter.queriesUsed).toBeLessThanOrEqual(950);
    expect((await currentSharedFeatureHead(corpus.owner,newDay))?.claim_token).toBeNull();
    const read=input(corpus.owner,completeDay);
    expect(await advanceSharedAnalyticsFeatureDay(read.value)).toMatchObject({state:'complete',reused:true,value:completed.value});
    expect(read.meter.queriesUsed).toBeLessThanOrEqual(950);
  }finally{await target().prepare(ddl!).run();}
  const restored=await finish(corpus.owner,newDay);
  expect(restored.result.state).toBe('complete');
},180_000);

it.each(['analytics_shared_feature_release_v1','analytics_shared_feature_day_update'] as const)(
 'refuses a feature claim when %s disappears after its fresh release proof',async name=>{
  const corpus=await setup(),day=corpus.graphDates[0]!,{value,meter}=input(corpus.owner,day);
  // Exact native DDL removal/restore is separate lab setup; no producer query
  // or budget/clock is substituted by this administrative race injection.
  const ddl=await target().prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?').bind(name).first<string>('sql');
  expect(ddl).toBeTruthy();
  let dropped=false,producerCalls=0;
  const before:{head:Record<string,unknown>|null}={head:null};
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(db,key){
    if(key==='bind')return (...args:unknown[])=>wrap(db.bind(...args));
    if(key==='first')return async(...args:unknown[])=>{
      const result=await Reflect.apply(db.first,db,args);
      if(result===2&&!dropped){before.head=await currentSharedFeatureHead(corpus.owner,day);
        await target().exec(`DROP TRIGGER ${name}`);dropped=true;}
      return result;
    };
    const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
  }});
  const racing=new Proxy(value.target,{get(db,key){
    if(key==='prepare')return (sql:string)=>sql.startsWith("SELECT count(*) n FROM sqlite_schema WHERE type='trigger'\n    AND tbl_name='analytics_shared_feature_days'")
      ?wrap(db.prepare(sql)):db.prepare(sql);
    const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
  }});
  try {
    expect(await advanceSharedAnalyticsFeatureDay({...value,target:racing,canonicalPreparation:async()=>{
      producerCalls++;return {state:'deferred' as const,reason:'query_budget'};
    }})).toEqual({state:'deferred',reason:'claim_busy'});
    expect(dropped).toBe(true);expect(producerCalls).toBe(0);
    expect(before.head?.claim_token).toBeNull();expect(before.head?.head_revision).toBe(0);
    expect(await currentSharedFeatureHead(corpus.owner,day)).toEqual(before.head);
    expect(await target().prepare('SELECT count(*) n FROM analytics_shared_feature_parts').first<number>('n')).toBe(0);
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  }finally{if(dropped)await target().prepare(ddl!).run();}
},60_000);
