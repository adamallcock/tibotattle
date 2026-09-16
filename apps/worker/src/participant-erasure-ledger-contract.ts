import { sha256Hex } from "./content-digest";

export const DELETION_TOMBSTONE_RETENTION_MILLISECONDS = 400 * 24 * 60 * 60 * 1_000;
const DELETION_DIGEST_DOMAIN = "app-usagemonitor/deletion-tombstone/v1\0";

/** Stable purpose-separated ledger identity shared by every storage adapter. */
export async function participantDeletionDigest(participantId: string): Promise<string> {
  return sha256Hex(`${DELETION_DIGEST_DOMAIN}${participantId}`);
}
