import { isProxy } from "node:util/types";

import { ExportResourceLimitError } from "../export/index.js";
import { createCodexLogScanner } from "../providers/codex/logs.js";

const FILESYSTEM_METHODS = Object.freeze([
  "defaultCodexHome",
  "joinPath",
  "currentUid",
  "readSelectedRolloutNames",
  "openDirectory",
  "statPath",
  "lstatPath",
  "openReadOnlyNoFollow",
  "createSha256",
  "readUtf8Range",
  "readUtf8LinesRange",
]);
const CONFIGURATION_ERROR = "local Codex log scanner configuration is invalid";

function configurationError() {
  throw new TypeError(CONFIGURATION_ERROR);
}

/**
 * Authenticate a caller-supplied proxy detector with this local runtime
 * owner's intrinsic before the detector is ever invoked. Keeping this check
 * here lets the export-source application owner receive the capability
 * explicitly without importing a Node intrinsic in its runtime-neutral
 * implementation directory.
 */
export function validateLocalProxyDetector(detector) {
  if (detector !== isProxy || isProxy(detector)) configurationError();
  return detector;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    configurationError();
  }
  return value;
}

function requireOwnCallable(owner, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, name);
  } catch {
    configurationError();
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
    configurationError();
  }
  return descriptor.value;
}

function snapshotCodexLogPorts(codexLogPorts) {
  const ports = requireObject(codexLogPorts);
  const filesystem = requireObject(requireOwnCallableOwner(ports, "filesystem"));
  const lineReader = requireObject(requireOwnCallableOwner(ports, "lineReader"));
  const safeFilesystem = {};
  for (const name of FILESYSTEM_METHODS) {
    safeFilesystem[name] = requireOwnCallable(filesystem, name);
  }
  const readBoundedUtf8Lines = requireOwnCallable(lineReader, "readBoundedUtf8Lines");
  return Object.freeze({
    filesystem: Object.freeze(safeFilesystem),
    lineReader: Object.freeze({
      // Resource-limit failures must keep the reviewed error identity even
      // though the platform reader itself cannot import the export owner.
      readBoundedUtf8Lines: (source, options) => readBoundedUtf8Lines(source, {
        ...options,
        createLimitError: (code) => new ExportResourceLimitError(code),
      }),
    }),
  });
}

function requireOwnCallableOwner(owner, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, name);
  } catch {
    configurationError();
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value")) configurationError();
  return descriptor.value;
}

/**
 * Node composition owner for the runtime-neutral provider scanner. It accepts
 * concrete local ports, snapshots their own data-callable fields, and never
 * passes an unreviewed object into the provider layer.
 */
export function createLocalCodexLogScanner(codexLogPorts) {
  return createCodexLogScanner(snapshotCodexLogPorts(codexLogPorts));
}
