{
  "targets": [
    {
      "target_name": "windows_filesystem",
      "sources": ["windows-filesystem.cc"],
      "defines": [
        "UNICODE",
        "_UNICODE",
        "NAPI_VERSION=8",
        "WIN32_LEAN_AND_MEAN"
      ],
      "libraries": ["Advapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"]
        }
      },
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
      }
    }
  ]
}
