import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "vite";

import * as Contract from "./current-q1-d7-contract.mjs";
import * as D7 from "./current-q1-d7-recompute.mjs";
import { buildCurrentQ1D7CurrentPublicExpectation, buildCurrentQ1D7PerDateExpectation,
  buildCurrentQ1D7WindowProofs } from "./current-q1-d7-expectation.mjs";
import { buildCurrentCorpus } from "../../scripts/gcp-fastpath-current-corpus.mjs";
import { captureCurrentQ1D7LiveCohort, clearCurrentQ1D7PrivateValidatedOracle,
  currentQ1D7CaseOutputQueueReceiptSha256,
  createCurrentQ1D7PublicProjectionReceipt,
  validateCurrentQ1D7CurrentPublicResponse } from "./current-q1-d7-case-output.mjs";

const H = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA = Contract.currentQ1D7JsonSha256;
const expectedReceipt = (proof) => hash({ caseId: proof.caseId, bindingSha256: proof.bindingSha256,
  context: proof.context, queuedRows: proof.queuedRows, orderedQueueDays: proof.orderedQueueDays });

function repositoryRoot(start) {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(resolve(directory, "packages/telemetry-contract/index.js"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("telemetry-contract package unavailable");
    directory = parent;
  }
}

const telemetryUrl = pathToFileURL(resolve(repositoryRoot(process.cwd()),
  "packages/telemetry-contract/index.js")).href;
const telemetryHook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@app-usagemonitor/telemetry-contract") {
    return { url: ${JSON.stringify(telemetryUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(telemetryHook)}`, import.meta.url);

async function loadCurrentPublicAuthority() {
  const workerRoot = resolve(repositoryRoot(process.cwd()), "apps/worker");
  const cacheDir = await mkdtemp(join(tmpdir(), "current-q1-d7-case-output-vite-"));
  await chmod(cacheDir, 0o700);
  let vite;
  try {
    vite = await createServer({ root: workerRoot, cacheDir, configFile: false, envDir: false, appType: "custom",
      logLevel: "silent", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    const [wrapper, community, allowance, metadataModule] = await Promise.all([
      vite.ssrLoadModule("/src/analytics-v2/public-allowance-breakdowns-v15.ts"),
      vite.ssrLoadModule("/src/community-allowance.ts"),
      vite.ssrLoadModule("/src/admin-community-allowance.ts"),
      vite.ssrLoadModule("/src/analytics-v2/public-model-metadata-current.ts"),
    ]);
    return Object.freeze({ reduce: wrapper.reducePublicAllowanceBreakdownsV15,
      wrap: wrapper.wrapPublicAllowanceBreakdownsV15,
      schemaVersion: wrapper.PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION,
      basis: community.COMMUNITY_ALLOWANCE_BASIS,
      normalization: community.COMMUNITY_ALLOWANCE_NORMALIZATION,
      modelBasis: allowance.ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
      modelGate: allowance.ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
      metadata: metadataModule.buildCurrentPublicModelMetadata() });
  } finally {
    await vite?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

const CURRENT_PUBLIC_AUTHORITY = await loadCurrentPublicAuthority();
const Telemetry = await import(telemetryUrl);
const OWNERS = ["a", "b", "c", "d"];
const STREAMS = ["quota", "session", "usage"];
const CASE_IDS = ["conflictPreserving", "conflictFreePositive"];
const dates = (from, length) => Array.from({ length }, (_, index) =>
  new Date(Date.parse(`${from}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));

function context() {
  return {
    sourceId: "gcp-fastpath-oracle",
    sourceNamespace: "gcp-fastpath-oracle",
    pinnedNowMs: 1_790_856_000_000,
    sourceInvariantSha256: H("source-invariant"),
    sourceModuleSha256: H("d1-export-oracle-module"),
    cohortMembers: 4,
    cohortSha256: H("cohort"),
    fenceSha256: H("fence"),
    selectionSha256: H("selection"),
  };
}

function receipt(caseId, queuedRows, orderedQueueDays) {
  return {
    caseId,
    bindingSha256: H("binding"),
    context: context(),
    queuedRows,
    orderedQueueDays,
  };
}

test("strict-export queue receipt binds the exact conflict-case projection", () => {
  const proof = receipt("conflictPreserving", 2, ["2026-04-17", "2026-04-18"]);
  assert.equal(currentQ1D7CaseOutputQueueReceiptSha256(proof), expectedReceipt(proof));

  const reordered = structuredClone(proof);
  reordered.orderedQueueDays.reverse();
  assert.notEqual(currentQ1D7CaseOutputQueueReceiptSha256(reordered), expectedReceipt(proof));

  const changedContext = structuredClone(proof);
  changedContext.context.sourceModuleSha256 = H("other-module");
  assert.notEqual(currentQ1D7CaseOutputQueueReceiptSha256(changedContext), expectedReceipt(proof));
});

test("strict-export queue receipt binds the exact zero-queue positive projection", () => {
  const proof = receipt("conflictFreePositive", 0, []);
  assert.equal(currentQ1D7CaseOutputQueueReceiptSha256(proof), expectedReceipt(proof));
  assert.throws(() => currentQ1D7CaseOutputQueueReceiptSha256({ ...proof, queuedRows: 1.5 }),
    /CURRENT_Q1_D7_EXPORT_PROOF_INVALID/u);
});

test("private validated oracle is excluded from serialization and explicitly clearable", () => {
  const ctx = {};
  const oracle = { schema: "analytics-history-oracle-v2", privateValue: true };
  Object.defineProperty(ctx, "privateValidatedOracle", { value: oracle, writable: true,
    enumerable: false, configurable: true });
  assert.equal(JSON.stringify(ctx), "{}");
  assert.equal(clearCurrentQ1D7PrivateValidatedOracle(ctx), true);
  assert.equal(Object.hasOwn(ctx, "privateValidatedOracle"), false);
  assert.equal(clearCurrentQ1D7PrivateValidatedOracle(ctx), false);

  Object.defineProperty(ctx, "privateValidatedOracle", { value: oracle, writable: true,
    enumerable: true, configurable: true });
  assert.throws(() => clearCurrentQ1D7PrivateValidatedOracle(ctx),
    /CURRENT_Q1_D7_EXPORT_PROOF_INVALID/u);
});

function testBinding() {
  const packageNames = ["accounting", "quota-analysis", "telemetry-contract"];
  const paths = new Set(Contract.CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS);
  for (const name of packageNames) for (const file of ["package.json", "index.js"]) {
    paths.add(`packages/${name}/${file}`);
    paths.add(`apps/worker/node_modules/@app-usagemonitor/${name}/${file}`);
  }
  const hashes = new Map([...paths].map((path) => [path, H(`source:${path}`)]));
  for (const name of ["admin-model-history.js", "model-catalog.js"]) {
    hashes.set(`apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/${name}`,
      hashes.get(`packages/telemetry-contract/src/${name}`));
  }
  for (const name of packageNames) for (const file of ["package.json", "index.js"]) {
    hashes.set(`apps/worker/node_modules/@app-usagemonitor/${name}/${file}`,
      hashes.get(`packages/${name}/${file}`));
  }
  const files = [...hashes].map(([path, sha256]) => ({ path, sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const allDailyDays = D7.currentQ1D7Days();
  const graphDays = Contract.currentQ1D7GraphDays();
  const makeCase = (caseId) => {
    const conflictDays = caseId === "conflictPreserving" ? [allDailyDays[2], allDailyDays[3]] : [];
    return { caseId, corpusCaseId: caseId === "conflictPreserving"
      ? "conflict-preserving-negative-v2" : "conflict-free-positive-v2",
    corpusSha256: caseId === "conflictPreserving"
      ? "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e" : H("positive-corpus"),
    topologySha256: H(`${caseId}:topology`), admissionSha256: H(`${caseId}:admission`),
    sourceInvariantSha256: H(`${caseId}:invariant`), owners: ["a", "b", "c", "d"], sourceDays: 170,
    recordCount: 14832, primaryRecordCount: 14830, extraAdmissions: 2, conflictDays,
    dailyDays: allDailyDays.filter((day) => !conflictDays.includes(day)), modelDays: graphDays };
  };
  const source = { head: "a".repeat(40), files, sha256: Contract.currentQ1D7JsonSha256(files) };
  return {
    schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.binding, decisionId: "D7",
    sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle", source,
    runtime: { version: "v26.2.0", platform: "darwin", arch: "arm64",
      binarySha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
      pinnedNowMs: Contract.CURRENT_Q1_D7_NOW_MS, randomSeed: "current-q1-reference", sqliteVersion: "3.50.4" },
    migrationSha256: H("migration"), bounds: Contract.CURRENT_Q1_D7_BOUNDS,
    cases: { conflictPreserving: makeCase("conflictPreserving"),
      conflictFreePositive: makeCase("conflictFreePositive") },
  };
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

function enrichNativePages(binding, witnesses, windowProofs) {
  const enriched = structuredClone(witnesses);
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

function sourceConflictProofs(binding, witnesses, windowProofs) {
  const bindingSha256 = SHA(binding);
  const sourceInvariantSha256 = binding.cases.conflictPreserving.sourceInvariantSha256;
  const sourceHash = (path) => binding.source.files.find((entry) => entry.path === path)?.sha256;
  return windowProofs.map((window) => {
    const sourceDay = binding.cases.conflictPreserving.conflictDays
      .find((day) => day >= window.fromDay && day <= window.throughDay);
    const witness = witnesses.find((entry) => entry.owner === "a" && entry.day === sourceDay && entry.stream === "usage");
    const page = witness?.nativePages.find((entry) => entry.modelDay === window.day);
    assert.ok(witness && page);
    const proof = { schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.conflict,
      caseId: "conflictPreserving", bindingSha256,
      scope: { owner: "a", metric: "model", day: window.day, sourceKind: "effective",
        dependencyDigest: page.dependencyDigest, keyDigest: page.keyDigest, headDigest: page.headDigest,
        cursorSha256: page.cursorSha256, checkpointMethod: page.checkpointMethod },
      origin: { label: "effective_history_guard_544",
        moduleSha256: sourceHash("apps/worker/src/storage-effective-history.ts"), originProofSha256: H("origin"),
        factoryLine: 26, guardLine: 544,
        observerSha256: sourceHash("apps/worker/scripts/current-q1-conflict-proof.mjs") },
      reader: { method: "effective-telemetry-owner-day-v1", stream: "usage", pageSha256: page.pageSha256,
        sourceDay, sourceWitnessSha256: SHA(witness), associationSha256: null,
        rows: 9, compatibleRows: 8, conflictRows: 1, compatibleRowsValid: true,
        conflictRecordJsonNull: true, conflictEventTimeNull: true, cursorMatched: true },
      fences: { authorityBeforeSha256: H("authority"), authorityAfterSha256: H("authority"),
        sourceBeforeSha256: sourceInvariantSha256, sourceAfterSha256: sourceInvariantSha256 } };
    proof.reader.associationSha256 = Contract.currentQ1D7ConflictAssociationSha256(proof, witness);
    return proof;
  });
}

function readyResult(day) {
  return { status: "ready", planType: "pro", fit: { status: "fitted", capacityUsdByModel: { "gpt-5.6-sol": 10 } },
    voidedBinCount: 0, poolCount: 1, quotaRowCount: 1, usageEventCount: 1, unpricedUsageEventCount: 0,
    poisonedBinCount: 0, latestQuotaObservedAt: `${day}T12:00:00.000Z`, attributionStatus: "legacy_conditional",
    attributionMethod: "synthetic-current-reader", inputFingerprint: H(`input:${day}`) };
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

const current = {
  ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG: [{ planType: "pro", multiplier: 1 }],
  COMMUNITY_ALLOWANCE_TRAILING_DAYS: 30,
  buildCommunityModelCompositionDay(collection, day) {
    const count = collection.compositions.length;
    return Telemetry.projectAdminModelHistoryDay({ day,
      catalogVersion: Telemetry.ADMIN_MODEL_HISTORY_CATALOG_VERSION,
      values: count ? [["gpt-5.6-sol", 10, count], ["gpt-6-sol", 20, count]] : [], fittedParticipantCount: count,
      unstableParticipantCount: 0, staleParticipantCount: 0,
      refusedParticipantCount: collection.refusedParticipantCount,
      v1ParticipantCount: collection.v1ParticipantCount,
      unsupportedSourceParticipantCount: collection.unsupportedSourceParticipantCount });
  },
  projectAdminModelHistoryDay: Telemetry.projectAdminModelHistoryDay,
};

function perDateExpectation(binding, caseId) {
  if (caseId === "conflictFreePositive") return buildCurrentQ1D7PerDateExpectation({ binding, caseId, current,
    contract: Contract, ownerResults: ownerResults(binding, caseId), sourceWitnesses: [], sourceConflictProofs: [] });
  const initialWitnesses = sourceWitnesses(binding);
  const initialWindows = buildCurrentQ1D7WindowProofs({ binding, caseId, sourceWitnesses: initialWitnesses });
  const witnesses = enrichNativePages(binding, initialWitnesses, initialWindows);
  const windows = buildCurrentQ1D7WindowProofs({ binding, caseId, sourceWitnesses: witnesses });
  const proofs = sourceConflictProofs(binding, witnesses, windows);
  return buildCurrentQ1D7PerDateExpectation({ binding, caseId, current, contract: Contract,
    ownerResults: ownerResults(binding, caseId, proofs.map((proof) => proof.scope)),
    sourceWitnesses: witnesses, sourceConflictProofs: proofs });
}

function nativeEvidenceFor(expectation) {
  const byCoordinate = new Map(expectation.ownerEvidence.map((entry) => [`${entry.owner}/${entry.day}`, entry]));
  return OWNERS.flatMap((owner) => Contract.currentQ1D7GraphDays().map((day) => {
    const expected = byCoordinate.get(`${owner}/${day}`);
    if (expected.conflictProofSha256 !== null) return { owner, metric: "model", day,
      state: "expected_source_conflict", invocations: 1, verifiedSha256: null,
      reason: null, proofSha256: expected.conflictProofSha256 };
    return { owner, metric: "model", day, state: expected.classification === "refused" ? "not_testable" : "complete",
      invocations: 1, verifiedSha256: expected.resultSha256,
      reason: expected.classification === "refused" ? expected.reason : null, proofSha256: null };
  }));
}

function publicationEvidence(expectation) {
  const graphDays = Contract.currentQ1D7GraphDays();
  const withheldDays = [...new Set(expectation.ownerEvidence.filter((entry) => entry.conflictProofSha256 !== null)
    .map((entry) => entry.day))].sort();
  const withheld = new Set(withheldDays);
  return {
    withheldDays,
    publication: { outcomes: new Map(graphDays.map((day) => [day, withheld.has(day)
      ? { state: "deferred", reason: "cache_pending", memberCount: 4 }
      : { state: "published", memberCount: 4 }])), expectedMissing: withheldDays },
    publicationInventory: graphDays.map((day, index) => withheld.has(day)
      ? { day, state: "withheld", sha256: null }
      : { day, state: "published", sha256: SHA(expectation.days[index]) }),
  };
}

function validPublicResponse(binding, expectation, currentPublicExpectation, meta, withheldDays = []) {
  const nowMs = Contract.CURRENT_Q1_D7_NOW_MS;
  const modelSummary = () => ({ centralUsd: 1, participantCount: 4, fitCount: 3,
    band80Usd: { lowerUsd: 0.5, upperUsd: 1.5 } });
  const publicDays = currentPublicExpectation.days.map((entry) => ({ day: entry.day, combined: modelSummary(),
    byPlanType: { pro: modelSummary(), prolite: modelSummary(), promax: modelSummary(), plus: modelSummary() },
    models: withheldDays.includes(entry.day) ? [] : entry.models.map((tuple) => [...tuple]) }));
  const dailyDays = binding.cases[currentPublicExpectation.caseId].dailyDays;
  const allowanceEnvelope = CURRENT_PUBLIC_AUTHORITY.wrap({
    schemaVersion: CURRENT_PUBLIC_AUTHORITY.schemaVersion,
    basis: CURRENT_PUBLIC_AUTHORITY.basis,
    referencePlanType: "pro",
    normalization: CURRENT_PUBLIC_AUTHORITY.normalization,
    modelBasis: CURRENT_PUBLIC_AUTHORITY.modelBasis,
    modelGate: CURRENT_PUBLIC_AUTHORITY.modelGate,
    generatedAt: new Date(nowMs).toISOString(), days: publicDays,
  }, meta);
  return { responseBody: { schemaVersion: "community-daily-read-v1.0", from: dailyDays[0],
    to: dailyDays.at(-1), allowanceState: "ready", allowanceReadState: "confirmed",
    allowanceBreakdowns: allowanceEnvelope,
    cacheRetention: {}, days: dailyDays.map((day) => ({ day })) },
  expectation: currentPublicExpectation, binding, expectedDailyDays: dailyDays,
  dailyWindow: { fromDay: D7.currentQ1D7Days()[0], throughDay: D7.currentQ1D7Days().at(-1) },
  metadata: meta, nowMs, publicAllowanceAuthority: CURRENT_PUBLIC_AUTHORITY.reduce };
}

function currentPublicCase(binding, caseId) {
  const expectation = perDateExpectation(binding, caseId);
  const currentPublicExpectation = buildCurrentQ1D7CurrentPublicExpectation({ expectation, binding, contract: Contract });
  const publicationProof = publicationEvidence(expectation);
  const base = validPublicResponse(binding, expectation, currentPublicExpectation, CURRENT_PUBLIC_AUTHORITY.metadata,
    publicationProof.withheldDays);
  const nativeEvidence = nativeEvidenceFor(expectation);
  const receiptInput = { binding, perDateExpectation: expectation, currentPublicExpectation, nativeEvidence,
    conflictProofs: expectation.sourceConflictProofs, publication: publicationProof.publication,
    publicationInventory: publicationProof.publicationInventory,
    publicAllowanceAuthority: CURRENT_PUBLIC_AUTHORITY.reduce,
    publicAllowanceEnvelope: base.responseBody.allowanceBreakdowns };
  const publicationReceipt = createCurrentQ1D7PublicProjectionReceipt(receiptInput);
  const validatorInput = { ...base, publicationReceipt,
    publicAllowanceAuthority: CURRENT_PUBLIC_AUTHORITY.reduce };
  return { expectation, currentPublicExpectation, publicationProof, nativeEvidence, receiptInput,
    publicationReceipt, validatorInput };
}

test("live cohort capture binds exact generated participant and owner-digest pairs", async () => {
  const generated = buildCurrentCorpus("conflict-preserving-negative-v2");
  const owners = generated.owners.map(({ key, participantId, pinnedOwnerDigest }) =>
    ({ key, participantId, pinnedOwnerDigest }));
  const bindingCase = { caseId: "conflictPreserving", corpusCaseId: "conflict-preserving-negative-v2",
    corpusSha256: H("corpus"), admissionSha256: H("admission"), owners: owners.map((owner) => owner.key) };
  const input = { caseKey: bindingCase.caseId, physicalId: bindingCase.corpusCaseId,
    corpusSha256: bindingCase.corpusSha256, admissionSha256: bindingCase.admissionSha256, corpus: { owners } };
  let liveRows = owners.map((owner) => ({ participantId: owner.participantId, ownerDigest: owner.pinnedOwnerDigest }));
  const ctx = { ingestion: {}, P: {
    async readD1AnalyticsLiveCohort() { return { members: 4, sha256: H("live-cohort") }; },
    async readStorageCommunityOwnerPage() { return liveRows; },
  } };
  assert.deepEqual(await captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase }),
    { members: 4, sha256: H("live-cohort") });
  const original = liveRows;
  liveRows = original.map((row, index) => index === 0 ? { ...row, participantId: "participant:substituted" } : row);
  await assert.rejects(() => captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase }),
    (error) => error?.code === "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
  liveRows = original.map((row, index) => index === 0 ? { ...row, ownerDigest: H("substituted-digest") } : row);
  await assert.rejects(() => captureCurrentQ1D7LiveCohort({ ctx, input, bindingCase }),
    (error) => error?.code === "CURRENT_Q1_D7_SOURCE_FENCE_INVALID");
});

test("positive public DTO binds all 70 published projections and the sealed 69-day expectation", () => {
  const binding = testBinding();
  Contract.validateCurrentQ1D7Binding(binding);
  const positive = currentPublicCase(binding, "conflictFreePositive");
  assert.equal(positive.publicationProof.publicationInventory.length, 70);
  assert.ok(positive.publicationProof.publicationInventory.every((entry) => entry.state === "published"));
  assert.deepEqual(validateCurrentQ1D7CurrentPublicResponse(positive.validatorInput),
    positive.validatorInput.responseBody);
  for (let index = 0; index < positive.currentPublicExpectation.days.length; index += 1) {
    assert.deepEqual(positive.validatorInput.responseBody.allowanceBreakdowns.days[index].models,
      positive.currentPublicExpectation.days[index].models);
  }
});

test("negative public DTO permits only the four conflict/native/publication-bound empty model days", () => {
  const binding = testBinding();
  Contract.validateCurrentQ1D7Binding(binding);
  const negative = currentPublicCase(binding, "conflictPreserving");
  const graphDays = Contract.currentQ1D7GraphDays();
  const conflictDerivedDays = [...new Set(negative.expectation.ownerEvidence
    .filter((entry) => entry.conflictProofSha256 !== null).map((entry) => entry.day))].sort();
  assert.deepEqual(binding.cases.conflictPreserving.conflictDays, ["2026-04-17", "2026-04-18"]);
  assert.equal(conflictDerivedDays.length, 4);
  assert.deepEqual(negative.publicationProof.withheldDays, conflictDerivedDays);
  assert.deepEqual(negative.publicationProof.publication.expectedMissing, conflictDerivedDays);
  assert.deepEqual(negative.publicationProof.publicationInventory.filter((entry) => entry.state === "withheld")
    .map((entry) => entry.day), conflictDerivedDays);
  for (let index = 0; index < graphDays.length - 1; index += 1) {
    const actual = negative.validatorInput.responseBody.allowanceBreakdowns.days[index];
    if (negative.publicationProof.withheldDays.includes(actual.day)) assert.deepEqual(actual.models, []);
    else assert.deepEqual(actual.models, negative.currentPublicExpectation.days[index].models);
  }
  assert.equal(validateCurrentQ1D7CurrentPublicResponse(negative.validatorInput),
    negative.validatorInput.responseBody);

  const rejectResponse = (mutate) => {
    const responseBody = structuredClone(negative.validatorInput.responseBody);
    mutate(responseBody);
    assert.throws(() => validateCurrentQ1D7CurrentPublicResponse({ ...negative.validatorInput, responseBody }),
      (error) => error?.code === "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  };
  rejectResponse((body) => { body.allowanceBreakdowns.days[4].models = []; });
  rejectResponse((body) => { body.allowanceBreakdowns.days.push({
    ...structuredClone(body.allowanceBreakdowns.days.at(-1)), models: [],
  }); });
  rejectResponse((body) => { body.allowanceBreakdowns.days.reverse(); });

  const counterfeitReceipt = structuredClone(negative.publicationReceipt);
  assert.throws(() => validateCurrentQ1D7CurrentPublicResponse({ ...negative.validatorInput,
    publicationReceipt: counterfeitReceipt }),
  (error) => error?.code === "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");

  const graphProof = negative.publicationProof;
  const nonConflictDay = graphDays.find((day) => !conflictDerivedDays.includes(day));
  const unboundMissing = { ...graphProof.publication,
    expectedMissing: [...graphProof.publication.expectedMissing, nonConflictDay],
    outcomes: new Map(graphProof.publication.outcomes) };
  unboundMissing.outcomes.set(nonConflictDay, { state: "deferred", reason: "cache_pending", memberCount: 4 });
  assert.throws(() => createCurrentQ1D7PublicProjectionReceipt({ ...negative.receiptInput,
    publication: unboundMissing }),
  (error) => error?.code === "CURRENT_Q1_D7_PUBLICATION_INVALID");

  const extraWithheldInventory = graphProof.publicationInventory.map((entry) => ({ ...entry }));
  const nonConflictIndex = graphDays.indexOf(nonConflictDay);
  extraWithheldInventory[nonConflictIndex] = { day: nonConflictDay, state: "withheld", sha256: null };
  assert.throws(() => createCurrentQ1D7PublicProjectionReceipt({ ...negative.receiptInput,
    publicationInventory: extraWithheldInventory }),
  (error) => error?.code === "CURRENT_Q1_D7_PUBLICATION_INVALID");

  const wrongNativeProof = structuredClone(negative.nativeEvidence);
  const conflictRow = wrongNativeProof.find((row) => row.state === "expected_source_conflict");
  conflictRow.proofSha256 = H("counterfeit-proof");
  assert.throws(() => createCurrentQ1D7PublicProjectionReceipt({ ...negative.receiptInput,
    nativeEvidence: wrongNativeProof }),
  (error) => error?.code === "CURRENT_Q1_D7_PUBLICATION_INVALID");
});

test("current public validator pins every nonempty v1.5 authority field through the source reducer", () => {
  const binding = testBinding();
  const positive = currentPublicCase(binding, "conflictFreePositive");
  const fields = ["basis", "normalization", "modelBasis", "modelGate"];
  for (const field of fields) {
    const envelope = structuredClone(positive.receiptInput.publicAllowanceEnvelope);
    envelope[field] = `counterfeit-${field}`;
    assert.throws(() => CURRENT_PUBLIC_AUTHORITY.reduce(envelope), /PUBLIC_ALLOWANCE_BREAKDOWNS_V15_INVALID/u);
    assert.throws(() => createCurrentQ1D7PublicProjectionReceipt({ ...positive.receiptInput,
      publicAllowanceEnvelope: envelope }),
    (error) => error?.code === "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");

    const responseBody = structuredClone(positive.validatorInput.responseBody);
    responseBody.allowanceBreakdowns[field] = `counterfeit-${field}`;
    assert.throws(() => validateCurrentQ1D7CurrentPublicResponse({ ...positive.validatorInput, responseBody }),
      (error) => error?.code === "CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID");
  }
});

test("current public DTO validator rejects envelope, date and per-model projection mutations", () => {
  const binding = testBinding();
  Contract.validateCurrentQ1D7Binding(binding);
  const positive = currentPublicCase(binding, "conflictFreePositive");
  const base = positive.validatorInput;
  const meta = CURRENT_PUBLIC_AUTHORITY.metadata;
  const reject = (mutate) => {
    const responseBody = structuredClone(base.responseBody);
    mutate(responseBody);
    assert.throws(() => validateCurrentQ1D7CurrentPublicResponse({ ...base, responseBody }),
      /CURRENT_Q1_D7_CURRENT_PUBLIC_INVALID/u);
  };
  reject((body) => { delete body.allowanceBreakdowns.normalization; });
  reject((body) => { body.allowanceBreakdowns.unexpected = true; });
  reject((body) => {
    const row = body.allowanceBreakdowns;
    body.allowanceBreakdowns = { basis: row.basis, schemaVersion: row.schemaVersion, ...row };
  });
  reject((body) => { body.allowanceBreakdowns.days.pop(); });
  reject((body) => { body.allowanceBreakdowns.days.push(structuredClone(body.allowanceBreakdowns.days.at(-1))); });
  reject((body) => { body.allowanceBreakdowns.days.reverse(); });
  reject((body) => { body.allowanceBreakdowns.days[0].models.pop(); });
  reject((body) => { body.allowanceBreakdowns.days[0].models.push([meta[2].id, 9, 2]); });
  reject((body) => { body.allowanceBreakdowns.days[0].models.reverse(); });
  reject((body) => { body.allowanceBreakdowns.days[0].models[0][0] = meta[2].id; });
  reject((body) => { body.allowanceBreakdowns.days[0].models[0][1] += 0.25; });
  reject((body) => { body.days.reverse(); });
});
