import {
  ADMIN_MODEL_CONFIG,
  SEPTEMBER29_ADMIN_MODEL_CONFIG,
  SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
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
    qualification: "shared_reset_fit_gates_25pp_span_floor",
    spanFloorPp: 25,
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

// The next exact producer contract. Values/dates stay identical to the old
// fixture so a basis label change cannot hide a reader-side rescaling.
export function createAdminPro10AllowancePreviewPayload() {
  const preview = createAdminAllowancePreviewPayload();
  preview.schemaVersion = "admin-community-allowance-preview-v0.4";
  preview.basis = "seven_day_codex_pro10x_equivalent_personal_plans_trailing_30d_promax25_preview";
  preview.models.basis = "seven_day_codex_pro10x_equivalent_per_model_composition";
  preview.plans = [
    { planType: "pro", label: "Pro 10x", multiplier: 1 },
    { planType: "prolite", label: "Pro 5x", multiplier: 2 },
    { planType: "promax", label: "Pro Max 25x", multiplier: 0.4 },
    { planType: "plus", label: "Plus", multiplier: 10 },
  ];
  for (const day of preview.days) day.byPlanType.promax = structuredClone(day.byPlanType.pro);
  return preview;
}

// Owner option B' (2026-10-10): Pro 20x unit with Pro Max 25x at x0.8.
// Same values/dates as the other fixtures so a basis change cannot hide a
// reader-side rescaling.
export function createAdminPro20PromaxAllowancePreviewPayload() {
  const preview = createAdminPro10AllowancePreviewPayload();
  preview.schemaVersion = "admin-community-allowance-preview-v0.5";
  preview.basis = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25_preview";
  preview.models.basis = "seven_day_codex_pro20x_equivalent_per_model_composition_promax25";
  preview.plans = [
    { planType: "pro", label: "Pro 20x", multiplier: 1 },
    { planType: "prolite", label: "Pro 5x", multiplier: 4 },
    { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
    { planType: "plus", label: "Plus", multiplier: 20 },
  ];
  return preview;
}

// Known live-origin catalog shape, with synthetic dollar values only.
export function withSeptember29AdminHistory(preview) {
  preview.models.modelConfig = SEPTEMBER29_ADMIN_MODEL_CONFIG;
  for (const day of preview.models.days) {
    day.catalogVersion = SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION;
    day.values.push(["gpt-6.1-sol", 1234.5, 1]);
  }
  return preview;
}

// ---- R1 server output (analytics kernel 16): the served value, not hand-written ----
// The admin-community-allowance-preview-v0.5 exactly as the R1 origin's
// readPostgresAdminAllowancePreview (apps/worker/src/postgres-admin-allowance-preview.ts)
// returned it at the clock below: canonical JSON with sorted keys, read back
// from a local PostgreSQL 17 that stored the kernel-16
// buildAdminCommunityAllowancePreview output for a deterministic synthetic
// corpus with Pro, Pro 5x, Plus and Team fits and no Pro Max fit. Server
// commit 2fd6d050d (guard v5 merged into the kernel-16 B' line); d4bf32371
// returns the same bytes. It is the stored preview that the public fixture
// body (SERVER_V15_COMMUNITY_DAILY in public-allowance.js) was served from.
// Every value is synthetic and content-free. JSON.stringify of the literal
// reproduces the read, so a test can prove the fixture was never edited.
export const SERVER_V05_ADMIN_ALLOWANCE_PREVIEW = Object.freeze({
  serverCommit: "2fd6d050d29e15db69de91effeb7355592136294",
  analyticsKernel: 16,
  computeClosureSha256: "d2e867213fe9656f6edf91d0ac991cb293a323f3b2cd84af7d79c0ac431f39f4",
  readAt: "2026-10-01T12:00:00.000Z",
  bytes: 57103,
  sha256: "a2a14e54f573d20b3d3c3cc478c5270337f0916be80c7ab8b3afa4987deb9be7",
  publicBodySha256: "fc3d0c4d9e2825955ac814c432aa5d2aed15f609a6d43970c0e6fa7f655c92c9",
});

/** A fresh copy of the served preview for each caller. */
export function serverV05AdminAllowancePreview() {
  return structuredClone(SERVER_V05_ADMIN_ALLOWANCE_PREVIEW_VALUE);
}

const SERVER_V05_ADMIN_ALLOWANCE_PREVIEW_VALUE = {
  "basis": "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25_preview",
  "coverage": {
    "cachedParticipantCount": 18,
    "mergeEligibleParticipantCount": 14,
    "noQualifyingFitParticipantCount": 1,
    "noRecentFitParticipantCount": 1,
    "recentFittedParticipantCount": 16,
    "unsupportedPlanParticipantCount": 2,
    "uploadingParticipantCount": 18,
  },
  "days": [
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":1053.0803,"upperUsd":1840.8726},"centralUsd":1222.0377,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":866.7752,"upperUsd":1732.1994},"centralUsd":1429.6486,"fitCount":8,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1001.7085,"upperUsd":1757.1726},"centralUsd":1547.9409,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":983.0628,"upperUsd":1763.6122},"centralUsd":1436.7263,"fitCount":29,"participantCount":14},
      "day": "2026-07-24",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":1053.0803,"upperUsd":1840.8726},"centralUsd":1222.0377,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":866.7752,"upperUsd":1732.1994},"centralUsd":1429.6486,"fitCount":8,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":979.157,"upperUsd":1751.2028},"centralUsd":1519.1242,"fitCount":13,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":970.8122,"upperUsd":1763.3773},"centralUsd":1429.6486,"fitCount":30,"participantCount":14},
      "day": "2026-07-25",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":1044.5417,"upperUsd":1841.0297},"centralUsd":1341.3852,"fitCount":8,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":866.7752,"upperUsd":1805.1246},"centralUsd":1451.6418,"fitCount":8,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":977.6924,"upperUsd":1757.1726},"centralUsd":1404.1147,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":959.9808,"upperUsd":1788.0117},"centralUsd":1448.7295,"fitCount":28,"participantCount":13},
      "day": "2026-07-26",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":1044.5417,"upperUsd":1841.0297},"centralUsd":1341.3852,"fitCount":8,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":977.6924,"upperUsd":1757.1726},"centralUsd":1404.1147,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":965.3965,"upperUsd":1780.505},"centralUsd":1436.7263,"fitCount":29,"participantCount":13},
      "day": "2026-07-27",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":971.9474,"upperUsd":1858.6762},"centralUsd":1341.3852,"fitCount":10,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":977.6924,"upperUsd":1757.1726},"centralUsd":1404.1147,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":922.071,"upperUsd":1840.5586},"centralUsd":1436.7263,"fitCount":31,"participantCount":13},
      "day": "2026-07-28",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":947.4179,"upperUsd":1842.1288},"centralUsd":1222.0377,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":990.8733,"upperUsd":1763.1424},"centralUsd":1519.1242,"fitCount":11,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":922.071,"upperUsd":1840.5586},"centralUsd":1436.7263,"fitCount":31,"participantCount":13},
      "day": "2026-07-29",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":947.4179,"upperUsd":1842.1288},"centralUsd":1222.0377,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1001.7085,"upperUsd":1757.1726},"centralUsd":1453.899,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":924.6057,"upperUsd":1833.0519},"centralUsd":1429.6486,"fitCount":32,"participantCount":13},
      "day": "2026-07-30",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":947.4179,"upperUsd":1842.1288},"centralUsd":1222.0377,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1001.7085,"upperUsd":1757.1726},"centralUsd":1453.899,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":924.6057,"upperUsd":1833.0519},"centralUsd":1429.6486,"fitCount":32,"participantCount":13},
      "day": "2026-07-31",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":947.4179,"upperUsd":1842.1288},"centralUsd":1222.0377,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1451.6418,"fitCount":10,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1001.7085,"upperUsd":1757.1726},"centralUsd":1453.899,"fitCount":12,"participantCount":5},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":927.1404,"upperUsd":1825.5452},"centralUsd":1436.7263,"fitCount":33,"participantCount":13},
      "day": "2026-08-01",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":938.3292,"upperUsd":1858.6762},"centralUsd":1169.5418,"fitCount":10,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1451.6418,"fitCount":10,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1216.2843,"upperUsd":1763.3773},"centralUsd":1547.9409,"fitCount":10,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":917.9885,"upperUsd":1840.7156},"centralUsd":1448.7295,"fitCount":30,"participantCount":12},
      "day": "2026-08-02",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":856.5306,"upperUsd":1842.1288},"centralUsd":1117.046,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1451.6418,"fitCount":10,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1216.2843,"upperUsd":1763.3773},"centralUsd":1547.9409,"fitCount":10,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":881.2455,"upperUsd":1840.5586},"centralUsd":1436.7263,"fitCount":31,"participantCount":12},
      "day": "2026-08-03",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":856.5306,"upperUsd":1842.1288},"centralUsd":1117.046,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1216.2843,"upperUsd":1763.3773},"centralUsd":1547.9409,"fitCount":10,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":878.774,"upperUsd":1840.7156},"centralUsd":1429.6486,"fitCount":30,"participantCount":12},
      "day": "2026-08-04",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":851.9802,"upperUsd":1875.2236},"centralUsd":1070.1575,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":871.5986,"upperUsd":1788.2256},"centralUsd":1436.7263,"fitCount":9,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1216.2843,"upperUsd":1763.3773},"centralUsd":1547.9409,"fitCount":10,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":873.831,"upperUsd":1841.0297},"centralUsd":1448.7295,"fitCount":28,"participantCount":12},
      "day": "2026-08-05",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":851.9802,"upperUsd":1873.9674},"centralUsd":1070.1575,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1487.2267,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1183.594,"upperUsd":1715.3839},"centralUsd":1519.1242,"fitCount":9,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":873.831,"upperUsd":1786.3673},"centralUsd":1429.6486,"fitCount":28,"participantCount":12},
      "day": "2026-08-06",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":851.9802,"upperUsd":1873.9674},"centralUsd":1070.1575,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1487.2267,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1183.594,"upperUsd":1715.3839},"centralUsd":1519.1242,"fitCount":9,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":873.831,"upperUsd":1786.3673},"centralUsd":1429.6486,"fitCount":28,"participantCount":12},
      "day": "2026-08-07",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":851.9802,"upperUsd":1873.9674},"centralUsd":1070.1575,"fitCount":9,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":876.4221,"upperUsd":1771.3266},"centralUsd":1487.2267,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1011.3734,"upperUsd":1709.414},"centralUsd":1453.899,"fitCount":10,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":876.3025,"upperUsd":1778.6256},"centralUsd":1422.5708,"fitCount":29,"participantCount":12},
      "day": "2026-08-08",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":854.2554,"upperUsd":1857.263},"centralUsd":1185.8372,"fitCount":10,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":866.7752,"upperUsd":1805.1246},"centralUsd":1480.149,"fitCount":8,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1011.3734,"upperUsd":1709.414},"centralUsd":1453.899,"fitCount":10,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":873.831,"upperUsd":1786.3673},"centralUsd":1405.6223,"fitCount":28,"participantCount":12},
      "day": "2026-08-09",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":856.5306,"upperUsd":1840.5586},"centralUsd":1301.517,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":969.1094,"upperUsd":1835.1827},"centralUsd":1480.149,"fitCount":6,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1021.2959,"upperUsd":1703.4442},"centralUsd":1519.1242,"fitCount":11,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":909.8234,"upperUsd":1786.3673},"centralUsd":1441.6518,"fitCount":28,"participantCount":11},
      "day": "2026-08-10",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":856.5306,"upperUsd":1840.5586},"centralUsd":1301.517,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":969.1094,"upperUsd":1835.1827},"centralUsd":1480.149,"fitCount":6,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1021.2959,"upperUsd":1703.4442},"centralUsd":1519.1242,"fitCount":11,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":909.8234,"upperUsd":1786.3673},"centralUsd":1441.6518,"fitCount":28,"participantCount":11},
      "day": "2026-08-11",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":865.6193,"upperUsd":1819.917},"centralUsd":1381.1249,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":969.1094,"upperUsd":1835.1827},"centralUsd":1480.149,"fitCount":6,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1011.3734,"upperUsd":1644.6374},"centralUsd":1453.899,"fitCount":10,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":909.8234,"upperUsd":1786.3673},"centralUsd":1441.6518,"fitCount":28,"participantCount":11},
      "day": "2026-08-12",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":865.6193,"upperUsd":1819.917},"centralUsd":1381.1249,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":969.1094,"upperUsd":1835.1827},"centralUsd":1480.149,"fitCount":6,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1593.1714},"centralUsd":1338.8895,"fitCount":8,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":901.6583,"upperUsd":1793.7532},"centralUsd":1405.6223,"fitCount":26,"participantCount":11},
      "day": "2026-08-13",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.0538,"upperUsd":1819.917},"centralUsd":1381.1249,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":969.1094,"upperUsd":1835.1827},"centralUsd":1480.149,"fitCount":6,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":981.606,"upperUsd":1598.6427},"centralUsd":1388.6737,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":866.4166,"upperUsd":1803.1143},"centralUsd":1422.5708,"fitCount":25,"participantCount":11},
      "day": "2026-08-14",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":838.329,"upperUsd":1799.2754},"centralUsd":1301.517,"fitCount":13,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":986.6821,"upperUsd":1817.5357},"centralUsd":1537.7272,"fitCount":7,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":981.606,"upperUsd":1598.6427},"centralUsd":1388.6737,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":871.3595,"upperUsd":1784.3921},"centralUsd":1422.5708,"fitCount":27,"participantCount":12},
      "day": "2026-08-15",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.0538,"upperUsd":1621.6022},"centralUsd":1178.4029,"fitCount":12,"participantCount":4},
        "pro": {"band80Usd":{"lowerUsd":986.6821,"upperUsd":1817.5357},"centralUsd":1537.7272,"fitCount":7,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1626.3016},"centralUsd":1455.1701,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":871.3595,"upperUsd":1718.8013},"centralUsd":1422.5708,"fitCount":27,"participantCount":12},
      "day": "2026-08-16",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":833.7786,"upperUsd":1634.1427},"centralUsd":1055.2887,"fitCount":11,"participantCount":4},
        "pro": {"band80Usd":{"lowerUsd":1239.772,"upperUsd":1835.1827},"centralUsd":1618.8821,"fitCount":6,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1626.3016},"centralUsd":1455.1701,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":882.7468,"upperUsd":1728.1835},"centralUsd":1422.5708,"fitCount":25,"participantCount":12},
      "day": "2026-08-17",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.0538,"upperUsd":1621.6022},"centralUsd":1178.4029,"fitCount":12,"participantCount":4},
        "pro": {"band80Usd":{"lowerUsd":1276.3318,"upperUsd":1817.5357},"centralUsd":1699.228,"fitCount":7,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":981.606,"upperUsd":1627.04},"centralUsd":1388.6737,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":889.3008,"upperUsd":1723.4924},"centralUsd":1429.2681,"fitCount":26,"participantCount":13},
      "day": "2026-08-18",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":838.329,"upperUsd":1613.117},"centralUsd":1301.517,"fitCount":13,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1276.3318,"upperUsd":1817.5357},"centralUsd":1699.228,"fitCount":7,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1626.3016},"centralUsd":1333.5816,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":902.4089,"upperUsd":1714.1102},"centralUsd":1429.2681,"fitCount":28,"participantCount":14},
      "day": "2026-08-19",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.0538,"upperUsd":1623.6298},"centralUsd":1368.7412,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1276.3318,"upperUsd":1817.5357},"centralUsd":1699.228,"fitCount":7,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1001.4509,"upperUsd":1625.5632},"centralUsd":1278.4894,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":902.4089,"upperUsd":1714.1102},"centralUsd":1429.2681,"fitCount":28,"participantCount":14},
      "day": "2026-08-20",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":840.6042,"upperUsd":1602.6042},"centralUsd":1368.7412,"fitCount":14,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1297.3502,"upperUsd":1835.1827},"centralUsd":1699.6325,"fitCount":6,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1626.3016},"centralUsd":1333.5816,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":902.4089,"upperUsd":1714.1102},"centralUsd":1468.2303,"fitCount":28,"participantCount":14},
      "day": "2026-08-21",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":845.1546,"upperUsd":1714.4003},"centralUsd":1368.7412,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1297.3502,"upperUsd":1835.1827},"centralUsd":1699.6325,"fitCount":6,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":991.5284,"upperUsd":1626.3016},"centralUsd":1333.5816,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":908.0305,"upperUsd":1751.7188},"centralUsd":1468.2303,"fitCount":30,"participantCount":14},
      "day": "2026-08-22",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.705,"upperUsd":1834.9536},"centralUsd":1468.2303,"fitCount":18,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1297.3502,"upperUsd":1835.1827},"centralUsd":1699.6325,"fitCount":6,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":981.606,"upperUsd":1562.6345},"centralUsd":1278.4894,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":913.7528,"upperUsd":1794.6579},"centralUsd":1500.4953,"fitCount":31,"participantCount":14},
      "day": "2026-08-23",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.705,"upperUsd":1834.9536},"centralUsd":1468.2303,"fitCount":18,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1345.4256,"upperUsd":1817.5357},"centralUsd":1700.037,"fitCount":7,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1036.6484,"upperUsd":1572.8765},"centralUsd":1333.5816,"fitCount":6,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":913.7528,"upperUsd":1794.6579},"centralUsd":1508.7379,"fitCount":31,"participantCount":13},
      "day": "2026-08-24",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.705,"upperUsd":1834.9536},"centralUsd":1468.2303,"fitCount":18,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1297.3502,"upperUsd":1728.5715},"centralUsd":1699.6325,"fitCount":6,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1036.7385,"upperUsd":1562.6345},"centralUsd":1278.4894,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":913.7528,"upperUsd":1746.9477},"centralUsd":1500.4953,"fitCount":31,"participantCount":12},
      "day": "2026-08-25",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.705,"upperUsd":1834.9536},"centralUsd":1468.2303,"fitCount":18,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1602.3275,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1036.7385,"upperUsd":1562.6345},"centralUsd":1278.4894,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":908.0305,"upperUsd":1751.7188},"centralUsd":1504.6166,"fitCount":30,"participantCount":12},
      "day": "2026-08-26",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":881.7631,"upperUsd":1698.3487},"centralUsd":1435.9653,"fitCount":17,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1602.3275,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1036.7385,"upperUsd":1562.6345},"centralUsd":1278.4894,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":940.6849,"upperUsd":1717.5458},"centralUsd":1500.4953,"fitCount":29,"participantCount":12},
      "day": "2026-08-27",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":873.7657,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1602.3275,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1036.7385,"upperUsd":1562.6345},"centralUsd":1278.4894,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":978.3198,"upperUsd":1721.221},"centralUsd":1504.6166,"fitCount":28,"participantCount":12},
      "day": "2026-08-28",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":873.7657,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1159.45,"upperUsd":1728.5715},"centralUsd":1699.6325,"fitCount":6,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1034.1648,"upperUsd":1572.8765},"centralUsd":1165.2451,"fitCount":6,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":889.7605,"upperUsd":1721.221},"centralUsd":1504.6166,"fitCount":28,"participantCount":12},
      "day": "2026-08-29",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":873.7657,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1159.45,"upperUsd":1728.5715},"centralUsd":1699.6325,"fitCount":6,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1034.1648,"upperUsd":1572.8765},"centralUsd":1165.2451,"fitCount":6,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":889.7605,"upperUsd":1721.221},"centralUsd":1504.6166,"fitCount":28,"participantCount":12},
      "day": "2026-08-30",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":873.7657,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1148.3949,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1009.3954,"upperUsd":1562.6345},"centralUsd":1052.0008,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":889.7605,"upperUsd":1721.221},"centralUsd":1468.2303,"fitCount":28,"participantCount":12},
      "day": "2026-08-31",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":873.7657,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1148.3949,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1009.3954,"upperUsd":1562.6345},"centralUsd":1052.0008,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":889.7605,"upperUsd":1721.221},"centralUsd":1468.2303,"fitCount":28,"participantCount":12},
      "day": "2026-09-01",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.3498,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1148.3949,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1012.3706,"upperUsd":1552.3925},"centralUsd":1165.2451,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":887.9916,"upperUsd":1717.5458},"centralUsd":1435.9653,"fitCount":29,"participantCount":13},
      "day": "2026-09-02",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":862.2304,"upperUsd":1698.3487},"centralUsd":1435.9653,"fitCount":17,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":1148.3949,"upperUsd":1732.2468},"centralUsd":1700.037,"fitCount":5,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1012.3706,"upperUsd":1552.3925},"centralUsd":1165.2451,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":900.8722,"upperUsd":1713.8705},"centralUsd":1423.0995,"fitCount":30,"participantCount":13},
      "day": "2026-09-03",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":862.2304,"upperUsd":1698.3487},"centralUsd":1435.9653,"fitCount":17,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":877.6675,"upperUsd":1728.5715},"centralUsd":1699.6325,"fitCount":6,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1012.3706,"upperUsd":1552.3925},"centralUsd":1165.2451,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":913.7528,"upperUsd":1710.1953},"centralUsd":1410.2337,"fitCount":31,"participantCount":13},
      "day": "2026-09-04",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.3498,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":858.3686,"upperUsd":1706.132},"centralUsd":1699.228,"fitCount":5,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1012.3706,"upperUsd":1552.3925},"centralUsd":1165.2451,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":887.9916,"upperUsd":1702.0687},"centralUsd":1410.2337,"fitCount":29,"participantCount":12},
      "day": "2026-09-05",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.3498,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":858.3686,"upperUsd":1706.132},"centralUsd":1699.228,"fitCount":5,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1015.3457,"upperUsd":1542.1505},"centralUsd":1278.4894,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":900.8722,"upperUsd":1701.0528},"centralUsd":1388.865,"fitCount":30,"participantCount":12},
      "day": "2026-09-06",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":849.3498,"upperUsd":1714.4003},"centralUsd":1468.2303,"fitCount":16,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":858.3686,"upperUsd":1706.132},"centralUsd":1699.228,"fitCount":5,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1552.3925},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":887.9916,"upperUsd":1702.0687},"centralUsd":1410.2337,"fitCount":29,"participantCount":12},
      "day": "2026-09-07",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.4692,"upperUsd":1730.4518},"centralUsd":1435.9653,"fitCount":15,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":858.3686,"upperUsd":1706.132},"centralUsd":1699.228,"fitCount":5,"participantCount":3},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1552.3925},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":875.111,"upperUsd":1703.0845},"centralUsd":1388.865,"fitCount":28,"participantCount":12},
      "day": "2026-09-08",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.4692,"upperUsd":1718.5353},"centralUsd":1289.8322,"fitCount":15,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":787.5592,"upperUsd":1702.0687},"centralUsd":1484.9724,"fitCount":9,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1640.9873},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":801.6155,"upperUsd":1699.9561},"centralUsd":1328.6642,"fitCount":32,"participantCount":13},
      "day": "2026-09-09",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.4692,"upperUsd":1718.5353},"centralUsd":1289.8322,"fitCount":15,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":787.5592,"upperUsd":1702.0687},"centralUsd":1484.9724,"fitCount":9,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1640.9873},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":801.6155,"upperUsd":1699.9561},"centralUsd":1328.6642,"fitCount":32,"participantCount":13},
      "day": "2026-09-10",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.4692,"upperUsd":1718.5353},"centralUsd":1257.0321,"fitCount":15,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1701.0528},"centralUsd":1530.6248,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1035.9358,"upperUsd":1635.3537},"centralUsd":1367.4962,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":826.5349,"upperUsd":1699.7943},"centralUsd":1328.6642,"fitCount":34,"participantCount":13},
      "day": "2026-09-11",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":836.4692,"upperUsd":1718.5353},"centralUsd":1257.0321,"fitCount":15,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1701.0528},"centralUsd":1530.6248,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1035.9358,"upperUsd":1635.3537},"centralUsd":1367.4962,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":826.5349,"upperUsd":1699.7943},"centralUsd":1328.6642,"fitCount":34,"participantCount":13},
      "day": "2026-09-12",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":940.2172,"upperUsd":1737.566},"centralUsd":1273.4321,"fitCount":14,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1701.0528},"centralUsd":1530.6248,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1035.9358,"upperUsd":1635.3537},"centralUsd":1367.4962,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":925.8347,"upperUsd":1699.8752},"centralUsd":1367.4962,"fitCount":33,"participantCount":13},
      "day": "2026-09-13",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":940.2172,"upperUsd":1737.566},"centralUsd":1328.8264,"fitCount":14,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":787.5592,"upperUsd":1701.4215},"centralUsd":1484.9724,"fitCount":9,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1035.9358,"upperUsd":1635.3537},"centralUsd":1367.4962,"fitCount":9,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":919.7937,"upperUsd":1697.3475},"centralUsd":1367.6584,"fitCount":32,"participantCount":13},
      "day": "2026-09-14",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":940.2172,"upperUsd":1737.566},"centralUsd":1328.8264,"fitCount":14,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1700.3247},"centralUsd":1346.9012,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1499.1171},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":919.7937,"upperUsd":1697.3475},"centralUsd":1328.6642,"fitCount":32,"participantCount":13},
      "day": "2026-09-15",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":940.2172,"upperUsd":1737.566},"centralUsd":1328.8264,"fitCount":14,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1700.3247},"centralUsd":1346.9012,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1499.1171},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":919.7937,"upperUsd":1697.3475},"centralUsd":1328.6642,"fitCount":32,"participantCount":13},
      "day": "2026-09-16",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":931.3957,"upperUsd":1756.5966},"centralUsd":1289.8322,"fitCount":13,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":787.5592,"upperUsd":1613.4305},"centralUsd":1208.83,"fitCount":9,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1030.387,"upperUsd":1499.1171},"centralUsd":1322.9928,"fitCount":8,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":901.2931,"upperUsd":1683.3998},"centralUsd":1284.1608,"fitCount":30,"participantCount":13},
      "day": "2026-09-17",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":931.3957,"upperUsd":1756.5966},"centralUsd":1275.075,"fitCount":13,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1728.2238},"centralUsd":1346.9012,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1024.8381,"upperUsd":1525.0179},"centralUsd":1367.4962,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":901.2931,"upperUsd":1718.6415},"centralUsd":1282.4536,"fitCount":30,"participantCount":13},
      "day": "2026-09-18",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":931.3957,"upperUsd":1756.5966},"centralUsd":1275.075,"fitCount":13,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1728.2238},"centralUsd":1346.9012,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1019.2892,"upperUsd":1550.9187},"centralUsd":1388.865,"fitCount":6,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":888.8334,"upperUsd":1727.0878},"centralUsd":1289.8322,"fitCount":29,"participantCount":12},
      "day": "2026-09-19",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":922.5742,"upperUsd":1915.545},"centralUsd":1282.4536,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1728.2238},"centralUsd":1346.9012,"fitCount":10,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1024.8381,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":888.8334,"upperUsd":1813.8225},"centralUsd":1367.4962,"fitCount":29,"participantCount":12},
      "day": "2026-09-20",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":1001.9675,"upperUsd":1928.9769},"centralUsd":1289.8322,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":789.1558,"upperUsd":1890.4809},"centralUsd":1484.9724,"fitCount":11,"participantCount":4},
        "prolite": {"band80Usd":{"lowerUsd":1024.8381,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":937.161,"upperUsd":1898.1801},"centralUsd":1367.8207,"fitCount":29,"participantCount":12},
      "day": "2026-09-21",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":979.3581,"upperUsd":1434.1163},"centralUsd":1199.8142,"fitCount":10,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":807.6564,"upperUsd":1941.999},"centralUsd":1530.6248,"fitCount":12,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1024.8381,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":937.161,"upperUsd":1901.9294},"centralUsd":1367.4962,"fitCount":29,"participantCount":13},
      "day": "2026-09-22",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":775.8733,"upperUsd":1375.9037},"centralUsd":1124.5535,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":789.1558,"upperUsd":1947.7232},"centralUsd":1484.9724,"fitCount":11,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1024.8381,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":787.5592,"upperUsd":1901.9294},"centralUsd":1289.8322,"fitCount":29,"participantCount":13},
      "day": "2026-09-23",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":775.8733,"upperUsd":1375.9037},"centralUsd":1124.5535,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":789.1558,"upperUsd":1947.7232},"centralUsd":1484.9724,"fitCount":11,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1179.5205,"upperUsd":1662.7778},"centralUsd":1415.8243,"fitCount":6,"participantCount":3},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":786.7609,"upperUsd":1907.6536},"centralUsd":1328.6642,"fitCount":28,"participantCount":13},
      "day": "2026-09-24",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":798.4827,"upperUsd":1605.2712},"centralUsd":1199.8142,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":807.6564,"upperUsd":1941.999},"centralUsd":1530.6248,"fitCount":12,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1217.1156,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":789.1558,"upperUsd":1890.4809},"centralUsd":1367.8207,"fitCount":31,"participantCount":14},
      "day": "2026-09-25",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":775.8733,"upperUsd":1630.7565},"centralUsd":1275.075,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":807.6564,"upperUsd":1941.999},"centralUsd":1530.6248,"fitCount":12,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1217.1156,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1896.2051},"centralUsd":1371.8622,"fitCount":30,"participantCount":14},
      "day": "2026-09-26",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":775.8733,"upperUsd":1630.7565},"centralUsd":1275.075,"fitCount":11,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":807.6564,"upperUsd":1941.999},"centralUsd":1530.6248,"fitCount":12,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1217.1156,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":788.3575,"upperUsd":1896.2051},"centralUsd":1371.8622,"fitCount":30,"participantCount":14},
      "day": "2026-09-27",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":798.4827,"upperUsd":1605.2712},"centralUsd":1199.8142,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":974.1623,"upperUsd":1947.7232},"centralUsd":1576.2773,"fitCount":11,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1217.1156,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":955.6616,"upperUsd":1896.2051},"centralUsd":1371.8622,"fitCount":30,"participantCount":14},
      "day": "2026-09-28",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":798.4827,"upperUsd":1605.2712},"centralUsd":1199.8142,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":981.4237,"upperUsd":1941.999},"centralUsd":1530.6248,"fitCount":12,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1217.1156,"upperUsd":1659.2488},"centralUsd":1410.2337,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":974.1623,"upperUsd":1890.4809},"centralUsd":1367.8207,"fitCount":31,"participantCount":14},
      "day": "2026-09-29",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":798.4827,"upperUsd":1605.2712},"centralUsd":1199.8142,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":976.3399,"upperUsd":1936.2748},"centralUsd":1484.9724,"fitCount":13,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1392.5682,"upperUsd":1740.7686},"centralUsd":1421.4148,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":975.2511,"upperUsd":1884.5616},"centralUsd":1371.8622,"fitCount":32,"participantCount":14},
      "day": "2026-09-30",
    },
    {
      "byPlanType": {
        "plus": {"band80Usd":{"lowerUsd":798.4827,"upperUsd":1605.2712},"centralUsd":1199.8142,"fitCount":12,"participantCount":5},
        "pro": {"band80Usd":{"lowerUsd":976.3399,"upperUsd":1936.2748},"centralUsd":1484.9724,"fitCount":13,"participantCount":5},
        "prolite": {"band80Usd":{"lowerUsd":1392.5682,"upperUsd":1740.7686},"centralUsd":1421.4148,"fitCount":7,"participantCount":4},
        "promax": {"band80Usd":null,"centralUsd":null,"fitCount":0,"participantCount":0},
      },
      "combined": {"band80Usd":{"lowerUsd":975.2511,"upperUsd":1884.5616},"centralUsd":1371.8622,"fitCount":32,"participantCount":14},
      "day": "2026-10-01",
    },
  ],
  "from": "2026-07-24",
  "generatedAt": "2026-10-01T12:00:00.000Z",
  "models": {
    "basis": "seven_day_codex_pro20x_equivalent_per_model_composition_promax25",
    "days": [
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-02",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-03",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-04",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-05",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-06",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-07",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-08",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-09",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-10",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-11",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-12",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-13",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-14",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-15",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-16",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-17",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-18",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-19",
        "fittedParticipantCount": 0,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 6,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-20",
        "fittedParticipantCount": 1,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 5,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",595.916,1],["gpt-6-astra",315.9996,1],["gpt-6-sol",406.1372,1],["gpt-6.1-sol",323.3301,1]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-21",
        "fittedParticipantCount": 2,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 4,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",448.9886,2],["gpt-6-astra",516.959,2],["gpt-6-sol",495.5083,2],["gpt-6.1-sol",565.0456,2]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-22",
        "fittedParticipantCount": 3,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 3,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",595.916,3],["gpt-6-astra",600.1272,3],["gpt-6-sol",584.8793,3],["gpt-6.1-sol",379.2092,3]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-23",
        "fittedParticipantCount": 4,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 2,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",1416.985,4],["gpt-6-astra",659.0229,4],["gpt-6-sol",971.3663,4],["gpt-6.1-sol",592.9851,4]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-24",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 1,
        "unstableParticipantCount": 0,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-25",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-26",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-27",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-28",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-29",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-09-30",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
      {
        "catalogVersion": "reviewed-model-catalog-2026-09-29.1",
        "day": "2026-10-01",
        "fittedParticipantCount": 5,
        "refusedParticipantCount": 1,
        "staleParticipantCount": 0,
        "unstableParticipantCount": 1,
        "unsupportedSourceParticipantCount": 0,
        "v1ParticipantCount": 7,
        "values": [["gpt-5.6-terra",2238.054,5],["gpt-6-astra",717.9185,5],["gpt-6-sol",1357.8532,5],["gpt-6.1-sol",806.761,5]],
      },
    ],
    "gate": "shared_composition_kernel_identification",
    "modelConfig": [
      {"allowanceTrack":"primary","label":"Codex Auto-review","modelId":"codex-auto-review","pricingStatus":"assumed_alias"},
      {"allowanceTrack":"primary","label":"GPT-4 Turbo (2024-04-09)","modelId":"gpt-4-turbo-2024-04-09","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4.1","modelId":"gpt-4.1","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4.1 Mini","modelId":"gpt-4.1-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4.1 Nano","modelId":"gpt-4.1-nano","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4o","modelId":"gpt-4o","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4o (2024-05-13)","modelId":"gpt-4o-2024-05-13","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-4o Mini","modelId":"gpt-4o-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5","modelId":"gpt-5","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5 Codex","modelId":"gpt-5-codex","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5 Mini","modelId":"gpt-5-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5 Nano","modelId":"gpt-5-nano","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5 Pro","modelId":"gpt-5-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.1","modelId":"gpt-5.1","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.1 Codex","modelId":"gpt-5.1-codex","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.1 Codex Mini","modelId":"gpt-5.1-codex-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.2","modelId":"gpt-5.2","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.2 Codex","modelId":"gpt-5.2-codex","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.2 Pro","modelId":"gpt-5.2-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.3 Codex","modelId":"gpt-5.3-codex","pricingStatus":"published"},
      {"allowanceTrack":"spark","label":"GPT-5.3 Codex Spark","modelId":"gpt-5.3-codex-spark","pricingStatus":"unpriced"},
      {"allowanceTrack":"primary","label":"GPT-5.4","modelId":"gpt-5.4","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.4 Mini","modelId":"gpt-5.4-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.4 Nano","modelId":"gpt-5.4-nano","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.4 Pro","modelId":"gpt-5.4-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.5","modelId":"gpt-5.5","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.5 Codex","modelId":"gpt-5.5-codex","pricingStatus":"assumed_alias"},
      {"allowanceTrack":"primary","label":"GPT-5.5 Pro","modelId":"gpt-5.5-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.6 Luna","modelId":"gpt-5.6-luna","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.6 Sol","modelId":"gpt-5.6-sol","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-5.6 Sol Work Mode","modelId":"gpt-5.6-sol-wm","pricingStatus":"assumed_alias"},
      {"allowanceTrack":"primary","label":"GPT-5.6 Terra","modelId":"gpt-5.6-terra","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-6 Astra","modelId":"gpt-6-astra","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o1","modelId":"o1","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o1 Pro","modelId":"o1-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o3","modelId":"o3","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o3 Mini","modelId":"o3-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o3 Pro","modelId":"o3-pro","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"o4 Mini","modelId":"o4-mini","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-6 Sol","modelId":"gpt-6-sol","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-6 Luna","modelId":"gpt-6-luna","pricingStatus":"published"},
      {"allowanceTrack":"primary","label":"GPT-6.1 Astra (forecast)","modelId":"gpt-6.1-astra","pricingStatus":"unpriced"},
      {"allowanceTrack":"primary","label":"GPT-6.1 Sol","modelId":"gpt-6.1-sol","pricingStatus":"published"},
    ],
  },
  "plans": [
    {"label":"Pro 20x","multiplier":1,"planType":"pro"},
    {"label":"Pro 5x","multiplier":4,"planType":"prolite"},
    {"label":"Pro Max 25x","multiplier":0.8,"planType":"promax"},
    {"label":"Plus","multiplier":20,"planType":"plus"},
  ],
  "qualification": "shared_reset_fit_gates_25pp_span_floor",
  "referencePlanType": "pro",
  "schemaVersion": "admin-community-allowance-preview-v0.5",
  "spanFloorPp": 25,
  "to": "2026-10-01",
  "trailingDays": 30,
};
