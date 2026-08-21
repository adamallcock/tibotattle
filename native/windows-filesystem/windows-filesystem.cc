#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <fileapi.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <array>
#include <cctype>
#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
#include <chrono>
#include <condition_variable>
#include <thread>
#endif
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cwchar>
#include <cwctype>
#include <iomanip>
#include <limits>
#include <mutex>
#include <new>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::size_t kMaximumFileBytes = 1024 * 1024;
// Prepared contribution payloads are bounded by the public contribution
// contract. Review/encoded artifacts use the existing 34 MiB resource ceiling.
// Both operations stream through a fixed 1 MiB native buffer; the N-API
// boundary still applies the total ceiling before allocation or publication.
constexpr std::size_t kMaximumPreparedContributionBytes = 1'310'720;
constexpr std::size_t kMaximumPreparedArtifactBytes = 34 * 1024 * 1024;
constexpr std::size_t kMaximumPreparedDirectoryEntries = 256;
constexpr std::size_t kPreparedChunkBytes = 1 << 20;
static_assert(
    kMaximumPreparedContributionBytes <= kMaximumPreparedArtifactBytes,
    "contribution ceiling must fit the prepared artifact ceiling");

// The Win32 CreateFile API has no root-directory parameter.  Calling it once
// for every component, even with FILE_FLAG_OPEN_REPARSE_POINT, leaves a
// window in which an ancestor can be renamed or replaced between the
// validation pass and the final open.  The native NT API does expose the
// root-directory handle, so the sensitive path walk below uses these small
// private declarations instead of relying on SDK-specific winternl.h
// prototypes.  The layouts are the documented x64/x86 ABI layouts and are
// intentionally kept local to this binding.
using NativeNtStatus = LONG;

struct NativeUnicodeString {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
};

struct NativeObjectAttributes {
  ULONG Length;
  HANDLE RootDirectory;
  NativeUnicodeString* ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
};

struct NativeIoStatusBlock {
  union {
    NativeNtStatus Status;
    PVOID Pointer;
  };
  ULONG_PTR Information;
};

using NativeNtCreateFile = NativeNtStatus (NTAPI *)(
    PHANDLE,
    ACCESS_MASK,
    NativeObjectAttributes*,
    NativeIoStatusBlock*,
    PLARGE_INTEGER,
    ULONG,
    ULONG,
    ULONG,
    ULONG,
    PVOID,
    ULONG);

using NativeNtSetInformationFile = NativeNtStatus (NTAPI *)(
    HANDLE,
    NativeIoStatusBlock*,
    PVOID,
    ULONG,
    ULONG);

using NativeRtlNtStatusToDosError = ULONG (WINAPI *)(NativeNtStatus);

constexpr ULONG kObjCaseInsensitive = 0x00000040;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
// FileRenameInformation is the legacy rename operation.  It has no
// conditional/handle-preserving replacement mode, so replacement uses the
// FileRenameInformationEx class available starting with Windows 10 1709.
constexpr ULONG kFileRenameInformation = 10;
constexpr ULONG kFileRenameInformationEx = 65;
constexpr ULONG kFileRenameReplaceIfExists = 0x00000001;
constexpr ULONG kFileRenamePosixSemantics = 0x00000002;
static_assert(kFileRenameInformation == 10, "legacy rename class value");
static_assert(kFileRenameInformationEx == 65, "extended rename class value");
constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileCreate = 2;
constexpr ULONG_PTR kFileOpened = 1;
constexpr ULONG_PTR kFileCreated = 2;
constexpr DWORD kDirectoryTraversalAccess = FILE_LIST_DIRECTORY
    | FILE_TRAVERSE
    | FILE_READ_ATTRIBUTES
    | READ_CONTROL
    | SYNCHRONIZE;
constexpr DWORD kDirectoryShareMode = FILE_SHARE_READ
    | FILE_SHARE_WRITE
    | FILE_SHARE_DELETE;
constexpr DWORD kCredentialMutexAccess = READ_CONTROL
    | SYNCHRONIZE
    | MUTEX_MODIFY_STATE;
constexpr NativeNtStatus kStatusObjectNameNotFound = static_cast<NativeNtStatus>(0xC0000034L);
constexpr NativeNtStatus kStatusObjectPathNotFound = static_cast<NativeNtStatus>(0xC000003AL);
constexpr NativeNtStatus kStatusObjectNameCollision = static_cast<NativeNtStatus>(0xC0000035L);
constexpr NativeNtStatus kStatusAccessDenied = static_cast<NativeNtStatus>(0xC0000022L);
constexpr NativeNtStatus kStatusSharingViolation = static_cast<NativeNtStatus>(0xC0000043L);
constexpr NativeNtStatus kStatusNotADirectory = static_cast<NativeNtStatus>(0xC0000103L);
constexpr NativeNtStatus kStatusObjectTypeMismatch = static_cast<NativeNtStatus>(0xC0000024L);
constexpr NativeNtStatus kStatusReparsePointEncountered = static_cast<NativeNtStatus>(0xC000050BL);

NativeNtCreateFile ResolveNtCreateFile() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return ntdll == nullptr
      ? nullptr
      : reinterpret_cast<NativeNtCreateFile>(GetProcAddress(ntdll, "NtCreateFile"));
}

NativeNtSetInformationFile ResolveNtSetInformationFile() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return ntdll == nullptr
      ? nullptr
      : reinterpret_cast<NativeNtSetInformationFile>(
          GetProcAddress(ntdll, "NtSetInformationFile"));
}

DWORD NativeStatusToWin32(NativeNtStatus status) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll != nullptr) {
    const auto convert = reinterpret_cast<NativeRtlNtStatusToDosError>(
        GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (convert != nullptr) {
      const ULONG result = convert(status);
      if (result != ERROR_MR_MID_NOT_FOUND) return result;
    }
  }
  switch (status) {
    case kStatusObjectNameNotFound:
    case kStatusObjectPathNotFound:
      return ERROR_FILE_NOT_FOUND;
    case kStatusObjectNameCollision:
      return ERROR_FILE_EXISTS;
    case kStatusAccessDenied:
      return ERROR_ACCESS_DENIED;
    case kStatusSharingViolation:
      return ERROR_SHARING_VIOLATION;
    case kStatusNotADirectory:
    case kStatusObjectTypeMismatch:
      return ERROR_DIRECTORY;
    case kStatusReparsePointEncountered:
      return ERROR_CANT_ACCESS_FILE;
    default:
      return ERROR_GEN_FAILURE;
  }
}

struct Failure {
  const char* code;
  const char* detail = nullptr;
  const char* stage = nullptr;
};

Failure InvalidConfiguration() { return {"INVALID_CONFIGURATION"}; }
Failure InvalidPath() { return {"INVALID_PATH"}; }
Failure NotFound() { return {"NOT_FOUND"}; }
Failure AlreadyExists() { return {"ALREADY_EXISTS"}; }
Failure AccessDenied() { return {"ACCESS_DENIED"}; }
Failure ReparsePoint() { return {"REPARSE_POINT"}; }
Failure HardLink() { return {"HARD_LINK"}; }
Failure SecurityPolicy(const char* detail = "unspecified") {
  return {"SECURITY_POLICY", detail};
}
Failure NotDirectory() { return {"NOT_DIRECTORY"}; }
Failure NotRegularFile() { return {"NOT_REGULAR_FILE"}; }
Failure TooLarge() { return {"FILE_TOO_LARGE"}; }
Failure PreparedDirectoryLimit() { return {"PREPARED_DIRECTORY_LIMIT"}; }
Failure PreparedDirectoryNotEmpty() { return {"PREPARED_DIRECTORY_NOT_EMPTY"}; }
Failure FileSizeChanged() { return {"FILE_SIZE_CHANGED"}; }
Failure IdentityMismatch() { return {"IDENTITY_MISMATCH"}; }
Failure OperationFailed() { return {"OPERATION_FAILED"}; }
Failure CredentialMutexInvalidCapability() { return {"CREDENTIAL_MUTEX_INVALID_CAPABILITY"}; }
Failure CredentialMutexContended() { return {"CREDENTIAL_MUTEX_CONTENDED"}; }
Failure CredentialMutexAbandoned() { return {"CREDENTIAL_MUTEX_ABANDONED"}; }
Failure CredentialMutexReleaseFailed() { return {"CREDENTIAL_MUTEX_RELEASE_FAILED"}; }
Failure CredentialMutexForeign() { return {"CREDENTIAL_MUTEX_FOREIGN"}; }
Failure CompanionInstanceMutexContended() {
  return {"COMPANION_INSTANCE_MUTEX_CONTENDED"};
}
Failure CompanionInstanceMutexReleaseFailed() {
  return {"COMPANION_INSTANCE_MUTEX_RELEASE_FAILED"};
}
Failure CompanionInstanceMutexForeign() {
  return {"COMPANION_INSTANCE_MUTEX_FOREIGN"};
}
Failure CredentialAuditGuardReleaseFailed() {
  return {"CREDENTIAL_AUDIT_GUARD_RELEASE_FAILED"};
}
Failure CredentialAuditGuardForeign() { return {"CREDENTIAL_AUDIT_GUARD_FOREIGN"}; }
Failure SqliteStateLeaseContended() { return {"SQLITE_STATE_LEASE_CONTENDED"}; }
Failure SqliteStateLeaseAbandoned() { return {"SQLITE_STATE_LEASE_ABANDONED"}; }
Failure SqliteStateLeaseSidecarPresent() {
  return {"SQLITE_STATE_LEASE_SIDECAR_PRESENT"};
}
Failure SqliteStateLeaseForeign() { return {"SQLITE_STATE_LEASE_FOREIGN"}; }
Failure SqliteStateLeaseReleaseFailed() {
  return {"SQLITE_STATE_LEASE_RELEASE_FAILED"};
}
Failure SqliteStateStagingUnavailable() {
  return {"SQLITE_STATE_STAGING_UNAVAILABLE"};
}
#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
Failure QualificationPauseAlreadyArmed() {
  return {"QUALIFICATION_PAUSE_ALREADY_ARMED"};
}
#endif

bool IsNotFoundError(DWORD error) {
  return error == ERROR_FILE_NOT_FOUND
      || error == ERROR_PATH_NOT_FOUND
      || error == ERROR_INVALID_DRIVE;
}

Failure FromLastError(DWORD error = GetLastError()) {
  if (IsNotFoundError(error)) return NotFound();
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
    return AlreadyExists();
  }
  if (error == ERROR_ACCESS_DENIED
      || error == ERROR_SHARING_VIOLATION
      || error == ERROR_LOCK_VIOLATION
      || error == ERROR_WRITE_PROTECT) {
    return AccessDenied();
  }
  if (error == ERROR_DIRECTORY) return NotDirectory();
  if (error == ERROR_CANT_ACCESS_FILE) return ReparsePoint();
  return OperationFailed();
}

napi_value ThrowFailure(napi_env env, Failure failure) {
  napi_value message;
  napi_value error;
  napi_value code;
  napi_create_string_utf8(env, "Windows filesystem operation failed", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &error);
  std::string publicCode = "WINDOWS_FILESYSTEM_";
  publicCode.append(failure.code);
  napi_create_string_utf8(env, publicCode.c_str(), NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  if (failure.detail != nullptr) {
    napi_value detail;
    napi_create_string_utf8(env, failure.detail, NAPI_AUTO_LENGTH, &detail);
    napi_set_named_property(env, error, "securityPolicyReason", detail);
  }
  if (failure.stage != nullptr) {
    napi_value stage;
    napi_create_string_utf8(env, failure.stage, NAPI_AUTO_LENGTH, &stage);
    napi_set_named_property(env, error, "windowsFilesystemStage", stage);
  }
  napi_throw(env, error);
  return nullptr;
}

bool GetString(napi_env env, napi_value value, std::wstring* result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  std::size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char16_t> buffer(length + 1, 0);
  if (napi_get_value_string_utf16(
          env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  result->assign(reinterpret_cast<const wchar_t*>(buffer.data()), length);
  return true;
}

bool GetBuffer(napi_env env, napi_value value, const std::uint8_t** bytes, std::size_t* length) {
  bool isBuffer = false;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) return false;
  void* data = nullptr;
  if (napi_get_buffer_info(env, value, &data, length) != napi_ok) return false;
  *bytes = static_cast<const std::uint8_t*>(data);
  return true;
}

bool GetUint32(napi_env env, napi_value value, std::uint32_t* result) {
  std::uint32_t candidate = 0;
  if (napi_get_value_uint32(env, value, &candidate) != napi_ok) return false;
  *result = candidate;
  return true;
}

// A caller-supplied read ceiling is checked before the file-sized vector is
// materialized.  Keep this separate from GetUint32: N-API's integer helper
// accepts coercions that are not a safe, explicit byte ceiling.
bool GetSafeReadMaximum(napi_env env, napi_value value, std::size_t* result) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double candidate = 0;
  if (napi_get_value_double(env, value, &candidate) != napi_ok
      || !std::isfinite(candidate)
      || candidate < 0
      || std::floor(candidate) != candidate
      || candidate > static_cast<double>(kMaximumFileBytes)) {
    return false;
  }
  *result = static_cast<std::size_t>(candidate);
  return true;
}

bool GetSafePreparedMaximum(napi_env env, napi_value value, std::size_t* result) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double candidate = 0;
  if (napi_get_value_double(env, value, &candidate) != napi_ok
      || !std::isfinite(candidate)
      || candidate < 1
      || std::floor(candidate) != candidate
      || candidate > static_cast<double>(kMaximumPreparedArtifactBytes)) {
    return false;
  }
  *result = static_cast<std::size_t>(candidate);
  return true;
}

bool GetSafePreparedDirectoryMaximum(
    napi_env env,
    napi_value value,
    std::size_t* result) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double candidate = 0;
  if (napi_get_value_double(env, value, &candidate) != napi_ok
      || !std::isfinite(candidate)
      || candidate < 1
      || std::floor(candidate) != candidate
      || candidate > static_cast<double>(kMaximumPreparedDirectoryEntries)) {
    return false;
  }
  *result = static_cast<std::size_t>(candidate);
  return true;
}

bool GetNamedString(napi_env env, napi_value object, const char* name, std::string* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok || !present) return false;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1, 0);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  result->assign(buffer.data(), length);
  return true;
}

bool GetNamedUint32(napi_env env, napi_value object, const char* name, std::uint32_t* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok || !present) return false;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  return GetUint32(env, value, result);
}

struct ParsedPath {
  std::wstring root;
  std::vector<std::wstring> components;
};

bool IsDriveLetter(wchar_t value) {
  return (value >= L'A' && value <= L'Z') || (value >= L'a' && value <= L'z');
}

bool EqualInsensitive(const std::wstring& left, const wchar_t* right) {
  if (left.size() != std::wcslen(right)) return false;
  for (std::size_t i = 0; i < left.size(); ++i) {
    if (std::towlower(left[i]) != std::towlower(right[i])) return false;
  }
  return true;
}

bool EqualInsensitive(const std::wstring& left, const std::wstring& right) {
  if (left.size() != right.size()) return false;
  for (std::size_t index = 0; index < left.size(); ++index) {
    if (std::towlower(left[index]) != std::towlower(right[index])) return false;
  }
  return true;
}

bool IsReservedDeviceName(const std::wstring& component) {
  std::wstring base = component;
  const std::size_t dot = base.find(L'.');
  if (dot != std::wstring::npos) base.resize(dot);
  return EqualInsensitive(base, L"CON")
      || EqualInsensitive(base, L"PRN")
      || EqualInsensitive(base, L"AUX")
      || EqualInsensitive(base, L"NUL")
      || EqualInsensitive(base, L"COM1")
      || EqualInsensitive(base, L"COM2")
      || EqualInsensitive(base, L"COM3")
      || EqualInsensitive(base, L"COM4")
      || EqualInsensitive(base, L"COM5")
      || EqualInsensitive(base, L"COM6")
      || EqualInsensitive(base, L"COM7")
      || EqualInsensitive(base, L"COM8")
      || EqualInsensitive(base, L"COM9")
      || EqualInsensitive(base, L"LPT1")
      || EqualInsensitive(base, L"LPT2")
      || EqualInsensitive(base, L"LPT3")
      || EqualInsensitive(base, L"LPT4")
      || EqualInsensitive(base, L"LPT5")
      || EqualInsensitive(base, L"LPT6")
      || EqualInsensitive(base, L"LPT7")
      || EqualInsensitive(base, L"LPT8")
      || EqualInsensitive(base, L"LPT9");
}

bool ParsePath(const std::wstring& supplied, ParsedPath* result) {
  if (supplied.empty() || supplied.find(L'\0') != std::wstring::npos) return false;
  std::wstring path = supplied;
  std::replace(path.begin(), path.end(), L'/', L'\\');

  std::size_t offset = 0;
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0
      || (path.rfind(L"\\\\", 0) == 0 && path.rfind(L"\\\\?\\", 0) != 0)) {
    // Network and device locations are not a private local state root. They
    // fail closed instead of silently accepting a different trust boundary.
    return false;
  }
  if (path.rfind(L"\\\\?\\", 0) == 0) {
    if (path.size() < 7 || !IsDriveLetter(path[4]) || path[5] != L':' || path[6] != L'\\') {
      return false;
    }
    result->root = path.substr(0, 7);
    offset = 7;
  } else {
    if (path.size() < 3 || !IsDriveLetter(path[0]) || path[1] != L':' || path[2] != L'\\') {
      return false;
    }
    result->root = path.substr(0, 3);
    offset = 3;
  }

  while (offset < path.size()) {
    while (offset < path.size() && path[offset] == L'\\') ++offset;
    if (offset >= path.size()) break;
    const std::size_t start = offset;
    while (offset < path.size() && path[offset] != L'\\') ++offset;
    std::wstring component = path.substr(start, offset - start);
    if (component.empty() || component == L"." || component == L".."
        || component.back() == L'.' || component.back() == L' '
        || IsReservedDeviceName(component)
        || component.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
      return false;
    }
    result->components.push_back(std::move(component));
  }
  return !result->components.empty();
}

bool ParseRelativeComponents(
    const std::wstring& supplied,
    std::vector<std::wstring>* components) {
  if (supplied.empty()
      || supplied.size() > static_cast<std::size_t>(USHRT_MAX / sizeof(wchar_t))
      || supplied.find(L'\0') != std::wstring::npos) {
    return false;
  }
  std::wstring path = supplied;
  std::replace(path.begin(), path.end(), L'/', L'\\');
  if (path.front() == L'\\'
      || (path.size() >= 2 && IsDriveLetter(path[0]) && path[1] == L':')) {
    return false;
  }
  std::size_t offset = 0;
  while (offset < path.size()) {
    const std::size_t start = offset;
    while (offset < path.size() && path[offset] != L'\\') ++offset;
    const std::wstring component = path.substr(start, offset - start);
    if (component.empty()
        || component == L"."
        || component == L".."
        || component.back() == L'.'
        || component.back() == L' '
        || IsReservedDeviceName(component)
        || component.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
      return false;
    }
    components->push_back(component);
    while (offset < path.size() && path[offset] == L'\\') {
      ++offset;
      if (offset == path.size() || path[offset] == L'\\') return false;
    }
  }
  return !components->empty();
}

std::wstring JoinComponent(const std::wstring& parent, const std::wstring& component) {
  if (!parent.empty() && parent.back() == L'\\') return parent + component;
  return parent + L"\\" + component;
}

bool GetFileAttributesFromHandle(HANDLE handle, DWORD* attributes) {
  FILE_BASIC_INFO basic{};
  if (GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) {
    *attributes = static_cast<DWORD>(basic.FileAttributes);
    return true;
  }
  BY_HANDLE_FILE_INFORMATION legacy{};
  if (!GetFileInformationByHandle(handle, &legacy)) return false;
  *attributes = legacy.dwFileAttributes;
  return true;
}

struct HandleIdentity {
  std::uint64_t volumeSerialNumber = 0;
  std::array<BYTE, 16> fileId{};
  std::uint32_t linkCount = 0;
  bool directory = false;
};

bool GetIdentity(HANDLE handle, HandleIdentity* identity) {
  FILE_ID_INFO fileId{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &fileId, sizeof(fileId))) return false;
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))) return false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)) return false;
  identity->volumeSerialNumber = fileId.VolumeSerialNumber;
  std::memcpy(identity->fileId.data(), fileId.FileId.Identifier, identity->fileId.size());
  identity->linkCount = standard.NumberOfLinks;
  identity->directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return true;
}

std::string HexIdentity(const HandleIdentity& identity) {
  std::ostringstream stream;
  stream << std::hex << std::setfill('0');
  for (BYTE byte : identity.fileId) stream << std::setw(2) << static_cast<unsigned int>(byte);
  return stream.str();
}

bool EqualIdentity(const HandleIdentity& left, const HandleIdentity& right) {
  return left.volumeSerialNumber == right.volumeSerialNumber
      && std::equal(left.fileId.begin(), left.fileId.end(), right.fileId.begin());
}

bool GetCurrentUserSid(std::vector<BYTE>* sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size == 0) {
    CloseHandle(token);
    return false;
  }
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
    CloseHandle(token);
    return false;
  }
  const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  const DWORD sidLength = GetLengthSid(user->User.Sid);
  const auto* sidBytes = static_cast<const BYTE*>(user->User.Sid);
  sid->assign(sidBytes, sidBytes + sidLength);
  CloseHandle(token);
  return true;
}

bool IsSidEqual(PSID left, PSID right) {
  return left != nullptr && right != nullptr && IsValidSid(left) && IsValidSid(right)
      && EqualSid(left, right) != FALSE;
}

bool IsBroadSid(PSID sid) {
  BYTE worldBuffer[SECURITY_MAX_SID_SIZE];
  DWORD worldSize = sizeof(worldBuffer);
  if (CreateWellKnownSid(WinWorldSid, nullptr, worldBuffer, &worldSize)
      && IsSidEqual(sid, worldBuffer)) return true;
  BYTE authBuffer[SECURITY_MAX_SID_SIZE];
  DWORD authSize = sizeof(authBuffer);
  if (CreateWellKnownSid(WinAuthenticatedUserSid, nullptr, authBuffer, &authSize)
      && IsSidEqual(sid, authBuffer)) return true;
  BYTE usersBuffer[SECURITY_MAX_SID_SIZE];
  DWORD usersSize = sizeof(usersBuffer);
  if (CreateWellKnownSid(WinBuiltinUsersSid, nullptr, usersBuffer, &usersSize)
      && IsSidEqual(sid, usersBuffer)) return true;
  return false;
}

struct SecuritySnapshot {
  bool ownerMatches = false;
  bool nullDacl = true;
  bool daclProtected = false;
  bool broadAccess = false;
  bool nonOwnerAllow = false;
  bool unrecognizedAce = false;
  bool denyAce = false;
  DWORD ownerAllowAceCount = 0;
  DWORD ownerAllowMask = 0;
};

bool ReadObjectSecurity(
    HANDLE handle,
    SE_OBJECT_TYPE objectType,
    SecuritySnapshot* snapshot) {
  std::vector<BYTE> currentSid;
  if (!GetCurrentUserSid(&currentSid)) return false;
  PSID ownerSid = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(
      handle,
      objectType,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &ownerSid,
      nullptr,
      &dacl,
      nullptr,
      &descriptor);
  if (result != ERROR_SUCCESS) return false;

  snapshot->ownerMatches = IsSidEqual(ownerSid, currentSid.data());
  snapshot->nullDacl = dacl == nullptr;
  SECURITY_DESCRIPTOR_CONTROL descriptorControl = 0;
  DWORD descriptorRevision = 0;
  if (!GetSecurityDescriptorControl(
          descriptor,
          &descriptorControl,
          &descriptorRevision)) {
    LocalFree(descriptor);
    return false;
  }
  snapshot->daclProtected = (descriptorControl & SE_DACL_PROTECTED) != 0;
  if (dacl != nullptr) {
    ACL_SIZE_INFORMATION size{};
    if (!GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation)) {
      LocalFree(descriptor);
      return false;
    }
    for (DWORD index = 0; index < size.AceCount; ++index) {
      void* rawAce = nullptr;
      if (!GetAce(dacl, index, &rawAce)) {
        LocalFree(descriptor);
        return false;
      }
      const ACE_HEADER* header = static_cast<const ACE_HEADER*>(rawAce);
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE
          && header->AceType != ACCESS_ALLOWED_OBJECT_ACE_TYPE
          && header->AceType != ACCESS_DENIED_ACE_TYPE
          && header->AceType != ACCESS_DENIED_OBJECT_ACE_TYPE) {
        snapshot->unrecognizedAce = true;
        continue;
      }
      if (header->AceType == ACCESS_DENIED_ACE_TYPE
          || header->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE) {
        snapshot->denyAce = true;
        continue;
      }
      PSID aceSid = nullptr;
      DWORD sidOffset = 0;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        sidOffset = FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
        if (header->AceSize < sidOffset + 8) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        auto* allowedAce = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        aceSid = static_cast<PSID>(&allowedAce->SidStart);
      } else {
        const auto* objectAce = static_cast<const ACCESS_ALLOWED_OBJECT_ACE*>(rawAce);
        if (header->AceSize
            < FIELD_OFFSET(ACCESS_ALLOWED_OBJECT_ACE, Flags) + sizeof(objectAce->Flags)) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        // The SID begins at ObjectType's offset when no GUID is present; the
        // structure's SidStart placeholder is not a safe base for variable
        // length object ACEs.
        sidOffset = FIELD_OFFSET(ACCESS_ALLOWED_OBJECT_ACE, ObjectType);
        if ((objectAce->Flags & ACE_OBJECT_TYPE_PRESENT) != 0) sidOffset += sizeof(GUID);
        if ((objectAce->Flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) != 0) sidOffset += sizeof(GUID);
        if (header->AceSize < sidOffset + 8) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        aceSid = reinterpret_cast<PSID>(reinterpret_cast<BYTE*>(rawAce) + sidOffset);
      }
      if (!IsValidSid(aceSid)
          || sidOffset > header->AceSize
          || GetLengthSid(aceSid) > header->AceSize - sidOffset) {
        snapshot->unrecognizedAce = true;
        continue;
      }
      if (IsBroadSid(aceSid)) snapshot->broadAccess = true;
      if (!IsSidEqual(aceSid, currentSid.data())) {
        snapshot->nonOwnerAllow = true;
      } else if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const auto* allowedAce = static_cast<const ACCESS_ALLOWED_ACE*>(rawAce);
        snapshot->ownerAllowAceCount += 1;
        snapshot->ownerAllowMask |= allowedAce->Mask;
      }
    }
  }
  LocalFree(descriptor);
  return true;
}

bool ReadSecurity(HANDLE handle, SecuritySnapshot* snapshot) {
  return ReadObjectSecurity(handle, SE_FILE_OBJECT, snapshot);
}

bool IsOwnerOnlySecurity(const SecuritySnapshot& descriptor) {
  return descriptor.ownerMatches
      && !descriptor.nullDacl
      && descriptor.daclProtected
      && !descriptor.broadAccess
      && !descriptor.nonOwnerAllow
      && !descriptor.unrecognizedAce
      && !descriptor.denyAce
      && descriptor.ownerAllowAceCount == 1
      && descriptor.ownerAllowMask == kCredentialMutexAccess;
}

bool HasReparsePoint(HANDLE handle, bool* result) {
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)) return false;
  *result = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return true;
}

std::wstring ExpectedPath(const ParsedPath& parsed) {
  std::wstring result = parsed.root;
  for (const auto& component : parsed.components) result = JoinComponent(result, component);
  return result;
}

bool IsLocalDrivePath(const std::wstring& path) {
  return path.size() >= 3
      && IsDriveLetter(path[0])
      && path[1] == L':'
      && path[2] == L'\\';
}

bool IsExtendedLocalDrivePath(const std::wstring& path) {
  return path.size() >= 7
      && path.rfind(L"\\\\?\\", 0) == 0
      && IsDriveLetter(path[4])
      && path[5] == L':'
      && path[6] == L'\\';
}

std::wstring ExtendedLocalDrivePath(const std::wstring& path) {
  if (IsExtendedLocalDrivePath(path)) return path;
  if (IsLocalDrivePath(path)) return L"\\\\?\\" + path;
  // Canonicalization must never turn a network or device path into an
  // accepted state path. ParsePath currently rejects those forms too, but
  // keep this helper closed over local drive paths as an independent guard.
  return {};
}

std::wstring ComparablePath(std::wstring value) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  if (value.rfind(L"\\\\?\\", 0) == 0) value.erase(0, 4);
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return std::towlower(character);
  });
  return value;
}

std::wstring CanonicalExpectedPath(const ParsedPath& parsed) {
  const std::wstring expected = ExpectedPath(parsed);
  const std::wstring lookup = ExtendedLocalDrivePath(expected);
  if (lookup.empty()) return {};
  DWORD size = MAX_PATH;
  for (int attempt = 0; attempt < 8; ++attempt) {
    std::vector<wchar_t> buffer(size, L'\0');
    const DWORD length = GetLongPathNameW(
        lookup.c_str(),
        buffer.data(),
        static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    // GetLongPathNameW returns the required length when the supplied buffer
    // is too small. On success the returned length excludes the NUL and is
    // therefore strictly below the supplied capacity. The extended local
    // drive spelling keeps this valid for paths longer than MAX_PATH.
    if (length < buffer.size()) return std::wstring(buffer.data(), length);
    if (length == std::numeric_limits<DWORD>::max()) return {};
    size = length + 1;
  }
  return {};
}

bool ResolveFinalPath(HANDLE handle, const ParsedPath* parsed = nullptr) {
  DWORD size = 256;
  std::vector<wchar_t> buffer(size);
  for (int attempt = 0; attempt < 4; ++attempt) {
    const DWORD length = GetFinalPathNameByHandleW(
        handle,
        buffer.data(),
        static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0) return false;
    if (length < buffer.size()) {
      if (parsed == nullptr) return true;
      const std::wstring observed(buffer.data(), length);
      const std::wstring expected = CanonicalExpectedPath(*parsed);
      return !expected.empty() && ComparablePath(observed) == ComparablePath(expected);
    }
    buffer.resize(length + 1);
  }
  return false;
}

// Forward declaration: newly-created objects are passed an owner-only
// descriptor at creation and are re-applied through the handle before the
// operation returns.  The declaration keeps the handle-relative walker near
// the NT API declarations while the descriptor builder remains below it.
bool SetOwnerOnlyDacl(HANDLE handle);
bool MarkHandleForDeletion(HANDLE handle);
void FreeOwnerOnlySecurity(PACL acl, PSECURITY_DESCRIPTOR descriptor);
napi_value IdentityValue(napi_env env, const HandleIdentity& identity);
bool ParseProtectedChildArguments(
    napi_env env,
    const std::vector<napi_value>& arguments,
    std::wstring* rootPath,
    HandleIdentity* expectedRoot,
    std::wstring* childPath,
    Failure* failure);
bool BuildOwnerOnlySecurity(
    std::vector<BYTE>* ownerSid,
    PACL* acl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_ATTRIBUTES* attributes);

struct RelativeHandles {
  std::vector<HANDLE> parents;
  HANDLE final = INVALID_HANDLE_VALUE;

  ~RelativeHandles() {
    if (final != INVALID_HANDLE_VALUE) CloseHandle(final);
    for (auto iterator = parents.rbegin(); iterator != parents.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
  }

  HANDLE releaseFinal() {
    for (auto iterator = parents.rbegin(); iterator != parents.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    parents.clear();
    const HANDLE result = final;
    final = INVALID_HANDLE_VALUE;
    return result;
  }

  void closeFinal() {
    if (final != INVALID_HANDLE_VALUE) CloseHandle(final);
    final = INVALID_HANDLE_VALUE;
  }
};

bool OpenRootDirectory(
    const std::wstring& root,
    HANDLE* result,
    Failure* failure) {
  *result = CreateFileW(
      root.c_str(),
      kDirectoryTraversalAccess,
      kDirectoryShareMode,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr);
  if (*result == INVALID_HANDLE_VALUE) {
    *failure = FromLastError();
    return false;
  }
  bool reparse = false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(*result, &attributes)
      || !HasReparsePoint(*result, &reparse)) {
    CloseHandle(*result);
    *result = INVALID_HANDLE_VALUE;
    *failure = OperationFailed();
    return false;
  }
  if (reparse || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(*result);
    *result = INVALID_HANDLE_VALUE;
    *failure = reparse ? ReparsePoint() : NotDirectory();
    return false;
  }
  return true;
}

bool OpenRelativeComponent(
    HANDLE parent,
    const std::wstring& component,
    DWORD access,
    DWORD shareMode,
    ULONG disposition,
    ULONG createOptions,
    PSECURITY_DESCRIPTOR securityDescriptor,
    HANDLE* result,
    ULONG_PTR* information,
    Failure* failure) {
  if (component.empty()
      || component.size() > static_cast<std::size_t>(USHRT_MAX / sizeof(wchar_t))) {
    *failure = InvalidPath();
    return false;
  }
  const auto createFile = ResolveNtCreateFile();
  if (createFile == nullptr) {
    *failure = OperationFailed();
    return false;
  }
  NativeUnicodeString name{};
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  name.Buffer = const_cast<PWSTR>(component.c_str());
  NativeObjectAttributes objectAttributes{};
  objectAttributes.Length = sizeof(objectAttributes);
  objectAttributes.RootDirectory = parent;
  objectAttributes.ObjectName = &name;
  objectAttributes.Attributes = kObjCaseInsensitive;
  objectAttributes.SecurityDescriptor = securityDescriptor;
  NativeIoStatusBlock ioStatus{};
  const NativeNtStatus status = createFile(
      result,
      access,
      &objectAttributes,
      &ioStatus,
      nullptr,
      FILE_ATTRIBUTE_NORMAL,
      shareMode,
      disposition,
      createOptions | kFileOpenReparsePoint | kFileSynchronousIoNonalert,
      nullptr,
      0);
  if (status < 0 || *result == nullptr || *result == INVALID_HANDLE_VALUE) {
    SetLastError(NativeStatusToWin32(status));
    *failure = FromLastError();
    *result = INVALID_HANDLE_VALUE;
    return false;
  }
  if (information != nullptr) *information = ioStatus.Information;
  return true;
}

struct OpenRelativeOptions {
  bool finalMayBeMissing = false;
  bool finalDirectoryKnown = false;
  bool finalDirectory = false;
  bool ownerOnlyOnCreate = false;
  bool protectAllAncestors = false;
  DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  DWORD shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  std::size_t protectedAncestorDepth = 0;
  DWORD protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  ULONG disposition = kFileOpen;
  ULONG extraOptions = 0;
  PSECURITY_DESCRIPTOR securityDescriptor = nullptr;
};

bool OpenRelativePath(
    const ParsedPath& parsed,
    const OpenRelativeOptions& options,
    RelativeHandles* opened,
    bool* finalMissing,
    Failure* failure) {
  *finalMissing = false;
  HANDLE root = INVALID_HANDLE_VALUE;
  if (!OpenRootDirectory(parsed.root, &root, failure)) return false;
  opened->parents.push_back(root);
  HANDLE current = root;
  for (std::size_t index = 0; index < parsed.components.size(); ++index) {
    const bool final = index + 1 == parsed.components.size();
    const ULONG typeOption = !final
        ? kFileDirectoryFile
        : options.finalDirectoryKnown
          ? (options.finalDirectory ? kFileDirectoryFile : kFileNonDirectoryFile)
          : 0;
    // Intermediate components are always opened as existing directories with
    // directory-only access.  In particular, never reuse a final-file
    // disposition (CREATE_NEW/OPEN_IF) or final-file sharing policy while
    // traversing ancestors.  Creation of missing directories is a separate
    // parent-handle operation in EnsureDirectoryCallback below.
    const DWORD access = final ? options.access : kDirectoryTraversalAccess;
    const std::size_t remainingComponents = parsed.components.size() - index - 1;
    const bool protectedAncestor = !final
        && (options.protectAllAncestors
          || (options.protectedAncestorDepth > 0
            && remainingComponents <= options.protectedAncestorDepth));
    const DWORD shareMode = final
        ? options.shareMode
        : protectedAncestor
          ? options.protectedAncestorShareMode
          : kDirectoryShareMode;
    const ULONG disposition = final ? options.disposition : kFileOpen;
    const PSECURITY_DESCRIPTOR securityDescriptor = final
        ? options.securityDescriptor
        : nullptr;
    HANDLE next = INVALID_HANDLE_VALUE;
    ULONG_PTR information = 0;
    if (!OpenRelativeComponent(
            current,
            parsed.components[index],
            access,
            shareMode,
            disposition,
            options.extraOptions | typeOption,
            securityDescriptor,
            &next,
            &information,
            failure)) {
      if (final && options.finalMayBeMissing && failure->code == NotFound().code) {
        *finalMissing = true;
        return true;
      }
      return false;
    }
    const bool created = information == kFileCreated;
    const auto rejectCreated = [&](Failure reason) -> bool {
      if (created && !MarkHandleForDeletion(next)) {
        *failure = OperationFailed();
      } else {
        *failure = reason;
      }
      CloseHandle(next);
      return false;
    };
    bool reparse = false;
    DWORD attributes = 0;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      return rejectCreated(OperationFailed());
    }
    if (reparse) {
      return rejectCreated(ReparsePoint());
    }
    if (!final && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return rejectCreated(NotDirectory());
    }
    if (final && options.finalDirectoryKnown
        && (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != options.finalDirectory)) {
      return rejectCreated(options.finalDirectory ? NotDirectory() : NotRegularFile());
    }
    if (final && options.ownerOnlyOnCreate && created
        && !SetOwnerOnlyDacl(next)) {
      return rejectCreated(SecurityPolicy("dacl_update_failed"));
    }
    if (final) {
      opened->final = next;
      return true;
    }
    opened->parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

// The prepared-artifact surface deliberately repeats the root identity and
// validates every retained directory handle before exposing a result. Existing
// protected-child methods only need the final object for their narrower
// contracts; prepared publication additionally keeps every child ancestor
// bound for enumeration, deletion, and no-clobber rename.
bool ParseAndValidatePath(
    const std::wstring& path,
    bool finalMayBeMissing,
    ParsedPath* parsed,
    Failure* failure);
bool ValidateSecurity(
    HANDLE handle,
    bool directory,
    Failure* failure,
    HandleIdentity* identity = nullptr,
    SecuritySnapshot* security = nullptr);
bool OpenProtectedRootAndChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    const OpenRelativeOptions& options,
    RelativeHandles* opened,
    bool* finalMissing,
    ParsedPath* fullPath,
    Failure* failure);

bool ValidatePreparedAncestors(
    const RelativeHandles& opened,
    const ParsedPath& fullPath,
    std::size_t rootComponentCount,
    Failure* failure) {
  if (opened.parents.empty() || rootComponentCount > fullPath.components.size()) {
    *failure = InvalidPath();
    return false;
  }
  for (std::size_t index = 0; index < opened.parents.size(); ++index) {
    HandleIdentity identity;
    if (!ValidateSecurity(opened.parents[index], true, failure, &identity)) {
      return false;
    }
    ParsedPath prefix = fullPath;
    const std::size_t componentCount = rootComponentCount + index;
    if (componentCount > prefix.components.size()) {
      *failure = InvalidPath();
      return false;
    }
    prefix.components.resize(componentCount);
    if (!ResolveFinalPath(opened.parents[index], &prefix)) {
      *failure = IdentityMismatch();
      return false;
    }
  }
  return true;
}

bool OpenPreparedExistingChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    bool finalDirectoryKnown,
    bool finalDirectory,
    DWORD access,
    DWORD shareMode,
    RelativeHandles* opened,
    ParsedPath* fullPath,
    Failure* failure) {
  OpenRelativeOptions options;
  options.finalDirectoryKnown = finalDirectoryKnown;
  options.finalDirectory = finalDirectory;
  options.access = access;
  options.shareMode = shareMode;
  options.protectAllAncestors = true;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          opened,
          &finalMissing,
          fullPath,
          failure)
      || finalMissing
      || opened->final == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::vector<std::wstring> childComponents;
  if (!ParseRelativeComponents(childPath, &childComponents)
      || childComponents.size() > fullPath->components.size()) {
    *failure = InvalidPath();
    return false;
  }
  ParsedPath parsedRoot = *fullPath;
  parsedRoot.components.resize(
      fullPath->components.size() - childComponents.size());
  const std::size_t rootComponentCount = parsedRoot.components.size();
  if (!ValidatePreparedAncestors(*opened, *fullPath, rootComponentCount, failure)) {
    return false;
  }
  HandleIdentity identity;
  if (!GetIdentity(opened->final, &identity)
      || !ValidateSecurity(opened->final, identity.directory, failure, &identity)
      || !ResolveFinalPath(opened->final, fullPath)) {
    if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
    return false;
  }
  return true;
}

bool OpenPreparedRootOnly(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    RelativeHandles* opened,
    ParsedPath* parsedRoot,
    Failure* failure) {
  if (!ParseAndValidatePath(rootPath, false, parsedRoot, failure)) return false;
  OpenRelativeOptions rootOptions;
  rootOptions.finalDirectoryKnown = true;
  rootOptions.finalDirectory = true;
  rootOptions.access = kDirectoryTraversalAccess;
  rootOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.protectedAncestorDepth = parsedRoot->components.size() - 1;
  rootOptions.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.disposition = kFileOpen;
  bool rootMissing = false;
  RelativeHandles rootOpened;
  if (!OpenRelativePath(
          *parsedRoot,
          rootOptions,
          &rootOpened,
          &rootMissing,
          failure)
      || rootMissing
      || rootOpened.final == INVALID_HANDLE_VALUE) {
    return false;
  }
  HandleIdentity observedRoot;
  if (!ValidateSecurity(rootOpened.final, true, failure, &observedRoot)
      || !EqualIdentity(observedRoot, expectedRoot)
      || !ResolveFinalPath(rootOpened.final, parsedRoot)) {
    if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
    return false;
  }
  HANDLE protectedRoot = rootOpened.releaseFinal();
  if (protectedRoot == INVALID_HANDLE_VALUE) {
    *failure = OperationFailed();
    return false;
  }
  opened->parents.push_back(protectedRoot);
  return ValidatePreparedAncestors(
      *opened,
      *parsedRoot,
      parsedRoot->components.size(),
      failure);
}

bool OpenPreparedRootAndDirectory(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    bool createMissing,
    RelativeHandles* opened,
    ParsedPath* fullPath,
    Failure* failure) {
  ParsedPath parsedRoot;
  if (!ParseAndValidatePath(rootPath, false, &parsedRoot, failure)) return false;
  std::vector<std::wstring> childComponents;
  if (!ParseRelativeComponents(childPath, &childComponents)) {
    *failure = InvalidPath();
    return false;
  }

  RelativeHandles rootOpened;
  if (!OpenPreparedRootOnly(rootPath, expectedRoot, &rootOpened, &parsedRoot, failure)) {
    return false;
  }
  HANDLE protectedRoot = rootOpened.parents.back();
  opened->parents.push_back(protectedRoot);
  rootOpened.parents.pop_back();
  HANDLE current = protectedRoot;
  *fullPath = parsedRoot;

  for (std::size_t index = 0; index < childComponents.size(); ++index) {
    const bool final = index + 1 == childComponents.size();
    HANDLE next = INVALID_HANDLE_VALUE;
    ULONG_PTR information = 0;
    Failure openFailure = OperationFailed();
    if (!OpenRelativeComponent(
            current,
            childComponents[index],
            kDirectoryTraversalAccess,
            kDirectoryShareMode,
            kFileOpen,
            kFileDirectoryFile,
            nullptr,
            &next,
            &information,
            &openFailure)) {
      if (!createMissing || openFailure.code != NotFound().code) {
        *failure = openFailure;
        return false;
      }
      std::vector<BYTE> ownerSid;
      PACL acl = nullptr;
      PSECURITY_DESCRIPTOR descriptor = nullptr;
      SECURITY_ATTRIBUTES attributes{};
      if (!BuildOwnerOnlySecurity(
              &ownerSid,
              &acl,
              &descriptor,
              &attributes)) {
        *failure = OperationFailed();
        return false;
      }
      bool created = OpenRelativeComponent(
          current,
          childComponents[index],
          kDirectoryTraversalAccess | WRITE_DAC | DELETE,
          kDirectoryShareMode,
          kFileCreate,
          kFileDirectoryFile,
          attributes.lpSecurityDescriptor,
          &next,
          &information,
          &openFailure);
      FreeOwnerOnlySecurity(acl, descriptor);
      // A competing ensure may win the create between our initial open and
      // this create-new attempt. Re-open the now-existing directory relative
      // to the same held parent instead of surfacing a spurious race failure.
      if (!created && openFailure.code == AlreadyExists().code) {
        openFailure = OperationFailed();
        created = OpenRelativeComponent(
            current,
            childComponents[index],
            kDirectoryTraversalAccess,
            kDirectoryShareMode,
            kFileOpen,
            kFileDirectoryFile,
            nullptr,
            &next,
            &information,
            &openFailure);
      }
      if (!created || (information != kFileCreated && information != kFileOpened)) {
        *failure = created ? AlreadyExists() : openFailure;
        if (next != INVALID_HANDLE_VALUE) CloseHandle(next);
        return false;
      }
    }

    bool reparse = false;
    DWORD attributes = 0;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      if (information == kFileCreated) MarkHandleForDeletion(next);
      CloseHandle(next);
      *failure = OperationFailed();
      return false;
    }
    if (reparse || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      if (information == kFileCreated) MarkHandleForDeletion(next);
      CloseHandle(next);
      *failure = reparse ? ReparsePoint() : NotDirectory();
      return false;
    }
    if (information == kFileCreated && !SetOwnerOnlyDacl(next)) {
      *failure = SecurityPolicy("dacl_update_failed");
      if (!MarkHandleForDeletion(next)) *failure = OperationFailed();
      CloseHandle(next);
      return false;
    }
    fullPath->components.push_back(childComponents[index]);
    HandleIdentity identity;
    if (!ValidateSecurity(next, true, failure, &identity)
        || !ResolveFinalPath(next, fullPath)) {
      if (information == kFileCreated) MarkHandleForDeletion(next);
      CloseHandle(next);
      if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
      return false;
    }
    if (final) {
      opened->final = next;
      return ValidatePreparedAncestors(
          *opened,
          *fullPath,
          parsedRoot.components.size(),
          failure);
    }
    opened->parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

bool SplitPreparedSiblingPaths(
    const std::wstring& sourcePath,
    const std::wstring& targetPath,
    std::wstring* sourceName,
    std::wstring* targetName,
    Failure* failure) {
  std::vector<std::wstring> source;
  std::vector<std::wstring> target;
  if (!ParseRelativeComponents(sourcePath, &source)
      || !ParseRelativeComponents(targetPath, &target)
      || source.size() != target.size()
      || source.empty()) {
    *failure = InvalidPath();
    return false;
  }
  for (std::size_t index = 0; index + 1 < source.size(); ++index) {
    if (!EqualInsensitive(source[index], target[index])) {
      *failure = InvalidPath();
      return false;
    }
  }
  *sourceName = source.back();
  *targetName = target.back();
  if (EqualInsensitive(*sourceName, *targetName)) {
    *failure = AlreadyExists();
    return false;
  }
  return true;
}

bool CreatePreparedResultEntry(
    napi_env env,
    napi_value array,
    std::uint32_t index,
    const std::wstring& name,
    const HandleIdentity& identity,
    bool isDirectory,
    bool isReparsePoint) {
  napi_value entry;
  napi_value nameValue;
  napi_value identityValue;
  napi_value directory;
  napi_value regular;
  napi_value reparse;
  napi_create_object(env, &entry);
  napi_create_string_utf16(
      env,
      reinterpret_cast<const char16_t*>(name.data()),
      name.size(),
      &nameValue);
  identityValue = IdentityValue(env, identity);
  napi_get_boolean(env, isDirectory, &directory);
  napi_get_boolean(env, !isDirectory, &regular);
  napi_get_boolean(env, isReparsePoint, &reparse);
  napi_set_named_property(env, entry, "name", nameValue);
  napi_set_named_property(env, entry, "identity", identityValue);
  napi_set_named_property(env, entry, "isDirectory", directory);
  napi_set_named_property(env, entry, "isRegularFile", regular);
  napi_set_named_property(env, entry, "isReparsePoint", reparse);
  napi_set_element(env, array, index, entry);
  return true;
}

bool EnumeratePreparedDirectoryEntries(
    HANDLE directory,
    const ParsedPath& directoryPath,
    std::size_t maximumEntries,
    napi_env env,
    napi_value result,
    Failure* failure) {
  if (maximumEntries < 1 || maximumEntries > kMaximumPreparedDirectoryEntries) {
    *failure = PreparedDirectoryLimit();
    return false;
  }
  std::array<BYTE, 64 * 1024> buffer{};
  std::size_t count = 0;
  for (;;) {
    if (!GetFileInformationByHandleEx(
            directory,
            FileIdBothDirectoryInfo,
            buffer.data(),
            static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) break;
      *failure = FromLastError(error);
      return false;
    }
    std::size_t offset = 0;
    for (;;) {
      if (offset + sizeof(FILE_ID_BOTH_DIR_INFO) > buffer.size()) {
        *failure = OperationFailed();
        return false;
      }
      auto* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(
          buffer.data() + offset);
      const std::size_t entryHeader = FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName);
      if (entry->FileNameLength % sizeof(WCHAR) != 0
          || entryHeader > buffer.size() - offset
          || entry->FileNameLength > buffer.size() - offset - entryHeader) {
        *failure = OperationFailed();
        return false;
      }
      const std::size_t recordBytes = entryHeader + entry->FileNameLength;
      if (entry->NextEntryOffset != 0
          && entry->NextEntryOffset < recordBytes) {
        *failure = OperationFailed();
        return false;
      }
      const std::wstring name(
          entry->FileName,
          entry->FileNameLength / sizeof(WCHAR));
      if (name != L"." && name != L"..") {
        std::vector<std::wstring> components;
        if (!ParseRelativeComponents(name, &components) || components.size() != 1) {
          *failure = InvalidPath();
          return false;
        }
        if (++count > maximumEntries) {
          *failure = PreparedDirectoryLimit();
          return false;
        }
        HANDLE child = INVALID_HANDLE_VALUE;
        if (!OpenRelativeComponent(
                directory,
                name,
                FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                kFileOpen,
                0,
                nullptr,
                &child,
                nullptr,
                failure)) {
          return false;
        }
        bool reparse = false;
        DWORD attributes = 0;
        HandleIdentity identity;
        const bool valid = GetFileAttributesFromHandle(child, &attributes)
            && HasReparsePoint(child, &reparse)
            && !reparse
            && GetIdentity(child, &identity)
            && ValidateSecurity(child, identity.directory, failure, &identity);
        if (!valid) {
          CloseHandle(child);
          if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
          return false;
        }
        ParsedPath childPath = directoryPath;
        childPath.components.push_back(name);
        if (!ResolveFinalPath(child, &childPath)) {
          CloseHandle(child);
          *failure = IdentityMismatch();
          return false;
        }
        CreatePreparedResultEntry(
            env,
            result,
            static_cast<std::uint32_t>(count - 1),
            name,
            identity,
            identity.directory,
            reparse);
        CloseHandle(child);
      }
      if (entry->NextEntryOffset == 0) break;
      if (entry->NextEntryOffset % sizeof(ULONG) != 0
          || entry->NextEntryOffset > buffer.size() - offset) {
        *failure = OperationFailed();
        return false;
      }
      offset += entry->NextEntryOffset;
    }
  }
  return true;
}

bool OpenPreparedParentForChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    RelativeHandles* opened,
    ParsedPath* parentPath,
    std::wstring* childName,
    Failure* failure) {
  std::vector<std::wstring> components;
  if (!ParseRelativeComponents(childPath, &components) || components.empty()) {
    *failure = InvalidPath();
    return false;
  }
  *childName = components.back();
  std::wstring relativeParent;
  for (std::size_t index = 0; index + 1 < components.size(); ++index) {
    if (!relativeParent.empty()) relativeParent.append(L"\\");
    relativeParent.append(components[index]);
  }
  if (relativeParent.empty()) {
    if (!OpenPreparedRootOnly(rootPath, expectedRoot, opened, parentPath, failure)) {
      return false;
    }
    return true;
  }
  if (!OpenPreparedExistingChild(
          rootPath,
          expectedRoot,
          relativeParent,
          true,
          true,
          kDirectoryTraversalAccess,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          opened,
          parentPath,
          failure)) {
    return false;
  }
  if (opened->final == INVALID_HANDLE_VALUE) {
    *failure = OperationFailed();
    return false;
  }
  opened->parents.push_back(opened->final);
  opened->final = INVALID_HANDLE_VALUE;
  return true;
}

bool FlushPreparedDirectoryBoundary(HANDLE directory, Failure* failure) {
  // Windows does not expose a portable directory-entry fsync equivalent. A
  // successful directory flush is used where the filesystem supports it; an
  // INVALID_HANDLE failure is recorded as the documented metadata-durability
  // boundary while the file bytes themselves are always flushed before this
  // point. Other failures are real operation failures.
  if (FlushFileBuffers(directory)) return true;
  const DWORD error = GetLastError();
  if (error == ERROR_INVALID_HANDLE || error == ERROR_ACCESS_DENIED) return true;
  *failure = FromLastError();
  return false;
}

bool ParseAndValidatePath(
    const std::wstring& path,
    bool /*finalMayBeMissing*/,
    ParsedPath* parsed,
    Failure* failure) {
  if (!ParsePath(path, parsed)) {
    *failure = InvalidPath();
    return false;
  }
  // Component validation is performed while each component is opened
  // relative to the already-open parent handle.  There is intentionally no
  // path-based preflight here: a separate validation pass would recreate the
  // ancestor replacement race this binding exists to prevent.
  return true;
}

bool ValidateSecurity(
    HANDLE handle,
    bool directory,
    Failure* failure,
    HandleIdentity* identity,
    SecuritySnapshot* security) {
  bool reparse = false;
  if (!HasReparsePoint(handle, &reparse)) {
    *failure = OperationFailed();
    return false;
  }
  if (reparse) {
    *failure = ReparsePoint();
    return false;
  }
  HandleIdentity observed;
  if (!GetIdentity(handle, &observed)) {
    *failure = OperationFailed();
    return false;
  }
  if (observed.directory != directory) {
    *failure = directory ? NotDirectory() : NotRegularFile();
    return false;
  }
  if (!directory && observed.linkCount != 1) {
    *failure = HardLink();
    return false;
  }
  SecuritySnapshot descriptor;
  if (!ReadSecurity(handle, &descriptor)) {
    *failure = OperationFailed();
    return false;
  }
  if (!descriptor.ownerMatches) {
    *failure = SecurityPolicy("owner_mismatch");
    return false;
  }
  if (descriptor.nullDacl) {
    *failure = SecurityPolicy("null_dacl");
    return false;
  }
  if (!descriptor.daclProtected) {
    *failure = SecurityPolicy("dacl_not_protected");
    return false;
  }
  if (descriptor.broadAccess) {
    *failure = SecurityPolicy("broad_access");
    return false;
  }
  if (descriptor.nonOwnerAllow) {
    *failure = SecurityPolicy("non_owner_allow");
    return false;
  }
  if (descriptor.unrecognizedAce) {
    *failure = SecurityPolicy("unrecognized_ace");
    return false;
  }
  if (identity != nullptr) *identity = observed;
  if (security != nullptr) *security = descriptor;
  return true;
}

// Open one protected state root and then traverse the caller's relative child
// name from that already-open root handle.  The root identity check is part of
// this operation, before a child handle is opened; callers must not implement
// this as an inspect-then-path-open sequence.  The root and every traversed
// child parent remain held in `opened` until the operation completes.
bool OpenProtectedRootAndChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    const OpenRelativeOptions& options,
    RelativeHandles* opened,
    bool* finalMissing,
    ParsedPath* fullPath,
    Failure* failure) {
  *finalMissing = false;
  ParsedPath parsedRoot;
  if (!ParseAndValidatePath(rootPath, false, &parsedRoot, failure)) return false;
  std::vector<std::wstring> childComponents;
  if (!ParseRelativeComponents(childPath, &childComponents)) {
    *failure = InvalidPath();
    return false;
  }

  OpenRelativeOptions rootOptions;
  rootOptions.finalDirectoryKnown = true;
  rootOptions.finalDirectory = true;
  rootOptions.access = kDirectoryTraversalAccess;
  // Keep the protected root and its traversed ancestors renameable only by a
  // caller that can satisfy the same Windows sharing policy.  The held root
  // handle is the security boundary for the child walk; this share mode is a
  // defense-in-depth lock while the operation is in flight.
  rootOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.protectedAncestorDepth = parsedRoot.components.size() - 1;
  rootOptions.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.disposition = kFileOpen;
  RelativeHandles rootOpened;
  bool rootMissing = false;
  if (!OpenRelativePath(
          parsedRoot,
          rootOptions,
          &rootOpened,
          &rootMissing,
          failure)
      || rootMissing
      || rootOpened.final == INVALID_HANDLE_VALUE) {
    return false;
  }

  HandleIdentity observedRoot;
  if (!ValidateSecurity(rootOpened.final, true, failure, &observedRoot)
      || !EqualIdentity(observedRoot, expectedRoot)) {
    if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
    return false;
  }
  if (!ResolveFinalPath(rootOpened.final, &parsedRoot)) {
    *failure = IdentityMismatch();
    return false;
  }

  // Transfer the root handle, not its path, into the child operation.  The
  // drive and root ancestors can close now; NtCreateFile receives this handle
  // as RootDirectory for every child component below.
  const HANDLE protectedRoot = rootOpened.releaseFinal();
  if (protectedRoot == INVALID_HANDLE_VALUE) {
    *failure = OperationFailed();
    return false;
  }
  opened->parents.push_back(protectedRoot);
  HANDLE current = protectedRoot;
  *fullPath = parsedRoot;
  fullPath->components.insert(
      fullPath->components.end(),
      childComponents.begin(),
      childComponents.end());

  for (std::size_t index = 0; index < childComponents.size(); ++index) {
    const bool final = index + 1 == childComponents.size();
    const ULONG typeOption = !final
        ? kFileDirectoryFile
        : options.finalDirectoryKnown
          ? (options.finalDirectory ? kFileDirectoryFile : kFileNonDirectoryFile)
          : 0;
    const DWORD access = final ? options.access : kDirectoryTraversalAccess;
    const std::size_t remainingComponents = childComponents.size() - index - 1;
    const bool protectedAncestor = !final
        && (options.protectAllAncestors
          || (options.protectedAncestorDepth > 0
            && remainingComponents <= options.protectedAncestorDepth));
    const DWORD shareMode = final
        ? options.shareMode
        : protectedAncestor
          ? options.protectedAncestorShareMode
          : kDirectoryShareMode;
    const ULONG disposition = final ? options.disposition : kFileOpen;
    const PSECURITY_DESCRIPTOR securityDescriptor = final
        ? options.securityDescriptor
        : nullptr;
    HANDLE next = INVALID_HANDLE_VALUE;
    ULONG_PTR information = 0;
    if (!OpenRelativeComponent(
            current,
            childComponents[index],
            access,
            shareMode,
            disposition,
            options.extraOptions | typeOption,
            securityDescriptor,
            &next,
            &information,
            failure)) {
      if (final && options.finalMayBeMissing && failure->code == NotFound().code) {
        *finalMissing = true;
        return true;
      }
      return false;
    }
    const bool created = information == kFileCreated;
    const auto rejectCreated = [&](Failure reason) -> bool {
      if (created && !MarkHandleForDeletion(next)) {
        *failure = OperationFailed();
      } else {
        *failure = reason;
      }
      CloseHandle(next);
      return false;
    };
    bool reparse = false;
    DWORD attributes = 0;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      return rejectCreated(OperationFailed());
    }
    if (reparse) return rejectCreated(ReparsePoint());
    if (!final && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return rejectCreated(NotDirectory());
    }
    if (final && options.finalDirectoryKnown
        && (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != options.finalDirectory)) {
      return rejectCreated(options.finalDirectory ? NotDirectory() : NotRegularFile());
    }
    if (final && options.ownerOnlyOnCreate && created
        && !SetOwnerOnlyDacl(next)) {
      return rejectCreated(SecurityPolicy("dacl_update_failed"));
    }
    if (final) {
      opened->final = next;
      return true;
    }
    opened->parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

bool EndsWithInsensitive(const std::wstring& value, const wchar_t* suffix) {
  const std::size_t suffixLength = std::wcslen(suffix);
  if (value.size() < suffixLength) return false;
  const std::size_t offset = value.size() - suffixLength;
  for (std::size_t index = 0; index < suffixLength; ++index) {
    if (std::towlower(value[offset + index]) != std::towlower(suffix[index])) {
      return false;
    }
  }
  return true;
}

bool ParseSqliteDatabaseName(
    const std::wstring& supplied,
    std::wstring* databaseName,
    Failure* failure) {
  // SQLite's rollback journal is derived from one basename.  Do not accept
  // a path here: accepting a separator would let the caller choose a child
  // outside the identity-bound root walk, and accepting a journal/WAL/SHM
  // basename would make the derived sidecar names ambiguous.
  if (supplied.empty()
      || supplied.find_first_of(L"\\/") != std::wstring::npos
      || EndsWithInsensitive(supplied, L"-journal")
      || EndsWithInsensitive(supplied, L"-wal")
      || EndsWithInsensitive(supplied, L"-shm")) {
    *failure = InvalidPath();
    return false;
  }
  std::vector<std::wstring> components;
  if (!ParseRelativeComponents(supplied, &components) || components.size() != 1) {
    *failure = InvalidPath();
    return false;
  }
  *databaseName = std::move(components.front());
  return true;
}

// A staged unified index is only safe when SQLite is in its rollback-journal
// mode.  The qualified session reserves -wal and -shm for its entire
// lifetime; this second, root-handle-bound check prevents a caller from
// cloning or publishing through an unexpected sidecar that appeared after
// that session was closed.
bool RequireSqliteSidecarsAbsent(
    HANDLE protectedRoot,
    const std::wstring& databaseName,
    Failure* failure) {
  for (const wchar_t* suffix : {L"-wal", L"-shm"}) {
    HANDLE sidecar = INVALID_HANDLE_VALUE;
    ULONG_PTR information = 0;
    const std::wstring sidecarName = databaseName + suffix;
    if (OpenRelativeComponent(
            protectedRoot,
            sidecarName,
            FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            kFileOpen,
            kFileNonDirectoryFile,
            nullptr,
            &sidecar,
            &information,
            failure)) {
      CloseHandle(sidecar);
      *failure = SqliteStateLeaseSidecarPresent();
      return false;
    }
    if (failure->code != NotFound().code) return false;
  }
  return true;
}

bool ValidateSqliteStagingHandle(
    HANDLE handle,
    const ParsedPath& fullPath,
    HandleIdentity* identity,
    Failure* failure) {
  return ValidateSecurity(handle, false, failure, identity)
      && ResolveFinalPath(handle, &fullPath);
}

bool ValidateSqliteChildHandle(
    HANDLE handle,
    const ParsedPath& fullPath,
    HandleIdentity* identity,
    Failure* failure) {
  bool reparse = false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)
      || !HasReparsePoint(handle, &reparse)) {
    *failure = OperationFailed();
    return false;
  }
  if (reparse) {
    *failure = ReparsePoint();
    return false;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    *failure = NotRegularFile();
    return false;
  }

  SecuritySnapshot security;
  if (!ValidateSecurity(handle, false, failure, identity, &security)
      || security.denyAce
      || security.ownerAllowAceCount != 1
      || security.ownerAllowMask != FILE_ALL_ACCESS
      || !ResolveFinalPath(handle, &fullPath)) {
    if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
    if (failure->code == IdentityMismatch().code
        && (security.denyAce
          || security.ownerAllowAceCount != 1
          || security.ownerAllowMask != FILE_ALL_ACCESS)) {
      *failure = SecurityPolicy("sqlite_state_lease_security");
    }
    return false;
  }
  return true;
}

bool OpenSqliteChild(
    HANDLE protectedRoot,
    const ParsedPath& parsedRoot,
    const std::wstring& childName,
    RelativeHandles* opened,
    HandleIdentity* identity,
    Failure* failure) {
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONG_PTR information = 0;
  bool createdNew = false;
  if (!OpenRelativeComponent(
          protectedRoot,
          childName,
          options.access,
          options.shareMode,
          options.disposition,
          kFileNonDirectoryFile,
          nullptr,
          &handle,
          &information,
          failure)) {
    if (failure->code != NotFound().code) return false;

    std::vector<BYTE> ownerSid;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    SECURITY_ATTRIBUTES attributes{};
    if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
      *failure = OperationFailed();
      return false;
    }
    options.access = GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
        | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    options.disposition = kFileCreate;
    options.ownerOnlyOnCreate = true;
    options.securityDescriptor = attributes.lpSecurityDescriptor;
    const bool created = OpenRelativeComponent(
        protectedRoot,
        childName,
        options.access,
        options.shareMode,
        options.disposition,
        kFileNonDirectoryFile,
        options.securityDescriptor,
        &handle,
        &information,
        failure);
    FreeOwnerOnlySecurity(acl, descriptor);
    if (!created) return false;
    if (information != kFileCreated) {
      CloseHandle(handle);
      *failure = AlreadyExists();
      return false;
    }
    createdNew = true;
    if (!FlushFileBuffers(handle)) {
      *failure = FromLastError();
      if (!MarkHandleForDeletion(handle)) *failure = OperationFailed();
      CloseHandle(handle);
      return false;
    }
  }

  ParsedPath fullPath = parsedRoot;
  fullPath.components.push_back(childName);
  if (!ValidateSqliteChildHandle(handle, fullPath, identity, failure)) {
    CloseHandle(handle);
    return false;
  }

  if (createdNew) {
    const HandleIdentity createdIdentity = *identity;
    CloseHandle(handle);
    handle = INVALID_HANDLE_VALUE;

    // A newly created child was opened with DELETE access so a failed lease
    // can clean it up.  Stock SQLite opens its database and journal without
    // FILE_SHARE_DELETE, so do not retain that creation handle while SQLite
    // opens the fresh files.  Reopen relative to the already-held protected
    // root, then validate both the security boundary and the exact object
    // identity before retaining the ordinary existing-file handle.
    options.access = READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
    options.disposition = kFileOpen;
    options.ownerOnlyOnCreate = false;
    options.securityDescriptor = nullptr;
    ULONG_PTR reopenInformation = 0;
    if (!OpenRelativeComponent(
            protectedRoot,
            childName,
            options.access,
            options.shareMode,
            options.disposition,
            kFileNonDirectoryFile,
            nullptr,
            &handle,
            &reopenInformation,
            failure)) {
      return false;
    }
    if (reopenInformation != kFileOpened) {
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      *failure = IdentityMismatch();
      return false;
    }
    HandleIdentity reopenedIdentity;
    if (!ValidateSqliteChildHandle(handle, fullPath, &reopenedIdentity, failure)
        || !EqualIdentity(reopenedIdentity, createdIdentity)) {
      if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      return false;
    }
    *identity = reopenedIdentity;
  }

  opened->final = handle;
  return true;
}

// Reserve a SQLite WAL/SHM basename for the complete native lease lifetime.
// A missing sidecar cannot be protected by an existence check alone: another
// process could create it immediately after that check.  Instead, create an
// owner-only placeholder relative to the already-held root and keep an
// exclusive handle open. All metadata, security, and canonical-path checks
// complete while the placeholder is still ordinary; Windows can reject those
// queries once a file is delete-pending. The final fallible step marks the
// validated handle for deletion immediately before exposing the lease. A
// SQLite writer attempting to create or open the sidecar then receives a
// sharing violation (or delete-pending error), and the file is removed after
// the lease has closed every reservation handle, including after a crash.
bool ReserveSqliteSidecar(
    HANDLE protectedRoot,
    const ParsedPath& parsedRoot,
    const std::wstring& sidecarName,
    HANDLE* result,
    Failure* failure) {
  *result = INVALID_HANDLE_VALUE;
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    *failure = OperationFailed();
    return false;
  }

  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
      | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  // No sharing is deliberate: both opens and creates of the reserved name
  // must be rejected while this handle remains live.
  options.shareMode = 0;
  options.disposition = kFileCreate;
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = attributes.lpSecurityDescriptor;
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONG_PTR information = 0;
  const bool opened = OpenRelativeComponent(
      protectedRoot,
      sidecarName,
      options.access,
      options.shareMode,
      options.disposition,
      kFileNonDirectoryFile | options.extraOptions,
      options.securityDescriptor,
      &handle,
      &information,
      failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!opened) {
    // An existing-but-unreadable sidecar is still a present sidecar.  Do not
    // expose whether its owner or ACL differs from the expected state.
    if (failure->code == AlreadyExists().code
        || failure->code == AccessDenied().code) {
      *failure = SqliteStateLeaseSidecarPresent();
    }
    return false;
  }
  if (information != kFileCreated) {
    CloseHandle(handle);
    *failure = SqliteStateLeaseSidecarPresent();
    return false;
  }

  bool reparse = false;
  DWORD attributesValue = 0;
  HandleIdentity identity;
  SecuritySnapshot security;
  ParsedPath fullPath = parsedRoot;
  fullPath.components.push_back(sidecarName);
  const bool valid = GetFileAttributesFromHandle(handle, &attributesValue)
      && HasReparsePoint(handle, &reparse)
      && !reparse
      && (attributesValue & FILE_ATTRIBUTE_DIRECTORY) == 0
      && FlushFileBuffers(handle)
      && ValidateSecurity(handle, false, failure, &identity, &security)
      && !security.denyAce
      && security.ownerAllowAceCount == 1
      && security.ownerAllowMask == FILE_ALL_ACCESS
      && ResolveFinalPath(handle, &fullPath);
  if (!valid) {
    if (!MarkHandleForDeletion(handle)) *failure = OperationFailed();
    CloseHandle(handle);
    return false;
  }

  // This must remain the final fallible operation before publishing the
  // reservation handle. Marking earlier makes the handle delete-pending and
  // can cause the validation above (especially final-path resolution) to
  // fail. If marking fails, never expose the lease; close the handle and
  // preserve the native failure unless cleanup itself also fails.
  if (!MarkHandleForDeletion(handle)) {
    const Failure deletionFailure = FromLastError();
    if (!CloseHandle(handle)) *failure = OperationFailed();
    else *failure = deletionFailure;
    return false;
  }
  *result = handle;
  return true;
}

std::vector<HANDLE> TakeAllHandles(RelativeHandles* opened) {
  std::vector<HANDLE> handles;
  handles.reserve(opened->parents.size() + 1);
  for (HANDLE handle : opened->parents) {
    if (handle != INVALID_HANDLE_VALUE) handles.push_back(handle);
  }
  opened->parents.clear();
  if (opened->final != INVALID_HANDLE_VALUE) {
    handles.push_back(opened->final);
    opened->final = INVALID_HANDLE_VALUE;
  }
  return handles;
}

bool BuildOwnerOnlyObjectSecurity(
    DWORD accessMask,
    std::vector<BYTE>* ownerSid,
    PACL* acl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_ATTRIBUTES* attributes) {
  if (!GetCurrentUserSid(ownerSid)) return false;
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = accessMask;
  entry.grfAccessMode = SET_ACCESS;
  entry.grfInheritance = NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
  entry.Trustee.ptstrName = reinterpret_cast<LPWSTR>(ownerSid->data());
  if (SetEntriesInAclW(1, &entry, nullptr, acl) != ERROR_SUCCESS) return false;
  *descriptor = static_cast<PSECURITY_DESCRIPTOR>(LocalAlloc(LPTR, SECURITY_DESCRIPTOR_MIN_LENGTH));
  if (*descriptor == nullptr) {
    LocalFree(*acl);
    *acl = nullptr;
    return false;
  }
  if (!InitializeSecurityDescriptor(*descriptor, SECURITY_DESCRIPTOR_REVISION)
      || !SetSecurityDescriptorOwner(*descriptor, ownerSid->data(), FALSE)
      || !SetSecurityDescriptorDacl(*descriptor, TRUE, *acl, FALSE)
      || !SetSecurityDescriptorControl(
          *descriptor,
          SE_DACL_PROTECTED,
          SE_DACL_PROTECTED)) {
    LocalFree(*descriptor);
    LocalFree(*acl);
    *descriptor = nullptr;
    *acl = nullptr;
    return false;
  }
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = *descriptor;
  attributes->bInheritHandle = FALSE;
  return true;
}

bool BuildOwnerOnlySecurity(
    std::vector<BYTE>* ownerSid,
    PACL* acl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_ATTRIBUTES* attributes) {
  return BuildOwnerOnlyObjectSecurity(
      FILE_ALL_ACCESS,
      ownerSid,
      acl,
      descriptor,
      attributes);
}

void FreeOwnerOnlySecurity(PACL acl, PSECURITY_DESCRIPTOR descriptor) {
  if (descriptor != nullptr) LocalFree(descriptor);
  if (acl != nullptr) LocalFree(acl);
}

bool SetOwnerOnlyDacl(HANDLE handle) {
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) return false;
  const DWORD result = SetSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      acl,
      nullptr);
  FreeOwnerOnlySecurity(acl, descriptor);
  return result == ERROR_SUCCESS;
}

napi_value IdentityValue(napi_env env, const HandleIdentity& identity) {
  napi_value object;
  napi_value volume;
  napi_value fileId;
  napi_value links;
  napi_create_object(env, &object);
  std::ostringstream volumeText;
  volumeText << std::hex << std::setfill('0') << std::setw(16) << identity.volumeSerialNumber;
  napi_create_string_utf8(env, volumeText.str().c_str(), NAPI_AUTO_LENGTH, &volume);
  napi_create_string_utf8(env, HexIdentity(identity).c_str(), NAPI_AUTO_LENGTH, &fileId);
  napi_create_uint32(env, identity.linkCount, &links);
  napi_set_named_property(env, object, "volumeSerialNumber", volume);
  napi_set_named_property(env, object, "fileId", fileId);
  napi_set_named_property(env, object, "linkCount", links);
  return object;
}

napi_value MetadataValue(
    napi_env env,
    const HandleIdentity& identity,
    const SecuritySnapshot& security,
    bool finalPathResolved) {
  napi_value result;
  napi_value identityValue;
  napi_value directory;
  napi_value regular;
  napi_value reparse;
  napi_value owner;
  napi_value nullDacl;
  napi_value daclProtected;
  napi_value broad;
  napi_value nonOwner;
  napi_value unrecognized;
  napi_value resolved;
  napi_create_object(env, &result);
  identityValue = IdentityValue(env, identity);
  napi_get_boolean(env, identity.directory, &directory);
  napi_get_boolean(env, !identity.directory, &regular);
  napi_get_boolean(env, false, &reparse);
  napi_get_boolean(env, security.ownerMatches, &owner);
  napi_get_boolean(env, security.nullDacl, &nullDacl);
  napi_get_boolean(env, security.daclProtected, &daclProtected);
  napi_get_boolean(env, security.broadAccess, &broad);
  napi_get_boolean(env, security.nonOwnerAllow, &nonOwner);
  napi_get_boolean(env, security.unrecognizedAce, &unrecognized);
  napi_get_boolean(env, finalPathResolved, &resolved);
  napi_set_named_property(env, result, "identity", identityValue);
  napi_set_named_property(env, result, "isDirectory", directory);
  napi_set_named_property(env, result, "isRegularFile", regular);
  napi_set_named_property(env, result, "isReparsePoint", reparse);
  napi_set_named_property(env, result, "ownerMatches", owner);
  napi_set_named_property(env, result, "nullDacl", nullDacl);
  napi_set_named_property(env, result, "daclProtected", daclProtected);
  napi_set_named_property(env, result, "broadAccess", broad);
  napi_set_named_property(env, result, "nonOwnerAllow", nonOwner);
  napi_set_named_property(env, result, "unrecognizedAce", unrecognized);
  napi_set_named_property(env, result, "finalPathResolved", resolved);
  return result;
}

bool ParseExpectedIdentity(napi_env env, napi_value value, HandleIdentity* identity) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
  std::string volumeText;
  std::string fileId;
  if (!GetNamedString(env, value, "volumeSerialNumber", &volumeText)
      || !GetNamedString(env, value, "fileId", &fileId)
      || volumeText.size() != 16
      || fileId.size() != 32) return false;
  for (char character : volumeText) {
    if (!std::isxdigit(static_cast<unsigned char>(character))) return false;
  }
  for (char character : fileId) {
    if (!std::isxdigit(static_cast<unsigned char>(character))) return false;
  }
  identity->volumeSerialNumber = std::stoull(volumeText, nullptr, 16);
  identity->linkCount = 1;
  for (std::size_t index = 0; index < identity->fileId.size(); ++index) {
    const std::string byte = fileId.substr(index * 2, 2);
    identity->fileId[index] = static_cast<BYTE>(std::stoul(byte, nullptr, 16));
  }
  return true;
}

bool GetArguments(
    napi_env env,
    napi_callback_info info,
    std::vector<napi_value>* arguments,
    std::size_t expected) {
  // Prepared-artifact publication is the widest callback surface (root path,
  // expected root identity, stage name, expected stage identity, and target
  // name); SQLite publication also uses six arguments. Keep the exact-count
  // check below: this is capacity, not permission to accept arbitrary trailing
  // arguments.
  napi_value values[8] = {};
  std::size_t count = 8;
  if (napi_get_cb_info(env, info, &count, values, nullptr, nullptr) != napi_ok
      || count != expected) {
    return false;
  }
  arguments->assign(values, values + count);
  return true;
}

bool OpenSecureExisting(
    const std::wstring& path,
    bool directory,
    DWORD access,
    DWORD shareMode,
    HANDLE* handle,
    HandleIdentity* identity,
    Failure* failure,
    SecuritySnapshot* security = nullptr) {
  ParsedPath parsed;
  if (!ParseAndValidatePath(path, false, &parsed, failure)) return false;
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = directory;
  options.access = access;
  options.shareMode = shareMode;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return false;
  }
  if (!ValidateSecurity(opened.final, directory, failure, identity, security)) {
    return false;
  }
  if (!ResolveFinalPath(opened.final, &parsed)) {
    *failure = OperationFailed();
    return false;
  }
  *handle = opened.releaseFinal();
  return true;
}

bool ReadHandleBounded(
    HANDLE handle,
    std::size_t maximumBytes,
    std::vector<std::uint8_t>* bytes,
    Failure* failure) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0) {
    *failure = OperationFailed();
    return false;
  }
  // This comparison is deliberately before vector::assign.  A hostile or
  // unexpectedly large file therefore cannot make the native binding reserve
  // memory before the caller's explicit safety ceiling is enforced.
  if (static_cast<unsigned long long>(size.QuadPart)
      > static_cast<unsigned long long>(maximumBytes)) {
    *failure = TooLarge();
    return false;
  }
  bytes->assign(static_cast<std::size_t>(size.QuadPart), 0);
  std::size_t offset = 0;
  while (offset < bytes->size()) {
    const std::size_t remaining = bytes->size() - offset;
    const DWORD requested = static_cast<DWORD>(
        std::min<std::size_t>(remaining, kPreparedChunkBytes));
    DWORD read = 0;
    if (!ReadFile(handle, bytes->data() + offset, requested, &read, nullptr)) {
      *failure = FromLastError();
      return false;
    }
    // A synchronous read must make progress without ever writing beyond the
    // size captured before allocation.  A premature EOF or an impossible
    // count is a rejection, never a truncated successful prefix.
    if (read == 0 || static_cast<std::size_t>(read) > remaining) {
      *failure = OperationFailed();
      return false;
    }
    offset += read;
  }
  LARGE_INTEGER finalSize{};
  if (!GetFileSizeEx(handle, &finalSize) || finalSize.QuadPart < 0) {
    *failure = OperationFailed();
    return false;
  }
  if (static_cast<unsigned long long>(finalSize.QuadPart)
      > static_cast<unsigned long long>(maximumBytes)) {
    *failure = TooLarge();
    return false;
  }
  if (finalSize.QuadPart != size.QuadPart) {
    *failure = FileSizeChanged();
    return false;
  }
  return true;
}

bool ReadHandle(HANDLE handle, std::vector<std::uint8_t>* bytes, Failure* failure) {
  return ReadHandleBounded(handle, kMaximumFileBytes, bytes, failure);
}

bool MarkHandleForDeletion(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  return SetFileInformationByHandle(
      handle,
      FileDispositionInfo,
      &disposition,
      sizeof(disposition)) != FALSE;
}

bool WriteAndFlushHandle(
    HANDLE handle,
    const std::uint8_t* bytes,
    std::size_t byteCount,
    Failure* failure) {
  std::size_t offset = 0;
  while (offset < byteCount) {
    const DWORD requested = static_cast<DWORD>(
        std::min<std::size_t>(byteCount - offset, kPreparedChunkBytes));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, requested, &written, nullptr)
        || written == 0
        || written > requested) {
      *failure = FromLastError();
      return false;
    }
    offset += written;
  }
  if (!FlushFileBuffers(handle)) {
    *failure = FromLastError();
    return false;
  }
  return true;
}

// Copy a SQLite database while both handles are already bound to the same
// protected root.  The operation deliberately streams fixed-size chunks: a
// unified index is not subject to the small bounded-read ceiling used by the
// JSON/credential adapter, and a hostile or unexpectedly large database must
// never force one allocation proportional to its size.
bool CopyHandleToHandle(
    HANDLE source,
    HANDLE destination,
    Failure* failure) {
  LARGE_INTEGER sourceSize{};
  if (!GetFileSizeEx(source, &sourceSize) || sourceSize.QuadPart < 0) {
    *failure = OperationFailed();
    return false;
  }
  LARGE_INTEGER beginning{};
  if (SetFilePointerEx(source, beginning, nullptr, FILE_BEGIN) == FALSE
      || SetFilePointerEx(destination, beginning, nullptr, FILE_BEGIN) == FALSE) {
    *failure = FromLastError();
    return false;
  }
  std::array<std::uint8_t, 1 << 20> buffer{};
  LONGLONG remaining = sourceSize.QuadPart;
  while (remaining > 0) {
    const DWORD requested = static_cast<DWORD>(std::min<LONGLONG>(
        remaining,
        static_cast<LONGLONG>(buffer.size())));
    DWORD read = 0;
    if (!ReadFile(source, buffer.data(), requested, &read, nullptr)
        || read == 0
        || read > requested) {
      *failure = FromLastError();
      return false;
    }
    DWORD written = 0;
    if (!WriteFile(destination, buffer.data(), read, &written, nullptr)
        || written != read) {
      *failure = FromLastError();
      return false;
    }
    remaining -= static_cast<LONGLONG>(read);
  }
  LARGE_INTEGER finalSourceSize{};
  LARGE_INTEGER finalDestinationSize{};
  if (!GetFileSizeEx(source, &finalSourceSize)
      || !GetFileSizeEx(destination, &finalDestinationSize)
      || finalSourceSize.QuadPart != sourceSize.QuadPart
      || finalDestinationSize.QuadPart != sourceSize.QuadPart) {
    *failure = FileSizeChanged();
    return false;
  }
  if (!FlushFileBuffers(destination)) {
    *failure = FromLastError();
    return false;
  }
  return true;
}

struct NativeFileRenameInformationEx {
  ULONG flags;
  HANDLE rootDirectory;
  ULONG fileNameLength;
  WCHAR fileName[1];
};

bool RenameHandleRelative(
    HANDLE handle,
    HANDLE parent,
    const std::wstring& target,
    Failure* failure,
    bool replaceIfExists = true) {
  if (target.empty()
      || target.size() > static_cast<std::size_t>(ULONG_MAX / sizeof(wchar_t))) {
    *failure = InvalidPath();
    return false;
  }
  const auto setInformation = ResolveNtSetInformationFile();
  if (setInformation == nullptr) {
    *failure = OperationFailed();
    return false;
  }
  const std::size_t bytes = target.size() * sizeof(wchar_t);
  // FILE_RENAME_INFORMATION has a one-element trailing FileName field. The
  // documented allocation is sizeof(the fixed struct) plus FileNameLength;
  // using only offsetof(FileName) + FileNameLength can under-allocate the
  // required fixed-size/padding area for short names.
  if (bytes > std::numeric_limits<std::size_t>::max()
      - sizeof(NativeFileRenameInformationEx)) {
    *failure = InvalidPath();
    return false;
  }
  const std::size_t bufferBytes = sizeof(NativeFileRenameInformationEx) + bytes;
  std::vector<BYTE> buffer(bufferBytes, 0);
  auto* information = reinterpret_cast<NativeFileRenameInformationEx*>(buffer.data());
  information->flags = kFileRenamePosixSemantics
      | (replaceIfExists ? kFileRenameReplaceIfExists : 0);
  information->rootDirectory = parent;
  information->fileNameLength = static_cast<ULONG>(bytes);
  std::memcpy(information->fileName, target.data(), bytes);
  NativeIoStatusBlock ioStatus{};
  const NativeNtStatus status = setInformation(
      handle,
      &ioStatus,
      information,
      static_cast<ULONG>(buffer.size()),
      kFileRenameInformationEx);
  if (status < 0) {
    SetLastError(NativeStatusToWin32(status));
    *failure = FromLastError();
    failure->stage = "rename";
    return false;
  }
  return true;
}

bool OpenPublishedTargetForValidation(
    HANDLE parent,
    const std::wstring& target,
    HANDLE* result,
    Failure* failure) {
  ULONG_PTR information = 0;
  return OpenRelativeComponent(
      parent,
      target,
      READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      kFileOpen,
      kFileNonDirectoryFile,
      nullptr,
      result,
      &information,
      failure);
}

std::wstring TemporaryReplacementName() {
  static std::atomic<unsigned long> sequence{0};
  const unsigned long serial = sequence.fetch_add(1, std::memory_order_relaxed);
  std::wstringstream stream;
  stream << L".tibotattle-rotation-"
         << GetCurrentProcessId()
         << L'-'
         << GetTickCount64()
         << L'-'
         << serial
         << L".tmp";
  return stream.str();
}

#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
// This state is compiled only into the qualification-only target.  It is
// deliberately process-global so a Node Worker that enters replaceFile can
// be coordinated by the test thread that attempts the competing filesystem
// operation.  No production binding export or wait point is generated.
struct ReplacementPauseState {
  std::mutex mutex;
  std::condition_variable condition;
  bool armed = false;
  bool entered = false;
  bool released = false;
};

ReplacementPauseState gReplacementPauseState;

void PauseBeforeReplacementRename() {
  std::unique_lock<std::mutex> lock(gReplacementPauseState.mutex);
  if (!gReplacementPauseState.armed) return;
  gReplacementPauseState.entered = true;
  gReplacementPauseState.condition.notify_all();
  gReplacementPauseState.condition.wait(lock, [] {
    return gReplacementPauseState.released;
  });
  gReplacementPauseState.armed = false;
  gReplacementPauseState.entered = false;
  gReplacementPauseState.released = false;
  gReplacementPauseState.condition.notify_all();
}

napi_value ArmReplacementPauseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 0)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  {
    std::lock_guard<std::mutex> lock(gReplacementPauseState.mutex);
    if (gReplacementPauseState.armed || gReplacementPauseState.entered) {
      return ThrowFailure(env, QualificationPauseAlreadyArmed());
    }
    gReplacementPauseState.armed = true;
    gReplacementPauseState.entered = false;
    gReplacementPauseState.released = false;
  }
  gReplacementPauseState.condition.notify_all();
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value WaitForReplacementPauseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::uint32_t timeoutMilliseconds = 0;
  if (!GetUint32(env, arguments[0], &timeoutMilliseconds)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::unique_lock<std::mutex> lock(gReplacementPauseState.mutex);
  gReplacementPauseState.condition.wait_for(
      lock,
      std::chrono::milliseconds(timeoutMilliseconds),
      [] {
        return gReplacementPauseState.entered
            || gReplacementPauseState.released
            || !gReplacementPauseState.armed;
      });
  napi_value result;
  napi_get_boolean(env, gReplacementPauseState.entered, &result);
  return result;
}

napi_value ReleaseReplacementPauseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 0)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  {
    std::lock_guard<std::mutex> lock(gReplacementPauseState.mutex);
    gReplacementPauseState.released = true;
  }
  gReplacementPauseState.condition.notify_all();
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}
#endif

napi_value ReplaceFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  HandleIdentity expected;
  if (!GetString(env, arguments[0], &path)
      || !ParseExpectedIdentity(env, arguments[1], &expected)
      || !GetBuffer(env, arguments[2], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);

  // Open the target and every ancestor relative to a held parent handle.  A
  // later rename therefore operates in the same directory object rather than
  // resolving the target path again from the process current namespace.
  RelativeHandles opened;
  OpenRelativeOptions targetOptions;
  targetOptions.finalDirectoryKnown = true;
  targetOptions.finalDirectory = false;
  targetOptions.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  // POSIX replacement requires the existing destination handle to permit
  // delete sharing. Ancestors remain protected without FILE_SHARE_DELETE
  // below, so the handle-relative walk still pins the state-root boundary.
  targetOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_DELETE;
  // Keep every renameable ancestor from the state root through the
  // destination parent open without FILE_SHARE_DELETE for the complete
  // replacement transaction.  The drive root is opened separately as the OS
  // trust anchor and is intentionally not included in this count.
  targetOptions.protectedAncestorDepth = parsed.components.size() - 1;
  targetOptions.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  targetOptions.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, targetOptions, &opened, &finalMissing, &failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity current;
  if (!ValidateSecurity(opened.final, false, &failure, &current)
      || !EqualIdentity(current, expected)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  if (opened.parents.empty()) return ThrowFailure(env, OperationFailed());
  HANDLE parent = opened.parents.back();

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE replacement = INVALID_HANDLE_VALUE;
  std::wstring temporaryName;
  ULONG_PTR createInformation = 0;
  for (int attempt = 0; attempt < 8; ++attempt) {
    temporaryName = TemporaryReplacementName();
    if (OpenRelativeComponent(
            parent,
            temporaryName,
            FILE_READ_DATA | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
                | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            kFileCreate,
            kFileNonDirectoryFile,
            attributes.lpSecurityDescriptor,
            &replacement,
            &createInformation,
            &failure)) {
      break;
    }
    if (failure.code != AlreadyExists().code) {
      FreeOwnerOnlySecurity(acl, descriptor);
      return ThrowFailure(env, failure);
    }
  }
  FreeOwnerOnlySecurity(acl, descriptor);
  if (replacement == INVALID_HANDLE_VALUE) return ThrowFailure(env, AlreadyExists());

  bool renamed = false;
  bool success = WriteAndFlushHandle(replacement, bytes, byteCount, &failure)
      && SetOwnerOnlyDacl(replacement);
  HandleIdentity replacementIdentity;
  if (success && !ValidateSecurity(replacement, false, &failure, &replacementIdentity)) {
    success = false;
  }
  if (success) {
    // Revalidate the identity-bound destination immediately before the rename.
    // This handle check rejects a security or namespace change made through
    // a pre-existing privileged handle before the atomic name replacement is
    // requested. Windows' rename API has no expected-file-ID argument, so the
    // native claim remains qualification-only until the supported
    // Windows/filesystem matrix proves this boundary.
    HandleIdentity latest;
    success = ValidateSecurity(opened.final, false, &failure, &latest)
        && EqualIdentity(latest, expected)
        && ResolveFinalPath(opened.final, &parsed);
    if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
  }
  if (success) {
#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
    PauseBeforeReplacementRename();
#endif
    // The qualification pause deliberately gives competing filesystem work a
    // chance to run. Repeat both handle-bound security checks after it and
    // immediately before the rename; the destination now allows delete
    // sharing as required by POSIX replacement.
    if (success) {
      ParsedPath replacementPath = parsed;
      replacementPath.components.back() = temporaryName;
      HandleIdentity latestReplacement;
      success = ValidateSecurity(replacement, false, &failure, &latestReplacement)
          && EqualIdentity(latestReplacement, replacementIdentity)
          && ResolveFinalPath(replacement, &replacementPath);
      if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
    }
    if (success) {
      HandleIdentity latest;
      success = ValidateSecurity(opened.final, false, &failure, &latest)
          && EqualIdentity(latest, expected)
          && ResolveFinalPath(opened.final, &parsed);
      if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
    }
  }
  if (success) {
    // Legacy FileRenameInformation rejects replacement while the destination
    // handle is open. FileRenameInformationEx with
    // FILE_RENAME_POSIX_SEMANTICS permits the replacement while that handle
    // is open when the destination allows delete sharing. The old close path
    // (`opened.closeFinal()`) would recreate the identity-check/rename race;
    // this handle-bound operation preserves the identity check while the
    // protected ancestors remain held without delete sharing.
    success = RenameHandleRelative(replacement, parent, parsed.components.back(), &failure);
    renamed = success;
  }
  if (success) {
    // The replacement handle remains valid after rename.  Verify both content
    // and the name-to-handle identity before exposing the new identity.
    std::vector<std::uint8_t> persisted;
    LARGE_INTEGER beginning{};
    success = SetFilePointerEx(replacement, beginning, nullptr, FILE_BEGIN) != FALSE
        && ReadHandle(replacement, &persisted, &failure)
        && persisted.size() == byteCount
        && std::equal(persisted.begin(), persisted.end(), bytes);
    if (success) {
      HANDLE check = INVALID_HANDLE_VALUE;
      ULONG_PTR checkInformation = 0;
      if (!OpenRelativeComponent(
              parent,
              parsed.components.back(),
              READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
              kFileOpen,
              kFileNonDirectoryFile,
              nullptr,
              &check,
              &checkInformation,
              &failure)) {
        success = false;
      } else {
        HandleIdentity checkIdentity;
        success = ValidateSecurity(check, false, &failure, &checkIdentity)
            && EqualIdentity(checkIdentity, replacementIdentity)
            && ResolveFinalPath(check, &parsed);
        if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
        CloseHandle(check);
      }
    }
  }
  if (!success && !renamed && !MarkHandleForDeletion(replacement)) failure = OperationFailed();
  CloseHandle(replacement);
  if (!success) return ThrowFailure(env, failure);
  return IdentityValue(env, replacementIdentity);
}

napi_value InspectPathCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, &failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  bool valid = GetIdentity(opened.final, &identity)
      && ReadSecurity(opened.final, &security)
      && ResolveFinalPath(opened.final, &parsed);
  bool reparse = false;
  if (!HasReparsePoint(opened.final, &reparse)) valid = false;
  if (!valid) return ThrowFailure(env, OperationFailed());
  napi_value result = MetadataValue(env, identity, security, true);
  napi_value isReparse;
  napi_get_boolean(env, reparse, &isReparse);
  napi_set_named_property(env, result, "isReparsePoint", isReparse);
  return result;
}

napi_value InspectPreparedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          arguments,
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  if (!OpenPreparedExistingChild(
          rootPath,
          expectedRoot,
          childPath,
          false,
          false,
          FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          &opened,
          &fullPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!GetIdentity(opened.final, &identity)
      || !ReadSecurity(opened.final, &security)) {
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result = MetadataValue(env, identity, security, true);
  napi_value isReparse;
  napi_get_boolean(env, false, &isReparse);
  napi_set_named_property(env, result, "isReparsePoint", isReparse);
  return result;
}

napi_value EnsurePreparedDirectoryCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          arguments,
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  if (!OpenPreparedRootAndDirectory(
          rootPath,
          expectedRoot,
          childPath,
          true,
          &opened,
          &fullPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  if (!GetIdentity(opened.final, &identity)
      || !ValidateSecurity(opened.final, true, &failure, &identity)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  return IdentityValue(env, identity);
}

napi_value EnumeratePreparedDirectoryCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  std::size_t maximumEntries = 0;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)
      || !GetSafePreparedDirectoryMaximum(env, arguments[3], &maximumEntries)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  if (!OpenPreparedExistingChild(
          rootPath,
          expectedRoot,
          childPath,
          true,
          true,
          FILE_LIST_DIRECTORY | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          &opened,
          &fullPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity before;
  if (!GetIdentity(opened.final, &before)) {
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_array(env, &result);
  if (!EnumeratePreparedDirectoryEntries(
          opened.final,
          fullPath,
          maximumEntries,
          env,
          result,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity after;
  if (!ValidateSecurity(opened.final, true, &failure, &after)
      || !EqualIdentity(after, before)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    // The final directory is not the protected root; compare against its
    // identity captured before enumeration instead of the root identity.
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  return result;
}

napi_value RemovePreparedDirectoryCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  HandleIdentity expected;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)
      || !ParseExpectedIdentity(env, arguments[3], &expected)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  if (!OpenPreparedExistingChild(
          rootPath,
          expectedRoot,
          childPath,
          true,
          true,
          DELETE | FILE_LIST_DIRECTORY | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          &opened,
          &fullPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity current;
  if (!ValidateSecurity(opened.final, true, &failure, &current)
      || !EqualIdentity(current, expected)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  napi_value entries;
  napi_create_array(env, &entries);
  if (!EnumeratePreparedDirectoryEntries(
          opened.final,
          fullPath,
          1,
          env,
          entries,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  std::uint32_t entryCount = 0;
  if (napi_get_array_length(env, entries, &entryCount) != napi_ok) {
    return ThrowFailure(env, OperationFailed());
  }
  if (entryCount != 0) return ThrowFailure(env, PreparedDirectoryNotEmpty());
  HandleIdentity afterEnumeration;
  if (!ValidateSecurity(opened.final, true, &failure, &afterEnumeration)
      || !EqualIdentity(afterEnumeration, current)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          opened.final,
          FileDispositionInfo,
          &disposition,
          sizeof(disposition))) {
    return ThrowFailure(env, FromLastError());
  }
  if (!FlushPreparedDirectoryBoundary(opened.parents.back(), &failure)) {
    return ThrowFailure(env, failure);
  }
  napi_value result;
  napi_value removed;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &removed);
  napi_set_named_property(env, result, "removed", removed);
  napi_set_named_property(env, result, "identity", IdentityValue(env, current));
  return result;
}

napi_value RenamePreparedDirectoryCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 5)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring sourcePath;
  std::wstring targetPath;
  HandleIdentity expectedRoot;
  HandleIdentity expectedSource;
  Failure failure = OperationFailed();
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &sourcePath)
      || !ParseExpectedIdentity(env, arguments[3], &expectedSource)
      || !GetString(env, arguments[4], &targetPath)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring sourceName;
  std::wstring targetName;
  if (!SplitPreparedSiblingPaths(
          sourcePath,
          targetPath,
          &sourceName,
          &targetName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  ParsedPath parentFullPath;
  if (!OpenPreparedParentForChild(
          rootPath,
          expectedRoot,
          sourcePath,
          &opened,
          &parentFullPath,
          &sourceName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  // The helper returns the source basename through the final out parameter;
  // targetName was already validated from the same sibling path above.
  HANDLE parent = opened.parents.back();
  HANDLE source = INVALID_HANDLE_VALUE;
  if (!OpenRelativeComponent(
          parent,
          sourceName,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          kFileOpen,
          kFileDirectoryFile,
          nullptr,
          &source,
          nullptr,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  ParsedPath sourceFullPath = parentFullPath;
  sourceFullPath.components.push_back(sourceName);
  HandleIdentity current;
  if (!ValidateSecurity(source, true, &failure, &current)
      || !EqualIdentity(current, expectedSource)
      || !ResolveFinalPath(source, &sourceFullPath)) {
    CloseHandle(source);
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  HANDLE existingTarget = INVALID_HANDLE_VALUE;
  Failure targetFailure = OperationFailed();
  if (OpenRelativeComponent(
          parent,
          targetName,
          FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          kFileOpen,
          0,
          nullptr,
          &existingTarget,
          nullptr,
          &targetFailure)) {
    CloseHandle(existingTarget);
    CloseHandle(source);
    return ThrowFailure(env, AlreadyExists());
  }
  if (targetFailure.code != NotFound().code) {
    CloseHandle(source);
    return ThrowFailure(env, targetFailure);
  }
  if (!RenameHandleRelative(source, parent, targetName, &failure, false)
      || !FlushPreparedDirectoryBoundary(parent, &failure)) {
    CloseHandle(source);
    return ThrowFailure(env, failure);
  }
  ParsedPath targetFullPath = parentFullPath;
  targetFullPath.components.push_back(targetName);
  if (!ValidateSecurity(source, true, &failure, &current)
      || !ResolveFinalPath(source, &targetFullPath)) {
    CloseHandle(source);
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  CloseHandle(source);
  napi_value result;
  napi_value renamed;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &renamed);
  napi_set_named_property(env, result, "renamed", renamed);
  napi_set_named_property(env, result, "identity", IdentityValue(env, current));
  return result;
}

napi_value CreatePreparedFileCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)
      || !GetBuffer(env, arguments[3], &bytes, &byteCount)
      || byteCount < 1
      || byteCount > kMaximumPreparedArtifactBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  RelativeHandles opened;
  ParsedPath parentFullPath;
  std::wstring childName;
  if (!OpenPreparedParentForChild(
          rootPath,
          expectedRoot,
          childPath,
          &opened,
          &parentFullPath,
          &childName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HANDLE parent = opened.parents.back();
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONG_PTR information = 0;
  const bool created = OpenRelativeComponent(
      parent,
      childName,
      GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
          | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ,
      kFileCreate,
      kFileNonDirectoryFile,
      attributes.lpSecurityDescriptor,
      &handle,
      &information,
      &failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!created || information != kFileCreated) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return ThrowFailure(env, created ? AlreadyExists() : failure);
  }
  bool success = WriteAndFlushHandle(handle, bytes, byteCount, &failure)
      && SetOwnerOnlyDacl(handle);
  HandleIdentity identity;
  if (success && !ValidateSecurity(handle, false, &failure, &identity)) success = false;
  LARGE_INTEGER finalSize{};
  if (success && (!GetFileSizeEx(handle, &finalSize)
      || finalSize.QuadPart != static_cast<LONGLONG>(byteCount))) {
    success = false;
    failure = FileSizeChanged();
  }
  ParsedPath fullPath = parentFullPath;
  fullPath.components.push_back(childName);
  if (success && !ResolveFinalPath(handle, &fullPath)) {
    success = false;
    failure = IdentityMismatch();
  }
  if (!success) {
    if (!MarkHandleForDeletion(handle)) failure = OperationFailed();
    CloseHandle(handle);
    return ThrowFailure(env, failure);
  }
  CloseHandle(handle);
  return IdentityValue(env, identity);
}

napi_value ReadPreparedFileCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  std::size_t maximumBytes = 0;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)
      || !GetSafePreparedMaximum(env, arguments[3], &maximumBytes)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  if (!OpenPreparedExistingChild(
          rootPath,
          expectedRoot,
          childPath,
          true,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &opened,
          &fullPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  std::vector<std::uint8_t> bytes;
  HandleIdentity identity;
  if (!GetIdentity(opened.final, &identity)
      || !ReadHandleBounded(opened.final, maximumBytes, &bytes, &failure)
      || !ValidateSecurity(opened.final, false, &failure, &identity)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  napi_value result;
  napi_value data;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value DeletePreparedFileCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  HandleIdentity expected;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)
      || !ParseExpectedIdentity(env, arguments[3], &expected)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  RelativeHandles opened;
  ParsedPath parentFullPath;
  std::wstring childName;
  if (!OpenPreparedParentForChild(
          rootPath,
          expectedRoot,
          childPath,
          &opened,
          &parentFullPath,
          &childName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HANDLE parent = opened.parents.back();
  HANDLE handle = INVALID_HANDLE_VALUE;
  if (!OpenRelativeComponent(
          parent,
          childName,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          kFileOpen,
          kFileNonDirectoryFile,
          nullptr,
          &handle,
          nullptr,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  ParsedPath fullPath = parentFullPath;
  fullPath.components.push_back(childName);
  HandleIdentity current;
  if (!ValidateSecurity(handle, false, &failure, &current)
      || !EqualIdentity(current, expected)
      || !ResolveFinalPath(handle, &fullPath)) {
    CloseHandle(handle);
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  if (!MarkHandleForDeletion(handle)) {
    failure = FromLastError();
    CloseHandle(handle);
    return ThrowFailure(env, failure);
  }
  if (!FlushPreparedDirectoryBoundary(parent, &failure)) {
    CloseHandle(handle);
    return ThrowFailure(env, failure);
  }
  CloseHandle(handle);
  napi_value result;
  napi_value deleted;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &deleted);
  napi_set_named_property(env, result, "deleted", deleted);
  napi_set_named_property(env, result, "identity", IdentityValue(env, current));
  return result;
}

napi_value PublishPreparedFileCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 5)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring stagePath;
  std::wstring targetPath;
  HandleIdentity expectedRoot;
  HandleIdentity expectedStage;
  Failure failure = OperationFailed();
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &stagePath)
      || !ParseExpectedIdentity(env, arguments[3], &expectedStage)
      || !GetString(env, arguments[4], &targetPath)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring stageName;
  std::wstring targetName;
  if (!SplitPreparedSiblingPaths(
          stagePath,
          targetPath,
          &stageName,
          &targetName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  ParsedPath parentFullPath;
  if (!OpenPreparedParentForChild(
          rootPath,
          expectedRoot,
          stagePath,
          &opened,
          &parentFullPath,
          &stageName,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HANDLE parent = opened.parents.back();
  HANDLE stage = INVALID_HANDLE_VALUE;
  if (!OpenRelativeComponent(
          parent,
          stageName,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          kFileOpen,
          kFileNonDirectoryFile,
          nullptr,
          &stage,
          nullptr,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  ParsedPath stageFullPath = parentFullPath;
  stageFullPath.components.push_back(stageName);
  HandleIdentity identity;
  if (!ValidateSecurity(stage, false, &failure, &identity)
      || !EqualIdentity(identity, expectedStage)
      || !ResolveFinalPath(stage, &stageFullPath)) {
    CloseHandle(stage);
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  HANDLE existingTarget = INVALID_HANDLE_VALUE;
  Failure targetFailure = OperationFailed();
  if (OpenRelativeComponent(
          parent,
          targetName,
          FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          kFileOpen,
          0,
          nullptr,
          &existingTarget,
          nullptr,
          &targetFailure)) {
    CloseHandle(existingTarget);
    CloseHandle(stage);
    return ThrowFailure(env, AlreadyExists());
  }
  if (targetFailure.code != NotFound().code) {
    CloseHandle(stage);
    return ThrowFailure(env, targetFailure);
  }
  if (!RenameHandleRelative(stage, parent, targetName, &failure, false)
      || !FlushPreparedDirectoryBoundary(parent, &failure)) {
    CloseHandle(stage);
    return ThrowFailure(env, failure);
  }
  ParsedPath targetFullPath = parentFullPath;
  targetFullPath.components.push_back(targetName);
  if (!ValidateSecurity(stage, false, &failure, &identity)
      || !ResolveFinalPath(stage, &targetFullPath)) {
    CloseHandle(stage);
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  CloseHandle(stage);
  napi_value result;
  napi_value published;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &published);
  napi_set_named_property(env, result, "published", published);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value ReadFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());
  Failure failure = OperationFailed();
  HANDLE handle = INVALID_HANDLE_VALUE;
  HandleIdentity identity;
  if (!OpenSecureExisting(
          path,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &handle,
          &identity,
          &failure)) return ThrowFailure(env, failure);
  std::vector<std::uint8_t> bytes;
  const bool read = ReadHandle(handle, &bytes, &failure);
  CloseHandle(handle);
  if (!read) return ThrowFailure(env, failure);
  napi_value result;
  napi_value data;
  napi_value identityValue = IdentityValue(env, identity);
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", identityValue);
  return result;
}

napi_value ReadFileBoundedCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring path;
  std::size_t maximumBytes = 0;
  if (!GetString(env, arguments[0], &path)
      || !GetSafeReadMaximum(env, arguments[1], &maximumBytes)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  Failure failure = OperationFailed();
  HANDLE handle = INVALID_HANDLE_VALUE;
  HandleIdentity identity;
  if (!OpenSecureExisting(
          path,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &handle,
          &identity,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  std::vector<std::uint8_t> bytes;
  const bool read = ReadHandleBounded(handle, maximumBytes, &bytes, &failure);
  CloseHandle(handle);
  if (!read) return ThrowFailure(env, failure);
  napi_value result;
  napi_value data;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

bool ParseProtectedChildArguments(
    napi_env env,
    const std::vector<napi_value>& arguments,
    std::wstring* rootPath,
    HandleIdentity* expectedRoot,
    std::wstring* childPath,
    Failure* failure) {
  if (!GetString(env, arguments[0], rootPath)
      || !ParseExpectedIdentity(env, arguments[1], expectedRoot)
      || !GetString(env, arguments[2], childPath)) {
    *failure = InvalidConfiguration();
    return false;
  }
  return true;
}

napi_value InspectProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          arguments,
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  OpenRelativeOptions options;
  options.access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  options.finalDirectoryKnown = false;
  options.disposition = kFileOpen;
  RelativeHandles opened;
  bool finalMissing = false;
  ParsedPath fullPath;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &opened,
          &finalMissing,
          &fullPath,
          &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  bool valid = GetIdentity(opened.final, &identity)
      && ReadSecurity(opened.final, &security)
      && ResolveFinalPath(opened.final, &fullPath);
  bool reparse = false;
  if (!HasReparsePoint(opened.final, &reparse)) valid = false;
  if (!valid) return ThrowFailure(env, OperationFailed());
  napi_value result = MetadataValue(env, identity, security, true);
  napi_value isReparse;
  napi_get_boolean(env, reparse, &isReparse);
  napi_set_named_property(env, result, "isReparsePoint", isReparse);
  return result;
}

napi_value ReadProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  std::size_t maximumBytes = 0;
  Failure failure = OperationFailed();
  const bool validChildArguments = ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure);
  if (!validChildArguments
      || !GetSafeReadMaximum(env, arguments[3], &maximumBytes)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  OpenRelativeOptions options;
  options.access = GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.disposition = kFileOpen;
  RelativeHandles opened;
  bool finalMissing = false;
  ParsedPath fullPath;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &opened,
          &finalMissing,
          &fullPath,
          &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  if (!ValidateSecurity(opened.final, false, &failure, &identity)
      || !ResolveFinalPath(opened.final, &fullPath)) {
    return ThrowFailure(env, failure);
  }
  std::vector<std::uint8_t> bytes;
  if (!ReadHandleBounded(opened.final, maximumBytes, &bytes, &failure)) {
    return ThrowFailure(env, failure);
  }
  napi_value result;
  napi_value data;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value CreateProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetBuffer(env, arguments[3], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
      | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileCreate;
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = attributes.lpSecurityDescriptor;
  options.protectAllAncestors = true;
  RelativeHandles opened;
  bool finalMissing = false;
  ParsedPath fullPath;
  const bool openedOk = OpenProtectedRootAndChild(
      rootPath,
      expectedRoot,
      childPath,
      options,
      &opened,
      &finalMissing,
      &fullPath,
      &failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!openedOk || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }

  bool success = WriteAndFlushHandle(opened.final, bytes, byteCount, &failure)
      && SetOwnerOnlyDacl(opened.final);
  if (!success && failure.code == OperationFailed().code) {
    failure = SecurityPolicy("dacl_update_failed");
  }
  HandleIdentity identity;
  if (success && !ValidateSecurity(opened.final, false, &failure, &identity)) {
    success = false;
  }
  if (success && !ResolveFinalPath(opened.final, &fullPath)) {
    failure = IdentityMismatch();
    success = false;
  }
  if (!success) {
    if (!MarkHandleForDeletion(opened.final)) failure = OperationFailed();
    return ThrowFailure(env, failure);
  }
  return IdentityValue(env, identity);
}

napi_value ReplaceProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 5)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity expected;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!ParseExpectedIdentity(env, arguments[3], &expected)
      || !GetBuffer(env, arguments[4], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  OpenRelativeOptions targetOptions;
  targetOptions.finalDirectoryKnown = true;
  targetOptions.finalDirectory = false;
  targetOptions.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  // POSIX replacement requires the existing destination handle to permit
  // delete sharing. The protected ancestor handles still use their default
  // no-delete share mode, preserving the root-boundary protection.
  targetOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_DELETE;
  targetOptions.disposition = kFileOpen;
  targetOptions.protectAllAncestors = true;
  RelativeHandles opened;
  bool finalMissing = false;
  ParsedPath fullPath;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          childPath,
          targetOptions,
          &opened,
          &finalMissing,
          &fullPath,
          &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity current;
  if (!ValidateSecurity(opened.final, false, &failure, &current)
      || !EqualIdentity(current, expected)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  if (opened.parents.empty()) return ThrowFailure(env, OperationFailed());
  HANDLE parent = opened.parents.back();

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE replacement = INVALID_HANDLE_VALUE;
  std::wstring temporaryName;
  ULONG_PTR createInformation = 0;
  for (int attempt = 0; attempt < 8; ++attempt) {
    temporaryName = TemporaryReplacementName();
    if (OpenRelativeComponent(
            parent,
            temporaryName,
            FILE_READ_DATA | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
                | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            kFileCreate,
            kFileNonDirectoryFile,
            attributes.lpSecurityDescriptor,
            &replacement,
            &createInformation,
            &failure)) {
      break;
    }
    if (failure.code != AlreadyExists().code) {
      FreeOwnerOnlySecurity(acl, descriptor);
      return ThrowFailure(env, failure);
    }
  }
  FreeOwnerOnlySecurity(acl, descriptor);
  if (replacement == INVALID_HANDLE_VALUE) return ThrowFailure(env, AlreadyExists());

  bool renamed = false;
  bool success = WriteAndFlushHandle(replacement, bytes, byteCount, &failure)
      && SetOwnerOnlyDacl(replacement);
  HandleIdentity replacementIdentity;
  if (success && !ValidateSecurity(replacement, false, &failure, &replacementIdentity)) {
    success = false;
  }
  if (success) {
    // Complete every replacement-handle check before the name mutation.  A
    // successful rename is deliberately the last fallible filesystem step;
    // returning an identity after it therefore cannot hide a failed
    // post-commit verification.
    std::vector<std::uint8_t> persisted;
    LARGE_INTEGER beginning{};
    ParsedPath replacementPath = fullPath;
    replacementPath.components.back() = temporaryName;
    if (SetFilePointerEx(replacement, beginning, nullptr, FILE_BEGIN) == FALSE) {
      failure = FromLastError();
      success = false;
    } else if (!ReadHandleBounded(
                   replacement,
                   kMaximumFileBytes,
                   &persisted,
                   &failure)) {
      success = false;
    } else if (persisted.size() != byteCount
        || !std::equal(persisted.begin(), persisted.end(), bytes)) {
      failure = IdentityMismatch();
      success = false;
    } else if (!ResolveFinalPath(replacement, &replacementPath)) {
      failure = IdentityMismatch();
      success = false;
    }
  }
  if (success) {
    // Repeat the replacement-handle security and identity checks after the
    // content readback and immediately before the target check/rename.
    ParsedPath replacementPath = fullPath;
    replacementPath.components.back() = temporaryName;
    HandleIdentity latestReplacement;
    success = ValidateSecurity(replacement, false, &failure, &latestReplacement)
        && EqualIdentity(latestReplacement, replacementIdentity)
        && ResolveFinalPath(replacement, &replacementPath);
    if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
  }
  if (success) {
    HandleIdentity latest;
    success = ValidateSecurity(opened.final, false, &failure, &latest)
        && EqualIdentity(latest, expected)
        && ResolveFinalPath(opened.final, &fullPath);
    if (!success && failure.code == OperationFailed().code) failure = IdentityMismatch();
  }
  if (success) {
    success = RenameHandleRelative(
        replacement,
        parent,
        fullPath.components.back(),
        &failure);
    renamed = success;
  }
  if (!success && !renamed && !MarkHandleForDeletion(replacement)) {
    failure = OperationFailed();
  }
  CloseHandle(replacement);
  if (!success) return ThrowFailure(env, failure);
  return IdentityValue(env, replacementIdentity);
}

bool ParseSqliteStagingNames(
    napi_env env,
    const std::vector<napi_value>& arguments,
    std::wstring* rootPath,
    HandleIdentity* expectedRoot,
    std::wstring* stageName,
    HandleIdentity* expectedStage,
    std::wstring* targetName,
    bool* targetExpectedPresent,
    HandleIdentity* expectedTarget,
    Failure* failure) {
  if (!GetString(env, arguments[0], rootPath)
      || !ParseExpectedIdentity(env, arguments[1], expectedRoot)
      || !GetString(env, arguments[2], stageName)
      || !ParseExpectedIdentity(env, arguments[3], expectedStage)
      || !GetString(env, arguments[4], targetName)) {
    *failure = InvalidConfiguration();
    return false;
  }
  std::wstring normalizedStage;
  std::wstring normalizedTarget;
  if (!ParseSqliteDatabaseName(*stageName, &normalizedStage, failure)
      || !ParseSqliteDatabaseName(*targetName, &normalizedTarget, failure)) {
    return false;
  }
  if (EqualInsensitive(normalizedStage, normalizedTarget.c_str())) {
    *failure = InvalidPath();
    return false;
  }
  *stageName = std::move(normalizedStage);
  *targetName = std::move(normalizedTarget);

  napi_valuetype targetType = napi_undefined;
  if (napi_typeof(env, arguments[5], &targetType) != napi_ok) {
    *failure = InvalidConfiguration();
    return false;
  }
  if (targetType == napi_null || targetType == napi_undefined) {
    *targetExpectedPresent = false;
    return true;
  }
  if (!ParseExpectedIdentity(env, arguments[5], expectedTarget)) {
    *failure = InvalidConfiguration();
    return false;
  }
  *targetExpectedPresent = true;
  return true;
}

bool OpenSqliteStagingChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childName,
    bool createNew,
    bool existingWriteAccess,
    RelativeHandles* opened,
    ParsedPath* fullPath,
    HandleIdentity* identity,
    Failure* failure) {
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_READ | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  if (createNew || existingWriteAccess) {
    options.access |= GENERIC_WRITE;
  }
  if (createNew) {
    options.access |= WRITE_DAC;
  }
  // Hold the file against ordinary writes and deletes until the operation is
  // complete.  Ancestors remain held by OpenProtectedRootAndChild as well.
  options.shareMode = FILE_SHARE_READ;
  options.disposition = createNew ? kFileCreate : kFileOpen;
  options.ownerOnlyOnCreate = createNew;
  options.protectAllAncestors = true;
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (createNew) {
    if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
      *failure = OperationFailed();
      return false;
    }
    options.securityDescriptor = attributes.lpSecurityDescriptor;
  }
  bool finalMissing = false;
  const bool openedOk = OpenProtectedRootAndChild(
      rootPath,
      expectedRoot,
      childName,
      options,
      opened,
      &finalMissing,
      fullPath,
      failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!openedOk || finalMissing || opened->final == INVALID_HANDLE_VALUE) {
    return false;
  }
  const auto rejectCreated = [&]() {
    if (createNew && opened->final != INVALID_HANDLE_VALUE) {
      if (!MarkHandleForDeletion(opened->final)) *failure = OperationFailed();
    }
  };
  if (createNew && !SetOwnerOnlyDacl(opened->final)) {
    *failure = SecurityPolicy("dacl_update_failed");
    rejectCreated();
    return false;
  }
  if (!ValidateSqliteStagingHandle(opened->final, *fullPath, identity, failure)) {
    rejectCreated();
    return false;
  }
  return true;
}

napi_value CreateSqliteDatabaseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring databaseName;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &databaseName)
      || !ParseSqliteDatabaseName(databaseName, &databaseName, &failure)) {
    return ThrowFailure(env, failure.code == OperationFailed().code
        ? InvalidConfiguration()
        : failure);
  }
  RelativeHandles opened;
  ParsedPath fullPath;
  HandleIdentity identity;
  if (!OpenSqliteStagingChild(
          rootPath,
          expectedRoot,
          databaseName,
          true,
          false,
          &opened,
          &fullPath,
          &identity,
          &failure)
      || !RequireSqliteSidecarsAbsent(opened.parents.front(), databaseName, &failure)
      || !FlushFileBuffers(opened.final)) {
    if (failure.code == OperationFailed().code && GetLastError() != ERROR_SUCCESS) {
      failure = FromLastError();
    }
    if (opened.final != INVALID_HANDLE_VALUE) MarkHandleForDeletion(opened.final);
    return ThrowFailure(env, failure);
  }
  return IdentityValue(env, identity);
}

napi_value CloneSqliteDatabaseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring sourceName;
  std::wstring stageName;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &sourceName)
      || !GetString(env, arguments[3], &stageName)
      || !ParseSqliteDatabaseName(sourceName, &sourceName, &failure)
      || !ParseSqliteDatabaseName(stageName, &stageName, &failure)
      || EqualInsensitive(sourceName, stageName.c_str())) {
    if (failure.code == OperationFailed().code) failure = InvalidConfiguration();
    if (failure.code == InvalidConfiguration().code) return ThrowFailure(env, failure);
    return ThrowFailure(env, failure);
  }
  RelativeHandles source;
  ParsedPath sourcePath;
  HandleIdentity sourceIdentity;
  if (!OpenSqliteStagingChild(
          rootPath,
          expectedRoot,
          sourceName,
          false,
          false,
          &source,
          &sourcePath,
          &sourceIdentity,
          &failure)
      || !RequireSqliteSidecarsAbsent(source.parents.front(), sourceName, &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles stage;
  ParsedPath stagePath;
  HandleIdentity stageIdentity;
  if (!OpenSqliteStagingChild(
          rootPath,
          expectedRoot,
          stageName,
          true,
          false,
          &stage,
          &stagePath,
          &stageIdentity,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  if (!CopyHandleToHandle(source.final, stage.final, &failure)
      || !RequireSqliteSidecarsAbsent(stage.parents.front(), stageName, &failure)
      || !ValidateSqliteStagingHandle(stage.final, stagePath, &stageIdentity, &failure)) {
    if (stage.final != INVALID_HANDLE_VALUE) MarkHandleForDeletion(stage.final);
    return ThrowFailure(env, failure);
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "sourceIdentity", IdentityValue(env, sourceIdentity));
  napi_set_named_property(env, result, "stageIdentity", IdentityValue(env, stageIdentity));
  return result;
}

napi_value PublishSqliteDatabaseCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  Failure failure = OperationFailed();
  if (!GetArguments(env, info, &arguments, 6)) {
    failure = InvalidConfiguration();
    failure.stage = "publish_parse";
    return ThrowFailure(env, failure);
  }
  std::wstring rootPath;
  std::wstring stageName;
  std::wstring targetName;
  HandleIdentity expectedRoot;
  HandleIdentity expectedStage;
  HandleIdentity expectedTarget;
  bool targetExpectedPresent = false;
  if (!ParseSqliteStagingNames(
          env,
          arguments,
          &rootPath,
          &expectedRoot,
          &stageName,
          &expectedStage,
          &targetName,
          &targetExpectedPresent,
          &expectedTarget,
          &failure)) {
    failure.stage = "publish_parse";
    return ThrowFailure(env, failure);
  }

  RelativeHandles stage;
  ParsedPath stagePath;
  HandleIdentity stageIdentity;
  if (!OpenSqliteStagingChild(
          rootPath,
          expectedRoot,
          stageName,
          false,
          true,
          &stage,
          &stagePath,
          &stageIdentity,
          &failure)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    failure.stage = "publish_stage_open";
    return ThrowFailure(env, failure);
  }
  if (!EqualIdentity(stageIdentity, expectedStage)
      || !RequireSqliteSidecarsAbsent(stage.parents.front(), stageName, &failure)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    failure.stage = "publish_stage_preflight";
    return ThrowFailure(env, failure);
  }
  if (!FlushFileBuffers(stage.final)) {
    failure = FromLastError();
    failure.stage = "publish_stage_preflight";
    return ThrowFailure(env, failure);
  }

  OpenRelativeOptions targetOptions;
  targetOptions.finalDirectoryKnown = true;
  targetOptions.finalDirectory = false;
  targetOptions.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  // POSIX replacement requires the existing destination handle to permit
  // delete sharing. The protected root handle remains held without delete
  // sharing, preserving the root-boundary protection during publication.
  targetOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_DELETE;
  targetOptions.protectedAncestorDepth = 1;
  targetOptions.disposition = kFileOpen;
  RelativeHandles target;
  bool targetMissing = false;
  ParsedPath targetPath;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          targetName,
          targetOptions,
          &target,
          &targetMissing,
          &targetPath,
          &failure)) {
    failure.stage = "publish_target_open";
    return ThrowFailure(env, failure);
  }
  if (targetMissing || target.final == INVALID_HANDLE_VALUE) {
    if (targetExpectedPresent) {
      failure = IdentityMismatch();
      failure.stage = "publish_target_preflight";
      return ThrowFailure(env, failure);
    }
  } else {
    HandleIdentity targetIdentity;
    if (!ValidateSqliteStagingHandle(target.final, targetPath, &targetIdentity, &failure)
        || !targetExpectedPresent
        || !EqualIdentity(targetIdentity, expectedTarget)
        || !RequireSqliteSidecarsAbsent(target.parents.front(), targetName, &failure)) {
      if (failure.code == OperationFailed().code) failure = IdentityMismatch();
      failure.stage = "publish_target_preflight";
      return ThrowFailure(env, failure);
    }
  }
  if (stage.parents.empty()) {
    failure = OperationFailed();
    failure.stage = "publish_stage_revalidate";
    return ThrowFailure(env, failure);
  }
  // Revalidate the staged source after the target walk and immediately before
  // publication. This repeats the security, identity, canonical-path, and
  // sidecar checks at the final fallible point before the handle-relative
  // rename.
  if (!ValidateSqliteStagingHandle(stage.final, stagePath, &stageIdentity, &failure)
      || !EqualIdentity(stageIdentity, expectedStage)
      || !RequireSqliteSidecarsAbsent(stage.parents.front(), stageName, &failure)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    failure.stage = "publish_stage_revalidate";
    return ThrowFailure(env, failure);
  }
  if (!targetMissing && target.final != INVALID_HANDLE_VALUE) {
    HandleIdentity targetIdentity;
    if (!ValidateSqliteStagingHandle(target.final, targetPath, &targetIdentity, &failure)
        || !targetExpectedPresent
        || !EqualIdentity(targetIdentity, expectedTarget)
        || !RequireSqliteSidecarsAbsent(target.parents.front(), targetName, &failure)) {
      if (failure.code == OperationFailed().code) failure = IdentityMismatch();
      failure.stage = "publish_target_revalidate";
      return ThrowFailure(env, failure);
    }
  }
  if (!RenameHandleRelative(
          stage.final,
          stage.parents.front(),
          targetName,
          &failure)) {
    // RenameHandleRelative reports its generic helper stage. Replace it here
    // with the bounded publish vocabulary before crossing the N-API boundary.
    failure.stage = "publish_rename";
    return ThrowFailure(env, failure);
  }
  // The stage handle is now the published target. Validate its security and
  // identity without requiring a final-path lookup on the renamed source
  // handle. The old destination handle remains open for the operation, so
  // verify the new directory entry through a fresh handle-relative open.
  targetPath.components.back() = targetName;
  HandleIdentity publishedIdentity;
  if (!ValidateSecurity(stage.final, false, &failure, &publishedIdentity)
      || !EqualIdentity(publishedIdentity, expectedStage)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    failure.stage = "publish_stage_postvalidate";
    return ThrowFailure(env, failure);
  }
  HANDLE publishedTarget = INVALID_HANDLE_VALUE;
  if (!OpenPublishedTargetForValidation(
          stage.parents.front(),
          targetName,
          &publishedTarget,
          &failure)) {
    failure.stage = "publish_target_postopen";
    return ThrowFailure(env, failure);
  }
  HandleIdentity targetIdentity;
  const bool publishedTargetValid = ValidateSqliteStagingHandle(
      publishedTarget,
      targetPath,
      &targetIdentity,
      &failure);
  CloseHandle(publishedTarget);
  if (!publishedTargetValid
      || !EqualIdentity(targetIdentity, publishedIdentity)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    failure.stage = "publish_target_postvalidate";
    return ThrowFailure(env, failure);
  }
  stageIdentity = publishedIdentity;
  napi_value result;
  napi_value published;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &published);
  napi_set_named_property(env, result, "published", published);
  napi_set_named_property(env, result, "identity", IdentityValue(env, stageIdentity));
  return result;
}

napi_value DeleteProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!ParseProtectedChildArguments(
          env,
          {arguments[0], arguments[1], arguments[2]},
          &rootPath,
          &expectedRoot,
          &childPath,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity expected;
  if (!ParseExpectedIdentity(env, arguments[3], &expected)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  options.protectAllAncestors = true;
  RelativeHandles opened;
  bool finalMissing = false;
  ParsedPath fullPath;
  if (!OpenProtectedRootAndChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &opened,
          &finalMissing,
          &fullPath,
          &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity current;
  if (!ValidateSecurity(opened.final, false, &failure, &current)
      || !EqualIdentity(current, expected)) {
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  if (!ResolveFinalPath(opened.final, &fullPath)) {
    failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          opened.final,
          FileDispositionInfo,
          &disposition,
          sizeof(disposition))) {
    return ThrowFailure(env, FromLastError());
  }
  napi_value result;
  napi_value deleted;
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &deleted);
  napi_set_named_property(env, result, "deleted", deleted);
  napi_set_named_property(env, result, "identity", IdentityValue(env, current));
  return result;
}

struct OwnerOnlySecurityResources {
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};

  ~OwnerOnlySecurityResources() {
    if (descriptor != nullptr) LocalFree(descriptor);
    if (acl != nullptr) LocalFree(acl);
  }

  bool initialize() {
    return BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes);
  }
};

bool EnsureDirectoryPath(
    const ParsedPath& parsed,
    HANDLE* finalHandle,
    HandleIdentity* identity,
    Failure* failure) {
  OwnerOnlySecurityResources security;
  if (!security.initialize()) {
    *failure = OperationFailed();
    return false;
  }
  RelativeHandles opened;
  HANDLE root = INVALID_HANDLE_VALUE;
  if (!OpenRootDirectory(parsed.root, &root, failure)) return false;
  opened.parents.push_back(root);
  HANDLE current = root;

  for (std::size_t index = 0; index < parsed.components.size(); ++index) {
    const bool final = index + 1 == parsed.components.size();
    HANDLE next = INVALID_HANDLE_VALUE;
    bool created = false;
    Failure lastFailure = OperationFailed();

    // Existing ancestors always use the directory-only FILE_OPEN path.  A
    // missing component is created separately, relative to the held parent;
    // this keeps the traversal contract independent from final-object
    // dispositions and avoids applying a file access mask to directories.
    for (int attempt = 0; attempt < 2; ++attempt) {
      ULONG_PTR information = 0;
      if (OpenRelativeComponent(
              current,
              parsed.components[index],
              kDirectoryTraversalAccess,
              kDirectoryShareMode,
              kFileOpen,
              kFileDirectoryFile,
              nullptr,
              &next,
              &information,
              &lastFailure)) {
        created = false;
        break;
      }
      if (lastFailure.code != NotFound().code) {
        *failure = lastFailure;
        return false;
      }

      ULONG_PTR createInformation = 0;
      if (OpenRelativeComponent(
              current,
              parsed.components[index],
              kDirectoryTraversalAccess | WRITE_DAC | DELETE,
              kDirectoryShareMode,
              kFileCreate,
              kFileDirectoryFile,
              security.attributes.lpSecurityDescriptor,
              &next,
              &createInformation,
              &lastFailure)) {
        created = createInformation == kFileCreated;
        break;
      }
      // Another creator may have won the same parent-relative name between
      // our FILE_OPEN and FILE_CREATE calls.  Reopen it with FILE_OPEN and
      // apply the same reparse/type checks below.
      if (lastFailure.code != AlreadyExists().code) {
        *failure = lastFailure;
        return false;
      }
    }
    if (next == INVALID_HANDLE_VALUE) {
      *failure = lastFailure;
      return false;
    }

    DWORD attributes = 0;
    bool reparse = false;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = OperationFailed();
      CloseHandle(next);
      return false;
    }
    if (reparse) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = ReparsePoint();
      CloseHandle(next);
      return false;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = NotDirectory();
      CloseHandle(next);
      return false;
    }

    if (created) {
      // The create call requests WRITE_DAC and supplies the protected
      // descriptor.  Reapply and validate through the same handle so a
      // post-create policy failure never leaves an unmanaged directory.
      if (!SetOwnerOnlyDacl(next)) {
        *failure = SecurityPolicy("dacl_update_failed");
        if (!MarkHandleForDeletion(next)) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
      if (!ValidateSecurity(next, true, failure, nullptr)) {
        if (!MarkHandleForDeletion(next)) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
    }

    if (final) {
      if (!ValidateSecurity(next, true, failure, identity)
          || !ResolveFinalPath(next, &parsed)) {
        if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
        else if (failure->code == OperationFailed().code) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
      opened.final = next;
      *finalHandle = opened.releaseFinal();
      return *finalHandle != INVALID_HANDLE_VALUE;
    }
    opened.parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

napi_value EnsureDirectoryCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());
  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParsePath(path, &parsed)) return ThrowFailure(env, InvalidPath());
  HANDLE finalHandle = INVALID_HANDLE_VALUE;
  HandleIdentity identity;
  if (!EnsureDirectoryPath(parsed, &finalHandle, &identity, &failure)) {
    return ThrowFailure(env, failure);
  }
  CloseHandle(finalHandle);
  return IdentityValue(env, identity);
}

napi_value CreateFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetString(env, arguments[0], &path)
      || !GetBuffer(env, arguments[1], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) return ThrowFailure(env, InvalidConfiguration());

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, true, &parsed, &failure)) return ThrowFailure(env, failure);
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
      | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileCreate;
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = attributes.lpSecurityDescriptor;
  bool finalMissing = false;
  const bool openedOk = OpenRelativePath(parsed, options, &opened, &finalMissing, &failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!openedOk || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HANDLE handle = opened.releaseFinal();
  if (handle == INVALID_HANDLE_VALUE) return ThrowFailure(env, OperationFailed());
  bool success = true;
  std::size_t offset = 0;
  while (offset < byteCount) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(byteCount - offset, 1 << 20));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, requested, &written, nullptr) || written == 0) {
      success = false;
      failure = FromLastError();
      break;
    }
    offset += written;
  }
  HandleIdentity identity;
  if (success && !FlushFileBuffers(handle)) {
    success = false;
    failure = FromLastError();
  }
  if (success && !SetOwnerOnlyDacl(handle)) {
    success = false;
    failure = SecurityPolicy("dacl_update_failed");
  }
  if (success && !ValidateSecurity(handle, false, &failure, &identity)) success = false;
  if (!success && !MarkHandleForDeletion(handle)) {
    failure = OperationFailed();
  }
  CloseHandle(handle);
  if (!success) return ThrowFailure(env, failure);

  HANDLE reopened = INVALID_HANDLE_VALUE;
  HandleIdentity reopenedIdentity;
  if (!OpenSecureExisting(
          path,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &reopened,
          &reopenedIdentity,
          &failure)) return ThrowFailure(env, failure);
  CloseHandle(reopened);
  if (!EqualIdentity(identity, reopenedIdentity)) return ThrowFailure(env, IdentityMismatch());
  return IdentityValue(env, reopenedIdentity);
}

napi_value DeleteFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  HandleIdentity expected;
  if (!GetString(env, arguments[0], &path)
      || !ParseExpectedIdentity(env, arguments[1], &expected)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  Failure failure = OperationFailed();
  HANDLE handle = INVALID_HANDLE_VALUE;
  HandleIdentity current;
  if (!OpenSecureExisting(
          path,
          false,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          &handle,
          &current,
          &failure)) return ThrowFailure(env, failure);
  if (!EqualIdentity(expected, current)) {
    CloseHandle(handle);
    return ThrowFailure(env, IdentityMismatch());
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition))) {
    failure = FromLastError();
    CloseHandle(handle);
    return ThrowFailure(env, failure);
  }
  CloseHandle(handle);
  napi_value result;
  napi_value deleted;
  napi_value identityValue = IdentityValue(env, current);
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &deleted);
  napi_set_named_property(env, result, "deleted", deleted);
  napi_set_named_property(env, result, "identity", identityValue);
  return result;
}

struct CredentialAuditFileGuard {
  std::vector<HANDLE> handles;
  bool active = false;
};

std::array<CredentialAuditFileGuard*, 64> gCredentialAuditFileGuards{};
std::mutex gCredentialAuditFileGuardsMutex;

bool IsIssuedCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  return std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      guard) != gCredentialAuditFileGuards.end();
}

bool RegisterCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  const auto available = std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      nullptr);
  if (available == gCredentialAuditFileGuards.end()) return false;
  *available = guard;
  return true;
}

bool UnregisterCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  const auto existing = std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      guard);
  if (existing == gCredentialAuditFileGuards.end()) return false;
  *existing = nullptr;
  return true;
}

void FinalizeCredentialAuditFileGuard(napi_env, void* data, void*) {
  auto* guard = static_cast<CredentialAuditFileGuard*>(data);
  if (guard == nullptr) return;
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  const bool issued = UnregisterCredentialAuditFileGuard(guard);
  if (issued && guard->active) {
    for (auto iterator = guard->handles.rbegin(); iterator != guard->handles.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    guard->handles.clear();
    guard->active = false;
  }
  delete guard;
}

napi_value AcquireCredentialAuditFileGuardCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  Failure failure = OperationFailed();
  ParsedPath parsed;
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = 2;
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE
      || opened.parents.size() < 2) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!ValidateSecurity(opened.final, false, &failure, &identity, &security)
      || !ResolveFinalPath(opened.final, &parsed)) {
    return ThrowFailure(env, failure);
  }
  if (security.denyAce
      || security.ownerAllowAceCount != 1
      || security.ownerAllowMask != FILE_ALL_ACCESS) {
    return ThrowFailure(env, SecurityPolicy("credential_audit_guard_security"));
  }
  for (std::size_t offset = 0; offset < 2; ++offset) {
    SecuritySnapshot directorySecurity;
    HANDLE directory = opened.parents[opened.parents.size() - 1 - offset];
    if (!ValidateSecurity(directory, true, &failure, nullptr, &directorySecurity)
        || directorySecurity.denyAce
        || directorySecurity.ownerAllowAceCount != 1
        || directorySecurity.ownerAllowMask != FILE_ALL_ACCESS) {
      return ThrowFailure(env, SecurityPolicy("credential_audit_directory_security"));
    }
  }
  std::vector<HANDLE> guardedHandles;
  guardedHandles.reserve(3);
  for (std::size_t offset = 0; offset < 2; ++offset) {
    const std::size_t index = opened.parents.size() - 1 - offset;
    guardedHandles.push_back(opened.parents[index]);
    opened.parents[index] = INVALID_HANDLE_VALUE;
  }
  guardedHandles.push_back(opened.releaseFinal());
  auto* guard = new (std::nothrow) CredentialAuditFileGuard{
      std::move(guardedHandles),
      true,
  };
  if (guard == nullptr) {
    for (HANDLE guarded : guardedHandles) {
      if (guarded != INVALID_HANDLE_VALUE) CloseHandle(guarded);
    }
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (!RegisterCredentialAuditFileGuard(guard)) {
      for (HANDLE guarded : guard->handles) {
        if (guarded != INVALID_HANDLE_VALUE) CloseHandle(guarded);
      }
      delete guard;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(
          env,
          guard,
          FinalizeCredentialAuditFileGuard,
          nullptr,
          &external) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "guard", external);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value ReleaseCredentialAuditFileGuardCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_external) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  auto* guard = static_cast<CredentialAuditFileGuard*>(data);
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  if (!IsIssuedCredentialAuditFileGuard(guard)
      || !guard->active
      || guard->handles.empty()) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  UnregisterCredentialAuditFileGuard(guard);
  bool closed = true;
  for (auto iterator = guard->handles.rbegin(); iterator != guard->handles.rend(); ++iterator) {
    if (*iterator != INVALID_HANDLE_VALUE && !CloseHandle(*iterator)) closed = false;
  }
  guard->handles.clear();
  guard->active = false;
  if (!closed) return ThrowFailure(env, CredentialAuditGuardReleaseFailed());
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

struct SqliteStateLease {
  std::vector<HANDLE> handles;
  HandleIdentity databaseIdentity;
  HandleIdentity journalIdentity;
  HANDLE coordination = nullptr;
  DWORD ownerThreadId = 0;
  bool coordinationHeld = false;
  bool active = false;
};

std::array<SqliteStateLease*, 128> gSqliteStateLeases{};
std::mutex gSqliteStateLeasesMutex;

bool IsIssuedSqliteStateLease(SqliteStateLease* lease) {
  return std::find(
      gSqliteStateLeases.begin(),
      gSqliteStateLeases.end(),
      lease) != gSqliteStateLeases.end();
}

bool RegisterSqliteStateLease(SqliteStateLease* lease) {
  const auto available = std::find(
      gSqliteStateLeases.begin(),
      gSqliteStateLeases.end(),
      nullptr);
  if (available == gSqliteStateLeases.end()) return false;
  *available = lease;
  return true;
}

bool UnregisterSqliteStateLease(SqliteStateLease* lease) {
  const auto existing = std::find(
      gSqliteStateLeases.begin(),
      gSqliteStateLeases.end(),
      lease);
  if (existing == gSqliteStateLeases.end()) return false;
  *existing = nullptr;
  return true;
}

void CloseSqliteStateLeaseHandles(SqliteStateLease* lease) {
  for (auto iterator = lease->handles.rbegin();
       iterator != lease->handles.rend();
       ++iterator) {
    if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
  }
  lease->handles.clear();
  if (lease->coordination != nullptr) {
    if (lease->coordinationHeld && lease->ownerThreadId == GetCurrentThreadId()) {
      ReleaseMutex(lease->coordination);
    }
    CloseHandle(lease->coordination);
    lease->coordination = nullptr;
    lease->coordinationHeld = false;
  }
  lease->active = false;
}

void FinalizeSqliteStateLease(napi_env, void* data, void*) {
  auto* lease = static_cast<SqliteStateLease*>(data);
  if (lease == nullptr) return;
  const std::lock_guard<std::mutex> lock(gSqliteStateLeasesMutex);
  const bool issued = UnregisterSqliteStateLease(lease);
  if (issued && lease->active) CloseSqliteStateLeaseHandles(lease);
  delete lease;
}

void AppendHandles(std::vector<HANDLE>* destination, std::vector<HANDLE>&& source) {
  destination->reserve(destination->size() + source.size());
  for (HANDLE handle : source) destination->push_back(handle);
}

std::wstring SqliteStateLeaseMutexName(
    const HandleIdentity& rootIdentity,
    const HandleIdentity& databaseIdentity) {
  std::wostringstream stream;
  stream << L"Local\\TiboTattle-SqliteStateLease-v1-"
         << std::hex << std::setfill(L'0') << std::setw(16)
         << rootIdentity.volumeSerialNumber << L'-';
  for (BYTE byte : rootIdentity.fileId) {
    stream << std::setw(2) << static_cast<unsigned int>(byte);
  }
  stream << L'-' << std::setw(16) << databaseIdentity.volumeSerialNumber << L'-';
  for (BYTE byte : databaseIdentity.fileId) {
    stream << std::setw(2) << static_cast<unsigned int>(byte);
  }
  return stream.str();
}

bool AcquireSqliteStateLeaseMutex(
    const HandleIdentity& rootIdentity,
    const HandleIdentity& databaseIdentity,
    HANDLE* result,
    Failure* failure) {
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kCredentialMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    *failure = OperationFailed();
    return false;
  }
  const std::wstring name = SqliteStateLeaseMutexName(rootIdentity, databaseIdentity);
  HANDLE mutex = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kCredentialMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (mutex == nullptr) {
    *failure = FromLastError();
    return false;
  }
  SecuritySnapshot security;
  if (!ReadObjectSecurity(mutex, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurity(security)) {
    CloseHandle(mutex);
    *failure = SecurityPolicy("sqlite_state_lease_mutex_security");
    return false;
  }
  const DWORD waitResult = WaitForSingleObject(mutex, 0);
  if (waitResult == WAIT_TIMEOUT) {
    CloseHandle(mutex);
    *failure = SqliteStateLeaseContended();
    return false;
  }
  if (waitResult == WAIT_ABANDONED_0) {
    // The previous process has already lost every database, journal, and
    // sidecar reservation handle.  Windows transfers ownership of the mutex
    // to this caller, so retain it and let SQLite perform its bounded hot
    // rollback-journal recovery before exposing a session.  The production
    // capability bit remains false until native qualification proves this
    // crash/reopen path across the supported filesystem matrix.
    *result = mutex;
    return true;
  }
  if (waitResult != WAIT_OBJECT_0) {
    CloseHandle(mutex);
    *failure = OperationFailed();
    return false;
  }
  *result = mutex;
  return true;
}

napi_value AcquireSqliteStateLeaseCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring rootPath;
  std::wstring suppliedDatabaseName;
  std::wstring databaseName;
  HandleIdentity expectedRoot;
  Failure failure = OperationFailed();
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &suppliedDatabaseName)
      || !ParseSqliteDatabaseName(suppliedDatabaseName, &databaseName, &failure)) {
    return ThrowFailure(env, failure.code == OperationFailed().code
        ? InvalidConfiguration()
        : failure);
  }
  if (databaseName.size() > static_cast<std::size_t>(USHRT_MAX / sizeof(wchar_t)) - 7) {
    return ThrowFailure(env, InvalidPath());
  }
  const std::wstring journalName = databaseName + L"-journal";
  const std::wstring walName = databaseName + L"-wal";
  const std::wstring shmName = databaseName + L"-shm";

  ParsedPath parsedRoot;
  if (!ParseAndValidatePath(rootPath, false, &parsedRoot, &failure)) {
    return ThrowFailure(env, failure);
  }
  OpenRelativeOptions rootOptions;
  rootOptions.finalDirectoryKnown = true;
  rootOptions.finalDirectory = true;
  rootOptions.access = kDirectoryTraversalAccess;
  rootOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.protectedAncestorDepth = parsedRoot.components.size() - 1;
  rootOptions.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  rootOptions.disposition = kFileOpen;
  RelativeHandles rootOpened;
  bool rootMissing = false;
  if (!OpenRelativePath(
          parsedRoot,
          rootOptions,
          &rootOpened,
          &rootMissing,
          &failure)
      || rootMissing
      || rootOpened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }

  HandleIdentity observedRoot;
  SecuritySnapshot rootSecurity;
  if (!ValidateSecurity(
          rootOpened.final,
          true,
          &failure,
          &observedRoot,
          &rootSecurity)
      || rootSecurity.denyAce
      || rootSecurity.ownerAllowAceCount != 1
      || rootSecurity.ownerAllowMask != FILE_ALL_ACCESS
      || !EqualIdentity(observedRoot, expectedRoot)
      || !ResolveFinalPath(rootOpened.final, &parsedRoot)) {
    if (rootSecurity.denyAce
        || rootSecurity.ownerAllowAceCount != 1
        || rootSecurity.ownerAllowMask != FILE_ALL_ACCESS) {
      failure = SecurityPolicy("sqlite_state_lease_root_security");
    }
    if (failure.code == OperationFailed().code) failure = IdentityMismatch();
    return ThrowFailure(env, failure);
  }

  RelativeHandles databaseOpened;
  RelativeHandles journalOpened;
  HandleIdentity databaseIdentity;
  HandleIdentity journalIdentity;
  if (!OpenSqliteChild(
          rootOpened.final,
          parsedRoot,
          databaseName,
          &databaseOpened,
          &databaseIdentity,
          &failure)
      || !OpenSqliteChild(
          rootOpened.final,
          parsedRoot,
          journalName,
          &journalOpened,
          &journalIdentity,
          &failure)
      ) {
    return ThrowFailure(env, failure);
  }

  HANDLE coordination = nullptr;
  if (!AcquireSqliteStateLeaseMutex(
          observedRoot,
          databaseIdentity,
          &coordination,
          &failure)) {
    return ThrowFailure(env, failure);
  }

  // The named mutex is the cross-process boundary.  This registry closes the
  // recursive same-thread behavior of Win32 mutexes, so a second call in one
  // Node process cannot accidentally acquire the same lease twice.
  {
    const std::lock_guard<std::mutex> lock(gSqliteStateLeasesMutex);
    for (SqliteStateLease* existing : gSqliteStateLeases) {
      if (existing != nullptr
          && existing->active
          && EqualIdentity(existing->databaseIdentity, databaseIdentity)) {
        ReleaseMutex(coordination);
        CloseHandle(coordination);
        return ThrowFailure(env, SqliteStateLeaseContended());
      }
    }
  }

  // Reserve both names after the identity mutex has been acquired and before
  // exposing a lease.  The delete-pending handles remain in the lease's
  // handle vector and are therefore held until after the SQLite connection
  // has closed.  This is the lifetime boundary that an existence preflight
  // cannot provide.  Acquiring the mutex first also makes a second contender
  // report the stable lease-contended result instead of racing the sidecar
  // placeholder and reporting a misleading sidecar-present result.
  std::vector<HANDLE> sidecarReservations;
  sidecarReservations.reserve(2);
  HANDLE walReservation = INVALID_HANDLE_VALUE;
  if (!ReserveSqliteSidecar(
          rootOpened.final,
          parsedRoot,
          walName,
          &walReservation,
          &failure)) {
    ReleaseMutex(coordination);
    CloseHandle(coordination);
    return ThrowFailure(env, failure);
  }
  sidecarReservations.push_back(walReservation);
  HANDLE shmReservation = INVALID_HANDLE_VALUE;
  if (!ReserveSqliteSidecar(
          rootOpened.final,
          parsedRoot,
          shmName,
          &shmReservation,
          &failure)) {
    for (auto iterator = sidecarReservations.rbegin();
         iterator != sidecarReservations.rend();
         ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    ReleaseMutex(coordination);
    CloseHandle(coordination);
    return ThrowFailure(env, failure);
  }
  sidecarReservations.push_back(shmReservation);

  std::vector<HANDLE> handles = TakeAllHandles(&rootOpened);
  AppendHandles(&handles, TakeAllHandles(&databaseOpened));
  AppendHandles(&handles, TakeAllHandles(&journalOpened));
  AppendHandles(&handles, std::move(sidecarReservations));
  auto* lease = new (std::nothrow) SqliteStateLease;
  if (lease == nullptr) {
    for (auto iterator = handles.rbegin(); iterator != handles.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    ReleaseMutex(coordination);
    CloseHandle(coordination);
    return ThrowFailure(env, OperationFailed());
  }
  lease->handles = std::move(handles);
  lease->databaseIdentity = databaseIdentity;
  lease->journalIdentity = journalIdentity;
  lease->coordination = coordination;
  lease->ownerThreadId = GetCurrentThreadId();
  lease->coordinationHeld = true;
  lease->active = true;
  {
    const std::lock_guard<std::mutex> lock(gSqliteStateLeasesMutex);
    if (!RegisterSqliteStateLease(lease)) {
      CloseSqliteStateLeaseHandles(lease);
      delete lease;
      return ThrowFailure(env, OperationFailed());
    }
  }

  napi_value external;
  if (napi_create_external(
          env,
          lease,
          FinalizeSqliteStateLease,
          nullptr,
          &external) != napi_ok) {
    const std::lock_guard<std::mutex> lock(gSqliteStateLeasesMutex);
    UnregisterSqliteStateLease(lease);
    CloseSqliteStateLeaseHandles(lease);
    delete lease;
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "lease", external);
  napi_set_named_property(
      env,
      result,
      "databaseIdentity",
      IdentityValue(env, databaseIdentity));
  napi_set_named_property(
      env,
      result,
      "journalIdentity",
      IdentityValue(env, journalIdentity));
  return result;
}

napi_value ReleaseSqliteStateLeaseCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok
      || type != napi_external) {
    return ThrowFailure(env, SqliteStateLeaseForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, SqliteStateLeaseForeign());
  }
  auto* lease = static_cast<SqliteStateLease*>(data);
  const std::lock_guard<std::mutex> lock(gSqliteStateLeasesMutex);
  if (!IsIssuedSqliteStateLease(lease) || !lease->active || lease->handles.empty()) {
    return ThrowFailure(env, SqliteStateLeaseForeign());
  }
  // A Win32 mutex can be released only by its owning thread. Reject before
  // unregistering or closing anything so the owner can still perform the
  // complete release; partial cleanup here would strand an owned mutex until
  // that thread exits.
  if (lease->coordination != nullptr
      && lease->coordinationHeld
      && lease->ownerThreadId != GetCurrentThreadId()) {
    return ThrowFailure(env, SqliteStateLeaseForeign());
  }
  UnregisterSqliteStateLease(lease);
  bool closed = true;
  for (auto iterator = lease->handles.rbegin();
       iterator != lease->handles.rend();
       ++iterator) {
    if (*iterator != INVALID_HANDLE_VALUE && !CloseHandle(*iterator)) closed = false;
  }
  lease->handles.clear();
  if (lease->coordination != nullptr) {
    if (lease->coordinationHeld) {
      if (!ReleaseMutex(lease->coordination)) {
        closed = false;
      }
    }
    if (!CloseHandle(lease->coordination)) closed = false;
    lease->coordination = nullptr;
    lease->coordinationHeld = false;
  }
  lease->active = false;
  if (!closed) return ThrowFailure(env, SqliteStateLeaseReleaseFailed());
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

struct CredentialMutexLease {
  HANDLE handle = nullptr;
  DWORD ownerThreadId = 0;
  bool active = false;
};

std::array<CredentialMutexLease*, 256> gCredentialMutexLeases{};
std::mutex gCredentialMutexLeasesMutex;

// Callers must hold gCredentialMutexLeasesMutex while reading or mutating the
// issued-token registry and the state of a registered lease.
bool IsIssuedCredentialMutexLease(CredentialMutexLease* lease) {
  return std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      lease) != gCredentialMutexLeases.end();
}

bool RegisterCredentialMutexLease(CredentialMutexLease* lease) {
  const auto available = std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      nullptr);
  if (available == gCredentialMutexLeases.end()) return false;
  *available = lease;
  return true;
}

bool UnregisterCredentialMutexLease(CredentialMutexLease* lease) {
  const auto existing = std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      lease);
  if (existing == gCredentialMutexLeases.end()) return false;
  *existing = nullptr;
  return true;
}

void FinalizeCredentialMutexLease(
    napi_env,
    void* data,
    void*) {
  auto* lease = static_cast<CredentialMutexLease*>(data);
  if (lease == nullptr) return;
  const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
  const bool issued = UnregisterCredentialMutexLease(lease);
  if (issued && lease->active && lease->handle != nullptr) {
    if (lease->ownerThreadId == GetCurrentThreadId()) {
      ReleaseMutex(lease->handle);
    }
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
  }
  delete lease;
}

bool CredentialMutexName(std::uint32_t capabilityId, std::wstring* name) {
  const wchar_t* label = nullptr;
  switch (capabilityId) {
    case 0:
      label = L"export-identity";
      break;
    case 1:
      label = L"account-observation";
      break;
    case 2:
      label = L"claude-callback";
      break;
    case 3:
      label = L"contribution-device";
      break;
    default:
      return false;
  }
  std::vector<BYTE> ownerSid;
  if (!GetCurrentUserSid(&ownerSid)) return false;
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(ownerSid.data(), &sidText) || sidText == nullptr) {
    return false;
  }
  *name = L"Local\\TiboTattle-CredentialMutation-v1-";
  name->append(sidText);
  name->push_back(L'-');
  name->append(label);
  LocalFree(sidText);
  return true;
}

napi_value AcquireCredentialMutexCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::uint32_t capabilityId = 0;
  std::wstring name;
  if (!GetUint32(env, arguments[0], &capabilityId)
      || !CredentialMutexName(capabilityId, &name)) {
    return ThrowFailure(env, CredentialMutexInvalidCapability());
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kCredentialMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE handle = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kCredentialMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (handle == nullptr) return ThrowFailure(env, FromLastError());

  SecuritySnapshot security;
  if (!ReadObjectSecurity(handle, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurity(security)) {
    CloseHandle(handle);
    return ThrowFailure(env, SecurityPolicy("credential_mutex_security"));
  }

  const DWORD waitResult = WaitForSingleObject(handle, 0);
  if (waitResult == WAIT_TIMEOUT) {
    CloseHandle(handle);
    return ThrowFailure(env, CredentialMutexContended());
  }
  if (waitResult == WAIT_ABANDONED_0) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, CredentialMutexAbandoned());
  }
  if (waitResult != WAIT_OBJECT_0) {
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }

  auto* lease = new (std::nothrow) CredentialMutexLease{
      handle,
      GetCurrentThreadId(),
      true,
  };
  if (lease == nullptr) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
    if (!RegisterCredentialMutexLease(lease)) {
      ReleaseMutex(handle);
      CloseHandle(handle);
      delete lease;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(
          env,
          lease,
          FinalizeCredentialMutexLease,
          nullptr,
          &external) != napi_ok) {
    FinalizeCredentialMutexLease(env, lease, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_value abandoned;
  napi_create_object(env, &result);
  napi_get_boolean(env, false, &abandoned);
  napi_set_named_property(env, result, "lease", external);
  napi_set_named_property(env, result, "abandoned", abandoned);
  return result;
}

napi_value ReleaseCredentialMutexCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_external) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  auto* lease = static_cast<CredentialMutexLease*>(data);
  const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
  if (!IsIssuedCredentialMutexLease(lease)) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  if (!lease->active
      || lease->handle == nullptr
      || lease->ownerThreadId != GetCurrentThreadId()) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  if (!ReleaseMutex(lease->handle)) {
    UnregisterCredentialMutexLease(lease);
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
    return ThrowFailure(env, CredentialMutexReleaseFailed());
  }
  UnregisterCredentialMutexLease(lease);
  CloseHandle(lease->handle);
  lease->handle = nullptr;
  lease->active = false;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// The companion lifetime is guarded by one fixed, per-user kernel mutex.  No
// caller-provided path, PID, label, or mutex name participates in this
// boundary.  In particular, the mutex is deliberately separate from the
// automatic-contribution JSON lock: a filesystem marker cannot provide
// process-wide exclusion on Windows.
struct CompanionInstanceMutexLease {
  HANDLE handle = nullptr;
  DWORD ownerThreadId = 0;
  bool active = false;
};

std::array<CompanionInstanceMutexLease*, 16> gCompanionInstanceMutexLeases{};
std::mutex gCompanionInstanceMutexLeasesMutex;

bool IsIssuedCompanionInstanceMutexLease(CompanionInstanceMutexLease* lease) {
  return std::find(
      gCompanionInstanceMutexLeases.begin(),
      gCompanionInstanceMutexLeases.end(),
      lease) != gCompanionInstanceMutexLeases.end();
}

bool RegisterCompanionInstanceMutexLease(CompanionInstanceMutexLease* lease) {
  const auto available = std::find(
      gCompanionInstanceMutexLeases.begin(),
      gCompanionInstanceMutexLeases.end(),
      nullptr);
  if (available == gCompanionInstanceMutexLeases.end()) return false;
  *available = lease;
  return true;
}

bool UnregisterCompanionInstanceMutexLease(CompanionInstanceMutexLease* lease) {
  const auto existing = std::find(
      gCompanionInstanceMutexLeases.begin(),
      gCompanionInstanceMutexLeases.end(),
      lease);
  if (existing == gCompanionInstanceMutexLeases.end()) return false;
  *existing = nullptr;
  return true;
}

enum class CompanionInstanceMutexReleaseResult {
  kReleased,
  kForeign,
  kReleaseFailed,
};

CompanionInstanceMutexReleaseResult ReleaseCompanionInstanceMutexLease(
    CompanionInstanceMutexLease* lease) {
  const std::lock_guard<std::mutex> lock(gCompanionInstanceMutexLeasesMutex);
  if (!IsIssuedCompanionInstanceMutexLease(lease)
      || !lease->active
      || lease->handle == nullptr
      || lease->ownerThreadId != GetCurrentThreadId()) {
    return CompanionInstanceMutexReleaseResult::kForeign;
  }
  if (!ReleaseMutex(lease->handle)) {
    UnregisterCompanionInstanceMutexLease(lease);
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
    return CompanionInstanceMutexReleaseResult::kReleaseFailed;
  }
  UnregisterCompanionInstanceMutexLease(lease);
  CloseHandle(lease->handle);
  lease->handle = nullptr;
  lease->active = false;
  return CompanionInstanceMutexReleaseResult::kReleased;
}

void FinalizeCompanionInstanceMutexLease(
    napi_env,
    void* data,
    void*) {
  auto* lease = static_cast<CompanionInstanceMutexLease*>(data);
  if (lease == nullptr) return;
  const std::lock_guard<std::mutex> lock(gCompanionInstanceMutexLeasesMutex);
  const bool issued = UnregisterCompanionInstanceMutexLease(lease);
  if (issued && lease->active && lease->handle != nullptr) {
    // Explicit release is the normal lifecycle.  If V8 finalizes the
    // external on its owning thread, release before closing; a finalizer on a
    // different thread cannot safely call ReleaseMutex and therefore only
    // closes the handle, allowing Windows to report an abandoned mutex to the
    // next process rather than pretending it was cleanly released.
    if (lease->ownerThreadId == GetCurrentThreadId()) {
      ReleaseMutex(lease->handle);
    }
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
  }
  delete lease;
}

bool CompanionInstanceMutexName(std::wstring* name) {
  std::vector<BYTE> ownerSid;
  if (!GetCurrentUserSid(&ownerSid)) return false;
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(ownerSid.data(), &sidText) || sidText == nullptr) {
    return false;
  }
  *name = L"Local\\TiboTattle-CompanionInstance-v1-";
  name->append(sidText);
  LocalFree(sidText);
  return true;
}

napi_value AcquireCompanionInstanceMutexCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 0)) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  std::wstring name;
  if (!CompanionInstanceMutexName(&name)) {
    return ThrowFailure(env, OperationFailed());
  }
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kCredentialMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE handle = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kCredentialMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (handle == nullptr) return ThrowFailure(env, FromLastError());

  SecuritySnapshot security;
  if (!ReadObjectSecurity(handle, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurity(security)) {
    CloseHandle(handle);
    return ThrowFailure(env, SecurityPolicy("companion_instance_mutex_security"));
  }

  const DWORD waitResult = WaitForSingleObject(handle, 0);
  bool abandoned = false;
  if (waitResult == WAIT_TIMEOUT) {
    CloseHandle(handle);
    return ThrowFailure(env, CompanionInstanceMutexContended());
  }
  if (waitResult == WAIT_ABANDONED_0) {
    // Ownership transfers atomically to this process.  The JS boundary only
    // receives the fixed boolean below; no stale process content is exposed.
    abandoned = true;
  } else if (waitResult != WAIT_OBJECT_0) {
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }

  auto* lease = new (std::nothrow) CompanionInstanceMutexLease{
      handle,
      GetCurrentThreadId(),
      true,
  };
  if (lease == nullptr) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCompanionInstanceMutexLeasesMutex);
    // Win32 mutexes are recursive for one thread.  The registry closes that
    // loophole: a second acquisition in this process is rejected without
    // changing the already-issued lease's ownership or lifetime.
    for (CompanionInstanceMutexLease* existing : gCompanionInstanceMutexLeases) {
      if (existing != nullptr && existing->active) {
        ReleaseMutex(handle);
        CloseHandle(handle);
        delete lease;
        return ThrowFailure(env, CompanionInstanceMutexContended());
      }
    }
    if (!RegisterCompanionInstanceMutexLease(lease)) {
      ReleaseMutex(handle);
      CloseHandle(handle);
      delete lease;
      return ThrowFailure(env, OperationFailed());
    }
  }

  napi_value external;
  if (napi_create_external(
          env,
          lease,
          FinalizeCompanionInstanceMutexLease,
          nullptr,
          &external) != napi_ok) {
    const std::lock_guard<std::mutex> lock(gCompanionInstanceMutexLeasesMutex);
    UnregisterCompanionInstanceMutexLease(lease);
    ReleaseMutex(handle);
    CloseHandle(handle);
    delete lease;
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_value abandonedValue;
  napi_create_object(env, &result);
  napi_get_boolean(env, abandoned, &abandonedValue);
  napi_set_named_property(env, result, "lease", external);
  napi_set_named_property(env, result, "abandoned", abandonedValue);
  return result;
}

napi_value ReleaseCompanionInstanceMutexCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok
      || type != napi_external) {
    return ThrowFailure(env, CompanionInstanceMutexForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CompanionInstanceMutexForeign());
  }
  auto* lease = static_cast<CompanionInstanceMutexLease*>(data);
  const CompanionInstanceMutexReleaseResult releaseResult =
      ReleaseCompanionInstanceMutexLease(lease);
  if (releaseResult == CompanionInstanceMutexReleaseResult::kForeign) {
    return ThrowFailure(env, CompanionInstanceMutexForeign());
  }
  if (releaseResult == CompanionInstanceMutexReleaseResult::kReleaseFailed) {
    return ThrowFailure(env, CompanionInstanceMutexReleaseFailed());
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
napi_value AttemptCompanionInstanceMutexReleaseFromWorkerCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok
      || type != napi_external) {
    return ThrowFailure(env, CompanionInstanceMutexForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CompanionInstanceMutexForeign());
  }
  auto* lease = static_cast<CompanionInstanceMutexLease*>(data);
  std::atomic<int> result(
      static_cast<int>(CompanionInstanceMutexReleaseResult::kForeign));
  std::thread worker([lease, &result] {
    result.store(
        static_cast<int>(ReleaseCompanionInstanceMutexLease(lease)),
        std::memory_order_release);
  });
  worker.join();
  napi_value response;
  napi_value rejected;
  napi_create_object(env, &response);
  napi_get_boolean(
      env,
      result.load(std::memory_order_acquire)
          != static_cast<int>(CompanionInstanceMutexReleaseResult::kReleased),
      &rejected);
  napi_set_named_property(env, response, "rejected", rejected);
  return response;
}
#endif

void DefineMethod(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function);
  napi_set_named_property(env, exports, name, function);
}

} // namespace

NAPI_MODULE_INIT() {
  DefineMethod(env, exports, "inspectPath", InspectPathCallback);
  DefineMethod(env, exports, "ensureDirectory", EnsureDirectoryCallback);
  DefineMethod(env, exports, "readFile", ReadFileCallback);
  DefineMethod(env, exports, "readFileBounded", ReadFileBoundedCallback);
  DefineMethod(env, exports, "createFile", CreateFileCallback);
  DefineMethod(env, exports, "deleteFile", DeleteFileCallback);
  DefineMethod(env, exports, "replaceFile", ReplaceFileCallback);
  DefineMethod(
      env,
      exports,
      "inspectProtectedChild",
      InspectProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "readProtectedChild",
      ReadProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "createProtectedChild",
      CreateProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "deleteProtectedChild",
      DeleteProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "replaceProtectedChild",
      ReplaceProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "inspectPreparedChild",
      InspectPreparedChildCallback);
  DefineMethod(
      env,
      exports,
      "ensurePreparedDirectory",
      EnsurePreparedDirectoryCallback);
  DefineMethod(
      env,
      exports,
      "enumeratePreparedDirectory",
      EnumeratePreparedDirectoryCallback);
  DefineMethod(
      env,
      exports,
      "removePreparedDirectory",
      RemovePreparedDirectoryCallback);
  DefineMethod(
      env,
      exports,
      "renamePreparedDirectory",
      RenamePreparedDirectoryCallback);
  DefineMethod(
      env,
      exports,
      "createPreparedFile",
      CreatePreparedFileCallback);
  DefineMethod(
      env,
      exports,
      "readPreparedFile",
      ReadPreparedFileCallback);
  DefineMethod(
      env,
      exports,
      "deletePreparedFile",
      DeletePreparedFileCallback);
  DefineMethod(
      env,
      exports,
      "publishPreparedFile",
      PublishPreparedFileCallback);
  DefineMethod(
      env,
      exports,
      "acquireSqliteStateLease",
      AcquireSqliteStateLeaseCallback);
  DefineMethod(
      env,
      exports,
      "releaseSqliteStateLease",
      ReleaseSqliteStateLeaseCallback);
  DefineMethod(
      env,
      exports,
      "createSqliteDatabase",
      CreateSqliteDatabaseCallback);
  DefineMethod(
      env,
      exports,
      "cloneSqliteDatabase",
      CloneSqliteDatabaseCallback);
  DefineMethod(
      env,
      exports,
      "publishSqliteDatabase",
      PublishSqliteDatabaseCallback);
#if defined(TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK)
  DefineMethod(
      env,
      exports,
      "armReplacementPause",
      ArmReplacementPauseCallback);
  DefineMethod(
      env,
      exports,
      "waitForReplacementPause",
      WaitForReplacementPauseCallback);
  DefineMethod(
      env,
      exports,
      "releaseReplacementPause",
      ReleaseReplacementPauseCallback);
  DefineMethod(
      env,
      exports,
      "attemptCompanionInstanceMutexReleaseFromWorker",
      AttemptCompanionInstanceMutexReleaseFromWorkerCallback);
#endif
  DefineMethod(
      env,
      exports,
      "acquireCredentialAuditFileGuard",
      AcquireCredentialAuditFileGuardCallback);
  DefineMethod(
      env,
      exports,
      "releaseCredentialAuditFileGuard",
      ReleaseCredentialAuditFileGuardCallback);
  DefineMethod(env, exports, "acquireCredentialMutex", AcquireCredentialMutexCallback);
  DefineMethod(env, exports, "releaseCredentialMutex", ReleaseCredentialMutexCallback);
  DefineMethod(
      env,
      exports,
      "acquireCompanionInstanceMutex",
      AcquireCompanionInstanceMutexCallback);
  DefineMethod(
      env,
      exports,
      "releaseCompanionInstanceMutex",
      ReleaseCompanionInstanceMutexCallback);
  napi_value version;
  napi_create_string_utf8(env, "windows-filesystem-v1", NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "contractVersion", version);
  napi_value securityVersion;
  napi_create_string_utf8(env, "windows-filesystem-security-v1", NAPI_AUTO_LENGTH, &securityVersion);
  napi_set_named_property(env, exports, "securityContractVersion", securityVersion);
  napi_value credentialMutexVersion;
  napi_create_string_utf8(
      env,
      "windows-credential-mutex-v1",
      NAPI_AUTO_LENGTH,
      &credentialMutexVersion);
  napi_set_named_property(
      env,
      exports,
      "credentialMutexContractVersion",
      credentialMutexVersion);
  napi_value companionInstanceMutexVersion;
  napi_create_string_utf8(
      env,
      "windows-companion-instance-mutex-v1",
      NAPI_AUTO_LENGTH,
      &companionInstanceMutexVersion);
  napi_set_named_property(
      env,
      exports,
      "companionInstanceMutexContractVersion",
      companionInstanceMutexVersion);
  napi_value credentialAuditGuardVersion;
  napi_create_string_utf8(
      env,
      "windows-credential-audit-file-guard-v1",
      NAPI_AUTO_LENGTH,
      &credentialAuditGuardVersion);
  napi_set_named_property(
      env,
      exports,
      "credentialAuditFileGuardContractVersion",
      credentialAuditGuardVersion);
  napi_value sqliteStateLeaseVersion;
  napi_create_string_utf8(
      env,
      "windows-sqlite-state-lease-v1",
      NAPI_AUTO_LENGTH,
      &sqliteStateLeaseVersion);
  napi_set_named_property(
      env,
      exports,
      "sqliteStateLeaseContractVersion",
      sqliteStateLeaseVersion);
  napi_value preparedArtifactVersion;
  napi_create_string_utf8(
      env,
      "windows-prepared-artifact-v1",
      NAPI_AUTO_LENGTH,
      &preparedArtifactVersion);
  napi_set_named_property(
      env,
      exports,
      "preparedArtifactContractVersion",
      preparedArtifactVersion);
  napi_value productionSafe;
  napi_value pathWalkRaceSafe;
  napi_value credentialMutexSafe;
  napi_value companionInstanceMutexSafe;
  napi_value sqliteStateLeaseSafe;
  napi_value preparedArtifactSafe;
  napi_value sqliteStateStagingContractVersion;
  napi_value sqliteStateStagingSafe;
  napi_get_boolean(env, false, &productionSafe);
  napi_get_boolean(env, false, &pathWalkRaceSafe);
  napi_get_boolean(env, true, &credentialMutexSafe);
  napi_get_boolean(env, false, &companionInstanceMutexSafe);
  napi_get_boolean(env, false, &sqliteStateLeaseSafe);
  napi_get_boolean(env, false, &preparedArtifactSafe);
  napi_set_named_property(env, exports, "productionSafe", productionSafe);
  napi_set_named_property(env, exports, "pathWalkRaceSafe", pathWalkRaceSafe);
  napi_set_named_property(env, exports, "credentialMutexSafe", credentialMutexSafe);
  napi_set_named_property(
      env,
      exports,
      "companionInstanceMutexSafe",
      companionInstanceMutexSafe);
  napi_set_named_property(env, exports, "sqliteStateLeaseSafe", sqliteStateLeaseSafe);
  napi_set_named_property(env, exports, "preparedArtifactSafe", preparedArtifactSafe);
  napi_create_string_utf8(
      env,
      "windows-sqlite-state-staging-v1",
      NAPI_AUTO_LENGTH,
      &sqliteStateStagingContractVersion);
  napi_set_named_property(
      env,
      exports,
      "sqliteStateStagingContractVersion",
      sqliteStateStagingContractVersion);
  napi_get_boolean(env, false, &sqliteStateStagingSafe);
  napi_set_named_property(
      env,
      exports,
      "sqliteStateStagingSafe",
      sqliteStateStagingSafe);
  napi_value credentialAuditFileGuardSafe;
  napi_get_boolean(env, true, &credentialAuditFileGuardSafe);
  napi_set_named_property(
      env,
      exports,
      "credentialAuditFileGuardSafe",
      credentialAuditFileGuardSafe);
  return exports;
}
