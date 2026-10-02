import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { it } from "vitest";
import pg from "pg";
import { telemetryV12DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { createPostgresTypedV12Domain } from "../src/postgres-typed-v12-domain.ts";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

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

async function seedDomainIdentity(pool, schema, { participantId, deviceId, ownerDigest = null }) {
  const s = `"${schema}"`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const secretHash = randomBytes(32);
  await pool.query(`INSERT INTO ${s}.participants(id, consent_version, created_at)
    VALUES ($1,$2,$3)`, [participantId, "privacy-safe-telemetry-v0.1", now]);
  await pool.query(`INSERT INTO ${s}.web_sessions(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [
    `${participantId}-session`, participantId, secretHash, secretHash, now, expires,
  ]);
  await pool.query(`INSERT INTO ${s}.device_pairings(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, issued_at, expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    `${participantId}-pairing`, participantId, `${participantId}-session`, secretHash,
    "synthetic-consent", "synthetic-transport", now, expires,
  ]);
  await pool.query(`INSERT INTO ${s}.device_credentials(
    id, participant_id, paired_via_pairing_id, secret_hash,
    issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [
    deviceId, participantId, `${participantId}-pairing`, secretHash, now, expires,
  ]);
  await pool.query(`INSERT INTO ${s}.telemetry_v12_device_capabilities(
    participant_id, device_id, telemetry_schema_version, field_dictionary_version,
    privacy_contract_version, consented_at
  ) VALUES ($1,$2,$3,$4,$5,$6)`, [
    participantId, deviceId, "telemetry-contribution-v1.2",
    "telemetry-v1.2-registry-2026-09-20.1",
    "ongoing-privacy-safe-telemetry-v1.2", now,
  ]);
  if (ownerDigest !== null) {
    await pool.query(`INSERT INTO ${s}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  }
  return { now };
}

async function insertReadyEmptyManifest(pool, schema, { participantId, deviceId, day }) {
  const manifestId = randomUUID();
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO "${schema}".telemetry_v12_day_manifests(
    id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
    manifest_json, expected_chunk_count, state, created_at, ready_at
  ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,0,'ready',$8,$8)`, [
    manifestId, participantId, deviceId, day, randomBytes(32).toString("hex"),
    "synthetic-domain", JSON.stringify({
      schemaVersion: "telemetry-day-manifest-v1.2", day, chunks: [],
    }), now,
  ]);
  return manifestId;
}

it("current v1.2 domain activates and replays on real local PostgreSQL", async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: "postgres",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `v12rt_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const s = `"${schema}"`;
    const now = new Date().toISOString();
    const participantId = "synthetic-domain-owner";
    const deviceId = "synthetic-domain-device";
    const ownerDigest = "f".repeat(64);
    await seedDomainIdentity(pool, schema, { participantId, deviceId, ownerDigest });
    await pool.query(`UPDATE ${s}.telemetry_v12_runtime
      SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await pool.query(`UPDATE ${s}.telemetry_v12_typed_runtime
      SET state='active', changed_at=$1 WHERE id=1`, [now]);
    const day = "2026-09-24";
    const manifestId = randomUUID();
    const manifestDigest = "e".repeat(64);
    await pool.query(`INSERT INTO ${s}.telemetry_v12_day_manifests(
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,0,'ready',$8,$8)`, [
      manifestId, participantId, deviceId, day, manifestDigest,
      "synthetic-domain", JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.2", day, chunks: [],
      }), now,
    ]);

    const domain = createPostgresTypedV12Domain(pool, {
      schema: { primarySchema: schema },
    });
    const principal = { participantId, deviceId };
    const predecessor = await domain.createPredecessor(principal);
    assert.equal(predecessor.fromDay, day);
    assert.equal(predecessor.throughDay, day);
    const manifest = {
      schemaVersion: "telemetry-domain-manifest-v1.2",
      fromDay: day, throughDay: day,
      predecessor: {
        token: predecessor.token,
        previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint,
      },
      days: [{ day, manifestId, manifestDigest }],
      manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = createHash("sha256")
      .update(telemetryV12DomainManifestDigestInput(manifest)).digest("hex");
    const first = await domain.activate(principal, manifest);
    assert.equal(first.replay, false);
    assert.equal(first.manifestDigest, manifest.manifestDigest);
    const replay = await domain.activate(principal, manifest);
    assert.deepEqual(replay, { ...first, replay: true });
    const persisted = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.telemetry_v12_domain_days WHERE generation_id = $1`, [first.generationId]);
    assert.equal(persisted.rows[0]?.n, "1");
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.telemetry_v12_day_manifests WHERE id=$1`, [manifestId]),
      (error) => error?.code === "P1005",
      "direct deletion of a ready source remains blocked while its owner exists",
    );

    // The predecessor still names the first ready day, while the new domain
    // selects an additive same-day successor. Both are truly empty typed days,
    // so the SQL containment proof has a positive, bounded case.
    const sameDaySuccessorId = randomUUID();
    const sameDaySuccessorDigest = "b".repeat(64);
    await pool.query(`INSERT INTO ${s}.telemetry_v12_day_manifests(
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,0,'ready',$8,$8)`, [
      sameDaySuccessorId, participantId, deviceId, day, sameDaySuccessorDigest,
      "synthetic-domain", JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.2", day, chunks: [],
      }), new Date(Date.now() + 1_000).toISOString(),
    ]);
    const secondDay = "2026-09-25";
    const secondManifestId = randomUUID();
    const secondManifestDigest = "d".repeat(64);
    await pool.query(`INSERT INTO ${s}.telemetry_v12_day_manifests(
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,0,'ready',$8,$8)`, [
      secondManifestId, participantId, deviceId, secondDay, secondManifestDigest,
      "synthetic-domain", JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.2", day: secondDay, chunks: [],
      }), now,
    ]);
    const nextPredecessor = await domain.createPredecessor(principal);
    assert.equal(nextPredecessor.previousGenerationId, first.generationId);
    assert.equal(nextPredecessor.fromDay, day);
    assert.equal(nextPredecessor.throughDay, secondDay);
    const nextManifest = {
      schemaVersion: "telemetry-domain-manifest-v1.2",
      fromDay: day, throughDay: secondDay,
      predecessor: {
        token: nextPredecessor.token,
        previousGenerationId: nextPredecessor.previousGenerationId,
        legacyFingerprint: nextPredecessor.legacyFingerprint,
      },
      days: [
        { day, manifestId: sameDaySuccessorId, manifestDigest: sameDaySuccessorDigest },
        { day: secondDay, manifestId: secondManifestId, manifestDigest: secondManifestDigest },
      ],
      manifestDigest: "0".repeat(64),
    };
    nextManifest.manifestDigest = createHash("sha256")
      .update(telemetryV12DomainManifestDigestInput(nextManifest)).digest("hex");
    const nextActivation = await domain.activate(principal, nextManifest);
    assert.equal(nextActivation.replay, false);
    assert.notEqual(nextActivation.generationId, first.generationId);
    const nextHead = await pool.query(`SELECT generation_id, revision::text AS revision
      FROM ${s}.telemetry_v12_domain_heads WHERE participant_id = $1`, [participantId]);
    assert.equal(nextHead.rows[0]?.generation_id, nextActivation.generationId);
    assert.equal(nextHead.rows[0]?.revision, "2");
    const changedDay = await pool.query(`SELECT manifest_id FROM ${s}.telemetry_v12_domain_days
      WHERE generation_id = $1 AND observed_day = $2::date`, [nextActivation.generationId, day]);
    assert.equal(changedDay.rows[0]?.manifest_id, sameDaySuccessorId);

    const incompleteManifestId = randomUUID();
    const incompleteManifestDigest = "a".repeat(64);
    await pool.query(`INSERT INTO ${s}.telemetry_v12_day_manifests(
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,1,'staged',$8,NULL)`, [
      incompleteManifestId, participantId, deviceId, day, incompleteManifestDigest,
      "synthetic-domain", JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.2", day,
        chunks: [{ chunkId: "missing", chunkDigest: "9".repeat(64), recordCount: 1 }],
      }), new Date(Date.now() + 2_000).toISOString(),
    ]);
    const guardPredecessor = await domain.createPredecessor(principal);
    const incompleteDomain = {
      ...nextManifest,
      predecessor: {
        token: guardPredecessor.token,
        previousGenerationId: guardPredecessor.previousGenerationId,
        legacyFingerprint: guardPredecessor.legacyFingerprint,
      },
      days: [
        { day, manifestId: incompleteManifestId, manifestDigest: incompleteManifestDigest },
        nextManifest.days[1],
      ],
      manifestDigest: "0".repeat(64),
    };
    incompleteDomain.manifestDigest = createHash("sha256")
      .update(telemetryV12DomainManifestDigestInput(incompleteDomain)).digest("hex");
    await assert.rejects(domain.activate(principal, incompleteDomain),
      { code: "TELEMETRY_MANIFEST_CONFLICT" });
    const retainedHead = await pool.query(`SELECT generation_id, revision::text AS revision
      FROM ${s}.telemetry_v12_domain_heads WHERE participant_id = $1`, [participantId]);
    assert.equal(retainedHead.rows[0]?.generation_id, nextActivation.generationId);
    assert.equal(retainedHead.rows[0]?.revision, "2");

    await pool.query(`UPDATE ${s}.telemetry_v12_device_capabilities
      SET state='revoked', revoked_at=$1 WHERE participant_id=$2 AND device_id=$3`,
    [now, participantId, deviceId]);
    await assert.rejects(domain.createPredecessor(principal),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" });

    const ownerState = await pool.query(`SELECT state FROM ${s}.storage_v11_owner_links
      WHERE participant_id=$1 AND owner_digest=$2`, [participantId, ownerDigest]);
    assert.deepEqual(ownerState.rows, [{ state: "active" }]);
    const receiptBeforeDelete = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.storage_owner_erasure_receipts WHERE owner_digest=$1`, [ownerDigest]);
    assert.equal(receiptBeforeDelete.rows[0]?.n, "0");
    await pool.query(`UPDATE ${s}.participants SET state='deleting' WHERE id=$1`, [participantId]);
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.telemetry_v12_day_manifests WHERE id=$1`, [manifestId]),
      (error) => error?.code === "P1005",
      "deleting state alone cannot authorize direct deletion of a ready source",
    );
    await pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [participantId]);
    const erased = await pool.query(`SELECT
      (SELECT count(*)::text FROM ${s}.telemetry_v12_domains) AS domains,
      (SELECT count(*)::text FROM ${s}.telemetry_v12_domain_days) AS days,
      (SELECT count(*)::text FROM ${s}.telemetry_v12_day_manifests) AS manifests`);
    assert.deepEqual(erased.rows[0], { domains: "0", days: "0", manifests: "0" });
    const receiptAfterDelete = await pool.query(`SELECT owner_digest
      FROM ${s}.storage_owner_erasure_receipts WHERE owner_digest=$1`, [ownerDigest]);
    assert.deepEqual(receiptAfterDelete.rows, [{ owner_digest: ownerDigest }]);
    const ownerLinkAfterDelete = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.storage_v11_owner_links WHERE participant_id=$1`, [participantId]);
    assert.equal(ownerLinkAfterDelete.rows[0]?.n, "0");
  } finally {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}, 60_000);

it("linkless v1.2 ready-owner deletion is refused without an erasure receipt", async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: "postgres",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `v12lnk_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const participantId = `synthetic-linkless-owner-${randomUUID()}`;
    const deviceId = `synthetic-linkless-device-${randomUUID()}`;
    const { now } = await seedDomainIdentity(pool, schema, { participantId, deviceId });
    const manifestId = await insertReadyEmptyManifest(pool, schema, {
      participantId, deviceId, day: "2026-09-24",
    });
    const s = `"${schema}"`;
    const links = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.storage_v11_owner_links WHERE participant_id=$1`, [participantId]);
    assert.equal(links.rows[0]?.n, "0");
    const receipt = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.storage_owner_erasure_receipts`);
    assert.equal(receipt.rows[0]?.n, "0");
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.telemetry_v12_day_manifests WHERE id=$1`, [manifestId]),
      (error) => error?.code === "P1005",
      "direct deletion cannot erase linkless ready source",
    );
    await pool.query(`UPDATE ${s}.participants SET state='deleting' WHERE id=$1`, [participantId]);
    await assert.rejects(
      pool.query(`DELETE FROM ${s}.participants WHERE id=$1`, [participantId]),
      (error) => error?.code === "P1005",
      "the participant cascade remains fail-closed without the established receipt",
    );
    const retained = await pool.query(`SELECT participant.state, manifest.state AS manifest_state
      FROM ${s}.participants participant
      JOIN ${s}.telemetry_v12_day_manifests manifest
        ON manifest.participant_id=participant.id
      WHERE participant.id=$1 AND manifest.id=$2`, [participantId, manifestId]);
    assert.deepEqual(retained.rows, [{ state: "deleting", manifest_state: "ready" }]);
    const receiptAfterRefusal = await pool.query(`SELECT count(*)::text AS n
      FROM ${s}.storage_owner_erasure_receipts`);
    assert.equal(receiptAfterRefusal.rows[0]?.n, "0");
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});
