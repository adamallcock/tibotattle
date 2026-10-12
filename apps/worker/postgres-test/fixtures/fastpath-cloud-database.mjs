/**
 * A local PostgreSQL 17 stand-in for the GCP fast-path Cloud SQL target, for
 * checks of the importers' `cloudFastpathTarget` exception
 * (scripts/gcp-fastpath-cloud-target.mjs).
 *
 * The seed reaches Cloud SQL through the Cloud SQL Node connector as the
 * migrator IAM user: a TCP session (inet_server_addr() is not NULL) into the
 * database `tibotattle_fastpath`, as a cloudsqlsuperuser member with CREATEDB
 * and CREATEROLE that is not a superuser. The stand-in is a database with
 * exactly that name, owned by a NOLOGIN NOSUPERUSER CREATEDB CREATEROLE group,
 * a LOGIN migrator in the group, and pools over loopback TCP
 * (PG_TEST_TCP_HOST, on PG_TEST_TCP_PORT when the TCP listener's port differs
 * from the cluster's PG_TEST_PORT, as in the CI container).
 *
 * The database name is the cloud's, so checks sharing a cluster serialize on
 * an advisory lock held in the admin database for the whole run, and an
 * existing database of that name is dropped only when it carries this
 * fixture's comment (a crashed run's leftover); anything else is refused.
 * Everything the fixture creates is dropped when `run` settles.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { GCP_FASTPATH_CLOUD_TARGET } from "../../scripts/gcp-fastpath-cloud-target.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCK_KEY = "tibotattle-local-fastpath-cloud-database";
const DATABASE_COMMENT = "tibotattle local stand-in for the GCP fast-path database (disposable check fixture)";

/** The loopback TCP host the stand-in is reached on, or null when unset. */
export function localFastpathTcpHost(env = process.env) {
  const host = env.PG_TEST_TCP_HOST;
  if (host === undefined || host === "") return null;
  assert.ok(LOOPBACK_HOSTS.has(host), "PG_TEST_TCP_HOST must be 127.0.0.1, ::1 or localhost");
  return host;
}

/**
 * The loopback TCP port: PG_TEST_TCP_PORT when set, else `socketPort` (a
 * cluster that listens on the socket's port over TCP too).
 */
export function localFastpathTcpPort(env = process.env, socketPort) {
  const value = env.PG_TEST_TCP_PORT;
  const port = value === undefined || value === "" ? socketPort : Number(value);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "PG_TEST_TCP_PORT must be a TCP port number");
  return port;
}

/**
 * Create the stand-in, call `run({ database, roles, tcpPool })` and drop it.
 * `admin` are pg options for a superuser in an existing admin database;
 * `tcpPool({ user, database?, max? })` opens a TCP pool (closed afterwards).
 */
export async function withLocalFastpathCloudDatabase({ admin: adminOptions, tcpHost, port }, run) {
  assert.ok(LOOPBACK_HOSTS.has(tcpHost));
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);
  const database = GCP_FASTPATH_CLOUD_TARGET.database;
  const tag = randomBytes(5).toString("hex");
  const roles = Object.freeze({ group: `fp_cloudsqlsuperuser_${tag}`, migrator: `fp_cloud_migrator_${tag}` });
  const admin = new pg.Client(adminOptions);
  await admin.connect();
  const created = { roles: [], database: false };
  const pools = [];
  try {
    const facts = await admin.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user");
    assert.equal(facts.rows[0]?.rolsuper, true, "the fixture creates roles and a database; the admin must be a superuser");
    await admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);
    const existing = await admin.query(`SELECT pg_catalog.shobj_description(oid, 'pg_database') AS comment
      FROM pg_catalog.pg_database WHERE datname = $1`, [database]);
    if (existing.rows.length > 0) {
      assert.equal(existing.rows[0].comment, DATABASE_COMMENT,
        `a ${database} database exists that this fixture did not create; refusing to drop it`);
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
    await admin.query(`CREATE ROLE "${roles.group}" NOLOGIN NOSUPERUSER CREATEDB CREATEROLE`);
    created.roles.push(roles.group);
    await admin.query(`CREATE ROLE "${roles.migrator}" LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT
      IN ROLE "${roles.group}"`);
    created.roles.push(roles.migrator);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${roles.group}"`);
    created.database = true;
    await admin.query(`COMMENT ON DATABASE "${database}" IS '${DATABASE_COMMENT}'`);
    const tcpPool = ({ user, database: name = database, max = 2 }) => {
      const pool = new pg.Pool({ host: tcpHost, port, user, database: name, ssl: false, max,
        connectionTimeoutMillis: 10_000, application_name: "fastpath-cloud-database-check" });
      pool.on("error", () => {});
      pools.push(pool);
      return pool;
    };
    return await run({ database, roles, tcpPool });
  } finally {
    for (const pool of pools) await pool.end().catch(() => {});
    if (created.database) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    for (const role of created.roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    await admin.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    await admin.end().catch(() => {});
  }
}
