import {
  parseTelemetryV1Chunk,
  MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES,
  telemetryV1RecordAnchor,
  type TelemetryV1Chunk,
  type TelemetryV1Record,
  type TelemetryV1Stream,
  type TelemetryV1UsageEvent,
} from "./telemetry-v1";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  MAX_USAGE_CORRECTION_PAGE_BYTES,
  MAX_USAGE_CORRECTION_SOURCES,
  prepareUsageCorrectionSources,
  reconcilePreparedUsageCorrectionSources,
  type UsageCorrectionSource,
} from "./telemetry-usage-reconciliation";

/**
 * Provider-neutral correction data.  This module intentionally contains no
 * D1, PostgreSQL, R2, or prepared-statement type: an adapter compiles the
 * operation into its own atomic transaction after the operation has been
 * prepared and snapshotted.
 */

export const TELEMETRY_CORRECTION_WRITE_SCHEMA_VERSION =
  "telemetry-correction-write-v1" as const;

export type TelemetryCorrectionField =
  | "totalInputContextTokens"
  | "outputCombinedTokens"
  | "usedPercent"
  | "resetsAt"
  | "sessionUuid"
  | "record";

export type TelemetryCorrectionSourceFormat = "v1" | "v1.1" | "v1.2";

export type TelemetryCorrectionFieldStatus = "known" | "unknown" | "later-null" | "conflict";

export interface TelemetryCorrectionFieldOutcome {
  readonly occurrenceId: string;
  readonly field: TelemetryCorrectionField;
  readonly status: TelemetryCorrectionFieldStatus;
  /** Known values are retained here; unknown, later-null and conflict carry null. */
  readonly value: number | string | null;
  /** Format-specific evidence that produced this outcome. */
  readonly sourceFormats: readonly TelemetryCorrectionSourceFormat[];
  readonly sourceRecordDigests: readonly string[];
}

/**
 * A source row/revision fence is verified again by the provider adapter inside
 * the correction transaction.  The digest is a compact commitment to the
 * complete cross-format source snapshot; it is not authority by itself.
 */
export interface TelemetryCorrectionSourceFenceEntry {
  readonly format: TelemetryCorrectionSourceFormat;
  readonly sourceRowId: string;
  readonly sourceChunkId: string;
  readonly sourceManifestId: string | null;
  readonly occurrenceId: string;
  readonly sourceRevision: number;
  readonly chunkDigest: string;
  readonly recordDigest: string;
}

export interface TelemetryCorrectionSourceFence {
  readonly snapshotDigest: string;
  readonly entries: readonly TelemetryCorrectionSourceFenceEntry[];
}

export interface TelemetryDerivedInvalidation {
  readonly kind: "telemetry-correction";
  readonly participantId: string;
  readonly deviceId: string;
  readonly stream: TelemetryV1Stream;
  /** Exact affected source days; never a whole-device/day winner selection. */
  readonly observedDays: readonly string[];
  readonly occurrenceIds: readonly string[];
  readonly predecessorChunkId: string;
  readonly replacementChunkId: string;
  readonly reason: "accepted-correction";
}

export interface TelemetryCorrectionWriteOperation {
  readonly schemaVersion: typeof TELEMETRY_CORRECTION_WRITE_SCHEMA_VERSION;
  readonly participantId: string;
  readonly deviceId: string;
  readonly stream: TelemetryV1Stream;
  readonly chunkDay: string;
  readonly chunkSeq: number;
  readonly predecessor: {
    readonly chunkId: string;
    readonly revision: number;
    readonly chunkDigest: string;
  };
  readonly claim: {
    readonly uploadAuthorizationId: string;
    /** Exact lease returned by the one-use claim; never reread by an adapter. */
    readonly leaseExpiresAt: string;
  };
  readonly sourceFence: TelemetryCorrectionSourceFence;
  readonly replacement: {
    readonly chunkId: string;
    readonly objectKey: string;
    readonly envelopeDigest: string;
    readonly chunk: TelemetryV1Chunk;
    readonly createdAt: string;
  };
  readonly outcomes: readonly TelemetryCorrectionFieldOutcome[];
  readonly invalidation: TelemetryDerivedInvalidation;
}

export interface TelemetryCorrectionPreparationInput {
  readonly participantId: string;
  readonly deviceId: string;
  readonly stream: TelemetryV1Stream;
  readonly predecessor: TelemetryCorrectionWriteOperation["predecessor"];
  readonly claim: TelemetryCorrectionWriteOperation["claim"];
  readonly replacement: TelemetryCorrectionWriteOperation["replacement"];
  readonly sourceFence: TelemetryCorrectionSourceFence;
  /** Cross-format evidence for the exact occurrence set being corrected. */
  readonly sources: readonly UsageCorrectionSource[];
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const FIELDS = new Set<TelemetryCorrectionField>([
  "totalInputContextTokens", "outputCombinedTokens", "usedPercent", "resetsAt", "sessionUuid", "record",
]);
const STREAMS = new Set<TelemetryV1Stream>(["usage", "quota", "session"]);
const FORMATS = new Set<TelemetryCorrectionSourceFormat>(["v1", "v1.1", "v1.2"]);
const SOURCE_FORMATS = new Set<UsageCorrectionSource["format"]>(["v1", "v11", "v12"]);
const OBJECT_KEY = /^[A-Za-z0-9._:/-]{1,512}$/u;

function fail(): never {
  throw new TypeError("Telemetry correction operation is invalid");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) fail();
}

function sourceFormat(value: UsageCorrectionSource["format"]): TelemetryCorrectionSourceFormat {
  return value === "v1" ? "v1" : value === "v11" ? "v1.1" : "v1.2";
}

function sourceFenceDigestInput(entries: readonly TelemetryCorrectionSourceFenceEntry[]): readonly unknown[] {
  return [...entries].sort((a, b) => {
    const left = `${a.format}\u0000${a.sourceRowId}\u0000${a.occurrenceId}`;
    const right = `${b.format}\u0000${b.sourceRowId}\u0000${b.occurrenceId}`;
    return left < right ? -1 : left > right ? 1 : 0;
  }).map((entry) => ({
    format: entry.format,
    sourceRowId: entry.sourceRowId,
    sourceChunkId: entry.sourceChunkId,
    sourceManifestId: entry.sourceManifestId,
    occurrenceId: entry.occurrenceId,
    sourceRevision: entry.sourceRevision,
    chunkDigest: entry.chunkDigest,
    recordDigest: entry.recordDigest,
  }));
}

export function telemetryCorrectionSourceFenceDigestInput(
  entries: readonly TelemetryCorrectionSourceFenceEntry[],
): string {
  return canonicalJson(sourceFenceDigestInput(entries));
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) fail();
  return value;
}

function objectKey(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_KEY.test(value)) fail();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail();
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}

function day(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) fail();
  return value;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail();
  return value as number;
}

const utf8 = new TextEncoder();
const MAX_REPLACEMENT_DEPTH = 16;
const MAX_REPLACEMENT_NODES = 16_384;

interface ReplacementSnapshotBudget {
  bytes: number;
  nodes: number;
  active: WeakSet<object>;
}

function replacementBudgetBytes(budget: ReplacementSnapshotBudget, value: string | number | boolean | null): void {
  const bytes = typeof value === "string" ? utf8.encode(value).byteLength
    : value === null ? 4 : typeof value === "boolean" ? 5 : 24;
  budget.bytes += bytes;
  if (budget.bytes > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES) fail();
}

/** Clone only a bounded JSON-shaped tree; accessors, cycles, and hidden array
 * properties are rejected before the parsed replacement can reach an await. */
function boundedReplacementSnapshot(value: unknown, budget: ReplacementSnapshotBudget, depth = 0): unknown {
  if (depth > MAX_REPLACEMENT_DEPTH) fail();
  budget.nodes += 1;
  if (budget.nodes > MAX_REPLACEMENT_NODES) fail();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    replacementBudgetBytes(budget, value);
    return value;
  }
  if (typeof value !== "object") fail();
  if (budget.active.has(value)) fail();
  budget.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 200) fail();
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail();
      return keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
        return boundedReplacementSnapshot(descriptor.value, budget, depth + 1);
      });
    }
    const keys = Object.keys(value);
    if (keys.length > 64) fail();
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (key.length > 512) fail();
      replacementBudgetBytes(budget, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
      output[key] = boundedReplacementSnapshot(descriptor.value, budget, depth + 1);
    }
    return output;
  } finally {
    budget.active.delete(value);
  }
}

function snapshotReplacementChunk(value: unknown): TelemetryV1Chunk {
  try {
    const clone = boundedReplacementSnapshot(value, { bytes: 0, nodes: 0, active: new WeakSet() });
    if (utf8.encode(canonicalJson(clone)).byteLength > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES) fail();
    if (!record(clone)) fail();
    return parseTelemetryV1Chunk({
      schemaVersion: clone.schemaVersion,
      chunkId: clone.chunkId,
      chunkRevision: clone.chunkRevision,
      chunkDigest: clone.chunkDigest,
      parserVersion: clone.parserVersion,
      consent: clone.consent,
      records: clone.records,
    });
  } catch {
    fail();
  }
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotSourceFence(value: unknown): TelemetryCorrectionSourceFence {
  if (!record(value)) fail();
  exactKeys(value, ["snapshotDigest", "entries"]);
  const snapshotDigest = digest(value.snapshotDigest);
  if (!Array.isArray(value.entries) || value.entries.length < 1
      || value.entries.length > MAX_USAGE_CORRECTION_SOURCES * 3) fail();
  const entries = value.entries.map((entry): TelemetryCorrectionSourceFenceEntry => {
    if (!record(entry)) fail();
    exactKeys(entry, ["format", "sourceRowId", "sourceChunkId", "sourceManifestId", "occurrenceId",
      "sourceRevision", "chunkDigest", "recordDigest"]);
    const format = entry.format;
    if (typeof format !== "string" || !FORMATS.has(format as TelemetryCorrectionSourceFormat)) fail();
    const sourceManifestId = entry.sourceManifestId === null ? null : id(entry.sourceManifestId);
    return Object.freeze({
      format: format as TelemetryCorrectionSourceFormat,
      sourceRowId: id(entry.sourceRowId),
      sourceChunkId: id(entry.sourceChunkId),
      sourceManifestId,
      occurrenceId: id(entry.occurrenceId),
      sourceRevision: safeInteger(entry.sourceRevision, 0, 0x7fffffff),
      chunkDigest: digest(entry.chunkDigest),
      recordDigest: digest(entry.recordDigest),
    });
  });
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.format}\u0000${entry.sourceRowId}`;
    if (keys.has(key)) fail();
    keys.add(key);
  }
  return Object.freeze({ snapshotDigest, entries: Object.freeze(entries) });
}

function snapshotOutcome(value: unknown): TelemetryCorrectionFieldOutcome {
  if (!record(value)) fail();
  exactKeys(value, ["occurrenceId", "field", "status", "value", "sourceFormats", "sourceRecordDigests"]);
  const occurrenceId = id(value.occurrenceId);
  const field = value.field;
  if (typeof field !== "string" || !FIELDS.has(field as TelemetryCorrectionField)) fail();
  const status = value.status;
  if (status !== "known" && status !== "unknown" && status !== "later-null" && status !== "conflict") fail();
  const raw = value.value;
  if (raw !== null && typeof raw !== "string" && !Number.isSafeInteger(raw)) fail();
  if (status !== "known" && raw !== null) fail();
  if (!Array.isArray(value.sourceFormats) || value.sourceFormats.length < 1
      || value.sourceFormats.some((format) => typeof format !== "string"
        || !FORMATS.has(format as TelemetryCorrectionSourceFormat))) fail();
  if (!Array.isArray(value.sourceRecordDigests) || value.sourceRecordDigests.length < 1
      || value.sourceRecordDigests.some((entry) => !HEX64.test(String(entry)))) fail();
  return Object.freeze({
    occurrenceId,
    field: field as TelemetryCorrectionField,
    status,
    value: raw as number | string | null,
    sourceFormats: Object.freeze([...new Set(value.sourceFormats as TelemetryCorrectionSourceFormat[])]),
    sourceRecordDigests: Object.freeze([...new Set(value.sourceRecordDigests as string[])].sort()),
  });
}

function snapshotInvalidation(value: unknown, operation: {
  participantId: string;
  deviceId: string;
  stream: TelemetryV1Stream;
  predecessorChunkId: string;
  replacementChunkId: string;
}): TelemetryDerivedInvalidation {
  if (!record(value) || value.kind !== "telemetry-correction" || value.reason !== "accepted-correction"
      || value.participantId !== operation.participantId || value.deviceId !== operation.deviceId
      || value.stream !== operation.stream || value.predecessorChunkId !== operation.predecessorChunkId
      || value.replacementChunkId !== operation.replacementChunkId) fail();
  exactKeys(value, ["kind", "participantId", "deviceId", "stream", "observedDays", "occurrenceIds",
    "predecessorChunkId", "replacementChunkId", "reason"]);
  if (!Array.isArray(value.observedDays) || value.observedDays.length < 1
      || value.observedDays.some((item) => typeof item !== "string" || !DAY.test(item))) fail();
  if (!Array.isArray(value.occurrenceIds) || value.occurrenceIds.length < 1
      || value.occurrenceIds.some((item) => typeof item !== "string" || !ID.test(item))) fail();
  return Object.freeze({
    kind: "telemetry-correction",
    participantId: operation.participantId,
    deviceId: operation.deviceId,
    stream: operation.stream,
    observedDays: Object.freeze([...new Set(value.observedDays as string[])].sort()),
    occurrenceIds: Object.freeze([...new Set(value.occurrenceIds as string[])].sort()),
    predecessorChunkId: operation.predecessorChunkId,
    replacementChunkId: operation.replacementChunkId,
    reason: "accepted-correction",
  });
}

/**
 * Snapshot and validate a correction operation before an adapter waits for
 * I/O.  This is the single operation-level contract shared by D1 and
 * PostgreSQL; no provider-specific statement or row object can cross it.
 */
function snapshotTelemetryCorrectionWriteOperationInternal(
  value: TelemetryCorrectionWriteOperation,
  preparedChunk?: TelemetryV1Chunk,
): TelemetryCorrectionWriteOperation {
  if (!record(value) || value.schemaVersion !== TELEMETRY_CORRECTION_WRITE_SCHEMA_VERSION) fail();
  exactKeys(value, ["schemaVersion", "participantId", "deviceId", "stream", "chunkDay", "chunkSeq",
    "predecessor", "claim", "sourceFence", "replacement", "outcomes", "invalidation"]);
  const participantId = id(value.participantId);
  const deviceId = id(value.deviceId);
  const stream = value.stream;
  if (typeof stream !== "string" || !STREAMS.has(stream as TelemetryV1Stream)) fail();
  const chunkDay = day(value.chunkDay);
  const chunkSeq = safeInteger(value.chunkSeq, 0, 99_999);
  if (!record(value.predecessor) || !record(value.claim) || !record(value.replacement)) fail();
  exactKeys(value.predecessor, ["chunkId", "revision", "chunkDigest"]);
  exactKeys(value.claim, ["uploadAuthorizationId", "leaseExpiresAt"]);
  exactKeys(value.replacement, ["chunkId", "objectKey", "envelopeDigest", "chunk", "createdAt"]);
  const predecessorChunkId = id(value.predecessor.chunkId);
  const predecessorRevision = safeInteger(value.predecessor.revision, 1, 0x7fffffff);
  const predecessorDigest = digest(value.predecessor.chunkDigest);
  const uploadAuthorizationId = id(value.claim.uploadAuthorizationId);
  const leaseExpiresAt = instant(value.claim.leaseExpiresAt);
  const sourceFence = snapshotSourceFence(value.sourceFence);
  const replacementChunkId = id(value.replacement.chunkId);
  const replacementObjectKey = objectKey(value.replacement.objectKey);
  const envelopeDigest = digest(value.replacement.envelopeDigest);
  const createdAt = instant(value.replacement.createdAt);
  const chunk = preparedChunk ?? snapshotReplacementChunk(value.replacement.chunk);
  if (chunk.stream !== stream || chunk.chunkDay !== chunkDay || chunk.chunkSeq !== chunkSeq
      || chunk.chunkRevision !== predecessorRevision + 1 || chunk.chunkId !== value.replacement.chunk.chunkId
      || chunk.records.length < 1) fail();
  const occurrenceIds = chunk.records.map((item: TelemetryV1Record) =>
    telemetryV1RecordAnchor(stream, item).occurrenceId);
  if (new Set(occurrenceIds).size !== occurrenceIds.length) fail();
  if (!Array.isArray(value.outcomes) || value.outcomes.length < 1) fail();
  const outcomes = Object.freeze(value.outcomes.map(snapshotOutcome));
  const occurrenceSet = new Set(occurrenceIds);
  const outcomeKeys = new Set<string>();
  for (const outcome of outcomes) {
    if (!occurrenceSet.has(outcome.occurrenceId)) fail();
    const key = `${outcome.occurrenceId}\u0000${outcome.field}`;
    if (outcomeKeys.has(key)) fail();
    outcomeKeys.add(key);
  }
  const invalidation = snapshotInvalidation(value.invalidation, {
    participantId, deviceId, stream, predecessorChunkId, replacementChunkId,
  });
  if (invalidation.occurrenceIds.some((item) => !occurrenceSet.has(item))
      || invalidation.observedDays.some((item) => item !== chunkDay)) fail();
  return Object.freeze({
    schemaVersion: TELEMETRY_CORRECTION_WRITE_SCHEMA_VERSION,
    participantId, deviceId, stream, chunkDay, chunkSeq,
    predecessor: Object.freeze({ chunkId: predecessorChunkId, revision: predecessorRevision, chunkDigest: predecessorDigest }),
    claim: Object.freeze({ uploadAuthorizationId, leaseExpiresAt }),
    sourceFence,
    replacement: Object.freeze({
      chunkId: replacementChunkId, objectKey: replacementObjectKey, envelopeDigest,
      chunk: freezeSnapshot(chunk) as TelemetryV1Chunk, createdAt,
    }),
    outcomes,
    invalidation,
  });
}

export function snapshotTelemetryCorrectionWriteOperation(
  value: TelemetryCorrectionWriteOperation,
): TelemetryCorrectionWriteOperation {
  return snapshotTelemetryCorrectionWriteOperationInternal(value);
}

function assertUsageReplacementMatchesOutcomes(
  chunk: TelemetryV1Chunk,
  outcomes: readonly TelemetryCorrectionFieldOutcome[],
): void {
  const byOccurrence = new Map<string, TelemetryCorrectionFieldOutcome>();
  const expectedKeys = new Set<string>();
  for (const item of chunk.records) {
    const occurrenceId = telemetryV1RecordAnchor("usage", item).occurrenceId;
    const usage = item as TelemetryV1UsageEvent;
    const expected: readonly [TelemetryCorrectionField, number | null][] = [
      ["totalInputContextTokens", usage.totalInputContextTokens],
      ["outputCombinedTokens", usage.components.outputCombinedTokens],
    ];
    for (const [field] of expected) {
      expectedKeys.add(`${occurrenceId}\u0000${field}`);
    }
    expectedKeys.add(`${occurrenceId}\u0000record`);
  }
  if (outcomes.length !== expectedKeys.size) fail();
  for (const outcome of outcomes) {
    const key = `${outcome.occurrenceId}\u0000${outcome.field}`;
    if (!expectedKeys.has(key) || byOccurrence.has(key)) fail();
    byOccurrence.set(key, outcome);
  }
  for (const item of chunk.records) {
    const occurrenceId = telemetryV1RecordAnchor("usage", item).occurrenceId;
    const usage = item as TelemetryV1UsageEvent;
    const expected: readonly [TelemetryCorrectionField, number | null][] = [
      ["totalInputContextTokens", usage.totalInputContextTokens],
      ["outputCombinedTokens", usage.components.outputCombinedTokens],
    ];
    for (const [field, actual] of expected) {
      const outcome = byOccurrence.get(`${occurrenceId}\u0000${field}`);
      if (!outcome) fail();
      if (outcome.status === "known" ? actual !== outcome.value : actual !== null) fail();
    }
    const recordOutcome = byOccurrence.get(`${occurrenceId}\u0000record`);
    if (!recordOutcome
        || (recordOutcome.status === "known" ? recordOutcome.value !== canonicalJson(item)
          : recordOutcome.value !== null)) fail();
  }
}

/**
 * Prepare usage correction outcomes from the existing identity-aware
 * occurrence reconciler.  A known value is monotonic over later nulls;
 * contradictory known evidence remains an explicit conflict.  The source
 * page is copied before the first await so a caller cannot change the
 * operation while cross-format hashes are being computed.
 */
export async function prepareTelemetryCorrectionWriteOperation(
  input: TelemetryCorrectionPreparationInput,
): Promise<TelemetryCorrectionWriteOperation> {
  if (!record(input) || !Array.isArray(input.sources) || input.sources.length < 1) fail();
  exactKeys(input, ["participantId", "deviceId", "stream", "predecessor", "claim", "replacement", "sourceFence", "sources"]);
  if (input.sources.length > MAX_USAGE_CORRECTION_SOURCES) fail();
  const participantId = id(input.participantId);
  const deviceId = id(input.deviceId);
  if (input.stream !== "usage") fail();
  let sourceBytes = 0;
  const encoder = new TextEncoder();
  for (const source of input.sources) {
    if (!record(source) || typeof source.ownerScope !== "string"
        || typeof source.format !== "string" || typeof source.recordJson !== "string") fail();
    if (!SOURCE_FORMATS.has(source.format as UsageCorrectionSource["format"])) fail();
    sourceBytes += encoder.encode(source.recordJson).byteLength;
    if (sourceBytes > MAX_USAGE_CORRECTION_PAGE_BYTES) fail();
  }
  const sourceFence = snapshotSourceFence(input.sourceFence);
  const sources = Object.freeze(input.sources.map((source) => {
    exactKeys(source, ["ownerScope", "format", "recordJson"]);
    return Object.freeze({ ownerScope: source.ownerScope,
      format: source.format as UsageCorrectionSource["format"], recordJson: source.recordJson });
  }));
  const replacementChunk = snapshotReplacementChunk(input.replacement.chunk);
  const predecessor = Object.freeze({ ...input.predecessor });
  const claim = Object.freeze({ ...input.claim });
  const replacement = Object.freeze({
    ...input.replacement,
    chunk: replacementChunk,
  });
  const preparedSources = await prepareUsageCorrectionSources(participantId, sources);
  const reconciled = reconcilePreparedUsageCorrectionSources({ ownerScope: participantId, prepared: preparedSources });
  const assertions = preparedSources.map((prepared) => prepared.assertion);
  if (sourceFence.entries.length !== assertions.length) fail();
  const fenceCounts = new Map<string, number>();
  for (const fence of sourceFence.entries) {
    const key = `${fence.format}\u0000${fence.occurrenceId}\u0000${fence.recordDigest}`;
    fenceCounts.set(key, (fenceCounts.get(key) ?? 0) + 1);
  }
  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index]!;
    const key = `${sourceFormat(sources[index]!.format)}\u0000${assertion.occurrenceId}\u0000${assertion.recordDigest}`;
    const remaining = fenceCounts.get(key) ?? 0;
    if (remaining < 1) fail();
    fenceCounts.set(key, remaining - 1);
  }
  if ([...fenceCounts.values()].some((remaining) => remaining !== 0)) fail();
  const expectedFenceDigest = await sha256Hex(telemetryCorrectionSourceFenceDigestInput(sourceFence.entries));
  if (expectedFenceDigest !== sourceFence.snapshotDigest) fail();
  const formatsByOccurrence = new Map<string, Set<TelemetryCorrectionSourceFormat>>();
  assertions.forEach((assertion, index) => {
    const formats = formatsByOccurrence.get(assertion.occurrenceId) ?? new Set();
    formats.add(sourceFormat(sources[index]!.format));
    formatsByOccurrence.set(assertion.occurrenceId, formats);
  });
  const digestsByOccurrence = new Map<string, Set<string>>();
  for (const assertion of assertions) {
    const digests = digestsByOccurrence.get(assertion.occurrenceId) ?? new Set();
    digests.add(assertion.recordDigest);
    digestsByOccurrence.set(assertion.occurrenceId, digests);
  }
  const outcomes: TelemetryCorrectionFieldOutcome[] = [];
  for (const occurrence of reconciled) {
    const sourceFormats = [...(formatsByOccurrence.get(occurrence.occurrenceId) ?? new Set())];
    const sourceRecordDigests = [...(digestsByOccurrence.get(occurrence.occurrenceId) ?? new Set())];
    const fields: readonly [TelemetryCorrectionField, { status: "unknown" | "reported" | "conflict"; value: number | null }][] = [
      ["totalInputContextTokens", occurrence.totalInputContextTokens],
      ["outputCombinedTokens", occurrence.outputCombinedTokens],
    ];
    for (const [field, result] of fields) outcomes.push({
      occurrenceId: occurrence.occurrenceId,
      field,
      status: result.status === "reported" ? "known" : result.status === "unknown" ? "unknown" : "conflict",
      value: result.status === "reported" ? result.value : null,
      sourceFormats,
      sourceRecordDigests,
    });
    outcomes.push({
      occurrenceId: occurrence.occurrenceId,
      field: "record",
      status: occurrence.status === "compatible" ? "known" : "conflict",
      value: occurrence.status === "compatible" ? occurrence.effectiveLegacyRecord : null,
      sourceFormats,
      sourceRecordDigests,
    });
  }
  assertUsageReplacementMatchesOutcomes(replacement.chunk, outcomes);
  const occurrenceIds = reconciled.map((row) => row.occurrenceId);
  return snapshotTelemetryCorrectionWriteOperationInternal({
    schemaVersion: TELEMETRY_CORRECTION_WRITE_SCHEMA_VERSION,
    participantId,
    deviceId,
    stream: "usage",
    chunkDay: replacementChunk.chunkDay,
    chunkSeq: replacementChunk.chunkSeq,
    predecessor,
    claim,
    sourceFence,
    replacement,
    outcomes,
    invalidation: {
      kind: "telemetry-correction", participantId, deviceId, stream: "usage",
      observedDays: [replacementChunk.chunkDay], occurrenceIds,
      predecessorChunkId: predecessor.chunkId, replacementChunkId: replacement.chunkId,
      reason: "accepted-correction",
    },
  }, replacementChunk);
}
