import { readMeasPgStat, measPgStatDelta } from "./meas-pgstat.mjs";

// The local diagnostic retains fingerprints/counters, never SQL text.
export function withoutStatementText(evidence) {
  return { ...evidence, statements: evidence.statements?.map(({ text: _text, ...figures }) => figures) ?? null };
}
export async function capturePgStat(pool, label) {
  const client = await pool.connect();
  try { return withoutStatementText(await readMeasPgStat(client, { label })); }
  finally { client.release(); }
}
export function pgStatDelta(before, after) {
  return withoutStatementText(measPgStatDelta(before, after));
}
/** Before completes before run spawns; after starts only after exit and pending sampling drains. */
export async function refreshPgStatLifecycle({ run, snapshot = null, intervalMs = 30_000,
  maxDuring = 2880, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (snapshot === null) return { result: await run(), evidence: null };
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_800_000
      || !Number.isSafeInteger(maxDuring) || maxDuring < 1 || maxDuring > 2880) {
    throw Object.assign(new Error("MEAS_PGSTAT_INTERVAL_INVALID"), { code: "MEAS_PGSTAT_INTERVAL_INVALID" });
  }
  const before = await snapshot("refresh-before");
  const during = [], errors = [];
  let active = true, timer = null, pending = Promise.resolve(), attempted = 0;
  const tick = () => {
    if (!active || attempted >= maxDuring) return;
    attempted++;
    pending = Promise.resolve().then(() => snapshot(`refresh-during-${attempted}`))
      .then((sample) => { during.push(sample); }, (error) => {
        errors.push({ label: `refresh-during-${attempted}`, code: /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "") ? error.code : "MEAS_PGSTAT_SAMPLE_FAILED" });
      }).then(() => { if (active && attempted < maxDuring) timer = schedule(tick, intervalMs); });
  };
  timer = schedule(tick, intervalMs);
  let result, failure, failed = false;
  const childStartedAt = new Date().toISOString();
  let childExitedAt;
  try { result = await run(); } catch (error) { failure = error; failed = true; }
  finally { childExitedAt = new Date().toISOString(); active = false; cancel(timer); await pending; }
  // Preserve a child failure even if the final statistics snapshot also fails.
  let after;
  try { after = await snapshot("refresh-after"); } catch (error) { if (!failed) throw error; }
  if (failed) throw failure;
  return { result, evidence: { scope: "refresh-child-window",
    limitations: ["diagnostic queries included", "IO and WAL counters are cluster-wide",
      "ranked statement retention may omit prior rows", "statement reset continuity is not independently established"],
    childStartedAt, childExitedAt, intervalMs, maxDuring,
    saturated: attempted >= maxDuring, before, during, after, delta: pgStatDelta(before, after), errors } };
}
