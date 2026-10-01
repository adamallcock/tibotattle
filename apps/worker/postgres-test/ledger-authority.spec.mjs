import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const TOMBSTONE_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000;

async function assertLocalSocket() {
  assert.match(PG_TEST_HOST ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_HOST);
  const resolved = await realpath(PG_TEST_HOST);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
}

function interceptPool(pool, intercept) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await intercept(text, values, () => client.query(text, values));
          return result;
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

test("PostgreSQL ledger tombstones preserve retention and pending erasure authority", {
  skip: !PG_TEST_HOST,
}, async () => {
  await assertLocalSocket();
  const pool = new pg.Pool({
    host: PG_TEST_HOST,
    port: PG_TEST_PORT,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? {} : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  const schema = `ledger_auth_${randomBytes(6).toString("hex")}`;
  const options = { schema: { primarySchema: `${schema}_primary`, ledgerSchema: schema } };
  let schemaCreated = false;
  let vite;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrations = await applyPostgresMigrations({ role: "ledger", schema, pool });
    assert.equal(migrations.applied, 7);

    vite = await createServer({
      root: new URL("..", import.meta.url).pathname,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const adapter = await vite.ssrLoadModule("/src/postgres-ledger-authority.ts");
    const digestModule = await vite.ssrLoadModule("/src/participant-deletion-digest.ts");
    const participantId = `synthetic-ledger-owner-${randomBytes(6).toString("hex")}`;
    const absentParticipantId = `synthetic-ledger-absent-${randomBytes(6).toString("hex")}`;
    const baseEpoch = Date.UTC(2025, 0, 1, 0, 0, 0);
    const digest = await digestModule.participantDeletionDigest(participantId);

    assert.equal(await adapter.hasPostgresDeletionTombstone(
      pool, absentParticipantId, baseEpoch, options,
    ), false);

    await adapter.recordPostgresDeletionTombstone(pool, participantId, baseEpoch, options);
    let receipt = await pool.query(
      `SELECT participant_digest,schema_version,
              (extract(epoch FROM deleted_at) * 1000)::numeric::text AS deleted_at_ms,
              (extract(epoch FROM retain_until) * 1000)::numeric::text AS retain_until_ms
         FROM "${schema}"."deletion_tombstones" WHERE participant_digest=$1`,
      [digest],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0]?.participant_digest, digest);
    assert.equal(receipt.rows[0]?.schema_version, "participant-deletion-tombstone-v0.1");
    assert.equal(Number(receipt.rows[0]?.deleted_at_ms), baseEpoch);
    assert.equal(Number(receipt.rows[0]?.retain_until_ms), baseEpoch + TOMBSTONE_RETENTION_MS);
    assert.equal(JSON.stringify(receipt.rows[0]).includes(participantId), false);
    assert.equal(await adapter.hasPostgresDeletionTombstone(
      pool, participantId, baseEpoch + TOMBSTONE_RETENTION_MS - 1, options,
    ), true);
    assert.equal(await adapter.hasPostgresDeletionTombstone(
      pool, participantId, baseEpoch + TOMBSTONE_RETENTION_MS + 1, options,
    ), false);

    await adapter.recordPostgresDeletionTombstone(pool, participantId, baseEpoch + 20 * 86_400_000, options);
    await adapter.recordPostgresDeletionTombstone(pool, participantId, baseEpoch + 10 * 86_400_000, options);
    receipt = await pool.query(
      `SELECT schema_version,
              (extract(epoch FROM deleted_at) * 1000)::numeric::text AS deleted_at_ms,
              (extract(epoch FROM retain_until) * 1000)::numeric::text AS retain_until_ms
         FROM "${schema}"."deletion_tombstones" WHERE participant_digest=$1`,
      [digest],
    );
    assert.equal(receipt.rows[0]?.schema_version, "participant-deletion-tombstone-v0.1");
    assert.equal(Number(receipt.rows[0]?.deleted_at_ms), baseEpoch, "replays retain the first deleted_at value");
    assert.equal(Number(receipt.rows[0]?.retain_until_ms), baseEpoch + TOMBSTONE_RETENTION_MS + 20 * 86_400_000,
      "a later retry extends retention and an older retry cannot shorten it");

    const expiredAt = baseEpoch + TOMBSTONE_RETENTION_MS + 20 * 86_400_000 + 1;
    assert.equal(await adapter.hasPostgresDeletionTombstone(pool, participantId, expiredAt, options), false);
    const ownerDigest = await digestModule.participantDeletionDigest(`synthetic-owner-${randomBytes(6).toString("hex")}`);
    await pool.query(
      `INSERT INTO "${schema}"."storage_erasure_jobs" (
         participant_digest,source_id,owner_digest,source_namespace,state,attempted_ms
       ) VALUES ($1,'synthetic-source-v1',$2,'synthetic-namespace-v1','pending',0)`,
      [digest, ownerDigest],
    );
    assert.equal(await adapter.hasPostgresDeletionTombstone(pool, participantId, expiredAt, options), true,
      "a pending erasure job retains deletion authority after tombstone expiry");
    const terminalJson = JSON.stringify({
      sourceId: "synthetic-source-v1", sequence: 1,
      eventDigest: "a".repeat(64), ownerDigest, revision: 1,
      kind: "owner-erased", objectDigest: "b".repeat(64),
      contentDigest: "c".repeat(64), authorityEpoch: 1,
      publicAuthorityEpoch: 1, recordedMs: expiredAt,
    });
    await pool.query(
      `UPDATE "${schema}"."storage_erasure_jobs"
          SET state='complete',completed_at=$2::timestamptz,terminal_json=$4
        WHERE participant_digest=$1 AND owner_digest=$3`,
      [digest, new Date(expiredAt).toISOString(), ownerDigest, terminalJson],
    );
    assert.equal(await adapter.hasPostgresDeletionTombstone(pool, participantId, expiredAt, options), false,
      "a completed erasure job no longer extends expired tombstone authority");

    const failedReadPool = interceptPool(pool, async (text, values, query) => {
      if (text.includes("FROM") && text.includes("deletion_tombstones")) {
        throw Object.assign(new Error("private provider diagnostic"), { code: "XX000" });
      }
      return query();
    });
    await assert.rejects(
      adapter.hasPostgresDeletionTombstone(failedReadPool, participantId, expiredAt, options),
      (error) => error?.code === "DELETION_LEDGER_UNAVAILABLE"
        && !error.message.includes("private provider diagnostic"),
    );

    const failedWritePool = interceptPool(pool, async (text, values, query) => {
      if (text.includes("INSERT INTO") && text.includes("deletion_tombstones")) {
        throw Object.assign(new Error("private provider diagnostic"), { code: "XX000" });
      }
      return query();
    });
    await assert.rejects(
      adapter.recordPostgresDeletionTombstone(failedWritePool, absentParticipantId, baseEpoch, options),
      (error) => error?.code === "DELETION_LEDGER_UNAVAILABLE"
        && !error.message.includes("private provider diagnostic"),
    );

    const missingReceiptPool = interceptPool(pool, async (text, values, query) => {
      if (text.includes("SELECT participant_digest,") && text.includes("deletion_tombstones")) {
        return { rows: [], rowCount: 0 };
      }
      return query();
    });
    await assert.rejects(
      adapter.recordPostgresDeletionTombstone(missingReceiptPool, absentParticipantId, baseEpoch, options),
      (error) => error?.code === "DELETION_LEDGER_UNAVAILABLE",
    );
  } finally {
    if (schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});
