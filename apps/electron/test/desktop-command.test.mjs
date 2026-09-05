import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_COMMAND_CHANNEL,
  createDesktopCommand,
  validateDesktopCommand,
} from "../desktop-command.js";

test("desktop commands contain only the fixed presentation vocabulary", () => {
  assert.equal(DESKTOP_COMMAND_CHANNEL, "tibotattle:desktop-command:v1");
  assert.deepEqual(createDesktopCommand("refresh"), { command: "refresh" });
  assert.deepEqual(createDesktopCommand("automaticRefresh", "quick"), {
    command: "automaticRefresh",
    mode: "quick",
  });
  assert.deepEqual(createDesktopCommand("automaticRefresh", "detailed"), {
    command: "automaticRefresh",
    mode: "detailed",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "weekly"), {
    command: "dashboardSection",
    section: "weekly",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "timeline"), {
    command: "dashboardSection",
    section: "timeline",
  });
  assert.deepEqual(createDesktopCommand("language", "zh-Hans"), {
    command: "language",
    value: "zh-Hans",
  });
  assert.deepEqual(createDesktopCommand("sidebar", true), {
    command: "sidebar",
    collapsed: true,
  });
  assert.equal(Object.isFrozen(createDesktopCommand("sidebar", false)), true);
  assert.deepEqual(createDesktopCommand("appearance", "dark", "dark"), {
    command: "appearance",
    preference: "dark",
    resolvedTheme: "dark",
  });
  assert.deepEqual(createDesktopCommand("hostedSignInReturn"), {
    command: "hostedSignInReturn",
  });
  assert.deepEqual(createDesktopCommand("shareCardDownloadCompleted"), {
    command: "shareCardDownloadCompleted",
  });
  assert.deepEqual(createDesktopCommand("shareCardDownloadFailed"), {
    command: "shareCardDownloadFailed",
  });
  assert.equal(Object.isFrozen(createDesktopCommand("refresh")), true);
});

test("desktop commands reject selectors, paths, URLs, extra keys, and prototypes", () => {
  for (const value of [
    null,
    { command: "refresh", selector: "#refresh-button" },
    { command: "automaticRefresh", mode: "quick", reason: "unexpected" },
    { command: "automaticRefresh", mode: "background" },
    { command: "dashboardSection", section: "accounting" },
    { command: "dashboardSection", section: "#weekly" },
    { command: "dashboardSection", section: "weekly", path: "/private/secret" },
    { command: "navigate", value: "https://attacker.example" },
    { command: "language", value: "fr" },
    { command: "language", value: "en", path: "/tmp/private" },
    { command: "sidebar", collapsed: true, path: "/tmp/private" },
    { command: "sidebar", collapsed: "true" },
    { command: "appearance", preference: "dark", resolvedTheme: "sepia" },
    { command: "appearance", preference: "sepia", resolvedTheme: "dark" },
    { command: "hostedSignInReturn", value: "unexpected" },
    { command: "shareCardDownloadCompleted", path: "/private/download.png" },
    { command: "shareCardDownloadFailed", error: "private details" },
    Object.assign(Object.create(null), { command: "refresh" }),
  ]) {
    assert.throws(() => validateDesktopCommand(value), TypeError);
  }
  assert.throws(
    () => createDesktopCommand("shareCardDownloadCompleted", "/private/download.png"),
    TypeError,
  );
  assert.throws(
    () => createDesktopCommand("shareCardDownloadFailed", { path: "/private/download.png" }),
    TypeError,
  );
  assert.throws(() => createDesktopCommand("dashboardSection", "accounting"), TypeError);
  assert.throws(() => createDesktopCommand("dashboardSection"), TypeError);
  assert.throws(() => createDesktopCommand("automaticRefresh"), TypeError);
  assert.throws(() => createDesktopCommand("automaticRefresh", "background"), TypeError);
  assert.throws(
    () => createDesktopCommand("automaticRefresh", "quick", "unexpected"),
    TypeError,
  );
  assert.throws(() => createDesktopCommand("sidebar"), TypeError);
  assert.throws(() => createDesktopCommand("appearance", "dark"), TypeError);
});
