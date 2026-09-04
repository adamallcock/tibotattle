// Reviewed identity vocabulary, not a claim that a model is selectable in Codex
// or that a particular account has access. Prices and entitlement are separate.
// The published identities match the accounting package's reviewed text-model
// cards; synthetic provider-tool cards are deliberately excluded. Explicit
// aliases retain their own identity even when a caller shares a price card.
export const REVIEWED_MODEL_CATALOG_VERSION = "reviewed-model-catalog-2026-09-03.1";

const reviewedOpenAiModelRows = [
  ["codex-auto-review", "Codex Auto-review", "assumed_alias", "gpt-5.4"],
  ["gpt-4-turbo-2024-04-09", "GPT-4 Turbo (2024-04-09)"],
  ["gpt-4.1", "GPT-4.1"],
  ["gpt-4.1-mini", "GPT-4.1 Mini"],
  ["gpt-4.1-nano", "GPT-4.1 Nano"],
  ["gpt-4o", "GPT-4o"],
  ["gpt-4o-2024-05-13", "GPT-4o (2024-05-13)"],
  ["gpt-4o-mini", "GPT-4o Mini"],
  ["gpt-5", "GPT-5"],
  ["gpt-5-codex", "GPT-5 Codex"],
  ["gpt-5-mini", "GPT-5 Mini"],
  ["gpt-5-nano", "GPT-5 Nano"],
  ["gpt-5-pro", "GPT-5 Pro"],
  ["gpt-5.1", "GPT-5.1"],
  ["gpt-5.1-codex", "GPT-5.1 Codex"],
  ["gpt-5.1-codex-mini", "GPT-5.1 Codex Mini"],
  ["gpt-5.2", "GPT-5.2"],
  ["gpt-5.2-codex", "GPT-5.2 Codex"],
  ["gpt-5.2-pro", "GPT-5.2 Pro"],
  ["gpt-5.3-codex", "GPT-5.3 Codex"],
  ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", "unpriced", null],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.4-mini", "GPT-5.4 Mini"],
  ["gpt-5.4-nano", "GPT-5.4 Nano"],
  ["gpt-5.4-pro", "GPT-5.4 Pro"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.5-codex", "GPT-5.5 Codex", "assumed_alias", "gpt-5.5"],
  ["gpt-5.5-pro", "GPT-5.5 Pro"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-sol-wm", "GPT-5.6 Sol Work Mode", "assumed_alias", "gpt-5.6-sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["o1", "o1"],
  ["o1-pro", "o1 Pro"],
  ["o3", "o3"],
  ["o3-mini", "o3 Mini"],
  ["o3-pro", "o3 Pro"],
  ["o4-mini", "o4 Mini"],
];

const reviewedClaudeModelRows = [
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
];

export const REVIEWED_MODEL_CATALOG = Object.freeze([
  ...reviewedOpenAiModelRows.map(([id, label, pricingStatus = "published", priceModelId = id]) => Object.freeze({
    id, label, provider: "openai_codex",
    allowanceTrack: id === "gpt-5.3-codex-spark" ? "spark" : "primary",
    pricingStatus, priceModelId,
  })),
  ...reviewedClaudeModelRows.map(([id, label]) => Object.freeze({
    id, label, provider: "anthropic_claude_code", allowanceTrack: "primary",
    pricingStatus: "published", priceModelId: id,
  })),
]);

export const REVIEWED_CODEX_MODEL_IDS = Object.freeze(
  REVIEWED_MODEL_CATALOG.filter((entry) => entry.provider === "openai_codex").map((entry) => entry.id),
);
export const REVIEWED_CLAUDE_MODEL_IDS = Object.freeze(
  REVIEWED_MODEL_CATALOG.filter((entry) => entry.provider === "anthropic_claude_code").map((entry) => entry.id),
);

const reviewedModelById = new Map(REVIEWED_MODEL_CATALOG.map((entry) => [entry.id, entry]));

// Never pass a custom/raw identity through to telemetry or presentation.
export function reviewedModelIdentity(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  return reviewedModelById.get(value.toLowerCase()) ?? null;
}

// Requested API effort is not effective effort, configuration-update evidence,
// or proof of cache compatibility. Codex Astra Ultra requests xhigh and enables
// delegation; legacy reviewed Codex models retain the existing Ultra -> Max
// request mapping. Unknown/custom identities cannot inherit that equivalence.
// Upstream source: openai/codex 5cc1c94b8e3226c5a343b2f4fe77bf0585234f50,
// codex-rs/core/src/client.rs and codex-rs/models-manager/models.json.
export function codexRequestReasoningEffort(modelId, effort) {
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"].includes(effort)) return null;
  if (effort !== "ultra") return effort;
  const model = reviewedModelIdentity(modelId);
  if (model?.provider !== "openai_codex") return effort;
  return model.id === "gpt-6-astra" ? "xhigh" : "max";
}

// A matching API effort alone does not imply matching cache configuration.
// Astra Ultra also enables proactive delegation, so keep it distinct from
// ordinary xhigh for continuity comparisons even though both request xhigh.
export function codexCacheReasoningConfiguration(modelId, effort) {
  const requested = codexRequestReasoningEffort(modelId, effort);
  return requested !== null && effort === "ultra"
      && reviewedModelIdentity(modelId)?.id === "gpt-6-astra"
    ? "ultra" : requested;
}
