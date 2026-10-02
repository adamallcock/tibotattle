// Per-owner-day cache-retention reference: production's effective day build
// called directly for every owner-day with usage, without the lane.
//
// The scheduled lane builds an owner's days oldest first and only after it has
// proved each day's source dependency, and the dependency of each of its seven
// lookback days, against the daily lane's effective owner rows
// (createCacheRetentionDaySourceBuild). A lookback day the daily lane never
// publishes (a conflict-blocked day) has no owner row, so its recorded digest
// is empty while the source holds rows for it: every later day of every owner
// is then skipped as `owner_source_unavailable` on every pass (measured on the
// Q-1 and dense corpora, whose 2026-04-17/18 conflict blocks the daily lane).
// The lane therefore never reaches most owner-days, and its values cannot
// serve as a per-owner-day reference.
//
// For each (owner, day) this computes what the lane's build returns once it
// gets there, with d43c8f92's own functions:
//
//   candidate  the effective key { sourceLayout 'effective', deviceId
//              CACHE_RETENTION_EFFECTIVE_DEVICE_ID, manifestId
//              CACHE_RETENTION_EFFECTIVE_MANIFEST_ID, day } whose manifestDigest
//              is sha256(canonicalJson(effectiveHistoryDependency(source,
//              owner, namespace, day, day, {includeSessions: true}))), the
//              digest the source build proves;
//   carry      the seven cacheRetentionLookbackDays, each with the same digest
//              of its own dependency, or '' when that day has no source rows
//              (the source build's own emptiness rule);
//   aggregate  createCacheRetentionEffectiveDayBuild({source, target, ...})
//              (candidate, carry, {deadlineMs: far future, remainingQueries:
//              unbounded}): the native page reader, the seven-day lookback
//              and the v2 reducer, with its progress envelope written to a
//              scratch target.
//
// The rows are the aggregate's groups and bands exactly as
// writeCacheRetentionDay stores them (one row per model, effort and band with
// its seven counters). A recorded refusal (CacheRetentionRefusedError) or a
// deferral (CacheRetentionDeferredError) is reported per day; with an
// unbounded budget a deferral means the build can never finish that day.
// Builds are independent of each other, so `jobs` > 1 splits the days across
// child processes (cache-days-child.mjs), each with its own scratch target.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, constants as fsConstants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_RETENTION_TABLES } from "./settled-cache.mjs";

const UNBOUNDED = 1_000_000_000_000;
const OWNER_DAY_SPANS = Object.freeze([["2026-03-01", "2026-06-09"], ["2026-06-10", "2026-09-17"], ["2026-09-18", "2026-12-26"]]);

async function dependencyDigest(P, source, owner, sourceNamespace, day) {
  const dependency = await P.effectiveHistoryDependency(source, owner, sourceNamespace, day, day, { includeSessions: true });
  const populated = dependency.v1.length > 0 || dependency.v11.length > 0 || dependency.v12.length > 0
    || dependency.corrections.length > 0 || dependency.occurrenceLinks.length > 0;
  return { digest: await P.sha256Hex(P.canonicalJson(dependency)), populated };
}

/** Every owner's usage days (readEffectiveTelemetryOwnerDays over 101-day spans). */
export async function cacheOwnerDays({ P, source, sourceNamespace, owners }) {
  const out = [];
  for (const owner of owners) {
    const days = new Set();
    for (const [fromDay, throughDay] of OWNER_DAY_SPANS) {
      for (const day of await P.readEffectiveTelemetryOwnerDays(source, { sourceNamespace, ownerDigest: owner.ownerDigest,
        ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch, stream: "usage", fromDay, throughDay })) days.add(day);
    }
    for (const day of [...days].sort()) out.push({ ownerDigest: owner.ownerDigest, day });
  }
  return out;
}

function rowsOf(aggregate) {
  const rows = [];
  for (const group of aggregate.groups) {
    for (const band of group.bands) {
      rows.push({ layout: "effective", method: aggregate.methodVersion, model: group.model, effort: group.effort, band: band.band,
        adjacencies: band.adjacencies, reusedMoreThanHalf: band.reusedMoreThanHalf, matchedOrExceeded: band.matchedOrExceeded,
        unorderedTies: band.unorderedTies, excludedInsufficientEvidence: band.excludedInsufficientEvidence,
        excludedContextContracted: band.excludedContextContracted, sessions: band.sessions });
    }
  }
  // The stored-row order the Tier N capture uses: model, effort, band.
  const key = (row) => `${row.model}\u0000${row.effort}\u0000${row.band}`;
  return rows.sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

/**
 * Run `tasks` ({ownerDigest, day}) in this process; the target is a scratch
 * copy this call owns. Its cache-retention rows are deleted first, so no day
 * resumes another run's progress envelope or meets an existing mark.
 */
export async function runCacheDayTasks({ P, openSealedSqliteD1, sourcePath, targetPath, sourceId, sourceNamespace, nowMs,
  tasks, onTask = () => {} }) {
  const sourceHandle = openSealedSqliteD1(sourcePath, { readOnly: true, pinnedNowMs: nowMs });
  const targetHandle = openSealedSqliteD1(targetPath, { pinnedNowMs: nowMs });
  const out = [];
  try {
    const source = sourceHandle.database, target = targetHandle.database;
    await target.batch(CACHE_RETENTION_TABLES.map((table) => target.prepare(`DELETE FROM ${table}`)));
    const owners = new Map((await P.readStorageCommunityOwnerPage(source)).map((owner) => [owner.ownerDigest, owner]));
    for (const task of tasks) {
      const owner = owners.get(task.ownerDigest);
      if (!owner) throw new Error("DENSE_ORACLE_CACHE_OWNER_UNKNOWN");
      const started = performance.now();
      let result;
      try {
        const own = await dependencyDigest(P, source, owner, sourceNamespace, task.day);
        const carry = [];
        for (const day of P.cacheRetentionLookbackDays(task.day)) {
          const value = await dependencyDigest(P, source, owner, sourceNamespace, day);
          carry.push({ day, manifestDigest: value.populated ? value.digest : "" });
        }
        const candidate = { sourceId, sourceLayout: "effective", sourceNamespace, ownerDigest: owner.ownerDigest,
          deviceId: P.CACHE_RETENTION_EFFECTIVE_DEVICE_ID, manifestId: P.CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
          manifestDigest: own.digest, day: task.day };
        const build = P.createCacheRetentionEffectiveDayBuild({ source, target, sourceNamespace, ownerDigest: owner.ownerDigest,
          ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch, now: () => nowMs });
        const aggregate = await build(candidate, carry, { deadlineMs: Number.MAX_SAFE_INTEGER, remainingQueries: UNBOUNDED });
        result = { state: "built", eventsRead: aggregate.eventsRead, unreadableEvents: aggregate.unreadableEvents,
          carryDays: carry.filter((value) => value.manifestDigest !== "").length, rows: rowsOf(aggregate) };
      } catch (error) {
        if (error instanceof P.CacheRetentionRefusedError) result = { state: "refused", reason: error.reason };
        else if (error instanceof P.CacheRetentionDeferredError) result = { state: "deferred", reason: error.reason };
        else {
          const message = error instanceof Error ? error.message : String(error);
          result = { state: "failed", code: /^[A-Za-z][A-Za-z0-9_ :.-]{2,120}$/u.test(message) ? message : "unclosed_error" };
        }
      }
      result.ms = Math.round(performance.now() - started);
      out.push({ ...task, result });
      onTask(task, result);
    }
  } finally { sourceHandle.close(); targetHandle.close(); }
  return out;
}

/**
 * The reference for every owner-day with usage. `dbDir` holds the run's
 * source and analytics files (`files`); each process works on its own clones.
 * Returns { ownerDays: {`${key}:${day}`: rows}, days: {`${key}:${day}`: outcome}, cost }.
 */
export async function runCacheDays({ P, openSealedSqliteD1, dbDir, files, scratchDir, sourceId, sourceNamespace, nowMs,
  ownerKeyOf, jobs = 1, child = null, onTask = () => {} }) {
  const started = performance.now();
  mkdirSync(scratchDir, { recursive: true });
  const sourcePath = join(scratchDir, files.source);
  rmSync(sourcePath, { force: true });
  copyFileSync(join(dbDir, files.source), sourcePath, fsConstants.COPYFILE_FICLONE);
  chmodSync(sourcePath, 0o400);
  const cloneTarget = (name) => {
    const path = join(scratchDir, name);
    rmSync(path, { force: true });
    copyFileSync(join(dbDir, files.target), path, fsConstants.COPYFILE_FICLONE);
    chmodSync(path, 0o600);
    return path;
  };
  const handle = openSealedSqliteD1(sourcePath, { readOnly: true, pinnedNowMs: nowMs });
  let tasks, weights;
  try {
    const owners = await P.readStorageCommunityOwnerPage(handle.database);
    tasks = await cacheOwnerDays({ P, source: handle.database, sourceNamespace, owners });
    // Work weight: usage rows of the day and its lookback (chunk headers).
    const counts = new Map();
    for (const row of (await handle.database.prepare(`SELECT l.owner_digest AS owner,c.chunk_day AS day,SUM(c.record_count) AS n
      FROM (SELECT participant_id,chunk_day,record_count FROM telemetry_v12_chunks WHERE stream='usage'
        UNION ALL SELECT participant_id,chunk_day,record_count FROM telemetry_v11_chunks WHERE stream='usage') c
      JOIN storage_v11_owner_links l ON l.participant_id=c.participant_id AND l.state='active' GROUP BY 1,2`).all()).results) {
      counts.set(`${row.owner}:${row.day}`, row.n);
    }
    weights = new Map(tasks.map((task) => [`${task.ownerDigest}:${task.day}`, 2 * (counts.get(`${task.ownerDigest}:${task.day}`) ?? 1)
      + P.cacheRetentionLookbackDays(task.day).reduce((n, day) => n + (counts.get(`${task.ownerDigest}:${day}`) ?? 0), 0)]));
  } finally { handle.close(); }
  const order = new Map(tasks.map((task, index) => [`${task.ownerDigest}:${task.day}`, index]));
  const weight = (task) => weights.get(`${task.ownerDigest}:${task.day}`);
  const byWeight = [...tasks].sort((left, right) => weight(right) - weight(left)
    || order.get(`${left.ownerDigest}:${left.day}`) - order.get(`${right.ownerDigest}:${right.day}`));
  let done;
  if (jobs <= 1) {
    done = await runCacheDayTasks({ P, openSealedSqliteD1, sourcePath, targetPath: cloneTarget("target-0.sqlite"), sourceId,
      sourceNamespace, nowMs, tasks: byWeight, onTask });
  } else {
    if (!child) throw new Error("DENSE_ORACLE_CACHE_CHILD_REQUIRED");
    const groups = Array.from({ length: jobs }, () => ({ load: 0, tasks: [] }));
    for (const task of byWeight) {
      const target = groups.reduce((best, group) => group.load < best.load ? group : best, groups[0]);
      target.tasks.push(task); target.load += weight(task);
    }
    const outputs = await Promise.all(groups.map(async (group, index) => {
      if (group.tasks.length === 0) return [];
      const specPath = join(scratchDir, `cache-${index}.json`), outPath = join(scratchDir, `cache-${index}.out.json`);
      writeFileSync(specPath, JSON.stringify({ ...child.spec, sourcePath, targetPath: cloneTarget(`target-${index}.sqlite`),
        sourceId, sourceNamespace, nowMs, tasks: group.tasks, outPath }));
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
      if (exit.exitCode !== 0) throw new Error(`DENSE_ORACLE_CACHE_CHILD_FAILED:${index}:${exit.stderr.slice(-400)}`);
      return JSON.parse(readFileSync(outPath, "utf8"));
    }));
    done = outputs.flat();
  }
  done.sort((left, right) => order.get(`${left.ownerDigest}:${left.day}`) - order.get(`${right.ownerDigest}:${right.day}`));
  const ownerDays = {}, days = {};
  for (const item of done) {
    const key = `${ownerKeyOf(item.ownerDigest)}:${item.day}`;
    const { rows, ms: _ms, ...outcome } = item.result;
    days[key] = outcome;
    if (rows && rows.length > 0) ownerDays[key] = rows;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  return { ownerDays, days, cost: { ms: Math.round(performance.now() - started), jobs, tasks: done.length,
    taskMs: done.reduce((n, item) => n + item.result.ms, 0) } };
}
