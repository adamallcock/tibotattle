import { readIngestionChanges, type StorageChange } from './analytics-delivery';

export interface V11StorageGeneration {
  disposition: 'generation'; sourceId: string; ownerDigest: string; eventDigest: string;
  generationId: string; manifestDigest: string; participantId: string; deviceId: string;
  fromDay: string; throughDay: string; headRevision: number; inputRevision: number;
  authorityEpoch: number; publicAuthorityEpoch: number;
}
export interface V11StorageDiscard {
  disposition: 'discard'; reason: 'owner-withdrawn' | 'owner-erased'; sourceId: string; ownerDigest: string;
  terminalRevision: number; terminalSequence: number; authorityEpoch: number; publicAuthorityEpoch: number;
}
interface Metadata {
  event_digest: string; owner_digest: string; participant_id: string; device_id: string;
  generation_id: string; manifest_digest: string; from_day: string; through_day: string;
  head_revision: number; input_revision: number;
}
const unavailable = () => new Error('V11_STORAGE_SOURCE_UNAVAILABLE');
function exactEvent(a: StorageChange, b: StorageChange): boolean {
  return a.sourceId === b.sourceId && a.sequence === b.sequence && a.eventDigest === b.eventDigest
    && a.ownerDigest === b.ownerDigest && a.revision === b.revision && a.kind === b.kind
    && a.objectDigest === b.objectDigest && a.contentDigest === b.contentDigest
    && a.authorityEpoch === b.authorityEpoch && a.publicAuthorityEpoch === b.publicAuthorityEpoch
    && a.recordedMs === b.recordedMs;
}
function discard(change: StorageChange): V11StorageDiscard {
  if (change.kind !== 'owner-withdrawn' && change.kind !== 'owner-erased') throw unavailable();
  return { disposition: 'discard', reason: change.kind, sourceId: change.sourceId, ownerDigest: change.ownerDigest,
    terminalRevision: change.revision, terminalSequence: change.sequence,
    authorityEpoch: change.authorityEpoch, publicAuthorityEpoch: change.publicAuthorityEpoch };
}

/** Protected ingestion-side lookup, not a public endpoint or authorization API.
 * Never substitute the newest domain. Metadata deletion requires a later source
 * terminal event; a missing generation by itself is not permission to skip it.
 */
export async function lookupV11StorageSource(db: D1Database, change: StorageChange): Promise<V11StorageGeneration | V11StorageDiscard> {
  if (!Number.isSafeInteger(change.sequence) || change.sequence < 1) throw unavailable();
  const actual = (await readIngestionChanges(db, change.sourceId, change.sequence - 1, 1))[0];
  if (!actual || !exactEvent(actual, change)) throw unavailable();
  if (change.kind === 'owner-withdrawn' || change.kind === 'owner-erased') return discard(actual);
  const terminal = await db.prepare(`SELECT c.sequence FROM storage_owner_revisions r
    JOIN storage_ingestion_changes c ON c.owner_digest=r.owner_digest AND c.revision=r.revision
    WHERE r.owner_digest=? AND r.state IN ('withdrawn','erased')
      AND c.kind=CASE r.state WHEN 'erased' THEN 'owner-erased' ELSE 'owner-withdrawn' END
      AND c.revision>? AND c.sequence>?`)
    .bind(change.ownerDigest, change.revision, change.sequence).first<{ sequence: number }>();
  if (terminal) {
    const proof = (await readIngestionChanges(db, change.sourceId, terminal.sequence - 1, 1))[0];
    if (!proof || proof.ownerDigest !== change.ownerDigest || proof.revision <= change.revision
        || proof.authorityEpoch <= change.authorityEpoch) throw unavailable();
    return discard(proof);
  }
  const metadata = await db.prepare(`SELECT s.event_digest,s.owner_digest,s.participant_id,s.device_id,s.generation_id,
      s.manifest_digest,s.from_day,s.through_day,s.head_revision,s.input_revision
    FROM storage_v11_event_sources s
    JOIN storage_v11_owner_links link ON link.participant_id=s.participant_id AND link.owner_digest=s.owner_digest AND link.state='active'
    JOIN storage_owner_revisions r ON r.owner_digest=s.owner_digest AND r.state='active'
    JOIN telemetry_v11_domains d ON d.id=s.generation_id AND d.participant_id=s.participant_id AND d.device_id=s.device_id
      AND d.manifest_digest=s.manifest_digest AND d.from_day=s.from_day AND d.through_day=s.through_day AND d.input_revision=s.input_revision
    JOIN community_public_source_owners p ON p.participant_id=s.participant_id AND (p.device_id IS NULL OR p.device_id=s.device_id)
    WHERE s.event_digest=? AND s.owner_digest=? AND s.manifest_digest=?`)
    .bind(change.objectDigest, change.ownerDigest, change.contentDigest).first<Metadata>();
  if (!metadata || metadata.event_digest !== change.eventDigest || !Number.isSafeInteger(metadata.head_revision)
      || !Number.isSafeInteger(metadata.input_revision)) throw unavailable();
  return { disposition: 'generation', sourceId: change.sourceId, ownerDigest: change.ownerDigest, eventDigest: change.eventDigest,
    generationId: metadata.generation_id, manifestDigest: metadata.manifest_digest, participantId: metadata.participant_id,
    deviceId: metadata.device_id, fromDay: metadata.from_day, throughDay: metadata.through_day,
    headRevision: metadata.head_revision, inputRevision: metadata.input_revision,
    authorityEpoch: change.authorityEpoch, publicAuthorityEpoch: change.publicAuthorityEpoch };
}

/** Explicit single-owner bootstrap. No scan, enrollment hook or source update is
 * performed. Calling twice for the same accepted eligible head is idempotent.
 * This privileged bridge API is for local/new-target integration only.
 */
export async function bootstrapV11StorageHead(db: D1Database, participantId: string): Promise<'eligible-head' | 'ineligible'> {
  if (typeof participantId !== 'string' || participantId.length < 1 || participantId.length > 256) throw unavailable();
  await db.prepare(`INSERT INTO storage_v11_head_requests(participant_id,generation_id,head_revision)
    SELECT h.participant_id,h.generation_id,h.revision FROM telemetry_v11_domain_heads h
    JOIN telemetry_v11_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
    JOIN community_public_source_owners p ON p.participant_id=h.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id)
    WHERE h.participant_id=?`).bind(participantId).run();
  const row = await db.prepare(`SELECT 1 AS present FROM storage_v11_owner_links link
    JOIN telemetry_v11_domain_heads h ON h.participant_id=link.participant_id
      AND h.generation_id=link.generation_id AND h.revision=link.head_revision
    JOIN community_public_source_owners p ON p.participant_id=link.participant_id
    WHERE link.participant_id=? AND link.state='active'`).bind(participantId).first<{ present: number }>();
  return row ? 'eligible-head' : 'ineligible';
}
