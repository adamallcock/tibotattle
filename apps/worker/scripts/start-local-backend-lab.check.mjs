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
  assert.equal(parsed.exitAfterReceipt, true);
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
