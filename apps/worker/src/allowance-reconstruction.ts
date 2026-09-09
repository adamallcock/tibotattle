/** Operational policy only; never changes contribution consent or activation. */
export function allowanceReconstructionMode(env: Pick<Env, "ENVIRONMENT">): "paused" | "legacy" | "resumable" {
  const mode: unknown = Reflect.get(env, "ALLOWANCE_RECONSTRUCTION_MODE");
  if (mode === "resumable") return "resumable";
  if (mode === "enabled") return "legacy";
  if (mode !== undefined) return "paused";
  // Preserve explicit synthetic/staging callers. A missing production setting
  // must never restart either analyzer accidentally.
  return env.ENVIRONMENT === "production" ? "paused" : "legacy";
}

export function allowanceReconstructionEnabled(env: Pick<Env, "ENVIRONMENT">): boolean {
  return allowanceReconstructionMode(env) !== "paused";
}
