import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = resolve(new URL("..", import.meta.url).pathname);

test("native Linux credential mutex keeps a fixed x64, durable, opaque contract", async () => {
  const [source, bindingGyp, readme] = await Promise.all([
    readFile(
      resolve(
        REPOSITORY_ROOT,
        "native/linux-credential-mutex/linux-credential-mutex.cc",
      ),
      "utf8",
    ),
    readFile(
      resolve(REPOSITORY_ROOT, "native/linux-credential-mutex/binding.gyp"),
      "utf8",
    ),
    readFile(
      resolve(REPOSITORY_ROOT, "native/linux-credential-mutex/README.md"),
      "utf8",
    ),
  ]);

  assert.match(bindingGyp, /"target_name": "linux_credential_mutex"/u);
  assert.match(bindingGyp, /"NAPI_VERSION=8"/u);
  assert.match(bindingGyp, /OS!='linux' or target_arch!='x64'/u);
  assert.match(source, /SYS_openat2/u);
  assert.match(source, /RESOLVE_NO_SYMLINKS/u);
  assert.match(source, /O_NOFOLLOW/u);
  assert.match(source, /XDG_STATE_HOME/u);
  assert.match(source, /app-usagemonitor/u);
  assert.match(source, /linux-credential-mutex-v1/u);
  assert.match(source, /AF_UNIX/u);
  assert.match(source, /SOCK_CLOEXEC/u);
  assert.match(source, /kSocketNamespace/u);
  assert.match(source, /EADDRINUSE/u);
  assert.match(source, /bind\(fd/u);
  assert.match(source, /kJournalActiveText/u);
  assert.match(source, /kJournalNormalText/u);
  assert.match(source, /WriteJournalState/u);
  assert.match(source, /VerifyJournalContinuity/u);
  assert.match(source, /fstatat\(state_fd/u);
  assert.match(source, /AT_SYMLINK_NOFOLLOW/u);
  assert.match(source, /AbandonCredentialMutex/u);
  assert.match(source, /preserve_active \|\| lease->abandoned/u);
  assert.match(source, /#error "linux_credential_mutex requires Linux x86_64"/u);
  assert.match(source, /napi_create_external/u);
  assert.match(source, /g_issued_leases/u);
  assert.match(source, /LINUX_CREDENTIAL_MUTEX_FOREIGN/u);
  assert.match(source, /"credentialMutexCrossProcessSafe", true/u);
  assert.match(source, /"credentialMutexSameNetworkNamespaceOnly", true/u);
  assert.match(source, /"credentialMutexDurableMarker", true/u);
  assert.match(source, /"productionSafe", false/u);
  assert.doesNotMatch(source, /flock\(/u);
  assert.doesNotMatch(source, /XDG_RUNTIME_DIR/u);
  assert.doesNotMatch(source, /unlinkat\(/u);
  assert.doesNotMatch(source, /productionSafe", true/u);
  assert.match(readme, /persistent XDG state\s+tree/u);
  assert.match(readme, /same Linux network namespace/u);
  assert.match(readme, /recovery_required/u);
  assert.match(readme, /not a\s+selected credential backend/u);
});
