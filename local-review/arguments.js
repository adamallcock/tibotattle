import { resolve } from "node:path";

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(argv, index, option) {
  const value = Number(optionValue(argv, index, option));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return value;
}

export function parseLocalReviewArgs(argv) {
  const result = {
    command: argv[0] ?? "help",
    startAt: null,
    endAt: null,
    outputFile: null,
    inputFile: null,
    receiptFile: null,
    directory: null,
    workspaceDirectory: null,
    codexHome: null,
    collectorFile: null,
    activityFile: null,
    exportSecretFile: null,
    claudeStatus: false,
    claudeStateDirectory: null,
    claudeUsage: false,
    claudeProjectsDirectory: null,
    resume: false,
    confirm: false,
    confirmDeletionToken: null,
    confirmDiscardToken: null,
    confirmRemovalToken: null,
    confirmUninstallToken: null,
    maximumRecordsPerChunk: null,
    maximumCanonicalBundleBytes: null,
    maximumEncodedArtifactBytes: null,
    target: null,
    artifactRoot: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--since") result.startAt = optionValue(argv, index++, arg);
    else if (arg === "--until") result.endAt = optionValue(argv, index++, arg);
    else if (arg === "--output") result.outputFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--input") result.inputFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--receipt") result.receiptFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--directory") result.directory = resolve(optionValue(argv, index++, arg));
    else if (arg === "--workspace") result.workspaceDirectory = resolve(optionValue(argv, index++, arg));
    else if (arg === "--codex-home") result.codexHome = resolve(optionValue(argv, index++, arg));
    else if (arg === "--collector-file") result.collectorFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--activity-file") result.activityFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--secret-file") result.exportSecretFile = resolve(optionValue(argv, index++, arg));
    else if (arg === "--claude-status") result.claudeStatus = true;
    else if (arg === "--claude-state-dir") result.claudeStateDirectory = resolve(optionValue(argv, index++, arg));
    else if (arg === "--claude-usage") result.claudeUsage = true;
    else if (arg === "--claude-projects-dir") result.claudeProjectsDirectory = resolve(optionValue(argv, index++, arg));
    else if (arg === "--resume") result.resume = true;
    else if (arg === "--confirm") result.confirm = true;
    else if (arg === "--confirm-deletion") result.confirmDeletionToken = optionValue(argv, index++, arg);
    else if (arg === "--confirm-discard") result.confirmDiscardToken = optionValue(argv, index++, arg);
    else if (arg === "--confirm-removal") result.confirmRemovalToken = optionValue(argv, index++, arg);
    else if (arg === "--confirm-uninstall") result.confirmUninstallToken = optionValue(argv, index++, arg);
    else if (arg === "--max-records-per-chunk") {
      result.maximumRecordsPerChunk = positiveInteger(argv, index++, arg);
    } else if (arg === "--max-bundle-bytes") {
      result.maximumCanonicalBundleBytes = positiveInteger(argv, index++, arg);
    } else if (arg === "--max-artifact-bytes") {
      result.maximumEncodedArtifactBytes = positiveInteger(argv, index++, arg);
    } else if (arg === "--target") {
      result.target = optionValue(argv, index++, arg);
    } else if (arg === "--artifact-root") {
      result.artifactRoot = resolve(optionValue(argv, index++, arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (result.claudeStatus && result.claudeStateDirectory !== null) {
    throw new Error("export-set accepts either --claude-status or --claude-state-dir, not both");
  }
  if ((result.claudeStatus || result.claudeStateDirectory !== null
      || result.claudeUsage || result.claudeProjectsDirectory !== null)
      && result.command !== "export-set") {
    throw new Error("Claude export options are available only for export-set");
  }
  if (result.confirmRemovalToken !== null
      && result.command !== "remove-claude-callback-identity") {
    throw new Error("--confirm-removal is available only for remove-claude-callback-identity");
  }
  if (result.confirmUninstallToken !== null && result.command !== "uninstall") {
    throw new Error("--confirm-uninstall is available only for uninstall");
  }
  if (result.target !== null && !["install", "uninstall"].includes(result.command)) {
    throw new Error("--target is available only for install and uninstall");
  }
  return result;
}
