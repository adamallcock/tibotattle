import { describe,expect,it } from 'vitest';
import { D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { V11ProjectionDeadlineExceededError } from '../src/v11-daily-projection';
import { TypedTelemetryError } from '../src/typed-telemetry-codec';
import { EffectiveUsageReaderError } from '../src/telemetry-usage-effective-reader';
import { caughtStorageGraphFailureFields,classifyStorageGraphFailure,storageGraphFailureDetail,storageGraphFailureFields,
 createStoragePublicationTiming, STORAGE_PUBLICATION_TIMING_PHASES,StorageGraphOperationError,
 withStorageGraphFailureStage,withStoragePublicationTiming } from '../src/storage-analytics-failure';

describe('storage analytics graph failure diagnostics',()=>{
 it.each([
  ['STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE','checkpoint_unavailable'],
  ['STORAGE_V1_HISTORY_CHECKPOINT_MISMATCH','checkpoint_mismatch'],
  ['v1 source changed during analysis','source_changed'],
  ['D1_ERROR: Exceeded CPU time limit. error 7429','d1_cpu_limit'],
  ['D1_ERROR: query timed out','d1_timeout'],
  ['D1_ERROR: too many SQL variables','too_many_bindings'],
  ['D1_ERROR: query is too large','query_too_large'],
  ['D1_ERROR: too many queries','query_limit'],
  ['D1_ERROR: opaque provider failure','d1_other'],
  ['application deadline exceeded','application'],
  ['private participant detail','application'],
 ] as const)('maps provider failures to a closed reason without retaining details',(message,reason)=>{
  expect(classifyStorageGraphFailure(new Error(message))).toBe(reason);
  const wrapped=new StorageGraphOperationError('graph_history_acquisition_page',reason);
  expect(wrapped.message).toBe('STORAGE_GRAPH_OPERATION_UNAVAILABLE');
  expect(storageGraphFailureFields(wrapped)).toEqual({phase:'graph_history_acquisition_page',reason});
  expect(JSON.stringify(storageGraphFailureFields(wrapped))).not.toContain(message);
 });

 it('emits no diagnostic fields for an unclassified outer failure',()=>{
  expect(storageGraphFailureFields(new Error('private participant detail'))).toEqual({});
 });

 it.each([new D1InvocationBudgetExceededError(),new V11ProjectionDeadlineExceededError()])(
  'preserves controlled deferrals instead of turning them into failures',async error=>{
   await expect(withStorageGraphFailureStage('graph_scope',async()=>{throw error})).rejects.toBe(error);
  });

 it('preserves the innermost classified stage',async()=>{
  const inner=new StorageGraphOperationError('graph_checkpoint_load','d1_timeout');
  await expect(withStorageGraphFailureStage('graph_model_compute',async()=>{throw inner})).rejects.toBe(inner);
 });

 it('carries a one-way token of the wrapped error through the closed operation error',async()=>{
  const message='v11 quota acquisition page order invalid',token=storageGraphFailureDetail(new Error(message));
  expect(token).toMatch(/^[0-9a-f]{8}$/u);
  expect(token).toBe(storageGraphFailureDetail(new Error(message)));
  expect(token).not.toBe(storageGraphFailureDetail(new Error('v11 quota acquisition membership conflict')));
  const wrapped=await withStorageGraphFailureStage('graph_model_compute',async()=>{throw new Error(message)}).catch(error=>error);
  expect(wrapped).toBeInstanceOf(StorageGraphOperationError);
  expect(wrapped.detail).toBe(token);
  expect(storageGraphFailureDetail(wrapped)).toBe(token);
  expect(JSON.stringify({...storageGraphFailureFields(wrapped),detail:wrapped.detail})).not.toContain('page order');
  expect(storageGraphFailureDetail('not an error')).toBeUndefined();
  expect(new StorageGraphOperationError('graph_scope','application').detail).toBeUndefined();
 });

 it('classifies a caught direct read without exposing details or relabeling controlled deferrals',()=>{
  const failure=caughtStorageGraphFailureFields('graph_history_direct_read',
   new Error('D1_ERROR: Exceeded CPU time limit. error 7429 private participant detail'));
  expect(failure).toEqual({phase:'graph_history_direct_read',reason:'d1_cpu_limit'});
  expect(JSON.stringify(failure)).not.toContain('private participant detail');
  expect(caughtStorageGraphFailureFields('graph_history_direct_read',new D1InvocationBudgetExceededError())).toBeUndefined();
  expect(caughtStorageGraphFailureFields('graph_history_direct_read',new V11ProjectionDeadlineExceededError())).toBeUndefined();
 });

 it('distinguishes the observed typed-reader wrapper from a retained D1 CPU/reset cause',async()=>{
  const unavailable=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE');
  expect(storageGraphFailureDetail(unavailable)).toBe('818d3d27');
  expect(classifyStorageGraphFailure(unavailable)).toBe('application');
  const cause=new Error('D1_ERROR: D1 DB exceeded its CPU time limit and was reset.');
  const typed=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE',{cause});
  expect(typed.message).toBe(unavailable.message);
  expect(JSON.stringify(typed)).toBe(JSON.stringify(unavailable));
  expect(classifyStorageGraphFailure(typed)).toBe('d1_cpu_limit');
  expect(storageGraphFailureDetail(typed)).toBe('61b3db2c');
  expect(caughtStorageGraphFailureFields('graph_history_reader',typed))
   .toEqual({phase:'graph_history_reader',reason:'d1_cpu_limit'});
  const classified=await withStorageGraphFailureStage('graph_model_compute',async()=>{throw typed;}).catch(error=>error);
  expect(classified).toMatchObject({stage:'graph_model_compute',reason:'d1_cpu_limit',detail:'61b3db2c'});
  expect(classified).not.toHaveProperty('cause');
 });

 it('keeps provider text and identifiers out of typed and graph diagnostic JSON',async()=>{
  const cause=new Error('D1_ERROR: query timed out SELECT private_fixture_column FROM private_fixture_table WHERE owner=synthetic-owner');
  const typed=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE',{cause});
  const classified=await withStorageGraphFailureStage('graph_model_compute',async()=>{throw typed;}).catch(error=>error);
  expect(classified).toMatchObject({reason:'d1_timeout',detail:storageGraphFailureDetail(cause)});
  expect(JSON.stringify(typed)).not.toContain('private_fixture');
  expect(JSON.stringify(classified)).not.toContain('private_fixture');
  expect(JSON.stringify(storageGraphFailureFields(classified))).not.toContain('synthetic-owner');
 });

 it.each([new D1InvocationBudgetExceededError(),new V11ProjectionDeadlineExceededError()])(
  'recovers a controlled deferral hidden by the typed reader',async cause=>{
   const typed=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE',{cause});
   await expect(withStorageGraphFailureStage('graph_model_compute',async()=>{throw typed;})).rejects.toBe(cause);
   expect(caughtStorageGraphFailureFields('graph_history_reader',typed)).toBeUndefined();
  });

 it('preserves an innermost classified stage inside the recognized typed wrapper',async()=>{
  const inner=new StorageGraphOperationError('graph_history_reader','d1_cpu_limit','61b3db2c');
  const typed=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE',{cause:inner});
  expect(classifyStorageGraphFailure(typed)).toBe('d1_cpu_limit');
  expect(storageGraphFailureDetail(typed)).toBe('61b3db2c');
  expect(caughtStorageGraphFailureFields('graph_model_compute',typed)).toEqual({phase:'graph_history_reader',reason:'d1_cpu_limit'});
  await expect(withStorageGraphFailureStage('graph_model_compute',async()=>{throw typed;})).rejects.toBe(inner);
 });

 it('does not trust arbitrary causes or loop through cyclic typed errors',()=>{
  const cause=new Error('D1_ERROR: query timed out');
  expect(classifyStorageGraphFailure(new Error('ordinary application failure',{cause}))).toBe('application');
  expect(classifyStorageGraphFailure(new TypedTelemetryError('TYPED_TELEMETRY_INVALID',{cause}))).toBe('application');
  const first=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE'),second=new TypedTelemetryError('TYPED_TELEMETRY_UNAVAILABLE',{cause:first});
  first.cause=second;
  expect(classifyStorageGraphFailure(first)).toBe('application');
  expect(storageGraphFailureDetail(first)).toBe('818d3d27');
 });

 it('classifies only genuine unavailable effective-reader causes without exposing them',async()=>{
  const cause=new Error('D1_ERROR: query timed out SELECT private_column WHERE owner=synthetic-owner');
  const unavailable=new EffectiveUsageReaderError('EFFECTIVE_USAGE_UNAVAILABLE',{cause});
  const plain=new EffectiveUsageReaderError('EFFECTIVE_USAGE_UNAVAILABLE');
  expect(unavailable.message).toBe(plain.message);
  expect(JSON.stringify(unavailable)).toBe(JSON.stringify(plain));
  expect(Object.keys(unavailable)).not.toContain('cause');
  expect(classifyStorageGraphFailure(unavailable)).toBe('d1_timeout');
  const classified=await withStorageGraphFailureStage('daily_effective_reader',async()=>{throw unavailable;})
    .catch(error=>error);
  expect(storageGraphFailureFields(classified)).toEqual({phase:'daily_effective_reader',reason:'d1_timeout'});
  expect(classified).not.toHaveProperty('cause');
  expect(classified.detail).toBeUndefined();
  expect(JSON.stringify(classified)).not.toMatch(/private_column|synthetic-owner|SELECT/u);
  expect(classifyStorageGraphFailure(plain)).toBe('application');
  expect(classifyStorageGraphFailure(new Error('ordinary failure',{cause}))).toBe('application');
  const nonUnavailable=new EffectiveUsageReaderError('EFFECTIVE_USAGE_LIMIT',{cause});
  expect(nonUnavailable).not.toHaveProperty('cause');
  expect(classifyStorageGraphFailure(nonUnavailable)).toBe('application');
  const forged=Object.assign(Object.create(EffectiveUsageReaderError.prototype) as EffectiveUsageReaderError,
    {code:'EFFECTIVE_USAGE_UNAVAILABLE',cause});
  expect(classifyStorageGraphFailure(forged)).toBe('application');
 });

 it.each([new D1InvocationBudgetExceededError(),new V11ProjectionDeadlineExceededError()])(
  'preserves controlled deferrals hidden in an effective-reader error',async cause=>{
   const unavailable=new EffectiveUsageReaderError('EFFECTIVE_USAGE_UNAVAILABLE',{cause});
   await expect(withStorageGraphFailureStage('daily_source_dependency',async()=>{throw unavailable;}))
    .rejects.toBe(cause);
   expect(caughtStorageGraphFailureFields('daily_source_dependency',unavailable)).toBeUndefined();
  });

 it('keeps the innermost stage and bounds mixed wrapper cycles',async()=>{
  const inner=new StorageGraphOperationError('graph_history_reader','d1_cpu_limit');
  const unavailable=new EffectiveUsageReaderError('EFFECTIVE_USAGE_UNAVAILABLE',{cause:inner});
  await expect(withStorageGraphFailureStage('daily_shared_feature',async()=>{throw unavailable;}))
   .rejects.toBe(inner);
  const cycle=new EffectiveUsageReaderError('EFFECTIVE_USAGE_UNAVAILABLE',{cause:unavailable});
  unavailable.cause=cycle;
  expect(classifyStorageGraphFailure(unavailable)).toBe('application');
  expect(caughtStorageGraphFailureFields('daily_shared_feature',unavailable))
   .toEqual({phase:'daily_shared_feature',reason:'application'});
 });

 it('records inclusive successful and throwing timings from actual statement deltas',async()=>{
  const timing=createStoragePublicationTiming();let statements=0;
  const result=await withStoragePublicationTiming('daily_attempt',timing.observe,()=>statements,
   async()=>withStoragePublicationTiming('feature_source_page',timing.observe,()=>statements,
    async()=>{statements+=3;return 'complete' as const;}));
  expect(result).toBe('complete');
  const failure=new Error('synthetic private failure');
  await expect(withStoragePublicationTiming('feature_save',timing.observe,()=>statements,
   async()=>{statements+=2;throw failure;})).rejects.toBe(failure);
  const deferred=await withStoragePublicationTiming('feature_dependency',timing.observe,()=>statements,
   async()=>{statements+=1;return {state:'deferred' as const};});
  expect(deferred).toEqual({state:'deferred'});
  const snapshot=timing.snapshot();
  expect(Object.keys(snapshot)).toEqual([...STORAGE_PUBLICATION_TIMING_PHASES]);
  expect(snapshot.daily_attempt).toMatchObject({count:1,totalStatements:3,maxStatements:3});
  expect(snapshot.feature_source_page).toMatchObject({count:1,totalStatements:3,maxStatements:3});
  expect(snapshot.feature_save).toMatchObject({count:1,totalStatements:2,maxStatements:2});
  expect(snapshot.feature_dependency).toMatchObject({count:1,totalStatements:1,maxStatements:1});
  expect(snapshot.daily_attempt.totalWallMs).toBeGreaterThanOrEqual(snapshot.feature_source_page.totalWallMs);
  for(const value of Object.values(snapshot)){
   expect(Object.keys(value)).toEqual(['count','totalWallMs','maxWallMs','totalStatements','maxStatements']);
   expect(Object.values(value).every(number=>Number.isSafeInteger(number)&&number>=0)).toBe(true);
  }
  expect(JSON.stringify(snapshot)).not.toContain('private failure');
 });

 it('isolates broken observers and counters from results, errors, and work',async()=>{
  const failure=new Error('original work error');let work=0;
  const broken=()=>{throw new Error('observer failure');};
  expect(await withStoragePublicationTiming('daily_attempt',broken,()=>0,
   async()=>{work++;return 'same result';})).toBe('same result');
  await expect(withStoragePublicationTiming('feature_save',broken,()=>0,
   async()=>{work++;throw failure;})).rejects.toBe(failure);
  expect(await withStoragePublicationTiming('daily_attempt',broken,()=>{throw failure;},
   async()=>{work++;return 'counter ignored';})).toBe('counter ignored');
  expect(work).toBe(3);
  const timing=createStoragePublicationTiming();
  for(let count=0;count<8;count++)timing.observe('daily_attempt',1,1);
  timing.observe('owner:synthetic' as never,1,1);
  timing.observe('feature_save',Number.NaN,1);
  expect(timing.snapshot().daily_attempt).toMatchObject({count:4,totalStatements:4});
  expect(Object.keys(timing.snapshot())).toEqual([...STORAGE_PUBLICATION_TIMING_PHASES]);
 });
});
