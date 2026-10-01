import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_MIGRATION = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/u;
const REPAIR_SQL = `CREATE TRIGGER IF NOT EXISTS ingestion_analytics_payload_refusal_01 BEFORE INSERT ON community_analysis_work_parts
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER IF NOT EXISTS ingestion_analytics_payload_refusal_15 BEFORE INSERT ON community_model_history_work_parts
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
`;
const REPAIR_NAMES = Object.freeze([
  'ingestion_analytics_payload_refusal_01',
  'ingestion_analytics_payload_refusal_15',
]);
const ISOLATED_DIRECTORIES = Object.freeze([
  'typed-ingestion-migrations',
  'ingestion-bridge-migrations',
  'typed-v11-admission-migrations',
  'typed-v1-admission-migrations',
  'ingestion-isolation-migrations',
]);

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { throw new Error(`PRODUCTION_TRIGGER_REPAIR_${message}`); };

async function migrationFiles(directory) {
  const names = (await readdir(join(directory))).filter(name => ROOT_MIGRATION.test(name)).sort();
  if (!names.length) fail('MIGRATIONS_MISSING');
  return names.map(name => join(directory, name));
}

function sqlSplitter(workerRoot) {
  const require = createRequire(join(workerRoot, 'package.json'));
  const split = require('wrangler').unstable_splitSqlQuery;
  if (typeof split !== 'function') fail('WRANGLER_UNAVAILABLE');
  return split;
}

async function applyFile(db, file, split) {
  const sql = await readFile(file, 'utf8');
  const statements = split(sql);
  if (!Array.isArray(statements) || statements.length < 1) fail('MIGRATION_EMPTY');
  for (const statement of statements) db.exec(statement);
}

async function applyFiles(db, files, split) {
  for (const file of files) await applyFile(db, file, split);
}

async function applySourceOrder(db, workerRoot, order, split) {
  for (const directory of order) {
    await applyFiles(db, await migrationFiles(join(workerRoot, directory)), split);
  }
}

function schemaObjects(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all();
}

function triggerSql(db, name) {
  return db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(name)?.sql ?? null;
}

function tableRows(db, table, orderBy) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

function seedSyntheticRows(db) {
  const now = '2026-01-01T00:00:00.000Z';
  const participant = 'synthetic-trigger-repair';
  const fingerprint = 'a'.repeat(64);
  db.exec(`INSERT INTO participants (id,access_token_id,access_token_hash,recovery_token_id,
    recovery_token_hash,state,consent_version,consented_at,created_at)
    VALUES ('${participant}','synthetic-access',zeroblob(32),'synthetic-recovery',zeroblob(32),
    'active','privacy-safe-telemetry-v0.1','${now}','${now}')`);
  const revision = db.prepare('SELECT revision FROM community_analytical_input_versions WHERE participant_id=?')
    .get(participant)?.revision ?? 0;
  // The out-of-order state retains the parent refusal guard. Temporarily
  // suspend only that guard to create a content-free parent fixture, then
  // restore it before exercising the candidate repair.
  db.exec('DROP TRIGGER ingestion_analytics_payload_refusal_00');
  db.prepare(`INSERT INTO community_analysis_work (participant_id,run_id,input_revision,input_fingerprint,
    source_kind,source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,window_minutes,
    max_quota_rows,phase,progress_revision,control_json,manifest_json,state_sha256)
    VALUES (?, ?, ?, ?, 'v1', 'synthetic-trigger-repair', ?, ?, ?, 10080, 60000, 'plan', 0, '{}', '[]', ?)`)
    .run(participant, 'synthetic-analysis-run', revision, fingerprint, now,
      '2025-12-01T00:00:00.000Z', '2025-12-08T00:00:00.000Z', fingerprint);
  db.exec(`CREATE TRIGGER ingestion_analytics_payload_refusal_00 BEFORE INSERT ON community_analysis_work
    BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END`);
  db.prepare(`INSERT INTO community_analysis_work_parts
    (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
    VALUES (?,?,'plan-anchors','[]',?,2)`)
    .run(participant, 'synthetic-analysis-run', 'b'.repeat(64));
  db.exec('DROP TRIGGER ingestion_analytics_payload_refusal_14');
  db.prepare(`INSERT INTO community_model_history_work (participant_id,run_id,input_revision,input_fingerprint,
    source_kind,source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,window_minutes,
    max_quota_rows,phase,progress_revision,control_json,manifest_json,state_sha256)
    VALUES (?, ?, ?, ?, 'v1', 'synthetic-trigger-repair', ?, ?, ?, 10080, 60000, 'plan', 0, '{}', '[]', ?)`)
    .run(participant, 'synthetic-history-run', revision, fingerprint, now,
      '2025-12-01T00:00:00.000Z', '2025-12-08T00:00:00.000Z', fingerprint);
  db.exec(`CREATE TRIGGER ingestion_analytics_payload_refusal_14 BEFORE INSERT ON community_model_history_work
    BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END`);
  db.prepare(`INSERT INTO community_model_history_work_parts
    (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
    VALUES (?,?,'plan-anchors','[]',?,2)`)
    .run(participant, 'synthetic-history-run', 'c'.repeat(64));
  db.exec(`CREATE TRIGGER synthetic_repair_sentinel BEFORE UPDATE ON community_analysis_work
    WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'synthetic_repair_sentinel'); END`);
  return participant;
}

function snapshot(db) {
  return {
    analysis: tableRows(db, 'community_analysis_work', 'participant_id'),
    analysisParts: tableRows(db, 'community_analysis_work_parts', 'participant_id,run_id,component,payload_sha256'),
    history: tableRows(db, 'community_model_history_work', 'participant_id'),
    historyParts: tableRows(db, 'community_model_history_work_parts', 'participant_id,run_id,component,payload_sha256'),
  };
}

function assertEqual(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
}

function assertRepairGuards(db) {
  const expected = REPAIR_SQL.trim().split(/;\n(?=CREATE TRIGGER)/u)
    .map(sql => sql.replace(' IF NOT EXISTS', '').replace(/;$/u, ''));
  for (const name of REPAIR_NAMES) {
    const sql = triggerSql(db, name);
    if (!sql || !expected.includes(sql)) {
      fail(`REPAIR_SQL_MISMATCH_${name}`);
    }
  }
  return REPAIR_NAMES.length;
}

function assertRefused(db, sql, expectedMessage = 'analytics_write_requires_separate_database') {
  try {
    db.exec(sql);
  } catch (error) {
    if (String(error?.message).includes(expectedMessage)) return;
    fail('UNEXPECTED_REFUSAL');
  }
  fail('WRITE_NOT_REFUSED');
}

/**
 * Rehearse the source-supported failure ordering and a forward-only, local
 * repair. This function never loads credentials, contacts Cloudflare, or
 * reads live data. The returned evidence is synthetic and content-free.
 */
export async function runProductionTriggerRepairRehearsal({ workerRoot = sourceRoot } = {}) {
  const root = resolve(workerRoot);
  const split = sqlSplitter(root);
  const roots = await migrationFiles(join(root, 'migrations'));
  const migration0062 = roots.findIndex(file => file.endsWith('0062_v1_acquisition_vocabulary.sql'));
  if (migration0062 < 1) fail('MIGRATION_0062_MISSING');

  async function reproduce(order) {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys=ON');
    try {
      if (order === 'isolation-then-0062') {
        await applyFiles(database, roots.filter(file => file.endsWith('.sql') && !file.endsWith('0062_v1_acquisition_vocabulary.sql')), split);
        await applySourceOrder(database, root, ISOLATED_DIRECTORIES, split);
        const before0062 = REPAIR_NAMES.map(name => Boolean(triggerSql(database, name)));
        await applyFile(database, roots.find(file => file.endsWith('0062_v1_acquisition_vocabulary.sql')), split);
        const after0062 = REPAIR_NAMES.map(name => Boolean(triggerSql(database, name)));
        const participant = seedSyntheticRows(database);
        const before = snapshot(database);
        const sentinelBefore = Boolean(triggerSql(database, 'synthetic_repair_sentinel'));
        database.exec(REPAIR_SQL);
        database.exec(REPAIR_SQL);
        const after = snapshot(database);
        assertEqual(after, before, 'DATA_CHANGED');
        if (!sentinelBefore || !triggerSql(database, 'synthetic_repair_sentinel')) fail('UNRELATED_TRIGGER_LOST');
        assertRepairGuards(database);
        assertRefused(database, `INSERT INTO community_analysis_work_parts
          (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
          VALUES ('${participant}','synthetic-analysis-run','plan-runs','[]','${'d'.repeat(64)}',2)`);
        assertRefused(database, `INSERT INTO community_model_history_work_parts
          (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
          VALUES ('${participant}','synthetic-history-run','plan-runs','[]','${'e'.repeat(64)}',2)`);
        assertRefused(database, `UPDATE community_analysis_work SET phase='complete' WHERE participant_id='${participant}'`, 'synthetic_repair_sentinel');
        const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
        assertEqual(foreignKeys, [], 'FOREIGN_KEY_CHECK');
        return { before0062, after0062, before, after, foreignKeys, repairAppliedTwice: true };
      }
      await applyFiles(database, roots, split);
      await applySourceOrder(database, root, ISOLATED_DIRECTORIES, split);
      return { canonicalGuards: REPAIR_NAMES.map(name => Boolean(triggerSql(database, name))) };
    } finally {
      database.close();
    }
  }

  const outOfOrder = await reproduce('isolation-then-0062');
  const canonical = await reproduce('0062-then-isolation');
  return {
    schema: 'production-trigger-repair-rehearsal-v1',
    repairSqlSha256: createHash('sha256').update(REPAIR_SQL).digest('hex'),
    repairTriggerNames: REPAIR_NAMES,
    outOfOrder: {
      guardsPresentBefore0062: outOfOrder.before0062,
      guardsPresentAfter0062: outOfOrder.after0062,
      dataPreserved: JSON.stringify(outOfOrder.before) === JSON.stringify(outOfOrder.after),
      foreignKeysClean: outOfOrder.foreignKeys.length === 0,
      repairAppliedTwice: outOfOrder.repairAppliedTwice,
    },
    canonical: canonical,
    productionWritesPerformed: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionTriggerRepairRehearsal().then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; });
}
