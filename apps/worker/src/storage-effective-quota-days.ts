import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { validEffectiveQuotaDay, type EffectiveQuotaDay } from './effective-quota-day';
import { GRAPH_DAY_EFFECTIVE_DEVICE_ID, GRAPH_DAY_EFFECTIVE_MANIFEST_ID,
  graphDayEffectiveQuotaSupported, readGraphDayEffectiveQuotaHeads, readGraphDayProjection, writeGraphDayProjection,
  type GraphDayProjectionKey, type GraphDayProjectionLoadCursor,
  type GraphDayProjectionWriteCursor } from './graph-day-projection';
import { assertEffectiveHistoryOwner, effectiveHistoryDependency,
  type advanceStorageEffectiveAnalysis } from './storage-effective-history';
import type { StorageCommunityOwner } from './storage-community-authority';
import { QUOTA_RESET_CLUSTER_LIMIT } from './quota-endpoint-collapse';

type Preparation = NonNullable<Parameters<typeof advanceStorageEffectiveAnalysis>[0]['preparedQuota']>;
const fail = () => new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
/** Leave room in the isolate for decoded objects, the folded acquisition and
 * checkpoint framing. A per-day bound alone permits 101 large days at once. */
export const STORAGE_EFFECTIVE_QUOTA_WINDOW_BYTES = 8 * 1024 * 1024;

/** Optional input cache. It never grants source authority: both preparation
 * and consumption recompute the exact day dependency under the current owner
 * fence. The caller supplies the invocation's actual shared statement meter.
 * Cold preparation is fed by the existing quota scan, not a second traversal. */
export async function createStorageEffectiveQuotaPreparation(input: {
  source: D1Database; target: D1Database; sourceId: string; sourceNamespace: string;
  owner: StorageCommunityOwner & {ownerDigest:string};
  remainingQueries: () => number; deadlineMs: number; now: () => number;
}): Promise<Preparation|undefined> {
  if (!await graphDayEffectiveQuotaSupported(input.target)) return undefined;
  const available = (reserve: number) => input.remainingQueries() >= reserve && input.now() < input.deadlineMs;
  const keyFor = async (day: string): Promise<GraphDayProjectionKey> => ({
    sourceId: input.sourceId, sourceLayout: 'effective', sourceNamespace: input.sourceNamespace,
    ownerDigest: input.owner.ownerDigest, deviceId: GRAPH_DAY_EFFECTIVE_DEVICE_ID,
    manifestId: GRAPH_DAY_EFFECTIVE_MANIFEST_ID, day,
    // Match the completed daily projector's dependency contract so retirement
    // can recognize corrections once that projector catches up. A session-only
    // change may conservatively rebuild quota inputs; it cannot serve stale data.
    manifestDigest: await sha256Hex(canonicalJson(await effectiveHistoryDependency(input.source,
      input.owner, input.sourceNamespace, day, day, {includeSessions:true}))),
  });
  let attempted = false, fallbackPage = false;
  return {
    preferSinglePageCheckpoint:()=>fallbackPage,
    async load(days) {
      // A miss is tried once per graph invocation. Rechecking after every source
      // page would make cold preparation slower than its maintained fallback.
      if (attempted) return undefined;
      attempted = true;
      if (days.length === 0) return [];
      if (!available(260)) return undefined;
      const heads = await readGraphDayEffectiveQuotaHeads({target:input.target,sourceId:input.sourceId,
        sourceNamespace:input.sourceNamespace,ownerDigest:input.owner.ownerDigest,
        fromDay:days[0]!,throughDay:days[days.length-1]!});
      if (!heads) return undefined;
      const candidates = days.map(day => heads.filter(head => head.key.day === day));
      // Prove complete coverage and affordability before doing source work.
      // Until dependencies are known, use each day's largest retained candidate.
      if (candidates.some(day => day.length === 0)) return undefined;
      const bytes = candidates.reduce((sum,day) => sum + Math.max(...day.map(head => head.payloadBytes)),0);
      const fragments = candidates.reduce((sum,day) => sum + Math.max(...day.map(head => head.fitFragmentCount)),0);
      const payloadReads = candidates.reduce((sum,day) => sum + Math.max(...day.map(head => Math.ceil(head.cursor.partCount/32))),0);
      if (bytes > STORAGE_EFFECTIVE_QUOTA_WINDOW_BYTES || fragments > QUOTA_RESET_CLUSTER_LIMIT) return undefined;
      // The day dependency costs at most six statements, including v1.2. Read
      // every dependency before loading payloads: a late cache miss still has
      // the 200 statements needed to advance the normal pager. A complete fold
      // needs only its 120-statement checkpoint reserve. Bulk heads remove one
      // manifest read per day, keeping a small 101-day window within the cap.
      if (!available(6*days.length + Math.max(200,payloadReads+120) + 2)) return undefined;
      // Until the complete window is proved, any fallback must be able to
      // stage the same one-page successor on a retry, even if it is >30 parts.
      fallbackPage = true;
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const selected:typeof heads[number][] = [];
      for (const [index,day] of days.entries()) {
        if (input.now() >= input.deadlineMs) return undefined;
        const key = await keyFor(day);
        const head=candidates[index]!.find(candidate => candidate.key.manifestDigest === key.manifestDigest);
        if (!head) return undefined;
        selected.push(head);
      }
      const prepared: EffectiveQuotaDay[] = [];
      for (const head of selected) {
        const key=head.key;
        let cursor:GraphDayProjectionLoadCursor=head.cursor;
        for (;;) {
          if (!available(121)) return undefined;
          const loaded = await readGraphDayProjection({target:input.target,key,maxParts:32,cursor});
          if (loaded.status === 'absent') return undefined;
          if (loaded.status === 'deferred') { cursor = loaded.cursor; continue; }
          if (!loaded.effectiveQuota || loaded.effectiveQuota.ownerRevision > input.owner.ownerRevision) throw fail();
          const value = {projection:loaded.projection,quotaRowsRead:loaded.effectiveQuota.quotaRowsRead};
          if (!validEffectiveQuotaDay(value)) throw fail();
          prepared.push(value);
          break;
        }
      }
      await assertEffectiveHistoryOwner(input.source,input.owner);
      fallbackPage = false;
      return prepared;
    },
    async store(day) {
      // Keep enough room for the normal checkpoint after optional preparation.
      // A bounded miss is harmless: the paged calculation already has the same
      // source rows and remains the authority for this result.
      if (!available(160)) return;
      if (!validEffectiveQuotaDay(day)) throw fail();
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const key = await keyFor(day.projection.day);
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const ready = await input.target.prepare(`SELECT 1 AS ready FROM analytics_owner_state
        WHERE source_id=? AND owner_digest=? AND state='active' AND authority_epoch=?`)
        .bind(input.sourceId,input.owner.ownerDigest,input.owner.authorityEpoch).first<number>('ready');
      if (ready !== 1) throw fail();
      let cursor:GraphDayProjectionWriteCursor|undefined;
      while (available(130)) {
        const saved = await writeGraphDayProjection({target:input.target,key,projection:day.projection,
          effectiveQuota:{quotaRowsRead:day.quotaRowsRead,ownerRevision:input.owner.ownerRevision},
          ...(cursor?{cursor}:{})});
        if (saved.status === 'stored') return;
        cursor = saved.cursor;
      }
    },
  };
}
