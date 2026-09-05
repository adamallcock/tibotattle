import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_ACTION_NAMES } from "../desktop-menu.js";
import {
  createDesktopTrayTemplate,
  STATUS_PLACEHOLDER,
} from "../desktop-tray.js";

function actionRecorder() {
  const calls = [];
  const actions = Object.fromEntries(
    DESKTOP_ACTION_NAMES.map((name) => [name, () => calls.push(name)]),
  );
  return { actions, calls };
}

function menuLabels(template) {
  return template.map((entry) => entry.type === "separator" ? entry.type : entry.label);
}

function labeled(template, label) {
  const match = template.find((entry) => entry.label === label);
  assert.ok(match, `missing tray item: ${label}`);
  return match;
}

const states = [
  ["starting", "Starting", "正在启动", "Iniciando"],
  ["analyzing", "Analyzing", "正在分析", "Analizando"],
  ["fresh", "Fresh", "最新", "Actualizado"],
  ["stale", "Stale", "已过期", "Desactualizado"],
  ["unavailable", "Status unavailable", "状态不可用", "Estado no disponible"],
];

const actionStates = {
  "en-US": {
    starting: ["Starting", false],
    analyzing: ["Analyzing", false],
    fresh: ["Update Local Usage", true],
    stale: ["Update Local Usage", true],
    unavailable: ["Retry", true],
  },
  "zh-Hans": {
    starting: ["正在启动", false],
    analyzing: ["正在分析", false],
    fresh: ["更新本地使用情况", true],
    stale: ["更新本地使用情况", true],
    unavailable: ["重试", true],
  },
  es: {
    starting: ["Iniciando", false],
    analyzing: ["Analizando", false],
    fresh: ["Actualizar uso local", true],
    stale: ["Actualizar uso local", true],
    unavailable: ["Reintentar", true],
  },
};

test("semantic tray states project fixed status copy in every supported locale", () => {
  for (const [status, ...labels] of states) {
    for (const [locale, expected] of [
      ["en-US", labels[0]],
      ["zh-Hans", labels[1]],
      ["es", labels[2]],
    ]) {
      const template = createDesktopTrayTemplate({
        appName: "TiboTattle Dev",
        locale,
        trayStatus: { status, allowance: null, notificationEvidence: null },
      });
      const compact = status === "analyzing" ? "…" : "–";
      const expectedTitle = locale === "en-US"
        ? `TiboTattle Dev · ${compact} allowance`
        : locale === "zh-Hans"
          ? `TiboTattle Dev · 剩余 ${compact}`
          : `TiboTattle Dev · ${compact} disponible`;
      assert.equal(template[0].label, expectedTitle);
      assert.equal(template[1].label, expected);
      assert.equal(template[1].enabled, false);
      const action = template[7];
      const [actionLabel, actionEnabled] = actionStates[locale][status];
      assert.equal(action.label, actionLabel);
      assert.equal(action.enabled ?? true, actionEnabled);
      const checkForUpdates = template.find((entry) => entry.label === "Check for Updates…"
        || entry.label === "检查更新…"
        || entry.label === "Buscar actualizaciones…");
      assert.ok(checkForUpdates);
      assert.equal(checkForUpdates.enabled, false);
      const separatorIndex = template.findIndex((entry) => entry.type === "separator");
      assert.equal(template.slice(1, separatorIndex).some((entry) => (
        entry.label?.includes("allowance")
        || entry.label?.includes("配额")
        || entry.label?.includes("Cuota")
      )), false);
    }
  }
});

test("tray refresh control follows companion lifecycle and avoids overlap", () => {
  const calls = [];
  const actions = {
    refresh: () => calls.push("refresh"),
    retry: () => calls.push("retry"),
  };
  for (const [status, expectedLabel, expectedEnabled, expectedCall] of [
    ["starting", "Starting", false, null],
    ["analyzing", "Analyzing", false, null],
    ["fresh", "Update Local Usage", true, "refresh"],
    ["stale", "Update Local Usage", true, "refresh"],
    ["unavailable", "Retry", true, "retry"],
  ]) {
    const template = createDesktopTrayTemplate({
      actions,
      trayStatus: { status, allowance: null, notificationEvidence: null },
    });
    const control = template[7];
    assert.equal(control.label, expectedLabel);
    assert.equal(control.enabled ?? true, expectedEnabled);
    if (expectedCall === null) {
      assert.equal(control.click, undefined);
    } else {
      control.click();
      assert.equal(calls.at(-1), expectedCall);
    }
  }
  assert.deepEqual(calls, ["refresh", "refresh", "retry"]);
});

test("fresh direct evidence projects compact title, evidence age, and quota lanes", () => {
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-08-22T12:00:00.000Z",
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 26.4,
      durationMinutes: 300,
      resetAt: "2026-08-22T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
  const fiveHour = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    locale: "en-US",
    trayStatus: {
      status: "fresh",
      allowance: { source: "direct", window: "five_hour", remainingPercent: 73.6 },
      notificationEvidence,
    },
    now: Date.parse("2026-08-22T12:04:00.000Z"),
  });
  assert.equal(fiveHour[0].label, "TiboTattle Dev · 74% allowance");
  assert.equal(fiveHour[1].label, "Observed 4 minutes ago · verified current evidence");
  assert.equal(fiveHour[2].label, "Five-hour allowance: 74% remaining · resets in 2h 56m");
  assert.equal(fiveHour[2].enabled, false);
  assert.deepEqual(fiveHour.slice(3).map((entry) => entry.type === "separator" ? entry.type : entry.label), [
    "separator",
    "Open TiboTattle Dev",
    "Weekly Allowance",
    "Usage Timeline",
    "Usage and Costs",
    "Update Local Usage",
    "Check for Updates…",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit TiboTattle Dev",
  ]);

  const sevenDay = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    locale: "zh-Hans",
    trayStatus: {
      status: "fresh",
      allowance: { source: "direct", window: "seven_day", remainingPercent: 12.4 },
      notificationEvidence: {
        ...notificationEvidence,
        windows: [{ ...notificationEvidence.windows[0], durationMinutes: 10_080, usedPercent: 87.6, resetAt: "2026-08-25T12:00:00.000Z" }],
      },
    },
    now: Date.parse("2026-08-22T12:00:00.000Z"),
  });
  assert.equal(sevenDay[0].label, "TiboTattle Dev · 剩余 12%");
  assert.equal(sevenDay[2].label, "七天配额：已过 57% · 已用 88% · 3d 0h 后重置");
});

test("analyzing tray keeps a live percentage and labels the second line as analyzing", () => {
  const template = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    platform: "darwin",
    now: Date.parse("2026-08-22T12:04:00.000Z"),
    trayStatus: {
      status: "analyzing",
      allowance: { source: "direct", window: "five_hour", remainingPercent: 73.6 },
      notificationEvidence: {
        schemaVersion: "tibotattle-notification-evidence-v2",
        status: "fresh_provider_observation",
        provider: "openai_codex",
        source: "app_server_read",
        freshness: "fresh",
        observedAt: "2026-08-22T12:00:00.000Z",
        continuityKey: "a".repeat(43),
        windows: [{
          lane: "primary",
          usedPercent: 26.4,
          durationMinutes: 300,
          resetAt: "2026-08-22T15:00:00.000Z",
          resetProofKind: "provider_reported_schedule_only",
        }],
      },
    },
  });
  assert.equal(template[0].label, "TiboTattle Dev · 74% allowance");
  assert.equal(template[0].sublabel, "Analyzing");
  assert.equal(template[1].visible, false);
});

test("allowance evidence never leaks into non-refreshing non-fresh tray states", () => {
  for (const status of ["starting", "stale", "unavailable"]) {
    assert.throws(
      () => createDesktopTrayTemplate({
        trayStatus: {
          status,
          allowance: { source: "direct", window: "five_hour", remainingPercent: 80 },
          notificationEvidence: null,
        },
      }),
      TypeError,
    );
  }
});

test("tray status rejects arbitrary fields and renderer-shaped labels", () => {
  for (const trayStatus of [
    null,
    { status: "fresh" },
    { status: "fresh", allowance: null, notificationEvidence: null, path: "/private/secret" },
    { status: "fresh", allowance: null, notificationEvidence: null, error: "raw" },
    { status: "unknown", allowance: null, notificationEvidence: null },
    { status: "fresh", allowance: {
      source: "direct",
      window: "five_hour",
      remainingPercent: 73,
      identity: "account",
    }, notificationEvidence: null },
  ]) {
    assert.throws(
      () => createDesktopTrayTemplate({ trayStatus }),
      TypeError,
    );
  }
  assert.throws(
    () => createDesktopTrayTemplate({
      trayStatus: { status: "fresh", allowance: null, notificationEvidence: null },
      statusLabel: "arbitrary renderer label",
    }),
    TypeError,
  );
});

test("default and legacy label callers remain bounded and preserve action identity", () => {
  const { actions, calls } = actionRecorder();
  const defaultTemplate = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    actions,
  });
  assert.equal(defaultTemplate[1].label, STATUS_PLACEHOLDER);
  assert.deepEqual(menuLabels(defaultTemplate), [
    "TiboTattle Dev · – allowance",
    STATUS_PLACEHOLDER,
    "separator",
    "Open TiboTattle Dev",
    "Weekly Allowance",
    "Usage Timeline",
    "Usage and Costs",
    "Retry",
    "Check for Updates…",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit TiboTattle Dev",
  ]);
  for (const [label, action] of [
    ["Open TiboTattle Dev", "show"],
    ["Weekly Allowance", "weekly"],
    ["Usage Timeline", "timeline"],
    ["Usage and Costs", "accounting"],
    ["Retry", "retry"],
    ["Settings…", "settings"],
    ["About TiboTattle Dev", "about"],
    ["Quit TiboTattle Dev", "quit"],
  ]) {
    labeled(defaultTemplate, label).click();
    assert.equal(calls.at(-1), action);
  }

  const legacy = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    statusLabel: "Status unavailable",
  });
  assert.equal(legacy[1].label, STATUS_PLACEHOLDER);
  assert.throws(() => createDesktopTrayTemplate({ statusLabel: "" }), TypeError);
  assert.throws(() => createDesktopTrayTemplate({ statusLabel: 42 }), TypeError);
});
