import { sha256Hex } from "./crypto";

const DELETION_DIGEST_DOMAIN = "app-usagemonitor/deletion-tombstone/v1\0";

/** Purpose-separated identity shared by ledger and cleanup; no lifecycle dependencies. */
export async function participantDeletionDigest(
  participantId: string,
): Promise<string> {
  return sha256Hex(`${DELETION_DIGEST_DOMAIN}${participantId}`);
}
