import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isProxy } from "node:util/types";

import { readBoundedUtf8Lines } from "./bounded-jsonl-reader.js";

/**
 * Concrete Node ports for the runtime-neutral Codex provider scanner.
 */
function safeDataOption(configuration, name, fallback) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(configuration, name);
    if (descriptor === undefined) return fallback;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("local Codex log ports configuration is invalid");
    }
    const value = descriptor.value;
    return value === undefined ? fallback : value;
  } catch {
    throw new TypeError("local Codex log ports configuration is invalid");
  }
}

export function createLocalCodexLogPorts(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) {
    throw new TypeError("local Codex log ports configuration is invalid");
  }
  const environment = safeDataOption(configuration, "environment", process.env);
  const homeDirectory = safeDataOption(configuration, "homeDirectory", homedir());
  if (!environment || typeof environment !== "object" || isProxy(environment)
      || typeof homeDirectory !== "string") {
    throw new TypeError("local Codex log ports configuration is invalid");
  }
  return Object.freeze({
    filesystem: Object.freeze({
      defaultCodexHome() {
        const codexHome = safeDataOption(environment, "CODEX_HOME", null);
        if (codexHome !== null && typeof codexHome !== "string") {
          throw new TypeError("local Codex log ports configuration is invalid");
        }
        return codexHome ?? join(homeDirectory, ".codex");
      },
      joinPath(...parts) {
        return join(...parts);
      },
      currentUid() {
        return typeof process.getuid === "function" ? process.getuid() : null;
      },
      openDirectory(path) {
        return opendir(path);
      },
      statPath(path) {
        return stat(path);
      },
      lstatPath(path) {
        return lstat(path);
      },
      openReadOnlyNoFollow(path) {
        return open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      },
      createSha256() {
        return createHash("sha256");
      },
      readUtf8Range(path, { start, end }) {
        return createReadStream(path, { start, end, encoding: "utf8" });
      },
      readUtf8LinesRange(path, { start, end }) {
        return createInterface({
          input: createReadStream(path, { start, end, encoding: "utf8" }),
          crlfDelay: Infinity,
        });
      },
    }),
    lineReader: Object.freeze({ readBoundedUtf8Lines }),
  });
}
