import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import {
  createSealedSqliteSocialV02ReceiptSource,
  transferPostgresSocialV02Receipts,
} from "../scripts/postgres-social-v02-receipt-transfer.mjs";
import { applyStockAndStagedMigrations, postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  digest,
  makeSocialV02ReceiptProjection,
  SOCIAL_V02_SOURCE_ID,
} from "./social-v02-receipt-transfer-fixture.mjs";

const ENDPOINT = await postgresTestEndpoint();
const SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for PostgreSQL 17"
  : false;
const PG_TEST_PASSWORD = ENDPOINT?.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const STAGED_FILES = Object.freeze([
  "0051_transport_floor_parity.sql",
  "0052_typed_telemetry_live_allocators.sql",
  "0053_community_publication_authority.sql",
  "0094_social_v02_bootstrap_receipts.sql",
]);
const CONSENT = "ongoing-privacy-safe-telemetry-v0.1";
const FIXED_TIME = "2026-09-21T01:02:03.456Z";
const sha256 = value => createHash("sha256").update(String(value)).digest("hex");

async function withTarget(operation) {
  assert.ok(ENDPOINT, "the PG17 fixture must not run without an explicit local endpoint");
  const schema = `social_v02_receipt_transfer_target_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = name => {
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
    application_name: "pg-social-v02-receipt-transfer-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  try {
    const server = await pool.query(`SELECT current_setting('server_version_num')::integer AS version,
      inet_server_addr() IS NULL AS unix_socket`);
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    if (ENDPOINT.host?.includes("/socket")) assert.equal(server.rows[0].unix_socket, true);
    await pool.query(`CREATE SCHEMA ${quoted}`);
    const stock = await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: STAGED_FILES });
    assert.equal(stock.stockApplied, 46);
    await operation({ pool, schema, table });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await pool.end();
  }
}

async function insertEligibleSocialV02(pool, table) {
  const participantId = `synthetic-social-${randomBytes(6).toString("hex")}`;
  const ownerDigest = sha256(`${participantId}-owner`);
  await pool.query(`INSERT INTO ${table("participants")}(
      id,owner_kind,state,consent_version,consented_at,created_at
    ) VALUES ($1,'social','active',$2,$3,$3)`, [participantId, CONSENT, FIXED_TIME]);
  const contributionId = `synthetic-v02-${participantId}`;
  await pool.query(`INSERT INTO ${table("telemetry_contributions")}(
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,
      range_start,range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,
      unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1','telemetry-contribution-v0.2',
      $6,$7,'synthetic','synthetic-policy',0,0,0,'synthetic',0,$8)`,
  [contributionId, participantId, sha256(`${contributionId}-plain`), sha256(`${contributionId}-envelope`),
    `synthetic/${contributionId}`, FIXED_TIME, FIXED_TIME, FIXED_TIME]);
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id,owner_digest,state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${table("community_analytical_input_versions")}(participant_id,revision)
    VALUES ($1,1) ON CONFLICT(participant_id) DO UPDATE SET revision=1`, [participantId]);
  return { participantId, ownerDigest };
}

async function sourceProof(pool, table, participantId, ownerDigest, eventDigest) {
  const [journalResult, headResult, inputResult, linkResult, sourceResult] = await Promise.all([
    pool.query(`SELECT source_id,sequence::text AS sequence,event_digest,owner_digest,revision::text AS revision,
        kind,object_digest,content_digest,authority_epoch::text AS authority_epoch,
        public_authority_epoch::text AS public_authority_epoch,recorded_ms::text AS recorded_ms
      FROM ${table("storage_ingestion_changes")} WHERE event_digest=$1`, [eventDigest]),
    pool.query(`SELECT revision::text AS revision,authority_epoch::text AS authority_epoch,state,
        last_sequence::text AS last_sequence,object_digest,content_digest
      FROM ${table("storage_owner_revisions")} WHERE owner_digest=$1`, [ownerDigest]),
    pool.query(`SELECT revision::text AS revision FROM ${table("community_analytical_input_versions")}
      WHERE participant_id=$1`, [participantId]),
    pool.query(`SELECT state FROM ${table("storage_v11_owner_links")}
      WHERE participant_id=$1 AND owner_digest=$2`, [participantId, ownerDigest]),
    pool.query(`SELECT source_id,authority_epoch::text AS authority_epoch FROM ${table("storage_source_state")}
      WHERE singleton=1`),
  ]);
  assert.equal(journalResult.rows.length, 1);
  assert.equal(headResult.rows.length, 1);
  assert.equal(inputResult.rows.length, 1);
  assert.equal(linkResult.rows.length, 1);
  assert.equal(sourceResult.rows.length, 1);
  const journal = journalResult.rows[0];
  const head = headResult.rows[0];
  const input = inputResult.rows[0];
  const link = linkResult.rows[0];
  return {
    sourceId: sourceResult.rows[0].source_id,
    sourceAuthorityEpoch: sourceResult.rows[0].authority_epoch,
    journal,
    proof: {
      event_digest: journal.event_digest,
      owner_digest: ownerDigest,
      participant_id: participantId,
      input_revision: input.revision,
      change_kind: journal.kind,
      sequence: journal.sequence,
      journal_revision: journal.revision,
      journal_kind: journal.kind,
      object_digest: journal.object_digest,
      content_digest: journal.content_digest,
      authority_epoch: journal.authority_epoch,
      public_authority_epoch: journal.public_authority_epoch,
      recorded_ms: journal.recorded_ms,
      owner_link_digest: ownerDigest,
      owner_link_state: link.state,
      current_input_revision: input.revision,
      owner_head_revision: head.revision,
      owner_head_authority_epoch: head.authority_epoch,
      owner_head_state: head.state,
      owner_head_last_sequence: head.last_sequence,
      owner_head_object_digest: head.object_digest,
      owner_head_content_digest: head.content_digest,
    },
  };
}

test("PG17 social v0.2 receipt transfer reconciles sealed source evidence, inserts exact rows and safely replays", {
  skip: SKIP,
  timeout: 180_000,
}, async () => withTarget(async ({ pool, schema, table }) => {
  await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch)
    VALUES (1,$1,0)`, [SOCIAL_V02_SOURCE_ID]);
  const { participantId, ownerDigest } = await insertEligibleSocialV02(pool, table);
  const eventDigest = sha256("synthetic-social-v02-source-event");
  await pool.query(`SELECT ${table("storage_journal_append")}('owner-active',$1,$2,$2,$2)`, [ownerDigest, eventDigest]);
  const evidence = await sourceProof(pool, table, participantId, ownerDigest, eventDigest);
  assert.equal(evidence.sourceId, SOCIAL_V02_SOURCE_ID);
  assert.equal(evidence.proof.input_revision, "1");
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "1");

  const staleProof = { ...evidence.proof, current_input_revision: "2" };
  const staleFile = await makeSocialV02ReceiptProjection({
    sourceId: evidence.sourceId,
    sourceAuthorityEpoch: evidence.sourceAuthorityEpoch,
    journalRows: [evidence.journal],
    proofRows: [staleProof],
  });
  let staleSource;
  try {
    staleSource = await createSealedSqliteSocialV02ReceiptSource({
      path: staleFile.path,
      expectedSha256: staleFile.expectedSha256,
      expectedSourceId: evidence.sourceId,
    });
    await assert.rejects(transferPostgresSocialV02Receipts({
      source: staleSource,
      destinationPool: pool,
      targetSchema: schema,
      pageSize: 1,
    }), { code: "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH" });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_legacy_event_sources")}`)).rows[0].count, 0,
      "authority mismatch rolls back receipt insertion");
  } finally {
    staleSource?.close();
    await rm(staleFile.directory, { recursive: true, force: true });
  }

  const file = await makeSocialV02ReceiptProjection({
    sourceId: evidence.sourceId,
    sourceAuthorityEpoch: evidence.sourceAuthorityEpoch,
    journalRows: [evidence.journal],
    proofRows: [evidence.proof],
  });
  let source;
  try {
    source = await createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: file.expectedSha256,
      expectedSourceId: evidence.sourceId,
    });
    const first = await transferPostgresSocialV02Receipts({ source, destinationPool: pool, targetSchema: schema, pageSize: 1 });
    assert.equal(first.status, "synthetic_social_v02_receipt_transfer_complete");
    assert.equal(first.sourceJournalRows, "1");
    assert.equal(first.sourceReceiptRows, "1");
    assert.equal(first.targetReceiptRows, "1");
    assert.equal(first.journalRowsWritten, false);
    assert.equal(first.ownerHeadsWritten, false);
    assert.equal(first.bootstrapPending, "0");
    assert.deepEqual((await pool.query(`SELECT event_digest,owner_digest,participant_id,input_revision::text AS input_revision,change_kind
      FROM ${table("storage_legacy_event_sources")}`)).rows, [{
      event_digest: eventDigest,
      owner_digest: ownerDigest,
      participant_id: participantId,
      input_revision: "1",
      change_kind: "owner-active",
    }]);
    const second = await transferPostgresSocialV02Receipts({ source, destinationPool: pool, targetSchema: schema, pageSize: 1 });
    assert.equal(second.targetReceiptRows, "1", "exact replay leaves one immutable receipt");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_ingestion_changes")}`)).rows[0].count, 1,
      "receipt transfer does not append a journal event");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_owner_revisions")}`)).rows[0].count, 1,
      "receipt transfer does not synthesize or rewrite the owner head");
  } finally {
    source?.close();
    await rm(file.directory, { recursive: true, force: true });
  }
}));

test("PG17 transfer reconciles v1 rows across retained v0 sequence gaps and rolls back a later page failure", {
  skip: SKIP,
  timeout: 180_000,
}, async () => withTarget(async ({ pool, schema, table }) => {
  await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch)
    VALUES (1,$1,0)`, [SOCIAL_V02_SOURCE_ID]);
  const { participantId, ownerDigest } = await insertEligibleSocialV02(pool, table);
  const firstEventDigest = sha256("synthetic-social-v02-gapped-event-one");
  const retainedV0Digest = sha256("synthetic-retained-v0-event");
  const secondEventDigest = sha256("synthetic-social-v02-gapped-event-two");

  await pool.query(`SELECT ${table("storage_journal_append")}('owner-active',$1,$2,$2,$2)`,
    [ownerDigest, firstEventDigest]);
  await pool.query(`INSERT INTO ${table("storage_ingestion_changes")}(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
    ) VALUES ($1,2,$2,$3,0,0,'source-updated',0)`,
  [SOCIAL_V02_SOURCE_ID, retainedV0Digest, sha256("synthetic-v0-owner")]);
  await pool.query(`UPDATE ${table("community_analytical_input_versions")} SET revision=2
    WHERE participant_id=$1`, [participantId]);
  await pool.query(`SELECT ${table("storage_journal_append")}('source-updated',$1,$2,$2,$2)`,
    [ownerDigest, secondEventDigest]);

  const first = await sourceProof(pool, table, participantId, ownerDigest, firstEventDigest);
  const second = await sourceProof(pool, table, participantId, ownerDigest, secondEventDigest);
  first.proof.input_revision = "1";
  assert.equal(first.journal.sequence, "1");
  assert.equal(second.journal.sequence, "3");
  assert.equal(second.sourceAuthorityEpoch, "1");
  const journalRows = [first.journal, second.journal];
  const proofRows = [first.proof, second.proof].sort((left, right) => left.event_digest.localeCompare(right.event_digest));
  const failureDigest = proofRows[1].event_digest;
  assert.match(failureDigest, /^[0-9a-f]{64}$/u);
  const file = await makeSocialV02ReceiptProjection({
    sourceId: first.sourceId,
    sourceAuthorityEpoch: first.sourceAuthorityEpoch,
    journalRows,
    proofRows,
  });
  let source;
  try {
    source = await createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: file.expectedSha256,
      expectedSourceId: first.sourceId,
    });

    await pool.query(`CREATE FUNCTION "${schema}".social_v02_second_page_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_digest = '${failureDigest}' THEN
          RAISE EXCEPTION 'synthetic_second_page_failure' USING ERRCODE='P1005';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await pool.query(`CREATE TRIGGER social_v02_second_page_failure
      BEFORE INSERT ON ${table("storage_legacy_event_sources")}
      FOR EACH ROW EXECUTE FUNCTION "${schema}".social_v02_second_page_failure()`);

    await assert.rejects(transferPostgresSocialV02Receipts({
      source,
      destinationPool: pool,
      targetSchema: schema,
      pageSize: 1,
    }), { code: "SOCIAL_V02_RECEIPT_TARGET_INSERT_FAILED" });
    assert.equal((await pool.query(`SELECT count(*)::int AS count
      FROM ${table("storage_legacy_event_sources")}`)).rows[0].count, 0,
    "failure on page two rolls back the receipt inserted by page one");

    await pool.query(`DROP TRIGGER social_v02_second_page_failure ON ${table("storage_legacy_event_sources")}`);
    await pool.query(`DROP FUNCTION "${schema}".social_v02_second_page_failure()`);
    const result = await transferPostgresSocialV02Receipts({ source, destinationPool: pool, targetSchema: schema, pageSize: 1 });
    assert.equal(result.sourceJournalRows, "2");
    assert.equal(result.sourceJournalLastSequence, "3");
    assert.equal(result.targetJournalLastSequence, "3");
    assert.equal(result.targetReceiptRows, "2");
    assert.equal(result.bootstrapPending, "0");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_ingestion_changes")}`)).rows[0].count, 3,
      "the retained version-0 row remains between the two exact journal rows");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_legacy_event_sources")}`)).rows[0].count, 2);
  } finally {
    source?.close();
    await rm(file.directory, { recursive: true, force: true });
  }
}));
