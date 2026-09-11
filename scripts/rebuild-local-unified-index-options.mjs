const VALUE_OPTIONS = Object.freeze({
  "--index": "indexFile",
  "--codex-home": "codexHome",
  "--workers": "workers",
});

function requireDefaultText(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${name} default`);
  }
  return value;
}

function requireWorkerCount(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]*$/u.test(text)) {
    throw new Error("--workers must be a positive integer");
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    throw new Error("--workers must be a safe positive integer");
  }
  return count;
}

export function parseRebuildLocalUnifiedIndexOptions(
  arguments_,
  { defaultIndexFile, defaultCodexHome, defaultWorkers },
) {
  if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== "string")) {
    throw new TypeError("Rebuild arguments must be an array of strings");
  }

  const parsed = {
    indexFile: requireDefaultText("index file", defaultIndexFile),
    codexHome: requireDefaultText("Codex home", defaultCodexHome),
    workers: requireWorkerCount(defaultWorkers),
  };
  const seen = new Set();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!Object.hasOwn(VALUE_OPTIONS, argument)) {
      throw new Error(`Unknown rebuild option: ${argument}`);
    }
    const property = VALUE_OPTIONS[argument];
    if (seen.has(argument)) {
      throw new Error(`Duplicate rebuild option: ${argument}`);
    }
    seen.add(argument);

    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new Error(`Missing value for rebuild option: ${argument}`);
    }
    index += 1;
    parsed[property] = property === "workers" ? requireWorkerCount(value) : value;
  }

  return Object.freeze(parsed);
}
