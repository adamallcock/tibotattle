#!/usr/bin/env node
// Standalone direct native reference over a seeded oracle source:
//
//   ~/.nvm/versions/node/v26.2.0/bin/node apps/worker/scripts/gcp-fastpath-dense-oracle/direct.mjs \
//     --work-dir <absolute dir outside the repository> --source <seeded usage-monitor.sqlite> \
//     [--expect-source-digest <hex>] [--jobs N] [--owners a,b,...] [--dates all|<day,...>]
//
// Clones the source (APFS clone) into the work directory, proves its content
// digest when one is given (the "analyzed" sourceDigest an oracle run logged),
// and runs direct-native.mjs for every owner's fits for 2026-10-01 and its 70
// model dates. Writes <work-dir>/direct-results.json and prints a summary.
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDenseOracle } from "./build.mjs";
import { DENSE_CORPUS_PINNED_NOW } from "./dense-corpus.mjs";
import { runDirectNative } from "./direct-native.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "./runtime.mjs";
import { sourceContentDigest, usageRowsByOwnerDay } from "./source-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const NAMESPACE = "gcp-fastpath-oracle";
const NOW_MS = Date.parse(DENSE_CORPUS_PINNED_NOW);
/** Pinned owner digests of the corpus owners (hex('owner-digest', key)). */
export const ORACLE_OWNER_KEYS = Object.freeze({
  f214e768a577e01681dcb70f03221c39e0715d52ff594724daf0ba76f6c6c54c: "a",
  b2df2e36a49340774e9550bb63a8ec9a663b5c56b63e86519a987b619c6981be: "b",
  "77fa209ac4e4d1407b6fbe20381f67bde307e0ffc5ab47b98f3ac48caa9fc04e": "c",
  "8f6b06d86afa675ccb556989677ad247f687a344926347a68281cebdfe4e4007": "d",
  "49a16990ce1ced5df1b259e629d2a70ae890bfee191b98be75e0d4e3a89b378a": "e",
});

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const workDir = resolve(value("--work-dir") ?? "");
const sourceArg = resolve(value("--source") ?? "");
const jobs = Number(value("--jobs") ?? "1");
const owners = value("--owners")?.split(",") ?? null;
const datesArg = value("--dates") ?? "all";
if (!existsSync(sourceArg)) throw new Error("DIRECT_SOURCE_MISSING");
mkdirSync(workDir, { recursive: true });
const sourcePath = join(workDir, "usage-monitor.sqlite");
if (!existsSync(sourcePath)) copyFileSync(sourceArg, sourcePath, fsConstants.COPYFILE_FICLONE);
const digest = sourceContentDigest(sourcePath);
const expected = value("--expect-source-digest");
if (expected && digest !== expected) throw new Error(`DIRECT_SOURCE_DIGEST_MISMATCH:${digest}`);

const build = await buildDenseOracle({ workDir: join(workDir, "build") });
installDenseOracleRuntime({ seed: "gcp-fastpath-dense-oracle:direct" });
process.setSourceMapsEnabled(true);
setPinnedNow(NOW_MS);
const P = await import(pathToFileURL(build.bundle.path).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(join(WORKER_ROOT, "cloud-run/sealed-sqlite-d1-adapter.mjs")).href);
const today = DENSE_CORPUS_PINNED_NOW.slice(0, 10);
const modelDates = Array.from({ length: 70 }, (_, index) => new Date(NOW_MS - (69 - index) * 86_400_000).toISOString().slice(0, 10));
const usage = usageRowsByOwnerDay(sourcePath);
const weight = (task) => {
  const window = P.modelHistoryWindow(task.day);
  let rows = 0;
  for (const [day, n] of usage.get(task.ownerDigest) ?? []) if (day >= window.fromDay && day <= window.day) rows += n;
  return rows;
};
const ownerKeyOf = (digest) => ORACLE_OWNER_KEYS[digest] ?? digest.slice(0, 8);
const started = performance.now();
let finished = 0;
const run = await runDirectNative({ P, openSealedSqliteD1, sourcePath, sourceNamespace: NAMESPACE, nowMs: NOW_MS, today,
  modelDates, ownerKeyOf, datesFor: (key) => (owners && !owners.includes(key) ? [] : datesArg === "all" ? modelDates : datesArg.split(",")),
  weight, jobs, scratchDir: join(workDir, "children"),
  child: { node: process.execPath, execArgv: ["--max-old-space-size=8192"], script: join(HERE, "direct-native-child.mjs"),
    spec: { bundlePath: build.bundle.path, adapterPath: join(WORKER_ROOT, "cloud-run/sealed-sqlite-d1-adapter.mjs") } },
  onTask: (task, result) => {
    finished++;
    process.stderr.write(`${JSON.stringify({ event: "direct-task", finished, owner: ownerKeyOf(task.ownerDigest), metric: task.metric,
      day: task.day, state: result.state, code: result.code ?? null, ms: result.cost.ms, steps: result.cost.steps,
      wallMs: Math.round(performance.now() - started) })}\n`);
  } });
const selected = owners === null ? run.results : Object.fromEntries(Object.entries(run.results).filter(([key]) => owners.includes(key)));
writeFileSync(join(workDir, "direct-results.json"), `${JSON.stringify({ schemaVersion: "gcp-fastpath-dense-direct-v1",
  sourceDigest: digest, bundleSha256: build.bundle.sha256, nowMs: NOW_MS, cost: run.cost, results: selected }, null, 1)}\n`);
process.stdout.write(`${JSON.stringify({ sourceDigest: digest, cost: run.cost,
  owners: Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, { fits: value.fits?.state,
    model: Object.values(value.model).reduce((n, item) => ({ ...n, [item.state]: (n[item.state] ?? 0) + 1 }), {}) }])) })}\n`);
