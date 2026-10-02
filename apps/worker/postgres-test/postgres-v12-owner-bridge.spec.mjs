import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { telemetryV12DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for the v1.2 owner bridge, primary migration
 * 0055_v12_owner_bridge.sql. Until the staged-migration harness is merged,
 * each schema receives every primary migration numbered below 0055 through
 * the migration runner (copied into a private root, so the pre-bridge
 * baseline stays exact before and after promotion and after later waves),
 * then 0055 in one transaction under the runner's search path. 0055 is read
 * from staged-migrations/ or, once promoted, from migrations/.
 *
 * Connection profiles: the private Unix socket (PG_TEST_SOCKET) or loopback
 * TCP (PG_TEST_HOST=127.0.0.1, ::1 or localhost). Without either, every
 * database test skips; a skip is not a pass. Every row is synthetic and
 * content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_ROOT = join(WORKER_ROOT, "postgres", "migrations");
const BRIDGE_MIGRATION = "0055_v12_owner_bridge.sql";
const BRIDGE_VERSION = Number(BRIDGE_MIGRATION.slice(0, 4));
const BRIDGE_LOCATIONS = Object.freeze([
  join(WORKER_ROOT, "postgres", "staged-migrations", "primary", BRIDGE_MIGRATION),
  join(MIGRATIONS_ROOT, "primary", BRIDGE_MIGRATION),
]);
const AUTHORITY_MIGRATION = "0046_owner_journal_authority.sql";
const SOURCE_ID = "synthetic-v12-bridge-source";
const TRANSFER_ROLE = "tibotattle_source_transfer";
// The cluster-global transfer role is created, granted and dropped only under
// the same advisory lock the owner-journal authority spec holds.
const TRANSFER_ROLE_LOCK = 460_046;
const CONSTANT_MESSAGE = /^[a-z][a-z0-9_]{2,80}$/u;
const DAY_1 = "2026-09-20";
const DAY_2 = "2026-09-21";
const HOUR_MS = 60 * 60 * 1_000;

let bridge;
/** 0055 from staged-migrations/ or, after promotion, migrations/: exactly one. */
async function readBridge() {
  if (bridge === undefined) {
    const found = [];
    for (const path of BRIDGE_LOCATIONS) {
      try {
        found.push(await readFile(path, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    assert.equal(found.length, 1, "0055 is either staged or promoted, never both or neither");
    bridge = found[0];
  }
  return bridge;
}

let baselineRoot;
/** A private migrations root holding every primary migration below 0055. */
function baselineMigrationsRoot() {
  baselineRoot ??= (async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-v12-bridge-baseline-")));
    await mkdir(join(directory, "primary"), { mode: 0o700 });
    const names = (await readdir(join(MIGRATIONS_ROOT, "primary")))
      .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name) && Number(name.slice(0, 4)) < BRIDGE_VERSION)
      .sort();
    assert.ok(names.includes(AUTHORITY_MIGRATION), "the bridge applies on top of the owner-journal authority");
    for (const name of names) await copyFile(join(MIGRATIONS_ROOT, "primary", name), join(directory, "primary", name));
    return directory;
  })();
  return baselineRoot;
}

const digest = (seed) => createHash("sha256").update(String(seed)).digest("hex");

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "v1.2 bridge tests require loopback or a private Unix socket");
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

async function poolOptions(applicationName, max = 12) {
  return {
    ...await endpoint(), user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, max, connectionTimeoutMillis: 5_000, application_name: applicationName,
  };
}

async function connection() {
  if (!sharedPool) {
    sharedPool = new pg.Pool(await poolOptions("pg-v12-owner-bridge-test"));
    const version = await sharedPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "the v1.2 bridge is qualified on PostgreSQL 17");
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
  const directory = await baselineRoot?.catch(() => null);
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function applyBridge(pool, schema, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql ?? await readBridge());
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function tableIn(schema) {
  const quoted = `"${schema}"`;
  return (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted}."${name}"`;
  };
}

/**
 * Run `body` against a fresh schema at the pre-bridge baseline, plus 0055
 * unless `bridged` is false.
 */
async function withSchema(body, { bridged = true } = {}) {
  const pool = await connection();
  const schema = `v12_bridge_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = tableIn(schema);
  await pool.query(`CREATE SCHEMA ${quoted}`);
  try {
    const rootDirectory = await baselineMigrationsRoot();
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory });
    assert.ok(applied.migrations.at(-1).version < BRIDGE_VERSION);
    if (bridged) await applyBridge(pool, schema);
    await body({ pool, schema, quoted, table });
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

// ---------------------------------------------------------------------------
// Fixtures.

async function initializeSource(pool, table, epoch = 5) {
  await pool.query(`INSERT INTO ${table("storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,$2)`,
    [SOURCE_ID, epoch]);
}

async function activateRuntime(pool, table) {
  await pool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active', changed_at=clock_timestamp() WHERE id=1`);
  await pool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active', changed_at=clock_timestamp() WHERE id=1`);
}

/** A v1.2-only accountless owner; the lease is equal-expiry unless told otherwise. */
async function seedAccountless(pool, table, {
  expiresAt = new Date(Date.now() + 30 * 24 * HOUR_MS),
  successorExpiresAt = expiresAt,
  deviceState = "active",
  participantState = "active",
  participantId = `participant:${randomUUID()}`,
} = {}) {
  const deviceId = randomUUID();
  const issuedAt = new Date(Date.now() - HOUR_MS);
  const secret = randomBytes(32);
  await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")} (
      device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
      state,issued_at,expires_at
    ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1','active',$4,$5)`,
  [deviceId, secret, `synthetic-install-${deviceId}`, issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at,deletion_session_id)
    VALUES ($1,'accountless',$2,$3,$4)`,
  [participantId, participantState, issuedAt, participantState === "deleting" ? randomUUID() : null]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,
      issued_at,expires_at,last_used_at,revoked_at
    ) VALUES ($1,$2,'accountless',$1,$3,$4,$5,$6,$5,$7)`,
  [deviceId, participantId, secret, deviceState, issuedAt, expiresAt, deviceState === "revoked" ? issuedAt : null]);
  await pool.query(`INSERT INTO ${table("accountless_upload_owners")} (
      enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
      authorized_at,expires_at,state
    ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
  [deviceId, participantId, issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${table("accountless_v12_device_authorizations")} (
      enrollment_device_id,participant_id,device_credential_id,schema_version,policy_version,
      authorization_basis,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
      authorized_at,expires_at,state
    ) VALUES ($1,$2,$1,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1',
      'accountless-policy-v1.2','telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`,
  [deviceId, participantId, issuedAt, successorExpiresAt]);
  return { participantId, deviceId };
}

/** A social owner with one paired v1.2 device, optionally with an existing owner link. */
async function seedSocial(pool, table, {
  consentVersion, state = "active", link = null, participantId = `synthetic-bridge-social-${randomUUID()}`,
} = {}) {
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  const issuedAt = new Date(Date.now() - HOUR_MS);
  const expiresAt = new Date(Date.now() + 7 * 24 * HOUR_MS);
  await pool.query(`INSERT INTO ${table("participants")} (
      id,owner_kind,state,consent_version,consented_at,created_at,deletion_session_id
    ) VALUES ($1,'social',$2,$3,$4,$4,$5)`,
  [participantId, state, consentVersion ?? "synthetic-consent", issuedAt, state === "deleting" ? randomUUID() : null]);
  await pool.query(`INSERT INTO ${table("web_sessions")} (id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
    VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${table("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
      issued_at,expires_at,consumed_at,claimed_device_id
    ) VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',$5,$6,$5,$7)`,
  [pairingId, participantId, sessionId, randomBytes(32), issuedAt, expiresAt, deviceId]);
  await pool.query(`INSERT INTO ${table("device_credentials")} (
      id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at,
      social_verified_at
    ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [deviceId, participantId, pairingId, randomBytes(32), issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")} (
      participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,state,consented_at
    ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, issuedAt]);
  if (link) {
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (
        participant_id,owner_digest,state,generation_id,head_revision,object_digest,manifest_digest
      ) VALUES ($1,$2,'active',$3,$4,$5,$6)`,
    [participantId, link.ownerDigest, link.generationId ?? null, link.headRevision ?? null,
      link.objectDigest ?? null, link.manifestDigest ?? null]);
  }
  return { participantId, deviceId };
}

/** One complete, empty, ready v1.2 day (an empty day is a valid manifest). */
async function readyDay(pool, table, { participantId, deviceId }, day) {
  const manifestId = randomUUID();
  const manifestDigest = digest(`day-manifest-${manifestId}`);
  const now = new Date();
  await pool.query(`INSERT INTO ${table("telemetry_v12_day_manifests")} (
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,
      state,created_at,ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-v12-bridge',$6,0,'ready',$7,$7)`,
  [manifestId, participantId, deviceId, day, manifestDigest, JSON.stringify({ day, chunks: [] }), now]);
  return { day, manifestId, manifestDigest };
}

/**
 * Prepare a domain activation over `days` through the real PostgreSQL v1.2
 * domain path: the predecessor is issued now, and `activate` (optionally on
 * another pool) runs the activation transaction.
 */
async function prepareActivation(schema, principal, days) {
  const { createPostgresTypedV12Domain } = await workerModule("/src/postgres-typed-v12-domain.ts");
  const domainOn = (pool) => createPostgresTypedV12Domain(pool, {
    schema: { primarySchema: schema },
  });
  const domain = domainOn(await connection());
  const predecessor = await domain.createPredecessor(principal);
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: days[0].day,
    throughDay: days.at(-1).day,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days,
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = createHash("sha256").update(telemetryV12DomainManifestDigestInput(manifest)).digest("hex");
  return { domain, manifest, activate: (pool) => (pool ? domainOn(pool) : domain).activate(principal, manifest) };
}

/** Activate a domain over `days` through the real PostgreSQL v1.2 domain path. */
async function activateDomain(schema, principal, days) {
  const prepared = await prepareActivation(schema, principal, days);
  return { ...prepared, activation: await prepared.activate() };
}

/** Insert a generation (and its predecessor) directly; used where the real path would refuse. */
async function insertDomain(pool, table, { participantId, deviceId }, previousGenerationId = null, generationId = randomUUID()) {
  const token = digest(`token-${generationId}`);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
      from_day,through_day,days_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,$5,0,$6::date,$6::date,'[]',clock_timestamp(),clock_timestamp() + interval '1 day')`,
  [token, participantId, deviceId, previousGenerationId, digest(`fingerprint-${generationId}`), DAY_1]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8::date,$8::date,'[]',clock_timestamp())`,
  [generationId, participantId, deviceId, token, previousGenerationId, digest(`domain-manifest-${generationId}`),
    digest(`fingerprint-${generationId}`), DAY_1]);
  return generationId;
}

async function publishHead(pool, table, participantId, generationId, revision) {
  await pool.query(`INSERT INTO ${table("telemetry_v12_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,$3,clock_timestamp())
    ON CONFLICT (participant_id) DO UPDATE SET generation_id=EXCLUDED.generation_id, revision=EXCLUDED.revision,
      updated_at=EXCLUDED.updated_at`, [participantId, generationId, revision]);
}

async function journal(pool, table) {
  return (await pool.query(`SELECT sequence::int AS sequence,event_digest,owner_digest,kind,event_tuple_version AS version,
      revision::int AS revision,authority_epoch::int AS epoch,public_authority_epoch::int AS public_epoch,
      object_digest,content_digest,recorded_ms::text AS recorded_ms,xmin::text AS xmin
    FROM ${table("storage_ingestion_changes")} ORDER BY sequence`)).rows;
}

async function receipts(pool, table, participantId) {
  return (await pool.query(`SELECT event_digest,owner_digest,participant_id,device_id,generation_id,previous_generation_id,
      manifest_digest,head_revision::int AS head_revision,recorded_ms::text AS recorded_ms,xmin::text AS xmin
    FROM ${table("storage_v12_event_sources")} WHERE participant_id=$1 ORDER BY head_revision`, [participantId])).rows;
}

async function link(pool, table, participantId) {
  return (await pool.query(`SELECT owner_digest,state,generation_id,head_revision::int AS head_revision,object_digest,
      manifest_digest,xmin::text AS xmin
    FROM ${table("storage_v11_owner_links")} WHERE participant_id=$1`, [participantId])).rows[0] ?? null;
}

async function sourceEpoch(pool, table) {
  return (await pool.query(`SELECT authority_epoch::int AS epoch FROM ${table("storage_source_state")} WHERE singleton=1`))
    .rows[0]?.epoch;
}

async function pendingCount(pool, quoted) {
  return Number((await pool.query(`SELECT ${quoted}.storage_v12_bridge_pending_count()::text AS pending`)).rows[0].pending);
}

async function domainManifest(pool, table, generationId) {
  return (await pool.query(`SELECT manifest_digest FROM ${table("telemetry_v12_domains")} WHERE id=$1`, [generationId]))
    .rows[0].manifest_digest;
}

/**
 * An ordinary accountless opt-out that pins the owner's current accepted
 * v1.2 head with a prospective marker (0045), then revokes the device lineage
 * at the marker's instant, as the disconnect path does.
 */
async function retainV12(pool, table, { participantId, deviceId }) {
  const head = (await pool.query(`SELECT generation_id,revision FROM ${table("telemetry_v12_domain_heads")}
    WHERE participant_id=$1`, [participantId])).rows[0];
  const retainedAt = new Date(Date.now() - 60_000);
  await pool.query(`INSERT INTO ${table("accountless_public_history_retention")} (
      participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
    ) VALUES ($1,$2,$2,$3,$4,$5)`, [participantId, deviceId, head.generation_id, head.revision, retainedAt]);
  await pool.query(`UPDATE ${table("accountless_enrollment_ledger")}
    SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out' WHERE device_id=$1`, [deviceId, retainedAt]);
  for (const name of ["accountless_upload_owners", "accountless_v12_device_authorizations"]) {
    await pool.query(`UPDATE ${table(name)} SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out'
      WHERE enrollment_device_id=$1`, [deviceId, retainedAt]);
  }
  await pool.query(`UPDATE ${table("device_credentials")} SET state='revoked', revoked_at=$2 WHERE id=$1`,
    [deviceId, retainedAt]);
}

async function eligibleOwners(pool, table, participantId) {
  return (await pool.query(`SELECT owner_kind,device_id FROM ${table("community_public_source_owners")}
    WHERE participant_id=$1`, [participantId])).rows;
}

/** A dedicated session with an open transaction, for deterministic lock races. */
async function openTransaction(pool) {
  const client = await pool.connect();
  let open = true;
  const end = async (verb) => {
    if (!open) return;
    open = false;
    try {
      await client.query(verb);
    } finally {
      client.release();
    }
  };
  try {
    await client.query("BEGIN");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { client, pid, commit: () => end("COMMIT"), rollback: () => end("ROLLBACK") };
  } catch (error) {
    await end("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** True once another backend is observed waiting on a lock that `pid` holds. */
async function blockedBy(pool, pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
    if (rows[0].waiting > 0) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return false;
}

/**
 * One storage_v12_bridge_backfill call in its own transaction under a short
 * lock_timeout: a call that waited on another session's row lock fails with
 * 55P03 instead of returning. `keepOpen` leaves the transaction (and whatever
 * the call locked) open for the caller to commit.
 */
async function backfillOnce(pool, quoted, limit, { keepOpen = false } = {}) {
  const session = await openTransaction(pool);
  try {
    await session.client.query("SET LOCAL lock_timeout = '2s'");
    const bridged = (await session.client.query(`SELECT ${quoted}.storage_v12_bridge_backfill($1) AS bridged`,
      [limit])).rows[0].bridged;
    if (keepOpen) return { bridged, session };
    await session.commit();
    return { bridged };
  } catch (error) {
    await session.rollback().catch(() => {});
    throw error;
  }
}

/**
 * Per owner: its exact journal rows, receipts and link. Every exact row's
 * object digest names one of the owner's receipts, no receipt is named twice,
 * and a v1.2-only link carries the latest receipt as its terminal object.
 */
async function assertOneRowPerReceipt(pool, table, participantId) {
  const ownerLink = await link(pool, table, participantId);
  const ownerReceipts = await receipts(pool, table, participantId);
  const rows = (await journal(pool, table)).filter((row) => row.owner_digest === ownerLink?.owner_digest);
  assert.deepEqual(rows.map((row) => row.object_digest).sort(), ownerReceipts.map((receipt) => receipt.event_digest).sort(),
    "exactly one owner-active per receipt");
  assert.ok(rows.every((row) => row.kind === "owner-active" && row.version === 1));
  if (ownerReceipts.length > 0 && ownerLink.generation_id === null) {
    assert.equal(ownerLink.object_digest, ownerReceipts.at(-1).event_digest);
  }
  return { ownerLink, ownerReceipts, rows };
}

// ---------------------------------------------------------------------------

test("0055 replaces only the v1.2 head trigger, journals only through storage_journal_append, and raises constants",
  async () => {
    const sql = await readBridge();
    const code = sql.replace(/--[^\n]*/gu, " ");
    assert.match(code, /DROP TRIGGER telemetry_v12_domain_head_source_revision ON telemetry_v12_domain_heads;/u);
    assert.equal(code.match(/\bDROP\s+TRIGGER\b/giu)?.length, 1, "no other trigger is dropped");
    assert.doesNotMatch(code, /storage_ingestion_changes/iu, "the bridge never writes the journal directly");
    assert.doesNotMatch(code, /telemetry_emit_source_event/iu, "a v1.2 head change never reaches the legacy emitter");
    assert.match(code, /AFTER INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_heads/u);
    assert.equal(code.match(/storage_journal_append\(/gu)?.length, 1);
    for (const raised of code.matchAll(/RAISE\s+EXCEPTION\s+'([^']*)'\s+USING\s+ERRCODE\s*=\s*'P1005'/gu)) {
      assert.match(raised[1], CONSTANT_MESSAGE);
    }
    assert.equal(code.match(/RAISE\s+EXCEPTION/gu)?.length,
      code.match(/RAISE\s+EXCEPTION\s+'[a-z0-9_]+'\s+USING\s+ERRCODE\s*=\s*'P1005'/gu)?.length,
      "every raise is a constant message with an explicit SQLSTATE");
  });

test("PG17 a v1.2-only accountless activation bridges one link, receipt and owner-active in its own transaction",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    await initializeSource(pool, table, 5);
    await activateRuntime(pool, table);
    const owner = await seedAccountless(pool, table);
    const principal = { participantId: owner.participantId, deviceId: owner.deviceId };
    const retained = async () => (await pool.query(`SELECT participant_id,device_id
      FROM ${table("telemetry_v12_typed_retained_authorizations")} WHERE participant_id=$1`, [owner.participantId])).rows;
    assert.deepEqual(await retained(), [], "an unlinked v1.2-only owner is outside the retained read authority");

    const day1 = await readyDay(pool, table, owner, DAY_1);
    const startedMs = Date.now();
    const first = await activateDomain(schema, principal, [day1]);
    assert.equal(first.activation.replay, false);
    const generation1 = first.activation.generationId;

    const ownerLink = await link(pool, table, owner.participantId);
    assert.equal(ownerLink.state, "active");
    assert.match(ownerLink.owner_digest, /^[0-9a-f]{64}$/u);
    const [receipt1, ...extraReceipts] = await receipts(pool, table, owner.participantId);
    assert.deepEqual(extraReceipts, []);
    assert.equal(receipt1.owner_digest, ownerLink.owner_digest);
    assert.equal(receipt1.device_id, owner.deviceId);
    assert.equal(receipt1.generation_id, generation1);
    assert.equal(receipt1.previous_generation_id, null);
    assert.equal(receipt1.manifest_digest, first.manifest.manifestDigest);
    assert.equal(receipt1.head_revision, 1);
    assert.equal(Number(receipt1.recorded_ms) % 1_000, 0, "receipt time is whole seconds, like D1");
    assert.ok(Number(receipt1.recorded_ms) >= startedMs - 5_000 && Number(receipt1.recorded_ms) <= Date.now() + 5_000);
    assert.deepEqual({
      generation_id: ownerLink.generation_id, head_revision: ownerLink.head_revision,
      object_digest: ownerLink.object_digest, manifest_digest: ownerLink.manifest_digest,
    }, {
      generation_id: null, head_revision: null,
      object_digest: receipt1.event_digest, manifest_digest: first.manifest.manifestDigest,
    }, "a v1.2-only link carries the event as its terminal object and keeps generation_id NULL");

    const rows = await journal(pool, table);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], xmin: undefined, recorded_ms: undefined }, {
      sequence: 1, event_digest: receipt1.event_digest, owner_digest: ownerLink.owner_digest, kind: "owner-active",
      version: 1, revision: 1, epoch: 1, public_epoch: 6, object_digest: receipt1.event_digest,
      content_digest: first.manifest.manifestDigest, xmin: undefined, recorded_ms: undefined,
    });
    assert.equal(await sourceEpoch(pool, table), 6, "the owner-active advances the source epoch by one");
    const head = (await pool.query(`SELECT xmin::text AS xmin FROM ${table("telemetry_v12_domain_heads")}
      WHERE participant_id=$1`, [owner.participantId])).rows[0];
    const ownerHead = (await pool.query(`SELECT revision::int AS revision,authority_epoch::int AS epoch,state,
        seeded_partial,xmin::text AS xmin
      FROM ${table("storage_owner_revisions")} WHERE owner_digest=$1`, [ownerLink.owner_digest])).rows[0];
    assert.deepEqual({ ...ownerHead, xmin: undefined }, { revision: 1, epoch: 1, state: "active", seeded_partial: false, xmin: undefined });
    assert.deepEqual([ownerLink.xmin, receipt1.xmin, rows[0].xmin, ownerHead.xmin], Array(4).fill(head.xmin),
      "the link, receipt, journal row and owner head commit in the activation's transaction");
    assert.deepEqual(await retained(), [{ participant_id: owner.participantId, device_id: owner.deviceId }],
      "the bridged owner enters telemetry_v12_typed_retained_authorizations");
    assert.equal(await pendingCount(pool, quoted), 0);

    const replay = await first.domain.activate(principal, first.manifest);
    assert.equal(replay.replay, true);
    assert.deepEqual(await journal(pool, table), rows, "a replay adds no journal row");
    assert.equal((await receipts(pool, table, owner.participantId)).length, 1, "a replay adds no receipt");

    const day2 = await readyDay(pool, table, owner, DAY_2);
    const second = await activateDomain(schema, principal, [day1, day2]);
    assert.equal(second.activation.replay, false);
    const allReceipts = await receipts(pool, table, owner.participantId);
    assert.equal(allReceipts.length, 2);
    const receipt2 = allReceipts[1];
    assert.deepEqual([receipt2.generation_id, receipt2.previous_generation_id, receipt2.head_revision, receipt2.manifest_digest],
      [second.activation.generationId, generation1, 2, second.manifest.manifestDigest]);
    const after = await journal(pool, table);
    assert.equal(after.length, 2, "a second head adds exactly one journal row");
    assert.deepEqual([after[1].kind, after[1].version, after[1].revision, after[1].epoch, after[1].public_epoch,
      after[1].event_digest, after[1].object_digest, after[1].content_digest],
    ["owner-active", 1, 2, 2, 7, receipt2.event_digest, receipt2.event_digest, second.manifest.manifestDigest]);
    const counts = (await pool.query(`SELECT count(*) FILTER (WHERE event_tuple_version=0)::int AS version_zero,
        count(*) FILTER (WHERE kind='source-updated')::int AS source_updated
      FROM ${table("storage_ingestion_changes")}`)).rows[0];
    assert.deepEqual(counts, { version_zero: 0, source_updated: 0 });
    const relinked = await link(pool, table, owner.participantId);
    assert.equal(relinked.owner_digest, ownerLink.owner_digest);
    assert.deepEqual([relinked.object_digest, relinked.manifest_digest], [receipt2.event_digest, second.manifest.manifestDigest]);

    // Bridging a head that already has its receipt (the current one, or an
    // earlier one on the chain) records nothing and journals nothing.
    for (const [generationId, revision] of [[second.activation.generationId, 2], [generation1, 1]]) {
      const again = await pool.query(`SELECT ${quoted}.storage_v12_bridge_head($1,$2,$3) AS bridged`,
        [owner.participantId, generationId, revision]);
      assert.equal(again.rows[0].bridged, false);
    }
    assert.deepEqual(await journal(pool, table), after, "an existing receipt adds no journal row");
    assert.equal((await receipts(pool, table, owner.participantId)).length, 2);
    assert.equal(await sourceEpoch(pool, table), 7);

    const executable = await pool.query(`SELECT
        has_function_privilege('public', $1, 'EXECUTE') AS backfill,
        has_function_privilege('public', $2, 'EXECUTE') AS append`,
    [`${quoted}.storage_v12_bridge_backfill(integer)`, `${quoted}.storage_journal_append(text,text,text,text,text)`]);
    assert.deepEqual(executable.rows[0], { backfill: false, append: false },
      "the backfill is a maintenance entrypoint, not executable by PUBLIC");
  }));

const PARITY_OWNERS = Object.freeze(["synthetic-parity-p", "synthetic-parity-q", "synthetic-parity-r", "synthetic-parity-d"]);

/** The same raw head sequence, with fixed identifiers, on one schema. */
async function rawHeadSequence(pool, table) {
  await initializeSource(pool, table, 5);
  const p = await seedSocial(pool, table, { participantId: PARITY_OWNERS[0], link: { ownerDigest: digest("parity-owner-p") } });
  await pool.query(`INSERT INTO ${table("analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
    VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, digest("parity-owner-p")]);
  const q = await seedSocial(pool, table, { participantId: PARITY_OWNERS[1] });
  const r = await seedSocial(pool, table, { participantId: PARITY_OWNERS[2] });
  const d = await seedSocial(pool, table, { participantId: PARITY_OWNERS[3], state: "deleting" });
  const g1 = await insertDomain(pool, table, p, null, "11111111-1111-4111-8111-111111111111");
  const g2 = await insertDomain(pool, table, p, g1, "22222222-2222-4222-8222-222222222222");
  const gq = await insertDomain(pool, table, q, null, "33333333-3333-4333-8333-333333333333");
  const gd = await insertDomain(pool, table, d, null, "44444444-4444-4444-8444-444444444444");
  await publishHead(pool, table, p.participantId, g1, 1);
  await pool.query(`UPDATE ${table("telemetry_v12_domain_heads")} SET updated_at=clock_timestamp() WHERE participant_id=$1`,
    [p.participantId]);
  await publishHead(pool, table, p.participantId, g2, 2);
  await publishHead(pool, table, q.participantId, gq, 1);
  await pool.query(`UPDATE ${table("telemetry_v12_domain_heads")} SET participant_id=$2 WHERE participant_id=$1`,
    [q.participantId, r.participantId]);
  await pool.query(`DELETE FROM ${table("telemetry_v12_domain_heads")} WHERE participant_id=$1`, [r.participantId]);
  await publishHead(pool, table, d.participantId, gd, 1);
  return [p, q, r, d].map((owner) => owner.participantId);
}

test("PG17 the head trigger keeps the exact 0014 input_versions and source-digest effect and never writes version 0",
  { skip: SKIP, timeout: 240_000 }, async () => {
    const observed = {};
    for (const bridged of [false, true]) {
      await withSchema(async ({ pool, table }) => {
        const ids = await rawHeadSequence(pool, table);
        const versions = [];
        for (const id of ids) {
          const revision = (await pool.query(`SELECT revision::int AS revision FROM ${table("input_versions")}
            WHERE participant_id=$1`, [id])).rows[0]?.revision ?? null;
          const sourceDigest = (await pool.query(`SELECT digest FROM ${table("input_source_digests")}
            WHERE participant_id=$1`, [id])).rows[0]?.digest ?? null;
          versions.push([revision, sourceDigest]);
        }
        const rows = await journal(pool, table);
        observed[bridged ? "bridged" : "baseline"] = { versions, rows, ids };
      }, { bridged });
    }
    const { baseline, bridged } = observed;
    assert.deepEqual(bridged.versions, baseline.versions,
      "input_versions and input_source_digests equal the pre-bridge values for the same head sequence");
    // The 0014 chain, recomputed from its event keys.
    const chain = (steps) => steps.reduce((value, step) =>
      value === null ? createHash("md5").update(step).digest("hex")
        : createHash("md5").update(`${value}:${step}`).digest("hex"), null);
    for (const run of [baseline, bridged]) {
      const [p, q, r, d] = run.ids;
      const t = "telemetry_v12_domain_heads";
      assert.deepEqual(run.versions, [
        [3, chain([`${t}:INSERT:${p}:11111111-1111-4111-8111-111111111111`,
          `${t}:UPDATE:${p}:11111111-1111-4111-8111-111111111111`,
          `${t}:UPDATE:${p}:22222222-2222-4222-8222-222222222222`])],
        [2, chain([`${t}:INSERT:${q}:33333333-3333-4333-8333-333333333333`,
          `${t}:UPDATE:old:${q}:33333333-3333-4333-8333-333333333333`])],
        [2, chain([`${t}:UPDATE:${r}:33333333-3333-4333-8333-333333333333`,
          `${t}:DELETE:${r}:33333333-3333-4333-8333-333333333333`])],
        [0, null],
      ], "input_versions and input_source_digests follow the 0014 event keys, old-owner branch and upsert");
    }
    assert.ok(baseline.rows.length >= 1 && baseline.rows.every((row) => row.version === 0 && row.kind === "source-updated"),
      "before 0055 a v1.2 head change reached the legacy emitter");
    assert.deepEqual(bridged.rows.map(({ kind, version, revision }) => [kind, version, revision]), [
      ["owner-active", 1, 1], ["owner-active", 1, 2], ["owner-active", 1, 1],
    ], "after 0055 only the bridge journals: p's insert and generation change, q's insert");
  });

test("PG17 social owners are bridged and an existing v1/v1.1 link keeps its digest and v1.1 digests",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, table }) => {
    const { TELEMETRY_CONSENT_VERSION } = await workerModule("/src/constants.ts");
    await initializeSource(pool, table, 0);
    await activateRuntime(pool, table);

    const fresh = await seedSocial(pool, table, { consentVersion: TELEMETRY_CONSENT_VERSION });
    const freshActivation = await activateDomain(schema, fresh, [await readyDay(pool, table, fresh, DAY_1)]);
    const freshLink = await link(pool, table, fresh.participantId);
    const [freshReceipt] = await receipts(pool, table, fresh.participantId);
    assert.equal(freshLink.state, "active");
    assert.equal(freshReceipt.owner_digest, freshLink.owner_digest);
    assert.equal(freshReceipt.generation_id, freshActivation.activation.generationId);

    const linked = {
      ownerDigest: digest("existing-v11-owner"), generationId: randomUUID(), headRevision: 4,
      objectDigest: digest("existing-v11-object"), manifestDigest: digest("existing-v11-manifest"),
    };
    const existing = await seedSocial(pool, table, { consentVersion: TELEMETRY_CONSENT_VERSION, link: linked });
    await activateDomain(schema, existing, [await readyDay(pool, table, existing, DAY_1)]);
    const kept = await link(pool, table, existing.participantId);
    assert.deepEqual({ ...kept, xmin: undefined }, {
      owner_digest: linked.ownerDigest, state: "active", generation_id: linked.generationId, head_revision: 4,
      object_digest: linked.objectDigest, manifest_digest: linked.manifestDigest, xmin: undefined,
    }, "a link with a v1.1 generation keeps its digest and v1.1 terminal digests");
    const [existingReceipt] = await receipts(pool, table, existing.participantId);
    assert.equal(existingReceipt.owner_digest, linked.ownerDigest);

    const rows = await journal(pool, table);
    assert.deepEqual(rows.map(({ owner_digest, kind, revision, epoch, public_epoch }) =>
      [owner_digest, kind, revision, epoch, public_epoch]), [
      [freshLink.owner_digest, "owner-active", 1, 1, 1],
      [linked.ownerDigest, "owner-active", 1, 1, 2],
    ]);
    assert.deepEqual(rows.map((row) => row.object_digest), [freshReceipt, existingReceipt].map((r) => r.event_digest));
  }));

test("PG17 lapsed leases, revoked devices without a marker and deleting participants mint nothing",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    await initializeSource(pool, table, 5);
    const expiresAt = new Date(Date.now() + 30 * 24 * HOUR_MS);
    const lapsed = await seedAccountless(pool, table, { expiresAt, successorExpiresAt: new Date(expiresAt.getTime() - HOUR_MS) });
    const revoked = await seedAccountless(pool, table, { deviceState: "revoked" });
    const deletingAccountless = await seedAccountless(pool, table, { participantState: "deleting" });
    const deletingSocial = await seedSocial(pool, table, { state: "deleting" });
    const control = await seedAccountless(pool, table);
    const ineligible = [lapsed, revoked, deletingAccountless, deletingSocial];
    for (const owner of [...ineligible, control]) {
      await publishHead(pool, table, owner.participantId, await insertDomain(pool, table, owner), 1);
    }
    for (const owner of ineligible) {
      assert.equal(await link(pool, table, owner.participantId), null, "no link is minted for an ineligible head");
      assert.deepEqual(await receipts(pool, table, owner.participantId), []);
    }
    const controlLink = await link(pool, table, control.participantId);
    assert.equal(controlLink?.state, "active", "the eligible control owner in the same schema is bridged");
    const rows = await journal(pool, table);
    assert.deepEqual(rows.map(({ owner_digest, kind }) => [owner_digest, kind]), [[controlLink.owner_digest, "owner-active"]]);
    assert.equal(await pendingCount(pool, quoted), 0, "ineligible heads are not pending");
    const bumped = (await pool.query(`SELECT participant_id,revision::int AS revision FROM ${table("input_versions")}
      WHERE participant_id = ANY($1::text[]) ORDER BY participant_id`,
    [[lapsed.participantId, revoked.participantId]])).rows;
    assert.deepEqual(bumped.map((row) => row.revision), [1, 1], "ineligible active owners still advance input_versions");
  }));

test("PG17 a withdrawn owner re-activates once and an erased owner is never re-bridged",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { appendPostgresOwnerJournal, ensurePostgresOwnerLink } = await workerModule("/src/postgres-owner-journal.ts");
    await initializeSource(pool, table, 5);
    const client = await pool.connect();
    try {
      // A journaled owner that was withdrawn (terminal row plus link state).
      const withdrawn = await seedAccountless(pool, table);
      const w1 = await insertDomain(pool, table, withdrawn);
      await publishHead(pool, table, withdrawn.participantId, w1, 1);
      const withdrawnDigest = (await link(pool, table, withdrawn.participantId)).owner_digest;
      await appendPostgresOwnerJournal(client, schema, {
        kind: "owner-withdrawn", ownerDigest: withdrawnDigest, eventDigest: digest("withdrawal"),
        objectDigest: digest("withdrawal-object"), contentDigest: digest("withdrawal-content"),
      });
      await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='withdrawn' WHERE participant_id=$1`,
        [withdrawn.participantId]);
      const w2 = await insertDomain(pool, table, withdrawn, w1);
      await publishHead(pool, table, withdrawn.participantId, w2, 2);
      assert.equal((await link(pool, table, withdrawn.participantId)).state, "active", "a later eligible head re-activates");
      const withdrawnRows = (await journal(pool, table)).filter((row) => row.owner_digest === withdrawnDigest);
      assert.deepEqual(withdrawnRows.map(({ kind, revision, epoch }) => [kind, revision, epoch]),
        [["owner-active", 1, 1], ["owner-withdrawn", 2, 2], ["owner-active", 3, 3]]);
      assert.equal((await receipts(pool, table, withdrawn.participantId)).length, 2);

      // A headless link minted withdrawn (never journaled) re-activates on its first head.
      const headless = await seedAccountless(pool, table);
      const headlessDigest = await ensurePostgresOwnerLink(client, schema, headless.participantId, "withdrawn");
      await publishHead(pool, table, headless.participantId, await insertDomain(pool, table, headless), 1);
      assert.equal((await link(pool, table, headless.participantId)).state, "active");
      assert.deepEqual((await journal(pool, table)).filter((row) => row.owner_digest === headlessDigest)
        .map(({ kind, revision }) => [kind, revision]), [["owner-active", 1]]);

      // An erased link is never re-bridged.
      const erasedLink = await seedAccountless(pool, table);
      const e1 = await insertDomain(pool, table, erasedLink);
      await publishHead(pool, table, erasedLink.participantId, e1, 1);
      await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
        [erasedLink.participantId]);
      // An owner whose journal head is erased while its link is still active.
      const erasedHead = await seedAccountless(pool, table);
      const h1 = await insertDomain(pool, table, erasedHead);
      await publishHead(pool, table, erasedHead.participantId, h1, 1);
      const erasedHeadDigest = (await link(pool, table, erasedHead.participantId)).owner_digest;
      await appendPostgresOwnerJournal(client, schema, {
        kind: "owner-erased", ownerDigest: erasedHeadDigest, eventDigest: digest("erasure"),
        objectDigest: digest("erasure-object"), contentDigest: digest("erasure-content"),
      });
      const before = await journal(pool, table);
      await publishHead(pool, table, erasedLink.participantId, await insertDomain(pool, table, erasedLink, e1), 2);
      await publishHead(pool, table, erasedHead.participantId, await insertDomain(pool, table, erasedHead, h1), 2);
      assert.deepEqual(await journal(pool, table), before, "no journal row for an erased owner");
      assert.equal((await receipts(pool, table, erasedLink.participantId)).length, 1);
      assert.equal((await receipts(pool, table, erasedHead.participantId)).length, 1);
      assert.equal((await link(pool, table, erasedLink.participantId)).state, "erased");
      assert.equal(await pendingCount(pool, quoted), 0, "erased owners are never pending");
      const sql = await readBridge();
      await applyBridge(pool, schema, sql.slice(sql.lastIndexOf("\nDO $$")));
      assert.deepEqual(await journal(pool, table), before, "the one-time backfill skips erased owners too");
    } finally {
      client.release();
    }
  }));

test("PG17 without storage_source_state nothing is minted; the pending read and backfill bridge it exactly once",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { readPostgresV12OwnerBridgePending, runPostgresV12OwnerBridgeBackfill, PostgresV12OwnerBridgeError } =
      await workerModule("/src/postgres-v12-owner-bridge.ts");
    const options = { pool, schema: { primarySchema: schema } };
    await activateRuntime(pool, table);
    const owner = await seedAccountless(pool, table);
    const activation = await activateDomain(schema, owner, [await readyDay(pool, table, owner, DAY_1)]);
    assert.equal(await link(pool, table, owner.participantId), null);
    assert.deepEqual(await receipts(pool, table, owner.participantId), []);
    assert.deepEqual(await journal(pool, table), []);
    const pending = await readPostgresV12OwnerBridgePending(options);
    assert.deepEqual(pending, { sourceInitialized: false, pending: 1 });
    assert.deepEqual(Object.keys(pending).sort(), ["pending", "sourceInitialized"], "the read is content-free");
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() + 60_000 }),
      { status: "source_uninitialized", bridged: 0, batches: 0, pending: 1 });
    assert.equal((await pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(500) AS bridged`)).rows[0].bridged, 0);

    await initializeSource(pool, table, 5);
    const second = await seedAccountless(pool, table);
    await publishHead(pool, table, second.participantId, await insertDomain(pool, table, second), 1);
    // The second owner was bridged by its own head change; the first is still pending.
    assert.equal(await pendingCount(pool, quoted), 1);
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() - 1 }),
      { status: "deferred", bridged: 0, batches: 0, pending: 1 }, "no batch starts after the deadline");
    for (const limit of [0, 501, 1.5]) {
      await assert.rejects(runPostgresV12OwnerBridgeBackfill({ ...options, limit, deadlineMs: Date.now() + 60_000 }),
        (error) => error instanceof PostgresV12OwnerBridgeError && error.code === "V12_OWNER_BRIDGE_INPUT_INVALID");
    }
    await refuses(pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(501)`), "storage_v12_bridge_limit_invalid");
    await refuses(pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(0)`), "storage_v12_bridge_limit_invalid");

    const repaired = await runPostgresV12OwnerBridgeBackfill({ ...options, limit: 1, deadlineMs: Date.now() + 60_000 });
    assert.deepEqual(repaired, { status: "complete", bridged: 1, batches: 1, pending: 0 });
    const ownerLink = await link(pool, table, owner.participantId);
    const [receipt] = await receipts(pool, table, owner.participantId);
    assert.deepEqual([receipt.generation_id, receipt.head_revision, receipt.manifest_digest, receipt.owner_digest],
      [activation.activation.generationId, 1, activation.manifest.manifestDigest, ownerLink.owner_digest]);
    assert.equal(ownerLink.object_digest, receipt.event_digest);
    const ownerRows = (await journal(pool, table)).filter((row) => row.owner_digest === ownerLink.owner_digest);
    assert.deepEqual(ownerRows.map(({ kind, revision, epoch, event_digest }) => [kind, revision, epoch, event_digest]),
      [["owner-active", 1, 1, receipt.event_digest]]);
    assert.equal(await sourceEpoch(pool, table), 7);
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() + 60_000 }),
      { status: "complete", bridged: 0, batches: 0, pending: 0 }, "a repeated backfill is a no-op");
    assert.equal((await pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(500) AS bridged`)).rows[0].bridged, 0);
    assert.equal((await journal(pool, table)).length, 2);
  }));

test("PG17 the migration's one-time backfill bridges eligible heads once and is a no-op without a source",
  { skip: SKIP, timeout: 240_000 }, async () => {
    for (const initialized of [true, false]) {
      await withSchema(async ({ pool, schema, quoted, table }) => {
        if (initialized) await initializeSource(pool, table, 5);
        const social = await seedSocial(pool, table);
        const accountless = await seedAccountless(pool, table);
        const lapsed = await seedAccountless(pool, table, { successorExpiresAt: new Date(Date.now() + HOUR_MS) });
        const erased = await seedSocial(pool, table, { link: { ownerDigest: digest(`erased-${schema}`) } });
        await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
          [erased.participantId]);
        for (const owner of [social, accountless, lapsed, erased]) {
          await publishHead(pool, table, owner.participantId, await insertDomain(pool, table, owner), 1);
        }
        assert.deepEqual((await journal(pool, table)).filter((row) => row.version === 1), [], "nothing is bridged before 0055");

        await applyBridge(pool, schema);
        const bridgedOwners = [];
        for (const owner of [social, accountless, lapsed, erased]) {
          if ((await receipts(pool, table, owner.participantId)).length > 0) bridgedOwners.push(owner.participantId);
        }
        const exact = (await journal(pool, table)).filter((row) => row.version === 1);
        if (initialized) {
          assert.deepEqual(bridgedOwners.sort(), [social.participantId, accountless.participantId].sort());
          assert.deepEqual(exact.map(({ kind, revision }) => [kind, revision]), [["owner-active", 1], ["owner-active", 1]]);
          assert.equal(await pendingCount(pool, quoted), 0);
        } else {
          assert.deepEqual(bridgedOwners, []);
          assert.deepEqual(exact, []);
          assert.equal(await pendingCount(pool, quoted), 2, "the eligible heads stay pending without a source");
        }
        const sql = await readBridge();
        await applyBridge(pool, schema, sql.slice(sql.lastIndexOf("\nDO $$")));
        assert.deepEqual((await journal(pool, table)).filter((row) => row.version === 1), exact,
          "re-running the one-time backfill adds nothing");
      }, { bridged: false });
    }
  });

test("PG17 a transfer-role session mints nothing and cannot run the backfill",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { runPostgresV12OwnerBridgeBackfill, PostgresV12OwnerBridgeError } =
      await workerModule("/src/postgres-v12-owner-bridge.ts");
    await initializeSource(pool, table, 5);
    const owner = await seedSocial(pool, table);
    const generationId = await insertDomain(pool, table, owner);
    const member = `synthetic_oj2_member_${randomBytes(4).toString("hex")}`;
    const lock = await pool.connect();
    let locked = false;
    let memberCreated = false;
    let roleCreated = false;
    try {
      await lock.query("SELECT pg_advisory_lock($1)", [TRANSFER_ROLE_LOCK]);
      locked = true;
      await pool.query(`CREATE ROLE ${member} LOGIN NOSUPERUSER NOCREATEROLE`);
      memberCreated = true;
      if ((await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [TRANSFER_ROLE])).rowCount === 0) {
        await pool.query(`CREATE ROLE ${TRANSFER_ROLE} NOLOGIN`);
        roleCreated = true;
      }
      await pool.query(`GRANT ${TRANSFER_ROLE} TO ${member}`);
      await pool.query(`GRANT USAGE ON SCHEMA ${quoted} TO ${member}`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoted} TO ${member}`);
      await pool.query(`GRANT EXECUTE ON FUNCTION ${quoted}.storage_v12_bridge_backfill(integer) TO ${member}`);
      const memberPool = new pg.Pool({ ...await poolOptions("pg-v12-owner-bridge-transfer", 2), user: member });
      try {
        assert.equal((await memberPool.query(`SELECT ${quoted}.storage_journal_transfer_session() AS transfer`)).rows[0].transfer,
          true, "the member login is a transfer session");
        await publishHead(memberPool, table, owner.participantId, generationId, 1);
        assert.equal(await link(pool, table, owner.participantId), null, "a transfer session mints no link");
        assert.deepEqual(await receipts(pool, table, owner.participantId), []);
        assert.deepEqual(await journal(pool, table), []);
        assert.equal((await pool.query(`SELECT revision::int AS revision FROM ${table("input_versions")}
          WHERE participant_id=$1`, [owner.participantId])).rows[0].revision, 1,
        "the head's input_versions effect still applies in a transfer session");
        await refuses(memberPool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(10)`), "storage_v12_bridge_transfer_session");
        await assert.rejects(runPostgresV12OwnerBridgeBackfill({
          pool: memberPool, schema: { primarySchema: schema }, deadlineMs: Date.now() + 60_000,
        }), (error) => error instanceof PostgresV12OwnerBridgeError && error.code === "V12_OWNER_BRIDGE_TRANSFER_SESSION");
      } finally {
        await memberPool.end();
      }
      assert.equal((await pool.query(`SELECT ${quoted}.storage_journal_transfer_session() AS transfer`)).rows[0].transfer, false,
        "the superuser test session is not a transfer session");
      assert.equal(await pendingCount(pool, quoted), 1);
      assert.equal((await pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(500) AS bridged`)).rows[0].bridged, 1);
      assert.equal((await pool.query(`SELECT ${quoted}.storage_v12_bridge_backfill(500) AS bridged`)).rows[0].bridged, 0);
      assert.deepEqual((await journal(pool, table)).map(({ kind, revision }) => [kind, revision]), [["owner-active", 1]]);
    } finally {
      if (memberCreated) {
        await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoted} FROM ${member}`).catch(() => {});
        await pool.query(`REVOKE ALL ON FUNCTION ${quoted}.storage_v12_bridge_backfill(integer) FROM ${member}`).catch(() => {});
        await pool.query(`REVOKE ALL ON SCHEMA ${quoted} FROM ${member}`).catch(() => {});
        await pool.query(`REVOKE ${TRANSFER_ROLE} FROM ${member}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${member}`);
      }
      if (roleCreated) await pool.query(`DROP ROLE IF EXISTS ${TRANSFER_ROLE}`);
      if (locked) await lock.query("SELECT pg_advisory_unlock($1)", [TRANSFER_ROLE_LOCK]).catch(() => {});
      lock.release();
    }
  }));

/**
 * A pool whose clients record every driver error code, and that can pause
 * once before a statement matching `pauseAt`, holding its transaction open
 * until another session is observed waiting on one of its locks, so the race
 * is proven to interleave rather than merely scheduled.
 */
function instrumentedPool(pool, pauseAt) {
  const errors = [];
  const state = { paused: false, contended: false };
  let reached;
  const reachedPromise = new Promise((resolveReached) => { reached = resolveReached; });
  return {
    errors,
    state,
    reached: reachedPromise,
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (!state.paused && pauseAt?.(text)) {
            state.paused = true;
            const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            reached();
            for (let attempt = 0; attempt < 120 && !state.contended; attempt += 1) {
              const blocked = await pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
                WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
              if (blocked.rows[0].waiting > 0) state.contended = true;
              else await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
            }
          }
          try {
            return await client.query(text, values);
          } catch (error) {
            errors.push(error?.code ?? "unknown");
            throw error;
          }
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

test("PG17 the backfill bridges one head per transaction and never waits on another owner while the source is held",
  { skip: SKIP, timeout: 240_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { runPostgresV12OwnerBridgeBackfill } = await workerModule("/src/postgres-v12-owner-bridge.ts");
    const options = { pool, schema: { primarySchema: schema } };
    await activateRuntime(pool, table);
    // Heads accepted before storage_source_state existed, as at cutover, for
    // owners a < b < c in "C" order. c's head came through the real path so
    // that c can activate again while the backfill runs.
    const run = randomUUID();
    const owners = [];
    for (const name of ["a", "b", "c"]) {
      owners.push(await seedAccountless(pool, table, { participantId: `participant:oj2-${name}-${run}` }));
    }
    for (const raw of owners.slice(0, 2)) {
      await publishHead(pool, table, raw.participantId, await insertDomain(pool, table, raw), 1);
    }
    const cDay1 = await readyDay(pool, table, owners[2], DAY_1);
    await activateDomain(schema, owners[2], [cDay1]);
    await initializeSource(pool, table, 5);
    assert.equal(await pendingCount(pool, quoted), 3);
    const [ownerA, ownerB, ownerC] = owners;

    // The reviewed deadlock: an eraser-style fence holds b's participant. The
    // backfill bridges a and returns at once instead of waiting on b while it
    // holds the source, so its caller's transaction ends before c's
    // activation, which queues on that source, can be waited on in turn.
    const fence = await openTransaction(pool);
    const activationPool = instrumentedPool(pool);
    try {
      await fence.client.query(`SELECT 1 FROM ${table("participants")} WHERE id=$1 FOR UPDATE`, [ownerB.participantId]);
      const prepared = await prepareActivation(schema, ownerC, [cDay1, await readyDay(pool, table, ownerC, DAY_2)]);
      const first = await backfillOnce(pool, quoted, 500, { keepOpen: true });
      let activation;
      try {
        assert.equal(first.bridged, 1, "one head per call, and no wait on the fenced owner");
        activation = prepared.activate(activationPool).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
        assert.equal(await blockedBy(pool, first.session.pid), true, "c's activation queues on the held source");
      } finally {
        await first.session.commit();
      }
      const activated = await activation;
      assert.equal(activated.ok, true, `c's activation completes once the backfill commits: ${activated.error?.code}`);
      // b is fenced and c's current head bridged itself: nothing else can
      // progress, so the run stops after one transaction instead of retrying.
      assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() + 60_000 }),
        { status: "deferred", bridged: 0, batches: 1, pending: 1 });
    } finally {
      await fence.rollback();
    }
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() + 60_000 }),
      { status: "complete", bridged: 1, batches: 1, pending: 0 });
    for (const owner of [ownerA, ownerB]) {
      const { rows, ownerLink } = await assertOneRowPerReceipt(pool, table, owner.participantId);
      assert.deepEqual(rows.map(({ revision }) => revision), [1]);
      assert.equal(ownerLink.state, "active");
    }
    const cState = await assertOneRowPerReceipt(pool, table, ownerC.participantId);
    assert.deepEqual(cState.ownerReceipts.map(({ head_revision }) => head_revision), [2],
      "a head superseded before it was bridged is not journaled; its successor is, once");
    assert.equal(cState.ownerLink.state, "active");
    for (const code of ["40P01", "55P03", "23505"]) {
      assert.equal(activationPool.errors.includes(code), false, `the activation saw no ${code}`);
    }
  }));

test("PG17 the backfill and an activation of the same owner bridge each head once, in either order",
  { skip: SKIP, timeout: 240_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    await activateRuntime(pool, table);
    const run = randomUUID();
    const d = await seedAccountless(pool, table, { participantId: `participant:oj2-d-${run}` });
    const e = await seedAccountless(pool, table, { participantId: `participant:oj2-e-${run}` });
    const eDay1 = await readyDay(pool, table, e, DAY_1);
    const dFirst = await activateDomain(schema, d, [await readyDay(pool, table, d, DAY_1)]);
    await activateDomain(schema, e, [eDay1]);
    await initializeSource(pool, table, 5);
    assert.equal(await pendingCount(pool, quoted), 2);

    // Activation first: a change of d's head is under way, and has bridged its
    // new head, when the backfill reaches d's still-pending committed head.
    // The backfill skips d (limit 1 inspects d alone) rather than waiting and
    // then bridging the superseded head a second time.
    const d2 = await insertDomain(pool, table, d, dFirst.activation.generationId);
    const change = await openTransaction(pool);
    try {
      await change.client.query(`UPDATE ${table("telemetry_v12_domain_heads")} SET generation_id=$2, revision=2,
        updated_at=clock_timestamp() WHERE participant_id=$1`, [d.participantId, d2]);
      assert.equal((await backfillOnce(pool, quoted, 1)).bridged, 0, "the held head is skipped, not awaited");
      await change.commit();
    } finally {
      await change.rollback();
    }
    const dState = await assertOneRowPerReceipt(pool, table, d.participantId);
    assert.deepEqual(dState.ownerReceipts.map(({ generation_id, head_revision }) => [generation_id, head_revision]),
      [[d2, 2]]);
    assert.deepEqual(dState.rows.map(({ revision }) => revision), [1]);
    assert.equal(await pendingCount(pool, quoted), 1);

    // Backfill first: it holds e's rows when e activates again. The activation
    // waits for it, then journals its own new head once.
    const prepared = await prepareActivation(schema, e, [eDay1, await readyDay(pool, table, e, DAY_2)]);
    const held = await backfillOnce(pool, quoted, 500, { keepOpen: true });
    const activationPool = instrumentedPool(pool);
    let activation;
    try {
      assert.equal(held.bridged, 1);
      activation = prepared.activate(activationPool).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      assert.equal(await blockedBy(pool, held.session.pid), true, "e's activation waits on the backfill");
    } finally {
      await held.session.commit();
    }
    assert.equal((await activation).ok, true);
    const eState = await assertOneRowPerReceipt(pool, table, e.participantId);
    assert.deepEqual(eState.ownerReceipts.map(({ head_revision }) => head_revision), [1, 2]);
    assert.deepEqual(eState.rows.map(({ revision }) => revision), [1, 2]);
    assert.equal(await pendingCount(pool, quoted), 0);
    for (const code of ["40P01", "55P03", "23505"]) {
      assert.equal(activationPool.errors.includes(code), false, `the activation saw no ${code}`);
    }
  }));

test("PG17 a retained v1.2 owner is bridged once, and a marker retirement under way is never reversed",
  { skip: SKIP, timeout: 240_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { ensurePostgresOwnerLink } = await workerModule("/src/postgres-owner-journal.ts");
    const { runPostgresV12OwnerBridgeBackfill } = await workerModule("/src/postgres-v12-owner-bridge.ts");
    const run = randomUUID();
    // Ordinary opt-outs whose markers pin heads accepted before
    // storage_source_state existed. linked had an owner link already; kept
    // and unlinked had none.
    const kept = await seedAccountless(pool, table, { participantId: `participant:oj2-r1-${run}` });
    const linked = await seedAccountless(pool, table, { participantId: `participant:oj2-r2-${run}` });
    const unlinked = await seedAccountless(pool, table, { participantId: `participant:oj2-r3-${run}` });
    const direct = await seedAccountless(pool, table, { participantId: `participant:oj2-r4-${run}` });
    const client = await pool.connect();
    try {
      await ensurePostgresOwnerLink(client, schema, linked.participantId, "active");
    } finally {
      client.release();
    }
    const directGeneration = await insertDomain(pool, table, direct);
    for (const owner of [kept, linked, unlinked, direct]) {
      await publishHead(pool, table, owner.participantId,
        owner === direct ? directGeneration : await insertDomain(pool, table, owner), 1);
      await retainV12(pool, table, owner);
      assert.deepEqual(await eligibleOwners(pool, table, owner.participantId),
        [{ owner_kind: "accountless", device_id: owner.deviceId }], "eligible through the retained v1.2 branch");
    }
    await initializeSource(pool, table, 5);
    assert.equal(await pendingCount(pool, quoted), 4);

    // Retiring the other markers withdraws linked's link (0041) and holds the
    // markers until it commits.
    const retirement = await openTransaction(pool);
    let directBridge;
    try {
      await retirement.client.query(`DELETE FROM ${table("accountless_public_history_retention")}
        WHERE participant_id = ANY($1::text[])`, [[linked.participantId, unlinked.participantId, direct.participantId]]);
      assert.equal((await backfillOnce(pool, quoted, 500)).bridged, 1, "the retained owner is bridged");
      assert.equal((await backfillOnce(pool, quoted, 500)).bridged, 0,
        "owners whose markers are being retired are skipped, not awaited or bridged");
      // A direct bridge of a retained head (the call every path makes) waits
      // for the retirement instead of reading the marker it is removing.
      directBridge = pool.query(`SELECT ${quoted}.storage_v12_bridge_head($1,$2,1) AS bridged`,
        [direct.participantId, directGeneration]);
      assert.equal(await blockedBy(pool, retirement.pid), true, "the direct bridge waits on the marker");
      await retirement.commit();
    } finally {
      await retirement.rollback();
    }
    assert.equal((await directBridge).rows[0].bridged, false, "the retired owner is not bridged after the wait");
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ pool, schema: { primarySchema: schema }, deadlineMs: Date.now() + 60_000 }),
    { status: "complete", bridged: 0, batches: 0, pending: 0 });

    const keptState = await assertOneRowPerReceipt(pool, table, kept.participantId);
    assert.equal(keptState.ownerLink.state, "active");
    assert.deepEqual(keptState.rows.map(({ revision }) => revision), [1]);
    for (const owner of [linked, unlinked, direct]) {
      assert.deepEqual(await eligibleOwners(pool, table, owner.participantId), []);
      assert.deepEqual(await receipts(pool, table, owner.participantId), [], "a retired owner gets no receipt");
    }
    assert.equal((await link(pool, table, linked.participantId)).state, "withdrawn", "the withdrawal stands");
    for (const owner of [unlinked, direct]) {
      assert.equal(await link(pool, table, owner.participantId), null, "no link is minted for a retired owner");
    }
    assert.deepEqual((await journal(pool, table)).map(({ owner_digest }) => owner_digest), [keptState.ownerLink.owner_digest],
      "only the retained owner is journaled");
  }));

test("PG17 a bridge never outlives a revocation under way: the backfill skips it, a head change re-reads after it",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    // A pending owner without a link whose device a revocation holds: the
    // backfill skips it rather than bridging an owner that is leaving.
    const leaving = await seedAccountless(pool, table);
    await publishHead(pool, table, leaving.participantId, await insertDomain(pool, table, leaving), 1);
    await initializeSource(pool, table, 5);
    assert.equal(await pendingCount(pool, quoted), 1);
    const disconnect = await openTransaction(pool);
    try {
      await disconnect.client.query(`UPDATE ${table("device_credentials")}
        SET state='revoked', revoked_at=clock_timestamp() WHERE id=$1`, [leaving.deviceId]);
      assert.equal((await backfillOnce(pool, quoted, 500)).bridged, 0, "a device being revoked is skipped");
      await disconnect.commit();
    } finally {
      await disconnect.rollback();
    }
    assert.equal(await pendingCount(pool, quoted), 0);
    assert.equal(await link(pool, table, leaving.participantId), null);
    assert.deepEqual(await receipts(pool, table, leaving.participantId), []);

    const owner = await seedAccountless(pool, table);
    const g1 = await insertDomain(pool, table, owner);
    await publishHead(pool, table, owner.participantId, g1, 1);
    const bridged = await assertOneRowPerReceipt(pool, table, owner.participantId);
    assert.equal(bridged.rows.length, 1);
    const g2 = await insertDomain(pool, table, owner, g1);

    // A revocation that also withdraws the owner link (the shape of the
    // planned device withdrawal trigger) is under way when the head changes.
    const revocation = await openTransaction(pool);
    let headChange;
    try {
      await revocation.client.query(`UPDATE ${table("device_credentials")}
        SET state='revoked', revoked_at=clock_timestamp() WHERE id=$1`, [owner.deviceId]);
      await revocation.client.query(`UPDATE ${table("storage_v11_owner_links")} SET state='withdrawn'
        WHERE participant_id=$1`, [owner.participantId]);
      headChange = publishHead(pool, table, owner.participantId, g2, 2).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
      assert.equal(await blockedBy(pool, revocation.pid), true, "the head change waits on the link");
      await revocation.commit();
    } finally {
      await revocation.rollback();
    }
    assert.equal((await headChange).ok, true);
    const after = await assertOneRowPerReceipt(pool, table, owner.participantId);
    assert.equal(after.ownerLink.state, "withdrawn", "the withdrawal is not reversed");
    assert.deepEqual(after.ownerReceipts.map(({ generation_id }) => generation_id), [g1], "no receipt for the new head");
    assert.deepEqual(after.rows, bridged.rows, "no journal row for the new head");
    assert.equal(await pendingCount(pool, quoted), 0);
  }));

test("PG17 the backfill inspects at most its limit and a run that makes no progress stops",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, schema, quoted, table }) => {
    const { runPostgresV12OwnerBridgeBackfill } = await workerModule("/src/postgres-v12-owner-bridge.ts");
    const options = { pool, schema: { primarySchema: schema } };
    const run = randomUUID();
    const owners = [];
    for (const name of ["p1", "p2", "p3"]) {
      const owner = await seedAccountless(pool, table, { participantId: `participant:oj2-${name}-${run}` });
      await publishHead(pool, table, owner.participantId, await insertDomain(pool, table, owner), 1);
      owners.push(owner);
    }
    await initializeSource(pool, table, 5);
    const fence = await openTransaction(pool);
    try {
      await fence.client.query(`SELECT 1 FROM ${table("participants")} WHERE id=$1 FOR UPDATE`, [owners[0].participantId]);
      assert.equal((await backfillOnce(pool, quoted, 1)).bridged, 0, "a limit of one inspects only the first, held head");
      assert.equal(await pendingCount(pool, quoted), 3);
      assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, limit: 1, deadlineMs: Date.now() + 60_000 }),
        { status: "deferred", bridged: 0, batches: 1, pending: 3 }, "a transaction without progress ends the run");
      assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, deadlineMs: Date.now() + 60_000 }),
        { status: "deferred", bridged: 2, batches: 3, pending: 1 }, "one head per transaction past the held one");
    } finally {
      await fence.rollback();
    }
    assert.deepEqual(await runPostgresV12OwnerBridgeBackfill({ ...options, limit: 1, deadlineMs: Date.now() + 60_000 }),
      { status: "complete", bridged: 1, batches: 1, pending: 0 });
    for (const owner of owners) {
      assert.deepEqual((await assertOneRowPerReceipt(pool, table, owner.participantId)).rows.map(({ revision }) => revision), [1]);
    }
  }));

test("PG17 a v1.2 head on a device other than the owner's eligible device mints nothing and is not pending",
  { skip: SKIP, timeout: 180_000 }, async () => withSchema(async ({ pool, quoted, table }) => {
    await initializeSource(pool, table, 5);
    // An accountless owner eligible through the v1.1 branch for v11Device,
    // with a second enrolled device that holds no grant.
    const participantId = `participant:${randomUUID()}`;
    const [v11Device, otherDevice] = [randomUUID(), randomUUID()];
    const issuedAt = new Date(Date.now() - HOUR_MS);
    const expiresAt = new Date(Date.now() + 30 * 24 * HOUR_MS);
    await pool.query(`INSERT INTO ${table("participants")} (id,owner_kind,state,created_at) VALUES ($1,'accountless','active',$2)`,
      [participantId, issuedAt]);
    for (const deviceId of [v11Device, otherDevice]) {
      const secret = randomBytes(32);
      await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")} (
          device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
          state,issued_at,expires_at
        ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1','active',$4,$5)`,
      [deviceId, secret, `synthetic-install-${deviceId}`, issuedAt, expiresAt]);
      await pool.query(`INSERT INTO ${table("device_credentials")} (
          id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,issued_at,expires_at,last_used_at
        ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`, [deviceId, participantId, secret, issuedAt, expiresAt]);
    }
    await pool.query(`INSERT INTO ${table("accountless_upload_owners")} (
        enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
        authorized_at,expires_at,state
      ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
    [v11Device, participantId, issuedAt, expiresAt]);
    await pool.query(`INSERT INTO ${table("accountless_v11_device_authorizations")} (
        enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,
        privacy_contract_version,authorized_at,expires_at,state
      ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
        'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active')`, [v11Device, participantId, issuedAt, expiresAt]);
    const v11Token = digest(`v11-token-${participantId}`);
    const v11Generation = randomUUID();
    await pool.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
        token_hash,participant_id,device_id,legacy_fingerprint,input_revision,from_day,through_day,winners_json,
        created_at,expires_at
      ) VALUES ($1,$2,$3,$4,0,$5::date,$5::date,'[]',clock_timestamp(),clock_timestamp() + interval '1 day')`,
    [v11Token, participantId, v11Device, digest(`v11-fingerprint-${participantId}`), DAY_1]);
    await pool.query(`INSERT INTO ${table("telemetry_v11_domains")} (
        id,participant_id,device_id,predecessor_token_hash,manifest_digest,legacy_fingerprint,input_revision,
        from_day,through_day,days_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,0,$7::date,$7::date,'[]',clock_timestamp())`,
    [v11Generation, participantId, v11Device, v11Token, digest(`v11-manifest-${participantId}`),
      digest(`v11-fingerprint-${participantId}`), DAY_1]);
    await pool.query(`INSERT INTO ${table("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,clock_timestamp())`, [participantId, v11Generation]);
    assert.deepEqual(await eligibleOwners(pool, table, participantId), [{ owner_kind: "accountless", device_id: v11Device }]);

    const elsewhere = await insertDomain(pool, table, { participantId, deviceId: otherDevice });
    await publishHead(pool, table, participantId, elsewhere, 1);
    assert.equal(await link(pool, table, participantId), null, "no link for a head on another device");
    assert.deepEqual(await receipts(pool, table, participantId), []);
    assert.equal(await pendingCount(pool, quoted), 0, "a head on another device is not pending");
    assert.equal((await backfillOnce(pool, quoted, 500)).bridged, 0);
    assert.deepEqual((await journal(pool, table)).filter((row) => row.version === 1), []);

    // Control: the same owner's next head on the eligible device is bridged.
    const here = await insertDomain(pool, table, { participantId, deviceId: v11Device }, elsewhere);
    await publishHead(pool, table, participantId, here, 2);
    const control = await assertOneRowPerReceipt(pool, table, participantId);
    assert.equal(control.ownerLink.state, "active");
    assert.deepEqual(control.ownerReceipts.map(({ generation_id, device_id }) => [generation_id, device_id]), [[here, v11Device]]);
  }));

test("the bridge wrappers validate input, map constant refusals and rethrow anything else sanitized", async () => {
  const { readPostgresV12OwnerBridgePending, runPostgresV12OwnerBridgeBackfill, PostgresV12OwnerBridgeError,
    POSTGRES_V12_OWNER_BRIDGE_MAX_BATCH } = await workerModule("/src/postgres-v12-owner-bridge.ts");
  const { PostgresStorageError } = await workerModule("/src/postgres-client.ts");
  assert.equal(POSTGRES_V12_OWNER_BRIDGE_MAX_BATCH, 500);
  const stub = (respond) => ({
    async connect() {
      return {
        async query(text) {
          if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
          return respond(text);
        },
        release() {},
      };
    },
  });
  const typed = (code) => (error) => error instanceof PostgresV12OwnerBridgeError && error.code === code;
  const pending = (text) => text.includes("storage_v12_bridge_pending_count")
    ? { rows: [{ source_initialized: true, pending: "3" }], rowCount: 1 } : null;
  for (const bad of [null, {}, { pool: {} }, { pool: stub(pending), schema: { primarySchema: "Bad-Schema" } }]) {
    await assert.rejects(readPostgresV12OwnerBridgePending(bad), typed("V12_OWNER_BRIDGE_INPUT_INVALID"));
  }
  assert.deepEqual(await readPostgresV12OwnerBridgePending({ pool: stub(pending) }), { sourceInitialized: true, pending: 3 });
  await assert.rejects(readPostgresV12OwnerBridgePending({
    pool: stub(() => ({ rows: [{ source_initialized: "yes", pending: "3" }], rowCount: 1 })),
  }), typed("V12_OWNER_BRIDGE_READBACK_FAILED"));
  await assert.rejects(runPostgresV12OwnerBridgeBackfill({ pool: stub(pending), deadlineMs: Number.NaN }),
    typed("V12_OWNER_BRIDGE_INPUT_INVALID"));
  const refusal = (message) => stub((text) => {
    if (text.includes("storage_v12_bridge_backfill")) throw Object.assign(new Error(message), { code: "P1005" });
    return pending(text);
  });
  await assert.rejects(runPostgresV12OwnerBridgeBackfill({ pool: refusal("storage_v12_bridge_transfer_session"),
    deadlineMs: Date.now() + 1_000 }), typed("V12_OWNER_BRIDGE_TRANSFER_SESSION"));
  await assert.rejects(runPostgresV12OwnerBridgeBackfill({ pool: refusal("storage_v12_bridge_limit_invalid"),
    deadlineMs: Date.now() + 1_000 }), typed("V12_OWNER_BRIDGE_INPUT_INVALID"));
  for (const [message, code] of [["duplicate key value violates unique constraint \"x\"", "23505"],
    ["storage_v12_bridge_transfer_session", "XX000"], ["participant detail", "P1005"]]) {
    await assert.rejects(runPostgresV12OwnerBridgeBackfill({
      pool: stub((text) => {
        if (text.includes("storage_v12_bridge_backfill")) throw Object.assign(new Error(message), { code });
        return pending(text);
      }),
      deadlineMs: Date.now() + 1_000,
    }), (error) => error instanceof PostgresStorageError && !error.message.includes(message),
    "an unmapped failure is sanitized and carries no database text");
  }
  let batches = 0;
  const counted = await runPostgresV12OwnerBridgeBackfill({
    pool: stub((text) => {
      if (text.includes("storage_v12_bridge_backfill")) {
        batches += 1;
        return { rows: [{ bridged: "2" }], rowCount: 1 };
      }
      return { rows: [{ source_initialized: true, pending: String(Math.max(0, 4 - batches * 2)) }], rowCount: 1 };
    }),
    limit: 2,
    deadlineMs: Date.now() + 1_000,
  });
  assert.deepEqual(counted, { status: "complete", bridged: 4, batches: 2, pending: 0 });

  // A transaction that bridges nothing while heads are still pending (all of
  // them held by concurrent changes) ends the run as deferred, without retrying.
  let stalled = 0;
  const deferred = await runPostgresV12OwnerBridgeBackfill({
    pool: stub((text) => {
      if (text.includes("storage_v12_bridge_backfill")) {
        stalled += 1;
        return { rows: [{ bridged: "0" }], rowCount: 1 };
      }
      return pending(text);
    }),
    deadlineMs: Date.now() + 60_000,
  });
  assert.deepEqual(deferred, { status: "deferred", bridged: 0, batches: 1, pending: 3 });
  assert.equal(stalled, 1, "a zero-progress transaction is not retried within the run");

  // The backlog is counted once, and again only when the heads bridged since
  // reach that count; the deadline stops the run between transactions.
  let reads = 0;
  let clock = 0;
  const bounded = await runPostgresV12OwnerBridgeBackfill({
    pool: stub((text) => {
      if (text.includes("storage_v12_bridge_backfill")) {
        clock += 10;
        return { rows: [{ bridged: "1" }], rowCount: 1 };
      }
      reads += 1;
      return { rows: [{ source_initialized: true, pending: "5" }], rowCount: 1 };
    }),
    deadlineMs: 30,
    now: () => clock,
  });
  assert.deepEqual(bounded, { status: "deferred", bridged: 3, batches: 3, pending: 2 });
  assert.equal(reads, 1, "one count serves every transaction of the run");
});
