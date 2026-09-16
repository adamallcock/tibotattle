import { describe, expect, it } from "vitest";
import {
  buildTelemetryV1ReplayReceipt,
  resolveTelemetryV1Replay,
  type StoredTelemetryV1Chunk,
  type TelemetryV1ChunkIdentity,
  type TelemetryV1ContributionReader,
} from "../src/telemetry-v1-contribution-reader";

describe("provider-neutral telemetry v1 replay receipt", () => {
  it("preserves superseded status and acknowledged-day fields", async () => {
    const row: StoredTelemetryV1Chunk = {
      id: "chunk:synthetic-0001",
      participantId: "participant-0001",
      deviceId: "device-0001",
      stream: "usage",
      chunkDay: "2026-09-15",
      chunkSeq: 4,
      revision: 2,
      chunkDigest: "a".repeat(64),
      recordCount: 3,
      acceptedRecords: 3,
      supersededAt: "2026-09-15T00:01:00.000Z",
    };
    const reader: TelemetryV1ContributionReader = {
      async byEnvelope() { return null; },
      async current() { return null; },
      async acknowledgedThroughDay(participantId, deviceId) {
        expect(participantId).toBe(row.participantId);
        expect(deviceId).toBe(row.deviceId);
        return "2026-09-15";
      },
    };

    await expect(buildTelemetryV1ReplayReceipt(reader, row, row.deviceId)).resolves.toEqual({
      schemaVersion: "telemetry-chunk-receipt-v1.0",
      contributionId: row.id,
      chunkId: "usage:2026-09-15:4",
      chunkRevision: 2,
      status: "superseded",
      replayed: true,
      recordCounts: { declared: 3, accepted: 3 },
      acknowledgedThroughDay: "2026-09-15",
    });
  });

  it("checks the historical envelope row before current identity recovery", async () => {
    const identity: TelemetryV1ChunkIdentity = {
      participantId: "participant-0001",
      deviceId: "device-0001",
      stream: "usage",
      chunkDay: "2026-09-15",
      chunkSeq: 4,
    };
    const historical: StoredTelemetryV1Chunk = {
      id: "chunk:historical",
      ...identity,
      revision: 1,
      chunkDigest: "a".repeat(64),
      recordCount: 1,
      acceptedRecords: 1,
      supersededAt: "2026-09-15T00:01:00.000Z",
    };
    const calls: string[] = [];
    const reader: TelemetryV1ContributionReader = {
      async byEnvelope() {
        calls.push("envelope");
        return historical;
      },
      async current() {
        calls.push("current");
        throw new Error("current lookup must not run after historical hit");
      },
      async acknowledgedThroughDay() { return null; },
    };

    await expect(resolveTelemetryV1Replay(
      reader,
      "envelope-digest",
      identity,
      "a".repeat(64),
    )).resolves.toBe(historical);
    expect(calls).toEqual(["envelope"]);
  });
});
