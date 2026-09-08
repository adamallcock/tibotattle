import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = resolve(new URL("..", import.meta.url).pathname);

test("native Linux credential mutex keeps a fixed x64, durable, opaque contract", async () => {
  const [source, bindingGyp, readme] = await Promise.all([
    readFile(
      resolve(
        REPOSITORY_ROOT,
        "native/linux-credential-mutex/linux-credential-mutex.cc",
      ),
      "utf8",
    ),
    readFile(
      resolve(REPOSITORY_ROOT, "native/linux-credential-mutex/binding.gyp"),
      "utf8",
    ),
    readFile(
      resolve(REPOSITORY_ROOT, "native/linux-credential-mutex/README.md"),
      "utf8",
    ),
  ]);

  assert.match(bindingGyp, /"target_name": "linux_credential_mutex"/u);
  assert.match(bindingGyp, /"NAPI_VERSION=8"/u);
  assert.match(bindingGyp, /OS!='linux' or target_arch!='x64'/u);
  assert.match(bindingGyp, /pkg-config --cflags libsecret-1/u);
  assert.match(bindingGyp, /pkg-config --libs-only-l libsecret-1/u);
  assert.doesNotMatch(bindingGyp, /-fexceptions/u);
  assert.match(source, /#include <libsecret\/secret\.h>/u);
  assert.match(source, /SYS_openat2/u);
  assert.match(source, /RESOLVE_NO_SYMLINKS/u);
  assert.match(source, /O_NOFOLLOW/u);
  assert.match(source, /XDG_STATE_HOME/u);
  assert.match(source, /prepareLinuxCredentialState/u);
  assert.match(source, /PrepareLinuxCredentialState/u);
  assert.match(source, /CurrentAccountHomeDirectory/u);
  assert.match(source, /getpwuid_r/u);
  assert.match(source, /PrepareDefaultStateBaseDirectory/u);
  assert.match(source, /PrepareConfiguredStateBaseDirectory/u);
  assert.match(source, /PreflightExistingCredentialStateDirectories/u);
  assert.match(source, /ReopenAndValidateCredentialStateDirectories/u);
  assert.match(source, /mkdirat\(parent_fd, child, 0700\)/u);
  assert.doesNotMatch(source, /getenv\("HOME"\)/u);
  assert.doesNotMatch(source, /mkdir\(/u);
  assert.doesNotMatch(source, /\bumask\(/u);
  assert.match(source, /app-usagemonitor/u);
  assert.match(source, /linux-credential-mutex-v1/u);
  assert.match(source, /AF_UNIX/u);
  assert.match(source, /SOCK_CLOEXEC/u);
  assert.match(source, /kSocketNamespace/u);
  assert.match(source, /EADDRINUSE/u);
  assert.match(source, /bind\(fd/u);
  assert.match(source, /kJournalActiveText/u);
  assert.match(source, /kJournalNormalText/u);
  assert.match(source, /kAccountlessInstallationCredentialSlot = 4/u);
  assert.match(source, /kAccountObservationCredentialSlot = 5/u);
  assert.match(source, /kLastCapabilityId = 3/u);
  assert.match(source, /IsCapabilityId\(\*capability_id\)/u);
  assert.match(source, /value == kAccountObservationCredentialSlot/u);
  assert.match(source, /readAccountlessInstallationCredential/u);
  assert.match(source, /createAccountlessInstallationCredentialIfMissing/u);
  assert.match(source, /deleteAccountlessInstallationCredentialExact/u);
  assert.match(source, /readAccountObservationCredential/u);
  assert.match(source, /createAccountObservationCredentialIfMissing/u);
  assert.match(source, /kAccountlessCredentialBytes = 32/u);
  assert.match(source, /OpenAccountlessCredentialDirectory/u);
  assert.match(source, /kAccountlessOperationJournalFile/u);
  assert.match(source, /accountless-operation-4-v2/u);
  assert.match(source, /kAccountlessOperationJournalBytes = 64/u);
  assert.match(source, /kAccountlessOperationJournalMagic/u);
  assert.match(source, /kAccountlessOperationJournalVersion = 2/u);
  assert.match(source, /kAccountlessCreateTemporaryFile/u);
  assert.match(source, /kAccountlessDeleteTemporaryFile/u);
  assert.match(source, /CreateAccountlessOperationJournal/u);
  assert.match(source, /RecoverAccountlessOperationJournal/u);
  assert.match(source, /VerifyDurableAccountlessOperationPostcondition/u);
  assert.match(source, /AccountlessOperationPostconditionHolds/u);
  assert.match(source, /SettleAccountlessMutation/u);
  assert.match(source, /NoFixedAccountlessOperationResidue/u);
  assert.match(source, /accountless_operation_journal_written/u);
  assert.match(source, /O_CREAT \| O_EXCL/u);
  assert.match(source, /O_RDONLY \| O_CLOEXEC \| O_NOFOLLOW \| O_NONBLOCK/u);
  assert.match(source, /RENAME_NOREPLACE/u);
  assert.match(source, /BeginAccountlessMutation/u);
  assert.match(source, /LatchAccountlessRecovery/u);
  assert.match(source, /accountless_active_marker_written/u);
  assert.match(
    source,
    /if \(!preserve_active && !lease->accountless_active_marker_written\) \{/u,
  );
  assert.match(source, /ReadJournalState\(lease->journal_fd\) == JournalState::kNormal/u);
  assert.match(source, /FailAccountlessRecovery/u);
  assert.match(source, /FailAccountlessPendingOperation/u);
  assert.match(source, /AccountlessOperationJournalRemoveOutcome::kUncertain/u);
  assert.match(source, /LatchUnissuedAccountlessRecovery\(/u);
  assert.match(source, /unlinkat\(credential_directory_fd, temporary_name, 0\)/u);
  assert.match(source, /WriteJournalState/u);
  assert.match(source, /VerifyJournalContinuity/u);
  assert.match(source, /fstatat\(state_fd/u);
  assert.match(source, /AT_SYMLINK_NOFOLLOW/u);
  assert.match(source, /AbandonCredentialMutex/u);
  assert.match(source, /preserve_active \|\| lease->abandoned/u);
  assert.match(source, /#error "linux_credential_mutex requires Linux x86_64"/u);
  assert.match(source, /napi_create_external/u);
  assert.match(source, /g_issued_leases/u);
  assert.match(source, /LINUX_CREDENTIAL_MUTEX_FOREIGN/u);
  assert.match(source, /account-observation-operation-5-v1/u);
  assert.match(source, /kAccountObservationOperationJournalBytes = 64/u);
  assert.match(source, /kAccountObservationOperationJournalMagic/u);
  assert.match(source, /kAccountObservationOperationJournalVersion = 1/u);
  assert.match(source, /kAccountObservationOperationCreate = 1/u);
  assert.match(source, /DigestAccountObservationCredential/u);
  assert.match(source, /RecoverAccountObservationOperationJournal/u);
  assert.match(
    source,
    /SettleAccountObservationMutation[\s\S]*?LatchAccountObservationRecovery\(lease\)[\s\S]*?RemoveAccountObservationOperationJournal/u,
  );
  assert.match(source, /SECRET_SEARCH_ALL \| SECRET_SEARCH_LOAD_SECRETS/u);
  assert.match(source, /secret_collection_get_locked\(collection\)/u);
  assert.match(source, /secret_item_create_sync/u);
  assert.match(source, /SECRET_ITEM_CREATE_NONE/u);
  assert.match(source, /kAccountObservationOperationDeadline \{5'000\}/u);
  assert.match(source, /class AccountObservationDeadlineGuard/u);
  assert.match(source, /g_cancellable_new\(\)/u);
  assert.match(source, /g_cancellable_cancel\(current\)/u);
  assert.match(source, /g_thread_try_new\(/u);
  assert.match(source, /g_thread_join\(watchdog\)/u);
  assert.match(source, /g_cond_wait_until\(/u);
  assert.match(
    source,
    /expires_at_ = g_get_monotonic_time\(\)[\s\S]*?g_thread_try_new\(/u,
  );
  assert.match(source, /const bool expired_before_join = DeadlineElapsedLocked\(\)/u);
  assert.match(source, /const bool expired_after_join = DeadlineElapsedLocked\(\)/u);
  assert.match(
    source,
    /g_mutex_unlock\(&mutex_\);\s*if \(cancellation != nullptr\) g_cancellable_cancel\(cancellation\);\s*if \(watchdog != nullptr\) g_thread_join\(watchdog\)/u,
  );
  assert.doesNotMatch(source, /std::thread/u);
  assert.doesNotMatch(source, /\bcatch\s*\(/u);
  assert.match(source, /FinishAccountObservationCancellation/u);
  assert.match(source, /FinishAccountObservationNormal/u);
  assert.match(source, /deadline->StopDeadline\(\)/u);
  assert.match(
    source,
    /OpenAccountObservationDefaultCollection\(cancellable\)[\s\S]*?AccountObservationDeadlineCancelled\(cancellable\)[\s\S]*?BeginAccountObservationMutation/u,
  );
  assert.match(
    source,
    /BeginAccountObservationMutation\(lease, work->candidate\)[\s\S]*?AccountObservationDeadlineCancelled\(cancellable\)[\s\S]*?FinishAccountObservationRecovery\(lease\)/u,
  );
  assert.match(
    source,
    /RecoverAccountObservationOperationJournal[\s\S]*?AccountObservationDeadlineCancelled\(cancellable\)[\s\S]*?AccountObservationOperationRecoveryOutcome::kUnavailable/u,
  );
  assert.doesNotMatch(
    source,
    /SECRET_SEARCH_ALL \| SECRET_SEARCH_LOAD_SECRETS\),\s*nullptr,\s*&error/u,
  );
  assert.doesNotMatch(
    source,
    /SECRET_COLLECTION_NONE,\s*nullptr,\s*&error/u,
  );
  assert.doesNotMatch(
    source,
    /SECRET_ITEM_CREATE_NONE,\s*nullptr,\s*&error/u,
  );
  assert.match(source, /napi_create_async_work/u);
  assert.match(source, /QueueAccountObservationWork/u);
  assert.doesNotMatch(source, /secret_password_store_sync/u);
  assert.doesNotMatch(source, /SECRET_ITEM_CREATE_REPLACE/u);
  assert.match(source, /"credentialMutexCrossProcessSafe", true/u);
  assert.match(source, /"credentialMutexSameNetworkNamespaceOnly", true/u);
  assert.match(source, /"credentialMutexDurableMarker", true/u);
  assert.match(source, /"productionSafe", false/u);
  assert.doesNotMatch(source, /flock\(/u);
  assert.doesNotMatch(source, /TransientRecordName/u);
  assert.doesNotMatch(source, /getrandom\(/u);
  assert.doesNotMatch(source, /XDG_RUNTIME_DIR/u);
  assert.doesNotMatch(source, /safeStorage/u);
  assert.doesNotMatch(source, /productionSafe", true/u);
  assert.match(readme, /persistent XDG state\s+tree/u);
  assert.match(readme, /umask that masks an\s+owner permission bit/u);
  assert.match(readme, /rather than chmod-repairing it/u);
  assert.match(readme, /same Linux network namespace/u);
  assert.match(readme, /recovery_required/u);
  assert.match(readme, /accountless-operation-4-v2/u);
  assert.match(readme, /account-observation-operation-5-v1/u);
  assert.match(readme, /SHA-256\(candidate\)/u);
  assert.match(readme, /no-replace creation/u);
  assert.match(readme, /unresolvable-digest refusal/u);
  assert.match(readme, /libsecret-1/u);
  assert.match(readme, /modeled interruption states/u);
  assert.match(readme, /five-second\s+aggregate deadline/u);
  assert.match(readme, /fallible thread constructor/u);
  assert.match(readme, /watchdog-thread creation failure/u);
  assert.match(readme, /never replies/u);
  assert.match(readme, /not a\s+selected credential\s+backend/u);
});
