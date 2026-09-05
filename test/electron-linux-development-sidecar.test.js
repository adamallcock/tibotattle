import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const SIDECAR = new URL("../scripts/launch-electron-linux-development.sh", import.meta.url);
const LAUNCHER = new URL("../scripts/launch-electron-linux-development.mjs", import.meta.url);

test("Linux downloaded handoff invokes the packaged Electron binary in Node mode", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-linux-sidecar-"));
  try {
    const distribution = join(root, "distribution");
    const app = join(distribution, "linux-unpacked", "tibotattle-dev");
    const launcher = join(distribution, "TiboTattle-Linux-Development-Launcher.mjs");
    const sidecar = join(distribution, "TiboTattle-Linux-Development-Launch.sh");
    await mkdir(join(distribution, "linux-unpacked"), { recursive: true });
    await writeFile(app, [
      "#!/usr/bin/env bash",
      "set -eu",
      "printf 'electron-run-as-node=%s\\n' \"${ELECTRON_RUN_AS_NODE-}\"",
      "printf 'script=%s\\n' \"$1\"",
      "printf 'arg-count=%s\\n' \"$#\"",
      "printf 'arg-2=%s\\n' \"$2\"",
      "printf 'arg-3=%s\\n' \"$3\"",
      "printf 'arg-4=%s\\n' \"$4\"",
      "printf 'arg-5=%s\\n' \"$5\"",
      "printf 'secret-present=%s\\n' \"${APP_USAGEMONITOR_EXPORT_SECRET+x}\"",
      "printf 'display=%s\\n' \"${DISPLAY-}\"",
    ].join("\n") + "\n", { mode: 0o755 });
    await writeFile(launcher, "synthetic launcher\n", { mode: 0o644 });
    await writeFile(sidecar, await readFile(SIDECAR), { mode: 0o755 });
    await chmod(app, 0o755);
    await chmod(sidecar, 0o755);

    const profile = join(root, "state-home", "tibotattle", "linux-x64-development");
    const { stdout, stderr } = await exec(sidecar, ["--dry-run"], {
      env: {
        HOME: join(root, "home"),
        PATH: process.env.PATH,
        DISPLAY: ":99",
        APP_USAGEMONITOR_EXPORT_SECRET: "synthetic-secret",
        XDG_STATE_HOME: join(root, "state-home"),
      },
    });
    assert.equal(stderr, "");
    assert.match(stdout, /electron-run-as-node=1\n/u);
    assert.match(stdout, /script=.*TiboTattle-Linux-Development-Launcher\.mjs\n/u);
    assert.match(stdout, /arg-count=6\n/u);
    assert.match(stdout, /arg-2=--app\n/u);
    assert.match(stdout, /arg-3=.*linux-unpacked\/tibotattle-dev\n/u);
    assert.match(stdout, /arg-4=--profile\n/u);
    assert.ok(stdout.includes(`arg-5=${profile}\n`));
    assert.match(stdout, /arg-5=.*linux-x64-development\n/u);
    assert.match(stdout, /secret-present=\n/u);
    assert.match(stdout, /display=:99\n/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Linux downloaded handoff stays a bounded auxiliary artifact contract", async () => {
  const [sidecar, launcher] = await Promise.all([
    readFile(SIDECAR, "utf8"),
    readFile(LAUNCHER, "utf8"),
  ]);
  assert.match(sidecar, /exec env -i \\\n\s+ELECTRON_RUN_AS_NODE=1/u);
  assert.match(sidecar, /TiboTattle-Linux-Development-Launcher\.mjs/u);
  assert.match(sidecar, /--app "\$app"/u);
  assert.match(sidecar, /--profile "\$profile"/u);
  assert.doesNotMatch(sidecar, /--no-sandbox/u);
  assert.match(launcher, /sandboxDisablingArgs: false/u);
  assert.doesNotMatch(launcher, /ELECTRON_RUN_AS_NODE\s*=/u);
  assert.doesNotMatch(launcher, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
});
