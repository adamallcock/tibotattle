import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { openSealedSqliteD1 } from "../../cloud-run/sealed-sqlite-d1-adapter.mjs";
import * as D1 from "./current-q1-d1-reference.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import { createCurrentQ1D7DiagnosticClient, createCurrentQ1D7DiagnosticTestClient }
  from "./current-q1-d7-diagnostic.mjs";

const SOURCE_ID = "gcp-fastpath-oracle";
const CASE_KEY = "conflictFreePositive";
const HASH = (value) => createHash("sha256").update(value).digest("hex");
const PRODUCTION_WATCHDOG_MS = Contract.CURRENT_Q1_D7_BOUNDS.diagnosticDeadlineMs;

async function fileSnapshot(path) {
  const stat = await lstat(path, { bigint: true });
  const bytes = await readFile(path);
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size,
    mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, sha256: HASH(bytes) };
}

function expectedOwners() {
  return ["a", "b", "c", "d"].map((ownerKey, index) => ({ ownerKey,
    ownerDigest: HASH(`current-q1-d7-diagnostic-test-owner-${ownerKey}`),
    ownerRevision: index + 1, authorityEpoch: index + 1 }));
}

async function makeCaseScratch() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "current-q1-d7-diagnostic-check-"));
  const root = await realpath(temporaryRoot);
  await chmod(root, 0o700);
  const scratchDirectory = join(root, CASE_KEY);
  await mkdir(scratchDirectory, { mode: 0o700 });
  const nowMs = Contract.CURRENT_Q1_D7_NOW_MS;
  const ingestionPath = join(scratchDirectory, "ingestion.sqlite");
  const analyticsPath = join(scratchDirectory, "analytics.sqlite");
  const ingestion = openSealedSqliteD1(ingestionPath, { create: true, pinnedNowMs: nowMs });
  ingestion.database.exec(`CREATE TABLE collection_controls(singleton INTEGER PRIMARY KEY);
    INSERT INTO collection_controls VALUES(1);
    CREATE TABLE admin_action_audit(id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  ingestion.close();
  const analytics = openSealedSqliteD1(analyticsPath, { create: true, pinnedNowMs: nowMs });
  analytics.database.exec("CREATE TABLE diagnostic_test_target(singleton INTEGER PRIMARY KEY)");
  analytics.close();
  await chmod(ingestionPath, 0o600);
  await chmod(analyticsPath, 0o600);
  const measuredRuntime = await D1.measureCurrentQ1Runtime();
  const input = { scratchDirectory, caseKey: CASE_KEY, sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_ID, nowMs, expectedOwners: expectedOwners(),
    expectedChildSha256: HASH(await readFile(new URL("./current-q1-d7-diagnostic-child.mjs", import.meta.url))),
    expectedGuardianSha256: HASH(await readFile(new URL("./current-q1-d7-diagnostic-guardian.mjs", import.meta.url))),
    runtime: { path: await realpath(process.execPath), version: measuredRuntime.version,
      binarySha256: measuredRuntime.binarySha256 },
    sourceFence: { head: "a".repeat(40), sha256: HASH("synthetic diagnostic source fence") },
    deadlineMonotonicMs: performance.now() + 60_000 };
  return { root, scratchDirectory, input };
}

async function withScratch(run) {
  const fixture = await makeCaseScratch();
  try { await run(fixture); }
  finally { await rm(fixture.root, { recursive: true, force: true }); }
}

test("persistent diagnostic child leaves synthetic readonly databases byte-identical and releases all resources", async () => {
  await withScratch(async ({ scratchDirectory, input }) => {
    const ingestionPath = join(scratchDirectory, "ingestion.sqlite");
    const analyticsPath = join(scratchDirectory, "analytics.sqlite");
    const before = { ingestion: await fileSnapshot(ingestionPath), analytics: await fileSnapshot(analyticsPath) };
    const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario: "success", watchdogMs: 5000 });
    let cleanup;
    try {
      const invariant = await client.captureIngestionInvariant();
      assert.deepEqual(Object.keys(invariant).sort(), ["fullSourceCaptureSha256", "schemaSha256", "sha256"]);
      assert.ok(Object.values(invariant).every((value) => /^[a-f0-9]{64}$/u.test(value)));
    } finally {
      cleanup = await client.close();
      assert.deepEqual(cleanup, { closed: true, closedDatabaseHandles: 2, closedVite: true,
        cacheRemoved: true, processGroupGone: true });
    }
    const after = { ingestion: await fileSnapshot(ingestionPath), analytics: await fileSnapshot(analyticsPath) };
    assert.deepEqual(after, before, "readonly diagnostic must not alter DB bytes or filesystem identity/timestamps");
    const reopenedIngestion = openSealedSqliteD1(ingestionPath, { readOnly: true, pinnedNowMs: input.nowMs });
    const reopenedAnalytics = openSealedSqliteD1(analyticsPath, { readOnly: true, pinnedNowMs: input.nowMs });
    try {
      assert.equal((await reopenedIngestion.database.prepare("SELECT count(*) AS n FROM collection_controls").first()).n, 1);
      assert.equal((await reopenedAnalytics.database.prepare("SELECT count(*) AS n FROM diagnostic_test_target").first()).n, 0);
    } finally { reopenedIngestion.close(); reopenedAnalytics.close(); }
    const exclusive = openSealedSqliteD1(analyticsPath, { pinnedNowMs: input.nowMs });
    try {
      await exclusive.database.exec("BEGIN EXCLUSIVE");
      await exclusive.database.exec("ROLLBACK");
    } finally { exclusive.close(); }
    assert.equal(cleanup.processGroupGone, true, "no owned guardian/reader process group remains");
  });
});

test("normal close keeps the owner connected until ignored-stdio group descendants are gone", { timeout: 10000 }, async () => {
  await withScratch(async ({ input }) => {
    const client = await createCurrentQ1D7DiagnosticTestClient(input,
      { scenario: "closed-reader-ignored-descendant", watchdogMs: 5000 });
    let closeSettled = false;
    const closing = client.close().then((result) => { closeSettled = true; return result; });
    try {
      assert.equal(await client.waitUntilTestDescendantSpawned(), true,
        "the reader must launch a same-group descendant with all stdio ignored");
      assert.equal(closeSettled, false,
        "the owner must remain connected while the guardian removes the descendant");
      assert.deepEqual(await closing, { closed: true, closedDatabaseHandles: 2,
        closedVite: true, cacheRemoved: true, processGroupGone: true });
    } finally {
      if (!closeSettled) await closing.catch(() => {});
    }
  });
});

test("parent watchdog kills, reaps, and verifies a blocked detached child process group", async () => {
  await withScratch(async ({ input }) => {
    const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario: "blocked", watchdogMs: 250 });
    const blockedRead = client.captureIngestionInvariant();
    assert.equal(await client.waitUntilTestBlocked(), true);
    await assert.rejects(blockedRead, (error) => {
      assert.equal(error.code, "CURRENT_Q1_D7_DIAGNOSTIC_TIMEOUT");
      assert.equal(error.message, error.code);
      return true;
    });
    assert.deepEqual(await client.close(), { closed: true, processGroupGone: true });
    assert.ok(Number.isFinite(client.testImmediateTerminationStartedAt));
    assert.ok(Number.isFinite(client.testImmediateTermSentAt));
    assert.ok(Number.isFinite(client.testImmediateKillSentAt));
    assert.ok(client.testImmediateTermSentAt >= client.testImmediateTerminationStartedAt);
    assert.ok(client.testImmediateKillSentAt - client.testImmediateTermSentAt >= 250);
    assert.ok(client.testImmediateKillSentAt - client.testImmediateTermSentAt <= 1500);
  });
});

test("production watchdog is fixed at 30 seconds and immediately terminates an unresponsive process family", { timeout: 40000 }, async () => {
  assert.equal(PRODUCTION_WATCHDOG_MS, 30_000);
  await withScratch(async ({ input }) => {
    const client = await createCurrentQ1D7DiagnosticTestClient(input,
      { scenario: "blocked-stalled-guardian", watchdogMs: PRODUCTION_WATCHDOG_MS });
    const startedAt = performance.now();
    const blockedRead = client.captureIngestionInvariant();
    assert.equal(await client.waitUntilTestBlocked(), true);
    await assert.rejects(blockedRead, (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_TIMEOUT");
    assert.ok(client.testImmediateTerminationStartedAt - startedAt >= PRODUCTION_WATCHDOG_MS - 100);
    assert.ok(client.testImmediateTerminationStartedAt - startedAt <= PRODUCTION_WATCHDOG_MS + 250);
    assert.ok(Number.isFinite(client.testImmediateTermSentAt));
    assert.ok(Number.isFinite(client.testImmediateKillSentAt));
    assert.ok(client.testImmediateTermSentAt - client.testImmediateTerminationStartedAt <= 25);
    assert.ok(client.testImmediateKillSentAt - client.testImmediateTermSentAt >= 250);
    assert.ok(client.testImmediateKillSentAt - client.testImmediateTermSentAt <= 1000);
    assert.deepEqual(await client.close(), { closed: true, processGroupGone: true });
  });
});

test("guardian reaps a synchronously blocked reader after its owner is hard-killed", { timeout: 15000 }, async () => {
  await withScratch(async ({ input }) => {
    const helperUrl = new URL("./current-q1-d7-diagnostic.mjs", import.meta.url).href;
    const ownerSource = `import { performance } from "node:perf_hooks";
      try {
      const { createCurrentQ1D7DiagnosticTestClient } = await import(${JSON.stringify(helperUrl)});
      const input = JSON.parse(process.env.CURRENT_Q1_D7_TEST_INPUT);
      input.deadlineMonotonicMs = performance.now() + 20000;
      const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario: "blocked", watchdogMs: 5000 });
      process.stdout.write(JSON.stringify({ stage: "client-ready", processGroupId: client.testProcessGroupId }) + "\\n");
      const operation = client.captureIngestionInvariant();
      if (!await client.waitUntilTestBlocked()) process.exit(31);
      process.stdout.write(JSON.stringify({ stage: "reader-blocked" }) + "\\n");
      void operation;
      await new Promise(() => {});
      } catch (error) { process.stdout.write("OWNER_FAILED " + (error?.code || error?.name || "unknown")
        + " ctx=" + (process.env.NODE_TEST_CONTEXT || "none") + "\\n"); process.exit(32); }`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerSource], {
      cwd: process.cwd(), detached: false, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: typeof process.env.PATH === "string" ? process.env.PATH : "",
        TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1", CI: "true", TZ: "UTC",
        NODE_TEST_CONTEXT: "child-v8", CURRENT_Q1_D7_TEST_INPUT: JSON.stringify(input) },
    });
    const lines = createInterface({ input: owner.stdout });
    const outputLines = [];
    const lineWaiters = [];
    lines.on("line", (line) => {
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else outputLines.push(line);
    });
    let processGroupId = null;
    const nextLine = async (maximumMs) => {
      if (outputLines.length > 0) return outputLines.shift();
      return new Promise((resolveLine) => {
        const timer = setTimeout(() => {
          const index = lineWaiters.indexOf(onLine);
          if (index >= 0) lineWaiters.splice(index, 1);
          resolveLine("OWNER_MARKER_TIMEOUT");
        }, maximumMs);
        const onLine = (line) => { clearTimeout(timer); resolveLine(line); };
        lineWaiters.push(onLine);
      });
    };
    const groupExistsNow = (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 1) return false;
      try { process.kill(-pid, 0); return true; }
      catch (error) { return error?.code !== "ESRCH"; }
    };
    const waitForGroupGone = async (pid, maximumMs) => {
      const deadline = performance.now() + maximumMs;
      while (performance.now() < deadline) {
        if (!groupExistsNow(pid)) return true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      return !groupExistsNow(pid);
    };
    const waitForOwnerClose = async (maximumMs) => {
      if (owner.exitCode !== null || owner.signalCode !== null) return { code: owner.exitCode, signal: owner.signalCode };
      return new Promise((resolveClose) => {
        const timer = setTimeout(() => { owner.removeListener("close", onClose); resolveClose(null); }, maximumMs);
        const onClose = (code, signal) => { clearTimeout(timer); resolveClose({ code, signal }); };
        owner.once("close", onClose);
      });
    };
    try {
      const readyLine = await nextLine(7000);
      assert.notEqual(readyLine, "OWNER_MARKER_TIMEOUT", `owner output before ready: ${outputLines.join("|")}`);
      assert.equal(readyLine.startsWith("OWNER_FAILED"), false, `owner helper failed: ${readyLine}`);
      const ready = JSON.parse(readyLine);
      assert.equal(ready.stage, "client-ready");
      processGroupId = ready.processGroupId;
      assert.ok(Number.isSafeInteger(processGroupId) && processGroupId > 1);
      const blockedLine = await nextLine(7000);
      assert.notEqual(blockedLine, "OWNER_MARKER_TIMEOUT", `owner output before blocked: ${outputLines.join("|")}`);
      assert.equal(blockedLine.startsWith("OWNER_FAILED"), false, `owner helper failed: ${blockedLine}`);
      assert.deepEqual(JSON.parse(blockedLine), { stage: "reader-blocked" });
      assert.equal(owner.kill("SIGKILL"), true);
      assert.deepEqual(await waitForOwnerClose(2000), { code: null, signal: "SIGKILL" });
      assert.equal(await waitForGroupGone(processGroupId, 5000), true,
        "guardian and blocked reader process group must disappear after owner EOF");
    } finally {
      lines.close();
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await waitForOwnerClose(2000);
      if (processGroupId !== null) assert.equal(await waitForGroupGone(processGroupId, 5000), true,
        "guardian EOF cleanup must remove its blocked reader process group without stale-PID signaling");
    }
  });
});

test("early child exit fails closed without forwarding child output", async () => {
  await withScratch(async ({ input }) => {
    const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario: "early-exit", watchdogMs: 5000 });
    await assert.rejects(client.captureIngestionInvariant(), (error) => {
      assert.equal(error.code, "CURRENT_Q1_D7_DIAGNOSTIC_CHILD_EXITED");
      assert.equal(error.message, error.code);
      return true;
    });
    assert.deepEqual(await client.close(), { closed: true, processGroupGone: true });
  });
});

test("guardian never signals an exited reader while inherited stdout delays close", { timeout: 10000 }, async () => {
  await withScratch(async ({ input }) => {
    const client = await createCurrentQ1D7DiagnosticTestClient(input,
      { scenario: "exited-reader-inherited-pipe", watchdogMs: 5000 });
    const invariant = await client.captureIngestionInvariant();
    assert.deepEqual(Object.keys(invariant).sort(), ["fullSourceCaptureSha256", "schemaSha256", "sha256"]);
    assert.equal(await client.waitUntilReaderExited(), true,
      "guardian must observe the reader exit before its inherited pipe closes");
    assert.equal(await client.waitUntilReaderSignalSkipped(), true,
      "guardian must refuse the exited reader PID instead of signaling it");
    assert.equal(await client.waitUntilReaderReaped(), true,
      "reader close/reap must be confirmed after the inherited pipe holder exits");
    assert.equal(await client.waitUntilGuardianExited(), true);
    assert.deepEqual(await client.close(), { closed: true, processGroupGone: true },
      "guardian and same-group inherited-pipe holder must be gone");
  });
});

test("malformed and oversized child protocol output are rejected and cleaned up", async (t) => {
  for (const scenario of ["malformed", "oversized"]) {
    await t.test(scenario, async () => withScratch(async ({ input }) => {
      const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario, watchdogMs: 5000 });
      await assert.rejects(client.captureIngestionInvariant(), (error) => {
        assert.equal(error.code, "CURRENT_Q1_D7_DIAGNOSTIC_PROTOCOL_INVALID");
        assert.equal(error.message, error.code);
        return true;
      });
      assert.deepEqual(await client.close(), { closed: true, processGroupGone: true });
    }));
  }
});

test("production client and method requests reject open or malformed inputs", async () => {
  await withScratch(async ({ input }) => {
    await assert.rejects(createCurrentQ1D7DiagnosticClient({ ...input,
      unexpectedPath: "/tmp/runner.mjs" }), (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
    await assert.rejects(createCurrentQ1D7DiagnosticClient({ ...input,
      expectedChildSha256: "0".repeat(64) }), (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
    await assert.rejects(createCurrentQ1D7DiagnosticClient({ ...input,
      runtime: { ...input.runtime, path: "/tmp/unpinned-node" } }),
    (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
    await assert.rejects(createCurrentQ1D7DiagnosticClient({ ...input,
      sourceFence: { ...input.sourceFence, sha256: "not-a-source-hash" } }),
    (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
    const client = await createCurrentQ1D7DiagnosticTestClient(input, { scenario: "success", watchdogMs: 5000 });
    try {
      assert.throws(() => client.readResult({ scopeSha256: "bad", sql: "SELECT 1" }),
        (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
      assert.throws(() => client.captureScope({ ownerKey: "a", metric: "model", day: "2026-10-01",
        callerScriptPath: "/tmp/runner.mjs" }),
      (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID");
    } finally { await client.close(); }
  });
});

test("input database admission requires owned, regular, single-link fixed files", async () => {
  await withScratch(async ({ root, scratchDirectory, input }) => {
    const ownerPath = join(scratchDirectory, "analytics.sqlite");
    const hardLinkPath = join(root, "analytics-hardlink.sqlite");
    const { link } = await import("node:fs/promises");
    await link(ownerPath, hardLinkPath);
    await assert.rejects(createCurrentQ1D7DiagnosticClient(input),
      (error) => error.code === "CURRENT_Q1_D7_DIAGNOSTIC_INIT_FAILED");
    const stat = await lstat(ownerPath);
    assert.equal(stat.nlink, 2);
  });
});
