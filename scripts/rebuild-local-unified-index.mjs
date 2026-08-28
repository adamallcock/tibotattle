#!/usr/bin/env node
// Prepare or explicitly apply a copy-first unified-index recovery.
//
// Preparation never replaces the live index. It first creates a consistent
// rollback copy, rebuilds at a separate candidate path, runs quick_check,
// foreign-key, schema, generation and count validation, and writes an
// owner-only receipt. Applying is a separate invocation that requires the app
// to be stopped and the exact live path to be repeated as confirmation.
//
// Prepare:
//   node scripts/rebuild-local-unified-index.mjs [--index <live-file>]
//       [--recovery-dir <new-private-directory>]
//       [--candidate <file>] [--backup <file>] [--receipt <file>]
//       [--codex-home <dir>] [--secret <file>] [--workers N] [--dry-run]
//
// Apply a reviewed receipt:
//   node scripts/rebuild-local-unified-index.mjs --apply
//       --index <live-file> --candidate <file> --receipt <file>
//       --confirm-index <same-live-file> --confirm-app-stopped
//
// Apply never auto-removes an existing recovery lock, including one whose PID
// appears dead: Node has no atomic compare-and-unlink primitive, so automatic
// stale cleanup could delete a replacement lock owned by another contender.
// Valid locks report local_unified_index_recovery_locked; malformed locks
// report local_unified_index_recovery_lock_invalid. Both remain untouched for
// explicit operator inspection.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { defaultRebuildWorkerCount } from "../src/local-unified-index-build.js";
import {
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
} from "../src/local-unified-index.js";
import { TELEMETRY_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import {
  applyLocalUnifiedIndexRecovery,
  localUnifiedIndexRecoveryPaths,
  prepareLocalUnifiedIndexRecovery,
  validateLocalUnifiedIndexRecoveryPaths,
} from "./local-unified-index-recovery-core.mjs";

const VALUE_OPTIONS = new Set([
  "index",
  "recovery-dir",
  "candidate",
  "backup",
  "receipt",
  "codex-home",
  "secret",
  "workers",
  "confirm-index",
]);
const BOOLEAN_OPTIONS = new Set([
  "apply",
  "dry-run",
  "confirm-app-stopped",
]);

function parseArguments(args) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--") || argument.length === 2) {
      throw new Error(`unexpected positional argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (VALUE_OPTIONS.has(name)) {
      if (values.has(name)) throw new Error(`duplicate --${name}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      values.set(name, value);
      index += 1;
    } else if (BOOLEAN_OPTIONS.has(name)) {
      if (flags.has(name)) throw new Error(`duplicate --${name}`);
      flags.add(name);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return Object.freeze({ values, flags });
}

const parsed = parseArguments(process.argv.slice(2));
function option(name, fallback = null) {
  return parsed.values.get(name) ?? fallback;
}
function flag(name) {
  return parsed.flags.has(name);
}
function rejectModeIncompatibleArguments(allowed) {
  for (const name of [...parsed.values.keys(), ...parsed.flags]) {
    if (!allowed.has(name)) {
      throw new Error(`--${name} is not valid in this mode`);
    }
  }
}

const indexFile = resolve(option("index", defaultLocalUnifiedIndexPath()));
const applying = flag("apply");
const dryRun = flag("dry-run");

if (applying && dryRun) throw new Error("--apply and --dry-run are mutually exclusive");

if (applying) {
  rejectModeIncompatibleArguments(new Set([
    "apply",
    "index",
    "candidate",
    "receipt",
    "confirm-index",
    "confirm-app-stopped",
  ]));
  const candidateFile = option("candidate");
  const receiptFile = option("receipt");
  const confirmIndex = option("confirm-index");
  if (candidateFile === null || receiptFile === null || confirmIndex === null) {
    throw new Error(
      "--apply requires --candidate, --receipt, and --confirm-index",
    );
  }
  const result = await applyLocalUnifiedIndexRecovery({
    indexFile,
    candidateFile: resolve(candidateFile),
    receiptFile: resolve(receiptFile),
    confirmIndex,
    confirmAppStopped: flag("confirm-app-stopped"),
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  rejectModeIncompatibleArguments(new Set([
    "index",
    "recovery-dir",
    "candidate",
    "backup",
    "receipt",
    "codex-home",
    "secret",
    "workers",
    "dry-run",
  ]));
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const recoveryDir = resolve(option(
    "recovery-dir",
    `${indexFile}.recovery-${runId}`,
  ));
  const defaults = localUnifiedIndexRecoveryPaths(indexFile, recoveryDir);
  const candidateFile = resolve(option(
    "candidate",
    defaults.candidateFile,
  ));
  const backupFile = resolve(option(
    "backup",
    defaults.backupFile,
  ));
  const receiptFile = resolve(option(
    "receipt",
    defaults.receiptFile,
  ));
  const codexHome = resolve(option(
    "codex-home",
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  ));
  const secretFile = resolve(option(
    "secret",
    defaultLocalUnifiedIndexSecretPath(indexFile),
  ));
  const workers = Number(option("workers", String(defaultRebuildWorkerCount())));
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error("--workers must be a positive integer");
  }
  // Dry-run shares the exact topology validator with prepare but intentionally
  // does not reserve the recovery directory or touch any artifact.
  const validatedPaths = validateLocalUnifiedIndexRecoveryPaths({
    indexFile,
    candidateFile,
    backupFile,
    receiptFile,
  });
  if (validatedPaths.recoveryDir !== recoveryDir) {
    throw new Error("local_unified_index_recovery_paths_invalid");
  }
  const plan = {
    mode: dryRun ? "dry-run" : "prepare",
    liveIndexPreserved: true,
    copyFirst: true,
    indexFile,
    recoveryDir,
    candidateFile,
    backupFile,
    receiptFile,
    secretFile,
    codexHome,
    workers,
    applyCommand: [
      "node",
      "scripts/rebuild-local-unified-index.mjs",
      "--apply",
      "--index",
      indexFile,
      "--candidate",
      candidateFile,
      "--receipt",
      receiptFile,
      "--confirm-index",
      indexFile,
      "--confirm-app-stopped",
    ],
  };
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    let peakRss = 0;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, 250);
    sample.unref?.();
    const result = await prepareLocalUnifiedIndexRecovery({
      codexHome,
      indexFile,
      candidateFile,
      backupFile,
      receiptFile,
      secretFile,
      contractVersion: TELEMETRY_SCHEMA_VERSION,
      workerCount: workers,
      onProgress: process.stderr.isTTY
        ? (progress) => {
          process.stderr.write(
            `\r${progress.sourcesScanned}/${progress.sources} sources, `
            + `${(progress.bytesScanned / 1024 ** 3).toFixed(1)} GiB, `
            + `${progress.usageEvents} events   `,
          );
        }
        : null,
    });
    clearInterval(sample);
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (process.stderr.isTTY) process.stderr.write("\n");
    console.log(JSON.stringify({
      ...plan,
      ...result,
      peakRssMib: +(peakRss / 1024 ** 2).toFixed(1),
    }, null, 2));
  }
}
