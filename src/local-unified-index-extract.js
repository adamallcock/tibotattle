import { forEachRolloutLine, ROLLOUT_LINE_BYTES } from "./rollout-line-reader.js";

// Projection from one Codex rollout file to typed usage facts.
//
// This module is pure: no SQLite, no filesystem writes, no identity. That is
// what lets the identical code run in-process and inside a worker thread.
//
// Only three record types are read: `turn_context`, `token_count` and
// `thread_settings_applied`. Nothing else is parsed, so no prompt, reply,
// reasoning or file content is ever decoded — and the fields taken from those
// three are enumerated by hand below rather than copied wholesale, so a new
// content-bearing field appearing upstream cannot leak in by default. Note in
// particular that `turn_context` carries `cwd`, `workspace_roots` and a
// `collaboration_mode.settings.developer_instructions` block: all three are
// content or filesystem paths, and none of them is read here.

// Byte-level needles. Matching on the raw Buffer avoids decoding the ~99% of
// lines that are irrelevant. `"custom_tool_call"` is deliberately absent: a
// loose `tool_call` marker matched large response records and cost measurable
// time, and tool classification is not one of the three permitted record
// types.
const NEEDLE_TURN_CONTEXT = Buffer.from('"turn_context"');
const NEEDLE_TOKEN_COUNT = Buffer.from('"token_count"');
const NEEDLE_THREAD_SETTINGS = Buffer.from('"thread_settings_applied"');

const REASONING_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function relevant(line) {
  return line.includes(NEEDLE_TOKEN_COUNT)
    || line.includes(NEEDLE_TURN_CONTEXT)
    || line.includes(NEEDLE_THREAD_SETTINGS);
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {};
  for (const key of TOKEN_KEYS) {
    const quantity = value[key] ?? 0;
    if (!Number.isFinite(quantity) || quantity < 0) return null;
    normalized[key] = quantity;
  }
  return normalized;
}

function subtract(current, previous) {
  const result = {};
  for (const key of TOKEN_KEYS) {
    result[key] = Math.max(0, current[key] - (previous?.[key] ?? 0));
  }
  return result;
}

function sameUsage(left, right) {
  return TOKEN_KEYS.every((key) => left[key] === right[key]);
}

// Mirrors the reviewed provider normalization exactly. It is restated here
// rather than imported so that this module has no owner-area dependency and
// can be loaded inside a worker without pulling the provider graph in.
export function canonicalComponents(raw) {
  const cacheRead = Math.min(raw.cached_input_tokens, raw.input_tokens);
  const cacheWrite = Math.min(
    raw.cache_write_input_tokens,
    Math.max(0, raw.input_tokens - cacheRead),
  );
  const reasoning = Math.min(raw.reasoning_output_tokens, raw.output_tokens);
  return {
    inputUncachedTokens: Math.max(0, raw.input_tokens - cacheRead - cacheWrite),
    inputCacheReadTokens: cacheRead,
    inputCacheWriteTokens: cacheWrite,
    outputTextTokens: Math.max(0, raw.output_tokens - reasoning),
    outputReasoningTokens: reasoning,
  };
}

function safeClassification(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,64}$/u.test(value)
    ? value
    : null;
}

function quotaWindows(rateLimits, observedAtMs) {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const limitId = safeClassification(rateLimits.limit_id) ?? "unknown";
  const planType = safeClassification(rateLimits.plan_type);
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const window = rateLimits[slot];
    if (!window || typeof window !== "object") continue;
    const usedPercent = window.used_percent;
    const durationMins = window.window_minutes;
    const resetsAt = window.resets_at;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    if (!Number.isSafeInteger(durationMins) || durationMins < 1) continue;
    windows.push({
      observedAtMs,
      limitId,
      slot,
      planType,
      usedPercent,
      resetsAtMs: Number.isSafeInteger(resetsAt) && resetsAt > 0
        ? resetsAt * 1_000
        : null,
      durationMins,
    });
  }
  return windows;
}

// A truncated prefix cannot be handed to JSON.parse. Rather than dropping the
// record, pull the handful of scalar metadata fields that are still visible in
// the prefix. The extraction is marker-driven and value-shape-bounded: it only
// ever returns a number or a short identifier-shaped string, so it cannot
// return free text even if a content field happens to bear a matching name.
const SALVAGE_NUMBER = /^\s*(-?\d{1,15})/u;
const SALVAGE_TOKEN = /^\s*"([A-Za-z0-9._:-]{1,64})"/u;

function salvageScalar(text, key, shape) {
  const marker = `"${key}":`;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const match = shape.exec(text.slice(at + marker.length, at + marker.length + 80));
  if (match === null) return null;
  return shape === SALVAGE_NUMBER ? Number(match[1]) : match[1];
}

/**
 * Salvage a `token_count` record whose tail was truncated by the bounded-line
 * cap. The six cumulative counters sit together near the front of the payload,
 * so a record cut short by an oversized `rate_limits` blob still yields exact
 * accounting.
 *
 * All six must be present. A partial counter set would silently corrupt the
 * running cumulative baseline for every later event in the file, and a wrong
 * number is worse than a missing one — so an incomplete salvage returns null
 * and is counted rather than guessed at.
 */
export function salvagePartialTokenCount(text) {
  const usage = {};
  for (const key of TOKEN_KEYS) {
    const value = salvageScalar(text, key, SALVAGE_NUMBER);
    if (value === null || value < 0) return null;
    usage[key] = value;
  }
  return usage;
}

/**
 * Scan one rollout file and emit typed usage facts in file order.
 *
 * `seedModel` / `seedEffort` carry the lineage parent's last observed values
 * into a forked child. This is the fix for the measured data gap: Codex writes
 * the parent thread's replayed history into the child rollout *before* the
 * child's first `turn_context`, so a strictly forward carry within one file
 * leaves every replayed `token_count` with no model at all. Measured on the
 * live corpus, that is exactly the population that came out as
 * `model: "unknown"` — 309,946 records, every one of them
 * `lineageDisposition: "forked"` — while `token_count` itself never carries a
 * model of its own (0 of 26,884 sampled records had `payload.model` or
 * `payload.info.model`).
 */
export async function extractRolloutUsage(path, {
  size,
  startOffset = 0,
  seedModel = null,
  seedEffort = null,
  seedTier = null,
  seedTotals = null,
  maximumLineBytes = ROLLOUT_LINE_BYTES,
  highWaterMark = 1024 * 1024,
  signal = null,
  onEvent,
} = {}) {
  if (typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }
  let currentModel = seedModel;
  let currentEffort = seedEffort;
  let settingsEffort = null;
  let tierState = seedTier;
  let previousTotals = seedTotals;
  const diagnostics = {
    relevantLines: 0,
    malformedLines: 0,
    malformedTimestamps: 0,
    partialLines: 0,
    salvagedRecords: 0,
    turnContexts: 0,
    tokenCounts: 0,
    tierEvents: 0,
    modelSeededFromLineage: 0,
    modelMissing: 0,
  };
  if (seedModel !== null) diagnostics.modelSeededFromLineage = 1;

  const read = await forEachRolloutLine(path, {
    start: startOffset,
    end: size,
    maximumLineBytes,
    highWaterMark,
    signal,
    onLine: async (line, lineEndOffset, partial) => {
      if (!relevant(line)) return;
      diagnostics.relevantLines += 1;
      const text = line.toString("utf8");
      let record = null;
      if (partial) {
        diagnostics.partialLines += 1;
      } else {
        try {
          record = JSON.parse(text);
        } catch {
          diagnostics.malformedLines += 1;
          return;
        }
      }
      if (record === null) {
        // Degrade, don't discard.
        const observedAtMs = Date.parse(
          salvageScalar(text, "timestamp", SALVAGE_TOKEN) ?? "",
        );
        if (!Number.isFinite(observedAtMs)) return;
        if (text.includes('"turn_context"')) {
          const model = salvageScalar(text, "model", SALVAGE_TOKEN);
          if (model !== null) currentModel = model;
          const effort = salvageScalar(text, "effort", SALVAGE_TOKEN);
          if (effort !== null && REASONING_EFFORT_VALUES.has(effort)) {
            currentEffort = effort;
          }
          diagnostics.salvagedRecords += 1;
          return;
        }
        if (!text.includes('"token_count"')) return;
        const salvaged = salvagePartialTokenCount(text);
        if (salvaged === null) return;
        diagnostics.salvagedRecords += 1;
        const delta = subtract(salvaged, previousTotals);
        previousTotals = salvaged;
        if (delta.total_tokens <= 0) return;
        await onEvent({
          observedAtMs,
          sourceOffset: lineEndOffset,
          model: currentModel,
          reasoningEffort: currentEffort ?? settingsEffort,
          tier: tierState,
          components: canonicalComponents(delta),
          quota: [],
          partial: true,
        });
        return;
      }

      const observedAtMs = Date.parse(record?.timestamp);
      if (!Number.isFinite(observedAtMs)) {
        diagnostics.malformedTimestamps += 1;
        return;
      }
      if (record.type === "turn_context") {
        diagnostics.turnContexts += 1;
        // Enumerated by hand. `cwd`, `workspace_roots`, `turn_id`,
        // `personality` and the collaboration-mode developer instructions in
        // the same payload are never touched.
        if (typeof record.payload?.model === "string") {
          currentModel = record.payload.model;
        }
        const effort = record.payload?.effort;
        if (typeof effort === "string" && REASONING_EFFORT_VALUES.has(effort)) {
          currentEffort = effort;
        }
        return;
      }
      if (record.type !== "event_msg") return;
      if (record.payload?.type === "thread_settings_applied") {
        const settings = record.payload?.thread_settings;
        if (!settings || typeof settings !== "object") return;
        if (!Object.hasOwn(settings, "service_tier")) return;
        const raw = settings.service_tier;
        if (raw !== null && typeof raw !== "string") return;
        diagnostics.tierEvents += 1;
        const priorMs = tierState?.observedAtMs ?? Number.NEGATIVE_INFINITY;
        if (observedAtMs >= priorMs) {
          tierState = {
            providerTierRaw: safeClassification(raw),
            observedAtMs,
          };
        }
        // A thread setting is only a fallback. `turn_context.effort` is what
        // actually applied to the turn, and the two genuinely disagree in real
        // logs — a thread settled on `xhigh` while the turn ran at `high`.
        const effort = settings.reasoning_effort;
        if (typeof effort === "string" && REASONING_EFFORT_VALUES.has(effort)) {
          settingsEffort = effort;
        }
        return;
      }
      if (record.payload?.type !== "token_count") return;
      diagnostics.tokenCounts += 1;
      const info = record.payload?.info;
      const total = normalizeUsage(info?.total_token_usage);
      const last = normalizeUsage(info?.last_token_usage);
      let usage = null;
      if (total) {
        const delta = subtract(total, previousTotals);
        if (previousTotals === null) usage = last;
        else if (delta.total_tokens > 0) {
          usage = last && sameUsage(last, delta) ? last : delta;
        }
        previousTotals = total;
      } else {
        usage = last;
      }
      const quota = quotaWindows(record.payload?.rate_limits, observedAtMs);
      if ((!usage || (usage.input_tokens === 0 && usage.output_tokens === 0))
          && quota.length === 0) return;
      if (currentModel === null) diagnostics.modelMissing += 1;
      await onEvent({
        observedAtMs,
        sourceOffset: lineEndOffset,
        model: currentModel,
        reasoningEffort: currentEffort ?? settingsEffort,
        tier: tierState !== null && tierState.observedAtMs <= observedAtMs
          ? tierState
          : null,
        components: usage ? canonicalComponents(usage) : null,
        quota,
        partial: false,
      });
    },
  });

  return {
    diagnostics,
    read,
    finalModel: currentModel,
    finalEffort: currentEffort,
    finalTier: tierState,
    finalTotals: previousTotals,
  };
}
