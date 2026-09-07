{
  "targets": [
    {
      "target_name": "linux_credential_mutex",
      "sources": ["linux-credential-mutex.cc"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17", "-Wall", "-Wextra", "-Werror"],
      "libraries": ["-pthread"],
      "conditions": [
        ["OS!='linux' or target_arch!='x64'", {
          "defines": ["LINUX_CREDENTIAL_MUTEX_UNSUPPORTED_TARGET=1"]
        }]
      ]
    }
  ]
}
