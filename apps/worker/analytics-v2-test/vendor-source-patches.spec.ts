// The vendored kernels' reviewed source patches (vendor-analytics-kernels.mjs
// SOURCE_PATCHES) keep d43c8f92's answers exactly. Each patch is compared here
// with the unpatched behaviour it replaces, on synthetic records only:
//
// - usage-row-evidence-memo: a usage row evaluated again (the same object, as
//   the native path's model windows re-read an owner's prepared rows) gives
//   exactly what a fresh copy of the row gives, the session step still runs
//   before the price on every call, and a row whose record_json or
//   observed_at changed is evaluated again;
// - daily-fold-trusted-state: folding an owner-day one record at a time with
//   the trusted fold returns, after every record, exactly the state the
//   checked fold returns, including past the 200-cell top-K, and a record the
//   checked fold refuses is refused the same way.
import { describe, expect, it } from "vitest";
import {
  advanceV11UsageReduction,
  createV11QuotaAcquisitionIdentity,
  finishV11UsageReduction,
  prepareV11UsageFeature,
  type UsageRow,
  v11PreparedUsageDayRow,
} from "../vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11";
import {
  appendEffectiveQuotaDay,
  finishEffectiveQuotaDay,
  foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow,
} from "../vendor/analytics-d43c8f92/apps/worker/src/effective-quota-day";
import { modelHistoryWindow } from "../vendor/analytics-d43c8f92/apps/worker/src/model-history-window";
import type { EffectiveTelemetryOccurrence } from "../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-effective-reader";
import type { V11SourcePin } from "../vendor/analytics-d43c8f92/apps/worker/src/telemetry-v11-domain";
import {
  createV11DailyProjectionValues,
  finalizeV11DailyProjectionValues,
  foldV11DailyProjectionValues,
  foldV11DailyProjectionValuesTrusted,
  MAX_V11_DAILY_MODEL_CELLS,
  validateV11DailyProjectionValues,
} from "../vendor/analytics-d43c8f92/apps/worker/src/v11-daily-projection-values";
import { v11UsageRecord } from "./kernel-parity/helpers/telemetry-v11";

const day = "2026-09-28", start = Date.parse(day), owner = "a".repeat(64);
const account = `account-track:v2:${"b".repeat(64)}`;
const attribution = { accountBasis: "same_source" as const, accountTrackId: account,
  planBasis: "same_source_occurrence" as const, planType: "pro" as const, planEraId: null };
const noRead = (): never => { throw new Error("UNEXPECTED_DATABASE_READ"); };
const db = { prepare: noRead, batch: noRead, exec: noRead, withSession: noRead, dump: noRead } as unknown as D1Database;
const pin: V11SourcePin = { source: "v1.1", participantId: "synthetic-patch-owner", generationId: "synthetic-patch-generation",
  fromDay: day, throughDay: day, inputRevision: 1, mutationEpoch: 1, fingerprint: "c".repeat(64) };
const MODELS = ["gpt-5.4", "gpt-5.3-codex-spark", "unknown-future-model", "gpt-5.5"];

function usageRow(index: number, changes: Partial<ReturnType<typeof v11UsageRecord>> = {}): UsageRow {
  const record = v11UsageRecord(day, "a", { eventId: `event:synthetic:${index.toString().padStart(4, "0")}`,
    eventTime: new Date(start + (index + 0.5) * 600_000).toISOString(),
    sessionUuid: `synthetic-private-session-${index % 3}`, apiServiceTier: "standard",
    accountPlanAttribution: attribution, modelId: MODELS[index % MODELS.length], ...changes });
  return { occurrence_id: record.eventId, observed_at: record.eventTime, provider: record.provider,
    session_uuid: record.sessionUuid, record_json: JSON.stringify(record) };
}
const fresh = (row: UsageRow): UsageRow => ({ ...row });
const sessionDigest = async (provider: string, session: string) => `${provider}:${session}`;

async function acquisition() {
  const rows: EffectiveTelemetryOccurrence[] = Array.from({ length: 9 }, (_, index) => {
    const record = { schemaVersion: "quota-observation-v1.1", observationId: `quota:synthetic:${index}`,
      observedTime: new Date(start + index * 3_600_000).toISOString(), provider: "openai_codex", planType: "pro",
      planVariant: "unknown", limitId: "codex", slot: "seven_day", usedPercent: 5 + index * 10,
      windowDurationMinutes: 10080, resetsAt: new Date(start + 8 * 86_400_000).toISOString(),
      accountPlanAttribution: attribution };
    return { methodVersion: "effective-telemetry-owner-day-v1", stream: "quota", participantId: pin.participantId,
      ownerDigest: owner, occurrenceId: record.observationId, eventTime: record.observedTime, eventTimeConflict: false,
      status: "compatible", sourceCount: 1, sourceFormats: ["v11"], sourceRowIds: [], sourceRecordKeys: [],
      recordJson: JSON.stringify(record) };
  });
  const pending = appendEffectiveQuotaDay(null, day, rows.map((value, index) => mapEffectiveQuotaPageRow(value, day, index + 1)), 10080);
  const value = pending && finishEffectiveQuotaDay(pending);
  if (!value) throw new Error("SYNTHETIC_QUOTA_REFUSED");
  const identity = createV11QuotaAcquisitionIdentity(pin, Date.parse(modelHistoryWindow(day).fixedNow));
  const folded = foldEffectiveQuotaDays(identity, [value], [day]);
  if (!folded || folded.status !== "complete") throw new Error("SYNTHETIC_QUOTA_INCOMPLETE");
  return { identity: folded.identity, planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
}

/** The paged reduction and its finish over `rows`, read from memory 200 rows a page. */
async function reduce(rows: readonly UsageRow[], metric: "fits" | "model") {
  const quotaAcquisition = await acquisition();
  const nowMs = Date.parse(modelHistoryWindow(day).fixedNow);
  const options = { nowMs, quotaAcquisition, scalarRequested: metric === "fits", effectiveUsageReader: {
    days: [day],
    async readPage({ afterTime, afterOccurrence }: { afterTime: string; afterOccurrence: string }) {
      const offset = rows.findIndex((value) => value.observed_at > afterTime
        || value.observed_at === afterTime && value.occurrence_id > afterOccurrence);
      const from = offset < 0 ? rows.length : offset, page = rows.slice(from, from + 200);
      return { rows: page, complete: from + page.length >= rows.length };
    },
  } };
  let state = null;
  for (let call = 0; call < 8 && !state?.complete; call += 1) {
    state = await advanceV11UsageReduction(db, pin, options,
      { remainingQueries: 1_024, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 }, state, 1_024);
  }
  return { state, result: await finishV11UsageReduction(db, pin, options, state!, metric) };
}

describe("source patch usage-row-evidence-memo", () => {
  const rows = Array.from({ length: 120 }, (_, index) => usageRow(index));
  const conflicted = usageRow(120, { accountPlanAttribution: { ...attribution, planBasis: "conflicted" } });

  it("a row evaluated again answers exactly as a fresh copy of it, for the day row and the feature", async () => {
    for (const row of [...rows, conflicted]) {
      const expected = await v11PreparedUsageDayRow(fresh(row), sessionDigest);
      expect(await v11PreparedUsageDayRow(row, sessionDigest)).toEqual(expected);
      expect(await v11PreparedUsageDayRow(row, sessionDigest)).toEqual(expected);
      const feature = await prepareV11UsageFeature(fresh(row), owner);
      expect(await prepareV11UsageFeature(row, owner)).toEqual(feature);
    }
  });

  it("the paged reduction over re-read rows equals the reduction over fresh rows, for fits and model", async () => {
    for (const metric of ["fits", "model"] as const) {
      const reference = await reduce(rows.map(fresh), metric);
      expect(reference.state?.commonRefusal).toBeNull();
      expect(reference.state?.usageEventCount).toBeGreaterThan(0);
      expect(await reduce(rows, metric)).toEqual(reference);
      expect(await reduce(rows, metric)).toEqual(reference);
    }
  });

  it("keeps the session step before the price: a memoized unpriceable row past the session bound still refuses", async () => {
    const row = usageRow(7, { components: { inputUncachedTokens: null, inputCacheReadTokens: null,
      inputCacheWriteTokens: null, outputTextTokens: null, outputReasoningTokens: null, outputCombinedTokens: null } });
    expect((await v11PreparedUsageDayRow(row, sessionDigest)).status).toBe("skipped");
    expect(await v11PreparedUsageDayRow(row, sessionDigest, new Set(), 0))
      .toEqual({ status: "refused", reason: "session_interval_scope_limit_exceeded" });
  });

  it("an unreadable record refuses on every evaluation", async () => {
    const row: UsageRow = { ...usageRow(3), record_json: "{" };
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await v11PreparedUsageDayRow(row, sessionDigest))
        .toEqual({ status: "refused", reason: "invalid_attribution_record" });
    }
  });

  it("evaluates a row again when its record_json or observed_at changed", async () => {
    const row = usageRow(5, { modelId: "gpt-5.4" });
    await v11PreparedUsageDayRow(row, sessionDigest);
    const other = usageRow(5, { modelId: "gpt-5.3-codex-spark" });
    row.record_json = other.record_json;
    expect(await v11PreparedUsageDayRow(row, sessionDigest)).toEqual(await v11PreparedUsageDayRow(fresh(other), sessionDigest));
    row.observed_at = new Date(start + 86_399_000).toISOString();
    expect(await v11PreparedUsageDayRow(row, sessionDigest)).toEqual(await v11PreparedUsageDayRow(fresh(row), sessionDigest));
  });
});

describe("source patch daily-fold-trusted-state", () => {
  const providers = ["openai_codex", "anthropic_claude"];
  function records(count: number): unknown[] {
    const out: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      // 260 distinct (provider, model) cells in a shuffled order, so the
      // lexical top 200 moves while the day is folded and cells overflow.
      const model = `model-${((index * 7919) % 260).toString().padStart(3, "0")}`;
      out.push(v11UsageRecord(day, "a", { eventId: `event:synthetic:${index.toString().padStart(5, "0")}`,
        eventTime: new Date(start + index * 1_000).toISOString(), provider: providers[index % 2],
        modelId: index % 11 === 0 ? "gpt-5.4" : model }));
    }
    return out;
  }

  it("returns exactly the checked fold's state after every record, past the top-K", () => {
    let checked = createV11DailyProjectionValues(day), trusted = createV11DailyProjectionValues(day);
    for (const record of records(900)) {
      checked = foldV11DailyProjectionValues(checked, [record]);
      trusted = foldV11DailyProjectionValuesTrusted(trusted, [record]);
      expect(JSON.stringify(trusted)).toBe(JSON.stringify(checked));
    }
    expect(checked.cells).toHaveLength(MAX_V11_DAILY_MODEL_CELLS);
    expect(checked.omitted.usageEvents).toBeGreaterThan(0);
    validateV11DailyProjectionValues(trusted);
    expect(JSON.stringify(finalizeV11DailyProjectionValues(trusted)))
      .toBe(JSON.stringify(finalizeV11DailyProjectionValues(checked)));
  });

  it("refuses a record the checked fold refuses, with the same error", () => {
    const state = foldV11DailyProjectionValuesTrusted(createV11DailyProjectionValues(day), records(3).slice(0, 1));
    const otherDay = v11UsageRecord("2026-09-27", "a", { eventId: `event:synthetic:${"9".repeat(5)}` });
    expect(() => foldV11DailyProjectionValues(state, [otherDay])).toThrow("V11_DAILY_PROJECTION_VALUES_INVALID");
    expect(() => foldV11DailyProjectionValuesTrusted(state, [otherDay])).toThrow("V11_DAILY_PROJECTION_VALUES_INVALID");
  });
});
