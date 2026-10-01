import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  applyPostgresMigrations,
  POSTGRES_MIGRATION_ROOT,
  readPostgresMigrations,
} from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL analytics event tuple migrations 0038-0039", () => {
  let pool;
  let schema;
  let quotedSchema;
  let legacyRoot;

  beforeAll(async () => {
    pool = new pg.Pool({
      ...(await localSocket()),
      user: PG_TEST_USER,
      password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE,
      application_name: "pg-analytics-event-tuple-test",
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
  }, 120_000);

  beforeEach(async () => {
    schema = `analytics_event_tuple_${randomBytes(6).toString("hex")}`;
    quotedSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    schema = undefined;
    quotedSchema = undefined;
    if (legacyRoot) await rm(legacyRoot, { recursive: true, force: true });
    legacyRoot = undefined;
  }, 120_000);

  afterAll(async () => { if (pool) await pool.end(); });

  it("preserves legacy rows and allows NULL projections only for complete v1 receipts", async () => {
    const migrations = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT });
    expect(migrations).toHaveLength(59);
    expect(migrations.at(-1)?.name).toBe("0059_analytics_v2.sql");

    legacyRoot = await mkdtemp(join(tmpdir(), "tibotattle-pg-event-tuple-v37-"));
    const legacyPrimary = join(legacyRoot, "primary");
    await mkdir(legacyPrimary, { mode: 0o700 });
    for (const migration of migrations.slice(0, 37)) {
      await writeFile(join(legacyPrimary, migration.name), migration.sql, { mode: 0o600 });
    }
    const before0038 = await applyPostgresMigrations({
      role: "primary", schema, pool, rootDirectory: legacyRoot,
    });
    expect(before0038.applied).toBe(37);

    const table = name => `${quotedSchema}."${name}"`;
    const sourceId = "synthetic-analytics-source";
    const ownerDigest = "a".repeat(64);
    const legacyDigest = "b".repeat(64);
    await pool.query(`INSERT INTO ${table("storage_ingestion_changes")}(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
    ) VALUES($1,4,$2,$3,7,3,'source-updated',1234)`, [sourceId, legacyDigest, ownerDigest]);
    await pool.query(`INSERT INTO ${table("analytics_applied_events")}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json
    ) VALUES($1,4,$2,$3,3,'{}')`, [sourceId, legacyDigest, ownerDigest]);
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch)
      VALUES($1,4,3)`, [sourceId]);

    await writeFile(join(legacyPrimary, migrations[37].name), migrations[37].sql, { mode: 0o600 });
    const applied0038 = await applyPostgresMigrations({
      role: "primary", schema, pool, rootDirectory: legacyRoot,
    });
    expect(applied0038.applied).toBe(38);
    expect(applied0038.migrations.at(-1)?.name).toBe("0038_analytics_event_tuple_versions.sql");
    const oldSource = await pool.query(`SELECT event_tuple_version,revision,object_digest,content_digest,
      public_authority_epoch,kind,recorded_ms::text FROM ${table("storage_ingestion_changes")}
      WHERE source_id=$1 AND sequence=4`, [sourceId]);
    expect(oldSource.rows).toEqual([{
      event_tuple_version: 0,
      revision: null,
      object_digest: null,
      content_digest: null,
      public_authority_epoch: null,
      kind: "source-updated",
      recorded_ms: "1234",
    }]);
    const oldReceipt = await pool.query(`SELECT event_tuple_version,revision,kind,object_digest,content_digest,
      public_authority_epoch,recorded_ms FROM ${table("analytics_applied_events")}
      WHERE source_id=$1 AND sequence=4`, [sourceId]);
    expect(oldReceipt.rows).toEqual([{
      event_tuple_version: 0,
      revision: null,
      kind: null,
      object_digest: null,
      content_digest: null,
      public_authority_epoch: null,
      recorded_ms: null,
    }]);
    const cursor = await pool.query(`SELECT sequence::text,authority_epoch::text
      FROM ${table("analytics_source_cursors")} WHERE source_id=$1`, [sourceId]);
    expect(cursor.rows).toEqual([{ sequence: "4", authority_epoch: "3" }]);

    const digest = suffix => String(suffix).repeat(64);
    const event = {
      sourceId,
      sequence: 5,
      eventDigest: digest("c"),
      ownerDigest,
      ownerRevision: 8,
      revision: 9,
      objectDigest: digest("d"),
      contentDigest: digest("e"),
      authorityEpoch: 4,
      publicAuthorityEpoch: 4,
      kind: "owner-active",
      recordedMs: 2000,
    };
    const appliedTable = table("analytics_applied_events");
    const uniqueConstraintsBefore = await pool.query(`SELECT conname, contype
      FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u')
      ORDER BY conname`, [`${schema}.analytics_applied_events`]);
    const triggersBefore = await pool.query(`SELECT tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`, [
      `${schema}.analytics_applied_events`,
    ]);
    await expect(pool.query(`INSERT INTO ${appliedTable}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,
      event_tuple_version,revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
    ) VALUES($1,$2,$3,$4,$5,NULL,1,$6,$7,$8,$9,$10,$11)`, [
      event.sourceId, event.sequence, event.eventDigest, event.ownerDigest, event.authorityEpoch,
      event.revision, event.kind, event.objectDigest, event.contentDigest,
      event.publicAuthorityEpoch, event.recordedMs,
    ])).rejects.toMatchObject({ code: "23502" });

    await writeFile(join(legacyPrimary, migrations[38].name), migrations[38].sql, { mode: 0o600 });
    const applied0039 = await applyPostgresMigrations({
      role: "primary", schema, pool, rootDirectory: legacyRoot,
    });
    expect(applied0039.applied).toBe(39);
    expect(applied0039.migrations.at(-1)?.name).toBe("0039_analytics_applied_projection_v1.sql");

    await pool.query(`INSERT INTO ${table("storage_ingestion_changes")}(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
      event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)`, [
      event.sourceId, event.sequence, event.eventDigest, event.ownerDigest, event.ownerRevision,
      event.authorityEpoch, event.kind, event.recordedMs, event.revision, event.objectDigest,
      event.contentDigest, event.publicAuthorityEpoch,
    ]);
    await pool.query(`INSERT INTO ${appliedTable}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,
      event_tuple_version,revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
    ) VALUES($1,$2,$3,$4,$5,NULL,1,$6,$7,$8,$9,$10,$11)`, [
      event.sourceId, event.sequence, event.eventDigest, event.ownerDigest, event.authorityEpoch,
      event.revision, event.kind, event.objectDigest, event.contentDigest,
      event.publicAuthorityEpoch, event.recordedMs,
    ]);
    await expect(pool.query(`INSERT INTO ${appliedTable}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json
    ) VALUES($1,8,$2,$3,4,NULL)`, [sourceId, digest("9"), ownerDigest]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`INSERT INTO ${appliedTable}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,
      event_tuple_version,revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
    ) VALUES($1,$2,$3,$4,$5,NULL,1,$6,$7,$8,'invalid',$9,$10)`, [
      sourceId, 9, digest("8"), ownerDigest, 4, 9, "source-updated", digest("7"), 4, 2001,
    ])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`INSERT INTO ${appliedTable}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,
      event_tuple_version,revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
    ) VALUES($1,$2,$3,$4,$5,NULL,1,$6,$7,$8,$9,$10,$11)`, [
      event.sourceId, event.sequence, digest("6"), event.ownerDigest, event.authorityEpoch,
      event.revision, event.kind, event.objectDigest, event.contentDigest,
      event.publicAuthorityEpoch, event.recordedMs,
    ])).rejects.toMatchObject({ code: "23505" });
    const uniqueConstraintsAfter = await pool.query(`SELECT conname, contype
      FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u')
      ORDER BY conname`, [`${schema}.analytics_applied_events`]);
    const triggersAfter = await pool.query(`SELECT tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`, [
      `${schema}.analytics_applied_events`,
    ]);
    expect(uniqueConstraintsAfter.rows).toEqual(uniqueConstraintsBefore.rows);
    expect(triggersAfter.rows).toEqual(triggersBefore.rows);

    const newSource = await pool.query(`SELECT event_tuple_version,revision,object_digest,content_digest,
      public_authority_epoch FROM ${table("storage_ingestion_changes")}
      WHERE source_id=$1 AND sequence=5`, [sourceId]);
    expect(newSource.rows).toEqual([{
      event_tuple_version: 1,
      revision: "9",
      object_digest: event.objectDigest,
      content_digest: event.contentDigest,
      public_authority_epoch: "4",
    }]);
    const newReceipt = await pool.query(`SELECT event_tuple_version,revision,kind,object_digest,content_digest,
      public_authority_epoch::text,recorded_ms::text FROM ${table("analytics_applied_events")}
      WHERE source_id=$1 AND sequence=5`, [sourceId]);
    expect(newReceipt.rows).toEqual([{
      event_tuple_version: 1,
      revision: "9",
      kind: "owner-active",
      object_digest: event.objectDigest,
      content_digest: event.contentDigest,
      public_authority_epoch: "4",
      recorded_ms: "2000",
    }]);

    await expect(pool.query(`INSERT INTO ${table("storage_ingestion_changes")}(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
      event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
    ) VALUES($1,6,$2,$3,8,4,'source-updated',2001,1,NULL,$4,$5,4)`, [
      sourceId, digest("f"), ownerDigest, digest("a"), digest("9"),
    ])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`INSERT INTO ${table("analytics_applied_events")}(
      source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,
      event_tuple_version,revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
    ) VALUES($1,6,$2,$3,4,'{}',1,9,'source-updated',$4,'invalid',4,2001)`, [
      sourceId, digest("7"), ownerDigest, digest("8"),
    ])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`INSERT INTO ${table("storage_ingestion_changes")}(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
      event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
    ) VALUES($1,7,$2,$3,8,4,'source-updated',2002,2,9,$4,$5,4)`, [
      sourceId, digest("6"), ownerDigest, digest("5"), digest("4"),
    ])).rejects.toMatchObject({ code: "23514" });
  }, 120_000);
});
