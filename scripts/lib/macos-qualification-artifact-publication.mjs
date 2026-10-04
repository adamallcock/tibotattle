// Immutable test objects only. Native trust and installed qualification remain separate.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_ENDPOINTS } from '../../config/deployment-endpoints.js';
import distribution from '../../config/electron-production-distribution.cjs';
import { hashPublicationFile } from '../reconcile-release-publication.mjs';
import { validateSignedSparkleFeed } from '../sparkle-signed-feed-validation.js';
import { credentialFixtureArchiveInspectionScript } from '../smoke-electron-macos-credentials.mjs';
import { credentialFixtureRoot } from '../prepare-electron-macos-credential-fixture.mjs';
import { preflightMacOSQualification } from './electron-macos-qualification-identity.mjs';
import { identityDigest, openOperation, operationError } from './release-operation.mjs';

export const MAC_QUALIFICATION_PROPOSAL_SCHEMA = 'tibotattle-macos-qualification-artifacts-v1';
export const MAC_QUALIFICATION_PLAN_SCHEMA = 'tibotattle-macos-qualification-artifact-plan-v1';
export const MAC_QUALIFICATION_PUBLISH_CONFIRMATION = 'PUBLISH_IMMUTABLE_MAC_QUALIFICATION_ARTIFACTS';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const CACHE = 'public, max-age=31536000, immutable';
const MAX = 512 * 1024 ** 2, SMALL = 1024 ** 2;
const IDENTITY_KEYS = ['runnerRevision', 'target', 'sourceRevision', 'version', 'bundleVersion', 'buildNumber', 'dmgSha256', 'asarSha256'];
const fail = code => { throw operationError(`MAC_QUALIFICATION_ARTIFACT_${code}`); };
export const macQualificationErrorCode = error => /^MAC_QUALIFICATION_ARTIFACT_[A-Z_]+$/u.test(error?.code ?? '')
  ? error.code : 'MAC_QUALIFICATION_ARTIFACT_OPERATION_FAILED';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const safePath = value => typeof value === 'string' && value.length < 512
  && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && !['.', '..'].includes(part));
const same = (actual, expected) => actual !== null && actual?.sha256 === expected.sha256 && actual.bytes === expected.bytes;
const maximum = family => family === 'dmg' ? MAX : family === 'credential-fixture' ? 10 * SMALL : SMALL;
function git(root, args, input) {
  try { return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 10000,
    maxBuffer: SMALL, stdio: ['pipe', 'pipe', 'ignore'] }).trim(); } catch { fail('SOURCE_CHECKOUT_INVALID'); }
}
function objectRule(identity, family, fixtureOperationId, digest) {
  const prefix = `electron/test/native-sparkle/${identity.sourceRevision}/${identity.bundleVersion}/${identity.dmgSha256}`;
  if (family === 'dmg') return { objectKey: `${prefix}/TiboTattle-${identity.version}-${identity.target === 'darwin-arm64' ? 'mac-arm64' : 'macOS-x64'}.dmg`, contentType: 'application/x-apple-diskimage' };
  if (family === 'appcast') return { objectKey: `${prefix}/appcast.xml`, contentType: 'application/xml; charset=utf-8' };
  if (family === 'credential-fixture' && identity.target === 'darwin-arm64' && UUID.test(fixtureOperationId)) {
    try { credentialFixtureRoot(fixtureOperationId); } catch { fail('FIXTURE_OPERATION_INVALID'); }
    return { objectKey: `electron/test/mac-credentials/${identity.runnerRevision}/${fixtureOperationId}/${digest}/fixture.zip`, contentType: 'application/zip' };
  }
  fail('OBJECT_FAMILY_INVALID');
}
export function validateMacQualificationProposal(proposal) {
  if (!exact(proposal, ['schemaVersion', 'identity', 'sourceCandidate', 'fixtureOperationId', 'objects', 'productionObjectKeys'])
    || proposal.schemaVersion !== MAC_QUALIFICATION_PROPOSAL_SCHEMA || !exact(proposal.identity, IDENTITY_KEYS)
    || !IDENTITY_KEYS.every(key => typeof proposal.identity[key] === 'string')
    || !['runnerRevision', 'sourceRevision'].every(key => COMMIT.test(proposal.identity[key]))
    || !['dmgSha256', 'asarSha256'].every(key => HASH.test(proposal.identity[key]))
    || !['darwin-arm64', 'darwin-x64'].includes(proposal.identity.target)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(proposal.identity.version)
    || !/^[1-9][0-9]*$/u.test(proposal.identity.bundleVersion)
    || !/^[1-9][0-9]{0,9}$/u.test(proposal.identity.buildNumber)
    || !Array.isArray(proposal.objects) || proposal.objects.length < 1 || proposal.objects.length > 3
    || !Array.isArray(proposal.productionObjectKeys) || proposal.productionObjectKeys.length > 1000
    || !proposal.productionObjectKeys.every(safePath)
    || new Set(proposal.productionObjectKeys).size !== proposal.productionObjectKeys.length) fail('PROPOSAL_INVALID');
  const families = new Set();
  for (const object of proposal.objects) {
    if (!exact(object, ['family', 'localPath', 'sha256', 'bytes']) || !safePath(object.localPath)
      || !HASH.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 1
      || object.bytes > maximum(object.family) || families.has(object.family)) fail('OBJECT_INVALID');
    families.add(object.family);
    const rule = objectRule(proposal.identity, object.family, proposal.fixtureOperationId, object.sha256);
    if (basename(object.localPath) !== basename(rule.objectKey)
      || (object.family === 'dmg' && object.sha256 !== proposal.identity.dmgSha256)) fail('OBJECT_IDENTITY_INVALID');
    if (proposal.productionObjectKeys.includes(rule.objectKey)) fail('PRODUCTION_OVERLAP');
  }
  if (!families.has('dmg') || (families.has('credential-fixture')
    ? !UUID.test(proposal.fixtureOperationId) : proposal.fixtureOperationId !== null)) fail('PROPOSAL_INVALID');
  return structuredClone(proposal);
}

/** The public key override is a unit-test seam, never a proposal or CLI input. */
export function validateMacQualificationAppcast({ identity, appcastBytes, dmgBytes },
  publicEdKey = distribution.PRODUCTION_ELECTRON_NATIVE_SPARKLE_PUBLIC_ED_KEY) {
  const rule = objectRule(identity, 'dmg', null, identity.dmgSha256);
  const result = validateSignedSparkleFeed({ architecture: identity.target === 'darwin-arm64' ? 'arm64' : 'x64',
    appcastBytes, dmg: { bytes: dmgBytes, fileName: basename(rule.objectKey), sha256: identity.dmgSha256, size: dmgBytes.length },
    objectPrefix: `electron/test/native-sparkle/${identity.sourceRevision}`, publicEdKey,
    updateOrigin: DEPLOYMENT_ENDPOINTS.sparkle.origin });
  if (result.bundleVersion !== identity.bundleVersion || result.shortVersion !== identity.version
    || result.enclosure.url !== `${DEPLOYMENT_ENDPOINTS.sparkle.origin}/${rule.objectKey}`) fail('APPCAST_IDENTITY_INVALID');
  return result;
}
export function inspectMacQualificationFixture(path) {
  const result = spawnSync('/usr/bin/python3', ['-c', credentialFixtureArchiveInspectionScript(), path],
    { encoding: 'utf8', timeout: 10000, maxBuffer: SMALL, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'verified') fail('FIXTURE_ARCHIVE_INVALID');
}
async function checkedFile(path, object) {
  const info = await lstat(path);
  if (process.getuid && info.uid !== process.getuid()) fail('LOCAL_FILE_OWNER_INVALID');
  if (!same(await hashPublicationFile(path, maximum(object.family)), object)) fail('LOCAL_BYTES_CHANGED');
}
export async function prepareMacQualificationPlan({ artifactRoot, proposal, repositoryRoot = ROOT }) {
  proposal = validateMacQualificationProposal(proposal);
  const identity = proposal.identity;
  preflightMacOSQualification({ identity, sourceCandidate: proposal.sourceCandidate,
    runnerRevision: identity.runnerRevision, sourceRevision: identity.sourceRevision, target: identity.target, repositoryRoot });
  if (git(repositoryRoot, ['status', '--porcelain']) !== '') fail('SOURCE_CHECKOUT_DIRTY');
  const root = resolve(artifactRoot);
  if (await realpath(root) !== root) fail('ARTIFACT_ROOT_UNSAFE');
  for (const object of proposal.objects) await checkedFile(join(root, object.localPath), object);
  const appcast = proposal.objects.find(object => object.family === 'appcast');
  if (appcast) {
    const dmg = proposal.objects.find(object => object.family === 'dmg');
    const appcastBytes = await readFile(join(root, appcast.localPath)), dmgBytes = await readFile(join(root, dmg.localPath));
    await checkedFile(join(root, appcast.localPath), appcast); await checkedFile(join(root, dmg.localPath), dmg);
    // Verify the exact buffers consumed by the signature validator, too.
    if (!same({ sha256: digestBytes(appcastBytes), bytes: appcastBytes.length }, appcast)
      || !same({ sha256: digestBytes(dmgBytes), bytes: dmgBytes.length }, dmg)) fail('LOCAL_BYTES_CHANGED');
    validateMacQualificationAppcast({ identity, appcastBytes, dmgBytes });
  }
  const fixture = proposal.objects.find(object => object.family === 'credential-fixture');
  if (fixture) { inspectMacQualificationFixture(join(root, fixture.localPath)); await checkedFile(join(root, fixture.localPath), fixture); }
  const objects = proposal.objects.map(object => ({ ...object,
    ...objectRule(identity, object.family, proposal.fixtureOperationId, object.sha256), cacheControl: CACHE }));
  return { schemaVersion: MAC_QUALIFICATION_PLAN_SCHEMA, proposalSha256: identityDigest(proposal),
    sourceCandidateSha256: identityDigest(proposal.sourceCandidate), identity, fixtureOperationId: proposal.fixtureOperationId,
    productionObjectKeys: [...proposal.productionObjectKeys].sort(), objects,
    bucket: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket, origin: DEPLOYMENT_ENDPOINTS.sparkle.origin,
    status: 'local_bytes_bound', nativeTrust: 'separate_installed_verification_required', published: false };
}
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function assertPlan(plan) {
  if (!exact(plan, ['schemaVersion', 'proposalSha256', 'sourceCandidateSha256', 'identity', 'fixtureOperationId', 'productionObjectKeys', 'objects', 'bucket', 'origin', 'status', 'nativeTrust', 'published'])
    || plan.schemaVersion !== MAC_QUALIFICATION_PLAN_SCHEMA || !HASH.test(plan.proposalSha256) || !HASH.test(plan.sourceCandidateSha256)
    || plan.bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket || plan.origin !== DEPLOYMENT_ENDPOINTS.sparkle.origin
    || plan.status !== 'local_bytes_bound' || plan.nativeTrust !== 'separate_installed_verification_required' || plan.published !== false) fail('PLAN_INVALID');
  const proposal = validateMacQualificationProposal({ schemaVersion: MAC_QUALIFICATION_PROPOSAL_SCHEMA,
    identity: plan.identity, sourceCandidate: {}, fixtureOperationId: plan.fixtureOperationId, productionObjectKeys: plan.productionObjectKeys,
    objects: plan.objects.map(({ family, localPath, sha256, bytes }) => ({ family, localPath, sha256, bytes })) });
  for (const object of plan.objects) {
    if (!exact(object, ['family', 'localPath', 'sha256', 'bytes', 'objectKey', 'contentType', 'cacheControl'])
      || object.cacheControl !== CACHE || Object.entries(objectRule(proposal.identity, object.family, plan.fixtureOperationId, object.sha256))
        .some(([key, value]) => object[key] !== value)) fail('PLAN_INVALID');
  }
  return plan;
}
async function operationPath(directory, repositoryRoot) {
  directory = resolve(directory); const parent = resolve(repositoryRoot, '.release-build');
  if (dirname(directory) !== parent || !safePath(basename(directory)) || await realpath(parent) !== parent
    || git(repositoryRoot, ['check-ignore', '--no-index', '--', directory]) === ''
    || git(repositoryRoot, ['ls-files', '--', directory]) !== '') fail('OPERATION_DIRECTORY_INVALID');
  const info = await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) fail('OPERATION_DIRECTORY_INVALID');
  return directory;
}
export function summarizeMacQualificationPlan(plan) {
  assertPlan(plan);
  return { status: 'planned', planSha256: identityDigest(plan), sourceRevision: plan.identity.sourceRevision,
    objects: plan.objects.map(({ localPath, ...object }) => object), nativeQualification: false, coordinationAcquired: false };
}
export async function recordMacQualificationPreparation(options) {
  const plan = await prepareMacQualificationPlan(options), planSha256 = identityDigest(plan);
  const directory = await operationPath(options.operationDirectory, options.repositoryRoot ?? ROOT);
  const operation = await openOperation({ directory, kind: 'qualification', binding: { schemaVersion: plan.schemaVersion, planSha256 } });
  const state = { plan, snapshots: [], preparation: 'preparing', writer: null };
  try {
    await operation.save(state);
    const snapshots = join(directory, 'snapshots'); await mkdir(snapshots, { mode: 0o700 });
    for (const [index, object] of plan.objects.entries()) {
      const leaf = String(index), path = join(snapshots, leaf);
      await copyFile(join(resolve(options.artifactRoot), object.localPath), path, constants.COPYFILE_EXCL);
      await chmod(path, 0o600); await checkedFile(path, object);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await chmod(path, 0o400);
      state.snapshots.push({ objectKey: object.objectKey, leaf }); await operation.save(state);
    }
    const handle = await open(snapshots, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
    state.preparation = 'prepared'; await operation.save(state);
    return { ...summarizeMacQualificationPlan(plan), status: 'prepared', operationId: operation.record.id };
  } finally { operation.close(); }
}

/** The fixed coordination ref must contain this exact parentless owner record. */
export function assertMacQualificationOwnerBinding({ repositoryRoot = ROOT, owner, id, sourceCommit, planSha256 }) {
  if (!COMMIT.test(owner) || !UUID.test(id) || !COMMIT.test(sourceCommit) || !HASH.test(planSha256)) fail('OWNER_INVALID');
  let record; try { record = JSON.parse(git(repositoryRoot, ['show', '-s', '--format=%B', owner])); } catch { fail('OWNER_INVALID'); }
  const expected = { schema: 'immutable-release-artifact-lock-v1', id, sourceCommit, planSha256 };
  if (git(repositoryRoot, ['rev-list', '--parents', '-n', '1', owner]) !== owner
    || git(repositoryRoot, ['show', '-s', '--format=%T', owner]) !== git(repositoryRoot, ['hash-object', '-t', 'tree', '--stdin'], '')
    || identityDigest(record) !== identityDigest(expected)) fail('OWNER_BINDING_INVALID');
}

// Wrangler 4.114.0 emits this one diagnostic only when its authenticated remote
// GET returns null. Authentication errors, timeouts and other failures stay unknown.
export function isMacQualificationWranglerAbsence(result) {
  if (result.error || result.signal || result.status !== 1) return false;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/gu, '');
  return !/authentication|unauthori[sz]ed|forbidden|timed?\s*out|network|ECONN|ENOTFOUND|code:\s*(?:401|403)/iu.test(text)
    && (text.match(/\[ERROR\]/gu)?.length ?? 0) === 1
    && /^\s*(?:✘\s*)?\[ERROR\]\s+The specified key does not exist\.\s*$/mu.test(text);
}
export function macQualificationWranglerEnvironment(environment) {
  if (['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV']
    .some(key => Object.hasOwn(environment, key))) fail('TRANSPORT_ENVIRONMENT_OVERRIDE');
  return { ...environment, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', CI: 'true', NO_COLOR: '1' };
}
/** Authenticated GET bytes never touch disk and cannot exceed the approved size. */
export function readMacQualificationWranglerStream({ cli, args, environment, maximumBytes, spawnChild = spawn, timeoutMs = 600000 }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('R2_READ_ARGUMENT_INVALID');
  if (process.platform === 'win32' && spawnChild === spawn) fail('R2_READ_HOST_UNSUPPORTED');
  return new Promise((resolveResult, reject) => {
    let child;
    try { child = spawnChild(process.execPath, [cli, ...args], { env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(operationError('MAC_QUALIFICATION_ARTIFACT_R2_READ_UNKNOWN')); return; }
    const hash = createHash('sha256'), errors = []; let bytes = 0, errorBytes = 0, failure = null, settled = false;
    const abort = code => {
      if (failure) return; failure = code; child.stdout.destroy();
      // Wrangler's bin wrapper forks the real CLI. Kill the entire owned GET
      // process group, then wait for close; killing only the wrapper can orphan it.
      try {
        if (Number.isInteger(child.pid) && child.pid > 0 && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') failure = 'R2_READ_CLEANUP_UNVERIFIED'; }
    };
    const deadline = setTimeout(() => abort('R2_READ_UNKNOWN'), timeoutMs); deadline.unref();
    const finish = error => { if (settled) return; settled = true; clearTimeout(deadline);
      if (error) reject(operationError(`MAC_QUALIFICATION_ARTIFACT_${error}`)); };
    child.stdout.on('data', chunk => {
      if (failure) return; bytes += chunk.length;
      if (bytes > maximumBytes) { abort('R2_READ_OVERSIZE'); return; } hash.update(chunk);
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > 256 * 1024) { abort('R2_READ_UNKNOWN'); return; } errors.push(Buffer.from(chunk));
    });
    child.stdout.on('error', () => abort('R2_READ_UNKNOWN')); child.stderr.on('error', () => abort('R2_READ_UNKNOWN'));
    child.once('error', () => finish('R2_READ_UNKNOWN'));
    child.once('close', (status, signal) => {
      if (settled) return;
      if (failure) { finish(failure); return; }
      if (status !== 0 || signal) {
        if (bytes === 0 && isMacQualificationWranglerAbsence({ status, signal, stderr: Buffer.concat(errors).toString('utf8') })) {
          finish(); resolveResult(null); return;
        }
        finish('R2_READ_UNKNOWN'); return;
      }
      if (bytes < 1) { finish('R2_READ_UNKNOWN'); return; }
      finish(); resolveResult({ bytes, sha256: hash.digest('hex') });
    });
  });
}
export function createMacQualificationR2Transport({ plan, repositoryRoot = ROOT, spawnWrite = spawnSync, spawnRead = spawn, environment = process.env }) {
  assertPlan(plan);
  const verifiedEnvironment = macQualificationWranglerEnvironment(environment);
  const require = createRequire(join(repositoryRoot, 'apps/worker/package.json'));
  const packagePath = require.resolve('wrangler/package.json');
  if (require(packagePath).version !== '4.114.0') fail('WRANGLER_VERSION_INVALID');
  const cli = join(dirname(packagePath), 'bin/wrangler.js');
  const selected = (bucket, key) => { const object = plan.objects.find(item => item.objectKey === key);
    if (bucket !== plan.bucket || !object) fail('R2_TARGET_INVALID'); return object; };
  const run = (args, input) => spawnWrite(process.execPath, [cli, ...args], { cwd: repositoryRoot, encoding: 'utf8', input,
    timeout: 600000, maxBuffer: 256 * 1024,
    env: verifiedEnvironment });
  return {
    async get(bucket, key) {
      const object = selected(bucket, key);
      if (process.platform === 'win32' && spawnRead === spawn) fail('R2_READ_HOST_UNSUPPORTED');
      return readMacQualificationWranglerStream({ cli, args: ['r2', 'object', 'get', `${bucket}/${key}`, '--pipe', '--remote'],
        environment: verifiedEnvironment, maximumBytes: object.bytes, spawnChild: (command, args, options) => spawnRead(command, args, { ...options, cwd: repositoryRoot }) });
    },
    async put(bucket, object, path) {
      if (identityDigest(selected(bucket, object.objectKey)) !== identityDigest(object)) fail('R2_TARGET_INVALID');
      await checkedFile(path, object);
      const bytes = await readFile(path);
      if (!same({ sha256: digestBytes(bytes), bytes: bytes.length }, object)) fail('LOCAL_BYTES_CHANGED');
      // Pinned Wrangler supports stdin. It receives this exact verified buffer;
      // it never reopens a pathname another local task might have replaced.
      const result = run(['r2', 'object', 'put', `${bucket}/${object.objectKey}`, '--pipe',
        '--content-type', object.contentType, '--cache-control', object.cacheControl, '--remote'], bytes);
      if (result.error || result.status !== 0) fail('R2_WRITE_UNKNOWN');
    },
  };
}
export async function readMacQualificationPublicObject(plan, object, { fetchObject = fetch } = {}) {
  assertPlan(plan);
  if (!plan.objects.some(item => identityDigest(item) === identityDigest(object))) fail('PUBLIC_TARGET_INVALID');
  const response = await fetchObject(`${plan.origin}/${object.objectKey}`, { method: 'GET', redirect: 'manual',
    signal: AbortSignal.timeout(45000), headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } });
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status, redirected: response.redirected }; }
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > object.bytes) fail('PUBLIC_BYTES_CHANGED'); hash.update(chunk); }
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return { status: response.status, redirected: response.redirected, bytes, sha256: hash.digest('hex'),
    contentType: response.headers.get('content-type')?.split(';')[0].trim(), cacheControl: response.headers.get('cache-control') };
}
function validateWriter(writer, plan, approvedPlanSha256, coordinationOwner) {
  if (writer === null) return;
  const intentValid = intent => intent === null || (exact(intent, ['objectKey', 'sha256', 'bytes'])
    && plan.objects.some(object => object.objectKey === intent.objectKey && same(intent, object)));
  if (!exact(writer, ['status', 'approvedPlanSha256', 'coordinationOwner', 'intent', 'completed', 'reconciliations', 'failureCode'])
    || !['running', 'completed', 'failed_known', 'unknown', 'reconciled'].includes(writer.status)
    || writer.approvedPlanSha256 !== approvedPlanSha256 || writer.coordinationOwner !== coordinationOwner
    || !Array.isArray(writer.completed) || new Set(writer.completed).size !== writer.completed.length
    || !writer.completed.every(key => plan.objects.some(object => object.objectKey === key))
    || !Array.isArray(writer.reconciliations) || writer.reconciliations.length > 16
    || writer.reconciliations.some(item => !exact(item, ['intent', 'outcome']) || !intentValid(item.intent)
      || !['present_verified', 'absent_verified', 'none'].includes(item.outcome))
    || (writer.failureCode !== null && !/^MAC_QUALIFICATION_ARTIFACT_[A-Z_]+$/u.test(writer.failureCode))) fail('JOURNAL_INVALID');
  if (!intentValid(writer.intent) || (['completed', 'reconciled', 'failed_known'].includes(writer.status) && writer.intent !== null)
    || (writer.status === 'completed' && writer.completed.length !== plan.objects.length)) fail('JOURNAL_INVALID');
}

/** No lock acquisition/release, deletion, automatic retry or mutable feed write. */
export async function publishMacQualificationArtifacts({ artifactRoot, proposal, operationDirectory, approvedPlanSha256,
  coordinationOwner, confirmation, phase = 'publish', resume = false, coordination, transport, readPublicObject,
  repositoryRoot = ROOT }) {
  if (!['publish', 'reconcile'].includes(phase) || !HASH.test(approvedPlanSha256 ?? '') || !COMMIT.test(coordinationOwner ?? '')
    || typeof coordination?.assertOwned !== 'function' || typeof resume !== 'boolean'
    || (phase === 'publish' ? confirmation !== MAC_QUALIFICATION_PUBLISH_CONFIRMATION : confirmation !== undefined || resume)) fail('APPROVAL_INVALID');
  let plan = phase === 'publish' ? await prepareMacQualificationPlan({ artifactRoot, proposal, repositoryRoot }) : null;
  if (plan && identityDigest(plan) !== approvedPlanSha256) fail('APPROVED_PLAN_CHANGED');
  const directory = await operationPath(operationDirectory, repositoryRoot);
  const operation = await openOperation({ directory, kind: 'qualification', resume: true,
    binding: { schemaVersion: MAC_QUALIFICATION_PLAN_SCHEMA, planSha256: approvedPlanSha256 } });
  let writer, initialized = false;
  const saved = operation.record.state;
  const save = async () => operation.save({ ...saved, writer });
  const owned = async () => {
    if (phase === 'publish' && (git(repositoryRoot, ['rev-parse', 'HEAD']) !== plan.identity.runnerRevision
      || git(repositoryRoot, ['status', '--porcelain']) !== '')) fail('RUNNER_CHANGED');
    await coordination.assertOwned(coordinationOwner);
  };
  try {
    if (!exact(saved, ['plan', 'snapshots', 'preparation', 'writer']) || saved.preparation !== 'prepared'
      || identityDigest(saved.plan) !== approvedPlanSha256 || !Array.isArray(saved.snapshots)) fail('JOURNAL_INVALID');
    if (phase === 'reconcile') {
      plan = assertPlan(saved.plan);
      git(repositoryRoot, ['merge-base', '--is-ancestor', plan.identity.sourceRevision, plan.identity.runnerRevision]);
      for (const revision of [plan.identity.sourceRevision, plan.identity.runnerRevision]) {
        let manifest; try { manifest = JSON.parse(git(repositoryRoot, ['show', `${revision}:package.json`])); } catch { fail('SOURCE_CHECKOUT_INVALID'); }
        if (manifest?.name !== 'app-usagemonitor' || manifest.type !== 'module' || manifest.version !== plan.identity.version) fail('SOURCE_CHECKOUT_INVALID');
      }
    }
    if (saved.snapshots.length !== plan.objects.length) fail('JOURNAL_INVALID');
    const snapshotRoot = join(directory, 'snapshots'), info = await lstat(snapshotRoot);
    if (!info.isDirectory() || await realpath(snapshotRoot) !== snapshotRoot || (info.mode & 0o077)
      || (process.getuid && info.uid !== process.getuid())) fail('SNAPSHOT_UNSAFE');
    for (const [index, object] of plan.objects.entries()) {
      if (!exact(saved.snapshots[index], ['objectKey', 'leaf']) || saved.snapshots[index].leaf !== String(index)
        || saved.snapshots[index].objectKey !== object.objectKey) fail('JOURNAL_INVALID');
      const path = join(snapshotRoot, String(index)), metadata = await lstat(path);
      if (metadata.mode & 0o077) fail('SNAPSHOT_UNSAFE');
      await checkedFile(path, object);
    }
    // Every snapshot is bound before the first remote ownership/read operation.
    assertMacQualificationOwnerBinding({ repositoryRoot, owner: coordinationOwner, id: operation.record.id,
      sourceCommit: plan.identity.sourceRevision, planSha256: approvedPlanSha256 });
    validateWriter(saved.writer, plan, approvedPlanSha256, coordinationOwner);
    if (phase === 'publish' && (resume ? saved.writer?.status !== 'reconciled' : saved.writer !== null)) fail('RECONCILIATION_REQUIRED');
    if (phase === 'reconcile' && saved.writer === null) fail('RECONCILIATION_REQUIRED');
    await owned();
    writer = saved.writer ?? { status: 'running', approvedPlanSha256, coordinationOwner, intent: null, completed: [], reconciliations: [], failureCode: null };
    initialized = true;
    const remote = transport ?? createMacQualificationR2Transport({ plan, repositoryRoot });
    if (!['get', 'put'].every(key => typeof remote[key] === 'function')) fail('TRANSPORT_INVALID');
    const get = async object => { await owned(); const value = await remote.get(plan.bucket, object.objectKey); await owned();
      if (value !== null && !same(value, object)) fail('IMMUTABLE_CONFLICT'); return value; };
    const verifyPublic = async (object, absent = false) => {
      await owned(); const value = await (readPublicObject ?? readMacQualificationPublicObject)(plan, object); await owned();
      if (value.redirected || value.status !== (absent ? 404 : 200)) fail('PUBLIC_STATUS_INVALID');
      if (!absent && (!same(value, object) || value.contentType !== object.contentType.split(';')[0]
        || value.cacheControl !== object.cacheControl)) fail('PUBLIC_BYTES_OR_HEADERS_CHANGED');
    };
    const current = new Map();
    // Entire allowlist and public preimages are checked before the first PUT.
    for (const object of plan.objects) {
      const value = await get(object);
      if (value === null && writer.completed.includes(object.objectKey)) fail('REMOTE_DRIFT');
      await verifyPublic(object, value === null); current.set(object.objectKey, value);
    }
    if (phase === 'reconcile') {
      if (writer.reconciliations.length === 16) fail('RECONCILIATION_LIMIT');
      writer.reconciliations.push({ intent: writer.intent, outcome: writer.intent === null ? 'none'
        : current.get(writer.intent.objectKey) === null ? 'absent_verified' : 'present_verified' });
      writer.intent = null; writer.failureCode = null;
      writer.status = plan.objects.every(object => current.get(object.objectKey) !== null) ? 'completed' : 'reconciled';
      writer.completed = plan.objects.filter(object => current.get(object.objectKey) !== null).map(object => object.objectKey);
      await save();
    } else {
      writer.status = 'running'; writer.failureCode = null; await save();
      for (const [index, object] of plan.objects.entries()) {
        if (current.get(object.objectKey) === null) {
          const path = join(snapshotRoot, String(index)); await checkedFile(path, object);
          const before = await get(object); await verifyPublic(object, before === null);
          if (before === null) {
            writer.intent = { objectKey: object.objectKey, sha256: object.sha256, bytes: object.bytes }; await save();
            await owned(); await remote.put(plan.bucket, object, path); await owned();
            if (await get(object) === null) fail('R2_WRITE_UNKNOWN');
            await verifyPublic(object);
          }
        }
        if (!writer.completed.includes(object.objectKey)) writer.completed.push(object.objectKey);
        writer.intent = null; await save();
      }
      // Final readback includes reused objects and catches drift across the batch.
      for (const object of plan.objects) { if (await get(object) === null) fail('REMOTE_DRIFT'); await verifyPublic(object); }
      writer.status = 'completed'; await save();
    }
    return { status: writer.status, phase, sourceRevision: plan.identity.sourceRevision,
      objects: plan.objects.length, coordinationReleased: false, nativeQualification: false };
  } catch (error) {
    if (initialized) { writer.status = writer.intent === null ? 'failed_known' : 'unknown';
      writer.failureCode = macQualificationErrorCode(error); await save().catch(() => {}); }
    throw error;
  } finally { operation.close(); }
}
