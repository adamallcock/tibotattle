// Unit spec for the interim frozen public read (owner decision OD-10, C-IPR):
// the closed community-daily-read-v1.0 validation of the export, the sha256
// pin, the capture facts, the per-request projection and the labelling.
//
// The fixtures are the Q-1 oracle golden (production code's own output over a
// synthetic corpus) widened to a full-year window, and variants derived from
// it. Everything is synthetic and content-free. The PostgreSQL behaviour of
// the route and the loader is in postgres-test/analytics-v2-interim-public-read.spec.mjs.
import { describe, expect, it } from "vitest";
import {
  INTERIM_PUBLIC_READ_ERROR_CODES,
  INTERIM_PUBLIC_READ_HEADERS,
  INTERIM_PUBLIC_READ_MAX_BYTES,
  InterimPublicReadError,
  interimPublicReadHeaders,
  normalizeInterimCapturedAt,
  prepareInterimPublicRead,
  projectInterimPublicRead,
  validateInterimCaptureFacts,
  verifyInterimPublicReadRow,
} from "../src/analytics-v2/interim-public-read";
// The d43c8f92 site reader that shipped with the golden's code.
import { normalizeCommunityDailySeries } from "../vendor/analytics-d43c8f92/apps/web/public/community-data.js";
import { ANALYTICS_V2_CACHE_RETENTION_BAND_IDS } from "../src/analytics-v2/cache-windows-sql";
import {
  FIXTURE_CAPTURED_AT,
  FIXTURE_EVIDENCE_DATE,
  FIXTURE_SOURCE_COMMIT,
  ORACLE_GOLDEN_RESPONSES,
  denseGoldenExportBody,
  exportBytes,
  exportInput,
  goldenExportBody,
  oracleGoldenExportBody,
  sha256Hex,
  withV10Breakdowns,
  withV12Breakdowns,
} from "./fixtures/interim-public-read-export.mjs";

type Body = Record<string, any>;

async function refusal(promise: Promise<unknown>): Promise<InterimPublicReadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InterimPublicReadError);
    return error as InterimPublicReadError;
  }
  throw new Error("expected a refusal");
}

/** Prepare a mutated golden body with its own correct pin: only the contract can refuse it. */
async function prepareMutated(mutate: (body: Body) => void, facts: Record<string, unknown> = {}) {
  const body = goldenExportBody() as Body;
  mutate(body);
  return prepareInterimPublicRead(exportInput(body, facts));
}

async function refuseMutated(
  mutate: (body: Body) => void,
  code: string,
  detail: string,
  facts: Record<string, unknown> = {},
) {
  const error = await refusal(prepareMutated(mutate, facts));
  expect([error.code, error.detail]).toEqual([code, detail]);
}

const CONTRACT = "INTERIM_PUBLIC_READ_CONTRACT_INVALID";
const EVIDENCE = "INTERIM_PUBLIC_READ_EVIDENCE_INCONSISTENT";

describe("an accepted export", () => {
  it("accepts the production-code golden and every derived shape, and records its facts", async () => {
    const prepared = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    expect(prepared.record.evidenceDate).toBe(FIXTURE_EVIDENCE_DATE);
    expect(prepared.record.capturedAt).toBe(FIXTURE_CAPTURED_AT);
    expect(prepared.record.sourceCommit).toBe(FIXTURE_SOURCE_COMMIT);
    expect(prepared.record.payloadSha256).toBe(sha256Hex(exportBytes(goldenExportBody())));
    expect(prepared.record.payloadText).toBe(JSON.stringify(goldenExportBody()));
    expect(prepared.summary).toEqual({
      bytes: exportBytes(goldenExportBody()).byteLength,
      from: "2025-10-01",
      to: "2026-10-01",
      dayCount: 168,
      firstDay: "2026-04-15",
      lastDay: "2026-10-01",
      latestReleasedAt: "2026-10-01T12:00:00.000Z",
      allowanceState: "ready",
      allowanceReadState: "confirmed",
      breakdownsSchemaVersion: "community-allowance-breakdowns-v1.1",
      breakdownDayCount: 69,
      cacheRetentionPresent: true,
    });
    // The dense golden: updating, unavailable, no breakdowns, a cache series.
    const dense = await prepareInterimPublicRead(exportInput(denseGoldenExportBody()));
    expect(dense.summary.allowanceState).toBe("updating");
    expect(dense.summary.allowanceReadState).toBe("temporarily_unavailable");
    expect(dense.summary.breakdownsSchemaVersion).toBeNull();
    // The release-era breakdowns (v1.2, promax) and the earliest (v1.0, no combined).
    const v12 = await prepareInterimPublicRead(exportInput(withV12Breakdowns(goldenExportBody())));
    expect(v12.summary.breakdownsSchemaVersion).toBe("community-allowance-breakdowns-v1.2");
    const v10 = await prepareInterimPublicRead(exportInput(withV10Breakdowns(goldenExportBody())));
    expect(v10.summary.breakdownsSchemaVersion).toBe("community-allowance-breakdowns-v1.0");
  });

  it("accepts every oracle golden: production code's own output, whatever its allowance state", async () => {
    for (const path of ORACLE_GOLDEN_RESPONSES) {
      const body = oracleGoldenExportBody(path) as Body;
      const prepared = await prepareInterimPublicRead(exportInput(body));
      expect(prepared.summary.dayCount, path).toBe(body.days.length);
      expect(prepared.summary.allowanceState, path).toBe(body.allowanceState);
    }
  });

  it("accepts the cache series and breakdowns as optional, and an export with no day", async () => {
    const bare = await prepareMutated((body) => {
      delete body.cacheRetention;
      delete body.allowanceBreakdowns;
      body.allowanceState = "updating";
      body.days = [];
    });
    expect(bare.summary).toMatchObject({ dayCount: 0, firstDay: null, lastDay: null, latestReleasedAt: null,
      cacheRetentionPresent: false, breakdownDayCount: 0 });
  });

  it("serves a body the d43c8f92 site reader accepts, in full and for a sub-range", async () => {
    const { frozen } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    const nowMs = Date.parse("2026-10-02T00:00:00.000Z");
    const full = normalizeCommunityDailySeries(projectInterimPublicRead(frozen, "2025-10-01", "2026-10-01"), { nowMs });
    expect(full.state).toBe("published");
    expect(full.days).toHaveLength(168);
    expect(full.breakdowns).not.toBeNull();
    const part = normalizeCommunityDailySeries(projectInterimPublicRead(frozen, "2026-09-01", "2026-09-15"), { nowMs });
    expect(part.state).toBe("published");
    expect(part.days).toHaveLength(15);
    expect(part.breakdowns?.days.length).toBeGreaterThan(0);
  });

  it("keeps the cache band vocabulary equal to the analytics_v2 reader's", () => {
    const series = goldenExportBody().cacheRetention;
    expect(series.windows[0].bands.map((band: { band: string }) => band.band))
      .toEqual([...ANALYTICS_V2_CACHE_RETENTION_BAND_IDS]);
  });
});

describe("the sha256 pin and the bytes", () => {
  it("refuses a pin that is not 64 lowercase hex, and a pin that does not match", async () => {
    const input = exportInput(goldenExportBody());
    for (const pin of ["", "abc", input.expectedSha256.toUpperCase(), `${input.expectedSha256}0`, null, 7]) {
      expect((await refusal(prepareInterimPublicRead({ ...input, expectedSha256: pin }))).code)
        .toBe("INTERIM_PUBLIC_READ_PIN_INVALID");
    }
    const wrong = `${input.expectedSha256.slice(0, 63)}${input.expectedSha256.endsWith("0") ? "1" : "0"}`;
    expect((await refusal(prepareInterimPublicRead({ ...input, expectedSha256: wrong }))).code)
      .toBe("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
  });

  it("pins the exact bytes: one changed byte, a reformatted body or a trailing newline is refused", async () => {
    const input = exportInput(goldenExportBody());
    const changed = new Uint8Array(input.exportBytes);
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 1;
    expect((await refusal(prepareInterimPublicRead({ ...input, exportBytes: changed }))).code)
      .toBe("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
    const pretty = new TextEncoder().encode(JSON.stringify(goldenExportBody(), null, 2));
    expect((await refusal(prepareInterimPublicRead({ ...input, exportBytes: pretty }))).code)
      .toBe("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
    const newline = new TextEncoder().encode(`${JSON.stringify(goldenExportBody())}\n`);
    expect((await refusal(prepareInterimPublicRead({ ...input, exportBytes: newline }))).code)
      .toBe("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
    // A pinned trailing newline is the same export: whitespace is part of the pinned bytes.
    const accepted = await prepareInterimPublicRead({
      ...input, exportBytes: newline, expectedSha256: sha256Hex(newline),
    });
    expect(accepted.record.payloadText.endsWith("\n")).toBe(true);
  });

  it("refuses bytes that are not strict UTF-8 JSON, even when pinned", async () => {
    const pinned = (bytes: Uint8Array) => ({ ...exportInput(goldenExportBody()), exportBytes: bytes, expectedSha256: sha256Hex(bytes) });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...exportBytes(goldenExportBody())]);
    expect((await refusal(prepareInterimPublicRead(pinned(withBom)))).code).toBe("INTERIM_PUBLIC_READ_EXPORT_NOT_JSON");
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    expect((await refusal(prepareInterimPublicRead(pinned(invalidUtf8)))).code)
      .toBe("INTERIM_PUBLIC_READ_EXPORT_ENCODING_INVALID");
    for (const text of ["not json", "[]", "null", "{}", "{\"schemaVersion\":\"community-daily-read-v1.0\"}"]) {
      const bytes = new TextEncoder().encode(text);
      const error = await refusal(prepareInterimPublicRead(pinned(bytes)));
      expect(["INTERIM_PUBLIC_READ_EXPORT_NOT_JSON", CONTRACT]).toContain(error.code);
    }
    expect((await refusal(prepareInterimPublicRead(pinned(new Uint8Array(0))))).code)
      .toBe("INTERIM_PUBLIC_READ_EXPORT_SIZE_INVALID");
    const oversized = new Uint8Array(INTERIM_PUBLIC_READ_MAX_BYTES + 1).fill(0x20);
    expect((await refusal(prepareInterimPublicRead(pinned(oversized)))).code)
      .toBe("INTERIM_PUBLIC_READ_EXPORT_SIZE_INVALID");
    expect((await refusal(prepareInterimPublicRead({
      ...exportInput(goldenExportBody()), exportBytes: "text" as unknown as Uint8Array,
    }))).code).toBe("INTERIM_PUBLIC_READ_EXPORT_ENCODING_INVALID");
  });

  it("checks the pin before it parses anything", async () => {
    const input = exportInput(goldenExportBody());
    const garbage = new TextEncoder().encode("not json at all");
    // A wrong pin on unparseable bytes is the pin's refusal, not the parser's.
    expect((await refusal(prepareInterimPublicRead({ ...input, exportBytes: garbage }))).code)
      .toBe("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
  });
});

describe("the capture facts", () => {
  it("normalizes a UTC instant to milliseconds and refuses every other form", () => {
    expect(normalizeInterimCapturedAt("2026-10-01T23:30:00Z")).toBe("2026-10-01T23:30:00.000Z");
    expect(normalizeInterimCapturedAt("2026-10-01T23:30:00.5Z")).toBe("2026-10-01T23:30:00.500Z");
    expect(normalizeInterimCapturedAt("2026-10-01T23:30:00.123Z")).toBe("2026-10-01T23:30:00.123Z");
    for (const value of ["2026-10-01", "2026-10-01T23:30:00+00:00", "2026-10-01T23:30:00.1234Z",
      "2026-02-31T00:00:00Z", "2026-10-01 23:30:00Z", "", null, 5, "2026-10-01T24:00:00Z"]) {
      expect(() => normalizeInterimCapturedAt(value)).toThrow(InterimPublicReadError);
    }
  });

  it("requires a 40-hex commit, a calendar evidence date and a capture on that day or the next", () => {
    const good = { capturedAt: "2026-10-01T23:30:00Z", sourceCommit: FIXTURE_SOURCE_COMMIT, evidenceDate: "2026-10-01" };
    expect(validateInterimCaptureFacts(good)).toEqual({
      capturedAt: "2026-10-01T23:30:00.000Z", sourceCommit: FIXTURE_SOURCE_COMMIT, evidenceDate: "2026-10-01",
    });
    expect(validateInterimCaptureFacts({ ...good, capturedAt: "2026-10-02T00:00:00Z" }).evidenceDate).toBe("2026-10-01");
    for (const bad of [
      { sourceCommit: FIXTURE_SOURCE_COMMIT.toUpperCase() }, { sourceCommit: "abc" }, { sourceCommit: `${FIXTURE_SOURCE_COMMIT}0` },
      { evidenceDate: "2026-02-31" }, { evidenceDate: "2026-10-1" }, { evidenceDate: null },
      // Captured before the evidence date, or two days after it: the label would be false.
      { evidenceDate: "2026-10-02" }, { capturedAt: "2026-10-03T00:00:00Z" },
    ]) {
      expect(() => validateInterimCaptureFacts({ ...good, ...bad })).toThrow(InterimPublicReadError);
    }
  });
});

describe("the closed community-daily-read-v1.0 contract", () => {
  it("refuses an unknown or missing key at every level, without echoing the key", async () => {
    await refuseMutated((body) => { body.extra = 1; }, CONTRACT, "$.*");
    await refuseMutated((body) => { delete body.allowanceReadState; }, CONTRACT, "$.allowanceReadState");
    await refuseMutated((body) => { delete body.days; }, CONTRACT, "$.days");
    await refuseMutated((body) => { body.days[0].extra = 1; }, CONTRACT, "days[0].*");
    await refuseMutated((body) => { delete body.days[3].revision; }, CONTRACT, "days[3].revision");
    await refuseMutated((body) => { body.days[0].payload.sessionPath = "/Users/example"; }, CONTRACT, "days[0].payload.*");
    await refuseMutated((body) => { delete body.days[0].payload.totals; }, CONTRACT, "days[0].payload.totals");
    await refuseMutated((body) => { body.days[0].payload.totals.ownerDigest = 1; }, CONTRACT, "days[0].payload.totals.*");
    await refuseMutated((body) => { delete body.days[0].payload.totals.usageEvents; }, CONTRACT, "days[0].payload.totals.usageEvents");
    await refuseMutated((body) => { body.days[0].payload.cells[0].speed = "fast"; }, CONTRACT, "days[0].payload.cells[0].*");
    await refuseMutated((body) => { delete body.days[0].payload.cells[0].provider; }, CONTRACT, "days[0].payload.cells[0].provider");
    await refuseMutated((body) => { body.cacheRetention.extra = 1; }, CONTRACT, "cacheRetention.*");
    await refuseMutated((body) => { body.allowanceBreakdowns.extra = 1; }, CONTRACT, "allowanceBreakdowns.*");
  });

  it("refuses the private and non-current day fields: capacityByPlanType and the per-day allowance", async () => {
    await refuseMutated((body) => { body.days[0].payload.capacityByPlanType = { pro: { capacityUsd: 1, participantCount: 1 } }; },
      CONTRACT, "days[0].payload.*");
    await refuseMutated((body) => {
      body.days[0].payload.allowance = { basis: "x", fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
    }, CONTRACT, "days[0].payload.*");
  });

  it("refuses wrong constants, versions and day wrapper facts", async () => {
    await refuseMutated((body) => { body.schemaVersion = "community-daily-read-v1.1"; }, CONTRACT, "schemaVersion");
    await refuseMutated((body) => { body.allowanceState = "confirmed"; }, CONTRACT, "allowanceState");
    await refuseMutated((body) => { body.allowanceReadState = "ready"; }, CONTRACT, "allowanceReadState");
    await refuseMutated((body) => { body.days[0].payload.schemaVersion = "community-daily-aggregate-v1.1"; }, CONTRACT, "days[0].payload.schemaVersion");
    await refuseMutated((body) => { body.days[0].payload.policyVersion = "other"; }, CONTRACT, "days[0].payload.policyVersion");
    await refuseMutated((body) => { body.days[0].payload.immutableRevision = false; }, CONTRACT, "days[0].payload.immutableRevision");
    await refuseMutated((body) => { body.days[0].payload.recomputesOnLateData = 1; }, CONTRACT, "days[0].payload.recomputesOnLateData");
    await refuseMutated((body) => { body.days[0].payload.day = "2026-04-16"; }, CONTRACT, "days[0].payload.day");
    await refuseMutated((body) => { body.days[0].payload.revision = 2; }, CONTRACT, "days[0].payload.revision");
    await refuseMutated((body) => { body.days[0].payload.aggregateId = "community-daily:2026-04-15:r9"; }, CONTRACT, "days[0].payload.aggregateId");
    await refuseMutated((body) => { body.days[0].payload.releasedAt = "2026-04-16T00:00:00.001Z"; }, CONTRACT, "days[0].payload.releasedAt");
    await refuseMutated((body) => { body.days[0].revision = 0; body.days[0].payload.revision = 0; }, CONTRACT, "days[0].revision");
    await refuseMutated((body) => { body.days[0].revision = 1.5; }, CONTRACT, "days[0].revision");
    await refuseMutated((body) => { body.days[0].releasedAt = "2026-04-16"; }, CONTRACT, "days[0].releasedAt");
    await refuseMutated((body) => { body.days[0].day = "2026-02-31"; }, CONTRACT, "days[0].day");
  });

  it("refuses counts that are not safe non-negative integers, and tokens outside their alphabet", async () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "12", null, Number.NaN]) {
      await refuseMutated((body) => { body.days[0].payload.totals.usageEvents = bad; }, CONTRACT, "days[0].payload.totals.usageEvents");
      await refuseMutated((body) => { body.days[0].payload.cells[0].inputCacheReadTokens = bad; },
        CONTRACT, "days[0].payload.cells[0].inputCacheReadTokens");
    }
    for (const bad of ["", "gpt 5", "a/b", "x".repeat(65), "../etc", "gpt-5\u0000", 5]) {
      await refuseMutated((body) => { body.days[0].payload.cells[0].modelId = bad; }, CONTRACT, "days[0].payload.cells[0].modelId");
    }
    await refuseMutated((body) => { body.days[0].payload.cells = new Array(513).fill(body.days[0].payload.cells[0]); },
      CONTRACT, "days[0].payload.cells");
    await refuseMutated((body) => { body.days[0].payload.cellsTruncated = "false"; }, CONTRACT, "days[0].payload.cellsTruncated");
  });

  it("refuses a spend block that disagrees with its day, or has an unknown shape", async () => {
    const spendDay = (body: Body) => body.days.findIndex((day: Body) => day.payload.apiEquivalentSpend !== undefined);
    const index = spendDay(goldenExportBody());
    expect(index).toBeGreaterThanOrEqual(0);
    const at = `days[${index}].payload.apiEquivalentSpend`;
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.usageEvents += 1; }, CONTRACT, at);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.fullyPricedUsageEvents += 1; }, CONTRACT, at);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.coverage = "partial"; }, CONTRACT, `${at}.coverage`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.knownCostUsd = -1; }, CONTRACT, `${at}.knownCostUsd`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.registrySha256 = "g".repeat(64); }, CONTRACT, `${at}.registrySha256`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.pricingMethodVersion = "v0.6"; }, CONTRACT, `${at}.pricingMethodVersion`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.currency = "EUR"; }, CONTRACT, `${at}.currency`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.note = "x"; }, CONTRACT, `${at}.*`);
    await refuseMutated((body) => { body.days[index].payload.apiEquivalentSpend.unavailableReason = "processing_capacity_exceeded"; }, CONTRACT, at);
    // A newer pricing method and registry are only shape-checked: the release changed them.
    const prepared = await prepareMutated((body) => {
      body.days[index].payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.6";
      body.days[index].payload.apiEquivalentSpend.registrySha256 = "ab".repeat(32);
    });
    expect(prepared.summary.dayCount).toBe(168);
    // A day with no spend block at all is valid (production removes a non-current one).
    await prepareMutated((body) => { delete body.days[index].payload.apiEquivalentSpend; });
  });

  it("refuses a window that is not the full year ending on the evidence date", async () => {
    // The facts keep the real evidence date, so a window ending elsewhere is the window's fault.
    await refuseMutated((body) => { body.to = "2026-09-30"; }, EVIDENCE, "to", { evidenceDate: FIXTURE_EVIDENCE_DATE });
    await refuseMutated((body) => { body.from = "2025-10-02"; }, EVIDENCE, "from");
    await refuseMutated((body) => { body.from = "2025-09-30"; }, EVIDENCE, "from");
    await refuseMutated((body) => { body.days[0].day = "2025-09-30"; body.days[0].payload.day = "2025-09-30"; },
      CONTRACT, "days[0].day");
    await refuseMutated((body) => { body.days[167].day = "2026-10-02"; body.days[167].payload.day = "2026-10-02"; },
      CONTRACT, "days[167].day");
  });

  it("refuses days that are duplicated, unordered or released after the capture", async () => {
    await refuseMutated((body) => { body.days[1] = structuredClone(body.days[0]); }, CONTRACT, "days[1].day");
    await refuseMutated((body) => { [body.days[1], body.days[2]] = [body.days[2], body.days[1]]; }, CONTRACT, "days[2].day");
    await refuseMutated((body) => {
      body.days[5].releasedAt = "2026-10-02T00:00:00.000Z";
      body.days[5].payload.releasedAt = "2026-10-02T00:00:00.000Z";
    }, EVIDENCE, "days[5].releasedAt");
    // Released exactly at the capture instant is allowed.
    await prepareMutated((body) => {
      body.days[5].releasedAt = FIXTURE_CAPTURED_AT;
      body.days[5].payload.releasedAt = FIXTURE_CAPTURED_AT;
    });
  });

  it("holds the allowance state to the breakdowns: ready exactly when a graph was published", async () => {
    await refuseMutated((body) => { delete body.allowanceBreakdowns; }, EVIDENCE, "allowanceState");
    await refuseMutated((body) => { body.allowanceState = "updating"; }, EVIDENCE, "allowanceState");
    await refuseMutated((body) => { body.allowanceBreakdowns.days = []; }, CONTRACT, "allowanceBreakdowns.days");
  });

  it("holds the read state to the breakdowns: an unreadable allowance cache never carries a graph", async () => {
    // Production projects the graph from the cache, so temporarily_unavailable always means no breakdowns.
    await refuseMutated((body) => { body.allowanceReadState = "temporarily_unavailable"; }, EVIDENCE, "allowanceReadState");
    // The Q1 settled golden carries breakdowns too, and is refused the same way.
    const settled = oracleGoldenExportBody("golden-q1-node/community-daily-response-settled.json") as Body;
    expect(settled.allowanceBreakdowns).toBeDefined();
    settled.allowanceReadState = "temporarily_unavailable";
    const error = await refusal(prepareInterimPublicRead(exportInput(settled)));
    expect([error.code, error.detail]).toEqual([EVIDENCE, "allowanceReadState"]);
    // The legitimate pairing is untouched: unavailable with no graph is the dense golden's shape.
    const dense = await prepareInterimPublicRead(exportInput(denseGoldenExportBody()));
    expect([dense.summary.allowanceReadState, dense.summary.breakdownDayCount]).toEqual(["temporarily_unavailable", 0]);
  });

  it("validates the breakdowns by version: their plan set, combined summary, days and models", async () => {
    const at = "allowanceBreakdowns";
    await refuseMutated((body) => { body.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.3"; },
      CONTRACT, `${at}.schemaVersion`);
    await refuseMutated((body) => { body.allowanceBreakdowns.referencePlanType = "plus"; }, CONTRACT, `${at}.referencePlanType`);
    await refuseMutated((body) => { body.allowanceBreakdowns.basis = "Not A Name"; }, CONTRACT, `${at}.basis`);
    // v1.1 has three plans and a combined summary; v1.2 four.
    await refuseMutated((body) => { body.allowanceBreakdowns.days[0].byPlanType.promax = body.allowanceBreakdowns.days[0].byPlanType.pro; },
      CONTRACT, `${at}.days[0].byPlanType.*`);
    await refuseMutated((body) => { delete body.allowanceBreakdowns.days[0].combined; }, CONTRACT, `${at}.days[0].combined`);
    const v12 = (mutate: (body: Body) => void) => {
      const body = withV12Breakdowns(goldenExportBody()) as Body;
      mutate(body);
      return prepareInterimPublicRead(exportInput(body));
    };
    const missingPlan = await refusal(v12((body) => { delete body.allowanceBreakdowns.days[0].byPlanType.promax; }));
    expect([missingPlan.code, missingPlan.detail]).toEqual([CONTRACT, `${at}.days[0].byPlanType.promax`]);
    const v10Extra = withV10Breakdowns(goldenExportBody()) as Body;
    v10Extra.allowanceBreakdowns.days[0].combined = { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null };
    expect((await refusal(prepareInterimPublicRead(exportInput(v10Extra)))).detail).toBe(`${at}.days[0].*`);
    // Days: ascending, published, closed (before the capture day and the generation day).
    await refuseMutated((body) => { body.allowanceBreakdowns.days[1].day = body.allowanceBreakdowns.days[0].day; },
      CONTRACT, `${at}.days[1].day`);
    await refuseMutated((body) => { body.allowanceBreakdowns.days[0].day = "2025-10-05"; }, CONTRACT, `${at}.days[0].day`);
    await refuseMutated((body) => {
      const last = body.allowanceBreakdowns.days.length - 1;
      body.allowanceBreakdowns.days[last].day = "2026-10-01";
    }, CONTRACT, `${at}.days[68].day`);
    await refuseMutated((body) => { body.allowanceBreakdowns.days = new Array(71).fill(body.allowanceBreakdowns.days[0]); },
      CONTRACT, `${at}.days`);
    // Summaries follow the site's rules: a band needs three fits and must bracket the centre.
    await refuseMutated((body) => { body.allowanceBreakdowns.days[0].combined.centralUsd = 0; }, CONTRACT, `${at}.days[0].combined.centralUsd`);
    await refuseMutated((body) => { body.allowanceBreakdowns.days[0].combined.participantCount = 99; },
      CONTRACT, `${at}.days[0].combined.participantCount`);
    await refuseMutated((body) => { body.allowanceBreakdowns.days[0].combined.band80Usd.upperUsd = 0.001; },
      CONTRACT, `${at}.days[0].combined.band80Usd`);
    // Models: [id, positive dollars, accounts >= 1], distinct.
    const rowIndex = (goldenExportBody() as Body).allowanceBreakdowns.days
      .findIndex((entry: Body) => entry.models.length > 0);
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    const withModels = (models: unknown[]) => (body: Body) => { body.allowanceBreakdowns.days[rowIndex].models = models; };
    const modelAt = `${at}.days[${rowIndex}].models`;
    for (const [models, detail] of [
      [[["gpt-5.6-sol", 0, 1]], `${modelAt}[0][1]`],
      [[["gpt-5.6-sol", 1.5, 0]], `${modelAt}[0][2]`],
      [[["gpt 5", 1.5, 1]], `${modelAt}[0][0]`],
      [[["gpt-5.6-sol", 1.5]], `${modelAt}[0]`],
      [[["gpt-5.6-sol", 1.5, 1], ["gpt-5.6-sol", 2, 1]], `${modelAt}[1][0]`],
    ] as Array<[unknown[], string]>) {
      await refuseMutated(withModels(models), CONTRACT, detail);
    }
    await refuseMutated((body) => { body.allowanceBreakdowns.generatedAt = "2026-10-02T00:00:00.000Z"; }, EVIDENCE, `${at}.generatedAt`);
    // The production clock skew is allowed: generated up to five minutes after the capture instant.
    await prepareMutated((body) => { body.allowanceBreakdowns.generatedAt = "2026-10-01T23:34:59.000Z"; });
  });

  it("validates the cache series at every level: four windows, ten exact bands, closed models", async () => {
    const at = "cacheRetention";
    await refuseMutated((body) => { body.cacheRetention.windows.pop(); }, CONTRACT, `${at}.windows`);
    await refuseMutated((body) => { body.cacheRetention.windows[1].window = "month"; }, CONTRACT, `${at}.windows[1].window`);
    await refuseMutated((body) => { body.cacheRetention.windows[3].days = 365; }, CONTRACT, `${at}.windows[3].days`);
    await refuseMutated((body) => { body.cacheRetention.windows[0].bands.pop(); }, CONTRACT, `${at}.windows[0].bands`);
    await refuseMutated((body) => { body.cacheRetention.windows[0].bands[2].endMs = 1; }, CONTRACT, `${at}.windows[0].bands[2].endMs`);
    await refuseMutated((body) => {
      const bands = body.cacheRetention.windows[0].bands;
      [bands[0], bands[1]] = [bands[1], bands[0]];
    }, CONTRACT, `${at}.windows[0].bands[0].band`);
    await refuseMutated((body) => { body.cacheRetention.windows[0].bands[0].extra = 1; }, CONTRACT, `${at}.windows[0].bands[0].*`);
    await refuseMutated((body) => { body.cacheRetention.methodVersion = "cache-retention-vX"; }, CONTRACT, `${at}.methodVersion`);
    await refuseMutated((body) => { body.cacheRetention.gapBasis = "request_start"; }, CONTRACT, `${at}.gapBasis`);
    await refuseMutated((body) => { body.cacheRetention.schemaVersion = "community-cache-retention-v2.0"; }, CONTRACT, `${at}.schemaVersion`);
    await refuseMutated((body) => { body.cacheRetention.windows[0].modelsTruncated = "no"; }, CONTRACT, `${at}.windows[0].modelsTruncated`);
    const allWindow = (body: Body) => body.cacheRetention.windows[3];
    expect(allWindow(goldenExportBody()).byModel.length).toBeGreaterThan(0);
    await refuseMutated((body) => { allWindow(body).byModel[0].extra = 1; }, CONTRACT, `${at}.windows[3].byModel[0].*`);
    await refuseMutated((body) => { allWindow(body).byModel[0].bands.pop(); }, CONTRACT, `${at}.windows[3].byModel[0].bands`);
    await refuseMutated((body) => { allWindow(body).byModel[1] = structuredClone(allWindow(body).byModel[0]); },
      CONTRACT, `${at}.windows[3].byModel[1].model`);
    await refuseMutated((body) => { allWindow(body).byModel[0].model = "../x"; }, CONTRACT, `${at}.windows[3].byModel[0].model`);
    // Band arithmetic: a measured band has a rate, an empty band explicit nulls.
    const measured = (body: Body) => body.cacheRetention.windows[3].bands.findIndex((band: Body) => band.adjacencies > 0);
    const empty = (body: Body) => body.cacheRetention.windows[0].bands.findIndex((band: Body) => band.adjacencies === 0);
    const measuredAt = measured(goldenExportBody());
    expect(measuredAt).toBeGreaterThanOrEqual(0);
    await refuseMutated((body) => { body.cacheRetention.windows[3].bands[measuredAt].reusedMoreThanHalfRate = null; },
      CONTRACT, `${at}.windows[3].bands[${measuredAt}].reusedMoreThanHalfRate`);
    await refuseMutated((body) => { body.cacheRetention.windows[3].bands[measuredAt].matchedOrExceededRate = 1.5; },
      CONTRACT, `${at}.windows[3].bands[${measuredAt}].matchedOrExceededRate`);
    await refuseMutated((body) => { body.cacheRetention.windows[3].bands[measuredAt].contributors = 99999; },
      CONTRACT, `${at}.windows[3].bands[${measuredAt}]`);
    await refuseMutated((body) => { body.cacheRetention.windows[3].bands[measuredAt].topContributorShare = 0; },
      CONTRACT, `${at}.windows[3].bands[${measuredAt}].topContributorShare`);
    const emptyAt = empty(goldenExportBody());
    expect(emptyAt).toBeGreaterThanOrEqual(0);
    await refuseMutated((body) => { body.cacheRetention.windows[0].bands[emptyAt].adjacencies = 1; },
      CONTRACT, `${at}.windows[0].bands[${emptyAt}]`);
    await refuseMutated((body) => { body.cacheRetention.windows[0].bands[emptyAt].reusedMoreThanHalfRate = 0; },
      CONTRACT, `${at}.windows[0].bands[${emptyAt}].reusedMoreThanHalfRate`);
  });

  it("never reports a value in an error: only a closed code and a structural path", async () => {
    const marker = "synthetic-secret-marker-7f3a";
    const error = await refusal(prepareMutated((body) => { body.days[0].payload[marker] = marker; }));
    expect(error.message).not.toContain(marker);
    expect(error.detail).toBe("days[0].payload.*");
    expect(INTERIM_PUBLIC_READ_ERROR_CODES).toContain(error.code);
    const valueError = await refusal(prepareMutated((body) => { body.days[0].payload.totals.usageEvents = marker; }));
    expect(valueError.message).not.toContain(marker);
  });
});

describe("serving the frozen days", () => {
  it("projects the full window to exactly the pinned export, byte for byte", async () => {
    const { frozen, record } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    expect(JSON.stringify(projectInterimPublicRead(frozen, "2025-10-01", "2026-10-01"))).toBe(record.payloadText);
    const dense = await prepareInterimPublicRead(exportInput(denseGoldenExportBody()));
    expect(JSON.stringify(projectInterimPublicRead(dense.frozen, "2025-10-01", "2026-10-01"))).toBe(dense.record.payloadText);
  });

  it("projects a sub-range: days, breakdown days and the allowance state follow the range", async () => {
    const { frozen } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    const body = projectInterimPublicRead(frozen, "2026-09-01", "2026-09-15") as Body;
    expect(Object.keys(body)).toEqual(["schemaVersion", "from", "to", "allowanceState", "allowanceReadState",
      "allowanceBreakdowns", "cacheRetention", "days"]);
    expect([body.from, body.to]).toEqual(["2026-09-01", "2026-09-15"]);
    expect(body.days.map((day: Body) => day.day)).toEqual(
      Array.from({ length: 15 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`));
    expect(body.allowanceState).toBe("ready");
    expect(body.allowanceBreakdowns.days.map((row: Body) => row.day))
      .toEqual(body.days.map((day: Body) => day.day).filter((day: string) => frozen.allowanceBreakdowns?.days.some((row) => row.day === day)));
    // Everything else about the breakdowns and the cache series is the frozen value.
    expect({ ...body.allowanceBreakdowns, days: undefined }).toEqual({ ...frozen.allowanceBreakdowns, days: undefined });
    expect(body.cacheRetention).toEqual(frozen.cacheRetention);
    // Frozen days are the frozen objects: nothing is recomputed or relabelled.
    expect(body.days[0]).toEqual(frozen.days.find((day) => day.day === "2026-09-01"));
  });

  it("answers `updating` with no breakdowns when the range holds none of their days, and an empty range", async () => {
    const { frozen } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    const early = projectInterimPublicRead(frozen, "2026-04-15", "2026-05-15") as Body;
    expect(early.days.length).toBeGreaterThan(0);
    expect([early.allowanceState, early.allowanceReadState, "allowanceBreakdowns" in early])
      .toEqual(["updating", "confirmed", false]);
    expect("cacheRetention" in early).toBe(true);
    const before = projectInterimPublicRead(frozen, "2025-10-01", "2025-10-05") as Body;
    expect(before.days).toEqual([]);
    expect(before.allowanceState).toBe("updating");
    // A range after the frozen window is empty too: the interim never invents days.
    const after = projectInterimPublicRead(frozen, "2026-10-02", "2026-10-06") as Body;
    expect(after.days).toEqual([]);
    // A window that extends past the frozen one echoes the request and serves the overlap.
    const later = projectInterimPublicRead(frozen, "2025-10-05", "2026-10-05") as Body;
    expect([later.from, later.to, later.days.length]).toEqual(["2025-10-05", "2026-10-05", 168]);
  });

  it("keeps the captured allowance read state, which decides the cache lifetime", async () => {
    const dense = await prepareInterimPublicRead(exportInput(denseGoldenExportBody()));
    expect((projectInterimPublicRead(dense.frozen, "2026-09-01", "2026-09-15") as Body).allowanceReadState)
      .toBe("temporarily_unavailable");
  });

  it("labels the answer in headers and nowhere else", async () => {
    const { record, frozen } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    expect(interimPublicReadHeaders(record)).toEqual({
      "x-tibotattle-interim-read": "frozen",
      "x-tibotattle-evidence-date": "2026-10-01",
      "x-tibotattle-interim-sha256": record.payloadSha256,
      "last-modified": "Thu, 01 Oct 2026 23:30:00 GMT",
    });
    expect(Object.values(INTERIM_PUBLIC_READ_HEADERS)).toEqual([
      "x-tibotattle-interim-read", "x-tibotattle-evidence-date", "x-tibotattle-interim-sha256", "last-modified",
    ]);
    // The body has no label field: its keys are the closed contract's.
    const keys = Object.keys(projectInterimPublicRead(frozen, "2025-10-01", "2026-10-01"));
    expect(keys.every((key) => ["schemaVersion", "from", "to", "allowanceState", "allowanceReadState",
      "allowanceBreakdowns", "cacheRetention", "days"].includes(key))).toBe(true);
  });
});

describe("verifying a stored row", () => {
  async function storedRow() {
    const { record } = await prepareInterimPublicRead(exportInput(goldenExportBody()));
    return {
      payload_text: record.payloadText,
      payload_sha256: record.payloadSha256,
      captured_at: record.capturedAt,
      source_commit: record.sourceCommit,
      evidence_date: record.evidenceDate,
    };
  }

  it("verifies an intact row to the record it was prepared from", async () => {
    const row = await storedRow();
    const verified = await verifyInterimPublicReadRow(row);
    expect(verified.record).toEqual({
      payloadText: row.payload_text, payloadSha256: row.payload_sha256, capturedAt: row.captured_at,
      sourceCommit: row.source_commit, evidenceDate: row.evidence_date,
    });
    expect(verified.frozen.days).toHaveLength(168);
  });

  it("refuses a row whose text, digest, shape or facts do not hold, as a row failure", async () => {
    const row = await storedRow();
    const flipped = `${row.payload_text.slice(0, 1000)}${row.payload_text[1000] === "1" ? "2" : "1"}${row.payload_text.slice(1001)}`;
    const cases: Array<Record<string, unknown>> = [
      { payload_text: flipped },
      { payload_sha256: `${row.payload_sha256.slice(0, 63)}${row.payload_sha256.endsWith("0") ? "1" : "0"}` },
      { payload_sha256: row.payload_sha256.toUpperCase() },
      { payload_text: 5 }, { payload_text: "" }, { payload_text: null },
      { captured_at: "2026-10-01T23:30:00Z" }, { captured_at: "2026-10-01 23:30:00.000Z" },
      { source_commit: "abc" }, { evidence_date: "2026-10-02" }, { evidence_date: "2026-09-29" }, { evidence_date: null },
    ];
    for (const change of cases) {
      const error = await refusal(verifyInterimPublicReadRow({ ...row, ...change }));
      expect(error.code).toBe("INTERIM_PUBLIC_READ_ROW_INVALID");
    }
    for (const notARow of [null, undefined, "row", 5, []]) {
      expect((await refusal(verifyInterimPublicReadRow(notARow))).code).toBe("INTERIM_PUBLIC_READ_ROW_INVALID");
    }
  });

  it("re-validates the contract of a row whose digest matches: a poisoned but self-consistent row is refused", async () => {
    const body = goldenExportBody() as Body;
    body.days[0].payload.capacityByPlanType = { pro: { capacityUsd: 1, participantCount: 1 } };
    const text = JSON.stringify(body);
    const row = {
      payload_text: text,
      payload_sha256: sha256Hex(new TextEncoder().encode(text)),
      captured_at: FIXTURE_CAPTURED_AT,
      source_commit: FIXTURE_SOURCE_COMMIT,
      evidence_date: FIXTURE_EVIDENCE_DATE,
    };
    const error = await refusal(verifyInterimPublicReadRow(row));
    expect([error.code, error.detail]).toEqual([CONTRACT, "days[0].payload.*"]);
  });
});
