import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NATIVE_ELECTRON_HANDOVER_JOURNAL_FILE,
  NATIVE_ELECTRON_HANDOVER_LEASE_FILE,
  NATIVE_ELECTRON_HANDOVER_ROUTE,
  NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION,
  nativeElectronHandoverCandidateDigest,
  runNativeElectronHandover,
  validateNativeElectronHandoverCandidate,
} from "../desktop-native-migration.js";

const MODE_FILE = 0o600;
const MODE_DIRECTORY = 0o700;
const ARCHIVE_DIGEST = "a".repeat(64);

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: MODE_DIRECTORY });
  await chmod(path, MODE_DIRECTORY);
}

async function privateFile(path, value) {
  await privateDirectory(join(path, ".."));
  await writeFile(path, value, { mode: MODE_FILE });
  await chmod(path, MODE_FILE);
}

function candidate(overrides = {}) {
  const base = {
    route: NATIVE_ELECTRON_HANDOVER_ROUTE,
    native: {
      appId: "com.usagemonitor.local",
      version: "0.1.18",
      build: "20260905.1",
      signingLineage: "TEAM:source-lineage",
    },
    electron: {
      appId: "com.usagemonitor.local",
      version: "0.1.19",
      build: "20260906.1",
      signingLineage: "TEAM:source-lineage",
    },
    signatureEvidence: {
      nativeCodeHash: ARCHIVE_DIGEST.slice(0, 40),
      electronCodeHash: "b".repeat(40),
      helperCodeHash: "c".repeat(40),
    },
  };
  return {
    ...base,
    ...overrides,
    native: { ...base.native, ...overrides.native },
    electron: { ...base.electron, ...overrides.electron },
    signatureEvidence: { ...base.signatureEvidence, ...overrides.signatureEvidence },
  };
}

function bridgeResult({ startAtLogin = true } = {}) {
  return {
    status: "prepared",
    nativeWriterStopped: true,
    loginItemDisabled: true,
    preferences: {
      language: "en-US",
      appearance: "dark",
      refreshIntervalSeconds: 900,
      startAtLogin,
    },
    credentialState: "unchanged",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-native-handover-"));
  await chmod(root, MODE_DIRECTORY);
  const nativeStateRoot = join(root, "native-state");
  const userDataRoot = join(root, "electron-user-data");
  const backupRoot = join(root, "backups");
  const nativeAppPath = join(root, "TiboTattle.app");
  await Promise.all([
    privateDirectory(nativeStateRoot),
    privateDirectory(userDataRoot),
    privateDirectory(backupRoot),
    privateDirectory(nativeAppPath),
  ]);
  await privateFile(join(nativeStateRoot, "local-unified-index-v1.sqlite"), "sqlite-fixture");
  await privateFile(join(nativeStateRoot, "local-unified-index-device-salt-v1"), Buffer.alloc(32, 7));
  await privateFile(join(nativeStateRoot, "history", "one.json"), "history-fixture");
  await privateFile(join(nativeStateRoot, "private", "automatic-contribution-v0.1.json"), "{\"enabled\":false}\n");
  await privateFile(join(nativeStateRoot, "launcher-settings-v1.json"), `${JSON.stringify({
    schemaVersion: "usage-monitor-launcher-settings-v1",
    codexHome: "/private/tmp/synthetic-codex-home",
  })}\n`);
  await privateFile(join(nativeStateRoot, "first-run-v1.json"), `${JSON.stringify({
    schemaVersion: "usage-monitor-first-run-v1",
    acknowledged: true,
  })}\n`);
  return {
    root,
    nativeStateRoot,
    userDataRoot,
    backupRoot,
    nativeAppPath,
    async dispose() { await rm(root, { recursive: true, force: true }); },
  };
}

function control(calls, { startAtLogin = true } = {}) {
  return {
    async prepareNativeHandover() {
      calls.push("prepare");
      return bridgeResult({ startAtLogin });
    },
    async claimElectronLoginItem({ startAtLogin: requested }) {
      calls.push(`claim:${requested}`);
      return "owned";
    },
  };
}

function migrationOptions(state, calls, extra = {}) {
  return {
    nativeStateRoot: state.nativeStateRoot,
    userDataRoot: state.userDataRoot,
    backupRoot: state.backupRoot,
    nativeAppPath: state.nativeAppPath,
    candidate: candidate(),
    control: control(calls),
    ...extra,
  };
}

async function assertMigratedState(state) {
  assert.equal(
    await readFile(join(state.userDataRoot, "companion-state", "history", "one.json"), "utf8"),
    "history-fixture",
  );
  assert.deepEqual(
    await readFile(join(state.userDataRoot, "companion-state", "local-unified-index-device-salt-v1")),
    Buffer.alloc(32, 7),
  );
  assert.equal(
    await readFile(join(state.userDataRoot, "companion-state", "private", "automatic-contribution-v0.1.json"), "utf8"),
    "{\"enabled\":false}\n",
  );
  const settings = JSON.parse(await readFile(
    join(state.userDataRoot, "desktop-settings", "desktop-settings-v1.json"),
    "utf8",
  ));
  assert.equal(settings.schemaVersion, "tibotattle-desktop-settings-v2");
  assert.equal(settings.codexHomes.activityRoots[0].path, "/private/tmp/synthetic-codex-home");
  assert.equal(settings.language, "en");
  assert.equal(settings.appearance, "dark");
  assert.equal(settings.refreshIntervalSeconds, 900);
  assert.equal(settings.startAtLogin, true);
  assert.deepEqual(JSON.parse(await readFile(
    join(state.userDataRoot, "desktop-settings", "desktop-first-run-v1.json"),
    "utf8",
 )), {
    schemaVersion: "tibotattle-desktop-first-run-v1",
    acknowledged: true,
  });
  await assert.rejects(
    readFile(join(state.userDataRoot, "desktop-settings", "accountless-sharing-v1.json")),
    { code: "ENOENT" },
  );
}

test("guided signed handover copies stable state, salt, settings and existing sharing without touching source", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const calls = [];
  const originalHistory = await readFile(join(state.nativeStateRoot, "history", "one.json"));
  const result = await runNativeElectronHandover(migrationOptions(state, calls));

  assert.equal(result.status, "migrated");
  assert.deepEqual(calls, ["prepare", "claim:true"]);
  await assertMigratedState(state);
  assert.deepEqual(await readFile(join(state.nativeStateRoot, "history", "one.json")), originalHistory);
  assert.equal(
    JSON.parse(await readFile(join(
      state.userDataRoot,
      ".native-electron-handover-v1",
      NATIVE_ELECTRON_HANDOVER_JOURNAL_FILE,
    ), "utf8")).phase,
    "completed",
  );

  const again = await runNativeElectronHandover(migrationOptions(state, calls));
  assert.equal(again.status, "already_migrated");
  assert.deepEqual(calls, ["prepare", "claim:true"]);

  // A later Electron update must not need the old native state directory to
  // remain on disk. The completion marker is checked before source inspection
  // or any native-control call.
  await rm(state.nativeStateRoot, { recursive: true, force: true });
  const afterNativeRetirement = await runNativeElectronHandover(migrationOptions(state, calls, {
    // Completion is profile-scoped. A newer valid Electron candidate must not
    // demand the old native bundle or matching original candidate digest.
    candidate: candidate({ electron: { version: "0.1.20", build: "20260907.1" } }),
  }));
  assert.equal(afterNativeRetirement.status, "already_migrated");
  assert.deepEqual(calls, ["prepare", "claim:true"]);
});

test("a journaled interruption after each durable publish boundary resumes without duplicate state", async (t) => {
  for (const interruptedPhase of ["prepared", "backed_up", "staged", "published_state", "published", "electron_login_owned"]) {
    await t.test(interruptedPhase, async (subtest) => {
      const state = await fixture();
      subtest.after(state.dispose);
      const calls = [];
      await assert.rejects(
        runNativeElectronHandover(migrationOptions(state, calls, {
          afterCheckpoint(phase) {
            if (phase === interruptedPhase) throw new Error("synthetic interruption");
          },
        })),
        /synthetic interruption/u,
      );
      const resumed = await runNativeElectronHandover(migrationOptions(state, calls, {
        control: control(calls, { startAtLogin: false }),
      }));
      assert.equal(resumed.status, "migrated");
      await assertMigratedState(state);
      assert.equal(calls.filter((call) => call === "prepare").length, 2);
      assert.equal(calls.filter((call) => call === "claim:true").length,
        interruptedPhase === "electron_login_owned" ? 2 : 1);
      assert.equal(calls.includes("claim:false"), false);
    });
  }
});

test("a live exclusive lease rejects a second handover before native control is called", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const calls = [];
  const controlRoot = join(state.userDataRoot, ".native-electron-handover-v1");
  await privateDirectory(controlRoot);
  const digest = nativeElectronHandoverCandidateDigest(candidate());
  await privateFile(join(controlRoot, NATIVE_ELECTRON_HANDOVER_LEASE_FILE), `${JSON.stringify({
    schemaVersion: NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION,
    operationId: "11111111-1111-4111-8111-111111111111",
    candidateDigest: digest,
    pid: process.pid,
  })}\n`);
  await assert.rejects(runNativeElectronHandover(migrationOptions(state, calls)), (error) => {
    assert.equal(error.code, "native_electron_handover_lease_contended");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("resuming after native activity preserves both snapshots and migrates the latest history", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const calls = [];
  await assert.rejects(runNativeElectronHandover(migrationOptions(state, calls, {
    afterCheckpoint(phase) {
      if (phase === "published_state") throw new Error("synthetic interruption");
    },
  })), /synthetic interruption/u);
  await privateFile(join(state.nativeStateRoot, "history", "one.json"), "new-native-history");
  const result = await runNativeElectronHandover(migrationOptions(state, calls, {
    control: control(calls, { startAtLogin: false }),
  }));
  assert.equal(result.status, "migrated");
  assert.equal(await readFile(join(result.stateRoot, "history", "one.json"), "utf8"), "new-native-history");
  assert.equal(await readFile(join(state.nativeStateRoot, "history", "one.json"), "utf8"), "new-native-history");
  const operationRoot = join(state.backupRoot, "backups", (await readdir(join(state.backupRoot, "backups")))[0]);
  const retained = (await readdir(operationRoot)).filter((name) => name.startsWith("retained-snapshot-"));
  assert.equal(retained.length, 1);
  assert.equal(await readFile(join(operationRoot, retained[0], "history", "one.json"), "utf8"), "history-fixture");
  assert.deepEqual(calls, ["prepare", "prepare", "claim:true"]);
});

test("an unsafe completion-control directory blocks handover before native control is called", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const calls = [];
  const controlRoot = join(state.userDataRoot, ".native-electron-handover-v1");
  await privateDirectory(controlRoot);
  await chmod(controlRoot, 0o755);
  await assert.rejects(runNativeElectronHandover(migrationOptions(state, calls)), (error) => {
    assert.equal(error.code, "native_electron_handover_recovery_required");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("candidate gates reject direct Sparkle, identity mismatch, and nonmonotonic replacement", () => {
  assert.equal(validateNativeElectronHandoverCandidate(candidate()).route, NATIVE_ELECTRON_HANDOVER_ROUTE);
  for (const rejected of [
    candidate({ route: "sparkle_direct" }),
    candidate({ electron: { appId: "com.example.dev" } }),
    candidate({ electron: { build: "20260905.1" } }),
    candidate({ signatureEvidence: { helperCodeHash: "not-a-code-hash" } }),
  ]) {
    assert.throws(() => validateNativeElectronHandoverCandidate(rejected), (error) => {
      assert.match(error.code, /^native_electron_handover_/u);
      return true;
    });
  }
});

test("unsafe source entries fail closed before native control is asked to stop the writer", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const calls = [];
  await symlink("/tmp", join(state.nativeStateRoot, "unsafe-link"));
  await assert.rejects(runNativeElectronHandover(migrationOptions(state, calls)), (error) => {
    assert.equal(error.code, "native_electron_handover_unsafe_state");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("legacy readable files inside the private native root migrate to private copies without changing source", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const path = join(state.nativeStateRoot, "contribution-sync-v0.1.sqlite3");
  await privateFile(path, "legacy-queue");
  await chmod(path, 0o644);
  const result = await runNativeElectronHandover(migrationOptions(state, []));
  assert.equal((await lstat(path)).mode & 0o777, 0o644);
  const copied = join(result.stateRoot, "contribution-sync-v0.1.sqlite3");
  assert.equal(await readFile(copied, "utf8"), "legacy-queue");
  assert.equal((await lstat(copied)).mode & 0o777, 0o600);
});

test("group-writable legacy files remain a migration blocker", async (t) => {
  const state = await fixture();
  t.after(state.dispose);
  const path = join(state.nativeStateRoot, "unsafe.json");
  await privateFile(path, "{}");
  await chmod(path, 0o664);
  const calls = [];
  await assert.rejects(runNativeElectronHandover(migrationOptions(state, calls)), {
    code: "native_electron_handover_unsafe_state",
  });
  assert.deepEqual(calls, []);
});
