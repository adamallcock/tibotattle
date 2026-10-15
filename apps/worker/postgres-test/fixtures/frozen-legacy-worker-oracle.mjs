import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const LEGACY_ORACLE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_ROOTS = Object.freeze([
  "apps/worker/src", "apps/worker/package.json", "apps/worker/package-lock.json",
  "apps/worker/migrations", "apps/worker/typed-ingestion-migrations",
  "apps/worker/ingestion-bridge-migrations", "apps/worker/typed-v11-admission-migrations",
  "apps/worker/typed-v1-admission-migrations", "apps/worker/ingestion-isolation-migrations",
  "packages/accounting", "packages/telemetry-contract", "packages/quota-analysis",
]);

export function legacyOracleBlobId(content) {
  const body = Buffer.from(content);
  return createHash("sha1").update(`blob ${body.byteLength}\0`).update(body).digest("hex");
}

// Read objects only: no worktree, ref, index, network, or repository mutation.
function gitRead(repositoryRoot, args, input = "") {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["--no-optional-locks", "-C", repositoryRoot, ...args],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } });
    const chunks = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("FROZEN_LEGACY_ORACLE_GIT_TIMEOUT");
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        failure = new Error("FROZEN_LEGACY_ORACLE_GIT_SIZE_LIMIT");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    // Git failure details can contain private repository paths; do not retain them.
    child.stderr.resume();
    child.on("error", (error) => { failure = error; });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new Error("FROZEN_LEGACY_ORACLE_GIT_UNAVAILABLE"));
      else resolveResult(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

function safeRelative(path) {
  assert.ok(typeof path === "string" && path.length > 0 && !isAbsolute(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && !/[\0\r\n\\]/u.test(path), "FROZEN_LEGACY_ORACLE_PATH_INVALID");
  return path;
}

async function writeExclusive(root, path, content) {
  const target = join(root, safeRelative(path));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
}

function unpackPinnedNpmArchive(archive, integrity) {
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, integrity,
    "the frozen external dependency matches its historical lock integrity");
  const tar = gunzipSync(archive, { maxOutputLength: MAX_BYTES });
  const entries = new Map();
  let offset = 0;
  for (; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").split("\0")[0];
    assert.equal(header.subarray(345, 500).every((byte) => byte === 0), true,
      "FROZEN_LEGACY_ORACLE_NPM_PREFIX_UNSUPPORTED");
    assert.ok(header[156] === 0 || header[156] === 48, "only regular npm package files are admitted");
    const sizeText = header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim();
    assert.match(sizeText, /^[0-7]+$/u);
    const size = Number.parseInt(sizeText, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= MAX_BYTES
      && offset + 512 + size <= tar.length, "FROZEN_LEGACY_ORACLE_NPM_SIZE_INVALID");
    assert.ok(name.startsWith("package/"), "FROZEN_LEGACY_ORACLE_NPM_ROOT_INVALID");
    const path = safeRelative(name.slice("package/".length));
    assert.equal(entries.has(path), false, "FROZEN_LEGACY_ORACLE_NPM_DUPLICATE");
    entries.set(path, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.size > 0 && entries.size < 100 && tar.subarray(offset).every((byte) => byte === 0),
    "FROZEN_LEGACY_ORACLE_NPM_TRAILER_INVALID");
  return entries;
}

/** A closed historical source capsule. Missing local Git/npm objects fail honestly;
 * it never fetches, installs, links to a current workspace package, or rewrites pins. */
export async function createFrozenLegacyWorkerOracle(currentWorkerRoot, pinned) {
  assert.equal(pinned.commit, LEGACY_ORACLE_COMMIT.slice(0, 8));
  const repositoryRoot = resolve(currentWorkerRoot, "../..");
  const tree = (await gitRead(repositoryRoot,
    ["ls-tree", "-rz", LEGACY_ORACLE_COMMIT, "--", ...SOURCE_ROOTS])).toString("utf8");
  const files = tree.split("\0").filter(Boolean).map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(record);
    assert.ok(match, "the frozen capsule contains only tracked regular source files");
    return { blob: match[2], production: safeRelative(match[3]) };
  });
  assert.ok(files.length > 0 && files.length < 1_000, "FROZEN_LEGACY_ORACLE_FILE_COUNT_INVALID");
  const objects = await gitRead(repositoryRoot, ["cat-file", "--batch"],
    files.map((file) => file.blob).join("\n") + "\n");
  const contents = new Map();
  let offset = 0;
  for (const file of files) {
    const end = objects.indexOf(10, offset);
    assert.ok(end > offset);
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(objects.subarray(offset, end).toString("ascii"));
    assert.ok(match && match[1] === file.blob, "FROZEN_LEGACY_ORACLE_OBJECT_INVALID");
    const size = Number(match[2]);
    assert.ok(Number.isSafeInteger(size) && size <= MAX_BYTES && end + 1 + size < objects.length);
    const content = objects.subarray(end + 1, end + 1 + size);
    assert.equal(legacyOracleBlobId(content), file.blob);
    assert.equal(objects[end + 1 + size], 10);
    contents.set(file.production, content);
    offset = end + 2 + size;
  }
  assert.equal(offset, objects.length);
  for (const [path, pin] of Object.entries(pinned.sources)) {
    safeRelative(path);
    assert.ok(pin.production === `apps/worker/${path}` || pin.production.startsWith("packages/"));
    assert.equal(legacyOracleBlobId(contents.get(pin.production)), pin.blob, `${path} retains its immutable oracle pin`);
  }
  const lock = JSON.parse(contents.get("apps/worker/package-lock.json"));
  const cache = resolve(process.env.npm_config_cache || join(homedir(), ".npm"));
  const dependencies = [];
  for (const [name, version] of [["runcost", "0.2.1"], ["jsonc-parser", "3.3.1"]]) {
    const dependency = lock.packages[`node_modules/${name}`];
    assert.equal(dependency.version, version);
    assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    const digest = Buffer.from(dependency.integrity.slice(7), "base64").toString("hex");
    const archivePath = join(cache, "_cacache", "content-v2", "sha512",
      digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
    const metadata = await lstat(archivePath);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= MAX_BYTES,
      "FROZEN_LEGACY_ORACLE_NPM_CACHE_INVALID");
    const npmEntries = unpackPinnedNpmArchive(await readFile(archivePath), dependency.integrity);
    const npmManifest = JSON.parse(npmEntries.get("package.json"));
    assert.equal(npmManifest.name, name);
    assert.equal(npmManifest.version, dependency.version);
    assert.equal(Object.keys(npmManifest.dependencies ?? {}).length, 0);
    dependencies.push({ name, version, integrity: dependency.integrity, entries: npmEntries });
  }

  const capsule = await mkdtemp(join(tmpdir(), "tibotattle-frozen-legacy-oracle-"));
  await chmod(capsule, 0o700);
  const identity = await lstat(capsule);
  const real = await realpath(capsule);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink()
    && identity.uid === process.getuid() && (identity.mode & 0o077) === 0);
  const workerRoot = join(real, "apps", "worker");
  const dispose = async () => {
    const current = await lstat(capsule);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.uid === identity.uid
      && current.dev === identity.dev && current.ino === identity.ino && await realpath(capsule) === real,
    "only this test's unchanged private capsule can be removed");
    await rm(capsule, { recursive: true });
  };
  try {
    for (const [production, content] of contents) {
      const path = production.startsWith("packages/")
        ? `apps/worker/node_modules/@app-usagemonitor/${production.slice("packages/".length)}` : production;
      await writeExclusive(capsule, path, content);
    }
    for (const dependency of dependencies) {
      for (const [path, content] of dependency.entries) {
        await writeExclusive(capsule, `apps/worker/node_modules/${dependency.name}/${path}`, content);
      }
    }
    await writeExclusive(capsule, "oracle-provenance.json", JSON.stringify({
      commit: LEGACY_ORACLE_COMMIT, sourceFiles: files.length,
      npmDependencies: dependencies.map(({ name, version, integrity }) => ({ name, version, integrity })),
    }, null, 2) + "\n");
    return Object.freeze({ workerRoot, dispose, sourceFiles: files.length });
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function frozenLegacyOracleResolutionGuard(workerRoot) {
  return {
    name: "frozen-legacy-oracle-source-isolation",
    enforce: "pre",
    load(id) {
      if (isAbsolute(id)) {
        const path = relative(workerRoot, id.split("?")[0]);
        assert.ok(path !== ".." && !path.startsWith("../") && !isAbsolute(path),
          "the frozen oracle cannot import a current or external source file");
      }
      return null;
    },
  };
}
