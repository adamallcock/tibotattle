import {requireStorageParticipantErasureComplete} from './storage-erasure';
import {invalidatePublicationsForOwnerErasure,prepareMultiSourceParticipantErasure,
  requireMultiSourceParticipantErasureComplete,storageErasurePlanForOwnerRoute,
} from './storage-multi-source-erasure';
import {assertParticipantDeletionRouteRegistered,storageForParticipantOwner} from './storage-routing-runtime';
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
import { revokeAccountlessEnrollment } from "./accountless-enrollment";
import { MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT } from "./constants";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { assertPinnedIdentityLinkSecretConfiguration } from "./identity-link-configuration";
import { identityRequired } from "./identity-oidc";
import {
  assertDeletionOwner,
  finishParticipantDeletion,
  listContributions,
  markParticipantDeleting,
  participantIdentityLinkKeyForDeletion,
} from "./repository";
import {
  hasDeletionTombstone,
  identityReenrollmentCooldownDigest,
  recordDeletionTombstone,
  recordIdentityReenrollmentCooldownFromDigest,
  recordPrimaryIdentityReenrollmentCooldown,
} from "./retention";
import {
  telemetryContributionCount,
  telemetryContributionR2KeyPage,
} from "./telemetry-repository";
import {
  telemetryV1ChunkCount,
  telemetryV1ChunkR2KeyPage,
} from "./telemetry-v1-repository";
import { telemetryV11ChunkCount, telemetryV11ChunkR2KeyPage } from "./telemetry-v11-repository";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTICIPANT_ID_PATTERN = new RegExp(`^participant:${UUID_PATTERN.source.slice(1)}`, "u");
const AUDIT_TARGET_DOMAIN = "app-usagemonitor/admin-participant-erasure/v1\0";
const ERASURE_ATTEMPT_LEASE_MILLISECONDS = 5 * 60 * 1_000;

type ErasureResult =
  | { deleted: true; alreadyDeleted: false; contributionsDeleted: number }
  | { deleted: true; alreadyDeleted: true; contributionsDeleted: null };

export function parseParticipantErasureRequest(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "action\0participantErasure"
      || Reflect.get(value, "action") !== "run_maintenance") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const erasure: unknown = Reflect.get(value, "participantErasure");
  if (typeof erasure !== "object" || erasure === null || Array.isArray(erasure)
      || Object.keys(erasure).sort().join("\0") !== "confirmation\0participantId"
      || Reflect.get(erasure, "confirmation") !== "erase_hosted_participant") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const participantId: unknown = Reflect.get(erasure, "participantId");
  if (typeof participantId !== "string" || !PARTICIPANT_ID_PATTERN.test(participantId)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return participantId;
}

interface ParticipantDeletionSnapshot {
  contributions:number;
  telemetry:number;
  telemetryV1:number;
  telemetryV11:number;
}

async function routedParticipantOwner(db:D1Database,participantId:string):Promise<string|null>{
  return db.prepare(`SELECT ledger.installation_principal_id FROM participants participant
    JOIN accountless_upload_owners owner ON owner.participant_id=participant.id
    JOIN accountless_enrollment_ledger ledger ON ledger.device_id=owner.enrollment_device_id
    WHERE participant.id=? AND participant.owner_kind='accountless' LIMIT 1`)
    .bind(participantId).first<string>('installation_principal_id');
}

async function beginParticipantSourceDeletion(options:{global:D1Database;source:D1Database;participantId:string;
  operationId:string;expectedRouteOwnerId?:string}):Promise<ParticipantDeletionSnapshot|null>{
  const {global,source,participantId,operationId,expectedRouteOwnerId}=options;
  let participant=await source.prepare(`SELECT participant.state,participant.deletion_session_id,
    participant.owner_kind,owner.enrollment_device_id FROM participants participant
    LEFT JOIN accountless_upload_owners owner ON owner.participant_id=participant.id AND owner.state='active'
    WHERE participant.id=?`).bind(participantId).first<{state:string;deletion_session_id:string|null;
      owner_kind:"social"|"accountless";enrollment_device_id:string|null}>();
  if(!participant)return null;
  if(expectedRouteOwnerId!==undefined&&await routedParticipantOwner(source,participantId)!==expectedRouteOwnerId){
    throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
  }
  if(participant.state!=='active'&&participant.state!=='deleting')throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
  if(participant.owner_kind==='accountless'&&typeof participant.enrollment_device_id==='string'){
    await revokeAccountlessEnrollment(source,participant.enrollment_device_id,'security_reset');
  }
  if(participant.state==='active'){
    await markParticipantDeleting(source,participantId,operationId);
  }else if(participant.deletion_session_id!==operationId){
    const previous=participant.deletion_session_id;
    if(typeof previous!=='string'||!UUID_PATTERN.test(previous))throw new ApiError(409,'PARTICIPANT_DELETING');
    const active=await global.prepare(`SELECT 1 AS active FROM admin_action_audit
      WHERE operation_id=? AND outcome='started' AND created_at>? LIMIT 1`)
      .bind(previous,new Date(Date.now()-ERASURE_ATTEMPT_LEASE_MILLISECONDS).toISOString()).first();
    if(active)throw new ApiError(409,'PARTICIPANT_DELETING');
    const claimed=await source.prepare(`UPDATE participants SET deletion_session_id=?
      WHERE id=? AND state='deleting' AND deletion_session_id=?`).bind(operationId,participantId,previous).run();
    if(claimed.meta.changes!==1)throw new ApiError(409,'PARTICIPANT_DELETING');
  }
  await assertDeletionOwner(source,participantId,operationId);
  await source.prepare(`UPDATE web_sessions SET state='revoked',revoked_at=? WHERE participant_id=? AND state='active'
    AND EXISTS(SELECT 1 FROM participants WHERE id=? AND state='deleting' AND deletion_session_id=?)`)
    .bind(new Date().toISOString(),participantId,participantId,operationId).run();
  const [contributions,telemetry,telemetryV1,telemetryV11]=await Promise.all([
    listContributions(source,participantId),telemetryContributionCount(source,participantId),
    telemetryV1ChunkCount(source,participantId),telemetryV11ChunkCount(source,participantId),
  ]);
  if(contributions.length>MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT)throw new ApiError(500,'INTERNAL_ERROR');
  participant=await source.prepare(`SELECT state,deletion_session_id,owner_kind,NULL AS enrollment_device_id
    FROM participants WHERE id=?`).bind(participantId).first<typeof participant>();
  if(!participant||participant.state!=='deleting'||participant.deletion_session_id!==operationId){
    throw new ApiError(409,'PARTICIPANT_DELETING');
  }
  return {contributions:contributions.length,telemetry,telemetryV1,telemetryV11};
}

async function finishParticipantSourceDeletion(env:Env,source:D1Database,participantId:string,operationId:string,
  expected:ParticipantDeletionSnapshot):Promise<void>{
  const contributions=await listContributions(source,participantId);
  if(contributions.length>0){
    await assertDeletionOwner(source,participantId,operationId);
    await env.QUARANTINE.delete(contributions.map(row=>row.r2_key));
  }
  let cursor:{createdAt:string;contributionId:string}|null=null;
  do{const page=await telemetryContributionR2KeyPage(source,participantId,cursor);
    if(page.rows.length>0){await assertDeletionOwner(source,participantId,operationId);
      await env.QUARANTINE.delete(page.rows.map(row=>row.r2Key));}cursor=page.nextCursor;}while(cursor);
  let chunkCursor:{createdAt:string;chunkRowId:string}|null=null;
  do{const page=await telemetryV1ChunkR2KeyPage(source,participantId,chunkCursor);
    if(page.rows.length>0){await assertDeletionOwner(source,participantId,operationId);
      await env.QUARANTINE.delete(page.rows.map(row=>row.r2Key));}chunkCursor=page.nextCursor;}while(chunkCursor);
  let stagedCursor:{createdAt:string;chunkRowId:string}|null=null;
  do{const page=await telemetryV11ChunkR2KeyPage(source,participantId,stagedCursor);
    if(page.rows.length>0){await assertDeletionOwner(source,participantId,operationId);
      await env.QUARANTINE.delete(page.rows.map(row=>row.r2Key));}stagedCursor=page.nextCursor;}while(stagedCursor);
  const current=await Promise.all([telemetryContributionCount(source,participantId),
    telemetryV1ChunkCount(source,participantId),telemetryV11ChunkCount(source,participantId)]);
  if(current[0]!==expected.telemetry||current[1]!==expected.telemetryV1||current[2]!==expected.telemetryV11){
    throw new ApiError(409,'UPLOAD_IN_PROGRESS');
  }
  await finishParticipantDeletion(source,participantId,operationId);
}

/**
 * Internal erasure machinery, called only after owner authorization and CSRF.
 * The audit operation is also the deletion fence for a newly erased account.
 * A failed/abandoned attempt can be fenced out by an owner retry. A fresh
 * started audit prevents concurrent requests from joining the same operation.
 */
async function eraseParticipantData(
  env: Env,
  participantId: string,
  operationId: string,
): Promise<ErasureResult> {
  const ownerStorage=await storageForParticipantOwner(env,participantId);
  await assertParticipantDeletionRouteRegistered(env,participantId,ownerStorage.route);
  await invalidatePublicationsForOwnerErasure(env,ownerStorage.route);
  const catalogErasure=ownerStorage.route.mode==='catalog';
  if(catalogErasure)await recordDeletionTombstone(env.DELETION_LEDGER,participantId);
  const plan=await storageErasurePlanForOwnerRoute(env,ownerStorage.route);
  const participant = await ownerStorage.database.prepare(
    `SELECT participant.state,
            participant.deletion_session_id,
            participant.owner_kind,
            owner.enrollment_device_id
       FROM participants participant
       LEFT JOIN accountless_upload_owners owner
         ON owner.participant_id = participant.id AND owner.state = 'active'
      WHERE participant.id = ?`,
  ).bind(participantId).first<{
    state: string;
    deletion_session_id: string | null;
    owner_kind: "social" | "accountless";
    enrollment_device_id: string | null;
  }>();
  if (participant === null) {
    if (!await hasDeletionTombstone(env.DELETION_LEDGER, participantId)) {
      throw new ApiError(404, "NOT_FOUND");
    }
  } else if (participant.state !== "active" && participant.state !== "deleting") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (identityRequired(env)) {
    await assertPinnedIdentityLinkSecretConfiguration(
      env.USAGE_MONITOR_DB,
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
    );
  }
  const ordered=[...(plan?.routeTargets??[])].sort((left,right)=>Number(left.current)-Number(right.current));
  const snapshots=new Map<D1Database,ParticipantDeletionSnapshot>();
  // Preserve the single-database fence ordering: an unavailable independent
  // ledger must still leave the source participant deleting and block uploads.
  // Catalog mode durably records its tombstone before touching any source.
  if(!catalogErasure){
    const snapshot=await beginParticipantSourceDeletion({global:env.USAGE_MONITOR_DB,
      source:ownerStorage.database,participantId,operationId});
    if(snapshot)snapshots.set(ownerStorage.database,snapshot);
  }
  if(!catalogErasure)await recordDeletionTombstone(env.DELETION_LEDGER, participantId);
  if(plan)await prepareMultiSourceParticipantErasure(plan.targets,participantId);

  // Mark every retained catalog source before deleting any of them. A target
  // outage leaves all owner links available for the next bounded retry.
  if(catalogErasure){
    for(const target of ordered){
      const snapshot=await beginParticipantSourceDeletion({global:env.USAGE_MONITOR_DB,source:target.database,
        participantId,operationId,expectedRouteOwnerId:target.ownerId});
      if(snapshot)snapshots.set(target.database,snapshot);
    }
  }
  const currentSnapshot=snapshots.get(ownerStorage.database);
  if(participant!==null&&!currentSnapshot)throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
  const identityLinkKey=currentSnapshot?await participantIdentityLinkKeyForDeletion(
    ownerStorage.database,participantId,operationId):null;
  if(identityLinkKey!==null){
    const secret: unknown = Reflect.get(env, "IDENTITY_LINK_SECRET");
    if (typeof secret !== "string" || secret.length < 32) {
      if (identityRequired(env)) throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    } else {
      const digest = await identityReenrollmentCooldownDigest(secret, identityLinkKey);
      await recordPrimaryIdentityReenrollmentCooldown(ownerStorage.database, digest);
      await recordIdentityReenrollmentCooldownFromDigest(env.DELETION_LEDGER, digest);
    }
  }
  for(const target of ordered){
    const snapshot=snapshots.get(target.database);
    if(snapshot)await finishParticipantSourceDeletion(env,target.database,participantId,operationId,snapshot);
  }
  if(!plan&&currentSnapshot)await finishParticipantSourceDeletion(env,ownerStorage.database,participantId,operationId,currentSnapshot);
  if(plan){
    await requireMultiSourceParticipantErasureComplete(env.DELETION_LEDGER,participantId,plan.targets);
  }else await requireStorageParticipantErasureComplete(env.DELETION_LEDGER,participantId,null);
  if(participant===null)return {deleted:true,alreadyDeleted:true,contributionsDeleted:null};
  return {
    deleted: true,
    alreadyDeleted: false,
    contributionsDeleted:(currentSnapshot?.contributions??0)+(currentSnapshot?.telemetry??0)
      +(currentSnapshot?.telemetryV1??0)+(currentSnapshot?.telemetryV11??0),
  };
}

/** Not a participant API: the caller must have passed the existing admin gate. */
export async function eraseParticipantAsOwner(
  env: Env,
  actorIdentityKey: string,
  participantId: string,
): Promise<ErasureResult & { task: "participant_erasure"; operationId: string }> {
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) throw new ApiError(400, "BODY_INVALID");
  const details = {
    task: "participant_erasure" as const,
    participantDigest: await sha256Hex(`${AUDIT_TARGET_DOMAIN}${participantId}`),
  };
  // Fail closed before touching participant data if the durable audit fails.
  const operationId = await beginAdminOperation(
    env.USAGE_MONITOR_DB, actorIdentityKey, "run_maintenance", details,
  );
  try {
    const result = await eraseParticipantData(env, participantId, operationId);
    await finishAdminOperation(env.USAGE_MONITOR_DB, operationId, "success", { ...details, ...result });
    return { task: "participant_erasure", operationId, ...result };
  } catch (error) {
    try {
      await finishAdminOperation(env.USAGE_MONITOR_DB, operationId, "failure", {
        ...details,
        code: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      });
    } catch {
      // Preserve the original error. An unfinished audit is not a success receipt.
    }
    throw error;
  }
}
