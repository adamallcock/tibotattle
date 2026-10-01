#!/usr/bin/env node
/** Explicit stable R2 writer. Ownership and native release approval are external
 * prerequisites; uncertain operations stop without releasing coordination. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareElectronStablePublication, verifyElectronStableReadback, readElectronStablePublicObject } from './prepare-electron-stable-publication.mjs';
import { hashPublicationFile } from './reconcile-release-publication.mjs';
import { checkReleaseNotes } from './check-release-notes.mjs';
import { identityDigest, openOperation } from './lib/release-operation.mjs';
import { DEPLOYMENT_ENDPOINTS } from '../config/deployment-endpoints.js';
import distribution from '../config/electron-production-distribution.cjs';
import { createProductionDeploymentLock } from '../apps/worker/scripts/production-deployment-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u;
const MAX = 2 * 1024 ** 3;
const fail = code => { throw Object.assign(new Error(`ELECTRON_STABLE_WRITER_${code}`), { code: `ELECTRON_STABLE_WRITER_${code}` }); };
const same = (actual, expected) => expected === null ? actual === null : actual !== null && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
const closedError = error => /^ELECTRON_STABLE_(?:WRITER|PUBLICATION)_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'ELECTRON_STABLE_WRITER_OPERATION_FAILED';

/** Auth remains inside the pinned existing Wrangler CLI. No token extraction. */
export function createElectronStableR2Transport({ temporaryDirectory, spawn = spawnSync, repositoryRoot = ROOT }) {
  const require = createRequire(join(repositoryRoot, 'apps/worker/package.json'));
  const packagePath = require.resolve('wrangler/package.json');
  if (require(packagePath).version !== '4.114.0') fail('WRANGLER_VERSION_INVALID');
  const cli = join(dirname(packagePath), 'bin/wrangler.js');
  const run = args => {
    const result = spawn(process.execPath, [cli, ...args], { cwd: repositoryRoot, encoding: 'utf8', timeout: 600000,
      maxBuffer: 256 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
    return result;
  };
  const targetForKey = (bucket, key) => {
    if (bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket || typeof key !== 'string') fail('R2_TARGET_INVALID');
    const target = Object.keys(distribution.PRODUCTION_ELECTRON_TARGETS).find(value => {
      const prefix = `electron/stable/${value}/`;
      return key.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(key.slice(prefix.length));
    });
    if (!target) fail('R2_TARGET_INVALID');
    return target;
  };
  let count = 0;
  return {
    async get(bucket, key) {
      targetForKey(bucket, key);
      const path = join(temporaryDirectory, `get-${count++}`);
      try {
        const result = run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', path, '--remote']);
        if (result.error || result.status !== 0) {
          if (!result.error && /the specified key does not exist|no such key|nosuchkey|object not found/iu.test(`${result.stdout}\n${result.stderr}`)) return null;
          fail('R2_READ_FAILED');
        }
        return await hashPublicationFile(path, MAX);
      } finally { await rm(path, { force: true }); }
    },
    async put(bucket, object, path) {
      targetForKey(bucket, object.objectKey);
      const result = run(['r2', 'object', 'put', `${bucket}/${object.objectKey}`, '--file', path,
        '--content-type', object.contentType, '--cache-control', object.cacheControl, '--remote']);
      if (result.error || result.status !== 0) fail('R2_WRITE_UNKNOWN');
    },
    async delete(bucket, key) {
      const target = targetForKey(bucket, key);
      const name = target.startsWith('darwin-') ? 'latest-mac.yml' : target === 'linux-x64' ? 'latest-linux.yml' : 'latest.yml';
      if (key !== `electron/stable/${target}/${name}`) fail('R2_DELETE_TARGET_INVALID');
      const result = run(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote']);
      if (result.error || result.status !== 0) fail('R2_WRITE_UNKNOWN');
    },
  };
}

/** The exact prepared journal must already exist. There is no automatic retry,
 * lock acquisition/stealing, or release after uncertain remote work. */
export async function publishElectronStableFeed({ artifactRoot, proposal, operationDirectory, approvedPlanSha256,
  coordinationOwner, phase = 'publish', coordination, transport, readPublicObject = readElectronStablePublicObject, repositoryRoot = ROOT } = {}) {
  if (!['publish', 'rollback'].includes(phase) || !SHA.test(approvedPlanSha256 ?? '')
      || !/^[a-f0-9]{40}$/u.test(coordinationOwner ?? '') || typeof coordination?.assertOwned !== 'function') fail('APPROVAL_INVALID');
  const plan = await prepareElectronStablePublication({ artifactRoot, proposal });
  if (identityDigest(plan) !== approvedPlanSha256) fail('APPROVED_PLAN_CHANGED');
  if (phase === 'publish') {
    const documentation = await checkReleaseNotes({ rootDirectory: repositoryRoot });
    if (!documentation.ok || !documentation.stableTagVersions.includes(plan.version)) fail('RELEASE_DOCUMENTATION_INVALID');
  }
  const root = await realpath(resolve(artifactRoot));
  const operation = await openOperation({ directory: operationDirectory, kind: 'publication', resume: true,
    binding: { schema: plan.schemaVersion, proposal: plan.proposalSha256 } });
  let temporaryDirectory, state;
  const owned = async () => { await coordination.assertOwned(coordinationOwner); };
  const save = async () => { await operation.save({ ...operation.record.state, writer: state }); };
  try {
    const prior = operation.record.state.writer;
    if (phase === 'publish' ? prior !== undefined : !prior || !['completed', 'failed_known'].includes(prior.status)
        || prior.phase !== 'publish' || prior.intent !== null || prior.approvedPlanSha256 !== approvedPlanSha256
        || prior.coordinationOwner !== coordinationOwner) fail('RECONCILIATION_REQUIRED');
    await owned();
    state = { phase, status: 'running', approvedPlanSha256, coordinationOwner, intent: null, completed: [],
      ...(phase === 'rollback' ? { priorPublication: prior } : {}) };
    await save();
    temporaryDirectory = await mkdtemp(join(operation.directory, 'stable-write-'));
    await chmod(temporaryDirectory, 0o700);
    const remote = transport ?? createElectronStableR2Transport({ temporaryDirectory });
    if (!['get', 'put', 'delete'].every(key => typeof remote[key] === 'function')) fail('TRANSPORT_INVALID');
    const get = async object => { await owned(); const value = await remote.get(plan.bucket, object.objectKey); await owned(); return value; };
    const requireState = async (object, expected) => { if (!same(await get(object), expected)) fail('REMOTE_PREIMAGE_CHANGED'); };
    let copies = 0;
    const write = async (object, preimage, next) => {
      // Snapshot exact bytes before recording a remote intent; Wrangler consumes
      // only this owned copy, never a mutable caller-selected source file.
      let path = null;
      if (next !== null) {
        path = join(temporaryDirectory, `put-${copies++}`);
        await copyFile(join(root, next.localPath), path);
        await chmod(path, 0o600);
        if (!same(await hashPublicationFile(path, MAX), next)) fail('LOCAL_BYTES_CHANGED');
      }
      await requireState(object, preimage);
      state.intent = { objectKey: object.objectKey, action: next === null ? 'delete_feed' : 'put',
        preimage: preimage === null ? null : { sha256: preimage.sha256, bytes: preimage.bytes },
        next: next === null ? null : { sha256: next.sha256, bytes: next.bytes } };
      await save();
      await owned();
      if (next === null) await remote.delete(plan.bucket, object.objectKey);
      else await remote.put(plan.bucket, object, path);
      await owned();
      await requireState(object, next);
      state.completed.push(state.intent); state.intent = null; await save();
      if (path !== null) await rm(path);
    };
    if (phase === 'publish') {
      for (const target of plan.targets) await requireState(target.feed, target.predecessor);
      for (const target of plan.targets) for (const object of target.artifacts) {
        const before = await get(object);
        if (before !== null && !same(before, object)) fail('IMMUTABLE_CONFLICT');
        if (before === null) await write(object, null, object);
      }
      // Re-read every immutable object before any feed changes, including reused
      // objects; public consumer verification remains a separate final readback.
      for (const target of plan.targets) for (const object of target.artifacts) await requireState(object, object);
      for (const target of plan.targets) await write(target.feed, target.predecessor, target.feed);
    } else {
      // Matching bytes alone do not establish ownership: a failed preflight may
      // have encountered another operation's exact release. Restore only feeds
      // whose successful write is durably recorded by this publication.
      const ownedTargets = plan.targets.filter(target => prior.completed.some(action => action.action === 'put'
        && action.objectKey === target.feed.objectKey && same(action.next, target.feed)
        && same(action.preimage, target.predecessor)));
      for (const target of ownedTargets) {
        const current = await get(target.feed);
        if (!same(current, target.feed) && !same(current, target.predecessor)) fail('REMOTE_PREIMAGE_CHANGED');
      }
      for (const target of ownedTargets) {
        if (same(await get(target.feed), target.predecessor)) continue;
        await write(target.feed, target.feed, target.predecessor);
      }
    }
    const result = await verifyElectronStableReadback(plan, { phase: phase === 'publish' ? 'published' : 'rollback', readObject: readPublicObject });
    await owned(); state.readback = result; state.status = 'completed'; await save();
    return { status: 'completed', phase, sourceRevision: plan.sourceRevision, targets: 4, coordinationReleased: false };
  } catch (error) {
    if (state) { state.status = state.intent === null ? 'failed_known' : 'unknown'; state.failureCode = closedError(error); await save().catch(() => {}); }
    throw error;
  } finally {
    // Keep exact upload snapshots after unknown work for owner reconciliation.
    if (temporaryDirectory && state?.status !== 'unknown') await rm(temporaryDirectory, { recursive: true, force: true });
    operation.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const keys = ['--artifact-root', '--proposal', '--operation-directory', '--approved-plan-sha256', '--coordination-owner', '--phase'];
    if (args.length !== 12 || keys.some((key, i) => args[i * 2] !== key)) fail('ARGUMENT_INVALID');
    const proposalPath = resolve(args[3]);
    if ((await lstat(proposalPath)).size > 1024 * 1024) fail('ARGUMENT_INVALID');
    const proposal = JSON.parse(await readFile(proposalPath));
    const coordination = createProductionDeploymentLock({ repositoryRoot: ROOT });
    console.log(JSON.stringify(await publishElectronStableFeed({ artifactRoot: args[1], proposal, operationDirectory: args[5],
      approvedPlanSha256: args[7], coordinationOwner: args[9], phase: args[11], coordination })));
  } catch (error) { console.error(closedError(error)); process.exitCode = 1; }
}
