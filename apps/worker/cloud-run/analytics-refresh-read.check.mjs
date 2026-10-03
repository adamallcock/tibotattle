/**
 * The refresh Job's snapshot read pool (analytics-refresh-read.mjs
 * createSnapshotReadPool) against a scripted client, without a database:
 * every reader statement runs inside a transaction that imports the Job's
 * snapshot, a named (prepared) statement passes through in its one closed
 * form, and every other form is refused with a closed code before anything
 * reaches the connection. The real snapshot sharing is proven by
 * postgres-test/analytics-v2-refresh.spec.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsRefreshForEachConcurrent,
  analyticsRefreshSlots,
  createAnalyticsRefreshStatementLedger,
  createAnalyticsV2Pipeline,
  createSnapshotReadPool,
  mergeAnalyticsRefreshOccurrencePart,
} from "./analytics-refresh-read.mjs";

const SNAPSHOT = "00000003-0000001B-1";

/** A pg pool whose one client records every query it is sent. */
function scriptedPool() {
  const sent = [];
  const released = [];
  const client = {
    async query(text, values) {
      sent.push(values === undefined ? text : [text, values]);
      return { rows: [{ one: 1 }], rowCount: 1 };
    },
    async release(discard) { released.push(discard); },
  };
  return { sent, released, pool: { async connect() { return client; } } };
}

const refused = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

test("the snapshot pool refuses a malformed pool, snapshot id or ledger", () => {
  const { pool } = scriptedPool();
  for (const [candidate, snapshot, options] of [
    [null, SNAPSHOT, {}], [{}, SNAPSHOT, {}], [pool, "not-a-snapshot", {}], [pool, `${SNAPSHOT}'; DROP`, {}],
    [pool, SNAPSHOT, { ledger: {} }], [pool, SNAPSHOT, { ledger: "ledger" }],
  ]) {
    assert.throws(() => createSnapshotReadPool(candidate, snapshot, options), refused("ANALYTICS_V2_REFRESH_SNAPSHOT_INVALID"));
  }
});

test("a named statement runs in its closed form inside the snapshot, and is recorded under its family", async () => {
  const { sent, pool } = scriptedPool();
  const ledger = createAnalyticsRefreshStatementLedger({ clock: () => 0 });
  const reads = createSnapshotReadPool(pool, SNAPSHOT, { ledger });
  const client = await reads.connect();
  const text = "/* analytics_v2:occurrences.v12_sources */ SELECT $1::int AS one";
  await client.query({ name: "a2_occurrences_v12_sources_0123456789abcdef", text, values: [1] });
  assert.deepEqual(sent, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    `SET TRANSACTION SNAPSHOT '${SNAPSHOT}'`,
    { name: "a2_occurrences_v12_sources_0123456789abcdef", text, values: [1] },
    "COMMIT",
  ]);
  const families = ledger.summary().families;
  assert.equal(families["occurrences.v12_sources"].calls, 1);
  assert.equal(families["snapshot.control"].calls, 3);
  await client.release();
});

test("every other named-statement form is refused before it reaches the connection", async () => {
  const { sent, pool } = scriptedPool();
  const reads = createSnapshotReadPool(pool, SNAPSHOT);
  const client = await reads.connect();
  const text = "/* analytics_v2:occurrences.scope */ SELECT 1";
  for (const [label, config, values] of [
    ["malformed name", { name: "a2 bad name", text }],
    ["name outside the a2_ namespace", { name: "pg_statement", text }],
    ["overlong name", { name: `a2_${"x".repeat(81)}`, text }],
    ["name not a string", { name: 7, text }],
    ["text not a string", { name: "a2_scope", text: 7 }],
    ["values not an array", { name: "a2_scope", text, values: "1" }],
    ["values beside a named config", { name: "a2_scope", text }, [1]],
    ["named BEGIN", { name: "a2_begin", text: "BEGIN" }],
    ["named START TRANSACTION", { name: "a2_begin", text: "START TRANSACTION READ WRITE" }],
    ["named COMMIT", { name: "a2_commit", text: "COMMIT" }],
    ["named ROLLBACK", { name: "a2_rollback", text: "ROLLBACK" }],
    ["array", [text]],
    ["number", 7],
  ]) {
    await assert.rejects(client.query(config, values), refused("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED"), label);
  }
  assert.deepEqual(sent, [], "nothing reached the connection");
  await client.release();
});

test("transactions nest never, and a released client or a closed pool refuses", async () => {
  const { sent, released, pool } = scriptedPool();
  const reads = createSnapshotReadPool(pool, SNAPSHOT);
  const client = await reads.connect();
  await client.query("BEGIN READ ONLY");
  await assert.rejects(client.query("BEGIN"), refused("ANALYTICS_V2_REFRESH_SNAPSHOT_NESTED_TRANSACTION"));
  // The open transaction is rolled back on release, never left behind.
  await client.release();
  assert.equal(sent.at(-1), "ROLLBACK");
  assert.deepEqual(released, [false]);
  await assert.rejects(client.query("SELECT 1"), refused("ANALYTICS_V2_REFRESH_SNAPSHOT_CLIENT_RELEASED"));
  const leaked = await reads.connect();
  assert.equal(await reads.close(), 1, "a leaked client is counted and discarded");
  assert.deepEqual(released, [false, true]);
  await assert.rejects(reads.connect(), refused("ANALYTICS_V2_REFRESH_SNAPSHOT_CLOSED"));
  await leaked.release();
});

test("bounded concurrency: in item order, at most N at once, and a failure waits for the started work", async () => {
  let running = 0;
  let peak = 0;
  const finished = [];
  const results = await analyticsRefreshForEachConcurrent([30, 10, 20, 5, 15], 3, async (delay, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, delay));
    running -= 1;
    finished.push(index);
    return delay * 2;
  });
  assert.deepEqual(results, [60, 20, 40, 10, 30], "results in item order, whatever order they finish in");
  assert.equal(peak, 3);
  assert.deepEqual(await analyticsRefreshForEachConcurrent([], 2, async () => 1), []);
  const boom = Object.assign(new Error("ANALYTICS_V2_SOURCE_LIMIT"), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  let slowDone = false;
  let startedAfterFailure = false;
  await assert.rejects(analyticsRefreshForEachConcurrent([0, 1, 2, 3], 2, async (item) => {
    if (item === 0) { await new Promise((resolve) => setTimeout(resolve, 2)); throw boom; }
    if (item === 1) { await new Promise((resolve) => setTimeout(resolve, 20)); slowDone = true; return 1; }
    startedAfterFailure = true;
    return item;
  }), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  assert.equal(slowDone, true, "the call settles only after the started work has");
  assert.equal(startedAfterFailure, false, "no new work starts after a failure");
  for (const concurrency of [0, 9, 1.5, "2"]) {
    await assert.rejects(analyticsRefreshForEachConcurrent([1], concurrency, async () => 1),
      refused("ANALYTICS_V2_REFRESH_READ_CONCURRENCY_INVALID"));
  }
});

test("an occurrence part merges by day and stream, and refuses an unknown stream", () => {
  const byDay = new Map();
  mergeAnalyticsRefreshOccurrencePart(byDay, "usage", new Map([["2026-01-02", [{ id: "u2" }]], ["2026-01-01", [{ id: "u1" }]]]));
  mergeAnalyticsRefreshOccurrencePart(byDay, "quota", new Map([["2026-01-01", [{ id: "q1" }]], ["2026-01-03", [{ id: "q3" }]]]));
  assert.deepEqual([...byDay.keys()], ["2026-01-02", "2026-01-01", "2026-01-03"]);
  assert.deepEqual(byDay.get("2026-01-01"), { usage: [{ id: "u1" }], quota: [{ id: "q1" }], session: [] });
  assert.deepEqual(byDay.get("2026-01-03"), { usage: [], quota: [{ id: "q3" }], session: [] });
  assert.throws(() => mergeAnalyticsRefreshOccurrencePart(byDay, "other", new Map()),
    refused("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID"));
  assert.throws(() => mergeAnalyticsRefreshOccurrencePart(byDay, "usage", [["2026-01-01", []]]),
    refused("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID"));
});

/** A-1/A-2 stand-ins for the default pipeline: three owners, counted and read per stream and span. */
function stubPipeline(log) {
  const OWNERS = ["a", "b", "c"].map((letter) => letter.repeat(64));
  const counts = new Map([["2026-09-01", 3], ["2026-09-20", 2], ["2026-09-30", 4]]);
  const occurrences = {
    MAX_ANALYTICS_V2_OCCURRENCE_DAYS: 400,
    async readOwnerOccurrences(context, { ownerDigest, stream, fromDay, throughDay, maxCandidates }) {
      log.push(["read", ownerDigest.slice(0, 1), stream, fromDay, throughDay, maxCandidates]);
      const days = new Map();
      for (const [day, count] of counts) {
        if (day >= fromDay && day <= throughDay) days.set(day, Array.from({ length: count }, (_, i) => ({ stream, i })));
      }
      return days;
    },
    async countOwnerOccurrences(context, { fromDay, throughDay }) {
      log.push(["count"]);
      return new Map([...counts].filter(([day]) => day >= fromDay && day <= throughDay));
    },
    async readOwnerFirstEvidenceDay(context, { ownerDigest }) {
      log.push(["first", ownerDigest.slice(0, 1)]);
      await new Promise((resolve) => setTimeout(resolve, ownerDigest.startsWith("a") ? 5 : 1));
      return ownerDigest.startsWith("b") ? "2026-08-01" : "2026-09-01";
    },
  };
  return createAnalyticsV2Pipeline({
    owners: {
      analyticsV2ExcludedOn: () => false,
      async listAnalyticsV2Owners() {
        return { owners: OWNERS.map((ownerDigest, index) => ({ ownerDigest, participantId: `p${index}`, source: "effective",
          hasV1: false, hasV11: true, hasV12: false, hasLegacy: false, hasEffective: true })), unlinked: [] };
      },
      async readAnalyticsV2Exclusions() {
        return { rows: 0, active: 0, sha256: "0".repeat(64), activeByParticipant: new Map() };
      },
    },
    ownerSets: {
      async readAnalyticsV2OwnerSetState(_context, { days }) {
        return { days: new Map(days.map((day) => [day, { members: new Map() }])), frozen: null };
      },
      async readAnalyticsV2SavedContributionValues() { return new Map(); },
    },
    occurrences,
    devices: { async countContributingDevices() { return new Map(); } },
    queuedDays: { async readQueuedDays() { return { days: [], terminalOwners: [], lastSequence: 0, complete: true }; } },
    compute: {
      ANALYTICS_V2_ANALYSIS_DAYS: 170,
      computeAnalyticsV2: async () => ({}),
      analyticsV2RequiredOccurrenceRange: ({ cacheFromDay }) => ({ fromDay: cacheFromDay, throughDay: "2026-10-01" }),
    },
  });
}

test("default wiring: concurrent pre-compute reads give the inline inputs; a streamed load gives the inline map", async () => {
  const state = { cursor: null, carriedBlockedDays: [], publishedDays: [], appliedExclusionsSha256: "0".repeat(64),
    cacheFloorDay: null };
  const read = (options) => stubPipeline([]).read({ pool: {}, schema: "s", nowMs: Date.parse("2026-10-01T12:00:00Z"), state,
    resources: { readChunkOccurrences: 4 }, ...options });
  const inline = await read({});
  const concurrent = await read({ readConcurrency: 3, loadConcurrency: 2 });
  assert.equal(concurrent.firstEvidenceDay, "2026-08-01", "the earliest first evidence day of any owner");
  assert.equal(concurrent.firstEvidenceDay, inline.firstEvidenceDay);
  assert.deepEqual([...concurrent.ownerEvidence], [...inline.ownerEvidence], "the same counts, in owner order");
  assert.deepEqual(concurrent.occurrenceRange, inline.occurrenceRange);
  // A load streamed in parts and merged by the receiver equals the inline load.
  const owner = "a".repeat(64);
  const whole = await inline.loadOwnerOccurrences(owner);
  const parts = [];
  assert.equal(await concurrent.loadOwnerOccurrences(owner, undefined, async (stream, days, ordinal) => {
    // Later calls finish first: the parts arrive out of order.
    await new Promise((resolve) => setTimeout(resolve, 20 - ordinal));
    parts.push([ordinal, stream, days]);
  }), null);
  assert.notDeepEqual(parts.map(([ordinal]) => ordinal), [...parts.keys()], "the parts arrived out of order");
  assert.deepEqual(parts.map(([ordinal]) => ordinal).sort((a, b) => a - b), [...parts.keys()], "one ordinal per call");
  const merged = new Map();
  for (const [, stream, days] of parts.sort(([left], [right]) => left - right)) {
    mergeAnalyticsRefreshOccurrencePart(merged, stream, days);
  }
  assert.deepEqual([...merged], [...whole], "merged in ordinal order, the parts make the inline map");
  // With two loads in flight, each read call targets half the read chunk (4 / 2): more, smaller parts.
  assert.ok(parts.length > 3, "one part per read call");
  for (const value of [0, 9]) {
    await assert.rejects(read({ readConcurrency: value }), refused("ANALYTICS_V2_REFRESH_READ_CONCURRENCY_INVALID"));
    await assert.rejects(read({ loadConcurrency: value }), refused("ANALYTICS_V2_REFRESH_READ_CONCURRENCY_INVALID"));
  }
});

test("shared read slots: at most `size` works at once across callers, first come first served, freed on failure", async () => {
  const slots = analyticsRefreshSlots(2);
  let running = 0;
  let peak = 0;
  const order = [];
  const work = (label, delay, fails = false) => slots.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(label);
    await new Promise((resolve) => setTimeout(resolve, delay));
    running -= 1;
    if (fails) throw new Error("boom");
    return label;
  });
  const results = await Promise.allSettled([work("a", 15), work("b", 5, true), work("c", 5), work("d", 5)]);
  assert.equal(peak, 2);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.deepEqual(results.map((value) => value.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(await work("e", 1), "e", "a failed work frees its slot");
  for (const size of [0, 9, 1.5]) assert.throws(() => analyticsRefreshSlots(size), refused("ANALYTICS_V2_REFRESH_READ_CONCURRENCY_INVALID"));
});
