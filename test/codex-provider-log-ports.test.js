import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  CodexLogSourceChangedError,
  createCodexLogScanner,
} from "../src/providers/codex/logs.js";

const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const VIRTUAL_CODEX_HOME = "/virtual/codex";
const ROLLOUT_NAME = "rollout-2026-07-24T12-00-00-port-contract.jsonl";
const ROLLOUT_PATH = `${VIRTUAL_CODEX_HOME}/archived_sessions/${ROLLOUT_NAME}`;
const MAXIMUM_APPEND_PROOF_BYTES = 8 * 1024 * 1024;
const PRIVATE_FAILURE_CANARY = "private-append-reader-canary";
const PORT_CONFIGURATION_ERROR = "createCodexLogScanner ports are invalid";

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

const RELEVANT_LINE_NEEDLES = Object.freeze([
  '"type":"session_meta"',
  '"type":"turn_context"',
  '"type":"thread_settings_applied"',
  '"type":"token_count"',
  '"type":"task_started"',
  '"type":"task_complete"',
  '"type":"custom_tool_call"',
  '"type":"function_call"',
  '"type":"web_search_call"',
  '"type":"file_search_call"',
  '"type":"code_interpreter_call"',
  '"type":"shell_call"',
  '"type":"computer_call"',
  '"type":"mcp_call"',
  '"type":"apply_patch_call"',
  '"type":"local_shell_call"',
]);

function asyncEntries(values = []) {
  return (async function* iterate() {
    yield* values;
  })();
}

function completeFilesystem(overrides = {}) {
  return {
    defaultCodexHome: () => VIRTUAL_CODEX_HOME,
    joinPath: (...parts) => posix.join(...parts),
    currentUid: () => 501,
    openDirectory: async () => asyncEntries(),
    statPath: async () => {
      throw new Error("unexpected statPath call");
    },
    lstatPath: async () => {
      throw new Error("unexpected lstatPath call");
    },
    openReadOnlyNoFollow: async () => {
      throw new Error("unexpected openReadOnlyNoFollow call");
    },
    createSha256: () => createHash("sha256"),
    readUtf8Range: async function* readUtf8Range() {},
    readUtf8LinesRange: async function* readUtf8LinesRange() {},
    ...overrides,
  };
}

function completeLineReader(readBoundedUtf8Lines = async function* emptyLines() {}) {
  return { readBoundedUtf8Lines };
}

function sessionMetadataLine(sessionId = "session-port-contract") {
  return JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId },
  });
}

function virtualDiscoveryScanner(rootSpecs) {
  const directories = new Map();
  const files = new Map();
  const metadata = new Map();
  const openFailures = new Map();
  let nextInode = 100;
  for (const root of rootSpecs) {
    const sessions = posix.join(root.path, "sessions");
    const archived = posix.join(root.path, "archived_sessions");
    const entries = [];
    for (const file of root.files ?? []) {
      const path = posix.join(sessions, file.name);
      const bytes = Buffer.isBuffer(file.bytes)
        ? file.bytes
        : Buffer.from(file.bytes, "utf8");
      const stats = {
        dev: root.dev ?? 1,
        ino: nextInode++,
        size: bytes.length,
        mtimeMs: file.mtimeMs ?? Date.parse("2026-07-24T12:30:00.000Z"),
        ctimeMs: file.mtimeMs ?? Date.parse("2026-07-24T12:30:00.000Z"),
        birthtimeMs: Date.parse("2026-07-24T12:00:00.000Z"),
        uid: 501,
        nlink: 1,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
      entries.push({
        name: file.name,
        isDirectory: () => false,
        isFile: () => true,
      });
      files.set(path, bytes);
      metadata.set(path, stats);
    }
    if (root.brokenNested === true) {
      entries.push({
        name: "broken",
        isDirectory: () => true,
        isFile: () => false,
      });
      const error = new Error("virtual inaccessible directory");
      error.code = "EACCES";
      openFailures.set(posix.join(sessions, "broken"), error);
    }
    directories.set(sessions, entries);
    directories.set(archived, []);
  }
  const filesystem = completeFilesystem({
    openDirectory: async (path) => {
      const failure = openFailures.get(path);
      if (failure !== undefined) throw failure;
      if (!directories.has(path)) {
        const error = new Error("virtual directory missing");
        error.code = "ENOENT";
        throw error;
      }
      return asyncEntries(directories.get(path));
    },
    statPath: async (path) => metadata.get(path),
    lstatPath: async (path) => metadata.get(path),
    openReadOnlyNoFollow: async (path) => {
      const bytes = files.get(path);
      const stats = metadata.get(path);
      let closed = false;
      return {
        async stat() {
          assert.equal(closed, false);
          return stats;
        },
        async read(target, offset, length, position) {
          assert.equal(closed, false);
          const copied = bytes.copy(target, offset, position, position + length);
          return { bytesRead: copied };
        },
        async close() {
          closed = true;
        },
      };
    },
  });
  const lineReader = completeLineReader(async function* readLines(source) {
    const bytes = files.get(source);
    if (bytes === undefined) return;
    yield* bytes.toString("utf8").split("\n").filter(Boolean);
  });
  return createCodexLogScanner({ filesystem, lineReader });
}

function scanLines() {
  return [
    sessionMetadataLine(),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 11,
          },
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 11,
          },
        },
      },
    }),
  ];
}

function resourceGuard(maximumLineBytes = 1_337) {
  return {
    limits: { maximumLineBytes },
    observeDirectoryEntry() {},
    observeSourcePlan() {},
    checkRuntime() {},
  };
}

function assertFixedPortError(callback, message) {
  assert.throws(callback, (error) => {
    assert.equal(error?.name, "TypeError");
    assert.equal(error?.message, message);
    assert.equal(error.message.includes(PRIVATE_FAILURE_CANARY), false);
    return true;
  });
}

test("scanner factory fails immediately with fixed errors for missing or incomplete ports", () => {
  assertFixedPortError(
    () => createCodexLogScanner(),
    "createCodexLogScanner options are required",
  );

  const lineReader = completeLineReader();
  for (const missingMethod of FILESYSTEM_METHODS) {
    const filesystem = completeFilesystem();
    delete filesystem[missingMethod];
    assertFixedPortError(
      () => createCodexLogScanner({ filesystem, lineReader }),
      `filesystem.${missingMethod} must be a function`,
    );
  }

  assertFixedPortError(
    () => createCodexLogScanner({
      filesystem: completeFilesystem(),
      lineReader: {},
    }),
    "lineReader.readBoundedUtf8Lines must be a function",
  );
});

test("lineage forwards the bounded-reader policy, byte ceiling, guard, and signal exactly", async () => {
  const calls = [];
  const guard = resourceGuard(4_321);
  const signal = new AbortController().signal;
  const scanner = createCodexLogScanner({
    filesystem: completeFilesystem(),
    lineReader: completeLineReader(async function* readBoundedUtf8Lines(source, options) {
      calls.push({ source, options });
      yield sessionMetadataLine();
    }),
  });

  const lineage = await scanner.readRolloutLineage(ROLLOUT_PATH, {
    resourceGuard: guard,
    maximumTotalBytes: 987_654,
    signal,
  });

  assert.equal(lineage.sessionId, "session-port-contract");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, ROLLOUT_PATH);
  assert.equal(calls[0].options.maximumLineBytes, 4_321);
  assert.equal(calls[0].options.maximumTotalBytes, 987_654);
  assert.equal(calls[0].options.resourceGuard, guard);
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].options.oversizedIrrelevantNeedles, RELEVANT_LINE_NEEDLES);
});

test("discovery preserves unbounded lineage reads while scan passes use the discovered source size", async () => {
  const sourceSize = 6_789;
  const guard = resourceGuard(5_432);
  const signal = new AbortController().signal;
  const calls = [];
  const archivedRoot = `${VIRTUAL_CODEX_HOME}/archived_sessions`;
  const filesystem = completeFilesystem({
    openDirectory: async (path) => asyncEntries(path === archivedRoot
      ? [{
        name: ROLLOUT_NAME,
        isDirectory: () => false,
        isFile: () => true,
      }]
      : []),
    statPath: async (path) => {
      assert.equal(path, ROLLOUT_PATH);
      return {
        dev: 12,
        ino: 34,
        size: sourceSize,
        mtimeMs: Date.parse("2026-07-24T12:30:00.000Z"),
        ctimeMs: Date.parse("2026-07-24T12:30:00.000Z"),
        birthtimeMs: Date.parse("2026-07-24T12:00:00.000Z"),
      };
    },
  });
  const scanner = createCodexLogScanner({
    filesystem,
    lineReader: completeLineReader(async function* readBoundedUtf8Lines(source, options) {
      calls.push({ source, options });
      yield* scanLines();
    }),
  });

  const rolloutInfos = await scanner.discoverCodexRolloutInfos({
    startAt: START_AT,
    endAt: END_AT,
    resourceGuard: guard,
    signal,
  });
  assert.equal(rolloutInfos.length, 1);
  assert.equal(rolloutInfos[0].size, sourceSize);
  assert.equal(rolloutInfos[0].location, "archive");
  const discoveryCallCount = calls.length;
  assert.equal(discoveryCallCount, 1);
  assert.equal(calls[0].source, ROLLOUT_PATH);
  assert.equal(calls[0].options.maximumLineBytes, guard.limits.maximumLineBytes);
  assert.equal(calls[0].options.maximumTotalBytes, Number.POSITIVE_INFINITY);
  assert.equal(calls[0].options.resourceGuard, guard);
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].options.oversizedIrrelevantNeedles, RELEVANT_LINE_NEEDLES);

  await scanner.scanCodexLogEvents({
    startAt: START_AT,
    endAt: END_AT,
    rolloutInfos,
    resourceGuard: guard,
    signal,
  });

  assert.ok(calls.length > discoveryCallCount);
  for (const call of calls.slice(discoveryCallCount)) {
    assert.equal(call.source, ROLLOUT_PATH);
    assert.equal(call.options.maximumLineBytes, guard.limits.maximumLineBytes);
    assert.equal(call.options.maximumTotalBytes, sourceSize);
    assert.equal(call.options.resourceGuard, guard);
    assert.equal(call.options.signal, signal);
    assert.deepEqual(call.options.oversizedIrrelevantNeedles, RELEVANT_LINE_NEEDLES);
  }
});

test("a discovery limit discards the affected root as partial", async () => {
  const archivedRoot = `${VIRTUAL_CODEX_HOME}/archived_sessions`;
  const privateSecondName = "rollout-2026-07-24T12-00-01-private-limit-canary.jsonl";
  const scanner = createCodexLogScanner({
    filesystem: completeFilesystem({
      openDirectory: async (path) => asyncEntries(path === archivedRoot
        ? [{
          name: ROLLOUT_NAME,
          isDirectory: () => false,
          isFile: () => true,
        }, {
          name: privateSecondName,
          isDirectory: () => false,
          isFile: () => true,
        }]
        : []),
      statPath: async () => ({
        dev: 12,
        ino: 34,
        size: 6789,
        mtimeMs: Date.parse("2026-07-24T12:30:00.000Z"),
        ctimeMs: Date.parse("2026-07-24T12:30:00.000Z"),
        birthtimeMs: Date.parse("2026-07-24T12:00:00.000Z"),
      }),
    }),
    lineReader: completeLineReader(),
  });

  const infos = await scanner.discoverCodexRolloutInfos({
    startAt: START_AT,
    endAt: END_AT,
    discoveryLimits: {
      maximumDirectoryEntries: 10,
      maximumRolloutFiles: 1,
    },
  });
  assert.deepEqual([...infos], []);
  assert.deepEqual(infos.rootCoverage, {
    status: "partial",
    configuredRoots: 1,
    availableRoots: 1,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  });
  assert.equal(JSON.stringify(infos).includes(privateSecondName), false);
  assert.deepEqual(infos.discoveryFailureCodes, [
    "codex_log_discovery_rollout_files",
  ]);
  assert.equal(JSON.stringify(infos).includes("codex_log_discovery_rollout_files"), false);
  assert.equal(infos.availableRootOwnerKeys.length, 0);
  assert.equal(infos.unavailableRootOwnerKeys.length, 1);
});

test("discovery ceilings are root-local so a healthy root still advances", async () => {
  const limitedFirst = "rollout-2026-07-24T12-00-00-limited-a.jsonl";
  const limitedSecond = "rollout-2026-07-24T12-00-01-limited-b.jsonl";
  const healthyName = "rollout-2026-07-24T12-00-02-healthy.jsonl";
  const scanner = virtualDiscoveryScanner([{
    path: "/virtual/limited",
    files: [{
      name: limitedFirst,
      bytes: `${sessionMetadataLine("10000000-0000-4000-8000-000000000011")}\n`,
    }, {
      name: limitedSecond,
      bytes: `${sessionMetadataLine("10000000-0000-4000-8000-000000000012")}\n`,
    }],
  }, {
    path: "/virtual/healthy",
    files: [{
      name: healthyName,
      bytes: `${sessionMetadataLine("10000000-0000-4000-8000-000000000013")}\n`,
    }],
  }]);

  const infos = await scanner.discoverCodexRolloutInfos({
    codexHomes: ["/virtual/limited", "/virtual/healthy"],
    startAt: START_AT,
    endAt: END_AT,
    discoveryLimits: {
      maximumDirectoryEntries: 10,
      maximumRolloutFiles: 1,
    },
  });

  assert.deepEqual(infos.map((info) => info.rolloutKey), [healthyName]);
  assert.deepEqual(infos.rootCoverage, {
    status: "partial",
    configuredRoots: 2,
    availableRoots: 2,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  });
  assert.equal(infos.availableRootOwnerKeys.length, 1);
  assert.equal(infos.unavailableRootOwnerKeys.length, 1);
});

test("multi-root discovery is order-independent and resolves lineage across roots", async () => {
  const parentName = "rollout-2026-07-24T11-30-00-parent.jsonl";
  const childName = "rollout-2026-07-24T12-00-00-child.jsonl";
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const parent = sessionMetadataLine(parentId);
  const child = JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: childId, forked_from_id: parentId },
  });
  const scanner = virtualDiscoveryScanner([{
    path: "/virtual/root-a",
    files: [{ name: parentName, bytes: `${parent}\n` }],
  }, {
    path: "/virtual/root-b",
    files: [{ name: childName, bytes: `${child}\n` }],
  }]);
  const first = await scanner.discoverCodexRolloutInfos({
    codexHomes: [
      { path: "/virtual/root-b", id: "root-b" },
      { path: "/virtual/root-a", id: "root-a" },
    ],
    startAt: START_AT,
    endAt: END_AT,
  });
  const second = await scanner.discoverCodexRolloutInfos({
    codexHomes: [
      { path: "/virtual/root-a", id: "root-a" },
      { path: "/virtual/root-b", id: "root-b" },
    ],
    startAt: START_AT,
    endAt: END_AT,
  });
  const project = (infos) => infos.map((info) => ({
    rolloutKey: info.rolloutKey,
    sessionId: info.lineage.sessionId,
    parentId: info.lineage.parentId,
    rootOwnerKey: info.rootOwnerKey,
  }));
  assert.deepEqual(project(first), project(second));
  assert.deepEqual(first.map((info) => info.rolloutKey), [parentName, childName]);
  assert.deepEqual(first.rootCoverage, {
    status: "ready",
    configuredRoots: 2,
    availableRoots: 2,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  });
  assert.equal(JSON.stringify(first.rootCoverage).includes("/virtual"), false);
  const firstFingerprint = await scanner.codexLogSourceFingerprint({
    codexHomes: ["/virtual/root-b", "/virtual/root-a"],
    startAt: START_AT,
    endAt: END_AT,
  });
  const secondFingerprint = await scanner.codexLogSourceFingerprint({
    codexHomes: ["/virtual/root-a", "/virtual/root-b"],
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.deepEqual(firstFingerprint, secondFingerprint);
});

test("same-key replicas require a raw-byte prefix and choose one deterministic owner", async () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const prefix = `${sessionMetadataLine(sessionId)}\n`;
  const longer = `${prefix}${JSON.stringify({
    timestamp: "2026-07-24T12:01:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  })}\n`;
  const scanner = virtualDiscoveryScanner([{
    path: "/virtual/replica-a",
    files: [{ name: ROLLOUT_NAME, bytes: prefix }],
  }, {
    path: "/virtual/replica-b",
    files: [{ name: ROLLOUT_NAME, bytes: longer }],
  }]);
  const options = (codexHomes) => ({ codexHomes, startAt: START_AT, endAt: END_AT });
  const first = await scanner.discoverCodexRolloutInfos(options([
    { path: "/virtual/replica-a", id: "replica-a" },
    { path: "/virtual/replica-b", id: "replica-b" },
  ]));
  const second = await scanner.discoverCodexRolloutInfos(options([
    { path: "/virtual/replica-b", id: "replica-b" },
    { path: "/virtual/replica-a", id: "replica-a" },
  ]));
  assert.equal(first.length, 1);
  assert.equal(first[0].path, `/virtual/replica-b/sessions/${ROLLOUT_NAME}`);
  assert.equal(first[0].physicalCandidates.length, 2);
  assert.equal(first[0].rootOwnerKey, second[0].rootOwnerKey);
  assert.equal(first.rootCoverage.status, "ready");
});

test("same-key divergent or conflicting replicas are omitted without blocking healthy roots", async () => {
  const sharedId = "44444444-4444-4444-8444-444444444444";
  const meta = Buffer.from(`${sessionMetadataLine(sharedId)}\n`, "utf8");
  // 0xff and 0xfe both decode to U+FFFD. A string round-trip comparison would
  // falsely equate them; the provider must hash the original bytes.
  const divergentA = Buffer.concat([meta, Buffer.from([0xff, 0x0a])]);
  const divergentB = Buffer.concat([meta, Buffer.from([0xfe, 0x0a])]);
  const healthyName = "rollout-2026-07-24T12-00-01-healthy.jsonl";
  const scanner = virtualDiscoveryScanner([{
    path: "/virtual/divergent-a",
    files: [{ name: ROLLOUT_NAME, bytes: divergentA }],
  }, {
    path: "/virtual/divergent-b",
    files: [{ name: ROLLOUT_NAME, bytes: divergentB }],
  }, {
    path: "/virtual/healthy",
    files: [{ name: healthyName, bytes: `${sessionMetadataLine(
      "55555555-5555-4555-8555-555555555555",
    )}\n` }],
  }]);
  const infos = await scanner.discoverCodexRolloutInfos({
    codexHomes: [
      { path: "/virtual/divergent-a", id: "divergent-a" },
      { path: "/virtual/divergent-b", id: "divergent-b" },
      { path: "/virtual/healthy", id: "healthy" },
    ],
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.deepEqual(infos.map((info) => info.rolloutKey), [healthyName]);
  assert.equal(infos.rootCoverage.status, "partial");
  assert.equal(infos.rootCoverage.ambiguousSources, 1);

  const conflicting = virtualDiscoveryScanner([{
    path: "/virtual/conflict-a",
    files: [{ name: ROLLOUT_NAME, bytes: `${sessionMetadataLine(sharedId)}\n` }],
  }, {
    path: "/virtual/conflict-b",
    files: [{ name: ROLLOUT_NAME, bytes: `${sessionMetadataLine(
      "66666666-6666-4666-8666-666666666666",
    )}\n` }],
  }]);
  const conflictInfos = await conflicting.discoverCodexRolloutInfos({
    codexHomes: ["/virtual/conflict-a", "/virtual/conflict-b"],
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.equal(conflictInfos.length, 0);
  assert.equal(conflictInfos.rootCoverage.status, "partial");
  assert.equal(conflictInfos.rootCoverage.ambiguousSources, 1);

  const distinctKeys = virtualDiscoveryScanner([{
    path: "/virtual/distinct",
    files: [{
      name: "rollout-2026-07-24T12-00-00-distinct-a.jsonl",
      bytes: `${sessionMetadataLine(sharedId)}\n`,
    }, {
      name: "rollout-2026-07-24T12-00-01-distinct-b.jsonl",
      bytes: `${sessionMetadataLine(sharedId)}\n`,
    }],
  }]);
  await assert.rejects(distinctKeys.discoverCodexRolloutInfos({
    codexHomes: ["/virtual/distinct"],
    startAt: START_AT,
    endAt: END_AT,
  }), /distinct rollout files/u);
});

test("an unsafe partial root contributes no truncated candidate subset", async () => {
  const unsafeName = "rollout-2026-07-24T12-00-00-unsafe.jsonl";
  const healthyName = "rollout-2026-07-24T12-00-01-safe.jsonl";
  const scanner = virtualDiscoveryScanner([{
    path: "/virtual/unsafe",
    files: [{ name: unsafeName, bytes: `${sessionMetadataLine()}\n` }],
    brokenNested: true,
  }, {
    path: "/virtual/safe",
    files: [{ name: healthyName, bytes: `${sessionMetadataLine(
      "77777777-7777-4777-8777-777777777777",
    )}\n` }],
  }]);
  const infos = await scanner.discoverCodexRolloutInfos({
    codexHomes: ["/virtual/unsafe", "/virtual/safe"],
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.deepEqual(infos.map((info) => info.rolloutKey), [healthyName]);
  assert.equal(infos.rootCoverage.status, "partial");
  assert.equal(infos.rootCoverage.availableRoots, 2);
});

test("coverage distinguishes an existing empty home from an unavailable home", async () => {
  const emptyRoot = "/virtual/empty-home";
  const missingRoot = "/virtual/missing-home";
  const scanner = createCodexLogScanner({
    filesystem: completeFilesystem({
      openDirectory: async () => {
        const error = new Error("virtual source directory missing");
        error.code = "ENOENT";
        throw error;
      },
      statPath: async (path) => {
        if (path === emptyRoot) return { isDirectory: () => true };
        const error = new Error("virtual home missing");
        error.code = "ENOENT";
        throw error;
      },
    }),
    lineReader: completeLineReader(),
  });
  const infos = await scanner.discoverCodexRolloutInfos({
    codexHomes: [emptyRoot, missingRoot],
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.equal(infos.length, 0);
  assert.equal(infos.rootCoverage.status, "partial");
  assert.equal(infos.rootCoverage.availableRoots, 1);
  assert.equal(infos.rootCoverage.emptyRoots, 1);
  assert.equal(infos.rootCoverage.unavailableRoots, 1);
});

test("root validation rejects mixed, duplicate, and oversized inputs before traversal", async () => {
  let traversals = 0;
  const scanner = createCodexLogScanner({
    filesystem: completeFilesystem({
      openDirectory: async () => {
        traversals += 1;
        return asyncEntries();
      },
    }),
    lineReader: completeLineReader(),
  });
  const discover = (options) => scanner.discoverCodexRolloutInfos({
    ...options,
    startAt: START_AT,
    endAt: END_AT,
  });
  await assert.rejects(discover({
    codexHome: "/virtual/a",
    codexHomes: ["/virtual/b"],
  }), /mutually exclusive/u);
  await assert.rejects(discover({
    codexHomes: ["/virtual/a", "/virtual/a"],
  }), /identities must be unique/u);
  await assert.rejects(discover({
    codexHomes: [
      { path: "/virtual/a", id: "same" },
      { path: "/virtual/b", id: "same" },
    ],
  }), /identities must be unique/u);
  await assert.rejects(discover({
    codexHomes: Array.from({ length: 9 }, (_, index) => `/virtual/${index}`),
  }), /between 1 and 8/u);
  assert.equal(traversals, 0);
});

function activeSourceFixture({ appendError = null } = {}) {
  const prefix = Buffer.from(`${scanLines().join("\n")}\n`, "utf8");
  const appended = Buffer.from(`${JSON.stringify({
    timestamp: "2026-07-24T14:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  })}\n`, "utf8");
  const bytes = Buffer.concat([prefix, appended]);
  const currentStats = {
    dev: 81,
    ino: 82,
    size: bytes.length,
    mtimeMs: 200,
    ctimeMs: 200,
    birthtimeMs: 100,
    uid: 501,
    nlink: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const info = {
    path: "/virtual/codex/sessions/rollout-active.jsonl",
    rolloutKey: "rollout-2026-07-24T12-00-00-active.jsonl",
    location: "active",
    dev: currentStats.dev,
    ino: currentStats.ino,
    size: prefix.length,
    mtimeMs: 100,
    ctimeMs: 100,
    birthtimeMs: currentStats.birthtimeMs,
    lineage: {
      sessionId: "session-active-port-contract",
      parentId: null,
      isFork: false,
      surfaceClassification: {
        surface: "unknown",
        threadSource: "unknown",
        agentScope: "unknown",
      },
    },
  };
  const state = {
    appendCalls: [],
    closeCalls: 0,
    closed: false,
    parsingFinished: false,
    verificationStats: 0,
  };
  const handle = {
    async read(target, offset, length, position) {
      assert.equal(state.closed, false, "the scanner used the handle after closing it");
      const slice = bytes.subarray(position, position + length);
      target.set(slice, offset);
      return { bytesRead: slice.length, buffer: target };
    },
    async stat() {
      assert.equal(state.closed, false, "verification received a closed handle");
      if (state.parsingFinished) state.verificationStats += 1;
      return currentStats;
    },
    async close() {
      state.closeCalls += 1;
      assert.equal(state.closed, false, "the source owner closed the handle more than once");
      state.closed = true;
    },
  };
  const filesystem = completeFilesystem({
    lstatPath: async (path) => {
      assert.equal(path, info.path);
      assert.equal(state.closed, false, "path verification ran after handle closure");
      return currentStats;
    },
    openReadOnlyNoFollow: async (path) => {
      assert.equal(path, info.path);
      return handle;
    },
  });
  const lineReader = completeLineReader(async function* readBoundedUtf8Lines(source, options) {
    if (Object.hasOwn(options, "startByte")) {
      state.appendCalls.push({ source, options });
      if (appendError) throw appendError;
      yield appended.toString("utf8").trimEnd();
      return;
    }
    assert.equal(source, handle);
    try {
      yield* scanLines();
    } finally {
      state.parsingFinished = true;
    }
  });
  return { filesystem, lineReader, info, handle, prefix, currentStats, state };
}

test("active append proof uses the caller-owned handle, exact prefix offset, and capped line limit", async () => {
  const fixture = activeSourceFixture();
  const guard = resourceGuard(MAXIMUM_APPEND_PROOF_BYTES * 2);
  const scanner = createCodexLogScanner({
    filesystem: fixture.filesystem,
    lineReader: fixture.lineReader,
  });

  await scanner.scanCodexLogEvents({
    startAt: START_AT,
    endAt: END_AT,
    rolloutInfos: [fixture.info],
    resourceGuard: guard,
  });

  assert.ok(fixture.state.appendCalls.length >= 3);
  for (const call of fixture.state.appendCalls) {
    assert.equal(call.source, fixture.handle);
    assert.equal(call.options.startByte, fixture.prefix.length);
    assert.equal(call.options.maximumTotalBytes, fixture.currentStats.size);
    assert.equal(call.options.maximumLineBytes, MAXIMUM_APPEND_PROOF_BYTES);
  }
  assert.ok(fixture.state.verificationStats > 0, "the open handle was not used during verification");
  assert.equal(fixture.state.closeCalls, 1);
  assert.equal(fixture.state.closed, true);
});

for (const [label, controlError] of [
  ["AbortError", Object.assign(new Error("abort sentinel"), { name: "AbortError" })],
  ["export resource error", Object.assign(new Error("resource sentinel"), { code: "export_resource_line_bytes" })],
]) {
  test(`active append proof preserves ${label} object identity`, async () => {
    const fixture = activeSourceFixture({ appendError: controlError });
    const scanner = createCodexLogScanner({
      filesystem: fixture.filesystem,
      lineReader: fixture.lineReader,
    });

    await assert.rejects(
      scanner.scanCodexLogEvents({
        startAt: START_AT,
        endAt: END_AT,
        rolloutInfos: [fixture.info],
        resourceGuard: resourceGuard(),
      }),
      (error) => error === controlError,
    );
    assert.equal(fixture.state.closeCalls, 1);
  });
}

test("generic append-reader failures become a fixed content-free source-change error", async () => {
  const injectedFailure = new Error(PRIVATE_FAILURE_CANARY);
  const fixture = activeSourceFixture({ appendError: injectedFailure });
  const scanner = createCodexLogScanner({
    filesystem: fixture.filesystem,
    lineReader: fixture.lineReader,
  });

  await assert.rejects(
    scanner.scanCodexLogEvents({
      startAt: START_AT,
      endAt: END_AT,
      rolloutInfos: [fixture.info],
      resourceGuard: resourceGuard(),
    }),
    (error) => {
      assert.equal(error instanceof CodexLogSourceChangedError, true);
      assert.equal(error.name, "CodexLogSourceChangedError");
      assert.equal(error.code, "codex_log_source_changed");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Codex log source changed during scan; retry");
      assert.equal(error.message.includes(PRIVATE_FAILURE_CANARY), false);
      assert.notEqual(error, injectedFailure);
      return true;
    },
  );
  assert.equal(fixture.state.closeCalls, 1);
});
