import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep, win32 } from "node:path";
import test from "node:test";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { verifyWindowsNormalCandidateSmokePackage } from "../scripts/smoke-electron-windows-normal-candidate.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const loaded = builderRequire("@electron/asar");
const asar = loaded.default ?? loaded;
const ROOT = String.raw`C:\archive-cache-fixture`;
const APP = win32.join(ROOT, "installed", "TiboTattle.exe");
const ARCHIVE = win32.join(ROOT, "installed", "resources", "app.asar");
const PRELOAD = "apps/electron/preload.cjs";
const BINDING = "native/windows-filesystem/build/Release/windows_filesystem.node";
const KEYTAR = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const digestBytes = (bytes) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

async function archiveFixture(context, { successorPackage } = {}) {
  assert.equal(builderRequire("@electron/asar/package.json").version, "3.4.1");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "windows-asar-replacement-")));
  const local = (path) => {
    const relative = win32.relative(ROOT, path);
    assert.ok(relative && !win32.isAbsolute(relative) && !relative.split(win32.sep).includes(".."));
    return join(directory, ...relative.split(win32.sep));
  };
  const archive = local(ARCHIVE);
  context.after(async () => {
    asar.uncache(archive);
    await rm(directory, { recursive: true, force: true });
  });
  const createCandidate = async (name, version, sourceRevision, padding, archivePackage) => {
    const stagedAppPath = win32.join(ROOT, name);
    const stage = local(stagedAppPath);
    const sourceCandidatePath = win32.join(ROOT, `${name}-source-candidate.json`);
    const distribution = createProductionDistributionMetadata({
      buildNumber: name === "predecessor" ? "12345" : "12346",
      sourceRevision, target: "win32-x64",
    });
    const manifest = { version, tibotattleDistribution: distribution };
    const preload = Buffer.from(`module.exports = ${JSON.stringify(version)};\n`);
    const files = new Map([
      ["a-padding.txt", padding],
      ["package.json", JSON.stringify(manifest)],
      [PRELOAD, preload],
      [BINDING, `synthetic-binding-${version}`],
      [`${BINDING}.manifest.json`, JSON.stringify({ fixtureVersion: version })],
      [KEYTAR, `synthetic-keytar-${version}`],
      ["electron-runtime-manifest.json", JSON.stringify({ files: [{ path: PRELOAD, ...digestBytes(preload) }] })],
    ]);
    for (const [relative, bytes] of files) {
      const target = join(stage, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await writeFile(local(sourceCandidatePath), JSON.stringify({
      schemaVersion: "tibotattle-electron-production-source-candidate-v1",
      status: "production_source_staged", target: "win32-x64", sourceRevision, version,
      stagingDirectory: ".release-build/electron-production/win32-x64/app",
      builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
      updaterEnabled: true, signingRequired: true, signingPerformed: false,
      publishingPerformed: false, windowsRuntimeQualification: "required",
    }));
    const packageInput = join(directory, `${name}-archive-input`);
    await cp(stage, packageInput, { recursive: true });
    if (archivePackage !== undefined) await writeFile(join(packageInput, "package.json"), archivePackage);
    const packagedArchive = join(directory, `${name}.asar`);
    await asar.createPackage(packageInput, packagedArchive);
    return { version, stage, packagedArchive,
      options: { appPath: APP, stagedAppPath, sourceCandidatePath, sourceRevision } };
  };
  const predecessor = await createCandidate("predecessor", "0.1.26", "1".repeat(40), "old");
  const successor = await createCandidate("successor", "0.1.27", "2".repeat(40), "new".repeat(2048), successorPackage);
  const install = async (candidate) => {
    await mkdir(dirname(archive), { recursive: true });
    await copyFile(candidate.packagedArchive, archive);
    await writeFile(local(APP), `synthetic-executable-${candidate.version}`);
    for (const relative of [BINDING, KEYTAR]) {
      const target = join(`${archive}.unpacked`, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(candidate.stage, ...relative.split("/")), target);
    }
  };
  const archiveApi = {
    uncache(path) {
      assert.equal(path, ARCHIVE, "invalidate only the archive being verified");
      return asar.uncache(local(path));
    },
    extractFile(path, member) {
      assert.equal(path, ARCHIVE);
      return asar.extractFile(local(path), member.replaceAll(win32.sep, sep));
    },
  };
  const verify = (candidate, selectedAsar = archiveApi) => verifyWindowsNormalCandidateSmokePackage(candidate.options, {
    platform: "win32", architecture: "x64", asar: selectedAsar,
    readJsonFile: async (path) => JSON.parse(await readFile(local(path), "utf8")),
    digest: async (path) => digestBytes(await readFile(local(path))),
    verifyPaths: async ({ appPath, stagedAppPath, resourcesPath, asarPath, unpackedPath }) => {
      for (const [path, directoryExpected] of [[appPath, false], [stagedAppPath, true],
        [resourcesPath, true], [asarPath, false], [unpackedPath, true]]) {
        const info = await lstat(local(path));
        assert.equal(info.isSymbolicLink(), false);
        assert.equal(directoryExpected ? info.isDirectory() : info.isFile(), true);
      }
    },
  });
  return { archive, archiveApi, predecessor, successor, install, verify };
}

test("Windows verification reads replacement ASAR bytes at the same installed path", async (context) => {
  const fixture = await archiveFixture(context);
  await fixture.install(fixture.predecessor);
  const before = await fixture.verify(fixture.predecessor);
  assert.deepEqual(await fixture.verify(fixture.predecessor), before, "unchanged predecessor can be reverified");
  await fixture.install(fixture.successor);
  // The real pinned reader still has predecessor offsets after the file swap.
  assert.throws(() => JSON.parse(asar.extractFile(fixture.archive, "package.json").toString("utf8")));
  const installedBytes = await readFile(fixture.archive);
  const after = await fixture.verify(fixture.successor);
  assert.equal(after.sourceRevision, fixture.successor.options.sourceRevision);
  assert.equal(after.artifactSha256, digestBytes(installedBytes).sha256);
  assert.notEqual(after.artifactSha256, before.artifactSha256);
  assert.notEqual(after.executableSha256, before.executableSha256);
  assert.notDeepEqual(after.native, before.native);
  assert.deepEqual(await fixture.verify(fixture.successor), after, "unchanged successor can be reverified");
  assert.deepEqual(await readFile(fixture.archive), installedBytes, "verification never changes archive bytes");
  await assert.rejects(fixture.verify(fixture.predecessor), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_METADATA_INVALID",
  });
});

test("Windows verification rejects a malformed successor manifest after replacing a cached archive", async (context) => {
  const fixture = await archiveFixture(context, { successorPackage: "{invalid-package-json" });
  await fixture.install(fixture.predecessor);
  await fixture.verify(fixture.predecessor);
  await fixture.install(fixture.successor);
  const installedBytes = await readFile(fixture.archive);
  await assert.rejects(fixture.verify(fixture.successor), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID",
  });
  assert.deepEqual(await readFile(fixture.archive), installedBytes);
});

test("Windows verification rejects a malformed successor archive instead of retaining the old index", async (context) => {
  const fixture = await archiveFixture(context);
  await fixture.install(fixture.predecessor);
  await fixture.verify(fixture.predecessor);
  await fixture.install(fixture.successor);
  // A complete size pickle followed by a missing, bounded 12-byte header.
  await writeFile(fixture.archive, Buffer.from([4, 0, 0, 0, 12, 0, 0, 0]));
  await assert.rejects(fixture.verify(fixture.successor), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID",
  });
});

for (const cacheState of ["missing", "throws"]) {
  test(`Windows verification fails closed when the archive cache API ${cacheState}`, async (context) => {
    const fixture = await archiveFixture(context);
    await fixture.install(fixture.predecessor);
    let memberReads = 0;
    const selectedAsar = {
      ...(cacheState === "missing" ? {} : { uncache() { throw new Error("private archive path"); } }),
      extractFile() { memberReads += 1; throw new Error("archive read must not be reached"); },
    };
    await assert.rejects(fixture.verify(fixture.predecessor, selectedAsar), (error) => {
      assert.equal(error.code, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_ASAR_UNAVAILABLE");
      assert.equal(error.message, error.code);
      return true;
    });
    assert.equal(memberReads, 0);
  });
}
