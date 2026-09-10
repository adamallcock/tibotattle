import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import distribution from '../config/electron-production-distribution.cjs';
import { RELEASE_VERSION } from '../config/release-manifest.js';
import { productionElectronCandidatePlan } from '../scripts/package-electron-production.mjs';
import { prepareElectronStablePublication, recordElectronStablePreparation, recordElectronStableReadback, readElectronStablePublicObject, verifyElectronStableReadback, STABLE_TARGETS } from '../scripts/prepare-electron-stable-publication.mjs';
const sha = (b, alg = 'sha256') => createHash(alg).update(b).digest(alg === 'sha512' ? 'base64' : 'hex');
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stable-publication-')));
  const proposal = { schemaVersion: 'tibotattle-electron-stable-publication-v1', sourceRevision: 'a'.repeat(40), version: RELEASE_VERSION, buildNumber: '2026091001', targets: [] };
  const put = async (path, data) => { const b = Buffer.from(data); await writeFile(join(root, path), b, { flag: 'wx', mode: 0o600 }); return { path, sha256: sha(b), bytes: b.length }; };
  try {
    for (const target of STABLE_TARGETS) {
      await mkdir(join(root, target), { mode: 0o700 });
      const spec = distribution.PRODUCTION_ELECTRON_TARGETS[target];
      const plan = productionElectronCandidatePlan({ target, sourceRevision: proposal.sourceRevision, buildNumber: proposal.buildNumber, hostPlatform: spec.platform, hostArchitecture: spec.architecture });
      const source = { ...plan, ...(plan.nativeHandoverHelper ? { nativeHandoverHelper: { ...plan.nativeHandoverHelper, status: 'contract_ok' } } : {}), ...(plan.nativeMacOSKeychainAdapter ? { nativeMacOSKeychainAdapter: { ...plan.nativeMacOSKeychainAdapter, status: 'source_compiled_unsigned' } } : {}), status: 'production_source_staged', stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
      const names = target.startsWith('darwin-') ? ['zip','dmg'].flatMap(ext => [`TiboTattle-${RELEASE_VERSION}-mac-${spec.architecture}.${ext}`, `TiboTattle-${RELEASE_VERSION}-mac-${spec.architecture}.${ext}.blockmap`]) : [target === 'win32-x64' ? `TiboTattle-${RELEASE_VERSION}-Windows-x64.exe` : `TiboTattle-${RELEASE_VERSION}-linux-x86_64.AppImage`];
      const artifacts = []; for (const name of names) artifacts.push(await put(`${target}/${name}`, `synthetic:${target}:${name}`));
      const primary = artifacts.filter(a => !a.path.endsWith('.blockmap'));
      const files = []; for (const a of primary) files.push({ url: a.path.split('/').at(-1), sha512: sha(await readFile(join(root, a.path)), 'sha512'), size: a.bytes });
      const manifestName = target.startsWith('darwin-') ? 'latest-mac.yml' : target === 'win32-x64' ? 'latest.yml' : 'latest-linux.yml';
      const manifest = await put(`${target}/${manifestName}`, JSON.stringify({ version: RELEASE_VERSION, files, path: files[0].url, sha512: files[0].sha512 }));
      const appUpdate = await put(`${target}/app-update.yml`, JSON.stringify({ provider: 'generic', url: spec.feedURL, updaterCacheDirName: 'tibotattle-updater', ...(target === 'win32-x64' ? { publisherName: ['Adam Allcock'] } : {}) }));
      proposal.targets.push({ target, sourceCandidate: await put(`${target}/source.json`, JSON.stringify(source)), appUpdate, manifest, artifacts, predecessor: null, evidence: [await put(`${target}/native-evidence.json`, '{"synthetic":true}')] });
    }
    await run({ root, proposal, put });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('four exact stable targets plan locally, journal no publication, readback and first-release withdrawal', async () => fixture(async ({ root, proposal }) => {
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  assert.equal(plan.status, 'local_bytes_bound'); assert.equal(plan.published, false);
  assert.equal(plan.nativeTrust, 'separate_evidence_review_required');
  assert(plan.preserve.includes('appcast.xml'));
  const response = async url => { const object = plan.targets.flatMap(t => [...t.artifacts, t.feed]).find(o => url.endsWith(o.objectKey)); return { status: 200, redirected: false, body: [await readFile(join(root, object.localPath))], contentType: object.contentType, cacheControl: object.cacheControl }; };
  assert.equal((await verifyElectronStableReadback(plan, { readObject: response })).objects.length, 14);
  assert.equal((await verifyElectronStableReadback(plan, { phase: 'rollback', readObject: async () => ({ status: 404 }) })).objects.length, 4);
  const dir = join(root, 'operation');
  await recordElectronStablePreparation({ artifactRoot: root, proposal, operationDirectory: dir });
  assert.equal(JSON.parse(await readFile(join(dir, 'operation.json'))).state.stage, 'prepared_only');
  await assert.rejects(recordElectronStablePreparation({ artifactRoot: root, proposal, operationDirectory: dir }), /USE_RESUME/);
}));
test('missing target, mismatched source, rehearsal and tampered final bytes refuse', async () => fixture(async ({ root, proposal }) => {
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal: { ...proposal, targets: proposal.targets.slice(1) } }), /PROPOSAL_INVALID/);
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal: { ...proposal, sourceRevision: 'b'.repeat(40) } }), /SOURCE_INVALID/);
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal: { ...proposal, version: '0.1.19-native-to-electron-handover.18' } }), /PROPOSAL_INVALID/);
  const artifact = proposal.targets[0].artifacts[0]; await writeFile(join(root, artifact.path), Buffer.alloc(artifact.bytes, 1));
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /FINAL_BYTES_MISMATCH/);
}));
test('readback refuses wrong bytes, redirect, headers and ambiguous predecessor absence', async () => fixture(async ({ root, proposal }) => {
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  await assert.rejects(verifyElectronStableReadback(plan, { readObject: async () => ({ status: 200, redirected: true }) }), /STATUS_INVALID/);
  await assert.rejects(verifyElectronStableReadback(plan, { readObject: async () => ({ status: 200, body: [Buffer.from('wrong')] }) }), /BYTES_MISMATCH/);
  await assert.rejects(verifyElectronStableReadback(plan, { phase: 'predecessor', readObject: async () => ({ status: 403 }) }), /STATUS_INVALID/);
  await assert.rejects(verifyElectronStableReadback(plan, { readObject: async () => ({ status: 200, body: [await readFile(join(root, plan.targets[0].artifacts[0].localPath))] }) }), /HEADERS_INVALID/);
}));
test('symlinked artifact and traversal refuse before preparation', async () => fixture(async ({ root, proposal }) => {
  const artifact = proposal.targets[0].artifacts[0]; const original = join(root, artifact.path);
  const data = await readFile(original); await rm(original); await writeFile(`${original}.other`, data); await symlink(`${original}.other`, original);
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /PATH_INVALID/);
  artifact.path = '../outside.zip';
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /FILE_SPEC_INVALID/);
}));

test('predecessor rollback binds exact prior bytes; alternate host and future predecessor refuse', async () => fixture(async ({ root, proposal, put }) => {
  const input = proposal.targets[0];
  const old = { version: '0.1.0', files: ['zip', 'dmg'].map(ext => ({ url: `TiboTattle-0.1.0-mac-arm64.${ext}`, sha512: sha('old', 'sha512') })), path: 'TiboTattle-0.1.0-mac-arm64.zip', sha512: sha('old', 'sha512') };
  input.predecessor = await put('previous.yml', JSON.stringify(old));
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  const receipt = await verifyElectronStableReadback(plan, { phase: 'rollback', readObject: async url => url.includes('darwin-arm64') ? { status: 200, body: [await readFile(join(root, 'previous.yml'))] } : { status: 404 } });
  assert.equal(receipt.status, 'verified');
  assert.equal(plan.targets[0].rollback, 'restore_exact_predecessor_feed_only');
  await assert.rejects(verifyElectronStableReadback({ ...plan, origin: 'https://other.invalid' }, { readObject: async () => assert.fail('no dispatch') }), /READBACK_PLAN_INVALID/);
  input.predecessor = await put('future.yml', JSON.stringify({ ...old, version: '99.0.0' }));
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /PREDECESSOR_INVALID/);
}));


test('explicit readback journals only verified results; network and publication selectors are closed', async () => fixture(async ({ root, proposal }) => {
  const directory = join(root, 'readback-operation');
  await recordElectronStablePreparation({ artifactRoot: root, proposal, operationDirectory: directory });
  await recordElectronStableReadback({ artifactRoot: root, proposal, operationDirectory: directory, phase: 'predecessor', readObject: async () => ({ status: 404 }) });
  const before = await readFile(join(directory, 'operation.json'));
  await assert.rejects(recordElectronStableReadback({ artifactRoot: root, proposal, operationDirectory: directory, phase: 'published', readObject: async () => ({ status: 403 }) }), /STATUS_INVALID/);
  assert.deepEqual(await readFile(join(directory, 'operation.json')), before);
  await assert.rejects(readElectronStablePublicObject('https://other.invalid/electron/stable/win32-x64/latest.yml', { maximumBytes: 1 }), /ARGUMENT_INVALID/);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/prepare-electron-stable-publication.mjs', import.meta.url)), '--publish'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /ELECTRON_STABLE_PUBLICATION_ARGUMENT_INVALID/);
  assert.equal(child.stdout, '');
}));
