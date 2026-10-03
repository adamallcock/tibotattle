// W2-SEAL PostgreSQL 17 harness: a registered PT-1 production transfer
// target on the local cluster. Test-only.
//
// Each target is one dedicated primary database (w2_seal_*; decision D4
// leaves no deletion-ledger database, and SIMP-4 makes the target
// primary-only), owned by a schema-owner role, with the promoted primary
// chain (through the append-only residue; the erased-redeemer migration
// would go through the staged-migrations harness while staged) applied by
// the production runner, and the contract registered. The transfer login is a deliberate, non-escalating
// member of tibotattle_source_transfer, so storage_journal_transfer_session()
// is true for it; the cluster-global role is created and granted under the
// advisory lock the owner-journal and transport-floor specs share.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyPostgresMigrations, readPostgresMigrations } from "../../../scripts/postgres-migrations.mjs";
import {
  openProductionTransferTarget,
  registerProductionTransferTarget,
} from "../../../scripts/postgres-transfer-target.mjs";
import { applyStockAndStagedMigrations, STAGED_MIGRATIONS_ROOT } from "../../staged-migrations-harness.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TRANSFER_ROLE = "tibotattle_source_transfer";
export const TRANSFER_ROLE_LOCK = 460_046;
export const PRIMARY_SCHEMA = "w2_seal_primary";
export const ERASED_REDEEMER_SUFFIX = "_enrollment_grants_erased_redeemer.sql";

export async function localSocket(socket, port) {
  assert.match(socket ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const [link, resolved] = await Promise.all([lstat(socket), realpath(socket)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port };
}

/** The erased-redeemer migration by name suffix: staged (applied by the harness) or promoted. */
export async function erasedRedeemerMigration() {
  let staged = [];
  try {
    staged = (await readdir(join(STAGED_MIGRATIONS_ROOT, "primary"))).filter(name => name.endsWith(ERASED_REDEEMER_SUFFIX));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const promoted = (await readPostgresMigrations({ role: "primary" })).map(migration => migration.name)
    .filter(name => name.endsWith(ERASED_REDEEMER_SUFFIX));
  assert.equal(staged.length + promoted.length, 1, "exactly one erased-redeemer migration, staged or promoted");
  return { name: staged[0] ?? promoted[0], staged: staged.length === 1 };
}

/**
 * Create the roles and the transfer-role grant, then `count` targets. The
 * returned dispose() drops everything this harness created. `collations[i]`
 * (default none: the cluster's template, C on the local clusters) creates
 * target i from template0 with that LC_COLLATE and LC_CTYPE, for example
 * en_US.UTF-8, the documented Cloud SQL default for a database created
 * without a collation flag.
 */
export async function createW2SealCluster({ socket, port, user, password, database, count = 1, label = "w2", collations = [] }) {
  assert.ok(Array.isArray(collations) && collations.every(name => name === null || name === undefined
    || /^[A-Za-z0-9_.@-]{1,64}$/u.test(name)), "collations must be plain locale names");
  const endpoint = await localSocket(socket, port);
  const base = { ...endpoint, password, ssl: false, connectionTimeoutMillis: 5_000 };
  const admin = new pg.Client({ ...base, user, database });
  await admin.connect();
  const lock = new pg.Client({ ...base, user, database });
  await lock.connect();
  const suffix = `${label}_${randomBytes(4).toString("hex")}`;
  const roles = { owner: `w2_seal_owner_${suffix}`, transfer: `w2_seal_transfer_${suffix}` };
  const pools = [];
  const created = { roles: [], databases: [], transferRole: false, locked: false };
  const pool = (poolUser, poolDatabase, max = 3) => {
    const instance = new pg.Pool({ ...base, user: poolUser, database: poolDatabase, max });
    instance.on("error", () => {});
    pools.push(instance);
    return instance;
  };
  const dispose = async () => {
    for (const instance of pools.splice(0)) await instance.end().catch(() => {});
    for (const name of created.databases.splice(0)) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    if (created.transferRole) await admin.query(`DROP ROLE IF EXISTS ${TRANSFER_ROLE}`).catch(() => {});
    else await admin.query(`REVOKE ${TRANSFER_ROLE} FROM "${roles.transfer}"`).catch(() => {});
    for (const role of created.roles.splice(0).reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    if (created.locked) await lock.query("SELECT pg_advisory_unlock($1)", [TRANSFER_ROLE_LOCK]).catch(() => {});
    await lock.end().catch(() => {});
    await admin.end().catch(() => {});
  };
  try {
    const facts = await admin.query(`SELECT current_setting('server_version_num') AS version,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser, inet_server_addr() AS address`);
    assert.match(facts.rows[0].version, /^17\d{4}$/u, "PostgreSQL 17 required");
    assert.equal(facts.rows[0].superuser, true, "the harness creates databases and roles");
    assert.equal(facts.rows[0].address, null, "local Unix socket only");
    await lock.query("SELECT pg_advisory_lock($1)", [TRANSFER_ROLE_LOCK]);
    created.locked = true;
    for (const role of Object.values(roles)) {
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB`);
      created.roles.push(role);
    }
    await admin.query(`GRANT "${roles.owner}" TO "${roles.transfer}"`);
    if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [TRANSFER_ROLE])).rowCount === 0) {
      await admin.query(`CREATE ROLE ${TRANSFER_ROLE} NOLOGIN`);
      created.transferRole = true;
    }
    await admin.query(`GRANT ${TRANSFER_ROLE} TO "${roles.transfer}"`);
    const erased = await erasedRedeemerMigration();
    const targets = [];
    for (let index = 0; index < count; index += 1) {
      const databases = { primary: `w2_seal_primary_${suffix}_${index}` };
      for (const name of Object.values(databases)) {
        const collation = collations[index] ?? null;
        await admin.query(collation === null ? `CREATE DATABASE "${name}" OWNER "${roles.owner}"`
          : `CREATE DATABASE "${name}" OWNER "${roles.owner}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE '${collation}' LC_CTYPE '${collation}'`);
        created.databases.push(name);
      }
      const ownerPrimary = pool(roles.owner, databases.primary);
      await ownerPrimary.query(`CREATE SCHEMA "${PRIMARY_SCHEMA}"`);
      if (erased.staged) {
        await applyStockAndStagedMigrations({ role: "primary", schema: PRIMARY_SCHEMA, pool: ownerPrimary,
          stagedFiles: [erased.name] });
      } else {
        await applyPostgresMigrations({ role: "primary", schema: PRIMARY_SCHEMA, pool: ownerPrimary });
      }
      const contract = {
        contractId: `w2-seal-target-${index}`,
        mode: "production",
        projectId: "tibotattle-synthetic",
        projectNumber: "123456789012",
        instanceConnectionName: "tibotattle-synthetic:us-east1:w2-seal-primary",
        databaseName: databases.primary,
        schemaName: PRIMARY_SCHEMA,
        iamDatabaseUser: roles.transfer,
        schemaOwnerRole: roles.owner,
        gcsBucket: "tibotattle-synthetic-quarantine",
        gcsBucketGeneration: "1790000000000001",
      };
      await registerProductionTransferTarget({ primaryPool: ownerPrimary, contract });
      const transferPrimary = pool(roles.transfer, databases.primary);
      targets.push(Object.freeze({
        index,
        databases,
        contract,
        ownerPrimary,
        adminPrimary: pool(user, databases.primary, 2),
        transferPrimary,
        open: sealManifestSha256 => openProductionTransferTarget({ primaryPool: transferPrimary,
          expectedContractId: contract.contractId, sealManifestSha256 }),
      }));
    }
    return { roles, targets, erased, dispose, endpoint };
  } catch (error) {
    await dispose();
    throw error;
  }
}
