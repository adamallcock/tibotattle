import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readBoundedUtf8Lines } from "./bounded-jsonl.js";
import {
  calculateCost,
  compilePriceCatalog,
  resolvePriceCatalog,
} from "runcost";
import { normalizeProviderTier, subscriptionSpeedSensitivity, unknownCodexTier } from "./tier-semantics.js";
import { addOfficialOpenAiPriceSupplements } from "./openai-api-price-supplements.js";
import { CODEX_LOG_SCAN_VERSION } from "./export-versions.js";
import { classifySessionSurface } from "./surface-classification.js";

const COMPONENT_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const EXPORT_RELEVANT_LINE_NEEDLES = Object.freeze([
  '"session_meta"',
  '"turn_context"',
  '"thread_settings_applied"',
  '"token_count"',
  '"task_started"',
  '"task_complete"',
  "tool_call",
  '"function_call"',
  '"code_interpreter_call"',
  '"shell_call"',
  '"computer_call"',
  '"mcp_call"',
  '"apply_patch_call"',
  '"local_shell_call"',
]);

function boundedScannerLines(path, resourceGuard, maximumTotalBytes = Number.POSITIVE_INFINITY) {
  return readBoundedUtf8Lines(path, {
    maximumLineBytes: resourceGuard?.limits.maximumLineBytes,
    resourceGuard,
    oversizedIrrelevantNeedles: EXPORT_RELEVANT_LINE_NEEDLES,
    maximumTotalBytes,
  });
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {};
  for (const key of COMPONENT_KEYS) {
    const quantity = value[key] ?? 0;
    if (!Number.isFinite(quantity) || quantity < 0) return null;
    normalized[key] = quantity;
  }
  return normalized;
}

function tokenComponentPresence(value) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, Boolean(value && Object.hasOwn(value, key))]));
}

function deltaComponentPresence(current, previous) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [
    key,
    current[key] && (previous === null || previous[key]),
  ]));
}

function subtractUsage(current, previous) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, Math.max(0, current[key] - (previous?.[key] ?? 0))]));
}

function sameUsage(left, right) {
  return COMPONENT_KEYS.every((key) => left[key] === right[key]);
}

async function collectJsonlFileInfos(root, resourceGuard = null) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      return;
    }
    for await (const entry of entries) {
      resourceGuard?.observeDirectoryEntry();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const metadata = await stat(path);
        resourceGuard?.observeSourceFile(metadata.size);
        files.push({
          path,
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
          ino: metadata.ino,
          birthtimeMs: metadata.birthtimeMs,
        });
      }
    }
  }
  await walk(root);
  return files;
}

export async function readRolloutLineage(path, {
  resourceGuard = null,
  maximumTotalBytes = Number.POSITIVE_INFINITY,
} = {}) {
  for await (const line of boundedScannerLines(path, resourceGuard, maximumTotalBytes)) {
    if (line === null) continue;
    if (!line.includes('"session_meta"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== "session_meta" || !record.payload) continue;
      const sessionId = typeof record.payload.id === "string"
        ? record.payload.id
        : (typeof record.payload.session_id === "string" ? record.payload.session_id : null);
      const parentId = typeof record.payload.forked_from_id === "string"
        ? record.payload.forked_from_id
        : (typeof record.payload.parent_thread_id === "string" ? record.payload.parent_thread_id : null);
      const surfaceClassification = classifySessionSurface(record.payload);
      return { sessionId, parentId, isFork: parentId !== null, surfaceClassification };
    } catch {
      // A malformed metadata line is handled by the main parser diagnostics.
    }
  }
  return {
    sessionId: null,
    parentId: null,
    isFork: false,
    surfaceClassification: classifySessionSurface(null),
  };
}

export async function hasForkReplayPrefix(path) {
  return (await readRolloutLineage(path)).isFork;
}

function rolloutKey(path) {
  return path.slice(path.lastIndexOf("rollout-"));
}

async function mapWithConcurrency(values, concurrency, callback) {
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

export async function discoverCodexRolloutInfos({
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  startAt,
  endAt = null,
  resourceGuard = null,
}) {
  const cutoffMs = new Date(startAt).getTime();
  const endMs = endAt === null ? Number.POSITIVE_INFINITY : new Date(endAt).getTime();
  const [active, archived] = await Promise.all([
    collectJsonlFileInfos(join(codexHome, "sessions"), resourceGuard),
    collectJsonlFileInfos(join(codexHome, "archived_sessions"), resourceGuard),
  ]);
  const byName = new Map();
  for (const info of archived) byName.set(rolloutKey(info.path), { ...info, location: "archive" });
  for (const info of active) byName.set(rolloutKey(info.path), { ...info, location: "active" });
  const all = await mapWithConcurrency([...byName.entries()], 16, async ([key, info]) => ({
    ...info,
    rolloutKey: key,
    lineage: await readRolloutLineage(info.path, { resourceGuard }),
  }));
  const bySessionId = new Map();
  for (const info of all) {
    if (!info.lineage.sessionId) continue;
    const existing = bySessionId.get(info.lineage.sessionId);
    if (existing && existing.rolloutKey !== info.rolloutKey) {
      throw new Error("Ambiguous duplicate Codex session identity across distinct rollout files");
    }
    bySessionId.set(info.lineage.sessionId, info);
  }

  const selected = new Set(all.filter((info) => {
    const sourceStartMs = rolloutStartMs(info.rolloutKey);
    return info.mtimeMs >= cutoffMs && (!Number.isFinite(sourceStartMs) || sourceStartMs <= endMs);
  }));
  function includeAncestors(info, visiting = new Set()) {
    const parentId = info.lineage.parentId;
    if (!parentId || visiting.has(parentId)) return;
    const parent = bySessionId.get(parentId);
    if (!parent) return;
    selected.add(parent);
    visiting.add(parentId);
    includeAncestors(parent, visiting);
  }
  for (const info of [...selected]) includeAncestors(info);

  const depthMemo = new Map();
  function lineageDepth(info, visiting = new Set()) {
    if (depthMemo.has(info)) return depthMemo.get(info);
    const parentId = info.lineage.parentId;
    if (!parentId || visiting.has(parentId)) return 0;
    const parent = bySessionId.get(parentId);
    if (!parent || !selected.has(parent)) return 0;
    visiting.add(parentId);
    const depth = 1 + lineageDepth(parent, visiting);
    depthMemo.set(info, depth);
    return depth;
  }

  return [...selected].sort((left, right) => {
    const depthDifference = lineageDepth(left) - lineageDepth(right);
    return depthDifference || left.rolloutKey.localeCompare(right.rolloutKey);
  });
}

export async function discoverCodexRollouts(options) {
  return (await discoverCodexRolloutInfos(options)).map((info) => info.path);
}

function rolloutStartMs(rolloutKey) {
  const match = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(rolloutKey);
  return match ? Date.parse(`${match[1].replaceAll("-", (value, offset) => offset > 9 ? ":" : value)}Z`) : Number.NaN;
}

export function summarizeCodexRolloutSources(rolloutInfos, { endAt = null } = {}) {
  const endMs = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY;
  const relevantInfos = rolloutInfos.filter((info) => {
    const startMs = rolloutStartMs(info.rolloutKey);
    return !Number.isFinite(startMs) || startMs <= endMs;
  });
  const rows = relevantInfos.map((info) => ({
    keyHash: createHash("sha256").update(info.rolloutKey).digest("hex"),
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
    ino: info.ino,
    birthtimeMs: Math.trunc(info.birthtimeMs),
  }));
  return {
    schemaVersion: "codex-rollout-source-fingerprint-v1",
    fileCount: rows.length,
    totalSizeBytes: rows.reduce((sum, row) => sum + row.size, 0),
    maxMtimeMs: rows.reduce((maximum, row) => Math.max(maximum, row.mtimeMs), 0),
    fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    files: rows,
  };
}

export async function codexLogSourceFingerprint({ codexHome, startAt, endAt, includeSourcePaths = false }) {
  const rolloutInfos = await discoverCodexRolloutInfos({ codexHome, startAt });
  const summary = summarizeCodexRolloutSources(rolloutInfos, { endAt });
  if (includeSourcePaths) {
    const endMs = Date.parse(endAt);
    summary.sourcePathByKeyHash = Object.fromEntries(rolloutInfos
      .filter((info) => {
        const startMs = rolloutStartMs(info.rolloutKey);
        return !Number.isFinite(startMs) || startMs <= endMs;
      })
      .map((info) => [createHash("sha256").update(info.rolloutKey).digest("hex"), info.path]));
  }
  return summary;
}

export async function appendedRolloutSourcesAreAfterEnd({ cachedProvenance, currentProvenance, endAt }) {
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(endMs)) return false;
  const cachedFiles = new Map((cachedProvenance?.files ?? []).map((file) => [file.keyHash, file]));
  const currentFiles = new Map((currentProvenance?.files ?? []).map((file) => [file.keyHash, file]));
  const sourcePaths = currentProvenance?.sourcePathByKeyHash ?? {};
  if (cachedFiles.size !== currentFiles.size) return false;
  for (const [key, prior] of cachedFiles) {
    const next = currentFiles.get(key);
    if (!next || next.ino !== prior.ino || Math.trunc(next.birthtimeMs) !== Math.trunc(prior.birthtimeMs) || next.size < prior.size) return false;
    if (next.size === prior.size) {
      if (Math.trunc(next.mtimeMs) !== Math.trunc(prior.mtimeMs)) return false;
      continue;
    }
    const path = sourcePaths[key];
    if (typeof path !== "string") return false;
    if (prior.size > 0) {
      const boundary = createReadStream(path, { start: prior.size - 1, end: prior.size - 1, encoding: "utf8" });
      let lastCharacter = "";
      for await (const chunk of boundary) lastCharacter += chunk;
      if (lastCharacter !== "\n") return false;
    }
    const appended = createReadStream(path, { start: prior.size, end: next.size - 1, encoding: "utf8" });
    const lines = createInterface({ input: appended, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return false;
      }
      const timestampMs = Date.parse(record?.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= endMs) return false;
    }
  }
  return true;
}

export function createSnapshotLineage(parent = null) {
  const local = new Set();
  return {
    add(key) {
      local.add(key);
      return this;
    },
    has(key) {
      return local.has(key) || Boolean(parent?.has(key));
    },
    localSize() {
      return local.size;
    },
    parent,
  };
}

export function canonicalComponents(raw) {
  const cacheRead = Math.min(raw.cached_input_tokens, raw.input_tokens);
  const cacheWrite = Math.min(raw.cache_write_input_tokens, Math.max(0, raw.input_tokens - cacheRead));
  const reasoning = Math.min(raw.reasoning_output_tokens, raw.output_tokens);
  return {
    input_uncached_tokens: Math.max(0, raw.input_tokens - cacheRead - cacheWrite),
    input_cache_read_tokens: cacheRead,
    input_cache_write_tokens: cacheWrite,
    output_text_tokens: Math.max(0, raw.output_tokens - reasoning),
    output_reasoning_tokens: reasoning,
  };
}

export function canonicalComponentAvailability(presence, raw) {
  const inputConsistent = raw.cached_input_tokens + raw.cache_write_input_tokens <= raw.input_tokens;
  const outputConsistent = raw.reasoning_output_tokens <= raw.output_tokens;
  return {
    input_uncached_tokens: inputConsistent && presence.input_tokens && presence.cached_input_tokens && presence.cache_write_input_tokens,
    input_cache_read_tokens: inputConsistent && presence.input_tokens && presence.cached_input_tokens,
    input_cache_write_tokens: inputConsistent && presence.input_tokens && presence.cached_input_tokens && presence.cache_write_input_tokens,
    output_text_tokens: outputConsistent && presence.output_tokens && presence.reasoning_output_tokens,
    output_reasoning_tokens: outputConsistent && presence.output_tokens && presence.reasoning_output_tokens,
  };
}

function safeClassification(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,64}$/.test(value) ? value : "unknown";
}

export function canonicalRateLimitWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const limitId = safeClassification(rateLimits.limit_id);
  const planType = safeClassification(rateLimits.plan_type);
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const window = rateLimits[slot];
    if (!window || typeof window !== "object") continue;
    const usedPercent = Number(window.used_percent);
    const windowDurationMins = Number(window.window_minutes);
    const resetsAt = Number(window.resets_at);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    if (!Number.isInteger(windowDurationMins) || windowDurationMins <= 0) continue;
    if (!Number.isInteger(resetsAt) || resetsAt <= 0) continue;
    windows.push({
      provider: "openai_codex",
      planType,
      limitId,
      slot,
      usedPercent,
      windowDurationMins,
      resetsAt,
    });
  }
  return windows;
}

export function classifyToolCall(name, namespace = null) {
  if (typeof name !== "string") return "unknown";
  const bareName = name.toLowerCase();
  const value = `${typeof namespace === "string" ? `${namespace}.` : ""}${name}`.toLowerCase();
  if (value.includes("web") && (value.includes("search") || value.includes("run"))) return "web_search";
  if (value.includes("file_search")) return "file_search";
  if (value.includes("code_interpreter") || bareName === "python") return "code_interpreter";
  if (value.includes("spawn_agent") || value.includes("subagent") || value.includes("thread_spawn")) return "subagent";
  if (value.includes("wait_agent") || value.includes("send_message") || value.includes("followup_task") || value.includes("interrupt_agent") || value.includes("list_agents")) return "subagent";
  if (value.includes("mcp__") || value.includes("mcp_call")) return "mcp";
  if (value.includes("browser") || value.includes("chrome") || value.includes("computer_use") || value.includes("playwright")) return "computer_use";
  if (value.includes("apply_patch") || value.includes("file_write") || value.includes("file_edit")) return "apply_patch";
  if (value.includes("exec_command") || value.includes("write_stdin") || value.includes("shell") || value.includes("terminal")) return "local_shell";
  if (value === "exec" || value === "wait" || value.endsWith(".wait") || value.includes("request_user_input") || value === "functions.exec" || value.endsWith("__exec")) return "tool_gateway";
  return "other";
}

const SERVER_TOOL_TYPES = {
  web_search_call: { toolClass: "web_search", serverBillableUnit: "responses_web_search_call" },
  file_search_call: { toolClass: "file_search", serverBillableUnit: "responses_file_search_call" },
  code_interpreter_call: { toolClass: "code_interpreter", serverBillableUnit: null },
  shell_call: { toolClass: "hosted_shell", serverBillableUnit: null },
  computer_call: { toolClass: "computer_use", serverBillableUnit: null },
  mcp_call: { toolClass: "mcp", serverBillableUnit: null },
  apply_patch_call: { toolClass: "apply_patch", serverBillableUnit: null },
  local_shell_call: { toolClass: "local_shell", serverBillableUnit: null },
};

function nestedToolNames(input) {
  if (typeof input !== "string") return [];
  const names = [];
  const matcher = /\btools\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  for (let match = matcher.exec(input); match; match = matcher.exec(input)) names.push(match[1]);
  return names;
}

/**
 * Convert one response item to privacy-safe descriptors. Raw tool names and
 * inputs are inspected only in memory and are never returned.
 */
export function extractToolObservations(payload) {
  if (!payload || typeof payload !== "object") return [];
  const server = SERVER_TOOL_TYPES[payload.type];
  if (server) {
    return [{
      toolClass: server.toolClass,
      sourceKind: "responses_typed_output_item",
      serverBillableUnit: server.serverBillableUnit,
    }];
  }
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return [];
  if (payload.type === "custom_tool_call" && payload.name === "exec") {
    const nestedNames = nestedToolNames(payload.input);
    if (nestedNames.length > 0) {
      return nestedNames.map((name) => ({
        toolClass: classifyToolCall(name),
        sourceKind: "client_nested_tool_call",
        serverBillableUnit: null,
      }));
    }
    return [{ toolClass: "tool_gateway", sourceKind: "client_wrapper", serverBillableUnit: null }];
  }
  return [{
    toolClass: classifyToolCall(payload.name, payload.namespace),
    sourceKind: payload.type === "function_call" ? "client_function_call" : "client_custom_tool_call",
    serverBillableUnit: null,
  }];
}

function addComponents(target, source) {
  for (const [name, quantity] of Object.entries(source)) target[name] = (target[name] ?? 0) + quantity;
}

function addToolObservation(target, bySource, serverUnits, observation) {
  target[observation.toolClass] = (target[observation.toolClass] ?? 0) + 1;
  const sourceCounts = bySource[observation.sourceKind] ??= {};
  sourceCounts[observation.toolClass] = (sourceCounts[observation.toolClass] ?? 0) + 1;
  if (observation.serverBillableUnit) {
    serverUnits[observation.serverBillableUnit] = (serverUnits[observation.serverBillableUnit] ?? 0) + 1;
  }
}

function cumulativeSnapshotKey(total, last) {
  if (!total) return null;
  return [...COMPONENT_KEYS.map((key) => total[key]), ...(last ? COMPONENT_KEYS.map((key) => last[key]) : [])].join("|");
}

async function collectCumulativeSnapshotKeys(path, target, resourceGuard = null, maximumTotalBytes = Number.POSITIVE_INFINITY) {
  for await (const line of boundedScannerLines(path, resourceGuard, maximumTotalBytes)) {
    if (line === null) continue;
    if (!line.includes('"token_count"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
      const total = normalizeTokenUsage(record.payload?.info?.total_token_usage);
      const last = normalizeTokenUsage(record.payload?.info?.last_token_usage);
      const key = cumulativeSnapshotKey(total, last);
      if (key) target.add(key);
    } catch {
      // Excluded rollouts support in-memory lineage only; their parse errors are not emitted.
    }
  }
}

async function collectTierTimeline(path, diagnostics, resourceGuard = null, maximumTotalBytes = Number.POSITIVE_INFINITY) {
  const timeline = [];
  let ordinal = 0;
  for await (const line of boundedScannerLines(path, resourceGuard, maximumTotalBytes)) {
    if (line === null) continue;
    ordinal += 1;
    if (!line.includes('"thread_settings_applied"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "thread_settings_applied") continue;
    const timestampMs = Date.parse(record.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    const rawTier = record.payload?.thread_settings?.service_tier;
    if (rawTier !== null && typeof rawTier !== "string") {
      diagnostics.malformedTierSettingEvents += 1;
      continue;
    }
    const normalized = normalizeProviderTier(rawTier, {
      billingSurface: "chatgpt_subscription",
      tierSource: "rollout_thread_settings",
      tierObservedAt: record.timestamp,
    });
    diagnostics.tierSettingEvents += 1;
    diagnostics.tierSettingCounts[normalized.codexSpeedMode] = (diagnostics.tierSettingCounts[normalized.codexSpeedMode] ?? 0) + 1;
    timeline.push({ ordinal, rawTier, timestamp: record.timestamp, timestampMs });
  }
  return timeline.sort((left, right) => left.timestampMs - right.timestampMs || left.ordinal - right.ordinal);
}

function tierAt(timeline, timestampMs) {
  let lower = 0;
  let upper = timeline.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (timeline[middle].timestampMs <= timestampMs) lower = middle + 1;
    else upper = middle;
  }
  return lower === 0 ? null : timeline[lower - 1];
}

async function parseRollout(path, {
  forked,
  inheritedSnapshots,
  rolloutSnapshots,
  startMs,
  endMs,
  seenEvents,
  seenToolCalls,
  onUsage,
  onRateLimitSnapshot,
  onToolCall,
  sourceRolloutOrdinal,
  diagnostics,
  toolCallsByClass,
  toolObservationsBySource,
  serverBillableUnits,
  surfaceClassification,
  sourceScopeId,
  sourceDedupeScope,
  resourceGuard,
  maximumTotalBytes = Number.POSITIVE_INFINITY,
}) {
  const tierTimeline = await collectTierTimeline(path, diagnostics, resourceGuard, maximumTotalBytes);
  let currentModel = null;
  let previousTotals = null;
  let previousTotalsPresence = null;
  const openTaskIds = new Set();
  let sourceRecordOrdinal = 0;

  for await (const line of boundedScannerLines(path, resourceGuard, maximumTotalBytes)) {
    sourceRecordOrdinal += 1;
    if (line === null) continue;
    if (!line.includes('"turn_context"')
        && !line.includes('"thread_settings_applied"')
        && !line.includes('"token_count"')
        && !line.includes('"task_started"')
        && !line.includes('"task_complete"')
        && !line.includes("tool_call")
        && !line.includes('"function_call"')
        && !line.includes('"code_interpreter_call"')
        && !line.includes('"shell_call"')
        && !line.includes('"computer_call"')
        && !line.includes('"mcp_call"')
        && !line.includes('"apply_patch_call"')
        && !line.includes('"local_shell_call"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      diagnostics.malformedLines += 1;
      continue;
    }
    const timestampMs = Date.parse(record.timestamp);
    if (!Number.isFinite(timestampMs)) {
      diagnostics.malformedTimestamps += 1;
      continue;
    }

    if (record.type === "turn_context") {
      if (typeof record.payload?.model === "string") currentModel = record.payload.model;
      continue;
    }

    if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
      continue;
    }

    if (record.type === "event_msg" && (record.payload?.type === "task_started" || record.payload?.type === "task_complete")) {
      if (timestampMs > endMs) continue;
      const turnId = record.payload?.turn_id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        diagnostics.malformedTaskEvents += 1;
      } else if (record.payload.type === "task_started") {
        openTaskIds.add(turnId);
      } else {
        openTaskIds.delete(turnId);
      }
      continue;
    }

    if (record.type === "response_item") {
      const observations = extractToolObservations(record.payload);
      if (observations.length > 0) {
        if (timestampMs < startMs || timestampMs > endMs) continue;
        const stableId = record.payload?.call_id ?? record.payload?.id;
        const toolKey = [sourceDedupeScope, sourceRecordOrdinal, stableId ?? "no-provider-id", record.payload?.type].join("|");
        if (seenToolCalls.has(toolKey)) {
          diagnostics.replayedToolCallsSkipped += 1;
          continue;
        }
        seenToolCalls.add(toolKey);
        for (const observation of observations) {
          addToolObservation(toolCallsByClass, toolObservationsBySource, serverBillableUnits, observation);
          await onToolCall?.({
            timestamp: record.timestamp,
            timestampMs,
            surfaceClassification,
            ...(sourceScopeId ? { sourceScopeId } : {}),
            sourceRecordOrdinal,
            ...observation,
          });
        }
      }
      continue;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;

    const info = record.payload?.info;
    const totalPresence = tokenComponentPresence(info?.total_token_usage);
    const lastPresence = tokenComponentPresence(info?.last_token_usage);
    const total = normalizeTokenUsage(info?.total_token_usage);
    const last = normalizeTokenUsage(info?.last_token_usage);
    if ((info?.total_token_usage && !total) || (info?.last_token_usage && !last)) {
      diagnostics.malformedUsageRecords += 1;
    }
    const cumulativeKey = cumulativeSnapshotKey(total, last);
    if (cumulativeKey) rolloutSnapshots.add(cumulativeKey);
    if (forked && cumulativeKey && inheritedSnapshots.has(cumulativeKey)) {
      if (total) {
        previousTotals = total;
        previousTotalsPresence = totalPresence;
      }
      if (timestampMs >= startMs && timestampMs <= endMs) diagnostics.forkReplayEventsSkipped += 1;
      continue;
    }
    if (timestampMs < startMs || timestampMs > endMs) {
      if (total) {
        previousTotals = total;
        previousTotalsPresence = totalPresence;
      }
      continue;
    }
    if (forked && currentModel === null) {
      if (total) {
        previousTotals = total;
        previousTotalsPresence = totalPresence;
      }
      diagnostics.unattributedForkReplayEventsSkipped += 1;
      continue;
    }
    const rateLimitWindows = canonicalRateLimitWindows(record.payload?.rate_limits);
    if (record.payload?.rate_limits === null || record.payload?.rate_limits === undefined) {
      diagnostics.missingRateLimitRecords += 1;
    } else if (rateLimitWindows.length === 0) {
      diagnostics.malformedRateLimitRecords += 1;
    }
    for (const window of rateLimitWindows) {
      await onRateLimitSnapshot?.({
        timestamp: record.timestamp,
        timestampMs,
        window,
        surfaceClassification,
        ...(sourceScopeId ? { sourceScopeId } : {}),
        sourceRecordOrdinal,
      });
      diagnostics.rateLimitSnapshots += 1;
    }
    let usage = null;
    let usagePresence = null;
    if (total) {
      const delta = subtractUsage(total, previousTotals);
      const deltaPresence = deltaComponentPresence(totalPresence, previousTotalsPresence);
      const firstCumulativeRecord = previousTotals === null;
      previousTotals = total;
      previousTotalsPresence = totalPresence;
      if (firstCumulativeRecord) {
        usage = last ?? delta;
        usagePresence = last ? lastPresence : deltaPresence;
      } else if (delta.total_tokens > 0) {
        if (last && sameUsage(last, delta)) {
          usage = last;
          usagePresence = lastPresence;
        }
        else {
          usage = delta;
          usagePresence = deltaPresence;
          if (last) diagnostics.lastVsCumulativeMismatches += 1;
        }
      } else if (last && last.total_tokens > 0) {
        diagnostics.duplicateSnapshotsSkipped += 1;
      }
    } else {
      usage = last;
      usagePresence = lastPresence;
      diagnostics.lastOnlyEvents += 1;
    }
    if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) continue;

    const model = record.payload?.model ?? info?.model ?? currentModel ?? "unknown";
    const eventKey = [sourceDedupeScope, sourceRecordOrdinal, "token_count"].join("|");
    if (seenEvents.has(eventKey)) {
      diagnostics.replayedEventsSkipped += 1;
      continue;
    }
    seenEvents.add(eventKey);
    const effectiveTier = tierAt(tierTimeline, timestampMs);
    await onUsage({
      timestamp: record.timestamp,
      model,
      raw: usage,
      rawAvailability: usagePresence,
      components: canonicalComponents(usage),
      componentAvailability: canonicalComponentAvailability(usagePresence, usage),
      tierSemantics: normalizeProviderTier(effectiveTier?.rawTier ?? null, {
        billingSurface: "chatgpt_subscription",
        tierSource: effectiveTier ? "rollout_thread_settings" : "unobserved",
        tierObservedAt: effectiveTier?.timestamp ?? null,
      }),
      surfaceClassification,
      sourceRolloutOrdinal,
      ...(sourceScopeId ? { sourceScopeId } : {}),
      sourceRecordOrdinal,
    });
  }
  return { openTasksAtEnd: openTaskIds.size };
}

export async function scanCodexLogEvents({
  startAt,
  endAt,
  codexHome,
  onUsage = () => {},
  onRateLimitSnapshot,
  onToolCall,
  excludeSessionIds = [],
  activeTaskRecencyMs = null,
  sourceScopeForRollout = null,
  resourceGuard = null,
  rolloutInfos: suppliedRolloutInfos = null,
  openRolloutSource = null,
  verifyRolloutSource = null,
}) {
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error("startAt and endAt must define a valid chronological interval");
  }
  const activeRecencyMs = Number.isFinite(activeTaskRecencyMs) && activeTaskRecencyMs >= 0
    ? activeTaskRecencyMs
    : endMs - startMs;
  const activeCutoffMs = endMs - activeRecencyMs;
  if (suppliedRolloutInfos !== null && !Array.isArray(suppliedRolloutInfos)) {
    throw new TypeError("rolloutInfos must be an array or null");
  }
  const rolloutInfos = suppliedRolloutInfos ?? await discoverCodexRolloutInfos({
      codexHome,
      startAt: new Date(Math.min(startMs, activeCutoffMs)).toISOString(),
      endAt,
      resourceGuard,
    });
  const excludedSessions = new Set(excludeSessionIds.filter((value) => typeof value === "string" && value.length > 0));
  const seenEvents = new Set();
  const seenToolCalls = new Set();
  const diagnostics = {
    filesScanned: rolloutInfos.length,
    lineageParentsMissing: 0,
    malformedLines: 0,
    malformedTimestamps: 0,
    malformedUsageRecords: 0,
    missingRateLimitRecords: 0,
    malformedRateLimitRecords: 0,
    rateLimitSnapshots: 0,
    lastVsCumulativeMismatches: 0,
    duplicateSnapshotsSkipped: 0,
    replayedEventsSkipped: 0,
    forkReplayEventsSkipped: 0,
    unattributedForkReplayEventsSkipped: 0,
    replayedToolCallsSkipped: 0,
    lastOnlyEvents: 0,
    excludedRollouts: 0,
    malformedTaskEvents: 0,
    activeTaskRolloutsAtEnd: 0,
    tierSettingEvents: 0,
    malformedTierSettingEvents: 0,
    tierSettingCounts: {},
    rolloutsBySurface: {},
    rolloutsByThreadSource: {},
    rolloutsByAgentScope: {},
  };
  const toolCallsByClass = {};
  const toolObservationsBySource = {};
  const serverBillableUnits = {};
  const snapshotsBySession = new Map();
  diagnostics.sourceProvenance = summarizeCodexRolloutSources(rolloutInfos, { endAt });
  for (let sourceRolloutOrdinal = 0; sourceRolloutOrdinal < rolloutInfos.length; sourceRolloutOrdinal += 1) {
    const info = rolloutInfos[sourceRolloutOrdinal];
    const openedSource = typeof openRolloutSource === "function" ? await openRolloutSource(info) : null;
    const sourceInput = openedSource ?? info.path;
    try {
    const classification = info.lineage.surfaceClassification ?? classifySessionSurface(null);
    diagnostics.rolloutsBySurface[classification.surface] = (diagnostics.rolloutsBySurface[classification.surface] ?? 0) + 1;
    diagnostics.rolloutsByThreadSource[classification.threadSource] = (diagnostics.rolloutsByThreadSource[classification.threadSource] ?? 0) + 1;
    diagnostics.rolloutsByAgentScope[classification.agentScope] = (diagnostics.rolloutsByAgentScope[classification.agentScope] ?? 0) + 1;
    if (info.lineage.sessionId && excludedSessions.has(info.lineage.sessionId)) {
      const inheritedSnapshots = info.lineage.parentId
        ? snapshotsBySession.get(info.lineage.parentId)
        : null;
      const rolloutSnapshots = createSnapshotLineage(inheritedSnapshots ?? null);
      await collectCumulativeSnapshotKeys(sourceInput, rolloutSnapshots, resourceGuard, info.size);
      snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
      diagnostics.excludedRollouts += 1;
      continue;
    }
    const inheritedSnapshots = info.lineage.parentId
      ? snapshotsBySession.get(info.lineage.parentId)
      : null;
    if (info.lineage.isFork && !inheritedSnapshots) diagnostics.lineageParentsMissing += 1;
    const rolloutSnapshots = createSnapshotLineage(inheritedSnapshots ?? null);
    const sourceScopeId = typeof sourceScopeForRollout === "function"
      ? sourceScopeForRollout(info.lineage.sessionId ?? info.rolloutKey)
      : null;
    const sourceDedupeScope = info.lineage.sessionId ?? info.rolloutKey;
    if (sourceScopeId !== null && (typeof sourceScopeId !== "string" || !/^[a-z][a-z0-9-]*:v1:[A-Za-z0-9_-]{43}$/.test(sourceScopeId))) {
      throw new Error("sourceScopeForRollout must return a versioned privacy-safe pseudonym or null");
    }
    const parsed = await parseRollout(sourceInput, {
      forked: info.lineage.isFork,
      inheritedSnapshots: inheritedSnapshots ?? createSnapshotLineage(),
      rolloutSnapshots,
      startMs,
      endMs,
      seenEvents,
      seenToolCalls,
      onUsage,
      onRateLimitSnapshot,
      onToolCall,
      sourceRolloutOrdinal,
      diagnostics,
      toolCallsByClass,
      toolObservationsBySource,
      serverBillableUnits,
      surfaceClassification: classification,
      sourceScopeId,
      sourceDedupeScope,
      resourceGuard,
      maximumTotalBytes: info.size,
    });
    if (parsed.openTasksAtEnd > 0 && info.mtimeMs >= activeCutoffMs) diagnostics.activeTaskRolloutsAtEnd += 1;
    if (info.lineage.sessionId) snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
    } finally {
      try {
        if (openedSource && typeof verifyRolloutSource === "function") {
          await verifyRolloutSource(info, openedSource);
        }
      } finally {
        await openedSource?.close?.().catch(() => {});
      }
    }
  }
  return {
    parserVersion: CODEX_LOG_SCAN_VERSION,
    diagnostics,
    toolCallsByClass,
    toolObservationsBySource,
    serverBillableUnits,
  };
}

export async function scanAndPriceCodexLogs({
  startAt,
  endAt,
  offline = false,
  codexHome,
  priceCards = null,
  excludeSessionIds = [],
}) {
  const baseResolution = await (priceCards
      ? Promise.resolve({
          selected_source: "provided",
          price_cards: priceCards,
          sources: [{ name: "provided", status: "selected", card_count: priceCards.length, selected: true }],
          warnings: [],
        })
      : resolvePriceCatalog({ provider: "openai", offline }));
  const resolution = priceCards ? baseResolution : addOfficialOpenAiPriceSupplements(baseResolution);
  const catalog = compilePriceCatalog(resolution.price_cards);
  const totals = {};
  const byModel = {};
  const bySurface = {};
  const byDay = {};
  const usageBearingRollouts = new Set();
  const warningCounts = {};
  const tierUsageEventCounts = {};
  let totalUsd = 0;
  let eventCount = 0;
  const pricingDiagnostics = { pricedEvents: 0, partiallyPricedEvents: 0, longContextEvents: 0 };

  function onUsage(event) {
    eventCount += 1;
    usageBearingRollouts.add(event.sourceRolloutOrdinal);
    if (event.raw.input_tokens >= 272_000) pricingDiagnostics.longContextEvents += 1;
    addComponents(totals, event.components);
    const modelSummary = byModel[event.model] ??= { components: {}, costUsd: 0, events: 0, warningCounts: {} };
    addComponents(modelSummary.components, event.components);
    modelSummary.events += 1;

    const usageLedger = {
      schema_version: "0.1",
      provider: "openai",
      surface: "openai.responses",
      model: { requested: event.model },
      context: {
        total_input_tokens: event.raw.input_tokens,
        priced_at: event.timestamp,
        service_tier: "standard",
      },
      components: Object.entries(event.components).filter(([, quantity]) => quantity > 0).map(([name, quantity]) => ({
        name,
        quantity: String(quantity),
        unit: "token",
      })),
    };
    const ledger = calculateCost({ usageLedger, priceCards: catalog, mode: "compatibility" });
    const cost = Number(ledger.total);
    totalUsd += cost;
    modelSummary.costUsd += cost;
    const speedMode = event.tierSemantics?.codexSpeedMode ?? "unknown";
    tierUsageEventCounts[speedMode] = (tierUsageEventCounts[speedMode] ?? 0) + 1;
    if (ledger.warnings.length === 0) pricingDiagnostics.pricedEvents += 1;
    else pricingDiagnostics.partiallyPricedEvents += 1;
    for (const warning of ledger.warnings) {
      warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + 1;
      modelSummary.warningCounts[warning.code] = (modelSummary.warningCounts[warning.code] ?? 0) + 1;
    }

    const surface = event.surfaceClassification?.surface ?? "local_rollout_unclassified";
    const eventTokens = Object.values(event.components).reduce((sum, value) => sum + value, 0);
    const surfaceSummary = bySurface[surface] ??= { events: 0, totalUsd: 0, totalTokens: 0, components: {}, byModel: {}, speedModeCounts: {} };
    surfaceSummary.events += 1;
    surfaceSummary.totalUsd += cost;
    surfaceSummary.totalTokens += eventTokens;
    addComponents(surfaceSummary.components, event.components);
    surfaceSummary.byModel[event.model] = (surfaceSummary.byModel[event.model] ?? 0) + cost;
    surfaceSummary.speedModeCounts[speedMode] = (surfaceSummary.speedModeCounts[speedMode] ?? 0) + 1;

    const date = event.timestamp.slice(0, 10);
    const day = byDay[date] ??= {
      date,
      events: 0,
      totalUsd: 0,
      totalTokens: 0,
      components: {},
      byModel: {},
      speedModeCounts: {},
      bySurface: {},
    };
    day.events += 1;
    day.totalUsd += cost;
    day.totalTokens += eventTokens;
    addComponents(day.components, event.components);
    const dayModel = day.byModel[event.model] ??= { events: 0, totalTokens: 0, costUsd: 0 };
    dayModel.events += 1;
    dayModel.totalTokens += eventTokens;
    dayModel.costUsd += cost;
    day.speedModeCounts[speedMode] = (day.speedModeCounts[speedMode] ?? 0) + 1;
    const daySurface = day.bySurface[surface] ??= { events: 0, totalUsd: 0, totalTokens: 0 };
    daySurface.events += 1;
    daySurface.totalUsd += cost;
    daySurface.totalTokens += Object.values(event.components).reduce((sum, value) => sum + value, 0);
  }

  const scanned = await scanCodexLogEvents({ startAt, endAt, codexHome, onUsage, excludeSessionIds });
  const diagnostics = {
    ...scanned.diagnostics,
    ...pricingDiagnostics,
    usageBearingRollouts: usageBearingRollouts.size,
    concurrentLocalUsageDetected: usageBearingRollouts.size > 1,
  };

  return {
    startAt,
    endAt,
    eventCount,
    components: totals,
    totalTokens: (totals.input_uncached_tokens ?? 0)
      + (totals.input_cache_read_tokens ?? 0)
      + (totals.input_cache_write_tokens ?? 0)
      + (totals.output_text_tokens ?? 0)
      + (totals.output_reasoning_tokens ?? 0),
    bySurface,
    daily: Object.values(byDay).sort((left, right) => left.date.localeCompare(right.date)),
    runcost: {
      totalUsd,
      byModel,
      warningCounts,
      tierSemantics: unknownCodexTier(),
      observedTierUsageEventCounts: tierUsageEventCounts,
      subscriptionSpeedSensitivity: subscriptionSpeedSensitivity(byModel),
      priceResolution: {
        selectedSource: resolution.selected_source,
        sources: resolution.sources.map((source) => ({
          name: source.name,
          status: source.status,
          url: source.url ?? source.resolved_url ?? null,
          retrievedAt: source.retrieved_at ?? null,
          cardCount: source.card_count,
          selected: source.selected ?? false,
        })),
        warnings: resolution.warnings.map((warning) => warning.code),
        serviceTier: {
          observed: null,
          apiPriceAssumption: "standard",
          reason: "Codex token_count logs do not expose an API service tier; standard is an explicit counterfactual pricing assumption.",
        },
      },
    },
    toolCalls: scanned.toolCallsByClass,
    toolCallsByClass: scanned.toolCallsByClass,
    toolObservationsBySource: scanned.toolObservationsBySource,
    serverBillableUnits: scanned.serverBillableUnits,
    diagnostics,
    sourceProvenance: scanned.diagnostics.sourceProvenance,
    assumptions: [
      "input_tokens includes cache-read and cache-write input; uncached input is the remainder",
      "output_tokens includes reasoning output; reasoning is separated before RunCost pricing",
      "forked-session history is excluded by matching cumulative token snapshots against chronologically earlier rollouts; unlabeled fork records are treated as replay",
      "token usage can be attributed to a model but not reliably to an individual user turn or tool",
      "tool calls are retained only as aggregate client-side classes and are not priced without a matching provider-billed unit",
      "Codex token_count logs do not expose API service tier; standard service-tier prices are used only as an explicit API-price-equivalent assumption",
      "Codex Fast is tracked separately from API Priority/Flex/Batch; unknown speed emits sensitivity scenarios and selects neither",
    ],
  };
}
