'use strict';
// Executed before the pinned Wrangler main module. Never accepts SQL on OS argv.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread } = require('node:worker_threads');
const PREFIX = 'WRANGLER_QUERY_';
const PLACEHOLDER = '--command=__TIBOTATTLE_FROZEN_QUERY__';
const fail = code => { throw new Error(PREFIX + code); };
const check = (ok, code) => { if (!ok) fail(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readPrivate(file, maxBytes) {
  const canonical = fs.realpathSync(file);
  check(!fs.lstatSync(file).isSymbolicLink(), 'SYMLINK');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    check(info.isFile() && info.size > 0 && info.size <= maxBytes, 'SIZE');
    check((info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid()), 'PRIVATE_FILE_REQUIRED');
    const buffer = Buffer.alloc(info.size + 1);
    let count = 0, read;
    do { read = fs.readSync(fd, buffer, count, buffer.length - count, null); count += read; } while (read > 0 && count < buffer.length);
    check(count === info.size && fs.fstatSync(fd).size === info.size, 'SIZE');
    const bytes = buffer.subarray(0, count);
    return { canonical, bytes };
  } finally { fs.closeSync(fd); }
}
function verifyQuery({ sqlPath, expectedSqlSha256, maxBytes }) {
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 256 * 1024, 'LIMIT');
  check(/^[a-f0-9]{64}$/.test(expectedSqlSha256), 'HASH');
  const { canonical, bytes } = readPrivate(sqlPath, maxBytes);
  check(sha(bytes) === expectedSqlSha256, 'HASH');
  let sql; try { sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('UTF8'); }
  check(!sql.includes('\0') && Buffer.from(sql).equals(bytes), 'UTF8');
  return { canonical, sql };
}
function verifyCli(cliPath, expectedCliSha256) {
  const canonical = fs.realpathSync(cliPath);
  check(canonical.endsWith(path.join('wrangler-dist', 'cli.js')), 'CLI_PATH');
  const packagePath = path.join(path.dirname(path.dirname(canonical)), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  check(pkg.name === 'wrangler' && pkg.version === '4.114.0' && pkg.main === 'wrangler-dist/cli.js', 'CLI_VERSION');
  const bytes = fs.readFileSync(canonical);
  check(bytes.length <= 64 * 1024 * 1024, 'CLI_SIZE');
  const digest = sha(bytes);
  if (expectedCliSha256 !== undefined) check(digest === expectedCliSha256, 'CLI_HASH');
  return { canonical, digest };
}
function verifyConfig({ configPath, binding, databaseId }) {
  check(/^[A-Z][A-Z0-9_]{0,63}$/.test(binding), 'BINDING');
  check(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(databaseId), 'DATABASE');
  const { canonical, bytes } = readPrivate(configPath, 64 * 1024);
  const config = JSON.parse(bytes);
  // This private transport configuration cannot select an alternate environment or preview DB.
  const bindings = config.d1_databases;
  check(Array.isArray(bindings) && bindings.length === 1 && bindings[0].binding === binding && bindings[0].database_id === databaseId && !bindings[0].preview_database_id && !config.env, 'CONFIG_TARGET');
  return { canonical, digest: sha(bytes) };
}
function preload() {
  const args = process.argv.slice(2);
  check(args.length === 14 || args.length === 16, 'ARGUMENTS');
  const [d1, execute, binding, mode, json, configFlag, configPath, placeholder, sqlPathArg, hashArg, limitArg, databaseArg, cliHashArg, configHashArg] = args;
  check(d1 === 'd1' && execute === 'execute' && ['--local', '--remote'].includes(mode) && json === '--json' && configFlag === '--config' && placeholder === PLACEHOLDER, 'ARGUMENTS');
  const value = (arg, name) => { check(arg.startsWith(name + '='), 'ARGUMENTS'); return arg.slice(name.length + 1); };
  const sqlPath = value(sqlPathArg, '--tibo-query-path'), expectedSqlSha256 = value(hashArg, '--tibo-query-sha256');
  const maxBytes = Number(value(limitArg, '--tibo-query-max-bytes')), databaseId = value(databaseArg, '--tibo-query-database');
  const cli = verifyCli(process.argv[1], value(cliHashArg, '--tibo-query-cli-sha256'));
  const config = verifyConfig({ configPath, binding, databaseId });
  check(config.digest === value(configHashArg, '--tibo-query-config-sha256'), 'CONFIG_HASH');
  const query = verifyQuery({ sqlPath, expectedSqlSha256, maxBytes });
  const trailing = args.slice(14);
  check(trailing.length === 0 || (mode === '--local' && trailing[0] === '--persist-to' && path.isAbsolute(trailing[1])), 'ARGUMENTS');
  process.argv = [process.execPath, cli.canonical, d1, execute, binding, mode, json, configFlag, config.canonical, '--command=' + query.sql, ...trailing];
}
module.exports = { PLACEHOLDER, verifyQuery, verifyCli, verifyConfig };
// Worker threads inherit preload arguments; only the CLI main thread rewrites argv.
if (isMainThread && process.argv.includes(PLACEHOLDER)) {
  try { preload(); } catch (error) {
    const code = /^WRANGLER_QUERY_[A-Z0-9_]+$/.test(error?.message) ? error.message : PREFIX + 'INPUT_INVALID';
    process.stderr.write(code + '\n');
    process.exit(1);
  }
}
