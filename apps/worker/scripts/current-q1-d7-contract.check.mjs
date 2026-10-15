import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_MODEL_HISTORY_CATALOG_VERSION } from "@app-usagemonitor/telemetry-contract";
import { CURRENT_Q1_D7_SCHEMAS as S, CURRENT_Q1_D7_BOUNDS, CURRENT_Q1_D7_NORMALIZATIONS,
  currentQ1D7JsonSha256 as sha, currentQ1D7GraphDays, validateCurrentQ1D7Binding,
  validateCurrentQ1D7SourceConflictProof, validateCurrentQ1D7PerDateExpectation,
  validateCurrentQ1D7CaseReference, assessCurrentQ1D7Qualification,
  validateCurrentQ1D7ProducerAcceptance, validateCurrentQ1D7PgCaseInput, validateCurrentQ1D7InputBinding, currentQ1D7PublicDays, currentQ1D7ConflictAssociationSha256, validateCurrentQ1D7BootstrapPreservation, validateCurrentQ1D7StrictExportProof, currentQ1D7BootstrapTransitionSha256, currentQ1D7BootstrapRawAdmissionsSha256, currentQ1D7ExportQueueReceiptSha256, CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS, validCurrentQ1D7SourcePath } from "../postgres-test/fixtures/current-q1-d7-contract.mjs";

const H = fill => fill.repeat(64), DAYS = currentQ1D7GraphDays(), OWNERS = ["a", "b", "c", "d"];
const CASES = ["conflictPreserving", "conflictFreePositive"];
const dates = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0,10));
const invalid = { code: "CURRENT_Q1_D7_CONTRACT_INVALID" };
/** Synthetic structural evidence only. Never an executed production receipt.
 * This builder is exported for the separate comparator's synthetic tests. */
export function currentQ1D7SyntheticFixture({ controllerInSource = true, sourceSha256ByPath = undefined } = {}) {
  const sourceFiles = CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS
    .filter(path => controllerInSource || path !== "apps/worker/scripts/gcp-fastpath-rehearsal.mjs")
    .map(path => ({path,sha256:path === "apps/worker/scripts/gcp-fastpath-rehearsal.mjs" ? H("f") : H("a")}));
  if (sourceSha256ByPath !== undefined) {
    const validMap = sourceSha256ByPath !== null && typeof sourceSha256ByPath === "object"
      && !Array.isArray(sourceSha256ByPath) && [Object.prototype, null].includes(Object.getPrototypeOf(sourceSha256ByPath))
      && Reflect.ownKeys(sourceSha256ByPath).every(path => typeof path === "string"
        && Object.getOwnPropertyDescriptor(sourceSha256ByPath,path)?.enumerable === true
        && typeof Object.getOwnPropertyDescriptor(sourceSha256ByPath,path)?.value === "string"
        && validCurrentQ1D7SourcePath(path) && /^[a-f0-9]{64}$/u.test(sourceSha256ByPath[path]))
      && Object.keys(sourceSha256ByPath).length > 0 && Object.keys(sourceSha256ByPath).length <= 10000
      && new Set([...sourceFiles.map(file=>file.path),...Object.keys(sourceSha256ByPath)]).size <= 10000;
    if (!validMap || !controllerInSource && Object.hasOwn(sourceSha256ByPath,"apps/worker/scripts/gcp-fastpath-rehearsal.mjs"))
      throw Object.assign(new Error("CURRENT_Q1_D7_SYNTHETIC_SOURCE_MAP_INVALID"), {code:"CURRENT_Q1_D7_SYNTHETIC_SOURCE_MAP_INVALID"});
    for (const [path,sha256] of Object.entries(sourceSha256ByPath)) {
      const entry=sourceFiles.find(file=>file.path===path);
      if(entry)entry.sha256=sha256;else sourceFiles.push({path,sha256});
    }
  }
  sourceFiles.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const sourceSha = (path, fallback=H("a")) => sourceFiles.find(file=>file.path===path)?.sha256 ?? fallback;
  const binding = { schemaVersion: S.binding, decisionId: "D7", sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle",
    source: { head: "1".repeat(40), files: sourceFiles, sha256: sha(sourceFiles) }, migrationSha256: H("b"), bounds: { ...CURRENT_Q1_D7_BOUNDS },
    runtime: { version: "v26.2.0", platform: "darwin", arch: "arm64", binarySha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
      pinnedNowMs: 1790856000000, randomSeed: "current-q1-reference", sqliteVersion: "synthetic-not-executed" }, cases: {} };
  for (const [i,caseId] of CASES.entries()) {
    const conflictDays = i === 0 ? ["2026-04-17", "2026-04-18"] : [];
    binding.cases[caseId] = { caseId, corpusCaseId:i===0?"conflict-preserving-negative-v2":"conflict-free-positive-v2", corpusSha256: i === 0 ? "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e" : H("2"),
      topologySha256: H(String(i + 3)), admissionSha256: H(String(i + 5)), sourceInvariantSha256: H(String(i + 7)),
      owners: [...OWNERS], sourceDays: 170, recordCount: 14832, primaryRecordCount: 14830, extraAdmissions: 2,
      conflictDays, dailyDays: dates("2026-04-15",170).filter(day => !conflictDays.includes(day)), modelDays: [...DAYS] };
  }
  const inputBinding=structuredClone(binding);inputBinding.schemaVersion=S.inputBinding;
  for(const id of CASES)delete inputBinding.cases[id].sourceInvariantSha256;
  const bindingSha256 = sha(binding), cases = {}, expectations = {}, expectationSha256 = {}, pgInputs = {};
  for (const caseId of CASES) {
    const c = binding.cases[caseId], source = c.sourceInvariantSha256;
    const affected = DAYS.filter(day => c.conflictDays.some(d => d >= new Date(Date.parse(day)-100*86400000).toISOString().slice(0,10) && d <= day));
    const sourceWitnesses = c.conflictDays.flatMap(day => ["quota","session","usage"].map(stream => ({ owner:"a",day,stream,
      method:"effective-telemetry-owner-day-v1",pageCount:1,rows:stream === "usage" ? 9 : 1,compatibleRows:stream === "usage" ? 8 : 1,
      conflictRows:stream === "usage" ? 1 : 0,complete:true,cursorOrderValid:true,occurrenceMatched:stream === "usage",compatibleRowsValid:true,
      conflictRecordJsonNull:stream === "usage",conflictEventTimeNull:stream === "usage",sourceInvariantSha256:source,readerEvidenceSha256:sha([day,stream]),nativePages:[] })));
    for(const day of affected){
      const fromDay=new Date(Date.parse(day)-100*86400000).toISOString().slice(0,10);
      const sourceDay=c.conflictDays.find(d=>d>=fromDay&&d<=day);
      const witness=sourceWitnesses.find(w=>w.day===sourceDay&&w.stream==="usage");
      witness.nativePages.push({modelDay:day,checkpointMethod:"synthetic-effective-model-checkpoint-1",dependencyDigest:sha(["dependency",day]),
        keyDigest:sha(["key",day]),headDigest:sha(["head",day]),cursorSha256:sha(["cursor",sourceDay,day]),pageSha256:sha(["canonical-page",sourceDay])});
    }
    const windowProofs = affected.map(day => {
      const fromDay = new Date(Date.parse(day)-100*86400000).toISOString().slice(0,10);
      return {owner:"a",day,fromDay,throughDay:day,reason:"source_window_conflict",derivation:"current-canonical-reader-window-predicate",
        sourceWindowSha256:sha(["source-window",day]),sourceWitnessSha256:sourceWitnesses.filter(w=>w.day>=fromDay&&w.day<=day).map(sha)};
    });
    const conflictProofs = affected.map(day => {
      const witness=sourceWitnesses.find(w=>w.stream==="usage"&&w.nativePages.some(page=>page.modelDay===day));
      const page=witness.nativePages.find(page=>page.modelDay===day);
      const proof={ schemaVersion:S.conflict,caseId,bindingSha256,
      scope:{owner:"a",metric:"model",day,sourceKind:"effective",dependencyDigest:sha(["dependency",day]),keyDigest:sha(["key",day]),
        headDigest:page.headDigest,cursorSha256:page.cursorSha256,checkpointMethod:page.checkpointMethod},
      origin:{label:"effective_history_guard_544",moduleSha256:sourceSha("apps/worker/src/storage-effective-history.ts"),originProofSha256:H("b"),factoryLine:26,guardLine:544,observerSha256:sourceSha("apps/worker/scripts/current-q1-conflict-proof.mjs")},
      reader:{method:"effective-telemetry-owner-day-v1",stream:"usage",pageSha256:page.pageSha256,sourceDay:witness.day,
        sourceWitnessSha256:sha(witness),associationSha256:null,rows:9,compatibleRows:8,conflictRows:1,
        compatibleRowsValid:true,conflictRecordJsonNull:true,conflictEventTimeNull:true,cursorMatched:true},
      fences:{authorityBeforeSha256:H("d"),authorityAfterSha256:H("d"),sourceBeforeSha256:source,sourceAfterSha256:source} };
      proof.reader.associationSha256=currentQ1D7ConflictAssociationSha256(proof,witness);return proof;
    });
    const ownerEvidence = OWNERS.flatMap(owner => DAYS.map(day => {
      const conflict = owner === "a" && affected.includes(day), proof = conflictProofs.find(p=>p.scope.day===day), window = windowProofs.find(p=>p.day===day);
      return {owner,day,classification:conflict ? "refused":"fitted",resultSha256:conflict?null:sha([caseId,owner,day]),reason:null,
        windowProofSha256:conflict?sha(window):null,conflictProofSha256:conflict?sha(proof):null};
    }));
    const modelDays = DAYS.map(day => ({day,catalogVersion:ADMIN_MODEL_HISTORY_CATALOG_VERSION,
      values:[["gpt-5.6-sol",10,affected.includes(day)?3:4]],fittedParticipantCount:affected.includes(day)?3:4,
      unstableParticipantCount:0,staleParticipantCount:0,refusedParticipantCount:affected.includes(day)?1:0,v1ParticipantCount:4,unsupportedSourceParticipantCount:0}));
    const expectation = { schemaVersion:S.expectation,caseId,bindingSha256,derivation:"current-canonical-reader-reducer-factories",
      producedBeforeCandidate:true,candidateInputs:false,ownerEvidenceSha256:sha(ownerEvidence),days:modelDays,ownerEvidence,
      sourceWitnesses,windowProofs,sourceConflictProofs:conflictProofs,unresolved:[] };
    const nativeEvidence = ownerEvidence.map(e => ({owner:e.owner,metric:"model",day:e.day,state:e.conflictProofSha256 ? "expected_source_conflict":"complete",
      invocations:1,verifiedSha256:e.resultSha256,reason:null,proofSha256:e.conflictProofSha256}));
    const publicationInventory = DAYS.map(day=>({day,state:affected.includes(day)?"withheld":"published",sha256:affected.includes(day)?null:sha(["published",day])}));
    pgInputs[caseId] = {schemaVersion:"current-q1-d7-pg-case-input-v1",corpusCaseId:c.corpusCaseId,corpusSha256:c.corpusSha256,
      admissionSha256:c.admissionSha256,sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,sourceInvariantSha256:source,
      selectionSha256:sha(["selection",caseId]),fenceSha256:sha(["fence",caseId]),
      ingestion:{path:`/private/tmp/synthetic-${caseId}/ingestion.sqlite`,sha256:sha(["ingestion",caseId]),bytes:4096},
      journal:{path:`/private/tmp/synthetic-${caseId}/journal.sqlite`,sha256:sha(["journal",caseId]),bytes:4096}};
    const capture={fullSourceCaptureSha256:sha(["full-capture",caseId]),sourceInvariantSha256:source,schemaSha256:H("a"),rawAdmissionsSha256:null,
      nonOperationalTablesSha256:H("b"),controlsSha256:H("c"),auditSha256:H("d"),otherSequencesSha256:H("e")};
    const bootstrapPreservation={schemaVersion:"current-q1-d7-bootstrap-preservation-v1",actual:true,caseId,bindingSha256,admissionSha256:c.admissionSha256,
      sourceModuleSha256:sourceSha("apps/worker/src/community-daily-aggregates.ts"),operation:"drainCommunityPublicSourceBootstrap",iterations:1,pageSize:32,completed:true,beforeCompleted:true,
      before:structuredClone(capture),after:structuredClone(capture),operationalTables:[],queueSequence:null};
    for(const cap of [bootstrapPreservation.before,bootstrapPreservation.after])cap.rawAdmissionsSha256=currentQ1D7BootstrapRawAdmissionsSha256(bootstrapPreservation,cap);
    for(const table of ["community_public_source_bootstrap","community_daily_aggregate_rebuilds","community_current_analysis_queue"]){
      const entry={table,beforeSha256:sha(["table",table]),afterSha256:sha(["table",table]),transitionProofSha256:null,transitionVerified:true};
      entry.transitionProofSha256=currentQ1D7BootstrapTransitionSha256(bootstrapPreservation,entry);bootstrapPreservation.operationalTables.push(entry);
    }
    bootstrapPreservation.queueSequence={table:"community_current_analysis_queue",before:4,after:4,transitionProofSha256:null,transitionVerified:true};
    bootstrapPreservation.queueSequence.transitionProofSha256=currentQ1D7BootstrapTransitionSha256(bootstrapPreservation,
      {table:"sqlite_sequence:community_current_analysis_queue",beforeSha256:sha(4),afterSha256:sha(4)});
    const exportContext={sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,pinnedNowMs:binding.runtime.pinnedNowMs,
      sourceInvariantSha256:source,sourceModuleSha256:sourceSha("apps/worker/src/d1-analytics-export-oracle.ts"),cohortMembers:4,cohortSha256:H("b"),fenceSha256:H("c"),selectionSha256:H("d")};
    const refusalProof=caseId===CASES[0]?{schemaVersion:"current-q1-d1-strict-export-refusal-v1",actual:true,code:"ANALYTICS_EXPORT_NOT_QUIESCENT",reasons:["queue_rows"],queueRows:2}:null;
    const successProof=caseId===CASES[1]?{schemaVersion:"current-q1-d7-oracle-success-v1",actual:true,oracleSchema:"analytics-history-oracle-v2",oracleSha256:H("e"),
      moduleDigest:binding.source.sha256,context:structuredClone(exportContext),quiescence:{queueRows:0,staleHeadIdle:true,cursorSequence:1,journalMax:1,
        deliveredTerminal:0,sourceTerminal:0,pendingErasureJobs:0,cacheRetentionIncompleteDays:0}}:null;
    const strictExport={schemaVersion:"current-q1-d7-strict-export-proof-v1",actual:true,caseId,bindingSha256,state:caseId===CASES[0]?"expected_conflict_refusal":"successful",
      context:exportContext,queuedRows:caseId===CASES[0]?2:0,orderedQueueDays:[...c.conflictDays],queueReceiptSha256:null,
      steps:caseId===CASES[0]?["fence"]:["fence","quiescence","cohort","selection","cache_retention_resume","daily_forced","graph_forced","cache_retention_rebuild"],
      refusalProof,successProof,receiptSha256:sha(refusalProof??successProof)};
    strictExport.queueReceiptSha256=currentQ1D7ExportQueueReceiptSha256(strictExport);
    const snapshot = {publicResponse:{status:200,body:{schemaVersion:"synthetic-structural-response",days:[]}},adminPreview:{schemaVersion:"synthetic-structural-preview"}};
    cases[caseId] = {schemaVersion:S.reference,caseId,bindingSha256,sourceInvariantSha256:{before:source,after:source},admissionSha256:c.admissionSha256,
      graphDays:[...DAYS],publicationInventory,nativeEvidence,conflictProofs,currentFits:OWNERS.map(owner=>({owner,state:"complete",verifiedSha256:sha(["fits",owner])})),
      strictExport,bootstrapPreservation,
      state:"complete",unresolved:[],snapshot,snapshotSha256:sha(snapshot),pgInputSha256:sha(pgInputs[caseId])};
    expectations[caseId]=expectation;expectationSha256[caseId]=sha(expectation);
  }
  const expectedController={path:"apps/worker/scripts/gcp-fastpath-rehearsal.mjs",sha256:sourceSha("apps/worker/scripts/gcp-fastpath-rehearsal.mjs",H("f"))};
  const acceptance={schemaVersion:S.acceptance,evidenceScope:"direct-source-pinned-producer-controller",cryptographicExecutionAttestation:false,
    actualHelperInvocation:true,resultReturnedAfterOwnedCleanup:true,accepted:true,bindingSha256,inputBindingSha256:sha(inputBinding),sourceHead:binding.source.head,sourceSha256:binding.source.sha256,
    controller:structuredClone(expectedController),caseReceipts:Object.fromEntries(CASES.map(caseId=>[caseId,{referenceSha256:sha(cases[caseId]),expectationSha256:expectationSha256[caseId],
      corpusSha256:binding.cases[caseId].corpusSha256,admissionSha256:binding.cases[caseId].admissionSha256,sourceInvariantSha256:binding.cases[caseId].sourceInvariantSha256,pgInputSha256:sha(pgInputs[caseId]),bootstrapPreservationSha256:sha(cases[caseId].bootstrapPreservation),strictExportSha256:sha(cases[caseId].strictExport)}]))};
  return {inputBinding,binding,cases,expectations,expectationSha256,pgInputs,expectedController,acceptance};
}
const validateExpectation=f=>validateCurrentQ1D7PerDateExpectation(f.expectations.conflictPreserving,f.binding,{expectedSha256:f.expectationSha256.conflictPreserving});
const validateCase=(f,id="conflictPreserving")=>validateCurrentQ1D7CaseReference(f.cases[id],f.binding,{expectation:f.expectations[id],expectedExpectationSha256:f.expectationSha256[id]});
const assessment=f=>assessCurrentQ1D7Qualification(f);

test("both exact cases are structurally complete and saved evidence never establishes execution",()=>{
  const f=currentQ1D7SyntheticFixture(); assert.equal(validateCurrentQ1D7Binding(f.binding),f.binding);
  for(const id of CASES)assert.equal(validateCase(f,id),f.cases[id]);
  assert.deepEqual(assessment(f),{state:"structurally_complete",establishesNativeExecution:false,reasons:[]});
  assert.equal(validateCurrentQ1D7ProducerAcceptance(f.acceptance,f).establishesNativeExecution,false);
});
test("the exact five pre-existing normalizations remain the full allowlist",()=>assert.deepEqual(CURRENT_Q1_D7_NORMALIZATIONS,
  ["days[].revision","days[].releasedAt","payload.revision","payload.releasedAt","payload.aggregateId :r<revision> suffix"]));
test("binding rejects topology reduction, altered limits, runtime drift, same corpus and extra keys",async t=>{
  const mutations=[f=>delete f.binding.cases.conflictFreePositive,f=>f.binding.cases.conflictFreePositive.sourceDays--,
    f=>f.binding.cases.conflictPreserving.recordCount--,f=>f.binding.cases.conflictFreePositive.owners.pop(),
    f=>f.binding.cases.conflictFreePositive.modelDays.pop(),f=>f.binding.bounds.nativeQueries++,f=>f.binding.bounds.s9DeadlineMs++,
    f=>f.binding.runtime.binarySha256=H("0"),f=>f.binding.cases.conflictFreePositive.corpusSha256=f.binding.cases.conflictPreserving.corpusSha256,
    f=>f.binding.privateRows=[]];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid);});
});
test("conflict proof rejects wrong guard, malformed-compatible evidence, fence/cursor drift and unrelated owner",async t=>{
  const mutations=[p=>p.origin.guardLine=509,p=>p.origin.moduleSha256=H("0"),p=>p.reader.compatibleRowsValid=false,
    p=>p.reader.cursorMatched=false,p=>p.reader.conflictRows=0,p=>p.reader.conflictRecordJsonNull=false,p=>p.reader.conflictEventTimeNull=false,
    p=>p.fences.authorityAfterSha256=H("0"),p=>p.fences.sourceAfterSha256=H("0"),p=>p.scope.owner="b",p=>p.stack="private"];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture(),p=structuredClone(f.cases.conflictPreserving.conflictProofs[0]);mutate(p);assert.throws(()=>validateCurrentQ1D7SourceConflictProof(p,f.binding,{sourceWitnesses:f.expectations.conflictPreserving.sourceWitnesses,windowProofs:f.expectations.conflictPreserving.windowProofs}),invalid);});
});
test("expectations forbid candidate-derived inputs and require the independent pre-candidate digest",async t=>{
  const mutations=[f=>f.expectations.conflictPreserving.derivation="computeAnalyticsV2",f=>f.expectations.conflictPreserving.derivation="ownerRefusals",
    f=>f.expectations.conflictPreserving.derivation="rehearsal",f=>f.expectations.conflictPreserving.candidateInputs=true,
    f=>f.expectations.conflictPreserving.producedBeforeCandidate=false,f=>delete f.expectationSha256.conflictPreserving,
    f=>f.expectations.conflictPreserving.days[0].refusedParticipantCount++,f=>f.expectations.conflictPreserving.ownerEvidence[0].reason="incomplete_window"];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);assert.throws(()=>validateExpectation(f),invalid);});
  const f=currentQ1D7SyntheticFixture(),before=sha(f.expectations.conflictPreserving);
  const candidate={ownerRefusals:[{reason:"incomplete_window",count:999}],response:{refusedParticipantCount:999}};
  candidate.ownerRefusals[0].count=0;candidate.response.refusedParticipantCount=0;
  assert.equal(sha(f.expectations.conflictPreserving),before);validateExpectation(f);
});
test("source and window witnesses reject incomplete pagination, malformed compatible rows and inferred reason",async t=>{
  const mutations=[f=>f.expectations.conflictPreserving.sourceWitnesses.pop(),f=>f.expectations.conflictPreserving.sourceWitnesses[0].complete=false,
    f=>f.expectations.conflictPreserving.sourceWitnesses[0].cursorOrderValid=false,f=>f.expectations.conflictPreserving.sourceWitnesses[0].compatibleRowsValid=false,
    f=>f.expectations.conflictPreserving.windowProofs[0].fromDay="2026-04-17",f=>f.expectations.conflictPreserving.windowProofs[0].reason="incomplete_window",
    f=>f.expectations.conflictPreserving.sourceConflictProofs[0].origin.label="generic_application_error"];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);f.expectationSha256.conflictPreserving=sha(f.expectations.conflictPreserving);assert.throws(()=>validateExpectation(f),invalid);});
});
test("case coverage refuses unknown, deferred, capacity or fabricated missing publication outcomes",async t=>{
  const mutations=[f=>f.cases.conflictFreePositive.nativeEvidence.pop(),f=>f.cases.conflictFreePositive.publicationInventory[0]={day:DAYS[0],state:"withheld",sha256:null},
    f=>f.cases.conflictPreserving.nativeEvidence[0].state="deferred",f=>f.cases.conflictPreserving.nativeEvidence[0].state="refused",
    f=>f.cases.conflictPreserving.nativeEvidence[0].reason="d1_timeout",f=>f.cases.conflictPreserving.nativeEvidence[0].invocations=129,
    f=>f.cases.conflictPreserving.publicationInventory[4]={day:DAYS[4],state:"withheld",sha256:null},
    f=>f.cases.conflictFreePositive.strictExport.state="expected_conflict_refusal",f=>f.cases.conflictFreePositive.sourceInvariantSha256.after=H("0"),
    f=>f.cases.conflictFreePositive.currentFits[0].state="not_testable",f=>f.cases.conflictPreserving.nativeEvidence[5].verifiedSha256=H("0")];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);assert.equal(assessment(f).state,"unresolved");});
  const f=currentQ1D7SyntheticFixture();delete f.cases.conflictFreePositive;assert.equal(assessment(f).state,"unresolved");
});
test("all-refused canonical day uses independently fixed counts and no zero capacity",()=>{
  const f=currentQ1D7SyntheticFixture(),id="conflictFreePositive",day=DAYS[0];
  const fixed={day,catalogVersion:ADMIN_MODEL_HISTORY_CATALOG_VERSION,values:[],fittedParticipantCount:0,unstableParticipantCount:0,
    staleParticipantCount:0,refusedParticipantCount:4,v1ParticipantCount:4,unsupportedSourceParticipantCount:0};
  f.expectations[id].days[0]=fixed;
  for(const e of f.expectations[id].ownerEvidence.filter(e=>e.day===day)){e.classification="refused";e.reason="supported_quota_track_unavailable";}
  for(const e of f.cases[id].nativeEvidence.filter(e=>e.day===day)){e.state="not_testable";e.reason="supported_quota_track_unavailable";}
  f.expectations[id].ownerEvidenceSha256=sha(f.expectations[id].ownerEvidence);f.expectationSha256[id]=sha(f.expectations[id]);
  validateCase(f,id);assert.deepEqual(f.expectations[id].days[0],fixed);
  const tampered=structuredClone(fixed);tampered.values=[["gpt-5.6-sol",0,4]];f.expectations[id].days[0]=tampered;
  f.expectationSha256[id]=sha(f.expectations[id]);assert.throws(()=>validateCase(f,id),invalid);
});
test("controller acceptance binds both exact case receipts and retains no execution-attestation claim",async t=>{
  const mutations=[f=>delete f.acceptance.caseReceipts.conflictFreePositive,f=>f.acceptance.actualHelperInvocation=false,
    f=>f.acceptance.resultReturnedAfterOwnedCleanup=false,f=>f.acceptance.cryptographicExecutionAttestation=true,
    f=>f.acceptance.caseReceipts.conflictPreserving.expectationSha256=H("0"),f=>f.acceptance.caseReceipts.conflictFreePositive.referenceSha256=H("0"),
    f=>f.acceptance.controller.sha256=H("0"),f=>f.acceptance.sourceHead="0".repeat(40),f=>f.acceptance.candidateOutput={}];
  for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);assert.throws(()=>validateCurrentQ1D7ProducerAcceptance(f.acceptance,f),invalid);});
});

test("owner-only per-case PG input descriptors cannot cross corpus/fence/file associations",async t=>{
 const mutations=[p=>p.corpusCaseId="conflictFreePositive",p=>p.corpusSha256=H("0"),p=>p.admissionSha256=H("0"),
  p=>p.sourceInvariantSha256=H("0"),p=>p.ingestion.path="relative.sqlite",p=>p.journal.path=p.ingestion.path,
  p=>p.journal.path="/private/tmp/foreign/journal.sqlite",p=>p.ingestion.bytes=0,p=>p.rawRows=[]];
 for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture(),p=f.pgInputs.conflictPreserving;
  mutate(p);assert.throws(()=>validateCurrentQ1D7PgCaseInput(p,f.binding,"conflictPreserving"),invalid);});
 const f=currentQ1D7SyntheticFixture();assert.throws(()=>validateCurrentQ1D7PgCaseInput(f.pgInputs.conflictPreserving,f.binding,"conflictPreserving",
  {expectedDirectory:"/private/tmp/foreign"}),invalid);delete f.pgInputs.conflictFreePositive;assert.equal(assessment(f).state,"unresolved");
});

test("two-stage capture adds only actual post-admission invariants while preserving every static pin",()=>{
 const f=currentQ1D7SyntheticFixture(),initial=structuredClone(f.binding);initial.schemaVersion=S.inputBinding;
 for(const id of CASES)delete initial.cases[id].sourceInvariantSha256;
 validateCurrentQ1D7InputBinding(initial);validateCurrentQ1D7Binding(f.binding,initial);
 const changed=structuredClone(f.binding);changed.cases.conflictFreePositive.admissionSha256=H("0");
 assert.throws(()=>validateCurrentQ1D7Binding(changed,initial),invalid);
 const guessed=structuredClone(initial);guessed.cases.conflictPreserving.sourceInvariantSha256=H("0");
 assert.throws(()=>validateCurrentQ1D7InputBinding(guessed),invalid);
});
test("current public projection has69 exact dates and excludes pinned today without reducing70-model coverage",()=>{
 const f=currentQ1D7SyntheticFixture();assert.deepEqual(currentQ1D7PublicDays(f.binding),DAYS.slice(0,-1));
 assert.equal(currentQ1D7GraphDays().length,70);assert.equal(currentQ1D7PublicDays(f.binding).length,69);
 assert.equal(currentQ1D7PublicDays(f.binding).includes("2026-10-01"),false);
});

test("acceptance requires independently captured initial pins and canonical controller closure entry",async t=>{
 const mutations=[f=>delete f.inputBinding,f=>delete f.acceptance.inputBindingSha256,f=>f.inputBinding.source.head="0".repeat(40),
  f=>f.inputBinding.cases.conflictFreePositive.corpusSha256=H("0"),
  f=>{f.binding.source.head="0".repeat(40);f.acceptance.sourceHead=f.binding.source.head;},
  f=>{const pin=f.binding.source.files.find(p=>p.path==="apps/worker/scripts/gcp-fastpath-rehearsal.mjs");pin.sha256=H("0");
    f.binding.source.sha256=sha(f.binding.source.files);f.acceptance.controller.sha256=H("0");f.expectedController.sha256=H("0");},
  f=>f.acceptance.controller.path="apps/worker/postgres-test/fixtures/current-q1-d7-reference.mjs",
  f=>{f.acceptance.controller.sha256=H("0");f.expectedController.sha256=H("0");}];
 for(const[i,mutate]of mutations.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture();mutate(f);assert.throws(()=>validateCurrentQ1D7ProducerAcceptance(f.acceptance,f),invalid);});
 const absent=currentQ1D7SyntheticFixture({controllerInSource:false});assert.throws(()=>validateCurrentQ1D7ProducerAcceptance(absent.acceptance,absent),invalid);
});
test("native page swaps across source days/windows fail even with recomputed outer evidence hashes",async t=>{
 for(const swap of ["source-day","model-window","page-digest"])await t.test(swap,()=>{
  const f=currentQ1D7SyntheticFixture(),id="conflictPreserving",original=f.cases[id].conflictProofs[0],donor=f.cases[id].conflictProofs.at(-1);
  const altered=structuredClone(original);
  if(swap==="source-day")Object.assign(altered.reader,{sourceDay:donor.reader.sourceDay,sourceWitnessSha256:donor.reader.sourceWitnessSha256,pageSha256:donor.reader.pageSha256});
  else if(swap==="model-window")altered.scope.cursorSha256=donor.scope.cursorSha256;
  else altered.reader.pageSha256=donor.reader.pageSha256;
  const witness=f.expectations[id].sourceWitnesses.find(w=>w.stream==="usage"&&w.day===altered.reader.sourceDay);
  altered.reader.associationSha256=currentQ1D7ConflictAssociationSha256(altered,witness);
  assert.throws(()=>validateCurrentQ1D7SourceConflictProof(altered,f.binding,{sourceWitnesses:f.expectations[id].sourceWitnesses,windowProofs:f.expectations[id].windowProofs}),invalid);
  const old=sha(original),updated=sha(altered);f.cases[id].conflictProofs[0]=altered;f.expectations[id].sourceConflictProofs[0]=altered;
  for(const e of f.cases[id].nativeEvidence)if(e.proofSha256===old)e.proofSha256=updated;
  for(const e of f.expectations[id].ownerEvidence)if(e.conflictProofSha256===old)e.conflictProofSha256=updated;
  f.expectations[id].ownerEvidenceSha256=sha(f.expectations[id].ownerEvidence);f.expectationSha256[id]=sha(f.expectations[id]);
  f.acceptance.caseReceipts[id].referenceSha256=sha(f.cases[id]);f.acceptance.caseReceipts[id].expectationSha256=f.expectationSha256[id];
  assert.equal(assessment(f).state,"unresolved");
 });
});

test("bootstrap preserves the complete source around exact canonical operational transitions",async t=>{
 const changes=[p=>p.before.rawAdmissionsSha256=H("0"),p=>p.after.schemaSha256=H("0"),p=>p.after.controlsSha256=H("0"),
  p=>p.after.auditSha256=H("0"),p=>p.after.otherSequencesSha256=H("0"),p=>p.after.nonOperationalTablesSha256=H("0"),
  p=>p.operationalTables[0].table="telemetry_v11_records",p=>p.operationalTables[0].transitionVerified=false,
  p=>p.queueSequence.table="admin_action_audit",p=>p.queueSequence.after=5,p=>p.after.fullSourceCaptureSha256=H("0"),
  p=>p.iterations=65,p=>p.actual=false,p=>p.before.extraTableWaiver=true];
 for(const[i,mutate]of changes.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture(),p=f.cases.conflictPreserving.bootstrapPreservation;mutate(p);
  assert.throws(()=>validateCurrentQ1D7BootstrapPreservation(p,f.binding,"conflictPreserving"),invalid);});
 const f=currentQ1D7SyntheticFixture(),p=f.cases.conflictPreserving.bootstrapPreservation;
 p.beforeCompleted=false;p.before.fullSourceCaptureSha256=H("1");p.before.sourceInvariantSha256=H("2");p.operationalTables[0].beforeSha256=H("3");
 p.operationalTables[0].transitionProofSha256=currentQ1D7BootstrapTransitionSha256(p,p.operationalTables[0]);
 validateCurrentQ1D7BootstrapPreservation(p,f.binding,"conflictPreserving");
});
test("negative strict export requires original exact two-date queue refusal and no later callback",async t=>{
 const changes=[p=>p.queuedRows=1,p=>p.orderedQueueDays=["2026-04-17","2026-04-19"],p=>p.orderedQueueDays.reverse(),
  p=>p.refusalProof.reasons=["stale_head"],p=>p.refusalProof.queueRows=3,p=>p.refusalProof.actual=false,p=>p.steps.push("quiescence"),
  p=>p.actual=false,p=>p.receiptSha256=H("0"),p=>p.queueReceiptSha256=H("0"),p=>p.context.sourceInvariantSha256=H("0"),
  p=>p.context.sourceId="foreign",p=>p.context.cohortMembers=3,p=>p.successProof={}];
 for(const[i,mutate]of changes.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture(),p=f.cases.conflictPreserving.strictExport;mutate(p);
  assert.throws(()=>validateCurrentQ1D7StrictExportProof(p,f.binding,"conflictPreserving"),invalid);});
});
test("positive strict export requires actual successful oracle context/quiescence and zero queue",async t=>{
 const changes=[p=>p.queuedRows=2,p=>p.orderedQueueDays=["2026-04-17"],p=>p.refusalProof={schemaVersion:"current-q1-d1-strict-export-refusal-v1"},
  p=>p.successProof=null,p=>p.successProof.actual=false,p=>p.successProof.oracleSha256="unknown",p=>p.successProof.moduleDigest=H("0"),
  p=>p.successProof.context.fenceSha256=H("0"),p=>p.successProof.quiescence.pendingErasureJobs=1,p=>p.successProof.quiescence.cursorSequence=2,
  p=>p.successProof.quiescence.queueRows=1,p=>p.steps.pop(),p=>p.context.selectionSha256="unknown"];
 for(const[i,mutate]of changes.entries())await t.test(String(i),()=>{const f=currentQ1D7SyntheticFixture(),p=f.cases.conflictFreePositive.strictExport;mutate(p);
  assert.throws(()=>validateCurrentQ1D7StrictExportProof(p,f.binding,"conflictFreePositive"),invalid);});
});
test("bootstrap and strict export proofs are bound into each accepted case receipt",()=>{
 const f=currentQ1D7SyntheticFixture();delete f.acceptance.caseReceipts.conflictPreserving.bootstrapPreservationSha256;
 assert.throws(()=>validateCurrentQ1D7ProducerAcceptance(f.acceptance,f),invalid);
 const g=currentQ1D7SyntheticFixture();g.acceptance.caseReceipts.conflictFreePositive.strictExportSha256=H("0");
 assert.throws(()=>validateCurrentQ1D7ProducerAcceptance(g.acceptance,g),invalid);
});

test("source-verified limit units preserve every original number without a cross-call query cap",()=>{
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeQueries,900);assert.equal(CURRENT_Q1_D7_BOUNDS.nativeInvocations,128);
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeStall,8);assert.equal(CURRENT_Q1_D7_BOUNDS.nativeProductionDeadlineMs,20000);
 assert.equal(CURRENT_Q1_D7_BOUNDS.diagnosticDeadlineMs,30000);assert.equal(CURRENT_Q1_D7_BOUNDS.s9DeadlineMs,2400000);
 assert.equal(CURRENT_Q1_D7_BOUNDS.rootDeadlineMs,10800000);
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeQueryBudgetScope,"per_compute_storage_graph_result_invocation_source_plus_target");
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeInvocationBudgetScope,"per_owner_metric_day_scope");
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeStallBudgetScope,"consecutive_per_owner_metric_day_scope");
 assert.equal(CURRENT_Q1_D7_BOUNDS.diagnosticDeadlineScope,"per_observed_diagnostic_invocation_wall_clock");
 assert.equal(CURRENT_Q1_D7_BOUNDS.s9DeadlineScope,"one_controller_child_both_cases_all_phases_wall_clock");
 const f=currentQ1D7SyntheticFixture();f.binding.bounds.nativeQueryBudgetScope="whole_two_case_fixture";
 assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid);
});
test("full-closure source paths accept exact root locks and reviewed scoped package copies",()=>{
 for(const path of ["package.json","pnpm-lock.yaml","apps/worker/node_modules/@app-usagemonitor/accounting/src/index.js",
  "apps/worker/node_modules/@app-usagemonitor/quota-analysis/index.d.ts",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/schemas/telemetry-v1.2.schema.json",
  "apps/worker/src/analytics-v2/kernel-vocabularies.generated.ts"])assert.equal(validCurrentQ1D7SourcePath(path),true,path);
 validateCurrentQ1D7Binding(currentQ1D7SyntheticFixture().binding);
});
test("source paths refuse traversal, foreign packages/scopes, absolute/env/private generated inputs",()=>{
 for(const path of ["../package.json","/package.json","./package.json","package-lock.json","apps/worker/../private/key.json",
  "apps/worker/node_modules/@other/telemetry-contract/index.js","apps/worker/node_modules/@app-usagemonitor/unknown/index.js",
  "apps/worker/node_modules/@app-usagemonitor/accounting/../../secret.json","apps/worker/node_modules/@app-usagemonitor/accounting/.env",
  "apps/worker/.dev.vars","apps/worker/.env.production","apps/worker/private/proof.json","apps/worker/generated-inputs/history.json",
  "packages/telemetry-contract/src//index.js","apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/../index.js",
  "apps/worker/node_modules/zod/index.js","apps/worker/node_modules/@app-usagemonitor/accounting/node_modules/zod/index.js","apps/worker/node_modules/@app-usagemonitor/accounting/%2e%2e/secret.json"])
  assert.equal(validCurrentQ1D7SourcePath(path),false,path);
});
test("missing DTO authority or a stale copied catalog cannot enter the bound closure",()=>{
 const f=currentQ1D7SyntheticFixture();f.binding.source.files=f.binding.source.files.filter(p=>p.path!=="apps/worker/src/analytics-v2/interim-public-read.ts");
 f.binding.source.sha256=sha(f.binding.source.files);assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid);
 const g=currentQ1D7SyntheticFixture();g.binding.source.files.find(p=>p.path==="apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog.js").sha256=H("0");
 g.binding.source.sha256=sha(g.binding.source.files);assert.throws(()=>validateCurrentQ1D7Binding(g.binding),invalid);
});


test("V5 source closure refuses audited hidden and case-variant credential paths",()=>{
 for(const path of ["apps/worker/.aws/credentials", "apps/worker/credentials/token", "apps/worker/Secrets/key.json",
  "apps/worker/.npmrc.local", "apps/worker/src/.aws/credentials", "apps/worker/src/Secrets/key.json",
  "apps/worker/src/CREDENTIALS/credential.json", "apps/worker/src/credentials.json", "apps/worker/src/token.json",
  "apps/worker/node_modules/@app-usagemonitor/accounting/src/Secrets/key.json",
  "packages/telemetry-contract/src/.hidden/module.js", "packages/telemetry-contract/schemas/PRIVATE/input.json",
  "scripts/.envrc", "src/raw-history/session.json", ".github/workflows/ci.yml"])
  assert.equal(validCurrentQ1D7SourcePath(path),false,path);
});
test("V5 source closure positively bounds Worker roots, public packages and exact configuration",()=>{
 for(const path of ["apps/worker/src/storage-effective-history.ts", "apps/worker/scripts/gcp-fastpath-rehearsal.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.mjs", "apps/worker/cloud-run/sealed-sqlite-d1-adapter.mjs",
  "apps/worker/test/helpers/telemetry-v11.ts", "apps/worker/migrations/0001_initial.sql",
  "apps/worker/typed-v11-admission-migrations/0001_initial.sql", "apps/worker/postgres/migrations/primary/0001_initial.sql",
  "apps/worker/vendor/analytics-d43c8f92/entry.ts", "packages/accounting/src/price-registry.js",
  "packages/quota-analysis/index.d.ts", "packages/telemetry-contract/scripts/sync-json-schemas.mjs",
  "apps/worker/wrangler.jsonc", "package.json", "pnpm-lock.yaml"])
  assert.equal(validCurrentQ1D7SourcePath(path),true,path);
 for(const path of ["apps/unknown/src/module.ts", "apps/worker/unknown/module.ts", "apps/worker/test/private.json",
  "packages/unknown/src/module.js", "packages/accounting/unknown/module.js", "apps/worker/unknown.json",
  "apps/worker/postgres/unknown/primary/0001.sql", "apps/worker/vendor/unknown/entry.ts",
  "apps/worker/node_modules/@app-usagemonitor/accounting/test/private.json", "apps/worker/src/history.sqlite",
  "apps/worker/src/key.pem", "apps/worker/src/Node_modules/foreign/module.ts",
  "apps/worker/cloud-run/Node_Modules/foreign/index.js", "packages/telemetry-contract/src/NODE_MODULES/foreign/index.js",
  "apps/worker/node_modules/@app-usagemonitor/accounting/src/NODE_MODULES/foreign/module.js", "package-lock.json", "tsconfig.json"])
  assert.equal(validCurrentQ1D7SourcePath(path),false,path);
});
test("V5 refused credential paths cannot enter a self-rehashed binding",()=>{
 for(const path of ["apps/worker/.aws/credentials", "apps/worker/credentials/token", "apps/worker/Secrets/key.json",
  "apps/worker/.npmrc.local", "apps/worker/src/Secrets/key.json", "packages/telemetry-contract/src/credentials.json"]){
  const f=currentQ1D7SyntheticFixture();f.binding.source.files.push({path,sha256:H("d")});
  f.binding.source.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  f.binding.source.sha256=sha(f.binding.source.files);
  assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid,path);
 }
});


test("V5 mandatory publication and allowance authority pins cannot be omitted",()=>{
 for(const path of ["apps/worker/src/public-allowance-breakdowns.ts", "apps/worker/src/storage-community-graph-publication.ts",
  "apps/worker/src/analytics-v2/allowance-projection.ts"]){
  const f=currentQ1D7SyntheticFixture();f.binding.source.files=f.binding.source.files.filter(p=>p.path!==path);
  f.binding.source.sha256=sha(f.binding.source.files);assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid,path);
 }
});
test("V5 all three installed public manifests and entrypoints must match their canonical bytes",()=>{
 for(const name of ["accounting", "quota-analysis", "telemetry-contract"])for(const file of ["package.json", "index.js"]){
  const path=`apps/worker/node_modules/@app-usagemonitor/${name}/${file}`;
  const f=currentQ1D7SyntheticFixture();f.binding.source.files.find(p=>p.path===path).sha256=H("0");
  f.binding.source.sha256=sha(f.binding.source.files);assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid,path);
  const g=currentQ1D7SyntheticFixture();g.binding.source.files=g.binding.source.files.filter(p=>p.path!==`packages/${name}/${file}`);
  g.binding.source.sha256=sha(g.binding.source.files);assert.throws(()=>validateCurrentQ1D7Binding(g.binding),invalid,path);
 }
});
test("V5 production and outer deadline units are exact ratchets",()=>{
 assert.equal(CURRENT_Q1_D7_BOUNDS.nativeProductionDeadlineScope,"per_compute_storage_graph_result_invocation_cooperative_clock");
 assert.equal(CURRENT_Q1_D7_BOUNDS.rootDeadlineScope,"one_complete_outer_gate_wall_clock");
 for(const [field,wrong] of [["nativeProductionDeadlineScope", "whole_two_case_wall_clock"], ["rootDeadlineScope", "per_case_wall_clock"]]){
  const f=currentQ1D7SyntheticFixture();f.binding.bounds[field]=wrong;
  assert.throws(()=>validateCurrentQ1D7Binding(f.binding),invalid,field);
 }
});
test("V5 code roots refuse arbitrary JSON/private data and non-source package directories",()=>{
 for(const path of ["apps/worker/src/key.json", "apps/worker/src/unreviewed.json", "apps/worker/scripts/input.json",
  "apps/worker/postgres-test/corpus.json", "apps/worker/cloud-run/receipt.json", "src/source.js", "scripts/source.mjs",
  "packages/accounting/schemas/key.schema.json", "packages/quota-analysis/scripts/loader.mjs",
  "apps/worker/node_modules/@app-usagemonitor/accounting/src/input.json"])
  assert.equal(validCurrentQ1D7SourcePath(path),false,path);
 for(const path of ["apps/worker/src/d1-provider-schema.json", "apps/worker/src/dogfood-sparkle-release-contract.json",
  "apps/worker/src/sparkle-release-contract.json", "apps/worker/src/analytics-v2/kernel-registry.json"])
  assert.equal(validCurrentQ1D7SourcePath(path),true,path);
});


const fixtureSourceMapInvalid={code:"CURRENT_Q1_D7_SYNTHETIC_SOURCE_MAP_INVALID"};
const fixtureSourceMap=()=>Object.fromEntries([
 ["apps/worker/src/storage-effective-history.ts",H("0")], ["apps/worker/scripts/current-q1-conflict-proof.mjs",H("1")],
 ["apps/worker/src/community-daily-aggregates.ts",H("2")], ["apps/worker/src/d1-analytics-export-oracle.ts",H("3")],
 ["apps/worker/scripts/gcp-fastpath-rehearsal.mjs",H("4")], ["apps/worker/src/canonical-json.ts",H("5")],
 ["apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/admin-model-history.js",H("6")],
 ["packages/telemetry-contract/src/admin-model-history.js",H("6")],
 ["apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog.js",H("7")],
 ["packages/telemetry-contract/src/model-catalog.js",H("7")]]);
test("V6 optional independent public source map reseals complete synthetic structures",()=>{
 const map=fixtureSourceMap(),before=structuredClone(map),f=currentQ1D7SyntheticFixture({sourceSha256ByPath:map});
 assert.deepEqual(map,before);assert.deepEqual(currentQ1D7SyntheticFixture({sourceSha256ByPath:Object.assign(Object.create(null),map)}),f);validateCurrentQ1D7InputBinding(f.inputBinding);validateCurrentQ1D7Binding(f.binding,f.inputBinding);
 for(const id of CASES){validateCase(f,id);assert.equal(f.expectations[id].bindingSha256,sha(f.binding));}
 assert.deepEqual(assessment(f),{state:"structurally_complete",establishesNativeExecution:false,reasons:[]});
 assert.equal(validateCurrentQ1D7ProducerAcceptance(f.acceptance,f).establishesNativeExecution,false);
 assert.equal(f.cases.conflictPreserving.conflictProofs[0].origin.moduleSha256,H("0"));
 assert.equal(f.cases.conflictPreserving.conflictProofs[0].origin.observerSha256,H("1"));
 assert.equal(f.cases.conflictPreserving.bootstrapPreservation.sourceModuleSha256,H("2"));
 assert.equal(f.cases.conflictFreePositive.strictExport.context.sourceModuleSha256,H("3"));
 assert.equal(f.expectedController.sha256,H("4"));
 assert.equal(f.acceptance.inputBindingSha256,sha(f.inputBinding));
});
test("V6 source map preserves every supplied closure leaf in both initial and final bindings",()=>{
 const map=fixtureSourceMap(),f=currentQ1D7SyntheticFixture({sourceSha256ByPath:map});
 const expected=CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS.map(path=>({path,sha256:map[path]??(path==="apps/worker/scripts/gcp-fastpath-rehearsal.mjs"?H("f"):H("a"))}));
 for(const [path,sha256]of Object.entries(map))if(!expected.some(file=>file.path===path))expected.push({path,sha256});
 expected.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 assert.deepEqual(f.binding.source.files,expected);assert.deepEqual(f.inputBinding.source,f.binding.source);
 assert.equal(f.binding.source.sha256,sha(expected));
 assert.equal(f.acceptance.sourceSha256,sha(expected));
});
test("V6 absent optional map retains default fixtures and does not alter missing-controller fixture",()=>{
 assert.deepEqual(currentQ1D7SyntheticFixture(),currentQ1D7SyntheticFixture({sourceSha256ByPath:undefined}));
 assert.equal(sha(currentQ1D7SyntheticFixture()),"d55643cd08f84e95e8486c3d50f2756730f88d114ecf4f4ba9b4ef6bdb6420e3");
 assert.equal(sha(currentQ1D7SyntheticFixture({controllerInSource:false})),"bf3cc187a6724af9e64695b9b0a1bf6c5ecba6566fb8421f8ef41bb7e85bd5bd");
 assert.deepEqual(currentQ1D7SyntheticFixture({controllerInSource:false}),currentQ1D7SyntheticFixture({controllerInSource:false,sourceSha256ByPath:undefined}));
 assert.throws(()=>currentQ1D7SyntheticFixture({controllerInSource:false,sourceSha256ByPath:fixtureSourceMap()}),fixtureSourceMapInvalid);
});
test("V6 synthetic source map rejects malformed maps, hashes, paths, hidden descriptors and accessors",()=>{
 const getter={};Object.defineProperty(getter,"apps/worker/src/canonical-json.ts",{enumerable:true,get(){throw Error("must not be read");}});
 const hidden={};Object.defineProperty(hidden,"apps/worker/src/canonical-json.ts",{enumerable:false,value:H("1")});
 const symbolic={ [Symbol("source")]:H("1") };
 const mixedHidden={"apps/worker/src/canonical-json.ts":H("1")};Object.defineProperty(mixedHidden,"apps/worker/src/crypto.ts",{enumerable:false,value:H("2")});
 for(const map of [null,[],new Map(),{},Object.create({"apps/worker/src/canonical-json.ts":H("1")}),
  {"apps/worker/src/canonical-json.ts":"A".repeat(64)},{"apps/worker/src/canonical-json.ts":1},
  {"apps/worker/.aws/credentials":H("1")},{"apps/worker/src/../canonical-json.ts":H("1")},
  {"apps/worker/node_modules/@other/telemetry-contract/index.js":H("1")},getter,hidden,mixedHidden,symbolic,
  {"apps/worker/src/canonical-json.ts":new String(H("1"))}])
  assert.throws(()=>currentQ1D7SyntheticFixture({sourceSha256ByPath:map}),fixtureSourceMapInvalid);
});
test("V6 map freshness still fails closed when only one required public-copy side is replaced",()=>{
 const f=currentQ1D7SyntheticFixture({sourceSha256ByPath:{"packages/telemetry-contract/src/admin-model-history.js":H("0")}});
 assert.throws(()=>validateCurrentQ1D7Binding(f.binding,f.inputBinding),invalid);
});

test("V6 supplied source map cannot overflow the final merged closure bound",()=>{
 const map=Object.fromEntries(Array.from({length:10000},(_,n)=>[`apps/worker/src/source-map-extra-${n}.ts`,H("1")]));
 assert.throws(()=>currentQ1D7SyntheticFixture({sourceSha256ByPath:map}),fixtureSourceMapInvalid);
});
