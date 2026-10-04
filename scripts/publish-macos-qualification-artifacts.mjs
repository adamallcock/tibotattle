#!/usr/bin/env node
// Default is local planning. This entrypoint never acquires or releases a lock.
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImmutableArtifactPublicationLock } from '../apps/worker/scripts/production-deployment-lock.mjs';
import { hashPublicationFile } from './reconcile-release-publication.mjs';
import { prepareMacQualificationPlan, recordMacQualificationPreparation, publishMacQualificationArtifacts,
  summarizeMacQualificationPlan, macQualificationErrorCode } from './lib/macos-qualification-artifact-publication.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseMacQualificationPublicationArguments(args) {
  const modes = new Set(['--plan', '--prepare', '--publish', '--reconcile']);
  const mode = modes.has(args[0]) ? args[0].slice(2) : 'plan';
  if (modes.has(args[0])) args = args.slice(1);
  const resume = args.at(-1) === '--resume';
  if (resume) args = args.slice(0, -1);
  const keys = mode === 'reconcile' ? ['--operation-directory', '--approved-plan-sha256', '--coordination-owner']
    : ['--artifact-root', '--proposal', ...(mode === 'plan' ? [] : ['--operation-directory']),
    ...(mode === 'publish' ? ['--approved-plan-sha256', '--coordination-owner'] : []),
    ...(mode === 'publish' ? ['--confirm'] : [])];
  if (args.length !== keys.length * 2 || keys.some((key, index) => args[index * 2] !== key)
    || args.some(value => typeof value !== 'string' || !value || /[\0\r\n]/u.test(value))
    || (resume && mode !== 'publish')) throw Object.assign(new Error('MAC_QUALIFICATION_ARTIFACT_ARGUMENT_INVALID'), { code: 'MAC_QUALIFICATION_ARTIFACT_ARGUMENT_INVALID' });
  if (mode === 'reconcile') return { mode, resume, operationDirectory: args[1], approvedPlanSha256: args[3], coordinationOwner: args[5] };
  return { mode, resume, artifactRoot: args[1], proposalPath: args[3],
    ...(mode === 'plan' ? {} : { operationDirectory: args[5] }),
    ...(['publish', 'reconcile'].includes(mode) ? { approvedPlanSha256: args[7], coordinationOwner: args[9] } : {}),
    ...(mode === 'publish' ? { confirmation: args[11] } : {}) };
}
export async function runMacQualificationPublication(args, { repositoryRoot = ROOT } = {}) {
  const { mode, proposalPath, ...options } = parseMacQualificationPublicationArguments(args);
  if (mode === 'reconcile') return publishMacQualificationArtifacts({ ...options, repositoryRoot, phase: 'reconcile',
    coordination: createImmutableArtifactPublicationLock({ repositoryRoot }) });
  const path = resolve(proposalPath), info = await lstat(path);
  if (process.getuid && info.uid !== process.getuid()) throw new Error('Unsafe proposal owner');
  const before = await hashPublicationFile(path, 1024 ** 2), bytes = await readFile(path);
  const after = await hashPublicationFile(path, 1024 ** 2);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes || bytes.length !== before.bytes
    || createHash('sha256').update(bytes).digest('hex') !== before.sha256) throw new Error('Changed proposal');
  const proposal = JSON.parse(bytes);
  const input = { ...options, proposal, repositoryRoot };
  if (mode === 'plan') return summarizeMacQualificationPlan(await prepareMacQualificationPlan(input));
  if (mode === 'prepare') return recordMacQualificationPreparation(input);
  return publishMacQualificationArtifacts({ ...input, phase: mode === 'reconcile' ? 'reconcile' : 'publish',
    coordination: createImmutableArtifactPublicationLock({ repositoryRoot }) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runMacQualificationPublication(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(macQualificationErrorCode(error) + '\n'); process.exitCode = 1; }
}
