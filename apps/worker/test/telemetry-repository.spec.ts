import { describe, expect, it, vi } from "vitest";
import {
  buildRollingQuotaMovement,
  type CalibrationGroupRow,
  type RollingQuotaObservationRow,
  type RollingUsageObservationRow,
} from "../src/telemetry-repository";

const group: CalibrationGroupRow = {
  provider: "openai_codex",
  plan_type: "pro",
  plan_variant: "pro-20x",
  limit_id: "codex",
  slot: "seven_day",
  resets_at: "2026-07-31T12:00:00.000Z",
  window_duration_minutes: 10_080,
  firstObservedAt: "2026-07-25T12:10:00.000Z",
  lastObservedAt: "2026-07-25T15:10:00.000Z",
};

function quota(
  observedAt: string,
  receivedAt: string,
  usedPercent: number,
): RollingQuotaObservationRow {
  return {
    observed_at: observedAt,
    used_percent: usedPercent,
    record_json: JSON.stringify({ receivedTime: receivedAt }),
  };
}

function usage(
  observedAt: string,
  costNanousd: number,
): RollingUsageObservationRow {
  return {
    observed_at: observedAt,
    server_cost_nanousd: costNanousd,
    server_pricing_status: "fully_priced",
  };
}

describe("rolling quota movement", () => {
  it("bins every usage timestamp once while preserving rolling output order", () => {
    const usageRows = [
      usage("2026-07-25T12:15:00.000Z", 100_000_000),
      usage("2026-07-25T13:30:00.000Z", 200_000_000),
      usage("2026-07-25T15:00:00.000Z", 300_000_000),
    ];
    const usageTimes = new Set(usageRows.map((row) => row.observed_at));
    const usageParseCounts = new Map<string, number>();
    const originalParse = Date.parse.bind(Date);
    const parseSpy = vi.spyOn(Date, "parse").mockImplementation((value) => {
      if (usageTimes.has(value)) {
        usageParseCounts.set(value, (usageParseCounts.get(value) ?? 0) + 1);
      }
      return originalParse(value);
    });
    try {
      const result = buildRollingQuotaMovement(
        group,
        "transmitted",
        [
          quota(
            "2026-07-25T12:10:00.000Z",
            "2026-07-25T12:10:01.000Z",
            20,
          ),
          quota(
            "2026-07-25T15:10:00.000Z",
            "2026-07-25T15:10:01.000Z",
            26,
          ),
        ],
        usageRows,
      );
      expect(result).toMatchObject({
        schemaVersion: "participant-quota-movement-v0.1",
        status: "conditional_estimate",
        accountContinuity: "transmitted",
        apiPriceEquivalentCapacityUsd: 10,
        observedUsedPercentSpan: 6,
        pricedUsageUsd: "0.6",
      });
      const rows = Reflect.get(result, "rows") as object[];
      expect(rows).toHaveLength(9);
      expect(rows.slice(0, 4)).toEqual([
        {
          timestamp: "2026-07-25T13:00:00.000Z",
          windowStartUtc: "2026-07-25T12:00:00.000Z",
          windowEndUtc: "2026-07-25T13:00:00.000Z",
          smoothingHours: 1,
          observedQuotaChangePp: 0,
          expectedQuotaChangePp: 1,
          apiPriceEquivalentUsd: "0.1",
          usageEvents: 1,
        },
        {
          timestamp: "2026-07-25T14:00:00.000Z",
          windowStartUtc: "2026-07-25T13:00:00.000Z",
          windowEndUtc: "2026-07-25T14:00:00.000Z",
          smoothingHours: 1,
          observedQuotaChangePp: 0,
          expectedQuotaChangePp: 2,
          apiPriceEquivalentUsd: "0.2",
          usageEvents: 1,
        },
        {
          timestamp: "2026-07-25T15:00:00.000Z",
          windowStartUtc: "2026-07-25T14:00:00.000Z",
          windowEndUtc: "2026-07-25T15:00:00.000Z",
          smoothingHours: 1,
          observedQuotaChangePp: 0,
          expectedQuotaChangePp: 0,
          apiPriceEquivalentUsd: "0",
          usageEvents: 0,
        },
        {
          timestamp: "2026-07-25T16:00:00.000Z",
          windowStartUtc: "2026-07-25T15:00:00.000Z",
          windowEndUtc: "2026-07-25T16:00:00.000Z",
          smoothingHours: 1,
          observedQuotaChangePp: 6,
          expectedQuotaChangePp: 3,
          apiPriceEquivalentUsd: "0.3",
          usageEvents: 1,
        },
      ]);
      expect([...usageParseCounts.values()]).toEqual([1, 1, 1]);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("refuses an elapsed range larger than its declared quota window", () => {
    const result = buildRollingQuotaMovement(
      {
        ...group,
        window_duration_minutes: 300,
        firstObservedAt: "1970-01-01T00:00:00.000Z",
        lastObservedAt: "9999-12-31T23:00:00.000Z",
      },
      "transmitted",
      [
        quota(
          "1970-01-01T00:00:00.000Z",
          "1970-01-01T00:00:01.000Z",
          10,
        ),
        quota(
          "9999-12-31T23:00:00.000Z",
          "9999-12-31T23:00:01.000Z",
          20,
        ),
      ],
      [usage("1970-01-01T00:30:00.000Z", 1_000_000)],
    );
    expect(result).toEqual({
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "analysis_time_range_exceeded",
      rows: [],
      accountContinuity: "transmitted",
    });
  });
});
