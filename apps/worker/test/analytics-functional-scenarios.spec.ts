import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {committedV11PageResponseLoss,replayFunctionalDuplicateDelivery,type FunctionalLifecycleInput} from './helpers/analytics-functional-scenarios';

function database(){
 let writes=0,batches=0;
 class Statement {
  constructor(readonly sql:string){}
  bind(..._values:unknown[]){return new Statement(this.sql);}
  async all(){return {success:true,results:[],meta:{rows_read:0,rows_written:0,duration:0}};}
  async run(){writes++;return {success:true,results:[],meta:{rows_read:0,rows_written:1,duration:0}};}
  async first(){return null;}
 }
 const db={prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{
  batches++;const result=[];for(const statement of statements)result.push(await statement.run());return result;
 },withSession:()=>{throw Error('UNUSED');},exec:()=>{throw Error('UNUSED');},dump:()=>{throw Error('UNUSED');}} as unknown as D1Database;
 return {db,read:()=>({writes,batches})};
}

it('loses exactly one response after a committed real page batch and preserves the nested meter',async()=>{
 const physical=database(),meter=createD1InvocationBudget(950),fault=committedV11PageResponseLoss(meter.wrap(physical.db));
 const page=()=>fault.target.prepare('INSERT INTO analytics_v11_projection_steps(source_id,event_digest,revision,step_digest) VALUES(?,?,?,?)').bind('synthetic', 'a',1,'b');
 const first=fault.target.prepare('UPDATE analytics_v11_projection_work SET revision=revision+1');
 await expect(fault.target.batch([first,page()])).rejects.toThrow('FUNCTIONAL_COMMITTED_PAGE_RESPONSE_LOST');
 expect(physical.read()).toEqual({writes:2,batches:1});expect(meter.queriesUsed).toBe(2);
 const success=await fault.target.batch([page()]);expect(success).toHaveLength(1);
 expect(fault.read()).toEqual({lost:1,committedPageBatches:2});expect(physical.read()).toEqual({writes:3,batches:2});
 expect(meter.queriesUsed).toBe(3);
});

it('keeps ordinary writes intact and rejects foreign statements or unbounded adapter operations',async()=>{
 const physical=database(),other=database(),fault=committedV11PageResponseLoss(physical.db);
 await fault.target.batch([fault.target.prepare('INSERT INTO ordinary_table(value) VALUES(?)').bind(1)]);
 expect(fault.read()).toEqual({lost:0,committedPageBatches:0});expect(physical.read()).toEqual({writes:1,batches:1});
 await expect(fault.target.batch([other.db.prepare('INSERT INTO analytics_v11_projection_steps VALUES(1)')])).rejects.toThrow('FOREIGN_FAULT_STATEMENT');
 expect(physical.read()).toEqual({writes:1,batches:1});
 expect(()=>fault.target.withSession()).toThrow('UNBOUNDED_FAULT_OPERATION');
 expect(()=>fault.target.exec('SELECT 1')).toThrow('UNBOUNDED_FAULT_OPERATION');
 expect(()=>fault.target.dump()).toThrow('UNBOUNDED_FAULT_OPERATION');
});

it('cannot run a lifecycle episode against an aliased or unreviewed laboratory context',async()=>{
 const physical=database(),one={source:physical.db,target:physical.db,ledger:physical.db};
 const input={context:{reference:one,candidate:one,analyticalNowMs:0,now:Date.now},kernels:{},
  sourceId:'synthetic-p11-functional',sourceNamespace:'synthetic-p11-functional',participantId:'participant:4aa335fb-32cd-452e-91b9-73e818a3cf81'} as unknown as FunctionalLifecycleInput;
 await expect(replayFunctionalDuplicateDelivery(input)).rejects.toThrow('LABORATORY_SCOPE');
 expect(physical.read()).toEqual({writes:0,batches:0});
});

function observedEpisode(mode:'normal'|'double'='normal'){
 let queries=0,entered=0,left=0;const database=()=>{const statement=():D1PreparedStatement=>({bind:()=>statement(),all:async()=>{queries++;return {success:true,results:[{sequence:2}],meta:{rows_read:1,rows_written:0,duration:0}};}} as unknown as D1PreparedStatement);return {prepare:()=>statement()} as unknown as D1Database;};
 const stores=()=>({source:database(),target:database(),ledger:database()});
 const observer=()=>{let probe:D1Database|undefined;return {enterInvocation(target:D1Database){expect(probe).toBeUndefined();probe=target;entered++;return()=>{probe=undefined;left++;};},wrap(target:D1Database){
  if(mode==='double')return new Proxy(probe!,{});
  const statement=(inner:D1PreparedStatement):D1PreparedStatement=>new Proxy(inner,{get(value,key){if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args));if(key==='all'||key==='first')return async(...args:unknown[])=>{if(!probe)throw Error('NO_ACTIVE_METER');await probe.prepare('SELECT 1 observation').all();return Reflect.apply(Reflect.get(value,key),value,args);};const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
  return new Proxy(target,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql));const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 }};};
 const kernel={readIngestionChanges:async()=>[{sequence:2}],applyAnalyticsChange:async()=> 'already-applied'};
 const input={context:{reference:stores(),candidate:stores(),analyticalNowMs:0,now:Date.now},kernels:{reference:kernel,candidate:kernel},sourceId:'synthetic-p11-observed',sourceNamespace:'synthetic-p11-observed',participantId:'participant:4aa335fb-32cd-452e-91b9-73e818a3cf81',targetObservers:{reference:observer(),candidate:observer()}} as unknown as FunctionalLifecycleInput;
 return {input,kernel,read:()=>({queries,entered,left})};
}
it('charges target observation reads to the original action meter and keeps exact profile equality',async()=>{
 const f=observedEpisode(),result=await replayFunctionalDuplicateDelivery(f.input);expect(f.read()).toEqual({queries:8,entered:2,left:2});
 for(const lane of ['reference','candidate'])expect(result.evidence.costs[lane]).toMatchObject({statements:4,metadataSamples:4,maximumStatementsPerInvocation:4,rowsWritten:0});
});
it('closes the target observer on a native exception and refuses identity-hiding same-meter wrapping',async()=>{
 const f=observedEpisode();f.kernel.readIngestionChanges=async()=>{throw Error('NATIVE_FAILURE');};await expect(replayFunctionalDuplicateDelivery(f.input)).rejects.toThrow('NATIVE_FAILURE');expect(f.read()).toEqual({queries:2,entered:1,left:1});
 const g=observedEpisode('double');await expect(replayFunctionalDuplicateDelivery(g.input)).rejects.toThrow('STATEMENT_ACCOUNTING');expect(g.read()).toEqual({queries:2,entered:1,left:1});
});
