import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION,
  RealLocalBackendAcceptanceError,
  parseRealLocalBackendAcceptanceArguments,
  runRealLocalBackendAcceptance,
} from "../src/real-local-backend-acceptance.js";

const START_AT = "2026-07-27T01:00:00.000Z";
const END_AT = "2026-07-27T02:00:00.000Z";
const PREPARATION_ID = "00000000-0000-4000-8000-000000000099";

async function localFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-real-acceptance-"));
  await chmod(root, 0o700);
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const identityFile = join(root, "identity.secret");
  const privateSession = "private-real-acceptance-session";
  const secret = Buffer.alloc(32, 7).toString("base64url");
  await writeFile(identityFile, `${secret}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const tokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-27T01:00:00.000Z",
      type: "session_meta",
      payload: { id: privateSession, source: "user" },
    },
    {
      timestamp: "2026-07-27T01:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-27T01:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_697_200,
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessions, "rollout-current.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const workDirectory = join(root, "work");
  const receiptFile = join(root, "acceptance-receipt.json");
  return {
    root,
    codexHome,
    identityFile,
    privateSession,
    workDirectory,
    receiptFile,
    activityFile: join(root, "missing-activity.jsonl"),
  };
}

function argumentsFor(files, overrides = {}) {
  return [
    "--confirm",
    overrides.confirm ?? REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION,
    "--start-at",
    overrides.startAt ?? START_AT,
    "--end-at",
    overrides.endAt ?? END_AT,
    "--codex-home",
    files.codexHome,
    "--identity-file",
    files.identityFile,
    "--work-directory",
    files.workDirectory,
    "--receipt-file",
    files.receiptFile,
    "--cleanup",
    overrides.cleanup ?? "recoverable-trash",
    "--activity-file",
    files.activityFile,
    "--port",
    "8793",
  ];
}

function labReceipt(recordCount) {
  return {
    schemaVersion: "local-backend-lab-receipt-v0.3",
    status: "ready",
    source: {
      mode: "prepared_contribution",
      containsRawLogs: false,
    },
    smoke: {
      participants: 20,
      acceptedRecordsPerParticipant: recordCount,
      idempotentReplay: true,
      privacyCanaryRejected: true,
      canonicalServerRepricing: true,
      personalStatisticsRecomputed: true,
      aggregatePublishedAtTwenty: true,
      authenticatedWeeklyComparison: true,
      participantExportVerified: true,
    },
    destructiveLifecycle: {
      d1: {
        activeParticipants: 0,
        acceptedContributions: 0,
        canonicalRecords: 0,
        retainedQuarantineReferences: 0,
        withdrawnSnapshots: 2,
        suppressedSnapshots: 1,
      },
      deletionLedger: { tombstones: 20 },
      directLocalR2ObjectCount: 0,
    },
    persistedRestart: {
      workerRestartedAgainstSameStateDirectory: true,
      privateStatsRestored: true,
    },
    acceptance: {
      individualContributionDeletionVerified: true,
      fullParticipantDeletionVerified: true,
      persistedRestartVerified: true,
    },
  };
}

test("argument gate rejects missing confirmation and non-bounded periods", async () => {
  const files = await localFixture();
  try {
    assert.throws(
      () => parseRealLocalBackendAcceptanceArguments(
        argumentsFor(files, { confirm: "NO" }),
      ),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "confirmation_required",
    );
    assert.throws(
      () => parseRealLocalBackendAcceptanceArguments(
        argumentsFor(files, { endAt: "2026-07-27T02:00:00.001Z" }),
      ),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "bounded_period_required",
    );
    assert.throws(
      () => parseRealLocalBackendAcceptanceArguments(
        argumentsFor(files, { cleanup: "delete" }),
      ),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "recoverable_cleanup_required",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("synthetic local logs bind preparation to backend evidence without Keychain or network", async () => {
  const files = await localFixture();
  const trashDestination = join(files.root, "recoverable-trash-item");
  let backendCalls = 0;
  let cleanupCalls = 0;
  try {
    const options = parseRealLocalBackendAcceptanceArguments(
      argumentsFor(files),
    );
    const receipt = await runRealLocalBackendAcceptance(options, {
      uuid: () => PREPARATION_ID,
      clock: () => "2026-07-27T02:05:00.000Z",
      async runBackendLab({ contributionFile, stateDirectory, port }) {
        backendCalls += 1;
        assert.equal(port, 8793);
        assert.equal(
          contributionFile.endsWith(
            "/telemetry-contribution-000001.json",
          ),
          true,
        );
        assert.equal(stateDirectory.endsWith("/backend-lab"), true);
        const contribution = JSON.parse(await readFile(
          contributionFile,
          "utf8",
        ));
        const recordCount = contribution.usageEvents.length
          + contribution.quotaSnapshots.length
          + contribution.activityMarkers.length;
        return labReceipt(recordCount);
      },
      async moveWorkspaceToTrash(path) {
        cleanupCalls += 1;
        assert.equal(path, await realpath(files.workDirectory));
        await rename(path, trashDestination);
      },
    });
    assert.equal(backendCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.source.coveredAt.startAt, START_AT);
    assert.equal(receipt.source.coveredAt.endAt, END_AT);
    assert.equal(receipt.source.privacyVerdict, "passed");
    assert.equal(receipt.source.transportReady, false);
    assert.match(receipt.source.bundleSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.source.privacyReceiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.preparedSet.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(
      receipt.preparedSet.selectedMember.sha256,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(receipt.backend.participants, 20);
    assert.equal(
      receipt.backend.destructiveFinalStorage.activeParticipants,
      0,
    );
    assert.equal(receipt.cleanup.workspaceDisposition, "moved_to_trash");
    assert.equal((await lstat(trashDestination)).isDirectory(), true);
    const persisted = JSON.parse(await readFile(files.receiptFile, "utf8"));
    assert.deepEqual(persisted, receipt);
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      files.root,
      files.codexHome,
      files.identityFile,
      files.workDirectory,
      files.receiptFile,
      files.privateSession,
      PREPARATION_ID,
      secretLookingValue(),
      "participantId",
      "accountScopeId",
      "sessionScopeId",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

function secretLookingValue() {
  return Buffer.alloc(32, 7).toString("base64url");
}

test("invalid options stop before source, backend, cleanup, or receipt dependencies", async () => {
  const files = await localFixture();
  const calls = [];
  try {
    const invalid = {
      ...parseRealLocalBackendAcceptanceArguments(argumentsFor(files)),
    };
    delete invalid.confirmation;
    await assert.rejects(
      runRealLocalBackendAcceptance(invalid, {
        prepareContribution: async () => calls.push("prepare"),
        verifySource: async () => calls.push("verify-source"),
        verifyPreparedSet: async () => calls.push("verify-set"),
        loadPreparedContribution: async () => calls.push("load-member"),
        runBackendLab: async () => calls.push("backend"),
        moveWorkspaceToTrash: async () => calls.push("cleanup"),
        writeReceipt: async () => calls.push("receipt"),
        uuid: randomUUID,
      }),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "arguments_invalid",
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("an existing receipt fails before workspace creation or source access", async () => {
  const files = await localFixture();
  const calls = [];
  try {
    await writeFile(files.receiptFile, "do-not-overwrite\n", {
      mode: 0o600,
      flag: "wx",
    });
    await assert.rejects(
      runRealLocalBackendAcceptance(
        parseRealLocalBackendAcceptanceArguments(argumentsFor(files)),
        {
          prepareContribution: async () => calls.push("prepare"),
          verifySource: async () => calls.push("verify-source"),
          verifyPreparedSet: async () => calls.push("verify-set"),
          loadPreparedContribution: async () => calls.push("load-member"),
          runBackendLab: async () => calls.push("backend"),
          moveWorkspaceToTrash: async () => calls.push("cleanup"),
          writeReceipt: async () => calls.push("receipt"),
        },
      ),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "receipt_destination_invalid",
    );
    assert.deepEqual(calls, []);
    await assert.rejects(lstat(files.workDirectory), { code: "ENOENT" });
    assert.equal(await readFile(files.receiptFile, "utf8"), "do-not-overwrite\n");
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("failed recoverable cleanup retains the workspace and publishes no receipt", async () => {
  const files = await localFixture();
  try {
    await assert.rejects(
      runRealLocalBackendAcceptance(
        parseRealLocalBackendAcceptanceArguments(argumentsFor(files)),
        {
          uuid: () => PREPARATION_ID,
          async runBackendLab({ contributionFile }) {
            const contribution = JSON.parse(await readFile(
              contributionFile,
              "utf8",
            ));
            return labReceipt(
              contribution.usageEvents.length
                + contribution.quotaSnapshots.length
                + contribution.activityMarkers.length,
            );
          },
          async moveWorkspaceToTrash() {
            throw new Error("simulated local Trash failure");
          },
        },
      ),
      (error) => error instanceof RealLocalBackendAcceptanceError
        && error.code === "recoverable_cleanup_failed",
    );
    assert.equal((await lstat(files.workDirectory)).isDirectory(), true);
    await assert.rejects(lstat(files.receiptFile), { code: "ENOENT" });
  } finally {
    await rm(files.root, { recursive: true });
  }
});
