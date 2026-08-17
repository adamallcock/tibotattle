import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkClaudeDesktopSyntheticScaledAppend } from "../src/claude-desktop-incremental-benchmark.js";

test("synthetic scaled append benchmark is aggregate-only and covers each cursor lifecycle", {
  timeout: 30_000,
}, async () => {
  const result = await benchmarkClaudeDesktopSyntheticScaledAppend({
    lineCount: 128,
    secret: Buffer.alloc(32, 41),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.contentFree, true);
  assert.equal(result.scale.sourceCount, 1);
  assert.equal(result.scale.initialLineCount, 128);
  assert.equal(result.scale.finalLineCount, 129);
  assert.ok(result.scale.initialSourceBytes > 0);
  assert.ok(result.scale.appendBytes > 0);
  assert.equal(
    result.scale.appendSourceBytes,
    result.scale.initialSourceBytes + result.scale.appendBytes,
  );
  assert.equal(result.scale.mutationContentBytesChanged, 1);
  assert.equal(result.scale.mutationSourceLengthDeltaBytes, 0);
  assert.equal(result.scale.mutationSourceBytes, result.scale.appendSourceBytes);
  assert.deepEqual(result.invariants, {
    firstImportParsedAllLines: true,
    unchangedReadZeroLines: true,
    appendReadOneSuffixLine: true,
    restartReadZeroLines: true,
    mutationRebuiltSource: true,
  });

  assert.equal(result.phases.firstImport.canonical.parsedLines, 128);
  assert.equal(result.phases.unchanged.canonical.parsedLines, 0);
  assert.equal(result.phases.append.canonical.parsedLines, 1);
  assert.equal(result.phases.restartAfterAppend.canonical.parsedLines, 0);
  assert.equal(result.phases.mutation.canonical.parsedLines, 129);
  assert.equal(result.phases.mutation.merge.superseded, 1);
  assert.equal(result.phases.mutation.canonical.candidateCount, 1);
  assert.equal(result.phases.mutation.contentBytesChanged, 1);
  assert.equal(result.phases.mutation.sourceLengthDeltaBytes, 0);
  assert.equal(result.phases.firstImport.pricing.eventCount, 128);
  assert.equal(result.phases.firstImport.pricing.cacheStatus, "published");
  assert.equal(result.phases.unchanged.pricing.eventCount, 128);
  assert.equal(result.phases.unchanged.pricing.cacheStatus, "reused");
  assert.equal(
    result.phases.unchanged.pricing.payloadSha256,
    result.phases.firstImport.pricing.payloadSha256,
  );
  assert.equal(result.phases.append.pricing.eventCount, 129);
  assert.equal(result.phases.append.pricing.cacheStatus, "published");
  assert.notEqual(
    result.phases.append.pricing.payloadSha256,
    result.phases.unchanged.pricing.payloadSha256,
  );
  assert.equal(result.phases.restartAfterAppend.pricing.cacheStatus, "reused");
  assert.equal(result.phases.mutation.pricing.cacheStatus, "published");

  const serialized = JSON.stringify(result);
  for (const privateSyntheticValue of [
    "synthetic-session-000000000000000000000000000000",
    "synthetic-cli-session-000000000000000000000000",
    "synthetic-message-",
    "synthetic-organization",
  ]) {
    assert.equal(serialized.includes(privateSyntheticValue), false, privateSyntheticValue);
  }
});
