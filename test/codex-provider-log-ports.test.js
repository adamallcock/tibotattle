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
