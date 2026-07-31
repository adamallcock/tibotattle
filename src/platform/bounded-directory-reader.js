import { opendir } from "node:fs/promises";

function defaultLimitError(code) {
  const error = new Error(
    `Bounded directory reader stopped at the ${code} resource limit`,
  );
  error.name = "BoundedReaderResourceLimitError";
  error.code = `export_resource_${code}`;
  return error;
}

export async function readBoundedDirectoryEntries(directory, {
  maximumEntries,
  sort = false,
  createLimitError = defaultLimitError,
} = {}) {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new TypeError("maximumEntries must be a positive safe integer");
  }
  if (typeof sort !== "boolean") throw new TypeError("sort must be boolean");
  if (typeof createLimitError !== "function") {
    throw new TypeError("createLimitError must be a function");
  }

  const entries = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (entries.length >= maximumEntries) {
        throw createLimitError("directory_entries");
      }
      entries.push(entry.name);
    }
  } finally {
    await handle.close().catch((error) => {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return sort ? entries.sort() : entries;
}
