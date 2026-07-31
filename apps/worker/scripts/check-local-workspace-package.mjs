import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep, win32 } from "node:path";

const DEFAULT_ERROR_CODE = "WORKSPACE_PACKAGE_STALE";

function portablePath(value) {
  return value.split(sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createFail(errorCode) {
  return (message) => {
    const error = new Error(message);
    error.code = errorCode;
    throw error;
  };
}

function checkedRelativePath(root, path, label, fail) {
  const selected = relative(root, path);
  if (
    selected === ""
    || selected === ".."
    || selected.startsWith(`..${sep}`)
  ) {
    fail(`${label} escaped its package root`);
  }
  return portablePath(selected);
}

async function packageRoot(path, label, fail) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory`);
  }
}

async function regularFile(path, root, label, fail) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing`);
    throw error;
  }
  checkedRelativePath(root, path, label, fail);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular file`);
  }
  return path;
}

function safeManifestSelection(selected, packageName, fail) {
  if (
    typeof selected !== "string"
    || selected.length === 0
    || selected.includes("\0")
    || selected.includes("\\")
    || selected.startsWith("/")
    || win32.isAbsolute(selected)
  ) {
    fail(`${packageName} package files entries must be safe relative paths`);
  }
  const segments = selected.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(`${packageName} package files entries must be safe relative paths`);
  }
  return segments;
}

async function sourcePackageFiles(root, packageName, fail) {
  await packageRoot(root, `${packageName} source package`, fail);
  const manifestPath = await regularFile(
    resolve(root, "package.json"),
    root,
    `${packageName} package manifest`,
    fail,
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail(`${packageName} package manifest must be valid JSON`);
  }
  if (
    manifest === null
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || manifest.name !== packageName
  ) {
    fail(`${packageName} package manifest must declare the expected package name`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${packageName} package manifest must declare a non-empty files list`);
  }

  const files = new Set(["package.json"]);
  const declared = new Set();

  async function visit(path) {
    let metadata;
    const selected = checkedRelativePath(
      root,
      path,
      `${packageName} package entry`,
      fail,
    );
    const label = `${packageName} package file ${selected}`;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") fail(`${label} is missing`);
      throw error;
    }
    if (metadata.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
    if (metadata.isFile()) {
      files.add(selected);
      return;
    }
    if (!metadata.isDirectory()) fail(`${label} has an unsupported type`);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      await visit(resolve(path, entry.name));
    }
  }

  for (const selected of manifest.files) {
    const segments = safeManifestSelection(selected, packageName, fail);
    if (declared.has(selected)) {
      fail(`${packageName} package manifest contains a duplicate files entry`);
    }
    declared.add(selected);
    await visit(resolve(root, ...segments));
  }
  return [...files].sort();
}

async function installedPackageFiles(root, packageName, fail) {
  await packageRoot(root, `installed ${packageName} package`, fail);
  const files = [];

  async function visit(path) {
    const selected = checkedRelativePath(
      root,
      path,
      `installed ${packageName} package entry`,
      fail,
    );
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail(`installed ${packageName} package entry is missing: ${selected}`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      fail(`installed ${packageName} package contains a symbolic link: ${selected}`);
    }
    if (metadata.isFile()) {
      files.push(selected);
      return;
    }
    if (!metadata.isDirectory()) {
      fail(`installed ${packageName} package contains an unsupported entry: ${selected}`);
    }
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      await visit(resolve(path, entry.name));
    }
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name))) {
    await visit(resolve(root, entry.name));
  }
  return files.sort();
}

function requiredString(value, label, fail) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

export async function checkLocalWorkspacePackage({
  packageName,
  sourceRoot,
  installedRoot,
  errorCode = DEFAULT_ERROR_CODE,
} = {}) {
  if (typeof errorCode !== "string" || errorCode.trim().length === 0) {
    throw new TypeError("errorCode must be a non-empty string");
  }
  const fail = createFail(errorCode);
  const selectedPackageName = requiredString(
    packageName,
    "packageName",
    fail,
  );
  const selectedSourceRoot = resolve(
    requiredString(sourceRoot, "sourceRoot", fail),
  );
  const selectedInstalledRoot = resolve(
    requiredString(installedRoot, "installedRoot", fail),
  );
  const [sourceFiles, copiedFiles] = await Promise.all([
    sourcePackageFiles(selectedSourceRoot, selectedPackageName, fail),
    installedPackageFiles(selectedInstalledRoot, selectedPackageName, fail),
  ]);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(copiedFiles)) {
    fail(`installed ${selectedPackageName} package file inventory differs from the source package`);
  }

  const digests = [];
  for (const selected of sourceFiles) {
    const [sourceBytes, installedBytes] = await Promise.all([
      readFile(resolve(selectedSourceRoot, ...selected.split("/"))),
      readFile(resolve(selectedInstalledRoot, ...selected.split("/"))),
    ]);
    const sourceSha256 = sha256(sourceBytes);
    if (sourceSha256 !== sha256(installedBytes)) {
      fail(`installed ${selectedPackageName} package is stale: ${selected}`);
    }
    digests.push([selected, sourceSha256]);
  }

  const files = Object.freeze([...sourceFiles]);
  return Object.freeze({
    packageName: selectedPackageName,
    fileCount: files.length,
    files,
    sha256: sha256(JSON.stringify(digests)),
  });
}
