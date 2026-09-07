import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_TRAY_DEFAULTS as defaults, migrateDesktopTrayPreferences, validateDesktopTrayPreferences } from "../desktop-tray-preferences.js";
import { createDesktopSettingsStore } from "../desktop-settings-store.js";
import { DESKTOP_DEFAULT_SETTINGS, validateDesktopRequest } from "../desktop-contract.js";
import { projectDesktopTrayStatus } from "../desktop-tray-status.js";

const now = Date.parse("2026-09-07T12:00:00Z");
function status(remaining = 63, weekly = 94, overrides = {}) {
  return { status: "fresh", allowance: { source: "direct", window: "five_hour", remainingPercent: remaining }, notificationEvidence: {
    schemaVersion: "tibotattle-notification-evidence-v2", status: "fresh_provider_observation", provider: "openai_codex", source: "app_server_read", freshness: "fresh",
    observedAt: new Date(now).toISOString(), continuityKey: "a".repeat(43), windows: [
      { lane: "primary", durationMinutes: 300, usedPercent: 100 - remaining, resetAt: "2026-09-07T15:00:00.000Z", resetProofKind: "provider_reported_schedule_only" },
      { lane: "secondary", durationMinutes: 10080, usedPercent: 100 - weekly, resetAt: "2026-09-10T15:00:00.000Z", resetProofKind: "provider_reported_schedule_only" },
    ], ...overrides,
  } };
}
const project = (value, preferences = {}, extras = {}) => projectDesktopTrayStatus(value, { now, preferences: { ...defaults, ...preferences }, ...extras });

test("all presets bind their own lane and preserve real zero, 100 and missing slots", () => {
  assert.equal(project(status()).compactTitle, "7d 94%");
  assert.equal(project(status(), { preset: "five-hour" }).compactTitle, "5h 63%");
  assert.equal(project(status(0, 100), { preset: "both" }).compactTitle, "5h 0% · 7d 100%");
  assert.equal(project(status(), { preset: "icon-only" }).compactTitle, "");
  const weeklyOnly = status(); weeklyOnly.notificationEvidence.windows.shift(); weeklyOnly.allowance = null;
  assert.equal(project(weeklyOnly, { preset: "both" }).compactTitle, "5h — · 7d 94%");
  assert.equal(project(weeklyOnly, { preset: "five-hour" }).meters[0].remainingPercent, null);
  const conflict = status(); conflict.notificationEvidence.windows[1].durationMinutes = 300;
  assert.equal(project(conflict, { preset: "both" }).compactTitle, "5h — · 7d —");
});

test("each reset expires independently while a current sibling remains and refresh does not change the selection", () => {
  const value = status(); value.notificationEvidence.windows[0].resetAt = "2026-09-07T12:01:00.000Z";
  assert.equal(project(value, { preset: "both" }, { now: now + 60_000 }).compactTitle, "5h — · 7d 94%");
  value.status = "analyzing";
  assert.equal(project(value, { preset: "both" }).compactTitle, "5h 63% · 7d 94%");
  assert.equal(project(value, { preset: "both" }, { now: now + 6 * 60_000 }).compactTitle, "5h — · 7d —");
});

test("emphasis enters at 10, leaves at 12 and clears on reset, source change and unavailable", () => {
  const lowState = {}; const preferences = { preset: "five-hour", emphasizeLow: true };
  const low = (value) => project(value, preferences, { lowState }).selected[0].low;
  assert.equal(low(status(10)), true);
  assert.equal(low(status(11)), true);
  assert.equal(low(status(12)), false);
  assert.equal(low(status(10)), true);
  assert.equal(low(status(11, 94, { continuityKey: "b".repeat(43) })), false);
  low(status(10));
  const reset = status(11); reset.notificationEvidence.windows[0].resetAt = "2026-09-07T16:00:00.000Z";
  assert.equal(low(reset), false);
  low(status(10));
  assert.equal(low({ status: "unavailable", allowance: null, notificationEvidence: null }), false);
  assert.equal(low(status(11)), false);
});

test("reset formats keep the selected window and dated clock labels", () => {
  assert.equal(project(status(), { preset: "five-hour", barMetric: "remaining-reset" }).compactTitle, "5h 63% · 5h resets in 3h 0m");
  assert.match(project(status(), { barMetric: "reset", resetFormat: "clock" }, { locale: "en-US" }).compactTitle, /7d resets at .*Sep 10/);
  const unavailable = { status: "stale", allowance: null, notificationEvidence: null };
  assert.equal(project(unavailable, { preset: "five-hour", barMetric: "reset" }).compactTitle, "5h resets in —");
});

test("strict preference contract rejects unknown, duplicated, empty and contradictory selections across IPC", () => {
  for (const patch of [{ schemaVersion: 2 }, { sections: ["usage", "usage"] }, { metrics: ["tokens", "tokens"] }, { showChart: false, metrics: [] }, { preset: "both", barMetric: "reset" }, { surprise: true }]) {
    assert.throws(() => validateDesktopTrayPreferences({ ...defaults, ...patch }), TypeError);
    assert.throws(() => validateDesktopRequest({ action: "setTrayPreferences", args: { value: { ...defaults, ...patch } } }), TypeError);
  }
  assert.deepEqual(validateDesktopTrayPreferences({ ...defaults, sections: [], metrics: [], showChart: false }).sections, []);
});

test("new installs, unconfigured upgrades and all community legacy choices retain distinct defaults", async () => {
  assert.equal((await createDesktopSettingsStore().getSettings()).tray.preset, "weekly");
  const legacy = { ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "tibotattle-desktop-settings-v2" }; delete legacy.tray;
  const upgraded = createDesktopSettingsStore({ backend: { load: async () => legacy, save: async () => {} } });
  assert.equal((await upgraded.getSettings()).tray.preset, "automatic");
  for (const [raw, expected] of [["five-hour", "five-hour"], ["weekly", "weekly"], ["both", "both"], ["off", "icon-only"]]) {
    const migrated = migrateDesktopTrayPreferences(raw);
    assert.equal(migrated.preset, expected);
    assert.deepEqual(migrateDesktopTrayPreferences(migrated), migrated);
  }
  assert.equal(migrateDesktopTrayPreferences("off").iconMode, "app");
});

test("persistence is atomic, survives relaunch, and never overwrites newer or unreadable records", async () => {
  let disk = null; let fail = false; let writes = 0;
  const backend = { load: async () => disk, save: async (next) => { if (fail) throw new Error("synthetic failure"); writes++; disk = structuredClone(next); } };
  const store = createDesktopSettingsStore({ backend });
  await store.update({ tray: { ...defaults, sections: ["cache", "usage"], historyRange: "30d", metrics: ["cost"] } });
  assert.equal((await createDesktopSettingsStore({ backend }).getSettings()).tray.historyRange, "30d");
  fail = true;
  await assert.rejects(store.update({ tray: { ...defaults, preset: "both" } }), { code: "desktop_settings_persistence_failed" });
  assert.equal((await store.getSettings()).tray.historyRange, "30d");
  fail = false; disk.tray.schemaVersion = 2;
  const newer = createDesktopSettingsStore({ backend }); const before = JSON.stringify(disk); const beforeWrites = writes;
  await newer.getSettings();
  await assert.rejects(newer.update({ tray: defaults }));
  await assert.rejects(newer.setLanguage("es"));
  assert.equal(writes, beforeWrites); assert.equal(JSON.stringify(disk), before);
});

test("display-only overview supplies both lanes, reset choices and quiet low cues without notification authority", async () => {
  const { projectDesktopShellStatus } = await import("../../../src/desktop-shell-status.js");
  const { reduceDesktopTrayStatus, DESKTOP_TRAY_INITIAL_STATUS } = await import("../desktop-tray-status.js");
  const raw = { evidenceStatus: "available", freshness: { status: "live", staleAfterSeconds: 1800 }, windows: [
    { slot: "primary", durationMinutes: 300, usedPercent: 90, remainingPercent: 10, observedAt: new Date(now).toISOString(), resetAt: "2026-09-07T12:01:00.000Z" },
    { slot: "secondary", durationMinutes: 10080, usedPercent: 6, remainingPercent: 94, observedAt: new Date(now).toISOString(), resetAt: "2026-09-10T12:00:00.000Z" },
  ] };
  const shell = projectDesktopShellStatus({ refresh: { status: "idle" }, displayEvidence: raw, now });
  assert.equal(shell.notificationEvidence, null);
  const tray = reduceDesktopTrayStatus(DESKTOP_TRAY_INITIAL_STATUS, { type: shell.state, allowance: shell.allowance, notificationEvidence: shell.notificationEvidence, displayEvidence: shell.displayEvidence });
  assert.equal(project(tray, { preset: "both" }).compactTitle, "5h 10% · 7d 94%");
  assert.equal(project(tray, { preset: "five-hour", barMetric: "reset" }).compactTitle, "5h resets in 1m");
  const lowState = {};
  assert.equal(project(tray, { preset: "five-hour", emphasizeLow: true }, { lowState }).selected[0].low, true);
  const same = structuredClone(tray); same.displayEvidence.windows[0].remainingPercent = 11;
  assert.equal(project(same, { preset: "five-hour", emphasizeLow: true }, { lowState }).selected[0].low, true);
  same.displayEvidence.windows[0].observedAt = new Date(now + 1_000).toISOString();
  assert.equal(project(same, { preset: "five-hour", emphasizeLow: true }, { lowState, now: now + 1_000 }).selected[0].low, false, "unscoped observations cannot assume account continuity");
  assert.equal(project(tray, { preset: "both" }, { now: now + 60_000 }).compactTitle, "5h — · 7d 94%");
  const retained = reduceDesktopTrayStatus(tray, { type: "analyzing" });
  assert.equal(project(retained, { preset: "both" }).compactTitle, "5h 10% · 7d 94%");
  assert.equal(project(retained, { preset: "both" }, { now: now + 1801_000 }).compactTitle, "5h — · 7d —");
});
