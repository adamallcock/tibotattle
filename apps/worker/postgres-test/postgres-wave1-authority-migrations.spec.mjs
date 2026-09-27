import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const ENDPOINT = await postgresTestEndpoint();
const SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for PostgreSQL 17"
  : false;
const PG_TEST_PASSWORD = ENDPOINT?.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const STAGED = Object.freeze([
  "0051_transport_floor_parity.sql",
  "0052_typed_telemetry_live_allocators.sql",
  "0053_community_publication_authority.sql",
  "0054_signin_handoff_claim_shape.sql",
]);
const FINAL_STAGED = Object.freeze([...STAGED, "0055_v12_owner_bridge.sql"]);
const V12_OWNER_BRIDGE = FINAL_STAGED[FINAL_STAGED.length - 1];
const CONSENT_VERSION = "ongoing-privacy-safe-telemetry-v0.1";
const V11_CONSENT = Object.freeze({
  schema: "telemetry-contribution-v1.1",
  dictionary: "telemetry-v1.1-registry-2026-08-31.1",
  privacy: "ongoing-privacy-safe-telemetry-v1.1",
});
const SOURCE_ID = "synthetic-wave1-publication-source";
const SOURCE_NAMESPACE = "synthetic-wave1-publication-namespace";
const FIXED_TIME = "2026-09-21T01:02:03.456Z";
const IDENTITIES = Object.freeze([
  "typed_telemetry_namespaces",
  "typed_telemetry_owners",
  "typed_telemetry_devices",
  "typed_telemetry_manifests",
  "typed_telemetry_chunks",
  "typed_telemetry_identifiers",
  "typed_telemetry_attributions",
  "typed_telemetry_quota_dimensions",
  "typed_telemetry_records",
]);

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

async function withSchema(operation) {
  assert.ok(ENDPOINT, "the PG17 fixture must not run without an explicit local endpoint");
  const schema = `wave1_primary_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted}."${name}"`;
  };
  const pool = new pg.Pool({
    ...ENDPOINT,
    password: PG_TEST_PASSWORD,
    database: process.env.PG_TEST_DATABASE || "postgres",
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
    application_name: "pg-wave1-authority-migrations-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  try {
    const server = await pool.query(`SELECT current_setting('server_version_num')::integer AS version,
      inet_server_addr()::text AS address`);
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "Wave-1 migration coverage runs on PostgreSQL 17");
    if (ENDPOINT.host.includes("/socket")) assert.equal(server.rows[0].address, null,
      "the qualifying profile uses the private Unix socket");
    await pool.query(`CREATE SCHEMA ${quoted}`);
    const apply = (stagedFiles) => applyStockAndStagedMigrations({
      role: "primary", schema, pool, stagedFiles,
    });
    const stock = await apply([]);
    assert.equal(stock.stockApplied, 46, "the fixture starts from the complete primary chain through 0046");
    await operation({ pool, schema, table, apply });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await pool.end();
  }
}

async function insertSocialParticipant(pool, table, participantId) {
  await pool.query(`INSERT INTO ${table("participants")} (
      id,owner_kind,state,consent_version,consented_at,created_at
    ) VALUES ($1,'social','active',$2,$3,$3)`, [participantId, CONSENT_VERSION, FIXED_TIME]);
}

async function insertSocialDevice(pool, table, participantId, deviceId) {
  const sessionId = `session-${deviceId}`;
  const pairingId = `pairing-${deviceId}`;
  await pool.query(`INSERT INTO ${table("web_sessions")} (
      id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,$3,$4,'personal','active',$5,'2099-01-01T00:00:00.000Z',$5)`,
  [sessionId, participantId, Buffer.from(digest(sessionId), "hex"),
    Buffer.from(digest(`csrf-${deviceId}`), "hex"), FIXED_TIME]);
  await pool.query(`INSERT INTO ${table("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,
      state,issued_at,expires_at,consumed_at,claimed_device_id
    ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,'2099-01-01T00:00:00.000Z',$6,$7)`,
  [pairingId, participantId, sessionId, Buffer.from(digest(pairingId), "hex"), CONSENT_VERSION,
    FIXED_TIME, deviceId]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,
      last_used_at,social_verified_at
    ) VALUES ($1,$2,'social',$3,$4,'active',$5,'2099-01-01T00:00:00.000Z',$5,$5)`,
  [deviceId, participantId, pairingId, Buffer.from(digest(`secret-${deviceId}`), "hex"), FIXED_TIME]);
}

async function insertV11Consent(pool, table, participantId, deviceId) {
  await pool.query(`INSERT INTO ${table("telemetry_v11_device_consents")} (
      participant_id,device_id,telemetry_schema_version,field_dictionary_version,
      privacy_contract_version,consented_at
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
  [participantId, deviceId, V11_CONSENT.schema, V11_CONSENT.dictionary, V11_CONSENT.privacy, FIXED_TIME]);
}

async function participantFloor(pool, table, participantId) {
  return (await pool.query(`SELECT minimum_rank,revision FROM ${table("telemetry_transport_participant_floors")}
    WHERE participant_id=$1`, [participantId])).rows;
}

async function deviceFloor(pool, table, deviceId) {
  return (await pool.query(`SELECT minimum_rank,revision FROM ${table("telemetry_transport_device_floors")}
    WHERE device_id=$1`, [deviceId])).rows;
}

async function expectSqlError(promise, code, message, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    if (code === "23514") {
      assert.ok(constraint, "native CHECK refusals identify the expected constraint");
      assert.equal(error?.constraint, constraint);
      return true;
    }
    if (message !== undefined) assert.equal(error.message, message);
    assert.equal(error.detail, undefined, "database refusals do not expose row values");
    return true;
  });
}

async function insertV02History(pool, table, participantId) {
  const id = `synthetic-v02-${participantId}`;
  await pool.query(`INSERT INTO ${table("telemetry_contributions")} (
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,
      range_start,range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,
      unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1','telemetry-contribution-v0.2',
      $6,$7,'synthetic','synthetic-policy',0,0,0,'synthetic',0,$8)`,
  [id, participantId, digest(`${id}-plain`), digest(`${id}-envelope`), `synthetic/${id}`,
    FIXED_TIME, FIXED_TIME, FIXED_TIME]);
}

function authority(publicAuthorityEpoch) {
  return {
    sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_NAMESPACE,
    publicAuthorityEpoch,
    policyRevision: 1,
    collectionRevision: 2,
    graphInvalidationEpoch: 3,
    sourceEpoch: 4,
    sequence: 9,
  };
}

async function insertAuthorityDaily(pool, table, publicEpoch) {
  const day = "2026-09-20";
  const revision = 1;
  const payload = JSON.stringify({ schemaVersion: "community-daily-aggregate-v1.0", day, revision });
  const deviceMethod = "contributing-devices-by-reader-v1";
  const pin = authority(publicEpoch);
  const authorityJson = JSON.stringify({ ...pin, dailyDeviceMethod: deviceMethod });
  await pool.query(`INSERT INTO ${table("community_daily_aggregates")} (
      source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,
      source_cursor_sequence,policy_revision,collection_revision,release_state,released_at,
      public_authority_epoch,source_mutation_epoch,journal_sequence,graph_invalidation_epoch,
      cohort_digest,provenance,import_receipt_id,released_at_iso,authority_json,daily_device_method
    ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,'published',$11,$7,$12,$8,$13,$14,'gcp',NULL,
      $17::text,$15,$16)`,
  [SOURCE_ID, SOURCE_NAMESPACE, day, revision, payload, digest(payload), publicEpoch, pin.sequence,
    pin.policyRevision, pin.collectionRevision, FIXED_TIME, pin.sourceEpoch, pin.graphInvalidationEpoch,
    digest(`cohort-${publicEpoch}`), authorityJson, deviceMethod, FIXED_TIME]);
}

async function insertGraphPreview(pool, table, publicEpoch, revision = 1) {
  const pin = authority(publicEpoch);
  const authorityJson = JSON.stringify(pin);
  const payload = JSON.stringify({ generatedAt: "2026-09-21T00:00:00.000Z", models: [] });
  await pool.query(`INSERT INTO ${table("community_graph_previews")} (
      source_id,source_namespace,revision,method,cohort_digest,authority_json,public_authority_epoch,
      policy_revision,collection_revision,source_mutation_epoch,journal_sequence,graph_invalidation_epoch,
      model_revision,payload_json,payload_sha256,generated_at,snapshot_source_epoch,inputs_current,
      oldest_computed_ms,newest_computed_ms,provenance,import_receipt_id
    ) VALUES ($1,$2,$3,'synthetic-graph-method',$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,
      '2026-09-21T00:00:00.000Z',$9,1,1,2,'gcp',NULL)`,
  [SOURCE_ID, SOURCE_NAMESPACE, revision, digest(`preview-${revision}`), authorityJson, publicEpoch,
    pin.policyRevision, pin.collectionRevision, pin.sourceEpoch, pin.sequence,
    pin.graphInvalidationEpoch, payload, digest(payload)]);
}

test("PG17 applies 0051-0054 safely before the existing 0055 and preserves publication erasure guards",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, table, apply }) => {
    const social = "legacy-social-11";
    const accountless = "legacy-accountless";
    const v02 = "legacy-v02";
    await insertSocialParticipant(pool, table, social);
    await insertSocialParticipant(pool, table, v02);
    await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at)
      VALUES ($1,'accountless','active',$2)`, [accountless, FIXED_TIME]);
    await pool.query(`INSERT INTO ${table("telemetry_transport_participant_floors")} (
        participant_id,minimum_rank,revision,changed_at
      ) VALUES ($1,11,1,$2)`, [social, FIXED_TIME]);
    await insertSocialDevice(pool, table, social, "legacy-consented-device");
    await insertSocialDevice(pool, table, social, "legacy-plain-device");
    await insertV11Consent(pool, table, social, "legacy-consented-device");
    await insertV02History(pool, table, v02);

    const first = await apply([STAGED[0]]);
    assert.deepEqual(first.staged.map(({ name }) => name), [STAGED[0]]);
    assert.deepEqual(await participantFloor(pool, table, social), [{ minimum_rank: 11, revision: 1 }],
      "0051 preserves a pre-existing rank and revision");
    assert.deepEqual(await participantFloor(pool, table, accountless), [{ minimum_rank: 11, revision: 0 }]);
    assert.deepEqual(await participantFloor(pool, table, v02), [{ minimum_rank: 1, revision: 0 }]);
    assert.deepEqual(await deviceFloor(pool, table, "legacy-consented-device"), [{ minimum_rank: 11, revision: 0 }]);
    assert.deepEqual(await deviceFloor(pool, table, "legacy-plain-device"), [{ minimum_rank: 10, revision: 0 }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("attribution_enrollments")}`)).rows[0].count,
      3, "existing participants receive one attribution enrollment each");

    const newSocial = "new-social-after-0051";
    await pool.query(`UPDATE ${table("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version=$1`, [V11_CONSENT.schema]);
    await insertSocialParticipant(pool, table, newSocial);
    assert.deepEqual(await participantFloor(pool, table, newSocial), [{ minimum_rank: 1, revision: 0 }]);
    await insertSocialDevice(pool, table, newSocial, "new-consented-device");
    assert.deepEqual(await deviceFloor(pool, table, "new-consented-device"), [{ minimum_rank: 1, revision: 0 }]);
    await insertV11Consent(pool, table, newSocial, "new-consented-device");
    assert.deepEqual(await participantFloor(pool, table, newSocial), [{ minimum_rank: 11, revision: 1 }],
      "v1.1 consent raises the participant floor");
    assert.deepEqual(await deviceFloor(pool, table, "new-consented-device"), [{ minimum_rank: 11, revision: 1 }]);
    await insertSocialDevice(pool, table, newSocial, "new-plain-device");
    assert.deepEqual(await deviceFloor(pool, table, "new-plain-device"), [{ minimum_rank: 10, revision: 0 }],
      "a later social device keeps the D1 rank-10 admission branch");
    await expectSqlError(pool.query(`UPDATE ${table("telemetry_transport_participant_floors")}
      SET minimum_rank=1,revision=revision+1 WHERE participant_id=$1`, [newSocial]),
    "P1005", "telemetry_transport_rollback_required");
    await expectSqlError(pool.query(`UPDATE ${table("telemetry_transport_device_floors")}
      SET minimum_rank=1,revision=revision+1 WHERE device_id='new-plain-device'`),
    "P1005", "telemetry_transport_device_floor_rollback_required");
    await expectSqlError(pool.query(`UPDATE ${table("telemetry_transport_participant_floors")}
      SET minimum_rank=11,revision=revision+1 WHERE participant_id=$1`, [v02]),
    "P1007", "telemetry_transport_blocked");

    // An explicit id is valid before 0052, as it is for D1 import. The staged
    // migration and restart function must leave every allocator above it.
    await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id,original_id)
      VALUES (50,decode('0102','hex'))`);
    const second = await apply([STAGED[1]]);
    assert.deepEqual(second.staged.map(({ name }) => name), [STAGED[1]]);
    const identityRows = await pool.query(`SELECT relation.relname AS table_name,attribute.attidentity AS identity
      FROM pg_attribute attribute JOIN pg_class relation ON relation.oid=attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=$1 AND attribute.attname='id' AND NOT attribute.attisdropped
        AND relation.relname=ANY($2::text[]) ORDER BY relation.relname`, [schema, IDENTITIES]);
    assert.deepEqual(identityRows.rows, IDENTITIES.slice().sort().map((table_name) => ({ table_name, identity: "d" })),
      "all nine typed ids accept explicit imports while allocating live rows by default");
    const allocated = await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(original_id)
      VALUES (decode('0304','hex')) RETURNING id`);
    assert.equal(allocated.rows[0].id, "51", "0052 initializes identities above pre-existing explicit ids");
    await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id,original_id)
      VALUES (60,decode('0506','hex'))`);
    await pool.query(`SELECT ${table("typed_telemetry_restart_identities")}()`);
    const afterRestart = await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(original_id)
      VALUES (decode('0708','hex')) RETURNING id`);
    assert.equal(afterRestart.rows[0].id, "61", "restart never lowers an allocator below imported rows");

    await apply([STAGED[2]]);
    assert.equal((await pool.query(`SELECT completed FROM ${table("community_public_source_bootstrap")}`)).rows[0].completed,
      1, "empty journal-producing schema follows the reviewed bootstrap seed rule");
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch)
      VALUES ($1,4,5)`, [SOURCE_ID]);
    const owner = digest("wave1-erased-owner");
    const event = digest("wave1-erasure-event");
    const addFence = (source, ownerDigest, eventDigest, sequence, publicEpoch) => pool.query(
      `INSERT INTO ${table("analytics_storage_erasure_fences")} (
        source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch
      ) VALUES ($1,$2,$3,$4,2,3,$5)`, [source, ownerDigest, eventDigest, sequence, publicEpoch]);
    await addFence(SOURCE_ID, owner, event, 5, 7);
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_receipts")} (
      source_id,owner_digest,terminal_event_digest,payload_contract
    ) VALUES ($1,$2,$3,1)`, [SOURCE_ID, owner, event]);
    await addFence(SOURCE_ID, digest("wave1-lower-epoch-owner"), digest("wave1-lower-epoch-event"), 6, 6);
    assert.deepEqual((await pool.query(`SELECT terminal_public_authority_epoch,terminal_sequence
      FROM ${table("community_terminal_watermarks")} WHERE source_id=$1`, [SOURCE_ID])).rows,
    [{ terminal_public_authority_epoch: "7", terminal_sequence: "6" }],
    "fences raise the retained watermark and a lower epoch never lowers it");
    await expectSqlError(pool.query(`UPDATE ${table("analytics_storage_erasure_fences")}
      SET public_authority_epoch=8 WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, owner]),
    "P1005", "storage_erasure_fence_conflict");
    await expectSqlError(pool.query(`DELETE FROM ${table("analytics_storage_erasure_fences")}
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, owner]),
    "P1005", "storage_erasure_fence_retained");
    await expectSqlError(pool.query(`UPDATE ${table("analytics_storage_erasure_receipts")}
      SET payload_contract=1 WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, owner]),
    "P1005", "storage_erasure_receipt_immutable");
    await expectSqlError(pool.query(`DELETE FROM ${table("analytics_storage_erasure_receipts")}
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, owner]),
    "P1005", "storage_erasure_receipt_retained");
    await expectSqlError(pool.query(`TRUNCATE ${table("analytics_storage_erasure_fences")},
      ${table("analytics_storage_erasure_receipts")}`), "P1005", "community_publication_proof_retained");
    await pool.query(`INSERT INTO ${table("community_terminal_watermarks")} (
      source_id,terminal_public_authority_epoch,terminal_sequence,legacy_terminal_floor_epoch
    ) VALUES ('synthetic-legacy-terminal-source',1,1,20)`);
    await expectSqlError(pool.query(`UPDATE ${table("community_terminal_watermarks")}
      SET legacy_terminal_floor_epoch=19 WHERE source_id='synthetic-legacy-terminal-source'`),
    "P1005", "community_terminal_watermark_regression");
    await expectSqlError(pool.query(`UPDATE ${table("community_terminal_watermarks")}
      SET legacy_terminal_floor_epoch=NULL WHERE source_id='synthetic-legacy-terminal-source'`),
    "P1005", "community_terminal_watermark_regression");
    await expectSqlError(pool.query(`UPDATE ${table("community_terminal_watermarks")}
      SET terminal_public_authority_epoch=6 WHERE source_id=$1`, [SOURCE_ID]),
    "P1005", "community_terminal_watermark_regression");
    await expectSqlError(pool.query(`DELETE FROM ${table("community_terminal_watermarks")} WHERE source_id=$1`, [SOURCE_ID]),
      "P1005", "community_terminal_watermark_retained");
    await expectSqlError(pool.query(`TRUNCATE ${table("community_terminal_watermarks")}`),
      "P1005", "community_publication_proof_retained");

    await expectSqlError(insertAuthorityDaily(pool, table, 6), "P1005", "analytics_publication_authority_stale");
    await insertAuthorityDaily(pool, table, 7);
    await expectSqlError(insertGraphPreview(pool, table, 6), "P1005", "analytics_publication_authority_stale");
    await insertGraphPreview(pool, table, 7);
    const lowerGraphPin = JSON.stringify(authority(6));
    await expectSqlError(pool.query(`UPDATE ${table("community_graph_previews")}
      SET revision=2,public_authority_epoch=6,authority_json=$1 WHERE source_id=$2`, [lowerGraphPin, SOURCE_ID]),
    "P1005", "analytics_publication_authority_stale");

    // 0054 validates old rows inside the same transaction. A malformed row
    // must remain untouched, and the failed migration must leave neither
    // provider constraint installed.
    await pool.query(`INSERT INTO ${table("apple_signin_handoffs")} (
      state,nonce_hash,claim_id,created_at,expires_at
    ) VALUES ('legacy-invalid-claim',$1,'short',$2,'2099-01-01T00:00:00.000Z')`, [digest("nonce"), FIXED_TIME]);
    await assert.rejects(apply([STAGED[3]]), (error) => {
      assert.equal(error?.code, "STAGED_MIGRATION_APPLY_FAILED");
      assert.equal(error?.migration, STAGED[3]);
      assert.equal(error?.cause?.code, "23514");
      assert.equal(error?.cause?.constraint, "apple_signin_handoffs_claim_id_shape");
      return true;
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("apple_signin_handoffs")}
      WHERE state='legacy-invalid-claim' AND claim_id='short'`)).rows[0].count, 1,
    "migration refusal does not rewrite pre-existing claim data");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM pg_constraint
      WHERE conrelid IN ($1::regclass,$2::regclass)
        AND conname IN ('apple_signin_handoffs_claim_id_shape','google_signin_handoffs_claim_id_shape')`,
    [`${schema}.apple_signin_handoffs`, `${schema}.google_signin_handoffs`])).rows[0].count, 0,
    "the failed 0054 transaction installs neither half of the constraint pair");
    await pool.query(`DELETE FROM ${table("apple_signin_handoffs")} WHERE state='legacy-invalid-claim'`);
    const fourth = await apply([STAGED[3]]);
    assert.deepEqual(fourth.staged.map(({ name }) => name), [STAGED[3]]);
    assert.deepEqual((await pool.query(`SELECT conname,convalidated FROM pg_constraint
      WHERE conrelid IN ($1::regclass,$2::regclass)
      AND conname IN ('apple_signin_handoffs_claim_id_shape','google_signin_handoffs_claim_id_shape')
      ORDER BY conname`, [`${schema}.apple_signin_handoffs`, `${schema}.google_signin_handoffs`])).rows,
    [
      { conname: "apple_signin_handoffs_claim_id_shape", convalidated: true },
      { conname: "google_signin_handoffs_claim_id_shape", convalidated: true },
    ]);
    for (const provider of ["apple", "google"]) {
      const handoff = table(`${provider}_signin_handoffs`);
      const insertClaim = (state, claimId) => provider === "apple"
        ? pool.query(`INSERT INTO ${handoff}(state,nonce_hash,claim_id,created_at,expires_at)
            VALUES ($1,$2,$3,$4,'2099-01-01T00:00:00.000Z')`,
        [state, digest(`${state}-nonce`), claimId, FIXED_TIME])
        : pool.query(`INSERT INTO ${handoff}(state,claim_id,created_at,expires_at)
            VALUES ($1,$2,$3,'2099-01-01T00:00:00.000Z')`, [state, claimId, FIXED_TIME]);
      await insertClaim(`${provider}-null-claim`, null);
      await insertClaim(`${provider}-valid-claim`, "A".repeat(64));
      await expectSqlError(insertClaim(`${provider}-invalid-claim`, "A".repeat(63)),
      "23514", undefined,
      `${provider}_signin_handoffs_claim_id_shape`);
    }

    const final = await apply([V12_OWNER_BRIDGE]);
    assert.deepEqual(final.staged.map(({ name }) => name), [V12_OWNER_BRIDGE],
      "the existing v1.2 owner bridge remains compatible after 0051-0054");
    assert.equal(final.stockApplied, 46);
  }));
