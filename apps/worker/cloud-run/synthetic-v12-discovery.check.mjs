import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const cliDirectory = await mkdtemp(join(ROOT, ".tmp-synthetic-v12-discovery-check-"));
const cliPath = join(cliDirectory, "synthetic-v12-discovery.mjs");
await build({
  entryPoints: [resolve(ROOT, "synthetic-v12-discovery.mjs")],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: cliPath,
  logLevel: "silent",
});
const {
  parseSyntheticV12DiscoveryConfig,
  readAttachedSyntheticDiscoveryServiceAccount,
  readSyntheticV12PrimarySnapshot,
  runSyntheticV12Discovery,
  SYNTHETIC_V12_DISCOVERY_JOB,
  SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT,
  SYNTHETIC_V12_DISCOVERY_TARGETS,
} = await import(pathToFileURL(cliPath).href);
test.after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

const TABLES = Object.freeze([
  "web_sessions",
  "device_pairings",
  "device_credentials",
  "device_upload_authorizations",
  "telemetry_v12_device_capabilities",
  "storage_v11_owner_links",
  "telemetry_v12_day_manifests",
  "telemetry_v12_chunks",
  "community_analytical_input_versions",
  "input_versions",
  "input_source_digests",
  "current_queue",
  "telemetry_transport_participant_floors",
  "telemetry_transport_device_floors",
]);

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: SYNTHETIC_V12_DISCOVERY_JOB,
    CLOUD_RUN_EXECUTION: "tibotattle-v12-synthetic-discovery-00001-abc",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: SYNTHETIC_V12_DISCOVERY_TARGETS.project,
    CLOUD_RUN_TEST_SERVICE: SYNTHETIC_V12_DISCOVERY_TARGETS.service,
    HOST_ORIGIN: SYNTHETIC_V12_DISCOVERY_TARGETS.origin,
    POSTGRES_IAM_USER: SYNTHETIC_V12_DISCOVERY_TARGETS.iamUser,
    PRIMARY_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_DISCOVERY_TARGETS.primary.instanceConnectionName,
    PRIMARY_DATABASE: SYNTHETIC_V12_DISCOVERY_TARGETS.primary.database,
    PRIMARY_SCHEMA: SYNTHETIC_V12_DISCOVERY_TARGETS.primary.schema,
    LEDGER_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_DISCOVERY_TARGETS.ledger.instanceConnectionName,
    LEDGER_DATABASE: SYNTHETIC_V12_DISCOVERY_TARGETS.ledger.database,
    LEDGER_SCHEMA: SYNTHETIC_V12_DISCOVERY_TARGETS.ledger.schema,
    GCS_BUCKET_NAME: SYNTHETIC_V12_DISCOVERY_TARGETS.bucket,
    ...overrides,
  };
}

function fakeManifest() {
  const migrations = (role) => [{
    role,
    version: 1,
    name: "0001_fixture.sql",
    bytes: 1,
    sql: "x",
    sha256: "a".repeat(64),
  }];
  return { roles: { primary: migrations("primary"), ledger: migrations("ledger") } };
}

function participantFixture() {
  const participantId = `synthetic-v12-smoke-${randomUUID()}`;
  const manifestId = randomUUID();
  const chunkUuid = randomUUID();
  const contributionId = `chunk:${chunkUuid}`;
  return {
    participant: {
      id: participantId,
      state: "active",
      owner_kind: "social",
      identity_link_key: null,
    },
    owner: { owner_digest: "b".repeat(64), state: "active" },
    manifest: { id: manifestId, expected_chunk_count: 1, state: "ready" },
    chunk: {
      id: contributionId,
      manifest_id: manifestId,
      participant_id: participantId,
      r2_key: `telemetry/v12-${randomUUID()}`,
    },
    pending: {
      contribution_id: contributionId,
      object_key: `telemetry/v12-${randomUUID()}`,
      object_kind: "telemetry_v12",
      reconciliation_state: "registered",
    },
  };
}

function fakePrimaryPool({
  fixtures = [participantFixture()],
  unattributableCount = 0,
  consumingCount = 0,
  familyCountOverrides = {},
  migrationRows = fakeManifest().roles.primary,
} = {}) {
  const statements = [];
  const pool = {
    statements,
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values });
          if (sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")) {
            return { rows: [], rowCount: null };
          }
          if (sql.startsWith("SET LOCAL ") || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [], rowCount: null };
          }
          if (sql.includes("current_setting('server_version_num')")) {
            return { rows: [{ server_version_num: 170000, observed_at: "2026-09-25 00:00:00+00" }], rowCount: 1 };
          }
          if (sql.includes("_tibotattle_migration_history")) {
            return {
              rows: migrationRows.map((item) => ({
                version: item.version,
                name: item.name,
                checksum_sha256: item.sha256,
              })),
              rowCount: migrationRows.length,
            };
          }
          if (sql.includes("information_schema.columns")) {
            return { rows: TABLES.map((table_name) => ({ table_name })), rowCount: TABLES.length };
          }
          if (sql.includes("left(id, length($1))")) {
            return { rows: fixtures.map(({ participant }) => participant), rowCount: fixtures.length };
          }
          if (sql.includes("UNION ALL")) {
            const fixture = fixtures.find(({ participant }) => participant.id === values[0]);
            assert.ok(fixture, "family query must use the candidate synthetic participant id");
            return {
              rows: TABLES.map((table_name) => ({
                table_name,
                row_count: Object.hasOwn(familyCountOverrides, table_name)
                  ? String(familyCountOverrides[table_name])
                  : table_name === "device_upload_authorizations" ? "2"
                  : ["web_sessions", "device_pairings", "device_credentials",
                    "telemetry_v12_device_capabilities", "storage_v11_owner_links",
                    "telemetry_v12_day_manifests", "telemetry_v12_chunks",
                    "community_analytical_input_versions", "input_source_digests"].includes(table_name) ? "1" : "0",
              })),
              rowCount: TABLES.length,
            };
          }
          if (sql.includes('"storage_v11_owner_links"') && sql.startsWith("SELECT owner_digest")) {
            const fixture = fixtures.find(({ participant }) => participant.id === values[0]);
            return { rows: fixture ? [fixture.owner] : [], rowCount: fixture ? 1 : 0 };
          }
          if (sql.includes("state = 'consuming'")) {
            return { rows: [{ row_count: String(consumingCount) }], rowCount: 1 };
          }
          if (sql.includes('"telemetry_v12_day_manifests"')) {
            const fixture = fixtures.find(({ participant }) => participant.id === values[0]);
            return { rows: fixture?.manifest ? [fixture.manifest] : [], rowCount: fixture?.manifest ? 1 : 0 };
          }
          if (sql.includes("SELECT id, manifest_id, participant_id, r2_key")) {
            const fixture = fixtures.find(({ participant }) => participant.id === values[0]);
            return { rows: fixture?.chunk ? [fixture.chunk] : [], rowCount: fixture?.chunk ? 1 : 0 };
          }
          if (sql.includes('"pending_objects" pending')) {
            return { rows: [{ row_count: String(unattributableCount) }], rowCount: 1 };
          }
          if (sql.includes("SELECT contribution_id, object_key, object_kind")) {
            const fixture = fixtures.find(({ chunk }) => chunk?.id === values[0]);
            return { rows: fixture?.pending ? [fixture.pending] : [], rowCount: fixture?.pending ? 1 : 0 };
          }
          throw new Error("unexpected synthetic discovery query");
        },
        release() {},
      };
    },
  };
  return pool;
}

test("discovery config pins the single IAM-private Job and exact test Cloud SQL/GCS targets", () => {
  const parsed = parseSyntheticV12DiscoveryConfig(validEnv());
  assert.equal(parsed.job, SYNTHETIC_V12_DISCOVERY_JOB);
  assert.equal(parsed.primary.instanceConnectionName, SYNTHETIC_V12_DISCOVERY_TARGETS.primary.instanceConnectionName);
  assert.equal(parsed.ledger.instanceConnectionName, SYNTHETIC_V12_DISCOVERY_TARGETS.ledger.instanceConnectionName);
  assert.equal(parsed.bucket, SYNTHETIC_V12_DISCOVERY_TARGETS.bucket);
  for (const overrides of [
    { CLOUD_RUN_TASK_INDEX: "1" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { CLOUD_RUN_JOB: "another-job" },
    { GOOGLE_CLOUD_PROJECT: "another-project" },
    { CLOUD_RUN_TEST_SERVICE: "another-service" },
    { HOST_ORIGIN: "https://service.invalid" },
    { POSTGRES_IAM_USER: "another@tibotattle.iam" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "another:region:instance" },
    { PRIMARY_DATABASE: "another" },
    { PRIMARY_SCHEMA: "another" },
    { LEDGER_INSTANCE_CONNECTION_NAME: "another:region:instance" },
    { LEDGER_DATABASE: "another" },
    { LEDGER_SCHEMA: "another" },
    { GCS_BUCKET_NAME: "another-test-bucket" },
    { K_SERVICE: "accidental-service-context" },
  ]) {
    assert.throws(() => parseSyntheticV12DiscoveryConfig(validEnv(overrides)));
  }
});

test("Cloud Run metadata identity is verified and never added to diagnostic output", async () => {
  const response = (email, status = 200, flavor = "Google") => ({
    status,
    headers: { get(name) { return name === "Metadata-Flavor" ? flavor : null; } },
    async text() { return email; },
  });
  assert.equal(await readAttachedSyntheticDiscoveryServiceAccount({
    fetchImpl: async (url, options) => {
      assert.match(url, /^http:\/\/metadata\.google\.internal\//u);
      assert.equal(options.headers["Metadata-Flavor"], "Google");
      return response(SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT);
    },
  }), SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT);
  await assert.rejects(readAttachedSyntheticDiscoveryServiceAccount({
    fetchImpl: async () => response("different@tibotattle.iam.gserviceaccount.com"),
  }));
});

test("primary discovery uses read-only SQL and returns only exact synthetic ids and aggregate references", async () => {
  const first = participantFixture();
  const second = participantFixture();
  first.pending.object_key = first.chunk.r2_key;
  second.pending.object_key = second.chunk.r2_key;
  second.chunk = null;
  second.manifest = { id: second.manifest.id, expected_chunk_count: 0, state: "ready" };
  second.pending = null;
  const pool = fakePrimaryPool({ fixtures: [first, second] });
  const migrations = fakeManifest().roles.primary;
  const snapshot = await readSyntheticV12PrimarySnapshot(pool, "tibotattle", migrations);
  assert.deepEqual(snapshot, {
    observedAt: "2026-09-25T00:00:00.000Z",
    owners: [
      { participantId: first.participant.id, referencedGcsObjectCount: 1, registeredPendingReferenceCount: 1 },
      { participantId: second.participant.id, referencedGcsObjectCount: 0, registeredPendingReferenceCount: 0 },
    ],
    referencedGcsObjectCount: 1,
    registeredPendingReferenceCount: 1,
    unattributablePendingReferenceCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /telemetry\/v12-/u);
  assert.equal(pool.statements[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(pool.statements.at(-1).sql, "COMMIT");
  assert.equal(pool.statements.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/iu.test(sql)), false);
});

test("family refusal reports only a catalog table and bounded aggregate count", async () => {
  const fixture = participantFixture();
  fixture.pending.object_key = fixture.chunk.r2_key;
  await assert.rejects(readSyntheticV12PrimarySnapshot(fakePrimaryPool({
    fixtures: [fixture],
    familyCountOverrides: { device_credentials: 2 },
  }), "tibotattle", fakeManifest().roles.primary), (error) => {
    assert.equal(error?.code, "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
    assert.deepEqual(error?.safeFamily, {
      table: "device_credentials", actual: 2, expectedMinimum: 1, expectedMaximum: 1,
    });
    assert.doesNotMatch(JSON.stringify(error.safeFamily), /synthetic-v12-smoke-|telemetry\/v12-/u);
    return true;
  });
});

test("tagged malformed ids, shared object keys, pending mismatches and unattributable refs fail closed", async (t) => {
  const good = participantFixture();
  good.pending.object_key = good.chunk.r2_key;
  const shared = participantFixture();
  shared.chunk.r2_key = good.chunk.r2_key;
  shared.pending.object_key = good.chunk.r2_key;
  const cases = [
    ["malformed prefix tag", () => fakePrimaryPool({
      fixtures: [{ ...good, participant: { ...good.participant, id: "synthetic-v12-smoke-not-a-uuid" } }],
    }), "SYNTHETIC_DISCOVERY_PARTICIPANT_TAG_INVALID"],
    ["same storage reference appears under two synthetic owners", () => fakePrimaryPool({ fixtures: [good, shared] }),
      "SYNTHETIC_DISCOVERY_V12_REFERENCE_SHARED"],
    ["unattributable pending row", () => fakePrimaryPool({ fixtures: [good], unattributableCount: 1 }),
      "SYNTHETIC_DISCOVERY_PENDING_REFERENCE_UNATTRIBUTABLE"],
    ["registered reference does not match its chunk key", () => fakePrimaryPool({
      fixtures: [{ ...good, pending: { ...good.pending, object_key: `telemetry/v12-${randomUUID()}` } }],
    }), "SYNTHETIC_DISCOVERY_PENDING_REFERENCE_INVALID"],
    ["active upload lease", () => fakePrimaryPool({ fixtures: [good], consumingCount: 1 }),
      "SYNTHETIC_DISCOVERY_UPLOAD_IN_PROGRESS"],
    ["stale migration receipt", () => fakePrimaryPool({
      fixtures: [good], migrationRows: [{ ...fakeManifest().roles.primary[0], sha256: "c".repeat(64) }],
    }), "POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_RECEIPT_MISMATCH"],
  ];
  for (const [name, makePool, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        readSyntheticV12PrimarySnapshot(makePool(), "tibotattle", fakeManifest().roles.primary),
        (error) => error?.code === code,
      );
    });
  }
});

test("job execution uses only pinned IAM database pools and keeps database snapshots distinct", async () => {
  const manifest = fakeManifest();
  const poolCalls = [];
  let closed = false;
  const owners = [participantFixture()];
  const primaryPool = {};
  const ledgerPool = {};
  const result = await runSyntheticV12Discovery({
    env: validEnv(),
    dependencies: {
      async readServiceAccountEmail() { return SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT; },
      buildManifest: async () => manifest,
      createConnector: async () => ({ connector: true }),
      async createPool(options) {
        poolCalls.push(options);
        return poolCalls.length === 1 ? primaryPool : ledgerPool;
      },
      async readPrimarySnapshot(pool) {
        assert.equal(pool, primaryPool);
        return {
          observedAt: "2026-09-25T00:00:00.000Z",
          owners: owners.map(({ participant }) => ({
            participantId: participant.id,
            referencedGcsObjectCount: 1,
            registeredPendingReferenceCount: 1,
          })),
          referencedGcsObjectCount: 1,
          registeredPendingReferenceCount: 1,
          unattributablePendingReferenceCount: 0,
        };
      },
      async readLedgerSnapshot(pool) {
        assert.equal(pool, ledgerPool);
        return { observedAt: "2026-09-25T00:00:01.000Z", migrationReceiptMatched: true };
      },
      async closeResources({ pools }) {
        assert.deepEqual(pools, [primaryPool, ledgerPool]);
        closed = true;
      },
    },
  });
  assert.equal(poolCalls.length, 2);
  assert.deepEqual(poolCalls.map(({ max, applicationName }) => ({ max, applicationName })), [
    { max: 1, applicationName: "tibotattle-synthetic-v12-discovery" },
    { max: 1, applicationName: "tibotattle-synthetic-v12-discovery" },
  ]);
  assert.equal(closed, true);
  assert.notEqual(result.primarySnapshotObservedAt, result.ledgerMigrationSnapshotObservedAt);
  assert.equal(result.owners[0].participantId, owners[0].participant.id);
  assert.equal(result.referencedGcsObjectCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /telemetry\/v12-/u);
});
