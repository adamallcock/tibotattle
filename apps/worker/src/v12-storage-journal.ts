import { applyAnalyticsChange, readIngestionChanges, type StorageChange } from './analytics-delivery';
import { lookupV11StorageSource } from './v11-storage-journal';

const unavailable = () => new Error('V12_STORAGE_SOURCE_UNAVAILABLE');
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
// A v1.2 domain names at most 4,096 days; a head change can touch both the
// new and the replaced generation's days.
const MAX_CHANGED_DAYS = 8_192;

/** Ordinary-dispatch probe. A source role before isolation 0011 has no v1.2
 * bridge, so none of its journal rows can be v1.2 events. */
export async function isV12StorageChange(source: D1Database, change: StorageChange): Promise<boolean> {
  try {
    const row = await source.prepare(`SELECT 1 AS present FROM storage_v12_event_sources
      WHERE event_digest=? AND owner_digest=?`).bind(change.eventDigest, change.ownerDigest).first<number>('present');
    return row === 1;
  } catch (error) {
    if (/no such table/iu.test(String(error))) return false;
    throw error;
  }
}

interface V12EventProof { generation_id: string; previous_generation_id: string | null }

/** One exact shared-cursor acknowledgement of an accepted v1.2 head. It copies
 * no records: the version-neutral daily and graph readers fold v1.2 evidence
 * directly from source. The analytics receipt advances the owner revision,
 * which invalidates that owner's cached folds, and re-queues exactly the days
 * whose accepted manifest the new head added, replaced or dropped.
 * Terminal events remain owned by the common v1/v11 terminal-fence dispatcher. */
export async function advanceV12StorageAcknowledgement(options: {
  source: D1Database; target: D1Database; sourceId: string; signal?: AbortSignal;
}): Promise<{ state: 'idle' | 'applied' | 'discarded'; sequence: number; recordsRead: number }> {
  const { source, target, sourceId, signal } = options; signal?.throwIfAborted();
  if (source === target) throw unavailable();
  const sequence = await target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?')
    .bind(sourceId).first<number>('sequence') ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw unavailable();
  const change = (await readIngestionChanges(source, sourceId, sequence, 1))[0];
  if (!change) return { state: 'idle', sequence, recordsRead: 0 };
  if (change.sequence !== sequence + 1 || change.kind !== 'owner-active' || change.eventDigest !== change.objectDigest) {
    throw unavailable();
  }
  const owner = await source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(change.ownerDigest).first<string>('state');
  let days: string[] = [];
  let discarded = false;
  if (owner === 'withdrawn' || owner === 'erased') {
    const terminal = await lookupV11StorageSource(source, change);
    if (terminal.disposition !== 'discard') throw unavailable();
    discarded = true;
  } else {
    const proof = await source.prepare(`SELECT s.generation_id,s.previous_generation_id FROM storage_v12_event_sources s
      JOIN storage_v11_owner_links l ON l.participant_id=s.participant_id AND l.owner_digest=s.owner_digest
      JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
      JOIN telemetry_v12_domains d ON d.id=s.generation_id AND d.participant_id=s.participant_id
        AND d.device_id=s.device_id AND d.manifest_digest=s.manifest_digest
      WHERE s.event_digest=? AND s.owner_digest=? AND s.manifest_digest=? AND l.state='active' AND o.state='active'
      AND EXISTS(SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=s.participant_id
        AND (p.device_id IS NULL OR p.device_id=s.device_id))`)
      .bind(change.eventDigest, change.ownerDigest, change.contentDigest).first<V12EventProof>();
    if (!proof || typeof proof.generation_id !== 'string') throw unavailable();
    // Both generations are immutable; their day/manifest pairs are compared in
    // one bounded read. A first head has no predecessor: every day is new.
    const rows = (await source.prepare(`SELECT observed_day AS day FROM (
        SELECT observed_day,manifest_digest FROM telemetry_v12_domain_days WHERE generation_id=?1
        EXCEPT SELECT observed_day,manifest_digest FROM telemetry_v12_domain_days WHERE generation_id=?2
      ) UNION SELECT observed_day FROM (
        SELECT observed_day,manifest_digest FROM telemetry_v12_domain_days WHERE generation_id=?2
        EXCEPT SELECT observed_day,manifest_digest FROM telemetry_v12_domain_days WHERE generation_id=?1
      ) ORDER BY day LIMIT ?3`)
      .bind(proof.generation_id, proof.previous_generation_id, MAX_CHANGED_DAYS + 1).all<{ day: string }>()).results;
    if (rows.length > MAX_CHANGED_DAYS || rows.some(row => typeof row.day !== 'string' || !DAY.test(row.day))) throw unavailable();
    days = rows.map(row => row.day);
  }
  signal?.throwIfAborted();
  await applyAnalyticsChange(target, change, async () => days.length === 0 ? [] : [target.prepare(`INSERT INTO
    analytics_community_daily_queue(source_id,day,revision) SELECT ?,value,1 FROM json_each(?) WHERE true
    ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1`).bind(sourceId, JSON.stringify(days))]);
  return { state: discarded ? 'discarded' : 'applied', sequence: change.sequence, recordsRead: 0 };
}
