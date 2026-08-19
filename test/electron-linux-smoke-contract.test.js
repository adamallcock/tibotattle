import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Linux Electron smoke keeps the desktop boundary explicit", async () => {
  const source = await readFile("scripts/smoke-electron-linux.mjs", "utf8");
  const entry = await readFile("apps/electron/main.js", "utf8");
  assert.match(source, /USAGE_MONITOR_STATE_ROOT/u);
  assert.match(source, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /Browser\.setWindowBounds/u);
  assert.match(source, /SIGUSR2/u);
  assert.match(source, /descendantsOf/u);
  assert.match(source, /network-none/u);
  assert.match(entry, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(entry, /lifecycle\.requestQuit\(\)/u);
  assert.match(entry, /process\.platform !== "win32"/u);
  assert.doesNotMatch(source, /windowsProductionReady\s*:\s*true/u);
});
