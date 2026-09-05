import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { developmentBuildEnvironment, developmentPackagePlan, executableArchitecture, parseDevelopmentPackageArguments } from "../scripts/package-electron-development.mjs";

const sourceRevision = "a".repeat(40);

test("one development packaging contract covers the four actual target architectures", () => {
  for (const [target, flag, packages] of [
    ["darwin-arm64", "--mac", ["dmg", "zip"]],
    ["darwin-x64", "--mac", ["dmg", "zip"]],
    ["win32-x64", "--win", ["nsis", "zip"]],
    ["linux-x64", "--linux", ["AppImage", "tar.gz"]],
  ]) {
    const plan = developmentPackagePlan({ target, sourceRevision, hostPlatform: "darwin", hostArchitecture: "arm64" });
    assert.deepEqual(plan.builderArguments, [flag, ...packages, `--${target.split("-")[1]}`, "--publish", "never"]);
    assert.equal(plan.stagingDirectory, `.release-build/electron-dev/${target}/app`);
    assert.equal(plan.outputDirectory, `.release-build/electron-candidates/${sourceRevision}/${target}/distribution`);
    assert.equal(plan.nativeHost, target === "darwin-arm64");
    assert.equal(plan.signed, false);
    assert.equal(plan.published, false);
    assert.equal(plan.updaterEnabled, false);
    assert.equal(plan.installedLifecycleQualified, false);
  }
  assert.equal(developmentPackagePlan({ target: "linux-x64", sourceRevision, hostPlatform: "darwin" }).buildHostAvailable, true);
  assert.equal(developmentPackagePlan({ target: "darwin-x64", sourceRevision, hostPlatform: "linux" }).buildHostAvailable, false);
  assert.equal(developmentPackagePlan({ target: "linux-x64", sourceRevision, hostPlatform: "linux", hostArchitecture: "arm64" }).nativeHost, false);
});

test("package CLI refuses unknown targets, publication flags, duplicate selections and ambiguous native inputs", () => {
  for (const args of [
    ["--target", "linux-arm64"], ["--publish", "always"], ["--target", "darwin-x64", "--target", "darwin-arm64"],
    ["--format", "release"], ["--windows-binding", "binding.node"],
    ["--target", "linux-x64", "--windows-binding", "binding.node", "--windows-manifest", "manifest.json"],
  ]) assert.throws(() => parseDevelopmentPackageArguments(args), /ELECTRON_DEVELOPMENT_/u);
  const options = parseDevelopmentPackageArguments(["--target", "win32-x64", "--format", "dir", "--windows-binding", "binding.node", "--windows-manifest", "manifest.json", "--dry-run"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.replaceStaging, false);
  assert.equal(options.windowsBindingPath, "binding.node");
  assert.throws(() => developmentPackagePlan({ target: "darwin-arm64", sourceRevision: "main" }), /PLAN_INVALID/u);
});

test("development builder cannot inherit signing, publishing or application credentials", () => {
  const env = developmentBuildEnvironment({ PATH: "/safe/bin", HOME: "/safe/home", CSC_LINK: "private", WIN_CSC_LINK: "private", CSC_KEY_PASSWORD: "private", GH_TOKEN: "private", APPLE_ID: "private", APPLE_APP_SPECIFIC_PASSWORD: "private", APP_USAGEMONITOR_EXPORT_SECRET: "private", USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid", TIBOTATTLE_ELECTRON_TARGET: "win32-x64" }, "darwin-arm64");
  assert.deepEqual(Object.keys(env).sort(), ["CSC_IDENTITY_AUTO_DISCOVERY", "HOME", "PATH", "TIBOTATTLE_ELECTRON_TARGET", "TIBOTATTLE_ELECTRON_VERSION"]);
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(env.TIBOTATTLE_ELECTRON_TARGET, "darwin-arm64");
  assert.equal(JSON.stringify(env).includes("private"), false);
});

test("artifact machine verification rejects an incorrect or malformed executable", () => {
  for (const [cpu, target] of [[0x0100000c, "darwin-arm64"], [0x01000007, "darwin-x64"]]) {
    const header = Buffer.alloc(64); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(cpu, 4);
    assert.equal(executableArchitecture(header), target);
  }
  const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  assert.equal(executableArchitecture(elf), "linux-x64");
  elf.writeUInt16LE(183, 18);
  assert.throws(() => executableArchitecture(elf), /EXECUTABLE_ARCHITECTURE/u);
  const pe = Buffer.alloc(256); pe.write("MZ"); pe.writeUInt32LE(128, 60); pe.write("PE\0\0", 128); pe.writeUInt16LE(0x8664, 132);
  assert.equal(executableArchitecture(pe), "win32-x64");
  pe.writeUInt32LE(65535, 60);
  assert.throws(() => executableArchitecture(pe), /EXECUTABLE_ARCHITECTURE/u);
  for (const header of [Buffer.alloc(0), Buffer.from("arbitrary"), Buffer.alloc(64)]) assert.throws(() => executableArchitecture(header), /EXECUTABLE_ARCHITECTURE/u);
});

test("the development workflow builds each target on a static native runner without release authority", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|id-token: write|--publish always/u);
  const jobs = workflow.split(/\n(?= {2}[a-z][a-z0-9-]+:\n)/u);
  for (const [target, runner] of [["darwin-arm64", "macos-26"], ["darwin-x64", "macos-26-intel"], ["win32-x64", "windows-2025"], ["linux-x64", "ubuntu-24.04"]]) {
    const job = jobs.find((section) => section.startsWith(`  ${target}:\n`));
    assert.ok(job);
    assert.ok(job.includes(`runs-on: ${runner}\n`));
    assert.ok(job.includes(`package-electron-development.mjs --target ${target} --format distribution --replace-staging`));
    assert.ok(job.includes(`/\${{ github.sha }}/${target}/distribution/`));
  }
  assert.match(workflow, /Add the Windows development launch handoff/u);
  assert.match(workflow, /TiboTattle-Windows-Development-Launch\.txt/u);
  assert.match(workflow, /TiboTattle-Windows-Development-Launch\.cmd/u);
  assert.match(workflow, /win-unpacked\\TiboTattle Dev\.exe/u);
  assert.match(workflow, /ELECTRON_RUN_AS_NODE=1/u);
  assert.match(workflow, /%LOCALAPPDATA%\\TiboTattle\\electron-user-test/u);
  assert.match(workflow, /does not require a separate Node\.js installation/u);
  assert.match(workflow, /launch-electron-windows-development\.mjs --app/u);
  assert.match(workflow, /Node\.js 26\.2\.0/u);
  assert.equal((workflow.match(/persist-credentials: false/gu) ?? []).length, 4);
  assert.equal((workflow.match(/if-no-files-found: error/gu) ?? []).length, 4);
  assert.match(workflow, /WINDOWS_BINDING_BUILD_FAILED/u);
});
