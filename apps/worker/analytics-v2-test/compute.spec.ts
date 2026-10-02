// A-2 analytics-refresh compute core: computeAnalyticsV2 over synthetic,
// content-free effective occurrences, using only the vendored d43c8f92
// kernels. The compose-parity case rebuilds the public read envelope from the
// outputs exactly as compose-proof.spec.ts does and requires its pinned bytes.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import {
  analyticsV2DailyContentSha256,
  analyticsV2RequiredOccurrenceRange,
  ANALYTICS_V2_MODEL_DATES,
  computeAnalyticsV2,
  stampAnalyticsV2DailyPayload,
  type AnalyticsV2ComputeOutputs,
  type ComputeAnalyticsV2Input,
} from "../src/analytics-v2/compute";
import { ANALYTICS_V2_PHASES, ANALYTICS_V2_REFUSAL_REASONS, type AnalyticsV2Refusal } from "../src/analytics-v2/contract";
import {
  ANALYTICS_V2_DEFAULT_RESOURCES,
  ANALYTICS_V2_MEMORY_MODEL,
  analyticsV2OwnerMemoryEstimate,
  validAnalyticsV2Resources,
} from "../src/analytics-v2/resources";
import { compareAnalyticsV2Refusals } from "../src/analytics-v2/refusals";
import {
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  isCurrentCommunityDailySpend,
  mergeCacheRetentionBands,
  projectPublicAllowanceGraph,
  publicCacheRetentionWindow,
  validCachedAdminCommunityAllowancePreview,
  type AdminCommunityAllowancePreview,
  type CacheRetentionBandRow,
} from "../vendor/analytics-d43c8f92/entry";
// The website's own normalizer at d43c8f92, unchanged.
import { normalizeCommunityDailySeries } from "../vendor/analytics-d43c8f92/apps/web/public/community-data.js";
import {
  addDays,
  COMPOSED_PREVIEW_SHA256,
  COMPOSED_RESPONSE_SHA256,
  composeFacts,
  composeProofCorpus,
  conflictFacts,
  DAY_MS,
  dayMs,
  denseFacts,
  DENSE_OWNER_PINS,
  effectiveV2Owner,
  label,
  legacyOnlyV2Owner,
  manyModelFacts,
  NOW_MS,
  oneDevicePerOwner,
  stamp,
  syntheticOwner,
  TODAY,
  v1OnlyV2Owner,
} from "./fixtures/synthetic-occurrences.mjs";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BAND_COUNTERS = [["adjacencies", "adjacencies"], ["reusedMoreThanHalf", "reused_more_than_half"],
  ["matchedOrExceeded", "matched_or_exceeded"], ["unorderedTies", "unordered_ties"],
  ["excludedInsufficientEvidence", "excluded_insufficient_evidence"],
  ["excludedContextContracted", "excluded_context_contracted"], ["sessions", "sessions"]] as const;

type Corpus = Pick<ComputeAnalyticsV2Input, "owners" | "occurrencesByOwner">;
function inputFor(corpus: Corpus, queued: readonly string[], extra: Partial<ComputeAnalyticsV2Input> = {}): ComputeAnalyticsV2Input {
  const queuedDays = { days: queued, lastSequence: 42 };
  return {
    owners: corpus.owners,
    occurrencesByOwner: corpus.occurrencesByOwner,
    occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays }),
    devicesByDay: oneDevicePerOwner(corpus.occurrencesByOwner, queued),
    queuedDays,
    nowMs: NOW_MS,
    revisionSeed: 0,
    ...extra,
  };
}

/** A-4's read-time composition, step for step as compose-proof.spec.ts builds it. */
function readEnvelope(outputs: AnalyticsV2ComputeOutputs, publishedDays: readonly string[]) {
  const preview = outputs.preview as AdminCommunityAllowancePreview;
  const graph = projectPublicAllowanceGraph({ generated_at: preview.generatedAt, payload_json: JSON.stringify(preview) },
    { publishedDays, nowMs: NOW_MS });
  const bandRows = outputs.cacheBands.map((row) => ({ ownerDigest: row.ownerDigest, day: row.day, model: row.model,
    band: row.band, ...Object.fromEntries(BAND_COUNTERS.map(([camel, snake]) => [camel, row.counters[snake]])) })) as
    Array<CacheRetentionBandRow & { day: string; model: string }>;
  const group = (rows: typeof bandRows, byModel: boolean) => {
    const m = new Map<string, CacheRetentionBandRow & { model?: string }>();
    for (const r of rows) {
      const key = JSON.stringify([r.ownerDigest, r.band, byModel ? r.model : null]);
      const old = m.get(key) ?? { ownerDigest: r.ownerDigest, band: r.band, adjacencies: 0, reusedMoreThanHalf: 0,
        matchedOrExceeded: 0, unorderedTies: 0, excludedInsufficientEvidence: 0, excludedContextContracted: 0, sessions: 0,
        ...(byModel ? { model: r.model } : {}) };
      for (const [k] of BAND_COUNTERS) (old as unknown as Record<string, number>)[k]! += r[k];
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
  const response = { schemaVersion: "community-daily-read-v1.0", from: label(dayMs(TODAY) - 365 * DAY_MS), to: TODAY,
    allowanceState: graph !== null ? "ready" : "updating", allowanceReadState: "confirmed",
    ...(graph === null ? {} : { allowanceBreakdowns: graph.breakdowns }), ...(cacheRetention ? { cacheRetention } : {}),
    days: outputs.dailyCandidates.map((candidate) => {
      const payload = { ...candidate.payload } as Record<string, unknown>;
      delete payload.capacityByPlanType;
      delete payload.allowance;
      if (!isCurrentCommunityDailySpend(payload.apiEquivalentSpend)) delete payload.apiEquivalentSpend;
      return { day: candidate.day, revision: candidate.payload.revision, releasedAt: candidate.payload.releasedAt, payload };
    }) };
  return { graph, cacheRetention, response };
}

/** Canonical bytes of everything except wall-clock timings. */
function outputsDigest(outputs: AnalyticsV2ComputeOutputs): string {
  const { timings: _timings, ...rest } = outputs;
  return sha(canonicalJson(rest));
}
/** Exact per-day evidence counts of one owner's occurrences (what A-1 countOwnerOccurrences returns). */
function evidenceOf(days: ReadonlyMap<string, { usage: readonly unknown[]; quota: readonly unknown[]; session: readonly unknown[] }>) {
  return new Map([...days].filter(([, value]) => value.usage.length + value.quota.length + value.session.length > 0)
    .map(([day, value]) => [day, { usage: value.usage.length, quota: value.quota.length, session: value.session.length }]));
}
const refusalsOf = (outputs: AnalyticsV2ComputeOutputs, ownerDigest: string) =>
  outputs.refusals.filter((refusal) => refusal.ownerDigest === ownerDigest);
const fitOwners = (outputs: AnalyticsV2ComputeOutputs) => outputs.ownerFits.map((row) => row.ownerDigest);

describe("computeAnalyticsV2 (A-2)", () => {
  it("(a) reproduces the compose proof exactly and (f) emits a valid, projectable preview", async () => {
    const corpus = composeProofCorpus();
    const outputs = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays));
    expect(outputs.refusals).toEqual([]);
    expect(outputs.blockedDays).toEqual([]);
    expect(outputs.journal).toEqual({ lastSequence: 42 });
    expect(outputs.today).toBe(TODAY);
    expect(outputs.ownerDays.length).toBe(3 * 7);
    expect(outputs.ownerFits.map((row) => row.asOfDay)).toEqual([TODAY, TODAY, TODAY]);
    // A fit carries only its participant (the owner digest), plan, capacity and last observation.
    for (const row of outputs.ownerFits) {
      for (const fit of row.fits as Array<Record<string, unknown>>) {
        expect(Object.keys(fit).sort()).toEqual(["capacityNanousd", "lastObservedAt", "participantId", "planType"]);
        expect(fit.participantId).toBe(row.ownerDigest);
      }
    }
    expect(outputs.ownerModelDates.length).toBe(3 * ANALYTICS_V2_MODEL_DATES);
    // The private pin fingerprint reaches no stored result.
    expect(JSON.stringify(outputs.ownerModelDates)).not.toContain("inputFingerprint");

    // (f) The preview is the production-valid admin DTO and projects publicly.
    const preview = outputs.preview as AdminCommunityAllowancePreview;
    expect(preview).not.toBeNull();
    expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW_MS)).toBe(true);

    const { graph, cacheRetention, response } = readEnvelope(outputs, corpus.publishedDays);
    expect(graph).not.toBeNull();
    const normalized = normalizeCommunityDailySeries(JSON.parse(JSON.stringify(response)), { nowMs: NOW_MS });
    expect({
      publishedDays: outputs.dailyCandidates.length,
      fits: outputs.ownerFits.reduce((sum, row) => sum + (row.fits as unknown[]).length, 0),
      modelDays: preview.models.days.length,
      breakdownDays: graph?.breakdowns.days.length ?? 0,
      cacheBandRows: outputs.cacheBands.length,
      state: normalized.state,
    }).toEqual({ publishedDays: 7, fits: 21, modelDays: 70, breakdownDays: 5, cacheBandRows: 210, state: "published" });
    expect(cacheRetention!.windows.length).toBe(4);
    // Byte-identical to the compose proof's pinned envelope and preview.
    expect(sha(JSON.stringify(response))).toBe(COMPOSED_RESPONSE_SHA256);
    expect(sha(JSON.stringify(preview))).toBe(COMPOSED_PREVIEW_SHA256);

    // Content identity excludes only the revision stamp; a restamp keeps it.
    const first = outputs.dailyCandidates[0]!;
    expect(first.payload.revision).toBe(1);
    expect(first.payload.releasedAt).toBe(stamp(NOW_MS));
    expect(await analyticsV2DailyContentSha256(first.payload)).toBe(first.payloadSha256);
    const restamped = await stampAnalyticsV2DailyPayload(first, { revision: 5, releasedAt: "2026-10-01T03:00:00.000Z" });
    expect(restamped).toMatchObject({ aggregateId: `community-daily:${first.day}:r5`, revision: 5,
      releasedAt: "2026-10-01T03:00:00.000Z", totals: first.payload.totals, cells: first.payload.cells });
    expect(await analyticsV2DailyContentSha256(restamped)).toBe(first.payloadSha256);
  }, 120_000);

  it("(b) is deterministic: two runs give byte-identical canonical outputs", async () => {
    const corpus = composeProofCorpus();
    const conflictOwner = syntheticOwner(5), legacy = syntheticOwner(6);
    const owners = [...corpus.owners, effectiveV2Owner(conflictOwner), legacyOnlyV2Owner(legacy)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner,
      [conflictOwner.digest, conflictFacts(conflictOwner, addDays(TODAY, -1))]]);
    const input = inputFor({ owners, occurrencesByOwner }, corpus.publishedDays);
    const first = await computeAnalyticsV2(input);
    // Input order is not identity: reversing every list changes nothing.
    const second = await computeAnalyticsV2({ ...input, owners: [...owners].reverse(),
      queuedDays: { days: [...corpus.publishedDays].reverse(), lastSequence: 42 } });
    expect(outputsDigest(second)).toBe(outputsDigest(first));
    expect(first.refusals.length).toBeGreaterThan(0);
  }, 120_000);

  // Owner decision 2026-10-01 (raise the caps, prove parity): an owner beyond
  // the d43c8f92 shared reducers' 120,000-row window bound used to be refused
  // (usage_window_unrepresentable on the scalar fit and all 70 model dates).
  // It is now computed on production's native path; native-parity.spec.ts
  // proves these results equal to d43c8f92 advanceStorageEffectiveAnalysis
  // over the same denseFacts corpus.
  it("(c) computes a dense owner's windows beyond the shared 120,000-row bound and keeps it in the cohort", async () => {
    const corpus = composeProofCorpus();
    const dense = syntheticOwner(4, "pro");
    const owners = [...corpus.owners, effectiveV2Owner(dense)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner, [dense.digest, denseFacts(dense)]]);
    const windowRows = [...occurrencesByOwner.get(dense.digest)!.entries()]
      .filter(([day]) => day >= addDays(TODAY, -100)).reduce((sum, [, streams]) => sum + streams.usage.length, 0);
    expect(windowRows).toBeGreaterThan(120_000);
    const started = performance.now();
    const outputs = await computeAnalyticsV2(inputFor({ owners, occurrencesByOwner }, corpus.publishedDays));
    const wallMs = performance.now() - started;

    expect(refusalsOf(outputs, dense.digest)).toEqual([]);
    expect(outputs.refusals).toEqual([]);
    expect(fitOwners(outputs)).toContain(dense.digest);
    const denseFits = outputs.ownerFits.find((row) => row.ownerDigest === dense.digest)!.fits as unknown[];
    const denseModels = outputs.ownerModelDates.filter((row) => row.ownerDigest === dense.digest);
    expect(denseModels.length).toBe(ANALYTICS_V2_MODEL_DATES);
    // Pinned: the dense owner's computed fits and 70 model results.
    expect({ fits: denseFits.length, fitsSha256: sha(canonicalJson(denseFits)),
      ready: denseModels.filter((row) => (row.result as { status: string }).status === "ready").length,
      modelsSha256: sha(canonicalJson(denseModels)) }).toEqual(DENSE_OWNER_PINS);
    const preview = outputs.preview as AdminCommunityAllowancePreview;
    expect(preview.coverage.uploadingParticipantCount).toBe(4);
    // Every model day counts the four-owner cohort with nobody refused.
    expect(preview.models.days.length).toBe(ANALYTICS_V2_MODEL_DATES);
    expect(preview.models.days.every((day) => day.v1ParticipantCount === 4 && day.refusedParticipantCount === 0)).toBe(true);
    const today = outputs.dailyCandidates.find((candidate) => candidate.day === TODAY)!;
    expect(today.payload.totals.contributingParticipants).toBe(4);
    expect(outputs.cacheBands.some((row) => row.ownerDigest === dense.digest && row.day === addDays(TODAY, -100))).toBe(true);
    // Its resource entry: exact counts and the deterministic estimate, within the default budget.
    const resource = outputs.resources!.owners.find((entry) => entry.ownerDigest === dense.digest)!;
    expect(resource).toMatchObject({ usage: 7 * 17_200 + 63, quota: 7 * 9 + 63, session: 14, admitted: true,
      heapPeakBytes: null, maxDayOccurrences: 17_210 });
    expect(resource.estimateBytes).toBeLessThan(ANALYTICS_V2_DEFAULT_RESOURCES.memoryBudgetBytes);

    // Timings for this 4-owner x 170-day corpus, one core.
    expect(Object.keys(outputs.timings).sort()).toEqual(["cache", "community", "model", "prepare", "scalar"]);
    expect(Object.values(outputs.timings).every((ms) => Number.isFinite(ms) && ms! >= 0)).toBe(true);
    console.log(JSON.stringify({ a2Timings: { owners: 4, calendarDays: 170, denseWindowUsageRows: windowRows,
      wallMs: Math.round(wallMs), phasesMs: Object.fromEntries(Object.entries(outputs.timings)
        .map(([phase, ms]) => [phase, Math.round(ms!)])), node: process.version } }));
  }, 900_000);

  // Owner decision 2026-10-01: the shared reducers' 20,000-occurrence day
  // bound is replaced by the GCP day backstop (default 250,000). Configured
  // at its minimum, the old bound, the backstop refuses exactly as before.
  it("(c, day bound) computes a day over 20,000 occurrences; the backstop at the old bound still refuses it", async () => {
    const corpus = composeProofCorpus();
    const crowded = syntheticOwner(4, "pro");
    const crowdedDay = addDays(TODAY, -30);
    // 19,995 usage + 9 quota + 1 session rows: over the shared reducers' 20,000-row day bound.
    const facts = denseFacts(crowded, { firstDenseBack: 30, denseDays: 1, usagePerDay: 19_995 });
    const input = inputFor({ owners: [...corpus.owners, effectiveV2Owner(crowded)],
      occurrencesByOwner: new Map([...corpus.occurrencesByOwner, [crowded.digest, facts]]) },
    [...corpus.publishedDays, crowdedDay].sort());
    const outputs = await computeAnalyticsV2(input);
    expect(outputs.blockedDays).toEqual([]);
    expect(outputs.refusals).toEqual([]);
    const row = outputs.ownerDays.find((value) => value.ownerDigest === crowded.digest && value.day === crowdedDay)!;
    expect(row.refusal).toBeNull();
    expect((row.daily as { counts: unknown }).counts).toEqual({ usage: 19_995, quota: 9, session: 1 });
    expect(fitOwners(outputs)).toContain(crowded.digest);
    const published = outputs.dailyCandidates.find((candidate) => candidate.day === crowdedDay)!;
    expect(published.payload.totals).toMatchObject({ contributingParticipants: 1, usageEvents: 19_995,
      quotaObservations: 9, sessionDimensions: 1 });

    const atOldBound = await computeAnalyticsV2({ ...input,
      resources: { ...ANALYTICS_V2_DEFAULT_RESOURCES, maxDayOccurrences: 20_000 } });
    expect(atOldBound.blockedDays).toEqual([crowdedDay]);
    expect(refusalsOf(atOldBound, crowded.digest)).toContainEqual({ ownerDigest: crowded.digest, day: crowdedDay,
      family: "daily", reason: "day_row_limit" });
    expect(atOldBound.ownerDays).toContainEqual({ ownerDigest: crowded.digest, day: crowdedDay, daily: null,
      refusal: "day_row_limit" });
    expect(fitOwners(atOldBound)).not.toContain(crowded.digest);
    expect(atOldBound.dailyCandidates.map((candidate) => candidate.day)).toEqual(corpus.publishedDays);
  }, 240_000);

  it("(c, cache bound) records a day over the cache reducer's group bound as that owner-day's refusal and carries on", async () => {
    const corpus = composeProofCorpus();
    const crowded = syntheticOwner(4, "pro");
    const crowdedDay = addDays(TODAY, -30);
    const withModels = (models: number) => computeAnalyticsV2(inputFor({
      owners: [...corpus.owners, effectiveV2Owner(crowded)],
      occurrencesByOwner: new Map([...corpus.occurrencesByOwner,
        [crowded.digest, manyModelFacts(crowded, crowdedDay, models)]]),
    }, corpus.publishedDays));
    const cacheRefusals = (outputs: AnalyticsV2ComputeOutputs) =>
      refusalsOf(outputs, crowded.digest).filter((refusal) => refusal.family === "cache");
    const crowdedBands = (outputs: AnalyticsV2ComputeOutputs, day: string) =>
      outputs.cacheBands.filter((row) => row.ownerDigest === crowded.digest && row.day === day);
    const base = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays));

    // 513 (model, effort) groups in one owner-day: d43c8f92 records group_limit_exceeded for
    // that day and continues, so one contributor never stops the run for everyone.
    const over = await withModels(513);
    expect(cacheRefusals(over)).toEqual([{ ownerDigest: crowded.digest, day: crowdedDay, family: "cache",
      reason: "group_limit_exceeded" }]);
    expect(crowdedBands(over, crowdedDay)).toEqual([]);
    expect(crowdedBands(over, TODAY).length).toBeGreaterThan(0);
    expect(over.refusals.every((refusal) => refusal.ownerDigest === crowded.digest)).toBe(true);
    expect(over.blockedDays).toEqual([]);
    expect(over.dailyCandidates.map((candidate) => candidate.day)).toEqual(corpus.publishedDays);
    expect(over.preview).not.toBeNull();
    // Every other owner's cache continuity is exactly what it is without this owner.
    expect(over.cacheBands.filter((row) => row.ownerDigest !== crowded.digest)).toEqual(base.cacheBands);

    // At the bound itself the day reduces into one group per model.
    const atBound = await withModels(512);
    expect(cacheRefusals(atBound)).toEqual([]);
    expect(new Set(crowdedBands(atBound, crowdedDay).map((row) => row.model)).size).toBe(512);
  }, 240_000);

  it("takes A-3's call shape; read width beyond the evidence never moves an output", async () => {
    const corpus = composeProofCorpus();
    const queued = corpus.publishedDays;
    // Exactly the keys A-3 analytics-refresh.mjs passes: no occurrenceRange, a bare queued-day list.
    const a3Input = { owners: corpus.owners, occurrencesByOwner: corpus.occurrencesByOwner,
      devicesByDay: oneDevicePerOwner(corpus.occurrencesByOwner, queued), queuedDays: queued, nowMs: NOW_MS,
      revisionSeed: 0 };
    const a3 = await computeAnalyticsV2(a3Input);
    const declared = await computeAnalyticsV2({ ...a3Input,
      occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: queued }) });
    expect(outputsDigest(a3)).toBe(outputsDigest(declared));
    expect(a3.cacheBands.length).toBe(210);
    // A read that is merely wider (no evidence in the extra days) changes nothing.
    const wideEmpty = await computeAnalyticsV2({ ...a3Input,
      occurrenceRange: { fromDay: addDays(TODAY, -400), throughDay: addDays(TODAY, 2) } });
    expect(outputsDigest(wideEmpty)).toBe(outputsDigest(declared));

    // Evidence 200 days back (older than the 170-day analysis horizon, not
    // queued) is part of the owner's history: production builds a cache day
    // for every delivered day and its `all` window has no lower bound, so the
    // day gets its cache bands and owner-day row. A day after today never
    // enters an output, however the read was declared.
    const first = syntheticOwner(1);
    const tomorrow = addDays(TODAY, 1), old = addDays(TODAY, -200);
    const withOld = new Map(corpus.occurrencesByOwner.get(first.digest)!);
    withOld.set(old, composeFacts(first, old).get(old)!);
    const older = new Map([...corpus.occurrencesByOwner, [first.digest, withOld]]);
    const history = await computeAnalyticsV2({ ...a3Input, occurrencesByOwner: older });
    const withTomorrow = new Map(withOld);
    withTomorrow.set(tomorrow, composeFacts(first, tomorrow).get(tomorrow)!);
    const wider = new Map([...corpus.occurrencesByOwner, [first.digest, withTomorrow]]);
    const widened = await computeAnalyticsV2({ ...a3Input, occurrencesByOwner: wider,
      occurrenceRange: { fromDay: addDays(TODAY, -220), throughDay: addDays(TODAY, 2) } });
    expect(outputsDigest(widened)).toBe(outputsDigest(history));
    expect(widened.cacheBands.filter((row) => row.day === old).length).toBeGreaterThan(0);
    expect(widened.cacheBands.filter((row) => row.day !== old)).toEqual(declared.cacheBands);
    expect(widened.ownerDays.some((row) => row.day === old && row.ownerDigest === first.digest)).toBe(true);
    expect(widened.cacheBands.every((row) => row.day <= TODAY)).toBe(true);
    expect(widened.ownerDays.every((row) => row.day !== tomorrow)).toBe(true);
    // The old day is not queued, so no community day changes.
    expect(widened.dailyCandidates).toEqual(declared.dailyCandidates);

    // Without a declared range, evidence after today is a caller defect.
    await expect(computeAnalyticsV2({ ...a3Input, occurrencesByOwner: wider }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrencesByOwner.range");
  }, 240_000);

  it("keeps cache history older than the 170-day analysis horizon (no lower bound, as production)", async () => {
    const corpus = composeProofCorpus();
    const queued = corpus.publishedDays;
    const first = syntheticOwner(1);
    const history = new Map(corpus.occurrencesByOwner.get(first.digest)!);
    const ancient = [addDays(TODAY, -400), addDays(TODAY, -171), addDays(TODAY, -165)];
    for (const day of ancient) history.set(day, composeFacts(first, day).get(day)!);
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner, [first.digest, history]]);
    const input = { owners: corpus.owners, occurrencesByOwner,
      devicesByDay: oneDevicePerOwner(occurrencesByOwner, queued), queuedDays: queued, nowMs: NOW_MS, revisionSeed: 0 };
    const outputs = await computeAnalyticsV2(input);
    // Every evidence day, however old, carries cache bands; the old today-162
    // default dropped all three of these days.
    for (const day of ancient) {
      expect(outputs.cacheBands.some((row) => row.ownerDigest === first.digest && row.day === day), day).toBe(true);
    }
    // An explicit horizon at the first evidence day gives the same outputs;
    // its 7-day lookback is read (and empty).
    const explicit = await computeAnalyticsV2({ ...input, cacheFromDay: ancient[0],
      occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: queued, cacheFromDay: ancient[0] }) });
    expect(outputsDigest(explicit)).toBe(outputsDigest(outputs));
    expect(analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: queued, cacheFromDay: ancient[0] }))
      .toEqual({ fromDay: addDays(TODAY, -407), throughDay: TODAY });
    // An explicit horizon later than old evidence is honoured (A-3 never passes one).
    const bounded = await computeAnalyticsV2({ ...input, cacheFromDay: addDays(TODAY, -162),
      occurrenceRange: { fromDay: addDays(TODAY, -400), throughDay: TODAY } });
    expect(bounded.cacheBands.some((row) => ancient.includes(row.day))).toBe(false);
  }, 240_000);

  it("(d) blocks every candidate day of a conflict and withholds that community day", async () => {
    const corpus = composeProofCorpus();
    const conflictOwner = syntheticOwner(5);
    const conflictDay = addDays(TODAY, -1);
    const owners = [...corpus.owners, effectiveV2Owner(conflictOwner)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner,
      [conflictOwner.digest, conflictFacts(conflictOwner, conflictDay)]]);
    const outputs = await computeAnalyticsV2(inputFor({ owners, occurrencesByOwner }, corpus.publishedDays));

    expect(outputs.blockedDays).toEqual([conflictDay, TODAY]);
    expect(outputs.dailyCandidates.map((candidate) => candidate.day))
      .toEqual(corpus.publishedDays.filter((day) => day !== conflictDay && day !== TODAY));
    const refused = refusalsOf(outputs, conflictOwner.digest);
    for (const day of [conflictDay, TODAY]) {
      expect(refused).toContainEqual({ ownerDigest: conflictOwner.digest, day, family: "daily",
        reason: "source_conflict_or_order" });
      expect(outputs.ownerDays).toContainEqual({ ownerDigest: conflictOwner.digest, day, daily: null,
        refusal: "source_conflict_or_order" });
    }
    // Its scalar window is incomplete without the refused days: no fit, no cohort seat.
    expect(refused).toContainEqual({ ownerDigest: conflictOwner.digest, day: TODAY, family: "scalar",
      reason: "incomplete_window" });
    expect(fitOwners(outputs)).not.toContain(conflictOwner.digest);
    // The unaffected days still publish with all four owners.
    for (const candidate of outputs.dailyCandidates) {
      expect(candidate.payload.totals.contributingParticipants).toBe(4);
    }
    // No other owner is touched.
    expect(outputs.refusals.every((refusal) => refusal.ownerDigest === conflictOwner.digest)).toBe(true);
  }, 120_000);

  it("(e) refuses non-effective owners: v0.2 blocks nothing, typed non-effective evidence blocks its days", async () => {
    const corpus = composeProofCorpus();
    const legacy = syntheticOwner(6), v1Unknown = syntheticOwner(7), v1Known = syntheticOwner(8);
    const knownDay = corpus.publishedDays[2]!;
    const owners = [...corpus.owners, legacyOnlyV2Owner(legacy), v1OnlyV2Owner(v1Unknown)];
    const outputsUnknown = await computeAnalyticsV2(inputFor({ owners, occurrencesByOwner: corpus.occurrencesByOwner },
      corpus.publishedDays));
    expect(refusalsOf(outputsUnknown, legacy.digest)).toEqual([{ ownerDigest: legacy.digest, day: null, family: "owner",
      reason: "non_effective_source_unported" }]);
    // A typed non-effective owner whose evidence was not supplied blocks every queued day.
    expect(outputsUnknown.blockedDays).toEqual(corpus.publishedDays);
    expect(outputsUnknown.dailyCandidates).toEqual([]);
    expect(refusalsOf(outputsUnknown, v1Unknown.digest).filter((refusal) => refusal.family === "daily").length)
      .toBe(corpus.publishedDays.length);

    // v0.2 alone blocks nothing; supplied v1 evidence blocks only its own days.
    const v1Facts = new Map([[knownDay, composeFacts(v1Known).get(knownDay)!]]);
    const outputs = await computeAnalyticsV2(inputFor({
      owners: [...corpus.owners, legacyOnlyV2Owner(legacy), v1OnlyV2Owner(v1Known)],
      occurrencesByOwner: new Map([...corpus.occurrencesByOwner, [v1Known.digest, v1Facts]]),
    }, corpus.publishedDays));
    expect(outputs.blockedDays).toEqual([knownDay]);
    expect(outputs.dailyCandidates.length).toBe(corpus.publishedDays.length - 1);
    expect(refusalsOf(outputs, v1Known.digest)).toEqual([
      { ownerDigest: v1Known.digest, day: null, family: "owner", reason: "non_effective_source_unported" },
      { ownerDigest: v1Known.digest, day: knownDay, family: "daily", reason: "non_effective_source_unported" },
    ]);
    for (const outputsCase of [outputsUnknown, outputs]) {
      expect(fitOwners(outputsCase)).toEqual(corpus.owners.map((owner) => owner.ownerDigest));
      expect((outputsCase.preview as AdminCommunityAllowancePreview).coverage.uploadingParticipantCount).toBe(3);
      expect(outputsCase.ownerDays.every((row) => corpus.occurrencesByOwner.has(row.ownerDigest))).toBe(true);
    }
  }, 120_000);

  it("keeps every refusal inside the closed contract reasons", async () => {
    const reasons = new Set<string>(ANALYTICS_V2_REFUSAL_REASONS);
    const corpus = composeProofCorpus();
    const conflictOwner = syntheticOwner(5);
    const outputs = await computeAnalyticsV2(inputFor({
      owners: [...corpus.owners, effectiveV2Owner(conflictOwner), legacyOnlyV2Owner(syntheticOwner(6))],
      occurrencesByOwner: new Map([...corpus.occurrencesByOwner,
        [conflictOwner.digest, conflictFacts(conflictOwner, addDays(TODAY, -45))]]),
    }, corpus.publishedDays));
    expect(outputs.refusals.every((refusal: AnalyticsV2Refusal) => reasons.has(refusal.reason))).toBe(true);
    expect(new Set(outputs.refusals.map((refusal) => refusal.family))).toEqual(new Set(["owner", "daily", "scalar", "model", "cache"]));
    // Refusals come out in the deterministic contract order, without duplicates.
    expect([...outputs.refusals].sort(compareAnalyticsV2Refusals)).toEqual(outputs.refusals);
    expect(new Set(outputs.refusals.map((refusal) => canonicalJson(refusal))).size).toBe(outputs.refusals.length);
  }, 120_000);

  it("streams owners through a loader with outputs identical to the in-memory input", async () => {
    const corpus = composeProofCorpus();
    const conflictOwner = syntheticOwner(5);
    const owners = [...corpus.owners, effectiveV2Owner(conflictOwner)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner,
      [conflictOwner.digest, conflictFacts(conflictOwner, addDays(TODAY, -1))]]);
    const input = inputFor({ owners, occurrencesByOwner }, corpus.publishedDays);
    const inMemory = await computeAnalyticsV2(input);
    const ownerEvidence = new Map([...occurrencesByOwner].map(([digest, days]) => [digest, evidenceOf(days)]));
    const loads: string[] = [];
    const streamed = await computeAnalyticsV2({ ...input, occurrencesByOwner: new Map(), ownerEvidence,
      loadOwnerOccurrences: async (digest) => { loads.push(digest); return occurrencesByOwner.get(digest)!; },
      memoryProbe: () => 1_000 });
    // Each effective owner is loaded once, in digest order.
    expect(loads).toEqual(owners.map((owner) => owner.ownerDigest).sort());
    const { timings: _a, resources: inMemoryResources, ...expected } = inMemory;
    const { timings: streamedTimings, resources: streamedResources, ...actual } = streamed;
    expect(sha(canonicalJson(actual))).toBe(sha(canonicalJson(expected)));
    expect(Object.keys(streamedTimings)).toContain("read");
    // Same counts and estimates; only the sampled heap differs (the probe).
    expect(streamedResources!.owners.map(({ heapPeakBytes: _peak, ...entry }) => entry))
      .toEqual(inMemoryResources!.owners.map(({ heapPeakBytes: _peak, ...entry }) => entry));
    expect(streamedResources!.owners.every((entry) => entry.heapPeakBytes === 1_000)).toBe(true);
    expect(inMemoryResources!.owners.every((entry) => entry.heapPeakBytes === null)).toBe(true);

    // A load that differs from its counts fails the run; so do mixed modes.
    const first = owners[0]!.ownerDigest;
    await expect(computeAnalyticsV2({ ...input, occurrencesByOwner: new Map(), ownerEvidence,
      loadOwnerOccurrences: async (digest) => (digest === first ? new Map() : occurrencesByOwner.get(digest)!) }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:loadOwnerOccurrences.evidence");
    await expect(computeAnalyticsV2({ ...input, ownerEvidence,
      loadOwnerOccurrences: async (digest) => occurrencesByOwner.get(digest)! }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrencesByOwner.streamedEffectiveOwner");
    await expect(computeAnalyticsV2({ ...input, ownerEvidence }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:ownerEvidence");
    await expect(computeAnalyticsV2({ ...input, occurrencesByOwner: new Map(),
      ownerEvidence: new Map([...ownerEvidence].slice(1)),
      loadOwnerOccurrences: async (digest) => occurrencesByOwner.get(digest)! }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:ownerEvidence.missingEffectiveOwner");
  }, 240_000);

  it("(memory budget) refuses an owner whose estimate exceeds the budget before reading it, and counts it", async () => {
    const corpus = composeProofCorpus();
    const big = syntheticOwner(4, "pro");
    const bigDay = corpus.publishedDays[3]!;
    const owners = [...corpus.owners, effectiveV2Owner(big)];
    // Ten analysis days of 120,000 usage rows, one of them queued: 1.2M rows.
    const bigEvidence = new Map(Array.from({ length: 10 }, (_, index) => [addDays(bigDay, -index),
      { usage: 120_000, quota: 9, session: 1 }]));
    const ownerEvidence = new Map<string, ReadonlyMap<string, { usage: number; quota: number; session: number }>>(
      [...corpus.occurrencesByOwner].map(([digest, days]) => [digest, evidenceOf(days)]));
    ownerEvidence.set(big.digest, bigEvidence);
    const loads: string[] = [];
    const base = { ...inputFor({ owners, occurrencesByOwner: corpus.occurrencesByOwner }, corpus.publishedDays),
      occurrencesByOwner: new Map(), ownerEvidence,
      loadOwnerOccurrences: async (digest: string) => {
        loads.push(digest);
        return corpus.occurrencesByOwner.get(digest) ?? new Map();
      } };
    const outputs = await computeAnalyticsV2(base);
    // Never read; one owner refusal and one daily refusal per queued day with evidence.
    expect(loads).not.toContain(big.digest);
    const bigQueued = corpus.publishedDays.filter((day) => bigEvidence.has(day));
    expect(bigQueued).toEqual([bigDay]);
    expect(refusalsOf(outputs, big.digest)).toEqual([
      { ownerDigest: big.digest, day: null, family: "owner", reason: "memory_budget" },
      { ownerDigest: big.digest, day: bigDay, family: "daily", reason: "memory_budget" },
    ]);
    expect(outputs.blockedDays).toEqual([bigDay]);
    expect(outputs.dailyCandidates.map((candidate) => candidate.day))
      .toEqual(corpus.publishedDays.filter((day) => day !== bigDay));
    // Nothing of it is written; it leaves the fit cohort and is a refused member of every model date.
    for (const rows of [outputs.ownerDays, outputs.cacheBands, outputs.ownerFits, outputs.ownerModelDates]) {
      expect((rows as ReadonlyArray<{ ownerDigest: string }>).some((row) => row.ownerDigest === big.digest)).toBe(false);
    }
    const preview = outputs.preview as AdminCommunityAllowancePreview;
    expect(preview.coverage.uploadingParticipantCount).toBe(3);
    expect(preview.models.days.length).toBe(ANALYTICS_V2_MODEL_DATES);
    expect(preview.models.days.every((day) => day.v1ParticipantCount === 4 && day.refusedParticipantCount === 1)).toBe(true);
    const estimate = analyticsV2OwnerMemoryEstimate(bigEvidence, addDays(TODAY, -169), TODAY);
    expect(outputs.resources!.owners.find((entry) => entry.ownerDigest === big.digest)).toEqual({
      ownerDigest: big.digest, usage: 1_200_000, quota: 90, session: 10, analysisUsage: 1_200_000,
      maxDayOccurrences: 120_010, estimateBytes: estimate.estimateBytes, admitted: false, heapPeakBytes: null });
    expect(estimate.estimateBytes).toBeGreaterThan(ANALYTICS_V2_DEFAULT_RESOURCES.memoryBudgetBytes);
    // The other owners are exactly what they are without it.
    const without = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays));
    expect(outputs.ownerFits).toEqual(without.ownerFits);
    expect(outputs.cacheBands).toEqual(without.cacheBands);

    // The decision follows the configured budget only: at 30 GiB it is admitted (and then read).
    const roomy = { ...ANALYTICS_V2_DEFAULT_RESOURCES, memoryBudgetBytes: 30_720 * 1_048_576 };
    await expect(computeAnalyticsV2({ ...base, resources: roomy })).rejects.toThrow(
      "ANALYTICS_V2_INPUT_INVALID:loadOwnerOccurrences.evidence");
    expect(loads.filter((digest) => digest === big.digest).length).toBe(1);
    // A day over one read call's ceiling refuses its owner at any budget.
    const huge = new Map([...ownerEvidence, [big.digest, new Map([[bigDay, { usage: 2_000_001, quota: 0, session: 0 }]])]]);
    const hugeOutputs = await computeAnalyticsV2({ ...base, ownerEvidence: huge, resources: roomy });
    expect(refusalsOf(hugeOutputs, big.digest)[0]).toEqual({ ownerDigest: big.digest, day: null, family: "owner",
      reason: "memory_budget" });
  }, 240_000);

  it("estimates owner memory deterministically and validates resources", () => {
    const evidence = new Map([
      [addDays(TODAY, -300), { usage: 1_000, quota: 10, session: 1 }],
      [addDays(TODAY, -5), { usage: 2_000, quota: 20, session: 2 }],
    ]);
    const model = ANALYTICS_V2_MEMORY_MODEL;
    expect(analyticsV2OwnerMemoryEstimate(evidence, addDays(TODAY, -169), TODAY)).toEqual({
      occurrences: { usage: 3_000, quota: 30, session: 3 }, analysisUsage: 2_000, maxDayOccurrences: 2_022,
      estimateBytes: model.ownerOverheadBytes + 3_000 * model.heldBytesPerOccurrence.usage
        + 30 * model.heldBytesPerOccurrence.quota + 3 * model.heldBytesPerOccurrence.session
        + 2_000 * model.preparedBytesPerAnalysisUsage + 2_022 * model.transientBytesPerLargestDayOccurrence,
    });
    expect(validAnalyticsV2Resources(ANALYTICS_V2_DEFAULT_RESOURCES)).toEqual(ANALYTICS_V2_DEFAULT_RESOURCES);
    for (const resources of [
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, maxDayOccurrences: 19_999 },
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, maxDayOccurrences: 250_001 },
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, maxDayRecordBytes: 32 * 1_048_576 - 1 },
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, memoryBudgetBytes: 1_024 * 1_048_576 - 1 },
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, memoryBudgetBytes: 30_720 * 1_048_576 + 1 },
      { ...ANALYTICS_V2_DEFAULT_RESOURCES, extra: 1 },
    ]) {
      expect(() => validAnalyticsV2Resources(resources)).toThrow("ANALYTICS_V2_INPUT_INVALID:resources");
    }
    // The defaults: an 8 GiB task with a 6,144 MiB heap.
    expect(ANALYTICS_V2_DEFAULT_RESOURCES).toEqual({ memoryBudgetBytes: 4_608 * 1_048_576, maxDayOccurrences: 250_000,
      maxDayRecordBytes: 256 * 1_048_576 });
  });

  it("withholds model days nobody could evaluate and still builds a valid preview", async () => {
    const outputs = await computeAnalyticsV2(inputFor({ owners: [legacyOnlyV2Owner(syntheticOwner(6))],
      occurrencesByOwner: new Map() }, [TODAY]));
    const preview = outputs.preview as AdminCommunityAllowancePreview;
    expect(preview).not.toBeNull();
    expect(preview.models.days).toEqual([]);
    expect(preview.coverage.uploadingParticipantCount).toBe(0);
    // An empty cohort's queued day is a real zero day, as production publishes it.
    expect(outputs.dailyCandidates.map((candidate) => candidate.payload.totals.contributingParticipants)).toEqual([0]);
    expect(ANALYTICS_V2_PHASES).toEqual(expect.arrayContaining(Object.keys(outputs.timings)));
  }, 120_000);

  it("fails closed on an incomplete or inconsistent input", async () => {
    const corpus = composeProofCorpus();
    const base = inputFor(corpus, corpus.publishedDays);
    // A read range that misses part of the 170-day analysis horizon.
    await expect(computeAnalyticsV2({ ...base, occurrenceRange: { fromDay: addDays(TODAY, -100), throughDay: TODAY } }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrenceRange");
    // A queued day outside the read range.
    await expect(computeAnalyticsV2({ ...base, queuedDays: [addDays(TODAY, -400)] }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrenceRange");
    // An effective owner whose occurrences were never read.
    const missing = new Map(corpus.occurrencesByOwner);
    missing.delete(corpus.owners[0]!.ownerDigest);
    await expect(computeAnalyticsV2({ ...base, occurrencesByOwner: missing }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrencesByOwner.missingEffectiveOwner");
    // Routing that contradicts production's hasEffective rule.
    await expect(computeAnalyticsV2({ ...base, owners: [{ ...corpus.owners[0]!, hasEffective: false }] }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:owners");
    // Evidence outside the declared range.
    const outside = new Map(corpus.occurrencesByOwner);
    outside.set(corpus.owners[0]!.ownerDigest, new Map([[addDays(TODAY, 1), { usage: [], quota: [], session: [] }]]));
    await expect(computeAnalyticsV2({ ...base, occurrencesByOwner: outside }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:occurrencesByOwner.range");
    // A published day whose contributing devices were never counted.
    await expect(computeAnalyticsV2({ ...base, devicesByDay: new Map() }))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:devicesByDay.missingDay");
    // A daily stamp that is not a canonical instant.
    const outputs = await computeAnalyticsV2(base);
    await expect(stampAnalyticsV2DailyPayload(outputs.dailyCandidates[0]!, { revision: 2, releasedAt: "yesterday" }))
      .rejects.toThrow("ANALYTICS_V2_DAILY_STAMP_INVALID");
  }, 120_000);

  it("names the read range a run needs", () => {
    expect(analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: [] }))
      .toEqual({ fromDay: addDays(TODAY, -169), throughDay: TODAY });
    expect(analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: { days: [addDays(TODAY, -300)], lastSequence: 9 } }))
      .toEqual({ fromDay: addDays(TODAY, -300), throughDay: TODAY });
    expect(analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays: [], cacheFromDay: addDays(TODAY, -364) }))
      .toEqual({ fromDay: addDays(TODAY, -371), throughDay: TODAY });
  });
});
