import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeToolMechanisms,
  renderToolMechanismReport,
} from "../src/tool-mechanism-analysis.js";
import { stableJson } from "../src/storage.js";

const REQUIRED_CLASSES = [
  "web_search",
  "file_search",
  "code_interpreter",
  "hosted_shell",
  "computer_use",
  "mcp",
  "local_shell",
  "apply_patch",
  "subagent",
];

function analyze({ clientToolEvents = [], pairedPilotResults = [], officialBillingEvidence = [], assessedToolClasses = [] } = {}) {
  return analyzeToolMechanisms({ clientToolEvents, pairedPilotResults, officialBillingEvidence, assessedToolClasses });
}

function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(walk)];
}

function classRecord(result, toolClass) {
  assert.ok(result.classes && typeof result.classes === "object", "analysis must return records by safe aggregate tool class");
  assert.ok(result.classes[toolClass], `missing required class ${toolClass}`);
  return result.classes[toolClass];
}

function assertNoPrivateSourceFields(value) {
  const text = stableJson(value);
  for (const privateValue of [
    "session-should-not-persist",
    "private-tool-name",
    "--private-command",
    "very private tool argument",
    "/private/project/path",
  ]) {
    assert.equal(text.includes(privateValue), false, `aggregate analysis leaked ${privateValue}`);
  }
  for (const record of walk(value)) {
    for (const key of ["toolName", "arguments", "command", "sessionId", "rolloutId", "path", "url"]) {
      assert.equal(Object.hasOwn(record, key), false, `aggregate analysis must not serialize ${key}`);
    }
  }
}

test("safely aggregates only client tool descriptors and emits every required mechanism class", () => {
  const result = analyze({
    clientToolEvents: [
      {
        toolClass: "web_search",
        sourceKind: "client_wrapper",
        count: 2,
        toolName: "private-tool-name",
        arguments: "very private tool argument",
        sessionId: "session-should-not-persist",
      },
      {
        toolClass: "local_shell",
        sourceKind: "client_wrapper",
        count: 3,
        command: "--private-command",
        path: "/private/project/path",
      },
      { toolClass: "mcp", sourceKind: "client_wrapper", count: 1 },
    ],
  });

  for (const toolClass of REQUIRED_CLASSES) {
    const record = classRecord(result, toolClass);
    assert.ok(["supported", "unsupported", "inconclusive"].includes(record.classification), `${toolClass} needs an explicit classification`);
    assert.equal(typeof record.clientEventCount, "number", `${toolClass} needs a safe aggregate client count`);
    assert.ok(Array.isArray(record.reasons) && record.reasons.length > 0, `${toolClass} needs an explicit evidence boundary`);
  }
  assert.equal(classRecord(result, "web_search").clientEventCount, 2);
  assert.equal(classRecord(result, "local_shell").clientEventCount, 3);
  assert.equal(classRecord(result, "mcp").clientEventCount, 1);
  assertNoPrivateSourceFields(result);
});

test("a local web wrapper is not an OpenAI Responses web-search unit and cannot receive a price", () => {
  const result = analyze({
    clientToolEvents: [{
      toolClass: "web_search",
      sourceKind: "client_wrapper",
      count: 4,
    }],
  });
  const webSearch = classRecord(result, "web_search");

  assert.equal(webSearch.classification, "inconclusive");
  assert.equal(webSearch.officialBillableUnit, "responses_web_search_call");
  assert.equal(webSearch.matchedServerUnitCount, 0);
  assert.equal(webSearch.unitPriceUsd, null, "a client wrapper count is not billing evidence");
  assert.ok(webSearch.reasons.some((reason) => /client.*wrapper|server.*unit|responses/i.test(reason)));
});

test("a local shell or patch operation is not a hosted container session and cannot receive a price", () => {
  const result = analyze({
    clientToolEvents: [
      { toolClass: "local_shell", sourceKind: "client_wrapper", count: 3 },
      { toolClass: "apply_patch", sourceKind: "client_wrapper", count: 2 },
    ],
  });

  const localShell = classRecord(result, "local_shell");
  const patch = classRecord(result, "apply_patch");
  assert.equal(localShell.classification, "unsupported");
  assert.equal(localShell.officialBillableUnit, "container_session");
  assert.equal(localShell.matchedServerUnitCount, 0);
  assert.equal(localShell.unitPriceUsd, null);
  assert.ok(localShell.reasons.some((reason) => /local.*shell|hosted.*container/i.test(reason)));
  assert.equal(patch.classification, "unsupported");
  assert.equal(patch.unitPriceUsd, null);
});

test("missing independently observed server units never receive an API tool price", () => {
  const result = analyze({
    clientToolEvents: REQUIRED_CLASSES.map((toolClass) => ({ toolClass, sourceKind: "client_wrapper", count: 1 })),
  });

  for (const toolClass of REQUIRED_CLASSES) {
    const record = classRecord(result, toolClass);
    assert.equal(record.matchedServerUnitCount, 0, `${toolClass} fixture has no server-unit receipt`);
    assert.equal(record.unitPriceUsd, null, `${toolClass} must remain unpriced without a matching provider unit`);
  }
});

test("independently observed Responses unit evidence can support web-search pricing, without converting client calls into units", () => {
  const result = analyze({
    clientToolEvents: [{ toolClass: "web_search", sourceKind: "client_wrapper", count: 9 }],
    officialBillingEvidence: [{
      toolClass: "web_search",
      sourceKind: "provider_usage_receipt",
      serverBillableUnit: "responses_web_search_call",
      serverUnitCount: 2,
    }],
  });
  const webSearch = classRecord(result, "web_search");

  assert.equal(webSearch.classification, "supported");
  assert.equal(webSearch.clientEventCount, 9, "client activity remains a separate measurement");
  assert.equal(webSearch.matchedServerUnitCount, 2, "only receipt-backed server units are priceable");
  assert.equal(webSearch.officialBillableUnit, "responses_web_search_call");
  assert.equal(webSearch.unitPriceUsd, 0.01, "standard API web-search pricing is per provider-reported call");
  assert.equal(webSearch.estimatedToolCostUsd, 0.02);
  assertNoPrivateSourceFields(result);
});

test("marks provider-tool classes inconclusive when client traces lack the provider's billable-unit evidence", () => {
  const result = analyze({
    clientToolEvents: [
      { toolClass: "file_search", sourceKind: "client_wrapper", count: 1 },
      { toolClass: "code_interpreter", sourceKind: "client_wrapper", count: 1 },
      { toolClass: "hosted_shell", sourceKind: "client_wrapper", count: 1 },
      { toolClass: "computer_use", sourceKind: "client_wrapper", count: 1 },
      { toolClass: "mcp", sourceKind: "client_wrapper", count: 1 },
    ],
  });

  for (const toolClass of ["file_search", "code_interpreter", "hosted_shell", "computer_use", "mcp"]) {
    const record = classRecord(result, toolClass);
    assert.equal(record.classification, "inconclusive", `${toolClass} is not inferable from a client wrapper alone`);
    assert.equal(record.unitPriceUsd, null);
    assert.ok(record.reasons.some((reason) => /provider|server|billable|receipt|unit/i.test(reason)));
  }
});

test("the acceptance gate passes only for a clean feasible pair or an exhaustive non-identifiability explanation", () => {
  const exhaustiveNoPair = analyze({
    clientToolEvents: REQUIRED_CLASSES.map((toolClass) => ({ toolClass, sourceKind: "client_wrapper", count: 1 })),
  });
  assert.equal(exhaustiveNoPair.acceptanceGate.passed, true);
  assert.equal(exhaustiveNoPair.acceptanceGate.basis, "no_safely_identifiable_pair_explained");
  for (const toolClass of REQUIRED_CLASSES) {
    assert.ok(classRecord(exhaustiveNoPair, toolClass).reasons.length > 0);
  }

  const incompleteNoPair = analyze({
    clientToolEvents: [{ toolClass: "web_search", sourceKind: "client_wrapper", count: 1 }],
  });
  assert.equal(incompleteNoPair.acceptanceGate.passed, false, "the gate cannot pass when remaining classes are not assessed");

  const cleanPair = analyze({
    clientToolEvents: [{ toolClass: "web_search", sourceKind: "client_wrapper", count: 1 }],
    officialBillingEvidence: [{
      toolClass: "web_search",
      sourceKind: "provider_usage_receipt",
      serverBillableUnit: "responses_web_search_call",
      serverUnitCount: 1,
    }],
    pairedPilotResults: [{
      toolClass: "web_search",
      status: "completed",
      controlStatus: "completed",
      contaminationState: "controlled",
      providerUnitMatched: true,
    }],
  });
  assert.equal(cleanPair.acceptanceGate.passed, true);
  assert.equal(cleanPair.acceptanceGate.basis, "feasible_pair_completed");

  const unrelatedPair = analyze({
    pairedPilotResults: [{
      toolClass: "not_assessed",
      status: "completed",
      controlStatus: "completed",
      contaminationState: "controlled",
      providerUnitMatched: true,
    }],
  });
  assert.equal(unrelatedPair.acceptanceGate.passed, false, "an unknown tool class cannot satisfy the pair gate");
});

test("the exhaustive gate distinguishes observed classes from explicit desk research", () => {
  const result = analyze({
    clientToolEvents: [{ toolClass: "web_search", sourceKind: "client_wrapper", count: 2 }],
    assessedToolClasses: REQUIRED_CLASSES,
  });

  assert.equal(result.acceptanceGate.passed, true);
  assert.equal(result.acceptanceGate.basis, "no_safely_identifiable_pair_explained");
  assert.equal(classRecord(result, "web_search").assessmentState, "observed_in_fixed_interval");
  assert.equal(classRecord(result, "file_search").assessmentState, "desk_researched_unobserved");
  assert.equal(result.summary.observedClassCount, 1);
  assert.equal(result.summary.deskResearchedUnobservedClassCount, REQUIRED_CLASSES.length - 1);

  const zeroCountsWithoutAssessment = analyze({
    clientToolEvents: REQUIRED_CLASSES.map((toolClass) => ({ toolClass, sourceKind: "client_wrapper", count: 0 })),
  });
  assert.equal(zeroCountsWithoutAssessment.acceptanceGate.passed, false);
  assert.equal(classRecord(zeroCountsWithoutAssessment, "web_search").assessmentState, "not_assessed");
});

test("the human report is deterministic and preserves evidence boundaries", () => {
  const input = {
    clientToolEvents: [
      { toolClass: "web_search", sourceKind: "client_wrapper", count: 2 },
      { toolClass: "local_shell", sourceKind: "client_wrapper", count: 1 },
    ],
  };
  const first = analyze(input);
  const second = analyze(input);
  const firstReport = renderToolMechanismReport(first);
  const secondReport = renderToolMechanismReport(second);

  assert.equal(stableJson(first), stableJson(second));
  assert.equal(firstReport, secondReport);
  assert.match(firstReport, /client-side aggregate/i);
  assert.match(firstReport, /not.*provider.*billing|provider.*billing.*not/i);
  assertNoPrivateSourceFields(firstReport);
});
