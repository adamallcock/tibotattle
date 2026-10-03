// PostgreSQL 17 spec for REV-SEED's revision floor (owner decisions rounds 12
// and 14): the staged migration's guarantees and the cutover import's loader
// (scripts/cutover-revision-floor.mjs loadRevisionFloorInTransaction). The
// store and the refresh Job's use of the floor are proven in
// analytics-v2-refresh.spec.mjs; the PT-8-lite stage in
// postgres-production-transfer.spec.mjs.
//
// Schemas: the promoted primary chain through the production runner plus the
// staged floor migration through the staged-migrations harness (or the stock
// chain alone once promoted; the file is found by its suffix). Every row is
// synthetic and content-free.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//   node --test postgres-test/analytics-v2-revision-floor.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { classifyContractOperations } from "../cloud-run/postgres-production-migrations.mjs";
import {
  CUTOVER_REVISION_FLOOR_SCHEMA,
  loadRevisionFloorInTransaction,
  parseRevisionFloorFile,
  renderRevisionFloorFile,
} from "../scripts/cutover-revision-floor.mjs";
import {
  applyStockAndStagedMigrations,
  defaultAnalyticsV2FixtureStamps,
  listStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const FLOOR_SUFFIX = "_analytics_v2_revision_floor.sql";
const RUN_ID = "00000000-0000-4000-8000-0000000000f1";
const digest = label => createHash("sha256").update(`revision-floor-spec:${label}`).digest("hex");
const SEAL_ID = digest("seal");
const FENCE = digest("fence");
const COMMIT = "c".repeat(40);

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

let pool;
let migration;
const schemas = [];

const q = (schema, name) => `"${schema}"."${name}"`;

async function floorMigration() {
  const [staged, stock] = await Promise.all([
    listStagedMigrations("primary"), readPostgresMigrations({ role: "primary" }),
  ]);
  const found = [...staged, ...stock].filter(({ name }) => name.endsWith(FLOOR_SUFFIX));
  assert.equal(found.length, 1, "exactly one revision-floor migration, staged or promoted");
  return { ...found[0], staged: staged.some(({ name }) => name === found[0].name) };
}

async function createSchema({ withFloor = true } = {}) {
  const schema = `rev_seed_${randomBytes(6).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: withFloor ? [migration.name] : [] });
  await defaultAnalyticsV2FixtureStamps(pool, schema);
  return schema;
}

/** A validated synthetic floor as the loader receives it (the parsed file, with its sha256). */
function floorOf(days, overrides = {}) {
  const { text, floorSha256 } = renderRevisionFloorFile({
    schema: CUTOVER_REVISION_FLOOR_SCHEMA, provenance: "synthetic", sealId: SEAL_ID, fenceReceiptSha256: FENCE,
    sourceCommit: COMMIT, capturedAt: "2026-10-02T01:30:00.000Z", capture: null, days,
    dayCount: days.length, maxRevision: Math.max(...days.map(([, revision]) => revision)), ...overrides,
  });
  return parseRevisionFloorFile(new TextEncoder().encode(text), floorSha256);
}

const FLOOR = [["2026-09-28", 5], ["2026-09-29", 1], ["2026-09-30", 12]];

async function load(schema, floor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await loadRevisionFloorInTransaction({ client, schema, floor });
    await client.query("COMMIT");
    return receipt;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function publish(schema, day, revision, sha = digest(`${day}:${revision}`)) {
  const payload = { aggregateId: `community-daily:${day}:r${revision}`, day, revision };
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")} AS head (day, revision, released_at, payload,
      payload_sha256, run_id) VALUES ($1, $2, '2026-10-02T06:00:00.000Z', $3::jsonb, $4, $5)
    ON CONFLICT (day) DO UPDATE SET revision = EXCLUDED.revision, payload = EXCLUDED.payload,
      payload_sha256 = EXCLUDED.payload_sha256`, [day, revision, JSON.stringify(payload), sha, RUN_ID]);
}

async function rejectsWith(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "P1005", `${message}: ${error.code}`);
    assert.equal(error.message, message);
    return true;
  }, message);
}

async function snapshot(schema) {
  const rows = {};
  for (const table of ["analytics_v2_revision_floor", "analytics_v2_revision_floor_source"]) {
    rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')::text AS rows
      FROM ${q(schema, table)} t`)).rows[0].rows;
  }
  return rows;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ ...endpoint, ssl: false, max: 6, connectionTimeoutMillis: 5_000,
    application_name: "analytics-v2-revision-floor-spec", options: "-c search_path=pg_catalog" });
  const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
  migration = await floorMigration();
});

after(async () => {
  for (const schema of schemas.reverse()) await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await pool?.end();
});

test("the migration is additive and pins every trigger function's search_path", { skip }, async () => {
  assert.deepEqual(classifyContractOperations(migration.sql), [],
    "tables, functions and triggers only: no CONTRACT_MIGRATIONS entry is needed");
  const schema = await createSchema();
  const functions = (await pool.query(`SELECT p.proname, p.proconfig FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE 'analytics\\_v2\\_%floor%'
      ORDER BY p.proname`, [schema])).rows;
  assert.deepEqual(functions.map((row) => row.proname), ["analytics_v2_published_daily_above_floor",
    "analytics_v2_revision_floor_immutable", "analytics_v2_revision_floor_insert_guard"]);
  for (const row of functions) assert.ok(row.proconfig?.some((entry) => entry.startsWith("search_path=")), row.proname);
  // The floor trigger on the published heads is its own trigger, apart from 0059's forward-only one.
  const triggers = (await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal
      ORDER BY tgname`, [q(schema, "analytics_v2_published_daily")])).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, ["analytics_v2_published_daily_above_floor", "analytics_v2_published_daily_forward_only"]);
});

test("the floor is immutable, ordered (days, then the singleton that summarizes them) and refused after a publication", { skip }, async () => {
  const schema = await createSchema();
  // A singleton that does not summarize the day rows is refused.
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_revision_floor")} VALUES ('2026-09-28', 5), ('2026-09-30', 12)`);
  const source = (dayCount, maxRevision, provenance = "synthetic", bookmark = null) => pool.query(
    `INSERT INTO ${q(schema, "analytics_v2_revision_floor_source")} (id, provenance, seal_id, floor_sha256,
      fence_receipt_sha256, analytics_bookmark_sha256, source_commit, captured_at, day_count, max_revision)
     VALUES (1, $1, $2, $3, $4, $5, $6, '2026-10-02T01:30:00Z', $7, $8)`,
    [provenance, SEAL_ID, digest("floor"), FENCE, bookmark, COMMIT, dayCount, maxRevision]);
  await rejectsWith(source(3, 12), "analytics_v2_revision_floor_summary_mismatch");
  await rejectsWith(source(2, 11), "analytics_v2_revision_floor_summary_mismatch");
  // Captured needs its bookmark digest, synthetic has none.
  await assert.rejects(source(2, 12, "captured", null), { code: "23514" });
  await assert.rejects(source(2, 12, "synthetic", digest("bookmark")), { code: "23514" });
  await source(2, 12);
  // Sealed: no day row after the singleton; nothing changes or leaves.
  await rejectsWith(pool.query(`INSERT INTO ${q(schema, "analytics_v2_revision_floor")} VALUES ('2026-09-29', 1)`),
    "analytics_v2_revision_floor_sealed");
  for (const sql of [
    `UPDATE ${q(schema, "analytics_v2_revision_floor")} SET revision = 6`,
    `DELETE FROM ${q(schema, "analytics_v2_revision_floor")}`,
    `TRUNCATE ${q(schema, "analytics_v2_revision_floor")}`,
    `UPDATE ${q(schema, "analytics_v2_revision_floor_source")} SET day_count = 2`,
    `DELETE FROM ${q(schema, "analytics_v2_revision_floor_source")}`,
    `TRUNCATE ${q(schema, "analytics_v2_revision_floor_source")}`,
  ]) {
    await rejectsWith(pool.query(sql), "analytics_v2_revision_floor_immutable");
  }
  // Revisions are 1..2,000,000,000 (ANALYTICS_V2_MAX_REVISION_SEED).
  const other = await createSchema();
  for (const revision of [0, 2_000_000_001]) {
    await assert.rejects(pool.query(`INSERT INTO ${q(other, "analytics_v2_revision_floor")} VALUES ('2026-09-28', $1)`,
      [revision]), { code: "23514" });
  }
  // Once a day is published no floor row can be inserted, in either table.
  await publish(other, "2026-09-01", 1);
  await rejectsWith(pool.query(`INSERT INTO ${q(other, "analytics_v2_revision_floor")} VALUES ('2026-09-28', 5)`),
    "analytics_v2_revision_floor_after_publication");
});

test("a published head at or below its day's floor is refused, insert and update alike; above it is accepted", { skip }, async () => {
  const schema = await createSchema();
  await load(schema, floorOf(FLOOR));
  await rejectsWith(publish(schema, "2026-09-28", 5), "analytics_v2_published_daily_below_floor");
  await rejectsWith(publish(schema, "2026-09-28", 1), "analytics_v2_published_daily_below_floor");
  await publish(schema, "2026-09-28", 6);
  await publish(schema, "2026-10-01", 1); // a day Cloudflare never published starts at r1
  await publish(schema, "2026-09-29", 2);
  // A forward move that would land at or below the floor is refused by the
  // floor trigger even where 0059's forward-only trigger would admit it.
  await publish(schema, "2026-09-30", 13);
  await pool.query(`ALTER TABLE ${q(schema, "analytics_v2_published_daily")}
    DISABLE TRIGGER analytics_v2_published_daily_forward_only`);
  try {
    await rejectsWith(pool.query(`UPDATE ${q(schema, "analytics_v2_published_daily")} SET revision = 12,
        payload = jsonb_set(jsonb_set(payload, '{revision}', '12'), '{aggregateId}', '"community-daily:2026-09-30:r12"'),
        payload_sha256 = $1 WHERE day = '2026-09-30'`, [digest("moved")]), "analytics_v2_published_daily_below_floor");
  } finally {
    await pool.query(`ALTER TABLE ${q(schema, "analytics_v2_published_daily")}
      ENABLE TRIGGER analytics_v2_published_daily_forward_only`);
  }
  const heads = (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, revision
    FROM ${q(schema, "analytics_v2_published_daily")} ORDER BY day`)).rows;
  assert.deepEqual(heads, [{ day: "2026-09-28", revision: 6 }, { day: "2026-09-29", revision: 2 },
    { day: "2026-09-30", revision: 13 }, { day: "2026-10-01", revision: 1 }]);
});

test("the loader writes the floor once: an identical reload writes nothing, any other floor is refused", { skip }, async () => {
  const schema = await createSchema();
  const floor = floorOf(FLOOR);
  const loaded = await load(schema, floor);
  assert.equal(loaded.state, "loaded");
  assert.deepEqual({ ...loaded }, { state: "loaded", provenance: "synthetic", floorSha256: floor.floorSha256, sealId: SEAL_ID,
    dayCount: 3, maxRevision: 12, firstDay: "2026-09-28", lastDay: "2026-09-30" });
  const stored = await snapshot(schema);
  const source = (await pool.query(`SELECT provenance, seal_id::text AS seal_id, floor_sha256::text AS floor_sha256,
      fence_receipt_sha256::text AS fence, analytics_bookmark_sha256, source_commit::text AS source_commit,
      to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at, day_count, max_revision
      FROM ${q(schema, "analytics_v2_revision_floor_source")}`)).rows;
  assert.deepEqual(source, [{ provenance: "synthetic", seal_id: SEAL_ID, floor_sha256: floor.floorSha256, fence: FENCE,
    analytics_bookmark_sha256: null, source_commit: COMMIT, captured_at: "2026-10-02T01:30:00.000Z", day_count: 3,
    max_revision: 12 }]);
  assert.equal((await load(schema, floor)).state, "already-loaded");
  assert.deepEqual(await snapshot(schema), stored, "an identical reload writes nothing");
  // Another floor: other days, another revision, another seal.
  for (const other of [floorOf(FLOOR.slice(1)), floorOf([["2026-09-28", 6], ...FLOOR.slice(1)]),
    floorOf(FLOOR, { sealId: digest("another-seal") })]) {
    await assert.rejects(load(schema, other), { code: "REVISION_FLOOR_CONFLICT" });
  }
  assert.deepEqual(await snapshot(schema), stored);
  // A captured floor stores its bookmark digest.
  const captured = await createSchema();
  const capture = { analyticsDatabaseIdSha256: digest("d1"), analyticsBookmarkSha256: digest("bookmark"),
    statementSha256: (await import("../scripts/cutover-source-seal.mjs")).CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 };
  await load(captured, floorOf(FLOOR, { provenance: "captured", capture }));
  assert.deepEqual((await pool.query(`SELECT provenance, analytics_bookmark_sha256::text AS bookmark
    FROM ${q(captured, "analytics_v2_revision_floor_source")}`)).rows, [{ provenance: "captured", bookmark: digest("bookmark") }]);
});

test("the loader refuses a target that has published, lacks the tables, or holds partial state", { skip }, async () => {
  const floor = floorOf(FLOOR);
  const published = await createSchema();
  await publish(published, "2026-09-01", 1);
  await assert.rejects(load(published, floor), { code: "REVISION_FLOOR_PUBLICATION_EXISTS" });
  assert.deepEqual(await snapshot(published), { analytics_v2_revision_floor: "[]", analytics_v2_revision_floor_source: "[]" });
  // A schema without the migration (only while it is staged: once promoted, every chain carries it).
  if (migration.staged) {
    const missing = await createSchema({ withFloor: false });
    await assert.rejects(load(missing, floor), { code: "REVISION_FLOOR_TABLE_MISSING" });
  }
  // Day rows without their singleton (an interrupted foreign writer) are not this floor.
  const partial = await createSchema();
  await pool.query(`INSERT INTO ${q(partial, "analytics_v2_revision_floor")} VALUES ('2026-09-28', 5)`);
  await assert.rejects(load(partial, floor), { code: "REVISION_FLOOR_CONFLICT" });
  // Usage: a floor without its pinned sha256, a bad schema name.
  const schema = await createSchema();
  const client = await pool.connect();
  try {
    await assert.rejects(loadRevisionFloorInTransaction({ client, schema, floor: { ...floor, floorSha256: "x" } }),
      { code: "REVISION_FLOOR_USAGE" });
    await assert.rejects(loadRevisionFloorInTransaction({ client, schema: "Bad-Schema", floor }),
      { code: "REVISION_FLOOR_USAGE" });
    await assert.rejects(loadRevisionFloorInTransaction({ client, schema, floor: { ...floor, dayCount: 4 } }),
      { code: "REVISION_FLOOR_FILE_INVALID" });
  } finally {
    client.release();
  }
});

test("a load waits for an uncommitted publication and then refuses: the floor never slips in under one", { skip }, async () => {
  const schema = await createSchema();
  const publisher = await pool.connect();
  const loader = await pool.connect();
  try {
    await publisher.query("BEGIN");
    await publisher.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")} (day, revision, released_at, payload,
        payload_sha256, run_id) VALUES ('2026-09-28', 1, '2026-10-02T06:00:00Z',
        '{"aggregateId":"community-daily:2026-09-28:r1","day":"2026-09-28","revision":1}', $1, $2)`,
    [digest("race"), RUN_ID]);
    await loader.query("BEGIN");
    await loader.query("SET LOCAL lock_timeout = '300ms'");
    // The day insert's guard takes a SHARE lock on the published heads: it
    // cannot pass the uncommitted publication.
    await assert.rejects(loader.query(`INSERT INTO ${q(schema, "analytics_v2_revision_floor")} VALUES ('2026-09-28', 5)`),
      { code: "55P03" });
    await loader.query("ROLLBACK");
    await publisher.query("COMMIT");
    await loader.query("BEGIN");
    await rejectsWith(loader.query(`INSERT INTO ${q(schema, "analytics_v2_revision_floor")} VALUES ('2026-09-28', 5)`),
      "analytics_v2_revision_floor_after_publication");
    await loader.query("ROLLBACK");
  } finally {
    await publisher.query("ROLLBACK").catch(() => {});
    publisher.release();
    loader.release();
  }
});

test("a publication that commits while the loader waits fails the load as REVISION_FLOOR_WRITE_FAILED (P1005)", { skip }, async () => {
  // The loader's own check finds no committed publication, so the refusal
  // can only come from the day insert's trigger once the publication commits.
  const schema = await createSchema();
  const publisher = await pool.connect();
  const loader = await pool.connect();
  try {
    const { pid } = (await loader.query("SELECT pg_backend_pid() AS pid")).rows[0];
    await publisher.query("BEGIN");
    await publisher.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")} (day, revision, released_at, payload,
        payload_sha256, run_id) VALUES ('2026-09-28', 1, '2026-10-02T06:00:00Z',
        '{"aggregateId":"community-daily:2026-09-28:r1","day":"2026-09-28","revision":1}', $1, $2)`,
    [digest("loader-race"), RUN_ID]);
    await loader.query("BEGIN");
    const pending = loadRevisionFloorInTransaction({ client: loader, schema, floor: floorOf(FLOOR) })
      .then(() => null, (error) => error);
    // Wait until the loader's day insert is blocked on the publication's lock.
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
      const { rows } = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
      waiting = rows[0]?.wait_event_type === "Lock";
      if (!waiting) await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.equal(waiting, true, "the loader waits on the publication");
    await publisher.query("COMMIT");
    const error = await pending;
    assert.equal(error?.code, "REVISION_FLOOR_WRITE_FAILED");
    assert.equal(error.sqlState, "P1005");
    assert.equal(error.message, "REVISION_FLOOR_WRITE_FAILED", "content-free: no database message");
    await loader.query("ROLLBACK");
    assert.deepEqual(await snapshot(schema), { analytics_v2_revision_floor: "[]", analytics_v2_revision_floor_source: "[]" });
  } finally {
    await publisher.query("ROLLBACK").catch(() => {});
    await loader.query("ROLLBACK").catch(() => {});
    publisher.release();
    loader.release();
  }
});

test("a stored floor that differs from the file after the load is REVISION_FLOOR_READBACK_MISMATCH", { skip }, async () => {
  // Synthetic tampering below the loader: a trigger that moves one day that
  // is not the largest, so the singleton's summary guard still passes.
  const schema = await createSchema();
  await pool.query(`CREATE FUNCTION ${q(schema, "spec_floor_tamper")}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.day = DATE '2026-09-29' THEN NEW.revision := NEW.revision + 1; END IF;
      RETURN NEW;
    END;
    $$`);
  await pool.query(`CREATE TRIGGER spec_floor_tamper BEFORE INSERT ON ${q(schema, "analytics_v2_revision_floor")}
    FOR EACH ROW EXECUTE FUNCTION ${q(schema, "spec_floor_tamper")}()`);
  await assert.rejects(load(schema, floorOf(FLOOR)), { code: "REVISION_FLOOR_READBACK_MISMATCH" });
  assert.deepEqual(await snapshot(schema), { analytics_v2_revision_floor: "[]", analytics_v2_revision_floor_source: "[]" },
    "the caller's rollback leaves nothing");
});
