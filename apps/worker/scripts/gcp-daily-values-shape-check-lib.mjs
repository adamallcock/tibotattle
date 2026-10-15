/** Harness-only closed-shape baseline and candidate facades. Never imported
 * by product code or included in the production kernel closure. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SOURCE_PATCHES, sourcePatchRecord } from './vendor-analytics-kernels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(root, 'vendor/analytics-d43c8f92');
const sourcePath = 'apps/worker/src/v11-daily-projection-values.ts';
const patchId = 'daily-values-ordered-closed-shape';
const patchSha256 = 'a00c3e6109b305a2f10d14b08dc3cdd78f14075a30b3eaeb7dd93a2547810d16';
const digest = value => createHash('sha256').update(value).digest('hex');
const occurrences = (text, part) => text.split(part).length - 1;

// Known schema keys are harness-only. Baseline shape access cannot depend on
// the new production declarations, which are removed with all ten hunks.
const harnessKeys = `const HARNESS_CLOSED_KEYS = {
  tokens: TOKEN_KEYS,
  token: ['knownSum','unavailable'],
  pricing: ['knownNanousd','fullyPriced','partiallyPriced','unpriced'],
  current: ['schemaVersion','day','pricingMethodVersion','registrySha256','counts','tokens','pricing','cells','omitted'],
  counts: ['usage','quota','session'],
  omitted: ['usageEvents','tokens','pricing'],
  cell: ['provider','modelId','usageEvents','tokens','pricing'],
  legacy: ['schemaVersion','day','pricingMethodVersion','registrySha256','counts','tokens','pricing','cells'],
} as const;
export const closedShapeKeys = Object.fromEntries(Object.entries(HARNESS_CLOSED_KEYS)
  .map(([name, keys]) => [name, [...keys]]));
`;

export async function loadDailyValuesShapeHarness({ oracle = false } = {}) {
  const file = join(vendorRoot, sourcePath);
  const bytes = await readFile(file);
  const manifest = JSON.parse(await readFile(join(vendorRoot, 'MANIFEST.json'), 'utf8'));
  const files = manifest.files.filter(entry => entry.path === sourcePath);
  assert.equal(files.length, 1, 'daily-values source provenance is unique');
  assert.equal(digest(bytes), files[0].sha256, 'daily-values source agrees with its manifest');
  const patches = SOURCE_PATCHES.filter(patch => patch.id === patchId && patch.path === sourcePath);
  assert.equal(patches.length, 1, 'one reviewed ordered-shape patch');
  const patch = patches[0];
  assert.equal(patch.hunks.length, 10);
  const record = sourcePatchRecord(patch);
  assert.equal(record.sha256, patchSha256, 'the baseline reverses the reviewed ten exact hunks');
  assert.deepEqual(manifest.sourcePatches.filter(entry => entry.id === patchId && entry.path === sourcePath), [record]);
  let source = bytes.toString('utf8');
  for (const hunk of patch.hunks) assert.equal(occurrences(source, hunk.replace), 1);
  if (oracle) {
    const candidate = source;
    for (const hunk of [...patch.hunks].reverse()) {
      assert.equal(occurrences(source, hunk.replace), 1);
      source = source.replace(hunk.replace, () => hunk.find);
    }
    let restored = source;
    for (const hunk of patch.hunks) {
      assert.equal(occurrences(restored, hunk.find), 1);
      restored = restored.replace(hunk.find, () => hunk.replace);
    }
    assert.equal(restored, candidate, 'reversing only this patch recovers the exact candidate');
  }
  source += '\n' + harnessKeys;
  source += oracle
    ? 'export function privateClosedShape(value: unknown, schema: keyof typeof HARNESS_CLOSED_KEYS) { closed(value, HARNESS_CLOSED_KEYS[schema]); }\n'
    : 'export function privateClosedShape(value: unknown, schema: keyof typeof HARNESS_CLOSED_KEYS) { closed(value, PRIVATE_CLOSED_KEYS[schema], PRIVATE_CLOSED_SIGNATURES[schema]); }\n';
  const directory = await mkdtemp(join(tmpdir(), 'tibo-daily-values-shape-check-'));
  const outfile = join(directory, 'kernel.mjs');
  try {
    // Resolve beside the original vendor file, preserving the vendored package
    // bindings; only the owned temporary bundle contains harness-only exports.
    const result = await build({ stdin: { contents: source, resolveDir: dirname(file), sourcefile: file, loader: 'ts' },
      outfile, write: false, mainFields: ['module', 'main'], bundle: true, platform: 'node', format: 'esm',
      target: 'node22', logLevel: 'silent', tsconfig: join(vendorRoot, 'tsconfig.json') });
    assert.equal(result.outputFiles.length, 1);
    const handle = await open(outfile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(result.outputFiles[0].contents); }
    finally { await handle.close(); }
    const module = await import(pathToFileURL(outfile).href);
    return { module, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
