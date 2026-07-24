import { randomUUID } from "node:crypto";
import { agenticPoolCouplingForSurface } from "./agentic-pool-policy.js";

export const ACTIVITY_SURFACES = Object.freeze([
  "chatgpt_chat",
  "chatgpt_web",
  "chatgpt_work",
  "workspace_agent",
  "chatgpt_excel",
  "codex_cloud",
  "codex_other_machine",
  "chatgpt_work_voice",
  "ordinary_chat_voice",
  "image_generation",
  "codex_spark",
  "other_machine",
  "voice_mode",
  "voice_dictation",
  "third_party_client",
  "quiet_period",
  "controlled_experiment",
]);

export const ACTIVITY_STATES = Object.freeze(["start", "end", "pulse"]);

export function createActivityMarker({
  surface,
  state,
  observedAt = new Date().toISOString(),
  accountScope = null,
  planType = "unknown",
  planVariant = "unknown",
  experimentId = null,
} = {}) {
  if (!ACTIVITY_SURFACES.includes(surface)) throw new Error(`surface must be one of: ${ACTIVITY_SURFACES.join(", ")}`);
  if (!ACTIVITY_STATES.includes(state)) throw new Error(`state must be one of: ${ACTIVITY_STATES.join(", ")}`);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("observedAt must be an ISO timestamp");
  if (experimentId !== null && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(experimentId)) {
    throw new Error("experimentId must be a safe lowercase identifier");
  }
  const safeScope = accountScope?.status === "available" && typeof accountScope.scopeId === "string"
    ? { status: "available", version: accountScope.version ?? null, scopeId: accountScope.scopeId }
    : { status: "unavailable", version: accountScope?.version ?? null, scopeId: null };
  return {
    schemaVersion: "activity-marker-v0.1",
    kind: "privacy_safe_activity_marker",
    markerId: randomUUID(),
    observedAt: new Date(observedAt).toISOString(),
    surface,
    state,
    agenticPoolCoupling: agenticPoolCouplingForSurface(surface),
    accountScope: safeScope,
    planType: typeof planType === "string" ? planType : "unknown",
    planVariant: typeof planVariant === "string" ? planVariant : "unknown",
    experimentId,
    privacy: {
      contentStored: false,
      urlStored: false,
      rawAccountIdentifierStored: false,
      credentialsStored: false,
      freeTextStored: false,
    },
  };
}
