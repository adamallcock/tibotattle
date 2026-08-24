import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyWindowsFilesystemBindingProvenance,
  WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS,
  WINDOWS_FILESYSTEM_BINDING_PROVENANCE_UNAVAILABLE,
} from "../src/platform/windows-binding-provenance.js";

test("Windows binding provenance reports an immutable verifier-unavailable result", () => {
  const result = verifyWindowsFilesystemBindingProvenance({
    bindingPath: "C:\\checkout\\windows_filesystem.node",
    bindingBytes: Buffer.from("development bytes"),
    manifest: {
      bindingProvenance: {
        status: "authenticated",
        source: "audited-signed-native-binding",
      },
      productionSafe: true,
    },
    verifier: () => ({ status: "verified" }),
  });

  assert.equal(result, WINDOWS_FILESYSTEM_BINDING_PROVENANCE_UNAVAILABLE);
  assert.equal(result.status, WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS.unavailable);
  assert.equal(result.reason, "no-trusted-package-verifier");
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => {
    result.status = "verified";
  }, TypeError);
});
