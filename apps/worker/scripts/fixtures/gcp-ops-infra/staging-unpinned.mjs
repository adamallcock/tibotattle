/**
 * The committed staging desired state as it reads before the main session
 * pins it (STG-PREP): every secret version and the bucket proof back to
 * null. Checks that describe the first staging plan or the pin edits start
 * from this text, so they hold whether or not the pins are committed yet.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const STAGING_DESIRED_STATE_PATH = join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json");

export function unpinnedStagingText(text = readFileSync(STAGING_DESIRED_STATE_PATH, "utf8")) {
  return text
    .replace(/("version": )"[1-9][0-9]{0,9}"( \})/gu, "$1null$2")
    .replace(/"proof": \{ "bucketGeneration": "[1-9][0-9]{0,18}", "bucketMetageneration": "[1-9][0-9]{0,18}" \}/u,
      "\"proof\": null");
}
