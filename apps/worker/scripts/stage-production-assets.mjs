import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
/**
 * Production staging consumes the output of build-public-release-site.js,
 * never the mutable browser source tree. The builder maps community.html to
 * index.html and removes local/admin files before this handoff.
 */
export const PRODUCTION_ASSET_SOURCE = join(
  REPOSITORY_ROOT,
  ".release-build",
  "public-release-site",
);
export const PRODUCTION_ASSET_DIRECTORY = join(
  REPOSITORY_ROOT,
  ".release-build",
  "worker-assets",
);

const RELEASE_MANIFEST_BASENAME = "release-site-manifest.json";
const PUBLIC_RELEASE_ASSET_BASENAMES = Object.freeze([
  "community-view.js",
  "community.js",
  "i18n.generated.js",
  "index.html",
  "localization.js",
  "robots.txt",
  "social-preview.png",
  "styles.css",
  // The reviewed app mark is a public brand asset of the landing page, not a
  // loopback/dashboard surface. It must travel with the generated page.
  "tibotattle-icon.png",
  "ui-format.js",
]);
const PUBLIC_RELEASE_ASSET_SET = new Set(PUBLIC_RELEASE_ASSET_BASENAMES);
const LOCAL_ONLY_BASENAMES = Object.freeze([
  "admin-client.js",
  "admin.css",
  "admin.html",
  "admin.js",
  "app.js",
  "community.html",
  "data-client.js",
  "install-cta.js",
  "navigation.js",
]);
const PUBLIC_ROUTE_MARKERS = Object.freeze([
  "./app.js",
  "/app.js",
  '"app.js"',
  "'app.js'",
  "./data-client.js",
  "/data-client.js",
  '"data-client.js"',
  "'data-client.js'",
  "./navigation.js",
  "/navigation.js",
  '"navigation.js"',
  "'navigation.js'",
  "./admin.js",
  "/admin.js",
  '"admin.js"',
  "'admin.js'",
  "./admin-client.js",
  "/admin-client.js",
  '"admin-client.js"',
  "'admin-client.js'",
  "./admin.css",
  "/admin.css",
  '"admin.css"',
  "'admin.css'",
  "./admin.html",
  "/admin.html",
  '"admin.html"',
  "'admin.html'",
  "./install-cta.js",
  "/install-cta.js",
  '"install-cta.js"',
  "'install-cta.js'",
  'id="refresh-button"',
  'id="connect-community"',
  'id="open-installed-app"',
  'id="contribution-form"',
  'id="identity-signin"',
  'id="identity-google-signin"',
  'id="identity-apple-signin"',
  'id="sign-in"',
  'id="signin"',
  'id="admin"',
  'id="app-open"',
  'id="contribution-',
  'id="identity-',
  'id="sign-in-',
  'id="admin-',
  'id="app-open-',
  'name="contribution',
  'href="#contribution',
  'href="#sign-in',
  'href="#signin',
  'href="#admin',
  'href="#app-open',
  "usage-monitor-semantic-open-target",
  "usagemonitor://",
  "/app-open",
  "/sign-in",
  "/signin",
  "/contribution",
  "/admin",
]);

function runGit(repositoryRoot, arguments_) {
  const result = spawnSync("/usr/bin/git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect the checked-out production assets.");
  }
  return result.stdout;
}

async function requireCleanReleaseTree(repositoryRoot, git) {
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
      .trim() !== "") {
    throw new Error(
      "Production deployment requires a clean, committed release tree; stage or discard no files automatically.",
    );
  }
}

async function regularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing or cannot be inspected.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return metadata;
}

async function fileManifest(root) {
  const rows = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Generated public output contains an unsafe filesystem entry.");
      }
      const bytes = await readFile(path);
      rows.push({
        path: relative(root, path).split(sep).join("/"),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await visit(root);
  return rows;
}

function safeManifestPath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function verifiedGeneratedFiles(sourceDirectory) {
  const manifestPath = join(sourceDirectory, RELEASE_MANIFEST_BASENAME);
  await regularFile(
    manifestPath,
    "Generated public release manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Generated public release manifest is not valid JSON.");
  }
  if (manifest?.schemaVersion !== "usage-monitor-release-site-manifest-v0.2"
      || !Array.isArray(manifest.files)) {
    throw new Error("Generated public release manifest has an unsupported shape.");
  }

  const expectedFiles = new Map();
  for (const row of manifest.files) {
    if (!safeManifestPath(row?.path)
        || !PUBLIC_RELEASE_ASSET_SET.has(row.path)
        || expectedFiles.has(row.path)
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 1
        || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
      throw new Error(
        "Generated public release manifest contains an unsafe or unsupported file entry.",
      );
    }
    expectedFiles.set(row.path, row);
  }
  if (!expectedFiles.has("index.html")) {
    throw new Error("Generated public release output must contain index.html.");
  }

  const actualFiles = await fileManifest(sourceDirectory);
  const expectedNames = new Set([
    ...expectedFiles.keys(),
    RELEASE_MANIFEST_BASENAME,
  ]);
  if (actualFiles.length !== expectedNames.size
      || actualFiles.some(({ path }) => !expectedNames.has(path))) {
    const unexpected = actualFiles
      .map(({ path }) => path)
      .filter((path) => !expectedNames.has(path));
    const localName = unexpected.find((path) =>
      LOCAL_ONLY_BASENAMES.includes(path));
    throw new Error(
      localName
        ? `Generated public output contains local-only asset: ${localName}`
        : "Generated public output does not match its release manifest.",
    );
  }

  for (const row of actualFiles) {
    if (row.path === RELEASE_MANIFEST_BASENAME) continue;
    const expected = expectedFiles.get(row.path);
    if (expected.bytes !== row.bytes || expected.sha256 !== row.sha256) {
      throw new Error(`Generated public asset changed after release build: ${row.path}`);
    }
  }

  const indexHtml = await readFile(join(sourceDirectory, "index.html"), "utf8");
  if (!indexHtml.includes('<script type="module" src="./community.js">')) {
    throw new Error("Generated public index does not load the community entry.");
  }
  const textAssetNames = actualFiles
    .map(({ path }) => path)
    .filter((path) => /\.(?:css|html|js|json|txt)$/u.test(path));
  for (const name of textAssetNames) {
    const contents = await readFile(join(sourceDirectory, name), "utf8");
    for (const marker of PUBLIC_ROUTE_MARKERS) {
      if (contents.includes(marker)) {
        throw new Error(
          `Generated public asset contains a local-only route or control: ${name} (${marker})`,
        );
      }
    }
  }
  return actualFiles;
}

export async function verifyGeneratedCommunityAssetTree(
  sourceDirectory = PRODUCTION_ASSET_SOURCE,
) {
  return verifiedGeneratedFiles(resolve(sourceDirectory));
}

async function replaceGeneratedDirectory(destination, temporaryDirectory) {
  let existing;
  try {
    existing = await lstat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("The generated production asset directory is not a safe directory.");
    }
    await rm(destination, { recursive: true, force: false });
  }
  await rename(temporaryDirectory, destination);
}

/**
 * Stage the exact, manifest-verified public release tree used by the
 * production Worker. Root, direct index requests, and SPA fallback therefore
 * all resolve to the generated community landing page.
 */
export async function stageProductionAssets({
  repositoryRoot = REPOSITORY_ROOT,
  sourceDirectory = PRODUCTION_ASSET_SOURCE,
  destinationDirectory = PRODUCTION_ASSET_DIRECTORY,
  git = runGit,
} = {}) {
  await requireCleanReleaseTree(repositoryRoot, git);
  const sourceFiles = await verifiedGeneratedFiles(sourceDirectory);
  const destinationParent = dirname(destinationDirectory);
  await mkdir(destinationParent, { recursive: true, mode: 0o755 });
  const temporaryDirectory = await mkdtemp(join(destinationParent, ".worker-assets-"));
  try {
    for (const { path } of sourceFiles) {
      const sourcePath = join(sourceDirectory, path);
      const targetPath = resolve(temporaryDirectory, path);
      if (!targetPath.startsWith(`${temporaryDirectory}${sep}`)) {
        throw new Error("Generated public asset path escaped the staging directory.");
      }
      await regularFile(sourcePath, `Generated public asset ${path}`);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o755 });
      await copyFile(sourcePath, targetPath);
    }
    await replaceGeneratedDirectory(destinationDirectory, temporaryDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    directory: destinationDirectory,
    files: sourceFiles.length,
  });
}

async function main() {
  const result = await stageProductionAssets();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
