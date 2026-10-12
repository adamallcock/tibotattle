// Direct native reference: production's effective-history analysis called
// directly, without Worker budget slicing.
//
// For each (owner, metric, day) this runs exactly what d43c8f92's
// computeStorageGraphResult does for an effective owner, minus the scheduler:
//
//   window      = modelHistoryWindow(day)
//   dependency  = effectiveHistoryDependency(source, owner, namespace, window.fromDay, window.day)
//   pin         = effectiveHistoryPin(owner, window.fromDay, window.day, dependency)
//   loop advanceStorageEffectiveAnalysis({ source, sourceNamespace, owner, pin, day: window.day, metric,
//     nowMs: Date.parse(window.fixedNow), checkpoint,
//     budget: { remainingQueries: 1e9, deadlineMs: far future, now: pinned } })
//   while it returns 'deferred', keeping the returned checkpoint in memory,
//
// with no preparedQuota, preparedUsage or preparedUsageReader. That is what
// computeEffective passes whenever the owner's shared feature window is
// refused (a refused day or more than 8 MiB of feature payloads) or shared
// features are off, because STORAGE_V11_PREPARED_FOLD is false at d43c8f92;
// it is also the model-block fallback's configuration. The completed analysis
// is validated and serialized as the publisher stores it:
//
//   fits   validCompleteScalarAnalysis(analysis, 'v1.1', pin.fingerprint, true), then
//          canonicalJson(selectCommunityAllowanceAnalysisFits(ownerDigest, [{ source: 'v1.1', analysis }]))
//   model  validCompleteCachedComposition(analysis, pin.fingerprint, V11_PLAN_ATTRIBUTION_ADAPTER_VERSION),
//          then canonicalJson(analysis)
//
// The source is opened read-only. Each analysis step reads one 200-row page,
// so `steps` is the native page count. Results do not depend on which process
// computes them, so `jobs` > 1 splits the work across child processes
// (direct-native-child.mjs), largest windows first.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNBOUNDED_QUERIES = 1_000_000_000;
/** d43c8f92 storage-community-graph.ts MAX_RESULT_BYTES: a larger payload defers as result_size_limit. */
const MAX_RESULT_BYTES = 1024 * 1024;

function counted(database, counter) {
  return new Proxy(database, { get(target, property) {
    const value = Reflect.get(target, property);
    if (property === "prepare") return (sql) => { counter.n++; return target.prepare(sql); };
    if (property === "batch") return (statements) => { counter.n += statements.length; return target.batch(statements); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function computeDirect({ P, source, counter, sourceNamespace, owner, metric, day, nowMs }) {
  const started = performance.now(), startedStatements = counter.n;
  const cost = (steps) => ({ ms: Math.round(performance.now() - started), statements: counter.n - startedStatements, steps });
  let steps = 0;
  try {
    if (owner.hasEffective !== true || !/^[a-f0-9]{64}$/u.test(owner.ownerDigest ?? "")) throw new Error("DIRECT_NATIVE_OWNER_NOT_EFFECTIVE");
    const window = P.modelHistoryWindow(day);
    const dependency = await P.effectiveHistoryDependency(source, owner, sourceNamespace, window.fromDay, window.day);
    const pin = await P.effectiveHistoryPin(owner, window.fromDay, window.day, dependency);
    const analysisNowMs = Date.parse(window.fixedNow);
    let checkpoint = null;
    for (;;) {
      steps++;
      const next = await P.advanceStorageEffectiveAnalysis({ source, sourceNamespace, owner, pin, day: window.day, metric,
        nowMs: analysisNowMs, checkpoint,
        budget: { remainingQueries: UNBOUNDED_QUERIES, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => nowMs } });
      if (next.status === "complete") {
        let payload;
        if (metric === "fits") {
          if (!P.validCompleteScalarAnalysis(next.analysis, "v1.1", pin.fingerprint, true)) throw new Error("DIRECT_NATIVE_SCALAR_INVALID");
          payload = P.canonicalJson(P.selectCommunityAllowanceAnalysisFits(owner.ownerDigest, [{ source: "v1.1", analysis: next.analysis }]));
        } else {
          if (!P.validCompleteCachedComposition(next.analysis, pin.fingerprint, P.V11_PLAN_ATTRIBUTION_ADAPTER_VERSION)) {
            throw new Error("DIRECT_NATIVE_COMPOSITION_INVALID");
          }
          payload = P.canonicalJson(next.analysis);
        }
        const bytes = Buffer.byteLength(payload);
        return { state: bytes > MAX_RESULT_BYTES ? "result_size_limit" : "complete", payload, bytes,
          window: { fromDay: window.fromDay, day: window.day }, cost: cost(steps) };
      }
      // An unbounded budget never needs a fresh invocation, so a step that
      // returns no successor would repeat forever: report it instead.
      if (!next.checkpoint) return { state: "stalled", cost: cost(steps) };
      checkpoint = next.checkpoint;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "failed", code: /^[A-Za-z][A-Za-z0-9_ :.-]{2,120}$/u.test(message) ? message : "unclosed_error",
      cost: cost(steps) };
  }
}

/** Run `tasks` ({ownerDigest, metric, day}) in this process over the read-only source. */
export async function runDirectTasks({ P, openSealedSqliteD1, sourcePath, sourceNamespace, nowMs, tasks, onTask = () => {} }) {
  const handle = openSealedSqliteD1(sourcePath, { readOnly: true, pinnedNowMs: nowMs });
  const counter = { n: 0 };
  const out = [];
  try {
    const source = counted(handle.database, counter);
    const owners = new Map((await P.readStorageCommunityOwnerPage(handle.database)).map((owner) => [owner.ownerDigest, owner]));
    for (const task of tasks) {
      const owner = owners.get(task.ownerDigest);
      if (!owner) throw new Error("DIRECT_NATIVE_OWNER_UNKNOWN");
      const result = await computeDirect({ P, source, counter, sourceNamespace, owner, metric: task.metric, day: task.day, nowMs });
      out.push({ ...task, result });
      onTask(task, result);
    }
  } finally { handle.close(); }
  return out;
}

/**
 * Every owner's fits for `today` and the model dates `datesFor(key)` names.
 * `weight(task)` orders the work (largest first) and balances it across
 * `jobs` child processes. Returns { results: {key: {fits, model: {day}}}, cost }.
 */
export async function runDirectNative({ P, openSealedSqliteD1, sourcePath, sourceNamespace, nowMs, today, modelDates,
  ownerKeyOf, datesFor = () => modelDates, weight = () => 1, jobs = 1, child = null, scratchDir, onTask = () => {} }) {
  const started = performance.now();
  const handle = openSealedSqliteD1(sourcePath, { readOnly: true, pinnedNowMs: nowMs });
  let page;
  try { page = await P.readStorageCommunityOwnerPage(handle.database); } finally { handle.close(); }
  const tasks = page.flatMap((owner) => [{ ownerDigest: owner.ownerDigest, metric: "fits", day: today },
    ...datesFor(ownerKeyOf(owner.ownerDigest)).map((day) => ({ ownerDigest: owner.ownerDigest, metric: "model", day }))]);
  const order = new Map(tasks.map((task, index) => [`${task.ownerDigest}:${task.metric}:${task.day}`, index]));
  const byWeight = [...tasks].sort((left, right) => weight(right) - weight(left)
    || order.get(`${left.ownerDigest}:${left.metric}:${left.day}`) - order.get(`${right.ownerDigest}:${right.metric}:${right.day}`));
  let done;
  if (jobs <= 1) {
    done = await runDirectTasks({ P, openSealedSqliteD1, sourcePath, sourceNamespace, nowMs, tasks: byWeight, onTask });
  } else {
    if (!child || !scratchDir) throw new Error("DIRECT_NATIVE_CHILD_REQUIRED");
    // Longest-processing-time assignment by estimated weight.
    const groups = Array.from({ length: jobs }, () => ({ load: 0, tasks: [] }));
    for (const task of byWeight) {
      const target = groups.reduce((best, group) => group.load < best.load ? group : best, groups[0]);
      target.tasks.push(task); target.load += weight(task);
    }
    mkdirSync(scratchDir, { recursive: true });
    const outputs = await Promise.all(groups.map(async (group, index) => {
      if (group.tasks.length === 0) return [];
      const specPath = join(scratchDir, `direct-${index}.json`), outPath = join(scratchDir, `direct-${index}.out.json`);
      writeFileSync(specPath, JSON.stringify({ ...child.spec, sourcePath, sourceNamespace, nowMs, tasks: group.tasks, outPath }));
      const exit = await new Promise((resolveExit) => {
        const process_ = spawn(child.node, [...child.execArgv, child.script, specPath], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "", buffer = "";
        process_.stdout.on("data", (chunk) => {
          buffer += chunk;
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try { const event = JSON.parse(line); onTask(event.task, event.result); } catch { /* not an event */ }
          }
        });
        process_.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
        process_.once("exit", (exitCode) => resolveExit({ exitCode, stderr }));
      });
      if (exit.exitCode !== 0) throw new Error(`DIRECT_NATIVE_CHILD_FAILED:${index}:${exit.stderr.slice(-400)}`);
      return JSON.parse(readFileSync(outPath, "utf8"));
    }));
    done = outputs.flat();
    rmSync(scratchDir, { recursive: true, force: true });
  }
  const results = {};
  for (const owner of page) results[ownerKeyOf(owner.ownerDigest)] = { fits: null, model: {} };
  done.sort((left, right) => order.get(`${left.ownerDigest}:${left.metric}:${left.day}`)
    - order.get(`${right.ownerDigest}:${right.metric}:${right.day}`));
  for (const item of done) {
    const entry = results[ownerKeyOf(item.ownerDigest)];
    if (item.metric === "fits") entry.fits = item.result; else entry.model[item.day] = item.result;
  }
  return { results, cost: { ms: Math.round(performance.now() - started), jobs,
    statements: done.reduce((n, item) => n + item.result.cost.statements, 0),
    steps: done.reduce((n, item) => n + item.result.cost.steps, 0),
    taskMs: done.reduce((n, item) => n + item.result.cost.ms, 0) } };
}
