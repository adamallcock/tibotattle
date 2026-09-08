import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function operationError(code) {
  return Object.assign(new Error(code), { code });
}

export function identityDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function privateDirectory(path, create) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== resolve(path)
      || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
    throw operationError("RELEASE_OPERATION_DIRECTORY_UNSAFE");
  }
}

async function privateFile(path, { optional = false } = {}) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (optional && error.code === "ENOENT") return false;
    throw operationError("RELEASE_OPERATION_FILE_UNAVAILABLE");
  }
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
    throw operationError("RELEASE_OPERATION_FILE_UNSAFE");
  }
  return info;
}

export async function durablePrivateJson(path, value) {
  await privateDirectory(dirname(path), false);
  await privateFile(path, { optional: true });
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw operationError("RELEASE_OPERATION_TOO_LARGE");
  const temporary = join(dirname(path), `.receipt-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function readOperation(directory) {
  await privateDirectory(directory, false);
  const path = join(directory, "operation.json");
  const info = await privateFile(path);
  if (info.size > 1024 * 1024) throw operationError("RELEASE_OPERATION_TOO_LARGE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const actual = await handle.stat();
    if (actual.ino !== info.ino || actual.dev !== info.dev || actual.nlink !== 1) throw new Error();
    value = JSON.parse(await handle.readFile("utf8"));
  } catch { throw operationError("RELEASE_OPERATION_INVALID"); } finally { await handle.close(); }
  if (!value || Object.keys(value).sort().join() !== "binding,createdAt,id,kind,schema,state,updatedAt"
      || value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.binding)
      || !/^[a-f0-9-]{36}$/.test(value.id) || !["native", "production"].includes(value.kind)
      || !value.state || typeof value.state !== "object" || Array.isArray(value.state)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw operationError("RELEASE_OPERATION_INVALID");
  }
  return value;
}

// SQLite holds only the local mutex. Its OS lock is released on process death;
// durable operation state is separately fsynced, never rolled back with it.
// Do not put this directory on a network filesystem.
export async function openOperation({ directory, kind, binding, resume = false }) {
  directory = resolve(directory);
  await privateDirectory(directory, !resume);
  const lockPath = join(directory, "mutex.sqlite");
  if (!await privateFile(lockPath, { optional: true })) {
    try {
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.close();
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await privateFile(lockPath);
  let mutex;
  try {
    mutex = new DatabaseSync(lockPath);
    mutex.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    mutex?.close();
    throw operationError("RELEASE_OPERATION_BUSY");
  }
  try {
    const path = join(directory, "operation.json");
    let record;
    if (resume) {
      record = await readOperation(directory);
      if (record.kind !== kind || record.binding !== identityDigest(binding)) throw operationError("RELEASE_OPERATION_INPUT_MISMATCH");
    } else {
      if (await privateFile(path, { optional: true })) throw operationError("RELEASE_OPERATION_EXISTS_USE_RESUME");
      const now = new Date().toISOString();
      record = { schema: 1, kind, binding: identityDigest(binding), id: randomUUID(), createdAt: now, updatedAt: now, state: {} };
      await durablePrivateJson(path, record);
    }
    return {
      directory,
      get record() { return structuredClone(record); },
      async save(state) {
        const next = { ...record, state: structuredClone(state), updatedAt: new Date().toISOString() };
        await durablePrivateJson(path, next);
        record = next;
      },
      close() { if (mutex) { mutex.close(); mutex = null; } },
    };
  } catch (error) { mutex.close(); throw error; }
}
