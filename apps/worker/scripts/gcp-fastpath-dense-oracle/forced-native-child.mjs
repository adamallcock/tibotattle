// One Tier F child process (forced-native.mjs runForcedNative with jobs > 1):
// pins the clock, seeds randomness, loads the oracle bundle and the sealed
// adapter, runs its share of the forced native scopes on its own scratch
// copies, and writes the results as JSON. Every scope starts from the same
// cleared state, so which child runs it does not change its result.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runForcedTasks } from "./forced-native.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "./runtime.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
installDenseOracleRuntime({ seed: `gcp-fastpath-dense-oracle:forced:${spec.outPath}` });
process.setSourceMapsEnabled(true);
setPinnedNow(spec.nowMs);
const P = await import(pathToFileURL(spec.bundlePath).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(spec.adapterPath).href);
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};
const results = await runForcedTasks({ P, openSealedSqliteD1, dbDir: spec.dbDir, scratchDir: spec.scratchDir,
  files: spec.files, bindings: spec.bindings, nowMs: spec.nowMs, tasks: spec.tasks, keepScratch: spec.keepScratch });
writeFileSync(spec.outPath, JSON.stringify(results));
