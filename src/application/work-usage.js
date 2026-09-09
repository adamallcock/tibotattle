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
  "scope",
  "grouping",
  "project",
  "worktree",
  "thread",
  "findThread",
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
    !["query", "cancel"].includes(q.action) ||
    !Object.hasOwn(PERIODS, q.period) ||
    !["project", "thread", "worktree"].includes(q.grouping) ||
    !["tokens", "cost", "recent"].includes(q.sort) ||
    !Number.isInteger(q.pageSize) ||
    q.pageSize < 1 ||
    q.pageSize > 100
  )
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
  return q;
}

/** Process-local immutable reports. Jobs never block HTTP or retain source content. */
export function createWorkUsageService({
  build,
  enrich = async () => ({}),
  clock = Date.now,
  newId = randomUUID,
  idleMs = 300_000,
  maximumSnapshots = 2,
} = {}) {
  const snapshots = new Map();
  let active = null;
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
      clearInterval(expiryTimer);
      for (const entry of snapshots.values()) dispose(entry);
    },
    async query(input) {
      const q = validateWorkUsageQuery(input);
      sweep();
      const source = q.sourceSnapshotId ? snapshots.get(q.sourceSnapshotId) : null;
      if (q.sourceSnapshotId && !source) throw workUsageError("work_usage_snapshot_expired");
      if (source && source.status !== "available") throw workUsageError("work_usage_snapshot_changed");
      // Capture before capacity eviction: related periods share the displayed
      // accounting instant, even when the original build took a long time.
      const anchorToMs = source?.toMs ?? null;
      const expectedGeneration = source?.result?.generation?.fingerprint ?? source?.result?.generation;
      let entry = q.snapshotId ? snapshots.get(q.snapshotId) : null;
      if (q.snapshotId && !entry)
        throw workUsageError("work_usage_snapshot_expired");
      if (q.action === "cancel") {
        dispose(entry);
        return { schemaVersion: WORK_USAGE_SCHEMA, status: "cancelled" };
      }
      if (
        entry &&
        (entry.period !== q.period ||
          (q.scope !== undefined && entry.requestedScope !== q.scope))
      )
        throw workUsageError("work_usage_snapshot_changed");
      if (!entry) {
        if (
          active &&
          active.period === q.period &&
          active.requestedScope === q.scope &&
          active.anchorToMs === anchorToMs &&
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
          entry = {
            id: newId(),
            period: q.period,
            requestedScope: q.scope,
            anchorToMs,
            expectedGeneration,
            fromMs: duration === null ? 0 : Math.max(0, now - duration),
            toMs: now,
            touched: now,
            controller: new AbortController(),
            status: "preparing",
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
              if (result.status === "available" && result.toMs !== undefined) {
                const duration = PERIODS[selected.period];
                if (!Number.isSafeInteger(result.toMs) || result.toMs > selected.toMs
                    || !Number.isSafeInteger(result.fromMs)
                    || result.fromMs !== (duration === null ? 0 : Math.max(0, result.toMs - duration))) {
                  throw workUsageError("work_usage_snapshot_changed");
                }
                selected.fromMs = result.fromMs;
                selected.toMs = result.toMs;
              }
              selected.result = result;
              selected.status = result.status;
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
      const base = {
        schemaVersion: WORK_USAGE_SCHEMA,
        status: entry.status,
        snapshotId: entry.id,
        fromMs: entry.fromMs,
        toMs: entry.toMs,
        errorCode: entry.errorCode ?? null,
      };
      if (entry.status !== "available") return base;
      const result = entry.result;
      const selected = { ...q, offset: 0 };
      if (q.findThread)
        selected.thread = result.threadLookup[q.findThread] ?? "not-found";
      const filterKey = JSON.stringify([
        q.grouping,
        q.project,
        q.worktree,
        selected.thread,
        q.model,
        q.sort,
        q.pageSize,
      ]);
      if (q.cursor) {
        const cursor = entry.cursors.get(q.cursor);
        if (!cursor || cursor.key !== filterKey)
          throw workUsageError("work_usage_snapshot_changed");
        selected.offset = cursor.offset;
      }
      const report = queryWorkUsageSnapshot(result, selected);
      let nextCursor = null;
      if (report.nextOffset !== null) {
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
      const display = await enrich({ result, rows: report.rows });
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
