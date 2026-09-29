import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadBundle(imports) {
  const result = await build({
    stdin: { contents: `${imports}\nexport const check = {
      preview: MODEL_BLOCK_PREVIEW_DAYS,
      adminPreview: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS,
      ranges: planHistoricalModelBlockRanges('2026-09-29'),
    };`, resolveDir: workerRoot, sourcefile: 'analytics-model-block-bundle-check.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    mainFields: ['module', 'main'], logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 1);
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`;
  return (await import(url)).check;
}

const expected = [
  { outputFromDay: '2026-07-22', outputThroughDay: '2026-08-06' },
  { outputFromDay: '2026-08-07', outputThroughDay: '2026-09-07' },
  { outputFromDay: '2026-09-08', outputThroughDay: '2026-09-28' },
];

test('standalone model contract and status-first bundles retain the 70-day horizon', async () => {
  const shared = `import { MODEL_BLOCK_PREVIEW_DAYS, planHistoricalModelBlockRanges }
    from './src/analytics-model-block-contract.ts';
    import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS }
    from './src/admin-community-allowance.ts';`;
  const entries = [shared, `import { readStorageCommunityProgress }
    from './src/storage-community-progress.ts';
    import { advanceNextStorageCommunityDaily }
    from './src/storage-community-daily.ts';
    export const statusEntrypoints = [readStorageCommunityProgress, advanceNextStorageCommunityDaily];
    ${shared}`];
  for (const imports of entries) {
    const result = await loadBundle(imports);
    assert.equal(result.preview, 70);
    assert.equal(result.adminPreview, 70);
    assert.deepEqual(result.ranges, expected);
    const coveredDays = result.ranges.reduce((count, range) =>
      count + (Date.parse(`${range.outputThroughDay}T00:00:00Z`)
        - Date.parse(`${range.outputFromDay}T00:00:00Z`)) / 86_400_000 + 1, 0);
    assert.equal(coveredDays, 69);
  }
});
