#pragma once

#include <cstddef>
#include <cstring>

namespace tibotattle::macos_keychain {

// The System Keychain is a standard system-managed search-list member that
// can be readable while not advertising the unlock bit. This comparison must
// stay exact: prefixes, aliases, and every unknown path keep the ordinary
// fail-closed handling below.
constexpr char kStandardSystemKeychainPath[] = "/Library/Keychains/System.keychain";

enum class SearchScopeMemberPath {
  kStandardSystem,
  kOther,
  kUnknown,
};

enum class SearchScopeMemberStatus {
  kPresent,
  kLocked,
  kDenied,
  kUnknown,
};

inline SearchScopeMemberPath ClassifySearchScopeMemberPath(
    const char* path,
    std::size_t length) {
  if (path == nullptr) return SearchScopeMemberPath::kUnknown;
  constexpr std::size_t expected = sizeof(kStandardSystemKeychainPath) - 1;
  if (length == expected
      && std::memcmp(path, kStandardSystemKeychainPath, expected) == 0) {
    return SearchScopeMemberPath::kStandardSystem;
  }
  return SearchScopeMemberPath::kOther;
}

// Called only after a fixed-capability query returned item-not-found. A
// readable standard System Keychain cannot make that absence ambiguous. Every
// user/custom or unknown locked member remains a block, as does any member
// without read permission.
inline SearchScopeMemberStatus ClassifySearchScopeMemberForAbsence(
    bool unlocked,
    bool readable,
    SearchScopeMemberPath path) {
  if (!readable) return SearchScopeMemberStatus::kDenied;
  if (unlocked) return SearchScopeMemberStatus::kPresent;
  if (path == SearchScopeMemberPath::kStandardSystem) {
    return SearchScopeMemberStatus::kPresent;
  }
  if (path == SearchScopeMemberPath::kUnknown) {
    return SearchScopeMemberStatus::kUnknown;
  }
  return SearchScopeMemberStatus::kLocked;
}

}  // namespace tibotattle::macos_keychain
