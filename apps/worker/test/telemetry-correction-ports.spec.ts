import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  prepareTelemetryCorrectionWriteOperation,
  snapshotTelemetryCorrectionWriteOperation,
  telemetryCorrectionSourceFenceDigestInput,
  type TelemetryCorrectionSourceFenceEntry,
  type TelemetryCorrectionWriteOperation,
} from "../src/telemetry-correction-ports";
import { prepareUsageCorrectionAssertion } from "../src/telemetry-usage-reconciliation";
import type { TelemetryV1UsageEvent } from "../src/telemetry-v1";

const eventId = `event:v2:${"a".repeat(64)}`;

function operation(overrides: Partial<TelemetryCorrectionWriteOperation> = {}): TelemetryCorrectionWriteOperation {
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.0" as const,
    stream: "usage" as const,
    chunkDay: "2026-09-20",
    chunkSeq: 0,
    chunkId: "usage:2026-09-20:0",
    chunkRevision: 2,
    chunkDigest: "a".repeat(64),
    parserVersion: "synthetic-correction-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [{
      schemaVersion: "usage-event-v1.0" as const,
      eventId,
      eventTime: "2026-09-20T12:00:00.000Z",
      sessionUuid: "00000000-0000-4000-8000-000000000001",
      provider: "openai_codex",
      modelId: "gpt-6-astra",
      speedMode: "standard",
      apiServiceTier: "unknown",
      surface: "local_interactive_unclassified",
      billingSurface: "chatgpt_subscription",
      reasoningEffort: "medium",
      agentScope: "root",
      outcome: "unknown",
      totalInputContextTokens: 1_000,
      components: {
        inputUncachedTokens: 900, inputCacheReadTokens: 100, inputCacheWriteTokens: 0,
        outputTextTokens: 20, outputReasoningTokens: 5, outputCombinedTokens: 25,
      },
    }],
  };
  const base: TelemetryCorrectionWriteOperation = {
    schemaVersion: "telemetry-correction-write-v1",
    participantId: "participant:synthetic",
    deviceId: "device:synthetic",
    stream: "usage",
    chunkDay: "2026-09-20",
    chunkSeq: 0,
    predecessor: { chunkId: "chunk:prior", revision: 1, chunkDigest: "b".repeat(64) },
    claim: { uploadAuthorizationId: "upload:synthetic", leaseExpiresAt: "2026-09-20T12:05:00.000Z" },
    sourceFence: {
      snapshotDigest: "f".repeat(64),
      entries: [{ format: "v1", sourceRowId: "row:synthetic", sourceChunkId: "chunk:prior",
        sourceManifestId: null, occurrenceId: eventId, sourceRevision: 1,
        chunkDigest: "b".repeat(64), recordDigest: "d".repeat(64) }],
    },
    replacement: {
      chunkId: "chunk:replacement", objectKey: "synthetic/correction/replacement",
      envelopeDigest: "c".repeat(64), chunk: { ...chunk, chunkId: "usage:2026-09-20:0" },
      createdAt: "2026-09-20T12:00:01.000Z",
    },
    outcomes: [{ occurrenceId: eventId, field: "totalInputContextTokens", status: "known", value: 1_000,
      sourceFormats: ["v1", "v1.1"], sourceRecordDigests: ["d".repeat(64)] }],
    invalidation: {
      kind: "telemetry-correction", participantId: "participant:synthetic", deviceId: "device:synthetic",
      stream: "usage", observedDays: ["2026-09-20"], occurrenceIds: [eventId],
      predecessorChunkId: "chunk:prior", replacementChunkId: "chunk:replacement", reason: "accepted-correction",
    },
  };
  return { ...base, ...overrides };
}

describe("provider-neutral telemetry correction operation", () => {
  it("snapshots the exact lease, replacement and invalidation scope", () => {
    const input = operation();
    const result = snapshotTelemetryCorrectionWriteOperation(input);
    expect(result.claim.leaseExpiresAt).toBe(input.claim.leaseExpiresAt);
    expect(result.replacement.objectKey).toBe("synthetic/correction/replacement");
    expect(result.invalidation.occurrenceIds).toEqual([eventId]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.replacement.chunk)).toBe(true);
  });

  it("keeps a later-null outcome explicit and preserves contradictory known evidence", () => {
    const result = snapshotTelemetryCorrectionWriteOperation(operation({
      outcomes: [
        { occurrenceId: eventId, field: "totalInputContextTokens", status: "known", value: 1_000,
          sourceFormats: ["v1"], sourceRecordDigests: ["d".repeat(64)] },
        { occurrenceId: eventId, field: "outputCombinedTokens", status: "later-null", value: null,
          sourceFormats: ["v1.1"], sourceRecordDigests: ["e".repeat(64)] },
        { occurrenceId: eventId, field: "sessionUuid", status: "unknown", value: null,
          sourceFormats: ["v1.2"], sourceRecordDigests: ["f".repeat(64)] },
        { occurrenceId: eventId, field: "record", status: "conflict", value: null,
          sourceFormats: ["v1.2"], sourceRecordDigests: ["f".repeat(64)] },
      ],
    }));
    expect(result.outcomes).toMatchObject([
      { field: "totalInputContextTokens", status: "known", value: 1_000 },
      { field: "outputCombinedTokens", status: "later-null", value: null },
      { field: "sessionUuid", status: "unknown", value: null },
      { field: "record", status: "conflict", value: null },
    ]);
  });

  it("rejects an invalidated day or occurrence outside the replacement chunk", () => {
    expect(() => snapshotTelemetryCorrectionWriteOperation(operation({
      invalidation: { ...operation().invalidation, observedDays: ["2026-09-19"] },
    }))).toThrow("Telemetry correction operation is invalid");
  });

  it("prepares an occurrence correction from a bounded, digest-matched source fence", async () => {
    const base = operation();
    const source = {
      ownerScope: base.participantId,
      format: "v1" as const,
      recordJson: JSON.stringify(base.replacement.chunk.records[0]),
    };
    const assertion = await prepareUsageCorrectionAssertion(source);
    const entries: TelemetryCorrectionSourceFenceEntry[] = [{
      format: "v1", sourceRowId: "row:synthetic", sourceChunkId: base.predecessor.chunkId,
      sourceManifestId: null, occurrenceId: eventId, sourceRevision: 1,
      chunkDigest: base.predecessor.chunkDigest, recordDigest: assertion.recordDigest,
    }];
    const snapshotDigest = await sha256Hex(telemetryCorrectionSourceFenceDigestInput(entries));
    const prepared = await prepareTelemetryCorrectionWriteOperation({
      participantId: base.participantId, deviceId: base.deviceId, stream: base.stream,
      predecessor: base.predecessor, claim: base.claim,
      replacement: base.replacement,
      sourceFence: { snapshotDigest, entries }, sources: [source],
    });
    expect(prepared.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "totalInputContextTokens", status: "known", value: 1_000 }),
      expect.objectContaining({ field: "outputCombinedTokens", status: "known", value: 25 }),
    ]));
    expect(prepared.sourceFence.snapshotDigest).toBe(snapshotDigest);
  });

  it("keeps an all-null source occurrence unknown", async () => {
    const base = operation();
    const baseRecord = base.replacement.chunk.records[0] as TelemetryV1UsageEvent;
    const record: TelemetryV1UsageEvent = {
      ...baseRecord,
      totalInputContextTokens: null,
      components: { ...baseRecord.components, outputCombinedTokens: null },
    };
    const source = { ownerScope: base.participantId, format: "v1" as const, recordJson: JSON.stringify(record) };
    const assertion = await prepareUsageCorrectionAssertion(source);
    const entries: TelemetryCorrectionSourceFenceEntry[] = [{
      format: "v1", sourceRowId: "row:unknown", sourceChunkId: base.predecessor.chunkId,
      sourceManifestId: null, occurrenceId: eventId, sourceRevision: 1,
      chunkDigest: base.predecessor.chunkDigest, recordDigest: assertion.recordDigest,
    }];
    const snapshotDigest = await sha256Hex(telemetryCorrectionSourceFenceDigestInput(entries));
    const prepared = await prepareTelemetryCorrectionWriteOperation({
      participantId: base.participantId, deviceId: base.deviceId, stream: base.stream,
      predecessor: base.predecessor, claim: base.claim,
      replacement: { ...base.replacement, chunk: { ...base.replacement.chunk, records: [record] } },
      sourceFence: { snapshotDigest, entries }, sources: [source],
    });
    expect(prepared.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "totalInputContextTokens", status: "unknown", value: null }),
      expect.objectContaining({ field: "outputCombinedTokens", status: "unknown", value: null }),
    ]));
  });
});
