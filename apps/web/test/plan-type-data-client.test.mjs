import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload } from "../public/data-client.js";

test("web timeline normalization retains prolite and maps arbitrary plan strings to unknown", () => {
  const normalized = normalizeDashboardPayload({
    timeline: {
      quota: [
        {
          observedAt: "2026-08-03T12:00:00.000Z",
          usedPercent: 10,
          remainingPercent: 90,
          planType: "prolite",
        },
        {
          observedAt: "2026-08-03T12:15:00.000Z",
          usedPercent: 20,
          remainingPercent: 80,
          planType: "arbitrary-plan-name",
        },
      ],
    },
  });

  assert.deepEqual(
    normalized.timeline.quota.map((row) => row.planType),
    ["prolite", "unknown"],
  );
});
