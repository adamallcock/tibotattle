import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import distribution from '../config/electron-production-distribution.cjs';
import { identityDigest } from '../scripts/lib/release-operation.mjs';
import { MAC_QUALIFICATION_PROPOSAL_SCHEMA, MAC_QUALIFICATION_PUBLISH_CONFIRMATION,
  prepareMacQualificationPlan, recordMacQualificationPreparation, publishMacQualificationArtifacts,
  validateMacQualificationProposal, validateMacQualificationAppcast, assertMacQualificationOwnerBinding,
  isMacQualificationWranglerAbsence, createMacQualificationR2Transport, readMacQualificationPublicObject,
  inspectMacQualificationFixture, macQualificationWranglerEnvironment, readMacQualificationWranglerStream } from '../scripts/lib/macos-qualification-artifact-publication.mjs';
import { parseMacQualificationPublicationArguments, runMacQualificationPublication } from '../scripts/publish-macos-qualification-artifacts.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerId = '12345678-1234-4234-8234-123456789abc';
async function fixture(run) {
  const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), 'mac-qualification-publisher-')));
  const git = (args, input) => execFileSync('git', args, { cwd: repositoryRoot, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Synthetic release test']); git(['config', 'user.email', 'test@localhost']);
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.27' }));
    await writeFile(join(repositoryRoot, '.gitignore'), '.release-build/\nartifacts/\n');
    git(['add', 'package.json', '.gitignore']); git(['commit', '-qm', 'Synthetic source']);
    const sourceRevision = git(['rev-parse', 'HEAD']);
    const artifactRoot = join(repositoryRoot, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
    await mkdir(join(repositoryRoot, '.release-build'), { mode: 0o700 });
    const data = Buffer.from('synthetic final DMG bytes'), filename = 'TiboTattle-0.1.27-mac-arm64.dmg';
    await writeFile(join(artifactRoot, filename), data, { mode: 0o600 });
    const identity = { runnerRevision: sourceRevision, sourceRevision, target: 'darwin-arm64',
      version: '0.1.27', bundleVersion: '1035', buildNumber: '2026100301', dmgSha256: sha(data), asarSha256: 'a'.repeat(64) };
    const sourceCandidate = { schemaVersion: 'tibotattle-electron-production-source-candidate-v1', status: 'production_source_staged',
      sourceRevision, version: identity.version, buildNumber: identity.buildNumber, target: identity.target,
      updateFeed: distribution.productionElectronFeedForTarget(identity.target), builderEnvironment: {
        TIBOTATTLE_ELECTRON_SOURCE_REVISION: sourceRevision, TIBOTATTLE_ELECTRON_BUILD_NUMBER: identity.buildNumber,
        TIBOTATTLE_ELECTRON_TARGET: identity.target, TIBOTATTLE_ELECTRON_VERSION: identity.version } };
    const proposal = { schemaVersion: MAC_QUALIFICATION_PROPOSAL_SCHEMA, identity, sourceCandidate,
      fixtureOperationId: null, productionObjectKeys: [], objects: [{ family: 'dmg', localPath: filename, sha256: sha(data), bytes: data.length }] };
    const operationDirectory = join(repositoryRoot, '.release-build', 'qualification-test');
    const base = { repositoryRoot, artifactRoot, proposal, operationDirectory };
    const readJournal = async () => JSON.parse(await readFile(join(operationDirectory, 'operation.json')));
    const createOwner = record => {
      const tree = git(['hash-object', '-t', 'tree', '--stdin'], '');
      return git(['commit-tree', tree], JSON.stringify(record) + '\n');
    };
    const prepare = async () => {
      const prepared = await recordMacQualificationPreparation(base);
      const plan = await prepareMacQualificationPlan(base), approvedPlanSha256 = identityDigest(plan);
      const record = { schema: 'immutable-release-artifact-lock-v1', id: prepared.operationId,
        sourceCommit: sourceRevision, planSha256: approvedPlanSha256 };
      const coordinationOwner = createOwner(record), calls = [], objects = new Map();
      const coordination = { assertOwned: async owner => { assert.equal(owner, coordinationOwner); calls.push(['owner']); } };
      const transport = { get: async (_bucket, key) => { calls.push(['get', key]); const b = objects.get(key); return b ? { sha256: sha(b), bytes: b.length } : null; },
        put: async (_bucket, object, path) => {
          calls.push(['put', object.objectKey]);
          const journal = await readJournal(); assert.equal(journal.state.writer.intent.objectKey, object.objectKey);
          const bytes = await readFile(path); assert.equal(sha(bytes), object.sha256); objects.set(object.objectKey, bytes);
        } };
      const readPublicObject = async (_plan, object) => { calls.push(['public', object.objectKey]); const b = objects.get(object.objectKey);
        return b ? { status: 200, redirected: false, sha256: sha(b), bytes: b.length, contentType: object.contentType.split(';')[0], cacheControl: object.cacheControl } : { status: 404, redirected: false }; };
      return { plan, prepared, record, calls, objects, transport, readPublicObject,
        options: { ...base, approvedPlanSha256, coordinationOwner, coordination, transport, readPublicObject,
          confirmation: MAC_QUALIFICATION_PUBLISH_CONFIRMATION } };
    };
    await run({ ...base, git, data, filename, readJournal, createOwner, prepare });
  } finally { await rm(repositoryRoot, { recursive: true, force: true }); }
}

test('default planning binds exact source and immutable DMG without operation or remote I/O', async () => fixture(async context => {
  const proposalPath = join(context.artifactRoot, 'proposal.json'); await writeFile(proposalPath, JSON.stringify(context.proposal), { mode: 0o600 });
  const result = await runMacQualificationPublication(['--artifact-root', context.artifactRoot, '--proposal', proposalPath], context);
  assert.equal(result.status, 'planned'); assert.equal(result.nativeQualification, false); assert.equal(result.coordinationAcquired, false);
  assert.equal(result.objects[0].contentType, 'application/x-apple-diskimage'); assert.match(result.objects[0].cacheControl, /immutable$/u);
  assert.equal(result.objects[0].objectKey, `electron/test/native-sparkle/${context.proposal.identity.sourceRevision}/1035/${sha(context.data)}/${context.filename}`);
  assert(!JSON.stringify(result).includes(context.artifactRoot)); assert(!Object.hasOwn(result.objects[0], 'localPath'));
  await assert.rejects(readFile(join(context.operationDirectory, 'operation.json')), { code: 'ENOENT' });
}));
test('proposal closure refuses arbitrary objects, mutable destinations, paths and reviewed production overlap', async () => fixture(async ({ proposal }) => {
  for (const mutation of [p => { p.extra = true; }, p => { p.objects[0].objectKey = 'appcast.xml'; },
    p => { p.objects[0].family = 'stable-feed'; }, p => { p.objects[0].localPath = '../outside.dmg'; },
    p => { p.objects.push(p.objects[0]); }, p => { p.fixtureOperationId = ownerId; },
    p => { p.productionObjectKeys = ['../unsafe']; }, p => { p.objects = []; },
    p => { p.identity.sourceRevision = 'INVALID'; }]) {
    const changed = structuredClone(proposal); mutation(changed); assert.throws(() => validateMacQualificationProposal(changed));
  }
  const changed = structuredClone(proposal);
  changed.productionObjectKeys = [`electron/test/native-sparkle/${proposal.identity.sourceRevision}/1035/${proposal.identity.dmgSha256}/${proposal.objects[0].localPath}`];
  assert.throws(() => validateMacQualificationProposal(changed), /PRODUCTION_OVERLAP/u);
}));
test('source admission refuses wrong runner, candidate build/version, rehearsal and tracked changes', async () => fixture(async context => {
  for (const mutation of [p => { p.identity.runnerRevision = 'a'.repeat(40); }, p => { p.sourceCandidate.buildNumber = '2026100302'; },
    p => { p.sourceCandidate.version = '0.1.26'; }, p => { p.sourceCandidate.rehearsal = true; }]) {
    const proposal = structuredClone(context.proposal); mutation(proposal);
    await assert.rejects(prepareMacQualificationPlan({ ...context, proposal }));
  }
  await writeFile(join(context.repositoryRoot, '.gitignore'), '.release-build/\nchanged\n');
  await assert.rejects(prepareMacQualificationPlan(context), /SOURCE_CHECKOUT_DIRTY/u);
}));
test('an untracked executable cannot claim a frozen qualification runner HEAD', async () => fixture(async context => {
  await writeFile(join(context.repositoryRoot, 'untracked-publisher.mjs'), 'export const synthetic=true;');
  await assert.rejects(prepareMacQualificationPlan(context), /SOURCE_CHECKOUT_DIRTY/u);
}));
test('a reviewed same-version runner descendant admits the unchanged source receipt', async () => fixture(async context => {
  await writeFile(join(context.repositoryRoot, 'tooling.txt'), 'synthetic verifier'); context.git(['add', 'tooling.txt']); context.git(['commit', '-qm', 'Verifier descendant']);
  context.proposal.identity.runnerRevision = context.git(['rev-parse', 'HEAD']);
  assert.equal((await prepareMacQualificationPlan(context)).identity.sourceRevision, context.proposal.identity.sourceRevision);
}));
test('local digest drift, symlink and hardlink refuse before preparation', async () => fixture(async context => {
  const path = join(context.artifactRoot, context.filename);
  await writeFile(path, Buffer.alloc(context.data.length, 1)); await assert.rejects(prepareMacQualificationPlan(context), /LOCAL_BYTES_CHANGED/u);
  await rm(path); await writeFile(path + '.other', context.data, { mode: 0o600 }); await symlink(path + '.other', path);
  await assert.rejects(prepareMacQualificationPlan(context)); await rm(path); await link(path + '.other', path);
  await assert.rejects(prepareMacQualificationPlan(context));
}));
test('preparation retains private fsynced snapshots and refuses unignored/unsafe/repeated operations', async () => fixture(async context => {
  await assert.rejects(recordMacQualificationPreparation({ ...context, operationDirectory: join(context.repositoryRoot, 'public-operation') }), /OPERATION_DIRECTORY_INVALID/u);
  const prepared = await recordMacQualificationPreparation(context), state = (await context.readJournal()).state;
  assert.equal(prepared.status, 'prepared'); assert.equal(state.preparation, 'prepared'); assert.equal(state.writer, null);
  assert.deepEqual(await readFile(join(context.operationDirectory, 'snapshots', '0')), context.data);
  await assert.rejects(recordMacQualificationPreparation(context), /USE_RESUME/u);
}));
test('exact parentless owner record must bind operation, candidate source and approved digest before remote reads', async () => fixture(async context => {
  const p = await context.prepare();
  for (const changes of [{ id: ownerId }, { sourceCommit: 'b'.repeat(40) }, { planSha256: 'c'.repeat(64) }, { schema: 1 }, { extra: true }]) {
    const owner = context.createOwner({ ...p.record, ...changes });
    await assert.rejects(publishMacQualificationArtifacts({ ...p.options, coordinationOwner: owner }), /OWNER_BINDING_INVALID/u);
  }
  assert.deepEqual(p.calls, []);
  const tree = context.git(['hash-object', '-t', 'tree', '--stdin'], '');
  const owner = context.git(['commit-tree', tree, '-p', context.proposal.identity.sourceRevision], JSON.stringify(p.record));
  assert.throws(() => assertMacQualificationOwnerBinding({ repositoryRoot: context.repositoryRoot, owner, id: p.prepared.operationId,
    sourceCommit: p.record.sourceCommit, planSha256: p.record.planSha256 }), /OWNER_BINDING_INVALID/u);
}));
test('approved plan and all snapshot bytes are checked before remote ownership or artifact reads', async () => fixture(async context => {
  const p = await context.prepare();
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, approvedPlanSha256: 'd'.repeat(64) }), /APPROVED_PLAN_CHANGED/u);
  const path = join(context.operationDirectory, 'snapshots', '0'); await chmod(path, 0o600); await writeFile(path, Buffer.alloc(context.data.length, 7));
  await assert.rejects(publishMacQualificationArtifacts(p.options), /LOCAL_BYTES_CHANGED/u); assert.deepEqual(p.calls, []);
}));
test('publication journals intent before PUT, verifies R2/public headers and refuses blind replay', async () => fixture(async context => {
  const p = await context.prepare(), result = await publishMacQualificationArtifacts(p.options);
  assert.equal(result.status, 'completed'); assert.equal(result.nativeQualification, false); assert.equal(result.coordinationReleased, false);
  const writer = (await context.readJournal()).state.writer;
  assert.equal(writer.intent, null); assert.deepEqual(writer.completed, [p.plan.objects[0].objectKey]);
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 1);
  await assert.rejects(publishMacQualificationArtifacts(p.options), /RECONCILIATION_REQUIRED/u);
}));
test('existing exact bytes are reused; conflicting bytes and ambiguous absence prevent every PUT', async () => fixture(async context => {
  const p = await context.prepare(), object = p.plan.objects[0]; p.objects.set(object.objectKey, Buffer.from('conflict'));
  await assert.rejects(publishMacQualificationArtifacts(p.options), /IMMUTABLE_CONFLICT/u);
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 0);
  p.objects.set(object.objectKey, context.data);
  await publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined });
  assert.equal((await context.readJournal()).state.writer.status, 'completed');
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 0);
}));
test('a failed read or public 403 is unknown evidence, never authoritative absence', async () => fixture(async context => {
  const p = await context.prepare();
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, readPublicObject: async () => ({ status: 403 }) }), /PUBLIC_STATUS_INVALID/u);
  assert.equal((await context.readJournal()).state.writer.status, 'failed_known');
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 0);
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined,
    transport: { ...p.transport, get: async () => { throw new Error('simulated connection failure'); } } }));
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 0);
}));
test('unknown completed PUT retains intent; reconciliation observes bytes without retry or lock release', async () => fixture(async context => {
  const p = await context.prepare(), put = p.transport.put;
  p.transport.put = async (...args) => { await put(...args); throw new Error('response lost'); };
  await assert.rejects(publishMacQualificationArtifacts(p.options));
  const writer = (await context.readJournal()).state.writer;
  assert.equal(writer.status, 'unknown'); assert.equal(writer.intent.objectKey, p.plan.objects[0].objectKey);
  await assert.rejects(publishMacQualificationArtifacts(p.options), /RECONCILIATION_REQUIRED/u);
  const result = await publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined });
  assert.equal(result.status, 'completed'); assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 1);
  assert.equal((await context.readJournal()).state.writer.reconciliations[0].outcome, 'present_verified');
}));
test('unknown absent PUT needs authoritative reconciliation and a separately explicit resume', async () => fixture(async context => {
  const p = await context.prepare(), put = p.transport.put;
  p.transport.put = async () => { throw new Error('unknown transport outcome'); };
  await assert.rejects(publishMacQualificationArtifacts(p.options));
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, resume: true }), /RECONCILIATION_REQUIRED/u);
  const reconciled = await publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined });
  assert.equal(reconciled.status, 'reconciled'); assert.equal((await context.readJournal()).state.writer.reconciliations[0].outcome, 'absent_verified');
  p.transport.put = put;
  assert.equal((await publishMacQualificationArtifacts({ ...p.options, resume: true })).status, 'completed');
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 1);
}));
test('partial post-write public verification keeps unknown intent and exact snapshots', async () => fixture(async context => {
  const p = await context.prepare(), publicRead = p.readPublicObject;
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, readPublicObject: async (plan, object) => {
    const result = await publicRead(plan, object); return result.status === 200 ? { ...result, cacheControl: 'no-store' } : result;
  } }), /PUBLIC_BYTES_OR_HEADERS_CHANGED/u);
  assert.equal((await context.readJournal()).state.writer.status, 'unknown');
  assert.deepEqual(await readFile(join(context.operationDirectory, 'snapshots', '0')), context.data);
  assert.equal((await publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined })).status, 'completed');
}));
test('snapshot-only reconciliation survives moved originals and unrelated tracked edits', async () => fixture(async context => {
  const p = await context.prepare(), put = p.transport.put;
  p.transport.put = async (...args) => { await put(...args); throw new Error('response lost'); };
  await assert.rejects(publishMacQualificationArtifacts(p.options));
  await rm(join(context.artifactRoot, context.filename));
  await writeFile(join(context.repositoryRoot, 'package.json'), '{"synthetic":"unrelated tracked edit"}');
  const result = await publishMacQualificationArtifacts({ operationDirectory: context.operationDirectory, repositoryRoot: context.repositoryRoot,
    approvedPlanSha256: p.options.approvedPlanSha256, coordinationOwner: p.options.coordinationOwner,
    coordination: p.options.coordination, transport: p.transport, readPublicObject: p.readPublicObject, phase: 'reconcile' });
  assert.equal(result.status, 'completed'); assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 1);
}));
test('journal closure rejects altered intent and nonempty owner tree before external ownership checks', async () => fixture(async context => {
  const p = await context.prepare(), journal = await context.readJournal();
  journal.state.writer = { status: 'unknown', approvedPlanSha256: p.options.approvedPlanSha256, coordinationOwner: p.options.coordinationOwner,
    intent: { objectKey: 'electron/stable/darwin-arm64/latest-mac.yml', sha256: 'f'.repeat(64), bytes: 1 }, completed: [], reconciliations: [], failureCode: null };
  await writeFile(join(context.operationDirectory, 'operation.json'), JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined }), /JOURNAL_INVALID/u);
  assert.deepEqual(p.calls, []);
  const tree = context.git(['rev-parse', `${context.proposal.identity.sourceRevision}^{tree}`]);
  const owner = context.git(['commit-tree', tree], JSON.stringify(p.record));
  assert.throws(() => assertMacQualificationOwnerBinding({ repositoryRoot: context.repositoryRoot, owner,
    id: p.record.id, sourceCommit: p.record.sourceCommit, planSha256: p.record.planSha256 }), /OWNER_BINDING_INVALID/u);
}));
test('partial immutable batch is retained and only an explicit reconciled resume writes its missing fixture', { skip: process.platform === 'win32' }, async () => fixture(async context => {
  const path = join(context.artifactRoot, 'fixture.zip');
  const built = spawnSync('/usr/bin/python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for n in ["Info.plist","MacOS/CredentialFixture","_CodeSignature/CodeResources"]: z.writestr("CredentialFixture.app/Contents/"+n,"synthetic fixture")', path]);
  assert.equal(built.status, 0); const bytes = await readFile(path);
  context.proposal.fixtureOperationId = ownerId;
  context.proposal.objects.push({ family: 'credential-fixture', localPath: 'fixture.zip', sha256: sha(bytes), bytes: bytes.length });
  const p = await context.prepare(), put = p.transport.put; let failed = false;
  p.transport.put = async (...args) => { if (args[1].family === 'credential-fixture' && !failed) { failed = true; throw new Error('unknown fixture PUT'); } return put(...args); };
  await assert.rejects(publishMacQualificationArtifacts(p.options));
  const journal = await context.readJournal(); assert.equal(journal.state.writer.status, 'unknown');
  assert.deepEqual(journal.state.writer.completed, [p.plan.objects[0].objectKey]); assert.equal(p.objects.size, 1);
  const reconciled = await publishMacQualificationArtifacts({ ...p.options, phase: 'reconcile', confirmation: undefined });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal((await publishMacQualificationArtifacts({ ...p.options, resume: true })).status, 'completed');
  assert.equal(p.calls.filter(([kind]) => kind === 'put').length, 2); assert.equal(p.objects.size, 2);
}));
test('Wrangler authoritative absence classifier is pinned and fails closed for mixed/auth/network failures', () => {
  assert.equal(isMacQualificationWranglerAbsence({ status: 1, stderr: '✘ [ERROR] The specified key does not exist.\n' }), true);
  for (const result of [{ status: 0, stderr: '[ERROR] The specified key does not exist.' },
    { status: 2, stderr: '[ERROR] The specified key does not exist.' },
    { status: 1, stderr: 'NoSuchKey' }, { status: 1, error: new Error(), stderr: '[ERROR] The specified key does not exist.' },
    { status: 1, stderr: '[ERROR] The specified key does not exist.\nAuthentication error' },
    { status: 1, stderr: '[ERROR] The specified key does not exist.\n[ERROR] Another error' }]) assert.equal(isMacQualificationWranglerAbsence(result), false);
});
test('Wrangler API routing overrides are refused rather than inherited or silently stripped', () => {
  for (const key of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV']) {
    assert.throws(() => macQualificationWranglerEnvironment({ [key]: '' }), /TRANSPORT_ENVIRONMENT_OVERRIDE/u);
  }
  const environment = macQualificationWranglerEnvironment({ SYNTHETIC_TEST: 'safe' });
  assert.equal(environment.SYNTHETIC_TEST, 'safe'); assert.equal(environment.WRANGLER_SEND_ERROR_REPORTS, 'false');
});
function fakeReadChild(output) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
  queueMicrotask(() => output(child)); return child;
}
test('authenticated streamed GET hashes exact bytes, recognizes empty absence and cancels oversize before settlement', async () => {
  const bytes = Buffer.from('synthetic object'); let child;
  const run = output => readMacQualificationWranglerStream({ cli: 'unused', args: [], environment: {}, maximumBytes: bytes.length,
    spawnChild: () => { child = fakeReadChild(output); return child; } });
  const result = await run(c => { c.stdout.write(bytes); c.emit('close', 0, null); });
  assert.deepEqual(result, { bytes: bytes.length, sha256: sha(bytes) }); assert.deepEqual(child.kills, []);
  assert.equal(await run(c => { c.stderr.write('[ERROR] The specified key does not exist.\n'); c.emit('close', 1, null); }), null);
  await assert.rejects(run(c => { c.stdout.write('x'); c.stderr.write('[ERROR] The specified key does not exist.\n'); c.emit('close', 1, null); }), /R2_READ_UNKNOWN/u);
  await assert.rejects(run(c => { c.stdout.write(Buffer.alloc(bytes.length + 1)); }), /R2_READ_OVERSIZE/u);
  assert.deepEqual(child.kills, ['SIGKILL']);
  await assert.rejects(run(c => { c.stderr.write(Buffer.alloc(256 * 1024 + 1)); }), /R2_READ_UNKNOWN/u);
  assert.deepEqual(child.kills, ['SIGKILL']);
});
test('authenticated GET admits only empty or single-LF absence while successful LF bytes retain their exact hash', async () => {
  const missing = '✘ [ERROR] The specified key does not exist.\n'; let child;
  const run = (chunks, stderr = missing, status = 1, signal = null) => readMacQualificationWranglerStream({
    cli: 'unused', args: [], environment: {}, maximumBytes: 16,
    spawnChild: () => { child = fakeReadChild(c => {
      for (const chunk of chunks) c.stdout.write(chunk);
      c.stderr.write(stderr); c.emit('close', status, signal);
    }); return child; },
  });
  assert.equal(await run([]), null);
  assert.equal(await run([Buffer.from([0x0a])]), null); assert.deepEqual(child.kills, []);
  for (const chunks of [['\r'], ['\n\n'], ['\n', '\n'], [' '], ['x'], ['\n', 'x']]) {
    await assert.rejects(run(chunks), /R2_READ_UNKNOWN/u, `stdout ${JSON.stringify(chunks)}`);
  }
  for (const stderr of [`${missing}Authentication error\n`, `${missing}Network error\n`,
    `${missing}[ERROR] Another error\n`, 'NoSuchKey\n']) {
    await assert.rejects(run(['\n'], stderr), /R2_READ_UNKNOWN/u);
  }
  await assert.rejects(run(['\n'], missing, 2), /R2_READ_UNKNOWN/u);
  await assert.rejects(run(['\n'], missing, 1, 'SIGTERM'), /R2_READ_UNKNOWN/u);
  const lf = Buffer.from([0x0a]);
  assert.deepEqual(await run([lf], '', 0), { bytes: 1, sha256: sha(lf) });
});
test('authenticated GET deadline kills the owned child and waits for close', async () => {
  let child;
  const result = readMacQualificationWranglerStream({ cli: 'unused', args: [], environment: {}, maximumBytes: 10, timeoutMs: 5,
    spawnChild: () => { child = fakeReadChild(() => {}); return child; } });
  // Keep this synthetic process alive until the unref'ed operation deadline.
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(result, /R2_READ_UNKNOWN/u); assert.deepEqual(child.kills, ['SIGKILL']); }
  finally { clearTimeout(keepAlive); }
});
test('transport refuses nonallowlisted stable/deletion destinations before Wrangler', async () => fixture(async context => {
  const plan = await prepareMacQualificationPlan(context);
  const transport = createMacQualificationR2Transport({ plan, temporaryDirectory: context.artifactRoot,
    spawnRead: () => assert.fail('no CLI execution permitted'), spawnWrite: () => assert.fail('no CLI execution permitted') });
  await assert.rejects(transport.get(plan.bucket, 'electron/stable/darwin-arm64/latest-mac.yml'), /R2_TARGET_INVALID/u);
  await assert.rejects(transport.get('other-bucket', plan.objects[0].objectKey), /R2_TARGET_INVALID/u);
  await assert.rejects(transport.put(plan.bucket, { ...plan.objects[0], cacheControl: 'no-store' }, 'unused'), /R2_TARGET_INVALID/u);
  assert.equal(transport.delete, undefined);
}));
test('public readback is bounded, fixed-origin and does not follow redirects', async () => fixture(async context => {
  const plan = await prepareMacQualificationPlan(context), object = plan.objects[0]; let args;
  const response = await readMacQualificationPublicObject(plan, object, { fetchObject: async (...input) => {
    args = input; return new Response(context.data, { status: 200, headers: { 'Content-Type': object.contentType, 'Cache-Control': object.cacheControl } });
  } });
  assert.equal(args[0], `${plan.origin}/${object.objectKey}`); assert.equal(args[1].redirect, 'manual'); assert.equal(response.sha256, object.sha256);
  await assert.rejects(readMacQualificationPublicObject(plan, { ...object, objectKey: 'appcast.xml' }, { fetchObject: () => assert.fail() }), /PUBLIC_TARGET_INVALID/u);
  await assert.rejects(readMacQualificationPublicObject(plan, object, { fetchObject: async () => new Response(Buffer.alloc(object.bytes + 1)) }), /PUBLIC_BYTES_CHANGED/u);
}));
test('optional appcasts use the existing official signature validator and exact candidate enclosure identity', async () => fixture(async context => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const identity = context.proposal.identity;
  const make = (url = `https://updates.tibotattle.com/electron/test/native-sparkle/${identity.sourceRevision}/1035/${identity.dmgSha256}/${context.filename}`, length = context.data.length) => {
    const xml = `<?xml version="1.0" standalone="yes"?><!-- sparkle-sign-warning:\nSynthetic fixture\n--><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><title>TiboTattle</title><item><title>0.1.27</title><pubDate>Wed, 05 Aug 2026 14:55:05 -0400</pubDate><sparkle:version>1035</sparkle:version><sparkle:shortVersionString>0.1.27</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="${url}" length="${length}" type="application/octet-stream" sparkle:edSignature="${sign(null, context.data, privateKey).toString('base64')}"></enclosure></item></channel></rss>`;
    return Buffer.from(`${xml}<!-- sparkle-signatures:\nedSignature: ${sign(null, Buffer.from(xml), privateKey).toString('base64')}\nlength: ${Buffer.byteLength(xml)}\n-->\n`);
  };
  assert.equal(validateMacQualificationAppcast({ identity, appcastBytes: make(), dmgBytes: context.data }, key).shortVersion, '0.1.27');
  for (const appcastBytes of [Buffer.from('<xml/>'), make('https://updates.tibotattle.com/appcast.xml'), make(undefined, context.data.length + 1)]) {
    assert.throws(() => validateMacQualificationAppcast({ identity, appcastBytes, dmgBytes: context.data }, key));
  }
  assert.throws(() => validateMacQualificationAppcast({ identity, appcastBytes: make(), dmgBytes: context.data }));
  const appcastBytes = make(); await writeFile(join(context.artifactRoot, 'appcast.xml'), appcastBytes, { mode: 0o600 });
  context.proposal.objects.push({ family: 'appcast', localPath: 'appcast.xml', sha256: sha(appcastBytes), bytes: appcastBytes.length });
  await assert.rejects(prepareMacQualificationPlan(context)); // A fixture signing key cannot enter the live publisher.
}));
test('fixture family admits only its exact ARM operation/hash namespace and existing closed archive shape', async () => fixture(async context => {
  context.proposal.fixtureOperationId = ownerId;
  context.proposal.objects.push({ family: 'credential-fixture', localPath: 'fixture.zip', sha256: 'f'.repeat(64), bytes: 128 });
  assert.equal(validateMacQualificationProposal(context.proposal).fixtureOperationId, ownerId);
  const intel = structuredClone(context.proposal); intel.identity.target = 'darwin-x64'; intel.objects[0].localPath = 'TiboTattle-0.1.27-macOS-x64.dmg';
  assert.throws(() => validateMacQualificationProposal(intel), /OBJECT_FAMILY_INVALID/u);
  if (process.platform !== 'darwin') return;
  const path = join(context.artifactRoot, 'fixture.zip');
  const result = spawnSync('/usr/bin/python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("private.txt","synthetic")', path]);
  assert.equal(result.status, 0); assert.throws(() => inspectMacQualificationFixture(path), /FIXTURE_ARCHIVE_INVALID/u);
}));
test('CLI mutation/recovery flags are closed; default cannot accidentally upload or resume', () => {
  const common = ['--artifact-root', 'root', '--proposal', 'proposal'];
  assert.equal(parseMacQualificationPublicationArguments(common).mode, 'plan');
  assert.equal(parseMacQualificationPublicationArguments(['--plan', ...common]).resume, false);
  for (const args of [['--upload', ...common], [...common, '--resume'], ['--prepare', ...common],
    ['--publish', ...common, '--operation-directory', 'op'], ['--reconcile', ...common, '--resume']]) {
    assert.throws(() => parseMacQualificationPublicationArguments(args), /ARGUMENT_INVALID/u);
  }
});
