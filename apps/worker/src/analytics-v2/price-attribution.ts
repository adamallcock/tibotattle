/**
 * analytics-v2 price attribution (K-PERCARD, engine v2 design section 5.2):
 * which price cards priced each owner-day, and the exact per-event price
 * inputs a later kernel reprices them from.
 *
 * The prepared-day observer. compute-owner.ts hands every owner-day it
 * prepared (and will store) to attributeAnalyticsV2DayPrices with the day's
 * usage occurrences and the kernel's own daily values. For each usage
 * occurrence it projects the stored record onto exactly the fields the
 * vendored buildPricingEvent reads (provider, modelId, billingSurface,
 * speedMode, apiServiceTier, reasoningEffort, the six token components,
 * totalInputContextTokens and the event time), and prices THAT projection
 * through the vendored buildPricingEvent and byte-identical GCP fast pricer: the
 * same path the kernel's daily fold takes (priceChunkUsageRecord ->
 * buildPricingEvent -> priceTelemetryUsageEvent, v11-daily-projection-values
 * .ts). So the stored projection is proven sufficient on every run.
 *
 * Fail-closed consistency check: the per-event results, folded per
 * (provider, modelId) cell exactly as the kernel folds them (unshapeable and
 * unpriced events count unpriced with no cost; the 200 lexically first cells
 * are kept and the rest are the omitted subtotal), must equal the kernel's
 * daily pricing block for every cell, the omitted subtotal and the total,
 * and the event count must equal the day's usage count. Any difference is a
 * defect: ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH ends the run, nothing is
 * written.
 *
 * What is recorded per owner-day (analytics_v2_owner_day_price):
 * - the price basis: every card id any event's pricing selected, sorted (the
 *   store maps it to the kernel's card refs and a deduplicated basis id);
 * - the usage, unpriced (including unshapeable) and partially priced event
 *   counts;
 * - the price inputs: one canonical document per owner-day (codec below),
 *   holding each event's projection and the result this kernel gave it (its
 *   cost as the daily fold counted it, its status and the cards it
 *   selected), deflated, with the sha256 of the canonical text. A later
 *   kernel's transition proof (price-transition.ts) reprices exactly these.
 *
 * Content-free: the projection holds names from the closed wire grammar
 * ([A-Za-z0-9._:-], 1 to 64 characters), integer token counts and an event
 * time; no prompt, path, session or account identifier. A name outside the
 * grammar, or a count that is not a non-negative safe integer, cannot be
 * stored and fails the run (ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE)
 * rather than be dropped or renamed.
 *
 * Pure apart from WebCrypto hashing and the Web Compression Streams; no I/O.
 */
import { canonicalJson } from "../canonical-json";
import { fastPriceTelemetryUsageEvent as priceTelemetryUsageEvent } from "./fast-pricer";
import { sha256Hex } from "../crypto";
import {
  APP_OFFICIAL_PRICE_CARDS,
  buildPricingEvent,
  type EffectiveTelemetryOccurrence,
} from "../../vendor/analytics-d43c8f92/entry";

/** Version of the projection below: what buildPricingEvent reads. A kernel that reads more is a new version. */
export const ANALYTICS_V2_PRICE_PROJECTION_VERSION = "analytics-v2-price-input-v1" as const;
/** Canonical JSON (canonical-json.ts) of the inputs document, deflate-raw, base64 in transit, bytea at rest. */
export const ANALYTICS_V2_PRICE_INPUTS_CODEC = "deflate-raw-canonical-json-v1" as const;
/** The card-set digest method (analytics_v2_kernel_prices.cards_sha256 and the price-basis digests). */
export const ANALYTICS_V2_PRICE_CARDS_METHOD = "analytics-v2-price-cards-v1" as const;
/** The kernel daily fold's lexical cell bound (v11-daily-projection-values.ts MAX_V11_DAILY_MODEL_CELLS). */
const DAILY_MODEL_CELLS = 200;
/** One owner-day holds at most the day backstop's occurrences (resources.ts). */
export const ANALYTICS_V2_MAX_PRICE_INPUT_EVENTS = 250_000;
/** Inflated document bound: generous for 250,000 events, a corrupt row cannot exhaust the heap. */
const MAX_INPUTS_TEXT_BYTES = 256 * 1024 * 1024;
/** Cards per kernel (the d43c8f92 registry has 178). */
export const ANALYTICS_V2_MAX_KERNEL_CARDS = 4_096;

/** Per-event pricing status, as stored. 0 and 1 both count as unpriced in the daily fold. */
export const ANALYTICS_V2_PRICE_STATUS = Object.freeze({
  /** buildPricingEvent returned null (no token observation): the fold counts it unpriced. */
  unshapeable: 0,
  unpriced: 1,
  partiallyPriced: 2,
  fullyPriced: 3,
} as const);
export type AnalyticsV2PriceStatus = (typeof ANALYTICS_V2_PRICE_STATUS)[keyof typeof ANALYTICS_V2_PRICE_STATUS];

export type AnalyticsV2PriceErrorCode =
  | "ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH"
  | "ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE"
  | "ANALYTICS_V2_PRICE_INPUTS_CORRUPT"
  | "ANALYTICS_V2_PRICE_CARDS_INVALID";

/** A closed, content-free price-attribution failure: the run ends, nothing is written. */
export class AnalyticsV2PriceError extends Error {
  constructor(readonly code: AnalyticsV2PriceErrorCode) {
    super(code);
    this.name = "AnalyticsV2PriceError";
  }
}

const fail = (code: AnalyticsV2PriceErrorCode): never => { throw new AnalyticsV2PriceError(code); };

/** The wire grammar (round 7 name guard): the only names a projection may hold. */
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
/** A price card id (the d43c8f92 ids are at most 92 characters). */
export const ANALYTICS_V2_PRICE_CARD_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMPONENTS = ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens"] as const;

/** One usage event's pricing projection: exactly the fields buildPricingEvent reads. */
export interface AnalyticsV2PriceInput {
  readonly eventTimeMs: number;
  readonly provider: string;
  readonly modelId: string | null;
  readonly billingSurface: string | null;
  readonly speedMode: string | null;
  readonly apiServiceTier: string | null;
  readonly reasoningEffort: string | null;
  /** The six components in COMPONENTS order. */
  readonly components: readonly (number | null)[];
  /** The record's own totalInputContextTokens, or null (buildPricingEvent derives one from the components). */
  readonly totalInputContextTokens: number | null;
}

/** What one kernel's pricing gave one event, normalized as the daily fold counts it. */
export interface AnalyticsV2PricedEvent {
  /** 0 unless the event was partially or fully priced (the fold adds no cost for unpriced events). */
  readonly costNanousd: number;
  readonly status: AnalyticsV2PriceStatus;
  /** selectedPriceCardIds, sorted and unique. */
  readonly cardIds: readonly string[];
}

export interface AnalyticsV2PriceInputEvent {
  readonly input: AnalyticsV2PriceInput;
  readonly priced: AnalyticsV2PricedEvent;
}

/** The stored inputs of one owner-day, as the store writes them. */
export interface AnalyticsV2EncodedPriceInputs {
  readonly projectionVersion: typeof ANALYTICS_V2_PRICE_PROJECTION_VERSION;
  readonly codec: typeof ANALYTICS_V2_PRICE_INPUTS_CODEC;
  /** sha256 of the canonical (uncompressed) document text: the identity, independent of the codec. */
  readonly sha256: string;
  readonly events: number;
  /** The deflated document, base64. */
  readonly data: string;
}

/** One owner-day's attribution (contract.ts AnalyticsV2OwnerDayPriceRow without the owner and day). */
export interface AnalyticsV2DayPriceAttribution {
  readonly cardIds: readonly string[];
  readonly usageEvents: number;
  readonly unpricedEvents: number;
  readonly partiallyPricedEvents: number;
  readonly inputs: AnalyticsV2EncodedPriceInputs;
}

// ---------------------------------------------------------------------------
// Projection and pricing
// ---------------------------------------------------------------------------

function nameOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !TOKEN.test(value)) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  return value as string;
}

function countOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  return value as number;
}

/**
 * The projection of one stored usage record. buildPricingEvent maps an absent
 * component or context to null exactly as it maps null, so null stands for
 * both and repricing the projection is repricing the record.
 */
export function analyticsV2PriceInput(record: unknown): AnalyticsV2PriceInput {
  if (record === null || typeof record !== "object" || Array.isArray(record)) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  const rec = record as Record<string, unknown>;
  const eventTimeMs = typeof rec.eventTime === "string" ? Date.parse(rec.eventTime) : Number.NaN;
  if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs < 0) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  const provider = nameOrNull(rec.provider);
  if (provider === null) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  const components = rec.components;
  // buildPricingEvent drops a record whose components are not an object; so
  // does the projection (all six null, which buildPricingEvent also drops).
  const parts = components !== null && typeof components === "object" && !Array.isArray(components)
    ? COMPONENTS.map((key) => countOrNull((components as Record<string, unknown>)[key]))
    : COMPONENTS.map(() => null);
  return Object.freeze({
    eventTimeMs,
    provider: provider!,
    modelId: nameOrNull(rec.modelId),
    billingSurface: nameOrNull(rec.billingSurface),
    speedMode: nameOrNull(rec.speedMode),
    apiServiceTier: nameOrNull(rec.apiServiceTier),
    reasoningEffort: nameOrNull(rec.reasoningEffort),
    components: Object.freeze(parts),
    totalInputContextTokens: countOrNull(rec.totalInputContextTokens),
  });
}

/** The record buildPricingEvent reads, rebuilt from a projection. */
function pricingRecord(input: AnalyticsV2PriceInput): Record<string, unknown> {
  return {
    provider: input.provider,
    modelId: input.modelId,
    billingSurface: input.billingSurface,
    speedMode: input.speedMode,
    apiServiceTier: input.apiServiceTier,
    reasoningEffort: input.reasoningEffort,
    components: Object.fromEntries(COMPONENTS.map((key, index) => [key, input.components[index] ?? null])),
    totalInputContextTokens: input.totalInputContextTokens,
  };
}

/**
 * Price one projection with this bundle's kernel, normalized as the daily
 * fold counts it: an unshapeable or unpriced event has cost 0.
 */
export function priceAnalyticsV2Input(input: AnalyticsV2PriceInput): AnalyticsV2PricedEvent {
  const event = buildPricingEvent(pricingRecord(input), new Date(input.eventTimeMs).toISOString());
  if (event === null) return Object.freeze({ costNanousd: 0, status: ANALYTICS_V2_PRICE_STATUS.unshapeable, cardIds: Object.freeze([]) });
  const priced = priceTelemetryUsageEvent(event);
  const cardIds = [...new Set(priced.selectedPriceCardIds)].sort();
  for (const cardId of cardIds) if (!ANALYTICS_V2_PRICE_CARD_ID.test(cardId)) fail("ANALYTICS_V2_PRICE_CARDS_INVALID");
  if (priced.coverageStatus === "unpriced") {
    return Object.freeze({ costNanousd: 0, status: ANALYTICS_V2_PRICE_STATUS.unpriced, cardIds: Object.freeze(cardIds) });
  }
  if (!Number.isSafeInteger(priced.costNanousd) || priced.costNanousd < 0) fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
  const status = priced.coverageStatus === "fully_priced" ? ANALYTICS_V2_PRICE_STATUS.fullyPriced
    : priced.coverageStatus === "partially_priced" ? ANALYTICS_V2_PRICE_STATUS.partiallyPriced
      : fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
  return Object.freeze({ costNanousd: priced.costNanousd, status, cardIds: Object.freeze(cardIds) });
}

/** True when two results are the same price: cost, status and the exact card set. */
export function sameAnalyticsV2Price(left: AnalyticsV2PricedEvent, right: AnalyticsV2PricedEvent): boolean {
  return left.costNanousd === right.costNanousd && left.status === right.status
    && left.cardIds.length === right.cardIds.length && left.cardIds.every((cardId, index) => cardId === right.cardIds[index]);
}

// ---------------------------------------------------------------------------
// The stored document (codec)
// ---------------------------------------------------------------------------

/** [provider, modelId, billingSurface, speedMode, apiServiceTier, reasoningEffort] */
type KeyTuple = readonly [string, string | null, string | null, string | null, string | null, string | null];

const keyText = (key: KeyTuple): string => JSON.stringify(key);
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The canonical document text of `events`, in their order: `cards` (every
 * card id any event selected, sorted) and `keys` (the distinct name tuples,
 * sorted by their JSON text) are dictionaries the events index into.
 */
export function analyticsV2PriceInputsText(events: readonly AnalyticsV2PriceInputEvent[]): {
  readonly text: string; readonly cardIds: readonly string[];
} {
  if (!Array.isArray(events) || events.length > ANALYTICS_V2_MAX_PRICE_INPUT_EVENTS) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
  const cards = [...new Set(events.flatMap((event) => event.priced.cardIds))].sort(compareText);
  const cardIndex = new Map(cards.map((cardId, index) => [cardId, index]));
  const keyOf = (input: AnalyticsV2PriceInput): KeyTuple => [input.provider, input.modelId, input.billingSurface,
    input.speedMode, input.apiServiceTier, input.reasoningEffort];
  const keyTexts = [...new Set(events.map((event) => keyText(keyOf(event.input))))].sort(compareText);
  const keyIndex = new Map(keyTexts.map((text, index) => [text, index]));
  // Each event: [eventTimeMs, keyIndex, the six components, totalInputContextTokens, costNanousd, status, cardIndexes].
  const tuples = events.map(({ input, priced }) => [input.eventTimeMs, keyIndex.get(keyText(keyOf(input)))!,
    ...input.components, input.totalInputContextTokens, priced.costNanousd, priced.status,
    priced.cardIds.map((cardId) => cardIndex.get(cardId)!)]);
  const text = canonicalJson({ v: ANALYTICS_V2_PRICE_PROJECTION_VERSION, cards,
    keys: keyTexts.map((value) => JSON.parse(value) as unknown), events: tuples });
  return Object.freeze({ text, cardIds: Object.freeze(cards) });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Decode base64 (the store's transit form); ANALYTICS_V2_PRICE_INPUTS_CORRUPT when it is not. */
export function analyticsV2PriceInputsBytes(data: string): Uint8Array {
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) {
    fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string> {
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INPUTS_TEXT_BYTES) {
        await reader.cancel();
        return fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(joined);
  } catch (error) {
    if (error instanceof AnalyticsV2PriceError) throw error;
    return fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
}

/** Encode one owner-day's events (in reader order) for storage. */
export async function encodeAnalyticsV2PriceInputs(events: readonly AnalyticsV2PriceInputEvent[]): Promise<{
  readonly inputs: AnalyticsV2EncodedPriceInputs; readonly cardIds: readonly string[];
}> {
  const { text, cardIds } = analyticsV2PriceInputsText(events);
  return Object.freeze({
    inputs: Object.freeze({ projectionVersion: ANALYTICS_V2_PRICE_PROJECTION_VERSION, codec: ANALYTICS_V2_PRICE_INPUTS_CODEC,
      sha256: await sha256Hex(text), events: events.length, data: toBase64(await deflate(text)) }),
    cardIds,
  });
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCountOrNull = (value: unknown): boolean => value === null || isCount(value);
const isNameOrNull = (value: unknown): boolean => value === null || (typeof value === "string" && TOKEN.test(value));

/**
 * Decode stored inputs: inflate, check the sha256 of the canonical text, the
 * closed shape and canonical form (re-encoding must give the same text), the
 * dictionaries' order and every index. Anything else is
 * ANALYTICS_V2_PRICE_INPUTS_CORRUPT, never a partial result.
 */
export async function decodeAnalyticsV2PriceInputs(stored: {
  readonly projectionVersion: string; readonly codec: string; readonly sha256: string; readonly events: number;
  readonly bytes: Uint8Array;
}): Promise<{ readonly events: readonly AnalyticsV2PriceInputEvent[]; readonly cardIds: readonly string[] }> {
  if (stored.projectionVersion !== ANALYTICS_V2_PRICE_PROJECTION_VERSION || stored.codec !== ANALYTICS_V2_PRICE_INPUTS_CODEC
      || typeof stored.sha256 !== "string" || !SHA256.test(stored.sha256) || !isCount(stored.events)
      || stored.events > ANALYTICS_V2_MAX_PRICE_INPUT_EVENTS || !(stored.bytes instanceof Uint8Array)) {
    fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
  const text = await inflate(stored.bytes);
  if (await sha256Hex(text) !== stored.sha256) fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)
      || Object.keys(document).sort().join(",") !== "cards,events,keys,v" || document.v !== ANALYTICS_V2_PRICE_PROJECTION_VERSION
      || !Array.isArray(document.cards) || !Array.isArray(document.keys) || !Array.isArray(document.events)
      || document.events.length !== stored.events) {
    fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
  const cards = document.cards as unknown[];
  const keys = document.keys as unknown[];
  for (const [index, cardId] of cards.entries()) {
    if (typeof cardId !== "string" || !ANALYTICS_V2_PRICE_CARD_ID.test(cardId)
        || (index > 0 && compareText(cards[index - 1] as string, cardId) >= 0)) fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  }
  for (const [index, key] of keys.entries()) {
    if (!Array.isArray(key) || key.length !== 6 || typeof key[0] !== "string" || !TOKEN.test(key[0])
        || !key.slice(1).every(isNameOrNull)
        || (index > 0 && compareText(JSON.stringify(keys[index - 1]), JSON.stringify(key)) >= 0)) {
      fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
    }
  }
  const events = (document.events as unknown[]).map((value): AnalyticsV2PriceInputEvent => {
    const tuple = value as unknown[];
    if (!Array.isArray(tuple) || tuple.length !== 12 || !isCount(tuple[0]) || !isCount(tuple[1]) || tuple[1] >= keys.length
        || !tuple.slice(2, 9).every(isCountOrNull) || !isCount(tuple[9])
        || !(Object.values(ANALYTICS_V2_PRICE_STATUS) as unknown[]).includes(tuple[10]) || !Array.isArray(tuple[11])) {
      fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
    }
    const indexes = tuple[11] as unknown[];
    if (!indexes.every((index, at) => isCount(index) && index < cards.length && (at === 0 || (indexes[at - 1] as number) < index))) {
      fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
    }
    const key = keys[tuple[1] as number] as KeyTuple;
    const status = tuple[10] as AnalyticsV2PriceStatus;
    if ((status <= ANALYTICS_V2_PRICE_STATUS.unpriced && tuple[9] !== 0)
        || (status === ANALYTICS_V2_PRICE_STATUS.unshapeable && indexes.length !== 0)) fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
    return Object.freeze({
      input: Object.freeze({ eventTimeMs: tuple[0] as number, provider: key[0], modelId: key[1], billingSurface: key[2],
        speedMode: key[3], apiServiceTier: key[4], reasoningEffort: key[5],
        components: Object.freeze(tuple.slice(2, 8) as (number | null)[]), totalInputContextTokens: tuple[8] as number | null }),
      priced: Object.freeze({ costNanousd: tuple[9] as number, status,
        cardIds: Object.freeze(indexes.map((index) => cards[index as number] as string)) }),
    });
  });
  const reencoded = analyticsV2PriceInputsText(events);
  if (reencoded.text !== text) fail("ANALYTICS_V2_PRICE_INPUTS_CORRUPT");
  return Object.freeze({ events: Object.freeze(events), cardIds: reencoded.cardIds });
}

// ---------------------------------------------------------------------------
// The prepared-day observer
// ---------------------------------------------------------------------------

interface CellSum { usageEvents: number; known: bigint; full: number; partial: number; unpriced: number }

const emptySum = (): CellSum => ({ usageEvents: 0, known: 0n, full: 0, partial: 0, unpriced: 0 });

function add(sum: CellSum, priced: AnalyticsV2PricedEvent): void {
  sum.usageEvents += 1;
  if (priced.status === ANALYTICS_V2_PRICE_STATUS.fullyPriced) { sum.full += 1; sum.known += BigInt(priced.costNanousd); }
  else if (priced.status === ANALYTICS_V2_PRICE_STATUS.partiallyPriced) { sum.partial += 1; sum.known += BigInt(priced.costNanousd); }
  else sum.unpriced += 1;
}

function addSums(target: CellSum, source: CellSum): void {
  target.usageEvents += source.usageEvents; target.known += source.known; target.full += source.full;
  target.partial += source.partial; target.unpriced += source.unpriced;
}

function samePricing(value: unknown, sum: CellSum): boolean {
  const pricing = value as Record<string, unknown> | null;
  return pricing !== null && typeof pricing === "object" && pricing.knownNanousd === sum.known.toString()
    && pricing.fullyPriced === sum.full && pricing.partiallyPriced === sum.partial && pricing.unpriced === sum.unpriced;
}

/**
 * The consistency check: `events` folded as the kernel folds them must equal
 * the kernel's daily pricing block (`daily`, finalized or not) exactly.
 */
export function assertAnalyticsV2PricesMatchDaily(day: string, events: readonly AnalyticsV2PriceInputEvent[],
  daily: unknown): void {
  const value = daily as Record<string, unknown> | null;
  if (value === null || typeof value !== "object" || value.day !== day) fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
  const counts = value!.counts as Record<string, unknown> | null;
  if (counts === null || typeof counts !== "object" || counts.usage !== events.length) fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
  const cells = new Map<string, { provider: string; modelId: string; sum: CellSum }>();
  const total = emptySum();
  for (const { input, priced } of events) {
    // The kernel keys a cell by the canonical record's provider and modelId.
    const modelId = input.modelId ?? "";
    const key = JSON.stringify([input.provider, modelId]);
    let cell = cells.get(key);
    if (cell === undefined) { cell = { provider: input.provider, modelId, sum: emptySum() }; cells.set(key, cell); }
    add(cell.sum, priced);
    add(total, priced);
  }
  const sorted = [...cells.values()].sort((left, right) => left.provider < right.provider ? -1 : left.provider > right.provider ? 1
    : left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0);
  const kept = sorted.slice(0, DAILY_MODEL_CELLS);
  const omitted = emptySum();
  for (const cell of sorted.slice(DAILY_MODEL_CELLS)) addSums(omitted, cell.sum);
  const dailyCells = value!.cells as unknown[];
  const dailyOmitted = value!.omitted as Record<string, unknown> | null;
  if (!samePricing(value!.pricing, total) || !Array.isArray(dailyCells) || dailyCells.length !== kept.length
      || dailyOmitted === null || typeof dailyOmitted !== "object" || dailyOmitted.usageEvents !== omitted.usageEvents
      || !samePricing(dailyOmitted.pricing, omitted)) {
    fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
  }
  for (const [index, cell] of kept.entries()) {
    const stored = dailyCells[index] as Record<string, unknown> | null;
    if (stored === null || typeof stored !== "object" || stored.provider !== cell.provider || stored.modelId !== cell.modelId
        || stored.usageEvents !== cell.sum.usageEvents || !samePricing(stored.pricing, cell.sum)) {
      fail("ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH");
    }
  }
}

/**
 * The prepared-day observer: attribute one prepared owner-day's prices from
 * its usage occurrences (reader order) and check them against the kernel's
 * daily values for that day (see the module comment).
 */
export async function attributeAnalyticsV2DayPrices(input: {
  readonly day: string;
  readonly usage: readonly EffectiveTelemetryOccurrence[];
  readonly daily: unknown;
}): Promise<AnalyticsV2DayPriceAttribution> {
  const events: AnalyticsV2PriceInputEvent[] = [];
  let unpriced = 0, partial = 0;
  for (const row of input.usage) {
    if (row.recordJson === null) fail("ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE");
    const projection = analyticsV2PriceInput(JSON.parse(row.recordJson!) as unknown);
    const priced = priceAnalyticsV2Input(projection);
    if (priced.status <= ANALYTICS_V2_PRICE_STATUS.unpriced) unpriced += 1;
    else if (priced.status === ANALYTICS_V2_PRICE_STATUS.partiallyPriced) partial += 1;
    events.push(Object.freeze({ input: projection, priced }));
  }
  assertAnalyticsV2PricesMatchDaily(input.day, events, input.daily);
  const { inputs, cardIds } = await encodeAnalyticsV2PriceInputs(events);
  return Object.freeze({ cardIds, usageEvents: events.length, unpricedEvents: unpriced, partiallyPricedEvents: partial, inputs });
}

// ---------------------------------------------------------------------------
// The kernel's cards and price bases
// ---------------------------------------------------------------------------

/** One card as the store registers it: its id and the sha256 of its canonical JSON. */
export interface AnalyticsV2PriceCard {
  readonly cardId: string;
  readonly contentSha256: string;
}

export interface AnalyticsV2KernelPriceCards {
  /** Sorted by card id; ids unique. */
  readonly cards: readonly AnalyticsV2PriceCard[];
  /** analyticsV2PriceCardSetSha256 of `cards`. */
  readonly cardsSha256: string;
}

/** The digest of a card set (a kernel's cards, or one owner-day's price basis): id and content, by id. */
export async function analyticsV2PriceCardSetSha256(cards: readonly AnalyticsV2PriceCard[]): Promise<string> {
  return sha256Hex(canonicalJson([ANALYTICS_V2_PRICE_CARDS_METHOD,
    [...cards].sort((left, right) => compareText(left.cardId, right.cardId)).map((card) => [card.cardId, card.contentSha256])]));
}

/** Validate and digest a card list (the bundled registry's, or a spec's). */
export async function analyticsV2PriceCards(source: readonly unknown[]): Promise<AnalyticsV2KernelPriceCards> {
  if (!Array.isArray(source) || source.length === 0 || source.length > ANALYTICS_V2_MAX_KERNEL_CARDS) fail("ANALYTICS_V2_PRICE_CARDS_INVALID");
  const cards: AnalyticsV2PriceCard[] = [];
  const ids = new Set<string>();
  for (const card of source) {
    const id = (card as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !ANALYTICS_V2_PRICE_CARD_ID.test(id) || ids.has(id)) fail("ANALYTICS_V2_PRICE_CARDS_INVALID");
    ids.add(id as string);
    cards.push(Object.freeze({ cardId: id as string, contentSha256: await sha256Hex(canonicalJson(card)) }));
  }
  cards.sort((left, right) => compareText(left.cardId, right.cardId));
  return Object.freeze({ cards: Object.freeze(cards), cardsSha256: await analyticsV2PriceCardSetSha256(cards) });
}

let bundledCards: Promise<AnalyticsV2KernelPriceCards> | null = null;

/** The cards this bundle's kernel prices with (the vendored APP_OFFICIAL_PRICE_CARDS), computed once. */
export function analyticsV2KernelPriceCards(): Promise<AnalyticsV2KernelPriceCards> {
  bundledCards ??= analyticsV2PriceCards(APP_OFFICIAL_PRICE_CARDS as readonly unknown[]);
  return bundledCards;
}
