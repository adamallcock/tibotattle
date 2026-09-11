import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopDiagnostics,
  formatDesktopDiagnostics,
} from "../desktop-diagnostics.js";

test("desktop diagnostics reduce runtime state to content-free enums and booleans", () => {
  const record = createDesktopDiagnostics({
    platform: "darwin",
    architecture: "arm64",
    version: "0.1.16",
    build: "release-abc123",
    lifecycle: {
      started: true,
      active: true,
      dashboardReady: true,
      windowVisible: false,
      hasTray: true,
      recoveryStatus: "companion_spawn_failed",
      origin: "http://127.0.0.1:61295/",
      privatePath: "/Users/adam/.codex",
    },
    settings: {
      language: "es",
      appearance: "dark",
      refreshIntervalSeconds: 900,
      codexFolder: {
        kind: "custom",
        displayPath: "/Users/adam/private-codex",
      },
      startAtLogin: { status: "enabled" },
      notifications: { delivery: "ready" },
    },
  });
  const text = formatDesktopDiagnostics(record);
  assert.match(text, /tibotattle-electron-diagnostics-v1/u);
  assert.match(text, /"dashboardReady": true/u);
  assert.doesNotMatch(text, /127\.0\.0\.1|Users|private-codex/u);
  assert.deepEqual(record.settings, {
    language: "es",
    appearance: "dark",
    refreshIntervalSeconds: 900,
    codexFolder: "custom",
    startAtLogin: "enabled",
    notificationDelivery: "ready",
  });
  assert.deepEqual(record.privacy, {
    includesPrivateData: false,
    includesPaths: false,
    includesCredentials: false,
  });
});

test("desktop diagnostics fail closed when a caller tampers with privacy guarantees", () => {
  const record = createDesktopDiagnostics({ platform: "win32", architecture: "x64" });
  assert.throws(
    () => formatDesktopDiagnostics({
      ...record,
      privacy: { ...record.privacy, includesPaths: true },
    }),
    TypeError,
  );
});

test("desktop diagnostics reject injected top-level and nested fields", () => {
  const record = createDesktopDiagnostics({ platform: "darwin", architecture: "arm64" });
  const injections = [
    {
      ...record,
      injected: "private value",
    },
    {
      ...record,
      lifecycle: {
        ...record.lifecycle,
        injected: "private value",
      },
    },
    {
      ...record,
      settings: {
        ...record.settings,
        injected: "private value",
      },
    },
    {
      ...record,
      privacy: {
        ...record.privacy,
        injected: true,
      },
    },
  ];
  for (const injected of injections) {
    assert.throws(() => formatDesktopDiagnostics(injected), TypeError);
  }
});

test("desktop diagnostics reject non-plain records and invalid allowlisted values", () => {
  const record = createDesktopDiagnostics({ platform: "linux", architecture: "x64" });
  assert.throws(
    () => formatDesktopDiagnostics(Object.assign(Object.create({ inherited: true }), record)),
    TypeError,
  );
  assert.throws(
    () => formatDesktopDiagnostics({
      ...record,
      lifecycle: { ...record.lifecycle, started: "yes" },
    }),
    TypeError,
  );
  assert.throws(
    () => formatDesktopDiagnostics({
      ...record,
      settings: { ...record.settings, refreshIntervalSeconds: 1 },
    }),
    TypeError,
  );
});

test("desktop diagnostics reject coercible label objects before serialization", () => {
  const record = createDesktopDiagnostics({ platform: "darwin", architecture: "arm64" });
  const injectedText = "/Users/adam/private-codex?credential=secret";
  let toJsonCalls = 0;
  const forgedLabel = {
    toString: () => "safe-label",
    toJSON: () => {
      toJsonCalls += 1;
      return injectedText;
    },
  };

  let formatted;
  assert.throws(
    () => {
      formatted = formatDesktopDiagnostics({ ...record, version: forgedLabel });
    },
    TypeError,
  );
  assert.equal(formatted, undefined);
  assert.equal(toJsonCalls, 0);
});
