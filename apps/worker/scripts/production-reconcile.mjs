import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { createProductionLiveProvider } from './production-live-provider.mjs';
import { createProductionLiveConfigSnapshot, renderProductionLiveConfig,
  verifyProductionLiveConfig } from './production-live-config.mjs';
import { buildTypedProductionExpectedSchemas } from './production-typed-schema.mjs';
import { runTypedProductionPreflight, TYPED_PRODUCTION_ROLE_BINDINGS } from './production-typed-preflight.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
// Edge-mode support loads only when --edge-mode is given, so an ordinary
// inspection keeps today's module graph.
const loadEdgeMode = () => import('./production-edge-mode.mjs');
const fail = code => { const error = new Error(code); error.code = code; throw error; };

/** Inspection only. This operation has no Wrangler deployment, migration,
 * trigger update, PR write, or release coordination mutation. A compatible
 * result is evidence for integration, never permission to publish. */
export async function reconcileProductionCandidate({
  inventory, trackedConfig, sourceCommit, expectedPreviousSourceCommit,
  workerDirectory, sourceClean, provider,
  buildSchemas = buildTypedProductionExpectedSchemas,
  inspectTyped = runTypedProductionPreflight,
  configTools = { createSnapshot: createProductionLiveConfigSnapshot,
    render: renderProductionLiveConfig, verify: verifyProductionLiveConfig },
  edgeMode = undefined, edgePlan = undefined,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')
      || !/^[a-f0-9]{40}$/.test(expectedPreviousSourceCommit ?? '')
      || typeof sourceClean !== 'boolean') fail('PRODUCTION_RECONCILE_SOURCE_INVALID');
  // --edge-mode inspects the candidate an edge deploy would install: the EP-9
  // overlay on the typed render, verified against the expected post-deploy
  // snapshot, with no typed storage reads in gcp mode (no role is bound).
  let edge = null;
  if (edgeMode !== undefined || edgePlan !== undefined) {
    const edgeModule = await loadEdgeMode();
    const { mode, plan, overlaySha256 } = edgeModule.resolveEdgeModeRequest({ edgeMode, edgePlan });
    edge = { mode, overlaySha256,
      tools: edgeModule.createEdgeModeConfigTools({ mode, plan, trackedConfig, base: configTools }),
      inspect: edgeModule.edgeModeTypedInspector({ mode, inspectTyped }) };
  }
  const renderTools = edge?.tools ?? configTools;
  const baseline = configTools.createSnapshot(inventory);
  if (baseline.sourceCommit !== expectedPreviousSourceCommit) fail('PRODUCTION_RECONCILE_PREDECESSOR_MISMATCH');
  const currentInventory = await provider.capture();
  const current = configTools.createSnapshot(currentInventory);
  if (current.versionId !== baseline.versionId || current.sourceCommit !== baseline.sourceCommit
      || current.fingerprint !== baseline.fingerprint) fail('PRODUCTION_RECONCILE_LIVE_CHANGED');
  const candidateConfig = renderTools.render({ trackedConfig, snapshot: current, sourceCommit });
  const preservation = renderTools.verify({ snapshot: current, candidateConfig, sourceCommit });
  if (!preservation.ok) fail('PRODUCTION_RECONCILE_CONFIG_UNVERIFIED');
  const expected = await buildSchemas({ workerDirectory });
  const production = candidateConfig.env.production;
  const typed = await (edge?.inspect ?? inspectTyped)({
    roles: Object.entries(TYPED_PRODUCTION_ROLE_BINDINGS).map(([role, binding]) => ({ role, binding })),
    expectedSchemas: expected.expectedSchemas,
    config: { mode: production.vars.TELEMETRY_STORAGE_MODE,
      sourceNamespace: production.vars.TELEMETRY_STORAGE_NAMESPACE },
    runQuery: (binding, sql) => provider.query(currentInventory, binding, sql),
  });
  const after = configTools.createSnapshot(await provider.capture());
  if (after.versionId !== current.versionId || after.sourceCommit !== current.sourceCommit
      || after.fingerprint !== current.fingerprint) fail('PRODUCTION_RECONCILE_LIVE_CHANGED');
  const report = {
    schema: 'production-reconciliation-v1',
    state: typed.ok && sourceClean ? 'compatible' : 'blocked',
    sourceCommit, previousSourceCommit: current.sourceCommit,
    sourceClean,
    liveConfigurationFingerprint: current.fingerprint,
    candidateConfigSha256: sha256(JSON.stringify(candidateConfig)),
    configurationPreserved: true,
    publicAssetsVerified: false,
    typed,
    schemaInputSha256: expected.inputSha256,
    productionWritesPerformed: false,
    deploymentPerformed: false,
    deploymentQualified: false,
    remainingGate: 'Guarded deployment integration, immutable candidate and owning surface qualification',
    ...(edge === null ? {} : { edge: { edgeMode: edge.mode, edgeOverlaySha256: edge.overlaySha256,
      expectedLiveConfigurationFingerprint: edge.tools.expectedSnapshot(current).fingerprint } }),
  };
  return { report, candidateConfig };
}

// Optional edge inspection arguments: --edge-mode MODE [--edge-plan PRIVATE_JSON] (gcp).
const EDGE_FIELDS = new Map([['--edge-mode', 'edgeMode'], ['--edge-plan', 'edgePlanPath']]);

export function parseProductionReconciliationArgs(args) {
  const fields = new Map([['--inventory', 'inventoryPath'], ['--inventory-sha256', 'inventorySha256'],
    ['--expected-previous-source', 'expectedPreviousSourceCommit'], ['--output-directory', 'outputDirectory']]);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = fields.get(args[index]) ?? EDGE_FIELDS.get(args[index]);
    const value = args[++index];
    if (!key || key in result || !value || value.startsWith('--') || value.includes('\0')) fail('PRODUCTION_RECONCILE_ARGUMENTS_INVALID');
    result[key] = value;
  }
  const edgeKeys = [...EDGE_FIELDS.values()].filter(key => key in result);
  if (Object.keys(result).length - edgeKeys.length !== fields.size || !/^[a-f0-9]{64}$/.test(result.inventorySha256)
      || !/^[a-f0-9]{40}$/.test(result.expectedPreviousSourceCommit)) fail('PRODUCTION_RECONCILE_ARGUMENTS_INVALID');
  if (edgeKeys.length > 0 && (!['worker', 'fenced', 'gcp'].includes(result.edgeMode)
      || (result.edgeMode === 'gcp') !== ('edgePlanPath' in result))) fail('PRODUCTION_RECONCILE_ARGUMENTS_INVALID');
  return result;
}

export async function readPrivateProductionInventory(path, expectedSha256) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 2_000_000
      || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail('PRODUCTION_RECONCILE_INVENTORY_UNSAFE');
  const bytes = await readFile(path);
  if (bytes.length !== info.size || sha256(bytes) !== expectedSha256) fail('PRODUCTION_RECONCILE_INVENTORY_CHANGED');
  try { return JSON.parse(bytes); } catch { fail('PRODUCTION_RECONCILE_INVENTORY_INVALID'); }
}

export async function createPrivateReconciliationOutputDirectory(requested) {
  const absolute = resolve(requested);
  const parent = await realpath(dirname(absolute));
  const parentInfo = await lstat(parent);
  const uid = process.getuid?.();
  // Root-owned sticky temporary directories are safe parents for an exclusive
  // new owner-only child. Other writable/shared parents could replace it.
  const safeTemporaryParent = parentInfo.uid === 0 && (parentInfo.mode & 0o1000) !== 0;
  if (!parentInfo.isDirectory() || (!safeTemporaryParent
    && ((uid !== undefined && parentInfo.uid !== uid) || (parentInfo.mode & 0o022) !== 0))) {
    fail('PRODUCTION_RECONCILE_OUTPUT_UNSAFE');
  }
  const directory = join(parent, basename(absolute));
  await mkdir(directory, { mode: 0o700 }); // Existing directories are refused.
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0
    || (uid !== undefined && info.uid !== uid) || await realpath(directory) !== directory) {
    fail('PRODUCTION_RECONCILE_OUTPUT_UNSAFE');
  }
  return directory;
}

async function main() {
  try {
    const options = parseProductionReconciliationArgs(process.argv.slice(2));
    const inventory = await readPrivateProductionInventory(options.inventoryPath, options.inventorySha256);
    const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
    const git = args => execFileSync('git', args, { cwd: workerDirectory, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
    const sourceCommit = git(['rev-parse', 'HEAD']);
    const sourceClean = git(['status', '--porcelain', '--untracked-files=all']) === '';
    const parseErrors = [];
    const trackedConfig = parse(await readFile(join(workerDirectory, 'wrangler.jsonc'), 'utf8'), parseErrors);
    if (parseErrors.length) fail('PRODUCTION_RECONCILE_CONFIG_INVALID');
    const provider = createProductionLiveProvider({ accountId: inventory.accountId, workerName: inventory.workerName });
    const edgeOptions = options.edgeMode === undefined ? {} : {
      edgeMode: options.edgeMode,
      ...(options.edgePlanPath === undefined
        ? {}
        : { edgePlan: await (await loadEdgeMode()).readEdgeModePlan(options.edgePlanPath) }),
    };
    const { report, candidateConfig } = await reconcileProductionCandidate({ inventory, trackedConfig, sourceCommit,
      expectedPreviousSourceCommit: options.expectedPreviousSourceCommit, workerDirectory, sourceClean, provider,
      ...edgeOptions });
    if (git(['rev-parse', 'HEAD']) !== sourceCommit
      || (git(['status', '--porcelain', '--untracked-files=all']) === '') !== sourceClean) fail('PRODUCTION_RECONCILE_SOURCE_CHANGED');
    // Exclusive creation preserves existing evidence; config contains private
    // binding identities and is never emitted to stdout or committed.
    const directory = await createPrivateReconciliationOutputDirectory(options.outputDirectory);
    await writeFile(join(directory, 'candidate-config.json'), `${JSON.stringify(candidateConfig, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.state === 'compatible' ? 0 : 1;
  } catch (error) {
    const code = /^(?:PRODUCTION|TYPED_PREFLIGHT|EDGE)_[A-Z_]+$/.test(error?.code ?? '')
      ? error.code : 'PRODUCTION_RECONCILE_FAILED';
    process.stdout.write(`${JSON.stringify({ state: 'blocked', code, productionWritesPerformed: false })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
