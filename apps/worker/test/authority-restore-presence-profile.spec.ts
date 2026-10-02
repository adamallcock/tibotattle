import { env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { authorityRestoreServingReady } from '../src/authority-restore';
import { AUTHORITY_RESTORE_SCHEMA } from '../src/authority-restore-schema';
import { createAnalyticsProfile, profileAnalyticsDatabase } from './helpers/analytics-profile';

const db = () => env.USAGE_MONITOR_DB;
const LEGACY_PRESENCE = "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_authority_restore_run'";
const LEGACY_RETENTION_PRESENCE = "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='retention_state'";
const KEYED_PRESENCE = "SELECT 1 AS present FROM pragma_table_list('_authority_restore_run') WHERE schema='main' AND name='_authority_restore_run' AND type IN ('table','virtual','shadow') LIMIT 1";
type Reading = { present: boolean; rowsRead: number; rowsWritten: number };

async function readPresence(sql: string, source: D1Database = db()): Promise<Reading> {
  const result = await source.prepare(sql).all();
  const rowsRead = result.meta?.rows_read;
  const rowsWritten = result.meta?.rows_written;
  expect(Number.isSafeInteger(rowsRead) && rowsRead >= 0).toBe(true);
  expect(Number.isSafeInteger(rowsWritten) && rowsWritten >= 0).toBe(true);
  expect(result.results.length).toBeLessThanOrEqual(1);
  return { present: result.results.length === 1, rowsRead: rowsRead!, rowsWritten: rowsWritten! };
}

async function proposedReady(source: D1Database = db()): Promise<boolean> {
  if (!(await readPresence(KEYED_PRESENCE, source)).present) return true;
  const run = await source.prepare('SELECT phase FROM _authority_restore_run WHERE id=1').first<{phase:string}>();
  if (run?.phase !== 'ready') return false;
  const retention = await source.prepare("SELECT 1 AS present FROM pragma_table_list('retention_state') WHERE schema='main' AND name='retention_state' AND type IN ('table','virtual','shadow') LIMIT 1").first();
  if (!retention) return false;
  return !!await source.prepare("SELECT 1 FROM retention_state WHERE singleton=1 AND state='completed' AND restore_replay_complete=1").first();
}

// Frozen pre-optimization reader. Keep its four exact queries independent of
// the production function so a source edit cannot redefine the cost baseline.
async function legacyReady(source: D1Database = db()): Promise<boolean> {
  if (!await source.prepare(LEGACY_PRESENCE).first()) return true;
  const run = await source.prepare('SELECT phase FROM _authority_restore_run WHERE id=1').first<{phase:string}>();
  if (run?.phase !== 'ready') return false;
  if (!await source.prepare(LEGACY_RETENTION_PRESENCE).first()) return false;
  return !!await source.prepare("SELECT 1 FROM retention_state WHERE singleton=1 AND state='completed' AND restore_replay_complete=1").first();
}

async function compare(label: string, readings: { label: string; legacy: number; keyed: number }[]): Promise<void> {
  const legacy = await readPresence(LEGACY_PRESENCE);
  const keyed = await readPresence(KEYED_PRESENCE);
  expect(keyed.present, label).toBe(legacy.present);
  expect(keyed.rowsWritten, label).toBe(0);
  const baseline = await legacyReady();
  expect(await proposedReady(), label).toBe(baseline);
  expect(await authorityRestoreServingReady(db()), label).toBe(baseline);
  readings.push({ label, legacy: legacy.rowsRead, keyed: keyed.rowsRead });
}

it('profiles fresh keyed table presence through absent, view, malformed and live restore states', async () => {
  await reset();
  const readings: { label: string; legacy: number; keyed: number }[] = [];
  for (let index = 0; index < 32; index++) {
    await db().prepare(`CREATE TABLE synthetic_presence_${index}(id INTEGER PRIMARY KEY) STRICT`).run();
  }
  await compare('absent', readings);
  await db().prepare('INSERT INTO synthetic_presence_0 VALUES(1)').run();
  await db().prepare("CREATE TRIGGER _authority_freeze_update_synthetic_presence_0 BEFORE UPDATE ON synthetic_presence_0 BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END").run();
  await expect(db().prepare('UPDATE synthetic_presence_0 SET id=2 WHERE id=1').run()).rejects.toThrow('AUTHORITY_SNAPSHOT_FROZEN');
  await compare('frozen-absent', readings);
  await db().prepare("CREATE VIEW _authority_restore_run AS SELECT 'ready' AS phase").run();
  await compare('view', readings);
  await db().prepare('DROP VIEW _authority_restore_run').run();
  await db().prepare('CREATE TABLE _authority_restore_run(id INTEGER PRIMARY KEY,other TEXT) STRICT').run();
  const malformed = await readPresence(KEYED_PRESENCE);
  expect(malformed.present).toBe(true);
  await expect(legacyReady()).rejects.toThrow();
  await expect(authorityRestoreServingReady(db())).rejects.toThrow();
  await expect(proposedReady()).rejects.toThrow();
  await db().prepare('DROP TABLE _authority_restore_run').run();
  await compare('removed', readings);
  await db().prepare(AUTHORITY_RESTORE_SCHEMA[0]!).run();
  await compare('real-marker-no-row', readings);
  await db().prepare("INSERT INTO _authority_restore_run VALUES(1,'synthetic','0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',33554432,'copying')").run();
  await compare('copying', readings);
  await db().prepare("UPDATE _authority_restore_run SET phase='ready' WHERE id=1").run();
  await compare('ready-no-retention', readings);
  await db().prepare("CREATE TABLE retention_state(singleton INTEGER PRIMARY KEY,state TEXT,restore_replay_complete INTEGER) STRICT").run();
  await db().prepare("INSERT INTO retention_state VALUES(1,'running',0)").run();
  await compare('replay-incomplete', readings);
  await db().prepare("UPDATE retention_state SET state='completed',restore_replay_complete=1 WHERE singleton=1").run();
  await compare('replay-complete', readings);
  const legacyProfile = createAnalyticsProfile();
  const keyedProfile = createAnalyticsProfile();
  const currentProfile = createAnalyticsProfile();
  expect(await legacyReady(profileAnalyticsDatabase(db(), 'source', legacyProfile, () => 'presence'))).toBe(true);
  expect(await proposedReady(profileAnalyticsDatabase(db(), 'source', keyedProfile, () => 'presence'))).toBe(true);
  expect(await authorityRestoreServingReady(profileAnalyticsDatabase(db(), 'source', currentProfile, () => 'presence'))).toBe(true);
  const total = (profile: typeof legacyProfile) => Object.values(profile.costs).reduce((sum, cost) => ({
    statements: sum.statements + cost.statements,
    rowsRead: sum.rowsRead + cost.rowsRead,
  }), { statements: 0, rowsRead: 0 });
  const nestedMeter = { legacy: total(legacyProfile), keyed: total(keyedProfile), current: total(currentProfile) };
  expect(nestedMeter.legacy.statements).toBe(4);
  expect(nestedMeter.keyed.statements).toBe(4);
  expect(nestedMeter.current.statements).toBe(4);
  expect(nestedMeter.keyed.rowsRead).toBeLessThan(nestedMeter.legacy.rowsRead);
  expect(nestedMeter.current.rowsRead).toBe(nestedMeter.keyed.rowsRead);
  await db().prepare("UPDATE _authority_restore_run SET phase='installed' WHERE id=1").run();
  await compare('installed-again', readings);
  let virtualTypes: 'supported' | 'unsupported' = 'unsupported';
  try {
    await db().prepare('CREATE VIRTUAL TABLE synthetic_virtual USING fts5(payload)').run();
    for (const [name, type] of [['synthetic_virtual', 'virtual'], ['synthetic_virtual_data', 'shadow']] as const) {
      const existing = await db().prepare(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='${name}'`).first();
      const keyed = await db().prepare(`SELECT type FROM pragma_table_list('${name}') WHERE schema='main' AND name='${name}'`).first<{type:string}>();
      const accepted = await db().prepare(`SELECT 1 FROM pragma_table_list('${name}') WHERE schema='main' AND name='${name}' AND type IN ('table','virtual','shadow') LIMIT 1`).first();
      expect(existing).not.toBeNull();
      expect(keyed?.type).toBe(type);
      expect(accepted).not.toBeNull();
    }
    virtualTypes = 'supported';
  } catch (error) {
    if (!/no such module|not authorized|unsupported/i.test(String(error))) throw error;
  }
  console.log('authority-restore-presence-profile', JSON.stringify({ statementsPerPresence: 1, readings, nestedMeter, virtualTypes }));
}, 30_000);
