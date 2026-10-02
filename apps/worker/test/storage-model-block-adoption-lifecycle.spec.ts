import { beforeEach, expect, it, vi } from 'vitest';
import { MODEL_BLOCK_METHOD, planHistoricalModelBlockRanges, type ModelBlockIdentity,
  type ModelBlockOutput } from '../src/analytics-model-block-contract';
import * as block from '../src/analytics-model-block';
import * as graph from '../src/storage-community-graph';
import { advanceStorageModelBlockGraphWork } from '../src/storage-community-graph-model-block';

vi.mock('../src/analytics-model-block',()=>({MODEL_BLOCK_METHOD:'unused',
  ModelBlockSourceChanged:class extends Error{},advanceAnalyticsModelBlock:vi.fn(),
  assertModelBlockSourceCurrent:vi.fn(async()=>{}),assertModelBlockTargetCurrent:vi.fn(async()=>{}),
  captureModelBlockAuthorityDigest:vi.fn(async()=> 'd'.repeat(64)),modelBlockSourcePinForDay:vi.fn(),
  readVerifiedAnalyticsModelBlock:vi.fn()}));
vi.mock('../src/storage-analytics-model-block',()=>({modelBlockStoreSupported:vi.fn(async()=>true),
  prepareModelBlockAdmission:vi.fn(async()=>({})),readRebasableModelBlockCheckpoint:vi.fn(async()=>null),
  retireModelBlockJobs:vi.fn(async()=>0)}));
vi.mock('../src/storage-community-graph',()=>({STORAGE_GRAPH_METHOD:'synthetic',
  createStorageGraphScopeBatch:vi.fn(),captureStorageGraphScope:vi.fn(),readStorageGraphResult:vi.fn(async()=>null),
  reuseStorageGraphResult:vi.fn(async()=>null),saveStorageGraphResult:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());

function database():D1Database {
  const statement={bind(){return statement;},first:async()=>1,run:async()=>({success:true,meta:{changes:1}})};
  return {prepare:()=>statement} as unknown as D1Database;
}
function fixture() {
  const nowMs=Date.parse('2026-10-01T12:00:00.000Z'),range=planHistoricalModelBlockRanges('2026-10-01')
    .find(value=>Date.parse(value.outputThroughDay)-Date.parse(value.outputFromDay)===31*86_400_000)!;
  const owner={participantId:'synthetic',ownerDigest:'a'.repeat(64),inputRevision:1,ownerRevision:1,
    authorityEpoch:1,hasV1:false,hasV11:true,hasV12:false,hasLegacy:false,hasEffective:true};
  const outputs:ModelBlockOutput[]=Array.from({length:32},(_,index)=>({day:new Date(Date.parse(range.outputFromDay)
    +index*86_400_000).toISOString().slice(0,10),fingerprint:'b'.repeat(64),
    value:{status:'not_testable',reason:'supported_quota_track_unavailable'}}));
  const scope=(day:string)=>({authority:{sourceId:'synthetic',sourceNamespace:'synthetic'},owner,
    source:'effective',pin:{fingerprint:'b'.repeat(64)},day,metric:'model'}) as graph.StorageGraphScope;
  const input={source:database(),target:database(),sourceId:'synthetic',sourceNamespace:'synthetic',
    scope:scope(outputs[0]!.day),nowMs,maxQueries:950,deadlineMs:nowMs+60_000,now:()=>nowMs};
  const identity:ModelBlockIdentity={version:1,method:MODEL_BLOCK_METHOD,sourceId:input.sourceId,
    sourceNamespace:input.sourceNamespace,ownerDigest:owner.ownerDigest,ownerRevision:1,authorityEpoch:1,
    inputRevision:1,authorityDigest:'d'.repeat(64),...range};
  vi.mocked(block.advanceAnalyticsModelBlock).mockResolvedValue({status:'complete',identity,queriesUsed:0} as Awaited<ReturnType<typeof block.advanceAnalyticsModelBlock>>);
  vi.mocked(block.readVerifiedAnalyticsModelBlock).mockResolvedValue({version:1,phase:'complete',outputs,dependencies:[],inputIndex:0,pending:null});
  vi.mocked(block.modelBlockSourcePinForDay).mockResolvedValue({fingerprint:'b'.repeat(64)} as Awaited<ReturnType<typeof block.modelBlockSourcePinForDay>>);
  vi.mocked(graph.captureStorageGraphScope).mockImplementation(async(_source,options)=>scope(options.day));
  vi.mocked(graph.saveStorageGraphResult).mockImplementation(async(bindings,savedScope,options)=>{
    await options.assertCurrent?.();await bindings.target.prepare('SELECT 1').first();
    await options.assertCurrent?.();return {state:'complete',reused:false,
      result:{scope:savedScope,fits:null,composition:outputs[0]!.value}};
  });
  return {input,scope,outputs};
}

it('uses final wrapped handles and retains lazy selected-first progress when a cold sibling exhausts the meter',async()=>{
  const f=fixture(),reads:string[]=[],closed=vi.fn(),full=vi.fn(async()=>{});
  vi.mocked(graph.createStorageGraphScopeBatch).mockImplementation(async(source,options)=>{
    expect(source).not.toBe(f.input.source);expect(options.target).not.toBe(f.input.target);
    await source.prepare('SELECT 1').first();
    return {assertCurrent:full,close:closed,readScope:async day=>{
      reads.push(day);
      if(day!==f.input.scope.day)for(let count=0;count<950;count++)await source.prepare('SELECT 1').first();
      return f.scope(day);
    }};
  });
  expect(await advanceStorageModelBlockGraphWork(f.input)).toMatchObject({state:'complete',adoptedDates:1,queriesUsed:950});
  expect(reads).toEqual(f.outputs.slice(0,2).map(output=>output.day));
  expect(graph.saveStorageGraphResult).toHaveBeenCalledTimes(1);
  expect(full).toHaveBeenCalledTimes(3);expect(closed).toHaveBeenCalledTimes(1);
  expect(graph.captureStorageGraphScope).not.toHaveBeenCalled();
});

it('closes each bounded batch and preserves every date identity, stored payload and original adoption order',async()=>{
  const f=fixture(),closures:ReturnType<typeof vi.fn>[]=[],fulls:ReturnType<typeof vi.fn>[]=[],reads:string[]=[];
  f.input.scope=f.scope(f.outputs.at(-1)!.day);
  vi.mocked(graph.createStorageGraphScopeBatch).mockImplementation(async(source,options)=>{
    const close=vi.fn(),full=vi.fn(async()=>{});closures.push(close);fulls.push(full);
    return {close,assertCurrent:full,readScope:async day=>{
      expect(options.days).toContain(day);reads.push(day);await source.prepare('SELECT 1').first();return f.scope(day);
    }};
  });
  const result=await advanceStorageModelBlockGraphWork(f.input);
  expect(result).toMatchObject({state:'complete',adoptedDates:32,queriesUsed:64});
  expect(vi.mocked(graph.createStorageGraphScopeBatch).mock.calls.map(([,input])=>input.days.length)).toEqual([1,16,15]);
  expect(reads).toEqual([f.outputs.at(-1)!.day,...f.outputs.slice(0,-1).map(output=>output.day)]);
  expect(closures.every(close=>close.mock.calls.length===1)).toBe(true);
  expect(fulls.reduce((sum,full)=>sum+full.mock.calls.length,0)).toBe(96);
  for(const [bindings,scope,options] of vi.mocked(graph.saveStorageGraphResult).mock.calls){
    expect(bindings.source).toBe(vi.mocked(graph.createStorageGraphScopeBatch).mock.calls[0]![0]);
    expect(bindings.target).toBe(vi.mocked(graph.createStorageGraphScopeBatch).mock.calls[0]![1].target);
    expect(scope.ownerAuthorityEpoch).toBe(1);expect(scope.pin.fingerprint).toBe('b'.repeat(64));
    expect(JSON.parse(options.payload)).toEqual(f.outputs[0]!.value);
  }
});

it('retains the independently captured singleton path when private batch acquisition is unsupported',async()=>{
  const f=fixture();vi.mocked(graph.createStorageGraphScopeBatch).mockResolvedValue(undefined);
  expect(await advanceStorageModelBlockGraphWork(f.input)).toMatchObject({state:'complete',adoptedDates:32});
  expect(graph.captureStorageGraphScope).toHaveBeenCalledTimes(32);
});

it('keeps singleton progress when fewer than120 statements remain after block verification',async()=>{
  const f=fixture();
  const complete=await vi.mocked(block.advanceAnalyticsModelBlock).getMockImplementation()!({} as Parameters<typeof block.advanceAnalyticsModelBlock>[0]);
  vi.mocked(block.advanceAnalyticsModelBlock).mockImplementationOnce(async input=>{
    for(let count=0;count<850;count++)await input.source.prepare('SELECT 1').first();
    return complete;
  });
  expect(await advanceStorageModelBlockGraphWork(f.input)).toMatchObject({state:'complete',adoptedDates:32,queriesUsed:882});
  expect(graph.createStorageGraphScopeBatch).not.toHaveBeenCalled();
  expect(graph.captureStorageGraphScope).toHaveBeenCalledTimes(32);
});

it.each(['source','unexpected','deferred'] as const)('closes without adopting an unfenced result on %s exit',async boundary=>{
  const f=fixture(),close=vi.fn();
  vi.mocked(graph.createStorageGraphScopeBatch).mockResolvedValue({close,readScope:async day=>f.scope(day),
    assertCurrent:async()=>{
      if(boundary==='source')throw new block.ModelBlockSourceChanged();
      if(boundary==='unexpected')throw new Error('synthetic failure');
    }});
  if(boundary==='deferred')vi.mocked(graph.saveStorageGraphResult).mockResolvedValue({state:'deferred',reason:'source_changed'});
  if(boundary==='unexpected')await expect(advanceStorageModelBlockGraphWork(f.input)).rejects.toThrow('synthetic failure');
  else expect(await advanceStorageModelBlockGraphWork(f.input)).toMatchObject({state:'deferred',adoptedDates:0});
  expect(close).toHaveBeenCalledTimes(1);
  if(boundary!=='deferred')expect(graph.saveStorageGraphResult).not.toHaveBeenCalled();
});
