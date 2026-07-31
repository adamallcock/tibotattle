import { resolve } from "node:path";

/** Local-only activity marker location retained for legacy storage callers. */
export function defaultActivityMarkerFile() {
  return resolve(process.cwd(), ".usage-monitor", "activity-markers-v0.1.jsonl");
}
