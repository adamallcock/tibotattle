/** Offline derivation only: never supplies build defines or registers a kernel. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { analyticsPricerBundleOptions } from '../cloud-run/analytics-kernel-closure.mjs';
import { cloudRunBuildPlugins } from '../cloud-run/node-host-build.mjs';
import { assertAnalyticsFastPricerBinding, FAST_PRICER_BINDING_POLICY } from '../cloud-run/analytics-fast-pricer-binding.mjs';
import { assertTelemetryByteBoundsBinding, TELEMETRY_BYTE_BOUNDS_POLICY, telemetryByteBoundsSource } from '../cloud-run/telemetry-byte-bounds-binding.mjs';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WORKER, '../..');
const VENDOR = resolve(WORKER, 'vendor/analytics-d43c8f92');
const METHOD = 'analytics-v2-prepared-day-producer-bundle-v1';
const ENTRY = '<analytics-v2-prepared-day-producer-entry>';
const ENTRY_TEXT = `
export { preparedDayFeatures, encodeAnalyticsV2PreparedDay, decodeAnalyticsV2PreparedDay,
 preparedDayReader, analyticsV2PreparedDayClass, ANALYTICS_V2_PREPARED_DAY_CODEC }
 from './src/analytics-v2/store-prepared-day';
export { mapEffectiveUsagePageRow } from './vendor/analytics-d43c8f92/apps/worker/src/effective-usage-day';
export { prepareV11UsageFeature, validV11UsageFeature } from './vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11';
export { sha256Hex } from './src/crypto';
export { analyticsV2BundledPricer, analyticsV2PricingClass } from './src/analytics-v2/kernel';
export { analyticsV2KernelPriceCards, ANALYTICS_V2_PRICE_PROJECTION_VERSION }
 from './src/analytics-v2/price-attribution';
`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

/** Exact artifact plus exact reached source bytes and composition policy.
 * No pure/sideEffects override: this pass retains real module initialization.
 * `read` injects source mutations for checks without writing a checkout.
 * The adapter must execute bundleText, never a separately compiled substitute.
 */
export async function deriveAnalyticsV2PreparedDayClass({ build = esbuild, read = readFile } = {}) {
  const options = analyticsPricerBundleOptions({ vendorRoot: VENDOR, cwd: WORKER, pure: false,
    options: { platform: 'node', target: 'node22', mainFields: ['module', 'main'], logLevel: 'silent',
      plugins: cloudRunBuildPlugins(WORKER, { read }) } });
  options.stdin = { contents: ENTRY_TEXT, sourcefile: ENTRY, resolveDir: WORKER, loader: 'js' };
  options.plugins.push({ name: 'offline-producer-source', setup(pass) {
    pass.onLoad({ filter: /\.(?:[cm]?js|ts|json)$/ }, async ({ path }) => ({
      contents: Buffer.from(await read(path)).toString('utf8'),
      loader: extname(path) === '.ts' ? 'ts' : extname(path) === '.json' ? 'json' : 'js',
    }));
  } });
  const result = await build(options);
  if (result.outputFiles?.length !== 1 || Object.keys(result.metafile?.outputs ?? {}).length !== 1) fail('PREPARED_DAY_CLASS_OUTPUT_INVALID');
  assertAnalyticsFastPricerBinding(result.metafile, WORKER);
  assertTelemetryByteBoundsBinding(result.metafile, { workerRoot: WORKER, cwd: WORKER });
  const output = Object.values(result.metafile.outputs)[0];
  for (const item of output.imports ?? []) {
    if (!item.external || !builtins.has(item.path.replace(/^node:/u, ''))) {
      fail('PREPARED_DAY_CLASS_UNRESOLVED_DEPENDENCY');
    }
  }
  const reached = new Set(Object.keys(output.inputs).map((name) => resolve(WORKER, name)));
  if (reached.has(telemetryByteBoundsSource(WORKER))) reached.add(TELEMETRY_BYTE_BOUNDS_POLICY);
  // Composition policy is not an emitted module, but controls actual bindings.
  reached.add(FAST_PRICER_BINDING_POLICY);
  reached.add(resolve(WORKER, 'cloud-run/node-host-build.mjs'));
  reached.add(resolve(WORKER, 'cloud-run/analytics-kernel-closure.mjs'));
  reached.add(fileURLToPath(import.meta.url));
  const inputs = [];
  for (const path of [...reached].sort()) {
    if (path === resolve(WORKER, ENTRY)) continue;
    const name = relative(ROOT, path).split(sep).join('/');
    if (name.startsWith('../')) fail('PREPARED_DAY_CLASS_OUTSIDE_CHECKOUT');
    const bytes = await read(path);
    inputs.push(Object.freeze({ name, sha256: hash(bytes) }));
  }
  inputs.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const bundleText = result.outputFiles[0].text;
  const bundleSha256 = hash(bundleText);
  const runtime = Object.freeze({ node: process.versions.node, target: 'node22', esbuild: (await import('esbuild')).version });
  const bindings = Object.freeze({ fastPricer: 'reviewed-consumer-only', host: 'cloud-run-node-host', sideEffects: 'real-module-semantics' });
  const producerSha256 = hash(JSON.stringify([METHOD, ENTRY_TEXT, runtime, bindings, inputs, bundleSha256]));
  // Builtins only: no output file, provider call or source data execution.
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundleText).toString('base64')}`);
  const codecVersion = module.ANALYTICS_V2_PREPARED_DAY_CODEC;
  const producerClass = await module.analyticsV2PreparedDayClass({ producerSha256, codecVersion });
  if (!producerClass || !/^[a-f0-9]{64}$/u.test(producerClass.classSha256)) fail('PREPARED_DAY_CLASS_INVALID');
  return Object.freeze({ method: METHOD, producerSha256, producerClassSha256: producerClass.classSha256,
    codecVersion, bundleSha256, bundleText, inputs: Object.freeze(inputs), bindings, runtime });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { bundleText: _text, ...identity } = await deriveAnalyticsV2PreparedDayClass();
  console.log(JSON.stringify(identity));
}
