import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const PRELOAD_PATH = fileURLToPath(new URL("../preload.cjs", import.meta.url));

async function smokeBridges({ platform, environment }) {
  const exposed = new Map();
  const source = await readFile(PRELOAD_PATH, "utf8");
  const context = vm.createContext({
    process: { platform, env: environment },
    require(identifier) {
      assert.equal(identifier, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value); } },
        ipcRenderer: { invoke() { return Promise.resolve(false); }, on() {}, off() {} },
      };
    },
  });
  vm.runInContext(source, context, { filename: PRELOAD_PATH });
  return exposed;
}

test("Windows normal candidate exposes only the one-shot startup gate under its quit-only smoke control", async () => {
  const normal = await smokeBridges({
    platform: "win32",
    environment: { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1" },
  });
  const bridge = normal.get("__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__");
  assert.equal(bridge?.version, "v1");
  assert.equal(typeof bridge?.waitForStartupRefresh, "function");
  assert.equal(bridge.releaseStartupRefresh(), true);
  assert.equal(bridge.releaseStartupRefresh(), false);

  for (const environment of [
    {},
    { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1", USAGE_MONITOR_TEST_LANE: "unexpected" },
    { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1", USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "unexpected" },
  ]) {
    const rejected = await smokeBridges({ platform: "win32", environment });
    assert.equal(rejected.has("__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__"), false);
  }
});
