import assert from "node:assert/strict";
import fsPromises, {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";

import {
  commitLocalCollectorState,
  readLocalCollectorState,
} from "../src/local-collector-state.js";
import {
  verifyLocalCollectorStateIntegrityOffMain,
} from "../src/local-collector-state-integrity-off-main.js";
import { runCollectorOnce } from "../src/passive-collector.js";

const CLOCK_BASE = Date.parse("2026-09-13T00:00:00.000Z");
const LARGE_DEVICE = 72057594039371911n;
const LARGE_INODE = 72057594039371911n;

function checkpoint() {
  return {
    schemaVersion: "0.3",
    collectionStartedAt: "2026-09-01T00:00:00.000Z",
    recentEventKeys: [],
    diagnostics: {},
  };
}

function record() {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    eventKey: "large-identity-fixture-record",
    observedAt: "2026-09-08T00:00:00.000Z",
    accountScope: { status: "unavailable" },
  };
}

function appPayload(percent = 2) {
  return {
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: percent,
        windowDurationMins: 10080,
        resetsAt: 1784854800,
      },
      secondary: null,
    },
    rateLimitsByLimitId: {},
  };
}

class MinimalClient {
  async start() {}
  async readRateLimits() { return appPayload(2); }
  async readAccount() { return null; }
  async readAccountUsage() { return { dailyUsageBuckets: [] }; }
  close() {}
}

async function fixture({ collector = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "collector-large-identity-"));
  const stateFile = join(root, "state", "local-collector-state-v1.sqlite");
  await mkdir(join(root, "codex-home"), { recursive: true });
  if (!collector) {
    await commitLocalCollectorState({
      stateFile,
      checkpoint: checkpoint(),
      records: [record()],
      clock: () => CLOCK_BASE,
    });
  }
  return {
    root,
    stateFile,
    codexHome: join(root, "codex-home"),
  };
}

function workerClassWithIdentity(
  stateFile,
  {
    dev = LARGE_DEVICE,
    ino = LARGE_INODE,
    onlyFirstIdentity = false,
    afterStat = "",
  } = {},
) {
  return class SyntheticIdentityWorker extends Worker {
    constructor(url, options = {}) {
      const script = `
        import fs from "node:fs/promises";
        const target = ${JSON.stringify(stateFile)};
        const device = ${dev}n;
        const inode = ${ino}n;
        let statCount = 0;
        const originalLstat = fs.lstat;
        fs.lstat = async (path, options) => {
          const metadata = await originalLstat(path, options);
          if (path === target && options?.bigint === true) {
            statCount += 1;
            if (${onlyFirstIdentity ? "statCount === 1" : "true"}) {
              metadata.dev = device;
              metadata.ino = inode;
            }
            ${afterStat}
          }
          return metadata;
        };
        await import(${JSON.stringify(url.href)});
      `;
      super(script, { ...options, eval: true });
    }
  };
}

async function verifyWithSyntheticIdentity(stateFile, options = {}) {
  const WorkerClass = workerClassWithIdentity(stateFile, options);
  return verifyLocalCollectorStateIntegrityOffMain({
    stateFile,
    expectedIdentity: {
      dev: options.dev ?? LARGE_DEVICE,
      ino: options.ino ?? LARGE_INODE,
    },
  }, { WorkerClass });
}

function lockRow(stateFile) {
  const database = new DatabaseSync(stateFile, { readOnly: true });
  try {
    return database.prepare(`
      SELECT name, pid, acquired_at
        FROM instance_locks
       WHERE name = 'collector'
    `).get() ?? null;
  } finally {
    database.close();
  }
}

test("run-once succeeds repeatedly with an exact large identity and releases its lock", async () => {
  const value = await fixture({ collector: true });
  const originalLstat = fsPromises.lstat;
  const verifierIdentities = [];
  const WorkerClass = workerClassWithIdentity(value.stateFile);
  let now = CLOCK_BASE;
  try {
    fsPromises.lstat = async (path, options) => {
      const metadata = await originalLstat(path, options);
      if (path === value.stateFile && options?.bigint === true) {
        metadata.dev = LARGE_DEVICE;
        metadata.ino = LARGE_INODE;
      }
      return metadata;
    };
    const resultOptions = {
      codexHome: value.codexHome,
      stateFile: value.stateFile,
      skipRolloutIngestion: true,
      staleAfterMs: -1,
      clock: () => now,
      appServerFactory: () => new MinimalClient(),
      integrityVerifier: async (options) => {
        verifierIdentities.push(options.expectedIdentity);
        await verifyLocalCollectorStateIntegrityOffMain(options, { WorkerClass });
      },
    };
    const first = await runCollectorOnce(resultOptions);
    const realIdentityAfterFirst = await lstat(value.stateFile, { bigint: true });
    now += 1_000;
    const second = await runCollectorOnce(resultOptions);
    const realIdentityAfterSecond = await lstat(value.stateFile, { bigint: true });

    assert.equal(first.status, "complete");
    assert.equal(first.refresh.recordWritten, true);
    assert.equal(second.status, "complete");
    assert.equal(second.refresh.recordWritten, true);
    assert.deepEqual(verifierIdentities, [
      { dev: LARGE_DEVICE, ino: LARGE_INODE },
      { dev: LARGE_DEVICE, ino: LARGE_INODE },
    ]);
    assert.notEqual(realIdentityAfterFirst.ino, LARGE_INODE);
    assert.equal(realIdentityAfterSecond.dev, realIdentityAfterFirst.dev);
    assert.equal(realIdentityAfterSecond.ino, realIdentityAfterFirst.ino);
    const state = await readLocalCollectorState({
      stateFile: value.stateFile,
      includeRecords: true,
    });
    assert.equal(
      state.records.filter((entry) => entry.kind === "codex_quota_snapshot").length,
      2,
    );
    assert.equal(lockRow(value.stateFile), null);
  } finally {
    fsPromises.lstat = originalLstat;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a session identity failure releases the lock before a same-PID retry", async () => {
  const value = await fixture({ collector: true });
  const originalLstat = fsPromises.lstat;
  const WorkerClass = workerClassWithIdentity(value.stateFile);
  let invalidIdentity = true;
  try {
    fsPromises.lstat = async (path, options) => {
      const metadata = await originalLstat(path, options);
      if (path === value.stateFile && options?.bigint === true) {
        if (invalidIdentity) {
          metadata.dev = LARGE_DEVICE;
          metadata.ino = -1n;
          invalidIdentity = false;
        } else {
          metadata.dev = LARGE_DEVICE;
          metadata.ino = LARGE_INODE;
        }
      }
      return metadata;
    };
    const options = {
      codexHome: value.codexHome,
      stateFile: value.stateFile,
      skipRolloutIngestion: true,
      staleAfterMs: -1,
      clock: () => CLOCK_BASE,
      appServerFactory: () => new MinimalClient(),
      integrityVerifier: (verificationOptions) =>
        verifyLocalCollectorStateIntegrityOffMain(verificationOptions, { WorkerClass }),
    };

    await assert.rejects(
      () => runCollectorOnce(options),
      { code: "local_collector_state_unavailable" },
    );
    assert.equal(lockRow(value.stateFile), null);

    const retried = await runCollectorOnce(options);
    assert.equal(retried.status, "complete");
    assert.equal(retried.refresh.recordWritten, true);
    assert.equal(lockRow(value.stateFile), null);
  } finally {
    fsPromises.lstat = originalLstat;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity rejects a symlink even when its supplied identity is large", async (t) => {
  const value = await fixture();
  const realStateFile = `${value.stateFile}.real`;
  try {
    await rename(value.stateFile, realStateFile);
    try {
      await symlink(realStateFile, value.stateFile);
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyWithSyntheticIdentity(value.stateFile),
      { code: "local_collector_state_unavailable" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity rejects a hardlinked state file before identity comparison", async (t) => {
  const value = await fixture();
  try {
    try {
      await link(value.stateFile, `${value.stateFile}.hardlink`);
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
        t.skip(`hardlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyWithSyntheticIdentity(value.stateFile),
      { code: "local_collector_state_unavailable" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity rejects a path replacement between exact identity checks", async () => {
  const value = await fixture();
  const replacement = `${value.stateFile}.replacement`;
  const backup = `${value.stateFile}.original`;
  try {
    await copyFile(value.stateFile, replacement);
    await assert.rejects(
      verifyWithSyntheticIdentity(value.stateFile, {
        onlyFirstIdentity: true,
        afterStat: `
          if (statCount === 1) {
            await fs.rename(target, ${JSON.stringify(backup)});
            await fs.rename(${JSON.stringify(replacement)}, target);
          }
        `,
      }),
      { code: "local_collector_state_unavailable" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity rejects group or world readable state permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not enforced on Windows");
    return;
  }
  const value = await fixture();
  try {
    await chmod(value.stateFile, 0o644);
    await assert.rejects(
      verifyWithSyntheticIdentity(value.stateFile),
      { code: "local_collector_state_unavailable" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity rejects state ownership changes", async (t) => {
  if (typeof process.getuid !== "function") {
    t.skip("owner UID checks are unavailable on Windows");
    return;
  }
  const value = await fixture();
  try {
    await assert.rejects(
      verifyWithSyntheticIdentity(value.stateFile, {
        afterStat: "metadata.uid = BigInt(process.getuid() + 1);",
      }),
      { code: "local_collector_state_unavailable" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
