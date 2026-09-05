import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  projectDesktopShellStatus,
  validateDesktopShellStatus,
} from "../src/desktop-shell-status.js";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function displayEvidence(overrides = {}) {
  const base = {
    evidenceStatus: "available",
    freshness: {
      status: "live",
      staleAfterSeconds: 30 * 60,
    },
    windows: [
      {
        durationMinutes: 300,
        slot: "secondary",
        usedPercent: 58,
        remainingPercent: 42,
        observedAt: "2026-09-05T11:59:00.000Z",
        resetAt: "2026-09-05T12:30:00.000Z",
      },
      {
        durationMinutes: 10_080,
        slot: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        observedAt: "2026-09-05T11:59:00.000Z",
        resetAt: "2026-09-05T15:00:00.000Z",
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    freshness: { ...base.freshness, ...overrides.freshness },
    windows: overrides.windows ?? base.windows,
  };
}

function expected(state, allowance = null, notificationEvidence = null) {
  return {
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state,
    allowance,
    notificationEvidence,
  };
}

test("published overview display evidence supplies a zero-percent native-primary allowance without notification authority", () => {
  const evidence = displayEvidence();
  const directAllowance = {
    source: "direct",
    window: "seven_day",
    remainingPercent: 0,
  };

  const idle = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "idle" },
    displayEvidence: evidence,
    now: NOW,
  });
  assert.deepEqual(idle, expected("fresh", directAllowance));
  assert.deepEqual(validateDesktopShellStatus(idle), idle);

  const analyzing = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "running", result: null },
    displayEvidence: evidence,
    now: NOW,
  });
  assert.deepEqual(analyzing, expected("analyzing", directAllowance));
  assert.deepEqual(validateDesktopShellStatus(analyzing), analyzing);
  assert.equal(JSON.stringify(analyzing).includes("continuity"), false);
  assert.equal(JSON.stringify(analyzing).includes("openai_codex"), false);
});

test("desktop shell display proof follows live current reset and primary-lane bounds", () => {
  const scenarios = [
    ["stale", displayEvidence({ freshness: { status: "stale" } })],
    ["demo", displayEvidence({ freshness: { status: "demo" } })],
    ["offline", displayEvidence({ freshness: { status: "offline" } })],
    ["expired", displayEvidence({
      windows: [{
        ...displayEvidence().windows[0],
        resetAt: "2026-09-05T12:00:00.000Z",
      }],
    })],
    ["old", displayEvidence({
      windows: [{
        ...displayEvidence().windows[0],
        observedAt: "2026-09-05T11:20:00.000Z",
        resetAt: "2026-09-05T12:20:00.000Z",
      }],
    })],
    ["malformed", displayEvidence({
      windows: [{
        ...displayEvidence().windows[0],
        remainingPercent: 43,
      }],
    })],
  ];

  for (const [name, evidence] of scenarios) {
    const status = projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: { status: "succeeded", result: {} },
      displayEvidence: evidence,
      now: NOW,
    });
    assert.deepEqual(status, expected("stale"), name);
  }

  // A secondary normal-Codex lane remains the native fallback when no primary
  // slot exists; a slot is display precedence, not a separate provider pool.
  const secondaryFallback = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: {} },
    displayEvidence: displayEvidence({ windows: [displayEvidence().windows[0]] }),
    now: NOW,
  });
  assert.deepEqual(secondaryFallback, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 42,
  }));

  const expiredWeeklyFallback = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: {} },
    displayEvidence: displayEvidence({ windows: [
      displayEvidence().windows[0],
      { ...displayEvidence().windows[1], resetAt: "2026-09-05T12:00:00.000Z" },
    ] }),
    now: NOW,
  });
  assert.deepEqual(expiredWeeklyFallback, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 42,
  }));
});

test("strict v2 notification evidence remains the only notification-bearing path", () => {
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-09-05T12:00:00.000Z",
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 26,
      durationMinutes: 300,
      resetAt: "2026-09-05T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
  const status = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: { notificationEvidence } },
    displayEvidence: displayEvidence({ freshness: { status: "offline" } }),
    now: NOW,
  });
  assert.deepEqual(status, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 74,
  }, notificationEvidence));
  assert.throws(
    () => validateDesktopShellStatus(expected("fresh")),
    /desktop shell status is invalid/u,
  );
});
