import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for ISO-2. This migration replaces the
 * owner-journal emitter (telemetry_emit_source_event) so that it checks for
 * the owner's storage_owner_revisions head before it takes
 * storage_source_state FOR UPDATE, the one global journal lock.
 *
 * The migration is staged as primary 0091, a provisional number that the
 * wave integrator changes at promotion. So this spec finds the file by name,
 * in staged-migrations/ or, once promoted, in migrations/. A staged copy is
 * applied after the repository chain, in one transaction under the runner's
 * search path.
 *
 * Comparison schemas reinstall the 0046 emitter statement verbatim from
 * 0046_owner_journal_authority.sql over the same chain. Any difference a test
 * sees between the two emitters therefore comes from the pre-check alone.
 * Every row is synthetic and content-free.
 *
 * Connection: a private Unix socket (PG_TEST_SOCKET) or loopback TCP
 * (PG_TEST_HOST). Without either, the PostgreSQL tests skip. A skip is not a
 * pass.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_DIRECTORIES = Object.freeze([
  { staged: true, directory: join(WORKER_ROOT, "postgres", "staged-migrations", "primary") },
  { staged: false, directory: join(WORKER_ROOT, "postgres", "migrations", "primary") },
]);
const PRECHECK_MIGRATION = /^\d{4}_owner_journal_emitter_head_precheck\.sql$/u;
const AUTHORITY_MIGRATION = /^0046_owner_journal_authority\.sql$/u;
const EMITTER_START = "CREATE OR REPLACE FUNCTION telemetry_emit_source_event(";
const EMITTER_END = "\n$$;";
const LOCKED_BODY = "  -- Lock the source authority before reading its sequence";
const SOURCE_ID = "synthetic-emitter-precheck-source";
const NOW = "2026-09-20T00:00:00.000Z";
const RECORDS_PER_UPLOAD = 3;

const digest = (seed) => createHash("sha256").update(String(seed)).digest("hex");

const migrationCache = new Map();
/** Exactly one primary migration matching `pattern`, staged or promoted. */
function readMigration(pattern) {
  if (!migrationCache.has(pattern)) {
    migrationCache.set(pattern, (async () => {
      const found = [];
      for (const { staged, directory } of PRIMARY_DIRECTORIES) {
        let names;
        try {
          names = await readdir(directory);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        for (const name of names.filter((entry) => pattern.test(entry))) {
          found.push({ staged, name, sql: await readFile(join(directory, name), "utf8") });
        }
      }
      assert.equal(found.length, 1, `${pattern} is either staged or promoted, never both or neither`);
      return found[0];
    })());
  }
  return migrationCache.get(pattern);
}
const readPrecheck = () => readMigration(PRECHECK_MIGRATION);
const readAuthority = () => readMigration(AUTHORITY_MIGRATION);

/** The one CREATE OR REPLACE statement for the emitter in `sql`. */
function emitterStatement(sql) {
  const start = sql.indexOf(EMITTER_START);
  assert.ok(start >= 0, "the migration replaces the emitter");
  assert.equal(sql.indexOf(EMITTER_START, start + 1), -1, "the migration replaces the emitter once");
  const end = sql.indexOf(EMITTER_END, start);
  assert.ok(end > start, "the emitter body is closed");
  return sql.slice(start, end + EMITTER_END.length);
}

/** The dollar-quoted body PostgreSQL stores as prosrc. */
function emitterBody(statement) {
  const open = statement.indexOf("AS $$");
  assert.ok(open > 0);
  return statement.slice(open + "AS $$".length, statement.length - "$$;".length);
}

// ---------------------------------------------------------------------------
// Static proof: one statement, and the 0046 body is untouched around one
// inserted lock-free guard.

test("the migration replaces only the emitter, adding one lock-free pre-check before the verbatim 0046 body", async () => {
  const precheck = await readPrecheck();
  const statement = emitterStatement(precheck.sql);
  assert.deepEqual(precheck.sql.replace(statement, "").split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--")), [],
  "nothing but comments surrounds the single emitter statement");

  const original = emitterStatement((await readAuthority()).sql);
  const split = (text) => {
    const at = text.indexOf(LOCKED_BODY);
    assert.ok(at > 0, "the locked 0046 body is present");
    assert.equal(text.indexOf(LOCKED_BODY, at + 1), -1);
    return [text.slice(0, at), text.slice(at)];
  };
  const [head, tail] = split(statement);
  const [originalHead, originalTail] = split(original);
  assert.equal(tail, originalTail, "everything from the source lock onwards is the 0046 body verbatim");
  assert.ok(head.startsWith(originalHead),
    "the signature, attributes, declarations and NULL-input return are the 0046 text verbatim");
  const inserted = head.slice(originalHead.length).split("\n")
    .filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.match(inserted, /^\s*IF EXISTS \(\s*SELECT 1\b[^;]*\)\s*THEN\s*RETURN;\s*END IF;\s*$/u,
    "the insertion is one EXISTS guard that only returns");
  for (const forbidden of [
    /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/iu,
    /\b(?:INSERT|UPDATE|DELETE|MERGE|PERFORM|LOCK|EXECUTE)\b/iu,
    /pg_advisory|storage_ingestion_changes|analytics_owner_state/iu,
  ]) {
    assert.doesNotMatch(inserted, forbidden, "the pre-check takes no lock and writes nothing");
  }
  for (const relation of ["storage_source_state", "storage_v11_owner_links", "storage_owner_revisions"]) {
    assert.match(inserted, new RegExp(`\\b${relation}\\b`, "u"));
  }
});

// ---------------------------------------------------------------------------
// PostgreSQL harness.

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "emitter pre-check tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

let sharedPool;
async function connection() {
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      ...(await endpoint()), user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
      ssl: false, max: 24, connectionTimeoutMillis: 5_000, application_name: "pg-owner-journal-emitter-precheck-test",
    });
    const version = await sharedPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "the emitter pre-check is qualified on PostgreSQL 17");
  }
  return sharedPool;
}

after(async () => {
  if (sharedPool) await sharedPool.end();
});

async function applyInTransaction(pool, schema, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `body` against a fresh schema: the repository's primary chain plus the
 * staged pre-check, or, with `emitter: "0046"`, the same chain with the 0046
 * emitter reinstalled verbatim.
 */
async function withSchema(body, { emitter = "precheck" } = {}) {
  assert.ok(["precheck", "0046"].includes(emitter));
  const pool = await connection();
  const schema = `emitter_precheck_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted}."${name}"`;
  };
  await pool.query(`CREATE SCHEMA ${quoted}`);
  try {
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const precheck = await readPrecheck();
    if (precheck.staged) await applyInTransaction(pool, schema, precheck.sql);
    const expected = emitter === "0046" ? emitterStatement((await readAuthority()).sql) : emitterStatement(precheck.sql);
    if (emitter === "0046") await applyInTransaction(pool, schema, expected);
    const live = await pool.query(`SELECT prosrc FROM pg_proc JOIN pg_namespace ns ON ns.oid=pronamespace
      WHERE nspname=$1 AND proname='telemetry_emit_source_event'`, [schema]);
    assert.deepEqual(live.rows.map((row) => row.prosrc), [emitterBody(expected)],
      `the live emitter is exactly the ${emitter} body`);
    await body({ pool, schema, quoted, table });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  }
}

/** A client whose unqualified names resolve in `schema`, as the Cloud Run host sets it. */
async function session(pool, quoted) {
  const client = await pool.connect();
  await client.query(`SET search_path TO ${quoted}, pg_catalog`);
  return client;
}

async function release(client) {
  await client.query("ROLLBACK").catch(() => {});
  await client.query("RESET search_path").catch(() => {});
  client.release();
}

async function initializeSource(db, table, epoch = 1) {
  await db.query(`INSERT INTO ${table("storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,$2)`,
    [SOURCE_ID, epoch]);
}

/**
 * One participant and, optionally, its owner link and its imported analytics
 * owner state. An unheaded owner with active link and analytics state is the
 * only one for which the version-0 path writes.
 */
async function createOwner(db, table, { participantId, owner, link = "active", analytics = null }) {
  await db.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ($1,$2)`, [participantId, NOW]);
  if (link) {
    await db.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state) VALUES ($1,$2,$3)`,
      [participantId, owner, link]);
  }
  if (analytics) {
    await db.query(`INSERT INTO ${table("analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
      VALUES ($1,$2,1,1,$3)`, [SOURCE_ID, owner, analytics]);
  }
}

async function append(db, quoted, kind, owner, label) {
  const result = await db.query(`SELECT ${quoted}.storage_journal_append($1,$2,$3,$4,$5)::int AS sequence`,
    [kind, owner, digest(`precheck-event-${label}`), digest(`precheck-object-${label}`), digest(`precheck-content-${label}`)]);
  return result.rows[0].sequence;
}

/**
 * A synthetic producer's journal step: take the source lock, then journal
 * owner-active for an owner without a head and source-updated otherwise.
 */
async function journalUpload(db, table, quoted, owner, label) {
  await db.query(`SELECT 1 FROM ${table("storage_source_state")} WHERE singleton=1 FOR UPDATE`);
  const head = await db.query(`SELECT 1 FROM ${table("storage_owner_revisions")} WHERE source_id=$1 AND owner_digest=$2`,
    [SOURCE_ID, owner]);
  const kind = head.rows.length === 0 ? "owner-active" : "source-updated";
  await append(db, quoted, kind, owner, label);
  return kind;
}

/** Raw retained records: each insert fires the 0014 trigger and so the emitter. */
async function rawRecords(db, table, participantId, label, count = RECORDS_PER_UPLOAD) {
  for (let index = 0; index < count; index += 1) {
    await db.query(`INSERT INTO ${table("telemetry_records")} (participant_id,record_kind,occurrence_id,observed_at,record_json)
      VALUES ($1,'usage',$2,$3,'{}'::jsonb)`, [participantId, `${label}-${index}`, NOW]);
  }
}

async function journal(db, table) {
  const result = await db.query(`SELECT sequence::int AS sequence,event_digest,owner_digest,owner_revision::int AS owner_revision,
      authority_epoch::int AS epoch,kind,event_tuple_version AS version,revision::int AS revision,object_digest,content_digest,
      public_authority_epoch::int AS public_epoch
    FROM ${table("storage_ingestion_changes")} ORDER BY sequence`);
  return result.rows;
}

async function heads(db, table) {
  const result = await db.query(`SELECT owner_digest,revision::int AS revision,authority_epoch::int AS epoch,state,
      last_sequence::int AS last_sequence,object_digest,content_digest,seeded_partial
    FROM ${table("storage_owner_revisions")} ORDER BY owner_digest`);
  return result.rows;
}

async function inputRevision(db, table, participantId) {
  const result = await db.query(`SELECT revision::int AS revision FROM ${table("input_versions")} WHERE participant_id=$1`,
    [participantId]);
  return result.rows[0]?.revision;
}

function assertGapless(rows) {
  assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: rows.length }, (_, index) => index + 1),
    "journal sequences are contiguous from 1");
  const exact = rows.filter((row) => row.version === 1);
  for (let index = 1; index < exact.length; index += 1) {
    const delta = exact[index].kind === "source-updated" ? 0 : 1;
    assert.equal(exact[index].public_epoch, exact[index - 1].public_epoch + delta,
      "each exact row's public epoch continues the previous exact row");
  }
}

/**
 * Open one transaction per job, release them together from a barrier, and
 * hold each transaction's locks briefly before COMMIT so the jobs contend.
 */
async function concurrently(pool, quoted, jobs) {
  let arrived = 0;
  let open;
  const barrier = new Promise((resolve) => { open = resolve; });
  return Promise.allSettled(jobs.map(async (job) => {
    let client;
    try {
      client = await session(pool, quoted);
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='20000ms'");
      await client.query("SET LOCAL statement_timeout='60000ms'");
    } catch (error) {
      open();
      if (client) await release(client);
      throw error;
    }
    arrived += 1;
    if (arrived === jobs.length) open();
    await barrier;
    try {
      const value = await job(client);
      await delay(20);
      await client.query("COMMIT");
      return value;
    } finally {
      await release(client);
    }
  }));
}

function rejectedCodes(settled) {
  return settled.filter((result) => result.status === "rejected")
    .map((result) => `${result.reason?.code ?? "unknown"} ${result.reason?.message ?? ""}`.trim());
}

/** Poll until `waiter` is blocked by `holder`'s transaction; bounded. */
async function waitUntilBlocked(pool, waiterPid, holderPid) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await pool.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [waiterPid, holderPid]);
    if (result.rows[0].blocked) return;
    await delay(20);
  }
  assert.fail("the waiting session never blocked on the holder's lock");
}

async function backendPid(client) {
  return (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

// ---------------------------------------------------------------------------
// The pre-check's purpose: a headed owner's raw changes no longer queue
// behind the global journal lock. Unheaded owners still take it; LF-2 must
// record that for v0.x-only owners.

test("PG17 a headed owner's raw changes skip the global journal lock, while an unheaded owner's still take it",
  { skip: SKIP, timeout: 180_000 }, async () => {
    const outcome = async (emitter) => {
      let result;
      await withSchema(async ({ pool, quoted, table }) => {
        await initializeSource(pool, table);
        const headed = { participantId: "synthetic-lock-headed", owner: digest("lock-headed"), analytics: "active" };
        const unheaded = { participantId: "synthetic-lock-unheaded", owner: digest("lock-unheaded"), analytics: "active" };
        for (const participant of [headed, unheaded]) await createOwner(pool, table, participant);
        await append(pool, quoted, "owner-active", headed.owner, "lock-headed");

        // Another producer holds the global lock: an uncommitted append.
        const holder = await session(pool, quoted);
        const attempt = async (participantId, label) => {
          const client = await session(pool, quoted);
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL lock_timeout='300ms'");
            await rawRecords(client, table, participantId, label);
            await client.query("COMMIT");
            return "committed";
          } catch (error) {
            return error?.code ?? "unknown";
          } finally {
            await release(client);
          }
        };
        try {
          await holder.query("BEGIN");
          await append(holder, quoted, "owner-active", digest("lock-holder"), "lock-holder");
          result = {
            headed: await attempt(headed.participantId, "lock-headed-records"),
            unheaded: await attempt(unheaded.participantId, "lock-unheaded-records"),
          };
          await holder.query("COMMIT");
        } finally {
          await release(holder);
        }
        const rows = await journal(pool, table);
        result.headedRows = rows.filter((row) => row.owner_digest === headed.owner).map((row) => [row.version, row.kind]);
        result.unheadedRows = rows.filter((row) => row.owner_digest === unheaded.owner).length;
        result.headedInput = await inputRevision(pool, table, headed.participantId);
        assertGapless(rows);
      }, { emitter });
      return result;
    };

    const precheck = await outcome("precheck");
    assert.equal(precheck.headed, "committed", "a headed owner's raw changes commit while another producer holds the lock");
    assert.deepEqual(precheck.headedRows, [[1, "owner-active"]], "and, as in 0046, journal nothing");
    assert.equal(precheck.headedInput, RECORDS_PER_UPLOAD, "while its input revision still advances per raw change");
    assert.equal(precheck.unheaded, "55P03", "an unheaded owner's raw change still waits for the global lock");
    assert.equal(precheck.unheadedRows, 0);

    const baseline = await outcome("0046");
    assert.equal(baseline.headed, "55P03", "control: the 0046 emitter makes the same headed change wait for the lock");
    assert.equal(baseline.unheaded, "55P03");
  });

test("PG17 a v0.2 contribution holds the global journal lock across its records only while its owner is unheaded",
  { skip: SKIP, timeout: 180_000 }, async () => {
    const outcome = async (emitter) => {
      const result = {};
      await withSchema(async ({ pool, quoted, table }) => {
        await initializeSource(pool, table);
        const owners = {
          headed: { participantId: "synthetic-hold-headed", owner: digest("hold-headed"), analytics: "active" },
          unheaded: { participantId: "synthetic-hold-unheaded", owner: digest("hold-unheaded"), analytics: "active" },
        };
        for (const owner of Object.values(owners)) await createOwner(pool, table, owner);
        await append(pool, quoted, "owner-active", owners.headed.owner, "hold-headed");
        for (const [name, owner] of Object.entries(owners)) {
          // The contribution has inserted its first record and has more to go.
          const contribution = await session(pool, quoted);
          const probe = await session(pool, quoted);
          try {
            await contribution.query("BEGIN");
            await rawRecords(contribution, table, owner.participantId, `hold-${name}-first`, 1);
            await probe.query("BEGIN");
            await probe.query("SET LOCAL lock_timeout='300ms'");
            result[name] = await append(probe, quoted, "owner-active", digest(`hold-probe-${name}`), `hold-probe-${name}`)
              .then(() => "appended", (error) => error?.code ?? "unknown");
            await rawRecords(contribution, table, owner.participantId, `hold-${name}-rest`, RECORDS_PER_UPLOAD - 1);
            await contribution.query("COMMIT");
          } finally {
            await release(probe);
            await release(contribution);
          }
        }
        assertGapless(await journal(pool, table));
      }, { emitter });
      return result;
    };

    assert.deepEqual(await outcome("precheck"), { headed: "appended", unheaded: "55P03" },
      "only an unheaded owner's contribution keeps other producers waiting until it commits");
    assert.deepEqual(await outcome("0046"), { headed: "55P03", unheaded: "55P03" },
      "control: under the 0046 emitter a headed owner's contribution held the lock as well");
  });

// ---------------------------------------------------------------------------
// The double check: a miss is re-checked under the lock.

test("PG17 a first upload whose emitter misses an uncommitted first head re-checks under the lock and writes no version-0 row",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    await initializeSource(pool, table);
    // The owner is new to the exact journal, but its imported analytics state
    // is active. That is the one state in which the version-0 path would write,
    // and in which a head that appears later makes that write a refused mix.
    const owner = { participantId: "synthetic-recheck-owner", owner: digest("recheck-owner"), analytics: "active" };
    await createOwner(pool, table, owner);

    // A: a producer that journals the owner's first head without touching the
    // owner's raw rows (for example the OJ-2 v1.2 bridge), still uncommitted.
    const first = await session(pool, quoted);
    // B: the owner's first upload. Its first raw row reaches the emitter while
    // A's head is invisible, so the lock-free check misses.
    const upload = await session(pool, quoted);
    let pendingRecords;
    try {
      await first.query("BEGIN");
      await append(first, quoted, "owner-active", owner.owner, "recheck-first");
      await upload.query("BEGIN");
      await upload.query("SET LOCAL lock_timeout='20000ms'");
      const uploadPid = await backendPid(upload);
      pendingRecords = rawRecords(upload, table, owner.participantId, "recheck-upload");
      pendingRecords.catch(() => {});
      await waitUntilBlocked(pool, uploadPid, await backendPid(first));
      await first.query("COMMIT");
      await pendingRecords;
      assert.equal(await journalUpload(upload, table, quoted, owner.owner, "recheck-upload"), "source-updated",
        "the upload sees the committed head");
      await upload.query("COMMIT");
    } finally {
      await release(first);
      // The upload's statements must settle before its client returns to the pool.
      await pendingRecords?.catch(() => {});
      await release(upload);
    }

    const rows = await journal(pool, table);
    assertGapless(rows);
    assert.deepEqual(rows.map((row) => [row.sequence, row.version, row.kind, row.revision]),
      [[1, 1, "owner-active", 1], [2, 1, "source-updated", 2]], "no version-0 row: the re-check under the lock found the head");
    assert.deepEqual((await heads(pool, table)).map(({ owner_digest, revision, epoch, state, last_sequence, seeded_partial }) =>
      [owner_digest, revision, epoch, state, last_sequence, seeded_partial]),
    [[owner.owner, 2, 1, "active", 2, false]], "one head");
    assert.equal(await inputRevision(pool, table, owner.participantId), RECORDS_PER_UPLOAD);
  }));

// ---------------------------------------------------------------------------
// Two concurrent first uploads for the same new owner. The 0014 triggers
// lock the participant's input_source_digests and input_versions rows before
// they call the emitter. Two uploads that write the same owner's raw rows
// therefore reach the emitter one after the other. The re-check under the
// lock is exercised by the deterministic test above, not here. This test
// guards the outcome of both upload orders.

test("PG17 two concurrent first uploads for a new owner produce one head, no version-0 row and a gapless journal",
  { skip: SKIP, timeout: 240_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    await initializeSource(pool, table);
    // Journal-first is the order LF-3 appends in, and the order V11-C adopts
    // under review recommendation 5. Rows-first is the order V11-C has today.
    // In rows-first, an owner whose imported analytics state is active
    // correctly gets 0046's version-0 row from the first raw row, because no
    // head exists yet. So rows-first rounds use owners with no analytics state.
    const variants = [
      { order: "journal-first", analytics: "active" },
      { order: "journal-first", analytics: null },
      { order: "rows-first", analytics: null },
    ];
    const rounds = 4;
    const owners = [];
    for (const [variantIndex, variant] of variants.entries()) {
      for (let round = 0; round < rounds; round += 1) {
        const label = `first-upload-${variantIndex}-${round}`;
        const owner = { participantId: `synthetic-${label}`, owner: digest(label), analytics: variant.analytics };
        await createOwner(pool, table, owner);
        owners.push(owner);
        const upload = (side) => async (client) => {
          if (variant.order === "journal-first") {
            const kind = await journalUpload(client, table, quoted, owner.owner, `${label}-${side}`);
            await rawRecords(client, table, owner.participantId, `${label}-${side}`);
            return kind;
          }
          await rawRecords(client, table, owner.participantId, `${label}-${side}`);
          return journalUpload(client, table, quoted, owner.owner, `${label}-${side}`);
        };
        const settled = await concurrently(pool, quoted, [upload("a"), upload("b")]);
        assert.deepEqual(rejectedCodes(settled), [], `${variant.order}: both uploads commit`);
        assert.deepEqual(settled.map((result) => result.value).sort(), ["owner-active", "source-updated"],
          `${variant.order}: exactly one upload initializes the owner`);
      }
    }

    const rows = await journal(pool, table);
    assertGapless(rows);
    assert.deepEqual(rows.filter((row) => row.version === 0), [], "no version-0 row for any new owner");
    const headRows = await heads(pool, table);
    assert.equal(headRows.length, owners.length, "one head per owner");
    for (const owner of owners) {
      const chain = rows.filter((row) => row.owner_digest === owner.owner);
      assert.deepEqual(chain.map((row) => [row.kind, row.revision, row.epoch]),
        [["owner-active", 1, 1], ["source-updated", 2, 1]]);
      const head = headRows.find((row) => row.owner_digest === owner.owner);
      assert.deepEqual([head.revision, head.epoch, head.state, head.last_sequence, head.seeded_partial],
        [2, 1, "active", chain[1].sequence, false]);
      assert.equal(await inputRevision(pool, table, owner.participantId), 2 * RECORDS_PER_UPLOAD,
        "both uploads' raw changes advanced the input revision");
    }
  }));

// ---------------------------------------------------------------------------
// Mixed contention: headed, unheaded and new owners and plain appends at once.

test("PG17 the journal stays gapless while emitter and append traffic contend", { skip: SKIP, timeout: 240_000 },
  async () => withSchema(async ({ pool, quoted, table }) => {
    await initializeSource(pool, table, 4);
    const make = (kind, count, analytics) => Array.from({ length: count }, (_, index) => ({
      participantId: `synthetic-mixed-${kind}-${index}`, owner: digest(`mixed-${kind}-${index}`), analytics,
    }));
    const headed = make("headed", 3, "active");
    const appenders = make("appender", 3, "active");
    const unheaded = make("unheaded", 3, "active");
    const fresh = make("fresh", 3, null);
    for (const owner of [...headed, ...appenders, ...unheaded, ...fresh]) await createOwner(pool, table, owner);
    for (const owner of [...headed, ...appenders]) await append(pool, quoted, "owner-active", owner.owner, `seed-${owner.owner}`);
    const seeded = (await journal(pool, table)).length;

    const jobs = [
      ...headed.map((owner) => (client) => rawRecords(client, table, owner.participantId, `mixed-${owner.owner}`)),
      ...appenders.map((owner) => (client) => append(client, quoted, "source-updated", owner.owner, `mixed-${owner.owner}`)),
      ...unheaded.map((owner) => (client) => rawRecords(client, table, owner.participantId, `mixed-${owner.owner}`)),
      ...fresh.map((owner) => async (client) => {
        await journalUpload(client, table, quoted, owner.owner, `mixed-${owner.owner}`);
        await rawRecords(client, table, owner.participantId, `mixed-${owner.owner}`);
      }),
    ];
    const settled = await concurrently(pool, quoted, jobs);
    assert.deepEqual(rejectedCodes(settled), [], "no job fails and none surfaces a driver conflict");

    const rows = await journal(pool, table);
    assertGapless(rows);
    assert.equal(rows.length, seeded + appenders.length + fresh.length + unheaded.length * RECORDS_PER_UPLOAD);
    const versionZero = rows.filter((row) => row.version === 0);
    assert.deepEqual([...new Set(versionZero.map((row) => row.owner_digest))].sort(), unheaded.map((owner) => owner.owner).sort(),
      "version-0 rows come only from unheaded owners");
    for (const owner of unheaded) {
      assert.equal(versionZero.filter((row) => row.owner_digest === owner.owner).length, RECORDS_PER_UPLOAD,
        "one version-0 row per raw change, as in 0046");
    }
    const headRows = await heads(pool, table);
    for (const owner of [...headed, ...appenders, ...fresh]) {
      const chain = rows.filter((row) => row.owner_digest === owner.owner);
      assert.ok(chain.every((row) => row.version === 1), "headed and new owners receive only exact rows");
      assert.deepEqual(chain.map((row) => row.revision), chain.map((_, index) => index + 1));
      assert.equal(headRows.find((row) => row.owner_digest === owner.owner).last_sequence, chain.at(-1).sequence);
    }
    assert.equal(headRows.length, headed.length + appenders.length + fresh.length);
  }));

// ---------------------------------------------------------------------------
// Differential oracle: every emitter decision equals 0046's.

async function createSocialDevice(db, table, participantId, deviceId) {
  const expires = "2026-12-20T00:00:00.000Z";
  const sessionId = `${participantId}-session`;
  const pairingId = `${participantId}-pairing`;
  await db.query(`INSERT INTO ${table("web_sessions")} (id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
    VALUES ($1,$2,$3,$3,$4,$5,$4)`, [sessionId, participantId, Buffer.alloc(32, 1), NOW, expires]);
  await db.query(`INSERT INTO ${table("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
      issued_at,expires_at,consumed_at,claimed_device_id
    ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`,
  [pairingId, participantId, sessionId, Buffer.alloc(32, 2), NOW, expires, deviceId]);
  await db.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [deviceId, participantId, pairingId, Buffer.alloc(32, 3), NOW, expires]);
}

async function v11Generation(db, table, { participantId, deviceId, generationId, previous = null }) {
  const token = digest(`precheck-token-${generationId}`);
  await db.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,from_day,through_day,
      winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,$5,0,'2026-09-20','2026-09-20','[]',$6,'2026-09-21T00:00:00.000Z')`,
  [token, participantId, deviceId, previous, digest(`precheck-legacy-${generationId}`), NOW]);
  await db.query(`INSERT INTO ${table("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,'2026-09-20','2026-09-20','[]',$8)`,
  [generationId, participantId, deviceId, token, previous, digest(`precheck-manifest-${generationId}`),
    digest(`precheck-legacy-${generationId}`), NOW]);
}

/** Every 0014 source kind for one participant: a v0.x contribution and its records, v1.1 heads, edits and a delete. */
async function sourceChanges(db, table, participantId, index) {
  await db.query(`INSERT INTO ${table("telemetry_contributions")} (
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,range_start,range_end,client_platform,
      provider_policy_epoch,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,
      declared_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1',$6,$6,'synthetic','synthetic',100,0,0,'synthetic',$7,$6)`,
  [`${participantId}-contribution`, participantId, digest(`precheck-plain-${index}`), digest(`precheck-envelope-${index}`),
    `synthetic/${participantId}/contribution`, NOW, RECORDS_PER_UPLOAD]);
  await rawRecords(db, table, participantId, `${participantId}-record`);
  await db.query(`UPDATE ${table("telemetry_records")} SET record_json='{"synthetic":1}'::jsonb WHERE participant_id=$1`,
    [participantId]);
  const deviceId = `${participantId}-device`;
  await createSocialDevice(db, table, participantId, deviceId);
  assert.ok(Number.isSafeInteger(index) && index >= 1 && index <= 9, "one hex digit keeps the generation id a UUID");
  const firstGeneration = `0d${index}00000-0000-4000-8000-000000000001`;
  const secondGeneration = `0d${index}00000-0000-4000-8000-000000000002`;
  await v11Generation(db, table, { participantId, deviceId, generationId: firstGeneration });
  await db.query(`INSERT INTO ${table("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, firstGeneration, NOW]);
  await v11Generation(db, table, { participantId, deviceId, generationId: secondGeneration, previous: firstGeneration });
  await db.query(`UPDATE ${table("telemetry_v11_domain_heads")} SET generation_id=$2,revision=2 WHERE participant_id=$1`,
    [participantId, secondGeneration]);
  await db.query(`DELETE FROM ${table("telemetry_records")} WHERE participant_id=$1 AND occurrence_id=$2`,
    [participantId, `${participantId}-record-0`]);
}

const ORACLE_OWNERS = Object.freeze([
  { name: "headed-active", link: "active", analytics: "active", journal: ["owner-active"] },
  { name: "headed-withdrawn", link: "active", analytics: "active", journal: ["owner-active", "owner-withdrawn"] },
  { name: "headed-erased", link: "active", analytics: "active", journal: ["owner-active", "owner-erased"] },
  { name: "unheaded-active", link: "active", analytics: "active", journal: [] },
  { name: "unheaded-analytics-withdrawn", link: "active", analytics: "withdrawn", journal: [] },
  { name: "unheaded-link-withdrawn", link: "withdrawn", analytics: "active", journal: [] },
  { name: "unheaded-no-analytics", link: "active", analytics: null, journal: [] },
  { name: "unlinked", link: null, analytics: null, journal: [] },
  // Journals version-0 rows until its first head appears mid-scenario.
  { name: "headed-later", link: "active", analytics: "active", journal: [] },
].map((owner) => ({ ...owner, participantId: `synthetic-oracle-${owner.name}`, owner: digest(`oracle-${owner.name}`) })));

async function oracleScenario({ pool, quoted, table }) {
  const client = await session(pool, quoted);
  try {
    const byName = new Map(ORACLE_OWNERS.map((owner) => [owner.name, owner]));
    for (const owner of ORACLE_OWNERS) await createOwner(client, table, owner);
    // Before the source exists, every emitter call returns without a row.
    await rawRecords(client, table, byName.get("unheaded-active").participantId, "oracle-pre-source", 2);
    await initializeSource(client, table, 3);
    for (const owner of ORACLE_OWNERS) {
      for (const [index, kind] of owner.journal.entries()) await append(client, quoted, kind, owner.owner, `oracle-${owner.name}-${index}`);
    }
    for (const [index, owner] of ORACLE_OWNERS.entries()) await sourceChanges(client, table, owner.participantId, index + 1);
    // The owner's first head, then more raw changes: version-0 rows stop.
    const later = byName.get("headed-later");
    await append(client, quoted, "owner-active", later.owner, "oracle-headed-later");
    await rawRecords(client, table, later.participantId, "oracle-headed-later-after");
    // A participant reassignment emits for the old and the new owner.
    await client.query(`UPDATE ${table("telemetry_records")} SET participant_id=$1 WHERE participant_id=$2 AND occurrence_id=$3`,
      [byName.get("headed-active").participantId, byName.get("unheaded-active").participantId,
        `${byName.get("unheaded-active").participantId}-record-1`]);
    // Direct calls: NULL inputs, an unknown participant, and a replayed event.
    const emit = (owner, key, revision) => client.query(`SELECT ${quoted}.telemetry_emit_source_event($1,$2,$3)`, [owner, key, revision]);
    await emit(null, "oracle-direct", 1);
    await emit(byName.get("unheaded-active").participantId, "oracle-direct", null);
    await emit("synthetic-oracle-unknown", "oracle-direct", 1);
    for (let replay = 0; replay < 2; replay += 1) {
      for (const owner of ORACLE_OWNERS) await emit(owner.participantId, "oracle-direct", 99);
    }
    const inputs = await client.query(`SELECT participant.id AS participant_id, versions.revision::int AS revision, digests.digest
      FROM ${table("participants")} participant
      LEFT JOIN ${table("input_versions")} versions ON versions.participant_id=participant.id
      LEFT JOIN ${table("input_source_digests")} digests ON digests.participant_id=participant.id
      ORDER BY participant.id`);
    const source = await client.query(`SELECT source_id,authority_epoch::int AS epoch FROM ${table("storage_source_state")}`);
    return { rows: await journal(client, table), heads: await heads(client, table), inputs: inputs.rows, source: source.rows };
  } finally {
    await release(client);
  }
}

test("PG17 differential oracle: every emitter outcome equals the 0046 emitter's, row for row",
  { skip: SKIP, timeout: 240_000 }, async () => {
    let baseline;
    await withSchema(async (context) => { baseline = await oracleScenario(context); }, { emitter: "0046" });
    let precheck;
    await withSchema(async (context) => { precheck = await oracleScenario(context); });

    assert.deepEqual(precheck, baseline,
      "journal rows (all columns but the clock), heads, input revisions, source digests and the source epoch are identical");

    // The oracle is not vacuous: it saw each outcome the emitter can produce.
    const owner = (name) => ORACLE_OWNERS.find((entry) => entry.name === name).owner;
    const versionZero = (name) => baseline.rows.filter((row) => row.owner_digest === owner(name) && row.version === 0);
    assertGapless(baseline.rows);
    assert.ok(versionZero("unheaded-active").length >= 8, "a v0.x-only owner keeps its version-0 rows");
    assert.ok(versionZero("headed-later").length >= 8, "an owner journals version-0 rows until its first head");
    const laterHead = baseline.rows.find((row) => row.owner_digest === owner("headed-later") && row.version === 1).sequence;
    assert.ok(versionZero("headed-later").every((row) => row.sequence < laterHead), "and none after it");
    for (const name of ["headed-active", "headed-withdrawn", "headed-erased", "unheaded-analytics-withdrawn",
      "unheaded-link-withdrawn", "unheaded-no-analytics"]) {
      assert.deepEqual(versionZero(name), [], `${name} receives no version-0 row`);
    }
    assert.equal(baseline.rows.filter((row) => row.event_digest.startsWith(createHash("md5").update("oracle-direct:99").digest("hex"))
      && row.owner_digest === owner("unheaded-active")).length, 1, "a replayed event is written once");
    assert.ok(baseline.inputs.filter((row) => row.revision !== null).length >= ORACLE_OWNERS.length);
  });
