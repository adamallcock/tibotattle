import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;

// The production image executes an esbuild bundle because its application
// TypeScript imports intentionally omit runtime extensions. Import the same
// entrypoint shape here rather than testing an un-runnable source module.
const cliDirectory = await mkdtemp(join(ROOT, ".tmp-synthetic-v12-cleanup-cli-"));
const cliPath = join(cliDirectory, "synthetic-v12-cleanup.mjs");
await build({
  entryPoints: [resolve(ROOT, "synthetic-v12-cleanup.mjs")],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: cliPath,
  logLevel: "silent",
});
const {
  cleanupSyntheticV12Participant,
  parseSyntheticV12CleanupConfig,
  readAttachedSyntheticCleanupServiceAccount,
  runSyntheticV12Cleanup,
  SYNTHETIC_V12_CLEANUP_RECEIPT_SCHEMA,
  SYNTHETIC_V12_CLEANUP_JOB,
  SYNTHETIC_V12_CLEANUP_SERVICE,
  SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT,
  SYNTHETIC_V12_CLEANUP_TARGETS,
} = await import(pathToFileURL(cliPath).href);
test.after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

const CLEANUP_BUCKET = "tibotattle-gcs-test-cleanup-20260925-a2";
const OLD_APP_BUCKET = "tibotattle-gcs-test-app-20260922";
const A1_BUCKET = "tibotattle-gcs-test-cleanup-20260925-a1";
const PARTICIPANT_ID = "synthetic-v12-smoke-20000000-0000-4000-8000-000000000001";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function proof(bucket = CLEANUP_BUCKET) {
  const creationRequest = {
    name: bucket,
    location: "US-EAST1",
    storageClass: "STANDARD",
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: "enforced",
    },
    softDeletePolicy: { retentionDurationSeconds: "0" },
    versioning: { enabled: false },
  };
  const creationResponse = {
    bucket,
    projectNumber: "806510610397",
    bucketGeneration: "1",
    bucketMetageneration: "1",
    location: "US-EAST1",
    timeCreated: "2026-09-25T04:30:00.000Z",
    softDeleteRetentionDurationSeconds: "0",
    iamConfiguration: {
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
    },
    versioningEnabled: false,
  };
  return JSON.stringify({
    schemaVersion: "gcs-erasure-bucket-history-receipt-v1",
    source: "storage.buckets.insert",
    project: SYNTHETIC_V12_CLEANUP_TARGETS.project,
    projectNumber: "806510610397",
    creationRequestSha256: digest(creationRequest),
    creationResponse,
    creationResponseSha256: digest(creationResponse),
    proof: {
      bucket,
      bucketGeneration: "1",
      bucketMetageneration: "1",
      softDeleteRetentionDurationSeconds: "0",
    },
  });
}

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: SYNTHETIC_V12_CLEANUP_JOB,
    CLOUD_RUN_EXECUTION: "tibotattle-v12-synthetic-cleanup-00001-abc",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: SYNTHETIC_V12_CLEANUP_TARGETS.project,
    CLOUD_RUN_TEST_SERVICE: SYNTHETIC_V12_CLEANUP_SERVICE,
    HOST_ORIGIN: SYNTHETIC_V12_CLEANUP_TARGETS.origin,
    POSTGRES_IAM_USER: SYNTHETIC_V12_CLEANUP_TARGETS.iamUser,
    PRIMARY_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_CLEANUP_TARGETS.primary.instanceConnectionName,
    PRIMARY_DATABASE: SYNTHETIC_V12_CLEANUP_TARGETS.primary.database,
    PRIMARY_SCHEMA: SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema,
    GCS_BUCKET_NAME: CLEANUP_BUCKET,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(),
    SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: PARTICIPANT_ID,
    ...overrides,
  };
}

test("cleanup config requires a provisioned test bucket receipt and pins the one-task owner target", () => {
  const env = validEnv();
  const parsed = parseSyntheticV12CleanupConfig(env, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT);
  assert.equal(SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema, "tibotattle_v12_a2_20260925");
  assert.equal("ledger" in SYNTHETIC_V12_CLEANUP_TARGETS, false);
  assert.equal(SYNTHETIC_V12_CLEANUP_TARGETS.bucket, CLEANUP_BUCKET);
  assert.equal(parsed.job, SYNTHETIC_V12_CLEANUP_JOB);
  assert.equal(parsed.origin, SYNTHETIC_V12_CLEANUP_TARGETS.origin);
  assert.equal(parsed.bucket, CLEANUP_BUCKET);
  assert.equal(parsed.participantId, PARTICIPANT_ID);
  for (const overrides of [
    { CLOUD_RUN_TASK_INDEX: "1" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { CLOUD_RUN_JOB: "another-job" },
    { CLOUD_RUN_TEST_SERVICE: "another-service" },
    { HOST_ORIGIN: "https://service.invalid" },
    { GOOGLE_CLOUD_PROJECT: "another-project" },
    { POSTGRES_IAM_USER: "another@tibotattle.iam" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "another:region:instance" },
    { PRIMARY_DATABASE: "another" },
    { PRIMARY_SCHEMA: "another" },
    { PRIMARY_SCHEMA: "tibotattle" },
    // The retired A2 ledger target is refused in any form.
    { LEDGER_INSTANCE_CONNECTION_NAME: "tibotattle:us-east1:tibotattle-test-ledger-20260922" },
    { LEDGER_DATABASE: "tibotattle_ledger" },
    { LEDGER_SCHEMA: "tibotattle_ledger_v12_a2_20260925" },
    { LEDGER_SCHEMA: "" },
    { GCS_BUCKET_NAME: "another-test-bucket" },
    { GCS_BUCKET_NAME: OLD_APP_BUCKET },
    { GCS_BUCKET_NAME: A1_BUCKET },
    { GCS_BUCKET_NAME: OLD_APP_BUCKET, GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(OLD_APP_BUCKET) },
    { GCS_BUCKET_NAME: A1_BUCKET, GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(A1_BUCKET) },
    { GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("another-test-bucket") },
    { SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: "participant:real-user" },
    { SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: "synthetic-v12-smoke-not-a-uuid" },
  ]) {
    assert.throws(() => parseSyntheticV12CleanupConfig({ ...env, ...overrides }, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT));
  }
  const alteredReceipt = JSON.parse(proof());
  alteredReceipt.creationResponse.softDeleteRetentionDurationSeconds = "604800";
  assert.throws(() => parseSyntheticV12CleanupConfig({
    ...env,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify(alteredReceipt),
  }, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT));
  const wrongProjectReceipt = JSON.parse(proof());
  wrongProjectReceipt.creationResponse.projectNumber = "123456789012";
  wrongProjectReceipt.creationResponseSha256 = digest(wrongProjectReceipt.creationResponse);
  assert.throws(() => parseSyntheticV12CleanupConfig({
    ...env,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify(wrongProjectReceipt),
  }, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT));
  assert.throws(() => parseSyntheticV12CleanupConfig(env, "another@tibotattle.iam.gserviceaccount.com"));
  assert.throws(() => parseSyntheticV12CleanupConfig(env, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT + ".evil"));
});

test("Cloud Run metadata identity is checked without logging its value", async () => {
  const response = (email, status = 200, flavor = "Google") => ({
    status,
    headers: { get(name) { return name === "Metadata-Flavor" ? flavor : null; } },
    async text() { return email; },
  });
  assert.equal(await readAttachedSyntheticCleanupServiceAccount({
    fetchImpl: async (url, options) => {
      assert.match(url, /^http:\/\/metadata\.google\.internal\//u);
      assert.equal(options.headers["Metadata-Flavor"], "Google");
      return response(SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT);
    },
  }), SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT);
  await assert.rejects(readAttachedSyntheticCleanupServiceAccount({
    fetchImpl: async () => response("different@tibotattle.iam.gserviceaccount.com"),
  }));
  await assert.rejects(readAttachedSyntheticCleanupServiceAccount({
    fetchImpl: async () => response(SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT, 200, "missing"),
  }));
});

test("wrong job and origin fail before SQL connector or GCS construction", async () => {
  let accessCalls = 0;
  const dependencies = {
    async readServiceAccountEmail() { accessCalls += 1; return SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT; },
    createConnector() { throw new Error("must not connect"); },
  };
  await assert.rejects(runSyntheticV12Cleanup({
    env: validEnv({ CLOUD_RUN_JOB: "not-the-cleanup-job" }), dependencies,
  }), /CLOUD_RUN_SYNTHETIC_CLEANUP_JOB_CONTEXT_INVALID/u);
  assert.equal(accessCalls, 0);
  await assert.rejects(runSyntheticV12Cleanup({
    env: validEnv({ HOST_ORIGIN: "https://service.invalid" }), dependencies,
  }), /CLOUD_RUN_SYNTHETIC_CLEANUP_SERVICE_INVALID/u);
  assert.equal(accessCalls, 1);
});

async function localPostgresEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "local cleanup checks require loopback PostgreSQL or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  return null;
}

function qualified(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

async function seedOwner(pool, schema, { withChunk = false } = {}) {
  const participantId = `synthetic-v12-smoke-${randomUUID()}`;
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  const ownerDigest = randomBytes(32).toString("hex");
  const priorSecretHash = randomBytes(32);
  const replacementSecretHash = randomBytes(32);
  const now = new Date();
  const later = new Date(now.getTime() + 86_400_000);
  await pool.query(
    `INSERT INTO ${qualified(schema, "participants")} (
       id, owner_kind, state, consent_version, consented_at, created_at
     ) VALUES ($1, 'social', 'active', 'privacy-safe-telemetry-v0.1', $2, $2)`,
    [participantId, now],
  );
  // Primary 0051 creates the social participant's attribution enrollment with
  // the participant (D1 parity); the fixture only checks that it exists.
  assert.equal((await pool.query(
    `SELECT count(*)::integer AS count FROM ${qualified(schema, "attribution_enrollments")} WHERE participant_id=$1`,
    [participantId],
  )).rows[0].count, 1);
  await pool.query(
    `INSERT INTO ${qualified(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, later],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1, $2, $3, $4, 'privacy-safe-telemetry-v0.1', 'privacy-safe-telemetry-v0.1',
       'consumed', $5, $6, $5, $7)`,
    [pairingId, participantId, sessionId, randomBytes(32), now, later, deviceId],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at, credential_generation
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5, 2)`,
    [deviceId, participantId, pairingId, replacementSecretHash, now, later],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "device_credential_rotations")} (
       id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
       attempt_id, generation, rotated_at, retire_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8)`,
    [randomUUID(), deviceId, participantId, priorSecretHash, replacementSecretHash,
      randomUUID(), now, later],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "telemetry_v12_device_capabilities")} (
       participant_id, device_id, telemetry_schema_version, field_dictionary_version,
       privacy_contract_version, state, consented_at
     ) VALUES ($1, $2, 'telemetry-contribution-v1.2',
       'telemetry-v1.2-registry-2026-09-20.1', 'ongoing-privacy-safe-telemetry-v1.2', 'accepted', $3)`,
    [participantId, deviceId, now],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "storage_v11_owner_links")} (participant_id, owner_digest, state)
     VALUES ($1, $2, 'active')`,
    [participantId, ownerDigest],
  );

  let objectKey = null;
  let contributionId = null;
  if (withChunk) {
    // The discovery rules' shape: one ready manifest declaring one chunk,
    // its typed key, its registered pending object and one legacy-lane record.
    const manifestId = randomUUID();
    const grantId = randomUUID();
    contributionId = `chunk:${randomUUID()}`;
    objectKey = `telemetry/v12-${randomUUID()}`;
    const chunkName = randomUUID();
    const day = "2026-09-24";
    const digest = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO ${qualified(schema, "device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
         content_type, state, issued_at, expires_at, consumed_at, consumed_contribution_id
       ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', 'consumed', $6, $7, $6, $8)`,
      [grantId, participantId, deviceId, randomBytes(32), digest, now, later, contributionId],
    );
    await pool.query(
      `INSERT INTO ${qualified(schema, "telemetry_v12_day_manifests")} (
         id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
         manifest_json, expected_chunk_count, state, created_at
       ) VALUES ($1, $2, $3, $4::date, $5, 'v1.2-test', $6, 1, 'staged', $7)`,
      [manifestId, participantId, deviceId, day, randomBytes(32).toString("hex"),
        JSON.stringify({ day, chunks: [{ chunkId: chunkName, chunkDigest: digest, recordCount: 1 }] }), now],
    );
    await pool.query(
      `INSERT INTO ${qualified(schema, "pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1, $2, 'telemetry_v12')`,
      [contributionId, objectKey],
    );
    await pool.query(
      `INSERT INTO ${qualified(schema, "telemetry_v12_chunks")} (
         id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
         chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
         r2_key, device_upload_authorization_id, created_at
       ) VALUES ($1, $2, $3, $4, 'usage', $5::date, 0, $6, $7, $8,
         'v1.2-test', 1, $9, $10, $11)`,
      [contributionId, manifestId, participantId, deviceId, day, chunkName, digest,
        digest, objectKey, grantId, now],
    );
    await pool.query(
      `INSERT INTO ${qualified(schema, "telemetry_v12_records")} (
         chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json
       ) VALUES ($1, $2, 'usage', $3, $4, '{}')`,
      [contributionId, manifestId, `occurrence-${randomUUID()}`, now],
    );
    await pool.query(
      `UPDATE ${qualified(schema, "telemetry_v12_day_manifests")} SET state = 'ready', ready_at = $2 WHERE id = $1`,
      [manifestId, now],
    );
  }
  return { participantId, deviceId, ownerDigest, objectKey, contributionId };
}

async function seedHistoricalHeader(pool, schema, fixture) {
  const sourceImportId = randomBytes(32).toString("hex");
  const tableCounts = {
    telemetry_v11_chunks: 0,
    telemetry_v11_day_manifests: 0,
    telemetry_v1_chunks: 1,
  };
  const tableDigests = Object.fromEntries(Object.keys(tableCounts).map((name) => [name, "a".repeat(64)]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${qualified(schema, "participants").split(".")[0]}, pg_catalog`);
    await client.query(`INSERT INTO ${qualified(schema, "historical_transport_header_imports")} (
      source_import_id,target_schema,source_snapshot_id,source_snapshot_kind,source_snapshot_sha256,
      source_manifest_sha256,v1_source_namespace,v11_source_namespace,header_manifest_sha256,
      header_table_row_counts,header_table_sha256,mirror_control_schema,mirror_transfer_id,mirror_receipt_sha256
    ) VALUES ($1,$2,'synthetic-owner-archive-snapshot','synthetic-d1-fixture',$3,$4,
      'synthetic-v1-namespace','synthetic-v11-namespace',$5,$6::jsonb,$7::jsonb,
      'typed_legacy_admission_transfer_aaaaaaaa','synthetic-owner-archive-transfer',$8)`,
    [sourceImportId, schema, "b".repeat(64), "c".repeat(64), "d".repeat(64),
      JSON.stringify(tableCounts), JSON.stringify(tableDigests), "e".repeat(64)]);
    await client.query("SELECT set_config('tibotattle.legacy_header_promotion',$1,true)", [sourceImportId]);
    await client.query(`INSERT INTO ${qualified(schema, "historical_telemetry_v1_chunk_headers")} (
      source_import_id,id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
      device_upload_authorization_id,created_at
    ) VALUES ($1,'synthetic-archived-v1-header',$2,$3,'usage','2026-09-24',0,1,$4,$4,
      'synthetic-owner-archive-v1',1,1,'synthetic-owner-archive/object','synthetic-owner-archive-upload',
      '2026-09-24T10:00:00.000Z')`, [sourceImportId, fixture.participantId, fixture.deviceId, "f".repeat(64)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function seedActivatedDomain(pool, schema, participantId) {
  const device = await pool.query(
    `SELECT id FROM ${qualified(schema, "device_credentials")} WHERE participant_id=$1`,
    [participantId],
  );
  const manifest = await pool.query(
    `SELECT id,manifest_digest FROM ${qualified(schema, "telemetry_v12_day_manifests")}
      WHERE participant_id=$1`,
    [participantId],
  );
  assert.equal(device.rows.length, 1);
  assert.equal(manifest.rows.length, 1);
  const now = new Date();
  const later = new Date(now.getTime() + 86_400_000);
  const tokenHash = randomBytes(32).toString("hex");
  const fingerprint = randomBytes(32).toString("hex");
  const generationId = randomUUID();
  await pool.query(
    `INSERT INTO ${qualified(schema, "telemetry_v12_domain_predecessors")} (
      token_hash,participant_id,device_id,legacy_fingerprint,input_revision,
      from_day,through_day,days_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,0,DATE '2026-09-24',DATE '2026-09-24','[]',$5,$6)`,
    [tokenHash, participantId, device.rows[0].id, fingerprint, now, later],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "telemetry_v12_domains")} (
      id,participant_id,device_id,predecessor_token_hash,manifest_digest,
      legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,0,DATE '2026-09-24',DATE '2026-09-24','[]',$7)`,
    [generationId, participantId, device.rows[0].id, tokenHash,
      randomBytes(32).toString("hex"), fingerprint, now],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "telemetry_v12_domain_days")} (
      generation_id,observed_day,manifest_id,manifest_digest
    ) VALUES ($1,DATE '2026-09-24',$2,$3)`,
    [generationId, manifest.rows[0].id, manifest.rows[0].manifest_digest],
  );
  await pool.query(
    `INSERT INTO ${qualified(schema, "telemetry_v12_domain_heads")} (
      participant_id,generation_id,revision,updated_at
    ) VALUES ($1,$2,1,$3)`,
    [participantId, generationId, now],
  );
  return generationId;
}

function fakeManifest() {
  const primary = Array.from({ length: 64 }, (_, index) => ({
    role: "primary",
    version: index + 1,
    name: index + 1 === 64 ? "0064_append_only_residue.sql" : `${String(index + 1).padStart(4, "0")}_fixture.sql`,
    bytes: 1,
    sql: "x",
    sha256: "a".repeat(64),
  }));
  return { roles: { primary } };
}

function migrationPool(migrations) {
  return {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith("SELECT current_setting('server_version_num')")) {
            return { rows: [{ server_version_num: 170000 }] };
          }
          if (sql.includes("_tibotattle_migration_history")) {
            return {
              rows: migrations.map((migration) => ({
                version: migration.version,
                name: migration.name,
                checksum_sha256: migration.sha256,
              })),
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

function injectedDependencies(overrides = {}) {
  const manifest = fakeManifest();
  const calls = { pools: [], cleanups: [], closed: 0, stores: 0 };
  const dependencies = {
    async readServiceAccountEmail() { return SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT; },
    buildManifest: async () => manifest,
    createConnector() { return { marker: "connector" }; },
    async createPool(options) {
      calls.pools.push(options);
      return migrationPool(manifest.roles.primary);
    },
    async createAccessTokenProvider() { return async () => "synthetic-token"; },
    createObjectStore({ bucket, historyProof }) {
      calls.stores += 1;
      assert.equal(bucket, CLEANUP_BUCKET);
      assert.equal(historyProof.bucket, CLEANUP_BUCKET, "OD-2: the history proof still reaches the store");
      return { async delete() {} };
    },
    async cleanupParticipant(options) {
      calls.cleanups.push(options);
      return { status: "complete", objectsDeleted: 1, erasureReceipts: 1 };
    },
    async closeResources({ pools, connector }) {
      assert.equal(pools.length, 1, "one primary pool, no ledger pool");
      assert.equal(connector.marker, "connector");
      calls.closed += 1;
    },
    ...overrides,
  };
  return { dependencies, calls, manifest };
}

test("injected cleanup verifies the primary receipt on one pool and returns a redacted receipt", async () => {
  const { dependencies, calls } = injectedDependencies();
  const result = await runSyntheticV12Cleanup({ env: validEnv(), dependencies });
  assert.deepEqual(result, { status: "complete", objectsDeleted: 1, erasureReceipts: 1 });
  assert.equal(calls.stores, 1);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.pools.map((call) => call.instanceConnectionName), [
    SYNTHETIC_V12_CLEANUP_TARGETS.primary.instanceConnectionName,
  ]);
  assert.ok(calls.pools.every((call) => call.user === SYNTHETIC_V12_CLEANUP_TARGETS.iamUser));
  assert.equal(calls.cleanups.length, 1);
  assert.equal(calls.cleanups[0].schema, SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema);
  assert.equal(calls.cleanups[0].participantId, PARTICIPANT_ID);
  assert.equal(JSON.stringify(result).includes(PARTICIPANT_ID), false);
  assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
  assert.equal(SYNTHETIC_V12_CLEANUP_RECEIPT_SCHEMA, "synthetic-v12-owner-cleanup-receipt-v2");
});

test("a stale manifest or a stale ledger setting stops before any pool or object store", async () => {
  const base = fakeManifest();
  for (const [label, env, manifest, code] of [
    ["v1 dual-role manifest", validEnv(), { roles: { ...base.roles, ledger: [] } },
      "POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID"],
    ["63-migration manifest", validEnv(), { roles: { primary: base.roles.primary.slice(0, 63) } },
      "POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID"],
    ["retired ledger schema", validEnv({ LEDGER_SCHEMA: "tibotattle_ledger_v12_a2_20260925" }), base,
      "POSTGRES_SYNTHETIC_CLEANUP_TARGET_INVALID"],
  ]) {
    const { dependencies, calls } = injectedDependencies({ buildManifest: async () => manifest });
    await assert.rejects(runSyntheticV12Cleanup({ env, dependencies }), { code }, label);
    assert.equal(calls.pools.length, 0, label);
    assert.equal(calls.stores, 0, label);
    assert.equal(calls.cleanups.length, 0, label);
  }
});

test("the cleanup bundle graph carries no ledger, tombstone, cooldown, retirement or eraser module", async () => {
  const result = await build({
    entryPoints: [resolve(ROOT, "synthetic-v12-cleanup.mjs")],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs)
    .map((path) => relative(WORKER_ROOT, resolve(process.cwd(), path)));
  assert.ok(inputs.includes("src/gcs-quarantine-object-store.ts"), "the quarantine delete primitive is the object path");
  assert.ok(inputs.includes("cloud-run/synthetic-v12-discovery.mjs"), "the discovery rules scope the target");
  for (const input of inputs) {
    assert.doesNotMatch(input, /ledger|tombstone|cooldown|retirement|owner-erasure|participant-erasure|storage-erasure|(?:^|\/)retention\.ts$/u, input);
  }
});

test("cleanupSyntheticV12Participant refuses a non-synthetic target or missing store before any query", async () => {
  let connected = 0;
  const pool = { async connect() { connected += 1; throw new Error("must not connect"); } };
  const objectStore = { async delete() { throw new Error("must not delete"); } };
  for (const [participantId, code] of [
    ["participant:real-user", "SYNTHETIC_CLEANUP_PARTICIPANT_INVALID"],
    ["synthetic-v12-smoke-not-a-uuid", "SYNTHETIC_CLEANUP_PARTICIPANT_INVALID"],
    [`real-${randomUUID()}`, "SYNTHETIC_CLEANUP_PARTICIPANT_INVALID"],
  ]) {
    await assert.rejects(cleanupSyntheticV12Participant({ pool, schema: "w3_simp_cleanup", participantId, objectStore }),
      { code });
  }
  await assert.rejects(cleanupSyntheticV12Participant({
    pool, schema: "w3_simp_cleanup", participantId: PARTICIPANT_ID, objectStore: { deleteBatch() {} },
  }), { code: "SYNTHETIC_CLEANUP_DEPENDENCIES_INVALID" });
  await assert.rejects(cleanupSyntheticV12Participant({
    pool, schema: "pg_catalog", participantId: PARTICIPANT_ID, objectStore,
  }), { code: "SYNTHETIC_CLEANUP_SCHEMA_INVALID" });
  assert.equal(connected, 0);
});

/**
 * A local PG17 schema migrated to the full primary chain; dropped afterwards.
 * A historical-header fixture needs primary 0040's typed_legacy_target_
 * schema family, so that case names its schema there (still tagged w3_simp).
 */
async function withMigratedSchema(label, run, { historicalHeaders = false } = {}) {
  const endpoint = await localPostgresEndpoint();
  const schema = `${historicalHeaders ? "typed_legacy_target_" : ""}w3_simp_cleanup_${label}_${
    randomBytes(4).toString("hex")}`;
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 3_000,
  });
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the local cleanup integration check requires PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await run(pool, schema);
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    await pool.end();
  }
}

function spyStore({ failFirst = false } = {}) {
  const deletes = [];
  let fail = failFirst;
  return {
    deletes,
    store: {
      async delete(key) {
        deletes.push(key);
        if (fail) {
          fail = false;
          throw new Error("provider detail must not escape");
        }
      },
    },
  };
}

async function count(pool, schema, table, where = "", params = []) {
  return (await pool.query(
    `SELECT count(*)::int AS count FROM ${qualified(schema, table)} ${where}`, params,
  )).rows[0].count;
}

const PG_ENABLED = Boolean(PG_TEST_HOST || PG_TEST_SOCKET);

test("PG17: a synthetic owner is deleted with its object and exactly one erasure receipt; a rerun is a no-op", {
  skip: !PG_ENABLED,
  timeout: 180_000,
}, async () => {
  await withMigratedSchema("owner", async (pool, schema) => {
    const fixture = await seedOwner(pool, schema, { withChunk: true });
    await pool.query(
      `INSERT INTO ${qualified(schema, "input_source_digests")} (participant_id,digest) VALUES($1,$2)`,
      [fixture.participantId, randomBytes(16).toString("hex")],
    );
    const generationId = await seedActivatedDomain(pool, schema, fixture.participantId);
    const receiptsBefore = await count(pool, schema, "storage_owner_erasure_receipts");
    const { deletes, store } = spyStore();
    const first = await cleanupSyntheticV12Participant({
      pool, schema, participantId: fixture.participantId, objectStore: store,
    });
    assert.deepEqual(first, { status: "complete", objectsDeleted: 1, erasureReceipts: 1 });
    assert.deepEqual(deletes, [fixture.objectKey], "the one DB-derived key goes through the quarantine delete");
    assert.equal(await count(pool, schema, "participants", "WHERE id=$1", [fixture.participantId]), 0);
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts") - receiptsBefore, 1,
      "exactly one erasure receipt is written");
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts", "WHERE owner_digest=$1",
      [fixture.ownerDigest]), 1);
    assert.equal(await count(pool, schema, "storage_v11_owner_links", "WHERE participant_id=$1",
      [fixture.participantId]), 0);
    assert.equal(await count(pool, schema, "pending_objects", "WHERE object_key=$1", [fixture.objectKey]), 0,
      "the deleted object's registration is cleared");
    for (const table of ["web_sessions", "device_pairings", "device_credentials", "device_credential_rotations",
      "attribution_enrollments", "telemetry_v12_device_capabilities", "telemetry_v12_day_manifests",
      "telemetry_v12_chunks", "input_source_digests", "telemetry_v12_domain_predecessors",
      "telemetry_v12_domain_heads"]) {
      assert.equal(await count(pool, schema, table, "WHERE participant_id=$1", [fixture.participantId]), 0,
        `${table} cascades with the participant`);
    }
    assert.equal(await count(pool, schema, "telemetry_v12_domain_days", "WHERE generation_id=$1",
      [generationId]), 0);

    const rerun = await cleanupSyntheticV12Participant({
      pool, schema, participantId: fixture.participantId, objectStore: store,
    });
    assert.deepEqual(rerun, { status: "absent", objectsDeleted: 0 });
    assert.equal(deletes.length, 1, "a rerun deletes nothing");
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts") - receiptsBefore, 1);
  });
});

test("PG17: an object delete failure leaves the participant deleted and the object registered for reconciliation", {
  skip: !PG_ENABLED,
  timeout: 180_000,
}, async () => {
  await withMigratedSchema("objfail", async (pool, schema) => {
    const fixture = await seedOwner(pool, schema, { withChunk: true });
    const { deletes, store } = spyStore({ failFirst: true });
    const result = await cleanupSyntheticV12Participant({
      pool, schema, participantId: fixture.participantId, objectStore: store,
    });
    assert.deepEqual(result, { status: "incomplete", code: "GCS_SYNTHETIC_CLEANUP_OBJECT_DELETE_DEFERRED" });
    assert.equal(JSON.stringify(result).includes("provider detail"), false);
    assert.deepEqual(deletes, [fixture.objectKey]);
    assert.equal(await count(pool, schema, "participants", "WHERE id=$1", [fixture.participantId]), 0,
      "plan-v5 order: the participant delete committed before the object step");
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts", "WHERE owner_digest=$1",
      [fixture.ownerDigest]), 1);
    const pending = await pool.query(
      `SELECT reconciliation_state FROM ${qualified(schema, "pending_objects")} WHERE object_key=$1`,
      [fixture.objectKey],
    );
    assert.deepEqual(pending.rows, [{ reconciliation_state: "registered" }],
      "the unreferenced registration stays for the pending-object reconciliation");
  });
});

test("PG17: owners outside the discovery rules and grant redeemers are refused before any write", {
  skip: !PG_ENABLED,
  timeout: 180_000,
}, async () => {
  await withMigratedSchema("refuse", async (pool, schema) => {
    const { deletes, store } = spyStore();
    const receiptsBefore = await count(pool, schema, "storage_owner_erasure_receipts");

    // A participant with a non-synthetic tag is refused by the id rule alone.
    const realId = `real-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${qualified(schema, "participants")} (
         id, owner_kind, state, consent_version, consented_at, created_at
       ) VALUES ($1, 'social', 'active', 'privacy-safe-telemetry-v0.1', now(), now())`,
      [realId],
    );
    await assert.rejects(cleanupSyntheticV12Participant({ pool, schema, participantId: realId, objectStore: store }),
      { code: "SYNTHETIC_CLEANUP_PARTICIPANT_INVALID" });
    assert.equal(await count(pool, schema, "participants", "WHERE id=$1", [realId]), 1);

    // An extra credential rotation is outside the per-owner family envelope.
    const extra = await seedOwner(pool, schema);
    const replacement = randomBytes(32);
    await pool.query(`UPDATE ${qualified(schema, "device_credentials")} SET credential_generation=3, secret_hash=$2 WHERE id=$1`,
      [extra.deviceId, replacement]);
    await pool.query(
      `INSERT INTO ${qualified(schema, "device_credential_rotations")} (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 3, now(), now() + interval '1 day')`,
      [randomUUID(), extra.deviceId, extra.participantId, randomBytes(32), replacement, randomUUID()],
    );
    await assert.rejects(cleanupSyntheticV12Participant({
      pool, schema, participantId: extra.participantId, objectStore: store,
    }), { code: "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID" });
    assert.equal((await pool.query(`SELECT state FROM ${qualified(schema, "participants")} WHERE id=$1`,
      [extra.participantId])).rows[0]?.state, "active");

    // A historical v1 archive reference is outside the envelope too.
    const archived = await seedOwner(pool, schema);
    await seedHistoricalHeader(pool, schema, archived);
    await assert.rejects(cleanupSyntheticV12Participant({
      pool, schema, participantId: archived.participantId, objectStore: store,
    }), { code: "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID" });
    assert.equal(await count(pool, schema, "participants", "WHERE id=$1", [archived.participantId]), 1);

    // A smoke participant that redeemed an enrollment grant: primary 0063
    // refuses the redeemer's SET NULL (23514) and the delete rolls back.
    const redeemer = await seedOwner(pool, schema);
    await pool.query(
      `INSERT INTO ${qualified(schema, "enrollment_grants")} (
         id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id
       ) VALUES ($1, $2, 'redeemed', now() - interval '1 hour', now() + interval '1 day', now(), $3)`,
      [`grant:${randomUUID()}`, randomBytes(32), redeemer.participantId],
    );
    await assert.rejects(cleanupSyntheticV12Participant({
      pool, schema, participantId: redeemer.participantId, objectStore: store,
    }), { code: "SYNTHETIC_CLEANUP_PARTICIPANT_GRANT_REDEEMED" });
    assert.equal(await count(pool, schema, "participants", "WHERE id=$1", [redeemer.participantId]), 1);
    assert.equal(await count(pool, schema, "storage_v11_owner_links", "WHERE participant_id=$1 AND state='active'",
      [redeemer.participantId]), 1, "the rolled-back delete left the owner link active");

    assert.deepEqual(deletes, [], "no refusal reaches the object store");
    assert.equal(await count(pool, schema, "storage_owner_erasure_receipts"), receiptsBefore,
      "no refusal writes an erasure receipt");
  }, { historicalHeaders: true });
});
