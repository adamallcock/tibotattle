import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV,
  ContributionDeviceKeychainBrokerError,
  contributionDeviceKeychainBrokerConfiguration,
  createContributionDeviceKeychainBrokerBinding,
  createContributionDeviceKeychainBrokerTransport,
} from "../src/contribution-device-keychain-broker.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
  exportIdentityKeychainAttributeProbeArguments,
  exportIdentityKeychainItemPresenceByAttributes,
} from "../src/export-identity-keychain.js";
import {
  ContributionDeviceCapabilityError,
  contributionDeviceKeychainPromptSurface,
  createAppBrokeredContributionDeviceBackend,
  ensureContributionDeviceCapability,
  readContributionDeviceCapability,
  removeContributionDeviceCapability,
  rotateContributionDeviceCredential,
} from "../src/contribution-device-capability.js";
import { startLocalCompanionServer } from "../apps/local/server.js";

const LEGACY_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
const APP_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp;
const ORIGIN = "https://usage.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function assertBrokerError(code) {
  return (error) => {
    assert.equal(error instanceof ContributionDeviceKeychainBrokerError, true);
    assert.equal(error.code, code);
    assert.equal(
      error.message,
      "Contribution device Keychain broker operation failed",
    );
    return true;
  };
}

function assertCapabilityError(code) {
  return (error) => {
    assert.equal(error instanceof ContributionDeviceCapabilityError, true);
    assert.equal(error.code, `contribution_device_${code}`);
    return true;
  };
}

function encodedSecret(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

/** An app-side emulator with keytar-shaped memory storage. */
function memoryBrokerTransport({ initial = null } = {}) {
  const state = { stored: initial, failWith: null };
  const requests = [];
  return {
    state,
    requests,
    async request(operation) {
      requests.push({ ...operation });
      if (state.failWith !== null) {
        throw new ContributionDeviceKeychainBrokerError(state.failWith);
      }
      if (operation.op === "get") return { ok: true, secret: state.stored };
      if (operation.op === "set") {
        state.stored = operation.secret;
        return { ok: true };
      }
      state.stored = null;
      return { ok: true };
    },
  };
}

function memoryKeytarBinding(store = new Map()) {
  return {
    store,
    async getPassword(service, account) {
      return store.get(`${service}\0${account}`) ?? null;
    },
    async setPassword(service, account, value) {
      store.set(`${service}\0${account}`, value);
    },
    async deletePassword(service, account) {
      return store.delete(`${service}\0${account}`);
    },
  };
}

function legacyStoreWith(secretString) {
  const store = new Map();
  if (secretString !== null) {
    store.set(
      `${LEGACY_CAPABILITY.service}\0${LEGACY_CAPABILITY.account}`,
      secretString,
    );
  }
  return store;
}

function brokeredBackend({
  transport = memoryBrokerTransport(),
  legacyStore = legacyStoreWith(null),
  sweeps = [],
  legacyConstructions = [],
  // The probe answers from the same store the legacy binding serves, exactly
  // as the real attribute probe answers from the same Keychain. Injecting it
  // also keeps every case here hermetic: the default probe shells out to
  // /usr/bin/security, so a developer Mac that happens to hold a real `.v1`
  // credential would otherwise decide these outcomes.
  probeLegacyCredential = () => (
    legacyStore.has(`${LEGACY_CAPABILITY.service}\0${LEGACY_CAPABILITY.account}`)
      ? "present"
      : "missing"
  ),
  sweepLegacyCredential = async () => {
    sweeps.push("swept");
    legacyStore.delete(
      `${LEGACY_CAPABILITY.service}\0${LEGACY_CAPABILITY.account}`,
    );
    return "deleted";
  },
} = {}) {
  const backend = createAppBrokeredContributionDeviceBackend({
    transport,
    createLegacyBackend: () => {
      legacyConstructions.push("built");
      return createExportIdentityKeychainBackend({
        binding: memoryKeytarBinding(legacyStore),
      });
    },
    probeLegacyCredential,
    sweepLegacyCredential,
  });
  return { backend, transport, legacyStore, sweeps, legacyConstructions };
}

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.unreferenced = false;
  }

  setEncoding() {}

  unref() {
    this.unreferenced = true;
  }

  write(frame) {
    this.written.push(frame);
    // Nothing in the transport listens for this; it exists so a test can drive
    // the app side of the wire as frames actually arrive instead of guessing
    // when they will.
    this.emit("written", frame);
    return true;
  }

  destroy() {
    this.destroyed = true;
  }

  respond(payload) {
    this.emit("data", `${JSON.stringify(payload)}\n`);
  }
}

test("broker configuration is absent, announced, or poisoned — never a silent fallback", () => {
  assert.equal(contributionDeviceKeychainBrokerConfiguration({}), null);
  assert.deepEqual(
    contributionDeviceKeychainBrokerConfiguration({
      [CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV]: "0",
    }),
    { fd: 0 },
  );
  assert.deepEqual(
    contributionDeviceKeychainBrokerConfiguration({
      [CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV]: "17",
    }),
    { fd: 17 },
  );
  // A present-but-malformed announcement means the app tried to hand over a
  // broker; ignoring it would silently resurrect the companion-side mint and
  // its first-pairing dialog, so it must poison instead.
  for (const malformed of ["", "x", "-1", "007", "10000", "1.5"]) {
    assert.deepEqual(
      contributionDeviceKeychainBrokerConfiguration({
        [CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV]: malformed,
      }),
      { fd: null },
      JSON.stringify(malformed),
    );
  }
  assert.throws(
    () => contributionDeviceKeychainBrokerConfiguration(null),
    assertBrokerError("invalid_configuration"),
  );
});

test("transport frames requests in order and settles strictly matching responses", async () => {
  const channel = new FakeChannel();
  const transport = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: ({ fd }) => {
      assert.equal(fd, 3);
      return channel;
    },
  });
  const first = transport.request({ op: "get" });
  const second = transport.request({ op: "set", secret: encodedSecret(0x41) });
  assert.deepEqual(
    channel.written.map((frame) => JSON.parse(frame)),
    [
      { v: 1, id: 1, op: "get" },
      { v: 1, id: 2, op: "set", secret: encodedSecret(0x41) },
    ],
  );
  for (const frame of channel.written) {
    assert.equal(frame.endsWith("\n"), true);
  }
  channel.respond({ id: 1, ok: true, secret: null });
  channel.respond({ id: 2, ok: true });
  assert.deepEqual(await first, { id: 1, ok: true, secret: null });
  assert.deepEqual(await second, { id: 2, ok: true });
  assert.equal(channel.unreferenced, true);
});

test("transport rejects malformed operations before anything reaches the wire", async () => {
  const channel = new FakeChannel();
  const transport = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => channel,
  });
  for (const operation of [
    null,
    {},
    { op: "steal" },
    { op: "set" },
    { op: "set", secret: "short" },
    { op: "get", secret: encodedSecret(0x41) },
  ]) {
    await assert.rejects(
      transport.request(operation),
      assertBrokerError("invalid_configuration"),
    );
  }
  assert.deepEqual(channel.written, []);
});

test("transport failures are coded and permanent: mismatch, oversize, error, timeout, no descriptor", async () => {
  const mismatch = new FakeChannel();
  const mismatched = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => mismatch,
  });
  const pendingMismatch = mismatched.request({ op: "get" });
  mismatch.respond({ id: 99, ok: true, secret: null });
  await assert.rejects(pendingMismatch, assertBrokerError("broker_protocol"));
  await assert.rejects(
    mismatched.request({ op: "get" }),
    assertBrokerError("broker_protocol"),
  );
  assert.equal(mismatch.destroyed, true);

  const oversize = new FakeChannel();
  const oversized = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => oversize,
  });
  const pendingOversize = oversized.request({ op: "get" });
  oversize.emit("data", "A".repeat(5_000));
  await assert.rejects(pendingOversize, assertBrokerError("broker_protocol"));

  const erroring = new FakeChannel();
  const errored = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => erroring,
  });
  const pendingError = errored.request({ op: "get" });
  erroring.emit("error", new Error("must not escape"));
  await assert.rejects(pendingError, assertBrokerError("broker_unavailable"));

  const silent = new FakeChannel();
  const timingOut = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => silent,
    timeoutMs: 20,
  });
  await assert.rejects(
    timingOut.request({ op: "get" }),
    assertBrokerError("broker_timeout"),
  );
  await assert.rejects(
    timingOut.request({ op: "get" }),
    assertBrokerError("broker_timeout"),
  );

  const unannounced = createContributionDeviceKeychainBrokerTransport({
    fd: null,
  });
  await assert.rejects(
    unannounced.request({ op: "get" }),
    assertBrokerError("broker_unavailable"),
  );
});

test("wire rejections keep the locked and denied identities and collapse the rest", async () => {
  for (const [wireCode, errorCode] of [
    ["locked", "KEYCHAIN_LOCKED"],
    ["denied", "KEYCHAIN_DENIED"],
    ["operation_failed", "broker_rejected"],
    ["invalid_request", "broker_rejected"],
  ]) {
    const channel = new FakeChannel();
    const transport = createContributionDeviceKeychainBrokerTransport({
      fd: 3,
      connect: () => channel,
    });
    const pending = transport.request({ op: "get" });
    channel.respond({ id: 1, ok: false, code: wireCode });
    await assert.rejects(pending, assertBrokerError(errorCode));
  }
});

test("the broker binding is single-purpose: only the app-managed generation is addressable", async () => {
  const transport = memoryBrokerTransport();
  const binding = createContributionDeviceKeychainBrokerBinding({ transport });
  await assert.rejects(
    binding.getPassword(LEGACY_CAPABILITY.service, LEGACY_CAPABILITY.account),
    assertBrokerError("invalid_configuration"),
  );
  await assert.rejects(
    binding.getPassword(APP_CAPABILITY.service, "other-account"),
    assertBrokerError("invalid_configuration"),
  );
  await assert.rejects(
    binding.setPassword(APP_CAPABILITY.service, APP_CAPABILITY.account, "bad"),
    assertBrokerError("invalid_configuration"),
  );
  assert.deepEqual(transport.requests, []);

  assert.equal(
    await binding.getPassword(APP_CAPABILITY.service, APP_CAPABILITY.account),
    null,
  );
  await binding.setPassword(
    APP_CAPABILITY.service,
    APP_CAPABILITY.account,
    encodedSecret(0x42),
  );
  assert.equal(
    await binding.getPassword(APP_CAPABILITY.service, APP_CAPABILITY.account),
    encodedSecret(0x42),
  );
  assert.equal(
    await binding.deletePassword(APP_CAPABILITY.service, APP_CAPABILITY.account),
    true,
  );
  assert.equal(transport.state.stored, null);
  // The wire never carries a service or account: there is nothing else the
  // companion could name through the broker.
  for (const request of transport.requests) {
    assert.equal("service" in request, false);
    assert.equal("account" in request, false);
  }
});

test("binding fails closed on a malformed stored value from the app", async () => {
  const transport = memoryBrokerTransport({ initial: "not-a-stored-secret" });
  const binding = createContributionDeviceKeychainBrokerBinding({ transport });
  await assert.rejects(
    binding.getPassword(APP_CAPABILITY.service, APP_CAPABILITY.account),
    assertBrokerError("broker_protocol"),
  );
});

async function temporaryStateFile() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-broker-test-"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  return {
    root,
    stateFile: join(root, "state", "contribution-device-binding-v1.json"),
  };
}

test("a fresh pairing mint is app-brokered end to end and never writes the legacy generation", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const { backend, transport, legacyStore, sweeps } = brokeredBackend();
  try {
    const created = await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 0x51),
      clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    });
    assert.equal(created.status, "created");
    assert.equal(created.deviceId, DEVICE_ID);
    assert.equal(transport.state.stored, encodedSecret(0x51));
    assert.equal(legacyStore.size, 0);
    assert.deepEqual(sweeps, []);
    const read = await readContributionDeviceCapability({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
    });
    assert.equal(read.status, "available");
    assert.equal(read.deviceId, DEVICE_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy credential keeps working untouched through the brokered backend", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const legacyStore = legacyStoreWith(null);
  // Seed exactly what an existing install holds: a keytar-readable legacy
  // item plus its binding state file.
  const seeded = await ensureContributionDeviceCapability({
    backend: createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(legacyStore),
    }),
    origin: ORIGIN,
    stateFile,
    generateDeviceId: () => DEVICE_ID,
    generateSecret: () => Buffer.alloc(32, 0x61),
    clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(seeded.status, "created");
  const { backend, transport, sweeps } = brokeredBackend({ legacyStore });
  try {
    const existing = await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
    });
    assert.equal(existing.status, "existing");
    assert.equal(existing.deviceId, DEVICE_ID);
    // Reads pass through to keytar; the app store stays empty and nothing is
    // migrated outside a rotation.
    assert.equal(transport.state.stored, null);
    assert.equal(
      legacyStore.get(`${LEGACY_CAPABILITY.service}\0${LEGACY_CAPABILITY.account}`),
      encodedSecret(0x61),
    );
    assert.deepEqual(sweeps, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the silent rotation is the migration point: replacement minted app-side, legacy retired", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const legacyStore = legacyStoreWith(null);
  await ensureContributionDeviceCapability({
    backend: createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(legacyStore),
    }),
    origin: ORIGIN,
    stateFile,
    generateDeviceId: () => DEVICE_ID,
    generateSecret: () => Buffer.alloc(32, 0x71),
    clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const { backend, transport, sweeps } = brokeredBackend({ legacyStore });
  const rotations = [];
  try {
    const rotated = await rotateContributionDeviceCredential({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
      generateSecret: () => Buffer.alloc(32, 0x72),
      performRemoteRotation: async (request) => {
        rotations.push({
          deviceId: request.deviceId,
          currentSecret: Buffer.from(request.currentSecret),
        });
        return { committed: true, expiresAt: "2026-09-18T00:00:00.000Z" };
      },
    });
    assert.equal(rotated.status, "renewed");
    assert.equal(rotated.deviceId, DEVICE_ID);
    // The rotation authenticated with the legacy secret, and the committed
    // replacement lives only in the app-managed generation.
    assert.equal(rotations.length, 1);
    assert.equal(
      rotations[0].currentSecret.toString("base64url"),
      encodedSecret(0x71),
    );
    assert.equal(transport.state.stored, encodedSecret(0x72));
    assert.deepEqual(sweeps, ["swept"]);
    assert.equal(legacyStore.size, 0);
    // Post-migration reads come from the broker.
    const read = await readContributionDeviceCapability({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
    });
    assert.equal(read.status, "available");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed legacy retirement never fails the rotation and reads prefer the app generation", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const legacyStore = legacyStoreWith(null);
  await ensureContributionDeviceCapability({
    backend: createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(legacyStore),
    }),
    origin: ORIGIN,
    stateFile,
    generateDeviceId: () => DEVICE_ID,
    generateSecret: () => Buffer.alloc(32, 0x71),
    clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const { backend, transport } = brokeredBackend({
    legacyStore,
    sweepLegacyCredential: async () => {
      throw new Error("must not escape");
    },
  });
  try {
    const rotated = await rotateContributionDeviceCredential({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
      generateSecret: () => Buffer.alloc(32, 0x72),
      performRemoteRotation: async () => ({
        committed: true,
        expiresAt: "2026-09-18T00:00:00.000Z",
      }),
    });
    assert.equal(rotated.status, "renewed");
    assert.equal(transport.state.stored, encodedSecret(0x72));
    // The stale legacy item survives but is shadowed by every read.
    assert.equal(legacyStore.size, 1);
    const read = await readContributionDeviceCapability({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
    });
    assert.equal(read.status, "available");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-migration rotations replace in place through the broker", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const transport = memoryBrokerTransport();
  const { backend, sweeps } = brokeredBackend({ transport });
  try {
    await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 0x51),
      clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    });
    const rotated = await rotateContributionDeviceCredential({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
      generateSecret: () => Buffer.alloc(32, 0x52),
      performRemoteRotation: async () => ({
        committed: true,
        expiresAt: "2026-09-18T00:00:00.000Z",
      }),
    });
    assert.equal(rotated.status, "renewed");
    assert.equal(transport.state.stored, encodedSecret(0x52));
    // The retirement sweep is idempotent housekeeping for interrupted
    // migrations; on a pure app-generation install it deletes nothing.
    assert.deepEqual(sweeps, ["swept"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disconnect removes whichever generation holds the credential", async () => {
  const { root, stateFile } = await temporaryStateFile();
  try {
    // App generation.
    {
      const { backend, transport } = brokeredBackend();
      await ensureContributionDeviceCapability({
        backend,
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => DEVICE_ID,
        generateSecret: () => Buffer.alloc(32, 0x51),
        clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
      });
      const removed = await removeContributionDeviceCapability({
        backend,
        stateFile,
        expectedOrigin: ORIGIN,
        confirmDeviceId: DEVICE_ID,
        remoteRevocationConfirmed: true,
      });
      assert.equal(removed.status, "removed");
      assert.equal(removed.credential, "deleted");
      assert.equal(transport.state.stored, null);
    }
    // Legacy generation, exactly today's path.
    {
      const legacyStore = legacyStoreWith(null);
      await ensureContributionDeviceCapability({
        backend: createExportIdentityKeychainBackend({
          binding: memoryKeytarBinding(legacyStore),
        }),
        origin: ORIGIN,
        stateFile,
        generateDeviceId: () => DEVICE_ID,
        generateSecret: () => Buffer.alloc(32, 0x61),
        clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
      });
      const { backend, transport } = brokeredBackend({ legacyStore });
      const removed = await removeContributionDeviceCapability({
        backend,
        stateFile,
        expectedOrigin: ORIGIN,
        confirmDeviceId: DEVICE_ID,
        remoteRevocationConfirmed: true,
      });
      assert.equal(removed.status, "removed");
      assert.equal(removed.credential, "deleted");
      assert.equal(legacyStore.size, 0);
      assert.equal(transport.state.stored, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable broker answers with today's coded recoverable errors, never a hang", async () => {
  const { root, stateFile } = await temporaryStateFile();
  try {
    const unavailable = createAppBrokeredContributionDeviceBackend({
      transport: createContributionDeviceKeychainBrokerTransport({ fd: null }),
      createLegacyBackend: () => createExportIdentityKeychainBackend({
        binding: memoryKeytarBinding(),
      }),
      probeLegacyCredential: () => "missing",
      sweepLegacyCredential: async () => "missing",
    });
    await assert.rejects(
      ensureContributionDeviceCapability({
        backend: unavailable,
        origin: ORIGIN,
        stateFile,
      }),
      assertCapabilityError("credential_unavailable"),
    );

    for (const [failWith, expected] of [
      ["KEYCHAIN_LOCKED", "credential_locked"],
      ["KEYCHAIN_DENIED", "credential_denied"],
      ["broker_timeout", "credential_unavailable"],
    ]) {
      const transport = memoryBrokerTransport();
      transport.state.failWith = failWith;
      const { backend } = brokeredBackend({ transport });
      await assert.rejects(
        ensureContributionDeviceCapability({
          backend,
          origin: ORIGIN,
          stateFile,
        }),
        assertCapabilityError(expected),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a locked keychain pauses honestly and leaves the channel usable after the unlock", async () => {
  // The owner's position on a locked login keychain is explicit: uploads stop,
  // and that is acceptable. What is NOT acceptable is a locked keychain that
  // wedges the product. Three properties make the difference, and all three
  // are pinned here.
  //
  // 1. The app answers `locked` promptly instead of raising a modal dialog.
  //    That is what SecKeychainSetUserInteractionAllowed(false) buys: the
  //    Swift side returns errSecInteractionNotAllowed at once rather than
  //    blocking the broker's single serialized queue.
  // 2. A `locked` wire rejection settles ONE request. It must not take the
  //    poison path, because the transport never reconnects — a poisoned
  //    channel stays dead for the companion's whole lifetime, so the user who
  //    unlocks correctly would find the product still broken.
  // 3. The very next operation after the unlock succeeds, with no re-pair,
  //    no reset, and no new credential.
  const { root, stateFile } = await temporaryStateFile();
  const channel = new FakeChannel();
  // The app side of the wire, over the real transport: real framing, real
  // identifiers, real poison rules. `locked` is what the Swift broker answers
  // when SecItemCopyMatching returns errSecInteractionNotAllowed under
  // SecKeychainSetUserInteractionAllowed(false).
  const app = { stored: null, locked: true };
  channel.on("written", (frame) => {
    const request = JSON.parse(frame);
    queueMicrotask(() => {
      if (app.locked) {
        channel.respond({ id: request.id, ok: false, code: "locked" });
        return;
      }
      if (request.op === "get") {
        channel.respond({ id: request.id, ok: true, secret: app.stored });
        return;
      }
      if (request.op === "set") {
        app.stored = request.secret;
        channel.respond({ id: request.id, ok: true });
        return;
      }
      app.stored = null;
      channel.respond({ id: request.id, ok: true });
    });
  });
  const transport = createContributionDeviceKeychainBrokerTransport({
    fd: 3,
    connect: () => channel,
  });
  try {
    const backend = createAppBrokeredContributionDeviceBackend({
      transport,
      createLegacyBackend: () => createExportIdentityKeychainBackend({
        binding: memoryKeytarBinding(),
      }),
      probeLegacyCredential: () => "missing",
      sweepLegacyCredential: async () => "missing",
    });
    const pair = () => ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 0x71),
      clock: () => Date.parse("2026-08-20T00:00:00.000Z"),
    });

    // Locked: the coded, recoverable pause the companion already knows, and
    // no credential written on the way through.
    await assert.rejects(pair(), assertCapabilityError("credential_locked"));
    assert.equal(app.stored, null);
    assert.equal(channel.destroyed, false, "a locked answer never poisons");

    // Unlocked: the same channel serves the whole mint. No reconnect exists,
    // so this passing at all is the proof the locked answer left it alive.
    app.locked = false;
    const paired = await pair();
    assert.equal(paired.status, "created");
    assert.equal(app.stored, encodedSecret(0x71));
    assert.equal(channel.destroyed, false);
    // Strictly increasing identifiers across both phases: one channel, never
    // re-established between them.
    const identifiers = channel.written.map((frame) => JSON.parse(frame).id);
    assert.deepEqual(
      identifiers,
      identifiers.map((_, index) => index + 1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent app-generation mint during migration fails closed instead of misreporting", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const legacyStore = legacyStoreWith(null);
  await ensureContributionDeviceCapability({
    backend: createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(legacyStore),
    }),
    origin: ORIGIN,
    stateFile,
    generateDeviceId: () => DEVICE_ID,
    generateSecret: () => Buffer.alloc(32, 0x71),
    clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const transport = memoryBrokerTransport();
  let probes = 0;
  const racing = {
    state: transport.state,
    async request(operation) {
      if (operation.op === "get") {
        probes += 1;
        // Empty at the migration probe, then filled by a concurrent writer
        // before the mint lands.
        if (probes <= 2) return { ok: true, secret: null };
        return { ok: true, secret: transport.state.stored };
      }
      if (operation.op === "set") {
        if (transport.state.stored === null) {
          transport.state.stored = encodedSecret(0x7f);
        }
        return { ok: true };
      }
      transport.state.stored = null;
      return { ok: true };
    },
  };
  const { backend } = brokeredBackend({ transport: racing, legacyStore });
  try {
    await assert.rejects(
      rotateContributionDeviceCredential({
        backend,
        stateFile,
        expectedOrigin: ORIGIN,
        generateSecret: () => Buffer.alloc(32, 0x72),
        performRemoteRotation: async () => ({
          committed: true,
          expiresAt: "2026-09-18T00:00:00.000Z",
        }),
      }),
      assertCapabilityError("credential_unavailable"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the wire protocol round-trips a real socket: mint, read, rotate", async () => {
  const { root, stateFile } = await temporaryStateFile();
  const socketPath = join(root, "broker.sock");
  // The app-side emulator: newline-framed JSON over a real UNIX socket, one
  // stored value, strictly ordered responses — the same contract the Swift
  // broker implements over the spawn socketpair.
  let stored = null;
  const server = createNetServer((connection) => {
    let received = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      received += chunk;
      let newline = received.indexOf("\n");
      while (newline !== -1) {
        const frame = JSON.parse(received.slice(0, newline));
        received = received.slice(newline + 1);
        let response;
        if (frame.op === "get") {
          response = { id: frame.id, ok: true, secret: stored };
        } else if (frame.op === "set") {
          stored = frame.secret;
          response = { id: frame.id, ok: true };
        } else {
          stored = null;
          response = { id: frame.id, ok: true };
        }
        connection.write(`${JSON.stringify(response)}\n`);
        newline = received.indexOf("\n");
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  const client = netConnect(socketPath);
  await once(client, "connect");
  const backend = createAppBrokeredContributionDeviceBackend({
    transport: createContributionDeviceKeychainBrokerTransport({
      fd: 0,
      connect: () => client,
    }),
    createLegacyBackend: () => createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(),
    }),
    probeLegacyCredential: () => "missing",
    sweepLegacyCredential: async () => "missing",
  });
  try {
    const created = await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
      generateSecret: () => Buffer.alloc(32, 0x51),
      clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    });
    assert.equal(created.status, "created");
    assert.equal(stored, encodedSecret(0x51));
    const rotated = await rotateContributionDeviceCredential({
      backend,
      stateFile,
      expectedOrigin: ORIGIN,
      generateSecret: () => Buffer.alloc(32, 0x52),
      performRemoteRotation: async () => ({
        committed: true,
        expiresAt: "2026-09-18T00:00:00.000Z",
      }),
    });
    assert.equal(rotated.status, "renewed");
    assert.equal(stored, encodedSecret(0x52));
  } finally {
    client.destroy();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function companionFixture() {
  const root = await mkdtemp(join(tmpdir(), "broker-companion-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  return { root, resourceRoot, staticRoot, stateRoot, codexHome };
}

function fakeCompanionStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() {
      return { evidenceStatus: "available" };
    },
    getGradient() {
      return { status: "available" };
    },
    getWeekly() {
      return { status: "available" };
    },
    getQuality() {
      return { status: "available" };
    },
    getReports() {
      return { reports: [] };
    },
  };
}

async function startPairingService() {
  const service = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({
        deviceId: parsed.deviceId,
        state: "active",
        expiresAt: "2026-09-18T00:00:00.000Z",
      }));
    });
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  return {
    origin: `http://127.0.0.1:${service.address().port}`,
    close: () => new Promise((resolve) => service.close(resolve)),
  };
}

test("the companion pairing route mints through the app broker when the app announces one", async () => {
  const files = await companionFixture();
  const service = await startPairingService();
  const { backend, transport, legacyStore } = brokeredBackend();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeCompanionStore(),
    refreshRunner: async () => ({}),
    port: 0,
    contributionServiceOrigin: service.origin,
    contributionDeviceBackendFactory: () => backend,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/contribution/device-pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        pairingCode: `um_pair_${DEVICE_ID}.${"C".repeat(43)}`,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, "paired");
    assert.equal(payload.includesCredentials, false);
    // The credential now lives in the app-managed generation only.
    assert.match(transport.state.stored ?? "", /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(legacyStore.size, 0);
  } finally {
    await app.close();
    await service.close();
    await rm(files.root, { recursive: true, force: true });
  }
});

test("an announced-but-unusable broker answers pairing with the recoverable code, never a legacy mint", async () => {
  const files = await companionFixture();
  const service = await startPairingService();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeCompanionStore(),
    refreshRunner: async () => ({}),
    port: 0,
    contributionServiceOrigin: service.origin,
    // A malformed announcement poisons the broker configuration; the default
    // factory must answer with the coded recovery error rather than silently
    // minting companion-side (which would resurrect the Keychain dialog).
    environment: {
      [CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV]: "not-a-descriptor",
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/contribution/device-pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        pairingCode: `um_pair_${DEVICE_ID}.${"C".repeat(43)}`,
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).error.code,
      "contribution_device_recovery_required",
    );
  } finally {
    await app.close();
    await service.close();
    await rm(files.root, { recursive: true, force: true });
  }
});

test("a fresh brokered install never constructs the legacy keytar backend", async () => {
  // The native binding is the surface that took sign-in down on 2026-08-10,
  // and the pre-pairing null read is exactly when the old fall-through built
  // it. A definite "missing" from the promptless probe must stop that.
  const { root, stateFile } = await temporaryStateFile();
  try {
    const { backend, legacyConstructions } = brokeredBackend();
    assert.equal(await readContributionDeviceCapability({ backend, stateFile }), null);
    const created = await ensureContributionDeviceCapability({
      backend,
      origin: ORIGIN,
      stateFile,
      generateDeviceId: () => DEVICE_ID,
    });
    assert.equal(created.status, "created");
    assert.deepEqual(legacyConstructions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function seededLegacyInstall(stateFile) {
  const legacyStore = legacyStoreWith(null);
  const seeded = await ensureContributionDeviceCapability({
    backend: createExportIdentityKeychainBackend({
      binding: memoryKeytarBinding(legacyStore),
    }),
    origin: ORIGIN,
    stateFile,
    generateDeviceId: () => DEVICE_ID,
    generateSecret: () => Buffer.alloc(32, 0x61),
    clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(seeded.status, "created");
  return legacyStore;
}

test("an indeterminate legacy probe keeps the fall-through rather than inventing a fresh install", async () => {
  // An install that really does hold a legacy credential must never be
  // mistaken for a fresh one and pushed into a re-pair just because the probe
  // could not answer.
  const { root, stateFile } = await temporaryStateFile();
  try {
    const legacyStore = await seededLegacyInstall(stateFile);
    const { backend, legacyConstructions } = brokeredBackend({
      legacyStore,
      probeLegacyCredential: () => "unknown",
    });
    const read = await readContributionDeviceCapability({ backend, stateFile });
    assert.equal(read.status, "available");
    assert.equal(read.deviceId, DEVICE_ID);
    assert.deepEqual(legacyConstructions, ["built"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe that throws is treated as indeterminate, never as an absent credential", async () => {
  const { root, stateFile } = await temporaryStateFile();
  try {
    const legacyStore = await seededLegacyInstall(stateFile);
    const { backend, legacyConstructions } = brokeredBackend({
      legacyStore,
      probeLegacyCredential: () => {
        throw new Error("security is unavailable");
      },
    });
    assert.equal(
      (await readContributionDeviceCapability({ backend, stateFile })).status,
      "available",
    );
    assert.deepEqual(legacyConstructions, ["built"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the legacy presence probe reads attributes only and never decrypts", () => {
  // Without -w or -g the security tool reports attributes and leaves the item
  // encrypted, which is what makes the probe incapable of raising a dialog.
  assert.deepEqual(
    [...exportIdentityKeychainAttributeProbeArguments(LEGACY_CAPABILITY)],
    ["find-generic-password", "-s", LEGACY_CAPABILITY.service, "-a", "installation"],
  );
  const calls = [];
  const probe = (status) => exportIdentityKeychainItemPresenceByAttributes(
    LEGACY_CAPABILITY,
    {
      platform: "darwin",
      runCommand: (command, commandArguments) => {
        calls.push([command, ...commandArguments]);
        return { status };
      },
    },
  );
  assert.equal(probe(0), "present");
  assert.equal(probe(44), "missing");
  assert.equal(probe(1), "unknown");
  assert.equal(probe(undefined), "unknown");
  assert.equal(
    exportIdentityKeychainItemPresenceByAttributes(LEGACY_CAPABILITY, {
      platform: "linux",
      runCommand: () => {
        throw new Error("never invoked off darwin");
      },
    }),
    "unknown",
  );
  assert.equal(
    exportIdentityKeychainItemPresenceByAttributes(LEGACY_CAPABILITY, {
      platform: "darwin",
      runCommand: () => {
        throw new Error("spawn failed");
      },
    }),
    "unknown",
  );
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call[0], "/usr/bin/security");
    assert.equal(call.includes("-w"), false);
    assert.equal(call.includes("-g"), false);
  }
});

test("the Keychain guidance surface names only where a dialog is reachable", () => {
  const announced = { [CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV]: "0" };
  // No announcement: the companion still mints and reads back itself, so the
  // pairing step remains the moment a dialog can appear.
  assert.equal(
    contributionDeviceKeychainPromptSurface({
      environment: {},
      probeLegacyCredential: () => "missing",
    }),
    "pairing",
  );
  // Brokered with nothing to migrate: no dialog exists to explain.
  assert.equal(
    contributionDeviceKeychainPromptSurface({
      environment: announced,
      probeLegacyCredential: () => "missing",
    }),
    "none",
  );
  // Brokered over a legacy item: the dialog moved to the rotation that
  // retires it, and an unreadable probe must land on the same guidance.
  for (const presence of ["present", "unknown"]) {
    assert.equal(
      contributionDeviceKeychainPromptSurface({
        environment: announced,
        probeLegacyCredential: () => presence,
      }),
      "rotation",
    );
  }
  assert.equal(
    contributionDeviceKeychainPromptSurface({
      environment: announced,
      probeLegacyCredential: () => {
        throw new Error("probe failed");
      },
    }),
    "rotation",
  );
  // A malformed announcement is still an install with no usable broker, and
  // the detection itself never reaches the Keychain in that case.
  assert.equal(
    contributionDeviceKeychainPromptSurface({
      environment: {},
      readBrokerConfiguration: () => {
        throw new Error("malformed");
      },
      probeLegacyCredential: () => {
        throw new Error("must not be probed");
      },
    }),
    "pairing",
  );
});
