import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import {
  CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
  CURRENT_Q1_CONFLICT_PAGE_SCHEMA,
  CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL,
  CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
  CURRENT_Q1_QUOTA_ANALYSIS_SOURCE_SHA256,
  observeCurrentQ1EffectiveHistoryGuard,
  validateCurrentQ1ConflictPageProof,
} from "./current-q1-conflict-proof.mjs";

const sourcePath = process.env.CURRENT_Q1_SOURCE_PATH
  ?? fileURLToPath(new URL("../src/storage-effective-history.ts", import.meta.url));
let sourceBytes;
try { sourceBytes = readFileSync(sourcePath); } catch { sourceBytes = null; }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourcePathForFrames = fileURLToPath(new URL("../src/storage-effective-history.ts", import.meta.url));
const quotaSourcePathForFrames = fileURLToPath(new URL("../src/quota-analysis-v11.ts", import.meta.url));
let quotaSourceBytes;
try { quotaSourceBytes = readFileSync(quotaSourcePathForFrames); } catch { quotaSourceBytes = null; }

function guardStack({ factoryLine = 26, guardLine = 544, factoryPath = sourcePathForFrames,
  guardPath = sourcePathForFrames, guardNamed = false, extra = [] } = {}) {
  return [
    "Error: STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE",
    `    at fail (${factoryPath}:${factoryLine}:25)`,
    ...extra,
    guardNamed ? `    at Object.readPage (${guardPath}:${guardLine}:81)` : `    at ${guardPath}:${guardLine}:81`,
  ].join("\n");
}

function realGuardStack({ factoryPath = sourcePathForFrames, factoryLine = 26,
  guardPath = sourcePathForFrames, guardLine = 544, mapSetupPath = sourcePathForFrames,
  mapSetupLine = 543, quotaPath = quotaSourcePathForFrames, quotaLine = 1447,
  finishPath = sourcePathForFrames, finishLine = 555,
  callerFrames = ["    at /synthetic/caller.mjs:1:1"] } = {}) {
  return [
    "Error: STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE",
    `    at fail (${factoryPath}:${factoryLine}:20)`,
    `    at ${guardPath}:${guardLine}:89`,
    "    at Array.map (<anonymous>)",
    `    at ${mapSetupPath}:${mapSetupLine}:39`,
    `    at ${quotaPath}:${quotaLine}:58`,
    `    at ${finishPath}:${finishLine}:15`,
    ...callerFrames,
  ].join("\n");
}

function guardServer(content = sourceBytes?.toString("utf8"), fix = () => {}, quotaContent = quotaSourceBytes?.toString("utf8")) {
  const calls = { moduleId: null, moduleIds: [], stacktraceCalls: 0 };
  const server = {
    config: { future: {} },
    environments: { ssr: { moduleGraph: { getModuleById(id) {
      calls.moduleId = id;
      calls.moduleIds.push(id);
      if (id === sourcePathForFrames) {
        return { transformResult: { map: { sources: ["storage-effective-history.ts"], sourcesContent: [content] } } };
      }
      if (id === quotaSourcePathForFrames) {
        return { transformResult: { map: { sources: ["quota-analysis-v11.ts"], sourcesContent: [quotaContent] } } };
      }
      return null;
    } } } },
    ssrFixStacktrace(holder) { calls.stacktraceCalls += 1; fix(holder); },
  };
  return { server, calls };
}

function telemetryRecord(eventId, eventTime) {
  return {
    schemaVersion: "usage-event-v1.1",
    eventId,
    eventTime,
    sessionUuid: "session:synthetic:current-q1",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 10,
    components: {
      inputUncachedTokens: 3,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 2,
      outputReasoningTokens: 0,
      outputCombinedTokens: 2,
    },
    accountPlanAttribution: {
      accountBasis: "same_source",
      accountTrackId: `account-track:v2:${"a".repeat(64)}`,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
  };
}

function association() {
  return {
    sourceId: "gcp-fastpath-oracle",
    sourceNamespace: "gcp-fastpath-oracle",
    ownerDigest: "a".repeat(64),
    ownerRevision: 7,
    authorityEpoch: 2,
    methodVersion: "effective-telemetry-owner-day-v1",
    stream: "usage",
    day: "2026-07-24",
    after: null,
    limit: 200,
    checkpoint: {
      keyDigest: "b".repeat(64),
      dependencyDigest: "c".repeat(64),
      method: "community-analysis:effective-model-checkpoint-1",
      headDigest: "d".repeat(64),
    },
  };
}

function compatibleRow(index) {
  const eventId = `event:synthetic:current-q1:${String(index).padStart(2, "0")}`;
  const eventTime = `2026-07-24T00:${String(index).padStart(2, "0")}:00.000Z`;
  const record = telemetryRecord(eventId, eventTime);
  return {
    methodVersion: "effective-telemetry-owner-day-v1",
    stream: "usage",
    participantId: "synthetic-participant-pseudonym",
    ownerDigest: "a".repeat(64),
    occurrenceId: eventId,
    eventTime,
    eventTimeConflict: false,
    status: "compatible",
    sourceCount: 1,
    sourceFormats: ["v11"],
    sourceRowIds: [index + 1],
    sourceRecordKeys: [`v11:${index + 1}`],
    recordJson: canonicalTelemetryV11Json(record),
  };
}

function conflictRow() {
  return {
    methodVersion: "effective-telemetry-owner-day-v1",
    stream: "usage",
    participantId: "synthetic-participant-pseudonym",
    ownerDigest: "a".repeat(64),
    occurrenceId: "event:synthetic:current-q1:conflict",
    eventTime: null,
    eventTimeConflict: true,
    status: "conflict",
    sourceCount: 2,
    sourceFormats: ["v11"],
    sourceRowIds: [10, 11],
    sourceRecordKeys: ["v11:10", "v11:11"],
    recordJson: null,
  };
}

function pageFixture() {
  return {
    methodVersion: "effective-telemetry-owner-day-v1",
    stream: "usage",
    participantId: "synthetic-participant-pseudonym",
    ownerDigest: "a".repeat(64),
    day: "2026-07-24",
    rows: [compatibleRow(1), compatibleRow(2), compatibleRow(3), compatibleRow(4),
      conflictRow(), compatibleRow(5), compatibleRow(6), compatibleRow(7), compatibleRow(8)],
    next: null,
  };
}

test("guard origin proof exposes only the exact pinned label and digests", () => {
  assert.ok(sourceBytes, "canonical source fixture unavailable");
  assert.equal(sha256(sourceBytes), CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256);
  const { server, calls } = guardServer(sourceBytes.toString("utf8"));
  const error = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  error.stack = guardStack();
  const proof = observeCurrentQ1EffectiveHistoryGuard(error, server);
  assert.equal(calls.moduleId, sourcePathForFrames);
  assert.deepEqual(calls.moduleIds, [sourcePathForFrames]);
  assert.equal(calls.stacktraceCalls, 1);
  assert.deepEqual(proof, {
    schemaVersion: "current-q1-effective-history-guard-origin-v2",
    guardLabel: CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL,
    sourceContentSha256: CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
    originProofSha256: proof.originProofSha256,
  });
  assert.match(proof.originProofSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.keys(proof).some((key) => /stack|error|path|record|sql|id/iu.test(key)), false);
  assert.equal(JSON.stringify(proof).includes(sourcePathForFrames), false);
  const named = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  named.stack = guardStack({ guardNamed: true });
  assert.ok(observeCurrentQ1EffectiveHistoryGuard(named, guardServer(sourceBytes.toString("utf8")).server));
});

test("the observed Vite-mapped guard chain proves only its pinned origin and excludes callers", () => {
  assert.ok(sourceBytes, "canonical source fixture unavailable");
  assert.ok(quotaSourceBytes, "quota reducer source fixture unavailable");
  assert.equal(sha256(sourceBytes), CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256);
  assert.equal(sha256(quotaSourceBytes), CURRENT_Q1_QUOTA_ANALYSIS_SOURCE_SHA256);
  const { server, calls } = guardServer(sourceBytes.toString("utf8"));
  const error = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  error.stack = realGuardStack();
  const proof = observeCurrentQ1EffectiveHistoryGuard(error, server);
  assert.ok(proof);
  assert.equal(calls.stacktraceCalls, 1);
  assert.deepEqual(calls.moduleIds, [sourcePathForFrames, quotaSourcePathForFrames]);
  assert.deepEqual({ ...proof, originProofSha256: "sha256" }, {
    schemaVersion: CURRENT_Q1_CONFLICT_ORIGIN_SCHEMA,
    guardLabel: CURRENT_Q1_EFFECTIVE_HISTORY_GUARD_LABEL,
    sourceContentSha256: CURRENT_Q1_EFFECTIVE_HISTORY_SOURCE_SHA256,
    originProofSha256: "sha256",
  });
  assert.match(proof.originProofSha256, /^[a-f0-9]{64}$/u);
  assert.equal(proof.schemaVersion, "current-q1-effective-history-guard-origin-v2");
  const anotherCaller = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  anotherCaller.stack = realGuardStack({ callerFrames: ["    at /synthetic/other-caller.mjs:9:2"] });
  assert.equal(observeCurrentQ1EffectiveHistoryGuard(anotherCaller,
    guardServer(sourceBytes.toString("utf8")).server).originProofSha256, proof.originProofSha256);
  const internalCaller = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  internalCaller.stack = realGuardStack({ callerFrames: ["    at node:internal/process/task_queues:95:5"] });
  assert.equal(observeCurrentQ1EffectiveHistoryGuard(internalCaller,
    guardServer(sourceBytes.toString("utf8")).server).originProofSha256, proof.originProofSha256);
  const bareAsyncFileUrl = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  bareAsyncFileUrl.stack = realGuardStack({ callerFrames: [`    at async ${pathToFileURL("/synthetic/caller path/worker.mjs").href}:11:3`] });
  assert.equal(observeCurrentQ1EffectiveHistoryGuard(bareAsyncFileUrl,
    guardServer(sourceBytes.toString("utf8")).server).originProofSha256, proof.originProofSha256);
  const namedAsyncFileUrl = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  namedAsyncFileUrl.stack = realGuardStack({ callerFrames: [`    at async task (${pathToFileURL("/synthetic/task.mjs").href}:12:4)`] });
  assert.equal(observeCurrentQ1EffectiveHistoryGuard(namedAsyncFileUrl,
    guardServer(sourceBytes.toString("utf8")).server).originProofSha256, proof.originProofSha256);
  assert.equal(JSON.stringify(proof).includes(sourcePathForFrames), false);
  assert.equal(JSON.stringify(proof).includes(quotaSourcePathForFrames), false);
});

test("guard origin rejects a wrong map, foreign path, wrong factory, intervening frame, or trailing frame", () => {
  assert.ok(sourceBytes, "canonical source fixture unavailable");
  const reject = (stack, content = sourceBytes, quotaContent = quotaSourceBytes?.toString("utf8")) => {
    const { server } = guardServer(content?.toString("utf8"), () => {}, quotaContent);
    const error = new Error("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
    error.stack = stack;
    return observeCurrentQ1EffectiveHistoryGuard(error, server);
  };
  assert.equal(reject(guardStack(), `${sourceBytes.toString("utf8")}\n`), null);
  assert.equal(reject(guardStack({ factoryPath: `${sourcePathForFrames}.foreign` })), null);
  assert.equal(reject(guardStack({ guardPath: `${sourcePathForFrames}.foreign` })), null);
  assert.equal(reject(guardStack({ factoryLine: 27 })), null);
  assert.equal(reject(guardStack({ extra: [`    at intervening (${sourcePathForFrames}:100:2)`] })), null);
  assert.equal(reject(`${guardStack()}\n    at trailing (${sourcePathForFrames}:545:2)`), null);
  assert.equal(reject("x".repeat(65_537)), null);
  assert.equal(reject(realGuardStack({ factoryPath: `${sourcePathForFrames}.foreign` })), null);
  assert.equal(reject(realGuardStack({ quotaPath: `${quotaSourcePathForFrames}.foreign` })), null);
  assert.equal(reject(realGuardStack({ factoryLine: 27 })), null);
  assert.equal(reject(realGuardStack({ guardLine: 545 })), null);
  assert.equal(reject(realGuardStack({ mapSetupLine: 544 })), null);
  assert.equal(reject(realGuardStack().replace("Array.map (<anonymous>)", "Array.filter (<anonymous>)")), null);
  assert.equal(reject(realGuardStack({ quotaLine: 1448 })), null);
  assert.equal(reject(realGuardStack({ finishLine: 554 })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: ["malformed caller frame"] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at ${sourcePathForFrames}:541:2`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at ${quotaSourcePathForFrames}:1448:2`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${pathToFileURL(sourcePathForFrames).href}:541:2`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${pathToFileURL(quotaSourcePathForFrames).href}:1448:2`] })), null);
  const sourceUrlAlias = pathToFileURL(sourcePathForFrames).href.replace(
    "/src/storage-effective-history.ts", "/scripts/../src/storage-effective-history.ts");
  assert.notEqual(sourceUrlAlias, pathToFileURL(sourcePathForFrames).href);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${sourceUrlAlias}:541:2`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at ${sourcePathForFrames.replace("/apps/worker/src/", "/apps/worker/scripts/../src/")}:541:2`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: ["    at async https://synthetic.invalid/caller.mjs:1:1"] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: ["    at async file://remote.invalid/caller.mjs:1:1"] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: ["    at async file://%zz/caller.mjs:1:1"] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: ["    at async file:///synthetic/caller.mjs:0:1"] })), null);
  for (const encodedControl of ["%00", "%01", "%1f", "%7f", "%0a", "%0d"]) {
    assert.equal(reject(realGuardStack({ callerFrames: [`    at async file:///synthetic/${encodedControl}caller.mjs:11:3`] })), null);
  }
  for (const rawControl of ["\0", "\x01", "\x1f", "\x7f", "\n", "\r"]) {
    assert.equal(reject(realGuardStack({ callerFrames: [`    at /synthetic/caller${rawControl}.mjs:11:3`] })), null);
  }
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${pathToFileURL("/synthetic/caller path/worker.mjs").href.replace("%20", " ")}:1:1`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${pathToFileURL("/synthetic/caller.mjs").href}?debug=1:1:1`] })), null);
  const encodedSeparator = pathToFileURL("/synthetic/caller.mjs").href.replace("caller.mjs", "caller%2Fmjs");
  assert.equal(reject(realGuardStack({ callerFrames: [`    at async ${encodedSeparator}:1:1`] })), null);
  assert.equal(reject(realGuardStack({ callerFrames: Array.from({ length: 7 }, (_, index) => `    at /synthetic/caller-${index}.mjs:1:1`) })), null);
  const extraOriginPrefix = realGuardStack().replace("Error: STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE\n",
    `Error: STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE\n    at ${sourcePathForFrames}:27:1\n`);
  assert.equal(reject(extraOriginPrefix), null);
  const intervening = realGuardStack().replace(`    at ${sourcePathForFrames}:544:89\n`,
    `    at ${sourcePathForFrames}:100:2\n    at ${sourcePathForFrames}:544:89\n`);
  assert.equal(reject(intervening), null);
  const wrongOrder = realGuardStack().replace(
    `    at ${sourcePathForFrames}:543:39\n    at ${quotaSourcePathForFrames}:1447:58\n`,
    `    at ${quotaSourcePathForFrames}:1447:58\n    at ${sourcePathForFrames}:543:39\n`);
  assert.equal(reject(wrongOrder), null);
  assert.equal(reject(realGuardStack(), sourceBytes, `${quotaSourceBytes?.toString("utf8")}\n`), null);
  const generic = new Error("unknown failure");
  assert.equal(observeCurrentQ1EffectiveHistoryGuard(generic, guardServer().server), null);
});

test("a bounded canonical conflict page yields only a closed proof envelope", () => {
  const value = validateCurrentQ1ConflictPageProof({ page: pageFixture(),
    expectedAssociation: association(), observedAssociation: association() });
  assert.deepEqual(value, {
    schemaVersion: CURRENT_Q1_CONFLICT_PAGE_SCHEMA,
    pageSha256: value.pageSha256,
    associationSha256: value.associationSha256,
    rowCount: 9,
    compatibleCount: 8,
    conflictCount: 1,
    compatibleRowsSchemaValid: true,
    compatibleRowsTimeValid: true,
    conflictFieldsNull: true,
  });
  assert.match(value.pageSha256, /^[a-f0-9]{64}$/u);
  assert.match(value.associationSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(value).includes("synthetic-participant"), false);
  assert.equal(JSON.stringify(value).includes("event:synthetic"), false);
  assert.equal(JSON.stringify(value).includes(sourcePathForFrames), false);
});

test("wrong owner, day, cursor, dependency, or head association fails closed", () => {
  const expectedAssociation = association();
  for (const mutate of [
    (value) => { value.ownerDigest = "e".repeat(64); },
    (value) => { value.day = "2026-07-25"; },
    (value) => { value.after = { observedAtMs: Date.parse("2026-07-24T00:00:00.000Z"), occurrenceId: "event:prior:001" }; },
    (value) => { value.checkpoint.dependencyDigest = "e".repeat(64); },
    (value) => { value.checkpoint.headDigest = "e".repeat(64); },
  ]) {
    const observedAssociation = structuredClone(expectedAssociation);
    mutate(observedAssociation);
    assert.equal(validateCurrentQ1ConflictPageProof({ page: pageFixture(), expectedAssociation, observedAssociation }), null);
  }
  const page = pageFixture();
  page.ownerDigest = "e".repeat(64);
  assert.equal(validateCurrentQ1ConflictPageProof({ page, expectedAssociation,
    observedAssociation: expectedAssociation }), null);
});

test("malformed compatible records, page fields, statuses, and conflict nulls fail closed", () => {
  const expectedAssociation = association();
  const rejects = (page) => assert.equal(validateCurrentQ1ConflictPageProof({ page,
    expectedAssociation, observedAssociation: expectedAssociation }), null);
  const malformed = pageFixture();
  malformed.rows[0].recordJson = "{}";
  rejects(malformed);
  const malformedTime = pageFixture();
  malformedTime.rows[0].eventTime = "not-a-time";
  rejects(malformedTime);
  const wrongDay = pageFixture();
  wrongDay.rows[0].eventTime = "2026-07-25T00:01:00.000Z";
  wrongDay.rows[0].recordJson = canonicalTelemetryV11Json(telemetryRecord(wrongDay.rows[0].occurrenceId,
    wrongDay.rows[0].eventTime));
  rejects(wrongDay);
  const extraRowField = pageFixture();
  extraRowField.rows[0].error = "private";
  rejects(extraRowField);
  const otherStatus = pageFixture();
  otherStatus.rows[4].status = "deferred";
  rejects(otherStatus);
  const nonNullConflictRecord = pageFixture();
  nonNullConflictRecord.rows[4].recordJson = "{}";
  rejects(nonNullConflictRecord);
  const nonNullConflictTime = pageFixture();
  nonNullConflictTime.rows[4].eventTime = "2026-07-24T00:04:30.000Z";
  rejects(nonNullConflictTime);
  const noConflict = pageFixture();
  noConflict.rows[4] = compatibleRow(4);
  rejects(noConflict);
  const wrongNext = pageFixture();
  wrongNext.next = { observedAtMs: Date.parse("2026-07-24T00:09:00.000Z"), occurrenceId: "event:next:001" };
  rejects(wrongNext);
  const extraPageField = pageFixture();
  extraPageField.sourcePath = sourcePathForFrames;
  rejects(extraPageField);
  assert.equal(validateCurrentQ1ConflictPageProof(), null);
});

test("source provenance arrays match canonical formats, keys, row ids, and entry counts", () => {
  const expectedAssociation = association();
  const accepts = (page) => assert.ok(validateCurrentQ1ConflictPageProof({ page,
    expectedAssociation, observedAssociation: expectedAssociation }));
  const rejects = (page) => assert.equal(validateCurrentQ1ConflictPageProof({ page,
    expectedAssociation, observedAssociation: expectedAssociation }), null);

  const impossibleSingleEntryConflict = pageFixture();
  Object.assign(impossibleSingleEntryConflict.rows[4], {
    sourceCount: 1,
    sourceRowIds: [10],
    sourceRecordKeys: ["v11:10"],
  });
  rejects(impossibleSingleEntryConflict);

  const sourceCountBelowArrays = pageFixture();
  sourceCountBelowArrays.rows[4].sourceCount = 1;
  rejects(sourceCountBelowArrays);

  const emptyConflictKeys = pageFixture();
  emptyConflictKeys.rows[4].sourceRecordKeys = [];
  rejects(emptyConflictKeys);

  const emptyConflictFormats = pageFixture();
  emptyConflictFormats.rows[4].sourceFormats = [];
  rejects(emptyConflictFormats);

  const emptyCompatibleKeys = pageFixture();
  emptyCompatibleKeys.rows[0].sourceRecordKeys = [];
  rejects(emptyCompatibleKeys);

  const emptyCompatibleFormats = pageFixture();
  emptyCompatibleFormats.rows[0].sourceFormats = [];
  rejects(emptyCompatibleFormats);

  const incompatibleFormatKey = pageFixture();
  incompatibleFormatKey.rows[0].sourceFormats = ["v12"];
  rejects(incompatibleFormatKey);

  const incompatibleCompatibleRowIds = pageFixture();
  incompatibleCompatibleRowIds.rows[0].sourceRowIds = [];
  rejects(incompatibleCompatibleRowIds);

  const nonCanonicalDirectKey = pageFixture();
  nonCanonicalDirectKey.rows[0].sourceRecordKeys = ["v11:001"];
  rejects(nonCanonicalDirectKey);

  const typedV12Page = pageFixture();
  Object.assign(typedV12Page.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v12"],
    sourceRowIds: [],
    sourceRecordKeys: ["v12:record:50"],
  });
  Object.assign(typedV12Page.rows[4], {
    sourceCount: 2,
    sourceFormats: ["v12"],
    sourceRowIds: [],
    sourceRecordKeys: ["v12:record:51", "v12:record:52"],
  });
  accepts(typedV12Page);

  const mixedCompatiblePage = pageFixture();
  Object.assign(mixedCompatiblePage.rows[0], {
    sourceCount: 2,
    sourceFormats: ["v11", "v12"],
    sourceRowIds: [2],
    sourceRecordKeys: ["v11:2", "v12:record:53"],
  });
  accepts(mixedCompatiblePage);

  const v1HistoryCompatiblePage = pageFixture();
  Object.assign(v1HistoryCompatiblePage.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v1"],
    sourceRowIds: [],
    sourceRecordKeys: ["v1:history:100"],
  });
  accepts(v1HistoryCompatiblePage);

  const v11HistoryConflictPage = pageFixture();
  Object.assign(v11HistoryConflictPage.rows[4], {
    sourceCount: 2,
    sourceFormats: ["v11"],
    sourceRowIds: [],
    sourceRecordKeys: ["v11:history:101", "v11:history:102"],
  });
  accepts(v11HistoryConflictPage);

  const mixedHistoryAndDirectCompatiblePage = pageFixture();
  Object.assign(mixedHistoryAndDirectCompatiblePage.rows[0], {
    sourceCount: 2,
    sourceFormats: ["v11"],
    sourceRowIds: [2],
    sourceRecordKeys: ["v11:2", "v11:history:103"],
  });
  accepts(mixedHistoryAndDirectCompatiblePage);

  const historyIdIncorrectlyCountedAsDirect = pageFixture();
  Object.assign(historyIdIncorrectlyCountedAsDirect.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v11"],
    sourceRowIds: [103],
    sourceRecordKeys: ["v11:history:103"],
  });
  rejects(historyIdIncorrectlyCountedAsDirect);

  const mixedHistoryIdIncorrectlyCountedAsDirect = pageFixture();
  Object.assign(mixedHistoryIdIncorrectlyCountedAsDirect.rows[0], {
    sourceCount: 2,
    sourceFormats: ["v11"],
    sourceRowIds: [2, 103],
    sourceRecordKeys: ["v11:2", "v11:history:103"],
  });
  rejects(mixedHistoryIdIncorrectlyCountedAsDirect);

  const malformedHistoryLeadingZero = pageFixture();
  Object.assign(malformedHistoryLeadingZero.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v11"],
    sourceRowIds: [],
    sourceRecordKeys: ["v11:history:0103"],
  });
  rejects(malformedHistoryLeadingZero);

  const malformedHistorySuffix = pageFixture();
  Object.assign(malformedHistorySuffix.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v1"],
    sourceRowIds: [],
    sourceRecordKeys: ["v1:history:104:extra"],
  });
  rejects(malformedHistorySuffix);

  const directKeyIdMismatch = pageFixture();
  Object.assign(directKeyIdMismatch.rows[0], {
    sourceCount: 1,
    sourceFormats: ["v11"],
    sourceRowIds: [3],
    sourceRecordKeys: ["v11:2"],
  });
  rejects(directKeyIdMismatch);
});
