import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build as esbuild } from 'esbuild';
import { deriveAnalyticsV2PreparedDayClass } from './analytics-v2-prepared-day-class.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await deriveAnalyticsV2PreparedDayClass();
const mutate = (name) => deriveAnalyticsV2PreparedDayClass({ read: async (path) => {
  const bytes = await readFile(path);
  return path === resolve(ROOT, name) ? Buffer.concat([bytes, Buffer.from('\n// synthetic producer class mutation\n')]) : bytes;
} });

test('producer class hashes the exact artifact and real composed graph without wiring source classes', async () => {
  const again = await deriveAnalyticsV2PreparedDayClass();
  assert.deepEqual(again, base);
  const names = new Set(base.inputs.map(({ name }) => name));
  for (const name of ['apps/worker/src/analytics-v2/store-prepared-day.ts',
    'apps/worker/vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11.ts',
    'apps/worker/vendor/analytics-d43c8f92/apps/worker/src/effective-usage-day.ts',
    'apps/worker/src/analytics-v2/fast-pricer.ts',
    'apps/worker/cloud-run/node-host-primitives.mjs',
    'apps/worker/cloud-run/analytics-fast-pricer-binding.mjs']) assert.ok(names.has(name), name);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(base.bundleText).toString('base64')}`);
  for (const name of ['preparedDayFeatures', 'encodeAnalyticsV2PreparedDay', 'decodeAnalyticsV2PreparedDay',
    'preparedDayReader', 'mapEffectiveUsagePageRow', 'prepareV11UsageFeature', 'sha256Hex',
    'analyticsV2PricingClass', 'analyticsV2KernelPriceCards']) assert.equal(typeof runtime[name], 'function', name);
  assert.equal(runtime.analyticsV2BundledPricer(), null, 'source run stays unknown');
  assert.equal(await runtime.analyticsV2PreparedDayClass({ producerSha256: null }), null);
  assert.equal((await runtime.analyticsV2PreparedDayClass({ producerSha256: base.producerSha256 })).classSha256, base.producerClassSha256);
});

test('comments in producer, mapper, codec and binding policy change the class despite unchanged emitted code', async () => {
  for (const name of ['apps/worker/vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11.ts',
    'apps/worker/vendor/analytics-d43c8f92/apps/worker/src/effective-usage-day.ts',
    'apps/worker/src/analytics-v2/store-prepared-day.ts',
    'apps/worker/cloud-run/analytics-fast-pricer-binding.mjs']) {
    const changed = await mutate(name);
    assert.notEqual(changed.producerSha256, base.producerSha256, name);
    assert.notEqual(changed.producerClassSha256, base.producerClassSha256, name);
    assert.equal(changed.bundleSha256, base.bundleSha256, 'comment-only mutation preserves artifact');
  }
});

test('unrelated owner compute, occurrence reader and native composition do not change producer class', async () => {
  for (const name of ['apps/worker/src/analytics-v2/compute-owner.ts',
    'apps/worker/src/analytics-v2/occurrence-source.ts', 'apps/worker/src/analytics-v2/native-path.ts']) {
    assert.ok(!base.inputs.some((input) => input.name === name), name);
    assert.deepEqual(await mutate(name), base, name);
  }
});

test('a missing fast-pricer binding fails closed before executing the artifact', async () => {
  await assert.rejects(deriveAnalyticsV2PreparedDayClass({ build: async () => ({
    outputFiles: [{ text: '' }], metafile: { inputs: {}, outputs: { 'producer.js': { inputs: {},
      imports: [{ path: 'unreviewed-third-party', external: true }] } } },
  }) }), /ANALYTICS_FAST_PRICER_BINDING_MISSING/u);
});


test('an unresolved external dependency fails closed despite a valid fast-pricer graph', async () => {
  await assert.rejects(deriveAnalyticsV2PreparedDayClass({ build: async (options) => {
    const result = await esbuild(options);
    Object.values(result.metafile.outputs)[0].imports.push({ path: 'unreviewed-third-party', external: true });
    return result;
  } }), /PREPARED_DAY_CLASS_UNRESOLVED_DEPENDENCY/u);
});
