// Runs only inside the no-network, no-capability, read-only extraction container.
// Its output is still untrusted: the host independently bounds and hashes it.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function emit(bytes) { if (!process.stdout.write(bytes)) await once(process.stdout, 'drain'); }
export async function emitLinuxExtractedFiles(base, write = emit) {
  for (const [suffix, limit] of [['resources/app.asar', 256 * 1024 ** 2], ['tibotattle', 512 * 1024 ** 2]]) {
    const path = `${base}/${suffix}`;
    if (await realpath(path) !== path) throw new Error();
    const before = await lstat(path, { bigint: true });
    const same = stat => stat.isFile() && stat.nlink === 1n
      && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key]);
    if (!same(before) || before.size < 1n || before.size > BigInt(limit)) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(await file.stat({ bigint: true }))) throw new Error();
      const header = Buffer.alloc(8); header.writeBigUInt64BE(before.size); await write(header);
      let count = 0;
      for await (const bytes of file.createReadStream({ autoClose: false })) {
        count += bytes.length; if (count > Number(before.size)) throw new Error(); await write(bytes);
      }
      if (count !== Number(before.size) || !same(await file.stat({ bigint: true })) || !same(await lstat(path, { bigint: true }))) throw new Error();
    } finally { await file.close(); }
  }
}
async function main() {
  await copyFile('/input.AppImage', '/scratch/candidate', constants.COPYFILE_EXCL);
  await chmod('/scratch/candidate', 0o700);
  await mkdir('/scratch/extracted', { mode: 0o700 });
  const result = spawnSync('/scratch/candidate', ['--appimage-extract'], {
    cwd: '/scratch/extracted', shell: false, stdio: 'ignore', timeout: 120000,
    killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', HOME: '/scratch', TMPDIR: '/scratch' },
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error();
  await emitLinuxExtractedFiles('/scratch/extracted/squashfs-root');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { process.exitCode = 1; });
