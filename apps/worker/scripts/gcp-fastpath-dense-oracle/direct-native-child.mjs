// One direct-native child process (direct-native.mjs runDirectNative with
// jobs > 1): pins the clock, seeds randomness, loads the oracle bundle and the
// sealed adapter, runs its share of the scopes over the read-only source,
// prints one JSON line per finished scope and writes all results as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runDirectTasks } from "./direct-native.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "./runtime.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
installDenseOracleRuntime({ seed: `gcp-fastpath-dense-oracle:direct:${spec.outPath}` });
process.setSourceMapsEnabled(true);
setPinnedNow(spec.nowMs);
const P = await import(pathToFileURL(spec.bundlePath).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(spec.adapterPath).href);
const write = process.stdout.write.bind(process.stdout);
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};
const results = await runDirectTasks({ P, openSealedSqliteD1, sourcePath: spec.sourcePath,
  sourceNamespace: spec.sourceNamespace, nowMs: spec.nowMs, tasks: spec.tasks,
  onTask: (task, result) => write(`${JSON.stringify({ task, result: { state: result.state, code: result.code ?? null,
    cost: result.cost } })}\n`) });
writeFileSync(spec.outPath, JSON.stringify(results));
