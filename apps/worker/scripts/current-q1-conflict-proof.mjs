import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalTelemetryV11Json, parseTelemetryV11Record } from "@app-usagemonitor/telemetry-contract";

export const CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA = "current-q1-effective-history-guard-origin-v2";
export const CURRENT_Q1_CONFLICT_PAGE_SCHEMA = "current-q1-effective-conflict-page-proof-v1";
export const CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256 = "347f7674f3473ee7991aeecc83657c69e0506e0ddbe057b6f7ce48f39784b6d7";
export const CURRENT_Q1_QUOTA_ANALYSIS_SOURCE_SHA256 = "c8f938dbe1448c9757e74ab3d03102404a410799674f4df63d81509d9804abca";
export const CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL = "effective_history_guard_544";

const SOURCE_MODULE_PATH = fileURLToPath(new URL("../src/storage-effective-history.ts", import.meta.url));
const QUOTA_ANALYSIS_MODULE_PATH = fileURLToPath(new URL("../src/quota-analysis-v11.ts", import.meta.url));
const SOURCE_ERROR_MESSAGE = "STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE";
const EFFECTIVE_TELEMETRY_METHOD = "effective-telemetry-owner-day-v1";
const MAX_STACK_CHARS = 65_536;
const MAX_GUARD_STACK_FRAMES = 12;
const MAX_FRAME_PATH_CHARS = 4_096;
const MAX_FRAME_COORDINATE = 1_000_000;
const MAX_PAGE_ROWS = 200;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 1_250_000;
const MAX_SOURCE_KEYS = 256;
const HASH = /^[a-f0-9]{64}$/u;
const FRAME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ROW_KEYS = Object.freeze([
  "methodVersion", "stream", "participantId", "ownerDigest", "occurrenceId", "eventTime",
  "eventTimeConflict", "status", "sourceCount", "sourceFormats", "sourceRowIds", "sourceRecordKeys", "recordJson",
]);
const PAGE_KEYS = Object.freeze(["methodVersion", "stream", "participantId", "ownerDigest", "day", "rows", "next"]);
const ASSOCIATION_KEYS = Object.freeze([
  "sourceId", "sourceNamespace", "ownerDigest", "ownerRevision", "authorityEpoch", "methodVersion",
  "stream", "day", "after", "limit", "checkpoint",
]);
const CHECKPOINT_KEYS = Object.freeze(["keyDigest", "dependencyDigest", "method", "headDigest"]);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function validDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validCursor(value) {
  return value === null || (exactKeys(value, ["observedAtMs", "occurrenceId"])
    && Number.isSafeInteger(value.observedAtMs) && value.observedAtMs >= 0
    && typeof value.occurrenceId === "string" && TOKEN.test(value.occurrenceId));
}

function validAssociation(value) {
  if (!exactKeys(value, ASSOCIATION_KEYS) || !exactKeys(value.checkpoint, CHECKPOINT_KEYS)) return false;
  return value.sourceId === "gcp-fastpath-oracle"
    && value.sourceNamespace === "gcp-fastpath-oracle"
    && typeof value.ownerDigest === "string" && HASH.test(value.ownerDigest)
    && Number.isSafeInteger(value.ownerRevision) && value.ownerRevision >= 0
    && Number.isSafeInteger(value.authorityEpoch) && value.authorityEpoch >= 0
    && value.methodVersion === EFFECTIVE_TELEMETRY_METHOD
    && value.stream === "usage"
    && validDay(value.day)
    && validCursor(value.after)
    && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= MAX_PAGE_ROWS
    && typeof value.checkpoint.keyDigest === "string" && HASH.test(value.checkpoint.keyDigest)
    && typeof value.checkpoint.dependencyDigest === "string" && HASH.test(value.checkpoint.dependencyDigest)
    && typeof value.checkpoint.method === "string" && /^[A-Za-z0-9._:-]{1,2048}$/u.test(value.checkpoint.method)
    && typeof value.checkpoint.headDigest === "string" && HASH.test(value.checkpoint.headDigest);
}

function associationsEqual(left, right) {
  if (!validAssociation(left) || !validAssociation(right)) return false;
  return left.sourceId === right.sourceId
    && left.sourceNamespace === right.sourceNamespace
    && left.ownerDigest === right.ownerDigest
    && left.ownerRevision === right.ownerRevision
    && left.authorityEpoch === right.authorityEpoch
    && left.methodVersion === right.methodVersion
    && left.stream === right.stream
    && left.day === right.day
    && left.limit === right.limit
    && ((left.after === null && right.after === null)
      || (left.after !== null && right.after !== null
        && left.after.observedAtMs === right.after.observedAtMs
        && left.after.occurrenceId === right.after.occurrenceId))
    && left.checkpoint.keyDigest === right.checkpoint.keyDigest
    && left.checkpoint.dependencyDigest === right.checkpoint.dependencyDigest
    && left.checkpoint.method === right.checkpoint.method
    && left.checkpoint.headDigest === right.checkpoint.headDigest;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  if (!value || typeof value !== "object") return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  const parts = [];
  for (const key of keys.sort()) {
    const encoded = canonicalJson(value[key]);
    if (encoded === null) return null;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

/** Match the reader's deduplicated provenance sets to their actual source keys.
 * Direct v1/v11 keys carry row IDs; correction-history keys carry history IDs
 * but deliberately do not populate sourceRowIds; typed v12 keys also have no
 * direct row ID. */
function validSourceProvenance(row) {
  if (!Array.isArray(row.sourceFormats) || row.sourceFormats.length < 1 || row.sourceFormats.length > 3
      || row.sourceFormats.some((format) => !["v1", "v11", "v12"].includes(format))
      || new Set(row.sourceFormats).size !== row.sourceFormats.length
      || row.sourceFormats.some((format, index) => index > 0 && row.sourceFormats[index - 1] >= format)
      || !Array.isArray(row.sourceRowIds) || row.sourceRowIds.length > MAX_SOURCE_KEYS
      || row.sourceRowIds.some((id) => !Number.isSafeInteger(id) || id < 1)
      || row.sourceRowIds.some((id, index) => index > 0 && row.sourceRowIds[index - 1] >= id)
      || !Array.isArray(row.sourceRecordKeys) || row.sourceRecordKeys.length < 1
      || row.sourceRecordKeys.length > MAX_SOURCE_KEYS
      || row.sourceRecordKeys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 512 || key.includes("\0"))
      || row.sourceRecordKeys.some((key, index) => index > 0 && row.sourceRecordKeys[index - 1] >= key)) return false;

  const formats = new Set();
  const directIds = new Set();
  for (const key of row.sourceRecordKeys) {
    const typed = /^(v1|v11|v12):/u.exec(key);
    if (!typed) return false;
    const format = typed[1];
    let sourceId;
    let direct = false;
    if (format === "v12") {
      sourceId = /^v12:record:([1-9][0-9]*)$/u.exec(key)?.[1];
    } else if (format === "v1") {
      const directId = /^v1:([1-9][0-9]*)$/u.exec(key)?.[1];
      const historyId = /^v1:history:([1-9][0-9]*)$/u.exec(key)?.[1];
      sourceId = directId ?? historyId;
      direct = directId !== undefined;
    } else {
      const directId = /^v11:([1-9][0-9]*)$/u.exec(key)?.[1];
      const historyId = /^v11:history:([1-9][0-9]*)$/u.exec(key)?.[1];
      sourceId = directId ?? historyId;
      direct = directId !== undefined;
    }
    if (!sourceId) return false;
    const numericId = Number(sourceId);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return false;
    formats.add(format);
    if (direct) directIds.add(numericId);
  }

  const expectedFormats = [...formats].sort();
  const expectedRowIds = [...directIds].sort((left, right) => left - right);
  return row.sourceCount >= row.sourceRecordKeys.length
    && row.sourceCount >= row.sourceFormats.length
    && row.sourceFormats.length === expectedFormats.length
    && row.sourceFormats.every((format, index) => format === expectedFormats[index])
    && row.sourceRowIds.length === expectedRowIds.length
    && row.sourceRowIds.every((id, index) => id === expectedRowIds[index])
    && (row.status !== "conflict" || (row.sourceCount >= 2 && row.sourceRecordKeys.length >= 2));
}

function parseV8Frame(frame) {
  if (typeof frame !== "string" || frame.length > MAX_FRAME_PATH_CHARS + 512
      || FRAME_CONTROL_CHARS.test(frame) || !frame.startsWith("    at ")) return null;
  const body = frame.slice(7);
  const opening = body.lastIndexOf(" (");
  let location = body;
  if (opening >= 0) {
    if (!body.endsWith(")") || /[()\r\n]/u.test(body.slice(0, opening))) return null;
    location = body.slice(opening + 2, -1);
  } else if (location.startsWith("async ")) {
    // V8 emits bare async file locations without a function-name wrapper.
    location = location.slice("async ".length);
  }
  const match = /^(.*):([1-9][0-9]*):([1-9][0-9]*)$/u.exec(location);
  if (!match || match[1].length < 1 || match[1].length > MAX_FRAME_PATH_CHARS
      || FRAME_CONTROL_CHARS.test(match[1])) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)
      || line > MAX_FRAME_COORDINATE || column > MAX_FRAME_COORDINATE) return null;
  return { modulePath: match[1], line, column };
}

function sourceMapContentMatches(server, modulePath, expectedHash) {
  const map = server.environments?.ssr?.moduleGraph?.getModuleById(modulePath)?.transformResult?.map;
  return Array.isArray(map?.sourcesContent) && map.sourcesContent.length === 1
    && typeof map.sourcesContent[0] === "string"
    && Buffer.byteLength(map.sourcesContent[0], "utf8") <= 262_144
    && sha256(map.sourcesContent[0]) === expectedHash;
}

function canonicalCallerPath(modulePath) {
  if (modulePath.startsWith("node:internal/")) return modulePath;
  let callerPath;
  if (modulePath.startsWith("/")) {
    callerPath = modulePath;
  } else if (modulePath.startsWith("file://")) {
    try {
      const url = new URL(modulePath);
      if (url.protocol !== "file:" || url.host !== "" || url.username !== "" || url.password !== ""
          || url.search !== "" || url.hash !== "") return null;
      callerPath = fileURLToPath(url);
      // Accept only the canonical local file URL spelling. This rejects URL
      // aliases such as dot segments, encoded separators, and remote hosts.
      if (pathToFileURL(callerPath).href !== modulePath) return null;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (callerPath.length < 1 || callerPath.length > MAX_FRAME_PATH_CHARS
      || FRAME_CONTROL_CHARS.test(callerPath)) return null;
  const canonicalPath = resolve(callerPath);
  return canonicalPath === resolve(SOURCE_MODULE_PATH) || canonicalPath === resolve(QUOTA_ANALYSIS_MODULE_PATH)
    ? null : canonicalPath;
}

function isCallerFrame(frame) {
  const parsed = parseV8Frame(frame);
  if (!parsed) return false;
  // Caller locations are bounded context only. Resolve local paths and
  // canonical file URLs so aliases of either origin module remain forbidden.
  return canonicalCallerPath(parsed.modulePath) !== null;
}

function parseCanonicalUsage(row, page, budget) {
  if (!exactKeys(row, ROW_KEYS)
      || row.methodVersion !== EFFECTIVE_TELEMETRY_METHOD || row.stream !== "usage"
      || row.participantId !== page.participantId || row.ownerDigest !== page.ownerDigest
      || typeof row.occurrenceId !== "string" || !TOKEN.test(row.occurrenceId)
      || typeof row.eventTimeConflict !== "boolean"
      || !Number.isSafeInteger(row.sourceCount) || row.sourceCount < 1 || row.sourceCount > 100_000
      || !validSourceProvenance(row)) return null;

  budget.bytes += Buffer.byteLength(row.participantId, "utf8") + Buffer.byteLength(row.ownerDigest, "utf8")
    + Buffer.byteLength(row.occurrenceId, "utf8")
    + row.sourceFormats.reduce((total, format) => total + Buffer.byteLength(format, "utf8"), 0)
    + row.sourceRecordKeys.reduce((total, key) => total + Buffer.byteLength(key, "utf8"), 0)
    + row.sourceRowIds.length * 8;
  if (budget.bytes > MAX_PAGE_BYTES) return null;

  if (row.status === "conflict") {
    return row.recordJson === null && row.eventTime === null && row.eventTimeConflict === true
      ? { status: "conflict" } : null;
  }
  if (row.status !== "compatible" || row.eventTimeConflict !== false
      || typeof row.eventTime !== "string" || row.eventTime.length > 64
      || typeof row.recordJson !== "string" || row.recordJson.length > MAX_RECORD_BYTES) return null;

  budget.bytes += Buffer.byteLength(row.recordJson, "utf8") + Buffer.byteLength(row.eventTime, "utf8");
  if (budget.bytes > MAX_PAGE_BYTES || row.eventTime.slice(0, 10) !== page.day) return null;
  const milliseconds = Date.parse(row.eventTime);
  if (!Number.isFinite(milliseconds)) return null;

  try {
    const parsed = JSON.parse(row.recordJson);
    const record = parseTelemetryV11Record("usage", parsed);
    if (record.schemaVersion !== "usage-event-v1.1" || record.eventId !== row.occurrenceId
        || record.eventTime !== row.eventTime || canonicalTelemetryV11Json(record) !== row.recordJson) return null;
  } catch {
    return null;
  }
  return { status: "compatible", milliseconds };
}

function validPage(page, association) {
  if (!exactKeys(page, PAGE_KEYS) || page.methodVersion !== EFFECTIVE_TELEMETRY_METHOD
      || page.stream !== "usage" || page.ownerDigest !== association.ownerDigest
      || page.day !== association.day || typeof page.participantId !== "string"
      || page.participantId.length < 1 || page.participantId.length > 256 || page.participantId.includes("\0")
      || !Array.isArray(page.rows) || page.rows.length > association.limit || page.rows.length > MAX_PAGE_ROWS
      || !validCursor(page.next)) return null;

  const budget = { bytes: Buffer.byteLength(page.participantId, "utf8") };
  const normalizedRows = [];
  let compatibleCount = 0;
  let conflictCount = 0;
  let previous = association.after === null ? null : {
    milliseconds: association.after.observedAtMs, occurrenceId: association.after.occurrenceId,
  };
  for (const row of page.rows) {
    const validated = parseCanonicalUsage(row, page, budget);
    if (!validated) return null;
    const current = validated.status === "compatible"
      ? { milliseconds: validated.milliseconds, occurrenceId: row.occurrenceId }
      : null;
    if (validated.status === "compatible") compatibleCount += 1;
    else conflictCount += 1;

    // A conflicted time has no canonical ordering value. Its exact page and
    // reader/checkpoint association remain bound by the private digests.
    if (!current) {
      normalizedRows.push(row);
      continue;
    }
    if (previous && (current.milliseconds < previous.milliseconds
        || (current.milliseconds === previous.milliseconds && current.occurrenceId <= previous.occurrenceId))) return null;
    previous = current;
    normalizedRows.push(row);
  }
  if (conflictCount < 1) return null;
  if (page.next !== null) {
    const last = normalizedRows.at(-1);
    if (!last || typeof last.eventTime !== "string" || page.rows.length !== association.limit
        || page.next.observedAtMs !== Date.parse(last.eventTime)
        || page.next.occurrenceId !== last.occurrenceId) return null;
  }
  budget.bytes += Buffer.byteLength(page.day, "utf8") + Buffer.byteLength(page.ownerDigest, "utf8")
    + Buffer.byteLength(page.methodVersion, "utf8") + Buffer.byteLength(page.stream, "utf8");
  if (budget.bytes > MAX_PAGE_BYTES) return null;
  const pageJson = canonicalJson(page);
  if (pageJson === null || Buffer.byteLength(pageJson, "utf8") > MAX_PAGE_BYTES) return null;
  return { pageSha256: sha256(pageJson), rowCount: page.rows.length, compatibleCount, conflictCount };
}

/** Prove the exact pinned guard-origin chain; caller frames remain bounded context. */
export function observeCurrentQ1EffectiveHistoryGuard(error, server) {
  try {
    if (error?.message !== SOURCE_ERROR_MESSAGE || typeof server?.ssrFixStacktrace !== "function"
        || server.config?.future?.removeSsrLoadModule === "warn"
        || !sourceMapContentMatches(server, SOURCE_MODULE_PATH, CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256)) return null;
    if (typeof error.stack !== "string" || error.stack.length > MAX_STACK_CHARS) return null;
    const holder = new Error(SOURCE_ERROR_MESSAGE);
    holder.stack = error.stack;
    server.ssrFixStacktrace(holder);
    if (typeof holder.stack !== "string" || holder.stack.length > MAX_STACK_CHARS) return null;
    const lines = holder.stack.split("\n");
    if (lines[0] !== `Error: ${SOURCE_ERROR_MESSAGE}`) return null;

    // Retain the existing closed two-frame form for current pure callers. It
    // accepts no caller tail, so an added frame cannot silently widen it.
    if (lines.length === 3) {
      const positions = lines.slice(1).map(parseV8Frame);
      if (positions.some((position) => position === null)
          || positions[0].modulePath !== SOURCE_MODULE_PATH || positions[1].modulePath !== SOURCE_MODULE_PATH
          || positions[0].line !== 26 || positions[1].line !== 544) return null;
      const originProofSha256 = sha256([
        CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
        "legacy-two-frame",
        CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
        `1:26:${positions[0].column}`,
        `1:544:${positions[1].column}`,
      ].join("\n"));
      return Object.freeze({
        schemaVersion: CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
        guardLabel: CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL,
        sourceContentSha256: CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
        originProofSha256,
      });
    }

    const frames = lines.slice(1);
    if (frames.length < 7 || frames.length > MAX_GUARD_STACK_FRAMES) return null;
    const [factoryFrame, guardFrame, arrayMapFrame, mapSetupFrame, quotaReducerFrame, finishFrame, ...callerFrames] = frames;
    if (arrayMapFrame !== "    at Array.map (<anonymous>)" || callerFrames.length < 1
        || callerFrames.some((frame) => !isCallerFrame(frame))) return null;
    const [factory, guard, mapSetup, quotaReducer, finish] = [
      factoryFrame, guardFrame, mapSetupFrame, quotaReducerFrame, finishFrame,
    ].map(parseV8Frame);
    if ([factory, guard, mapSetup, quotaReducer, finish].some((position) => position === null)
        || factory.modulePath !== SOURCE_MODULE_PATH || factory.line !== 26
        || guard.modulePath !== SOURCE_MODULE_PATH || guard.line !== 544
        || mapSetup.modulePath !== SOURCE_MODULE_PATH || mapSetup.line !== 543
        || quotaReducer.modulePath !== QUOTA_ANALYSIS_MODULE_PATH || quotaReducer.line !== 1447
        || finish.modulePath !== SOURCE_MODULE_PATH || finish.line !== 555
        || !sourceMapContentMatches(server, QUOTA_ANALYSIS_MODULE_PATH, CURRENT_Q1_QUOTA_ANALYSIS_SOURCE_SHA256)) return null;

    // Only these six ordered frames establish origin. Bounded callers are
    // validated above, excluded from the digest, and never exposed as proof.
    const originProofSha256 = sha256([
      CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
      "real-vite-origin-chain-v1",
      CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
      CURRENT_Q1_QUOTA_ANALYSIS_SOURCE_SHA256,
      `1:26:${factory.column}`,
      `1:544:${guard.column}`,
      "array-map",
      `1:543:${mapSetup.column}`,
      `2:1447:${quotaReducer.column}`,
      `1:555:${finish.column}`,
    ].join("\n"));
    return Object.freeze({
      schemaVersion: CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
      guardLabel: CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL,
      sourceContentSha256: CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
      originProofSha256,
    });
  } catch {
    return null;
  }
}

/** Validate one bounded current effective usage page without retaining its rows. */
export function validateCurrentQ1ConflictPageProof(input) {
  try {
    if (!exactKeys(input, ["page", "expectedAssociation", "observedAssociation"])) return null;
    const { page, expectedAssociation, observedAssociation } = input;
    if (!associationsEqual(expectedAssociation, observedAssociation)) return null;
    const validated = validPage(page, expectedAssociation);
    if (!validated) return null;
    const associationJson = canonicalJson(expectedAssociation);
    if (associationJson === null) return null;
    return Object.freeze({
      schemaVersion: CURRENT_Q1_CONFLICT_PAGE_SCHEMA,
      pageSha256: validated.pageSha256,
      associationSha256: sha256(associationJson),
      rowCount: validated.rowCount,
      compatibleCount: validated.compatibleCount,
      conflictCount: validated.conflictCount,
      compatibleRowsSchemaValid: true,
      compatibleRowsTimeValid: true,
      conflictFieldsNull: true,
    });
  } catch {
    return null;
  }
}
