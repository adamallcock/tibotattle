import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeCallbackCapabilityError,
  createClaudeCallbackCapabilityContext,
  selectProductionClaudeCallbackBackend,
} from "../src/application/index.js";

const CAPABILITY = Object.freeze({
  name: "opaque-claude-session-pseudonym-capability",
});

function backendFixture(initial = null) {
  let stored = initial && Buffer.from(initial);
  const seenCapabilities = [];
  return {
    seenCapabilities,
    async read(capability) {
      seenCapabilities.push(capability);
      return stored && Buffer.from(stored);
    },
    async createIfMissing(capability, secret) {
      seenCapabilities.push(capability);
      if (stored) return "existing";
      stored = Buffer.from(secret);
      return "created";
    },
    async replaceExact(capability, expected, replacement) {
      seenCapabilities.push(capability);
      if (!stored) return "missing";
      if (!stored.equals(expected)) return "conflict";
      stored = Buffer.from(replacement);
      return "replaced";
    },
    async deleteExact(capability, expected) {
      seenCapabilities.push(capability);
      if (!stored) return "missing";
      if (!stored.equals(expected)) return "conflict";
      stored.fill(0);
      stored = null;
      return "deleted";
    },
  };
}

function fixedError(code) {
  return (error) =>
    error instanceof ClaudeCallbackCapabilityError
    && error.code === `claude_callback_${code}`
    && error.message
      === "Claude callback capability operation failed";
}

test("application context binds one opaque capability to every backend call", async () => {
  const context = createClaudeCallbackCapabilityContext({
    capability: CAPABILITY,
  });
  const backend = backendFixture();
  const generated = Buffer.alloc(32, 11);

  const ensured = await context.ensureClaudeCallbackCapability({
    backend,
    generateSecret: () => generated,
  });
  assert.equal(ensured.status, "created");
  ensured.secret.fill(0);
  assert.deepEqual(generated, Buffer.alloc(32));

  await context.rotateClaudeCallbackCapability({
    backend,
    confirm: true,
    generateSecret: () => Buffer.alloc(32, 12),
  });
  const targetBinding = "a".repeat(64);
  const planned = await context.planClaudeCallbackCapabilityRemoval({
    backend,
    targetBinding,
  });
  await context.removeClaudeCallbackCapability({
    backend,
    targetBinding,
    providedToken: planned.confirmationToken,
  });

  assert.equal(Object.isFrozen(context), true);
  assert.ok(backend.seenCapabilities.length >= 7);
  assert.equal(
    backend.seenCapabilities.every(
      (capability) => capability === CAPABILITY,
    ),
    true,
  );
});

test("application context requires an explicit opaque capability", () => {
  assert.throws(
    () => createClaudeCallbackCapabilityContext(),
    fixedError("invalid_configuration"),
  );
  assert.throws(
    () => createClaudeCallbackCapabilityContext({
      capability: null,
    }),
    fixedError("invalid_configuration"),
  );
});

test("production backend selection is host- and port-driven", () => {
  let constructions = 0;
  const selected = backendFixture();
  assert.equal(
    selectProductionClaudeCallbackBackend({
      platform: "darwin",
      architecture: "arm64",
      createBackend() {
        constructions += 1;
        return selected;
      },
    }),
    selected,
  );
  assert.equal(constructions, 1);

  assert.throws(
    () => selectProductionClaudeCallbackBackend({
      platform: "linux",
      architecture: "arm64",
      createBackend() {
        constructions += 1;
        return backendFixture();
      },
    }),
    fixedError("invalid_configuration"),
  );
  assert.equal(constructions, 1);
});

test("Windows production selection remains closed until callback state is qualified", () => {
  let constructions = 0;
  assert.throws(
    () => selectProductionClaudeCallbackBackend({
      platform: "win32",
      architecture: "x64",
      createBackend() {
        constructions += 1;
        return backendFixture();
      },
    }),
    fixedError("invalid_configuration"),
  );
  assert.equal(constructions, 0);
});

test("production backend selection collapses hostile upstream errors", () => {
  const canary = "PRIVATE-CLAUDE-CALLBACK-UPSTREAM";
  assert.throws(
    () => selectProductionClaudeCallbackBackend({
      platform: "darwin",
      architecture: "arm64",
      createBackend() {
        throw new Error(canary);
      },
    }),
    (error) =>
      fixedError("credential_unavailable")(error)
      && !`${error.stack}${JSON.stringify(error)}`.includes(canary),
  );
});
