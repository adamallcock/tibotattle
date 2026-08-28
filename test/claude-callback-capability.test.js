import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeCallbackCapabilityError,
  createProductionClaudeCallbackBackend,
  ensureClaudeCallbackCapability,
  planClaudeCallbackCapabilityRemoval,
  readClaudeCallbackCapability,
  removeClaudeCallbackCapability,
  rotateClaudeCallbackCapability,
} from "../src/claude-callback-capability.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
const CANARY = "PRIVATE_CALLBACK_SECRET_CANARY";

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
      calls.push("read");
      return value && Buffer.from(value);
    },
    async createIfMissing(capability, secret) {
      exact(capability);
      calls.push("create");
      if (value) return "existing";
      value = Buffer.from(secret);
      return "created";
    },
    async replaceExact(capability, expected, replacement) {
      exact(capability);
      calls.push("replace");
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value = Buffer.from(replacement);
      return "replaced";
    },
    async deleteExact(capability, expected) {
      exact(capability);
      calls.push("delete");
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
    assert.equal(error instanceof ClaudeCallbackCapabilityError, true);
    assert.equal(error.code, `claude_callback_${code}`);
    assert.equal(error.message, "Claude callback capability operation failed");
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(CANARY), false);
    return true;
  };
}

test("Claude callback capability is distinct, created once, copied, and reused", async () => {
  const backend = memoryBackend();
  const generated = Buffer.alloc(32, 4);
  const first = await ensureClaudeCallbackCapability({ backend, generateSecret: () => generated });
  assert.equal(first.status, "created");
  assert.deepEqual(generated, Buffer.alloc(32));
  assert.deepEqual(first.secret, Buffer.alloc(32, 4));
  first.secret.fill(9);
  const second = await ensureClaudeCallbackCapability({ backend });
  assert.equal(second.status, "existing");
  assert.deepEqual(second.secret, Buffer.alloc(32, 4));
  second.secret.fill(0);
  assert.notEqual(CAPABILITY, EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity);
  assert.notEqual(CAPABILITY, EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation);
});

test("rotation is explicit and invalidates old removal preflights", async () => {
  const backend = memoryBackend(Buffer.alloc(32, 5));
  const binding = "a".repeat(64);
  const firstPlan = await planClaudeCallbackCapabilityRemoval({ backend, targetBinding: binding });
  assert.match(firstPlan.confirmationToken, /^[A-F0-9]{20}$/);
  await assert.rejects(rotateClaudeCallbackCapability({ backend }), fixedError("confirmation_required"));
  const generated = Buffer.alloc(32, 6);
  assert.deepEqual(await rotateClaudeCallbackCapability({ backend, confirm: true, generateSecret: () => generated }), {
    status: "rotated",
  });
  assert.deepEqual(generated, Buffer.alloc(32));
  await assert.rejects(
    removeClaudeCallbackCapability({ backend, targetBinding: binding, providedToken: firstPlan.confirmationToken }),
    fixedError("confirmation_invalid"),
  );
  const secondPlan = await planClaudeCallbackCapabilityRemoval({ backend, targetBinding: binding });
  assert.notEqual(secondPlan.confirmationToken, firstPlan.confirmationToken);
  assert.deepEqual(await removeClaudeCallbackCapability({
    backend,
    targetBinding: binding,
    providedToken: secondPlan.confirmationToken,
  }), { status: "removed", secureErasure: false });
  assert.equal(await readClaudeCallbackCapability({ backend }), null);
});

test("removal confirmation is target-bound and wrong tokens are non-mutating", async () => {
  const backend = memoryBackend(Buffer.alloc(32, 7));
  const planned = await planClaudeCallbackCapabilityRemoval({ backend, targetBinding: "b".repeat(64) });
  await assert.rejects(removeClaudeCallbackCapability({
    backend,
    targetBinding: "c".repeat(64),
    providedToken: planned.confirmationToken,
  }), fixedError("confirmation_invalid"));
  assert.deepEqual(backend.current(), Buffer.alloc(32, 7));
  assert.equal(backend.calls.includes("delete"), false);
});

test("Keychain recovery failures are fixed and content-free", async () => {
  for (const [upstream, expected] of [
    ["export_identity_keychain_locked", "credential_locked"],
    ["export_identity_keychain_denied", "credential_denied"],
    [
      "export_identity_keychain_migration_required",
      "credential_migration_required",
    ],
    ["arbitrary", "credential_unavailable"],
  ]) {
    const backend = memoryBackend();
    backend.read = async () => {
      const error = new Error(CANARY);
      error.code = upstream;
      throw error;
    };
    await assert.rejects(readClaudeCallbackCapability({ backend }), fixedError(expected));
  }
});

test("production selector rejects unsupported hosts before creating a backend", () => {
  let called = false;
  assert.throws(() => createProductionClaudeCallbackBackend({
    platform: "linux",
    architecture: "arm64",
    createBackend() { called = true; },
  }), fixedError("invalid_configuration"));
  assert.equal(called, false);
});

test("Windows x64 Claude callback production selection remains fail closed", () => {
  let constructions = 0;
  assert.throws(() => createProductionClaudeCallbackBackend({
    platform: "win32",
    architecture: "x64",
    createBackend() {
      constructions += 1;
      return memoryBackend();
    },
  }), fixedError("invalid_configuration"));
  assert.equal(constructions, 0);
});
