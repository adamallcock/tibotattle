import { QUARANTINE_RETENTION_MILLISECONDS } from "./constants";

export interface ContributionQuarantineLifecycle {
  state: "retained" | "deleted";
  /**
   * `null` when no age-based deletion is scheduled. A participant reading this
   * must be told the envelope is kept, not shown a date that never arrives.
   */
  scheduledDeletionAt: string | null;
  deletedAt: string | null;
  canonicalMetadataRetained: true;
}

export function contributionQuarantineLifecycle(
  createdAt: string,
  deletedAt: string | null | undefined,
): ContributionQuarantineLifecycle {
  const createdEpoch = Date.parse(createdAt);
  const deletedEpoch = deletedAt ? Date.parse(deletedAt) : null;
  if (!Number.isFinite(createdEpoch)
      || (deletedEpoch !== null
        && (!Number.isFinite(deletedEpoch) || deletedEpoch < createdEpoch))) {
    throw new TypeError("invalid contribution lifecycle timestamp");
  }
  return {
    state: deletedAt ? "deleted" : "retained",
    scheduledDeletionAt: QUARANTINE_RETENTION_MILLISECONDS === null
      ? null
      : new Date(
        createdEpoch + QUARANTINE_RETENTION_MILLISECONDS,
      ).toISOString(),
    deletedAt: deletedAt ?? null,
    canonicalMetadataRetained: true,
  };
}
