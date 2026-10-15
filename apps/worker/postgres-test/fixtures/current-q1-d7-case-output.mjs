/** Current-source D7 case outputs, kept separate from PostgreSQL transport.
 * Strict-export receipts hash only actual current D1 proof results. The PG
 * input descriptor binds private, owner-only SQLite snapshots and observed
 * source fences; it does not claim a database transfer or comparison. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { performance } from "node:perf_hooks";

import * as D1 from "./current-q1-d1-reference.mjs";
import * as D1Recompute from "./current-q1-d1-recompute.mjs";
import * as D7 from "./current-q1-d7-recompute.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import { buildCurrentQ1D7CurrentPublicExpectation } from "./current-q1-d7-expectation.mjs";
import { createSealedSqliteIngestionJournalSource } from "../../scripts/postgres-ingestion-journal-transfer.mjs";

const SOURCE_ID = "gcp-fastpath-oracle";
const CASE_IDS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const FILE_NAMES = Object.freeze({ ingestion: "ingestion.sqlite", journal: "journal.sqlite" });
const PRIVATE_VALIDATED_ORACLE = "privateValidatedOracle";
const SQLITE_OBJECTS = Object.freeze([
  "index:storage_ingestion_owner_cursor",
  "table:storage_ingestion_changes",
  "table:storage_source_state",
]);
const CURRENT_PUBLIC_SCHEMA = "current-q1-d7-current-public-expectation-v1";
const PUBLIC_RESPONSE_KEYS = Object.freeze(["schemaVersion", "from", "to", "allowanceState",
  "allowanceReadState", "allowanceBreakdowns", "cacheRetention", "days"]);
const PUBLIC_PROJECTION_KEYS = Object.freeze(["schemaVersion", "basis", "referencePlanType",
  "normalization", "modelBasis", "modelGate", "generatedAt", "days", "modelConfig"]);
const PUBLIC_DAY_KEYS = Object.freeze(["day", "combined", "byPlanType", "models"]);
const PUBLIC_SUMMARY_KEYS = Object.freeze(["centralUsd", "participantCount", "fitCount", "band80Usd"]);
const PUBLIC_PLANS = Object.freeze(["pro", "prolite", "promax", "plus"]);
const PUBLIC_BASE_AUTHORITY_KEYS = Object.freeze(["schemaVersion", "basis", "referencePlanType",
  "normalization", "modelBasis", "modelGate", "generatedAt", "days"]);
const PUBLIC_AUTHORITY_METADATA_FIELDS = Object.freeze(["basis", "normalization", "modelBasis", "modelGate"]);
const PUBLIC_PROJECTION_RECEIPT_SCHEMA = "current-q1-d7-public-projection-receipt-v1";
const PUBLIC_PROJECTION_RECEIPT_KEYS = Object.freeze(["schemaVersion", "caseId", "bindingSha256",
  "perDateExpectationSha256", "currentPublicExpectationSha256", "nativeEvidenceSha256",
  "conflictProofsSha256", "publicationSha256", "publicationInventorySha256",
  "publicAuthoritySha256", "withheldDays"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const PUBLIC_PROJECTION_RECEIPTS = new WeakSet();
const PUBLIC_PROJECTION_RECEIPT_DETAILS = new WeakMap();
const fail = (code = "CURRENT_Q1_D7_CASE_OUTPUT_INVALID") => {
  throw Object.assign(new Error(code), { code });
};
const requireFact = (condition, code) => { if (!condition) fail(code); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonSha256 = (value) => Contract.currentQ1D7JsonSha256(value);

export function currentQ1D7CaseOutputQueueReceiptSha256(proof) {
  requireFact(isObject(proof) && CASE_IDS.includes(proof.caseId) && SHA256.test(proof.bindingSha256)
    && isObject(proof.context) && Number.isSafeInteger(proof.queuedRows) && proof.queuedRows >= 0
    && Array.isArray(proof.orderedQueueDays)
    && proof.orderedQueueDays.every((day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day)),
  "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  return jsonSha256({ caseId: proof.caseId, bindingSha256: proof.bindingSha256,
    context: proof.context, queuedRows: proof.queuedRows, orderedQueueDays: proof.orderedQueueDays });
}

function checkDeadline(deadlineMonotonicMs) {
  requireFact(Number.isFinite(deadlineMonotonicMs) && performance.now() < deadlineMonotonicMs,
    "CURRENT_Q1_D7_DEADLINE");
}

function checkProgress(progress) {
  requireFact(isObject(progress) && typeof progress.phase === "function"
    && typeof progress.counts === "function", "CURRENT_Q1_D7_PROGRESS_INVALID");
}

function assertHash(value) { requireFact(typeof value === "string" && SHA256.test(value)); }

function exactKeysInOrder(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function deeplyFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((nested) => deeplyFrozen(nested, seen));
}

function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) === value;
}

function assertCurrentPublicExpectation(expectation, binding, metadata) {
  requireFact(exactKeysInOrder(expectation, ["schemaVersion", "caseId", "bindingSha256", "days"])
    && expectation.schemaVersion === CURRENT_PUBLIC_SCHEMA
    && ["conflictPreserving", "conflictFreePositive"].includes(expectation.caseId)
    && isObject(binding) && deeplyFrozen(expectation) && expectation.bindingSha256 === jsonSha256(binding)
    && Array.isArray(expectation.days), "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  requireFact(typeof Contract.currentQ1D7GraphDays === "function"
    && typeof Contract.currentQ1D7PublicDays === "function", "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  const graphDays = Contract.currentQ1D7GraphDays();
  const publicDays = Contract.currentQ1D7PublicDays(binding);
  const bindingCase = binding.cases?.[expectation.caseId];
  const allDailyDays = D7.currentQ1D7Days();
  requireFact(Array.isArray(graphDays) && graphDays.length === 70 && graphDays.every(validDay)
    && Array.isArray(publicDays) && publicDays.length === 69
    && isDeepStrictEqual(publicDays, graphDays.slice(0, -1))
    && expectation.days.length === publicDays.length
    && isDeepStrictEqual(expectation.days.map((day) => day?.day), publicDays)
    && isObject(bindingCase) && Array.isArray(bindingCase.dailyDays)
    && isDeepStrictEqual(bindingCase.dailyDays, allDailyDays.filter((day) => !bindingCase.conflictDays.includes(day))),
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  requireFact(Array.isArray(metadata) && metadata.length === 7
    && metadata.every((entry, index) => exactKeysInOrder(entry, ["id", "label", "family", "order"])
      && typeof entry.id === "string" && entry.id.length > 0 && typeof entry.label === "string"
      && typeof entry.family === "string" && entry.order === index)
    && new Set(metadata.map((entry) => entry.id)).size === metadata.length,
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  const modelIds = new Set(metadata.map((entry) => entry.id));
  for (const day of expectation.days) {
    requireFact(exactKeysInOrder(day, ["day", "models"]) && validDay(day.day)
      && Array.isArray(day.models), "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
    const seen = new Set();
    for (const tuple of day.models) {
      requireFact(Array.isArray(tuple) && tuple.length === 3 && modelIds.has(tuple[0])
        && !seen.has(tuple[0]) && typeof tuple[1] === "number" && Number.isFinite(tuple[1])
        && tuple[1] > 0 && Number.isSafeInteger(tuple[2]) && tuple[2] > 0,
      "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
      seen.add(tuple[0]);
    }
  }
  return expectation;
}

function assertPublicAuthority(publicAllowanceAuthority, publicAllowanceEnvelope, metadata) {
  requireFact(typeof publicAllowanceAuthority === "function"
    && exactKeysInOrder(publicAllowanceEnvelope, PUBLIC_PROJECTION_KEYS),
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  let reduced;
  try { reduced = publicAllowanceAuthority(publicAllowanceEnvelope); }
  catch { fail("CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID"); }
  requireFact(exactKeysInOrder(reduced, ["base", "metadata"])
    && exactKeysInOrder(reduced.base, PUBLIC_BASE_AUTHORITY_KEYS)
    && Array.isArray(reduced.metadata)
    && isDeepStrictEqual(reduced.metadata, publicAllowanceEnvelope.modelConfig)
    && (metadata === undefined || isDeepStrictEqual(reduced.metadata, metadata))
    && isDeepStrictEqual({ ...reduced.base, modelConfig: reduced.metadata }, publicAllowanceEnvelope),
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  const authorityMetadata = { schemaVersion: reduced.base.schemaVersion,
    referencePlanType: reduced.base.referencePlanType,
    ...Object.fromEntries(PUBLIC_AUTHORITY_METADATA_FIELDS.map((field) => [field, reduced.base[field]])),
    modelConfig: reduced.metadata };
  return jsonSha256(authorityMetadata);
}

function conflictDerivedWithheldDays(perDateExpectation) {
  const days = [...new Set(perDateExpectation.ownerEvidence
    .filter((entry) => entry.conflictProofSha256 !== null)
    .map((entry) => entry.day))].sort();
  return days;
}

function currentNativeEvidenceByCoordinate(nativeEvidence, conflictProofs, perDateExpectation, binding) {
  const graphDays = Contract.currentQ1D7GraphDays();
  const owners = D7.CURRENT_Q1_D7_OWNER_KEYS;
  requireFact(Array.isArray(nativeEvidence) && nativeEvidence.length === owners.length * graphDays.length
    && Array.isArray(conflictProofs)
    && isDeepStrictEqual(conflictProofs, perDateExpectation.sourceConflictProofs),
  "CURRENT_Q1_D7_PUBLICATION_INVALID");
  for (const proof of conflictProofs) {
    try {
      Contract.validateCurrentQ1D7SourceConflictProof(proof, binding,
        { sourceWitnesses: perDateExpectation.sourceWitnesses, windowProofs: perDateExpectation.windowProofs });
    } catch { fail("CURRENT_Q1_D7_PUBLICATION_INVALID"); }
  }
  const proofHashes = new Set(conflictProofs.map((proof) => jsonSha256(proof)));
  const evidenceByCoordinate = new Map(perDateExpectation.ownerEvidence.map((entry) =>
    [`${entry.owner}/${entry.day}`, entry]));
  const nativeByCoordinate = new Map();
  for (const row of nativeEvidence) {
    requireFact(exactKeysInOrder(row, ["owner", "metric", "day", "state", "invocations",
      "verifiedSha256", "reason", "proofSha256"])
      && owners.includes(row.owner) && row.metric === "model" && graphDays.includes(row.day)
      && Number.isSafeInteger(row.invocations) && row.invocations >= 1 && row.invocations <= 128,
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
    const coordinate = `${row.owner}/${row.day}`;
    requireFact(!nativeByCoordinate.has(coordinate), "CURRENT_Q1_D7_PUBLICATION_INVALID");
    const expected = evidenceByCoordinate.get(coordinate);
    requireFact(expected, "CURRENT_Q1_D7_PUBLICATION_INVALID");
    if (expected.conflictProofSha256 !== null) {
      requireFact(row.state === "expected_source_conflict" && row.verifiedSha256 === null
        && row.reason === null && row.proofSha256 === expected.conflictProofSha256
        && proofHashes.has(row.proofSha256), "CURRENT_Q1_D7_PUBLICATION_INVALID");
    } else {
      requireFact(row.verifiedSha256 === expected.resultSha256 && SHA256.test(row.verifiedSha256)
        && row.proofSha256 === null
        && (row.state === "complete" ? row.reason === null && expected.classification !== "refused"
          : row.state === "not_testable" && typeof row.reason === "string"
            && row.reason === expected.reason && expected.classification === "refused"),
      "CURRENT_Q1_D7_PUBLICATION_INVALID");
    }
    nativeByCoordinate.set(coordinate, row);
  }
  const expectedCoordinates = owners.flatMap((owner) => graphDays.map((day) => `${owner}/${day}`)).sort();
  requireFact(isDeepStrictEqual([...nativeByCoordinate.keys()].sort(), expectedCoordinates)
    && evidenceByCoordinate.size === expectedCoordinates.length,
  "CURRENT_Q1_D7_PUBLICATION_INVALID");
  return { nativeByCoordinate, proofHashes };
}

function normalizePublicationOutcome(day, outcome, withheldDaySet) {
  if (withheldDaySet.has(day)) {
    requireFact(exactKeysInOrder(outcome, ["state", "reason", "memberCount"])
      && outcome.state === "deferred" && outcome.reason === "cache_pending"
      && Number.isSafeInteger(outcome.memberCount) && outcome.memberCount >= 0 && outcome.memberCount <= 4,
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
    return { day, state: outcome.state, reason: outcome.reason, memberCount: outcome.memberCount };
  }
  requireFact(exactKeysInOrder(outcome, ["state", "memberCount"])
    && ["published", "unchanged"].includes(outcome.state)
    && Number.isSafeInteger(outcome.memberCount) && outcome.memberCount >= 0 && outcome.memberCount <= 4,
  "CURRENT_Q1_D7_PUBLICATION_INVALID");
  return { day, state: outcome.state, memberCount: outcome.memberCount };
}

/** Build a private, in-memory authorization receipt for the public model
 * projection. Withheld dates are derived from the sealed current expectation,
 * validated native conflict rows, publisher outcomes, and the exact inventory;
 * callers cannot authorize an empty model projection by supplying a date list. */
export function createCurrentQ1D7PublicProjectionReceipt({ binding, perDateExpectation,
  currentPublicExpectation, nativeEvidence, conflictProofs, publication, publicationInventory,
  publicAllowanceAuthority, publicAllowanceEnvelope } = {}) {
  requireFact(isObject(binding) && isObject(perDateExpectation)
    && exactKeysInOrder(publication, ["outcomes", "expectedMissing"])
    && publication.outcomes instanceof Map && Array.isArray(publication.expectedMissing)
    && Array.isArray(publicationInventory), "CURRENT_Q1_D7_PUBLICATION_INVALID");
  try {
    Contract.validateCurrentQ1D7Binding(binding);
    Contract.validateCurrentQ1D7PerDateExpectation(perDateExpectation, binding,
      { expectedSha256: jsonSha256(perDateExpectation) });
  } catch { fail("CURRENT_Q1_D7_PUBLICATION_INVALID"); }
  let expectedPublic;
  try {
    expectedPublic = buildCurrentQ1D7CurrentPublicExpectation({ expectation: perDateExpectation,
      binding, contract: Contract });
  } catch { fail("CURRENT_Q1_D7_PUBLICATION_INVALID"); }
  requireFact(isDeepStrictEqual(currentPublicExpectation, expectedPublic)
    && deeplyFrozen(currentPublicExpectation)
    && currentPublicExpectation.caseId === perDateExpectation.caseId
    && currentPublicExpectation.bindingSha256 === jsonSha256(binding),
  "CURRENT_Q1_D7_PUBLICATION_INVALID");

  const graphDays = Contract.currentQ1D7GraphDays();
  const withheldDays = conflictDerivedWithheldDays(perDateExpectation);
  const withheldDaySet = new Set(withheldDays);
  const native = currentNativeEvidenceByCoordinate(nativeEvidence, conflictProofs, perDateExpectation, binding);
  requireFact(isDeepStrictEqual(publication.expectedMissing, withheldDays)
    && publication.outcomes.size === graphDays.length
    && isDeepStrictEqual([...publication.outcomes.keys()], graphDays)
    && publicationInventory.length === graphDays.length
    && isDeepStrictEqual(publicationInventory.map((entry) => entry?.day), graphDays),
  "CURRENT_Q1_D7_PUBLICATION_INVALID");

  const publicationRows = graphDays.map((day, index) => {
    const outcome = normalizePublicationOutcome(day, publication.outcomes.get(day), withheldDaySet);
    const inventory = publicationInventory[index];
    const expectedProjection = perDateExpectation.days[index];
    requireFact(expectedProjection?.day === day
      && exactKeysInOrder(inventory, ["day", "state", "sha256"])
      && inventory.day === day
      && (withheldDaySet.has(day)
        ? inventory.state === "withheld" && inventory.sha256 === null
        : inventory.state === "published" && inventory.sha256 === jsonSha256(expectedProjection)),
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
    return { outcome, inventory: { ...inventory } };
  });
  requireFact(isDeepStrictEqual(publicationInventory.filter((entry) => entry.state === "withheld")
    .map((entry) => entry.day), withheldDays)
    && (perDateExpectation.caseId !== "conflictFreePositive" || withheldDays.length === 0),
  "CURRENT_Q1_D7_PUBLICATION_INVALID");

  const publicAuthoritySha256 = assertPublicAuthority(publicAllowanceAuthority, publicAllowanceEnvelope);
  const normalizedPublication = { expectedMissing: [...publication.expectedMissing],
    outcomes: publicationRows.map((row) => row.outcome) };
  const receipt = Object.freeze({ schemaVersion: PUBLIC_PROJECTION_RECEIPT_SCHEMA,
    caseId: perDateExpectation.caseId, bindingSha256: jsonSha256(binding),
    perDateExpectationSha256: jsonSha256(perDateExpectation),
    currentPublicExpectationSha256: jsonSha256(currentPublicExpectation),
    nativeEvidenceSha256: jsonSha256(nativeEvidence), conflictProofsSha256: jsonSha256(conflictProofs),
    publicationSha256: jsonSha256(normalizedPublication),
    publicationInventorySha256: jsonSha256(publicationRows.map((row) => row.inventory)),
    publicAuthoritySha256: publicAuthoritySha256, withheldDays: Object.freeze([...withheldDays]) });
  requireFact(exactKeysInOrder(receipt, PUBLIC_PROJECTION_RECEIPT_KEYS), "CURRENT_Q1_D7_PUBLICATION_INVALID");
  PUBLIC_PROJECTION_RECEIPTS.add(receipt);
  PUBLIC_PROJECTION_RECEIPT_DETAILS.set(receipt, Object.freeze({ binding, perDateExpectation,
    currentPublicExpectation, withheldDays: new Set(withheldDays), publicAuthoritySha256 }));
  return receipt;
}

function validPublicSummary(value) {
  return exactKeysInOrder(value, PUBLIC_SUMMARY_KEYS)
    && (value.centralUsd === null || (typeof value.centralUsd === "number"
      && Number.isFinite(value.centralUsd) && value.centralUsd >= 0))
    && Number.isSafeInteger(value.participantCount) && value.participantCount >= 0
    && Number.isSafeInteger(value.fitCount) && value.fitCount >= 0
    && value.fitCount <= value.participantCount
    && (value.band80Usd === null || (exactKeysInOrder(value.band80Usd, ["lowerUsd", "upperUsd"])
      && Number.isFinite(value.band80Usd.lowerUsd) && value.band80Usd.lowerUsd >= 0
      && Number.isFinite(value.band80Usd.upperUsd) && value.band80Usd.upperUsd >= value.band80Usd.lowerUsd));
}

/** Validate the actual current HTTP DTO against the independent public-day
 * expectation. The endpoint's current projector builds allowanceBreakdowns;
 * this seam proves its exact 69-day order and per-day model tuples. */
export function validateCurrentQ1D7CurrentPublicResponse({ responseBody, expectation, binding,
  expectedDailyDays, dailyWindow, metadata, nowMs, publicationReceipt,
  publicAllowanceAuthority } = {}) {
  assertCurrentPublicExpectation(expectation, binding, metadata);
  const { allowanceBreakdowns } = responseBody ?? {};
  const allDailyDays = D7.currentQ1D7Days();
  const bindingCase = binding?.cases?.[expectation?.caseId];
  const receiptDetails = PUBLIC_PROJECTION_RECEIPT_DETAILS.get(publicationReceipt);
  requireFact(PUBLIC_PROJECTION_RECEIPTS.has(publicationReceipt)
    && exactKeysInOrder(publicationReceipt, PUBLIC_PROJECTION_RECEIPT_KEYS)
    && publicationReceipt.schemaVersion === PUBLIC_PROJECTION_RECEIPT_SCHEMA
    && publicationReceipt.caseId === expectation.caseId
    && publicationReceipt.bindingSha256 === jsonSha256(binding)
    && publicationReceipt.currentPublicExpectationSha256 === jsonSha256(expectation)
    && receiptDetails?.binding === binding && receiptDetails.currentPublicExpectation === expectation,
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  let expectedPublic;
  try {
    expectedPublic = buildCurrentQ1D7CurrentPublicExpectation({
      expectation: receiptDetails.perDateExpectation, binding, contract: Contract });
  } catch { fail("CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID"); }
  requireFact(isDeepStrictEqual(expectedPublic, expectation)
    && publicationReceipt.perDateExpectationSha256 === jsonSha256(receiptDetails.perDateExpectation),
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  const publicAuthoritySha256 = assertPublicAuthority(publicAllowanceAuthority, allowanceBreakdowns, metadata);
  requireFact(publicAuthoritySha256 === receiptDetails.publicAuthoritySha256
    && publicationReceipt.publicAuthoritySha256 === publicAuthoritySha256,
  "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  requireFact(Number.isSafeInteger(nowMs) && nowMs > 0
    && exactKeysInOrder(responseBody, PUBLIC_RESPONSE_KEYS)
    && responseBody.schemaVersion === "community-daily-read-v1.0"
    && isObject(dailyWindow) && exactKeysInOrder(dailyWindow, ["fromDay", "throughDay"])
    && dailyWindow.fromDay === allDailyDays[0] && dailyWindow.throughDay === allDailyDays.at(-1)
    && responseBody.from === dailyWindow.fromDay && responseBody.to === dailyWindow.throughDay
    && responseBody.allowanceState === "ready" && responseBody.allowanceReadState === "confirmed"
    && Array.isArray(expectedDailyDays) && isObject(bindingCase)
    && isDeepStrictEqual(expectedDailyDays, bindingCase.dailyDays)
    && expectedDailyDays.every(validDay)
    && Array.isArray(responseBody.days)
    && isDeepStrictEqual(responseBody.days.map((day) => day?.day), expectedDailyDays)
    && isObject(responseBody.cacheRetention)
    && exactKeysInOrder(allowanceBreakdowns, PUBLIC_PROJECTION_KEYS)
    && allowanceBreakdowns.schemaVersion === "community-allowance-breakdowns-v1.5"
    && typeof allowanceBreakdowns.basis === "string" && allowanceBreakdowns.basis.length > 0
    && allowanceBreakdowns.referencePlanType === "pro"
    && typeof allowanceBreakdowns.normalization === "string" && allowanceBreakdowns.normalization.length > 0
    && typeof allowanceBreakdowns.modelBasis === "string" && allowanceBreakdowns.modelBasis.length > 0
    && typeof allowanceBreakdowns.modelGate === "string" && allowanceBreakdowns.modelGate.length > 0
    && allowanceBreakdowns.generatedAt === new Date(nowMs).toISOString()
    && isDeepStrictEqual(allowanceBreakdowns.modelConfig, metadata)
    && Array.isArray(allowanceBreakdowns.days)
    && allowanceBreakdowns.days.length === expectation.days.length
    && isDeepStrictEqual(allowanceBreakdowns.days.map((day) => day?.day),
      expectation.days.map((day) => day.day)), "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  for (let index = 0; index < allowanceBreakdowns.days.length; index += 1) {
    const day = allowanceBreakdowns.days[index]; const expected = expectation.days[index];
    const publicationWithheld = receiptDetails.withheldDays.has(day?.day);
    requireFact(exactKeysInOrder(day, PUBLIC_DAY_KEYS) && day.day === expected.day
      && validPublicSummary(day.combined)
      && exactKeysInOrder(day.byPlanType, PUBLIC_PLANS)
      && PUBLIC_PLANS.every((plan) => validPublicSummary(day.byPlanType[plan]))
      && Array.isArray(day.models)
      && (publicationWithheld ? day.models.length === 0 : isDeepStrictEqual(day.models, expected.models)),
    "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  }
  return responseBody;
}

function retainPrivateValidatedOracle(ctx, oracle) {
  requireFact(isObject(ctx) && isObject(oracle)
    && !Object.prototype.hasOwnProperty.call(ctx, PRIVATE_VALIDATED_ORACLE),
  "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  Object.defineProperty(ctx, PRIVATE_VALIDATED_ORACLE, { value: oracle, writable: true,
    enumerable: false, configurable: true });
}

/** Drop the full positive oracle retained privately for in-memory producer use.
 * The summarized strict-export proof is the only oracle data returned. */
export function clearCurrentQ1D7PrivateValidatedOracle(ctx) {
  requireFact(isObject(ctx), "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(ctx, PRIVATE_VALIDATED_ORACLE);
  if (descriptor === undefined) return false;
  requireFact(descriptor.enumerable === false && descriptor.configurable === true
    && descriptor.writable === true && isObject(descriptor.value), "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  delete ctx[PRIVATE_VALIDATED_ORACLE];
  return true;
}

function typedSqliteValue(value) {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return ["number", value];
  if (ArrayBuffer.isView(value)) return ["blob", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")];
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return ["blob", Buffer.from(value).toString("hex")];
  }
  fail("CURRENT_Q1_D7_PG_INPUT_INVALID");
}

function sqliteQuote(name) {
  requireFact(typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name),
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
  return `"${name}"`;
}

async function assertOwnerDirectory(path, { root } = {}) {
  requireFact(typeof path === "string" && isAbsolute(path) && normalize(path) === path
    && await realpath(path) === path, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  const stat = await lstat(path);
  requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o077) === 0, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  if (root !== undefined) {
    const rel = relative(root, path);
    requireFact(rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(rel), "CURRENT_Q1_D7_PG_INPUT_INVALID");
  }
  return stat;
}

async function assertNoSqliteSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await lstat(path + suffix); fail("CURRENT_Q1_D7_PG_INPUT_INVALID"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function assertPrivateFile(path, { readOnly = false, directory } = {}) {
  requireFact(isAbsolute(path) && normalize(path) === path && dirname(path) === directory
    && await realpath(path) === path, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  const stat = await lstat(path);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && stat.nlink === 1 && stat.size > 0 && (!readOnly || (stat.mode & 0o222) === 0),
  "CURRENT_Q1_D7_PG_INPUT_INVALID");
  return stat;
}

async function removeOwnedSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await removeOwned(path + suffix, await lstatIfPresent(path + suffix));
  }
}

async function lstatIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function fileSha256(path, deadlineMonotonicMs) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    checkDeadline(deadlineMonotonicMs); hash.update(chunk); bytes += chunk.byteLength;
  }
  requireFact(bytes > 0, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  return { sha256: hash.digest("hex"), bytes };
}

async function copySealedSnapshot(sourcePath, destinationPath, expectedSourceStat, created, deadlineMonotonicMs) {
  requireFact(Number.isInteger(fsConstants.O_NOFOLLOW), "CURRENT_Q1_D7_PG_INPUT_INVALID");
  const source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destination;
  try {
    const openedSource = await source.stat();
    requireFact(openedSource.isFile() && openedSource.dev === expectedSourceStat.dev
      && openedSource.ino === expectedSourceStat.ino && openedSource.size === expectedSourceStat.size,
    "CURRENT_Q1_D7_SOURCE_CHANGED");
    destination = await open(destinationPath, "wx", 0o600);
    created.set(destinationPath, await destination.stat());
    const deadlineCheck = new Transform({ transform(chunk, encoding, callback) {
      try { checkDeadline(deadlineMonotonicMs); callback(null, chunk); }
      catch (error) { callback(error); }
    } });
    await pipeline(source.createReadStream({ autoClose: false }), deadlineCheck,
      destination.createWriteStream({ autoClose: false }));
    await destination.sync();
    const finalSource = await source.stat();
    requireFact(finalSource.isFile() && finalSource.dev === expectedSourceStat.dev
      && finalSource.ino === expectedSourceStat.ino && finalSource.size === expectedSourceStat.size,
    "CURRENT_Q1_D7_SOURCE_CHANGED");
  } finally {
    try { if (destination) await destination.close(); } finally { await source.close(); }
  }
}

async function assertMissingFile(path) {
  try { await lstat(path); fail("CURRENT_Q1_D7_PG_INPUT_INVALID"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function equalRowsHash(columns, hash, rows) {
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((column) => typedSqliteValue(row[column])))).update("\n");
  }
}

function checkQuick(database) {
  const rows = database.prepare("PRAGMA quick_check").all();
  requireFact(rows.length === 1 && Object.values(rows[0])[0] === "ok",
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
}

/** Recreate only the two current ingestion journal tables and their one
 * canonical index, using DDL and ordered rows read from the sealed input. */
async function buildJournalSnapshot(ingestionPath, journalPath, directory, deadlineMonotonicMs, progress) {
  const source = new DatabaseSync(ingestionPath, { readOnly: true, allowExtension: false });
  const target = new DatabaseSync(journalPath, { allowExtension: false });
  try {
    source.exec("PRAGMA query_only=ON; BEGIN");
    const journalMode = target.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
    requireFact(journalMode === "delete", "CURRENT_Q1_D7_PG_INPUT_INVALID");
    target.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    const schemaRows = source.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name IN('storage_source_state','storage_ingestion_changes','storage_ingestion_owner_cursor')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`).all();
    requireFact(schemaRows.length === SQLITE_OBJECTS.length
      && schemaRows.map((row) => `${row.type}:${row.name}`).sort().join("\n") === SQLITE_OBJECTS.join("\n")
      && schemaRows.every((row) => typeof row.sql === "string" && row.sql.length > 0),
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
    requireFact(schemaRows.find((row) => row.name === "storage_ingestion_owner_cursor")?.tbl_name
      === "storage_ingestion_changes", "CURRENT_Q1_D7_PG_INPUT_INVALID");

    target.exec("BEGIN IMMEDIATE");
    try {
      for (const row of schemaRows.filter((item) => item.type === "table")) target.exec(row.sql);
      const copiedRows = {};
      for (const table of ["storage_source_state", "storage_ingestion_changes"]) {
        checkDeadline(deadlineMonotonicMs);
        const columnInfo = source.prepare(`PRAGMA table_info(${sqliteQuote(table)})`).all();
        const columns = columnInfo.map((row) => row.name);
        const keys = columnInfo.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
        requireFact(columns.length > 0 && columns.length <= 64 && keys.length > 0,
          "CURRENT_Q1_D7_PG_INPUT_INVALID");
        const columnSql = columns.map(sqliteQuote).join(",");
        const insert = target.prepare(`INSERT INTO ${sqliteQuote(table)}(${columnSql}) VALUES(${columns.map(() => "?").join(",")})`);
        const sourceStatement = source.prepare(`SELECT ${columnSql} FROM ${sqliteQuote(table)}
          ORDER BY ${keys.map(sqliteQuote).join(",")} LIMIT 500 OFFSET ?`);
        sourceStatement.setReadBigInts(true);
        const sourceHash = createHash("sha256"); let rowCount = 0, pageCount = 0;
        for (let offset = 0; ; offset += 500) {
          checkDeadline(deadlineMonotonicMs); pageCount++;
          progress.counts({ completedSteps: pageCount });
          const page = sourceStatement.all(offset);
          requireFact(page.length <= 500, "CURRENT_Q1_D7_PG_INPUT_INVALID");
          equalRowsHash(columns, sourceHash, page);
          for (const row of page) insert.run(...columns.map((column) => row[column]));
          rowCount += page.length;
          requireFact(rowCount <= 1_000_000, "CURRENT_Q1_D7_PG_INPUT_INVALID");
          if (page.length < 500) break;
        }
        const targetStatement = target.prepare(`SELECT ${columnSql} FROM ${sqliteQuote(table)}
          ORDER BY ${keys.map(sqliteQuote).join(",")} LIMIT 500 OFFSET ?`);
        targetStatement.setReadBigInts(true);
        const targetHash = createHash("sha256"); let targetRowCount = 0;
        for (let offset = 0; ; offset += 500) {
          checkDeadline(deadlineMonotonicMs);
          const targetRows = targetStatement.all(offset);
          requireFact(targetRows.length <= 500, "CURRENT_Q1_D7_PG_INPUT_INVALID");
          equalRowsHash(columns, targetHash, targetRows); targetRowCount += targetRows.length;
          if (targetRows.length < 500) break;
        }
        requireFact(targetRowCount === rowCount && targetHash.digest("hex") === sourceHash.digest("hex"),
          "CURRENT_Q1_D7_PG_INPUT_INVALID");
        copiedRows[table] = rowCount;
      }
      for (const row of schemaRows.filter((item) => item.type === "index")) target.exec(row.sql);
      const targetSchema = target.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
        WHERE name IN('storage_source_state','storage_ingestion_changes','storage_ingestion_owner_cursor')
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`).all();
      requireFact(targetSchema.length === schemaRows.length
        && targetSchema.every((row, index) => row.type === schemaRows[index].type
          && row.name === schemaRows[index].name && row.tbl_name === schemaRows[index].tbl_name
          && row.sql === schemaRows[index].sql), "CURRENT_Q1_D7_PG_INPUT_INVALID");
      checkQuick(target);
      target.exec("COMMIT");
      target.exec("VACUUM");
      checkQuick(target);
      requireFact(copiedRows.storage_source_state >= 1, "CURRENT_Q1_D7_PG_INPUT_INVALID");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    try { source.exec("ROLLBACK"); } catch { /* read transaction ends on close */ }
    try { source.close(); } finally { target.close(); }
  }
  await chmod(journalPath, 0o444);
  await assertNoSqliteSidecars(journalPath);
  const stat = await assertPrivateFile(journalPath, { readOnly: true, directory });
  const digest = await fileSha256(journalPath, deadlineMonotonicMs);
  requireFact(stat.size === digest.bytes, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  const sealed = await createSealedSqliteIngestionJournalSource({ path: journalPath,
    expectedSha256: digest.sha256, expectedSourceId: SOURCE_ID });
  try {
    const verified = await sealed.verifySnapshot();
    requireFact(verified.artifactSha256 === digest.sha256 && verified.sourceId === SOURCE_ID,
      "CURRENT_Q1_D7_PG_INPUT_INVALID");
    await sealed.verifyUnchanged();
  } finally { sealed.close(); }
  return digest;
}

function freezeFile(file) { return Object.freeze({ ...file }); }

function freezePgInputDescriptor(descriptor) {
  Object.freeze(descriptor.ingestion); Object.freeze(descriptor.journal);
  return Object.freeze(descriptor);
}

function assertCurrentCaseInput({ ctx, input, bindingCase, sourceInvariantSha256 }) {
  const caseId = bindingCase?.caseId;
  requireFact(CASE_IDS.includes(caseId) && input?.caseKey === caseId
    && input?.physicalId === bindingCase.corpusCaseId
    && input?.corpusSha256 === bindingCase.corpusSha256
    && input?.admissionSha256 === bindingCase.admissionSha256,
  "CURRENT_Q1_D7_CASE_BINDING_INVALID");
  requireFact(isObject(ctx?.binding) && ctx.binding.cases?.[caseId]
    && isDeepStrictEqual(bindingCase, ctx.binding.cases[caseId]), "CURRENT_Q1_D7_CASE_BINDING_INVALID");
  Contract.validateCurrentQ1D7Binding(ctx.binding);
  assertHash(sourceInvariantSha256);
  requireFact(bindingCase.sourceInvariantSha256 === sourceInvariantSha256
    && ctx?.binding?.cases?.[caseId]?.sourceInvariantSha256 === sourceInvariantSha256,
  "CURRENT_Q1_D7_CASE_BINDING_INVALID");
  requireFact(ctx?.binding?.source?.sha256 && SHA256.test(ctx.binding.source.sha256)
    && ctx.binding.source === ctx.source, "CURRENT_Q1_D7_SOURCE_BINDING_INVALID");
  requireFact(ctx.sourceId === SOURCE_ID && ctx.sourceNamespace === SOURCE_ID
    && ctx.binding.sourceId === ctx.sourceId && ctx.binding.sourceNamespace === ctx.sourceNamespace,
  "CURRENT_Q1_D7_SOURCE_BINDING_INVALID");
  requireFact(isObject(ctx.P) && ctx.ingestion && ctx.analytics && ctx.ledger && isObject(ctx.paths)
    && typeof ctx.paths.ingestion === "string" && Number.isSafeInteger(ctx.nowMs) && ctx.nowMs > 0
    && !Object.prototype.hasOwnProperty.call(ctx, PRIVATE_VALIDATED_ORACLE),
  "CURRENT_Q1_D7_CASE_BINDING_INVALID");
  return caseId;
}

async function captureSelectionAndFence({ ctx, progress, deadlineMonotonicMs }) {
  checkDeadline(deadlineMonotonicMs); progress.phase("oracle");
  const bindings = D1.currentQ1DatabaseBindings(ctx);
  const authority = await ctx.P.captureStorageCommunityAuthority(ctx.ingestion, bindings);
  const journalMax = await ctx.ingestion.prepare(
    "SELECT COALESCE(MAX(sequence),0) AS n FROM storage_ingestion_changes").first("n");
  const cursorSequence = await ctx.analytics.prepare(
    "SELECT sequence FROM analytics_source_cursors WHERE source_id=?").bind(ctx.sourceId).first("sequence");
  const delivery = await ctx.P.advanceStorageAnalytics(bindings);
  requireFact(delivery?.state === "idle" && delivery.sequence === journalMax
    && cursorSequence === journalMax && authority?.sequence === journalMax,
  "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const selection = await ctx.P.readD1AnalyticsImportSelection({ ...bindings, pinnedNowMs: ctx.nowMs });
  const sourceTerminalEpoch = await ctx.P.readStorageCommunitySourceTerminalEpoch(ctx.ingestion);
  const deliveredTerminalEpoch = await ctx.P.readStorageCommunityDeliveredTerminalEpoch(ctx.analytics, ctx.sourceId);
  const pendingErasureJobs = await ctx.ledger.prepare(
    "SELECT count(*) AS n FROM storage_erasure_jobs WHERE state='pending'").first("n");
  requireFact(Number.isSafeInteger(journalMax) && journalMax > 0 && Number.isSafeInteger(cursorSequence)
    && Number.isSafeInteger(sourceTerminalEpoch) && Number.isSafeInteger(deliveredTerminalEpoch)
    && deliveredTerminalEpoch >= sourceTerminalEpoch && Number.isSafeInteger(pendingErasureJobs)
    && pendingErasureJobs === 0 && isObject(selection), "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const closedAuthority = Object.freeze({ sourceId: authority.sourceId,
    sourceNamespace: authority.sourceNamespace, publicAuthorityEpoch: authority.publicAuthorityEpoch,
    policyRevision: authority.policyRevision, collectionRevision: authority.collectionRevision,
    graphInvalidationEpoch: authority.graphInvalidationEpoch, sourceEpoch: authority.sourceEpoch,
    sequence: authority.sequence });
  requireFact(closedAuthority.sourceId === ctx.sourceId
    && closedAuthority.sourceNamespace === ctx.sourceNamespace
    && [closedAuthority.publicAuthorityEpoch, closedAuthority.policyRevision, closedAuthority.collectionRevision,
      closedAuthority.graphInvalidationEpoch, closedAuthority.sourceEpoch, closedAuthority.sequence]
      .every((value) => Number.isSafeInteger(value) && value >= 0), "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  return Object.freeze({
    selection,
    fence: Object.freeze({ authority: closedAuthority, journalMax, cursorSequence, sourceTerminalEpoch,
      deliveredTerminalEpoch, pendingErasureJobs }),
  });
}

export async function captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase } = {}) {
  requireFact(isObject(input) && isObject(input.corpus) && CASE_IDS.includes(bindingCase?.caseId)
    && input.caseKey === bindingCase.caseId && input.physicalId === bindingCase.corpusCaseId
    && input.corpusSha256 === bindingCase.corpusSha256
    && input.admissionSha256 === bindingCase.admissionSha256
    && Array.isArray(input.corpus.owners) && input.corpus.owners.length === 4
    && Array.isArray(bindingCase.owners), "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const expectedOwners = input.corpus.owners.map((owner) => ({
    key: owner?.key, participantId: owner?.participantId, ownerDigest: owner?.pinnedOwnerDigest,
  }));
  requireFact(expectedOwners.every((owner) => typeof owner.key === "string"
    && typeof owner.participantId === "string" && SHA256.test(owner.ownerDigest))
    && new Set(expectedOwners.map((owner) => owner.key)).size === 4
    && new Set(expectedOwners.map((owner) => owner.participantId)).size === 4
    && new Set(expectedOwners.map((owner) => owner.ownerDigest)).size === 4
    && isDeepStrictEqual(expectedOwners.map((owner) => owner.key).sort(), [...bindingCase.owners].sort()),
  "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  requireFact(typeof ctx.P.readD1AnalyticsLiveCohort === "function"
    && typeof ctx.P.readStorageCommunityOwnerPage === "function", "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const cohort = await ctx.P.readD1AnalyticsLiveCohort(ctx.ingestion);
  const rows = await ctx.P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 });
  requireFact(isObject(cohort) && Number.isSafeInteger(cohort.members) && cohort.members === 4
    && SHA256.test(cohort.sha256) && Array.isArray(rows) && rows.length === 4,
  "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const owners = rows.map(({ participantId, ownerDigest }) => ({ participantId, ownerDigest }))
    .sort((left, right) => left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0);
  requireFact(owners.every((owner) => typeof owner.participantId === "string"
    && SHA256.test(owner.ownerDigest))
    && isDeepStrictEqual(owners, expectedOwners.map(({ participantId, ownerDigest }) => ({ participantId, ownerDigest }))
      .sort((left, right) => left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0)),
  "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  return Object.freeze({ members: cohort.members, sha256: cohort.sha256 });
}

async function captureQueueProjection(ctx, bindingCase) {
  const response = await ctx.analytics.prepare(`SELECT day,revision FROM analytics_community_daily_queue
    WHERE source_id=? ORDER BY day`).bind(ctx.sourceId).all();
  const rows = response?.results;
  requireFact(Array.isArray(rows) && rows.length <= 2
    && rows.every((row) => typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(row.day)
      && Number.isSafeInteger(row.revision) && row.revision > 0), "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  const orderedQueueDays = rows.map((row) => row.day);
  requireFact(new Set(orderedQueueDays).size === orderedQueueDays.length
    && isDeepStrictEqual(orderedQueueDays, bindingCase.conflictDays), "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  return Object.freeze({ queuedRows: rows.length, orderedQueueDays: Object.freeze(orderedQueueDays) });
}

function assertSuccessfulOracleMatchesFence(oracle, selection, fence, sourceDigest, sourceNamespace) {
  requireFact(isObject(oracle) && oracle.moduleDigest === sourceDigest
    && isDeepStrictEqual(oracle.fenceAuthority, fence.authority)
    && oracle.fenceCounters?.journal?.maxSequence === fence.journalMax
    && oracle.fenceCounters?.sourceTerminalEpoch === fence.sourceTerminalEpoch
    && oracle.fenceCounters?.deliveredTerminalEpoch === fence.deliveredTerminalEpoch
    && oracle.quiescence?.queueRows === 0 && oracle.quiescence?.cursorSequence === fence.cursorSequence
    && oracle.quiescence?.journalMax === fence.journalMax
    && oracle.quiescence?.pendingErasureJobs === fence.pendingErasureJobs
    && oracle.importSelection?.daily && oracle.importSelection?.modelDays
    && isDeepStrictEqual(oracle.importSelection, { daily: selection.daily,
      modelDays: selection.modelDays, preview: selection.preview })
    && fence.authority.sourceNamespace === sourceNamespace,
  "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
}

async function produceStrictExport({ ctx, caseId, moduleDigest, sourceInvariantSha256, progress,
  bindingCase, selection, fence, cohort, queueProjection, deadlineMonotonicMs }) {
  checkDeadline(deadlineMonotonicMs); progress.phase("oracle");
  const bindingSha256 = jsonSha256(ctx.binding);
  const sourceModule = ctx.binding.source.files.find((file) =>
    file.path === "apps/worker/src/d1-analytics-export-oracle.ts");
  requireFact(sourceModule && SHA256.test(sourceModule.sha256), "CURRENT_Q1_D7_SOURCE_BINDING_INVALID");
  const context = Object.freeze({ sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace,
    pinnedNowMs: ctx.nowMs, sourceInvariantSha256, sourceModuleSha256: sourceModule.sha256,
    cohortMembers: cohort.members, cohortSha256: cohort.sha256,
    fenceSha256: jsonSha256(fence), selectionSha256: jsonSha256(selection) });
  const queueReceiptBase = { caseId, bindingSha256, context,
    queuedRows: queueProjection.queuedRows, orderedQueueDays: queueProjection.orderedQueueDays };
  const queueReceiptSha256 = currentQ1D7CaseOutputQueueReceiptSha256(queueReceiptBase);
  if (caseId === "conflictPreserving") {
    requireFact(typeof D1.proveCurrentQ1ExportConflictRefusal === "function",
      "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
    const refusal = await D1.proveCurrentQ1ExportConflictRefusal(ctx, moduleDigest);
    D1Recompute.validateCurrentQ1StrictExportRefusal(refusal);
    requireFact(refusal.actual === true && refusal.queueRows === queueProjection.queuedRows
      && refusal.queueRows === 2,
      "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
    checkDeadline(deadlineMonotonicMs);
    const proof = freezeProof({ schemaVersion: "current-q1-d7-strict-export-proof-v1", actual: true,
      caseId, bindingSha256, state: "expected_conflict_refusal", context,
      queuedRows: queueProjection.queuedRows, orderedQueueDays: [...queueProjection.orderedQueueDays],
      queueReceiptSha256, steps: ["fence"], refusalProof: refusal, successProof: null,
      receiptSha256: jsonSha256(refusal) });
    requireFact(typeof Contract.validateCurrentQ1D7StrictExportProof === "function",
      "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
    return Contract.validateCurrentQ1D7StrictExportProof(proof, ctx.binding, caseId);
  }

  requireFact(caseId === "conflictFreePositive"
    && typeof ctx.P.runD1AnalyticsExportOracle === "function"
    && typeof ctx.P.validateAnalyticsHistoryOracle === "function",
  "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  let stepOrdinal = 0; const steps = [];
  const oracle = await ctx.P.runD1AnalyticsExportOracle({ ingestion: ctx.ingestion, analytics: ctx.analytics,
    ledger: ctx.ledger, pinnedNowMs: ctx.nowMs, sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace,
    cacheRetentionFromDay: null,
    foldHistory: [{ value: "disabled", fromMs: 1_700_000_000_000, untilMs: null }],
    moduleDigest,
    onStep: (step) => {
      checkDeadline(deadlineMonotonicMs);
      requireFact(typeof step === "string" && /^[a-z_]{1,48}$/u.test(step), "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
      steps.push(step);
      progress.counts({ completedSteps: ++stepOrdinal });
    } });
  const validated = ctx.P.validateAnalyticsHistoryOracle(oracle);
  requireFact(validated === oracle, "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  retainPrivateValidatedOracle(ctx, validated);
  assertSuccessfulOracleMatchesFence(validated, selection, fence, moduleDigest, ctx.sourceNamespace);
  requireFact(validated.liveCohort.members === cohort.members && validated.liveCohort.sha256 === cohort.sha256
    && validated.schema === "analytics-history-oracle-v2"
    && validated.moduleDigest === moduleDigest
    && validated.quiescence.queueRows === queueProjection.queuedRows
    && queueProjection.queuedRows === 0 && queueProjection.orderedQueueDays.length === 0
    && validated.importSelection.daily.length === bindingCase.dailyDays.length
    && isDeepStrictEqual(validated.importSelection.daily.map((row) => row.day), bindingCase.dailyDays)
    && validated.importSelection.modelDays.length === bindingCase.modelDays.length
    && isDeepStrictEqual(validated.importSelection.modelDays.map((row) => row.day), bindingCase.modelDays)
    && isDeepStrictEqual(steps, ["fence", "quiescence", "cohort", "selection", "cache_retention_resume",
      "daily_forced", "graph_forced", "cache_retention_rebuild"]),
  "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  checkDeadline(deadlineMonotonicMs);
  const successProof = Object.freeze({ schemaVersion: "current-q1-d7-oracle-success-v1", actual: true,
    oracleSchema: validated.schema, oracleSha256: jsonSha256(validated), moduleDigest: validated.moduleDigest,
    context, quiescence: Object.freeze({ ...validated.quiescence }) });
  const proof = freezeProof({ schemaVersion: "current-q1-d7-strict-export-proof-v1", actual: true,
    caseId, bindingSha256, state: "successful", context, queuedRows: queueProjection.queuedRows,
    orderedQueueDays: [...queueProjection.orderedQueueDays], queueReceiptSha256, steps,
    refusalProof: null, successProof, receiptSha256: jsonSha256(successProof) });
  requireFact(typeof Contract.validateCurrentQ1D7StrictExportProof === "function",
    "CURRENT_Q1_D7_EXPORT_PROOF_INVALID");
  return Contract.validateCurrentQ1D7StrictExportProof(proof, ctx.binding, caseId);
}

function freezeProof(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) freezeProof(nested, seen);
  return Object.freeze(value);
}

async function removeOwned(path, expectedStat) {
  if (!expectedStat) return;
  try {
    const current = await lstat(path);
    requireFact(current.isFile() && !current.isSymbolicLink() && current.uid === process.getuid()
      && current.nlink === 1 && current.dev === expectedStat.dev && current.ino === expectedStat.ino,
    "CURRENT_Q1_D7_OUTPUT_CLEANUP_CONFLICT");
    await unlink(path);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

/**
 * Prove the case's strict D1 export result and seal the exact current
 * ingestion snapshot for a later PG-input consumer. No transport, native PG
 * execution, or remote operation occurs here.
 */
export async function produceCurrentQ1D7CaseOutput({ ctx, input, bindingCase, sourceInvariantSha256,
  pgCaseDirectory, deadlineMonotonicMs, progress } = {}) {
  checkProgress(progress); checkDeadline(deadlineMonotonicMs);
  const caseId = assertCurrentCaseInput({ ctx, input, bindingCase, sourceInvariantSha256 });
  const sourceDigest = ctx.binding.source.sha256;
  const scratchRoot = ctx.scratchDirectory;
  const pgInputRoot = ctx.pgInputDirectory;
  await assertOwnerDirectory(scratchRoot);
  await assertOwnerDirectory(pgInputRoot);
  const pgRootFromScratch = relative(scratchRoot, pgInputRoot);
  requireFact(pgInputRoot !== scratchRoot && (pgRootFromScratch === ".."
    || pgRootFromScratch.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(pgRootFromScratch)), "CURRENT_Q1_D7_PG_INPUT_INVALID");
  await assertOwnerDirectory(pgCaseDirectory, { root: pgInputRoot });

  const ingestionPath = join(pgCaseDirectory, FILE_NAMES.ingestion);
  const journalPath = join(pgCaseDirectory, FILE_NAMES.journal);
  await assertMissingFile(ingestionPath); await assertMissingFile(journalPath);
  await assertNoSqliteSidecars(ingestionPath); await assertNoSqliteSidecars(journalPath);
  const created = new Map(); let complete = false;
  try {
    checkDeadline(deadlineMonotonicMs); progress.phase("source_recheck");
    requireFact(typeof ctx.sourceInvariant?.sha256 === "string"
      && ctx.sourceInvariant.sha256 === sourceInvariantSha256,
    "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
    const beforeInvariant = await D1.captureCurrentQ1IngestionInvariant(ctx.ingestion);
    requireFact(beforeInvariant.sha256 === sourceInvariantSha256, "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");

    requireFact(isAbsolute(ctx.paths.ingestion) && normalize(ctx.paths.ingestion) === ctx.paths.ingestion
      && await realpath(ctx.paths.ingestion) === ctx.paths.ingestion,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
    const sourceRel = relative(scratchRoot, ctx.paths.ingestion);
    requireFact(sourceRel !== ".." && !sourceRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(sourceRel), "CURRENT_Q1_D7_PG_INPUT_INVALID");
    await assertNoSqliteSidecars(ctx.paths.ingestion);
    const sourceFileBefore = await assertPrivateFile(ctx.paths.ingestion, { directory: dirname(ctx.paths.ingestion) });
    const sourceDigestBefore = await fileSha256(ctx.paths.ingestion, deadlineMonotonicMs);

    const { selection, fence } = await captureSelectionAndFence({ ctx, progress, deadlineMonotonicMs });
    const cohort = await captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase });
    const queueProjection = await captureQueueProjection(ctx, bindingCase);
    const strictExport = await produceStrictExport({ ctx, caseId, moduleDigest: sourceDigest,
      sourceInvariantSha256, bindingCase, progress, selection, fence, cohort, queueProjection, deadlineMonotonicMs });
    requireFact(isDeepStrictEqual(await captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase }), cohort)
      && isDeepStrictEqual(await captureQueueProjection(ctx, bindingCase), queueProjection),
    "CURRENT_Q1_D7_SOURCE_CHANGED");

    checkDeadline(deadlineMonotonicMs); progress.phase("source_recheck");
    const afterInvariant = await D1.captureCurrentQ1IngestionInvariant(ctx.ingestion);
    requireFact(afterInvariant.sha256 === sourceInvariantSha256,
      "CURRENT_Q1_D7_SOURCE_CHANGED");
    await assertNoSqliteSidecars(ctx.paths.ingestion);
    const sourceDigestAfter = await fileSha256(ctx.paths.ingestion, deadlineMonotonicMs);
    const sourceFileAfter = await assertPrivateFile(ctx.paths.ingestion,
      { directory: dirname(ctx.paths.ingestion) });
    requireFact(sourceDigestAfter.sha256 === sourceDigestBefore.sha256
      && sourceDigestAfter.bytes === sourceDigestBefore.bytes
      && sourceFileAfter.dev === sourceFileBefore.dev && sourceFileAfter.ino === sourceFileBefore.ino
      && sourceFileAfter.size === sourceFileBefore.size,
    "CURRENT_Q1_D7_SOURCE_CHANGED");

    checkDeadline(deadlineMonotonicMs);
    await copySealedSnapshot(ctx.paths.ingestion, ingestionPath, sourceFileBefore, created, deadlineMonotonicMs);
    await chmod(ingestionPath, 0o444);
    await assertNoSqliteSidecars(ingestionPath);
    const ingestionStat = await assertPrivateFile(ingestionPath, { readOnly: true, directory: pgCaseDirectory });
    const ingestionDigest = await fileSha256(ingestionPath, deadlineMonotonicMs);
    requireFact(ingestionStat.size === ingestionDigest.bytes
      && ingestionDigest.sha256 === sourceDigestBefore.sha256
      && ingestionDigest.bytes === sourceDigestBefore.bytes,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");

    const ingestionCheck = new DatabaseSync(ingestionPath, { readOnly: true, allowExtension: false });
    try { ingestionCheck.exec("PRAGMA query_only=ON"); checkQuick(ingestionCheck); }
    finally { ingestionCheck.close(); }

    checkDeadline(deadlineMonotonicMs);
    await assertNoSqliteSidecars(journalPath);
    await assertMissingFile(journalPath);
    const journalHandle = await open(journalPath, "wx", 0o600);
    try { created.set(journalPath, await journalHandle.stat()); await journalHandle.sync(); }
    finally { await journalHandle.close(); }
    const journalDigest = await buildJournalSnapshot(ingestionPath, journalPath, pgCaseDirectory,
      deadlineMonotonicMs, progress);
    const ingestionAfterProjection = await fileSha256(ingestionPath, deadlineMonotonicMs);
    requireFact(ingestionAfterProjection.sha256 === ingestionDigest.sha256
      && ingestionAfterProjection.bytes === ingestionDigest.bytes,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");

    const descriptor = freezePgInputDescriptor({
      schemaVersion: "current-q1-d7-pg-case-input-v1",
      corpusCaseId: input.physicalId,
      corpusSha256: input.corpusSha256,
      admissionSha256: input.admissionSha256,
      sourceId: ctx.sourceId,
      sourceNamespace: ctx.sourceNamespace,
      sourceInvariantSha256,
      selectionSha256: jsonSha256(selection),
      fenceSha256: jsonSha256(fence),
      ingestion: freezeFile({ path: ingestionPath, sha256: ingestionDigest.sha256, bytes: ingestionDigest.bytes }),
      journal: freezeFile({ path: journalPath, sha256: journalDigest.sha256, bytes: journalDigest.bytes }),
    });
    requireFact(descriptor.ingestion.path !== descriptor.journal.path
      && dirname(descriptor.ingestion.path) === pgCaseDirectory
      && dirname(descriptor.journal.path) === pgCaseDirectory,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
    requireFact(typeof Contract.validateCurrentQ1D7PgCaseInput === "function"
      && Contract.validateCurrentQ1D7PgCaseInput(descriptor, ctx.binding, caseId,
        { expectedDirectory: pgCaseDirectory }) === descriptor,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
    complete = true;
    return Object.freeze({ strictExport, pgInput: descriptor });
  } catch (error) {
    if (Object.prototype.hasOwnProperty.call(ctx, PRIVATE_VALIDATED_ORACLE))
      clearCurrentQ1D7PrivateValidatedOracle(ctx);
    if (error && typeof error.code === "string" && /^CURRENT_Q1_D7_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail("CURRENT_Q1_D7_CASE_OUTPUT_INVALID");
  } finally {
    if (!complete) {
      for (const path of [journalPath, ingestionPath]) await removeOwned(path, created.get(path));
      await removeOwnedSidecars(journalPath);
      await removeOwnedSidecars(ingestionPath);
    }
  }
}
