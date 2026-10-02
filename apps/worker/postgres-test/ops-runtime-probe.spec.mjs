import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { OPS_ACTIVITY_CLASSES, OPS_BACKLOG_CAP, OPS_PROBE_NAMES, OPS_PROBES, opsProbeNamesForJob, serializeOpsProbeLine }
  from "../cloud-run/ops-probe-contract.mjs";
import { collectOpsRuntimeSignals, runLogRedactionProbe, runOpsRuntimeProbe } from "../cloud-run/ops-runtime-probe-job.mjs";

/*
 * PostgreSQL 17 qualification for the OPS-4 runtime liveness probe
 * (cloud-run/ops-runtime-probe-job.mjs): the probe's SQL against a real
 * migrated primary schema, in a database of its own so that the session
 * counts are exact (the probe reads only sessions of the database it is in).
 *
 * One database, d_ops4_probe_<hex>, is created for the file and dropped at the
 * end, with the primary chain applied once through the production runner into
 * the schema d_ops4_primary. Tests that need rows seed them as the local
 * superuser with session_replication_role = replica (the journal, manifest and
 * lifecycle guards belong to the writers under test elsewhere; here they only
 * need to leave a row for the probe to read) and remove them afterwards. Roles
 * are prefixed d_ops4_ and dropped. Every row and name is synthetic.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const SCHEMA = "d_ops4_primary";
const OWNER_SENTINEL = "d0".repeat(32);

async function endpoint() {
  const socket = PG_TEST_SOCKET || (PG_TEST_HOST?.startsWith("/") ? PG_TEST_HOST : undefined);
  assert.ok(socket || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "the probe tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (socket) {
    assert.match(socket, SOCKET_DIRECTORY);
    const link = await lstat(socket);
    const host = await realpath(socket);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

let admin;
let pool;
let databaseName;
let setupPromise;
const roles = [];

function poolFor(host, port, database, extra = {}) {
  const value = new pg.Pool({
    host, port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database, ssl: false, max: 8,
    connectionTimeoutMillis: 5_000, ...extra,
  });
  value.on("error", () => {});
  return value;
}

/** The test database, its migrated schema and the shared pool, built once. */
function environment() {
  setupPromise ??= (async () => {
    const { host, port } = await endpoint();
    admin = poolFor(host, port, PG_TEST_DATABASE, { max: 2, application_name: "d-ops4-admin" });
    const server = await admin.query("SELECT current_setting('server_version_num')::integer AS version, rolsuper "
      + "FROM pg_roles WHERE rolname = current_user");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the probe is qualified on PostgreSQL 17");
    assert.equal(server.rows[0].rolsuper, true, "the spec seeds with session_replication_role as the local superuser");
    databaseName = `d_ops4_probe_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = poolFor(host, port, databaseName, { application_name: "d-ops4-test" });
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    const applied = await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool });
    assert.ok(applied.applied > 0);
    return { host, port };
  })();
  return setupPromise;
}

after(async () => {
  try {
    if (pool) await pool.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  } finally {
    if (admin) await admin.end();
  }
});

const table = (name) => {
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${SCHEMA}"."${name}"`;
};

/** A client in a transaction-less session as the superuser, with triggers off while `body` runs. */
async function seeding(body) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return await body(client);
  } finally {
    try { await client.query("RESET session_replication_role"); } catch { /* the client is discarded below */ }
    client.release();
  }
}

async function probeLines(client, schema = SCHEMA) {
  const lines = await collectOpsRuntimeSignals({ client, schema });
  return new Map(lines.map((line) => [`${line.probe}${line.class === undefined ? "" : `/${line.class}`}`, line]));
}

async function withClient(body, applicationName = "d-ops4-probe") {
  const client = await pool.connect();
  try {
    await client.query(`SET application_name = '${applicationName}'`);
    return await body(client);
  } finally {
    client.release();
  }
}

const unavailable = (map, key) => {
  const line = map.get(key);
  assert.ok(line, key);
  assert.equal(line.state, "unavailable", key);
  assert.equal(Object.hasOwn(line, "value"), false, `${key} carries no value`);
  return `${line.reason}${line.sqlstate_class === undefined ? "" : `:${line.sqlstate_class}`}`;
};
const measured = (map, key) => {
  const line = map.get(key);
  assert.ok(line, key);
  assert.equal(line.state, "ok", `${key}: ${line.reason}`);
  return line.value;
};

async function poll(read, ok, { attempts = 80, delayMs = 100 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((done) => setTimeout(done, delayMs));
  }
  assert.fail(`condition not reached; last: ${JSON.stringify(last)}`);
  return last;
}

test("an empty migrated schema reports what it cannot know as unavailable, never 0", { skip: SKIP, timeout: 240_000 }, async () => {
  await environment();
  const map = await withClient((client) => probeLines(client));
  // The lifecycle singleton exists (seeded never_run) but has never completed.
  assert.equal(unavailable(map, "maintenance_completed_age_seconds"), "NO_DATA");
  assert.equal(unavailable(map, "analytics_refresh_completed_age_seconds"), "NO_DATA");
  assert.equal(unavailable(map, "community_daily_head_age_days"), "NO_DATA");
  assert.equal(unavailable(map, "v12_newest_ready_manifest_age_seconds"), "NO_DATA");
  // No source row, so no journal: head, lag, pending and age all say NO_DATA.
  for (const name of ["ingestion_journal_head_sequence", "ingestion_journal_head_age_seconds", "analytics_journal_lag_sequences",
    "analytics_journal_pending_events", "analytics_journal_oldest_undelivered_age_seconds"]) {
    assert.equal(unavailable(map, name), "NO_DATA", name);
  }
  // The database itself always answers.
  assert.ok(measured(map, "database_size_bytes") > 0);
  assert.ok(measured(map, "database_xid_age") >= 0);
  assert.ok(measured(map, "database_mxid_age") >= 0);
  assert.ok(Number.isInteger(measured(map, "database_deadlocks_total")));
  assert.equal(measured(map, "database_conflicts_total"), 0, "a primary has no recovery conflicts");
  // The superuser sees every session; nothing here is waiting or open.
  for (const klass of OPS_ACTIVITY_CLASSES) {
    assert.equal(measured(map, `lock_waiting_sessions/${klass}`), 0, klass);
    assert.equal(measured(map, `oldest_transaction_age_seconds/${klass}`), 0, klass);
  }
  assert.equal(measured(map, "idle_in_transaction_sessions"), 0);
  // Every signal the job writes is on the contract, once.
  const expected = opsProbeNamesForJob("ops-runtime-probe")
    .filter((name) => !["log_redaction_marker", "log_redaction_posture"].includes(name))
    .flatMap((name) => (OPS_PROBES[name].perClass ? OPS_ACTIVITY_CLASSES.map((klass) => `${name}/${klass}`) : [name]));
  assert.deepEqual([...map.keys()].sort(), expected.sort());
});

test("the maintenance age comes from retention_state.last_completed_at", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  try {
    await pool.query(`UPDATE ${table("retention_state")} SET last_completed_at = clock_timestamp() - interval '90 seconds' WHERE singleton = 1`);
    const age = measured(await withClient((client) => probeLines(client)), "maintenance_completed_age_seconds");
    assert.ok(age >= 90 && age < 100, `age ${age}`);
    // A completion stamped ahead of the database clock reads 0, never negative.
    await pool.query(`UPDATE ${table("retention_state")} SET last_completed_at = clock_timestamp() + interval '1 hour' WHERE singleton = 1`);
    assert.equal(measured(await withClient((client) => probeLines(client)), "maintenance_completed_age_seconds"), 0);
  } finally {
    await pool.query(`UPDATE ${table("retention_state")} SET last_completed_at = NULL WHERE singleton = 1`);
  }
});

test("the refresh age is the newest complete run; a newer failed run does not count", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const completeId = randomUUID();
  const failedId = randomUUID();
  const insert = (id, state, minutesAgo) => pool.query(
    `INSERT INTO ${table("analytics_v2_runs")} (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings)
     VALUES ($1, now() - ($2 || ' minutes')::interval - interval '30 seconds', now() - ($2 || ' minutes')::interval, 'full', $3, 0, 0, '[]'::jsonb,
       '{"published":[],"unchanged":[],"blocked":[]}'::jsonb, '{}'::jsonb)`, [id, String(minutesAgo), state]);
  try {
    await insert(completeId, "complete", 7);
    await insert(failedId, "failed", 1);
    const age = measured(await withClient((client) => probeLines(client)), "analytics_refresh_completed_age_seconds");
    assert.ok(age >= 420 && age < 440, `age ${age}`);
  } finally {
    await pool.query(`DELETE FROM ${table("analytics_v2_runs")} WHERE run_id = ANY($1::uuid[])`, [[completeId, failedId]]);
  }
});

test("the community head age is whole UTC days since the newest published day, 0 for a future day", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const days = [];
  const insert = async (offset) => {
    const row = await pool.query(`SELECT to_char((now() AT TIME ZONE 'UTC')::date + $1::int, 'YYYY-MM-DD') AS day`, [offset]);
    const day = row.rows[0].day;
    days.push(day);
    await pool.query(`INSERT INTO ${table("analytics_v2_published_daily")} (day, revision, released_at, payload, payload_sha256, run_id)
      VALUES ($1::date, 1, now(), $2::jsonb, $3, $4)`, [day, JSON.stringify({ day, revision: 1, aggregateId: `community-daily:${day}:r1` }),
      randomBytes(32).toString("hex"), randomUUID()]);
  };
  try {
    await insert(-10);
    await insert(-3);
    assert.equal(measured(await withClient((client) => probeLines(client)), "community_daily_head_age_days"), 3);
    await insert(2);
    assert.equal(measured(await withClient((client) => probeLines(client)), "community_daily_head_age_days"), 0);
  } finally {
    await seeding((client) => client.query(`DELETE FROM ${table("analytics_v2_published_daily")} WHERE day = ANY($1::date[])`, [days]));
  }
});

test("the newest ready v1.2 manifest gives its age; an absent relation is unavailable with its SQLSTATE class", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const ids = [randomUUID(), randomUUID()];
  try {
    await seeding(async (client) => {
      for (const [index, id] of ids.entries()) {
        await client.query(`INSERT INTO ${table("telemetry_v12_day_manifests")}
          (id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at, ready_at)
          VALUES ($1, $2, $3, current_date, $4, 'synthetic', '{}', 0, 'ready', now(), now() - ($5 || ' minutes')::interval)`,
        [id, `synthetic-participant-${index}`, `synthetic-device-${index}`, randomBytes(32).toString("hex"), String(index === 0 ? 30 : 12)]);
      }
    });
    const age = measured(await withClient((client) => probeLines(client)), "v12_newest_ready_manifest_age_seconds");
    assert.ok(age >= 720 && age < 740, `the newest of the two, 12 minutes: ${age}`);
    // The relation absent (a schema older than 0006): unavailable, not 0.
    await pool.query(`ALTER TABLE ${table("telemetry_v12_day_manifests")} RENAME TO d_ops4_hidden_manifests`);
    try {
      assert.equal(unavailable(await withClient((client) => probeLines(client)), "v12_newest_ready_manifest_age_seconds"), "RELATION_ABSENT:42");
    } finally {
      await pool.query(`ALTER TABLE "${SCHEMA}"."d_ops4_hidden_manifests" RENAME TO telemetry_v12_day_manifests`);
    }
  } finally {
    await seeding((client) => client.query(`DELETE FROM ${table("telemetry_v12_day_manifests")} WHERE id = ANY($1::text[])`, [ids]));
  }
});

/**
 * Seeds `count` journal rows of one source with sequences from `from`. Row n is
 * recorded (recordedMs) minus one second for each row after it, so the newest
 * row is recorded at recordedMs.
 */
async function seedJournal(client, { source = "synthetic-source-a", from, count, recordedMs }) {
  await client.query(`INSERT INTO ${table("storage_ingestion_changes")}
      (source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms)
    SELECT $1::text, n, md5(n::text) || md5($2::text || n::text), $3::text, 1, 0, 'source-updated',
           $4::bigint - ($5::bigint + $6::bigint - 1 - n) * 1000
      FROM generate_series($5::bigint, $5::bigint + $6::bigint - 1) AS n`,
  [source, "x", OWNER_SENTINEL, String(recordedMs), String(from), String(count)]);
}

async function resetJournal() {
  await seeding(async (client) => {
    await client.query(`DELETE FROM ${table("analytics_v2_journal_cursor")}`);
    await client.query(`DELETE FROM ${table("storage_ingestion_changes")}`);
    await client.query(`DELETE FROM ${table("storage_source_state")}`);
  });
}

test("the journal head, the cursor lag, the pending count and the oldest undelivered row are read from the one source", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  try {
    const now = Date.now();
    await seeding(async (client) => {
      await client.query(`INSERT INTO ${table("storage_source_state")} (singleton, source_id, authority_epoch) VALUES (1, 'synthetic-source-a', 0)`);
      // Twelve rows, one second apart, the newest recorded 4 s ago.
      await seedJournal(client, { from: 1, count: 12, recordedMs: now - 4_000 });
      // Another source's rows are not this journal's: they must not move the head.
      await client.query(`INSERT INTO ${table("storage_ingestion_changes")}
        (source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms)
        VALUES ('synthetic-source-b', 999, $1, $2, 1, 0, 'source-updated', $3)`, [randomBytes(32).toString("hex"), OWNER_SENTINEL, now]);
      await client.query(`INSERT INTO ${table("analytics_v2_journal_cursor")} (id, last_sequence, run_id) VALUES (1, 5, $1)`, [randomUUID()]);
    });
    const map = await withClient((client) => probeLines(client));
    assert.equal(measured(map, "ingestion_journal_head_sequence"), 12);
    const headAge = measured(map, "ingestion_journal_head_age_seconds");
    assert.ok(headAge >= 4 && headAge < 15, `head age ${headAge}`);
    assert.equal(measured(map, "analytics_journal_lag_sequences"), 7);
    assert.equal(measured(map, "analytics_journal_pending_events"), 7);
    assert.equal(map.get("analytics_journal_pending_events").capped, false);
    // Row 6 is the first undelivered one, recorded 10 s before the head's 4 s: 9 s.. 10 s old.
    const oldest = measured(map, "analytics_journal_oldest_undelivered_age_seconds");
    assert.ok(oldest >= 9 && oldest < 20, `oldest undelivered ${oldest}`);
    // Delivered to the end: nothing waits, so the age is 0 (evidence, not a gap).
    await seeding((client) => client.query(`UPDATE ${table("analytics_v2_journal_cursor")} SET last_sequence = 12 WHERE id = 1`));
    const caught = await withClient((client) => probeLines(client));
    assert.equal(measured(caught, "analytics_journal_lag_sequences"), 0);
    assert.equal(measured(caught, "analytics_journal_pending_events"), 0);
    assert.equal(measured(caught, "analytics_journal_oldest_undelivered_age_seconds"), 0);
    // No cursor row yet (no run has read the journal): the whole journal is pending, as in the admin overview.
    await seeding((client) => client.query(`DELETE FROM ${table("analytics_v2_journal_cursor")}`));
    const first = await withClient((client) => probeLines(client));
    assert.equal(measured(first, "analytics_journal_lag_sequences"), 12);
    assert.equal(measured(first, "analytics_journal_pending_events"), 12);
    // A cursor ahead of its own journal is a fault, not a negative lag.
    await seeding((client) => client.query(`INSERT INTO ${table("analytics_v2_journal_cursor")} (id, last_sequence, run_id) VALUES (1, 13, $1)`, [randomUUID()]));
    const ahead = await withClient((client) => probeLines(client));
    assert.equal(unavailable(ahead, "analytics_journal_lag_sequences"), "UNEXPECTED_RESULT");
    assert.equal(unavailable(ahead, "analytics_journal_pending_events"), "UNEXPECTED_RESULT");
    assert.equal(measured(ahead, "ingestion_journal_head_sequence"), 12, "the head is still readable");
  } finally {
    await resetJournal();
  }
});

test("a journal source that has no change rows yet has head sequence 0 and no age", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  try {
    await seeding((client) => client.query(`INSERT INTO ${table("storage_source_state")} (singleton, source_id, authority_epoch) VALUES (1, 'synthetic-source-a', 0)`));
    const map = await withClient((client) => probeLines(client));
    assert.equal(measured(map, "ingestion_journal_head_sequence"), 0);
    assert.equal(unavailable(map, "ingestion_journal_head_age_seconds"), "NO_DATA");
    assert.equal(measured(map, "analytics_journal_lag_sequences"), 0);
    assert.equal(measured(map, "analytics_journal_pending_events"), 0);
  } finally {
    await resetJournal();
  }
});

test("the pending-journal backlog is capped at 10001, exactly, in the statement itself", { skip: SKIP, timeout: 240_000 }, async () => {
  await environment();
  try {
    await seeding(async (client) => {
      await client.query(`INSERT INTO ${table("storage_source_state")} (singleton, source_id, authority_epoch) VALUES (1, 'synthetic-source-a', 0)`);
      // 10,014 rows: sequences 1..10014.
      await seedJournal(client, { from: 1, count: OPS_BACKLOG_CAP + 13, recordedMs: Date.now() });
      await client.query(`INSERT INTO ${table("analytics_v2_journal_cursor")} (id, last_sequence, run_id) VALUES (1, 0, $1)`, [randomUUID()]);
    });
    const at = async (cursor) => {
      await seeding((client) => client.query(`UPDATE ${table("analytics_v2_journal_cursor")} SET last_sequence = $1 WHERE id = 1`, [cursor]));
      return withClient((client) => probeLines(client));
    };
    // 10,014 pending: capped at 10001.
    let map = await at(0);
    assert.equal(measured(map, "analytics_journal_pending_events"), 10_001);
    assert.equal(map.get("analytics_journal_pending_events").capped, true);
    assert.equal(measured(map, "analytics_journal_lag_sequences"), 10_014, "the lag is exact, not capped");
    // Exactly 10,002, then exactly 10,001 pending: both read 10001, capped.
    map = await at(12);
    assert.equal(measured(map, "analytics_journal_pending_events"), 10_001);
    assert.equal(map.get("analytics_journal_pending_events").capped, true);
    map = await at(13);
    assert.equal(measured(map, "analytics_journal_pending_events"), 10_001);
    assert.equal(map.get("analytics_journal_pending_events").capped, true);
    // 10,000 pending: exact, and not capped.
    map = await at(14);
    assert.equal(measured(map, "analytics_journal_pending_events"), 10_000);
    assert.equal(map.get("analytics_journal_pending_events").capped, false);
    assert.equal(measured(map, "analytics_journal_lag_sequences"), 10_000);
  } finally {
    await resetJournal();
  }
});

test("every probe transaction is read only, with the two bounds, on a real session", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  await withClient(async (real) => {
    const checked = { selects: 0, begins: 0 };
    const guarded = {
      async query(text, values) {
        if (text.startsWith("BEGIN")) checked.begins += 1;
        if (text.startsWith("SELECT")) {
          checked.selects += 1;
          const mode = await real.query("SHOW transaction_read_only");
          assert.equal(mode.rows[0].transaction_read_only, "on", `a probe read must run read only: ${text.slice(0, 60)}`);
          assert.equal((await real.query("SHOW statement_timeout")).rows[0].statement_timeout, "2s");
          assert.equal((await real.query("SHOW lock_timeout")).rows[0].lock_timeout, "500ms");
          assert.equal((await real.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
        }
        return real.query(text, values);
      },
    };
    const lines = await collectOpsRuntimeSignals({ client: guarded, schema: SCHEMA });
    assert.ok(lines.length > 20);
    assert.equal(checked.begins, 9);
    assert.ok(checked.selects >= 9);
    // Outside its transactions the session is back to its own defaults: nothing leaked.
    assert.equal((await real.query("SHOW statement_timeout")).rows[0].statement_timeout, "0");
    assert.equal((await real.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  });
});

test("the probe writes nothing: no relation, row or sequence changes", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const fingerprint = async () => {
    const result = await pool.query(`SELECT (SELECT count(*) FROM pg_class WHERE relnamespace = '"${SCHEMA}"'::regnamespace)::int AS relations,
      (SELECT count(*) FROM pg_class WHERE relname = 'ops_probe_log_redaction')::int AS markers,
      (SELECT coalesce(sum(xmin::text::bigint), 0) FROM ${table("retention_state")})::text AS retention_xmin,
      (SELECT count(*) FROM ${table("storage_ingestion_changes")})::int AS journal`);
    return JSON.stringify(result.rows[0]);
  };
  const before = await fingerprint();
  await withClient((client) => probeLines(client));
  await withClient((client) => runLogRedactionProbe({ client }));
  assert.equal(await fingerprint(), before);
});

test("a lock held on a source relation makes the read time out in 500 ms, and the rest still answers", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${table("retention_state")} IN ACCESS EXCLUSIVE MODE`);
    const started = Date.now();
    const map = await withClient((client) => probeLines(client));
    assert.equal(unavailable(map, "maintenance_completed_age_seconds"), "LOCK_TIMEOUT:55");
    assert.ok(Date.now() - started < 5_000, "the bound, not the holder, ends the wait");
    assert.equal(measured(map, "database_size_bytes") > 0, true);
    assert.equal(unavailable(map, "analytics_refresh_completed_age_seconds"), "NO_DATA");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});

test("a read that outlasts 2000 ms is unavailable with STATEMENT_TIMEOUT", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const slow = "d_ops4_slow";
  await pool.query(`CREATE SCHEMA "${slow}"`);
  try {
    await pool.query(`CREATE VIEW "${slow}".analytics_v2_published_daily AS SELECT current_date AS day FROM pg_sleep(3)`);
    const started = Date.now();
    const map = await withClient((client) => probeLines(client, slow));
    assert.equal(unavailable(map, "community_daily_head_age_days"), "STATEMENT_TIMEOUT:57");
    assert.ok(Date.now() - started < 8_000);
    // The rest of that schema does not exist: each group says so on its own.
    assert.equal(unavailable(map, "maintenance_completed_age_seconds"), "RELATION_ABSENT:42");
    assert.equal(measured(map, "database_size_bytes") > 0, true);
  } finally {
    await pool.query(`DROP SCHEMA "${slow}" CASCADE`);
  }
});

test("a deadlock raises the cumulative deadlock count by one", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const base = measured(await withClient((client) => probeLines(client)), "database_deadlocks_total");
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    await a.query(`LOCK TABLE ${table("retention_state")} IN ACCESS EXCLUSIVE MODE`);
    await b.query(`LOCK TABLE ${table("storage_source_state")} IN ACCESS EXCLUSIVE MODE`);
    const waitA = a.query(`LOCK TABLE ${table("storage_source_state")} IN ACCESS EXCLUSIVE MODE`).catch((error) => error);
    await poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [databaseName])).rows[0].n,
      (n) => n >= 1);
    const waitB = b.query(`LOCK TABLE ${table("retention_state")} IN ACCESS EXCLUSIVE MODE`).catch((error) => error);
    const outcomes = await Promise.all([waitA, waitB]);
    assert.equal(outcomes.filter((outcome) => outcome?.code === "40P01").length, 1, "exactly one session is chosen as the deadlock victim");
  } finally {
    for (const client of [a, b]) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
  const after = await poll(async () => measured(await withClient((client) => probeLines(client)), "database_deadlocks_total"),
    (count) => count >= base + 1, { attempts: 60, delayMs: 200 });
  assert.equal(after, base + 1);
});

test("session signals count by application class and never name the application", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  const origin = await pool.connect();
  const maintenance = await pool.connect();
  const stranger = await pool.connect();
  let waiting;
  try {
    await origin.query("SET application_name = 'tibotattle-cloud-run-host'");
    await maintenance.query("SET application_name = 'tibotattle-maintenance-job'");
    await stranger.query("SET application_name = 'd-ops4-unknown-tool'");
    await origin.query("BEGIN");
    // A relation the probe itself never reads, so its own reads are not held up.
    await origin.query(`LOCK TABLE ${table("pending_quarantine_objects")} IN ACCESS EXCLUSIVE MODE`);
    await stranger.query("BEGIN");
    await maintenance.query("BEGIN");
    waiting = maintenance.query(`SELECT 1 FROM ${table("pending_quarantine_objects")}`).catch((error) => error);
    await poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [databaseName])).rows[0].n,
      (n) => n === 1);
    await new Promise((done) => setTimeout(done, 1_200));
    const map = await withClient((client) => probeLines(client));
    assert.equal(measured(map, "lock_waiting_sessions/maintenance"), 1);
    for (const klass of ["origin", "analytics", "migration", "probe", "other"]) {
      assert.equal(measured(map, `lock_waiting_sessions/${klass}`), 0, klass);
    }
    // origin and stranger sit idle in a transaction; the maintenance session is waiting, not idle.
    assert.equal(measured(map, "idle_in_transaction_sessions"), 2);
    assert.ok(measured(map, "oldest_transaction_age_seconds/origin") >= 1);
    assert.ok(measured(map, "oldest_transaction_age_seconds/maintenance") >= 1);
    assert.ok(measured(map, "oldest_transaction_age_seconds/other") >= 1, "an unknown application is class other");
    assert.equal(measured(map, "oldest_transaction_age_seconds/analytics"), 0);
    const text = [...map.values()].map(serializeOpsProbeLine).join("\n");
    for (const name of ["tibotattle-cloud-run-host", "tibotattle-maintenance-job", "d-ops4-unknown-tool", "pending_quarantine_objects", databaseName]) {
      assert.equal(text.includes(name), false, `${name} never reaches a line`);
    }
  } finally {
    await origin.query("ROLLBACK").catch(() => {});
    await waiting;
    for (const client of [origin, maintenance, stranger]) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
});

test("a role outside pg_read_all_stats gets PRIVILEGE_MISSING for the session signals; a revoked table reads 42501", { skip: SKIP, timeout: 180_000 }, async () => {
  await environment();
  const role = `d_ops4_plain_${randomBytes(4).toString("hex")}`;
  roles.push(role);
  await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await pool.query(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${role}"`);
  await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${role}"`);
  try {
    const asRole = async (body) => {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE "${role}"`);
        return await body(client);
      } finally {
        await client.query("RESET ROLE").catch(() => {});
        client.release();
      }
    };
    let map = await asRole((client) => probeLines(client));
    assert.equal(unavailable(map, "maintenance_completed_age_seconds"), "NO_DATA");
    for (const klass of OPS_ACTIVITY_CLASSES) {
      assert.equal(unavailable(map, `lock_waiting_sessions/${klass}`), "PRIVILEGE_MISSING", klass);
      assert.equal(unavailable(map, `oldest_transaction_age_seconds/${klass}`), "PRIVILEGE_MISSING", klass);
    }
    assert.equal(unavailable(map, "idle_in_transaction_sessions"), "PRIVILEGE_MISSING");
    assert.ok(measured(map, "database_size_bytes") > 0, "database signals need no extra privilege");
    // With the membership the same role sees every session.
    await pool.query(`GRANT pg_read_all_stats TO "${role}"`);
    map = await asRole((client) => probeLines(client));
    for (const klass of OPS_ACTIVITY_CLASSES) assert.equal(measured(map, `lock_waiting_sessions/${klass}`), 0);
    await pool.query(`REVOKE pg_read_all_stats FROM "${role}"`);
    // A table the role may not read: PRIVILEGE_MISSING with the class 42, and the rest unchanged.
    await pool.query(`REVOKE SELECT ON ${table("analytics_v2_runs")} FROM "${role}"`);
    map = await asRole((client) => probeLines(client));
    assert.equal(unavailable(map, "analytics_refresh_completed_age_seconds"), "PRIVILEGE_MISSING:42");
    assert.equal(unavailable(map, "maintenance_completed_age_seconds"), "NO_DATA");
  } finally {
    await pool.query(`DROP OWNED BY "${role}"`);
  }
});

test("the log-redaction probe forces a real 23505, leaves no relation, and reads the logging posture", { skip: SKIP, timeout: 120_000 }, async () => {
  await environment();
  await withClient(async (client) => {
    const lines = await runLogRedactionProbe({ client, randomHex: () => "0123456789abcdef0123456789abcdef" });
    assert.equal(lines[0].probe, "log_redaction_marker");
    assert.equal(lines[0].state, "ok");
    assert.equal(lines[0].value, 1);
    assert.equal(lines[0].marker, "tibotattle-log-redaction-0123456789abcdef0123456789abcdef");
    // The default local cluster is not terse: the posture reports 0, not a pass.
    assert.equal(lines[1].probe, "log_redaction_posture");
    assert.equal(lines[1].value, 0);
    // The temp table was never committed and is gone from this session and from every other.
    assert.equal((await client.query("SELECT to_regclass('pg_temp.ops_probe_log_redaction') AS relation")).rows[0].relation, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'ops_probe_log_redaction'")).rows[0].n, 0);
    // The session is usable and idle: the forced error did not leave a transaction open.
    assert.equal((await client.query("SELECT 1 AS ok")).rows[0].ok, 1);
    assert.equal((await client.query("SELECT now() = statement_timestamp() AS fresh")).rows[0].fresh, true);
    // The raw driver error WOULD carry the marker in its detail: that is what a verbose log would print.
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE ops_probe_log_redaction_raw (marker text PRIMARY KEY) ON COMMIT DROP");
    await client.query("INSERT INTO ops_probe_log_redaction_raw VALUES ('raw-marker')");
    const raw = await client.query("INSERT INTO ops_probe_log_redaction_raw VALUES ('raw-marker')").catch((error) => error);
    await client.query("ROLLBACK");
    assert.equal(raw.code, "23505");
    assert.match(raw.detail, /raw-marker/u);
    assert.equal(JSON.stringify(lines).includes("already exists"), false);
    // The five settings of the OPS-2 posture make the posture line 1.
    for (const setting of ["log_error_verbosity = 'terse'", "log_min_error_statement = 'panic'", "log_parameter_max_length = 0",
      "log_parameter_max_length_on_error = 0", "log_statement = 'none'"]) {
      await client.query(`SET ${setting}`);
    }
    const tight = await runLogRedactionProbe({ client, randomHex: () => "fedcba9876543210fedcba9876543210" });
    assert.equal(tight[0].value, 1);
    assert.equal(tight[1].value, 1);
    await client.query("RESET ALL");
  });
});

test("the job, end to end on a real pool, writes a closed content-free line per signal", { skip: SKIP, timeout: 180_000 }, async () => {
  await environment();
  try {
    await seeding(async (client) => {
      await client.query(`INSERT INTO ${table("storage_source_state")} (singleton, source_id, authority_epoch) VALUES (1, 'synthetic-source-a', 0)`);
      await seedJournal(client, { from: 1, count: 3, recordedMs: Date.now() - 2_000 });
    });
    const connector = { closed: false, close() { this.closed = true; } };
    const ends = [];
    const result = await runOpsRuntimeProbe({
      argv: [],
      env: {
        CLOUD_RUN_JOB: "synthetic-ops-runtime-probe",
        DEPLOYMENT_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
        OPS_PROBE_TARGET: "production",
        PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-ops-project:us-east1:synthetic-primary",
        PRIMARY_DATABASE: databaseName,
        PRIMARY_SCHEMA: SCHEMA,
        POSTGRES_IAM_USER: "synthetic-runtime@synthetic-ops-project.iam",
      },
      dependencies: {
        createConnector: () => connector,
        createIamPool: async (options) => {
          assert.equal(options.max, 1);
          assert.equal(options.applicationName, "tibotattle-ops-probe");
          assert.equal(options.database, databaseName);
          const { host: socket, port: socketPort } = await endpoint();
          const one = poolFor(socket, socketPort, databaseName, { max: 1, application_name: options.applicationName });
          const end = one.end.bind(one);
          one.end = async () => { ends.push("pool"); await end(); };
          return one;
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(connector.closed, true);
    assert.deepEqual(ends, ["pool"]);
    const text = result.lines.map(serializeOpsProbeLine).join("\n");
    for (const line of text.split("\n")) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.schema, "tibotattle-ops-probe-v1");
      assert.ok(OPS_PROBE_NAMES.includes(parsed.probe));
      assert.ok(["ok", "unavailable"].includes(parsed.state));
    }
    for (const forbidden of [OWNER_SENTINEL, "synthetic-source-a", databaseName, SCHEMA, "retention_state"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} never reaches a line`);
    }
    const map = new Map(result.lines.map((line) => [`${line.probe}${line.class === undefined ? "" : `/${line.class}`}`, line]));
    assert.equal(measured(map, "ingestion_journal_head_sequence"), 3);
    // The probe's own session is class "probe" by name and is excluded from its own counts.
    assert.equal(measured(map, "lock_waiting_sessions/probe"), 0);
  } finally {
    await resetJournal();
  }
});
