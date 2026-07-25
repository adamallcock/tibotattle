import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, run } from "../src/cli.js";

async function captureLogs(callback) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await callback();
    return lines.join("\n");
  } finally {
    console.log = original;
  }
}

function dependencies(overrides = {}) {
  const backend = {};
  return {
    createClaudeCallbackBackend: () => backend,
    readClaudeCallbackCredential: async () => Buffer.alloc(32, 1),
    inspectClaudeCallback: async () => ({ status: "installed", targetBinding: "a".repeat(64) }),
    installClaudeCallbackCommand: async ({ backend: selected }) => {
      assert.equal(selected, backend);
      return { status: "installed", capability: "created" };
    },
    uninstallClaudeCallbackCommand: async () => ({ status: "uninstalled", capabilityPreserved: true }),
    recoverClaudeCallbackCommand: async () => ({ status: "installed", recovered: "installed" }),
    rotateClaudeCallbackCommand: async ({ backend: selected, confirm }) => {
      assert.equal(selected, backend);
      assert.equal(confirm, true);
      return { status: "rotated" };
    },
    planClaudeCallbackRemoval: async ({ backend: selected }) => {
      assert.equal(selected, backend);
      return { status: "ready", confirmationToken: "A".repeat(20) };
    },
    removeClaudeCallbackCredential: async ({ backend: selected, providedToken }) => {
      assert.equal(selected, backend);
      assert.equal(providedToken, "A".repeat(20));
      return { status: "removed", secureErasure: false };
    },
    ...overrides,
  };
}

test("Claude callback arguments keep permanent removal confirmation command-specific", () => {
  assert.equal(parseArgs(["remove-claude-callback-identity", "--confirm-removal", "ABC"]).confirmRemovalToken, "ABC");
  assert.throws(
    () => parseArgs(["install-claude-callback", "--confirm-removal", "ABC"]),
    /available only for remove-claude-callback-identity/,
  );
});

test("Claude callback CLI reports only closed lifecycle/capability states", async () => {
  const canary = "PRIVATE_EXISTING_COMMAND";
  const inspect = await captureLogs(() => run(["inspect-claude-callback"], dependencies()));
  assert.match(inspect, /Lifecycle: installed/);
  assert.match(inspect, /capability: available/);
  assert.equal(inspect.includes(canary), false);

  const install = await captureLogs(() => run(["install-claude-callback"], dependencies()));
  assert.match(install, /installation: installed/);
  assert.match(install, /Network activity: none/);
  const uninstall = await captureLogs(() => run(["uninstall-claude-callback"], dependencies()));
  assert.match(uninstall, /capability preserved: true/);
});

test("rotation and permanent removal CLI require separate explicit confirmations", async () => {
  let rotated = false;
  const deps = dependencies({
    rotateClaudeCallbackCommand: async () => {
      rotated = true;
      return { status: "rotated" };
    },
  });
  const preflight = await captureLogs(() => run(["rotate-claude-callback-identity"], deps));
  assert.equal(rotated, false);
  assert.match(preflight, /rerun with --confirm/);
  await captureLogs(() => run(["rotate-claude-callback-identity", "--confirm"], deps));
  assert.equal(rotated, true);

  const removalPlan = await captureLogs(() => run(["remove-claude-callback-identity"], dependencies()));
  assert.match(removalPlan, new RegExp(`Confirmation token: ${"A".repeat(20)}`));
  const removed = await captureLogs(() => run([
    "remove-claude-callback-identity",
    "--confirm-removal",
    "A".repeat(20),
  ], dependencies()));
  assert.match(removed, /identity removal: removed/);
  assert.match(removed, /Secure erasure guaranteed: false/);
});
