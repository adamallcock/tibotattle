import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLinuxStartupBaseline, waitForLinuxSuccessorStartup, assertLinuxCdpEndpointOwned, assertLinuxCdpPortUnused } from "../scripts/lib/linux-successor-evidence.mjs";

const identity = { pid: 123, startTime: "456", executable: "/isolated/tibotattle" };
const notBefore = 1_700_000_000_000;
const record = (overrides = {}) => ({ schemaVersion: "tibotattle-electron-startup-diagnostic-v1", recordedAt: new Date(notBefore + 2).toISOString(),
  startedAt: new Date(notBefore + 1).toISOString(), phase: "ready", outcome: "ready", code: null, platform: "linux", architecture: "x64", version: "0.1.28", ...overrides });
async function fixture(t) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), "linux-successor-synthetic-")));
  await chmod(userData, 0o700);
  const directory = join(userData, "startup-diagnostics"); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "startup-diagnostic-v1.json");
  await writeFile(path, JSON.stringify(record({ version: "0.1.27", startedAt: new Date(notBefore - 20).toISOString(), recordedAt: new Date(notBefore - 10).toISOString() })), { mode: 0o600 });
  t.after(() => rm(userData, { recursive: true, force: true }));
  const baseline = await captureLinuxStartupBaseline({ userData });
  const replace = async (value = record()) => {
    const next = join(directory, "next.json"); await writeFile(next, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); await rename(next, path);
  };
  return { userData, directory, path, baseline, replace, options: { identity, readIdentity: async () => identity, userData, baseline, version: "0.1.28", notBefore, timeoutMs: 1, now: () => notBefore + 100 } };
}

test("automatic successor proves only a new ready dedicated-profile generation bound around the read", async (t) => {
  const f = await fixture(t); await f.replace(); let reads = 0;
  const proof = await waitForLinuxSuccessorStartup({ ...f.options, readIdentity: async () => { reads++; return identity; } });
  assert.deepEqual(proof, { outcome: "ready", attribution: "dedicated_profile_generation" });
  assert.equal(reads, 2); assert.ok(!JSON.stringify(proof).includes("health"));
});
test("successor journal rejects stale version, schema extensions, malformed/oversized content, failed outcome and timestamp drift", async (t) => {
  for (const value of [record({ version: "0.1.27" }), record({ version: ["0.1.28"] }), record({ extra: true }), "{", " ".repeat(4097), record({ outcome: "failed", code: "startup_stopped" }),
    record({ platform: "darwin" }), record({ architecture: "arm64" }), record({ startedAt: new Date(notBefore - 1).toISOString() }),
    record({ recordedAt: new Date(notBefore + 101).toISOString() }), record({ recordedAt: new Date(notBefore).toISOString() })]) {
    const f = await fixture(t); await f.replace(value);
    await assert.rejects(waitForLinuxSuccessorStartup(f.options), { message: /^LINUX_SUCCESSOR_DIAGNOSTIC_/u });
  }
});
test("same inode, unfinished record and PID reuse never become successful startup proof", async (t) => {
  const f = await fixture(t);
  let clock = notBefore + 100;
  await assert.rejects(waitForLinuxSuccessorStartup({ ...f.options, now: () => clock, sleep: async () => { clock += 2; } }), { code: "LINUX_SUCCESSOR_DIAGNOSTIC_TIMEOUT" });
  await writeFile(f.path, JSON.stringify(record()));
  await assert.rejects(waitForLinuxSuccessorStartup(f.options), { code: "LINUX_SUCCESSOR_DIAGNOSTIC_CHANGED" });
  await f.replace(record({ outcome: "in_progress", phase: "lifecycle" })); clock = notBefore + 100;
  await assert.rejects(waitForLinuxSuccessorStartup({ ...f.options, now: () => clock, sleep: async () => { clock += 2; } }), { code: "LINUX_SUCCESSOR_DIAGNOSTIC_TIMEOUT" });
  await f.replace(); let reads = 0;
  await assert.rejects(waitForLinuxSuccessorStartup({ ...f.options, readIdentity: async () => ++reads === 1 ? identity : { ...identity, startTime: "457" } }), { code: "LINUX_SUCCESSOR_IDENTITY_CHANGED" });
  await assert.rejects(waitForLinuxSuccessorStartup({ ...f.options, identity: { ...identity, startTime: ["456"] } }), { code: "LINUX_SUCCESSOR_IDENTITY_CHANGED" });
  await assert.rejects(waitForLinuxSuccessorStartup({ ...f.options, readIdentity: async () => { throw new Error("private identity detail"); } }), { message: "LINUX_SUCCESSOR_IDENTITY_CHANGED" });
});
test("diagnostic ownership rejects links, unsafe directories/modes and replaced profile directory", async (t) => {
  const modes = await fixture(t); await chmod(modes.path, 0o644);
  await assert.rejects(captureLinuxStartupBaseline({ userData: modes.userData }));
  const hard = await fixture(t); await link(hard.path, join(hard.directory, "alias"));
  await assert.rejects(captureLinuxStartupBaseline({ userData: hard.userData }));
  const sym = await fixture(t); await rename(sym.path, join(sym.directory, "target")); await symlink(join(sym.directory, "target"), sym.path);
  await assert.rejects(captureLinuxStartupBaseline({ userData: sym.userData }));
  const parent = await fixture(t); await chmod(parent.directory, 0o755);
  await assert.rejects(waitForLinuxSuccessorStartup(parent.options));
  const replaced = await fixture(t); await rename(replaced.directory, join(replaced.userData, "old")); await mkdir(replaced.directory, { mode: 0o700 }); await replaced.replace();
  await assert.rejects(waitForLinuxSuccessorStartup(replaced.options), { code: "LINUX_SUCCESSOR_DIAGNOSTIC_CHANGED" });
});

const header = "  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
const socketRow = ({ address = "0100007F", port = 43210, inode = "987", owner = process.getuid(), state = "0A" } = {}) =>
  `0: ${address}:${port.toString(16).toUpperCase()} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${owner} 0 ${inode} 1\n`;
function socketOptions(overrides = {}) {
  return { identity, readIdentity: async () => identity, port: 43210,
    read: async (path) => header + (path.endsWith("/tcp") ? socketRow() : ""),
    list: async () => ["1", "2"], link: async (path) => path.endsWith("/1") ? "socket:[987]" : "/irrelevant", ...overrides };
}
test("controlled restart accepts the sole selected loopback listener only when exact PID owns its inode", async () => {
  let identityReads = 0;
  assert.equal(await assertLinuxCdpEndpointOwned(socketOptions({ readIdentity: async () => { identityReads++; return identity; } })), true);
  assert.equal(identityReads, 2);
  assert.equal(await assertLinuxCdpPortUnused({ port: 43210, read: async () => header }), true);
  await assert.rejects(assertLinuxCdpPortUnused(socketOptions()), { code: "LINUX_SUCCESSOR_CDP_PREEXISTING" });
});
test("CDP absence is retryable but another PID, wildcard/IPv6, duplicates and wrong owner are terminal", async () => {
  await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions({ read: async () => header })), { code: "LINUX_SUCCESSOR_CDP_NOT_READY" });
  for (const options of [
    { link: async () => "socket:[999]" },
    { read: async (path) => header + (path.endsWith("/tcp") ? socketRow({ address: "00000000" }) : "") },
    { read: async (path) => header + (path.endsWith("/tcp6") ? socketRow({ address: "00000000000000000000000000000000" }) : "") },
    { read: async (path) => header + (path.endsWith("/tcp") ? socketRow() + socketRow({ inode: "988" }) : "") },
    { read: async (path) => header + (path.endsWith("/tcp") ? socketRow({ owner: process.getuid() + 1 }) : "") },
    { list: async () => ["1", "2"], link: async () => "socket:[987]" },
  ]) await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions(options)), { code: "LINUX_SUCCESSOR_CDP_UNTRUSTED" });
});
test("CDP socket replacement and PID reuse during observation are rejected without a network request", async () => {
  let reads = 0;
  await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions({ read: async (path) => header + (path.endsWith("/tcp") ? socketRow({ inode: ++reads === 1 ? "987" : "988" }) : "") })), { code: "LINUX_SUCCESSOR_CDP_UNTRUSTED" });
  let identityReads = 0;
  await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions({ readIdentity: async () => ++identityReads === 1 ? identity : { ...identity, startTime: "999" } })), { code: "LINUX_SUCCESSOR_IDENTITY_CHANGED" });
});
test("final identity observation cannot hide listener loss or substitution; an admitted binding never retries disappearance", async () => {
  for (const replacement of ["", socketRow({ inode: "988" })]) {
    let row = socketRow(), checks = 0;
    await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions({
      read: async path => header + (path.endsWith("/tcp") ? row : ""),
      readIdentity: async () => { if (++checks === 2) row = replacement; return identity; },
    })), { code: "LINUX_SUCCESSOR_CDP_UNTRUSTED" });
  }
  const binding = {};
  await assertLinuxCdpEndpointOwned(socketOptions({ binding }));
  await assert.rejects(assertLinuxCdpEndpointOwned(socketOptions({ binding, read: async () => header })), { code: "LINUX_SUCCESSOR_CDP_UNTRUSTED" });
});
test("concurrent first proofs cannot overwrite a different admitted socket binding", async () => {
  const binding = {}; let firstResume; let firstPaused;
  const paused = new Promise(done => { firstPaused = done; });
  const resume = new Promise(done => { firstResume = done; });
  let firstChecks = 0;
  const first = assertLinuxCdpEndpointOwned(socketOptions({ binding, readIdentity: async () => { if (++firstChecks === 2) { firstPaused(); await resume; } return identity; } }));
  await paused;
  await assertLinuxCdpEndpointOwned(socketOptions({ binding,
    read: async path => header + (path.endsWith("/tcp") ? socketRow({ inode: "988" }) : ""),
    link: async path => path.endsWith("/1") ? "socket:[988]" : "/irrelevant" }));
  firstResume();
  await assert.rejects(first, { code: "LINUX_SUCCESSOR_CDP_UNTRUSTED" });
  assert.ok(binding.socketIdentity.endsWith(":988"));
});
