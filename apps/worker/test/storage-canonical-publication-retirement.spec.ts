import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {beginCanonicalPublicationClosure,appendCanonicalPublicationExpected,sealCanonicalPublicationExpected,commitCanonicalPublicationClosure,retireCanonicalPublicationPage} from '../src/storage-canonical-publication';
import {retireMaintainedPublicationCohorts} from '../src/storage-community-publication-cohort';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork} from '../src/storage-analytics-partition-work';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-publication-retirement',hash='a'.repeat(64);
beforeEach(async()=>{
 await reset();await applyD1Migrations(target,b.TEST_ANALYTICS_MIGRATIONS);
 await target.prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(sourceId,sourceId).run();
 await target.prepare(`WITH RECURSIVE seq(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<130)
 INSERT INTO analytics_owner_state SELECT ?,printf('%064x',n),1,1,'active' FROM seq`).bind(sourceId).run();
});
async function hold(nowMs:number){
 await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'cleanup',lane:'history',partitionKey:'synthetic/hold',
  headKey:hash,inputRevision:hash,policyRevision:hash,day:null,stream:null,selectionMethod:null,residentBytes:1,admissionQueries:1}],nowMs);
 return (await claimAnalyticsPartitionWork(target,{sourceId,nowMs,limit:1}))[0]!;
}
it('protects a live publisher and drains abandoned capturing closure children before its header',async()=>{
 const nowMs=Date.now();const closure=await beginCanonicalPublicationClosure(target,{sourceId,day:'2026-09-20',family:'activity',
  watermark:1,authorityDigest:hash,expectedCount:130,nowMs:0});
 for(let start=0;start<130;start+=128)await appendCanonicalPublicationExpected(target,closure,
  Array.from({length:Math.min(128,130-start)},(_,n)=>({partitionKey:'synthetic/'+String(start+n).padStart(3,'0'),contentRevision:hash})));
 const lease=await hold(nowMs);
 expect(await retireCanonicalPublicationPage(target,{sourceId,beforeMs:1,nowMs})).toBe(0);
 expect(await target.prepare('SELECT state FROM analytics_canonical_publication_closures WHERE closure_key=?').bind(closure).first<string>('state')).toBe('capturing');
 await releaseAnalyticsPartitionWork(target,lease,'complete',nowMs+1);
 expect(await retireCanonicalPublicationPage(target,{sourceId,beforeMs:1,nowMs:nowMs+2})).toBe(129);
 expect(await target.prepare('SELECT state FROM analytics_canonical_publication_closures WHERE closure_key=?').bind(closure).first<string>('state')).toBe('invalidated');
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_expected WHERE closure_key=?').bind(closure).first<number>('n')).toBe(2);
 expect(await retireCanonicalPublicationPage(target,{sourceId,beforeMs:1,nowMs:nowMs+3})).toBe(3);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_publication_closures WHERE closure_key=?').bind(closure).first()).toBeNull();
 expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('bounds expired cohort drains, protects live leases and preserves a complete current census',async()=>{
 const nowMs=Date.now(),old='b'.repeat(64),current='c'.repeat(64);
 await target.prepare(`INSERT INTO analytics_canonical_publication_cohorts(cohort_key,source_id,proof_digest,member_count,state,valid_until_ms,created_ms)
  VALUES(?,?,?,130,'complete',?,0),(?,?,?,0,'complete',?,0)`).bind(old,sourceId,old,nowMs-1,current,sourceId,current,nowMs+86400000).run();
 await target.prepare(`INSERT INTO analytics_canonical_publication_cohort_members SELECT ?,source_id,owner_digest,
  row_number() OVER(ORDER BY owner_digest)-1,'{}' FROM analytics_owner_state WHERE source_id=?`).bind(old,sourceId).run();
 const lease=await hold(nowMs);expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:1,nowMs,limit:16})).toBe(0);
 await releaseAnalyticsPartitionWork(target,lease,'complete',nowMs+1);
 expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:1,nowMs:nowMs+2,limit:16})).toBe(128);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_cohort_members WHERE cohort_key=?').bind(old).first<number>('n')).toBe(2);
 expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:1,nowMs:nowMs+3,limit:16})).toBe(3);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_publication_cohorts WHERE cohort_key=?').bind(current).first()).not.toBeNull();
 expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

it('retains a pinned last-good cache closure and cohort even after their metadata expires',async()=>{
 const nowMs=Date.now(),cohort='d'.repeat(64);
 const closure=await beginCanonicalPublicationClosure(target,{sourceId,day:'2026-09-20',family:'cache',watermark:1,
  authorityDigest:hash,expectedCount:0,nowMs:0});
 expect(await sealCanonicalPublicationExpected(target,closure)).toBe(true);
 expect(await commitCanonicalPublicationClosure(target,closure)).toBe(true);
 await target.prepare(`INSERT INTO analytics_canonical_publication_cohorts(cohort_key,source_id,proof_digest,member_count,state,valid_until_ms,created_ms)
  VALUES(?,?,?,0,'complete',?,0)`).bind(cohort,sourceId,cohort,nowMs-1).run();
 await target.prepare(`INSERT INTO analytics_canonical_cache_publications VALUES(?,1,?,?,0,'2026-09-20','{}','null',?,0)`)
  .bind(sourceId,closure,cohort,hash).run();
 expect(await retireCanonicalPublicationPage(target,{sourceId,beforeMs:1,nowMs})).toBe(0);
 expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:1,nowMs,limit:16})).toBe(0);
 expect(await target.prepare('SELECT closure_key,cohort_key FROM analytics_canonical_cache_publications WHERE source_id=?').bind(sourceId).first())
  .toEqual({closure_key:closure,cohort_key:cohort});
});

it('retires only cohorts positively superseded by a newer published cohort',async()=>{
 const nowMs=Date.now(),old='e'.repeat(64),published='f'.repeat(64),prepared='1'.repeat(64);
 const closure=await beginCanonicalPublicationClosure(target,{sourceId,day:'2026-09-20',family:'cache',watermark:1,
  authorityDigest:hash,expectedCount:0,nowMs:0});
 expect(await sealCanonicalPublicationExpected(target,closure)).toBe(true);
 expect(await commitCanonicalPublicationClosure(target,closure)).toBe(true);
 await target.prepare(`INSERT INTO analytics_canonical_publication_cohorts(cohort_key,source_id,proof_digest,member_count,state,valid_until_ms,created_ms)
  VALUES(?,?,?,0,'complete',?,0),(?,?,?,0,'complete',?,5),(?,?,?,0,'complete',?,8)`)
  .bind(old,sourceId,old,nowMs+86400000,published,sourceId,published,nowMs+86400000,prepared,sourceId,prepared,nowMs+86400000).run();
 await target.prepare(`INSERT INTO analytics_canonical_cache_publications VALUES(?,1,?,?,0,'2026-09-20','{}','null',?,10)`)
  .bind(sourceId,closure,published,hash).run();
 expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:20,nowMs,limit:16})).toBe(2);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_publication_cohorts WHERE cohort_key=?').bind(old).first()).toBeNull();
 expect(await retireMaintainedPublicationCohorts(target,{sourceId,beforeMs:20,nowMs,limit:16})).toBe(0);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_publication_cohorts WHERE cohort_key=?').bind(prepared).first()).not.toBeNull();
});
