import { resolve } from "node:path";

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function boundedPort(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("--port requires an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--port must be between 1024 and 65535");
  }
  return port;
}

export function parseLocalBackendLabArguments(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Backend laboratory arguments must be strings");
  }
  const valueOptions = new Set(["--port", "--state-directory", "--file"]);
  const flagOptions = new Set([
    "--exit-after-receipt",
    "--generated-content-free-fixture",
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!valueOptions.has(argument) && !flagOptions.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (flagOptions.has(argument)) continue;
    index += 1;
    if (!args[index] || args[index].startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
  }
  const contributionFile = optionValue(args, "--file");
  const explicitGeneratedFixture =
    args.includes("--generated-content-free-fixture");
  if (contributionFile && explicitGeneratedFixture) {
    throw new Error(
      "--file and --generated-content-free-fixture are mutually exclusive",
    );
  }
  const source = contributionFile
    ? Object.freeze({
        mode: "prepared_contribution",
        contributionFile: resolve(contributionFile),
      })
    : Object.freeze({
        mode: "generated_content_free_fixture",
        contributionFile: null,
      });
  return Object.freeze({
    port: boundedPort(optionValue(args, "--port", "8792")),
    stateDirectory: optionValue(args, "--state-directory"),
    exitAfterReceipt: args.includes("--exit-after-receipt"),
    source,
  });
}

export function backendSmokeSourceArguments(source) {
  if (source?.mode === "prepared_contribution"
      && typeof source.contributionFile === "string") {
    return ["--file", source.contributionFile];
  }
  if (source?.mode === "generated_content_free_fixture"
      && source.contributionFile === null) {
    return ["--generated-content-free-fixture"];
  }
  throw new TypeError("Backend laboratory contribution source is invalid");
}

export function projectLocalBackendLabReceipt({
  receipt,
  sourceMode,
  locations,
} = {}) {
  if (!receipt || typeof receipt !== "object") {
    throw new TypeError("Backend laboratory receipt is required");
  }
  if (sourceMode === "prepared_contribution") {
    return Object.freeze({
      ...receipt,
      source: Object.freeze({
        mode: "prepared_contribution",
        containsRawLogs: false,
      }),
      cleanup: Object.freeze({
        automaticOnShutdown: false,
        disposition: "retained_for_explicit_caller_cleanup",
        recoverableCleanupRequired: true,
      }),
    });
  }
  if (sourceMode !== "generated_content_free_fixture"
      || typeof locations?.stateDirectory !== "string"
      || typeof locations?.participantAccessFile !== "string"
      || typeof locations?.redeemedInvitationDirectory !== "string"
      || !Number.isSafeInteger(locations?.redeemedInvitationFilesRetained)) {
    throw new TypeError("Backend laboratory receipt projection is invalid");
  }
  return Object.freeze({
    ...receipt,
    source: Object.freeze({
      mode: "generated_content_free_fixture",
      containsRawLogs: false,
    }),
    stateDirectory: locations.stateDirectory,
    participantAccessFile: locations.participantAccessFile,
    participantAccessFileContainsSecret: true,
    redeemedInvitationDirectory: locations.redeemedInvitationDirectory,
    redeemedInvitationFilesRetained:
      locations.redeemedInvitationFilesRetained,
    cleanup: Object.freeze({
      automaticOnShutdown: false,
      instruction:
        "Stop the lab, inspect the exact stateDirectory, then move that directory to Trash.",
    }),
  });
}
