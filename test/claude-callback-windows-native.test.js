import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  buildManagedClaudeStatusLine,
  selectClaudeCallbackRunner,
} from "../src/claude-callback-lifecycle.js";
import { createCoexistingInvocation } from "../src/claude-callback-runtime.js";

const nativeWindows = process.platform === "win32" && process.arch === "x64";

function runRunner(runner, command) {
  const args = runner.kind === "git_bash"
    ? ["--noprofile", "--norc", "-c", command]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  return new Promise((resolve, reject) => {
    const child = spawn(runner.executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error("runner_spawn_failed")));
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("native Windows selects a reviewed shell and executes it without cmd.exe", {
  skip: !nativeWindows,
}, async () => {
  const runner = selectClaudeCallbackRunner();
  assert.ok(runner.kind === "git_bash" || runner.kind === "powershell");
  assert.match(runner.executable, /(?:bash|powershell)\.exe$/iu);
  assert.doesNotMatch(runner.executable, /cmd\.exe/iu);
  const command = runner.kind === "git_bash"
    ? "printf 'callback-native-ok'"
    : "Write-Output -NoNewline 'callback-native-ok'";
  const result = await runRunner(runner, command);
  assert.equal(result.code, 0);
  assert.equal(result.output, "callback-native-ok");
});

test("native Windows managed status command is Electron-as-Node and content-free", {
  skip: !nativeWindows,
}, () => {
  const runner = selectClaudeCallbackRunner();
  const statusLine = buildManagedClaudeStatusLine({
    platform: "win32",
    windowsRunner: runner,
    nodeExecutable: process.execPath,
    runtimeScript: "C:\\Program Files\\TiboTattle\\resources\\app.asar\\src\\claude-callback-runtime.js",
  });
  assert.match(statusLine.command, /ELECTRON_RUN_AS_NODE/u);
  assert.doesNotMatch(statusLine.command, /cmd\.exe|\beval\b/iu);
  assert.equal(statusLine.command.includes("PRIVATE"), false);
});

test("native Windows timeout path requires whole-tree cleanup", {
  skip: !nativeWindows,
}, async () => {
  const runner = selectClaudeCallbackRunner();
  const command = runner.kind === "git_bash"
    ? "sleep 30"
    : "Start-Sleep -Seconds 30";
  const invocation = createCoexistingInvocation(command, {
    platform: "win32",
    runner,
    timeoutMilliseconds: 100,
    windowsCleanupTimeoutMilliseconds: 5_000,
  });
  invocation.end();
  assert.deepEqual(await invocation.result, { status: "failed", output: "" });
});
