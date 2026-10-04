#!/usr/bin/env node
// Exact public predecessor -> final candidate, ordinary FUSE launcher only.
import { spawn, spawnSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:https';
import { lookup } from 'node:dns/promises';
import { basename, dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertContainerContract, freeTcpPort, terminateLinuxSmokeChild, runSmoke,
  ELECTRON_LINUX_SMOKE_FAILURE_STAGES } from './smoke-electron-linux.mjs';
import { createLinuxStartupDiagnostics,
  validateLinuxStartupDiagnostic } from './lib/linux-startup-diagnostics.mjs';
import { createLinuxNormalPackagedSmokeFixture, normalPackagedSmokeEnvironment, runOneNormalApp, normalPackagedSmokeFailureStageCode,
  persistLinuxNormalPackagedRestartPreferences, verifyLinuxNormalPackagedRestartPreferences } from './smoke-electron-linux-packaged.mjs';
import { prepareLinuxUpdaterDownload, realUpdaterFeed, isLinuxUpdaterSettingsURL,
  connectPage as connectUpdaterPage, processHealth as updaterProcessHealth, waitFor as waitForUpdater } from './smoke-electron-linux-real-appimage-updater.mjs';
import { proveLinuxSecretServiceContainerIsolation, startLinuxSecretServiceDaemon } from './qualify-linux-secret-service.mjs';
import { readLocalCollectorCheckpoint } from '../src/local-collector-state.js';
import { fingerprintLinuxFinalFile } from './qualify-electron-linux-installed-lifecycle.mjs';
import { readLinuxMountRuntimeFacts, sampleLinuxMountProbeFacts } from './diagnose-electron-linux-appimage-mount.mjs';
import { LINUX_FINAL_INPUT, LINUX_FINAL_FEED, validateLinuxFinalPair, linuxFinalFailure as fail } from './lib/linux-final-artifact-intake.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LINUX_FINAL_EXEC = '/opt/tibotattle-updater-exec';
const IMAGE = `${LINUX_FINAL_EXEC}/TiboTattle.AppImage`, TEMP_ROOT = `${LINUX_FINAL_EXEC}/tmp`;
const HOST = 'updates.tibotattle.com';
const wait = waitForUpdater;
const digest = async path => (await fingerprintLinuxFinalFile(path)).sha256;
const unescapeMount = text => text.replace(/\\(040|011|012|134)/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
export function linuxFinalTemporary(nonce) {
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? '')) fail('FUSE_TEMPORARY_INVALID');
  return `${TEMP_ROOT}/${nonce}`;
}
export function assertLinuxFinalOwnedPolicy({ nonce, name, profileText, facts }) {
  linuxFinalTemporary(nonce);
  if (typeof name !== 'string' || !new RegExp(`^tibotattle-mount-candidate-[1-9][0-9]{0,14}-${nonce}$`, 'u').test(name)
    || typeof profileText !== 'string' || profileText.length > 256 || profileText.trim() !== `${name} (enforce)`
    || !isDeepStrictEqual(facts, { appArmor: { profile: 'other', enforcement: 'enforce' }, seccomp: 'filter',
      noNewPrivileges: false, sysAdmin: { effective: false, permitted: false, bounding: true },
      fuseDevice: { characterDevice: true, readable: true, writable: true },
      fusermount: { present: true, regular: true, rootOwned: true, setuid: true, executable: true } })) fail('ISOLATION_REQUIRED');
}

/** A path alone never proves FUSE. Bind the kernel mount table and the runtime's
 * environment to the installed image. SquashFS file uid is not the app uid. */
export function selectLinuxFinalFuseMount({ executable, mountinfo, environment, image = IMAGE, temporary }) {
  if (typeof temporary !== 'string' || temporary !== linuxFinalTemporary(temporary.slice(TEMP_ROOT.length + 1))) fail('FUSE_TEMPORARY_INVALID');
  if (image !== IMAGE) fail('FUSE_IMAGE_PATH_INVALID');
  if (typeof executable !== 'string' || posix.resolve(executable) !== executable
    || posix.basename(executable) !== 'tibotattle') fail('FUSE_EXECUTABLE_PATH_INVALID');
  const mount = posix.dirname(executable);
  if (!new RegExp(`^${temporary}/\\.mount_[A-Za-z0-9._-]+$`, 'u').test(mount)) fail('FUSE_MOUNT_LOCATION_INVALID');
  const rows = mountinfo.split('\n').filter(Boolean).map(line => {
    const parts = line.split(' - '); if (parts.length !== 2) return null;
    const before = parts[0].split(' '), after = parts[1].split(' ');
    return { root: unescapeMount(before[3] ?? ''), mount: unescapeMount(before[4] ?? ''),
      options: (before[5] ?? '').split(','), type: after[0], source: unescapeMount(after[1] ?? ''),
      superOptions: (after[2] ?? '').split(',') };
  }).filter(row => row?.mount === mount);
  if (rows.length === 0) fail('FUSE_MOUNT_MISSING');
  if (rows.length !== 1) fail('FUSE_MOUNT_AMBIGUOUS');
  const selected = rows[0];
  if (!['fuse.squashfuse', 'fuse.TiboTattle.AppImage', 'fuse'].includes(selected.type)) fail('FUSE_MOUNT_TYPE_INVALID');
  if (!(selected.type === 'fuse.squashfuse' ? selected.source === 'squashfuse'
    : [image, posix.basename(image)].includes(selected.source))) fail('FUSE_MOUNT_SOURCE_INVALID');
  if (selected.root !== '/') fail('FUSE_MOUNT_ROOT_INVALID');
  if (!selected.options.includes('ro')) fail('FUSE_MOUNT_READ_ONLY_REQUIRED');
  if (!selected.superOptions.includes('user_id=1000')) fail('FUSE_MOUNT_UID_INVALID');
  if (environment.APPIMAGE !== image) fail(environment.APPIMAGE === undefined ? 'FUSE_APPIMAGE_ENV_MISSING' : 'FUSE_APPIMAGE_ENV_MISMATCH');
  if (environment.APPDIR !== mount) fail(environment.APPDIR === undefined ? 'FUSE_APPDIR_ENV_MISSING' : 'FUSE_APPDIR_ENV_MISMATCH');
  if (environment.APPIMAGE_EXTRACT_AND_RUN !== undefined) fail('FUSE_EXTRACTION_MODE_FORBIDDEN');
  return { mount, type: selected.type };
}
export function linuxFinalSandboxStatus({ commandLine, status }) {
  const args = commandLine.split('\0');
  return args.includes('--type=renderer') && !args.includes('--no-sandbox')
    && !args.includes('--disable-setuid-sandbox') && /^NoNewPrivs:\s+1$/mu.test(status)
    && /^Seccomp:\s+2$/mu.test(status);
}
function startTime(stat) {
  const close = stat.lastIndexOf(')');
  const value = stat.slice(close + 2).split(' ')[19];
  if (!/^[0-9]+$/u.test(value ?? '')) fail('PROCESS_START_TIME_INVALID');
  return value;
}
export async function readLinuxFinalAppProcessIdentity(pid, expected, temporary, { read = readFile, link = readlink, hash = digest } = {}) {
  const stat = await read(`/proc/${pid}/stat`, 'utf8');
  const args = (await read(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  if (args.some(arg => arg.startsWith('--type='))) return null;
  const executable = await link(`/proc/${pid}/exe`); // No argv fallback in this lane.
  if (!executable.startsWith(`${temporary}/.mount_`) || basename(executable) !== 'tibotattle') return null;
  const status = await read(`/proc/${pid}/status`, 'utf8');
  if (!/^Uid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status)) fail('PROCESS_UID_INVALID');
  const entries = (await read(`/proc/${pid}/environ`, 'utf8')).split('\0');
  const environment = Object.fromEntries(entries.filter(item => /^(APPIMAGE|APPDIR|APPIMAGE_EXTRACT_AND_RUN|ELECTRON_RUN_AS_NODE)=/u.test(item)).map(item => {
    const split = item.indexOf('='); return [item.slice(0, split), item.slice(split + 1)];
  }));
  // The ordinary companion uses this same executable in Node mode. Its closed
  // environment omits APPIMAGE/APPDIR; it remains part of browser descendants.
  if (environment.ELECTRON_RUN_AS_NODE === '1') return null;
  if (environment.ELECTRON_RUN_AS_NODE !== undefined) fail('PROCESS_ROLE_INVALID');
  const mounted = selectLinuxFinalFuseMount({ executable, mountinfo: await read(`/proc/${pid}/mountinfo`, 'utf8'), environment, temporary });
  if (await hash(executable) !== expected.executableSha256
    || await hash(join(mounted.mount, 'resources/app.asar')) !== expected.asarSha256) return null;
  if (startTime(await read(`/proc/${pid}/stat`, 'utf8')) !== startTime(stat)) fail('PROCESS_BYTES_CHANGED');
  return { pid, startTime: startTime(stat), mount: mounted.mount, executable };
}
async function ownedApps(expected, temporary) {
  const found = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/u.test(name)) continue;
    try { const identity = await readLinuxFinalAppProcessIdentity(Number(name), expected, temporary); if (identity) found.push(identity); }
    catch (error) { if (error.code?.startsWith('LINUX_FINAL_LIFECYCLE_')) throw error; /* Exited or unrelated. */ }
  }
  return found;
}
async function currentApp(expected, temporary) {
  return wait(async () => {
    const found = await ownedApps(expected, temporary); if (found.length > 1) fail('MULTIPLE_APPS');
    return found[0] ?? null;
  }, 60000);
}
async function alive(identity) {
  try { return startTime(await readFile(`/proc/${identity.pid}/stat`, 'utf8')) === identity.startTime; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function assertNoOwnedMounts(temporary) {
  await wait(async () => !(await readFile('/proc/self/mountinfo', 'utf8')).split('\n')
    .some(line => line.split(' ')[4]?.startsWith(`${temporary}/.mount_`)), 15000);
}
async function descendants(browser) {
  const found = [browser];
  for (let pass = 0; pass < 8; pass++) {
    const before = found.length;
    for (const name of await readdir('/proc')) {
      if (!/^[0-9]+$/u.test(name) || found.some(row => row.pid === Number(name))) continue;
      try {
        const status = await readFile(`/proc/${name}/status`, 'utf8');
        if (!found.some(row => row.pid === Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]))) continue;
        found.push({ pid: Number(name), startTime: startTime(await readFile(`/proc/${name}/stat`, 'utf8')) });
      } catch { /* Already exited. */ }
    }
    if (found.length === before) return found;
  }
  fail('PROCESS_TREE_UNBOUNDED');
}
async function assertRendererSandbox(browser) {
  await wait(async () => {
    for (const child of await descendants(browser)) {
      const name = String(child.pid);
      try {
        const status = await readFile(`/proc/${name}/status`, 'utf8');
        const args = await readFile(`/proc/${name}/cmdline`, 'utf8');
        if (!linuxFinalSandboxStatus({ commandLine: args, status })) continue;
        const executable = await readlink(`/proc/${name}/exe`);
        if (executable !== browser.executable) continue;
        return true;
      } catch { /* Exited or unrelated. */ }
    }
    return false;
  }, 10000);
}
export async function assertLinuxFinalProcessTreeGone(identities, { readAlive = alive, waiter = wait } = {}) {
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > 1024
    || new Set(identities.map(row => row.pid)).size !== identities.length
    || identities.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 || !/^[0-9]+$/u.test(row.startTime))) fail('PROCESS_IDENTITY_INVALID');
  await waiter(async () => (await Promise.all(identities.map(readAlive))).every(value => value === false), 15000);
}
async function stopOwned(identity, temporary) {
  const children = await descendants(identity);
  if (await alive(identity)) process.kill(identity.pid, 'SIGUSR2');
  await assertLinuxFinalProcessTreeGone(children);
  await assertNoOwnedMounts(temporary);
}
function command(name, args) {
  const result = spawnSync(name, args, { shell: false, stdio: 'ignore', timeout: 15000 });
  if (result.error || result.status !== 0 || result.signal) fail('LOCAL_TRUST_FAILED');
}
async function fixtureWithDefaultProfile() {
  const original = await createLinuxNormalPackagedSmokeFixture();
  const config = join(original.home, '.config'); await mkdir(config, { mode: 0o700 });
  const userData = join(config, 'TiboTattle'); await rename(original.userData, userData);
  return { ...original, userData, stateFile: join(userData, 'companion-state/local-collector-state-v1.sqlite') };
}
async function trustFixture(fixture, cert) {
  const nss = join(fixture.home, '.pki/nssdb'); await mkdir(nss, { recursive: true, mode: 0o700 });
  command('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
  command('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'TiboTattle disposable loopback CA', '-t', 'C,,', '-i', cert]);
}
function launchEnvironment(fixture, cert, temporary) {
  const environment = { ...normalPackagedSmokeEnvironment({ fixture, service: 'available' }),
    XDG_CONFIG_HOME: join(fixture.home, '.config'), XDG_CACHE_HOME: join(fixture.home, '.cache'),
    XDG_DATA_HOME: join(fixture.home, '.local/share'), TMPDIR: temporary, NODE_EXTRA_CA_CERTS: cert };
  for (const key of ['APPIMAGE', 'APPDIR', 'APPIMAGE_EXTRACT_AND_RUN', 'APPIMAGE_EXTRACT_AND_RUN_CLEANUP']) delete environment[key];
  return environment;
}
async function checkedCheckpoint(fixture) {
  const checkpoint = await readLocalCollectorCheckpoint({ stateFile: fixture.stateFile });
  const scope = checkpoint?.accountScopeMarker?.accountScope;
  if (scope?.status !== 'available' || scope.version !== 'openai-account-v1' || !/^openai-account:v1:[A-Za-z0-9_-]{43}$/u.test(scope.scopeId ?? '')) fail('CREDENTIAL_ACCESS_UNPROVEN');
  return scope;
}
async function proveNoUpdate(cdp, origin, browser) {
  await cdp.evaluate('globalThis.tibotattleDesktop.openSettings()');
  // Reuse the owned CDP port selected by the caller's app; no arbitrary URL.
  const args = (await readFile(`/proc/${browser.pid}/cmdline`, 'utf8')).split('\0');
  const port = Number(args.find(arg => /^--remote-debugging-port=[0-9]+$/u.test(arg))?.split('=')[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('DEBUGGER_IDENTITY_INVALID');
  const settings = await connectUpdaterPage(port, url => isLinuxUpdaterSettingsURL(url, origin));
  try {
    await wait(() => settings.evaluate("document.querySelector('#settings-tab-about') !== null"));
    await settings.evaluate("document.querySelector('#settings-tab-about').click()");
    await wait(async () => (await settings.evaluate('globalThis.tibotattleDesktop.getSettings()')).about.update.canCheck);
    await settings.evaluate("document.querySelector('#settings-check-for-updates').click()");
    await wait(async () => {
      const state = (await settings.evaluate('globalThis.tibotattleDesktop.getSettings()')).about.update;
      if (state.status === 'error') fail('NO_UPDATE_FAILED');
      return state.status === 'current' && !state.canInstall && !state.canDownload;
    }, 30000);
  } finally { settings.close(); }
}
export function linuxFinalFeedRequestPath(requestUrl) {
  const url = new URL(requestUrl, LINUX_FINAL_FEED);
  if (url.origin !== `https://${HOST}` || url.username || url.password || url.hash) return null;
  const feed = '/electron/stable/linux-x64/latest-linux.yml';
  if (url.pathname === feed && (url.search === '' || /^\?noCache=[0-9a-v]{1,20}$/u.test(url.search))) return 'feed';
  if (url.pathname === '/electron/stable/linux-x64/next.AppImage' && url.search === '') return 'image';
  return null;
}
export function assertLinuxFinalChecksumRejection({ update, installedSha256, expectedSha256, completedTransfers }) {
  if (update?.status !== 'error' || update.error !== 'download_failed' || update.canInstall !== false
    || installedSha256 !== expectedSha256 || !Number.isSafeInteger(completedTransfers) || completedTransfers < 1) fail('CHECKSUM_REFUSAL_UNPROVEN');
}
async function installImage(source, expected) {
  await copyFile(source, IMAGE, constants.COPYFILE_EXCL); await chmod(IMAGE, 0o700);
  if (await digest(IMAGE) !== expected.sha256) fail('INSTALLED_BYTES_INVALID');
}
async function uninstallImage(expected, preservedFixture, temporary) {
  await assertNoOwnedMounts(temporary);
  const stat = await lstat(IMAGE);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 1000
    || await digest(IMAGE) !== expected.sha256) fail('UNINSTALL_TARGET_INVALID');
  const before = preservedFixture ? await checkedCheckpoint(preservedFixture) : null;
  await unlink(IMAGE);
  try { await lstat(IMAGE); fail('UNINSTALL_FAILED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (preservedFixture && !isDeepStrictEqual(before, await checkedCheckpoint(preservedFixture))) fail('UNINSTALL_STATE_CHANGED');
}
/** Preserve only the maintained smoke-stage code and closed startup evidence. */
export function linuxFinalFailureDetails(errorCode, startupDiagnostic) {
  const smokeCode = typeof errorCode === 'string' && ELECTRON_LINUX_SMOKE_FAILURE_STAGES.some(stage => {
    const code = normalPackagedSmokeFailureStageCode(stage);
    return code !== null && errorCode === `ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_${code}`;
  });
  const diagnostic = validateLinuxStartupDiagnostic(startupDiagnostic);
  return { errorCode: /^LINUX_FINAL_LIFECYCLE_[A-Z_]+$/u.test(errorCode ?? '') || smokeCode
    ? errorCode : 'LINUX_FINAL_LIFECYCLE_RUNTIME_FAILED',
  ...(diagnostic === null ? {} : { startupDiagnostic: diagnostic }) };
}
/** The shared smoke retains its late-network stage while beforeQuit runs. Keep
 * failures from these final-lifecycle checks distinct, after its cleanup runs. */
const IDENTITY_HOOK_FAILURES = new Map([
  'FUSE_TEMPORARY_INVALID', 'FUSE_IMAGE_PATH_INVALID', 'FUSE_EXECUTABLE_PATH_INVALID',
  'FUSE_MOUNT_LOCATION_INVALID', 'FUSE_MOUNT_MISSING', 'FUSE_MOUNT_AMBIGUOUS',
  'FUSE_MOUNT_TYPE_INVALID', 'FUSE_MOUNT_SOURCE_INVALID', 'FUSE_MOUNT_ROOT_INVALID',
  'FUSE_MOUNT_READ_ONLY_REQUIRED', 'FUSE_MOUNT_UID_INVALID', 'FUSE_APPIMAGE_ENV_MISSING', 'FUSE_APPIMAGE_ENV_MISMATCH',
  'FUSE_APPDIR_ENV_MISSING', 'FUSE_APPDIR_ENV_MISMATCH', 'FUSE_EXTRACTION_MODE_FORBIDDEN', 'PROCESS_START_TIME_INVALID',
  'PROCESS_UID_INVALID', 'PROCESS_ROLE_INVALID', 'PROCESS_BYTES_CHANGED', 'MULTIPLE_APPS',
  'FILE_UNSAFE', 'FILE_CHANGED',
].map(code => [`LINUX_FINAL_LIFECYCLE_${code}`, `NORMAL_APP_IDENTITY_${code}`]));
IDENTITY_HOOK_FAILURES.set('LINUX_REAL_APPIMAGE_TIMEOUT', 'NORMAL_APP_IDENTITY_TIMEOUT');
export async function runLinuxFinalNormalJourney({ run, readIdentity, assertSandbox, preferences, noUpdate, preserveState = null }) {
  if (![run, readIdentity, assertSandbox, preferences, noUpdate].every(value => typeof value === 'function')
    || preserveState !== null && typeof preserveState !== 'function') fail('NORMAL_HOOK_INVALID');
  let hookFailure = null, entered = false, completed = false, identity;
  const check = async (code, action) => {
    try { return await action(); }
    catch (error) {
      // Never retain arbitrary error codes, messages, paths or other properties.
      hookFailure = code === 'NORMAL_APP_IDENTITY_FAILED' ? IDENTITY_HOOK_FAILURES.get(error?.code) ?? code : code;
      fail(hookFailure);
    }
  };
  try {
    await run(async context => {
      if (entered) { hookFailure = 'NORMAL_HOOK_INVALID'; fail(hookFailure); }
      entered = true;
      identity = await check('NORMAL_APP_IDENTITY_FAILED', readIdentity);
      await check('NORMAL_RENDERER_SANDBOX_FAILED', () => assertSandbox(identity));
      await check('NORMAL_PREFERENCES_FAILED', () => preferences(context));
      await check('NORMAL_NO_UPDATE_FAILED', () => noUpdate(context, identity));
      if (preserveState !== null) await check('NORMAL_LOCAL_STATE_FAILED', preserveState);
      completed = true;
    });
  } catch (error) {
    if (hookFailure !== null) fail(hookFailure);
    throw error;
  }
  // An adapter may not turn a swallowed or omitted hook into qualification.
  if (hookFailure !== null) fail(hookFailure);
  if (!completed) fail('NORMAL_HOOK_UNPROVEN');
  return identity;
}
export async function runLinuxFinalLifecycle() {
  const contract = assertContainerContract();
  const nonce = process.env.TIBOTATTLE_LINUX_FINAL_NONCE, temporary = linuxFinalTemporary(nonce);
  const sampleLinuxStartupFuseMount = () => sampleLinuxMountProbeFacts(temporary);
  assertLinuxFinalOwnedPolicy({ nonce, name: process.env.TIBOTATTLE_LINUX_FINAL_PROFILE,
    profileText: await readFile('/proc/self/attr/current', 'utf8'), facts: await readLinuxMountRuntimeFacts() });
  if (process.arch !== 'x64' || process.getuid() !== 1000 || process.version !== 'v26.2.0'
    || process.env.ELECTRON_DISABLE_SANDBOX !== '0' || process.env.APPIMAGE_EXTRACT_AND_RUN !== undefined
    || (await lookup(HOST)).address !== '127.0.0.1'
    || !((await lstat('/dev/fuse')).isCharacterDevice())
    || proveLinuxSecretServiceContainerIsolation().status !== 'isolated') fail('ISOLATION_REQUIRED');
  const execution = await lstat(LINUX_FINAL_EXEC);
  if (!execution.isDirectory() || execution.isSymbolicLink() || execution.uid !== 1000
    || (execution.mode & 0o777) !== 0o700 || (await readdir(LINUX_FINAL_EXEC)).length) fail('ISOLATION_REQUIRED');
  const inputs = join(ROOT, LINUX_FINAL_INPUT);
  const pair = validateLinuxFinalPair(JSON.parse((await fingerprintLinuxFinalFile(join(inputs, 'pair.json'), 131072, true)).contents), contract.sourceRevision);
  for (const role of ['current', 'next']) {
    const file = await fingerprintLinuxFinalFile(join(inputs, pair.images[role].file));
    if (file.sha256 !== pair.images[role].sha256 || file.bytes !== pair.images[role].bytes) fail('INPUT_CHANGED');
  }
  if (startLinuxSecretServiceDaemon().status !== 'started') fail('SECRET_SERVICE_UNAVAILABLE');
  await mkdir(TEMP_ROOT, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  const key = join(LINUX_FINAL_EXEC, 'loopback.key'), cert = join(LINUX_FINAL_EXEC, 'loopback.crt');
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', key, '-out', cert]);
  let feedRequests = 0, imageRequests = 0, completedRejectedTransfers = 0, rejectChecksum = true, unexpectedRequests = 0, stage = 'loopback_tls';
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const route = linuxFinalFeedRequestPath(request.url);
    if (request.method !== 'GET' || request.headers.host !== HOST || route === null) { unexpectedRequests++; response.writeHead(404).end(); return; }
    if (route === 'feed') {
      feedRequests++;
      const selected = rejectChecksum ? { images: { next: { ...pair.images.next, sha512: Buffer.alloc(64).toString('base64') } } } : pair;
      response.writeHead(200, { 'content-type': 'application/yaml' }).end(realUpdaterFeed(selected)); return;
    }
    if (route === 'image') {
      imageRequests++;
      const rejectedTransfer = rejectChecksum;
      response.once('finish', () => { if (rejectedTransfer) completedRejectedTransfers++; });
      response.writeHead(200, { 'content-length': pair.images.next.bytes, 'content-type': 'application/octet-stream' });
      createReadStream(join(inputs, 'next.AppImage')).on('error', () => response.destroy()).pipe(response); return;
    }
    unexpectedRequests++; response.writeHead(404).end();
  });
  const receipt = { schemaVersion: 'tibotattle-linux-final-installed-lifecycle-v1',
    sourceRevision: pair.intake.sourceRevision, workflowRunnerRevision: pair.intake.runnerRevision,
    sourceCandidateSha256: pair.intake.sourceCandidateSha256, packageReceiptSha256: pair.intake.packageReceiptSha256,
    packageRunId: pair.intake.packageRunId, version: pair.intake.version, buildNumber: pair.intake.buildNumber,
    target: 'linux-x64', images: { current: pair.images.current.sha256, next: pair.images.next.sha256 },
    runtime: 'native_x64_Xvfb_FUSE_ordinary_AppImage_launcher', physicalDesktop: 'not_qualified',
    network: 'loopback_only_network_none', feed: 'fixed_production_URL_simulated_locally',
    credentialScope: 'disposable_Secret_Service', rebuilt: false, published: false };
  let child = null, dashboard = null, settings = null, upgradeFixture = null;
  let startupDiagnostic = null, predecessorStartupDiagnostics = null;
  const owned = [];
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', done); });
    stage = 'fresh_final_install';
    const clean = await fixtureWithDefaultProfile(); owned.push(clean);
    await trustFixture(clean, cert); await installImage(join(inputs, 'next.AppImage'), pair.images.next);
    const identity = { sourceRevision: pair.intake.runnerRevision, artifactSha256: pair.images.next.asarSha256 };
    const runNormal = (fixture, preferences, preserveState = null) => runLinuxFinalNormalJourney({
      run: beforeQuit => runOneNormalApp(identity, {
        appPath: IMAGE, environment: launchEnvironment(fixture, cert, temporary), fixture,
        preserveFixtureAfterCleanQuit: true, service: 'available', beforeQuit,
        run: options => runSmoke({ ...options, sampleStartupMount: sampleLinuxStartupFuseMount,
          onStartupDiagnostic: value => { startupDiagnostic = validateLinuxStartupDiagnostic(value); } }),
      }),
      readIdentity: () => currentApp(pair.images.next, temporary), assertSandbox: assertRendererSandbox,
      preferences, noUpdate: (context, browser) => proveNoUpdate(context.cdp, context.dashboardOrigin, browser), preserveState,
    });
    const cleanIdentity = await runNormal(clean, persistLinuxNormalPackagedRestartPreferences);
    await assertNoOwnedMounts(temporary);
    if (await alive(cleanIdentity)) fail('CLEAN_QUIT_FAILED');
    await checkedCheckpoint(clean);
    receipt.cleanInstallSmokePassed = true; receipt.localRefreshAndCredentialAccess = true;
    receipt.chromiumRendererSandboxVerified = true;
    await uninstallImage(pair.images.next, clean, temporary);
    receipt.cleanUninstallPreservedLocalState = true;
    stage = 'public_predecessor_install';
    upgradeFixture = await fixtureWithDefaultProfile(); owned.push(upgradeFixture);
    await trustFixture(upgradeFixture, cert); await installImage(join(inputs, 'current.AppImage'), pair.images.current);
    const environment = launchEnvironment(upgradeFixture, cert, temporary);
    const port = await freeTcpPort();
    child = spawn(IMAGE, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
      { env: environment, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', () => {});
    predecessorStartupDiagnostics = createLinuxStartupDiagnostics({ child, sampleMount: sampleLinuxStartupFuseMount });
    child.stderr.on('data', predecessorStartupDiagnostics.feed);
    dashboard = await connectUpdaterPage(port, url => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url));
    await wait(() => dashboard.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"));
    const previous = await currentApp(pair.images.current, temporary); await assertRendererSandbox(previous);
    await predecessorStartupDiagnostics.stop(); predecessorStartupDiagnostics = null;
    await persistLinuxNormalPackagedRestartPreferences({ cdp: dashboard });
    // Ordinary startup refresh must have reached the persisted keyed observation.
    const beforeScope = await wait(async () => { try { return await checkedCheckpoint(upgradeFixture); } catch { return null; } }, 60000);
    const rawFixture = join(upgradeFixture.codexHome, 'sessions/synthetic-linux-smoke.jsonl');
    const rawBefore = await digest(rawFixture);
    await dashboard.evaluate('globalThis.tibotattleDesktop.openSettings()');
    const origin = await dashboard.evaluate('location.origin');
    settings = await connectUpdaterPage(port, url => isLinuxUpdaterSettingsURL(url, origin));
    await wait(() => settings.evaluate("document.querySelector('#settings-tab-about') !== null"));
    const before = await settings.evaluate('globalThis.tibotattleDesktop.getSettings()');
    if (before.about.version !== pair.images.current.version) fail('PREDECESSOR_VERSION_INVALID');
    await settings.evaluate("document.querySelector('#settings-tab-about').click()");
    stage = 'checksum_refusal';
    if (before.about.automaticUpdates.enabled !== true) {
      const state = before.about.update;
      if (state.canCheck) await settings.evaluate("document.querySelector('#settings-check-for-updates').click()");
      await wait(async () => (await settings.evaluate('globalThis.tibotattleDesktop.getSettings()')).about.update.canDownload);
      await settings.evaluate("document.querySelector('#settings-download-update').click()");
    }
    const refused = await wait(async () => {
      const state = (await settings.evaluate('globalThis.tibotattleDesktop.getSettings()')).about.update;
      if (state.canInstall) fail('CHECKSUM_REFUSAL_UNPROVEN');
      return state.status === 'error' ? state : null;
    }, 120000);
    assertLinuxFinalChecksumRejection({ update: refused, installedSha256: await digest(IMAGE),
      expectedSha256: pair.images.current.sha256, completedTransfers: completedRejectedTransfers });
    receipt.mismatchedFeedChecksumRefusedWithoutReplacement = true;
    rejectChecksum = false;
    stage = 'settings_download';
    receipt.updateInitiation = await prepareLinuxUpdaterDownload({
      readUpdate: async () => (await settings.evaluate('globalThis.tibotattleDesktop.getSettings()')).about.update,
      automaticDownload: before.about.automaticUpdates.enabled === true,
      click: action => settings.evaluate(action === 'check' ? "document.querySelector('#settings-check-for-updates').click()" : "document.querySelector('#settings-download-update').click()"),
    });
    // Automatic download may precede Settings; require the overall actual transfer.
    if (imageRequests < 1) fail('UPDATE_TRANSFER_MISSING');
    await wait(() => settings.evaluate("(() => { const b=document.querySelector('#settings-install-update'); return b && !b.disabled && !b.hidden; })()"));
    stage = 'settings_install';
    const previousTree = await descendants(previous);
    if (previousTree.length < 2) fail('PREDECESSOR_CHILDREN_UNPROVEN');
    await settings.evaluate("setTimeout(() => document.querySelector('#settings-install-update').click(), 25)");
    await wait(async () => { try { return await digest(IMAGE) === pair.images.next.sha256; } catch { return false; } }, 60000);
    stage = 'automatic_restart';
    const successor = await currentApp(pair.images.next, temporary);
    if (successor.pid === previous.pid && successor.startTime === previous.startTime) fail('RESTART_IDENTITY_INVALID');
    await wait(() => updaterProcessHealth(successor.pid), 60000);
    await assertLinuxFinalProcessTreeGone(previousTree);
    await assertRendererSandbox(successor);
    if (await digest(rawFixture) !== rawBefore) fail('SOURCE_STATE_CHANGED');
    const persisted = JSON.parse(await readFile(join(upgradeFixture.userData, 'desktop-settings/desktop-settings-v1.json'), 'utf8'));
    if ((persisted.settings ?? persisted).refreshIntervalSeconds !== 900) fail('SETTINGS_NOT_PRESERVED');
    await stopOwned(successor, temporary);
    if (child) { await terminateLinuxSmokeChild(child).catch(() => {}); child = null; }
    dashboard.close(); dashboard = null; settings.close(); settings = null;
    receipt.publicPredecessorUpdate = 'exact_published_0.1.26_to_final_0.1.27';
    receipt.replacementAndAutomaticRestartVerified = true;
    stage = 'cold_restart_no_update';
    await runNormal(upgradeFixture, verifyLinuxNormalPackagedRestartPreferences, async () => {
      if (!isDeepStrictEqual(beforeScope, await checkedCheckpoint(upgradeFixture)) || await digest(rawFixture) !== rawBefore) fail('LOCAL_STATE_NOT_PRESERVED');
    });
    await assertNoOwnedMounts(temporary);
    receipt.coldRestartSettingsAndOptOutVerified = true;
    receipt.credentialAndSourceStatePreserved = true; receipt.noUpdateVerified = true;
    stage = 'owned_uninstall';
    await uninstallImage(pair.images.next, upgradeFixture, temporary);
    for (const fixture of owned) await rm(fixture.root, { recursive: true });
    owned.length = 0;
    receipt.ownedUninstallAndAppCleanupVerified = true;
    receipt.artifactIntegrityVerified = await digest(join(inputs, 'next.AppImage')) === pair.images.next.sha256;
    if (!receipt.artifactIntegrityVerified || unexpectedRequests !== 0) fail('UNEXPECTED_UPDATE_REQUEST');
    receipt.status = 'passed'; receipt.feedRequests = feedRequests; receipt.imageRequests = imageRequests;
    return receipt;
  } catch (error) {
    if (predecessorStartupDiagnostics !== null) {
      try { startupDiagnostic = await predecessorStartupDiagnostics.stop(); } catch { /* Diagnostic only. */ }
    }
    error.receipt = { ...receipt, status: 'failed', stage, ...linuxFinalFailureDetails(error.code, startupDiagnostic) };
    throw error;
  } finally {
    dashboard?.close(); settings?.close();
    // Stop only hash- and start-time-bound app processes. Container destruction
    // is the outer cleanup boundary if an app or mount cannot be proved gone.
    for (const expected of Object.values(pair.images)) {
      for (const identity of await ownedApps(expected, temporary).catch(() => [])) await stopOwned(identity, temporary).catch(() => {});
    }
    if (child) await terminateLinuxSmokeChild(child).catch(() => {});
    server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done));
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('LINUX_FINAL_LIFECYCLE_ARGUMENT_INVALID\n'); process.exitCode = 1; }
  else {
    try { process.stdout.write(`${JSON.stringify(await runLinuxFinalLifecycle())}\n`); }
    catch (error) { if (error.receipt) process.stdout.write(`${JSON.stringify(error.receipt)}\n`);
      process.stderr.write(`${/^LINUX_FINAL_LIFECYCLE_[A-Z_]+$/u.test(error.code ?? '') ? error.code : 'LINUX_FINAL_LIFECYCLE_RUNTIME_FAILED'}\n`); process.exitCode = 1; }
  }
}
