#!/usr/bin/env node
// Exact signed ARM artifact, disposable hosted account, synthetic credentials.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { exerciseEmptyProfileSettings } from './smoke-electron-macos-empty-profile.mjs';
import { validateSparkleTransitionHost, signedMacTransitionEnvironment,
  assertExtractedSignedMacBundle, verifySparkleTransitionCandidate } from './smoke-electron-macos-sparkle-transition.mjs';
import { ELECTRON_020_DMG, verifyPredecessor, refreshProductionUpdateArchiveIndex } from './smoke-electron-macos-production-update.mjs';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp, signedStagingFixture } from './run-signed-electron-staging.mjs';
import { CREDENTIAL_FIXTURE_CASES, CREDENTIAL_FIXTURE_REQUIREMENT } from './prepare-electron-macos-credential-fixture.mjs';
import { inspectMacOSLoopbackEnforcement, MACOS_LOOPBACK_MODE } from './lib/macos-loopback-qualification.mjs';

export { MAC_CREDENTIAL_CONFIRMATION, validateMacCredentialIntake, parseMacCredentialArguments } from './lib/macos-credential-qualification-intake.mjs';
import { MAC_CREDENTIAL_SCHEMA as SCHEMA, validateMacCredentialIntake, parseMacCredentialArguments } from './lib/macos-credential-qualification-intake.mjs';
const HASH = /^[a-f0-9]{64}$/u;
const fail = stage => { throw Object.assign(new Error('MAC_CREDENTIAL_QUALIFICATION_REFUSED'), { credentialStage: stage }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (file, args, timeout = 30000) => execFileSync(file, args,
  { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function absent(path) { try { await lstat(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; } fail('preexisting_state'); }
async function safePath(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = await lstat(p);
    if (s.isSymbolicLink() || (s.mode & 0o002)) fail('unsafe_path');
    if (p === dirname(p)) break;
  }
  if (await realpath(path) !== path) fail('unsafe_path');
}
async function checkedFile(path, expected, maximum) {
  await safePath(path); const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
    || before.size < 1n || before.size > BigInt(maximum)) fail('unsafe_file');
  const bytes = await readFile(path), after = await lstat(path, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || sha(bytes) !== expected) fail('artifact_digest');
  return bytes;
}
async function download(url, path, digest, maximum, github = false) {
  let selected = new URL(url);
  for (let n = 0; n < 5; n++) {
    if (selected.protocol !== 'https:' || selected.username || selected.password
      || !(github ? ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(selected.hostname)
        : selected.origin === 'https://updates.tibotattle.com')) fail('download_origin');
    const response = await fetch(selected, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status) && github) {
      selected = new URL(response.headers.get('location'), selected); await response.body?.cancel(); continue;
    }
    if (!response.ok || +(response.headers.get('content-length') ?? 0) > maximum) {
      await response.body?.cancel(); fail('download');
    }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > maximum) fail('download_size'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (!size || sha(bytes) !== digest) fail('download_digest');
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); return;
  }
  fail('download_redirect');
}
async function install(dmg, installed, mount) {
  await absent(installed); await mkdir(mount, { mode: 0o700 });
  command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], 90000);
  try { command('/usr/bin/ditto', [join(mount, 'TiboTattle.app'), installed], 120000); }
  finally { command('/usr/bin/hdiutil', ['detach', mount], 90000); }
  return assertExtractedSignedMacBundle(dmg, installed, mount + '-verify');
}

export function credentialFixtureArchiveInspectionScript() {
  return `import pathlib,stat,sys,zipfile
allowed={'CredentialFixture.app/Contents/Info.plist','CredentialFixture.app/Contents/MacOS/CredentialFixture','CredentialFixture.app/Contents/_CodeSignature/CodeResources'}
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist(); assert len(entries)<=12 and len({e.filename for e in entries})==len(entries)
 files=set(); total=0
 for e in entries:
  p=pathlib.PurePosixPath(e.filename); assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='CredentialFixture.app'
  mode=stat.S_IFMT(e.external_attr>>16); assert mode in [0,stat.S_IFDIR,stat.S_IFREG]
  if not e.is_dir(): files.add(e.filename); assert e.filename in allowed and e.file_size<=8*1024*1024
  total+=e.file_size
 assert files==allowed and total<=10*1024*1024
print('verified')`;
}
async function prepareFixture(input, directory) {
  const archive = join(directory, 'fixture.zip');
  await download(input.fixtureUrl, archive, input.fixtureArchiveSha256, 10 * 1024 ** 2);
  if (command('/usr/bin/python3', ['-c', credentialFixtureArchiveInspectionScript(), archive]) !== 'verified') fail('fixture_archive');
  const extracted = join(directory, 'fixture'); await mkdir(extracted, { mode: 0o700 });
  command('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
  const app = join(extracted, 'CredentialFixture.app'), executable = join(app, 'Contents', 'MacOS', 'CredentialFixture');
  await checkedFile(executable, input.fixtureExecutableSha256, 8 * 1024 ** 2);
  command('/usr/bin/codesign', ['--verify', '--strict', '--deep', '-R=' + CREDENTIAL_FIXTURE_REQUIREMENT, app]);
  const details = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]));
  if (details.CFBundleIdentifier !== 'com.usagemonitor.local' || details.CFBundleExecutable !== 'CredentialFixture') fail('fixture_identity');
  if (command('/usr/bin/lipo', ['-archs', executable]) !== 'arm64') fail('fixture_architecture');
  return executable;
}

export function validateCredentialSnapshot(value, scenario) {
  const capabilities = ['account-observation', 'contribution-device', 'accountless-installation'];
  if (!value || value.ok !== true || Object.keys(value).sort().join() !== 'items,ok' || !Array.isArray(value.items)
    || value.items.length !== 3 || value.items.some((item, index) => !item || Object.keys(item).sort().join() !== 'aclDigest,capability,itemDigest,readable,valueDigest'
      || item.capability !== capabilities[index]
      || !['itemDigest', 'aclDigest', 'valueDigest'].every(k => typeof item[k] === 'string' && HASH.test(item[k]))
      || !CREDENTIAL_FIXTURE_CASES.includes(scenario) || item.readable !== true)) fail('fixture_snapshot');
  return value.items;
}
// Only fixed fixture classifications may leave the owned helper. Never retain
// an arbitrary error message, Security stderr, returned value or filesystem path.
export const MAC_CREDENTIAL_FIXTURE_FAILURE_CODES = Object.freeze([
  'ADOPTION_ROLLBACK_UNVERIFIED', 'ADOPTION_WRITE_READBACK_FAILED', 'CLEANUP_DELETE_FAILED',
  'CLEANUP_INTENT_MISMATCH', 'CLEANUP_TARGET_CHANGED', 'CORE_DUMPS_NOT_DISABLED', 'CREATOR_READBACK_FAILED',
  'DISPOSABLE_HOST_REQUIRED', 'EXISTING_KEYCHAIN_REFUSED', 'FIXTURE_ACCESS_FAILED', 'FIXTURE_ACL_UNAVAILABLE',
  'FIXTURE_AGGREGATE_DOMAIN_MISMATCH', 'FIXTURE_ALREADY_SEEDED', 'FIXTURE_CLEANUP_FAILED',
  'FIXTURE_CLEANUP_NOT_READY', 'FIXTURE_COMMAND_INVALID', 'FIXTURE_COMMON_DOMAIN_CHANGED',
  'FIXTURE_COMMON_DOMAIN_REFUSED', 'FIXTURE_CREATE_FAILED', 'FIXTURE_DEFAULT_DOMAIN_MISMATCH',
  'FIXTURE_DEFAULT_RESTORE_FAILED', 'FIXTURE_DEFAULT_SELECT_FAILED', 'FIXTURE_DYNAMIC_DOMAIN_REFUSED',
  'FIXTURE_EXISTS', 'FIXTURE_FAILED', 'FIXTURE_IDENTITY_INVALID', 'FIXTURE_IDENTITY_UNAVAILABLE',
  'FIXTURE_ITEM_INVALID', 'FIXTURE_ITEM_MISSING', 'FIXTURE_LOCK_NOT_APPLIED', 'FIXTURE_LOCK_OPERATION_FAILED',
  'FIXTURE_LOCK_STATE_INVALID', 'FIXTURE_METADATA_UNAVAILABLE', 'FIXTURE_NOT_READABLE', 'FIXTURE_NOT_SEEDED',
  'FIXTURE_PREFERENCE_DOMAIN_REFUSED', 'FIXTURE_PROTOCOL_ENDED', 'FIXTURE_PROTOCOL_INVALID',
  'FIXTURE_PROTOCOL_LIMIT', 'FIXTURE_PROTOCOL_READ_FAILED', 'FIXTURE_PROTOCOL_TRUNCATED',
  'FIXTURE_READBACK_FAILED', 'FIXTURE_RECEIPT_CREATE_FAILED', 'FIXTURE_RECEIPT_INVALID',
  'FIXTURE_RECEIPT_SYNC_FAILED', 'FIXTURE_RECEIPT_TRUNCATED', 'FIXTURE_RECEIPT_UNAVAILABLE',
  'FIXTURE_RECEIPT_WRITE_FAILED', 'FIXTURE_SCOPE_ALREADY_SELECTED', 'FIXTURE_SCOPE_NOT_SELECTED',
  'FIXTURE_SCOPE_RESTORE_UNAVAILABLE', 'FIXTURE_SCOPE_SELECT_FAILED', 'FIXTURE_SCOPE_UNAVAILABLE',
  'FIXTURE_SEARCH_RESTORE_FAILED', 'FIXTURE_SEED_FAILED', 'FIXTURE_SYSTEM_METADATA_CHANGED',
  'FIXTURE_SYSTEM_METADATA_REFUSED', 'FIXTURE_SYSTEM_NAMESPACE_NOT_ABSENT', 'FIXTURE_SYSTEM_NOT_READABLE',
  'FIXTURE_SYSTEM_PATH_REFUSED', 'FIXTURE_USER_DEFAULT_CHANGED', 'FIXTURE_USER_DOMAIN_CHANGED',
  'INTERACTION_NOT_DISABLED', 'KEYCHAIN_JOURNAL_INCOMPLETE_OR_INVALID', 'KEYCHAIN_JOURNAL_INVALID',
  'KEYCHAIN_OPEN_FAILED', 'KEYCHAIN_OPEN_TARGET_CHANGED', 'KEYCHAIN_OWNERSHIP_INVALID',
  'KEYCHAIN_RECEIPT_MISMATCH', 'KEYCHAIN_REFERENCE_MISMATCH', 'KEYCHAIN_WRITE_INTENT_CHANGED',
  'KEYCHAIN_WRITE_LIMIT', 'KEYCHAIN_WRITE_PROOF_INVALID', 'KEYCHAIN_WRITE_TARGET_CHANGED', 'OWNER_MARKER_INVALID',
  'RANDOM_UNAVAILABLE', 'ROOT_LINK_REFUSED', 'ROOT_OWNERSHIP_INVALID', 'SYNTHETIC_KEYCHAIN_CREATE_FAILED',
  'SYNTHETIC_LEGACY_CREATE_FAILED', 'SYNTHETIC_RANDOM_FAILED',
]);
const fixtureFailureCodes = new Set(MAC_CREDENTIAL_FIXTURE_FAILURE_CODES);
const fixtureCommands = new Set(['seed', 'snapshot', 'select', 'scope', 'lock', 'unlock', 'restore', 'cleanup']);
export function validateCredentialScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== 'aggregateMatchesDomains,commonDomain,defaultFixture,dynamicDomainEmpty,schemaVersion,systemNamespacesAbsent,userDomainFixtureOnly'
    || value.schemaVersion !== 'mac-credential-isolated-scope-v1'
    || !['aggregateMatchesDomains', 'defaultFixture', 'dynamicDomainEmpty', 'userDomainFixtureOnly'].every(key => value[key] === true)
    || !['empty', 'verified_system'].includes(value.commonDomain)
    || value.systemNamespacesAbsent !== (value.commonDomain === 'empty' ? 0 : 10)) fail('fixture_scope');
  return value;
}
export function validateCredentialFixtureReply(value, { scenario, operation }) {
  if (!CREDENTIAL_FIXTURE_CASES.includes(scenario) || (operation !== null && !fixtureCommands.has(operation))) fail('fixture_protocol');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('fixture_protocol');
  if (value.ok === false) {
    if (Object.keys(value).sort().join() !== 'code,ok' || !fixtureFailureCodes.has(value.code)) fail('fixture_protocol');
    throw Object.assign(new Error('MAC_CREDENTIAL_QUALIFICATION_REFUSED'), { credentialStage: 'fixture_operation',
      fixtureFailure: Object.freeze({ scenario, command: operation ?? 'startup', code: value.code }) });
  }
  const scoped = operation === 'select' || operation === 'scope';
  const keys = operation === 'snapshot' ? 'items,ok' : operation === null ? 'ok,ready' : scoped ? 'ok,operation,scope' : 'ok,operation';
  if (value.ok !== true || Object.keys(value).sort().join() !== keys
    || (operation === null ? value.ready !== true : operation !== 'snapshot' && value.operation !== operation)) fail('fixture_response');
  if (operation === 'snapshot') validateCredentialSnapshot(value, scenario);
  if (scoped) validateCredentialScope(value.scope);
  return value;
}
async function fixtureSession(input, executable, scenario, environment) {
  if (!CREDENTIAL_FIXTURE_CASES.includes(scenario)) fail('fixture_case');
  const root = join(input.fixtureRoot, scenario); await mkdir(root, { mode: 0o700 });
  const info = await lstat(root, { bigint: true });
  if (info.ino > BigInt(Number.MAX_SAFE_INTEGER)) fail('fixture_root_identity');
  await writeFile(join(root, 'owner.json'), JSON.stringify({ nonce: input.operationId, uid: process.getuid(), inode: Number(info.ino) }), { mode: 0o600, flag: 'wx' });
  const child = spawn(executable, [scenario], { env: environment, stdio: ['pipe', 'pipe', 'ignore'] });
  let pending = null, buffer = '', ended = false, protocolError = false;
  child.stdin.on('error', () => {});
  child.on('error', () => { protocolError = true; pending?.reject(new Error('FIXTURE_PROCESS_FAILED')); });
  child.on('exit', () => { ended = true; if (pending) pending.reject(new Error('FIXTURE_PROCESS_ENDED')); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8192 || buffer.split('\n').length > 2) { protocolError = true; child.kill('SIGKILL'); return; }
    if (buffer.includes('\n') && pending) { const line = buffer.slice(0, -1); buffer = ''; const p = pending; pending = null;
      try { p.resolve(JSON.parse(line)); } catch (e) { p.reject(e); } }
  });
  async function receive(operation) {
    if (pending || ended || protocolError) fail('fixture_protocol');
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { protocolError = true; child.kill('SIGKILL'); reject(new Error('FIXTURE_TIMEOUT')); }, 15000);
      pending = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); pending = null; reject(e); } };
      if (operation) child.stdin.write(operation + '\n');
      else if (buffer.endsWith('\n')) { const line = buffer.trim(); buffer = ''; const p = pending; pending = null;
        try { p.resolve(JSON.parse(line)); } catch (e) { p.reject(e); } }
    });
    return validateCredentialFixtureReply(result, { scenario, operation });
  }
  await receive(null);
  return { request: receive, async close() { child.stdin.end(); for (let n = 0; n < 30 && !ended; n++) await delay(100);
    if (!ended) { child.kill('SIGKILL'); fail('fixture_not_stopped'); } if (protocolError) fail('fixture_protocol'); } };
}

export function macCredentialDialogScript(pid, action = 'inspect') {
  if (!Number.isSafeInteger(pid) || pid < 2 || !['inspect', 'retry', 'quit'].includes(action)) fail('dialog_input');
  return `function run(){var e=Application('System Events');if(!e.uiElementsEnabled())return 'ui_unavailable';
var security=e.applicationProcesses().filter(p=>['SecurityAgent','SecurityUIAgent','CoreServicesUIAgent'].includes(p.name()));
if(security.some(p=>p.windows().length>0))return 'unexpected_security_ui';
var p=e.applicationProcesses.whose({unixId:${pid}})();if(p.length!==1)return 'process_absent';
var windows=p[0].windows();if(windows.length>4)return 'ui_limit';var texts=[],buttons=[];
for(var w of windows){var q=[w],count=0;while(q.length){if(++count>256)return 'ui_limit';var x=q.shift(),r=x.role();if(r==='AXWebArea')continue;
if(r==='AXStaticText')texts.push(String(x.value()));if(r==='AXButton')buttons.push(x);var children=x.uiElements();if(q.length+children.length>256)return 'ui_limit';q.push(...children);}}
var codes=texts.join(' ').match(/SECURE_STORAGE_(LOCKED|DENIED|MIGRATION_REQUIRED|CREDENTIAL_INVALID|TIMEOUT|UNAVAILABLE|ADAPTER_INTEGRITY_FAILED)/g)||[];
if(codes.length!==1)return codes.length?'ambiguous_dialog':'no_secure_storage_dialog';
if(${JSON.stringify(action)}==='inspect')return codes[0];var name=${JSON.stringify(action === 'retry' ? 'Retry' : 'Quit')};
var matches=buttons.filter(b=>b.name()===name&&b.enabled());if(matches.length!==1)return 'action_unavailable';matches[0].click();return 'clicked';}`;
}
function dialog(pid, action) { return command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macCredentialDialogScript(pid, action)], 10000); }
async function until(check, stage, timeout = 30000, { now = Date.now, wait = delay } = {}) {
  const deadline = now() + timeout;
  do { const value = await check(); if (value) return value; await wait(200); } while (now() < deadline);
  fail(stage);
}
export function expectedCredentialReason(scenario, observed) {
  const accepted = { invalid: ['SECURE_STORAGE_CREDENTIAL_INVALID'], locked: ['SECURE_STORAGE_LOCKED'] };
  return accepted[scenario]?.includes(observed) === true;
}
async function observeRefusal(pid, scenario) {
  const inspect = () => { const value = dialog(pid, 'inspect'); if (value === 'no_secure_storage_dialog') return null;
    if (!expectedCredentialReason(scenario, value)) fail('unexpected_startup_dialog'); return value; };
  const initial = await until(inspect, 'secure_storage_dialog');
  if (dialog(pid, 'retry') !== 'clicked') fail('retry_action');
  await delay(500);
  if (await until(inspect, 'secure_storage_retry') !== initial) fail('retry_reason_changed');
  if (dialog(pid, 'quit') !== 'clicked') fail('quit_action');
  await until(() => {
    try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'quit_completion');
  return { reason: initial, explicitRetryObserved: true, explicitQuitObserved: true, nativeQuitCompleted: true };
}

export async function exerciseCredentialRefresh(dashboard, clock) {
  await until(() => dashboard.evaluate('Boolean(document.querySelector("#refresh-button") && !document.querySelector("#refresh-button").disabled)'), 'refresh_button', 60000, clock);
  const read = () => dashboard.evaluate('(async()=>{const r=await fetch("/api/local/refresh");if(!r.ok)return null;const v=(await r.json()).refresh;return v?{id:v.refreshId,status:v.status}:null})()');
  const before = await read();
  if (await dashboard.evaluate('(()=>{const b=document.querySelector("#refresh-button");if(!b||b.disabled)return false;b.click();return true})()') !== true) fail('refresh_action');
  await until(async () => {
    const value = await read();
    if (!value?.id || value.id === before?.id) return false;
    if (['failed', 'cancelled', 'degraded'].includes(value.status)) fail('refresh_failed');
    return value.status === 'succeeded';
  }, 'refresh_completion', 60000, clock);
  return true;
}

// Retain fixed failure families only; exception messages, URLs and paths stay private.
export function macCredentialFailureDiagnostics(error) {
  const launchStages = ['process_group', 'native_intro', 'owned_debugger', 'dashboard_target',
    'dashboard_ready', 'settings_target', 'settings_ready'];
  const launchCodes = ['startup', 'process_inventory', 'preexisting_app', 'local_response',
    'native_intro_identity', 'native_intro_closed', 'native_intro_unexpected',
    'native_intro_automation_unavailable'];
  const settingsCodes = ['settings_tab', 'settings_ready', 'settings_click', 'settings_effect'];
  return {
    launchStage: launchStages.includes(error?.signedLaunchStage) ? error.signedLaunchStage : null,
    launchCode: launchCodes.includes(error?.stage) ? error.stage : null,
    settingsStage: settingsCodes.includes(error?.emptyProfileStage) ? error.emptyProfileStage : null,
    launchOwnedProcessesStopped: typeof error?.ownedMacProcessesStopped === 'boolean'
      ? error.ownedMacProcessesStopped : null,
  };
}

export async function runMacCredentialQualification({ intake, execute = false }) {
  const proof = { schemaVersion: SCHEMA, status: 'planned', credentialContinuityQualified: false,
    enforcedLoopbackOnly: false, fixtureCleaned: false, ownedProcessesStopped: false,
    applicationBytesUnchanged: false, cases: [], fixtureScopes: [], failureStage: null, failurePhase: null, failureDiagnostics: null, fixtureFailure: null,
    nativeLegacyMigrationQualified: false, hostedUploadQualified: false, timeoutQualified: false,
    lockedStoreQualified: false, deniedStoreQualified: false, legacyOnlyQualified: false,
    nativeCleanQuitQualified: false, partialMigrationQualified: false,
    completeCredentialFailureMatrixQualified: false };
  let active = null, fixture = null, stage = 'intake';
  try {
    const input = validateMacCredentialIntake(intake);
    Object.assign(proof, { runnerRevision: input.runnerRevision, sourceRevision: input.sourceRevision,
      target: input.target, version: input.version, bundleVersion: input.bundleVersion, buildNumber: input.buildNumber,
      dmgSha256: input.dmgSha256, asarSha256: input.asarSha256, fixtureExecutableSha256: input.fixtureExecutableSha256,
      fixtureArchiveSha256: input.fixtureArchiveSha256, operationId: input.operationId, predecessorVersion: '0.1.20',
      predecessorAsarSha256: input.predecessorAsarSha256 });
    if (!execute) return proof;
    proof.status = 'failed'; stage = 'disposable_host';
    const home = validateSparkleTransitionHost({ target: input.target, platform: process.platform, architecture: process.arch,
      nodeVersion: process.version, environment: process.env, account: userInfo() });
    if (process.env.GITHUB_SHA !== input.runnerRevision) fail('runner_revision');
    const support = join(home, 'Library', 'Application Support'), profile = join(support, 'TiboTattle');
    const installed = join(home, 'Applications', 'TiboTattle.app'), codex = join(home, '.codex');
    for (const path of [profile, codex, join(home, '.claude'), installed, '/Applications/TiboTattle.app', input.fixtureRoot,
      join(support, 'Usage Monitor'), join(support, 'TiboTattle Native Handover'), join(support, 'app-usagemonitor'),
      join(home, 'Library', 'Preferences', 'com.usagemonitor.local.plist')]) await absent(path);
    const directory = join(process.env.RUNNER_TEMP, 'mac-credential-qualification');
    await mkdir(directory, { mode: 0o700 }); await safePath(directory);
    await mkdir(input.fixtureRoot, { mode: 0o700 }); await safePath(input.fixtureRoot);
    const environment = signedMacTransitionEnvironment({ target: input.target, home, temporaryDirectory: directory });
    stage = 'network_enforcement'; proof.networkChecks = await inspectMacOSLoopbackEnforcement(); proof.enforcedLoopbackOnly = true;
    stage = 'artifact_intake';
    const dmg = join(directory, 'candidate.dmg'), predecessor = join(directory, 'predecessor.dmg');
    await download(input.candidate.url, dmg, input.dmgSha256, 1024 ** 3);
    await download(input.predecessorUrl, predecessor, ELECTRON_020_DMG[input.target], 1024 ** 3, true);
    const helper = await prepareFixture(input, directory);
    await mkdir(dirname(installed), { recursive: true, mode: 0o700 }); await safePath(dirname(installed));
    await install(predecessor, installed, join(directory, 'old-mount'));
    let verified = await verifyPredecessor({ ...input, architecture: 'arm64' }, installed);
    await mkdir(codex, { mode: 0o700 }); await mkdir(join(codex, 'sessions'), { mode: 0o700 });
    await writeFile(join(codex, 'sessions', 'rollout-credential-synthetic.jsonl'), signedStagingFixture(), { mode: 0o600, flag: 'wx' });
    const launchOptions = { networkMode: MACOS_LOOPBACK_MODE };
    stage = 'modern_fixture'; fixture = await fixtureSession(input, helper, 'modern', environment);
    await fixture.request('seed'); const before = validateCredentialSnapshot(await fixture.request('snapshot'), 'modern');
    proof.fixtureScopes.push({ scenario: 'modern', ...((await fixture.request('select')).scope) });
    await fixture.request('scope');
    stage = 'predecessor_launch'; active = await launchVerifiedMacSharingApp(verified, environment, { ...launchOptions, untouched: true });
    stage = 'predecessor_settings'; await exerciseEmptyProfileSettings(active.settings);
    stage = 'predecessor_opt_out'; await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)');
    await until(async () => (await active.readSharing())?.enabled === false, 'predecessor_opt_out');
    await stopOwnedMacSharingApp(active); active = null;
    if (JSON.stringify(validateCredentialSnapshot(await fixture.request('snapshot'), 'modern')) !== JSON.stringify(before)) fail('predecessor_credential_changed');
    stage = 'installed_replacement';
    // Preserve the old signed app, never recursively delete or overwrite it.
    await rename(installed, join(dirname(installed), 'TiboTattle-credential-predecessor.app'));
    const cdhash = await install(dmg, installed, join(directory, 'candidate-mount'));
    refreshProductionUpdateArchiveIndex(installed);
    verified = await verifySparkleTransitionCandidate({ ...input.candidate, candidateCodeDirectoryHash: cdhash }, installed);
    for (let pass = 0; pass < 3; pass++) {
      stage = 'candidate_launch_' + pass;
      await fixture.request('scope');
      active = await launchVerifiedMacSharingApp(verified, environment, launchOptions);
      if (dialog(active.pid, 'inspect') !== 'no_secure_storage_dialog') fail('unexpected_security_ui');
      await exerciseEmptyProfileSettings(active.settings);
      if (pass === 0) await exerciseCredentialRefresh(active.dashboard);
      await until(async () => (await active.readSharing())?.enabled === (pass === 1), 'sharing_restart_preference');
      if (pass === 0) await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(true)');
      if (pass === 1) await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)');
      await until(async () => (await active.readSharing())?.enabled === (pass === 0), 'sharing_preference_applied');
      await stopOwnedMacSharingApp(active); active = null;
      if (JSON.stringify(validateCredentialSnapshot(await fixture.request('snapshot'), 'modern')) !== JSON.stringify(before)) fail('credential_changed');
    }
    proof.cases.push({ scenario: 'modern', status: 'passed', sameIdentityInstalledUpgrade: true,
      existingKeysUnchanged: true, aclUnchanged: true, controlledRestart: true, sharingEnabledRestart: true,
      localRefreshCompleted: true });
    await fixture.request('restore'); await fixture.request('cleanup'); await fixture.close(); fixture = null;
    for (const scenario of CREDENTIAL_FIXTURE_CASES.filter(v => v !== 'modern')) {
      stage = scenario; fixture = await fixtureSession(input, helper, scenario, environment);
      await fixture.request('seed'); const original = validateCredentialSnapshot(await fixture.request('snapshot'), scenario);
      proof.fixtureScopes.push({ scenario, ...((await fixture.request('select')).scope) });
      if (scenario === 'locked') await fixture.request('lock');
      await fixture.request('scope');
      active = await launchVerifiedMacSharingApp(verified, environment, { ...launchOptions,
        observeBeforeDashboard: pid => observeRefusal(pid, scenario) });
      const observation = active.startupObservation;
      await stopOwnedMacSharingApp(active); active = null;
      if (scenario === 'locked') await fixture.request('unlock');
      if (JSON.stringify(validateCredentialSnapshot(await fixture.request('snapshot'), scenario)) !== JSON.stringify(original)) fail('refused_credential_changed');
      await fixture.request('restore'); await fixture.request('cleanup'); await fixture.close(); fixture = null;
      proof.cases.push({ scenario, status: 'passed', ...observation, itemAndAclPreserved: true });
      if (scenario === 'locked') proof.lockedStoreQualified = true;
    }
    stage = 'final_artifact_verification';
    await verifySparkleTransitionCandidate({ ...input.candidate, candidateCodeDirectoryHash: cdhash }, installed);
    await checkedFile(helper, input.fixtureExecutableSha256, 8 * 1024 ** 2);
    proof.applicationBytesUnchanged = true; proof.ownedProcessesStopped = true; proof.fixtureCleaned = true;
    proof.credentialContinuityQualified = true; proof.status = 'passed';
  } catch (error) {
    proof.status = 'failed'; proof.failureStage = error.credentialStage ?? stage; proof.failurePhase = stage;
    proof.failureDiagnostics = macCredentialFailureDiagnostics(error);
    if (error.fixtureFailure) proof.fixtureFailure = error.fixtureFailure;
  }
  finally {
    if (active) { try { await stopOwnedMacSharingApp(active); proof.ownedProcessesStopped = true; } catch { proof.ownedProcessesStopped = false; } }
    if (fixture) { try { await fixture.close(); } catch { /* Uncertain fixture scope/journal stays failed; hosted machine is disposable. */ } }
  }
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runMacCredentialQualification({ ...parseMacCredentialArguments(process.argv.slice(2)), intake: JSON.parse(process.env.MAC_CREDENTIAL_INTAKE ?? '{}') });
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.status === 'failed') process.exitCode = 1; }
  catch { process.stderr.write('MAC_CREDENTIAL_QUALIFICATION_REFUSED\n'); process.exitCode = 1; }
}
