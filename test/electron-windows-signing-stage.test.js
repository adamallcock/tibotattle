import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import transfer from "../scripts/lib/windows-signing-transfer.cjs";
import { finalizeWindowsSigningStageMetadata, parseWindowsSigningStageArguments, validateWindowsNsisCompilerResult, verifyWindowsNsisContinuation, withWritableWindowsNativeInputs } from "../scripts/prepare-electron-windows-signing-stage.mjs";

const require = createRequire(import.meta.url);
const binding = { sourceRevision: "a".repeat(40), candidateSha256: "b".repeat(64), version: "1.2.3", buildNumber: "42" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Windows signing stages require explicit chained digests and reject authority", () => {
  const base = ["--stage", "native", "--candidate-receipt", "candidate.json", "--candidate-sha256", binding.candidateSha256,
    "--source-revision", binding.sourceRevision];
  assert.equal(parseWindowsSigningStageArguments(base).stage, "native");
  assert.throws(() => parseWindowsSigningStageArguments([...base, "--stage", "installer"]), /ARGUMENT_INVALID/u);
  const installer = [...base]; installer[1] = "installer";
  const signed = ["--signed-root", "signed", "--signed-receipt-sha256", "c".repeat(64), "--manifest-sha256", "d".repeat(64)];
  assert.throws(() => parseWindowsSigningStageArguments([...installer, ...signed]), /ARGUMENT_INVALID/u);
  assert.equal(parseWindowsSigningStageArguments([...installer, ...signed, "--continuation-sha256", "e".repeat(64)]).stage, "installer");
  assert.throws(() => parseWindowsSigningStageArguments([...base, ...signed]), /ARGUMENT_INVALID/u);
  for (const key of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "AZURE_CONFIG_DIR", "ARM_CLIENT_ID", "CSC_LINK", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"]) {
    assert.throws(() => transfer.assertUnprivileged({ [key]: "" }), /AUTHORITY_PRESENT/u, key);
  }
  assert.doesNotThrow(() => transfer.assertUnprivileged({ PATH: "synthetic", TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Adam Allcock" }));
});

async function fixture(run) {
  const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), "windows-signing-continuation-")));
  const root = join(repositoryRoot, ".release-build/electron-production/win32-x64");
  const stateRoot = join(root, "signing-transfer");
  const previousRoot = process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT;
  const previousStage = process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE;
  try {
    const modulePath = join(repositoryRoot, "scripts/lib/windows-signing-transfer.cjs");
    await mkdir(join(repositoryRoot, "scripts/lib"), { recursive: true });
    await copyFile(resolve("scripts/lib/windows-signing-transfer.cjs"), modulePath);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "context.json"), JSON.stringify({ schemaVersion: "tibotattle-windows-signing-transfer-v1", ...binding }));
    process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT = root;
    process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE = "uninstaller";
    const helper = require(modulePath);
    const command = join(root, "tool-cache/nsis/Bin/makensis.exe");
    const temporaryRoot = join(root, "builder-tmp/session");
    const cwd = join(repositoryRoot, "node_modules/app-builder/templates/nsis");
    for (const directory of [join(root, "tool-cache/nsis/Bin"), temporaryRoot, cwd, join(root, "artifacts")]) await mkdir(directory, { recursive: true });
    await writeFile(command, "synthetic compiler; must never execute");
    await writeFile(join(temporaryRoot, "messages.nsh"), `!include "${temporaryRoot}/other.nsh"`);
    await writeFile(join(temporaryRoot, "other.nsh"), "synthetic NSIS text");
    await writeFile(join(root, "artifacts/application-1.2.3-x64.nsis.7z"), "synthetic archive containing signed app");
    const uninstaller = join(root, "artifacts/TiboTattle-1.2.3-Windows-x64.__uninstaller.exe");
    await writeFile(uninstaller, "synthetic uninstaller");
    const options = { command, temporaryRoot, cwd, environment: { NSISDIR: join(root, "tool-cache/nsis") }, uninstaller,
      script: `!include "${temporaryRoot}/messages.nsh"\nFile "${root}/artifacts/application-1.2.3-x64.nsis.7z"`,
      args: ["-WX", `-DAPP_64=${root}/artifacts/application-1.2.3-x64.nsis.7z`,
        `-XOutFile \"${root}/artifacts/TiboTattle-1.2.3-Windows-x64.exe\"`, "-"] };
    await run({ repositoryRoot, root, stateRoot, helper, options });
  } finally {
    if (previousRoot === undefined) delete process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT;
    else process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT = previousRoot;
    if (previousStage === undefined) delete process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE;
    else process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE = previousStage;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test("NSIS checkpoint persists exact unsigned uninstaller and compiler inputs without executing them", async () => {
  await fixture(async ({ root, stateRoot, repositoryRoot, helper, options }) => {
    await helper.recordSubject(options.uninstaller, "uninstaller");
    await assert.rejects(helper.recordSubject(options.uninstaller, "application"), /SUBJECT_INVALID/u);
    await assert.rejects(helper.checkpointMakensis(options), /CHECKPOINT_READY/u);
    const bytes = await readFile(join(stateRoot, "nsis-continuation.json"));
    const checkpoint = JSON.parse(bytes);
    assert.equal(checkpoint.schemaVersion, "tibotattle-windows-nsis-continuation-v1");
    assert.equal(bytes.includes(Buffer.from(repositoryRoot)), false, "checkpoint has only portable paths");
    assert.match(await readFile(join(stateRoot, "installer.nsi"), "utf8"), /@TIBOTATTLE_REPOSITORY_ROOT@/u);
    assert.doesNotMatch(await readFile(join(stateRoot, "installer.nsi"), "utf8"), /builder-tmp/u);
    await rm(options.temporaryRoot, { recursive: true });
    assert.equal(await verifyWindowsNsisContinuation({ root, repositoryRoot, binding, checkpoint }), checkpoint);
    assert.equal(checkpoint.inputs.some((input) => input.path.endsWith(".__uninstaller.exe")), false,
      "uninstaller bytes are independently replaced from a verified signed receipt");
    await assert.rejects(helper.recordSubject(options.uninstaller, "uninstaller"), { code: "EEXIST" });
    await writeFile(join(root, "artifacts/application-1.2.3-x64.nsis.7z"), "changed archive");
    await assert.rejects(verifyWindowsNsisContinuation({ root, repositoryRoot, binding, checkpoint }), /CONTINUATION_CHANGED/u);
  });
});

test("continuation rejects traversal, missing compiler binding, changed source, links and environment injection", async () => {
  await fixture(async ({ root, stateRoot, repositoryRoot, helper, options }) => {
    await assert.rejects(helper.checkpointMakensis({ ...options, environment: { AZURE_TOKEN: "synthetic" } }), /COMPILER_INVALID/u);
    await assert.rejects(helper.checkpointMakensis(options), /CHECKPOINT_READY/u);
    const checkpoint = JSON.parse(await readFile(join(stateRoot, "nsis-continuation.json")));
    for (const change of [
      { sourceRevision: "c".repeat(40) }, { cwd: "node_modules/../../host" },
      { command: "../makensis.exe" }, { environment: { PATH: "synthetic" } },
      { inputs: checkpoint.inputs.filter((entry) => entry.path !== checkpoint.command) },
      { inputs: [...checkpoint.inputs, checkpoint.inputs[0]] },
    ]) {
      await assert.rejects(verifyWindowsNsisContinuation({ root, repositoryRoot, binding, checkpoint: { ...checkpoint, ...change } }), /CONTINUATION_INVALID/u);
    }
    await rm(options.command);
    const external = join(repositoryRoot, "compiler.exe"); await writeFile(external, "synthetic");
    await symlink(external, options.command);
    await assert.rejects(verifyWindowsNsisContinuation({ root, repositoryRoot, binding, checkpoint }), /PATH_INVALID/u);
    assert.equal(hash(await readFile(external)), hash("synthetic"));
  });
});

test("native transfer makes only journal-bound inputs writable and restores modes after failure", async () => {
  await fixture(async ({ root }) => {
    const nativePaths = ["native/windows-filesystem/build/Release/windows_filesystem.node", "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node"];
    const metadataPaths = ["native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json", "electron-runtime-manifest.json"];
    const journal = {
      nativeModes: Object.fromEntries(nativePaths.map((entry) => [entry, 0o444])),
      rebindMetadataModes: Object.fromEntries(metadataPaths.map((entry) => [entry, 0o444])),
    };
    const paths = [...nativePaths, ...metadataPaths].map((entry) => join(root, "app", entry));
    for (const file of paths) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, "synthetic"); await chmod(file, 0o444); }
    const unrelated = join(root, "app/unrelated.json"); await writeFile(unrelated, "synthetic"); await chmod(unrelated, 0o444);
    await assert.rejects(withWritableWindowsNativeInputs({ root, journal }, async () => {
      for (const file of paths) assert.notEqual((await lstat(file)).mode & 0o200, 0);
      assert.equal((await lstat(unrelated)).mode & 0o222, 0);
      throw new Error("synthetic interruption");
    }), /synthetic interruption/u);
    for (const file of paths) assert.equal((await lstat(file)).mode & 0o222, 0);
    await assert.rejects(withWritableWindowsNativeInputs({ root, journal: { ...journal, nativeModes: { ...journal.nativeModes, "../outside": 0o444 } } }, () => assert.fail()), /NATIVE_ACCESS_INVALID/u);
  });
});

test("patched NSIS target checkpoints before final compiler execution after allowing unprivileged uninstaller generation", async () => {
  await fixture(async ({ helper, options }) => {
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
    const sourcePath = appBuilderRequire.resolve("./out/targets/nsis/NsisTarget.js");
    const source = await readFile(sourcePath, "utf8");
    const unused = new Proxy(function unusedDependency() {}, { get: () => unused, apply: () => unused, construct: () => ({}) });
    const module = { exports: {} }; let compilerCalls = 0;
    const context = { module, exports: module.exports, process: { platform: "darwin" }, Buffer,
      require: (name) => {
        if (name === "builder-util") return { spawnAndWriteWithOutput: async () => { compilerCalls += 1; return { stdout: "", stderr: "" }; } };
        if (name === "../../core") return { Target: class Target {} };
        if (name === "../../toolsets/windows") return { getMakeNsisPath: async () => ({ path: options.command, env: options.environment }) };
        if (name === "./nsisUtil") return { nsisTemplatesDir: options.cwd };
        if (name === "./nsisScriptGenerator") return { nsisEscapeString: (value) => value };
        if (name === "./nsisValidation") return { checkMakensisOutput() {} };
        if (name === "synthetic-transfer-hook") return helper;
        return unused;
      } };
    runInNewContext(source, context, { filename: sourcePath });
    const receiver = { options: { warningsAsErrors: true }, packager: {
      config: {}, debugLogger: { isEnabled: false },
      info: { tempDirManager: { rootTempDir: Promise.resolve(options.temporaryRoot) } },
      platformSpecificBuildOptions: { windowsSigningTransferStage: "uninstaller", windowsSigningTransferHook: "synthetic-transfer-hook" },
    } };
    const execute = module.exports.NsisTarget.prototype.executeMakensis.bind(receiver);
    await execute({ BUILD_UNINSTALLER: null }, { OutFile: '"synthetic.exe"' }, options.script);
    assert.equal(compilerCalls, 1);
    await assert.rejects(execute({ UNINSTALLER_OUT_FILE: options.uninstaller }, { OutFile: '"synthetic.exe"' }, options.script), /CHECKPOINT_READY/u);
    assert.equal(compilerCalls, 1, "final compiler waits for an independently signed uninstaller");
  });
});

test("final update metadata and gzip blockmap bind the unchanged final signed installer", async () => {
  await fixture(async ({ root }) => {
    const leaf = "TiboTattle-1.2.3-Windows-x64.exe";
    const file = join(root, "artifacts", leaf);
    const bytes = Buffer.concat([Buffer.from("synthetic signed PE header"), Buffer.alloc(100000, 0x5a), Buffer.from("synthetic signature")]);
    await writeFile(file, bytes);
    const result = await finalizeWindowsSigningStageMetadata({ root, binding });
    assert.deepEqual(await readFile(file), bytes, "building the sidecar cannot append to the signed executable");
    assert.equal(result.installerSha256, hash(bytes));
    assert.equal(result.installerSha512, createHash("sha512").update(bytes).digest("base64"));
    const blockmapBytes = await readFile(`${file}.blockmap`);
    assert.equal(hash(blockmapBytes), result.blockmapSha256);
    const blockmap = JSON.parse(gunzipSync(blockmapBytes));
    assert.equal(blockmap.files.flatMap((entry) => entry.sizes).reduce((sum, size) => sum + size, 0), bytes.length);
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const metadata = builderRequire("js-yaml").load(await readFile(join(root, "artifacts/latest.yml"), "utf8"));
    assert.deepEqual(metadata.files, [{ url: leaf, sha512: result.installerSha512, size: bytes.length }]);
    assert.equal(metadata.path, leaf); assert.equal(metadata.sha512, result.installerSha512);
    await assert.rejects(finalizeWindowsSigningStageMetadata({ root, binding }), { code: "EEXIST" });
  });
});

test("NSIS continuation preserves pinned zero-exit diagnostic and installer completeness checks", async () => {
  await fixture(async ({ root, stateRoot, repositoryRoot, helper, options }) => {
    await assert.rejects(helper.checkpointMakensis(options), /CHECKPOINT_READY/u);
    const checkpoint = JSON.parse(await readFile(join(stateRoot, "nsis-continuation.json")));
    const context = { root, binding };
    const installerPath = join(root, "artifacts/TiboTattle-1.2.3-Windows-x64.exe");
    const archiveBytes = await readFile(join(root, "artifacts/application-1.2.3-x64.nsis.7z"));
    const success = { status: 0, stdout: "synthetic build completed", stderr: "" };
    const validate = (result = success, selected = checkpoint) => validateWindowsNsisCompilerResult({
      context, checkpoint: selected, result, repositoryRoot,
    });
    await writeFile(installerPath, Buffer.alloc(archiveBytes.length + 128));
    await assert.rejects(validate({ ...success, stderr: "  Error: synthetic disk full\n" }), /COMPILER_OUTPUT_INVALID/u);
    await assert.rejects(validate({ ...success, status: 1 }), /COMPILER_FAILED/u);
    await rm(installerPath);
    await assert.rejects(validate(), /INSTALLER_INCOMPLETE/u);
    await writeFile(installerPath, Buffer.alloc(archiveBytes.length - 1));
    await assert.rejects(validate(), /INSTALLER_INCOMPLETE/u);
    await writeFile(installerPath, Buffer.alloc(archiveBytes.length + 128));
    await assert.doesNotReject(validate());
    await assert.rejects(validate(success, { ...checkpoint, args: checkpoint.args.filter((argument) => !argument.startsWith("-DAPP_64=")) }), /ARCHIVE_BINDING_INVALID/u);
    await writeFile(join(root, "artifacts/application-1.2.3-x64.nsis.7z"), "changed archive");
    await assert.rejects(validate(), /CONTINUATION_CHANGED/u);
  });
});
