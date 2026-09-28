import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {modelBlockStoreSupported} from '../src/storage-analytics-model-block';
import {advanceSharedAnalyticsFeatureDay} from '../src/storage-analytics-shared-features';
import {advanceStorageCommunityDaily,readPublishedStorageCommunityDaily} from '../src/storage-community-daily';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus} from './fixtures/shared-analytics-corpus';

type Bindings=Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const b=env as Bindings,source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-redesign-migration',sourceNamespace=sourceId;
const bindings=()=>({source:source(),target:target(),sourceId,sourceNamespace});

it('preserves populated published data while advancing the observed analytics ledger from 0029 through 0032',async()=>{
 await reset();
 // Live read-only inspection on 2026-09-28 found 0027 absent. This rehearsal
 // deliberately preserves that divergence; these analytics features neither
 // need nor silently authorize the independent owner-history table migration.
 const before=b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0030_'&&!m.name.startsWith('0027_'));
 const additions=b.TEST_ANALYTICS_MIGRATIONS.filter(m=>/^003[012]_/u.test(m.name));
 expect(additions.map(m=>m.name.slice(0,4))).toEqual(['0030','0031','0032']);
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),{...b,TEST_ANALYTICS_MIGRATIONS:before},sourceId,sourceNamespace);
 const anchorDay=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
 const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay,calendarDays:14,graphDays:2});
 let published=false;
 for(let attempt=0;attempt<32&&!published;attempt++){
  const result=await advanceStorageCommunityDaily({...bindings(),day:anchorDay,maxOwners:4});
  published=result.state==='published';
 }
 expect(published).toBe(true);
 const readPublic=()=>readPublishedStorageCommunityDaily({...bindings(),fromDay:anchorDay,throughDay:anchorDay});
 const priorPublic=await readPublic();expect(priorPublic.rows).toHaveLength(1);
 expect(await modelBlockStoreSupported(target())).toBe(false);
 const featureInput=()=>{
  const meter=createD1InvocationBudget(950);
  return {meter,input:{...bindings(),source:meter.wrap(source()),target:meter.wrap(target()),
   owner:corpus.owner,day:anchorDay,
   budget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+55_000,now:Date.now}}};
 };
 expect((await advanceSharedAnalyticsFeatureDay(featureInput().input)).state).toBe('refused');
 const tables=(await target().prepare(`SELECT name FROM sqlite_schema WHERE type='table'
   AND name LIKE 'analytics_%' ORDER BY name`).all<{name:string}>()).results.map(row=>row.name);
 const retained=new Map<string,string[]>();
 for(const table of tables){
  expect(table).toMatch(/^analytics_[a-z0-9_]+$/u);
  const rows=(await target().prepare(`SELECT * FROM ${table}`).all()).results;
  retained.set(table,rows.map(row=>canonicalJson(row)).sort());
 }
 expect([...retained.values()].filter(rows=>rows.length>0).length).toBeGreaterThan(3);
 await applyD1Migrations(target(),additions);
 for(const table of tables){
  const rows=(await target().prepare(`SELECT * FROM ${table}`).all()).results;
  expect(rows.map(row=>canonicalJson(row)).sort(),table).toEqual(retained.get(table));
 }
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 expect(await target().prepare(`SELECT name FROM sqlite_schema
   WHERE name='analytics_admin_metrics_history_publications'`).first()).toBeNull();
 expect(await modelBlockStoreSupported(target())).toBe(true);
 expect(await readPublic()).toEqual(priorPublic);
 let completed=false;
 for(let attempt=0;attempt<16&&!completed;attempt++){
  const {meter,input}=featureInput();
  const result=await advanceSharedAnalyticsFeatureDay(input);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  expect(result.state).not.toBe('refused');completed=result.state==='complete';
 }
 expect(completed).toBe(true);
 // The old serving path continues to accept the unchanged public payload
 // after new private features have been written. Activation is a separate step.
 expect(await readPublic()).toEqual(priorPublic);
},120_000);
