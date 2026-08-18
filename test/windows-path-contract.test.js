import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, win32 } from "node:path";
import test from "node:test";

import {
  defaultExportSecretFile,
  defaultExportStateDirectory,
} from "../src/platform/participant-identity.js";
import {
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
} from "../src/local-installation-diagnostics.js";

test("Windows application-state paths are deterministic on every host", () => {
  const home = "D:\\Profiles\\Ada Lovelace-测试";
  assert.equal(
    defaultExportStateDirectory({ platform: "win32", homeDirectory: home, environment: {} }),
    "D:\\Profiles\\Ada Lovelace-测试\\AppData\\Local\\app-usagemonitor",
  );
  assert.equal(
    defaultExportSecretFile({
      platform: "win32",
      homeDirectory: home,
      environment: { LOCALAPPDATA: "E:\\Local Data\\用户" },
    }),
    "E:\\Local Data\\用户\\app-usagemonitor\\export-participant-secret",
  );
  assert.equal(
    win32.relative("C:\\State Root", "c:\\state root\\private\\queue.sqlite3"),
    "private\\queue.sqlite3",
  );
});

test("native Windows roots support spaces, Unicode, custom CODEX_HOME, and cleanup", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "Tibo Tattle Windows 路径 "));
  const resourceRoot = join(root, "Program Files", "TiboTattle resources");
  const localAppData = join(root, "Local AppData 用户");
  const stateRoot = defaultExportStateDirectory({
    platform: "win32",
    homeDirectory: join(root, "Profile"),
    environment: { LOCALAPPDATA: localAppData },
  });
  const codexHome = join(root, "Custom Codex Home", ".codex");
  try {
    await mkdir(resourceRoot, { recursive: true });
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    const installation = prepareLocalInstallationRoots({ resourceRoot, stateRoot });
    assert.equal(isAbsolute(installation.stateRoot), true);
    assert.equal(relative(stateRoot, installation.paths.collectorStateFile).startsWith(".."), false);
    assert.throws(
      () => prepareLocalInstallationRoots({
        resourceRoot,
        stateRoot: parse(stateRoot).root,
      }),
      { code: "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID" },
    );
    const onboarding = await inspectLocalOnboarding({
      codexHome,
      stateRoot,
      customCodexHomeConfigured: true,
    });
    assert.equal(onboarding.capabilities.customCodexHomeConfigured, true);
    assert.equal(JSON.stringify(onboarding).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
