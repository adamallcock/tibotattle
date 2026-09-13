import { constants } from 'node:fs';
import { lstat, open, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadWindowsTimingBinding } from './windows-filesystem.js';

const safe = (ok, code) => { if (!ok) throw new Error(code); };
const ownerFile = s => s.isFile() && s.nlink === 1
  && s.uid === process.getuid() && !(s.mode & 0o077);

// The injected loader is for portable/native qualification tests. Production
// always uses the manifest-verified, approved Windows capability loader.
export function createTimingFilesystem({ platform = process.platform,
  loadWindowsBinding = loadWindowsTimingBinding } = {}) {
  if (platform !== 'win32') return {
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
    async openSource(path) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        safe(stat.isFile() && stat.uid === process.getuid(), 'unsafe_source');
        return handle;
      } catch (e) { await handle.close(); throw e; }
    },
    namedStat: path => lstat(path),
  };

  const native = loadWindowsBinding();
  return {
    readSize: 64 * 1024,
    async prepare(directory) {
      const dir = resolve(directory), file = join(dir, 'timing-experiment.sqlite');
      // Validate existing parents; never repair their ACLs. The native guard
      // authenticates and holds the private directory and its parent.
      native.ensureDirectory(dirname(dir));
      native.ensureDirectory(dir);
      const guards = [];
      let created = false;
      try {
        for (const path of [file, `${file}-journal`]) {
          try {
            native.createFile(path, Buffer.alloc(0));
            if (path === file) created = true;
          } catch (e) {
            if (e.code !== 'WINDOWS_FILESYSTEM_ALREADY_EXISTS' && e.code !== 'EEXIST') throw e;
          }
          guards.push(native.acquireCredentialAuditFileGuard(path).guard);
        }
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
        for (const guard of guards.reverse()) {
          try { native.releaseCredentialAuditFileGuard(guard); } catch { /* Preserve original failure. */ }
        }
        throw e;
      }
      let released = false;
      return { file, created, persistentJournal: true, release() {
        if (released) return;
        released = true;
        let failed = false;
        for (const guard of guards.reverse()) {
          try { native.releaseCredentialAuditFileGuard(guard); } catch { failed = true; }
        }
        safe(!failed, 'timing_guard_release_failed');
      } };
    },
    async openSource(path) {
      const lease = native.openTimingSource(path);
      let closed = false;
      return {
        async stat() { safe(!closed, 'timing_source_closed'); return native.statTimingSource(lease); },
        async read(buffer, offset, length, position) {
          safe(!closed, 'timing_source_closed');
          safe(Buffer.isBuffer(buffer) && Number.isSafeInteger(offset) && offset >= 0
            && Number.isSafeInteger(length) && length >= 0 && length <= 65536
            && offset + length <= buffer.length && Number.isSafeInteger(position) && position >= 0,
          'invalid_timing_read');
          const data = native.readTimingSource(lease, position, length);
          safe(Buffer.isBuffer(data) && data.length <= length, 'invalid_timing_read');
          data.copy(buffer, offset);
          return { bytesRead: data.length, buffer };
        },
        async close() { if (!closed) { closed = true; native.releaseCredentialAuditFileGuard(lease); } },
      };
    },
    // The native lease holds every ancestor and the source without delete
    // sharing, so the name cannot change until the chunk is committed.
    namedStat: (_path, handle) => handle.stat(),
  };
}
