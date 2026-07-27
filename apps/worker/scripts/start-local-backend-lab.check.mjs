import assert from "node:assert/strict";
import test from "node:test";
import {
  backendSmokeSourceArguments,
  parseLocalBackendLabArguments,
  projectLocalBackendLabReceipt,
} from "./start-local-backend-lab-lib.mjs";

test("backend laboratory defaults to its generated content-free fixture", () => {
  const parsed = parseLocalBackendLabArguments([
    "--exit-after-receipt",
    "--port",
    "8793",
  ]);
  assert.equal(parsed.port, 8793);
  assert.equal(parsed.companionPort, 8791);
  assert.equal(parsed.exitAfterReceipt, true);
  assert.equal(parsed.startCompanion, false);
  assert.deepEqual(
    backendSmokeSourceArguments(parsed.source),
    ["--generated-content-free-fixture"],
  );
});

test("backend laboratory accepts exactly one explicit prepared contribution", () => {
  const parsed = parseLocalBackendLabArguments([
    "--file",
    "./prepared.json",
    "--state-directory",
    "./state",
  ]);
  assert.equal(parsed.source.mode, "prepared_contribution");
  assert.equal(parsed.startCompanion, true);
  assert.equal(parsed.companionPort, 8791);
  assert.deepEqual(
    backendSmokeSourceArguments(parsed.source),
    ["--file", parsed.source.contributionFile],
  );
  assert.throws(
    () => parseLocalBackendLabArguments([
      "--file",
      "./prepared.json",
      "--generated-content-free-fixture",
    ]),
    /mutually exclusive/u,
  );
  assert.throws(
    () => parseLocalBackendLabArguments(["--file", "one", "--file", "two"]),
    /Duplicate option/u,
  );
  assert.throws(
    () => parseLocalBackendLabArguments([
      "--port",
      "8792",
      "--companion-port",
      "8792",
    ]),
    /must differ/u,
  );
});

test("backend-only laboratory leaves the local companion stopped", () => {
  const parsed = parseLocalBackendLabArguments([
    "--backend-only",
    "--port",
    "8892",
    "--companion-port",
    "8891",
  ]);
  assert.equal(parsed.backendOnly, true);
  assert.equal(parsed.startCompanion, false);
});

test("real-file laboratory receipt projection excludes private locations", () => {
  const receipt = projectLocalBackendLabReceipt({
    receipt: {
      schemaVersion: "local-backend-lab-receipt-v0.3",
      status: "ready",
      smoke: { participants: 20 },
    },
    sourceMode: "prepared_contribution",
    locations: {
      stateDirectory: "/private/state",
      participantAccessFile: "/private/access",
      redeemedInvitationDirectory: "/private/invites",
      redeemedInvitationFilesRetained: 20,
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.source.mode, "prepared_contribution");
  assert.equal(receipt.cleanup.recoverableCleanupRequired, true);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("participantAccessFile"), false);
  assert.equal(serialized.includes("stateDirectory"), false);
});
