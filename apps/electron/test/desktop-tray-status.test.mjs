import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopTrayStatusReducer,
  DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS,
  DESKTOP_TRAY_ALLOWANCE_WINDOWS,
  DESKTOP_TRAY_INITIAL_STATUS,
  DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS,
  DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES,
  DESKTOP_TRAY_STATUS_STATES,
  projectDesktopTrayStatus,
  reduceDesktopTrayStatus,
  validateDesktopTrayAllowance,
  validateDesktopTrayStatus,
} from "../desktop-tray-status.js";

const freshWithoutAllowance = Object.freeze({
  status: "fresh",
  allowance: null,
  notificationEvidence: null,
});
const directAllowance = Object.freeze({
  source: "direct",
  window: "five_hour",
  remainingPercent: 73.4,
});

test("tray status exposes only the fixed states and bounded allowance windows", () => {
  assert.deepEqual(DESKTOP_TRAY_STATUS_STATES, [
    "starting",
    "analyzing",
    "fresh",
    "stale",
    "unavailable",
  ]);
  assert.deepEqual(DESKTOP_TRAY_ALLOWANCE_WINDOWS, ["five_hour", "seven_day"]);
  assert.equal(Object.isFrozen(DESKTOP_TRAY_STATUS_STATES), true);
  assert.equal(Object.isFrozen(DESKTOP_TRAY_ALLOWANCE_WINDOWS), true);
  assert.equal(Object.isFrozen(DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS), true);
  assert.equal(Object.isFrozen(DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS), true);
  assert.ok(DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES > 0);
  assert.deepEqual(DESKTOP_TRAY_INITIAL_STATUS, {
    status: "starting",
    allowance: null,
    notificationEvidence: null,
  });
  assert.equal(Object.isFrozen(DESKTOP_TRAY_INITIAL_STATUS), true);
});

test("reducer transitions clear evidence until fresh direct evidence returns", () => {
  let state = DESKTOP_TRAY_INITIAL_STATUS;
  state = reduceDesktopTrayStatus(state, { type: "analyzing" });
  assert.deepEqual(state, { status: "analyzing", allowance: null, notificationEvidence: null });
  state = reduceDesktopTrayStatus(state, {
    type: "fresh",
    allowance: directAllowance,
    notificationEvidence: null,
  });
  assert.deepEqual(state, {
    status: "fresh",
    allowance: directAllowance,
    notificationEvidence: null,
  });
  state = reduceDesktopTrayStatus(state, { type: "stale" });
  assert.deepEqual(state, { status: "stale", allowance: null, notificationEvidence: null });
  state = reduceDesktopTrayStatus(state, { type: "analyzing" });
  assert.deepEqual(state, { status: "analyzing", allowance: null, notificationEvidence: null });
  state = reduceDesktopTrayStatus(state, { type: "unavailable" });
  assert.deepEqual(state, { status: "unavailable", allowance: null, notificationEvidence: null });
  state = reduceDesktopTrayStatus(state, { type: "starting" });
  assert.deepEqual(state, { status: "starting", allowance: null, notificationEvidence: null });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.allowance), true);
});

test("analyzing retains a prior live observation but the projector expires it", () => {
  const observedAt = "2026-08-22T12:00:00.000Z";
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 26.6,
      durationMinutes: 300,
      resetAt: "2026-08-22T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
  const fresh = reduceDesktopTrayStatus(
    DESKTOP_TRAY_INITIAL_STATUS,
    {
      type: "fresh",
      allowance: { source: "direct", window: "five_hour", remainingPercent: 73.4 },
      notificationEvidence,
    },
  );
  const analyzing = reduceDesktopTrayStatus(fresh, { type: "analyzing" });
  assert.deepEqual(analyzing, {
    status: "analyzing",
    allowance: { source: "direct", window: "five_hour", remainingPercent: 73.4 },
    notificationEvidence,
  });
  const liveProjection = projectDesktopTrayStatus(analyzing, {
    now: Date.parse("2026-08-22T12:04:00.000Z"),
  });
  assert.equal(liveProjection.status, "analyzing");
  assert.equal(liveProjection.compactTitle, "73%");
  assert.equal(liveProjection.allowance.remainingPercent, 73);
  assert.equal(liveProjection.evidenceLabel, "Observed 4 minutes ago · verified current evidence");

  const expiredProjection = projectDesktopTrayStatus(analyzing, {
    now: Date.parse("2026-08-22T17:01:00.000Z"),
  });
  assert.equal(expiredProjection.status, "analyzing");
  assert.equal(expiredProjection.compactTitle, "…");
  assert.equal(expiredProjection.allowance, null);
  assert.equal(expiredProjection.windows.length, 0);
  assert.equal(expiredProjection.evidenceLabel, "Analyzing");
});

test("fresh status may be current without a primary allowance summary", () => {
  const state = reduceDesktopTrayStatus(
    DESKTOP_TRAY_INITIAL_STATUS,
    { type: "fresh", allowance: null, notificationEvidence: null },
  );
  assert.deepEqual(state, freshWithoutAllowance);
  assert.deepEqual(validateDesktopTrayStatus(state), freshWithoutAllowance);
});

test("only fresh direct finite percentages can carry a bounded summary", () => {
  const validated = validateDesktopTrayAllowance(directAllowance);
  assert.deepEqual(validated, directAllowance);
  assert.equal(Object.isFrozen(validated), true);
  for (const value of [
    { source: "inferred", window: "five_hour", remainingPercent: 73 },
    { source: "direct", window: "stale", remainingPercent: 73 },
    { source: "direct", window: "five_hour", remainingPercent: NaN },
    { source: "direct", window: "five_hour", remainingPercent: Infinity },
    { source: "direct", window: "five_hour", remainingPercent: -Infinity },
    { source: "direct", window: "five_hour", remainingPercent: -0.1 },
    { source: "direct", window: "five_hour", remainingPercent: 100.1 },
    { source: "direct", window: "five_hour", remainingPercent: "73" },
    { source: "direct", window: "five_hour", remainingPercent: true },
    { source: "direct", window: "five_hour", remainingPercent: null },
    { source: "direct", window: "five_hour", remainingPercent: 73, path: "/private" },
    { source: "direct", window: "five_hour", remainingPercent: 73, identifier: "acct" },
    { source: "direct", window: "five_hour", remainingPercent: 73, label: "custom" },
    { source: "direct", window: "five_hour", remainingPercent: 73, rawError: "secret" },
    { source: "direct", window: "five_hour" },
    { source: "direct", remainingPercent: 73 },
    null,
    undefined,
    "allowance",
    [],
  ]) {
    assert.throws(() => validateDesktopTrayAllowance(value), TypeError);
  }
});

test("stale and unavailable events reject summaries, paths, identifiers, and errors", () => {
  for (const event of [
    { type: "stale", allowance: directAllowance },
    { type: "unavailable", allowance: directAllowance },
    { type: "analyzing", rawError: "ENOENT /Users/private" },
    { type: "starting", path: "/Users/private" },
    { type: "unavailable", identifier: "account-123" },
  ]) {
    assert.throws(
      () => reduceDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, event),
      TypeError,
    );
  }
  const stale = reduceDesktopTrayStatus(
    { status: "fresh", allowance: directAllowance, notificationEvidence: null },
    { type: "stale" },
  );
  assert.deepEqual(stale, { status: "stale", allowance: null, notificationEvidence: null });
});

test("state and event contracts reject arbitrary or extra fields", () => {
  for (const value of [
    null,
    [],
    { status: "fresh" },
    { status: "fresh", allowance: null, notificationEvidence: null, path: "/tmp" },
    { status: "fresh", allowance: directAllowance, notificationEvidence: null, error: "raw" },
    { status: "stale", allowance: directAllowance, notificationEvidence: null },
    { status: "unknown", allowance: null, notificationEvidence: null },
    Object.assign(Object.create(null), { status: "starting", allowance: null, notificationEvidence: null }),
  ]) {
    assert.throws(() => validateDesktopTrayStatus(value), TypeError);
  }
  for (const event of [
    null,
    [],
    { type: "unknown" },
    { type: "fresh" },
    { type: "fresh", allowance: null, notificationEvidence: null, extra: true },
    { type: "fresh", allowance: { source: "direct", window: "five_hour", remainingPercent: 1, path: "/tmp" }, notificationEvidence: null },
    { type: "stale", note: "arbitrary" },
  ]) {
    assert.throws(
      () => reduceDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, event),
      TypeError,
    );
  }
});

test("projector supplies a localization seam without exposing raw input fields", () => {
  const calls = [];
  const projected = projectDesktopTrayStatus(
    { status: "fresh", allowance: directAllowance, notificationEvidence: null },
    {
      localize(key, values) {
        calls.push({ key, values });
        if (key === DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS.fresh) return "FRESH";
        if (key === DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS.five_hour) {
          return `5H ${values.remainingPercent}%`;
        }
        throw new Error("unexpected key");
      },
    },
  );
  assert.deepEqual(projected, {
    status: "fresh",
    label: "FRESH",
    allowance: {
      window: "five_hour",
      remainingPercent: 73,
      label: "5H 73%",
    },
    compactTitle: "73%",
    evidenceLabel: "FRESH",
    windows: [],
  });
  assert.deepEqual(calls, [
    {
      key: DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS.fresh,
      values: {},
    },
    {
      key: DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS.five_hour,
      values: { remainingPercent: 73 },
    },
  ]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.allowance), true);
  assert.deepEqual(
    projectDesktopTrayStatus({ status: "stale", allowance: null, notificationEvidence: null }),
    { status: "stale", label: "Stale", allowance: null, compactTitle: "–", evidenceLabel: "Stale", windows: [] },
  );
});

test("compact title never promotes a secondary-only lane", () => {
  const projected = projectDesktopTrayStatus({
    status: "fresh",
    allowance: null,
    notificationEvidence: {
      schemaVersion: "tibotattle-notification-evidence-v2",
      status: "fresh_provider_observation",
      provider: "openai_codex",
      source: "app_server_read",
      freshness: "fresh",
      observedAt: "2026-08-22T12:00:00.000Z",
      continuityKey: "a".repeat(43),
      windows: [{
        lane: "secondary",
        usedPercent: 26,
        durationMinutes: 300,
        resetAt: "2026-08-22T15:00:00.000Z",
        resetProofKind: "provider_reported_schedule_only",
      }],
    },
  });
  assert.equal(projected.compactTitle, "–");
  assert.equal(projected.allowance, null);
});

test("localization output is bounded and cannot smuggle control text", () => {
  const invalidLocalizers = [
    () => "",
    () => "x".repeat(DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES + 1),
    () => "line\nfeed",
    () => 42,
    () => null,
    () => { throw new Error("raw failure"); },
  ];
  for (const localize of invalidLocalizers) {
    assert.throws(
      () => projectDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, { localize }),
      TypeError,
    );
  }
  assert.throws(
    () => projectDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, { localize: null }),
    TypeError,
  );
  assert.throws(
    () => projectDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, { locale: "../../secret" }),
    TypeError,
  );
});

test("stateful reducer serializes transitions and can reset to starting", () => {
  const reducer = createDesktopTrayStatusReducer();
  assert.deepEqual(reducer.state, DESKTOP_TRAY_INITIAL_STATUS);
  reducer.dispatch({ type: "analyzing" });
  reducer.dispatch({ type: "fresh", allowance: directAllowance, notificationEvidence: null });
  assert.equal(reducer.state.status, "fresh");
  assert.equal(reducer.project().allowance.remainingPercent, 73);
  assert.deepEqual(reducer.reset(), DESKTOP_TRAY_INITIAL_STATUS);
  assert.equal(reducer.state.status, "starting");
});
