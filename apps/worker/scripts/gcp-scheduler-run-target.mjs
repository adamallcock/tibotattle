/**
 * Which Cloud Run job a Cloud Scheduler trigger runs (OPS-3, OPS-10).
 *
 * One classification for the rollout's ROLLOUT_JOBS_NOT_PAUSED gate
 * (gcp-production-rollout.mjs) and OPS-3's pause-all and resume-all
 * (gcp-ops-infra-operations.mjs), so pause-all pauses exactly the triggers
 * that gate reads. A leaf module: no imports, no I/O.
 */

/**
 * The jobs:run URI shapes of the Cloud Run Admin API (v2, and v1 through the
 * regional endpoint). A trigger whose URI names run.googleapis.com in any
 * other shape is "unparsed", so it is paused and gated like a job trigger.
 */
export const RUN_JOB_URIS = Object.freeze([
  /^https:\/\/run\.googleapis\.com\/v2\/projects\/[a-z0-9-]+\/locations\/([a-z0-9-]+)\/jobs\/([a-z0-9-]+):run$/u,
  /^https:\/\/([a-z0-9-]+)-run\.googleapis\.com\/apis\/run\.googleapis\.com\/v1\/namespaces\/[a-z0-9-]+\/jobs\/([a-z0-9-]+):run$/u,
]);

/** The Cloud Run job a scheduler entry's HTTP target runs, "unparsed", or null for any other target. */
export function scheduledRunJob(entry) {
  const uri = entry?.httpTarget?.uri;
  if (typeof uri !== "string") return null;
  for (const pattern of RUN_JOB_URIS) {
    const match = pattern.exec(uri);
    if (match !== null) return match[2];
  }
  return /run\.googleapis\.com/u.test(uri) ? "unparsed" : null;
}
