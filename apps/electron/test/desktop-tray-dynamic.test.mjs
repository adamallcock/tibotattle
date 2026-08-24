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
        trayStatus: { status, allowance: null },
      });
      assert.equal(template[1].label, expected);
      assert.equal(template[1].enabled, false);
      assert.equal(template.filter((entry) => entry.enabled === false).length, 1);
      assert.equal(template.some((entry) => entry.label?.includes("allowance")
        || entry.label?.includes("配额")
        || entry.label?.includes("Cuota")), false);
    }
  }
});
test("fresh direct evidence adds one disabled, rounded allowance row", () => {
  const fiveHour = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    locale: "en-US",
    trayStatus: {
      status: "fresh",
      allowance: { source: "direct", window: "five_hour", remainingPercent: 73.6 },
    },
  });
  assert.equal(fiveHour[1].label, "Fresh");
  assert.equal(fiveHour[1].enabled, false);
  assert.equal(fiveHour[2].label, "Five-hour allowance: 74% remaining");
  assert.equal(fiveHour[2].enabled, false);
  assert.deepEqual(fiveHour.slice(3).map((entry) => entry.type === "separator" ? entry.type : entry.label), [
    "separator",
    "Refresh Usage",
    "Retry",
    "separator",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit",
  ]);

  const sevenDay = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    locale: "zh-Hans",
    trayStatus: {
      status: "fresh",
      allowance: { source: "direct", window: "seven_day", remainingPercent: 12.4 },
    },
  });
  assert.equal(sevenDay[2].label, "七天配额：剩余 12%");
});

test("allowance evidence never leaks into non-fresh tray states", () => {
  for (const status of ["starting", "analyzing", "stale", "unavailable"]) {
    assert.throws(
      () => createDesktopTrayTemplate({
        trayStatus: {
          status,
          allowance: { source: "direct", window: "five_hour", remainingPercent: 80 },
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
    { status: "fresh", allowance: null, path: "/private/secret" },
    { status: "fresh", allowance: null, error: "raw" },
    { status: "unknown", allowance: null },
    { status: "fresh", allowance: {
      source: "direct",
      window: "five_hour",
      remainingPercent: 73,
      identity: "account",
    } },
  ]) {
    assert.throws(
      () => createDesktopTrayTemplate({ trayStatus }),
      TypeError,
    );
  }
  assert.throws(
    () => createDesktopTrayTemplate({
      trayStatus: { status: "fresh", allowance: null },
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
    "Open TiboTattle Dev",
    STATUS_PLACEHOLDER,
    "separator",
    "Refresh Usage",
    "Retry",
    "separator",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit",
  ]);
  for (const [label, action] of [
    ["Open TiboTattle Dev", "show"],
    ["Refresh Usage", "refresh"],
    ["Retry", "retry"],
    ["Settings…", "settings"],
    ["About TiboTattle Dev", "about"],
    ["Quit", "quit"],
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
