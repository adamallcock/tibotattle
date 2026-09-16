import {
  prepareStorageParticipantErasure,
  requireStorageParticipantErasureComplete,
  storageErasureBindings,
} from "./storage-erasure";
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
import { revokeAccountlessEnrollment } from "./accountless-enrollment";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  createD1ParticipantErasureLedger,
  createD1ParticipantErasureStore,
} from "./d1-participant-erasure-store";
import { createQuarantineParticipantErasureObjectStore } from "./erasure-object-store";
import { assertPinnedIdentityLinkSecretConfiguration } from "./identity-link-configuration";
import { identityRequired } from "./identity-oidc";
import {
  identityReenrollmentCooldownDigest,
  recordIdentityReenrollmentCooldownFromDigest,
  recordPrimaryIdentityReenrollmentCooldown,
} from "./retention";
import {
  eraseParticipantWithStore,
  type ParticipantErasureDependencies,
  type ParticipantErasureResult,
} from "./participant-erasure-store";
import type { QuarantineObjectStore } from "./quarantine-object-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTICIPANT_ID_PATTERN = new RegExp(`^participant:${UUID_PATTERN.source.slice(1)}`, "u");
const AUDIT_TARGET_DOMAIN = "app-usagemonitor/admin-participant-erasure/v1\0";

type ErasureResult = ParticipantErasureResult;

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
  quarantine: QuarantineObjectStore,
  participantId: string,
  operationId: string,
): Promise<ErasureResult> {
  const storage = await storageErasureBindings(env);
  const dependencies: ParticipantErasureDependencies = {
    primary: createD1ParticipantErasureStore(env.USAGE_MONITOR_DB),
    ledger: createD1ParticipantErasureLedger(env.DELETION_LEDGER),
    objects: createQuarantineParticipantErasureObjectStore(quarantine),
    hooks: {
      revokeAccountlessEnrollment: async (enrollmentDeviceId) => {
        await revokeAccountlessEnrollment(
          env.USAGE_MONITOR_DB,
          enrollmentDeviceId,
          "security_reset",
        );
      },
      assertIdentityConfiguration: async () => {
        if (identityRequired(env)) {
          await assertPinnedIdentityLinkSecretConfiguration(
            env.USAGE_MONITOR_DB,
            Reflect.get(env, "IDENTITY_LINK_SECRET"),
            Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
          );
        }
      },
      recordIdentityCooldown: async (identityLinkKey) => {
        const secret: unknown = Reflect.get(env, "IDENTITY_LINK_SECRET");
        if (typeof secret !== "string" || secret.length < 32) {
          if (identityRequired(env)) throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
          return;
        }
        const digest = await identityReenrollmentCooldownDigest(secret, identityLinkKey);
        await recordPrimaryIdentityReenrollmentCooldown(env.USAGE_MONITOR_DB, digest);
        await recordIdentityReenrollmentCooldownFromDigest(env.DELETION_LEDGER, digest);
      },
      afterLedgerTombstone: async () => {
        if (storage !== null) {
          await prepareStorageParticipantErasure(storage, participantId);
        }
      },
      afterPrimaryFinish: async () => {
        await requireStorageParticipantErasureComplete(
          env.DELETION_LEDGER,
          participantId,
          storage,
        );
      },
      afterAlreadyDeleted: async () => {
        await requireStorageParticipantErasureComplete(
          env.DELETION_LEDGER,
          participantId,
          storage,
        );
      },
    },
  };
  return eraseParticipantWithStore(dependencies, participantId, operationId);
}

/** Not a participant API: the caller must have passed the existing admin gate. */
export async function eraseParticipantAsOwner(
  env: Env,
  actorIdentityKey: string,
  participantId: string,
  quarantine: QuarantineObjectStore,
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
    const result = await eraseParticipantData(env, quarantine, participantId, operationId);
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
