import { QUARANTINE_RETENTION_MILLISECONDS } from "./constants";

export interface ContributionQuarantineLifecycle {
  state: "retained" | "deleted";
  scheduledDeletionAt: string;
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
    scheduledDeletionAt: new Date(
      createdEpoch + QUARANTINE_RETENTION_MILLISECONDS,
    ).toISOString(),
    deletedAt: deletedAt ?? null,
    canonicalMetadataRetained: true,
  };
}
