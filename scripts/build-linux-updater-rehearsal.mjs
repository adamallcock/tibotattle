#!/usr/bin/env node
/** Two private AppImages from the normal staged product; never publishes. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStagedElectronRuntime } from "./build-electron-runtime.mjs";
import { validateProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const fail = (code) => { throw Object.assign(new Error(code), { code: `LINUX_UPDATER_PAIR_${code}` }); };
export function linuxUpdaterRehearsalVersions(version) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version ?? "")) fail("VERSION_INVALID");
  const parts = version.split(".").map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n)) || parts[2] >= 999999) fail("VERSION_INVALID");
  return { current: version, next: `${parts[0]}.${parts[1]}.${parts[2] + 1}` };
}
export async function linuxAppImageIdentity(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
      || details.size < 4096 || details.size > 1024 ** 3) fail("APPIMAGE_INVALID");
  const handle = await open(path, "r");
  const header = Buffer.alloc(64);
  try { await handle.read(header, 0, 64, 0); } finally { await handle.close(); }
  if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      || header[4] !== 2 || header.readUInt16LE(18) !== 62
      || !header.subarray(8, 11).equals(Buffer.from([65, 73, 2]))) fail("APPIMAGE_INVALID");
  const sha256 = createHash("sha256"); const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); }
  return { bytes: details.size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}
async function runBuilder(args, environment) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [require.resolve("electron-builder/cli.js"), ...args], {
      cwd: ROOT, env: environment, stdio: "ignore", shell: false,
    });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("PAIR_BUILD_TIMEOUT")); }, 600000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error("PAIR_BUILD_FAILED")); });
  });
}
export async function buildLinuxUpdaterRehearsal() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.version !== "v26.2.0") fail("NATIVE_HOST_REQUIRED");
  const stage = join(ROOT, ".release-build/electron-production/linux-x64/app");
  const candidate = JSON.parse(await readFile(join(dirname(stage), "production-source-candidate.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
  if (candidate.status !== "production_source_staged" || candidate.target !== "linux-x64"
      || !/^[0-9a-f]{40}$/u.test(candidate.sourceRevision ?? "") || candidate.version !== metadata.version) fail("CANDIDATE_INVALID");
  validateProductionDistributionMetadata(metadata.tibotattleDistribution, { platform: "linux", architecture: "x64" });
  if (metadata.tibotattleDistribution.sourceRevision !== candidate.sourceRevision) fail("CANDIDATE_INVALID");
  await verifyStagedElectronRuntime({ output: stage, target: "linux-x64", version: candidate.version });
  const root = join(ROOT, ".release-build/electron-linux-updater-rehearsal");
  await mkdir(root, { mode: 0o700 });
  const versions = linuxUpdaterRehearsalVersions(candidate.version);
  const images = {};
  for (const role of ["current", "next"]) {
    const output = join(root, role);
    // Only test package version/output differ. Normal app source, updater,
    // production fixed feed, fuses and beforePack validation remain intact.
    await runBuilder(["--config", "apps/electron/electron-builder.production.config.cjs",
      `--config.directories.output=${output}`, `--config.extraMetadata.version=${versions[role]}`,
      "--linux", "AppImage", "--x64", "--publish", "never"], {
      ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false",
      TIBOTATTLE_ELECTRON_TARGET: "linux-x64", TIBOTATTLE_ELECTRON_VERSION: candidate.version,
      TIBOTATTLE_ELECTRON_SOURCE_REVISION: candidate.sourceRevision,
      TIBOTATTLE_ELECTRON_BUILD_NUMBER: candidate.buildNumber,
    });
    const entries = (await readdir(output)).filter((name) => name.endsWith(".AppImage"));
    if (entries.length !== 1) fail("APPIMAGE_SET_INVALID");
    const asarPath = join(output, "linux-unpacked/resources/app.asar");
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar");
    const packaged = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
    if (packaged.version !== versions[role] || packaged.main !== metadata.main
        || JSON.stringify(packaged.tibotattleDistribution) !== JSON.stringify(metadata.tibotattleDistribution)) fail("PACKAGED_METADATA_MISMATCH");
    const asarHash = createHash("sha256");
    for await (const chunk of createReadStream(asarPath)) asarHash.update(chunk);
    const asarSha256 = asarHash.digest("hex");
    images[role] = { asarSha256, file: `${role}/${entries[0]}`, version: versions[role], ...await linuxAppImageIdentity(join(output, entries[0])) };
  }
  const receipt = { schemaVersion: "tibotattle-linux-real-updater-pair-v1", sourceRevision: candidate.sourceRevision,
    scope: "private_test_version_override", feed: metadata.tibotattleDistribution.updateFeed, images, publication: "not_performed" };
  await writeFile(join(root, "pair.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("ARGUMENT_INVALID");
  buildLinuxUpdaterRehearsal().then((receipt) => console.log(JSON.stringify(receipt))).catch((error) => {
    console.error(error.code?.startsWith("LINUX_UPDATER_PAIR_") ? error.code : "LINUX_UPDATER_PAIR_FAILED"); process.exitCode = 1;
  });
}
