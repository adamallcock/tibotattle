import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import {
  defaultLocalUnifiedIndexRecoveryLockPath,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import {
  applyLocalUnifiedIndexRecovery,
  localUnifiedIndexRecoveryPaths,
  prepareLocalUnifiedIndexRecovery,
  recoveryFileIdentity,
} from "../scripts/local-unified-index-recovery-core.mjs";

const CONTRACT = "usage-event-v0.2";
const RECOVERY_CLI = fileURLToPath(new URL(
  "../scripts/rebuild-local-unified-index.mjs",
  import.meta.url,
));

function sessionMeta() {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "11111111-1111-4111-8111-111111111111",
      session_id: "11111111-1111-4111-8111-111111111111",
      thread_source: "user",
      originator: "codex_cli_rs",
    },
  });
}

function turnContext() {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "turn_context",
    payload: {
      turn_id: "turn-1",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
  });
}

function tokenCount(timestamp, input, output) {
  const usage = {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: 200000,
      },
    },
  });
}

function usageCount(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try {
    return Number(database.prepare(
      "SELECT COUNT(*) AS count FROM usage_event",
    ).get().count);
  } finally {
    database.close();
  }
}

function recoveryLockRecord(pid = process.pid) {
  return `${JSON.stringify({
    schemaVersion: "local-unified-index-recovery-lock-v1",
    pid,
    acquiredAt: "2026-08-27T00:00:00.000Z",
  })}\n`;
}

async function recoveryFixture(prefix = "unified-index-recovery-audit-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessions = join(root, "sessions", "2026", "07", "25");
  const rollout = join(
    sessions,
    "rollout-2026-07-25T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  const indexFile = join(root, "index.sqlite");
  const secretFile = join(root, "salt");
  const paths = localUnifiedIndexRecoveryPaths(indexFile, join(root, "recovery"));
  await mkdir(sessions, { recursive: true });
  await writeFile(rollout, `${[
    sessionMeta(),
    turnContext(),
    tokenCount("2026-07-25T00:00:01.000Z", 100, 10),
  ].join("\n")}\n`);
  await rebuildLocalUnifiedIndex({
    codexHome: root,
    indexFile,
    secretFile,
    contractVersion: CONTRACT,
    workerCount: 1,
  });
  return { root, sessions, rollout, indexFile, secretFile, ...paths };
}

async function prepareFixture(fixture, extra = {}) {
  return prepareLocalUnifiedIndexRecovery({
    codexHome: fixture.root,
    indexFile: fixture.indexFile,
    candidateFile: fixture.candidateFile,
    backupFile: fixture.backupFile,
    receiptFile: fixture.receiptFile,
    secretFile: fixture.secretFile,
    contractVersion: CONTRACT,
    workerCount: 1,
    ...extra,
  });
}

test("copy-first recovery preserves the source until an explicitly confirmed apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-recovery-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  const rollout = join(
    sessions,
    "rollout-2026-07-25T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  const indexFile = join(root, "index.sqlite");
  const {
    candidateFile,
    backupFile,
    receiptFile,
    prePublishRollbackFile,
    recoverySecretFile,
  } = localUnifiedIndexRecoveryPaths(indexFile, join(root, "recovery"));
  const secretFile = join(root, "salt");
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(rollout, `${[
      sessionMeta(),
      turnContext(),
      tokenCount("2026-07-25T00:00:01.000Z", 100, 10),
    ].join("\n")}\n`);
    await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile,
      secretFile,
      contractVersion: CONTRACT,
      workerCount: 1,
    });
    assert.equal(usageCount(indexFile), 1);
    await appendFile(
      rollout,
      `${tokenCount("2026-07-25T00:00:02.000Z", 300, 30)}\n`,
    );
    const sourceBefore = await recoveryFileIdentity(indexFile);
    const secretBefore = await readFile(secretFile);

    const receipt = await prepareLocalUnifiedIndexRecovery({
      codexHome: root,
      indexFile,
      candidateFile,
      backupFile,
      receiptFile,
      secretFile,
      contractVersion: CONTRACT,
      workerCount: 1,
    });

    assert.deepEqual(await recoveryFileIdentity(indexFile), sourceBefore);
    assert.deepEqual(await readFile(secretFile), secretBefore);
    assert.deepEqual(await readFile(recoverySecretFile), secretBefore);
    assert.equal((await lstat(recoverySecretFile)).mode & 0o077, 0);
    assert.equal(usageCount(indexFile), 1);
    assert.equal(usageCount(backupFile), 1);
    assert.equal(usageCount(candidateFile), 2);
    assert.equal(receipt.backup.validation.quickCheck, "ok");
    assert.equal(receipt.candidate.validation.quickCheck, "ok");
    assert.equal(receipt.candidate.validation.eligibleForApply, true);
    assert.equal(receipt.secret.recoveryCopyPath, recoverySecretFile);
    assert.deepEqual(
      JSON.parse(await readFile(receiptFile, "utf8")).candidate.identity,
      await recoveryFileIdentity(candidateFile),
    );

    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile,
        candidateFile,
        receiptFile,
        confirmIndex: indexFile,
      }),
      (error) => error?.code
        === "local_unified_index_recovery_app_stop_unconfirmed",
    );
    assert.equal(usageCount(indexFile), 1);
    await lstat(candidateFile);

    let cooperatingOpenBlocked = false;
    const applied = await applyLocalUnifiedIndexRecovery({
      indexFile,
      candidateFile,
      receiptFile,
      confirmIndex: indexFile,
      confirmAppStopped: true,
      dependencies: {
        onLocked: () => {
          assert.throws(
            () => openLocalUnifiedIndex(indexFile, { readOnly: true }),
            (error) => error?.code
              === "local_unified_index_recovery_in_progress",
          );
          cooperatingOpenBlocked = true;
        },
      },
    });
    assert.equal(cooperatingOpenBlocked, true);
    assert.equal(applied.status, "applied");
    assert.equal(applied.backupFile, backupFile);
    assert.equal(applied.prePublishRollbackFile, prePublishRollbackFile);
    assert.equal(usageCount(indexFile), 2);
    assert.equal(usageCount(backupFile), 1);
    assert.equal(usageCount(prePublishRollbackFile), 1);
    await assert.rejects(lstat(candidateFile), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("apply refuses a source changed after preparation and leaves every path in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-recovery-race-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  const rollout = join(
    sessions,
    "rollout-2026-07-25T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  const indexFile = join(root, "index.sqlite");
  const { candidateFile, backupFile, receiptFile } =
    localUnifiedIndexRecoveryPaths(indexFile, join(root, "recovery"));
  const secretFile = join(root, "salt");
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(rollout, `${[
      sessionMeta(),
      turnContext(),
      tokenCount("2026-07-25T00:00:01.000Z", 100, 10),
    ].join("\n")}\n`);
    await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile,
      secretFile,
      contractVersion: CONTRACT,
      workerCount: 1,
    });
    await prepareLocalUnifiedIndexRecovery({
      codexHome: root,
      indexFile,
      candidateFile,
      backupFile,
      receiptFile,
      secretFile,
      contractVersion: CONTRACT,
      workerCount: 1,
    });
    const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
    database.prepare(
      "INSERT INTO meta(key, value) VALUES ('recovery_test_change', '1')",
    ).run();
    database.close();

    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile,
        candidateFile,
        receiptFile,
        confirmIndex: indexFile,
        confirmAppStopped: true,
      }),
      (error) => error?.code === "local_unified_index_recovery_source_changed",
    );
    await lstat(indexFile);
    await lstat(candidateFile);
    await lstat(backupFile);
    assert.equal(usageCount(indexFile), 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("preparation refuses a source that changes during the online backup", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-backup-race-");
  try {
    await assert.rejects(
      prepareFixture(fixture, {
        dependencies: {
          afterBackup: () => {
            const database = openLocalUnifiedIndex(fixture.indexFile, {
              readOnly: false,
            });
            database.prepare(
              "INSERT INTO meta(key, value) VALUES ('backup_race', 'changed')",
            ).run();
            database.close();
          },
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_source_changed_during_backup",
    );
    await lstat(fixture.backupFile);
    await assert.rejects(
      lstat(fixture.receiptFile),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(fixture.candidateFile),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("preparation copies an existing salt privately without mutating the live salt", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-secret-copy-");
  try {
    // 0400 is a valid owner-only salt. The ordinary rebuild reader historically
    // chmodded it to 0600, making this a deterministic non-mutation regression.
    await chmod(fixture.secretFile, 0o400);
    const bytesBefore = await readFile(fixture.secretFile);
    const metadataBefore = await lstat(fixture.secretFile);
    const receipt = await prepareFixture(fixture);
    const metadataAfter = await lstat(fixture.secretFile);
    assert.deepEqual(await readFile(fixture.secretFile), bytesBefore);
    assert.equal(metadataAfter.mode & 0o777, 0o400);
    assert.equal(metadataAfter.ino, metadataBefore.ino);
    assert.equal(metadataAfter.mtimeMs, metadataBefore.mtimeMs);
    assert.equal(metadataAfter.ctimeMs, metadataBefore.ctimeMs);
    assert.deepEqual(await readFile(fixture.recoverySecretFile), bytesBefore);
    assert.equal((await lstat(fixture.recoverySecretFile)).mode & 0o777, 0o600);
    assert.equal(receipt.secret.sourcePath, fixture.secretFile);
    assert.equal(receipt.secret.recoveryCopyPath, fixture.recoverySecretFile);
    assert.deepEqual(
      receipt.secret.sourceIdentity,
      receipt.secret.recoveryCopyIdentity,
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("preparation rejects WAL without opening SQLite or creating recovery state", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-wal-prepare-");
  let wal;
  try {
    wal = new DatabaseSync(fixture.indexFile);
    assert.equal(
      wal.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode,
      "wal",
    );
    wal.prepare(`
      INSERT INTO meta(key, value) VALUES ('wal_prepare_marker', 'committed')
    `).run();
    const mainBefore = await readFile(fixture.indexFile);
    const walBefore = await readFile(`${fixture.indexFile}-wal`);
    const shmBefore = await readFile(`${fixture.indexFile}-shm`);

    await assert.rejects(
      prepareFixture(fixture),
      (error) => error?.code === "local_unified_index_recovery_wal_unsupported",
    );

    assert.deepEqual(await readFile(fixture.indexFile), mainBefore);
    assert.deepEqual(await readFile(`${fixture.indexFile}-wal`), walBefore);
    assert.deepEqual(await readFile(`${fixture.indexFile}-shm`), shmBefore);
    await assert.rejects(
      lstat(fixture.recoveryDir),
      (error) => error?.code === "ENOENT",
    );
    assert.equal(
      wal.prepare(`
        SELECT value FROM meta WHERE key = 'wal_prepare_marker'
      `).get()?.value,
      "committed",
    );
  } finally {
    wal?.close();
    await rm(fixture.root, { recursive: true });
  }
});

test("preparation refuses missing or non-owner-only salts without creating recovery state", async (t) => {
  await t.test("missing", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-secret-missing-");
    try {
      await unlink(fixture.secretFile);
      await assert.rejects(
        prepareFixture(fixture),
        (error) => error?.code === "local_unified_index_recovery_secret_missing",
      );
      await assert.rejects(
        lstat(fixture.secretFile),
        (error) => error?.code === "ENOENT",
      );
      await assert.rejects(
        lstat(fixture.recoveryDir),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });

  await t.test("group-readable", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-secret-mode-");
    try {
      await chmod(fixture.secretFile, 0o640);
      const bytesBefore = await readFile(fixture.secretFile);
      const metadataBefore = await lstat(fixture.secretFile);
      await assert.rejects(
        prepareFixture(fixture),
        (error) => error?.code === "local_unified_index_recovery_secret_invalid",
      );
      const metadataAfter = await lstat(fixture.secretFile);
      assert.deepEqual(await readFile(fixture.secretFile), bytesBefore);
      assert.equal(metadataAfter.mode & 0o777, metadataBefore.mode & 0o777);
      assert.equal(metadataAfter.mtimeMs, metadataBefore.mtimeMs);
      assert.equal(metadataAfter.ctimeMs, metadataBefore.ctimeMs);
      await assert.rejects(
        lstat(fixture.recoveryDir),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });
});

test("apply detects tampering in candidate, backup, secrets, and sealed receipt", async (t) => {
  for (const target of [
    "candidate",
    "backup",
    "receipt",
    "secret-copy",
    "live-secret",
  ]) {
    await t.test(target, async () => {
      const fixture = await recoveryFixture(`unified-index-recovery-tamper-${target}-`);
      try {
        await prepareFixture(fixture);
        if (target === "candidate") {
          await appendFile(fixture.candidateFile, "tamper");
        } else if (target === "backup") {
          await appendFile(fixture.backupFile, "tamper");
        } else if (target === "secret-copy") {
          await appendFile(fixture.recoverySecretFile, "tamper");
        } else if (target === "live-secret") {
          await appendFile(fixture.secretFile, "tamper");
        } else {
          const receipt = JSON.parse(await readFile(fixture.receiptFile, "utf8"));
          receipt.createdAt = "2000-01-01T00:00:00.000Z";
          await chmod(fixture.receiptFile, 0o600);
          await writeFile(fixture.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
          await chmod(fixture.receiptFile, 0o400);
        }
        const expected = target === "receipt"
          ? "local_unified_index_recovery_receipt_invalid"
          : target === "secret-copy" || target === "live-secret"
            ? "local_unified_index_recovery_secret_changed"
            : `local_unified_index_recovery_${target}_changed`;
        await assert.rejects(
          applyLocalUnifiedIndexRecovery({
            indexFile: fixture.indexFile,
            candidateFile: fixture.candidateFile,
            receiptFile: fixture.receiptFile,
            confirmIndex: fixture.indexFile,
            confirmAppStopped: true,
          }),
          (error) => error?.code === expected,
        );
        assert.equal(usageCount(fixture.indexFile), 1);
      } finally {
        await rm(fixture.root, { recursive: true });
      }
    });
  }
});

test("recovery rejects symlinked and group-readable artifacts", async (t) => {
  await t.test("symlinked candidate", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-symlink-");
    try {
      await prepareFixture(fixture);
      const retainedCandidate = `${fixture.candidateFile}.retained`;
      await rename(fixture.candidateFile, retainedCandidate);
      await symlink(fixture.backupFile, fixture.candidateFile);
      await assert.rejects(
        applyLocalUnifiedIndexRecovery({
          indexFile: fixture.indexFile,
          candidateFile: fixture.candidateFile,
          receiptFile: fixture.receiptFile,
          confirmIndex: fixture.indexFile,
          confirmAppStopped: true,
        }),
        (error) => error?.code === "local_unified_index_file_invalid",
      );
      await assert.rejects(
        lstat(defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile)),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });

  await t.test("group-readable backup", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-mode-");
    try {
      await prepareFixture(fixture);
      await chmod(fixture.backupFile, 0o640);
      await assert.rejects(
        applyLocalUnifiedIndexRecovery({
          indexFile: fixture.indexFile,
          candidateFile: fixture.candidateFile,
          receiptFile: fixture.receiptFile,
          confirmIndex: fixture.indexFile,
          confirmAppStopped: true,
        }),
        (error) => error?.code === "local_unified_index_file_invalid",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });
});

test("recovery preparation refuses a symlinked parent before reserving artifacts", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-parent-link-");
  const realParent = join(fixture.root, "real-parent");
  const linkedParent = join(fixture.root, "linked-parent");
  const realIndex = join(realParent, "index.sqlite");
  const linkedIndex = join(linkedParent, "index.sqlite");
  try {
    await mkdir(realParent, { mode: 0o700 });
    await rename(fixture.indexFile, realIndex);
    await symlink(realParent, linkedParent);
    const paths = localUnifiedIndexRecoveryPaths(
      linkedIndex,
      join(linkedParent, "recovery"),
    );
    const sourceBefore = await readFile(realIndex);
    await assert.rejects(
      prepareLocalUnifiedIndexRecovery({
        codexHome: fixture.root,
        indexFile: linkedIndex,
        candidateFile: paths.candidateFile,
        backupFile: paths.backupFile,
        receiptFile: paths.receiptFile,
        secretFile: fixture.secretFile,
        contractVersion: CONTRACT,
        workerCount: 1,
      }),
      (error) => error?.code === "local_unified_index_file_invalid",
    );
    assert.deepEqual(await readFile(realIndex), sourceBefore);
    await assert.rejects(
      lstat(join(realParent, "recovery")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("preparation atomically rejects duplicate paths and an existing recovery directory", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-reservation-");
  try {
    await assert.rejects(
      prepareLocalUnifiedIndexRecovery({
        codexHome: fixture.root,
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        backupFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        secretFile: fixture.secretFile,
        contractVersion: CONTRACT,
      }),
      (error) => error?.code === "local_unified_index_recovery_paths_invalid",
    );
    await assert.rejects(
      lstat(fixture.recoveryDir),
      (error) => error?.code === "ENOENT",
    );

    await mkdir(fixture.recoveryDir, { mode: 0o700 });
    await assert.rejects(
      prepareFixture(fixture),
      (error) => error?.code === "local_unified_index_recovery_target_exists",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a final candidate race is caught after the exact rollback copy", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-final-race-");
  try {
    await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          beforeFinalRecheck: () => appendFile(fixture.candidateFile, "race"),
        },
      }),
      (error) => error?.code === "local_unified_index_recovery_candidate_changed",
    );
    assert.equal(usageCount(fixture.indexFile), 1);
    assert.equal(usageCount(fixture.prePublishRollbackFile), 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a SQLite sidecar introduced at the final boundary prevents rename", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-sidecar-race-");
  try {
    await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          beforeFinalRecheck: () => writeFile(
            `${fixture.indexFile}-wal`,
            "untrusted-sidecar",
            { flag: "wx", mode: 0o600 },
          ),
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_live_sidecar_present",
    );
    assert.equal(usageCount(fixture.indexFile), 1);
    await lstat(fixture.candidateFile);
    await lstat(fixture.prePublishRollbackFile);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("apply excludes a direct SQLite writer across final verification and publication", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-writer-race-");
  let writerBlocked = false;
  try {
    await prepareFixture(fixture);
    const applied = await applyLocalUnifiedIndexRecovery({
      indexFile: fixture.indexFile,
      candidateFile: fixture.candidateFile,
      receiptFile: fixture.receiptFile,
      confirmIndex: fixture.indexFile,
      confirmAppStopped: true,
      dependencies: {
        beforeFinalRecheck: () => {
          // This bypasses the cooperating sidecar check and deterministically
          // attempts the exact write that used to fit between hash and rename.
          const writer = new DatabaseSync(fixture.indexFile, { timeout: 0 });
          try {
            assert.throws(
              () => writer.prepare(`
                INSERT INTO meta(key, value)
                VALUES ('recovery_hash_rename_race', 'committed')
              `).run(),
              (error) => error?.errcode === 5,
            );
            writerBlocked = true;
          } finally {
            writer.close();
          }
        },
      },
    });
    assert.equal(applied.status, "applied");
    assert.equal(writerBlocked, true);
    const published = new DatabaseSync(fixture.indexFile, { readOnly: true });
    try {
      assert.equal(Number(published.prepare(`
        SELECT COUNT(*) AS count FROM meta
        WHERE key = 'recovery_hash_rename_race'
      `).get().count), 0);
    } finally {
      published.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("apply refuses a retained source WAL instead of publishing it with the candidate main file", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-wal-apply-");
  let walWriter;
  let retainedReader;
  try {
    await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          onLocked: () => {
            walWriter = new DatabaseSync(fixture.indexFile);
            assert.equal(
              walWriter.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode,
              "wal",
            );
            retainedReader = new DatabaseSync(fixture.indexFile, {
              readOnly: true,
            });
            retainedReader.exec("BEGIN");
            retainedReader.prepare("SELECT COUNT(*) FROM meta").get();
            walWriter.prepare(`
              INSERT INTO meta(key, value)
              VALUES ('retained_wal_marker', 'committed')
            `).run();
          },
        },
      }),
      (error) => error?.code === "local_unified_index_recovery_wal_unsupported",
    );

    assert.equal(
      walWriter.prepare(`
        SELECT value FROM meta WHERE key = 'retained_wal_marker'
      `).get()?.value,
      "committed",
    );
    await lstat(`${fixture.indexFile}-wal`);
    await lstat(`${fixture.indexFile}-shm`);
    await lstat(fixture.candidateFile);
    await assert.rejects(
      lstat(fixture.prePublishRollbackFile),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    try {
      retainedReader?.exec("ROLLBACK");
    } catch {
      // Test cleanup only.
    }
    retainedReader?.close();
    walWriter?.close();
    await rm(fixture.root, { recursive: true });
  }
});

test("apply rejects a WAL candidate before acquiring recovery state", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-wal-candidate-");
  let walCandidate;
  try {
    await prepareFixture(fixture);
    walCandidate = new DatabaseSync(fixture.candidateFile);
    assert.equal(
      walCandidate.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode,
      "wal",
    );
    walCandidate.prepare(`
      INSERT INTO meta(key, value) VALUES ('wal_candidate_marker', 'committed')
    `).run();

    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
      }),
      (error) => error?.code === "local_unified_index_recovery_wal_unsupported",
    );

    assert.equal(usageCount(fixture.indexFile), 1);
    assert.equal(
      walCandidate.prepare(`
        SELECT value FROM meta WHERE key = 'wal_candidate_marker'
      `).get()?.value,
      "committed",
    );
    await assert.rejects(
      lstat(fixture.prePublishRollbackFile),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    walCandidate?.close();
    await rm(fixture.root, { recursive: true });
  }
});

test("the former publisher override seam is rejected without renaming", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-publish-override-");
  let overrideCalled = false;
  try {
    const receipt = await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          publish: async () => {
            overrideCalled = true;
            await writeFile(`${fixture.indexFile}-wal`, "forged-sidecar");
          },
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_publish_override_forbidden",
    );
    assert.equal(overrideCalled, false);
    assert.deepEqual(
      await recoveryFileIdentity(fixture.indexFile),
      receipt.source.identity,
    );
    assert.deepEqual(
      await recoveryFileIdentity(fixture.candidateFile),
      receipt.candidate.identity,
    );
    await assert.rejects(
      lstat(`${fixture.indexFile}-wal`),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(fixture.prePublishRollbackFile),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("post-publication uncertainty retains the exact rollback and reports mutation", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-uncertain-");
  try {
    await appendFile(
      fixture.rollout,
      `${tokenCount("2026-07-25T00:00:02.000Z", 300, 30)}\n`,
    );
    await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          afterPublication: () => {
            const error = new Error(
              "simulated_post_publication_failure",
            );
            error.code = "simulated_post_publication_failure";
            throw error;
          },
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_publication_state_uncertain"
        && error?.published === true
        && error?.candidateConsumed === true
        && error?.causeCode === "simulated_post_publication_failure"
        && error?.prePublishRollbackFile === fixture.prePublishRollbackFile,
    );
    assert.equal(usageCount(fixture.indexFile), 2);
    assert.equal(usageCount(fixture.backupFile), 1);
    assert.equal(usageCount(fixture.prePublishRollbackFile), 1);
    await assert.rejects(
      lstat(fixture.candidateFile),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a recovery-lock release failure after rename reports published uncertainty", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-post-lock-");
  let receipt;
  try {
    receipt = await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          afterPublication: ({ lockFile }) => unlink(lockFile),
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_publication_state_uncertain"
        && error?.published === true
        && error?.candidateConsumed === true
        && error?.causeCode === "local_unified_index_recovery_lock_changed"
        && error?.prePublishRollbackFile === fixture.prePublishRollbackFile,
    );
    assert.deepEqual(
      await recoveryFileIdentity(fixture.indexFile),
      receipt.candidate.identity,
    );
    await lstat(fixture.prePublishRollbackFile);
    await assert.rejects(
      lstat(fixture.candidateFile),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      lstat(defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a sidecar detected after rename is reported as published and preserved", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-post-sidecar-");
  let receipt;
  try {
    receipt = await prepareFixture(fixture);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
        dependencies: {
          afterPublication: () => writeFile(
            `${fixture.indexFile}-wal`,
            "untrusted-post-rename-sidecar",
            { flag: "wx", mode: 0o600 },
          ),
        },
      }),
      (error) => error?.code
        === "local_unified_index_recovery_publication_state_uncertain"
        && error?.published === true
        && error?.candidateConsumed === true
        && error?.causeCode
          === "local_unified_index_recovery_live_sidecar_present"
        && error?.prePublishRollbackFile === fixture.prePublishRollbackFile,
    );
    assert.deepEqual(
      await recoveryFileIdentity(fixture.indexFile),
      receipt.candidate.identity,
    );
    await lstat(`${fixture.indexFile}-wal`);
    await lstat(fixture.prePublishRollbackFile);
    await assert.rejects(
      lstat(fixture.candidateFile),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("explicit apply never auto-reclaims a valid stale-looking recovery lock", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-stale-lock-");
  const lockFile = defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile);
  const deadPid = 987_654_321;
  try {
    await prepareFixture(fixture);
    await writeFile(lockFile, recoveryLockRecord(deadPid), {
      flag: "wx",
      mode: 0o600,
    });
    const lockBytes = await readFile(lockFile);
    await assert.rejects(
      applyLocalUnifiedIndexRecovery({
        indexFile: fixture.indexFile,
        candidateFile: fixture.candidateFile,
        receiptFile: fixture.receiptFile,
        confirmIndex: fixture.indexFile,
        confirmAppStopped: true,
      }),
      (error) => error?.code === "local_unified_index_recovery_locked"
        && error?.lockOwnerPid === deadPid,
    );
    assert.deepEqual(await readFile(lockFile), lockBytes);
    await assert.rejects(
      lstat(fixture.prePublishRollbackFile),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("explicit apply retains live and malformed recovery locks", async (t) => {
  await t.test("live owner", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-live-lock-");
    const lockFile = defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile);
    try {
      await prepareFixture(fixture);
      const lockBytes = recoveryLockRecord(process.pid);
      await writeFile(lockFile, lockBytes, { flag: "wx", mode: 0o600 });
      await assert.rejects(
        applyLocalUnifiedIndexRecovery({
          indexFile: fixture.indexFile,
          candidateFile: fixture.candidateFile,
          receiptFile: fixture.receiptFile,
          confirmIndex: fixture.indexFile,
          confirmAppStopped: true,
        }),
        (error) => error?.code === "local_unified_index_recovery_locked"
          && error?.lockOwnerPid === process.pid,
      );
      assert.equal(await readFile(lockFile, "utf8"), lockBytes);
      await assert.rejects(
        lstat(fixture.prePublishRollbackFile),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });

  await t.test("malformed record", async () => {
    const fixture = await recoveryFixture("unified-index-recovery-bad-lock-");
    const lockFile = defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile);
    try {
      await prepareFixture(fixture);
      const lockBytes = "{not-json\n";
      await writeFile(lockFile, lockBytes, { flag: "wx", mode: 0o600 });
      await assert.rejects(
        applyLocalUnifiedIndexRecovery({
          indexFile: fixture.indexFile,
          candidateFile: fixture.candidateFile,
          receiptFile: fixture.receiptFile,
          confirmIndex: fixture.indexFile,
          confirmAppStopped: true,
        }),
        (error) => error?.code
          === "local_unified_index_recovery_lock_invalid",
      );
      assert.equal(await readFile(lockFile, "utf8"), lockBytes);
      await assert.rejects(
        lstat(fixture.prePublishRollbackFile),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true });
    }
  });
});

test("a second recovery contender cannot alter the first contender's lock", async () => {
  const fixture = await recoveryFixture("unified-index-recovery-contenders-");
  const lockFile = defaultLocalUnifiedIndexRecoveryLockPath(fixture.indexFile);
  let announceLocked;
  const firstLocked = new Promise((resolve) => {
    announceLocked = resolve;
  });
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  try {
    await prepareFixture(fixture);
    const firstApply = applyLocalUnifiedIndexRecovery({
      indexFile: fixture.indexFile,
      candidateFile: fixture.candidateFile,
      receiptFile: fixture.receiptFile,
      confirmIndex: fixture.indexFile,
      confirmAppStopped: true,
      dependencies: {
        onLocked: async () => {
          announceLocked();
          await holdFirst;
        },
      },
    });
    await firstLocked;
    const firstLockBytes = await readFile(lockFile);
    try {
      await assert.rejects(
        applyLocalUnifiedIndexRecovery({
          indexFile: fixture.indexFile,
          candidateFile: fixture.candidateFile,
          receiptFile: fixture.receiptFile,
          confirmIndex: fixture.indexFile,
          confirmAppStopped: true,
        }),
        (error) => error?.code === "local_unified_index_recovery_locked",
      );
      assert.deepEqual(await readFile(lockFile), firstLockBytes);
    } finally {
      releaseFirst();
    }
    const result = await firstApply;
    assert.equal(result.status, "applied");
    await assert.rejects(lstat(lockFile), (error) => error?.code === "ENOENT");
  } finally {
    releaseFirst?.();
    await rm(fixture.root, { recursive: true });
  }
});

test("recovery CLI rejects unknown, stray, and duplicate arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-recovery-cli-args-"));
  const indexFile = join(root, "index.sqlite");
  const cases = [
    {
      name: "unknown flag",
      args: ["--aply", "--index", indexFile],
      expected: /unknown argument: --aply/u,
    },
    {
      name: "stray positional",
      args: ["--dry-run", "--index", indexFile, "stray"],
      expected: /unexpected positional argument: stray/u,
    },
    {
      name: "duplicate flag",
      args: ["--dry-run", "--dry-run", "--index", indexFile],
      expected: /duplicate --dry-run/u,
    },
    {
      name: "duplicate value option",
      args: ["--dry-run", "--index", indexFile, "--index", indexFile],
      expected: /duplicate --index/u,
    },
  ];
  try {
    for (const fixture of cases) {
      await t.test(fixture.name, () => {
        const result = spawnSync(process.execPath, [RECOVERY_CLI, ...fixture.args], {
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, fixture.expected);
      });
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("recovery CLI dry-run validates topology without creating artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-recovery-cli-dry-"));
  const indexFile = join(root, "index.sqlite");
  const recoveryDir = join(root, "recovery");
  try {
    const valid = spawnSync(process.execPath, [
      RECOVERY_CLI,
      "--dry-run",
      "--index",
      indexFile,
      "--recovery-dir",
      recoveryDir,
    ], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const plan = JSON.parse(valid.stdout);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.recoveryDir, recoveryDir);
    await assert.rejects(lstat(recoveryDir), (error) => error?.code === "ENOENT");

    const duplicateArtifact = join(recoveryDir, "same.sqlite");
    const invalid = spawnSync(process.execPath, [
      RECOVERY_CLI,
      "--dry-run",
      "--index",
      indexFile,
      "--recovery-dir",
      recoveryDir,
      "--candidate",
      duplicateArtifact,
      "--backup",
      duplicateArtifact,
      "--receipt",
      join(recoveryDir, "receipt.json"),
    ], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /local_unified_index_recovery_paths_invalid/u);
    await assert.rejects(lstat(recoveryDir), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true });
  }
});
