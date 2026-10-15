// Downloaded AppImages execute only in a disposable, separately built boundary.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const LINUX_EXTRACTION_IMAGE = 'tibotattle-electron-linux-extraction:test';
const LIMITS = [256 * 1024 ** 2, 512 * 1024 ** 2];
const LABEL = 'org.tibotattle.extraction.owner';
const fail = () => { throw Object.assign(new Error('LINUX_FINAL_LIFECYCLE_EXTRACTION_FAILED'), { code: 'LINUX_FINAL_LIFECYCLE_EXTRACTION_FAILED' }); };
const environment = () => ({ PATH: process.env.PATH, DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: '/nonexistent' });
function docker(args) {
  const result = spawnSync('docker', args, { shell: false, env: environment(), encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, maxBuffer: 65536 });
  if (result.error || result.status !== 0 || result.signal) fail();
  return result.stdout.trim();
}
export function linuxExtractionArguments({ input, name, nonce, image, uid, gid }) {
  if (!/^tibotattle-extract-[a-f0-9]{32}$/u.test(name) || name !== `tibotattle-extract-${nonce}`
      || !/^sha256:[a-f0-9]{64}$/u.test(image) || !input.startsWith('/') || /[,\r\n]/u.test(input)
      || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) fail();
  return ['create', '--pull=never', '--name', name, '--label', `${LABEL}=${nonce}`,
    '--platform=linux/amd64', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user', `${uid}:${gid}`, '--pids-limit=32',
    '--memory=2g', '--memory-swap=2g', '--cpus=1', '--ulimit', 'fsize=1073741824:1073741824',
    '--ulimit', 'nofile=64:64', '--stop-timeout=2', '--log-driver=none',
    '--tmpfs', `/scratch:rw,exec,nosuid,nodev,size=1610612736,mode=0700,uid=${uid},gid=${gid}`,
    '--mount', `type=bind,src=${input},dst=/input.AppImage,readonly`, image];
}

// No archive member names or file types are accepted from the container. Even a
// compromised wrapper can only supply two bounded byte strings, never a path.
export async function receiveLinuxExtraction(stream, destination, expected = {}) {
  if (Object.keys(expected).some(key => !['asarSha256', 'executableSha256'].includes(key))
      || Object.values(expected).some(value => !/^[a-f0-9]{64}$/u.test(value))) fail();
  if (await realpath(destination) !== destination) fail();
  await mkdir(join(destination, 'squashfs-root'), { mode: 0o700 });
  await mkdir(join(destination, 'squashfs-root/resources'), { mode: 0o700 });
  const paths = ['squashfs-root/resources/app.asar', 'squashfs-root/tibotattle'].map(path => join(destination, path));
  const expectedHashes = [expected.asarSha256, expected.executableSha256];
  const created = [];
  let header = Buffer.alloc(0), index = 0, remaining = 0, handle, hash;
  try {
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        if (index >= paths.length) fail();
        if (!handle) {
          const take = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + take)]); offset += take;
          if (header.length < 8) continue;
          const size = header.readBigUInt64BE();
          if (size < 1n || size > BigInt(LIMITS[index])) fail();
          remaining = Number(size); header = Buffer.alloc(0);
          hash = createHash('sha256');
          handle = await open(paths[index], constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          created.push(paths[index]);
        }
        const take = Math.min(remaining, chunk.length - offset);
        if (take) { const bytes = chunk.subarray(offset, offset + take); hash.update(bytes); await handle.writeFile(bytes); }
        offset += take; remaining -= take;
        if (remaining === 0) {
          if (expectedHashes[index] && hash.digest('hex') !== expectedHashes[index]) fail();
          await handle.sync(); await handle.close(); handle = undefined; index += 1;
        }
      }
    }
    if (index !== paths.length || handle || header.length) fail();
  } catch (error) {
    await handle?.close().catch(() => {});
    // Only fixed newly-created targets are removed; never recurse into outputs.
    for (const path of created) await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return paths;
}

export async function cleanupLinuxExtraction(destination, { run = docker } = {}) {
  const file = join(destination, 'extraction-state.json');
  let state;
  try {
    if (await realpath(file) !== file) fail();
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 1024 || (stat.mode & 0o077) !== 0) fail();
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (Object.keys(state).sort().join() !== 'image,name,nonce' || !/^[a-f0-9]{32}$/u.test(state.nonce)
      || state.name !== `tibotattle-extract-${state.nonce}` || !/^sha256:[a-f0-9]{64}$/u.test(state.image)) fail();
  // Listing with the exact owner filter distinguishes absence from an inspect
  // failure; failure never authorizes deletion of another container.
  const ids = run(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${LABEL}=${state.nonce}`]);
  if (!ids) return;
  if (!/^[a-f0-9]{64}$/u.test(ids)) fail();
  const facts = JSON.parse(run(['inspect', '--format', '{{json .}}', ids]));
  if (facts.Id !== ids || facts.Name !== `/${state.name}` || facts.Image !== state.image || facts.Config?.Labels?.[LABEL] !== state.nonce) fail();
  run(['rm', '--force', ids]);
}

export async function extractLinuxFinalImage(input, destination, { runnerRevision, run = docker, start = spawn,
  signal, timeoutMs = 150000, expected = {} } = {}) {
  if (!/^[a-f0-9]{40}$/u.test(runnerRevision ?? '') || await realpath(input) !== input
      || await realpath(destination) !== destination) fail();
  const facts = JSON.parse(run(['image', 'inspect', '--format', '{{json .}}', LINUX_EXTRACTION_IMAGE]));
  if (!/^sha256:[a-f0-9]{64}$/u.test(facts.Id ?? '') || facts.Config?.Labels?.['org.opencontainers.image.revision'] !== runnerRevision) fail();
  const nonce = randomBytes(16).toString('hex'), name = `tibotattle-extract-${nonce}`;
  const state = { name, nonce, image: facts.Id };
  const handle = await open(join(destination, 'extraction-state.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
  let child, timer, interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGKILL'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop); signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) fail();
    const id = run(linuxExtractionArguments({ input, ...state, uid: process.getuid(), gid: process.getgid() }));
    if (!/^[a-f0-9]{64}$/u.test(id)) fail();
    child = start('docker', ['start', '--attach', id], { shell: false, env: environment(), stdio: ['ignore', 'pipe', 'ignore'] });
    const ended = new Promise(resolve => { child.once('error', () => resolve(false)); child.once('close', code => resolve(code === 0)); });
    timer = setTimeout(stop, timeoutMs);
    await receiveLinuxExtraction(child.stdout, destination, expected);
    if (!await ended || interrupted) fail();
  } finally {
    clearTimeout(timer); child?.kill('SIGKILL');
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); signal?.removeEventListener('abort', stop);
    await cleanupLinuxExtraction(destination, { run });
  }
}
