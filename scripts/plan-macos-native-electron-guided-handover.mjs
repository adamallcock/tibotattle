#!/usr/bin/env node

/**
 * Build the deterministic, owner-run route for a native-to-Electron guided
 * install. This script only plans; it never moves an installed application,
 * replaces a bundle, mutates a profile, or invokes the handover bridge.
 */
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  NATIVE_ELECTRON_HANDOVER_ROUTE,
} from "../apps/electron/desktop-native-migration.js";
import {
  nativeElectronGuidedBackupRoot,
  nativeElectronGuidedNativeAppBackupPath,
  nativeElectronLegacyStateRoot,
} from "../apps/electron/desktop-native-migration-macos.js";

export const MAC_NATIVE_ELECTRON_GUIDED_INSTALL_PLAN_SCHEMA =
  "tibotattle-macos-guided-native-electron-install-v1";

function fail(code) {
  const error = new Error("Guided handover plan is invalid");
  error.name = "MacNativeElectronGuidedInstallPlanError";
  error.code = `mac_native_electron_guided_install_${code}`;
  throw error;
}

function absolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    fail(code);
  }
  return resolve(value);
}

/**
 * Return exact local locations for a future owner-run relocation and install.
 * The native app is retained at the backup path, then a separately verified
 * Electron candidate may occupy the original application path and discover it
 * without scanning the disk.
 */
export function createMacNativeElectronGuidedInstallPlan({
  legacyAppPath,
  homeDirectory = homedir(),
  backupRoot = nativeElectronGuidedBackupRoot(homeDirectory),
} = {}) {
  const nativeApp = absolutePath(legacyAppPath, "invalid_legacy_app");
  const home = absolutePath(homeDirectory, "invalid_home");
  const backup = absolutePath(backupRoot, "invalid_backup_root");
  if (basename(nativeApp) !== "TiboTattle.app") fail("invalid_legacy_app");
  const preservedNativeAppPath = nativeElectronGuidedNativeAppBackupPath(backup);
  if (nativeApp === preservedNativeAppPath) fail("already_relocated");
  return Object.freeze({
    schemaVersion: MAC_NATIVE_ELECTRON_GUIDED_INSTALL_PLAN_SCHEMA,
    route: NATIVE_ELECTRON_HANDOVER_ROUTE,
    nativeStateRoot: nativeElectronLegacyStateRoot(home),
    legacyAppPath: nativeApp,
    preservedNativeAppPath,
    electronInstallPath: join(dirname(nativeApp), "TiboTattle.app"),
    backupRoot: backup,
  });
}

function parseArguments(argumentsList) {
  let legacyAppPath = null;
  let homeDirectory = homedir();
  let backupRoot;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--legacy-app") {
      legacyAppPath = argumentsList[index + 1] ?? null;
      index += 1;
    } else if (argument === "--home") {
      homeDirectory = argumentsList[index + 1] ?? "";
      index += 1;
    } else if (argument === "--backup-root") {
      backupRoot = argumentsList[index + 1] ?? "";
      index += 1;
    } else {
      fail("invalid_arguments");
    }
  }
  if (legacyAppPath === null) fail("invalid_legacy_app");
  return { legacyAppPath, homeDirectory, backupRoot };
}

function main() {
  try {
    const plan = createMacNativeElectronGuidedInstallPlan(parseArguments(process.argv.slice(2)));
    // Do not print profile paths. The source API returns the route to the
    // owner-run installer; this CLI is deliberately a bounded readiness check.
    if (plan.route !== NATIVE_ELECTRON_HANDOVER_ROUTE) fail("invalid_route");
    process.stdout.write("Guided native-to-Electron install route is ready.\n");
  } catch {
    process.stderr.write("Guided native-to-Electron install route is unavailable.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
