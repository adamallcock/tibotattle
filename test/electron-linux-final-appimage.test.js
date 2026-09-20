import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { productionElectronCandidatePlan } from '../scripts/package-electron-production.mjs';
import { linuxAppImageIdentity } from '../scripts/build-linux-updater-rehearsal.mjs';
import { prepareLinuxFinalAppImage, verifyLinuxFinalAppImageRuntime } from '../scripts/qualify-electron-linux-final-appimage.mjs';

const revision = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-appimage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, '.release-build/electron-production/linux-x64');
  await mkdir(join(candidate, 'artifacts'), { recursive: true });
  await mkdir(join(candidate, 'app'));
  const plan = productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision: revision,
    buildNumber: '2026091401', hostPlatform: 'linux', hostArchitecture: 'x64' });
  const source = join(candidate, 'production-source-candidate.json');
  await writeJson(source, { ...plan, status: 'production_source_staged',
    stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' });
  const artifactName = `TiboTattle-${plan.version}-linux-x86_64.AppImage`;
  const artifact = join(candidate, 'artifacts', artifactName);
  const bytes = Buffer.alloc(4096);
  Buffer.from([127, 69, 76, 70, 2]).copy(bytes);
  Buffer.from([65, 73, 2]).copy(bytes, 8); bytes.writeUInt16LE(62, 18);
  await writeFile(artifact, bytes);
  const packageReceipt = join(candidate, 'linux-production-package-receipt.json');
  await writeJson(packageReceipt, { schemaVersion: 'tibotattle-linux-production-package-v1',
    workflowRunnerRevision: 'b'.repeat(40), sourceRevision: revision, version: plan.version,
    buildNumber: plan.buildNumber, target: 'linux-x64', sourceCandidateSha256: hash(await readFile(source)),
    artifact: { file: artifactName, ...await linuxAppImageIdentity(artifact) },
    signingRequired: false, published: false, nativeRuntimeQualification: 'separate_evidence_required' });
  const runtime = join(candidate, 'final-runtime');
  const options = { repositoryRoot: root, sourceRevision: revision };
  const runExtractor = async (input, output) => {
    assert.equal(input, artifact);
    await mkdir(join(output, 'squashfs-root/resources'), { recursive: true });
    await writeFile(join(output, 'squashfs-root/tibotattle'), 'synthetic executable');
    await writeFile(join(output, 'squashfs-root/resources/app.asar'), 'synthetic archive');
  };
  const verifyPackage = async ({ appPath, stagedAppPath, sourceCandidatePath, sourceRevision }) => {
    assert.equal(appPath, join(runtime, 'extracted/squashfs-root/tibotattle'));
    assert.equal(stagedAppPath, join(candidate, 'app'));
    assert.equal(sourceCandidatePath, source);
    return { sourceRevision, target: 'linux-x64', executableSha256: hash(await readFile(appPath)),
      artifactSha256: hash(await readFile(join(dirname(appPath), 'resources/app.asar'))),
      native: { keytarSha256: 'c'.repeat(64), mutexSha256: 'd'.repeat(64) } };
  };
  const dependencies = { runExtractor, verifyPackage };
  const smoke = join(runtime, 'normal-packaged-smoke.json');
  const final = join(runtime, 'final-image-runtime.json');
  async function writeSmoke(patch = {}) {
    const identity = await verifyPackage({ appPath: join(runtime, 'extracted/squashfs-root/tibotattle'),
      stagedAppPath: join(candidate, 'app'), sourceCandidatePath: source, sourceRevision: revision });
    const value = { schemaVersion: 'tibotattle-electron-linux-normal-packaged-smoke-v1',
      status: 'passed', scope: 'candidate_only', target: 'linux-x64', sourceRevision: revision,
      artifactSha256: identity.artifactSha256, executableSha256: identity.executableSha256,
      packageArtifactVerified: true, packagedElectronExecutionVerified: true,
      accountObservationLifecycleVerified: true, unavailableServiceResponseVerified: true,
      coldRestartSettingsVerified: true, sharingOptOutPersisted: true, sessionCleanupConfirmed: true,
      errorCode: null, productionReady: false, ...patch };
    await writeJson(smoke, value);
  }
  return { options, dependencies, source, artifact, packageReceipt, runtime, final, smoke, writeSmoke };
}
test('final Linux runtime proof binds original AppImage, extracted ASAR, native identities and normal smoke', async t => {
  const f = await fixture(t);
  const prepared = await prepareLinuxFinalAppImage(f.options, f.dependencies);
  assert.equal(prepared.extraction, 'final_appimage_bytes');
  assert.equal(prepared.rebuilt, false);
  await f.writeSmoke();
  const proof = await verifyLinuxFinalAppImageRuntime(f.options, f.dependencies);
  assert.deepEqual(proof.artifact, prepared.artifact);
  assert.deepEqual(proof.extractedIdentity, prepared.extractedIdentity);
  assert.equal(proof.normalSmokeSha256, hash(await readFile(f.smoke)));
  assert.equal(proof.publicPredecessorUpdate, 'not_exercised');
  assert.equal(proof.appImageMountAndLauncher, 'not_exercised');
  assert.equal(proof.published, false);
  await assert.rejects(verifyLinuxFinalAppImageRuntime(f.options, f.dependencies), { code: 'EEXIST' });
  await assert.rejects(prepareLinuxFinalAppImage(f.options, f.dependencies), { code: 'EEXIST' });
});
test('wrong source or final AppImage bytes refuse extraction', async t => {
  for (const kind of ['source', 'bytes', 'receipt-source']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'bytes') { const bytes = await readFile(f.artifact); bytes[50]++; await writeFile(f.artifact, bytes); }
    if (kind === 'receipt-source') {
      const receipt = JSON.parse(await readFile(f.packageReceipt)); receipt.sourceRevision = 'e'.repeat(40);
      await writeJson(f.packageReceipt, receipt);
    }
    await assert.rejects(prepareLinuxFinalAppImage({ ...f.options,
      ...(kind === 'source' ? { sourceRevision: 'f'.repeat(40) } : {}) }, {
      ...f.dependencies, runExtractor: () => assert.fail('must refuse before extraction'),
    }), /LINUX_FINAL_APPIMAGE_/u);
    await assert.rejects(readFile(f.final), { code: 'ENOENT' });
  });
});
test('missing runtime receipt never becomes final-package qualification', async t => {
  const f = await fixture(t);
  await prepareLinuxFinalAppImage(f.options, f.dependencies);
  await assert.rejects(verifyLinuxFinalAppImageRuntime(f.options, f.dependencies), { code: 'ENOENT' });
  await assert.rejects(readFile(f.final), { code: 'ENOENT' });
});
test('runtime proof refuses failed, incomplete, wrong-source and different-byte smoke receipts', async t => {
  const f = await fixture(t);
  await prepareLinuxFinalAppImage(f.options, f.dependencies);
  for (const patch of [{ status: 'failed' }, { sourceRevision: 'e'.repeat(40) },
    { artifactSha256: 'f'.repeat(64) }, { executableSha256: 'f'.repeat(64) },
    { coldRestartSettingsVerified: false }, { sharingOptOutPersisted: false },
    { sessionCleanupConfirmed: false }, { accountObservationLifecycleVerified: false },
    { errorCode: 'incomplete' }]) {
    await f.writeSmoke(patch);
    await assert.rejects(verifyLinuxFinalAppImageRuntime(f.options, f.dependencies), /RUNTIME_UNPROVEN/u);
  }
  await assert.rejects(readFile(f.final), { code: 'ENOENT' });
});
test('final image or extracted ASAR changes after preparation invalidate runtime proof', async t => {
  for (const kind of ['image', 'asar', 'source-receipt']) await t.test(kind, async t => {
    const f = await fixture(t);
    await prepareLinuxFinalAppImage(f.options, f.dependencies);
    await f.writeSmoke();
    const path = kind === 'image' ? f.artifact : kind === 'asar'
      ? join(f.runtime, 'extracted/squashfs-root/resources/app.asar') : f.source;
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]));
    await assert.rejects(verifyLinuxFinalAppImageRuntime(f.options, f.dependencies), /LINUX_FINAL_APPIMAGE_/u);
    await assert.rejects(readFile(f.final), { code: 'ENOENT' });
  });
});
