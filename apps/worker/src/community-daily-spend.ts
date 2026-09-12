import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { priceChunkUsageRecord } from "./quota-analysis-v1";
import { SERVER_PRICING_METHOD_VERSION } from "./server-pricing";
import { MAX_TELEMETRY_V1_CHUNK_RECORDS } from "./telemetry-v1";
import { MAX_V1_SOURCE_CHUNKS } from "./telemetry-v1-source-selection";

export const COMMUNITY_DAILY_SPEND_BASIS = "reported_usage_event_time_api_price_equivalent_v1";
export const COMMUNITY_DAILY_SPEND_PRICING_METHOD = SERVER_PRICING_METHOD_VERSION;
export const COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 = APP_PRICE_REGISTRY_MANIFEST.sha256;
// Bound the additional work of the entire cron pass, not each of its 24 days.
// Admission also bounds each chunk's canonical bytes. Eight chunks at a time
// avoid retaining a day's raw JSON or sorting its event corpus in D1.
export const DAILY_SPEND_CHUNKS_PER_BATCH = 8;
export const DAILY_SPEND_CHUNKS_PER_PASS = 2_048;
export const DAILY_SPEND_EVENTS_PER_PASS = 200_000;
export const DAILY_SPEND_CAPACITY_POLICY =
  `daily-spend-capacity-${DAILY_SPEND_CHUNKS_PER_PASS}-chunks-${DAILY_SPEND_EVENTS_PER_PASS}-events`;

export interface DailySpendBudget { remainingChunks: number; remainingEvents: number; }
export interface CommunityDailySpend {
  basis: typeof COMMUNITY_DAILY_SPEND_BASIS;
  currency: "USD";
  knownCostUsd: number | null;
  coverage: "complete" | "partial" | "unavailable";
  usageEvents: number;
  fullyPricedUsageEvents: number;
  partiallyPricedUsageEvents: number;
  unpricedUsageEvents: number;
  pricingMethodVersion: typeof SERVER_PRICING_METHOD_VERSION;
  registrySha256: string;
  unprocessedUsageEvents?: number;
  unavailableReason?: "processing_capacity_exceeded";
  processingPolicyVersion?: typeof DAILY_SPEND_CAPACITY_POLICY;
}

interface UsageChunk {
  id: string;
  participant_id: string;
  device_id: string;
  accepted_record_count: number;
}
interface UsageRow {
  chunk_row_id: string;
  participant_id: string;
  device_id: string;
  observed_at: string;
  record_json: string;
}

export const DAILY_SPEND_CHUNKS_SQL = `SELECT r.id, r.participant_id, r.device_id,
    r.accepted_record_count
  FROM telemetry_analytical_chunks r
  JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
  WHERE (r.participant_id, r.chunk_day, r.device_id) IN (
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
      json_extract(value, '$[2]') FROM json_each(?1)
  ) AND r.chunk_day = ?2 AND r.stream = 'usage'
  ORDER BY r.participant_id, r.device_id, r.id LIMIT ?3`;

// The scalar IN permits chunk-index pushdown through both analytical UNION
// branches; the tuple additionally rejects a cross-table chunk-ID collision.
// Unary + keeps validated TEXT equality but disqualifies competing day/device
// indexes, which otherwise rescan the day/manifest for every small chunk batch.
// No global event ORDER BY, OFFSET, window, or raw all-history materialization.
export const DAILY_SPEND_RECORDS_SQL = `SELECT r.chunk_row_id, r.participant_id,
    r.device_id, r.observed_at, r.record_json
  FROM telemetry_analytical_records r
  WHERE r.chunk_row_id IN (SELECT json_extract(value, '$[2]') FROM json_each(?1))
    AND (+r.participant_id, +r.device_id, r.chunk_row_id) IN (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
        json_extract(value, '$[2]') FROM json_each(?1)
    ) AND +r.observed_day = ?2 AND +r.stream = 'usage'
  LIMIT ?3`;

function chunkKey(participant: string, device: string, id: string): string {
  return JSON.stringify([participant, device, id]);
}

/** Old or differently priced immutable caches are not current-price evidence. */
export function isCurrentCommunityDailySpend(value: unknown): value is CommunityDailySpend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spend = value as Record<string, unknown>;
  const unprocessed = spend.unprocessedUsageEvents ?? 0;
  const resourceLimited = typeof unprocessed === "number" && unprocessed > 0;
  if (Object.keys(spend).length !== (resourceLimited ? 13 : 10)
      || spend.basis !== COMMUNITY_DAILY_SPEND_BASIS || spend.currency !== "USD"
      || spend.pricingMethodVersion !== COMMUNITY_DAILY_SPEND_PRICING_METHOD
      || spend.registrySha256 !== COMMUNITY_DAILY_SPEND_REGISTRY_SHA256) return false;
  const counts = [spend.usageEvents, spend.fullyPricedUsageEvents,
    spend.partiallyPricedUsageEvents, spend.unpricedUsageEvents, unprocessed];
  if (!counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return false;
  const [events, full, partial, unpriced] = counts as number[];
  if (full! + partial! + unpriced! + Number(unprocessed) !== events) return false;
  if (resourceLimited && (unprocessed !== events || Number(events) <= Math.min(DAILY_SPEND_CHUNKS_PER_PASS, DAILY_SPEND_EVENTS_PER_PASS)
      || spend.unavailableReason !== "processing_capacity_exceeded"
      || spend.processingPolicyVersion !== DAILY_SPEND_CAPACITY_POLICY)) return false;
  const known = events === 0 || full! + partial! > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  return spend.coverage === coverage && (known
    ? typeof spend.knownCostUsd === "number" && Number.isFinite(spend.knownCostUsd)
      && spend.knownCostUsd >= 0 && (events !== 0 || spend.knownCostUsd === 0)
    : spend.knownCostUsd === null);
}

function resourceUnavailableSpend(usageEvents: number): CommunityDailySpend {
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: null, coverage: "unavailable",
    usageEvents, fullyPricedUsageEvents: 0, partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0,
    pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
    registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
    unprocessedUsageEvents: usageEvents, unavailableReason: "processing_capacity_exceeded",
    processingPolicyVersion: DAILY_SPEND_CAPACITY_POLICY,
  };
}

/** Price exactly the same active winner/day population as the token totals. */
export async function priceCommunityDailySpend(
  db: D1Database, day: string, winnersJson: string, usageEvents: number,
  budget: DailySpendBudget,
): Promise<{ state: "priced"; spend: CommunityDailySpend } | { state: "deferred" | "conflicted" }> {
  if (!Number.isSafeInteger(budget.remainingChunks) || budget.remainingChunks < 0
      || budget.remainingChunks > DAILY_SPEND_CHUNKS_PER_PASS
      || !Number.isSafeInteger(budget.remainingEvents) || budget.remainingEvents < 0
      || budget.remainingEvents > DAILY_SPEND_EVENTS_PER_PASS) {
    throw new Error("community daily spend budget invalid");
  }
  if (!Number.isSafeInteger(usageEvents) || usageEvents < 0) {
    throw new Error("community daily spend event count invalid");
  }
  // Permanent capacity refusal is not temporary exhaustion of a shared pass:
  // publish no subtotal and distinguish unprocessed from model-unpriceable.
  if (usageEvents > DAILY_SPEND_EVENTS_PER_PASS) {
    return { state: "priced", spend: resourceUnavailableSpend(usageEvents) };
  }
  if (usageEvents > budget.remainingEvents) return { state: "deferred" };
  const chunks = (await db.prepare(DAILY_SPEND_CHUNKS_SQL)
    .bind(winnersJson, day, MAX_V1_SOURCE_CHUNKS + 1).all<UsageChunk>()).results;
  if (chunks.length > MAX_V1_SOURCE_CHUNKS) throw new Error("community daily spend chunk limit exceeded");
  let expectedEvents = 0;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.accepted_record_count)
        || chunk.accepted_record_count < 1 || chunk.accepted_record_count > MAX_TELEMETRY_V1_CHUNK_RECORDS) {
      throw new Error("community daily spend chunk count invalid");
    }
    expectedEvents += chunk.accepted_record_count;
  }
  if (expectedEvents !== usageEvents) return { state: "conflicted" };
  if (chunks.length > DAILY_SPEND_CHUNKS_PER_PASS) {
    return { state: "priced", spend: resourceUnavailableSpend(usageEvents) };
  }
  if (chunks.length > budget.remainingChunks) return { state: "deferred" };
  // Reserve the complete day before reading any raw record. Exhaustion never
  // publishes a prefix subtotal or dequeues the unfinished day.
  budget.remainingChunks -= chunks.length;
  budget.remainingEvents -= usageEvents;
  let knownNanousd = 0n;
  let fullyPricedUsageEvents = 0;
  let partiallyPricedUsageEvents = 0;
  let unpricedUsageEvents = 0;
  for (let start = 0; start < chunks.length; start += DAILY_SPEND_CHUNKS_PER_BATCH) {
    const batch = chunks.slice(start, start + DAILY_SPEND_CHUNKS_PER_BATCH);
    const remaining = new Map(batch.map(chunk => [
      chunkKey(chunk.participant_id, chunk.device_id, chunk.id), chunk.accepted_record_count,
    ]));
    const identities = JSON.stringify(batch.map(chunk => [chunk.participant_id, chunk.device_id, chunk.id]));
    const rows = (await db.prepare(DAILY_SPEND_RECORDS_SQL)
      .bind(identities, day, batch.length * MAX_TELEMETRY_V1_CHUNK_RECORDS + 1).all<UsageRow>()).results;
    for (const row of rows) {
      const key = chunkKey(row.participant_id, row.device_id, row.chunk_row_id);
      const count = remaining.get(key);
      if (count === undefined || count < 1) return { state: "conflicted" };
      remaining.set(key, count - 1);
      const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
      if (priced === null || priced.pricingStatus === "unpriced") {
        unpricedUsageEvents += 1;
      } else {
        if (!Number.isSafeInteger(priced.costNanousd) || priced.costNanousd < 0) {
          throw new Error("community daily spend cost invalid");
        }
        knownNanousd += BigInt(priced.costNanousd);
        if (priced.pricingStatus === "fully_priced") fullyPricedUsageEvents += 1;
        else partiallyPricedUsageEvents += 1;
      }
    }
    if ([...remaining.values()].some(count => count !== 0)) return { state: "conflicted" };
  }
  return {state:"priced",spend:finalizeCommunityDailySpend({usageEvents,knownNanousd,
    fullyPricedUsageEvents,partiallyPricedUsageEvents,unpricedUsageEvents})};
}

/** Shared exact integer fold boundary; never rounds individual owners/events. */
export function finalizeCommunityDailySpend(input: {
  usageEvents: number; knownNanousd: bigint; fullyPricedUsageEvents: number;
  partiallyPricedUsageEvents: number; unpricedUsageEvents: number;
}): CommunityDailySpend {
  const {usageEvents,knownNanousd,fullyPricedUsageEvents,partiallyPricedUsageEvents,unpricedUsageEvents}=input;
  if (![usageEvents,fullyPricedUsageEvents,partiallyPricedUsageEvents,unpricedUsageEvents]
      .every(value=>Number.isSafeInteger(value)&&value>=0) || knownNanousd<0n
      || fullyPricedUsageEvents+partiallyPricedUsageEvents+unpricedUsageEvents!==usageEvents)
    throw new Error("community daily spend counts invalid");
  const hasKnownCost = usageEvents === 0 || fullyPricedUsageEvents + partiallyPricedUsageEvents > 0;
  // Match the public dollar series' four-decimal boundary, without rounding
  // individual events/components or losing integer precision during the fold.
  const units = (knownNanousd + 50_000n) / 100_000n;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("community daily spend total exceeds range");
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD",
    knownCostUsd: hasKnownCost ? Number(units) / 10_000 : null,
    coverage: !hasKnownCost ? "unavailable"
      : fullyPricedUsageEvents === usageEvents ? "complete" : "partial",
    usageEvents, fullyPricedUsageEvents, partiallyPricedUsageEvents, unpricedUsageEvents,
    pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
    registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  };
}
