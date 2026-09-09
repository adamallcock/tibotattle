/** Read-only final-byte updater proof. Authenticode and installed replacement
 * remain separate native checks; this helper never publishes or launches. */
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import distribution from '../config/electron-production-distribution.cjs';

const PREFIX = 'ELECTRON_WINDOWS_UPDATE_ARTIFACTS_';
const FEED = distribution.PRODUCTION_ELECTRON_TARGETS['win32-x64'].feedURL;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LEAF = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/u;
const fail = (code) => { throw Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` }); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function pinnedYaml() {
  try {
    const require = createRequire(import.meta.url);
    const builder = createRequire(require.resolve('electron-builder/package.json'));
    if (builder('electron-builder/package.json').version !== '26.15.7'
        || builder('app-builder-lib/package.json').version !== '26.15.7') fail('DEPENDENCY_INVALID');
    return builder('js-yaml');
  } catch { fail('DEPENDENCY_INVALID'); }
}

export function parseWindowsUpdaterYaml(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024) fail('YAML_INVALID');
  const yaml = pinnedYaml();
  try {
    const value = yaml.load(bytes.toString('utf8'), { schema: yaml.JSON_SCHEMA });
    if (!record(value)) fail('YAML_INVALID');
    return value;
  } catch { fail('YAML_INVALID'); }
}

export function validateWindowsUpdateArtifactMetadata({ manifest, appUpdate, installer, version }) {
  if (!VERSION.test(version ?? '') || !record(installer) || !LEAF.test(installer.name ?? '')
      || !SHA256.test(installer.sha256 ?? '') || !/^[A-Za-z0-9+/]{86}==$/u.test(installer.sha512 ?? '')
      || !Number.isSafeInteger(installer.bytes) || installer.bytes < 1 || installer.bytes > 1024 ** 3) fail('IDENTITY_INVALID');
  if (!record(manifest) || manifest.version !== version || !Array.isArray(manifest.files)
      || manifest.files.length !== 1 || !record(manifest.files[0])) fail('MANIFEST_INVALID');
  const file = manifest.files[0];
  // Pinned builder omits size for non-differential NSIS updates. Both required
  // SHA-512 fields still bind the complete final bytes; validate size if supplied.
  const manifestSizePresent = Object.hasOwn(file, 'size');
  if (file.url !== installer.name || file.sha512 !== installer.sha512
      || (manifestSizePresent && file.size !== installer.bytes)
      || manifest.path !== installer.name || manifest.sha512 !== installer.sha512
      || Object.hasOwn(manifest, 'packages')) fail('FINAL_BYTES_MISMATCH');
  const publishers = Array.isArray(appUpdate?.publisherName) ? appUpdate.publisherName : [appUpdate?.publisherName];
  if (!record(appUpdate) || appUpdate.provider !== 'generic' || appUpdate.url !== FEED
      || publishers.length !== 1 || publishers[0] !== 'Adam Allcock'
      || typeof appUpdate.updaterCacheDirName !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(appUpdate.updaterCacheDirName)
      || ['.', '..'].includes(appUpdate.updaterCacheDirName)
      || Object.keys(appUpdate).some((key) => !['provider', 'url', 'publisherName', 'updaterCacheDirName'].includes(key))) fail('UPDATER_CONFIGURATION_INVALID');
  return Object.freeze({ schemaVersion: 'tibotattle-windows-update-artifacts-v1', status: 'passed',
    target: 'win32-x64', version, installerSha256: installer.sha256,
    installerSha512: installer.sha512, installerBytes: installer.bytes,
    manifestSizeVerified: manifestSizePresent,
    finalManifestMatchesInstaller: true, fixedFeedAndPublisher: true,
    signature: 'separate_native_check', installedReplacement: 'not_exercised', publication: 'not_performed' });
}

async function regularFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/u.test(path)) fail('PATH_INVALID');
  let current = parse(path).root;
  const parts = relative(current, path).split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('PATH_INVALID');
  }
}

async function fingerprint(path, limit, keepBytes = false) {
  await regularFile(path);
  const before = await lstat(path);
  if (before.size < 1 || before.size > limit) fail('FILE_SIZE_INVALID');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('FILE_CHANGED');
    const sha256 = createHash('sha256'), sha512 = createHash('sha512'), chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) fail('FILE_SIZE_INVALID');
      sha256.update(chunk); sha512.update(chunk);
      if (keepBytes) chunks.push(chunk);
    }
    const after = await handle.stat(), named = await lstat(path);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || named.ino !== after.ino || named.dev !== after.dev || named.isSymbolicLink()) fail('FILE_CHANGED');
    return { name: basename(path), sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), bytes,
      ...(keepBytes ? { contents: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

/** Call only after the owning installed-package verifier has bound `version`
 * to both staged and installed ASAR metadata. The receipt does not import that
 * separate proof or claim that an update was installed. */
export async function verifyWindowsUpdateArtifacts({ installerPath, installerSha256, installedAppPath, version }) {
  if (!SHA256.test(installerSha256 ?? '') || !VERSION.test(version ?? '')) fail('IDENTITY_INVALID');
  const installer = await fingerprint(installerPath, 1024 ** 3);
  if (installer.sha256 !== installerSha256) fail('INSTALLER_HASH_MISMATCH');
  const manifest = await fingerprint(join(dirname(installerPath), 'latest.yml'), 64 * 1024, true);
  const appUpdate = await fingerprint(join(dirname(installedAppPath), 'resources', 'app-update.yml'), 64 * 1024, true);
  return Object.freeze({ ...validateWindowsUpdateArtifactMetadata({
    manifest: parseWindowsUpdaterYaml(manifest.contents), appUpdate: parseWindowsUpdaterYaml(appUpdate.contents), installer, version,
  }), manifestSha256: manifest.sha256, packagedUpdaterConfigurationSha256: appUpdate.sha256 });
}
