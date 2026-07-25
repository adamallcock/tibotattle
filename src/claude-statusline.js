#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

export const CLAUDE_STATUSLINE_SCHEMA_VERSION = "0.2";
export const DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES = 64 * 1024;
const MIN_RESET_EPOCH_SECONDS = 946_684_800; // 2000-01-01
const MAX_RESET_EPOCH_SECONDS = 7_258_118_400; // 2200-01-01
const SEMVER = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,4})$/;
const SESSION_PSEUDONYM = /^claude-session:v1:[A-Za-z0-9_-]{43}$/;

export class ClaudeStatuslineError extends Error {
  constructor(code) {
    super(`Claude status capture failed [${code}]`);
    this.name = "ClaudeStatuslineError";
    this.code = code;
  }
}

function fail(code) {
  throw new ClaudeStatuslineError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// Read a data property without invoking an accessor. This also turns hostile
// proxy traps into a fixed, content-free failure.
function ownData(record, key, required = false) {
  if (!isPlainRecord(record)) fail("input_shape");
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    fail("input_shape");
  }
  if (!descriptor) {
    if (required) fail("input_shape");
    return undefined;
  }
  if (!("value" in descriptor)) fail("input_shape");
  return descriptor.value;
}

function requireExactKeys(record, expected, code) {
  let keys;
  try {
    keys = Object.keys(record);
  } catch {
    fail(code);
  }
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) fail(code);
}

function normalizeCapturedAt(value) {
  if (typeof value !== "string" || value.length > 32) fail("captured_at");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail("captured_at");
  return value;
}

function normalizeClientVersion(value) {
  return typeof value === "string" && value.length <= 16 && SEMVER.test(value) ? value : "unknown";
}

function normalizeModelFamily(model) {
  if (model === undefined || model === null) return "unknown";
  if (!isPlainRecord(model)) fail("model_shape");
  const id = ownData(model, "id");
  if (id === undefined || id === null) return "unknown";
  if (typeof id !== "string" || id.length > 256) fail("model_id");
  const normalized = id.toLowerCase();
  if (normalized.includes("opus")) return "claude_opus";
  if (normalized.includes("sonnet")) return "claude_sonnet";
  if (normalized.includes("haiku")) return "claude_haiku";
  return "unknown";
}

function normalizeSessionPseudonym(sessionId, sessionSecret) {
  if (sessionId === undefined || sessionId === null) return null;
  if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 1024) fail("session_id");
  if (sessionSecret === undefined || sessionSecret === null) return null;
  if (!Buffer.isBuffer(sessionSecret) && !(sessionSecret instanceof Uint8Array)) fail("session_secret");
  const secret = Buffer.from(sessionSecret);
  try {
    if (secret.byteLength !== 32) fail("session_secret");
    const digest = createHmac("sha256", secret)
      .update("app-usagemonitor/claude-session/v1\0", "utf8")
      .update(sessionId, "utf8")
      .digest("base64url");
    return `claude-session:v1:${digest}`;
  } finally {
    secret.fill(0);
  }
}

function normalizeWindow(value, windowMinutes) {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) fail("limit_window_shape");
  const usedPercent = ownData(value, "used_percentage", true);
  const resetsAt = ownData(value, "resets_at", true);
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    fail("limit_percent");
  }
  if (!Number.isSafeInteger(resetsAt)
      || resetsAt < MIN_RESET_EPOCH_SECONDS
      || resetsAt > MAX_RESET_EPOCH_SECONDS) {
    fail("limit_reset_epoch");
  }
  return { windowMinutes, usedPercent, resetsAt };
}

export function validateClaudeStatusSnapshot(snapshot) {
  if (!isPlainRecord(snapshot)) fail("snapshot_shape");
  const exactKeys = [
    "schemaVersion", "kind", "provider", "capturedAt", "clientVersion", "modelId",
    "fastMode", "sessionPseudonym", "limits", "privacy",
  ];
  requireExactKeys(snapshot, exactKeys, "snapshot_shape");
  if (ownData(snapshot, "schemaVersion", true) !== CLAUDE_STATUSLINE_SCHEMA_VERSION
      || ownData(snapshot, "kind", true) !== "claude_rate_limit_snapshot"
      || ownData(snapshot, "provider", true) !== "anthropic_claude_code") fail("snapshot_constants");
  const capturedAt = normalizeCapturedAt(ownData(snapshot, "capturedAt", true));
  const version = ownData(snapshot, "clientVersion", true);
  if (version !== "unknown" && normalizeClientVersion(version) !== version) fail("snapshot_version");
  const modelId = ownData(snapshot, "modelId", true);
  if (!["claude_opus", "claude_sonnet", "claude_haiku", "unknown"].includes(modelId)) {
    fail("snapshot_model");
  }
  const fastMode = ownData(snapshot, "fastMode", true);
  if (typeof fastMode !== "boolean") fail("snapshot_fast_mode");
  const pseudonym = ownData(snapshot, "sessionPseudonym", true);
  if (pseudonym !== null && (typeof pseudonym !== "string" || !SESSION_PSEUDONYM.test(pseudonym))) {
    fail("snapshot_session");
  }
  const limits = ownData(snapshot, "limits", true);
  if (!isPlainRecord(limits)) fail("snapshot_limits");
  requireExactKeys(limits, ["fiveHour", "sevenDay"], "snapshot_limits");
  const normalizedLimits = {};
  for (const [key, duration] of [["fiveHour", 300], ["sevenDay", 10_080]]) {
    const window = ownData(limits, key, true);
    if (window === null) {
      normalizedLimits[key] = null;
      continue;
    }
    if (!isPlainRecord(window)) fail("snapshot_limits");
    requireExactKeys(window, ["windowMinutes", "usedPercent", "resetsAt"], "snapshot_limits");
    if (ownData(window, "windowMinutes", true) !== duration) fail("snapshot_limits");
    const percent = ownData(window, "usedPercent", true);
    const reset = ownData(window, "resetsAt", true);
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) fail("snapshot_limits");
    if (!Number.isSafeInteger(reset) || reset < MIN_RESET_EPOCH_SECONDS || reset > MAX_RESET_EPOCH_SECONDS) fail("snapshot_limits");
    normalizedLimits[key] = { windowMinutes: duration, usedPercent: percent, resetsAt: reset };
  }
  const privacy = ownData(snapshot, "privacy", true);
  if (!isPlainRecord(privacy)) fail("snapshot_privacy");
  const expectedPrivacy = {
    rawSessionIdentifierStored: false,
    transcriptPathStored: false,
    workspaceStored: false,
    conversationContentStored: false,
    accountIdentifierStored: false,
    repositoryMetadataStored: false,
  };
  requireExactKeys(privacy, Object.keys(expectedPrivacy), "snapshot_privacy");
  if (Object.entries(expectedPrivacy).some(([key, expected]) => ownData(privacy, key, true) !== expected)) {
    fail("snapshot_privacy");
  }
  // Return a descriptor-read, plain-data copy. Callers can safely serialize it
  // even if the input was a proxy with hostile ordinary-property reads.
  return {
    schemaVersion: CLAUDE_STATUSLINE_SCHEMA_VERSION,
    kind: "claude_rate_limit_snapshot",
    provider: "anthropic_claude_code",
    capturedAt,
    clientVersion: version,
    modelId,
    fastMode,
    sessionPseudonym: pseudonym,
    limits: normalizedLimits,
    privacy: expectedPrivacy,
  };
}

export function sanitizeClaudeStatusline(input, capturedAt = new Date().toISOString(), options = {}) {
  if (!isPlainRecord(input)) fail("input_shape");
  if (!isPlainRecord(options)) fail("options_shape");
  const rateLimits = ownData(input, "rate_limits");
  if (rateLimits !== undefined && rateLimits !== null && !isPlainRecord(rateLimits)) fail("rate_limits_shape");
  const fastMode = ownData(input, "fast_mode");
  if (fastMode !== undefined && typeof fastMode !== "boolean") fail("fast_mode");
  const snapshot = {
    schemaVersion: CLAUDE_STATUSLINE_SCHEMA_VERSION,
    kind: "claude_rate_limit_snapshot",
    provider: "anthropic_claude_code",
    capturedAt: normalizeCapturedAt(capturedAt),
    clientVersion: normalizeClientVersion(ownData(input, "version")),
    modelId: normalizeModelFamily(ownData(input, "model")),
    fastMode: fastMode === true,
    sessionPseudonym: normalizeSessionPseudonym(ownData(input, "session_id"), ownData(options, "sessionSecret")),
    limits: {
      fiveHour: normalizeWindow(rateLimits ? ownData(rateLimits, "five_hour") : undefined, 300),
      sevenDay: normalizeWindow(rateLimits ? ownData(rateLimits, "seven_day") : undefined, 10_080),
    },
    privacy: {
      rawSessionIdentifierStored: false,
      transcriptPathStored: false,
      workspaceStored: false,
      conversationContentStored: false,
      accountIdentifierStored: false,
      repositoryMetadataStored: false,
    },
  };
  return validateClaudeStatusSnapshot(snapshot);
}

function displayPercent(value) {
  return String(Math.round(value * 10) / 10);
}

export function formatClaudeStatusline(snapshot) {
  const normalized = validateClaudeStatusSnapshot(snapshot);
  const segments = [];
  if (normalized.limits.fiveHour) segments.push(`5h ${displayPercent(normalized.limits.fiveHour.usedPercent)}%`);
  if (normalized.limits.sevenDay) segments.push(`7d ${displayPercent(normalized.limits.sevenDay.usedPercent)}%`);
  return segments.length ? `Claude ${segments.join(" · ")}` : "Claude limits unavailable";
}

export async function readBoundedClaudeStatusBytes(readable, maxBytes = DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 1024 * 1024) fail("input_bound");
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of readable) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== "string" && !(chunk instanceof Uint8Array)) fail("input_read");
      const chunkBytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? chunk.byteLength
        : Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > maxBytes - bytes) fail("input_too_large");
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += chunkBytes;
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ClaudeStatuslineError) throw error;
    fail("input_read");
  }
  if (bytes === 0) fail("input_empty");
  return Buffer.concat(chunks, bytes);
}

export async function readBoundedClaudeStatusInput(readable, maxBytes = DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES) {
  const bytes = await readBoundedClaudeStatusBytes(readable, maxBytes);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("input_json");
  }
  if (!isPlainRecord(parsed)) fail("input_shape");
  return parsed;
}

export async function runClaudeStatusline({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  platform = process.platform,
  homeDirectory,
  stateDirectory,
  loadSessionSecret = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const input = await readBoundedClaudeStatusInput(stdin);
  if (loadSessionSecret !== null && typeof loadSessionSecret !== "function") fail("session_secret");
  let sessionSecret = null;
  try {
    if (loadSessionSecret) {
      const loaded = await loadSessionSecret();
      if (!Buffer.isBuffer(loaded) || loaded.byteLength !== 32) {
        if (Buffer.isBuffer(loaded)) loaded.fill(0);
        fail("session_secret");
      }
      sessionSecret = loaded;
    }
    const snapshot = sanitizeClaudeStatusline(input, capturedAt, { sessionSecret });
    const { defaultClaudeStatusStateDirectory, writeClaudeStatusSnapshot } = await import("./claude-statusline-storage.js");
    const selectedStateDirectory = stateDirectory ?? env.USAGEMONITOR_CLAUDE_STATE_DIR
      ?? defaultClaudeStatusStateDirectory({ platform, env, homeDirectory });
    await writeClaudeStatusSnapshot(snapshot, { stateDirectory: selectedStateDirectory });
    stdout.write(`${formatClaudeStatusline(snapshot)}\n`);
    return snapshot;
  } finally {
    sessionSecret?.fill(0);
  }
}

async function main() {
  await runClaudeStatusline();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof ClaudeStatuslineError ? error.code : "internal";
    console.error(`Claude limits unavailable [${code}]`);
    process.exitCode = 1;
  });
}
