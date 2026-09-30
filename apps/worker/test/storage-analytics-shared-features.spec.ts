import { env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
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
async function finish(owner:Awaited<ReturnType<typeof setup>>['owner'],day:string) {
  let deferred=0;
  for (let attempt=0;attempt<24;attempt++) {
    const {value,meter}=input(owner,day);
    const result=await advanceSharedAnalyticsFeatureDay(value);
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
  let firstReads=0;
  for(let attempt=0;attempt<2;attempt++) {
    const {value,meter}=input(corpus.owner,day);
    let now=Date.now(),dependencies=0,pages=0;
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
  const completed=await finish(corpus.owner,day);
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
