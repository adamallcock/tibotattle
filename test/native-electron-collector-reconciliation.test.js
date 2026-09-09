import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitLocalCollectorState,
  readLocalCollectorState,
} from "../src/local-collector-state.js";
import {
  parseNativeElectronCollectorReconciliationArguments,
  planNativeElectronCollectorReconciliation,
  reconcileNativeElectronCollectorPrivateCopy,
} from "../scripts/reconcile-native-electron-collector-observations.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function checkpoint(marker) {
  return {
    schemaVersion: "0.3",
    collectionStartedAt: "2026-09-08T00:00:00.000Z",
    files: {},
    recentEventKeys: [],
    lastQuotaObservedAt: null,
    accountScopeMarker: marker,
    diagnostics: {},
    indexing: {
      mode: "recent_7d", status: "recent_7d_indexing", phase: "discovering",
      boundedBy: "modified_at_and_collection_start", filesDiscovered: 0,
      filesSelected: 0, filesProcessed: 0, recordsWritten: 0,
      coveredAt: { startAt: "2026-09-08T00:00:00.000Z", endAt: null },
    },
  };
}

function record(eventKey) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    observedAt: "2026-09-08T00:01:00.000Z",
    eventKey,
    quota: { synthetic: true },
  };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "native-electron-collector-reconcile-"));
  const copyRoot = join(root, "private-copies");
  const native = join(copyRoot, "native-local-collector-state-v1.sqlite");
  const electron = join(copyRoot, "electron-local-collector-state-v1.sqlite");
  const baseline = join(copyRoot, "electron-local-collector-state-before-reconcile.sqlite");
  const proof = join(copyRoot, "collector-conservation.json");
  try {
    await mkdir(copyRoot, { mode: 0o700 });
    const shared = record("synthetic-shared");
    const duplicate = record("synthetic-duplicate");
    const nativeOnly = record("synthetic-native-only");
    const destinationCheckpoint = checkpoint("electron");
    await commitLocalCollectorState({
      stateFile: native,
      checkpoint: checkpoint("native"),
      records: [shared, duplicate, duplicate, nativeOnly],
    });
    await commitLocalCollectorState({
      stateFile: electron,
      checkpoint: destinationCheckpoint,
      records: [shared, duplicate],
    });
    await copyFile(electron, baseline);
    await chmod(baseline, 0o600);
    await writeFile(proof, `${JSON.stringify({
      schema: "tibotattle-native-electron-collector-conservation-r9-v1",
      inspection: "read-only",
      scope: "stopped-native-r9-versus-current-electron",
      saltMatches: true,
      nativeRows: 4,
      electronRows: 2,
    })}\n`, { mode: 0o600 });
    return await run({ root, copyRoot, native, electron, baseline, proof, destinationCheckpoint });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("private-copy plan is content-free and finds digest-plus-kind multiplicity", async () => fixture(async ({ copyRoot, native, electron }) => {
  const beforeNative = sha256(await readFile(native));
  const beforeElectron = sha256(await readFile(electron));
  const result = await planNativeElectronCollectorReconciliation({ copyRoot });
  assert.deepEqual(result, {
    schema: "tibotattle-native-electron-collector-reconciliation-v1",
    status: "planned_private_copy_only",
    sourceRecordCount: 4,
    destinationRecordCountBefore: 2,
    missingSourceRecordMultiplicity: 2,
    identitySaltProven: true,
    destinationCheckpointPreserved: null,
    destinationMetadataPreserved: null,
    destinationExistingRecordsPreserved: null,
    insertedRecordMultiplicity: 0,
    destinationRecordCountAfter: 2,
  });
  assert.equal(sha256(await readFile(native)), beforeNative);
  assert.equal(sha256(await readFile(electron)), beforeElectron);
  assert.equal(JSON.stringify(result).includes("synthetic-native-only"), false);
}));

test("explicit private-copy reconciliation is append-only, checkpoint-preserving and idempotent", async () => fixture(async ({ root, copyRoot, native, electron, baseline, destinationCheckpoint }) => {
  const baselineHash = sha256(await readFile(baseline));
  const sourceHash = sha256(await readFile(native));
  const result = await reconcileNativeElectronCollectorPrivateCopy({
    copyRoot,
    confirmAppendOnlyPrivateCopy: true,
  });
  assert.equal(result.status, "reconciled_private_copy");
  assert.equal(result.insertedRecordMultiplicity, 2);
  assert.equal(result.destinationRecordCountAfter, 4);
  assert.equal(result.destinationCheckpointPreserved, true);
  assert.equal(result.destinationMetadataPreserved, true);
  assert.equal(result.destinationExistingRecordsPreserved, true);
  assert.equal(sha256(await readFile(native)), sourceHash);
  assert.equal(sha256(await readFile(baseline)), baselineHash);
  assert.deepEqual((await readLocalCollectorState({ stateFile: electron, includeRecords: false })).checkpoint, destinationCheckpoint);
  const receipt = JSON.parse(await readFile(join(copyRoot, "collector-reconciliation-receipt-v1.json"), "utf8"));
  assert.equal(receipt.status, "verified");
  assert.equal(JSON.stringify(receipt).includes("synthetic-native-only"), false);
  if (process.platform !== "win32") assert.equal((await stat(join(copyRoot, "collector-reconciliation-receipt-v1.json"))).mode & 0o777, 0o600);

  const cloneRoot = join(root, "private-copies-idempotent");
  await mkdir(cloneRoot, { mode: 0o700 });
  await copyFile(join(copyRoot, "native-local-collector-state-v1.sqlite"), join(cloneRoot, "native-local-collector-state-v1.sqlite"));
  await copyFile(join(copyRoot, "electron-local-collector-state-v1.sqlite"), join(cloneRoot, "electron-local-collector-state-v1.sqlite"));
  await copyFile(join(copyRoot, "electron-local-collector-state-v1.sqlite"), join(cloneRoot, "electron-local-collector-state-before-reconcile.sqlite"));
  for (const file of ["native-local-collector-state-v1.sqlite", "electron-local-collector-state-v1.sqlite", "electron-local-collector-state-before-reconcile.sqlite"]) {
    await chmod(join(cloneRoot, file), 0o600);
  }
  await writeFile(join(cloneRoot, "collector-conservation.json"), `${JSON.stringify({
    schema: "tibotattle-native-electron-collector-conservation-r9-v1",
    inspection: "read-only",
    scope: "stopped-native-r9-versus-current-electron",
    saltMatches: true,
    nativeRows: 4,
    electronRows: 4,
  })}\n`, { mode: 0o600 });
  const second = await reconcileNativeElectronCollectorPrivateCopy({
    copyRoot: cloneRoot,
    confirmAppendOnlyPrivateCopy: true,
  });
  assert.equal(second.insertedRecordMultiplicity, 0);
  assert.equal(second.missingSourceRecordMultiplicity, 0);
  assert.equal(second.destinationRecordCountAfter, 4);
}));

test("copy-root, baseline, proof and apply confirmation fail before a destination write", async () => fixture(async ({ copyRoot, electron, proof }) => {
  const before = sha256(await readFile(electron));
  await assert.rejects(
    () => reconcileNativeElectronCollectorPrivateCopy({ copyRoot }),
    { code: "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_CONFIRMATION_REQUIRED" },
  );
  assert.equal(sha256(await readFile(electron)), before);
  await writeFile(proof, `${JSON.stringify({ schema: "tibotattle-native-electron-collector-conservation-r9-v1", inspection: "read-only", scope: "stopped-native-r9-versus-current-electron", saltMatches: false, nativeRows: 4, electronRows: 2 })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => planNativeElectronCollectorReconciliation({ copyRoot }),
    { code: "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_PROOF_INVALID" },
  );
  assert.equal(sha256(await readFile(electron)), before);
  await unlink(join(copyRoot, "native-local-collector-state-v1.sqlite"));
  await assert.rejects(
    () => planNativeElectronCollectorReconciliation({ copyRoot }),
    { code: "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_UNAVAILABLE" },
  );
  assert.equal(sha256(await readFile(electron)), before);
}));

test("argument parser refuses a write flag without its explicit private-copy confirmation", () => {
  assert.throws(
    () => parseNativeElectronCollectorReconciliationArguments(["--copy-root", "/private/copies", "--apply-to-private-copy"]),
    { code: "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_CONFIRMATION_REQUIRED" },
  );
  assert.deepEqual(
    parseNativeElectronCollectorReconciliationArguments(["--copy-root", "/private/copies"]),
    { copyRoot: "/private/copies", conservationProof: null, apply: false, confirm: false },
  );
});
