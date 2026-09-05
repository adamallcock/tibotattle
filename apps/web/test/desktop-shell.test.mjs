import assert from "node:assert/strict";
import test from "node:test";

import {
  mountDesktopShell,
  navigateToDashboardSection,
} from "../public/desktop-shell.js";

function fakeButton() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

function fakeWindow() {
  const commandListeners = [];
  const events = [];
  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const windowRef = {
    tibotattleDesktop: {
      version: "v1",
      onCommand(listener) {
        commandListeners.push(listener);
        return () => {
          const index = commandListeners.indexOf(listener);
          if (index >= 0) commandListeners.splice(index, 1);
        };
      },
      getSettings: async () => ({}),
    },
    location: { hash: "#overview" },
    CustomEvent: FakeCustomEvent,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  return { commandListeners, events, windowRef };
}

function fakeDocument(settingsButton = fakeButton()) {
  const classList = { contains: (value) => value === "electron-dashboard" };
  return {
    documentElement: { classList },
    querySelector(selector) {
      if (selector === "#electron-settings-button") return settingsButton;
      if (selector === "#electron-share-button") return null;
      if (selector === "[data-language-picker]") return null;
      return null;
    },
  };
}

test("native navigation accepts only the fixed dashboard destinations", () => {
  const { windowRef } = fakeWindow();
  assert.equal(navigateToDashboardSection({}, windowRef, "weekly"), true);
  assert.equal(windowRef.location.hash, "#weekly");
  assert.equal(navigateToDashboardSection({}, windowRef, "timeline"), true);
  assert.equal(windowRef.location.hash, "#timeline");
  assert.equal(navigateToDashboardSection({}, windowRef, "accounting"), true);
  assert.equal(windowRef.location.hash, "#accounting");
  assert.equal(navigateToDashboardSection({}, windowRef, "#weekly"), false);
  assert.equal(navigateToDashboardSection({}, {}, "weekly"), false);
});

test("desktop command bridge navigates the dashboard through the fixed section map", async () => {
  const { commandListeners, windowRef } = fakeWindow();
  const documentRef = fakeDocument();
  const mounted = mountDesktopShell({ documentRef, windowRef });
  assert.equal(commandListeners.length, 1);

  commandListeners[0]({ command: "dashboardSection", section: "weekly" });
  assert.equal(windowRef.location.hash, "#weekly");
  commandListeners[0]({ command: "dashboardSection", section: "timeline" });
  assert.equal(windowRef.location.hash, "#timeline");
  commandListeners[0]({ command: "dashboardSection", section: "accounting" });
  assert.equal(windowRef.location.hash, "#accounting");
  commandListeners[0]({ command: "dashboardSection", section: "weekly", path: "/private/secret" });
  assert.equal(windowRef.location.hash, "#accounting");

  mounted.teardown();
  await Promise.resolve();
  assert.equal(commandListeners.length, 0);
});

test("desktop command bridge forwards only the closed automatic refresh mode", () => {
  const { commandListeners, events, windowRef } = fakeWindow();
  const mounted = mountDesktopShell({
    documentRef: fakeDocument(),
    windowRef,
  });

  commandListeners[0]({ command: "automaticRefresh", mode: "quick" });
  commandListeners[0]({ command: "automaticRefresh", mode: "detailed" });
  commandListeners[0]({ command: "automaticRefresh", mode: "quick", path: "/private/secret" });
  commandListeners[0]({ command: "automaticRefresh", mode: "background" });

  assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [
    { type: "tibotattle:automatic-refresh", detail: { mode: "quick" } },
    { type: "tibotattle:automatic-refresh", detail: { mode: "detailed" } },
  ]);
  mounted.teardown();
});
