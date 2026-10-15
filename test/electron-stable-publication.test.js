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
import { prepareElectronStablePublication as prepareProductionPublication, recordElectronStablePreparation, recordElectronStableReadback, readElectronStablePublicObject, verifyElectronStableReadback, STABLE_TARGETS } from '../scripts/prepare-electron-stable-publication.mjs';
import { linuxPlannerOptions, linuxUpdateKeys, linuxUpdateNow, signSyntheticLinuxFeed, resignSyntheticLinuxManifest, recordSyntheticStablePreparation, prepareSyntheticSameVersionRenewal } from './helpers/linux-update-publication-fixture.js';
const prepareElectronStablePublication = options => prepareProductionPublication({ ...linuxPlannerOptions, ...options });
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
      const plainFeed = Buffer.from(JSON.stringify({ version: RELEASE_VERSION, files, path: files[0].url, sha512: files[0].sha512 }));
      const manifest = await put(`${target}/${manifestName}`, target === 'linux-x64'
        ? await signSyntheticLinuxFeed(join(root, primary[0].path), plainFeed) : plainFeed);
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
  await recordSyntheticStablePreparation(plan, dir);
  assert.equal(JSON.parse(await readFile(join(dir, 'operation.json'))).state.stage, 'prepared_only');
  await assert.rejects(recordSyntheticStablePreparation(plan, dir), /USE_RESUME/);
  await assert.rejects(recordElectronStablePreparation({ artifactRoot: root, proposal, operationDirectory: join(root, 'production-operation') }), /LINUX_PUBLISHER_AUTHENTICATION_FAILED/);
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


test('production preparation and readback refuse unprovisioned publisher roots; network selectors are closed', async () => fixture(async ({ root, proposal }) => {
  const directory = join(root, 'readback-operation');
  await recordSyntheticStablePreparation(await prepareElectronStablePublication({ artifactRoot: root, proposal }), directory);
  const before = await readFile(join(directory, 'operation.json'));
  await assert.rejects(recordElectronStableReadback({ artifactRoot: root, proposal, operationDirectory: directory, phase: 'published', readObject: async () => assert.fail('no dispatch') }), /LINUX_PUBLISHER_AUTHENTICATION_FAILED/);
  assert.deepEqual(await readFile(join(directory, 'operation.json')), before);
  await assert.rejects(readElectronStablePublicObject('https://other.invalid/electron/stable/win32-x64/latest.yml', { maximumBytes: 1 }), /ARGUMENT_INVALID/);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/prepare-electron-stable-publication.mjs', import.meta.url)), '--publish'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /ELECTRON_STABLE_PUBLICATION_ARGUMENT_INVALID/);
  assert.equal(child.stdout, '');
}));


test('Linux publication validates optional embedded block map size and refuses other file fields',async()=>fixture(async({root,proposal})=>{
 const target=proposal.targets.find(t=>t.target==='linux-x64');const original=JSON.parse(await readFile(join(root,target.manifest.path)));
 async function setFile(diff){const doc=structuredClone(original);Object.assign(doc.files[0],diff);const bytes=Buffer.from(JSON.stringify(doc));await writeFile(join(root,target.manifest.path),bytes);target.manifest={...target.manifest,sha256:sha(bytes),bytes:bytes.length};}
 await setFile({blockMapSize:12});await prepareElectronStablePublication({artifactRoot:root,proposal});
 for(const value of [0,-1,1.5,'12',original.files[0].size-3,Number.MAX_SAFE_INTEGER]){await setFile({blockMapSize:value});await assert.rejects(prepareElectronStablePublication({artifactRoot:root,proposal}),/MANIFEST_INVALID/);}
 await setFile({blockMapSize:12,unknown:true});await assert.rejects(prepareElectronStablePublication({artifactRoot:root,proposal}),/MANIFEST_INVALID/);
}));

test('Linux publication requires an independent signature and binds it to the exact final AppImage', async () => fixture(async ({ root, proposal }) => {
  const target = proposal.targets.find(value => value.target === 'linux-x64');
  const original = JSON.parse(await readFile(join(root, target.manifest.path)));
  const replace = async document => {
    const bytes = Buffer.from(JSON.stringify(document));
    await writeFile(join(root, target.manifest.path), bytes);
    target.manifest = { ...target.manifest, sha256: sha(bytes), bytes: bytes.length };
  };
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  assert.deepEqual(plan.targets.find(value => value.target === 'linux-x64').publisherAuthentication, {
    status: 'signature_verified', keyId: linuxUpdateKeys[0].id, sequence: 1,
    sha256: target.artifacts[0].sha256, bytes: target.artifacts[0].bytes, expiresAt: linuxUpdateNow + 24 * 60 * 60_000,
  });
  await assert.rejects(prepareProductionPublication({ artifactRoot: root, proposal }), /LINUX_PUBLISHER_AUTHENTICATION_FAILED/);
  for (const change of [
    document => { delete document.tibotattleLinuxUpdate; },
    document => { document.tibotattleLinuxUpdate.manifest.channel = 'preview'; },
    document => { document.tibotattleLinuxUpdate.manifest.target = 'win32-x64'; },
    document => { document.tibotattleLinuxUpdate.manifest.appId = 'other.app'; },
    document => { document.tibotattleLinuxUpdate.manifest.version = '99.0.0'; },
    document => { document.tibotattleLinuxUpdate.manifest.keyId = 'unknown'; },
    document => { document.tibotattleLinuxUpdate.manifest.sequence = 101; },
    document => { document.tibotattleLinuxUpdate.manifest.expiresAt = linuxUpdateNow; },
    document => { document.tibotattleLinuxUpdate.manifest.size += 1; },
    document => { document.tibotattleLinuxUpdate.publicKey = linuxUpdateKeys[0].publicKey; },
  ]) {
    const document = structuredClone(original); change(document);
    if (document.tibotattleLinuxUpdate?.manifest) resignSyntheticLinuxManifest(document);
    await replace(document);
    await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /LINUX_PUBLISHER_AUTHENTICATION_FAILED/);
  }
  const invalidSignature = structuredClone(original);
  invalidSignature.tibotattleLinuxUpdate.signature = Buffer.alloc(64).toString('base64');
  await replace(invalidSignature);
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /LINUX_PUBLISHER_AUTHENTICATION_FAILED/);
  const differentSignedArtifact = structuredClone(original);
  differentSignedArtifact.tibotattleLinuxUpdate.manifest.sha256 = 'f'.repeat(64);
  await replace(resignSyntheticLinuxManifest(differentSignedArtifact));
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /LINUX_SIGNED_BYTES_MISMATCH/);
}));

test('Linux readback covers the entire signed envelope and rollback retains exact predecessor discovery bytes', async () => fixture(async ({ root, proposal, put }) => {
  const target = proposal.targets.find(value => value.target === 'linux-x64');
  const old = { version: '0.1.0', files: [{ url: 'TiboTattle-0.1.0-linux-x86_64.AppImage', sha512: sha('old', 'sha512') }],
    path: 'TiboTattle-0.1.0-linux-x86_64.AppImage', sha512: sha('old', 'sha512') };
  target.predecessor = await put('linux-predecessor.yml', JSON.stringify(old));
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  assert.equal(plan.targets.find(value => value.target === 'linux-x64').rollback, 'restore_exact_predecessor_feed_only');
  await assert.rejects(verifyElectronStableReadback(plan, { readObject: async url => {
    const object = plan.targets.flatMap(value => [...value.artifacts, value.feed]).find(value => url.endsWith(value.objectKey));
    const bytes = await readFile(join(root, object.localPath));
    if (object.objectKey.endsWith('latest-linux.yml')) {
      const signature = JSON.parse(bytes).tibotattleLinuxUpdate.signature;
      const offset = bytes.indexOf(signature); bytes[offset] = bytes[offset] === 65 ? 66 : 65;
    }
    return { status: 200, body: [bytes], contentType: object.contentType, cacheControl: object.cacheControl };
  } }), /READBACK_BYTES_MISMATCH/);
  assert.equal((await verifyElectronStableReadback(plan, { phase: 'rollback', readObject: async url => url.includes('linux-x64')
    ? { status: 200, body: [await readFile(join(root, target.predecessor.path))] } : { status: 404 } })).status, 'verified');
}));

test('same-version Linux expiry renewal binds all four targets and authenticates expired exact predecessor', async () => fixture(async ({ root, proposal, put }) => {
  await prepareSyntheticSameVersionRenewal({ root, proposal, put });
  const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
  assert.equal(plan.targets.length, 4);
  assert.equal(plan.targets.find(target => target.target === 'linux-x64').feedAction, 'renew_linux_metadata');
  assert(plan.targets.filter(target => target.target !== 'linux-x64').every(target => target.feedAction === 'preserve_exact_feed'
    && target.feed.sha256 === target.predecessor.sha256 && target.feed.bytes === target.predecessor.bytes));
  assert.equal(plan.targets.find(target => target.target === 'linux-x64').publisherAuthentication.sequence, 2);
  for (const phase of ['published', 'predecessor', 'rollback']) {
    const result = await verifyElectronStableReadback(plan, { phase, readObject: async url => {
      const target = plan.targets.find(value => url.includes(`/${value.target}/`));
      const object = [...target.artifacts, target.feed].find(value => url.endsWith(value.objectKey));
      const path = phase === 'published' ? object.localPath : target.predecessor.localPath;
      return { status: 200, body: [await readFile(join(root, path))], contentType: object.contentType, cacheControl: object.cacheControl };
    } });
    assert.equal(result.status, 'verified');
    assert.equal(result.objects.length, phase === 'published' ? 14 : 4);
  }
}));

test('same-version renewal refuses equal sequence, nonincreasing expiry, changed artifact or platform feed, and mixed target preimages', async () => fixture(async ({ root, proposal, put }) => {
  await prepareSyntheticSameVersionRenewal({ root, proposal, put });
  const target = proposal.targets.find(value => value.target === 'linux-x64');
  const oldBytes = await readFile(join(root, target.predecessor.path));
  const oldSpec = { ...target.predecessor };
  for (const change of [
    doc => { doc.tibotattleLinuxUpdate.manifest.sequence = 2; },
    doc => { doc.tibotattleLinuxUpdate.manifest.expiresAt = linuxUpdateNow + 24 * 60 * 60_000; },
    doc => { doc.tibotattleLinuxUpdate.manifest.sha256 = 'f'.repeat(64); },
    doc => { doc.tibotattleLinuxUpdate.manifest.size += 1; doc.files[0].size += 1; },
    doc => { doc.tibotattleLinuxUpdate.manifest.expiresAt = 1; },
    doc => { doc.tibotattleLinuxUpdate.manifest.keyId = 'unknown'; },
    doc => { doc.files[0].blockMapSize = 12; },
    doc => { doc.unreviewed = true; },
    doc => { delete doc.tibotattleLinuxUpdate; },
  ]) {
    const parsed = JSON.parse(oldBytes); change(parsed);
    if (parsed.tibotattleLinuxUpdate) resignSyntheticLinuxManifest(parsed);
    const bytes = Buffer.from(JSON.stringify(parsed));
    await writeFile(join(root, target.predecessor.path), bytes);
    target.predecessor = { ...oldSpec, sha256: sha(bytes), bytes: bytes.length };
    await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /LINUX_RENEWAL_PREDECESSOR_INVALID/);
  }
  const invalidSignature = JSON.parse(oldBytes);
  invalidSignature.tibotattleLinuxUpdate.signature = Buffer.alloc(64).toString('base64');
  const invalidBytes = Buffer.from(JSON.stringify(invalidSignature));
  await writeFile(join(root, oldSpec.path), invalidBytes);
  target.predecessor = { ...oldSpec, sha256: sha(invalidBytes), bytes: invalidBytes.length };
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /LINUX_RENEWAL_PREDECESSOR_INVALID/);
  await writeFile(join(root, oldSpec.path), oldBytes); target.predecessor = oldSpec;
  for (const name of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const other = proposal.targets.find(value => value.target === name), originalSpec = { ...other.predecessor };
    const original = await readFile(join(root, other.predecessor.path));
    const bytes = Buffer.concat([original, Buffer.from('\n')]);
    await writeFile(join(root, other.predecessor.path), bytes);
    other.predecessor = { ...originalSpec, sha256: sha(bytes), bytes: bytes.length };
    await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /SAME_VERSION_FEED_CHANGED/);
    await writeFile(join(root, originalSpec.path), original); other.predecessor = originalSpec;
  }
  proposal.targets[0].predecessor = null;
  await assert.rejects(prepareElectronStablePublication({ artifactRoot: root, proposal }), /RENEWAL_TARGET_SET_INVALID/);
}));
