/**
 * The one runtime-grant policy for a migrated PostgreSQL role schema.
 *
 * Every migrator that hands a schema to the Cloud Run runtime applies this
 * module, and nothing else, to decide what the runtime role may do there:
 *
 *   - cloud-run/test-migrations.mjs (the A2, benchmark and fast-path migrate
 *     Jobs, and the fast-path seed through grantAndVerifyTestRuntimePrivileges),
 *     with the pinned test runtime role;
 *   - cloud-run/postgres-production-migrations.mjs (OPS-10), with the
 *     configured production runtime role;
 *   - scripts/gcp-test-database.mjs (the generic Cloud SQL IAM qualification
 *     job), with its configured runtime role.
 *
 * The policy: the runtime role gets USAGE on the schema (never CREATE), table
 * DML (SELECT, INSERT, UPDATE, DELETE) on every relation, USAGE, SELECT and
 * UPDATE on every sequence, the same through the migrator's default
 * privileges, SELECT only on the migration history, and EXECUTE on exactly
 * RUNTIME_PRIMARY_FUNCTIONS among the schema's non-PUBLIC routines (none in a
 * ledger schema). Every direct grant to the runtime role on the schema's
 * tables, sequences and routines is reset first, so a re-run converges.
 *
 * The read-back is part of the policy, not an option: after granting, one
 * catalog query must show exactly that posture, and every operator-only
 * entrypoint (OPERATOR_ONLY_PRIMARY_FUNCTIONS) must exist, be non-PUBLIC and
 * be closed to the runtime role. A privilege the reset cannot remove (an
 * operator entrypoint reopened to PUBLIC, a role membership) fails closed.
 *
 * Errors carry only a code: `<codePrefix><ROLE>_<REASON>` (or
 * `<codePrefix><REASON>` for argument refusals). The prefix names the caller's
 * error family ("POSTGRES_TEST_MIGRATIONS_", "POSTGRES_PRODUCTION_MIGRATIONS_",
 * or "" for the generic qualification job). No identifier, row or driver
 * message is ever attached.
 */

import { createHash } from "node:crypto";

export const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
export const RUNTIME_GRANT_ROLES = Object.freeze(["primary", "ledger"]);

/**
 * Primary functions the migrations revoke from PUBLIC that the runtime role
 * must execute: canonical v1 admission (0004), and the owner journal's append
 * and owner-link mint (0046). Both are SECURITY INVOKER and run as the
 * request's role inside the v1.2 owner-bridge trigger (0055, every v1.2
 * domain activation), v1.1 live admission (0060) and legacy contribution
 * admission (0061), so without EXECUTE those routes answer 503.
 */
export const RUNTIME_PRIMARY_FUNCTIONS = Object.freeze([
  Object.freeze({ name: "insert_telemetry_v1_contribution", args: "jsonb" }),
  Object.freeze({ name: "storage_journal_append", args: "text, text, text, text, text" }),
  Object.freeze({ name: "storage_owner_link_ensure", args: "text, text" }),
]);
/**
 * Maintenance entrypoints revoked from PUBLIC (0055, 0060, 0052) that only an
 * operator or schema-owner role runs. The runtime role must never execute
 * them; the read-back also refuses any other non-PUBLIC function it can run.
 */
export const OPERATOR_ONLY_PRIMARY_FUNCTIONS = Object.freeze([
  Object.freeze({ name: "storage_v11_bridge_backfill", args: "integer" }),
  Object.freeze({ name: "storage_v12_bridge_backfill", args: "integer" }),
  Object.freeze({ name: "typed_telemetry_restart_identities", args: "" }),
]);

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const RESERVED_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema"]);
// Mirrors cloud-sql.mjs normalizeIamUser: a Cloud SQL IAM database user (an
// IAM email without .gserviceaccount.com) or a plain role name.
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const CODE_PREFIX_PATTERN = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)?$/u;

/** `name(args)`, as the read-back renders pg_proc rows (oidvectortypes). */
export function functionSignature({ name, args }) {
  return `${name}(${args})`;
}

/**
 * True when the non-PUBLIC functions of one role schema are exactly as the
 * runtime policy requires: the runtime role executes every runtime function
 * and nothing else among them, and every operator-only entrypoint is present
 * and closed to it.
 */
export function restrictedFunctionsMatchPolicy(role, rows) {
  if (!Array.isArray(rows)) return false;
  const runtime = role === "primary" ? RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature).sort() : [];
  const operatorOnly = role === "primary" ? OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature) : [];
  const executable = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || typeof row.signature !== "string"
        || typeof row.runtime_execute !== "boolean" || executable.has(row.signature)) {
      return false;
    }
    executable.set(row.signature, row.runtime_execute);
  }
  const granted = [...executable].filter(([, allowed]) => allowed).map(([signature]) => signature).sort();
  return granted.length === runtime.length
    && granted.every((signature, index) => signature === runtime[index])
    && operatorOnly.every((signature) => executable.get(signature) === false);
}

/**
 * sha256 of the canonical policy (function lists and the table, sequence and
 * history privilege sets). Receipts carry it so a reader can tell which
 * policy a schema was verified against.
 */
export function runtimeGrantPolicyDigest() {
  return createHash("sha256").update(JSON.stringify({
    schema: "tibotattle-runtime-grant-policy-v1",
    runtimePrimaryFunctions: RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature),
    operatorOnlyPrimaryFunctions: OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature),
    schemaPrivileges: ["USAGE"],
    tablePrivileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    sequencePrivileges: ["USAGE", "SELECT", "UPDATE"],
    historyPrivileges: ["SELECT"],
  })).digest("hex");
}

/** A refusal raised by this module; its code is the whole content. */
export class RuntimeGrantError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeGrantError";
    this.code = code;
  }
}

export function isRuntimeGrantError(error) {
  return error instanceof RuntimeGrantError;
}

function fail(code) {
  throw new RuntimeGrantError(code);
}

function codePrefixOf(value) {
  if (typeof value !== "string" || !CODE_PREFIX_PATTERN.test(value)) {
    fail("POSTGRES_RUNTIME_GRANTS_CODE_PREFIX_INVALID");
  }
  return value;
}

function roleOf(role, prefix) {
  if (!RUNTIME_GRANT_ROLES.includes(role)) fail(`${prefix}ROLE_INVALID`);
  return role;
}

function quoteSchema(schema, prefix) {
  // Callers pass validated or constant names; retain a local guard before SQL rendering.
  if (typeof schema !== "string" || !SCHEMA_PATTERN.test(schema)
      || RESERVED_SCHEMAS.has(schema) || schema.startsWith("pg_")) {
    fail(`${prefix}SCHEMA_INVALID`);
  }
  return `"${schema}"`;
}

function quoteRole(role, prefix) {
  if (typeof role !== "string" || !ROLE_PATTERN.test(role) || Buffer.byteLength(role, "utf8") > 63) {
    fail(`${prefix}RUNTIME_ROLE_INVALID`);
  }
  return `"${role.replaceAll('"', '""')}"`;
}

function ownerOf(owner, prefix) {
  if (typeof owner !== "string" || !ROLE_PATTERN.test(owner) || Buffer.byteLength(owner, "utf8") > 63) {
    fail(`${prefix}SCHEMA_OWNER_INVALID`);
  }
  return owner;
}

function rowsFrom(result, code) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail(code);
  }
  return result.rows;
}

/**
 * Create the role schema owned by the connected migrator, or accept an
 * existing one only when `ownerRole` already owns it. Nothing else is
 * written.
 */
export async function ensureSchema(pool, { role, schema, ownerRole, codePrefix } = {}) {
  const prefix = codePrefixOf(codePrefix);
  const roleCode = `${prefix}${roleOf(role, prefix).toUpperCase()}`;
  const owner = ownerOf(ownerRole, prefix);
  const schemaSql = quoteSchema(schema, prefix);
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const currentRows = rowsFrom(await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
      [schema],
    ), `${roleCode}_SCHEMA_READ_FAILED`);
    if (currentRows.length > 1) {
      fail(`${roleCode}_SCHEMA_READ_FAILED`);
    }
    if (currentRows.length === 0) {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
    } else if (currentRows[0]?.owner !== owner) {
      fail(`${roleCode}_SCHEMA_OWNER_UNEXPECTED`);
    }
    const ownerRows = rowsFrom(await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
      [schema],
    ), `${roleCode}_SCHEMA_READ_FAILED`);
    if (ownerRows.length !== 1 || ownerRows[0]?.owner !== owner) {
      fail(`${roleCode}_SCHEMA_OWNER_UNEXPECTED`);
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`${roleCode}_SCHEMA_ROLLBACK_FAILED`);
      }
    }
    if (isRuntimeGrantError(error)) throw error;
    fail(`${roleCode}_SCHEMA_SETUP_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`${roleCode}_SCHEMA_RELEASE_FAILED`);
      }
    }
  }
}

/**
 * Apply the runtime policy to one role schema and read it back in the same
 * transaction. `runtimeRole` is the runtime's database role; the connected
 * session must own the schema (it defines the default privileges read back).
 */
export async function grantAndVerifyRuntimePrivileges(pool, { role, schema: schemaName, runtimeRole: runtimeRoleName,
  codePrefix } = {}) {
  const prefix = codePrefixOf(codePrefix);
  const roleCode = `${prefix}${roleOf(role, prefix).toUpperCase()}`;
  const schema = quoteSchema(schemaName, prefix);
  const runtimeRole = quoteRole(runtimeRoleName, prefix);
  const historyTable = `"${MIGRATION_HISTORY_TABLE}"`;
  const tableRelation = `${schemaName}.${MIGRATION_HISTORY_TABLE}`;
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");

    // Reset only direct grants on this exact schema, then grant the runtime
    // role only the privileges exercised by the application. Migration
    // history remains read-only to runtime.
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`,
    );
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole}`,
    );
    await client.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
         ON ${schema}.${historyTable} FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         REVOKE ALL ON TABLES FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         REVOKE ALL ON SEQUENCES FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeRole}`,
    );
    // Function grants are reset the same way: no direct grant survives on any
    // routine of the schema, then the primary runtime functions are granted.
    // PUBLIC's default EXECUTE on the other functions is the migrations' own.
    await client.query(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schema} FROM ${runtimeRole}`);
    if (role === "primary") {
      for (const { name, args } of RUNTIME_PRIMARY_FUNCTIONS) {
        await client.query(`GRANT EXECUTE ON FUNCTION ${schema}."${name}"(${args}) TO ${runtimeRole}`);
      }
    }

    const rows = rowsFrom(await client.query(
      `SELECT
         has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
         has_schema_privilege($1, $2, 'CREATE') AS schema_create,
         (SELECT count(*) > 0 AND COALESCE(bool_and(
             has_table_privilege($1, rel.oid, 'SELECT')
             AND has_table_privilege($1, rel.oid, 'INSERT')
             AND has_table_privilege($1, rel.oid, 'UPDATE')
             AND has_table_privilege($1, rel.oid, 'DELETE')
           ), false)
            FROM pg_class rel
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $2 AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND rel.relname <> $4) AS application_tables_dml,
         (SELECT COALESCE(bool_and(
             has_sequence_privilege($1, rel.oid, 'USAGE')
             AND has_sequence_privilege($1, rel.oid, 'SELECT')
             AND has_sequence_privilege($1, rel.oid, 'UPDATE')
           ), true)
            FROM pg_class rel
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $2 AND rel.relkind = 'S') AS sequences_access,
         has_table_privilege($1, $3, 'SELECT') AS history_select,
         has_table_privilege($1, $3, 'INSERT') AS history_insert,
         has_table_privilege($1, $3, 'UPDATE') AS history_update,
         has_table_privilege($1, $3, 'DELETE') AS history_delete,
         (SELECT count(*) = 4
                 AND array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                   = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
                 AND bool_and(NOT acl.is_grantable)
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'r'
             AND defaults.defaclnamespace = to_regnamespace($2)
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS default_tables_dml,
         (SELECT count(*) = 3
                 AND array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                   = ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]
                 AND bool_and(NOT acl.is_grantable)
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'S'
             AND defaults.defaclnamespace = to_regnamespace($2)
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS default_sequences_access,
         (SELECT count(*) = 0
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'r'
             AND defaults.defaclnamespace = 0
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS no_global_table_defaults,
         (SELECT count(*) = 0
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'S'
             AND defaults.defaclnamespace = 0
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS no_global_sequence_defaults,
         (SELECT COALESCE(json_agg(json_build_object(
             'signature', fn.proname || '(' || pg_catalog.oidvectortypes(fn.proargtypes) || ')',
             'runtime_execute', has_function_privilege($1, fn.oid, 'EXECUTE')
           ) ORDER BY fn.proname, fn.oid), '[]'::json)
            FROM pg_proc fn
           WHERE fn.pronamespace = to_regnamespace($2)
             AND NOT has_function_privilege('public', fn.oid, 'EXECUTE')) AS restricted_functions`,
      [
        runtimeRoleName,
        schemaName,
        tableRelation,
        MIGRATION_HISTORY_TABLE,
      ],
    ), `${roleCode}_RUNTIME_PRIVILEGES_READ_FAILED`);
    const actual = rows[0];
    if (rows.length !== 1
        || actual?.schema_usage !== true
        || actual?.schema_create !== false
        || actual?.application_tables_dml !== true
        || actual?.sequences_access !== true
        || actual?.history_select !== true
        || actual?.history_insert !== false
        || actual?.history_update !== false
        || actual?.history_delete !== false
        || actual?.default_tables_dml !== true
        || actual?.default_sequences_access !== true
        || actual?.no_global_table_defaults !== true
        || actual?.no_global_sequence_defaults !== true
        || !restrictedFunctionsMatchPolicy(role, actual?.restricted_functions)) {
      fail(`${roleCode}_RUNTIME_PRIVILEGES_INVALID`);
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`${roleCode}_RUNTIME_PRIVILEGES_ROLLBACK_FAILED`);
      }
    }
    if (isRuntimeGrantError(error)) throw error;
    fail(`${roleCode}_RUNTIME_GRANT_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`${roleCode}_RUNTIME_PRIVILEGES_RELEASE_FAILED`);
      }
    }
  }
}

/**
 * Read the schema's migration history in a read-only transaction and require
 * it to equal `expected` ({version, name, sha256} per migration, in order).
 */
export async function readBackReceipts(pool, { role, schema, expected, codePrefix } = {}) {
  const prefix = codePrefixOf(codePrefix);
  const roleCode = `${prefix}${roleOf(role, prefix).toUpperCase()}`;
  if (!Array.isArray(expected)) fail(`${roleCode}_RECEIPT_MISMATCH`);
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const receiptRows = rowsFrom(await client.query(
      `SELECT version, name, checksum_sha256
         FROM ${quoteSchema(schema, prefix)}."${MIGRATION_HISTORY_TABLE}"
        ORDER BY version`,
    ), `${roleCode}_RECEIPT_READ_FAILED`);
    if (receiptRows.length !== expected.length) {
      fail(`${roleCode}_RECEIPT_MISMATCH`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = receiptRows[index];
      const wanted = expected[index];
      if (actual?.version !== wanted?.version
          || actual?.name !== wanted?.name
          || actual?.checksum_sha256 !== wanted?.sha256) {
        fail(`${roleCode}_RECEIPT_MISMATCH`);
      }
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`${roleCode}_RECEIPT_ROLLBACK_FAILED`);
      }
    }
    if (isRuntimeGrantError(error)) throw error;
    fail(`${roleCode}_RECEIPT_READ_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`${roleCode}_RECEIPT_RELEASE_FAILED`);
      }
    }
  }
}
