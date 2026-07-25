import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { discoverCodexRolloutInfos } from "./codex-log-scan.js";
import { stableJson } from "./storage.js";

export const EXPORT_SOURCE_PLAN_VERSION = "codex-export-source-plan-v2";

const SAFE_SOURCE_PLAN_CODES = new Set([
  "source_missing",
  "source_type",
  "source_owner",
  "source_links",
  "source_changed",
  "source_prefix",
  "source_duplicate",
  "source_lineage",
]);

export class ExportSourcePlanError extends Error {
  constructor(code) {
    if (!SAFE_SOURCE_PLAN_CODES.has(code)) throw new TypeError("Unknown export source-plan failure code");
    super(`Local export source plan failed (${code})`);
    this.name = "ExportSourcePlanError";
    this.code = `export_source_${code}`;
  }
}

function fail(code) {
  throw new ExportSourcePlanError(code);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sourceKey(rolloutKey) {
  return createHash("sha256")
    .update("app-usagemonitor/codex-source-key/v1\0")
    .update(rolloutKey)
    .digest("hex");
}

function sameIdentity(stats, expected) {
  if (Number.isSafeInteger(expected?.dev) && stats.dev !== expected.dev) return false;
  if (Number.isSafeInteger(expected?.ino) && stats.ino !== expected.ino) return false;
  if (Number.isFinite(expected?.birthtimeMs)
      && Math.trunc(stats.birthtimeMs) !== Math.trunc(expected.birthtimeMs)) return false;
  return true;
}

function assertSafeSourceStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("source_type");
  if (stats.nlink !== 1) fail("source_links");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("source_owner");
}

async function openSource(path, expectedIdentity = null) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    assertSafeSourceStats(stats);
    if (expectedIdentity && !sameIdentity(stats, expectedIdentity)) fail("source_changed");
    return { handle, stats };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof ExportSourcePlanError) throw error;
    if (error?.code === "ENOENT") fail("source_missing");
    if (error?.code === "ELOOP") fail("source_type");
    fail("source_changed");
  }
}

async function completeLinePrefixBytes(handle, size, resourceGuard = null) {
  if (!Number.isSafeInteger(size) || size < 0) fail("source_changed");
  const chunkBytes = 256 * 1024;
  for (let end = size; end > 0;) {
    resourceGuard?.checkRuntime();
    const start = Math.max(0, end - chunkBytes);
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) fail("source_changed");
    const newline = buffer.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function sha256Prefix(handle, prefixBytes, resourceGuard = null) {
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) fail("source_prefix");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (offset < prefixBytes) {
    resourceGuard?.checkRuntime();
    const length = Math.min(buffer.length, prefixBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest("hex");
}

function publicDigestRows(sources) {
  return sources.map((source) => ({
    ordinal: source.ordinal,
    sourceKey: source.sourceKey,
    prefixBytes: source.prefixBytes,
    prefixSha256: source.prefixSha256,
    parentSourceKey: source.parentSourceKey ?? null,
    isFork: Boolean(source.isFork),
    parentMissing: Boolean(source.parentMissing),
  }));
}

function planDigest(sources) {
  return createHash("sha256")
    .update("app-usagemonitor/export-source-plan/v2\0")
    .update(stableJson(publicDigestRows(sources)))
    .digest("hex");
}

export function summarizeExportSourcePlan(plan) {
  if (!plan || !Array.isArray(plan.sources) || plan.sourcePlanSha256 !== planDigest(plan.sources)) {
    fail("source_changed");
  }
  return {
    schemaVersion: EXPORT_SOURCE_PLAN_VERSION,
    sourcePlanSha256: plan.sourcePlanSha256,
    sourceFiles: plan.sources.length,
    sourceBytes: plan.sources.reduce((sum, source) => sum + source.prefixBytes, 0),
  };
}

export async function createCodexExportSourcePlan({
  codexHome,
  startAt,
  endAt,
  resourceGuard = null,
} = {}) {
  const infos = await discoverCodexRolloutInfos({ codexHome, startAt, endAt, resourceGuard });
  const sources = [];
  for (const [ordinal, info] of infos.entries()) {
    resourceGuard?.checkRuntime();
    const { handle, stats } = await openSource(info.path, info);
    try {
      const prefixBytes = await completeLinePrefixBytes(handle, stats.size, resourceGuard);
      sources.push({
        ordinal,
        sourceKey: sourceKey(info.rolloutKey),
        path: info.path,
        dev: stats.dev,
        ino: stats.ino,
        birthtimeMs: Math.trunc(stats.birthtimeMs),
        prefixBytes,
        prefixSha256: await sha256Prefix(handle, prefixBytes, resourceGuard),
        rolloutInfo: { ...info, size: prefixBytes },
      });
    } finally {
      await handle.close();
    }
  }
  const sourceKeyBySessionId = new Map(sources
    .filter((source) => typeof source.rolloutInfo?.lineage?.sessionId === "string")
    .map((source) => [source.rolloutInfo.lineage.sessionId, source.sourceKey]));
  for (const source of sources) {
    const parentId = source.rolloutInfo?.lineage?.parentId;
    source.isFork = Boolean(source.rolloutInfo?.lineage?.isFork);
    source.parentSourceKey = typeof parentId === "string"
      ? (sourceKeyBySessionId.get(parentId) ?? null)
      : null;
    source.parentMissing = source.isFork && source.parentSourceKey === null;
  }
  const sourceByKey = new Map(sources.map((source) => [source.sourceKey, source]));
  for (const source of sources) {
    const seen = new Set([source.sourceKey]);
    let cursor = source;
    let depth = 0;
    while (cursor.parentSourceKey !== null) {
      if (seen.has(cursor.parentSourceKey) || depth >= 1_000) fail("source_lineage");
      seen.add(cursor.parentSourceKey);
      cursor = sourceByKey.get(cursor.parentSourceKey);
      if (!cursor) fail("source_lineage");
      depth += 1;
    }
  }
  const keys = new Set(sources.map((source) => source.sourceKey));
  if (keys.size !== sources.length) fail("source_duplicate");
  resourceGuard?.observeSourcePlan(
    sources.length,
    sources.reduce((sum, source) => sum + source.prefixBytes, 0),
  );
  return {
    schemaVersion: EXPORT_SOURCE_PLAN_VERSION,
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(endAt).toISOString(),
    sourcePlanSha256: planDigest(sources),
    sources,
  };
}

export async function verifyCodexExportSourcePlan(plan, { resourceGuard = null } = {}) {
  if (!plan || plan.schemaVersion !== EXPORT_SOURCE_PLAN_VERSION || !Array.isArray(plan.sources)) {
    fail("source_changed");
  }
  if (plan.sourcePlanSha256 !== planDigest(plan.sources)) fail("source_changed");
  for (const source of plan.sources) {
    resourceGuard?.checkRuntime();
    const handle = await openVerifiedCodexExportSource(source, { resourceGuard });
    try {
    } finally {
      await handle.close();
    }
  }
  return summarizeExportSourcePlan(plan);
}

export async function openVerifiedCodexExportSource(source, { resourceGuard = null } = {}) {
  if (!source || typeof source.path !== "string" || !Number.isSafeInteger(source.prefixBytes)
      || source.prefixBytes < 0 || !validSha256(source.prefixSha256)) fail("source_changed");
  const { handle, stats } = await openSource(source.path, source);
  try {
    await verifyCodexExportSourceHandle(source, handle, { resourceGuard, stats });
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function verifyCodexExportSourceHandle(source, handle, {
  resourceGuard = null,
  stats: suppliedStats = null,
} = {}) {
  if (!source || !handle || !Number.isInteger(handle.fd)) fail("source_changed");
  const stats = suppliedStats ?? await handle.stat();
  assertSafeSourceStats(stats);
  if (!sameIdentity(stats, source) || stats.size < source.prefixBytes) fail("source_changed");
  if (source.prefixBytes > 0) {
    const tail = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(tail, 0, 1, source.prefixBytes - 1);
    if (bytesRead !== 1 || tail[0] !== 0x0a) fail("source_prefix");
  }
  if (await sha256Prefix(handle, source.prefixBytes, resourceGuard) !== source.prefixSha256) {
    fail("source_changed");
  }
}

export async function resolveCodexExportSourcePlan(plan, {
  codexHome,
  resourceGuard = null,
} = {}) {
  if (!plan || plan.schemaVersion !== EXPORT_SOURCE_PLAN_VERSION || !Array.isArray(plan.sources)) {
    fail("source_changed");
  }
  const infos = await discoverCodexRolloutInfos({
    codexHome,
    startAt: plan.startAt,
    endAt: plan.endAt,
    resourceGuard,
  });
  const current = new Map();
  for (const info of infos) {
    const key = sourceKey(info.rolloutKey);
    if (current.has(key)) fail("source_duplicate");
    current.set(key, info);
  }
  const resolved = plan.sources.map((source) => {
    const info = current.get(source.sourceKey);
    if (!info) fail("source_missing");
    return {
      ...source,
      path: info.path,
      rolloutInfo: { ...info, size: source.prefixBytes },
    };
  });
  const result = { ...plan, sources: resolved };
  await verifyCodexExportSourcePlan(result, { resourceGuard });
  return result;
}
