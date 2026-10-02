import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {effectiveSelectiveSchemaAvailable,readEffectiveDependencySourceFence} from '../src/storage-effective-selective-dependencies';
import {canonicalAnalyticsAvailable,CANONICAL_ANALYTICS_TABLES} from '../src/storage-canonical-analytics-facts';
import {canonicalFeatureContributionsAvailable,CANONICAL_FEATURE_CONTRIBUTION_TABLES,
  CANONICAL_FEATURE_CONTRIBUTION_TRIGGERS} from '../src/storage-canonical-feature-contributions';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

type Captured={sql:string;bound:unknown[]};
type Pair=readonly [type:string,name:string];
type Hint=readonly [rowid:number,type:string,name:string];
type Cost={rowsRead:number;rowsWritten:number;databaseMs:number;wallMs:number};
const bindings=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>bindings.USAGE_MONITOR_DB,target=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-capability-profile';
function capture(db:D1Database):{db:D1Database;calls:Captured[]}{
 const calls:Captured[]=[];
 const wrapped=new Proxy(db,{get(inner,key){
  if(key==='prepare')return(sql:string)=>{
   const call:Captured={sql,bound:[]};calls.push(call);
   const statement=inner.prepare(sql);
   return new Proxy(statement,{get(prepared,method){
    if(method==='bind')return(...values:unknown[])=>{
     call.bound=values;
     return Reflect.apply(prepared.bind,prepared,values) as D1PreparedStatement;
    };
    const value:unknown=Reflect.get(prepared,method);
    return typeof value==='function'?value.bind(prepared):value;
   }});
  };
  const value:unknown=Reflect.get(inner,key);
  return typeof value==='function'?value.bind(inner):value;
 }});
 return {db:wrapped,calls};
}
function pairs(value:unknown):Pair[]{
 expect(typeof value).toBe('string');
 const parsed:unknown=JSON.parse(value as string);
 expect(Array.isArray(parsed)).toBe(true);
 const result=(parsed as unknown[]).map(item=>{
  if(!Array.isArray(item)||item.length!==2||!['table','index','trigger','view'].includes(item[0])
    ||typeof item[1]!=='string')throw new Error('capability profile captured malformed required pair');
  return [item[0],item[1]] as Pair;
 });
 expect(new Set(result.map(item=>JSON.stringify(item))).size).toBe(result.length);
 return result;
}
const originalCount=`SELECT count(*) AS n FROM sqlite_schema s WHERE (s.type,s.name) IN(
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`;
// Preserve the original target availability query as the profile's fixed
// oracle even after the production caller switches to typed rowid inventories.
const originalTargetRows=`SELECT type,name FROM sqlite_schema WHERE name IN(
 SELECT value FROM json_each(?))`;
const required=`WITH required(type,name) AS MATERIALIZED (
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1))`;
const shapes={
 materializedJoin:`${required} SELECT count(*) AS n FROM required r JOIN sqlite_schema s ON s.type=r.type AND s.name=r.name`,
 materializedExists:`${required} SELECT count(*) AS n FROM required r WHERE EXISTS(
   SELECT 1 FROM sqlite_schema s WHERE s.name=r.name AND s.type=r.type)`,
 directJoin:`SELECT count(*) AS n FROM json_each(?1) r JOIN sqlite_schema s
   ON s.name=json_extract(r.value,'$[1]') AND s.type=json_extract(r.value,'$[0]')`,
} as const;
const rowShapes={
 materializedJoin:`${required} SELECT s.type,s.name FROM required r JOIN sqlite_schema s
   ON s.name=r.name AND s.type=r.type`,
 materializedExists:`${required} SELECT s.type,s.name FROM sqlite_schema s WHERE EXISTS(
   SELECT 1 FROM required r WHERE r.name=s.name AND r.type=s.type)`,
 directJoin:`SELECT s.type,s.name FROM json_each(?1) r JOIN sqlite_schema s
   ON s.name=json_extract(r.value,'$[1]') AND s.type=json_extract(r.value,'$[0]')`,
} as const;
async function query(db:D1Database,sql:string,bound:unknown[]):Promise<{rows:Record<string,unknown>[];cost:Cost}>{
 const start=performance.now();
 const prepared=db.prepare(sql);
 const statement=Reflect.apply(prepared.bind,prepared,bound) as D1PreparedStatement;
 const result=await statement.all<Record<string,unknown>>();
 const meta=result.meta;
 expect(meta.rows_read).toBeGreaterThanOrEqual(0);
 expect(meta.rows_written).toBe(0);
 expect(meta.duration).toBeGreaterThanOrEqual(0);
 return {rows:result.results,cost:{rowsRead:meta.rows_read,rowsWritten:meta.rows_written,
  databaseMs:meta.duration,wallMs:performance.now()-start}};
}
async function count(db:D1Database,sql:string,list:readonly Pair[]):Promise<{n:number;cost:Cost}>{
 const result=await query(db,sql,[JSON.stringify(list)]);
 expect(result.rows).toHaveLength(1);
 const n=result.rows[0]!.n;
 expect(typeof n).toBe('number');
 return {n:n as number,cost:result.cost};
}
const mean=(values:readonly number[])=>values.reduce((sum,value)=>sum+value,0)/values.length;
async function compareCounts(db:D1Database,list:readonly Pair[],rounds=3){
 const report:Record<string,{statements:number;rowsRead:number;databaseMs:number;wallMs:number}>={};
 for(const [name,sql] of Object.entries({original:originalCount,...shapes})){
  const costs:Cost[]=[];
  for(let index=0;index<rounds;index++){
   const result=await count(db,sql,list);expect(result.n).toBe(list.length);costs.push(result.cost);
  }
  report[name]={statements:rounds,rowsRead:mean(costs.map(cost=>cost.rowsRead)),
   databaseMs:mean(costs.map(cost=>cost.databaseMs)),wallMs:mean(costs.map(cost=>cost.wallMs))};
 }
 return report;
}
const rowKeys=(rows:readonly Record<string,unknown>[])=>rows.map(row=>{
 expect(typeof row.type).toBe('string');expect(typeof row.name).toBe('string');
 return JSON.stringify([row.type,row.name]);
}).sort();
const hintKey=(hint:Hint)=>JSON.stringify(hint);
// D1 rejects 141 independently bound triples. One JSON argument preserves
// exact triple matching and lets the planner decide whether rowid drives seeks.
const hintPredicate=`(rowid,type,name) IN (SELECT json_extract(value,'$[0]'),
 json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?))`;
const hintSql=()=>`SELECT rowid,type,name FROM sqlite_schema WHERE ${hintPredicate}`;
const hintBound=(hints:readonly Hint[])=>[JSON.stringify(hints)];
const rowidOnlySql=`SELECT rowid,type,name FROM sqlite_schema WHERE rowid IN(
 SELECT CAST(value AS INTEGER) FROM json_each(?))`;
const rowidOnlyBound=(hints:readonly Hint[])=>[JSON.stringify(hints.map(hint=>hint[0]))];
function hintedRows(rows:readonly Record<string,unknown>[]):Hint[]{
 return rows.map(row=>{
  expect(typeof row.rowid).toBe('number');
  expect(Number.isSafeInteger(row.rowid)).toBe(true);
  expect(typeof row.type).toBe('string');expect(typeof row.name).toBe('string');
  return [row.rowid as number,row.type as string,row.name as string];
 });
}
async function fullHintInventory(db:D1Database,list:readonly Pair[]):Promise<{complete:boolean;hints:Hint[];cost:Cost}>{
 const full=await query(db,`SELECT rowid,type,name FROM sqlite_schema s WHERE (s.type,s.name) IN(
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`,[JSON.stringify(list)]);
 const found=hintedRows(full.rows),byPair=new Map(found.map(hint=>[JSON.stringify([hint[1],hint[2]]),hint]));
 const hints=list.map(pair=>byPair.get(JSON.stringify(pair))).filter((hint):hint is Hint=>hint!==undefined);
 const complete=found.length===list.length&&hints.length===list.length
  &&new Set(found.map(hint=>hint[0])).size===list.length;
 return {complete,hints,cost:full.cost};
}
async function freshHintInventoryWith(db:D1Database,list:readonly Pair[],hints:readonly Hint[],
 mode:'exactTriple'|'rowidOnly'):Promise<{
 complete:boolean;hints:Hint[];fallback:boolean;freshCost:Cost;fallbackCost?:Cost}>{
 const fresh=await query(db,mode==='exactTriple'?hintSql():rowidOnlySql,
  mode==='exactTriple'?hintBound(hints):rowidOnlyBound(hints));
 const received=hintedRows(fresh.rows).map(hintKey).sort();
 const hintsMatchRequired=JSON.stringify(hints.map(hint=>JSON.stringify([hint[1],hint[2]])).sort())
  ===JSON.stringify(list.map(pair=>JSON.stringify(pair)).sort());
 if(hintsMatchRequired&&received.length===list.length
   &&JSON.stringify(received)===JSON.stringify(hints.map(hintKey).sort()))
  return {complete:true,hints:[...hints],fallback:false,freshCost:fresh.cost};
 // Rowids are hints, not authority. A mismatch always pays the original full
 // typed inventory before availability can be affirmed or hints refreshed.
 const full=await fullHintInventory(db,list);
 return {complete:full.complete,hints:full.hints,fallback:true,freshCost:fresh.cost,fallbackCost:full.cost};
}
const freshHintInventory=(db:D1Database,list:readonly Pair[],hints:readonly Hint[])=>
 freshHintInventoryWith(db,list,hints,'exactTriple');
const freshRowidOnlyInventory=(db:D1Database,list:readonly Pair[],hints:readonly Hint[])=>
 freshHintInventoryWith(db,list,hints,'rowidOnly');
async function compareHints(db:D1Database,list:readonly Pair[],rounds=3,
 mode:'exactTriple'|'rowidOnly'='exactTriple'){
 const setup=await fullHintInventory(db,list);expect(setup.complete).toBe(true);
 const costs:Cost[]=[];
 for(let index=0;index<rounds;index++){
  const fresh=await freshHintInventoryWith(db,list,setup.hints,mode);
  expect(fresh.complete).toBe(true);expect(fresh.fallback).toBe(false);costs.push(fresh.freshCost);
 }
 return {hints:setup.hints,setup:setup.cost,
  fresh:{statements:rounds,rowsRead:mean(costs.map(cost=>cost.rowsRead)),
   databaseMs:mean(costs.map(cost=>cost.databaseMs)),wallMs:mean(costs.map(cost=>cost.wallMs))}};
}
async function compareRows(db:D1Database,call:Captured,list:readonly Pair[],rounds=3){
 const report:Record<string,{statements:number;rowsRead:number;databaseMs:number;wallMs:number}>={};
 const expected=list.map(item=>JSON.stringify(item)).sort();
 for(const [name,sql,bound] of [
  ['original',call.sql,call.bound],
  ...Object.entries(rowShapes).map(([key,value])=>[key,value,[JSON.stringify(list)]])
 ] as Array<[string,string,unknown[]]>){
  const costs:Cost[]=[];
  for(let index=0;index<rounds;index++){
   const result=await query(db,sql,bound);
   expect(rowKeys(result.rows)).toEqual(expected);
   costs.push(result.cost);
  }
  report[name]={statements:rounds,rowsRead:mean(costs.map(cost=>cost.rowsRead)),
   databaseMs:mean(costs.map(cost=>cost.databaseMs)),wallMs:mean(costs.map(cost=>cost.wallMs))};
 }
 return report;
}
async function matchAll(db:D1Database,list:readonly Pair[],expected:boolean){
 for(const sql of [originalCount,...Object.values(shapes)]){
  const result=await count(db,sql,list);expect(result.n===list.length).toBe(expected);
 }
}

it('compares fresh exact source/target capability inventories on full local D1 schemas',async()=>{
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId);
 const sourceCapture=capture(source()),targetCapture=capture(target());
 expect(await effectiveSelectiveSchemaAvailable(sourceCapture.db)).toBe(true);
 expect(await readEffectiveDependencySourceFence(sourceCapture.db)).toMatchObject({capabilityVersion:'effective-selective-v1'});
 expect(await canonicalAnalyticsAvailable(targetCapture.db)).toBe(true);
 expect(await canonicalFeatureContributionsAvailable(targetCapture.db)).toBe(true);
 expect(sourceCapture.calls).toHaveLength(2);expect(targetCapture.calls).toHaveLength(2);
 const selective=pairs(sourceCapture.calls[0]!.bound[0]);
 const fence=pairs(sourceCapture.calls[1]!.bound[1]);
 expect(sourceCapture.calls[1]!.bound[2]).toBe(fence.length);
 expect(fence.length).toBeGreaterThan(selective.length);
 const canonical=pairs(targetCapture.calls[0]!.bound[0]);
 expect(canonical.filter(item=>item[0]==='table').map(item=>item[1]).sort())
  .toEqual([...CANONICAL_ANALYTICS_TABLES].sort());
 const features=pairs(targetCapture.calls[1]!.bound[0]);
 expect(features.filter(item=>item[0]==='table').map(item=>item[1]).sort())
  .toEqual([...CANONICAL_FEATURE_CONTRIBUTION_TABLES].sort());
 expect(features.filter(item=>item[0]==='trigger').map(item=>item[1]).sort())
  .toEqual([...CANONICAL_FEATURE_CONTRIBUTION_TRIGGERS].sort());
 for(const [label,db,list] of [
  ['sourceSelective',source(),selective],['sourceFence',source(),fence],
 ] as const){
  const report=await compareCounts(db,list);
  const hinted=await compareHints(db,list);
  const rowidOnly=await compareHints(db,list,3,'rowidOnly');
  // Only aggregate metrics and fixed capability names leave the test.
  console.log(JSON.stringify({schema:'capability-query-profile-v1',capability:label,required:list.length,
   report:{...report,rowidHint:hinted.fresh,rowidOnly:rowidOnly.fresh},
   rowidHintSetup:hinted.setup,rowidOnlySetup:rowidOnly.setup}));
 }
 const targetCases:Array<[string,Captured,readonly Pair[]]>=[
  ['targetCanonical',{sql:originalTargetRows,bound:[JSON.stringify(canonical.map(item=>item[1]))]},canonical],
  ['targetFeatures',{sql:originalTargetRows,bound:[JSON.stringify(features.map(item=>item[1]))]},features],
 ];
 for(const [label,call,list] of targetCases){
  const report=await compareRows(target(),call,list);
  const hinted=await compareHints(target(),list);
  const rowidOnly=await compareHints(target(),list,3,'rowidOnly');
  console.log(JSON.stringify({schema:'capability-query-profile-v1',capability:label,required:list.length,
   report:{...report,rowidHint:hinted.fresh,rowidOnly:rowidOnly.fresh},
   rowidHintSetup:hinted.setup,rowidOnlySetup:rowidOnly.setup}));
 }
 const originalFence=await query(source(),sourceCapture.calls[1]!.sql,sourceCapture.calls[1]!.bound);
 expect(originalFence.rows).toHaveLength(1);
 const expected=originalFence.rows[0]!;
 const candidateFence=`WITH required(type,name) AS MATERIALIZED (
   SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?2))
   SELECT sequence AS generation,method AS capabilityVersion FROM storage_effective_selective_runtime
   WHERE id=1 AND method=?1 AND (SELECT count(*) FROM required r JOIN sqlite_schema s
     ON s.name=r.name AND s.type=r.type)=?3`;
 const current=await query(source(),candidateFence,sourceCapture.calls[1]!.bound);
 expect(current.rows).toEqual([expected]);
 const hintedFence=await compareHints(source(),fence,1);
 const hintFenceSql=`SELECT sequence AS generation,method AS capabilityVersion
  FROM storage_effective_selective_runtime WHERE id=1 AND method=?
  AND (SELECT count(*) FROM sqlite_schema WHERE ${hintPredicate})=?`;
 const hintFenceBound=[sourceCapture.calls[1]!.bound[0],...hintBound(hintedFence.hints),fence.length];
 const hintedCurrent=await query(source(),hintFenceSql,hintFenceBound);
 expect(hintedCurrent.rows).toEqual([expected]);
 console.log(JSON.stringify({schema:'capability-query-profile-v1',capability:'sourceFenceGuard',
  original:originalFence.cost,candidate:current.cost,rowidHint:hintedCurrent.cost,
  rowidHintSetup:hintedFence.setup,rowidOnlyAtomicReplacement:false}));
 // Rowid-only acquisition checks names/types in JS after its query. The
 // runtime method/generation and current schema cannot then share one D1
 // statement, so this shape is only an inventory candidate, never a fence.
 // Wrong runtime method must still refuse even when all schema objects exist.
 const wrong=await query(source(),candidateFence,['wrong-method',sourceCapture.calls[1]!.bound[1],fence.length]);
 expect(wrong.rows).toEqual([]);
 const wrongHinted=await query(source(),hintFenceSql,['wrong-method',...hintBound(hintedFence.hints),fence.length]);
 expect(wrongHinted.rows).toEqual([]);
},120_000);

it('refuses missing table/index/trigger, wrong type/name, then observes restored objects freshly',async()=>{
 await reset();
 await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 const table='profile_capability_table',index='profile_capability_index',trigger='profile_capability_trigger';
 const complete:Pair[]=[['table',table],['index',index],['trigger',trigger]];
 const create=async()=>{
  await target().prepare(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`).run();
  await target().prepare(`CREATE INDEX ${index} ON ${table}(id)`).run();
  await target().prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} BEGIN SELECT 1; END`).run();
 };
 await create();await matchAll(target(),complete,true);
 let current=(await fullHintInventory(target(),complete));expect(current.complete).toBe(true);
 const checkHint=async(expected:boolean)=>{
  const rowidOnly=await freshRowidOnlyInventory(target(),complete,current.hints);
  const result=await freshHintInventory(target(),complete,current.hints);
  expect(result.complete).toBe(expected);
  expect(rowidOnly.complete).toBe(expected);
  expect(rowidOnly.fallback).toBe(result.fallback);
  if(result.complete)current={complete:true,hints:result.hints,cost:result.fallbackCost??result.freshCost};
  return result;
 };
 expect((await checkHint(true)).fallback).toBe(false);
 await target().prepare(`DROP INDEX ${index}`).run();await matchAll(target(),complete,false);
 expect((await checkHint(false)).fallback).toBe(true);
 await target().prepare(`CREATE INDEX ${index} ON ${table}(id)`).run();await matchAll(target(),complete,true);
 expect((await checkHint(true)).fallback).toBe(true);
 await target().prepare(`DROP TRIGGER ${trigger}`).run();await matchAll(target(),complete,false);
 expect((await checkHint(false)).fallback).toBe(true);
 await target().prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} BEGIN SELECT 1; END`).run();await matchAll(target(),complete,true);
 expect((await checkHint(true)).fallback).toBe(true);
 await target().prepare(`DROP TABLE ${table}`).run();await matchAll(target(),complete,false);
 expect((await checkHint(false)).fallback).toBe(true);
 await create();await matchAll(target(),complete,true);
 expect((await checkHint(true)).fallback).toBe(true);
 await target().prepare('CREATE TABLE profile_capability_unrelated(id INTEGER PRIMARY KEY)').run();
 expect((await checkHint(true)).complete).toBe(true);
 // A reused or stale rowid pointing to a different object cannot pass the
 // triple query. Full fallback may affirm only the complete current inventory.
 const foreign=(await fullHintInventory(target(),[['table','profile_capability_unrelated']])).hints[0]!;
 const wrongHint=current.hints.map((hint,index)=>index===0?[foreign[0],hint[1],hint[2]] as Hint:hint);
 const recovered=await freshHintInventory(target(),complete,wrongHint);
 expect(recovered.complete).toBe(true);expect(recovered.fallback).toBe(true);
 const rowidRecovered=await freshRowidOnlyInventory(target(),complete,wrongHint);
 expect(rowidRecovered.complete).toBe(true);expect(rowidRecovered.fallback).toBe(true);
 const wrongExpectedName=current.hints.map((hint,index)=>index===0
  ?[hint[0],hint[1],'profile_capability_unrelated'] as Hint:hint);
 const wrongExpected=await freshRowidOnlyInventory(target(),complete,wrongExpectedName);
 expect(wrongExpected.complete).toBe(true);expect(wrongExpected.fallback).toBe(true);
 await target().prepare(`DROP TABLE ${table}`).run();
 const noFalsePositive=await freshHintInventory(target(),complete,wrongHint);
 expect(noFalsePositive.complete).toBe(false);expect(noFalsePositive.fallback).toBe(true);
 const rowidNoFalsePositive=await freshRowidOnlyInventory(target(),complete,wrongHint);
 expect(rowidNoFalsePositive.complete).toBe(false);expect(rowidNoFalsePositive.fallback).toBe(true);
 await create();expect((await checkHint(true)).complete).toBe(true);
 await target().prepare('CREATE VIEW profile_capability_view AS SELECT 1 id').run();
 await matchAll(target(),[['table','profile_capability_view']],false);
 const wrongType=await fullHintInventory(target(),[['table','profile_capability_view']]);
 expect(wrongType.complete).toBe(false);
 const viewHint=(await fullHintInventory(target(),[['view','profile_capability_view']])).hints[0]!;
 expect((await freshRowidOnlyInventory(target(),[['table','profile_capability_view']],
  [[viewHint[0],'table','profile_capability_view']])).complete).toBe(false);
 await matchAll(target(),[['table','profile_capability_missing']],false);
 const wrongName=await fullHintInventory(target(),[['table','profile_capability_missing']]);
 expect(wrongName.complete).toBe(false);
 expect((await freshRowidOnlyInventory(target(),[['table','profile_capability_missing']],
  [[current.hints[0]![0],'table','profile_capability_missing']])).complete).toBe(false);
 await matchAll(target(),complete,true);
},120_000);
