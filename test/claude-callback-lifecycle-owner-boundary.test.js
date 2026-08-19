import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as legacy from "../src/claude-callback-lifecycle.js";
import {
  ClaudeCallbackCapabilityError,
} from "../src/application/index.js";
import * as platform from "../src/platform/index.js";
import * as owner from
  "../src/platform/claude-callback-lifecycle.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OWNER_EXPORTS = Object.freeze([
  "buildClaudeCallbackRunnerInvocation",
  "ClaudeCallbackLifecycleError",
  "createClaudeCallbackLifecycleContext",
  "selectClaudeCallbackRunner",
  "validateClaudeCallbackRunner",
]);
const CONTEXT_EXPORTS = Object.freeze([
  "buildManagedClaudeStatusLine",
  "defaultClaudeCallbackLifecycleDirectory",
  "defaultClaudeSettingsFile",
  "inspectClaudeCallbackLifecycle",
  "installClaudeCallback",
  "planManagedClaudeCallbackCapabilityRemoval",
  "readClaudeCallbackRuntimeConfiguration",
  "recoverClaudeCallbackLifecycle",
  "removeManagedClaudeCallbackCapability",
  "rotateManagedClaudeCallbackCapability",
  "uninstallClaudeCallback",
]);
const LEGACY_EXPORTS = Object.freeze([
  "buildClaudeCallbackRunnerInvocation",
  "ClaudeCallbackLifecycleError",
  ...CONTEXT_EXPORTS,
  "selectClaudeCallbackRunner",
  "validateClaudeCallbackRunner",
]);

function capabilityOperations() {
  return {
    ClaudeCallbackCapabilityError,
    ensureClaudeCallbackCapability: async () => ({
      status: "created",
      secret: Buffer.alloc(32),
    }),
    planClaudeCallbackCapabilityRemoval: async () => ({
      status: "missing",
      confirmationToken: null,
    }),
    removeClaudeCallbackCapability: async () => ({
      status: "removed",
      secureErasure: false,
    }),
    rotateClaudeCallbackCapability: async () => ({ status: "rotated" }),
  };
}

function fixedConfigurationError(error) {
  return error instanceof owner.ClaudeCallbackLifecycleError
    && error.code === "claude_callback_lifecycle_invalid_configuration"
    && error.message
      === "Claude callback lifecycle operation failed";
}

function fixedConfigurationWithout(error, canary) {
  return fixedConfigurationError(error)
    && !`${error.stack}${JSON.stringify(error)}`.includes(canary);
}

function lifecycleContext(overrides = {}) {
  return owner.createClaudeCallbackLifecycleContext({
    ...capabilityOperations(),
    ...overrides,
    runtimeScript: "/safe/claude-callback-runtime.js",
  });
}

async function withLifecycleFixture(context, callback) {
  const created = await mkdtemp(join(tmpdir(), "claude-lifecycle-port-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const settingsDirectory = join(root, ".claude");
  const settingsFile = join(settingsDirectory, "settings.json");
  const lifecycleDirectory = join(root, "private", "lifecycle");
  await mkdir(settingsDirectory, { mode: 0o700 });
  await writeFile(settingsFile, "{}\n", { mode: 0o600 });
  const options = {
    lifecycleDirectory,
    settingsFile,
    installedStatusLine: context.buildManagedClaudeStatusLine({
      nodeExecutable: "/safe/node",
    }),
  };
  try {
    return await callback(options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Claude callback lifecycle owner, context, and legacy APIs are exact", () => {
  assert.deepEqual(Object.keys(owner).sort(), [...OWNER_EXPORTS].sort());
  assert.deepEqual(Object.keys(legacy).sort(), [...LEGACY_EXPORTS].sort());
  for (const name of OWNER_EXPORTS) {
    assert.equal(platform[name], owner[name], name);
  }
  assert.equal(
    legacy.ClaudeCallbackLifecycleError,
    owner.ClaudeCallbackLifecycleError,
  );

  const context = owner.createClaudeCallbackLifecycleContext({
    ...capabilityOperations(),
    runtimeScript: "/safe/claude-callback-runtime.js",
  });
  assert.deepEqual(Object.keys(context).sort(), [...CONTEXT_EXPORTS].sort());
  assert.equal(Object.isFrozen(context), true);
  for (const name of CONTEXT_EXPORTS) {
    assert.equal(typeof context[name], "function", name);
  }
  assert.deepEqual(context.buildManagedClaudeStatusLine({
    nodeExecutable: "/safe/node",
  }), {
    type: "command",
    command: "'/safe/node' '/safe/claude-callback-runtime.js'",
  });
});

test("lifecycle context rejects incomplete capability ports and runtime configuration", () => {
  const operations = capabilityOperations();
  for (const name of Object.keys(operations)) {
    assert.throws(
      () => owner.createClaudeCallbackLifecycleContext({
        ...operations,
        [name]: undefined,
        runtimeScript: "/safe/claude-callback-runtime.js",
      }),
      fixedConfigurationError,
      name,
    );
  }
  for (const runtimeScript of [
    undefined,
    null,
    "relative/runtime.js",
    "/safe/runtime\0private",
    `/${"a".repeat(4096)}`,
  ]) {
    assert.throws(
      () => owner.createClaudeCallbackLifecycleContext({
        ...operations,
        runtimeScript,
      }),
      fixedConfigurationError,
    );
  }
  assert.throws(
    () => owner.createClaudeCallbackLifecycleContext(new Proxy({}, {
      get() {
        throw new Error("PRIVATE-CONFIGURATION-CANARY");
      },
    })),
    (error) => fixedConfigurationError(error)
      && !`${error.stack}${JSON.stringify(error)}`
        .includes("PRIVATE-CONFIGURATION-CANARY"),
  );
  assert.throws(
    () => owner.createClaudeCallbackLifecycleContext({
      ...operations,
      ensureClaudeCallbackCapability: new Proxy(
        operations.ensureClaudeCallbackCapability,
        {},
      ),
      runtimeScript: "/safe/claude-callback-runtime.js",
    }),
    fixedConfigurationError,
  );
  assert.throws(
    () => owner.createClaudeCallbackLifecycleContext({
      ...operations,
      ClaudeCallbackCapabilityError: new Proxy(
        ClaudeCallbackCapabilityError,
        {},
      ),
      runtimeScript: "/safe/claude-callback-runtime.js",
    }),
    fixedConfigurationError,
  );
});

test("lifecycle context invokes only its injected capability operations", async () => {
  const created = await mkdtemp(join(tmpdir(), "claude-lifecycle-owner-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const settingsDirectory = join(root, ".claude");
  const settingsFile = join(settingsDirectory, "settings.json");
  const lifecycleDirectory = join(root, "private", "lifecycle");
  await mkdir(settingsDirectory, { mode: 0o700 });
  await writeFile(settingsFile, "{}\n", { mode: 0o600 });
  const calls = [];
  const context = owner.createClaudeCallbackLifecycleContext({
    ClaudeCallbackCapabilityError,
    ensureClaudeCallbackCapability: async () => {
      calls.push("ensure");
      return { status: "created", secret: Buffer.alloc(32, 19) };
    },
    planClaudeCallbackCapabilityRemoval: async () => {
      calls.push("plan");
      return { status: "missing", confirmationToken: null };
    },
    removeClaudeCallbackCapability: async () => {
      calls.push("remove");
      return { status: "removed", secureErasure: false };
    },
    rotateClaudeCallbackCapability: async () => {
      calls.push("rotate");
      return { status: "rotated" };
    },
    runtimeScript: "/safe/claude-callback-runtime.js",
  });
  const options = {
    lifecycleDirectory,
    settingsFile,
    installedStatusLine: context.buildManagedClaudeStatusLine({
      nodeExecutable: "/safe/node",
    }),
  };
  try {
    assert.deepEqual(await context.installClaudeCallback(options), {
      status: "installed",
      capability: "created",
    });
    assert.deepEqual(await context.uninstallClaudeCallback(options), {
      status: "uninstalled",
      capabilityPreserved: true,
    });
    assert.deepEqual(
      await context.rotateManagedClaudeCallbackCapability(options),
      { status: "rotated" },
    );
    assert.deepEqual(
      await context.planManagedClaudeCallbackCapabilityRemoval(options),
      { status: "missing", confirmationToken: null },
    );
    assert.deepEqual(
      await context.removeManagedClaudeCallbackCapability(options),
      { status: "removed", secureErasure: false },
    );
    assert.deepEqual(calls, ["ensure", "rotate", "plan", "remove"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreviewed capability failures collapse while the reviewed application error passes through", async () => {
  const thrownCanary = "PRIVATE-CAPABILITY-THROWN-CANARY";
  const throwing = lifecycleContext({
    ensureClaudeCallbackCapability: async () => {
      throw new Error(thrownCanary);
    },
  });
  await withLifecycleFixture(throwing, async (options) => {
    await assert.rejects(
      throwing.installClaudeCallback(options),
      (error) => fixedConfigurationWithout(error, thrownCanary),
    );
  });

  const thenableCanary = "PRIVATE-CAPABILITY-THENABLE-CANARY";
  const hostileThenable = lifecycleContext({
    ensureClaudeCallbackCapability: () => ({
      get then() {
        throw new Error(thenableCanary);
      },
    }),
  });
  await withLifecycleFixture(hostileThenable, async (options) => {
    await assert.rejects(
      hostileThenable.installClaudeCallback(options),
      (error) => fixedConfigurationWithout(error, thenableCanary),
    );
  });

  const reviewed = new ClaudeCallbackCapabilityError("credential_locked");
  const reviewedFailure = lifecycleContext({
    ensureClaudeCallbackCapability: async () => {
      throw reviewed;
    },
  });
  await withLifecycleFixture(reviewedFailure, async (options) => {
    await assert.rejects(
      reviewedFailure.installClaudeCallback(options),
      (error) => error === reviewed,
    );
  });

  const proxiedReviewed = new Proxy(reviewed, {});
  const proxiedReviewedFailure = lifecycleContext({
    ensureClaudeCallbackCapability: async () => {
      throw proxiedReviewed;
    },
  });
  await withLifecycleFixture(proxiedReviewedFailure, async (options) => {
    await assert.rejects(
      proxiedReviewedFailure.installClaudeCallback(options),
      fixedConfigurationError,
    );
  });
});

test("ensure result validation is closed, content-free, and intrinsically zeroizing", async () => {
  const getterCanary = "PRIVATE-CAPABILITY-GETTER-CANARY";
  const getterSecret = Buffer.alloc(32, 29);
  const getterResult = { secret: getterSecret };
  Object.defineProperty(getterResult, "status", {
    enumerable: true,
    get() {
      throw new Error(getterCanary);
    },
  });
  const throwingGetter = lifecycleContext({
    ensureClaudeCallbackCapability: async () => getterResult,
  });
  await withLifecycleFixture(throwingGetter, async (options) => {
    await assert.rejects(
      throwingGetter.installClaudeCallback(options),
      (error) => fixedConfigurationWithout(error, getterCanary),
    );
  });
  assert.deepEqual(getterSecret, Buffer.alloc(32));

  let statusReads = 0;
  const singleReadSecret = Buffer.alloc(32, 28);
  const singleReadResult = { secret: singleReadSecret };
  Object.defineProperty(singleReadResult, "status", {
    enumerable: true,
    get() {
      statusReads += 1;
      return statusReads === 1 ? "created" : "PRIVATE-SECOND-STATUS";
    },
  });
  const singleRead = lifecycleContext({
    ensureClaudeCallbackCapability: async () => singleReadResult,
  });
  await withLifecycleFixture(singleRead, async (options) => {
    assert.deepEqual(await singleRead.installClaudeCallback(options), {
      status: "installed",
      capability: "created",
    });
  });
  assert.equal(statusReads, 1);
  assert.deepEqual(singleReadSecret, Buffer.alloc(32));

  let fakeFillCalls = 0;
  const fakeFill = lifecycleContext({
    ensureClaudeCallbackCapability: async () => ({
      status: "created",
      secret: {
        fill() {
          fakeFillCalls += 1;
          throw new Error("PRIVATE-FAKE-FILL-CANARY");
        },
      },
    }),
  });
  await withLifecycleFixture(fakeFill, async (options) => {
    await assert.rejects(
      fakeFill.installClaudeCallback(options),
      fixedConfigurationError,
    );
  });
  assert.equal(fakeFillCalls, 0);

  let shadowedFillCalls = 0;
  const shadowedFillSecret = Buffer.alloc(32, 27);
  Object.defineProperty(shadowedFillSecret, "fill", {
    configurable: true,
    value() {
      shadowedFillCalls += 1;
      throw new Error("PRIVATE-SHADOWED-FILL-CANARY");
    },
  });
  const shadowedFill = lifecycleContext({
    ensureClaudeCallbackCapability: async () => ({
      status: "unknown",
      secret: shadowedFillSecret,
    }),
  });
  await withLifecycleFixture(shadowedFill, async (options) => {
    await assert.rejects(
      shadowedFill.installClaudeCallback(options),
      fixedConfigurationError,
    );
  });
  assert.equal(shadowedFillCalls, 0);
  assert.deepEqual([...shadowedFillSecret], [...Buffer.alloc(32)]);

  const proxiedResultSecret = Buffer.alloc(32, 26);
  const proxiedResult = lifecycleContext({
    ensureClaudeCallbackCapability: async () => new Proxy({
      status: "created",
      secret: proxiedResultSecret,
    }, {}),
  });
  await withLifecycleFixture(proxiedResult, async (options) => {
    await assert.rejects(
      proxiedResult.installClaudeCallback(options),
      fixedConfigurationError,
    );
  });
  assert.deepEqual(proxiedResultSecret, Buffer.alloc(32));

  for (const result of [
    { status: "unknown", secret: Buffer.alloc(32, 30) },
    { status: "created", secret: Buffer.alloc(31, 31) },
    { status: "created", secret: Buffer.alloc(32, 32), extra: true },
  ]) {
    const malformed = lifecycleContext({
      ensureClaudeCallbackCapability: async () => result,
    });
    await withLifecycleFixture(malformed, async (options) => {
      await assert.rejects(
        malformed.installClaudeCallback(options),
        fixedConfigurationError,
      );
    });
    assert.deepEqual(result.secret, Buffer.alloc(result.secret.length));
  }
});

test("rotate, removal planning, and removal return only validated closed results", async () => {
  const context = lifecycleContext({
    rotateClaudeCallbackCapability: async () => ({
      status: "rotated",
      privateExtra: "PRIVATE-ROTATE-CANARY",
    }),
    planClaudeCallbackCapabilityRemoval: async () => ({
      status: "ready",
      confirmationToken: "not-a-reviewed-token",
    }),
    removeClaudeCallbackCapability: async () => ({
      status: "removed",
      secureErasure: true,
    }),
  });
  await withLifecycleFixture(context, async (options) => {
    await context.installClaudeCallback(options);
    await context.uninstallClaudeCallback(options);
    await assert.rejects(
      context.rotateManagedClaudeCallbackCapability(options),
      fixedConfigurationError,
    );
    await assert.rejects(
      context.planManagedClaudeCallbackCapabilityRemoval(options),
      fixedConfigurationError,
    );
    await assert.rejects(
      context.removeManagedClaudeCallbackCapability(options),
      fixedConfigurationError,
    );
  });
});

test("platform owner is opaque and the flat module is a composition-only identity shim", async () => {
  const ownerSource = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "src/platform/claude-callback-lifecycle.js",
    ),
    "utf8",
  );
  assert.doesNotMatch(ownerSource, /src\/application|\.\.\/application/u);
  assert.doesNotMatch(ownerSource, /src\/storage|\.\.\/storage|\.\/storage/u);
  assert.doesNotMatch(ownerSource, /claude-callback-capability\.js/u);
  assert.match(
    ownerSource,
    /from "\.\/participant-identity\.js";/u,
  );

  const legacySource = await readFile(
    resolve(REPOSITORY_ROOT, "src/claude-callback-lifecycle.js"),
    "utf8",
  );
  assert.match(
    legacySource,
    /from "\.\/application\/claude-callback-capability\.js";/u,
  );
  assert.match(legacySource, /ClaudeCallbackCapabilityError/u);
  assert.match(
    legacySource,
    /from "\.\/platform\/claude-callback-lifecycle\.js";/u,
  );
  assert.match(
    legacySource,
    /from "\.\/platform\/export-identity-keychain\.js";/u,
  );
  assert.match(
    legacySource,
    /new URL\("\.\/claude-callback-runtime\.js", import\.meta\.url\)/u,
  );
  assert.match(
    legacySource,
    /export const \{[\s\S]*\} = CLAUDE_CALLBACK_LIFECYCLE;/u,
  );
  assert.doesNotMatch(legacySource, /export (?:async )?function/u);
});

test("local-review composes the reviewed facades with the exact packaged runtime path", async () => {
  const localReviewSource = await readFile(
    resolve(REPOSITORY_ROOT, "local-review/cli.js"),
    "utf8",
  );
  assert.doesNotMatch(
    localReviewSource,
    /src\/claude-callback-lifecycle\.js/u,
  );
  assert.match(localReviewSource, /src\/application\/local-review\.js/u);
  assert.match(localReviewSource, /ClaudeCallbackCapabilityError/u);
  assert.match(localReviewSource, /src\/platform\/local-review\.js/u);
  assert.match(
    localReviewSource,
    /createClaudeCallbackLifecycleContext\(\{/u,
  );
  assert.match(
    localReviewSource,
    /new URL\("\.\.\/src\/claude-callback-runtime\.js", import\.meta\.url\)/u,
  );

  const runtimeScript = fileURLToPath(
    new URL("../src/claude-callback-runtime.js", import.meta.url),
  );
  assert.equal(
    legacy.buildManagedClaudeStatusLine({
      nodeExecutable: "/safe/node",
    }).command,
    `'/safe/node' '${runtimeScript}'`,
  );
});

test("the exact local-review lifecycle migration allowance is removed", async () => {
  const architecture = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "scripts/check-architecture-boundaries.mjs",
    ),
    "utf8",
  );
  const baseline = architecture.slice(
    architecture.indexOf(
      "const LOCAL_REVIEW_LEGACY_MIGRATION_TARGETS",
    ),
    architecture.indexOf("export const LEGACY_STORAGE_DIRECT_IMPORTERS"),
  );
  assert.doesNotMatch(
    baseline,
    /src\/claude-callback-lifecycle\.js/u,
  );
  assert.deepEqual(
    [...baseline.matchAll(/"(src\/[^"]+)"/gu)].map((match) => match[1]),
    [],
  );
});
