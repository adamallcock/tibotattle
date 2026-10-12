#!/usr/bin/env node
// Rebuild a GCP fast-path oracle D1 dump (test/__snapshots__/gcp-fastpath/dump/*.json)
// into a self-contained SQLite file with node:sqlite, check it, and emit the
// seal receipt that createSealedSqliteTypedLegacyRehearsalSource
// (apps/worker/scripts/postgres-typed-legacy-transfer.mjs on the GCP line)
// requires before it will open a sealed rehearsal source:
//
//   - an absolute, symlink-free path to a regular, owner-owned, single-link file;
//   - no write permission bits (0444) and no -wal/-shm/-journal sidecars;
//   - a non-WAL journal mode and PRAGMA quick_check(1) = 'ok';
//   - every table in its SEALED_SOURCE_TABLES layout;
//   - expectedSha256 equal to the SHA-256 of the exact file bytes.
//
// Usage (Node 22.13 or later):
//   node scripts/gcp-fastpath-oracle-sqlite.mjs <dump.json> <out.sqlite> [--receipt <receipt.json>] [--no-seal]
//   node scripts/gcp-fastpath-oracle-sqlite.mjs --privacy <corpus.json|dump.json>...
//
// The output must not exist. Rows are inserted with the dump's CREATE TABLE
// statements first; indexes, views and triggers are created only after every
// row is loaded, so insert triggers never fire on restored rows.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors SEALED_SOURCE_TABLES at claude/gcp-parity-integration cfd7dc39.
export const SEALED_SOURCE_TABLES = Object.freeze([
  'typed_telemetry_dictionary', 'typed_telemetry_namespaces', 'typed_telemetry_owners',
  'typed_telemetry_devices', 'typed_telemetry_manifests', 'typed_telemetry_identifiers',
  'typed_telemetry_attributions', 'typed_telemetry_quota_dimensions', 'typed_telemetry_chunks',
  'typed_telemetry_records', 'typed_telemetry_usage', 'typed_telemetry_quota', 'typed_telemetry_session_tools',
  'typed_v1_owner_memberships', 'typed_v11_owner_memberships', 'typed_v1_admission_state',
  'typed_v11_admission_state', 'participants', 'storage_v11_owner_links',
]);

function usage(message) {
  process.stderr.write(`${message}\nusage: node scripts/gcp-fastpath-oracle-sqlite.mjs <dump.json> <out.sqlite> [--receipt <receipt.json>] [--no-seal]\n`);
  process.exit(2);
}

function decode(cell) {
  if (cell === null || typeof cell === 'string' || typeof cell === 'number') return cell;
  if (typeof cell === 'object' && typeof cell.$blob === 'string' && /^(?:[0-9a-f]{2})*$/u.test(cell.$blob)) {
    return Buffer.from(cell.$blob, 'hex');
  }
  if (typeof cell === 'object' && typeof cell.$real === 'number') return cell.$real;
  throw new Error('GCP_ORACLE_DUMP_CELL_INVALID');
}

export function rebuildOracleSqlite(dumpPath, outPath, { seal = true } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('GCP_ORACLE_NODE_TOO_OLD');
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!dump || !Array.isArray(dump.schema) || !Array.isArray(dump.tables)) throw new Error('GCP_ORACLE_DUMP_INVALID');
  const out = resolve(outPath);
  if (existsSync(out)) throw new Error('GCP_ORACLE_OUTPUT_EXISTS');
  const database = new DatabaseSync(out);
  const expected = new Map();
  try {
    database.exec('PRAGMA journal_mode=DELETE');
    database.exec('PRAGMA foreign_keys=OFF');
    const tables = new Map(dump.tables.map((table) => [table.name, table]));
    // Every table in the schema exists in the rebuild, populated or not.
    const declared = dump.schema.filter((entry) => entry.type === 'table');
    database.exec('BEGIN');
    for (const entry of declared) database.exec(entry.sql);
    for (const table of dump.tables) {
      if (!declared.some((entry) => entry.name === table.name)) throw new Error('GCP_ORACLE_DUMP_TABLE_UNDECLARED');
      const columns = table.columns.map((column) => `"${String(column).replaceAll('"', '""')}"`);
      const insert = database.prepare(`INSERT INTO "${table.name.replaceAll('"', '""')}" (${columns.join(',')})
        VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of table.rows) {
        if (!Array.isArray(row) || row.length !== columns.length) throw new Error('GCP_ORACLE_DUMP_ROW_INVALID');
        insert.run(...row.map(decode));
      }
      if (table.rows.length !== table.rowCount) throw new Error('GCP_ORACLE_DUMP_ROW_COUNT_INVALID');
      expected.set(table.name, table.rowCount);
    }
    if (Array.isArray(dump.sqliteSequence) && dump.sqliteSequence.length > 0) {
      const present = database.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get();
      if (present) {
        const upsert = database.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
        database.exec('DELETE FROM sqlite_sequence');
        for (const { name, seq } of dump.sqliteSequence) upsert.run(name, seq);
      }
    }
    for (const kind of ['index', 'view', 'trigger']) {
      for (const entry of dump.schema.filter((item) => item.type === kind)) database.exec(entry.sql);
    }
    database.exec('COMMIT');
    for (const name of tables.keys()) {
      const actual = Number(database.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
      if (actual !== expected.get(name)) throw new Error(`GCP_ORACLE_ROW_COUNT_MISMATCH:${name}`);
    }
    const integrity = database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const quick = database.prepare('PRAGMA quick_check(1)').get().quick_check;
    const journalMode = database.prepare('PRAGMA journal_mode').get().journal_mode;
    const allTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    database.close();
    const missingSealedTables = SEALED_SOURCE_TABLES.filter((name) => !allTables.has(name));
    if (seal) chmodSync(out, 0o444);
    const stat = lstatSync(out);
    const bytes = readFileSync(out);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const receipt = {
      schemaVersion: 'gcp-fastpath-oracle-sqlite-receipt-v1',
      dump: { header: dump.header ?? null, sha256: createHash('sha256').update(readFileSync(dumpPath)).digest('hex') },
      path: realpathSync(out),
      bytes: stat.size,
      sha256,
      expectedSha256: sha256,
      integrityCheck: integrity.length === 1 ? integrity[0] : integrity,
      quickCheck: quick,
      journalMode,
      sidecars: ['-wal', '-shm', '-journal'].filter((suffix) => existsSync(out + suffix)),
      mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
      writable: (stat.mode & 0o222) !== 0,
      nlink: stat.nlink,
      ownedByCurrentUser: typeof process.getuid === 'function' && stat.uid === process.getuid(),
      tables: Object.fromEntries([...expected.entries()].sort(([a], [b]) => a.localeCompare(b))),
      populatedTables: expected.size,
      declaredTables: allTables.size,
      sealedSourceTables: { required: SEALED_SOURCE_TABLES.length, missing: missingSealedTables },
      createSealedSqliteTypedLegacyRehearsalSource: { path: realpathSync(out), expectedSha256: sha256 },
      sealReady: integrity.length === 1 && integrity[0] === 'ok' && quick === 'ok' && journalMode !== 'wal'
        && (stat.mode & 0o222) === 0 && stat.nlink === 1 && missingSealedTables.length === 0
        && isAbsolute(realpathSync(out)),
    };
    return receipt;
  } catch (error) {
    try { database.close(); } catch { /* already closed */ }
    throw error;
  }
}

// ------------------------------------------------------------- privacy --
// Every JSON key in the corpus must be a closed telemetry/corpus key, and no
// string value (in the corpus or in any dumped row) may carry a path
// separator, an email address or prompt-like free text. Schema SQL and the
// MIME type of synthetic upload grants are the only allowlisted exceptions.
const CORPUS_KEYS = new Set([
  // corpus envelope and owner metadata
  'schemaVersion', 'sourceCommit', 'generator', 'seed', 'synthetic', 'window', 'fromDay', 'throughDay', 'days',
  'pinnedNow', 'correctionRuntimeState', 'conflict', 'duplicate', 'owner', 'occurrenceId', 'formats', 'day',
  'v1AdmittedAfterV11Domain', 'v1AdmittedBeforeV11Domain', 'recordCounts', 'quota', 'session', 'usage', 'owners',
  'key', 'kind', 'participantId', 'pinnedOwnerDigest', 'planType', 'accountTrackId', 'models',
  'capacitiesUsdPerWindow', 'resetWeekdayUtc', 'storage', 'v11', 'v12', 'v1ConflictChunk', 'v1DuplicateChunk',
  'format', 'records', 'v1Extra', 'shards', 'dayCount',
  // closed telemetry record keys (v1.0 / v1.1 / v1.2)
  'eventId', 'eventTime', 'sessionUuid', 'provider', 'modelId', 'speedMode', 'apiServiceTier', 'surface',
  'billingSurface', 'reasoningEffort', 'agentScope', 'outcome', 'totalInputContextTokens', 'components',
  'inputUncachedTokens', 'inputCacheReadTokens', 'inputCacheWriteTokens', 'outputTextTokens',
  'outputReasoningTokens', 'outputCombinedTokens', 'accountPlanAttribution', 'accountBasis', 'planBasis',
  'planEraId', 'observationId', 'observedTime', 'planVariant', 'limitId', 'slot', 'usedPercent',
  'windowDurationMinutes', 'resetsAt', 'firstEventTime', 'toolClassCounts', 'localShell', 'web', 'other',
  'boundaryFlags', 'tieOrder', 'cacheWriteTtl',
]);
const MODEL_KEY = /^(?:gpt-[0-9a-z.-]+|\d{4}-\d{2}-\d{2}|[a-d])$/u; // model ids, UTC days, owner keys
const PATH = /[\\/]/u;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const FREE_TEXT = /\s\S+\s\S+/u; // three or more whitespace-separated words
// Display names from the reviewed model catalog (telemetry-contract), carried
// verbatim by the published allowance preview; product vocabulary, not content.
const REVIEWED_TEXT = /\.modelConfig\[\d+\]\.label$/u;
// A dumped column whose name suggests session content must hold no strings.
const PROMPT_COLUMNS = /prompt|message|command|cwd|path|file|title|body|email|transcript/iu;

export function privacyScan(paths) {
  const findings = [];
  const visit = (value, where, keyed) => {
    if (typeof value === 'string') {
      if (PATH.test(value)) findings.push({ where, issue: 'path_separator' });
      if (EMAIL.test(value)) findings.push({ where, issue: 'email' });
      if (FREE_TEXT.test(value) && !REVIEWED_TEXT.test(where)) findings.push({ where, issue: 'free_text' });
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${where}[${index}]`, keyed)); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (keyed && !CORPUS_KEYS.has(key) && !MODEL_KEY.test(key)) findings.push({ where: `${where}.${key}`, issue: 'key_not_allowlisted' });
        visit(item, `${where}.${key}`, keyed);
      }
    }
  };
  const summary = [];
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const before = findings.length;
    if (Array.isArray(parsed.tables)) {
      // A D1 dump: scan every row value. Schema SQL is reviewed migration text.
      let cells = 0;
      for (const table of parsed.tables) {
        table.rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
          cells++;
          const name = table.columns[column];
          if (name === 'content_type' && cell === 'application/json') return; // synthetic upload grant MIME type
          if (typeof cell === 'string' && name === 'sql') return;
          if (typeof cell === 'string' && PROMPT_COLUMNS.test(name)) findings.push({ where: `${table.name}.${name}`, issue: 'prompt_like_column' });
          // JSON-valued cells (published payloads, authority pins) are scanned structurally.
          if (typeof cell === 'string' && /^[[{]/u.test(cell)) {
            try { visit(JSON.parse(cell), `${table.name}[${rowIndex}].${name}`, false); return; } catch { /* plain text */ }
          }
          visit(cell, `${table.name}[${rowIndex}].${name}`, false);
        }));
      }
      visit(parsed.header, 'header', false);
      summary.push({ path, kind: 'dump', tables: parsed.tables.length, cells, findings: findings.length - before });
    } else {
      visit(parsed, '$', true);
      summary.push({ path, kind: 'corpus', findings: findings.length - before });
    }
  }
  return { ok: findings.length === 0, summary, findings: findings.slice(0, 50), findingCount: findings.length };
}

// Compare decoded, resolved filesystem paths: import.meta.url is percent-encoded,
// so a URL built from argv[1] by hand never matches a path with a space, '%',
// '#' or non-ASCII character, and the CLI would exit 0 having done nothing.
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}
const CLI = invokedAsCli();

if (CLI && process.argv[2] === '--privacy') {
  const result = privacyScan(process.argv.slice(3));
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (CLI && process.argv[2] !== '--privacy') {
  const args = process.argv.slice(2);
  const receiptIndex = args.indexOf('--receipt');
  const receiptPath = receiptIndex < 0 ? null : args[receiptIndex + 1];
  if (receiptIndex >= 0 && !receiptPath) usage('missing --receipt path');
  const seal = !args.includes('--no-seal');
  const positional = args.filter((arg, index) => !arg.startsWith('--') && (receiptIndex < 0 || index !== receiptIndex + 1));
  if (positional.length !== 2) usage('expected <dump.json> <out.sqlite>');
  const [dumpPath, outPath] = positional;
  if (!existsSync(dirname(resolve(outPath)))) usage('output directory does not exist');
  try {
    const receipt = rebuildOracleSqlite(dumpPath, outPath, { seal });
    if (receiptPath) writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({ integrity_check: receipt.integrityCheck, sha256: receipt.sha256,
      bytes: receipt.bytes, populatedTables: receipt.populatedTables, sealReady: receipt.sealReady,
      missingSealedTables: receipt.sealedSourceTables.missing })}\n`);
    process.exit(receipt.integrityCheck === 'ok' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
