#!/usr/bin/env node
// Compile only. Signing and publication remain separate protected operations.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CREDENTIAL_FIXTURE_CASES = Object.freeze(['modern', 'invalid', 'locked']);
export const CREDENTIAL_FIXTURE_REQUIREMENT = 'identifier "com.usagemonitor.local" and anchor apple generic '
  + 'and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
  + 'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
  + 'and certificate leaf[subject.OU] = "43RTH622SB"';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SOURCES = ['apps/macos/Sources/KeychainMigration.swift',
  'test/fixtures/macos-keychain-migration/OwnershipPolicy.swift',
  'test/fixtures/macos-keychain-migration/FixtureSupport.swift',
  'test/fixtures/macos-keychain-migration/ElectronCredentialMain.swift'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('MAC_CREDENTIAL_FIXTURE_PREPARATION_REFUSED'); };
export function credentialFixtureRoot(operationId) {
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail();
  return '/Users/runner/Library/Caches/tibotattle-credential-qualification-' + operationId;
}
export function credentialFixtureConfiguration(operationId) {
  const root = credentialFixtureRoot(operationId);
  return `import Foundation\nenum ProbeConfiguration {
    static let nonce = ${JSON.stringify(operationId)}
    static let requirement = ${JSON.stringify(CREDENTIAL_FIXTURE_REQUIREMENT)}
    static let cases = ${JSON.stringify(CREDENTIAL_FIXTURE_CASES)}
    static var scenario: String { CommandLine.arguments.count == 2 && cases.contains(CommandLine.arguments[1]) ? CommandLine.arguments[1] : "refused" }
    static var root: String { ${JSON.stringify(root)} + "/" + scenario }
}\n`;
}
export function credentialFixtureInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleExecutable</key><string>CredentialFixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleName</key><string>Synthetic credential fixture</string></dict></plist>\n`;
}
export function parseCredentialFixtureArguments(args) {
  if (args.length === 1 && args[0] === '--plan') return { execute: false };
  if (args.length !== 5 || args[0] !== '--compile-only' || args[1] !== '--operation-id'
    || args[3] !== '--output' || !isAbsolute(args[4] ?? '') || /[\0\r\n]/u.test(args[4])) fail();
  credentialFixtureRoot(args[2]);
  return { execute: true, operationId: args[2], output: resolve(args[4]) };
}
async function safeParent(path) {
  for (let current = path; ; current = dirname(current)) {
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o002)) fail();
    if (dirname(current) === current) break;
  }
  if (await realpath(path) !== path) fail();
}
export async function compileCredentialFixture(options) {
  if (!options.execute) return { schemaVersion: 'mac-credential-fixture-preparation-v1', status: 'planned',
    signingPerformed: false, keychainAccessPerformed: false };
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v26.2.0') fail();
  const configuration = credentialFixtureConfiguration(options.operationId);
  await safeParent(dirname(options.output));
  await mkdir(options.output, { mode: 0o700 });
  const app = join(options.output, 'CredentialFixture.app'), executable = join(app, 'Contents', 'MacOS', 'CredentialFixture');
  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  await writeFile(join(app, 'Contents', 'Info.plist'), credentialFixtureInfoPlist(), { mode: 0o600, flag: 'wx' });
  const generated = join(options.output, 'ProbeConfiguration.swift');
  await writeFile(generated, configuration, { mode: 0o600, flag: 'wx' });
  const sourceFiles = [];
  for (const path of SOURCES) sourceFiles.push({ path, sha256: digest(await readFile(join(ROOT, path))) });
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const command = (args) => execFileSync('/usr/bin/xcrun', args,
    { encoding: 'utf8', env: environment, timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const sdk = command(['--sdk', 'macosx', '--show-sdk-path']).trim();
  try {
    command(['swiftc', '-parse-as-library', '-O', '-suppress-warnings', '-sdk', sdk, '-target', 'arm64-apple-macosx13.0',
      '-module-cache-path', join(options.output, 'module-cache'), '-framework', 'Foundation', '-framework', 'Security',
      '-framework', 'CryptoKit', '-lbsm', generated, ...SOURCES.map(path => join(ROOT, path)), '-o', executable]);
  } catch (error) {
    await writeFile(join(options.output, 'compile-diagnostics.txt'), String(error.stderr ?? '').slice(0, 1024 * 1024),
      { mode: 0o600, flag: 'wx' });
    fail();
  }
  await chmod(executable, 0o700);
  const receipt = { schemaVersion: 'mac-credential-fixture-preparation-v1', status: 'compiled_unsigned',
    operationId: options.operationId, fixedRunnerRoot: credentialFixtureRoot(options.operationId),
    sourceFiles, configurationSha256: digest(Buffer.from(configuration)), unsignedExecutableSha256: digest(await readFile(executable)),
    signingPerformed: false, keychainAccessPerformed: false };
  await writeFile(join(options.output, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await compileCredentialFixture(parseCredentialFixtureArguments(process.argv.slice(2)))) + '\n'); }
  catch { process.stderr.write('MAC_CREDENTIAL_FIXTURE_PREPARATION_REFUSED\n'); process.exitCode = 1; }
}
