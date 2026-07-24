const REQUIRED_TOOL_CLASSES = [
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

const TOOL_DEFINITIONS = {
  web_search: {
    officialBillableUnit: "responses_web_search_call",
    unitPriceUsd: 0.01,
    boundary: "A client web wrapper is not a Responses web_search_call or an Admin Usage API web-search receipt.",
    identifiable: "Requires a typed server output or provider usage receipt plus a clean repeated no-tool pair.",
    documentedApiPrice: "$10.00 per 1,000 calls, plus applicable model-token charges",
  },
  file_search: {
    officialBillableUnit: "responses_file_search_call",
    unitPriceUsd: 0.0025,
    boundary: "A client file-search wrapper is not the provider-reported Responses file-search request unit.",
    identifiable: "Requires a typed server output or provider usage receipt, storage telemetry, and a clean repeated no-tool pair.",
    documentedApiPrice: "$2.50 per 1,000 Responses API calls, plus $0.10 per GB-day storage after the free allowance",
  },
  code_interpreter: {
    officialBillableUnit: "code_interpreter_container_session",
    unitPriceUsd: null,
    boundary: "A local Python or code wrapper does not expose the provider's container session, memory size, or duration.",
    identifiable: "Requires provider session telemetry, container size and duration, and a clean repeated no-tool pair.",
    documentedApiPrice: "$0.03 to $1.92 per 20-minute session per container depending on memory, with eligible sessions billed by minute and a five-minute minimum",
  },
  hosted_shell: {
    officialBillableUnit: "container_session",
    unitPriceUsd: null,
    boundary: "A local shell call is not a hosted container session and has no provider container identifier, size, or duration.",
    identifiable: "Requires typed hosted-shell output plus provider container-session telemetry and a clean repeated no-tool pair.",
    documentedApiPrice: "$0.03 to $1.92 per 20-minute session per container depending on memory, with eligible sessions billed by minute and a five-minute minimum",
  },
  computer_use: {
    officialBillableUnit: "computer_use_model_tokens",
    unitPriceUsd: null,
    boundary: "A local browser or computer controller call is not a provider usage receipt or a separately priced API action unit.",
    identifiable: "Requires provider-side model/token evidence and a clean repeated no-tool pair; no separate current per-action price is assumed.",
    documentedApiPrice: "Model input and output token rates; no separate current per-action price is listed",
  },
  mcp: {
    officialBillableUnit: "none_separate_from_model_tokens",
    unitPriceUsd: null,
    boundary: "A client MCP invocation has no separately listed standard OpenAI API per-call price.",
    identifiable: "Only token-mediated quota effects can be tested unless OpenAI exposes a separate provider unit.",
    documentedApiPrice: "No separate standard API per-call price is listed",
  },
  local_shell: {
    officialBillableUnit: "container_session",
    unitPriceUsd: null,
    boundary: "The observed operation runs in the client runtime; it is not OpenAI Hosted Shell or a hosted container session.",
    identifiable: "No standard API hosted-tool price can be attached to this client-local event.",
    documentedApiPrice: "Not applicable to a client-local shell event",
    unsupported: true,
  },
  apply_patch: {
    officialBillableUnit: "none_separate_from_model_tokens",
    unitPriceUsd: null,
    boundary: "Apply Patch is a client-side edit operation, not a separately priced standard API tool unit.",
    identifiable: "No standard API tool price can be attached; any subscription effect beyond tokens needs a clean causal experiment.",
    documentedApiPrice: "No separate standard API price is listed",
    unsupported: true,
  },
  subagent: {
    officialBillableUnit: "none_separate_from_child_model_usage",
    unitPriceUsd: null,
    boundary: "Subagent orchestration is a client control event; child model tokens are already measured separately when logged.",
    identifiable: "No standard API orchestration price can be attached; a clean parent/child attribution experiment would be needed.",
    documentedApiPrice: "No separate standard API orchestration price is listed",
    unsupported: true,
  },
};

function finiteNonnegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function roundUsd(value) {
  return Number(value.toFixed(9));
}

function isMatchedReceipt(evidence, definition) {
  return (evidence?.sourceKind === "provider_usage_receipt" || evidence?.sourceKind === "responses_typed_output_item")
    && evidence.serverBillableUnit === definition.officialBillableUnit
    && finiteNonnegative(evidence.serverUnitCount) > 0;
}

function isCleanCompletedPair(result) {
  return REQUIRED_TOOL_CLASSES.includes(result?.toolClass)
    && result.status === "completed"
    && result.controlStatus === "completed"
    && result.contaminationState === "controlled"
    && result.providerUnitMatched === true;
}

/**
 * Analyze descriptor-only tool evidence. Raw names, arguments, commands, paths,
 * URLs, and stable identifiers are intentionally ignored and never serialized.
 */
export function analyzeToolMechanisms({
  clientToolEvents = [],
  pairedPilotResults = [],
  officialBillingEvidence = [],
  assessedToolClasses = [],
  scope = null,
} = {}) {
  const assessedClasses = new Set(assessedToolClasses.filter((toolClass) => REQUIRED_TOOL_CLASSES.includes(toolClass)));
  const observedClasses = new Set();
  const clientCounts = Object.fromEntries(REQUIRED_TOOL_CLASSES.map((toolClass) => [toolClass, 0]));
  for (const event of clientToolEvents) {
    if (!REQUIRED_TOOL_CLASSES.includes(event?.toolClass)) continue;
    const count = finiteNonnegative(event.count ?? 1);
    clientCounts[event.toolClass] += count;
    if (count > 0) {
      assessedClasses.add(event.toolClass);
      observedClasses.add(event.toolClass);
    }
  }

  const classes = {};
  for (const toolClass of REQUIRED_TOOL_CLASSES) {
    const definition = TOOL_DEFINITIONS[toolClass];
    const receipts = officialBillingEvidence.filter((evidence) => evidence?.toolClass === toolClass
      && isMatchedReceipt(evidence, definition));
    const matchedServerUnitCount = receipts.reduce((total, evidence) => total + finiteNonnegative(evidence.serverUnitCount), 0);
    const cleanPairCount = pairedPilotResults.filter((result) => result?.toolClass === toolClass && isCleanCompletedPair(result)).length;
    const unitPriceUsd = matchedServerUnitCount > 0 && definition.unitPriceUsd !== null
      ? definition.unitPriceUsd
      : null;
    const classification = matchedServerUnitCount > 0 && unitPriceUsd !== null
      ? "supported"
      : (definition.unsupported ? "unsupported" : "inconclusive");

    const reasons = [definition.boundary, definition.identifiable];
    if (matchedServerUnitCount === 0) reasons.push("No independently observed provider billing unit is present, so no API tool price is applied.");
    if (cleanPairCount === 0) reasons.push("No clean, completed tool/no-tool pair supports an incremental subscription-quota claim.");

    classes[toolClass] = {
      classification,
      assessmentState: observedClasses.has(toolClass)
        ? "observed_in_fixed_interval"
        : (assessedClasses.has(toolClass) ? "desk_researched_unobserved" : "not_assessed"),
      clientEventCount: clientCounts[toolClass],
      officialBillableUnit: definition.officialBillableUnit,
      documentedApiPrice: definition.documentedApiPrice,
      matchedServerUnitCount,
      unitPriceUsd,
      estimatedToolCostUsd: unitPriceUsd === null ? null : roundUsd(unitPriceUsd * matchedServerUnitCount),
      cleanPairedPilotCount: cleanPairCount,
      safeIdentifiability: cleanPairCount > 0 && matchedServerUnitCount > 0
        ? "paired_provider_unit_evidence_available"
        : "not_currently_identifiable",
      reasons,
    };
  }

  const classificationCounts = { supported: 0, unsupported: 0, inconclusive: 0 };
  for (const record of Object.values(classes)) classificationCounts[record.classification] += 1;
  const cleanPairCount = pairedPilotResults.filter((result) => isCleanCompletedPair(result)
    && (classes[result.toolClass]?.matchedServerUnitCount ?? 0) > 0).length;
  const allClassesAssessed = REQUIRED_TOOL_CLASSES.every((toolClass) => assessedClasses.has(toolClass));
  const acceptanceGate = cleanPairCount > 0
    ? { passed: true, basis: "feasible_pair_completed" }
    : allClassesAssessed
      ? { passed: true, basis: "no_safely_identifiable_pair_explained" }
      : { passed: false, basis: "assessment_incomplete" };

  return {
    schemaVersion: "0.3",
    analysisKind: "tool_mechanism_observability",
    parserVersion: "codex-tool-observability@0.3.1",
    ...(scope && typeof scope === "object" ? { scope: {
      startAt: typeof scope.startAt === "string" ? scope.startAt : null,
      endAt: typeof scope.endAt === "string" ? scope.endAt : null,
      provider: typeof scope.provider === "string" ? scope.provider : "openai_codex",
      localOnly: scope.localOnly !== false,
    } } : {}),
    pricingBasis: "standard_openai_api_prices_not_codex_subscription_credits",
    classes,
    summary: {
      assessedClassCount: assessedClasses.size,
      observedClassCount: observedClasses.size,
      deskResearchedUnobservedClassCount: [...assessedClasses].filter((toolClass) => !observedClasses.has(toolClass)).length,
      requiredClassCount: REQUIRED_TOOL_CLASSES.length,
      totalClientEventCount: Object.values(clientCounts).reduce((total, count) => total + count, 0),
      totalMatchedServerUnitCount: Object.values(classes).reduce((total, record) => total + record.matchedServerUnitCount, 0),
      cleanPairedPilotCount: cleanPairCount,
      classificationCounts,
    },
    acceptanceGate,
    evidenceBoundary: [
      "Client-side aggregate tool activity is not provider billing evidence.",
      "Only independently observed provider units receive standard API tool prices.",
      "API price equivalence does not establish Codex subscription-quota accounting.",
    ],
    officialSources: [
      {
        name: "OpenAI API detailed pricing",
        sourceLink: "https://developers.openai.com/api/docs/pricing",
        supports: "model token prices, web search calls, file search, and hosted container sessions",
      },
      {
        name: "OpenAI organization usage API",
        sourceLink: "https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage",
        supports: "provider-reported web and file search requests and code interpreter sessions",
      },
    ],
    privacy: {
      retained: ["aggregate_tool_class", "source_kind", "count", "provider_unit_kind", "paired_pilot_status"],
      excluded: ["tool_names", "arguments", "commands", "paths", "urls", "stable_identifiers", "content"],
    },
  };
}

export function renderToolMechanismReport(analysis) {
  const date = analysis.scope?.endAt?.slice(0, 10) ?? "2026-07-23";
  const lines = [
    "---",
    "title: Tool Mechanism Observability Report",
    `date: ${date}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# Tool Mechanism Observability Report",
    "",
    `Gate: **${analysis.acceptanceGate.passed ? "pass" : "fail"}** (${analysis.acceptanceGate.basis}).`,
    "",
    "This report uses client-side aggregate descriptors only. Client events are not provider billing receipts, and API-price equivalence does not establish the Codex subscription mechanism.",
    "",
    "| Class | Assessment | Client events | Provider units | API unit | Documented API price | Classification | Pair |",
    "| --- | --- | ---: | ---: | --- | --- | --- | --- |",
  ];
  for (const [toolClass, record] of Object.entries(analysis.classes)) {
    lines.push(`| ${toolClass} | ${record.assessmentState} | ${record.clientEventCount} | ${record.matchedServerUnitCount} | ${record.officialBillableUnit} | ${record.documentedApiPrice} | ${record.classification} | ${record.cleanPairedPilotCount > 0 ? "clean" : "none"} |`);
  }
  lines.push(
    "",
    "## Evidence boundary",
    "",
    ...analysis.evidenceBoundary.map((value) => `- ${value}`),
    "",
    "Official sources:",
    "",
    ...analysis.officialSources.map((source) => `- [${source.name}](${source.sourceLink}) — ${source.supports}.`),
    "",
    "## Class findings",
    "",
  );
  for (const [toolClass, record] of Object.entries(analysis.classes)) {
    lines.push(`### ${toolClass}`, "", ...record.reasons.map((reason) => `- ${reason}`), "");
  }
  return `${lines.join("\n")}\n`;
}

export { REQUIRED_TOOL_CLASSES };
