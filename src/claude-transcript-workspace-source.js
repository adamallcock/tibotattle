import {
  CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION,
  ClaudeTranscriptExportSourceError,
  createClaudeTranscriptExportCursor,
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
  sliceClaudeTranscriptExportSourcePlans,
  verifyClaudeTranscriptExportSource,
} from "./claude-transcript-export-source.js";
import { ExportResourceLimitError } from "./export-resource-policy.js";
import { normalizeClaudeTranscriptUsageCandidate } from "./export-safe-records.js";
import { createSupplementalSourcePlan, normalizeSupplementalSourcePlan } from "./export-supplemental-source-plan.js";
import { supplementalSourceCheckpointBatchSha256 } from "./export-workspace.js";
import { stableJson } from "./storage.js";

export const CLAUDE_TRANSCRIPT_WORKSPACE_SOURCE_VERSION = "claude-transcript-workspace-source-v0.1";
export const DEFAULT_CLAUDE_TRANSCRIPT_RECORDS_PER_BATCH = 500;

const MAXIMUM_BATCH_RECORDS = 1_000;
const SAFE_CODES = new Set(["configuration", "source_integrity"]);

export class ClaudeTranscriptWorkspaceSourceError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown Claude transcript workspace source code");
    super(`Claude transcript workspace source failed (${code})`);
    this.name = "ClaudeTranscriptWorkspaceSourceError";
    this.code = `claude_transcript_workspace_${code}`;
  }
}

function fail(code) {
  throw new ClaudeTranscriptWorkspaceSourceError(code);
}

function sourceFromPlan(source, ordinal, singlePlan, secret) {
  const cursor = createClaudeTranscriptExportCursor(singlePlan, source.sourceKey, { secret });
  return {
    publicSource: {
      ordinal,
      sourceKey: source.sourceKey,
      kind: "claude_transcript_jsonl",
      parserVersion: CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION,
      binding: {
        kind: "file_prefix",
        device: source.device,
        inode: source.inode,
        birthtimeMs: source.birthtimeMs,
        prefixBytes: source.prefixBytes,
        prefixSha256: source.prefixSha256,
      },
      initialCursorJson: stableJson(cursor),
    },
    privatePlan: { sourceKey: source.sourceKey, valueJson: stableJson(singlePlan) },
  };
}

export async function createClaudeTranscriptWorkspaceSource({
  projectsDirectory, startAt, endAt, secret, resourceGuard,
} = {}) {
  const transcriptPlan = await createClaudeTranscriptExportSourcePlan({
    projectsDirectory, startAt, endAt, secret, resourceGuard,
  });
  const singlePlans = sliceClaudeTranscriptExportSourcePlans(transcriptPlan, { secret });
  const entries = transcriptPlan.sources.map((source, ordinal) => (
    sourceFromPlan(source, ordinal, singlePlans[ordinal], secret)
  ));
  return {
    transcriptPlan,
    sources: entries.map((entry) => entry.publicSource),
    privatePlans: entries.map((entry) => entry.privatePlan),
  };
}

export function appendClaudeTranscriptWorkspaceSources(supplementalSourcePlan, transcriptPlan, { secret } = {}) {
  let base;
  try {
    base = normalizeSupplementalSourcePlan(supplementalSourcePlan);
  } catch {
    fail("configuration");
  }
  if (base.sources.some((source) => source.kind === "claude_transcript_jsonl")) fail("configuration");
  const singlePlans = sliceClaudeTranscriptExportSourcePlans(transcriptPlan, { secret });
  const appended = transcriptPlan.sources.map((source, index) => (
    sourceFromPlan(source, base.sources.length + index, singlePlans[index], secret).publicSource
  ));
  return createSupplementalSourcePlan({ sources: [...base.sources, ...appended] });
}

function parseCursor(value, sourceKey) {
  let cursor;
  try {
    cursor = JSON.parse(value);
  } catch {
    fail("source_integrity");
  }
  const keys = ["schemaVersion", "sourceKey", "nextByte", "nextLineOrdinal", "nextCostOrdinal"];
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
      || Object.keys(cursor).length !== keys.length || !keys.every((key) => Object.hasOwn(cursor, key))
      || cursor.schemaVersion !== CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION
      || cursor.sourceKey !== sourceKey || !Number.isSafeInteger(cursor.nextByte) || cursor.nextByte < 0
      || !Number.isSafeInteger(cursor.nextLineOrdinal) || cursor.nextLineOrdinal < 1
      || !Number.isSafeInteger(cursor.nextCostOrdinal) || cursor.nextCostOrdinal < 0
      || stableJson(cursor) !== value) fail("source_integrity");
  return cursor;
}

function checkpointExpected(checkpoint) {
  return {
    checkpointSeq: checkpoint.checkpointSeq,
    status: checkpoint.status,
    cursorJson: checkpoint.cursorJson,
  };
}

function resourceDelta(before, after) {
  const delta = (key) => Math.max(0, after[key] - before[key]);
  return {
    directoryEntries: delta("directoryEntries"),
    lines: delta("lines"),
    oversizedIrrelevantLines: delta("oversizedIrrelevantLines"),
    cumulativeElapsedMs: delta("cumulativeElapsedMs"),
    peakRssBytes: after.peakRssBytes,
  };
}

function completedBatch(batch) {
  return { ...batch, batchSha256: supplementalSourceCheckpointBatchSha256(batch) };
}

function transcriptSources(workspace) {
  return workspace.loadSupplementalSourcePlan().sources
    .filter((source) => source.kind === "claude_transcript_jsonl");
}

function loadPrivatePlan(workspace, source, projectsDirectory) {
  let plan;
  try {
    plan = workspace.loadSupplementalPrivatePlan(source.sourceKey);
  } catch {
    fail("source_integrity");
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)
      || plan.rootDirectory !== projectsDirectory || plan.sourceCount !== 1
      || plan.sources?.[0]?.sourceKey !== source.sourceKey
      || plan.sources[0].device !== source.binding.device || plan.sources[0].inode !== source.binding.inode
      || plan.sources[0].birthtimeMs !== source.binding.birthtimeMs
      || plan.sources[0].prefixBytes !== source.binding.prefixBytes
      || !Number.isSafeInteger(plan.sources[0].prefixLineCount)
      || plan.sources[0].prefixLineCount < 0
      || plan.sources[0].prefixSha256 !== source.binding.prefixSha256) fail("source_integrity");
  return plan;
}

export async function populateClaudeTranscriptWorkspaceSources({
  workspace,
  projectsDirectory,
  secret,
  resourceGuard,
  maximumRecords = DEFAULT_CLAUDE_TRANSCRIPT_RECORDS_PER_BATCH,
  failpoint = async () => {},
} = {}) {
  if (!workspace || typeof projectsDirectory !== "string" || projectsDirectory.length < 1
      || !secret || !resourceGuard || !Number.isSafeInteger(maximumRecords)
      || maximumRecords < 1 || maximumRecords > MAXIMUM_BATCH_RECORDS) {
    throw new TypeError("Claude transcript workspace scan requires bounded inputs");
  }
  try {
    const sources = transcriptSources(workspace);
    for (const source of sources) {
      if (source.binding.kind !== "file_prefix"
          || source.parserVersion !== CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION) fail("source_integrity");
      const privatePlan = loadPrivatePlan(workspace, source, projectsDirectory);
      for (;;) {
        const checkpoint = workspace.loadSupplementalSourceCheckpoint(source.sourceKey);
        if (checkpoint.status === "complete") break;
        const cursor = parseCursor(checkpoint.cursorJson, source.sourceKey);
        const before = resourceGuard.durableSnapshot();
        let scanned;
        if (privatePlan.sources[0].selectedMessages === 0) {
          const verified = await verifyClaudeTranscriptExportSource(privatePlan, source.sourceKey, {
            secret, resourceGuard,
          });
          scanned = { candidates: [], cursor: verified.cursor, complete: true };
        } else {
          scanned = await scanClaudeTranscriptExportSource(privatePlan, source.sourceKey, {
            secret, cursor, maximumCandidateRecords: maximumRecords, resourceGuard, verifyWholePrefix: false,
          });
        }
        if (scanned.complete && privatePlan.sources[0].selectedMessages > 0) {
          await verifyClaudeTranscriptExportSource(privatePlan, source.sourceKey, {
            secret, cursor: scanned.cursor, resourceGuard,
          });
        }
        const records = scanned.candidates.map((candidate) => ({
          recordType: "usageEvent",
          record: normalizeClaudeTranscriptUsageCandidate(secret, candidate),
        }));
        for (const envelope of records) {
          resourceGuard.observeOutputRecord(Buffer.byteLength(stableJson(envelope.record), "utf8"));
        }
        const after = resourceGuard.durableSnapshot();
        const batch = completedBatch({
          sourceKey: source.sourceKey,
          expected: checkpointExpected(checkpoint),
          next: {
            status: scanned.complete ? "complete" : "pending",
            cursorJson: stableJson(scanned.cursor),
          },
          records,
          diagnosticDeltas: [],
          registryGapDeltas: [],
          resourceDeltas: resourceDelta(before, after),
        });
        const committed = await workspace.commitSupplementalSourceBatch(batch);
        await failpoint("after_claude_transcript_checkpoint_batch", committed.checkpoint);
        if (records.length > 0) await failpoint("after_record_batch", committed.checkpoint);
        if (committed.checkpoint.status === "complete") break;
      }
    }
    return { sourceCount: sources.length };
  } catch (error) {
    if (error instanceof ExportResourceLimitError) throw error;
    if (error instanceof ClaudeTranscriptExportSourceError
        || error instanceof ClaudeTranscriptWorkspaceSourceError) workspace.markPoisoned("source_integrity");
    throw error;
  }
}
