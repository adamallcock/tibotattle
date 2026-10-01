// Tier F: production's native graph computation forced for every owner, for
// today's fits and every model date, on scratch copies of a converged run.
//
// Each (owner, metric, day) runs d43c8f92's computeStorageGraphResult with the
// options its model-block fallback uses (prepared fold off, prepared effective
// usage off, no shared features, result not persisted), re-invoked while it
// defers, so every invocation stays inside production's 1,000-statement
// invocation meter (createD1InvocationBudget refuses more) and reloads its
// checkpoint exactly as successive scheduled passes do. The clock is pinned, so
// deadlines never cut a pass; only the statement meter bounds each call.
//
// The scratch analytics copy has every graph cache and checkpoint cleared
// first, and the checkpoints of each completed scope are cleared before the
// next, so no result is reused; the source copy is opened read-only, so the
// computation provably writes nothing to ingestion state.
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const GRAPH_CACHE_TABLES = Object.freeze([
  "analytics_community_graph_results", "analytics_community_graph_execution", "analytics_community_graph_scan",
  "analytics_community_graph_work_selection", "analytics_history_checkpoint_heads",
  "analytics_history_checkpoint_parts", "analytics_history_checkpoint_stages",
]);
const CHECKPOINT_TABLES = Object.freeze(["analytics_history_checkpoint_heads",
  "analytics_history_checkpoint_parts", "analytics_history_checkpoint_stages"]);
/** Production's per-invocation ceiling (d1-invocation-budget.ts). */
const INVOCATION_QUERIES = 1_000;
/** A scope that defers this many times in a row without moving any checkpoint head is stuck. */
const STALL_LIMIT = 8;

function counted(database, counter) {
  return new Proxy(database, { get(target, property) {
    const value = Reflect.get(target, property);
    if (property === "prepare") return (sql) => { counter.n++; return target.prepare(sql); };
    if (property === "batch") return (statements) => { counter.n += statements.length; return target.batch(statements); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function headsDigest(target) {
  const row = await target.prepare(`SELECT COUNT(*) AS n,COALESCE(group_concat(key_digest||':'||COALESCE(generation,'-'),','),'') AS v
    FROM (SELECT * FROM analytics_history_checkpoint_heads ORDER BY key_digest)`).first();
  return `${row.n}:${row.v}`;
}

async function computeScope({ P, scratch, bindings, owner, metric, day, nowMs }) {
  const started = performance.now(), startedStatements = scratch.counter.n;
  const cost = () => ({ ms: Math.round(performance.now() - started), statements: scratch.counter.n - startedStatements });
  let invocations = 0, stalled = 0, lastReason = null, maxCheckpointParts = 0, maxCheckpointBytes = 0;
  try {
    const scope = await P.captureStorageGraphScope(scratch.source, { owner, day, metric,
      sourceId: bindings.sourceId, sourceNamespace: bindings.sourceNamespace, preparedFold: false });
    let heads = await headsDigest(scratch.rawTarget);
    for (;;) {
      invocations++;
      const outcome = await P.computeStorageGraphResult({ ...bindings, source: scratch.source, target: scratch.target },
        scope, { maxQueries: INVOCATION_QUERIES, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => nowMs,
          preparedFold: false, preparedEffectiveUsage: false, persistResult: false });
      const parts = await scratch.rawTarget.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(payload_bytes),0) AS bytes
        FROM analytics_history_checkpoint_parts p JOIN analytics_history_checkpoint_heads h
          ON h.key_digest=p.key_digest AND h.generation=p.generation`).first();
      maxCheckpointParts = Math.max(maxCheckpointParts, parts.n);
      maxCheckpointBytes = Math.max(maxCheckpointBytes, parts.bytes);
      if (outcome.state === "complete") {
        const payload = metric === "fits" ? P.canonicalJson(outcome.result.fits) : P.canonicalJson(outcome.result.composition);
        return { state: "complete", sourceKind: scope.source, payload,
          cost: { ...cost(), invocations, maxCheckpointParts, maxCheckpointBytes } };
      }
      lastReason = outcome.reason;
      const next = await headsDigest(scratch.rawTarget);
      stalled = next === heads ? stalled + 1 : 0;
      heads = next;
      if (stalled >= STALL_LIMIT) {
        return { state: "deferred", reason: lastReason, failure: outcome.failure ?? null,
          cost: { ...cost(), invocations, maxCheckpointParts, maxCheckpointBytes } };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "failed", code: /^[A-Za-z][A-Za-z0-9_ :.-]{2,120}$/u.test(message) ? message : "unclosed_error",
      cost: { ...cost(), invocations, maxCheckpointParts, maxCheckpointBytes } };
  } finally {
    // Independence: the next scope starts with no checkpoint at all.
    await scratch.rawTarget.batch(CHECKPOINT_TABLES.map((table) => scratch.rawTarget.prepare(`DELETE FROM ${table}`)));
  }
}

/**
 * Run Tier F over the converged databases in `dbDir`. Returns per owner key
 * (resolved by `ownerKeyOf(ownerDigest)`) the fits result and one result per
 * model date `datesFor(key)` names (default: all), each with its cost (wall
 * ms, statements, invocations, peak checkpoint parts and bytes).
 */
export async function runForcedNative({ P, openSealedSqliteD1, dbDir, scratchDir, files, bindings, nowMs, today,
  modelDates, ownerKeyOf, owners = null, datesFor = () => modelDates, onOwner = () => {}, keepScratch = false }) {
  mkdirSync(scratchDir, { recursive: true });
  const scratchSource = join(scratchDir, files.source), scratchTarget = join(scratchDir, files.target);
  rmSync(scratchSource, { force: true }); rmSync(scratchTarget, { force: true });
  copyFileSync(join(dbDir, files.source), scratchSource);
  copyFileSync(join(dbDir, files.target), scratchTarget);
  chmodSync(scratchSource, 0o400); chmodSync(scratchTarget, 0o600);
  const sourceHandle = openSealedSqliteD1(scratchSource, { readOnly: true, pinnedNowMs: nowMs });
  const targetHandle = openSealedSqliteD1(scratchTarget, { pinnedNowMs: nowMs });
  const results = {};
  const started = performance.now();
  const counter = { n: 0 };
  try {
    await targetHandle.database.batch(GRAPH_CACHE_TABLES.map((table) => targetHandle.database.prepare(`DELETE FROM ${table}`)));
    const scratch = { source: counted(sourceHandle.database, counter), target: counted(targetHandle.database, counter),
      rawTarget: targetHandle.database, counter };
    const page = await P.readStorageCommunityOwnerPage(sourceHandle.database);
    for (const owner of page) {
      const key = ownerKeyOf(owner.ownerDigest);
      if (owners !== null && !owners.includes(key)) continue;
      const entry = results[key] = { fits: null, model: {} };
      entry.fits = await computeScope({ P, scratch, bindings, owner, metric: "fits", day: today, nowMs });
      for (const day of datesFor(key)) {
        entry.model[day] = await computeScope({ P, scratch, bindings, owner, metric: "model", day, nowMs });
      }
      onOwner(key, entry);
    }
  } finally {
    sourceHandle.close(); targetHandle.close();
    if (!keepScratch) rmSync(scratchDir, { recursive: true, force: true });
  }
  return { results, cost: { ms: Math.round(performance.now() - started), statements: counter.n } };
}
