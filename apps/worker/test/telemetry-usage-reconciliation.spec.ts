import { describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, canonicalTelemetryV12Json } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";
import {
  MAX_USAGE_CORRECTION_RECORD_BYTES, MAX_USAGE_CORRECTION_SOURCES,
  prepareUsageCorrectionAssertion, reconcileUsageCorrectionSources,
  type UsageCorrectionFormat,
} from "../src/telemetry-usage-reconciliation";

const OWNER = "owner:synthetic";
function usage(format: UsageCorrectionFormat, totals: boolean = true) {
  return {
    schemaVersion: `usage-event-v${format === "v1" ? "1.0" : format === "v11" ? "1.1" : "1.2"}`,
    eventId: `event:v2:${"a".repeat(64)}`,
    eventTime: "2026-09-20T12:00:00.000Z",
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex", modelId: "gpt-6-astra", speedMode: "standard",
    apiServiceTier: "unknown", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "medium",
    agentScope: "root", outcome: "unknown",
    totalInputContextTokens: totals ? 1_000 : null,
    components: { inputUncachedTokens: 900, inputCacheReadTokens: 100,
      inputCacheWriteTokens: 0, outputTextTokens: 20, outputReasoningTokens: 5,
      outputCombinedTokens: totals ? 25 : null },
    ...(format === "v1" ? {} : { accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null, planBasis: "unavailable",
      planType: "unknown", planEraId: null,
    } }),
    ...(format === "v12" ? { boundaryFlags: null, tieOrder: null, cacheWriteTtl: null } : {}),
  };
}
function source(format: UsageCorrectionFormat, record: unknown = usage(format)) {
  return { ownerScope: OWNER, format, recordJson: JSON.stringify(record) };
}
async function reconcile(sources: ReturnType<typeof source>[]) {
  return reconcileUsageCorrectionSources({ ownerScope: OWNER, sources });
}

describe("staged usage correction reconciliation", () => {
  it("hashes original family bytes separately from the shared total-independent base", async () => {
    const records = (["v1", "v11", "v12"] as const).map((format) => source(format));
    const assertions = await Promise.all(records.map(prepareUsageCorrectionAssertion));
    expect(new Set(assertions.map((row) => row.baseDigest)).size).toBe(1);
    expect(new Set(assertions.map((row) => row.recordDigest)).size).toBe(3);
    for (let index = 0; index < records.length; index += 1) {
      expect(assertions[index]!.recordDigest).toBe(await sha256Hex(
        canonicalTelemetryV11Json(JSON.parse(records[index]!.recordJson))));
      expect(Object.isFrozen(assertions[index])).toBe(true);
    }
    expect(assertions[2]!.recordDigest).toBe(await sha256Hex(canonicalTelemetryV12Json(usage("v12"))));
    expect(await prepareUsageCorrectionAssertion(source("v1", usage("v1", false))))
      .toMatchObject({ baseDigest: assertions[0]!.baseDigest, inputQualification: "unknown",
        outputQualification: "unknown" });
  });

  it("keeps corrected totals across late nulls, replay and every source ordering", async () => {
    const old = source("v1", usage("v1", false));
    const repaired = source("v11");
    const successor = source("v12", usage("v12", false));
    const expected = await reconcile([old, repaired, successor]);
    for (const sources of [[old, successor, repaired], [repaired, old, successor],
      [repaired, successor, old], [successor, old, repaired], [successor, repaired, old],
      [old, old, repaired, repaired, successor, old]]) {
      expect(await reconcile(sources)).toEqual(expected);
    }
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ status: "compatible",
      totalInputContextTokens: { status: "reported", value: 1_000 },
      outputCombinedTokens: { status: "reported", value: 25 } });
    const effective = JSON.parse(expected[0]!.effectiveLegacyRecord!);
    expect(effective).toEqual(usage("v1"));
    expect(old.recordJson).toBe(JSON.stringify(usage("v1", false)));
  });

  it("preserves disjoint occurrences without claiming owner-day coverage", async () => {
    const olderOnly = usage("v1", false);
    olderOnly.eventId = `event:v2:${"b".repeat(64)}`;
    const rows = await reconcile([source("v1", olderOnly), source("v12")]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ occurrenceId: olderOnly.eventId,
      totalInputContextTokens: { status: "unknown", value: null } });
    expect(rows[0]).not.toHaveProperty("complete");
  });

  it("never turns absent totals into inferred values and preserves an explicit zero", async () => {
    const unknown = (await reconcile([source("v1", usage("v1", false))]))[0]!;
    expect(unknown.totalInputContextTokens).toEqual({ status: "unknown", value: null });
    expect(unknown.outputCombinedTokens).toEqual({ status: "unknown", value: null });
    const zero = usage("v1");
    zero.totalInputContextTokens = 0;
    for (const field of Object.keys(zero.components) as (keyof typeof zero.components)[]) zero.components[field] = 0;
    expect((await reconcile([source("v1", zero)]))[0]).toMatchObject({ status: "compatible",
      totalInputContextTokens: { status: "reported", value: 0 },
      outputCombinedTokens: { status: "reported", value: 0 } });
  });

  it("qualifies partial splits by lower bound and refuses a known contradiction", async () => {
    const partial = usage("v1");
    const record = { ...partial, components: { ...partial.components,
      inputCacheReadTokens: null, outputReasoningTokens: null } };
    expect(await prepareUsageCorrectionAssertion({ format: "v1", recordJson: JSON.stringify(record) }))
      .toMatchObject({ inputQualification: "reported", outputQualification: "reported" });
    record.totalInputContextTokens = 899;
    record.components.outputCombinedTokens = 19;
    expect(await prepareUsageCorrectionAssertion({ format: "v1", recordJson: JSON.stringify(record) }))
      .toMatchObject({ inputQualification: "inconsistent", outputQualification: "inconsistent" });
    const rows = await reconcileUsageCorrectionSources({ ownerScope: OWNER,
      sources: [{ ownerScope: OWNER, format: "v1", recordJson: JSON.stringify(record) }] });
    expect(rows[0]).toMatchObject({ status: "total_conflict",
      totalInputContextTokens: { status: "conflict", value: null },
      outputCombinedTokens: { status: "conflict", value: null } });
  });

  it("reports conflicting known values independently of arrival or version", async () => {
    const first = usage("v1");
    const second = usage("v12");
    // Both totals qualify against the same partial vector, but disagree.
    const a = { ...source("v1"), recordJson: JSON.stringify({ ...first,
      components: { ...first.components, inputCacheReadTokens: null } }) };
    const b = { ...source("v12"), recordJson: JSON.stringify({ ...second,
      totalInputContextTokens: 1_001, components: { ...second.components, inputCacheReadTokens: null } }) };
    const expected = await reconcile([a, b]);
    expect(await reconcile([b, a, b])).toEqual(expected);
    expect(expected[0]).toMatchObject({ status: "total_conflict", effectiveLegacyRecord: null,
      totalInputContextTokens: { status: "conflict", value: null },
      outputCombinedTokens: { status: "reported", value: 25 } });
  });

  it("withholds a total that exceeds a complete split without weakening the legacy parser", async () => {
    const contradictory = usage("v1");
    contradictory.totalInputContextTokens = 1_001;
    contradictory.components.outputCombinedTokens = 26;
    expect(await prepareUsageCorrectionAssertion(source("v1", contradictory)))
      .toMatchObject({ totalInputContextTokens: 1_001, outputCombinedTokens: 26,
        inputQualification: "inconsistent", outputQualification: "inconsistent" });
    const rows = await reconcile([source("v12"), source("v1", contradictory)]);
    expect(rows[0]).toMatchObject({ status: "total_conflict",
      totalInputContextTokens: { status: "conflict", value: null },
      outputCombinedTokens: { status: "conflict", value: null } });
  });

  it("does not treat changed shared fields as a total repair", async () => {
    for (const change of [{ modelId: "gpt-5.6-sol" }, { eventTime: "2026-09-20T12:00:01.000Z" },
      { sessionUuid: "00000000-0000-4000-8000-000000000002" },
      { components: { ...usage("v12").components, inputUncachedTokens: 901 } }]) {
      const sources = [source("v1"), source("v12", { ...usage("v12"), ...change })];
      const rows = await reconcile(sources);
      expect(await reconcile([...sources].reverse())).toEqual(rows);
      expect(rows[0]).toMatchObject({ status: "base_conflict", effectiveLegacyRecord: null });
    }
  });

  it("keeps successor extension facts out of the shared usage join", async () => {
    const a = source("v12");
    const b = source("v12", { ...usage("v12"), boundaryFlags: 3, tieOrder: 0,
      cacheWriteTtl: { fiveMinuteTokens: 0, oneHourTokens: 0 } });
    const rows = await reconcile([a, b]);
    expect(rows[0]).toMatchObject({ status: "compatible" });
    expect(rows[0]!.sourceRecordDigests).toHaveLength(2);
    expect(JSON.parse(rows[0]!.effectiveLegacyRecord!)).not.toHaveProperty("boundaryFlags");
  });

  it("rejects cross-owner inputs and snapshots a pending page before hashing", async () => {
    await expect(reconcileUsageCorrectionSources({ ownerScope: OWNER,
      sources: [{ ...source("v1"), ownerScope: "owner:other" }] }))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_SCOPE_MISMATCH" });
    const sources = [source("v1"), source("v11")];
    const input = { ownerScope: OWNER, sources };
    const pending = reconcileUsageCorrectionSources(input);
    input.ownerScope = "owner:other";
    sources[1]!.recordJson = "{}";
    sources.push(source("v12"));
    const result = await pending;
    expect(result).toHaveLength(1);
    expect(result[0]!.ownerScope).toBe(OWNER);
    expect(result[0]!.sourceRecordDigests).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]!.sourceRecordDigests)).toBe(true);
  });

  it("rejects unsupported families, other streams, private fields and duplicate JSON keys", async () => {
    for (const recordJson of ["{}", JSON.stringify({ ...usage("v1"), prompt: "synthetic-private-canary" }),
      JSON.stringify({ schemaVersion: "session-dimension-v1.0", sessionUuid: "session-fixture",
        firstEventTime: "2026-09-20T12:00:00.000Z", provider: "openai_codex", toolClassCounts: {} }),
      JSON.stringify({ schemaVersion: "quota-observation-v1.0", observationId: "q:1790000000000:codex:primary",
        observedTime: "2026-09-20T12:00:00.000Z", provider: "openai_codex", planType: "pro",
        planVariant: "unknown", limitId: "codex", slot: "primary", usedPercent: 10,
        windowDurationMinutes: 300, resetsAt: "2026-09-20T17:00:00.000Z" }),
      JSON.stringify(usage("v1")).replace('"outcome":"unknown"', '"outcome":"synthetic-private-canary","outcome":"unknown"')]) {
      await expect(prepareUsageCorrectionAssertion({ format: "v1", recordJson }))
        .rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID", message: "USAGE_CORRECTION_INVALID" });
    }
    await expect(prepareUsageCorrectionAssertion({ format: "v13" as UsageCorrectionFormat,
      recordJson: source("v1").recordJson })).rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID" });
    for (const format of ["v1", "v11", "v12"] as const) {
      const other = format === "v1" ? "v11" : "v1";
      await expect(prepareUsageCorrectionAssertion({ format, recordJson: source(other).recordJson }))
        .rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID" });
    }
  });

  it("enforces record and page bounds before doing work", async () => {
    await expect(prepareUsageCorrectionAssertion({ format: "v1",
      recordJson: " ".repeat(MAX_USAGE_CORRECTION_RECORD_BYTES + 1) }))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_LIMIT" });
    await expect(reconcile(Array.from({ length: MAX_USAGE_CORRECTION_SOURCES + 1 }, () => source("v1"))))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_LIMIT" });
    await expect(reconcile(Array.from({ length: 100 }, () => ({ ...source("v1"),
      recordJson: " ".repeat(12_501) }))))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_LIMIT" });
    expect(await reconcile([])).toEqual([]);
  });

  it("keeps malformed runtime inputs behind constant safe errors", async () => {
    await expect(prepareUsageCorrectionAssertion(null as never))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID" });
    for (const sources of [[null], Array(1), [42]]) {
      await expect(reconcileUsageCorrectionSources({ ownerScope: OWNER, sources: sources as never }))
        .rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID", message: "USAGE_CORRECTION_INVALID" });
    }
    await expect(reconcileUsageCorrectionSources(null as never))
      .rejects.toMatchObject({ code: "USAGE_CORRECTION_INVALID" });
  });
});
