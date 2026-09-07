{
  "targets": [
    {
      "target_name": "macos_keychain",
      "sources": ["macos-keychain.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
        "OTHER_LDFLAGS": ["-framework Security", "-framework CoreFoundation"]
      }
    }
  ]
}
