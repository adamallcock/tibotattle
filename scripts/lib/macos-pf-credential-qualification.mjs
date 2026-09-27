// Disposable hosted-Mac credential qualification only. Preserve the signed
// app's ordinary launch while blocking new external sockets for the runner UID.
import { execFileSync, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';

const PF = '/sbin/pfctl';
const SUDO = '/usr/bin/sudo';
const HOST = 'updates.tibotattle.com';
export const MACOS_PF_CREDENTIAL_MODE = 'credential-qualification-pf-uid-v1';
const fail = () => { throw new Error('MAC_CREDENTIAL_PF_GUARD_FAILED'); };

export function macOSCredentialPfRule(uid) {
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 65535) fail();
  return `block drop out quick on ! lo0 proto { tcp, udp } all user ${uid}\n`;
}

export function parseMacOSPfEnableToken(value) {
  const match = /(?:^|\n)[ \t]*Token\s*:\s*(\d+)(?:\r?\n|$)/iu.exec(value);
  if (!match || !/^[1-9]\d{0,19}$/u.test(match[1])) fail();
  return match[1];
}

export function macOSPfRuleInstalled(value, uid) {
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 65535) return false;
  const rows = value.trim().split('\n').filter(Boolean);
  return rows.length >= 2 && rows.length <= 4
    && rows.every(row => row.includes('block drop out quick') && row.includes('on ! lo0')
      && ['tcp', 'udp'].some(proto => row.includes(`proto ${proto}`)) && row.includes(`user = ${uid}`))
    && ['tcp', 'udp'].every(proto => rows.some(row => row.includes(`proto ${proto}`)));
}

function pf(args) {
  try { return execFileSync(SUDO, ['-n', PF, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'ignore'],
  }); } catch { fail(); }
}

function enablePf() {
  const result = spawnSync(SUDO, ['-n', PF, '-E'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) fail();
  // pfctl may write its reference token to stderr. Keep both streams in memory;
  // only the validated numeric token is used, and neither stream is emitted.
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function tcp(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export async function activateMacOSCredentialPfGuard({ temporaryRoot, runId, uid = process.getuid() }) {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || !/^\d{6,20}$/u.test(runId ?? '') || !temporaryRoot?.startsWith('/')) fail();
  const anchor = `com.apple/tibotattle-credential-${runId}`;
  const base = await mkdtemp(join(temporaryRoot, 'credential-pf-'));
  const file = join(base, 'rules');
  let token = null, loaded = false, stage = 'main_anchor';
  try {
    if (!/anchor\s+"com\.apple\/\*"/u.test(pf(['-sr'])) || pf(['-a', anchor, '-sr']).trim()) fail();
    stage = 'baseline_connectivity';
    const { address } = await lookup(HOST, { family: 4 });
    if (!await tcp(address, 443)) fail();
    await writeFile(file, macOSCredentialPfRule(uid), { mode: 0o600, flag: 'wx' });
    stage = 'syntax';
    pf(['-n', '-f', file]);
    stage = 'anchor_load';
    pf(['-a', anchor, '-f', file]); loaded = true;
    stage = 'enable_command';
    const enabled = enablePf();
    stage = 'enable_token';
    token = parseMacOSPfEnableToken(enabled);
    const check = async () => {
      try {
        stage = 'active_rules';
        if (!/Status:\s*Enabled/iu.test(pf(['-s', 'info']))
          || !macOSPfRuleInstalled(pf(['-a', anchor, '-sr']), uid)) fail();
        const server = createServer(socket => socket.end());
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        try {
          stage = 'loopback';
          if (!await tcp('127.0.0.1', server.address().port)) fail();
          stage = 'external_denial';
          if (await tcp(address, 443)) fail();
        } finally { await new Promise(resolve => server.close(resolve)); }
        return { mode: MACOS_PF_CREDENTIAL_MODE, loopback: true, externalTcpDenied: true,
          tcpAndUdpRulesInstalled: true, runnerUidScoped: true };
      } catch { throw Object.assign(new Error('MAC_CREDENTIAL_PF_GUARD_FAILED'), { pfStage: stage }); }
    };
    const proof = await check();
    return { proof, assertEffective: check, async close() {
      if (!token) fail();
      pf(['-a', anchor, '-F', 'rules']);
      pf(['-X', token]); token = null;
      await rm(base, { recursive: true });
    } };
  } catch (error) {
    const failedStage = error?.pfStage ?? stage;
    if (loaded) { try { pf(['-a', anchor, '-F', 'rules']); } catch {} }
    if (token) { try { pf(['-X', token]); } catch {} }
    await rm(base, { recursive: true, force: true });
    throw Object.assign(new Error('MAC_CREDENTIAL_PF_GUARD_FAILED'), { pfStage: failedStage });
  }
}
