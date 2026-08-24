import {
  extractRolloutUsage,
  inheritedTierSeed,
} from "./local-unified-index-extract.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Resolve a paginated rollout's carried state at the exact physical history
 * boundary named by Codex. The scan is content-free and emits no facts; its
 * only output is the same bounded model/tier/counter and replay-snapshot state
 * the normal extractor would hold after that prefix. Results are cached by
 * immutable rollout id and cutoff so successive generations do not re-read
 * one base boundary within a pass.
 */
export function createHistoryBaseSeedResolver(infos, {
  maximumLineBytes,
  signal = null,
} = {}) {
  const byRolloutId = new Map(infos
    .filter((info) => typeof info.rolloutId === "string")
    .map((info) => [info.rolloutId, info]));
  const cache = new Map();
  const resolving = new Set();

  async function resolveSeed(info, { includeSnapshots = false } = {}) {
    const chain = [];
    const ownedKeys = [];
    const localKeys = new Set();
    let current = info;
    let inherited = null;
    try {
      for (;;) {
        const base = current.lineage?.historyBase ?? null;
        if (current.lineage?.historyMode !== "paginated" || base === null) {
          inherited = null;
          break;
        }
        const key = `${base.rolloutId}\0${base.endByteOffset}\0${base.endOrdinalExclusive}`
          + `\0${includeSnapshots ? "snapshots" : "state"}`;
        if (cache.has(key)) {
          inherited = cache.get(key);
          break;
        }
        if (localKeys.has(key) || resolving.has(key)) {
          throw fixedError("codex_rollout_lineage_invalid");
        }
        const parent = byRolloutId.get(base.rolloutId);
        if (parent === undefined) throw fixedError("codex_rollout_lineage_invalid");
        localKeys.add(key);
        resolving.add(key);
        ownedKeys.push(key);
        chain.push({ base, key, parent });
        current = parent;
      }

      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const { base, key, parent } = chain[index];
        const seedSnapshots = includeSnapshots
          ? new Set(inherited?.seedSnapshots ?? [])
          : null;
        const outcome = await withStableRolloutSource(parent, (source) => (
          extractRolloutUsage(source, {
            size: base.endByteOffset,
            isFork: parent.lineage?.isInlineFork === true,
            seedModel: inherited?.seedModel ?? null,
            seedEffort: inherited?.seedEffort ?? null,
            seedTier: inherited?.seedTier ?? null,
            seedTotals: inherited?.seedTotals ?? null,
            collectSnapshots: seedSnapshots === null ? null : {
              add(snapshotKey) {
                seedSnapshots.add(snapshotKey);
              },
            },
            ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
            signal,
            onEvent: () => {},
          })
        ));
        if (outcome.read.nextOffset !== base.endByteOffset
            || outcome.read.completeLines
              !== base.endOrdinalExclusive
                - Number(parent.lineage?.startOrdinal ?? 0)) {
          throw fixedError("codex_rollout_lineage_invalid");
        }
        inherited = Object.freeze({
          seedModel: outcome.finalModel,
          seedEffort: outcome.finalEffort,
          seedTier: inheritedTierSeed(outcome.finalTier),
          seedTotals: outcome.finalTotals,
          seedSnapshots,
        });
        cache.set(key, inherited);
      }
      return inherited;
    } finally {
      for (const key of ownedKeys) resolving.delete(key);
    }
  }

  return Object.freeze({ resolveSeed });
}
