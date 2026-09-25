import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../scripts/postgres-migrations.mjs";

async function localSocket() {
  const path = process.env.PG_TEST_SOCKET;
  const port = Number(process.env.PG_TEST_PORT ?? "5432");
  assert.match(path ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const link = await lstat(path);
  const resolved = await realpath(path);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port };
}

test("0026 preserves legacy winner bytes and admits a distinct current day representation", async () => {
  const socket = await localSocket();
  const client = new pg.Client({
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: "postgres",
    ssl: false,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  let begun = false;
  try {
    const locality = await client.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    const schema = `v12domain_${randomBytes(6).toString("hex")}`;
    await client.query("BEGIN");
    begun = true;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    const migrations = await readPostgresMigrations({ role: "primary" });
    assert.equal(migrations.length, 39);
    assert.equal(migrations[25].name, "0026_v12_domain_days_and_input_revision.sql");
    assert.equal(migrations[26].name, "0027_typed_v12_published_delete_guard.sql");
    assert.equal(migrations[27].name, "0028_typed_v12_ready_integrity_guard.sql");
    assert.equal(migrations[28].name, "0029_legacy_source_membership.sql");
    assert.equal(migrations[29].name, "0030_legacy_typed_telemetry.sql");
    assert.equal(migrations[34].name, "0035_v12_ready_manifest_retention.sql");
    assert.equal(migrations[35].name, "0036_streamed_publication_proofs.sql");
    assert.equal(migrations[36].name, "0037_community_daily_publications.sql");
    assert.equal(migrations[37].name, "0038_analytics_event_tuple_versions.sql");
    assert.equal(migrations[38].name, "0039_analytics_applied_projection_v1.sql");
    for (const migration of migrations.slice(0, 25)) await client.query(migration.sql);

    const now = "2026-09-24T12:00:00.000Z";
    const expires = "2026-09-25T12:00:00.000Z";
    const hash = Buffer.alloc(32, 1);
    await client.query("INSERT INTO participants(id, created_at) VALUES ($1, $2)", ["synthetic-owner", now]);
    await client.query(`INSERT INTO web_sessions(
      id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $5)`, [
      "synthetic-session", "synthetic-owner", hash, hash, now, expires,
    ]);
    await client.query(`INSERT INTO device_pairings(
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, issued_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      "synthetic-pairing", "synthetic-owner", "synthetic-session", hash,
      "synthetic-consent", "synthetic-transport", now, expires,
    ]);
    await client.query(`INSERT INTO device_credentials(
      id, participant_id, paired_via_pairing_id, secret_hash,
      issued_at, expires_at, last_used_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $5)`, [
      "synthetic-device", "synthetic-owner", "synthetic-pairing", hash, now, expires,
    ]);
    const predecessor = `INSERT INTO telemetry_v12_domain_predecessors(
      token_hash, participant_id, device_id, previous_generation_id,
      legacy_fingerprint, input_revision, from_day, through_day,
      winners_json, created_at, expires_at
    ) VALUES ($1, $2, $3, NULL, $4, 0, DATE '2026-09-24',
      DATE '2026-09-24', $5, $6, $7)`;
    await client.query(predecessor, [
      "a".repeat(64), "synthetic-owner", "synthetic-device", "b".repeat(64),
      '[{"legacy":true}]', now, expires,
    ]);

    await client.query(migrations[25].sql);
    const old = await client.query(`SELECT winners_json, days_json
      FROM telemetry_v12_domain_predecessors WHERE token_hash = $1`, ["a".repeat(64)]);
    assert.deepEqual(old.rows, [{ winners_json: '[{"legacy":true}]', days_json: null }]);
    await client.query(`INSERT INTO telemetry_v12_domain_predecessors(
      token_hash, participant_id, device_id, previous_generation_id,
      legacy_fingerprint, input_revision, from_day, through_day,
      days_json, created_at, expires_at
    ) VALUES ($1, $2, $3, NULL, $4, 0, DATE '2026-09-24',
      DATE '2026-09-24', $5, $6, $7)`, [
      "c".repeat(64), "synthetic-owner", "synthetic-device", "d".repeat(64),
      "[]", now, expires,
    ]);
    const current = await client.query(`SELECT winners_json, days_json
      FROM telemetry_v12_domain_predecessors WHERE token_hash = $1`, ["c".repeat(64)]);
    assert.deepEqual(current.rows, [{ winners_json: null, days_json: "[]" }]);

    await client.query("SAVEPOINT invalid_dual_representation");
    await assert.rejects(client.query(`UPDATE telemetry_v12_domain_predecessors
      SET winners_json = '[]' WHERE token_hash = $1`, ["c".repeat(64)]),
    { code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT invalid_dual_representation");

    const revision = await client.query(`SELECT revision
      FROM community_analytical_input_versions WHERE participant_id = $1`, ["synthetic-owner"]);
    assert.equal(revision.rows[0]?.revision, "0");
    await client.query("UPDATE participants SET state = 'deleting' WHERE id = $1", ["synthetic-owner"]);
    const changed = await client.query(`SELECT revision
      FROM community_analytical_input_versions WHERE participant_id = $1`, ["synthetic-owner"]);
    assert.equal(changed.rows[0]?.revision, "1");
    const manifestFk = await client.query(`SELECT confdeltype, condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'telemetry_v12_domain_days_manifest_id_fkey'
        AND connamespace = $1::regnamespace`, [schema]);
    assert.deepEqual(manifestFk.rows[0], {
      confdeltype: "a", condeferrable: true, condeferred: true,
    });
  } finally {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
