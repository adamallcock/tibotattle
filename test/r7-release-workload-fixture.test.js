import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  createCodexCollectorExportSourcePlan,
  scanCodexCollectorExportSource,
} from "../src/codex-collector-export-source.js";
import {
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
} from "../src/claude-transcript-export-source.js";
import {
  createExportResourceGuard,
  readBoundedDirectoryEntries,
} from "../src/export-resource-policy.js";
import { localSafeRecords } from "../src/local-node-runtime.js";
import {
  createR7ReleaseWorkloadFixture,
  inspectR7ReleaseWorkloadFixture,
  R7_RELEASE_WORKLOAD_END_AT,
  R7_RELEASE_WORKLOAD_FIXTURE_VERSION,
  R7_RELEASE_WORKLOAD_LAYOUT,
  R7_RELEASE_WORKLOAD_FIXED_SOURCE_FILE_COUNT,
  R7_RELEASE_WORKLOAD_PARAMETER_BOUNDS,
  R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS,
  R7_RELEASE_SYNTHETIC_SEMANTICS_PARAMETERS,
  R7_RELEASE_WORKLOAD_START_AT,
} from "../src/r7-release-workload-fixture.js";

const {
  normalizeClaudeTranscriptUsageCandidate,
  scanCodexSafeRecords,
} = localSafeRecords;

const SECRET = Buffer.alloc(32, 0x45);
const TEST_OPTIONS = Object.freeze({
  seed: 0x1234_5678,
  smallFileCount: 6,
  denseRecordCount: 12,
  longLineBytes: 16 * 1024,
  compressiblePayloadBytes: 32 * 1024,
  incompressiblePayloadBytes: 32 * 1024,
});

async function temporaryRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function guard() {
  return createExportResourceGuard({ scope: "export_set" });
}

test("release workload fixture is root-independent, deterministic, bounded, and aggregate-only", async () => {
  const firstRoot = await temporaryRoot("usage-monitor-r7-release-first-");
  const secondRoot = await temporaryRoot("usage-monitor-r7-release-second-");
  try {
    const first = await createR7ReleaseWorkloadFixture(firstRoot, TEST_OPTIONS);
    const second = await createR7ReleaseWorkloadFixture(secondRoot, TEST_OPTIONS);
    assert.deepEqual(first, second);
    assert.deepEqual(await inspectR7ReleaseWorkloadFixture(firstRoot, TEST_OPTIONS), first);
    assert.equal(first.fixtureVersion, R7_RELEASE_WORKLOAD_FIXTURE_VERSION);
    assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.coverage.codexForkSubagentRollouts, 1);
    assert.equal(first.coverage.codexReplayedUsageCopies, 1);
    assert.equal(first.coverage.knownAccountQuotaStates, 1);
    assert.equal(first.coverage.unattributedAccountQuotaStates, 1);
    assert.equal(first.coverage.claudeStatusFiveHourOnly, 1);
    assert.equal(first.coverage.claudeStatusSevenDayOnly, 1);
    assert.equal(first.coverage.manySmallFiles, TEST_OPTIONS.smallFileCount);
    assert.equal(first.coverage.totalSourceFiles, first.totals.files);
    assert.equal(first.coverage.longLineCases, 2);
    assert.equal(first.coverage.longLineBytes, TEST_OPTIONS.longLineBytes);
    assert.equal(first.coverage.longLinePlusOneBytes, TEST_OPTIONS.longLineBytes + 1);
    assert.equal(first.coverage.denseRecordCases, TEST_OPTIONS.denseRecordCount);
    assert.equal(
      first.coverage.claudeRootTranscriptRecords + first.coverage.claudeSubagentTranscriptRecords,
      4 + TEST_OPTIONS.smallFileCount + TEST_OPTIONS.denseRecordCount + 3,
    );
    assert.equal(first.categories.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)), true);
    assert.equal(first.totals.files, 2 + 1 + 4 + 1 + TEST_OPTIONS.smallFileCount + 5);

    const serialized = JSON.stringify(first);
    for (const prohibited of [
      firstRoot,
      secondRoot,
      "R7_RELEASE_SYNTHETIC_CONTENT_NEVER_EXPORT",
      "r7-release-parent",
      "openai-account:v1:",
      "claude-release-unreviewed-model",
      "sessionId",
      "modelFingerprint",
    ]) {
      assert.equal(serialized.includes(prohibited), false, prohibited);
    }
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("release workload semantic records exercise replay, account scope, Claude windows, fallback, and unknown models", async () => {
  const root = await temporaryRoot("usage-monitor-r7-release-semantics-");
  try {
    await createR7ReleaseWorkloadFixture(root, TEST_OPTIONS);
    const codexHome = join(root, R7_RELEASE_WORKLOAD_LAYOUT.codexHome);
    const codexRecords = [];
    const codex = await scanCodexSafeRecords({
      startAt: R7_RELEASE_WORKLOAD_START_AT,
      endAt: R7_RELEASE_WORKLOAD_END_AT,
      codexHome,
      secret: SECRET,
      onRecord(value) { codexRecords.push(value); },
      resourceGuard: guard(),
    });
    assert.equal(codex.diagnostics.codes.some(
      (row) => row.code === "fork_replay_events_skipped" && row.count >= 1,
    ), true);
    const parentLines = (await readFile(
      join(codexHome, "sessions", "rollout-parent.jsonl"),
      "utf8",
    )).trimEnd().split("\n");
    const childLines = (await readFile(
      join(codexHome, "sessions", "rollout-child.jsonl"),
      "utf8",
    )).trimEnd().split("\n");
    const parentTool = parentLines.find((line) => line.includes('"type":"shell_call"'));
    assert.equal(typeof parentTool, "string");
    assert.equal(childLines.includes(parentTool), true);
    assert.equal(codexRecords.some(
      (row) => row.recordType === "usageEvent" && row.record.agentScope === "subagent",
    ), true);

    const collectorPlan = await createCodexCollectorExportSourcePlan({
      collectorPath: join(root, R7_RELEASE_WORKLOAD_LAYOUT.collectorFile),
      startAt: R7_RELEASE_WORKLOAD_START_AT,
      endAt: R7_RELEASE_WORKLOAD_END_AT,
      resourceGuard: guard(),
    });
    const collector = await scanCodexCollectorExportSource(collectorPlan, {
      maximumCandidateRecords: 10,
      resourceGuard: guard(),
    });
    assert.equal(collector.complete, true);
    assert.equal(collector.candidates.length, 4);
    assert.equal(collector.candidates.some((row) => row.accountScopeSubject === "unattributed"), true);
    assert.equal(collector.candidates.some((row) => row.accountScopeSubject.startsWith("openai-account:v1:")), true);

    const statusDirectory = join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeState, "records");
    const statusNames = await readBoundedDirectoryEntries(statusDirectory, {
      maximumEntries: 4,
      sort: true,
    });
    const statuses = [];
    for (const name of statusNames) {
      statuses.push(JSON.parse(await readFile(join(statusDirectory, name), "utf8")));
    }
    assert.deepEqual(statuses.map((row) => [row.limits.fiveHour !== null, row.limits.sevenDay !== null]), [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]);

    const transcriptPlan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeProjects),
      startAt: R7_RELEASE_WORKLOAD_START_AT,
      endAt: R7_RELEASE_WORKLOAD_END_AT,
      secret: SECRET,
      resourceGuard: guard(),
    });
    const candidates = [];
    for (const source of transcriptPlan.sources) {
      const scanned = await scanClaudeTranscriptExportSource(transcriptPlan, source.sourceKey, {
        secret: SECRET,
        maximumCandidateRecords: 1_000,
        resourceGuard: guard(),
      });
      assert.equal(scanned.complete, true);
      candidates.push(...scanned.candidates);
    }
    assert.equal(candidates.some((row) => row.agentScope === "subagent"), true);
    assert.equal(candidates.some((row) => row.components.outputCombinedTokens === 11), true);
    assert.equal(candidates.some((row) => row.components.outputCombinedTokens === 23), true);
    const unknowns = candidates
      .map((candidate) => normalizeClaudeTranscriptUsageCandidate(SECRET, candidate))
      .filter((candidate) => candidate.modelRecognition === "unrecognized");
    assert.equal(unknowns.length >= 2, true);
    assert.equal(new Set(unknowns.map((row) => row.modelFingerprint)).size >= 2, true);
    assert.equal(unknowns.every((row) => row.modelId === "unknown"), true);
    assert.equal(unknowns.every((row) => /^model:v1:[a-f0-9]{64}$/u.test(row.modelFingerprint)), true);
    assert.equal(JSON.stringify(unknowns).includes("claude-release-unreviewed-model"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workload materializes an exact long line and distinct deterministic compression shapes", async () => {
  const root = await temporaryRoot("usage-monitor-r7-release-shapes-");
  try {
    await createR7ReleaseWorkloadFixture(root, TEST_OPTIONS);
    const projects = join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeProjects);
    const longLine = await readFile(join(projects, "long-line.jsonl"));
    assert.equal(longLine.length, TEST_OPTIONS.longLineBytes + 1);
    assert.equal(longLine.at(-1), 0x0a);
    const longLinePlusOne = await readFile(join(projects, "long-line-plus-one.jsonl"));
    assert.equal(longLinePlusOne.length, TEST_OPTIONS.longLineBytes + 2);
    assert.equal(longLinePlusOne.at(-1), 0x0a);

    const compressible = await readFile(join(projects, "compressible.jsonl"));
    const incompressible = await readFile(join(projects, "incompressible.jsonl"));
    const compressibleRecord = JSON.parse(compressible.toString("utf8").trimEnd());
    const incompressibleRecord = JSON.parse(incompressible.toString("utf8").trimEnd());
    assert.equal(
      compressibleRecord.message.content[1].text.length,
      TEST_OPTIONS.compressiblePayloadBytes,
    );
    assert.equal(
      incompressibleRecord.message.content[1].text.length,
      TEST_OPTIONS.incompressiblePayloadBytes,
    );
    assert.equal(Math.abs(compressible.length - incompressible.length) < 32, true);
    assert.equal(gzipSync(compressible).length * 4 < gzipSync(incompressible).length, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release workload rejects unknown or out-of-range resource-shape parameters", async () => {
  const root = await temporaryRoot("usage-monitor-r7-release-invalid-");
  try {
    assert.deepEqual(R7_RELEASE_WORKLOAD_PARAMETER_BOUNDS.smallFileCount, [1, 4_096]);
    assert.deepEqual(R7_RELEASE_WORKLOAD_PARAMETER_BOUNDS.denseRecordCount, [1, 25_000]);
    assert.deepEqual(R7_RELEASE_SYNTHETIC_SEMANTICS_PARAMETERS, {
      seed: 0x6d2b79f5,
      smallFileCount: 1,
      denseRecordCount: 1,
      longLineBytes: 64 * 1024,
      compressiblePayloadBytes: 4 * 1024,
      incompressiblePayloadBytes: 4 * 1024,
    });
    assert.deepEqual(R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS, {
      seed: 0x6d2b79f5,
      smallFileCount: 4_083,
      denseRecordCount: 25_000,
      longLineBytes: 64 * 1024,
      compressiblePayloadBytes: 8 * 1024 * 1024,
      incompressiblePayloadBytes: 8 * 1024 * 1024,
    });
    assert.equal(
      R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS.smallFileCount
        + R7_RELEASE_WORKLOAD_FIXED_SOURCE_FILE_COUNT,
      4_096,
    );
    assert.equal(R7_RELEASE_WORKLOAD_FIXED_SOURCE_FILE_COUNT, 13);
    await assert.rejects(
      createR7ReleaseWorkloadFixture(root, { ...TEST_OPTIONS, userContent: "not-allowed" }),
      /unknown fields/,
    );
    await assert.rejects(
      createR7ReleaseWorkloadFixture(root, { ...TEST_OPTIONS, smallFileCount: 100_000 }),
      /bounded range/,
    );
    await assert.rejects(
      createR7ReleaseWorkloadFixture(root, { ...TEST_OPTIONS, longLineBytes: 10 }),
      /bounded range/,
    );
    await assert.rejects(
      createR7ReleaseWorkloadFixture(root, TEST_OPTIONS, { maximumDirectoryEntries: 3 }),
      (error) => error?.code === "export_resource_directory_entries",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
