import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildCompletionFunnelPlan, parseArguments, MAX_INPUT_ROWS } from './contribution-completion-funnel.mjs';

const options = { from: '2026-09-21T00:00:00.000Z', until: '2026-09-22T00:00:00.000Z', v12: 'absent' };
const sourceBinding = 'STORAGE_INGESTION_DB';
const plan = (changes = {}) => buildCompletionFunnelPlan({ ...options, ...changes });
const query = (name, changes = {}) => plan(changes).queries.find((entry) => entry.name === name).sql;
const row = (db, name, changes) => ({ ...db.prepare(query(name, changes)).get() });

function syntheticSource() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE telemetry_transport_formats(schema_version TEXT,format_rank INTEGER);
 INSERT INTO telemetry_transport_formats VALUES('telemetry-contribution-v1.0',10),('telemetry-contribution-v1.1',11);
 CREATE TABLE community_public_source_owners(participant_id TEXT);
 CREATE TABLE telemetry_v1_chunks(participant_id TEXT,created_at TEXT,chunk_day TEXT);
 CREATE TABLE telemetry_v11_chunks(participant_id TEXT,created_at TEXT,chunk_day TEXT,manifest_id TEXT);
 CREATE TABLE telemetry_v11_day_manifests(id TEXT,state TEXT);
 CREATE TABLE telemetry_v11_domains(id TEXT,participant_id TEXT,created_at TEXT);
 CREATE TABLE telemetry_v11_domain_heads(participant_id TEXT,generation_id TEXT);
 CREATE TABLE telemetry_v11_domain_days(generation_id TEXT,manifest_id TEXT);`);
  return db;
}

test('bounds and CLI options refuse ambiguity, injection, invalid dates and windows', () => {
  for (const changes of [{ from: "2026-09-21';DROP TABLE x;--" }, { from: '2026-02-30T00:00:00.000Z' },
    { until: options.from }, { from: '2026-01-01T00:00:00.000Z' }, { v12: undefined }, { v12: 'auto' }]) {
    assert.throws(() => plan(changes));
  }
  assert.throws(() => parseArguments(['--remote', 'true']));
  assert.throws(() => parseArguments(['--v12', 'absent', '--v12', 'present']));
  assert.deepEqual(plan({ until: '2026-09-22T01:00:00.000Z' }).observedDays,
    { from: '2026-09-21', until: '2026-09-23' });
  for (const entry of plan().queries) {
    assert.match(entry.sql, /^(SELECT|WITH) /u);
    assert.doesNotMatch(entry.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|PRAGMA)\b/iu);
    assert.equal(entry.maxResultRows, 1);
  }
});

test('receipt time is independent of activity day; staged, old and active domains stay distinct', () => {
  const db = syntheticSource();
  try {
    db.exec(`INSERT INTO telemetry_v11_chunks VALUES
 ('synthetic-active','2026-09-21T10:00:00.000Z','2026-01-01','m-old'),
 ('synthetic-active','2026-09-21T11:00:00.000Z','2026-09-21','m-active'),
 ('synthetic-staged','2026-09-21T12:00:00.000Z','2026-09-20','m-staged'),
 ('synthetic-outside','2026-09-22T00:00:00.000Z','2026-09-22','m-outside');
 INSERT INTO telemetry_v11_day_manifests VALUES('m-old','ready'),('m-active','ready'),('m-staged','staged');
 INSERT INTO telemetry_v11_domain_heads VALUES('synthetic-active','g-active');
 INSERT INTO telemetry_v11_domain_days VALUES('g-active','m-active');
 INSERT INTO community_public_source_owners VALUES('synthetic-active');
 INSERT INTO telemetry_v11_domains VALUES('g-active','synthetic-active','2026-09-21T10:00:00.000Z'),
 ('g-old','synthetic-active','2026-09-21T09:00:00.000Z');`);
    assert.deepEqual(row(db, 'v11_receipts'), { status: 'ok', received_chunks: 3, receiving_owners: 2,
      latest_receipt_at: '2026-09-21T12:00:00.000Z', latest_chunk_day: '2026-09-21',
      owners_with_public_source_authority: 1, owners_without_current_domain: 1,
      chunks_outside_current_domain: 2, chunks_with_staged_manifest: 1 });
    assert.equal(row(db, 'v11_domains_created').domains_not_current, 1);
    assert.equal(row(db, 'v1_receipts').latest_chunk_day, null);
  } finally { db.close(); }
});

test('caps fail closed without reporting a truncated cohort as zero or complete', () => {
  const db = syntheticSource();
  try {
    const insert = db.prepare('INSERT INTO telemetry_v1_chunks VALUES(?,?,?)');
    for (let i = 0; i <= MAX_INPUT_ROWS; i++) insert.run('synthetic', '2026-09-21T12:00:00.000Z', '2026-09-21');
    const result = row(db, 'v1_receipts');
    assert.equal(result.status, 'unavailable_row_limit');
    assert.ok(Object.entries(result).filter(([key]) => key !== 'status').every(([, value]) => value === null));
  } finally { db.close(); }
});

test('missing schema, changed versions and incorrectly declared absent v1.2 cannot look empty', () => {
  const db = syntheticSource();
  try {
    assert.throws(() => row(db, 'source_contract', { v12: 'present' }));
    db.exec("UPDATE telemetry_transport_formats SET schema_version='unknown' WHERE format_rank=11");
    assert.equal(row(db, 'v1_receipts').status, 'unavailable_contract');
    assert.equal(row(db, 'v1_receipts').received_chunks, null);
    db.exec("UPDATE telemetry_transport_formats SET schema_version='telemetry-contribution-v1.1' WHERE format_rank=11; CREATE TABLE telemetry_v12_runtime(id INTEGER)");
    assert.equal(row(db, 'source_contract').status, 'unavailable_contract');
    db.exec('DROP TABLE telemetry_v11_chunks');
    assert.throws(() => row(db, 'v11_receipts'));
  } finally { db.close(); }
});

function createMigrationTable(db, migration, table) {
  const text = readFileSync(new URL(`../${migration}`, import.meta.url), 'utf8');
  const ddl = text.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\) STRICT(?:, WITHOUT ROWID)?;`, 'u'))?.[0];
  assert.ok(ddl, `Missing actual migration table ${table}`);
  db.exec(ddl);
}

test('all SELECTs compile and execute against actual migration table declarations including v1.2', () => {
  const source = new DatabaseSync(':memory:');
  const analytics = new DatabaseSync(':memory:');
  try {
    source.exec('PRAGMA foreign_keys=OFF'); analytics.exec('PRAGMA foreign_keys=OFF');
    for (const [migration, tables] of [
      ['migrations/0031_incremental_contribution_v1.sql', ['telemetry_v1_chunks']],
      ['migrations/0044_attribution_transport_staging.sql', ['telemetry_transport_formats', 'telemetry_v11_chunks', 'telemetry_v11_day_manifests']],
      ['migrations/0045_attribution_domain_activation.sql', ['telemetry_v11_domains', 'telemetry_v11_domain_heads', 'telemetry_v11_domain_days']],
      ['ingestion-isolation-migrations/0008_telemetry_v12.sql', ['telemetry_v12_runtime', 'telemetry_v12_chunks', 'telemetry_v12_day_manifests', 'telemetry_v12_domains', 'telemetry_v12_domain_heads', 'telemetry_v12_domain_days']],
    ]) for (const table of tables) createMigrationTable(source, migration, table);
    // Authority view is supplied synthetically: this test does not bypass or
    // claim to qualify its production authorization joins.
    source.exec('CREATE TABLE community_public_source_owners(participant_id TEXT)');
    source.exec("INSERT INTO telemetry_transport_formats VALUES('telemetry-contribution-v1.0',10,'accepted'),('telemetry-contribution-v1.1',11,'accepted')");
    source.exec(`INSERT INTO telemetry_v12_runtime VALUES(1,'telemetry-contribution-v1.2','telemetry-envelope-v1.2',
 'telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2','staged',1,4096,200,64000000,'2026-09-21T00:00:00.000Z')`);
    for (const [migration, tables] of [
      ['analytics-migrations/0006_runtime_source_contract.sql', ['analytics_runtime_sources']],
      ['analytics-migrations/0002_v11_daily_projection.sql', ['analytics_v11_projection_work', 'analytics_v11_owner_heads']],
      ['analytics-migrations/0005_v1_daily_projection.sql', ['analytics_v1_chunk_values']],
      ['analytics-migrations/0024_effective_owner_daily_cursor.sql', ['analytics_community_daily_owners']],
      ['analytics-migrations/0007_community_daily_publication.sql', ['analytics_community_daily_heads', 'analytics_community_daily_publications', 'analytics_community_daily_queue']],
    ]) for (const table of tables) createMigrationTable(analytics, migration, table);
    analytics.exec("INSERT INTO analytics_runtime_sources VALUES('synthetic-source','synthetic-namespace',1)");
    for (const entry of plan({ v12: 'present' }).queries) {
      const result = (entry.binding === sourceBinding ? source : analytics).prepare(entry.sql).get();
      assert.equal(result.status, 'ok', entry.name);
      assert.ok(Object.values(result).every((value) => value === null || typeof value === 'number' || ['ok', 'staged'].includes(value)));
    }
    analytics.exec(`INSERT INTO analytics_community_daily_owners VALUES
 ('synthetic-source','2026-09-21','owner-a',1,1,'effective','synthetic',1,0,NULL,1,'{}'),
 ('synthetic-source','2026-09-21','owner-b',1,1,'v11','synthetic',1,0,NULL,0,'{}'),
 ('synthetic-source','2026-09-20','owner-c',1,1,'v1','synthetic',1,0,NULL,1,'{}');
 INSERT INTO analytics_community_daily_heads VALUES('synthetic-source','2026-09-21',2,'cohort');
 INSERT INTO analytics_community_daily_publications VALUES
 ('synthetic-source','2026-09-21',1,'cohort','{}','{}','digest','2026-09-21T01:00:00.000Z'),
 ('synthetic-source','2026-09-21',2,'cohort','{}','{}','digest','2026-09-22T02:00:00.000Z');
 INSERT INTO analytics_community_daily_queue VALUES('synthetic-source','2026-09-21',3);`);
    assert.deepEqual(row(analytics, 'daily_owner_projection'), { status: 'ok', owner_days: 2,
      complete_owner_days: 1, incomplete_owner_days: 1, effective_owner_days: 1, latest_observed_day: '2026-09-21' });
    assert.deepEqual(row(analytics, 'daily_publication'), { status: 'ok', published_source_days: 1,
      missing_publication_rows: 0, latest_published_day: '2026-09-21', latest_release_at: '2026-09-22T02:00:00.000Z' });
    assert.equal(row(analytics, 'daily_queue').queued_source_days, 1);
    analytics.exec('DELETE FROM analytics_community_daily_publications WHERE revision=2');
    assert.equal(row(analytics, 'daily_publication').missing_publication_rows, 1);
    assert.equal(row(analytics, 'daily_publication').latest_published_day, null);
    analytics.exec('DELETE FROM analytics_runtime_sources');
    assert.equal(row(analytics, 'daily_queue').status, 'unavailable_contract');
    assert.equal(row(analytics, 'daily_queue').queued_source_days, null);
    source.exec("UPDATE telemetry_v12_runtime SET state='active'");
    assert.equal(row(source, 'source_contract', { v12: 'present' }).v12_state, 'active');
  } finally { source.close(); analytics.close(); }
});
