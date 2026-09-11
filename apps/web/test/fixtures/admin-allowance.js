import {
  ADMIN_MODEL_CONFIG,
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
} from "../../public/telemetry-shared.generated.js";

// Synthetic, content-free private-preview DTO for isolated admin rendering QA.
// Never used by a production route or populated from participant evidence.
export function createAdminAllowancePreviewPayload() {
  const startMs = Date.parse("2026-06-29T00:00:00.000Z");
  const summary = (centralUsd, fitCount = 2, participantCount = 1) => ({
    centralUsd,
    fitCount,
    participantCount,
    band80Usd: fitCount >= 3 ? { lowerUsd: centralUsd - 100, upperUsd: centralUsd + 100 } : null,
  });
  const days = Array.from({ length: 70 }, (_, index) => ({
    day: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
    combined: summary(2_100 + index, 6, 3),
    byPlanType: {
      pro: summary(2_050 + index),
      // Divide before rounding: $1,917.90 / 4 = $479.475, displayed as $479.
      prolite: summary(1_917.9),
      plus: summary(1_900),
    },
  }));
  return {
    schemaVersion: "admin-community-allowance-preview-v0.3",
    generatedAt: "2026-09-06T10:30:00.000Z",
    from: days[0].day,
    to: days.at(-1).day,
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_preview",
    referencePlanType: "pro",
    trailingDays: 30,
    qualification: "shared_reset_fit_gates_40pp_span_floor",
    spanFloorPp: 40,
    plans: [
      { planType: "pro", label: "Pro 20x", multiplier: 1 },
      { planType: "prolite", label: "Pro 5x", multiplier: 4 },
      { planType: "plus", label: "Plus", multiplier: 20 },
    ],
    days,
    coverage: null,
    models: {
      modelConfig: ADMIN_MODEL_CONFIG,
      basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
      gate: "shared_composition_kernel_identification",
      days: days.map(({ day }, index) => ({
        day,
        catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
        values: [
          ["gpt-5.6-sol", 2_400 + index, 2],
          ["gpt-5.6-terra", 1_100 + index, 1],
          ["gpt-5.6-luna", 1_300 + index, 1],
          ["gpt-5.5", 2_100 + index, 1],
          ...(index < 60 ? [] : [["gpt-6-astra", 1_500 + index, 1]]),
        ],
        fittedParticipantCount: 2,
        unstableParticipantCount: 0,
        staleParticipantCount: 0,
        refusedParticipantCount: 0,
        v1ParticipantCount: 2,
        unsupportedSourceParticipantCount: 0,
      })),
    },
  };
}
