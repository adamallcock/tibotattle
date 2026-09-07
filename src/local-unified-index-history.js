import {
  extractRolloutUsage,
  inheritedTierSeed,
  resolveLogicalRolloutHeads,
} from "./local-unified-index-extract.js";
import { reviewedModelIdentity } from "@app-usagemonitor/telemetry-contract";
import { forEachRolloutLine, ROLLOUT_LINE_BYTES } from "./rollout-line-reader.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";

const MODEL_CONTEXT_MARKER = Buffer.from('"turn_context"');
const MODEL_SETTINGS_MARKER = Buffer.from('"thread_settings_applied"');
const MODEL_META_MARKER = Buffer.from('"session_meta"');

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * A paginated source inherits only its exact physical history boundary, never
 * a logical parent's later final state. An absent base and an explicitly
 * unknown field both stay unknown. Resume cursors already hold model, effort
 * and counters; only an absent own-file tier may be reconstructed from the
 * same immutable base, because inherited tiers are not persisted as own
 * observations. An explicit own null-tier observation remains an object and
 * therefore overrides the base. Legacy inline inheritance is unchanged.
 */
export function selectRolloutUsageSeed(info, {
  historySeed = null,
  logicalSeed = null,
  cursorSeed = null,
} = {}) {
  const paginated = info.lineage?.historyMode === "paginated";
  const selected = cursorSeed ?? (paginated ? historySeed : logicalSeed);
  return {
    seedModel: selected?.seedModel ?? null,
    seedEffort: selected?.seedEffort ?? null,
    seedTier: cursorSeed !== null && paginated
      ? cursorSeed.seedTier ?? historySeed?.seedTier ?? null
      : selected?.seedTier ?? null,
    seedTotals: selected?.seedTotals ?? null,
  };
}

/**
 * Model-only fallback for forks without an exact history base. A parent's
 * final cursor is not historical evidence: use its declarations at or before
 * the event, capped at the child's creation time. Copied history therefore
 * follows the original model switches, while later parent switches cannot
 * change new child work. No counters, tier, effort or replay state is inherited.
 *
 * The cache retains only reviewed model IDs and timestamps, with explicit
 * bounds on both timeline size and ancestry. It is scoped to one discovery
 * snapshot; every read uses the same physical-source guard as normal ingest.
 */
export function createParentModelResolver(infos, {
  maximumLineBytes = ROLLOUT_LINE_BYTES,
  signal = null,
} = {}) {
  const heads = resolveLogicalRolloutHeads(infos);
  const byRollout = new Map(infos.filter((info) => info.rolloutId)
    .map((info) => [info.rolloutId, info]));
  const cache = new Map();
  const none = () => null;

  async function timeline(info, end = info.size) {
    const key = `${info.rolloutKey}\0${end}`;
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const entries = [];
    let createdAt = null;
    let valid = true;
    let lastDeclarationAt = -Infinity;
    const read = await withStableRolloutSource(info, (source) => forEachRolloutLine(source, {
      end: Number(end), maximumLineBytes, signal,
      onLine(line, offset, partial) {
        // Reject unrelated content as bytes before decoding the bounded header.
        if (!line.includes(MODEL_CONTEXT_MARKER) && !line.includes(MODEL_SETTINGS_MARKER)
            && !line.includes(MODEL_META_MARKER)) return;
        // Inspect the bounded top-level header, never a marker in content.
        const header = line.toString("utf8", 0, Math.min(line.length, 200));
        if (!/^\{\s*"(?:timestamp|type|ordinal)"/.test(header)) return;
        const type = header.match(/"type"\s*:\s*"(session_meta|turn_context|event_msg)"/u)?.[1];
        if (!type) return;
        if (type === "event_msg"
            && !line.includes(MODEL_SETTINGS_MARKER)) return;
        if (partial) { valid = false; return; }
        let record;
        try { record = JSON.parse(line.toString("utf8")); }
        catch { valid = false; return; }
        if (record.type !== type) return;
        if (type === "session_meta") {
          const timestamp = Date.parse(record.timestamp);
          if (Number.isFinite(timestamp)) createdAt = timestamp;
          return;
        }
        const payload = type === "turn_context" ? record.payload
          : record.payload?.type === "thread_settings_applied"
            ? record.payload.thread_settings : null;
        if (!payload || !Object.hasOwn(payload, "model")) return;
        if (typeof payload.model !== "string") { valid = false; return; }
        const at = Date.parse(record.timestamp);
        if (!Number.isFinite(at)) { valid = false; return; }
        // A regressing clock cannot safely order settings against copied
        // history. Refuse this timeline instead of dropping a later switch.
        if (at < lastDeclarationAt) { valid = false; return; }
        lastDeclarationAt = at;
        // An explicit unreviewed selection blocks the previous known model.
        const model = reviewedModelIdentity(payload.model)?.id ?? "unknown";
        if (entries.at(-1)?.model === model && entries.at(-1).at <= at) return;
        if (entries.length >= 4096) { valid = false; return; }
        entries.push({ at, model, offset });
      },
    }));
    if (read.aborted) signal?.throwIfAborted();
    valid &&= !read.aborted && read.nextOffset === Number(end);
    entries.sort((a, b) => a.at - b.at || a.offset - b.offset);
    const value = { entries: valid ? entries : [], createdAt, valid };
    cache.set(key, value);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return value;
  }

  async function forSource(info) {
    if (info.lineage?.historyMode !== "paginated"
        || info.lineage.historyBase != null || !info.lineage.parentId) return none;
    // Only the first complete metadata record is needed for the fork time.
    // Do not reread the child's entire history merely to seed its first turn.
    let createdAt = null;
    await withStableRolloutSource(info, (source) => forEachRolloutLine(source, {
      end: Math.min(Number(info.size), maximumLineBytes), maximumLineBytes, signal,
      onLine(line, offset, partial) {
        if (offset !== line.length + 1 || partial || !line.includes(MODEL_META_MARKER)) return;
        const header = line.toString("utf8", 0, Math.min(line.length, 200));
        if (!/"type"\s*:\s*"session_meta"/u.test(header)) return;
        try {
          const record = JSON.parse(line.toString("utf8"));
          if (record.type === "session_meta" && typeof record.timestamp === "string") {
            const at = Date.parse(record.timestamp);
            if (Number.isFinite(at)) createdAt = at;
          }
        } catch { /* No reliable creation boundary: leave it unknown. */ }
      },
    }));
    signal?.throwIfAborted();
    if (createdAt === null) return none;
    const chain = [];
    const seen = new Set([info.rolloutKey]);
    let parent = heads.get(info.lineage.parentId);
    let end = parent?.size;
    let ceiling = createdAt;
    while (parent && chain.length < 128) {
      if (seen.has(parent.rolloutKey)) return none;
      seen.add(parent.rolloutKey);
      const state = await timeline(parent, end);
      if (!state.valid) return none;
      chain.push({ entries: state.entries, ceiling });
      const base = parent.lineage?.historyBase;
      if (base != null) {
        parent = byRollout.get(base.rolloutId);
        end = base.endByteOffset;
      } else {
        if (state.createdAt === null) break;
        ceiling = Math.min(ceiling, state.createdAt);
        parent = heads.get(parent.lineage?.parentId);
        end = parent?.size;
      }
    }
    if (parent && chain.length === 128) return none;
    return (observedAtMs) => {
      if (!Number.isFinite(observedAtMs)) return null;
      for (const { entries, ceiling: limit } of chain) {
        const cutoff = Math.min(observedAtMs, limit);
        let low = 0;
        let high = entries.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (entries[mid].at <= cutoff) low = mid + 1;
          else high = mid;
        }
        if (low > 0) return entries[low - 1].model;
      }
      return null;
    };
  }
  return Object.freeze({ forSource });
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
