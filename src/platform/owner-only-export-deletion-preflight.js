import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";

function invalid() { throw new TypeError("Owner-only export deletion preflight configuration is invalid"); }
function ownFunction(configuration, key) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function"
      || isProxy(descriptor.value)) invalid();
  return descriptor.value;
}
function ownValue(configuration, key) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) invalid();
  return descriptor.value;
}

/** Owner-only directory, artifact, hash, and canonical-control inspection. */
export function createOwnerOnlyExportDeletionPreflightInspector(configuration = {}) {
  const fail = ownFunction(configuration, "fail");
  const isTrustedDeletionError = ownFunction(configuration, "isTrustedDeletionError");
  const stableJson = ownFunction(configuration, "stableJson");
  const assertValidExportSetManifest = ownFunction(configuration, "assertValidExportSetManifest");
  const maximumDirectoryEntries = ownValue(configuration, "maximumDirectoryEntries");
  const maximumManifestBytes = ownValue(configuration, "maximumManifestBytes");
  if (!Number.isSafeInteger(maximumDirectoryEntries) || maximumDirectoryEntries < 1
      || !Number.isSafeInteger(maximumManifestBytes) || maximumManifestBytes < 1) invalid();
  function rethrowTrustedOrFail(error, code) {
    let trusted = false;
    try {
      trusted = Reflect.apply(isTrustedDeletionError, undefined, [error]) === true;
    } catch {
      trusted = false;
    }
    if (trusted) throw error;
    fail(code);
  }
  function freezeJson(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) freezeJson(nested);
    return Object.freeze(value);
  }
  function directoryStats(stats) {
    return Object.freeze({ dev: Number(stats.dev), ino: Number(stats.ino) });
  }
  function sameStats(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink;
  }
  function assertOwnerDirectory(stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail("directory");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("directory");
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("directory");
  }
  async function directoryEntries(path, options = {}) {
    return readBoundedDirectoryEntries(path, {
      maximumEntries: maximumDirectoryEntries,
      ...options,
    });
  }
  async function inspectDirectory(path) {
    const requested = resolve(path);
    if (requested === parse(requested).root) fail("directory");
    let stats; let canonical;
    try {
      stats = await lstat(requested); assertOwnerDirectory(stats); canonical = await realpath(requested);
    } catch (error) { rethrowTrustedOrFail(error, "directory"); }
    const parentPath = dirname(canonical); let parentStats;
    try { parentStats = await lstat(parentPath); assertOwnerDirectory(parentStats); }
    catch (error) { rethrowTrustedOrFail(error, "directory"); }
    let entries;
    try {
      entries = await directoryEntries(canonical, { sort: true });
    } catch (error) {
      rethrowTrustedOrFail(error, "directory");
    }
    return Object.freeze({
      path: canonical,
      stats: directoryStats(stats),
      parent: Object.freeze({ path: parentPath, stats: directoryStats(parentStats) }),
      entries: Object.freeze(entries),
    });
  }
  function assertArtifactStats(stats, maximumBytes) {
    if (!stats.isFile() || stats.isSymbolicLink()) fail("artifact_type");
    if (stats.nlink !== 1) fail("artifact_links");
    if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes) fail("artifact_size");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("artifact_owner");
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("artifact_permissions");
  }
  async function hashOwnerOnlyFile(path, maximumBytes) {
    let before;
    try { before = await lstat(path); } catch (error) { if (error.code === "ENOENT") fail("artifact_missing"); fail("artifact_read"); }
    assertArtifactStats(before, maximumBytes); let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat(); assertArtifactStats(opened, maximumBytes);
      if (!sameStats(before, opened)) fail("artifact_changed");
      const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
      while (position < opened.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position); if (bytesRead < 1) fail("artifact_changed"); digest.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
      const after = await handle.stat(); if (!sameStats(opened, after)) fail("artifact_changed");
      return Object.freeze({ device: Number(after.dev), inode: Number(after.ino), fileType: "regular_file", linkCount: 1, byteSize: Number(after.size), sha256: digest.digest("hex") });
    } catch (error) { rethrowTrustedOrFail(error, "artifact_read"); }
    finally { await handle?.close().catch(() => {}); }
  }
  async function readCanonicalManifest(path) {
    const evidence = await hashOwnerOnlyFile(path, maximumManifestBytes); let bytes;
    try {
      bytes = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const text = await bytes.readFile("utf8"); const manifest = JSON.parse(text);
      if (stableJson(manifest) !== text) fail("set_state"); assertValidExportSetManifest(manifest);
      if (createHash("sha256").update(text).digest("hex") !== evidence.sha256 || Buffer.byteLength(text) !== evidence.byteSize) fail("artifact_changed");
      return Object.freeze({ manifest: freezeJson(manifest), text, evidence });
    } catch (error) { rethrowTrustedOrFail(error, "set_state"); }
    finally { await bytes?.close().catch(() => {}); }
  }
  async function assertDirectoryStable(directory) {
    const after = await lstat(directory.path); assertOwnerDirectory(after);
    if (after.dev !== directory.stats.dev || after.ino !== directory.stats.ino) fail("directory_changed");
    const parentAfter = await lstat(directory.parent.path); assertOwnerDirectory(parentAfter);
    if (parentAfter.dev !== directory.parent.stats.dev || parentAfter.ino !== directory.parent.stats.ino) fail("directory_changed");
    const entries = await directoryEntries(directory.path, { sort: true });
    if (stableJson(entries) !== stableJson(directory.entries)) fail("directory_changed");
  }
  return Object.freeze({ inspectDirectory, hashOwnerOnlyFile, readCanonicalManifest, assertDirectoryStable });
}
