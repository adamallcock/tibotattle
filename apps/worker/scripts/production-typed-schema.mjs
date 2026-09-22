import { DatabaseSync } from 'node:sqlite';
import { createRequire, Module } from 'node:module';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import providerSchemas from '../src/d1-provider-schema.json' with { type: 'json' };
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { TYPED_PRODUCTION_QUERIES } from './production-typed-preflight.mjs';

const MAX_MIGRATION_BYTES = 240 * 1024;
const MIGRATION_NAME = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/u;
const MAX_STATEMENTS = 900;
const ROLE_ORDER = Object.freeze(['primary', 'analytics', 'ledger']);
const OPERATOR_SCHEMA_SOURCES = Object.freeze([
  Object.freeze({ path: 'src/authority-restore-schema.ts', kind: 'array', marker: 'AUTHORITY_RESTORE_SCHEMA' }),
  Object.freeze({ path: 'src/authority-restore-bootstrap.ts', kind: 'constant', marker: 'AUTHORITY_RESTORE_BOOTSTRAP_STATE_SCHEMA' }),
  Object.freeze({ path: 'src/authority-restore-bootstrap.ts', kind: 'constant', marker: 'AUTHORITY_RESTORE_BOOTSTRAP_ASSERT_SCHEMA' }),
  Object.freeze({ path: 'scripts/d1-storage-migration-worker.mjs', kind: 'constant', marker: 'MIGRATION_JOURNAL_DDL' }),
]);
const OPERATOR_OBJECT_NAMES = Object.freeze(new Set([
  '_authority_operator_progress',
  '_authority_restore_adoption',
  '_authority_restore_adoption_assert',
  '_authority_restore_bootstrap',
  '_authority_restore_bootstrap_assert',
  '_authority_restore_expected',
  '_authority_restore_installed_guards',
  '_authority_restore_pages',
  '_authority_restore_permission',
  '_authority_restore_run',
  '_authority_restore_tables',
  '_authority_restore_typed',
  '_authority_restore_descriptor_guard',
  '_authority_restore_page_commit',
  '_authority_restore_page_guard',
  '_authority_restore_run_guard',
  '_authority_restore_run_retained',
]));

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

async function restoredSchemaTransform(root) {
  try {
    const require = createRequire(join(root, 'package.json'));
    const result = await require('esbuild').build({
      absWorkingDir: root,
      stdin: { contents: "export { authorityRoleFinalSchema } from './src/authority-restore-role.ts'; export { typedEvidenceRestoreFinalSchema } from './src/authority-restore.ts';",
        resolveDir: root, sourcefile: 'typed-schema-transform.ts' },
      bundle: true, packages: 'external', platform: 'node', format: 'cjs',
      write: false, treeShaking: true, metafile: true, logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).filter(path => path !== 'typed-schema-transform.ts').sort();
    if (!inputs.length || inputs.length > 128 || inputs.some(path => !path.startsWith('src/') || path.includes('..'))) fail('RESTORE_SOURCE_INVALID');
    const sources = await Promise.all(inputs.map(path => readOperatorSource(root, path)));
    const code = result.outputFiles[0].text;
    if (Buffer.byteLength(code) > 1024 * 1024) fail('RESTORE_SOURCE_INVALID');
    const module = new Module(join(root, '__typed-schema-transform.cjs'));
    module.filename = join(root, '__typed-schema-transform.cjs');
    module.paths = Module._nodeModulePaths(root);
    module._compile(code, module.filename);
    if (typeof module.exports.authorityRoleFinalSchema !== 'function'
        || typeof module.exports.typedEvidenceRestoreFinalSchema !== 'function') {
      fail('RESTORE_SOURCE_INVALID');
    }
    return {
      transforms: {
        legacy: module.exports.authorityRoleFinalSchema,
        typedEvidence: module.exports.typedEvidenceRestoreFinalSchema,
      },
      sourceSha256: identityDigest({ bundle: storageSha256(code),
        sources: sources.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })) }) };
  } catch { fail('RESTORE_SOURCE_INVALID'); }
}

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

async function readOperatorSource(workerRoot, relativePath) {
  const file = join(workerRoot, relativePath);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_MIGRATION_BYTES
      || await realpath(file).catch(() => null) !== file) fail('OPERATOR_SOURCE_UNSAFE');
  const bytes = await readFile(file);
  if (bytes.length !== info.size || bytes.includes(0)) fail('OPERATOR_SOURCE_CHANGED');
  return { relativePath, bytes, text: bytes.toString('utf8'), sha256: storageSha256(bytes) };
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function providerSchemaPredicate() {
  return providerSchemas.map(provider => `(s.type=${sqlLiteral(provider.type)}
 AND s.name=${sqlLiteral(provider.name)} AND s.tbl_name=${sqlLiteral(provider.tbl_name)}
 AND s.sql=${sqlLiteral(provider.sql)} AND NOT EXISTS(
 SELECT 1 FROM sqlite_master provider_attached WHERE provider_attached.tbl_name=${sqlLiteral(provider.tbl_name)}
 AND provider_attached.name!=${sqlLiteral(provider.name)} AND provider_attached.sql IS NOT NULL))`).join(' OR ');
}

function sourceMarker(marker) {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueExportLiteral(source, marker, quote) {
  const expression = new RegExp(`^export\\s+const\\s+${sourceMarker(marker)}\\s*=\\s*${quote}([\\s\\S]*?)${quote}\\s*;`, 'gm');
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) fail('OPERATOR_SOURCE_EXPORT_INVALID');
  return matches[0][1];
}

function templateBody(source, marker) {
  return uniqueExportLiteral(source, marker, '`');
}

function singleQuotedBody(source, marker) {
  return uniqueExportLiteral(source, marker, "'");
}

function arrayTemplateBodies(source, marker) {
  const expression = new RegExp(`^export\\s+const\\s+${sourceMarker(marker)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, 'gm');
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) fail('OPERATOR_SOURCE_EXPORT_INVALID');
  const bodies = [];
  let remaining = matches[0][1];
  while (!/^\s*$/u.test(remaining)) {
    const literal = /^\s*`([^`]*)`\s*(?:,|$)/su.exec(remaining);
    if (!literal) fail('OPERATOR_SOURCE_ARRAY_INVALID');
    bodies.push(literal[1]);
    remaining = remaining.slice(literal[0].length);
  }
  if (!bodies.length) fail('OPERATOR_SOURCE_ARRAY_EMPTY');
  return bodies;
}

function operatorSqlDescriptor(sql) {
  const trimmed = sql.trim();
  const table = /^CREATE TABLE\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/iu.exec(trimmed);
  if (table) {
    const name = table[1] ?? table[2];
    return { type: 'table', name, tbl_name: name, sql: trimmed };
  }
  const trigger = /^CREATE TRIGGER\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))[\s\S]*?\bON\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/iu.exec(trimmed);
  if (trigger) {
    const name = trigger[1] ?? trigger[2];
    const tblName = trigger[3] ?? trigger[4];
    return { type: 'trigger', name, tbl_name: tblName, sql: trimmed };
  }
  fail('OPERATOR_SOURCE_SQL_INVALID');
}

/**
 * Read the exact operator metadata DDL from its maintained source modules.
 * These objects are optional because a fresh role has not necessarily entered
 * a restore operation. They are never inferred from a live schema or a live
 * object name list.
 */
export async function buildTypedProductionOperatorObjects({ workerDirectory } = {}) {
  if (typeof workerDirectory !== 'string' || !workerDirectory.length) fail('ARGUMENTS');
  const root = await safeDirectory(workerDirectory);
  const sources = await Promise.all(OPERATOR_SCHEMA_SOURCES.map(source => readOperatorSource(root, source.path)));
  const sourceByPath = new Map(sources.map(source => [source.relativePath, source]));
  const sql = [];
  for (const source of OPERATOR_SCHEMA_SOURCES) {
    const text = sourceByPath.get(source.path).text;
    if (source.kind === 'array') sql.push(...arrayTemplateBodies(text, source.marker));
    else if (source.marker === 'AUTHORITY_RESTORE_BOOTSTRAP_ASSERT_SCHEMA') sql.push(singleQuotedBody(text, source.marker));
    else sql.push(templateBody(text, source.marker));
  }
  const predicate = providerSchemaPredicate();
  const resolved = sql.map(value => value
    .replaceAll('${D1_PROVIDER_SCHEMA_PREDICATE}', predicate)
    .replaceAll('${TABLE}', '_authority_operator_progress'));
  if (resolved.some(value => value.includes('${'))) fail('OPERATOR_SOURCE_INTERPOLATION_UNRESOLVED');
  const objects = resolved.map(operatorSqlDescriptor).sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  const seen = new Set();
  for (const objectDescriptor of objects) {
    if (!OPERATOR_OBJECT_NAMES.has(objectDescriptor.name)) fail('OPERATOR_SOURCE_OBJECT_UNEXPECTED');
    const key = `${objectDescriptor.type}\u0000${objectDescriptor.name}\u0000${objectDescriptor.tbl_name}`;
    if (seen.has(key)) fail('OPERATOR_SOURCE_OBJECT_DUPLICATE');
    seen.add(key);
  }
  if (seen.size !== OPERATOR_OBJECT_NAMES.size
      || [...OPERATOR_OBJECT_NAMES].some(name => !objects.some(objectDescriptor => objectDescriptor.name === name))) {
    fail('OPERATOR_SOURCE_OBJECT_SET_INVALID');
  }
  return {
    schema: 'production-typed-operator-schema-v1',
    sourceSha256: identityDigest(sources.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes: bytes.length, sha256 }))),
    objects,
  };
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
  const operatorSchema = await buildTypedProductionOperatorObjects({ workerDirectory: root });
  const restored = await restoredSchemaTransform(root);
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
        optionalObjects: role === 'primary' ? operatorSchema.objects : [],
      };
      if (role === 'primary') {
        const transformed = restored.transforms.legacy(rows);
        validateSchemaRows(transformed);
        const variants = [storageSchemaDigest(transformed)];
        // Also support the maintained forward extension of a restored role:
        // migration 0061 creates its table after the restore has finished.
        // Derive that table's exact SQL from the migration itself, never live DDL.
        const extension = inputs.find(input => input.directory === 'migrations'
          && input.name === '0061_accountless_history_retention.sql');
        if (extension) {
          const extensionDb = new DatabaseSync(':memory:');
          try {
            applyInputs(extensionDb, [extension], split);
            const additions = extensionDb.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table'").all();
            if (additions.length !== 1 || additions[0].name !== 'accountless_public_history_retention') fail('RESTORE_EXTENSION_INVALID');
            const addition = additions[0];
            if (!rows.some(row => row.type === 'table' && row.name === addition.name && row.sql === addition.sql)) fail('RESTORE_EXTENSION_INVALID');
            variants.push(storageSchemaDigest(transformed.map(row => row.type === 'table' && row.name === addition.name
              ? { ...row, sql: addition.sql } : row)));
          } finally { extensionDb.close(); }
        }
        // A correction-bearing source may use the typed-evidence restore
        // contract. That contract preserves every application table and
        // applies SQLite's exact final-schema quoting to all table DDL,
        // including the v1.2 and performance tables that the legacy authority
        // transform deliberately leaves outside its retained set.
        if (rows.some(row => row.name.startsWith('telemetry_usage_correction_'))) {
          const typedEvidence = restored.transforms.typedEvidence(rows);
          validateSchemaRows(typedEvidence);
          variants.push(storageSchemaDigest(typedEvidence));
        }
        expectedSchemas.primary.restoredSchemaSha256 = [...new Set(variants)];
      }
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
    operatorSchemaSourceSha256: identityDigest({ operator: operatorSchema.sourceSha256,
      restored: restored.sourceSha256, variants: expectedSchemas.primary.restoredSchemaSha256 }),
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
