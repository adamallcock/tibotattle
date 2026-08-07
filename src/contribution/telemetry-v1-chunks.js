import { createHash } from "node:crypto";

import {
  TELEMETRY_MODEL_IDS,
  TELEMETRY_PLAN_TYPES,
} from "@app-usagemonitor/telemetry-contract";

// telemetry-contribution-v1.0 chunk derivation over the local unified index
// (docs/design/2026-08-07-incremental-contribution-model.md).
//
// History is deterministically partitioned client-side: per stream, per UTC
// day, ordered by a total order any two scans reproduce, split into segments
// of at most 200 records. The digest identity is SHA-256 over the canonical
// minified JSON array of a chunk's records — the same serialization the
// worker recomputes — so an unchanged day re-derives to the identical digest
// and is never re-sent, and a changed day supersedes at revision + 1.
//
// The worker's fail-closed validators (apps/worker/src/telemetry-v1.ts) are
// the wire contract; every bound here mirrors one there. A row the contract
// cannot carry is excluded deterministically and counted, never shipped and
// never silently mutated.

export const TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION =
  "telemetry-contribution-v1.0";
export const TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.0";
// Required consent identifiers (design section 5). Drift against the stored
// consent record halts auto-upload by construction because equality is exact.
export const TELEMETRY_V1_FIELD_DICTIONARY_VERSION =
  "telemetry-v1.0-registry-2026-08-07.1";
export const TELEMETRY_V1_PRIVACY_CONTRACT_VERSION =
  "ongoing-privacy-safe-telemetry-v1.0";

export const MAX_TELEMETRY_V1_CHUNK_RECORDS = 200;
export const MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES = 1_250_000;

export const TELEMETRY_V1_STREAMS = Object.freeze(["quota", "session", "usage"]);

const PROVIDER_OPENAI_CODEX = "openai_codex";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const BOUNDED_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SESSION_UUID = /^[A-Za-z0-9._:-]{8,128}$/u;
const TOOL_CLASS_KEY = /^[a-zA-Z][A-Za-z0-9]{0,31}$/u;
const PARSER_VERSION = /^[A-Za-z0-9._-]{1,64}$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const CHUNK_ID =
  /^(usage|quota|session):(\d{4}-\d{2}-\d{2}):(0|[1-9]\d{0,4})$/u;
const MAX_TOKEN_COMPONENT = 1_000_000_000_000;
const MAX_TOOL_CLASS_COUNT = 1_000_000_000;
const MAX_TOOL_CLASS_ENTRIES = 32;
const MAX_WINDOW_DURATION_MINUTES = 527_040;
const MAX_CHUNK_REVISION = 1_000_000;
const MAX_ORPHAN_CHUNK_IDS = 64;
const MODEL_IDS = new Set(TELEMETRY_MODEL_IDS);
const PLAN_TYPES = new Set(TELEMETRY_PLAN_TYPES);
// Transport canary, re-pinned from the v0.1 projection for v1.0: raw scope
// identifiers never leave the device. `sessionUuid` is the one deliberate
// v1.0 addition and is allowlisted by exact name; these remain forbidden in
// any serialized chunk plaintext.
const FORBIDDEN_TRANSPORT_KEYS = Object.freeze([
  "\"accountScopeId\"",
  "\"sessionScopeId\"",
  "\"participantId\"",
  "\"providerStateId\"",
]);

const ERROR_CODES = new Set([
  "index_unavailable",
  "derivation_invalid",
  "chunk_invalid",
  "plan_invalid",
]);

export class TelemetryV1ChunkError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown telemetry v1 chunk error code");
    }
    super("Telemetry v1 chunk derivation failed closed");
    this.name = "TelemetryV1ChunkError";
    this.code = `telemetry_v1_${code}`;
  }
}

function fail(code) {
  throw new TelemetryV1ChunkError(code);
}

/**
 * The canonical serializer both sides digest: compact JSON with object keys
 * sorted by UTF-16 code unit, arrays in order. Byte-identical to the worker's
 * `canonicalJson` (apps/worker/src/canonical-json.ts) by construction.
 */
export function telemetryV1CanonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => telemetryV1CanonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${telemetryV1CanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function telemetryV1ChunkDigest(records) {
  return sha256Hex(telemetryV1CanonicalJson(records));
}

/**
 * Day digest: SHA-256 over the day's chunk digests concatenated in
 * (stream ASC, seq ASC) order — the exact order the worker reads back from
 * its journal. History digest: SHA-256 over day digests in day order.
 */
export function telemetryV1DayDigest(chunks) {
  const ordered = [...chunks].sort((left, right) => (
    left.stream === right.stream
      ? left.chunkSeq - right.chunkSeq
      : left.stream < right.stream ? -1 : 1
  ));
  return sha256Hex(ordered.map((chunk) => chunk.chunkDigest).join(""));
}

export function telemetryV1HistoryDigest(days) {
  if (days.length === 0) return null;
  const ordered = [...days].sort((left, right) => (
    left.day < right.day ? -1 : left.day > right.day ? 1 : 0
  ));
  return sha256Hex(ordered.map((day) => day.dayDigest).join(""));
}

function isUtcDay(value) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString().slice(0, 10) === value;
}

function dayBounds(day) {
  if (!isUtcDay(day)) fail("derivation_invalid");
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  return { startMs, endMs: startMs + DAY_MILLISECONDS };
}

function instant(milliseconds) {
  return new Date(Number(milliseconds)).toISOString();
}

function tokenComponent(value) {
  if (value === null || value === undefined) return null;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)
      || selected < 0
      || selected > MAX_TOKEN_COMPONENT) {
    return undefined;
  }
  return selected;
}

function boundedToken(value) {
  return typeof value === "string" && BOUNDED_TOKEN.test(value) ? value : null;
}

function tableExists(database, name) {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

function splitIntoChunks(stream, day, records, parserVersions, fallbackParserVersion) {
  const chunks = [];
  for (let offset = 0; offset < records.length;
    offset += MAX_TELEMETRY_V1_CHUNK_RECORDS) {
    const seq = offset / MAX_TELEMETRY_V1_CHUNK_RECORDS;
    const segment = records.slice(
      offset,
      offset + MAX_TELEMETRY_V1_CHUNK_RECORDS,
    );
    const canonical = telemetryV1CanonicalJson(segment);
    if (Buffer.byteLength(canonical, "utf8")
        > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES) {
      fail("derivation_invalid");
    }
    // The chunk's parser stamp is the lexicographically greatest distinct
    // parser version among its source rows — deterministic under any scan
    // order, and honest about a mixed-parser day: the digest identity is the
    // records alone, so the stamp never perturbs supersession.
    const stamped = parserVersions === null
      ? fallbackParserVersion
      : [...parserVersions.slice(offset, offset + MAX_TELEMETRY_V1_CHUNK_RECORDS)]
        .sort()
        .at(-1) ?? fallbackParserVersion;
    if (!PARSER_VERSION.test(stamped)) fail("derivation_invalid");
    chunks.push(Object.freeze({
      stream,
      chunkDay: day,
      chunkSeq: seq,
      chunkId: `${stream}:${day}:${seq}`,
      chunkDigest: sha256Hex(canonical),
      recordCount: segment.length,
      parserVersion: stamped,
      records: Object.freeze(segment),
    }));
  }
  return chunks;
}

/**
 * A bounded reader over one open unified index connection. Reads are strictly
 * read-only; per-day queries stream off the observed-at index, and the
 * session dimension is grouped once via the session index. The reader carries
 * no device salt: `sessionUuid` is a stored column (raw, per the owner's
 * ruling), with the stable hex of the local join key as the deterministic
 * stand-in for sessions indexed before identity recording existed.
 *
 * The unified index is reached only through injected ports: the open database
 * handle plus the index's own row codecs — the outcome and reasoning-effort
 * ordinal decoders and the fallback parser stamp — supplied by the
 * composition root that owns the index module. The contribution owner never
 * reaches back into legacy flat source for them.
 */
export function createTelemetryV1IndexReader(database, {
  outcomeName,
  reasoningEffortName,
  fallbackParserVersion,
} = {}) {
  if (!database || typeof database.prepare !== "function"
      || typeof outcomeName !== "function"
      || typeof reasoningEffortName !== "function"
      || typeof fallbackParserVersion !== "string"
      || !PARSER_VERSION.test(fallbackParserVersion)) {
    fail("index_unavailable");
  }
  const identityAvailable = tableExists(database, "session_identity");
  const toolClassAvailable = tableExists(database, "tool_class_count");
  const identityJoin = identityAvailable
    ? "LEFT JOIN session_identity si ON si.session_local = u.session_local"
    : "";
  const identityColumn = identityAvailable
    ? "si.session_uuid"
    : "NULL";

  const usageStatement = database.prepare(`
    SELECT u.event_key AS event_key,
           u.observed_at_ms AS observed_at_ms,
           u.session_local AS session_local,
           ${identityColumn} AS session_uuid,
           m.model_id AS model_id,
           t.api_service_tier AS api_service_tier,
           t.billing_surface AS billing_surface,
           t.codex_speed_mode AS codex_speed_mode,
           s.agent_scope AS agent_scope,
           s.surface AS surface,
           u.reasoning_effort AS reasoning_effort,
           u.outcome AS outcome,
           u.tokens_in_uncached AS tokens_in_uncached,
           u.tokens_in_cache_read AS tokens_in_cache_read,
           u.tokens_in_cache_write AS tokens_in_cache_write,
           u.tokens_out_text AS tokens_out_text,
           u.tokens_out_reasoning AS tokens_out_reasoning,
           u.tokens_out_combined AS tokens_out_combined,
           u.total_input_context AS total_input_context,
           p.parser_version AS parser_version
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class s ON s.id = u.surface_id
    JOIN parser_version p ON p.id = u.parser_version_id
    ${identityJoin}
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ?
    ORDER BY u.observed_at_ms, u.event_key`);
  const quotaStatement = database.prepare(`
    SELECT observed_at_ms, limit_id, slot, plan_type, used_percent,
           resets_at_ms, duration_mins
    FROM quota_observation
    WHERE observed_at_ms >= ? AND observed_at_ms < ?
    ORDER BY observed_at_ms, limit_id, slot`);
  const sessionStatement = database.prepare(`
    SELECT u.session_local AS session_local,
           MIN(u.observed_at_ms) AS first_ms,
           ${identityColumn} AS session_uuid
    FROM usage_event u
    ${identityJoin}
    GROUP BY u.session_local
    HAVING MIN(u.observed_at_ms) >= ? AND MIN(u.observed_at_ms) < ?
    ORDER BY first_ms, u.session_local`);
  const toolClassStatement = toolClassAvailable
    ? database.prepare(`
      SELECT tool_class, count FROM tool_class_count
      WHERE session_local = ?
      ORDER BY tool_class`)
    : null;
  const daysStatement = database.prepare(`
    SELECT DISTINCT day FROM (
      SELECT date(observed_at_ms / 1000, 'unixepoch') AS day FROM usage_event
      UNION
      SELECT date(observed_at_ms / 1000, 'unixepoch') AS day
      FROM quota_observation
    )
    ORDER BY day`);

  function sessionUuidFor(row) {
    const stored = row.session_uuid;
    if (typeof stored === "string" && SESSION_UUID.test(stored)) return stored;
    // Deterministic stand-in for pre-identity rows: the stable hex of the
    // local join key. Content-free by construction and stable across scans,
    // so dedupe and supersession keep working; the day revises itself the
    // moment a re-scan records the raw identity.
    const key = Buffer.from(row.session_local).toString("hex");
    return SESSION_UUID.test(key) ? key : null;
  }

  function usageRecords(day) {
    const { startMs, endMs } = dayBounds(day);
    const records = [];
    const parserVersions = [];
    let excluded = 0;
    for (const row of usageStatement.iterate(startMs, endMs)) {
      const sessionUuid = sessionUuidFor(row);
      const modelId = typeof row.model_id === "string"
        && MODEL_IDS.has(row.model_id)
        ? row.model_id
        : null;
      const eventId = Buffer.from(row.event_key).toString("hex");
      const components = {
        inputUncachedTokens: tokenComponent(row.tokens_in_uncached),
        inputCacheReadTokens: tokenComponent(row.tokens_in_cache_read),
        inputCacheWriteTokens: tokenComponent(row.tokens_in_cache_write),
        outputTextTokens: tokenComponent(row.tokens_out_text),
        outputReasoningTokens: tokenComponent(row.tokens_out_reasoning),
        outputCombinedTokens: tokenComponent(row.tokens_out_combined),
      };
      const totalInputContextTokens = tokenComponent(row.total_input_context);
      const bounded = {
        speedMode: boundedToken(row.codex_speed_mode),
        apiServiceTier: boundedToken(row.api_service_tier),
        surface: boundedToken(row.surface),
        billingSurface: boundedToken(row.billing_surface),
        agentScope: boundedToken(row.agent_scope),
      };
      if (sessionUuid === null
          || modelId === null
          || !OCCURRENCE_ID.test(eventId)
          || totalInputContextTokens === undefined
          || Object.values(components).includes(undefined)
          || Object.values(bounded).includes(null)) {
        excluded += 1;
        continue;
      }
      records.push({
        schemaVersion: "usage-event-v1.0",
        eventId,
        eventTime: instant(row.observed_at_ms),
        sessionUuid,
        provider: PROVIDER_OPENAI_CODEX,
        modelId,
        speedMode: bounded.speedMode,
        apiServiceTier: bounded.apiServiceTier,
        surface: bounded.surface,
        billingSurface: bounded.billingSurface,
        reasoningEffort: reasoningEffortName(Number(row.reasoning_effort)),
        agentScope: bounded.agentScope,
        outcome: outcomeName(Number(row.outcome)),
        totalInputContextTokens,
        components,
      });
      parserVersions.push(
        typeof row.parser_version === "string"
          && PARSER_VERSION.test(row.parser_version)
          ? row.parser_version
          : fallbackParserVersion,
      );
    }
    return { records, parserVersions, excluded };
  }

  function quotaRecords(day) {
    const { startMs, endMs } = dayBounds(day);
    const records = [];
    let excluded = 0;
    for (const row of quotaStatement.iterate(startMs, endMs)) {
      const limitId = boundedToken(row.limit_id);
      const slot = boundedToken(row.slot);
      const usedPercent = Number(row.used_percent);
      const windowDurationMinutes = Number(row.duration_mins);
      const resetsAtMs = Number(row.resets_at_ms);
      const observationId = limitId !== null && slot !== null
        ? `q:${row.observed_at_ms}:${limitId}:${slot}`
        : "";
      // The contract carries only complete observations: a reading without a
      // percentage, window or reset instant cannot satisfy the worker's
      // closed schema and is excluded deterministically rather than invented.
      if (limitId === null || slot === null
          || !OCCURRENCE_ID.test(observationId)
          || !Number.isFinite(usedPercent)
          || usedPercent < 0 || usedPercent > 100
          || !Number.isSafeInteger(windowDurationMinutes)
          || windowDurationMinutes < 1
          || windowDurationMinutes > MAX_WINDOW_DURATION_MINUTES
          || !Number.isSafeInteger(resetsAtMs)) {
        excluded += 1;
        continue;
      }
      records.push({
        schemaVersion: "quota-observation-v1.0",
        observationId,
        observedTime: instant(row.observed_at_ms),
        provider: PROVIDER_OPENAI_CODEX,
        planType: typeof row.plan_type === "string"
          && PLAN_TYPES.has(row.plan_type)
          ? row.plan_type
          : "unknown",
        planVariant: "unknown",
        limitId,
        slot,
        usedPercent,
        windowDurationMinutes,
        resetsAt: instant(resetsAtMs),
      });
    }
    return { records, excluded };
  }

  function sessionRecords(day) {
    const { startMs, endMs } = dayBounds(day);
    const records = [];
    let excluded = 0;
    for (const row of sessionStatement.all(startMs, endMs)) {
      const sessionUuid = sessionUuidFor(row);
      if (sessionUuid === null) {
        excluded += 1;
        continue;
      }
      const toolClassCounts = {};
      let entries = 0;
      let invalid = false;
      if (toolClassStatement !== null) {
        for (const tool of toolClassStatement.all(row.session_local)) {
          const count = Number(tool.count);
          if (typeof tool.tool_class !== "string"
              || !TOOL_CLASS_KEY.test(tool.tool_class)
              || !Number.isSafeInteger(count)
              || count < 0
              || count > MAX_TOOL_CLASS_COUNT) {
            invalid = true;
            break;
          }
          toolClassCounts[tool.tool_class] = count;
          entries += 1;
        }
      }
      // The worker's closed schema requires 1..32 tool-class entries: a
      // session the index holds no counts for has no dimension record yet
      // and simply appears — as a day revision — once counts are ingested.
      if (invalid || entries < 1 || entries > MAX_TOOL_CLASS_ENTRIES) {
        if (invalid) excluded += 1;
        continue;
      }
      records.push({
        schemaVersion: "session-dimension-v1.0",
        sessionUuid,
        firstEventTime: instant(row.first_ms),
        provider: PROVIDER_OPENAI_CODEX,
        toolClassCounts,
      });
    }
    return { records, excluded };
  }

  return Object.freeze({
    days() {
      return daysStatement.all()
        .map((row) => row.day)
        .filter((day) => isUtcDay(day));
    },

    /**
     * Derive one UTC day: all three streams, ordered, split, digested. The
     * same index slice always produces byte-identical chunks; changing or
     * adding any row in the day changes that day's digests and only that
     * day's.
     */
    deriveDay(day) {
      const usage = usageRecords(day);
      const quota = quotaRecords(day);
      const session = sessionRecords(day);
      const chunks = [
        ...splitIntoChunks("quota", day, quota.records, null, fallbackParserVersion),
        ...splitIntoChunks("session", day, session.records, null, fallbackParserVersion),
        ...splitIntoChunks("usage", day, usage.records, usage.parserVersions, fallbackParserVersion),
      ];
      return Object.freeze({
        day,
        dayDigest: telemetryV1DayDigest(chunks),
        chunks: Object.freeze(chunks),
        excluded: Object.freeze({
          usage: usage.excluded,
          quota: quota.excluded,
          session: session.excluded,
        }),
      });
    },
  });
}

function validConsent(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0")
      === "fieldDictionaryVersion\0privacyContractVersion\0telemetrySchemaVersion"
    && value.telemetrySchemaVersion === TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
    && value.fieldDictionaryVersion === TELEMETRY_V1_FIELD_DICTIONARY_VERSION
    && value.privacyContractVersion === TELEMETRY_V1_PRIVACY_CONTRACT_VERSION;
}

/**
 * Build the chunk plaintext the worker decrypts, and fail closed before
 * anything leaves the device: exact keys, worker-mirrored bounds, digest
 * consistency, and the transport canary — raw scope identifiers stay
 * forbidden; `sessionUuid` is the one allowlisted v1.0 addition.
 */
export function buildTelemetryV1ChunkPlaintext({
  chunk,
  revision,
  consent,
} = {}) {
  if (!chunk || typeof chunk !== "object"
      || !Number.isSafeInteger(revision)
      || revision < 1
      || revision > MAX_CHUNK_REVISION
      || !validConsent(consent)) {
    fail("chunk_invalid");
  }
  const match = CHUNK_ID.exec(chunk.chunkId ?? "");
  if (!match
      || match[1] !== chunk.stream
      || match[2] !== chunk.chunkDay
      || Number(match[3]) !== chunk.chunkSeq
      || !isUtcDay(chunk.chunkDay)
      || !DIGEST_HEX.test(chunk.chunkDigest ?? "")
      || !PARSER_VERSION.test(chunk.parserVersion ?? "")
      || !Array.isArray(chunk.records)
      || chunk.records.length < 1
      || chunk.records.length > MAX_TELEMETRY_V1_CHUNK_RECORDS) {
    fail("chunk_invalid");
  }
  const canonicalRecords = telemetryV1CanonicalJson(chunk.records);
  if (Buffer.byteLength(canonicalRecords, "utf8")
        > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES
      || sha256Hex(canonicalRecords) !== chunk.chunkDigest) {
    fail("chunk_invalid");
  }
  for (const record of chunk.records) {
    const observedAt = chunk.stream === "usage"
      ? record?.eventTime
      : chunk.stream === "quota"
        ? record?.observedTime
        : record?.firstEventTime;
    if (typeof observedAt !== "string"
        || observedAt.slice(0, 10) !== chunk.chunkDay) {
      fail("chunk_invalid");
    }
  }
  const plaintext = {
    schemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    chunkId: chunk.chunkId,
    chunkRevision: revision,
    chunkDigest: chunk.chunkDigest,
    parserVersion: chunk.parserVersion,
    consent: {
      telemetrySchemaVersion: consent.telemetrySchemaVersion,
      fieldDictionaryVersion: consent.fieldDictionaryVersion,
      privacyContractVersion: consent.privacyContractVersion,
    },
    records: chunk.records,
  };
  const serialized = JSON.stringify(plaintext);
  for (const forbidden of FORBIDDEN_TRANSPORT_KEYS) {
    if (serialized.includes(forbidden)) fail("chunk_invalid");
  }
  return plaintext;
}

function validManifestDay(value) {
  return value !== null
    && typeof value === "object"
    && isUtcDay(value.day)
    && DIGEST_HEX.test(value.dayDigest ?? "")
    && Array.isArray(value.chunks)
    && value.chunks.every((chunk) => (
      chunk !== null
      && typeof chunk === "object"
      && CHUNK_ID.test(chunk.chunkId ?? "")
      && Number.isSafeInteger(chunk.revision)
      && chunk.revision >= 1
      && chunk.revision <= MAX_CHUNK_REVISION
      && DIGEST_HEX.test(chunk.chunkDigest ?? "")
    ));
}

/**
 * Diff the locally derived days against the service's manifest and produce
 * the exact upload set, oldest day first: a chunk the service has never seen
 * uploads at revision 1, a chunk whose content digest changed supersedes at
 * revision + 1, and an identical digest is never re-sent. A server chunk with
 * no local counterpart cannot be superseded from here — the ids are reported,
 * bounded, for the status surface.
 */
export function planTelemetryV1Upload({ localDays, manifestDays = [] } = {}) {
  if (!Array.isArray(localDays) || !Array.isArray(manifestDays)) {
    fail("plan_invalid");
  }
  const manifestByDay = new Map();
  for (const day of manifestDays) {
    if (!validManifestDay(day) || manifestByDay.has(day.day)) {
      fail("plan_invalid");
    }
    manifestByDay.set(day.day, day);
  }
  const uploads = [];
  const orphanChunkIds = [];
  let skippedChunks = 0;
  const orderedLocalDays = [...localDays].sort((left, right) => (
    left.day < right.day ? -1 : left.day > right.day ? 1 : 0
  ));
  const localDaySet = new Set();
  for (const localDay of orderedLocalDays) {
    if (!isUtcDay(localDay?.day)
        || !DIGEST_HEX.test(localDay?.dayDigest ?? "")
        || !Array.isArray(localDay?.chunks)
        || localDaySet.has(localDay.day)) {
      fail("plan_invalid");
    }
    localDaySet.add(localDay.day);
    const manifestDay = manifestByDay.get(localDay.day);
    if (manifestDay !== undefined
        && manifestDay.dayDigest === localDay.dayDigest) {
      skippedChunks += localDay.chunks.length;
      continue;
    }
    const manifestChunks = new Map(
      (manifestDay?.chunks ?? []).map((chunk) => [chunk.chunkId, chunk]),
    );
    const localChunkIds = new Set();
    for (const chunk of localDay.chunks) {
      localChunkIds.add(chunk.chunkId);
      const existing = manifestChunks.get(chunk.chunkId);
      if (existing === undefined) {
        uploads.push(Object.freeze({
          day: localDay.day,
          chunkId: chunk.chunkId,
          stream: chunk.stream,
          chunkSeq: chunk.chunkSeq,
          chunkDigest: chunk.chunkDigest,
          revision: 1,
        }));
      } else if (existing.chunkDigest === chunk.chunkDigest) {
        skippedChunks += 1;
      } else {
        uploads.push(Object.freeze({
          day: localDay.day,
          chunkId: chunk.chunkId,
          stream: chunk.stream,
          chunkSeq: chunk.chunkSeq,
          chunkDigest: chunk.chunkDigest,
          revision: existing.revision + 1,
        }));
      }
    }
    for (const chunkId of manifestChunks.keys()) {
      if (!localChunkIds.has(chunkId)
          && orphanChunkIds.length < MAX_ORPHAN_CHUNK_IDS) {
        orphanChunkIds.push(chunkId);
      }
    }
  }
  return Object.freeze({
    uploads: Object.freeze(uploads),
    skippedChunks,
    orphanChunkIds: Object.freeze(orphanChunkIds),
  });
}

/**
 * The consent record the approve-once flow persists and every chunk carries.
 */
export function telemetryV1RequiredConsent() {
  return Object.freeze({
    telemetrySchemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    fieldDictionaryVersion: TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  });
}
