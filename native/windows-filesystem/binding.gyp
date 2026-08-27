{
  "variables": {
    "tibotattle_build_qualification%": 0
  },
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
          "ExceptionHandling": 1
        }
      }
    }
  ],
  "conditions": [
    [
      "tibotattle_build_qualification==1",
      {
        "targets": [
          {
            "target_name": "windows_filesystem_qualification",
            "sources": ["windows-filesystem.cc"],
            "defines": [
              "UNICODE",
              "_UNICODE",
              "NAPI_VERSION=8",
              "WIN32_LEAN_AND_MEAN",
              "TIBOTATTLE_WINDOWS_FILESYSTEM_TEST_HOOK=1"
            ],
            "libraries": ["Advapi32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      }
    ]
  ]
}
