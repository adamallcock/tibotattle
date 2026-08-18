import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrCreateParticipantSecret } from "../src/platform/participant-identity.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function forgedWindowsFilesystem() {
  return Object.freeze({
    productionSafe: true,
    pathWalkRaceSafe: true,
    inspectPath() {},
    ensureDirectory() {},
    readFile() {},
    createFile() {},
    deleteFile() {},
    replaceFile() {},
  });
}

test("participant identity rejects a structurally complete but unbranded Windows adapter", async () => {
  await assert.rejects(
    loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: "C:\\state\\export-participant-secret",
      legacySecretFile: null,
      windowsFilesystemAdapter: forgedWindowsFilesystem(),
    }),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_ADAPTER_INVALID",
  );
});

test("participant identity rejects copied Windows adapter claims", async () => {
  await assert.rejects(
    loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: "C:\\state\\export-participant-secret",
      legacySecretFile: null,
      windowsFilesystemAdapter: { ...forgedWindowsFilesystem() },
    }),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_ADAPTER_INVALID",
  );
});

test("native source contract keeps sensitive opens handle-relative and replacement atomic", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
    "utf8",
  );
  const renameStart = source.indexOf("bool RenameHandleRelative(");
  const replaceStart = source.indexOf("napi_value ReplaceFileCallback(");
  const inspectStart = source.indexOf("napi_value InspectPathCallback(", replaceStart);
  assert.ok(renameStart >= 0 && replaceStart > renameStart && inspectStart > replaceStart);
  const renameBody = source.slice(renameStart, replaceStart);
  const replaceBody = source.slice(replaceStart, inspectStart);
  const withoutCppComments = (value) => value
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
  const executableRenameBody = withoutCppComments(renameBody);
  const executableReplaceBody = withoutCppComments(replaceBody);
  assert.match(source, /NtCreateFile/u);
  assert.match(source, /RootDirectory/u);
  assert.match(source, /NtSetInformationFile/u);
  assert.match(
    executableRenameBody,
    /information->flags = kFileRenameReplaceIfExists \| kFileRenamePosixSemantics;/u,
  );
  assert.match(
    executableRenameBody,
    /setInformation\(\s*handle,\s*&ioStatus,\s*information,\s*static_cast<ULONG>\(buffer\.size\(\)\),\s*kFileRenameInformationEx\s*\);/u,
  );
  assert.match(source, /GetLongPathNameW/u);
  assert.match(executableReplaceBody, /ResolveFinalPath\(check, &parsed\)/u);
  assert.match(
    executableReplaceBody,
    /ValidateSecurity\(opened\.final, false, &failure, &latest\)[\s\S]*?EqualIdentity\(latest, expected\)[\s\S]*?ResolveFinalPath\(opened\.final, &parsed\)/u,
  );
  assert.match(source, /const auto\* sidBytes = static_cast<const BYTE\*>\(user->User.Sid\)/u);
  assert.match(source, /DWORD descriptorRevision = 0/u);
  assert.match(source, /auto\* allowedAce = static_cast<ACCESS_ALLOWED_ACE\*>\(rawAce\)/u);
  assert.match(source, /SetSecurityDescriptorOwner\(\*descriptor, ownerSid->data\(\), FALSE\)/u);
  assert.match(source, /"securityPolicyReason"/u);
  assert.match(source, /"windowsFilesystemStage"/u);
  assert.match(source, /failure->stage = "rename"/u);
  assert.match(source, /SecurityPolicy\("dacl_update_failed"\)/u);
  assert.doesNotMatch(executableReplaceBody, /opened\.closeFinal\(\)/u);
  const identityCheckOffset = executableReplaceBody.indexOf("ValidateSecurity(opened.final");
  const renameCallOffset = executableReplaceBody.indexOf("RenameHandleRelative(");
  assert.ok(identityCheckOffset >= 0 && renameCallOffset > identityCheckOffset);
  assert.equal(
    executableReplaceBody.slice(identityCheckOffset, renameCallOffset)
      .includes("opened.closeFinal()"),
    false,
  );
  assert.match(source, /FILE_READ_DATA \| GENERIC_WRITE \| DELETE \| READ_CONTROL \| WRITE_DAC/u);
  assert.match(source, /DefineMethod\(env, exports, "replaceFile",/u);
  assert.match(source, /ArmReplacementPauseCallback/u);
  assert.match(source, /WaitForReplacementPauseCallback/u);
  assert.match(source, /ReleaseReplacementPauseCallback/u);
  assert.match(source, /QUALIFICATION_PAUSE_ALREADY_ARMED/u);
  assert.match(source, /CreateMutexExW/u);
  assert.match(source, /WaitForSingleObject\(handle, 0\)/u);
  assert.match(source, /waitResult == WAIT_ABANDONED_0/u);
  assert.match(source, /return ThrowFailure\(env, CredentialMutexAbandoned\(\)\)/u);
  assert.match(source, /IsIssuedCredentialMutexLease/u);
  assert.match(source, /std::mutex gCredentialMutexLeasesMutex/u);
  assert.match(source, /std::lock_guard<std::mutex> lock\(gCredentialMutexLeasesMutex\)/u);
  assert.match(source, /SE_KERNEL_OBJECT/u);
  assert.match(source, /ConvertSidToStringSidW/u);
  assert.match(source, /Local\\\\TiboTattle-CredentialMutation-v1-/u);
  assert.match(source, /DefineMethod\(env, exports, "acquireCredentialMutex",/u);
  assert.match(source, /DefineMethod\(env, exports, "releaseCredentialMutex",/u);
  assert.match(source, /protectedAncestorDepth = 2/u);
  assert.match(source, /protectedAncestorShareMode = FILE_SHARE_READ \| FILE_SHARE_WRITE/u);
  assert.match(source, /std::mutex gCredentialAuditFileGuardsMutex/u);
  assert.match(source, /IsIssuedCredentialAuditFileGuard/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"acquireCredentialAuditFileGuard",/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"releaseCredentialAuditFileGuard",/u);
  assert.match(source, /"windows-credential-audit-file-guard-v1"/u);
  assert.match(source, /napi_get_boolean\(env, false, &productionSafe\)/u);
  assert.match(source, /napi_get_boolean\(env, false, &pathWalkRaceSafe\)/u);
  assert.doesNotMatch(source, /ValidateComponents\(/u);
});

test("qualification hooks are opt-in and cannot become the production artifact", async () => {
  const gyp = JSON.parse(await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/binding.gyp"),
    "utf8",
  ));
  const production = gyp.targets.find(({ target_name }) => target_name === "windows_filesystem");
  const qualification = gyp.conditions
    .find(([expression]) => expression === "tibotattle_build_qualification==1")?.[1]
    ?.targets?.find(({ target_name }) => target_name === "windows_filesystem_qualification");
  assert.ok(production);
  assert.ok(qualification);
  assert.equal(
    production.defines.includes("TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK=1"),
    false,
  );
  assert.equal(
    qualification.defines.includes("TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK=1"),
    true,
  );
  assert.match(
    await readFile(
      resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
      "utf8",
    ),
    /ArmReplacementPauseCallback/u,
  );
  assert.match(
    await readFile(
      resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
      "utf8",
    ),
    /#if defined\(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK\)/u,
  );
});
