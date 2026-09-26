import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for the community publication authority,
 * primary migration 0053_community_publication_authority.sql, and
 * src/postgres-storage-community-authority.ts. Until the staged-migration
 * harness exists, each schema receives the stock primary chain below 0053
 * through the migration runner (copied into a private root) and then 0053 in
 * one transaction under the runner's search path. 0053 is read from
 * staged-migrations/ or, once promoted, from migrations/, so the tests are
 * unchanged by promotion and by later waves. Tests that need data from
 * before 0053 (the bootstrap seed and the head backfill) write it at the
 * baseline. Every row is synthetic and content-free.
 *
 * Connection profile: the private Unix socket (PG_TEST_SOCKET) or loopback
 * TCP (PG_TEST_HOST). Without either, every database test skips; a skip is
 * not a pass.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STOCK_PRIMARY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const STAGED_PRIMARY = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
const AUTHORITY_FILE = /^(\d{4})_community_publication_authority\.sql$/u;
const ORACLE = join(WORKER_ROOT, "postgres-test", "fixtures", "community-authority-owner-page-oracle.json");
const SOURCE_ID = "synthetic-community-authority-source";
const SOURCE_NAMESPACE = "synthetic-community-authority-namespace";
const DAY = "2026-09-20";
// Shared with the owner-journal spec: serializes every test that touches the
// cluster-global transfer role.
const TRANSFER_ROLE = "tibotattle_source_transfer";
const TRANSFER_ROLE_LOCK = 460_046;
const CONSTANT_MESSAGE = /^[a-z][a-z0-9_]{2,80}$/u;

const digest = (seed) => createHash("sha256").update(String(seed)).digest("hex");

let authorityMigration;
/** 0053 from staged-migrations/ or, after promotion, migrations/: exactly one. */
async function readAuthority() {
  if (authorityMigration === undefined) {
    const found = [];
    for (const [directory, staged] of [[STAGED_PRIMARY, true], [STOCK_PRIMARY, false]]) {
      let names = [];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const name of names.filter((entry) => AUTHORITY_FILE.test(entry))) {
        found.push({ name, staged, version: Number(name.slice(0, 4)), sql: await readFile(join(directory, name), "utf8") });
      }
    }
    assert.equal(found.length, 1, "0053 is either staged or promoted, never both or neither");
    authorityMigration = found[0];
  }
  return authorityMigration;
}

let baselineRoot;
/** A private migrations root holding the stock primary chain below 0053 (0001-0046 while staged). */
function baselineMigrationsRoot() {
  baselineRoot ??= (async () => {
    const { version } = await readAuthority();
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-community-authority-")));
    await mkdir(join(directory, "primary"), { mode: 0o700 });
    const names = (await readdir(STOCK_PRIMARY))
      .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name) && Number(name.slice(0, 4)) < version)
      .sort();
    assert.ok(names.length >= 46 && Number(names.at(-1).slice(0, 4)) === names.length,
      "the stock chain below 0053 is contiguous and holds 0046");
    for (const name of names) await copyFile(join(STOCK_PRIMARY, name), join(directory, "primary", name));
    return { directory, count: names.length };
  })();
  return baselineRoot;
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "community authority tests require loopback or a private Unix socket");
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
      ssl: false, max: 8, connectionTimeoutMillis: 5_000, application_name: "pg-community-authority-test",
    });
    const version = await sharedPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "the community authority is qualified on PostgreSQL 17");
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
const authorityModule = () => workerModule("/src/postgres-storage-community-authority.ts");

after(async () => {
  if (sharedVite) await sharedVite.close();
  if (sharedPool) await sharedPool.end();
  const baseline = await baselineRoot?.catch(() => null);
  if (baseline) await rm(baseline.directory, { recursive: true, force: true });
});

async function applyAuthority(pool, schema) {
  const { sql } = await readAuthority();
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

/** Run `body` on a fresh schema at the baseline, `before` data, then 0053. */
async function withSchema(body, { before } = {}) {
  const pool = await connection();
  const schema = `community_authority_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted}."${name}"`;
  };
  const context = { pool, schema, quoted, table };
  await pool.query(`CREATE SCHEMA ${quoted}`);
  try {
    const baseline = await baselineMigrationsRoot();
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: baseline.directory });
    assert.equal(applied.migrations.length, baseline.count);
    if (before) await before(context);
    await applyAuthority(pool, schema);
    await body(context);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  }
}

/** Assert a constant P1005 refusal. */
async function refuses(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, "P1005", `expected P1005 for ${message}, got ${error?.code} ${error?.message}`);
    assert.equal(error.message, message);
    assert.match(error.message, CONSTANT_MESSAGE);
    assert.equal(error.detail, undefined, "constant refusals carry no detail");
    return true;
  });
}

async function violates(promise, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, "23514", `expected a CHECK violation, got ${error?.code} ${error?.message}`);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

const unavailable = (error) => error instanceof Error && error.constructor === Error
  && error.message === "STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE";
const apiError = (code, status = 503) => (error) => error?.name === "ApiError" && error.code === code
  && error.status === status;

let journalEvent = 0;
async function append(pool, quoted, kind, ownerDigest) {
  journalEvent += 1;
  const n = `${journalEvent}-${randomBytes(4).toString("hex")}`;
  const result = await pool.query(`SELECT ${quoted}.storage_journal_append($1,$2,$3,$4,$5)::int AS sequence`,
    [kind, ownerDigest, digest(`event-${n}`), digest(`object-${n}`), digest(`content-${n}`)]);
  return result.rows[0].sequence;
}

/** Source identity, typed admission states and a fully operational control row. */
async function initializeAuthority(pool, table, { epoch = 0, mutationEpoch = 4, graphEpoch = 3 } = {}) {
  await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id,original_id) VALUES (1,decode('0102','hex'))`);
  for (const name of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
    await pool.query(`INSERT INTO ${table(name)}(id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
  }
  await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch) VALUES (1,$1,$2)`,
    [SOURCE_ID, epoch]);
  await pool.query(`UPDATE ${table("publication_state")} SET policy_revision=1 WHERE singleton=1`);
  await setControls(pool, table, "operational");
  await pool.query(`UPDATE ${table("mutation_control")} SET mutation_epoch=$1 WHERE singleton_id=1`, [mutationEpoch]);
  await pool.query(`UPDATE ${table("mutation_control")} SET graph_invalidation_epoch=$1 WHERE singleton_id=1`, [graphEpoch]);
}

async function setControls(pool, table, state) {
  const on = state === "operational";
  await pool.query(`UPDATE ${table("collection_controls")} SET revision=revision+1,control_state=$1,
      enrollment_enabled=$2,upload_registration_enabled=$2,processing_enabled=$2,publication_enabled=$2,
      reason_code=NULL,updated_at=clock_timestamp() WHERE singleton=1`, [state, on]);
}

async function bootstrapRow(pool, table) {
  return (await pool.query(`SELECT singleton,policy_version,participant_cursor,source_day_cursor,completed
    FROM ${table("community_public_source_bootstrap")}`)).rows;
}

// ---------------------------------------------------------------------------
// Synthetic authority rows, shared by the D1 oracle and the bootstrap cases.

const T = Object.freeze({ issued: "2026-09-01T00:00:00.000Z" });

async function insertSocialDevice(pool, table, participantId, deviceId, secretHash) {
  const sessionId = `session-${deviceId}`;
  const pairingId = `pairing-${deviceId}`;
  await pool.query(`INSERT INTO ${table("web_sessions")} (
      id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,$3,$4,'personal','active',$5,'2099-01-01T00:00:00.000Z',$5)`,
  [sessionId, participantId, Buffer.from(digest(`session-${deviceId}`), "hex"),
    Buffer.from(digest(`csrf-${deviceId}`), "hex"), T.issued]);
  await pool.query(`INSERT INTO ${table("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
      issued_at,expires_at,consumed_at,claimed_device_id
    ) VALUES ($1,$2,$3,$4,'ongoing-privacy-safe-telemetry-v0.1','ongoing-privacy-safe-telemetry-v0.1','consumed',
      $5,'2099-01-01T00:00:00.000Z',$5,$6)`,
  [pairingId, participantId, sessionId, Buffer.from(digest(`pairing-${deviceId}`), "hex"), T.issued, deviceId]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at,
      social_verified_at
    ) VALUES ($1,$2,'social',$3,$4,'active',$5,'2099-01-01T00:00:00.000Z',$5,$5)`,
  [deviceId, participantId, pairingId, Buffer.from(secretHash, "hex"), T.issued]);
}

/** An eligible accountless owner with an active lease graph (v1.1 or v1.2 grant). */
async function insertAccountlessGraph(pool, table, owner, graph) {
  const secret = Buffer.from(owner.secretHash, "hex");
  const initial = (lease) => (graph.markerRetainedAt
    ? { ...lease, state: "active", revokedAt: null, revocationReason: null } : lease);
  const ledger = initial(graph.ledger);
  const device = initial(graph.device);
  const ownerLease = initial(graph.owner);
  await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")} (
      device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
      state,issued_at,expires_at,revoked_at,revocation_reason,renewal_generation,renewed_at
    ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',
      $4,$5,$6,$7,$8,0,NULL)`,
  [owner.deviceId, secret, `authority-installation-${owner.deviceId}`, ledger.state, ledger.issuedAt,
    ledger.expiresAt, ledger.revokedAt, ledger.revocationReason]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,
      issued_at,expires_at,last_used_at,revoked_at,social_verified_at
    ) VALUES ($1,$2,'accountless',$1,$3,$4,$5,$6,$5,$7,NULL)`,
  [owner.deviceId, owner.id, secret, device.state, device.issuedAt, device.expiresAt, device.revokedAt]);
  await pool.query(`INSERT INTO ${table("accountless_upload_owners")} (
      enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
      authorized_at,expires_at,state,revoked_at,revocation_reason
    ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,$5,$6,$7)`,
  [owner.deviceId, owner.id, ownerLease.issuedAt, ownerLease.expiresAt, ownerLease.state, ownerLease.revokedAt,
    ownerLease.revocationReason]);
  for (const [name, grant] of [["accountless_v11_device_authorizations", graph.v11Grant],
    ["accountless_v12_device_authorizations", graph.v12Grant]]) {
    if (!grant) continue;
    const lease = initial(grant);
    const v11 = name === "accountless_v11_device_authorizations";
    await pool.query(`INSERT INTO ${table(name)} (
        enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,
        privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason
      ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [owner.deviceId, owner.id,
      v11 ? "telemetry-contribution-v1.1" : "telemetry-contribution-v1.2",
      v11 ? "telemetry-v1.1-registry-2026-08-31.1" : "telemetry-v1.2-registry-2026-09-20.1",
      v11 ? "ongoing-privacy-safe-telemetry-v1.1" : "ongoing-privacy-safe-telemetry-v1.2",
      lease.issuedAt, lease.expiresAt, lease.state, lease.revokedAt, lease.revocationReason]);
  }
}

async function revokeAccountlessGraph(pool, table, owner, graph) {
  const revoke = async (name, key, final, reason = true) => {
    await pool.query(`UPDATE ${table(name)} SET state=$2,revoked_at=$3${reason ? ",revocation_reason=$4" : ""}
      WHERE ${key}=$1`, reason ? [owner.deviceId, final.state, final.revokedAt, final.revocationReason]
      : [owner.deviceId, final.state, final.revokedAt]);
  };
  await revoke("accountless_enrollment_ledger", "device_id", graph.ledger);
  await revoke("accountless_upload_owners", "enrollment_device_id", graph.owner);
  await revoke("device_credentials", "id", graph.device, false);
  if (graph.v11Grant) await revoke("accountless_v11_device_authorizations", "enrollment_device_id", graph.v11Grant);
  if (graph.v12Grant) await revoke("accountless_v12_device_authorizations", "enrollment_device_id", graph.v12Grant);
}

async function insertV11Head(pool, table, participantId, deviceId, generationId) {
  const token = digest(`token-v11-${generationId}`);
  const fingerprint = digest(`legacy-v11-${generationId}`);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
      from_day,through_day,winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'[]',$6,'2099-01-01T00:00:00.000Z')`,
  [token, participantId, deviceId, fingerprint, DAY, T.issued]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,'[]',$8)`,
  [generationId, participantId, deviceId, token, digest(`manifest-v11-${generationId}`), fingerprint, DAY, T.issued]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, generationId, T.issued]);
}

async function insertV12Head(pool, table, participantId, deviceId, domain) {
  const token = digest(`token-v12-${domain.generationId}`);
  const fingerprint = digest(`legacy-v12-${domain.generationId}`);
  const dayDigest = digest(`day-v12-${domain.manifestId}`);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
      from_day,through_day,winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'[]',$6,'2099-01-01T00:00:00.000Z')`,
  [token, participantId, deviceId, fingerprint, DAY, T.issued]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_day_manifests")} (
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,
      state,created_at,ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-v12',$6,0,$7,$8,$9)`,
  [domain.manifestId, participantId, deviceId, DAY, dayDigest, JSON.stringify({ day: DAY, chunks: [] }),
    domain.manifestState, T.issued, domain.manifestState === "ready" ? T.issued : null]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,'[]',$8)`,
  [domain.generationId, participantId, deviceId, token, digest(`manifest-v12-${domain.generationId}`), fingerprint,
    DAY, T.issued]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domain_days")} (generation_id,observed_day,manifest_id,manifest_digest)
    VALUES ($1,$2::date,$3,$4)`, [domain.generationId, DAY, domain.manifestId, dayDigest]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, domain.generationId, T.issued]);
}

async function insertV1Chunk(pool, table, participantId, deviceId, chunk) {
  const envelope = digest(`envelope-${chunk.id}`);
  const objectKey = `synthetic/authority/${chunk.id}`;
  await pool.query(`INSERT INTO ${table("device_upload_authorizations")} (
      id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,
      issued_at,expires_at,consumed_at,consumed_contribution_id
    ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,'2099-01-01T00:00:00.000Z',$6,$7)`,
  [chunk.authorizationId, participantId, deviceId, Buffer.from(digest(`authorization-${chunk.id}`), "hex"), envelope,
    T.issued, chunk.id]);
  await pool.query(`INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind)
    VALUES ($1,$2,'telemetry_v1')`, [chunk.id, objectKey]);
  await pool.query(`INSERT INTO ${table("telemetry_v1_chunks")} (
      id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,parser_version,
      record_count,accepted_record_count,r2_key,device_upload_authorization_id,superseded_at,created_at
    ) VALUES ($1,$2,$3,'usage',$4::date,$5,1,$6,$7,'synthetic-v1',1,$8,$9,$10,$11,$12)`,
  [chunk.id, participantId, deviceId, DAY, chunk.chunkSeq, digest(`chunk-${chunk.id}`), envelope,
    chunk.acceptedRecordCount, objectKey, chunk.authorizationId,
    chunk.superseded ? "2026-09-21T00:00:00.000Z" : null, T.issued]);
}

/** Rebuild one D1 oracle participant as PostgreSQL rows through the live guards. */
async function insertOracleParticipant(pool, table, quoted, owner) {
  await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,$2,$3,$4)`,
    [owner.id, owner.ownerKind, owner.state, T.issued]);
  const graph = owner.accountless;
  if (graph === null) {
    await insertSocialDevice(pool, table, owner.id, owner.deviceId, owner.secretHash);
  } else {
    await insertAccountlessGraph(pool, table, owner, graph);
  }
  if (owner.capability !== null) {
    await pool.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")} (
        participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
        state,consented_at,revoked_at
      ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
        'ongoing-privacy-safe-telemetry-v1.2',$3,$4,$5)`,
    [owner.id, owner.deviceId, owner.capability, T.issued, owner.capability === "revoked" ? "2026-09-20T12:00:00.000Z" : null]);
  }
  if (owner.v11GenerationId !== null) await insertV11Head(pool, table, owner.id, owner.deviceId, owner.v11GenerationId);
  if (owner.v12Domain !== null) await insertV12Head(pool, table, owner.id, owner.deviceId, owner.v12Domain);
  if (graph?.markerRetainedAt) {
    await pool.query(`INSERT INTO ${table("accountless_public_history_retention")} (
        participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
      ) VALUES ($1,$2,$2,$3,1,$4)`, [owner.id, owner.deviceId, owner.v12Domain.generationId, graph.markerRetainedAt]);
  }
  if (graph !== null && (graph.markerRetainedAt || graph.ledger.state === "revoked")) {
    await revokeAccountlessGraph(pool, table, owner, graph);
  }
  for (const chunk of owner.v1Chunks) await insertV1Chunk(pool, table, owner.id, owner.deviceId, chunk);
  if (owner.legacyContribution !== null) {
    const contributionId = `authority-contribution-${owner.id}`;
    // Legacy telemetry triggers resolve their relations through the runtime
    // search path, as the Cloud Run host sets it.
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted}, pg_catalog`);
      await client.query(`INSERT INTO ${table("telemetry_contributions")} (
          id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,range_start,
          range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,unknown_model_event_count,
          unknown_billable_units,price_basis,declared_record_count,created_at
        ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1',$6,$7,$7,'synthetic','synthetic',100,0,0,'synthetic',0,$7)`,
      [contributionId, owner.id, digest(`plain-${contributionId}`), digest(`envelope-${contributionId}`),
        `synthetic/authority/${contributionId}`, `telemetry-contribution-${owner.legacyContribution}`, T.issued]);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
  }
  if (owner.ownerDigest !== null) {
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
      VALUES ($1,$2,'active')`, [owner.id, owner.ownerDigest]);
    if (owner.ownerRevision !== null) {
      // Through the single journal producer, so the head is the one 0046
      // derives: owner-active, then source-updated (active) or owner-withdrawn.
      await append(pool, quoted, "owner-active", owner.ownerDigest);
      if (owner.ownerRevision === 2) {
        await append(pool, quoted, owner.ownerHeadState === "withdrawn" ? "owner-withdrawn" : "source-updated",
          owner.ownerDigest);
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** The view body, comments and layout removed. */
function normalizedSql(text) {
  return text.replace(/--[^\n]*/gu, " ").replace(/\s+/gu, " ").replace(/\s*([(),=])\s*/gu, "$1").trim();
}

test("0053 community_v12_retained_authorization_scope is D1's V12_RETAINED_AUTHORIZATION_SCOPE text", async () => {
  const { V12_RETAINED_AUTHORIZATION_SCOPE } = await workerModule("/src/storage-community-authority.ts");
  const code = (await readAuthority()).sql.replace(/--[^\n]*/gu, " ");
  const start = code.search(/\bCREATE VIEW community_v12_retained_authorization_scope\(participant_id, device_id\) AS\b/u);
  assert.ok(start >= 0, "0053 defines the retained scope view with named columns");
  const body = code.slice(code.indexOf(" AS", start) + 3, code.indexOf(";", start));
  // The only differences: PostgreSQL's port of D1's active-authorization
  // view (D1's telemetry_v12_runtime is telemetry_v12_typed_runtime), the
  // reserved alias quoted, and the clock.
  const d1 = V12_RETAINED_AUTHORIZATION_SCOPE
    .replace("FROM telemetry_v12_active_authorizations", "FROM telemetry_v12_typed_active_authorizations")
    .replace(/\bauthorization\b/gu, "\"authorization\"")
    .replace("strftime('%Y-%m-%dT%H:%M:%fZ','now')", "now()");
  assert.notEqual(d1, V12_RETAINED_AUTHORIZATION_SCOPE);
  assert.equal(normalizedSql(body), normalizedSql(d1));
});

test("PG17 retained v1.2 scope and community owner page equal the D1 oracle", { skip: SKIP, timeout: 240_000 },
  async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { readPostgresCommunityOwnerPage } = await authorityModule();
    const oracle = JSON.parse(await readFile(ORACLE, "utf8"));
    assert.equal(oracle.schemaVersion, "community-authority-owner-page-oracle-v1");
    assert.equal(oracle.day, DAY);
    assert.equal(oracle.cases.length, 16);
    await initializeAuthority(pool, table);
    await pool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [T.issued]);
    await pool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [T.issued]);
    const participants = oracle.cases.flatMap((oracleCase) => oracleCase.participants);
    for (const owner of participants) await insertOracleParticipant(pool, table, quoted, owner);
    for (const owner of participants) {
      await pool.query(`UPDATE ${table("community_analytical_input_versions")} SET revision=$2 WHERE participant_id=$1`,
        [owner.id, owner.inputRevision]);
    }

    const scope = await pool.query(`SELECT participant_id,device_id FROM ${table("community_v12_retained_authorization_scope")}
      ORDER BY participant_id COLLATE "C",device_id COLLATE "C"`);
    assert.deepEqual(scope.rows, oracle.retainedScope, "the retained scope matches D1 row for row");
    // 0025's retained view joins the owner link on the active branch, so it
    // loses the unlinked accepted social device D1 retains.
    const typedRetained = await pool.query(`SELECT participant_id FROM ${table("telemetry_v12_typed_retained_authorizations")}
      WHERE participant_id='authority-03a'`);
    assert.equal(typedRetained.rowCount, 0);

    const client = await pool.connect();
    try {
      const authority = { sourceId: SOURCE_ID };
      for (const limit of [4, 64]) {
        const pages = [];
        let after = "";
        for (;;) {
          const page = await readPostgresCommunityOwnerPage(client, schema, authority, { afterParticipantId: after, limit });
          assert.ok(page.length <= limit);
          pages.push(...page);
          if (page.length < limit) break;
          after = page.at(-1).participantId;
        }
        assert.deepEqual(pages, oracle.ownerPage, `owner pages of ${limit} match D1 exactly`);
      }
      await assert.rejects(readPostgresCommunityOwnerPage(client, schema, authority, { limit: 65 }), unavailable);
      await assert.rejects(readPostgresCommunityOwnerPage(client, schema, authority, { limit: 0 }), unavailable);
      await assert.rejects(readPostgresCommunityOwnerPage(client, schema, authority, { afterParticipantId: "x".repeat(257) }),
        unavailable);
      // Owner revisions are read for the authority's source only.
      const foreign = await readPostgresCommunityOwnerPage(client, schema, { sourceId: "synthetic-other-source" });
      assert.ok(foreign.every((owner) => owner.ownerRevision === 0 && owner.authorityEpoch === 0));
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------------------

test("PG17 capture pins the D1 authority, fails closed and uses the journal maximum", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const module = await authorityModule();
    const worker = await workerModule("/src/storage-community-authority.ts");
    const { capturePostgresCommunityAuthority: capture, isPostgresCalculationAuthorityCurrent } = module;
    for (const name of ["storageCommunityPublicationVisible", "sameStorageCommunityCalculationAuthority",
      "sameStorageCommunityHardAuthority", "sameStorageCommunityAuthority"]) {
      assert.equal(module[name], worker[name], `${name} is the Worker predicate, not a copy`);
    }
    const client = await pool.connect();
    try {
      await assert.rejects(capture(client, schema), unavailable, "publication is off in the contained bootstrap row");
      await setControls(pool, table, "operational");
      await assert.rejects(capture(client, schema), unavailable, "no source identity yet: nothing to capture");
      await initializeAuthority(pool, table, { epoch: 0, mutationEpoch: 4, graphEpoch: 3 });
      const ownerA = digest("capture-owner-a");
      const ownerB = digest("capture-owner-b");
      await append(pool, quoted, "owner-active", ownerA);
      await append(pool, quoted, "owner-active", ownerB);
      const last = await append(pool, quoted, "source-updated", ownerA);
      // The delivery cursor lags the journal; capture never reads it.
      await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch) VALUES ($1,1,1)`,
        [SOURCE_ID]);
      // 0010 moves the graph invalidation epoch with a mutation-epoch update;
      // set it afterwards so the two pins are distinct.
      await pool.query(`UPDATE ${table("mutation_control")} SET mutation_epoch=11 WHERE singleton_id=1`);
      await pool.query(`UPDATE ${table("mutation_control")} SET graph_invalidation_epoch=7 WHERE singleton_id=1`);
      const controls = (await pool.query(`SELECT revision::int AS revision FROM ${table("collection_controls")}`)).rows[0];
      const authority = await capture(client, schema);
      assert.deepEqual({ ...authority }, {
        sourceId: SOURCE_ID,
        sourceNamespace: SOURCE_NAMESPACE,
        publicAuthorityEpoch: 2,
        policyRevision: 1,
        collectionRevision: controls.revision,
        graphInvalidationEpoch: 7,
        sourceEpoch: 11,
        sequence: last,
      });
      assert.equal(last, 3);
      assert.ok(Object.isFrozen(authority));
      assert.deepEqual({ ...await capture(client, schema, { sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE }) },
        { ...authority });
      await assert.rejects(capture(client, schema, { sourceId: "synthetic-other-source" }), unavailable);
      await assert.rejects(capture(client, schema, { sourceNamespace: "synthetic-other-namespace" }), unavailable);
      assert.equal(await isPostgresCalculationAuthorityCurrent(client, schema, authority), true);

      // A second controls read that disagrees with the joined revision fails.
      let bumped = false;
      const racing = {
        async query(text, values) {
          const result = await client.query(text, values);
          if (!bumped && /collection_controls WHERE singleton=1$/u.test(text.trim())) {
            bumped = true;
            await pool.query(`UPDATE ${table("collection_controls")} SET revision=revision+1 WHERE singleton=1`);
          }
          return result;
        },
        release() {},
      };
      await assert.rejects(capture(racing, schema), unavailable, "a collection revision change between reads fails closed");
      assert.equal(bumped, true);
      assert.equal(await isPostgresCalculationAuthorityCurrent(client, schema, authority), false,
        "a collection revision change ends calculation authority");
      const fresh = await capture(client, schema);
      await pool.query(`UPDATE ${table("publication_state")} SET policy_revision=2 WHERE singleton=1`);
      assert.equal(await isPostgresCalculationAuthorityCurrent(client, schema, fresh), false,
        "a policy revision change ends calculation authority");
      const current = await capture(client, schema);
      assert.equal(current.policyRevision, 2);
      assert.equal(module.sameStorageCommunityHardAuthority(fresh, current), false);

      // Publication off: build and read capture fail closed; retirement does not.
      await setControls(pool, table, "contained");
      await assert.rejects(capture(client, schema), unavailable);
      await assert.rejects(isPostgresCalculationAuthorityCurrent(client, schema, current), unavailable);
      const retirement = await capture(client, schema, { retirement: true });
      assert.equal(retirement.sourceId, SOURCE_ID);
      await setControls(pool, table, "operational");

      // Bootstrap incomplete: the same.
      await pool.query(`UPDATE ${table("community_public_source_bootstrap")} SET completed=0`);
      await assert.rejects(capture(client, schema), unavailable);
      assert.equal(await isPostgresCalculationAuthorityCurrent(client, schema, current), false);
      assert.equal((await capture(client, schema, { retirement: true })).sequence, last);
      await pool.query(`UPDATE ${table("community_public_source_bootstrap")} SET completed=1`);

      // An inconsistent control row is the Worker's controls failure.
      await pool.query(`UPDATE ${table("collection_controls")} SET enrollment_enabled=false WHERE singleton=1`);
      await assert.rejects(capture(client, schema), apiError("COLLECTION_CONTROL_UNAVAILABLE"));
      await assert.rejects(capture(client, "Invalid-Schema"), unavailable);
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------------------

test("PG17 terminal epochs: exact maximum, legacy floor or 503, and a monotonic delivered watermark",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { readPostgresSourceTerminalEpoch: sourceTerminal, readPostgresDeliveredTerminalEpoch: delivered } =
      await authorityModule();
    await initializeAuthority(pool, table, { epoch: 10 });
    const client = await pool.connect();
    const watermark = async () => (await pool.query(`SELECT terminal_public_authority_epoch::int AS epoch,
        terminal_sequence::int AS sequence,legacy_terminal_floor_epoch::int AS floor
      FROM ${table("community_terminal_watermarks")} WHERE source_id=$1`, [SOURCE_ID])).rows[0];
    try {
      assert.equal(await sourceTerminal(client, schema, SOURCE_ID), 0);
      assert.equal(await delivered(client, schema, SOURCE_ID), 0);
      const ownerA = digest("terminal-owner-a");
      const ownerB = digest("terminal-owner-b");
      await append(pool, quoted, "owner-active", ownerA);
      await append(pool, quoted, "owner-active", ownerB);
      await append(pool, quoted, "owner-withdrawn", ownerA);
      const exact = (await pool.query(`SELECT max(public_authority_epoch)::int AS epoch FROM ${table("storage_ingestion_changes")}
        WHERE kind IN ('owner-withdrawn','owner-erased')`)).rows[0].epoch;
      assert.equal(exact, 13);
      await append(pool, quoted, "owner-active", ownerA);
      assert.equal(await sourceTerminal(client, schema, SOURCE_ID), exact, "the highest exact terminal epoch");
      assert.equal(await sourceTerminal(client, schema, "synthetic-other-source"), 0, "per source");

      // A legacy version-0 terminal carries no public epoch: without an
      // explicit floor the read fails closed rather than reading 0.
      const next = (await pool.query(`SELECT max(sequence)::int + 1 AS next FROM ${table("storage_ingestion_changes")}`)).rows[0].next;
      await pool.query(`INSERT INTO ${table("storage_ingestion_changes")} (
          source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
        ) VALUES ($1,$2,$3,$4,1,1,'owner-erased',1)`, [SOURCE_ID, next, digest("legacy-terminal"), digest("legacy-owner")]);
      await assert.rejects(sourceTerminal(client, schema, SOURCE_ID), apiError("BACKEND_STORAGE_UNAVAILABLE"));
      await pool.query(`INSERT INTO ${table("community_terminal_watermarks")}
          (source_id,terminal_public_authority_epoch,terminal_sequence,legacy_terminal_floor_epoch) VALUES ($1,0,0,9)`,
      [SOURCE_ID]);
      assert.equal(await sourceTerminal(client, schema, SOURCE_ID), exact, "a lower floor never lowers the exact maximum");
      await pool.query(`UPDATE ${table("community_terminal_watermarks")} SET legacy_terminal_floor_epoch=20 WHERE source_id=$1`,
        [SOURCE_ID]);
      assert.equal(await sourceTerminal(client, schema, SOURCE_ID), 20, "the legacy floor bounds the legacy terminal");
      await refuses(pool.query(`UPDATE ${table("community_terminal_watermarks")} SET legacy_terminal_floor_epoch=19
        WHERE source_id=$1`, [SOURCE_ID]), "community_terminal_watermark_regression");
      await refuses(pool.query(`UPDATE ${table("community_terminal_watermarks")} SET legacy_terminal_floor_epoch=NULL
        WHERE source_id=$1`, [SOURCE_ID]), "community_terminal_watermark_regression");

      // Delivered: a fence raises the watermark in its own transaction and
      // retained exact terminal receipts are read directly; nothing lowers
      // or deletes either.
      assert.equal(await delivered(client, schema, SOURCE_ID), 0);
      await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
          terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,7,3,2,17)`,
      [SOURCE_ID, digest("fenced-owner"), digest("fenced-event")]);
      assert.deepEqual(await watermark(), { epoch: 17, sequence: 7, floor: 20 });
      assert.equal(await delivered(client, schema, SOURCE_ID), 17);
      // Owners are fenced out of epoch order: a later, lower fence neither
      // lowers the watermark nor is refused by its monotonic guard.
      await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
          terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,3,2,2,12)`,
      [SOURCE_ID, digest("fenced-owner-lower"), digest("fenced-event-lower")]);
      assert.deepEqual(await watermark(), { epoch: 17, sequence: 7, floor: 20 });
      assert.equal(await delivered(client, schema, SOURCE_ID), 17);
      const receipt =(sequence, kind, publicEpoch, tupleVersion = 1) => pool.query(`INSERT INTO ${table("analytics_applied_events")} (
          source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,event_tuple_version,revision,kind,
          object_digest,content_digest,public_authority_epoch,recorded_ms
        ) VALUES ($1,$2,$3,$4,1,'{}',$5,$6,$7,$8,$9,$10,$11)`,
      [SOURCE_ID, sequence, digest(`applied-${sequence}`), digest("delivered-owner"), tupleVersion,
        tupleVersion === 1 ? 1 : null, kind, tupleVersion === 1 ? digest("o") : null, tupleVersion === 1 ? digest("c") : null,
        publicEpoch, tupleVersion === 1 ? 1 : null]);
      await receipt(20, "owner-erased", 15);
      assert.equal(await delivered(client, schema, SOURCE_ID), 17, "a lower delivered epoch never lowers it");
      await receipt(21, "source-updated", 30);
      assert.equal(await delivered(client, schema, SOURCE_ID), 17, "a non-terminal receipt is not containment");
      await receipt(22, "owner-withdrawn", 25);
      assert.equal(await delivered(client, schema, SOURCE_ID), 25);
      await receipt(23, null, null, 0);
      assert.equal(await delivered(client, schema, SOURCE_ID), 25, "a version-0 receipt carries no containment");
      assert.deepEqual(await watermark(), { epoch: 17, sequence: 7, floor: 20 },
        "applied receipts need no trigger on the transfer-owned applied-event table");
      const appliedTriggers = await pool.query(`SELECT count(*)::int AS count FROM pg_trigger trigger_row
          JOIN pg_class relation_row ON relation_row.oid=trigger_row.tgrelid
          JOIN pg_namespace namespace_row ON namespace_row.oid=relation_row.relnamespace
         WHERE namespace_row.nspname=$1 AND relation_row.relname='analytics_applied_events' AND NOT trigger_row.tgisinternal`,
      [schema]);
      assert.equal(appliedTriggers.rows[0].count, 0);
      await refuses(pool.query(`UPDATE ${table("community_terminal_watermarks")} SET terminal_public_authority_epoch=16`),
        "community_terminal_watermark_regression");
      await refuses(pool.query(`UPDATE ${table("community_terminal_watermarks")} SET terminal_sequence=1`),
        "community_terminal_watermark_regression");
      await refuses(pool.query(`DELETE FROM ${table("community_terminal_watermarks")}`), "community_terminal_watermark_retained");
      await refuses(pool.query(`TRUNCATE ${table("community_terminal_watermarks")}`), "community_publication_proof_retained");
      assert.equal(await delivered(client, schema, "synthetic-other-source"), 0);
    } finally {
      client.release();
    }
  }));

test("PG17 the delivered epoch includes exact terminal receipts applied before 0053", { skip: SKIP, timeout: 120_000 },
  async () => withSchema(async ({ pool, schema, table }) => {
    const { readPostgresDeliveredTerminalEpoch } = await authorityModule();
    const client = await pool.connect();
    try {
      assert.equal(await readPostgresDeliveredTerminalEpoch(client, schema, SOURCE_ID), 12);
      assert.equal(await readPostgresDeliveredTerminalEpoch(client, schema, "synthetic-other-source"), 0);
    } finally {
      client.release();
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("community_terminal_watermarks")}`)).rows[0].count, 0);
  }, {
    before: async ({ pool, table }) => {
      for (const [sequence, kind, epoch] of [[2, "owner-withdrawn", 12], [3, "owner-active", 40], [4, "owner-erased", 9]]) {
        await pool.query(`INSERT INTO ${table("analytics_applied_events")} (
            source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,event_tuple_version,revision,kind,
            object_digest,content_digest,public_authority_epoch,recorded_ms
          ) VALUES ($1,$2,$3,$4,1,'{}',1,1,$5,$6,$6,$7,1)`,
        [SOURCE_ID, sequence, digest(`backfill-${sequence}`), digest("backfill-owner"), kind, digest("x"), epoch]);
      }
    },
  }));

// ---------------------------------------------------------------------------
// Public-source bootstrap.

async function eligibleAccountlessV11(pool, table, id, { journaled = false, ownerDigest = digest(`owner-${id}`) } = {}) {
  const deviceId = `0d000000-0000-4000-8000-${digest(id).slice(0, 12)}`;
  const generationId = `0a110000-0000-4000-8000-${digest(id).slice(0, 12)}`;
  const current = { issuedAt: "2098-12-02T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", state: "active",
    revokedAt: null, revocationReason: null };
  const owner = { id, deviceId, secretHash: digest(`secret-${id}`) };
  await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'accountless','active',$2)`,
    [id, T.issued]);
  await insertAccountlessGraph(pool, table, owner, { ledger: current, owner: current, device: current, v11Grant: current,
    v12Grant: null, markerRetainedAt: null });
  await insertV11Head(pool, table, id, deviceId, generationId);
  if (journaled) await journalV11Head(pool, table, id, ownerDigest);
  return { ...owner, generationId, ownerDigest };
}

/** The v1.1 publication receipt for the participant's current head. */
async function journalV11Head(pool, table, participantId, ownerDigest, eventSeed = participantId) {
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
    VALUES ($1,$2,'active') ON CONFLICT (participant_id) DO NOTHING`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${table("storage_v11_event_sources")} (
      event_digest,owner_digest,participant_id,device_id,generation_id,manifest_digest,from_day,through_day,
      head_revision,input_revision,recorded_ms
    ) SELECT $1,$2,domain.participant_id,domain.device_id,domain.id,domain.manifest_digest,domain.from_day,
      domain.through_day,head.revision,domain.input_revision,1
      FROM ${table("telemetry_v11_domain_heads")} head
      JOIN ${table("telemetry_v11_domains")} domain ON domain.id=head.generation_id
     WHERE head.participant_id=$3`, [digest(`v11-event-${eventSeed}`), ownerDigest, participantId]);
}

/** A successor v1.1 generation (0029's chain shape) that the head can move to. */
async function insertV11Successor(pool, table, participantId, deviceId, generationId, previousGenerationId) {
  const token = digest(`token-v11-${generationId}`);
  const fingerprint = digest(`legacy-v11-${generationId}`);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
      from_day,through_day,winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,$5,0,$6::date,$6::date,'[]',$7,'2099-01-01T00:00:00.000Z')`,
  [token, participantId, deviceId, previousGenerationId, fingerprint, DAY, T.issued]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8::date,$8::date,'[]',$9)`,
  [generationId, participantId, deviceId, token, previousGenerationId, digest(`manifest-v11-${generationId}`), fingerprint,
    DAY, T.issued]);
}

async function pending(pool, quoted) {
  return Number((await pool.query(`SELECT ${quoted}.community_public_source_bootstrap_pending()::text AS pending`)).rows[0].pending);
}

test("PG17 an empty schema seeds the public-source bootstrap complete", { skip: SKIP, timeout: 120_000 },
  async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { advancePostgresPublicSourceBootstrap } = await authorityModule();
    assert.deepEqual(await bootstrapRow(pool, table), [{ singleton: 1, policy_version: "community-public-sources-v1",
      participant_cursor: "", source_day_cursor: "", completed: 1 }]);
    const client = await pool.connect();
    try {
      const result = await advancePostgresPublicSourceBootstrap(client, schema);
      assert.deepEqual(result, { completed: true, pending: 0 });
      assert.deepEqual(Object.keys(result), ["completed", "pending"], "only content-free counts are returned");
      assert.equal(await pending(pool, quoted), 0);
      // PostgreSQL ports no walk: a D1 walk cursor (a raw participant id or a
      // source day) is never stored, whether written or imported.
      const cursors = "community_public_source_bootstrap_cursors_empty";
      await violates(pool.query(`UPDATE ${table("community_public_source_bootstrap")} SET participant_cursor='synthetic-participant'`),
        cursors);
      await violates(pool.query(`UPDATE ${table("community_public_source_bootstrap")} SET source_day_cursor='2026-09-20'`), cursors);
      await pool.query(`DELETE FROM ${table("community_public_source_bootstrap")}`);
      await violates(pool.query(`INSERT INTO ${table("community_public_source_bootstrap")}
          (singleton,policy_version,participant_cursor,source_day_cursor,completed)
        VALUES (1,'community-public-sources-v1','synthetic-participant','',1)`), cursors);
      await assert.rejects(advancePostgresPublicSourceBootstrap(client, schema), unavailable,
        "a missing singleton is not a completed bootstrap");
    } finally {
      client.release();
    }
    await violates(pool.query(`INSERT INTO ${table("community_public_source_bootstrap")} VALUES (1,'community-public-sources-v2','','',1)`));
    await violates(pool.query(`INSERT INTO ${table("community_public_source_bootstrap")} VALUES (2,'community-public-sources-v1','','',1)`));
  }));

test("PG17 an eligible v1.1 head without its event source seeds the bootstrap incomplete until journaled",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { advancePostgresPublicSourceBootstrap: advance, capturePostgresCommunityAuthority: capture } =
      await authorityModule();
    assert.equal((await bootstrapRow(pool, table))[0].completed, 0, "discovery found un-journaled evidence");
    await initializeAuthority(pool, table);
    const client = await pool.connect();
    try {
      await assert.rejects(capture(client, schema), unavailable, "capture fails closed while the bootstrap is incomplete");
      assert.equal((await capture(client, schema, { retirement: true })).sourceId, SOURCE_ID);
      assert.deepEqual(await advance(client, schema), { completed: false, pending: 1 });
      assert.deepEqual(await advance(client, schema), { completed: false, pending: 1 }, "advancing is idempotent");
      assert.equal((await bootstrapRow(pool, table))[0].completed, 0);

      await journalV11Head(pool, table, "bootstrap-v11-pending", digest("owner-bootstrap-v11-pending"));
      assert.deepEqual(await advance(client, schema), { completed: true, pending: 0 });
      assert.equal((await bootstrapRow(pool, table))[0].completed, 1);
      assert.equal((await capture(client, schema)).sourceId, SOURCE_ID, "capture opens once complete");

      // Never reverts: new un-journaled evidence is visible to the predicate
      // but the completed row stays complete and advance is one locked read.
      await eligibleAccountlessV11(pool, table, "bootstrap-v11-later");
      assert.equal(await pending(pool, quoted), 1);
      assert.deepEqual(await advance(client, schema), { completed: true, pending: 0 });
      assert.equal((await bootstrapRow(pool, table))[0].completed, 1);
      await capture(client, schema);
    } finally {
      client.release();
    }
  }, {
    before: async ({ pool, table }) => {
      await eligibleAccountlessV11(pool, table, "bootstrap-v11-pending");
      await eligibleAccountlessV11(pool, table, "bootstrap-v11-journaled", { journaled: true });
    },
  }));

test("PG17 the bootstrap predicate follows D1's v1, v1.1 and v1.2 journal producers", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, quoted, table }) => {
    // Seeded at the baseline: an eligible owner's current accepted v1 chunk
    // without a typed_v1_event_sources row.
    assert.equal((await bootstrapRow(pool, table))[0].completed, 0);
    assert.equal(await pending(pool, quoted), 1);
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
      VALUES ('bootstrap-v1-social',$1,'active')`, [digest("owner-bootstrap-v1")]);
    // The typed receipt requires the chunk's one accepted record.
    await pool.query(`INSERT INTO ${table("telemetry_v1_records")} (
        chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,record_json
      ) SELECT id,participant_id,device_id,stream,'synthetic-occurrence-1','2026-09-20T01:00:00.000Z',chunk_day,'{}'
          FROM ${table("telemetry_v1_chunks")} WHERE id='bootstrap-chunk-current'`);
    await pool.query(`INSERT INTO ${table("typed_v1_event_sources")} (event_digest,owner_digest,participant_id,chunk_id,source_namespace)
      VALUES ($1,$2,'bootstrap-v1-social','bootstrap-chunk-current',$3)`,
    [digest("v1-event"), digest("owner-bootstrap-v1"), SOURCE_NAMESPACE]);
    assert.equal(await pending(pool, quoted), 0, "the journaled chunk is no longer pending");

    // v1.2: a head eligible for its device and without a receipt at
    // (generation, head revision).
    const participantId = "bootstrap-v12-social";
    const deviceId = "0d000000-0000-4000-8000-0000000012aa";
    await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'social','active',$2)`,
      [participantId, T.issued]);
    await insertSocialDevice(pool, table, participantId, deviceId, digest("secret-v12"));
    const domain = { generationId: "0a120000-0000-4000-8000-0000000012aa", manifestId: "0e120000-0000-4000-8000-0000000012aa",
      manifestState: "ready" };
    await insertV12Head(pool, table, participantId, deviceId, domain);
    assert.equal(await pending(pool, quoted), 1, "an eligible v1.2 head without its receipt is pending");
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state) VALUES ($1,$2,'active')`,
      [participantId, digest("owner-v12")]);
    await pool.query(`INSERT INTO ${table("storage_v12_event_sources")} (
        event_digest,owner_digest,participant_id,device_id,generation_id,previous_generation_id,manifest_digest,
        head_revision,recorded_ms
      ) VALUES ($1,$2,$3,$4,$5,NULL,$6,1,1)`,
    [digest("v12-event"), digest("owner-v12"), participantId, deviceId, domain.generationId,
      digest(`manifest-v12-${domain.generationId}`)]);
    assert.equal(await pending(pool, quoted), 0, "the receipt at the head revision journals it");
    await pool.query(`UPDATE ${table("telemetry_v12_domain_heads")} SET revision=2 WHERE participant_id=$1`, [participantId]);
    assert.equal(await pending(pool, quoted), 1, "a receipt for an older head revision does not journal the head");
  }, {
    before: async ({ pool, table }) => {
      const social = async (id, state = "active") => {
        await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'social',$2,$3)`,
          [id, state, T.issued]);
        const deviceId = `0d000000-0000-4000-8000-${digest(id).slice(0, 12)}`;
        await insertSocialDevice(pool, table, id, deviceId, digest(`secret-${id}`));
        return deviceId;
      };
      const chunk = (id, seq, overrides = {}) => ({ id, authorizationId: `auth-${id}`, chunkSeq: seq,
        acceptedRecordCount: 1, superseded: false, ...overrides });
      // Pending: current, accepted, eligible, no v1.1 head, no receipt.
      const current = await social("bootstrap-v1-social");
      await insertV1Chunk(pool, table, "bootstrap-v1-social", current, chunk("bootstrap-chunk-current", 0));
      // Not pending: superseded, unaccepted, an owner with a v1.1 head (D1
      // journals the head instead), and an ineligible (deleting) owner.
      await insertV1Chunk(pool, table, "bootstrap-v1-social", current, chunk("bootstrap-chunk-superseded", 1, { superseded: true }));
      await insertV1Chunk(pool, table, "bootstrap-v1-social", current, chunk("bootstrap-chunk-unaccepted", 2,
        { acceptedRecordCount: 0 }));
      const headed = await social("bootstrap-v1-headed");
      await insertV1Chunk(pool, table, "bootstrap-v1-headed", headed, chunk("bootstrap-chunk-headed", 0));
      await insertV11Head(pool, table, "bootstrap-v1-headed", headed, "0a110000-0000-4000-8000-00000000b1ed");
      await journalV11Head(pool, table, "bootstrap-v1-headed", digest("owner-bootstrap-v1-headed"));
      const deleting = await social("bootstrap-v1-deleting", "deleting");
      await insertV1Chunk(pool, table, "bootstrap-v1-deleting", deleting, chunk("bootstrap-chunk-deleting", 0));
    },
  }));

test("PG17 the bootstrap predicate keys accountless v1.2 heads on the eligible device and v1.1 heads on their generation",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    const current = { issuedAt: "2098-12-02T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", state: "active",
      revokedAt: null, revocationReason: null };
    const eligible = async (participantId) => (await pool.query(`SELECT owner_kind,device_id
      FROM ${table("community_public_source_owners")} WHERE participant_id=$1 ORDER BY device_id`, [participantId])).rows;
    const receiptV12 = async (participantId, deviceId, generationId, ownerDigest) => {
      await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
        VALUES ($1,$2,'active') ON CONFLICT (participant_id) DO NOTHING`, [participantId, ownerDigest]);
      await pool.query(`INSERT INTO ${table("storage_v12_event_sources")} (
          event_digest,owner_digest,participant_id,device_id,generation_id,previous_generation_id,manifest_digest,
          head_revision,recorded_ms
        ) VALUES ($1,$2,$3,$4,$5,NULL,$6,1,1)`,
      [digest(`v12-event-${participantId}`), ownerDigest, participantId, deviceId, generationId,
        digest(`manifest-v12-${generationId}`)]);
    };
    assert.equal(await pending(pool, quoted), 0);

    // An eligible accountless v1.2 successor install: its ready head on the
    // eligible device is pending until the receipt at (generation, revision).
    const successor = { id: "bootstrap-v12-accountless", deviceId: "0d000000-0000-4000-8000-0000000012ac",
      secretHash: digest("secret-v12-accountless") };
    const successorDomain = { generationId: "0a120000-0000-4000-8000-0000000012ac",
      manifestId: "0e120000-0000-4000-8000-0000000012ac", manifestState: "ready" };
    await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'accountless','active',$2)`,
      [successor.id, T.issued]);
    await insertAccountlessGraph(pool, table, successor, { ledger: current, owner: current, device: current, v11Grant: null,
      v12Grant: current, markerRetainedAt: null });
    await insertV12Head(pool, table, successor.id, successor.deviceId, successorDomain);
    assert.deepEqual(await eligible(successor.id), [{ owner_kind: "accountless", device_id: successor.deviceId }]);
    assert.equal(await pending(pool, quoted), 1, "an eligible accountless v1.2 head without its receipt is pending");
    await receiptV12(successor.id, successor.deviceId, successorDomain.generationId, digest("owner-v12-accountless"));
    assert.equal(await pending(pool, quoted), 0, "the receipt at the head revision journals it");

    // An accountless owner eligible only through its v1.1 device, whose v1.2
    // head is on another, ineligible device: that head is not evidence of an
    // eligible public source.
    const legacy = await eligibleAccountlessV11(pool, table, "bootstrap-v11-device-only", { journaled: true });
    const otherDevice = "0d000000-0000-4000-8000-0000000012ad";
    await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")} (
        device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
        state,issued_at,expires_at,revoked_at,revocation_reason,renewal_generation,renewed_at
      ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',
        'active',$4,$5,NULL,NULL,0,NULL)`,
    [otherDevice, Buffer.from(digest("secret-other-device"), "hex"), `authority-installation-${otherDevice}`,
      current.issuedAt, current.expiresAt]);
    await pool.query(`INSERT INTO ${table("device_credentials")} (
        id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,
        issued_at,expires_at,last_used_at,revoked_at,social_verified_at
      ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4,NULL,NULL)`,
    [otherDevice, legacy.id, Buffer.from(digest("secret-other-device"), "hex"), current.issuedAt, current.expiresAt]);
    await insertV12Head(pool, table, legacy.id, otherDevice, { generationId: "0a120000-0000-4000-8000-0000000012ad",
      manifestId: "0e120000-0000-4000-8000-0000000012ad", manifestState: "ready" });
    assert.deepEqual(await eligible(legacy.id), [{ owner_kind: "accountless", device_id: legacy.deviceId }]);
    assert.equal(await pending(pool, quoted), 0, "a v1.2 head on a device that is not eligible is not pending");

    // v1.1: a receipt for an earlier generation does not journal the head
    // after it moves to a successor generation.
    const moved = await eligibleAccountlessV11(pool, table, "bootstrap-v11-moved", { journaled: true });
    assert.equal(await pending(pool, quoted), 0);
    const successorGeneration = "0a110000-0000-4000-8000-0000000011a2";
    await insertV11Successor(pool, table, moved.id, moved.deviceId, successorGeneration, moved.generationId);
    await pool.query(`UPDATE ${table("telemetry_v11_domain_heads")} SET generation_id=$2,revision=2 WHERE participant_id=$1`,
      [moved.id, successorGeneration]);
    assert.equal(await pending(pool, quoted), 1, "the head's new generation has no receipt yet");
    await journalV11Head(pool, table, moved.id, moved.ownerDigest, `${moved.id}-successor`);
    assert.equal(await pending(pool, quoted), 0, "the receipt for the head's generation journals it");
  }));

test("PG17 the bootstrap step runs with the runtime's table grants alone and is refused in a transfer session",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { advancePostgresPublicSourceBootstrap } = await authorityModule();
    const local = await endpoint();
    const suffix = randomBytes(4).toString("hex");
    const member = `synthetic_an_member_${suffix}`;
    const runtime = `synthetic_an_runtime_${suffix}`;
    const bare = `synthetic_an_bare_${suffix}`;
    const asLogin = async (role, body) => {
      const session = new pg.Client({ ...local, user: role, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, ssl: false,
        application_name: "pg-community-authority-test" });
      await session.connect();
      try {
        return await body(session);
      } finally {
        await session.end();
      }
    };
    const lock = await pool.connect();
    let locked = false;
    let rolesCreated = false;
    let roleCreated = false;
    try {
      await lock.query("SELECT pg_advisory_lock($1)", [TRANSFER_ROLE_LOCK]);
      locked = true;
      await pool.query(`CREATE ROLE ${member} LOGIN NOSUPERUSER NOCREATEROLE`);
      await pool.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEROLE`);
      await pool.query(`CREATE ROLE ${bare} LOGIN NOSUPERUSER NOCREATEROLE`);
      rolesCreated = true;
      await pool.query(`GRANT USAGE ON SCHEMA ${quoted} TO ${member}, ${runtime}, ${bare}`);
      // The Cloud Run runtime grant (cloud-run/test-migrations.mjs): table DML
      // on every relation, and no grant on this function.
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoted} TO ${member}, ${runtime}`);
      roleCreated = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [TRANSFER_ROLE])).rowCount === 0;
      if (roleCreated) await pool.query(`CREATE ROLE ${TRANSFER_ROLE} NOLOGIN`);
      await pool.query(`GRANT ${TRANSFER_ROLE} TO ${member}`);
      const privileges = await pool.query(`SELECT has_function_privilege($1, $3, 'EXECUTE') AS runtime,
          has_function_privilege($2, $3, 'EXECUTE') AS bare`,
      [runtime, bare, `${quoted}.community_public_source_bootstrap_advance()`]);
      assert.deepEqual(privileges.rows[0], { runtime: true, bare: true }, "EXECUTE is the default PUBLIC grant");

      // A login without table privileges is refused by the tables, not by a
      // function grant, and the bootstrap row is unchanged.
      await pool.query(`UPDATE ${table("community_public_source_bootstrap")} SET completed=0`);
      await asLogin(bare, async (session) => {
        await assert.rejects(advancePostgresPublicSourceBootstrap(session, schema), (error) => error?.code === "42501"
          && /community_public_source_bootstrap/u.test(error.message));
      });
      assert.equal((await bootstrapRow(pool, table))[0].completed, 0);

      // A transfer session is refused before it reads anything, whatever it
      // may write.
      await asLogin(member, async (session) => {
        assert.equal((await session.query(`SELECT ${quoted}.storage_journal_transfer_session() AS transfer`)).rows[0].transfer, true);
        await refuses(session.query(`SELECT * FROM ${quoted}.community_public_source_bootstrap_advance()`),
          "community_public_source_bootstrap_transfer_session");
        await assert.rejects(advancePostgresPublicSourceBootstrap(session, schema), (error) => error instanceof Error
          && error.message === "COMMUNITY_PUBLIC_SOURCE_BOOTSTRAP_TRANSFER_SESSION");
      });
      assert.equal((await bootstrapRow(pool, table))[0].completed, 0);

      // The runtime login completes it with its table grants alone.
      await asLogin(runtime, async (session) => {
        assert.equal((await session.query(`SELECT ${quoted}.storage_journal_transfer_session() AS transfer`)).rows[0].transfer, false);
        assert.deepEqual(await advancePostgresPublicSourceBootstrap(session, schema), { completed: true, pending: 0 });
        assert.deepEqual(await advancePostgresPublicSourceBootstrap(session, schema), { completed: true, pending: 0 });
      });
      assert.equal((await bootstrapRow(pool, table))[0].completed, 1);
    } finally {
      if (rolesCreated) {
        await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoted} FROM ${member}, ${runtime}`).catch(() => {});
        await pool.query(`REVOKE ALL ON SCHEMA ${quoted} FROM ${member}, ${runtime}, ${bare}`).catch(() => {});
        if (roleCreated) {
          await pool.query(`DROP ROLE IF EXISTS ${TRANSFER_ROLE}`);
        } else {
          await pool.query(`REVOKE ${TRANSFER_ROLE} FROM ${member}`).catch(() => {});
        }
        for (const role of [member, runtime, bare]) await pool.query(`DROP ROLE IF EXISTS ${role}`);
      }
      if (locked) await lock.query("SELECT pg_advisory_unlock($1)", [TRANSFER_ROLE_LOCK]).catch(() => {});
      lock.release();
    }
  }));

// ---------------------------------------------------------------------------
// Daily heads, authority columns and the erasure fence.

function dailyPayload(day, revision) {
  return JSON.stringify({ schemaVersion: "community-daily-aggregate-v1.0", day, revision });
}

async function insertJsonDaily(pool, table, day, revision) {
  const payload = dailyPayload(day, revision);
  await pool.query(`INSERT INTO ${table("community_daily_aggregates")} (
      source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,source_cursor_sequence,
      policy_revision,collection_revision,release_state,released_at
    ) VALUES ($1,$2,$3::date,$4,$5,$6,0,0,1,1,'published','2026-09-21T00:00:00.000Z')`,
  [SOURCE_ID, SOURCE_NAMESPACE, day, revision, payload, digest(payload)]);
}

function pin(overrides = {}) {
  return {
    sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, publicAuthorityEpoch: 5, policyRevision: 1,
    collectionRevision: 2, graphInvalidationEpoch: 3, sourceEpoch: 4, sequence: 9, ...overrides,
  };
}

async function insertAuthorityDaily(pool, table, day, revision, {
  authority = pin(), json, provenance = "gcp", importReceiptId = null, deviceMethod = "contributing-devices-by-reader-v1",
  releasedAt = "2026-09-21T01:02:03.456Z", releasedAtIso = releasedAt, cohortDigest = digest(`cohort-${day}-${revision}`),
} = {}) {
  const authorityJson = json ?? JSON.stringify(deviceMethod === null ? authority : { ...authority, dailyDeviceMethod: deviceMethod });
  const payload = dailyPayload(day, revision);
  await pool.query(`INSERT INTO ${table("community_daily_aggregates")} (
      source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,source_cursor_sequence,
      policy_revision,collection_revision,release_state,released_at,public_authority_epoch,source_mutation_epoch,
      journal_sequence,graph_invalidation_epoch,cohort_digest,provenance,import_receipt_id,released_at_iso,authority_json,
      daily_device_method
    ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,'published',$11,$7,$12,$8,$13,$14,$15,$16,$17,$18,$19)`,
  [SOURCE_ID, SOURCE_NAMESPACE, day, revision, payload, digest(payload), authority.publicAuthorityEpoch,
    authority.sequence, authority.policyRevision, authority.collectionRevision, releasedAt, authority.sourceEpoch,
    authority.graphInvalidationEpoch, cohortDigest, provenance, importReceiptId, releasedAtIso, authorityJson, deviceMethod]);
}

const PREVIEW_PAYLOAD = JSON.stringify({ generatedAt: "2026-09-21T00:00:00.000Z", models: [] });

/** Insert or replace the source's graph preview, through the fence on both paths. */
function upsertPreview(queryable, table, authority, overrides = {}) {
  const row = {
    revision: 1, method: "synthetic-graph-method", cohort: digest("preview-cohort"), json: JSON.stringify(authority),
    payload: PREVIEW_PAYLOAD, hash: digest(PREVIEW_PAYLOAD), generatedAt: "2026-09-21T00:00:00.000Z", oldest: 1, newest: 2,
    provenance: "gcp", receipt: null, ...overrides,
  };
  return queryable.query(`INSERT INTO ${table("community_graph_previews")} (
      source_id,source_namespace,revision,method,cohort_digest,authority_json,public_authority_epoch,policy_revision,
      collection_revision,source_mutation_epoch,journal_sequence,graph_invalidation_epoch,model_revision,payload_json,
      payload_sha256,generated_at,snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms,provenance,
      import_receipt_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15,$10,1,$16,$17,$18,$19)
    ON CONFLICT (source_id) DO UPDATE SET revision=EXCLUDED.revision,authority_json=EXCLUDED.authority_json,
      public_authority_epoch=EXCLUDED.public_authority_epoch,source_mutation_epoch=EXCLUDED.source_mutation_epoch,
      journal_sequence=EXCLUDED.journal_sequence,snapshot_source_epoch=EXCLUDED.snapshot_source_epoch`,
  [SOURCE_ID, SOURCE_NAMESPACE, row.revision, row.method, row.cohort, row.json, authority.publicAuthorityEpoch,
    authority.policyRevision, authority.collectionRevision, authority.sourceEpoch, authority.sequence,
    authority.graphInvalidationEpoch, row.payload, row.hash, row.generatedAt, row.oldest, row.newest, row.provenance,
    row.receipt]);
}

test("PG17 daily heads refuse revision gaps, seed from existing revisions and are never deleted",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, table }) => {
    const heads = async () => (await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,revision::int AS revision,cohort_digest
      FROM ${table("community_daily_heads")} WHERE source_id=$1 ORDER BY day`, [SOURCE_ID])).rows;
    assert.deepEqual(await heads(), [{ day: "2026-09-18", revision: 2, cohort_digest: null }],
      "existing JSON-mode revisions seed their day's head");
    await assert.rejects(insertJsonDaily(pool, table, "2026-09-18", 2), (error) => error?.code === "P1005" || error?.code === "23505");
    await refuses(insertJsonDaily(pool, table, "2026-09-18", 4), "community_daily_revision_conflict");
    await insertJsonDaily(pool, table, "2026-09-18", 3);
    await refuses(insertJsonDaily(pool, table, "2026-09-19", 2), "community_daily_revision_conflict");
    await insertJsonDaily(pool, table, "2026-09-19", 1);
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch) VALUES ($1,0,0)`,
      [SOURCE_ID]);
    await insertAuthorityDaily(pool, table, "2026-09-19", 2, { cohortDigest: digest("cohort-authority") });
    assert.deepEqual(await heads(), [
      { day: "2026-09-18", revision: 3, cohort_digest: null },
      { day: "2026-09-19", revision: 2, cohort_digest: digest("cohort-authority") },
    ]);
    await refuses(pool.query(`DELETE FROM ${table("community_daily_heads")}`), "community_daily_head_retained");
    await refuses(pool.query(`TRUNCATE ${table("community_daily_heads")}`), "community_publication_proof_retained");
    await refuses(pool.query(`UPDATE ${table("community_daily_heads")} SET revision=revision+2`), "community_daily_head_immutable");
    await refuses(pool.query(`UPDATE ${table("community_daily_heads")} SET revision=revision-1`), "community_daily_head_immutable");
    await refuses(pool.query(`UPDATE ${table("community_daily_heads")} SET day=day+1 WHERE day='2026-09-19'`),
      "community_daily_head_immutable");
    // The existing immutable-revision contract still admits withdrawal.
    await pool.query(`UPDATE ${table("community_daily_aggregates")} SET release_state='withdrawn',withdrawn_at=clock_timestamp()
      WHERE day='2026-09-19'`);
    await refuses(pool.query(`UPDATE ${table("community_daily_aggregates")} SET daily_device_method=NULL WHERE day='2026-09-19'`),
      "community_daily_revision_immutable");
  }, {
    before: async ({ pool, table }) => {
      await insertJsonDaily(pool, table, "2026-09-18", 1);
      await insertJsonDaily(pool, table, "2026-09-18", 2);
    },
  }));

test("PG17 the daily authority fence refuses stale or inconsistent pins and keeps JSON-mode rows unchanged",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, table }) => {
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch) VALUES ($1,4,5)`,
      [SOURCE_ID]);
    let revision = 0;
    const day = "2026-09-20";
    const accept = async (options) => { await insertAuthorityDaily(pool, table, day, revision + 1, options); revision += 1; };
    const reject = async (options, message) => refuses(insertAuthorityDaily(pool, table, day, revision + 1, options), message);
    const shape = async (options) => violates(insertAuthorityDaily(pool, table, day, revision + 1,
      { authority: pin({ publicAuthorityEpoch: 8 }), ...options }), "community_daily_aggregates_authority_shape");

    await accept({});
    await reject({ authority: pin({ publicAuthorityEpoch: 4 }) }, "analytics_publication_authority_stale");
    await accept({ deviceMethod: null });
    // A source-proven erasure fence raises the floor above the cursor.
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
        terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,5,2,2,7)`,
    [SOURCE_ID, digest("fence-owner"), digest("fence-event")]);
    await reject({ authority: pin({ publicAuthorityEpoch: 6 }) }, "analytics_publication_authority_stale");
    await accept({ authority: pin({ publicAuthorityEpoch: 7 }) });
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
        terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ('synthetic-other-source',$1,$2,5,2,2,99)`,
    [digest("fence-owner"), digest("fence-event")]);
    // Another source's fence does not fence this one.
    await accept({ authority: pin({ publicAuthorityEpoch: 7 }) });

    // The verbatim authority text must be exactly the pinned Worker authority.
    const current = pin({ publicAuthorityEpoch: 8 });
    for (const [label, json] of [
      ["sourceId", JSON.stringify({ ...current, sourceId: "synthetic-other-source", dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["sourceNamespace", JSON.stringify({ ...current, sourceNamespace: "x", dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["epoch", JSON.stringify({ ...current, publicAuthorityEpoch: 9, dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["string epoch", JSON.stringify({ ...current, publicAuthorityEpoch: "8", dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["fractional", JSON.stringify({ ...current, sequence: 9.5, dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["missing key", JSON.stringify({ ...current, graphInvalidationEpoch: undefined, dailyDeviceMethod: "contributing-devices-by-reader-v1" })],
      ["extra key", JSON.stringify({ ...current, dailyDeviceMethod: "contributing-devices-by-reader-v1", ownerDigest: digest("x") })],
      ["device method", JSON.stringify({ ...current, dailyDeviceMethod: "other-method" })],
      ["device method absent", JSON.stringify(current)],
    ]) {
      await refuses(insertAuthorityDaily(pool, table, day, revision + 1, { authority: current, json }),
        "community_publication_authority_mismatch", label);
    }
    await reject({ authority: current, deviceMethod: null,
      json: JSON.stringify({ ...current, dailyDeviceMethod: "contributing-devices-by-reader-v1" }) },
    "community_publication_authority_mismatch");
    await accept({ authority: current });

    // Shape: an authority row carries every pin; a JSON-mode row none.
    await shape({ releasedAtIso: "2026-09-21T01:02:03.457Z" });
    await shape({ provenance: "d1_import" });
    await shape({ importReceiptId: "00000000-0000-4000-8000-000000000001" });
    await accept({ provenance: "d1_import", importReceiptId: "00000000-0000-4000-8000-000000000001", authority: current });
    await violates(insertAuthorityDaily(pool, table, day, revision + 1, { authority: current, provenance: "other" }));
    await violates(insertAuthorityDaily(pool, table, day, revision + 1, { deviceMethod: "Bad Method",
      json: JSON.stringify({ ...current, dailyDeviceMethod: "Bad Method" }), authority: current }));
    const payload = dailyPayload(day, revision + 1);
    await violates(pool.query(`INSERT INTO ${table("community_daily_aggregates")} (
        source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,source_cursor_sequence,
        policy_revision,collection_revision,release_state,released_at,cohort_digest
      ) VALUES ($1,$2,$3::date,$4,$5,$6,0,0,1,1,'published','2026-09-21T00:00:00.000Z',$7)`,
    [SOURCE_ID, SOURCE_NAMESPACE, day, revision + 1, payload, digest(payload), digest("partial")]),
    "community_daily_aggregates_authority_shape");
    // A JSON-mode row below every floor is still governed by 0037 alone.
    await insertJsonDaily(pool, table, day, revision + 1);
    const stored = await pool.query(`SELECT revision::int AS revision,provenance,public_authority_epoch::int AS epoch,
        daily_device_method,released_at_iso FROM ${table("community_daily_aggregates")} WHERE day=$1 ORDER BY revision`, [day]);
    assert.deepEqual(stored.rows.map((row) => [row.revision, row.provenance, row.epoch, row.daily_device_method]), [
      [1, "gcp", 5, "contributing-devices-by-reader-v1"],
      [2, "gcp", 5, null],
      [3, "gcp", 7, "contributing-devices-by-reader-v1"],
      [4, "gcp", 7, "contributing-devices-by-reader-v1"],
      [5, "gcp", 8, "contributing-devices-by-reader-v1"],
      [6, "d1_import", 8, "contributing-devices-by-reader-v1"],
      [7, null, null, null],
    ]);
    assert.equal(stored.rows[0].released_at_iso, "2026-09-21T01:02:03.456Z");
  }));

// ---------------------------------------------------------------------------

test("PG17 erasure fences and receipts are immutable retained proof", { skip: SKIP, timeout: 120_000 },
  async () => withSchema(async ({ pool, table }) => {
    const owner = digest("fence-proof-owner");
    const fence = (values) => pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,
        terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    values);
    await violates(fence([SOURCE_ID, "A".repeat(64), digest("e"), 1, 1, 1, 1]));
    await violates(fence([SOURCE_ID, owner, digest("e"), 0, 1, 1, 1]));
    await violates(fence([SOURCE_ID, owner, digest("e"), 1, 1, 1, 0]));
    await fence([SOURCE_ID, owner, digest("terminal"), 3, 2, 2, 4]);
    await assert.rejects(fence([SOURCE_ID, owner, digest("terminal"), 3, 2, 2, 4]), (error) => error?.code === "23505");
    await pool.query(`UPDATE ${table("analytics_storage_erasure_fences")} SET public_authority_epoch=public_authority_epoch`);
    await refuses(pool.query(`UPDATE ${table("analytics_storage_erasure_fences")} SET public_authority_epoch=5`),
      "storage_erasure_fence_conflict");
    await refuses(pool.query(`DELETE FROM ${table("analytics_storage_erasure_fences")}`), "storage_erasure_fence_retained");
    await refuses(pool.query(`TRUNCATE ${table("analytics_storage_erasure_fences")},${table("analytics_storage_erasure_receipts")}`),
      "community_publication_proof_retained");
    const receipt = (values) => pool.query(`INSERT INTO ${table("analytics_storage_erasure_receipts")} (source_id,owner_digest,
        terminal_event_digest,payload_contract) VALUES ($1,$2,$3,$4)`, values);
    await assert.rejects(receipt([SOURCE_ID, digest("unfenced"), digest("terminal"), 1]), (error) => error?.code === "23503");
    await violates(receipt([SOURCE_ID, owner, digest("terminal"), 2]));
    await receipt([SOURCE_ID, owner, digest("terminal"), 1]);
    await refuses(pool.query(`UPDATE ${table("analytics_storage_erasure_receipts")} SET payload_contract=1`),
      "storage_erasure_receipt_immutable");
    await refuses(pool.query(`DELETE FROM ${table("analytics_storage_erasure_receipts")}`), "storage_erasure_receipt_retained");
    await refuses(pool.query(`TRUNCATE ${table("analytics_storage_erasure_receipts")}`), "community_publication_proof_retained");
  }));

test("PG17 graph previews carry the full pin and are fenced on insert and update", { skip: SKIP, timeout: 120_000 },
  async () => withSchema(async ({ pool, table }) => {
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch) VALUES ($1,4,5)`,
      [SOURCE_ID]);
    const preview = (authority, overrides = {}) => upsertPreview(pool, table, authority, overrides);
    await refuses(preview(pin({ publicAuthorityEpoch: 4 })), "analytics_publication_authority_stale");
    await refuses(preview(pin(), { json: JSON.stringify({ ...pin(), sequence: 10 }) }), "community_publication_authority_mismatch");
    await refuses(preview(pin(), { json: JSON.stringify({ ...pin(), dailyDeviceMethod: "contributing-devices-by-reader-v1" }) }),
      "community_publication_authority_mismatch");
    await violates(preview(pin(), { hash: digest("other payload") }));
    await violates(preview(pin(), { generatedAt: "2026-09-21T00:00:00Z" }));
    await violates(preview(pin(), { oldest: 3, newest: 2 }));
    await violates(preview(pin(), { oldest: null }));
    await violates(preview(pin(), { provenance: "d1_import" }));
    await violates(preview(pin(), { payload: "x".repeat(262_145), hash: digest("x".repeat(262_145)) }));
    await preview(pin());
    await preview(pin({ publicAuthorityEpoch: 6, sourceEpoch: 5, sequence: 11 }), { revision: 2 });
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
        terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,5,2,2,9)`,
    [SOURCE_ID, digest("preview-fence-owner"), digest("preview-fence-event")]);
    await refuses(preview(pin({ publicAuthorityEpoch: 8 }), { revision: 3 }), "analytics_publication_authority_stale");
    await refuses(pool.query(`UPDATE ${table("community_graph_previews")} SET revision=revision+1`),
      "analytics_publication_authority_stale", "a proof-only update below the fence is refused too");
    await preview(pin({ publicAuthorityEpoch: 9 }), { revision: 3 });
    const stored = await pool.query(`SELECT revision::int AS revision,public_authority_epoch::int AS epoch,provenance
      FROM ${table("community_graph_previews")}`);
    assert.deepEqual(stored.rows, [{ revision: 3, epoch: 9, provenance: "gcp" }]);
  }));

/** A dedicated connection, so one transaction can stay open across awaits. */
async function openSession() {
  const session = new pg.Client({ ...await endpoint(), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, application_name: "pg-community-authority-test" });
  await session.connect();
  await session.query("SET lock_timeout='20s'");
  const pid = (await session.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  return Object.assign(session, { pid });
}

/** Resolve once `session` is blocked on a heavyweight lock. */
async function waitsOnLock(pool, session) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [session.pid])).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.fail("the session never waited on a row lock");
}

/** Settle a promise into its error (or null) so a pending rejection is never unhandled. */
const outcome = (promise) => promise.then(() => null, (error) => error);
const serializationFailure = (error) => error?.code === "40001";

test("PG17 the write-side fence is linearizable with concurrent erasure fences and cursor advances",
  { skip: SKIP, timeout: 240_000 }, async () => withSchema(async ({ pool, table }) => {
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")}(source_id,sequence,authority_epoch) VALUES ($1,4,5)`,
      [SOURCE_ID]);
    let fenced = 0;
    const fence = (queryable, publicEpoch) => {
      fenced += 1;
      return queryable.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,
          terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
        VALUES ($1,$2,$3,$4,2,2,$5)`,
      [SOURCE_ID, digest(`race-owner-${fenced}`), digest(`race-event-${fenced}`), fenced, publicEpoch]);
    };
    const daily = (queryable, day, publicAuthorityEpoch) => insertAuthorityDaily(queryable, table, day, 1,
      { authority: pin({ publicAuthorityEpoch }) });
    const watermarks = async () => Number((await pool.query(`SELECT count(*) AS count
      FROM ${table("community_terminal_watermarks")}`)).rows[0].count);
    const writer = await openSession();
    const other = await openSession();
    try {
      // REPEATABLE READ, the daily publisher's level. The source's first fence
      // commits after the writer's snapshot; its snapshot still shows no
      // fence, and the watermark row the fence created makes the write fail
      // rather than commit a pin below the erasure.
      assert.equal(await watermarks(), 0);
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writer.query(`SELECT count(*) FROM ${table("community_daily_aggregates")}`);
      await fence(pool, 10);
      assert.ok(serializationFailure(await outcome(daily(writer, "2026-09-10", 5))),
        "a writer whose snapshot predates the source's first fence cannot commit below it");
      await writer.query("ROLLBACK");
      await refuses(daily(pool, "2026-09-10", 5), "analytics_publication_authority_stale");

      // The same once the watermark row exists: a later fence updates it.
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writer.query(`SELECT count(*) FROM ${table("community_daily_aggregates")}`);
      await fence(pool, 12);
      assert.ok(serializationFailure(await outcome(daily(writer, "2026-09-11", 11))),
        "a writer whose snapshot predates a fence cannot commit below it");
      await writer.query("ROLLBACK");

      // READ COMMITTED: a fence still in flight holds the watermark row; the
      // writer waits for it and then reads the committed fence.
      await other.query("BEGIN");
      await fence(other, 20);
      await writer.query("BEGIN");
      const waiting = outcome(daily(writer, "2026-09-12", 14));
      await waitsOnLock(pool, writer);
      await other.query("COMMIT");
      const refused = await waiting;
      assert.equal(refused?.code, "P1005");
      assert.equal(refused?.message, "analytics_publication_authority_stale");
      await writer.query("ROLLBACK");

      // A writer that locks first orders before a later fence: the fence
      // waits for its commit, so the publication is that erasure's to contain.
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await daily(writer, "2026-09-13", 20);
      await other.query("BEGIN");
      const fencing = outcome(fence(other, 30));
      await waitsOnLock(pool, other);
      await writer.query("COMMIT");
      assert.equal(await fencing, null);
      await other.query("COMMIT");
      const committed = await pool.query(`SELECT public_authority_epoch::int AS epoch FROM ${table("community_daily_aggregates")}
        WHERE day='2026-09-13'`);
      assert.deepEqual(committed.rows, [{ epoch: 20 }]);
      await refuses(daily(pool, "2026-09-14", 20), "analytics_publication_authority_stale");

      // Graph previews are replaced in place: a stale writer cannot overwrite
      // a good preview either.
      await upsertPreview(pool, table, pin({ publicAuthorityEpoch: 30 }));
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writer.query(`SELECT count(*) FROM ${table("community_graph_previews")}`);
      await fence(pool, 40);
      assert.ok(serializationFailure(await outcome(upsertPreview(writer, table, pin({ publicAuthorityEpoch: 35 }),
        { revision: 2 }))), "a stale preview writer cannot replace the preview after a fence");
      await writer.query("ROLLBACK");
      const preview = await pool.query(`SELECT revision::int AS revision,public_authority_epoch::int AS epoch
        FROM ${table("community_graph_previews")}`);
      assert.deepEqual(preview.rows, [{ revision: 1, epoch: 30 }]);

      // The delivered cursor half of the floor, under both levels.
      await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writer.query(`SELECT count(*) FROM ${table("community_daily_aggregates")}`);
      await pool.query(`UPDATE ${table("analytics_source_cursors")} SET sequence=9,authority_epoch=45 WHERE source_id=$1`,
        [SOURCE_ID]);
      assert.ok(serializationFailure(await outcome(daily(writer, "2026-09-15", 40))),
        "a writer whose snapshot predates a cursor advance cannot commit below it");
      await writer.query("ROLLBACK");
      await other.query("BEGIN");
      await other.query(`UPDATE ${table("analytics_source_cursors")} SET sequence=10,authority_epoch=50 WHERE source_id=$1`,
        [SOURCE_ID]);
      await writer.query("BEGIN");
      const behind = outcome(daily(writer, "2026-09-15", 46));
      await waitsOnLock(pool, writer);
      await other.query("COMMIT");
      assert.equal((await behind)?.message, "analytics_publication_authority_stale");
      await writer.query("ROLLBACK");
      await daily(pool, "2026-09-15", 50);
    } finally {
      for (const session of [writer, other]) {
        await session.query("ROLLBACK").catch(() => {});
        await session.end().catch(() => {});
      }
    }
  }));

// ---------------------------------------------------------------------------

test("PG17 analytics owner retirement keeps erasure fences and receipts as retained proof", { skip: SKIP, timeout: 180_000 },
  async () => withSchema(async ({ pool, schema, table }) => {
    const { retirePostgresAnalyticsOwner, hasPostgresAnalyticsOwnerResidue } =
      await workerModule("/src/postgres-analytics-owner-retirement.ts");
    const owner = digest("retired-owner");
    const participantId = "synthetic-retired-owner";
    await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'accountless','active',$2)`,
      [participantId, T.issued]);
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state) VALUES ($1,$2,'active')`,
      [participantId, owner]);
    await pool.query(`DELETE FROM ${table("participants")} WHERE id=$1`, [participantId]);
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_fences")} (source_id,owner_digest,terminal_event_digest,
        terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch) VALUES ($1,$2,$3,5,2,2,6)`,
    [SOURCE_ID, owner, digest("retired-terminal")]);
    await pool.query(`INSERT INTO ${table("analytics_storage_erasure_receipts")} (source_id,owner_digest,terminal_event_digest,
        payload_contract) VALUES ($1,$2,$3,1)`, [SOURCE_ID, owner, digest("retired-terminal")]);
    const options = { primaryPool: pool, ownerDigest: owner, schema: { primarySchema: schema } };
    assert.equal(await hasPostgresAnalyticsOwnerResidue(options), false, "retained proof is not residue");
    const result = await retirePostgresAnalyticsOwner(options);
    assert.equal(result.status, "complete", "the closed owner inventory accepts the 0053 relations");
    const retained = await pool.query(`SELECT
        (SELECT count(*)::int FROM ${table("analytics_storage_erasure_fences")} WHERE owner_digest=$1) AS fences,
        (SELECT count(*)::int FROM ${table("analytics_storage_erasure_receipts")} WHERE owner_digest=$1) AS receipts`, [owner]);
    assert.deepEqual(retained.rows[0], { fences: 1, receipts: 1 });
    assert.equal((await retirePostgresAnalyticsOwner(options)).status, "complete", "retirement stays replay-safe");
  }));
