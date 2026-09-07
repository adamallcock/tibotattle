#include <node_api.h>

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecAccess.h>
#include <Security/SecCode.h>
#include <Security/Security.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace {

constexpr char kContractVersion[] = "tibotattle-macos-keychain-v2";
constexpr char kBundleIdentifier[] = "com.usagemonitor.local";
constexpr char kTeamIdentifier[] = "43RTH622SB";
constexpr char kAccount[] = "installation";
constexpr std::size_t kSecretBytes = 32;
constexpr std::size_t kEncodedSecretBytes = 43;

struct CapabilitySpec {
  const char* name;
  const char* service;
  const char* legacy_service;
};

constexpr std::array<CapabilitySpec, 5> kCapabilities = {{
    {"export_identity", "app-usagemonitor.export-identity.app.v1",
     "app-usagemonitor.export-identity.v1"},
    {"account_observation", "app-usagemonitor.account-observation.app.v1",
     "app-usagemonitor.account-observation.v1"},
    {"claude_session_pseudonym", "app-usagemonitor.claude-session-pseudonym.app.v1",
     "app-usagemonitor.claude-session-pseudonym.v1"},
    {"contribution_device", "app-usagemonitor.contribution-device.app.v1",
     "app-usagemonitor.contribution-device.v1"},
    {"accountless_installation", "app-usagemonitor.accountless-installation.app.v1",
     "app-usagemonitor.accountless-installation.v1"},
}};

enum class ItemStatus {
  kAbsent,
  kPresent,
  kLocked,
  kDenied,
  kMigrationRequired,
  kUnknown,
};

enum class Operation {
  kInspect,
  kRead,
  kStore,
  kRemove,
  kCreateIfMissing,
  kDeleteExact,
};

enum class ConditionalStatus {
  kCreated,
  kExisting,
  kDeleted,
  kMissing,
  kMismatch,
  kLocked,
  kDenied,
  kMigrationRequired,
  kUnknown,
};

// SecKeychainSetUserInteractionAllowed is process-wide. Keep the disabled
// scope serial, then restore the exact prior setting before another worker runs.
std::mutex g_keychain_operation_mutex;

void SecureClear(void* value, std::size_t length) {
  volatile unsigned char* cursor = static_cast<volatile unsigned char*>(value);
  while (length > 0) {
    *cursor = 0;
    ++cursor;
    --length;
  }
}

const char* StatusName(ItemStatus status) {
  switch (status) {
    case ItemStatus::kAbsent:
      return "absent";
    case ItemStatus::kPresent:
      return "present";
    case ItemStatus::kLocked:
      return "locked";
    case ItemStatus::kDenied:
      return "denied";
    case ItemStatus::kMigrationRequired:
      return "migration_required";
    case ItemStatus::kUnknown:
      return "unknown";
  }
  return "unknown";
}

const char* ConditionalStatusName(ConditionalStatus status) {
  switch (status) {
    case ConditionalStatus::kCreated:
      return "created";
    case ConditionalStatus::kExisting:
      return "existing";
    case ConditionalStatus::kDeleted:
      return "deleted";
    case ConditionalStatus::kMissing:
      return "missing";
    case ConditionalStatus::kMismatch:
      return "mismatch";
    case ConditionalStatus::kLocked:
      return "locked";
    case ConditionalStatus::kDenied:
      return "denied";
    case ConditionalStatus::kMigrationRequired:
      return "migration_required";
    case ConditionalStatus::kUnknown:
      return "unknown";
  }
  return "unknown";
}

ItemStatus StatusFromSecurity(OSStatus status) {
  if (status == errSecItemNotFound) return ItemStatus::kAbsent;
  if (status == errSecSuccess) return ItemStatus::kPresent;
  if (status == errSecInteractionNotAllowed) return ItemStatus::kLocked;
  if (status == errSecAuthFailed || status == errSecUserCanceled) {
    return ItemStatus::kDenied;
  }
  return ItemStatus::kUnknown;
}

ConditionalStatus ConditionalStatusFromItemStatus(ItemStatus status) {
  switch (status) {
    case ItemStatus::kLocked:
      return ConditionalStatus::kLocked;
    case ItemStatus::kDenied:
      return ConditionalStatus::kDenied;
    case ItemStatus::kMigrationRequired:
      return ConditionalStatus::kMigrationRequired;
    case ItemStatus::kUnknown:
      return ConditionalStatus::kUnknown;
    case ItemStatus::kAbsent:
    case ItemStatus::kPresent:
      return ConditionalStatus::kUnknown;
  }
  return ConditionalStatus::kUnknown;
}

bool IsAccountlessInstallationCapability(const CapabilitySpec& capability) {
  return std::strcmp(capability.name, "accountless_installation") == 0;
}

bool SecureEquals(
    const std::array<unsigned char, kSecretBytes>& left,
    const std::array<unsigned char, kSecretBytes>& right) {
  unsigned char difference = 0;
  for (std::size_t index = 0; index < left.size(); ++index) {
    difference |= static_cast<unsigned char>(left[index] ^ right[index]);
  }
  return difference == 0;
}

template <typename OperationFunction>
OSStatus WithUserInteractionDisabled(OperationFunction&& operation) {
  std::lock_guard<std::mutex> lock(g_keychain_operation_mutex);
  Boolean previous = false;
  if (SecKeychainGetUserInteractionAllowed(&previous) != errSecSuccess
      || SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) {
    return errSecInteractionNotAllowed;
  }
  const OSStatus result = operation();
  // This must restore the previous process setting, rather than blindly
  // enabling interaction for another caller.
  (void)SecKeychainSetUserInteractionAllowed(previous);
  return result;
}

bool SameExpectedString(CFTypeRef value, const char* expected) {
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  CFStringRef expected_string = CFStringCreateWithCString(
      kCFAllocatorDefault, expected, kCFStringEncodingUTF8);
  if (expected_string == nullptr) return false;
  const bool matches = CFStringCompare(
      static_cast<CFStringRef>(value), expected_string, 0) == kCFCompareEqualTo;
  CFRelease(expected_string);
  return matches;
}

// CFBundleGetMainBundle is a process-level lookup and is intentionally checked
// synchronously before work is queued. It performs no Keychain access.
bool MainBundleHasExpectedIdentifier() {
  CFBundleRef bundle = CFBundleGetMainBundle();
  return bundle != nullptr
      && SameExpectedString(CFBundleGetIdentifier(bundle), kBundleIdentifier);
}

// This runs on the async worker immediately before every Security operation.
// The designated requirement matches the production app identity and prevents
// an unsigned, repackaged, or differently-signed host from touching items.
bool CurrentProcessHasExpectedSigningIdentity() {
  SecCodeRef current_code = nullptr;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &current_code) != errSecSuccess
      || current_code == nullptr) {
    return false;
  }

  CFDictionaryRef signing_information = nullptr;
  bool valid = SecCodeCopySigningInformation(
      current_code, kSecCSSigningInformation, &signing_information) == errSecSuccess
      && signing_information != nullptr;
  if (valid) {
    valid = SameExpectedString(
        CFDictionaryGetValue(signing_information, kSecCodeInfoIdentifier),
        kBundleIdentifier)
      && SameExpectedString(
        CFDictionaryGetValue(signing_information, kSecCodeInfoTeamIdentifier),
        kTeamIdentifier);
  }

  SecRequirementRef requirement = nullptr;
  if (valid) {
    valid = SecRequirementCreateWithString(
        CFSTR("identifier \"com.usagemonitor.local\" and anchor apple generic and certificate leaf[subject.OU] = \"43RTH622SB\""),
        kSecCSDefaultFlags, &requirement) == errSecSuccess
        && requirement != nullptr;
  }
  if (valid) {
    valid = SecCodeCheckValidity(
        current_code, kSecCSStrictValidate, requirement) == errSecSuccess;
  }

  if (requirement != nullptr) CFRelease(requirement);
  if (signing_information != nullptr) CFRelease(signing_information);
  CFRelease(current_code);
  return valid;
}

const CapabilitySpec* CapabilityFromArgument(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return nullptr;
  std::array<char, 65> name{};
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, name.data(), name.size(), &length) != napi_ok
      || length == 0 || length >= name.size()) {
    return nullptr;
  }
  for (const auto& capability : kCapabilities) {
    if (std::strlen(capability.name) == length
        && std::memcmp(capability.name, name.data(), length) == 0) {
      return &capability;
    }
  }
  return nullptr;
}

bool SecretFromArgument(
    napi_env env,
    napi_value value,
    std::array<unsigned char, kSecretBytes>* result) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) return false;
  void* bytes = nullptr;
  std::size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok
      || bytes == nullptr || length != result->size()) {
    return false;
  }
  std::memcpy(result->data(), bytes, result->size());
  return true;
}

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value InvalidArguments(napi_env env) {
  napi_throw_type_error(env, nullptr, "Invalid macOS Keychain adapter arguments");
  return Undefined(env);
}

napi_value StringValue(napi_env env, const char* text) {
  napi_value value;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  return value;
}

bool CallbackArguments(
    napi_env env,
    napi_callback_info info,
    std::size_t expected_count,
    napi_value* arguments) {
  std::size_t actual_count = expected_count;
  if (napi_get_cb_info(env, info, &actual_count, arguments, nullptr, nullptr) != napi_ok) {
    return false;
  }
  return actual_count == expected_count;
}

CFMutableDictionaryRef BaseQuery(
    const CapabilitySpec& capability,
    bool legacy = false,
    CFArrayRef search_scope = nullptr) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFStringRef service = CFStringCreateWithCString(
      kCFAllocatorDefault, legacy ? capability.legacy_service : capability.service,
      kCFStringEncodingUTF8);
  CFStringRef account = CFStringCreateWithCString(
      kCFAllocatorDefault, kAccount, kCFStringEncodingUTF8);
  if (query == nullptr || service == nullptr || account == nullptr) {
    if (query != nullptr) CFRelease(query);
    if (service != nullptr) CFRelease(service);
    if (account != nullptr) CFRelease(account);
    return nullptr;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, account);
  // Every lookup, update, and delete stays bound to the one user search list
  // captured for this prompt-disabled operation. Add attributes intentionally
  // omit this match-only key; SecItemAdd receives its checked destination later.
  if (search_scope != nullptr) {
    CFDictionarySetValue(query, kSecMatchSearchList, search_scope);
  }
  CFRelease(service);
  CFRelease(account);
  return query;
}

int Base64UrlValue(unsigned char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '-') return 62;
  if (value == '_') return 63;
  return -1;
}

bool DecodeStoredSecret(
    CFDataRef stored,
    std::array<unsigned char, kSecretBytes>* output) {
  if (stored == nullptr || CFDataGetLength(stored) != kEncodedSecretBytes) return false;
  const UInt8* input = CFDataGetBytePtr(stored);
  if (input == nullptr) return false;
  std::uint32_t accumulator = 0;
  int bits = 0;
  std::size_t written = 0;
  for (std::size_t index = 0; index < kEncodedSecretBytes; ++index) {
    const int decoded = Base64UrlValue(input[index]);
    if (decoded < 0) return false;
    accumulator = (accumulator << 6) | static_cast<std::uint32_t>(decoded);
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      if (written >= output->size()) return false;
      (*output)[written++] = static_cast<unsigned char>((accumulator >> bits) & 0xff);
    }
  }
  return written == output->size() && bits == 2 && (accumulator & 0x3u) == 0;
}

std::array<unsigned char, kEncodedSecretBytes> EncodeSecret(
    const std::array<unsigned char, kSecretBytes>& input) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::array<unsigned char, kEncodedSecretBytes> result{};
  std::size_t input_index = 0;
  std::size_t output_index = 0;
  while (input_index + 2 < input.size()) {
    const std::uint32_t value = (static_cast<std::uint32_t>(input[input_index]) << 16)
      | (static_cast<std::uint32_t>(input[input_index + 1]) << 8)
      | static_cast<std::uint32_t>(input[input_index + 2]);
    result[output_index++] = alphabet[(value >> 18) & 0x3f];
    result[output_index++] = alphabet[(value >> 12) & 0x3f];
    result[output_index++] = alphabet[(value >> 6) & 0x3f];
    result[output_index++] = alphabet[value & 0x3f];
    input_index += 3;
  }
  const std::size_t remaining = input.size() - input_index;
  if (remaining == 2) {
    const std::uint32_t value = (static_cast<std::uint32_t>(input[input_index]) << 16)
      | (static_cast<std::uint32_t>(input[input_index + 1]) << 8);
    result[output_index++] = alphabet[(value >> 18) & 0x3f];
    result[output_index++] = alphabet[(value >> 12) & 0x3f];
    result[output_index++] = alphabet[(value >> 6) & 0x3f];
  }
  return result;
}

struct ReadResult {
  ItemStatus status = ItemStatus::kUnknown;
  std::array<unsigned char, kSecretBytes> secret{};
};

struct CapturedSearchScope {
  CFArrayRef value = nullptr;

  ~CapturedSearchScope() {
    if (value != nullptr) CFRelease(value);
  }

  CapturedSearchScope() = default;
  CapturedSearchScope(const CapturedSearchScope&) = delete;
  CapturedSearchScope& operator=(const CapturedSearchScope&) = delete;
};

struct CapturedDefaultKeychain {
  SecKeychainRef value = nullptr;

  ~CapturedDefaultKeychain() {
    if (value != nullptr) CFRelease(value);
  }

  CapturedDefaultKeychain() = default;
  CapturedDefaultKeychain(const CapturedDefaultKeychain&) = delete;
  CapturedDefaultKeychain& operator=(const CapturedDefaultKeychain&) = delete;
};

ItemStatus ScopeFailureStatus(OSStatus status) {
  if (status == errSecInteractionNotAllowed) return ItemStatus::kLocked;
  if (status == errSecAuthFailed || status == errSecUserCanceled) {
    return ItemStatus::kDenied;
  }
  return ItemStatus::kUnknown;
}

// Capture exactly the user search list that all item queries in this operation
// will use. This executes under the same interaction-disabled mutex as the
// Security calls below, so the list remains bound until the operation ends.
ItemStatus CaptureSearchScopeNoInteraction(CapturedSearchScope* result) {
  if (result == nullptr || result->value != nullptr) return ItemStatus::kUnknown;
  CFArrayRef search_scope = nullptr;
  const OSStatus status = SecKeychainCopySearchList(&search_scope);
  if (status != errSecSuccess) return ScopeFailureStatus(status);
  if (search_scope == nullptr || CFGetTypeID(search_scope) != CFArrayGetTypeID()
      || CFArrayGetCount(search_scope) == 0) {
    if (search_scope != nullptr) CFRelease(search_scope);
    return ItemStatus::kUnknown;
  }
  result->value = search_scope;
  return ItemStatus::kPresent;
}

// A not-found result is only absence proof after every keychain in the exact
// query scope reports an unlocked, available status. Do not call this before a
// successful lookup: a readable modern item remains usable even if another
// user-search-list member is currently locked.
ItemStatus KeychainStatusForAbsenceNoInteraction(SecKeychainRef keychain) {
  if (keychain == nullptr) return ItemStatus::kUnknown;
  SecKeychainStatus keychain_status = 0;
  const OSStatus status = SecKeychainGetStatus(keychain, &keychain_status);
  if (status != errSecSuccess) return ScopeFailureStatus(status);
  if ((keychain_status & kSecUnlockStateStatus) == 0) return ItemStatus::kLocked;
  if ((keychain_status & kSecReadPermStatus) == 0) return ItemStatus::kDenied;
  return ItemStatus::kPresent;
}

ItemStatus SearchScopeStatusForAbsenceNoInteraction(
    const CapturedSearchScope& search_scope) {
  if (search_scope.value == nullptr
      || CFGetTypeID(search_scope.value) != CFArrayGetTypeID()
      || CFArrayGetCount(search_scope.value) == 0) {
    return ItemStatus::kUnknown;
  }
  const CFIndex count = CFArrayGetCount(search_scope.value);
  for (CFIndex index = 0; index < count; ++index) {
    const CFTypeRef candidate = CFArrayGetValueAtIndex(search_scope.value, index);
    if (candidate == nullptr || CFGetTypeID(candidate) != SecKeychainGetTypeID()) {
      return ItemStatus::kUnknown;
    }
    const ItemStatus status = KeychainStatusForAbsenceNoInteraction(
        static_cast<SecKeychainRef>(const_cast<void*>(candidate)));
    if (status != ItemStatus::kPresent) return status;
  }
  return ItemStatus::kPresent;
}

bool SearchScopeContainsKeychain(
    const CapturedSearchScope& search_scope,
    SecKeychainRef keychain) {
  if (search_scope.value == nullptr || keychain == nullptr) return false;
  const CFIndex count = CFArrayGetCount(search_scope.value);
  for (CFIndex index = 0; index < count; ++index) {
    const CFTypeRef candidate = CFArrayGetValueAtIndex(search_scope.value, index);
    if (candidate != nullptr && CFEqual(candidate, keychain)) return true;
  }
  return false;
}

// SecItemAdd does not accept kSecMatchSearchList. After modern and legacy
// absence have both been proven against that list, choose one unlocked default
// keychain from the same captured list explicitly with kSecUseKeychain.
ItemStatus CaptureDefaultKeychainForNewItemNoInteraction(
    const CapturedSearchScope& search_scope,
    CapturedDefaultKeychain* result) {
  if (result == nullptr || result->value != nullptr) return ItemStatus::kUnknown;
  SecKeychainRef default_keychain = nullptr;
  const OSStatus status = SecKeychainCopyDefault(&default_keychain);
  if (status != errSecSuccess) return ScopeFailureStatus(status);
  if (default_keychain == nullptr
      || !SearchScopeContainsKeychain(search_scope, default_keychain)) {
    if (default_keychain != nullptr) CFRelease(default_keychain);
    return ItemStatus::kUnknown;
  }
  const ItemStatus keychain_status =
      KeychainStatusForAbsenceNoInteraction(default_keychain);
  if (keychain_status != ItemStatus::kPresent) {
    CFRelease(default_keychain);
    return keychain_status;
  }
  result->value = default_keychain;
  return ItemStatus::kPresent;
}

ItemStatus ItemPresenceNoInteraction(
    const CapabilitySpec& capability,
    const CapturedSearchScope& search_scope,
    bool legacy = false) {
  CFMutableDictionaryRef query = BaseQuery(capability, legacy, search_scope.value);
  if (query == nullptr) return ItemStatus::kUnknown;
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  // Attribute-only lookup deliberately avoids legacy secret material.
  CFDictionarySetValue(query, kSecReturnAttributes, kCFBooleanTrue);
  CFTypeRef item = nullptr;
  const OSStatus status = SecItemCopyMatching(query, &item);
  CFRelease(query);
  if (item != nullptr) CFRelease(item);
  if (status != errSecItemNotFound) return StatusFromSecurity(status);
  const ItemStatus scope_status = SearchScopeStatusForAbsenceNoInteraction(search_scope);
  return scope_status == ItemStatus::kPresent ? ItemStatus::kAbsent : scope_status;
}

ItemStatus ResultAfterLegacyPresenceProbeNoInteraction(
    const CapabilitySpec& capability,
    const CapturedSearchScope& search_scope) {
  const ItemStatus legacy_status = ItemPresenceNoInteraction(capability, search_scope, true);
  if (legacy_status == ItemStatus::kAbsent
      || legacy_status == ItemStatus::kLocked
      || legacy_status == ItemStatus::kDenied) {
    return legacy_status;
  }
  // A legacy item exists, or probing it was otherwise indeterminate. Neither
  // state can safely mint a modern replacement without the native recovery UI.
  return ItemStatus::kMigrationRequired;
}

ReadResult ReadModernSecret(const CapabilitySpec& capability) {
  ReadResult result;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result.status = scope_status;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFMutableDictionaryRef query = BaseQuery(capability, false, search_scope.value);
    if (query == nullptr) {
      result.status = ItemStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFTypeRef item = nullptr;
    const OSStatus status = SecItemCopyMatching(query, &item);
    CFRelease(query);
    result.status = StatusFromSecurity(status);
    if (status == errSecItemNotFound) {
      const ItemStatus absence_scope =
          SearchScopeStatusForAbsenceNoInteraction(search_scope);
      result.status = absence_scope == ItemStatus::kPresent
          ? ResultAfterLegacyPresenceProbeNoInteraction(capability, search_scope)
          : absence_scope;
    } else if (status == errSecSuccess) {
      if (item == nullptr || CFGetTypeID(item) != CFDataGetTypeID()
          || !DecodeStoredSecret(static_cast<CFDataRef>(item), &result.secret)) {
        result.status = ItemStatus::kUnknown;
        SecureClear(result.secret.data(), result.secret.size());
      }
    }
    if (item != nullptr) CFRelease(item);
    return status;
  });
  if (!operation_ran) result.status = StatusFromSecurity(operation_status);
  return result;
}

ItemStatus InspectModernSecret(const CapabilitySpec& capability) {
  ItemStatus result = ItemStatus::kUnknown;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result = scope_status;
      return static_cast<OSStatus>(errSecSuccess);
    }
    result = ItemPresenceNoInteraction(capability, search_scope);
    if (result == ItemStatus::kAbsent) {
      result = ResultAfterLegacyPresenceProbeNoInteraction(capability, search_scope);
    }
    return static_cast<OSStatus>(errSecSuccess);
  });
  return operation_ran ? result : StatusFromSecurity(operation_status);
}

SecAccessRef CurrentAppAccess(const CapabilitySpec& capability) {
  SecTrustedApplicationRef trusted_self = nullptr;
  if (SecTrustedApplicationCreateFromPath(nullptr, &trusted_self) != errSecSuccess
      || trusted_self == nullptr) {
    return nullptr;
  }
  CFStringRef label = CFStringCreateWithCString(
      kCFAllocatorDefault, capability.service, kCFStringEncodingUTF8);
  const void* values[] = {trusted_self};
  CFArrayRef trusted_apps = CFArrayCreate(
      kCFAllocatorDefault, values, 1, &kCFTypeArrayCallBacks);
  SecAccessRef access = nullptr;
  if (label == nullptr || trusted_apps == nullptr
      || SecAccessCreate(label, trusted_apps, &access) != errSecSuccess) {
    access = nullptr;
  }
  if (label != nullptr) CFRelease(label);
  if (trusted_apps != nullptr) CFRelease(trusted_apps);
  CFRelease(trusted_self);
  return access;
}

CFMutableDictionaryRef StoreAttributes(
    const CapabilitySpec& capability,
    const std::array<unsigned char, kSecretBytes>& secret,
    SecKeychainRef destination_keychain) {
  CFMutableDictionaryRef attributes = BaseQuery(capability);
  const auto encoded = EncodeSecret(secret);
  CFDataRef stored = CFDataCreate(
      kCFAllocatorDefault, encoded.data(), static_cast<CFIndex>(encoded.size()));
  CFStringRef label = CFStringCreateWithCString(
      kCFAllocatorDefault, capability.service, kCFStringEncodingUTF8);
  SecAccessRef access = CurrentAppAccess(capability);
  if (attributes == nullptr || stored == nullptr || label == nullptr || access == nullptr
      || destination_keychain == nullptr) {
    if (attributes != nullptr) CFRelease(attributes);
    if (stored != nullptr) CFRelease(stored);
    if (label != nullptr) CFRelease(label);
    if (access != nullptr) CFRelease(access);
    return nullptr;
  }
  CFDictionarySetValue(attributes, kSecAttrLabel, label);
  CFDictionarySetValue(attributes, kSecValueData, stored);
  CFDictionarySetValue(attributes, kSecAttrAccess, access);
  CFDictionarySetValue(attributes, kSecUseKeychain, destination_keychain);
  CFRelease(stored);
  CFRelease(label);
  CFRelease(access);
  return attributes;
}

ItemStatus StoreModernSecret(
    const CapabilitySpec& capability,
    const std::array<unsigned char, kSecretBytes>& secret) {
  ItemStatus result = ItemStatus::kUnknown;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result = scope_status;
      return static_cast<OSStatus>(errSecSuccess);
    }
    const ItemStatus existing_status = ItemPresenceNoInteraction(capability, search_scope);
    CapturedDefaultKeychain new_item_destination;
    if (existing_status == ItemStatus::kAbsent) {
      const ItemStatus legacy_status =
          ResultAfterLegacyPresenceProbeNoInteraction(capability, search_scope);
      if (legacy_status != ItemStatus::kAbsent) {
        result = legacy_status;
        return static_cast<OSStatus>(errSecSuccess);
      }
      const ItemStatus destination_status =
          CaptureDefaultKeychainForNewItemNoInteraction(search_scope, &new_item_destination);
      if (destination_status != ItemStatus::kPresent) {
        result = destination_status;
        return static_cast<OSStatus>(errSecSuccess);
      }
    } else if (existing_status != ItemStatus::kPresent) {
      result = existing_status;
      return static_cast<OSStatus>(errSecSuccess);
    }

    if (existing_status == ItemStatus::kPresent) {
      // An existing modern credential retains its original, app-owned ACL.
      // Update only the secret bytes; never delete then add an item whose
      // access policy we cannot safely reconstruct at this boundary.
      CFMutableDictionaryRef query = BaseQuery(capability, false, search_scope.value);
      CFMutableDictionaryRef changes = CFDictionaryCreateMutable(
          kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
          &kCFTypeDictionaryValueCallBacks);
      const auto encoded = EncodeSecret(secret);
      CFDataRef stored = CFDataCreate(
          kCFAllocatorDefault, encoded.data(), static_cast<CFIndex>(encoded.size()));
      if (query == nullptr || changes == nullptr || stored == nullptr) {
        if (query != nullptr) CFRelease(query);
        if (changes != nullptr) CFRelease(changes);
        if (stored != nullptr) CFRelease(stored);
        result = ItemStatus::kUnknown;
        return static_cast<OSStatus>(errSecSuccess);
      }
      CFDictionarySetValue(changes, kSecValueData, stored);
      const OSStatus update_status = SecItemUpdate(query, changes);
      CFRelease(query);
      CFRelease(changes);
      CFRelease(stored);
      result = update_status == errSecSuccess
        ? ItemStatus::kPresent
        : (update_status == errSecItemNotFound ? ItemStatus::kUnknown
          : StatusFromSecurity(update_status));
      return update_status;
    }

    CFMutableDictionaryRef attributes = StoreAttributes(
        capability, secret, new_item_destination.value);
    if (attributes == nullptr) {
      result = ItemStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    const OSStatus add_status = SecItemAdd(attributes, nullptr);
    CFRelease(attributes);
    // A duplicate after our proven-absent check is a race or a changed ACL.
    // Preserve that item and require a later recovery decision; no deletion,
    // replacement, or ACL migration is allowed on this path.
    result = add_status == errSecSuccess
      ? ItemStatus::kPresent
      : (add_status == errSecDuplicateItem || add_status == errSecItemNotFound
        ? ItemStatus::kUnknown
        : StatusFromSecurity(add_status));
    return add_status;
  });
  return operation_ran ? result : StatusFromSecurity(operation_status);
}

ItemStatus RemoveModernSecret(const CapabilitySpec& capability) {
  ItemStatus result = ItemStatus::kUnknown;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result = scope_status;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFMutableDictionaryRef query = BaseQuery(capability, false, search_scope.value);
    if (query == nullptr) {
      result = ItemStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    const OSStatus status = SecItemDelete(query);
    CFRelease(query);
    result = StatusFromSecurity(status);
    if (status == errSecItemNotFound) {
      const ItemStatus absence_scope =
          SearchScopeStatusForAbsenceNoInteraction(search_scope);
      result = absence_scope == ItemStatus::kPresent
          ? ItemStatus::kAbsent
          : absence_scope;
    }
    return status;
  });
  return operation_ran ? result : StatusFromSecurity(operation_status);
}

// Accountless enrollment is deliberately create-only. A normal `store` can
// update an existing legacy-broker credential, but it must never replace an
// installation secret during an enrollment race.
ConditionalStatus CreateModernSecretIfMissing(
    const CapabilitySpec& capability,
    const std::array<unsigned char, kSecretBytes>& secret) {
  ConditionalStatus result = ConditionalStatus::kUnknown;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    if (!IsAccountlessInstallationCapability(capability)) {
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result = ConditionalStatusFromItemStatus(scope_status);
      return static_cast<OSStatus>(errSecSuccess);
    }
    const ItemStatus existing_status = ItemPresenceNoInteraction(capability, search_scope);
    if (existing_status == ItemStatus::kPresent) {
      result = ConditionalStatus::kExisting;
      return static_cast<OSStatus>(errSecSuccess);
    }
    if (existing_status != ItemStatus::kAbsent) {
      result = ConditionalStatusFromItemStatus(existing_status);
      return static_cast<OSStatus>(errSecSuccess);
    }
    const ItemStatus legacy_status =
        ResultAfterLegacyPresenceProbeNoInteraction(capability, search_scope);
    if (legacy_status != ItemStatus::kAbsent) {
      result = ConditionalStatusFromItemStatus(legacy_status);
      return static_cast<OSStatus>(errSecSuccess);
    }
    CapturedDefaultKeychain destination;
    const ItemStatus destination_status =
        CaptureDefaultKeychainForNewItemNoInteraction(search_scope, &destination);
    if (destination_status != ItemStatus::kPresent) {
      result = ConditionalStatusFromItemStatus(destination_status);
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFMutableDictionaryRef attributes = StoreAttributes(capability, secret, destination.value);
    if (attributes == nullptr) {
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    const OSStatus add_status = SecItemAdd(attributes, nullptr);
    CFRelease(attributes);
    // A duplicate after the checked absence is an independent enrollment or a
    // changed item ACL. It is preserved; the caller treats `existing` as a
    // conflict and never assumes its proposed secret was stored.
    result = add_status == errSecSuccess
      ? ConditionalStatus::kCreated
      : (add_status == errSecDuplicateItem ? ConditionalStatus::kExisting
        : ConditionalStatusFromItemStatus(StatusFromSecurity(add_status)));
    return add_status;
  });
  return operation_ran ? result
    : ConditionalStatusFromItemStatus(StatusFromSecurity(operation_status));
}

// Delete only the exact persistent item whose bytes matched the caller's
// expected secret. The persistent reference pins a delete/recreate race to
// that item rather than selecting a fresh service/account match. It is not an
// OS-wide compare-and-swap against an in-place update of that same item.
ConditionalStatus DeleteModernSecretExact(
    const CapabilitySpec& capability,
    const std::array<unsigned char, kSecretBytes>& expected_secret) {
  ConditionalStatus result = ConditionalStatus::kUnknown;
  bool operation_ran = false;
  const OSStatus operation_status = WithUserInteractionDisabled([&] {
    operation_ran = true;
    if (!IsAccountlessInstallationCapability(capability)) {
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CapturedSearchScope search_scope;
    const ItemStatus scope_status = CaptureSearchScopeNoInteraction(&search_scope);
    if (scope_status != ItemStatus::kPresent) {
      result = ConditionalStatusFromItemStatus(scope_status);
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFMutableDictionaryRef query = BaseQuery(capability, false, search_scope.value);
    if (query == nullptr) {
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecReturnPersistentRef, kCFBooleanTrue);
    CFTypeRef item = nullptr;
    const OSStatus read_status = SecItemCopyMatching(query, &item);
    CFRelease(query);
    if (read_status == errSecItemNotFound) {
      const ItemStatus absence_scope = SearchScopeStatusForAbsenceNoInteraction(search_scope);
      if (absence_scope != ItemStatus::kPresent) {
        result = ConditionalStatusFromItemStatus(absence_scope);
      } else {
        const ItemStatus legacy_status =
            ResultAfterLegacyPresenceProbeNoInteraction(capability, search_scope);
        result = legacy_status == ItemStatus::kAbsent
          ? ConditionalStatus::kMissing
          : ConditionalStatusFromItemStatus(legacy_status);
      }
      return read_status;
    }
    if (read_status != errSecSuccess || item == nullptr
        || CFGetTypeID(item) != CFDictionaryGetTypeID()) {
      if (item != nullptr) CFRelease(item);
      result = ConditionalStatusFromItemStatus(StatusFromSecurity(read_status));
      return read_status;
    }
    const CFDictionaryRef attributes = static_cast<CFDictionaryRef>(item);
    const CFTypeRef stored_data = CFDictionaryGetValue(attributes, kSecValueData);
    const CFTypeRef persistent_ref = CFDictionaryGetValue(
        attributes, kSecValuePersistentRef);
    std::array<unsigned char, kSecretBytes> stored_secret{};
    const bool valid = stored_data != nullptr
      && CFGetTypeID(stored_data) == CFDataGetTypeID()
      && persistent_ref != nullptr
      && CFGetTypeID(persistent_ref) == CFDataGetTypeID()
      && DecodeStoredSecret(static_cast<CFDataRef>(stored_data), &stored_secret);
    if (!valid) {
      SecureClear(stored_secret.data(), stored_secret.size());
      CFRelease(item);
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    const bool matches = SecureEquals(stored_secret, expected_secret);
    SecureClear(stored_secret.data(), stored_secret.size());
    if (!matches) {
      CFRelease(item);
      result = ConditionalStatus::kMismatch;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFMutableDictionaryRef delete_query = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    if (delete_query == nullptr) {
      CFRelease(item);
      result = ConditionalStatus::kUnknown;
      return static_cast<OSStatus>(errSecSuccess);
    }
    CFDictionarySetValue(delete_query, kSecValuePersistentRef, persistent_ref);
    const OSStatus delete_status = SecItemDelete(delete_query);
    CFRelease(delete_query);
    CFRelease(item);
    result = delete_status == errSecSuccess
      ? ConditionalStatus::kDeleted
      : (delete_status == errSecItemNotFound ? ConditionalStatus::kMissing
        : ConditionalStatusFromItemStatus(StatusFromSecurity(delete_status)));
    return delete_status;
  });
  return operation_ran ? result
    : ConditionalStatusFromItemStatus(StatusFromSecurity(operation_status));
}

struct OperationContext {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Operation operation = Operation::kInspect;
  const CapabilitySpec* capability = nullptr;
  std::array<unsigned char, kSecretBytes> secret{};
  ItemStatus status = ItemStatus::kUnknown;
  ConditionalStatus conditional_status = ConditionalStatus::kUnknown;
  ReadResult read_result;
};

napi_value ReadResponse(napi_env env, const ReadResult& result) {
  napi_value response;
  napi_value status = StringValue(env, StatusName(result.status));
  napi_value value;
  napi_create_object(env, &response);
  napi_set_named_property(env, response, "status", status);
  if (result.status == ItemStatus::kPresent) {
    napi_create_buffer_copy(
        env, result.secret.size(), result.secret.data(), nullptr, &value);
  } else {
    napi_get_null(env, &value);
  }
  napi_set_named_property(env, response, "value", value);
  return response;
}

napi_value OperationResponse(napi_env env, const OperationContext& context) {
  switch (context.operation) {
    case Operation::kInspect:
      return StringValue(env, StatusName(context.status));
    case Operation::kRead:
      return ReadResponse(env, context.read_result);
    case Operation::kStore:
      return StringValue(
          env, context.status == ItemStatus::kPresent ? "stored" : StatusName(context.status));
    case Operation::kRemove:
      return StringValue(
          env, context.status == ItemStatus::kPresent ? "deleted" : StatusName(context.status));
    case Operation::kCreateIfMissing:
    case Operation::kDeleteExact:
      return StringValue(env, ConditionalStatusName(context.conditional_status));
  }
  return StringValue(env, "unknown");
}

void ExecuteOperation(napi_env, void* data) {
  auto* context = static_cast<OperationContext*>(data);
  // This Security code-signature verification executes on the worker too. The
  // main-thread bundle preflight only decides whether to queue the operation.
  if (context->capability == nullptr || !CurrentProcessHasExpectedSigningIdentity()) {
    context->status = ItemStatus::kUnknown;
    context->read_result.status = ItemStatus::kUnknown;
    return;
  }
  switch (context->operation) {
    case Operation::kInspect:
      context->status = InspectModernSecret(*context->capability);
      break;
    case Operation::kRead:
      context->read_result = ReadModernSecret(*context->capability);
      context->status = context->read_result.status;
      break;
    case Operation::kStore:
      context->status = StoreModernSecret(*context->capability, context->secret);
      break;
    case Operation::kRemove:
      context->status = RemoveModernSecret(*context->capability);
      break;
    case Operation::kCreateIfMissing:
      context->conditional_status = CreateModernSecretIfMissing(
          *context->capability, context->secret);
      break;
    case Operation::kDeleteExact:
      context->conditional_status = DeleteModernSecretExact(
          *context->capability, context->secret);
      break;
  }
}

napi_value AdapterUnavailableError(napi_env env) {
  napi_value message = StringValue(env, "macOS Keychain adapter unavailable");
  napi_value error;
  napi_create_error(env, nullptr, message, &error);
  return error;
}

void CompleteOperation(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<OperationContext*>(data);
  if (status == napi_ok) {
    napi_value response = OperationResponse(env, *context);
    (void)napi_resolve_deferred(env, context->deferred, response);
  } else {
    (void)napi_reject_deferred(env, context->deferred, AdapterUnavailableError(env));
  }
  SecureClear(context->secret.data(), context->secret.size());
  SecureClear(context->read_result.secret.data(), context->read_result.secret.size());
  (void)napi_delete_async_work(env, context->work);
  delete context;
}

napi_value ResolvedUnknownOperation(napi_env env, Operation operation) {
  OperationContext context;
  context.operation = operation;
  context.status = ItemStatus::kUnknown;
  context.read_result.status = ItemStatus::kUnknown;
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return Undefined(env);
  (void)napi_resolve_deferred(env, deferred, OperationResponse(env, context));
  return promise;
}

napi_value QueueOperation(
    napi_env env,
    Operation operation,
    const CapabilitySpec* capability,
    const std::array<unsigned char, kSecretBytes>* secret = nullptr) {
  if (!MainBundleHasExpectedIdentifier()) {
    return ResolvedUnknownOperation(env, operation);
  }

  auto* context = new OperationContext();
  context->env = env;
  context->operation = operation;
  context->capability = capability;
  if (secret != nullptr) context->secret = *secret;

  napi_value promise;
  if (napi_create_promise(env, &context->deferred, &promise) != napi_ok) {
    SecureClear(context->secret.data(), context->secret.size());
    delete context;
    return Undefined(env);
  }
  napi_value resource_name = StringValue(env, "TiboTattleMacOSKeychain");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteOperation, CompleteOperation,
      context, &context->work);
  if (create_status != napi_ok
      || napi_queue_async_work(env, context->work) != napi_ok) {
    if (context->work != nullptr) (void)napi_delete_async_work(env, context->work);
    (void)napi_reject_deferred(env, context->deferred, AdapterUnavailableError(env));
    SecureClear(context->secret.data(), context->secret.size());
    delete context;
  }
  return promise;
}

napi_value IdentityStatusCallback(napi_env env, napi_callback_info info) {
  if (!CallbackArguments(env, info, 0, nullptr)) return InvalidArguments(env);
  return StringValue(env, MainBundleHasExpectedIdentifier() ? "valid" : "invalid");
}

napi_value InspectCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!CallbackArguments(env, info, 1, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  if (capability == nullptr) return InvalidArguments(env);
  return QueueOperation(env, Operation::kInspect, capability);
}

napi_value ReadCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!CallbackArguments(env, info, 1, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  if (capability == nullptr) return InvalidArguments(env);
  return QueueOperation(env, Operation::kRead, capability);
}

napi_value StoreCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!CallbackArguments(env, info, 2, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  std::array<unsigned char, kSecretBytes> secret{};
  if (capability == nullptr || IsAccountlessInstallationCapability(*capability)
      || !SecretFromArgument(env, arguments[1], &secret)) {
    return InvalidArguments(env);
  }
  napi_value promise = QueueOperation(env, Operation::kStore, capability, &secret);
  SecureClear(secret.data(), secret.size());
  return promise;
}

napi_value RemoveCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!CallbackArguments(env, info, 1, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  if (capability == nullptr || IsAccountlessInstallationCapability(*capability)) {
    return InvalidArguments(env);
  }
  return QueueOperation(env, Operation::kRemove, capability);
}

napi_value CreateIfMissingCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!CallbackArguments(env, info, 2, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  std::array<unsigned char, kSecretBytes> secret{};
  if (capability == nullptr || !IsAccountlessInstallationCapability(*capability)
      || !SecretFromArgument(env, arguments[1], &secret)) {
    return InvalidArguments(env);
  }
  napi_value promise = QueueOperation(
      env, Operation::kCreateIfMissing, capability, &secret);
  SecureClear(secret.data(), secret.size());
  return promise;
}

napi_value DeleteExactCallback(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!CallbackArguments(env, info, 2, arguments)) return InvalidArguments(env);
  const CapabilitySpec* capability = CapabilityFromArgument(env, arguments[0]);
  std::array<unsigned char, kSecretBytes> secret{};
  if (capability == nullptr || !IsAccountlessInstallationCapability(*capability)
      || !SecretFromArgument(env, arguments[1], &secret)) {
    return InvalidArguments(env);
  }
  napi_value promise = QueueOperation(env, Operation::kDeleteExact, capability, &secret);
  SecureClear(secret.data(), secret.size());
  return promise;
}

void DefineMethod(
    napi_env env,
    napi_value exports,
    const char* name,
    napi_callback callback) {
  napi_value method;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &method);
  napi_set_named_property(env, exports, name, method);
}

}  // namespace

NAPI_MODULE_INIT() {
  DefineMethod(env, exports, "identityStatus", IdentityStatusCallback);
  DefineMethod(env, exports, "inspect", InspectCallback);
  DefineMethod(env, exports, "read", ReadCallback);
  DefineMethod(env, exports, "store", StoreCallback);
  DefineMethod(env, exports, "remove", RemoveCallback);
  DefineMethod(env, exports, "createIfMissing", CreateIfMissingCallback);
  DefineMethod(env, exports, "deleteExact", DeleteExactCallback);

  napi_value version = StringValue(env, kContractVersion);
  napi_set_named_property(env, exports, "contractVersion", version);
  napi_value capabilities;
  napi_create_array_with_length(env, kCapabilities.size(), &capabilities);
  for (std::size_t index = 0; index < kCapabilities.size(); ++index) {
    napi_set_element(env, capabilities, index, StringValue(env, kCapabilities[index].name));
  }
  napi_set_named_property(env, exports, "capabilities", capabilities);
  return exports;
}
