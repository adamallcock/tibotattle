import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  demoDashboard,
  normalizeDashboardPayload,
} from "../public/data-client.js";

async function allowanceWindowResolver(activeWindowMinutes = null) {
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function allowanceHistoryForWindow");
  const end = source.indexOf("\nfunction allowanceWindowView", start);
  assert.ok(start >= 0 && end > start);
  return Function(
    "CODEX_FIVE_HOUR_ALLOWANCE_MINUTES",
    "CODEX_WEEKLY_ALLOWANCE_MINUTES",
    "activeAllowanceWindowMinutes",
    `${source.slice(start, end)}\nreturn resolvedAllowanceWindowMinutes;`,
  )(
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
    CODEX_WEEKLY_ALLOWANCE_MINUTES,
    activeWindowMinutes,
  );
}

test("allowance history normalization keeps only the supported five-hour lane", () => {
  const dashboard = normalizeDashboardPayload({
    weekly: {
      status: "available",
      summary: [{ median_weekly_value_usd: 1_800 }],
      weekly_values: [{
        last_observed_at: "2026-09-01T00:00:00.000Z",
        displayed_span_pp: 80,
        value_usd: 1_800,
      }],
    },
    allowanceHistoryByWindow: {
      [CODEX_FIVE_HOUR_ALLOWANCE_MINUTES]: {
        status: "available",
        summary: [{ median_weekly_value_usd: 112 }],
        weekly_values: [{
          last_observed_at: "2026-09-01T05:00:00.000Z",
          displayed_span_pp: 72,
          value_usd: 112,
          private_context: "must not survive",
        }],
      },
      60: {
        status: "available",
        summary: [{ median_weekly_value_usd: 999 }],
      },
    },
  });

  assert.deepEqual(
    Object.keys(dashboard.allowanceHistoryByWindow).sort(),
    [
      String(CODEX_FIVE_HOUR_ALLOWANCE_MINUTES),
      String(CODEX_WEEKLY_ALLOWANCE_MINUTES),
    ].sort(),
  );
  assert.equal(
    dashboard.allowanceHistoryByWindow[CODEX_WEEKLY_ALLOWANCE_MINUTES],
    dashboard.weekly,
    "the established weekly artifact remains the seven-day authority",
  );
  const fiveHour = dashboard.allowanceHistoryByWindow[
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
  ];
  assert.equal(fiveHour.summary.median_weekly_value_usd, 112);
  assert.equal(fiveHour.weeklyValues.length, 1);
  assert.equal(Object.hasOwn(fiveHour.weeklyValues[0], "private_context"), false);
});

test("the local weekly route can publish the five-hour lane", () => {
  const dashboard = normalizeDashboardPayload({}, {
    overview: { mode: "real_local_evidence", usage: [] },
    weekly: {
      weekly: {
        status: "available",
        datasets: {
          summary: [{ median_weekly_value_usd: 1_800 }],
          weekly_values: [],
        },
        allowanceHistoryByWindow: {
          300: {
            status: "available",
            planType: "pro",
            datasets: {
              summary: [{ median_weekly_value_usd: 112 }],
              weekly_values: [{
                last_observed_at: "2026-09-12T10:00:00.000Z",
                displayed_span_pp: 72,
                value_usd: 112,
              }],
            },
          },
        },
      },
    },
  });

  assert.equal(
    dashboard.allowanceHistoryByWindow[300].summary
      .median_weekly_value_usd,
    112,
  );
  assert.equal(dashboard.allowanceHistoryByWindow[300].planType, "pro");
  assert.equal(dashboard.allowanceHistoryByWindow[300].weeklyValues.length, 1);
});

test("the labeled demo carries both allowance-history windows", () => {
  const dashboard = demoDashboard({ now: "2026-09-12T12:00:00.000Z" });
  const fiveHour = dashboard.allowanceHistoryByWindow[
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
  ];

  assert.ok(dashboard.weekly.weeklyValues.length > 5);
  assert.equal(fiveHour.status, "available");
  assert.ok(fiveHour.weeklyValues.length > 20);
  assert.equal(dashboard.mode, "demo");
});

test("seven-day is preferred, with five-hour as the honest evidence fallback", async () => {
  const fiveHour = { status: "available", weeklyValues: [{ value_usd: 110 }] };
  const both = {
    weekly: { status: "available", weeklyValues: [{ value_usd: 1_800 }] },
    allowanceHistoryByWindow: {
      [CODEX_FIVE_HOUR_ALLOWANCE_MINUTES]: fiveHour,
    },
  };
  assert.equal(
    (await allowanceWindowResolver())(both),
    CODEX_WEEKLY_ALLOWANCE_MINUTES,
  );
  assert.equal(
    (await allowanceWindowResolver(CODEX_FIVE_HOUR_ALLOWANCE_MINUTES))(both),
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  );
  assert.equal(
    (await allowanceWindowResolver())({
      ...both,
      weekly: { status: "unavailable", weeklyValues: [] },
    }),
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  );
  assert.equal(
    (await allowanceWindowResolver(CODEX_FIVE_HOUR_ALLOWANCE_MINUTES))({
      weekly: both.weekly,
    }),
    CODEX_WEEKLY_ALLOWANCE_MINUTES,
  );
});

test("the Allowance page exposes one real two-state window control", async () => {
  const [html, appSource, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="allowance-window-controls"[^>]*role="group"/u);
  assert.match(html, /data-window-minutes="300"/u);
  assert.match(
    styles,
    /\.allowance-window-toggle button \{[\s\S]*?white-space: nowrap;[\s\S]*?\}/u,
    "the five-hour label stays on one line",
  );
  assert.match(
    html,
    /data-window-minutes="10080" class="active" aria-pressed="true"/u,
    "seven-day is the static first paint",
  );
  assert.match(appSource, /function resolvedAllowanceWindowMinutes\(data\)/u);
  assert.match(
    appSource,
    /if \(allowanceHistoryHasEvidence\(data\?\.weekly\)\) \{\s*return CODEX_WEEKLY_ALLOWANCE_MINUTES;/u,
    "seven-day wins the runtime default when it has evidence",
  );
  assert.match(appSource, /activeAllowanceWindowMinutes = windowMinutes;/u);
  assert.match(appSource, /renderWeekly\(dashboard\);/u);
  assert.match(
    appSource,
    /note\.hidden = !fiveHourSelected && fiveHourAvailable;/u,
    "an unavailable five-hour lane explains the evidence gate on the default view",
  );
});
