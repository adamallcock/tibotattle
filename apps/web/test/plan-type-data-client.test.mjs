import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDashboardPayload,
  normalizeParticipantStats,
} from "../public/data-client.js";
import { TELEMETRY_PLAN_TYPES } from "../public/telemetry-shared.generated.js";

test("web timeline normalization retains canonical plans and maps arbitrary strings to unknown", () => {
  const normalized = normalizeDashboardPayload({
    timeline: {
      quota: [
        {
          observedAt: "2026-08-03T12:00:00.000Z",
          usedPercent: 10,
          remainingPercent: 90,
          planType: "go",
        },
        {
          observedAt: "2026-08-03T12:15:00.000Z",
          usedPercent: 15,
          remainingPercent: 85,
          planType: "edu",
        },
        {
          observedAt: "2026-08-03T12:30:00.000Z",
          usedPercent: 20,
          remainingPercent: 80,
          planType: "prolite",
        },
        {
          observedAt: "2026-08-03T12:45:00.000Z",
          usedPercent: 25,
          remainingPercent: 75,
          planType: "arbitrary-plan-name",
        },
      ],
    },
  });

  assert.deepEqual(
    normalized.timeline.quota.map((row) => row.planType),
    ["go", "edu", "prolite", "unknown"],
  );
});

test("web quota windows expose only known provider plan types as plan evidence", () => {
  const knownPlanTypes = [...TELEMETRY_PLAN_TYPES];
  const normalized = normalizeDashboardPayload({
    quotaWindows: [
      ...knownPlanTypes.map((planType, index) => ({
        id: `known-${index}`,
        limitId: "codex",
        durationMinutes: 300,
        usedPercent: 10,
        plan_type: planType,
      })),
      {
        id: "provider-private",
        limitId: "codex",
        durationMinutes: 300,
        usedPercent: 20,
        plan_type: "provider-private-plan",
      },
      {
        id: "plan-variant",
        limitId: "codex",
        durationMinutes: 300,
        usedPercent: 30,
        plan_type: "pro-20x",
      },
      {
        id: "non-string",
        limitId: "codex",
        durationMinutes: 300,
        usedPercent: 40,
        plan_type: { name: "pro" },
      },
    ],
  });

  assert.deepEqual(
    normalized.quotaWindows.map((window) => window.planType),
    [...knownPlanTypes, "unknown", "unknown", "unknown"],
  );
  assert.doesNotMatch(
    JSON.stringify(normalized.quotaWindows),
    /provider-private-plan|pro-20x/u,
  );
});

test("private quota analysis normalizes malformed provider plan labels to unknown", () => {
  const normalized = normalizeParticipantStats({
    schemaVersion: "participant-stats-v0.2",
    rollingQuotaMovement: {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      planType: "pro-20x",
    },
    accountScopedQuotaAnalysis: {
      schemaVersion: "account-scoped-quota-analysis-v0.1",
      status: "ready",
      tracks: [{
        continuity: {
          provider: "openai_codex",
          planType: "provider-private-plan",
          limitId: "codex",
          windowDurationMinutes: 43_200,
        },
        calibration: { tracks: [] },
        rolling: { status: "not_testable" },
      }],
    },
  });

  assert.equal(normalized.rollingQuotaMovement.planType, "unknown");
  assert.equal(normalized.accountScopedQuotaAnalysis.tracks[0].planType, "unknown");
});
