import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";

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

async function waitForLockWait(pool, pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`PostgreSQL backend ${pid} did not wait on a row lock`);
}

async function insertGeneration(pool, schema, { participantId, deviceId, predecessorId = null, day, now }) {
  const table = (name) => `"${schema}"."${name}"`;
  const manifestId = randomUUID();
  const generationId = randomUUID();
  const tokenHash = randomBytes(32).toString("hex");
  const manifestDigest = randomBytes(32).toString("hex");
  const legacyFingerprint = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO ${table("telemetry_v11_day_manifests")} (
       id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
       manifest_json, expected_chunk_count, state, created_at, ready_at
     ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-membership',
       '{"schemaVersion":"telemetry-day-manifest-v1.1"}',0,'ready',$6,$6)`,
    [manifestId, participantId, deviceId, day, manifestDigest, now],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
       token_hash, participant_id, device_id, previous_generation_id,
       legacy_fingerprint, input_revision, from_day, through_day, winners_json,
       created_at, expires_at
     ) VALUES ($1,$2,$3,$4,$5,0,$6::date,$6::date,'[]',$7,$7::timestamptz + interval '1 hour')`,
    [tokenHash, participantId, deviceId, predecessorId, legacyFingerprint, day, now],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v11_domains")} (
       id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
       manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
       days_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8::date,$8::date,$9,$10)`,
    [generationId, participantId, deviceId, tokenHash, predecessorId, manifestDigest,
      legacyFingerprint, day, JSON.stringify([{ day, manifestId, manifestDigest }]), now],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v11_domain_days")} (generation_id, observed_day, manifest_id)
     VALUES ($1,$2::date,$3)`,
    [generationId, day, manifestId],
  );
  return { generationId, manifestId, manifestDigest, day };
}

test("PostgreSQL v1 and v1.1 source memberships are explicit, consistent, and retained", {
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
  const schema = `legacy_membership_${randomBytes(6).toString("hex")}`;
  const legacySchema = `${schema}_upgrade`;
  let created = false;
  let legacyCreated = false;
  let migrationRoot;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(`CREATE SCHEMA "${legacySchema}"`);
    legacyCreated = true;

    // Stage the original 28 migrations. Applying 0029 to old erased-state rows
    // must fail without inventing receipt proof; a clean forward upgrade still
    // succeeds in the independent schema below.
    const migrations = await readPostgresMigrations({ role: "primary" });
    migrationRoot = await mkdtemp("/private/tmp/tibotattle-pg-legacy-membership-");
    async function rootThrough(version) {
      const root = join(migrationRoot, `through-${version}`);
      const primary = join(root, "primary");
      await mkdir(primary, { recursive: true, mode: 0o700 });
      for (const migration of migrations.filter((entry) => entry.version <= version)) {
        await writeFile(join(primary, migration.name), migration.sql, { flag: "wx", mode: 0o600 });
      }
      return root;
    }
    const root28 = await rootThrough(28);
    const root29 = await rootThrough(29);
    const now = new Date().toISOString();
    const legacyErasedParticipantId = `synthetic-preexisting-erased-${randomBytes(4).toString("hex")}`;
    const legacyErasedOwnerDigest = randomBytes(32).toString("hex");
    const legacyPriorMigration = await applyPostgresMigrations({
      role: "primary", schema: legacySchema, pool, rootDirectory: root28,
    });
    assert.equal(legacyPriorMigration.applied, 28);
    await pool.query(
      `INSERT INTO "${legacySchema}".participants (id, created_at) VALUES ($1,$2)`,
      [legacyErasedParticipantId, now],
    );
    await pool.query(
      `INSERT INTO "${legacySchema}".storage_v11_owner_links (participant_id, owner_digest, state)
       VALUES ($1,$2,'erased')`,
      [legacyErasedParticipantId, legacyErasedOwnerDigest],
    );
    await assert.rejects(
      applyPostgresMigrations({
        role: "primary", schema: legacySchema, pool, rootDirectory: root29,
      }),
      (error) => error?.code === "POSTGRES_MIGRATION_APPLY_FAILED",
      "0029 fails closed when an erased link predates digest-only terminal proof",
    );
    const legacyVersion = await pool.query(
      `SELECT version FROM "${legacySchema}"."_tibotattle_migration_history"
        ORDER BY version DESC LIMIT 1`,
    );
    assert.equal(legacyVersion.rows[0]?.version, 28, "failed 0029 leaves forward-upgrade history at v28");
    const legacyOwner = await pool.query(
      `SELECT state FROM "${legacySchema}".storage_v11_owner_links WHERE owner_digest=$1`,
      [legacyErasedOwnerDigest],
    );
    assert.equal(legacyOwner.rows[0]?.state, "erased", "failed migration preserves the unresolved legacy row");
    const legacyReceiptTable = await pool.query(
      "SELECT to_regclass($1) AS relation", [`${legacySchema}.storage_owner_erasure_receipts`],
    );
    assert.equal(legacyReceiptTable.rows[0]?.relation, null,
      "failed migration installs neither the receipt table nor invented proof");

    const priorMigration = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: root28 });
    assert.equal(priorMigration.applied, 28);
    const migration = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: root29 });
    assert.equal(migration.applied, 29);

    const table = (name) => `"${schema}"."${name}"`;
    const participantId = `synthetic-membership-participant-${randomBytes(4).toString("hex")}`;
    const deviceId = `synthetic-membership-device-${randomBytes(4).toString("hex")}`;
    const pairingId = randomUUID();
    const sessionId = randomUUID();
    const chunkId = randomUUID();
    const uploadId = randomUUID();
    const ownerDigest = randomBytes(32).toString("hex");
    const sourceNamespace = randomBytes(32).toString("hex");
    const chunkDigest = randomBytes(32).toString("hex");
    const envelopeDigest = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    await pool.query(
      `INSERT INTO ${table("participants")} (id, created_at) VALUES ($1,$2)`,
      [participantId, now],
    );
    await pool.query(
      `INSERT INTO ${table("web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$3,$4,$5,$4)`,
      [sessionId, participantId, randomBytes(32), now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1',
         'consumed',$5,$6,$5,$7)`,
      [pairingId, participantId, sessionId, randomBytes(32), now, expiresAt, deviceId],
    );
    await pool.query(
      `INSERT INTO ${table("device_credentials")} (
         id, participant_id, paired_via_pairing_id, secret_hash,
         issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
      [deviceId, participantId, pairingId, randomBytes(32), now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("storage_v11_owner_links")} (participant_id, owner_digest, state)
       VALUES ($1,$2,'active')`,
      [participantId, ownerDigest],
    );
    await pool.query(
      `INSERT INTO ${table("device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at, consumed_at
       ) VALUES ($1,$2,$3,$4,$5,32,'application/json','consumed',$6,$7,$6)`,
      [uploadId, participantId, deviceId, randomBytes(32), envelopeDigest, now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1,$2,'telemetry_v1')`,
      [chunkId, `synthetic/${chunkId}`],
    );
    const day = "2026-09-24";
    await pool.query(
      `INSERT INTO ${table("telemetry_v1_chunks")} (
         id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
         chunk_digest, envelope_digest, parser_version, record_count,
         accepted_record_count, r2_key, device_upload_authorization_id, created_at
       ) VALUES ($1,$2,$3,'usage',$4::date,0,1,$5,$6,'synthetic-membership',
         1,1,$7,$8,$9)`,
      [chunkId, participantId, deviceId, day, chunkDigest, envelopeDigest,
        `synthetic/${chunkId}`, uploadId, now],
    );
    await pool.query(
      `INSERT INTO ${table("telemetry_v1_records")} (
         chunk_row_id, participant_id, device_id, stream, occurrence_id,
         observed_at, observed_day, record_json
       ) VALUES ($1,$2,$3,'usage','synthetic-v1-occurrence',$4,$5::date,'{}'::jsonb)`,
      [chunkId, participantId, deviceId, `${day}T12:00:00.000Z`, day],
    );

    const v1EventDigest = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO ${table("typed_v1_event_sources")} (
         event_digest, owner_digest, participant_id, chunk_id, source_namespace
       ) VALUES ($1,$2,$3,$4,$5)`,
      [v1EventDigest, ownerDigest, participantId, chunkId, sourceNamespace],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${table("typed_v1_event_sources")} (
           event_digest, owner_digest, participant_id, chunk_id, source_namespace
         ) VALUES ($1,$2,$3,$4,$5)`,
        [randomBytes(32).toString("hex"), randomBytes(32).toString("hex"),
          participantId, chunkId, sourceNamespace],
      ),
      (error) => error?.code === "P1005",
      "a v1 membership cannot cross the participant owner mapping",
    );

    const first = await insertGeneration(pool, schema, {
      participantId, deviceId, day, now,
    });
    await pool.query(
      `INSERT INTO ${table("telemetry_v11_domain_heads")} (
         participant_id, generation_id, revision, updated_at
       ) VALUES ($1,$2,1,$3)`,
      [participantId, first.generationId, now],
    );
    const second = await insertGeneration(pool, schema, {
      participantId, deviceId, predecessorId: first.generationId, day, now,
    });
    await pool.query(
      `UPDATE ${table("telemetry_v11_domain_heads")} SET generation_id=$2, revision=2, updated_at=$3
        WHERE participant_id=$1`,
      [participantId, second.generationId, now],
    );

    const eventFor = (generation, headRevision) => [
      randomBytes(32).toString("hex"), ownerDigest, participantId, deviceId,
      generation.generationId, generation.manifestDigest, generation.day,
      generation.day, headRevision, 0, Date.now(),
    ];
    await pool.query(
      `INSERT INTO ${table("storage_v11_event_sources")} (
         event_digest, owner_digest, participant_id, device_id, generation_id,
         manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
      eventFor(first, 1),
    );
    await pool.query(
      `INSERT INTO ${table("storage_v11_event_sources")} (
         event_digest, owner_digest, participant_id, device_id, generation_id,
         manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
      eventFor(second, 2),
    );

    const third = await insertGeneration(pool, schema, {
      participantId, deviceId, predecessorId: second.generationId, day, now,
    });
    const headBlocker = await pool.connect();
    const headPublisher = await pool.connect();
    try {
      await headBlocker.query("BEGIN");
      await headBlocker.query(
        `UPDATE ${table("telemetry_v11_domain_heads")}
            SET generation_id=$2, revision=3, updated_at=$3 WHERE participant_id=$1`,
        [participantId, third.generationId, now],
      );
      const { rows: [{ pid: publisherPid }] } = await headPublisher.query("SELECT pg_backend_pid() AS pid");
      const publication = headPublisher.query(
        `INSERT INTO ${table("storage_v11_event_sources")} (
           event_digest, owner_digest, participant_id, device_id, generation_id,
           manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
        eventFor(third, 3),
      ).then((value) => ({ value }), (error) => ({ error }));
      await waitForLockWait(pool, publisherPid);
      await headBlocker.query("COMMIT");
      const publicationResult = await publication;
      assert.equal(publicationResult.error, undefined,
        "publication waits for a concurrent head update and validates the committed head");
    } finally {
      try { await headBlocker.query("ROLLBACK"); } catch {}
      headBlocker.release();
      headPublisher.release();
    }

    await assert.rejects(
      pool.query(
        `INSERT INTO ${table("storage_v11_event_sources")} (
           event_digest, owner_digest, participant_id, device_id, generation_id,
           manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
        eventFor(first, 2),
      ),
      (error) => error?.code === "P1005",
      "a v1.1 membership must match the generation's publication revision",
    );
    await assert.rejects(
      pool.query(`UPDATE ${table("storage_v11_event_sources")} SET head_revision=3`),
      (error) => error?.code === "P1005",
      "published v1.1 membership is immutable",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("typed_v1_event_sources")} WHERE event_digest=$1`, [v1EventDigest]),
      (error) => error?.code === "P1005",
      "active owner source membership is retained",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("storage_v11_event_sources")}`),
      (error) => error?.code === "P1005",
      "active owner generation membership is retained",
    );

    await pool.query(
      `UPDATE ${table("participants")} SET state='deleting' WHERE id=$1`,
      [participantId],
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("typed_v1_event_sources")} WHERE event_digest=$1`, [v1EventDigest]),
      (error) => error?.code === "P1005",
      "a deleting participant with an active owner is not terminal erasure proof for v1",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("storage_v11_event_sources")}`),
      (error) => error?.code === "P1005",
      "a deleting participant with an active owner is not terminal erasure proof for v1.1",
    );

    await pool.query(
      `UPDATE ${table("storage_v11_owner_links")} SET state='withdrawn' WHERE participant_id=$1`,
      [participantId],
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("typed_v1_event_sources")} WHERE event_digest=$1`, [v1EventDigest]),
      (error) => error?.code === "P1005",
      "a withdrawn owner and deleting participant are not terminal erasure proof for v1",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("storage_v11_event_sources")}`),
      (error) => error?.code === "P1005",
      "a withdrawn owner and deleting participant are not terminal erasure proof for v1.1",
    );

    // Isolate the owner-transition race from the earlier deletion-state
    // retention checks. A new membership is admissible only for an active
    // participant, so it must reach and serialize on the owner row.
    await pool.query(
      `UPDATE ${table("participants")} SET state='active' WHERE id=$1`, [participantId],
    );
    const ownerBlocker = await pool.connect();
    const ownerPublisher = await pool.connect();
    try {
      await ownerBlocker.query("BEGIN");
      await ownerBlocker.query(
        `UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
        [participantId],
      );
      const { rows: [{ pid: publisherPid }] } = await ownerPublisher.query("SELECT pg_backend_pid() AS pid");
      const publication = ownerPublisher.query(
        `INSERT INTO ${table("typed_v1_event_sources")} (
           event_digest, owner_digest, participant_id, chunk_id, source_namespace
         ) VALUES ($1,$2,$3,$4,$5)`,
        [randomBytes(32).toString("hex"), ownerDigest, participantId, chunkId, sourceNamespace],
      ).then((value) => ({ value }), (error) => ({ error }));
      await waitForLockWait(pool, publisherPid);
      await ownerBlocker.query("COMMIT");
      const publicationResult = await publication;
      assert.equal(publicationResult.error?.code, "P1005",
        "membership publication waits for owner termination and rejects the now-erased owner");
    } finally {
      try { await ownerBlocker.query("ROLLBACK"); } catch {}
      ownerBlocker.release();
      ownerPublisher.release();
    }

    const receipt = await pool.query(
      `SELECT owner_digest FROM ${table("storage_owner_erasure_receipts")}
        WHERE owner_digest=$1`,
      [ownerDigest],
    );
    assert.equal(receipt.rowCount, 1, "owner erasure records durable terminal proof");
    await assert.rejects(
      pool.query(
        `UPDATE ${table("storage_v11_owner_links")} SET state='active' WHERE participant_id=$1`,
        [participantId],
      ),
      (error) => error?.code === "P1005",
      "owner erasure is an irreversible terminal state",
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table("storage_v11_owner_links")} WHERE participant_id=$1`, [participantId]),
      (error) => error?.code === "P1005",
      "an erased owner link remains the source-to-participant authority while its participant exists",
    );

    const erasedDelete = await pool.query(
      `DELETE FROM ${table("typed_v1_event_sources")} WHERE event_digest=$1`, [v1EventDigest],
    );
    assert.equal(erasedDelete.rowCount, 1, "terminal owner erasure releases v1 membership");
    const erasedV11Delete = await pool.query(`DELETE FROM ${table("storage_v11_event_sources")}`);
    assert.equal(erasedV11Delete.rowCount, 3, "terminal owner erasure releases retained v1.1 generations");
    await pool.query(
      `UPDATE ${table("telemetry_v1_chunks")} SET superseded_at=$2 WHERE id=$1`,
      [chunkId, now],
    );
    await pool.query(
      `UPDATE ${table("participants")} SET state='deleting' WHERE id=$1`, [participantId],
    );
    const participantDeleteAfterRelease = await pool.query(
      `DELETE FROM ${table("participants")} WHERE id=$1`, [participantId],
    );
    assert.equal(participantDeleteAfterRelease.rowCount, 1,
      "the participant cascade can remove the owner link after memberships are released");
    const retainedReceipt = await pool.query(
      `SELECT owner_digest FROM ${table("storage_owner_erasure_receipts")} WHERE owner_digest=$1`,
      [ownerDigest],
    );
    assert.equal(retainedReceipt.rowCount, 1, "terminal digest proof survives the participant cascade");

    const cascadeParticipantId = `synthetic-cascade-participant-${randomBytes(4).toString("hex")}`;
    const cascadeDeviceId = `synthetic-cascade-device-${randomBytes(4).toString("hex")}`;
    const cascadeOwnerDigest = randomBytes(32).toString("hex");
    const cascadeSessionId = randomUUID();
    const cascadePairingId = randomUUID();
    const cascadeUploadId = randomUUID();
    const cascadeChunkId = randomUUID();
    const cascadeDay = "2026-09-23";
    const cascadeEnvelopeDigest = randomBytes(32).toString("hex");
    const cascadeChunkDigest = randomBytes(32).toString("hex");
    const cascadeEventDigestV1 = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO ${table("participants")} (id, created_at) VALUES ($1,$2)`,
      [cascadeParticipantId, now],
    );
    await pool.query(
      `INSERT INTO ${table("web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$3,$4,$5,$4)`,
      [cascadeSessionId, cascadeParticipantId, randomBytes(32), now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1',
         'consumed',$5,$6,$5,$7)`,
      [cascadePairingId, cascadeParticipantId, cascadeSessionId, randomBytes(32), now, expiresAt, cascadeDeviceId],
    );
    await pool.query(
      `INSERT INTO ${table("device_credentials")} (
         id, participant_id, paired_via_pairing_id, secret_hash,
         issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
      [cascadeDeviceId, cascadeParticipantId, cascadePairingId, randomBytes(32), now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("storage_v11_owner_links")} (participant_id, owner_digest, state)
       VALUES ($1,$2,'active')`,
      [cascadeParticipantId, cascadeOwnerDigest],
    );
    await pool.query(
      `INSERT INTO ${table("device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at, consumed_at
       ) VALUES ($1,$2,$3,$4,$5,32,'application/json','consumed',$6,$7,$6)`,
      [cascadeUploadId, cascadeParticipantId, cascadeDeviceId, randomBytes(32), cascadeEnvelopeDigest, now, expiresAt],
    );
    await pool.query(
      `INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1,$2,'telemetry_v1')`,
      [cascadeChunkId, `synthetic/${cascadeChunkId}`],
    );
    await pool.query(
      `INSERT INTO ${table("telemetry_v1_chunks")} (
         id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
         chunk_digest, envelope_digest, parser_version, record_count,
         accepted_record_count, r2_key, device_upload_authorization_id, created_at
       ) VALUES ($1,$2,$3,'usage',$4::date,0,1,$5,$6,'synthetic-membership',
         1,1,$7,$8,$9)`,
      [cascadeChunkId, cascadeParticipantId, cascadeDeviceId, cascadeDay, cascadeChunkDigest,
        cascadeEnvelopeDigest, `synthetic/${cascadeChunkId}`, cascadeUploadId, now],
    );
    await pool.query(
      `INSERT INTO ${table("telemetry_v1_records")} (
         chunk_row_id, participant_id, device_id, stream, occurrence_id,
         observed_at, observed_day, record_json
       ) VALUES ($1,$2,$3,'usage','synthetic-cascade-occurrence',$4,$5::date,'{}'::jsonb)`,
      [cascadeChunkId, cascadeParticipantId, cascadeDeviceId, `${cascadeDay}T12:00:00.000Z`, cascadeDay],
    );
    await pool.query(
      `INSERT INTO ${table("typed_v1_event_sources")} (
         event_digest, owner_digest, participant_id, chunk_id, source_namespace
       ) VALUES ($1,$2,$3,$4,$5)`,
      [cascadeEventDigestV1, cascadeOwnerDigest, cascadeParticipantId, cascadeChunkId, sourceNamespace],
    );
    const cascadeGeneration = await insertGeneration(pool, schema, {
      participantId: cascadeParticipantId, deviceId: cascadeDeviceId, day: cascadeDay, now,
    });
    await pool.query(
      `INSERT INTO ${table("telemetry_v11_domain_heads")} (
         participant_id, generation_id, revision, updated_at
       ) VALUES ($1,$2,1,$3)`,
      [cascadeParticipantId, cascadeGeneration.generationId, now],
    );
    const cascadeEventDigestV11 = randomBytes(32).toString("hex");
    const cascadePublication = [
      cascadeEventDigestV11, cascadeOwnerDigest, cascadeParticipantId, cascadeDeviceId,
      cascadeGeneration.generationId, cascadeGeneration.manifestDigest,
      cascadeDay, cascadeDay, 1, 0, Date.now(),
    ];
    await pool.query(
      `INSERT INTO ${table("storage_v11_event_sources")} (
         event_digest, owner_digest, participant_id, device_id, generation_id,
         manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
      cascadePublication,
    );

    // Model the erasure transaction acquiring participant then owner. A
    // concurrent v1.1 insert must wait before it can lock the head, so erasure
    // can cascade without an owner/head lock cycle.
    const erasure = await pool.connect();
    const concurrentPublisher = await pool.connect();
    try {
      await erasure.query("BEGIN");
      await erasure.query(
        `SELECT id FROM ${table("participants")} WHERE id=$1 FOR UPDATE`,
        [cascadeParticipantId],
      );
      await erasure.query(
        `UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
        [cascadeParticipantId],
      );
      await erasure.query(
        `UPDATE ${table("telemetry_v1_chunks")} SET superseded_at=$2 WHERE id=$1`,
        [cascadeChunkId, now],
      );
      await erasure.query(
        `UPDATE ${table("participants")} SET state='deleting' WHERE id=$1`,
        [cascadeParticipantId],
      );
      const { rows: [{ pid: concurrentPid }] } = await concurrentPublisher.query(
        "SELECT pg_backend_pid() AS pid",
      );
      await concurrentPublisher.query("SET statement_timeout='10s'");
      const publication = concurrentPublisher.query(
        `INSERT INTO ${table("storage_v11_event_sources")} (
           event_digest, owner_digest, participant_id, device_id, generation_id,
           manifest_digest, from_day, through_day, head_revision, input_revision, recorded_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
        [randomBytes(32).toString("hex"), ...cascadePublication.slice(1)],
      ).then((value) => ({ value }), (error) => ({ error }));
      await waitForLockWait(pool, concurrentPid);
      const participantDelete = await erasure.query(
        `DELETE FROM ${table("participants")} WHERE id=$1`,
        [cascadeParticipantId],
      );
      assert.equal(participantDelete.rowCount, 1);
      await erasure.query("COMMIT");
      const publicationResult = await publication;
      assert.equal(publicationResult.error?.code, "P1005",
        "publication wakes after erasure and rejects the deleted participant");
    } finally {
      try { await erasure.query("ROLLBACK"); } catch {}
      erasure.release();
      concurrentPublisher.release();
    }

    const [cascadeV1, cascadeV11, cascadeOwner, cascadeParticipant] = await Promise.all([
      pool.query(`SELECT 1 FROM ${table("typed_v1_event_sources")} WHERE participant_id=$1`, [cascadeParticipantId]),
      pool.query(`SELECT 1 FROM ${table("storage_v11_event_sources")} WHERE participant_id=$1`, [cascadeParticipantId]),
      pool.query(`SELECT 1 FROM ${table("storage_v11_owner_links")} WHERE owner_digest=$1`, [cascadeOwnerDigest]),
      pool.query(`SELECT 1 FROM ${table("participants")} WHERE id=$1`, [cascadeParticipantId]),
    ]);
    assert.equal(cascadeV1.rowCount, 0, "participant cascade removes the v1 membership row");
    assert.equal(cascadeV11.rowCount, 0, "participant cascade removes the v1.1 membership row");
    assert.equal(cascadeOwner.rowCount, 0, "participant cascade removes the owner-link index row");
    assert.equal(cascadeParticipant.rowCount, 0, "participant is deleted");
    const cascadeReceipt = await pool.query(
      `SELECT owner_digest FROM ${table("storage_owner_erasure_receipts")}
        WHERE owner_digest=$1`,
      [cascadeOwnerDigest],
    );
    assert.equal(cascadeReceipt.rowCount, 1,
      "participant deletion retains digest-only proof after cascading memberships and owner link");
  } finally {
    if (created) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (legacyCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`); } catch {}
    }
    if (migrationRoot) await rm(migrationRoot, { recursive: true, force: true });
    await pool.end();
  }
});
