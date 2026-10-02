import {expect,it} from 'vitest';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import type {D1SchemaObject} from '../src/d1-schema-object-hints';
import {EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA,readEffectiveDependencyMutationToken} from '../src/storage-effective-dependency-mutations';
import {maintainedEffectiveHistoryDependency,withMaintainedEffectiveDependencies} from '../src/storage-effective-dependency-summaries';
import type {StorageCommunityOwner} from '../src/storage-community-authority';
import type {EffectiveHistoryDependency} from '../src/effective-history-dependency';

const targetRequired:readonly D1SchemaObject[]=[['table','analytics_effective_dependency_summaries'],
 ...['insert','update','owner_update','owner_delete','runtime_update','runtime_delete','terminal_insert','terminal_update','contract_v1']
  .map(suffix=>['trigger',`analytics_effective_dependency_${suffix}`] as const),['index','analytics_effective_dependency_owner']];
const identity={participantId:'synthetic-hint-participant',ownerDigest:'a'.repeat(64),sourceId:'synthetic-hint-source',sourceNamespace:'synthetic-hint-source'};
const owner:StorageCommunityOwner={participantId:identity.participantId,ownerDigest:identity.ownerDigest,
 inputRevision:1,ownerRevision:1,authorityEpoch:1,hasV1:true,hasV11:false,hasV12:false,hasLegacy:false};
const nativeValue:EffectiveHistoryDependency={version:'effective-history-dependency-v3',participantId:identity.participantId,
 fromDay:'2026-10-01',throughDay:'2026-10-01',correctionRuntime:'active',streams:['usage','quota'],v1:[],v11:[],v12:[],corrections:[],occurrenceLinks:[]};
type SchemaRow={rowid:number;type:string;name:string};
type Call={sql:string;bound:unknown[];method:'all'|'first'};
function fakeBoundary(kind:'source'|'target') {
 const required=kind==='source'?EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA:targetRequired;
 let rows:SchemaRow[]=required.map(([type,name],index)=>({rowid:index+1,type,name}));
 let failure:Error|undefined,nativeCalls=0;
 const calls:Call[]=[];
 const proofStarted=new Error('synthetic source proof boundary reached');
 const schemaDatabase={prepare(sql:string){
  const make=(bound:unknown[]):D1PreparedStatement=>({
   bind:(...values:unknown[])=>make(values),
   all:async()=>{
    calls.push({sql,bound,method:'all'});if(failure)throw failure;
    if(!sql.includes('sqlite_schema'))throw new Error('unexpected fake schema query');
    const values:unknown=JSON.parse(bound[0] as string);
    if(!Array.isArray(values))throw new Error('malformed fake schema parameters');
    const selected=sql.includes('WHERE rowid IN')?rows.filter(row=>values.includes(row.rowid))
     :rows.filter(row=>values.some(pair=>Array.isArray(pair)&&pair[0]===row.type&&pair[1]===row.name));
    return {results:selected.map(row=>({...row})),success:true,meta:{rows_read:selected.length,rows_written:0,duration:0}};
   },
   first:async()=>{
    calls.push({sql,bound,method:'first'});if(failure)throw failure;
    if(!sql.includes('runtime.global_revision AS globalRevision'))throw new Error('unexpected fake token query');
    return {globalRevision:7,participantRevision:3,nextExpiry:null,expiredPhase:0,nowMs:1,v1Namespace:1,v11Namespace:1};
   },
  } as unknown as D1PreparedStatement);
  return make([]);
 }} as unknown as D1Database;
 // A target-positive check must reach the original source proof. Its sentinel
 // isolates this private availability boundary without fabricating a snapshot.
 const sourceProof={prepare(){throw proofStarted;}} as unknown as D1Database;
 const database=kind==='source'?schemaDatabase
  :withMaintainedEffectiveDependencies(sourceProof,schemaDatabase,identity.sourceId,identity.sourceNamespace);
 return {required,database,calls,get nativeCalls(){return nativeCalls;},
  rows(){return rows;},setRows(value:SchemaRow[]){rows=value;},fail(value?:Error){failure=value;},
  async read(db=database):Promise<boolean>{
   if(kind==='source')return !!await readEffectiveDependencyMutationToken(db,identity);
   try {
    const result=await maintainedEffectiveHistoryDependency(db,owner,identity.sourceNamespace,'2026-10-01','2026-10-01',false,
     async()=>{nativeCalls++;return nativeValue;});
    expect(result).toBe(nativeValue);return false;
   }catch(error){if(error===proofStarted)return true;throw error;}
  },
 };
}
const schemaCalls=(boundary:ReturnType<typeof fakeBoundary>)=>boundary.calls.filter(call=>call.sql.includes('sqlite_schema'));

it.each(['source','target'] as const)('preserves the exact unique %s inventory and reads fresh metadata on every unmetered call',async kind=>{
 const boundary=fakeBoundary(kind);
 expect(new Set(boundary.required.map(pair=>JSON.stringify(pair))).size).toBe(boundary.required.length);
 expect(boundary.required.length).toBe(kind==='target'?11:143);
 expect(await boundary.read()).toBe(true);expect(await boundary.read()).toBe(true);
 const schemas=schemaCalls(boundary);expect(schemas).toHaveLength(2);
 for(const call of schemas){expect(call.method).toBe('all');expect(call.sql).toContain('(s.type,s.name) IN');
  expect(JSON.parse(call.bound[0] as string)).toEqual(boundary.required);}
 if(kind==='source'){
  expect(boundary.calls.filter(call=>call.method==='first')).toHaveLength(2);
  expect(boundary.calls.filter(call=>call.method==='first').every(call=>JSON.stringify(call.bound.slice(0,4))
   ===JSON.stringify([identity.participantId,identity.ownerDigest,identity.sourceId,identity.sourceNamespace]))).toBe(true);
 }else expect(boundary.nativeCalls).toBe(0);
});

it.each(['source','target'] as const)('uses fresh exact %s rowids through nested950 meters and transparent summary attachments',async kind=>{
 const boundary=fakeBoundary(kind),outer=createD1InvocationBudget(950),inner=createD1InvocationBudget(950),
  original=outer.wrap(boundary.database),nested=inner.wrap(original);
 expect(await boundary.read(original)).toBe(true);expect(await boundary.read(nested)).toBe(true);
 expect(await boundary.read(nested)).toBe(true);
 const schemas=schemaCalls(boundary);expect(schemas).toHaveLength(3);
 expect(schemas[0]!.sql).toContain('(s.type,s.name) IN');
 expect(schemas.slice(1).every(call=>call.sql.includes('WHERE rowid IN'))).toBe(true);
 const perRead=kind==='source'?2:1;
 expect(outer.queriesUsed).toBe(3*perRead);expect(inner.queriesUsed).toBe(2*perRead);
});

it.each(['source','target'] as const)('refuses missing %s objects, rechecks absence, and restores changed rowids with full fallback',async kind=>{
 const boundary=fakeBoundary(kind),meter=createD1InvocationBudget(950),db=meter.wrap(boundary.database);
 expect(await boundary.read(db)).toBe(true);
 const complete=boundary.rows().map(row=>({...row})),removed=complete.find(row=>row.type==='trigger')!;
 boundary.setRows(complete.filter(row=>row!==removed&&row.name!==removed.name));
 let before=schemaCalls(boundary).length;
 expect(await boundary.read(db)).toBe(false);expect(schemaCalls(boundary).length-before).toBe(2);
 before=schemaCalls(boundary).length;
 expect(await boundary.read(db)).toBe(false);expect(schemaCalls(boundary).length-before).toBe(1);
 boundary.setRows([...boundary.rows(),{...removed,type:'view'}]);
 expect(await boundary.read(db)).toBe(false);
 boundary.setRows(complete.map(row=>row.name===removed.name?{...row,rowid:complete.length+9}:row));
 expect(await boundary.read(db)).toBe(true);
 before=schemaCalls(boundary).length;
 expect(await boundary.read(db)).toBe(true);expect(schemaCalls(boundary).length-before).toBe(1);
 expect(schemaCalls(boundary).at(-1)!.sql).toContain('WHERE rowid IN');
 if(kind==='target')expect(boundary.nativeCalls).toBe(3);
});

it.each(['source','target'] as const)('rejects wrong %s names/types at retained rowids and never trusts cardinality',async kind=>{
 for(const change of ['name','type'] as const){
  const boundary=fakeBoundary(kind),meter=createD1InvocationBudget(950),db=meter.wrap(boundary.database);
  expect(await boundary.read(db)).toBe(true);
  const complete=boundary.rows().map(row=>({...row}));
  boundary.setRows(complete.map((row,index)=>index?row:{...row,[change]:change==='name'?'synthetic_foreign_object':'view'}));
  const before=meter.queriesUsed;
  expect(await boundary.read(db)).toBe(false);expect(meter.queriesUsed-before).toBe(2);
  boundary.setRows(complete);expect(await boundary.read(db)).toBe(true);
 }
});

it.each(['source','target'] as const)('propagates %s full and hinted read failures without native fallback',async kind=>{
 const boundary=fakeBoundary(kind),meter=createD1InvocationBudget(950),db=meter.wrap(boundary.database),
  failure=new Error('synthetic schema read failure');
 boundary.fail(failure);await expect(boundary.read(db)).rejects.toBe(failure);expect(meter.queriesUsed).toBe(1);
 boundary.fail();expect(await boundary.read(db)).toBe(true);
 const before=meter.queriesUsed;boundary.fail(failure);
 await expect(boundary.read(db)).rejects.toBe(failure);expect(meter.queriesUsed-before).toBe(1);
 expect(boundary.nativeCalls).toBe(0);
});

it.each(['source','target'] as const)('charges the %s stale-hint attempt and preserves nested950 reserves when full fallback cannot fit',async kind=>{
 const boundary=fakeBoundary(kind),outer=createD1InvocationBudget(950),inner=createD1InvocationBudget(950),db=inner.wrap(outer.wrap(boundary.database));
 expect(await boundary.read(db)).toBe(true);
 boundary.setRows(boundary.rows().slice(1));
 outer.reserveQueries=950-outer.queriesUsed-1;
 const beforeOuter=outer.queriesUsed,beforeInner=inner.queriesUsed,beforeCalls=boundary.calls.length;
 await expect(boundary.read(db)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 expect([outer.queriesUsed-beforeOuter,inner.queriesUsed-beforeInner]).toEqual([1,2]);
 expect(boundary.calls.length-beforeCalls).toBe(1);expect(outer.remainingQueries).toBe(0);
 expect(boundary.nativeCalls).toBe(0);
});

it('rejects malformed mutation scopes before touching schema or token metadata',async()=>{
 const boundary=fakeBoundary('source');
 expect(await readEffectiveDependencyMutationToken(boundary.database,{...identity,ownerDigest:'not-a-digest'})).toBeUndefined();
 expect(boundary.calls).toEqual([]);
});
