import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  formatTrustedSigningPreflight,
  parseTrustedSigningProbe,
  runTrustedSigningPreflight,
  trustedSigningPowerShellCommand,
  validateTrustedSigningProbe,
} from "../scripts/verify-windows-trusted-signing-preflight.mjs";

const PREFLIGHT_SCRIPT = "scripts/verify-windows-trusted-signing-preflight.mjs";
const REQUIRED_STATUS = "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED";
const INVALID_STATUS = "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_INVALID";
const UNSUPPORTED_STATUS = "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_NATIVE_WINDOWS_REQUIRED";
const UNAVAILABLE_STATUS = "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_UNAVAILABLE";
const require = createRequire(import.meta.url);

async function installedAppBuilderSource(relativePath) {
  const sourceRoot = process.env.TIBOTATTLE_APP_BUILDER_SOURCE_ROOT;
  if (sourceRoot) return readFile(join(resolve(sourceRoot), relativePath), "utf8");
  const electronBuilderEntry = require.resolve("electron-builder");
  const electronBuilderRoot = resolve(dirname(electronBuilderEntry), "..");
  const appBuilderRoot = resolve(electronBuilderRoot, "..", "app-builder-lib");
  return readFile(join(appBuilderRoot, relativePath), "utf8");
}

test("TrustedSigning preflight is read-only, exact-version, and content-free", async () => {
  const source = await readFile(PREFLIGHT_SCRIPT, "utf8");
  const command = trustedSigningPowerShellCommand();

  assert.match(command, /Get-Module -ListAvailable -Name TrustedSigning/u);
  assert.match(source, /REQUIRED_VERSION = "0\.5\.0"/u);
  assert.doesNotMatch(command, /Install-Module|Import-Module|Invoke-TrustedSigning/u);
  assert.doesNotMatch(source, /process\.env|AZURE_CLIENT_SECRET|CSC_LINK|PFX|credential/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /stdio: \["ignore", "pipe", "ignore"\]/u);
  assert.match(source, /WINDOWS_TRUSTEDSIGNING_PREFLIGHT_/u);

  assert.equal(validateTrustedSigningProbe({ count: 1, versions: ["0.5.0"] }), true);
  assert.equal(validateTrustedSigningProbe({ count: 2, versions: ["0.5.0", "0.6.0"] }), false);
  assert.equal(validateTrustedSigningProbe({ count: 1, versions: ["0.5.1"] }), false);
  assert.equal(validateTrustedSigningProbe({ count: 0, versions: [] }), false);
  assert.equal(validateTrustedSigningProbe({ count: 1, versions: ["0.5.0"], path: "C:\\private" }), false);
  assert.equal(parseTrustedSigningProbe('{"count":1,"versions":["0.5.0"]}').status, REQUIRED_STATUS);
  assert.equal(parseTrustedSigningProbe('{"count":1,"versions":["0.5.0","0.6.0"]}').status, INVALID_STATUS);
  assert.equal(parseTrustedSigningProbe("diagnostic data").status, INVALID_STATUS);
});

test("Windows preflight accepts only the exact injected success aggregate", () => {
  const calls = [];
  const outcome = runTrustedSigningPreflight({
    platform: "win32",
    executable: "powershell.exe",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '{"count":1,"versions":["0.5.0"]}' };
    },
  });
  assert.deepEqual(outcome, { status: REQUIRED_STATUS, exitCode: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "ignore"]);
  assert.doesNotMatch(calls[0].args.join(" "), /Install-Module|Import-Module|Invoke-TrustedSigning/u);

  const invalid = runTrustedSigningPreflight({
    platform: "win32",
    spawn: () => ({ status: 0, stdout: '{"count":1,"versions":["0.5.1"]}' }),
  });
  assert.deepEqual(invalid, { status: INVALID_STATUS, exitCode: 1 });

  const unavailable = runTrustedSigningPreflight({
    platform: "win32",
    spawn: () => ({ status: 1, stdout: "", stderr: "private diagnostic" }),
  });
  assert.deepEqual(unavailable, { status: UNAVAILABLE_STATUS, exitCode: 1 });
});

test("non-Windows invocation fails closed with a fixed unsupported status", () => {
  const result = runTrustedSigningPreflight({ platform: "darwin" });
  assert.deepEqual(result, { status: UNSUPPORTED_STATUS, exitCode: 1 });
  assert.equal(formatTrustedSigningPreflight(result), `${UNSUPPORTED_STATUS}\n`);

  const child = spawnSync(process.execPath, [PREFLIGHT_SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  if (process.platform === "win32") return;
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout, `${UNSUPPORTED_STATUS}\n`);
});

test("pnpm frozen install pins the exact app-builder-lib Azure module command", async () => {
  const patchPath = resolve("patches/app-builder-lib@26.15.7.patch");
  const patch = await readFile(patchPath, "utf8");
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const workspace = await readFile("pnpm-workspace.yaml", "utf8");
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");
  assert.match(
    workspace,
    /app-builder-lib@26\.15\.7:\s+patches\/app-builder-lib@26\.15\.7\.patch/u,
  );
  assert.match(lockfile, new RegExp(`app-builder-lib@26\\.15\\.7:\\s+${patchHash}`, "u"));
  assert.match(lockfile, new RegExp(`patch_hash=${patchHash}`, "u"));
  assert.match(patch, /^\+.*Install-Module -Name TrustedSigning -RequiredVersion 0\.5\.0/um);
  assert.match(patch, /^-.*Install-Module -Name TrustedSigning -MinimumVersion 0\.5\.0/um);

  const azureManager = await installedAppBuilderSource(
    "out/codeSign/windowsSignAzureManager.js",
  );
  assert.match(azureManager, /Install-Module -Name TrustedSigning -RequiredVersion 0\.5\.0/u);
  assert.doesNotMatch(azureManager, /Install-Module -Name TrustedSigning -MinimumVersion/u);
});
