import { ApiError } from "./errors";
import {
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectPage,
  type ParticipantErasureObjectSource,
  type ParticipantErasureObjectStore,
} from "./erasure-object-store";
export type {
  ParticipantErasureObjectPage,
  ParticipantErasureObjectSource,
} from "./erasure-object-store";

/** The bounded state used by the owner-only erasure workflow. */
export interface ParticipantErasureTarget {
  readonly state: "active" | "deleting";
  readonly deletionFence: string | null;
  readonly ownerKind: "social" | "accountless";
  readonly enrollmentDeviceId: string | null;
}

export interface ParticipantErasureCounts {
  readonly synthetic: number;
  readonly telemetry: number;
  readonly telemetryV1: number;
  readonly telemetryV11: number;
}

export interface ParticipantErasurePrimaryStore {
  readParticipant(participantId: string): Promise<ParticipantErasureTarget | null>;
  /** Claim a fresh or expired deletion attempt and return its fence. */
  claimDeletion(
    participantId: string,
    target: ParticipantErasureTarget,
    operationId: string,
    nowEpoch: number,
  ): Promise<string>;
  assertOwner(participantId: string, deletionFence: string): Promise<void>;
  revokeLegacySessions(participantId: string, deletionFence: string, nowEpoch: number): Promise<void>;
  identityLinkKey(participantId: string, deletionFence: string): Promise<string | null>;
  countObjects(participantId: string): Promise<ParticipantErasureCounts>;
  listObjectPage(
    participantId: string,
    source: ParticipantErasureObjectSource,
    cursor: { readonly createdAt: string; readonly id: string } | null,
    limit: number,
  ): Promise<ParticipantErasureObjectPage>;
  finish(participantId: string, deletionFence: string): Promise<void>;
}

/** This capability must be backed by an authority separate from the primary DB. */
export interface ParticipantErasureLedgerStore {
  hasTombstone(participantId: string, nowEpoch: number): Promise<boolean>;
  recordTombstone(participantId: string, nowEpoch: number): Promise<void>;
}

/** Domain hooks keep accountless authority and identity cooldown policy explicit. */
export interface ParticipantErasureHooks {
  revokeAccountlessEnrollment(enrollmentDeviceId: string): Promise<void>;
  assertIdentityConfiguration(): Promise<void>;
  recordIdentityCooldown(identityLinkKey: string): Promise<void>;
  /**
   * Called immediately after the independent deletion tombstone is durable
   * and before any primary rows or provider objects are removed.
   */
  afterLedgerTombstone?(): Promise<void>;
  /**
   * Called after the primary participant state is finalized. Implementations
   * use this to require completion of any separately persisted projections.
   */
  afterPrimaryFinish?(): Promise<void>;
  /** Called when a retry finds only the durable deletion tombstone. */
  afterAlreadyDeleted?(): Promise<void>;
}

export interface ParticipantErasureDependencies {
  readonly primary: ParticipantErasurePrimaryStore;
  readonly ledger: ParticipantErasureLedgerStore;
  readonly objects: ParticipantErasureObjectStore;
  readonly hooks: ParticipantErasureHooks;
  readonly maxObjectPages?: number;
}

export type ParticipantErasureResult =
  | { readonly deleted: true; readonly alreadyDeleted: false; readonly contributionsDeleted: number }
  | { readonly deleted: true; readonly alreadyDeleted: true; readonly contributionsDeleted: null };

const SOURCES: readonly ParticipantErasureObjectSource[] = [
  "synthetic",
  "telemetry",
  "telemetry_v1",
  "telemetry_v11",
];
const DEFAULT_MAX_OBJECT_PAGES = 1_000;

function validEpoch(value: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new TypeError("invalid participant erasure time");
  }
}

function validCounts(value: ParticipantErasureCounts): void {
  for (const count of [value.synthetic, value.telemetry, value.telemetryV1, value.telemetryV11]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
  }
  if (!Number.isSafeInteger(
    value.synthetic + value.telemetry + value.telemetryV1 + value.telemetryV11,
  )) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

function sourceCount(counts: ParticipantErasureCounts, source: ParticipantErasureObjectSource): number {
  switch (source) {
    case "synthetic": return counts.synthetic;
    case "telemetry": return counts.telemetry;
    case "telemetry_v1": return counts.telemetryV1;
    case "telemetry_v11": return counts.telemetryV11;
  }
}

function cursorValue(value: string): { readonly epoch: number; readonly id: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return { epoch, id: value };
}

function cursorAfter(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): boolean {
  const leftValue = cursorValue(left.createdAt);
  const rightValue = cursorValue(right.createdAt);
  return leftValue.epoch > rightValue.epoch
    || (leftValue.epoch === rightValue.epoch && left.id > right.id);
}

function cursorBefore(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): boolean {
  return cursorAfter(right, left);
}

/**
 * Run the destructive half of owner erasure after the route has authenticated
 * Access-owner and CSRF. The ledger write is deliberately before the first
 * provider delete. Pages are keyset ordered and replay-safe: a failed attempt
 * can restart from the beginning, where already-deleted keys are harmless.
 */
export async function eraseParticipantWithStore(
  dependencies: ParticipantErasureDependencies,
  participantId: string,
  operationId: string,
  nowEpoch = Date.now(),
): Promise<ParticipantErasureResult> {
  validEpoch(nowEpoch);
  if (typeof participantId !== "string" || participantId.length === 0
      || typeof operationId !== "string" || operationId.length === 0) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const maxObjectPages = dependencies.maxObjectPages ?? DEFAULT_MAX_OBJECT_PAGES;
  if (!Number.isSafeInteger(maxObjectPages) || maxObjectPages < 1) {
    throw new TypeError("invalid participant erasure page bound");
  }

  const target = await dependencies.primary.readParticipant(participantId);
  if (target === null) {
    if (!await dependencies.ledger.hasTombstone(participantId, nowEpoch)) {
      throw new ApiError(404, "NOT_FOUND");
    }
    await dependencies.hooks.afterAlreadyDeleted?.();
    return { deleted: true, alreadyDeleted: true, contributionsDeleted: null };
  }
  if (target.state !== "active" && target.state !== "deleting") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (target.ownerKind === "accountless" && target.enrollmentDeviceId !== null) {
    await dependencies.hooks.revokeAccountlessEnrollment(target.enrollmentDeviceId);
  }
  await dependencies.hooks.assertIdentityConfiguration();

  const deletionFence = await dependencies.primary.claimDeletion(
    participantId,
    target,
    operationId,
    nowEpoch,
  );
  await dependencies.primary.assertOwner(participantId, deletionFence);
  await dependencies.primary.revokeLegacySessions(participantId, deletionFence, nowEpoch);

  // This is the deletion safety boundary. A primary DB row may disappear
  // after a crash, so the independent ledger must be durable before objects
  // or rows are destroyed.
  await dependencies.ledger.recordTombstone(participantId, nowEpoch);
  await dependencies.hooks.afterLedgerTombstone?.();
  const identityLinkKey = await dependencies.primary.identityLinkKey(
    participantId,
    deletionFence,
  );
  if (identityLinkKey !== null) {
    await dependencies.hooks.recordIdentityCooldown(identityLinkKey);
  }

  const initialCounts = await dependencies.primary.countObjects(participantId);
  validCounts(initialCounts);
  let pages = 0;
  for (const source of SOURCES) {
    let cursor: { readonly createdAt: string; readonly id: string } | null = null;
    let processed = 0;
    const seenIds = new Set<string>();
    do {
      if (++pages > maxObjectPages) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      const page = await dependencies.primary.listObjectPage(
        participantId,
        source,
        cursor,
        PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
      );
      if (!Array.isArray(page.objects)
          || page.objects.length > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      if (page.nextCursor !== null
          && (typeof page.nextCursor !== "object"
            || typeof page.nextCursor.createdAt !== "string"
            || typeof page.nextCursor.id !== "string"
            || page.nextCursor.id.length === 0)) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      let previous = cursor;
      for (const object of page.objects) {
        if (object === null || typeof object !== "object"
            || object.source !== source
            || typeof object.id !== "string" || object.id.length === 0
            || typeof object.createdAt !== "string"
            || !cursorAfter(object, previous ?? { createdAt: "1970-01-01T00:00:00.000Z", id: "" })
            || seenIds.has(object.id)) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
        seenIds.add(object.id);
        previous = { createdAt: object.createdAt, id: object.id };
      }
      processed += page.objects.length;
      if (processed > sourceCount(initialCounts, source)) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      if (page.objects.length === PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT && page.nextCursor === null) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      if (page.objects.length < PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT && page.nextCursor !== null) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      if (page.nextCursor !== null) {
        if (cursor !== null && !cursorAfter(page.nextCursor, cursor)) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
        // The adapter must advance beyond the final row it just returned. A
        // repeated cursor would otherwise let a truncated page finalize while
        // the source count remains unchanged.
        const last = page.objects.at(-1);
        if (last === undefined || cursorBefore(page.nextCursor, last)) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
      }
      if (page.objects.length > 0) {
        await dependencies.primary.assertOwner(participantId, deletionFence);
        await dependencies.objects.deleteBatch(page.objects);
        // A lease can be fenced while an external delete is in flight. It is
        // too late to undo that delete, but refusing finalization preserves
        // the primary row for an owner retry and prevents a stale caller from
        // deleting database state.
        await dependencies.primary.assertOwner(participantId, deletionFence);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (processed !== sourceCount(initialCounts, source)) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
  }

  const finalCounts = await dependencies.primary.countObjects(participantId);
  validCounts(finalCounts);
  if (finalCounts.synthetic !== initialCounts.synthetic
      || finalCounts.telemetry !== initialCounts.telemetry
      || finalCounts.telemetryV1 !== initialCounts.telemetryV1
      || finalCounts.telemetryV11 !== initialCounts.telemetryV11) {
    throw new ApiError(409, "UPLOAD_IN_PROGRESS");
  }
  await dependencies.primary.finish(participantId, deletionFence);
  await dependencies.hooks.afterPrimaryFinish?.();
  const contributionsDeleted = initialCounts.synthetic
    + initialCounts.telemetry
    + initialCounts.telemetryV1
    + initialCounts.telemetryV11;
  return {
    deleted: true,
    alreadyDeleted: false,
    contributionsDeleted,
  };
}
