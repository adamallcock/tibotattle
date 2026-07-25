import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createR7FilesystemRootBinding,
  measureR7FilesystemRoot,
  R7_FILESYSTEM_HIGH_WATER_VERSION,
  R7_FILESYSTEM_SAMPLE_INTERVAL_MS,
  R7FilesystemHighWaterError,
  runR7FilesystemHighWaterSampler,
} from "../src/r7-filesystem-high-water.js";

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-fs-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "task-root");
  await mkdir(root, { mode: 0o700 });
  return { parent, root };
}

function manualScheduler() {
  const intervals = [];
  return {
    intervals,
    scheduleInterval(fn, milliseconds) {
      const handle = { fn, milliseconds, cancelled: false };
      intervals.push(handle);
      return handle;
    },
    cancelInterval(handle) { handle.cancelled = true; },
    fire(handle) { return handle.cancelled ? undefined : handle.fn(); },
  };
}

async function flushSampling() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("sampler returns explicit aggregate-only before, high-water, and after measurements", async (t) => {
  const { root } = await fixture(t);
  const scheduler = manualScheduler();
  await writeFile(join(root, "before"), Buffer.alloc(3));
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  let started;
  const operationStarted = new Promise((resolve) => { started = resolve; });
  let now = 1_000_000_000n;
  const promise = runR7FilesystemHighWaterSampler({
    root,
    maximumElapsedMs: 1_000,
    async operation() { started(); await hold; },
  }, {
    monotonicNow: () => now,
    scheduleInterval: scheduler.scheduleInterval,
    cancelInterval: scheduler.cancelInterval,
  });
  await operationStarted;
  assert.equal(scheduler.intervals.length, 1);
  assert.equal(scheduler.intervals[0].milliseconds, R7_FILESYSTEM_SAMPLE_INTERVAL_MS);

  await writeFile(join(root, "peak"), Buffer.alloc(9));
  now += 100_000_000n;
  await scheduler.fire(scheduler.intervals[0]);
  await rm(join(root, "peak"));
  now += 25_000_000n;
  finish();
  const result = await promise;

  assert.deepEqual(result, {
    filesystemHighWaterVersion: R7_FILESYSTEM_HIGH_WATER_VERSION,
    outcome: "completed",
    samplingIntervalMs: R7_FILESYSTEM_SAMPLE_INTERVAL_MS,
    elapsedMs: 125,
    sampleCount: 3,
    periodicSampleCount: 1,
    measurements: {
      before: { bytes: 3, entryCount: 1, fileCount: 1, directoryCount: 0 },
      highWater: { bytes: 12, entryCount: 2, fileCount: 2, directoryCount: 0 },
      after: { bytes: 3, entryCount: 1, fileCount: 1, directoryCount: 0 },
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("before"), true); // fixed measurement label only
  assert.equal(serialized.includes("peak"), false);
});

test("fixed interval checks a bigint monotonic deadline without retaining a sample series", async (t) => {
  const { root } = await fixture(t);
  const scheduler = manualScheduler();
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  let started;
  const operationStarted = new Promise((resolve) => { started = resolve; });
  let now = 0n;
  const promise = runR7FilesystemHighWaterSampler({
    root,
    maximumElapsedMs: 100,
    async operation() { started(); await hold; },
  }, {
    monotonicNow: () => now,
    scheduleInterval: scheduler.scheduleInterval,
    cancelInterval: scheduler.cancelInterval,
  });
  await operationStarted;
  now = 100_000_000n;
  await scheduler.fire(scheduler.intervals[0]);
  finish();
  const result = await promise;
  assert.equal(result.outcome, "deadline_exceeded");
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.periodicSampleCount, 0);
  assert.equal("samples" in result, false);
  assert.deepEqual(result.measurements.before, result.measurements.highWater);
  assert.deepEqual(result.measurements.after, result.measurements.highWater);
});

test("periodic sampling coalesces ticks while one recursive measurement is in flight", async (t) => {
  const { root } = await fixture(t);
  const scheduler = manualScheduler();
  let finishOperation;
  const operationHold = new Promise((resolve) => { finishOperation = resolve; });
  let releasePeriodic;
  const periodicHold = new Promise((resolve) => { releasePeriodic = resolve; });
  let signalPeriodicStarted;
  const periodicStarted = new Promise((resolve) => { signalPeriodicStarted = resolve; });
  let directoryReads = 0;
  let operationStarted;
  const started = new Promise((resolve) => { operationStarted = resolve; });
  const promise = runR7FilesystemHighWaterSampler({
    root,
    async operation() { operationStarted(); await operationHold; },
  }, {
    monotonicNow: () => 0n,
    scheduleInterval: scheduler.scheduleInterval,
    cancelInterval: scheduler.cancelInterval,
    async readDirectoryEntries() {
      directoryReads += 1;
      if (directoryReads === 2) {
        signalPeriodicStarted();
        await periodicHold;
      }
      return [];
    },
  });
  await started;
  const firstTick = scheduler.fire(scheduler.intervals[0]);
  await periodicStarted;
  const secondTick = scheduler.fire(scheduler.intervals[0]);
  assert.equal(firstTick, secondTick);
  assert.equal(directoryReads, 2);
  releasePeriodic();
  await firstTick;
  finishOperation();
  const result = await promise;
  assert.equal(result.outcome, "completed");
  assert.equal(result.periodicSampleCount, 1);
  assert.equal(result.sampleCount, 3);
  assert.equal(directoryReads, 3);
});

test("root binding follows realpath once and rejects later root replacement", async (t) => {
  const { parent, root } = await fixture(t);
  const scheduler = manualScheduler();
  const moved = join(parent, "original-root");
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  let started;
  const operationStarted = new Promise((resolve) => { started = resolve; });
  const promise = runR7FilesystemHighWaterSampler({
    root,
    async operation() { started(); await hold; },
  }, {
    monotonicNow: () => 0n,
    scheduleInterval: scheduler.scheduleInterval,
    cancelInterval: scheduler.cancelInterval,
  });
  await operationStarted;
  await rename(root, moved);
  await mkdir(root);
  await scheduler.fire(scheduler.intervals[0]);
  finish();
  const result = await promise;
  assert.equal(result.outcome, "root_replaced");
  assert.equal(result.measurements.after, null);
  assert.deepEqual(result.measurements.before, {
    bytes: 0,
    entryCount: 0,
    fileCount: 0,
    directoryCount: 0,
  });
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("tree measurement rejects symlinks and hardlinks with fixed content-free errors", async (t) => {
  await t.test("symlink", async (t) => {
    const { root } = await fixture(t);
    const privateTarget = join(root, "private-target");
    await writeFile(privateTarget, "secret");
    await symlink(privateTarget, join(root, "private-link"));
    const binding = await createR7FilesystemRootBinding(root);
    await assert.rejects(
      measureR7FilesystemRoot(binding),
      (error) => {
        assert.ok(error instanceof R7FilesystemHighWaterError);
        assert.equal(error.code, "r7_filesystem_symlink_rejected");
        assert.equal(error.message.includes(root), false);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  });

  await t.test("hardlink", async (t) => {
    const { root } = await fixture(t);
    const privateFile = join(root, "private-file");
    await writeFile(privateFile, "secret");
    await link(privateFile, join(root, "private-hardlink"));
    const binding = await createR7FilesystemRootBinding(root);
    await assert.rejects(
      measureR7FilesystemRoot(binding),
      (error) => {
        assert.ok(error instanceof R7FilesystemHighWaterError);
        assert.equal(error.code, "r7_filesystem_hardlink_rejected");
        assert.equal(error.message.includes(root), false);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  });
});

test("only the fixed export coordination symlink can be explicitly excluded without traversal", async (t) => {
  const { root } = await fixture(t);
  await symlink("pid=1;token=00000000-0000-4000-8000-000000000000", join(
    root,
    ".app-usagemonitor-export.lock",
  ));
  const binding = await createR7FilesystemRootBinding(root);
  assert.deepEqual(await measureR7FilesystemRoot(binding, {
    allowedTransientSymlinkNames: [".app-usagemonitor-export.lock"],
  }), { bytes: 0, entryCount: 1, fileCount: 0, directoryCount: 0 });
  await assert.rejects(
    measureR7FilesystemRoot(binding, { allowedTransientSymlinkNames: ["private-link"] }),
    /transient symlink exclusion is unsupported/,
  );
});

test("owned two-link transaction files are counted only under the explicit transient option", async (t) => {
  const { root } = await fixture(t);
  const first = join(root, "first");
  await writeFile(first, "abc");
  await link(first, join(root, "second"));
  const binding = await createR7FilesystemRootBinding(root);
  assert.deepEqual(await measureR7FilesystemRoot(binding, {
    allowTransientOwnedHardlinks: true,
  }), { bytes: 6, entryCount: 2, fileCount: 2, directoryCount: 0 });
  await assert.rejects(
    measureR7FilesystemRoot(binding, { allowTransientOwnedHardlinks: "yes" }),
    /hardlink option must be boolean/,
  );
});

test("enabled transient hardlinks still reject fixed zero, many, and unowned classes", async (t) => {
  const { root } = await fixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const third = join(root, "third");
  await writeFile(first, "x");
  await link(first, second);
  await link(first, third);
  const binding = await createR7FilesystemRootBinding(root);
  await assert.rejects(
    measureR7FilesystemRoot(binding, { allowTransientOwnedHardlinks: true }),
    (error) => error.code === "r7_filesystem_hardlink_many_rejected",
  );

  await rm(third);
  const realLstat = (await import("node:fs/promises")).lstat;
  for (const [nlink, uidDelta, code] of [
    [0, 0, "r7_filesystem_hardlink_zero_rejected"],
    [2, 1, "r7_filesystem_hardlink_unowned_rejected"],
  ]) {
    await assert.rejects(
      measureR7FilesystemRoot(binding, { allowTransientOwnedHardlinks: true }, {
        async lstatPath(path) {
          const stat = await realLstat(path);
          if (path.endsWith("/first")) {
            return new Proxy(stat, {
              get(target, property) {
                if (property === "nlink") return nlink;
                if (property === "uid") return target.uid + uidDelta;
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }
          return stat;
        },
      }),
      (error) => error.code === code,
    );
  }
});

test("a confirmed terminal-unlink inode remains conservatively counted", async (t) => {
  const { root } = await fixture(t);
  const disappearing = join(root, "disappearing");
  await writeFile(disappearing, "x");
  const binding = await createR7FilesystemRootBinding(root);
  const realLstat = (await import("node:fs/promises")).lstat;
  let returnedTerminalStat = false;
  const value = await measureR7FilesystemRoot(binding, {
    allowTransientOwnedHardlinks: true,
  }, {
    async lstatPath(path) {
      const stat = await realLstat(path);
      if (path.endsWith("/disappearing") && !returnedTerminalStat) {
        returnedTerminalStat = true;
        await rm(disappearing);
        return new Proxy(stat, {
          get(target, property) {
            if (property === "nlink") return 0;
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
          },
        });
      }
      return stat;
    },
  });
  assert.deepEqual(value, { bytes: 1, entryCount: 1, fileCount: 1, directoryCount: 0 });
});

test("tree measurement rejects unsupported filesystem entry types", async (t) => {
  const { root } = await fixture(t);
  const socketPath = join(root, "private-socket");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const binding = await createR7FilesystemRootBinding(root);
  await assert.rejects(
    measureR7FilesystemRoot(binding),
    (error) => {
      assert.equal(error.code, "r7_filesystem_unsupported_entry_rejected");
      assert.equal(error.message.includes(root), false);
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
});

test("global directory enumeration uses the existing bounded helper ceiling", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "file"), "x");
  const binding = await createR7FilesystemRootBinding(root);
  await assert.rejects(
    measureR7FilesystemRoot(binding, { maximumDirectoryEntries: 1 }),
    (error) => {
      assert.equal(error.code, "r7_filesystem_directory_limit_exceeded");
      assert.equal(error.message.includes(root), false);
      return true;
    },
  );
});

test("a child removed during a mutable-tree sample is skipped while the bound root remains exact", async (t) => {
  const { root } = await fixture(t);
  const disappearing = join(root, "disappearing");
  await writeFile(disappearing, "x");
  const binding = await createR7FilesystemRootBinding(root);
  let removed = false;
  const value = await measureR7FilesystemRoot(binding, {}, {
    async readDirectoryEntries(path, options) {
      const names = await (await import("../src/export-resource-policy.js"))
        .readBoundedDirectoryEntries(path, options);
      if (!removed) {
        removed = true;
        await rm(disappearing);
      }
      return names;
    },
  });
  assert.deepEqual(value, { bytes: 0, entryCount: 0, fileCount: 0, directoryCount: 0 });
});

test("a queued child directory removed before enumeration is skipped while the root remains exact", async (t) => {
  const { root } = await fixture(t);
  const disappearing = join(root, "disappearing-directory");
  await mkdir(disappearing);
  await writeFile(join(disappearing, "child"), "x");
  const binding = await createR7FilesystemRootBinding(root);
  let removed = false;
  const value = await measureR7FilesystemRoot(binding, {}, {
    async readDirectoryEntries(path, options) {
      if (path.endsWith("/disappearing-directory") && !removed) {
        removed = true;
        await rm(disappearing, { recursive: true });
      }
      return (await import("../src/export-resource-policy.js"))
        .readBoundedDirectoryEntries(path, options);
    },
  });
  assert.deepEqual(value, { bytes: 0, entryCount: 1, fileCount: 0, directoryCount: 1 });
});

test("operation failures have a fixed outcome and never expose thrown content", async (t) => {
  const { root } = await fixture(t);
  const privateCanary = `PRIVATE_${root}_CANARY`;
  const result = await runR7FilesystemHighWaterSampler({
    root,
    async operation() { throw new Error(privateCanary); },
  }, { monotonicNow: () => 0n });
  assert.equal(result.outcome, "operation_failed");
  assert.notEqual(result.measurements.before, null);
  assert.notEqual(result.measurements.highWater, null);
  assert.notEqual(result.measurements.after, null);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("a symlink supplied as the task root is rejected before the operation runs", async (t) => {
  const { parent, root } = await fixture(t);
  const alias = join(parent, "private-root-alias");
  await symlink(root, alias);
  let ran = false;
  const result = await runR7FilesystemHighWaterSampler({
    root: alias,
    async operation() { ran = true; },
  }, { monotonicNow: () => 0n });
  assert.equal(result.outcome, "root_unsafe");
  assert.equal(ran, false);
  assert.deepEqual(result.measurements, { before: null, highWater: null, after: null });
  assert.equal(JSON.stringify(result).includes(alias), false);
});
