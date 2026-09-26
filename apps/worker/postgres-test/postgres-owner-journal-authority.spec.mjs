import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "../scripts/postgres-ingestion-journal-transfer.mjs";

/*
 * PostgreSQL 17 qualification for the staged owner-journal authority
 * (postgres/staged-migrations/primary/0046_owner_journal_authority.sql).
 * Until the staged-migration harness exists, each schema receives the stock
 * primary migrations and then the staged file in one transaction under the
 * migration runner's search path. Every row is synthetic and content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_0046 = join(WORKER_ROOT, "postgres", "staged-migrations", "primary", "0046_owner_journal_authority.sql");
const ORACLE = join(WORKER_ROOT, "postgres-test", "fixtures", "community-public-source-owners-oracle.json");
const SOURCE_ID = "synthetic-owner-journal-source";
const TRANSFER_ROLE = "tibotattle_source_transfer";
const CONSTANT_MESSAGE = /^[a-z][a-z0-9_]{2,80}$/u;

const digest = (seed) => createHash("sha256").update(String(seed)).digest("hex");

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "owner-journal tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

let sharedPool;
let sharedVite;
const loadedModules = new Map();

async function connection() {
  if (!sharedPool) {
    const local = await endpoint();
    sharedPool = new pg.Pool({
      ...local, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
      ssl: false, max: 12, connectionTimeoutMillis: 5_000, application_name: "pg-owner-journal-authority-test",
    });
    const version = await sharedPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "owner-journal authority is qualified on PostgreSQL 17");
  }
  return sharedPool;
}

async function workerModule(path) {
  if (!sharedVite) {
    sharedVite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
  }
  if (!loadedModules.has(path)) loadedModules.set(path, await sharedVite.ssrLoadModule(path));
  return loadedModules.get(path);
}

after(async () => {
  if (sharedVite) await sharedVite.close();
  if (sharedPool) await sharedPool.end();
});

async function applyStaged(pool, schema) {
  const sql = await readFile(STAGED_0046, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Run `body` against a fresh schema at primary 0045, plus 0046 unless told not to. */
async function withSchema(body, { staged = true, prefix = "owner_journal_" } = {}) {
  const pool = await connection();
  const schema = `${prefix}${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted}."${name}"`;
  };
  await pool.query(`CREATE SCHEMA ${quoted}`);
  try {
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.migrations.at(-1)?.name, "0045_accountless_v12_history_retention.sql",
      "the staged authority applies directly after the stock primary head");
    if (staged) await applyStaged(pool, schema);
    await body({ pool, schema, quoted, table });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  }
}

/** Assert a constant P1005 refusal and return nothing that could carry values. */
async function refuses(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, "P1005", `expected P1005 for ${message}, got ${error?.code} ${error?.message}`);
    assert.equal(error.message, message);
    assert.match(error.message, CONSTANT_MESSAGE);
    assert.equal(error.detail, undefined, "constant refusals carry no detail");
    return true;
  });
}

async function initializeSource(pool, table, epoch = 5) {
  await pool.query(`INSERT INTO ${table("storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,$2)`,
    [SOURCE_ID, epoch]);
}

async function heads(pool, table) {
  const result = await pool.query(`SELECT owner_digest,revision::int AS revision,authority_epoch::int AS epoch,state,
      last_sequence::int AS last_sequence,object_digest,content_digest,seeded_partial
    FROM ${table("storage_owner_revisions")} ORDER BY owner_digest`);
  return result.rows;
}

async function journal(pool, table) {
  const result = await pool.query(`SELECT sequence::int AS sequence,event_digest,owner_digest,owner_revision::int AS owner_revision,
      authority_epoch::int AS epoch,kind,event_tuple_version AS version,revision::int AS revision,object_digest,content_digest,
      public_authority_epoch::int AS public_epoch,recorded_ms::text AS recorded_ms
    FROM ${table("storage_ingestion_changes")} ORDER BY sequence`);
  return result.rows;
}

async function sourceEpoch(pool, table) {
  const result = await pool.query(`SELECT authority_epoch::int AS epoch FROM ${table("storage_source_state")} WHERE singleton=1`);
  return result.rows[0]?.epoch;
}

async function rawExact(pool, table, row) {
  await pool.query(`INSERT INTO ${table("storage_ingestion_changes")} (
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
      event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
    ) VALUES ($1,$2,$3,$4,0,$5,$6,$7,1,$8,$9,$10,$11)`,
  [row.sourceId ?? SOURCE_ID, row.sequence, row.eventDigest ?? digest(`event-${row.sequence}-${row.owner}`), row.owner,
    row.epoch, row.kind, 1_790_000_000_000 + row.sequence, row.revision,
    digest(`object-${row.sequence}`), digest(`content-${row.sequence}`), row.publicEpoch]);
}

async function rawLegacy(pool, table, { sequence, owner, eventDigest }) {
  await pool.query(`INSERT INTO ${table("storage_ingestion_changes")} (
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
    ) VALUES ($1,$2,$3,$4,1,1,'source-updated',1)`, [SOURCE_ID, sequence, eventDigest ?? digest(`legacy-${sequence}`), owner]);
}

// ---------------------------------------------------------------------------
// Oracle participants: the D1 oracle's abstract inputs, built as PostgreSQL
// rows. A retained case first installs its eligible active graph so the 0041
// and 0045 marker guards admit the marker, then revokes to the final state.

async function insertOracleParticipant(pool, table, participant) {
  await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,$2,$3,$4)`,
    [participant.id, participant.ownerKind, participant.state, "2026-09-01T00:00:00.000Z"]);
  const graph = participant.accountless;
  if (!graph) return;
  const lease = (final) => (graph.marker ? { ...final, state: "active", revokedAt: null, revocationReason: null } : final);
  const ledger = lease(graph.ledger);
  const owner = lease(graph.owner);
  const device = lease({ ...graph.device, revocationReason: null });
  const secret = Buffer.from(graph.secretHash, "hex");
  await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")} (
      device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
      state,issued_at,expires_at,revoked_at,revocation_reason,renewal_generation,renewed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [graph.deviceId, secret, `oracle-installation-${graph.deviceId}`, graph.ledger.schemaVersion,
    graph.ledger.policyVersion, graph.ledger.authorizationBasis, ledger.state, ledger.issuedAt, ledger.expiresAt,
    ledger.revokedAt, ledger.revocationReason, graph.ledger.renewalGeneration, graph.ledger.renewedAt]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,
      issued_at,expires_at,last_used_at,revoked_at,social_verified_at
    ) VALUES ($1,$2,'accountless',$1,$3,$4,$5,$6,$5,$7,$8)`,
  [graph.deviceId, participant.id, secret, device.state, device.issuedAt, device.expiresAt, device.revokedAt,
    graph.device.socialVerifiedAt]);
  await pool.query(`INSERT INTO ${table("accountless_upload_owners")} (
      enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
      authorized_at,expires_at,state,revoked_at,revocation_reason
    ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,$5,$6,$7)`,
  [graph.deviceId, participant.id, owner.issuedAt, owner.expiresAt, owner.state, owner.revokedAt, owner.revocationReason]);
  for (const [name, grant] of [["accountless_v11_device_authorizations", graph.v11Grant],
    ["accountless_v12_device_authorizations", graph.v12Grant]]) {
    if (!grant) continue;
    const initial = lease(grant);
    const v11 = name === "accountless_v11_device_authorizations";
    await pool.query(`INSERT INTO ${table(name)} (
        enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,
        privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason
      ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [graph.deviceId, participant.id,
      v11 ? "telemetry-contribution-v1.1" : "telemetry-contribution-v1.2",
      v11 ? "telemetry-v1.1-registry-2026-08-31.1" : "telemetry-v1.2-registry-2026-09-20.1",
      v11 ? "ongoing-privacy-safe-telemetry-v1.1" : "ongoing-privacy-safe-telemetry-v1.2",
      initial.issuedAt, initial.expiresAt, initial.state, initial.revokedAt, initial.revocationReason]);
  }
  for (const [version, domain] of [["v11", graph.v11Domain], ["v12", graph.v12Domain]]) {
    if (!domain) continue;
    const token = digest(`token-${version}-${domain.generationId}`);
    const fingerprint = digest(`legacy-${version}-${domain.generationId}`);
    await pool.query(`INSERT INTO ${table(`telemetry_${version}_domain_predecessors`)} (
        token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
        from_day,through_day,winners_json,created_at,expires_at
      ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'[]',$6,$7)`,
    [token, participant.id, graph.deviceId, fingerprint, "2026-09-20", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    await pool.query(`INSERT INTO ${table(`telemetry_${version}_domains`)} (
        id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
        input_revision,from_day,through_day,days_json,created_at
      ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,'[]',$8)`,
    [domain.generationId, participant.id, graph.deviceId, token, digest(`manifest-${version}-${domain.generationId}`),
      fingerprint, "2026-09-20", "2026-09-01T00:00:00.000Z"]);
    if (domain.head) {
      await pool.query(`INSERT INTO ${table(`telemetry_${version}_domain_heads`)} (participant_id,generation_id,revision,updated_at)
        VALUES ($1,$2,1,$3)`, [participant.id, domain.generationId, "2026-09-01T00:00:00.000Z"]);
    }
  }
  if (!graph.marker) return;
  const generation = graph.marker.lineage === "v1.1" ? graph.v11Domain : graph.v12Domain;
  await pool.query(`INSERT INTO ${table("accountless_public_history_retention")} (
      participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
    ) VALUES ($1,$2,$2,$3,1,$4)`, [participant.id, graph.deviceId, generation.generationId, graph.marker.retainedAt]);
  const revoke = async (name, key, final, reason = true) => {
    await pool.query(`UPDATE ${table(name)} SET state=$2,revoked_at=$3${reason ? ",revocation_reason=$4" : ""}
      WHERE ${key}=$1`, reason ? [graph.deviceId, final.state, final.revokedAt, final.revocationReason]
      : [graph.deviceId, final.state, final.revokedAt]);
  };
  await revoke("accountless_enrollment_ledger", "device_id", graph.ledger);
  await revoke("accountless_upload_owners", "enrollment_device_id", graph.owner);
  await revoke("device_credentials", "id", graph.device, false);
  if (graph.v11Grant) await revoke("accountless_v11_device_authorizations", "enrollment_device_id", graph.v11Grant);
  if (graph.v12Grant) await revoke("accountless_v12_device_authorizations", "enrollment_device_id", graph.v12Grant);
}

function sortRows(rows) {
  const key = (row) => `${row.participant_id}\u0000${row.owner_kind}\u0000${row.device_id ?? ""}`;
  return [...rows].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

test("PG17 community_public_source_owners equals the D1 oracle in all twelve cases", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, table }) => {
    const oracle = JSON.parse(await readFile(ORACLE, "utf8"));
    assert.equal(oracle.schemaVersion, "community-public-source-owners-oracle-v1");
    assert.equal(oracle.cases.length, 12);
    for (const oracleCase of oracle.cases) {
      for (const participant of oracleCase.participants) await insertOracleParticipant(pool, table, participant);
    }
    const view = await pool.query(`SELECT participant_id,owner_kind,device_id FROM ${table("community_public_source_owners")}`);
    const all = view.rows.filter((row) => row.participant_id.startsWith("oracle-"));
    let matched = 0;
    for (const oracleCase of oracle.cases) {
      const ids = new Set(oracleCase.participants.map((participant) => participant.id));
      const actual = sortRows(all.filter((row) => ids.has(row.participant_id)));
      assert.deepEqual(actual, oracleCase.rows, `case ${oracleCase.name} matches D1 row for row`);
      matched += actual.length;
    }
    assert.equal(matched, all.length, "the view returns no row outside the oracle cases");
    assert.equal(all.length, oracle.cases.reduce((total, oracleCase) => total + oracleCase.rows.length, 0));
  }));

// ---------------------------------------------------------------------------

test("PG17 storage_journal_append follows every D1 journal rule with constant codes", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { appendPostgresOwnerJournal, PostgresOwnerJournalError, OWNER_JOURNAL_KINDS } =
      await workerModule("/src/postgres-owner-journal.ts");
    assert.deepEqual([...OWNER_JOURNAL_KINDS], ["source-updated", "owner-active", "owner-withdrawn", "owner-erased"]);
    const client = await pool.connect();
    const ownerA = digest("owner-a");
    const ownerB = digest("owner-b");
    const unknown = digest("owner-unknown");
    let event = 0;
    const accepted = [];
    const append = async (kind, ownerDigest) => {
      event += 1;
      const n = event;
      const result = await appendPostgresOwnerJournal(client, schema, {
        kind, ownerDigest, eventDigest: digest(`event-${n}`), objectDigest: digest(`object-${n}`),
        contentDigest: digest(`content-${n}`),
      });
      accepted.push(n);
      return result;
    };
    const raw = (kind, ownerDigest, eventDigest = digest(`raw-${randomUUID()}`), objectDigest = digest("o")) =>
      pool.query(`SELECT ${quoted}.storage_journal_append($1,$2,$3,$4,$5)`,
        [kind, ownerDigest, eventDigest, objectDigest, digest("c")]);
    try {
      await refuses(raw("owner-active", ownerA), "storage_source_uninitialized");
      await initializeSource(pool, table, 5);

      const startedMs = Date.now();
      assert.deepEqual(await append("owner-active", ownerA), { sequence: 1 });
      assert.equal(await sourceEpoch(pool, table), 6, "a non-source-updated append advances the source epoch");
      assert.deepEqual(await append("source-updated", ownerA), { sequence: 2 });
      assert.equal(await sourceEpoch(pool, table), 6, "source-updated keeps both epochs");
      assert.deepEqual(await append("owner-active", ownerB), { sequence: 3 });

      await assert.rejects(append("owner-withdrawn", unknown), (error) =>
        error instanceof PostgresOwnerJournalError && error.code === "OWNER_JOURNAL_OWNER_UNINITIALIZED");
      await refuses(raw("owner-withdrawn", unknown), "storage_owner_uninitialized");
      await refuses(raw("owner-erased", unknown), "storage_owner_uninitialized");
      // D1 checks eligibility before initialization, so an unknown owner's
      // source-updated is ineligible.
      await refuses(raw("source-updated", unknown), "storage_owner_ineligible");

      assert.deepEqual(await append("owner-withdrawn", ownerB), { sequence: 4 });
      await assert.rejects(append("source-updated", ownerB), (error) =>
        error instanceof PostgresOwnerJournalError && error.code === "OWNER_JOURNAL_OWNER_INELIGIBLE");
      await refuses(raw("source-updated", ownerB), "storage_owner_ineligible");
      assert.deepEqual(await append("owner-active", ownerB), { sequence: 5 }, "a withdrawn owner re-activates");
      assert.deepEqual(await append("owner-erased", ownerA), { sequence: 6 });
      for (const kind of OWNER_JOURNAL_KINDS) {
        await refuses(raw(kind, ownerA), "storage_owner_erased");
      }
      await assert.rejects(append("owner-active", ownerA), (error) =>
        error instanceof PostgresOwnerJournalError && error.code === "OWNER_JOURNAL_OWNER_ERASED");
      await refuses(raw("owner-active", ownerB, digest(`event-${accepted[2]}`)), "storage_journal_event_conflict");
      await refuses(raw("owner-archived", ownerB), "storage_journal_kind_invalid");
      await refuses(raw("owner-active", "A".repeat(64)), "storage_journal_digest_invalid");
      await refuses(raw("owner-active", ownerB, "short"), "storage_journal_digest_invalid");
      await refuses(raw("owner-active", ownerB, digest("fresh"), null), "storage_journal_digest_invalid");
      await assert.rejects(appendPostgresOwnerJournal(client, schema, {
        kind: "owner-archived", ownerDigest: ownerB, eventDigest: digest("x"), objectDigest: digest("y"), contentDigest: digest("z"),
      }), (error) => error instanceof PostgresOwnerJournalError && error.code === "OWNER_JOURNAL_INPUT_INVALID");

      const rows = await journal(pool, table);
      assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4, 5, 6], "sequences are contiguous");
      assert.deepEqual(rows.map(({ owner_digest, kind, revision, owner_revision, epoch, public_epoch, version }) =>
        [owner_digest === ownerA ? "a" : "b", kind, revision, owner_revision, epoch, public_epoch, version]), [
        ["a", "owner-active", 1, 1, 1, 6, 1],
        ["a", "source-updated", 2, 2, 1, 6, 1],
        ["b", "owner-active", 1, 1, 1, 7, 1],
        ["b", "owner-withdrawn", 2, 2, 2, 8, 1],
        ["b", "owner-active", 3, 3, 3, 9, 1],
        ["a", "owner-erased", 3, 3, 2, 10, 1],
      ]);
      assert.ok(rows.every((row) => Number(row.recorded_ms) >= startedMs - 5_000 && Number(row.recorded_ms) <= Date.now() + 5_000),
        "recorded_ms is the database clock in milliseconds");
      assert.deepEqual(rows.map((row) => [row.event_digest, row.object_digest, row.content_digest]),
        accepted.map((n) => [digest(`event-${n}`), digest(`object-${n}`), digest(`content-${n}`)]),
        "the caller's event, object and content digests are journaled exactly");
      assert.equal(await sourceEpoch(pool, table), 10);
      assert.deepEqual((await heads(pool, table)).map(({ owner_digest, revision, epoch, state, last_sequence, seeded_partial }) =>
        [owner_digest === ownerA ? "a" : "b", revision, epoch, state, last_sequence, seeded_partial]).sort(), [
        ["a", 3, 2, "erased", 6, false],
        ["b", 3, 3, "active", 5, false],
      ]);
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------------------

test("PG17 derivation trigger refuses discontinuous raw rows and seeds partial heads", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, table }) => {
    await initializeSource(pool, table, 2);
    const owner = digest("raw-owner");
    const erasedFirst = digest("raw-erased-first");

    // The analytics-retirement fixture shape: a first raw row that is already
    // terminal seeds an erased head flagged partial.
    await rawExact(pool, table, { sequence: 1, owner: erasedFirst, kind: "owner-erased", revision: 1, epoch: 2, publicEpoch: 2 });
    const [seeded] = await heads(pool, table);
    assert.deepEqual({ ...seeded, object_digest: undefined, content_digest: undefined }, {
      owner_digest: erasedFirst, revision: 1, epoch: 2, state: "erased", last_sequence: 1,
      object_digest: undefined, content_digest: undefined, seeded_partial: true,
    });
    await refuses(rawExact(pool, table, { sequence: 2, owner: erasedFirst, kind: "owner-active", revision: 2, epoch: 3, publicEpoch: 3 }),
      "storage_owner_erased");

    await rawExact(pool, table, { sequence: 2, owner, kind: "owner-active", revision: 1, epoch: 1, publicEpoch: 3 });
    assert.equal(await sourceEpoch(pool, table), 3, "a raw row raises the source epoch with GREATEST");
    await refuses(rawExact(pool, table, { sequence: 3, owner, kind: "source-updated", revision: 3, epoch: 1, publicEpoch: 3 }),
      "storage_owner_revision_conflict");
    await refuses(rawExact(pool, table, { sequence: 3, owner, kind: "owner-withdrawn", revision: 2, epoch: 1, publicEpoch: 4 }),
      "storage_authority_conflict");
    await refuses(rawExact(pool, table, { sequence: 3, owner, kind: "source-updated", revision: 2, epoch: 2, publicEpoch: 3 }),
      "storage_authority_conflict");
    await refuses(rawExact(pool, table, { sequence: 3, owner, kind: "source-updated", revision: 2, epoch: 1, publicEpoch: 2 }),
      "storage_public_authority_regressed");
    await refuses(rawExact(pool, table, { sourceId: "synthetic-foreign-source", sequence: 3, owner, kind: "source-updated",
      revision: 2, epoch: 1, publicEpoch: 3 }), "storage_source_mismatch");
    await rawExact(pool, table, { sequence: 3, owner, kind: "owner-withdrawn", revision: 2, epoch: 2, publicEpoch: 4 });
    await refuses(rawExact(pool, table, { sequence: 4, owner, kind: "source-updated", revision: 3, epoch: 2, publicEpoch: 4 }),
      "storage_owner_ineligible");
    // A later exact row never carries a lower public epoch than the source's
    // previous exact row, whatever its owner.
    await refuses(rawExact(pool, table, { sequence: 1_000, owner: digest("gap-owner"), kind: "owner-active", revision: 1,
      epoch: 1, publicEpoch: 3 }), "storage_public_authority_regressed");

    // Mixing: a version-0 row for a headed owner, or one queued after an
    // exact row in the same statement, is refused.
    await refuses(rawLegacy(pool, table, { sequence: 10, owner }), "storage_owner_tuple_mixed");
    const mixedOwner = digest("mixed-owner");
    await refuses(pool.query(`INSERT INTO ${table("storage_ingestion_changes")} (
        source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
        event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
      ) VALUES ($1,4,$2,$3,0,1,'owner-active',1,1,1,$4,$4,5),
               ($1,5,$5,$3,1,1,'source-updated',1,0,NULL,NULL,NULL,NULL)`,
    [SOURCE_ID, digest("mixed-exact"), mixedOwner, digest("mixed-object"), digest("mixed-legacy")]), "storage_owner_tuple_mixed");
    await rawLegacy(pool, table, { sequence: 10, owner: digest("unheaded-owner") });
    // An owner's chain only moves forward in sequence.
    const lateOwner = digest("late-owner");
    await rawExact(pool, table, { sequence: 30, owner: lateOwner, kind: "owner-active", revision: 1, epoch: 1, publicEpoch: 4 });
    await refuses(rawExact(pool, table, { sequence: 25, owner: lateOwner, kind: "source-updated", revision: 2, epoch: 1,
      publicEpoch: 4 }), "storage_owner_revision_conflict");

    // Exact rows and heads are retained evidence.
    await refuses(pool.query(`UPDATE ${table("storage_ingestion_changes")} SET recorded_ms=0 WHERE sequence=2`),
      "storage_event_immutable");
    await refuses(pool.query(`DELETE FROM ${table("storage_ingestion_changes")} WHERE sequence=2`), "storage_event_retained");
    await pool.query(`DELETE FROM ${table("storage_ingestion_changes")} WHERE sequence=10`);
    await refuses(pool.query(`DELETE FROM ${table("storage_owner_revisions")} WHERE owner_digest=$1`, [owner]),
      "storage_owner_revision_retained");
    await refuses(pool.query(`TRUNCATE ${table("storage_owner_revisions")}`), "storage_owner_revision_retained");
    await refuses(pool.query(`UPDATE ${table("storage_owner_revisions")} SET state='active' WHERE owner_digest=$1`, [erasedFirst]),
      "storage_owner_revision_immutable");
    await refuses(pool.query(`UPDATE ${table("storage_owner_revisions")} SET revision=revision-1 WHERE owner_digest=$1`, [owner]),
      "storage_owner_revision_immutable");
    await refuses(pool.query(`UPDATE ${table("storage_owner_revisions")} SET seeded_partial=false WHERE owner_digest=$1`,
      [erasedFirst]), "storage_owner_revision_immutable");
    await refuses(pool.query(`UPDATE ${table("storage_owner_revisions")} SET revision=revision+1,last_sequence=last_sequence+1
      WHERE owner_digest=$1`, [owner]), "storage_owner_revision_unproven");
    await refuses(pool.query(`INSERT INTO ${table("storage_owner_revisions")} (
        source_id,owner_digest,revision,authority_epoch,state,last_sequence,object_digest,content_digest,seeded_partial
      ) VALUES ($1,$2,1,1,'active',2,$3,$3,false)`, [SOURCE_ID, digest("invented"), digest("object-2")]),
    "storage_owner_revision_unproven");
    assert.deepEqual((await heads(pool, table)).map((head) => [head.owner_digest, head.revision, head.state, head.seeded_partial]).sort(),
      [[erasedFirst, 1, "erased", true], [owner, 2, "withdrawn", false], [lateOwner, 1, "active", false]].sort());

    // Without a singleton source nothing exact can be derived.
    const unsourced = await pool.connect();
    try {
      await unsourced.query("BEGIN");
      await unsourced.query(`DELETE FROM ${table("storage_source_state")}`);
      await refuses(rawExact(unsourced, table, { sequence: 20, owner: digest("unsourced"), kind: "owner-active", revision: 1,
        epoch: 1, publicEpoch: 9 }), "storage_source_uninitialized");
    } finally {
      await unsourced.query("ROLLBACK");
      unsourced.release();
    }
  }));

// ---------------------------------------------------------------------------
// The sealed D1 journal fixture of postgres-ingestion-journal-transfer.spec.mjs:
// two owners with a source-updated interleaving, one withdrawn and one erased.

const TRANSFER_SOURCE_ID = "synthetic-ingestion-journal-source";
const TRANSFER_SCHEMA_PREFIX = "storage_journal_transfer_target_";
const TRANSFER_ROWS = [
  [1, "a", 1, "owner-active", 1, 1],
  [2, "a", 2, "source-updated", 1, 1],
  [3, "a", 3, "owner-withdrawn", 2, 2],
  [4, "b", 1, "owner-active", 1, 3],
  [5, "b", 2, "source-updated", 1, 3],
  [6, "b", 3, "owner-erased", 2, 4],
];
const transferDigest = (n) => BigInt(n).toString(16).padStart(64, "0");

async function makeSealedJournal() {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-owner-journal-pg17-"));
  const path = join(await realpath(directory), "journal.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE storage_source_state(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL UNIQUE,
        authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch>=0)
      ) STRICT;
      CREATE TABLE storage_ingestion_changes(
        sequence INTEGER PRIMARY KEY,event_digest TEXT NOT NULL UNIQUE,owner_digest TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        kind TEXT NOT NULL CHECK(kind IN('source-updated','owner-active','owner-withdrawn','owner-erased')),
        object_digest TEXT NOT NULL,content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
        public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch>0),
        recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0),UNIQUE(owner_digest,revision)
      ) STRICT;
      CREATE INDEX storage_ingestion_owner_cursor ON storage_ingestion_changes(owner_digest,sequence);
    `);
    database.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,4)").run(TRANSFER_SOURCE_ID);
    const insert = database.prepare(`INSERT INTO storage_ingestion_changes(
      sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const [sequence, owner, revision, kind, authorityEpoch, publicEpoch] of TRANSFER_ROWS) {
      insert.run(sequence, transferDigest(sequence), owner.repeat(64), revision, kind, transferDigest(sequence + 20),
        transferDigest(sequence + 40), authorityEpoch, publicEpoch, 1_790_000_000_000 + sequence);
    }
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const source = await createSealedSqliteIngestionJournalSource({
    path: await realpath(path), expectedSha256, expectedSourceId: TRANSFER_SOURCE_ID,
  });
  return { directory, source };
}

/** D1's final owner revision rows for the sealed fixture (typed-ingestion 0002:55-63). */
const D1_TRANSFER_HEADS = [
  { owner_digest: "a".repeat(64), revision: 3, epoch: 2, state: "withdrawn", last_sequence: 3,
    object_digest: transferDigest(23), content_digest: transferDigest(43), seeded_partial: false },
  { owner_digest: "b".repeat(64), revision: 3, epoch: 2, state: "erased", last_sequence: 6,
    object_digest: transferDigest(26), content_digest: transferDigest(46), seeded_partial: false },
];

test("PG17 journal transfer through 0046 derives the D1 heads, rolls back with a failed page, and continues live",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const fixture = await makeSealedJournal();
    const transferId = "synthetic-ingestion-journal-owner-authority";
    try {
      await pool.query(`ALTER TABLE ${table("storage_ingestion_changes")}
        ADD CONSTRAINT synthetic_transfer_interrupt CHECK(sequence < 3)`);
      await assert.rejects(transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 }), (error) => error?.code === "INGESTION_JOURNAL_PAGE_COMMIT_FAILED");
      assert.deepEqual((await heads(pool, table)).map((head) => [head.owner_digest, head.revision, head.state, head.last_sequence]),
        [["a".repeat(64), 2, "active", 2]], "the failed page rolled back with its heads");
      await pool.query(`ALTER TABLE ${table("storage_ingestion_changes")} DROP CONSTRAINT synthetic_transfer_interrupt`);
      const result = await transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      assert.equal(result.status, "synthetic_storage_ingestion_journal_transfer_complete");
      assert.equal(result.targetRows, "6");
      assert.deepEqual(await heads(pool, table), D1_TRANSFER_HEADS);
      assert.equal(await sourceEpoch(pool, table), 4, "the preset source epoch is unchanged");
      const replay = await transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      assert.equal(replay.status, "already_complete");

      // Live appends continue the imported chains.
      const appended = await pool.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$2,$3,$4)::int AS sequence`,
        ["a".repeat(64), digest("live-event"), digest("live-object"), digest("live-content")]);
      assert.equal(appended.rows[0].sequence, 7);
      const live = (await journal(pool, table)).at(-1);
      assert.deepEqual([live.revision, live.epoch, live.public_epoch, live.kind], [4, 3, 5, "owner-active"]);
      await refuses(pool.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$2,$3,$4)`,
        ["b".repeat(64), digest("erased-event"), digest("o"), digest("c")]), "storage_owner_erased");
    } finally {
      fixture.source.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, { prefix: TRANSFER_SCHEMA_PREFIX }));

// ---------------------------------------------------------------------------

test("PG17 0046 backfills heads from an imported journal and aborts on a tampered chain", { skip: SKIP, timeout: 240_000 },
  async () => {
    await withSchema(async ({ pool, schema, quoted, table }) => {
      const fixture = await makeSealedJournal();
      try {
        const result = await transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
          targetSchema: schema, transferId: "synthetic-ingestion-journal-owner-backfill", pageSize: 4 });
        assert.equal(result.targetRows, "6");
      } finally {
        fixture.source.close();
        await rm(fixture.directory, { recursive: true, force: true });
      }
      await applyStaged(pool, schema);
      assert.deepEqual(await heads(pool, table), D1_TRANSFER_HEADS, "backfilled heads equal the derived D1 state");
      assert.equal(await sourceEpoch(pool, table), 4);
      const appended = await pool.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$2,$3,$4)::int AS sequence`,
        ["a".repeat(64), digest("backfill-live"), digest("o"), digest("c")]);
      assert.equal(appended.rows[0].sequence, 7, "a later append continues at head+1 without a uniqueness conflict");
      assert.equal((await heads(pool, table))[0].revision, 4);
    }, { staged: false, prefix: TRANSFER_SCHEMA_PREFIX });

    await withSchema(async ({ pool, schema, table }) => {
      await pool.query(`INSERT INTO ${table("storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,1)`,
        [SOURCE_ID]);
      const owner = digest("tampered-owner");
      const tamperings = [
        ["revision gap", [["owner-active", 1, 1, 1], ["source-updated", 3, 1, 1]]],
        ["owner epoch", [["owner-active", 1, 1, 1], ["owner-withdrawn", 2, 1, 1]]],
        ["after erased", [["owner-erased", 1, 1, 1], ["owner-active", 2, 2, 2]]],
        ["updated while withdrawn", [["owner-active", 1, 1, 1], ["owner-withdrawn", 2, 2, 2], ["source-updated", 3, 2, 2]]],
        ["public epoch regression", [["owner-active", 1, 1, 2], ["source-updated", 2, 1, 1]]],
      ];
      for (const [label, chain] of tamperings) {
        for (const [index, [kind, revision, epoch, publicEpoch]] of chain.entries()) {
          await rawExact(pool, table, { sequence: index + 1, owner, kind, revision, epoch, publicEpoch });
        }
        await assert.rejects(applyStaged(pool, schema), (error) =>
          error?.code === "P1005" && error.message === "storage_owner_revision_backfill_invalid", label);
        const relations = await pool.query(`SELECT to_regclass($1) AS heads, to_regclass($2) AS view,
            (SELECT count(*)::int FROM pg_indexes WHERE schemaname=$3 AND indexname='storage_ingestion_owner_revision') AS indexes`,
        [`${schema}.storage_owner_revisions`, `${schema}.community_public_source_owners`, schema]);
        assert.deepEqual(relations.rows[0], { heads: null, view: null, indexes: 0 }, `${label} leaves the schema at 0045`);
        await pool.query(`DELETE FROM ${table("storage_ingestion_changes")}`);
      }
      // A foreign-source exact row is refused as well.
      await rawExact(pool, table, { sourceId: "synthetic-foreign-source", sequence: 1, owner, kind: "owner-active",
        revision: 1, epoch: 1, publicEpoch: 1 });
      await assert.rejects(applyStaged(pool, schema), (error) =>
        error?.code === "P1005" && error.message === "storage_owner_revision_backfill_invalid");
      await pool.query(`DELETE FROM ${table("storage_ingestion_changes")}`);
      const emitter = await pool.query(`SELECT prosrc FROM pg_proc JOIN pg_namespace ns ON ns.oid=pronamespace
        WHERE nspname=$1 AND proname='telemetry_emit_source_event'`, [schema]);
      assert.equal(emitter.rows[0].prosrc.includes("storage_owner_revisions"), false, "the 0014 emitter is untouched");
      await applyStaged(pool, schema);
    }, { staged: false });
  });

// ---------------------------------------------------------------------------
// Emitter parity. Two schemas run the same raw telemetry changes for the same
// participants: the 0045 baseline and 0046 with one owner already headed.

async function createSocialDevice(pool, table, participantId, deviceId) {
  const now = "2026-09-20T00:00:00.000Z";
  const expires = "2026-12-20T00:00:00.000Z";
  const sessionId = `${participantId}-session`;
  const pairingId = `${participantId}-pairing`;
  await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ($1,$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${table("web_sessions")} (id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
    VALUES ($1,$2,$3,$3,$4,$5,$4)`, [sessionId, participantId, Buffer.alloc(32, 1), now, expires]);
  await pool.query(`INSERT INTO ${table("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
      issued_at,expires_at,consumed_at,claimed_device_id
    ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`,
  [pairingId, participantId, sessionId, Buffer.alloc(32, 2), now, expires, deviceId]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [deviceId, participantId, pairingId, Buffer.alloc(32, 3), now, expires]);
}

async function v11Generation(pool, table, { participantId, deviceId, generationId, previous = null }) {
  const now = "2026-09-20T00:00:00.000Z";
  const token = digest(`token-${generationId}`);
  const manifestDigest = digest(`manifest-${generationId}`);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,from_day,through_day,
      winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,$5,0,'2026-09-20','2026-09-20','[]',$6,'2026-09-21T00:00:00.000Z')`,
  [token, participantId, deviceId, previous, digest(`legacy-${generationId}`), now]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,'2026-09-20','2026-09-20','[]',$8)`,
  [generationId, participantId, deviceId, token, previous, manifestDigest, digest(`legacy-${generationId}`), now]);
}

async function rawTelemetryChanges(pool, table, participantId, deviceId, index) {
  const now = "2026-09-20T00:00:00.000Z";
  const expires = "2026-12-20T00:00:00.000Z";
  await pool.query(`INSERT INTO ${table("telemetry_records")} (participant_id,record_kind,occurrence_id,observed_at,record_json)
    VALUES ($1,'usage','synthetic-occurrence',$2,'{}'::jsonb)`, [participantId, now]);
  await pool.query(`UPDATE ${table("telemetry_records")} SET record_json='{"synthetic":1}'::jsonb WHERE participant_id=$1`,
    [participantId]);
  await pool.query(`INSERT INTO ${table("telemetry_contributions")} (
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,range_start,range_end,client_platform,
      provider_policy_epoch,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,
      declared_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1',$6,$6,'synthetic','synthetic',100,0,0,'synthetic',0,$6)`,
  [`${participantId}-contribution`, participantId, digest(`plain-${index}`), digest(`envelope-${index}`),
    `synthetic/${participantId}/contribution`, now]);
  const uploadId = `${participantId}-upload`;
  const chunkId = `${participantId}-chunk`;
  await pool.query(`INSERT INTO ${table("device_upload_authorizations")} (
      id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consumed_at
    ) VALUES ($1,$2,$3,$4,$5,32,'application/json','consumed',$6,$7,$6)`,
  [uploadId, participantId, deviceId, Buffer.alloc(32, 4), digest(`chunk-envelope-${index}`), now, expires]);
  await pool.query(`INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind) VALUES ($1,$2,'telemetry_v1')`,
    [chunkId, `synthetic/${chunkId}`]);
  await pool.query(`INSERT INTO ${table("telemetry_v1_chunks")} (
      id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,parser_version,
      record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
    ) VALUES ($1,$2,$3,'usage','2026-09-20',0,1,$4,$5,'synthetic-owner-journal',1,1,$6,$7,$8)`,
  [chunkId, participantId, deviceId, digest(`chunk-${index}`), digest(`chunk-envelope-${index}`), `synthetic/${chunkId}`,
    uploadId, now]);
  const first = `0e${index}00000-0000-4000-8000-000000000001`;
  const second = `0e${index}00000-0000-4000-8000-000000000002`;
  await v11Generation(pool, table, { participantId, deviceId, generationId: first });
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, first, now]);
  await v11Generation(pool, table, { participantId, deviceId, generationId: second, previous: first });
  await pool.query(`UPDATE ${table("telemetry_v11_domain_heads")} SET generation_id=$2,revision=2 WHERE participant_id=$1`,
    [participantId, second]);
  await pool.query(`DELETE FROM ${table("telemetry_records")} WHERE participant_id=$1`, [participantId]);
}

test("PG17 headed owners receive no emitter rows while input revisions and source digests advance as before",
  { skip: SKIP, timeout: 240_000 }, async () => {
    const headed = { participantId: "synthetic-emitter-headed", deviceId: "synthetic-emitter-headed-device", owner: digest("emitter-headed") };
    const unheaded = { participantId: "synthetic-emitter-unheaded", deviceId: "synthetic-emitter-unheaded-device", owner: digest("emitter-unheaded") };
    const run = async ({ pool, table, quoted }, staged) => {
      await initializeSource(pool, table, 1);
      for (const participant of [headed, unheaded]) {
        await createSocialDevice(pool, table, participant.participantId, participant.deviceId);
        await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state) VALUES ($1,$2,'active')`,
          [participant.participantId, participant.owner]);
        await pool.query(`INSERT INTO ${table("analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
          VALUES ($1,$2,1,1,'active')`, [SOURCE_ID, participant.owner]);
      }
      if (staged) {
        await pool.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$2,$3,$4)`,
          [headed.owner, digest("emitter-event"), digest("emitter-object"), digest("emitter-content")]);
      }
      for (const [index, participant] of [headed, unheaded].entries()) {
        await rawTelemetryChanges(pool, table, participant.participantId, participant.deviceId, index + 1);
      }
      const inputs = await pool.query(`SELECT participant.id AS participant_id, versions.revision::int AS revision, digests.digest
        FROM ${table("participants")} participant
        LEFT JOIN ${table("input_versions")} versions ON versions.participant_id=participant.id
        LEFT JOIN ${table("input_source_digests")} digests ON digests.participant_id=participant.id
        ORDER BY participant.id`);
      const rows = await journal(pool, table);
      return { inputs: inputs.rows, rows };
    };
    // Legacy telemetry triggers resolve their relations through the runtime
    // search path, as the Cloud Run host sets it.
    const withSearchPath = async (context, staged) => {
      const client = await context.pool.connect();
      try {
        await client.query(`SET search_path TO ${context.quoted}, pg_catalog`);
        return await run({ ...context, pool: client }, staged);
      } finally {
        await client.query("RESET search_path").catch(() => {});
        client.release();
      }
    };
    let baseline;
    await withSchema(async (context) => { baseline = await withSearchPath(context, false); }, { staged: false });
    let staged;
    await withSchema(async (context) => { staged = await withSearchPath(context, true); });

    assert.ok(baseline.inputs.every((row) => row.revision > 1 && /^[0-9a-f]{32}$/u.test(row.digest)),
      "the raw changes advanced input revisions and digests");
    assert.deepEqual(staged.inputs, baseline.inputs, "input_versions and input_source_digests are unchanged by 0046");
    const legacy = (rows, owner) => rows.filter((row) => row.owner_digest === owner && row.version === 0)
      .map(({ event_digest, owner_revision, epoch, kind, revision, public_epoch }) =>
        ({ event_digest, owner_revision, epoch, kind, revision, public_epoch }));
    assert.ok(legacy(baseline.rows, headed.owner).length >= 5, "the baseline emitter journaled the same owner's changes");
    assert.deepEqual(legacy(staged.rows, headed.owner), [], "a headed owner receives no version-0 row");
    assert.deepEqual(staged.rows.filter((row) => row.owner_digest === headed.owner).map((row) => [row.version, row.kind]),
      [[1, "owner-active"]]);
    assert.deepEqual(legacy(staged.rows, unheaded.owner), legacy(baseline.rows, unheaded.owner),
      "an unheaded owner keeps the version-0 body verbatim");
    assert.ok(legacy(staged.rows, unheaded.owner).length >= 5);
  });

// ---------------------------------------------------------------------------

async function v12Participant(pool, table, participantId, { generations, headRevision }) {
  const deviceId = `${participantId}-device`;
  await createSocialDevice(pool, table, participantId, deviceId);
  const now = "2026-09-20T00:00:00.000Z";
  const ids = [];
  for (let index = 0; index < generations; index += 1) {
    const generationId = `0f${participantId.slice(-2)}0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const previous = ids.at(-1) ?? null;
    const token = digest(`v12-token-${generationId}`);
    await pool.query(`INSERT INTO ${table("telemetry_v12_domain_predecessors")} (
        token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,from_day,through_day,
        winners_json,created_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,0,'2026-09-20','2026-09-20','[]',$6,'2026-09-21T00:00:00.000Z')`,
    [token, participantId, deviceId, previous, digest(`v12-legacy-${generationId}`), now]);
    await pool.query(`INSERT INTO ${table("telemetry_v12_domains")} (
        id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
        input_revision,from_day,through_day,days_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,'2026-09-20','2026-09-20','[]',$8)`,
    [generationId, participantId, deviceId, token, previous, digest(`v12-manifest-${generationId}`),
      digest(`v12-legacy-${generationId}`), now]);
    ids.push(generationId);
  }
  for (let revision = 1; revision <= headRevision; revision += 1) {
    if (revision === 1) {
      await pool.query(`INSERT INTO ${table("telemetry_v12_domain_heads")} (participant_id,generation_id,revision,updated_at)
        VALUES ($1,$2,1,$3)`, [participantId, ids[0], now]);
    } else {
      await pool.query(`UPDATE ${table("telemetry_v12_domain_heads")} SET generation_id=$2,revision=$3 WHERE participant_id=$1`,
        [participantId, ids[revision - 1], revision]);
    }
  }
  return { deviceId, ids };
}

test("PG17 storage_v12_event_sources admits exactly the published v1.2 chain", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, quoted, table }) => {
    const participantId = "synthetic-v12-events-01";
    const { deviceId, ids } = await v12Participant(pool, table, participantId, { generations: 4, headRevision: 3 });
    const ownerDigest = (await pool.query(`SELECT ${quoted}.storage_owner_link_ensure($1,'active') AS digest`,
      [participantId])).rows[0].digest;
    const eventFor = (generation, revision, overrides = {}) => ({
      event_digest: digest(`v12-event-${randomUUID()}`), owner_digest: ownerDigest, participant_id: participantId,
      device_id: deviceId, generation_id: ids[generation], previous_generation_id: generation === 0 ? null : ids[generation - 1],
      manifest_digest: digest(`v12-manifest-${ids[generation]}`), head_revision: revision, recorded_ms: 1, ...overrides,
    });
    const insert = (event) => pool.query(`INSERT INTO ${table("storage_v12_event_sources")} (
        event_digest,owner_digest,participant_id,device_id,generation_id,previous_generation_id,manifest_digest,head_revision,recorded_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [event.event_digest, event.owner_digest, event.participant_id, event.device_id,
      event.generation_id, event.previous_generation_id, event.manifest_digest, event.head_revision, event.recorded_ms]);

    await insert(eventFor(2, 3));
    await insert(eventFor(1, 2));
    await insert(eventFor(0, 1));
    // generation index 3 exists but is not published (the head stops at 3).
    await refuses(insert(eventFor(3, 4)), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(3, 3)), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(1, 3)), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(2, 2)), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(2, 3, { manifest_digest: digest("other-manifest") })), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(2, 3, { previous_generation_id: ids[0] })), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(2, 3, { device_id: `${participantId}-other-device` })), "telemetry_source_membership_invalid");
    await refuses(insert(eventFor(2, 3, { owner_digest: digest("not-the-link") })), "telemetry_source_membership_invalid");
    await assert.rejects(insert(eventFor(2, 3)), (error) => error?.code === "23505", "one receipt per head change");

    await refuses(pool.query(`UPDATE ${table("storage_v12_event_sources")} SET recorded_ms=2`), "telemetry_source_membership_immutable");
    await refuses(pool.query(`DELETE FROM ${table("storage_v12_event_sources")}`), "telemetry_source_membership_retained");

    const deleting = "synthetic-v12-events-02";
    const deletingGraph = await v12Participant(pool, table, deleting, { generations: 1, headRevision: 1 });
    const deletingDigest = (await pool.query(`SELECT ${quoted}.storage_owner_link_ensure($1,'active') AS digest`, [deleting])).rows[0].digest;
    await pool.query(`UPDATE ${table("participants")} SET state='deleting' WHERE id=$1`, [deleting]);
    await refuses(insert({ ...eventFor(0, 1), participant_id: deleting, owner_digest: deletingDigest, device_id: deletingGraph.deviceId,
      generation_id: deletingGraph.ids[0], manifest_digest: digest(`v12-manifest-${deletingGraph.ids[0]}`) }),
    "telemetry_source_membership_invalid");

    const erased = "synthetic-v12-events-03";
    const erasedGraph = await v12Participant(pool, table, erased, { generations: 1, headRevision: 1 });
    const erasedDigest = (await pool.query(`SELECT ${quoted}.storage_owner_link_ensure($1,'withdrawn') AS digest`, [erased])).rows[0].digest;
    const erasedEvent = { ...eventFor(0, 1), participant_id: erased, owner_digest: erasedDigest, device_id: erasedGraph.deviceId,
      generation_id: erasedGraph.ids[0], manifest_digest: digest(`v12-manifest-${erasedGraph.ids[0]}`) };
    await insert(erasedEvent);
    await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`, [erased]);
    await refuses(insert({ ...erasedEvent, event_digest: digest("after-erasure") }), "telemetry_source_membership_invalid");
    // The erasure receipt releases the retained receipt, and participant
    // deletion cascades the rest.
    assert.equal((await pool.query(`DELETE FROM ${table("storage_v12_event_sources")} WHERE participant_id=$1`, [erased])).rowCount, 1);
    await pool.query(`UPDATE ${table("participants")} SET state='deleting' WHERE id=$1`, [participantId]);
    await pool.query(`DELETE FROM ${table("participants")} WHERE id=$1`, [participantId]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("storage_v12_event_sources")}`)).rows[0].count, 0);
  }));

// ---------------------------------------------------------------------------

test("PG17 owner-link ensure is idempotent under concurrency and the transfer predicate excludes superusers",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { ensurePostgresOwnerLink, PostgresOwnerJournalError } = await workerModule("/src/postgres-owner-journal.ts");
    for (const id of ["synthetic-link-01", "synthetic-link-02", "synthetic-link-03"]) {
      await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ($1,clock_timestamp())`, [id]);
    }
    const client = await pool.connect();
    let withdrawn;
    try {
      const first = await ensurePostgresOwnerLink(client, schema, "synthetic-link-01", "active");
      assert.match(first, /^[0-9a-f]{64}$/u);
      assert.equal(await ensurePostgresOwnerLink(client, schema, "synthetic-link-01", "withdrawn"), first,
        "an existing link keeps its digest and state");
      withdrawn = await ensurePostgresOwnerLink(client, schema, "synthetic-link-02", "withdrawn");
      assert.notEqual(withdrawn, first);
      await assert.rejects(ensurePostgresOwnerLink(client, schema, "synthetic-link-03", "erased"), (error) =>
        error instanceof PostgresOwnerJournalError && error.code === "OWNER_JOURNAL_INPUT_INVALID");
      await refuses(pool.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-03','erased')`),
        "storage_owner_link_state_invalid");
      await refuses(pool.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-missing','active')`),
        "storage_owner_link_participant_unavailable");
    } finally {
      client.release();
    }
    const states = await pool.query(`SELECT participant_id,state FROM ${table("storage_v11_owner_links")} ORDER BY participant_id`);
    assert.deepEqual(states.rows, [
      { participant_id: "synthetic-link-01", state: "active" },
      { participant_id: "synthetic-link-02", state: "withdrawn" },
    ]);
    await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id='synthetic-link-02'`);
    assert.equal((await pool.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-02','active') AS digest`)).rows[0].digest,
      withdrawn, "an erased link is returned, never re-minted or re-activated");
    assert.equal((await pool.query(`SELECT state FROM ${table("storage_v11_owner_links")} WHERE participant_id='synthetic-link-02'`))
      .rows[0].state, "erased");

    // Concurrent first mints for one participant converge without 23505.
    const blocker = await pool.connect();
    const waiter = await pool.connect();
    try {
      await blocker.query("BEGIN");
      const held = (await blocker.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-03','active') AS digest`)).rows[0].digest;
      await waiter.query("BEGIN");
      const pending = waiter.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-03','withdrawn') AS digest`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await blocker.query("COMMIT");
      assert.equal((await pending).rows[0].digest, held);
      await waiter.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await waiter.query("ROLLBACK").catch(() => {});
      blocker.release();
      waiter.release();
    }
    await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ('synthetic-link-race',clock_timestamp())`);
    const racers = await Promise.all(Array.from({ length: 8 }, async (_, attempt) => {
      const racer = await pool.connect();
      try {
        await racer.query("BEGIN");
        const minted = (await racer.query(`SELECT ${quoted}.storage_owner_link_ensure('synthetic-link-race',$1) AS digest`,
          [attempt % 2 === 0 ? "active" : "withdrawn"])).rows[0].digest;
        await racer.query("COMMIT");
        return minted;
      } catch (error) {
        await racer.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        racer.release();
      }
    }));
    assert.equal(new Set(racers).size, 1, "eight concurrent first mints converge on one digest");
    const raced = await pool.query(`SELECT owner_digest FROM ${table("storage_v11_owner_links")}
      WHERE participant_id='synthetic-link-race'`);
    assert.deepEqual(raced.rows, [{ owner_digest: racers[0] }]);

    // Transfer-session predicate.
    const predicate = async (runner) =>
      (await runner.query(`SELECT ${quoted}.storage_journal_transfer_session() AS transfer`)).rows[0].transfer;
    const roleExisted = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [TRANSFER_ROLE])).rowCount === 1;
    if (!roleExisted) assert.equal(await predicate(pool), false, "no transfer session without the role");
    const suffix = randomBytes(4).toString("hex");
    const member = `synthetic_owner_journal_member_${suffix}`;
    const runtime = `synthetic_owner_journal_runtime_${suffix}`;
    let roleCreated = false;
    try {
      if (!roleExisted) {
        await pool.query(`CREATE ROLE ${TRANSFER_ROLE} NOLOGIN`);
        roleCreated = true;
      }
      await pool.query(`CREATE ROLE ${member} LOGIN NOSUPERUSER IN ROLE ${TRANSFER_ROLE}`);
      await pool.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER`);
      await pool.query(`GRANT USAGE ON SCHEMA ${quoted} TO ${member}, ${runtime}`);
      assert.equal(await predicate(pool), false, "a superuser session is never a transfer session");
      const local = await endpoint();
      for (const [role, expected] of [[member, true], [runtime, false]]) {
        const session = new pg.Client({ ...local, user: role, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, ssl: false });
        await session.connect();
        try {
          assert.equal(await predicate(session), expected, `${expected ? "a" : "no"} transfer session for the ${role === member ? "member" : "runtime"} login`);
          await assert.rejects(session.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$1,$1,$1)`, [digest("x")]),
            (error) => error?.code === "42501", "append is not granted to PUBLIC");
        } finally {
          await session.end();
        }
      }
    } finally {
      await pool.query(`REVOKE ALL ON SCHEMA ${quoted} FROM ${member}, ${runtime}`).catch(() => {});
      await pool.query(`DROP ROLE IF EXISTS ${member}`);
      await pool.query(`DROP ROLE IF EXISTS ${runtime}`);
      if (roleCreated) await pool.query(`DROP ROLE IF EXISTS ${TRANSFER_ROLE}`);
    }
  }));

// ---------------------------------------------------------------------------

test("PG17 owner-journal health is content-free and analytics retirement retains an erased head",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { readPostgresOwnerJournalHealth, appendPostgresOwnerJournal, ensurePostgresOwnerLink } =
      await workerModule("/src/postgres-owner-journal.ts");
    const { retirePostgresAnalyticsOwner, hasPostgresAnalyticsOwnerResidue } =
      await workerModule("/src/postgres-analytics-owner-retirement.ts");
    const client = await pool.connect();
    const health = () => readPostgresOwnerJournalHealth(client, schema);
    try {
      assert.deepEqual(await health(), {
        sourceInitialized: false, heads: { active: 0, withdrawn: 0, erased: 0 },
        seededPartialHeads: 0, linksWithoutHead: 0, versionZeroRowsForHeadedOwners: 0,
      });
      await initializeSource(pool, table, 1);
      for (const id of ["synthetic-health-active", "synthetic-health-legacy", "synthetic-health-linkless", "synthetic-health-erased"]) {
        await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ($1,clock_timestamp())`, [id]);
      }
      const activeOwner = await ensurePostgresOwnerLink(client, schema, "synthetic-health-active", "active");
      const legacyOwner = await ensurePostgresOwnerLink(client, schema, "synthetic-health-legacy", "active");
      await ensurePostgresOwnerLink(client, schema, "synthetic-health-linkless", "withdrawn");
      const erasedOwner = await ensurePostgresOwnerLink(client, schema, "synthetic-health-erased", "active");
      // Pre-head legacy history, then the owner's first exact row.
      await rawLegacy(pool, table, { sequence: 1, owner: legacyOwner });
      await rawLegacy(pool, table, { sequence: 2, owner: legacyOwner });
      const append = (kind, owner, n) => appendPostgresOwnerJournal(client, schema, {
        kind, ownerDigest: owner, eventDigest: digest(`health-${n}`), objectDigest: digest(`health-object-${n}`),
        contentDigest: digest(`health-content-${n}`),
      });
      await append("owner-active", activeOwner, 1);
      await append("owner-active", legacyOwner, 2);
      await append("owner-active", erasedOwner, 3);
      await append("owner-withdrawn", legacyOwner, 4);
      await rawExact(pool, table, { sequence: 7, owner: digest("health-partial"), kind: "owner-withdrawn", revision: 4,
        epoch: 4, publicEpoch: 6 });
      await append("owner-erased", erasedOwner, 5);
      const reading = await health();
      assert.deepEqual(reading, {
        sourceInitialized: true, heads: { active: 1, withdrawn: 2, erased: 1 },
        seededPartialHeads: 1, linksWithoutHead: 1, versionZeroRowsForHeadedOwners: 2,
      });
      assert.equal(JSON.stringify(reading).match(/[0-9a-f]{64}|synthetic/u), null, "no digest or identifier leaves the health read");
    } finally {
      client.release();
    }

    // Participant erasure after the owner's terminal row, then retirement
    // once the analytics cursor has applied the whole journal.
    await pool.query(`UPDATE ${table("participants")} SET state='deleting' WHERE id='synthetic-health-erased'`);
    await pool.query(`DELETE FROM ${table("participants")} WHERE id='synthetic-health-erased'`);
    const latest = (await journal(pool, table)).at(-1);
    const epoch = await sourceEpoch(pool, table);
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")} (source_id,sequence,authority_epoch) VALUES ($1,$2,$3)`,
      [SOURCE_ID, latest.sequence, epoch]);
    await pool.query(`INSERT INTO ${table("analytics_applied_events")} (
        source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,event_tuple_version,revision,kind,
        object_digest,content_digest,public_authority_epoch,recorded_ms
      ) SELECT source_id,sequence,event_digest,owner_digest,authority_epoch,NULL,1,revision,kind,object_digest,content_digest,
          public_authority_epoch,recorded_ms
          FROM ${table("storage_ingestion_changes")} WHERE source_id=$1 AND sequence=$2`, [SOURCE_ID, latest.sequence]);
    const erasedHead = (await heads(pool, table)).find((head) => head.state === "erased" && !head.seeded_partial);
    const options = { primaryPool: pool, ownerDigest: erasedHead.owner_digest, schema: { primarySchema: schema } };
    const retired = await retirePostgresAnalyticsOwner(options);
    assert.equal(retired.status, "complete");
    assert.equal(retired.sourceCount, 1);
    assert.equal(retired.retained.sourceJournalRows, 2);
    assert.equal(await hasPostgresAnalyticsOwnerResidue(options), false, "a retained head is never residue");
    assert.deepEqual((await pool.query(`SELECT state,revision::int AS revision FROM ${table("storage_owner_revisions")}
      WHERE owner_digest=$1`, [erasedHead.owner_digest])).rows, [{ state: "erased", revision: 2 }],
    "the head is a retained tombstone");
    await refuses(pool.query(`SELECT ${quoted}.storage_journal_append('owner-active',$1,$2,$2,$2)`,
      [erasedHead.owner_digest, digest("after-retirement")]), "storage_owner_erased");
  }));
