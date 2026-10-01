import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createSourceFileAccess } from "./source-file-access.js";

const SIDECARS = ["-wal", "-shm", "-journal"];

export function ownerControlledRegularFile(stats) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && (uid === null || stats.uid === uid) && (stats.mode & 0o022) === 0;
}

export function createLocalCodexMetadataFilesystem({
  platform = process.platform, loadWindowsBinding,
} = {}) {
  const windows = platform === "win32";
  // Resolve only when needed, so an unavailable native capability is an ordinary
  // optional-metadata refusal rather than an import-time application failure.
  let sourceAccess;
  const sources = () => sourceAccess ??= createSourceFileAccess({ platform, loadWindowsBinding });
  const same = (before, after) => (windows || ownerControlledRegularFile(after))
    && before.dev === after.dev && before.ino === after.ino;

  async function openFile(path) {
    if (windows) {
      const handle = await sources().open(path);
      try { return { path, handle, before: await handle.stat() }; }
      catch (error) { await handle.close(); throw error; }
    }
    const before = await lstat(path);
    if (!ownerControlledRegularFile(before)) throw new Error("unsafe_metadata_source");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!same(before, await handle.stat())) throw new Error("unsafe_metadata_source");
      return { path, handle, before };
    } catch (error) { await handle.close(); throw error; }
  }

  async function sidecarExists(path) {
    try { await lstat(path); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }

  return Object.freeze({
    async validHome(path) {
      if (typeof path !== "string" || path.length === 0) return false;
      try {
        const stats = await lstat(path);
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        // On Windows the subsequent native source open authenticates the file
        // owner and traverses every ancestor with held, reparse-rejecting handles.
        return stats.isDirectory() && !stats.isSymbolicLink()
          && (windows || ((uid === null || stats.uid === uid) && (stats.mode & 0o022) === 0));
      } catch { return false; }
    },
    openFile,
    same,
    namedStat: (path, handle) => windows ? sources().namedStat(path, handle) : lstat(path),
    async guardDatabase(path) {
      const held = [];
      const absent = [];
      const release = async () => {
        let failure;
        for (const entry of held.splice(0).reverse()) {
          try { await entry.handle.close(); } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
      };
      try {
        held.push(await openFile(path));
        const databaseHeader = Buffer.alloc(20);
        const readHeader = async () => {
          const bytes = Buffer.alloc(20);
          const { bytesRead } = await held[0].handle.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== bytes.length || bytes.toString("ascii", 0, 16) !== "SQLite format 3\0"
              || ![1, 2].includes(bytes[18]) || bytes[18] !== bytes[19]) {
            throw new Error("unsafe_metadata_database");
          }
          return bytes;
        };
        (await readHeader()).copy(databaseHeader);
        for (const suffix of SIDECARS) {
          const sidecar = `${path}${suffix}`;
          if (await sidecarExists(sidecar)) held.push(await openFile(sidecar));
          else absent.push(sidecar);
        }
        // SQLite can create coordination files even with a read-only main
        // connection. A closed database with no sidecars uses immutable URI
        // mode, which never opens sidecars; validate the held main's full file
        // state before publishing. A live WAL must have both leased WAL/SHM so
        // its committed rows remain visible through the ordinary SQLite reader.
        const immutable = absent.length === SIDECARS.length;
        if (!immutable && databaseHeader[18] === 2
            && (absent.includes(`${path}-wal`) || absent.includes(`${path}-shm`))) {
          throw new Error("unsafe_metadata_database");
        }
        // Windows leases prevent replacement of existing files and ancestors;
        // POSIX paths are revalidated against held descriptors. An
        // absent sidecar cannot be leased without mutating Codex's source; a
        // changed sidecar set therefore refuses this optional result. This does
        // not claim protection against a transient create/remove of an absent
        // name by a hostile same-owner process between the checks.
        return {
          databasePath: immutable ? `${pathToFileURL(path).href}?mode=ro&immutable=1` : path,
          async validate() {
            if (!(await readHeader()).equals(databaseHeader)) return false;
            for (const entry of held) {
              const after = await entry.handle.stat();
              if (!same(entry.before, after)) return false;
              if (!windows && !same(entry.before, await lstat(entry.path))) return false;
              if (immutable && (entry.before.size !== after.size
                  || entry.before.mtimeMs !== after.mtimeMs
                  || entry.before.ctimeMs !== after.ctimeMs)) return false;
            }
            for (const sidecar of absent) if (await sidecarExists(sidecar)) return false;
            return true;
          },
          release,
        };
      } catch (error) { await release(); throw error; }
    },
  });
}
