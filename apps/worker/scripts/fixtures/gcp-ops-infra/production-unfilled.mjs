/**
 * The committed production desired state in two earlier shapes, for checks
 * that must hold whatever the main session has pinned since PROD-PREP:
 *
 * - unfilledProductionText: OWN-5's owner placeholders (project, project
 *   number, region and bucket location) back to null, as the file read before
 *   PROD-PREP filled them. Checks of the placeholder refusal start from it.
 * - unpinnedProductionText: the values the main session pins after an apply
 *   (secret versions, the bucket proof and the telemetry storage namespace)
 *   back to null. Checks that describe the first production plan start from it.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PRODUCTION_DESIRED_STATE_PATH = join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json");

export function unfilledProductionText(text = readFileSync(PRODUCTION_DESIRED_STATE_PATH, "utf8")) {
  const value = JSON.parse(text);
  Object.assign(value, { project: null, projectNumber: null, region: null });
  value.bucket.location = null;
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function unpinnedProductionText(text = readFileSync(PRODUCTION_DESIRED_STATE_PATH, "utf8")) {
  const value = JSON.parse(text);
  for (const secret of Object.values(value.secrets)) secret.version = null;
  value.bucket.proof = null;
  value.service.telemetryStorageNamespace = null;
  return `${JSON.stringify(value, null, 2)}\n`;
}
