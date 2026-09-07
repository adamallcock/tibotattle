// Synthetic public wire data for tests and disposable visual QA only.
// Never imported by the production website or deployment builder.
export function publicAllowanceFixture(nowMs = Date.now()) {
  const generatedAt = new Date(nowMs).toISOString();
  const midnight = Date.parse(`${generatedAt.slice(0, 10)}T00:00:00.000Z`);
  const dayAt = offset => new Date(midnight + offset * 86400000).toISOString().slice(0, 10);
  const summary = (usd, accounts = 2) => ({ centralUsd: usd,
    participantCount: usd === null ? 0 : accounts, fitCount: usd === null ? 0 : 4,
    band80Usd: usd === null ? null : { lowerUsd: usd * .8, upperUsd: usd * 1.2 } });
  const basis = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
  const normalization = "pro_x1_prolite_x4_plus_x20";
  const dates = Array.from({ length: 35 }, (_, i) => dayAt(i - 35));
  return {
    schemaVersion: "community-daily-read-v1.0", allowanceState: "ready",
    from: dayAt(-365), to: dayAt(0),
    days: dates.map((day, i) => ({ day, revision: 1, releasedAt: generatedAt,
      payload: { schemaVersion: "community-daily-aggregate-v1.0", policyVersion: "community-daily-v1.0",
        immutableRevision: true, recomputesOnLateData: true, day, revision: 1,
        totals: { contributingParticipants: 3, contributingDevices: 3, usageEvents: 100,
          quotaObservations: 20, sessionDimensions: 10, inputUncachedTokens: 1000,
          inputCacheReadTokens: 10000, inputCacheWriteTokens: 2000, outputTextTokens: 200,
          outputReasoningTokens: 0, outputCombinedTokens: 200 },
        allowance: { basis, referencePlanType: "pro", normalization, ...summary(1500 + i * 12) },
      } })),
    allowanceBreakdowns: {
      schemaVersion: "community-allowance-breakdowns-v1.0", basis, referencePlanType: "pro",
      normalization, modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition",
      modelGate: "shared_composition_kernel_identification", generatedAt,
      days: dates.map((day, i) => ({ day,
        byPlanType: { pro: summary(2000 + Math.sin(i / 3) * 200),
          prolite: summary(i === 20 ? null : 1000 + i * 8), plus: summary(3000 - i * 10, 1) },
        models: i < 25 ? [] : [
          ["gpt-5.5", 1200 + i * 6, 1], ["gpt-5.6-sol", 2200 + Math.cos(i) * 100, 3],
          ...(i > 30 ? [["gpt-6-astra", 1600 + i * 8, 1]] : []),
        ],
      })),
    },
  };
}
