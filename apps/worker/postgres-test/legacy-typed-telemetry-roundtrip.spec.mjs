import assert from "node:assert/strict";
import { lstat, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");

async function localSocket() {
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
  return { host: resolved, port: PG_TEST_PORT };
}

test("PostgreSQL typed v1/v1.1 base preserves source keys and blocks erasure until explicit typed cleanup", {
  skip: !PG_TEST_HOST,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    ssl: false,
    max: 5,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `legacy_typed_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const migration = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(migration.applied, 58);

    const s = `"${schema}"`;
    const participantId = `synthetic-typed-owner-${randomBytes(4).toString("hex")}`;
    const ownerDigest = randomBytes(32).toString("hex");
    const namespaceOriginal = randomBytes(24);
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const fixedHash = Buffer.alloc(32, 17);

    await pool.query(`INSERT INTO ${s}.participants(id, created_at) VALUES ($1,$2)`, [participantId, now]);
    await pool.query(`INSERT INTO ${s}.web_sessions(
      id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,$3,$3,$4,$5,$4)`, [
      `${participantId}-session`, participantId, fixedHash, now, expires,
    ]);
    await pool.query(`INSERT INTO ${s}.device_pairings(
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
    ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1',
      'consumed',$5,$6,$5,$7)`, [
      `${participantId}-pairing`, participantId, `${participantId}-session`, fixedHash,
      now, expires, `${participantId}-device`,
    ]);
    await pool.query(`INSERT INTO ${s}.device_credentials(
      id, participant_id, paired_via_pairing_id, secret_hash,
      issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [
      `${participantId}-device`, participantId, `${participantId}-pairing`, fixedHash, now, expires,
    ]);
    await pool.query(`INSERT INTO ${s}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);

    // Source primary keys are explicit and remain available for an id-preserving
    // importer. The shared dictionary is the same table used by PostgreSQL v1.2.
    await pool.query(`INSERT INTO ${s}.typed_telemetry_dictionary(id, value) VALUES
      (1,'codex'), (2,'model-x'), (3,'standard'), (4,'default-tier'),
      (5,'cli'), (6,'codex-billing'), (7,'medium'), (8,'core'),
      (9,'success'), (10,'plus'), (11,'standard-variant'),
      (12,'five-hour'), (13,'primary'), (14,'shell')`);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_namespaces(id, original_id)
      VALUES (100, $1)`, [namespaceOriginal]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_owners(id, namespace_id, original_id)
      VALUES (200,100,$1)`, [randomBytes(24)]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_devices(id, namespace_id, owner_id, original_id)
      VALUES (300,100,200,$1)`, [randomBytes(24)]);

    // Source membership is not publication authority. A new membership needs
    // an active participant; when an owner-link row exists it must be active.
    await pool.query(`UPDATE ${s}.participants SET state='deleting' WHERE id=$1`, [participantId]);
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES (100,10,200,$1,'synthetic-v1')`, [participantId]),
      (error) => error?.code === "P1005",
    );
    await pool.query(`UPDATE ${s}.participants SET state='active' WHERE id=$1`, [participantId]);
    await pool.query(`UPDATE ${s}.storage_v11_owner_links SET state='withdrawn' WHERE participant_id=$1`, [participantId]);
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES (100,10,200,$1,'synthetic-v1')`, [participantId]),
      (error) => error?.code === "P1005",
    );
    await pool.query(`UPDATE ${s}.storage_v11_owner_links SET state='active' WHERE participant_id=$1`, [participantId]);

    const erasedParticipantId = `${participantId}-erased`;
    const erasedOwnerDigest = randomBytes(32).toString("hex");
    await pool.query(`INSERT INTO ${s}.participants(id, created_at) VALUES ($1,$2)`, [erasedParticipantId, now]);
    await pool.query(`INSERT INTO ${s}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [erasedParticipantId, erasedOwnerDigest]);
    await pool.query(`UPDATE ${s}.storage_v11_owner_links SET state='erased' WHERE participant_id=$1`, [erasedParticipantId]);
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES (100,10,200,$1,'synthetic-v1')`, [erasedParticipantId]),
      (error) => error?.code === "P1005",
    );
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES (100,11,200,$1,'synthetic-v11')`, [erasedParticipantId]),
      (error) => error?.code === "P1005",
      "a second source-format mapping cannot bypass a present terminal owner link",
    );
    await pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [erasedParticipantId]);

    await pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
      namespace_id, source_format, owner_id, participant_id, source_namespace
    ) VALUES (100,10,200,$1,'synthetic-v1')`, [participantId]);

    // Some active v1.1 source owners have no storage_v11_owner_links row. Keep
    // that source identity without fabricating an owner digest or erasure proof.
    // This deliberately shares owner 200 with linked v1 format 10 so deletion
    // has to account for every format-specific owner mapping.
    const linklessParticipantId = `synthetic-linkless-owner-${randomBytes(4).toString("hex")}`;
    await pool.query(`INSERT INTO ${s}.participants(id, created_at) VALUES ($1,$2)`, [linklessParticipantId, now]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_owner_memberships(
      namespace_id,source_format,owner_id,participant_id,source_namespace
    ) VALUES (100,11,200,$1,'synthetic-linkless-v11')`, [linklessParticipantId]);
    const linklessDay = 20_720;
    const linklessTimestamp = Date.UTC(2026, 8, 24, 12);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_devices(id, namespace_id, owner_id, original_id)
      VALUES (301,100,200,$1)`, [randomBytes(24)]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_manifests(
      id, namespace_id, owner_id, device_id, original_id, chunk_day
    ) VALUES (401,100,200,301,$1,$2)`, [randomBytes(24), linklessDay]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_chunks(
      id, namespace_id, format, owner_id, device_id, manifest_id,
      original_id, stream, chunk_day
    ) VALUES (1201,100,11,200,301,401,$1,1,$2)`, [randomBytes(24), linklessDay]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_identifiers(id, namespace_id, owner_id, value)
      VALUES (610,100,200,$1)`, [randomBytes(24)]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_attributions(
      id, namespace_id, owner_id, account_basis, account_track,
      plan_basis, plan_type_id, plan_era
    ) VALUES (611,100,200,0,''::bytea,0,11,''::bytea)`);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_records(
      id, namespace_id, format, source_row_id, owner_id, device_id,
      chunk_id, manifest_id, stream, occurrence_id, observed_at_ms,
      observed_day, provider_id, canonical_digest
    ) VALUES (2101,100,11,3001,200,301,1201,401,1,$1,$2,$3,1,$4)`, [
      Buffer.from("synthetic-linkless-record"), linklessTimestamp, linklessDay, randomBytes(32),
    ]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_usage(
      record_id,stream,session_id,model_id,speed_mode_id,api_service_tier_id,
      surface_id,billing_surface_id,reasoning_effort_id,agent_scope_id,
      outcome_id,attribution_id,input_uncached_tokens
    ) VALUES (2101,1,610,2,3,4,5,6,7,8,9,611,13)`);
    assert.equal((await pool.query(`SELECT owner_link.owner_digest
      FROM ${s}.typed_telemetry_owner_memberships membership
      LEFT JOIN ${s}.storage_v11_owner_links owner_link
        ON owner_link.participant_id=membership.participant_id
      WHERE membership.participant_id=$1`, [linklessParticipantId])).rows[0]?.owner_digest, null);
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_owner_memberships
        WHERE namespace_id=100 AND source_format=11 AND owner_id=200`),
      (error) => error?.code === "P1005",
      "linkless source membership has no external digest proof to authorize release",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [linklessParticipantId]),
      (error) => error?.code === "23503",
      "linkless v1.1 membership blocks participant erasure until explicitly resolved",
    );
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_owner_memberships
      WHERE participant_id=$1 AND source_format=11`, [linklessParticipantId])).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_records
      WHERE id=2101 AND source_row_id=3001 AND manifest_id=401`)).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_usage WHERE record_id=2101`)).rows[0]?.n, 1);

    const day = 20_720;
    await pool.query(`INSERT INTO ${s}.typed_telemetry_manifests(
      id, namespace_id, owner_id, device_id, original_id, chunk_day
    ) VALUES (400,100,200,300,$1,$2)`, [randomBytes(24), day]);
    const chunks = [];
    for (const [format, manifestId] of [[10, null], [11, 400]]) {
      for (const stream of [1, 2, 3]) {
        const chunkId = format * 100 + stream;
        chunks.push({ format, stream, chunkId, manifestId });
        await pool.query(`INSERT INTO ${s}.typed_telemetry_chunks(
          id, namespace_id, format, owner_id, device_id, manifest_id,
          original_id, stream, chunk_day
        ) VALUES ($1,100,$2,200,300,$3,$4,$5,$6)`, [
          chunkId, format, manifestId, randomBytes(24), stream, day,
        ]);
      }
    }
    await pool.query(`INSERT INTO ${s}.typed_telemetry_identifiers(
      id, namespace_id, owner_id, value
    ) VALUES (600,100,200,$1)`, [randomBytes(24)]);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_attributions(
      id, namespace_id, owner_id, account_basis, account_track,
      plan_basis, plan_type_id, plan_era
    ) VALUES (601,100,200,0,''::bytea,0,10,''::bytea)`);
    await pool.query(`INSERT INTO ${s}.typed_telemetry_quota_dimensions(
      id, namespace_id, owner_id, plan_type_id, plan_variant_id, attribution_id
    ) VALUES (602,100,200,10,11,NULL), (603,100,200,10,11,601)`);

    const timestamp = Date.UTC(2026, 8, 24, 12);
    const records = [];
    for (const [format, firstSourceRowId] of [[10, 1001], [11, 2001]]) {
      for (const stream of [1, 2, 3]) {
        const chunk = chunks.find((candidate) => candidate.format === format && candidate.stream === stream);
        assert.ok(chunk);
        const id = firstSourceRowId + stream - 1;
        const sourceRowId = firstSourceRowId + stream - 1;
        const occurrenceId = Buffer.from(`synthetic-${format}-${stream}`);
        records.push({ format, stream, id, sourceRowId });
        await pool.query(`INSERT INTO ${s}.typed_telemetry_records(
          id, namespace_id, format, source_row_id, owner_id, device_id,
          chunk_id, manifest_id, stream, occurrence_id, observed_at_ms,
          observed_day, provider_id, canonical_digest
        ) VALUES ($1,100,$2,$3,200,300,$4,$5,$6,$7,$8,$9,1,$10)`, [
          id, format, sourceRowId, chunk.chunkId, chunk.manifestId, stream,
          occurrenceId, timestamp, day, randomBytes(32),
        ]);
      }
    }

    const usageColumns = `record_id, stream, session_id, model_id, speed_mode_id,
      api_service_tier_id, surface_id, billing_surface_id, reasoning_effort_id,
      agent_scope_id, outcome_id, attribution_id, input_uncached_tokens`;
    for (const record of records.filter((row) => row.stream === 1)) {
      await pool.query(`INSERT INTO ${s}.typed_telemetry_usage(${usageColumns})
        VALUES ($1,1,600,2,3,4,5,6,7,8,9,$2,23)`, [
        record.id, record.format === 11 ? 601 : null,
      ]);
    }
    for (const record of records.filter((row) => row.stream === 2)) {
      await pool.query(`INSERT INTO ${s}.typed_telemetry_quota(
        record_id, stream, dimensions_id, limit_id, slot_id, used_percent,
        window_duration_minutes, resets_at_ms
      ) VALUES ($1,2,$2,12,13,75,300,$3)`, [
        record.id, record.format === 11 ? 603 : 602, timestamp + 86_400_000,
      ]);
    }
    for (const record of records.filter((row) => row.stream === 3)) {
      await pool.query(`INSERT INTO ${s}.typed_telemetry_session_tools(
        record_id, stream, tool_class_id, count
      ) VALUES ($1,3,14,2)`, [record.id]);
    }

    const preserved = await pool.query(`SELECT format, source_row_id, chunk_id, manifest_id,
      stream, encode(occurrence_id,'hex') AS occurrence_hex,
      encode(canonical_digest,'hex') AS digest_hex
      FROM ${s}.typed_telemetry_records WHERE owner_id=200 AND id<>2101 ORDER BY id`);
    assert.equal(preserved.rowCount, 6);
    assert.deepEqual(preserved.rows.map((row) => Number(row.source_row_id)), [1001, 1002, 1003, 2001, 2002, 2003]);
    assert.deepEqual(preserved.rows.map((row) => row.manifest_id), [null, null, null, "400", "400", "400"]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_usage child
      JOIN ${s}.typed_telemetry_records record ON record.id=child.record_id WHERE record.owner_id=200 AND record.id<>2101`)).rows[0]?.n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_quota child
      JOIN ${s}.typed_telemetry_records record ON record.id=child.record_id WHERE record.owner_id=200 AND record.id<>2101`)).rows[0]?.n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_session_tools child
      JOIN ${s}.typed_telemetry_records record ON record.id=child.record_id WHERE record.owner_id=200 AND record.id<>2101`)).rows[0]?.n, 2);

    // Cross-owner references, a mismatched v1.1 manifest day, a wrong child
    // stream, and an inexact negative epoch day all fail before they can form
    // plausible-looking source data.
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_chunks(
        id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day
      ) VALUES (999,100,11,200,300,400,$1,1,$2)`, [randomBytes(24), day + 1]),
      (error) => error?.code === "23514",
    );
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_usage(${usageColumns})
        VALUES (1002,1,600,2,3,4,5,6,7,8,9,NULL,1)`),
      (error) => error?.code === "23503",
      "quota rows cannot acquire a usage child",
    );
    // Keep lineage aligned to day zero so this isolates the floor-day rule:
    // -1ms is still in the previous UTC day, not day zero.
    await pool.query(`INSERT INTO ${s}.typed_telemetry_chunks(
      id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day
    ) VALUES (104,100,10,200,300,NULL,$1,1,0)`, [randomBytes(24)]);
    await assert.rejects(
      pool.query(`INSERT INTO ${s}.typed_telemetry_records(
        id,namespace_id,format,source_row_id,owner_id,device_id,chunk_id,manifest_id,
        stream,occurrence_id,observed_at_ms,observed_day,provider_id,canonical_digest
      ) VALUES (998,100,10,1998,200,300,104,NULL,1,$1,-1,0,1,$2)`, [
        randomBytes(12), randomBytes(32),
      ]),
      (error) => error?.code === "23514",
      "observed_day must be the UTC floor of observed_at_ms",
    );

    // Individual typed deletes still require terminal owner proof, and the
    // source mapping cannot be dropped while the participant is active.
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_records WHERE id=1001`),
      (error) => error?.code === "P1005",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_owner_memberships
        WHERE namespace_id=100 AND source_format=10 AND owner_id=200`),
      (error) => error?.code === "P1005",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_records WHERE id=2001`),
      (error) => error?.code === "P1005",
      "a v1 receipt cannot release a linkless v1.1 record sharing the typed owner",
    );

    // Participant deletion executes the real 0029 terminal-erasure transition,
    // then the owner-link retention guard blocks its cascade while typed source
    // memberships remain. Its trigger side effects roll back with the statement.
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [participantId]),
      (error) => error?.code === "P1005",
    );
    assert.equal((await pool.query(`SELECT state FROM ${s}.participants WHERE id=$1`, [participantId])).rows[0]?.state, "active");
    assert.equal((await pool.query(`SELECT state FROM ${s}.storage_v11_owner_links WHERE owner_digest=$1`, [ownerDigest])).rows[0]?.state, "active");
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM ${s}.storage_owner_erasure_receipts WHERE owner_digest=$1`, [ownerDigest])).rows[0]?.n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_owner_memberships`)).rows[0]?.n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_records`)).rows[0]?.n, 7);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_usage`)).rows[0]?.n, 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_quota`)).rows[0]?.n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_session_tools`)).rows[0]?.n, 2);

    // Even if the linked v1 owner reaches terminal state, a shared owner row
    // cannot cascade away its sibling linkless v1.1 family.
    await pool.query(`UPDATE ${s}.storage_v11_owner_links SET state='erased' WHERE participant_id=$1`, [participantId]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n
      FROM ${s}.storage_owner_erasure_receipts WHERE owner_digest=$1`, [ownerDigest])).rows[0]?.n, 1);
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.storage_v11_owner_links WHERE participant_id=$1`, [participantId]),
      (error) => error?.code === "P1005",
      "the digest-to-participant authority link is retained while typed memberships depend on it",
    );
    assert.equal((await pool.query(`SELECT owner_link.owner_digest
      FROM ${s}.typed_telemetry_owner_memberships membership
      JOIN ${s}.storage_v11_owner_links owner_link
        ON owner_link.participant_id=membership.participant_id
      WHERE membership.participant_id=$1`, [participantId])).rows[0]?.owner_digest, ownerDigest);
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_records WHERE id=2001`),
      (error) => error?.code === "P1005",
      "the format-11 mapping has no terminal owner receipt",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.typed_telemetry_owners WHERE id=200`),
      (error) => error?.code === "P1005",
      "owner-wide cleanup requires proof for both v1 and v1.1 mappings",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [participantId]),
      (error) => error?.code === "P1005",
      "typed memberships continue to block participant erasure after a receipt exists",
    );
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_records`)).rows[0]?.n, 7);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_usage`)).rows[0]?.n, 3);

    // The admission/proof schema can exist without an importer receipt for
    // these base rows. They must remain unqualified as effective evidence.
    const authorityTables = await pool.query(`SELECT
      to_regclass($1) AS v1_admissions,
      to_regclass($2) AS v11_proofs,
      to_regclass($3) AS admission_receipts`, [
      `${schema}.typed_v1_record_admissions`,
      `${schema}.typed_v11_record_proofs`,
      `${schema}.typed_telemetry_admission_transfer_receipts`,
    ]);
    assert.deepEqual(authorityTables.rows[0], {
      v1_admissions: `${schema}.typed_v1_record_admissions`,
      v11_proofs: `${schema}.typed_v11_record_proofs`,
      admission_receipts: `${schema}.typed_telemetry_admission_transfer_receipts`,
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${s}.typed_telemetry_admission_transfer_receipts`)).rows[0]?.n, 0);
  } finally {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
