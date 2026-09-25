import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function unavailable() {
  return new Response("Not Found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

function contentType(path) {
  const suffix = path.slice(path.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[suffix] ?? "application/octet-stream";
}

function safeAssetPath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.length > 4096
      || !pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    return null;
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (!decoded.startsWith("/") || decoded.split("/").some((part) => part === "..")) return null;
  const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
  if (relativePath.length === 0 || relativePath.startsWith(".")
      || relativePath.split("/").some((part) => part.length === 0 || part === ".")) {
    return null;
  }
  return relativePath;
}

/**
 * Serve an explicitly built, immutable asset directory behind the existing
 * Worker ASSETS.fetch contract. The directory is supplied by the audited
 * Cloud Build context; no request can select a path outside it.
 */
export async function createFilesystemAssets(rootDirectory) {
  if (typeof rootDirectory !== "string" || rootDirectory.length === 0
      || !isAbsolute(rootDirectory)) {
    throw new Error("ASSET_ROOT_INVALID");
  }
  const root = resolve(rootDirectory);
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("ASSET_ROOT_UNAVAILABLE");
  }
  const canonicalRoot = await realpath(root);
  return Object.freeze({
    async fetch(request) {
      if (!(request instanceof Request)
          || (request.method !== "GET" && request.method !== "HEAD")) {
        return unavailable();
      }
      const relativePath = safeAssetPath(new URL(request.url).pathname);
      if (relativePath === null) return unavailable();
      const candidate = resolve(canonicalRoot, relativePath);
      const candidateRelative = relative(canonicalRoot, candidate);
      if (candidateRelative.startsWith(".." + sep) || isAbsolute(candidateRelative)) {
        return unavailable();
      }
      let canonicalCandidate;
      try { canonicalCandidate = await realpath(candidate); } catch { return unavailable(); }
      const resolvedRelative = relative(canonicalRoot, canonicalCandidate);
      if (resolvedRelative.startsWith(".." + sep) || isAbsolute(resolvedRelative)) {
        return unavailable();
      }
      const stat = await lstat(canonicalCandidate).catch(() => null);
      if (stat === null || !stat.isFile() || stat.isSymbolicLink()
          || stat.size > MAX_ASSET_BYTES) return unavailable();
      const headers = {
        "cache-control": "public, max-age=60, must-revalidate",
        "content-length": String(stat.size),
        "content-type": contentType(relativePath),
        "x-content-type-options": "nosniff",
      };
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      const bytes = await readFile(canonicalCandidate).catch(() => null);
      if (bytes === null || bytes.byteLength > MAX_ASSET_BYTES) return unavailable();
      return new Response(bytes, { status: 200, headers });
    },
  });
}
