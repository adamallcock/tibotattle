// Composition proof: every public /api/v1/community/daily output can be built
// from effective occurrences in ONE Node process using only the vendored
// d43c8f92 kernels (through vendor/analytics-d43c8f92/entry.ts), with no D1 and
// no Worker runtime, and the website's own d43c8f92 normalizer accepts it.
// Synthetic, content-free owners only.
import { createHash } from "node:crypto";
import { canonicalTelemetryV11Json as gcpLineCanonicalJson } from "@app-usagemonitor/telemetry-contract";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityDailyPayload,
  buildCommunityModelCompositionDay,
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  canonicalTelemetryV11Json,
  evaluateSharedCacheDay,
  evaluateSharedModelDate,
  evaluateSharedScalarDate,
  isCurrentCommunityDailySpend,
  mergeCacheRetentionBands,
  modelHistoryWindow,
  prepareSharedAnalyticsDay,
  projectPublicAllowanceGraph,
  publicCacheRetentionWindow,
  publicInputs,
  validCachedAdminCommunityAllowancePreview,
  type CacheRetentionBandRow,
  type CacheRetentionDayAggregate,
  type CachedCommunityModelCompositions,
  type CommunityAllowanceFit,
  type EffectiveTelemetryOccurrence,
  type SharedAnalyticsDay,
  type V11DailyProjectionValues,
  type V11SourcePin,
  type V1ModelCompositionResult,
} from "../vendor/analytics-d43c8f92/entry";
import { v11UsageRecord } from "./kernel-parity/helpers/telemetry-v11";
// The website's own normalizer at d43c8f92, unchanged.
import { normalizeCommunityDailySeries } from "../vendor/analytics-d43c8f92/apps/web/public/community-data.js";

const DAY_MS = 86_400_000;
const TODAY = "2026-09-30";
const NOW_MS = Date.parse(`${TODAY}T18:00:00.000Z`);
const CALENDAR_DAYS = 170;
const MODEL_DATES = 70;
const ACTIVE_DAYS_BACK = [0, 1, 2, 9, 20, 45, 80];
/** sha256 of JSON.stringify of the composed envelope and preview for this corpus. */
const COMPOSED_RESPONSE_SHA256 = "2737d60661d0392b19ccc368b62bdb7ba3c8f14ead2241a28d30d6914ee84390";
const COMPOSED_PREVIEW_SHA256 = "f04259f71d4e2a34bddaa92f306687d051fd8c3ac082f012dcec80e8fd7af6d2";
const stamp = (at: number) => new Date(at).toISOString();
const label = (at: number) => stamp(at).slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const id = (prefix: string, owner: number, index: number) =>
  `${prefix}:v1:${(owner * 1_000_000 + index).toString(16).padStart(64, "0")}`;

interface Owner { digest: string; participant: string; account: string; plan: "pro" | "prolite" | "plus"; n: number }
const OWNERS: Owner[] = [1, 2, 3].map((n) => ({
  n,
  digest: String(n).repeat(64),
  participant: `synthetic-owner-${n}`,
  account: `account-track:v2:${String.fromCharCode(97 + n).repeat(64)}`,
  plan: (["pro", "prolite", "plus"] as const)[n - 1]!,
}));

function occurrence(o: Owner, stream: "usage" | "quota" | "session", at: number, occurrenceId: string,
  record: unknown): EffectiveTelemetryOccurrence {
  return { methodVersion: "effective-telemetry-owner-day-v1", stream, participantId: o.participant,
    ownerDigest: o.digest, occurrenceId, eventTime: stamp(at), eventTimeConflict: false, status: "compatible",
    sourceCount: 1, sourceFormats: ["v12"], sourceRowIds: [], sourceRecordKeys: ["synthetic"],
    recordJson: canonicalTelemetryV11Json(record) };
}
const attribution = (o: Owner) => ({ accountBasis: "same_source", accountTrackId: o.account,
  planBasis: "same_source_occurrence", planType: o.plan, planEraId: null } as const);
function usage(o: Owner, index: number, at: number) {
  const record = v11UsageRecord(label(at), "c", { eventId: id("event", o.n, index), eventTime: stamp(at),
    sessionUuid: `synthetic-session-${o.n}`, accountPlanAttribution: attribution(o) });
  return occurrence(o, "usage", at, record.eventId, record);
}
function quota(o: Owner, index: number, at: number, usedPercent: number, resetsAt: number) {
  const observationId = id("quota", o.n, index);
  return occurrence(o, "quota", at, observationId, { schemaVersion: "quota-observation-v1.1", observationId,
    observedTime: stamp(at), provider: "openai_codex", planType: o.plan, planVariant: "unknown", limitId: "codex",
    slot: "seven_day", usedPercent, windowDurationMinutes: 10_080, resetsAt: stamp(resetsAt),
    accountPlanAttribution: attribution(o) });
}
function session(o: Owner, at: number) {
  return occurrence(o, "session", at, id("session", o.n, at % 1_000_000), { schemaVersion: "session-dimension-v1.1",
    sessionUuid: `synthetic-session-${o.n}`, firstEventTime: stamp(at), provider: "openai_codex",
    toolClassCounts: { shell: 1 } });
}

type DayStreams = { usage: EffectiveTelemetryOccurrence[]; quota: EffectiveTelemetryOccurrence[]; session: EffectiveTelemetryOccurrence[] };
/** Admitted effective occurrences for one owner: owner -> day -> streams, populated days only. */
function facts(o: Owner): Map<string, DayStreams> {
  const byDay = new Map<string, DayStreams>();
  let k = 0;
  for (const back of ACTIVE_DAYS_BACK) {
    const start = dayMs(TODAY) - back * DAY_MS;
    const u = Array.from({ length: 9 }, (_, i) => usage(o, ++k, start + i * 3_600_000 + 30 * 60_000 + o.n * 1000));
    const q = Array.from({ length: 9 }, (_, i) => quota(o, ++k, start + i * 3_600_000, 5 + i * 10 + o.n, start + 8 * DAY_MS));
    byDay.set(label(start), { usage: u, quota: q, session: [session(o, start + 30 * 60_000)] });
  }
  return byDay;
}

const pinFor = (o: Owner, day: string): V11SourcePin => ({ source: "v1.1", participantId: o.participant,
  generationId: `effective:${o.digest}`, fromDay: modelHistoryWindow(day).fromDay, throughDay: day,
  inputRevision: 1, mutationEpoch: 1, fingerprint: "d".repeat(64) });

const BAND_COUNTERS = ["adjacencies", "reusedMoreThanHalf", "matchedOrExceeded", "unorderedTies",
  "excludedInsufficientEvidence", "excludedContextContracted", "sessions"] as const;

async function compose() {
  // 1. One SharedAnalyticsDay per owner x calendar day (70 model dates x 101-day windows need 170 days).
  const firstDay = label(dayMs(TODAY) - (CALENDAR_DAYS - 1) * DAY_MS);
  const calendar = Array.from({ length: CALENDAR_DAYS }, (_, i) => label(dayMs(firstDay) + i * DAY_MS));
  const prepared = new Map<string, Map<string, SharedAnalyticsDay>>();
  for (const o of OWNERS) {
    const f = facts(o);
    const days = new Map<string, SharedAnalyticsDay>();
    for (const day of calendar) {
      days.set(day, await prepareSharedAnalyticsDay({ day, ownerDigest: o.digest, ...(f.get(day) ?? { usage: [], quota: [], session: [] }) }));
    }
    prepared.set(o.digest, days);
  }
  const windowFor = (o: Owner, day: string) => {
    const w = modelHistoryWindow(day);
    const out: SharedAnalyticsDay[] = [];
    for (let at = dayMs(w.fromDay); at <= dayMs(day); at += DAY_MS) out.push(prepared.get(o.digest)!.get(label(at))!);
    return out;
  };

  // 2. Daily activity/API value: per-day cross-owner fold with the vendored publicInputs
  //    (one contributing device per contributing owner here).
  const publishedDays = calendar.filter((day) => OWNERS.some((o) => {
    const d = prepared.get(o.digest)!.get(day)!.daily;
    return d.counts.usage + d.counts.quota + d.counts.session > 0;
  }));
  const dailyRows = publishedDays.map((day) => {
    // prepareSharedAnalyticsDay returns the FINALIZED daily (adds coverage and knownCostNanousd);
    // the publisher folds the closed, unfinalized shape.
    const values = OWNERS.map((o) => {
      const { coverage: _coverage, knownCostNanousd: _known, ...value } = prepared.get(o.digest)!.get(day)!.daily;
      return value as V11DailyProjectionValues;
    });
    const payload = buildCommunityDailyPayload({ day, revision: 1, releasedAt: stamp(NOW_MS),
      ...publicInputs(values, values.map(() => 1)) });
    return { day, revision: 1, releasedAt: stamp(NOW_MS), payload };
  });

  // 3. Current scalar fits (today only), per owner.
  const fits: CommunityAllowanceFit[] = [];
  for (const o of OWNERS) {
    const r = await evaluateSharedScalarDate({ pin: pinFor(o, TODAY), day: TODAY, ownerDigest: o.digest, days: windowFor(o, TODAY) });
    fits.push(...r.selectedFits);
  }

  // 4. Model history: 70 dates x owners, then each day's community composition.
  const modelDays = [];
  for (let i = MODEL_DATES - 1; i >= 0; i--) {
    const day = label(dayMs(TODAY) - i * DAY_MS);
    const collection: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: 0,
      unsupportedSourceParticipantCount: 0, refusedParticipantCount: 0, storeAvailable: true };
    for (const o of OWNERS) {
      const c = await evaluateSharedModelDate({ pin: pinFor(o, day), day, ownerDigest: o.digest,
        days: windowFor(o, day) }) as V1ModelCompositionResult;
      collection.v1ParticipantCount++;
      if (c.status === "ready") collection.compositions.push({ participantId: o.digest, composition: c });
      else collection.refusedParticipantCount++;
    }
    modelDays.push(buildCommunityModelCompositionDay(collection, day));
  }
  const preview = buildAdminCommunityAllowancePreview(fits, NOW_MS, OWNERS.map((o) => o.digest), {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays });
  const graph = projectPublicAllowanceGraph({ generated_at: preview.generatedAt, payload_json: JSON.stringify(preview) },
    { publishedDays, nowMs: NOW_MS });

  // 5. Cache continuity: per owner-day reducer with the 7-day carry, then the read-time window projection.
  const bandRows: Array<CacheRetentionBandRow & { day: string; model: string }> = [];
  for (const o of OWNERS) {
    for (const day of calendar.slice(7)) {
      const at = calendar.indexOf(day);
      const agg: CacheRetentionDayAggregate = evaluateSharedCacheDay({ day, ownerDigest: o.digest,
        days: calendar.slice(at - 7, at + 1).map((d) => prepared.get(o.digest)!.get(d)!) });
      for (const g of agg.groups) for (const b of g.bands) bandRows.push({ ownerDigest: o.digest, day, model: g.model, ...b });
    }
  }
  const group = (rows: typeof bandRows, byModel: boolean) => {
    const m = new Map<string, CacheRetentionBandRow & { model?: string }>();
    for (const r of rows) {
      const key = JSON.stringify([r.ownerDigest, r.band, byModel ? r.model : null]);
      const old = m.get(key) ?? { ownerDigest: r.ownerDigest, band: r.band, adjacencies: 0, reusedMoreThanHalf: 0,
        matchedOrExceeded: 0, unorderedTies: 0, excludedInsufficientEvidence: 0, excludedContextContracted: 0, sessions: 0,
        ...(byModel ? { model: r.model } : {}) };
      for (const k of BAND_COUNTERS) (old as unknown as Record<string, number>)[k] += r[k];
      m.set(key, old);
    }
    return [...m.values()];
  };
  let anyEvidence = false;
  const windows = CACHE_RETENTION_WINDOWS.map((span) => {
    const from = span.days === null ? "" : label(NOW_MS - (span.days - 1) * DAY_MS);
    const rows = bandRows.filter((r) => r.day >= from);
    const pooled = group(rows, false).map(({ model: _model, ...r }) => r);
    if (pooled.length) anyEvidence = true;
    return publicCacheRetentionWindow({ window: span.id, days: span.days, pooled: mergeCacheRetentionBands(pooled),
      modelRows: group(rows, true) });
  });
  const cacheRetention = anyEvidence ? { schemaVersion: CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
    metric: CACHE_RETENTION_METRIC_ID, methodVersion: CACHE_RETENTION_METHOD.version, measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end", windows } : null;

  // 6. The handler envelope (d43c8f92 index.ts handleCommunityDaily, typed mode).
  const response = { schemaVersion: "community-daily-read-v1.0", from: label(dayMs(TODAY) - 365 * DAY_MS), to: TODAY,
    allowanceState: graph !== null ? "ready" : "updating", allowanceReadState: "confirmed",
    ...(graph === null ? {} : { allowanceBreakdowns: graph.breakdowns }), ...(cacheRetention ? { cacheRetention } : {}),
    days: dailyRows.map((d) => {
      const payload = { ...d.payload } as Record<string, unknown>;
      delete payload.capacityByPlanType;
      delete payload.allowance;
      if (!isCurrentCommunityDailySpend(payload.apiEquivalentSpend)) delete payload.apiEquivalentSpend;
      return { ...d, payload };
    }) };
  return { calendar, publishedDays, fits, modelDays, preview, graph, bandRows, cacheRetention, response };
}

describe("one-process composition over the vendored d43c8f92 kernels", () => {
  it("resolves the kernels' packages to the d43c8f92 copies, not this checkout's", () => {
    // entry.ts re-exports the vendored telemetry-contract; this spec's own import
    // resolves normally. One module instance would mean the vendor scoping failed.
    expect(typeof canonicalTelemetryV11Json).toBe("function");
    expect(canonicalTelemetryV11Json).not.toBe(gcpLineCanonicalJson);
  });

  it("produces a community-daily-read-v1.0 payload the website accepts", async () => {
    const first = await compose();
    const { publishedDays, fits, modelDays, preview, graph, bandRows, cacheRetention, response } = first;
    expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW_MS)).toBe(true);
    const normalized = normalizeCommunityDailySeries(JSON.parse(JSON.stringify(response)), { nowMs: NOW_MS });

    expect({
      publishedDays: publishedDays.length,
      fits: fits.length,
      modelDays: modelDays.length,
      breakdownDays: graph?.breakdowns.days.length ?? 0,
      cacheBandRows: bandRows.length,
      state: normalized.state,
    }).toEqual({ publishedDays: 7, fits: 21, modelDays: 70, breakdownDays: 5, cacheBandRows: 210, state: "published" });
    expect(response.schemaVersion).toBe("community-daily-read-v1.0");
    expect(normalized.days.length).toBe(publishedDays.length);
    expect(normalized.breakdowns).not.toBeNull();
    // The site passes RAW payload.cacheRetention (the windows series) to feature-insights.js;
    // the community-page normalizer only accepts the legacy single-curve shape.
    expect(cacheRetention!.windows.length).toBe(4);
    expect(cacheRetention!.windows.every((w) => w.bands.length === 10 && w.byModel.every((m) => m.bands.length === 10))).toBe(true);

    // Deterministic: an independent second composition is byte-identical, and the
    // frozen kernels keep producing the pinned bytes (the same under Node 22 and 26).
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const second = await compose();
    expect(digest(second.response)).toBe(digest(response));
    expect(digest(second.preview)).toBe(digest(preview));
    expect(digest(response)).toBe(COMPOSED_RESPONSE_SHA256);
    expect(digest(preview)).toBe(COMPOSED_PREVIEW_SHA256);
    console.log(JSON.stringify({ composeProof: { responseSha256: digest(response), previewSha256: digest(preview),
      responseBytes: JSON.stringify(response).length } }));
  }, 240_000);
});
