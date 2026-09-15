import { D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { V11ProjectionDeadlineExceededError } from './v11-daily-projection';

export const STORAGE_GRAPH_OPERATION_STAGES=[
 'graph_scope','graph_historical_pin','graph_checkpoint_load',
 'graph_history_direct_read',
 'graph_history_layout','graph_history_source_precheck','graph_history_reader',
 'graph_history_acquisition_page','graph_history_source_postcheck','graph_history_finish',
 'graph_checkpoint_save','graph_current_fit_compute','graph_model_compute',
] as const;
export type StorageGraphOperationStage=typeof STORAGE_GRAPH_OPERATION_STAGES[number];
export const STORAGE_GRAPH_FAILURE_REASONS=[
 'd1_cpu_limit','d1_timeout','query_too_large','too_many_bindings','query_limit','d1_other',
 'checkpoint_unavailable','checkpoint_mismatch','source_changed','application',
] as const;
export type StorageGraphFailureReason=typeof STORAGE_GRAPH_FAILURE_REASONS[number];

export class StorageGraphOperationError extends Error {
 readonly stage:StorageGraphOperationStage;readonly reason:StorageGraphFailureReason;
 constructor(stage:StorageGraphOperationStage,reason:StorageGraphFailureReason){
  super('STORAGE_GRAPH_OPERATION_UNAVAILABLE');this.stage=stage;this.reason=reason;
 }
}

export interface StorageGraphFailureFields {
 phase:StorageGraphOperationStage;
 reason:StorageGraphFailureReason;
}

/** D1 may attach SQL, bindings or account data to its message. Inspect only a
 * closed list of provider phrases and retain only the static classification. */
export function classifyStorageGraphFailure(error:unknown):StorageGraphFailureReason{
 const message=error instanceof Error?error.message.toLowerCase():'';
 if(message==='storage_history_checkpoint_unavailable')return 'checkpoint_unavailable';
 if(message==='storage_v1_history_checkpoint_mismatch')return 'checkpoint_mismatch';
 if(message==='v1 source changed during analysis')return 'source_changed';
 const name=error instanceof Error?error.name.toLowerCase():'';
 const d1=name.includes('d1')||message.startsWith('d1_error:')||message.startsWith('d1_exec_error:')
  ||message.includes('d1 db storage')||message.includes('error 7429');
 if(d1&&(message.includes('exceeded cpu time')||message.includes('cpu time limit')||message.includes('error 7429')))return 'd1_cpu_limit';
 if(d1&&(message.includes('timed out')||message.includes('timeout')))return 'd1_timeout';
 if(d1&&(message.includes('too many sql variables')||message.includes('too many bound')||message.includes('binding count')))return 'too_many_bindings';
 if(d1&&(message.includes('query is too large')||message.includes('statement too long')||message.includes('maximum sql length')))return 'query_too_large';
 if(d1&&(message.includes('query limit')||message.includes('too many queries')||message.includes('subrequest limit')))return 'query_limit';
 if(d1)return 'd1_other';
 return 'application';
}

/** Controlled budget/deadline exhaustion remains a deferred pass. Existing
 * classified failures also keep their innermost actionable operation stage. */
export function rethrowStorageGraphFailure(stage:StorageGraphOperationStage,error:unknown):never{
 if(error instanceof D1InvocationBudgetExceededError||error instanceof V11ProjectionDeadlineExceededError
   ||error instanceof StorageGraphOperationError)throw error;
 throw new StorageGraphOperationError(stage,classifyStorageGraphFailure(error));
}

export async function withStorageGraphFailureStage<T>(stage:StorageGraphOperationStage,
 operation:()=>Promise<T>):Promise<T>{
 try{return await operation()}
 catch(error){rethrowStorageGraphFailure(stage,error)}
}

/** Return only closed diagnostic fields. Never expose the original exception,
 * its message, a query, bindings, or identifiers to the scheduler log. */
export function storageGraphFailureFields(error:unknown):StorageGraphFailureFields|Record<string,never>{
 return error instanceof StorageGraphOperationError?{phase:error.stage,reason:error.reason}:{};
}

/** Classify a caught best-effort graph operation without converting controlled
 * query-budget or deadline exhaustion into a scheduler failure. */
export function caughtStorageGraphFailureFields(stage:StorageGraphOperationStage,
 error:unknown):StorageGraphFailureFields|undefined {
 if(error instanceof D1InvocationBudgetExceededError||error instanceof V11ProjectionDeadlineExceededError)return undefined;
 if(error instanceof StorageGraphOperationError)return {phase:error.stage,reason:error.reason};
 return {phase:stage,reason:classifyStorageGraphFailure(error)};
}
