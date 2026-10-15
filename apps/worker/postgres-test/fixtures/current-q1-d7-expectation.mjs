/**
 * Pure pre-candidate builder for current per-date D7 expectation evidence.
 *
 * The caller supplies current source-reader results, source-day witnesses,
 * and source-conflict proofs produced by the exact conflict-proof helper.
 * This module derives the current 100-day window predicate, calls the current
 * model-day factories, and validates the closed expectation with the frozen
 * contract. It does not read candidate output or a database.
 */

import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const OWNERS = Object.freeze(["a", "b", "c", "d"]);
const STREAMS = Object.freeze(["quota", "session", "usage"]);
const READY_RESULT_KEYS = Object.freeze([
  "status", "planType", "fit", "voidedBinCount", "poolCount", "quotaRowCount", "usageEventCount",
  "unpricedUsageEventCount", "poisonedBinCount", "latestQuotaObservedAt", "attributionStatus",
  "attributionMethod", "inputFingerprint",
]);
const REFUSAL_RESULT_KEYS = Object.freeze(["status", "reason"]);
const WITNESS_KEYS = Object.freeze([
  "owner", "day", "stream", "method", "pageCount", "rows", "compatibleRows", "conflictRows", "complete",
  "cursorOrderValid", "occurrenceMatched", "compatibleRowsValid", "conflictRecordJsonNull", "conflictEventTimeNull",
  "sourceInvariantSha256", "readerEvidenceSha256",
]);
const INPUT_WITNESS_KEYS = Object.freeze([...WITNESS_KEYS, "nativePages"]);
const SCHEMA_VERSION = "current-q1-d7-per-date-expectation-v1";
const WINDOW_PROOF_SCHEMA_VERSION = "current-q1-d7-source-window-proof-v1";
const DERIVATION = "current-canonical-reader-reducer-factories";
const WINDOW_DERIVATION = "current-canonical-reader-window-predicate";
const BUILT_EXPECTATION_SHA256 = new WeakMap();

function invalid() {
  throw Object.assign(new Error("CURRENT_Q1_D7_EXPECTATION_UNRESOLVED"), {
    code: "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED",
  });
}

function requireFact(condition) {
  if (!condition) invalid();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function jsonSha256(value) {
  const json = JSON.stringify(value);
  requireFact(typeof json === "string");
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) === value;
}

function addDays(day, amount) {
  requireFact(validDay(day) && Number.isSafeInteger(amount));
  const milliseconds = Date.parse(`${day}T00:00:00.000Z`) + amount * DAY_MS;
  requireFact(Number.isFinite(milliseconds));
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function api(contract, current) {
  requireFact(isObject(contract) && isObject(current)
    && isObject(contract.CURRENT_Q1_D7_SCHEMAS)
    && typeof contract.currentQ1D7JsonSha256 === "function"
    && typeof contract.currentQ1D7GraphDays === "function"
    && typeof contract.validateCurrentQ1D7Binding === "function"
    && typeof contract.validateCurrentQ1D7SourceConflictProof === "function"
    && typeof contract.validateCurrentQ1D7PerDateExpectation === "function"
    && typeof current.buildCommunityModelCompositionDay === "function"
    && typeof current.projectAdminModelHistoryDay === "function"
    && Array.isArray(current.ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG)
    && integer(current.COMMUNITY_ALLOWANCE_TRAILING_DAYS)
    && current.COMMUNITY_ALLOWANCE_TRAILING_DAYS > 0);
  requireFact(contract.CURRENT_Q1_D7_SCHEMAS.expectation === SCHEMA_VERSION);
  return {
    sha: contract.currentQ1D7JsonSha256,
    days: contract.currentQ1D7GraphDays,
    validateBinding: contract.validateCurrentQ1D7Binding,
    validateConflictProof: contract.validateCurrentQ1D7SourceConflictProof,
    validateExpectation: contract.validateCurrentQ1D7PerDateExpectation,
  };
}

function ownerDay(owner, day) {
  return `${owner}/${day}`;
}

function expectedWindowWitnesses(witnesses, fromDay, throughDay, sha) {
  return witnesses.filter((witness) => witness.day >= fromDay && witness.day <= throughDay)
    .map((witness) => sha(witness));
}

/** Hash the exact window descriptor and its source-witness digests. */
export function currentQ1D7SourceWindowSha256(input, contract) {
  requireFact(isObject(contract) && typeof contract.currentQ1D7JsonSha256 === "function");
  requireFact(exactKeys(input, ["caseId", "bindingSha256", "owner", "day", "fromDay", "throughDay",
    "sourceInvariantSha256", "sourceWitnessSha256"]));
  const { caseId, bindingSha256, owner, day, fromDay, throughDay, sourceInvariantSha256, sourceWitnessSha256 } = input;
  requireFact(["conflictPreserving", "conflictFreePositive"].includes(caseId)
    && hash(bindingSha256) && OWNERS.includes(owner) && validDay(day) && validDay(fromDay)
    && validDay(throughDay) && throughDay === day && fromDay === addDays(day, -100)
    && hash(sourceInvariantSha256) && Array.isArray(sourceWitnessSha256)
    && sourceWitnessSha256.length >= STREAMS.length && sourceWitnessSha256.every(hash));
  return contract.currentQ1D7JsonSha256({ schemaVersion: WINDOW_PROOF_SCHEMA_VERSION, caseId, bindingSha256,
    owner, day, fromDay, throughDay, sourceInvariantSha256, sourceWitnessSha256 });
}

function projectWitness(value, sourceInvariantSha256) {
  requireFact(exactKeys(value, INPUT_WITNESS_KEYS) && Array.isArray(value.nativePages));
  const projected = Object.fromEntries(WITNESS_KEYS.map((key) => [key, value[key]]));
  requireFact(projected.owner === "a" && validDay(projected.day) && STREAMS.includes(projected.stream)
    && projected.method === "effective-telemetry-owner-day-v1"
    && integer(projected.pageCount) && projected.pageCount >= 1 && projected.pageCount <= 256
    && [projected.rows, projected.compatibleRows, projected.conflictRows].every(integer)
    && projected.compatibleRows + projected.conflictRows === projected.rows
    && projected.complete === true && projected.cursorOrderValid === true
    && projected.compatibleRowsValid === true && projected.sourceInvariantSha256 === sourceInvariantSha256
    && hash(projected.readerEvidenceSha256));
  if (projected.stream === "usage") {
    requireFact(projected.conflictRows === 1 && projected.occurrenceMatched === true
      && projected.conflictRecordJsonNull === true && projected.conflictEventTimeNull === true);
  } else {
    requireFact(projected.conflictRows === 0 && projected.occurrenceMatched === false
      && projected.conflictRecordJsonNull === false && projected.conflictEventTimeNull === false);
  }
  return { ...projected, nativePages: value.nativePages };
}

/**
 * Build the current 100-day source-window proofs before native probes run.
 * The source witness digests bind the full current witness, including its
 * validated nativePages association when native probes have completed.
 */
export function buildCurrentQ1D7WindowProofs(input) {
  requireFact(exactKeys(input, ["binding", "caseId", "sourceWitnesses"]));
  const { binding, caseId, sourceWitnesses } = input;
  requireFact(isObject(binding) && ["conflictPreserving", "conflictFreePositive"].includes(caseId)
    && Array.isArray(sourceWitnesses));
  const caseBinding = binding.cases?.[caseId];
  requireFact(isObject(caseBinding) && caseBinding.caseId === caseId
    && Array.isArray(caseBinding.owners) && same(caseBinding.owners, OWNERS)
    && Array.isArray(caseBinding.modelDays) && caseBinding.modelDays.length === 70
    && caseBinding.modelDays.every(validDay) && new Set(caseBinding.modelDays).size === 70
    && Array.isArray(caseBinding.conflictDays) && caseBinding.conflictDays.every(validDay)
    && new Set(caseBinding.conflictDays).size === caseBinding.conflictDays.length
    && (caseId === "conflictPreserving" ? caseBinding.conflictDays.length > 0 : caseBinding.conflictDays.length === 0)
    && hash(caseBinding.sourceInvariantSha256));

  const days = caseBinding.modelDays;
  const conflictDays = caseBinding.conflictDays;
  const witnesses = sourceWitnesses.map((witness) => projectWitness(witness, caseBinding.sourceInvariantSha256));
  if (caseId === "conflictFreePositive") {
    requireFact(witnesses.length === 0);
    return [];
  }
  const expectedWitnessCoordinates = conflictDays.flatMap((day) => STREAMS.map((stream) => `${day}/${stream}`));
  requireFact(same(witnesses.map((witness) => `${witness.day}/${witness.stream}`), expectedWitnessCoordinates));

  const bindingSha256 = jsonSha256(binding);
  const affectedDays = days.filter((day) => conflictDays.some((sourceDay) => {
    const fromDay = addDays(day, -100);
    return sourceDay >= fromDay && sourceDay <= day;
  }));
  return affectedDays.map((day) => {
    const fromDay = addDays(day, -100);
    const sourceWitnessSha256 = expectedWindowWitnesses(witnesses, fromDay, day, jsonSha256);
    requireFact(sourceWitnessSha256.length >= STREAMS.length);
    const sourceWindowSha256 = currentQ1D7SourceWindowSha256({ caseId, bindingSha256, owner: "a", day,
      fromDay, throughDay: day, sourceInvariantSha256: caseBinding.sourceInvariantSha256, sourceWitnessSha256 },
    { currentQ1D7JsonSha256: jsonSha256 });
    return { owner: "a", day, fromDay, throughDay: day, reason: "source_window_conflict",
      derivation: WINDOW_DERIVATION, sourceWindowSha256, sourceWitnessSha256 };
  });
}

function classificationForResult(result, day, current) {
  if (result.status === "not_testable") {
    requireFact(exactKeys(result, REFUSAL_RESULT_KEYS) && typeof result.reason === "string");
    return { classification: "refused", reason: result.reason };
  }
  requireFact(result.status === "ready" && exactKeys(result, READY_RESULT_KEYS)
    && typeof result.latestQuotaObservedAt === "string" && isObject(result.fit));
  const dayEndMs = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
  const recencyFloorMs = dayEndMs - current.COMMUNITY_ALLOWANCE_TRAILING_DAYS * DAY_MS;
  const latestMs = Date.parse(result.latestQuotaObservedAt);
  if (!Number.isFinite(latestMs) || latestMs <= recencyFloorMs || latestMs > dayEndMs) {
    return { classification: "stale", reason: null };
  }
  const knownPlan = current.ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.some((plan) => plan?.planType === result.planType);
  if (result.fit.status !== "fitted" || result.fit.capacityUsdByModel === null || !knownPlan) {
    return { classification: "unstable", reason: null };
  }
  requireFact(isObject(result.fit.capacityUsdByModel));
  return { classification: "fitted", reason: null };
}

function buildOwnerEvidence({ owners, days, ownerResults, conflictByCoordinate, windowByCoordinate, sha, current }) {
  const expectedResultCoordinates = owners.flatMap((owner) => days
    .filter((day) => !conflictByCoordinate.has(ownerDay(owner, day)))
    .map((day) => ownerDay(owner, day))).sort();
  requireFact(ownerResults instanceof Map && same([...ownerResults.keys()].sort(), expectedResultCoordinates));
  const evidence = [];
  for (const owner of owners) for (const day of days) {
    const coordinate = ownerDay(owner, day);
    const conflict = conflictByCoordinate.get(coordinate);
    if (conflict) {
      const window = windowByCoordinate.get(coordinate);
      requireFact(window);
      evidence.push({ owner, day, classification: "refused", resultSha256: null, reason: null,
        windowProofSha256: sha(window), conflictProofSha256: sha(conflict) });
      continue;
    }
    const result = ownerResults.get(coordinate);
    requireFact(isObject(result) && ["ready", "not_testable"].includes(result.status));
    const classification = classificationForResult(result, day, current);
    evidence.push({ owner, day, classification: classification.classification,
      resultSha256: sha(result), reason: classification.reason, windowProofSha256: null, conflictProofSha256: null });
  }
  return evidence;
}

function buildDays({ owners, days, ownerEvidence, ownerResults, conflictByCoordinate, current, sha }) {
  const projectedDays = [];
  for (const day of days) {
    const collection = { compositions: [], v1ParticipantCount: 0, unsupportedSourceParticipantCount: 0,
      refusedParticipantCount: 0 };
    for (const owner of owners) {
      const coordinate = ownerDay(owner, day);
      collection.v1ParticipantCount++;
      if (conflictByCoordinate.has(coordinate)) {
        collection.refusedParticipantCount++;
        continue;
      }
      const result = ownerResults.get(coordinate);
      requireFact(result);
      if (result.status === "not_testable") {
        collection.refusedParticipantCount++;
      } else {
        collection.compositions.push({ participantId: owner, composition: result });
      }
    }
    const raw = current.buildCommunityModelCompositionDay(collection, day);
    const projected = current.projectAdminModelHistoryDay(raw);
    requireFact(projected !== null && projected.day === day);
    const group = ownerEvidence.filter((entry) => entry.day === day);
    for (const [classification, key] of [["fitted", "fittedParticipantCount"], ["unstable", "unstableParticipantCount"],
      ["stale", "staleParticipantCount"], ["refused", "refusedParticipantCount"]]) {
      requireFact(projected[key] === group.filter((entry) => entry.classification === classification).length);
    }
    requireFact(projected.v1ParticipantCount === owners.length && projected.unsupportedSourceParticipantCount === 0);
    projectedDays.push(projected);
  }
  requireFact(projectedDays.every((value, index) => sha(value) === sha(current.projectAdminModelHistoryDay(value))));
  return projectedDays;
}

/**
 * Build one closed 280-row current D7 expectation.
 *
 * ownerResults is a Map keyed by `${owner}/${day}` containing the direct
 * current account-scoped historical model result. In the conflict-preserving
 * case, the four owner-a scopes proved by sourceConflictProofs are omitted;
 * all other 276 results are mandatory. The positive case requires all 280.
 * sourceWitnesses are current effective-reader outputs. sourceConflictProofs
 * must be outputs of the exact V2 conflict-proof helper and pass its validator.
 */
export function buildCurrentQ1D7PerDateExpectation(input) {
  requireFact(exactKeys(input, ["binding", "caseId", "current", "contract", "ownerResults", "sourceWitnesses",
    "sourceConflictProofs"]));
  const { binding, caseId, current, contract, ownerResults } = input;
  const { sha, days: graphDays, validateBinding, validateConflictProof, validateExpectation } = api(contract, current);
  requireFact(["conflictPreserving", "conflictFreePositive"].includes(caseId)
    && Array.isArray(input.sourceWitnesses) && Array.isArray(input.sourceConflictProofs));
  validateBinding(binding);
  const bindingSha256 = sha(binding);
  const caseBinding = binding.cases?.[caseId];
  const days = graphDays();
  requireFact(Array.isArray(days) && days.length === 70 && same(days, caseBinding?.modelDays)
    && caseBinding?.owners?.length === OWNERS.length && same(caseBinding.owners, OWNERS)
    && Array.isArray(caseBinding.conflictDays));

  const witnesses = input.sourceWitnesses.map((witness) => projectWitness(witness, caseBinding.sourceInvariantSha256));
  if (caseId === "conflictFreePositive") {
    requireFact(caseBinding.conflictDays.length === 0 && witnesses.length === 0 && input.sourceConflictProofs.length === 0);
  } else {
    const expectedWitnessCoordinates = caseBinding.conflictDays.flatMap((day) => STREAMS.map((stream) => `${day}/${stream}`));
    requireFact(same(witnesses.map((witness) => `${witness.day}/${witness.stream}`), expectedWitnessCoordinates));
  }

  const windows = buildCurrentQ1D7WindowProofs({ binding, caseId, sourceWitnesses: witnesses });
  requireFact(same(bindingSha256, jsonSha256(binding)));
  const expectedConflictDays = windows.map((window) => window.day);
  const proofs = [...input.sourceConflictProofs];
  const conflictValidation = { sourceWitnesses: witnesses, windowProofs: windows };
  for (const proof of proofs) validateConflictProof(proof, binding, conflictValidation);
  requireFact(same(proofs.map((proof) => `${proof.scope.owner}/${proof.scope.day}`),
    expectedConflictDays.map((day) => `a/${day}`)));

  const conflictByCoordinate = new Map(proofs.map((proof) => [ownerDay(proof.scope.owner, proof.scope.day), proof]));
  const windowByCoordinate = new Map(windows.map((window) => [ownerDay(window.owner, window.day), window]));
  const ownerEvidence = buildOwnerEvidence({ owners: OWNERS, days, ownerResults,
    conflictByCoordinate, windowByCoordinate, sha, current });
  const projectedDays = buildDays({ owners: OWNERS, days, ownerEvidence, ownerResults,
    conflictByCoordinate, current, sha });
  const expectation = {
    schemaVersion: SCHEMA_VERSION,
    caseId,
    bindingSha256,
    derivation: DERIVATION,
    producedBeforeCandidate: true,
    candidateInputs: false,
    ownerEvidenceSha256: sha(ownerEvidence),
    days: projectedDays,
    ownerEvidence,
    sourceWitnesses: witnesses,
    windowProofs: windows,
    sourceConflictProofs: proofs,
    unresolved: [],
  };
  const finalConflictValidation = { sourceWitnesses: expectation.sourceWitnesses, windowProofs: expectation.windowProofs };
  for (const proof of expectation.sourceConflictProofs) validateConflictProof(proof, binding, finalConflictValidation);
  validateExpectation(expectation, binding, { expectedSha256: sha(expectation) });
  BUILT_EXPECTATION_SHA256.set(expectation, sha(expectation));
  return expectation;
}

const CURRENT_PUBLIC_EXPECTATION_SCHEMA_VERSION = "current-q1-d7-current-public-expectation-v1";

function freezeTree(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Derive the public 69-day comparison envelope from a complete, independently
 * validated 70-day current per-date expectation. Public days must be exactly
 * the graph prefix before the pinned current day; values come from the
 * expectation rows that were already projected by the current model factory.
 */
export function buildCurrentQ1D7CurrentPublicExpectation(input) {
  requireFact(exactKeys(input, ["expectation", "binding", "contract"]));
  const { expectation, binding, contract } = input;
  requireFact(isObject(contract)
    && typeof contract.currentQ1D7JsonSha256 === "function"
    && typeof contract.currentQ1D7GraphDays === "function"
    && typeof contract.currentQ1D7PublicDays === "function"
    && typeof contract.validateCurrentQ1D7Binding === "function"
    && typeof contract.validateCurrentQ1D7PerDateExpectation === "function");
  contract.validateCurrentQ1D7Binding(binding);

  const sha = contract.currentQ1D7JsonSha256;
  const graphDays = contract.currentQ1D7GraphDays();
  const publicDays = contract.currentQ1D7PublicDays(binding);
  requireFact(Array.isArray(graphDays) && graphDays.length === 70 && graphDays.every(validDay)
    && Array.isArray(publicDays) && same(publicDays, graphDays.slice(0, -1)));

  requireFact(isObject(expectation));
  const builtExpectationSha256 = BUILT_EXPECTATION_SHA256.get(expectation);
  requireFact(hash(builtExpectationSha256) && builtExpectationSha256 === sha(expectation));
  contract.validateCurrentQ1D7PerDateExpectation(expectation, binding, { expectedSha256: builtExpectationSha256 });
  requireFact(isObject(expectation) && ["conflictPreserving", "conflictFreePositive"].includes(expectation.caseId)
    && expectation.bindingSha256 === sha(binding) && Array.isArray(expectation.days)
    && expectation.days.length === graphDays.length && same(expectation.days.map((row) => row.day), graphDays));

  const days = publicDays.map((day, index) => {
    const row = expectation.days[index];
    requireFact(isObject(row) && row.day === day && Array.isArray(row.values)
      && row.values.every((tuple) => Array.isArray(tuple) && tuple.length === 3));
    return { day, models: row.values.map((tuple) => [...tuple]) };
  });
  return freezeTree({ schemaVersion: CURRENT_PUBLIC_EXPECTATION_SCHEMA_VERSION,
    caseId: expectation.caseId, bindingSha256: expectation.bindingSha256, days });
}
