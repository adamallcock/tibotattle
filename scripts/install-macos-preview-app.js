#!/usr/bin/env node
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
} from "../config/product-brand.js";
import {
  MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
  validateMacOSPreviewApp,
} from "./build-macos-app.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SYSTEM_APPLICATIONS_TARGET = join(
  "/Applications",
  PREVIEW_PRODUCT_BRAND.bundleName,
);
const STABLE_SYSTEM_APPLICATIONS_TARGET = join(
  "/Applications",
  PRODUCT_BRAND.bundleName,
);
const BACKUP_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z(?:-[0-9]+)?$/u;

export const MACOS_PREVIEW_INSTALL_CODES = Object.freeze({
  ACTIVATION_FAILED: "MACOS_PREVIEW_INSTALL_ACTIVATION_FAILED",
  ARGUMENTS_INVALID: "MACOS_PREVIEW_INSTALL_ARGUMENTS_INVALID",
  BACKUP_FAILED: "MACOS_PREVIEW_INSTALL_BACKUP_FAILED",
  BACKUP_EXISTS: "MACOS_PREVIEW_INSTALL_BACKUP_EXISTS",
  BACKUP_INVALID: "MACOS_PREVIEW_INSTALL_BACKUP_INVALID",
  BACKUP_SYMLINK: "MACOS_PREVIEW_INSTALL_BACKUP_SYMLINK",
  CLEANUP_FAILED: "MACOS_PREVIEW_INSTALL_CLEANUP_FAILED",
  PARENT_INVALID: "MACOS_PREVIEW_INSTALL_PARENT_INVALID",
  PARENT_MISSING: "MACOS_PREVIEW_INSTALL_PARENT_MISSING",
  REPLACE_REQUIRED: "MACOS_PREVIEW_INSTALL_REPLACE_REQUIRED",
  SYSTEM_INSTALL_CONFIRMATION_REQUIRED: "MACOS_PREVIEW_INSTALL_SYSTEM_CONFIRMATION_REQUIRED",
  ROLLBACK_FAILED: "MACOS_PREVIEW_INSTALL_ROLLBACK_FAILED",
  SOURCE_INVALID: "MACOS_PREVIEW_INSTALL_SOURCE_INVALID",
  SOURCE_MISSING: "MACOS_PREVIEW_INSTALL_SOURCE_MISSING",
  SOURCE_NAME_INVALID: "MACOS_PREVIEW_INSTALL_SOURCE_NAME_INVALID",
  SOURCE_TARGET_CONFLICT: "MACOS_PREVIEW_INSTALL_SOURCE_TARGET_CONFLICT",
  STAGE_FAILED: "MACOS_PREVIEW_INSTALL_STAGE_FAILED",
  STABLE_TARGET_FORBIDDEN: "MACOS_PREVIEW_INSTALL_STABLE_TARGET_FORBIDDEN",
  TARGET_INVALID: "MACOS_PREVIEW_INSTALL_TARGET_INVALID",
  TARGET_MISSING: "MACOS_PREVIEW_INSTALL_TARGET_MISSING",
  TARGET_NAME_INVALID: "MACOS_PREVIEW_INSTALL_TARGET_NAME_INVALID",
  TARGET_SYMLINK: "MACOS_PREVIEW_INSTALL_TARGET_SYMLINK",
  TARGET_UNSAFE: "MACOS_PREVIEW_INSTALL_TARGET_UNSAFE",
  VALIDATOR_INVALID: "MACOS_PREVIEW_INSTALL_VALIDATOR_INVALID",
});

const DEFAULT_FILE_SYSTEM = Object.freeze({
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
});

function fail(code, message, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function pathValue(value, label, code = MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw fail(code, `${label} must be a non-empty filesystem path`);
  }
  return resolve(value);
}

function pathErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function backupPrefix() {
  return `${PREVIEW_PRODUCT_BRAND.bundleName}.backup-`;
}

function backupName(timestamp, suffix = 0) {
  return `${backupPrefix()}${timestamp}${suffix === 0 ? "" : `-${suffix}`}`;
}

function formatBackupTimestamp(value) {
  const selected = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(selected.getTime())) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.BACKUP_INVALID,
      "Backup timestamp is invalid",
    );
  }
  return selected.toISOString().replace(/[:.]/gu, "-");
}

export function getMacOSPreviewInstallTargetPaths(homeDirectory = homedir()) {
  const selectedHome = pathValue(homeDirectory, "Home directory");
  return Object.freeze([
    SYSTEM_APPLICATIONS_TARGET,
    join(selectedHome, "Applications", PREVIEW_PRODUCT_BRAND.bundleName),
  ]);
}

export function macOSUserApplicationsTarget(homeDirectory = homedir()) {
  return getMacOSPreviewInstallTargetPaths(homeDirectory)[1];
}

export function requiresMacOSSystemInstallConfirmation(targetPath) {
  return targetPath === SYSTEM_APPLICATIONS_TARGET;
}

function assertMacOSSystemInstallConfirmation(targetPath, confirmed) {
  if (!requiresMacOSSystemInstallConfirmation(targetPath) || confirmed === true) {
    return;
  }
  throw fail(
    MACOS_PREVIEW_INSTALL_CODES.SYSTEM_INSTALL_CONFIRMATION_REQUIRED,
    `Installing to ${SYSTEM_APPLICATIONS_TARGET} requires --confirm-system-install in addition to --replace`,
  );
}

function normalizeAllowedTargetPaths(allowedTargetPaths, homeDirectory) {
  const candidates = allowedTargetPaths
    ?? getMacOSPreviewInstallTargetPaths(homeDirectory);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.TARGET_UNSAFE,
      "No safe preview application targets are configured",
    );
  }
  return candidates.map((candidate) =>
    pathValue(candidate, "Allowed preview application target",
      MACOS_PREVIEW_INSTALL_CODES.TARGET_UNSAFE));
}

export function validateMacOSPreviewTargetPath(
  targetPath,
  {
    allowedTargetPaths,
    homeDirectory = homedir(),
  } = {},
) {
  const selected = pathValue(
    targetPath,
    "Preview application target",
    MACOS_PREVIEW_INSTALL_CODES.TARGET_UNSAFE,
  );
  const stableTargets = new Set([
    STABLE_SYSTEM_APPLICATIONS_TARGET,
    join(resolve(homeDirectory), "Applications", PRODUCT_BRAND.bundleName),
  ]);
  if (stableTargets.has(selected)) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.STABLE_TARGET_FORBIDDEN,
      `Refusing to replace stable ${PRODUCT_BRAND.bundleName}; previews install as ${PREVIEW_PRODUCT_BRAND.bundleName}`,
    );
  }
  if (basename(selected) !== PREVIEW_PRODUCT_BRAND.bundleName) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.TARGET_NAME_INVALID,
      `Preview application target must be named ${PREVIEW_PRODUCT_BRAND.bundleName}`,
    );
  }
  const allowed = normalizeAllowedTargetPaths(allowedTargetPaths, homeDirectory);
  if (!allowed.includes(selected)) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.TARGET_UNSAFE,
      `Refusing to modify ${selected}; target must be exactly `
        + `${SYSTEM_APPLICATIONS_TARGET} or ${macOSUserApplicationsTarget(homeDirectory)}`,
    );
  }
  return selected;
}

export function validateMacOSPreviewBackupPath(
  backupPath,
  {
    targetPath,
    allowedTargetPaths,
    homeDirectory = homedir(),
  } = {},
) {
  const target = validateMacOSPreviewTargetPath(targetPath, {
    allowedTargetPaths,
    homeDirectory,
  });
  const selected = pathValue(
    backupPath,
    "Preview application backup",
    MACOS_PREVIEW_INSTALL_CODES.BACKUP_INVALID,
  );
  const expectedPrefix = escapeRegularExpression(backupPrefix());
  const validName = new RegExp(
    `^${expectedPrefix}${BACKUP_TIMESTAMP_PATTERN.source.slice(1, -1)}$`,
    "u",
  );
  if (dirname(selected) !== dirname(target)
      || !validName.test(basename(selected))) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.BACKUP_INVALID,
      `Backup must be a timestamped ${PREVIEW_PRODUCT_BRAND.bundleName} sibling of the target`,
    );
  }
  return selected;
}

function validateSourcePath(sourcePath) {
  const selected = pathValue(
    sourcePath,
    "Preview application source",
    MACOS_PREVIEW_INSTALL_CODES.SOURCE_INVALID,
  );
  if (basename(selected) !== PREVIEW_PRODUCT_BRAND.bundleName) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.SOURCE_NAME_INVALID,
      `Preview application source must be named ${PREVIEW_PRODUCT_BRAND.bundleName}`,
    );
  }
  return selected;
}

async function readPathMetadata(path, fileSystem) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function assertRealDirectory(
  path,
  fileSystem,
  {
    missingCode,
    invalidCode,
    symlinkCode,
    label,
  },
) {
  let metadata;
  try {
    metadata = await fileSystem.lstat(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw fail(missingCode, `${label} is unavailable: ${path}`);
    }
    throw fail(
      invalidCode,
      `Could not inspect ${label.toLowerCase()}: ${path}: ${pathErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink()) {
    throw fail(symlinkCode, `Refusing to use a symbolic-link ${label.toLowerCase()}: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw fail(invalidCode, `${label} must be a real directory: ${path}`);
  }
  return metadata;
}

async function assertSafeTargetParent(
  targetPath,
  fileSystem,
  { createIfMissing },
) {
  const parent = dirname(targetPath);
  let metadata = await readPathMetadata(parent, fileSystem);
  if (metadata === null) {
    if (!createIfMissing) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.PARENT_MISSING,
        `Preview application target directory is unavailable: ${parent}`,
      );
    }
    const ancestor = dirname(parent);
    await assertRealDirectory(ancestor, fileSystem, {
      missingCode: MACOS_PREVIEW_INSTALL_CODES.PARENT_MISSING,
      invalidCode: MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
      symlinkCode: MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
      label: "Preview application target parent",
    });
    try {
      await fileSystem.mkdir(parent, { recursive: true, mode: 0o755 });
    } catch (error) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
        `Could not create the preview application target directory ${parent}: `
          + pathErrorMessage(error),
        { cause: error },
      );
    }
    metadata = await readPathMetadata(parent, fileSystem);
  }
  if (metadata === null) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.PARENT_MISSING,
      `Preview application target directory is unavailable: ${parent}`,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
      `Preview application target directory must be a real directory: ${parent}`,
    );
  }
  let resolvedParent;
  try {
    resolvedParent = await fileSystem.realpath(parent);
  } catch (error) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
      `Could not resolve the preview application target directory ${parent}: `
        + pathErrorMessage(error),
      { cause: error },
    );
  }
  if (resolvedParent !== parent) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.PARENT_INVALID,
      `Refusing to use a symbolic-link target directory: ${parent}`,
    );
  }
  return parent;
}

async function inspectExistingTarget(targetPath, fileSystem) {
  const metadata = await readPathMetadata(targetPath, fileSystem);
  if (metadata === null) return false;
  if (metadata.isSymbolicLink()) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.TARGET_SYMLINK,
      `Refusing to replace a symbolic-link target: ${targetPath}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.TARGET_INVALID,
      `Preview application target must be a real directory: ${targetPath}`,
    );
  }
  return true;
}

async function chooseBackupPath(
  targetPath,
  fileSystem,
  {
    backupPath,
    clock,
    allowedTargetPaths,
    homeDirectory,
  },
) {
  if (backupPath !== null && backupPath !== undefined) {
    const selected = validateMacOSPreviewBackupPath(backupPath, {
      targetPath,
      allowedTargetPaths,
      homeDirectory,
    });
    const metadata = await readPathMetadata(selected, fileSystem);
    if (metadata?.isSymbolicLink()) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.BACKUP_SYMLINK,
        `Refusing to use a symbolic-link backup path: ${selected}`,
      );
    }
    if (metadata !== null) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.BACKUP_EXISTS,
        `Refusing to overwrite an existing preview backup: ${selected}`,
      );
    }
    return selected;
  }

  const timestamp = formatBackupTimestamp(clock());
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = join(
      dirname(targetPath),
      backupName(timestamp, suffix),
    );
    const selected = validateMacOSPreviewBackupPath(candidate, {
      targetPath,
      allowedTargetPaths,
      homeDirectory,
    });
    const metadata = await readPathMetadata(selected, fileSystem);
    if (metadata === null) return selected;
    if (metadata.isSymbolicLink()) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.BACKUP_SYMLINK,
        `Refusing to use a symbolic-link backup path: ${selected}`,
      );
    }
  }
  throw fail(
    MACOS_PREVIEW_INSTALL_CODES.BACKUP_INVALID,
    `Could not select an unused timestamped backup for ${targetPath}`,
  );
}

async function cleanStagingRoot(stageRoot, fileSystem) {
  if (stageRoot === null) return;
  const metadata = await readPathMetadata(stageRoot, fileSystem);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.CLEANUP_FAILED,
      `Refusing to remove an unexpected staging path: ${stageRoot}`,
    );
  }
  try {
    await fileSystem.rm(stageRoot, { recursive: true, force: false });
  } catch (error) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.CLEANUP_FAILED,
      `Could not clean the preview staging path ${stageRoot}: `
        + pathErrorMessage(error),
      { cause: error },
    );
  }
}

export async function installMacOSPreviewApp({
  sourcePath,
  targetPath,
  replace = false,
  confirmSystemInstall = false,
  backupPath = null,
  validator = validateMacOSPreviewApp,
  fileSystem = DEFAULT_FILE_SYSTEM,
  clock = () => new Date(),
  allowedTargetPaths,
  homeDirectory = homedir(),
} = {}) {
  if (replace !== true) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.REPLACE_REQUIRED,
      "Preview installation requires the explicit --replace opt-in",
    );
  }
  if (typeof validator !== "function") {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.VALIDATOR_INVALID,
      "A preview validator function is required",
    );
  }
  const source = validateSourcePath(sourcePath);
  const target = validateMacOSPreviewTargetPath(targetPath, {
    allowedTargetPaths,
    homeDirectory,
  });
  assertMacOSSystemInstallConfirmation(target, confirmSystemInstall);
  if (source === target) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.SOURCE_TARGET_CONFLICT,
      "Preview source and installation target must be different paths",
    );
  }
  const requestedBackupPath = backupPath === null || backupPath === undefined
    ? null
    : validateMacOSPreviewBackupPath(backupPath, {
      targetPath: target,
      allowedTargetPaths,
      homeDirectory,
    });
  await assertRealDirectory(source, fileSystem, {
    missingCode: MACOS_PREVIEW_INSTALL_CODES.SOURCE_MISSING,
    invalidCode: MACOS_PREVIEW_INSTALL_CODES.SOURCE_INVALID,
    symlinkCode: MACOS_PREVIEW_INSTALL_CODES.SOURCE_INVALID,
    label: "Preview application source",
  });

  // Validate before creating any staging directory or touching the target.
  const sourceValidation = await validator(source);
  const isUserApplicationsTarget =
    target === macOSUserApplicationsTarget(homeDirectory);
  const parent = await assertSafeTargetParent(target, fileSystem, {
    createIfMissing: isUserApplicationsTarget,
  });

  let stageRoot = null;
  let primaryError = null;
  try {
    try {
      stageRoot = await fileSystem.mkdtemp(join(
        parent,
        `.${PREVIEW_PRODUCT_BRAND.bundleName}.preview-stage-`,
      ));
      await assertRealDirectory(stageRoot, fileSystem, {
        missingCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
        invalidCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
        symlinkCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
        label: "Preview staging directory",
      });
    } catch (error) {
      if (error?.code === MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED) throw error;
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
        `Could not create the preview staging directory: ${pathErrorMessage(error)}`,
        { cause: error },
      );
    }

    const stagedApp = join(stageRoot, PREVIEW_PRODUCT_BRAND.bundleName);
    try {
      await fileSystem.cp(source, stagedApp, {
        recursive: true,
        errorOnExist: true,
        force: false,
        // Node otherwise rewrites the framework's relative symlinks into
        // absolute paths rooted at the staging source. Sparkle's sealed
        // framework contract requires the reviewed relative link targets.
        verbatimSymlinks: true,
      });
    } catch (error) {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
        `Could not stage the preview application before replacement: `
          + pathErrorMessage(error),
        { cause: error },
      );
    }
    await assertRealDirectory(stagedApp, fileSystem, {
      missingCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
      invalidCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
      symlinkCode: MACOS_PREVIEW_INSTALL_CODES.STAGE_FAILED,
      label: "Staged preview application",
    });

    // Re-check the copied bundle so a later replacement never relies only on
    // the source path that was validated before the copy.
    const stagedValidation = await validator(stagedApp);
    let existingTarget = await inspectExistingTarget(target, fileSystem);
    let selectedBackup = null;
    let existingMoved = false;

    // A target may have appeared while the bundle was being staged. Treat it
    // as an existing app and preserve it rather than overwriting it blindly.
    if (existingTarget) {
      selectedBackup = await chooseBackupPath(target, fileSystem, {
        backupPath: requestedBackupPath,
        clock,
        allowedTargetPaths,
        homeDirectory,
      });
      try {
        await fileSystem.rename(target, selectedBackup);
        existingMoved = true;
      } catch (error) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.BACKUP_FAILED,
          `Could not preserve the existing app at ${target} as ${selectedBackup}: `
            + pathErrorMessage(error),
          { cause: error },
        );
      }
    } else {
      // Narrow the no-target window immediately before activation. If an app
      // appeared, run the same backup path rather than replacing it.
      existingTarget = await inspectExistingTarget(target, fileSystem);
      if (existingTarget) {
        selectedBackup = await chooseBackupPath(target, fileSystem, {
          backupPath: requestedBackupPath,
          clock,
          allowedTargetPaths,
          homeDirectory,
        });
        try {
          await fileSystem.rename(target, selectedBackup);
          existingMoved = true;
        } catch (error) {
          throw fail(
            MACOS_PREVIEW_INSTALL_CODES.BACKUP_FAILED,
            `Could not preserve the existing app at ${target} as ${selectedBackup}: `
              + pathErrorMessage(error),
            { cause: error },
          );
        }
      }
    }

    try {
      if (await inspectExistingTarget(target, fileSystem)) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.TARGET_INVALID,
          `Preview application target changed during installation: ${target}`,
        );
      }
      await fileSystem.rename(stagedApp, target);
    } catch (error) {
      const activationError = error?.code === MACOS_PREVIEW_INSTALL_CODES.TARGET_INVALID
        ? error
        : fail(
          MACOS_PREVIEW_INSTALL_CODES.ACTIVATION_FAILED,
          `Could not activate the staged preview application at ${target}: `
            + pathErrorMessage(error),
          { cause: error },
        );
      if (existingMoved) {
        try {
          if (await inspectExistingTarget(target, fileSystem)) {
            throw fail(
              MACOS_PREVIEW_INSTALL_CODES.ROLLBACK_FAILED,
              `Rollback target is unexpectedly occupied: ${target}`,
            );
          }
          await fileSystem.rename(selectedBackup, target);
          existingMoved = false;
        } catch (rollbackError) {
          throw fail(
            MACOS_PREVIEW_INSTALL_CODES.ROLLBACK_FAILED,
            `Preview activation failed and the previous app could not be restored. `
              + `The preserved app remains at ${selectedBackup}: `
              + pathErrorMessage(rollbackError),
            { cause: rollbackError },
          );
        }
      }
      throw activationError;
    }

    return Object.freeze({
      backupPath: selectedBackup,
      sourcePath: source,
      sourceValidation,
      stagedValidation,
      targetPath: target,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanStagingRoot(stageRoot, fileSystem);
    } catch (cleanupError) {
      if (primaryError) {
        try {
          primaryError.cleanupError = cleanupError;
        } catch {
          // Preserve the operation's original error even if it is immutable.
        }
      } else {
        throw cleanupError;
      }
    }
  }
}

export function usage() {
  return [
    "Usage:",
    `  node scripts/install-macos-preview-app.js --app <${PREVIEW_PRODUCT_BRAND.bundleName} path> \\`,
    `    --target ${SYSTEM_APPLICATIONS_TARGET} --replace --confirm-system-install`,
    `  node scripts/install-macos-preview-app.js --app <${PREVIEW_PRODUCT_BRAND.bundleName} path> \\`,
    "    --user-applications --replace",
    "",
    "The target is restricted to /Applications or the current user's ~/Applications.",
    "--replace is mandatory because this command moves an existing app to a backup.",
    "--confirm-system-install is additionally mandatory for /Applications.",
  ].join("\n");
}

function argumentValue(argv, index, argument) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
      `${argument} requires a value`,
    );
  }
  return value;
}

export function parseMacOSPreviewInstallArguments(
  argv,
  { homeDirectory = homedir() } = {},
) {
  let sourcePath = null;
  let targetPath = null;
  let replace = false;
  let confirmSystemInstall = false;
  let userApplications = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" || argument === "--source") {
      if (sourcePath !== null) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "Preview application source must be provided only once",
        );
      }
      sourcePath = validateSourcePath(argumentValue(argv, index, argument));
      index += 1;
    } else if (argument === "--target") {
      if (targetPath !== null || userApplications) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "Provide exactly one of --target or --user-applications",
        );
      }
      targetPath = validateMacOSPreviewTargetPath(
        argumentValue(argv, index, argument),
        { homeDirectory },
      );
      index += 1;
    } else if (argument === "--user-applications") {
      if (userApplications || targetPath !== null) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "Provide exactly one of --target or --user-applications",
        );
      }
      userApplications = true;
    } else if (argument === "--replace") {
      if (replace) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "--replace may be provided only once",
        );
      }
      replace = true;
    } else if (argument === "--confirm-system-install") {
      if (confirmSystemInstall) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "--confirm-system-install may be provided only once",
        );
      }
      confirmSystemInstall = true;
    } else if (argument === "--help" || argument === "-h") {
      if (argv.length !== 1) {
        throw fail(
          MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
          "--help cannot be combined with installation arguments",
        );
      }
      return Object.freeze({ help: true });
    } else {
      throw fail(
        MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
        `Unknown argument: ${argument}`,
      );
    }
  }
  if (!replace) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.REPLACE_REQUIRED,
      "Preview installation requires the explicit --replace opt-in",
    );
  }
  if (sourcePath === null) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
      "A preview application source is required via --app <path>",
    );
  }
  if (targetPath === null && !userApplications) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
      "Provide exactly one of --target or --user-applications",
    );
  }
  const selectedTarget = targetPath
    ?? macOSUserApplicationsTarget(homeDirectory);
  if (confirmSystemInstall && !requiresMacOSSystemInstallConfirmation(selectedTarget)) {
    throw fail(
      MACOS_PREVIEW_INSTALL_CODES.ARGUMENTS_INVALID,
      `--confirm-system-install is valid only with --target ${SYSTEM_APPLICATIONS_TARGET}`,
    );
  }
  assertMacOSSystemInstallConfirmation(selectedTarget, confirmSystemInstall);
  return Object.freeze({
    confirmSystemInstall,
    replace: true,
    sourcePath,
    targetPath: selectedTarget,
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseMacOSPreviewInstallArguments(argv, dependencies);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const result = await installMacOSPreviewApp({
    ...options,
    allowedTargetPaths: dependencies.allowedTargetPaths,
    backupPath: dependencies.backupPath,
    clock: dependencies.clock,
    fileSystem: dependencies.fileSystem,
    homeDirectory: dependencies.homeDirectory,
    validator: dependencies.validator,
  });
  console.log(`Preview app activated at ${result.targetPath}`);
  console.log(
    result.backupPath
      ? `Previous app preserved at ${result.backupPath}`
      : "Previous app: none (target was absent)",
  );
  console.log(`Preview validation: ${MACOS_PREVIEW_DISTRIBUTION_CHANNEL}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    const code = typeof error?.code === "string"
      ? error.code
      : "MACOS_PREVIEW_INSTALL_FAILED";
    console.error(`install-macos-preview-app: ${code}: ${pathErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
