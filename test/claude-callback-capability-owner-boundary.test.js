import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as applicationCapability from
  "../src/application/claude-callback-capability.js";
import * as application from "../src/application/index.js";
import * as legacy from "../src/claude-callback-capability.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const APPLICATION_EXPORTS = Object.freeze([
  "ClaudeCallbackCapabilityError",
  "createClaudeCallbackCapabilityContext",
  "selectProductionClaudeCallbackBackend",
]);
const LEGACY_EXPORTS = Object.freeze([
  "ClaudeCallbackCapabilityError",
  "createProductionClaudeCallbackBackend",
  "ensureClaudeCallbackCapability",
  "planClaudeCallbackCapabilityRemoval",
  "readClaudeCallbackCapability",
  "removeClaudeCallbackCapability",
  "rotateClaudeCallbackCapability",
]);

test("Claude callback capability owner and legacy APIs are exact", () => {
  assert.deepEqual(
    Object.keys(applicationCapability).sort(),
    [...APPLICATION_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(legacy).sort(),
    [...LEGACY_EXPORTS].sort(),
  );
  for (const name of APPLICATION_EXPORTS) {
    assert.equal(application[name], applicationCapability[name], name);
  }
  assert.equal(
    legacy.ClaudeCallbackCapabilityError,
    application.ClaudeCallbackCapabilityError,
  );
});

test("application policy is platform-opaque and consumers use reviewed facades", async () => {
  const ownerSource = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "src/application/claude-callback-capability.js",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    ownerSource,
    /(?:export-identity-keychain|src\/platform|\.\/platform)/u,
  );

  const legacySource = await readFile(
    resolve(REPOSITORY_ROOT, "src/claude-callback-capability.js"),
    "utf8",
  );
  assert.match(
    legacySource,
    /from "\.\/application\/claude-callback-capability\.js";/u,
  );
  assert.match(
    legacySource,
    /from "\.\/platform\/export-identity-keychain\.js";/u,
  );

  const localReviewSource = await readFile(
    resolve(REPOSITORY_ROOT, "local-review/cli.js"),
    "utf8",
  );
  assert.doesNotMatch(
    localReviewSource,
    /src\/claude-callback-capability\.js/u,
  );
  assert.match(
    localReviewSource,
    /createClaudeCallbackCapabilityContext/u,
  );
  assert.match(
    localReviewSource,
    /selectProductionClaudeCallbackBackend/u,
  );
});

test("the exact local-review migration allowance is removed", async () => {
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
    architecture.indexOf(
      "export const CURRENT_ARCHITECTURE_BOUNDARY_BASELINE",
    ),
  );
  assert.doesNotMatch(
    baseline,
    /src\/claude-callback-capability\.js/u,
  );
});
