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
Failure FileSizeChanged() { return {"FILE_SIZE_CHANGED"}; }
Failure IdentityMismatch() { return {"IDENTITY_MISMATCH"}; }
Failure OperationFailed() { return {"OPERATION_FAILED"}; }
Failure CredentialMutexInvalidCapability() { return {"CREDENTIAL_MUTEX_INVALID_CAPABILITY"}; }
Failure CredentialMutexContended() { return {"CREDENTIAL_MUTEX_CONTENDED"}; }
Failure CredentialMutexAbandoned() { return {"CREDENTIAL_MUTEX_ABANDONED"}; }
Failure CredentialMutexReleaseFailed() { return {"CREDENTIAL_MUTEX_RELEASE_FAILED"}; }
Failure CredentialMutexForeign() { return {"CREDENTIAL_MUTEX_FOREIGN"}; }
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
  DWORD size = MAX_PATH;
  for (int attempt = 0; attempt < 8; ++attempt) {
    std::vector<wchar_t> buffer(size, L'\0');
    const DWORD length = GetLongPathNameW(
        expected.c_str(),
        buffer.data(),
        static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    // GetLongPathNameW returns the required length when the supplied buffer
    // is too small.  A spare element is retained for the NUL terminator.
    if (length + 1 < buffer.size()) return std::wstring(buffer.data(), length);
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
    HandleIdentity* identity = nullptr,
    SecuritySnapshot* security = nullptr) {
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
  if (!OpenRelativeComponent(
          protectedRoot,
          childName,
          options.access,
          options.shareMode,
          options.disposition,
          kFileNonDirectory,
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
        kFileNonDirectory,
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
    if (!FlushFileBuffers(handle)) {
      *failure = FromLastError();
      if (!MarkHandleForDeletion(handle)) *failure = OperationFailed();
      CloseHandle(handle);
      return false;
    }
  }

  bool reparse = false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)
      || !HasReparsePoint(handle, &reparse)) {
    CloseHandle(handle);
    *failure = OperationFailed();
    return false;
  }
  if (reparse) {
    CloseHandle(handle);
    *failure = ReparsePoint();
    return false;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    CloseHandle(handle);
    *failure = NotRegularFile();
    return false;
  }

  ParsedPath fullPath = parsedRoot;
  fullPath.components.push_back(childName);
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
    CloseHandle(handle);
    return false;
  }
  opened->final = handle;
  return true;
}

bool EnsureSqliteSidecarAbsent(
    HANDLE protectedRoot,
    const std::wstring& sidecarName,
    Failure* failure) {
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONG_PTR information = 0;
  const bool opened = OpenRelativeComponent(
      protectedRoot,
      sidecarName,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      kFileOpen,
      kFileNonDirectory,
      nullptr,
      &handle,
      &information,
      failure);
  if (!opened) {
    if (failure->code == NotFound().code) return true;
    // The name is reserved by SQLite even when an attacker has made it
    // unreadable.  Treat every non-missing result as present and fail closed.
    *failure = SqliteStateLeaseSidecarPresent();
    return false;
  }
  CloseHandle(handle);
  *failure = SqliteStateLeaseSidecarPresent();
  return false;
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
  // Protected-child replacement is the widest callback surface (root path,
  // expected root identity, child name, expected child identity, bytes).
  // Keep the exact-count check below: this is capacity, not permission to
  // accept arbitrary trailing arguments.
  napi_value values[5] = {};
  std::size_t count = 5;
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
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(remaining, 1 << 20));
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
        std::min<std::size_t>(byteCount - offset, 1 << 20));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, requested, &written, nullptr)
        || written == 0) {
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
    Failure* failure) {
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
  const std::size_t headerBytes = offsetof(NativeFileRenameInformationEx, fileName);
  std::vector<BYTE> buffer(headerBytes + bytes, 0);
  auto* information = reinterpret_cast<NativeFileRenameInformationEx*>(buffer.data());
  information->flags = kFileRenameReplaceIfExists | kFileRenamePosixSemantics;
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
  // Keep the identity-bound destination handle open with write/delete sharing
  // disabled.  A later same-user open capable of changing or removing the
  // destination then fails the Windows sharing check before the rename call.
  targetOptions.shareMode = FILE_SHARE_READ;
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
    // The open handle and its no-delete-sharing mode provide the same-user
    // race boundary; this second handle check also rejects a security or
    // namespace change made through a pre-existing privileged handle before
    // the atomic name replacement is requested. Windows' rename API has no
    // expected-file-ID argument, so the native claim remains qualification-
    // only until the supported Windows/filesystem matrix proves this boundary.
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
    // Legacy FileRenameInformation rejects replacement while the destination
    // handle is open.  FileRenameInformationEx with FILE_RENAME_POSIX_SEMANTICS
    // permits the replacement while that handle is open.  The old close path
    // (`opened.closeFinal()`) would recreate the identity-check/rename race;
    // this handle-bound operation prevents a same-user rename/delete between
    // the identity check and the final kernel operation.
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
  targetOptions.shareMode = FILE_SHARE_READ;
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
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    *failure = SqliteStateLeaseAbandoned();
    return false;
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

  // A live WAL/SHM file means the database is not using the single rollback
  // journal contract this lease protects.  These are defensive preflight
  // checks only; the still-false sqliteStateLeaseSafe claim deliberately does
  // not pretend that a missing sidecar can be reserved against an unrelated
  // same-user writer for the whole lease lifetime.
  if (!EnsureSqliteSidecarAbsent(rootOpened.final, walName, &failure)
      || !EnsureSqliteSidecarAbsent(rootOpened.final, shmName, &failure)) {
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
      || !EnsureSqliteSidecarAbsent(rootOpened.final, walName, &failure)
      || !EnsureSqliteSidecarAbsent(rootOpened.final, shmName, &failure)) {
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

  std::vector<HANDLE> handles = TakeAllHandles(&rootOpened);
  AppendHandles(&handles, TakeAllHandles(&databaseOpened));
  AppendHandles(&handles, TakeAllHandles(&journalOpened));
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
      if (lease->ownerThreadId != GetCurrentThreadId()
          || !ReleaseMutex(lease->coordination)) {
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
      "acquireSqliteStateLease",
      AcquireSqliteStateLeaseCallback);
  DefineMethod(
      env,
      exports,
      "releaseSqliteStateLease",
      ReleaseSqliteStateLeaseCallback);
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
  napi_value productionSafe;
  napi_value pathWalkRaceSafe;
  napi_value credentialMutexSafe;
  napi_value sqliteStateLeaseSafe;
  napi_get_boolean(env, false, &productionSafe);
  napi_get_boolean(env, false, &pathWalkRaceSafe);
  napi_get_boolean(env, true, &credentialMutexSafe);
  napi_get_boolean(env, false, &sqliteStateLeaseSafe);
  napi_set_named_property(env, exports, "productionSafe", productionSafe);
  napi_set_named_property(env, exports, "pathWalkRaceSafe", pathWalkRaceSafe);
  napi_set_named_property(env, exports, "credentialMutexSafe", credentialMutexSafe);
  napi_set_named_property(env, exports, "sqliteStateLeaseSafe", sqliteStateLeaseSafe);
  napi_value credentialAuditFileGuardSafe;
  napi_get_boolean(env, true, &credentialAuditFileGuardSafe);
  napi_set_named_property(
      env,
      exports,
      "credentialAuditFileGuardSafe",
      credentialAuditFileGuardSafe);
  return exports;
}
