import { createLocalCodexLogScanner } from "../local-codex-log-scanner.js";
import { parseCodexRolloutFilename } from "../../providers/codex/logs.js";
import {
  EXPORT_SOURCE_PLAN_VERSION,
  ExportSourcePlanError,
  ExportResourceLimitError,
  createSourcePlanSummaryContract,
  stableJson,
  summarizeExportSourcePlan,
} from "../../export/index.js";
import { validSha256 } from "./source-validation.js";

export function createCodexSourcePlanContext(configuration) {
const {
  allocUnsafe,
  codexLogPorts,
  createHash,
  currentUid,
  fsConstants: constants,
  open,
} = configuration;
const {
  discoverCodexRolloutInfos,
  codexRolloutDiscoveryReceipt,
  readRolloutLineage,
} = createLocalCodexLogScanner(codexLogPorts);
const { compressedRolloutHandle, inspectCompressedRollout } = codexLogPorts.lineReader;

function isCompressedSource(source) {
  return typeof source?.path === "string" && source.path.endsWith(".jsonl.zst");
}

async function inspectCompressedSource(handle, resourceGuard) {
  try {
    return await inspectCompressedRollout(compressedRolloutHandle(handle), {
      resourceGuard,
      createLimitError: (code) => new ExportResourceLimitError(code),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error instanceof ExportResourceLimitError) throw error;
    fail("source_changed");
  }
}

function fail(code) { throw new ExportSourcePlanError(code); }

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
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) fail("source_owner");
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
  if (size === 0) return 0;
  resourceGuard?.checkRuntime();
  const tail = allocUnsafe(1);
  const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
  if (bytesRead !== 1) fail("source_changed");
  if (tail[0] !== 0x0a) fail("codex_rollout_tail_incomplete");
  return size;
}

async function sha256Prefix(handle, prefixBytes, resourceGuard = null) {
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) fail("source_prefix");
  const digest = createHash("sha256");
  const buffer = allocUnsafe(256 * 1024);
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

const { planDigest } = createSourcePlanSummaryContract();

function assertCheckpointHistory(lineage) {
  // A paginated root/reset starts fresh even when it has a logical parent.
  // Physical continuations need exact cutoff state and remain unsupported by
  // the persisted checkpoint format; never approximate them with a reset.
  if (lineage?.historyMode === "paginated"
      && (lineage.historyBase !== null
        || lineage.startOrdinalValid !== true || lineage.startOrdinal !== 0)) {
    fail("codex_rollout_checkpoint_history_unsupported");
  }
}

function sourcesBySession(sources) {
  const bySession = new Map();
  for (const source of sources) {
    const sessionId = source.rolloutInfo?.lineage?.sessionId;
    if (typeof sessionId !== "string") continue;
    const members = bySession.get(sessionId) ?? [];
    members.push(source);
    bySession.set(sessionId, members);
  }
  return bySession;
}

function replayAncestry(sources) {
  const bySession = sourcesBySession(sources);
  const selectedParents = new Map();
  return sources.map((source) => {
    const lineage = source.rolloutInfo?.lineage;
    assertCheckpointHistory(lineage);
    const isFork = lineage?.isInlineFork === true;
    if (isFork && !selectedParents.has(lineage.parentId)) {
      const candidates = bySession.get(lineage.parentId) ?? [];
      const heads = candidates.filter((candidate) => candidate.rolloutInfo.resolvedHead === true);
      // Ordering is dependency-first, not generation-first. An older source
      // can follow the resolved reset when it has a deeper logical ancestry.
      if (heads.length > 1 || (candidates.length > 1 && heads.length !== 1)) fail("source_lineage");
      selectedParents.set(lineage.parentId, (heads[0] ?? candidates[0])?.sourceKey ?? null);
    }
    const parentSourceKey = isFork ? selectedParents.get(lineage.parentId) : null;
    return { isFork, parentSourceKey, parentMissing: isFork && parentSourceKey === null };
  });
}

function assertReplayAncestry(sources) {
  const bySession = sourcesBySession(sources);
  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  if (byKey.size !== sources.length) fail("source_duplicate");
  const committedParents = new Map();
  for (const source of sources) {
    const lineage = source.rolloutInfo?.lineage;
    assertCheckpointHistory(lineage);
    const isFork = lineage?.isInlineFork === true;
    const candidates = isFork ? (bySession.get(lineage.parentId) ?? []) : [];
    const parentMissing = isFork && candidates.length === 0;
    if (source.isFork !== isFork || source.parentMissing !== parentMissing) fail("source_changed");
    if (!isFork || parentMissing) {
      if (source.parentSourceKey !== null) fail("source_changed");
      continue;
    }
    const parent = byKey.get(source.parentSourceKey);
    if (!parent || parent.rolloutInfo.lineage.sessionId !== lineage.parentId) fail("source_changed");
    const committed = committedParents.get(lineage.parentId);
    if (committed !== undefined && committed !== parent.sourceKey) fail("source_changed");
    committedParents.set(lineage.parentId, parent.sourceKey);
  }
  for (const source of sources) {
    const seen = new Set([source.sourceKey]);
    let cursor = source;
    let depth = 0;
    while (cursor.parentSourceKey !== null) {
      if (seen.has(cursor.parentSourceKey) || depth >= 1_000) fail("source_lineage");
      seen.add(cursor.parentSourceKey);
      cursor = byKey.get(cursor.parentSourceKey);
      if (!cursor) fail("source_lineage");
      depth += 1;
    }
  }
  return committedParents;
}

function withFrozenReplayHeadHints(plan) {
  // Parent edges are part of the frozen digest. A later selected-head hint
  // must not reinterpret those edges, and an ephemeral flag is not proof of
  // them. Project committed choices only after metadata/graph verification.
  const committedParents = assertReplayAncestry(plan.sources);
  return { ...plan, sources: plan.sources.map((source) => {
    const committed = committedParents.get(source.rolloutInfo.lineage.sessionId);
    return committed === undefined ? source : {
      ...source,
      rolloutInfo: { ...source.rolloutInfo, resolvedHead: committed === source.sourceKey },
    };
  }) };
}

function assertFrozenRolloutInfo(source, lineage) {
  const key = source.path.slice(Math.max(source.path.lastIndexOf("/"), source.path.lastIndexOf("\\")) + 1);
  const filename = parseCodexRolloutFilename(source.path);
  const info = source.rolloutInfo;
  if (!info || info.path !== source.path || info.size !== source.prefixBytes
      || info.rolloutKey !== key || source.sourceKey !== sourceKey(key)
      || info.sourceIdentity !== (filename?.rolloutId ?? key)
      || info.rolloutId !== (filename?.rolloutId ?? null)
      || stableJson(info.lineage) !== stableJson(lineage)) fail("source_changed");
}

async function verifyFrozenMetadata(source, handle, resourceGuard) {
  const lineage = await readRolloutLineage(
    isCompressedSource(source) ? compressedRolloutHandle(handle) : handle,
    { resourceGuard, maximumTotalBytes: Math.min(source.prefixBytes, 1024 * 1024) },
  );
  assertCheckpointHistory(lineage);
  assertFrozenRolloutInfo(source, lineage);
}

async function createCodexExportSourcePlan({
  codexHome,
  startAt,
  endAt,
  resourceGuard = null,
} = {}) {
  const infos = await discoverCodexRolloutInfos({ codexHome, startAt, endAt, resourceGuard });
  const discovery = codexRolloutDiscoveryReceipt(infos);
  if (discovery.status === "partial") {
    fail(Object.keys(discovery.reasonCounts).sort()[0]
      ?? "codex_rollout_generation_ambiguous");
  }
  for (const info of infos) assertCheckpointHistory(info.lineage);
  resourceGuard?.assertSourceSelection(
    infos.length,
    infos.reduce((sum, info) => sum + info.size, 0),
  );
  const sources = [];
  for (const [ordinal, info] of infos.entries()) {
    resourceGuard?.checkRuntime();
    const { handle, stats } = await openSource(info.path, info);
    try {
      const inspected = info.compressed
        ? await inspectCompressedSource(handle, resourceGuard)
        : null;
      if (inspected !== null && (stats.size !== info.physicalSize
          || inspected.size !== info.size || inspected.sha256 !== info.contentSha256)) fail("source_changed");
      if (inspected !== null && inspected.size > 0 && inspected.lastByte !== 0x0a) fail("codex_rollout_tail_incomplete");
      const prefixBytes = inspected?.size
        ?? await completeLinePrefixBytes(handle, stats.size, resourceGuard);
      const source = {
        ordinal,
        sourceKey: sourceKey(info.rolloutKey),
        path: info.path,
        dev: stats.dev,
        ino: stats.ino,
        birthtimeMs: Math.trunc(stats.birthtimeMs),
        prefixBytes,
        prefixSha256: inspected?.sha256 ?? await sha256Prefix(handle, prefixBytes, resourceGuard),
        rolloutInfo: { ...info, size: prefixBytes },
      };
      // Discovery metadata must still describe the exact opened prefix. A
      // frozen private bundle must not carry stale reset/inline semantics.
      await verifyFrozenMetadata(source, handle, resourceGuard);
      sources.push(source);
    } finally {
      await handle.close();
    }
  }
  const ancestry = replayAncestry(sources);
  for (const [index, source] of sources.entries()) Object.assign(source, ancestry[index]);
  assertReplayAncestry(sources);
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

async function verifyCodexExportSourcePlan(plan, { resourceGuard = null } = {}) {
  if (!plan || plan.schemaVersion !== EXPORT_SOURCE_PLAN_VERSION || !Array.isArray(plan.sources)) {
    fail("source_changed");
  }
  if (plan.sourcePlanSha256 !== planDigest(plan.sources)) fail("source_changed");
  for (const source of plan.sources) {
    resourceGuard?.checkRuntime();
    const { handle } = await openSource(source.path, source);
    try {
      await verifyFrozenMetadata(source, handle, resourceGuard);
      await verifyCodexExportSourceHandle(source, handle, { resourceGuard });
    } catch (error) {
      if (error instanceof ExportSourcePlanError || error instanceof ExportResourceLimitError
          || error?.name === "AbortError") throw error;
      fail("source_changed");
    } finally {
      await handle.close();
    }
  }
  assertReplayAncestry(plan.sources);
  return summarizeExportSourcePlan(plan);
}

async function openVerifiedCodexExportSource(source, { resourceGuard = null } = {}) {
  if (!source || typeof source.path !== "string" || !Number.isSafeInteger(source.prefixBytes)
      || source.prefixBytes < 0 || !validSha256(source.prefixSha256)) fail("source_changed");
  const { handle, stats } = await openSource(source.path, source);
  try {
    await verifyCodexExportSourceHandle(source, handle, { resourceGuard, stats });
    return isCompressedSource(source) ? compressedRolloutHandle(handle) : handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function verifyCodexExportSourceHandle(source, handle, {
  resourceGuard = null,
  stats: suppliedStats = null,
} = {}) {
  if (!source || !handle || !Number.isInteger(handle.fd)) fail("source_changed");
  const stats = suppliedStats ?? await handle.stat();
  assertSafeSourceStats(stats);
  if (isCompressedSource(source)) {
    if (!sameIdentity(stats, source)) fail("source_changed");
    const inspected = await inspectCompressedSource(handle, resourceGuard);
    if (inspected.size !== source.prefixBytes || inspected.sha256 !== source.prefixSha256
        || (inspected.size > 0 && inspected.lastByte !== 0x0a)) fail("source_changed");
    return;
  }
  if (!sameIdentity(stats, source) || stats.size < source.prefixBytes) fail("source_changed");
  if (source.prefixBytes > 0) {
    const tail = allocUnsafe(1);
    const { bytesRead } = await handle.read(tail, 0, 1, source.prefixBytes - 1);
    if (bytesRead !== 1 || tail[0] !== 0x0a) fail("source_prefix");
  }
  if (await sha256Prefix(handle, source.prefixBytes, resourceGuard) !== source.prefixSha256) {
    fail("source_changed");
  }
}

async function resolveCodexExportSourcePlan(plan, {
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
  const discovery = codexRolloutDiscoveryReceipt(infos);
  if (discovery.status === "partial") {
    fail(Object.keys(discovery.reasonCounts).sort()[0]
      ?? "codex_rollout_generation_ambiguous");
  }
  const current = new Map();
  for (const info of infos) {
    const key = sourceKey(info.rolloutKey);
    if (current.has(key)) fail("source_duplicate");
    current.set(key, info);
  }
  const resolved = plan.sources.map((source) => {
    const info = current.get(source.sourceKey);
    if (!info) fail("source_missing");
    if (source.rolloutInfo !== undefined
        && (stableJson(source.rolloutInfo?.lineage) !== stableJson(info.lineage)
          || source.rolloutInfo?.sourceIdentity !== info.sourceIdentity
          || source.rolloutInfo?.rolloutKey !== info.rolloutKey
          || source.rolloutInfo?.rolloutId !== info.rolloutId)) fail("source_changed");
    return {
      ...source,
      path: info.path,
      rolloutInfo: { ...info, size: source.prefixBytes },
    };
  });
  const result = { ...plan, sources: resolved };
  await verifyCodexExportSourcePlan(result, { resourceGuard });
  return withFrozenReplayHeadHints(result);
}

return Object.freeze({
  EXPORT_SOURCE_PLAN_VERSION,
  ExportSourcePlanError,
  createCodexExportSourcePlan,
  openVerifiedCodexExportSource,
  resolveCodexExportSourcePlan,
  summarizeExportSourcePlan,
  verifyCodexExportSourceHandle,
  verifyCodexExportSourcePlan,
});
}
