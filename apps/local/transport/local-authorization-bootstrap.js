import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { isLocalCapability } from "./local-caller-authorization.js";

export const LOCAL_BOOTSTRAP_LIFETIME_MS = 15 * 60 * 1_000;
export const LOCAL_BOOTSTRAP_BASENAME = "dashboard-access.json";

function unavailable() {
  return new Error("local authorization bootstrap unavailable");
}

// The inherited descriptor is fixed by the trusted desktop launcher; its value
// is not a credential. Never accept a token in argv, environment or stdout.
export async function readInheritedLocalCapability(environment = process.env) {
  const descriptor = environment.USAGE_MONITOR_LOCAL_AUTH_FD;
  if (descriptor === undefined) return undefined;
  if (descriptor !== "5") throw unavailable();
  return new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(null, { fd: 5, autoClose: true, highWaterMark: 45 });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      if (value === null) rejectRead(unavailable());
      else resolveRead(value);
    };
    const timer = setTimeout(() => finish(null), 5_000);
    timer.unref?.();
    stream.on("error", () => finish(null));
    stream.on("data", (chunk) => {
      if (bytes.length + chunk.length > 44) { finish(null); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    stream.on("end", () => {
      const value = bytes.toString("utf8");
      finish(bytes.length === 44 && value.endsWith("\n")
        && isLocalCapability(value.slice(0, -1)) ? value.slice(0, -1) : null);
      bytes.fill(0);
    });
  });
}

function ownerOnly(metadata, kind) {
  return metadata[kind]() && !metadata.isSymbolicLink()
    && typeof process.getuid === "function" && metadata.uid === process.getuid()
    && (metadata.mode & 0o077) === 0
    && (kind !== "isFile" || metadata.nlink === 1);
}

// Standalone browsers cannot obtain the credential from unauthenticated HTTP.
// The user selects this short-lived owner-only file; the dashboard keeps its
// contents in memory only. Windows needs a qualified ACL writer, so the desktop
// private pipe remains its available authorization path.
export async function writeLocalAuthorizationBootstrap({ stateRoot, origin, capability, now = Date.now }) {
  if (process.platform === "win32") return null;
  if (!isLocalCapability(capability) || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)) {
    throw unavailable();
  }
  const selectedRoot = resolve(stateRoot);
  if (!ownerOnly(await lstat(selectedRoot), "isDirectory")) throw unavailable();
  // System-owned ancestor aliases (for example macOS temporary directories)
  // are legitimate; resolve them once, then use only the canonical root.
  const root = await realpath(selectedRoot);
  const directory = join(root, "private");
  if (!ownerOnly(await lstat(root), "isDirectory") || await realpath(root) !== root) throw unavailable();
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw unavailable();
  });
  if (!ownerOnly(await lstat(directory), "isDirectory") || await realpath(directory) !== directory) throw unavailable();
  const file = join(directory, LOCAL_BOOTSTRAP_BASENAME);
  try {
    if (!ownerOnly(await lstat(file), "isFile")) throw unavailable();
  } catch (error) {
    if (error.code !== "ENOENT") throw unavailable();
  }
  const temporary = join(directory, `.dashboard-access-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, origin, capability, expiresAt: now() + LOCAL_BOOTSTRAP_LIFETIME_MS }));
    await handle.sync();
    const written = await handle.stat();
    if (!ownerOnly(written, "isFile")) throw unavailable();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const published = await lstat(file);
    if (published.ino !== written.ino || published.dev !== written.dev) throw unavailable();
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(expiration);
      try {
        const current = await lstat(file);
        if (current.ino === written.ino && current.dev === written.dev && ownerOnly(current, "isFile")) await unlink(file);
      } catch { /* A missing or replaced file is never removed. */ }
    };
    const expiration = setTimeout(() => { void dispose(); }, LOCAL_BOOTSTRAP_LIFETIME_MS);
    expiration.unref?.();
    return Object.freeze({ dispose });
  } catch {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw unavailable();
  }
}
