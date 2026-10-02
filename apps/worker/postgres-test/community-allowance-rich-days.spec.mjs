import { expect, it } from "vitest";
import { richV11Day, richV12Day } from "./fixtures/rich-telemetry-days.mjs";
import {
  finishProviderEffectiveModelComposition,
  finishProviderEffectiveQuotaAnalysis,
} from "../src/quota-analysis-v1.ts";
import { selectCommunityAllowanceAnalysisFits } from "../src/community-allowance.ts";
import { buildAdminCommunityAllowancePreview } from "../src/admin-community-allowance.ts";

const DAYS = [
  "2026-09-18",
  "2026-09-19",
  "2026-09-20",
  "2026-09-21",
  "2026-09-22",
];
const RESET_DAY = "2026-09-29";
const ACCOUNT_TRACK_ID = `account-track:v2:${"a".repeat(64)}`;
const DATASET_ID = `dataset:v1:${"d".repeat(64)}`;
const SOURCE_FINGERPRINT = "e".repeat(64);

function rowsForDay(day) {
  const v11 = richV11Day(day, { resetDay: RESET_DAY });
  const v12 = richV12Day(day, { resetDay: RESET_DAY });
  const quotaRows = [];
  const usageRows = [];
  for (const fixture of [v11, v12]) {
    for (const chunk of fixture.chunks) {
      if (chunk.chunkId.startsWith("quota:")) {
        for (const record of chunk.records) {
          quotaRows.push({
            occurrenceId: record.observationId,
            observedAt: record.observedTime,
            provider: "openai_codex",
            planType: record.planType,
            planVariant: record.planVariant,
            limitId: record.limitId,
            slot: record.slot,
            usedPercent: record.usedPercent,
            windowDurationMinutes: record.windowDurationMinutes,
            resetsAt: record.resetsAt,
          });
        }
      } else if (chunk.chunkId.startsWith("usage:")) {
        for (const record of chunk.records) {
          usageRows.push({
            occurrenceId: record.eventId,
            observedAt: record.eventTime,
            provider: "openai_codex",
            recordJson: JSON.stringify(record),
          });
        }
      }
    }
  }
  expect(quotaRows).toHaveLength(40);
  expect(usageRows).toHaveLength(40);
  return { quotaRows, usageRows };
}

function effectiveRowsThrough(index) {
  const quotaRows = [];
  const usageRows = [];
  for (const day of DAYS.slice(0, index + 1)) {
    const rows = rowsForDay(day);
    quotaRows.push(...rows.quotaRows);
    usageRows.push(...rows.usageRows);
  }
  return {
    sourceFingerprint: SOURCE_FINGERPRINT,
    sourceGroups: [{
      kind: "modern",
      datasetId: DATASET_ID,
      accountTrackId: ACCOUNT_TRACK_ID,
      policyEpoch: "effective-v1",
      completeWindow: true,
      quotaRows,
      usageRows,
    }],
  };
}

it("keeps three mixed successor days fitted with positive model capacities", () => {
  const results = DAYS.slice(2).map((_, index) => finishProviderEffectiveModelComposition(
    effectiveRowsThrough(index + 2),
  ));
  for (const result of results) {
    expect(result.status).toBe("ready");
    expect(result.fit.status).toBe("fitted");
    expect(Object.values(result.fit.capacityUsdByModel)).toEqual(
      expect.arrayContaining([
        expect.any(Number),
      ]),
    );
    expect(result.fit.capacityUsdByModel["gpt-5.6-sol"]).toBeGreaterThan(0);
    expect(result.fit.capacityUsdByModel["gpt-5.6-terra"]).toBeGreaterThan(0);
  }
});

it("binds scalar preview days to the selected fit timestamp, independently of model history", () => {
  const targetDay = DAYS.at(-1);
  const result = finishProviderEffectiveQuotaAnalysis(effectiveRowsThrough(DAYS.length - 1));
  expect(result.status).toBe("ready");
  const fits = selectCommunityAllowanceAnalysisFits("scalar-owner", [{
    source: "v1",
    analysis: result,
  }]);
  expect(fits).toHaveLength(1);
  expect(fits[0].lastObservedAt.slice(0, 10)).toBe(targetDay);

  const atTarget = buildAdminCommunityAllowancePreview(
    fits,
    Date.parse(`${targetDay}T20:00:00.000Z`),
    ["scalar-owner"],
  );
  expect(atTarget.days.filter((entry) => entry.combined.fitCount > 0).map((entry) => entry.day))
    .toEqual([targetDay]);

  const onFollowingDay = buildAdminCommunityAllowancePreview(
    fits,
    Date.parse(`${targetDay}T20:00:00.000Z`) + 86_400_000,
    ["scalar-owner"],
  );
  expect(onFollowingDay.days.filter((entry) => entry.combined.fitCount > 0).map((entry) => entry.day))
    .toEqual([targetDay, "2026-09-23"]);
});
