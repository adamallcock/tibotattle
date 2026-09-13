import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, run } from "../src/cli.js";
import {
  createLocalUsageExplainer,
  defaultLocalUsageExplainerPaths,
} from "../src/local-usage-explainer.js";
import { USAGE_EXPLAINER_SCHEMA_VERSION } from "../src/reporting/index.js";

async function captureRun(argv, options) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await run(argv, options);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("default explainer discovery prefers the current production desktop index", () => {
  const homeDirectory = "/Users/synthetic";
  const electronIndex = join(
    homeDirectory,
    "Library",
    "Application Support",
    "TiboTattle",
    "companion-state",
    "local-unified-index-v1.sqlite",
  );
  const nativeIndex = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Usage Monitor",
    "local-unified-index-v1.sqlite",
  );
  const electron = defaultLocalUsageExplainerPaths({
    environment: {},
    homeDirectory,
    platform: "darwin",
    fileExists: (path) => path === electronIndex || path === nativeIndex,
  });
  assert.equal(electron.sourceKind, "electron_production");
  assert.equal(electron.indexFile, electronIndex);

  const native = defaultLocalUsageExplainerPaths({
    environment: {},
    homeDirectory,
    platform: "darwin",
    fileExists: (path) => path === nativeIndex,
  });
  assert.equal(native.sourceKind, "native_production");
  assert.equal(native.indexFile, nativeIndex);

  const overrideRoot = join(homeDirectory, "explicit-state");
  const override = defaultLocalUsageExplainerPaths({
    environment: { USAGE_MONITOR_STATE_ROOT: overrideRoot },
    homeDirectory,
    platform: "darwin",
    fileExists: () => false,
  });
  assert.equal(override.sourceKind, "environment_override");
  assert.equal(
    override.indexFile,
    join(overrideRoot, "local-unified-index-v1.sqlite"),
  );
});

test("an explicit index bypasses invalid ambient state-root discovery", () => {
  assert.doesNotThrow(() => createLocalUsageExplainer({
    environment: { USAGE_MONITOR_STATE_ROOT: "relative-invalid-root" },
    homeDirectory: "/Users/synthetic",
    indexFile: "/tmp/synthetic-index.sqlite",
    secretFile: "/tmp/synthetic-secret",
    codexHome: "/tmp/synthetic-codex",
    readHealth: async () => ({ status: "unavailable" }),
    readWorkUsage: async () => ({ status: "unavailable" }),
    readAllowance: async () => ({ status: "unavailable" }),
  }));
});

test("usage explanation options are closed and command scoped", () => {
  const parsed = parseArgs([
    "explain-usage",
    "--plan", "top_work",
    "--period", "30d",
    "--limit", "7",
    "--cursor", "uec1.synthetic",
    "--index-file", "./synthetic-index.sqlite",
    "--codex-home", "./synthetic-codex",
  ]);
  assert.equal(parsed.command, "explain-usage");
  assert.equal(parsed.usagePlan, "top_work");
  assert.equal(parsed.usagePeriod, "30d");
  assert.equal(parsed.usageLimit, 7);
  assert.equal(parsed.usageCursor, "uec1.synthetic");
  assert.match(parsed.indexFile, /synthetic-index\.sqlite$/u);
  assert.match(parsed.codexHome, /synthetic-codex$/u);

  for (const values of [
    ["doctor", "--plan", "top_work"],
    ["doctor", "--period", "7d"],
    ["doctor", "--limit", "10"],
    ["doctor", "--selector", "ue1.fake"],
    ["doctor", "--cursor", "uec1.fake"],
    ["doctor", "--index-file", "./index.sqlite"],
    ["explain-usage", "--limit", "0"],
    ["explain-usage", "--limit", "1.5"],
  ]) assert.throws(() => parseArgs(values));
});

test("CLI exposes the machine-readable plan catalog without opening the index", async () => {
  let created = false;
  const output = await captureRun(["explain-usage-plans"], {
    createUsageExplainer() {
      created = true;
      throw new Error("should not create explainer");
    },
  });
  const catalog = JSON.parse(output);
  assert.equal(catalog.schemaVersion, USAGE_EXPLAINER_SCHEMA_VERSION);
  assert.equal(catalog.plans.length, 8);
  assert.equal(catalog.pagination.responseField, "nextCursor");
  assert.equal(created, false);
});

test("CLI query emits exactly the structured service result", async () => {
  const calls = [];
  const expected = {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "available",
    plan: "top_work",
    items: [],
  };
  const output = await captureRun([
    "explain-usage",
    "--plan", "top_work",
    "--period", "24h",
    "--limit", "5",
    "--index-file", "/tmp/synthetic-index.sqlite",
    "--codex-home", "/tmp/synthetic-codex",
  ], {
    createUsageExplainer(options) {
      calls.push(["create", options]);
      return {
        async query(request) {
          calls.push(["query", request]);
          return expected;
        },
      };
    },
  });
  assert.deepEqual(JSON.parse(output), expected);
  assert.deepEqual(calls, [
    ["create", {
      indexFile: "/tmp/synthetic-index.sqlite",
      codexHome: "/tmp/synthetic-codex",
    }],
    ["query", {
      schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
      plan: "top_work",
      period: "24h",
      limit: 5,
    }],
  ]);
});

test("CLI forwards an opaque continuation cursor with the bound query", async () => {
  const calls = [];
  const cursor = "uec1.top_work.7d.1.2.1.1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await captureRun([
    "explain-usage",
    "--plan", "top_work",
    "--period", "7d",
    "--limit", "1",
    "--cursor", cursor,
  ], {
    createUsageExplainer() {
      return {
        async query(request) {
          calls.push(request);
          return { status: "available" };
        },
      };
    },
  });
  assert.deepEqual(calls, [{
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    plan: "top_work",
    period: "7d",
    limit: 1,
    cursor,
  }]);
});

test("CLI evidence resolves only the explicit selector", async () => {
  const calls = [];
  const expected = {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "unavailable",
    errorCode: "usage_explainer_selector_stale",
  };
  const output = await captureRun([
    "explain-usage-evidence",
    "--selector", "ue1.top_work.7d.1.2.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ], {
    createUsageExplainer(options) {
      calls.push(["create", options]);
      return {
        async evidence(request) {
          calls.push(["evidence", request]);
          return expected;
        },
      };
    },
  });
  assert.deepEqual(JSON.parse(output), expected);
  assert.deepEqual(calls[1], ["evidence", {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: "ue1.top_work.7d.1.2.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }]);
  await assert.rejects(
    run(["explain-usage"], { createUsageExplainer: () => ({}) }),
    /requires --plan/u,
  );
  await assert.rejects(
    run(["explain-usage-evidence"], { createUsageExplainer: () => ({}) }),
    /requires --selector/u,
  );
});
