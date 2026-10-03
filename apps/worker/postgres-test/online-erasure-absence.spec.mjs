/**
 * PG17: the running service has no online erasure (decision D2, Variant B).
 *
 * Deleting a participant row, the one primitive the synthetic cleanup uses
 * and the offline purge procedure starts from, cascades that participant's
 * raw rows, writes exactly one storage_owner_erasure_receipts row through the
 * 0029 trigger, and leaves every published or derived community row
 * byte-identical: no fence, watermark, withdrawal, cooldown or retirement
 * runs. Synthetic, content-free rows only; the schema is w3_simp_-prefixed and
 * dropped afterwards.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { defaultAnalyticsV2FixtureStamps } from "./staged-migrations-harness.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const SOURCE = "w3-simp-erasure-source";
const NAMESPACE = "w3-simp-erasure-namespace";
const RELEASED_AT = "2026-09-30T12:00:00.000Z";

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "online-erasure absence requires a loopback host or a private Unix socket");
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
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

function t(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function count(pool, schema, table, where = "", params = []) {
  return (await pool.query(`SELECT count(*)::int AS count FROM ${t(schema, table)} ${where}`, params))
    .rows[0].count;
}

/** Every row of the published and derived community tables, as JSON text. */
async function communitySnapshot(pool, schema) {
  const snapshot = {};
  for (const [table, order] of [
    ["community_daily_aggregates", "source_id, day, revision"],
    ["community_daily_heads", "source_id, day"],
    ["community_graph_previews", "source_id"],
    ["analytics_owner_state", "source_id, owner_digest"],
    ["analytics_v2_runs", "run_id"],
    ["analytics_v2_owner_day", "owner_digest, day"],
    ["analytics_v2_owner_model_dates", "owner_digest, day"],
    ["analytics_v2_published_daily", "day"],
    ["analytics_v2_preview", "id"],
  ]) {
    snapshot[table] = (await pool.query(
      `SELECT to_jsonb(row_value)::text AS row FROM ${t(schema, table)} row_value ORDER BY ${order}`,
    )).rows.map((row) => row.row);
  }
  return snapshot;
}

async function seedCommunity(pool, schema, ownerDigest) {
  const authority = JSON.stringify({
    sourceId: SOURCE, sourceNamespace: NAMESPACE, publicAuthorityEpoch: 2, policyRevision: 1,
    collectionRevision: 1, graphInvalidationEpoch: 0, sourceEpoch: 0, sequence: 0,
  });
  const dailyAuthority = JSON.stringify({ ...JSON.parse(authority), dailyDeviceMethod: "w3-simp-method" });
  const dailyPayload = JSON.stringify({ synthetic: true, day: "2026-09-28" });
  await pool.query(
    `INSERT INTO ${t(schema, "community_daily_aggregates")} (
       source_id, source_namespace, day, revision, payload_json, payload_sha256,
       source_authority_epoch, source_cursor_sequence, policy_revision, collection_revision,
       release_state, released_at, public_authority_epoch, source_mutation_epoch, journal_sequence,
       graph_invalidation_epoch, cohort_digest, provenance, released_at_iso, authority_json,
       daily_device_method
     ) VALUES ($1, $2, '2026-09-28', 1, $3, $4, 0, 0, 1, 1, 'published', $5::timestamptz,
       2, 0, 0, 0, $6, 'gcp', $7, $8, 'w3-simp-method')`,
    [SOURCE, NAMESPACE, dailyPayload, sha256(dailyPayload), RELEASED_AT, "c".repeat(64), RELEASED_AT,
      dailyAuthority],
  );
  const previewPayload = JSON.stringify({ synthetic: true });
  await pool.query(
    `INSERT INTO ${t(schema, "community_graph_previews")} (
       source_id, source_namespace, revision, method, cohort_digest, authority_json,
       public_authority_epoch, policy_revision, collection_revision, source_mutation_epoch,
       journal_sequence, graph_invalidation_epoch, model_revision, payload_json, payload_sha256,
       generated_at, snapshot_source_epoch, inputs_current, provenance
     ) VALUES ($1, $2, 1, 'w3-simp-preview', $3, $4, 2, 1, 1, 0, 0, 0, 0, $5, $6, $7, 0, 1, 'gcp')`,
    [SOURCE, NAMESPACE, "d".repeat(64), authority, previewPayload, sha256(previewPayload), RELEASED_AT],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_owner_state")} (source_id, owner_digest, revision, authority_epoch, state)
     VALUES ($1, $2, 1, 2, 'active')`,
    [SOURCE, ownerDigest],
  );
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_v2_runs")} (
       run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings
     ) VALUES ($1, $2::timestamptz, $2::timestamptz, 'full', 'complete', 1, 1, '[]',
       '{"published":["2026-09-28"],"unchanged":[],"blocked":[]}', '{}')`,
    [runId, RELEASED_AT],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, run_id)
     VALUES ($1, '2026-09-28', '{"synthetic":true}', $2)`,
    [ownerDigest, runId],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_v2_owner_model_dates")} (owner_digest, day, result, run_id)
     VALUES ($1, '2026-09-28', '{"synthetic":true}', $2)`,
    [ownerDigest, runId],
  );
  const published = { aggregateId: "community-daily:2026-09-28:r1", day: "2026-09-28", revision: 1 };
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_v2_published_daily")} (day, revision, released_at, payload, payload_sha256, run_id)
     VALUES ('2026-09-28', 1, $1::timestamptz, $2::jsonb, $3, $4)`,
    [RELEASED_AT, JSON.stringify(published), "e".repeat(64), runId],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "analytics_v2_preview")} (id, preview, computed_at, run_id)
     VALUES (1, '{"synthetic":true}', $1::timestamptz, $2)`,
    [RELEASED_AT, runId],
  );
}

async function seedSocialOwner(pool, schema) {
  const participantId = `w3-simp-erasure-${randomUUID()}`;
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  const ownerDigest = randomBytes(32).toString("hex");
  const now = new Date();
  const later = new Date(now.getTime() + 86_400_000);
  await pool.query(
    `INSERT INTO ${t(schema, "participants")} (id, owner_kind, state, consent_version, consented_at, created_at)
     VALUES ($1, 'social', 'active', 'privacy-safe-telemetry-v0.1', $2, $2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, later],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1, $2, $3, $4, 'privacy-safe-telemetry-v0.1', 'privacy-safe-telemetry-v0.1',
       'consumed', $5, $6, $5, $7)`,
    [pairingId, participantId, sessionId, randomBytes(32), now, later, deviceId],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, later],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "storage_v11_owner_links")} (participant_id, owner_digest, state)
     VALUES ($1, $2, 'active')`,
    [participantId, ownerDigest],
  );
  await pool.query(
    `INSERT INTO ${t(schema, "input_source_digests")} (participant_id, digest) VALUES ($1, $2)`,
    [participantId, randomBytes(16).toString("hex")],
  );
  return { participantId, deviceId, ownerDigest };
}

test("PG17: deleting a participant cascades its raw rows, writes one receipt and changes no community row", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 300_000,
}, async () => {
  const endpoint = await localEndpoint();
  const schema = `w3_simp_erasure_${randomBytes(4).toString("hex")}`;
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await defaultAnalyticsV2FixtureStamps(pool, schema);

    // No online-erasure relation or function exists to call.
    for (const name of ["analytics_storage_erasure_fences", "analytics_storage_erasure_receipts",
      "community_terminal_watermarks", "identity_reenrollment_cooldowns", "postgres_readiness_sweeps"]) {
      assert.equal((await pool.query("SELECT to_regclass($1) IS NULL AS absent",
        [`"${schema}"."${name}"`])).rows[0].absent, true, name);
    }
    const erasureFunctions = (await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND (p.proname LIKE '%erasure_floor%' OR p.proname LIKE '%erasure_fence%'
          OR p.proname LIKE '%terminal_watermark%' OR p.proname LIKE '%retire%owner%')
        ORDER BY p.proname`, [schema])).rows;
    assert.deepEqual(erasureFunctions, []);

    const owner = await seedSocialOwner(pool, schema);
    const bystander = await seedSocialOwner(pool, schema);
    await seedCommunity(pool, schema, owner.ownerDigest);
    const before = await communitySnapshot(pool, schema);
    const receiptsBefore = await count(pool, schema, "storage_owner_erasure_receipts");

    const deleted = await pool.query(`DELETE FROM ${t(schema, "participants")} WHERE id = $1`,
      [owner.participantId]);
    assert.equal(deleted.rowCount, 1);

    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts") - receiptsBefore, 1,
      "exactly one erasure receipt");
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts", "WHERE owner_digest = $1",
      [owner.ownerDigest]), 1);
    for (const table of ["web_sessions", "device_pairings", "device_credentials", "storage_v11_owner_links",
      "input_source_digests", "attribution_enrollments"]) {
      assert.equal(await count(pool, schema, table, "WHERE participant_id = $1", [owner.participantId]), 0,
        `${table} cascades with the participant`);
      assert.ok(await count(pool, schema, table, "WHERE participant_id = $1", [bystander.participantId]) > 0
        || table === "attribution_enrollments", `${table} keeps another participant's rows`);
    }
    assert.deepEqual(await communitySnapshot(pool, schema), before,
      "published and derived community rows are byte-identical: nothing is withdrawn or retired online");
    assert.equal(await count(pool, schema, "storage_ingestion_changes",
      "WHERE kind IN ('owner-withdrawn', 'owner-erased')"), 0, "no terminal journal event is emitted");
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});
