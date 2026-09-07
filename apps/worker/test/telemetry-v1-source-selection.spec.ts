import { describe, expect, it } from "vitest";
import { selectV1WinningDevices } from "../src/telemetry-v1-source-selection";
import type { V1SourceChunk } from "../src/telemetry-v1-source-selection";

const chunk = (device: string, stream: V1SourceChunk["stream"], hour: number,
  overrides: Partial<V1SourceChunk> = {}): V1SourceChunk => ({
  id: `chunk-${device}-${stream}-${hour}`, participant_id: "participant-a", device_id: device,
  chunk_day: "2026-08-01", stream, revision: 1, chunk_digest: "a".repeat(64),
  parser_version: "synthetic-parser", accepted_record_count: 1,
  created_at: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`, ...overrides,
});

describe("shared v1 source selection", () => {
  it("elects once from quota and usage; a newer session-only transport cannot displace it", () => {
    const rows = [chunk("device-a", "usage", 1), chunk("device-a", "quota", 4),
      chunk("device-b", "usage", 3), chunk("device-b", "session", 10)];
    const expected = [{ participant_id: "participant-a", observed_day: "2026-08-01",
      device_id: "device-a", evidence: "analytical" }];
    expect(selectV1WinningDevices(rows)).toEqual(expected);
    expect(selectV1WinningDevices([...rows].reverse())).toEqual(expected);
  });

  it("uses explicit session-only fallback only when no analytical input exists", () => {
    expect(selectV1WinningDevices([chunk("device-a", "session", 1), chunk("device-b", "session", 2)]))
      .toEqual([{ participant_id: "participant-a", observed_day: "2026-08-01",
        device_id: "device-b", evidence: "session_only" }]);
  });

  it("retains independent participant-days and ignores zero-record chunks", () => {
    expect(selectV1WinningDevices([
      chunk("device-a", "usage", 1), chunk("device-b", "usage", 2, { accepted_record_count: 0 }),
      chunk("device-c", "quota", 3, { chunk_day: "2026-08-02" }),
      chunk("device-d", "usage", 4, { participant_id: "participant-b" }),
    ]).map((winner) => [winner.participant_id, winner.observed_day, winner.device_id]))
      .toEqual([["participant-a", "2026-08-01", "device-a"],
        ["participant-a", "2026-08-02", "device-c"], ["participant-b", "2026-08-01", "device-d"]]);
  });

  it("uses SQLite-compatible bytewise device ties, not runtime locale collation", () => {
    const rows = [chunk("device-Z", "usage", 1), chunk("device-a", "usage", 1)];
    expect(selectV1WinningDevices(rows)[0]?.device_id).toBe("device-a");
    expect(selectV1WinningDevices([...rows].reverse())).toEqual(selectV1WinningDevices(rows));
  });
});
