import { writeSync } from "node:fs";

import {
  createWindowsFilesystemAdapter,
  loadWindowsFilesystemBinding,
} from "../../src/platform/windows-filesystem.js";
import {
  createWindowsAccountlessInstallationCredentialBackend,
} from "../../src/platform/windows-accountless-installation-credential.js";

const mode = process.argv[2] ?? "";
const rootPath = process.argv[3] ?? "";
const RECORD_NAME = "accountless-installation-credential-v1.bin";
const SECRET = Buffer.alloc(32, 73);

if (process.platform !== "win32" || process.arch !== "x64") {
  process.exitCode = 3;
} else if (mode !== "hold" && mode !== "interrupt-create") {
  process.exitCode = 4;
} else if (mode === "interrupt-create") {
  try {
    const native = loadWindowsFilesystemBinding();
    const binding = Object.create(native);
    binding.createProtectedChild = (root, identity, child, data) => {
      const result = native.createProtectedChild(root, identity, child, data);
      if (child === RECORD_NAME) {
        // This has to reach the parent before the synchronous interruption;
        // returning to createIfMissing could otherwise settle active -> normal.
        writeSync(1, "WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_RECORD_PUBLISHED\n");
        process.exit(17);
      }
      return result;
    };
    const interruptedAdapter = createWindowsFilesystemAdapter({
      platform: "win32",
      architecture: "x64",
      binding,
    });
    const selected = createWindowsAccountlessInstallationCredentialBackend({
      platform: "win32",
      architecture: "x64",
      adapter: interruptedAdapter,
      rootPath,
    });
    await selected.createIfMissing(SECRET);
    process.exitCode = 6;
  } catch {
    process.stdout.write("WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_UNAVAILABLE\n");
    process.exitCode = 2;
  }
} else {
  let adapter;
  let acquired;
  try {
    adapter = createWindowsFilesystemAdapter();
    acquired = adapter.acquireAccountlessInstallationCredentialMutex();
  } catch {
    process.stdout.write("WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_UNAVAILABLE\n");
    process.exitCode = 2;
  }
  if (acquired !== undefined) {
    process.stdout.write("WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_HELD\n");
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      try {
        adapter.releaseAccountlessInstallationCredentialMutex(acquired.lease);
        process.exit(0);
      } catch {
        process.exit(5);
      }
    };
    const timer = setTimeout(release, 30_000);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => {
      clearTimeout(timer);
      release();
    });
  }
}
