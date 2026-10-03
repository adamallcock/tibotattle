/**
 * analytics-v2 contributing-device counts (A-1): a PostgreSQL port of d43c8f92
 * storage-community-daily-devices.ts countStorageDailyContributingDevices,
 * method 'contributing-devices-by-reader-v1', for the effective reader.
 *
 * For each contributing owner and observed day it counts the distinct device
 * credentials whose accepted, non-empty evidence the effective (v1/v1.1/v1.2
 * union) reader reads that day:
 *   - v1: every owner-linked current chunk of the day that is fully accepted
 *     and holds more than zero records;
 *   - v1.1: every owner-linked retained generation with a ready manifest for
 *     the day that has a nonempty chunk from the generation's device;
 *   - v1.2: every generation with a ready manifest for the day that has a
 *     complete nonempty chunk and whose device is in the retained
 *     authorization scope at the pinned nowMs.
 * A contributing owner counts at least one device. Only counts leave this
 * module. Production's other two branches (the v1.1 projection's head-only
 * read and the v1 projection's elected winner) belong to non-effective
 * owners, which the fast path refuses (non_effective_source_unported); such
 * a member is refused here rather than counted by the wrong rule.
 */

import type { AnalyticsV2Day, AnalyticsV2Owner, AnalyticsV2OwnerDigest } from "./contract";
import {
  analyticsV2Statement,
  dayFromNumber,
  dayNumber,
  nowTimestamp,
  onReadSnapshot,
  quotedSchema,
  sourceFail,
  v12RetainedAuthorizationScopeSql,
  type AnalyticsV2SnapshotContext,
} from "./owners";

/** Versioned meaning of the public contributingDevices total (production's). */
export const ANALYTICS_V2_DAILY_DEVICE_METHOD = "contributing-devices-by-reader-v1" as const;

export interface CountContributingDevicesOptions {
  /** Contributing owners per observed day (owners whose day fold is nonempty). */
  readonly days: ReadonlyMap<AnalyticsV2Day, readonly Pick<AnalyticsV2Owner, "participantId" | "ownerDigest" | "source">[]>;
}

const MAX_DAYS = 4_096;
const MAX_MEMBERS_PER_DAY = 100_000;

function devicesSql(s: string): string {
  return `WITH members AS MATERIALIZED (
      SELECT member.owner_digest,member.participant_id,member.day::date AS day
        FROM jsonb_to_recordset($1::jsonb) AS member(owner_digest text,participant_id text,day text)
    )
    SELECT to_char(m.day,'YYYY-MM-DD') AS day,m.owner_digest,chunk.device_id FROM members m
      JOIN ${s}.typed_v1_event_sources event ON event.participant_id=m.participant_id
       AND event.owner_digest=m.owner_digest
      JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=event.chunk_id AND chunk.participant_id=m.participant_id
     WHERE chunk.chunk_day=m.day AND chunk.superseded_at IS NULL AND chunk.accepted_record_count>0
       AND chunk.accepted_record_count=chunk.record_count
    UNION
    SELECT to_char(m.day,'YYYY-MM-DD'),m.owner_digest,generation.device_id FROM members m
      JOIN ${s}.storage_v11_event_sources event ON event.owner_digest=m.owner_digest
       AND event.participant_id=m.participant_id
      JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
       AND generation.participant_id=m.participant_id AND generation.manifest_digest=event.manifest_digest
      JOIN ${s}.telemetry_v11_domain_days domain_day ON domain_day.generation_id=generation.id
       AND domain_day.observed_day=m.day
      JOIN ${s}.telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
     WHERE EXISTS (SELECT 1 FROM ${s}.telemetry_v11_chunks chunk WHERE chunk.manifest_id=manifest.id
       AND chunk.device_id=generation.device_id AND chunk.record_count>0)
    UNION
    SELECT to_char(m.day,'YYYY-MM-DD'),m.owner_digest,generation.device_id FROM members m
      JOIN ${s}.telemetry_v12_domains generation ON generation.participant_id=m.participant_id
      JOIN ${s}.telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
       AND domain_day.observed_day=m.day
      JOIN ${s}.telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
       AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
       AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest
       AND manifest.state='ready'
      JOIN (${v12RetainedAuthorizationScopeSql(s, "$2::timestamptz", "community")}) retained
        ON retained.participant_id=generation.participant_id AND retained.device_id=generation.device_id
     WHERE EXISTS (SELECT 1 FROM ${s}.telemetry_v12_chunks chunk WHERE chunk.manifest_id=manifest.id
       AND chunk.record_count>0
       AND chunk.record_count=(SELECT count(*) FROM ${s}.telemetry_v12_typed_records complete
         WHERE complete.chunk_id=chunk.id))`;
}

/**
 * Count contributing devices per day and owner. Returns, for every requested
 * day, a map of owner digest to max(1, distinct devices).
 */
export async function countContributingDevices(
  context: AnalyticsV2SnapshotContext,
  options: CountContributingDevicesOptions,
): Promise<Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, number>>> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  if (!options || !(options.days instanceof Map) || options.days.size > MAX_DAYS) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  const members: { owner_digest: string; participant_id: string; day: string }[] = [];
  const devices = new Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, Set<string>>>();
  for (const [day, owners] of options.days) {
    dayFromNumber(dayNumber(day));
    if (!Array.isArray(owners) || owners.length > MAX_MEMBERS_PER_DAY) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
    const byOwner = new Map<AnalyticsV2OwnerDigest, Set<string>>();
    for (const owner of owners) {
      if (!owner || typeof owner.ownerDigest !== "string" || !/^[0-9a-f]{64}$/u.test(owner.ownerDigest)
          || typeof owner.participantId !== "string" || byOwner.has(owner.ownerDigest)) {
        sourceFail("ANALYTICS_V2_SOURCE_INVALID");
      }
      if (owner.source !== "effective") sourceFail("ANALYTICS_V2_SOURCE_INVALID");
      byOwner.set(owner.ownerDigest, new Set());
      members.push({ owner_digest: owner.ownerDigest, participant_id: owner.participantId, day });
    }
    devices.set(day, byOwner);
  }
  return onReadSnapshot(context, async (client) => {
    if (members.length > 0) {
      const result = await client.query<{ day: unknown; owner_digest: unknown; device_id: unknown }>(
        analyticsV2Statement("devices.count", devicesSql(s)), [JSON.stringify(members), now]);
      for (const row of result.rows) {
        const set = typeof row.day === "string" && typeof row.owner_digest === "string"
          ? devices.get(row.day)?.get(row.owner_digest) : undefined;
        if (!set || typeof row.device_id !== "string") sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
        set.add(row.device_id);
      }
    }
    return new Map([...devices].map(([day, byOwner]) => [day,
      new Map([...byOwner].map(([ownerDigest, set]) => [ownerDigest, Math.max(1, set.size)]))]));
  });
}
