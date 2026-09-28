import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import pg from "pg";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
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
  parseSyntheticV12CleanupConfig,
  readAttachedSyntheticCleanupServiceAccount,
  resolveSyntheticV12CleanupParticipantId,
  runSyntheticV12Cleanup,
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
    LEDGER_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_CLEANUP_TARGETS.ledger.instanceConnectionName,
    LEDGER_DATABASE: SYNTHETIC_V12_CLEANUP_TARGETS.ledger.database,
    LEDGER_SCHEMA: SYNTHETIC_V12_CLEANUP_TARGETS.ledger.schema,
    GCS_BUCKET_NAME: CLEANUP_BUCKET,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(),
    SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: PARTICIPANT_ID,
    ...overrides,
  };
}

function fakeManifest() {
  const roles = {};
  for (const [role, expected, tail] of [
    ["primary", 46, "0046_owner_journal_authority.sql"],
    ["ledger", 6, "0006_erasure_ledger_transfer_receipts.sql"],
  ]) {
    roles[role] = Array.from({ length: expected }, (_, index) => ({
      role,
      version: index + 1,
      name: index + 1 === expected ? tail : `${String(index + 1).padStart(4, "0")}_fixture.sql`,
      bytes: 1,
      sql: "x",
      sha256: "a".repeat(64),
    }));
  }
  return { roles };
}

function migrationPool(role, migrations) {
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

test("cleanup config requires a provisioned test bucket receipt and pins the one-task owner target", () => {
  const env = validEnv();
  const parsed = parseSyntheticV12CleanupConfig(env, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT);
  assert.equal(SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema, "tibotattle_v12_a2_20260925");
  assert.equal(SYNTHETIC_V12_CLEANUP_TARGETS.ledger.schema, "tibotattle_ledger_v12_a2_20260925");
  assert.equal(SYNTHETIC_V12_CLEANUP_TARGETS.bucket, CLEANUP_BUCKET);
  assert.equal(parsed.job, SYNTHETIC_V12_CLEANUP_JOB);
  assert.equal(parsed.origin, SYNTHETIC_V12_CLEANUP_TARGETS.origin);
  assert.equal(parsed.bucket, CLEANUP_BUCKET);
  assert.equal(parsed.participantId, PARTICIPANT_ID);
  assert.equal(parsed.selectorMode, "explicit_participant_id");
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
    { LEDGER_INSTANCE_CONNECTION_NAME: "another:region:instance" },
    { LEDGER_DATABASE: "another" },
    { LEDGER_SCHEMA: "another" },
    { LEDGER_SCHEMA: "tibotattle_ledger" },
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

test("bounded recovery config requires one exact UTC window no wider than one minute", () => {
  const env = validEnv();
  delete env.SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID;
  env.SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM = "2026-09-28T02:53:30.000Z";
  env.SYNTHETIC_V12_CLEANUP_CREATED_AT_TO = "2026-09-28T02:54:05.000Z";
  const parsed = parseSyntheticV12CleanupConfig(env, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT);
  assert.equal(parsed.participantId, null);
  assert.equal(parsed.selectorMode, "bounded_created_at_window");
  assert.equal(parsed.createdAtFrom, env.SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM);
  assert.equal(parsed.createdAtTo, env.SYNTHETIC_V12_CLEANUP_CREATED_AT_TO);

  for (const overrides of [
    { SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: undefined },
    { SYNTHETIC_V12_CLEANUP_CREATED_AT_TO: undefined },
    { SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: "2026-09-28 02:53:30Z" },
    { SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: "2026-02-30T02:53:30.000Z" },
    {
      SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: "2026-09-28T02:53:00.000Z",
      SYNTHETIC_V12_CLEANUP_CREATED_AT_TO: "2026-09-28T02:54:01.000Z",
    },
    {
      SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: "2026-09-28T02:54:05.000Z",
      SYNTHETIC_V12_CLEANUP_CREATED_AT_TO: "2026-09-28T02:53:30.000Z",
    },
    {
      SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: PARTICIPANT_ID,
    },
  ]) {
    assert.throws(() => parseSyntheticV12CleanupConfig(
      { ...env, ...overrides }, SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT,
    ));
  }
});

test("bounded recovery selector accepts exactly one synthetic owner and rejects zero or ambiguous matches", async () => {
  const candidateId = "synthetic-v12-smoke-20000000-0000-4000-8000-000000000002";
  const from = "2026-09-28T02:53:30.000Z";
  const to = "2026-09-28T02:54:05.000Z";
  const calls = [];
  let rows = [{ id: candidateId, created_at: new Date("2026-09-28T02:53:37.000Z") }];
  const pool = {
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql, values });
          return sql.includes('FROM "tibotattle_v12_a2_20260925"."participants"')
            ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  assert.equal(await resolveSyntheticV12CleanupParticipantId({
    primaryPool: pool,
    primarySchema: SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema,
    createdAtFrom: from,
    createdAtTo: to,
  }), candidateId);
  const selection = calls.find(({ sql }) => sql.includes('FROM "tibotattle_v12_a2_20260925"."participants"'));
  assert.ok(selection);
  assert.match(selection.sql, /ORDER BY participant\.created_at, participant\.id\s+LIMIT 2/u);
  assert.match(selection.sql, /owner_kind = 'social'/u);
  assert.match(selection.sql, /state = 'active'/u);
  assert.match(selection.sql, /identity_link_key IS NULL/u);
  assert.match(selection.sql, /manifest\.state = 'staged'/u);
  assert.match(selection.sql, /manifest\.expected_chunk_count = 1/u);
  assert.match(selection.sql, /NOT EXISTS \([\s\S]*telemetry_v12_chunks/u);
  assert.deepEqual(selection.values, ["synthetic-v12-smoke-%", from, to]);

  rows = [];
  await assert.rejects(resolveSyntheticV12CleanupParticipantId({
    primaryPool: pool,
    primarySchema: SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema,
    createdAtFrom: from,
    createdAtTo: to,
  }), (error) => error?.code === "SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_NOT_UNIQUE");
  rows = [
    { id: candidateId, created_at: new Date("2026-09-28T02:53:37.000Z") },
    { id: "synthetic-v12-smoke-20000000-0000-4000-8000-000000000003",
      created_at: new Date("2026-09-28T02:53:38.000Z") },
  ];
  await assert.rejects(resolveSyntheticV12CleanupParticipantId({
    primaryPool: pool,
    primarySchema: SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema,
    createdAtFrom: from,
    createdAtTo: to,
  }), (error) => error?.code === "SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_NOT_UNIQUE");
  rows = [{ id: "synthetic-v12-smoke-not-a-uuid", created_at: new Date("2026-09-28T02:53:37.000Z") }];
  await assert.rejects(resolveSyntheticV12CleanupParticipantId({
    primaryPool: pool,
    primarySchema: SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema,
    createdAtFrom: from,
    createdAtTo: to,
  }), (error) => error?.code === "SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_INVALID"
    && !error.message.includes(candidateId));
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

test("injected cleanup execution verifies both PG receipts and returns a redacted receipt", async () => {
  const manifest = fakeManifest();
  const primaryPool = migrationPool("primary", manifest.roles.primary);
  const ledgerPool = migrationPool("ledger", manifest.roles.ledger);
  const poolCalls = [];
  let storeConstructed = false;
  let closed = false;
  const participantId = validEnv().SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID;
  const result = await runSyntheticV12Cleanup({
    env: validEnv({ SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: participantId }),
    dependencies: {
      async readServiceAccountEmail() { return SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT; },
      buildManifest: async () => manifest,
      createConnector() { return { marker: "connector" }; },
      async createPool(options) {
        poolCalls.push(options);
        return options.instanceConnectionName === SYNTHETIC_V12_CLEANUP_TARGETS.primary.instanceConnectionName
          ? primaryPool : ledgerPool;
      },
      async createAccessTokenProvider() { return async () => "synthetic-token"; },
      createObjectStore({ bucket, historyProof }) {
        storeConstructed = true;
        assert.equal(bucket, CLEANUP_BUCKET);
        assert.equal(historyProof.bucket, CLEANUP_BUCKET);
        return { async deleteBatch() {} };
      },
      async eraseOwner(options) {
        assert.equal(options.participantId, participantId);
        return { status: "complete", objectsDeleted: 1 };
      },
      async closeResources({ pools, connector }) {
        assert.equal(pools.length, 2);
        assert.equal(connector.marker, "connector");
        closed = true;
      },
    },
  });
  assert.deepEqual(result, { status: "complete", objectsDeleted: 1 });
  assert.equal(storeConstructed, true);
  assert.equal(closed, true);
  assert.deepEqual(poolCalls.map((call) => call.instanceConnectionName), [
    SYNTHETIC_V12_CLEANUP_TARGETS.primary.instanceConnectionName,
    SYNTHETIC_V12_CLEANUP_TARGETS.ledger.instanceConnectionName,
  ]);
  assert.ok(poolCalls.every((call) => call.user === SYNTHETIC_V12_CLEANUP_TARGETS.iamUser));
  assert.equal(JSON.stringify(result).includes(participantId), false);
  assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
});

test("bounded recovery keeps the resolved owner in memory and replays exact erasure idempotently", async () => {
  const manifest = fakeManifest();
  const primaryPool = migrationPool("primary", manifest.roles.primary);
  const ledgerPool = migrationPool("ledger", manifest.roles.ledger);
  const candidateId = "synthetic-v12-smoke-20000000-0000-4000-8000-000000000004";
  const env = validEnv({
    SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID: undefined,
    SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM: "2026-09-28T02:53:30.000Z",
    SYNTHETIC_V12_CLEANUP_CREATED_AT_TO: "2026-09-28T02:54:05.000Z",
  });
  let eraseCalls = 0;
  let resolved = false;
  const setupOrder = [];
  const result = await runSyntheticV12Cleanup({
    env,
    dependencies: {
      async readServiceAccountEmail() { return SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT; },
      buildManifest: async () => manifest,
      createConnector() { return { marker: "connector" }; },
      async createPool(options) {
        return options.instanceConnectionName === SYNTHETIC_V12_CLEANUP_TARGETS.primary.instanceConnectionName
          ? primaryPool : ledgerPool;
      },
      async resolveParticipantId(options) {
        resolved = true;
        setupOrder.push("resolved");
        assert.equal(options.primaryPool, primaryPool);
        assert.equal(options.primarySchema, SYNTHETIC_V12_CLEANUP_TARGETS.primary.schema);
        assert.equal(options.createdAtFrom, env.SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM);
        assert.equal(options.createdAtTo, env.SYNTHETIC_V12_CLEANUP_CREATED_AT_TO);
        return candidateId;
      },
      async createAccessTokenProvider() {
        setupOrder.push("token-provider");
        return async () => "synthetic-token";
      },
      createObjectStore() {
        setupOrder.push("object-store");
        return { async deleteBatch() {} };
      },
      async eraseOwner(options) {
        eraseCalls += 1;
        assert.equal(options.participantId, candidateId);
        return eraseCalls === 1
          ? { status: "complete", objectsDeleted: 0 }
          : { status: "already_complete", objectsDeleted: 0 };
      },
      async closeResources({ pools }) { assert.equal(pools.length, 2); },
    },
  });
  assert.equal(resolved, true);
  assert.deepEqual(setupOrder, ["resolved", "token-provider", "object-store"]);
  assert.equal(eraseCalls, 2);
  assert.deepEqual(result, {
    status: "complete",
    objectsDeleted: 0,
    attempts: 2,
    replayStatus: "already_complete",
  });
  assert.equal(JSON.stringify(result).includes(candidateId), false);
  assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
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

async function seedOwner(pool, schema, {
  withChunk = false,
  withStagedManifest = false,
  withCredentialRotation = true,
} = {}) {
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
  await pool.query(
    `INSERT INTO ${qualified(schema, "attribution_enrollments")} (
       participant_id, namespace, created_at
     ) VALUES ($1, $2, $3)`,
    [participantId, randomBytes(32).toString("hex"), now],
  );
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
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5, $7)`,
    [deviceId, participantId, pairingId, replacementSecretHash, now, later,
      withCredentialRotation ? 2 : 1],
  );
  if (withCredentialRotation) {
    await pool.query(
      `INSERT INTO ${qualified(schema, "device_credential_rotations")} (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8)`,
      [randomUUID(), deviceId, participantId, priorSecretHash, replacementSecretHash,
        randomUUID(), now, later],
    );
  }
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
  if (withChunk || withStagedManifest) {
    const manifestId = randomUUID();
    const day = "2026-09-24";
    await pool.query(
      `INSERT INTO ${qualified(schema, "telemetry_v12_day_manifests")} (
         id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
         manifest_json, expected_chunk_count, state, created_at
       ) VALUES ($1, $2, $3, $4::date, $5, 'v1.2-test', $6, 1, 'staged', $7)`,
      [manifestId, participantId, deviceId, day, randomBytes(32).toString("hex"),
        JSON.stringify({ day, chunks: [] }), now],
    );
    if (withChunk) {
      const grantId = randomUUID();
      const contributionId = `chunk:${randomUUID()}`;
      objectKey = `telemetry/v12/test/${randomUUID()}`;
      const digest = randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO ${qualified(schema, "device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
           content_type, state, issued_at, expires_at, consumed_at, consumed_contribution_id
         ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', 'consumed', $6, $7, $6, $8)`,
        [grantId, participantId, deviceId, randomBytes(32), digest, now, later, contributionId],
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
        [contributionId, manifestId, participantId, deviceId, day, randomUUID(), digest,
          digest, objectKey, grantId, now],
      );
    }
  }
  return { participantId, deviceId, ownerDigest, objectKey };
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

async function importOwnerErasure(temporary) {
  const result = await build({
    entryPoints: [resolve(WORKER_ROOT, "src/postgres-owner-erasure.ts")],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const path = join(temporary, "postgres-owner-erasure.cjs");
  await writeFile(path, result.outputFiles[0].contents);
  return createRequire(import.meta.url)(path);
}

test("PG17 owner-erasure fixture fences one exact owner, retries an object failure and verifies ledger/owner receipts", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `typed_legacy_target_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 3_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  const temporary = await mkdtemp(join(ROOT, ".tmp-postgres-owner-erasure-"));
  const createdSchemas = [];
  try {
    const server = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the local cleanup integration check requires PostgreSQL 17");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    createdSchemas.push(ledgerSchema);
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);
    const { eraseSyntheticPostgresV12Owner } = await importOwnerErasure(temporary);

    const fixture = await seedOwner(primaryPool, primarySchema, { withChunk: true });
    const rotationBefore = await primaryPool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "device_credential_rotations")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(rotationBefore.rows[0]?.count, 1);
    await primaryPool.query(
      `INSERT INTO ${qualified(primarySchema, "input_source_digests")}
        (participant_id,digest) VALUES($1,$2)`,
      [fixture.participantId, randomBytes(16).toString("hex")],
    );
    const generationId = await seedActivatedDomain(
      primaryPool, primarySchema, fixture.participantId,
    );
    const sourceDigestBefore = await primaryPool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "input_source_digests")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(sourceDigestBefore.rows[0]?.count, 1);
    const deletes = [];
    let shouldFail = true;
    const objectStore = {
      async deleteBatch(refs) {
        deletes.push(refs.map((ref) => ({ ...ref })));
        assert.equal(refs.length, 1);
        assert.equal(refs[0].source, "telemetry_v12");
        assert.equal(refs[0].key, fixture.objectKey);
        assert.equal(refs[0].version, null,
          "the GCS adapter must resolve exact generations from this exact stored key");
        if (shouldFail) {
          shouldFail = false;
          throw new Error("provider detail must not escape");
        }
      },
    };
    const options = {
      primaryPool,
      ledgerPool,
      objectStore,
      participantId: fixture.participantId,
      schema: { primarySchema, ledgerSchema },
    };
    const first = await eraseSyntheticPostgresV12Owner(options);
    assert.equal(first.status, "incomplete");
    assert.equal(first.code, "SYNTHETIC_OWNER_ERASURE_OBJECT_STORE_FAILED");
    let state = await primaryPool.query(
      `SELECT state FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [fixture.participantId],
    );
    assert.equal(state.rows[0]?.state, "deleting");
    const rotationAfterFailedDelete = await primaryPool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "device_credential_rotations")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(rotationAfterFailedDelete.rows[0]?.count, 1,
      "a failed object-delete attempt leaves the exact owner and its rotation receipt retryable");
    const stillReferenced = await primaryPool.query(
      `SELECT r2_key FROM ${qualified(primarySchema, "telemetry_v12_chunks")} WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(stillReferenced.rows[0]?.r2_key, fixture.objectKey);
    const tombstone = await ledgerPool.query(
      `SELECT participant_digest FROM ${qualified(ledgerSchema, "deletion_tombstones")}`,
    );
    assert.equal(tombstone.rows.length, 1);
    const failureReceipt = await ledgerPool.query(
      `SELECT outcome, details_json FROM ${qualified(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(failureReceipt.rows[0]?.outcome, "failed");
    assert.equal(failureReceipt.rows[0]?.details_json.includes(fixture.participantId), false);
    assert.equal(failureReceipt.rows[0]?.details_json.includes(fixture.objectKey), false);

    const retry = await eraseSyntheticPostgresV12Owner(options);
    assert.deepEqual(retry, { status: "complete", objectsDeleted: 1 });
    assert.equal(deletes.length, 2, "the same DB-derived exact object ref is retried idempotently");
    state = await primaryPool.query(
      `SELECT id FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [fixture.participantId],
    );
    assert.equal(state.rows.length, 0);
    const rotationAfterComplete = await primaryPool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "device_credential_rotations")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(rotationAfterComplete.rows[0]?.count, 0,
      "completed exact-owner erasure cascades its credential rotation receipt");
    const enrollment = await primaryPool.query(
      `SELECT participant_id FROM ${qualified(primarySchema, "attribution_enrollments")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(enrollment.rows.length, 0);
    const sourceDigestAfter = await primaryPool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "input_source_digests")}
        WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(sourceDigestAfter.rows[0]?.count, 0);
    for (const name of ["telemetry_v12_domain_predecessors", "telemetry_v12_domains",
      "telemetry_v12_domain_heads", "telemetry_v12_domain_days"]) {
      const remaining = await primaryPool.query(
        `SELECT count(*)::int AS count FROM ${qualified(primarySchema, name)} WHERE ${
          name === "telemetry_v12_domain_days" ? "generation_id=$1" :
            name === "telemetry_v12_domains" ? "id=$1" : "participant_id=$1"}`,
        [name === "telemetry_v12_domain_days" || name === "telemetry_v12_domains"
          ? generationId : fixture.participantId],
      );
      assert.equal(remaining.rows[0]?.count, 0, `${name} must cascade with the owner`);
    }
    const ownerProof = await primaryPool.query(
      `SELECT owner_digest FROM ${qualified(primarySchema, "storage_owner_erasure_receipts")}
        WHERE owner_digest=$1`,
      [fixture.ownerDigest],
    );
    assert.equal(ownerProof.rows.length, 1);
    const completed = await ledgerPool.query(
      `SELECT outcome, details_json FROM ${qualified(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(completed.rows[0]?.outcome, "completed");
    assert.equal(completed.rows[0]?.details_json.includes(fixture.participantId), false);
    assert.equal(completed.rows[0]?.details_json.includes(fixture.objectKey), false);
    const repeated = await eraseSyntheticPostgresV12Owner(options);
    assert.deepEqual(repeated, { status: "already_complete", objectsDeleted: 1 });
    assert.equal(deletes.length, 2);

    const unexpectedFixture = await seedOwner(primaryPool, primarySchema);
    const nextPriorSecretHash = randomBytes(32);
    const nextReplacementSecretHash = randomBytes(32);
    const rotationNow = new Date();
    const rotationRetireAt = new Date(rotationNow.getTime() + 86_400_000);
    await primaryPool.query(
      `UPDATE ${qualified(primarySchema, "device_credentials")}
          SET credential_generation=3, secret_hash=$2
        WHERE id=$1`,
      [unexpectedFixture.deviceId, nextReplacementSecretHash],
    );
    await primaryPool.query(
      `INSERT INTO ${qualified(primarySchema, "device_credential_rotations")} (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 3, $7, $8)`,
      [randomUUID(), unexpectedFixture.deviceId, unexpectedFixture.participantId,
        nextPriorSecretHash, nextReplacementSecretHash, randomUUID(), rotationNow, rotationRetireAt],
    );
    await assert.rejects(
      eraseSyntheticPostgresV12Owner({ ...options, participantId: unexpectedFixture.participantId }),
      (error) => error?.code === "SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED",
      "cleanup must refuse a synthetic owner with more than its exact expected rotation receipt",
    );
    const unexpectedState = await primaryPool.query(
      `SELECT state FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [unexpectedFixture.participantId],
    );
    assert.equal(unexpectedState.rows[0]?.state, "active",
      "family refusal occurs before the owner is fenced or mutated");
    assert.equal(deletes.length, 2, "family refusal must not reach object deletion");

    const archivedFixture = await seedOwner(primaryPool, primarySchema);
    await seedHistoricalHeader(primaryPool, primarySchema, archivedFixture);
    await assert.rejects(
      eraseSyntheticPostgresV12Owner({ ...options, participantId: archivedFixture.participantId }),
      (error) => error?.code === "SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED",
      "the v1.2-only eraser refuses owners with historical v1 archive references",
    );
    const archivedOwnerState = await primaryPool.query(
      `SELECT state FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [archivedFixture.participantId],
    );
    assert.equal(archivedOwnerState.rows[0]?.state, "active",
      "archived owner refusal happens before fencing or archive cascade");
    assert.equal(deletes.length, 2,
      "historical object keys are not silently omitted from object erasure");

    const partialFixture = await seedOwner(primaryPool, primarySchema, {
      withStagedManifest: true,
      withCredentialRotation: false,
    });
    const partialShape = await primaryPool.query(
      `SELECT
         (SELECT count(*)::int FROM ${qualified(primarySchema, "telemetry_v12_day_manifests")}
           WHERE participant_id=$1 AND state='staged' AND expected_chunk_count=1) AS staged_manifest_count,
         (SELECT count(*)::int FROM ${qualified(primarySchema, "telemetry_v12_chunks")}
           WHERE participant_id=$1) AS chunk_count,
         (SELECT count(*)::int FROM ${qualified(primarySchema, "pending_objects")}
           WHERE object_kind='telemetry_v12') AS pending_object_count`,
      [partialFixture.participantId],
    );
    assert.deepEqual(partialShape.rows[0], {
      staged_manifest_count: 1,
      chunk_count: 0,
      pending_object_count: 0,
    }, "the pre-chunk recovery fixture must have one staged manifest and no object refs");
    const emptyDeletes = [];
    const partialOptions = {
      ...options,
      participantId: partialFixture.participantId,
      objectStore: {
        async deleteBatch(refs) {
          emptyDeletes.push(refs);
          assert.deepEqual(refs, [], "partial manifest cleanup must never invent a storage key");
        },
      },
    };
    const partialCleanup = await eraseSyntheticPostgresV12Owner(partialOptions);
    assert.deepEqual(partialCleanup, { status: "complete", objectsDeleted: 0 });
    assert.equal(emptyDeletes.length, 1,
      "empty exact-reference deletion is a valid idempotent store operation");
    const partialOwner = await primaryPool.query(
      `SELECT id FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [partialFixture.participantId],
    );
    assert.equal(partialOwner.rows.length, 0);
    const partialReplay = await eraseSyntheticPostgresV12Owner(partialOptions);
    assert.deepEqual(partialReplay, { status: "already_complete", objectsDeleted: 0 });
    assert.equal(emptyDeletes.length, 1, "an exact replay must not invoke storage deletion twice");

    const lateNoRotationFixture = await seedOwner(primaryPool, primarySchema, {
      withChunk: true,
      withCredentialRotation: false,
    });
    await assert.rejects(
      eraseSyntheticPostgresV12Owner({ ...options, participantId: lateNoRotationFixture.participantId }),
      (error) => error?.code === "SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED",
      "zero rotation receipts are accepted only for the staged pre-renewal, zero-chunk fixture",
    );
    const lateNoRotationState = await primaryPool.query(
      `SELECT state FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [lateNoRotationFixture.participantId],
    );
    assert.equal(lateNoRotationState.rows[0]?.state, "active",
      "the mismatched no-rotation family is refused before fencing or object deletion");
    assert.equal(deletes.length, 2);
  } finally {
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});

test("PG17 cleanup refuses an unattributable pending v1.2 object and leaves it untouched", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `owner_orphan_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  const temporary = await mkdtemp(join(ROOT, ".tmp-postgres-owner-orphan-"));
  const createdSchemas = [];
  try {
    const server = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    createdSchemas.push(ledgerSchema);
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);
    const { eraseSyntheticPostgresV12Owner } = await importOwnerErasure(temporary);
    const fixture = await seedOwner(primaryPool, primarySchema);
    const orphanId = `chunk:${randomUUID()}`;
    const orphanKey = `telemetry/v12/test/${randomUUID()}`;
    await primaryPool.query(
      `INSERT INTO ${qualified(primarySchema, "pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1, $2, 'telemetry_v12')`,
      [orphanId, orphanKey],
    );
    let deletes = 0;
    const result = await eraseSyntheticPostgresV12Owner({
      primaryPool,
      ledgerPool,
      participantId: fixture.participantId,
      schema: { primarySchema, ledgerSchema },
      objectStore: { async deleteBatch() { deletes += 1; } },
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, "SYNTHETIC_OWNER_ERASURE_PENDING_UNATTRIBUTED");
    assert.equal(deletes, 0);
    const stillPending = await primaryPool.query(
      `SELECT object_key FROM ${qualified(primarySchema, "pending_objects")} WHERE contribution_id=$1`,
      [orphanId],
    );
    assert.equal(stillPending.rows[0]?.object_key, orphanKey);
    const state = await primaryPool.query(
      `SELECT state FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [fixture.participantId],
    );
    assert.equal(state.rows[0]?.state, "deleting");
    const receipt = await ledgerPool.query(
      `SELECT outcome, details_json FROM ${qualified(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(receipt.rows[0]?.outcome, "failed");
    assert.equal(receipt.rows[0]?.details_json.includes(orphanKey), false);
    assert.equal(receipt.rows[0]?.details_json.includes(fixture.participantId), false);
  } finally {
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});

// The v1.2 owner bridge (primary 0055) journals an eligible v1.2 head on a
// journal-enabled target. Until the wave integrator promotes it, apply the
// staged file after the stock chain; once promoted, the stock chain carries it.
const V12_OWNER_BRIDGE = "0055_v12_owner_bridge.sql";

async function applyV12OwnerBridge(pool, schema) {
  let sql;
  try {
    sql = await readFile(resolve(WORKER_ROOT, "postgres/staged-migrations/primary", V12_OWNER_BRIDGE), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const promoted = (await readdir(resolve(WORKER_ROOT, "postgres/migrations/primary")))
    .some((name) => name.endsWith("_v12_owner_bridge.sql"));
  assert.notEqual(sql !== undefined, promoted, "the v1.2 owner bridge is either staged or promoted, never both or neither");
  if (sql === undefined) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

test("PG17 cleanup erases a bridged smoke owner whose v1.2 receipt reuses the seeded owner link", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `owner_bridged_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  const temporary = await mkdtemp(join(ROOT, ".tmp-postgres-owner-bridged-"));
  const createdSchemas = [];
  try {
    const server = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    createdSchemas.push(ledgerSchema);
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);
    await applyV12OwnerBridge(primaryPool, primarySchema);
    const { eraseSyntheticPostgresV12Owner } = await importOwnerErasure(temporary);
    // A journal-enabled test target: the smoke owner's head is bridged.
    await primaryPool.query(
      `INSERT INTO ${qualified(primarySchema, "storage_source_state")} (singleton, source_id, authority_epoch)
       VALUES (1, 'synthetic-cleanup-source', 0)`,
    );
    const fixture = await seedOwner(primaryPool, primarySchema, { withChunk: true });
    const generationId = await seedActivatedDomain(primaryPool, primarySchema, fixture.participantId);
    const bridged = await primaryPool.query(
      `SELECT event_digest, owner_digest, generation_id, head_revision
         FROM ${qualified(primarySchema, "storage_v12_event_sources")} WHERE participant_id=$1`,
      [fixture.participantId],
    );
    assert.equal(bridged.rows.length, 1, "the smoke owner's head is bridged once");
    assert.equal(bridged.rows[0].owner_digest, fixture.ownerDigest, "the bridge reuses the smoke's seeded owner link");
    assert.equal(bridged.rows[0].generation_id, generationId);
    assert.equal(Number(bridged.rows[0].head_revision), 1);
    const journalRows = async () => (await primaryPool.query(
      `SELECT kind, event_tuple_version, owner_digest, object_digest
         FROM ${qualified(primarySchema, "storage_ingestion_changes")} ORDER BY sequence`,
    )).rows;
    assert.deepEqual(await journalRows(), [{
      kind: "owner-active", event_tuple_version: 1, owner_digest: fixture.ownerDigest,
      object_digest: bridged.rows[0].event_digest,
    }]);

    let deletes = 0;
    const result = await eraseSyntheticPostgresV12Owner({
      primaryPool,
      ledgerPool,
      participantId: fixture.participantId,
      schema: { primarySchema, ledgerSchema },
      objectStore: { async deleteBatch() { deletes += 1; } },
    });
    assert.deepEqual(result, { status: "complete", objectsDeleted: 1 });
    assert.equal(deletes, 1);
    const remaining = await primaryPool.query(
      `SELECT
         (SELECT count(*)::int FROM ${qualified(primarySchema, "participants")} WHERE id=$1) AS participants,
         (SELECT count(*)::int FROM ${qualified(primarySchema, "storage_v12_event_sources")} WHERE participant_id=$1) AS receipts,
         (SELECT count(*)::int FROM ${qualified(primarySchema, "storage_owner_erasure_receipts")} WHERE owner_digest=$2) AS erasure_receipts`,
      [fixture.participantId, fixture.ownerDigest],
    );
    assert.deepEqual(remaining.rows[0], { participants: 0, receipts: 0, erasure_receipts: 1 },
      "the bridge receipt cascades with the owner under its erasure receipt");
    assert.equal((await journalRows()).length, 1, "the exact journal row is retained");
  } finally {
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});

test("PG17 recovery selector resolves only a staged, zero-chunk synthetic owner in its exact window", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `cleanup_recovery_${suffix}`;
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await pool.query(`CREATE SCHEMA "${primarySchema}"`);
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool });
    const fixture = await seedOwner(pool, primarySchema, {
      withStagedManifest: true,
      withCredentialRotation: false,
    });
    const row = await pool.query(
      `SELECT created_at FROM ${qualified(primarySchema, "participants")} WHERE id=$1`,
      [fixture.participantId],
    );
    assert.equal(row.rows.length, 1);
    const createdAt = new Date(row.rows[0].created_at).getTime();
    const resolved = await resolveSyntheticV12CleanupParticipantId({
      primaryPool: pool,
      primarySchema,
      createdAtFrom: new Date(createdAt - 1).toISOString(),
      createdAtTo: new Date(createdAt + 1).toISOString(),
    });
    assert.equal(resolved, fixture.participantId);
    const chunks = await pool.query(
      `SELECT count(*)::int AS count FROM ${qualified(primarySchema, "telemetry_v12_chunks")}
        WHERE participant_id=$1`,
      [resolved],
    );
    assert.equal(chunks.rows[0]?.count, 0);
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`); } catch {}
    await pool.end();
  }
});
