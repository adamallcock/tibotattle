import { retireStorageHistoryCheckpoint, type StorageHistoryKey } from './storage-history-checkpoint';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';

/** One bounded payload page. Durable erased-owner state prevents new work;
 * retired checkpoint heads independently reject delayed immutable stage writes.
 * Reversible withdrawal does not discard retained history. */
export async function retireStorageGraphPage(target:D1Database,sourceId:string,nowMs=Date.now()):Promise<{
 state:'idle'|'retiring';deleted:number;
}> {
 if(!Number.isFinite(nowMs)||!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(sourceId))throw new Error('STORAGE_GRAPH_RETIREMENT_INVALID');
 const oldest=new Date(Date.parse(new Date(nowMs).toISOString().slice(0,10))
  -(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);
 const erased=await target.prepare(`WITH terminals AS (
  SELECT owner_digest,revision FROM analytics_owner_state WHERE source_id=? AND state='erased'
  UNION ALL SELECT owner_digest,terminal_revision AS revision FROM analytics_storage_erasure_fences WHERE source_id=?
 ), latest AS (SELECT owner_digest,MAX(revision) revision FROM terminals GROUP BY owner_digest)
 SELECT t.owner_digest,t.revision FROM latest t WHERE NOT EXISTS(SELECT 1 FROM analytics_graph_erasure_receipts r
  WHERE r.source_id=? AND r.owner_digest=t.owner_digest AND r.terminal_revision>=t.revision)
 ORDER BY t.owner_digest LIMIT 1`).bind(sourceId,sourceId,sourceId).first<{owner_digest:string;revision:number}>();
 const results=await target.batch([
  target.prepare(`DELETE FROM analytics_community_graph_results WHERE (source_id,owner_digest,metric,day) IN (
   SELECT source_id,owner_digest,metric,day FROM analytics_community_graph_results
   WHERE source_id=? AND (day<? OR owner_digest=?) ORDER BY owner_digest,metric,day LIMIT 32) RETURNING day`)
   .bind(sourceId,oldest,erased?.owner_digest??null),
  target.prepare(`DELETE FROM analytics_community_graph_execution WHERE (source_id,owner_digest,day) IN (
   SELECT e.source_id,e.owner_digest,e.day FROM analytics_community_graph_execution e
   WHERE source_id=? AND (day<? OR owner_digest=? OR EXISTS(SELECT 1 FROM analytics_community_graph_results r
    WHERE r.source_id=e.source_id AND r.owner_digest=e.owner_digest AND r.day=e.day
     AND r.metric='model' AND r.dependency_digest=e.dependency_digest)) ORDER BY owner_digest,day LIMIT 32) RETURNING day`)
   .bind(sourceId,oldest,erased?.owner_digest??null),
 ]);
 const deleted=results.reduce((n,r)=>n+r.results.length,0);
 const stage=await target.prepare(`SELECT s.source_id,s.owner_digest,s.day,s.dependency_digest,s.source_namespace,s.method,
  h.generation AS head FROM analytics_history_checkpoint_stages s LEFT JOIN analytics_history_checkpoint_heads h USING(key_digest)
  WHERE s.source_id=? AND (s.day<? OR s.owner_digest=? OR h.retired=1 OR EXISTS(
   SELECT 1 FROM analytics_community_graph_results r WHERE r.source_id=s.source_id AND r.owner_digest=s.owner_digest
    AND r.metric='model' AND r.day=s.day AND r.dependency_digest=s.dependency_digest))
  ORDER BY s.owner_digest,s.day,s.key_digest,s.generation LIMIT 1`).bind(sourceId,oldest,erased?.owner_digest??null)
  .first<{source_id:string;owner_digest:string;day:string;dependency_digest:string;source_namespace:string;method:string;head:string|null}>();
 if(stage) {
  const key:StorageHistoryKey={sourceId:stage.source_id,ownerDigest:stage.owner_digest,day:stage.day,
   dependencyDigest:stage.dependency_digest,sourceNamespace:stage.source_namespace,method:stage.method};
  await retireStorageHistoryCheckpoint({target,key,expectedHead:stage.head,maxWrites:16});
  return {state:'retiring',deleted};
 }
 if(erased) {
  // Same-database absence proof and receipt commit atomically. Digest-only
  // anti-resurrection tombstones remain, never checkpoint record payloads.
  await target.prepare(`INSERT INTO analytics_graph_erasure_receipts
   SELECT ?1,?2,?3 WHERE (
    EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=?1 AND owner_digest=?2 AND state='erased' AND revision=?3)
    OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=?1 AND owner_digest=?2 AND terminal_revision=?3))
   AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_results WHERE source_id=?1 AND owner_digest=?2)
   AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_execution WHERE source_id=?1 AND owner_digest=?2)
   AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages WHERE source_id=?1 AND owner_digest=?2)
   ON CONFLICT(source_id,owner_digest) DO UPDATE SET terminal_revision=excluded.terminal_revision
    WHERE excluded.terminal_revision>analytics_graph_erasure_receipts.terminal_revision`)
   .bind(sourceId,erased.owner_digest,erased.revision).run();
  return {state:'retiring',deleted};
 }
 // Replaced acquisition generations are disposable once their successor head
 // commits. Preserve both the current generation and a partly staged successor
 // which still expects that head; a concurrent promotion cannot make an older
 // generation current again because the store uses exact-head CAS.
 const stale=await target.prepare(`SELECT s.key_digest,s.generation FROM analytics_history_checkpoint_stages s
  JOIN analytics_history_checkpoint_heads h ON h.key_digest=s.key_digest AND h.retired=0
  WHERE s.source_id=? AND h.generation IS NOT NULL AND s.generation!=h.generation
   AND s.expected_head IS NOT h.generation ORDER BY s.owner_digest,s.day,s.key_digest,s.generation LIMIT 1`)
  .bind(sourceId).first<{key_digest:string;generation:string}>();
 if(stale) {
  await target.batch([
   target.prepare(`DELETE FROM analytics_history_checkpoint_parts WHERE key_digest=?1 AND generation=?2 AND part_index IN(
    SELECT part_index FROM analytics_history_checkpoint_parts WHERE key_digest=?1 AND generation=?2 ORDER BY part_index LIMIT 15)
    AND EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages s JOIN analytics_history_checkpoint_heads h USING(key_digest)
     WHERE s.key_digest=?1 AND s.generation=?2 AND h.retired=0 AND h.generation IS NOT NULL
      AND s.generation!=h.generation AND s.expected_head IS NOT h.generation)`).bind(stale.key_digest,stale.generation),
   target.prepare(`DELETE FROM analytics_history_checkpoint_stages WHERE key_digest=?1 AND generation=?2
    AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_parts WHERE key_digest=?1 AND generation=?2)
    AND EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=?1 AND h.retired=0
     AND h.generation IS NOT NULL AND h.generation!=?2 AND analytics_history_checkpoint_stages.expected_head IS NOT h.generation)`)
    .bind(stale.key_digest,stale.generation),
  ]);
  return {state:'retiring',deleted};
 }
 return {state:deleted?'retiring':'idle',deleted};
}
