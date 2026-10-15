import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cleanupLinuxExtraction, extractLinuxFinalImage, linuxExtractionArguments, receiveLinuxExtraction } from '../scripts/lib/linux-final-extraction.mjs';
import { emitLinuxExtractedFiles } from '../containers/electron-linux-extraction/extract.mjs';
const revision = 'a'.repeat(40), image = `sha256:${'b'.repeat(64)}`, id = 'c'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const size = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(n)); return bytes; };
const frame = (asar = Buffer.from('asar'), executable = Buffer.from('executable')) => Buffer.concat([size(asar.length), asar, size(executable.length), executable]);
async function directory(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-extraction-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('the extraction boundary exposes one readonly input with bounded resources and no host output', () => {
  const nonce = 'd'.repeat(32), input = '/synthetic/candidate.AppImage';
  const args = linuxExtractionArguments({ input, nonce, name: `tibotattle-extract-${nonce}`, image, uid: 1001, gid: 1001 });
  for (const value of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=2g', '--memory-swap=2g', '--pids-limit=32', '--cpus=1', '--log-driver=none']) assert.ok(args.includes(value));
  assert.equal(args.filter(value => value === '--mount').length, 1);
  assert.ok(args.includes(`type=bind,src=${input},dst=/input.AppImage,readonly`));
  assert.ok(args.includes('/scratch:rw,exec,nosuid,nodev,size=1610612736,mode=0700,uid=1001,gid=1001'));
  assert.equal(args.at(-1), image);
  assert.doesNotMatch(args.join(' '), /--device|--privileged|--volume|--env|docker\.sock|fuse|SYS_ADMIN|unconfined/u);
  for (const change of [{ input: '/synthetic/file,readonly=false' }, { uid: 0 }, { name: 'other' }, { image: 'mutable:latest' }]) {
    assert.throws(() => linuxExtractionArguments({ input, nonce, name: `tibotattle-extract-${nonce}`, image, uid: 1001, gid: 1001, ...change }));
  }
});
test('host accepts only two fixed bounded byte strings and independently checks exact identities', async t => {
  const root = await directory(t);
  const stream = Readable.from([...frame()].map(byte => Buffer.from([byte])));
  const paths = await receiveLinuxExtraction(stream, root, { asarSha256: digest('asar'), executableSha256: digest('executable') });
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), ['asar', 'executable']);
  for (const [name, bytes, expected] of [
    ['oversized', size(256 * 1024 ** 2 + 1), {}], ['empty', size(0), {}],
    ['truncated', frame().subarray(0, -1), {}], ['extra', Buffer.concat([frame(), Buffer.from('../outside')]), {}],
    ['tampered', frame(), { asarSha256: digest('different') }],
    ['second-tampered', frame(), { executableSha256: digest('different') }],
    ['path-framing', Buffer.from('../outside\n'), {}],
  ]) {
    const target = join(root, name); await mkdir(target);
    await assert.rejects(receiveLinuxExtraction(Readable.from([bytes]), target, expected));
    await assert.rejects(readFile(join(target, 'squashfs-root/resources/app.asar')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(target, 'squashfs-root/tibotattle')), { code: 'ENOENT' });
  }
});
test('extractor refuses linked, special, traversing and oversized exported files before opening them', async t => {
  const root = await directory(t);
  for (const kind of ['valid', 'symlink', 'hardlink', 'parent-symlink', 'directory', 'fifo', 'oversized']) {
    const base = join(root, kind); await mkdir(base); await mkdir(join(base, 'resources'));
    const asar = join(base, 'resources/app.asar');
    if (kind === 'symlink') { await writeFile(join(base, 'outside'), 'x'); await symlink('../outside', asar); }
    else if (kind === 'parent-symlink') { await rm(join(base, 'resources'), { recursive: true }); await mkdir(join(base, 'outside')); await writeFile(join(base, 'outside/app.asar'), 'x'); await symlink('outside', join(base, 'resources')); }
    else if (kind === 'directory') await mkdir(asar);
    else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [asar], { stdio: 'ignore' }).status, 0);
    else { await writeFile(asar, 'asar'); if (kind === 'hardlink') await link(asar, join(base, 'alias')); }
    if (kind === 'oversized') { const { truncate } = await import('node:fs/promises'); await truncate(asar, 256 * 1024 ** 2 + 1); }
    await writeFile(join(base, 'tibotattle'), 'executable');
    const chunks = [];
    if (kind === 'valid') { await emitLinuxExtractedFiles(base, bytes => chunks.push(bytes)); assert.deepEqual(Buffer.concat(chunks), frame()); }
    else { await assert.rejects(emitLinuxExtractedFiles(base, bytes => chunks.push(bytes))); assert.equal(chunks.length, 0); }
  }
});
function daemon() {
  const calls = []; let owner;
  const run = args => {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify({ Id: image, Config: { Labels: { 'org.opencontainers.image.revision': revision } } });
    if (args[0] === 'create') { owner = { name: args[args.indexOf('--name') + 1], nonce: args[args.indexOf('--label') + 1].split('=')[1] }; return id; }
    if (args[0] === 'ps') return owner ? id : '';
    if (args[0] === 'inspect') return JSON.stringify({ Id: id, Name: `/${owner.name}`, Image: image, Config: { Labels: { 'org.tibotattle.extraction.owner': owner.nonce } } });
    if (args[0] === 'rm') { owner = undefined; return id; }
    throw new Error('unexpected operation');
  };
  return { calls, run };
}
test('preparation never invokes an artifact on the host; interruption removes only the recorded container', async t => {
  const root = await directory(t), input = join(root, 'candidate'), marker = join(root, 'host-marker');
  await writeFile(input, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 });
  for (const mode of ['success', 'interrupt', 'timeout', 'invalid-output']) {
    const target = join(root, mode); await mkdir(target); const fake = daemon(), controller = new AbortController();
    const start = (command, args, options) => {
      assert.equal(command, 'docker'); assert.deepEqual(args, ['start', '--attach', id]);
      assert.deepEqual(Object.keys(options.env).sort(), ['DOCKER_CONFIG', 'DOCKER_HOST', 'PATH']);
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.kill = () => { child.stdout.destroy(); queueMicrotask(() => child.emit('close', 137)); };
      if (mode === 'success' || mode === 'invalid-output') setImmediate(() => { child.stdout.end(mode === 'success' ? frame() : Buffer.from('../outside')); setImmediate(() => child.emit('close', 0)); });
      if (mode === 'interrupt') setImmediate(() => controller.abort());
      return child;
    };
    const work = extractLinuxFinalImage(input, target, { runnerRevision: revision, run: fake.run, start,
      signal: controller.signal, timeoutMs: mode === 'timeout' ? 30 : 5000 });
    if (mode === 'success') await work; else await assert.rejects(work);
    assert.equal(fake.calls.filter(args => args[0] === 'rm').length, 1);
    assert.deepEqual(fake.calls.find(args => args[0] === 'rm'), ['rm', '--force', id]);
    await cleanupLinuxExtraction(target, { run: fake.run });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});
test('cleanup refuses a forged owner record without removing anything', async t => {
  const root = await directory(t), nonce = 'd'.repeat(32);
  await writeFile(join(root, 'extraction-state.json'), JSON.stringify({ name: `tibotattle-extract-${nonce}`, nonce, image }), { mode: 0o600 });
  const calls = [];
  await assert.rejects(cleanupLinuxExtraction(root, { run: args => { calls.push(args); return args[0] === 'ps' ? id : JSON.stringify({ Id: id, Name: '/unrelated', Image: image, Config: { Labels: {} } }); } }));
  assert.equal(calls.some(args => args[0] === 'rm'), false);
});
test('both downloaded-artifact workflows establish extraction containment before preparation', async () => {
  for (const name of ['electron-linux-final-qualification', 'electron-linux-appimage-mount-diagnosis']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.ok(workflow.indexOf('containers/electron-linux-extraction/Dockerfile') < workflow.indexOf('.mjs --prepare'));
    assert.match(workflow, /--cleanup-extraction/u);
    assert.match(workflow, /TIBOTATTLE_LINUX_EXTRACTION_SMOKE=1/u);
    assert.doesNotMatch(workflow, /qualify-electron-linux-final-appimage\.mjs|--appimage-extract/u);
  }
  const source = await readFile(new URL('../scripts/qualify-electron-linux-installed-lifecycle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /spawnSync\(path|--appimage-extract/u);
});

// Explicit native qualification step: ordinary source tests do not claim Docker
// or native Linux runtime proof. The two owning workflows require this exercise.
if (process.env.TIBOTATTLE_LINUX_EXTRACTION_SMOKE === '1') test('native container confines a malicious marker and exports exact fixed files', async t => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const root = await directory(t), input = join(root, 'candidate'), marker = join(root, 'host-marker'), output = join(root, 'output');
  await mkdir(output);
  await writeFile(input, `#!/bin/sh\nprintf unsafe > '${marker}' 2>/dev/null\nmkdir -p squashfs-root/resources\nprintf asar > squashfs-root/resources/app.asar\nprintf executable > squashfs-root/tibotattle\n`, { mode: 0o600 });
  await extractLinuxFinalImage(input, output, { runnerRevision: process.env.QUALIFICATION_RUNNER,
    expected: { asarSha256: digest('asar'), executableSha256: digest('executable') } });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(join(output, 'squashfs-root/resources/app.asar'), 'utf8'), 'asar');
});
