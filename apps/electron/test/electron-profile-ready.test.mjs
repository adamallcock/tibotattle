import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAccountlessSignedStagingRehearsalMetadata,
} from "../../../scripts/lib/electron-builder-package-json.mjs";

const require = createRequire(import.meta.url);
const PRODUCTION_ENTRYPOINT = new URL("../main.js", import.meta.url).href;

test("the production Electron entry configures signed staging before ready", {
  // The signed staging package policy is qualified only for macOS arm64.
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-ready-"));
  const appRoot = join(root, "synthetic-app");
  const home = join(root, "home");
  const appData = join(home, "Library", "Application Support");
  const profile = join(appData, "TiboTattle Signed Staging Rehearsal");
  const temporary = join(root, "tmp");
  const defaultUserData = join(appData, "TiboTattle");
  const resultPath = join(root, "result.json");
  const operatingUID = process.getuid();
  const operatingUsername = userInfo().username;
  await Promise.all([
    mkdir(appRoot, { recursive: true, mode: 0o700 }),
    mkdir(appData, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temporary, { recursive: true, mode: 0o700 }),
  ]);
  const metadata = createAccountlessSignedStagingRehearsalMetadata({
    expectedTestUID: operatingUID,
    expectedTestUsername: operatingUsername,
    sourceRevision: "a".repeat(40),
  });
  await writeFile(join(appRoot, "package.json"), `${JSON.stringify({
    name: "app-usagemonitor",
    productName: "TiboTattle",
    version: "0.1.18",
    tibotattleAccountlessSignedStagingRehearsal: metadata,
    main: "main.mjs",
    type: "module",
  })}\n`, "utf8");
  await writeFile(join(appRoot, "main.mjs"), `
    import { app } from "electron";
    import { writeFileSync } from "node:fs";

    const profile = process.env.TIBOTATTLE_SYNTHETIC_PROFILE;
    const resultPath = process.env.TIBOTATTLE_SYNTHETIC_RESULT;
    const appRoot = process.env.TIBOTATTLE_SYNTHETIC_APP_ROOT;
    // macOS appData is not selected by HOME. Bind it explicitly before the
    // product entry can read a profile path.
    app.setPath("appData", process.env.TIBOTATTLE_SYNTHETIC_APP_DATA);
    // The real ready event still fires. Hold the ordinary lifecycle's separate
    // promise forever so its native handover/credential work cannot execute.
    app.whenReady = () => new Promise(() => {});
    Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
    app.getAppPath = () => appRoot;
    app.getName = () => "TiboTattle";
    app.once("ready", () => {
      writeFileSync(resultPath, JSON.stringify({
        readyEvent: true,
        readyAtEvent: app.isReady(),
        configuredBeforeReady: app.getPath("userData") === profile,
        userDataIsProfile: app.getPath("userData") === profile,
        sessionDataIsProfile: app.getPath("sessionData") === profile,
      }), { mode: 0o600 });
      // The ordinary lifecycle is held at the explicit whenReady barrier.
      process.exit(0);
    });

    // This is the actual packaged entry, so its top-level bootstrap is the
    // production code under test rather than a copied profile implementation.
    await import(${JSON.stringify(PRODUCTION_ENTRYPOINT)});
  `);

  try {
    const electron = require("electron");
    const child = spawn(electron, [
      `--user-data-dir=${defaultUserData}`,
      "--disable-gpu",
      appRoot,
    ], {
      cwd: appRoot,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: temporary,
        GITHUB_ACTIONS: "true",
        RUNNER_ARCH: "ARM64",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: "macOS",
        TIBOTATTLE_SYNTHETIC_PROFILE: profile,
        TIBOTATTLE_SYNTHETIC_RESULT: resultPath,
        TIBOTATTLE_SYNTHETIC_APP_ROOT: appRoot,
        TIBOTATTLE_SYNTHETIC_APP_DATA: appData,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBytes = 0;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`synthetic Electron ready probe timed out (${stderrBytes} stderr bytes)`));
      }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      readyEvent: true,
      readyAtEvent: true,
      configuredBeforeReady: true,
      userDataIsProfile: true,
      sessionDataIsProfile: true,
    });
    const profileStats = await lstat(profile);
    assert.equal(profileStats.isDirectory(), true);
    assert.equal(profileStats.uid, operatingUID);
    assert.equal(profileStats.mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
