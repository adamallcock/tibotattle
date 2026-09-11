import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOwnerErasureLifecycle,
  backendSmokeSourceArguments,
  localCompanionEnvironment,
  parseLocalBackendLabArguments,
  projectLocalBackendLabReceipt,
} from "./start-local-backend-lab-lib.mjs";

function erasedLifecycle() {
  return {
    database: {
      activeParticipants: 0, deletingParticipants: 0, acceptedContributions: 0,
      canonicalRecords: 0, contributionOccurrences: 0, retainedQuarantineReferences: 0,
      activeSessions: 0, activeDevices: 0, publishedSnapshots: 0,
      suppressedSnapshots: 0, withdrawnSnapshots: 1, withdrawnSuppressedSnapshots: 1,
    },
    deletionLedger: { tombstones: 21 },
  };
}

test("owner cleanup proves prior suppression from an immutable withdrawn empty revision", () => {
  assert.deepEqual(assertOwnerErasureLifecycle(erasedLifecycle(), 0), {
    suppressionEvidence: "immutable_withdrawn_empty_snapshot",
    suppressedRevisionsWithdrawn: 1,
    publishedSnapshotsRemaining: 0,
  });
});

test("terminal owner cleanup rejects surviving data, published snapshots or missing suppression evidence", () => {
  for (const name of [
    "activeParticipants", "deletingParticipants", "acceptedContributions", "canonicalRecords",
    "contributionOccurrences", "retainedQuarantineReferences", "activeSessions", "activeDevices",
    "publishedSnapshots",
  ]) {
    const storage = erasedLifecycle();
    storage.database[name] = 1;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), new RegExp(name, "u"));
  }
  for (const invalid of [0, undefined, null, -1, 0.5, 2]) {
    const storage = erasedLifecycle();
    storage.database.withdrawnSuppressedSnapshots = invalid;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), /withdrawnSuppressedSnapshots/u);
  }
  const missingWithdrawal = erasedLifecycle();
  missingWithdrawal.database.withdrawnSnapshots = 0;
  assert.throws(() => assertOwnerErasureLifecycle(missingWithdrawal, 0), /withdrawnSnapshots/u);
  for (const tombstones of [20, 22]) {
    const storage = erasedLifecycle();
    storage.deletionLedger.tombstones = tombstones;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), /tombstones/u);
  }
  assert.throws(() => assertOwnerErasureLifecycle(erasedLifecycle(), 1), /r2ObjectCount/u);
});

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

test("backend laboratory isolates companion state from the installed app", () => {
  const environment = localCompanionEnvironment({
    environment: { EXISTING: "preserved" },
    port: 8891,
    centralOrigin: "http://127.0.0.1:8892",
    stateRoot: "/private/lab/companion-state",
  });
  assert.deepEqual(environment, {
    EXISTING: "preserved",
    USAGE_MONITOR_PORT: "8891",
    USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8892",
    USAGE_MONITOR_STATE_ROOT: "/private/lab/companion-state",
  });
  assert.throws(
    () => localCompanionEnvironment({
      port: 8891,
      centralOrigin: "http://127.0.0.1:8892",
      stateRoot: "relative-state",
    }),
    /state root must be absolute/u,
  );
});

test("real-file laboratory receipt projection excludes private locations", () => {
  const receipt = projectLocalBackendLabReceipt({
    receipt: {
      schemaVersion: "local-backend-lab-receipt-v0.4",
      status: "ready",
      smoke: { participants: 20 },
    },
    sourceMode: "prepared_contribution",
    locations: {
      stateDirectory: "/private/state",
      participantAccessFile: "/private/access",
      ownerAccessFile: "/private/owner-access",
      redeemedInvitationDirectory: "/private/invites",
      redeemedInvitationFilesRetained: 20,
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.source.mode, "prepared_contribution");
  assert.equal(receipt.cleanup.recoverableCleanupRequired, true);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("participantAccessFile"), false);
  assert.equal(serialized.includes("ownerAccessFile"), false);
  assert.equal(serialized.includes("stateDirectory"), false);
});

test("generated-fixture lab receipt identifies separate local owner authority", () => {
  const receipt = projectLocalBackendLabReceipt({
    receipt: { schemaVersion: "local-backend-lab-receipt-v0.4", status: "ready" },
    sourceMode: "generated_content_free_fixture",
    locations: {
      stateDirectory: "/private/lab", participantAccessFile: "/private/lab/access",
      ownerAccessFile: "/private/lab/owner/access", redeemedInvitationDirectory: "/private/lab/invites",
      redeemedInvitationFilesRetained: 20,
    },
  });
  assert.equal(receipt.ownerAccessFile, "/private/lab/owner/access");
  assert.equal(receipt.ownerAccessFileContainsSecret, true);
  assert.notEqual(receipt.participantAccessFile, receipt.ownerAccessFile);
  assert.equal(receipt.cleanup.automaticOnShutdown, false);
});
