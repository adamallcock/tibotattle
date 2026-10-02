import { env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { readStorageCommunityOwner, readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { storageCommunityGraphPreviewReadyHint } from '../src/storage-community-graph-publication';
import { canonicalRollingSqlProfile } from './helpers/canonical-rolling-profile';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const bindings=env as Bindings;
const source=()=>bindings.USAGE_MONITOR_DB;
const target=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-c06-metadata-audit';
const sourceNamespace=sourceId;
type Reading={label:string;sql:string;args:unknown[];rowsRead:number;returnedRows:number};

/** Keep exact SQL and synthetic binds only in test memory for EXPLAIN. Never
 * retain source result rows, and exclude fixture setup and EXPLAIN resources. */
function observingSource(db:D1Database,readings:Reading[]):D1Database {
  const prepared=(inner:D1PreparedStatement,sql:string,args:unknown[]=[]):D1PreparedStatement=>
    new Proxy(inner,{get(_target,key){
      if(key==='bind')return(...values:unknown[])=>prepared(inner.bind(...values),sql,values);
      if(key==='all')return async()=>{
        const result=await inner.all();
        readings.push({label:'',sql,args,rowsRead:result.meta.rows_read,returnedRows:result.results.length});
        return result;
      };
      const member=Reflect.get(inner,key);
      return typeof member==='function'?member.bind(inner):member;
    }});
  return new Proxy(db,{get(_target,key){
    if(key==='prepare')return(sql:string)=>prepared(db.prepare(sql),sql);
    const member=Reflect.get(db,key);
    return typeof member==='function'?member.bind(db):member;
  }});
}

async function observe(calendarDays:number){
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId,sourceNamespace);
  const anchorDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,
    anchorDay,calendarDays,graphDays:2});
  // All accepted native fixture writes are complete before measurement begins.
  const readings:Reading[]=[];
  const profile=canonicalRollingSqlProfile(()=>`c06_${calendarDays}`);
  const measured=profile.wrap(observingSource(source(),readings),'source');
  const page=await readStorageCommunityOwnerPage(measured,{limit:64});
  readings.at(-1)!.label='page';
  const linkedPage=await readStorageCommunityOwnerPage(measured,{limit:64,requireLinkedOwner:true});
  readings.at(-1)!.label='linked_page';
  const owner=await readStorageCommunityOwner(measured,{ownerDigest:corpus.owner.ownerDigest});
  readings.at(-1)!.label='digest';
  const preview=await storageCommunityGraphPreviewReadyHint({source:measured,target:target(),sourceId,sourceNamespace},
    {nowMs:Date.now()});
  readings.at(-1)!.label='preview';
  expect(page.some(row=>row.ownerDigest===corpus.owner.ownerDigest)).toBe(true);
  expect(linkedPage.some(row=>row.ownerDigest===corpus.owner.ownerDigest)).toBe(true);
  expect(linkedPage.every(row=>row.ownerDigest!==null&&row.ownerRevision>0&&row.authorityEpoch>0)).toBe(true);
  expect(owner).toEqual(corpus.owner);
  expect(typeof preview).toBe('boolean');
  expect(readings.map(row=>row.label)).toEqual(['page','linked_page','digest','preview']);
  const measuredReadings=readings.slice();
  const report=await profile.report();
  expect(report.rawPhysicalHistory).toHaveLength(4);
  expect(report.rawPhysicalHistory.every(row=>row.category==='source_authority'&&
    row.payloadBearingRows===0&&row.rowsWritten===0)).toBe(true);
  const plans=await Promise.all(measuredReadings.map(async row=>{
    // EXPLAIN is a separate read against the same accepted source snapshot.
    const result=await source().prepare('EXPLAIN QUERY PLAN '+row.sql).bind(...row.args)
      .all<{detail:string}>();
    return {label:row.label,details:result.results.map(item=>item.detail)};
  }));
  expect(plans.every(plan=>plan.details.length>0)).toBe(true);
  if(calendarDays===466){
    const eligibility=await source().prepare(`SELECT type FROM sqlite_schema
      WHERE name='community_public_source_owners'`).first<{type:string}>();
    expect(eligibility?.type).toBe('view');
    await source().prepare('DROP VIEW community_public_source_owners').run();
    await expect(readStorageCommunityOwner(source(),{ownerDigest:corpus.owner.ownerDigest})).rejects.toThrow();
    await expect(storageCommunityGraphPreviewReadyHint({source:source(),target:target(),sourceId,sourceNamespace},
      {nowMs:Date.now()})).rejects.toThrow();
  }
  return {calendarDays,readings:measuredReadings,raw:report.rawPhysicalHistory,
    plans:plans.map(plan=>({label:plan.label,
      indexedSearches:plan.details.filter(detail=>/\bSEARCH\b.*\bUSING\b.*\bINDEX\b/iu.test(detail)).length,
      indexNames:[...new Set(plan.details.flatMap(detail=>{
        const match=/\bUSING\s+(?:COVERING\s+)?INDEX\s+([a-zA-Z0-9_]+)/iu.exec(detail);
        return match?[match[1]!]:[];
      }))].sort(),
      fullHistoryScans:plan.details.filter(detail=>/\bSCAN\s+(?:typed_telemetry_records|telemetry_v1_records|telemetry_v12_records)\b/iu.test(detail))}))};
}

it('reads only fresh owner and cohort metadata across accepted short and 466-day source histories',async()=>{
  const short=await observe(14),long=await observe(466);
  expect(long.raw.map(row=>row.fingerprint).sort()).toEqual(short.raw.map(row=>row.fingerprint).sort());
  expect(long.raw.every(row=>row.resultProjection.analyticalProjectionRows===0&&
    row.resultProjection.unclassifiedRows===0)).toBe(true);
  expect(long.plans.every(plan=>plan.fullHistoryScans.length===0)).toBe(true);
  const totals=(rows:Reading[])=>rows.map(row=>({label:row.label,rowsRead:row.rowsRead,
    returnedRows:row.returnedRows}));
  // This is a local, synthetic metadata/index scaling observation. It is not a
  // proof about view aliases, sessions, triggers, physical pages, or all C06.
  console.log(JSON.stringify({contract:'c06-source-metadata-synthetic-v1',short:totals(short.readings),
    long:totals(long.readings),shapes:long.raw.map(row=>({fingerprint:row.fingerprint,
      rowsRead:row.rowsRead,returnedRows:row.returnedRows,payloadBearingRows:row.payloadBearingRows})),
    plans:long.plans,unqualified:['view-alias','session','trigger','physical-page-access']}));
},180_000);
