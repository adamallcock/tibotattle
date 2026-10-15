import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const ROUTES = new Set(["/api/local/health", "/api/local/overview", "/api/local/refresh"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const LIFETIME_MS = 15 * 60 * 1000;
function unavailable() { return new Error("Owner-selected local authorization unavailable"); }
function owned(stat, file = false) {
  return (file ? stat.isFile() && stat.nlink === 1 : stat.isDirectory())
    && !stat.isSymbolicLink() && typeof process.getuid === "function"
    && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Only an explicit owner-selected standalone bootstrap authorizes these reads.
 * Electron deliberately has no file credential; inspect it via its renderer. */
export async function createOwnerAuthorizedLocalReader(file, {
  fetchImpl = globalThis.fetch, now = Date.now, expectedOrigin,
} = {}) {
  let handle;
  try {
    if (typeof file !== "string" || process.platform === "win32" || typeof fetchImpl !== "function") throw unavailable();
    const path = resolve(file), directory = dirname(path), root = dirname(directory);
    if (basename(path) !== "dashboard-access.json" || basename(directory) !== "private") throw unavailable();
    for (const selected of [root, directory]) {
      if (await realpath(selected) !== selected || !owned(await lstat(selected))) throw unavailable();
    }
    const before = await lstat(path);
    if (!owned(before, true) || before.size < 1 || before.size > 1024) throw unavailable();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!owned(opened, true) || !sameFile(before, opened)) throw unavailable();
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== opened.size || !sameFile(opened, await handle.stat())
        || !sameFile(opened, await lstat(path))) throw unavailable();
    let value;
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
    finally { bytes.fill(0); }
    if (!value || Object.keys(value).sort().join(",") !== "capability,expiresAt,origin,version"
        || value.version !== 1 || typeof value.capability !== "string" || !TOKEN.test(value.capability)
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now()
        || value.expiresAt > now() + LIFETIME_MS + 5000
        || typeof value.origin !== "string") throw unavailable();
    const originUrl = new URL(value.origin);
    if (originUrl.protocol !== "http:" || originUrl.hostname !== "127.0.0.1"
        || originUrl.username || originUrl.password || !originUrl.port
        || originUrl.origin !== value.origin || (expectedOrigin !== undefined && expectedOrigin !== value.origin)) throw unavailable();
    const { origin, capability, expiresAt } = value;
    return Object.freeze({ origin, async read(route) {
      if (!ROUTES.has(route) || now() >= expiresAt) throw unavailable();
      const controller = new AbortController();
      let reader;
      let timer;
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 20_000); });
        const task = (async () => {
          const response = await fetchImpl(new URL(route, origin), {
            signal: controller.signal, redirect: "error", cache: "no-store",
            headers: { "X-TiboTattle-Local-Capability": capability },
          });
          if (!response.ok || response.redirected) throw unavailable();
          const declared = response.headers.get("content-length");
          if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 4 * 1024 * 1024)) throw unavailable();
          reader = response.body?.getReader();
          if (!reader) throw unavailable();
          const chunks = []; let total = 0;
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            total += chunk.byteLength;
            if (total > 4 * 1024 * 1024) throw unavailable();
            chunks.push(Buffer.from(chunk));
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        })();
        return await Promise.race([task, deadline]);
      } catch { throw unavailable(); }
      finally { clearTimeout(timer); controller.abort(); try { void reader?.cancel().catch(() => {}); } catch {} }
    } });
  } catch { throw unavailable(); }
  finally { await handle?.close().catch(() => {}); }
}
