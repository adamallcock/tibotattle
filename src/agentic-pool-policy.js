export const AGENTIC_POOL_POLICY = Object.freeze({
  schemaVersion: "agentic-pool-policy-v0.2",
  checkedAt: "2026-07-24",
  sourceUrl: "https://learn.chatgpt.com/docs/pricing",
  ordinaryChatIncluded: false,
  ordinaryChatVoiceIncluded: false,
  includedSurfaces: Object.freeze([
    "codex_cloud",
    "codex_other_machine",
    "chatgpt_work",
    "workspace_agent",
    "chatgpt_excel",
    "image_generation",
  ]),
  separateOrMixedMeters: Object.freeze({
    chatgpt_work_voice: "mixed_task_shared_voice_time_separate",
    codex_spark: "separate_demand_adjusted_model_limit",
  }),
});

const COUPLING_BY_SURFACE = Object.freeze({
  chatgpt_chat: "excluded_ordinary_chat",
  chatgpt_web: "excluded_ordinary_chat",
  ordinary_chat_voice: "excluded_ordinary_chat",
  chatgpt_work: "shared_agentic_pool",
  workspace_agent: "shared_agentic_pool",
  chatgpt_excel: "shared_agentic_pool",
  codex_cloud: "shared_agentic_pool",
  codex_other_machine: "shared_agentic_pool",
  chatgpt_work_voice: "mixed_task_shared_voice_time_separate",
  image_generation: "shared_agentic_pool_feature_multiplier",
  codex_spark: "separate_demand_adjusted_model_limit",
  other_machine: "unknown_client_surface",
  voice_mode: "unknown_legacy_voice_marker",
  voice_dictation: "depends_on_destination_surface",
  third_party_client: "unknown_client_surface",
  quiet_period: "not_applicable",
  controlled_experiment: "depends_on_experiment_surface",
});

export function agenticPoolCouplingForSurface(surface) {
  return COUPLING_BY_SURFACE[surface] ?? "unknown";
}
