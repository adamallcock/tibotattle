import { normalizeProviderPlanType } from "./plan-normalization.js";
import {
  sanitizeProviderQuotaLimitDisplayName,
  sanitizeProviderQuotaLimitId,
} from "./quota-metadata.js";
import { normalizeProviderQuotaWindow } from "./quota-normalization.js";

const COMPONENT_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

export function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}

// #41912 response-usage records and compacted.latest_token_usage_record are
// overlapping evidence, not additive spend. Keep legacy token_count as the
// supported accounting source until response-identity reconciliation exists.
export const CODEX_LOG_RELEVANT_LINE_NEEDLES = Object.freeze([
  '"type":"session_meta"',
  '"type":"turn_context"',
  '"type":"thread_settings_applied"',
  '"type":"token_count"',
  '"type":"task_started"',
  '"type":"task_complete"',
  '"type":"custom_tool_call"',
  '"type":"function_call"',
  '"type":"web_search_call"',
  '"type":"file_search_call"',
  '"type":"code_interpreter_call"',
  '"type":"shell_call"',
  '"type":"computer_call"',
  '"type":"mcp_call"',
  '"type":"apply_patch_call"',
  '"type":"local_shell_call"',
]);

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("codex_log_scan_aborted");
  error.name = "AbortError";
  error.code = "codex_log_scan_aborted";
  throw error;
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of COMPONENT_KEYS) {
    const quantity = value[key] ?? 0;
    if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
    normalized[key] = quantity;
  }
  return normalized;
}

export function tokenComponentPresence(value) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key,
    Boolean(value && Object.hasOwn(value, key)
      && Number.isSafeInteger(value[key]) && value[key] >= 0),
  ]));
}

export function deltaComponentPresence(current, previous) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [
    key,
    current[key] && (previous === null || previous[key]),
  ]));
}

export function subtractUsage(current, previous) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, Math.max(0, current[key] - (previous?.[key] ?? 0))]));
}

export function sameUsage(left, right) {
  return COMPONENT_KEYS.every((key) => left[key] === right[key]);
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

const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function normalizeSessionIdentity(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return UUID_VALUE.test(value) ? value.toLowerCase() : value;
}

export function codexSessionMetaIdentity(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  // Codex's `id` is the stable thread identity. `session_id` is a separate
  // runtime-session identity and is only the compatibility fallback for old
  // records that predate the stable thread field.
  return normalizeSessionIdentity(payload.id)
    ?? normalizeSessionIdentity(payload.session_id);
}

function validOptionalRateLimitField(rateLimits, key, predicate) {
  if (!Object.hasOwn(rateLimits, key) || rateLimits[key] === null) return true;
  return predicate(rateLimits[key]);
}

/**
 * Normalize one complete Codex rate-limit snapshot. A snapshot may contain
 * credits or spend-control state without either rolling window; Codex emits
 * those windowless updates intentionally. Invalid window objects still fail
 * closed so accounting corruption cannot be mistaken for a sparse update.
 */
export function canonicalRateLimitSnapshot(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) return null;
  const recognizedFields = [
    "limit_id", "limit_name", "primary", "secondary", "credits",
    "individual_limit", "spend_control_reached", "plan_type",
    "rate_limit_reached_type",
  ];
  if (!recognizedFields.some((key) => Object.hasOwn(rateLimits, key))
      || !validOptionalRateLimitField(rateLimits, "limit_id", (value) => typeof value === "string")
      || !validOptionalRateLimitField(rateLimits, "limit_name", (value) => typeof value === "string")
      || !validOptionalRateLimitField(rateLimits, "credits", (value) => typeof value === "object" && !Array.isArray(value))
      || !validOptionalRateLimitField(rateLimits, "individual_limit", (value) => typeof value === "object" && !Array.isArray(value))
      || !validOptionalRateLimitField(rateLimits, "spend_control_reached", (value) => typeof value === "boolean")
      || !validOptionalRateLimitField(rateLimits, "plan_type", (value) => typeof value === "string")
      || !validOptionalRateLimitField(rateLimits, "rate_limit_reached_type", (value) => typeof value === "string")) {
    return null;
  }
  const limitId = sanitizeProviderQuotaLimitId(rateLimits.limit_id);
  const limitName = sanitizeProviderQuotaLimitDisplayName(rateLimits.limit_name);
  const planType = normalizeProviderPlanType(rateLimits.plan_type);
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const window = rateLimits[slot];
    if (window === null || window === undefined) continue;
    const normalized = normalizeProviderQuotaWindow(window);
    if (normalized === null) return null;
    windows.push({
      provider: "openai_codex",
      planType,
      limitId,
      ...(limitName === null ? {} : { limitName }),
      slot,
      ...normalized,
    });
  }
  return { windows };
}

export function canonicalRateLimitWindows(rateLimits) {
  return canonicalRateLimitSnapshot(rateLimits)?.windows ?? [];
}

/**
 * A rollout that inherits history replays the ancestor's records into its own
 * file. Replay is normally suppressed by cumulative-snapshot lineage, but a
 * replayed record whose snapshot key is absent from the ancestor's set is
 * admitted as if it were freshly observed, and it carries the ancestor's OLD
 * rate-limit reading. Such a leading reading is recognisable because the same
 * source contradicts it moments later: within the same quota window, used
 * percent cannot climb this far in this little wall-clock time.
 */
export const CONTRADICTED_LEADING_SNAPSHOT_WINDOW_MS = 60_000;
export const CONTRADICTED_LEADING_SNAPSHOT_PERCENT = 10;

function rateLimitWindowIdentity(window) {
  return [
    window.provider,
    window.limitId,
    window.slot,
    window.windowDurationMins ?? "unknown",
  ].join("\u0000");
}

function contradicts(held, candidate) {
  return candidate.resetsAt === held.resetsAt
    && candidate.timestampMs >= held.timestampMs
    && candidate.timestampMs - held.timestampMs
      <= CONTRADICTED_LEADING_SNAPSHOT_WINDOW_MS
    && candidate.usedPercent - held.usedPercent
      >= CONTRADICTED_LEADING_SNAPSHOT_PERCENT;
}

/**
 * Hold a source's leading rate-limit reading for one observation, per quota
 * window identity, until the next reading either corroborates it or exposes it
 * as stale. Nothing is corrected or invented: a contradicted reading is
 * withheld so it never becomes a data point, and every later reading passes
 * straight through. A source that genuinely starts low and rises across real
 * elapsed time keeps its leading reading.
 */
export function createLeadingRateLimitGate(settledWindows = null) {
  const settled = new Set(
    (settledWindows ?? []).map((window) => rateLimitWindowIdentity(window)),
  );
  const held = new Map();
  return {
    /**
     * Offer one observed window. `entry` is opaque payload returned verbatim,
     * so each caller keeps its own emission shape.
     */
    offer(window, timestampMs, entry) {
      const identity = rateLimitWindowIdentity(window);
      if (settled.has(identity)) return { released: [entry], withheld: [] };
      const candidate = {
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        timestampMs,
        entry,
      };
      const leading = held.get(identity);
      if (leading === undefined) {
        held.set(identity, candidate);
        return { released: [], withheld: [] };
      }
      if (contradicts(leading, candidate)) {
        held.set(identity, candidate);
        return { released: [], withheld: [leading.entry] };
      }
      held.delete(identity);
      settled.add(identity);
      return { released: [leading.entry, entry], withheld: [] };
    },
    /**
     * Release every still-held leading reading. A reading nothing contradicts
     * is a real observation, including the reading of a single-snapshot source.
     */
    flush() {
      const released = [...held.values()].map((value) => value.entry);
      held.clear();
      return released;
    },
  };
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

export function cumulativeSnapshotKey(total, last) {
  if (!total) return null;
  let key = `${total.input_tokens ?? ""}|${total.cached_input_tokens ?? ""}`
    + `|${total.cache_write_input_tokens ?? ""}|${total.output_tokens ?? ""}`
    + `|${total.reasoning_output_tokens ?? ""}|${total.total_tokens ?? ""}`;
  if (last) {
    key += `|${last.input_tokens ?? ""}|${last.cached_input_tokens ?? ""}`
      + `|${last.cache_write_input_tokens ?? ""}|${last.output_tokens ?? ""}`
      + `|${last.reasoning_output_tokens ?? ""}|${last.total_tokens ?? ""}`;
  }
  return key;
}
