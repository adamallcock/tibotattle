import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';

// Qualification only. No DYLD injection, proxy, endpoint override or app rewrite.
// Unix-domain IPC and Security.framework remain subject to the normal OS policy.
export const MACOS_LOOPBACK_POLICY = '(version 1) (allow default) '
  + '(deny network-outbound (remote ip "*:*")) '
  + '(allow network-outbound (remote ip "localhost:*"))';
export const MACOS_LOOPBACK_MODE = 'credential-qualification-loopback-only-v1';

export function macOSLoopbackLaunch(executable, args, mode) {
  if (mode !== MACOS_LOOPBACK_MODE || typeof executable !== 'string'
    || !isAbsolute(executable) || /[\0\r\n]/u.test(executable)
    || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('MACOS_LOOPBACK_LAUNCH_INVALID');
  }
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', MACOS_LOOPBACK_POLICY, executable, ...args] };
}

// Both child and grandchild must encounter kernel denial, not a timeout or an
// unreachable route. The external destinations are documentation-only IPs.
export function macOSLoopbackProbeSource(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MACOS_LOOPBACK_PORT_INVALID');
  return `import net from 'node:net'; import dgram from 'node:dgram'; import {spawnSync} from 'node:child_process';
const tcp=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.once('connect',()=>{s.destroy();resolve('connected')});s.once('error',e=>resolve(e.code));s.setTimeout(1500,()=>{s.destroy();resolve('timeout')})});
const udp=(family,host)=>new Promise(resolve=>{const s=dgram.createSocket(family);s.once('error',e=>{s.close();resolve(e.code)});s.send(Buffer.from('synthetic'),9,host,e=>{s.close();resolve(e?.code??'sent')})});
const denied=c=>c==='EPERM'||c==='EACCES';
const results=await Promise.all([tcp('127.0.0.1',${port}),tcp('192.0.2.1',9),tcp('2001:db8::1',9),udp('udp4','192.0.2.1'),udp('udp6','2001:db8::1')]);
const child=spawnSync(process.execPath,['--input-type=module','-e',"import net from 'node:net';const s=net.connect({host:'192.0.2.1',port:9});s.once('error',e=>{process.exitCode=['EPERM','EACCES'].includes(e.code)?0:2});s.setTimeout(1500,()=>{s.destroy();process.exitCode=3})"],{timeout:2500,stdio:'ignore'});
const proof={loopback:results[0]==='connected',ipv4Denied:denied(results[1]),ipv6Denied:denied(results[2]),udp4Denied:denied(results[3]),udp6Denied:denied(results[4]),descendantDenied:child.status===0};
process.stdout.write(JSON.stringify(proof));process.exitCode=Object.values(proof).every(Boolean)?0:1;`;
}

export async function inspectMacOSLoopbackEnforcement({ nodeExecutable = process.execPath, spawnImpl = spawn } = {}) {
  const server = createServer(socket => socket.end());
  let connected = false;
  server.on('connection', () => { connected = true; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const selected = macOSLoopbackLaunch(nodeExecutable,
      ['--input-type=module', '-e', macOSLoopbackProbeSource(server.address().port)], MACOS_LOOPBACK_MODE);
    const result = await new Promise((resolve, reject) => {
      const child = spawnImpl(selected.executable, selected.args, { stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      let output = '', settled = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 4096) child.kill('SIGKILL'); });
      child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('MACOS_LOOPBACK_PROBE_UNAVAILABLE')); } });
      child.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, output }); } });
    });
    let proof;
    try { proof = JSON.parse(result.output); } catch { throw new Error('MACOS_LOOPBACK_PROBE_FAILED'); }
    const keys = ['loopback', 'ipv4Denied', 'ipv6Denied', 'udp4Denied', 'udp6Denied', 'descendantDenied'];
    if (result.code !== 0 || !connected || !proof || Object.keys(proof).sort().join() !== keys.sort().join()
      || keys.some(key => proof[key] !== true)) throw new Error('MACOS_LOOPBACK_PROBE_FAILED');
    return Object.freeze(proof);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
