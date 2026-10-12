import {
  canonicalTelemetryV11Json,
  canonicalTelemetryV12Json,
  parseTelemetryV12Record,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { parseStrictJson } from "./strict-json";
import {
  encodeTypedTelemetryRecord,
  typedTelemetryCanonicalRecords,
} from "./typed-telemetry-codec";
import type { TelemetryV1UsageEvent } from "./telemetry-v1";

/** Derived evidence only: never an upload contract, receipt, or source authority. */
export const USAGE_TOTAL_CORRECTION_METHOD = "usage-total-correction-v1";
export const MAX_USAGE_CORRECTION_SOURCES = 200;
export const MAX_USAGE_CORRECTION_RECORD_BYTES = 16_384;
export const MAX_USAGE_CORRECTION_PAGE_BYTES = 1_250_000;
const MAX_PAGE_BYTES = MAX_USAGE_CORRECTION_PAGE_BYTES;
const encoder = new TextEncoder();
export type UsageCorrectionFormat = "v1" | "v11" | "v12";
export type UsageTotalQualification = "unknown" | "reported" | "inconsistent";
export type UsageCorrectionErrorCode = "USAGE_CORRECTION_INVALID" | "USAGE_CORRECTION_LIMIT"
  | "USAGE_CORRECTION_SCOPE_MISMATCH" | "USAGE_CORRECTION_OCCURRENCE_MISMATCH"
  | "USAGE_CORRECTION_CONCURRENT" | "USAGE_CORRECTION_CLOSED";

export class UsageCorrectionError extends Error {
  constructor(readonly code: UsageCorrectionErrorCode) {
    super(code);
    this.name = "UsageCorrectionError";
  }
}

export interface UsageCorrectionInput {
  format: UsageCorrectionFormat;
  recordJson: string;
}

export type UsageCorrectionSource = UsageCorrectionInput & { ownerScope: string };

export interface UsageCorrectionAssertion {
  readonly methodVersion: typeof USAGE_TOTAL_CORRECTION_METHOD;
  readonly occurrenceId: string;
  readonly eventTime: string;
  readonly baseDigest: string;
  readonly recordDigest: string;
  readonly totalInputContextTokens: number | null;
  readonly outputCombinedTokens: number | null;
  readonly inputQualification: UsageTotalQualification;
  readonly outputQualification: UsageTotalQualification;
}

function fail(code: UsageCorrectionErrorCode = "USAGE_CORRECTION_INVALID"): never {
  throw new UsageCorrectionError(code);
}

const OWNER_SCOPE = /^[A-Za-z0-9._:-]{1,256}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

function assertOwnerScope(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OWNER_SCOPE.test(value)) fail();
}

function assertOccurrenceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OCCURRENCE_ID.test(value)) fail();
}

function recordBytes(raw: string): number {
  if (typeof raw !== "string") fail();
  // Check character length first to avoid allocating an oversized byte array.
  if (raw.length > MAX_USAGE_CORRECTION_RECORD_BYTES) fail("USAGE_CORRECTION_LIMIT");
  const size = encoder.encode(raw).length;
  if (size > MAX_USAGE_CORRECTION_RECORD_BYTES) fail("USAGE_CORRECTION_LIMIT");
  return size;
}

function qualify(total: number | null, components: readonly (number | null)[]): UsageTotalQualification {
  if (total === null) return "unknown";
  const lowerBound = components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return total < lowerBound || (components.every((value) => value !== null) && total !== lowerBound)
    ? "inconsistent" : "reported";
}

function parseUsage(input: UsageCorrectionInput): { canonical: string; legacy: TelemetryV1UsageEvent } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  recordBytes(input.recordJson);
  try {
    const value = parseStrictJson(input.recordJson);
    if (input.format === "v12") {
      const row = parseTelemetryV12Record("usage", value) as TelemetryV12UsageEvent;
      const { accountPlanAttribution: _attribution, boundaryFlags: _boundary,
        tieOrder: _order, cacheWriteTtl: _ttl, ...shared } = row;
      return { canonical: canonicalTelemetryV12Json(row),
        legacy: { ...shared, schemaVersion: "usage-event-v1.0" } };
    }
    const fields = encodeTypedTelemetryRecord(input.format, value);
    // Quota's v1 projection is lossy. It cannot use this occurrence join.
    if (fields.stream !== "usage") fail();
    const snapshot = typedTelemetryCanonicalRecords(fields);
    if (snapshot.legacy === null) fail();
    return { canonical: snapshot.canonicalRecord,
      legacy: JSON.parse(snapshot.legacy.canonicalRecord) as TelemetryV1UsageEvent };
  } catch {
    // No raw source strings or validator details enter correction diagnostics.
    fail();
  }
}

async function prepare(input: UsageCorrectionInput) {
  const parsed = parseUsage(input);
  const row = parsed.legacy;
  // Every other shared field participates, including outcome and all splits.
  // Removing just these two totals makes null-to-known repair comparable.
  const base = { ...row, totalInputContextTokens: null,
    components: { ...row.components, outputCombinedTokens: null } };
  const [baseDigest, recordDigest] = await Promise.all([
    sha256Hex(canonicalTelemetryV11Json(base)), sha256Hex(parsed.canonical),
  ]);
  const assertion: UsageCorrectionAssertion = Object.freeze({
    methodVersion: USAGE_TOTAL_CORRECTION_METHOD,
    occurrenceId: row.eventId, eventTime: row.eventTime, baseDigest, recordDigest,
    totalInputContextTokens: row.totalInputContextTokens,
    outputCombinedTokens: row.components.outputCombinedTokens,
    inputQualification: qualify(row.totalInputContextTokens, [row.components.inputUncachedTokens,
      row.components.inputCacheReadTokens, row.components.inputCacheWriteTokens]),
    outputQualification: qualify(row.components.outputCombinedTokens,
      [row.components.outputTextTokens, row.components.outputReasoningTokens]),
  });
  return { assertion, legacy: row };
}

interface PreparedUsageCorrection {
  readonly assertion: UsageCorrectionAssertion;
  readonly legacy: TelemetryV1UsageEvent;
}

function snapshotUsageCorrectionPage(
  ownerScope: string,
  sources: readonly UsageCorrectionSource[],
): readonly UsageCorrectionInput[] {
  if (!Array.isArray(sources)) fail();
  if (sources.length > MAX_USAGE_CORRECTION_SOURCES) fail("USAGE_CORRECTION_LIMIT");
  let bytes = 0;
  for (const source of sources) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) fail();
    if (source.ownerScope !== ownerScope) fail("USAGE_CORRECTION_SCOPE_MISMATCH");
    bytes += recordBytes(source.recordJson);
    if (bytes > MAX_PAGE_BYTES) fail("USAGE_CORRECTION_LIMIT");
  }
  // The returned values are primitives copied before the first await. A caller
  // may continue filling or reusing its page while canonical hashes run.
  return sources.map(({ format, recordJson }) => ({ format, recordJson }));
}

/** Validates a frozen wire family and hashes its canonical bytes without rewriting it.
 * A historically admitted, inconsistent total remains representable but unqualified.
 * Repository callers must independently prove stored source bytes and owner authority.
 */
export async function prepareUsageCorrectionAssertion(input: UsageCorrectionInput): Promise<UsageCorrectionAssertion> {
  return (await prepare(input)).assertion;
}

export interface ReconciledUsageTotal {
  readonly status: "unknown" | "reported" | "conflict";
  readonly value: number | null;
}

export interface ReconciledUsageOccurrence {
  readonly ownerScope: string;
  readonly occurrenceId: string;
  readonly status: "compatible" | "total_conflict" | "base_conflict";
  readonly sourceRecordDigests: readonly string[];
  readonly totalInputContextTokens: ReconciledUsageTotal;
  readonly outputCombinedTokens: ReconciledUsageTotal;
  /** An analytical projection only, never substituted into a canonical receipt.
   * Extension attribution/boundary/order/TTL evidence is deliberately not joined.
   */
  readonly effectiveLegacyRecord: string | null;
}

/**
 * One occurrence accumulated over any number of bounded source pages. The
 * caller must prove that all authoritative source units have been enumerated
 * before calling `close`; this type does not claim complete owner-day
 * coverage, generation activation, or source authority.
 */
export interface StreamingReconciledUsageOccurrence {
  readonly ownerScope: string;
  readonly occurrenceId: string;
  readonly eventTime: string | null;
  readonly eventTimeConflict: boolean;
  readonly sourceCount: number;
  readonly status: "compatible" | "total_conflict" | "base_conflict";
  readonly totalInputContextTokens: ReconciledUsageTotal;
  readonly outputCombinedTokens: ReconciledUsageTotal;
  /** An analytical projection only; it is emitted only by explicit `close`. */
  readonly effectiveLegacyRecord: string | null;
}

function reconcileTotal(assertions: readonly UsageCorrectionAssertion[], kind: "input" | "output"): ReconciledUsageTotal {
  let value: number | null = null;
  for (const assertion of assertions) {
    const total = kind === "input" ? assertion.totalInputContextTokens : assertion.outputCombinedTokens;
    const qualification = kind === "input" ? assertion.inputQualification : assertion.outputQualification;
    if (qualification === "inconsistent" || (total !== null && value !== null && total !== value)) {
      return Object.freeze({ status: "conflict", value: null });
    }
    if (total !== null) value = total;
  }
  return Object.freeze({ status: value === null ? "unknown" : "reported", value });
}

/** Bounded qualification primitive. This does not establish complete owner-day coverage,
 * activate a generation, admit an upload, or select a newest source family.
 */
export async function reconcileUsageCorrectionSources(input: {
  ownerScope: string;
  sources: readonly UsageCorrectionSource[];
}): Promise<readonly ReconciledUsageOccurrence[]> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  assertOwnerScope(input.ownerScope);
  const snapshots = snapshotUsageCorrectionPage(input.ownerScope, input.sources);
  const ownerScope = input.ownerScope;
  const groups = new Map<string, PreparedUsageCorrection[]>();
  // Sequential hashing keeps asynchronous work bounded as well as the input.
  for (const source of snapshots) {
    const prepared = await prepare(source);
    const rows = groups.get(prepared.assertion.occurrenceId) ?? [];
    rows.push(prepared);
    groups.set(prepared.assertion.occurrenceId, rows);
  }
  return Object.freeze([...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([occurrenceId, rows]): ReconciledUsageOccurrence => {
      const assertions = rows.map((row) => row.assertion);
      const sourceRecordDigests = Object.freeze([...new Set(assertions.map((row) => row.recordDigest))].sort());
      const baseConflict = new Set(assertions.map((row) => row.baseDigest)).size !== 1;
      const unknown = Object.freeze({ status: "conflict" as const, value: null });
      const totalInputContextTokens = baseConflict ? unknown : reconcileTotal(assertions, "input");
      const outputCombinedTokens = baseConflict ? unknown : reconcileTotal(assertions, "output");
      const status = baseConflict ? "base_conflict"
        : totalInputContextTokens.status === "conflict" || outputCombinedTokens.status === "conflict"
          ? "total_conflict" : "compatible";
      const row = rows[0]!.legacy;
      return Object.freeze({ ownerScope, occurrenceId, status, sourceRecordDigests,
        totalInputContextTokens, outputCombinedTokens,
        effectiveLegacyRecord: status !== "compatible" ? null : canonicalTelemetryV11Json({ ...row,
          totalInputContextTokens: totalInputContextTokens.value,
          components: { ...row.components, outputCombinedTokens: outputCombinedTokens.value } }),
      });
    }));
}

interface StreamingTotalState {
  status: ReconciledUsageTotal["status"];
  value: number | null;
}

function emptyStreamingTotal(): StreamingTotalState {
  return { status: "unknown", value: null };
}

function mergeStreamingTotal(
  state: StreamingTotalState,
  total: number | null,
  qualification: UsageTotalQualification,
): void {
  // Conflicts are monotonic: later nulls or matching values cannot erase one.
  if (state.status === "conflict") return;
  if (qualification === "inconsistent") {
    state.status = "conflict";
    state.value = null;
    return;
  }
  if (total === null) return;
  if (state.status === "reported" && state.value !== total) {
    state.status = "conflict";
    state.value = null;
    return;
  }
  state.status = "reported";
  state.value = total;
}

function freezeStreamingTotal(state: StreamingTotalState): ReconciledUsageTotal {
  return Object.freeze({ status: state.status, value: state.value });
}

function conflictStreamingTotal(): ReconciledUsageTotal {
  return Object.freeze({ status: "conflict" as const, value: null });
}

function freezeLegacyTemplate(row: TelemetryV1UsageEvent): TelemetryV1UsageEvent {
  return Object.freeze({ ...row, components: Object.freeze({ ...row.components }) });
}

class UsageCorrectionOccurrenceAccumulatorImpl {
  readonly #ownerScope: string;
  readonly #occurrenceId: string;
  #baseDigest: string | null = null;
  #template: TelemetryV1UsageEvent | null = null;
  #eventTime: string | null = null;
  #eventTimeConflict = false;
  #baseConflict = false;
  #inputTotal = emptyStreamingTotal();
  #outputTotal = emptyStreamingTotal();
  #sourceCount = 0;
  #appendInFlight = false;
  #closed = false;

  constructor(options: UsageCorrectionOccurrenceAccumulatorOptions) {
    assertOwnerScope(options?.ownerScope);
    assertOccurrenceId(options?.occurrenceId);
    this.#ownerScope = options.ownerScope;
    this.#occurrenceId = options.occurrenceId;
  }

  async append(page: readonly UsageCorrectionSource[]): Promise<void> {
    if (this.#closed) fail("USAGE_CORRECTION_CLOSED");
    if (this.#appendInFlight) fail("USAGE_CORRECTION_CONCURRENT");
    this.#appendInFlight = true;
    try {
      // Snapshot and validate the complete page before the first await. The
      // prepared page is bounded by the same 200-record/1.25 MB limits; it is
      // released after merging into the constant-size occurrence state.
      const snapshots = snapshotUsageCorrectionPage(this.#ownerScope, page);
      const prepared: PreparedUsageCorrection[] = [];
      for (const source of snapshots) {
        const row = await prepare(source);
        if (row.assertion.occurrenceId !== this.#occurrenceId) {
          fail("USAGE_CORRECTION_OCCURRENCE_MISMATCH");
        }
        prepared.push(row);
      }
      // Check the whole page before merging so a safe-integer overflow cannot
      // leave a partially applied page behind.
      if (prepared.length > Number.MAX_SAFE_INTEGER - this.#sourceCount) {
        fail("USAGE_CORRECTION_LIMIT");
      }
      for (const row of prepared) this.merge(row);
    } finally {
      this.#appendInFlight = false;
    }
  }

  close(): StreamingReconciledUsageOccurrence {
    if (this.#appendInFlight) fail("USAGE_CORRECTION_CONCURRENT");
    if (this.#closed) fail("USAGE_CORRECTION_CLOSED");
    if (this.#template === null || this.#baseDigest === null || this.#eventTime === null) fail();
    this.#closed = true;
    const totalInputContextTokens = this.#baseConflict
      ? conflictStreamingTotal() : freezeStreamingTotal(this.#inputTotal);
    const outputCombinedTokens = this.#baseConflict
      ? conflictStreamingTotal() : freezeStreamingTotal(this.#outputTotal);
    const status = this.#baseConflict ? "base_conflict"
      : totalInputContextTokens.status === "conflict" || outputCombinedTokens.status === "conflict"
        ? "total_conflict" : "compatible";
    return Object.freeze({
      ownerScope: this.#ownerScope,
      occurrenceId: this.#occurrenceId,
      eventTime: this.#eventTimeConflict ? null : this.#eventTime,
      eventTimeConflict: this.#eventTimeConflict,
      sourceCount: this.#sourceCount,
      status,
      totalInputContextTokens,
      outputCombinedTokens,
      effectiveLegacyRecord: status !== "compatible" ? null : canonicalTelemetryV11Json({
        ...this.#template,
        totalInputContextTokens: totalInputContextTokens.value,
        components: { ...this.#template.components, outputCombinedTokens: outputCombinedTokens.value },
      }),
    });
  }

  private merge(prepared: PreparedUsageCorrection): void {
    const { assertion, legacy } = prepared;
    if (this.#sourceCount === Number.MAX_SAFE_INTEGER) fail("USAGE_CORRECTION_LIMIT");
    this.#sourceCount += 1;
    if (this.#baseDigest === null) {
      this.#baseDigest = assertion.baseDigest;
      this.#template = freezeLegacyTemplate(legacy);
      this.#eventTime = assertion.eventTime;
    } else {
      if (this.#baseDigest !== assertion.baseDigest) this.#baseConflict = true;
      if (this.#eventTime !== assertion.eventTime) {
        this.#eventTimeConflict = true;
        this.#baseConflict = true;
      }
    }
    mergeStreamingTotal(this.#inputTotal, assertion.totalInputContextTokens,
      assertion.inputQualification);
    mergeStreamingTotal(this.#outputTotal, assertion.outputCombinedTokens,
      assertion.outputQualification);
  }
}

export interface UsageCorrectionOccurrenceAccumulatorOptions {
  readonly ownerScope: string;
  readonly occurrenceId: string;
}

export interface UsageCorrectionOccurrenceAccumulator {
  /**
   * Append one bounded source page. Pages may be appended indefinitely, but
   * only the current occurrence's constant-size state is retained. The caller
   * must enumerate and authorize all source units before `close`.
   */
  append(page: readonly UsageCorrectionSource[]): Promise<void>;
  /** Explicitly close a complete source group and emit its analytical row. */
  close(): StreamingReconciledUsageOccurrence;
}

export function createUsageCorrectionOccurrenceAccumulator(
  options: UsageCorrectionOccurrenceAccumulatorOptions,
): UsageCorrectionOccurrenceAccumulator {
  return new UsageCorrectionOccurrenceAccumulatorImpl(options);
}
