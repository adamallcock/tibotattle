import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContributionDeviceRenewalError,
  DEFAULT_RENEWAL_LEAD_MILLISECONDS,
  contributionDeviceCredentialRenewalDue,
  readContributionDeviceRenewalState,
  renewContributionDeviceCredentialIfDue,
  writeContributionDeviceRenewalState,
} from "../src/contribution-device-renewal.js";
import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsProtectedStateStore,
} from "../src/platform/windows-protected-state-store.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1_000;
const EXPIRES_AT = "2026-09-10T00:00:00.000Z";
const EXPIRES_EPOCH = Date.parse(EXPIRES_AT);
const WINDOWS_ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state";
const WINDOWS_ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function windowsError(code) {
  const error = new Error("simulated Windows filesystem failure");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function windowsIdentity(number) {
  return Object.freeze({
    volumeSerialNumber: WINDOWS_ROOT_IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function windowsMetadata(entry) {
  return {
    identity: entry.identity,
    isDirectory: entry.directory === true,
    isRegularFile: entry.directory !== true,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  };
}

function simulatedWindowsStore({ mismatchedReadIdentity = false } = {}) {
  const entries = new Map([
    [WINDOWS_ROOT, { directory: true, identity: WINDOWS_ROOT_IDENTITY }],
  ]);
  const calls = [];
  let nextIdentity = 2;
  const childPath = (name) => `${WINDOWS_ROOT}\\${name}`;
  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    inspectPath(path) {
      const entry = entries.get(path);
      if (!entry) throw windowsError("NOT_FOUND");
      return windowsMetadata(entry);
    },
    ensureDirectory(path) {
      const entry = entries.get(path);
      if (entry) return entry.identity;
      const identity = windowsIdentity(nextIdentity++);
      entries.set(path, { directory: true, identity });
      return identity;
    },
    readFile() { throw windowsError("NOT_FOUND"); },
    readFileBounded() { throw windowsError("NOT_FOUND"); },
    createFile() { throw windowsError("OPERATION_FAILED"); },
    deleteFile() { throw windowsError("NOT_FOUND"); },
    replaceFile() { throw windowsError("NOT_FOUND"); },
    inspectProtectedChild(root, rootIdentity, name) {
      calls.push(["inspect", root, rootIdentity, name]);
      const rootEntry = entries.get(root);
      if (!rootEntry || rootEntry.identity.fileId !== rootIdentity.fileId) {
        throw windowsError("IDENTITY_MISMATCH");
      }
      const entry = entries.get(childPath(name));
      if (!entry) throw windowsError("NOT_FOUND");
      return windowsMetadata(entry);
    },
    readProtectedChild(root, rootIdentity, name, maximumBytes) {
      calls.push(["read", root, rootIdentity, name, maximumBytes]);
      const rootEntry = entries.get(root);
      if (!rootEntry || rootEntry.identity.fileId !== rootIdentity.fileId) {
        throw windowsError("IDENTITY_MISMATCH");
      }
      const entry = entries.get(childPath(name));
      if (!entry) throw windowsError("NOT_FOUND");
      if (entry.data.byteLength > maximumBytes) throw windowsError("FILE_TOO_LARGE");
      return {
        data: Buffer.from(entry.data),
        identity: mismatchedReadIdentity ? windowsIdentity(99) : entry.identity,
      };
    },
    createProtectedChild(root, rootIdentity, name, data) {
      calls.push(["create", root, rootIdentity, name]);
      const rootEntry = entries.get(root);
      if (!rootEntry || rootEntry.identity.fileId !== rootIdentity.fileId) {
        throw windowsError("IDENTITY_MISMATCH");
      }
      const path = childPath(name);
      if (entries.has(path)) throw windowsError("ALREADY_EXISTS");
      const identity = windowsIdentity(nextIdentity++);
      entries.set(path, { data: Buffer.from(data), identity });
      return identity;
    },
    deleteProtectedChild() { throw windowsError("NOT_FOUND"); },
    replaceProtectedChild(root, rootIdentity, name, expectedIdentity, data) {
      calls.push(["replace", root, rootIdentity, name, expectedIdentity]);
      const rootEntry = entries.get(root);
      if (!rootEntry || rootEntry.identity.fileId !== rootIdentity.fileId) {
        throw windowsError("IDENTITY_MISMATCH");
      }
      const entry = entries.get(childPath(name));
      if (!entry || entry.identity.fileId !== expectedIdentity.fileId) {
        throw windowsError("IDENTITY_MISMATCH");
      }
      entry.data = Buffer.from(data);
      entry.identity = windowsIdentity(nextIdentity++);
      return entry.identity;
    },
    acquireSqliteStateLease() {
      return {
        lease: {},
        databaseIdentity: WINDOWS_ROOT_IDENTITY,
        journalIdentity: WINDOWS_ROOT_IDENTITY,
      };
    },
    releaseSqliteStateLease() {},
    acquireCredentialAuditFileGuard() {
      return { guard: {}, identity: WINDOWS_ROOT_IDENTITY };
    },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() { return { lease: {}, abandoned: false }; },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() { return { lease: {}, abandoned: false }; },
    releaseCompanionInstanceMutex() {},
  };
  return {
    store: createWindowsProtectedStateStore({
      adapter: createWindowsFilesystemAdapter({
        platform: "win32",
        architecture: "x64",
        binding,
      }),
      rootPath: WINDOWS_ROOT,
    }),
    calls,
  };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-device-renewal-"));
  try {
    await run({ root, stateFile: join(root, "renewal.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("renewal is due only inside the lead window and never for an unknown expiry", () => {
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH - DEFAULT_RENEWAL_LEAD_MILLISECONDS,
    }),
    true,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH - DEFAULT_RENEWAL_LEAD_MILLISECONDS - 1,
    }),
    false,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH + DAY,
    }),
    true,
  );
  for (const expiresAt of [null, undefined, "not-a-date", 123]) {
    assert.equal(
      contributionDeviceCredentialRenewalDue({ expiresAt, now: EXPIRES_EPOCH }),
      false,
    );
  }
  assert.equal(
    contributionDeviceCredentialRenewalDue({ expiresAt: EXPIRES_AT, now: Number.NaN }),
    false,
  );
});

test("renewal state round-trips as an owner-only file and tolerates corruption", async () => {
  await fixture(async ({ stateFile }) => {
    await writeContributionDeviceRenewalState(stateFile, {
      deviceId: DEVICE_ID,
      expiresAt: EXPIRES_AT,
    });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readContributionDeviceRenewalState(stateFile), {
      deviceId: DEVICE_ID,
      expiresAt: EXPIRES_AT,
    });

    await writeFile(stateFile, "{ not json", "utf8");
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);

    await writeFile(
      stateFile,
      JSON.stringify({ schemaVersion: "wrong", deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
      "utf8",
    );
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);
  });
  assert.equal(await readContributionDeviceRenewalState("/does/not/exist.json"), null);
  await assert.rejects(
    writeContributionDeviceRenewalState("/x.json", { deviceId: "nope", expiresAt: EXPIRES_AT }),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_invalid_configuration",
  );
});

test("Windows renewal refuses a missing or forged protected store without filesystem fallback", async () => {
  const stateFile = `${WINDOWS_ROOT}\\contribution-device-renewal-v1.json`;
  let forgedCalls = 0;
  const forgedStore = {
    contractVersion: "windows-protected-state-store-v1",
    rootPath: WINDOWS_ROOT,
    ensureProtectedDirectory() { forgedCalls += 1; },
    inspect() { forgedCalls += 1; },
    read() { forgedCalls += 1; },
    create() { forgedCalls += 1; },
    replace() { forgedCalls += 1; },
  };
  await assert.rejects(
    readContributionDeviceRenewalState(stateFile, {
      platform: "win32",
      windowsProtectedStateStore: forgedStore,
    }),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_state_unavailable",
  );
  await assert.rejects(
    writeContributionDeviceRenewalState(
      stateFile,
      { deviceId: DEVICE_ID, expiresAt: EXPIRES_AT },
      { platform: "win32" },
    ),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_state_unavailable",
  );
  assert.equal(forgedCalls, 0);
});

test("Windows renewal uses exact protected child identity for create, inspect, read, and replace", async () => {
  const { store, calls } = simulatedWindowsStore();
  const stateFile = `${WINDOWS_ROOT}\\contribution-device-renewal-v1.json`;
  await writeContributionDeviceRenewalState(
    stateFile,
    { deviceId: DEVICE_ID, expiresAt: EXPIRES_AT },
    { platform: "win32", windowsProtectedStateStore: store },
  );
  assert.deepEqual(
    await readContributionDeviceRenewalState(stateFile, {
      platform: "win32",
      windowsProtectedStateStore: store,
    }),
    { deviceId: DEVICE_ID, expiresAt: EXPIRES_AT },
  );
  await writeContributionDeviceRenewalState(
    stateFile,
    { deviceId: OTHER_DEVICE_ID, expiresAt: "2026-10-10T00:00:00.000Z" },
    { platform: "win32", windowsProtectedStateStore: store },
  );
  assert.deepEqual(
    await readContributionDeviceRenewalState(stateFile, {
      platform: "win32",
      windowsProtectedStateStore: store,
    }),
    { deviceId: OTHER_DEVICE_ID, expiresAt: "2026-10-10T00:00:00.000Z" },
  );
  assert.equal(calls.some(([method, , , name]) => method === "create"
    && name === "contribution-device-renewal-v1.json"), true);
  assert.equal(calls.some(([method, , , name]) => method === "inspect"
    && name === "contribution-device-renewal-v1.json"), true);
  assert.equal(calls.some(([method, , , name]) => method === "read"
    && name === "contribution-device-renewal-v1.json"), true);
  assert.equal(calls.some(([method, , , name]) => method === "replace"
    && name === "contribution-device-renewal-v1.json"), true);
  for (const call of calls) {
    if (["inspect", "read", "create", "replace"].includes(call[0])) {
      assert.equal(call[1], WINDOWS_ROOT);
      assert.deepEqual(call[2], WINDOWS_ROOT_IDENTITY);
    }
  }
});

test("Windows renewal rejects a child identity mismatch before replacing state", async () => {
  const { store, calls } = simulatedWindowsStore({ mismatchedReadIdentity: true });
  const stateFile = `${WINDOWS_ROOT}\\contribution-device-renewal-v1.json`;
  await writeContributionDeviceRenewalState(
    stateFile,
    { deviceId: DEVICE_ID, expiresAt: EXPIRES_AT },
    { platform: "win32", windowsProtectedStateStore: store },
  );
  // The mismatch is introduced by the simulated read boundary; a second
  // write must fail closed rather than pass an untrusted identity to replace.
  await assert.rejects(
    writeContributionDeviceRenewalState(
      stateFile,
      { deviceId: OTHER_DEVICE_ID, expiresAt: EXPIRES_AT },
      { platform: "win32", windowsProtectedStateStore: store },
    ),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_state_unavailable",
  );
  assert.equal(calls.some(([method]) => method === "replace"), false);
});

test("Windows renewal rejects a state path outside the composed protected root", async () => {
  const { store, calls } = simulatedWindowsStore();
  await assert.rejects(
    readContributionDeviceRenewalState(
      "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\other\\renewal.json",
      { platform: "win32", windowsProtectedStateStore: store },
    ),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_invalid_configuration",
  );
  assert.equal(calls.some(([method]) => ["inspect", "read"].includes(method)), false);
});

test("Windows renewal cannot inject POSIX readers or writers", async () => {
  await assert.rejects(
    renewContributionDeviceCredentialIfDue({
      platform: "win32",
      renewalStateFile: `${WINDOWS_ROOT}\\contribution-device-renewal-v1.json`,
      readState: async () => null,
      writeState: async () => {},
    }),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_invalid_configuration",
  );
});

test("an unseeded tracker never renews a fresh credential", async () => {
  let renewed = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/ignored.json",
    now: EXPIRES_EPOCH,
    readState: async () => null,
    writeState: async () => { throw new Error("must not write"); },
    renew: async () => { renewed = true; return null; },
  });
  assert.deepEqual(outcome, { status: "unseeded" });
  assert.equal(renewed, false);
});

test("a credential outside its window is left alone", async () => {
  let renewed = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/ignored.json",
    now: EXPIRES_EPOCH - 20 * DAY,
    readState: async () => ({ deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
    writeState: async () => { throw new Error("must not write"); },
    renew: async () => { renewed = true; return null; },
  });
  assert.deepEqual(outcome, { status: "not_due", expiresAt: EXPIRES_AT });
  assert.equal(renewed, false);
});

test("a due credential is renewed and the new expiry is recorded", async () => {
  const writes = [];
  const renewCalls = [];
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now: EXPIRES_EPOCH - DAY,
    readState: async () => ({ deviceId: OTHER_DEVICE_ID, expiresAt: EXPIRES_AT }),
    renew: async (options) => {
      renewCalls.push(options);
      return {
        status: "renewed",
        origin: "https://usage.example",
        deviceId: DEVICE_ID,
        expiresAt: "2026-10-10T00:00:00.000Z",
      };
    },
    writeState: async (file, value) => { writes.push({ file, value }); },
  });
  assert.deepEqual(outcome, { status: "renewed", expiresAt: "2026-10-10T00:00:00.000Z" });
  assert.equal(renewCalls.length, 1);
  assert.equal(renewCalls[0].origin, "https://usage.example");
  // The tracker is rewritten from the id the service returned, correcting any
  // drift left by a re-pair.
  assert.deepEqual(writes, [{
    file: "/tmp/renewal.json",
    value: { deviceId: DEVICE_ID, expiresAt: "2026-10-10T00:00:00.000Z" },
  }]);
});

test("a renewal failure is non-fatal and never rewrites the tracker", async () => {
  let wrote = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now: EXPIRES_EPOCH,
    readState: async () => ({ deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
    renew: async () => { throw new Error("service_unavailable"); },
    writeState: async () => { wrote = true; },
  });
  assert.deepEqual(outcome, { status: "renewal_failed" });
  assert.equal(wrote, false);
});
