import { describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import {
  createUsageCorrectionOccurrenceAccumulator,
  type UsageCorrectionFormat,
  type UsageCorrectionSource,
} from "../src/telemetry-usage-reconciliation";

const OWNER = "owner:streaming-synthetic";
const OCCURRENCE = `event:v2:${"a".repeat(64)}`;

function usage(
  format: UsageCorrectionFormat,
  options: { totals?: boolean; eventTime?: string; inputCacheReadTokens?: number | null } = {},
) {
  const totals = options.totals ?? true;
  return {
    schemaVersion: `usage-event-v${format === "v1" ? "1.0" : format === "v11" ? "1.1" : "1.2"}`,
    eventId: OCCURRENCE,
    eventTime: options.eventTime ?? "2026-09-20T12:00:00.000Z",
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex", modelId: "gpt-6-astra", speedMode: "standard",
    apiServiceTier: "unknown", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "medium",
    agentScope: "root", outcome: "unknown",
    totalInputContextTokens: totals ? 1_000 : null,
    components: { inputUncachedTokens: 900,
      inputCacheReadTokens: options.inputCacheReadTokens ?? 100, inputCacheWriteTokens: 0,
      outputTextTokens: 20, outputReasoningTokens: 5,
      outputCombinedTokens: totals ? 25 : null },
    ...(format === "v1" ? {} : { accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null, planBasis: "unavailable",
      planType: "unknown", planEraId: null,
    } }),
    ...(format === "v12" ? { boundaryFlags: null, tieOrder: null, cacheWriteTtl: null } : {}),
  };
}

function source(
  format: UsageCorrectionFormat,
  record: ReturnType<typeof usage> = usage(format),
): UsageCorrectionSource {
  return { ownerScope: OWNER, format, recordJson: JSON.stringify(record) };
}

function accumulator() {
  return createUsageCorrectionOccurrenceAccumulator({ ownerScope: OWNER, occurrenceId: OCCURRENCE });
}

async function appendPages(
  pages: readonly (readonly UsageCorrectionSource[])[],
) {
  const value = accumulator();
  for (const page of pages) await value.append(page);
  return value.close();
}

describe("bounded streaming usage correction accumulator", () => {
  it("merges more than 200 pages while retaining no source digest list", async () => {
    const pages = Array.from({ length: 205 }, (_, index) => {
      const format = index % 3 === 0 ? "v1" : index % 3 === 1 ? "v11" : "v12";
      return [source(format, usage(format, { totals: index % 2 === 0 }))];
    });
    const result = await appendPages(pages);

    expect(result).toMatchObject({ ownerScope: OWNER, occurrenceId: OCCURRENCE,
      sourceCount: 205, status: "compatible", eventTimeConflict: false,
      totalInputContextTokens: { status: "reported", value: 1_000 },
      outputCombinedTokens: { status: "reported", value: 25 } });
    expect(result).not.toHaveProperty("sourceRecordDigests");
    expect(JSON.parse(result.effectiveLegacyRecord!)).toEqual(usage("v1"));
  });

  it("is independent of page split and source order, including late null-to-known repair", async () => {
    const partial = usage("v1", { totals: false, inputCacheReadTokens: null });
    const known = usage("v11", { inputCacheReadTokens: null });
    const family = [source("v1", partial), source("v11", known), source("v12", {
      ...usage("v12", { totals: false, inputCacheReadTokens: null }),
    })];
    const expected = await appendPages([family]);
    for (let split = 0; split <= family.length; split += 1) {
      expect(await appendPages([family.slice(0, split), family.slice(split)])).toEqual(expected);
    }
    for (const order of [[0, 1, 2], [1, 2, 0], [2, 0, 1], [1, 0, 2]]) {
      expect(await appendPages([order.map((index) => family[index]!)] )).toEqual(expected);
    }
    expect(expected).toMatchObject({ sourceCount: 3, status: "compatible",
      totalInputContextTokens: { status: "reported", value: 1_000 },
      outputCombinedTokens: { status: "reported", value: 25 } });
  });

  it("keeps a late known-total conflict monotonic after more matching pages", async () => {
    const partial = usage("v1", { totals: false, inputCacheReadTokens: null });
    const conflict = { ...usage("v11", { inputCacheReadTokens: null }), totalInputContextTokens: 1_001 };
    const value = accumulator();
    await value.append([source("v1", partial)]);
    await value.append(Array.from({ length: 200 }, () => source("v1", partial)));
    await value.append([source("v1", partial)]);
    await value.append([source("v11", conflict)]);
    await value.append([source("v12", usage("v12", { inputCacheReadTokens: null }))]);
    expect(value.close()).toMatchObject({ sourceCount: 204, status: "total_conflict",
      totalInputContextTokens: { status: "conflict", value: null },
      outputCombinedTokens: { status: "reported", value: 25 }, effectiveLegacyRecord: null });
  });

  it("refuses a crossed-day occurrence as a sticky base conflict", async () => {
    const first = source("v1");
    const crossed = source("v11", usage("v11", { eventTime: "2026-09-21T00:01:00.000Z" }));
    const forward = accumulator();
    await forward.append([first]);
    await forward.append([crossed]);
    const reverse = accumulator();
    await reverse.append([crossed]);
    await reverse.append([first]);
    const result = forward.close();
    expect(result).toMatchObject({ status: "base_conflict", eventTime: null,
      eventTimeConflict: true, effectiveLegacyRecord: null,
      totalInputContextTokens: { status: "conflict", value: null },
      outputCombinedTokens: { status: "conflict", value: null } });
    expect(result).toEqual(reverse.close());
  });

  it("snapshots pages, rejects scope mismatches, and rejects overlapping appends", async () => {
    const value = accumulator();
    const page = [source("v1")];
    const original = page[0]!.recordJson;
    const pending = value.append(page);
    page[0]!.recordJson = "{}";
    page.push(source("v11"));
    await expect(value.append([source("v1")])).rejects.toMatchObject({
      code: "USAGE_CORRECTION_CONCURRENT",
    });
    await pending;
    expect(page[0]!.recordJson).toBe("{}");
    expect(value.close().sourceCount).toBe(1);
    expect(original).not.toBe("{}");

    await expect(accumulator().append([{ ...source("v1"), ownerScope: "owner:other" }]))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_SCOPE_MISMATCH" });
    await expect(accumulator().append([source("v1", {
      ...usage("v1"), eventId: `event:v2:${"b".repeat(64)}`,
    })])).rejects.toMatchObject({ code: "USAGE_CORRECTION_OCCURRENCE_MISMATCH" });
  });

  it("does not rewrite source bytes and emits only on explicit close", async () => {
    const value = accumulator();
    const input = source("v1", usage("v1", { totals: false }));
    const original = input.recordJson;
    await value.append([input]);
    expect(input.recordJson).toBe(original);
    expect(value.close()).toMatchObject({ effectiveLegacyRecord: canonicalTelemetryV11Json(usage("v1", { totals: false })) });
    await expect(value.append([input])).rejects.toMatchObject({ code: "USAGE_CORRECTION_CLOSED" });
    expect(() => value.close()).toThrowError("USAGE_CORRECTION_CLOSED");
  });
});
