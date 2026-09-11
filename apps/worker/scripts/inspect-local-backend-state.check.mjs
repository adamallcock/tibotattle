import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { localOwnerFixtureMaterial } from "./local-owner-fixture.mjs";
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
          withdrawn_suppressed_snapshots: 0,
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
    assert.equal(summary.database.withdrawnSuppressedSnapshots, 0);
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

test("owner-fixture withdrawal preserves verifiable empty suppression evidence", (t) => {
  const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
  const stateDirectory = mkdtempSync(join(tmpdir(), "app-usagemonitor-suppression-check."));
  t.after(() => rmSync(stateDirectory, { recursive: true, force: false }));
  const db = new DatabaseSync(":memory:");
  const ledger = new DatabaseSync(":memory:");
  t.after(() => { db.close(); ledger.close(); });
  for (const [database, directory] of [[db, "migrations"], [ledger, "deletion-ledger-migrations"]]) {
    for (const name of readdirSync(join(workerDirectory, directory)).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(readFileSync(join(workerDirectory, directory, name), "utf8"));
    }
  }
  const owner = localOwnerFixtureMaterial("http://127.0.0.1:8792");
  db.exec(owner.sql);
  const valid = { releaseStatus: "suppressed", reason: "privacy_release_policy_not_met", cells: [] };
  const payloads = [
    valid,
    { ...valid, cells: [{ mustNotCount: true }] },
    { ...valid, cells: null },
    { ...valid, cells: {} },
    { ...valid, reason: "not-privacy-suppression" },
    { ...valid, releaseStatus: "published" },
  ].map((value) => JSON.stringify(value));
  for (const [index, payload] of payloads.entries()) {
    db.prepare(`INSERT INTO community_weekly_snapshots (
      snapshot_id, week_start, week_end, revision, ingestion_cutoff_at, released_at,
      policy_version, payload_json, payload_sha256, release_state, sealed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'suppressed', ?)`).run(
      `snapshot-fixture-${index}`, "2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z",
      index + 1, "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z",
      "community-weekly-v0.1", payload, createHash("sha256").update(payload).digest("hex"),
      "2026-09-02T00:00:00.000Z",
    );
  }
  const inspect = () => inspectLocalBackendState({
    persistTo: stateDirectory, workerDirectory,
    spawn: (_command, args) => {
      assert.equal(args.includes("--local"), true);
      const database = args[2] === "USAGE_MONITOR_DB" ? db : ledger;
      return { status: 0, stdout: JSON.stringify([{ results: database.prepare(args[args.indexOf("--command") + 1]).all() }]) };
    },
  });
  const before = inspect();
  assert.equal(before.database.suppressedSnapshots, payloads.length);
  assert.equal(before.database.withdrawnSuppressedSnapshots, 0);
  // The real erasure transition withdraws even an owner's zero-contribution
  // snapshot cache. The terminal payload cannot be rewritten by this trigger.
  db.prepare("UPDATE participants SET state = 'deleting' WHERE id = ?").run(owner.access.participantId);
  db.prepare("DELETE FROM participants WHERE id = ?").run(owner.access.participantId);
  const after = inspect();
  assert.equal(after.database.activeParticipants, 0);
  assert.equal(after.database.activeSessions, 0);
  assert.equal(after.database.publishedSnapshots, 0);
  assert.equal(after.database.suppressedSnapshots, 0);
  assert.equal(after.database.withdrawnSnapshots, payloads.length);
  assert.equal(after.database.withdrawnSuppressedSnapshots, 1);
  assert.deepEqual(db.prepare("SELECT payload_json FROM community_weekly_snapshots ORDER BY revision").all().map((row) => row.payload_json), payloads);
  assert.throws(() => db.prepare("UPDATE community_weekly_snapshots SET payload_json = ?").run("{}"), /immutable/u);
  assert.doesNotMatch(JSON.stringify(after), /participant:|payload_json|mustNotCount/u);
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
