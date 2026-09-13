import { participantDeletionDigest } from './participant-deletion-digest';
import {ApiError} from './errors';
import { advanceStorageErasureJobs, prepareStorageParticipantErasure,
  readStorageErasureSourceIdentity,reconcileStorageErasureTargetReceipts,
  requireStorageParticipantErasureSourceComplete,
  storageErasureBindings, type StorageErasureBindings } from './storage-erasure';
import { advanceMultiSourcePublicationGenerations } from './storage-multi-source-publication';
import {storageTargetsForOwnerRoute,type OwnerStorageTargetContext} from './storage-routing-runtime';
import type {OwnerStorageRoute} from './storage-routing';

export interface StorageErasureTarget extends StorageErasureBindings {targetId:string;}
export interface MultiSourceStorageErasurePlan {
  routeTargets:readonly OwnerStorageTargetContext[];
  targets:readonly StorageErasureTarget[];
  publicationTarget?:D1Database;
}
interface MultiSourceErasureEnv {
  STORAGE_ANALYTICS_A?:unknown;STORAGE_ANALYTICS_B?:unknown;STORAGE_ANALYTICS_C?:unknown;
  STORAGE_PUBLICATION_DB?:unknown;
}
const id=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const fail=()=>new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
function validate(targets:readonly StorageErasureTarget[]):void {
  if(!Array.isArray(targets)||targets.length<1||targets.length>8)throw fail();
  const sourceIds=new Set<string>(),targetIds=new Set<string>();
  for(const target of targets){
    if(!id.test(target.sourceId)||!id.test(target.targetId)||sourceIds.has(target.sourceId)
      ||targetIds.has(target.targetId)||target.source===target.target)throw fail();
    sourceIds.add(target.sourceId);targetIds.add(target.targetId);
  }
  const ledger=targets[0]!.ledger;if(targets.some(target=>target.ledger!==ledger))throw fail();
}

function database(value:unknown):value is D1Database {
  return !!value&&typeof value==='object'&&typeof Reflect.get(value,'prepare')==='function'
    &&typeof Reflect.get(value,'batch')==='function';
}

/** Resolve only the physical sources proven by the authenticated route and its
 * immutable move history. Analytics pairings are explicit binding pairs; an
 * unbound spare refuses erasure rather than silently omitting derived data. */
export async function storageErasurePlanForOwnerRoute(env:Env,route:OwnerStorageRoute):Promise<MultiSourceStorageErasurePlan|null>{
  const routeTargets=await storageTargetsForOwnerRoute(env,route);
  if(route.mode==='single'){
    const binding=await storageErasureBindings(env);
    return binding?{routeTargets,targets:[{...binding,targetId:'ANALYTICS_DB'}]}:null;
  }
  const runtime=env as Env&MultiSourceErasureEnv;
  if(!database(runtime.STORAGE_PUBLICATION_DB))throw fail();
  const analyticsBindings:Readonly<Record<string,{binding:keyof MultiSourceErasureEnv;targetId:string}>>={
    STORAGE_INGESTION_A:{binding:'STORAGE_ANALYTICS_A',targetId:'analytics-a'},
    STORAGE_INGESTION_B:{binding:'STORAGE_ANALYTICS_B',targetId:'analytics-b'},
    STORAGE_INGESTION_C:{binding:'STORAGE_ANALYTICS_C',targetId:'analytics-c'},
  };
  const targets:StorageErasureTarget[]=[];
  for(const source of routeTargets){
    const configured=analyticsBindings[source.bindingName];
    const target=configured?runtime[configured.binding]:undefined;
    if(!configured||!database(target))throw fail();
    const identity=await readStorageErasureSourceIdentity(source.database);
    targets.push({source:source.database,target,ledger:env.DELETION_LEDGER,
      sourceId:identity.sourceId,sourceNamespace:identity.sourceNamespace,targetId:configured.targetId});
  }
  validate(targets);
  return {routeTargets,targets,publicationTarget:runtime.STORAGE_PUBLICATION_DB};
}

/** Reserve a unique invalidation generation in the publication database before
 * any source deletion. Retrying may advance again, which is conservative: no
 * earlier complete result can become visible while cleanup is unfinished. */
export async function invalidateMultiSourcePublicationsForErasure(target:D1Database,nowMs=Date.now()):Promise<number>{
  if(!Number.isSafeInteger(nowMs)||nowMs<0)throw fail();
  const row=await target.prepare(`UPDATE analytics_multi_source_control SET
    erasure_generation=erasure_generation+1,updated_ms=MAX(updated_ms,?)
    WHERE singleton=1 AND erasure_generation<9007199254740990
    RETURNING erasure_generation`).bind(nowMs).first<{erasure_generation:number}>();
  if(!row||!Number.isSafeInteger(row.erasure_generation)||row.erasure_generation<1)throw fail();
  return row.erasure_generation;
}

/** The owner-admin request calls this immediately after its catalog locator is
 * authenticated, before any source discovery that could fail. */
export async function invalidatePublicationsForOwnerErasure(env:Env,route:OwnerStorageRoute):Promise<number|null>{
  if(route.mode==='single')return null;
  const target=(env as Env&MultiSourceErasureEnv).STORAGE_PUBLICATION_DB;
  if(!database(target))throw fail();
  return invalidateMultiSourcePublicationsForErasure(target);
}

/** Called while every retained source still has its participant->owner link.
 * The caller supplies current, prior and retained source/target pairs; absence
 * from that declared set is never inferred from a routing snapshot. */
export async function prepareMultiSourceParticipantErasure(targets:readonly StorageErasureTarget[],participantId:string,
  publication?:{target:D1Database;routingGeneration:number;erasureGeneration:number}):Promise<number>{
  validate(targets);
  // This is deliberately before any source deletion. Once owner erasure is
  // authorized, the old central result cannot be served while physical target
  // cleanup catches up.
  if(publication)await advanceMultiSourcePublicationGenerations(publication.target,{
    routingGeneration:publication.routingGeneration,erasureGeneration:publication.erasureGeneration});
  const participantDigest=await participantDeletionDigest(participantId);let prepared=0;
  for(const target of targets){
    await prepareStorageParticipantErasure(target,participantId);
    const jobs=(await target.ledger.prepare(`SELECT owner_digest,source_namespace FROM storage_erasure_jobs
      WHERE participant_digest=? AND source_id=? ORDER BY owner_digest LIMIT 9`).bind(participantDigest,target.sourceId)
      .all<{owner_digest:string;source_namespace:string}>()).results;
    if(jobs.length>8)throw fail();
    for(const job of jobs){
      await target.ledger.prepare(`INSERT INTO storage_erasure_targets
        (participant_digest,source_id,owner_digest,target_id,source_namespace,state,completed_at)
        VALUES(?,?,?,?,?,'pending',NULL) ON CONFLICT(participant_digest,source_id,owner_digest,target_id)
        DO UPDATE SET state='pending',completed_at=NULL WHERE source_namespace=excluded.source_namespace`)
        .bind(participantDigest,target.sourceId,job.owner_digest,target.targetId,job.source_namespace).run();
      const receipt=await target.ledger.prepare(`SELECT state,source_namespace FROM storage_erasure_targets
        WHERE participant_digest=? AND source_id=? AND owner_digest=? AND target_id=?`)
        .bind(participantDigest,target.sourceId,job.owner_digest,target.targetId)
        .first<{state:string;source_namespace:string}>();
      if(receipt?.state!=='pending'||receipt.source_namespace!==target.sourceNamespace)throw fail();prepared++;
    }
  }
  return prepared;
}

export async function advanceMultiSourceStorageErasureJobs(options:{
  targets:readonly StorageErasureTarget[];publicationTarget?:D1Database;
  routingGeneration?:number;erasureGeneration?:number;maxJobsPerTarget?:number;participantId?:string;
}):Promise<{completedTargets:number;pendingTargets:number;unavailableTargets:string[]}>{
  validate(options.targets);
  if(options.publicationTarget){
    if(!Number.isSafeInteger(options.routingGeneration)||!Number.isSafeInteger(options.erasureGeneration)
      ||options.routingGeneration!<0||options.erasureGeneration!<0)throw fail();
    await advanceMultiSourcePublicationGenerations(options.publicationTarget,{routingGeneration:options.routingGeneration!,
      erasureGeneration:options.erasureGeneration!});
  }
  let completedTargets=0;const unavailableTargets:string[]=[];
  for(const target of options.targets){
    try{
      await advanceStorageErasureJobs(target,{maxJobs:options.maxJobsPerTarget??1});
      completedTargets+=await reconcileStorageErasureTargetReceipts(target.ledger,target.sourceId,target.targetId);
    }catch{unavailableTargets.push(target.targetId);}
  }
  const ledger=options.targets[0]!.ledger;
  const participantDigest=options.participantId===undefined?null:await participantDeletionDigest(options.participantId);
  const pendingTargets=participantDigest===null
    ?await ledger.prepare("SELECT COUNT(*) n FROM storage_erasure_targets WHERE state='pending'").first<number>('n')
    :await ledger.prepare("SELECT COUNT(*) n FROM storage_erasure_targets WHERE state='pending' AND participant_digest=?")
      .bind(participantDigest).first<number>('n');
  if(!Number.isSafeInteger(pendingTargets)||pendingTargets!<0)throw fail();
  return {completedTargets,pendingTargets:pendingTargets!,unavailableTargets};
}

export async function requireMultiSourceParticipantErasureComplete(ledger:D1Database,participantId:string,
  targets:readonly StorageErasureTarget[]):Promise<void>{
  validate(targets);const participantDigest=await participantDeletionDigest(participantId);
  for(const target of targets){
    try{await requireStorageParticipantErasureSourceComplete(ledger,participantId,target);}
    catch(error){
      // A restored derived target can invalidate a previously complete source
      // proof. Reopen its per-target receipt before returning unavailable so
      // the bounded reconciler records a fresh completion time.
      await ledger.prepare(`UPDATE storage_erasure_targets SET state='pending',completed_at=NULL
       WHERE participant_digest=? AND source_id=? AND target_id=?`)
       .bind(participantDigest,target.sourceId,target.targetId).run();
      throw error;
    }
    await reconcileStorageErasureTargetReceipts(ledger,target.sourceId,target.targetId);
  }
  const pending=await ledger.prepare(`SELECT 1 FROM storage_erasure_targets WHERE participant_digest=? AND state!='complete' LIMIT 1`)
    .bind(participantDigest).first();
  if(pending)throw fail();
}
