import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
  ExportResourceLimitError,
  createExportResourceGuard as createPureExportResourceGuard,
  normalizeExportResourceLimits,
} from "./export/index.js";
import {
  readBoundedDirectoryEntries as readPlatformDirectoryEntries,
} from "./platform/index.js";

export {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
  ExportResourceLimitError,
  normalizeExportResourceLimits,
};

export function createExportResourceGuard(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return createPureExportResourceGuard(options);
  }
  return createPureExportResourceGuard({
    ...options,
    ...(Object.hasOwn(options, "clock") ? {} : { clock: () => Date.now() }),
    ...(Object.hasOwn(options, "rss")
      ? {}
      : { rss: () => process.memoryUsage().rss }),
  });
}

export function readBoundedDirectoryEntries(directory, {
  maximumEntries = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
  sort = false,
} = {}) {
  if (
    !Number.isSafeInteger(maximumEntries)
    || maximumEntries < 1
  ) {
    throw new TypeError(
      "maximum directory entries must be a positive safe integer",
    );
  }
  if (
    maximumEntries
    > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries
  ) {
    throw new TypeError(
      "maximum directory entries cannot exceed the compatibility-bound candidate ceiling",
    );
  }
  return readPlatformDirectoryEntries(directory, {
    maximumEntries,
    sort,
    createLimitError: (code) => new ExportResourceLimitError(code),
  });
}
