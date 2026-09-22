import { applyAnalyticsChange, readIngestionChanges, type StorageChange } from './analytics-delivery';
import { lookupV11StorageSource } from './v11-storage-journal';

const unavailable = () => new Error('LEGACY_STORAGE_SOURCE_UNAVAILABLE');
/** Bounded, privileged retained-source bootstrap. No payload scan or new consent.
 * A revision receipt means input changed, never that a fit or price completed. */
export async function bootstrapLegacyStorageOwner(source:D1Database,participantId:string):Promise<'eligible-legacy'|'ineligible'> {
  if(typeof participantId!=='string'||participantId.length<1||participantId.length>256)throw unavailable();
  await source.prepare('INSERT INTO storage_legacy_revision_requests(participant_id) VALUES(?)').bind(participantId).run();
  const row=await source.prepare(`SELECT 1 FROM storage_legacy_event_sources s
    JOIN storage_v11_owner_links l ON l.participant_id=s.participant_id AND l.owner_digest=s.owner_digest AND l.state='active'
    JOIN community_analytical_input_versions v ON v.participant_id=s.participant_id AND v.revision=s.input_revision
    WHERE s.participant_id=? AND EXISTS(SELECT 1 FROM community_public_source_owners p
      WHERE p.participant_id=s.participant_id AND p.device_id IS NULL)
    AND EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=s.participant_id
      AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2')`).bind(participantId).first();
  return row?'eligible-legacy':'ineligible';
}

export async function isLegacyStorageChange(source:D1Database,change:StorageChange):Promise<boolean> {
  return !!await source.prepare('SELECT 1 FROM storage_legacy_event_sources WHERE event_digest=? AND owner_digest=?')
    .bind(change.eventDigest,change.ownerDigest).first();
}

/** One exact shared-cursor acknowledgement. It copies no raw records, fit
 * values, dataset totals or fabricated daily zeros. The existing fit selector
 * reads source-side records and must recheck its own source and authority pins.
 * Terminal events remain owned by the common v1/v11 terminal-fence dispatcher. */
export async function advanceLegacyStorageAcknowledgement(options:{source:D1Database;target:D1Database;sourceId:string;signal?:AbortSignal}):Promise<{
  state:'idle'|'applied'|'discarded';sequence:number;recordsRead:number;
}> {
  const {source,target,sourceId,signal}=options;signal?.throwIfAborted();
  if(source===target)throw unavailable();
  const sequence=await target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?')
    .bind(sourceId).first<number>('sequence')??0;
  if(!Number.isSafeInteger(sequence)||sequence<0)throw unavailable();
  const change=(await readIngestionChanges(source,sourceId,sequence,1))[0];
  if(!change)return {state:'idle',sequence,recordsRead:0};
  if(change.sequence!==sequence+1||!['owner-active','source-updated'].includes(change.kind)
    ||change.eventDigest!==change.objectDigest||change.eventDigest!==change.contentDigest)throw unavailable();
  const owner=await source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(change.ownerDigest).first<string>('state');
  let disposition:'legacy-fit-source'|'owner-withdrawn'|'owner-erased'='legacy-fit-source';
  if(owner==='withdrawn'||owner==='erased') {
    const terminal=await lookupV11StorageSource(source,change);
    if(terminal.disposition!=='discard')throw unavailable();
    disposition=terminal.reason;
  } else {
    const proof=await source.prepare(`SELECT s.input_revision FROM storage_legacy_event_sources s
      JOIN storage_v11_owner_links l ON l.participant_id=s.participant_id AND l.owner_digest=s.owner_digest
      JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
      WHERE s.event_digest=? AND s.owner_digest=? AND s.change_kind=? AND l.state='active' AND o.state='active'
      AND EXISTS(SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=s.participant_id AND p.device_id IS NULL)`)
      .bind(change.eventDigest,change.ownerDigest,change.kind).first<{input_revision:number}>();
    if(!proof||!Number.isSafeInteger(proof.input_revision)||proof.input_revision<0)throw unavailable();
  }
  signal?.throwIfAborted();
  await applyAnalyticsChange(target,change,async()=>[target.prepare(`INSERT INTO analytics_legacy_authority_receipts
    (source_id,event_digest,owner_digest,disposition) VALUES(?,?,?,?)`)
    .bind(sourceId,change.eventDigest,change.ownerDigest,disposition)]);
  return {state:disposition==='legacy-fit-source'?'applied':'discarded',sequence:change.sequence,recordsRead:0};
}
