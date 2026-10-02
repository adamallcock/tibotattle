import { env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { advanceStorageAnalyticsPreparation } from '../src/storage-analytics-preparation';
import { readStorageCommunityOwner, readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-preparation',sourceNamespace=sourceId;
async function setup(options:{dense?:boolean;old?:boolean;preMigration?:boolean}={}) {
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),options.preMigration
  ?{...b,TEST_ANALYTICS_MIGRATIONS:b.TEST_ANALYTICS_MIGRATIONS.filter(migration=>migration.name<'0034_')}:b,sourceId,sourceNamespace);
 const anchorDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,
  anchorDay,calendarDays:options.old?130:14,graphDays:2,...(options.dense?{denseUsageRows:401}:{})});
 for(const owner of await readStorageCommunityOwnerPage(source())) {
  if(owner.ownerDigest!==corpus.owner.ownerDigest)await target().prepare(`INSERT INTO analytics_owner_state
   (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
   .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,'active').run();
 }
 return corpus;
}
async function run(throughDay:string,options:{maxAttempts?:number;queries?:number;now?:()=>number}={}) {
 const meter=createD1InvocationBudget(options.queries??950),now=options.now??Date.now;
 const result=await advanceStorageAnalyticsPreparation({source:meter.wrap(source()),target:meter.wrap(target()),
  sourceId,sourceNamespace,sharedFeatures:true,maxAttempts:options.maxAttempts??1,throughDay,
  budget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:now()+60_000,now}});
 expect(meter.queriesUsed).toBeLessThanOrEqual(options.queries??950);
 expect(result.attempts).toBeLessThanOrEqual(options.maxAttempts??1);
 return {result,queries:meter.queriesUsed};
}
async function choose(turn:number) {
 await target().prepare(`INSERT INTO analytics_shared_preparation_cursor(source_id,turn) VALUES(?,?)
  ON CONFLICT(source_id) DO UPDATE SET turn=excluded.turn,
   after_recent_owner='',after_dirty_owner='',after_history_owner='',after_resume_rowid=0`)
  .bind(sourceId,turn).run();
}
async function forceRecent(ownerDigest:string,day:string) {
 await choose(1);
 const range=await target().prepare(`SELECT revision FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,ownerDigest).first<{revision:number}>();
 if(range)await target().prepare(`UPDATE analytics_shared_preparation_ranges SET recent_next_day=?,revision=revision+1,updated_ms=?
  WHERE source_id=? AND owner_digest=?`).bind(day,Date.now(),sourceId,ownerDigest).run();
}

it('opens no statement while disabled and refuses before a preparation migration',async()=>{
 let touched=0;
 const fake=()=>({prepare(){touched++;throw new Error('unexpected statement');}} as unknown as D1Database);
 expect(await advanceStorageAnalyticsPreparation({source:fake(),target:fake(),sourceId,sourceNamespace,
  budget:{remainingQueries:()=>950,deadlineMs:Date.now()+60_000,now:Date.now}})).toMatchObject({state:'idle',reason:'disabled',attempts:0});
 expect(touched).toBe(0);
 const corpus=await setup({preMigration:true});
 expect((await run(corpus.graphDates[0]!)).result).toMatchObject({state:'refused',reason:'migration_required',attempts:0});
},60_000);

it('resumes dense day work while independent owner turns and all four lanes remain bounded',async()=>{
 const corpus=await setup({dense:true}),day=corpus.graphDates[0]!;
 await choose(1);
 const first=await run(day);
 expect(first.result).toMatchObject({attempts:1,recentAttempts:1,deferred:1});
 const head=await target().prepare(`SELECT state,head_revision FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=?`)
  .bind(sourceId,corpus.owner.ownerDigest,day).first<{state:string;head_revision:number}>();
 expect(head).toMatchObject({state:'building',head_revision:1});
 let resume=0,recent=0,dirty=0,history=0;
 for(let round=0;round<12;round++) {
  const {result}=await run(day);
  resume+=result.resumeAttempts;recent+=result.recentAttempts;dirty+=result.dirtyAttempts;history+=result.historyAttempts;
 }
 expect(resume).toBeGreaterThan(0);expect(recent).toBeGreaterThan(0);expect(dirty).toBeGreaterThan(0);expect(history).toBeGreaterThan(0);
 const owners=await target().prepare(`SELECT count(DISTINCT owner_digest) n FROM analytics_shared_feature_days WHERE source_id=?`)
  .bind(sourceId).first<number>('n');
 expect(owners).toBe(2);
 expect(await target().prepare(`SELECT state FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=?`)
  .bind(sourceId,corpus.owner.ownerDigest,day).first<string>('state')).toBe('complete');
 const stored=(await target().prepare('SELECT * FROM analytics_shared_preparation_cursor').all()).results;
 expect(JSON.stringify(stored)).not.toContain(corpus.participantId);
},180_000);

it('walks retained history as bounded ranges beyond the recent window',async()=>{
 const corpus=await setup({old:true}),throughDay=corpus.graphDates.at(-1)!;
 await choose(3);await run(throughDay);
 const first=await target().prepare(`SELECT history_from_day,history_through_day,history_next_day FROM analytics_shared_preparation_ranges
  WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest)
  .first<{history_from_day:string;history_through_day:string;history_next_day:string}>();
 expect(first).not.toBeNull();
 expect(Date.parse(first!.history_from_day)).toBeLessThan(Date.parse(throughDay)-100*86_400_000);
 expect(Date.parse(first!.history_through_day)-Date.parse(first!.history_from_day)).toBe(100*86_400_000);
 const nextFrom=new Date(Date.parse(first!.history_through_day)+86_400_000).toISOString().slice(0,10);
 await target().prepare(`UPDATE analytics_shared_preparation_ranges SET history_next_day=?,revision=revision+1,updated_ms=?
  WHERE source_id=? AND owner_digest=?`).bind(nextFrom,Date.now(),sourceId,corpus.owner.ownerDigest).run();
 await choose(3);expect((await run(throughDay)).result.historyAttempts).toBe(1);
 const next=await target().prepare(`SELECT history_from_day,history_through_day FROM analytics_shared_preparation_ranges
  WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest)
  .first<{history_from_day:string;history_through_day:string}>();
 expect(next!.history_from_day).toBe(nextFrom);
 expect(Date.parse(next!.history_through_day)-Date.parse(next!.history_from_day)).toBeLessThanOrEqual(100*86_400_000);
},180_000);

it('revalidates corrected days and purges owner scheduling metadata on erasure',async()=>{
 const corpus=await setup(),day=corpus.correctionDay;
 // The first recent turn targets the pinned horizon itself.
 await choose(1);await run(day);
 for(let attempt=0;attempt<5;attempt++) {
  await forceRecent(corpus.owner.ownerDigest,day);await run(day);
  if(await target().prepare(`SELECT 1 ready FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=? AND state='complete'`)
   .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('ready')===1)break;
 }
 const before=await target().prepare(`SELECT dependency_digest FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=? AND state='complete'`)
  .bind(sourceId,corpus.owner.ownerDigest,day).first<string>('dependency_digest');
 expect(before).not.toBeNull();
 const corrected=await corpus.mutateCorrection();
 for(let attempt=0;attempt<6;attempt++){await forceRecent(corrected.ownerDigest,day);await run(day);}
 const after=await target().prepare(`SELECT dependency_digest FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=? AND day=? AND state='complete' ORDER BY updated_ms DESC LIMIT 1`)
  .bind(sourceId,corrected.ownerDigest,day).first<string>('dependency_digest');
 expect(after).not.toBeNull();expect(after).not.toBe(before);
 await target().prepare(`UPDATE analytics_shared_preparation_cursor SET after_recent_owner=?,after_history_owner=? WHERE source_id=?`)
  .bind(corrected.ownerDigest,corrected.ownerDigest,sourceId).run();
 await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
  .bind(sourceId,corrected.ownerDigest,'c'.repeat(64),1,1,corrected.authorityEpoch,corrected.authorityEpoch).run();
 expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,corrected.ownerDigest).first<number>('n')).toBe(0);
 expect(await target().prepare(`SELECT after_recent_owner,after_history_owner FROM analytics_shared_preparation_cursor WHERE source_id=?`)
  .bind(sourceId).first()).toMatchObject({after_recent_owner:'',after_history_owner:''});
 expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,corrected.ownerDigest).first<number>('n')).toBe(0);
 await expect(target().prepare(`INSERT INTO analytics_shared_preparation_ranges VALUES(?,?,?,?,?,?,?,?,?)`)
  .bind(sourceId,corrected.ownerDigest,day,day,day,day,'',1,Date.now()).run()).rejects.toThrow();
},180_000);

it('recovers expired selection leases, refuses live contention and respects early query exhaustion',async()=>{
 const corpus=await setup(),day=corpus.graphDates[0]!;
 await choose(1);
 const now=Date.now();
 await target().prepare(`UPDATE analytics_shared_preparation_cursor SET claim_token=?,claim_expires_ms=?,updated_ms=? WHERE source_id=?`)
  .bind(crypto.randomUUID(),now+30_000,now,sourceId).run();
 expect((await run(day)).result).toMatchObject({state:'deferred',reason:'claim_busy',attempts:0});
 expect((await run(day,{now:()=>now+31_000})).result.attempts).toBe(1);
 expect(await target().prepare(`SELECT claim_token FROM analytics_shared_preparation_cursor WHERE source_id=?`)
  .bind(sourceId).first<string>('claim_token')).toBeNull();
 const low=await run(day,{queries:129});
 expect(low.result).toMatchObject({state:'deferred',reason:'query_budget_or_deadline',attempts:0});expect(low.queries).toBe(0);
},60_000);

it('uses the same closed owner admission for exact digest resume lookups',async()=>{
 const corpus=await setup();
 expect(await readStorageCommunityOwner(source(),{ownerDigest:corpus.owner.ownerDigest})).toEqual(corpus.owner);
 const page=await readStorageCommunityOwnerPage(source());
 expect(page).toHaveLength(2);
 expect(await readStorageCommunityOwner(source(),{ownerDigest:'0'.repeat(64)})).toBeNull();
},60_000);

it('passes ownerless legacy rows without changing the default owner inventory',async()=>{
 const corpus=await setup();
 // Model a legacy eligibility row that predates the typed digest link.
 await source().prepare(`INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,
  recovery_token_hash,state,consent_version,consented_at,created_at)
  VALUES('0-synthetic-ownerless',?,?,?,?,'active','privacy-safe-telemetry-v0.1',?,?)`)
  .bind(crypto.randomUUID(),new Uint8Array(32),crypto.randomUUID(),new Uint8Array(32),
   new Date().toISOString(),new Date().toISOString()).run();
 expect((await readStorageCommunityOwnerPage(source(),{limit:1}))[0]!.ownerDigest).toBeNull();
 const linked=await readStorageCommunityOwnerPage(source(),{limit:1,requireLinkedOwner:true});
 expect(linked[0]!.ownerDigest).toBe(corpus.owner.ownerDigest);
 await choose(1);
 expect((await run(corpus.graphDates[0]!)).result.recentAttempts).toBe(1);
},60_000);

it('does not mistake source-ahead owners for active target preparation authority',async()=>{
 const corpus=await setup(),day=corpus.graphDates[0]!;
 const other=(await readStorageCommunityOwnerPage(source())).find(owner=>owner.ownerDigest!==corpus.owner.ownerDigest)!;
 await target().prepare(`UPDATE analytics_owner_state SET revision=revision+1 WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,other.ownerDigest).run();
 await choose(1);await run(day);
 await target().prepare(`UPDATE analytics_shared_preparation_cursor SET turn=1 WHERE source_id=?`).bind(sourceId).run();
 expect((await run(day)).result).toMatchObject({state:'idle',attempts:0});
 expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,other.ownerDigest).first<number>('n')).toBe(0);
},60_000);

it('keeps multi-attempt work inside one actual statement budget and rotates dirty dates',async()=>{
 const corpus=await setup(),day=corpus.graphDates.at(-1)!;
 const old=corpus.correctionDay;
 await target().prepare(`INSERT INTO analytics_community_daily_queue(source_id,day,revision) VALUES(?,?,1),(?,?,1)`)
  .bind(sourceId,day,sourceId,old).run();
 await choose(2);const first=await run(day,{maxAttempts:4,queries:180});
 expect(first.queries).toBeLessThanOrEqual(180);expect(first.result.dirtyAttempts).toBe(1);
 const prior=await target().prepare(`SELECT dirty_after_day FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,corpus.owner.ownerDigest).first<string>('dirty_after_day');
 expect(prior).toBe(day);
 await choose(2);await run(day);
 expect(await target().prepare(`SELECT dirty_after_day FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,corpus.owner.ownerDigest).first<string>('dirty_after_day')).toBe(old);
},60_000);
