import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recoverOwnerOnlyPairTransactions, writeOwnerOnlyPairNoClobber } from "../src/storage.js";

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-pair-"));
  return {
    directory,
    bundle: join(directory, "sample.umx.json"),
    receipt: join(directory, "sample.privacy-receipt.json"),
  };
}

async function crashAt(paths, point) {
  await assert.rejects(
    writeOwnerOnlyPairNoClobber({
      firstPath: paths.bundle,
      firstContent: "bundle-content\n",
      secondPath: paths.receipt,
      secondContent: "receipt-content\n",
    }, {
      failpoint(name) {
        if (name === point) throw new Error(`simulated-${point}`);
      },
    }),
    new RegExp(`simulated-${point}`),
  );
}

const binaryBundle = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
const binaryReceipt = new Uint8Array([0xfe, 0x00, 0x42, 0x81]);

async function crashBinaryAt(paths, point) {
  await assert.rejects(
    writeOwnerOnlyPairNoClobber({
      firstPath: paths.bundle,
      firstContent: binaryBundle,
      secondPath: paths.receipt,
      secondContent: binaryReceipt,
    }, {
      failpoint(name) {
        if (name === point) throw new Error(`simulated-binary-${point}`);
      },
    }),
    new RegExp(`simulated-binary-${point}`),
  );
}

async function assertRecovered(paths) {
  assert.equal(await readFile(paths.bundle, "utf8"), "bundle-content\n");
  assert.equal(await readFile(paths.receipt, "utf8"), "receipt-content\n");
  assert.equal((await lstat(paths.bundle)).nlink, 1);
  assert.equal((await lstat(paths.receipt)).nlink, 1);
  await assert.rejects(stat(join(paths.directory, ".app-usagemonitor-export-transactions")), { code: "ENOENT" });
}

for (const point of ["after_manifest_link", "after_manifest", "after_receipt", "after_bundle", "after_manifest_cleanup"]) {
  test(`recovery completes an interrupted receipt-first pair at ${point}`, async () => {
    const paths = await workspace();
    try {
      await crashAt(paths, point);
      const result = await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
      assert.deepEqual(result, { recovered: 1, transactionsFound: 1 });
      await assertRecovered(paths);
      assert.deepEqual(
        await recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
        { recovered: 0, transactionsFound: 0 },
      );
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });
}

for (const point of ["after_transaction_prepare", "after_manifest_prepare"]) {
  test(`recovery safely removes a pre-commit transaction at ${point}`, async () => {
    const paths = await workspace();
    try {
      await crashAt(paths, point);
      const result = await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
      assert.deepEqual(result, { recovered: 1, transactionsFound: 1 });
      await assert.rejects(stat(paths.bundle), { code: "ENOENT" });
      await assert.rejects(stat(paths.receipt), { code: "ENOENT" });
      await assert.rejects(stat(join(paths.directory, ".app-usagemonitor-export-transactions")), { code: "ENOENT" });
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });
}

for (const point of [
  "after_transaction_prepare",
  "after_manifest_prepare",
  "after_manifest_link",
  "after_manifest",
  "after_receipt",
  "after_bundle",
  "after_manifest_cleanup",
]) {
  test(`binary recovery is byte-exact after interruption at ${point}`, async () => {
    const paths = await workspace();
    try {
      await crashBinaryAt(paths, point);
      assert.deepEqual(
        await recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
        { recovered: 1, transactionsFound: 1 },
      );
      if (["after_transaction_prepare", "after_manifest_prepare"].includes(point)) {
        await assert.rejects(stat(paths.bundle), { code: "ENOENT" });
        await assert.rejects(stat(paths.receipt), { code: "ENOENT" });
      } else {
        assert.deepEqual(await readFile(paths.bundle), binaryBundle);
        assert.deepEqual(await readFile(paths.receipt), Buffer.from(binaryReceipt));
        assert.equal((await lstat(paths.bundle)).nlink, 1);
        assert.equal((await lstat(paths.receipt)).nlink, 1);
      }
      await assert.rejects(stat(join(paths.directory, ".app-usagemonitor-export-transactions")), { code: "ENOENT" });
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });
}

test("recovery removes an empty pre-commit control file without publishing outputs", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_transaction_prepare");
    const root = join(paths.directory, ".app-usagemonitor-export-transactions");
    const [transaction] = await readdir(root);
    await writeFile(join(root, transaction, "manifest.prepared"), "", { mode: 0o600 });
    await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
    await assert.rejects(stat(paths.bundle), { code: "ENOENT" });
    await assert.rejects(stat(paths.receipt), { code: "ENOENT" });
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recovery repairs the impossible bundle-only state in receipt-first order", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_bundle");
    await unlink(paths.receipt);
    await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
    await assertRecovered(paths);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recovery fails closed without replacing a foreign destination artifact", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_manifest");
    await writeFile(paths.receipt, "foreign\n", { mode: 0o600 });
    await assert.rejects(
      recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
      /conflicting destination artifact/,
    );
    assert.equal(await readFile(paths.receipt, "utf8"), "foreign\n");
    assert.equal((await readdir(join(paths.directory, ".app-usagemonitor-export-transactions"))).length, 1);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recovery never follows a substituted stage symlink", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_manifest");
    const root = join(paths.directory, ".app-usagemonitor-export-transactions");
    const [transaction] = await readdir(root);
    const stage = join(root, transaction, "bundle.stage");
    const outside = join(paths.directory, "outside");
    await writeFile(outside, "bundle-content\n", { mode: 0o600 });
    await unlink(stage);
    await symlink(outside, stage);
    await assert.rejects(
      recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
      /Invalid export recovery stage/,
    );
    assert.equal(await readFile(outside, "utf8"), "bundle-content\n");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("paired writes never overwrite an existing final artifact", async () => {
  const paths = await workspace();
  try {
    await writeFile(paths.bundle, "existing\n", { mode: 0o600 });
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({
        firstPath: paths.bundle,
        firstContent: "new-bundle\n",
        secondPath: paths.receipt,
        secondContent: "new-receipt\n",
      }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(paths.bundle, "utf8"), "existing\n");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recover-exports CLI replays an interrupted pair without exposing file names", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_receipt");
    const output = execFileSync(process.execPath, [
      resolve("src/cli.js"), "recover-exports", "--directory", paths.directory,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(output, /1 recovered of 1 transaction/);
    assert.match(output, /Upload remains disabled/);
    assert.equal(output.includes(paths.directory), false);
    assert.equal(output.includes("sample.umx.json"), false);
    await assertRecovered(paths);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

for (const point of ["after_receipt", "after_bundle"]) {
  test(`recovery itself resumes after interruption at ${point}`, async () => {
    const paths = await workspace();
    try {
      await crashAt(paths, "after_manifest");
      await assert.rejects(
        recoverOwnerOnlyPairTransactions({ directory: paths.directory }, {
          failpoint(name) {
            if (name === point) throw new Error(`recovery-${point}`);
          },
        }),
        new RegExp(`recovery-${point}`),
      );
      await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
      await assertRecovered(paths);
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });
}

test("destination lock serializes concurrent writers", async () => {
  const paths = await workspace();
  let release;
  let reached;
  const reachedManifest = new Promise((resolveReached) => { reached = resolveReached; });
  const continueWrite = new Promise((resolveWrite) => { release = resolveWrite; });
  try {
    const first = writeOwnerOnlyPairNoClobber({
      firstPath: paths.bundle,
      firstContent: "bundle-content\n",
      secondPath: paths.receipt,
      secondContent: "receipt-content\n",
    }, {
      async failpoint(name) {
        if (name === "after_manifest") {
          reached();
          await continueWrite;
        }
      },
    });
    await reachedManifest;
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({
        firstPath: paths.bundle,
        firstContent: "other-bundle\n",
        secondPath: paths.receipt,
        secondContent: "other-receipt\n",
      }),
      /destination is busy/,
    );
    release();
    await first;
    await assertRecovered(paths);
  } finally {
    release?.();
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recovery reaps an owner-only lock left by a dead process", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_manifest");
    await symlink("pid=99999999;token=11111111-1111-4111-8111-111111111111", join(paths.directory, ".app-usagemonitor-export.lock"));
    await recoverOwnerOnlyPairTransactions({ directory: paths.directory });
    await assertRecovered(paths);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("two stale-lock reapers elect one owner without removing the new active lock", async () => {
  const paths = await workspace();
  try {
    await crashAt(paths, "after_manifest");
    await symlink("pid=99999999;token=22222222-2222-4222-8222-222222222222", join(paths.directory, ".app-usagemonitor-export.lock"));
    const attempts = await Promise.allSettled([
      recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
      recoverOwnerOnlyPairTransactions({ directory: paths.directory }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.match(attempts.find((result) => result.status === "rejected").reason.message, /destination is busy/);
    await assertRecovered(paths);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("claim handoff cannot strand a claim when another caller acquires the vacant lock", async () => {
  const paths = await workspace();
  let releaseFirst;
  let releaseClaimOwner;
  let signalFirstScanned;
  let signalClaimed;
  const firstScanned = new Promise((resolveSignal) => { signalFirstScanned = resolveSignal; });
  const claimAcquired = new Promise((resolveSignal) => { signalClaimed = resolveSignal; });
  const continueFirst = new Promise((resolveSignal) => { releaseFirst = resolveSignal; });
  const continueClaimOwner = new Promise((resolveSignal) => { releaseClaimOwner = resolveSignal; });
  let firstScan = true;
  try {
    await symlink("pid=99999999;token=33333333-3333-4333-8333-333333333333", join(paths.directory, ".app-usagemonitor-export.lock"));
    const first = writeOwnerOnlyPairNoClobber({
      firstPath: paths.bundle,
      firstContent: "bundle-content\n",
      secondPath: paths.receipt,
      secondContent: "receipt-content\n",
    }, {
      async lockFailpoint(name) {
        if (name === "after_claim_scan" && firstScan) {
          firstScan = false;
          signalFirstScanned();
          await continueFirst;
        }
      },
    });
    await firstScanned;
    const claimOwner = writeOwnerOnlyPairNoClobber({
      firstPath: paths.bundle,
      firstContent: "bundle-content\n",
      secondPath: paths.receipt,
      secondContent: "receipt-content\n",
    }, {
      async lockFailpoint(name) {
        if (name === "after_claim_acquired") {
          signalClaimed();
          await continueClaimOwner;
        }
      },
    });
    await claimAcquired;
    releaseFirst();
    await assert.rejects(first, /destination is busy/);
    releaseClaimOwner();
    await claimOwner;
    await assertRecovered(paths);
    assert.deepEqual(
      (await readdir(paths.directory)).filter((name) => name.includes(".lock.claim.")),
      [],
    );
  } finally {
    releaseFirst?.();
    releaseClaimOwner?.();
    await rm(paths.directory, { recursive: true, force: true });
  }
});
