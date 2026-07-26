import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectLocalBackendState,
  parseD1Result,
} from "./inspect-local-backend-state.mjs";

test("parseD1Result accepts exactly one bounded results row", () => {
  assert.deepEqual(
    parseD1Result(JSON.stringify([{ results: [{ active_participants: 20 }] }])),
    { active_participants: 20 },
  );
  assert.throws(() => parseD1Result("not-json"), /invalid bounded D1 result/u);
  assert.throws(
    () => parseD1Result(JSON.stringify([{ results: [] }])),
    /no bounded D1 result row/u,
  );
});

test("local state inspection emits counts without identifiers or record contents", () => {
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "app-usagemonitor-state-inspection."),
  );
  chmodSync(stateDirectory, 0o700);
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    const binding = args[2];
    const results = binding === "USAGE_MONITOR_DB"
      ? [{
          active_participants: 20,
          deleting_participants: 0,
          accepted_contributions: 20,
          canonical_records: 40,
          contribution_occurrences: 40,
          retained_quarantine_references: 20,
          published_snapshots: 1,
          suppressed_snapshots: 0,
          withdrawn_snapshots: 0,
          active_sessions: 20,
          active_devices: 0,
        }]
      : [{ deletion_tombstones: 0 }];
    return {
      status: 0,
      stdout: JSON.stringify([{ results }]),
      stderr: "",
    };
  };

  try {
    const summary = inspectLocalBackendState({
      persistTo: stateDirectory,
      workerDirectory: stateDirectory,
      spawn,
    });
    assert.equal(summary.database.activeParticipants, 20);
    assert.equal(summary.database.acceptedContributions, 20);
    assert.equal(summary.database.canonicalRecords, 40);
    assert.equal(summary.database.publishedSnapshots, 1);
    assert.equal(summary.deletionLedger.tombstones, 0);
    assert.equal(summary.privacy.includesIdentifiers, false);
    assert.equal(summary.privacy.includesAuthorities, false);
    assert.equal(summary.privacy.includesRecordContents, false);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((args) => args.includes("--local")));
    assert.ok(calls.every((args) => args.includes("--persist-to")));
    assert.doesNotMatch(JSON.stringify(summary), /participant:/u);
    assert.doesNotMatch(JSON.stringify(summary), /um_recovery_/u);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: false });
  }
});

test("local state inspection rejects a group-readable directory before querying", () => {
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "app-usagemonitor-state-permissions."),
  );
  chmodSync(stateDirectory, 0o750);
  let called = false;
  try {
    assert.throws(
      () => inspectLocalBackendState({
        persistTo: stateDirectory,
        workerDirectory: stateDirectory,
        spawn: () => {
          called = true;
          return { status: 0, stdout: "[]", stderr: "" };
        },
      }),
      /must be owner-only/u,
    );
    assert.equal(called, false);
  } finally {
    chmodSync(stateDirectory, 0o700);
    rmSync(stateDirectory, { recursive: true, force: false });
  }
});
