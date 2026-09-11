import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { release } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { extractEsmImports } from "./esm-imports.mjs";

export const QUALIFICATION_TEST_FILES = Object.freeze([
  "test/export-paginated-reset.test.js",
  "test/export-paginated-ancestry.test.js",
  "test/local-unified-index.test.js",
]);
const PROFILE = "release-synthetic-admission-inputs-v1";
const REVIEW_MANIFEST = "config/release-admission-profile.json";
const ROOTS = ["src", "packages", "contracts", "schemas", "generated", "config"];
const FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "scripts/qualify-release.mjs", "scripts/lib/release-qualification-cache.mjs",
  "scripts/lib/release-qualification-inputs.mjs", "scripts/lib/release-operation.mjs",
  "scripts/lib/esm-imports.mjs", "scripts/r7-materialized-boundary-worker.js",
  "scripts/r7-resource-benchmark-worker.js", ...QUALIFICATION_TEST_FILES];
const MAX_FILES = 30_000;
const MAX_BYTES = 512 * 1024 * 1024;
const ENVIRONMENT_KEYS = new Set(["LANG", "LC_ALL", "TZ", "NO_COLOR", "FORCE_COLOR",
  "NODE_ENV", "UV_THREADPOOL_SIZE", "timeoutMs", "umask"]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const canonicalJson = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

/** A deliberately broad local-only admission fingerprint, not an R7 receipt.
 * Hash installed dependency bytes, not merely their declared lockfile versions.
 * Unknown computed imports/out-of-profile dependencies disable reuse. A new
 * source file is included automatically; documentation and hosted apps are not.
 */
export async function computeQualificationInputs({ repositoryRoot, runtimePath = process.execPath, environment = {} } = {}) {
  try {
    const root = await realpath(resolve(repositoryRoot));
    if (root !== resolve(repositoryRoot)) fail("QUALIFICATION_ROOT_UNSAFE");
    if (!environment || Array.isArray(environment) || typeof environment !== "object"
        || Object.entries(environment).some(([key, value]) => !ENVIRONMENT_KEYS.has(key)
          || typeof value !== "string" || value.length > 4096)) fail("QUALIFICATION_ENVIRONMENT_INVALID");
    if (Object.keys(environment).length > 64) fail("QUALIFICATION_ENVIRONMENT_INVALID");
    const executable = await realpath(runtimePath);
    // Version metadata below describes this process, never an unexecuted binary.
    if (executable !== await realpath(process.execPath)) fail("QUALIFICATION_RUNTIME_MISMATCH");
    const records = new Map();
    const codeFiles = [];
    let totalBytes = 0;
    let unknownDependencyCount = 0;
    const dependencies = new Map();
    let reviewedBytes;
    const digestFile = async (path, label, { code = false } = {}) => {
      if (records.has(label)) return;
      const before = await lstat(path);
      if (!before.isFile() || (inside(root, path) && !path.includes(`${sep}node_modules${sep}`) && before.nlink !== 1)
          || await realpath(dirname(path)) !== dirname(path)) fail("QUALIFICATION_INPUT_UNSAFE");
      if (label === REVIEW_MANIFEST && before.size > 4096) fail("QUALIFICATION_REVIEW_INVALID");
      if (records.size >= MAX_FILES || totalBytes + before.size > MAX_BYTES) fail("QUALIFICATION_INPUT_LIMIT");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash("sha256");
      const chunks = [];
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) fail("QUALIFICATION_INPUT_CHANGED");
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          if (position > before.size) fail("QUALIFICATION_INPUT_CHANGED");
          hash.update(buffer.subarray(0, bytesRead));
          if (code || label === REVIEW_MANIFEST) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const after = await handle.stat();
        const current = await lstat(path);
        if (position !== before.size || before.ino !== current.ino || before.dev !== current.dev
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) fail("QUALIFICATION_INPUT_CHANGED");
      } finally { await handle.close(); }
      totalBytes += before.size;
      records.set(label, { sha256: hash.digest("hex"), size: before.size, mode: before.mode & 0o777 });
      if (code) codeFiles.push({ path, source: Buffer.concat(chunks).toString("utf8") });
      if (label === REVIEW_MANIFEST) reviewedBytes = Buffer.concat(chunks);
    };
    const walk = async (directory, prefix, external = false) => {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) fail("QUALIFICATION_INPUT_UNSAFE");
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const path = join(directory, entry.name);
        const label = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(path, label, external);
        else if (entry.isSymbolicLink()) {
          // Package managers may link a package root; links *inside* source or
          // package contents are not accepted as an invisible dependency edge.
          fail("QUALIFICATION_INPUT_UNSAFE");
        } else if (entry.isFile()) {
          if (!external && (entry.name === "AGENTS.md" || /\.(?:md|mdx)$/u.test(entry.name))) continue;
          await digestFile(path, label, { code: !external && /\.(?:js|mjs)$/u.test(entry.name) });
        } else fail("QUALIFICATION_INPUT_UNSAFE");
      }
    };
    for (const directory of ROOTS) await walk(join(root, directory), directory);
    for (const name of FILES) await digestFile(join(root, name), name, { code: /\.(?:js|mjs)$/u.test(name) });

    const resolvePackage = async (name, from) => {
      const require = createRequire(join(from, "qualification-resolver.cjs"));
      for (const search of require.resolve.paths(name) ?? []) {
        const candidate = join(search, name);
        try {
          const selected = await realpath(candidate);
          const manifestFile = join(selected, "package.json");
          if ((await lstat(manifestFile)).size > 1024 * 1024) fail("QUALIFICATION_DEPENDENCY_INVALID");
          const handle = await open(manifestFile, constants.O_RDONLY | constants.O_NOFOLLOW);
          let manifest;
          try { manifest = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
          if (manifest.name !== name) fail("QUALIFICATION_DEPENDENCY_INVALID");
          return { selected, manifest };
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return null;
    };
    const visitPackage = async (name, from, optional = false) => {
      const resolved = await resolvePackage(name, from);
      if (!resolved) {
        if (!optional) unknownDependencyCount += 1;
        records.set(`missing:${name}:${relative(root, from)}`, { optional });
        return;
      }
      if (name.startsWith("@app-usagemonitor/")) {
        if (!inside(join(root, "packages"), resolved.selected)) fail("QUALIFICATION_WORKSPACE_DEPENDENCY_UNSAFE");
        return;
      }
      if (dependencies.has(resolved.selected)) return;
      const label = `dependency:${dependencies.size}:${name}`;
      dependencies.set(resolved.selected, label);
      await walk(resolved.selected, label, true);
      const declared = { ...resolved.manifest.peerDependencies, ...resolved.manifest.dependencies, ...resolved.manifest.optionalDependencies };
      for (const child of Object.keys(declared).sort()) await visitPackage(child, resolved.selected,
        Object.hasOwn(resolved.manifest.optionalDependencies ?? {}, child)
          || resolved.manifest.peerDependenciesMeta?.[child]?.optional === true);
    };
    // Scan all conservatively included source, not only today's reachable
    // imports. Any new literal edge must resolve inside the profile or an
    // installed package whose entire declared dependency closure is hashed.
    for (const { path, source } of codeFiles) {
      for (const { specifier } of await extractEsmImports(source, { sourceName: "qualification-input" })) {
        if (typeof specifier !== "string") { unknownDependencyCount += 1; continue; }
        if (isBuiltin(specifier)) continue;
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(path), specifier);
          if (!inside(root, target) || !records.has(relative(root, target).split(sep).join("/"))) unknownDependencyCount += 1;
        } else if (specifier.startsWith("/") || specifier.includes(":")) unknownDependencyCount += 1;
        else await visitPackage(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0], dirname(path));
      }
    }
    await digestFile(executable, "runtime-executable");
    const runtime = { executableSha256: records.get("runtime-executable").sha256,
      versions: { ...process.versions }, platform: process.platform, arch: process.arch, osRelease: release() };
    if (!reviewedBytes) fail("QUALIFICATION_REVIEW_INVALID");
    const review = JSON.parse(reviewedBytes);
    if (!review || Array.isArray(review) || Object.keys(review).sort().join() !== "profile,reviewedExecutableDigest,schema"
        || review.schema !== 1 || review.profile !== PROFILE || !/^[a-f0-9]{64}$/u.test(review.reviewedExecutableDigest ?? "")) {
      fail("QUALIFICATION_REVIEW_INVALID");
    }
    // New source may introduce filesystem/subprocess inputs ESM cannot find.
    // Run it fresh, but do not mint reusable proof before profile review.
    // Schema/data changes invalidate the ordinary key, not executable review.
    const executableRecords = [...records].filter(([name]) => name !== REVIEW_MANIFEST
      && (name.startsWith("dependency:") || name.startsWith("missing:") || name === "runtime-executable"
        || name.endsWith("package.json") || !name.endsWith(".json")))
      .sort(([a], [b]) => a.localeCompare(b));
    const executableDigest = createHash("sha256").update(canonicalJson({ profile: PROFILE, records: executableRecords })).digest("hex");
    const executableReviewed = executableDigest === review.reviewedExecutableDigest;
    const payload = { profile: PROFILE, runtime, environment, records: [...records].sort(([a], [b]) => a.localeCompare(b)) };
    return { profile: PROFILE, digest: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
      fileCount: records.size, dependencyCount: dependencies.size, runtime,
      executableDigest, executableReviewed,
      reusable: unknownDependencyCount === 0 && executableReviewed, unknownDependencyCount };
  } catch (error) {
    if (error.code?.startsWith("QUALIFICATION_")) throw error;
    fail("QUALIFICATION_INPUTS_UNAVAILABLE");
  }
}
