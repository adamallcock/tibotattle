import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { TYPED_PRODUCTION_QUERIES } from './production-typed-preflight.mjs';

const MAX_MIGRATION_BYTES = 240 * 1024;
const MIGRATION_NAME = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/u;
const MAX_STATEMENTS = 900;
const ROLE_ORDER = Object.freeze(['primary', 'analytics', 'ledger']);

/** These are candidate-owned, reviewed source inputs. Generated restore
 * qualification output is deliberately excluded: it is evidence, not a
 * source of expectations for a routine production redeploy. */
export const TYPED_SCHEMA_INPUT_DIRECTORIES = Object.freeze({
  primary: Object.freeze([
    'migrations',
    'typed-ingestion-migrations',
    'ingestion-bridge-migrations',
    'typed-v11-admission-migrations',
    'typed-v1-admission-migrations',
    'ingestion-isolation-migrations',
  ]),
  analytics: Object.freeze(['analytics-migrations']),
  ledger: Object.freeze(['deletion-ledger-migrations']),
});

/** Wrangler creates this exact administrative ledger for a database that is
 * deployed through its migration runner. It is role bookkeeping rather than a
 * candidate migration, so the local builder installs only this fixed DDL for
 * the deletion-ledger role. Any attached index, trigger, or changed SQL still
 * remains visible to the preflight schema comparison. */
export const WRANGLER_MIGRATION_LEDGER_SCHEMA = Object.freeze({
  type: 'table',
  name: 'd1_migrations',
  tbl_name: 'd1_migrations',
  sql: 'CREATE TABLE "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)',
});

const fail = code => { throw operationError(`PRODUCTION_TYPED_SCHEMA_${code}`); };
const safeObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function safeDirectory(path) {
  const absolute = resolve(path);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isDirectory() || await realpath(absolute).catch(() => null) !== absolute) fail('DIRECTORY_UNSAFE');
  return absolute;
}

async function readDirectoryInputs(workerRoot, directory) {
  const path = await safeDirectory(join(workerRoot, directory));
  const names = (await readdir(path)).filter(name => name.endsWith('.sql')).sort();
  if (names.length < 1 || names.length > 128 || names.some(name => !MIGRATION_NAME.test(name))) fail('INPUTS_INVALID');
  const inputs = [];
  for (const name of names) {
    const file = join(path, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_MIGRATION_BYTES
        || await realpath(file).catch(() => null) !== file) fail('INPUT_FILE_UNSAFE');
    const bytes = await readFile(file);
    if (bytes.length !== info.size || bytes.includes(0)) fail('INPUT_FILE_CHANGED');
    const sql = bytes.toString('utf8');
    if (!Buffer.from(sql).equals(bytes)) fail('INPUT_ENCODING_INVALID');
    inputs.push({ directory, name, bytes: bytes.length, sha256: storageSha256(bytes), sql });
  }
  return inputs;
}

function migrationRows(rows) {
  return rows.map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name }));
}

function validateSchemaRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4096) fail('SCHEMA_INVALID');
  const seen = new Set();
  for (const row of rows) {
    if (!safeObject(row) || !['table', 'index', 'trigger', 'view'].includes(row.type)
        || typeof row.name !== 'string' || typeof row.tbl_name !== 'string'
        || !(typeof row.sql === 'string' || row.sql === null)) fail('SCHEMA_INVALID');
    const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
    if (seen.has(key)) fail('SCHEMA_INVALID');
    seen.add(key);
  }
}

function applyInputs(db, inputs, split) {
  for (const input of inputs) {
    const statements = split(input.sql);
    if (!Array.isArray(statements) || statements.length < 1 || statements.length > MAX_STATEMENTS) fail('STATEMENT_LIMIT');
    try {
      for (const statement of statements) {
        const head = statement.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/u, '');
        if (/^(?:ATTACH|DETACH|VACUUM)\b/iu.test(head) || /\bload_extension\s*\(/iu.test(statement)) fail('CANONICAL_SQL_UNSAFE');
        db.exec(statement);
      }
    } catch {
      if (statementUnsafe(statements)) fail('CANONICAL_SQL_UNSAFE');
      fail('CANONICAL_SQL_INVALID');
    }
  }
}

function statementUnsafe(statements) {
  return statements.some(statement => {
    const head = statement.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/u, '');
    return /^(?:ATTACH|DETACH|VACUUM)\b/iu.test(head) || /\bload_extension\s*\(/iu.test(statement);
  });
}

/**
 * Build expected schema digests from a fresh local SQLite database populated
 * only by the candidate's canonical migration directories. This helper has no
 * Wrangler transport, credentials, remote database IDs, or live-query input.
 * The resulting object is safe to pass to runTypedProductionPreflight.
 */
export async function buildTypedProductionExpectedSchemas({ workerDirectory } = {}) {
  if (typeof workerDirectory !== 'string' || !workerDirectory.length) fail('ARGUMENTS');
  const root = await safeDirectory(workerDirectory);
  const require = createRequire(join(root, 'package.json'));
  let split;
  try {
    split = require('wrangler').unstable_splitSqlQuery;
  } catch {
    fail('WRANGLER_UNAVAILABLE');
  }
  if (typeof split !== 'function') fail('WRANGLER_UNAVAILABLE');

  const expectedSchemas = {};
  const inputSha256 = {};
  const migrationCounts = {};
  for (const role of ROLE_ORDER) {
    const inputs = [];
    for (const directory of TYPED_SCHEMA_INPUT_DIRECTORIES[role]) {
      inputs.push(...await readDirectoryInputs(root, directory));
    }
    if (!inputs.length) fail('INPUTS_INVALID');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      applyInputs(db, inputs, split);
      if (role === 'ledger') db.exec(WRANGLER_MIGRATION_LEDGER_SCHEMA.sql);
      const rows = db.prepare(TYPED_PRODUCTION_QUERIES.schema).all();
      validateSchemaRows(rows);
      expectedSchemas[role] = {
        schemaSha256: storageSchemaDigest(rows),
        requiredObjects: migrationRows(rows),
      };
    } finally {
      db.close();
    }
    const inputInventory = inputs.map(({ directory, name, bytes, sha256 }) => ({ directory, name, bytes, sha256 }));
    inputSha256[role] = identityDigest(inputInventory);
    migrationCounts[role] = inputs.length;
  }
  return {
    schema: 'production-typed-schema-v1',
    expectedSchemas,
    inputSha256,
    migrationCounts,
  };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--worker-root' || !argv[1] || argv[1].startsWith('--')) fail('ARGUMENTS');
  return { workerDirectory: argv[1] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await buildTypedProductionExpectedSchemas(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${/^PRODUCTION_TYPED_SCHEMA_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'PRODUCTION_TYPED_SCHEMA_FAILED'}\n`);
    process.exitCode = 1;
  }
}
