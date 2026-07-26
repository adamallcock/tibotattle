import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContributionDeviceCapabilityError,
  createProductionContributionDeviceBackend,
  ensureContributionDeviceCapability,
  readContributionDeviceCapability,
  removeContributionDeviceCapability,
  withContributionDeviceSecret,
} from "../src/contribution-device-capability.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://usage.example";
const CANARY = "PRIVATE_DEVICE_SECRET_CANARY";

function memoryBackend(initial = null) {
  let value = initial && Buffer.from(initial);
  const calls = [];
  function exact(capability) {
    assert.equal(capability, CAPABILITY);
  }
  return {
    calls,
    current: () => value && Buffer.from(value),
    async read(capability) {
      exact(capability);
      calls.push(["read"]);
      return value && Buffer.from(value);
    },
    async createIfMissing(capability, secret) {
      exact(capability);
      calls.push(["create", Buffer.from(secret)]);
      if (value) return "existing";
      value = Buffer.from(secret);
      return "created";
    },
    async deleteExact(capability, expected) {
      exact(capability);
      calls.push(["delete"]);
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value.fill(0);
      value = null;
      return "deleted";
    },
  };
}

function fixedError(code) {
  return (error) => {
    assert.equal(error instanceof ContributionDeviceCapabilityError, true);
    assert.equal(error.code, `contribution_device_${code}`);
    assert.equal(error.message, "Contribution device capability operation failed");
    const rendered = `${error.stack}\n${JSON.stringify(error)}`;
    assert.equal(rendered.includes(CANARY), false);
    assert.equal(rendered.includes(CAPABILITY.service), false);
    return true;
  };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-device-capability-"));
  try {
    await run({ root, stateFile: join(root, "state", "device.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("device capability creates a UUID locally and stores only the 32-byte secret in Keychain", async () => {
  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    const generated = Buffer.alloc(32, 37);
    const result = await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => generated,
      clock: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    assert.deepEqual(generated, Buffer.alloc(32), "caller-owned generated buffers are zeroized");
    assert.deepEqual(result, {
      status: "created",
      origin: ORIGIN,
      deviceId: DEVICE_ID,
      createdAt: "2026-07-26T12:00:00.000Z",
      deviceSecretHash: "1ec2f641ad37bc1446708db769a3f6d86911bc17240912bc2f60a5b1113d66ec",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.hasOwn(result, "secret"), false);
    assert.deepEqual(backend.current(), Buffer.alloc(32, 37));
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const state = await readFile(stateFile, "utf8");
    assert.equal(state, '{"schemaVersion":"contribution-device-binding-v1","origin":"https://usage.example","deviceId":"11111111-1111-4111-8111-111111111111","createdAt":"2026-07-26T12:00:00.000Z"}\n');
    assert.equal(state.includes(Buffer.alloc(32, 37).toString("base64url")), false);

    const reused = await ensureContributionDeviceCapability({
      backend,
      origin: `${ORIGIN}/`,
      stateFile,
    });
    assert.deepEqual(reused, { ...result, status: "existing" });
    assert.equal(backend.calls.filter(([method]) => method === "create").length, 1);
  });
});

test("normal reads expose only a stable domain-separated hash and public binding metadata", async () => {
  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await ensureContributionDeviceCapability({
      backend,
      origin: "http://127.0.0.1:8787",
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 9),
      clock: () => Date.parse("2026-07-26T13:00:00.000Z"),
    });
    const read = await readContributionDeviceCapability({
      backend,
      stateFile,
      expectedOrigin: "http://127.0.0.1:8787/",
    });
    assert.equal(read.status, "available");
    assert.equal(read.deviceSecretHash.length, 64);
    assert.equal(Object.hasOwn(read, "secret"), false);
    await assert.rejects(
      readContributionDeviceCapability({ backend, stateFile, expectedOrigin: "https://other.example" }),
      fixedError("origin_conflict"),
    );
  });
});

test("callback-scoped secret access awaits the operation and zeroizes immediately on success", async () => {
  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 21),
    });
    let leased = null;
    const result = await withContributionDeviceSecret({
      backend,
      stateFile,
      expectedOrigin: `${ORIGIN}/`,
      async operation(secret, binding) {
        leased = secret;
        assert.deepEqual(secret, Buffer.alloc(32, 21));
        assert.deepEqual(binding, {
          origin: ORIGIN,
          deviceId: DEVICE_ID,
          createdAt: binding.createdAt,
        });
        await Promise.resolve();
        return { status: "used" };
      },
    });
    assert.deepEqual(result, { status: "used" });
    assert.deepEqual(leased, Buffer.alloc(32), "leased secret is zeroized before return");
    assert.deepEqual(backend.current(), Buffer.alloc(32, 21), "Keychain-owned value is unchanged");
  });
});

test("callback-scoped secret access zeroizes thrown callbacks and rejects returned aliases", async () => {
  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 22),
    });
    let thrownLease = null;
    await assert.rejects(
      withContributionDeviceSecret({
        backend,
        stateFile,
        operation(secret) {
          thrownLease = secret;
          throw new Error(CANARY);
        },
      }),
      fixedError("operation_failed"),
    );
    assert.deepEqual(thrownLease, Buffer.alloc(32));

    let aliasedLease = null;
    await assert.rejects(
      withContributionDeviceSecret({
        backend,
        stateFile,
        operation(secret) {
          aliasedLease = secret;
          return secret.subarray(4, 12);
        },
      }),
      fixedError("callback_result_invalid"),
    );
    assert.deepEqual(aliasedLease, Buffer.alloc(32));

    await assert.rejects(
      withContributionDeviceSecret({
        backend,
        stateFile,
        operation(secret) {
          return secret.buffer;
        },
      }),
      fixedError("callback_result_invalid"),
    );
  });
});

test("local removal requires confirmed remote revocation and exact device identity", async () => {
  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 23),
    });

    await assert.rejects(
      removeContributionDeviceCapability({
        backend,
        stateFile,
        confirmDeviceId: DEVICE_ID,
        remoteRevocationConfirmed: false,
      }),
      fixedError("remote_revocation_required"),
    );
    assert.deepEqual(backend.current(), Buffer.alloc(32, 23));
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

    await assert.rejects(
      removeContributionDeviceCapability({
        backend,
        stateFile,
        confirmDeviceId: "22222222-2222-4222-8222-222222222222",
        remoteRevocationConfirmed: true,
      }),
      fixedError("confirmation_invalid"),
    );
    assert.deepEqual(backend.current(), Buffer.alloc(32, 23));

    assert.deepEqual(await removeContributionDeviceCapability({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
      confirmDeviceId: DEVICE_ID,
      remoteRevocationConfirmed: true,
    }), {
      status: "removed",
      deviceId: DEVICE_ID,
      credential: "deleted",
      secureErasure: false,
    });
    assert.equal(backend.current(), null);
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
    assert.deepEqual(await removeContributionDeviceCapability({
      backend,
      stateFile,
      remoteRevocationConfirmed: true,
    }), { status: "missing" });
  });
});

test("locked, denied, malformed, and partial states fail closed with fixed content-free errors", async () => {
  for (const [upstream, expected] of [
    ["export_identity_keychain_locked", "credential_locked"],
    ["export_identity_keychain_denied", "credential_denied"],
    ["arbitrary", "credential_unavailable"],
  ]) {
    await fixture(async ({ stateFile }) => {
      const backend = memoryBackend();
      backend.read = async () => {
        const error = new Error(CANARY);
        error.code = upstream;
        throw error;
      };
      await assert.rejects(
        ensureContributionDeviceCapability({ backend, origin: ORIGIN, stateFile }),
        fixedError(expected),
      );
    });
  }

  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend(Buffer.alloc(32, 1));
    await assert.rejects(
      readContributionDeviceCapability({ backend, stateFile }),
      fixedError("credential_conflict"),
    );
  });

  await fixture(async ({ stateFile }) => {
    await ensureContributionDeviceCapability({
      backend: memoryBackend(),
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 2),
    });
    await assert.rejects(
      readContributionDeviceCapability({ backend: memoryBackend(), stateFile }),
      fixedError("credential_missing"),
    );
    await chmod(stateFile, 0o644);
    await assert.rejects(
      readContributionDeviceCapability({ backend: memoryBackend(Buffer.alloc(32, 2)), stateFile }),
      fixedError("state_invalid"),
    );
  });
});

test("invalid origins and device IDs fail before persisting credentials", async () => {
  for (const origin of [
    "http://example.com",
    "https://user@example.com",
    "https://example.com/path",
    "file:///private/tmp/server",
  ]) {
    await fixture(async ({ stateFile }) => {
      const backend = memoryBackend();
      await assert.rejects(
        ensureContributionDeviceCapability({ backend, origin, stateFile }),
        fixedError("origin_invalid"),
      );
      assert.equal(backend.calls.length, 0);
    });
  }

  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend,
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => "not-a-uuid",
      }),
      fixedError("device_id_invalid"),
    );
    assert.equal(backend.current(), null);
  });

  await fixture(async ({ stateFile }) => {
    const backend = memoryBackend();
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend,
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => { throw new Error(CANARY); },
      }),
      fixedError("invalid_configuration"),
    );
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend,
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => DEVICE_ID,
        generateSecret: () => { throw new Error(CANARY); },
      }),
      fixedError("credential_unavailable"),
    );
  });
});

test("unsafe state paths and failed Keychain creation do not leave a plaintext credential", async () => {
  await fixture(async ({ root, stateFile }) => {
    const outside = join(root, "outside");
    await writeFile(outside, "not a directory", { mode: 0o600 });
    await symlink(outside, join(root, "linked-state"));
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend: memoryBackend(),
        origin: ORIGIN,
        stateFile: join(root, "linked-state", "device.json"),
      }),
      fixedError("state_unavailable"),
    );

    const backend = memoryBackend();
    backend.createIfMissing = async () => {
      const error = new Error(CANARY);
      error.code = "export_identity_keychain_denied";
      throw error;
    };
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend,
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => DEVICE_ID,
        generateSecret: () => Buffer.alloc(32, 8),
      }),
      fixedError("credential_denied"),
    );
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
  });
});

test("production selection never falls back from the audited macOS arm64 Keychain backend", () => {
  let called = false;
  assert.throws(() => createProductionContributionDeviceBackend({
    platform: "linux",
    architecture: "arm64",
    createBackend() { called = true; },
  }), fixedError("invalid_configuration"));
  assert.equal(called, false);

  const backend = memoryBackend();
  assert.equal(createProductionContributionDeviceBackend({
    platform: "darwin",
    architecture: "arm64",
    createBackend: () => backend,
  }), backend);
});
