import assert from "node:assert/strict";
import { sep } from "node:path";
import test from "node:test";

import {
  LINUX_KEYTAR_BINDING_MANIFEST,
  LinuxSecretServiceBindingError,
  linuxSecretServiceBindingEvidence,
  loadLinuxSecretServiceBinding,
  snapshotLinuxSecretServiceBinding,
} from "../src/platform/linux-secret-service-binding.js";

function bindingError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxSecretServiceBindingError, true);
    assert.equal(error.code, `linux_secret_service_binding_${code}`);
    assert.equal(error.message, "Linux Secret Service binding failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function memoryBinding() {
  const values = new Map();
  return {
    async getPassword(service, account) {
      return values.get(`${service}\u0000${account}`) ?? null;
    },
    async setPassword(service, account, value) {
      values.set(`${service}\u0000${account}`, value);
    },
    async deletePassword(service, account) {
      return values.delete(`${service}\u0000${account}`);
    },
  };
}

function syntheticLoader(overrides = {}) {
  const bytes = Buffer.alloc(LINUX_KEYTAR_BINDING_MANIFEST.bytes, 7);
  return {
    platform: "linux",
    architecture: "x64",
    resolveBinding(specifier) {
      assert.equal(specifier, "@github/keytar/prebuilds/linux-x64/keytar.node");
      return `${sep}reviewed${sep}node_modules${sep}@github${sep}keytar${sep}prebuilds${sep}linux-x64${sep}keytar.node`;
    },
    readBinding() {
      return bytes;
    },
    requireBinding() {
      return memoryBinding();
    },
    // Test-only digest injection can cover the successful loader branch, but
    // the returned facade is explicitly not provenance-verified.
    digestBinding() {
      return LINUX_KEYTAR_BINDING_MANIFEST.sha256;
    },
    ...overrides,
  };
}

test("Linux binding manifest pins the reviewed keytar 7.10.6 x64 artifact", () => {
  assert.deepEqual(LINUX_KEYTAR_BINDING_MANIFEST, {
    package: "@github/keytar",
    version: "7.10.6",
    target: "linux-x64",
    relativePath: "prebuilds/linux-x64/keytar.node",
    bytes: 109_664,
    sha256: "e7894a1e1001764de29ff08d3dae418ccbaaf78889c5673d367e05df1682fc7c",
  });
});

test("Linux binding loader is gated to native linux x64 before path resolution", () => {
  let resolverCalls = 0;
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["win32", "x64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => loadLinuxSecretServiceBinding({
        platform,
        architecture,
        resolveBinding() {
          resolverCalls += 1;
        },
      }),
      bindingError(code),
    );
  }
  assert.equal(resolverCalls, 0);
});

test("Linux binding loader accepts only the exact reviewed prebuild path", () => {
  for (const bindingPath of [
    "relative/prebuilds/linux-x64/keytar.node",
    `${sep}reviewed${sep}prebuilds${sep}linux-arm64${sep}keytar.node`,
    `${sep}reviewed${sep}prebuilds${sep}linux-x64${sep}other.node`,
  ]) {
    assert.throws(
      () => loadLinuxSecretServiceBinding(syntheticLoader({
        resolveBinding: () => bindingPath,
      })),
      bindingError("binding_path_invalid"),
    );
  }
});

test("Linux binding loader snapshots methods and keeps test digest overrides unverified", async () => {
  const original = memoryBinding();
  const options = syntheticLoader({ requireBinding: () => original });
  const binding = loadLinuxSecretServiceBinding(options);
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(linuxSecretServiceBindingEvidence(binding), {
    target: "linux-x64",
    bytes: LINUX_KEYTAR_BINDING_MANIFEST.bytes,
    sha256: LINUX_KEYTAR_BINDING_MANIFEST.sha256,
    pathDigestVerifiedBeforeAndAfter: true,
    immutablePathVerified: false,
    provenanceVerified: false,
  });
  original.getPassword = async () => "mutated";
  assert.equal(await binding.getPassword("service", "account"), null);
});

test("an injected immutable-path assertion cannot promote test provenance", () => {
  const binding = loadLinuxSecretServiceBinding(syntheticLoader({
    verifyImmutableBindingPath: () => true,
  }));
  assert.deepEqual(linuxSecretServiceBindingEvidence(binding), {
    target: "linux-x64",
    bytes: LINUX_KEYTAR_BINDING_MANIFEST.bytes,
    sha256: LINUX_KEYTAR_BINDING_MANIFEST.sha256,
    pathDigestVerifiedBeforeAndAfter: true,
    immutablePathVerified: true,
    provenanceVerified: false,
  });
});

test("Linux binding loader rejects byte and post-load digest mutation", () => {
  assert.throws(
    () => loadLinuxSecretServiceBinding(syntheticLoader({
      readBinding: () => Buffer.alloc(17),
    })),
    bindingError("binding_integrity"),
  );

  let digestCalls = 0;
  assert.throws(
    () => loadLinuxSecretServiceBinding(syntheticLoader({
      digestBinding() {
        digestCalls += 1;
        return digestCalls === 1
          ? LINUX_KEYTAR_BINDING_MANIFEST.sha256
          : "0".repeat(64);
      },
    })),
    bindingError("binding_mutated"),
  );
  assert.equal(digestCalls, 2);
});

test("Linux binding loader collapses unavailable and hostile native exports", () => {
  assert.throws(
    () => loadLinuxSecretServiceBinding(syntheticLoader({
      resolveBinding() {
        throw new Error("PATH-CANARY");
      },
    })),
    bindingError("binding_unavailable"),
  );
  const hostile = new Proxy({}, {
    get() {
      throw new Error("BINDING-CANARY");
    },
  });
  assert.throws(
    () => loadLinuxSecretServiceBinding(syntheticLoader({
      requireBinding: () => hostile,
    })),
    bindingError("binding_invalid"),
  );
  assert.throws(
    () => snapshotLinuxSecretServiceBinding({ getPassword() {} }),
    bindingError("binding_invalid"),
  );
});

test("native Linux x64 keytar binding matches the pinned artifact", {
  skip: process.platform !== "linux"
    || process.arch !== "x64"
    || process.env.USAGE_MONITOR_LINUX_SECRET_SERVICE_QUALIFICATION !== "1",
}, () => {
  const binding = loadLinuxSecretServiceBinding();
  assert.equal(linuxSecretServiceBindingEvidence(binding)?.provenanceVerified, true);
});
