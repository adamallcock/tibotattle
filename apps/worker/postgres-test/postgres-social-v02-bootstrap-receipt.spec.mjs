import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { applyStockAndStagedMigrations, postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const ENDPOINT = await postgresTestEndpoint();
const SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for PostgreSQL 17"
  : false;
const PG_TEST_PASSWORD = ENDPOINT?.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const BEFORE_RECEIPT = Object.freeze([
  "0051_transport_floor_parity.sql",
  "0052_typed_telemetry_live_allocators.sql",
  "0053_community_publication_authority.sql",
]);
const RECEIPT_MIGRATION = "0094_social_v02_bootstrap_receipts.sql";
const CONSENT = "ongoing-privacy-safe-telemetry-v0.1";
const FIXED_TIME = "2026-09-21T01:02:03.456Z";
const digest = value => createHash("sha256").update(String(value)).digest("hex");

async function withSchema(operation) {
  assert.ok(ENDPOINT, "the PG17 fixture must not run without an explicit local endpoint");
  const schema = `social_v02_receipt_${randomBytes(6).toString("hex")}`;
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
    application_name: "pg-social-v02-bootstrap-receipt-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  try {
    const server = await pool.query(`SELECT current_setting('server_version_num')::integer AS version,
      inet_server_addr() IS NULL AS unix_socket`);
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "social v0.2 bootstrap migration coverage runs on PostgreSQL 17");
    if (ENDPOINT.host.includes("/socket")) assert.equal(server.rows[0].unix_socket, true);
    await pool.query(`CREATE SCHEMA ${quoted}`);
    const apply = stagedFiles => applyStockAndStagedMigrations({
      role: "primary", schema, pool, stagedFiles,
    });
    const stock = await apply([]);
    assert.equal(stock.stockApplied, 46, "the fixture starts from primary migrations through 0046");
    await operation({ pool, schema, table, apply });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await pool.end();
  }
}

async function insertEligibleSocialV02(pool, table) {
  const participantId = `synthetic-social-${randomBytes(6).toString("hex")}`;
  const ownerDigest = digest(`${participantId}-owner`);
  await pool.query(`INSERT INTO ${table("participants")} (
      id,owner_kind,state,consent_version,consented_at,created_at
    ) VALUES ($1,'social','active',$2,$3,$3)`, [participantId, CONSENT, FIXED_TIME]);
  const contributionId = `synthetic-v02-${participantId}`;
  await pool.query(`INSERT INTO ${table("telemetry_contributions")} (
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,
      range_start,range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,
      unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1','telemetry-contribution-v0.2',
      $6,$7,'synthetic','synthetic-policy',0,0,0,'synthetic',0,$8)`,
  [contributionId, participantId, digest(`${contributionId}-plain`), digest(`${contributionId}-envelope`),
    `synthetic/${contributionId}`, FIXED_TIME, FIXED_TIME, FIXED_TIME]);
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id,owner_digest,state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  return { participantId, ownerDigest };
}

async function insertExactEventWithoutAppliedHead(pool, table, ownerDigest, eventDigest) {
  const changes = table("storage_ingestion_changes");
  const sourceId = "synthetic-social-v02-source";
  const sequence = (await pool.query(`SELECT COALESCE(max(sequence),0)::int+1 AS sequence
    FROM ${changes} WHERE source_id=$1`, [sourceId])).rows[0].sequence;
  await pool.query(`ALTER TABLE ${changes} DISABLE TRIGGER storage_owner_revision_advance`);
  try {
    await pool.query(`INSERT INTO ${changes} (
        source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
        event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
      ) VALUES ($1,$2,$3,$4,1,1,'owner-active',0,1,1,$3,$3,1)`,
    [sourceId, sequence, eventDigest, ownerDigest]);
  } finally {
    await pool.query(`ALTER TABLE ${changes} ENABLE TRIGGER storage_owner_revision_advance`);
  }
}

test("PG17 0094 repairs a false 0053 completion and waits for the exact current social v0.2 receipt", {
  skip: SKIP,
  timeout: 180_000,
}, async () => withSchema(async ({ pool, table, apply }) => {
  const receiptOnlyOwner = await insertEligibleSocialV02(pool, table);
  const eventWithoutHeadOwner = await insertEligibleSocialV02(pool, table);
  const fullyAppliedOwner = await insertEligibleSocialV02(pool, table);
  await apply(BEFORE_RECEIPT);

  assert.deepEqual((await pool.query(`SELECT completed FROM ${table("community_public_source_bootstrap")}
    WHERE singleton=1`)).rows, [{ completed: 1 }],
  "0053 reproduces the bug by completing before it knows about social v0.2 receipts");
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "0");

  await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch)
    VALUES (1,'synthetic-social-v02-source',0)`);
  await apply([RECEIPT_MIGRATION]);
  assert.deepEqual((await pool.query(`SELECT completed FROM ${table("community_public_source_bootstrap")}
    WHERE singleton=1`)).rows, [{ completed: 0 }],
  "0094 repairs the already-completed singleton when the exact receipt is missing");
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "3");
  assert.deepEqual((await pool.query(`SELECT * FROM ${table("community_public_source_bootstrap_advance")}()`)).rows,
    [{ completed: 0, pending: "3" }],
  "maintenance cannot complete bootstrap while the current source receipt is absent");

  const currentInput = table("community_analytical_input_versions");
  await pool.query(`DELETE FROM ${currentInput} WHERE participant_id=$1`, [receiptOnlyOwner.participantId]);
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "3",
    "a missing analytical input revision fails closed instead of removing the candidate");
  await pool.query(`INSERT INTO ${table("storage_legacy_event_sources")} (
      event_digest,owner_digest,participant_id,input_revision,change_kind
    ) VALUES ($1,$2,$3,0,'owner-active')`,
  [digest(`${receiptOnlyOwner.participantId}-revision-0`), receiptOnlyOwner.ownerDigest, receiptOnlyOwner.participantId]);
  await pool.query(`INSERT INTO ${currentInput}(participant_id,revision) VALUES ($1,1)`, [receiptOnlyOwner.participantId]);
  await pool.query(`INSERT INTO ${currentInput}(participant_id,revision) VALUES ($1,1),($2,1),($3,1)
    ON CONFLICT (participant_id) DO UPDATE SET revision=EXCLUDED.revision`,
  [receiptOnlyOwner.participantId, eventWithoutHeadOwner.participantId, fullyAppliedOwner.participantId]);
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "3",
    "an older exact D1 tuple cannot acknowledge the current analytical revision");
  await assert.rejects(pool.query(`INSERT INTO ${table("storage_legacy_event_sources")} (
      event_digest,owner_digest,participant_id,input_revision,change_kind
    ) VALUES ($1,$2,$3,1,'source-updated')`,
  [digest(`${receiptOnlyOwner.participantId}-wrong-owner`), digest("another-owner"), receiptOnlyOwner.participantId]),
  error => error?.code === "P1005" && error?.message === "telemetry_source_membership_invalid");

  const receiptOnlyDigest = digest(`${receiptOnlyOwner.participantId}-receipt-without-event`);
  const unrelatedDigest = digest(`${receiptOnlyOwner.participantId}-unrelated-event`);
  await pool.query(`SELECT ${table("storage_journal_append")}('owner-active',$1,$2,$2,$2)`,
    [receiptOnlyOwner.ownerDigest, unrelatedDigest]);
  await pool.query(`INSERT INTO ${table("storage_legacy_event_sources")} (
      event_digest,owner_digest,participant_id,input_revision,change_kind
    ) VALUES ($1,$2,$3,1,'source-updated')`,
  [receiptOnlyDigest, receiptOnlyOwner.ownerDigest, receiptOnlyOwner.participantId]);
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "3",
    "a receipt cannot match an unrelated exact journal event or its active owner head");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table("storage_ingestion_changes")}
    WHERE event_digest=$1 AND event_tuple_version=1`, [receiptOnlyDigest])).rows[0].n, 0,
  "the receipt has no exact matching journal event");

  const unappliedDigest = digest(`${eventWithoutHeadOwner.participantId}-event-without-head`);
  await insertExactEventWithoutAppliedHead(pool, table, eventWithoutHeadOwner.ownerDigest, unappliedDigest);
  await pool.query(`INSERT INTO ${table("storage_legacy_event_sources")} (
      event_digest,owner_digest,participant_id,input_revision,change_kind
    ) VALUES ($1,$2,$3,1,'owner-active')`,
  [unappliedDigest, eventWithoutHeadOwner.ownerDigest, eventWithoutHeadOwner.participantId]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table("storage_owner_revisions")}
    WHERE owner_digest=$1`, [eventWithoutHeadOwner.ownerDigest])).rows[0].n, 0,
  "the synthetic exact event has no applied owner-revision head");
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "3",
    "an exact journal event without its applied owner head remains pending");

  const appliedDigest = digest(`${fullyAppliedOwner.participantId}-applied-event`);
  await pool.query(`SELECT ${table("storage_journal_append")}('owner-active',$1,$2,$2,$2)`,
    [fullyAppliedOwner.ownerDigest, appliedDigest]);
  const appliedHead = await pool.query(`SELECT change.event_tuple_version,change.kind,change.revision::int AS revision,
      change.sequence::int AS sequence,head.last_sequence::int AS last_sequence,head.state
    FROM ${table("storage_ingestion_changes")} change
    JOIN ${table("storage_owner_revisions")} head
      ON head.source_id=change.source_id AND head.owner_digest=change.owner_digest
    WHERE change.event_digest=$1 AND change.owner_digest=$2`, [appliedDigest, fullyAppliedOwner.ownerDigest]);
  assert.deepEqual(appliedHead.rows, [{ event_tuple_version: 1, kind: "owner-active", revision: 1,
    sequence: 3, last_sequence: 3, state: "active" }],
  "the exact journal event advances the matching active owner head");
  await pool.query(`INSERT INTO ${table("storage_legacy_event_sources")} (
      event_digest,owner_digest,participant_id,input_revision,change_kind
    ) VALUES ($1,$2,$3,1,'owner-active')`,
  [appliedDigest, fullyAppliedOwner.ownerDigest, fullyAppliedOwner.participantId]);
  const laterDigest = digest(`${fullyAppliedOwner.participantId}-later-source-event`);
  await pool.query(`SELECT ${table("storage_journal_append")}('source-updated',$1,$2,$2,$2)`,
    [fullyAppliedOwner.ownerDigest, laterDigest]);
  assert.deepEqual((await pool.query(`SELECT revision::int AS revision,last_sequence::int AS last_sequence,state
    FROM ${table("storage_owner_revisions")} WHERE owner_digest=$1`, [fullyAppliedOwner.ownerDigest])).rows,
  [{ revision: 2, last_sequence: 4, state: "active" }],
  "a later event advances the applied owner head beyond the receipt's exact event");
  assert.equal((await pool.query(`SELECT community_public_source_bootstrap_pending() AS pending`)).rows[0].pending, "2",
    "the current receipt remains covered by its exact event after the same-owner head advances");
  assert.deepEqual((await pool.query(`SELECT * FROM ${table("community_public_source_bootstrap_advance")}()`)).rows,
    [{ completed: 0, pending: "2" }],
  "bootstrap stays incomplete while the receipt-only and unapplied-event cases remain pending");
  assert.deepEqual((await pool.query(`SELECT completed FROM ${table("community_public_source_bootstrap")}
    WHERE singleton=1`)).rows, [{ completed: 0 }]);

  await assert.rejects(pool.query(`UPDATE ${table("storage_legacy_event_sources")} SET change_kind='owner-active'
    WHERE participant_id=$1`, [receiptOnlyOwner.participantId]), error => error?.code === "P1005"
      && error?.message === "storage_legacy_event_immutable");
  await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
    [receiptOnlyOwner.participantId]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table("storage_owner_erasure_receipts")}
    WHERE owner_digest=$1`, [receiptOnlyOwner.ownerDigest])).rows[0].n, 1,
  "the older PG erasure receipt exists after the link reaches erased state");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table("storage_owner_revisions")}
    WHERE owner_digest=$1 AND state='erased'`, [receiptOnlyOwner.ownerDigest])).rows[0].n, 0,
  "the fixture has no journal-proven owner-erased head");
  await assert.rejects(pool.query(`DELETE FROM ${table("storage_legacy_event_sources")} WHERE participant_id=$1`,
    [receiptOnlyOwner.participantId]), error => error?.code === "P1005"
      && error?.message === "storage_legacy_terminal_required");
  await assert.rejects(pool.query(`TRUNCATE ${table("storage_legacy_event_sources")}`),
    error => error?.code === "P1005" && error?.message === "storage_legacy_event_immutable");
}));
