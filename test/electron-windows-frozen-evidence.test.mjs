import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { retainWindowsFrozenComparison } from '../scripts/qualify-electron-windows-frozen-installer.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'windows-frozen-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const virtualRoot = String.raw`C:\fixture`;
  const mapped = target => {
    assert.ok(target === virtualRoot || target.startsWith(`${virtualRoot}\\`));
    return join(root, ...win32.relative(virtualRoot, target).split('\\'));
  };
  await mkdir(join(root, 'candidate'));
  await mkdir(join(root, 'predecessor'));
  await mkdir(join(root, 'evidence'));
  const candidate = { schemaVersion: 'tibotattle-electron-production-source-candidate-v1',
    version: '0.1.27', sourceRevision: 'a'.repeat(40), target: 'win32-x64', status: 'production_source_staged' };
  const predecessor = { ...candidate, version: '0.1.26', sourceRevision: 'b'.repeat(40),
    referenceOrigin: 'extracted_from_exact_signed_installer', independentPreSigningStage: false };
  const originals = { candidate: Buffer.from(`${JSON.stringify(candidate)}\n`),
    predecessor: Buffer.from(`${JSON.stringify(predecessor)}\n`) };
  for (const role of ['candidate', 'predecessor']) {
    await writeFile(join(root, role, 'production-source-candidate.json'), originals[role]);
  }
  return { root, originals, signingStageBytes: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`),
    input: role => join(root, role, 'production-source-candidate.json'),
    output: role => join(root, 'evidence', `frozen-${role}-source-candidate.json`),
    options: role => ({ sourceCandidatePath: win32.join(virtualRoot, role, 'production-source-candidate.json'),
      evidenceDirectory: win32.join(virtualRoot, 'evidence'), role }),
    fileSystem: { inspect: (target, options) => lstat(mapped(target), options),
      openFile: (target, flags, mode) => open(mapped(target), flags, mode) } };
}

test('retained comparisons preserve both receipt digests without substituting signing-stage serialization', async t => {
  const f = await fixture(t);
  const upgrade = { sourceCandidateSha256: hash(f.originals.candidate),
    predecessorSourceCandidateSha256: hash(f.originals.predecessor) };
  assert.notEqual(hash(f.signingStageBytes), upgrade.sourceCandidateSha256);
  assert.deepEqual(JSON.parse(f.signingStageBytes), JSON.parse(f.originals.candidate));
  for (const role of ['candidate', 'predecessor']) {
    const proof = await retainWindowsFrozenComparison(f.options(role), f.fileSystem);
    assert.deepEqual(proof, { file: `frozen-${role}-source-candidate.json`, bytes: f.originals[role].length,
      sha256: upgrade[role === 'candidate' ? 'sourceCandidateSha256' : 'predecessorSourceCandidateSha256'] });
    assert.deepEqual(await readFile(f.output(role)), f.originals[role]);
    assert.deepEqual(await readFile(f.input(role)), f.originals[role]);
  }
});

test('retention never overwrites evidence, even when the source comparison later differs', async t => {
  const f = await fixture(t);
  await retainWindowsFrozenComparison(f.options('candidate'), f.fileSystem);
  await writeFile(f.input('candidate'), f.signingStageBytes);
  await assert.rejects(retainWindowsFrozenComparison(f.options('candidate'), f.fileSystem), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.output('candidate')), f.originals.candidate);
  assert.deepEqual(await readFile(f.input('candidate')), f.signingStageBytes);
});

test('comparison retention refuses unknown roles before inspecting any files', async () => {
  for (const role of ['successor', '../candidate', 'toString', undefined]) {
    let inspected = 0, opened = 0;
    await assert.rejects(retainWindowsFrozenComparison({ role }, {
      inspect: () => { inspected += 1; assert.fail('invalid role must not inspect files'); },
      openFile: () => { opened += 1; assert.fail('invalid role must not create files'); },
    }), { code: 'ERR_ASSERTION' });
    assert.equal(inspected, 0); assert.equal(opened, 0);
  }
});

test('comparison retention refuses missing, oversized or aliased sources without creating retained evidence', async t => {
  for (const kind of ['absent', 'oversized', 'hardlink']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'absent') await rm(f.input('candidate'));
    if (kind === 'oversized') await writeFile(f.input('candidate'), Buffer.alloc(128 * 1024 + 1));
    if (kind === 'hardlink') await link(f.input('candidate'), `${f.input('candidate')}.alias`);
    await assert.rejects(retainWindowsFrozenComparison(f.options('candidate'), f.fileSystem));
    await assert.rejects(lstat(f.output('candidate')), { code: 'ENOENT' });
  });
});

test('a corrupted retained copy cannot return positive digest evidence', async t => {
  const f = await fixture(t);
  const originalOpen = f.fileSystem.openFile;
  f.fileSystem.openFile = async (target, flags, mode) => {
    const handle = await originalOpen(target, flags, mode);
    if (flags !== 'wx') return handle;
    return { writeFile: () => handle.writeFile('changed-after-read\n'),
      sync: () => handle.sync(), close: () => handle.close() };
  };
  await assert.rejects(retainWindowsFrozenComparison(f.options('candidate'), f.fileSystem));
  assert.deepEqual(await readFile(f.input('candidate')), f.originals.candidate);
});
