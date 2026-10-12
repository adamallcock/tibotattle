import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalTelemetryV11Json,
  canonicalTelemetryV12Json,
  MAX_TELEMETRY_V11_CHUNK_CANONICAL_BYTES,
  REVIEWED_CODEX_MODEL_IDS,
  type TelemetryV11UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import {
  MAX_POSTGRES_CLASSIFICATION_RECORD_BYTES,
  preparePostgresClassificationCorrection,
} from "./postgres-classification-correction";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";

type Format = 10 | 11 | 12;
type Stream = "usage" | "session";
type RecordFixture = Record<string, unknown>;
const formats = [10, 11, 12] as const;
const refusal = "POSTGRES_CLASSIFICATION_CORRECTION_INVALID";
const knownModel = "gpt-6-sol";
const attribution = {
  accountBasis: "same_source" as const, accountTrackId: `account-track:v2:${"b".repeat(64)}`,
  planBasis: "same_source_occurrence" as const, planType: "pro" as const,
  planEraId: `plan-era:v1:${"c".repeat(64)}`,
};
const components = {
  inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 30,
  outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null,
};

// Synthetic structural evidence only. No database, provider or source corpus.
function usage(format: Format): RecordFixture {
  const v11: TelemetryV11UsageEvent = {
    schemaVersion: "usage-event-v1.1", eventId: `event:v2:${"a".repeat(64)}`,
    eventTime: "2026-10-01T12:05:00.000Z", sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex", modelId: "unknown", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1030,
    components: { ...components }, accountPlanAttribution: { ...attribution },
  };
  if (format === 10) {
    const projected = telemetryV11LegacyProjection("usage", v11);
    if (!projected) throw new Error("SYNTHETIC_FIXTURE_INVALID");
    return JSON.parse(projected.canonicalRecord) as RecordFixture;
  }
  if (format === 12) return {
    ...v11, schemaVersion: "usage-event-v1.2", boundaryFlags: 1, tieOrder: 7,
    cacheWriteTtl: { fiveMinuteTokens: 10, oneHourTokens: 20 },
  };
  return v11 as unknown as RecordFixture;
}
function session(format: Format): RecordFixture {
  return {
    schemaVersion: `session-dimension-v1.${format - 10}`,
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    firstEventTime: "2026-10-01T12:05:00.000Z", provider: "unknown",
    toolClassCounts: { shell: 2, browser: 1 },
  };
}
const canonical = (format: Format, value: unknown) => format === 12
  ? canonicalTelemetryV12Json(value) : canonicalTelemetryV11Json(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function prepare(format: Format, stream: Stream, before: RecordFixture, after: RecordFixture) {
  return preparePostgresClassificationCorrection({ beforeFormat: format, afterFormat: format, stream,
    beforeRecordJson: JSON.stringify(before), afterRecordJson: JSON.stringify(after) });
}
async function rejected(operation: Promise<unknown>) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: refusal, message: refusal });
}
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)]));
  }
  return value;
}

const frozenUsageChanges: [string, RecordFixture][] = [
  ["event identity", { eventId: `event:v2:${"d".repeat(64)}` }],
  ["event clock", { eventTime: "2026-10-01T12:05:01.000Z" }],
  ["event day", { eventTime: "2026-10-02T12:05:00.000Z" }],
  ["session identity", { sessionUuid: "00000000-0000-4000-8000-000000000002" }],
  ["speed", { speedMode: "fast" }],
  ["service tier", { apiServiceTier: "priority" }],
  ["surface", { surface: "cloud_task" }],
  ["billing surface", { billingSurface: "api" }],
  ["reasoning effort", { reasoningEffort: "low" }],
  ["agent scope", { agentScope: "subagent" }],
  ["outcome", { outcome: "failed" }],
  ["context total", { totalInputContextTokens: 1031 }],
  ["null context total", { totalInputContextTokens: null }],
  ...Object.keys(components).map((key): [string, RecordFixture] => [
    `component ${key}`, { components: { ...components, [key]: key === "outputCombinedTokens" ? 75 : 1 } },
  ]),
  ["null component", { components: { ...components, inputCacheReadTokens: null } }],
];
const attributionChanges: [string, RecordFixture][] = [
  ["account basis", { accountPlanAttribution: { ...attribution, accountBasis: "provisional_marker" } }],
  ["account identity", { accountPlanAttribution: { ...attribution, accountTrackId: `account-track:v2:${"e".repeat(64)}` } }],
  ["plan basis", { accountPlanAttribution: { ...attribution, planBasis: "provisional_marker" } }],
  ["plan type", { accountPlanAttribution: { ...attribution, planType: "plus" } }],
  ["plan era", { accountPlanAttribution: { ...attribution, planEraId: `plan-era:v1:${"f".repeat(64)}` } }],
];
const v12Changes: [string, RecordFixture][] = [
  ["boundary flags", { boundaryFlags: 2 }],
  ["null boundary flags", { boundaryFlags: null }],
  ["tie order", { tieOrder: 8 }],
  ["null tie order", { tieOrder: null }],
  ["TTL allocation", { cacheWriteTtl: { fiveMinuteTokens: 20, oneHourTokens: 10 } }],
  ["null TTL evidence", { cacheWriteTtl: null }],
];

describe("PostgreSQL classification correction pure proof", () => {
  it("uses the reviewed public Codex catalog for its accepted target set", () => {
    expect(REVIEWED_CODEX_MODEL_IDS).toContain(knownModel);
    expect(REVIEWED_CODEX_MODEL_IDS).not.toContain("unknown");
  });

  describe.each(formats)("source format %s", format => {
    it("permits unknown model to each reviewed Codex target", async () => {
      for (const modelId of REVIEWED_CODEX_MODEL_IDS) {
        const before = usage(format); const after = { ...before, modelId };
        const proof = await prepare(format, "usage", before, after);
        expect(proof, modelId).toEqual({
          methodVersion: "classification-correction-v1", kind: "usage-model",
          beforeDigest: digest(canonical(format, before)), afterDigest: digest(canonical(format, after)),
          invariantDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          beforeRecordJson: canonical(format, before), afterRecordJson: canonical(format, after),
        });
        expect(proof!.beforeDigest, modelId).not.toBe(proof!.afterDigest);
      }
    });

    it.each([
      ["usage-provider", { modelId: knownModel, provider: "unknown" }, { provider: "openai_codex" }],
      ["usage-provider", { provider: "unknown" }, { provider: "openai_codex" }],
      ["usage-model-provider", { provider: "unknown" }, { modelId: knownModel, provider: "openai_codex" }],
    ] as const)("permits %s repair", async (kind, beforePatch, afterPatch) => {
      const before = { ...usage(format), ...beforePatch };
      expect(await prepare(format, "usage", before, { ...before, ...afterPatch })).toMatchObject({ kind });
    });

    it("returns null only after validating unchanged usage and session records", async () => {
      for (const stream of ["usage", "session"] as const) {
        const before = stream === "usage" ? usage(format) : session(format);
        expect(await prepare(format, stream, before, reversed(before) as RecordFixture)).toBeNull();
      }
      const invalid = { ...usage(format), unexpected: "synthetic-extra" };
      await rejected(prepare(format, "usage", invalid, invalid));
    });

    it("canonicalizes both original records and nested maps independently of input order", async () => {
      const before = usage(format); const after = { ...before, modelId: knownModel };
      const first = await prepare(format, "usage", before, after);
      const ordered = await preparePostgresClassificationCorrection({ beforeFormat: format, afterFormat: format,
        stream: "usage", beforeRecordJson: JSON.stringify(reversed(before), null, 2),
        afterRecordJson: JSON.stringify(reversed(after), null, 2) });
      expect(ordered).toEqual(first);
    });

    it.each([
      ["known model replacement", { modelId: knownModel }, { modelId: "gpt-5.6-sol" }],
      ["known model regression", { modelId: knownModel }, { modelId: "unknown" }],
      ["unreviewed model", {}, { modelId: "synthetic-unreviewed-model" }],
      ["Claude model", {}, { modelId: "claude-sonnet-4-5" }],
      ["known provider replacement", {}, { modelId: knownModel, provider: "anthropic_claude" }],
      ["known provider regression", {}, { modelId: knownModel, provider: "unknown" }],
      ["unreviewed provider", { provider: "unknown" }, { provider: "synthetic-provider" }],
      ["other is not unknown", { modelId: "other" }, { modelId: knownModel }],
      ["case variant is not unknown", { modelId: "Unknown" }, { modelId: knownModel }],
      ["provider case variant", { provider: "unknown" }, { provider: "OpenAI_Codex" }],
      ["other provider is not unknown", { provider: "other" }, { provider: "openai_codex" }],
      ["known incompatible provider", { provider: "anthropic_claude" }, { modelId: knownModel }],
      ["provider-only repair with Claude model", { provider: "unknown", modelId: "claude-sonnet-4-5" }, { provider: "openai_codex" }],
      ["provider-only repair with unreviewed model", { provider: "unknown", modelId: "synthetic-unreviewed-model" }, { provider: "openai_codex" }],
    ])("refuses %s", async (_label, beforePatch, afterPatch) => {
      const before = { ...usage(format), ...beforePatch };
      await rejected(prepare(format, "usage", before, { ...before, ...afterPatch }));
    });

    const frozen = [...frozenUsageChanges, ...(format === 10 ? [] : attributionChanges),
      ...(format === 12 ? v12Changes : [])];
    it.each(frozen)("refuses model repair bundled with changed %s", async (_label, patch) => {
      const before = usage(format);
      await rejected(prepare(format, "usage", before, { ...before, modelId: knownModel, ...patch }));
    });
    it.each(frozen)(
      "includes frozen %s in the invariant digest", async (_label, patch) => {
        const before = usage(format);
        // Null TTL is valid unknown evidence: vary the aggregate alone rather
        // than forcing an invalid TTL/aggregate combination into the fixture.
        if (format === 12 && _label === "component inputCacheWriteTokens") before.cacheWriteTtl = null;
        const first = await prepare(format, "usage", before, { ...before, modelId: knownModel });
        const differentEvidence = { ...before, ...patch };
        const second = await prepare(format, "usage", differentEvidence, { ...differentEvidence, modelId: knownModel });
        expect(second!.invariantDigest).not.toBe(first!.invariantDigest);
      },
    );

    it("freezes session evidence while preparing provider repair without claiming usage-set completeness", async () => {
      const before = session(format); const after = { ...before, provider: "openai_codex" };
      const proof = await prepare(format, "session", before, after);
      expect(proof).toEqual({ methodVersion: "classification-correction-v1", kind: "session-provider",
        beforeDigest: digest(canonical(format, before)), afterDigest: digest(canonical(format, after)),
        invariantDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        beforeRecordJson: canonical(format, before), afterRecordJson: canonical(format, after) });
      expect(await prepare(format, "session", reversed(before) as RecordFixture,
        reversed(after) as RecordFixture)).toEqual(proof);
    });
    it.each([
      ["session identity", { sessionUuid: "00000000-0000-4000-8000-000000000002" }],
      ["first-event clock", { firstEventTime: "2026-10-01T12:05:01.000Z" }],
      ["first-event day", { firstEventTime: "2026-10-02T12:05:00.000Z" }],
      ["tool quantity", { toolClassCounts: { shell: 3, browser: 1 } }],
      ["removed tool", { toolClassCounts: { shell: 2 } }],
      ["added zero-count tool", { toolClassCounts: { shell: 2, browser: 1, other: 0 } }],
    ])("refuses session provider repair with changed %s", async (_label, patch) => {
      const before = session(format);
      await rejected(prepare(format, "session", before, { ...before, provider: "openai_codex", ...patch }));
      const first = await prepare(format, "session", before, { ...before, provider: "openai_codex" });
      const differentEvidence = { ...before, ...patch };
      const second = await prepare(format, "session", differentEvidence, { ...differentEvidence, provider: "openai_codex" });
      expect(second!.invariantDigest).not.toBe(first!.invariantDigest);
    });
    it("refuses session known-provider replacement and regression", async () => {
      const before = { ...session(format), provider: "openai_codex" };
      for (const provider of ["unknown", "anthropic_claude"]) {
        await rejected(prepare(format, "session", before, { ...before, provider }));
      }
    });

    it.each(["record", "components", "attribution", "missing-model", "null-model", "missing-provider"])(
      "refuses closed-schema violation at %s", async location => {
        const before = usage(format); const after: RecordFixture = { ...before, modelId: knownModel };
        if (location === "record") after.extra = "synthetic-extra";
        if (location === "components") after.components = { ...components, extra: 1 };
        if (location === "attribution") after.accountPlanAttribution = { ...attribution, extra: 1 };
        if (location === "missing-model") delete after.modelId;
        if (location === "null-model") after.modelId = null;
        if (location === "missing-provider") delete after.provider;
        await rejected(prepare(format, "usage", before, after));
        await rejected(prepare(format, "usage", after, before));
      },
    );
  });

  it("permits reviewed 10→11 projection while preserving original and candidate source digests", async () => {
    const before = usage(10); const after = { ...usage(11), modelId: knownModel };
    const proof = await preparePostgresClassificationCorrection({ beforeFormat: 10, afterFormat: 11,
      stream: "usage", beforeRecordJson: JSON.stringify(before), afterRecordJson: JSON.stringify(after) });
    expect(proof).toMatchObject({ kind: "usage-model", beforeRecordJson: canonical(10, before),
      afterRecordJson: canonical(11, after), beforeDigest: digest(canonical(10, before)),
      afterDigest: digest(canonical(11, after)) });
    expect(proof!.beforeRecordJson).toContain("usage-event-v1.0");
    expect(proof!.afterRecordJson).toContain("usage-event-v1.1");
    expect(proof!.afterRecordJson).toContain("accountPlanAttribution");
    await rejected(preparePostgresClassificationCorrection({ beforeFormat: 10, afterFormat: 11, stream: "usage",
      beforeRecordJson: JSON.stringify(before), afterRecordJson: JSON.stringify({ ...after, totalInputContextTokens: 1031 }) }));
  });

  it("uses reviewed 10→11 projection for provider and combined usage repairs", async () => {
    for (const stream of ["usage", "session"] as const) {
      const before = stream === "usage" ? { ...usage(10), provider: "unknown" } : session(10);
      const after = stream === "usage" ? { ...usage(11), modelId: knownModel } : { ...session(11), provider: "openai_codex" };
      const proof = await preparePostgresClassificationCorrection({ beforeFormat: 10, afterFormat: 11,
        stream, beforeRecordJson: JSON.stringify(before), afterRecordJson: JSON.stringify(after) });
      expect(proof).toMatchObject({ kind: stream === "usage" ? "usage-model-provider" : "session-provider",
        beforeDigest: digest(canonical(10, before)), afterDigest: digest(canonical(11, after)),
        beforeRecordJson: canonical(10, before), afterRecordJson: canonical(11, after) });
    }
  });

  describe.each([10, 11] as const)("reviewed forward projection %s→12", beforeFormat => {
    function forward(stream: Stream, before: RecordFixture, after: RecordFixture) {
      return preparePostgresClassificationCorrection({ beforeFormat, afterFormat: 12, stream,
        beforeRecordJson: JSON.stringify(before), afterRecordJson: JSON.stringify(after) });
    }
    it("prepares each correction kind with exact common evidence and full source-format digests", async () => {
      const repairs = [
        ["usage-model", { provider: "openai_codex", modelId: "unknown" }, { provider: "openai_codex", modelId: knownModel }],
        ["usage-provider", { provider: "unknown", modelId: knownModel }, { provider: "openai_codex", modelId: knownModel }],
        ["usage-model-provider", { provider: "unknown", modelId: "unknown" }, { provider: "openai_codex", modelId: knownModel }],
      ] as const;
      for (const [kind, beforePatch, afterPatch] of repairs) {
        const before = { ...usage(beforeFormat), ...beforePatch };
        const after = { ...usage(12), ...afterPatch };
        const proof = await forward("usage", before, after);
        expect(proof).toEqual({ methodVersion: "classification-correction-v1", kind,
          beforeDigest: digest(canonical(beforeFormat, before)), afterDigest: digest(canonical(12, after)),
          invariantDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          beforeRecordJson: canonical(beforeFormat, before), afterRecordJson: canonical(12, after) });
        expect(JSON.parse(proof!.afterRecordJson)).toMatchObject({
          schemaVersion: "usage-event-v1.2", boundaryFlags: 1, tieOrder: 7,
          cacheWriteTtl: { fiveMinuteTokens: 10, oneHourTokens: 20 },
        });
        expect(await forward("usage", reversed(before) as RecordFixture, reversed(after) as RecordFixture)).toEqual(proof);
      }
      const before = session(beforeFormat); const after = { ...session(12), provider: "openai_codex" };
      expect(await forward("session", before, after)).toMatchObject({ kind: "session-provider",
        beforeDigest: digest(canonical(beforeFormat, before)), afterDigest: digest(canonical(12, after)),
        beforeRecordJson: canonical(beforeFormat, before), afterRecordJson: canonical(12, after) });
    });

    it("hashes validated full v12 candidate dimensions while comparing the reviewed common projection", async () => {
      const before = usage(beforeFormat); const after = { ...usage(12), modelId: knownModel };
      const first = await forward("usage", before, after);
      for (const [_label, patch] of v12Changes) {
        const candidate = { ...after, ...patch };
        const proof = await forward("usage", before, candidate);
        expect(proof!.afterRecordJson).toBe(canonical(12, candidate));
        expect(proof!.afterDigest).toBe(digest(canonical(12, candidate)));
        expect(proof!.afterDigest).not.toBe(first!.afterDigest);
        expect(proof!.beforeDigest).toBe(first!.beforeDigest);
        expect(proof!.invariantDigest).toBe(first!.invariantDigest);
      }
      // Validation remains a prerequisite to projection; TTL may not disagree
      // with the aggregate, and the v12 dimensions retain their own bounds.
      for (const patch of [{ boundaryFlags: 4 }, { tieOrder: -1 },
        { cacheWriteTtl: { fiveMinuteTokens: 1, oneHourTokens: 1 } }]) {
        await rejected(forward("usage", before, { ...after, ...patch }));
      }
    });

    it.each([...frozenUsageChanges, ...(beforeFormat === 11 ? attributionChanges : [])])(
      "refuses changed common %s during the forward transition", async (_label, patch) => {
        await rejected(forward("usage", usage(beforeFormat), { ...usage(12), modelId: knownModel, ...patch }));
      },
    );
    it("requires valid candidate attribution even on the legacy transition", async () => {
      await rejected(forward("usage", usage(beforeFormat), { ...usage(12), modelId: knownModel,
        accountPlanAttribution: { ...attribution, accountTrackId: null } }));
      await rejected(forward("usage", usage(beforeFormat), { ...usage(12), modelId: knownModel,
        accountPlanAttribution: { ...attribution, extra: 1 } }));
    });
    it("refuses changed session identity, first-event evidence or tool-map membership", async () => {
      const before = session(beforeFormat);
      for (const patch of [
        { sessionUuid: "00000000-0000-4000-8000-000000000002" },
        { firstEventTime: "2026-10-02T12:05:00.000Z" },
        { firstEventTime: "2026-10-01T12:05:01.000Z" },
        { toolClassCounts: { shell: 3, browser: 1 } },
        { toolClassCounts: { shell: 2 } },
        { toolClassCounts: { shell: 2, browser: 1, other: 0 } },
      ]) {
        await rejected(forward("session", before, { ...session(12), provider: "openai_codex", ...patch }));
      }
    });
    it("refuses invalid provider targets, incompatible models and known-classification replacement", async () => {
      for (const stream of ["usage", "session"] as const) {
        const before = stream === "usage" ? { ...usage(beforeFormat), provider: "unknown" } : session(beforeFormat);
        const after = stream === "usage" ? { ...usage(12), modelId: knownModel } : session(12);
        for (const provider of ["anthropic_claude", "synthetic-provider"]) {
          await rejected(forward(stream, before, { ...after, provider }));
        }
      }
      await rejected(forward("usage", { ...usage(beforeFormat), provider: "unknown", modelId: "claude-sonnet-4-5" },
        { ...usage(12), modelId: "claude-sonnet-4-5" }));
      await rejected(forward("usage", usage(beforeFormat), { ...usage(12), provider: "anthropic_claude", modelId: knownModel }));
      await rejected(forward("usage", { ...usage(beforeFormat), modelId: knownModel }, { ...usage(12), modelId: "gpt-5.6-sol" }));
      await rejected(forward("session", { ...session(beforeFormat), provider: "openai_codex" }, session(12)));
    });
  });

  it.each([[11, 10], [12, 10], [12, 11]] as const)(
    "refuses backwards format transition %s→%s", async (beforeFormat, afterFormat) => {
      await rejected(preparePostgresClassificationCorrection({ beforeFormat, afterFormat, stream: "usage",
        beforeRecordJson: JSON.stringify(usage(beforeFormat)),
        afterRecordJson: JSON.stringify({ ...usage(afterFormat), modelId: knownModel }) }));
    },
  );

  it.each(["{", "null", "[]", "42", JSON.stringify("synthetic-value")])(
    "refuses invalid/non-record JSON without disclosing its content", async beforeRecordJson => {
      await rejected(preparePostgresClassificationCorrection({ beforeFormat: 11, afterFormat: 11,
        stream: "usage", beforeRecordJson, afterRecordJson: JSON.stringify({ ...usage(11), modelId: knownModel }) }));
      await rejected(preparePostgresClassificationCorrection({ beforeFormat: 11, afterFormat: 11,
        stream: "usage", beforeRecordJson: JSON.stringify(usage(11)), afterRecordJson: beforeRecordJson }));
    },
  );

  it("refuses duplicate JSON keys instead of accepting a last-key-wins classification", async () => {
    const source = JSON.stringify(usage(11));
    const duplicate = source.replace('"modelId":"unknown"', '"modelId":"gpt-6-sol","modelId":"unknown"');
    await rejected(preparePostgresClassificationCorrection({ beforeFormat: 11, afterFormat: 11, stream: "usage",
      beforeRecordJson: duplicate, afterRecordJson: JSON.stringify({ ...usage(11), modelId: knownModel }) }));
  });

  it("bounds raw input bytes before accepting whitespace-expanded canonical-equivalent records", async () => {
    const beforeRecordJson = " ".repeat(MAX_TELEMETRY_V11_CHUNK_CANONICAL_BYTES + 1) + JSON.stringify(usage(11));
    await rejected(preparePostgresClassificationCorrection({ beforeFormat: 11, afterFormat: 11, stream: "usage",
      beforeRecordJson, afterRecordJson: JSON.stringify({ ...usage(11), modelId: knownModel }) }));
  });

  it("accepts its exact raw-byte boundary and refuses one extra byte on either side", async () => {
    const before = JSON.stringify(usage(11));
    const after = JSON.stringify({ ...usage(11), modelId: knownModel });
    const pad = (value: string, size: number) => value + " ".repeat(size - new TextEncoder().encode(value).byteLength);
    const input = { beforeFormat: 11 as const, afterFormat: 11 as const, stream: "usage" as const,
      beforeRecordJson: pad(before, MAX_POSTGRES_CLASSIFICATION_RECORD_BYTES),
      afterRecordJson: pad(after, MAX_POSTGRES_CLASSIFICATION_RECORD_BYTES) };
    expect(await preparePostgresClassificationCorrection(input)).toMatchObject({
      beforeDigest: digest(canonical(11, usage(11))), afterDigest: digest(canonical(11, { ...usage(11), modelId: knownModel })),
    });
    await rejected(preparePostgresClassificationCorrection({ ...input, beforeRecordJson: input.beforeRecordJson + " " }));
    await rejected(preparePostgresClassificationCorrection({ ...input, afterRecordJson: input.afterRecordJson + " " }));
  });

  it("refuses a record whose schema disagrees with the declared stream or format", async () => {
    await rejected(preparePostgresClassificationCorrection({ beforeFormat: 11, afterFormat: 11, stream: "session",
      beforeRecordJson: JSON.stringify(usage(11)), afterRecordJson: JSON.stringify({ ...usage(11), modelId: knownModel }) }));
    await rejected(preparePostgresClassificationCorrection({ beforeFormat: 12, afterFormat: 12, stream: "usage",
      beforeRecordJson: JSON.stringify(usage(11)), afterRecordJson: JSON.stringify({ ...usage(11), modelId: knownModel }) }));
  });
});
