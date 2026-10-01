import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 0050 is promoted (claude/gcp-fastpath-base): each schema receives the
// promoted chain below 0050, then the promoted 0050 file itself.
const STAGED_NAME = "0050_admin_audit_and_collection_controls.sql";
const STAGED_PATH = resolve(WORKER_ROOT, "postgres/migrations/primary", STAGED_NAME);
const CONTROL_NAMES = ["enrollment", "uploadRegistration", "processing", "publication"];
const PG_FLAG_COLUMNS = {
  enrollment: "enrollment_enabled",
  uploadRegistration: "upload_registration_enabled",
  processing: "processing_enabled",
  publication: "publication_enabled",
};
const PG_FLAG_COLUMNS_LIST = CONTROL_NAMES.map((name) => PG_FLAG_COLUMNS[name]);
const WORKER_DISABLED_CODES = {
  enrollment: "COLLECTION_ENROLLMENT_DISABLED",
  uploadRegistration: "UPLOAD_REGISTRATION_DISABLED",
  processing: "PROCESSING_DISABLED",
  publication: "PUBLICATION_DISABLED",
};

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "collection-control tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT, socket: true };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
  return null;
}

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

async function withWorkerModules(operation) {
  const vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    return await operation({
      worker: await vite.ssrLoadModule("/src/collection-controls.ts"),
      postgres: await vite.ssrLoadModule("/src/postgres-collection-controls.ts"),
    });
  } finally {
    await vite.close();
  }
}

async function apiErrorCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.name, "ApiError");
    assert.equal(error.status, 503);
    return error.code;
  }
  assert.fail("expected an ApiError");
}

/** Worker D1 row shape (0/1 flags, schema_version column). */
function d1Row(pgRow) {
  if (pgRow === null) return null;
  // A PostgreSQL non-boolean flag corresponds to a D1 flag outside {0, 1}.
  const flag = (value) => (value === true ? 1 : value === false ? 0 : 2);
  return {
    schema_version: "collection-controls-v0.1",
    enrollment_enabled: flag(pgRow.enrollment_enabled),
    upload_registration_enabled: flag(pgRow.upload_registration_enabled),
    processing_enabled: flag(pgRow.processing_enabled),
    publication_enabled: flag(pgRow.publication_enabled),
    control_state: pgRow.control_state,
    revision: typeof pgRow.revision === "string" ? Number(pgRow.revision) : pgRow.revision,
  };
}

function fakeD1(row) {
  return {
    prepare() {
      return { async first() { return row; } };
    },
  };
}

function fakeClient(rows, statements = []) {
  return {
    async query(text) {
      statements.push(text);
      if (rows instanceof Error) throw rows;
      return { rows, rowCount: rows.length };
    },
    release() {},
  };
}

function pgRow(state, flags, revision = "1") {
  return {
    control_state: state,
    revision,
    enrollment_enabled: flags[0],
    upload_registration_enabled: flags[1],
    processing_enabled: flags[2],
    publication_enabled: flags[3],
  };
}

const VALID_ROWS = [
  pgRow("contained", [false, false, false, false]),
  pgRow("operational", [true, true, true, true], "7"),
  pgRow("degraded", [false, true, true, false], "12"),
  pgRow("degraded", [true, true, true, false], "9007199254740991"),
];

// Every entry is a row the Worker reader refuses with 503
// COLLECTION_CONTROL_UNAVAILABLE; the PostgreSQL reader must agree.
const DEFECT_ROWS = [
  ["missing row", null],
  ["revision zero", pgRow("contained", [false, false, false, false], "0")],
  ["negative revision", pgRow("contained", [false, false, false, false], "-1")],
  ["fractional revision", pgRow("contained", [false, false, false, false], 1.5)],
  ["unsafe revision", pgRow("contained", [false, false, false, false], "9007199254740993")],
  ["unknown state", pgRow("paused", [false, false, false, false])],
  ["operational with a flag off", pgRow("operational", [true, true, false, true])],
  ["contained with a flag on", pgRow("contained", [false, false, false, true])],
  ["degraded with all four on", pgRow("degraded", [true, true, true, true])],
  ["degraded with all four off", pgRow("degraded", [false, false, false, false])],
  ["non-boolean flag", pgRow("contained", [0, false, false, false])],
];

test("PostgreSQL controls reader and assertion match the Worker reader row for row", async () => {
  await withWorkerModules(async ({ worker, postgres }) => {
    assert.equal(postgres.COLLECTION_CONTROLS_SCHEMA_VERSION, worker.COLLECTION_CONTROLS_SCHEMA_VERSION);
    assert.deepEqual({ ...postgres.POSTGRES_COLLECTION_CONTROL_DISABLED_CODES }, WORKER_DISABLED_CODES);
    assert.ok(Object.isFrozen(postgres.POSTGRES_COLLECTION_CONTROL_DISABLED_CODES));

    for (const row of VALID_ROWS) {
      const expected = await worker.readCollectionControls(fakeD1(d1Row(row)));
      const statements = [];
      const actual = await postgres.readPostgresCollectionControls(fakeClient([row], statements), "synthetic_schema");
      assert.deepEqual(actual, expected);
      assert.ok(Object.isFrozen(actual));
      assert.doesNotMatch(statements[0], /FOR SHARE/u);
      const locked = [];
      await postgres.readPostgresCollectionControls(fakeClient([row], locked), "synthetic_schema", { forShare: true });
      assert.match(locked[0], /WHERE singleton = 1\s+FOR SHARE$/u);
    }

    for (const [label, row] of DEFECT_ROWS) {
      assert.equal(await apiErrorCode(worker.readCollectionControls(fakeD1(d1Row(row)))),
        "COLLECTION_CONTROL_UNAVAILABLE", `Worker ${label}`);
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(
        fakeClient(row === null ? [] : [row]), "synthetic_schema")),
      "COLLECTION_CONTROL_UNAVAILABLE", `PostgreSQL ${label}`);
    }
    assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(
      fakeClient(new Error("synthetic driver failure")), "synthetic_schema")), "COLLECTION_CONTROL_UNAVAILABLE");
    assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(
      fakeClient([VALID_ROWS[0], VALID_ROWS[0]]), "synthetic_schema")), "COLLECTION_CONTROL_UNAVAILABLE");
    assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(
      fakeClient([VALID_ROWS[0]]), "Invalid-Schema")), "COLLECTION_CONTROL_UNAVAILABLE");
    assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(undefined, "synthetic_schema")),
      "COLLECTION_CONTROL_UNAVAILABLE");

    // Each control disabled alone in an otherwise valid degraded row gives
    // exactly the Worker's DISABLED_CODES entry; the other three pass.
    for (const name of CONTROL_NAMES) {
      const flags = CONTROL_NAMES.map((candidate) => candidate !== name);
      const row = pgRow("degraded", flags, "3");
      const workerCode = await apiErrorCode(worker.assertCollectionControl(fakeD1(d1Row(row)), name));
      assert.equal(workerCode, WORKER_DISABLED_CODES[name]);
      assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControl(
        fakeClient([row]), "synthetic_schema", name)), workerCode);
      for (const other of CONTROL_NAMES.filter((candidate) => candidate !== name)) {
        assert.deepEqual(
          await postgres.assertPostgresCollectionControl(fakeClient([row]), "synthetic_schema", other),
          await worker.assertCollectionControl(fakeD1(d1Row(row)), other),
        );
      }
    }
  });
});

async function connectPool(endpoint) {
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 3_000,
  });
  const server = await pool.query(
    "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
  );
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "this qualification requires PostgreSQL 17");
  if (endpoint.socket) assert.equal(server.rows[0].address, null);
  else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
  return pool;
}

/**
 * Apply the promoted primary migrations below 0050, then the promoted 0050
 * file in one transaction under the runner's search_path guard.
 */
async function createSchema(pool, schema, created, { beforeStaged, staged = true } = {}) {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  const before = await applyMigrationsBefore({ role: "primary", schema, pool, name: STAGED_NAME });
  assert.equal(before.target.version, 50);
  assert.equal(before.applied, before.prefix.length);
  if (beforeStaged !== undefined) await beforeStaged(schema);
  if (staged) await applyStagedMigration(pool, schema);
}

async function applyStagedMigration(pool, schema) {
  const sql = await readFile(STAGED_PATH, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    await client.query("SET LOCAL lock_timeout='10000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectsConstraint(promise, sqlState, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, sqlState);
    if (constraint !== undefined) assert.equal(error.constraint, constraint);
    return true;
  });
}

function recordingPool(pool, statements) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query(text, values) {
          statements.push(text);
          return client.query(text, values);
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

test("0050 closes collection_controls; the PostgreSQL reader serves the bootstrap row and refuses every defect", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = await connectPool(endpoint);
  const suffix = randomBytes(6).toString("hex");
  const schema = `aa0_controls_${suffix}`;
  const scratch = `aa0_controls_scratch_${suffix}`;
  const legacy = `aa0_controls_legacy_${suffix}`;
  const rejected = `aa0_controls_rejected_${suffix}`;
  const inconsistent = `aa0_controls_inconsistent_${suffix}`;
  const unrecordedChanged = `aa0_controls_unrecorded_${suffix}`;
  const unrecordedRevision = `aa0_controls_unrecorded_rev_${suffix}`;
  const unrecordedOperational = `aa0_controls_unrecorded_op_${suffix}`;
  const unrecordedFlag = `aa0_controls_unrecorded_flag_${suffix}`;
  const unrecordedState = `aa0_controls_unrecorded_state_${suffix}`;
  const absent = `aa0_controls_absent_${suffix}`;
  const created = [];
  try {
    await withWorkerModules(async ({ worker, postgres }) => {
      await createSchema(pool, schema, created);
      const table = q(schema, "collection_controls");

      // (1) The untouched 0007/0016 bootstrap row, reason backfilled to
      // 'initial'.
      const bootstrap = await pool.query(
        `SELECT revision::text AS revision, control_state, reason_code,
                enrollment_enabled, upload_registration_enabled,
                processing_enabled, publication_enabled
           FROM ${table}`,
      );
      assert.deepEqual(bootstrap.rows, [{
        revision: "1",
        control_state: "contained",
        reason_code: "initial",
        enrollment_enabled: false,
        upload_registration_enabled: false,
        processing_enabled: false,
        publication_enabled: false,
      }]);
      const contained = {
        schemaVersion: "collection-controls-v0.1",
        state: "contained",
        revision: 1,
        enrollment: false,
        uploadRegistration: false,
        processing: false,
        publication: false,
      };
      const client = await pool.connect();
      try {
        assert.deepEqual(await postgres.readPostgresCollectionControls(client, schema), contained);
      } finally {
        client.release();
      }
      assert.deepEqual(await postgres.readPostgresCollectionControlsFromPool(pool, schema), contained);
      for (const name of CONTROL_NAMES) {
        assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControlFromPool(pool, schema, name)),
          WORKER_DISABLED_CODES[name]);
      }

      // (2) The migration refuses what the Worker reader would refuse.
      await rejectsConstraint(pool.query(`UPDATE ${table} SET reason_code='synthetic-import-test'`),
        "23514", "collection_controls_reason_code_check");
      await rejectsConstraint(pool.query(`UPDATE ${table} SET reason_code=NULL`), "23502");
      await rejectsConstraint(pool.query(`UPDATE ${table} SET revision=0`),
        "23514", "collection_controls_revision_check");
      for (const [state, flags] of [
        ["operational", [true, true, false, true]],
        ["contained", [false, false, false, true]],
        ["degraded", [true, true, true, true]],
        ["degraded", [false, false, false, false]],
      ]) {
        await rejectsConstraint(pool.query(
          `UPDATE ${table}
              SET control_state=$1, enrollment_enabled=$2, upload_registration_enabled=$3,
                  processing_enabled=$4, publication_enabled=$5, revision=revision+1
            WHERE singleton=1`,
          [state, ...flags],
        ), "23514", "collection_controls_state_flags_check");
      }
      for (const reason of ["drill_containment", "drill_restore", "privacy_incident",
        "security_incident", "abuse_or_cost", "maintenance", "initial"]) {
        assert.equal((await pool.query(`UPDATE ${table} SET reason_code=$1 WHERE singleton=1`, [reason])).rowCount, 1);
      }

      // (3) publication off: assert refuses with PUBLICATION_DISABLED, the
      // other three controls pass, and the value equals the Worker's read.
      assert.equal((await pool.query(
        `UPDATE ${table}
            SET control_state='degraded', enrollment_enabled=true, upload_registration_enabled=true,
                processing_enabled=true, publication_enabled=false, revision=2,
                reason_code='maintenance', updated_at=clock_timestamp()
          WHERE singleton=1 AND revision=1`,
      )).rowCount, 1);
      const degraded = {
        schemaVersion: "collection-controls-v0.1",
        state: "degraded",
        revision: 2,
        enrollment: true,
        uploadRegistration: true,
        processing: true,
        publication: false,
      };
      assert.deepEqual(await worker.readCollectionControls(fakeD1(d1Row(
        pgRow("degraded", [true, true, true, false], "2"),
      ))), degraded);
      assert.deepEqual(await postgres.readPostgresCollectionControlsFromPool(pool, schema), degraded);
      assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControlFromPool(pool, schema, "publication")),
        "PUBLICATION_DISABLED");
      const assertClient = await pool.connect();
      try {
        assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControl(assertClient, schema, "publication")),
          "PUBLICATION_DISABLED");
        for (const name of ["enrollment", "uploadRegistration", "processing"]) {
          assert.deepEqual(await postgres.assertPostgresCollectionControl(assertClient, schema, name), degraded);
          assert.deepEqual(await postgres.assertPostgresCollectionControlFromPool(pool, schema, name), degraded);
        }
      } finally {
        assertClient.release();
      }

      // (4) The pool variant runs in its own read-only snapshot transaction.
      const statements = [];
      await postgres.readPostgresCollectionControlsFromPool(recordingPool(pool, statements), schema);
      assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.equal(statements.at(-1), "COMMIT");
      assert.equal(statements.filter((text) => /collection_controls/u.test(text)).length, 1);
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool({
        async connect() { throw new Error("synthetic connect failure"); },
      }, schema)), "COLLECTION_CONTROL_UNAVAILABLE");
      assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControlFromPool(pool, "bad-schema", "processing")),
        "COLLECTION_CONTROL_UNAVAILABLE");

      // (5) forShare holds the row against a concurrent controls change until
      // the caller's transaction ends; a plain read takes no row lock.
      for (const forShare of [true, false]) {
        const holder = await pool.connect();
        const contender = await pool.connect();
        try {
          await holder.query("BEGIN");
          assert.deepEqual(await postgres.readPostgresCollectionControls(holder, schema, { forShare }), degraded);
          const attempt = contender.query(`SELECT singleton FROM ${table} WHERE singleton=1 FOR UPDATE NOWAIT`);
          if (forShare) await rejectsConstraint(attempt, "55P03");
          else assert.equal((await attempt).rowCount, 1);
        } finally {
          await holder.query("ROLLBACK");
          contender.release();
          holder.release();
        }
      }

      // (6) Defects the constraints now forbid, in a scratch table with the
      // same columns and no constraints, each give 503 from every variant.
      await pool.query(`CREATE SCHEMA "${scratch}"`);
      created.push(scratch);
      const scratchTable = q(scratch, "collection_controls");
      await pool.query(`CREATE TABLE ${scratchTable} (
        singleton integer, revision bigint, control_state text,
        enrollment_enabled boolean, upload_registration_enabled boolean,
        processing_enabled boolean, publication_enabled boolean,
        reason_code text, updated_at timestamptz)`);
      const scratchDefects = [
        ["revision zero", "contained", [false, false, false, false], 0],
        ["operational with a flag off", "operational", [true, false, true, true], 3],
        ["degraded with all four on", "degraded", [true, true, true, true], 3],
        ["degraded with all four off", "degraded", [false, false, false, false], 3],
        ["contained with a flag on", "contained", [true, false, false, false], 3],
        ["unknown state", "paused", [false, false, false, false], 3],
        ["unsafe revision", "contained", [false, false, false, false], "9007199254740993"],
      ];
      for (const [label, state, flags, revision] of scratchDefects) {
        await pool.query(`DELETE FROM ${scratchTable}`);
        await pool.query(
          `INSERT INTO ${scratchTable} VALUES (1, $1, $2, $3, $4, $5, $6, 'initial', clock_timestamp())`,
          [revision, state, ...flags],
        );
        assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool(pool, scratch)),
          "COLLECTION_CONTROL_UNAVAILABLE", label);
        assert.equal(await apiErrorCode(postgres.assertPostgresCollectionControlFromPool(pool, scratch, "enrollment")),
          "COLLECTION_CONTROL_UNAVAILABLE", label);
      }
      await pool.query(`DELETE FROM ${scratchTable}`);
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool(pool, scratch)),
        "COLLECTION_CONTROL_UNAVAILABLE", "missing row");
      await pool.query(
        `INSERT INTO ${scratchTable} VALUES (2, 1, 'contained', false, false, false, false, 'initial', clock_timestamp())`,
      );
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool(pool, scratch)),
        "COLLECTION_CONTROL_UNAVAILABLE", "no singleton row");
      await pool.query(`DROP TABLE ${scratchTable}`);
      await pool.query(`CREATE TABLE ${scratchTable} (
        singleton integer, revision bigint, control_state text,
        enrollment_enabled integer, upload_registration_enabled boolean,
        processing_enabled boolean, publication_enabled boolean)`);
      await pool.query(`INSERT INTO ${scratchTable} VALUES (1, 1, 'contained', 0, false, false, false)`);
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool(pool, scratch)),
        "COLLECTION_CONTROL_UNAVAILABLE", "non-boolean flag column");
      await pool.query(`CREATE SCHEMA "${absent}"`);
      created.push(absent);
      assert.equal(await apiErrorCode(postgres.readPostgresCollectionControlsFromPool(pool, absent)),
        "COLLECTION_CONTROL_UNAVAILABLE", "unreadable table");
      const failedClient = await pool.connect();
      try {
        await failedClient.query("BEGIN");
        assert.equal(await apiErrorCode(postgres.readPostgresCollectionControls(failedClient, absent)),
          "COLLECTION_CONTROL_UNAVAILABLE");
        await rejectsConstraint(failedClient.query("SELECT 1"), "25P02");
      } finally {
        await failedClient.query("ROLLBACK");
        failedClient.release();
      }

      // (7) Backfill scope: only the untouched bootstrap row's NULL reason
      // becomes 'initial' (section 1). A changed row that already carries a
      // closed-set reason keeps it, and its revision, state and updated_at
      // are untouched.
      let legacyBefore;
      await createSchema(pool, legacy, created, {
        beforeStaged: async (target) => {
          await pool.query(
            `UPDATE ${q(target, "collection_controls")}
                SET revision=4, control_state='degraded', upload_registration_enabled=true,
                    processing_enabled=true, reason_code='maintenance',
                    updated_at='2026-09-01T00:00:00.000Z'
              WHERE singleton=1 AND reason_code IS NULL`,
          );
          legacyBefore = (await pool.query(
            `SELECT revision::text AS revision, control_state, updated_at, reason_code
               FROM ${q(target, "collection_controls")}`,
          )).rows;
        },
      });
      assert.equal(legacyBefore[0].reason_code, "maintenance");
      const legacyAfter = await pool.query(
        `SELECT revision::text AS revision, control_state, updated_at, reason_code
           FROM ${q(legacy, "collection_controls")}`,
      );
      assert.deepEqual(legacyAfter.rows, legacyBefore);

      // (8) Fail closed: an out-of-vocabulary reason, an inconsistent row, or
      // a NULL reason on any row other than the untouched bootstrap row (a
      // change whose reason was never recorded; 'initial' would claim it was
      // never changed) aborts the whole migration; nothing is rewritten.
      for (const [target, update, sqlState] of [
        [rejected, "reason_code='synthetic-import-test'", "23514"],
        [inconsistent,
          "control_state='operational', publication_enabled=true, revision=2, reason_code='maintenance'", "23514"],
        [unrecordedChanged,
          "revision=4, control_state='degraded', upload_registration_enabled=true, processing_enabled=true",
          "23502"],
        [unrecordedRevision, "revision=2", "23502"],
        [unrecordedOperational,
          `control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
           processing_enabled=true, publication_enabled=true`,
          "23502"],
        // Revision 1 with every flag off, but not contained; and revision 1
        // and contained, but one flag on: neither is the bootstrap shape.
        [unrecordedState, "control_state='degraded'", "23502"],
        ...PG_FLAG_COLUMNS_LIST.map((column) => [`${unrecordedFlag}_${column.slice(0, 3)}`, `${column}=true`, "23502"]),
      ]) {
        await createSchema(pool, target, created, { staged: false });
        await pool.query(`UPDATE ${q(target, "collection_controls")} SET ${update} WHERE singleton=1`);
        const before = (await pool.query(`SELECT * FROM ${q(target, "collection_controls")}`)).rows;
        await rejectsConstraint(applyStagedMigration(pool, target), sqlState);
        assert.deepEqual((await pool.query(`SELECT * FROM ${q(target, "collection_controls")}`)).rows, before,
          "a failed 0050 must leave the controls row unchanged");
        const columns = await pool.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema=$1 AND table_name='admin_action_audit' AND column_name='id'`,
          [target],
        );
        assert.equal(columns.rowCount, 0, "a failed 0050 must leave no partial schema change");
        const nullable = await pool.query(
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_schema=$1 AND table_name='collection_controls' AND column_name='reason_code'`,
          [target],
        );
        assert.equal(nullable.rows[0].is_nullable, "YES");
      }
    });
  } finally {
    for (const name of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await pool.end();
  }
});
