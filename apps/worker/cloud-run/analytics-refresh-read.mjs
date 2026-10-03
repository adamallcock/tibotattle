/**
 * analytics-refresh read side (K-SPLIT): the snapshot read pool the Job's
 * A-1 readers run through, its per-statement ledger (K-PGSTAT), the day and
 * span arithmetic of the read plan, and the default pipeline that adapts the
 * A-1 readers and the A-2 compute core to the Job (createAnalyticsV2Pipeline).
 *
 * Moved out of analytics-refresh.mjs unchanged in behaviour; the Job module
 * re-exports every name, so callers and specs keep importing it from there.
 * It imports nothing from the Job module (no cycle) and does no I/O of its
 * own beyond the pool it is given.
 */

const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/u;
const BEGIN_STATEMENT = /^\s*(?:BEGIN|START\s+TRANSACTION)\b[^;]*;?\s*$/iu;
const END_STATEMENT = /^\s*(?:COMMIT|END|ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?\s*;?\s*$/iu;
const MILLISECONDS_PER_DAY = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const OCCURRENCE_STREAMS = Object.freeze(["usage", "quota", "session"]);
/** Days one run may queue for publication (store ANALYTICS_V2_OUTPUT_LIMITS.days). */
export const ANALYTICS_REFRESH_MAX_QUEUED_DAYS = 4_096;
/** Widest contiguous occurrence range one run reads (bounded full-history recompute). */
export const ANALYTICS_REFRESH_MAX_RANGE_DAYS = 4_096;
/** Journal events per readQueuedDays page, and the page bound of one run. */
const QUEUE_PAGE_EVENTS = 100_000;
const MAX_QUEUE_PAGES = 1_000;
/** A-1's per-call day bound when its module does not export one. */
const DEFAULT_OCCURRENCE_CHUNK_DAYS = 400;
/** ANALYTICS_V2_READ_CHUNK_OCCURRENCES' default (the Job's resource env names it). */
export const ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES = 250_000;
/** Mirrors occurrence-source.ts MAX_ANALYTICS_V2_CANDIDATES (one read call's ceiling); the spec pins it. */
export const ANALYTICS_REFRESH_MAX_READ_CANDIDATES = 2_000_000;

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

// ---------------------------------------------------------------------------
// The statement ledger (K-PGSTAT)
// ---------------------------------------------------------------------------

export const ANALYTICS_REFRESH_STATEMENT_MODEL = "analytics-refresh-statements-v1";
/** The family tag every A-1 reader statement starts with (owners.ts analyticsV2Statement). */
const STATEMENT_TAG = /^\/\* analytics_v2:([a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})?) \*\//u;
/**
 * Transaction plumbing: the snapshot pool's own BEGIN, SET TRANSACTION
 * SNAPSHOT, COMMIT and ROLLBACK, and a reader transaction's SET LOCAL
 * timeouts (postgres-client.ts withPostgresTransaction).
 */
const CONTROL_FAMILY = "snapshot.control";
const SET_LOCAL_STATEMENT = /^\s*SET\s+LOCAL\s+(?:statement_timeout|lock_timeout)\s*=\s*'\d{1,9}ms'\s*;?\s*$/iu;
/** A statement without a family tag (counted, never named by its text). */
const UNTAGGED_FAMILY = "untagged";
const MAX_FAMILIES = 64;
const NAMED_STATEMENT = /^a2_[a-z0-9_]{1,80}$/u;

/** The family of one statement text: its tag, or "untagged". Never its text. */
export function analyticsRefreshStatementFamily(text) {
  if (typeof text === "string" && SET_LOCAL_STATEMENT.test(text)) return CONTROL_FAMILY;
  const match = typeof text === "string" ? STATEMENT_TAG.exec(text) : null;
  return match === null ? UNTAGGED_FAMILY : match[1];
}

/**
 * A per-run ledger of the read side's round trips, by statement family:
 * calls, client wall time (send to result, which includes server execution,
 * planning, protocol and the driver's row parsing), rows and protocol bytes
 * received (null when the driver's socket is not reachable). Content-free:
 * families are code constants and every figure is a count or a duration.
 */
export function createAnalyticsRefreshStatementLedger({ clock = () => performance.now() } = {}) {
  const families = new Map();
  let bytesKnown = true;
  const entry = (family) => {
    let value = families.get(family);
    if (value === undefined) {
      if (families.size >= MAX_FAMILIES) family = UNTAGGED_FAMILY;
      value = families.get(family) ?? { calls: 0, wallMs: 0, rows: 0, bytes: 0 };
      families.set(family, value);
    }
    return value;
  };
  return Object.freeze({
    clock,
    record(family, wallMs, rows, bytes) {
      const value = entry(family);
      value.calls += 1;
      value.wallMs += Number.isFinite(wallMs) && wallMs >= 0 ? wallMs : 0;
      value.rows += Number.isSafeInteger(rows) && rows >= 0 ? rows : 0;
      if (Number.isSafeInteger(bytes) && bytes >= 0) value.bytes += bytes;
      else bytesKnown = false;
    },
    /** The ledger as receipt data: families sorted by name, durations in whole milliseconds. */
    summary() {
      const sorted = [...families].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      let calls = 0;
      let wallMs = 0;
      const byFamily = {};
      for (const [family, value] of sorted) {
        calls += value.calls;
        wallMs += value.wallMs;
        byFamily[family] = Object.freeze({ calls: value.calls, wallMs: Math.round(value.wallMs), rows: value.rows,
          bytes: bytesKnown ? value.bytes : null });
      }
      return Object.freeze({ calls, wallMs: Math.round(wallMs), families: Object.freeze(byFamily) });
    },
  });
}

/**
 * The server's side of the ledger, when PostgreSQL can tell it: a snapshot of
 * pg_stat_statements for this database and role, summed by statement family
 * (the family tag survives in the query text pg_stat_statements keeps).
 * Taken on its own connection (never the run's snapshot transaction, which a
 * refused statement would abort), before the reads and after the last one;
 * analyticsRefreshServerStatementDelta subtracts the two. Returns
 * { available: false } when the extension view is absent or unreadable.
 * The query text is matched against the family tag and dropped: only family
 * names and figures leave this function.
 */
export async function readAnalyticsRefreshServerStatements(pool) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    return Object.freeze({ available: false });
  }
  let discard = false;
  try {
    const present = await client.query("SELECT to_regclass('pg_stat_statements') IS NOT NULL AS present");
    if (present?.rows?.[0]?.present !== true) return Object.freeze({ available: false });
    const result = await client.query(`SELECT queryid::text AS id, left(query, 96) AS head, calls::text AS calls,
        total_exec_time AS exec_ms, total_plan_time AS plan_ms, rows::text AS rows,
        shared_blks_hit::text AS shared_hit, shared_blks_read::text AS shared_read
      FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND query LIKE '/* analytics\\_v2:%'`);
    const statements = new Map();
    for (const row of result.rows ?? []) {
      const family = analyticsRefreshStatementFamily(row.head);
      if (family === UNTAGGED_FAMILY || typeof row.id !== "string") continue;
      const number = (value) => (typeof value === "number" ? value : Number(value));
      statements.set(row.id, Object.freeze({ family, calls: number(row.calls), execMs: number(row.exec_ms),
        planMs: number(row.plan_ms), rows: number(row.rows), sharedHit: number(row.shared_hit),
        sharedRead: number(row.shared_read) }));
    }
    return Object.freeze({ available: true, statements });
  } catch {
    discard = true;
    return Object.freeze({ available: false });
  } finally {
    try { await client.release(discard); } catch { /* the pool is closed by the caller */ }
  }
}

/** after - before, summed by family; null unless both snapshots were available. */
export function analyticsRefreshServerStatementDelta(before, after) {
  if (before?.available !== true || after?.available !== true) return null;
  const families = new Map();
  for (const [id, now] of after.statements) {
    const was = before.statements.get(id);
    const delta = (key) => Math.max(0, now[key] - (was?.[key] ?? 0));
    const calls = delta("calls");
    if (!(calls > 0)) continue;
    const entry = families.get(now.family) ?? { calls: 0, execMs: 0, planMs: 0, rows: 0, sharedHit: 0, sharedRead: 0 };
    entry.calls += calls;
    entry.execMs += delta("execMs");
    entry.planMs += delta("planMs");
    entry.rows += delta("rows");
    entry.sharedHit += delta("sharedHit");
    entry.sharedRead += delta("sharedRead");
    families.set(now.family, entry);
  }
  const sorted = [...families].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  let execMs = 0;
  let planMs = 0;
  const byFamily = {};
  for (const [family, entry] of sorted) {
    execMs += entry.execMs;
    planMs += entry.planMs;
    byFamily[family] = Object.freeze({ calls: entry.calls, execMs: Math.round(entry.execMs),
      planMs: Math.round(entry.planMs), rows: entry.rows, sharedHit: entry.sharedHit, sharedRead: entry.sharedRead });
  }
  return Object.freeze({ source: "pg_stat_statements", execMs: Math.round(execMs), planMs: Math.round(planMs),
    families: Object.freeze(byFamily) });
}

/**
 * Protocol bytes received on one driver connection: node-pg's client exposes
 * its socket (TCP, Unix or the Cloud SQL connector's TLS stream); a counter
 * on its "data" events (decrypted payload for TLS) is read before and after
 * each statement. Returns null when no socket is reachable.
 */
const byteCounters = new WeakMap();
function socketBytes(client) {
  const stream = client?.connection?.stream;
  if (stream === null || typeof stream !== "object" || typeof stream.on !== "function") return null;
  let counter = byteCounters.get(stream);
  if (counter === undefined) {
    counter = { received: 0 };
    stream.on("data", (chunk) => { counter.received += chunk?.length ?? 0; });
    byteCounters.set(stream, counter);
  }
  return counter;
}

/**
 * A PostgresPool whose every transaction reads the one exported snapshot.
 * A reader's BEGIN (any isolation or access mode) becomes
 * BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY + SET TRANSACTION SNAPSHOT,
 * so all A-1 reads see exactly the state the run's cursor was read in, and
 * any write throws. A statement outside a transaction runs in its own
 * snapshot transaction. The exporting transaction must stay open until the
 * last read finishes. close() discards any client a reader failed to release
 * (so pool shutdown cannot hang) and refuses later connects.
 */
export function createSnapshotReadPool(pool, snapshotId, { ledger = null } = {}) {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
      || typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)
      || (ledger !== null && (typeof ledger !== "object" || typeof ledger.record !== "function"))) {
    fail("ANALYTICS_V2_REFRESH_SNAPSHOT_INVALID");
  }
  // Every round trip goes through `send`, so the ledger sees each one once.
  const send = async (client, family, query) => {
    if (ledger === null) return query();
    const counter = socketBytes(client);
    const before = counter?.received ?? 0;
    const started = ledger.clock();
    const result = await query();
    ledger.record(family, ledger.clock() - started, Array.isArray(result?.rows) ? result.rows.length : 0,
      counter === null ? null : counter.received - before);
    return result;
  };
  const control = (client, text) => send(client, CONTROL_FAMILY, () => client.query(text));
  const beginSnapshot = async (client, state) => {
    await control(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    state.open = true;
    await control(client, `SET TRANSACTION SNAPSHOT '${snapshotId}'`);
  };
  const outstanding = new Set();
  let closed = false;
  return Object.freeze({
    async connect() {
      if (closed) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_CLOSED");
      const client = await pool.connect();
      const state = { open: false, released: false };
      const wrapper = Object.freeze({
        async query(text, values) {
          if (state.released) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_CLIENT_RELEASED");
          // A named (prepared) statement, K-READ: { name, text, values }.
          let named = null;
          if (text !== null && typeof text === "object" && !Array.isArray(text)) {
            if (typeof text.name !== "string" || !NAMED_STATEMENT.test(text.name) || typeof text.text !== "string"
                || (text.values !== undefined && !Array.isArray(text.values)) || values !== undefined) {
              fail("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED");
            }
            named = { name: text.name, text: text.text, values: text.values ?? [] };
            text = text.text;
          }
          if (typeof text !== "string") fail("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED");
          if (BEGIN_STATEMENT.test(text)) {
            if (named !== null) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED");
            if (state.open) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_NESTED_TRANSACTION");
            await beginSnapshot(client, state);
            return { rows: [], rowCount: null };
          }
          if (END_STATEMENT.test(text)) {
            if (named !== null) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED");
            state.open = false;
            return control(client, text);
          }
          const family = analyticsRefreshStatementFamily(text);
          const run = () => send(client, family, () => (named === null ? client.query(text, values) : client.query(named)));
          if (state.open) return run();
          await beginSnapshot(client, state);
          try {
            const result = await run();
            await control(client, "COMMIT");
            state.open = false;
            return result;
          } catch (error) {
            try {
              await control(client, "ROLLBACK");
              state.open = false;
            } catch {
              // release() discards the connection while state.open remains true.
            }
            throw error;
          }
        },
        async release(discard = false) {
          if (state.released) return;
          state.released = true;
          outstanding.delete(wrapper);
          let drop = discard === true;
          if (state.open) {
            try {
              await client.query("ROLLBACK");
            } catch {
              drop = true;
            }
            state.open = false;
          }
          await client.release(drop);
        },
      });
      outstanding.add(wrapper);
      return wrapper;
    },
    async close() {
      closed = true;
      const leaked = [...outstanding];
      for (const wrapper of leaked) {
        try { await wrapper.release(true); } catch { /* the pool is closed by the caller */ }
      }
      return leaked.length;
    },
  });
}

function utcDay(epochMs) {
  return new Date(Math.floor(epochMs / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

function isDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function daySpan(fromDay, throughDay) {
  return Math.round((Date.parse(`${throughDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`))
    / MILLISECONDS_PER_DAY) + 1;
}

/**
 * The days a full run publishes (production's queue): the days named by
 * journal events after the cursor plus the days the last run left blocked (a
 * blocked day is not consumed). Published heads that are neither are never
 * recomputed, except when the community aggregate exclusions changed since
 * the last completed run (N-EXCL, `exclusionsChanged`): every published day
 * is then queued too, so a new, revoked or edited exclusion reaches each day
 * it covers or covered (a day whose content is unchanged keeps its revision).
 *
 * Constraint on a content-changing kernel (K-REPRICE, E-OWNERSET): every
 * queued day is recomputed under the run's own kernel. With kernel 1 (parity
 * with d43c8f92) a day the change does not cover recomputes to the same
 * content and keeps its revision. Once a kernel that changes content is the
 * current one, one exclusion change would give every published day a new
 * revision under it, including days the change never covered, before
 * K-REPRICE's owner decision between attestation and revision applies. That
 * change must first queue only the days whose excluded owner set changed
 * (the per-day saved owner set, E-OWNERSET, gives each day's set).
 */
export function analyticsRefreshPublicationDays(journalDays, state, { exclusionsChanged = false } = {}) {
  return [...new Set([...journalDays, ...state.carriedBlockedDays,
    ...(exclusionsChanged ? state.publishedDays : [])])].sort();
}

/**
 * The content-free summary of one run's community aggregate exclusions
 * (N-EXCL): rows of every state, active rows, owners of the run that have an
 * active exclusion, whether the table changed since the last completed run,
 * and the published days that change queued. Counts only; never an id.
 */
function exclusionsSummary(exclusions, excludedOwners, changed, republishedDays) {
  return Object.freeze({ rows: exclusions.rows, active: exclusions.active, excludedOwners, changed, republishedDays });
}

/**
 * First day that gets cache-band rows. Production builds a cache-retention
 * day for every delivered day (d43c8f92 cache-retention-day-worker.ts:
 * CACHE_RETENTION_FROM_DAY is unset in every deployment, which "means every
 * delivered day"), and its `all` window has no lower bound. So the horizon
 * has no fixed lower bound either: it reaches back to the first evidence day
 * of any effective owner (A-1 readOwnerFirstEvidenceDay over the whole day
 * domain), the earliest stored cache-band day and the earliest queued day,
 * and never starts later than the analysis horizon
 * [today-(analysisDays-1), today]. Every stored cache day is recomputed
 * exactly (with its 7-day carry) instead of being dropped.
 */
export function analyticsRefreshCacheFromDay({
  today, analysisDays, queuedDays, cacheFloorDay, firstEvidenceDay = null,
}) {
  let fromDay = addDays(today, -(analysisDays - 1));
  for (const day of queuedDays) if (day < fromDay) fromDay = day;
  if (cacheFloorDay !== null && cacheFloorDay < fromDay) fromDay = cacheFloorDay;
  if (firstEvidenceDay !== null && firstEvidenceDay < fromDay) fromDay = firstEvidenceDay;
  return fromDay;
}

/**
 * Contiguous runs of `days`, each split into ranges of at most `chunkDays`
 * days (A-1 reads at most that many days per call).
 */
export function analyticsRefreshDaySpans(days, chunkDays) {
  const spans = [];
  for (const day of [...new Set(days)].sort()) {
    const last = spans.at(-1);
    if (last !== undefined && addDays(last.throughDay, 1) === day
        && daySpan(last.fromDay, day) <= chunkDays) {
      last.throughDay = day;
    } else {
      spans.push({ fromDay: day, throughDay: day });
    }
  }
  return spans.map((span) => Object.freeze(span));
}

/** One inclusive range split into consecutive ranges of at most `chunkDays` days. */
export function analyticsRefreshRangeChunks(range, chunkDays) {
  const chunks = [];
  for (let fromDay = range.fromDay; fromDay <= range.throughDay; fromDay = addDays(fromDay, chunkDays)) {
    const end = addDays(fromDay, chunkDays - 1);
    chunks.push(Object.freeze({ fromDay, throughDay: end < range.throughDay ? end : range.throughDay }));
  }
  return chunks;
}

/**
 * Contiguous read spans covering `range`, for one owner and stream: each at
 * most `chunkDays` days and, where the exact per-day counts allow, at most
 * `maxOccurrences` occurrences; a single day larger than that is a span of
 * its own (A-1 never splits a day). Without counts the spans are
 * analyticsRefreshRangeChunks(range, chunkDays).
 */
export function analyticsRefreshReadSpans(range, chunkDays, dayCounts, maxOccurrences) {
  const spans = [];
  let current = null;
  for (let day = range.fromDay; day <= range.throughDay; day = addDays(day, 1)) {
    const count = dayCounts.get(day) ?? 0;
    if (current !== null && daySpan(current.fromDay, day) <= chunkDays
        && current.occurrences + count <= maxOccurrences) {
      current.throughDay = day;
      current.occurrences += count;
    } else {
      if (current !== null) spans.push(Object.freeze(current));
      current = { fromDay: day, throughDay: day, occurrences: count };
    }
  }
  if (current !== null) spans.push(Object.freeze(current));
  return spans;
}

function requireFunction(module, name) {
  const value = module?.[name];
  if (typeof value !== "function") fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE", { missing: name });
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE", { missing: name });
  return value;
}

function sequenceNumber(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
  }
  return number;
}

function hasTypedEvidence(owner) {
  return owner.hasV1 === true || owner.hasV11 === true || owner.hasV12 === true;
}

/** Heap bytes in use: sampled into each owner's heapPeakBytes (operational metadata only). */
function defaultMemoryProbe() {
  return process.memoryUsage().heapUsed;
}

/** A-1's closed, content-free source failure (owners.ts AnalyticsV2SourceError). */
function isSourceError(error) {
  return typeof error?.code === "string" && /^ANALYTICS_V2_SOURCE_[A-Z_]+$/u.test(error.code);
}

function compareOwners(left, right) {
  return left.ownerDigest < right.ownerDigest ? -1 : left.ownerDigest > right.ownerDigest ? 1 : 0;
}

/**
 * The default wiring of the A-1 readers and the A-2 compute core. It adapts
 * the shapes the two packages landed with:
 *
 * - listAnalyticsV2Owners(context) -> {owners, unlinked, correctionRuntimeActive};
 * - readQueuedDays(context, {afterSequence, limit}) -> one journal page, read
 *   until complete;
 * - readOwnerOccurrences(context, {ownerDigest, stream, fromDay, throughDay,
 *   maxCandidates}) -> Map(day -> occurrences), at most
 *   MAX_ANALYTICS_V2_OCCURRENCE_DAYS a call;
 * - countOwnerOccurrences(context, {ownerDigest, stream, fromDay, throughDay})
 *   -> Map(day -> the exact count readOwnerOccurrences returns), same bound;
 * - readOwnerFirstEvidenceDay(context, {ownerDigest, throughDay}) -> the
 *   owner's first evidence day or null (the cache horizon's lower end);
 * - countContributingDevices(context, {days: Map(day -> effective owners)});
 * - computeAnalyticsV2({..., occurrenceRange, cacheFromDay,
 *   loadOwnerOccurrences, ownerEvidence, resources}) over ONE contiguous range
 *   that covers analyticsV2RequiredOccurrenceRange.
 *
 * Effective owners are counted over the whole range during read and loaded,
 * one at a time and one A-2 segment at a time, during compute: every stream
 * of the requested segment (the whole range when A-2 names none) in
 * contiguous spans of at most MAX_ANALYTICS_V2_OCCURRENCE_DAYS days and, by
 * the counts, about the read chunk of occurrences. A-2 skips the load of an owner its memory guard
 * refuses and refuses a load that differs from the counts. A non-effective owner with
 * typed evidence is a member of production's daily cohort: it is read over
 * the queued days only, so A-2 blocks exactly the queued days it has evidence
 * on (a closed A-1 source refusal leaves it unread, and A-2 then blocks every
 * queued day, never fewer). An eligible typed owner without an active owner
 * link makes production's daily lane unavailable (d43c8f92
 * storage-community-daily.ts cohort()): every queued day is blocked and
 * carried. Legacy-only (v0.2) owners are not daily-cohort members and are not
 * read.
 */
export function createAnalyticsV2Pipeline({ owners, occurrences, devices, queuedDays, compute }) {
  const listOwners = requireFunction(owners, "listAnalyticsV2Owners");
  const readQueued = requireFunction(queuedDays, "readQueuedDays");
  const readOccurrences = requireFunction(occurrences, "readOwnerOccurrences");
  const countOccurrences = requireFunction(occurrences, "countOwnerOccurrences");
  const readFirstEvidenceDay = requireFunction(occurrences, "readOwnerFirstEvidenceDay");
  const countDevices = requireFunction(devices, "countContributingDevices");
  const readExclusions = requireFunction(owners, "readAnalyticsV2Exclusions");
  const computeOutputs = requireFunction(compute, "computeAnalyticsV2");
  const requiredRange = requireFunction(compute, "analyticsV2RequiredOccurrenceRange");
  const analysisDays = requirePositiveInteger(compute?.ANALYTICS_V2_ANALYSIS_DAYS, "ANALYTICS_V2_ANALYSIS_DAYS");
  const chunkDays = requirePositiveInteger(
    occurrences?.MAX_ANALYTICS_V2_OCCURRENCE_DAYS ?? DEFAULT_OCCURRENCE_CHUNK_DAYS,
    "MAX_ANALYTICS_V2_OCCURRENCE_DAYS",
  );

  async function readJournal(context, cursor) {
    let afterSequence = cursor === null ? 0 : sequenceNumber(cursor);
    const days = new Set();
    const terminalOwners = new Set();
    for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
      const result = await readQueued(context, { afterSequence, limit: QUEUE_PAGE_EVENTS });
      if (result === null || typeof result !== "object" || !Array.isArray(result.days)
          || !result.days.every(isDay) || !Array.isArray(result.terminalOwners)
          || !result.terminalOwners.every((owner) => typeof owner === "string" && OWNER_DIGEST.test(owner))
          || typeof result.complete !== "boolean") {
        fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      }
      const lastSequence = sequenceNumber(result.lastSequence);
      if (lastSequence === null || lastSequence < afterSequence) fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      for (const day of result.days) days.add(day);
      for (const owner of result.terminalOwners) terminalOwners.add(owner);
      if (days.size > ANALYTICS_REFRESH_MAX_QUEUED_DAYS) fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
      if (result.complete) {
        return { days: [...days].sort(), lastSequence, terminalOwners: terminalOwners.size };
      }
      // An incomplete page must advance, or the loop could never end.
      if (lastSequence === afterSequence) fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      afterSequence = lastSequence;
    }
    return fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
  }

  /** `rangesOf(stream)` -> the ranges to read; a range may carry a candidate bound. */
  async function readOwnerDays(context, ownerDigest, rangesOf) {
    const byDay = new Map();
    for (const stream of OCCURRENCE_STREAMS) {
      for (const range of rangesOf(stream)) {
        const result = await readOccurrences(context, {
          ownerDigest,
          stream,
          fromDay: range.fromDay,
          throughDay: range.throughDay,
          ...(range.maxCandidates === undefined ? {} : { maxCandidates: range.maxCandidates }),
        });
        if (!(result instanceof Map)) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        for (const [day, list] of result) {
          if (!isDay(day) || day < range.fromDay || day > range.throughDay || !Array.isArray(list)) {
            fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
          }
          const entry = byDay.get(day) ?? { usage: [], quota: [], session: [] };
          entry[stream] = list;
          byDay.set(day, entry);
        }
      }
    }
    return byDay;
  }

  /** One effective owner's exact counts per stream and day over `chunks` (A-1's own candidate selection). */
  async function countOwnerEvidence(context, ownerDigest, chunks) {
    const byStream = {};
    const evidence = new Map();
    for (const stream of OCCURRENCE_STREAMS) {
      const counts = new Map();
      for (const chunk of chunks) {
        const result = await countOccurrences(context, { ownerDigest, stream, fromDay: chunk.fromDay,
          throughDay: chunk.throughDay });
        if (!(result instanceof Map)) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        for (const [day, count] of result) {
          if (!isDay(day) || day < chunk.fromDay || day > chunk.throughDay || counts.has(day)
              || !Number.isSafeInteger(count) || count < 1) {
            fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
          }
          counts.set(day, count);
          const entry = evidence.get(day) ?? { usage: 0, quota: 0, session: 0 };
          entry[stream] = count;
          evidence.set(day, entry);
        }
      }
      byStream[stream] = counts;
    }
    for (const [day, entry] of evidence) evidence.set(day, Object.freeze(entry));
    return { byStream, evidence };
  }

  return Object.freeze({
    async read({ pool, schema, nowMs, state, resources, checkpoint = () => {} }) {
      const context = Object.freeze({ pool, schema, nowMs });
      const readChunk = resources?.readChunkOccurrences
        ?? ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES;
      if (!Number.isSafeInteger(readChunk) || readChunk < 1 || readChunk > ANALYTICS_REFRESH_MAX_READ_CANDIDATES) {
        fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID");
      }
      const listing = await listOwners(context);
      if (listing === null || typeof listing !== "object" || Array.isArray(listing)
          || !Array.isArray(listing.owners) || !Array.isArray(listing.unlinked)
          || !listing.owners.every((owner) => owner !== null && typeof owner === "object"
            && typeof owner.ownerDigest === "string" && OWNER_DIGEST.test(owner.ownerDigest))
          || !listing.unlinked.every((owner) => owner !== null && typeof owner === "object")) {
        fail("ANALYTICS_V2_REFRESH_OWNERS_INVALID");
      }
      // N-EXCL (src/analytics-v2/exclusions.ts): the community aggregate
      // exclusions, read in the run's snapshot. A linked owner's active rows
      // go to A-2, which leaves the owner out of each covered day's community
      // aggregates; an unlinked participant is in no aggregate. When the
      // table changed since the last completed run, every published day is
      // republished.
      const exclusions = await readExclusions(context);
      if (exclusions === null || typeof exclusions !== "object" || !Number.isSafeInteger(exclusions.rows)
          || !Number.isSafeInteger(exclusions.active) || exclusions.active < 0 || exclusions.active > exclusions.rows
          || typeof exclusions.sha256 !== "string"
          || !OWNER_DIGEST.test(exclusions.sha256) || !(exclusions.activeByParticipant instanceof Map)) {
        fail("ANALYTICS_V2_REFRESH_EXCLUSIONS_INVALID");
      }
      if (typeof state.appliedExclusionsSha256 !== "string" || !OWNER_DIGEST.test(state.appliedExclusionsSha256)
          || !Array.isArray(state.publishedDays) || !state.publishedDays.every(isDay)) {
        fail("ANALYTICS_V2_REFRESH_STATE_INVALID");
      }
      const exclusionsByOwner = new Map();
      for (const owner of listing.owners) {
        const intervals = exclusions.activeByParticipant.get(owner.participantId);
        if (intervals !== undefined) exclusionsByOwner.set(owner.ownerDigest, intervals);
      }
      const exclusionsChanged = exclusions.sha256 !== state.appliedExclusionsSha256;
      const journal = await readJournal(context, state.cursor);
      const unchangedDays = analyticsRefreshPublicationDays(journal.days, state);
      const days = analyticsRefreshPublicationDays(journal.days, state, { exclusionsChanged });
      if (days.length > ANALYTICS_REFRESH_MAX_QUEUED_DAYS) fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
      const today = utcDay(nowMs);
      const ownerList = [...listing.owners].sort(compareOwners);
      // Production has no lower bound on cache history: start at the first
      // evidence day of any effective owner, whatever the queue holds.
      let firstEvidenceDay = null;
      for (const owner of ownerList) {
        if (owner.source !== "effective") continue;
        checkpoint(Object.freeze({ kind: "read" }));
        const first = await readFirstEvidenceDay(context, { ownerDigest: owner.ownerDigest, throughDay: today });
        if (first === null) continue;
        if (!isDay(first) || first > today) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        if (firstEvidenceDay === null || first < firstEvidenceDay) firstEvidenceDay = first;
      }
      const cacheFromDay = analyticsRefreshCacheFromDay({
        today,
        analysisDays,
        queuedDays: days,
        cacheFloorDay: state.cacheFloorDay ?? null,
        firstEvidenceDay,
      });
      const range = await requiredRange({ nowMs, queuedDays: days, cacheFromDay });
      if (range === null || typeof range !== "object" || !isDay(range.fromDay) || !isDay(range.throughDay)
          || range.fromDay > range.throughDay) {
        fail("ANALYTICS_V2_REFRESH_RANGE_INVALID");
      }
      if (daySpan(range.fromDay, range.throughDay) > ANALYTICS_REFRESH_MAX_RANGE_DAYS) {
        fail("ANALYTICS_V2_REFRESH_RANGE_EXCEEDED");
      }
      const occurrenceRange = Object.freeze({ fromDay: range.fromDay, throughDay: range.throughDay });
      const fullRange = analyticsRefreshRangeChunks(occurrenceRange, chunkDays);
      const queuedSpans = analyticsRefreshDaySpans(days, chunkDays);

      // Effective owners: exact counts only. Their occurrences are read one
      // owner at a time during compute, after the memory guard.
      const ownerEvidence = new Map();
      const streamCounts = new Map();
      const occurrencesByOwner = new Map();
      let nonEffectiveUnread = 0;
      for (const owner of ownerList) {
        checkpoint(Object.freeze({ kind: "read" }));
        if (owner.source === "effective") {
          const counted = await countOwnerEvidence(context, owner.ownerDigest, fullRange);
          ownerEvidence.set(owner.ownerDigest, counted.evidence);
          streamCounts.set(owner.ownerDigest, counted.byStream);
        } else if (hasTypedEvidence(owner)) {
          try {
            occurrencesByOwner.set(owner.ownerDigest, await readOwnerDays(context, owner.ownerDigest, () => queuedSpans));
          } catch (error) {
            // Fail closed for publication only: unread, A-2 blocks every queued day.
            if (!isSourceError(error)) throw error;
            nonEffectiveUnread += 1;
          }
        }
      }

      const contributing = new Map(days.map((day) => [day, ownerList
        .filter((owner) => owner.source === "effective" && ownerEvidence.get(owner.ownerDigest).has(day))
        .map((owner) => ({ participantId: owner.participantId, ownerDigest: owner.ownerDigest, source: owner.source }))]));
      const devicesByDay = await countDevices(context, { days: contributing });
      if (!(devicesByDay instanceof Map)) fail("ANALYTICS_V2_REFRESH_DEVICES_INVALID");

      // One effective owner's occurrences over one A-2 segment (the whole
      // range when none is named), in spans of about the read chunk by its
      // exact counts. Called by A-2 only while the run's read snapshot is open
      // (runAnalyticsRefresh closes it after compute).
      let loadWallMs = 0;
      const loadOwnerOccurrences = async (ownerDigest, segment = occurrenceRange) => {
        const counts = streamCounts.get(ownerDigest);
        if (counts === undefined) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        if (segment === null || typeof segment !== "object" || !isDay(segment.fromDay) || !isDay(segment.throughDay)
            || segment.fromDay > segment.throughDay || segment.fromDay < occurrenceRange.fromDay
            || segment.throughDay > occurrenceRange.throughDay) {
          fail("ANALYTICS_V2_REFRESH_RANGE_INVALID");
        }
        const bounded = Object.freeze({ fromDay: segment.fromDay, throughDay: segment.throughDay });
        const started = performance.now();
        try {
          return await readOwnerDays(context, ownerDigest, (stream) =>
            analyticsRefreshReadSpans(bounded, chunkDays, counts[stream], readChunk).map((span) => ({
              fromDay: span.fromDay,
              throughDay: span.throughDay,
              maxCandidates: Math.min(ANALYTICS_REFRESH_MAX_READ_CANDIDATES, Math.max(readChunk, span.occurrences)),
            })));
        } finally {
          // Main-thread wall time of the owner loads (K-PGSTAT), whichever
          // thread computes the owner.
          loadWallMs += performance.now() - started;
        }
      };

      return {
        owners: listing.owners,
        unlinkedTypedOwners: listing.unlinked.filter(hasTypedEvidence).length,
        occurrencesByOwner,
        ownerEvidence,
        loadOwnerOccurrences,
        loadWallMs: () => loadWallMs,
        occurrenceRange,
        cacheFromDay,
        devicesByDay,
        queuedDays: days,
        firstEvidenceDay,
        lastSequence: journal.lastSequence,
        terminalOwners: journal.terminalOwners,
        nonEffectiveUnread,
        exclusionsByOwner,
        exclusionsSha256: exclusions.sha256,
        exclusions: exclusionsSummary(exclusions, exclusionsByOwner.size, exclusionsChanged,
          days.length - unchangedDays.length),
        ...(resources?.compute === undefined ? {} : { resources: resources.compute }),
      };
    },
    async compute(inputs, { nowMs, revisionSeed, memoryProbe = defaultMemoryProbe, checkpoint, ownerPool }) {
      const outputs = await computeOutputs({
        owners: inputs.owners,
        occurrencesByOwner: inputs.occurrencesByOwner,
        occurrenceRange: inputs.occurrenceRange,
        cacheFromDay: inputs.cacheFromDay,
        devicesByDay: inputs.devicesByDay,
        queuedDays: inputs.queuedDays,
        nowMs,
        revisionSeed,
        loadOwnerOccurrences: inputs.loadOwnerOccurrences,
        ownerEvidence: inputs.ownerEvidence,
        exclusions: inputs.exclusionsByOwner,
        // Inline, the Job's resources partition one heap (analyticsRefreshResources),
        // so the run may reclaim the per-owner budget its largest owner leaves.
        // With compute workers (K-PAR) the owners' heaps are the Workers', and
        // the main heap's output budget is its own.
        ...(inputs.resources === undefined ? {}
          : { resources: inputs.resources, reclaimUnusedOwnerBudget: ownerPool === undefined }),
        ...(ownerPool === undefined ? {} : { ownerPool }),
        memoryProbe,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      if (outputs === null || typeof outputs !== "object" || !Array.isArray(outputs.dailyCandidates)
          || !Array.isArray(outputs.blockedDays)) {
        fail("ANALYTICS_V2_REFRESH_OUTPUTS_INVALID");
      }
      let publication = {};
      if (inputs.unlinkedTypedOwners > 0) {
        // Production's daily cohort is unavailable while an eligible typed
        // owner has no owner link: nothing publishes, every queued day is
        // carried, and each keeps its prior row.
        publication = {
          dailyCandidates: [],
          blockedDays: [...new Set([...outputs.blockedDays,
            ...outputs.dailyCandidates.map((candidate) => candidate.day)])].sort(),
        };
      }
      return {
        ...outputs,
        ...publication,
        // The journal position is the reader's, not the pure compute core's.
        journal: { lastSequence: inputs.lastSequence },
        // The owner-scoped rows this run recomputes: every prepared day from the
        // start of the occurrence range, and every cache day from cacheFromDay.
        horizon: { ownerDayFromDay: inputs.occurrenceRange.fromDay, cacheBandsFromDay: inputs.cacheFromDay },
        readSummary: {
          unlinkedTypedOwners: inputs.unlinkedTypedOwners,
          terminalOwners: inputs.terminalOwners,
          nonEffectiveUnread: inputs.nonEffectiveUnread,
        },
        // N-EXCL: what the run applied, for the run row and the receipt.
        exclusionsSha256: inputs.exclusionsSha256,
        exclusions: inputs.exclusions,
      };
    },
  });
}
