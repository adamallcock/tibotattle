import assert from "node:assert/strict";
import test from "node:test";

import {
  isElectronDashboard,
  resolveDesktopAppearance,
  resolveElectronStartupAppearance,
} from "../public/desktop-appearance.js";

function documentWithMarker(marked) {
  return {
    documentElement: {
      classList: { contains: (value) => marked && value === "electron-dashboard" },
    },
    body: { classList: { contains: () => false } },
  };
}

function windowWithScheme({ dark, bridge = true } = {}) {
  return {
    ...(bridge ? { tibotattleDesktop: { version: "v1" } } : {}),
    matchMedia(query) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return { matches: dark };
    },
  };
}

test("desktop appearance resolves system and forced preferences", () => {
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: windowWithScheme({ dark: true }),
  }), "dark");
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: windowWithScheme({ dark: false }),
  }), "light");
  assert.equal(resolveDesktopAppearance("dark", {
    windowRef: windowWithScheme({ dark: false }),
  }), "dark");
  assert.equal(resolveDesktopAppearance("light", {
    windowRef: windowWithScheme({ dark: true }),
  }), "light");
  assert.equal(resolveDesktopAppearance("sepia", {
    windowRef: windowWithScheme({ dark: true }),
  }), null);
});

test("system appearance fails safely to light when matchMedia is unavailable", () => {
  assert.equal(resolveDesktopAppearance("system", { windowRef: {} }), "light");
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: { matchMedia() { throw new Error("unavailable"); } },
  }), "light");
});

test("startup appearance follows Chromium only inside Electron", () => {
  const publicDocument = documentWithMarker(false);
  assert.equal(isElectronDashboard(publicDocument, windowWithScheme({
    dark: true,
    bridge: false,
  })), false);
  assert.equal(resolveElectronStartupAppearance({
    documentRef: publicDocument,
    windowRef: windowWithScheme({ dark: true, bridge: false }),
  }), null);

  assert.equal(resolveElectronStartupAppearance({
    documentRef: publicDocument,
    windowRef: windowWithScheme({ dark: true }),
  }), "dark");
  assert.equal(resolveElectronStartupAppearance({
    documentRef: documentWithMarker(true),
    windowRef: windowWithScheme({ dark: false, bridge: false }),
  }), "light");
});
