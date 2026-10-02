import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {c06SourceLineageObserver} from './helpers/analytics-c06-source-lineage';
import {c06ScopeSource} from './helpers/analytics-c06-operation-scope';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';

function fixture(){
 let dispatched=0;
 const result=()=>({success:true,results:[{value:1}],meta:{rows_read:1,rows_written:0,duration:0,changes:0}});
 const statement=():D1PreparedStatement=>({bind:()=>statement(),all:async()=>{dispatched++;return result();}} as unknown as D1PreparedStatement);
 const raw={prepare:()=>statement(),batch:async(items:D1PreparedStatement[])=>{dispatched+=items.length;return items.map(result);}} as unknown as D1Database;
 const census=c06SourceLineageObserver(raw,()=>({consumer:'unclassified',phase:'warm'}),{allowedPhases:['warm']});
 return {raw,census,dispatched:()=>dispatched};
}

it('keeps real outer950 and fresh phase950 meters exact through fixed scopes and mixed batches',async()=>{
 const input=fixture(),scopes:string[]=[],whole=createWholeWorkloadMeter(input.census.source,input.raw,undefined,undefined,undefined,row=>{if(row.operationScope)scopes.push(row.operationScope);});
 await whole.invocation('real_scoped_phase',async(db,outer)=>{
  const phase=createD1InvocationBudget(950);
  const cache=phase.wrap(c06ScopeSource(db.source,'scheduler_cache'));
  await phase.wrap(cache).prepare('SELECT ?').bind(1).all();
  const common=phase.wrap(db.source);
  const cacheBatch=c06ScopeSource(common,'scheduler_cache'),featuresBatch=c06ScopeSource(common,'scheduler_features');
  // Mixed statements retain the SAME phase database's native batch affinity.
  await common.batch([cacheBatch.prepare('SELECT ?').bind(2),featuresBatch.prepare('SELECT ?').bind(3)]);
  expect(phase.queriesUsed).toBe(3);expect(outer.queriesUsed).toBe(3);
 });
 expect(input.dispatched()).toBe(3);
 expect(summarizeWholeWorkload(whole.profile)).toMatchObject({statements:3,maximumStatementsPerInvocation:3,measurementFailures:0});
 expect(scopes).toEqual(['scheduler_cache','scheduler_cache','scheduler_features']);
 const candidates=await input.census.privateReviewCandidates();
 expect(candidates.map(row=>[row.consumer,row.operationScope]).sort()).toEqual([['cache','scheduler_cache'],['unclassified','scheduler_features']]);
});

it('refuses unsupported same-meter facade rewrap through the unchanged accounting guard',async()=>{
 const input=fixture(),whole=createWholeWorkloadMeter(input.census.source,input.raw);
 await expect(whole.invocation('unsupported_same_meter',async(db,outer)=>{
  await outer.wrap(c06ScopeSource(db.source,'scheduler_cache')).prepare('SELECT 1').all();
 })).rejects.toThrow('whole workload statement accounting mismatch: unsupported_same_meter, profiled=1, metered=2');
 expect(input.dispatched()).toBe(1);expect(whole.profile.maximumStatementsPerInvocation).toBe(0);
});

it('refuses conflicting scopes behind a foreign real meter and foreign batch statements before dispatch',async()=>{
 const input=fixture(),outer=createD1InvocationBudget(950),phase=createD1InvocationBudget(950);
 const original=outer.wrap(input.census.source),tagged=c06ScopeSource(original,'direct_model');
 const hidden=phase.wrap(tagged),conflicting=c06ScopeSource(hidden,'candidate_model_block');
 expect(()=>conflicting.prepare('SELECT 1')).toThrow('C06_OPERATION_STATEMENT_SCOPE_MISMATCH');
 expect(()=>hidden.batch([original.prepare('SELECT 1')])).toThrow('unmetered or foreign database statement');
 expect({outer:outer.queriesUsed,phase:phase.queriesUsed,dispatched:input.dispatched()}).toEqual({outer:0,phase:0,dispatched:0});
});

it('keeps caught scope mismatch sticky after a later successful source query',async()=>{
 const input=fixture(),outer=createD1InvocationBudget(950),phase=createD1InvocationBudget(950);let failures=0;
 const observed=outer.wrap(input.census.source),direct=c06ScopeSource(observed,'direct_model',{onFailure:()=>{failures++;}});
 const nested=c06ScopeSource(phase.wrap(direct),'candidate_model_block',{onFailure:()=>{failures++;}});
 expect(()=>nested.prepare('SELECT 1')).toThrow('C06_OPERATION_STATEMENT_SCOPE_MISMATCH');
 await direct.prepare('SELECT 1').all();
 const diagnostic={prepare:()=>({all:async()=>({results:[],success:true,meta:{rows_read:0,rows_written:0,duration:0}})})} as unknown as D1Database;
 const report=await input.census.report({expectedSourceCalls:1,diagnosticDatabase:diagnostic});
 expect(failures).toBe(1);expect(input.dispatched()).toBe(1);expect(outer.queriesUsed).toBe(1);
 expect(report).toMatchObject({calls:1,boundaryFailures:1,meterReconciled:true,resourceMeasured:false,allMeasured:false,noRescanQualified:false});
});

it('inherits the callback across its own nested facades without hiding missing-tag refusal',async()=>{
 const {C06_DATABASE_SCOPE}=await import('./helpers/analytics-c06-operation-scope');let failures=0;
 const marked={[C06_DATABASE_SCOPE]:true,prepare:()=>({})} as unknown as D1Database;
 const direct=c06ScopeSource(marked,'direct_model',{onFailure:()=>{failures++;}});
 const nested=c06ScopeSource(direct,'candidate_model_block');
 expect(()=>nested.prepare('SELECT 1')).toThrow('C06_OPERATION_STATEMENT_SCOPE_MISSING');expect(failures).toBe(1);
 const failingCallback=c06ScopeSource(marked,'direct_model',{onFailure:()=>{throw Error('callback failed');}});
 expect(()=>failingCallback.prepare('SELECT 1')).toThrow('C06_OPERATION_STATEMENT_SCOPE_MISSING');
});
