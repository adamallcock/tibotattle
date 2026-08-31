import { setImmediate as cooperativeYield } from "node:timers/promises";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
  reasoningEffortOrdinal,
  REASONING_EFFORTS,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION,
} from "./local-unified-index.js";
import { readCodexLocalThreadMetadata } from "./platform/index.js";

export const LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA = "local-cache-drop-thread-links-v1";
const MAX_REFERENCES = 160;
const MAX_RECENT_ROWS = 20;
const MAX_CANDIDATES_PER_REFERENCE = 8;
const MAX_SESSION_ROWS = 25_000;
const MAX_TOTAL_SESSION_ROWS = 100_000;
const UNINSPECTED_SESSION = Symbol("uninspected_session");
const FUTURE_EVIDENCE_TOLERANCE_MS = 5 * 60_000;
const PERIODS = new Set(["24h", "7d", "30d", "all"]);
const KINDS = new Set(["switch", "continuity"]);
const CURRENT_PARSERS = new Set([
  LOCAL_UNIFIED_INDEX_PARSER_VERSION, LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION,
]);
const EFFORTS = new Set(REASONING_EFFORTS.filter((value) => value !== "unknown"));
const MAX_EFFORT = reasoningEffortOrdinal("max");
const ULTRA_EFFORT = reasoningEffortOrdinal("ultra");
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_INPUT = `COALESCE(tokens_in_uncached, 0)
  + COALESCE(tokens_in_cache_read, 0) + COALESCE(tokens_in_cache_write, 0) > 0`;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function generationNumber(value) {
  if (typeof value !== "number"
      && (typeof value !== "string" || value.length > 32
        || !/^[1-9]\d*(?:\.0+)?$/u.test(value))) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function configuration(value) {
  return object(value) && typeof value.model === "string"
    && value.model.length > 0 && value.model.length <= 200
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value.model)
    && EFFORTS.has(value.reasoningEffort);
}

function referenceFor(kind, row) {
  if (!KINDS.has(kind) || !object(row)) return null;
  const previous = kind === "switch" ? row.previous : row.configuration;
  const current = kind === "switch" ? row.current : row.configuration;
  if (!configuration(previous) || !configuration(current)
      || typeof row.observedAt !== "string" || row.observedAt.length !== 24
      || !count(row.previousCacheReadTokens) || !count(row.currentCacheReadTokens)
      || !count(row.lostCacheTokens) || row.lostCacheTokens < 1
      || row.currentCacheReadTokens > row.previousCacheReadTokens / 2
      || row.lostCacheTokens > row.previousCacheReadTokens - row.currentCacheReadTokens
      || typeof row.gapSeconds !== "number" || !Number.isFinite(row.gapSeconds)
      || row.gapSeconds < 0) return null;
  const observedMs = Date.parse(row.observedAt);
  const gapMs = Math.round(row.gapSeconds * 1_000);
  if (!count(observedMs) || new Date(observedMs).toISOString() !== row.observedAt
      || !count(gapMs) || gapMs / 1_000 !== row.gapSeconds
      || observedMs < gapMs) return null;
  const key = JSON.stringify([
    kind, row.observedAt, row.gapSeconds,
    previous.model, previous.reasoningEffort,
    current.model, current.reasoningEffort,
    row.previousCacheReadTokens, row.currentCacheReadTokens, row.lostCacheTokens,
  ]);
  return {
    kind, key, observedMs, gapMs,
    previousModel: previous.model,
    previousEffort: reasoningEffortOrdinal(previous.reasoningEffort),
    currentModel: current.model,
    currentEffort: reasoningEffortOrdinal(current.reasoningEffort),
    previousCacheReadTokens: row.previousCacheReadTokens,
    currentCacheReadTokens: row.currentCacheReadTokens,
    lostCacheTokens: row.lostCacheTokens,
  };
}

/** Stable, anonymous key shared with the browser's local-only lookup map. */
export function cacheDropThreadLookupKey(kind, row) {
  return referenceFor(kind, row)?.key ?? null;
}

function selectedReferences(overview) {
  const found = new Map();
  for (const [kind, impact] of [
    ["switch", overview?.accounting?.cacheSwitchImpact],
    ["continuity", overview?.accounting?.cacheContinuityImpact],
  ]) {
    if (!object(impact) || impact.status !== "available") continue;
    const periods = Array.isArray(impact.periods)
      ? impact.periods.slice(0, PERIODS.size).filter((period) => PERIODS.has(period?.periodId))
      : [];
    for (const period of [impact, ...periods]) {
      if (!Array.isArray(period.recent)) continue;
      for (const row of period.recent.slice(0, MAX_RECENT_ROWS)) {
        const reference = referenceFor(kind, row);
        if (reference !== null && !found.has(reference.key)) {
          if (found.size === MAX_REFERENCES) return [...found.values()];
          found.set(reference.key, reference);
        }
      }
    }
  }
  return [...found.values()];
}

function unavailable() {
  return {
    schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA,
    status: "unavailable",
    generation: null,
    entries: [],
  };
}

function safeName(value, maximumLength = 512) {
  if (typeof value !== "string" || value.length > maximumLength
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value.trim().length > 0 ? value.trim() : null;
}

function safeThread(id, metadata) {
  const parentId = typeof metadata?.parent?.id === "string"
      && THREAD_ID.test(metadata.parent.id)
    ? metadata.parent.id.toLowerCase()
    : null;
  return {
    id,
    name: metadata?.id === id ? safeName(metadata.name) : null,
    nickname: metadata?.id === id ? safeName(metadata.nickname, 80) : null,
    parent: metadata?.id !== id || parentId === null || parentId === id
      ? null
      : { id: parentId, name: safeName(metadata.parent.name) },
  };
}

function sameObservedDimension(left, right) {
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right;
}

function previousConfigurationMatches(reference, previous, current) {
  if (reference.kind === "switch") {
    // Switch details preserve both raw labels, so an equivalent alias is not
    // sufficient to identify that specific prior configuration.
    return previous.reasoning_effort === reference.previousEffort;
  }
  // Continuity details expose only the current label. Match the analyzer's
  // effective-effort boundary: Max and Ultra are equivalent, but a different
  // observed tier or surface is not cache continuity. Analyzer-backed tests
  // pin this to sameContinuityConfiguration without widening the anonymous DTO.
  const previousEffort = previous.reasoning_effort === ULTRA_EFFORT
    ? MAX_EFFORT : previous.reasoning_effort;
  const currentEffort = reference.currentEffort === ULTRA_EFFORT
    ? MAX_EFFORT : reference.currentEffort;
  return previousEffort === currentEffort
    && sameObservedDimension(previous.tier_id, current.tier_id)
    && sameObservedDimension(previous.surface_id, current.surface_id);
}

async function readSelectedMatches(database, references, futureLimitMs) {
  const candidates = database.prepare(`
    SELECT u.rowid AS usage_rowid, u.session_local, u.model_id,
           b.compaction_before, b.turn_context_before
    FROM usage_event u INDEXED BY usage_event_observed
    LEFT JOIN usage_event_boundary b ON b.current_event_key = u.event_key
    WHERE u.observed_at_ms = ?
      AND u.model_id = (SELECT id FROM model WHERE model_id = ? AND recognition = 'recognized')
      AND u.reasoning_effort = ? AND u.tokens_in_cache_read = ?
      AND ${POSITIVE_INPUT}
    LIMIT ?`);
  const sessionRows = database.prepare(`
    SELECT rowid AS usage_rowid, observed_at_ms, source_id, source_offset,
           model_id, reasoning_effort, tier_id, surface_id,
           parser_version_id, tokens_in_cache_read,
           tokens_in_uncached, tokens_in_cache_write
    FROM usage_event INDEXED BY usage_event_session
    WHERE session_local = ? AND observed_at_ms <= ? AND ${POSITIVE_INPUT}
    LIMIT ?`);
  const model = database.prepare("SELECT model_id FROM model WHERE id = ? AND recognition = 'recognized'");
  const parser = database.prepare("SELECT parser_version FROM parser_version WHERE id = ?");
  const identity = database.prepare(
    "SELECT session_uuid FROM session_identity WHERE session_local = ?",
  );
  const sessions = new Map();
  let totalRows = 0;

  async function orderedSession(sessionLocal) {
    if (!(sessionLocal instanceof Uint8Array) || sessionLocal.byteLength !== 32) return null;
    const sessionKey = Buffer.from(sessionLocal).toString("hex");
    if (sessions.has(sessionKey)) return sessions.get(sessionKey);
    // Budget exhaustion means unknown, not proof that this session could not
    // produce the tuple. Retain that distinction across every reference that
    // reaches this same session later in the call.
    sessions.set(sessionKey, UNINSPECTED_SESSION);
    if (totalRows >= MAX_TOTAL_SESSION_ROWS) return UNINSPECTED_SESSION;
    const limit = Math.min(MAX_SESSION_ROWS, MAX_TOTAL_SESSION_ROWS - totalRows);
    const rows = [];
    for (const row of sessionRows.iterate(sessionLocal, futureLimitMs, limit + 1)) {
      totalRows += 1;
      rows.push(row);
      if (rows.length > limit) return UNINSPECTED_SESSION;
      if (totalRows % 500 === 0) await cooperativeYield();
    }
    // The complete bounded result can now establish ineligibility. Before
    // this point, neither ordering nor absence of a match has been proven.
    sessions.set(sessionKey, null);
    if (rows.length < 2) return null;
    const source = rows[0].source_id;
    if (!count(source) || source === 0
        || rows.some((row) => row.source_id !== source || !count(row.source_offset))) {
      return null;
    }
    rows.sort((left, right) => left.source_offset - right.source_offset);
    if (rows.some((row, index) => index > 0
        && row.source_offset === rows[index - 1].source_offset)) return null;
    const adjacent = new Map();
    for (let index = 1; index < rows.length; index += 1) {
      adjacent.set(rows[index].usage_rowid, [rows[index - 1], rows[index]]);
    }
    sessions.set(sessionKey, adjacent);
    return adjacent;
  }

  const matches = [];
  for (const reference of references) {
    if (reference.observedMs > futureLimitMs) continue;
    const possible = candidates.all(reference.observedMs, reference.currentModel,
      reference.currentEffort, reference.currentCacheReadTokens,
      MAX_CANDIDATES_PER_REFERENCE + 1);
    if (possible.length > MAX_CANDIDATES_PER_REFERENCE) continue;
    const resolved = [];
    let unexaminedCandidate = false;
    for (const candidate of possible) {
      const adjacent = await orderedSession(candidate.session_local);
      if (adjacent === UNINSPECTED_SESSION) {
        unexaminedCandidate = true;
        continue;
      }
      const pair = adjacent?.get(candidate.usage_rowid);
      if (pair === undefined) continue;
      const [previous, current] = pair;
      if (current.observed_at_ms - previous.observed_at_ms !== reference.gapMs
          || !previousConfigurationMatches(reference, previous, current)
          || previous.tokens_in_cache_read !== reference.previousCacheReadTokens
          || model.get(previous.model_id)?.model_id !== reference.previousModel
          || !CURRENT_PARSERS.has(parser.get(previous.parser_version_id)?.parser_version)
          || !CURRENT_PARSERS.has(parser.get(current.parser_version_id)?.parser_version)
          || !count(current.tokens_in_uncached) || !count(current.tokens_in_cache_write)
          || !count(current.tokens_in_uncached + current.tokens_in_cache_write
            + reference.currentCacheReadTokens)
          || current.tokens_in_uncached + current.tokens_in_cache_write
            + reference.currentCacheReadTokens < reference.previousCacheReadTokens
          || Math.min(reference.previousCacheReadTokens - reference.currentCacheReadTokens,
            current.tokens_in_uncached + current.tokens_in_cache_write) !== reference.lostCacheTokens
          || candidate.compaction_before === 1) continue;
      if (reference.kind === "continuity" && candidate.turn_context_before !== 1) continue;
      const id = identity.get(candidate.session_local)?.session_uuid;
      resolved.push(typeof id === "string" && THREAD_ID.test(id)
        ? id.toLowerCase()
        : null);
    }
    // A tied metadata tuple is not an identity. Even if both matches carry the
    // same UUID, there are two source events and no unique provenance proof.
    if (!unexaminedCandidate && resolved.length === 1 && resolved[0] !== null) matches.push({
      kind: reference.kind, key: reference.key, id: resolved[0],
    });
  }
  return matches;
}

/**
 * Local-only enrichment for the bounded recent rows already in this snapshot.
 * It is never an arbitrary thread lookup and never mutates an index or cache.
 */
export async function buildLocalCacheDropThreadLinks({
  indexFile,
  codexHome,
  overview,
  nowMs = Date.now(),
  openIndex = openLocalUnifiedIndex,
  readThreadMetadata = readCodexLocalThreadMetadata,
} = {}) {
  const generation = generationNumber(overview?.accounting?.generation);
  if (generation === null || overview.accounting.generationMatched !== true
      || !count(nowMs) || typeof indexFile !== "string" || indexFile.length === 0) {
    return unavailable();
  }
  let database;
  let matches;
  try {
    database = openIndex(indexFile, { readOnly: true });
    database.exec("BEGIN");
    const descriptor = readUnifiedIndexGenerationDescriptor(database);
    if (descriptor?.id !== generation
        || !(descriptor.status === "complete" || (descriptor.status === "partial"
          && ["tool_provenance_incomplete", "codex_rollout_sources_quarantined"]
            .includes(descriptor.blockReason)))
        || !descriptor.discoveryComplete || !descriptor.diagnosticsComplete
        || (overview.accounting.generationFingerprint != null
          && overview.accounting.generationFingerprint !== descriptor.fingerprint)) {
      return unavailable();
    }
    matches = await readSelectedMatches(
      database, selectedReferences(overview), nowMs + FUTURE_EVIDENCE_TOLERANCE_MS,
    );
  } catch {
    return unavailable();
  } finally {
    if (database?.isOpen) database.close();
  }
  let metadata = null;
  try {
    metadata = await readThreadMetadata(codexHome, [...new Set(matches.map((row) => row.id))]);
  } catch {
    // Thread names are optional; exact local IDs remain useful when the Codex
    // display-name store is unavailable. No error text enters the response.
  }
  return {
    schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA,
    status: "available",
    generation: String(generation),
    entries: matches.map(({ kind, key, id }) => ({
      kind, key, thread: safeThread(id, metadata instanceof Map ? metadata.get(id) : null),
    })),
  };
}
