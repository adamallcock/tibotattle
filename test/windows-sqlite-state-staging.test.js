import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsSqliteStateStaging,
  isWindowsSqliteStateStaging,
} from "../src/platform/windows-sqlite-state-staging.js";

const ROOT = "C:\\Users\\test\\AppData\\Local\\TiboTattle";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});
const LIVE_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "11112233445566778899aabbccddeeff",
  linkCount: 1,
});
const STAGE_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "22222233445566778899aabbccddeeff",
  linkCount: 1,
});

function metadata(identity, directory = false) {
  return {
    identity,
    isDirectory: directory,
    isRegularFile: !directory,
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

function binding(calls) {
  return {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    inspectPath: () => metadata(ROOT_IDENTITY, true),
    ensureDirectory: () => ROOT_IDENTITY,
    readFile: () => ({ data: Buffer.from(""), identity: LIVE_IDENTITY }),
    readFileBounded: () => ({ data: Buffer.from(""), identity: LIVE_IDENTITY }),
    createFile: () => LIVE_IDENTITY,
    deleteFile: () => ({ deleted: true, identity: LIVE_IDENTITY }),
    replaceFile: () => LIVE_IDENTITY,
    inspectProtectedChild: (_root, _identity, name) => {
      if (name === "local-unified-index-v1.sqlite") return metadata(LIVE_IDENTITY);
      if (name.includes(".building-")) return metadata(STAGE_IDENTITY);
      const error = new Error("missing");
      error.code = "WINDOWS_FILESYSTEM_NOT_FOUND";
      throw error;
    },
    readProtectedChild: () => ({ data: Buffer.from(""), identity: LIVE_IDENTITY }),
    createProtectedChild: () => LIVE_IDENTITY,
    deleteProtectedChild: (_root, _identity, name, identity) => {
      calls.push(["discard", name, identity]);
      return { deleted: true, identity };
    },
    replaceProtectedChild: () => LIVE_IDENTITY,
    acquireSqliteStateLease: () => ({
      lease: {},
      databaseIdentity: LIVE_IDENTITY,
      journalIdentity: LIVE_IDENTITY,
    }),
    releaseSqliteStateLease: () => {},
    acquireCredentialAuditFileGuard: () => ({ lease: {} }),
    releaseCredentialAuditFileGuard: () => {},
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
    createSqliteDatabase: (_root, _identity, name) => {
      calls.push(["create", name]);
      return STAGE_IDENTITY;
    },
    cloneSqliteDatabase: (_root, _identity, source, stage) => {
      calls.push(["clone", source, stage]);
      return { sourceIdentity: LIVE_IDENTITY, stageIdentity: STAGE_IDENTITY };
    },
    publishSqliteDatabase: (_root, _identity, stage, expectedStage, target, expectedTarget) => {
      calls.push(["publish", stage, expectedStage, target, expectedTarget]);
      return { published: true, identity: STAGE_IDENTITY };
    },
  };
}

test("Windows SQLite staging routes clone and publication through the native adapter", () => {
  const calls = [];
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding(calls),
  });
  const staging = createWindowsSqliteStateStaging({ adapter, rootPath: ROOT });
  assert.equal(isWindowsSqliteStateStaging(staging), true);
  assert.equal(staging.stagingSafe, false);

  const clone = staging.clone(
    "local-unified-index-v1.sqlite",
    "local-unified-index-v1.sqlite.building-1",
  );
  assert.deepEqual(clone, {
    sourceIdentity: LIVE_IDENTITY,
    stageIdentity: STAGE_IDENTITY,
  });
  const published = staging.publish(
    "local-unified-index-v1.sqlite.building-1",
    "local-unified-index-v1.sqlite",
    LIVE_IDENTITY,
  );
  assert.deepEqual(published, { published: true, identity: STAGE_IDENTITY });
  assert.equal(calls[0][0], "clone");
  assert.equal(calls[1][0], "publish");
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("staging cleanup remains root-bound and identity-bound", () => {
  const calls = [];
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding(calls),
  });
  const staging = createWindowsSqliteStateStaging({ adapter, rootPath: ROOT });
  staging.create("local-unified-index-v1.sqlite.building-2");
  staging.discard("local-unified-index-v1.sqlite.building-2");
  assert.deepEqual(calls.at(-1), [
    "discard",
    "local-unified-index-v1.sqlite.building-2",
    STAGE_IDENTITY,
  ]);
});
