import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeClaudeStatusline } from "./claude-statusline.js";
import { writeClaudeStatusSnapshot } from "./claude-statusline-storage.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  readBoundedDirectoryEntries,
} from "./export-resource-policy.js";
import { stableJson } from "./storage.js";

export const R7_RELEASE_WORKLOAD_FIXTURE_VERSION = "g1-r7-release-workload-fixture-v0.1";
export const R7_RELEASE_WORKLOAD_START_AT = "2026-07-24T00:00:00.000Z";
export const R7_RELEASE_WORKLOAD_END_AT = "2026-07-25T00:00:00.000Z";

export const R7_RELEASE_WORKLOAD_LAYOUT = Object.freeze({
  codexHome: "codex-source",
  collectorFile: "collector-source.jsonl",
  claudeState: "claude-status-source",
  claudeProjects: "claude-transcript-source",
});
export const R7_RELEASE_WORKLOAD_FIXED_SOURCE_FILE_COUNT = 13;

const FIXTURE_SECRET = Buffer.alloc(32, 0x67);
const SYNTHETIC_CONTENT = "R7_RELEASE_SYNTHETIC_CONTENT_NEVER_EXPORT";
const BASE_TIME_MS = Date.parse(R7_RELEASE_WORKLOAD_START_AT);
const MAXIMUM_LONG_LINE_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumLineBytes - 1;
const OPTION_KEYS = Object.freeze([
  "seed",
  "smallFileCount",
  "denseRecordCount",
  "longLineBytes",
  "compressiblePayloadBytes",
  "incompressiblePayloadBytes",
]);
const RESOURCE_OPTION_KEYS = Object.freeze(["maximumDirectoryEntries"]);

export const R7_RELEASE_WORKLOAD_DEFAULTS = Object.freeze({
  seed: 0x6d2b79f5,
  smallFileCount: 256,
  denseRecordCount: 4_096,
  longLineBytes: 64 * 1024,
  compressiblePayloadBytes: 1024 * 1024,
  incompressiblePayloadBytes: 1024 * 1024,
});

export const R7_RELEASE_SYNTHETIC_SEMANTICS_PARAMETERS = Object.freeze({
  seed: 0x6d2b79f5,
  smallFileCount: 1,
  denseRecordCount: 1,
  longLineBytes: 64 * 1024,
  compressiblePayloadBytes: 4 * 1024,
  incompressiblePayloadBytes: 4 * 1024,
});

export const R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS = Object.freeze({
  seed: 0x6d2b79f5,
  // The amendment freezes 4,096 total source files, not 4,096 files in this
  // category in addition to the thirteen fixed semantic/shape sources.
  smallFileCount: 4_096 - R7_RELEASE_WORKLOAD_FIXED_SOURCE_FILE_COUNT,
  denseRecordCount: 25_000,
  longLineBytes: 64 * 1024,
  compressiblePayloadBytes: 8 * 1024 * 1024,
  incompressiblePayloadBytes: 8 * 1024 * 1024,
});

export const R7_RELEASE_WORKLOAD_PARAMETER_BOUNDS = Object.freeze({
  seed: Object.freeze([1, 0xffff_ffff]),
  smallFileCount: Object.freeze([1, 4_096]),
  denseRecordCount: Object.freeze([1, 25_000]),
  longLineBytes: Object.freeze([4 * 1024, MAXIMUM_LONG_LINE_BYTES]),
  compressiblePayloadBytes: Object.freeze([4 * 1024, 8 * 1024 * 1024]),
  incompressiblePayloadBytes: Object.freeze([4 * 1024, 8 * 1024 * 1024]),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeResourceOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("R7 release fixture resource options must be an object");
  }
  const unknown = Object.keys(options).filter((key) => !RESOURCE_OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError("R7 release fixture resource options contain unknown fields");
  const maximumDirectoryEntries = options.maximumDirectoryEntries
    ?? DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries;
  if (!Number.isSafeInteger(maximumDirectoryEntries)
      || maximumDirectoryEntries < 1
      || maximumDirectoryEntries > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries) {
    throw new TypeError("R7 release fixture directory-entry ceiling is outside its bounded range");
  }
  return Object.freeze({ maximumDirectoryEntries });
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("R7 release fixture options must be an object");
  }
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError("R7 release fixture options contain unknown fields");
  const normalized = { ...R7_RELEASE_WORKLOAD_DEFAULTS, ...options };
  for (const key of OPTION_KEYS) {
    const [minimum, maximum] = R7_RELEASE_WORKLOAD_PARAMETER_BOUNDS[key];
    if (!Number.isSafeInteger(normalized[key])
        || normalized[key] < minimum
        || normalized[key] > maximum) {
      throw new TypeError("R7 release fixture option is outside its bounded range");
    }
  }
  return Object.freeze(normalized);
}

async function assertOwnedFixtureRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("R7 release fixture root must be a path");
  }
  const supplied = resolve(root);
  const suppliedStat = await lstat(supplied);
  if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink()) {
    throw new Error("R7 release fixture root must be a real directory");
  }
  const target = await realpath(supplied);
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("R7 release fixture root must be a real directory");
  }
  await chmod(target, 0o700);
  return target;
}

function fixturePaths(root) {
  return {
    codexHome: join(root, R7_RELEASE_WORKLOAD_LAYOUT.codexHome),
    collectorFile: join(root, R7_RELEASE_WORKLOAD_LAYOUT.collectorFile),
    claudeState: join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeState),
    claudeProjects: join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeProjects),
  };
}

function timestamp(secondOffset) {
  return new Date(BASE_TIME_MS + (secondOffset * 1_000)).toISOString();
}

function codexUsage(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function tokenCount(at, total, last, usedPercent) {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_785_430_800 },
        secondary: { used_percent: usedPercent / 2, window_minutes: 10_080, resets_at: 1_785_949_200 },
      },
    },
  });
}

function buildCodexRollouts() {
  const initial = codexUsage(120, 40, 30, 9);
  const final = codexUsage(210, 75, 55, 16);
  const parentTool = JSON.stringify({
    timestamp: timestamp(3_620),
    type: "response_item",
    payload: { type: "shell_call", call_id: "r7-release-tool-parent" },
  });
  const replayedSnapshot = tokenCount(
    timestamp(3_660),
    final,
    codexUsage(90, 35, 25, 7),
    18,
  );
  const parent = [
    JSON.stringify({
      timestamp: timestamp(3_600),
      type: "session_meta",
      payload: { id: "r7-release-parent", prompt: SYNTHETIC_CONTENT },
    }),
    JSON.stringify({
      timestamp: timestamp(3_601),
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    tokenCount(timestamp(3_610), initial, initial, 12),
    parentTool,
    replayedSnapshot,
  ];
  const child = [
    JSON.stringify({
      timestamp: timestamp(3_700),
      type: "session_meta",
      payload: {
        id: "r7-release-child",
        forked_from_id: "r7-release-parent",
        source: { type: "collaboration", client: { kind: "subagent" } },
      },
    }),
    JSON.stringify({
      timestamp: timestamp(3_701),
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    replayedSnapshot,
    parentTool,
    JSON.stringify({
      timestamp: timestamp(3_710),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "thread_spawn", input: SYNTHETIC_CONTENT },
    }),
    tokenCount(
      timestamp(3_720),
      codexUsage(265, 90, 70, 20),
      codexUsage(55, 15, 15, 4),
      21,
    ),
  ];
  return [
    Buffer.from(`${parent.join("\n")}\n`),
    Buffer.from(`${child.join("\n")}\n`),
  ];
}

function quotaWindow(slot, usedPercent, windowDurationMins, resetsAt) {
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot,
    usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

function collectorRecord(at, available, eventKeyByte) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: at,
    receivedAt: at,
    stalenessMs: 0,
    source: "app_server_read",
    windows: [
      quotaWindow("primary", available ? 22.25 : 23.5, 300, 1_785_430_800),
      quotaWindow("secondary", available ? 41.5 : 42.75, 10_080, 1_785_949_200),
    ],
    providerSurface: "account_shared_unallocated",
    accountScope: available ? {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: `openai-account:v1:${"A".repeat(43)}`,
      planType: "pro",
    } : {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    },
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey: eventKeyByte.repeat(64),
  };
}

function buildCollectorBytes() {
  return Buffer.from(`${[
    collectorRecord(timestamp(7_200), true, "a"),
    collectorRecord(timestamp(7_260), false, "b"),
  ].map(JSON.stringify).join("\n")}\n`);
}

function claudeStatusInput(rateLimits, index) {
  return {
    version: "2.1.176",
    model: { id: index % 2 === 0 ? "claude-opus-4-8" : "claude-sonnet-5" },
    session_id: `r7-release-status-${index}`,
    cwd: `/synthetic/${SYNTHETIC_CONTENT}`,
    prompt: SYNTHETIC_CONTENT,
    rate_limits: rateLimits,
  };
}

async function writeStatusCases(stateDirectory) {
  const fiveHour = { used_percentage: 31.25, resets_at: 1_785_430_800 };
  const sevenDay = { used_percentage: 47.5, resets_at: 1_785_949_200 };
  const cases = [
    { five_hour: fiveHour, seven_day: sevenDay },
    { five_hour: fiveHour },
    { seven_day: sevenDay },
    {},
  ];
  for (const [index, rateLimits] of cases.entries()) {
    const snapshot = sanitizeClaudeStatusline(
      claudeStatusInput(rateLimits, index),
      timestamp(7_800 + (index * 60)),
      { sessionSecret: FIXTURE_SECRET },
    );
    await writeClaudeStatusSnapshot(snapshot, {
      stateDirectory,
      uuid: `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    });
  }
}

function iteration({ type = "message", model, input, read, write, output, fiveMinute, oneHour }) {
  return {
    type,
    model,
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    output_tokens: output,
    cache_creation: {
      ephemeral_5m_input_tokens: fiveMinute,
      ephemeral_1h_input_tokens: oneHour,
    },
  };
}

function assistantRecord(index, {
  isSidechain = false,
  model = "claude-opus-4-8",
  text = SYNTHETIC_CONTENT,
  iterations = undefined,
  output = 19,
} = {}) {
  const usage = {
    input_tokens: 11,
    cache_creation_input_tokens: 13,
    cache_read_input_tokens: 17,
    output_tokens: output,
    cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 5 },
    service_tier: "standard_only",
    speed: index % 2 === 0 ? "fast" : "standard",
    ...(iterations === undefined ? {} : { iterations }),
  };
  return {
    parentUuid: `r7-release-parent-${index}`,
    isSidechain,
    ...(isSidechain ? { agentId: `r7-release-agent-${index}` } : {}),
    userType: "external",
    cwd: `/synthetic/${SYNTHETIC_CONTENT}`,
    sessionId: `r7-release-session-${Math.floor(index / 10)}`,
    version: "2.1.176",
    type: "assistant",
    requestId: `r7-release-request-${index}`,
    uuid: `r7-release-uuid-${index}`,
    timestamp: timestamp(10_800 + index),
    message: {
      id: `r7-release-message-${index}`,
      type: "message",
      role: "assistant",
      model,
      content: [
        { type: "thinking", thinking: SYNTHETIC_CONTENT, signature: SYNTHETIC_CONTENT },
        { type: "text", text },
        { type: "tool_use", id: `r7-release-tool-${index}`, name: index % 2 === 0 ? "Read" : "Bash", input: { value: SYNTHETIC_CONTENT } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
  };
}

function coreTranscriptBytes() {
  const fallback = assistantRecord(0, {
    iterations: [
      iteration({
        type: "fallback_message",
        model: "claude-release-unknown-fallback",
        input: 3,
        read: 5,
        write: 7,
        output: 11,
        fiveMinute: 2,
        oneHour: 5,
      }),
      iteration({
        model: "claude-opus-4-8",
        input: 11,
        read: 17,
        write: 13,
        output: 23,
        fiveMinute: 8,
        oneHour: 5,
      }),
    ],
    output: 23,
  });
  const subagent = assistantRecord(1, { isSidechain: true, model: "claude-sonnet-5" });
  const unknown = assistantRecord(2, { model: "claude-release-unreviewed-model" });
  return Buffer.from(`${[fallback, subagent, unknown].map(JSON.stringify).join("\n")}\n`);
}

function deterministicAscii(length, seed) {
  const alphabet = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", "ascii");
  const output = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = alphabet[state >>> 0 & 63];
  }
  return output.toString("ascii");
}

function exactLineRecord(index, targetBytes) {
  const record = assistantRecord(index, { text: "" });
  const empty = JSON.stringify(record);
  const padding = targetBytes - Buffer.byteLength(empty);
  if (padding < 0) throw new TypeError("R7 release long-line target is too small for its structural envelope");
  record.message.content[1].text = "L".repeat(padding);
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) !== targetBytes) throw new Error("R7 release long-line construction drifted");
  return Buffer.from(`${line}\n`);
}

function manySmallFiles(count) {
  return Array.from({ length: count }, (_, index) => Buffer.from(
    `${JSON.stringify(assistantRecord(100 + index, { isSidechain: index % 3 === 0 }))}\n`,
  ));
}

function denseTranscriptBytes(count) {
  return Buffer.from(`${Array.from({ length: count }, (_, index) => (
    JSON.stringify(assistantRecord(10_000 + index, { isSidechain: index % 11 === 0 }))
  )).join("\n")}\n`);
}

function payloadTranscriptBytes(index, payload) {
  return Buffer.from(`${JSON.stringify(assistantRecord(index, { text: payload }))}\n`);
}

async function writeFiles(directory, prefix, buffers) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [index, bytes] of buffers.entries()) {
    await writeFile(join(directory, `${prefix}-${String(index).padStart(5, "0")}.jsonl`), bytes, { mode: 0o600 });
  }
}

function countLines(bytes) {
  let count = 0;
  for (const value of bytes) if (value === 0x0a) count += 1;
  return count;
}

function categoryEvidence(category, buffers) {
  const digest = createHash("sha256");
  digest.update(`app-usagemonitor/r7-release-fixture/${category}/v1\0`);
  let bytes = 0;
  let records = 0;
  for (const value of buffers) {
    digest.update(String(value.length));
    digest.update("\0");
    digest.update(value);
    bytes += value.length;
    records += countLines(value);
  }
  return { category, files: buffers.length, records, bytes, sha256: digest.digest("hex") };
}

function buildManifest(parameters, categoryBuffers) {
  const categories = Object.entries(categoryBuffers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, buffers]) => categoryEvidence(category, buffers));
  const totals = categories.reduce((value, category) => ({
    files: value.files + category.files,
    records: value.records + category.records,
    bytes: value.bytes + category.bytes,
  }), { files: 0, records: 0, bytes: 0 });
  const manySmallSubagents = Math.ceil(parameters.smallFileCount / 3);
  const denseSubagents = Math.ceil(parameters.denseRecordCount / 11);
  const projection = {
    fixtureVersion: R7_RELEASE_WORKLOAD_FIXTURE_VERSION,
    parameters,
    coverage: {
      codexRootRollouts: 1,
      codexForkSubagentRollouts: 1,
      codexReplayedUsageCopies: 1,
      codexReplayedToolCopies: 1,
      knownAccountQuotaStates: 1,
      unattributedAccountQuotaStates: 1,
      claudeFallbackIterations: 2,
      claudeCombinedOutputRecords: 1,
      claudeRootTranscriptRecords: 6
        + parameters.smallFileCount - manySmallSubagents
        + parameters.denseRecordCount - denseSubagents,
      claudeSubagentTranscriptRecords: 1 + manySmallSubagents + denseSubagents,
      claudeUnknownModelDeclarations: 2,
      claudeStatusBothWindows: 1,
      claudeStatusFiveHourOnly: 1,
      claudeStatusSevenDayOnly: 1,
      claudeStatusNeitherWindow: 1,
      manySmallFiles: parameters.smallFileCount,
      totalSourceFiles: totals.files,
      longLineCases: 2,
      longLineBytes: parameters.longLineBytes,
      longLinePlusOneBytes: parameters.longLineBytes + 1,
      denseRecordCases: parameters.denseRecordCount,
      compressibleShapeCases: 1,
      incompressibleShapeCases: 1,
    },
    categories,
    totals,
  };
  return Object.freeze({ ...projection, manifestSha256: sha256(stableJson(projection)) });
}

async function statusBuffers(paths, resourceOptions) {
  const recordsDirectory = join(paths.claudeState, "records");
  await assertExactNames(paths.claudeState, ["records"], resourceOptions);
  const names = await readBoundedDirectoryEntries(recordsDirectory, {
    maximumEntries: resourceOptions.maximumDirectoryEntries,
    sort: true,
  });
  if (names.length !== 4) throw new Error("R7 release fixture status inventory changed");
  const buffers = [];
  for (const name of names) buffers.push(await readFile(join(recordsDirectory, name)));
  return buffers;
}

async function assertExactNames(directory, expected, resourceOptions) {
  const actual = await readBoundedDirectoryEntries(directory, {
    maximumEntries: resourceOptions.maximumDirectoryEntries,
    sort: true,
  });
  if (stableJson(actual) !== stableJson([...expected].sort())) {
    throw new Error("R7 release fixture inventory changed");
  }
}

async function readCategoryBuffers(root, parameters, resourceOptions) {
  const paths = fixturePaths(root);
  const sessions = join(paths.codexHome, "sessions");
  const projects = paths.claudeProjects;
  const smallDirectory = join(projects, "many-small");
  const smallNames = Array.from(
    { length: parameters.smallFileCount },
    (_, index) => `small-${String(index).padStart(5, "0")}.jsonl`,
  );
  await assertExactNames(root, Object.values(R7_RELEASE_WORKLOAD_LAYOUT), resourceOptions);
  await assertExactNames(paths.codexHome, ["archived_sessions", "sessions"], resourceOptions);
  await assertExactNames(join(paths.codexHome, "archived_sessions"), [], resourceOptions);
  await assertExactNames(sessions, ["rollout-child.jsonl", "rollout-parent.jsonl"], resourceOptions);
  await assertExactNames(projects, [
    "compressible.jsonl",
    "core.jsonl",
    "dense.jsonl",
    "incompressible.jsonl",
    "long-line-plus-one.jsonl",
    "long-line.jsonl",
    "many-small",
  ], resourceOptions);
  await assertExactNames(smallDirectory, smallNames, resourceOptions);
  const manySmallBuffers = [];
  for (const name of smallNames) {
    manySmallBuffers.push(await readFile(join(smallDirectory, name)));
  }
  return {
    claude_status: await statusBuffers(paths, resourceOptions),
    claude_transcript_compressible: [await readFile(join(projects, "compressible.jsonl"))],
    claude_transcript_core: [await readFile(join(projects, "core.jsonl"))],
    claude_transcript_dense: [await readFile(join(projects, "dense.jsonl"))],
    claude_transcript_incompressible: [await readFile(join(projects, "incompressible.jsonl"))],
    claude_transcript_long_line: [
      await readFile(join(projects, "long-line.jsonl")),
      await readFile(join(projects, "long-line-plus-one.jsonl")),
    ],
    claude_transcript_many_small: manySmallBuffers,
    codex_collector: [await readFile(paths.collectorFile)],
    codex_rollout: [
      await readFile(join(sessions, "rollout-parent.jsonl")),
      await readFile(join(sessions, "rollout-child.jsonl")),
    ],
  };
}

export async function createR7ReleaseWorkloadFixture(root, options = {}, resourceOptions = {}) {
  const parameters = normalizeOptions(options);
  const resources = normalizeResourceOptions(resourceOptions);
  const target = await assertOwnedFixtureRoot(root);
  const paths = fixturePaths(target);
  await mkdir(join(paths.codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.codexHome, "archived_sessions"), { recursive: true, mode: 0o700 });
  await mkdir(paths.claudeProjects, { recursive: true, mode: 0o700 });

  const codexRollouts = buildCodexRollouts();
  await writeFile(join(paths.codexHome, "sessions", "rollout-parent.jsonl"), codexRollouts[0], { mode: 0o600 });
  await writeFile(join(paths.codexHome, "sessions", "rollout-child.jsonl"), codexRollouts[1], { mode: 0o600 });
  await writeFile(paths.collectorFile, buildCollectorBytes(), { mode: 0o600 });
  await writeStatusCases(paths.claudeState);

  await writeFile(join(paths.claudeProjects, "core.jsonl"), coreTranscriptBytes(), { mode: 0o600 });
  await writeFiles(join(paths.claudeProjects, "many-small"), "small", manySmallFiles(parameters.smallFileCount));
  await writeFile(
    join(paths.claudeProjects, "dense.jsonl"),
    denseTranscriptBytes(parameters.denseRecordCount),
    { mode: 0o600 },
  );
  await writeFile(
    join(paths.claudeProjects, "long-line.jsonl"),
    exactLineRecord(40_000, parameters.longLineBytes),
    { mode: 0o600 },
  );
  await writeFile(
    join(paths.claudeProjects, "long-line-plus-one.jsonl"),
    exactLineRecord(40_003, parameters.longLineBytes + 1),
    { mode: 0o600 },
  );
  await writeFile(
    join(paths.claudeProjects, "compressible.jsonl"),
    payloadTranscriptBytes(40_001, "C".repeat(parameters.compressiblePayloadBytes)),
    { mode: 0o600 },
  );
  await writeFile(
    join(paths.claudeProjects, "incompressible.jsonl"),
    payloadTranscriptBytes(
      40_002,
      deterministicAscii(parameters.incompressiblePayloadBytes, parameters.seed),
    ),
    { mode: 0o600 },
  );

  return buildManifest(parameters, await readCategoryBuffers(target, parameters, resources));
}

export async function inspectR7ReleaseWorkloadFixture(root, options = {}, resourceOptions = {}) {
  const parameters = normalizeOptions(options);
  const resources = normalizeResourceOptions(resourceOptions);
  const target = await assertOwnedFixtureRoot(root);
  return buildManifest(parameters, await readCategoryBuffers(target, parameters, resources));
}
