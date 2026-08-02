import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
export const PRODUCTION_ASSET_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "web",
  "public",
);
export const PRODUCTION_ASSET_DIRECTORY = join(
  REPOSITORY_ROOT,
  ".release-build",
  "worker-assets",
);

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

function sourceRelativePath(repositoryRoot, sourceDirectory, trackedPath) {
  if (!trackedPath.startsWith("apps/web/public/")) {
    throw new Error("Git returned a production asset outside apps/web/public.");
  }
  const source = resolve(repositoryRoot, trackedPath);
  const relativeSource = relative(sourceDirectory, source);
  if (relativeSource.length === 0
      || relativeSource === ".."
      || relativeSource.startsWith(`..${sep}`)) {
    throw new Error("Git returned an unsafe production asset path.");
  }
  return relativeSource;
}

async function requireCleanReleaseTree(repositoryRoot, git) {
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
      .trim() !== "") {
    throw new Error(
      "Production deployment requires a clean, committed release tree; stage or discard no files automatically.",
    );
  }
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
 * Build the exact asset tree that a production Worker may upload.
 *
 * The source must be a clean Git checkout and every copied file comes from
 * `git ls-files`, so a new or locally altered public asset can never reach a
 * deploy merely because Wrangler recursively found it in the working tree.
 */
export async function stageProductionAssets({
  repositoryRoot = REPOSITORY_ROOT,
  sourceDirectory = PRODUCTION_ASSET_SOURCE,
  destinationDirectory = PRODUCTION_ASSET_DIRECTORY,
  git = runGit,
} = {}) {
  await requireCleanReleaseTree(repositoryRoot, git);
  const trackedPaths = git(repositoryRoot, ["ls-files", "-z", "--", "apps/web/public"])
    .split("\0")
    .filter(Boolean);
  if (trackedPaths.length === 0) {
    throw new Error("No tracked web assets are available for production deployment.");
  }
  const destinationParent = dirname(destinationDirectory);
  await mkdir(destinationParent, { recursive: true, mode: 0o755 });
  const temporaryDirectory = await mkdtemp(join(destinationParent, ".worker-assets-"));
  try {
    for (const trackedPath of trackedPaths) {
      const relativePath = sourceRelativePath(
        repositoryRoot,
        sourceDirectory,
        trackedPath,
      );
      const sourcePath = resolve(sourceDirectory, relativePath);
      const targetPath = resolve(temporaryDirectory, relativePath);
      if (!targetPath.startsWith(`${temporaryDirectory}${sep}`)) {
        throw new Error("Git returned an unsafe production asset target path.");
      }
      const metadata = await lstat(sourcePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Production asset is not a regular file: ${trackedPath}`);
      }
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
    files: trackedPaths.length,
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
