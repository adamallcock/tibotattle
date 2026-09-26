import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../scripts/postgres-migrations.mjs";
import {
  abandonRun,
  advanceRun,
  applyIdentityHighWater,
  assertFlipReady,
  assertInstantRoundTrip,
  assertNoTransferUserOwnership,
  assertStageComplete,
  assertTriggerPolicyCoverage,
  beginRun,
  CONTROL_SCHEMA_RELATIONS,
  createRowsDigest,
  degradeCollectionControlsForImport,
  dropTransferStagingRelations,
  EMPTY_PREFIX_CHAIN,
  markLive,
  openProductionTransferTarget,
  PostgresTransferTargetError,
  readCheckpoint,
  recordCheckpoint,
  recordSealedCollectionControls,
  registerProductionTransferTarget,
  restoreSealedCollectionControls,
  scrubCheckpointCursors,
  SEEDED_SINGLETONS,
  sealedCollectionControlsSha256,
  stageReceipt,
  tableReceipt,
  TRANSFER_STAGES,
  withTransferTransaction,
  withTriggerPolicy,
} from "../scripts/postgres-transfer-target.mjs";

// PG17 acceptance for the production transfer target (PT-1). The control
// schema is database-scoped and its contract is a singleton, so the spec
// creates dedicated primary and ledger databases and dedicated roles (schema
// owner, transfer login, a second member, a stranger and a runtime role),
// and drops all of them at the end. All data is synthetic and content-free.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(WORKER_ROOT, "scripts/postgres-transfer-target.mjs");
const STAGED = Object.freeze({
  primary: join(WORKER_ROOT, "postgres/staged-migrations/primary/0056_production_transfer_control.sql"),
  ledger: join(WORKER_ROOT, "postgres/staged-migrations/ledger/0007_production_transfer_control.sql"),
});
const PRIMARY_SCHEMA = "synthetic_primary";
const LEDGER_SCHEMA = "synthetic_ledger";
const SEAL_A = createHash("sha256").update("synthetic-seal-a").digest("hex");
const SEAL_B = createHash("sha256").update("synthetic-seal-b").digest("hex");
const FLIP = createHash("sha256").update("synthetic-flip-evidence").digest("hex");
const GUARD = "telemetry_v12_domain_day_immutable_guard";

async function connection() {
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
    const metadata = await stat(resolved);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host: resolved, port: PG_TEST_PORT };
  }
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST), "PG_TEST_HOST must be loopback");
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

function isCode(code) {
  return error => error instanceof PostgresTransferTargetError && error.code === code;
}

function isSqlState(sqlState, message = undefined) {
  return error => error?.code === sqlState && (message === undefined || error.message === message);
}

async function applyRole(pool, role, schema) {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyPostgresMigrations({ role, schema, pool });
  await applyStaged(pool, role, schema);
}

// Until the staged-migration harness lands, stage the SQL after the stock
// migrations in one transaction with the migration runner's search path.
async function applyStaged(pool, role, schema) {
  const sql = await readFile(STAGED[role], "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function stubPool(pool, rewrite) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          return rewrite(String(text), await client.query(text, values));
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
}

async function seedV12Domain(pool) {
  const s = `"${PRIMARY_SCHEMA}"`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const participantId = "synthetic-pt1-owner";
  const deviceId = "synthetic-pt1-device";
  const secretHash = randomBytes(32);
  await pool.query(`INSERT INTO ${s}.participants(id, consent_version, created_at) VALUES ($1,$2,$3)`,
    [participantId, "privacy-safe-telemetry-v0.1", now]);
  await pool.query(`INSERT INTO ${s}.web_sessions(id, participant_id, secret_hash, csrf_hash, issued_at,
      expires_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
  [`${participantId}-session`, participantId, secretHash, secretHash, now, expires]);
  await pool.query(`INSERT INTO ${s}.device_pairings(id, participant_id, issued_by_session_id, secret_hash,
      consent_version, transport_consent_version, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [`${participantId}-pairing`, participantId, `${participantId}-session`, secretHash, "synthetic-consent",
    "synthetic-transport", now, expires]);
  await pool.query(`INSERT INTO ${s}.device_credentials(id, participant_id, paired_via_pairing_id, secret_hash,
      issued_at, expires_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
  [deviceId, participantId, `${participantId}-pairing`, secretHash, now, expires]);
  const manifests = {};
  for (const [index, day] of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].entries()) {
    const id = randomUUID();
    const digest = String(index + 1).repeat(64);
    await pool.query(`INSERT INTO ${s}.telemetry_v12_day_manifests(id, participant_id, device_id, chunk_day,
        manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at, ready_at)
      VALUES ($1,$2,$3,$4::date,$5,'synthetic-domain',$6,0,'ready',$7,$7)`, [id, participantId, deviceId, day,
      digest, JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day, chunks: [] }), now]);
    manifests[day] = { id, digest };
  }
  const token = "a".repeat(64);
  await pool.query(`INSERT INTO ${s}.telemetry_v12_domain_predecessors(token_hash, participant_id, device_id,
      previous_generation_id, legacy_fingerprint, input_revision, from_day, through_day, winners_json, days_json,
      created_at, expires_at) VALUES ($1,$2,$3,NULL,$4,0,'2026-09-21','2026-09-24',NULL,'[]',$5,$6)`,
  [token, participantId, deviceId, "b".repeat(64), now, expires]);
  const generationId = randomUUID();
  await pool.query(`INSERT INTO ${s}.telemetry_v12_domains(id, participant_id, device_id, predecessor_token_hash,
      previous_generation_id, manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
      days_json, created_at) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,'2026-09-21','2026-09-24','[]',$7)`,
  [generationId, participantId, deviceId, token, "c".repeat(64), "b".repeat(64), now]);
  // With an active head the guard refuses any new day for this generation.
  await pool.query(`INSERT INTO ${s}.telemetry_v12_domain_heads(participant_id, generation_id, revision, updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, generationId, now]);
  return { generationId, manifests };
}

function insertDay(client, fixture, day, manifestId = fixture.manifests[day].id) {
  return client.query(`INSERT INTO "${PRIMARY_SCHEMA}".telemetry_v12_domain_days(generation_id, observed_day,
      manifest_id, manifest_digest) VALUES ($1,$2::date,$3,$4)`,
  [fixture.generationId, day, manifestId, fixture.manifests[day].digest]);
}

async function guardEnabled(client) {
  const result = await client.query(`SELECT tgenabled::text AS enabled FROM pg_trigger
    WHERE tgname = $1 AND tgrelid = $2::regclass`, [GUARD, `"${PRIMARY_SCHEMA}".telemetry_v12_domain_days`]);
  return result.rows[0]?.enabled;
}

async function doctoredTriggerPolicyModule(directory) {
  // A copy of the module without the SET CONSTRAINTS ... IMMEDIATE step.
  let source = await readFile(MODULE_PATH, "utf8");
  const step = "await q(client, `SET CONSTRAINTS ${list} IMMEDIATE`, undefined, \"CUTOVER_TRIGGER_POLICY_CONSTRAINT_VIOLATION\");";
  assert.equal(source.split(step).length, 2, "the IMMEDIATE step moved; update the doctored copy");
  source = source.replace(step, "void list;");
  source = source.replace("from \"./postgres-migrations.mjs\"",
    `from ${JSON.stringify(pathToFileURL(join(WORKER_ROOT, "scripts/postgres-migrations.mjs")).href)}`);
  const path = join(directory, "doctored-postgres-transfer-target.mjs");
  await writeFile(path, source, { mode: 0o600 });
  return import(pathToFileURL(path).href);
}

test("PG17 production transfer target: contract, open, roles, trigger policy, controls, hygiene and live lock", {
  skip: !PG_TEST_SOCKET && !PG_TEST_HOST,
}, async (t) => {
  const socket = await connection();
  const base = { ...socket, password: PG_TEST_PASSWORD, ssl: false, connectionTimeoutMillis: 5_000 };
  const admin = new pg.Client({ ...base, user: PG_TEST_USER, database: PG_TEST_DATABASE });
  await admin.connect();
  const suffix = randomBytes(5).toString("hex");
  const roles = {
    owner: `pt1_owner_${suffix}`,
    transfer: `pt1_transfer_${suffix}`,
    other: `pt1_other_${suffix}`,
    stranger: `pt1_stranger_${suffix}`,
    runtime: `pt1_runtime_${suffix}`,
  };
  const databases = { primary: `pt1_primary_${suffix}`, ledger: `pt1_ledger_${suffix}`, clone: `pt1_clone_${suffix}` };
  const createdRoles = [];
  const createdDatabases = [];
  const pools = [];
  let temporaryDirectory;
  const pool = (user, database) => {
    const created = new pg.Pool({ ...base, user, database, max: 3 });
    created.on("error", () => {});
    pools.push(created);
    return created;
  };
  try {
    const facts = await admin.query(`SELECT current_setting('server_version_num') AS version,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`);
    assert.match(facts.rows[0].version, /^17\d{4}$/u, "the spec requires PostgreSQL 17");
    assert.equal(facts.rows[0].superuser, true, "the spec creates databases and roles; PG_TEST_USER must be superuser");
    for (const [key, role] of Object.entries(roles)) {
      await admin.query(`CREATE ROLE "${role}" ${key === "runtime" ? "NOLOGIN" : "LOGIN"}`);
      createdRoles.push(role);
    }
    await admin.query(`GRANT "${roles.owner}" TO "${roles.transfer}"`);
    await admin.query(`GRANT "${roles.owner}" TO "${roles.other}"`);
    for (const key of ["primary", "ledger"]) {
      await admin.query(`CREATE DATABASE "${databases[key]}" OWNER "${roles.owner}"`);
      createdDatabases.push(databases[key]);
    }
    let ownerPrimary = pool(roles.owner, databases.primary);
    const ownerLedger = pool(roles.owner, databases.ledger);
    await applyRole(ownerPrimary, "primary", PRIMARY_SCHEMA);
    await applyRole(ownerLedger, "ledger", LEDGER_SCHEMA);
    for (const [ownerPool, schema] of [[ownerPrimary, PRIMARY_SCHEMA], [ownerLedger, LEDGER_SCHEMA]]) {
      // The runtime role's grants, as the Cloud Run host issues them, cover
      // only the application schema.
      await ownerPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles.runtime}"`);
      await ownerPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}"
        TO "${roles.runtime}"`);
      await ownerPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}"
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${roles.runtime}"`);
    }

    const contract = {
      contractId: "synthetic-production-transfer-v1",
      mode: "production",
      projectId: "tibotattle-synthetic",
      projectNumber: "123456789012",
      instanceConnectionName: "tibotattle-synthetic:us-east1:synthetic-primary",
      databaseName: databases.primary,
      schemaName: PRIMARY_SCHEMA,
      ledgerInstanceConnectionName: "tibotattle-synthetic:us-east1:synthetic-ledger",
      ledgerDatabaseName: databases.ledger,
      ledgerSchemaName: LEDGER_SCHEMA,
      iamDatabaseUser: roles.transfer,
      schemaOwnerRole: roles.owner,
      gcsBucket: "tibotattle-synthetic-quarantine",
      gcsBucketGeneration: "1790000000000001",
    };
    const openArgs = { expectedContractId: contract.contractId };

    await t.test("control migrations install once per database and leave seeded singletons explicit", async () => {
      const installed = await ownerPrimary.query(`SELECT component FROM tibotattle_transfer.transfer_control_installations`);
      assert.deepEqual(installed.rows.map(row => row.component), ["primary"]);
      const before = await ownerPrimary.query(`SELECT relname FROM pg_class
        WHERE relnamespace = 'tibotattle_transfer'::regnamespace AND relkind = 'r' ORDER BY 1`);
      await ownerPrimary.query(`CREATE SCHEMA "pt1_second_application"`);
      await applyPostgresMigrations({ role: "primary", schema: "pt1_second_application", pool: ownerPrimary });
      await applyStaged(ownerPrimary, "primary", "pt1_second_application");
      const after = await ownerPrimary.query(`SELECT relname FROM pg_class
        WHERE relnamespace = 'tibotattle_transfer'::regnamespace AND relkind = 'r' ORDER BY 1`);
      assert.deepEqual(after.rows, before.rows);
      await ownerPrimary.query(`DROP SCHEMA "pt1_second_application" CASCADE`);
      assert.deepEqual(before.rows.map(row => row.relname).sort(),
        CONTROL_SCHEMA_RELATIONS.filter(name => name !== "ledger_transfer_runs").sort());
      const ledgerRelations = await ownerLedger.query(`SELECT relname FROM pg_class
        WHERE relnamespace = 'tibotattle_transfer'::regnamespace AND relkind = 'r' ORDER BY 1`);
      assert.deepEqual(ledgerRelations.rows.map(row => row.relname).sort(),
        ["ledger_transfer_runs", "transfer_control_installations"]);
      for (const [role, ownerPool, schema] of [["primary", ownerPrimary, PRIMARY_SCHEMA],
        ["ledger", ownerLedger, LEDGER_SCHEMA]]) {
        const tables = await ownerPool.query(`SELECT relname FROM pg_class
          WHERE relnamespace = $1::regnamespace AND relkind IN ('r', 'p') AND relname <> '_tibotattle_migration_history'
          ORDER BY 1`, [schema]);
        const seeded = new Map();
        for (const { relname } of tables.rows) {
          const count = await ownerPool.query(`SELECT count(*)::int AS n FROM "${schema}"."${relname}"`);
          if (count.rows[0].n > 0) seeded.set(relname, count.rows[0].n);
        }
        const expected = new Map(SEEDED_SINGLETONS.filter(entry => entry.role === role
          && tables.rows.some(row => row.relname === entry.table)).map(entry => [entry.table, entry.seedRows]));
        assert.deepEqual([...seeded.entries()].sort(), [...expected.entries()].sort(),
          `${role} seeded tables drifted from SEEDED_SINGLETONS`);
      }
    });

    await t.test("contract registration is idempotent and the contract is immutable", async () => {
      const first = await registerProductionTransferTarget({ primaryPool: ownerPrimary, ledgerPool: ownerLedger, contract });
      assert.deepEqual(first, { contractId: contract.contractId, registered: true });
      const again = await registerProductionTransferTarget({ primaryPool: ownerPrimary, ledgerPool: ownerLedger, contract });
      assert.deepEqual(again, { contractId: contract.contractId, registered: false });
      await assert.rejects(registerProductionTransferTarget({ primaryPool: ownerPrimary, ledgerPool: ownerLedger,
        contract: { ...contract, gcsBucketGeneration: "1790000000000002" } }), isCode("CUTOVER_TARGET_CONTRACT_CONFLICT"));
      await assert.rejects(registerProductionTransferTarget({ primaryPool: ownerPrimary, ledgerPool: ownerLedger,
        contract: { ...contract, databaseName: databases.ledger } }), isCode("CUTOVER_TARGET_DATABASE_MISMATCH"));
      const adminPrimaryClient = new pg.Client({ ...base, user: PG_TEST_USER, database: databases.primary });
      await adminPrimaryClient.connect();
      try {
        for (const client of [ownerPrimary, adminPrimaryClient]) {
          for (const statement of [
            "UPDATE tibotattle_transfer.transfer_target_contract SET gcs_bucket_generation = '1790000000000009'",
            "DELETE FROM tibotattle_transfer.transfer_target_contract",
            // A plain TRUNCATE is refused by the runs foreign key before any
            // trigger runs; CASCADE reaches the statement guard.
            "TRUNCATE tibotattle_transfer.transfer_target_contract CASCADE",
          ]) {
            await assert.rejects(client.query(statement), isSqlState("P1005", "TRANSFER_CONTROL_ROW_IMMUTABLE"));
          }
          await assert.rejects(client.query("TRUNCATE tibotattle_transfer.transfer_target_contract"), isSqlState("0A000"));
        }
      } finally {
        await adminPrimaryClient.end();
      }
      const stored = await ownerPrimary.query(`SELECT gcs_bucket_generation FROM tibotattle_transfer.transfer_target_contract`);
      assert.deepEqual(stored.rows, [{ gcs_bucket_generation: contract.gcsBucketGeneration }]);
    });

    // A byte-for-byte clone of the primary database is a different database
    // that still carries the contract naming the original.
    for (const open of pools.filter(entry => entry === ownerPrimary)) await open.end();
    pools.splice(pools.indexOf(ownerPrimary), 1);
    await admin.query(`CREATE DATABASE "${databases.clone}" TEMPLATE "${databases.primary}" OWNER "${roles.owner}"`);
    createdDatabases.push(databases.clone);
    ownerPrimary = pool(roles.owner, databases.primary);
    const transferPrimary = pool(roles.transfer, databases.primary);
    const transferLedger = pool(roles.transfer, databases.ledger);
    const adminPrimary = pool(PG_TEST_USER, databases.primary);
    const adminLedger = pool(PG_TEST_USER, databases.ledger);
    const target = { primaryPool: transferPrimary, ledgerPool: transferLedger };

    await t.test("openProductionTransferTarget refuses every contract, session and target mismatch", async () => {
      const pg16 = stubPool(transferPrimary, (text, result) => (text.includes("server_version_num")
        ? { ...result, rows: result.rows.map(row => ({ ...row, server_version_num: "160004" })) } : result));
      await assert.rejects(openProductionTransferTarget({ ...target, primaryPool: pg16, ...openArgs, sealManifestSha256: SEAL_A }),
        isCode("CUTOVER_TARGET_POSTGRES_VERSION_UNSUPPORTED"));
      const pg16Ledger = stubPool(transferLedger, (text, result) => (text.includes("server_version_num")
        ? { ...result, rows: result.rows.map(row => ({ ...row, server_version_num: "160004" })) } : result));
      await assert.rejects(openProductionTransferTarget({ ...target, ledgerPool: pg16Ledger, ...openArgs,
        sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_POSTGRES_VERSION_UNSUPPORTED"));
      await assert.rejects(openProductionTransferTarget({ ...target, primaryPool: pool(roles.stranger, databases.primary),
        ...openArgs, sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_ROLE_INVALID"));
      const notOwner = stubPool(transferPrimary, (text, result) => (text.includes("assumed_role")
        ? { ...result, rows: result.rows.map(row => ({ ...row, assumed_role: roles.other })) } : result));
      await assert.rejects(openProductionTransferTarget({ ...target, primaryPool: notOwner, ...openArgs,
        sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_ROLE_INVALID"));
      await assert.rejects(openProductionTransferTarget({ ...target, primaryPool: pool(roles.other, databases.primary),
        ...openArgs, sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_SESSION_USER_MISMATCH"));
      await assert.rejects(openProductionTransferTarget({ ...target, ledgerPool: pool(roles.other, databases.ledger),
        ...openArgs, sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_SESSION_USER_MISMATCH"));
      await assert.rejects(openProductionTransferTarget({ ...target, primaryPool: pool(roles.transfer, databases.clone),
        ...openArgs, sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_DATABASE_MISMATCH"));
      await assert.rejects(openProductionTransferTarget({ ...target, ledgerPool: transferPrimary, ...openArgs,
        sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_DATABASE_MISMATCH"));
      await assert.rejects(openProductionTransferTarget({ ...target, expectedContractId: "synthetic-other-contract",
        sealManifestSha256: SEAL_A }), isCode("CUTOVER_TARGET_CONTRACT_MISMATCH"));
      await adminPrimary.query(`ALTER SCHEMA "${PRIMARY_SCHEMA}" RENAME TO "${PRIMARY_SCHEMA}_moved"`);
      try {
        await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A }),
          isCode("CUTOVER_TARGET_SCHEMA_MISMATCH"));
      } finally {
        await adminPrimary.query(`ALTER SCHEMA "${PRIMARY_SCHEMA}_moved" RENAME TO "${PRIMARY_SCHEMA}"`);
      }

      temporaryDirectory = await mkdtemp(join(tmpdir(), "tibotattle-transfer-target-"));
      const primaryMigrations = await readPostgresMigrations({ role: "primary" });
      const ledgerMigrations = await readPostgresMigrations({ role: "ledger" });
      const root = async (name, primarySelection, extra = null) => {
        const directory = join(temporaryDirectory, name);
        await mkdir(join(directory, "primary"), { recursive: true });
        await mkdir(join(directory, "ledger"), { recursive: true });
        for (const migration of primarySelection) {
          await copyFile(join(WORKER_ROOT, "postgres/migrations/primary", migration.name), join(directory, "primary", migration.name));
        }
        for (const migration of ledgerMigrations) {
          await copyFile(join(WORKER_ROOT, "postgres/migrations/ledger", migration.name), join(directory, "ledger", migration.name));
        }
        if (extra !== null) await writeFile(join(directory, "primary", extra), "SELECT 1;\n", { mode: 0o600 });
        return directory;
      };
      const missingInSource = await root("receipt-extra", primaryMigrations.slice(0, -1));
      const missingInTarget = await root("receipt-missing", primaryMigrations,
        `${String(primaryMigrations.length + 1).padStart(4, "0")}_synthetic_unapplied.sql`);
      for (const rootDirectory of [missingInSource, missingInTarget]) {
        await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A, rootDirectory }),
          isCode("CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH"));
      }

      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".admin_action_audit(operation_id, action,
          actor_identity_digest, outcome, details_json, created_at)
        VALUES ('synthetic-operation', 'run_maintenance', $1, 'success', '{}', clock_timestamp())`, ["d".repeat(64)]);
      await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A }),
        error => isCode("CUTOVER_TARGET_NOT_EMPTY")(error) && error.relation === "admin_action_audit");
      await ownerPrimary.query(`DELETE FROM "${PRIMARY_SCHEMA}".admin_action_audit`);
      await ownerLedger.query(`INSERT INTO "${LEDGER_SCHEMA}".identity_reenrollment_cooldowns(identity_cooldown_digest,
          schema_version, deleted_at, retain_until) VALUES ($1, 'identity-reenrollment-cooldown-v0.1',
          '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`, ["e".repeat(64)]);
      await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A }),
        error => isCode("CUTOVER_TARGET_NOT_EMPTY")(error) && error.relation === "identity_reenrollment_cooldowns");
      await ownerLedger.query(`DELETE FROM "${LEDGER_SCHEMA}".identity_reenrollment_cooldowns`);

      // AN-1's public-source bootstrap is a seeded singleton where it exists.
      await ownerPrimary.query(`CREATE TABLE "${PRIMARY_SCHEMA}".community_public_source_bootstrap (
        singleton integer PRIMARY KEY, completed integer NOT NULL)`);
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".community_public_source_bootstrap VALUES (1, 0)`);
      const seededOpen = await openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A });
      assert.equal(seededOpen.resumed, false);
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".community_public_source_bootstrap VALUES (2, 0)`);
      await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A }),
        error => isCode("CUTOVER_TARGET_NOT_EMPTY")(error) && error.relation === "community_public_source_bootstrap");
      await ownerPrimary.query(`DROP TABLE "${PRIMARY_SCHEMA}".community_public_source_bootstrap`);
    });

    const handle = await openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A });
    let runId;

    await t.test("a fresh target begins one run, mirrored in the ledger, and resumes only the same seal", async () => {
      assert.equal(Object.isFrozen(handle), true);
      assert.equal(handle.resumed, false);
      assert.equal(handle.primarySchema, PRIMARY_SCHEMA);
      assert.equal(handle.schemaOwnerRole, roles.owner);
      await assert.rejects(advanceRun(handle, "importing"), isCode("CUTOVER_RUN_MISSING"));
      ({ runId } = await beginRun(handle, { sealedAt: "2026-09-25T12:00:00.000Z" }));
      await assert.rejects(beginRun(handle, { sealedAt: "2026-09-25T12:00:00.000Z" }), isCode("CUTOVER_RUN_EXISTS"));
      const mirror = await adminLedger.query(`SELECT run_id, state, seal_manifest_sha256
        FROM tibotattle_transfer.ledger_transfer_runs`);
      assert.deepEqual(mirror.rows, [{ run_id: runId, state: "preflight", seal_manifest_sha256: SEAL_A }]);
      const progressed = await advanceRun(handle, "importing");
      assert.deepEqual({ ...progressed }, { runId, state: "importing", ledgerState: "importing" });
      await assert.rejects(adminPrimary.query(`INSERT INTO tibotattle_transfer.transfer_runs
          (run_id, contract_id, seal_manifest_sha256, sealed_at, state)
        VALUES ($1, $2, $3, '2026-09-25T12:00:00.000Z', 'preflight')`, [randomUUID(), contract.contractId, SEAL_B]),
      isSqlState("23505"));
      await assert.rejects(adminPrimary.query(`UPDATE tibotattle_transfer.transfer_runs SET state = 'preflight'`),
        isSqlState("P1005", "TRANSFER_RUN_TRANSITION_REFUSED"));
      await assert.rejects(adminPrimary.query(`DELETE FROM tibotattle_transfer.transfer_runs`),
        isSqlState("P1005", "TRANSFER_RUN_IMMUTABLE"));

      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".admin_action_audit(operation_id, action,
          actor_identity_digest, outcome, details_json, created_at)
        VALUES ('synthetic-imported-operation', 'run_maintenance', $1, 'success', '{}',
          '2026-09-25T12:00:00.123Z')`, ["d".repeat(64)]);
      const resumed = await openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A });
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.openedRunState, "importing");
      await assert.rejects(beginRun(resumed, { sealedAt: "2026-09-25T12:00:00.000Z" }), isCode("CUTOVER_RUN_EXISTS"));
      await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_B }),
        isCode("CUTOVER_TARGET_SEAL_MISMATCH"));
    });

    await t.test("receipts never overwrite completed digests and bind the production transfer id", async () => {
      await withTransferTransaction(handle, "primary", async (client) => {
        const started = await stageReceipt(client, handle, { stage: "identity-authority", state: "started" });
        assert.equal(started.transferId, `production-identity-authority-${SEAL_A.slice(0, 16)}`);
        const complete = { stage: "identity-authority", state: "complete", rowCount: 3, byteCount: 120,
          receiptSha256: "a".repeat(64) };
        await stageReceipt(client, handle, complete);
        await stageReceipt(client, handle, complete);
        await assert.rejects(stageReceipt(client, handle, { ...complete, receiptSha256: "b".repeat(64) }),
          isCode("CUTOVER_RECEIPT_CONFLICT"));
        await assert.rejects(stageReceipt(client, handle, { ...complete, stage: "identity" }), isCode("CUTOVER_STAGE_UNKNOWN"));
        const table = { stage: "identity-authority", sourceRole: "ingestion", sourceTable: "participants",
          disposition: "imported:identity-authority", targetTable: "participants", state: "complete",
          sourceRowCount: 1, sourceSha256: "c".repeat(64), targetRowCount: 1, targetSha256: "c".repeat(64) };
        await tableReceipt(client, handle, table);
        await tableReceipt(client, handle, table);
        await assert.rejects(tableReceipt(client, handle, { ...table, targetSha256: "d".repeat(64) }),
          isCode("CUTOVER_RECEIPT_CONFLICT"));
        await assert.rejects(tableReceipt(client, handle, { ...table, disposition: "must-be-empty" }),
          isCode("CUTOVER_RECEIPT_CONFLICT"));
        await assert.rejects(tableReceipt(client, handle, { ...table, disposition: "blanket" }),
          isCode("CUTOVER_RECEIPT_INVALID"));
      });
      await assertStageComplete(handle, "identity-authority");
      await assert.rejects(assertStageComplete(handle, "objects"), isCode("CUTOVER_STAGE_INCOMPLETE"));
      await assert.rejects(ownerPrimary.query(`UPDATE tibotattle_transfer.transfer_stage_receipts SET receipt_sha256 = $1`,
        ["e".repeat(64)]), isSqlState("P1005", "TRANSFER_RECEIPT_IMMUTABLE"));
      await assert.rejects(ownerPrimary.query(`INSERT INTO tibotattle_transfer.transfer_stage_receipts
          (run_id, stage, transfer_id, state) VALUES ($1, 'objects', 'production-objects-0000000000000000', 'started')`,
      [runId]), isSqlState("P1005", "TRANSFER_RECEIPT_REFUSED"));
      await assert.rejects(ownerPrimary.query(`DELETE FROM tibotattle_transfer.transfer_table_receipts`),
        isSqlState("P1005", "TRANSFER_RECEIPT_IMMUTABLE"));
    });

    const sealedRow = {
      singleton: 1, schema_version: "collection-controls-v0.1", control_state: "operational",
      enrollment_enabled: 1, upload_registration_enabled: 1, processing_enabled: 1, publication_enabled: 1,
      revision: 7, reason_code: "drill_restore", updated_at: "2026-09-20T10:11:12.345Z",
    };
    const retentionTransferId = `production-accountless-retention-${SEAL_A.slice(0, 16)}`;

    await t.test("sealed controls are recorded and degraded by an ordinary UPDATE under the 0042/0043 guards", async () => {
      const guards = await ownerPrimary.query(`SELECT tgname, tgenabled::text AS enabled FROM pg_trigger
        WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`, [`"${PRIMARY_SCHEMA}".collection_controls`]);
      assert.deepEqual(guards.rows, [
        { tgname: "accountless_public_history_d1_fence_controls_guard", enabled: "O" },
        { tgname: "accountless_public_history_import_controls_guard", enabled: "O" },
      ]);
      const seed = await ownerPrimary.query(`SELECT control_state, revision::int AS revision
        FROM "${PRIMARY_SCHEMA}".collection_controls`);
      assert.deepEqual(seed.rows, [{ control_state: "contained", revision: 1 }]);
      await withTransferTransaction(handle, "primary", async (client) => {
        const recorded = await recordSealedCollectionControls(client, handle, sealedRow);
        assert.equal(recorded.sealedRowSha256, sealedCollectionControlsSha256({ ...sealedRow,
          enrollment_enabled: true, upload_registration_enabled: true, processing_enabled: true,
          publication_enabled: true }));
        await recordSealedCollectionControls(client, handle, sealedRow);
        await assert.rejects(recordSealedCollectionControls(client, handle, { ...sealedRow, revision: 8 }),
          isCode("CUTOVER_RECEIPT_CONFLICT"));
        await degradeCollectionControlsForImport(client, handle);
      });
      const degraded = await ownerPrimary.query(`SELECT control_state, enrollment_enabled, upload_registration_enabled,
        processing_enabled, publication_enabled, revision::int AS revision, reason_code FROM "${PRIMARY_SCHEMA}".collection_controls`);
      assert.deepEqual(degraded.rows, [{ control_state: "degraded", enrollment_enabled: false,
        upload_registration_enabled: true, processing_enabled: true, publication_enabled: false, revision: 7,
        reason_code: "drill_restore" }]);

      // A D1-sourced accountless retention import is admitted only under these
      // degraded controls; while it is open the guards refuse enabling.
      const [receipt43] = (await readPostgresMigrations({ role: "primary" })).filter(migration => migration.version === 43);
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".accountless_public_history_import_runs
          (transfer_id, schema_version, source_kind, target_schema, source_snapshot_id, source_fence_id,
           source_artifact_sha256, source_manifest_sha256, source_row_count, source_migration_receipts,
           target_migration_version, target_migration_sha256, page_size, status, source_run_id, source_revision,
           source_mapping_sha256, source_fence_state)
        VALUES ($1, 'accountless-public-history-retention-import-v1', 'cloudflare-d1-accountless-retention-snapshot-v1',
          $2, 'synthetic-snapshot', 'synthetic-fence', $3, $4, 0, '[]'::jsonb, 43, $5, 100, 'importing',
          'synthetic-source-run', 0, $6, 'pending')`,
      [retentionTransferId, PRIMARY_SCHEMA, "1".repeat(64), "2".repeat(64), receipt43.sha256, "3".repeat(64)]);
      await assert.rejects(ownerPrimary.query(`UPDATE "${PRIMARY_SCHEMA}".collection_controls SET enrollment_enabled = true`),
        isSqlState("P1005"));
      await withTransferTransaction(handle, "primary", client => degradeCollectionControlsForImport(client, handle));
      await withTransferTransaction(handle, "primary", async (client) => {
        await assert.rejects(restoreSealedCollectionControls(client, handle), isCode("CUTOVER_RUN_NOT_VERIFIED"));
      });
      await ownerPrimary.query(`UPDATE "${PRIMARY_SCHEMA}".accountless_public_history_import_runs
        SET status = 'complete', completed_at = clock_timestamp(), updated_at = clock_timestamp(),
            target_manifest_sha256 = $2 WHERE transfer_id = $1`, [retentionTransferId, "4".repeat(64)]);
    });

    const fixture = await seedV12Domain(ownerPrimary);
    const domainDays = { schema: PRIMARY_SCHEMA, table: "telemetry_v12_domain_days", suppress: [GUARD] };

    await t.test("withTriggerPolicy on telemetry_v12_domain_days commits without 55006 and keeps FK checks", async () => {
      await assert.rejects(insertDay(ownerPrimary, fixture, "2026-09-21"),
        isSqlState("P1005", "telemetry_domain_immutable"));
      // Without the IMMEDIATE step the deferred 0026 FK leaves a pending
      // AFTER-trigger event and re-enabling the 0014 guard fails.
      await assert.rejects(withTransferTransaction(handle, "primary", async (client) => {
        await client.query(`ALTER TABLE "${PRIMARY_SCHEMA}".telemetry_v12_domain_days DISABLE TRIGGER ${GUARD}`);
        await insertDay(client, fixture, "2026-09-21");
        await client.query(`ALTER TABLE "${PRIMARY_SCHEMA}".telemetry_v12_domain_days ENABLE TRIGGER ${GUARD}`);
      }), isSqlState("55006"));
      temporaryDirectory ??= await mkdtemp(join(tmpdir(), "tibotattle-transfer-target-"));
      const doctored = await doctoredTriggerPolicyModule(temporaryDirectory);
      const ownerClient = await ownerPrimary.connect();
      try {
        await ownerClient.query("BEGIN");
        await assert.rejects(doctored.withTriggerPolicy(ownerClient, domainDays,
          page => insertDay(page, fixture, "2026-09-21")),
        error => error.code === "CUTOVER_TRIGGER_POLICY_REENABLE_FAILED" && error.sqlState === "55006");
        assert.equal(await guardEnabled(ownerClient), "O");
        await ownerClient.query("ROLLBACK");
      } finally {
        ownerClient.release();
      }

      const committed = await withTransferTransaction(handle, "primary",
        client => withTriggerPolicy(client, domainDays, async (page) => {
          await insertDay(page, fixture, "2026-09-21");
          return "page-committed";
        }));
      assert.equal(committed, "page-committed");
      assert.equal(await guardEnabled(ownerPrimary), "O");
      const days = await ownerPrimary.query(`SELECT observed_day::text AS day FROM "${PRIMARY_SCHEMA}".telemetry_v12_domain_days`);
      assert.deepEqual(days.rows, [{ day: "2026-09-21" }]);
      await assert.rejects(insertDay(ownerPrimary, fixture, "2026-09-22"),
        isSqlState("P1005", "telemetry_domain_immutable"));

      await assert.rejects(withTransferTransaction(handle, "primary", async (client) => {
        await assert.rejects(withTriggerPolicy(client, domainDays, async (page) => {
          await insertDay(page, fixture, "2026-09-22");
          throw new Error("synthetic page failure");
        }), /synthetic page failure/u);
        assert.equal(await guardEnabled(client), "O");
        await assert.rejects(withTriggerPolicy(client, domainDays,
          page => insertDay(page, fixture, "2026-09-23", randomUUID())),
        error => isCode("CUTOVER_TRIGGER_POLICY_CONSTRAINT_VIOLATION")(error) && error.sqlState === "23503");
        assert.equal(await guardEnabled(client), "O");
        const kept = await client.query(`SELECT count(*)::int AS n FROM "${PRIMARY_SCHEMA}".telemetry_v12_domain_days`);
        assert.equal(kept.rows[0].n, 1);
        throw new Error("synthetic outer rollback");
      }), /synthetic outer rollback/u);
      assert.equal(await guardEnabled(ownerPrimary), "O");
      const outside = await ownerPrimary.connect();
      try {
        await assert.rejects(withTriggerPolicy(outside, domainDays, async () => {}),
          isCode("CUTOVER_TRIGGER_POLICY_TRANSACTION_REQUIRED"));
      } finally {
        outside.release();
      }
      await assert.rejects(withTransferTransaction(handle, "primary", client => withTriggerPolicy(client,
        { ...domainDays, suppress: ["RI_ConstraintTrigger_c_1"] }, async () => {})), isCode("CUTOVER_TRIGGER_POLICY_INVALID"));
    });

    await t.test("assertTriggerPolicyCoverage fails for an unclassified trigger and for a stale policy", async () => {
      const policy = { telemetry_v12_domain_days: { [GUARD]: { policy: "suppress", reason: "historical days already admitted" } } };
      await withTransferTransaction(handle, "primary", async (client) => {
        const report = await assertTriggerPolicyCoverage(client, PRIMARY_SCHEMA, policy);
        assert.deepEqual([...report.suppressedTablesWithDeferrables], ["telemetry_v12_domain_days"]);
        await assert.rejects(assertTriggerPolicyCoverage(client, PRIMARY_SCHEMA, {
          telemetry_v12_domain_days: { ...policy.telemetry_v12_domain_days,
            retired_guard: { policy: "fire", reason: "no longer present" } },
        }), error => isCode("CUTOVER_TRIGGER_POLICY_STALE")(error) && error.trigger === "retired_guard");
      }, { readOnly: true });
      await assert.rejects(withTransferTransaction(handle, "primary", async (client) => {
        await client.query(`CREATE TRIGGER pt1_unclassified BEFORE UPDATE ON "${PRIMARY_SCHEMA}".telemetry_v12_domain_days
          FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`);
        await assertTriggerPolicyCoverage(client, PRIMARY_SCHEMA, policy);
      }), error => isCode("CUTOVER_TRIGGER_POLICY_MISSING")(error) && error.trigger === "pt1_unclassified");

      // A deferred user constraint trigger may only fire; withTriggerPolicy
      // forces it IMMEDIATE with the FK so re-enabling the guard still works.
      await assert.rejects(withTransferTransaction(handle, "primary", async (client) => {
        await client.query(`CREATE FUNCTION "${PRIMARY_SCHEMA}".pt1_probe_constraint() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
        await client.query(`CREATE CONSTRAINT TRIGGER pt1_probe_constraint
          AFTER INSERT ON "${PRIMARY_SCHEMA}".telemetry_v12_domain_days DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION "${PRIMARY_SCHEMA}".pt1_probe_constraint()`);
        const withConstraint = policyEntry => ({ telemetry_v12_domain_days: {
          ...policy.telemetry_v12_domain_days, pt1_probe_constraint: policyEntry } });
        await assert.rejects(assertTriggerPolicyCoverage(client, PRIMARY_SCHEMA,
          withConstraint({ policy: "suppress", reason: "constraint triggers are never disabled" })),
        error => isCode("CUTOVER_TRIGGER_POLICY_INVALID")(error) && error.trigger === "pt1_probe_constraint");
        await assertTriggerPolicyCoverage(client, PRIMARY_SCHEMA,
          withConstraint({ policy: "fire", reason: "forced IMMEDIATE by the page" }));
        await assert.rejects(withTriggerPolicy(client, { ...domainDays, suppress: ["pt1_probe_constraint"] },
          async () => {}), isCode("CUTOVER_TRIGGER_POLICY_TRIGGER_INVALID"));
        await withTriggerPolicy(client, domainDays, page => insertDay(page, fixture, "2026-09-24"));
        assert.equal(await guardEnabled(client), "O");
        throw new Error("synthetic constraint-trigger rollback");
      }), /synthetic constraint-trigger rollback/u);
    });

    await t.test("identity high water rises to the sealed sequence and max id and is never lowered", async () => {
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".typed_telemetry_dictionary(id, value)
        VALUES (30, 'synthetic-value')`);
      const sequenceState = async () => (await ownerPrimary.query(`SELECT last_value::int AS last_value, is_called
        FROM ${(await ownerPrimary.query(`SELECT pg_get_serial_sequence($1, 'id') AS name`,
    [`"${PRIMARY_SCHEMA}".typed_telemetry_dictionary`])).rows[0].name}`)).rows[0];
      const entry = applied => applied.find(row => row.table === "typed_telemetry_dictionary");
      await withTransferTransaction(handle, "primary", async (client) => {
        assert.equal(entry(await applyIdentityHighWater(client, handle, {
          sealedSequences: { typed_telemetry_dictionary: 41 } })).highWater, "41");
      });
      assert.deepEqual(await sequenceState(), { last_value: 41, is_called: true });
      await withTransferTransaction(handle, "primary", async (client) => {
        assert.equal(entry(await applyIdentityHighWater(client, handle, {
          sealedSequences: { typed_telemetry_dictionary: 5 } })).highWater, "41");
        await assert.rejects(applyIdentityHighWater(client, handle, { sealedSequences: { participants: 5 } }),
          isCode("CUTOVER_IDENTITY_HIGH_WATER_INVALID"));
      });
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".typed_telemetry_dictionary(id, value)
        VALUES (50, 'synthetic-value-2')`);
      await withTransferTransaction(handle, "primary", async (client) => {
        assert.equal(entry(await applyIdentityHighWater(client, handle, {
          sealedSequences: { typed_telemetry_dictionary: 41 } })).highWater, "50");
      });
      assert.deepEqual(await sequenceState(), { last_value: 50, is_called: true });
    });

    await t.test("instant round trips name only the table and column", async () => {
      await withTransferTransaction(handle, "primary", client => assertInstantRoundTrip(client,
        { schema: PRIMARY_SCHEMA, table: "admin_action_audit", columns: ["created_at"] }), { readOnly: true });
      await ownerPrimary.query(`INSERT INTO "${PRIMARY_SCHEMA}".admin_action_audit(operation_id, action,
          actor_identity_digest, outcome, details_json, created_at)
        VALUES ('synthetic-microsecond', 'run_maintenance', $1, 'success', '{}', '2026-09-25T12:00:00.123456Z')`,
      ["d".repeat(64)]);
      await assert.rejects(withTransferTransaction(handle, "primary", client => assertInstantRoundTrip(client,
        { schema: PRIMARY_SCHEMA, table: "admin_action_audit", columns: ["created_at"] }), { readOnly: true }),
      (error) => {
        assert.equal(error.code, "CUTOVER_INSTANT_FORMAT_INVALID");
        assert.equal(error.message, "CUTOVER_INSTANT_FORMAT_INVALID [table=admin_action_audit column=created_at]");
        return true;
      });
      await ownerPrimary.query(`DELETE FROM "${PRIMARY_SCHEMA}".admin_action_audit WHERE operation_id = 'synthetic-microsecond'`);
    });

    await t.test("tool relations are owned by the schema owner; objects made without SET ROLE are refused", async () => {
      await withTransferTransaction(handle, "primary", async (client) => {
        await client.query(`CREATE TABLE tibotattle_transfer.pt1_probe_mirror (
          probe_id integer PRIMARY KEY, probe_digest text NOT NULL, probe_cursor text)`);
        await client.query(`CREATE FUNCTION tibotattle_transfer.pt1_probe_guard() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
        await client.query(`CREATE TRIGGER pt1_probe_guard BEFORE INSERT ON tibotattle_transfer.pt1_probe_mirror
          FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.pt1_probe_guard()`);
        await client.query(`INSERT INTO tibotattle_transfer.pt1_probe_mirror VALUES (1, 'a', 'k1'), (2, 'b', NULL)`);
        await assertNoTransferUserOwnership(client, handle);
      });
      const owners = await adminPrimary.query(`SELECT
          (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'tibotattle_transfer.pt1_probe_mirror'::regclass) AS relation,
          (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'tibotattle_transfer.pt1_probe_guard()'::regprocedure) AS function`);
      assert.deepEqual(owners.rows, [{ relation: roles.owner, function: roles.owner }]);
      const rogue = new pg.Client({ ...base, user: roles.transfer, database: databases.primary });
      await rogue.connect();
      try {
        await rogue.query("CREATE TABLE tibotattle_transfer.pt1_rogue (probe integer)");
        await assert.rejects(withTransferTransaction(handle, "primary", client => assertNoTransferUserOwnership(client, handle)),
          isCode("CUTOVER_TRANSFER_USER_OWNS_OBJECTS"));
        await rogue.query("DROP TABLE tibotattle_transfer.pt1_rogue");
      } finally {
        await rogue.end();
      }
      await withTransferTransaction(handle, "primary", client => assertNoTransferUserOwnership(client, handle));
      await withTransferTransaction(handle, "ledger", client => assertNoTransferUserOwnership(client, handle));
    });

    await t.test("checkpoint cursors are scrubbed and staging relations drop with receipts before verification", async () => {
      await withTransferTransaction(handle, "primary", async (client) => {
        await recordCheckpoint(client, handle, { stage: "typed-legacy", name: "typed_v1_rows", state: "pending",
          lastKey: ["synthetic-key", 3], rowCount: 3, prefixChainSha256: EMPTY_PREFIX_CHAIN });
        assert.deepEqual((await readCheckpoint(client, handle, { stage: "typed-legacy", name: "typed_v1_rows" })).lastKey,
          ["synthetic-key", 3]);
        await recordCheckpoint(client, handle, { stage: "typed-legacy", name: "typed_v11_rows", state: "complete",
          rowCount: 0, prefixChainSha256: EMPTY_PREFIX_CHAIN });
        await assert.rejects(recordCheckpoint(client, handle, { stage: "typed-legacy", name: "typed_v11_rows",
          state: "complete", lastKey: ["x"], rowCount: 0, prefixChainSha256: EMPTY_PREFIX_CHAIN }),
        isCode("CUTOVER_CHECKPOINT_INVALID"));
      });
      await assert.rejects(adminPrimary.query(`UPDATE tibotattle_transfer.transfer_checkpoints SET last_key = '["x"]'
        WHERE checkpoint_name = 'typed_v11_rows'`), isSqlState("P1005", "TRANSFER_CHECKPOINT_IMMUTABLE"));
      const staging = [{ schema: "tibotattle_transfer", table: "pt1_probe_mirror", requiresStageComplete: "header-promotion" }];
      await withTransferTransaction(handle, "primary", async (client) => {
        const scrubbed = await scrubCheckpointCursors(client, handle,
          [{ table: "pt1_probe_mirror", cursorColumns: ["probe_cursor"] }]);
        assert.deepEqual(scrubbed.map(row => ({ ...row })),
          [{ relation: "transfer_checkpoints", rows: 1 }, { relation: "pt1_probe_mirror", rows: 1 }]);
        await assert.rejects(scrubCheckpointCursors(client, handle,
          [{ table: "pt1_probe_mirror", cursorColumns: ["probe_digest"] }]), isCode("CUTOVER_STAGING_REGISTRY_INVALID"));
      });
      await withTransferTransaction(handle, "primary", async (client) => {
        await assert.rejects(dropTransferStagingRelations(client, handle, staging),
          error => isCode("CUTOVER_STAGE_INCOMPLETE")(error) && error.stage === "header-promotion");
        await assert.rejects(dropTransferStagingRelations(client, handle,
          [{ ...staging[0], table: "transfer_runs" }]), isCode("CUTOVER_STAGING_REGISTRY_INVALID"));
        for (const stage of TRANSFER_STAGES) {
          await stageReceipt(client, handle, { stage, state: "complete", rowCount: stage === "identity-authority" ? 3 : 0,
            byteCount: stage === "identity-authority" ? 120 : 0,
            receiptSha256: stage === "identity-authority" ? "a".repeat(64) : createRowsDigest().digest() });
        }
      });
      const receipts = await withTransferTransaction(handle, "primary",
        client => dropTransferStagingRelations(client, handle, staging));
      const expected = createRowsDigest();
      for (const row of ["{\"probe_id\": 1, \"probe_cursor\": null, \"probe_digest\": \"a\"}",
        "{\"probe_id\": 2, \"probe_cursor\": null, \"probe_digest\": \"b\"}"]) expected.update(row);
      assert.deepEqual(receipts.map(row => ({ ...row })), [{ relation: "pt1_probe_mirror", wasPresent: true, rowCount: 2,
        rowsSha256: expected.digest() }]);
      const dropped = await adminPrimary.query(`SELECT to_regclass('tibotattle_transfer.pt1_probe_mirror') AS relation,
        to_regprocedure('tibotattle_transfer.pt1_probe_guard()') AS function,
        (SELECT count(*)::int FROM tibotattle_transfer.transfer_dropped_relations) AS receipts`);
      assert.deepEqual(dropped.rows, [{ relation: null, function: null, receipts: 1 }]);
      assert.deepEqual((await withTransferTransaction(handle, "primary",
        client => dropTransferStagingRelations(client, handle, staging))).map(row => row.rowCount), [2]);

      await withTransferTransaction(handle, "primary",
        client => client.query("CREATE TABLE tibotattle_transfer.pt1_leftover (probe integer)"));
      await assert.rejects(withTransferTransaction(handle, "primary", client => dropTransferStagingRelations(client, handle, [])),
        error => isCode("CUTOVER_CONTROL_SCHEMA_NOT_ALLOWLISTED")(error) && error.relation === "pt1_leftover");
      await advanceRun(handle, "verifying");
      await assert.rejects(advanceRun(handle, "verified"),
        error => isCode("CUTOVER_CONTROL_SCHEMA_NOT_ALLOWLISTED")(error) && error.relation === "pt1_leftover");
      await ownerPrimary.query("DROP TABLE tibotattle_transfer.pt1_leftover");
      const verified = await advanceRun(handle, "verified");
      assert.deepEqual({ ...verified }, { runId, state: "verified", ledgerState: "verified" });
      await assert.rejects(ownerPrimary.query(`INSERT INTO tibotattle_transfer.transfer_dropped_relations
          (run_id, relation_name, stage, was_present, row_count, rows_sha256)
        VALUES ($1, 'pt1_late', 'post-import', false, 0, $2)`, [runId, "0".repeat(64)]),
      isSqlState("P1005", "TRANSFER_WRITE_REFUSED"));
    });

    await t.test("restore is refused while the D1 retention fence is unreconciled, then restores the sealed row exactly", async () => {
      await withTransferTransaction(handle, "primary", async (client) => {
        await assert.rejects(restoreSealedCollectionControls(client, handle), isCode("CUTOVER_RETENTION_FENCE_UNRECONCILED"));
      });
      // Stand-in for PT-6's reviewed pending -> reconciled transition.
      const reconcile = await adminPrimary.connect();
      try {
        await reconcile.query("BEGIN");
        await reconcile.query(`ALTER TABLE "${PRIMARY_SCHEMA}".accountless_public_history_import_runs
          DISABLE TRIGGER accountless_public_history_import_run_guard`);
        await reconcile.query(`UPDATE "${PRIMARY_SCHEMA}".accountless_public_history_import_runs
          SET source_fence_state = 'reconciled' WHERE transfer_id = $1`, [retentionTransferId]);
        await reconcile.query(`ALTER TABLE "${PRIMARY_SCHEMA}".accountless_public_history_import_runs
          ENABLE TRIGGER accountless_public_history_import_run_guard`);
        await reconcile.query("COMMIT");
      } finally {
        reconcile.release();
      }
      const restored = await withTransferTransaction(handle, "primary", client => restoreSealedCollectionControls(client, handle));
      const controls = await ownerPrimary.query(`SELECT control_state, enrollment_enabled, upload_registration_enabled,
          processing_enabled, publication_enabled, revision::int AS revision, reason_code,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM "${PRIMARY_SCHEMA}".collection_controls`);
      const expectedRow = { control_state: "operational", enrollment_enabled: true, upload_registration_enabled: true,
        processing_enabled: true, publication_enabled: true, revision: 7, reason_code: "drill_restore",
        updated_at: "2026-09-20T10:11:12.345Z" };
      assert.deepEqual(controls.rows, [expectedRow]);
      assert.equal(restored.sealedRowSha256, sealedCollectionControlsSha256(expectedRow));
    });

    await t.test("the runtime role cannot read tibotattle_transfer in either database", async () => {
      for (const [adminPool, schema] of [[adminPrimary, PRIMARY_SCHEMA], [adminLedger, LEDGER_SCHEMA]]) {
        const client = await adminPool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE "${roles.runtime}"`);
          // The runtime role does hold its application-schema grants.
          await client.query(`SELECT count(*) FROM "${schema}"."_tibotattle_migration_history"`);
          await client.query("SAVEPOINT sp");
          const relation = schema === PRIMARY_SCHEMA ? "transfer_runs" : "ledger_transfer_runs";
          await assert.rejects(client.query(`SELECT * FROM tibotattle_transfer.${relation}`), isSqlState("42501"));
          await client.query("ROLLBACK TO SAVEPOINT sp");
          await assert.rejects(client.query("SELECT tibotattle_transfer.install_transfer_live_lock()"), isSqlState("42501"));
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    });

    await t.test("flip readiness refuses extra role members, runtime grants and disabled triggers", async () => {
      const flip = { flipEvidenceSha256: FLIP };
      const ready = () => withTransferTransaction(handle, "primary", client => assertFlipReady(client, handle, flip),
        { readOnly: true });
      await assert.rejects(ready(), isCode("CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED"));
      await admin.query(`REVOKE "${roles.owner}" FROM "${roles.other}"`);
      await ownerPrimary.query(`GRANT SELECT ON tibotattle_transfer.transfer_runs TO "${roles.runtime}"`);
      await assert.rejects(ready(), isCode("CUTOVER_FLIP_RUNTIME_PRIVILEGE"));
      await ownerPrimary.query(`REVOKE SELECT ON tibotattle_transfer.transfer_runs FROM "${roles.runtime}"`);
      await ownerLedger.query(`GRANT USAGE ON SCHEMA tibotattle_transfer TO "${roles.runtime}"`);
      await assert.rejects(ready(), isCode("CUTOVER_FLIP_RUNTIME_PRIVILEGE"));
      await ownerLedger.query(`REVOKE USAGE ON SCHEMA tibotattle_transfer FROM "${roles.runtime}"`);
      await ownerPrimary.query(`ALTER TABLE "${PRIMARY_SCHEMA}".telemetry_v12_domain_days DISABLE TRIGGER ${GUARD}`);
      await assert.rejects(ready(), error => isCode("CUTOVER_FLIP_TRIGGER_DISABLED")(error) && error.trigger === GUARD);
      await ownerPrimary.query(`ALTER TABLE "${PRIMARY_SCHEMA}".telemetry_v12_domain_days ENABLE TRIGGER ${GUARD}`);
      await assert.rejects(withTransferTransaction(handle, "primary",
        client => assertFlipReady(client, handle, { flipEvidenceSha256: "not-a-digest" })), isCode("CUTOVER_FLIP_EVIDENCE_INVALID"));
      const report = await ready();
      assert.deepEqual({ ...report }, { runId, flipEvidenceSha256: FLIP, ready: true });
    });

    await t.test("markLive locks every relation of tibotattle_transfer in both databases and refuses new runs", async () => {
      const live = await markLive(handle, { flipEvidenceSha256: FLIP });
      assert.equal(live.state, "live");
      assert.equal(live.primaryLocked, CONTROL_SCHEMA_RELATIONS.length - 1);
      assert.equal(live.ledgerLocked, 2);
      const again = await markLive(handle, { flipEvidenceSha256: FLIP });
      assert.deepEqual({ ...again }, { ...live });
      await assert.rejects(markLive(handle, { flipEvidenceSha256: SEAL_B }), isCode("CUTOVER_FLIP_EVIDENCE_INVALID"));
      for (const [adminPool, databaseRole] of [[adminPrimary, "primary"], [adminLedger, "ledger"]]) {
        const relations = await adminPool.query(`SELECT relname FROM pg_class
          WHERE relnamespace = 'tibotattle_transfer'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`);
        assert.ok(relations.rows.length > 0);
        for (const { relname } of relations.rows) {
          await assert.rejects(adminPool.query(`INSERT INTO tibotattle_transfer."${relname}" DEFAULT VALUES`),
            isSqlState("P1005", "TRANSFER_TARGET_LIVE"), `${databaseRole}.${relname} accepted an insert after live`);
        }
      }
      await assert.rejects(adminPrimary.query(`UPDATE tibotattle_transfer.transfer_runs SET state = 'abandoned'`),
        isSqlState("P1005", "TRANSFER_TARGET_LIVE"));
      await assert.rejects(adminLedger.query(`DELETE FROM tibotattle_transfer.ledger_transfer_runs`),
        isSqlState("P1005", "TRANSFER_TARGET_LIVE"));
      const states = await Promise.all([
        adminPrimary.query("SELECT state, flip_evidence_sha256 FROM tibotattle_transfer.transfer_runs"),
        adminLedger.query("SELECT state, flip_evidence_sha256 FROM tibotattle_transfer.ledger_transfer_runs"),
      ]);
      for (const result of states) assert.deepEqual(result.rows, [{ state: "live", flip_evidence_sha256: FLIP }]);
      const resumed = await openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_A });
      assert.equal(resumed.openedRunState, "live");
      await assert.rejects(beginRun(resumed, { sealedAt: "2026-09-25T12:00:00.000Z" }), isCode("CUTOVER_RUN_EXISTS"));
      await assert.rejects(abandonRun(resumed), isCode("CUTOVER_RUN_TRANSITION_REFUSED"));
      await assert.rejects(openProductionTransferTarget({ ...target, ...openArgs, sealManifestSha256: SEAL_B }),
        isCode("CUTOVER_TARGET_SEAL_MISMATCH"));
      await assert.rejects(withTransferTransaction(resumed, "primary", client => stageReceipt(client, resumed,
        { stage: "objects", state: "started" })), isCode("CUTOVER_RUN_STATE_INVALID"));
    });
  } finally {
    await Promise.allSettled(pools.map(entry => entry.end()));
    for (const database of createdDatabases.reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    for (const role of createdRoles.reverse()) {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.end();
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
