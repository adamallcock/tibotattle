import { projectAdminModelHistoryDay } from '@app-usagemonitor/telemetry-contract';
import { sha256Hex } from './crypto';
import { sameStorageCommunityAuthority, type StorageCommunityAuthority } from './storage-community-authority';

export interface StorageModelPublicationValue {
  day: string;
  authority_json: string;
  payload_json: string;
  payload_sha256: string;
}

/** A corrupt derived row is unfinished work, not a permanently completed day.
 * The schema limits each payload to 16 KiB; callers bound the history window. */
export async function validStorageModelPublication(row: StorageModelPublicationValue,
  authority: StorageCommunityAuthority): Promise<boolean> {
  try {
    const recorded = JSON.parse(row.authority_json) as StorageCommunityAuthority;
    if (!sameStorageCommunityAuthority(recorded, authority)
        || !Number.isSafeInteger(recorded.sourceEpoch) || recorded.sourceEpoch < 0
        || recorded.sourceEpoch > authority.sourceEpoch
        || !Number.isSafeInteger(recorded.sequence) || recorded.sequence < 0
        || recorded.sequence > authority.sequence
        || new TextEncoder().encode(row.payload_json).byteLength > 16 * 1024
        || await sha256Hex(row.payload_json) !== row.payload_sha256) return false;
    const value = projectAdminModelHistoryDay(JSON.parse(row.payload_json));
    return value !== null && value.day === row.day;
  } catch {
    return false;
  }
}
