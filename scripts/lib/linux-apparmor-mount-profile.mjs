// Controlled profile generation for a disposable mount-only comparison.
// Moby v28.0.4 at 6430e49a55babd9b8f4d08e70ecb2b68900770fe; Apache-2.0.
// https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/profiles/apparmor/template.go
// Generator: profiles/apparmor/apparmor.go, SHA256
// 8318df09d9d783ddd7caf27d1725f500f7028e65bd7bec87c8a27940c715edc5.
// This is a reviewed source basis, never a reconstruction of loaded docker-default.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintLinuxFinalFile } from '../qualify-electron-linux-installed-lifecycle.mjs';

export const LINUX_APPARMOR_COMPARISON_SCHEMA = 'tibotattle-linux-apparmor-mount-comparison-v4';
export const LINUX_APPARMOR_COMPARISON_CONFIRMATION = 'RUN_DISPOSABLE_LINUX_APPARMOR_MOUNT_COMPARISON';
export const LINUX_APPARMOR_DOCKER_VERSION = '28.0.4';
const PARSER = '/usr/sbin/apparmor_parser';
const PARSER_CONFIG = '/etc/apparmor/parser.conf';
const ABI40 = '/etc/apparmor.d/abi/4.0';
const IMAGE = '/opt/tibotattle-updater-exec/TiboTattle.AppImage';
const EXEC = '/opt/tibotattle-updater-exec';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const refused = code => { throw Object.assign(new Error('LINUX_APPARMOR_COMPARISON_REFUSED'), { code }); };
const digest = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const token = value => /^[a-f0-9]{32}$/u.test(value ?? '');
const stages = ['baseline', 'candidate'];
const basisFailures = new Set(['docker_version_unmatched', 'parser_unavailable', 'daemon_profile_unavailable', 'template_invalid', 'imports_unavailable', 'basis_unavailable']);
const importFailures = new Set(['unknown', 'optional_import_unsafe', 'optional_import_unavailable',
  'parser_config_unavailable', 'parser_config_unsafe', 'parser_config_unsupported', 'parser_config_changed',
  'parser_config_resolution_unavailable', 'abi_unavailable', 'abi_unsafe', 'abi_missing', 'abi_changed',
  'preprocess_failed', 'expanded_invalid', 'include_remaining', 'abi_directive_unsupported',
  'all_permission_unsupported', 'mount_rule_unsupported', 'profile_shape_unsupported']);
const importRefused = importFailure => {
  throw Object.assign(new Error('LINUX_APPARMOR_COMPARISON_REFUSED'), { code: 'imports_unavailable', importFailure });
};
export const LINUX_APPARMOR_TEMPLATE_SHA256 = '42130ca5908f45263facef820961d9e1a988e82f8a2937f4658e7bcccc96cc07';

// A closed observed tuple is input to generation, never an arbitrary audit string.
export function normalizeLinuxAppArmorMountTuple(fields) {
  const type = fields?.fstype, source = fields?.srcname;
  const options = typeof fields?.flags === 'string' ? fields.flags.split(',').map(part => part.trim()) : [];
  if (new Set(options).size !== 3 || options.length !== 3 || !['ro', 'nosuid', 'nodev'].every(option => options.includes(option))) return null;
  const kind = type === 'fuse.squashfuse' && source === 'squashfuse' ? 'squashfuse'
    : ['fuse.TiboTattle.AppImage', 'fuse'].includes(type) && [IMAGE, 'TiboTattle.AppImage'].includes(source) ? type === 'fuse' ? 'fuse' : 'appimage' : null;
  if (kind === null) return null;
  return { type: kind, source: source === 'squashfuse' ? 'squashfuse' : source === IMAGE ? 'image_absolute' : 'image_basename',
    options: ['ro', 'nosuid', 'nodev'] };
}
export function validateLinuxAppArmorMountTuple(value) {
  if (!exact(value, ['type', 'source', 'options']) || !Array.isArray(value.options)
    || JSON.stringify(value.options) !== '["ro","nosuid","nodev"]') return null;
  return value.type === 'squashfuse' && value.source === 'squashfuse'
    || ['appimage', 'fuse'].includes(value.type) && ['image_absolute', 'image_basename'].includes(value.source) ? value : null;
}
export function linuxAppArmorProfileName({ run, nonce, stage }) {
  if (!/^[1-9][0-9]{0,14}$/u.test(run ?? '') || !token(nonce) || !stages.includes(stage)) refused('basis_unavailable');
  return `tibotattle-mount-${stage}-${run}-${nonce}`;
}
function validName(name) { return /^tibotattle-mount-(baseline|candidate)-[1-9][0-9]{0,14}-[a-f0-9]{32}$/u.test(name ?? ''); }
export function renderLinuxAppArmorBasis(template, { name, daemonProfile, globalImport, baseImport }) {
  if (sha256(template) !== LINUX_APPARMOR_TEMPLATE_SHA256 || !validName(name)
    || !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(daemonProfile ?? '')
    || typeof globalImport !== 'boolean' || typeof baseImport !== 'boolean') refused('template_invalid');
  const match = /^const baseTemplate = `([\s\S]*)`\n?$/mu.exec(template);
  if (!match) refused('template_invalid');
  const rendered = match[1]
    .replace('{{range $value := .Imports}}\n{{$value}}\n{{end}}', globalImport ? '\n#include <tunables/global>\n' : '\n@{PROC}=/proc/\n')
    .replace('{{range $value := .InnerImports}}\n  {{$value}}\n{{end}}', baseImport ? '\n  #include <abstractions/base>\n' : '')
    .replaceAll('{{.Name}}', name).replaceAll('{{.DaemonProfile}}', daemonProfile);
  if (rendered.includes('{{') || rendered.split('  deny mount,').length !== 2) refused('template_invalid');
  return rendered;
}
export function linuxAppArmorMountRule(tuple, nonce) {
  if (!validateLinuxAppArmorMountTuple(tuple) || !token(nonce)) refused('template_invalid');
  const type = { squashfuse: 'fuse.squashfuse', appimage: 'fuse.TiboTattle.AppImage', fuse: 'fuse' }[tuple.type];
  const source = { squashfuse: 'squashfuse', image_absolute: IMAGE, image_basename: 'TiboTattle.AppImage' }[tuple.source];
  return `  mount fstype=${type} options=(ro,nosuid,nodev) "${source}" -> "${EXEC}/tmp/${nonce}/.mount_*/",`;
}
// AppArmor 4 preserves ABI directives in --preprocess output. Keep their exact
// location and bytes, and bind the file consumed by the default search path.
// https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/parser_yacc.y#L1660
export function deriveLinuxAppArmorProfile(expanded, { baselineName, name, stage, tuple, nonce, imports = null }) {
  if (typeof expanded !== 'string' || Buffer.byteLength(expanded) > 1048576 || !validName(baselineName) || !validName(name)
    || !stages.includes(stage)) importRefused('expanded_invalid');
  if (/^\s*(?:#\s*)?include\b/mu.test(expanded)) importRefused('include_remaining');
  const lines = expanded.split('\n').map(line => line.replace(/#.*$/u, '').trim());
  for (const line of lines.filter(line => /\babi\b/u.test(line))) {
    if (line !== 'abi <abi/4.0>,') importRefused('abi_directive_unsupported');
    if (!validImportBinding(imports) || imports.abi40Sha256 === null) importRefused('abi_missing');
  }
  // Refuse any imported mount/remount permission. A narrowly scoped allow can
  // replace a blanket denial only when there is no second mount rule.
  const rules = lines.filter(line => /^(?:(?:audit|allow|deny)\s+)*(?:mount|remount)\b/u.test(line));
  const tokens = expanded.replaceAll(baselineName, 'PROFILE').split('\n').map(line => line.replace(/#.*$/u, '')).join('\n');
  if (/\ball\s*,/u.test(tokens)) importRefused('all_permission_unsupported');
  if ((tokens.match(/\b(?:mount|remount)\b/gu) ?? []).length !== 1 || rules.length !== 1 || rules[0] !== 'deny mount,') importRefused('mount_rule_unsupported');
  if (expanded.split(`profile ${baselineName} `).length !== 2
    || (expanded.match(/^\s*profile\s/gmu) ?? []).length !== 1) importRefused('profile_shape_unsupported');
  const replacement = stage === 'baseline' ? '  audit deny mount,' : linuxAppArmorMountRule(tuple, nonce);
  return expanded.replaceAll(baselineName, name).replace(/^[ \t]*deny mount,$/mu, replacement);
}
function validImportBinding(value) {
  return exact(value, ['parserConfigSha256', 'abi40Sha256'])
    && ['parserConfigSha256', 'abi40Sha256'].every(key => value[key] === null || digest(value[key]));
}
// Only these canonical root-owned inputs are admitted. Missing files are
// distinguished from unreadable/unsafe files; absence is rechecked as well.
export async function readLinuxAppArmorRootImport(kind, io = { lstat, realpath, open }) {
  if (!['parser_config', 'abi'].includes(kind)) importRefused('unknown');
  const path = kind === 'parser_config' ? PARSER_CONFIG : ABI40;
  const parents = kind === 'parser_config' ? ['/etc', '/etc/apparmor'] : ['/etc', '/etc/apparmor.d', '/etc/apparmor.d/abi'];
  const maximum = 65536;
  const safe = stat => stat.uid === 0n && !stat.isSymbolicLink() && (stat.mode & 0o022n) === 0n;
  const checkParents = async () => {
    for (const parent of parents) {
      const stat = await io.lstat(parent, { bigint: true });
      if (!stat.isDirectory() || !safe(stat) || await io.realpath(parent) !== parent) importRefused(`${kind}_unsafe`);
    }
  };
  try {
    await checkParents();
    let before;
    try { before = await io.lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const same = stat => safe(stat) && stat.isFile() && stat.nlink === 1n
      && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode'].every(key => stat[key] === before[key]);
    if (!same(before) || before.size < 0n || before.size > BigInt(maximum)
      || kind === 'abi' && before.size === 0n || await io.realpath(path) !== path) importRefused(`${kind}_unsafe`);
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(await handle.stat({ bigint: true }))) importRefused(`${kind}_unsafe`);
      const bytes = Buffer.alloc(maximum + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== Number(before.size) || !same(await handle.stat({ bigint: true }))
        || !same(await io.lstat(path, { bigint: true }))) importRefused(`${kind}_unsafe`);
      await checkParents();
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'imports_unavailable') throw error;
    importRefused(`${kind}_unavailable`);
  }
}
export async function readLinuxAppArmorImportBinding({ read = readLinuxAppArmorRootImport } = {}) {
  const config = await read('parser_config');
  // The default config is absent or comments only. Any active option may change
  // search, ABI, enforcement or compilation semantics and is not normalized.
  // Its fgets buffer holds 255 bytes: an overlong comment's next chunk can be
  // parsed as an option. Keep each physical line plus newline in one record.
  if (config !== null && (!Buffer.isBuffer(config) || config.length > 65536 || config.includes(0)
    || !config.toString('utf8').split('\n').every(line => Buffer.byteLength(line) <= 254 && /^[ \t\r]*(?:#.*)?$/u.test(line)))) importRefused('parser_config_unsupported');
  const abi = await read('abi');
  if (abi !== null && (!Buffer.isBuffer(abi) || abi.length === 0 || abi.length > 65536)) importRefused('abi_unsafe');
  return { parserConfigSha256: config === null ? null : sha256(config), abi40Sha256: abi === null ? null : sha256(abi) };
}
export async function withLinuxAppArmorImportBinding(expected, operation, { read = readLinuxAppArmorImportBinding } = {}) {
  if (!validImportBinding(expected)) importRefused('unknown');
  const verify = async () => {
    const actual = await read();
    if (!validImportBinding(actual)) importRefused('unknown');
    if (actual.parserConfigSha256 !== expected.parserConfigSha256) importRefused('parser_config_changed');
    if (actual.abi40Sha256 !== expected.abi40Sha256) importRefused('abi_changed');
  };
  await verify();
  try { return await operation(); } finally { await verify(); }
}
export function linuxAppArmorPrivilegedArguments(args) {
  if (!Array.isArray(args) || args[0] !== '-n' || ![PARSER, 'python3', 'env', 'cat'].includes(args[1])) refused('basis_unavailable');
  return ['-n', 'timeout', '--signal=TERM', '--kill-after=2s', '10s', ...args.slice(1)];
}
function invoke(file, args, { input, maximum = 1048576, timeout = 15000 } = {}) {
  // Bound the privileged descendant itself, not only its sudo controller.
  // The root-owned TERM/KILL deadline expires before the outer 15-second wait.
  if (file === 'sudo') args = linuxAppArmorPrivilegedArguments(args);
  const result = spawnSync(file, args, { shell: false, input, encoding: 'utf8', timeout, maxBuffer: maximum, stdio: ['pipe', 'pipe', 'ignore'] });
  if (result.error || result.signal || result.status !== 0) refused('basis_unavailable');
  return result.stdout;
}
async function ownedFile(path, maximum = 1048576) {
  const stat = await lstat(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) refused('basis_unavailable');
  return fingerprintLinuxFinalFile(path, maximum, true);
}
async function writeNew(path, value) {
  if (await realpath(join(path, '..')) !== join(path, '..')) refused('basis_unavailable');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function parserIdentity() {
  const stat = await lstat(PARSER);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) refused('parser_unavailable');
  const fingerprint = await fingerprintLinuxFinalFile(PARSER, 16777216);
  const text = invoke(PARSER, ['--version'], { maximum: 4096 });
  const version = /^AppArmor parser version ([0-9]+\.[0-9]+\.[0-9]+)(?:\n|$)/u.exec(text)?.[1];
  if (!version) refused('parser_unavailable');
  return { version, sha256: fingerprint.sha256 };
}
// Reads only the systemd-owned daemon identity; no default is substituted when
// its profile cannot be read. Private identity/profile text never enters a receipt.
const DAEMON_PROFILE = String.raw`
import json, os, sys
pid = sys.argv[1]
if not pid.isdecimal() or int(pid) < 1: raise ValueError()
def read(name, limit=4096):
    with open('/proc/' + pid + '/' + name, 'r') as f: value = f.read(limit + 1)
    if len(value) > limit: raise ValueError()
    return value
before = read('stat')
if read('comm') != 'dockerd\n': raise ValueError()
profile = read('attr/current').strip().split(' ')[0]
if read('stat').rsplit(')', 1)[1].split()[19] != before.rsplit(')', 1)[1].split()[19]: raise ValueError()
print(json.dumps({'profile': profile}, separators=(',', ':')))
`;
export const LINUX_APPARMOR_DAEMON_READER = DAEMON_PROFILE;
async function optionalImport(path) {
  try { const stat = await lstat(path); if (stat.uid !== 0 || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) importRefused('optional_import_unsafe'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; if (error.code === 'imports_unavailable') throw error; importRefused('optional_import_unavailable'); }
}
function profileState(name) {
  const lines = invoke('sudo', ['-n', 'cat', '/sys/kernel/security/apparmor/profiles'], { maximum: 1048576 }).trim().split('\n');
  const matches = lines.filter(line => line.startsWith(`${name} `));
  if (!matches.length) return 'absent';
  if (matches.length === 1 && matches[0] === `${name} (enforce)`) return 'enforce';
  return 'unavailable';
}
export async function prepareLinuxAppArmorProfiles({ root, directory, run, runner, nonce }) {
  const baselineName = linuxAppArmorProfileName({ run, nonce, stage: 'baseline' });
  if (!/^[a-f0-9]{40}$/u.test(runner ?? '') || await realpath(directory) !== directory) refused('basis_unavailable');
  const dockerVersion = invoke('docker', ['version', '--format', '{{.Server.Version}}'], { maximum: 4096 }).trim();
  if (dockerVersion !== LINUX_APPARMOR_DOCKER_VERSION) refused('docker_version_unmatched');
  const parser = await parserIdentity();
  const template = (await fingerprintLinuxFinalFile(join(root, 'scripts/assets/moby-apparmor-v28.0.4-template.txt'), 16384, true)).contents.toString('utf8');
  let daemon;
  try {
    const pid = invoke('systemctl', ['show', '--property=MainPID', '--value', 'docker'], { maximum: 128 }).trim();
    if (!/^[1-9][0-9]{0,9}$/u.test(pid)) refused('daemon_profile_unavailable');
    daemon = JSON.parse(invoke('sudo', ['-n', 'python3', '-c', DAEMON_PROFILE, pid], { maximum: 8192 }));
    if (!exact(daemon, ['profile'])) refused('daemon_profile_unavailable');
  } catch { refused('daemon_profile_unavailable'); }
  const globalImport = await optionalImport('/etc/apparmor.d/tunables/global'), baseImport = await optionalImport('/etc/apparmor.d/abstractions/base');
  const rendered = renderLinuxAppArmorBasis(template, { name: baselineName, daemonProfile: daemon.profile, globalImport, baseImport });
  const imports = await readLinuxAppArmorImportBinding();
  const expanded = await withLinuxAppArmorImportBinding(imports, () => {
    // Verify this installed parser's default before relying on its search path.
    // --version exits before policy processing; --print-config-file alone does not.
    try { if (!invoke(PARSER, ['--print-config-file', '--version'], { maximum: 4096 })
      .startsWith(`${PARSER_CONFIG}\nAppArmor parser version ${parser.version}\n`)) importRefused('parser_config_resolution_unavailable'); }
    catch { importRefused('parser_config_resolution_unavailable'); }
    try { return invoke(PARSER, ['--preprocess', '--skip-cache'], { input: rendered }); }
    catch { importRefused('preprocess_failed'); }
  });
  // Preprocess once, then load these same flattened bytes for both profiles.
  deriveLinuxAppArmorProfile(expanded, { baselineName, name: baselineName, stage: 'baseline', imports });
  if ((await parserIdentity()).sha256 !== parser.sha256) refused('parser_unavailable');
  const privateDirectory = join(directory, '.mount-apparmor');
  await mkdir(privateDirectory, { mode: 0o700 });
  const basis = { dockerVersion, parserVersion: parser.version, parserSha256: parser.sha256, templateSha256: sha256(template),
    renderedSha256: sha256(rendered), expandedSha256: sha256(expanded), daemonProfileSha256: sha256(daemon.profile),
    globalImport, baseImport, imports, loadedDefaultPolicyVerified: false };
  const owner = { run, runner, nonce, parserSha256: parser.sha256, baselineName, imports };
  await writeNew(join(privateDirectory, 'owner.json'), JSON.stringify(owner));
  const loaded = new Map(), evidence = { baseline: null, candidate: null };
  const controller = { basis, evidence, async load(stage, tuple = null) {
    const name = linuxAppArmorProfileName({ run, nonce, stage });
    if (loaded.has(stage) || profileState(name) !== 'absent') refused('basis_unavailable');
    const text = deriveLinuxAppArmorProfile(expanded, { baselineName, name, stage, tuple, nonce, imports });
    const path = join(privateDirectory, `${stage}.profile`);
    await writeNew(path, text);
    if ((await parserIdentity()).sha256 !== parser.sha256) refused('parser_unavailable');
    const names = await withLinuxAppArmorImportBinding(imports, () => invoke(PARSER, ['--names', '--skip-cache'], { input: text }));
    if (names.trim() !== name) refused('template_invalid');
    // --add refuses an existing profile; --replace is intentionally absent.
    const row = { profileSha256: sha256(text), profileNameSha256: sha256(name), loaded: false, removed: false };
    evidence[stage] = row; loaded.set(stage, { name, text, evidence: row });
    await withLinuxAppArmorImportBinding(imports, async () => {
      invoke('sudo', ['-n', PARSER, '--add', '--skip-cache'], { input: text });
      row.loaded = true;
      // Persist successful add ownership before a post-command binding refusal.
      await writeNew(join(privateDirectory, `${stage}.loaded.json`), JSON.stringify({ ...owner, stage, name, sha256: row.profileSha256 }));
    });
    if (profileState(name) !== 'enforce') refused('basis_unavailable');
    return { name, evidence: row };
  }, async remove(stage, containersGone) {
    if (!containersGone) return false;
    const entry = loaded.get(stage);
    if (!entry) return true;
    if (profileState(entry.name) === 'absent') { entry.evidence.removed = true; return true; }
    if (!entry.evidence.loaded || (await parserIdentity()).sha256 !== parser.sha256
      || profileState(entry.name) !== 'enforce' || !profileActorsGone(entry.name)) return false;
    const saved = await ownedFile(join(privateDirectory, `${stage}.profile`));
    if (saved.sha256 !== entry.evidence.profileSha256) return false;
    await withLinuxAppArmorImportBinding(imports, () => invoke('sudo', ['-n', PARSER, '--remove', '--skip-cache'], { input: saved.contents }));
    entry.evidence.removed = profileState(entry.name) === 'absent';
    return entry.evidence.removed;
  } };
  return controller;
}
export function linuxAppArmorBasisFailure(error) { return basisFailures.has(error?.code) ? error.code : 'basis_unavailable'; }
export function linuxAppArmorImportFailure(error) {
  return error?.code !== 'imports_unavailable' ? 'none' : importFailures.has(error.importFailure) ? error.importFailure : 'unknown';
}

export const LINUX_APPARMOR_PROFILE_ACTORS = String.raw`
import json, os
name = os.environ.get('TIBOTATTLE_OWNED_PROFILE')
result = 'unavailable'
try:
    if not name or len(name) > 128: raise ValueError()
    pids = [value for value in os.listdir('/proc') if value.isdecimal()]
    if len(pids) > 4096: raise ValueError()
    active = False
    for pid in pids:
        try:
            with open('/proc/' + pid + '/attr/current', 'r') as f: current = f.read(257)
            if len(current) > 256: raise ValueError()
            if current.strip() == name + ' (enforce)': active = True
        except (FileNotFoundError, ProcessLookupError): pass
    result = not active
except Exception: pass
print(json.dumps(result))
`;
function profileActorsGone(name) {
  // The fixed read-only helper receives the private profile through a validated
  // env argument; no shell interpolation or raw profile output is involved.
  return JSON.parse(invoke('sudo', ['-n', 'env', `TIBOTATTLE_OWNED_PROFILE=${name}`, 'python3', '-c', LINUX_APPARMOR_PROFILE_ACTORS], { maximum: 128 })) === true;
}

export function linuxAppArmorRemovalAllowed({ owner, marker, profileSha256, currentState, actorsGone },
  { run, runner, parserSha256, stage }) {
  if (!stages.includes(stage) || !exact(owner, ['run', 'runner', 'nonce', 'parserSha256', 'baselineName', 'imports'])
    || !validImportBinding(owner.imports) || owner.run !== run || owner.runner !== runner || owner.parserSha256 !== parserSha256 || !token(owner.nonce)
    || !/^[1-9][0-9]{0,14}$/u.test(run ?? '') || !/^[a-f0-9]{40}$/u.test(runner ?? '') || !digest(parserSha256)) return false;
  const name = linuxAppArmorProfileName({ run, nonce: owner.nonce, stage });
  return owner.baselineName === linuxAppArmorProfileName({ run, nonce: owner.nonce, stage: 'baseline' })
    && exact(marker, [...Object.keys(owner), 'stage', 'name', 'sha256']) && Object.keys(owner).every(key => JSON.stringify(marker[key]) === JSON.stringify(owner[key]))
    && marker.stage === stage && marker.name === name && digest(marker.sha256) && marker.sha256 === profileSha256
    && currentState === 'enforce' && actorsGone === true;
}

export async function cleanupLinuxAppArmorProfiles({ directory, run, runner, containersGone }) {
  if (!containersGone) return false;
  const privateDirectory = join(directory, '.mount-apparmor');
  let stat;
  try { stat = await lstat(privateDirectory); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
    || await realpath(privateDirectory) !== privateDirectory) refused('basis_unavailable');
  const owner = JSON.parse((await ownedFile(join(privateDirectory, 'owner.json'), 2048)).contents);
  if (!exact(owner, ['run', 'runner', 'nonce', 'parserSha256', 'baselineName', 'imports']) || owner.run !== run || owner.runner !== runner
    || !validImportBinding(owner.imports) || !token(owner.nonce) || owner.baselineName !== linuxAppArmorProfileName({ run, nonce: owner.nonce, stage: 'baseline' })
    || (await parserIdentity()).sha256 !== owner.parserSha256) refused('basis_unavailable');
  for (const stage of [...stages].reverse()) {
    const name = linuxAppArmorProfileName({ run, nonce: owner.nonce, stage });
    if (profileState(name) === 'absent') continue;
    // A prepared definition alone is not evidence that this invocation added it.
    const marker = JSON.parse((await ownedFile(join(privateDirectory, `${stage}.loaded.json`), 4096)).contents);
    const profile = await ownedFile(join(privateDirectory, `${stage}.profile`));
    if (!linuxAppArmorRemovalAllowed({ owner, marker, profileSha256: profile.sha256, currentState: profileState(name), actorsGone: profileActorsGone(name) },
      { run, runner, parserSha256: (await parserIdentity()).sha256, stage })) return false;
    await withLinuxAppArmorImportBinding(owner.imports, () => invoke('sudo', ['-n', PARSER, '--remove', '--skip-cache'], { input: profile.contents }));
    if (profileState(name) !== 'absent') return false;
  }
  return true;
}

const comparisonOutcomes = new Set(['basis_unavailable', 'profile_load_failed', 'baseline_failed', 'tuple_unavailable',
  'candidate_failed', 'negative_unproven', 'interrupted', 'cleanup_failed', 'compared']);
// Host closure authorizes only an attempt at the separate, owned profile
// removal checks. Missing in-container proof must still fail probe acceptance.
const hostClosed = result => result?.row?.containerRemoved === true && result.row.observerStopped === true
  && result.row.actorTrace?.instanceRemoved === true;
const clean = result => result?.row?.containerRemoved === true && result.row.observerStopped === true
  && result.row.probe?.cleanup?.childGone === true && result.row.probe.cleanup.mountGone === true;
const successfulProbe = result => clean(result) && result.row.errorCode === 'none' && result.profileApplied === true
  && result.row.probe.environment.appArmor.profile === 'other' && result.row.probe.environment.appArmor.enforcement === 'enforce'
  && result.row.probe.environment.seccomp === 'filter' && result.row.probe.environment.sysAdmin.effective === false
  && result.row.probe.environment.sysAdmin.permitted === false && result.row.probe.environment.sysAdmin.bounding === true;
function sameTuple(left, right) { return validateLinuxAppArmorMountTuple(left) !== null && JSON.stringify(left) === JSON.stringify(right); }
function positiveMount(result, tuple) {
  const mount = result?.row?.probe?.startup?.fuseMount;
  return successfulProbe(result) && result.row.probe.mount === 'observed' && mount?.state === 'observed'
    && mount.type === tuple.type && mount.uid === 1000 && mount.readOnly === true && mount.nosuid === true && mount.nodev === true && mount.noexec === false;
}
function negativeMount(result, tuple) {
  return successfulProbe(result) && result.row.probe.mount === 'not_observed' && result.row.appArmorMountDenial === true
    && result.row.probe.launcherErrors.stages.directFuseMount === 'EACCES' && sameTuple(result.tuple, tuple);
}
export function validateLinuxAppArmorComparison(value, validateRow) {
  if (!exact(value, ['schemaVersion', 'purpose', 'qualifiesRelease', 'runnerRevision', 'sourceRevision',
    'outcome', 'basisFailure', 'importFailure', 'basis', 'profiles', 'cases', 'profilesRemoved'])
    || value.schemaVersion !== LINUX_APPARMOR_COMPARISON_SCHEMA || value.purpose !== 'diagnostic_only' || value.qualifiesRelease !== false
    || !/^[a-f0-9]{40}$/u.test(value.runnerRevision ?? '') || !/^[a-f0-9]{40}$/u.test(value.sourceRevision ?? '')
    || !comparisonOutcomes.has(value.outcome) || !(value.basisFailure === 'none' || basisFailures.has(value.basisFailure))
    || (value.basisFailure === 'imports_unavailable' ? !importFailures.has(value.importFailure) : value.importFailure !== 'none')
    || typeof value.profilesRemoved !== 'boolean' || !exact(value.profiles, stages) || typeof validateRow !== 'function'
    || !Array.isArray(value.cases) || value.cases.length > 5) return null;
  if (value.basis !== null && (!exact(value.basis, ['dockerVersion', 'parserVersion', 'parserSha256', 'templateSha256',
    'renderedSha256', 'expandedSha256', 'daemonProfileSha256', 'globalImport', 'baseImport', 'imports', 'loadedDefaultPolicyVerified'])
    || value.basis.dockerVersion !== LINUX_APPARMOR_DOCKER_VERSION || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.basis.parserVersion)
    || !['parserSha256', 'templateSha256', 'renderedSha256', 'expandedSha256', 'daemonProfileSha256'].every(key => digest(value.basis[key]))
    || value.basis.templateSha256 !== LINUX_APPARMOR_TEMPLATE_SHA256 || typeof value.basis.globalImport !== 'boolean'
    || typeof value.basis.baseImport !== 'boolean' || !validImportBinding(value.basis.imports) || value.basis.loadedDefaultPolicyVerified !== false)) return null;
  for (const stage of stages) {
    const profile = value.profiles[stage];
    if (profile !== null && (!exact(profile, ['profileSha256', 'profileNameSha256', 'loaded', 'removed'])
      || !digest(profile.profileSha256) || !digest(profile.profileNameSha256) || typeof profile.loaded !== 'boolean' || typeof profile.removed !== 'boolean')) return null;
  }
  const order = [['baseline', 'current'], ['baseline', 'next'], ['candidate', 'current'], ['candidate', 'next'], ['negative', 'current']];
  for (const [index, result] of value.cases.entries()) {
    if (!exact(result, ['stage', 'row', 'profileApplied', 'tuple']) || result.stage !== order[index][0] || result.row?.role !== order[index][1]
      || !validateRow(result.row) || typeof result.profileApplied !== 'boolean'
      || result.tuple !== null && validateLinuxAppArmorMountTuple(result.tuple) === null
      || index > 0 && !clean(value.cases[index - 1])) return null;
  }
  if (value.cases.length > 2 && (!value.cases.slice(0, 2).every(result => negativeMount(result, value.cases[0]?.tuple))
    || value.profiles.baseline?.loaded !== true || value.profiles.baseline.removed !== true)) return null;
  if (value.cases.length > 4 && !value.cases.slice(2, 4).every(result => positiveMount(result, value.cases[0]?.tuple))) return null;
  if (value.outcome === 'compared') {
    const tuple = value.cases[0]?.tuple;
    if (!value.basis || value.basisFailure !== 'none' || !value.profilesRemoved || value.cases.length !== 5
      || !stages.every(stage => value.profiles[stage]?.loaded === true && value.profiles[stage].removed === true)
      || !value.cases.every(result => JSON.stringify(result.row.probe.environment) === JSON.stringify(value.cases[0].row.probe.environment))
      || !value.cases.slice(0, 2).every(result => negativeMount(result, tuple))
      || !value.cases.slice(2, 4).every(result => positiveMount(result, tuple)) || !negativeMount(value.cases[4], tuple)) return null;
  }
  if (value.profilesRemoved && stages.some(stage => value.profiles[stage] !== null && !value.profiles[stage].removed)) return null;
  return value;
}
export async function runLinuxAppArmorComparison(pair, { prepareProfiles, runProbe, validateRow, interrupted = () => false }) {
  const receipt = { schemaVersion: LINUX_APPARMOR_COMPARISON_SCHEMA, purpose: 'diagnostic_only', qualifiesRelease: false,
    runnerRevision: pair.intake.runnerRevision, sourceRevision: pair.intake.sourceRevision, outcome: 'basis_unavailable', basisFailure: 'none', importFailure: 'none',
    basis: null, profiles: { baseline: null, candidate: null }, cases: [], profilesRemoved: true };
  let profiles = null, probePending = false;
  try {
    try { profiles = await prepareProfiles(); receipt.basis = profiles.basis; }
    catch (error) { receipt.basisFailure = linuxAppArmorBasisFailure(error); receipt.importFailure = linuxAppArmorImportFailure(error); return receipt; }
    const probe = async (stage, role, name) => {
      if (interrupted()) { receipt.outcome = 'interrupted'; return null; }
      probePending = true;
      const result = await runProbe(stage, role, pair.images[role], name);
      if (!exact(result, ['row', 'tuple', 'profileApplied']) || !validateRow(result.row)
        || result.row.role !== role || result.row.artifactSha256 !== pair.images[role].sha256 || result.row.artifactBytes !== pair.images[role].bytes) refused('basis_unavailable');
      receipt.cases.push({ stage, ...result }); probePending = !hostClosed(result);
      return result;
    };
    if (interrupted()) { receipt.outcome = 'interrupted'; return receipt; }
    receipt.outcome = 'profile_load_failed';
    const baseline = await profiles.load('baseline');
    receipt.profiles.baseline = baseline.evidence; receipt.profilesRemoved = false;
    receipt.outcome = 'baseline_failed';
    for (const role of ['current', 'next']) {
      const result = await probe('baseline', role, baseline.name);
      if (result === null || !successfulProbe(result)
        || JSON.stringify(result.row.probe.environment) !== JSON.stringify(receipt.cases[0].row.probe.environment)) return receipt;
    }
    const tuple = receipt.cases[0].tuple;
    // Fast actors can exit between ownership samples. Missing bracketing stays
    // unavailable even when audit text resembles the expected mount attempt.
    receipt.outcome = 'tuple_unavailable';
    if (!receipt.cases.every(result => negativeMount(result, tuple))) return receipt;
    if (!await profiles.remove('baseline', !probePending)) { receipt.outcome = 'cleanup_failed'; return receipt; }
    if (interrupted()) { receipt.outcome = 'interrupted'; return receipt; }
    receipt.outcome = 'profile_load_failed';
    const candidate = await profiles.load('candidate', tuple); receipt.profiles.candidate = candidate.evidence;
    receipt.outcome = 'candidate_failed';
    for (const role of ['current', 'next']) {
      const result = await probe('candidate', role, candidate.name);
      if (result === null || !positiveMount(result, tuple)
        || JSON.stringify(result.row.probe.environment) !== JSON.stringify(receipt.cases[0].row.probe.environment)) return receipt;
    }
    receipt.outcome = 'negative_unproven';
    const negative = await probe('negative', 'current', candidate.name);
    if (negative !== null && negativeMount(negative, tuple)
      && JSON.stringify(negative.row.probe.environment) === JSON.stringify(receipt.cases[0].row.probe.environment)) receipt.outcome = 'compared';
    return receipt;
  } catch (error) {
    if (error?.code === 'imports_unavailable') { receipt.basisFailure = linuxAppArmorBasisFailure(error); receipt.importFailure = linuxAppArmorImportFailure(error); }
    return receipt;
  } finally {
    if (profiles) {
      receipt.profiles = profiles.evidence;
      let removed = !probePending;
      for (const stage of [...stages].reverse()) {
        try { if (!await profiles.remove(stage, !probePending)) removed = false; }
        catch (error) {
          removed = false;
          if (receipt.importFailure === 'none' && error?.code === 'imports_unavailable') {
            receipt.basisFailure = linuxAppArmorBasisFailure(error); receipt.importFailure = linuxAppArmorImportFailure(error);
          }
        }
      }
      receipt.profilesRemoved = removed;
      if (!removed) receipt.outcome = 'cleanup_failed';
    }
    if (validateLinuxAppArmorComparison(receipt, validateRow) === null) refused('basis_unavailable');
  }
}
