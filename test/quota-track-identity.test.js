import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveCodexTransitionSeries } from "../src/codex-transition-miner.js";
import {
  finalizeQuotaTimeline,
  orderQuotaWindows,
  quotaWindowProjection,
  sampleQuotaTimelineByTrack,
} from "../src/local-companion-usage-model.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { readLocalUnifiedCompanionProjection } from "../src/local-unified-companion-source.js";

// Quota track identity is (limit_id, duration): the provider's
// primary/secondary slots are server-assigned UI roles, not identities.
// Around 2026-07-06 the provider flipped the weekly (10080-minute) window
// from slot `secondary` to `primary` while the 300-minute window left
// telemetry. Any pipeline that keys a series by slot severs the weekly track
// at the flip and hides the pre-flip era from every slot-selected view.

const WEEKLY_MINUTES = 10_080;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_RESETS_AT = Math.floor(Date.parse("2026-07-28T12:00:00.000Z") / 1_000);
const FIVE_HOUR_RESETS_AT = Math.floor(Date.parse("2026-07-25T05:00:00.000Z") / 1_000);

function timelineRow({
  observedAt,
  slot,
  usedPercent,
  durationMinutes = WEEKLY_MINUTES,
  resetsAt = WEEKLY_RESETS_AT,
}) {
  const projected = quotaWindowProjection({
    limitId: "codex",
    slot,
    planType: "pro",
    usedPercent,
    windowDurationMins: durationMinutes,
    resetsAt,
  });
  assert.ok(projected, "fixture row must survive projection");
  return { observedAt, ...projected, accountAttribution: "unattributed" };
}

test("finalizeQuotaTimeline keeps one weekly track across the slot flip and a separate five-hour track", () => {
  const rows = [
    // Weekly window, pre-flip era: reported under slot `secondary`.
    timelineRow({ observedAt: "2026-07-25T00:01:00.000Z", slot: "secondary", usedPercent: 10 }),
    timelineRow({ observedAt: "2026-07-25T00:02:00.000Z", slot: "secondary", usedPercent: 11 }),
    // Weekly window, post-flip era: the SAME window now under slot `primary`.
    timelineRow({ observedAt: "2026-07-25T00:03:00.000Z", slot: "primary", usedPercent: 12 }),
    timelineRow({ observedAt: "2026-07-25T00:04:00.000Z", slot: "primary", usedPercent: 13 }),
    // The five-hour window stays a separate track BY DURATION even though it
    // shares limit_id and, pre-flip, the `primary` slot name.
    timelineRow({
      observedAt: "2026-07-25T00:01:00.000Z",
      slot: "primary",
      usedPercent: 40,
      durationMinutes: FIVE_HOUR_MINUTES,
      resetsAt: FIVE_HOUR_RESETS_AT,
    }),
    timelineRow({
      observedAt: "2026-07-25T00:02:00.000Z",
      slot: "primary",
      usedPercent: 41,
      durationMinutes: FIVE_HOUR_MINUTES,
      resetsAt: FIVE_HOUR_RESETS_AT,
    }),
  ];

  const finalized = finalizeQuotaTimeline([...rows]);
  const weekly = finalized.filter((row) => row.durationMinutes === WEEKLY_MINUTES);
  const fiveHour = finalized.filter((row) => row.durationMinutes === FIVE_HOUR_MINUTES);

  // One continuous weekly series spanning the flip: nothing dropped, strictly
  // chronological, with slot preserved as per-era display provenance.
  assert.deepEqual(
    weekly.map((row) => [row.observedAt, row.usedPercent, row.slot]),
    [
      ["2026-07-25T00:01:00.000Z", 10, "secondary"],
      ["2026-07-25T00:02:00.000Z", 11, "secondary"],
      ["2026-07-25T00:03:00.000Z", 12, "primary"],
      ["2026-07-25T00:04:00.000Z", 13, "primary"],
    ],
  );
  assert.deepEqual(
    fiveHour.map((row) => [row.observedAt, row.usedPercent]),
    [
      ["2026-07-25T00:01:00.000Z", 40],
      ["2026-07-25T00:02:00.000Z", 41],
    ],
  );
});

test("finalizeQuotaTimeline dedupes a same-instant dual-slot restatement into one deterministic point", () => {
  const rows = [
    timelineRow({ observedAt: "2026-07-25T00:05:00.000Z", slot: "secondary", usedPercent: 14 }),
    timelineRow({ observedAt: "2026-07-25T00:05:00.000Z", slot: "primary", usedPercent: 14 }),
  ];
  const forward = finalizeQuotaTimeline([...rows]);
  const reversed = finalizeQuotaTimeline([...rows].reverse());

  // One (limitId, duration) track means one point per instant, and the
  // trailing slot tie-break keeps the winner order-independent.
  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reversed);
  assert.equal(forward[0].usedPercent, 14);
  assert.equal(forward[0].slot, "primary");
});

test("orderQuotaWindows prefers the longest-duration codex window regardless of slot labels", () => {
  const fiveHourPrimary = {
    limitId: "codex", slot: "primary", durationMinutes: FIVE_HOUR_MINUTES, usedPercent: 40,
  };
  const weeklySecondary = {
    limitId: "codex", slot: "secondary", durationMinutes: WEEKLY_MINUTES, usedPercent: 10,
  };
  // Pre-flip shape: the weekly window sits in `secondary`, yet it is the
  // normal Codex allowance and must lead. Slot can never override duration.
  assert.deepEqual(
    orderQuotaWindows([fiveHourPrimary, weeklySecondary]),
    [weeklySecondary, fiveHourPrimary],
  );
  // Order of arrival must not matter for the duration rule.
  assert.deepEqual(
    orderQuotaWindows([weeklySecondary, fiveHourPrimary]),
    [weeklySecondary, fiveHourPrimary],
  );
});

test("orderQuotaWindows keeps a deterministic slot tie-break only among equal durations", () => {
  const weeklySecondary = {
    limitId: "codex", slot: "secondary", durationMinutes: WEEKLY_MINUTES, usedPercent: 10,
  };
  const weeklyPrimary = {
    limitId: "codex", slot: "primary", durationMinutes: WEEKLY_MINUTES, usedPercent: 12,
  };
  const fiveHourPrimary = {
    limitId: "codex", slot: "primary", durationMinutes: FIVE_HOUR_MINUTES, usedPercent: 40,
  };

  // Equal durations: `primary` wins the tie deterministically.
  assert.deepEqual(
    orderQuotaWindows([weeklySecondary, weeklyPrimary]),
    [weeklyPrimary, weeklySecondary],
  );
  // The scan is stable for equal duration/slot candidates: the first stays.
  const duplicateSecondary = { ...weeklySecondary, usedPercent: 11 };
  assert.equal(
    orderQuotaWindows([weeklySecondary, duplicateSecondary])[0],
    weeklySecondary,
  );
  // And the tie-break can never promote a shorter `primary` window over a
  // longer `secondary` one.
  assert.deepEqual(
    orderQuotaWindows([fiveHourPrimary, weeklySecondary, weeklyPrimary]),
    [weeklyPrimary, fiveHourPrimary, weeklySecondary],
  );
});

// Thinning must happen per track, not across the combined series: an
// index-uniform sample of a mixed weekly + five-hour series hands each track
// an uneven residue of survivors, and a consumer that filters to one track
// can lose whole days (measured: every usable window of a recent day).
test("sampleQuotaTimelineByTrack thins each track independently under the shared ceiling", () => {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  const rows = [];
  // A dense weekly track: one observation a minute for 200 hours.
  for (let index = 0; index < 12_000; index += 1) {
    rows.push(timelineRow({
      observedAt: new Date(start + index * 60_000).toISOString(),
      slot: index < 6_000 ? "secondary" : "primary",
      usedPercent: Math.min(100, index / 200),
    }));
  }
  // A sparse five-hour track: one observation an hour over the same span.
  for (let index = 0; index < 200; index += 1) {
    rows.push(timelineRow({
      observedAt: new Date(start + index * 3_600_000).toISOString(),
      slot: "primary",
      usedPercent: Math.min(100, index / 4),
      durationMinutes: FIVE_HOUR_MINUTES,
      resetsAt: FIVE_HOUR_RESETS_AT,
    }));
  }
  const sampled = sampleQuotaTimelineByTrack(rows, 1_000);
  assert.equal(sampled.length, 1_000);
  const weekly = sampled.filter((row) => row.durationMinutes === WEEKLY_MINUTES);
  const fiveHour = sampled.filter((row) => row.durationMinutes === FIVE_HOUR_MINUTES);
  // The sparse track fits inside its fair share and keeps every row; the
  // dense track absorbs the surplus.
  assert.equal(fiveHour.length, 200);
  assert.equal(weekly.length, 800);
  // Each surviving track still spans its whole era — first and last rows kept.
  assert.equal(weekly[0].observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(weekly.at(-1).observedAt, new Date(start + 11_999 * 60_000).toISOString());
  assert.equal(fiveHour[0].observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(fiveHour.at(-1).observedAt, new Date(start + 199 * 3_600_000).toISOString());
  // The merged output stays chronological.
  const instants = sampled.map((row) => Date.parse(row.observedAt));
  assert.ok(instants.every((value, index) => index === 0 || value >= instants[index - 1]));
  // Below the ceiling nothing is touched.
  assert.equal(sampleQuotaTimelineByTrack(rows, rows.length), rows);
});

test("finalizeQuotaTimeline over the ceiling keeps recent rows of every track", () => {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  const rows = [];
  for (let index = 0; index < 11_000; index += 1) {
    rows.push(timelineRow({
      observedAt: new Date(start + index * 60_000).toISOString(),
      slot: "primary",
      usedPercent: Math.min(100, index / 200),
    }));
  }
  for (let index = 0; index < 400; index += 1) {
    rows.push(timelineRow({
      observedAt: new Date(start + index * 1_800_000).toISOString(),
      slot: "primary",
      usedPercent: Math.min(100, index / 4),
      durationMinutes: FIVE_HOUR_MINUTES,
      resetsAt: FIVE_HOUR_RESETS_AT,
    }));
  }
  const finalized = finalizeQuotaTimeline(rows);
  assert.ok(finalized.length <= 10_000);
  const weekly = finalized.filter((row) => row.durationMinutes === WEEKLY_MINUTES);
  const fiveHour = finalized.filter((row) => row.durationMinutes === FIVE_HOUR_MINUTES);
  // The five-hour track fits under its fair share and survives whole; the
  // weekly track keeps its own first and last observations.
  assert.equal(fiveHour.length, 400);
  assert.equal(weekly[0].observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(weekly.at(-1).observedAt, new Date(start + 10_999 * 60_000).toISOString());
});

function minerSnapshot({ timestamp, slot, usedPercent, durationMinutes = WEEKLY_MINUTES, resetsAt = WEEKLY_RESETS_AT }) {
  return {
    timestamp,
    window: {
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot,
      windowDurationMins: durationMinutes,
      resetsAt,
      usedPercent,
    },
  };
}

test("the transition miner derives one continuous weekly series across the slot flip", () => {
  const derived = deriveCodexTransitionSeries({
    startAt: "2026-07-24T23:59:00.000Z",
    endAt: "2026-07-25T00:10:00.000Z",
    rawUsageEvents: [],
    rateLimitSnapshots: [
      minerSnapshot({ timestamp: "2026-07-25T00:01:00.000Z", slot: "secondary", usedPercent: 1 }),
      minerSnapshot({ timestamp: "2026-07-25T00:02:00.000Z", slot: "secondary", usedPercent: 2 }),
      minerSnapshot({ timestamp: "2026-07-25T00:03:00.000Z", slot: "primary", usedPercent: 3 }),
      minerSnapshot({ timestamp: "2026-07-25T00:04:00.000Z", slot: "primary", usedPercent: 4 }),
      // A separate five-hour window remains its own group by duration.
      minerSnapshot({
        timestamp: "2026-07-25T00:01:00.000Z",
        slot: "primary",
        usedPercent: 40,
        durationMinutes: FIVE_HOUR_MINUTES,
        resetsAt: FIVE_HOUR_RESETS_AT,
      }),
      minerSnapshot({
        timestamp: "2026-07-25T00:02:00.000Z",
        slot: "primary",
        usedPercent: 41,
        durationMinutes: FIVE_HOUR_MINUTES,
        resetsAt: FIVE_HOUR_RESETS_AT,
      }),
    ],
    includeSnapshotIntervals: true,
  });

  // Two groups by (limit, duration, reset) — never four by slot.
  assert.equal(derived.windowGroupCount, 2);
  const weeklyGroups = derived.groupSummaries.filter(
    (group) => group.windowDurationMins === WEEKLY_MINUTES,
  );
  assert.equal(weeklyGroups.length, 1);
  assert.equal(weeklyGroups[0].snapshotCount, 4);
  assert.equal(weeklyGroups[0].transitionCount, 3);
  assert.equal(weeklyGroups[0].monotonicTransitionCount, 3);

  // The flip-boundary transition (2% -> 3%) exists: a slot-keyed grouping
  // severed exactly this pair and with it the whole pre-flip era.
  const weeklyTransitions = derived.transitions.filter(
    (row) => row.windowDurationMins === WEEKLY_MINUTES,
  );
  assert.deepEqual(
    weeklyTransitions.map((row) => [row.priorUsedPercent, row.nextUsedPercent]),
    [[1, 2], [2, 3], [3, 4]],
  );
  const flipTransition = weeklyTransitions[1];
  assert.equal(flipTransition.slot, "secondary", "slot stays as provenance of the prior window");

  const fiveHourGroups = derived.groupSummaries.filter(
    (group) => group.windowDurationMins === FIVE_HOUR_MINUTES,
  );
  assert.equal(fiveHourGroups.length, 1);
  assert.equal(fiveHourGroups[0].snapshotCount, 2);
});

// End to end over the unified local index: rollouts report the weekly window
// under `secondary` early and `primary` later (the server-side flip), with a
// five-hour window only in the early era. The companion projection must read
// ONE continuous weekly series and a separate five-hour series by duration.
test("the unified companion projection reads one continuous weekly quota series across the flip", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-track-identity-"));
  try {
    const sessions = join(root, "sessions", "2026", "07", "25");
    await mkdir(sessions, { recursive: true });

    const record = (timestamp, rateLimits) => JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 15,
          },
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 15,
          },
        },
        rate_limits: rateLimits,
      },
    });
    const weeklyWindow = (usedPercent) => ({
      used_percent: usedPercent,
      window_minutes: WEEKLY_MINUTES,
      resets_at: WEEKLY_RESETS_AT,
    });
    const fiveHourWindow = (usedPercent) => ({
      used_percent: usedPercent,
      window_minutes: FIVE_HOUR_MINUTES,
      resets_at: FIVE_HOUR_RESETS_AT,
    });
    const lines = [
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019f978f-51a4-7ae3-0000-000000000001",
          session_id: "019f978f-51a4-7ae3-0000-000000000001",
          thread_source: "user",
          originator: "codex_cli_rs",
          cwd: "/Users/nobody/project",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.001Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/Users/nobody/project", model: "gpt-5.6-sol", effort: "high", summary: "auto" },
      }),
      // Pre-flip era: weekly in `secondary`, five-hour in `primary`.
      record("2026-07-25T00:01:00.000Z", {
        limit_id: "codex",
        plan_type: "pro",
        primary: fiveHourWindow(40),
        secondary: weeklyWindow(10),
      }),
      record("2026-07-25T00:02:00.000Z", {
        limit_id: "codex",
        plan_type: "pro",
        primary: fiveHourWindow(41),
        secondary: weeklyWindow(11),
      }),
      // Post-flip era: the weekly window now sits in `primary` and the
      // five-hour window has left telemetry.
      record("2026-07-25T00:03:00.000Z", {
        limit_id: "codex",
        plan_type: "pro",
        primary: weeklyWindow(12),
      }),
      record("2026-07-25T00:04:00.000Z", {
        limit_id: "codex",
        plan_type: "pro",
        primary: weeklyWindow(13),
      }),
    ];
    await writeFile(
      join(sessions, "rollout-2026-07-25T00-00-00-fixture.jsonl"),
      `${lines.join("\n")}\n`,
    );

    const indexFile = join(root, "index.sqlite");
    await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: "usage-event-v0.2",
    });
    const projection = await readLocalUnifiedCompanionProjection({
      indexFile,
      nowMs: Date.parse("2026-07-25T00:05:00.000Z"),
    });

    assert.equal(projection.status, "available");
    const weekly = projection.timeline.quota.filter(
      (row) => row.durationMinutes === WEEKLY_MINUTES,
    );
    const fiveHour = projection.timeline.quota.filter(
      (row) => row.durationMinutes === FIVE_HOUR_MINUTES,
    );

    // One continuous weekly track spanning the flip: all four observations,
    // strictly chronological, slot retained as per-era provenance.
    assert.deepEqual(
      weekly.map((row) => [row.observedAt, row.usedPercent, row.slot]),
      [
        ["2026-07-25T00:01:00.000Z", 10, "secondary"],
        ["2026-07-25T00:02:00.000Z", 11, "secondary"],
        ["2026-07-25T00:03:00.000Z", 12, "primary"],
        ["2026-07-25T00:04:00.000Z", 13, "primary"],
      ],
    );
    // The five-hour window remains a separate track by duration.
    assert.deepEqual(
      fiveHour.map((row) => [row.observedAt, row.usedPercent]),
      [
        ["2026-07-25T00:01:00.000Z", 40],
        ["2026-07-25T00:02:00.000Z", 41],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
