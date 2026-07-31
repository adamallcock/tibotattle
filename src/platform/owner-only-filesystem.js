import { open, lstat } from "node:fs/promises";

/**
 * Shared, low-level filesystem guards for owner-only local artifacts.
 * Consumers retain their public contracts; this module deliberately owns only
 * the canonical directory and inode primitives so those checks cannot drift.
 */
export async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertOwnerControlledDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Export destination must be a real directory");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Export destination must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error("Export destination must not be group- or world-writable");
  }
}

export async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
