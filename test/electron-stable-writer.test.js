import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionElectronCandidatePlan } from '../scripts/package-electron-production.mjs';
import { prepareElectronStablePublication, recordElectronStablePreparation, STABLE_TARGETS } from '../scripts/prepare-electron-stable-publication.mjs';
import { publishElectronStableFeed, createElectronStableR2Transport } from '../scripts/publish-electron-stable-feed.mjs';
import { identityDigest } from '../scripts/lib/release-operation.mjs';
import distribution from '../config/electron-production-distribution.cjs';
import { RELEASE_VERSION } from '../config/release-manifest.js';
const digest = (value, alg = 'sha256') => createHash(alg).update(value).digest(alg === 'sha512' ? 'base64' : 'hex');
const fingerprint = bytes => ({ sha256: digest(bytes), bytes: bytes.length });
async function fixture(run, { predecessors = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stable-writer-')));
  const proposal = { schemaVersion: 'tibotattle-electron-stable-publication-v1', sourceRevision: 'a'.repeat(40), version: RELEASE_VERSION, buildNumber: '2026091001', targets: [] };
  const put = async (path, value) => { const bytes = Buffer.from(value); await writeFile(join(root, path), bytes); return { path, ...fingerprint(bytes) }; };
  try {
    for (const target of STABLE_TARGETS) {
      await mkdir(join(root, target)); const spec = distribution.PRODUCTION_ELECTRON_TARGETS[target];
      const source = productionElectronCandidatePlan({ target, sourceRevision: proposal.sourceRevision, buildNumber: proposal.buildNumber, hostPlatform: spec.platform, hostArchitecture: spec.architecture });
      const receipt = { ...source, ...(source.nativeHandoverHelper ? { nativeHandoverHelper: { ...source.nativeHandoverHelper, status: 'contract_ok' } } : {}), ...(source.nativeMacOSKeychainAdapter ? { nativeMacOSKeychainAdapter: { ...source.nativeMacOSKeychainAdapter, status: 'source_compiled_unsigned' } } : {}), status: 'production_source_staged', stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
      const names = target.startsWith('darwin-') ? ['zip','dmg'].flatMap(ext => [`TiboTattle-${RELEASE_VERSION}-mac-${spec.architecture}.${ext}`, `TiboTattle-${RELEASE_VERSION}-mac-${spec.architecture}.${ext}.blockmap`]) : [target === 'win32-x64' ? `TiboTattle-${RELEASE_VERSION}-Windows-x64.exe` : `TiboTattle-${RELEASE_VERSION}-linux-x86_64.AppImage`];
      const artifacts = []; for (const name of names) artifacts.push(await put(`${target}/${name}`, name));
      const files = names.filter(name => !name.endsWith('.blockmap')).map(name => ({ url: name, sha512: digest(name, 'sha512'), size: Buffer.byteLength(name) }));
      const manifestName = target.startsWith('darwin-') ? 'latest-mac.yml' : target === 'win32-x64' ? 'latest.yml' : 'latest-linux.yml';
      proposal.targets.push({ target, sourceCandidate: await put(`${target}/source.json`, JSON.stringify(receipt)),
        appUpdate: await put(`${target}/app-update.yml`, JSON.stringify({ provider: 'generic', url: spec.feedURL, updaterCacheDirName: 'cache', ...(target === 'win32-x64' ? { publisherName: 'Adam Allcock' } : {}) })),
        manifest: await put(`${target}/${manifestName}`, JSON.stringify({ version: RELEASE_VERSION, files, path: files[0].url, sha512: files[0].sha512 })), artifacts,
        predecessor: null, evidence: [await put(`${target}/evidence.json`, '{"synthetic":true}')] });
    }
    if (predecessors) for (const target of proposal.targets) {
      const parsed = JSON.parse(await readFile(join(root, target.manifest.path)));
      parsed.version = '0.1.0';
      parsed.files = parsed.files.map(file => ({ ...file, url: file.url.replace(RELEASE_VERSION, '0.1.0') }));
      parsed.path = parsed.path.replace(RELEASE_VERSION, '0.1.0');
      target.predecessor = await put(`${target.target}/previous.yml`, JSON.stringify(parsed));
    }
    const operationDirectory = join(root, 'operation');
    await recordElectronStablePreparation({ artifactRoot: root, proposal, operationDirectory });
    const plan = await prepareElectronStablePublication({ artifactRoot: root, proposal });
    const objects = new Map(), calls = [], owner = 'b'.repeat(40);
    if (predecessors) for (const target of plan.targets) objects.set(target.feed.objectKey, { ...target.feed, bytes: await readFile(join(root, target.predecessor.localPath)) });
    let ownership = true;
    const options = { artifactRoot: root, proposal, operationDirectory, approvedPlanSha256: identityDigest(plan), coordinationOwner: owner,
      coordination: { assertOwned: value => { assert.equal(value, owner); if (!ownership) throw new Error('ownership lost'); } },
      transport: {
        get: async (bucket, key) => { calls.push(['get', key]); return objects.has(key) ? fingerprint(objects.get(key).bytes) : null; },
        put: async (bucket, object, path) => {
          const journal = JSON.parse(await readFile(join(operationDirectory, 'operation.json')));
          assert.equal(journal.state.writer.intent.objectKey, object.objectKey);
          calls.push(['put', object.objectKey]); objects.set(object.objectKey, { bytes: await readFile(path), ...object });
          // Keep payload bytes separate from the length in its public descriptor.
          objects.get(object.objectKey).bytes = await readFile(path);
        },
        delete: async (bucket, key) => { calls.push(['delete', key]); objects.delete(key); },
      },
      readPublicObject: async url => { const value = objects.get(new URL(url).pathname.slice(1)); return value ? { status: 200, body: [value.bytes], contentType: value.contentType, cacheControl: value.cacheControl } : { status: 404 }; },
    };
    await run({ root, plan, options, objects, calls, loseOwnership: () => { ownership = false; }, readJournal: async () => JSON.parse(await readFile(join(operationDirectory, 'operation.json'))) });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('publication verifies all immutable artifacts before feeds; explicit rollback removes only newly created feeds', async () => fixture(async ({ options, plan, calls, objects, readJournal }) => {
  const result = await publishElectronStableFeed(options); assert.equal(result.status, 'completed');
  const firstFeed = calls.findIndex(([kind, key]) => kind === 'put' && key.endsWith('.yml'));
  assert(firstFeed > 0);
  for (const artifact of plan.targets.flatMap(t => t.artifacts)) assert(calls.slice(0, firstFeed).some(([kind, key]) => kind === 'get' && key === artifact.objectKey));
  assert.equal((await readJournal()).state.writer.intent, null);
  await publishElectronStableFeed({ ...options, phase: 'rollback' });
  assert.equal(objects.size, plan.targets.flatMap(t => t.artifacts).length);
  assert(calls.filter(([kind]) => kind === 'delete').every(([, key]) => key.startsWith('electron/stable/') && key.endsWith('.yml')));
  assert.equal((await readJournal()).state.writer.priorPublication.status, 'completed');
}));
test('wrong approved digest and lost ownership dispatch nothing', async () => fixture(async ({ options, calls, loseOwnership }) => {
  await assert.rejects(publishElectronStableFeed({ ...options, approvedPlanSha256: 'f'.repeat(64) }), /APPROVED_PLAN_CHANGED/);
  loseOwnership(); await assert.rejects(publishElectronStableFeed(options), /ownership lost/); assert.equal(calls.length, 0);
}));
test('immutable collision refuses and leaves every feed unchanged', async () => fixture(async ({ options, plan, objects, calls }) => {
  objects.set(plan.targets[0].artifacts[0].objectKey, { bytes: Buffer.from('conflict') });
  await assert.rejects(publishElectronStableFeed(options), /IMMUTABLE_CONFLICT/);
  assert.equal(calls.filter(([kind]) => kind === 'put').length, 0);
}));
test('uncertain write persists intent and refuses both replay and rollback', async () => fixture(async ({ options, readJournal }) => {
  const original = options.transport.put;
  options.transport.put = async (...args) => { await original(...args); throw new Error('lost response'); };
  await assert.rejects(publishElectronStableFeed(options), /lost response/);
  const journal = await readJournal(); assert.equal(journal.state.writer.status, 'unknown'); assert(journal.state.writer.intent);
  options.transport.get = async () => assert.fail('no remote replay');
  await assert.rejects(publishElectronStableFeed(options), /RECONCILIATION_REQUIRED/);
  await assert.rejects(publishElectronStableFeed({ ...options, phase: 'rollback' }), /RECONCILIATION_REQUIRED/);
}));
test('feed changed before replacement refuses without overwriting the competing feed', async () => fixture(async ({ options, plan, objects, calls }) => {
  const key = plan.targets[0].feed.objectKey, original = options.transport.get; let reads = 0;
  options.transport.get = async (bucket, name) => { if (name === key && ++reads === 2) objects.set(key, { bytes: Buffer.from('new concurrent feed') }); return original(bucket, name); };
  await assert.rejects(publishElectronStableFeed(options), /REMOTE_PREIMAGE_CHANGED/);
  assert.equal(calls.filter(([kind, name]) => kind === 'put' && name.endsWith('.yml')).length, 0);
  assert.equal(objects.get(key).bytes.toString(), 'new concurrent feed');
}));


test('explicit rollback restores exact prior stable manifests and retains immutable release objects', async () => fixture(async ({ options, plan, objects, readJournal }) => {
  const previous = new Map(plan.targets.map(t => [t.feed.objectKey, Buffer.from(objects.get(t.feed.objectKey).bytes)]));
  await publishElectronStableFeed(options);
  await publishElectronStableFeed({ ...options, phase: 'rollback' });
  for (const [key, bytes] of previous) assert.deepEqual(objects.get(key).bytes, bytes);
  for (const artifact of plan.targets.flatMap(t => t.artifacts)) assert(objects.has(artifact.objectKey));
  assert.equal((await readJournal()).state.writer.status, 'completed');
}, { predecessors: true }));


test('failed preflight cannot claim or roll back another operation exact feed bytes', async () => fixture(async ({ root, options, plan, objects, calls, readJournal }) => {
  const feed = plan.targets[0].feed;
  objects.set(feed.objectKey, { ...feed, bytes: await readFile(join(root, feed.localPath)) });
  await assert.rejects(publishElectronStableFeed(options), /REMOTE_PREIMAGE_CHANGED/);
  assert.equal((await readJournal()).state.writer.completed.length, 0);
  await assert.rejects(publishElectronStableFeed({ ...options, phase: 'rollback' }), /READBACK_STATUS_INVALID/);
  assert(objects.has(feed.objectKey));
  assert.equal(calls.filter(([kind]) => ['put', 'delete'].includes(kind)).length, 0);
}));


test('pinned CLI adapter refuses native namespace and installer deletion before command dispatch', async () => fixture(async ({ root }) => {
  let calls = 0;
  const remote = createElectronStableR2Transport({ temporaryDirectory: root, spawn: () => { calls++; return { status: 1, stderr: 'Access denied' }; } });
  await assert.rejects(remote.put('tibotattle-updates', { objectKey: 'appcast.xml' }, 'unused'), /R2_TARGET_INVALID/);
  await assert.rejects(remote.delete('tibotattle-updates', 'electron/stable/win32-x64/TiboTattle-1.0.0-Windows-x64.exe'), /R2_DELETE_TARGET_INVALID/);
  assert.equal(calls, 0);
  await assert.rejects(remote.get('tibotattle-updates', 'electron/stable/win32-x64/latest.yml'), /R2_READ_FAILED/);
  assert.equal(calls, 1);
}));
