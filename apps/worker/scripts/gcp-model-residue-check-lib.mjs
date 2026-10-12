/** Harness-only exports, oracle and per-page checks. Never imported by product
 * code or the production build; variants are selected only by this caller. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SOURCE_PATCHES } from './vendor-analytics-kernels.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function loadReductionHarness({ oracle = false, check = false } = {}) {
  const file = join(root, 'vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11.ts');
  let source = await readFile(file, 'utf8');
  if (oracle) for (const hunk of [...SOURCE_PATCHES.find(patch => patch.id === 'reduction-payload-bytes').hunks].reverse()) {
    assert.equal(source.split(hunk.replace).length - 1, 1); source = source.replace(hunk.replace, hunk.find);
  }
  source += '\nexport const reductionChecks: Array<{rows:number;bytes:number;oracle:number}> = [];\nexport { Hazards, reductionPayloadBytes };\n';
  source += 'export { appendEffectiveQuotaDay, finishEffectiveQuotaDay, foldEffectiveQuotaDays, mapEffectiveQuotaPageRow } from "./effective-quota-day";\n';
  if (!oracle) source += 'export { ReductionByteMap, ReductionByteSet, reductionJsonBytes };\n';
  if (check) {
    const needle = '    const retainedEntries=previous.size+hazards.size+scalarBuckets.size+modelCosts.size+poisoned.size;';
    assert.equal(source.split(needle).length - 1, 1);
    source = source.replace(needle, needle + `
    const actualBytes = reductionPayloadBytes(previous,hazards,scalarBuckets,modelCosts,poisoned);
    const oracleBytes = new TextEncoder().encode(JSON.stringify({previous:[...previous],hazards:serializeHazards(hazards),
      scalarBuckets:[...scalarBuckets],modelCosts:[...modelCosts],poisoned:[...poisoned]})).byteLength;
    if (actualBytes !== oracleBytes) throw new Error("REDUCTION_BYTE_CHECK_MISMATCH");
    reductionChecks.push({rows:state.rowsRead,bytes:actualBytes,oracle:oracleBytes});`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'tibo-model-residue-check-'));
  const outfile = join(directory, 'kernel.mjs');
  try {
    await build({ stdin: { contents: source, resolveDir: dirname(file), sourcefile: file, loader: 'ts' },
      outfile, mainFields: ['module', 'main'], bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      tsconfig: join(root, 'vendor/analytics-d43c8f92/tsconfig.json') });
    const module = await import(pathToFileURL(outfile).href);
    return { module, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export function payloadOracle(previous, hazards, scalarBuckets, modelCosts, poisoned) {
  return Buffer.byteLength(JSON.stringify({previous:[...previous], hazards:hazards.snapshot(),
    scalarBuckets:[...scalarBuckets],modelCosts:[...modelCosts],poisoned:[...poisoned]}));
}
