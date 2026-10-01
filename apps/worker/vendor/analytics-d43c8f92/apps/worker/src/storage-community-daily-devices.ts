import { MAX_V1_SOURCE_CHUNKS, selectV1WinningDevices, type V1SourceChunk } from './telemetry-v1-source-selection';
import { V12_RETAINED_AUTHORIZATION_SCOPE, type StorageCommunityOwner } from './storage-community-authority';

/** Versioned meaning of the public `contributingDevices` total. A day
 * published under another method is recounted once. */
export const STORAGE_DAILY_DEVICE_METHOD = 'contributing-devices-by-reader-v1';
const unavailable = () => new Error('STORAGE_COMMUNITY_DAILY_DEVICES_UNAVAILABLE');

export interface DailyDeviceMember { owner: StorageCommunityOwner; effective: boolean }

/** Distinct device credentials whose accepted, non-empty evidence each
 * contributing owner's day fold reads, following the same source selection as
 * that owner's reader:
 * - the effective (v1/v1.1/v1.2 union) reader reads every owner-linked current
 *   v1 chunk, every owner-linked retained v1.1 generation and every retained
 *   v1.2 device generation, reconciling by occurrence, never by device;
 * - the v1.1 projection reads the participant's current head only;
 * - the v1 projection reads the day's single elected winner device.
 * Only counts leave this function; a contributing owner is at least one device. */
export async function countStorageDailyContributingDevices(source: D1Database, observedDay: string,
  members: readonly DailyDeviceMember[]): Promise<Map<string, number>> {
  const devices = new Map<string, Set<string>>();
  for (const { owner } of members) {
    if (!owner.ownerDigest) throw unavailable();
    devices.set(owner.ownerDigest, new Set());
  }
  const add = (ownerDigest: unknown, deviceId: unknown) => {
    if (typeof ownerDigest !== 'string' || typeof deviceId !== 'string') throw unavailable();
    const set = devices.get(ownerDigest);
    if (!set) throw unavailable();
    set.add(deviceId);
  };
  const pairs = (selected: readonly DailyDeviceMember[]) =>
    JSON.stringify(selected.map(({ owner }) => [owner.ownerDigest, owner.participantId]));
  const effective = members.filter(member => member.effective);
  const v11 = members.filter(member => !member.effective && member.owner.hasV11);
  const v1 = members.filter(member => !member.effective && !member.owner.hasV11);
  if (effective.length) {
    const list = pairs(effective);
    const rows = (await source.prepare(`WITH members AS MATERIALIZED (
        SELECT json_extract(value,'$[0]') AS owner_digest, json_extract(value,'$[1]') AS participant_id FROM json_each(?1))
      SELECT m.owner_digest, chunk.device_id FROM members m
        JOIN typed_v1_event_sources event ON event.participant_id=m.participant_id AND event.owner_digest=m.owner_digest
        JOIN telemetry_v1_chunks chunk ON chunk.id=event.chunk_id AND chunk.participant_id=m.participant_id
       WHERE chunk.chunk_day=?2 AND chunk.superseded_at IS NULL AND chunk.accepted_record_count>0
         AND chunk.accepted_record_count=chunk.record_count
      UNION
      SELECT m.owner_digest, generation.device_id FROM members m
        JOIN storage_v11_event_sources event ON event.owner_digest=m.owner_digest AND event.participant_id=m.participant_id
        JOIN telemetry_v11_domains generation ON generation.id=event.generation_id
         AND generation.participant_id=m.participant_id AND generation.manifest_digest=event.manifest_digest
        JOIN telemetry_v11_domain_days domain_day ON domain_day.generation_id=generation.id AND domain_day.observed_day=?2
        JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
       WHERE EXISTS (SELECT 1 FROM telemetry_v11_chunks chunk WHERE chunk.manifest_id=manifest.id
         AND chunk.device_id=generation.device_id AND chunk.record_count>0)`)
      .bind(list, observedDay).all<{ owner_digest: string; device_id: string }>()).results;
    for (const row of rows) add(row.owner_digest, row.device_id);
    // The successor tables exist only after its migration; absence is no evidence.
    let successor: Array<{ owner_digest: string; device_id: string }> = [];
    try {
      successor = (await source.prepare(`WITH members AS MATERIALIZED (
          SELECT json_extract(value,'$[0]') AS owner_digest, json_extract(value,'$[1]') AS participant_id FROM json_each(?1))
        SELECT DISTINCT m.owner_digest, generation.device_id FROM members m
          JOIN telemetry_v12_domains generation ON generation.participant_id=m.participant_id
          JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id AND domain_day.observed_day=?2
          JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
           AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
           AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest
           AND manifest.state='ready'
          JOIN (${V12_RETAINED_AUTHORIZATION_SCOPE}) authorization
           ON authorization.participant_id=generation.participant_id AND authorization.device_id=generation.device_id
         WHERE EXISTS (SELECT 1 FROM telemetry_v12_chunks chunk WHERE chunk.manifest_id=manifest.id AND chunk.record_count>0
           AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id))`)
        .bind(list, observedDay).all<{ owner_digest: string; device_id: string }>()).results;
    } catch (error) {
      if (!/no such table|no such view/iu.test(String(error))) throw error;
    }
    for (const row of successor) add(row.owner_digest, row.device_id);
  }
  if (v11.length) {
    const rows = (await source.prepare(`WITH members AS MATERIALIZED (
        SELECT json_extract(value,'$[0]') AS owner_digest, json_extract(value,'$[1]') AS participant_id FROM json_each(?1))
      SELECT m.owner_digest, generation.device_id FROM members m
        JOIN telemetry_v11_domain_heads head ON head.participant_id=m.participant_id
        JOIN telemetry_v11_domains generation ON generation.id=head.generation_id AND generation.participant_id=m.participant_id
        JOIN telemetry_v11_domain_days domain_day ON domain_day.generation_id=generation.id AND domain_day.observed_day=?2
       WHERE EXISTS (SELECT 1 FROM telemetry_v11_chunks chunk WHERE chunk.manifest_id=domain_day.manifest_id
         AND chunk.record_count>0)`)
      .bind(pairs(v11), observedDay).all<{ owner_digest: string; device_id: string }>()).results;
    for (const row of rows) add(row.owner_digest, row.device_id);
  }
  if (v1.length) {
    const byParticipant = new Map(v1.map(({ owner }) => [owner.participantId, owner.ownerDigest!]));
    const chunks = (await source.prepare(`SELECT c.id,c.participant_id,c.device_id,c.chunk_day,c.stream,c.revision,
        c.chunk_digest,c.parser_version,c.accepted_record_count,c.created_at
      FROM telemetry_analytical_chunks c WHERE c.participant_id IN (SELECT value FROM json_each(?))
        AND c.chunk_day=? AND c.accepted_record_count>0 ORDER BY c.participant_id,c.device_id,c.id LIMIT ?`)
      .bind(JSON.stringify([...byParticipant.keys()]), observedDay, MAX_V1_SOURCE_CHUNKS + 1).all<V1SourceChunk>()).results;
    if (chunks.length > MAX_V1_SOURCE_CHUNKS) throw unavailable();
    for (const winner of selectV1WinningDevices(chunks)) add(byParticipant.get(winner.participant_id), winner.device_id);
  }
  return new Map([...devices].map(([ownerDigest, set]) => [ownerDigest, Math.max(1, set.size)]));
}
