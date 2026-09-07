#include <node_api.h>

#if defined(LINUX_CREDENTIAL_MUTEX_UNSUPPORTED_TARGET)
#error "linux_credential_mutex requires Linux x86_64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <pwd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <array>
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
constexpr char kApplicationDirectory[] = "app-usagemonitor";
constexpr char kMutexDirectory[] = "linux-credential-mutex-v1";
constexpr char kSocketNamespace[] = "app-usagemonitor/linux-credential-mutex-v1";
constexpr char kJournalActiveText[] = "linux-credential-mutex-journal-v1:active\n";
constexpr char kJournalNormalText[] = "linux-credential-mutex-journal-v1:normal\n";
constexpr std::size_t kMaximumPathBytes = 4096;
constexpr std::size_t kMaximumPasswordRecordBytes = 1024 * 1024;

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

struct FileIdentity {
  dev_t device = 0;
  ino_t inode = 0;
};

struct NativeLease {
  int socket_fd = -1;
  int persistent_state_fd = -1;
  int journal_fd = -1;
  FileIdentity journal_identity {};
  int capability_id = -1;
  bool abandoned = false;
  bool active = true;
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

std::mutex g_issued_leases_mutex;
std::unordered_set<NativeLease*> g_issued_leases;

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

int OpenNoSymlinkDirectory(const std::string& path) {
  if (!IsNormalizedAbsolutePath(path.c_str())) return -1;
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

int EnsurePrivateDirectoryAt(int parent_fd, const char* child, bool durable) {
  bool created = false;
  if (mkdirat(parent_fd, child, 0700) == 0) {
    created = true;
  } else if (errno != EEXIST) {
    return -1;
  }
  const int fd = OpenVerifiedDirectoryAt(parent_fd, child, true);
  if (fd < 0) return -1;
  if (created && durable && fsync(parent_fd) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

bool StateBaseDirectory(std::string* result) {
  const char* configured = getenv("XDG_STATE_HOME");
  if (configured != nullptr) {
    if (!IsNormalizedAbsolutePath(configured)) return false;
    *result = configured;
    return true;
  }

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
  const std::string candidate = std::string(record.pw_dir) + "/.local/state";
  if (!IsNormalizedAbsolutePath(candidate.c_str())) return false;
  *result = candidate;
  return true;
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

bool CapabilityFileName(int capability_id, const char* prefix, char* output, std::size_t length) {
  if (!IsCapabilityId(capability_id) || length < 32) return false;
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

bool AcquireKernelLeaseSocket(int capability_id, int* socket_fd, bool* contended) {
  if (socket_fd == nullptr || contended == nullptr || !IsCapabilityId(capability_id)) {
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

  auto* lease = new (std::nothrow) NativeLease {
    socket_fd,
    persistent_state_fd,
    journal_fd,
    journal_identity,
    capability_id,
    prior == JournalState::kActive,
    true,
  };
  if (lease == nullptr) {
    CloseUnissuedLeaseDescriptors(
        &socket_fd,
        &persistent_state_fd,
        &journal_fd);
    return ThrowFixed(env, kCodeStateUnavailable);
  }
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
  if (!DefineMethod(env, exports, "acquireCredentialMutex", AcquireCredentialMutex)
      || !DefineMethod(env, exports, "releaseCredentialMutex", ReleaseCredentialMutex)
      || !DefineMethod(env, exports, "abandonCredentialMutex", AbandonCredentialMutex)
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
