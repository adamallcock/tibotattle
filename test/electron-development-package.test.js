import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developmentBuildEnvironment, developmentPackagePlan, executableArchitecture, parseDevelopmentPackageArguments, writeDevelopmentHandoff } from "../scripts/package-electron-development.mjs";

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
    assert.equal(plan.packagingProfile, "development");
    assert.equal(Object.hasOwn(plan, "accountlessHostedRehearsal"), false);
  }
  assert.equal(developmentPackagePlan({ target: "linux-x64", sourceRevision, hostPlatform: "darwin" }).buildHostAvailable, true);
  assert.equal(developmentPackagePlan({ target: "darwin-x64", sourceRevision, hostPlatform: "linux" }).buildHostAvailable, false);
  assert.equal(developmentPackagePlan({ target: "linux-x64", sourceRevision, hostPlatform: "linux", hostArchitecture: "arm64" }).nativeHost, false);
});

test("hosted scheduler rehearsal is an explicit unsigned arm64 directory package", () => {
  const options = parseDevelopmentPackageArguments([
    "--target", "darwin-arm64", "--format", "dir", "--accountless-hosted-rehearsal",
  ]);
  assert.equal(options.accountlessHostedRehearsal, true);
  const plan = developmentPackagePlan({ ...options, sourceRevision });
  assert.equal(plan.packagingProfile, "accountless-hosted-rehearsal");
  assert.equal(plan.accountlessHostedRehearsal.sourceRevision, sourceRevision);
  assert.equal(plan.accountlessHostedRehearsal.target, "darwin-arm64");
  assert.deepEqual(plan.builderArguments, ["--mac", "dir", "--arm64", "--publish", "never"]);
  assert.equal(plan.outputDirectory,
    `.release-build/electron-candidates/${sourceRevision}/darwin-arm64/accountless-hosted-rehearsal`);
  assert.equal(plan.signed, false);
  assert.equal(plan.updaterEnabled, false);
  for (const target of ["darwin-x64", "win32-x64", "linux-x64"]) {
    assert.throws(() => parseDevelopmentPackageArguments([
      "--target", target, "--format", "dir", "--accountless-hosted-rehearsal",
    ]), /HOSTED_REHEARSAL_TARGET_OR_FORMAT_INVALID/u);
  }
  assert.throws(() => developmentPackagePlan({
    target: "darwin-arm64", format: "distribution", sourceRevision,
    accountlessHostedRehearsal: true,
  }), /HOSTED_REHEARSAL_TARGET_OR_FORMAT_INVALID/u);
  assert.throws(() => parseDevelopmentPackageArguments([
    "--target", "darwin-arm64", "--format", "dir", "--accountless-hosted-rehearsal",
    "--origin", "https://example.invalid",
  ]), /ARGUMENT_INVALID/u);
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
  assert.match(workflow, /  push:\n    branches:\n      - codex\/unified-desktop-accountless\n/u);
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
  assert.doesNotMatch(workflow, /Add the (?:Windows|Linux) development launch handoff/u,
    "handoff assembly belongs to the common local/CI packaging command");
  assert.equal((workflow.match(/persist-credentials: false/gu) ?? []).length, 5);
  assert.equal((workflow.match(/if-no-files-found: error/gu) ?? []).length, 5);
  assert.match(workflow, /WINDOWS_BINDING_BUILD_FAILED/u);
  assert.match(workflow, /LINUX_CREDENTIAL_MUTEX_NODE_GYP_UNAVAILABLE/u);
  assert.match(workflow, /rebuild --directory native\/linux-credential-mutex/u);
  assert.match(workflow, /stage-linux-credential-mutex-binding\.mjs/u);
  assert.match(workflow, /build-linux-credential-mutex-manifest\.mjs/u);
  assert.match(workflow, /qualify-linux-credential-mutex\.mjs/u);
  assert.ok(
    workflow.indexOf("stage-linux-credential-mutex-binding.mjs")
      < workflow.indexOf("build-linux-credential-mutex-manifest.mjs"),
  );
  assert.ok(
    workflow.indexOf("build-linux-credential-mutex-manifest.mjs")
      < workflow.indexOf("qualify-linux-credential-mutex.mjs"),
  );

  const windowsPackageJob = jobs.find((section) => section.startsWith("  win32-x64:\n"));
  const windowsLifecycleJob = jobs.find((section) => section.startsWith("  win32-x64-nsis-lifecycle:\n"));
  assert.ok(windowsPackageJob);
  assert.ok(windowsLifecycleJob);
  assert.match(windowsPackageJob, /outputs:\n\s+development-artifact-id: \$\{\{ steps\.retain-win32-development\.outputs\.artifact-id \}\}/u);
  assert.match(windowsPackageJob, /id: retain-win32-development/u);
  assert.match(windowsPackageJob, /\.release-build\/electron-dev\/win32-x64\/app\//u);
  assert.match(windowsPackageJob, /id: validate-win32-retained-inputs/u);
  assert.match(windowsPackageJob, /WINDOWS_RETAINED_ARTIFACT_REPARSE_POINT/u);
  assert.match(windowsPackageJob, /node_modules\/json-schema-traverse\/\.eslintrc\.yml/u);
  assert.match(windowsPackageJob, /b1ea981e2461f053646b08a616efcaba0d3b278b223957e9eb931bcbc3971ccc/u);
  assert.match(windowsPackageJob, /node_modules\/fast-uri\/\.gitattributes/u);
  assert.match(windowsPackageJob, /e173bffc6cde613d3e6d06e49f2b1d05385cb02aa68c4931656b5b051ab649dd/u);
  assert.match(
    windowsPackageJob,
    /if: \$\{\{ !cancelled\(\) && steps\.validate-win32-retained-inputs\.outcome == 'success' \}\}/u,
  );
  assert.ok(
    windowsPackageJob.indexOf("Exercise synthetic upload and account-observation storage")
      < windowsPackageJob.indexOf("Validate exact retained Windows artifact inputs"),
  );
  assert.ok(
    windowsPackageJob.indexOf("Validate exact retained Windows artifact inputs")
      < windowsPackageJob.indexOf("Retain verified Windows package, staging tree, and receipts"),
  );
  assert.doesNotMatch(windowsPackageJob, /Exercise unsigned NSIS install/u);

  assert.match(windowsLifecycleJob, /needs: win32-x64/u);
  assert.match(windowsLifecycleJob, /runs-on: windows-2025/u);
  assert.match(windowsLifecycleJob, /persist-credentials: false/u);
  assert.match(windowsLifecycleJob, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(windowsLifecycleJob, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  assert.match(windowsLifecycleJob, /artifact-ids: \$\{\{ needs\.win32-x64\.outputs\.development-artifact-id \}\}/u);
  assert.match(windowsLifecycleJob, /merge-multiple: true/u);
  assert.match(windowsLifecycleJob, /\.release-build\/electron-dev\/win32-x64\/app/u);
  assert.match(windowsLifecycleJob, /smoke-electron-windows-nsis-lifecycle\.mjs/u);
  assert.match(windowsLifecycleJob, /Retain Windows NSIS lifecycle receipt/u);
  assert.doesNotMatch(windowsLifecycleJob, /smoke-electron-windows-accountless\.mjs/u);
});

test("common packaging assembles usable, hashed handoffs without a source checkout", async () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
    const outputDirectory = await mkdtemp(join(tmpdir(), "electron-development-handoff-"));
    try {
      const files = await writeDevelopmentHandoff({ target, outputDirectory });
      assert.equal(files.length, target.startsWith("darwin-") ? 1 : 3);
      for (const file of files) {
        const bytes = await readFile(join(outputDirectory, file.file));
        assert.equal(bytes.length, file.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
        if (file.executable && process.platform !== "win32") {
          assert.equal((await stat(join(outputDirectory, file.file))).mode & 0o111, 0o111);
        }
      }
      const readme = await readFile(join(outputDirectory, "DEVELOPMENT-TESTING.txt"), "utf8");
      assert.match(readme, /hosted accountless uploads remain unavailable/u);
      if (!target.startsWith("darwin-")) {
        assert.match(readme, /No separate Node\.js installation or source checkout is needed/u);
        const wrapper = files.find(({ file }) => /\.(?:cmd|sh)$/u.test(file));
        const source = await readFile(join(outputDirectory, wrapper.file), "utf8");
        assert.match(source, /ELECTRON_RUN_AS_NODE=1/u);
        assert.doesNotMatch(source, /SOURCE_CHECKOUT|%SOURCE%|source checkout.*required/iu);
      }
      await assert.rejects(writeDevelopmentHandoff({ target, outputDirectory }), { code: "EEXIST" });
      assert.equal(await readFile(join(outputDirectory, "DEVELOPMENT-TESTING.txt"), "utf8"), readme);
    } finally { await rm(outputDirectory, { recursive: true, force: true }); }
  }
});

test("Linux native qualification outputs leave the source inventory unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "electron-native-build-ignore-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  try {
    git("init", "--quiet", "--template=");
    await writeFile(join(directory, ".gitignore"), await readFile(new URL("../.gitignore", import.meta.url)));
    const source = "native/linux-credential-mutex/linux-credential-mutex.cc";
    await mkdir(join(directory, "native/linux-credential-mutex"), { recursive: true });
    await writeFile(join(directory, source), "// synthetic qualification source\n");
    const before = git("status", "--porcelain", "--untracked-files=all");
    assert.ok(before.includes(source), "native source changes must remain visible to the clean-source gate");

    for (const build of [
      "native/linux-credential-mutex/build/Release",
      "native/linux-credential-mutex/build/qualification",
    ]) {
      await mkdir(join(directory, build), { recursive: true });
      for (const name of ["linux_credential_mutex.node", "linux_credential_mutex.node.manifest.json"]) {
        await writeFile(join(directory, build, name), "synthetic build output\n");
        assert.equal(git("check-ignore", "--", `${build}/${name}`).trim(), `${build}/${name}`);
      }
    }
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), before,
      "building, staging, and manifesting the native binding must not dirty the packager's source inventory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
