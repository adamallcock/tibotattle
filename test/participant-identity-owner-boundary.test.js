import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";
import * as legacy from "../src/export-identity.js";
import * as platform from "../src/platform/index.js";
import * as participantIdentity from
  "../src/platform/participant-identity.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PARTICIPANT_IDENTITY_EXPORTS = Object.freeze([
  "defaultExportSecretFile",
  "defaultExportStateDirectory",
  "deriveAccountScopeId",
  "deriveEventId",
  "deriveEventOccurrenceId",
  "deriveExportPseudonym",
  "deriveExportPseudonymV2",
  "deriveMarkerId",
  "deriveMarkerOccurrenceId",
  "deriveModelFingerprint",
  "deriveParticipantId",
  "deriveQuotaStateId",
  "deriveSessionScopeId",
  "deriveSnapshotId",
  "deriveSnapshotObservationId",
  "encodeParticipantSecret",
  "inspectParticipantSecret",
  "legacyWorkingDirectorySecretFile",
  "loadOrCreateParticipantSecret",
  "participantSecretBackendRetirementFile",
  "participantSecretLegacyRetirementFile",
  "randomBundleId",
  "rotateParticipantSecret",
  "withParticipantSecretLease",
]);

test("participant identity has one exact platform owner and legacy API", () => {
  assert.deepEqual(
    Object.keys(participantIdentity).sort(),
    [...PARTICIPANT_IDENTITY_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(legacy).sort(),
    [...PARTICIPANT_IDENTITY_EXPORTS].sort(),
  );
  for (const name of PARTICIPANT_IDENTITY_EXPORTS) {
    assert.equal(platform[name], participantIdentity[name], name);
    assert.equal(legacy[name], participantIdentity[name], name);
  }
});

test("legacy participant identity is implementation-free and local-review uses the platform facade", async () => {
  const legacySource = await readFile(
    resolve(REPOSITORY_ROOT, "src/export-identity.js"),
    "utf8",
  );
  assert.match(legacySource, /from "\.\/platform\/index\.js";/u);
  assert.doesNotMatch(legacySource, /export\s+\*/u);
  assert.doesNotMatch(
    legacySource,
    /\b(?:class|const|function|let|var)\b|node:/u,
  );

  const localReviewSource = await readFile(
    resolve(REPOSITORY_ROOT, "local-review/cli.js"),
    "utf8",
  );
  assert.doesNotMatch(
    localReviewSource,
    /src\/export-identity\.js/u,
  );
  assert.match(
    localReviewSource,
    /from "\.\.\/src\/platform\/index\.js";/u,
  );
});

test("participant identity owner depends only on its exact Node runtime ports", async () => {
  const ownerSource = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "src/platform/participant-identity.js",
    ),
    "utf8",
  );
  assert.deepEqual(
    (await extractEsmImports(ownerSource))
      .map(({ specifier }) => specifier)
      .sort(),
    [
      "@app-usagemonitor/identity-core",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:os",
      "node:path",
    ],
  );
});

test("the exact participant identity migration allowance is removed", async () => {
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
  assert.doesNotMatch(baseline, /src\/export-identity\.js/u);
});
