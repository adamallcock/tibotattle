import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalCompanionServer } from "./server.js";
import { CLIENT_WEB_FILES } from "../../scripts/export-tibotattle.mjs";
import { MACOS_WEB_MODULE_ENTRYPOINTS, MACOS_RUNTIME_STATIC_ASSETS } from "../../scripts/build-macos-app.js";

const ASSETS = ["desktop-shell.js", "electron-tray-popup.html", "electron-tray-popup.js",
  "electron-tray-popup.css", "electron-settings.html", "electron-settings.js",
  "electron-settings.css", "icon-panel-left.svg", "icon-refresh-cw.svg", "icon-settings.svg"];

test("Electron settings and bridge have a real loopback route and retained client/native asset closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-assets-"));
  const sourceStaticRoot = fileURLToPath(new URL("../web/public/", import.meta.url));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  for (const file of ASSETS) await copyFile(join(sourceStaticRoot, file), join(staticRoot, file));
  const codexHome = join(root, "synthetic-codex");
  await mkdir(codexHome, { mode: 0o700 });
  let app;
  try {
    app = await startLocalCompanionServer({ resourceRoot,
      stateRoot: join(root, "state"), codexHome, staticRoot, port: 0,
      dataStore: { initialize: async () => {}, reload: async () => {}, getOverview: () => ({}) },
      refreshRunner: async () => ({}),
    });
    const origin = `http://127.0.0.1:${app.port}`;
    for (const file of ASSETS) {
      const response = await fetch(`${origin}/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(await response.text(), await readFile(join(staticRoot, file), "utf8"), file);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.ok(CLIENT_WEB_FILES.includes(`apps/web/public/${file}`), `client export: ${file}`);
      assert.ok([...MACOS_WEB_MODULE_ENTRYPOINTS, ...MACOS_RUNTIME_STATIC_ASSETS]
        .includes(`apps/web/public/${file}`), `native closure: ${file}`);
    }
    const health = await (await fetch(`${origin}/api/local/health`)).json();
    assert.equal(health.capabilities.centralServiceProxy, false);
    assert.equal(health.capabilities.contributionDevicePairing, false);
    assert.equal(health.capabilities.incrementalContributionSync, false);
    assert.equal((await fetch(`${origin}/unexpected-electron-file.js`)).status, 404);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
