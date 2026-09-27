import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

/*
 * ISO-1 no-go evidence for 0057. The reviewed offline PostgreSQL eraser is
 * exercised against the full 0047-0055 staged chain and 0058. It writes the
 * existing 0029 owner receipt and 0032 publication invalidation, then fails
 * closed because the 0053 owner-digest fence and receipt tables are outside
 * the retirement inventory. The test pins that the 0053 terminal watermark,
 * publication floor, and already-published row therefore remain unchanged.
 * Until an owned erasure path handles those relations and hides that row,
 * 0057 must remain out of the staged primary chain.
 *
 * This spec intentionally does not apply a 0057 candidate or call participant
 * DELETE directly. It uses only a synthetic social owner with no stored object.
 */

const ENDPOINT = await postgresTestEndpoint();
const SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) for PostgreSQL 17"
  : false;
const PG_TEST_PASSWORD = ENDPOINT?.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY = Object.freeze([
  "0047_host_diagnostic_errors.sql",
  "0048_rate_limit_buckets_unlogged.sql",
  "0049_lifecycle_readiness_state.sql",
  "0050_admin_audit_and_collection_controls.sql",
  "0051_transport_floor_parity.sql",
  "0052_typed_telemetry_live_allocators.sql",
  "0053_community_publication_authority.sql",
  "0054_signin_handoff_claim_shape.sql",
  "0055_v12_owner_bridge.sql",
  "0058_owner_journal_emitter_head_precheck.sql",
]);
const SOURCE_ID = "canonical-v1-primary";
const SOURCE_NAMESPACE = "synthetic-owner-erasure-no-go";
const PUBLIC_EPOCH = 4;
const FIXED_TIME = "2026-09-27T12:00:00.000Z";

const digest = value => createHash("sha256").update(String(value)).digest("hex");

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

async function count(pool, schema, table, where, values = []) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, table)} WHERE ${where}`, values);
  return result.rows[0].count;
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
    sequence: 0,
  };
}

async function insertPublishedDaily(pool, schema, revision) {
  const payload = JSON.stringify({ schemaVersion: "community-daily-aggregate-v1.0", day: "2026-09-20", revision });
  const deviceMethod = "contributing-devices-by-reader-v1";
  const authorityJson = JSON.stringify({ ...authority(PUBLIC_EPOCH), dailyDeviceMethod: deviceMethod });
  await pool.query(`INSERT INTO ${q(schema, "community_daily_aggregates")} (
      source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,
      source_cursor_sequence,policy_revision,collection_revision,release_state,released_at,
      public_authority_epoch,source_mutation_epoch,journal_sequence,graph_invalidation_epoch,
      cohort_digest,provenance,import_receipt_id,released_at_iso,authority_json,daily_device_method
    ) VALUES ($1,$2,'2026-09-20'::date,$3,$4,$5,$6,0,1,2,'published',$7::timestamptz,
      $6,4,0,3,$8,'gcp',NULL,$11::text,$9,$10)`,
  [SOURCE_ID, SOURCE_NAMESPACE, revision, payload, digest(payload), PUBLIC_EPOCH, FIXED_TIME,
    digest(`synthetic-cohort-${revision}`), authorityJson, deviceMethod, FIXED_TIME]);
}

async function withHarness(run) {
  assert.ok(ENDPOINT, "the no-go fixture requires an explicit local PostgreSQL endpoint");
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `wave1_0057_nogo_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    ...ENDPOINT,
    password: PG_TEST_PASSWORD,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 5_000,
    application_name: "wave1-0057-owner-erasure-no-go-pg17-test",
  };
  const primaryPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  let vite;
  try {
    const server = await primaryPool.query(`SELECT current_setting('server_version_num')::integer AS version,
      inet_server_addr() IS NULL AS unix_socket`);
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the erasure evidence is qualified on PostgreSQL 17");
    if (process.env.PG_TEST_SOCKET) assert.equal(server.rows[0].unix_socket, true,
      "the assigned qualification uses the private Unix socket");

    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    const primaryApplied = await applyStockAndStagedMigrations({
      role: "primary", schema: primarySchema, pool: primaryPool, stagedFiles: PRIMARY,
    });
    assert.deepEqual([...primaryApplied.promoted, ...primaryApplied.staged.map(migration => migration.name)].sort(),
      [...PRIMARY].sort(), "the fixture uses the complete 0047-0055 chain plus 0058, with no 0057");
    const ledgerApplied = await applyStockAndStagedMigrations({
      role: "ledger", schema: ledgerSchema, pool: ledgerPool, stagedFiles: [],
    });
    assert.equal(ledgerApplied.staged.length, 0);

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const eraser = await vite.ssrLoadModule("/src/postgres-social-owner-erasure.ts");
    await run({ primaryPool, ledgerPool, primarySchema, ledgerSchema, eraser });
  } finally {
    if (vite) await vite.close();
    await primaryPool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`).catch(() => {});
    await primaryPool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`).catch(() => {});
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
}

test("NO-GO evidence: guarded social erasure fails closed before 0053's fence and publication floor", {
  skip: SKIP,
  timeout: 180_000,
}, async () => withHarness(async ({ primaryPool, ledgerPool, primarySchema, ledgerSchema, eraser }) => {
  const participantId = `participant:${randomUUID()}`;
  const ownerDigest = digest(`synthetic-owner-${participantId}`);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "participants")} (
      id,owner_kind,state,consent_version,consented_at,created_at
    ) VALUES ($1,'social','active','ongoing-privacy-safe-telemetry-v0.1',$2,$2)`, [participantId, FIXED_TIME]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "storage_v11_owner_links")} (
      participant_id,owner_digest,state
    ) VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "storage_source_state")} (
      singleton,source_id,authority_epoch
    ) VALUES (1,$1,$2)`, [SOURCE_ID, PUBLIC_EPOCH]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "analytics_source_cursors")} (
      source_id,sequence,authority_epoch
    ) VALUES ($1,0,$2)`, [SOURCE_ID, PUBLIC_EPOCH]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "analytics_owner_state")} (
      source_id,owner_digest,revision,authority_epoch,state
    ) VALUES ($1,$2,1,$3,'active')`, [SOURCE_ID, ownerDigest, PUBLIC_EPOCH]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "analytics_publication_owner_members")} (
      source_id,day,metric,generation,owner_digest
    ) VALUES ($1,'2026-09-20','daily','synthetic-generation',$2)`, [SOURCE_ID, ownerDigest]);
  await primaryPool.query(`INSERT INTO ${q(primarySchema, "analytics_publications")} (
      source_id,day,metric,generation,cohort_digest,authority_json,payload_json,payload_sha256,
      computed_at_ms,policy_revision,collection_revision
    ) VALUES ($1,'2026-09-20','daily','synthetic-generation',$2,'{}','{}',$3,0,1,2)`,
  [SOURCE_ID, digest("synthetic-public-cohort"), digest("{}")]);

  const floor = async () => (await primaryPool.query(
    `SELECT ${q(primarySchema, "community_publication_erasure_floor")}($1)::text AS floor`, [SOURCE_ID],
  )).rows[0].floor;
  assert.equal(await floor(), String(PUBLIC_EPOCH), "the source cursor establishes the initial floor");
  await insertPublishedDaily(primaryPool, primarySchema, 1);

  const result = await eraser.erasePostgresSocialOwner({
    primaryPool,
    ledgerPool,
    objectStore: { async deleteBatch(refs) { assert.deepEqual(refs, []); } },
    participantId,
    schema: { primarySchema, ledgerSchema },
  });
  assert.deepEqual(result, {
    status: "incomplete",
    code: "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED",
  }, "retirement refuses the unowned 0053 owner-digest relations");
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1", [participantId]), 0,
    "the guarded eraser deletes the synthetic participant before analytics retirement fails");
  assert.equal(await count(primaryPool, primarySchema, "storage_v11_owner_links", "owner_digest=$1", [ownerDigest]), 0,
    "the guarded eraser removes the participant's owner link");
  assert.equal(await count(primaryPool, primarySchema, "storage_owner_erasure_receipts", "owner_digest=$1", [ownerDigest]), 1,
    "the existing 0029 owner-erasure receipt is written");
  assert.equal(await count(primaryPool, primarySchema, "analytics_publication_invalidations",
    "source_id=$1 AND owner_digest=$2 AND reason='owner-erased'", [SOURCE_ID, ownerDigest]), 1,
  "the existing 0032 invalidation is written");

  assert.equal(await count(primaryPool, primarySchema, "analytics_storage_erasure_fences", "source_id=$1", [SOURCE_ID]), 0,
    "the offline eraser does not write 0053's source erasure fence");
  assert.equal(await count(primaryPool, primarySchema, "analytics_storage_erasure_receipts", "source_id=$1", [SOURCE_ID]), 0,
    "the offline eraser does not write 0053's fence payload receipt");
  assert.deepEqual((await primaryPool.query(`SELECT state FROM ${q(primarySchema, "analytics_owner_state")}
    WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, ownerDigest])).rows,
  [{ state: "active" }],
  "the existing analytics owner state remains active when the closed inventory refuses retirement");
  assert.deepEqual((await primaryPool.query(`SELECT terminal_public_authority_epoch,terminal_sequence
    FROM ${q(primarySchema, "community_terminal_watermarks")} WHERE source_id=$1`, [SOURCE_ID])).rows,
  [{ terminal_public_authority_epoch: "0", terminal_sequence: "0" }],
  "without a fence, 0053's terminal watermark does not advance");
  assert.equal(await floor(), String(PUBLIC_EPOCH), "the 0053 publication floor remains at the pre-erasure source cursor");
  assert.deepEqual((await primaryPool.query(`SELECT release_state FROM ${q(primarySchema, "community_daily_aggregates")}
    WHERE source_id=$1 AND day='2026-09-20' AND revision=1`, [SOURCE_ID])).rows,
  [{ release_state: "published" }],
  "the already published 0053 daily row is not hidden by a terminal event or erasure fence");
}));
