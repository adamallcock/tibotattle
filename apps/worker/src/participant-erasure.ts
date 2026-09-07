import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
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
  const participant = await env.USAGE_MONITOR_DB.prepare(
    "SELECT state, deletion_session_id FROM participants WHERE id = ?",
  ).bind(participantId).first<{
    state: string;
    deletion_session_id: string | null;
  }>();
  if (participant === null) {
    if (!await hasDeletionTombstone(env.DELETION_LEDGER, participantId)) {
      throw new ApiError(404, "NOT_FOUND");
    }
    // A lost response can be retried, but the removed rows cannot provide a
    // historical contribution count. Unknown is not zero.
    return { deleted: true, alreadyDeleted: true, contributionsDeleted: null };
  }
  if (participant.state !== "active" && participant.state !== "deleting") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (identityRequired(env)) {
    await assertPinnedIdentityLinkSecretConfiguration(
      env.USAGE_MONITOR_DB,
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
    );
  }
  let deletionFence = participant.deletion_session_id;
  if (participant.state === "active") {
    deletionFence = operationId;
    await markParticipantDeleting(env.USAGE_MONITOR_DB, participantId, deletionFence);
  } else {
    // Restore replay owns the NULL fence, including an interrupted replay.
    // Let its existing maintenance retry finish rather than taking it over.
    if (deletionFence === null) throw new ApiError(409, "PARTICIPANT_DELETING");
    if (typeof deletionFence !== "string" || !UUID_PATTERN.test(deletionFence)) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    const claimed = await env.USAGE_MONITOR_DB.prepare(
      `UPDATE participants SET deletion_session_id = ?
        WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM admin_action_audit
             WHERE operation_id = ? AND outcome = 'started' AND created_at > ?
          )`,
    ).bind(
      operationId,
      participantId,
      deletionFence,
      deletionFence,
      new Date(Date.now() - ERASURE_ATTEMPT_LEASE_MILLISECONDS).toISOString(),
    ).run();
    if (claimed.meta.changes !== 1) throw new ApiError(409, "PARTICIPANT_DELETING");
    deletionFence = operationId;
  }
  if (typeof deletionFence !== "string" || !UUID_PATTERN.test(deletionFence)) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  await assertDeletionOwner(env.USAGE_MONITOR_DB, participantId, deletionFence);
  // A legacy deleting participant may still have its old deletion-only web
  // session. The owner procedure no longer needs to preserve that capability.
  await env.USAGE_MONITOR_DB.prepare(
    `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
      WHERE participant_id = ? AND state = 'active'
        AND EXISTS (
          SELECT 1 FROM participants
           WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?
        )`,
  ).bind(new Date().toISOString(), participantId, participantId, deletionFence).run();
  await recordDeletionTombstone(env.DELETION_LEDGER, participantId);
  const identityLinkKey = await participantIdentityLinkKeyForDeletion(
    env.USAGE_MONITOR_DB, participantId, deletionFence,
  );
  if (identityLinkKey !== null) {
    const secret: unknown = Reflect.get(env, "IDENTITY_LINK_SECRET");
    if (typeof secret !== "string" || secret.length < 32) {
      if (identityRequired(env)) throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    } else {
      const digest = await identityReenrollmentCooldownDigest(secret, identityLinkKey);
      await recordPrimaryIdentityReenrollmentCooldown(env.USAGE_MONITOR_DB, digest);
      await recordIdentityReenrollmentCooldownFromDigest(env.DELETION_LEDGER, digest);
    }
  }
  const contributions = await listContributions(env.USAGE_MONITOR_DB, participantId);
  if (contributions.length > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const telemetryTotal = await telemetryContributionCount(env.USAGE_MONITOR_DB, participantId);
  const telemetryV1Total = await telemetryV1ChunkCount(env.USAGE_MONITOR_DB, participantId);
  const telemetryV11Total = await telemetryV11ChunkCount(env.USAGE_MONITOR_DB, participantId);
  if (contributions.length > 0) {
    await assertDeletionOwner(env.USAGE_MONITOR_DB, participantId, deletionFence);
    await env.QUARANTINE.delete(contributions.map((row) => row.r2_key));
  }
  let cursor: { createdAt: string; contributionId: string } | null = null;
  do {
    const page = await telemetryContributionR2KeyPage(env.USAGE_MONITOR_DB, participantId, cursor);
    if (page.rows.length > 0) {
      await assertDeletionOwner(env.USAGE_MONITOR_DB, participantId, deletionFence);
      await env.QUARANTINE.delete(page.rows.map((row) => row.r2Key));
    }
    cursor = page.nextCursor;
  } while (cursor);
  let chunkCursor: { createdAt: string; chunkRowId: string } | null = null;
  do {
    const page = await telemetryV1ChunkR2KeyPage(env.USAGE_MONITOR_DB, participantId, chunkCursor);
    if (page.rows.length > 0) {
      await assertDeletionOwner(env.USAGE_MONITOR_DB, participantId, deletionFence);
      await env.QUARANTINE.delete(page.rows.map((row) => row.r2Key));
    }
    chunkCursor = page.nextCursor;
  } while (chunkCursor);
  let stagedCursor: { createdAt: string; chunkRowId: string } | null = null;
  do {
    const page = await telemetryV11ChunkR2KeyPage(env.USAGE_MONITOR_DB, participantId, stagedCursor);
    if (page.rows.length > 0) {
      await assertDeletionOwner(env.USAGE_MONITOR_DB, participantId, deletionFence);
      await env.QUARANTINE.delete(page.rows.map((row) => row.r2Key));
    }
    stagedCursor = page.nextCursor;
  } while (stagedCursor);
  const currentTelemetryTotal = await telemetryContributionCount(env.USAGE_MONITOR_DB, participantId);
  const currentTelemetryV1Total = await telemetryV1ChunkCount(env.USAGE_MONITOR_DB, participantId);
  const currentTelemetryV11Total = await telemetryV11ChunkCount(env.USAGE_MONITOR_DB, participantId);
  if (currentTelemetryTotal !== telemetryTotal || currentTelemetryV1Total !== telemetryV1Total
      || currentTelemetryV11Total !== telemetryV11Total) {
    throw new ApiError(409, "UPLOAD_IN_PROGRESS");
  }
  await finishParticipantDeletion(env.USAGE_MONITOR_DB, participantId, deletionFence);
  return {
    deleted: true,
    alreadyDeleted: false,
    contributionsDeleted: contributions.length + telemetryTotal + telemetryV1Total + telemetryV11Total,
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
