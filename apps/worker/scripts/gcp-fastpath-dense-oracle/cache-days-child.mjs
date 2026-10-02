// One per-owner-day cache reference child process (cache-days.mjs runCacheDays
// with jobs > 1): pins the clock, seeds randomness, loads the oracle bundle and
// the sealed adapter, builds its share of the owner-days over the read-only
// source and its own scratch target, prints one JSON line per finished day and
// writes all results as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCacheDayTasks } from "./cache-days.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "./runtime.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
installDenseOracleRuntime({ seed: `gcp-fastpath-dense-oracle:cache-days:${spec.outPath}` });
process.setSourceMapsEnabled(true);
setPinnedNow(spec.nowMs);
const P = await import(pathToFileURL(spec.bundlePath).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(spec.adapterPath).href);
const write = process.stdout.write.bind(process.stdout);
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};
const results = await runCacheDayTasks({ P, openSealedSqliteD1, sourcePath: spec.sourcePath, targetPath: spec.targetPath,
  sourceId: spec.sourceId, sourceNamespace: spec.sourceNamespace, nowMs: spec.nowMs, tasks: spec.tasks,
  onTask: (task, result) => write(`${JSON.stringify({ task, result: { state: result.state, reason: result.reason ?? null,
    ms: result.ms } })}\n`) });
writeFileSync(spec.outPath, JSON.stringify(results));
