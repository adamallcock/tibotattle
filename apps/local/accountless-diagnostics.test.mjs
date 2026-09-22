import test from "node:test";
import assert from "node:assert/strict";
import { createAccountlessDiagnosticRecorder } from "./accountless-diagnostics.js";

test("accountless support trail is allowlisted, bounded and contains no input details", async () => {
  const notes = [];
  let now = 1000;
  const record = createAccountlessDiagnosticRecorder({
    clock: () => now, createReference: () => "TT-ABC123", recordNote: async (note) => notes.push(note),
  });
  const failure = { state: "retry_wait", lastFailureCode: "transient_failure", error: "synthetic private body" };
  assert.equal(await record(failure), true);
  assert.equal(await record(failure), false);
  assert.equal(await record({ state: "paused", lastFailureCode: "synthetic_private_error" }), false);
  assert.equal(await record({ state: "off", lastFailureCode: "terminal_failure" }), false);
  assert.deepEqual(notes, [{ reference: "TT-ABC123", surface: "automatic_contribution", code: "accountless_transient_failure", requestId: "" }]);
  now += 3600000;
  assert.equal(await record(failure), true);
  now = 0;
  assert.equal(await record(failure), false, "clock rollback rebases without a write storm");
  now += 3600000;
  assert.equal(await record(failure), true, "stable clock resumes the trail after rollback");
  assert.equal(await record({ state: "uploading" }), true);
  assert.equal(await record({ state: "up_to_date", lastSuccessfulSyncAt: null, lastFailureCode: null }), false);
  assert.equal(await record({ state: "up_to_date", lastFailureCode: null }), false);
  assert.equal(await record({ state: "up_to_date", lastSuccessfulSyncAt: "bad", lastFailureCode: null }), false);
  assert.equal(await record({ state: "up_to_date", lastSuccessfulSyncAt: "2026-09-22T00:00:00.000Z", lastFailureCode: null }), true);
  now += 3600000;
  assert.equal(await record({ state: "pending", lastSuccessfulSyncAt: "2026-09-22T00:00:00.000Z", lastFailureCode: null }), false,
    "publication wake does not report the earlier sync as a new success");
});

test("failed private diagnostic writes are swallowed and rate limited", async () => {
  let calls = 0;
  const record = createAccountlessDiagnosticRecorder({ clock: () => 1000, createReference: () => "TT-ABC123",
    recordNote: async () => { calls += 1; throw new Error("synthetic sink failure"); } });
  assert.equal(await record({ state: "paused", lastFailureCode: "terminal_failure" }), false);
  assert.equal(await record({ state: "paused", lastFailureCode: "terminal_failure" }), false);
  assert.equal(calls, 1);
});
