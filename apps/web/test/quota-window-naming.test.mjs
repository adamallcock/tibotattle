import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyQuotaWindowKind,
  isSparkQuotaLimitId,
  normalizeDashboardPayload,
  quotaLimitDisplayAlias,
  quotaWindowLabel,
  sanitizeQuotaLimitDisplayName,
  sanitizeQuotaLimitId,
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  CODEX_SPARK_LIMIT_IDS,
  CODEX_SPARK_RESERVED_LIMIT_ID,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  QUOTA_WINDOW_KINDS,
} from "../public/data-client.js";
import {
  quotaLimitDisplayAlias as sharedQuotaLimitDisplayAlias,
  sanitizeQuotaLimitDisplayName as sharedSanitizeQuotaLimitDisplayName,
  sanitizeQuotaLimitId as sharedSanitizeQuotaLimitId,
} from "../../../packages/quota-analysis/index.js";
import {
  SUPPORTED_LOCALES,
  translate,
  translatePlural,
} from "../public/localization.js";

// The provider re-introduced the 5-hour "Codex Spark" allowance window on
// 2026-08-19. On the wire it arrives from `account/rateLimits/read` as a
// distinct rate-limit window on the separate Spark limit — limit_id
// "codex_bengalfox", window_minutes 300 — in the limit's `primary` slot,
// while the Spark seven-day window moves to `secondary`, all alongside the
// normal Codex weekly window. These tests pin that observed shape and the
// display identity each window classifies into.

test("window kinds map from technical identity alone, including the returned 5-hour Spark window", () => {
  assert.deepEqual(CODEX_SPARK_LIMIT_IDS, ["codex_bengalfox", "codex-spark"]);
  assert.equal(isSparkQuotaLimitId(CODEX_SPARK_LIMIT_ID), true);
  assert.equal(isSparkQuotaLimitId(CODEX_SPARK_RESERVED_LIMIT_ID), true);
  assert.equal(isSparkQuotaLimitId(CODEX_PRIMARY_LIMIT_ID), false);
  assert.equal(isSparkQuotaLimitId("unknown"), false);

  const expectations = [
    // The normal Codex allowance track keeps its named durations.
    [CODEX_PRIMARY_LIMIT_ID, CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, "codex_five_hour"],
    [CODEX_PRIMARY_LIMIT_ID, CODEX_WEEKLY_ALLOWANCE_MINUTES, "codex_seven_day"],
    [CODEX_PRIMARY_LIMIT_ID, 43_200, "codex_provider_reported"],
    [CODEX_PRIMARY_LIMIT_ID, 0, "other"],
    [CODEX_PRIMARY_LIMIT_ID, null, "other"],
    // The re-introduced 5-hour Spark window and the Spark weekly window are
    // distinct kinds on the same separate limit.
    [CODEX_SPARK_LIMIT_ID, CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, "spark_five_hour"],
    [CODEX_SPARK_LIMIT_ID, CODEX_WEEKLY_ALLOWANCE_MINUTES, "spark_seven_day"],
    // A novel valid Spark duration keeps the generic Spark kind rather than
    // borrowing a named duration (525,600 minutes was the Spark limit's
    // original observed shape). Invalid durations remain unclassified.
    [CODEX_SPARK_LIMIT_ID, 525_600, "spark_other"],
    [CODEX_SPARK_LIMIT_ID, 0, "other"],
    [CODEX_SPARK_LIMIT_ID, null, "other"],
    // The reserved marketing token classifies identically to the wire id.
    [CODEX_SPARK_RESERVED_LIMIT_ID, CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, "spark_five_hour"],
    [CODEX_SPARK_RESERVED_LIMIT_ID, CODEX_WEEKLY_ALLOWANCE_MINUTES, "spark_seven_day"],
    // An unrecognized limit id never inherits a named window identity.
    ["mystery_limit", CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, "other"],
    ["mystery_limit", CODEX_WEEKLY_ALLOWANCE_MINUTES, "other"],
    ["unknown", 300, "other"],
    [null, 300, "other"],
    [undefined, undefined, "other"],
  ];
  for (const [limitId, durationMinutes, kind] of expectations) {
    assert.equal(
      classifyQuotaWindowKind(limitId, durationMinutes),
      kind,
      `${String(limitId)} + ${String(durationMinutes)}`,
    );
    assert.equal(QUOTA_WINDOW_KINDS.includes(kind), true, kind);
  }
});

test("fixed window labels name the Spark durations and keep honest generic fallbacks", () => {
  assert.equal(quotaWindowLabel("codex", 300), "Five-hour allowance");
  assert.equal(quotaWindowLabel("codex", 10_080), "Seven-day allowance");
  assert.equal(quotaWindowLabel("codex", 43_200), "Provider-reported 30-day window");
  assert.equal(quotaWindowLabel("codex_bengalfox", 300), "Spark five-hour allowance");
  assert.equal(quotaWindowLabel("codex_bengalfox", 10_080), "Spark seven-day allowance");
  assert.equal(quotaWindowLabel("codex-spark", 300), "Spark five-hour allowance");
  // Unfamiliar valid Spark durations stay generically Spark; an invalid
  // duration remains unnamed, and neither is presented as a normal Codex
  // allowance.
  assert.equal(quotaWindowLabel("codex_bengalfox", 525_600), "Spark allowance");
  assert.equal(quotaWindowLabel("codex_bengalfox", null), "Other observed allowance");
  // Unknown limits gain a duration fallback without borrowing a known pool.
  assert.equal(quotaWindowLabel("unknown", 300), "Other observed 5-hour allowance");
  assert.equal(quotaWindowLabel(null, 10_080), "Other observed 7-day allowance");
  assert.equal(
    quotaWindowLabel("future_pool", 43_200, "Future Pool"),
    "Future Pool · 30-day allowance",
  );
  assert.equal(quotaWindowLabel("codex", null), "Other observed allowance");
});

test("browser limit sanitizers match the canonical runtime-neutral contract", () => {
  const ids = [
    "codex",
    "codex_bengalfox",
    "future_pool:v2",
    "unknown",
    "",
    " future_pool",
    "future/pool",
    "_future",
    "x".repeat(65),
    null,
  ];
  for (const value of ids) {
    assert.equal(
      sanitizeQuotaLimitId(value),
      sharedSanitizeQuotaLimitId(value),
      String(value),
    );
  }
  const names = [
    "GPT-5.3-Codex-Spark",
    "  Future Pool  ",
    "未来额度",
    "Account alice@example.com",
    "https://example.com/limit",
    "Future\nPool",
    "<Future Pool>",
    "x".repeat(81),
    null,
  ];
  for (const value of names) {
    assert.equal(
      sanitizeQuotaLimitDisplayName(value),
      sharedSanitizeQuotaLimitDisplayName(value),
      String(value),
    );
  }
  for (const limitId of ["codex", "codex_bengalfox", "codex-spark", "future_pool"]) {
    assert.equal(
      quotaLimitDisplayAlias(limitId),
      sharedQuotaLimitDisplayAlias(limitId),
      limitId,
    );
  }
});

test("Spark window titles are translated in every supported locale", () => {
  const expected = {
    "dashboard.quota.windowSparkFiveHour": {
      "en-US": "Spark five-hour allowance",
      "zh-Hans": "Spark 五小时额度",
      es: "Asignación de Spark de cinco horas",
    },
    "dashboard.quota.windowSparkSevenDay": {
      "en-US": "Spark seven-day allowance",
      "zh-Hans": "Spark 七天额度",
      es: "Asignación de Spark de siete días",
    },
    "dashboard.quota.windowSpark": {
      "en-US": "Spark allowance",
      "zh-Hans": "Spark 额度",
      es: "Asignación de Spark",
    },
    "dashboard.quota.windowOther": {
      "en-US": "Other observed allowance",
      "zh-Hans": "其他观测到的额度",
      es: "Otra asignación observada",
    },
    "dashboard.quota.windowOtherDuration": {
      "en-US": "Other observed 30-day allowance",
      "zh-Hans": "其他观测到的 30 天额度",
      es: "Otra asignación observada de 30 días",
    },
    "dashboard.quota.windowNamedObserved": {
      "en-US": "Future Pool · 30-day allowance",
      "zh-Hans": "Future Pool · 30 天额度",
      es: "Future Pool · asignación de 30 días",
    },
  };
  for (const [key, byLocale] of Object.entries(expected)) {
    for (const locale of SUPPORTED_LOCALES) {
      const values = key === "dashboard.quota.windowOtherDuration"
        ? { duration: translatePlural("quota.durationDay", 30, {}, locale) }
        : key === "dashboard.quota.windowNamedObserved"
          ? {
              name: "Future Pool",
              duration: translatePlural("quota.durationDay", 30, {}, locale),
            }
          : {};
      assert.equal(translate(key, values, locale), byLocale[locale], `${key} ${locale}`);
    }
  }
});

test("future pools remain distinct and use only bounded local display metadata", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      {
        limitId: "future_alpha",
        limitName: "Future Alpha",
        slot: "primary",
        durationMinutes: 1_440,
        usedPercent: 10,
      },
      {
        limitId: "future_beta",
        limitName: "Account alice@example.com",
        slot: "primary",
        durationMinutes: 43_200,
        usedPercent: 20,
      },
      {
        limitId: "future/pool",
        limitName: "Future Gamma",
        slot: "primary",
        durationMinutes: 300,
        usedPercent: 30,
      },
    ],
  });

  assert.deepEqual(
    result.quotaWindows.map((window) => [
      window.limitId,
      window.limitName,
      window.label,
    ]),
    [
      ["future_alpha", "Future Alpha", "Future Alpha · 1-day allowance"],
      ["future_beta", null, "Other observed 30-day allowance"],
      ["unknown", "Future Gamma", "Future Gamma · 5-hour allowance"],
    ],
  );
  assert.equal(new Set(result.quotaWindows.map((window) => window.limitId)).size, 3);
  assert.equal(result.quotaWindows.some((window) => window.limitId === "codex"), false);
});

test("the observed three-window wire shape normalizes into distinctly named windows", () => {
  // Shape recorded by the live collector on 2026-08-19T23:49:40Z (epoch
  // resets abbreviated to ISO instants the browser contract carries).
  const result = normalizeDashboardPayload({}, {
    overview: {
      schemaVersion: "local-companion-v0.1",
      mode: "real_local_evidence",
      evidenceStatus: "available",
      latestEvidenceAt: "2026-08-19T23:49:40.000Z",
      freshness: { status: "live", ageSeconds: 30 },
      quota: {
        observedAt: "2026-08-19T23:49:40.000Z",
        windows: [
          {
            limitId: "codex",
            slot: "primary",
            planType: "pro",
            usedPercent: 100,
            durationMinutes: 10_080,
            resetAt: "2026-08-20T05:54:08.000Z",
          },
          {
            limitId: "codex_bengalfox",
            slot: "primary",
            planType: "pro",
            usedPercent: 0,
            durationMinutes: 300,
            resetAt: "2026-08-20T04:49:39.000Z",
          },
          {
            limitId: "codex_bengalfox",
            slot: "secondary",
            planType: "pro",
            usedPercent: 0,
            durationMinutes: 10_080,
            resetAt: "2026-08-26T23:49:39.000Z",
          },
        ],
      },
      usage: [],
    },
  });
  assert.deepEqual(
    result.quotaWindows.map((window) => [window.limitId, window.durationMinutes, window.label]),
    [
      ["codex", 10_080, "Seven-day allowance"],
      ["codex_bengalfox", 300, "Spark five-hour allowance"],
      ["codex_bengalfox", 10_080, "Spark seven-day allowance"],
    ],
  );
  assert.deepEqual(
    result.quotaWindows.map((window) => classifyQuotaWindowKind(window.limitId, window.durationMinutes)),
    ["codex_seven_day", "spark_five_hour", "spark_seven_day"],
  );
  // The Spark windows never join the normal Codex allowance selection.
  assert.deepEqual(
    result.quotaWindows.filter((window) => isSparkQuotaLimitId(window.limitId)).length,
    2,
  );
});
