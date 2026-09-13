import { constants } from 'node:fs';
import { lstat, open, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as pathApi from 'node:path';
import { loadWindowsSourceReadBinding } from './windows-filesystem.js';
import { createSourceFileAccess } from './source-file-access.js';
import { acquireProtectedSqliteFiles } from './windows-protected-sqlite.js';

const safe = (ok, code) => { if (!ok) throw new Error(code); };
const ownerFile = s => s.isFile() && s.nlink === 1
  && s.uid === process.getuid() && !(s.mode & 0o077);

// The injected loader is for portable/native qualification tests. Production
// always uses the manifest-verified, approved Windows capability loader.
export function createTimingFilesystem({ platform = process.platform,
  loadWindowsBinding = loadWindowsSourceReadBinding } = {}) {
  const native = platform === 'win32' ? loadWindowsBinding() : null;
  const sources = createSourceFileAccess({ platform, loadWindowsBinding: () => native });
  const sourceMethods = { openSource: path => sources.open(path), namedStat: sources.namedStat };
  if (platform !== 'win32') return {
    ...sourceMethods,
    async prepare(directory) {
      const dir = resolve(directory);
      safe(await realpath(dirname(dir)) === dirname(dir), 'unsafe_directory');
      await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const d = await lstat(dir);
      safe(d.isDirectory() && !d.isSymbolicLink() && d.uid === process.getuid()
        && !(d.mode & 0o077), 'unsafe_directory');
      const file = join(dir, 'timing-experiment.sqlite');
      let created = false;
      try {
        const h = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        await h.close(); created = true;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      safe(ownerFile(await lstat(file)), 'unsafe_database');
      return { file, created, persistentJournal: false, release() {} };
    },

  };

  return {
    ...sourceMethods,
    async prepare(directory) {
      const dir = resolve(directory), file = join(dir, 'timing-experiment.sqlite');
      const lease = acquireProtectedSqliteFiles({ native, path: file, pathApi });
      const { created } = lease;
      try {
        for (const suffix of ['-wal', '-shm']) {
          let missing = false;
          try { native.inspectPath(`${file}${suffix}`); } catch (e) {
            if (e.code !== 'WINDOWS_FILESYSTEM_NOT_FOUND' && e.code !== 'ENOENT') throw e;
            missing = true;
          }
          safe(missing, 'unsafe_journal_mode');
        }
        if (!created) {
          // The guarded name cannot be replaced during this bounded header read.
          const h = await open(file, constants.O_RDONLY);
          try {
            const header = Buffer.alloc(20);
            const { bytesRead } = await h.read(header, 0, 20, 0);
            safe(bytesRead === 20 && header.subarray(0, 16).toString() === 'SQLite format 3\0'
              && header[18] === 1 && header[19] === 1, 'incompatible_database');
          } finally { await h.close(); }
        }
      } catch (e) {
        try { lease.release(); } catch { /* Keep the validation failure. */ }
        throw e;
      }
      return { file, created, persistentJournal: true, release: lease.release };
    },
  };
}
