import { describe,expect,it } from 'vitest';
import { D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { V11ProjectionDeadlineExceededError } from '../src/v11-daily-projection';
import { caughtStorageGraphFailureFields,classifyStorageGraphFailure,storageGraphFailureDetail,storageGraphFailureFields,
 StorageGraphOperationError,withStorageGraphFailureStage } from '../src/storage-analytics-failure';

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
});
