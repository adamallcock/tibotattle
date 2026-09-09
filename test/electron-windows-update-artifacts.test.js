import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseWindowsUpdaterYaml, validateWindowsUpdateArtifactMetadata, verifyWindowsUpdateArtifacts,
} from '../scripts/verify-electron-windows-update-artifacts.mjs';

const exe = Buffer.from('synthetic installer bytes, not a signed executable');
const hash = (algorithm, encoding = 'hex') => createHash(algorithm).update(exe).digest(encoding);
const fixture = () => ({ version: '0.1.18',
  installer: { name: 'TiboTattle-0.1.18-win32-x64.exe', sha256: hash('sha256'), sha512: hash('sha512', 'base64'), bytes: exe.length },
  manifest: { version: '0.1.18', files: [{ url: 'TiboTattle-0.1.18-win32-x64.exe', sha512: hash('sha512', 'base64'), size: exe.length }],
    path: 'TiboTattle-0.1.18-win32-x64.exe', sha512: hash('sha512', 'base64') },
  appUpdate: { provider: 'generic', url: 'https://updates.tibotattle.com/electron/stable/win32-x64',
    publisherName: ['Adam Allcock'], updaterCacheDirName: 'tibotattle-updater' },
});

test('final manifest proof states its native-signature and replacement boundaries', () => {
  const proof = validateWindowsUpdateArtifactMetadata(fixture());
  assert.equal(proof.status, 'passed');
  assert.equal(proof.finalManifestMatchesInstaller, true);
  assert.equal(proof.signature, 'separate_native_check');
  assert.equal(proof.installedReplacement, 'not_exercised');
  assert.equal(proof.publication, 'not_performed');
});

test('final byte binding refuses stale presigning hashes, wrong sizes, version and redirected artifact', () => {
  const mutations = [
    (v) => { v.manifest.files[0].sha512 = 'x'.repeat(86) + '=='; },
    (v) => { v.manifest.sha512 = 'x'.repeat(86) + '=='; },
    (v) => { v.manifest.files[0].size++; },
    (v) => { v.manifest.version = '0.1.19'; },
    (v) => { v.manifest.path = '../other.exe'; },
    (v) => { v.manifest.files[0].url = 'https://other.invalid/app.exe'; },
    (v) => { v.manifest.files.push({ ...v.manifest.files[0] }); },
    (v) => { v.manifest.packages = {}; },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validateWindowsUpdateArtifactMetadata(value), /ELECTRON_WINDOWS_UPDATE_ARTIFACTS_/u); }
});

test('installed updater configuration requires exact production origin and signing publisher', () => {
  for (const patch of [{ provider: 'github' }, { url: 'http://updates.tibotattle.com/electron/stable/win32-x64' },
    { url: fixture().appUpdate.url + '/other' }, { publisherName: [] }, { publisherName: ['Adam Allcock', 'Other'] },
    { publisherName: 'Other' }, { updaterCacheDirName: '../cache' }, { requestHeaders: { Authorization: 'synthetic' } }]) {
    const value = fixture(); Object.assign(value.appUpdate, patch);
    assert.throws(() => validateWindowsUpdateArtifactMetadata(value), /UPDATER_CONFIGURATION_INVALID/u);
  }
});

test('bounded YAML parser rejects duplicate keys, unsafe tags and non-map documents', () => {
  assert.deepEqual(parseWindowsUpdaterYaml(Buffer.from('version: 0.1.18\n')), { version: '0.1.18' });
  for (const input of ['version: 0.1.18\nversion: 0.1.19', '!!js/function >\n  function () {}', '[]', 'x'.repeat(65537)]) {
    assert.throws(() => parseWindowsUpdaterYaml(Buffer.from(input)), /YAML_INVALID/u);
  }
});

test('read-only verifier streams exact final installer and reads installed configuration', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'windows-update-proof-'));
  try {
    await mkdir(join(root, 'resources'));
    const value = fixture(), installerPath = join(root, value.installer.name);
    await writeFile(installerPath, exe);
    await writeFile(join(root, 'latest.yml'), JSON.stringify(value.manifest));
    await writeFile(join(root, 'resources', 'app-update.yml'), JSON.stringify(value.appUpdate));
    const options = { installerPath, installerSha256: hash('sha256'), installedAppPath: join(root, 'TiboTattle.exe'), version: '0.1.18' };
    const proof = await verifyWindowsUpdateArtifacts(options);
    assert.equal(proof.installerBytes, exe.length);
    assert.match(proof.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await readFile(installerPath), exe);
    await writeFile(installerPath, Buffer.from('changed after metadata generation'));
    await assert.rejects(verifyWindowsUpdateArtifacts(options), /INSTALLER_HASH_MISMATCH/u);
    await rm(installerPath);
    await writeFile(join(root, 'other.exe'), exe);
    await symlink(join(root, 'other.exe'), installerPath);
    await assert.rejects(verifyWindowsUpdateArtifacts(options), /PATH_INVALID/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
