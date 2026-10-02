import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { CANONICAL_INPUT_MEMBERSHIP_SCHEMA, CANONICAL_INPUT_MEMBERSHIP_METHOD,
 type CanonicalSourceMembershipReader } from './storage-canonical-analytics-input';
import { MAX_V1_SOURCE_CHUNKS, selectV1WinningDevices, type V1SourceChunk } from './telemetry-v1-source-selection';
import { V12_RETAINED_AUTHORIZATION_SCOPE, readStorageCommunityOwner, type StorageCommunityOwner } from './storage-community-authority';

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
async function readNativeDeviceMembership(source: D1Database, observedDay: string,
  members: readonly DailyDeviceMember[],maxSelectedRows=-1): Promise<Map<string, Set<string>>> {
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
         AND chunk.device_id=generation.device_id AND chunk.record_count>0) LIMIT ?3`)
      .bind(list, observedDay,maxSelectedRows).all<{ owner_digest: string; device_id: string }>()).results;
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
           AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id)) LIMIT ?3`)
        .bind(list, observedDay,maxSelectedRows).all<{ owner_digest: string; device_id: string }>()).results;
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
  return devices;
}


export async function countStorageDailyContributingDevices(source:D1Database,observedDay:string,
 members:readonly DailyDeviceMember[]):Promise<Map<string,number>> {
 const devices=await readNativeDeviceMembership(source,observedDay,members);
 return new Map([...devices].map(([ownerDigest,set])=>[ownerDigest,Math.max(1,set.size)]));
}

/** Credential identities remain source-private. This adapter follows the actual
 * native reader's selected day, including retained effective generations; it
 * never infers devices from canonical occurrence variants. The 128-key proof
 * contract has an explicit unavailable result above its bound. */
export const readStorageCanonicalSourceMembership:CanonicalSourceMembershipReader=async(source,identity)=>{
 const owner=await readStorageCommunityOwner(source,{ownerDigest:identity.ownerDigest});
 if(!owner||owner.participantId!==identity.participantId||owner.ownerRevision!==identity.ownerRevision
   ||owner.authorityEpoch!==identity.authorityEpoch)return null;
 const effective=identity.selectionMethod==='effective-union-v1';
 const selected=await readNativeDeviceMembership(source,identity.day,[{owner,effective}],129);
 const credentials=selected.get(identity.ownerDigest);
 if(!credentials||credentials.size>128)return null;
 const contributorKey=await sha256Hex(canonicalJson(['canonical-native-contributor-v1',identity.sourceNamespace,identity.ownerDigest]));
 const deviceKeys=(await Promise.all([...credentials].map(credential=>sha256Hex(canonicalJson(
   ['canonical-native-device-v1',identity.sourceNamespace,identity.ownerDigest,credential]))))).sort();
 const current=await readStorageCommunityOwner(source,{ownerDigest:identity.ownerDigest});
 if(!current||current.participantId!==identity.participantId||current.ownerRevision!==owner.ownerRevision
   ||current.authorityEpoch!==owner.authorityEpoch)return null;
 return {schema:CANONICAL_INPUT_MEMBERSHIP_SCHEMA,method:CANONICAL_INPUT_MEMBERSHIP_METHOD,
   contributorKey,deviceKeys,dependencyRevision:await sha256Hex(canonicalJson({
    method:STORAGE_DAILY_DEVICE_METHOD,day:identity.day,selectionMethod:identity.selectionMethod,
    contributorKey,deviceKeys})),sourceDay:identity.day,selectionMethod:identity.selectionMethod,
   sourceToken:identity.sourceStamp,coverage:'complete'};
};

/** Maintained source-selected credential sets were sealed independently of
 * quantity arithmetic. Count their exact union for the same owner/day reader;
 * missing membership defers instead of reporting zero or recounting source. */
export async function readCanonicalDailyDeviceCounts(target:D1Database,sourceId:string,observedDay:string,
 members:readonly DailyDeviceMember[]):Promise<Map<string,number>|null> {
 if(!members.length)return new Map();
 const requested=JSON.stringify(members.map(({owner,effective})=>({ownerDigest:owner.ownerDigest,
  selectionMethod:effective?'effective-union-v1':'legacy-selected-v1'})));
 const rows=(await target.prepare(`WITH selected AS MATERIALIZED(
  SELECT f.owner_digest,f.revision FROM json_each(?1) wanted JOIN analytics_canonical_facts f
   ON f.source_id=?2 AND f.owner_digest=json_extract(wanted.value,'$.ownerDigest') AND f.observed_day=?3
   AND f.selection_method=json_extract(wanted.value,'$.selectionMethod')
  JOIN analytics_canonical_heads h ON h.revision=f.revision), complete AS MATERIALIZED(
  SELECT s.owner_digest,s.revision,m.device_keys_json FROM selected s LEFT JOIN analytics_canonical_feature_membership m
   ON m.fact_revision=s.revision AND m.method=?4)
 SELECT json_extract(w.value,'$.ownerDigest') owner_digest,
 (SELECT count(*) FROM selected s WHERE s.owner_digest=json_extract(w.value,'$.ownerDigest')) fact_count,
 (SELECT count(*) FROM complete c WHERE c.owner_digest=json_extract(w.value,'$.ownerDigest') AND c.device_keys_json IS NULL) missing,
 (SELECT count(DISTINCT d.value) FROM complete c,json_each(c.device_keys_json) d
  WHERE c.owner_digest=json_extract(w.value,'$.ownerDigest')) device_count FROM json_each(?1) w`)
  .bind(requested,sourceId,observedDay,STORAGE_DAILY_DEVICE_METHOD)
  .all<{owner_digest:string;fact_count:number;missing:number;device_count:number}>()).results;
 if(rows.length!==members.length||rows.some(row=>row.fact_count===0||row.missing!==0||row.device_count<1))return null;
 return new Map(rows.map(row=>[row.owner_digest,row.device_count]));
}
