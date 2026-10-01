import { randomUUID } from "node:crypto";
import {
  WORK_USAGE_SCHEMA,
  queryWorkUsageSnapshot,
  workUsageError,
} from "../reporting/index.js";
const PERIODS = {
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  all: null,
};
const ID = /^[a-zA-Z0-9:_-]{1,200}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEYS = new Set([
  "schemaVersion",
  "action",
  "snapshotId",
  "sourceSnapshotId",
  "period",
  "endAt",
  "scope",
  "grouping",
  "project",
  "worktree",
  "thread",
  "findThread",
  "search",
  "model",
  "sort",
  "pageSize",
  "cursor",
]);
export function validateWorkUsageQuery(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !KEYS.has(key)) ||
    value.schemaVersion !== WORK_USAGE_SCHEMA
  )
    throw workUsageError("work_usage_query_invalid");
  const q = {
    action: "query",
    period: "7d",
    grouping: "project",
    sort: "tokens",
    pageSize: 25,
    ...value,
  };
  if (
    !["query", "cancel", "touch"].includes(q.action) ||
    !Object.hasOwn(PERIODS, q.period) ||
    !["project", "thread", "worktree"].includes(q.grouping) ||
    !["tokens", "cost", "recent"].includes(q.sort) ||
    !Number.isInteger(q.pageSize) ||
    q.pageSize < 1 ||
    q.pageSize > 100
  )
    throw workUsageError("work_usage_query_invalid");
  if (q.endAt !== undefined && (typeof q.endAt !== "string"
      || !Number.isSafeInteger(Date.parse(q.endAt)) || Date.parse(q.endAt) < 0
      || new Date(q.endAt).toISOString() !== q.endAt))
    throw workUsageError("work_usage_query_invalid");
  for (const key of [
    "snapshotId",
    "sourceSnapshotId",
    "cursor",
    "scope",
    "project",
    "worktree",
    "thread",
  ])
    if (
      q[key] !== undefined &&
      (typeof q[key] !== "string" || !ID.test(q[key]))
    )
      throw workUsageError("work_usage_query_invalid");
  if (
    q.model !== undefined &&
    (typeof q.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,200}$/u.test(q.model))
  )
    throw workUsageError("work_usage_query_invalid");
  if (q.search !== undefined) {
    if (typeof q.search !== "string" || q.search.length > 100 || /[\u0000-\u001f\u007f]/u.test(q.search))
      throw workUsageError("work_usage_query_invalid");
    q.search = q.search.normalize("NFKC").trim().toLowerCase();
    if (q.search.length > 100) throw workUsageError("work_usage_query_invalid");
  }
  if (q.findThread !== undefined) {
    if (typeof q.findThread !== "string" || q.findThread.length > 100)
      throw workUsageError("work_usage_query_invalid");
    const id = q.findThread.replace(/^codex:\/\/threads\//iu, "");
    if (!UUID.test(id)) throw workUsageError("work_usage_query_invalid");
    q.findThread = id.toLowerCase();
  }
  if (q.sourceSnapshotId !== undefined && (q.snapshotId !== undefined || q.cursor !== undefined || q.action !== "query"))
    throw workUsageError("work_usage_query_invalid");
  if (q.cursor && !q.snapshotId)
    throw workUsageError("work_usage_query_invalid");
  if (q.action === "cancel" && !q.snapshotId)
    throw workUsageError("work_usage_query_invalid");
  if (q.action === "touch" && (!q.snapshotId || Object.keys(value).some(
    key => !["schemaVersion", "action", "snapshotId"].includes(key),
  )))
    throw workUsageError("work_usage_query_invalid");
  return q;
}

// Names remain separate from the immutable accounting snapshot and never leave
// this process as a search index. Loading is lazy and shared across search calls.
async function createSearchIndex(result, enrich) {
  const rows = new Map();
  for (const cell of result.cells) {
    for (const [field, kind] of [["projects", "project"], ["threads", "thread"]]) {
      for (const id of cell[field]) rows.set(`${kind}:${id}`, { id, kind });
    }
  }
  for (const id of Object.values(result.threadFamilies ?? {})) rows.set(`thread:${id}`, { id, kind: "thread" });
  if (rows.size > 75_000 || [...rows.values()].filter(row => row.kind === "thread").length > 25_000)
    throw workUsageError("work_usage_capacity_exceeded");
  const display = await enrich({ result, rows: [...rows.values()], purpose: "search" });
  const index = { projects: new Map(), threads: new Map() };
  let bytes = 0;
  for (const row of rows.values()) {
    const value = display[row.id];
    const text = [value?.name, value?.thread?.name, value?.thread?.nickname, value?.thread?.parent?.name]
      .filter(item => typeof item === "string").map(item => item.normalize("NFKC").toLowerCase()).join("\n");
    bytes += text.length * 2;
    if (bytes > 16 * 1024 * 1024) throw workUsageError("work_usage_capacity_exceeded");
    if (text) index[row.kind === "project" ? "projects" : "threads"].set(row.id, text);
  }
  return index;
}

/** Immutable reports with an optional content-free last-good snapshot port. */
export function createWorkUsageService({
  build,
  enrich = async () => ({}),
  clock = Date.now,
  newId = randomUUID,
  idleMs = 300_000,
  maximumSnapshots = 2,
  snapshotStore = null,
} = {}) {
  const snapshots = new Map();
  let active = null;
  let closed = false;
  const completed = new Map();
  const writes = new Set();
  const cacheKey = q => JSON.stringify([q.period, q.scope ?? null]);
  const authoritative = result => result.status === "available"
    && result.generation?.status === "complete" && result.metadata?.status === "available";
  function retain(entry) {
    const key = cacheKey({ period: entry.period, scope: entry.requestedScope });
    completed.delete(key);
    completed.set(key, { id: entry.id, result: entry.result,
      fromMs: entry.fromMs, toMs: entry.toMs, namesAvailable: true });
    while (completed.size > maximumSnapshots) completed.delete(completed.keys().next().value);
    if (!snapshotStore) return;
    const write = Promise.resolve().then(() => snapshotStore.write({
      period: entry.period, scope: entry.requestedScope,
      ...(entry.exactWindow ? { endAt: new Date(entry.toMs).toISOString() } : {}),
    }, { ...entry.result, fromMs: entry.fromMs, toMs: entry.toMs })).catch(() => {});
    writes.add(write);
    void write.finally(() => writes.delete(write));
  }
  const dispose = (entry) => {
    entry.controller.abort();
    snapshots.delete(entry.id);
    if (active === entry) active = null;
  };
  function sweep() {
    for (const entry of snapshots.values())
      if (clock() - entry.touched > idleMs) dispose(entry);
  }
  const expiryTimer = setInterval(sweep, Math.min(idleMs, 30_000));
  expiryTimer.unref?.();
  return {
    close() {
      closed = true;
      clearInterval(expiryTimer);
      for (const entry of snapshots.values()) dispose(entry);
      completed.clear();
      return Promise.allSettled([...writes]);
    },
    async query(input) {
      const q = validateWorkUsageQuery(input);
      if (closed) throw workUsageError("work_usage_unavailable");
      // Read only a validated local snapshot, never wait for aggregation here.
      let restored = null;
      if (!q.snapshotId && !q.sourceSnapshotId && !completed.has(cacheKey(q)) && snapshotStore) {
        try { restored = await snapshotStore.read(q); } catch { /* Optional cache. */ }
        if (closed) throw workUsageError("work_usage_unavailable");
      }
      sweep();
      const source = q.sourceSnapshotId ? snapshots.get(q.sourceSnapshotId) : null;
      if (q.sourceSnapshotId && !source) throw workUsageError("work_usage_snapshot_expired");
      if (source && source.status !== "available") throw workUsageError("work_usage_snapshot_changed");
      // Capture before capacity eviction: related periods share the displayed
      // accounting instant, even when the original build took a long time.
      const requestedEnd = q.endAt === undefined ? null : Date.parse(q.endAt);
      if (requestedEnd !== null && (requestedEnd > clock()
          || (source && source.toMs !== requestedEnd))) throw workUsageError("work_usage_query_invalid");
      const anchorToMs = requestedEnd ?? source?.toMs ?? null;
      const expectedGeneration = source?.result?.generation?.fingerprint ?? source?.result?.generation;
      let entry = q.snapshotId ? snapshots.get(q.snapshotId) : null;
      if (q.snapshotId && !entry)
        throw workUsageError("work_usage_snapshot_expired");
      if (q.action === "cancel") {
        dispose(entry);
        return { schemaVersion: WORK_USAGE_SCHEMA, status: "cancelled" };
      }
      if (
        entry && q.action !== "touch" &&
        (entry.period !== q.period ||
          (requestedEnd !== null && entry.toMs !== requestedEnd) ||
          (q.scope !== undefined && entry.requestedScope !== q.scope))
      )
        throw workUsageError("work_usage_snapshot_changed");
      if (!entry) {
        if (
          active &&
          active.period === q.period &&
          active.requestedScope === q.scope &&
          active.anchorToMs === anchorToMs &&
          active.exactWindow === (requestedEnd !== null) &&
          active.expectedGeneration === expectedGeneration
        )
          entry = active;
        else {
          if (active) dispose(active);
          while (snapshots.size >= maximumSnapshots) {
            const victim = [...snapshots.values()].find(item => item !== source)
              ?? snapshots.values().next().value;
            dispose(victim);
          }
          const now = anchorToMs ?? clock();
          const duration = PERIODS[q.period];
          let retained = completed.get(cacheKey(q)) ?? (restored ? {
            id: newId(), result: restored, fromMs: restored.fromMs,
            toMs: restored.toMs, namesAvailable: false,
          } : null);
          // An explicit reporting end must match exactly, including after a
          // restart. A source snapshot additionally pins the generation; an
          // endAt-only request has no generation identity to compare against.
          if (anchorToMs !== null && (retained?.toMs !== anchorToMs
              || (expectedGeneration !== undefined
                && (retained?.result.generation?.fingerprint ?? retained?.result.generation) !== expectedGeneration))) retained = null;
          entry = {
            id: newId(),
            period: q.period,
            requestedScope: q.scope,
            anchorToMs,
            expectedGeneration,
            fromMs: duration === null ? 0 : Math.max(0, now - duration),
            toMs: now,
            touched: clock(),
            exactWindow: requestedEnd !== null,
            controller: new AbortController(),
            status: "preparing",
            retained,
            cursors: new Map(),
          };
          snapshots.set(entry.id, entry);
          active = entry;
          const selected = entry;
          Promise.resolve()
            .then(() =>
              build(
                {
                  period: selected.period,
                  exactWindow: selected.exactWindow,
                  fromMs: selected.fromMs,
                  toMs: selected.toMs,
                  scope: selected.requestedScope,
                },
                { signal: selected.controller.signal },
              ),
            )
            .then((result) => {
              if (!snapshots.has(selected.id)) return;
              if (result.status === "available" && selected.expectedGeneration !== undefined &&
                  selected.expectedGeneration !== (result.generation?.fingerprint ?? result.generation)) {
                throw workUsageError("work_usage_snapshot_changed");
              }
              if (result.status === "available" && (selected.exactWindow || result.toMs !== undefined)) {
                const duration = PERIODS[selected.period];
                if (!Number.isSafeInteger(result.toMs) || result.toMs > selected.toMs
                    || (selected.exactWindow && result.toMs !== selected.toMs)
                    || !Number.isSafeInteger(result.fromMs)
                    || result.fromMs !== (duration === null ? 0 : Math.max(0, result.toMs - duration))) {
                  throw workUsageError("work_usage_snapshot_changed");
                }
                selected.fromMs = result.fromMs;
                selected.toMs = result.toMs;
              }
              if (selected.retained && !authoritative(result)) {
                selected.status = "unavailable";
                return;
              }
              selected.result = result;
              selected.status = result.status;
              if (authoritative(result)) retain(selected);
            })
            .catch((error) => {
              if (!snapshots.has(selected.id)) return;
              selected.status = "unavailable";
              selected.errorCode = /^work_usage_[a-z_]+$/u.test(
                error?.code ?? "",
              )
                ? error.code
                : "work_usage_unavailable";
            })
            .finally(() => {
              if (active === selected) active = null;
            });
        }
      }
      entry.touched = clock();
      // A retained report is read-only and has its own immutable identity.
      // The pending build keeps a separate ID; no old cursor can address it.
      const retained = q.action !== "touch" && entry.status !== "available"
        && entry.retained && !q.cursor
        && (entry.retained.namesAvailable || ![q.project, q.worktree, q.thread, q.findThread, q.search].some(Boolean))
        ? entry.retained : null;
      const base = {
        schemaVersion: WORK_USAGE_SCHEMA,
        status: retained ? "available" : entry.status,
        snapshotId: retained?.id ?? entry.id,
        fromMs: retained?.fromMs ?? entry.fromMs,
        toMs: retained?.toMs ?? entry.toMs,
        ...(retained ? { retained: true, refreshing: entry.status === "preparing",
          refreshSnapshotId: entry.status === "preparing" ? entry.id : null,
          namesAvailable: retained.namesAvailable } : {}),
        errorCode: entry.errorCode ?? null,
      };
      // A visible report renews its idle lease without repeating aggregation,
      // name enrichment, or cursor allocation. Expired reports stay expired.
      if (q.action === "touch" || base.status !== "available") return base;
      const result = retained?.result ?? entry.result;
      const selected = { ...q, offset: 0 };
      if (q.findThread)
        selected.thread = result.threadLookup[q.findThread] ?? "not-found";
      if (q.search) {
        const key = retained ? "retainedSearchIndex" : "searchIndex";
        entry[key] ??= createSearchIndex(result, enrich);
        const index = await entry[key];
        selected.searchMatches = { projects: new Set(), threads: new Set() };
        for (const [id, name] of index.projects) if (name.includes(q.search)) selected.searchMatches.projects.add(id);
        for (const [id, name] of index.threads) if (name.includes(q.search)) selected.searchMatches.threads.add(result.threadFamilies?.[id] ?? id);
      }
      const filterKey = JSON.stringify([
        q.grouping,
        q.project,
        q.worktree,
        selected.thread,
        q.model,
        q.sort,
        q.pageSize,
        q.search || undefined,
      ]);
      if (q.cursor) {
        const cursor = entry.cursors.get(q.cursor);
        if (!cursor || cursor.key !== filterKey)
          throw workUsageError("work_usage_snapshot_changed");
        selected.offset = cursor.offset;
      }
      const report = queryWorkUsageSnapshot(result, selected);
      let nextCursor = null;
      if (!retained && report.nextOffset !== null) {
        const existing = [...entry.cursors].find(
          ([, c]) => c.key === filterKey && c.offset === report.nextOffset,
        );
        nextCursor = existing?.[0] ?? newId();
        if (!existing) {
          if (entry.cursors.size >= 4096)
            throw workUsageError("work_usage_capacity_exceeded");
          entry.cursors.set(nextCursor, {
            key: filterKey,
            offset: report.nextOffset,
          });
        }
      }
      const display = retained?.namesAvailable === false ? {} : await enrich({ result, rows: report.rows });
      if (!snapshots.has(entry.id) || entry.controller.signal.aborted)
        throw workUsageError("work_usage_snapshot_expired");
      return {
        ...base,
        generation: result.generation,
        scope: result.scope,
        scopes: result.scopes,
        metadata: result.metadata,
        pricing: result.pricing,
        models: result.models,
        ...report,
        nextOffset: undefined,
        nextCursor,
        offset: selected.offset,
        display,
      };
    },
  };
}
