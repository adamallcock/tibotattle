import { ExportResourceLimitError, stableJson } from "../../export/index.js";
import { safeCount, validSha256 } from "./source-validation.js";
import { parseClaudeTranscriptRecord } from "./claude-transcript-record.js";
import {
  normalizeClaudeConfiguredPath,
  resolveClaudeConfigRoot,
} from "./claude-config-root.js";

export function createClaudeTranscriptExportContext(configuration) {
const {
  allocUnsafe,
  bufferByteLength,
  bufferFrom,
  bufferIsBuffer,
  claudeConfigDirectory,
  createHash,
  createHmac,
  currentUid,
  deriveSessionScopeId,
  defaultHomeDirectory,
  fsConstants: constants,
  joinPath: join,
  lstat,
  open,
  openDirectory: opendir,
  platform,
  userProfile,
  readBoundedUtf8LineEntries,
  realpath,
  resolvePath: resolve,
  safeExportModelDeclaration,
} = configuration;

const CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION = "claude-transcript-export-source-plan-v0.2";
const CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION = "claude-transcript-export-cursor-v0.2";
const CLAUDE_TRANSCRIPT_USAGE_CANDIDATE_VERSION = "claude-transcript-usage-candidate-v0.2";
const CLAUDE_TRANSCRIPT_PLAN_CHECKPOINT_VERSION = "claude-transcript-plan-checkpoint-v0.1";

// Windows file IDs are 64-bit values.  Node's ordinary Stats projection can
// round those values when it exposes them as Numbers, so use the bigint
// projection at every identity boundary on Windows.  O_NOFOLLOW is a POSIX
// flag and is not a portable Windows open flag; Windows relies on the
// descriptor/path identity checks below instead.
const NOFOLLOW = platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_STAT_IDENTITY_BIGINT = (1n << 64n) - 1n;
const DECIMAL_IDENTITY_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const MAXIMUM_SESSION_ID_BYTES = 4096;
const SAFE_CODES = new Set([
  "configuration", "root_unsafe", "source_unsafe", "source_changed", "source_prefix",
  "source_bound", "plan_invalid", "cursor_invalid", "record_invalid",
]);

class ClaudeTranscriptExportSourceError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown Claude transcript source failure code");
    super(`Claude transcript export source failed (${code})`);
    this.name = "ClaudeTranscriptExportSourceError";
    this.code = `claude_transcript_export_${code}`;
  }
}

function fail(code) {
  throw new ClaudeTranscriptExportSourceError(code);
}

function normalizeStatCount(value, code = "source_changed") {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) fail(code);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function normalizeStatMilliseconds(value, code = "source_changed") {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) fail(code);
    return Number(value);
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) fail(code);
  return Math.trunc(value);
}

function normalizeStatIdentity(value, code = "source_changed") {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_STAT_IDENTITY_BIGINT) fail(code);
    return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : value.toString(10);
  }
  // An unsafe Number has already lost bits and cannot be safely serialized or
  // compared.  Callers must request the bigint Stats projection instead.
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function canonicalStatIdentity(value) {
  if (typeof value === "bigint") {
    return value >= 0n && value <= MAX_STAT_IDENTITY_BIGINT ? value.toString(10) : null;
  }
  if (Number.isSafeInteger(value) && value >= 0
      && BigInt(value) <= MAX_STAT_IDENTITY_BIGINT) return String(value);
  if (typeof value === "string" && DECIMAL_IDENTITY_PATTERN.test(value)) {
    try {
      const parsed = BigInt(value);
      return parsed <= MAX_STAT_IDENTITY_BIGINT ? parsed.toString(10) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function validStatIdentity(value) {
  return canonicalStatIdentity(value) !== null;
}

function normalizeStats(stats, code = "source_changed") {
  if (!stats || typeof stats !== "object"
      || typeof stats.isDirectory !== "function"
      || typeof stats.isFile !== "function"
      || typeof stats.isSymbolicLink !== "function") {
    fail(code);
  }
  return {
    dev: normalizeStatIdentity(stats.dev, code),
    ino: normalizeStatIdentity(stats.ino, code),
    birthtimeMs: normalizeStatMilliseconds(stats.birthtimeMs, code),
    size: normalizeStatCount(stats.size, code),
    mode: normalizeStatCount(stats.mode, code),
    uid: normalizeStatCount(stats.uid, code),
    nlink: normalizeStatCount(stats.nlink, code),
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

async function statPath(path, code = "source_changed") {
  const stats = platform === "win32"
    ? await lstat(path, { bigint: true })
    : await lstat(path);
  return normalizeStats(stats, code);
}

async function statHandle(handle, code = "source_changed") {
  const stats = platform === "win32"
    ? await handle.stat({ bigint: true })
    : await handle.stat();
  return normalizeStats(stats, code);
}

function canonicalIso(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? canonical : null;
}

function normalizeBounds(startAt, endAt) {
  let start;
  let end;
  try {
    start = canonicalIso(new Date(startAt).toISOString());
    end = canonicalIso(new Date(endAt).toISOString());
  } catch {
    fail("configuration");
  }
  if (!start || !end || Date.parse(end) < Date.parse(start)) fail("configuration");
  return { startAt: start, endAt: end, startMs: Date.parse(start), endMs: Date.parse(end) };
}

function normalizeSecret(secret) {
  if (!bufferIsBuffer(secret) && !(secret instanceof Uint8Array)) fail("configuration");
  const copy = bufferFrom(secret);
  if (copy.byteLength !== 32) fail("configuration");
  return copy;
}

function defaultClaudeProjectsDirectory(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Claude transcript configuration is invalid");
  }
  const homeDirectory = Object.hasOwn(options, "homeDirectory")
    && options.homeDirectory === null
    ? null
    : options.homeDirectory ?? defaultHomeDirectory;
  const environment = options.environment;
  const selectedUserProfile = Object.hasOwn(options, "userProfile")
    ? options.userProfile
    : environment === undefined ? userProfile : undefined;
  const configDirectory = Object.hasOwn(options, "configDirectory")
    ? options.configDirectory
    : environment === undefined ? claudeConfigDirectory : undefined;
  return resolveClaudeConfigRoot({
    platform,
    homeDirectory,
    userProfile: selectedUserProfile,
    claudeConfigDirectory: configDirectory,
    environment,
    joinPath: join,
    resolvePath: resolve,
  }).projectsDirectory;
}

function normalizeConfiguredPath(path) {
  try {
    return normalizeClaudeConfiguredPath(path, { platform, resolvePath: resolve });
  } catch (error) {
    if (error?.code?.startsWith("claude_config_root_")) fail("configuration");
    throw error;
  }
}

function pathWithinRoot(root, path) {
  const comparisonRoot = platform === "win32" ? root.toLowerCase() : root;
  const comparisonPath = platform === "win32" ? path.toLowerCase() : path;
  const prefix = `${comparisonRoot}${platform === "win32" ? "\\" : "/"}`;
  return comparisonPath === comparisonRoot || comparisonPath.startsWith(prefix);
}

function assertSafeDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (currentUid() !== null && stats.uid !== currentUid())
      || (platform !== "win32" && (stats.mode & 0o022) !== 0)) fail("root_unsafe");
}

function assertSafeFile(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (currentUid() !== null && stats.uid !== currentUid())
      || (platform !== "win32" && (stats.mode & 0o022) !== 0)) fail("source_unsafe");
}

function sameIdentity(stats, source) {
  return canonicalStatIdentity(stats.dev) === canonicalStatIdentity(source.device)
    && canonicalStatIdentity(stats.ino) === canonicalStatIdentity(source.inode)
    && Math.trunc(stats.birthtimeMs) === source.birthtimeMs;
}

async function openSafeFile(path, expected = null) {
  let before;
  let handle;
  try {
    before = await statPath(path);
    assertSafeFile(before);
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await statHandle(handle);
    assertSafeFile(opened);
    if (!sameIdentity(opened, {
      device: before.dev,
      inode: before.ino,
      birthtimeMs: before.birthtimeMs,
    })
        || (expected && !sameIdentity(opened, expected))) fail("source_changed");
    return { handle, stats: opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof ClaudeTranscriptExportSourceError || error instanceof ExportResourceLimitError) throw error;
    fail("source_changed");
  }
}

async function completeLinePrefixBytes(handle, size, maximumLineBytes, resourceGuard) {
  if (!safeCount(size) || !Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) fail("source_bound");
  let scanned = 0;
  for (let end = size; end > 0;) {
    resourceGuard.checkRuntime();
    const remaining = maximumLineBytes + 1 - scanned;
    if (remaining <= 0) throw new ExportResourceLimitError("line_bytes");
    const start = Math.max(0, end - Math.min(256 * 1024, remaining));
    const buffer = allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) fail("source_changed");
    scanned += bytesRead;
    const newline = buffer.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function hashPrefix(handle, bytes, resourceGuard) {
  const digest = createHash("sha256");
  const buffer = allocUnsafe(256 * 1024);
  for (let offset = 0; offset < bytes;) {
    resourceGuard.checkRuntime();
    const length = Math.min(buffer.length, bytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest("hex");
}

function sourceKey(secret, path, stats) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-transcript-source/v1\0", "utf8")
    .update(stableJson({ path, device: stats.dev, inode: stats.ino, birthtimeMs: Math.trunc(stats.birthtimeMs) }))
    .digest("hex");
}

function publicPlanRows(sources) {
  return sources.map(({
    ordinal, sourceKey: key, device, inode, birthtimeMs, prefixBytes, prefixLineCount, prefixSha256,
    selectedMessages, selectionSha256,
  }) => ({
    ordinal, sourceKey: key, device, inode, birthtimeMs, prefixBytes, prefixLineCount, prefixSha256,
    selectedMessages, selectionSha256,
  }));
}

function planDigest(sources) {
  return createHash("sha256")
    .update("app-usagemonitor/claude-transcript-plan/v1\0", "utf8")
    .update(stableJson(publicPlanRows(sources)))
    .digest("hex");
}

async function verifyRootDirectory(rootDirectory) {
  try {
    const root = resolve(normalizeConfiguredPath(rootDirectory));
    const stats = await statPath(root, "root_unsafe");
    assertSafeDirectory(stats);
    return await realpath(root);
  } catch (error) {
    if (error instanceof ClaudeTranscriptExportSourceError) throw error;
    fail("root_unsafe");
  }
}

async function discoverJsonl(root, resourceGuard) {
  const files = [];
  async function walk(directory) {
    let stream;
    try {
      stream = await opendir(directory);
      for await (const entry of stream) {
        resourceGuard.observeDirectoryEntry();
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fail("root_unsafe");
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      }
    } catch (error) {
      if (error instanceof ClaudeTranscriptExportSourceError || error instanceof ExportResourceLimitError) throw error;
      fail("root_unsafe");
    }
  }
  await walk(root);
  return files;
}

function assertPlan(plan, secret) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)
      || plan.schemaVersion !== CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION
      || !canonicalIso(plan.startAt) || !canonicalIso(plan.endAt)
      || Date.parse(plan.endAt) < Date.parse(plan.startAt)
      || typeof plan.rootDirectory !== "string" || !Array.isArray(plan.sources)
      || !safeCount(plan.sourceCount) || plan.sourceCount !== plan.sources.length
      || !safeCount(plan.totalBytes) || !validSha256(plan.planSha256)) fail("plan_invalid");
  let total = 0;
  for (const [ordinal, source] of plan.sources.entries()) {
    if (!source || source.ordinal !== ordinal || typeof source.path !== "string"
        || !validSha256(source.sourceKey) || !validStatIdentity(source.device)
        || !validStatIdentity(source.inode)
        || !safeCount(source.birthtimeMs) || !safeCount(source.prefixBytes)
        || !safeCount(source.prefixLineCount)
        || ((source.prefixBytes === 0) !== (source.prefixLineCount === 0))
        || !validSha256(source.prefixSha256) || !safeCount(source.selectedMessages)
        || !validSha256(source.selectionSha256) || !Array.isArray(source.selections)
        || source.selections.length !== source.selectedMessages
        || source.selectionSha256 !== selectionDigest(source.selections)) fail("plan_invalid");
    let priorLine = 0;
    for (const selection of source.selections) {
      if (!selection || !Number.isSafeInteger(selection.lineOrdinal) || selection.lineOrdinal <= priorLine
          || selection.lineOrdinal > source.prefixLineCount
          || !validSha256(selection.occurrenceMaterial)
          || !Number.isSafeInteger(selection.costEventCount) || selection.costEventCount < 1
          || !validSha256(selection.costStructureSha256)
          || !validToolCounts(selection.toolClassCounts)) fail("plan_invalid");
      priorLine = selection.lineOrdinal;
    }
    const expected = sourceKey(secret, source.path, {
      dev: source.device, ino: source.inode, birthtimeMs: source.birthtimeMs,
    });
    if (source.sourceKey !== expected) fail("plan_invalid");
    total += source.prefixBytes;
    if (!safeCount(total)) fail("plan_invalid");
  }
  if (total !== plan.totalBytes || plan.planSha256 !== planDigest(plan.sources)) fail("plan_invalid");
  return plan;
}

function occurrenceMaterial(secret, messageId) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-transcript-message/v1\0", "utf8")
    .update(messageId, "utf8")
    .digest("hex");
}

function privateGroupingDigest(secret, domain, value) {
  return createHmac("sha256", secret)
    .update(`app-usagemonitor/claude-transcript-${domain}/v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function selectionDigest(selections) {
  return createHash("sha256")
    .update("app-usagemonitor/claude-transcript-selection/v1\0", "utf8")
    .update(stableJson(selections))
    .digest("hex");
}

const TOOL_COUNT_KEYS = Object.freeze([
  "web_search", "file_search", "code_interpreter", "hosted_shell", "computer_use", "mcp",
  "apply_patch", "local_shell", "subagent", "tool_gateway", "other", "unknown",
]);

function validToolCounts(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === TOOL_COUNT_KEYS.length
    && TOOL_COUNT_KEYS.every((key) => Object.hasOwn(value, key) && safeCount(value[key]));
}

function emptyToolCounts() {
  return Object.fromEntries(TOOL_COUNT_KEYS.map((key) => [key, 0]));
}

function rowScope(record) {
  return record.isSidechain === true
    || (typeof record.agentId === "string" && record.agentId.length > 0) ? "subagent" : "root";
}

function tokenComponents(usage, { requireCacheSplit = false } = {}) {
  const inputUncachedTokens = usageNumber(usage, "input_tokens");
  const inputCacheReadTokens = usageNumber(usage, "cache_read_input_tokens");
  const inputCacheWriteTokens = usageNumber(usage, "cache_creation_input_tokens");
  const outputCombinedTokens = usageNumber(usage, "output_tokens");
  let inputCacheWrite5mTokens = null;
  let inputCacheWrite1hTokens = null;
  const cache = usage?.cache_creation;
  if (cache !== undefined) {
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) fail("record_invalid");
    const fiveMinute = cache.ephemeral_5m_input_tokens;
    const oneHour = cache.ephemeral_1h_input_tokens;
    if (safeCount(fiveMinute) && safeCount(oneHour)
        && fiveMinute + oneHour === inputCacheWriteTokens
        && safeCount(fiveMinute + oneHour)) {
      inputCacheWrite5mTokens = fiveMinute;
      inputCacheWrite1hTokens = oneHour;
    } else if (requireCacheSplit) {
      // The total remains usable, but API cache-write pricing is unpriceable
      // without a trustworthy duration split.
      inputCacheWrite5mTokens = null;
      inputCacheWrite1hTokens = null;
    }
  } else if (requireCacheSplit) {
    inputCacheWrite5mTokens = null;
    inputCacheWrite1hTokens = null;
  }
  return {
    inputUncachedTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    inputCacheWrite5mTokens,
    inputCacheWrite1hTokens,
    outputCombinedTokens,
  };
}

function sameCoreComponents(left, right) {
  return left.inputUncachedTokens === right.inputUncachedTokens
    && left.inputCacheReadTokens === right.inputCacheReadTokens
    && left.inputCacheWriteTokens === right.inputCacheWriteTokens
    && left.outputCombinedTokens === right.outputCombinedTokens;
}

function costEventsFromMessage(message) {
  const topLevel = tokenComponents(message.usage);
  const iterations = message.usage.iterations;
  if (iterations === undefined || iterations === null
      || (Array.isArray(iterations) && iterations.length === 0)) {
    return [{ kind: "top_level", type: "message", ordinal: 0, model: message.model, components: topLevel }];
  }
  if (!Array.isArray(iterations) || iterations.length > 64) fail("record_invalid");
  return iterations.map((iteration, ordinal) => {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) fail("record_invalid");
    const type = iteration.type === "message" || iteration.type === "fallback_message"
      ? iteration.type : "unknown";
    const components = tokenComponents(iteration, { requireCacheSplit: true });
    let model = null;
    if (typeof iteration.model === "string" && iteration.model.length > 0) {
      model = iteration.model;
    } else if (iterations.length === 1 && type === "message" && sameCoreComponents(components, topLevel)) {
      // The ordinary one-iteration form is byte-for-byte token equivalent to
      // the message total, so the top-level model is structurally attributable.
      model = message.model;
    }
    return { kind: "iteration", type, ordinal, model, components };
  });
}

function rowIdentity(record, secret) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.type !== "assistant") return null;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message) || message.usage === undefined) return null;
  if (!message.usage || typeof message.usage !== "object" || Array.isArray(message.usage)
      || typeof message.id !== "string" || message.id.length < 1
      || bufferByteLength(message.id, "utf8") > MAXIMUM_SESSION_ID_BYTES
      || typeof record.sessionId !== "string" || record.sessionId.length < 1
      || bufferByteLength(record.sessionId, "utf8") > MAXIMUM_SESSION_ID_BYTES
      || typeof message.model !== "string" || message.model.length < 1) fail("record_invalid");
  const timestamp = canonicalIso(record.timestamp);
  if (!timestamp) fail("record_invalid");
  const inputUncachedTokens = usageNumber(message.usage, "input_tokens");
  const inputCacheReadTokens = usageNumber(message.usage, "cache_read_input_tokens");
  const inputCacheWriteTokens = usageNumber(message.usage, "cache_creation_input_tokens");
  const outputCombinedTokens = usageNumber(message.usage, "output_tokens");
  const costEvents = costEventsFromMessage(message);
  const costInvariantSha256 = privateGroupingDigest(secret, "cost-invariant", stableJson(
    costEvents.map((event) => ({
      kind: event.kind,
      type: event.type,
      ordinal: event.ordinal,
      model: event.model,
      inputUncachedTokens: event.components.inputUncachedTokens,
      inputCacheReadTokens: event.components.inputCacheReadTokens,
      inputCacheWriteTokens: event.components.inputCacheWriteTokens,
      inputCacheWrite5mTokens: event.components.inputCacheWrite5mTokens,
      inputCacheWrite1hTokens: event.components.inputCacheWrite1hTokens,
    })),
  ));
  const costStructureSha256 = privateGroupingDigest(secret, "cost-structure", stableJson(costEvents));
  const hasIterationBreakdown = costEvents[0].kind === "iteration";
  const costEventOutputTokens = costEvents.reduce((sum, event) => {
    const next = sum + event.components.outputCombinedTokens;
    if (!safeCount(next)) fail("record_invalid");
    return next;
  }, 0);
  if (!Array.isArray(message.content)) fail("record_invalid");
  return {
    messageId: message.id,
    timestamp,
    sessionId: record.sessionId,
    model: message.model,
    scope: rowScope(record),
    inputUncachedTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputCombinedTokens,
    costEvents,
    costEventOutputTokens,
    hasIterationBreakdown,
    costInvariantSha256,
    costStructureSha256,
    content: message.content,
  };
}

function selectedAfter(left, right) {
  if (left.hasIterationBreakdown !== right.hasIterationBreakdown) return left.hasIterationBreakdown;
  if (left.costEventOutputTokens !== right.costEventOutputTokens) {
    return left.costEventOutputTokens > right.costEventOutputTokens;
  }
  if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp;
  if (left.sourceKey !== right.sourceKey) return left.sourceKey > right.sourceKey;
  return left.lineOrdinal > right.lineOrdinal;
}

function mergeCanonicalRow(state, row, sourceKeyValue, lineOrdinal, secret, resourceGuard) {
  const messageKey = occurrenceMaterial(secret, row.messageId);
  const existing = state.groups.get(messageKey);
  const invariant = privateGroupingDigest(secret, "invariant", stableJson({
    sessionId: row.sessionId,
    model: row.model,
    scope: row.scope,
    inputUncachedTokens: row.inputUncachedTokens,
    inputCacheReadTokens: row.inputCacheReadTokens,
    inputCacheWriteTokens: row.inputCacheWriteTokens,
  }));
  // Do not retain content, raw session/model fields, or raw provider IDs. The
  // HMAC message key is sufficient for grouping and later event identity.
  const selected = {
    timestamp: row.timestamp,
    outputCombinedTokens: row.outputCombinedTokens,
    costEventOutputTokens: row.costEventOutputTokens,
    hasIterationBreakdown: row.hasIterationBreakdown,
    sourceKey: sourceKeyValue,
    lineOrdinal,
    costEventCount: row.costEvents.length,
    costStructureSha256: row.costStructureSha256,
  };
  const group = existing ?? {
    invariant,
    topLevelInvariant: row.hasIterationBreakdown ? null : row.costInvariantSha256,
    iterationInvariant: row.hasIterationBreakdown ? row.costInvariantSha256 : null,
    selected,
    tools: new Map(),
  };
  if (existing && existing.invariant !== invariant) fail("record_invalid");
  // A logical provider message has one billable input/cache structure. This
  // deliberately fails closed on both conflicting concrete TTL splits and a
  // known-versus-unavailable split: silently preferring either duplicate would
  // make API-price accounting depend on physical transcript completeness.
  const invariantKey = row.hasIterationBreakdown ? "iterationInvariant" : "topLevelInvariant";
  if (group[invariantKey] !== null && group[invariantKey] !== row.costInvariantSha256) fail("record_invalid");
  group[invariantKey] = row.costInvariantSha256;
  if (existing && selectedAfter(selected, existing.selected)) group.selected = selected;
  for (const block of row.content) {
    if (!block || typeof block !== "object" || Array.isArray(block) || block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || block.id.length < 1
        || bufferByteLength(block.id, "utf8") > MAXIMUM_SESSION_ID_BYTES) fail("record_invalid");
    const category = classifyTool(block.name);
    const toolKey = privateGroupingDigest(secret, "tool", block.id);
    const prior = group.tools.get(toolKey);
    if (prior !== undefined && prior !== category) fail("record_invalid");
    if (prior === undefined) {
      group.tools.set(toolKey, category);
      state.retainedToolKeys += 1;
    }
    if (state.retainedToolKeys > resourceGuard.limits.maximumExportSetRecords) {
      throw new ExportResourceLimitError("output_records");
    }
  }
  if (!existing) {
    state.groups.set(messageKey, group);
    if (state.groups.size > resourceGuard.limits.maximumExportSetRecords) {
      throw new ExportResourceLimitError("output_records");
    }
  }
}

function minimizeClaudeTranscriptCanonicalOccurrence(line, sourceKeyValue, lineOrdinal, {
  secret,
} = {}) {
  if (typeof line !== "string" || !validSha256(sourceKeyValue)
      || !Number.isSafeInteger(lineOrdinal) || lineOrdinal < 1) fail("configuration");
  const key = normalizeSecret(secret);
  try {
    let record;
    try { record = parseClaudeTranscriptRecord(line); } catch { fail("record_invalid"); }
    const row = rowIdentity(record, key);
    if (!row) return null;
    const messageKey = occurrenceMaterial(key, row.messageId);
    const invariant = privateGroupingDigest(key, "invariant", stableJson({
      sessionId: row.sessionId,
      model: row.model,
      scope: row.scope,
      inputUncachedTokens: row.inputUncachedTokens,
      inputCacheReadTokens: row.inputCacheReadTokens,
      inputCacheWriteTokens: row.inputCacheWriteTokens,
    }));
    const selected = {
      timestamp: row.timestamp,
      outputCombinedTokens: row.outputCombinedTokens,
      costEventOutputTokens: row.costEventOutputTokens,
      hasIterationBreakdown: row.hasIterationBreakdown,
      sourceKey: sourceKeyValue,
      lineOrdinal,
      costEventCount: row.costEvents.length,
      costStructureSha256: row.costStructureSha256,
    };
    const tools = new Map();
    for (const block of row.content) {
      if (!block || typeof block !== "object" || Array.isArray(block) || block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || block.id.length < 1
          || bufferByteLength(block.id, "utf8") > MAXIMUM_SESSION_ID_BYTES) fail("record_invalid");
      const category = classifyTool(block.name);
      const toolKey = privateGroupingDigest(key, "tool", block.id);
      const prior = tools.get(toolKey);
      if (prior !== undefined && prior !== category) fail("record_invalid");
      tools.set(toolKey, category);
    }
    const toolClassCounts = emptyToolCounts();
    for (const category of tools.values()) toolClassCounts[category] += 1;
    const candidates = classifyAssistantRecords(record, {
      lineOrdinal,
      occurrenceMaterial: messageKey,
      costEventCount: selected.costEventCount,
      costStructureSha256: selected.costStructureSha256,
      toolClassCounts,
    }, key);
    return {
      messageKey,
      invariant,
      topLevelInvariant: row.hasIterationBreakdown ? null : row.costInvariantSha256,
      iterationInvariant: row.hasIterationBreakdown ? row.costInvariantSha256 : null,
      selected,
      tools: [...tools].map(([toolKey, category]) => ({ toolKey, category })),
      candidates,
    };
  } finally {
    key.fill(0);
  }
}

async function canonicalSelections(sources, bounds, secret, resourceGuard) {
  const state = { groups: new Map(), retainedToolKeys: 0 };
  const prefixLineCounts = new Map(sources.map((source) => [source.sourceKey, 0]));
  try {
    for (const source of sources) {
      const { handle } = await openSafeFile(source.path, source);
      try {
        await verifySource(source, handle, resourceGuard);
        for await (const entry of readBoundedUtf8LineEntries(handle, {
          maximumLineBytes: resourceGuard.limits.maximumLineBytes,
          maximumTotalBytes: source.prefixBytes,
          startByte: 0,
          startLineOrdinal: 1,
          oversizedIrrelevantNeedles: ["{"],
          resourceGuard,
        })) {
          prefixLineCounts.set(source.sourceKey, entry.lineOrdinal);
          if (entry.line === null || entry.line.trim() === "") continue;
          let record;
          try { record = parseClaudeTranscriptRecord(entry.line); } catch { fail("record_invalid"); }
          const row = rowIdentity(record, secret);
          if (row) mergeCanonicalRow(state, row, source.sourceKey, entry.lineOrdinal, secret, resourceGuard);
        }
        await verifySource(source, handle, resourceGuard);
      } finally {
        await handle.close().catch(() => {});
      }
    }
    const selectionsBySource = new Map(sources.map((source) => [source.sourceKey, []]));
    // Interval membership follows the deterministic final/max occurrence. A
    // partial row inside the interval does not pull a message whose final/max
    // occurrence falls outside into the export, and vice versa.
    for (const [messageKey, group] of state.groups) {
      if (Date.parse(group.selected.timestamp) < bounds.startMs || Date.parse(group.selected.timestamp) > bounds.endMs) continue;
      const counts = emptyToolCounts();
      for (const category of group.tools.values()) counts[category] += 1;
      selectionsBySource.get(group.selected.sourceKey).push({
        lineOrdinal: group.selected.lineOrdinal,
        occurrenceMaterial: messageKey,
        costEventCount: group.selected.costEventCount,
        costStructureSha256: group.selected.costStructureSha256,
        toolClassCounts: counts,
      });
    }
    return { selectionsBySource, prefixLineCounts };
  } finally {
    state.groups.clear();
    state.retainedToolKeys = 0;
  }
}

async function createClaudeTranscriptExportSourcePlan({
  projectsDirectory = defaultClaudeProjectsDirectory(), startAt, endAt, secret, resourceGuard,
  selectedSourcePaths = null,
} = {}) {
  if (!resourceGuard?.limits || (selectedSourcePaths !== null
      && (!Array.isArray(selectedSourcePaths)
        || selectedSourcePaths.some((path) => typeof path !== "string" || path.length === 0)))) {
    fail("configuration");
  }
  const bounds = normalizeBounds(startAt, endAt);
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  const key = normalizeSecret(secret);
  try {
    // Validate the configured path before any lstat/realpath or directory
    // traversal. A relative path must never silently fall back to cwd.
    normalizeConfiguredPath(projectsDirectory);
    let normalizedSelectedPaths;
    if (selectedSourcePaths !== null) {
      try {
        normalizedSelectedPaths = selectedSourcePaths.map(normalizeConfiguredPath);
      } catch (error) {
        if (error instanceof ClaudeTranscriptExportSourceError) throw error;
        fail("configuration");
      }
    }
    const root = await verifyRootDirectory(projectsDirectory);
    const discoveredPaths = await discoverJsonl(root, resourceGuard);
    let paths = discoveredPaths;
    if (selectedSourcePaths !== null) {
      let selectedRealPaths;
      try {
        selectedRealPaths = await Promise.all(normalizedSelectedPaths.map((path) => (
          realpath(resolve(path))
        )));
      } catch {
        fail("source_changed");
      }
      const selectedSet = new Set(selectedRealPaths);
      if (selectedSet.size !== selectedSourcePaths.length
          || [...selectedSet].some((path) => !pathWithinRoot(root, path))) {
        fail("configuration");
      }
      paths = discoveredPaths.filter((path) => selectedSet.has(path));
      if (paths.length !== selectedSet.size) fail("source_changed");
    }
    const selected = [];
    let totalBytes = 0;
    for (const path of paths) {
      const { handle, stats } = await openSafeFile(path);
      try {
        if (stats.size > resourceGuard.limits.maximumSourceBytes) throw new ExportResourceLimitError("source_bytes");
        const prefixBytes = await completeLinePrefixBytes(
          handle, stats.size, resourceGuard.limits.maximumLineBytes, resourceGuard,
        );
        totalBytes += prefixBytes;
        if (!safeCount(totalBytes) || totalBytes > resourceGuard.limits.maximumSourceBytes) {
          throw new ExportResourceLimitError("source_bytes");
        }
        selected.push({
          sourceKey: sourceKey(key, path, stats),
          path,
          device: stats.dev,
          inode: stats.ino,
          birthtimeMs: Math.trunc(stats.birthtimeMs),
          prefixBytes,
          prefixSha256: await hashPrefix(handle, prefixBytes, resourceGuard),
        });
      } finally {
        await handle.close().catch(() => {});
      }
    }
    selected.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    const provisional = selected.map((source, ordinal) => ({ ordinal, ...source }));
    const { selectionsBySource, prefixLineCounts } = await canonicalSelections(
      provisional, bounds, key, resourceGuard,
    );
    const sources = provisional.map((source) => {
      const selections = selectionsBySource.get(source.sourceKey)
        .sort((left, right) => left.lineOrdinal - right.lineOrdinal);
      return {
        ...source,
        prefixLineCount: prefixLineCounts.get(source.sourceKey),
        selections,
        selectedMessages: selections.length,
        selectionSha256: selectionDigest(selections),
      };
    }).sort((left, right) => {
      const leftSelected = left.selectedMessages > 0;
      const rightSelected = right.selectedMessages > 0;
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      return left.sourceKey.localeCompare(right.sourceKey);
    }).map((source, ordinal) => ({ ...source, ordinal }));
    resourceGuard.observeSourcePlan(sources.length, totalBytes);
    return Object.freeze({
      schemaVersion: CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      rootDirectory: root,
      sources: Object.freeze(sources.map(Object.freeze)),
      sourceCount: sources.length,
      totalBytes,
      planSha256: planDigest(sources),
    });
  } finally {
    key.fill(0);
  }
}

function createClaudeTranscriptExportCursor(plan, sourceKeyValue, { secret } = {}) {
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    if (!plan.sources.some((source) => source.sourceKey === sourceKeyValue)) fail("cursor_invalid");
    return {
      schemaVersion: CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION,
      sourceKey: sourceKeyValue,
      nextByte: 0,
      nextLineOrdinal: 1,
      nextCostOrdinal: 0,
    };
  } finally {
    key.fill(0);
  }
}

function createClaudeTranscriptExportPlanCheckpoint(plan, { secret } = {}) {
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    return Object.freeze({
      schemaVersion: CLAUDE_TRANSCRIPT_PLAN_CHECKPOINT_VERSION,
      sourcePlanVersion: CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION,
      startAt: plan.startAt,
      endAt: plan.endAt,
      sources: Object.freeze(publicPlanRows(plan.sources).map((source) => Object.freeze({
        ...source,
        selections: Object.freeze(plan.sources[source.ordinal].selections.map((selection) => Object.freeze({
          ...selection,
          toolClassCounts: Object.freeze({ ...selection.toolClassCounts }),
        }))),
      }))),
      sourceCount: plan.sourceCount,
      totalBytes: plan.totalBytes,
      planSha256: plan.planSha256,
    });
  } finally {
    key.fill(0);
  }
}

async function restoreClaudeTranscriptExportSourcePlan(checkpoint, {
  projectsDirectory = defaultClaudeProjectsDirectory(), selectedSourcePaths, secret,
} = {}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
      || checkpoint.schemaVersion !== CLAUDE_TRANSCRIPT_PLAN_CHECKPOINT_VERSION
      || checkpoint.sourcePlanVersion !== CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION
      || !Array.isArray(checkpoint.sources) || !Array.isArray(selectedSourcePaths)
      || checkpoint.sources.length !== selectedSourcePaths.length) fail("plan_invalid");
  const key = normalizeSecret(secret);
  try {
    let normalizedSelectedPaths;
    try {
      normalizeConfiguredPath(projectsDirectory);
      normalizedSelectedPaths = selectedSourcePaths.map(normalizeConfiguredPath);
    } catch (error) {
      if (error instanceof ClaudeTranscriptExportSourceError) throw error;
      fail("configuration");
    }
    const root = await verifyRootDirectory(projectsDirectory);
    let paths;
    try {
      paths = await Promise.all(normalizedSelectedPaths.map((path) => (
        realpath(resolve(path))
      )));
    } catch {
      fail("source_changed");
    }
    const unique = new Set(paths);
    if (unique.size !== paths.length || paths.some((path) => (
      !pathWithinRoot(root, path) || !path.endsWith(".jsonl")
    ))) fail("configuration");
    const pathBySourceKey = new Map();
    for (const path of paths) {
      const { handle, stats } = await openSafeFile(path);
      try {
        const keyValue = sourceKey(key, path, stats);
        if (pathBySourceKey.has(keyValue)) fail("plan_invalid");
        pathBySourceKey.set(keyValue, path);
      } finally {
        await handle.close().catch(() => {});
      }
    }
    const sources = checkpoint.sources.map((source) => ({
      ...source,
      path: pathBySourceKey.get(source.sourceKey),
      selections: source.selections?.map((selection) => ({
        ...selection,
        toolClassCounts: { ...selection.toolClassCounts },
      })),
    }));
    if (sources.some((source) => typeof source.path !== "string")) fail("source_changed");
    const plan = {
      schemaVersion: CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION,
      startAt: checkpoint.startAt,
      endAt: checkpoint.endAt,
      rootDirectory: root,
      sources,
      sourceCount: checkpoint.sourceCount,
      totalBytes: checkpoint.totalBytes,
      planSha256: checkpoint.planSha256,
    };
    assertPlan(plan, key);
    return Object.freeze({
      ...plan,
      sources: Object.freeze(sources.map((source) => Object.freeze({
        ...source,
        selections: Object.freeze(source.selections.map((selection) => Object.freeze({
          ...selection,
          toolClassCounts: Object.freeze({ ...selection.toolClassCounts }),
        }))),
      }))),
    });
  } finally {
    key.fill(0);
  }
}

function sliceTrustedClaudeTranscriptExportSourcePlan(plan, selected) {
  const source = { ...selected, ordinal: 0 };
  return {
    schemaVersion: CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION,
    startAt: plan.startAt,
    endAt: plan.endAt,
    rootDirectory: plan.rootDirectory,
    sources: [source],
    sourceCount: 1,
    totalBytes: source.prefixBytes,
    planSha256: planDigest([source]),
  };
}

function sliceClaudeTranscriptExportSourcePlan(plan, sourceKeyValue, { secret } = {}) {
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    const selected = plan.sources.find((source) => source.sourceKey === sourceKeyValue);
    if (!selected) fail("plan_invalid");
    return sliceTrustedClaudeTranscriptExportSourcePlan(plan, selected);
  } finally {
    key.fill(0);
  }
}

function sliceClaudeTranscriptExportSourcePlans(plan, { secret } = {}) {
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    return plan.sources.map((source) => sliceTrustedClaudeTranscriptExportSourcePlan(plan, source));
  } finally {
    key.fill(0);
  }
}

function validateCursor(source, cursor) {
  if (!cursor || cursor.schemaVersion !== CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION
      || cursor.sourceKey !== source.sourceKey || !safeCount(cursor.nextByte)
      || cursor.nextByte > source.prefixBytes || !Number.isSafeInteger(cursor.nextLineOrdinal)
      || cursor.nextLineOrdinal < 1 || !safeCount(cursor.nextCostOrdinal)) fail("cursor_invalid");
  if (cursor.nextCostOrdinal > 0) {
    const selection = source.selections.find((item) => item.lineOrdinal === cursor.nextLineOrdinal);
    if (!selection || cursor.nextCostOrdinal >= selection.costEventCount) fail("cursor_invalid");
  }
  return { ...cursor };
}

async function countLinesTo(handle, bytes, resourceGuard) {
  let lines = 0;
  const buffer = allocUnsafe(256 * 1024);
  for (let offset = 0; offset < bytes;) {
    resourceGuard.checkRuntime();
    const length = Math.min(buffer.length, bytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === 0x0a) lines += 1;
    offset += bytesRead;
  }
  return lines;
}

function classifyTool(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 256) return "unknown";
  const normalized = name.toLowerCase();
  if (normalized.startsWith("mcp__")) return "mcp";
  if (["websearch", "webfetch"].includes(normalized)) return "web_search";
  if (["read", "glob", "grep"].includes(normalized)) return "file_search";
  if (["bash", "shell"].includes(normalized)) return "local_shell";
  if (["edit", "write", "notebookedit"].includes(normalized)) return "apply_patch";
  if (["task", "agent", "taskoutput", "taskstop"].includes(normalized)) return "subagent";
  return "other";
}

function usageNumber(usage, key) {
  const value = usage?.[key];
  if (!safeCount(value)) fail("record_invalid");
  return value;
}

function costOccurrenceMaterial(secret, messageMaterial, ordinal, type) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-transcript-cost-occurrence/v1\0", "utf8")
    .update(stableJson({ messageMaterial, ordinal, type }))
    .digest("hex");
}

function classifyAssistantRecords(record, selection, secret) {
  const row = rowIdentity(record, secret);
  if (!row) fail("record_invalid");
  if (occurrenceMaterial(secret, row.messageId) !== selection.occurrenceMaterial) fail("record_invalid");
  if (row.costEvents.length !== selection.costEventCount
      || row.costStructureSha256 !== selection.costStructureSha256) fail("record_invalid");
  const isSubagent = row.scope === "subagent";
  const speed = record.message.usage.speed === "standard" || record.message.usage.speed === "fast"
    ? record.message.usage.speed : "unknown";
  return row.costEvents.map((cost, ordinal) => {
    const totalInputContextTokens = cost.components.inputUncachedTokens
      + cost.components.inputCacheReadTokens + cost.components.inputCacheWriteTokens;
    if (!safeCount(totalInputContextTokens)) fail("record_invalid");
    return {
      candidateVersion: CLAUDE_TRANSCRIPT_USAGE_CANDIDATE_VERSION,
      provider: "anthropic_claude_code",
      eventTime: row.timestamp,
      modelDeclaration: safeExportModelDeclaration(secret, cost.model),
      billingSurface: "claude_subscription",
      speedMode: speed,
      components: { ...cost.components },
      totalInputContextTokens,
      surface: isSubagent ? "subagent" : "local_interactive_unclassified",
      agentScope: isSubagent ? "subagent" : "root",
      lineageDisposition: isSubagent ? "parent_linked" : "standalone",
      // Tool calls describe the logical message, not each provider attempt.
      // Attach them once to the terminal attempt to preserve aggregate counts.
      toolClassCounts: ordinal === row.costEvents.length - 1
        ? selection.toolClassCounts : emptyToolCounts(),
      sessionScopeId: deriveSessionScopeId(secret, row.sessionId),
      occurrenceMaterial: costOccurrenceMaterial(secret, selection.occurrenceMaterial, ordinal, cost.type),
    };
  });
}

async function verifySourceBoundary(source, handle) {
  const stats = await statHandle(handle);
  assertSafeFile(stats);
  if (!sameIdentity(stats, source) || stats.size < source.prefixBytes) fail("source_changed");
  if (source.prefixBytes > 0) {
    const tail = allocUnsafe(1);
    const read = await handle.read(tail, 0, 1, source.prefixBytes - 1);
    if (read.bytesRead !== 1 || tail[0] !== 0x0a) fail("source_prefix");
  }
}

async function verifyCursorBoundary(handle, cursor) {
  if (cursor.nextByte === 0) return;
  const preceding = allocUnsafe(1);
  const read = await handle.read(preceding, 0, 1, cursor.nextByte - 1);
  if (read.bytesRead !== 1 || preceding[0] !== 0x0a) fail("cursor_invalid");
}

async function verifySource(source, handle, resourceGuard) {
  await verifySourceBoundary(source, handle);
  if (await hashPrefix(handle, source.prefixBytes, resourceGuard) !== source.prefixSha256) fail("source_changed");
}

async function verifyClaudeTranscriptExportSource(plan, sourceKeyValue, {
  secret, cursor = null, resourceGuard,
} = {}) {
  if (!resourceGuard?.limits) fail("configuration");
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    await verifyRootDirectory(plan.rootDirectory);
    const source = plan.sources.find((item) => item.sourceKey === sourceKeyValue);
    if (!source) fail("plan_invalid");
    const { handle } = await openSafeFile(source.path, source);
    try {
      await verifySource(source, handle, resourceGuard);
      const supplied = cursor === null ? null : validateCursor(source, cursor);
      const terminal = supplied === null
        || (supplied.nextByte === source.prefixBytes && supplied.nextCostOrdinal === 0);
      const verifiedLines = terminal
        ? source.prefixLineCount
        : await countLinesTo(handle, supplied.nextByte, resourceGuard);
      const next = cursor === null ? {
        schemaVersion: CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION,
        sourceKey: source.sourceKey,
        nextByte: source.prefixBytes,
        nextLineOrdinal: verifiedLines + 1,
        nextCostOrdinal: 0,
      } : supplied;
      if (verifiedLines !== next.nextLineOrdinal - 1) fail("cursor_invalid");
      await verifyCursorBoundary(handle, next);
      const afterPath = await statPath(source.path).catch(() => fail("source_changed"));
      assertSafeFile(afterPath);
      if (!sameIdentity(afterPath, source)) fail("source_changed");
      return { cursor: next, complete: next.nextByte === source.prefixBytes && next.nextCostOrdinal === 0 };
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    key.fill(0);
  }
}

async function scanClaudeTranscriptExportSource(plan, sourceKeyValue, {
  secret, cursor = null, maximumCandidateRecords = 500, resourceGuard, verifyWholePrefix = true,
} = {}) {
  if (!resourceGuard?.limits || !Number.isSafeInteger(maximumCandidateRecords)
      || maximumCandidateRecords < 1 || maximumCandidateRecords > 1_000
      || typeof verifyWholePrefix !== "boolean") fail("configuration");
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    await verifyRootDirectory(plan.rootDirectory);
    const source = plan.sources.find((item) => item.sourceKey === sourceKeyValue);
    if (!source) fail("plan_invalid");
    const next = validateCursor(source, cursor ?? createClaudeTranscriptExportCursor(plan, sourceKeyValue, { secret: key }));
    const selections = new Map(source.selections.map((selection) => [selection.lineOrdinal, selection]));
    resourceGuard.assertCoveredInterval(Date.parse(plan.startAt), Date.parse(plan.endAt));
    const { handle } = await openSafeFile(source.path, source);
    try {
      await verifySourceBoundary(source, handle);
      await verifyCursorBoundary(handle, next);
      if (verifyWholePrefix) {
        if (await hashPrefix(handle, source.prefixBytes, resourceGuard) !== source.prefixSha256) fail("source_changed");
        const cursorLineCount = next.nextByte === source.prefixBytes && next.nextCostOrdinal === 0
          ? source.prefixLineCount
          : await countLinesTo(handle, next.nextByte, resourceGuard);
        if (cursorLineCount !== next.nextLineOrdinal - 1) fail("cursor_invalid");
      }
      const candidates = [];
      for await (const entry of readBoundedUtf8LineEntries(handle, {
        maximumLineBytes: resourceGuard.limits.maximumLineBytes,
        maximumTotalBytes: source.prefixBytes,
        startByte: next.nextByte,
        startLineOrdinal: next.nextLineOrdinal,
        oversizedIrrelevantNeedles: ["{"],
        resourceGuard,
      })) {
        const selection = selections.get(entry.lineOrdinal);
        if (!selection) {
          if (next.nextCostOrdinal !== 0) fail("cursor_invalid");
          next.nextByte = entry.endByteExclusive;
          next.nextLineOrdinal = entry.lineOrdinal + 1;
          continue;
        }
        if (entry.line === null || entry.line.trim() === "") {
          fail("record_invalid");
        }
        let record;
        try {
          record = parseClaudeTranscriptRecord(entry.line);
        } catch {
          fail("record_invalid");
        }
        const lineCandidates = classifyAssistantRecords(record, selection, key);
        if (next.nextCostOrdinal >= lineCandidates.length) fail("cursor_invalid");
        for (let ordinal = next.nextCostOrdinal; ordinal < lineCandidates.length; ordinal += 1) {
          candidates.push(lineCandidates[ordinal]);
          if (candidates.length >= maximumCandidateRecords) {
            if (ordinal + 1 < lineCandidates.length) {
              next.nextByte = entry.startByte;
              next.nextLineOrdinal = entry.lineOrdinal;
              next.nextCostOrdinal = ordinal + 1;
            } else {
              next.nextByte = entry.endByteExclusive;
              next.nextLineOrdinal = entry.lineOrdinal + 1;
              next.nextCostOrdinal = 0;
            }
            break;
          }
        }
        if (candidates.length >= maximumCandidateRecords) break;
        next.nextByte = entry.endByteExclusive;
        next.nextLineOrdinal = entry.lineOrdinal + 1;
        next.nextCostOrdinal = 0;
      }
      if (verifyWholePrefix) await verifySource(source, handle, resourceGuard);
      else await verifySourceBoundary(source, handle);
      const afterPath = await statPath(source.path).catch(() => fail("source_changed"));
      assertSafeFile(afterPath);
      if (!sameIdentity(afterPath, source)) fail("source_changed");
      return {
        candidates,
        cursor: next,
        complete: next.nextByte === source.prefixBytes && next.nextCostOrdinal === 0,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    key.fill(0);
  }
}

function summarizeClaudeTranscriptPlan(plan, { secret } = {}) {
  const key = normalizeSecret(secret);
  try {
    assertPlan(plan, key);
    return { sourceFiles: plan.sourceCount, sourceBytes: plan.totalBytes, planSha256: plan.planSha256 };
  } finally {
    key.fill(0);
  }
}

return Object.freeze({
  CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION,
  CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION,
  CLAUDE_TRANSCRIPT_USAGE_CANDIDATE_VERSION,
  ClaudeTranscriptExportSourceError,
  createClaudeTranscriptExportCursor,
  createClaudeTranscriptExportPlanCheckpoint,
  createClaudeTranscriptExportSourcePlan,
  defaultClaudeProjectsDirectory,
  minimizeClaudeTranscriptCanonicalOccurrence,
  scanClaudeTranscriptExportSource,
  restoreClaudeTranscriptExportSourcePlan,
  sliceClaudeTranscriptExportSourcePlan,
  sliceClaudeTranscriptExportSourcePlans,
  summarizeClaudeTranscriptPlan,
  verifyClaudeTranscriptExportSource,
});
}
