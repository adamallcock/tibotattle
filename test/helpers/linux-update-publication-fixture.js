import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openOperation } from '../../scripts/lib/release-operation.mjs';
import { signLinuxUpdateFeed } from '../../scripts/sign-electron-linux-update.mjs';

// Generated per test process, never a real release signing key or trust root.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
export const linuxUpdateNow = Date.UTC(2026, 9, 12);
export const linuxUpdateKeys = [{ id: 'synthetic-publication',
  publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  minimumSequence: 1, maximumSequence: 100 }];
export const linuxUpdateVerification = { keys: linuxUpdateKeys, now: () => linuxUpdateNow };
export const linuxPlannerOptions = { linuxUpdateKeys, now: () => linuxUpdateNow };

export function signSyntheticLinuxFeed(artifactPath, feedBytes, { sequence = 1, expiresAt = linuxUpdateNow + 24 * 60 * 60_000 } = {}) {
  return signLinuxUpdateFeed({ artifactPath, feedBytes, sequence,
    expiresAt, keyId: linuxUpdateKeys[0].id,
    signer: bytes => sign(null, bytes, privateKey), keys: linuxUpdateKeys, now: () => linuxUpdateNow });
}

export async function prepareSyntheticSameVersionRenewal({ root, proposal, put }) {
  for (const target of proposal.targets) {
    const original = await readFile(join(root, target.manifest.path));
    if (target.target !== 'linux-x64') {
      target.predecessor = await put(`${target.target}/previous.yml`, original);
      continue;
    }
    const old = JSON.parse(original);
    old.tibotattleLinuxUpdate.manifest.expiresAt = linuxUpdateNow - 1000;
    target.predecessor = await put(`${target.target}/previous.yml`, JSON.stringify(resignSyntheticLinuxManifest(old)));
    const next = await signSyntheticLinuxFeed(join(root, target.artifacts[0].path), original, { sequence: 2 });
    await writeFile(join(root, target.manifest.path), next);
    target.manifest = { ...target.manifest, sha256: createHash('sha256').update(next).digest('hex'), bytes: next.length };
  }
}

export function resignSyntheticLinuxManifest(feed) {
  const input = feed.tibotattleLinuxUpdate.manifest;
  const keys = ['schemaVersion', 'appId', 'channel', 'target', 'version', 'sequence', 'size', 'sha256', 'keyId', 'expiresAt'];
  feed.tibotattleLinuxUpdate.signature = sign(null,
    Buffer.from(`${JSON.stringify(Object.fromEntries(keys.map(key => [key, input[key]])))}\n`), privateKey).toString('base64');
  return feed;
}

// Production journal preparation has no injected trust roots. Seed the exact
// planner result using the same operation primitive for isolated writer tests.
export async function recordSyntheticStablePreparation(plan, operationDirectory) {
  const operation = await openOperation({ directory: operationDirectory, kind: 'publication',
    binding: { schema: plan.schemaVersion, proposal: plan.proposalSha256 } });
  try { await operation.save({ stage: 'prepared_only', plan }); }
  finally { operation.close(); }
}
