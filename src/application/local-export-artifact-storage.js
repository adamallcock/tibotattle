import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
  stableJson,
} from "../export/index.js";
import { isProxy } from "node:util/types";

const REFLECT_APPLY = Reflect.apply;

function boundaryTypeError(message) {
  return new TypeError(message);
}

function guardedRead(object, key, message) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw boundaryTypeError(message);
  }
  return descriptor.value;
}

function guardedFunction(value, message) {
  if (isProxy(value) || typeof value !== "function") throw boundaryTypeError(message);
  return value;
}

const callbackFailures = new WeakMap();

function applicationCallbackFailure(error) {
  const marker = Object.freeze({});
  callbackFailures.set(marker, error);
  return marker;
}

async function invokeApplicationPort(port, receiver, argumentsList, message, {
  preserveResourceLimitError = false,
} = {}) {
  try {
    return await REFLECT_APPLY(port, receiver, argumentsList);
  } catch (error) {
    if (callbackFailures.has(error)) throw callbackFailures.get(error);
    if (preserveResourceLimitError && !isProxy(error)
        && error instanceof ExportResourceLimitError) throw error;
    throw new Error(message);
  }
}

/**
 * Present a reviewed application facade over a platform-bound durable local
 * artifact store. The command composition root supplies its concrete factory.
 */
export function createLocalExportArtifactStorageContext(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || isProxy(configuration) || Array.isArray(configuration)) {
    throw boundaryTypeError("local export artifact storage configuration is required");
  }
  const createStorage = guardedFunction(
    guardedRead(configuration, "createStorage", "local export artifact storage configuration is invalid"),
    "createStorage must be a function",
  );
  const activityMarkerFile = guardedFunction(
    guardedRead(configuration, "activityMarkerFile", "local export artifact storage configuration is invalid"),
    "activityMarkerFile must be a function",
  );
  let storage;
  try {
    storage = REFLECT_APPLY(createStorage, undefined, [{
      stableJson,
      maximumCanonicalBundleBytes:
        DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
      maximumEncodedArtifactBytes:
        DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes,
      maximumDirectoryEntries:
        DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      createResourceLimitError: (code) => new ExportResourceLimitError(code),
    }]);
  } catch {
    throw boundaryTypeError("createStorage must return owner-only export artifact storage");
  }
  if (!storage || typeof storage !== "object" || isProxy(storage)) {
    throw boundaryTypeError("owner-only export artifact storage is required");
  }
  const required = [
    "enumerateOwnerOnlyExportDestinationEntries",
    "openOwnerOnlyExportDestination",
    "projectOwnerOnlyExportArtifactPath",
    "readOwnerOnlyExportArtifactIfPresent",
    "recoverOwnerOnlyPairTransactionsForDestination",
    "recoverOwnerOnlyPairTransactions",
    "recoverOwnerOnlyPairTransactionsUnderLease",
    "withExportDestinationLease",
    "writeOwnerOnlyPairNoClobberForDestination",
    "writeOwnerOnlyPairNoClobber",
    "writeOwnerOnlyPairNoClobberUnderLease",
  ];
  const ports = {};
  for (const name of required) {
    ports[name] = guardedFunction(
      guardedRead(storage, name, "owner-only export artifact storage is invalid"),
      `owner-only export artifact storage.${name} must be a function`,
    );
  }

  const facade = {
    defaultActivityMarkerFile: activityMarkerFile,
    ...Object.fromEntries(required
      .filter((name) => name !== "withExportDestinationLease")
      .map((name) => [name, (...argumentsList) =>
        invokeApplicationPort(
          ports[name],
          storage,
          argumentsList,
          "Local export storage operation failed",
          { preserveResourceLimitError: name === "enumerateOwnerOnlyExportDestinationEntries" },
        )])),
    withExportDestinationLease: async (directory, callback, options) => {
      const leaseCallback = guardedFunction(
        callback,
        "Export destination lease callback is required",
      );
      return invokeApplicationPort(
        ports.withExportDestinationLease,
        storage,
        [directory, async (...argumentsList) => {
          try {
            return await REFLECT_APPLY(leaseCallback, undefined, argumentsList);
          } catch (error) {
            throw applicationCallbackFailure(error);
          }
        }, options],
        "Local export storage operation failed",
      );
    },
  };
  return Object.freeze(facade);
}
