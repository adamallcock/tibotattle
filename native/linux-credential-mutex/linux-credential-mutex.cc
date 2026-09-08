#include <node_api.h>

#if defined(LINUX_CREDENTIAL_MUTEX_UNSUPPORTED_TARGET)
#error "linux_credential_mutex requires Linux x86_64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <pwd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <libsecret/secret.h>

#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

constexpr int kFirstCapabilityId = 0;
constexpr int kLastCapabilityId = 3;
// The accountless installation credential intentionally has no generic
// capability handle. Slot four is consumed only by the fixed methods below;
// `acquireCredentialMutex` remains limited to the inherited 0..3 FD4 set.
constexpr int kAccountlessInstallationCredentialSlot = 4;
// The observation root has a distinct fixed slot and a native-private API.
// It never expands the inherited generic 0..3 FD4 capability surface.
constexpr int kAccountObservationCredentialSlot = 5;
constexpr char kApplicationDirectory[] = "app-usagemonitor";
constexpr char kMutexDirectory[] = "linux-credential-mutex-v1";
constexpr char kAccountlessCredentialDirectory[] =
    "linux-accountless-installation-credential-v1";
constexpr char kAccountlessCredentialFile[] =
    "accountless-installation-credential-v1";
// This is a fixed, private intent record for slot four only. It deliberately
// lives beside the legacy mutex journal rather than widening that generic
// 0..3 format or API.
constexpr char kAccountlessOperationJournalFile[] =
    "accountless-operation-4-v2";
constexpr char kAccountlessCreateTemporaryFile[] =
    ".accountless-create-4-v2";
constexpr char kAccountlessDeleteTemporaryFile[] =
    ".accountless-delete-4-v2";
constexpr char kAccountObservationOperationJournalFile[] =
    "account-observation-operation-5-v1";
constexpr char kAccountObservationService[] =
    "app-usagemonitor.account-observation.v1";
constexpr char kAccountObservationAccount[] = "installation";
constexpr char kAccountObservationLabel[] =
    "app-usagemonitor.account-observation.v1/installation";
constexpr char kSocketNamespace[] = "app-usagemonitor/linux-credential-mutex-v1";
constexpr char kJournalActiveText[] = "linux-credential-mutex-journal-v1:active\n";
constexpr char kJournalNormalText[] = "linux-credential-mutex-journal-v1:normal\n";
constexpr std::size_t kMaximumPathBytes = 4096;
constexpr std::size_t kMaximumPasswordRecordBytes = 1024 * 1024;
constexpr std::size_t kAccountlessCredentialBytes = 32;
constexpr std::size_t kAccountlessOperationJournalBytes = 64;
constexpr std::size_t kAccountlessOperationJournalMagicBytes = 16;
constexpr std::size_t kAccountlessOperationJournalVersionOffset = 16;
constexpr std::size_t kAccountlessOperationJournalOperationOffset = 17;
constexpr std::size_t kAccountlessOperationJournalReservedStart = 18;
constexpr std::size_t kAccountlessOperationJournalValueOffset = 32;
constexpr unsigned char kAccountlessOperationJournalVersion = 2;
constexpr std::size_t kAccountObservationCredentialBytes = 32;
constexpr std::size_t kAccountObservationOperationJournalBytes = 64;
constexpr std::size_t kAccountObservationOperationJournalMagicBytes = 16;
constexpr std::size_t kAccountObservationOperationJournalVersionOffset = 16;
constexpr std::size_t kAccountObservationOperationJournalOperationOffset = 17;
constexpr std::size_t kAccountObservationOperationJournalReservedStart = 18;
constexpr std::size_t kAccountObservationOperationJournalDigestOffset = 32;
constexpr unsigned char kAccountObservationOperationJournalVersion = 1;
constexpr unsigned char kAccountObservationOperationCreate = 1;
constexpr std::chrono::milliseconds kAccountObservationOperationDeadline {5'000};
// Exact binary bytes: the printable namespace is deliberately terminated and
// padded instead of relying on a C string's implicit trailing byte.
constexpr std::array<unsigned char, kAccountlessOperationJournalMagicBytes>
    kAccountlessOperationJournalMagic {{
        'T', 'I', 'B', 'O', 'T', 'A', 'T', 'T',
        'L', 'E', '-', 'F', 'D', '3', '\0', '\0',
    }};
// Exact binary bytes: the printable FD4 namespace is terminated and padded
// explicitly. The intent retains only SHA-256(candidate), never the account
// observation root itself.
constexpr std::array<unsigned char, kAccountObservationOperationJournalMagicBytes>
    kAccountObservationOperationJournalMagic {{
        'T', 'I', 'B', 'O', 'T', 'A', 'T', 'T',
        'L', 'E', '-', 'F', 'D', '4', '\0', '\0',
    }};

const SecretSchema kAccountObservationSecretSchema = {
    "org.freedesktop.Secret.Generic", SECRET_SCHEMA_NONE, {
        { "service", SECRET_SCHEMA_ATTRIBUTE_STRING },
        { "account", SECRET_SCHEMA_ATTRIBUTE_STRING },
    }};

static_assert(
    sizeof(kJournalActiveText) == sizeof(kJournalNormalText),
    "journal state records must have a fixed length");

constexpr char kCodeInvalidCapability[] =
    "LINUX_CREDENTIAL_MUTEX_INVALID_CAPABILITY";
constexpr char kCodeContended[] = "LINUX_CREDENTIAL_MUTEX_CONTENDED";
constexpr char kCodeForeign[] = "LINUX_CREDENTIAL_MUTEX_FOREIGN";
constexpr char kCodeReleaseFailed[] = "LINUX_CREDENTIAL_MUTEX_RELEASE_FAILED";
constexpr char kCodeRuntimeUnavailable[] =
    "LINUX_CREDENTIAL_MUTEX_RUNTIME_UNAVAILABLE";
constexpr char kCodeStateUnavailable[] =
    "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE";
constexpr char kCodeStateInvalid[] =
    "LINUX_CREDENTIAL_MUTEX_STATE_INVALID";
constexpr char kCodeAccountlessUnavailable[] =
    "LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE";
constexpr char kCodeAccountlessRecoveryRequired[] =
    "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED";
constexpr char kCodeAccountlessInvalidValue[] =
    "LINUX_ACCOUNTLESS_CREDENTIAL_INVALID_VALUE";
constexpr char kCodeAccountObservationUnavailable[] =
    "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE";
constexpr char kCodeAccountObservationRecoveryRequired[] =
    "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_RECOVERY_REQUIRED";
constexpr char kCodeAccountObservationInvalidValue[] =
    "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_INVALID_VALUE";

struct FileIdentity {
  dev_t device = 0;
  ino_t inode = 0;
};

struct NativeLease {
  int socket_fd = -1;
  int persistent_state_fd = -1;
  int journal_fd = -1;
  FileIdentity journal_identity {};
  int accountless_operation_journal_fd = -1;
  FileIdentity accountless_operation_journal_identity {};
  int capability_id = -1;
  bool abandoned = false;
  bool active = true;
  // Private accountless operations hold the socket while they preflight. The
  // durable marker is written immediately before their first credential
  // mutation or when an unsafe record must be latched for recovery. Generic
  // FD4 leases retain their existing eager-marker behavior.
  bool accountless_active_marker_written = false;
  // A complete v2 fixed intent is recoverable under the same private socket.
  // It is never rewritten or replaced after creation; failure leaves it for a
  // later exact replay rather than falling back to the generic v1 marker.
  bool accountless_operation_journal_written = false;
};

enum class JournalState {
  kActive,
  kNormal,
  kInvalid,
};

enum class JournalOpenOutcome {
  kCreated,
  kOpened,
  kFailure,
};

enum class AccountlessRecordState {
  kAbsent,
  kPresent,
  kInvalid,
  kUnavailable,
};

enum class DirectoryOpenOutcome {
  kOpened,
  kMissing,
  kInvalid,
};

std::mutex g_issued_leases_mutex;
std::unordered_set<NativeLease*> g_issued_leases;

bool FinishLease(NativeLease* lease, bool preserve_active);
bool CloseDescriptor(int* fd);
void CloseUnissuedLeaseDescriptors(
    int* socket_fd,
    int* persistent_state_fd,
    int* journal_fd);
bool AcquireKernelLeaseSocket(int capability_id, int* socket_fd, bool* contended);

uid_t OwnerUid() {
  return geteuid();
}

napi_value MakeFixedError(napi_env env, const char* code) {
  napi_value message = nullptr;
  napi_value error = nullptr;
  napi_value code_value = nullptr;
  if (napi_create_string_utf8(
          env,
          "Linux credential mutex operation failed",
          NAPI_AUTO_LENGTH,
          &message) != napi_ok
      || napi_create_error(env, nullptr, message, &error) != napi_ok
      || napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok
      || napi_set_named_property(env, error, "code", code_value) != napi_ok) {
    napi_throw_error(env, nullptr, "Linux credential mutex operation failed");
    return nullptr;
  }
  return error;
}

napi_value ThrowFixed(napi_env env, const char* code) {
  napi_value error = MakeFixedError(env, code);
  if (error != nullptr) napi_throw(env, error);
  return nullptr;
}

bool IsCapabilityId(int value) {
  return value >= kFirstCapabilityId && value <= kLastCapabilityId;
}

bool IsInternalCredentialSlot(int value) {
  return IsCapabilityId(value)
      || value == kAccountlessInstallationCredentialSlot
      || value == kAccountObservationCredentialSlot;
}

bool IsNormalizedAbsolutePath(const char* path) {
  if (path == nullptr || path[0] != '/') return false;
  const std::size_t length = strnlen(path, kMaximumPathBytes + 1);
  if (length == 0 || length > kMaximumPathBytes || path[length - 1] == '/') {
    return false;
  }
  std::size_t start = 1;
  for (std::size_t index = 1; index <= length; ++index) {
    if (path[index] != '/' && path[index] != '\0') continue;
    const std::size_t component_length = index - start;
    if (component_length == 0
        || (component_length == 1 && path[start] == '.')
        || (component_length == 2 && path[start] == '.' && path[start + 1] == '.')) {
      return false;
    }
    start = index + 1;
  }
  return true;
}

bool IsOwnerDirectory(const struct stat& metadata, bool owner_only) {
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != OwnerUid()) return false;
  const mode_t mode = metadata.st_mode & 0777;
  if ((mode & 0700) != 0700 || (mode & 0022) != 0) return false;
  return !owner_only || (mode & 0077) == 0;
}

bool IsOwnerRegularFile(const struct stat& metadata) {
  if (!S_ISREG(metadata.st_mode)
      || metadata.st_uid != OwnerUid()
      || metadata.st_nlink != 1) {
    return false;
  }
  return (metadata.st_mode & 0777) == 0600;
}

// Directory descriptors are retained across the fixed replay flow, but each
// mutation rechecks the opened directory's owner-only mode before it acts.
bool VerifyOwnerPrivateDirectory(int fd) {
  struct stat metadata {};
  return fd >= 0
      && fstat(fd, &metadata) == 0
      && IsOwnerDirectory(metadata, true);
}

bool CaptureRegularFileIdentity(int fd, FileIdentity* identity) {
  if (identity == nullptr) return false;
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsOwnerRegularFile(metadata)) return false;
  identity->device = metadata.st_dev;
  identity->inode = metadata.st_ino;
  return true;
}

bool MatchesIdentity(const struct stat& metadata, const FileIdentity& identity) {
  return metadata.st_dev == identity.device && metadata.st_ino == identity.inode;
}

bool SameFileIdentity(const FileIdentity& first, const FileIdentity& second) {
  return first.device == second.device && first.inode == second.inode;
}

int OpenNoSymlinkDirectory(const std::string& path, bool allow_root = false) {
  // Keep the original state-base guard for every existing caller. Only the
  // custom-base parent opener may explicitly request a handle for `/`.
  if ((path == "/" && !allow_root)
      || (path != "/" && !IsNormalizedAbsolutePath(path.c_str()))) {
    return -1;
  }
#if defined(SYS_openat2)
  struct open_how how {};
  how.flags = static_cast<__u64>(O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  how.resolve = static_cast<__u64>(RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS);
  return static_cast<int>(syscall(
      SYS_openat2,
      AT_FDCWD,
      path.c_str(),
      &how,
      sizeof(how)));
#else
  errno = ENOSYS;
  return -1;
#endif
}

int OpenVerifiedDirectoryPath(const std::string& path, bool owner_only) {
  const int fd = OpenNoSymlinkDirectory(path);
  if (fd < 0) return -1;
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsOwnerDirectory(metadata, owner_only)) {
    close(fd);
    return -1;
  }
  return fd;
}

int OpenVerifiedDirectoryAt(int parent_fd, const char* child, bool owner_only) {
  const int fd = openat(
      parent_fd,
      child,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsOwnerDirectory(metadata, owner_only)) {
    close(fd);
    return -1;
  }
  return fd;
}

int OpenExistingVerifiedDirectoryPath(
    const std::string& path,
    bool owner_only,
    DirectoryOpenOutcome* outcome) {
  if (outcome == nullptr) return -1;
  *outcome = DirectoryOpenOutcome::kInvalid;
  const int fd = OpenNoSymlinkDirectory(path);
  if (fd < 0) {
    if (errno == ENOENT) *outcome = DirectoryOpenOutcome::kMissing;
    return -1;
  }
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsOwnerDirectory(metadata, owner_only)) {
    close(fd);
    return -1;
  }
  *outcome = DirectoryOpenOutcome::kOpened;
  return fd;
}

int OpenExistingVerifiedDirectoryAt(
    int parent_fd,
    const char* child,
    bool owner_only,
    DirectoryOpenOutcome* outcome) {
  if (outcome == nullptr) return -1;
  *outcome = DirectoryOpenOutcome::kInvalid;
  const int fd = openat(
      parent_fd,
      child,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    if (errno == ENOENT) *outcome = DirectoryOpenOutcome::kMissing;
    return -1;
  }
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsOwnerDirectory(metadata, owner_only)) {
    close(fd);
    return -1;
  }
  *outcome = DirectoryOpenOutcome::kOpened;
  return fd;
}

int EnsureVerifiedDirectoryAt(
    int parent_fd,
    const char* child,
    bool owner_only,
    bool durable) {
  bool created = false;
  if (mkdirat(parent_fd, child, 0700) == 0) {
    created = true;
  } else if (errno != EEXIST) {
    return -1;
  }
  const int fd = OpenVerifiedDirectoryAt(parent_fd, child, owner_only);
  if (fd < 0) return -1;
  if (created && durable && fsync(parent_fd) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

int EnsurePrivateDirectoryAt(int parent_fd, const char* child, bool durable) {
  return EnsureVerifiedDirectoryAt(parent_fd, child, true, durable);
}

bool CurrentAccountHomeDirectory(std::string* result) {
  if (result == nullptr) return false;
  long requested = sysconf(_SC_GETPW_R_SIZE_MAX);
  if (requested < 0 || requested > static_cast<long>(kMaximumPasswordRecordBytes)) {
    requested = 16 * 1024;
  }
  std::vector<char> storage(static_cast<std::size_t>(requested));
  struct passwd record {};
  struct passwd* resolved = nullptr;
  if (getpwuid_r(
          OwnerUid(),
          &record,
          storage.data(),
          storage.size(),
          &resolved) != 0
      || resolved == nullptr
      || !IsNormalizedAbsolutePath(record.pw_dir)) {
    return false;
  }
  *result = record.pw_dir;
  return true;
}

bool StateBaseDirectory(std::string* result, bool* configured_result = nullptr) {
  if (result == nullptr) return false;
  const char* configured = getenv("XDG_STATE_HOME");
  if (configured != nullptr) {
    if (!IsNormalizedAbsolutePath(configured)) return false;
    *result = configured;
    if (configured_result != nullptr) *configured_result = true;
    return true;
  }

  std::string home;
  if (!CurrentAccountHomeDirectory(&home)) return false;
  const std::string candidate = home + "/.local/state";
  if (!IsNormalizedAbsolutePath(candidate.c_str())) return false;
  *result = candidate;
  if (configured_result != nullptr) *configured_result = false;
  return true;
}

bool SplitNormalizedAbsolutePath(
    const std::string& path,
    std::string* parent,
    std::string* leaf) {
  if (parent == nullptr
      || leaf == nullptr
      || !IsNormalizedAbsolutePath(path.c_str())) {
    return false;
  }
  const std::size_t separator = path.rfind('/');
  if (separator == std::string::npos || separator + 1 >= path.size()) return false;
  *parent = separator == 0 ? "/" : path.substr(0, separator);
  *leaf = path.substr(separator + 1);
  return !leaf->empty();
}

bool IsSafeStateBaseParent(const struct stat& metadata) {
  if (!S_ISDIR(metadata.st_mode)
      || (metadata.st_uid != OwnerUid() && metadata.st_uid != 0)) {
    return false;
  }
  const mode_t mode = metadata.st_mode & 0777;
  return (mode & 0700) == 0700 && (mode & 0022) == 0;
}

int OpenSafeStateBaseParent(const std::string& path) {
  const int fd = OpenNoSymlinkDirectory(path, true);
  if (fd < 0) return -1;
  struct stat metadata {};
  if (fstat(fd, &metadata) != 0 || !IsSafeStateBaseParent(metadata)) {
    close(fd);
    return -1;
  }
  return fd;
}

int ReopenPreparedStateBaseDirectory(const std::string& state_base) {
  return OpenVerifiedDirectoryPath(state_base, false);
}

int PrepareConfiguredStateBaseDirectory(const std::string& state_base) {
  std::string parent;
  std::string leaf;
  if (!SplitNormalizedAbsolutePath(state_base, &parent, &leaf)) return -1;
  const int parent_fd = OpenSafeStateBaseParent(parent);
  if (parent_fd < 0) return -1;
  const int base_fd = EnsureVerifiedDirectoryAt(parent_fd, leaf.c_str(), false, true);
  const bool parent_closed = close(parent_fd) == 0;
  if (base_fd < 0 || !parent_closed) {
    if (base_fd >= 0) close(base_fd);
    return -1;
  }
  const bool base_closed = close(base_fd) == 0;
  if (!base_closed) return -1;
  return ReopenPreparedStateBaseDirectory(state_base);
}

int PrepareDefaultStateBaseDirectory(const std::string& state_base) {
  std::string home;
  if (!CurrentAccountHomeDirectory(&home)) return -1;
  if (state_base != home + "/.local/state") return -1;
  const int home_fd = OpenVerifiedDirectoryPath(home, false);
  if (home_fd < 0) return -1;

  DirectoryOpenOutcome local_outcome = DirectoryOpenOutcome::kInvalid;
  int local_fd = OpenExistingVerifiedDirectoryAt(
      home_fd,
      ".local",
      false,
      &local_outcome);
  if (local_fd < 0 && local_outcome != DirectoryOpenOutcome::kMissing) {
    close(home_fd);
    return -1;
  }
  if (local_fd < 0) {
    local_fd = EnsureVerifiedDirectoryAt(home_fd, ".local", false, true);
  }
  const bool home_closed = close(home_fd) == 0;
  if (local_fd < 0 || !home_closed) {
    if (local_fd >= 0) close(local_fd);
    return -1;
  }

  DirectoryOpenOutcome state_outcome = DirectoryOpenOutcome::kInvalid;
  int state_fd = OpenExistingVerifiedDirectoryAt(
      local_fd,
      "state",
      false,
      &state_outcome);
  if (state_fd < 0 && state_outcome != DirectoryOpenOutcome::kMissing) {
    close(local_fd);
    return -1;
  }
  if (state_fd < 0) {
    state_fd = EnsureVerifiedDirectoryAt(local_fd, "state", false, true);
  }
  const bool local_closed = close(local_fd) == 0;
  if (state_fd < 0 || !local_closed) {
    if (state_fd >= 0) close(state_fd);
    return -1;
  }
  const bool state_closed = close(state_fd) == 0;
  if (!state_closed) return -1;
  return ReopenPreparedStateBaseDirectory(state_base);
}

int OpenOrPrepareStateBaseDirectory(std::string* state_base) {
  if (state_base == nullptr) return -1;
  bool configured = false;
  if (!StateBaseDirectory(state_base, &configured)) return -1;
  DirectoryOpenOutcome outcome = DirectoryOpenOutcome::kInvalid;
  const int existing = OpenExistingVerifiedDirectoryPath(
      *state_base,
      false,
      &outcome);
  if (existing >= 0) {
    // Reopen existing bases through their validated parent. The passwd
    // fallback has a fixed two-component suffix, and a configured base must
    // also keep its direct parent safe even when no base creation is needed.
    if (close(existing) != 0) return -1;
    return configured
        ? PrepareConfiguredStateBaseDirectory(*state_base)
        : PrepareDefaultStateBaseDirectory(*state_base);
  }
  if (outcome != DirectoryOpenOutcome::kMissing) return -1;
  return configured
      ? PrepareConfiguredStateBaseDirectory(*state_base)
      : PrepareDefaultStateBaseDirectory(*state_base);
}

bool PreflightExistingCredentialStateDirectories(int state_base_fd) {
  DirectoryOpenOutcome application_outcome = DirectoryOpenOutcome::kInvalid;
  const int application_fd = OpenExistingVerifiedDirectoryAt(
      state_base_fd,
      kApplicationDirectory,
      true,
      &application_outcome);
  if (application_fd < 0) return application_outcome == DirectoryOpenOutcome::kMissing;

  DirectoryOpenOutcome mutex_outcome = DirectoryOpenOutcome::kInvalid;
  const int mutex_fd = OpenExistingVerifiedDirectoryAt(
      application_fd,
      kMutexDirectory,
      true,
      &mutex_outcome);
  DirectoryOpenOutcome accountless_outcome = DirectoryOpenOutcome::kInvalid;
  const int accountless_fd = OpenExistingVerifiedDirectoryAt(
      application_fd,
      kAccountlessCredentialDirectory,
      true,
      &accountless_outcome);
  const bool valid = mutex_outcome != DirectoryOpenOutcome::kInvalid
      && accountless_outcome != DirectoryOpenOutcome::kInvalid;
  const bool accountless_closed = accountless_fd < 0 || close(accountless_fd) == 0;
  const bool mutex_closed = mutex_fd < 0 || close(mutex_fd) == 0;
  const bool application_closed = close(application_fd) == 0;
  return valid && accountless_closed && mutex_closed && application_closed;
}

bool PrepareFixedCredentialStateDirectories(int state_base_fd) {
  int application_fd = EnsurePrivateDirectoryAt(
      state_base_fd,
      kApplicationDirectory,
      true);
  if (application_fd < 0) return false;
  int mutex_fd = EnsurePrivateDirectoryAt(application_fd, kMutexDirectory, true);
  if (mutex_fd < 0) {
    close(application_fd);
    return false;
  }
  int accountless_fd = EnsurePrivateDirectoryAt(
      application_fd,
      kAccountlessCredentialDirectory,
      true);
  const bool accountless_closed = accountless_fd >= 0 && close(accountless_fd) == 0;
  const bool mutex_closed = close(mutex_fd) == 0;
  const bool application_closed = close(application_fd) == 0;
  return accountless_fd >= 0
      && accountless_closed
      && mutex_closed
      && application_closed;
}

bool ReopenAndValidateCredentialStateDirectories(const std::string& state_base) {
  const int state_base_fd = ReopenPreparedStateBaseDirectory(state_base);
  if (state_base_fd < 0) return false;
  const int application_fd = OpenVerifiedDirectoryAt(
      state_base_fd,
      kApplicationDirectory,
      true);
  if (application_fd < 0) {
    close(state_base_fd);
    return false;
  }
  const int mutex_fd = OpenVerifiedDirectoryAt(
      application_fd,
      kMutexDirectory,
      true);
  const int accountless_fd = OpenVerifiedDirectoryAt(
      application_fd,
      kAccountlessCredentialDirectory,
      true);
  const bool accountless_closed = accountless_fd >= 0 && close(accountless_fd) == 0;
  const bool mutex_closed = mutex_fd >= 0 && close(mutex_fd) == 0;
  const bool application_closed = close(application_fd) == 0;
  const bool state_base_closed = close(state_base_fd) == 0;
  return accountless_fd >= 0
      && mutex_fd >= 0
      && accountless_closed
      && mutex_closed
      && application_closed
      && state_base_closed;
}

int OpenPersistentStateDirectory() {
  std::string state_base;
  if (!StateBaseDirectory(&state_base)) return -1;
  const int base_fd = OpenVerifiedDirectoryPath(state_base, false);
  if (base_fd < 0) return -1;
  const int application_fd = EnsurePrivateDirectoryAt(
      base_fd,
      kApplicationDirectory,
      true);
  close(base_fd);
  if (application_fd < 0) return -1;
  const int mutex_fd = EnsurePrivateDirectoryAt(
      application_fd,
      kMutexDirectory,
      true);
  close(application_fd);
  return mutex_fd;
}

// The upload-only accountless record has its own fixed owner-private state
// directory. It is deliberately separate from the mutex journal directory
// and from all legacy four-capability data.
int OpenAccountlessCredentialDirectory() {
  std::string state_base;
  if (!StateBaseDirectory(&state_base)) return -1;
  const int base_fd = OpenVerifiedDirectoryPath(state_base, false);
  if (base_fd < 0) return -1;
  const int application_fd = EnsurePrivateDirectoryAt(
      base_fd,
      kApplicationDirectory,
      true);
  close(base_fd);
  if (application_fd < 0) return -1;
  const int credential_fd = EnsurePrivateDirectoryAt(
      application_fd,
      kAccountlessCredentialDirectory,
      true);
  close(application_fd);
  return credential_fd;
}

bool CapabilityFileName(int capability_id, const char* prefix, char* output, std::size_t length) {
  if (!IsInternalCredentialSlot(capability_id) || length < 32) return false;
  const int written = snprintf(output, length, "%s-%d-v1", prefix, capability_id);
  return written > 0 && static_cast<std::size_t>(written) < length;
}

bool JournalFileName(int capability_id, char* output, std::size_t length) {
  return CapabilityFileName(capability_id, "journal", output, length);
}

bool ReadAll(int fd, char* bytes, std::size_t length) {
  std::size_t read_total = 0;
  while (read_total < length) {
    const ssize_t count = read(fd, bytes + read_total, length - read_total);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    read_total += static_cast<std::size_t>(count);
  }
  return true;
}

bool WriteAll(int fd, const char* bytes, std::size_t length) {
  std::size_t written = 0;
  while (written < length) {
    const ssize_t result = write(fd, bytes + written, length - written);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) return false;
    written += static_cast<std::size_t>(result);
  }
  return true;
}

bool VerifyJournalContinuity(
    int state_fd,
    int journal_fd,
    int capability_id,
    const FileIdentity& identity) {
  char name[48] {};
  if (!JournalFileName(capability_id, name, sizeof(name))) return false;
  struct stat opened {};
  struct stat named {};
  return fstat(journal_fd, &opened) == 0
      && IsOwnerRegularFile(opened)
      && MatchesIdentity(opened, identity)
      && fstatat(state_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0
      && IsOwnerRegularFile(named)
      && MatchesIdentity(named, identity);
}

JournalState ReadJournalState(int journal_fd) {
  std::array<char, sizeof(kJournalActiveText)> bytes {};
  char trailing = 0;
  if (lseek(journal_fd, 0, SEEK_SET) < 0
      || !ReadAll(journal_fd, bytes.data(), sizeof(kJournalActiveText) - 1)) {
    return JournalState::kInvalid;
  }
  ssize_t trailing_count = 0;
  do {
    trailing_count = read(journal_fd, &trailing, 1);
  } while (trailing_count < 0 && errno == EINTR);
  if (trailing_count != 0) return JournalState::kInvalid;
  if (std::memcmp(
          bytes.data(),
          kJournalActiveText,
          sizeof(kJournalActiveText) - 1) == 0) {
    return JournalState::kActive;
  }
  if (std::memcmp(
          bytes.data(),
          kJournalNormalText,
          sizeof(kJournalNormalText) - 1) == 0) {
    return JournalState::kNormal;
  }
  return JournalState::kInvalid;
}

bool WriteJournalState(
    int state_fd,
    int journal_fd,
    int capability_id,
    const FileIdentity& identity,
    JournalState state) {
  const char* bytes = state == JournalState::kActive
      ? kJournalActiveText
      : state == JournalState::kNormal ? kJournalNormalText : nullptr;
  if (bytes == nullptr
      || !VerifyJournalContinuity(state_fd, journal_fd, capability_id, identity)
      || ftruncate(journal_fd, 0) != 0
      || lseek(journal_fd, 0, SEEK_SET) < 0
      || !WriteAll(journal_fd, bytes, sizeof(kJournalActiveText) - 1)
      || fsync(journal_fd) != 0
      || !VerifyJournalContinuity(state_fd, journal_fd, capability_id, identity)) {
    return false;
  }
  return true;
}

JournalOpenOutcome OpenJournal(
    int state_fd,
    int capability_id,
    int* journal_fd,
    FileIdentity* identity) {
  if (journal_fd == nullptr || identity == nullptr) return JournalOpenOutcome::kFailure;
  *journal_fd = -1;
  char name[48] {};
  if (!JournalFileName(capability_id, name, sizeof(name))) {
    return JournalOpenOutcome::kFailure;
  }

  int fd = openat(state_fd, name, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (fd >= 0) {
    if (!CaptureRegularFileIdentity(fd, identity)
        || !VerifyJournalContinuity(state_fd, fd, capability_id, *identity)) {
      close(fd);
      return JournalOpenOutcome::kFailure;
    }
    *journal_fd = fd;
    return JournalOpenOutcome::kOpened;
  }
  if (errno != ENOENT) return JournalOpenOutcome::kFailure;

  fd = openat(
      state_fd,
      name,
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (fd < 0) return JournalOpenOutcome::kFailure;
  if (!CaptureRegularFileIdentity(fd, identity)
      || !VerifyJournalContinuity(state_fd, fd, capability_id, *identity)
      || fsync(state_fd) != 0) {
    close(fd);
    return JournalOpenOutcome::kFailure;
  }
  *journal_fd = fd;
  return JournalOpenOutcome::kCreated;
}

// This is used only by the accountless lease while it still knows it created
// this journal and has not reached a credential mutation boundary. It never
// clears an existing or potentially active journal: continuity must prove the
// exact freshly-created inode is still named before unlinking it.
bool RemoveFreshAccountlessJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity) {
  char name[48] {};
  return JournalFileName(
             kAccountlessInstallationCredentialSlot,
             name,
             sizeof(name))
      && VerifyJournalContinuity(
          state_fd,
          journal_fd,
          kAccountlessInstallationCredentialSlot,
          identity)
      && unlinkat(state_fd, name, 0) == 0
      && fsync(state_fd) == 0;
}

bool VerifyNamedRegularFileContinuity(
    int directory_fd,
    const char* name,
    int file_fd,
    const FileIdentity& identity) {
  struct stat opened {};
  struct stat named {};
  return fstat(file_fd, &opened) == 0
      && IsOwnerRegularFile(opened)
      && MatchesIdentity(opened, identity)
      && fstatat(directory_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0
      && IsOwnerRegularFile(named)
      && MatchesIdentity(named, identity);
}

struct AccountlessRecord {
  std::array<unsigned char, kAccountlessCredentialBytes> bytes {};
  FileIdentity identity {};
};

bool EqualAccountlessCredential(
    const std::array<unsigned char, kAccountlessCredentialBytes>& first,
    const std::array<unsigned char, kAccountlessCredentialBytes>& second) {
  unsigned char difference = 0;
  for (std::size_t index = 0; index < first.size(); ++index) {
    difference |= static_cast<unsigned char>(first[index] ^ second[index]);
  }
  return difference == 0;
}

AccountlessRecordState ReadAccountlessRecordNamed(
    int credential_directory_fd,
    const char* name,
    AccountlessRecord* result) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || name == nullptr
      || result == nullptr) {
    return AccountlessRecordState::kUnavailable;
  }
  result->bytes.fill(0);
  result->identity = FileIdentity {};
  int record_fd = openat(
      credential_directory_fd,
      name,
      // A hostile or corrupted fixed name may be a FIFO. Open it
      // nonblocking before the regular-file check so a credential read never
      // waits for a peer to attach to that FIFO.
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (record_fd < 0) {
    return errno == ENOENT ? AccountlessRecordState::kAbsent
        : AccountlessRecordState::kInvalid;
  }
  bool valid = false;
  FileIdentity identity {};
  do {
    if (!CaptureRegularFileIdentity(record_fd, &identity)
        || !VerifyNamedRegularFileContinuity(
            credential_directory_fd,
            name,
            record_fd,
            identity)) {
      break;
    }
    struct stat metadata {};
    if (fstat(record_fd, &metadata) != 0
        || metadata.st_size != static_cast<off_t>(kAccountlessCredentialBytes)
        || lseek(record_fd, 0, SEEK_SET) < 0
        || !ReadAll(
            record_fd,
            reinterpret_cast<char*>(result->bytes.data()),
            result->bytes.size())
        || !VerifyNamedRegularFileContinuity(
            credential_directory_fd,
            name,
            record_fd,
            identity)) {
      break;
    }
    valid = true;
  } while (false);
  const bool closed = close(record_fd) == 0;
  if (!valid || !closed) {
    result->bytes.fill(0);
    result->identity = FileIdentity {};
    return AccountlessRecordState::kInvalid;
  }
  result->identity = identity;
  return AccountlessRecordState::kPresent;
}

AccountlessRecordState ReadAccountlessRecord(
    int credential_directory_fd,
    AccountlessRecord* result) {
  return ReadAccountlessRecordNamed(
      credential_directory_fd,
      kAccountlessCredentialFile,
      result);
}

bool NamedRecordMatches(
    int credential_directory_fd,
    const char* name,
    const FileIdentity& identity) {
  struct stat named {};
  return VerifyOwnerPrivateDirectory(credential_directory_fd)
      && fstatat(
             credential_directory_fd,
             name,
             &named,
             AT_SYMLINK_NOFOLLOW) == 0
      && IsOwnerRegularFile(named)
      && MatchesIdentity(named, identity);
}

// Return a pinned, newly-created fixed operation residue. The slot-four
// abstract socket serialises normal callers; O_EXCL means a stale or foreign
// residue can never be overwritten or silently adopted.
int CreateTransientRecord(
    int credential_directory_fd,
    const char* name) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd) || name == nullptr) return -1;
  const int fd = openat(
      credential_directory_fd,
      name,
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (fd < 0) return -1;
  if (fchmod(fd, 0600) != 0) {
    close(fd);
    return -2;
  }
  return fd;
}

bool WriteTransientAccountlessRecord(
    int credential_directory_fd,
    const char* name,
    int record_fd,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  FileIdentity identity {};
  return VerifyOwnerPrivateDirectory(credential_directory_fd)
      && CaptureRegularFileIdentity(record_fd, &identity)
      && VerifyNamedRegularFileContinuity(
          credential_directory_fd,
          name,
          record_fd,
          identity)
      && WriteAll(
          record_fd,
          reinterpret_cast<const char*>(value.data()),
          value.size())
      && fsync(record_fd) == 0
      && VerifyNamedRegularFileContinuity(
          credential_directory_fd,
          name,
          record_fd,
          identity);
}

bool RenameNoReplace(
    int directory_fd,
    const char* source,
    const char* destination) {
  if (!VerifyOwnerPrivateDirectory(directory_fd)
      || source == nullptr
      || destination == nullptr) {
    return false;
  }
#if defined(SYS_renameat2)
  return syscall(
             SYS_renameat2,
             directory_fd,
             source,
             directory_fd,
             destination,
             RENAME_NOREPLACE) == 0;
#else
  errno = ENOSYS;
  return false;
#endif
}

enum class AccountlessOperation {
  kCreate = 1,
  kDelete = 2,
  kInvalid,
};

struct AccountlessOperationJournal {
  AccountlessOperation operation = AccountlessOperation::kInvalid;
  std::array<unsigned char, kAccountlessCredentialBytes> value {};
};

enum class AccountlessOperationJournalOpenOutcome {
  kMissing,
  kOpened,
  kInvalid,
};

enum class AccountlessOperationJournalRemoveOutcome {
  kRemoved,
  // unlinkat may have committed even though the following directory fsync
  // failed. The caller must report uncertainty and inspect observed state on a
  // later invocation; it must never recreate an intent record.
  kUncertain,
  kInvalid,
};

enum class AccountlessOperationRecoveryOutcome {
  kRecovered,
  kUnavailable,
  kAmbiguous,
  kUncertain,
};

void ClearAccountlessRecord(AccountlessRecord* record) {
  if (record == nullptr) return;
  record->bytes.fill(0);
  record->identity = FileIdentity {};
}

void ClearAccountlessOperationJournal(AccountlessOperationJournal* journal) {
  if (journal == nullptr) return;
  journal->value.fill(0);
  journal->operation = AccountlessOperation::kInvalid;
}

bool VerifyAccountlessOperationJournalContinuity(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity) {
  struct stat opened {};
  struct stat named {};
  return VerifyOwnerPrivateDirectory(state_fd)
      && fstat(journal_fd, &opened) == 0
      && IsOwnerRegularFile(opened)
      && MatchesIdentity(opened, identity)
      && fstatat(
             state_fd,
             kAccountlessOperationJournalFile,
             &named,
             AT_SYMLINK_NOFOLLOW) == 0
      && IsOwnerRegularFile(named)
      && MatchesIdentity(named, identity);
}

AccountlessOperationJournalOpenOutcome OpenAccountlessOperationJournal(
    int state_fd,
    int* journal_fd,
    FileIdentity* identity) {
  if (journal_fd == nullptr || identity == nullptr || !VerifyOwnerPrivateDirectory(state_fd)) {
    return AccountlessOperationJournalOpenOutcome::kInvalid;
  }
  *journal_fd = -1;
  *identity = FileIdentity {};
  const int fd = openat(
      state_fd,
      kAccountlessOperationJournalFile,
      O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    return errno == ENOENT
        ? AccountlessOperationJournalOpenOutcome::kMissing
        : AccountlessOperationJournalOpenOutcome::kInvalid;
  }
  if (!CaptureRegularFileIdentity(fd, identity)
      || !VerifyAccountlessOperationJournalContinuity(state_fd, fd, *identity)) {
    close(fd);
    *identity = FileIdentity {};
    return AccountlessOperationJournalOpenOutcome::kInvalid;
  }
  *journal_fd = fd;
  return AccountlessOperationJournalOpenOutcome::kOpened;
}

bool ReadAccountlessOperationJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity,
    AccountlessOperationJournal* result) {
  if (result == nullptr) return false;
  ClearAccountlessOperationJournal(result);
  std::array<unsigned char, kAccountlessOperationJournalBytes> bytes {};
  unsigned char trailing = 0;
  bool valid = false;
  do {
    if (!VerifyAccountlessOperationJournalContinuity(state_fd, journal_fd, identity)
        || lseek(journal_fd, 0, SEEK_SET) < 0
        || !ReadAll(
            journal_fd,
            reinterpret_cast<char*>(bytes.data()),
            bytes.size())) {
      break;
    }
    ssize_t trailing_count = 0;
    do {
      trailing_count = read(journal_fd, &trailing, 1);
    } while (trailing_count < 0 && errno == EINTR);
    if (trailing_count != 0
        || std::memcmp(
               bytes.data(),
               kAccountlessOperationJournalMagic.data(),
               kAccountlessOperationJournalMagic.size()) != 0
        || bytes[kAccountlessOperationJournalVersionOffset]
            != kAccountlessOperationJournalVersion
        || (bytes[kAccountlessOperationJournalOperationOffset]
                != static_cast<unsigned char>(AccountlessOperation::kCreate)
            && bytes[kAccountlessOperationJournalOperationOffset]
                != static_cast<unsigned char>(AccountlessOperation::kDelete))) {
      break;
    }
    bool reserved_zero = true;
    for (std::size_t index = kAccountlessOperationJournalReservedStart;
         index < kAccountlessOperationJournalValueOffset;
         ++index) {
      reserved_zero = reserved_zero && bytes[index] == 0;
    }
    if (!reserved_zero
        || !VerifyAccountlessOperationJournalContinuity(state_fd, journal_fd, identity)) {
      break;
    }
    result->operation = static_cast<AccountlessOperation>(
        bytes[kAccountlessOperationJournalOperationOffset]);
    std::memcpy(
        result->value.data(),
        bytes.data() + kAccountlessOperationJournalValueOffset,
        result->value.size());
    valid = true;
  } while (false);
  bytes.fill(0);
  trailing = 0;
  if (!valid) ClearAccountlessOperationJournal(result);
  return valid;
}

bool CreateAccountlessOperationJournal(
    int state_fd,
    AccountlessOperation operation,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value,
    int* journal_fd,
    FileIdentity* identity) {
  if (journal_fd == nullptr
      || identity == nullptr
      || (operation != AccountlessOperation::kCreate
          && operation != AccountlessOperation::kDelete)
      || !VerifyOwnerPrivateDirectory(state_fd)) {
    return false;
  }
  *journal_fd = -1;
  *identity = FileIdentity {};
  const int fd = openat(
      state_fd,
      kAccountlessOperationJournalFile,
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (fd < 0) return false;
  std::array<unsigned char, kAccountlessOperationJournalBytes> bytes {};
  std::memcpy(
      bytes.data(),
      kAccountlessOperationJournalMagic.data(),
      kAccountlessOperationJournalMagic.size());
  bytes[kAccountlessOperationJournalVersionOffset] =
      kAccountlessOperationJournalVersion;
  bytes[kAccountlessOperationJournalOperationOffset] =
      static_cast<unsigned char>(operation);
  std::memcpy(
      bytes.data() + kAccountlessOperationJournalValueOffset,
      value.data(),
      value.size());
  const bool written = CaptureRegularFileIdentity(fd, identity)
      && VerifyAccountlessOperationJournalContinuity(state_fd, fd, *identity)
      && WriteAll(
          fd,
          reinterpret_cast<const char*>(bytes.data()),
          bytes.size())
      && fsync(fd) == 0
      && VerifyAccountlessOperationJournalContinuity(state_fd, fd, *identity)
      && fsync(state_fd) == 0
      && VerifyAccountlessOperationJournalContinuity(state_fd, fd, *identity);
  bytes.fill(0);
  if (!written) {
    close(fd);
    *identity = FileIdentity {};
    return false;
  }
  *journal_fd = fd;
  return true;
}

AccountlessOperationJournalRemoveOutcome RemoveAccountlessOperationJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity) {
  if (!VerifyAccountlessOperationJournalContinuity(state_fd, journal_fd, identity)
      || unlinkat(state_fd, kAccountlessOperationJournalFile, 0) != 0) {
    return AccountlessOperationJournalRemoveOutcome::kInvalid;
  }
  return fsync(state_fd) == 0
      ? AccountlessOperationJournalRemoveOutcome::kRemoved
      : AccountlessOperationJournalRemoveOutcome::kUncertain;
}

bool IsFixedAccountlessResidueAbsent(int credential_directory_fd, const char* name) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd) || name == nullptr) return false;
  struct stat metadata {};
  return fstatat(
             credential_directory_fd,
             name,
             &metadata,
             AT_SYMLINK_NOFOLLOW) != 0
      && errno == ENOENT;
}

bool NoFixedAccountlessOperationResidue(int credential_directory_fd) {
  return IsFixedAccountlessResidueAbsent(
             credential_directory_fd,
             kAccountlessCreateTemporaryFile)
      && IsFixedAccountlessResidueAbsent(
             credential_directory_fd,
             kAccountlessDeleteTemporaryFile);
}

const char* AccountlessOperationTemporaryFile(AccountlessOperation operation) {
  return operation == AccountlessOperation::kCreate
      ? kAccountlessCreateTemporaryFile
      : operation == AccountlessOperation::kDelete
          ? kAccountlessDeleteTemporaryFile
          : nullptr;
}

bool IsOtherFixedAccountlessResidueAbsent(
    int credential_directory_fd,
    const char* temporary_name) {
  const char* other = temporary_name == kAccountlessCreateTemporaryFile
      ? kAccountlessDeleteTemporaryFile
      : temporary_name == kAccountlessDeleteTemporaryFile
          ? kAccountlessCreateTemporaryFile
          : nullptr;
  return other != nullptr
      && IsFixedAccountlessResidueAbsent(credential_directory_fd, other);
}

bool PublishNewAccountlessRecord(
    int credential_directory_fd,
    const char* temporary_name,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)) {
    return false;
  }
  AccountlessRecord final_before {};
  const AccountlessRecordState final_before_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_before);
  ClearAccountlessRecord(&final_before);
  if (final_before_state != AccountlessRecordState::kAbsent) return false;

  int temporary_fd = CreateTransientRecord(credential_directory_fd, temporary_name);
  if (temporary_fd < 0) return false;
  const bool written = WriteTransientAccountlessRecord(
      credential_directory_fd,
      temporary_name,
      temporary_fd,
      value);
  const bool temporary_closed = CloseDescriptor(&temporary_fd);
  if (!written || !temporary_closed) return false;

  AccountlessRecord temporary {};
  const AccountlessRecordState temporary_state = ReadAccountlessRecordNamed(
      credential_directory_fd,
      temporary_name,
      &temporary);
  const FileIdentity temporary_identity = temporary.identity;
  const bool temporary_exact = temporary_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(temporary.bytes, value)
      && NamedRecordMatches(
          credential_directory_fd,
          temporary_name,
          temporary_identity);
  ClearAccountlessRecord(&temporary);
  if (!temporary_exact
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)
      || !RenameNoReplace(
          credential_directory_fd,
          temporary_name,
          kAccountlessCredentialFile)
      || fsync(credential_directory_fd) != 0) {
    return false;
  }

  AccountlessRecord final_after {};
  const AccountlessRecordState final_after_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_after);
  const bool exact = final_after_state == AccountlessRecordState::kPresent
      && SameFileIdentity(final_after.identity, temporary_identity)
      && EqualAccountlessCredential(final_after.bytes, value)
      && IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name);
  ClearAccountlessRecord(&final_after);
  return exact;
}

bool PublishExistingAccountlessRecord(
    int credential_directory_fd,
    const char* temporary_name,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)) {
    return false;
  }
  AccountlessRecord final_before {};
  const AccountlessRecordState final_before_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_before);
  ClearAccountlessRecord(&final_before);
  if (final_before_state != AccountlessRecordState::kAbsent) return false;

  AccountlessRecord temporary {};
  const AccountlessRecordState temporary_state = ReadAccountlessRecordNamed(
      credential_directory_fd,
      temporary_name,
      &temporary);
  const FileIdentity temporary_identity = temporary.identity;
  const bool temporary_exact = temporary_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(temporary.bytes, value)
      && NamedRecordMatches(
          credential_directory_fd,
          temporary_name,
          temporary_identity);
  ClearAccountlessRecord(&temporary);
  if (!temporary_exact
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)
      || !RenameNoReplace(
          credential_directory_fd,
          temporary_name,
          kAccountlessCredentialFile)
      || fsync(credential_directory_fd) != 0) {
    return false;
  }

  AccountlessRecord final_after {};
  const AccountlessRecordState final_after_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_after);
  const bool exact = final_after_state == AccountlessRecordState::kPresent
      && SameFileIdentity(final_after.identity, temporary_identity)
      && EqualAccountlessCredential(final_after.bytes, value)
      && IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name);
  ClearAccountlessRecord(&final_after);
  return exact;
}

bool DeleteCurrentAccountlessRecord(
    int credential_directory_fd,
    const char* temporary_name,
    const std::array<unsigned char, kAccountlessCredentialBytes>& expected) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)) {
    return false;
  }
  AccountlessRecord current {};
  const AccountlessRecordState current_state = ReadAccountlessRecord(
      credential_directory_fd,
      &current);
  const FileIdentity current_identity = current.identity;
  const bool exact_current = current_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(current.bytes, expected)
      && NamedRecordMatches(
          credential_directory_fd,
          kAccountlessCredentialFile,
          current_identity);
  ClearAccountlessRecord(&current);
  if (!exact_current
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)
      || !RenameNoReplace(
          credential_directory_fd,
          kAccountlessCredentialFile,
          temporary_name)
      || fsync(credential_directory_fd) != 0) {
    return false;
  }

  AccountlessRecord temporary {};
  const AccountlessRecordState temporary_state = ReadAccountlessRecordNamed(
      credential_directory_fd,
      temporary_name,
      &temporary);
  const bool exact_temporary = temporary_state == AccountlessRecordState::kPresent
      && SameFileIdentity(temporary.identity, current_identity)
      && EqualAccountlessCredential(temporary.bytes, expected)
      && NamedRecordMatches(
          credential_directory_fd,
          temporary_name,
          temporary.identity);
  ClearAccountlessRecord(&temporary);
  if (!exact_temporary
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)
      || unlinkat(credential_directory_fd, temporary_name, 0) != 0
      || fsync(credential_directory_fd) != 0) {
    return false;
  }
  AccountlessRecord final_after {};
  const AccountlessRecordState final_after_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_after);
  ClearAccountlessRecord(&final_after);
  return final_after_state == AccountlessRecordState::kAbsent
      && IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name);
}

bool DeleteExistingAccountlessRecord(
    int credential_directory_fd,
    const char* temporary_name,
    const std::array<unsigned char, kAccountlessCredentialBytes>& expected) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)) {
    return false;
  }
  AccountlessRecord final_before {};
  const AccountlessRecordState final_before_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_before);
  ClearAccountlessRecord(&final_before);
  if (final_before_state != AccountlessRecordState::kAbsent) return false;

  AccountlessRecord temporary {};
  const AccountlessRecordState temporary_state = ReadAccountlessRecordNamed(
      credential_directory_fd,
      temporary_name,
      &temporary);
  const bool exact_temporary = temporary_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(temporary.bytes, expected)
      && NamedRecordMatches(
          credential_directory_fd,
          temporary_name,
          temporary.identity);
  ClearAccountlessRecord(&temporary);
  if (!exact_temporary
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)
      || unlinkat(credential_directory_fd, temporary_name, 0) != 0
      || fsync(credential_directory_fd) != 0) {
    return false;
  }
  AccountlessRecord final_after {};
  const AccountlessRecordState final_after_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_after);
  ClearAccountlessRecord(&final_after);
  return final_after_state == AccountlessRecordState::kAbsent
      && IsFixedAccountlessResidueAbsent(credential_directory_fd, temporary_name);
}

bool AccountlessOperationPostconditionHolds(
    int credential_directory_fd,
    AccountlessOperation operation,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  if (!VerifyOwnerPrivateDirectory(credential_directory_fd)
      || (operation != AccountlessOperation::kCreate
          && operation != AccountlessOperation::kDelete)) {
    return false;
  }
  AccountlessRecord final_record {};
  const AccountlessRecordState final_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_record);
  const bool exact_create = final_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(final_record.bytes, value);
  ClearAccountlessRecord(&final_record);
  return (operation == AccountlessOperation::kCreate
          ? exact_create
          : final_state == AccountlessRecordState::kAbsent)
      && NoFixedAccountlessOperationResidue(credential_directory_fd);
}

// A prior operation can leave an exact-looking postcondition after its record
// directory fsync failed. It is not safe to clear its intent based only on a
// later observation: bind settlement to a successful fsync and two independent
// descriptor/path revalidations of the exact final state.
bool VerifyDurableAccountlessOperationPostcondition(
    int credential_directory_fd,
    AccountlessOperation operation,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  return AccountlessOperationPostconditionHolds(
             credential_directory_fd,
             operation,
             value)
      && fsync(credential_directory_fd) == 0
      && AccountlessOperationPostconditionHolds(
          credential_directory_fd,
          operation,
          value);
}

AccountlessOperationRecoveryOutcome RecoverAccountlessOperationJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& journal_identity,
    int credential_directory_fd) {
  if (!VerifyOwnerPrivateDirectory(state_fd)
      || !VerifyOwnerPrivateDirectory(credential_directory_fd)) {
    return AccountlessOperationRecoveryOutcome::kUnavailable;
  }
  AccountlessOperationJournal journal {};
  if (!ReadAccountlessOperationJournal(
          state_fd,
          journal_fd,
          journal_identity,
          &journal)) {
    return AccountlessOperationRecoveryOutcome::kAmbiguous;
  }
  const char* temporary_name = AccountlessOperationTemporaryFile(journal.operation);
  if (temporary_name == nullptr
      || !IsOtherFixedAccountlessResidueAbsent(
          credential_directory_fd,
          temporary_name)) {
    ClearAccountlessOperationJournal(&journal);
    return AccountlessOperationRecoveryOutcome::kAmbiguous;
  }
  AccountlessRecord final_record {};
  AccountlessRecord temporary_record {};
  const AccountlessRecordState final_state = ReadAccountlessRecord(
      credential_directory_fd,
      &final_record);
  const AccountlessRecordState temporary_state = ReadAccountlessRecordNamed(
      credential_directory_fd,
      temporary_name,
      &temporary_record);
  const bool final_exact = final_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(final_record.bytes, journal.value);
  const bool temporary_exact = temporary_state == AccountlessRecordState::kPresent
      && EqualAccountlessCredential(temporary_record.bytes, journal.value);
  bool reconciled = false;
  if (journal.operation == AccountlessOperation::kCreate) {
    if (final_exact && temporary_state == AccountlessRecordState::kAbsent) {
      reconciled = true;
    } else if (final_state == AccountlessRecordState::kAbsent && temporary_exact) {
      reconciled = PublishExistingAccountlessRecord(
          credential_directory_fd,
          temporary_name,
          journal.value);
    } else if (final_state == AccountlessRecordState::kAbsent
        && temporary_state == AccountlessRecordState::kAbsent) {
      reconciled = PublishNewAccountlessRecord(
          credential_directory_fd,
          temporary_name,
          journal.value);
    }
  } else if (journal.operation == AccountlessOperation::kDelete) {
    if (final_state == AccountlessRecordState::kAbsent
        && temporary_state == AccountlessRecordState::kAbsent) {
      reconciled = true;
    } else if (final_exact && temporary_state == AccountlessRecordState::kAbsent) {
      reconciled = DeleteCurrentAccountlessRecord(
          credential_directory_fd,
          temporary_name,
          journal.value);
    } else if (final_state == AccountlessRecordState::kAbsent && temporary_exact) {
      reconciled = DeleteExistingAccountlessRecord(
          credential_directory_fd,
          temporary_name,
          journal.value);
    }
  }
  ClearAccountlessRecord(&final_record);
  ClearAccountlessRecord(&temporary_record);
  if (!reconciled
      || !VerifyDurableAccountlessOperationPostcondition(
          credential_directory_fd,
          journal.operation,
          journal.value)) {
    ClearAccountlessOperationJournal(&journal);
    return AccountlessOperationRecoveryOutcome::kAmbiguous;
  }
  ClearAccountlessOperationJournal(&journal);
  const AccountlessOperationJournalRemoveOutcome removal =
      RemoveAccountlessOperationJournal(state_fd, journal_fd, journal_identity);
  return removal == AccountlessOperationJournalRemoveOutcome::kRemoved
      ? AccountlessOperationRecoveryOutcome::kRecovered
      : removal == AccountlessOperationJournalRemoveOutcome::kUncertain
          ? AccountlessOperationRecoveryOutcome::kUncertain
          : AccountlessOperationRecoveryOutcome::kAmbiguous;
}

enum class AccountlessLeaseOutcome {
  kAcquired,
  kUnavailable,
  kRecoveryRequired,
};

bool LatchUnissuedAccountlessRecovery(
    int state_fd,
    int journal_fd,
    const FileIdentity& journal_identity) {
  return WriteJournalState(
      state_fd,
      journal_fd,
      kAccountlessInstallationCredentialSlot,
      journal_identity,
      JournalState::kActive);
}

AccountlessLeaseOutcome AcquireAccountlessLease(NativeLease** result) {
  if (result == nullptr) return AccountlessLeaseOutcome::kUnavailable;
  *result = nullptr;
  int socket_fd = -1;
  bool contended = false;
  if (!AcquireKernelLeaseSocket(
          kAccountlessInstallationCredentialSlot,
          &socket_fd,
          &contended)) {
    return AccountlessLeaseOutcome::kUnavailable;
  }
  int persistent_state_fd = OpenPersistentStateDirectory();
  if (persistent_state_fd < 0) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, nullptr);
    return AccountlessLeaseOutcome::kUnavailable;
  }
  int journal_fd = -1;
  FileIdentity journal_identity {};
  const JournalOpenOutcome journal = OpenJournal(
      persistent_state_fd,
      kAccountlessInstallationCredentialSlot,
      &journal_fd,
      &journal_identity);
  if (journal == JournalOpenOutcome::kFailure) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountlessLeaseOutcome::kRecoveryRequired;
  }
  // Normalise a fresh journal before any later allocation or preflight can
  // fail. That keeps known pre-mutation failures retryable instead of leaving
  // a zero-length fresh journal that a later caller would treat as recovery.
  const bool initialized = journal != JournalOpenOutcome::kCreated
      || WriteJournalState(
          persistent_state_fd,
          journal_fd,
          kAccountlessInstallationCredentialSlot,
          journal_identity,
          JournalState::kNormal);
  const JournalState prior = journal == JournalOpenOutcome::kCreated
      ? JournalState::kNormal
      : ReadJournalState(journal_fd);
  if (!initialized) {
    const bool removed = RemoveFreshAccountlessJournal(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return removed
        ? AccountlessLeaseOutcome::kUnavailable
        : AccountlessLeaseOutcome::kRecoveryRequired;
  }
  if (prior != JournalState::kNormal) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountlessLeaseOutcome::kRecoveryRequired;
  }

  int operation_journal_fd = -1;
  FileIdentity operation_journal_identity {};
  const AccountlessOperationJournalOpenOutcome operation_journal =
      OpenAccountlessOperationJournal(
          persistent_state_fd,
          &operation_journal_fd,
          &operation_journal_identity);
  if (operation_journal == AccountlessOperationJournalOpenOutcome::kInvalid) {
    LatchUnissuedAccountlessRecovery(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountlessLeaseOutcome::kRecoveryRequired;
  }

  int credential_directory_fd = OpenAccountlessCredentialDirectory();
  if (credential_directory_fd < 0) {
    CloseDescriptor(&operation_journal_fd);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return operation_journal == AccountlessOperationJournalOpenOutcome::kMissing
        ? AccountlessLeaseOutcome::kUnavailable
        : AccountlessLeaseOutcome::kRecoveryRequired;
  }

  if (operation_journal == AccountlessOperationJournalOpenOutcome::kMissing) {
    const bool clean = NoFixedAccountlessOperationResidue(credential_directory_fd);
    const bool credential_directory_closed = CloseDescriptor(&credential_directory_fd);
    if (!clean || !credential_directory_closed) {
      LatchUnissuedAccountlessRecovery(
          persistent_state_fd,
          journal_fd,
          journal_identity);
      CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
      return AccountlessLeaseOutcome::kRecoveryRequired;
    }
  } else {
    // A v2 intent can only have been written after this v1 marker was durably
    // normal. A newly-created v1 marker beside one is therefore an unbound
    // replacement state, never an intent we may adopt.
    const AccountlessOperationRecoveryOutcome recovery = journal
            == JournalOpenOutcome::kCreated
        ? AccountlessOperationRecoveryOutcome::kAmbiguous
        : RecoverAccountlessOperationJournal(
            persistent_state_fd,
            operation_journal_fd,
            operation_journal_identity,
            credential_directory_fd);
    const bool credential_directory_closed = CloseDescriptor(&credential_directory_fd);
    const bool operation_journal_closed = CloseDescriptor(&operation_journal_fd);
    if (recovery != AccountlessOperationRecoveryOutcome::kRecovered
        || !credential_directory_closed
        || !operation_journal_closed) {
      // If unlink or close becomes uncertain, the v2 name may no longer be a
      // durable fence. Preserve the existing v1 active refusal before the
      // socket is released; never recreate a journal from observed state.
      LatchUnissuedAccountlessRecovery(
          persistent_state_fd,
          journal_fd,
          journal_identity);
      CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
      return AccountlessLeaseOutcome::kRecoveryRequired;
    }
  }

  const bool journal_still_normal = VerifyJournalContinuity(
          persistent_state_fd,
          journal_fd,
          kAccountlessInstallationCredentialSlot,
          journal_identity)
      && ReadJournalState(journal_fd) == JournalState::kNormal
      && VerifyJournalContinuity(
          persistent_state_fd,
          journal_fd,
          kAccountlessInstallationCredentialSlot,
          journal_identity);
  if (!journal_still_normal) {
    LatchUnissuedAccountlessRecovery(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountlessLeaseOutcome::kRecoveryRequired;
  }

  auto* lease = new (std::nothrow) NativeLease {};
  if (lease == nullptr) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountlessLeaseOutcome::kUnavailable;
  }
  lease->socket_fd = socket_fd;
  lease->persistent_state_fd = persistent_state_fd;
  lease->journal_fd = journal_fd;
  lease->journal_identity = journal_identity;
  lease->capability_id = kAccountlessInstallationCredentialSlot;
  socket_fd = -1;
  persistent_state_fd = -1;
  journal_fd = -1;
  *result = lease;
  return AccountlessLeaseOutcome::kAcquired;
}

bool BeginAccountlessMutation(
    NativeLease* lease,
    AccountlessOperation operation,
    const std::array<unsigned char, kAccountlessCredentialBytes>& value) {
  if (lease == nullptr
      || lease->capability_id != kAccountlessInstallationCredentialSlot
      || !lease->active
      || lease->accountless_active_marker_written
      || lease->accountless_operation_journal_written
      || lease->accountless_operation_journal_fd >= 0) {
    return false;
  }
  int operation_journal_fd = -1;
  FileIdentity operation_journal_identity {};
  if (!CreateAccountlessOperationJournal(
          lease->persistent_state_fd,
          operation,
          value,
          &operation_journal_fd,
          &operation_journal_identity)) {
    return false;
  }
  lease->accountless_operation_journal_fd = operation_journal_fd;
  lease->accountless_operation_journal_identity = operation_journal_identity;
  lease->accountless_operation_journal_written = true;
  return true;
}

AccountlessOperationJournalRemoveOutcome SettleAccountlessMutation(
    NativeLease* lease) {
  if (lease == nullptr
      || lease->capability_id != kAccountlessInstallationCredentialSlot
      || !lease->active
      || !lease->accountless_operation_journal_written
      || lease->accountless_operation_journal_fd < 0) {
    return AccountlessOperationJournalRemoveOutcome::kInvalid;
  }
  const AccountlessOperationJournalRemoveOutcome removal =
      RemoveAccountlessOperationJournal(
          lease->persistent_state_fd,
          lease->accountless_operation_journal_fd,
          lease->accountless_operation_journal_identity);
  const bool closed = CloseDescriptor(&lease->accountless_operation_journal_fd);
  if (removal == AccountlessOperationJournalRemoveOutcome::kRemoved && closed) {
    lease->accountless_operation_journal_identity = FileIdentity {};
    lease->accountless_operation_journal_written = false;
    return AccountlessOperationJournalRemoveOutcome::kRemoved;
  }
  return removal == AccountlessOperationJournalRemoveOutcome::kRemoved
      ? AccountlessOperationJournalRemoveOutcome::kUncertain
      : removal;
}

// A malformed or unsafe fixed record is not a retryable pre-mutation error:
// even though no syscall changed that record in this call, removal of it later
// must not permit silent identity minting. Latch the same private journal
// before releasing the socket. If a prior mutation already wrote `active`,
// verify that exact pinned journal rather than attempting to overwrite it.
bool LatchAccountlessRecovery(NativeLease* lease) {
  if (lease == nullptr
      || lease->capability_id != kAccountlessInstallationCredentialSlot
      || !lease->active) {
    return false;
  }
  if (lease->accountless_active_marker_written) {
    return VerifyJournalContinuity(
        lease->persistent_state_fd,
        lease->journal_fd,
        lease->capability_id,
        lease->journal_identity);
  }
  if (!WriteJournalState(
          lease->persistent_state_fd,
          lease->journal_fd,
          lease->capability_id,
          lease->journal_identity,
          JournalState::kActive)) {
    return false;
  }
  lease->accountless_active_marker_written = true;
  return true;
}

bool FinishAccountlessLease(NativeLease* lease, bool preserve_active) {
  if (lease == nullptr) return false;
  // A read, an existing-record result, or a known pre-mutation failure has
  // only observed an already-normal private journal. Rewriting that normal
  // record would add an unnecessary ftruncate/fsync crash window. Verify the
  // pinned normal state and close it instead. A marker written for a mutation
  // or recovery latch still uses the ordinary active->normal/preserve path.
  const bool operation_journal_retained = !lease->accountless_operation_journal_written
      || (lease->accountless_operation_journal_fd >= 0
          && VerifyAccountlessOperationJournalContinuity(
              lease->persistent_state_fd,
              lease->accountless_operation_journal_fd,
              lease->accountless_operation_journal_identity));
  const bool operation_journal_closed = CloseDescriptor(
      &lease->accountless_operation_journal_fd);
  bool finished = false;
  if (!preserve_active && !lease->accountless_active_marker_written) {
    const bool journal_normal = VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            lease->capability_id,
            lease->journal_identity)
        && ReadJournalState(lease->journal_fd) == JournalState::kNormal
        && VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            lease->capability_id,
            lease->journal_identity);
    const bool journal_closed = CloseDescriptor(&lease->journal_fd);
    const bool state_closed = CloseDescriptor(&lease->persistent_state_fd);
    const bool socket_closed = CloseDescriptor(&lease->socket_fd);
    finished = journal_normal && journal_closed && state_closed && socket_closed;
  } else {
    finished = FinishLease(lease, preserve_active);
  }
  lease->active = false;
  delete lease;
  return operation_journal_retained && operation_journal_closed && finished;
}

bool CloseDescriptor(int* fd) {
  if (fd == nullptr || *fd < 0) return true;
  const int current = *fd;
  *fd = -1;
  return close(current) == 0;
}

void CloseUnissuedLeaseDescriptors(
    int* socket_fd,
    int* persistent_state_fd,
    int* journal_fd) {
  CloseDescriptor(journal_fd);
  CloseDescriptor(persistent_state_fd);
  CloseDescriptor(socket_fd);
}

bool FinishLease(NativeLease* lease, bool preserve_active) {
  if (lease == nullptr) return false;
  const bool journal_settled = preserve_active
      ? VerifyJournalContinuity(
          lease->persistent_state_fd,
          lease->journal_fd,
          lease->capability_id,
          lease->journal_identity)
      : WriteJournalState(
          lease->persistent_state_fd,
          lease->journal_fd,
          lease->capability_id,
          lease->journal_identity,
          JournalState::kNormal);
  const bool journal_closed = CloseDescriptor(&lease->journal_fd);
  const bool state_closed = CloseDescriptor(&lease->persistent_state_fd);
  const bool socket_closed = CloseDescriptor(&lease->socket_fd);
  return journal_settled && journal_closed && state_closed && socket_closed;
}

// FD4 has no generic Linux mutation surface. These helpers implement the one
// fixed account-observation root as a native-private no-replace operation.
// The journal carries a digest only: unlike FD3's owner-private filesystem
// record, persisting an FD4 candidate outside Secret Service would weaken the
// credential's intended protection boundary.
enum class AccountObservationRecordState {
  kAbsent,
  kPresent,
  kInvalid,
  kUnavailable,
};

enum class AccountObservationCollectionOpenOutcome {
  kReady,
  kPreCancelled,
  kErrorGioCancelled,
  kErrorGioTimedOut,
  kErrorGioNotFound,
  kErrorGioPermissionDenied,
  kErrorGioInvalidArgument,
  kErrorGioNotInitialized,
  kErrorGioNotSupported,
  kErrorGioClosed,
  kErrorGioDbus,
  kErrorGioOther,
  kErrorDbusServiceUnknown,
  kErrorDbusNoOwner,
  kErrorDbusNoReply,
  kErrorDbusAccessDenied,
  kErrorDbusAuthFailed,
  kErrorDbusTimeout,
  kErrorDbusDisconnected,
  kErrorDbusInvalidArgument,
  kErrorDbusNotSupported,
  kErrorDbusNotFound,
  kErrorDbusOther,
  kErrorOther,
  kNull,
  kLocked,
  kPostCancelled,
};

struct AccountObservationRecord {
  std::array<unsigned char, kAccountObservationCredentialBytes> bytes {};
};

struct AccountObservationOperationJournal {
  std::array<unsigned char, kAccountObservationCredentialBytes> digest {};
};

enum class AccountObservationOperationJournalOpenOutcome {
  kMissing,
  kOpened,
  kInvalid,
};

enum class AccountObservationOperationJournalRemoveOutcome {
  kRemoved,
  // unlinkat may have committed before the directory fsync fails. The caller
  // must retain the legacy active refusal and never recreate a digest intent.
  kUncertain,
  kInvalid,
};

void ClearAccountObservationRecord(AccountObservationRecord* record) {
  if (record == nullptr) return;
  record->bytes.fill(0);
}

void ClearAccountObservationOperationJournal(
    AccountObservationOperationJournal* journal) {
  if (journal == nullptr) return;
  journal->digest.fill(0);
}

// The fixed observation route has one aggregate cancellation budget per N-API
// worker. A single guard covers lookup, collection resolution, create, and
// reconciliation; nested calls must never extend that budget.
class AccountObservationDeadlineGuard {
 public:
  AccountObservationDeadlineGuard() {
    g_mutex_init(&mutex_);
    g_cond_init(&condition_);
  }
  AccountObservationDeadlineGuard(const AccountObservationDeadlineGuard&) = delete;
  AccountObservationDeadlineGuard& operator=(const AccountObservationDeadlineGuard&) = delete;

  ~AccountObservationDeadlineGuard() {
    Finish();
    g_cond_clear(&condition_);
    g_mutex_clear(&mutex_);
  }

  bool Start() {
    g_mutex_lock(&mutex_);
    if (finished_ || cancellable_ != nullptr || watchdog_ != nullptr) {
      g_mutex_unlock(&mutex_);
      return false;
    }
    cancellable_ = g_cancellable_new();
    if (cancellable_ == nullptr) {
      g_mutex_unlock(&mutex_);
      return false;
    }
    expires_at_ = g_get_monotonic_time()
        + static_cast<gint64>(kAccountObservationOperationDeadline.count())
            * G_TIME_SPAN_MILLISECOND;
    GError* error = nullptr;
    GThread* watchdog = g_thread_try_new(
        "tibotattle-observation-deadline",
        &AccountObservationDeadlineGuard::Watch,
        this,
        &error);
    if (error != nullptr) g_error_free(error);
    if (watchdog == nullptr) {
      g_object_unref(cancellable_);
      cancellable_ = nullptr;
      g_mutex_unlock(&mutex_);
      return false;
    }
    watchdog_ = watchdog;
    g_mutex_unlock(&mutex_);
    return true;
  }

  GCancellable* cancellable() const {
    g_mutex_lock(&mutex_);
    GCancellable* current = cancellable_;
    g_mutex_unlock(&mutex_);
    return current;
  }

  // Stop the aggregate deadline before a caller commits an otherwise-normal
  // local settlement. The deadline was fixed before watchdog scheduling; check
  // it on both sides of the join while the lease can still be latched as
  // recovery-required.
  bool StopDeadline() noexcept {
    GCancellable* cancellation = nullptr;
    g_mutex_lock(&mutex_);
    const bool expired_before_join = DeadlineElapsedLocked();
    if (!finished_) {
      finished_ = true;
      g_cond_broadcast(&condition_);
    }
    GThread* watchdog = watchdog_;
    watchdog_ = nullptr;
    if (expired_before_join && cancellable_ != nullptr
        && !g_cancellable_is_cancelled(cancellable_)) {
      cancellation = cancellable_;
    }
    g_mutex_unlock(&mutex_);
    if (cancellation != nullptr) g_cancellable_cancel(cancellation);
    if (watchdog != nullptr) g_thread_join(watchdog);
    g_mutex_lock(&mutex_);
    const bool expired_after_join = DeadlineElapsedLocked();
    if (expired_after_join && cancellable_ != nullptr
        && !g_cancellable_is_cancelled(cancellable_)) {
      cancellation = cancellable_;
    } else {
      cancellation = nullptr;
    }
    const bool cancelled = cancellable_ == nullptr
        || g_cancellable_is_cancelled(cancellable_)
        || expired_after_join;
    g_mutex_unlock(&mutex_);
    if (cancellation != nullptr) g_cancellable_cancel(cancellation);
    return cancelled;
  }

  void Finish() noexcept {
    StopDeadline();
    GCancellable* current = nullptr;
    g_mutex_lock(&mutex_);
    current = cancellable_;
    cancellable_ = nullptr;
    g_mutex_unlock(&mutex_);
    if (current != nullptr) g_object_unref(current);
  }

 private:
  bool DeadlineElapsedLocked() const {
    return cancellable_ != nullptr
        && expires_at_ > 0
        && g_get_monotonic_time() >= expires_at_;
  }

  static gpointer Watch(gpointer data) {
    auto* deadline = static_cast<AccountObservationDeadlineGuard*>(data);
    if (deadline == nullptr) return nullptr;
    bool timed_out = false;
    g_mutex_lock(&deadline->mutex_);
    while (!deadline->finished_) {
      if (!g_cond_wait_until(
              &deadline->condition_,
              &deadline->mutex_,
              deadline->expires_at_)) {
        timed_out = !deadline->finished_;
        break;
      }
    }
    GCancellable* current = timed_out ? deadline->cancellable_ : nullptr;
    g_mutex_unlock(&deadline->mutex_);
    if (current != nullptr) g_cancellable_cancel(current);
    return nullptr;
  }

  mutable GMutex mutex_;
  GCond condition_;
  GCancellable* cancellable_ = nullptr;
  GThread* watchdog_ = nullptr;
  gint64 expires_at_ = 0;
  bool finished_ = false;
};

bool AccountObservationDeadlineCancelled(GCancellable* cancellable) {
  return cancellable == nullptr || g_cancellable_is_cancelled(cancellable);
}

bool EqualAccountObservationCredential(
    const std::array<unsigned char, kAccountObservationCredentialBytes>& first,
    const std::array<unsigned char, kAccountObservationCredentialBytes>& second) {
  unsigned char difference = 0;
  for (std::size_t index = 0; index < first.size(); ++index) {
    difference |= static_cast<unsigned char>(first[index] ^ second[index]);
  }
  return difference == 0;
}

bool DigestAccountObservationCredential(
    const std::array<unsigned char, kAccountObservationCredentialBytes>& value,
    std::array<unsigned char, kAccountObservationCredentialBytes>* digest) {
  if (digest == nullptr) return false;
  digest->fill(0);
  GChecksum* checksum = g_checksum_new(G_CHECKSUM_SHA256);
  if (checksum == nullptr) return false;
  g_checksum_update(checksum, value.data(), value.size());
  gsize length = digest->size();
  g_checksum_get_digest(checksum, digest->data(), &length);
  g_checksum_free(checksum);
  if (length != digest->size()) {
    digest->fill(0);
    return false;
  }
  return true;
}

int Base64UrlValue(char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '-') return 62;
  if (value == '_') return 63;
  return -1;
}

std::array<char, 44> EncodeAccountObservationCredential(
    const std::array<unsigned char, kAccountObservationCredentialBytes>& value) {
  constexpr char kBase64Url[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::array<char, 44> output {};
  std::size_t input = 0;
  std::size_t written = 0;
  while (input + 3 <= value.size()) {
    const unsigned int combined = (static_cast<unsigned int>(value[input]) << 16)
        | (static_cast<unsigned int>(value[input + 1]) << 8)
        | static_cast<unsigned int>(value[input + 2]);
    output[written++] = kBase64Url[(combined >> 18) & 0x3f];
    output[written++] = kBase64Url[(combined >> 12) & 0x3f];
    output[written++] = kBase64Url[(combined >> 6) & 0x3f];
    output[written++] = kBase64Url[combined & 0x3f];
    input += 3;
  }
  if (input + 2 == value.size()) {
    const unsigned int combined = (static_cast<unsigned int>(value[input]) << 16)
        | (static_cast<unsigned int>(value[input + 1]) << 8);
    output[written++] = kBase64Url[(combined >> 18) & 0x3f];
    output[written++] = kBase64Url[(combined >> 12) & 0x3f];
    output[written++] = kBase64Url[(combined >> 6) & 0x3f];
  }
  if (written != output.size() - 1) output.fill(0);
  return output;
}

bool DecodeAccountObservationCredential(
    const char* text,
    std::array<unsigned char, kAccountObservationCredentialBytes>* value) {
  if (text == nullptr || value == nullptr) return false;
  value->fill(0);
  constexpr std::size_t kEncodedBytes = 43;
  if (strnlen(text, kEncodedBytes + 1) != kEncodedBytes) return false;
  std::uint32_t accumulator = 0;
  int bits = 0;
  std::size_t output = 0;
  for (std::size_t index = 0; index < kEncodedBytes; ++index) {
    const int decoded = Base64UrlValue(text[index]);
    if (decoded < 0) {
      value->fill(0);
      return false;
    }
    accumulator = (accumulator << 6) | static_cast<std::uint32_t>(decoded);
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      if (output >= value->size()) {
        value->fill(0);
        return false;
      }
      (*value)[output++] = static_cast<unsigned char>((accumulator >> bits) & 0xff);
    }
  }
  if (output != value->size() || bits != 2 || (accumulator & 0x3u) != 0) {
    value->fill(0);
    return false;
  }
  std::array<char, 44> canonical = EncodeAccountObservationCredential(*value);
  const bool valid = std::memcmp(text, canonical.data(), kEncodedBytes) == 0;
  canonical.fill(0);
  if (!valid) value->fill(0);
  return valid;
}

void FreeAccountObservationItems(GList* items) {
  for (GList* current = items; current != nullptr; current = current->next) {
    if (current->data != nullptr) g_object_unref(current->data);
  }
  g_list_free(items);
}

AccountObservationRecordState ReadAccountObservationCredential(
    AccountObservationRecord* result,
    GCancellable* cancellable) {
  if (result == nullptr || AccountObservationDeadlineCancelled(cancellable)) {
    return AccountObservationRecordState::kUnavailable;
  }
  ClearAccountObservationRecord(result);
  GHashTable* attributes = g_hash_table_new(g_str_hash, g_str_equal);
  if (attributes == nullptr) return AccountObservationRecordState::kUnavailable;
  g_hash_table_insert(
      attributes,
      const_cast<char*>("service"),
      const_cast<char*>(kAccountObservationService));
  g_hash_table_insert(
      attributes,
      const_cast<char*>("account"),
      const_cast<char*>(kAccountObservationAccount));
  GError* error = nullptr;
  GList* items = secret_service_search_sync(
      nullptr,
      &kAccountObservationSecretSchema,
      attributes,
      static_cast<SecretSearchFlags>(
          SECRET_SEARCH_ALL | SECRET_SEARCH_LOAD_SECRETS),
      cancellable,
      &error);
  g_hash_table_destroy(attributes);
  if (error != nullptr) {
    g_error_free(error);
    FreeAccountObservationItems(items);
    return AccountObservationRecordState::kUnavailable;
  }
  if (items == nullptr) return AccountObservationRecordState::kAbsent;
  if (items->next != nullptr || items->data == nullptr) {
    FreeAccountObservationItems(items);
    return AccountObservationRecordState::kInvalid;
  }
  auto* item = static_cast<SecretItem*>(items->data);
  if (secret_item_get_locked(item)) {
    FreeAccountObservationItems(items);
    return AccountObservationRecordState::kUnavailable;
  }
  SecretValue* secret = secret_item_get_secret(item);
  const char* text = secret == nullptr ? nullptr : secret_value_get_text(secret);
  const bool decoded = DecodeAccountObservationCredential(text, &result->bytes);
  if (secret != nullptr) secret_value_unref(secret);
  FreeAccountObservationItems(items);
  return decoded
      ? AccountObservationRecordState::kPresent
      : AccountObservationRecordState::kInvalid;
}

AccountObservationCollectionOpenOutcome ClassifyAccountObservationCollectionError(
    const GError* error) {
  if (error == nullptr) return AccountObservationCollectionOpenOutcome::kErrorOther;
  if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
    return AccountObservationCollectionOpenOutcome::kErrorGioCancelled;
  }
  if (error->domain == G_IO_ERROR) {
    switch (error->code) {
      case G_IO_ERROR_TIMED_OUT:
        return AccountObservationCollectionOpenOutcome::kErrorGioTimedOut;
      case G_IO_ERROR_NOT_FOUND:
        return AccountObservationCollectionOpenOutcome::kErrorGioNotFound;
      case G_IO_ERROR_PERMISSION_DENIED:
        return AccountObservationCollectionOpenOutcome::kErrorGioPermissionDenied;
      case G_IO_ERROR_INVALID_ARGUMENT:
        return AccountObservationCollectionOpenOutcome::kErrorGioInvalidArgument;
      case G_IO_ERROR_NOT_INITIALIZED:
        return AccountObservationCollectionOpenOutcome::kErrorGioNotInitialized;
      case G_IO_ERROR_NOT_SUPPORTED:
        return AccountObservationCollectionOpenOutcome::kErrorGioNotSupported;
      case G_IO_ERROR_CLOSED:
        return AccountObservationCollectionOpenOutcome::kErrorGioClosed;
      case G_IO_ERROR_DBUS_ERROR:
        return AccountObservationCollectionOpenOutcome::kErrorGioDbus;
      default:
        return AccountObservationCollectionOpenOutcome::kErrorGioOther;
    }
  }
  if (error->domain == G_DBUS_ERROR) {
    switch (error->code) {
      case G_DBUS_ERROR_SERVICE_UNKNOWN:
        return AccountObservationCollectionOpenOutcome::kErrorDbusServiceUnknown;
      case G_DBUS_ERROR_NAME_HAS_NO_OWNER:
        return AccountObservationCollectionOpenOutcome::kErrorDbusNoOwner;
      case G_DBUS_ERROR_NO_REPLY:
        return AccountObservationCollectionOpenOutcome::kErrorDbusNoReply;
      case G_DBUS_ERROR_ACCESS_DENIED:
        return AccountObservationCollectionOpenOutcome::kErrorDbusAccessDenied;
      case G_DBUS_ERROR_AUTH_FAILED:
        return AccountObservationCollectionOpenOutcome::kErrorDbusAuthFailed;
      case G_DBUS_ERROR_TIMEOUT:
      case G_DBUS_ERROR_TIMED_OUT:
        return AccountObservationCollectionOpenOutcome::kErrorDbusTimeout;
      case G_DBUS_ERROR_DISCONNECTED:
        return AccountObservationCollectionOpenOutcome::kErrorDbusDisconnected;
      case G_DBUS_ERROR_INVALID_ARGS:
        return AccountObservationCollectionOpenOutcome::kErrorDbusInvalidArgument;
      case G_DBUS_ERROR_NOT_SUPPORTED:
        return AccountObservationCollectionOpenOutcome::kErrorDbusNotSupported;
      case G_DBUS_ERROR_FILE_NOT_FOUND:
        return AccountObservationCollectionOpenOutcome::kErrorDbusNotFound;
      default:
        return AccountObservationCollectionOpenOutcome::kErrorDbusOther;
    }
  }
  return AccountObservationCollectionOpenOutcome::kErrorOther;
}

AccountObservationCollectionOpenOutcome OpenAccountObservationDefaultCollection(
    GCancellable* cancellable,
    SecretCollection** result) {
  if (result == nullptr) return AccountObservationCollectionOpenOutcome::kErrorOther;
  *result = nullptr;
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return AccountObservationCollectionOpenOutcome::kPreCancelled;
  }
  GError* error = nullptr;
  SecretCollection* collection = secret_collection_for_alias_sync(
      nullptr,
      SECRET_COLLECTION_DEFAULT,
      SECRET_COLLECTION_NONE,
      cancellable,
      &error);
  if (error != nullptr) {
    const AccountObservationCollectionOpenOutcome outcome =
        ClassifyAccountObservationCollectionError(error);
    g_error_free(error);
    if (collection != nullptr) g_object_unref(collection);
    return outcome;
  }
  // Do not create a digest intent or ask libsecret to create an item when the
  // resolved default collection is already locked. The fixed route never
  // calls an unlock API; a lock that races this checked snapshot remains an
  // uncertain postcondition and is handled through the retained intent.
  if (collection == nullptr) {
    return AccountObservationCollectionOpenOutcome::kNull;
  }
  if (secret_collection_get_locked(collection)) {
    g_object_unref(collection);
    return AccountObservationCollectionOpenOutcome::kLocked;
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    if (collection != nullptr) g_object_unref(collection);
    return AccountObservationCollectionOpenOutcome::kPostCancelled;
  }
  *result = collection;
  return AccountObservationCollectionOpenOutcome::kReady;
}

bool CreateAccountObservationCredentialNoReplace(
    SecretCollection* collection,
    const std::array<unsigned char, kAccountObservationCredentialBytes>& value,
    GCancellable* cancellable) {
  if (collection == nullptr || AccountObservationDeadlineCancelled(cancellable)) {
    return false;
  }
  std::array<char, 44> encoded = EncodeAccountObservationCredential(value);
  if (encoded[0] == '\0') return false;
  GHashTable* attributes = g_hash_table_new(g_str_hash, g_str_equal);
  if (attributes == nullptr) {
    encoded.fill(0);
    return false;
  }
  g_hash_table_insert(
      attributes,
      const_cast<char*>("service"),
      const_cast<char*>(kAccountObservationService));
  g_hash_table_insert(
      attributes,
      const_cast<char*>("account"),
      const_cast<char*>(kAccountObservationAccount));
  SecretValue* secret = secret_value_new(
      encoded.data(),
      static_cast<gssize>(encoded.size() - 1),
      "text/plain");
  if (secret == nullptr) {
    g_hash_table_destroy(attributes);
    encoded.fill(0);
    return false;
  }
  GError* error = nullptr;
  // Deliberately use the no-replace creation mode. If another writer adds an
  // item concurrently, postcondition lookup sees a duplicate and refuses;
  // this fixed route never updates or deletes a credential item.
  SecretItem* item = secret_item_create_sync(
      collection,
      &kAccountObservationSecretSchema,
      attributes,
      kAccountObservationLabel,
      secret,
      SECRET_ITEM_CREATE_NONE,
      cancellable,
      &error);
  const bool created = item != nullptr && error == nullptr;
  if (error != nullptr) g_error_free(error);
  if (item != nullptr) g_object_unref(item);
  secret_value_unref(secret);
  g_hash_table_destroy(attributes);
  encoded.fill(0);
  return created;
}

bool VerifyAccountObservationOperationJournalContinuity(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity) {
  struct stat opened {};
  struct stat named {};
  return VerifyOwnerPrivateDirectory(state_fd)
      && fstat(journal_fd, &opened) == 0
      && IsOwnerRegularFile(opened)
      && MatchesIdentity(opened, identity)
      && fstatat(
             state_fd,
             kAccountObservationOperationJournalFile,
             &named,
             AT_SYMLINK_NOFOLLOW) == 0
      && IsOwnerRegularFile(named)
      && MatchesIdentity(named, identity);
}

AccountObservationOperationJournalOpenOutcome OpenAccountObservationOperationJournal(
    int state_fd,
    int* journal_fd,
    FileIdentity* identity) {
  if (journal_fd == nullptr || identity == nullptr || !VerifyOwnerPrivateDirectory(state_fd)) {
    return AccountObservationOperationJournalOpenOutcome::kInvalid;
  }
  *journal_fd = -1;
  *identity = FileIdentity {};
  const int fd = openat(
      state_fd,
      kAccountObservationOperationJournalFile,
      O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    return errno == ENOENT
        ? AccountObservationOperationJournalOpenOutcome::kMissing
        : AccountObservationOperationJournalOpenOutcome::kInvalid;
  }
  if (!CaptureRegularFileIdentity(fd, identity)
      || !VerifyAccountObservationOperationJournalContinuity(state_fd, fd, *identity)) {
    close(fd);
    *identity = FileIdentity {};
    return AccountObservationOperationJournalOpenOutcome::kInvalid;
  }
  *journal_fd = fd;
  return AccountObservationOperationJournalOpenOutcome::kOpened;
}

bool ReadAccountObservationOperationJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity,
    AccountObservationOperationJournal* result) {
  if (result == nullptr) return false;
  ClearAccountObservationOperationJournal(result);
  std::array<unsigned char, kAccountObservationOperationJournalBytes> bytes {};
  unsigned char trailing = 0;
  bool valid = false;
  do {
    if (!VerifyAccountObservationOperationJournalContinuity(state_fd, journal_fd, identity)
        || lseek(journal_fd, 0, SEEK_SET) < 0
        || !ReadAll(
            journal_fd,
            reinterpret_cast<char*>(bytes.data()),
            bytes.size())) {
      break;
    }
    ssize_t trailing_count = 0;
    do {
      trailing_count = read(journal_fd, &trailing, 1);
    } while (trailing_count < 0 && errno == EINTR);
    if (trailing_count != 0
        || std::memcmp(
               bytes.data(),
               kAccountObservationOperationJournalMagic.data(),
               kAccountObservationOperationJournalMagic.size()) != 0
        || bytes[kAccountObservationOperationJournalVersionOffset]
            != kAccountObservationOperationJournalVersion
        || bytes[kAccountObservationOperationJournalOperationOffset]
            != kAccountObservationOperationCreate) {
      break;
    }
    bool reserved_zero = true;
    for (std::size_t index = kAccountObservationOperationJournalReservedStart;
         index < kAccountObservationOperationJournalDigestOffset;
         ++index) {
      reserved_zero = reserved_zero && bytes[index] == 0;
    }
    if (!reserved_zero
        || !VerifyAccountObservationOperationJournalContinuity(state_fd, journal_fd, identity)) {
      break;
    }
    std::memcpy(
        result->digest.data(),
        bytes.data() + kAccountObservationOperationJournalDigestOffset,
        result->digest.size());
    valid = true;
  } while (false);
  bytes.fill(0);
  trailing = 0;
  if (!valid) ClearAccountObservationOperationJournal(result);
  return valid;
}

bool CreateAccountObservationOperationJournal(
    int state_fd,
    const std::array<unsigned char, kAccountObservationCredentialBytes>& digest,
    int* journal_fd,
    FileIdentity* identity) {
  if (journal_fd == nullptr || identity == nullptr || !VerifyOwnerPrivateDirectory(state_fd)) {
    return false;
  }
  *journal_fd = -1;
  *identity = FileIdentity {};
  const int fd = openat(
      state_fd,
      kAccountObservationOperationJournalFile,
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (fd < 0) return false;
  std::array<unsigned char, kAccountObservationOperationJournalBytes> bytes {};
  std::memcpy(
      bytes.data(),
      kAccountObservationOperationJournalMagic.data(),
      kAccountObservationOperationJournalMagic.size());
  bytes[kAccountObservationOperationJournalVersionOffset] =
      kAccountObservationOperationJournalVersion;
  bytes[kAccountObservationOperationJournalOperationOffset] =
      kAccountObservationOperationCreate;
  std::memcpy(
      bytes.data() + kAccountObservationOperationJournalDigestOffset,
      digest.data(),
      digest.size());
  const bool written = CaptureRegularFileIdentity(fd, identity)
      && VerifyAccountObservationOperationJournalContinuity(state_fd, fd, *identity)
      && WriteAll(fd, reinterpret_cast<const char*>(bytes.data()), bytes.size())
      && fsync(fd) == 0
      && VerifyAccountObservationOperationJournalContinuity(state_fd, fd, *identity)
      && fsync(state_fd) == 0
      && VerifyAccountObservationOperationJournalContinuity(state_fd, fd, *identity);
  bytes.fill(0);
  if (!written) {
    close(fd);
    *identity = FileIdentity {};
    return false;
  }
  *journal_fd = fd;
  return true;
}

AccountObservationOperationJournalRemoveOutcome RemoveAccountObservationOperationJournal(
    int state_fd,
    int journal_fd,
    const FileIdentity& identity) {
  if (!VerifyAccountObservationOperationJournalContinuity(state_fd, journal_fd, identity)
      || unlinkat(state_fd, kAccountObservationOperationJournalFile, 0) != 0) {
    return AccountObservationOperationJournalRemoveOutcome::kInvalid;
  }
  return fsync(state_fd) == 0
      ? AccountObservationOperationJournalRemoveOutcome::kRemoved
      : AccountObservationOperationJournalRemoveOutcome::kUncertain;
}

struct AccountObservationLease {
  int socket_fd = -1;
  int persistent_state_fd = -1;
  int journal_fd = -1;
  FileIdentity journal_identity {};
  int operation_journal_fd = -1;
  FileIdentity operation_journal_identity {};
  bool active_marker_written = false;
  bool operation_journal_written = false;
  bool active = true;
};

enum class AccountObservationLeaseOutcome {
  kAcquired,
  kUnavailable,
  kRecoveryRequired,
};

enum class AccountObservationOperationRecoveryOutcome {
  kRecovered,
  kUnavailable,
  kAmbiguous,
  kUncertain,
};

bool LatchUnissuedAccountObservationRecovery(
    int state_fd,
    int journal_fd,
    const FileIdentity& journal_identity) {
  return WriteJournalState(
      state_fd,
      journal_fd,
      kAccountObservationCredentialSlot,
      journal_identity,
      JournalState::kActive);
}

bool LatchAccountObservationRecovery(AccountObservationLease* lease) {
  if (lease == nullptr || !lease->active) return false;
  if (lease->active_marker_written) {
    return VerifyJournalContinuity(
               lease->persistent_state_fd,
               lease->journal_fd,
               kAccountObservationCredentialSlot,
               lease->journal_identity)
        && ReadJournalState(lease->journal_fd) == JournalState::kActive
        && VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            kAccountObservationCredentialSlot,
            lease->journal_identity);
  }
  if (!WriteJournalState(
          lease->persistent_state_fd,
          lease->journal_fd,
          kAccountObservationCredentialSlot,
          lease->journal_identity,
          JournalState::kActive)) {
    return false;
  }
  lease->active_marker_written = true;
  return true;
}

bool FinishAccountObservationLease(
    AccountObservationLease* lease,
    bool preserve_active) {
  if (lease == nullptr) return false;
  // A retained digest intent must always keep the v1 state active. An intent
  // that was unlinked before its directory fsync is not a reliable fence, so
  // callers latch active before reaching this cleanup path.
  const bool must_preserve = preserve_active || lease->operation_journal_written;
  const bool operation_journal_retained = !lease->operation_journal_written
      || (lease->operation_journal_fd >= 0
          && VerifyAccountObservationOperationJournalContinuity(
              lease->persistent_state_fd,
              lease->operation_journal_fd,
              lease->operation_journal_identity));
  const bool operation_journal_closed = CloseDescriptor(&lease->operation_journal_fd);
  bool journal_settled = false;
  if (must_preserve) {
    if (!lease->active_marker_written) LatchAccountObservationRecovery(lease);
    journal_settled = VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            kAccountObservationCredentialSlot,
            lease->journal_identity)
        && ReadJournalState(lease->journal_fd) == JournalState::kActive
        && VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            kAccountObservationCredentialSlot,
            lease->journal_identity);
  } else if (!lease->active_marker_written) {
    journal_settled = VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            kAccountObservationCredentialSlot,
            lease->journal_identity)
        && ReadJournalState(lease->journal_fd) == JournalState::kNormal
        && VerifyJournalContinuity(
            lease->persistent_state_fd,
            lease->journal_fd,
            kAccountObservationCredentialSlot,
            lease->journal_identity);
  } else {
    journal_settled = WriteJournalState(
        lease->persistent_state_fd,
        lease->journal_fd,
        kAccountObservationCredentialSlot,
        lease->journal_identity,
        JournalState::kNormal);
  }
  const bool journal_closed = CloseDescriptor(&lease->journal_fd);
  const bool state_closed = CloseDescriptor(&lease->persistent_state_fd);
  const bool socket_closed = CloseDescriptor(&lease->socket_fd);
  lease->active = false;
  delete lease;
  return operation_journal_retained
      && operation_journal_closed
      && journal_settled
      && journal_closed
      && state_closed
      && socket_closed;
}

AccountObservationLeaseOutcome AcquireAccountObservationLease(
    AccountObservationLease** result) {
  if (result == nullptr) return AccountObservationLeaseOutcome::kUnavailable;
  *result = nullptr;
  int socket_fd = -1;
  bool contended = false;
  if (!AcquireKernelLeaseSocket(
          kAccountObservationCredentialSlot,
          &socket_fd,
          &contended)) {
    return AccountObservationLeaseOutcome::kUnavailable;
  }
  int persistent_state_fd = OpenPersistentStateDirectory();
  if (persistent_state_fd < 0) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, nullptr);
    return AccountObservationLeaseOutcome::kUnavailable;
  }
  int journal_fd = -1;
  FileIdentity journal_identity {};
  const JournalOpenOutcome journal = OpenJournal(
      persistent_state_fd,
      kAccountObservationCredentialSlot,
      &journal_fd,
      &journal_identity);
  if (journal == JournalOpenOutcome::kFailure) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountObservationLeaseOutcome::kRecoveryRequired;
  }
  const bool initialized = journal != JournalOpenOutcome::kCreated
      || WriteJournalState(
          persistent_state_fd,
          journal_fd,
          kAccountObservationCredentialSlot,
          journal_identity,
          JournalState::kNormal);
  const JournalState prior = journal == JournalOpenOutcome::kCreated
      ? JournalState::kNormal
      : ReadJournalState(journal_fd);
  if (!initialized || prior == JournalState::kInvalid) {
    LatchUnissuedAccountObservationRecovery(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountObservationLeaseOutcome::kRecoveryRequired;
  }

  int operation_journal_fd = -1;
  FileIdentity operation_journal_identity {};
  const AccountObservationOperationJournalOpenOutcome operation_journal =
      OpenAccountObservationOperationJournal(
          persistent_state_fd,
          &operation_journal_fd,
          &operation_journal_identity);
  if (operation_journal == AccountObservationOperationJournalOpenOutcome::kInvalid) {
    LatchUnissuedAccountObservationRecovery(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountObservationLeaseOutcome::kRecoveryRequired;
  }
  // A newly-created v1 journal cannot safely adopt an existing digest intent:
  // it might be an orphan from a substituted state directory. An active v1
  // journal without an intent is likewise a permanent refusal.
  if ((journal == JournalOpenOutcome::kCreated
       && operation_journal == AccountObservationOperationJournalOpenOutcome::kOpened)
      || (prior == JournalState::kActive
          && operation_journal == AccountObservationOperationJournalOpenOutcome::kMissing)) {
    LatchUnissuedAccountObservationRecovery(
        persistent_state_fd,
        journal_fd,
        journal_identity);
    CloseDescriptor(&operation_journal_fd);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return AccountObservationLeaseOutcome::kRecoveryRequired;
  }

  auto* lease = new (std::nothrow) AccountObservationLease {};
  if (lease == nullptr) {
    if (operation_journal == AccountObservationOperationJournalOpenOutcome::kOpened) {
      LatchUnissuedAccountObservationRecovery(
          persistent_state_fd,
          journal_fd,
          journal_identity);
    }
    CloseDescriptor(&operation_journal_fd);
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, &journal_fd);
    return operation_journal == AccountObservationOperationJournalOpenOutcome::kOpened
        ? AccountObservationLeaseOutcome::kRecoveryRequired
        : AccountObservationLeaseOutcome::kUnavailable;
  }
  lease->socket_fd = socket_fd;
  lease->persistent_state_fd = persistent_state_fd;
  lease->journal_fd = journal_fd;
  lease->journal_identity = journal_identity;
  lease->operation_journal_fd = operation_journal_fd;
  lease->operation_journal_identity = operation_journal_identity;
  lease->active_marker_written = prior == JournalState::kActive;
  lease->operation_journal_written =
      operation_journal == AccountObservationOperationJournalOpenOutcome::kOpened;
  socket_fd = -1;
  persistent_state_fd = -1;
  journal_fd = -1;
  operation_journal_fd = -1;
  *result = lease;
  return AccountObservationLeaseOutcome::kAcquired;
}

bool BeginAccountObservationMutation(
    AccountObservationLease* lease,
    const std::array<unsigned char, kAccountObservationCredentialBytes>& value) {
  if (lease == nullptr
      || !lease->active
      || lease->active_marker_written
      || lease->operation_journal_written
      || lease->operation_journal_fd >= 0) {
    return false;
  }
  std::array<unsigned char, kAccountObservationCredentialBytes> digest {};
  int operation_journal_fd = -1;
  FileIdentity operation_journal_identity {};
  const bool started = DigestAccountObservationCredential(value, &digest)
      && CreateAccountObservationOperationJournal(
          lease->persistent_state_fd,
          digest,
          &operation_journal_fd,
          &operation_journal_identity);
  digest.fill(0);
  if (!started) return false;
  lease->operation_journal_fd = operation_journal_fd;
  lease->operation_journal_identity = operation_journal_identity;
  lease->operation_journal_written = true;
  return LatchAccountObservationRecovery(lease);
}

AccountObservationOperationJournalRemoveOutcome SettleAccountObservationMutation(
    AccountObservationLease* lease) {
  if (lease == nullptr
      || !lease->active
      || !lease->operation_journal_written
      || lease->operation_journal_fd < 0) {
    return AccountObservationOperationJournalRemoveOutcome::kInvalid;
  }
  // Recovery can begin from a normal v1 journal with a retained valid intent.
  // Persist the active refusal before the unlink, so a crash after removal
  // cannot leave an exact remote record with neither a v5 intent nor a fence.
  if (!LatchAccountObservationRecovery(lease)) {
    return AccountObservationOperationJournalRemoveOutcome::kInvalid;
  }
  const AccountObservationOperationJournalRemoveOutcome removal =
      RemoveAccountObservationOperationJournal(
          lease->persistent_state_fd,
          lease->operation_journal_fd,
          lease->operation_journal_identity);
  const bool closed = CloseDescriptor(&lease->operation_journal_fd);
  if (removal == AccountObservationOperationJournalRemoveOutcome::kRemoved && closed) {
    lease->operation_journal_identity = FileIdentity {};
    lease->operation_journal_written = false;
    return AccountObservationOperationJournalRemoveOutcome::kRemoved;
  }
  return removal == AccountObservationOperationJournalRemoveOutcome::kRemoved
      ? AccountObservationOperationJournalRemoveOutcome::kUncertain
      : removal;
}

AccountObservationOperationRecoveryOutcome RecoverAccountObservationOperationJournal(
    AccountObservationLease* lease,
    GCancellable* cancellable) {
  if (lease == nullptr
      || !lease->active
      || !lease->operation_journal_written
      || lease->operation_journal_fd < 0
      || AccountObservationDeadlineCancelled(cancellable)) {
    return AccountObservationOperationRecoveryOutcome::kAmbiguous;
  }
  AccountObservationOperationJournal journal {};
  if (!ReadAccountObservationOperationJournal(
          lease->persistent_state_fd,
          lease->operation_journal_fd,
          lease->operation_journal_identity,
          &journal)) {
    return AccountObservationOperationRecoveryOutcome::kAmbiguous;
  }
  AccountObservationRecord record {};
  const AccountObservationRecordState state = ReadAccountObservationCredential(
      &record,
      cancellable);
  std::array<unsigned char, kAccountObservationCredentialBytes> digest {};
  const bool exact = state == AccountObservationRecordState::kPresent
      && DigestAccountObservationCredential(record.bytes, &digest)
      && EqualAccountObservationCredential(digest, journal.digest);
  ClearAccountObservationRecord(&record);
  digest.fill(0);
  ClearAccountObservationOperationJournal(&journal);
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return AccountObservationOperationRecoveryOutcome::kUnavailable;
  }
  if (!exact) {
    return state == AccountObservationRecordState::kUnavailable
        ? AccountObservationOperationRecoveryOutcome::kUnavailable
        : AccountObservationOperationRecoveryOutcome::kAmbiguous;
  }
  const AccountObservationOperationJournalRemoveOutcome settled =
      SettleAccountObservationMutation(lease);
  return settled == AccountObservationOperationJournalRemoveOutcome::kRemoved
      ? AccountObservationOperationRecoveryOutcome::kRecovered
      : settled == AccountObservationOperationJournalRemoveOutcome::kUncertain
          ? AccountObservationOperationRecoveryOutcome::kUncertain
          : AccountObservationOperationRecoveryOutcome::kAmbiguous;
}

bool AcquireKernelLeaseSocket(int capability_id, int* socket_fd, bool* contended) {
  if (socket_fd == nullptr || contended == nullptr || !IsInternalCredentialSlot(capability_id)) {
    return false;
  }
  *socket_fd = -1;
  *contended = false;
  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return false;

  struct sockaddr_un address {};
  address.sun_family = AF_UNIX;
  const int written = snprintf(
      address.sun_path + 1,
      sizeof(address.sun_path) - 1,
      "%s/%lu/%d",
      kSocketNamespace,
      static_cast<unsigned long>(OwnerUid()),
      capability_id);
  if (written <= 0 || static_cast<std::size_t>(written) > sizeof(address.sun_path) - 1) {
    close(fd);
    return false;
  }
  const socklen_t length = static_cast<socklen_t>(
      offsetof(struct sockaddr_un, sun_path) + 1 + written);
  if (bind(fd, reinterpret_cast<const struct sockaddr*>(&address), length) != 0) {
    const int saved_errno = errno;
    close(fd);
    *contended = saved_errno == EADDRINUSE;
    return false;
  }
  *socket_fd = fd;
  return true;
}

void LeaseFinalizer(napi_env /* env */, void* data, void* /* hint */) {
  auto* lease = static_cast<NativeLease*>(data);
  if (lease == nullptr) return;
  bool issued = false;
  {
    std::lock_guard<std::mutex> lock(g_issued_leases_mutex);
    const auto found = g_issued_leases.find(lease);
    if (found != g_issued_leases.end()) {
      // A collected lease is indistinguishable from an abandoned caller. Keep
      // the durable active journal state, release the kernel-held socket, and
      // force later callers through recovery rather than treating it as settled.
      g_issued_leases.erase(found);
      lease->active = false;
      issued = true;
    }
  }
  if (issued) FinishLease(lease, true);
  delete lease;
}

bool CapabilityArgument(napi_env env, napi_callback_info info, int* capability_id) {
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments.data(),
          nullptr,
          nullptr) != napi_ok
      || argument_count != 1) {
    return false;
  }
  napi_valuetype type = napi_undefined;
  double value = 0;
  if (napi_typeof(env, arguments[0], &type) != napi_ok
      || type != napi_number
      || napi_get_value_double(env, arguments[0], &value) != napi_ok
      || !std::isfinite(value)
      || std::floor(value) != value
      || value < static_cast<double>(std::numeric_limits<int>::min())
      || value > static_cast<double>(std::numeric_limits<int>::max())) {
    return false;
  }
  *capability_id = static_cast<int>(value);
  return IsCapabilityId(*capability_id);
}

bool NoArguments(napi_env env, napi_callback_info info) {
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  return napi_get_cb_info(
             env,
             info,
             &argument_count,
             arguments.data(),
             nullptr,
             nullptr) == napi_ok
      && argument_count == 0;
}

enum class AccountObservationWorkOperation {
  kRead,
  kCreate,
};

enum class AccountObservationWorkResult {
  kAbsent,
  kValue,
  kCreated,
  kExisting,
  kUnavailable,
  kRecoveryRequired,
};

// Temporary names emitted only by the isolated native qualification fixture.
// They identify a fixed pre-intent boundary without exposing a D-Bus path,
// GError message, candidate, or general diagnostic API. Remove this seam once
// the qualification failure has a concrete regression.
enum class AccountObservationQualificationPhase {
  kNone,
  kWatchdog,
  kLease,
  kRead,
  kDeadline,
  kCollectionPreCancelled,
  kCollectionErrorGioCancelled,
  kCollectionErrorGioTimedOut,
  kCollectionErrorGioNotFound,
  kCollectionErrorGioPermissionDenied,
  kCollectionErrorGioInvalidArgument,
  kCollectionErrorGioNotInitialized,
  kCollectionErrorGioNotSupported,
  kCollectionErrorGioClosed,
  kCollectionErrorGioDbus,
  kCollectionErrorGioOther,
  kCollectionErrorDbusServiceUnknown,
  kCollectionErrorDbusNoOwner,
  kCollectionErrorDbusNoReply,
  kCollectionErrorDbusAccessDenied,
  kCollectionErrorDbusAuthFailed,
  kCollectionErrorDbusTimeout,
  kCollectionErrorDbusDisconnected,
  kCollectionErrorDbusInvalidArgument,
  kCollectionErrorDbusNotSupported,
  kCollectionErrorDbusNotFound,
  kCollectionErrorDbusOther,
  kCollectionErrorOther,
  kCollectionNull,
  kCollectionLocked,
  kCollectionPostCancelled,
};

const char* AccountObservationQualificationPhaseName(
    AccountObservationQualificationPhase phase) {
  switch (phase) {
    case AccountObservationQualificationPhase::kWatchdog:
      return "WATCHDOG";
    case AccountObservationQualificationPhase::kLease:
      return "LEASE";
    case AccountObservationQualificationPhase::kRead:
      return "READ";
    case AccountObservationQualificationPhase::kDeadline:
      return "DEADLINE";
    case AccountObservationQualificationPhase::kCollectionPreCancelled:
      return "COLLECTION_PRE_CANCELLED";
    case AccountObservationQualificationPhase::kCollectionErrorGioCancelled:
      return "COLLECTION_ERROR_GIO_CANCELLED";
    case AccountObservationQualificationPhase::kCollectionErrorGioTimedOut:
      return "COLLECTION_ERROR_GIO_TIMED_OUT";
    case AccountObservationQualificationPhase::kCollectionErrorGioNotFound:
      return "COLLECTION_ERROR_GIO_NOT_FOUND";
    case AccountObservationQualificationPhase::kCollectionErrorGioPermissionDenied:
      return "COLLECTION_ERROR_GIO_PERMISSION_DENIED";
    case AccountObservationQualificationPhase::kCollectionErrorGioInvalidArgument:
      return "COLLECTION_ERROR_GIO_INVALID_ARGUMENT";
    case AccountObservationQualificationPhase::kCollectionErrorGioNotInitialized:
      return "COLLECTION_ERROR_GIO_NOT_INITIALIZED";
    case AccountObservationQualificationPhase::kCollectionErrorGioNotSupported:
      return "COLLECTION_ERROR_GIO_NOT_SUPPORTED";
    case AccountObservationQualificationPhase::kCollectionErrorGioClosed:
      return "COLLECTION_ERROR_GIO_CLOSED";
    case AccountObservationQualificationPhase::kCollectionErrorGioDbus:
      return "COLLECTION_ERROR_GIO_DBUS";
    case AccountObservationQualificationPhase::kCollectionErrorGioOther:
      return "COLLECTION_ERROR_GIO_OTHER";
    case AccountObservationQualificationPhase::kCollectionErrorDbusServiceUnknown:
      return "COLLECTION_ERROR_DBUS_SERVICE_UNKNOWN";
    case AccountObservationQualificationPhase::kCollectionErrorDbusNoOwner:
      return "COLLECTION_ERROR_DBUS_NO_OWNER";
    case AccountObservationQualificationPhase::kCollectionErrorDbusNoReply:
      return "COLLECTION_ERROR_DBUS_NO_REPLY";
    case AccountObservationQualificationPhase::kCollectionErrorDbusAccessDenied:
      return "COLLECTION_ERROR_DBUS_ACCESS_DENIED";
    case AccountObservationQualificationPhase::kCollectionErrorDbusAuthFailed:
      return "COLLECTION_ERROR_DBUS_AUTH_FAILED";
    case AccountObservationQualificationPhase::kCollectionErrorDbusTimeout:
      return "COLLECTION_ERROR_DBUS_TIMEOUT";
    case AccountObservationQualificationPhase::kCollectionErrorDbusDisconnected:
      return "COLLECTION_ERROR_DBUS_DISCONNECTED";
    case AccountObservationQualificationPhase::kCollectionErrorDbusInvalidArgument:
      return "COLLECTION_ERROR_DBUS_INVALID_ARGUMENT";
    case AccountObservationQualificationPhase::kCollectionErrorDbusNotSupported:
      return "COLLECTION_ERROR_DBUS_NOT_SUPPORTED";
    case AccountObservationQualificationPhase::kCollectionErrorDbusNotFound:
      return "COLLECTION_ERROR_DBUS_NOT_FOUND";
    case AccountObservationQualificationPhase::kCollectionErrorDbusOther:
      return "COLLECTION_ERROR_DBUS_OTHER";
    case AccountObservationQualificationPhase::kCollectionErrorOther:
      return "COLLECTION_ERROR_OTHER";
    case AccountObservationQualificationPhase::kCollectionNull:
      return "COLLECTION_NULL";
    case AccountObservationQualificationPhase::kCollectionLocked:
      return "COLLECTION_LOCKED";
    case AccountObservationQualificationPhase::kCollectionPostCancelled:
      return "COLLECTION_POST_CANCELLED";
    case AccountObservationQualificationPhase::kNone:
      return nullptr;
  }
  return nullptr;
}

AccountObservationQualificationPhase AccountObservationCollectionQualificationPhase(
    AccountObservationCollectionOpenOutcome outcome) {
  switch (outcome) {
    case AccountObservationCollectionOpenOutcome::kPreCancelled:
      return AccountObservationQualificationPhase::kCollectionPreCancelled;
    case AccountObservationCollectionOpenOutcome::kErrorGioCancelled:
      return AccountObservationQualificationPhase::kCollectionErrorGioCancelled;
    case AccountObservationCollectionOpenOutcome::kErrorGioTimedOut:
      return AccountObservationQualificationPhase::kCollectionErrorGioTimedOut;
    case AccountObservationCollectionOpenOutcome::kErrorGioNotFound:
      return AccountObservationQualificationPhase::kCollectionErrorGioNotFound;
    case AccountObservationCollectionOpenOutcome::kErrorGioPermissionDenied:
      return AccountObservationQualificationPhase::kCollectionErrorGioPermissionDenied;
    case AccountObservationCollectionOpenOutcome::kErrorGioInvalidArgument:
      return AccountObservationQualificationPhase::kCollectionErrorGioInvalidArgument;
    case AccountObservationCollectionOpenOutcome::kErrorGioNotInitialized:
      return AccountObservationQualificationPhase::kCollectionErrorGioNotInitialized;
    case AccountObservationCollectionOpenOutcome::kErrorGioNotSupported:
      return AccountObservationQualificationPhase::kCollectionErrorGioNotSupported;
    case AccountObservationCollectionOpenOutcome::kErrorGioClosed:
      return AccountObservationQualificationPhase::kCollectionErrorGioClosed;
    case AccountObservationCollectionOpenOutcome::kErrorGioDbus:
      return AccountObservationQualificationPhase::kCollectionErrorGioDbus;
    case AccountObservationCollectionOpenOutcome::kErrorGioOther:
      return AccountObservationQualificationPhase::kCollectionErrorGioOther;
    case AccountObservationCollectionOpenOutcome::kErrorDbusServiceUnknown:
      return AccountObservationQualificationPhase::kCollectionErrorDbusServiceUnknown;
    case AccountObservationCollectionOpenOutcome::kErrorDbusNoOwner:
      return AccountObservationQualificationPhase::kCollectionErrorDbusNoOwner;
    case AccountObservationCollectionOpenOutcome::kErrorDbusNoReply:
      return AccountObservationQualificationPhase::kCollectionErrorDbusNoReply;
    case AccountObservationCollectionOpenOutcome::kErrorDbusAccessDenied:
      return AccountObservationQualificationPhase::kCollectionErrorDbusAccessDenied;
    case AccountObservationCollectionOpenOutcome::kErrorDbusAuthFailed:
      return AccountObservationQualificationPhase::kCollectionErrorDbusAuthFailed;
    case AccountObservationCollectionOpenOutcome::kErrorDbusTimeout:
      return AccountObservationQualificationPhase::kCollectionErrorDbusTimeout;
    case AccountObservationCollectionOpenOutcome::kErrorDbusDisconnected:
      return AccountObservationQualificationPhase::kCollectionErrorDbusDisconnected;
    case AccountObservationCollectionOpenOutcome::kErrorDbusInvalidArgument:
      return AccountObservationQualificationPhase::kCollectionErrorDbusInvalidArgument;
    case AccountObservationCollectionOpenOutcome::kErrorDbusNotSupported:
      return AccountObservationQualificationPhase::kCollectionErrorDbusNotSupported;
    case AccountObservationCollectionOpenOutcome::kErrorDbusNotFound:
      return AccountObservationQualificationPhase::kCollectionErrorDbusNotFound;
    case AccountObservationCollectionOpenOutcome::kErrorDbusOther:
      return AccountObservationQualificationPhase::kCollectionErrorDbusOther;
    case AccountObservationCollectionOpenOutcome::kErrorOther:
      return AccountObservationQualificationPhase::kCollectionErrorOther;
    case AccountObservationCollectionOpenOutcome::kNull:
      return AccountObservationQualificationPhase::kCollectionNull;
    case AccountObservationCollectionOpenOutcome::kLocked:
      return AccountObservationQualificationPhase::kCollectionLocked;
    case AccountObservationCollectionOpenOutcome::kPostCancelled:
      return AccountObservationQualificationPhase::kCollectionPostCancelled;
    case AccountObservationCollectionOpenOutcome::kReady:
      return AccountObservationQualificationPhase::kNone;
  }
  return AccountObservationQualificationPhase::kNone;
}

bool AccountObservationQualificationDiagnosticsEnabled() {
  const char* native_test = getenv(
      "USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST");
  const char* isolated = getenv("TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED");
  return native_test != nullptr
      && isolated != nullptr
      && std::strcmp(native_test, "1") == 0
      && std::strcmp(isolated, "1") == 0;
}

void AttachAccountObservationQualificationPhase(
    napi_env env,
    napi_value error,
    AccountObservationQualificationPhase phase) {
  const char* name = AccountObservationQualificationPhaseName(phase);
  if (env == nullptr || error == nullptr || name == nullptr
      || !AccountObservationQualificationDiagnosticsEnabled()) {
    return;
  }
  napi_value value = nullptr;
  if (napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &value) == napi_ok) {
    // This fixed, test-only property is intentionally non-authoritative: a
    // failure to attach it leaves the public unavailable outcome unchanged.
    static_cast<void>(napi_set_named_property(env, error, "qualificationPhase", value));
  }
}

struct AccountObservationWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  AccountObservationWorkOperation operation = AccountObservationWorkOperation::kRead;
  std::array<unsigned char, kAccountObservationCredentialBytes> candidate {};
  std::array<unsigned char, kAccountObservationCredentialBytes> value {};
  AccountObservationWorkResult result = AccountObservationWorkResult::kUnavailable;
  AccountObservationQualificationPhase qualification_phase =
      AccountObservationQualificationPhase::kNone;
};

void ClearAccountObservationWork(AccountObservationWork* work) {
  if (work == nullptr) return;
  work->candidate.fill(0);
  work->value.fill(0);
}

AccountObservationWorkResult FinishAccountObservationUnavailable(
    AccountObservationLease* lease) {
  return FinishAccountObservationLease(lease, false)
      ? AccountObservationWorkResult::kUnavailable
      : AccountObservationWorkResult::kRecoveryRequired;
}

AccountObservationWorkResult FinishAccountObservationRecovery(
    AccountObservationLease* lease) {
  if (lease == nullptr) return AccountObservationWorkResult::kRecoveryRequired;
  LatchAccountObservationRecovery(lease);
  FinishAccountObservationLease(lease, true);
  return AccountObservationWorkResult::kRecoveryRequired;
}

AccountObservationWorkResult FinishAccountObservationCancellation(
    AccountObservationLease* lease) {
  if (lease == nullptr) return AccountObservationWorkResult::kUnavailable;
  return lease->operation_journal_written || lease->active_marker_written
      ? FinishAccountObservationRecovery(lease)
      : FinishAccountObservationUnavailable(lease);
}

AccountObservationWorkResult FinishAccountObservationNormal(
    AccountObservationLease* lease,
    AccountObservationDeadlineGuard* deadline,
    AccountObservationWorkResult normal_result) {
  // Freeze the watchdog before changing active back to normal. If it expired
  // between the last service postcondition check and this point, the v1/v5
  // recovery fence remains durable rather than racing that final settlement.
  if (deadline == nullptr || deadline->StopDeadline()) {
    return FinishAccountObservationCancellation(lease);
  }
  return FinishAccountObservationLease(lease, false)
      ? normal_result
      : AccountObservationWorkResult::kRecoveryRequired;
}

bool ReconcilePendingAccountObservationOperation(
    AccountObservationLease* lease,
    GCancellable* cancellable) {
  if (lease == nullptr) return false;
  if (!lease->operation_journal_written) return true;
  return RecoverAccountObservationOperationJournal(lease, cancellable)
      == AccountObservationOperationRecoveryOutcome::kRecovered;
}

AccountObservationWorkResult RunAccountObservationRead(
    AccountObservationWork* work,
    GCancellable* cancellable,
    AccountObservationDeadlineGuard* deadline) {
  if (work == nullptr) return AccountObservationWorkResult::kUnavailable;
  AccountObservationLease* lease = nullptr;
  const AccountObservationLeaseOutcome acquired = AcquireAccountObservationLease(&lease);
  if (acquired == AccountObservationLeaseOutcome::kRecoveryRequired) {
    return AccountObservationWorkResult::kRecoveryRequired;
  }
  if (acquired != AccountObservationLeaseOutcome::kAcquired) {
    return AccountObservationWorkResult::kUnavailable;
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationCancellation(lease);
  }
  if (!ReconcilePendingAccountObservationOperation(lease, cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationCancellation(lease);
  }
  AccountObservationRecord record {};
  const AccountObservationRecordState state = ReadAccountObservationCredential(
      &record,
      cancellable);
  const bool cancelled = AccountObservationDeadlineCancelled(cancellable);
  if (state == AccountObservationRecordState::kAbsent) {
    ClearAccountObservationRecord(&record);
    if (cancelled) return FinishAccountObservationCancellation(lease);
    return FinishAccountObservationNormal(
        lease,
        deadline,
        AccountObservationWorkResult::kAbsent);
  }
  if (state == AccountObservationRecordState::kPresent) {
    work->value = record.bytes;
    ClearAccountObservationRecord(&record);
    if (cancelled) {
      work->value.fill(0);
      return FinishAccountObservationCancellation(lease);
    }
    const AccountObservationWorkResult result = FinishAccountObservationNormal(
        lease,
        deadline,
        AccountObservationWorkResult::kValue);
    if (result != AccountObservationWorkResult::kValue) {
      work->value.fill(0);
    }
    return result;
  }
  ClearAccountObservationRecord(&record);
  if (cancelled) return FinishAccountObservationCancellation(lease);
  return state == AccountObservationRecordState::kUnavailable
      ? FinishAccountObservationUnavailable(lease)
      : FinishAccountObservationRecovery(lease);
}

AccountObservationWorkResult RunAccountObservationCreate(
    AccountObservationWork* work,
    GCancellable* cancellable,
    AccountObservationDeadlineGuard* deadline) {
  if (work == nullptr) return AccountObservationWorkResult::kUnavailable;
  AccountObservationLease* lease = nullptr;
  const AccountObservationLeaseOutcome acquired = AcquireAccountObservationLease(&lease);
  if (acquired == AccountObservationLeaseOutcome::kRecoveryRequired) {
    return AccountObservationWorkResult::kRecoveryRequired;
  }
  if (acquired != AccountObservationLeaseOutcome::kAcquired) {
    work->qualification_phase = AccountObservationQualificationPhase::kLease;
    return AccountObservationWorkResult::kUnavailable;
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    work->qualification_phase = AccountObservationQualificationPhase::kDeadline;
    return FinishAccountObservationCancellation(lease);
  }
  if (!ReconcilePendingAccountObservationOperation(lease, cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    work->qualification_phase = AccountObservationQualificationPhase::kDeadline;
    return FinishAccountObservationCancellation(lease);
  }

  AccountObservationRecord before {};
  const AccountObservationRecordState before_state = ReadAccountObservationCredential(
      &before,
      cancellable);
  const bool cancelled_before = AccountObservationDeadlineCancelled(cancellable);
  if (before_state == AccountObservationRecordState::kPresent) {
    ClearAccountObservationRecord(&before);
    if (cancelled_before) {
      work->qualification_phase = AccountObservationQualificationPhase::kDeadline;
      return FinishAccountObservationCancellation(lease);
    }
    return FinishAccountObservationNormal(
        lease,
        deadline,
        AccountObservationWorkResult::kExisting);
  }
  ClearAccountObservationRecord(&before);
  if (cancelled_before) {
    work->qualification_phase = AccountObservationQualificationPhase::kDeadline;
    return FinishAccountObservationCancellation(lease);
  }
  if (before_state == AccountObservationRecordState::kUnavailable) {
    work->qualification_phase = AccountObservationQualificationPhase::kRead;
    return FinishAccountObservationUnavailable(lease);
  }
  if (before_state != AccountObservationRecordState::kAbsent) {
    return FinishAccountObservationRecovery(lease);
  }

  // Obtain the default collection before persisting the digest intent. A
  // missing or locked collection is a known non-mutation failure, whereas a
  // later create result is intentionally reconciled through the digest.
  SecretCollection* collection = nullptr;
  const AccountObservationCollectionOpenOutcome collection_outcome =
      OpenAccountObservationDefaultCollection(cancellable, &collection);
  if (collection_outcome != AccountObservationCollectionOpenOutcome::kReady) {
    work->qualification_phase =
        AccountObservationCollectionQualificationPhase(collection_outcome);
    // Preserve the pre-existing caller-side cancellation fence. The helper's
    // outcome is diagnostic-only: the watchdog can still fire after any
    // non-ready return and before this settlement decision.
    return AccountObservationDeadlineCancelled(cancellable)
        ? FinishAccountObservationCancellation(lease)
        : FinishAccountObservationUnavailable(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    g_object_unref(collection);
    work->qualification_phase = AccountObservationQualificationPhase::kDeadline;
    return FinishAccountObservationCancellation(lease);
  }
  if (!BeginAccountObservationMutation(lease, work->candidate)) {
    g_object_unref(collection);
    return FinishAccountObservationRecovery(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    g_object_unref(collection);
    return FinishAccountObservationRecovery(lease);
  }
  CreateAccountObservationCredentialNoReplace(collection, work->candidate, cancellable);
  g_object_unref(collection);
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }

  AccountObservationRecord after {};
  const AccountObservationRecordState after_state = ReadAccountObservationCredential(
      &after,
      cancellable);
  const bool exact = after_state == AccountObservationRecordState::kPresent
      && EqualAccountObservationCredential(after.bytes, work->candidate);
  ClearAccountObservationRecord(&after);
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }
  if (!exact) {
    // A no-replace create may still race a non-cooperating same-user writer and
    // leave a duplicate or foreign item. Retain the digest intent and refuse;
    // this route never cleans, replaces, or adopts that state.
    return FinishAccountObservationRecovery(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }
  if (SettleAccountObservationMutation(lease)
      != AccountObservationOperationJournalRemoveOutcome::kRemoved) {
    return FinishAccountObservationRecovery(lease);
  }
  if (AccountObservationDeadlineCancelled(cancellable)) {
    return FinishAccountObservationRecovery(lease);
  }
  return FinishAccountObservationNormal(
      lease,
      deadline,
      AccountObservationWorkResult::kCreated);
}

void ExecuteAccountObservationWork(napi_env /* env */, void* data) {
  auto* work = static_cast<AccountObservationWork*>(data);
  if (work == nullptr) return;
  AccountObservationDeadlineGuard deadline;
  if (!deadline.Start()) {
    work->qualification_phase = AccountObservationQualificationPhase::kWatchdog;
    work->result = AccountObservationWorkResult::kUnavailable;
  } else {
    GCancellable* cancellable = deadline.cancellable();
    work->result = work->operation == AccountObservationWorkOperation::kRead
        ? RunAccountObservationRead(work, cancellable, &deadline)
        : RunAccountObservationCreate(work, cancellable, &deadline);
  }
  deadline.Finish();
  work->candidate.fill(0);
}

const char* AccountObservationWorkErrorCode(AccountObservationWorkResult result) {
  return result == AccountObservationWorkResult::kRecoveryRequired
      ? kCodeAccountObservationRecoveryRequired
      : kCodeAccountObservationUnavailable;
}

void CompleteAccountObservationWork(
    napi_env env,
    napi_status status,
    void* data) {
  auto* work = static_cast<AccountObservationWork*>(data);
  if (work == nullptr) return;
  const AccountObservationWorkResult result = status == napi_ok
      ? work->result
      : AccountObservationWorkResult::kUnavailable;
  napi_value resolution = nullptr;
  napi_status settled = napi_generic_failure;
  if (result == AccountObservationWorkResult::kAbsent) {
    settled = napi_get_null(env, &resolution) == napi_ok
        ? napi_resolve_deferred(env, work->deferred, resolution)
        : napi_generic_failure;
  } else if (result == AccountObservationWorkResult::kValue) {
    void* copied = nullptr;
    settled = napi_create_buffer_copy(
        env,
        work->value.size(),
        work->value.data(),
        &copied,
        &resolution) == napi_ok
        ? napi_resolve_deferred(env, work->deferred, resolution)
        : napi_generic_failure;
  } else if (result == AccountObservationWorkResult::kCreated
      || result == AccountObservationWorkResult::kExisting) {
    const char* text = result == AccountObservationWorkResult::kCreated
        ? "created"
        : "existing";
    settled = napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &resolution) == napi_ok
        ? napi_resolve_deferred(env, work->deferred, resolution)
        : napi_generic_failure;
  } else {
    napi_value error = MakeFixedError(env, AccountObservationWorkErrorCode(result));
    if (error != nullptr) {
      if (result == AccountObservationWorkResult::kUnavailable
          && work->operation == AccountObservationWorkOperation::kCreate) {
        AttachAccountObservationQualificationPhase(
            env,
            error,
            work->qualification_phase);
      }
      settled = napi_reject_deferred(env, work->deferred, error);
    }
  }
  // The deferred has no caller-visible secret data. If N-API cannot settle it,
  // the completed native operation remains durable and a later read is the
  // only safe observation; do not recreate any intent or credential here.
  static_cast<void>(settled);
  if (work->work != nullptr) napi_delete_async_work(env, work->work);
  ClearAccountObservationWork(work);
  delete work;
}

bool AccountObservationCredentialArgument(
    napi_env env,
    napi_callback_info info,
    std::array<unsigned char, kAccountObservationCredentialBytes>* value) {
  if (value == nullptr) return false;
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  bool is_buffer = false;
  void* bytes = nullptr;
  std::size_t length = 0;
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments.data(),
          nullptr,
          nullptr) != napi_ok
      || argument_count != 1
      || napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok
      || !is_buffer
      || napi_get_buffer_info(env, arguments[0], &bytes, &length) != napi_ok
      || bytes == nullptr
      || length != value->size()) {
    return false;
  }
  std::memcpy(value->data(), bytes, value->size());
  return true;
}

napi_value QueueAccountObservationWork(
    napi_env env,
    AccountObservationWorkOperation operation,
    const std::array<unsigned char, kAccountObservationCredentialBytes>* candidate) {
  auto* work = new (std::nothrow) AccountObservationWork {};
  if (work == nullptr) return ThrowFixed(env, kCodeAccountObservationUnavailable);
  work->operation = operation;
  if (candidate != nullptr) work->candidate = *candidate;
  napi_value promise = nullptr;
  napi_value resource_name = nullptr;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok
      || napi_create_string_utf8(
          env,
          "linuxAccountObservationCredential",
          NAPI_AUTO_LENGTH,
          &resource_name) != napi_ok
      || napi_create_async_work(
          env,
          nullptr,
          resource_name,
          ExecuteAccountObservationWork,
          CompleteAccountObservationWork,
          work,
          &work->work) != napi_ok
      || napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work != nullptr) napi_delete_async_work(env, work->work);
    ClearAccountObservationWork(work);
    delete work;
    return ThrowFixed(env, kCodeAccountObservationUnavailable);
  }
  return promise;
}

napi_value ReadAccountObservationCredential(
    napi_env env,
    napi_callback_info info) {
  if (!NoArguments(env, info)) {
    return ThrowFixed(env, kCodeAccountObservationInvalidValue);
  }
  return QueueAccountObservationWork(env, AccountObservationWorkOperation::kRead, nullptr);
}

napi_value CreateAccountObservationCredentialIfMissing(
    napi_env env,
    napi_callback_info info) {
  std::array<unsigned char, kAccountObservationCredentialBytes> candidate {};
  if (!AccountObservationCredentialArgument(env, info, &candidate)) {
    candidate.fill(0);
    return ThrowFixed(env, kCodeAccountObservationInvalidValue);
  }
  napi_value result = QueueAccountObservationWork(
      env,
      AccountObservationWorkOperation::kCreate,
      &candidate);
  candidate.fill(0);
  return result;
}

// This is deliberately a zero-argument main-process preparation authority.
// It has no credential, journal, capability, or pathname input and does not
// select a backend. It only creates the absent fixed directories needed before
// a later, separately gated credential operation can reopen them.
napi_value PrepareLinuxCredentialState(napi_env env, napi_callback_info info) {
  if (!NoArguments(env, info)) return ThrowFixed(env, kCodeStateInvalid);

  std::string state_base;
  const int state_base_fd = OpenOrPrepareStateBaseDirectory(&state_base);
  if (state_base_fd < 0) return ThrowFixed(env, kCodeStateUnavailable);
  if (!PreflightExistingCredentialStateDirectories(state_base_fd)) {
    close(state_base_fd);
    return ThrowFixed(env, kCodeStateInvalid);
  }
  const bool prepared = PrepareFixedCredentialStateDirectories(state_base_fd);
  const bool state_base_closed = close(state_base_fd) == 0;
  if (!prepared || !state_base_closed
      || !ReopenAndValidateCredentialStateDirectories(state_base)) {
    return ThrowFixed(env, kCodeStateUnavailable);
  }
  napi_value undefined = nullptr;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return ThrowFixed(env, kCodeStateUnavailable);
  }
  return undefined;
}

napi_value AcquireCredentialMutex(napi_env env, napi_callback_info info) {
  int capability_id = -1;
  if (!CapabilityArgument(env, info, &capability_id)) {
    return ThrowFixed(env, kCodeInvalidCapability);
  }

  int socket_fd = -1;
  bool contended = false;
  if (!AcquireKernelLeaseSocket(capability_id, &socket_fd, &contended)) {
    return ThrowFixed(env, contended ? kCodeContended : kCodeRuntimeUnavailable);
  }
  int persistent_state_fd = OpenPersistentStateDirectory();
  if (persistent_state_fd < 0) {
    CloseUnissuedLeaseDescriptors(&socket_fd, &persistent_state_fd, nullptr);
    return ThrowFixed(env, kCodeStateUnavailable);
  }
  int journal_fd = -1;
  FileIdentity journal_identity {};
  const JournalOpenOutcome journal = OpenJournal(
      persistent_state_fd,
      capability_id,
      &journal_fd,
      &journal_identity);
  if (journal == JournalOpenOutcome::kFailure) {
    CloseUnissuedLeaseDescriptors(
        &socket_fd,
        &persistent_state_fd,
        &journal_fd);
    return ThrowFixed(env, kCodeStateInvalid);
  }
  const JournalState prior = journal == JournalOpenOutcome::kCreated
      ? JournalState::kNormal
      : ReadJournalState(journal_fd);
  if (prior == JournalState::kInvalid
      || !WriteJournalState(
          persistent_state_fd,
          journal_fd,
          capability_id,
          journal_identity,
          JournalState::kActive)) {
    CloseUnissuedLeaseDescriptors(
        &socket_fd,
        &persistent_state_fd,
        &journal_fd);
    return ThrowFixed(env, kCodeStateInvalid);
  }

  auto* lease = new (std::nothrow) NativeLease {};
  if (lease == nullptr) {
    CloseUnissuedLeaseDescriptors(
        &socket_fd,
        &persistent_state_fd,
        &journal_fd);
    return ThrowFixed(env, kCodeStateUnavailable);
  }
  lease->socket_fd = socket_fd;
  lease->persistent_state_fd = persistent_state_fd;
  lease->journal_fd = journal_fd;
  lease->journal_identity = journal_identity;
  lease->capability_id = capability_id;
  lease->abandoned = prior == JournalState::kActive;
  // Ownership transferred to the lease object. Do not close these aliases in
  // an error path after this point.
  socket_fd = -1;
  persistent_state_fd = -1;
  journal_fd = -1;
  {
    std::lock_guard<std::mutex> lock(g_issued_leases_mutex);
    g_issued_leases.insert(lease);
  }

  napi_value native_lease = nullptr;
  napi_value result = nullptr;
  napi_value abandoned = nullptr;
  const napi_status status = napi_create_external(
      env,
      lease,
      LeaseFinalizer,
      nullptr,
      &native_lease);
  if (status != napi_ok
      || napi_create_object(env, &result) != napi_ok
      || napi_get_boolean(env, lease->abandoned, &abandoned) != napi_ok
      || napi_set_named_property(env, result, "lease", native_lease) != napi_ok
      || napi_set_named_property(env, result, "abandoned", abandoned) != napi_ok) {
    {
      std::lock_guard<std::mutex> lock(g_issued_leases_mutex);
      g_issued_leases.erase(lease);
      lease->active = false;
    }
    FinishLease(lease, true);
    // If napi_create_external succeeded, its finalizer owns the allocation.
    // It sees an inactive lease and only deletes it. Otherwise this branch
    // remains responsible for the allocation.
    if (native_lease == nullptr) delete lease;
    return ThrowFixed(env, kCodeStateUnavailable);
  }
  return result;
}

bool ReadIssuedLease(
    napi_env env,
    napi_callback_info info,
    NativeLease** lease) {
  if (lease == nullptr) return false;
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments.data(),
          nullptr,
          nullptr) != napi_ok
      || argument_count != 1) {
    return false;
  }
  void* raw_lease = nullptr;
  if (napi_get_value_external(env, arguments[0], &raw_lease) != napi_ok
      || raw_lease == nullptr) {
    return false;
  }
  *lease = static_cast<NativeLease*>(raw_lease);
  return true;
}

napi_value FinishIssuedLease(
    napi_env env,
    napi_callback_info info,
    bool preserve_active) {
  NativeLease* lease = nullptr;
  if (!ReadIssuedLease(env, info, &lease)) return ThrowFixed(env, kCodeForeign);
  {
    std::lock_guard<std::mutex> lock(g_issued_leases_mutex);
    const auto found = g_issued_leases.find(lease);
    if (found == g_issued_leases.end() || !lease->active) {
      return ThrowFixed(env, kCodeForeign);
    }
    // A caller cannot settle a lease that already found an interrupted
    // transaction. Only a future explicit recovery workflow may clear that
    // durable state.
    if (!FinishLease(lease, preserve_active || lease->abandoned)) {
      lease->active = false;
      g_issued_leases.erase(found);
      return ThrowFixed(env, kCodeReleaseFailed);
    }
    lease->active = false;
    g_issued_leases.erase(found);
  }
  napi_value undefined = nullptr;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return ThrowFixed(env, kCodeReleaseFailed);
  }
  return undefined;
}

napi_value ReleaseCredentialMutex(napi_env env, napi_callback_info info) {
  return FinishIssuedLease(env, info, false);
}

napi_value AbandonCredentialMutex(napi_env env, napi_callback_info info) {
  return FinishIssuedLease(env, info, true);
}

bool AccountlessCredentialArgument(
    napi_env env,
    napi_callback_info info,
    std::array<unsigned char, kAccountlessCredentialBytes>* value) {
  if (value == nullptr) return false;
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  bool is_buffer = false;
  void* bytes = nullptr;
  std::size_t length = 0;
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments.data(),
          nullptr,
          nullptr) != napi_ok
      || argument_count != 1
      || napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok
      || !is_buffer
      || napi_get_buffer_info(env, arguments[0], &bytes, &length) != napi_ok
      || bytes == nullptr
      || length != value->size()) {
    return false;
  }
  std::memcpy(value->data(), bytes, value->size());
  return true;
}

napi_value AccountlessStatus(napi_env env, const char* status) {
  napi_value value = nullptr;
  if (napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value) != napi_ok) {
    return ThrowFixed(env, kCodeAccountlessUnavailable);
  }
  return value;
}

napi_value AccountlessValue(
    napi_env env,
    const std::array<unsigned char, kAccountlessCredentialBytes>& bytes) {
  napi_value value = nullptr;
  void* copied = nullptr;
  if (napi_create_buffer_copy(
          env,
          bytes.size(),
          bytes.data(),
          &copied,
          &value) != napi_ok) {
    return nullptr;
  }
  return value;
}

napi_value FailAccountlessRecovery(napi_env env, NativeLease* lease);
napi_value FailAccountlessKnownNonMutation(napi_env env, NativeLease* lease);
napi_value FailAccountlessPendingOperation(napi_env env, NativeLease* lease);

napi_value ReadAccountlessInstallationCredential(
    napi_env env,
    napi_callback_info info) {
  std::array<napi_value, 1> arguments {};
  std::size_t argument_count = arguments.size();
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments.data(),
          nullptr,
          nullptr) != napi_ok
      || argument_count != 0) {
    return ThrowFixed(env, kCodeAccountlessInvalidValue);
  }
  NativeLease* lease = nullptr;
  const AccountlessLeaseOutcome acquired = AcquireAccountlessLease(&lease);
  if (acquired == AccountlessLeaseOutcome::kRecoveryRequired) {
    return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
  }
  if (acquired != AccountlessLeaseOutcome::kAcquired) {
    return ThrowFixed(env, kCodeAccountlessUnavailable);
  }
  const int credential_directory_fd = OpenAccountlessCredentialDirectory();
  if (credential_directory_fd < 0) {
    return FailAccountlessKnownNonMutation(env, lease);
  }
  AccountlessRecord record {};
  const AccountlessRecordState state = ReadAccountlessRecord(
      credential_directory_fd,
      &record);
  const bool closed = close(credential_directory_fd) == 0;
  if (state == AccountlessRecordState::kInvalid || !closed) {
    record.bytes.fill(0);
    return FailAccountlessRecovery(env, lease);
  }
  if (state == AccountlessRecordState::kUnavailable) {
    record.bytes.fill(0);
    return FailAccountlessKnownNonMutation(env, lease);
  }
  napi_value result = nullptr;
  if (state == AccountlessRecordState::kAbsent) {
    napi_get_null(env, &result);
  } else {
    result = AccountlessValue(env, record.bytes);
  }
  record.bytes.fill(0);
  if (result == nullptr) {
    napi_value ignored = nullptr;
    napi_get_and_clear_last_exception(env, &ignored);
    const bool settled = FinishAccountlessLease(lease, false);
    return ThrowFixed(
        env,
        settled ? kCodeAccountlessUnavailable : kCodeAccountlessRecoveryRequired);
  }
  if (!FinishAccountlessLease(lease, false)) {
    return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
  }
  return result;
}

napi_value FailAccountlessKnownNonMutation(napi_env env, NativeLease* lease) {
  if (lease == nullptr || lease->accountless_active_marker_written) {
    return FailAccountlessRecovery(env, lease);
  }
  if (lease->accountless_operation_journal_written) {
    return FailAccountlessPendingOperation(env, lease);
  }
  return ThrowFixed(
      env,
      FinishAccountlessLease(lease, false)
          ? kCodeAccountlessUnavailable
          : kCodeAccountlessRecoveryRequired);
}

napi_value FailAccountlessPendingOperation(napi_env env, NativeLease* lease) {
  // A complete v2 intent remains the only authority for replay. Do not turn
  // it into a generic v1 active marker: the next private-socket holder must be
  // able to inspect the exact journal and observed record state.
  if (lease == nullptr || !lease->accountless_operation_journal_written) {
    return FailAccountlessRecovery(env, lease);
  }
  if (lease->accountless_operation_journal_fd < 0) {
    // Settle may already have unlinked the fixed v2 name before its directory
    // fsync or descriptor close failed. That name cannot honestly fence a
    // later process, so retain the legacy v1 active refusal rather than
    // recreating an intent from a final record that merely appears correct.
    LatchAccountlessRecovery(lease);
    FinishAccountlessLease(lease, true);
    return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
  }
  FinishAccountlessLease(lease, false);
  return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
}

napi_value FailAccountlessRecovery(napi_env env, NativeLease* lease) {
  // Once an O_EXCL temporary inode, rename, unlink, or malformed/unsafe fixed
  // record was observed, retain the active marker. A later startup must not
  // silently mint or erase an installation identity through an ambiguous
  // local state.
  LatchAccountlessRecovery(lease);
  FinishAccountlessLease(lease, true);
  return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
}

napi_value CreateAccountlessInstallationCredentialIfMissing(
    napi_env env,
    napi_callback_info info) {
  std::array<unsigned char, kAccountlessCredentialBytes> value {};
  if (!AccountlessCredentialArgument(env, info, &value)) {
    value.fill(0);
    return ThrowFixed(env, kCodeAccountlessInvalidValue);
  }
  NativeLease* lease = nullptr;
  const AccountlessLeaseOutcome acquired = AcquireAccountlessLease(&lease);
  if (acquired != AccountlessLeaseOutcome::kAcquired) {
    value.fill(0);
    return ThrowFixed(
        env,
        acquired == AccountlessLeaseOutcome::kRecoveryRequired
            ? kCodeAccountlessRecoveryRequired
            : kCodeAccountlessUnavailable);
  }
  int credential_directory_fd = OpenAccountlessCredentialDirectory();
  if (credential_directory_fd < 0) {
    value.fill(0);
    return FailAccountlessKnownNonMutation(env, lease);
  }

  AccountlessRecord existing {};
  const AccountlessRecordState before = ReadAccountlessRecord(
      credential_directory_fd,
      &existing);
  if (before == AccountlessRecordState::kPresent) {
    ClearAccountlessRecord(&existing);
    const bool directory_closed = CloseDescriptor(&credential_directory_fd);
    value.fill(0);
    if (!directory_closed) return FailAccountlessRecovery(env, lease);
    if (!FinishAccountlessLease(lease, false)) {
      return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
    }
    return AccountlessStatus(env, "existing");
  }
  ClearAccountlessRecord(&existing);
  if (before == AccountlessRecordState::kInvalid) {
    CloseDescriptor(&credential_directory_fd);
    value.fill(0);
    return FailAccountlessRecovery(env, lease);
  }
  if (before != AccountlessRecordState::kAbsent) {
    CloseDescriptor(&credential_directory_fd);
    value.fill(0);
    return FailAccountlessKnownNonMutation(env, lease);
  }

  // The exact v2 intent is durable before the first O_EXCL temporary inode can
  // appear. It authorizes only this candidate's later replay under slot four.
  if (!BeginAccountlessMutation(lease, AccountlessOperation::kCreate, value)) {
    CloseDescriptor(&credential_directory_fd);
    value.fill(0);
    return FailAccountlessRecovery(env, lease);
  }
  const bool published = PublishNewAccountlessRecord(
      credential_directory_fd,
      kAccountlessCreateTemporaryFile,
      value);
  const bool directory_closed = CloseDescriptor(&credential_directory_fd);
  value.fill(0);
  if (!published || !directory_closed) {
    return FailAccountlessPendingOperation(env, lease);
  }
  // Allocate the JavaScript result before clearing the intent. A failed
  // allocation leaves that exact v2 record available for restart replay.
  napi_value result = AccountlessStatus(env, "created");
  if (result == nullptr) {
    napi_value ignored = nullptr;
    napi_get_and_clear_last_exception(env, &ignored);
    return FailAccountlessPendingOperation(env, lease);
  }
  if (SettleAccountlessMutation(lease)
      != AccountlessOperationJournalRemoveOutcome::kRemoved) {
    return FailAccountlessPendingOperation(env, lease);
  }
  if (!FinishAccountlessLease(lease, false)) {
    return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
  }
  return result;
}

napi_value DeleteAccountlessInstallationCredentialExact(
    napi_env env,
    napi_callback_info info) {
  std::array<unsigned char, kAccountlessCredentialBytes> expected {};
  if (!AccountlessCredentialArgument(env, info, &expected)) {
    expected.fill(0);
    return ThrowFixed(env, kCodeAccountlessInvalidValue);
  }
  NativeLease* lease = nullptr;
  const AccountlessLeaseOutcome acquired = AcquireAccountlessLease(&lease);
  if (acquired != AccountlessLeaseOutcome::kAcquired) {
    expected.fill(0);
    return ThrowFixed(
        env,
        acquired == AccountlessLeaseOutcome::kRecoveryRequired
            ? kCodeAccountlessRecoveryRequired
            : kCodeAccountlessUnavailable);
  }
  int credential_directory_fd = OpenAccountlessCredentialDirectory();
  if (credential_directory_fd < 0) {
    expected.fill(0);
    return FailAccountlessKnownNonMutation(env, lease);
  }

  AccountlessRecord current {};
  const AccountlessRecordState before = ReadAccountlessRecord(
      credential_directory_fd,
      &current);
  if (before == AccountlessRecordState::kAbsent) {
    ClearAccountlessRecord(&current);
    const bool directory_closed = CloseDescriptor(&credential_directory_fd);
    expected.fill(0);
    if (!directory_closed) return FailAccountlessRecovery(env, lease);
    if (!FinishAccountlessLease(lease, false)) {
      return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
    }
    return AccountlessStatus(env, "missing");
  }
  if (before != AccountlessRecordState::kPresent) {
    ClearAccountlessRecord(&current);
    CloseDescriptor(&credential_directory_fd);
    expected.fill(0);
    return before == AccountlessRecordState::kInvalid
        ? FailAccountlessRecovery(env, lease)
        : FailAccountlessKnownNonMutation(env, lease);
  }
  if (!EqualAccountlessCredential(current.bytes, expected)) {
    ClearAccountlessRecord(&current);
    const bool directory_closed = CloseDescriptor(&credential_directory_fd);
    expected.fill(0);
    if (!directory_closed) return FailAccountlessRecovery(env, lease);
    if (!FinishAccountlessLease(lease, false)) {
      return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
    }
    return AccountlessStatus(env, "mismatch");
  }
  ClearAccountlessRecord(&current);
  if (!BeginAccountlessMutation(lease, AccountlessOperation::kDelete, expected)) {
    CloseDescriptor(&credential_directory_fd);
    expected.fill(0);
    return FailAccountlessRecovery(env, lease);
  }
  const bool deleted = DeleteCurrentAccountlessRecord(
      credential_directory_fd,
      kAccountlessDeleteTemporaryFile,
      expected);
  const bool directory_closed = CloseDescriptor(&credential_directory_fd);
  expected.fill(0);
  if (!deleted || !directory_closed) {
    return FailAccountlessPendingOperation(env, lease);
  }
  // As with create, retain the exact delete intent until its result object
  // exists and the postcondition is durable.
  napi_value result = AccountlessStatus(env, "deleted");
  if (result == nullptr) {
    napi_value ignored = nullptr;
    napi_get_and_clear_last_exception(env, &ignored);
    return FailAccountlessPendingOperation(env, lease);
  }
  if (SettleAccountlessMutation(lease)
      != AccountlessOperationJournalRemoveOutcome::kRemoved) {
    return FailAccountlessPendingOperation(env, lease);
  }
  if (!FinishAccountlessLease(lease, false)) {
    return ThrowFixed(env, kCodeAccountlessRecoveryRequired);
  }
  return result;
}

bool DefineMethod(
    napi_env env,
    napi_value exports,
    const char* name,
    napi_callback callback) {
  napi_value value = nullptr;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &value) == napi_ok
      && napi_set_named_property(env, exports, name, value) == napi_ok;
}

bool DefineString(
    napi_env env,
    napi_value exports,
    const char* name,
    const char* value) {
  napi_value property = nullptr;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &property) == napi_ok
      && napi_set_named_property(env, exports, name, property) == napi_ok;
}

bool DefineBoolean(napi_env env, napi_value exports, const char* name, bool value) {
  napi_value property = nullptr;
  return napi_get_boolean(env, value, &property) == napi_ok
      && napi_set_named_property(env, exports, name, property) == napi_ok;
}

napi_value Initialize(napi_env env, napi_value exports) {
  if (!DefineMethod(env, exports, "prepareLinuxCredentialState", PrepareLinuxCredentialState)
      || !DefineMethod(env, exports, "acquireCredentialMutex", AcquireCredentialMutex)
      || !DefineMethod(env, exports, "releaseCredentialMutex", ReleaseCredentialMutex)
      || !DefineMethod(env, exports, "abandonCredentialMutex", AbandonCredentialMutex)
      || !DefineMethod(
          env,
          exports,
          "readAccountlessInstallationCredential",
          ReadAccountlessInstallationCredential)
      || !DefineMethod(
          env,
          exports,
          "createAccountlessInstallationCredentialIfMissing",
          CreateAccountlessInstallationCredentialIfMissing)
      || !DefineMethod(
          env,
          exports,
          "deleteAccountlessInstallationCredentialExact",
          DeleteAccountlessInstallationCredentialExact)
      || !DefineMethod(
          env,
          exports,
          "readAccountObservationCredential",
          ReadAccountObservationCredential)
      || !DefineMethod(
          env,
          exports,
          "createAccountObservationCredentialIfMissing",
          CreateAccountObservationCredentialIfMissing)
      || !DefineString(
          env,
          exports,
          "credentialMutexContractVersion",
          "linux-credential-mutex-v1")
      || !DefineBoolean(env, exports, "credentialMutexCrossProcessSafe", true)
      || !DefineBoolean(env, exports, "credentialMutexSameNetworkNamespaceOnly", true)
      || !DefineBoolean(env, exports, "credentialMutexDurableMarker", true)
      || !DefineBoolean(env, exports, "productionSafe", false)) {
    napi_throw_error(env, nullptr, "Linux credential mutex initialization failed");
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
