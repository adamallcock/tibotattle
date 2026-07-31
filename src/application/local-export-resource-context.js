import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
  createExportResourceGuard,
} from "../export/index.js";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

export function createLocalExportResourceContext({
  readBoundedJsonLines,
  clock,
  rss,
} = {}) {
  const readJsonLines = requireFunction(
    readBoundedJsonLines,
    "readBoundedJsonLines",
  );
  const readClock = requireFunction(clock, "clock");
  const readRss = requireFunction(rss, "rss");
  const createLimitError = (code) => new ExportResourceLimitError(code);

  return Object.freeze({
    createGuard(options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return createExportResourceGuard(options);
      }
      return createExportResourceGuard({
        ...options,
        ...(Object.hasOwn(options, "clock") ? {} : { clock: readClock }),
        ...(Object.hasOwn(options, "rss") ? {} : { rss: readRss }),
      });
    },
    readActivityMarkers(path, { resourceGuard = null } = {}) {
      return readJsonLines(path, {
        maximumFileBytes:
          DEFAULT_EXPORT_RESOURCE_LIMITS.maximumExpandedRecordBytes,
        maximumLineBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumLineBytes,
        maximumRecords: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
        resourceGuard,
        createLimitError,
      });
    },
  });
}
