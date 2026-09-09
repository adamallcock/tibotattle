#!/usr/bin/env node
// Executes only the package-bound disposable Mac account against staging.
// No production installation, OS credential value, or raw record is exported.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectCdp, selectMacDashboardTarget, selectMacSettingsTarget, waitFor } from './smoke-electron-macos.mjs';
import { desktopFirstRunDialogCopy, validateDesktopFirstRunReceipt } from '../apps/electron/desktop-first-run.js';
import { classifyDesktopSharingInstallation } from '../apps/electron/desktop-sharing-installation.js';
import { verifySignedStagingLaunchInputs, prepareSignedStagingDisposableProfile, parseSignedStagingConsumerArguments } from './consume-signed-electron-staging.mjs';

export const SIGNED_STAGING_EXECUTION_SCHEMA = 'tibotattle-signed-staging-execution-v1';
const OPERATION = 10_000;
const STARTUP = 60_000;
const SYNC = 6 * 60_000;
function fail(stage) { throw Object.assign(new Error('SIGNED_STAGING_EXECUTION_FAILED'), { stage }); }
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseSignedStagingExecutionArguments(argv) {
  if (!Array.isArray(argv) || !['--execute-staging', '--execute-fresh-install'].includes(argv[0])) fail('arguments');
  return { ...parseSignedStagingConsumerArguments(argv.slice(1)),
    executionMode: argv[0] === '--execute-fresh-install' ? 'fresh_install' : 'seeded_upload' };
}

export function signedStagingChildEnvironment(parent, home, temporaryDirectory) {
  if (parent.GITHUB_ACTIONS !== 'true' || parent.RUNNER_ARCH !== 'ARM64'
      || parent.RUNNER_ENVIRONMENT !== 'github-hosted' || parent.RUNNER_OS !== 'macOS'
      || !home.startsWith('/') || !temporaryDirectory.startsWith('/')) fail('account');
  // No shell inheritance, alternate credential backend, control lane or endpoint.
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temporaryDirectory,
    LANG: 'en_US.UTF-8', GITHUB_ACTIONS: 'true', RUNNER_ARCH: 'ARM64',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS' };
}

export function signedStagingFixture(now = Date.now()) {
  const total = { input_tokens: 100, cached_input_tokens: 20,
    cache_write_input_tokens: 0, output_tokens: 24, reasoning_output_tokens: 8, total_tokens: 124 };
  const stamp = (offset) => new Date(now + offset).toISOString();
  return [
    { timestamp: stamp(-2000), type: 'session_meta', payload: { id: 'signed-staging-synthetic' } },
    { timestamp: stamp(-1000), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    ...[0, 1000].map((offset, index) => ({ timestamp: stamp(offset), type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v * (index + 1)])), last_token_usage: total },
      rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: {
        used_percent: 20 + index, window_minutes: 10080, resets_at: Math.floor((now + 7 * 86400000) / 1000),
      } },
    } })),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function processTable() {
  const result = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='],
    { encoding: 'utf8', timeout: OPERATION, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.trim().split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!m) fail('process_inventory');
    return { pid: +m[1], parent: +m[2], group: +m[3], command: m[4] };
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function json(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(OPERATION) });
  if (!response.ok) fail('local_response');
  const value = await response.text();
  if (Buffer.byteLength(value) > 1024 * 1024) fail('local_response');
  return JSON.parse(value);
}
function listenerOwned(pid, port) {
  try {
    const result = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'],
      { encoding: 'utf8', timeout: OPERATION, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.split('\n').includes('p' + pid) && result.split('\n').includes('n127.0.0.1:' + port);
  } catch { return false; }
}

// UI automation is confined to the PID whose executable and process group the
// launcher verified. No global keystrokes, injected dialog response or receipt.
export function signedStagingNativeIntroScript(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('native_intro_identity');
  const copies = ['en-US', 'zh-Hans', 'es'].map((locale) => {
    const copy = desktopFirstRunDialogCopy({ production: true, locale });
    return { message: copy.message, buttons: copy.buttons, checkbox: copy.checkboxLabel };
  });
  return `function run() {
    var events = Application('System Events');
    if (!events.uiElementsEnabled()) return 'unavailable';
    var matches = events.applicationProcesses.whose({ unixId: ${pid} })();
    if (matches.length !== 1) return 'waiting';
    var windows = matches[0].windows();
    if (windows.length > 3) return 'unexpected';
    var copies = ${JSON.stringify(copies)};
    var found = [];
    for (var w = 0; w < windows.length; w++) {
      var elements = windows[w].entireContents();
      if (elements.length > 500) return 'unexpected';
      var texts = elements.filter(function(e) { return e.role() === 'AXStaticText'; });
      var buttons = elements.filter(function(e) { return e.role() === 'AXButton'; });
      var checks = elements.filter(function(e) { return e.role() === 'AXCheckBox'; });
      for (var c = 0; c < copies.length; c++) {
        var copy = copies[c];
        if (!texts.some(function(e) { return e.value() === copy.message; })) continue;
        var next = buttons.filter(function(e) { return e.name() === copy.buttons[0]; });
        var quit = buttons.filter(function(e) { return e.name() === copy.buttons[1]; });
        var box = checks.filter(function(e) { return e.name() === copy.checkbox; });
        if (next.length !== 1 || quit.length !== 1 || box.length !== 1) return 'unexpected';
        found.push({ next: next[0], box: box[0] });
      }
    }
    if (found.length === 0) return 'waiting';
    if (found.length !== 1) return 'unexpected';
    var selected = found[0];
    if (selected.box.value() === 1) selected.box.click();
    if (selected.box.value() !== 0) return 'unexpected';
    selected.next.click();
    return 'continued';
  }`;
}

export function interpretSignedStagingNativeIntroResult(value) {
  if (value === 'continued') return true;
  if (value === 'waiting') return false;
  fail(value === 'unavailable' ? 'native_intro_automation_unavailable' : 'native_intro_unexpected');
}

async function continueNativeIntro(state, verified) {
  await waitFor(() => {
    if (state.stopped()) fail('native_intro_closed');
    const row = processTable().find((entry) => entry.pid === state.pid);
    if (row?.group !== state.pid || row.command !== verified.executable) fail('native_intro_identity');
    let result;
    try {
      result = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', signedStagingNativeIntroScript(state.pid)],
        { encoding: 'utf8', timeout: OPERATION, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { fail('native_intro_automation_unavailable'); }
    return interpretSignedStagingNativeIntroResult(result);
  }, STARTUP, 'native introduction');
  state.nativeIntroContinued = true;
}

export function assertSignedStagingFreshProjection(sharing, receipt) {
  validateDesktopFirstRunReceipt(receipt);
  if (sharing?.enabled !== true || sharing.basis !== 'default_on') fail('fresh_classification');
  return true;
}

async function launch(verified, environment, { untouched = false } = {}) {
  // Same-identity handover/SingleInstanceLock must never attach to a pre-existing app.
  if (processTable().some((row) => /\/TiboTattle(?: Dev)?\.app\/Contents\/MacOS\/TiboTattle(?: Dev)?$/u.test(row.command))) fail('preexisting_app');
  const port = await freePort();
  const child = spawn(verified.executable, ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
    { cwd: verified.appPath, env: environment, detached: true, stdio: 'ignore' });
  let exited = false;
  let spawnFailed = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { spawnFailed = true; });
  const state = { child, pid: child.pid, sessions: [], groupVerified: false,
    stopped: () => exited || spawnFailed };
  try {
    await waitFor(() => {
      if (state.stopped()) fail('startup');
      const row = processTable().find((entry) => entry.pid === child.pid);
      return row?.group === child.pid && row.command === verified.executable;
    }, OPERATION, 'process group');
    state.groupVerified = true;
    if (untouched) await continueNativeIntro(state, verified);
    await waitFor(() => listenerOwned(child.pid, port), STARTUP, 'owned debugger');
    const target = await waitFor(async () => selectMacDashboardTarget(await json(`http://127.0.0.1:${port}/json/list`), port), STARTUP, 'dashboard target');
    const dashboard = await connectCdp(target);
    state.sessions.push(dashboard);
    await waitFor(() => dashboard.evaluate('document.readyState === "complete" && document.title === "TiboTattle" && typeof globalThis.tibotattleDesktop?.getSharingPreference === "function"'), STARTUP, 'dashboard ready');
    // Settings methods remain restricted to the actual Settings frame.
    await dashboard.evaluate('globalThis.tibotattleDesktop.openSettings()');
    const origin = new URL(target.url).origin;
    const settingsTarget = await waitFor(async () => selectMacSettingsTarget(await json(`http://127.0.0.1:${port}/json/list`), origin, port), STARTUP, 'settings target');
    state.settings = await connectCdp(settingsTarget);
    state.sessions.push(state.settings);
    await waitFor(() => state.settings.evaluate('typeof globalThis.tibotattleDesktop?.getSharingPreference === "function"'), STARTUP, 'settings ready');
    state.readSharing = () => state.settings.evaluate('globalThis.tibotattleDesktop.getSharingPreference()');
    return state;
  } catch (error) {
    const stopped = await stop(state);
    error.ownedMacProcessesStopped = stopped === true;
    throw error;
  }
}

async function stop(state, { processTableImpl = processTable } = {}) {
  if (!state) return true;
  for (const session of state.sessions) session.close();
  if (!state.groupVerified) {
    if (!state.stopped()) state.child.kill('SIGTERM');
    await waitFor(state.stopped, OPERATION, 'unstarted process stop');
    // The child may have spawned descendants before group identity was observed.
    // Do not signal unverified descendants or claim that stopping one PID removed them.
    if (processTableImpl().some((row) => row.group === state.pid)) fail('unverified_group_remaining');
    return true;
  }
  // This is an explicitly recorded controlled process restart, not a native menu-quit proof.
  if (processTableImpl().some((row) => row.group === state.pid)) {
    try { process.kill(-state.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  try { await waitFor(() => !processTableImpl().some((row) => row.group === state.pid), OPERATION, 'group stop'); }
  catch {
    try { process.kill(-state.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await waitFor(() => !processTableImpl().some((row) => row.group === state.pid), OPERATION, 'group cleanup');
  }
  return true;
}

async function bindingDigest(root) {
  const path = join(root, 'companion-state', 'accountless-device-binding-v1.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.uid !== process.getuid()) fail('binding');
  const bytes = await readFile(path);
  try { return createHash('sha256').update(bytes).digest('hex'); }
  finally { bytes.fill(0); }
}

export async function runSignedStagingExecution(options) {
  const proof = { schemaVersion: SIGNED_STAGING_EXECUTION_SCHEMA, status: 'failed',
    sourceRevision: options.sourceRevision, asarSha256: options.asarSha256,
    executionMode: options.executionMode ?? 'seeded_upload', untouchedProfile: false,
    nativeIntroContinued: false, freshDefaultOnObserved: false,
    signedArtifactVerified: false, seededDefaultOn: false, automaticAcceptedUpload: false,
    credentialReuseAfterRestart: false, durableOptOut: false, controlledRestart: false,
    nativeCleanQuitQualified: false, ownedProcessesStopped: false, failureStage: null, failureCode: null };
  let active;
  let stage = 'artifact';
  try {
    const verified = await verifySignedStagingLaunchInputs(options);
    proof.signedArtifactVerified = true;
    stage = 'profile';
    if (!['seeded_upload', 'fresh_install'].includes(proof.executionMode)) fail('arguments');
    const untouched = proof.executionMode === 'fresh_install';
    const seed = await prepareSignedStagingDisposableProfile({ metadata: verified.metadata,
      initialSharing: untouched ? 'untouched' : 'fresh' });
    const temporary = join(seed.profileRoot, 'temporary');
    const sessions = join(seed.runtimeProfileRoot, 'synthetic-home', '.codex', 'sessions');
    await mkdir(temporary, { mode: 0o700 });
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await writeFile(join(sessions, 'rollout-signed-staging-synthetic.jsonl'), signedStagingFixture(), { mode: 0o600, flag: 'wx' });
    const environment = signedStagingChildEnvironment(process.env, userInfo().homedir, temporary);
    proof.seededDefaultOn = !untouched;
    if (untouched) {
      stage = 'fresh_profile';
      if (await classifyDesktopSharingInstallation({ profileRoot: seed.runtimeProfileRoot,
        stateRoot: join(seed.runtimeProfileRoot, 'companion-state'), legacyStateRoots: [] }) !== 'fresh') fail('fresh_profile');
      proof.untouchedProfile = true;
      stage = 'native_intro';
      active = await launch(verified, environment, { untouched: true });
      proof.nativeIntroContinued = active.nativeIntroContinued === true;
      stage = 'fresh_classification';
      const receiptPath = join(seed.settingsRoot, 'desktop-first-run-v1.json');
      const metadata = await lstat(receiptPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
        || metadata.size > 4096 || metadata.nlink !== 1) fail('fresh_classification');
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      proof.freshDefaultOnObserved = assertSignedStagingFreshProjection(await active.readSharing(), receipt);
    }
    stage = 'automatic_upload';
    // Fresh-install reaches this point through the real native Continue path.
    // Keep that verified owned process alive so the same untouched profile
    // performs the first automatic upload before the controlled restart below.
    active ??= await launch(verified, environment);
    const accepted = await waitFor(async () => {
      const value = await active.readSharing();
      return value?.enabled === true && value.basis === 'default_on'
        && value.transportStatus === 'up_to_date' && typeof value.lastAcceptedAt === 'string' ? value : null;
    }, SYNC, 'accepted automatic upload');
    proof.automaticAcceptedUpload = Boolean(accepted);
    const identity = await bindingDigest(seed.runtimeProfileRoot);
    await stop(active); active = null;
    stage = 'credential_restart';
    active = await launch(verified, environment);
    proof.controlledRestart = true;
    await waitFor(async () => (await active.readSharing())?.transportStatus === 'up_to_date', SYNC, 'authenticated restart');
    if (await bindingDigest(seed.runtimeProfileRoot) !== identity) fail('binding_changed');
    proof.credentialReuseAfterRestart = true;
    stage = 'opt_out';
    await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)');
    await waitFor(async () => { const v = await active.readSharing(); return v?.enabled === false && v.transportStatus === 'off'; }, OPERATION, 'opt out');
    await stop(active); active = null;
    active = await launch(verified, environment);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = await active.readSharing();
      if (value?.enabled !== false || value.transportStatus !== 'off' || value.lastAcceptedAt !== null) fail('opt_out_restart');
      await delay(1000);
    }
    if (await bindingDigest(seed.runtimeProfileRoot) !== identity) fail('binding_changed');
    proof.durableOptOut = true;
    await stop(active); active = null;
    proof.ownedProcessesStopped = true;
    proof.status = 'passed';
  } catch (error) {
    const knownCodes = ['ACCOUNT_CONTEXT_INVALID', 'APP_INVALID', 'ARCHIVE_INVALID', 'ARTIFACT_DIGEST_INVALID', 'ARTIFACT_INVALID', 'INPUT_INVALID', 'METADATA_INVALID', 'OPT_OUT_INVALID', 'PROFILE_NOT_FRESH', 'PROFILE_UNSAFE', 'SIGNATURE_INVALID', 'TARGET_INVALID'];
    const prefix = 'ELECTRON_SIGNED_STAGING_CONSUMER_';
    proof.failureCode = knownCodes.map((code) => prefix + code).includes(error?.code) ? error.code : null;
    proof.failureStage = ['arguments', 'account', 'process_inventory', 'preexisting_app', 'binding', 'binding_changed', 'opt_out_restart', 'native_intro_identity', 'native_intro_closed', 'native_intro_unexpected', 'native_intro_automation_unavailable', 'fresh_profile', 'fresh_classification'].includes(error?.stage) ? error.stage : stage;
  } finally {
    if (active) { try { proof.ownedProcessesStopped = await stop(active); } catch { proof.ownedProcessesStopped = false; proof.status = 'failed'; } }
  }
  return proof;
}
// Shared qualification mechanics only. Callers must verify their own signed
// artifact and account/profile boundary before launch; staging intake stays closed.
export { launch as launchVerifiedMacSharingApp, stop as stopOwnedMacSharingApp };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await runSignedStagingExecution(parseSignedStagingExecutionArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(receipt) + '\n');
    if (receipt.status !== 'passed') process.exitCode = 1;
  } catch { process.stderr.write('SIGNED_STAGING_EXECUTION_FAILED\n'); process.exitCode = 1; }
}
