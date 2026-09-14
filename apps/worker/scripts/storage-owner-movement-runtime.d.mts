import type { OwnerStorageRoute, StorageShardBindings } from '../src/storage-routing';

export interface StorageOwnerMovementRuntimePlan {
  schema:'storage-owner-movement-runtime-v1'; operationDigest:string; moveId:string; ownerDigest:string;
  sourceRoute:OwnerStorageRoute; destinationShardId:string; sourceNamespace:string;
  catalogBinding:'STORAGE_ROUTING_DB'; sourceBinding:string; destinationBinding:string;
  pageSize:number; expiresAt:number;
}

export interface StorageOwnerMovementRuntimeStatus {
  state:'absent'|'copying'|'ready'|'fencing'|'finalizing'|'verified'|'committed'|'abandoning'|'abandoned';
  destinationGeneration:number|null;reservationBytes:number|null;sourceNamespace:string|null;
  precopyCursor:number; precopyHighWater:number; finalHighWater:number|null;
  materializedCursor:number; verifyCursor:number;verifyChainDigest:string|null;authorityDigest:string|null;copyDigest:string|null;
  route:{shardId:string;bindingName:string;generation:number}|null;
  sourceFence:{shardId:string;generation:number;state:string;moveId:string|null;copyDigest:string|null}|null;
  destinationFence:{shardId:string;generation:number;state:string;moveId:string|null;copyDigest:string|null}|null;
  move:{moveId:string;ownerId:string;sourceShardId:string;destinationShardId:string;sourceGeneration:number;
    destinationGeneration:number;reservationBytes:number;state:string;copyDigest:string|null}|null;
  authority:{ownerId:string;authorityDigest:string;state:string}|null;
  history:{ownerId:string;sourceNamespace:string;state:string;completedDigest:string|null}|null;
  copyControl:string|null;stagedCount:number;stagedInvalidCount:number;stagedMaximum:number;
}

export function validateStorageOwnerMovementRuntimePlan(value:unknown):StorageOwnerMovementRuntimePlan;
export function readStorageOwnerMovementRuntimeStatus(env:Record<string,unknown>,
  plan:StorageOwnerMovementRuntimePlan):Promise<StorageOwnerMovementRuntimeStatus>;
export function createStorageOwnerMovementWorker(options:{
  createMovement:(options:{catalog:D1Database;bindings:StorageShardBindings;clock:()=>number})=>{
    prepare(moveId:string,route:OwnerStorageRoute,destinationShardId:string,sourceNamespace:string):Promise<unknown>;
    copyPage(moveId:string,limit:number):Promise<unknown>;
    fenceSource(moveId:string):Promise<unknown>;
    resumeFinalization(moveId:string):Promise<unknown>;
    rollbackPage(moveId:string,limit:number):Promise<unknown>;
  };
  plan:StorageOwnerMovementRuntimePlan;clock?:()=>number;
}):{
  fetch():Response;
  queue(batch:{messages:Array<{body:unknown;ack():void}>},env:Record<string,unknown>):Promise<void>;
};
