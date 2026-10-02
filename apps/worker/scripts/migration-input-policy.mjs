import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const DEFAULT_MIGRATION_INPUT_MAX_BYTES = 240 * 1024;
// Source admission only. This pin neither extends a closed forward profile nor
// changes the independent 256 KiB hosted query transport allowance.
export const SELECTIVE_DEPENDENCY_MIGRATION_INPUT = Object.freeze({
  directory: 'ingestion-isolation-migrations',
  name: '0015_effective_selective_dependencies.sql',
  sha256: 'f13862cca051ff88e4f9e67363b131483311ad085cf4bc8d7c006506c729706a',
  bytes: 269024,
  statements: 129,
  maxStatementBytes: 8 * 1024,
});
const selective = (directory, name) => directory === SELECTIVE_DEPENDENCY_MIGRATION_INPUT.directory
  && name === SELECTIVE_DEPENDENCY_MIGRATION_INPUT.name;
const fail = () => { throw Object.assign(new Error('MIGRATION_INPUT_POLICY_INVALID'), { code: 'MIGRATION_INPUT_POLICY_INVALID' }); };

export function migrationInputMaximumBytes(directory, name) {
  return selective(directory, name) ? SELECTIVE_DEPENDENCY_MIGRATION_INPUT.bytes : DEFAULT_MIGRATION_INPUT_MAX_BYTES;
}

/** Every caller retains its filesystem safety and source identity checks. Only
 * the exact reviewed source file receives this larger local input allowance. */
export function assertMigrationInputPolicy({ workerDirectory, directory, name, bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > migrationInputMaximumBytes(directory, name)
      || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail();
  if (!selective(directory, name)) return;
  const pin = SELECTIVE_DEPENDENCY_MIGRATION_INPUT;
  if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) fail();
  let statements;
  try {
    const split = createRequire(join(workerDirectory, 'package.json'))('wrangler').unstable_splitSqlQuery;
    if (typeof split !== 'function') fail();
    statements = split(bytes.toString('utf8'));
  } catch { fail(); }
  if (!Array.isArray(statements) || statements.length !== pin.statements
      || statements.some(sql => typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > pin.maxStatementBytes)) fail();
}
