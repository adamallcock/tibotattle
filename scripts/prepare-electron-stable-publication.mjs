#!/usr/bin/env node
/** Local final-byte plan and read-only public verification; no upload adapter. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import distribution from '../config/electron-production-distribution.cjs';
import { DEPLOYMENT_ENDPOINTS } from '../config/deployment-endpoints.js';
import { productionElectronCandidatePlan } from './package-electron-production.mjs';
import { parseWindowsUpdaterYaml, validateWindowsUpdateArtifactMetadata } from './verify-electron-windows-update-artifacts.mjs';
import { identityDigest, openOperation } from './lib/release-operation.mjs';

export const STABLE_TARGETS = Object.freeze(Object.keys(distribution.PRODUCTION_ELECTRON_TARGETS));
const HASH = /^[a-f0-9]{64}$/u;
const MAX = 2 * 1024 ** 3;
const SMALL = 128 * 1024;
const fail = (code) => { throw Object.assign(new Error(`ELECTRON_STABLE_PUBLICATION_${code}`), { code: `ELECTRON_STABLE_PUBLICATION_${code}` }); };
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const leaf = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(v);
const feedName = target => target.startsWith('darwin-') ? 'latest-mac.yml' : target === 'linux-x64' ? 'latest-linux.yml' : 'latest.yml';
const mime = name => name.endsWith('.yml') ? 'application/yaml' : name.endsWith('.zip') ? 'application/zip' : name.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/octet-stream';
const older = (left, right) => {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; }
  return false;
};
const cache = name => name.endsWith('.yml') ? 'public, max-age=300, must-revalidate' : 'public, max-age=31536000, immutable';

async function file(root, spec, maximum = MAX, keep = false) {
  if (!exact(spec, ['path', 'sha256', 'bytes']) || typeof spec.path !== 'string' || spec.path.includes('\\')
      || spec.path.split('/').some(p => !leaf(p)) || !HASH.test(spec.sha256)
      || !Number.isSafeInteger(spec.bytes) || spec.bytes < 1 || spec.bytes > maximum) fail('FILE_SPEC_INVALID');
  const path = resolve(root, spec.path);
  if (!path.startsWith(`${root}${sep}`) || await realpath(path) !== path) fail('FILE_PATH_INVALID');
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size !== spec.bytes) fail('FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('FILE_CHANGED');
    const sha256 = createHash('sha256'), sha512 = createHash('sha512'), chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > spec.bytes) fail('FILE_CHANGED');
      sha256.update(chunk); sha512.update(chunk); if (keep) chunks.push(chunk);
    }
    const after = await handle.stat(), named = await lstat(path);
    const digest = sha256.digest('hex');
    if (bytes !== spec.bytes || digest !== spec.sha256 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail('FINAL_BYTES_MISMATCH');
    return { name: basename(path), bytes, sha256: digest, sha512: sha512.digest('base64'), ...(keep ? { contents: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}
function parseJson(bytes) { try { return JSON.parse(bytes); } catch { fail('JSON_INVALID'); } }
function validateManifest(manifest, version, artifacts, target) {
  if (!manifest || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== artifacts.length
      || Object.hasOwn(manifest, 'packages') || new Set(manifest.files.map(f => f?.url)).size !== artifacts.length) fail('MANIFEST_INVALID');
  for (const entry of manifest.files) {
    const artifact = artifacts.find(a => a.name === entry?.url);
    if (!artifact || entry.sha512 !== artifact.sha512 || (Object.hasOwn(entry, 'size') && entry.size !== artifact.bytes)) fail('MANIFEST_BYTES_MISMATCH');
  }
  const primary = artifacts.find(a => a.name === manifest.path);
  const extension = target.startsWith('darwin-') ? '.zip' : target === 'linux-x64' ? '.AppImage' : '.exe';
  if (!primary?.name.endsWith(extension) || manifest.sha512 !== primary.sha512) fail('MANIFEST_PRIMARY_INVALID');
}

export async function prepareElectronStablePublication({ artifactRoot, proposal }) {
  const root = await realpath(resolve(artifactRoot));
  if (!exact(proposal, ['schemaVersion', 'sourceRevision', 'version', 'buildNumber', 'targets'])
      || proposal.schemaVersion !== 'tibotattle-electron-stable-publication-v1'
      || !/^[a-f0-9]{40}$/u.test(proposal.sourceRevision) || !distribution.PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(proposal.version)
      || !Array.isArray(proposal.targets) || proposal.targets.length !== 4
      || proposal.targets.map(t => t.target).sort().join() !== [...STABLE_TARGETS].sort().join()) fail('PROPOSAL_INVALID');
  const targets = [];
  for (const input of proposal.targets) {
    if (!exact(input, ['target', 'sourceCandidate', 'appUpdate', 'manifest', 'artifacts', 'predecessor', 'evidence'])
        || !Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 4
        || !Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 8) fail('TARGET_INVALID');
    const source = parseJson((await file(root, input.sourceCandidate, SMALL, true)).contents);
    let expected;
    try { expected = productionElectronCandidatePlan({ target: input.target, sourceRevision: proposal.sourceRevision,
      buildNumber: proposal.buildNumber, hostPlatform: source.host?.platform, hostArchitecture: source.host?.architecture }); }
    catch { fail('SOURCE_INVALID'); }
    const staged = { ...expected, ...(expected.nativeHandoverHelper ? { nativeHandoverHelper: { ...expected.nativeHandoverHelper, status: 'contract_ok' } } : {}),
      ...(expected.nativeMacOSKeychainAdapter ? { nativeMacOSKeychainAdapter: { ...expected.nativeMacOSKeychainAdapter, status: 'source_compiled_unsigned' } } : {}),
      status: 'production_source_staged', stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
    if (!isDeepStrictEqual(source, staged) || source.version !== proposal.version) fail('SOURCE_INVALID');
    const feedURL = distribution.PRODUCTION_ELECTRON_TARGETS[input.target].feedURL;
    const appUpdate = parseWindowsUpdaterYaml((await file(root, input.appUpdate, SMALL, true)).contents);
    if (appUpdate.provider !== 'generic' || appUpdate.url !== feedURL
        || Object.keys(appUpdate).some(k => !['provider', 'url', 'updaterCacheDirName', 'publisherName'].includes(k))) fail('APP_UPDATE_INVALID');
    const artifacts = [];
    for (const spec of input.artifacts) artifacts.push(await file(root, spec));
    const names = input.target.startsWith('darwin-')
      ? ['dmg', 'zip'].flatMap(ext => [`TiboTattle-${proposal.version}-mac-${input.target.slice(7)}.${ext}`, `TiboTattle-${proposal.version}-mac-${input.target.slice(7)}.${ext}.blockmap`])
      : [input.target === 'win32-x64' ? `TiboTattle-${proposal.version}-Windows-x64.exe` : `TiboTattle-${proposal.version}-linux-x64.AppImage`];
    const actual = artifacts.map(a => a.name).sort();
    const allowed = input.target === 'win32-x64' && actual.length === 2 ? [...names, `${names[0]}.blockmap`] : names;
    if (actual.join() !== allowed.sort().join()) fail('ARTIFACT_SET_INVALID');
    const manifestFile = await file(root, input.manifest, SMALL, true);
    if (manifestFile.name !== feedName(input.target)) fail('FEED_NAME_INVALID');
    const manifest = parseWindowsUpdaterYaml(manifestFile.contents);
    const primaryArtifacts = artifacts.filter(a => !a.name.endsWith('.blockmap'));
    validateManifest(manifest, proposal.version, primaryArtifacts, input.target);
    if (input.target === 'win32-x64') validateWindowsUpdateArtifactMetadata({ manifest, appUpdate, installer: primaryArtifacts[0], version: proposal.version });
    const evidence = [];
    for (const spec of input.evidence) { const bound = await file(root, spec, 1024 * 1024); evidence.push({ sha256: bound.sha256, bytes: bound.bytes }); }
    let predecessor = null;
    if (input.predecessor !== null) {
      const old = await file(root, input.predecessor, SMALL, true);
      const parsed = parseWindowsUpdaterYaml(old.contents);
      if (!distribution.PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(parsed.version ?? '') || !older(parsed.version, proposal.version)
          || !Array.isArray(parsed.files) || parsed.files.length < 1 || parsed.files.some(f => !leaf(f?.url) || !/^[A-Za-z0-9+/]{86}==$/u.test(f?.sha512 ?? '')) || !leaf(parsed.path)
          || parsed.sha512 !== parsed.files.find(f => f.url === parsed.path)?.sha512 || Object.hasOwn(parsed, 'packages')) fail('PREDECESSOR_INVALID');
      const previousNames = input.target.startsWith('darwin-')
        ? ['zip', 'dmg'].map(ext => `TiboTattle-${parsed.version}-mac-${input.target.slice(7)}.${ext}`)
        : [input.target === 'win32-x64' ? `TiboTattle-${parsed.version}-Windows-x64.exe` : `TiboTattle-${parsed.version}-linux-x64.AppImage`];
      if (parsed.path !== previousNames[0] || parsed.files.map(f => f.url).sort().join() !== [...previousNames].sort().join()) fail('PREDECESSOR_INVALID');
      predecessor = { sha256: old.sha256, bytes: old.bytes, localPath: input.predecessor.path };
    }
    const prefix = new URL(feedURL).pathname.slice(1);
    const object = (a, path) => ({ objectKey: `${prefix}/${a.name}`, localPath: path, sha256: a.sha256, bytes: a.bytes, contentType: mime(a.name), cacheControl: cache(a.name) });
    targets.push({ target: input.target, feedURL, evidence, artifacts: artifacts.map((a, i) => object(a, input.artifacts[i].path)),
      feed: object(manifestFile, input.manifest.path), predecessor,
      rollback: predecessor === null ? 'remove_exact_new_feed_only' : 'restore_exact_predecessor_feed_only' });
  }
  return { schemaVersion: 'tibotattle-electron-stable-publication-plan-v1', proposalSha256: identityDigest(proposal),
    sourceRevision: proposal.sourceRevision, version: proposal.version, buildNumber: proposal.buildNumber,
    bucket: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket, origin: distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN,
    targets, preserve: ['appcast.xml', 'intel/appcast.xml', 'preview/**', 'electron/rehearsal/**', 'all previously published installers'],
    order: ['verify_exact_predecessors', 'create_or_verify_immutable_artifacts', 'verify_all_artifacts', 'recheck_each_predecessor_then_replace_feed', 'verify_all_feeds'],
    writeConcurrency: 'exclusive_operator_required_no_R2_compare_and_swap', rollbackBoundary: 'feed_discovery_only_no_installed_downgrade',
    status: 'local_bytes_bound', nativeTrust: 'separate_evidence_review_required', sourceProvenance: 'separate_commit_and_artifact_review_required', published: false };
}

/** GET-only transport; callers must separately authorize invoking this network mode. */
export async function verifyElectronStableReadback(plan, { readObject, phase = 'published' } = {}) {
  if (!['published', 'predecessor', 'rollback'].includes(phase) || typeof readObject !== 'function') fail('READBACK_ARGUMENT_INVALID');
  if (plan?.schemaVersion !== 'tibotattle-electron-stable-publication-plan-v1'
      || plan.origin !== distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN || plan.published !== false
      || !Array.isArray(plan.targets) || plan.targets.map(t => t.target).sort().join() !== [...STABLE_TARGETS].sort().join()) fail('READBACK_PLAN_INVALID');
  const results = [];
  for (const target of plan.targets) {
    const prefix = new URL(distribution.PRODUCTION_ELECTRON_TARGETS[target.target].feedURL).pathname.slice(1);
    for (const object of [...target.artifacts, target.feed]) {
      if (object.objectKey !== `${prefix}/${basename(object.objectKey)}` || !leaf(basename(object.objectKey))
          || !HASH.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 1 || object.bytes > MAX
          || object.contentType !== mime(basename(object.objectKey)) || object.cacheControl !== cache(basename(object.objectKey))) fail('READBACK_PLAN_INVALID');
    }
    if (target.feed.objectKey !== `${prefix}/${feedName(target.target)}`) fail('READBACK_PLAN_INVALID');
    if (target.predecessor && (!HASH.test(target.predecessor.sha256) || !Number.isSafeInteger(target.predecessor.bytes)
        || target.predecessor.bytes < 1 || target.predecessor.bytes > SMALL)) fail('READBACK_PLAN_INVALID');
    const expected = phase === 'published' ? [...target.artifacts, target.feed] : [{ ...target.feed, ...(target.predecessor ?? {}), absent: target.predecessor === null }];
    for (const item of expected) {
      const response = await readObject(`${plan.origin}/${item.objectKey}`, { timeoutMs: 45000, maximumBytes: item.absent ? 0 : item.bytes });
      if (response.redirected || (item.absent ? response.status !== 404 : response.status !== 200)) fail('READBACK_STATUS_INVALID');
      if (item.absent) { results.push({ objectKey: item.objectKey, absent: true }); continue; }
      const sha = createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > item.bytes) fail('READBACK_BYTES_MISMATCH'); sha.update(chunk); }
      if (bytes !== item.bytes || sha.digest('hex') !== item.sha256) fail('READBACK_BYTES_MISMATCH');
      if (phase === 'published' && (response.contentType !== item.contentType || response.cacheControl !== item.cacheControl)) fail('READBACK_HEADERS_INVALID');
      results.push({ objectKey: item.objectKey, sha256: item.sha256, bytes });
    }
  }
  return { phase, status: 'verified', objects: results, installedUpdate: 'not_exercised' };
}

/** Fixed-origin, no-redirect GET; response body and complete call share a deadline. */
export async function readElectronStablePublicObject(url, { timeoutMs = 45000, maximumBytes } = {}) {
  const parsed = new URL(url);
  const allowed = STABLE_TARGETS.some(target => parsed.pathname.startsWith(`/electron/stable/${target}/`)
    && leaf(parsed.pathname.slice(`/electron/stable/${target}/`.length)));
  if (parsed.origin !== distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN || parsed.search || parsed.hash || !allowed
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX) fail('READBACK_ARGUMENT_INVALID');
  const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status, redirected: response.redirected };
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) !== maximumBytes)) {
    await response.body?.cancel(); fail('READBACK_BYTES_MISMATCH');
  }
  return { status: response.status, redirected: response.redirected, body: response.body,
    contentType: response.headers.get('content-type')?.split(';')[0].trim(), cacheControl: response.headers.get('cache-control') };
}

export async function recordElectronStableReadback({ artifactRoot, proposal, operationDirectory, phase, readObject = readElectronStablePublicObject }) {
  const plan = await prepareElectronStablePublication({ artifactRoot, proposal });
  const operation = await openOperation({ directory: operationDirectory, kind: 'publication', resume: true,
    binding: { schema: plan.schemaVersion, proposal: plan.proposalSha256 } });
  try {
    const result = await verifyElectronStableReadback(plan, { phase, readObject });
    await operation.save({ ...operation.record.state, readbacks: { ...operation.record.state.readbacks, [phase]: result } });
    return { status: 'readback_verified', phase, targets: 4, uploadPerformed: false };
  } finally { operation.close(); }
}

export async function recordElectronStablePreparation({ artifactRoot, proposal, operationDirectory }) {
  const plan = await prepareElectronStablePublication({ artifactRoot, proposal });
  const operation = await openOperation({ directory: operationDirectory, kind: 'publication', binding: { schema: plan.schemaVersion, proposal: plan.proposalSha256 } });
  try { await operation.save({ stage: 'prepared_only', plan }); } finally { operation.close(); }
  return { status: plan.status, sourceRevision: plan.sourceRevision, targets: 4, published: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let args = process.argv.slice(2);
    const phase = args[0] === '--verify-public' ? args[1] : null;
    if (phase !== null) {
      if (!['published', 'predecessor', 'rollback'].includes(phase)) fail('ARGUMENT_INVALID');
      args = args.slice(2);
    }
    if (args.length !== 6 || args[0] !== '--artifact-root' || args[2] !== '--proposal' || args[4] !== '--operation-directory') fail('ARGUMENT_INVALID');
    const proposalPath = resolve(args[3]);
    if ((await lstat(proposalPath)).size > 1024 * 1024) fail('PROPOSAL_INVALID');
    const proposal = parseJson(await readFile(proposalPath));
    const options = { artifactRoot: args[1], proposal, operationDirectory: args[5] };
    console.log(JSON.stringify(phase === null ? await recordElectronStablePreparation(options) : await recordElectronStableReadback({ ...options, phase })));
  } catch (error) { console.error(/^ELECTRON_STABLE_PUBLICATION_|^RELEASE_OPERATION_/u.test(error?.code ?? '') ? error.code : 'ELECTRON_STABLE_PUBLICATION_FAILED'); process.exitCode = 1; }
}
