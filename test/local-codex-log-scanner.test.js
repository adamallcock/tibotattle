import assert from "node:assert/strict";
import test from "node:test";

import { createLocalCodexLogScanner } from "../src/application/index.js";
import { createLocalCodexLogPorts } from "../src/platform/index.js";

const PRIVATE_CANARY = "private-local-codex-scanner-canary";
const CONFIGURATION_ERROR = "local Codex log scanner configuration is invalid";
const FILESYSTEM_METHODS = Object.freeze([
  "defaultCodexHome",
  "joinPath",
  "currentUid",
  "openDirectory",
  "statPath",
  "lstatPath",
  "openReadOnlyNoFollow",
  "createSha256",
  "readUtf8Range",
  "readUtf8LinesRange",
]);

function completePorts(overrides = {}) {
  const filesystem = Object.fromEntries(
    FILESYSTEM_METHODS.map((name) => [name, () => null]),
  );
  return {
    filesystem: { ...filesystem, ...(overrides.filesystem ?? {}) },
    lineReader: {
      readBoundedUtf8Lines: async function* readBoundedUtf8Lines() {},
      ...(overrides.lineReader ?? {}),
    },
  };
}

function assertFixedConfigurationError(callback) {
  assert.throws(callback, (error) => error instanceof TypeError
    && error.message === CONFIGURATION_ERROR
    && !`${error.stack}${JSON.stringify(error)}`.includes(PRIVATE_CANARY));
}

test("application scanner composition accepts concrete local Codex ports", () => {
  const scanner = createLocalCodexLogScanner(createLocalCodexLogPorts({
    environment: {},
    homeDirectory: "/application-scanner-home",
  }));
  assert.deepEqual(Object.keys(scanner).sort(), [
    "appendedRolloutSourcesAreAfterEnd",
    "codexLogSourceFingerprint",
    "discoverCodexRolloutInfos",
    "discoverCodexRollouts",
    "hasForkReplayPrefix",
    "readRolloutLineage",
    "scanCodexLogEvents",
    "summarizeCodexRolloutSources",
  ]);
});

test("application scanner rejects proxied, accessor, and callable-proxy ports without canaries", () => {
  const accessorPorts = {};
  Object.defineProperty(accessorPorts, "filesystem", {
    get() {
      throw new Error(PRIVATE_CANARY);
    },
  });
  Object.defineProperty(accessorPorts, "lineReader", {
    value: {},
  });
  const callableFilesystem = completePorts({
    filesystem: {
      defaultCodexHome: new Proxy(() => "/private", {}),
    },
  });
  const callableLineReader = completePorts({
    lineReader: {
      readBoundedUtf8Lines: new Proxy(async function* readBoundedUtf8Lines() {}, {}),
    },
  });

  for (const ports of [
    new Proxy(completePorts(), {
      get() {
        throw new Error(PRIVATE_CANARY);
      },
    }),
    accessorPorts,
    {
      filesystem: new Proxy(completePorts().filesystem, {
        get() {
          throw new Error(PRIVATE_CANARY);
        },
      }),
      lineReader: completePorts().lineReader,
    },
    callableFilesystem,
    callableLineReader,
  ]) {
    assertFixedConfigurationError(() => createLocalCodexLogScanner(ports));
  }
});
