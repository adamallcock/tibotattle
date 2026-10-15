import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCurrentQ1D7CurrentPublicExpectation, buildCurrentQ1D7PerDateExpectation, buildCurrentQ1D7WindowProofs }
  from "./current-q1-d7-expectation.mjs";

// The isolated proposal resolves workspace packages through the source
// checkout only for this pure contract check; all fixtures stay in memory.
function repositoryRoot(start) {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(resolve(directory, "packages/telemetry-contract/index.js"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("telemetry-contract package unavailable");
    directory = parent;
  }
}

const telemetryUrl = pathToFileURL(resolve(repositoryRoot(process.cwd()), "packages/telemetry-contract/index.js")).href;
const hookSource = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@app-usagemonitor/telemetry-contract") {
    return { url: ${JSON.stringify(telemetryUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url);

const Contract = await import("./current-q1-d7-contract.mjs");
const Telemetry = await import(telemetryUrl);
const SHA = Contract.currentQ1D7JsonSha256;
const H = (value) => value.repeat(64);
const OWNERS = ["a", "b", "c", "d"];
const STREAMS = ["quota", "session", "usage"];
const CASES = ["conflictPreserving", "conflictFreePositive"];
const dates = (from, length) => Array.from({ length }, (_, index) =>
  new Date(Date.parse(`${from}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));

function bindingFixture() {
  const sourceFiles = [...new Set(Contract.CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS)]
    .map((path) => ({ path, sha256: H("a") }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const binding = { schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.binding, decisionId: "D7",
    sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle",
    source: { head: "1".repeat(40), files: sourceFiles, sha256: SHA(sourceFiles) }, migrationSha256: H("b"),
    bounds: { ...Contract.CURRENT_Q1_D7_BOUNDS },
    runtime: { version: "v26.2.0", platform: "darwin", arch: "arm64",
      binarySha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
      pinnedNowMs: Contract.CURRENT_Q1_D7_NOW_MS, randomSeed: "current-q1-reference", sqliteVersion: "synthetic-check" },
    cases: {} };
  for (const [index, caseId] of CASES.entries()) {
    const conflictDays = index === 0 ? ["2026-04-17", "2026-04-18"] : [];
    binding.cases[caseId] = { caseId,
      corpusCaseId: index === 0 ? "conflict-preserving-negative-v2" : "conflict-free-positive-v2",
      corpusSha256: index === 0 ? "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e" : H("2"),
      topologySha256: H(index === 0 ? "3" : "4"), admissionSha256: H(index === 0 ? "5" : "6"),
      sourceInvariantSha256: H(index === 0 ? "7" : "8"), owners: [...OWNERS], sourceDays: 170,
      recordCount: 14832, primaryRecordCount: 14830, extraAdmissions: 2, conflictDays,
      dailyDays: dates("2026-04-15", 170).filter((day) => !conflictDays.includes(day)),
      modelDays: Contract.currentQ1D7GraphDays() };
  }
  Contract.validateCurrentQ1D7Binding(binding);
  return binding;
}

function sourceWitnesses(binding) {
  const source = binding.cases.conflictPreserving.sourceInvariantSha256;
  return binding.cases.conflictPreserving.conflictDays.flatMap((day) => STREAMS.map((stream) => ({
    owner: "a", day, stream, method: "effective-telemetry-owner-day-v1", pageCount: 1,
    rows: stream === "usage" ? 9 : 1, compatibleRows: stream === "usage" ? 8 : 1,
    conflictRows: stream === "usage" ? 1 : 0, complete: true, cursorOrderValid: true,
    occurrenceMatched: stream === "usage", compatibleRowsValid: true,
    conflictRecordJsonNull: stream === "usage", conflictEventTimeNull: stream === "usage",
    sourceInvariantSha256: source, readerEvidenceSha256: SHA([day, stream]), nativePages: [],
  })));
}

function affectedDays(days, conflictDays) {
  return days.filter((day) => conflictDays.some((sourceDay) => {
    const fromDay = new Date(Date.parse(`${day}T00:00:00.000Z`) - 100 * 86_400_000).toISOString().slice(0, 10);
    return sourceDay >= fromDay && sourceDay <= day;
  }));
}

function enrichNativePages(binding, sourceWitnesses, windowProofs) {
  const enriched = structuredClone(sourceWitnesses);
  for (const window of windowProofs) {
    const sourceDay = binding.cases.conflictPreserving.conflictDays
      .find((day) => day >= window.fromDay && day <= window.throughDay);
    const witness = enriched.find((entry) => entry.owner === "a" && entry.day === sourceDay && entry.stream === "usage");
    assert.ok(witness);
    witness.nativePages.push({ modelDay: window.day, checkpointMethod: "synthetic-effective-model-checkpoint-1",
      dependencyDigest: SHA(["dependency", window.day]), keyDigest: SHA(["key", window.day]),
      headDigest: SHA(["head", window.day]), cursorSha256: SHA(["cursor", sourceDay, window.day]),
      pageSha256: SHA(["canonical-page", sourceDay]) });
  }
  return enriched;
}

function sourceConflictProofs(binding, sourceWitnesses, windowProofs) {
  const bindingSha256 = SHA(binding);
  const sourceInvariantSha256 = binding.cases.conflictPreserving.sourceInvariantSha256;
  return windowProofs.map((window) => {
    const sourceDay = binding.cases.conflictPreserving.conflictDays
      .find((day) => day >= window.fromDay && day <= window.throughDay);
    const witness = sourceWitnesses.find((entry) => entry.owner === "a" && entry.day === sourceDay && entry.stream === "usage");
    const page = witness?.nativePages.find((entry) => entry.modelDay === window.day);
    assert.ok(witness && page);
    const proof = { schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.conflict,
      caseId: "conflictPreserving", bindingSha256,
      scope: { owner: "a", metric: "model", day: window.day, sourceKind: "effective",
        dependencyDigest: page.dependencyDigest, keyDigest: page.keyDigest, headDigest: page.headDigest,
        cursorSha256: page.cursorSha256, checkpointMethod: page.checkpointMethod },
      origin: { label: "effective_history_guard_544", moduleSha256: H("a"), originProofSha256: H("b"),
        factoryLine: 26, guardLine: 544, observerSha256: H("a") },
      reader: { method: "effective-telemetry-owner-day-v1", stream: "usage", pageSha256: page.pageSha256,
        sourceDay, sourceWitnessSha256: SHA(witness), associationSha256: null,
        rows: 9, compatibleRows: 8, conflictRows: 1, compatibleRowsValid: true,
        conflictRecordJsonNull: true, conflictEventTimeNull: true, cursorMatched: true },
      fences: { authorityBeforeSha256: H("d"), authorityAfterSha256: H("d"),
        sourceBeforeSha256: sourceInvariantSha256, sourceAfterSha256: sourceInvariantSha256 } };
    proof.reader.associationSha256 = Contract.currentQ1D7ConflictAssociationSha256(proof, witness);
    return proof;
  });
}

function readyResult(day) {
  return { status: "ready", planType: "pro", fit: { status: "fitted", capacityUsdByModel: { "gpt-5.6-sol": 10 } },
    voidedBinCount: 0, poolCount: 1, quotaRowCount: 1, usageEventCount: 1, unpricedUsageEventCount: 0,
    poisonedBinCount: 0, latestQuotaObservedAt: `${day}T12:00:00.000Z`, attributionStatus: "legacy_conditional",
    attributionMethod: "synthetic-current-reader", inputFingerprint: H("9") };
}

function ownerResults(binding, caseId, conflicts = []) {
  const omitted = new Set(conflicts.map(({ owner, day }) => `${owner}/${day}`));
  const results = new Map();
  for (const owner of OWNERS) for (const day of binding.cases[caseId].modelDays) {
    const coordinate = `${owner}/${day}`;
    if (!omitted.has(coordinate)) results.set(coordinate, readyResult(day));
  }
  return results;
}

function positiveExpectation(binding) {
  return buildCurrentQ1D7PerDateExpectation({ binding, caseId: "conflictFreePositive", current, contract: Contract,
    ownerResults: ownerResults(binding, "conflictFreePositive"), sourceWitnesses: [], sourceConflictProofs: [] });
}

const current = {
  ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG: [{ planType: "pro", multiplier: 1 }],
  COMMUNITY_ALLOWANCE_TRAILING_DAYS: 30,
  buildCommunityModelCompositionDay(collection, day) {
    const count = collection.compositions.length;
    return Telemetry.projectAdminModelHistoryDay({ day,
      catalogVersion: Telemetry.ADMIN_MODEL_HISTORY_CATALOG_VERSION,
      values: count ? [["gpt-5.6-sol", 10, count]] : [], fittedParticipantCount: count,
      unstableParticipantCount: 0, staleParticipantCount: 0,
      refusedParticipantCount: collection.refusedParticipantCount,
      v1ParticipantCount: collection.v1ParticipantCount,
      unsupportedSourceParticipantCount: collection.unsupportedSourceParticipantCount });
  },
  projectAdminModelHistoryDay: Telemetry.projectAdminModelHistoryDay,
};

test("builds both exact 70-date, 280-owner current expectations from injected results", () => {
  const binding = bindingFixture();
  const initialWitnesses = sourceWitnesses(binding);
  const initialWindows = buildCurrentQ1D7WindowProofs({ binding, caseId: "conflictPreserving",
    sourceWitnesses: initialWitnesses });
  assert.deepEqual(initialWindows.map((proof) => proof.day),
    ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"]);
  const negativeWitnesses = enrichNativePages(binding, initialWitnesses, initialWindows);
  const negativeWindows = buildCurrentQ1D7WindowProofs({ binding, caseId: "conflictPreserving",
    sourceWitnesses: negativeWitnesses });
  const negativeProofs = sourceConflictProofs(binding, negativeWitnesses, negativeWindows);
  assert.notDeepEqual(initialWindows.map((proof) => proof.sourceWitnessSha256),
    negativeWindows.map((proof) => proof.sourceWitnessSha256));
  assert.notDeepEqual(initialWindows.map((proof) => proof.sourceWindowSha256),
    negativeWindows.map((proof) => proof.sourceWindowSha256));

  const negative = buildCurrentQ1D7PerDateExpectation({ binding, caseId: "conflictPreserving", current, contract: Contract,
    ownerResults: ownerResults(binding, "conflictPreserving", negativeProofs.map((proof) => proof.scope)),
    sourceWitnesses: negativeWitnesses, sourceConflictProofs: negativeProofs });
  assert.equal(negative.days.length, 70);
  assert.equal(negative.ownerEvidence.length, 280);
  assert.equal(negative.windowProofs.length, 4);
  assert.deepEqual(negative.windowProofs, negativeWindows);
  assert.deepEqual(negative.sourceWitnesses, negativeWitnesses);
  assert.equal(negative.sourceConflictProofs.length, 4);
  assert.equal(negative.ownerEvidence.filter((entry) => entry.conflictProofSha256 !== null).length, 4);
  assert.ok(negative.days.slice(0, 4).every((day) => day.fittedParticipantCount === 3
    && day.refusedParticipantCount === 1));
  const negativePublic = buildCurrentQ1D7CurrentPublicExpectation({ expectation: negative, binding, contract: Contract });
  assert.deepEqual(negativePublic.days.map((row) => row.day), Contract.currentQ1D7PublicDays(binding));
  for (let index = 0; index < negativePublic.days.length; index++) {
    assert.deepEqual(negativePublic.days[index].models, negative.days[index].values);
  }

  const positive = positiveExpectation(binding);
  assert.deepEqual(buildCurrentQ1D7WindowProofs({ binding, caseId: "conflictFreePositive", sourceWitnesses: [] }), []);
  assert.equal(positive.days.length, 70);
  assert.equal(positive.ownerEvidence.length, 280);
  assert.deepEqual(positive.windowProofs, []);
  assert.deepEqual(positive.sourceConflictProofs, []);
  assert.ok(positive.days.every((day) => day.fittedParticipantCount === 4 && day.refusedParticipantCount === 0));
});

test("builds the closed, frozen 69-day public expectation from validated current projections", () => {
  const binding = bindingFixture();
  const expectation = positiveExpectation(binding);
  const actual = buildCurrentQ1D7CurrentPublicExpectation({ expectation, binding, contract: Contract });
  const graphDays = Contract.currentQ1D7GraphDays();
  const publicDays = graphDays.slice(0, -1);

  assert.deepEqual(Object.keys(actual), ["schemaVersion", "caseId", "bindingSha256", "days"]);
  assert.equal(actual.schemaVersion, "current-q1-d7-current-public-expectation-v1");
  assert.equal(actual.caseId, "conflictFreePositive");
  assert.equal(actual.bindingSha256, SHA(binding));
  assert.deepEqual(actual.days.map((row) => row.day), publicDays);
  assert.equal(actual.days.length, 69);
  for (let index = 0; index < actual.days.length; index++) {
    assert.deepEqual(actual.days[index].models, expectation.days[index].values);
  }
  assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.days)
    && Object.isFrozen(actual.days[0]) && Object.isFrozen(actual.days[0].models)
    && Object.isFrozen(actual.days[0].models[0]));

  const missingDay = positiveExpectation(binding);
  missingDay.days.pop();
  assert.throws(() => buildCurrentQ1D7CurrentPublicExpectation({ expectation: missingDay, binding, contract: Contract }),
    { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });

  const reorderedDays = positiveExpectation(binding);
  [reorderedDays.days[0], reorderedDays.days[1]] = [reorderedDays.days[1], reorderedDays.days[0]];
  assert.throws(() => buildCurrentQ1D7CurrentPublicExpectation({ expectation: reorderedDays, binding, contract: Contract }),
    { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });

  const extraDay = positiveExpectation(binding);
  extraDay.days.push(structuredClone(extraDay.days.at(-1)));
  assert.throws(() => buildCurrentQ1D7CurrentPublicExpectation({ expectation: extraDay, binding, contract: Contract }),
    { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });

  const changedModels = structuredClone(positiveExpectation(binding));
  changedModels.days[0].values[0][1] += 1;
  assert.throws(() => buildCurrentQ1D7CurrentPublicExpectation({ expectation: changedModels, binding, contract: Contract }),
    { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });

  const wrongPublicWindow = { ...Contract, currentQ1D7PublicDays: () => publicDays.slice(1) };
  assert.throws(() => buildCurrentQ1D7CurrentPublicExpectation({ expectation, binding, contract: wrongPublicWindow }),
    { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });
});

test("fails closed when any non-conflict current owner result is absent", () => {
  const binding = bindingFixture();
  const results = ownerResults(binding, "conflictFreePositive");
  results.delete("d/2026-07-24");
  assert.throws(() => buildCurrentQ1D7PerDateExpectation({ binding, caseId: "conflictFreePositive", current,
    contract: Contract, ownerResults: results, sourceWitnesses: [], sourceConflictProofs: [] }),
  { code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED" });
});

test("rejects a missing native page association and a wrong association digest", () => {
  const binding = bindingFixture();
  const initial = sourceWitnesses(binding);
  const initialWindows = buildCurrentQ1D7WindowProofs({ binding, caseId: "conflictPreserving", sourceWitnesses: initial });
  const witnesses = enrichNativePages(binding, initial, initialWindows);
  const windows = buildCurrentQ1D7WindowProofs({ binding, caseId: "conflictPreserving", sourceWitnesses: witnesses });
  const proofs = sourceConflictProofs(binding, witnesses, windows);
  const results = ownerResults(binding, "conflictPreserving", proofs.map((proof) => proof.scope));

  const missingPageWitnesses = structuredClone(witnesses);
  const usageWitness = missingPageWitnesses.find((witness) => witness.stream === "usage");
  usageWitness.nativePages.pop();
  assert.throws(() => buildCurrentQ1D7PerDateExpectation({ binding, caseId: "conflictPreserving", current,
    contract: Contract, ownerResults: results, sourceWitnesses: missingPageWitnesses, sourceConflictProofs: proofs }),
  { code: "CURRENT_Q1_D7_CONTRACT_INVALID" });

  const wrongAssociationProofs = structuredClone(proofs);
  wrongAssociationProofs[0].reader.associationSha256 = H("e");
  assert.throws(() => buildCurrentQ1D7PerDateExpectation({ binding, caseId: "conflictPreserving", current,
    contract: Contract, ownerResults: results, sourceWitnesses: witnesses, sourceConflictProofs: wrongAssociationProofs }),
  { code: "CURRENT_Q1_D7_CONTRACT_INVALID" });
});
