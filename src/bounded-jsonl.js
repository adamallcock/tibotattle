import { ExportResourceLimitError } from "./export/index.js";
import {
  readBoundedJsonLines as readPlatformJsonLines,
  readBoundedUtf8LineEntries as readPlatformLineEntries,
  readBoundedUtf8Lines as readPlatformLines,
} from "./platform/index.js";

const createLimitError = (code) => new ExportResourceLimitError(code);

export function readBoundedUtf8LineEntries(path, options = {}) {
  return readPlatformLineEntries(path, {
    ...options,
    createLimitError,
  });
}

export function readBoundedUtf8Lines(path, options = {}) {
  return readPlatformLines(path, {
    ...options,
    createLimitError,
  });
}

export function readBoundedJsonLines(path, options = {}) {
  return readPlatformJsonLines(path, {
    ...options,
    createLimitError,
  });
}
