import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { ANALYTICS_WORK_CONTRACT, dispatchAnalyticsWork, dispatchAnalyticsFeatureGroup, dispatchAnalyticsActivityGroup, groupAnalyticsPartitions,
  type AnalyticsWorkLease } from '../src/analytics-partition-work';

const lease = (n: number, overrides: Partial<AnalyticsWorkLease> = {}): AnalyticsWorkLease => ({
  contract: ANALYTICS_WORK_CONTRACT, workKey: n.toString(16).padStart(64,'0'), headKey: n.toString(16).padStart(64,'0'),
  claimToken: 'synthetic-claim-0001', revision: 1, stage: 'features', residentBytes: 100,
  admissionQueries: 5, expiresAtMs: 1000, ...overrides,
});
describe('bounded partition dispatch', () => {
  it('groups logical leaves by exact row/byte bounds and refuses oversized leaves', () => {
    const parts = [1,2,3].map(n => ({partitionKey:`usage/2026-09-30/0${n}`,rows:4,bytes:10}));
    expect(groupAnalyticsPartitions(parts,{maxPartitions:16,maxRows:9,maxBytes:25}).map(g=>g.length)).toEqual([2,1]);
    expect(()=>groupAnalyticsPartitions(parts,{maxPartitions:16,maxRows:3,maxBytes:25})).toThrow('ANALYTICS_WORK_CONTRACT_INVALID');
  });
  it('parallelizes independent heads, preserves the invocation reserve and releases every claim', async () => {
    const invocation = createD1InvocationBudget(30); invocation.reserveQueries = 2;
    const entered: number[] = [], released: string[] = [];
    let startSecond!: () => void;
    const second = new Promise<void>(resolve => {startSecond=resolve;});
    const result = await dispatchAnalyticsWork({degree:2,maxResidentBytes:500,invocation,deadlineMs:900,now:()=>0,
      releaseQueries:2,claim:async()=>[lease(1),lease(2)],
      execute:async item => { entered.push(Number.parseInt(item.workKey,16));
        if(entered.length===2)startSecond(); await second;
        expect(invocation.reserveQueries).toBe(6);return 'complete'; },
      release:async item => { released.push(item.workKey); },
    });
    expect(result).toMatchObject({claimed:2,admitted:2,complete:2,releaseDeferred:0});
    expect(entered).toEqual([1,2]);expect(released).toHaveLength(2);expect(invocation.reserveQueries).toBe(2);
  });
  it('serializes duplicate output heads and respects memory and expired leases', async () => {
    const one=lease(1), items=[one,lease(2,{headKey:one.headKey}),lease(3,{residentBytes:1000}),lease(4,{expiresAtMs:0})];
    const releases: string[]=[];
    const result=await dispatchAnalyticsWork({degree:4,maxResidentBytes:200,invocation:createD1InvocationBudget(40),
      deadlineMs:900,now:()=>0,releaseQueries:1,claim:async()=>items,
      execute:async()=> 'complete',release:async(_item,outcome)=>{releases.push(outcome);}});
    expect(result).toMatchObject({claimed:4,admitted:1,complete:1,deferred:3});
    expect(releases).toEqual(['complete','not_admitted','not_admitted','not_admitted']);
  });
  it('charges real statements through both meters and retains final release headroom', async () => {
    const invocation=createD1InvocationBudget(12),database=invocation.wrap(env.USAGE_MONITOR_DB);
    const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:200,invocation,deadlineMs:900,now:()=>0,
      releaseQueries:2,claim:async()=>[lease(1)],
      execute:async(_item,budget)=>{const phase=budget.meter.wrap(database);
        for(let i=0;i<20;i++)await phase.prepare('SELECT 1').first();return 'complete';},
      release:async()=>{await database.prepare('SELECT 1').first();}});
    expect(result).toMatchObject({complete:0,deferred:1,releaseDeferred:0,statements:11});
    expect(invocation.remainingQueries).toBe(1);
  });
  it('keeps failed work recoverable and does not assert completion after a lost release', async () => {
    const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:200,invocation:createD1InvocationBudget(20),
      deadlineMs:900,now:()=>0,releaseQueries:1,claim:async()=>[lease(1)],
      execute:async()=>{throw new Error('synthetic interruption');},release:async()=>{throw new Error('synthetic lost response');}});
    expect(result).toMatchObject({complete:0,failed:1,releaseDeferred:1});
  });
});

describe('closed preparation group dispatch',()=>{
 it('keeps activity groups serial, releases every original leaf and restores the reserve',async()=>{
  const invocation=createD1InvocationBudget(950);invocation.reserveQueries=3;
  const leaves=Array.from({length:8},(_,index)=>lease(index+1,{stage:'activity',admissionQueries:160}));
  const released:string[]=[];let executions=0;
  const result=await dispatchAnalyticsActivityGroup({invocation,deadlineMs:900,now:()=>0,
   claim:async limit=>{expect(limit).toBe(8);return leaves;},
   execute:async(items,budget)=>{executions++;expect(items).toEqual(leaves);
    expect(invocation.reserveQueries).toBe(19);expect(budget.remainingQueries()).toBe(931);
    return items.map(item=>({workKey:item.workKey,outcome:'complete' as const,admitted:true}));},
   release:async(item,outcome)=>{expect(outcome).toBe('complete');released.push(item.workKey);}});
  expect(result).toMatchObject({claimed:8,admitted:8,complete:8,groupsAdmitted:1,failed:0,releaseDeferred:0});
  expect(executions).toBe(1);expect(released).toEqual(leaves.map(item=>item.workKey));expect(invocation.reserveQueries).toBe(3);
 });
 it('refuses a foreign stage through either closed facade before execution',async()=>{
  for(const [dispatcher,stage] of [[dispatchAnalyticsFeatureGroup,'activity'],[dispatchAnalyticsActivityGroup,'features']] as const){
   let executed=false;
   await expect(dispatcher({invocation:createD1InvocationBudget(950),deadlineMs:900,now:()=>0,
    claim:async()=>[lease(1,{stage})],execute:async()=>{executed=true;return [];},release:async()=>{}}))
    .rejects.toThrow('ANALYTICS_WORK_CONTRACT_INVALID');
   expect(executed).toBe(false);
  }
 });
});
