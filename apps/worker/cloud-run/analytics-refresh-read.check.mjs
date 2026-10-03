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
import { createAnalyticsRefreshStatementLedger, createSnapshotReadPool } from "./analytics-refresh-read.mjs";

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
