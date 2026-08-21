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
  const protectedReplaceStart = source.indexOf("napi_value ReplaceProtectedChildCallback(");
  const protectedDeleteStart = source.indexOf("napi_value DeleteProtectedChildCallback(");
  const ownerOnlyResourcesStart = source.indexOf(
    "struct OwnerOnlySecurityResources",
    protectedDeleteStart,
  );
  assert.ok(
    renameStart >= 0
      && replaceStart > renameStart
      && inspectStart > replaceStart
      && protectedReplaceStart > inspectStart
      && protectedDeleteStart > inspectStart
      && protectedDeleteStart > protectedReplaceStart
      && ownerOnlyResourcesStart > protectedDeleteStart,
  );
  const renameBody = source.slice(renameStart, replaceStart);
  const replaceBody = source.slice(replaceStart, inspectStart);
  const protectedDeleteBody = source.slice(protectedDeleteStart, ownerOnlyResourcesStart);
  const withoutCppComments = (value) => value
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
  const executableRenameBody = withoutCppComments(renameBody);
  const executableReplaceBody = withoutCppComments(replaceBody);
  const protectedReplaceBody = source.slice(protectedReplaceStart, protectedDeleteStart);
  const executableProtectedDeleteBody = withoutCppComments(protectedDeleteBody);
  const executableProtectedReplaceBody = withoutCppComments(protectedReplaceBody);
  assert.match(source, /NtCreateFile/u);
  assert.match(source, /RootDirectory/u);
  assert.match(source, /NtSetInformationFile/u);
  assert.match(source, /napi_value values\[8\] = \{\}/u);
  assert.match(source, /std::size_t count = 8;[\s\S]*?count != expected/u);
  assert.match(source, /OpenProtectedRootAndChild\(/u);
  assert.match(source, /ParseExpectedIdentity\(env, arguments\[1\]/u);
  assert.match(source, /ValidateSecurity\(rootOpened\.final, true, failure, &observedRoot\)/u);
  assert.match(
    source,
    /ReadHandleBounded\([\s\S]*?maximumBytes[\s\S]*?bytes->assign\(/u,
  );
  assert.match(
    source,
    /static_cast<unsigned long long>\(size\.QuadPart\)[\s\S]*?maximumBytes[\s\S]*?TooLarge\(\)/u,
  );
  assert.match(source, /const std::size_t remaining = bytes->size\(\) - offset;/u);
  assert.match(
    source,
    /if \(read == 0 \|\| static_cast<std::size_t>\(read\) > remaining\)/u,
  );
  assert.match(source, /GetFileSizeEx\(handle, &finalSize\)/u);
  assert.match(
    source,
    /finalSize\.QuadPart != size\.QuadPart[\s\S]*?FileSizeChanged\(\)/u,
  );
  assert.match(
    source,
    /if \(offset == path\.size\(\) \|\| path\[offset\] == L'\\\\'\) return false;/u,
  );
  for (const method of [
    "readFileBounded",
    "inspectProtectedChild",
    "readProtectedChild",
    "createProtectedChild",
    "deleteProtectedChild",
    "replaceProtectedChild",
    "acquireSqliteStateLease",
    "releaseSqliteStateLease",
    "createSqliteDatabase",
    "cloneSqliteDatabase",
    "publishSqliteDatabase",
    "inspectPreparedChild",
    "ensurePreparedDirectory",
    "enumeratePreparedDirectory",
    "removePreparedDirectory",
    "renamePreparedDirectory",
    "createPreparedFile",
    "readPreparedFile",
    "deletePreparedFile",
    "publishPreparedFile",
    "acquireCompanionInstanceMutex",
    "releaseCompanionInstanceMutex",
  ]) {
    assert.match(source, new RegExp(`DefineMethod[\\s\\S]+"${method}"`, "u"));
  }
  assert.match(source, /companionInstanceMutexContractVersion/u);
  assert.match(source, /companionInstanceMutexSafe/u);
  assert.match(
    executableRenameBody,
    /information->flags = kFileRenamePosixSemantics\s*\|\s*\(replaceIfExists \? kFileRenameReplaceIfExists : 0\);/u,
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
  assert.match(
    executableProtectedDeleteBody,
    /ValidateSecurity\(opened\.final, false, &failure, &current\)[\s\S]*?EqualIdentity\(current, expected\)[\s\S]*?ResolveFinalPath\(opened\.final, &fullPath\)[\s\S]*?FILE_DISPOSITION_INFO/u,
  );
  const protectedReadbackOffset = executableProtectedReplaceBody.indexOf(
    "ReadHandleBounded(",
  );
  const protectedReplacementPathOffset = executableProtectedReplaceBody.indexOf(
    "ResolveFinalPath(replacement",
  );
  const protectedTargetRevalidationOffset = executableProtectedReplaceBody.indexOf(
    "ValidateSecurity(opened.final",
    protectedReplacementPathOffset,
  );
  const protectedRenameOffset = executableProtectedReplaceBody.indexOf(
    "RenameHandleRelative(",
  );
  assert.ok(
    protectedReadbackOffset >= 0
      && protectedReplacementPathOffset > protectedReadbackOffset
      && protectedTargetRevalidationOffset > protectedReplacementPathOffset
      && protectedRenameOffset > protectedTargetRevalidationOffset,
  );
  assert.doesNotMatch(
    executableProtectedReplaceBody.slice(protectedRenameOffset),
    /ReadHandleBounded\(|OpenRelativeComponent\(|ResolveFinalPath\(/u,
  );
  assert.match(source, /const auto\* sidBytes = static_cast<const BYTE\*>\(user->User.Sid\)/u);
  assert.match(source, /DWORD descriptorRevision = 0/u);
  assert.match(source, /auto\* allowedAce = static_cast<ACCESS_ALLOWED_ACE\*>\(rawAce\)/u);
  assert.match(source, /SetSecurityDescriptorOwner\(\*descriptor, ownerSid->data\(\), FALSE\)/u);
  assert.match(source, /"securityPolicyReason"/u);
  assert.match(source, /"windowsFilesystemStage"/u);
  assert.match(source, /failure->stage = "rename"/u);
  for (const stage of [
    "prepared_root_open",
    "prepared_root_validation",
    "prepared_child_open",
    "prepared_child_create",
    "prepared_dacl_update",
    "prepared_child_validation",
    "prepared_ancestor_validation",
    "prepared_final_validation",
  ]) {
    assert.match(source, new RegExp(`"${stage}"`, "u"));
  }
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
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"acquireSqliteStateLease",/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"releaseSqliteStateLease",/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"createSqliteDatabase",/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"cloneSqliteDatabase",/u);
  assert.match(source, /DefineMethod\(\s*env,\s*exports,\s*"publishSqliteDatabase",/u);
  assert.match(source, /CopyHandleToHandle\(/u);
  assert.match(source, /RequireSqliteSidecarsAbsent\(/u);
  assert.match(source, /windows-sqlite-state-staging-v1/u);
  assert.match(source, /windows-prepared-artifact-v1/u);
  assert.match(source, /preparedArtifactSafe/u);
  assert.match(source, /kMaximumPreparedArtifactBytes/u);
  assert.match(source, /kMaximumPreparedContributionBytes/u);
  assert.match(source, /kPreparedChunkBytes/u);
  assert.match(source, /FileIdBothDirectoryInfo/u);
  assert.match(source, /PreparedDirectoryNotEmpty/u);
  assert.match(source, /DeletePreparedFileCallback/u);
  assert.match(source, /FlushPreparedDirectoryBoundary/u);
  assert.match(source, /RenameHandleRelative\([\s\S]*?false\)/u);
  assert.match(source, /napi_get_boolean\(env, false, &sqliteStateStagingSafe\)/u);
  assert.match(source, /"windows-sqlite-state-lease-v1"/u);
  assert.match(source, /napi_get_boolean\(env, false, &sqliteStateLeaseSafe\)/u);
  assert.match(source, /std::mutex gSqliteStateLeasesMutex/u);
  assert.match(source, /IsIssuedSqliteStateLease/u);
  assert.match(source, /SqliteStateLeaseContended/u);
  assert.match(source, /SqliteStateLeaseSidecarPresent/u);
  assert.match(source, /ReserveSqliteSidecar/u);
  assert.match(source, /kFileDeleteOnClose/u);
  assert.match(source, /options\.shareMode = 0/u);
  assert.match(source, /options\.disposition = kFileCreate/u);
  assert.match(source, /options\.extraOptions = kFileDeleteOnClose/u);
  assert.match(source, /kFileNonDirectoryFile \| options\.extraOptions/u);
  assert.doesNotMatch(source, /\bkFileNonDirectory\b/u);
  assert.match(source, /sidecarReservations/u);
  assert.match(source, /lease->sidecarReservations = std::move\(sidecarReservations\)/u);
  assert.doesNotMatch(
    source,
    /AppendHandles\(&handles,\s*std::move\(sidecarReservations\)\)/u,
  );
  assert.match(source, /protectedRootHandleIndex/u);
  assert.match(source, /databaseName = databaseName/u);
  assert.match(source, /MarkSqliteStateLeaseSidecarsForDeletion/u);
  assert.match(source, /WaitForSqliteStateLeaseSidecarsAbsent/u);
  assert.match(source, /GetTickCount64\(\)/u);
  assert.match(source, /Sleep\(/u);
  assert.match(source, /SqliteStateLeaseMutexName/u);
  assert.match(source, /CreateMutexExW/u);
  assert.match(source, /WaitForSingleObject\(mutex, 0\)/u);
  assert.match(
    source,
    /waitResult == WAIT_ABANDONED_0[\s\S]*?\*result = mutex;/u,
  );
  assert.match(source, /ownerThreadId != GetCurrentThreadId\(\)/u);
  assert.match(
    source,
    /ownerThreadId != GetCurrentThreadId\(\)[\s\S]*?return ThrowFailure\(env, SqliteStateLeaseForeign\(\)\);[\s\S]*?UnregisterSqliteStateLease\(lease\)/u,
  );
  assert.match(source, /SqliteStateLeaseReleaseFailed/u);
  const sqliteReleaseStart = source.indexOf("napi_value ReleaseSqliteStateLeaseCallback(");
  const credentialLeaseStart = source.indexOf("struct CredentialMutexLease", sqliteReleaseStart);
  assert.ok(sqliteReleaseStart >= 0 && credentialLeaseStart > sqliteReleaseStart);
  const sqliteReleaseBody = source.slice(sqliteReleaseStart, credentialLeaseStart);
  const markSidecarsOffset = sqliteReleaseBody.indexOf("MarkSqliteStateLeaseSidecarsForDeletion(");
  const closeSidecarsOffset = sqliteReleaseBody.indexOf("CloseSqliteStateLeaseSidecars(");
  const absentProofOffset = sqliteReleaseBody.indexOf("WaitForSqliteStateLeaseSidecarsAbsent(");
  const ordinaryCloseOffset = sqliteReleaseBody.indexOf("CloseSqliteStateLeaseHandleVector(");
  const releaseMutexOffset = sqliteReleaseBody.indexOf("ReleaseMutex(lease->coordination)");
  const unregisterOffset = sqliteReleaseBody.indexOf("UnregisterSqliteStateLease(lease)");
  assert.ok(
    markSidecarsOffset >= 0
      && closeSidecarsOffset > markSidecarsOffset
      && absentProofOffset > closeSidecarsOffset
      && ordinaryCloseOffset > absentProofOffset
      && releaseMutexOffset > ordinaryCloseOffset
      && unregisterOffset > releaseMutexOffset,
  );
  assert.match(source, /FILE_SHARE_READ \| FILE_SHARE_WRITE/u);
  assert.match(source, /EndsWithInsensitive\(supplied, L"-journal"\)/u);
  assert.match(source, /EndsWithInsensitive\(supplied, L"-wal"\)/u);
  assert.match(source, /EndsWithInsensitive\(supplied, L"-shm"\)/u);
  assert.match(source, /TakeAllHandles\(&rootOpened\)/u);
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
    /AttemptCompanionInstanceMutexReleaseFromWorkerCallback/u,
  );
  assert.match(
    await readFile(
      resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
      "utf8",
    ),
    /#if defined\(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK\)/u,
  );
});

test("SQLite publication diagnostics use the fixed ordered phase vocabulary", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
    "utf8",
  );
  const publishStart = source.indexOf("napi_value PublishSqliteDatabaseCallback(");
  const publishEnd = source.indexOf("napi_value DeleteProtectedChildCallback(", publishStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  const publishBody = source.slice(publishStart, publishEnd);
  const stages = [
    "publish_parse",
    "publish_stage_open",
    "publish_stage_preflight",
    "publish_target_open",
    "publish_target_preflight",
    "publish_stage_revalidate",
    "publish_target_revalidate",
    "publish_rename",
    "publish_stage_postvalidate",
    "publish_target_postopen",
    "publish_target_postvalidate",
  ];
  const stageAssignments = [
    ...publishBody.matchAll(/failure\.stage = "(publish_[a-z_]+)";/gu),
  ];
  const failureBoundaries = [...publishBody.matchAll(/return ThrowFailure\(env,/gu)];
  assert.equal(stageAssignments.length, failureBoundaries.length);
  assert.deepEqual(
    [...new Set(stageAssignments.map((match) => match[1]))],
    stages,
  );
  assert.deepEqual(
    stages.map((stage) => publishBody.indexOf(`failure.stage = "${stage}";`)),
    [...stages]
      .sort((left, right) => publishBody.indexOf(`failure.stage = "${left}";`)
        - publishBody.indexOf(`failure.stage = "${right}";`))
      .map((stage) => publishBody.indexOf(`failure.stage = "${stage}";`)),
  );
  assert.doesNotMatch(publishBody, /failure\.stage = "(?!publish_)[^"]+"/u);
  const stageOpenBranchStart = publishBody.indexOf("if (!OpenSqliteStagingChild(");
  const stageOpenBranchEnd = publishBody.indexOf("  if (!EqualIdentity", stageOpenBranchStart);
  assert.ok(stageOpenBranchStart >= 0 && stageOpenBranchEnd > stageOpenBranchStart);
  const stageOpenBranch = publishBody.slice(stageOpenBranchStart, stageOpenBranchEnd);
  const stageOpenNormalizationOffset = stageOpenBranch.indexOf(
    "if (failure.code == OperationFailed().code) failure = IdentityMismatch();",
  );
  const stageOpenAssignmentOffset = stageOpenBranch.indexOf(
    'failure.stage = "publish_stage_open";',
  );
  const stageOpenThrowOffset = stageOpenBranch.indexOf(
    "return ThrowFailure(env, failure);",
  );
  assert.ok(
    stageOpenNormalizationOffset >= 0
      && stageOpenNormalizationOffset < stageOpenAssignmentOffset
      && stageOpenAssignmentOffset < stageOpenThrowOffset,
  );
  assert.match(
    publishBody,
    /RenameHandleRelative\([\s\S]*?\)\)\s*\{[\s\S]*?failure\.stage = "publish_rename";/u,
  );
  for (const match of failureBoundaries) {
    const prefix = publishBody.slice(0, match.index);
    assert.match(prefix, /failure\.stage = "publish_[a-z_]+";\s*$/u);
  }
});

test("SQLite staging grants existing-stage write access only to publication", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
    "utf8",
  );
  const stagingStart = source.indexOf("bool OpenSqliteStagingChild(");
  const createStart = source.indexOf("napi_value CreateSqliteDatabaseCallback(", stagingStart);
  const cloneStart = source.indexOf("napi_value CloneSqliteDatabaseCallback(", createStart);
  const publishStart = source.indexOf("napi_value PublishSqliteDatabaseCallback(", cloneStart);
  const publishEnd = source.indexOf("napi_value DeleteProtectedChildCallback(", publishStart);
  assert.ok(
    stagingStart >= 0
      && createStart > stagingStart
      && cloneStart > createStart
      && publishStart > cloneStart
      && publishEnd > publishStart,
  );
  const stagingBody = source.slice(stagingStart, createStart);
  const createBody = source.slice(createStart, cloneStart);
  const cloneBody = source.slice(cloneStart, publishStart);
  const publishBody = source.slice(publishStart, publishEnd);

  assert.match(stagingBody, /bool existingWriteAccess,/u);
  assert.match(
    stagingBody,
    /options\.access = GENERIC_READ \| DELETE \| READ_CONTROL \| FILE_READ_ATTRIBUTES \| SYNCHRONIZE;/u,
  );
  const existingWriteAccessMatch = stagingBody.match(
    /if \(createNew \|\| existingWriteAccess\) \{([\s\S]*?)\}/u,
  );
  assert.ok(existingWriteAccessMatch);
  assert.match(existingWriteAccessMatch[1], /GENERIC_WRITE/u);
  assert.doesNotMatch(existingWriteAccessMatch[1], /WRITE_DAC/u);
  assert.match(
    stagingBody,
    /if \(createNew\) \{\s*options\.access \|= WRITE_DAC;\s*\}/u,
  );
  assert.match(
    createBody,
    /OpenSqliteStagingChild\([\s\S]*?databaseName,\s*true,\s*false,\s*&opened/u,
  );
  assert.match(
    cloneBody,
    /OpenSqliteStagingChild\([\s\S]*?sourceName,\s*false,\s*false,\s*&source/u,
  );
  assert.match(
    cloneBody,
    /OpenSqliteStagingChild\([\s\S]*?stageName,\s*true,\s*false,\s*&stage/u,
  );
  assert.match(
    publishBody,
    /OpenSqliteStagingChild\([\s\S]*?stageName,\s*false,\s*true,\s*&stage/u,
  );
  assert.doesNotMatch(
    cloneBody,
    /OpenSqliteStagingChild\([\s\S]*?stageName,\s*false,\s*true,\s*&stage/u,
  );

  const flushStart = publishBody.indexOf("if (!FlushFileBuffers(stage.final))");
  const flushEnd = publishBody.indexOf("return ThrowFailure(env, failure);", flushStart);
  assert.ok(flushStart >= 0 && flushEnd > flushStart);
  assert.match(
    publishBody.slice(flushStart, flushEnd),
    /failure = FromLastError\(\);\s*failure\.stage = "publish_stage_preflight";/u,
  );
  assert.match(source, /napi_get_boolean\(env, false, &sqliteStateLeaseSafe\)/u);
  assert.match(source, /napi_get_boolean\(env, false, &sqliteStateStagingSafe\)/u);
  assert.doesNotMatch(publishBody, /sqliteState(?:Lease|Staging)Safe/u);
});
