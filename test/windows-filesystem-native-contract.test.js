import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOrCreateParticipantSecret,
  rotateParticipantSecret,
  withParticipantSecretLease,
} from "../src/platform/participant-identity.js";

const IDENTITY_BASE = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00000000000000000000000000000001",
  linkCount: 1,
});

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function memoryWindowsFilesystem() {
  const files = new Map();
  let nextId = 1;
  const identityFor = () => ({
    ...IDENTITY_BASE,
    fileId: nextId.toString(16).padStart(32, "0"),
  });
  return {
    productionSafe: true,
    pathWalkRaceSafe: true,
    files,
    directories: new Set(),
    ensureDirectory(path) {
      this.directories.add(path);
      return IDENTITY_BASE;
    },
    readFile(path) {
      const value = files.get(path);
      if (!value) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { data: Buffer.from(value.data), identity: value.identity };
    },
    createFile(path, data) {
      if (files.has(path)) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      const identity = identityFor();
      nextId += 1;
      files.set(path, { data: Buffer.from(data), identity });
      return identity;
    },
    deleteFile(path, identity) {
      const value = files.get(path);
      if (!value) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      if (value.identity.fileId !== identity.fileId) {
        const error = new Error("changed");
        error.code = "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH";
        throw error;
      }
      files.delete(path);
      return { deleted: true, identity };
    },
  };
}

test("participant identity uses the injected Windows handle contract for state and control files", async () => {
  const filesystem = memoryWindowsFilesystem();
  const secretFile = join(tmpdir(), "state-root", "app-usagemonitor", "export-participant-secret");
  const first = await loadOrCreateParticipantSecret({
    environmentSecret: null,
    secretFile,
    legacySecretFile: null,
    windowsFilesystemAdapter: filesystem,
  });
  const second = await loadOrCreateParticipantSecret({
    environmentSecret: null,
    secretFile,
    legacySecretFile: null,
    windowsFilesystemAdapter: filesystem,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(first.secret, second.secret);
  assert.equal(filesystem.files.size, 1);
  assert.deepEqual([...filesystem.directories], [dirname(secretFile)]);

  let callbackObserved = false;
  await withParticipantSecretLease({
    environmentSecret: null,
    secretFile,
    legacySecretFile: null,
    windowsFilesystemAdapter: filesystem,
  }, async (identity) => {
    callbackObserved = true;
    assert.deepEqual(identity.secret, first.secret);
  });
  assert.equal(callbackObserved, true);
  assert.equal([...filesystem.files.keys()].some((path) => path.endsWith("rotation-lock")), false);
});

test("Windows file-backed rotation remains fail closed until atomic replacement is handle-bound", async () => {
  const filesystem = memoryWindowsFilesystem();
  const secretFile = join(tmpdir(), "state-root", "app-usagemonitor", "export-participant-secret");
  await loadOrCreateParticipantSecret({
    environmentSecret: null,
    secretFile,
    legacySecretFile: null,
    windowsFilesystemAdapter: filesystem,
  });
  await assert.rejects(
    rotateParticipantSecret({
      confirmRotation: true,
      environmentSecret: null,
      secretFile,
      legacySecretFile: null,
      windowsFilesystemAdapter: filesystem,
    }),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_ROTATION_REPLACEMENT_UNAVAILABLE",
  );
});

test("native source contract keeps sensitive opens handle-relative and replacement atomic", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
    "utf8",
  );
  assert.match(source, /NtCreateFile/u);
  assert.match(source, /RootDirectory/u);
  assert.match(source, /NtSetInformationFile/u);
  assert.match(source, /kFileRenameInformation/u);
  assert.match(source, /GetLongPathNameW/u);
  assert.match(source, /ResolveFinalPath\(check, &parsed\)/u);
  assert.match(source, /const auto\* sidBytes = static_cast<const BYTE\*>\(user->User.Sid\)/u);
  assert.match(source, /DWORD descriptorRevision = 0/u);
  assert.match(source, /auto\* allowedAce = static_cast<ACCESS_ALLOWED_ACE\*>\(rawAce\)/u);
  assert.match(source, /SetSecurityDescriptorOwner\(\*descriptor, ownerSid->data\(\), FALSE\)/u);
  assert.match(source, /"securityPolicyReason"/u);
  assert.match(source, /"windowsFilesystemStage"/u);
  assert.match(source, /failure->stage = "rename"/u);
  assert.match(source, /SecurityPolicy\("dacl_update_failed"\)/u);
  assert.match(source, /opened\.closeFinal\(\)/u);
  assert.match(source, /Legacy FileRenameInformation rejects replacement/u);
  assert.match(source, /FILE_READ_DATA \| GENERIC_WRITE \| DELETE \| READ_CONTROL \| WRITE_DAC/u);
  assert.match(source, /DefineMethod\(env, exports, "replaceFile",/u);
  assert.match(source, /napi_get_boolean\(env, false, &productionSafe\)/u);
  assert.match(source, /napi_get_boolean\(env, false, &pathWalkRaceSafe\)/u);
  assert.doesNotMatch(source, /ValidateComponents\(/u);
});
