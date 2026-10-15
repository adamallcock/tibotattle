// Unit checks for the GCP fast-path rehearsal's options and source-dump
// resolution. Synthetic files only; no database, no network, no refresh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertCurrentD7RehearsalOutputsNew, assertCurrentImageRuntime, assertCurrentRehearsalOutputsNew,
  awaitCurrentD7OriginReadiness, createCurrentD7DeadlinePool, currentD7RemainingMs, currentD7StatementTimeoutMs,
  currentD7RehearsalOutputDestinations, currentRehearsalOutputDestinations, parseArguments,
  rehearsalComparisonGates, resolveRehearsalDump, runRehearsal, syntheticRehearsalFloorDays,
  validateCurrentD7ControllerQualification, verifyCurrentImageRuntimePath } from "./gcp-fastpath-rehearsal.mjs";

import { assertS9ChildCompleted, boundedS9ChildOutput, captureS9ChildCompletion, createS9Progress, observeS9ChildProgress,
  ownedKeptRehearsalSchemas, s9ControllerGoldenArguments, withS9OwnedSchemaCleanup,
  readS9ChildReport, validateS9ProgressJournal, S9_DIAGNOSTIC_BYTES, S9_REHEARSAL_DEADLINE_MS,
  S9_TAP_PROGRESS_PREFIX } from "./s9-rehearsal-diagnostics.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_GOLDEN = join(WORKER_ROOT, "analytics-v2-test", "golden");

const refused = (code) => (error) => error?.code === code;

const READINESS_CHALLENGE = "current-d7-origin-readiness-challenge-v1";
const READINESS_ACK = "current-d7-origin-readiness-ack-v1";
const READINESS_NONCE = "1".repeat(64);
const READINESS_ORIGIN = "http://127.0.0.1:1";
const READINESS_CHILD_CLEANUP_CAP_MS = 2_000; // Existing 1s TERM plus 1s KILL/reap caps.
const READINESS_SCHEDULER_MARGIN_MS = 250;

function spawnReadinessChild(mode = "valid") {
  const code = [
    "const mode = process.env.READINESS_MODE;",
    "const nonce = process.env.READINESS_NONCE;",
    `const origin = ${JSON.stringify(READINESS_ORIGIN)};`,
    "let extraOutputSent = false;",
    "if (mode === 'late' || mode === 'staggered') process.on('SIGTERM', () => {});",
    "else process.on('SIGTERM', () => process.exit(0));",
    "if (mode === 'disconnect' || mode === 'extra-output') setInterval(() => {}, 1_000);",
    "if (mode.startsWith('ack-after-')) setInterval(() => {}, 1_000);",
    "process.on('message', (message) => {",
    `if (message?.type === 'readiness-test-release-ack' && (mode.startsWith('ack-after-') || mode === 'extra-output')) { process.send({ type: ${JSON.stringify(READINESS_ACK)}, nonce, origin }); return; }`,
    "if (message?.type === 'readiness-test-go') { const ready = () => { if (mode === 'staggered') process.stderr.write('readiness-test-ready-record\\n'); if (mode === 'oversized-record') { process.stdout.write(JSON.stringify({ origin, padding: 'x'.repeat(9_000) }) + '\\n'); return; } process.stdout.write(JSON.stringify({ origin }) + '\\n'); }; if (mode === 'staggered') setTimeout(ready, 300); else ready(); return; }",
    `if (message?.type !== ${JSON.stringify(READINESS_CHALLENGE)}) return;`,
    "if (mode === 'disconnect') { process.disconnect(); return; }",
    "if (mode === 'extra-output') { if (!extraOutputSent) { extraOutputSent = true; process.stdout.write(JSON.stringify({ origin }) + '\\n'); process.stdout.write('x'.repeat(20_000)); process.stdout.write('y'.repeat(20_000)); } return; }",
    "if (mode === 'absent') return;",
    "if (mode === 'staggered') process.stderr.write('readiness-test-ack-pending\\n');",
    "setTimeout(() => {",
    `const acknowledgement = { type: ${JSON.stringify(READINESS_ACK)}, nonce: mode === 'invalid' ? '0'.repeat(64) : nonce, origin };`,
    "process.send(acknowledgement, () => { if (mode === 'late' || mode === 'staggered') process.exit(0); });",
    "}, mode === 'late' ? 700 : mode === 'staggered' ? 300 : 0);",
    "});",
    "process.send({ type: 'readiness-test-ready' });",
  ].join("");
  const child = spawn(process.execPath, ["-e", code], {
    env: { READINESS_MODE: mode, READINESS_NONCE },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return { child, nonce: READINESS_NONCE };
}

function requestReadiness(child, readinessNonce, readyTimeoutMs, { sendOverride } = {}) {
  const started = new Promise((resolveReady, rejectReady) => {
    const onMessage = (message) => {
      child.removeListener("error", onError);
      if (message?.type === "readiness-test-ready") resolveReady();
      else rejectReady(new Error("synthetic readiness child did not reach its barrier"));
    };
    const onError = (error) => {
      child.removeListener("message", onMessage);
      rejectReady(error);
    };
    child.once("message", onMessage);
    child.once("error", onError);
  });
  return started.then(() => {
    const readinessPromise = awaitCurrentD7OriginReadiness(child, { readyTimeoutMs, readinessNonce });
    const sendToChild = child.send.bind(child);
    if (sendOverride) child.send = (message, callback) => sendOverride(message, callback, sendToChild);
    sendToChild({ type: "readiness-test-go" }, (error) => {
      if (error) child.kill("SIGTERM");
    });
    return readinessPromise;
  });
}

function createDisconnectingReadinessChild(nonce) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 41_337;
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.kill = () => {
    child.exitCode = 0;
    setImmediate(() => child.emit("exit", 0, null));
    return true;
  };
  child.send = (message, callback) => {
    assert.equal(message?.type, READINESS_CHALLENGE);
    child.connected = false;
    child.emit("disconnect");
    setImmediate(() => child.emit("message", { type: READINESS_ACK, nonce, origin: READINESS_ORIGIN }));
    if (callback) setImmediate(() => callback(new Error("synthetic disconnected IPC")));
    return false;
  };
  setImmediate(() => child.stdout.write(`${JSON.stringify({ origin: READINESS_ORIGIN })}\n`));
  return child;
}

function gateChallengeCallbackUntilAcknowledgement(child, { callbackError = false, neverCallback = false } = {}) {
  const state = { acknowledgementReceived: false, deliveryCallbackCompleted: false,
    callbackInvoked: false, acknowledgementBeforeCallback: false };
  let pendingCallback = null;
  let deliveryError = null;
  let releaseQueued = false;
  const maybeRelease = () => {
    if (neverCallback || releaseQueued || !state.acknowledgementReceived
      || !state.deliveryCallbackCompleted || !pendingCallback) return;
    releaseQueued = true;
    setImmediate(() => {
      state.acknowledgementBeforeCallback = state.acknowledgementReceived;
      state.callbackInvoked = true;
      pendingCallback(callbackError ? new Error("synthetic IPC callback refusal") : deliveryError);
    });
  };
  const onMessage = (message) => {
    if (message?.type !== READINESS_ACK) return;
    state.acknowledgementReceived = true;
    maybeRelease();
  };
  child.on("message", onMessage);
  return {
    state,
    sendOverride(message, callback, sendToChild) {
      if (message?.type !== READINESS_CHALLENGE) return sendToChild(message, callback);
      pendingCallback = callback;
      return sendToChild(message, (error) => {
        deliveryError = error;
        state.deliveryCallbackCompleted = true;
        maybeRelease();
      });
    },
    dispose() { child.removeListener("message", onMessage); },
  };
}

function createOversizedReadyLineChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 41_338;
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  let challengeCount = 0;
  child.kill = () => {
    child.exitCode = 0;
    setImmediate(() => child.emit("exit", 0, null));
    return true;
  };
  child.send = (message) => {
    if (message?.type === READINESS_CHALLENGE) challengeCount++;
    return true;
  };
  setImmediate(() => child.stdout.write(Buffer.from(`${JSON.stringify({ origin: READINESS_ORIGIN, padding: "x".repeat(9_000) })}\n`)));
  return { child, get challengeCount() { return challengeCount; } };
}

test("--dense holds the golden to its own per-date expectation and owner references", () => {
  const options = parseArguments(["--golden", "/g/golden-dense", "--dense", "--dump", "/d/usage-monitor-db.json"]);
  assert.equal(options.dense, true);
  assert.equal(options.perDateExpected, "/g/golden-dense/per-date-expected.json");
  assert.equal(options.ownerReference, "/g/golden-dense");
  assert.equal(options.dump, "/d/usage-monitor-db.json");
  assert.equal(options.refreshTimeoutMinutes, 30);
  for (const extra of [["--per-date-expected", "/x.json"], ["--owner-reference", "/x"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", "--dense", ...extra]), refused("REHEARSAL_ARGUMENT_INVALID"));
  }
});

test("the Q-1 rehearsal takes optional per-date and owner references", () => {
  const options = parseArguments(["--golden", "/g/golden", "--per-date-expected", "/n/per-date-expected.json",
    "--owner-reference", "/n"]);
  assert.deepEqual([options.dense, options.perDateExpected, options.ownerReference, options.dump],
    [false, "/n/per-date-expected.json", "/n", null]);
});

test("K-CORE-A: staged primary migrations and compute Workers are opt-in and bounded", () => {
  const plain = parseArguments(["--golden", "/g/golden"]);
  assert.deepEqual([plain.stagedPrimary, plain.refreshWorkers], [[], 1]);
  const options = parseArguments(["--golden", "/g/golden", "--staged-primary", "0911_analytics_v2_run_stamps.sql",
    "--refresh-workers", "4"]);
  assert.deepEqual([options.stagedPrimary, options.refreshWorkers], [["0911_analytics_v2_run_stamps.sql"], 4]);
  for (const argv of [["--staged-primary", "../0911_x.sql"], ["--staged-primary", "kernel.sql"],
    ["--staged-primary", "0911_a.sql", "--staged-primary", "0911_a.sql"], ["--refresh-workers", "0"],
    ["--refresh-workers", "17"], ["--refresh-workers", "2.5"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...argv]), refused("REHEARSAL_ARGUMENT_INVALID"), argv.join(" "));
  }
});

test("options are closed and bounded", () => {
  assert.throws(() => parseArguments([]), refused("REHEARSAL_GOLDEN_REQUIRED"));
  for (const argv of [["--golden"], ["--golden", "/g", "--dump"], ["--golden", "/g", "--dump", "--dense"],
    ["--golden", "/g", "--unknown"], ["--golden", "/g", "--refresh-timeout-minutes", "0"],
    ["--golden", "/g", "--refresh-timeout-minutes", "721"], ["--golden", "/g", "--refresh-timeout-minutes", "1.5"],
    ["--golden", "/g", "--reuse-schema", "public"],
    ["--golden", "/g", "--reuse-schema", "typed_legacy_transfer_rehearsal_target_fastpath_XYZ"]]) {
    assert.throws(() => parseArguments(argv), (error) => /^REHEARSAL_/u.test(error?.code ?? ""), argv.join(" "));
  }
  assert.equal(parseArguments(["--golden", "/g", "--refresh-timeout-minutes", "720"]).refreshTimeoutMinutes, 720);
  assert.equal(parseArguments(["--golden", "/g", "--reuse-schema",
    "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d"]).reuseSchema,
  "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d");
});

test("an external dump must match the digest the golden manifest pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-fastpath-rehearsal-check-"));
  try {
    const golden = join(directory, "golden");
    await mkdir(golden);
    const dump = join(directory, "usage-monitor-db.json");
    const bytes = '{"schema":[],"tables":[]}\n';
    await writeFile(dump, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(await resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: sha256 } } }),
      { path: dump, sha256, pinned: true });
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: "0".repeat(64) } } }),
      refused("REHEARSAL_DUMP_DIGEST_MISMATCH"));
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: {} }), refused("REHEARSAL_DUMP_UNPINNED"));
    await assert.rejects(resolveRehearsalDump({ golden, dump: null, manifest: {} }), refused("REHEARSAL_DUMP_MISSING"));
    // A committed dump is used as it is; giving another one as well is ambiguous.
    await mkdir(join(golden, "dump"));
    await writeFile(join(golden, "dump", "usage-monitor-db.json"), bytes);
    assert.deepEqual(await resolveRehearsalDump({ golden, dump: null, manifest: {} }),
      { path: join(golden, "dump", "usage-monitor-db.json"), sha256, pinned: false });
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: sha256 } } }),
      refused("REHEARSAL_DUMP_AMBIGUOUS"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("REV-SEED: the synthetic revision floor option is a fresh-schema rehearsal of a pure floor", () => {
  assert.equal(parseArguments(["--golden", "/g/golden"]).syntheticRevisionFloor, false);
  assert.equal(parseArguments(["--golden", "/g/golden", "--synthetic-revision-floor"]).syntheticRevisionFloor, true);
  assert.throws(() => parseArguments(["--golden", "/g", "--synthetic-revision-floor", "--reuse-schema",
    "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d"]), (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID");
  const days = Array.from({ length: 15 }, (_, index) => ({ day: `2026-09-${String(index + 1).padStart(2, "0")}`, revision: 1 }));
  const floor = syntheticRehearsalFloorDays([...days].reverse());
  assert.equal(floor.length, 13, "each seventh day has no floor");
  assert.deepEqual(floor.slice(0, 7), [["2026-09-01", 1], ["2026-09-02", 2], ["2026-09-03", 3], ["2026-09-04", 4],
    ["2026-09-05", 5], ["2026-09-06", 1], ["2026-09-08", 3]]);
  assert.deepEqual(syntheticRehearsalFloorDays(days), floor, "a pure function of the golden");
});


test("MODEL-BLOCKS flags are bounded pure rehearsal pass-throughs", () => {
  const options = parseArguments(["--golden", "/g", "--refresh-model-block-size", "14", "--refresh-model-fanout", "all"]);
  assert.equal(options.refreshModelBlockSize, 14);
  assert.equal(options.refreshModelFanOut, "all");
  for (const flags of [["--refresh-model-block-size", "0"], ["--refresh-model-block-size", "71"],
    ["--refresh-model-block-size", "1.5"], ["--refresh-model-fanout", "sometimes"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...flags]), refused("REHEARSAL_ARGUMENT_INVALID"));
  }
});


test("current Worker/D1 mode is explicit and has no saved-reference or injected producer path", () => {
  assert.equal(parseArguments(["--golden", "/g"]).comparisonMode, "historical");
  assert.equal(parseArguments(["--golden", "/g", "--comparison-mode", "current-worker-d1", "--out", "/new-report.json"]).comparisonMode,
    "current-worker-d1");
  const diagnostic = parseArguments(["--golden", "/g", "--comparison-mode", "current-worker-d1",
    "--per-date-expected", "/g/per-date.json", "--out", "/new-report.json"]);
  assert.equal(diagnostic.perDateExpected, "/g/per-date.json");
  for (const flags of [["--comparison-mode"], ["--comparison-mode", "unknown"],
    ["--comparison-mode", "historical", "--comparison-mode", "current-worker-d1"],
    ["--comparison-mode", "current-worker-d1", "--dense"],
    ["--comparison-mode", "current-worker-d1", "--owner-reference", "/old"],
    ["--comparison-mode", "current-worker-d1", "--current-reference", "/forged.json"],
    ["--comparison-mode", "current-worker-d1", "--current-reference-sha256", "a".repeat(64)],
    ["--comparison-mode", "current-worker-d1", "--producer", "/forged.mjs"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...flags]), refused("REHEARSAL_ARGUMENT_INVALID"), flags.join(" "));
  }
});

test("current CLI and direct controller refuse schema reuse before resource access", async () => {
  const schema = "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d";
  for (const flags of [
    ["--comparison-mode", "current-worker-d1", "--reuse-schema", schema],
    ["--reuse-schema", schema, "--comparison-mode", "current-worker-d1"],
  ]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...flags]),
      (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID" && error.details?.argument === "--reuse-schema");
  }
  assert.equal(parseArguments(["--golden", "/g", "--reuse-schema", schema]).reuseSchema, schema,
    "historical reuse is preserved");
  for (const options of [
    { comparisonMode: "current-worker-d1", reuseSchema: schema },
    { reuseSchema: schema, comparisonMode: "current-worker-d1" },
  ]) {
    let accessed = false;
    for (const key of ["node22", "golden", "out", "stagedPrimary"]) Object.defineProperty(options, key, {
      get() { accessed = true; throw new Error("RESOURCE_ACCESS_BEFORE_REFUSAL"); },
    });
    await assert.rejects(runRehearsal(options),
      (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID" && error.details?.argument === "--reuse-schema");
    assert.equal(accessed, false, "direct refusal precedes runtime/file/source binding and PG prerequisites");
  }
});

test("current output is explicit at CLI and direct entry before resource access", async () => {
  for (const flags of [["--comparison-mode", "current-worker-d1"],
    ["--comparison-mode", "current-worker-d1", "--out", "/"],
    ["--comparison-mode", "current-worker-d1", "--out", "/tmp/invalid\nreport"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...flags]),
      (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID" && error.details?.argument === "--out");
  }
  const explicit = parseArguments(["--golden", "/g", "--comparison-mode", "current-worker-d1",
    "--out", "./new-report.json"]);
  assert.equal(explicit.out, join(process.cwd(), "new-report.json"), "CLI resolves an explicit output normally");
  assert.equal(parseArguments(["--golden", "/g"]).out, null, "historical omitted output is preserved");
  for (const out of [null, undefined, "", "relative.json", "/", "/tmp/../tmp/report.json", "/tmp/report\0.json",
    "/tmp/report\r.json", "/tmp/report\n.json", {}, 5]) {
    let accessed = false;
    const options = { comparisonMode: "current-worker-d1", reuseSchema: null, out };
    for (const key of ["node22", "golden", "stagedPrimary"]) Object.defineProperty(options, key, {
      get() { accessed = true; throw new Error("RESOURCE_ACCESS_BEFORE_REFUSAL"); },
    });
    await assert.rejects(runRehearsal(options),
      (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID" && error.details?.argument === "--out");
    assert.equal(accessed, false);
  }
});

test("current report and every original sidecar must be new before runtime access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "current-rehearsal-no-clobber-"));
  try {
    const out = join(directory, "report.json");
    const destinations = currentRehearsalOutputDestinations(out);
    assert.equal(destinations.length, 4);
    assert.deepEqual(await assertCurrentRehearsalOutputsNew(out), destinations);
    for (const [index, path] of destinations.entries()) {
      const original = `retained-${index}`;
      await writeFile(path, original, { flag: "wx" });
      let accessed = false;
      const options = { comparisonMode: "current-worker-d1", reuseSchema: null, out };
      Object.defineProperty(options, "node22", { get() { accessed = true; throw new Error("RUNTIME_ACCESSED"); } });
      await assert.rejects(runRehearsal(options), (error) =>
        error?.code === "REHEARSAL_CURRENT_OUTPUT_EXISTS" && error.details?.destination === index);
      assert.equal(accessed, false);
      assert.equal(await readFile(path, "utf8"), original, "no original evidence is overwritten");
      await rm(path);
    }
    await mkdir(destinations[2]);
    await assert.rejects(assertCurrentRehearsalOutputsNew(out), refused("REHEARSAL_CURRENT_OUTPUT_EXISTS"));
    await rm(destinations[2], { recursive: true });
    await symlink(join(directory, "absent-target"), destinations[3]);
    await assert.rejects(assertCurrentRehearsalOutputsNew(out), refused("REHEARSAL_CURRENT_OUTPUT_EXISTS"));
    await rm(destinations[3]);
    await assert.rejects(assertCurrentRehearsalOutputsNew(join(directory, "absent-parent", "report.json")),
      refused("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE"));
    // A destination appearing after preflight is still protected by the actual
    // controller's wx writes, not by the earlier absence check alone.
    await writeFile(out, "late-retained", { flag: "wx" });
    await assert.rejects(writeFile(out, "replacement", { flag: "wx", mode: 0o600 }), (error) => error?.code === "EEXIST");
    assert.equal(await readFile(out, "utf8"), "late-retained");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("current image runtime enforces exact version and verified platform binary pins", () => {
  const mac = { version: "v22.16.0", platform: "darwin", arch: "arm64",
    binarySha256: "a45751fbfe88440bebff63cd44814e4ed6deb642bc3e3c4a14c4f8ae0ed9e019" };
  const linux = { version: "v22.16.0", platform: "linux", arch: "x64",
    binarySha256: "8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d" };
  for (const identity of [mac, linux]) assert.doesNotThrow(() => assertCurrentImageRuntime(identity));
  for (const identity of [{ ...mac, version: "v22.17.0" }, { ...mac, version: "v26.2.0" },
    { ...mac, binarySha256: "0".repeat(64) }, { ...mac, binarySha256: linux.binarySha256 },
    { ...mac, platform: "linux", arch: "arm64" }, { ...linux, platform: "win32" }]) {
    assert.throws(() => assertCurrentImageRuntime(identity), refused("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID"));
  }
});

test("current-worker-d1-d7 selects the closed two-case controller and rejects alternate selections", () => {
  const base = ["--golden", "/g/golden-q1-node", "--comparison-mode", "current-worker-d1-d7",
    "--keep-schema", "--out", "/tmp/current-d7-report.json"];
  assert.equal(parseArguments(base).comparisonMode, "current-worker-d1-d7");
  for (const extra of [
    ["--reuse-schema", "typed_legacy_transfer_rehearsal_target_fastpath_0123abcd"],
    ["--dump", "/tmp/historical-dump.json"], ["--per-date-expected", "/tmp/historical-expectation.json"],
    ["--owner-reference", "/tmp/historical-owner-reference"], ["--dense"],
    ["--synthetic-revision-floor"], ["--staged-primary", "0911_analytics_v2_run_stamps.sql"],
    ["--single-case", "conflictPreserving"], ["--case", "conflictFreePositive"],
  ]) assert.throws(() => parseArguments([...base, ...extra]), refused("REHEARSAL_ARGUMENT_INVALID"), extra.join(" "));
  assert.throws(() => parseArguments(["--golden", "/g/golden-q1-node", "--comparison-mode", "current-worker-d1-d7",
    "--out", "/tmp/current-d7-report.json"]), refused("REHEARSAL_ARGUMENT_INVALID"), "both cases require retained schemas");
});

test("S9 routes only the D7 controller through its dense manifest and keeps consumer corpus paths", async () => {
  const d7Arguments = s9ControllerGoldenArguments({ mode: "current-worker-d1-d7", golden: CURRENT_GOLDEN,
    workerRoot: WORKER_ROOT });
  const d7Options = parseArguments([...d7Arguments, "--comparison-mode", "current-worker-d1-d7",
    "--keep-schema", "--out", join(tmpdir(), "s9-controller-corpus-routing-report.json")]);
  assert.deepEqual(d7Arguments, ["--golden", join(WORKER_ROOT, "analytics-v2-test", "golden-q1-node")]);
  assert.equal(d7Options.golden, join(WORKER_ROOT, "analytics-v2-test", "golden-q1-node"));
  assert.equal(d7Options.comparisonMode, "current-worker-d1-d7");
  const d7Manifest = JSON.parse(await readFile(join(d7Options.golden, "manifest.json"), "utf8"));
  assert.equal(d7Manifest.schemaVersion, "gcp-fastpath-dense-oracle-manifest-v1");
  assert.equal(d7Manifest.nowMs, 1_790_856_000_000);
  assert.equal(d7Manifest.corpus?.q1?.sha256, "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e");

  const historicalGolden = join(tmpdir(), "historical-golden");
  assert.deepEqual(s9ControllerGoldenArguments({ mode: "historical", golden: historicalGolden, workerRoot: WORKER_ROOT }),
    ["--golden", historicalGolden]);
  assert.deepEqual(s9ControllerGoldenArguments({ mode: "current-worker-d1", golden: CURRENT_GOLDEN, workerRoot: WORKER_ROOT }),
    ["--golden", CURRENT_GOLDEN]);
  const currentManifest = JSON.parse(await readFile(join(CURRENT_GOLDEN, "manifest.json"), "utf8"));
  assert.equal(currentManifest.schemaVersion, "gcp-fastpath-oracle-manifest-v1");
  const consumerDump = await readFile(join(CURRENT_GOLDEN, "dump", "usage-monitor-db.json"));
  assert.ok(consumerDump.byteLength > 0, "the edge consumer source dump stays under its canonical Q-1 corpus root");

  const edge = await readFile(new URL("../postgres-test/edge-origin-e2e.spec.mjs", import.meta.url), "utf8");
  const producerStart = edge.indexOf("async function seededRehearsal()");
  const producerEnd = edge.indexOf("\nasync function removeCurrentD7PrivateOutput", producerStart);
  assert.ok(producerStart >= 0 && producerEnd > producerStart);
  const producer = edge.slice(producerStart, producerEnd);
  assert.ok(producer.includes("...s9ControllerGoldenArguments({ mode: S9_COMPARISON_MODE, golden: GOLDEN, workerRoot: WORKER_ROOT })"),
    "the selector builds the actual controller CLI arguments from the canonical consumer root");
  const currentD7Consumer = edge.slice(edge.indexOf("async function runCurrentD7S9"));
  assert.ok(currentD7Consumer.includes('join(GOLDEN, "dump", "usage-monitor-db.json")'),
    "the D7 edge transport continues to read the source dump from canonical GOLDEN");
  assert.equal(CURRENT_GOLDEN, join(WORKER_ROOT, "analytics-v2-test", "golden"));
  assert.notEqual(d7Options.golden, CURRENT_GOLDEN);
});

test("current D7 owns a fresh eight-file output set under an owner-only parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "current-d7-output-check-"));
  try {
    const out = join(await realpath(directory), "report.json");
    assert.deepEqual(currentD7RehearsalOutputDestinations(out), [out, `${out}.current-d7-reference.json`,
      `${out}.current-d7-binding.json`, `${out}.current-d7-producer-acceptance.json`,
      `${out}.current-d7-conflict-preserving-case.json`, `${out}.current-d7-conflict-free-positive-case.json`,
      `${out}.current-d7-contract.json`, `${out}.current-d7-input-binding-capture.json`]);
    assert.equal((await assertCurrentD7RehearsalOutputsNew(out)).length, 8);
    await writeFile(`${out}.current-d7-reference.json`, "occupied");
    await assert.rejects(assertCurrentD7RehearsalOutputsNew(out), refused("REHEARSAL_CURRENT_OUTPUT_EXISTS"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("current D7 controller qualification accepts exactly two retained schema pairs and rejects ambiguous receipts", () => {
  const digest = "a".repeat(64);
  const receipt = (caseId, suffix) => ({ caseId, schemaVersion: "current-q1-d7-controller-case-receipt-v1",
    referenceSha256: digest, expectationSha256: digest, corpusSha256: digest, admissionSha256: digest,
    sourceInvariantSha256: digest, pgInputSha256: digest, bootstrapPreservationSha256: digest,
    strictExportSha256: digest, actualResponseSha256: digest, actualPreviewSha256: digest,
    schema: `typed_legacy_transfer_rehearsal_target_fastpath_${suffix}`,
    controlSchema: `typed_legacy_transfer_rehearsal_ctl_${suffix}`, currentDay: "2026-10-01", retainedForS9Cleanup: true });
  const qualification = {
    schemaVersion: "current-q1-d7-controller-qualification-v1", comparisonMode: "current-worker-d1-d7", decisionId: "D7",
    caseIds: ["conflictPreserving", "conflictFreePositive"], inputBindingSha256: digest,
    inputBindingCaptureContentSha256: digest, bindingSha256: digest,
    referenceContentSha256: digest, producerAcceptanceContentSha256: digest, contractContentSha256: digest,
    caseReceipts: { conflictPreserving: receipt("conflictPreserving", "0123abcd"),
      conflictFreePositive: receipt("conflictFreePositive", "89abcdef") },
    sidecars: { referenceSha256: digest, bindingSha256: digest, producerAcceptanceSha256: digest,
      conflictPreservingCaseSha256: digest, conflictFreePositiveCaseSha256: digest, contractSha256: digest,
      inputBindingCaptureSha256: digest },
    cleanupPending: true, qualifying: false, establishesNativeExecution: false,
    deadlineMs: S9_REHEARSAL_DEADLINE_MS, elapsedMs: 1000, pgInputSnapshotsRemoved: true,
  };
  assert.equal(validateCurrentD7ControllerQualification(qualification), qualification);
  const mutations = [
    (value) => { value.caseIds.pop(); },
    (value) => { value.cleanupPending = false; },
    (value) => { value.sidecars.caseSidecarSha256 = digest; },
    (value) => { value.caseReceipts.conflictFreePositive.schema = value.caseReceipts.conflictPreserving.schema; },
    (value) => { value.caseReceipts.conflictPreserving.retainedForS9Cleanup = false; },
    (value) => { value.pgInputSnapshotsRemoved = false; },
    (value) => { value.sidecars.inputBindingCaptureSha256 = "b".repeat(64); },
    (value) => { value.caseReceipts.conflictFreePositive.currentDay = "2026-09-30"; },
    (value) => { value.unrecognized = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(qualification); mutate(changed);
    assert.throws(() => validateCurrentD7ControllerQualification(changed), refused("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID"));
  }
});

test("current D7 uses one non-resetting monotonic deadline and runs both cases before aggregate comparison", async () => {
  assert.equal(currentD7RemainingMs(10_000, 1_000), 9_000);
  assert.equal(currentD7StatementTimeoutMs(10_000, 1_000), 8_000);
  assert.throws(() => currentD7RemainingMs(1_000, 1_000), refused("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"));
  const source = await readFile(new URL("./gcp-fastpath-rehearsal.mjs", import.meta.url), "utf8");
  const driver = source.slice(source.indexOf("async function runCurrentD7Rehearsal(options)"),
    source.indexOf("/** Direct controller callers retain"));
  assert.ok(driver.length > 0);
  const order = [
    "const startedMonotonicMs = performance.now()",
    "const deadlineMonotonicMs = startedMonotonicMs + S9_REHEARSAL_DEADLINE_MS",
    "const capturedInputBinding = await timed(timings, \"current-d7:input-binding\"",
    "outputSidecars.inputBindingCaptureSha256 = await writeCurrentD7Sidecar(outputPaths[7], inputBindingCapture)",
    "const producerResult = await timed(timings, \"current-d7:producer\"",
    "await verifyCurrentD7InputBindingCapture(outputPaths[7], inputBindingCaptureMetadata",
    "outputSidecars.referenceSha256 = await writeCurrentD7Sidecar",
    "for (const caseId of CURRENT_D7_CASES)",
    "const result = await runRehearsal",
    "const comparatorReport = comparator.compareCurrentQ1D7Contract({",
    "const pgInputSnapshotsRemoved = await removeCurrentD7PgInputDirectory",
    "validateCurrentD7ControllerQualification({",
  ].map((statement) => driver.indexOf(statement));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.match(driver, /deadlineMonotonicMs,\s*progress,/u, "both inner case runs share the original deadline and progress journal");
  assert.match(driver, /inputBinding:\s*producerInputBinding/u, "the producer receives a distinct immutable binding clone");
});

test("D7 PostgreSQL adapter refreshes server statement timeouts after waits and serializes transactions", async () => {
  const calls = [];
  const rawClient = {
    async query(...args) {
      calls.push({ type: "query", text: typeof args[0] === "string" ? args[0] : args[0]?.text, args });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      return { rows: [] };
    },
    release(error) { calls.push({ type: "release", error }); },
  };
  const rawPool = {
    async connect() { await new Promise((resolveDelay) => setTimeout(resolveDelay, 30)); return rawClient; },
    async end() {},
  };
  const deadline = performance.now() + 15_000;
  const pool = createCurrentD7DeadlinePool(rawPool, deadline);
  const timeoutBeforeCheckout = currentD7StatementTimeoutMs(deadline);
  await pool.query("SELECT pool_query");
  const poolQueries = calls.filter((entry) => entry.type === "query");
  assert.deepEqual(poolQueries.map(({ text }) => text), [
    "SELECT set_config('statement_timeout', $1, false)", "SELECT pool_query",
  ]);
  assert.ok(Number.parseInt(poolQueries[0].args[1][0], 10) < timeoutBeforeCheckout - 20,
    "remaining time is sampled after the public pool connect wait");

  calls.length = 0;
  const client = await pool.connect();
  const queries = [client.query("BEGIN"), client.query("SELECT first"),
    client.query({ text: "SELECT $1", values: ["second"] }), client.query("ROLLBACK")];
  await Promise.all(queries);
  const observed = calls.filter((entry) => entry.type === "query");
  assert.deepEqual(observed.map(({ text }) => text), [
    "SELECT set_config('statement_timeout', $1, false)", "BEGIN",
    "SELECT set_config('statement_timeout', $1, false)", "SELECT first",
    "SELECT set_config('statement_timeout', $1, false)", "SELECT $1", "ROLLBACK",
  ], "each config and target query are adjacent on one serialized client; rollback remains possible");
  const timeoutValues = observed.filter(({ text }) => text.startsWith("SELECT set_config"))
    .map(({ args }) => Number.parseInt(args[1][0], 10));
  assert.ok(timeoutValues.every((value) => Number.isSafeInteger(value) && value > 0));
  assert.ok(timeoutValues[1] < timeoutValues[0], "later statements receive the shorter remaining timeout");
  await client.release();

  const perClient = [[], []]; let checkout = 0;
  const concurrentPool = createCurrentD7DeadlinePool({
    async connect() {
      const id = checkout++;
      return { async query(text) { perClient[id].push(text); await new Promise((resolveDelay) => setTimeout(resolveDelay, 2)); return { rows: [] }; },
        release() {} };
    },
    async end() {},
  }, performance.now() + 5_000);
  const [left, right] = await Promise.all([concurrentPool.connect(), concurrentPool.connect()]);
  await Promise.all([left.query("SELECT left_client"), right.query("SELECT right_client")]);
  assert.deepEqual(perClient, [
    ["SELECT set_config('statement_timeout', $1, false)", "SELECT left_client"],
    ["SELECT set_config('statement_timeout', $1, false)", "SELECT right_client"],
  ], "concurrent clients configure only their own checked-out PostgreSQL sessions");
  await Promise.all([left.release(), right.release()]);
});

test("D7 PostgreSQL adapter bounds a queued checkout and releases a failed raw query client", async () => {
  let resolveCheckout;
  const lateClientCalls = [];
  const lateClient = { async query(...args) { lateClientCalls.push(args); return { rows: [] }; },
    release(error) { lateClientCalls.push({ release: true, error }); } };
  const queued = createCurrentD7DeadlinePool({ connect: () => new Promise((resolve) => { resolveCheckout = resolve; }),
    async end() {} }, performance.now() + 30);
  await assert.rejects(queued.query("SELECT must_not_run"), refused("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"));
  resolveCheckout(lateClient);
  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  assert.equal(lateClientCalls.length, 1);
  assert.equal(lateClientCalls[0].release, true, "a client checked out after expiry is discarded");
  assert.equal(lateClientCalls[0].error.code, "REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED");

  const targetError = new Error("synthetic query failure");
  const failedCalls = [];
  const failedPool = createCurrentD7DeadlinePool({
    async connect() { return { async query(text) {
      failedCalls.push(text);
      if (text === "SELECT target_failure") throw targetError;
      return { rows: [] };
    }, release(error) { failedCalls.push({ release: true, error }); } }; },
    async end() {},
  }, performance.now() + 5_000);
  await assert.rejects(failedPool.query("SELECT target_failure"), (error) => error === targetError);
  assert.deepEqual(failedCalls.slice(0, 2), ["SELECT set_config('statement_timeout', $1, false)", "SELECT target_failure"]);
  assert.equal(failedCalls[2].release, true);
  assert.equal(failedCalls[2].error, targetError, "pool.query preserves its original failure while releasing the client");

  const nearDeadlineCalls = [];
  const nearDeadlinePool = createCurrentD7DeadlinePool({
    async connect() { return { async query(...args) { nearDeadlineCalls.push(args); return { rows: [] }; },
      release(error) { nearDeadlineCalls.push({ release: true, error }); } }; },
    async end() {},
  }, performance.now() + 500);
  const nearDeadlineClient = await nearDeadlinePool.connect();
  await assert.rejects(nearDeadlineClient.query("ROLLBACK"), refused("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"));
  const callsBeforeFollowup = nearDeadlineCalls.length;
  await assert.rejects(nearDeadlineClient.query("SELECT must_not_run_after_expired_cleanup"),
    refused("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"));
  assert.equal(nearDeadlineCalls.length, callsBeforeFollowup,
    "once an expired cleanup poisons the client, no later target SQL reaches PostgreSQL");
  await nearDeadlineClient.release();
  assert.equal(nearDeadlineCalls[0].release, true);
  assert.equal(nearDeadlineCalls[0].error.code, "REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED",
    "a refused rollback discards its transaction instead of returning an aborted session to the pool");
});

test("D7 skips timeout setup only for exact owned rollback cleanup statements", async () => {
  const calls = [];
  let aborted = false;
  const rawClient = {
    async query(...args) {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
      calls.push(text);
      if (aborted && text.startsWith("SELECT set_config")) throw new Error("synthetic-aborted-transaction");
      if (text === "SELECT synthetic_failure") {
        aborted = true;
        throw new Error("synthetic-target-failure");
      }
      if (text === "ROLLBACK TO SAVEPOINT tibotattle_transfer_trigger_policy") aborted = false;
      if (text === "ROLLBACK") aborted = false;
      return { rows: [] };
    },
    release(error) { calls.push(error ? "release:discard" : "release:reuse"); },
  };
  const pool = createCurrentD7DeadlinePool({ async connect() { return rawClient; }, async end() {} }, performance.now() + 5_000);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SAVEPOINT tibotattle_transfer_trigger_policy");
  await assert.rejects(client.query("SELECT synthetic_failure"), /synthetic-target-failure/u);
  await client.query("ROLLBACK TO SAVEPOINT tibotattle_transfer_trigger_policy");
  await client.query("RELEASE SAVEPOINT tibotattle_transfer_trigger_policy");
  await client.query("ROLLBACK");
  assert.deepEqual(calls, [
    "SELECT set_config('statement_timeout', $1, false)", "BEGIN",
    "SELECT set_config('statement_timeout', $1, false)", "SAVEPOINT tibotattle_transfer_trigger_policy",
    "SELECT set_config('statement_timeout', $1, false)", "SELECT synthetic_failure",
    "ROLLBACK TO SAVEPOINT tibotattle_transfer_trigger_policy",
    "SELECT set_config('statement_timeout', $1, false)", "RELEASE SAVEPOINT tibotattle_transfer_trigger_policy",
    "ROLLBACK",
  ], "the two exact importer-owned cleanups reach an aborted transaction without an illegal setter");
  await client.release();

  calls.length = 0;
  const statements = createCurrentD7DeadlinePool({ async connect() { return rawClient; }, async end() {} }, performance.now() + 5_000);
  await statements.query("ROLLBACK; SELECT must_not_use_cleanup_bypass");
  await statements.query("ROLLBACK TO SAVEPOINT another_savepoint");
  assert.deepEqual(calls, [
    "SELECT set_config('statement_timeout', $1, false)", "ROLLBACK; SELECT must_not_use_cleanup_bypass",
    "release:reuse", "SELECT set_config('statement_timeout', $1, false)", "ROLLBACK TO SAVEPOINT another_savepoint",
    "release:reuse",
  ], "multi-statement and non-owned savepoint text use the regular bounded query path");
});

test("D7 refuses the target statement if timeout setup consumes the deadline reserve", async () => {
  const calls = [];
  const pool = createCurrentD7DeadlinePool({
    async connect() { return { async query(text) {
      calls.push(text);
      if (text.startsWith("SELECT set_config")) await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      return { rows: [] };
    }, release(error) { calls.push({ release: true, error }); } }; },
    async end() {},
  }, performance.now() + 1_700);
  await assert.rejects(pool.query("SELECT too_late"), refused("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"));
  assert.deepEqual(calls.map((entry) => typeof entry === "string" ? entry : "release"), [
    "SELECT set_config('statement_timeout', $1, false)", "release",
  ], "the target SQL is not sent after configuration uses the deadline reserve");
});

test("D7 origin readiness requires a nonce-bound acknowledgement from the live child", async () => {
  const { child, nonce } = spawnReadinessChild();
  let exited;
  try {
    const result = await requestReadiness(child, nonce, 1_000);
    exited = result.exited;
    assert.equal(result.ready.origin, READINESS_ORIGIN);
    assert.equal(child.exitCode, null, "the child is alive when readiness is returned");
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  }
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness waits for successful send delivery when the valid ACK arrives first", async () => {
  const { child, nonce } = spawnReadinessChild("ack-after-callback-success");
  const gate = gateChallengeCallbackUntilAcknowledgement(child);
  let readinessSettled = false;
  let settledBeforeCallback = false;
  let exited;
  const readiness = requestReadiness(child, nonce, 1_000, { sendOverride: gate.sendOverride });
  readiness.then(() => {
    readinessSettled = true;
    if (!gate.state.callbackInvoked) settledBeforeCallback = true;
  }, () => { readinessSettled = true; });
  try {
    const result = await readiness;
    exited = result.exited;
    assert.equal(result.ready.origin, READINESS_ORIGIN);
    assert.equal(gate.state.acknowledgementReceived, true);
    assert.equal(gate.state.deliveryCallbackCompleted, true);
    assert.equal(gate.state.acknowledgementBeforeCallback, true);
    assert.equal(gate.state.callbackInvoked, true);
    assert.equal(readinessSettled, true);
    assert.equal(settledBeforeCallback, false);
    assert.equal(child.exitCode, null, "the owned child remains alive when readiness resolves");
  } finally {
    gate.dispose();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  }
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness fails closed when an ACK precedes the send callback error", async () => {
  const timeoutMs = 250;
  const { child, nonce } = spawnReadinessChild("ack-after-callback-error");
  const gate = gateChallengeCallbackUntilAcknowledgement(child, { callbackError: true });
  const startedAt = performance.now();
  let exited;
  const readiness = requestReadiness(child, nonce, timeoutMs, { sendOverride: gate.sendOverride }).then((result) => {
    exited = result.exited;
    return result;
  });
  try {
    await assert.rejects(readiness, refused("REHEARSAL_ORIGIN_START_FAILED"));
  } finally {
    gate.dispose();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(gate.state.acknowledgementReceived, true);
  assert.equal(gate.state.deliveryCallbackCompleted, true);
  assert.equal(gate.state.acknowledgementBeforeCallback, true);
  assert.equal(gate.state.callbackInvoked, true);
  assert.ok(elapsedMs >= timeoutMs - 50, `IPC failure classification waits for the shared readiness deadline (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness and explicit reap caps stay bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0, "the owned child is reaped after callback failure");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness times out and reaps when ACK arrives but the send callback never fires", async () => {
  const timeoutMs = 250;
  const { child, nonce } = spawnReadinessChild("ack-after-callback-never");
  const gate = gateChallengeCallbackUntilAcknowledgement(child, { neverCallback: true });
  const startedAt = performance.now();
  let exited;
  const readiness = requestReadiness(child, nonce, timeoutMs, { sendOverride: gate.sendOverride }).then((result) => {
    exited = result.exited;
    return result;
  });
  try {
    await assert.rejects(readiness, refused("REHEARSAL_ORIGIN_START_TIMEOUT"));
  } finally {
    gate.dispose();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(gate.state.acknowledgementReceived, true);
  assert.equal(gate.state.deliveryCallbackCompleted, true);
  assert.equal(gate.state.callbackInvoked, false);
  assert.ok(elapsedMs >= timeoutMs - 50, `missing delivery confirmation uses the shared readiness deadline (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness and explicit reap caps stay bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0, "the owned child is reaped after missing callback confirmation");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness consumes one bounded record and ignores repeated large post-ready stdout", async () => {
  const { child, nonce } = spawnReadinessChild("extra-output");
  const expectedPostReadyBytes = Buffer.byteLength(`${JSON.stringify({ origin: READINESS_ORIGIN })}\n`) + 40_000;
  const sendControl = child.send.bind(child);
  let challengeStarted = false;
  let postReadyBytes = 0;
  let postReadyOutputReleased = false;
  let resolvePostReadyOutput;
  const postReadyOutput = new Promise((resolveOutput) => { resolvePostReadyOutput = resolveOutput; });
  child.stdout.on("data", (chunk) => {
    if (!challengeStarted) return;
    postReadyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (!postReadyOutputReleased && postReadyBytes >= expectedPostReadyBytes) {
      postReadyOutputReleased = true;
      resolvePostReadyOutput();
      sendControl({ type: "readiness-test-release-ack" });
    }
  });
  let challengeCount = 0;
  let exited;
  try {
    const result = await requestReadiness(child, nonce, 1_000, { sendOverride(message, callback, sendToChild) {
      if (message?.type !== READINESS_CHALLENGE) return sendToChild(message, callback);
      challengeCount++;
      challengeStarted = true;
      return sendToChild(message, (error) => { postReadyOutput.then(() => callback(error)); });
    } });
    exited = result.exited;
    assert.equal(result.ready.origin, READINESS_ORIGIN);
    assert.ok(postReadyBytes >= expectedPostReadyBytes, "the duplicate record and both large stdout chunks were delivered");
    assert.equal(challengeCount, 1, "post-ready output cannot issue another challenge");
    assert.equal(child.exitCode, null, "the owned child remains live through readiness return");
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  }
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness enforces the first-line limit when newline shares an oversized chunk", async () => {
  const { child, challengeCount } = createOversizedReadyLineChild();
  let dataChunkCount = 0;
  child.stdout.on("data", () => { dataChunkCount++; });
  try {
    await assert.rejects(awaitCurrentD7OriginReadiness(child,
      { readyTimeoutMs: 500, readinessNonce: READINESS_NONCE }), refused("REHEARSAL_ORIGIN_START_FAILED"));
    assert.equal(dataChunkCount, 1, "the oversized record and newline arrived in one stream chunk");
    assert.equal(challengeCount, 0, "oversized readiness cannot trigger an IPC challenge");
    assert.equal(child.exitCode, 0, "the rejected owned child is reaped");
    assert.equal(child.signalCode, null);
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("D7 origin readiness refuses an invalid acknowledgement and reaps its child", async () => {
  const { child, nonce } = spawnReadinessChild("invalid");
  await assert.rejects(requestReadiness(child, nonce, 1_000), refused("REHEARSAL_ORIGIN_START_FAILED"));
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness times out when the live child never acknowledges", async () => {
  const timeoutMs = 1_000;
  const { child, nonce } = spawnReadinessChild("absent");
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs), refused("REHEARSAL_ORIGIN_START_TIMEOUT"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `one readiness budget elapsed (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0, "timeout cleanup waits for the owned child to exit");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness does not accept an acknowledgement after the single deadline", async () => {
  const timeoutMs = 500;
  const { child, nonce } = spawnReadinessChild("late");
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs), refused("REHEARSAL_ORIGIN_START_TIMEOUT"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `the single readiness budget elapsed (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0, "the child exits only after its delayed acknowledgement is sent");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness shares one deadline across the ready line and acknowledgement", async () => {
  const timeoutMs = 500;
  const { child, nonce } = spawnReadinessChild("staggered");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs), refused("REHEARSAL_ORIGIN_START_TIMEOUT"));
  const elapsedMs = performance.now() - startedAt;
  const phases = stderr.join("");
  assert.match(phases, /readiness-test-ready-record/u, "the child emitted its stdout-ready record");
  assert.match(phases, /readiness-test-ack-pending/u, "the child received the challenge and entered the acknowledgement wait");
  assert.ok(elapsedMs >= timeoutMs - 50, `the single readiness budget elapsed (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0, "the ack sent after the global deadline cannot extend readiness");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness fails closed and reaps after a post-ready IPC disconnect", async () => {
  const timeoutMs = 250;
  const { child, nonce } = spawnReadinessChild("disconnect");
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs), refused("REHEARSAL_ORIGIN_START_FAILED"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `disconnected IPC used the same bounded readiness budget (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness ignores a queued matching acknowledgement after disconnect and reaps the child", async () => {
  const timeoutMs = 250;
  const child = createDisconnectingReadinessChild(READINESS_NONCE);
  let acknowledgementReceived = false;
  child.on("message", (message) => { if (message?.type === READINESS_ACK) acknowledgementReceived = true; });
  const startedAt = performance.now();
  await assert.rejects(awaitCurrentD7OriginReadiness(child,
    { readyTimeoutMs: timeoutMs, readinessNonce: READINESS_NONCE }), refused("REHEARSAL_ORIGIN_START_FAILED"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `disconnect defers refusal to the shared readiness deadline (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(acknowledgementReceived, true, "the matching queued acknowledgement was actually delivered after disconnect");
  assert.equal(child.exitCode, 0, "the disconnected owned child is reaped");
  assert.equal(child.signalCode, null);
  child.stdout.destroy();
  child.stderr.destroy();
});

test("D7 origin readiness ignores a matching acknowledgement after synchronous send failure and reaps the child", async () => {
  const timeoutMs = 250;
  const { child, nonce } = spawnReadinessChild("ack-after-sync-error");
  let acknowledgementReceived = false;
  child.on("message", (message) => { if (message?.type === READINESS_ACK) acknowledgementReceived = true; });
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs, {
    sendOverride(message, _callback, sendToChild) {
      if (message?.type === READINESS_CHALLENGE) {
        sendToChild({ type: "readiness-test-release-ack" });
        throw new Error("synthetic IPC send refusal");
      }
      return sendToChild(message);
    },
  }), refused("REHEARSAL_ORIGIN_START_FAILED"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `send refusal remained within the shared readiness budget (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(acknowledgementReceived, true, "the matching acknowledgement was emitted after the synchronous throw");
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness ignores a matching acknowledgement after callback failure and reaps the child", async () => {
  const timeoutMs = 250;
  const { child, nonce } = spawnReadinessChild("ack-after-callback-error");
  let acknowledgementReceived = false;
  child.on("message", (message) => { if (message?.type === READINESS_ACK) acknowledgementReceived = true; });
  const startedAt = performance.now();
  await assert.rejects(requestReadiness(child, nonce, timeoutMs, {
    sendOverride(message, callback, sendToChild) {
      if (message?.type === READINESS_CHALLENGE) {
        setImmediate(() => {
          callback(new Error("synthetic IPC callback refusal"));
          sendToChild({ type: "readiness-test-release-ack" });
        });
        return true;
      }
      return sendToChild(message, callback);
    },
  }), refused("REHEARSAL_ORIGIN_START_FAILED"));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs - 50, `callback refusal remained within the shared readiness budget (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs <= timeoutMs + READINESS_CHILD_CLEANUP_CAP_MS + READINESS_SCHEDULER_MARGIN_MS,
    `readiness plus explicit cleanup caps stayed bounded (${elapsedMs.toFixed(1)}ms)`);
  assert.equal(acknowledgementReceived, true, "the matching acknowledgement was emitted after the callback error");
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness timeout terminates and reaps a child before its late-ready line", async () => {
  const nonce = READINESS_NONCE;
  const code = [
    "process.on('SIGTERM', () => process.exit(0));",
    "process.stdout.write('armed\\n');",
    "setTimeout(() => process.stdout.write(JSON.stringify({origin:'http://127.0.0.1:1'}) + '\\n'), 250);",
  ].join("");
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolveReady, rejectReady) => {
    child.stdout.once("data", resolveReady);
    child.once("error", rejectReady);
  });
  await assert.rejects(awaitCurrentD7OriginReadiness(child, { readyTimeoutMs: 25, readinessNonce: nonce }),
    refused("REHEARSAL_ORIGIN_START_TIMEOUT"));
  assert.equal(child.exitCode, 0, "the controller waits for its own SIGTERM-handled child to exit");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  assert.equal(child.exitCode, 0, "the delayed readiness output cannot resurrect or orphan the child");
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness rejects an early-exit child without returning a dead handle", async () => {
  const nonce = READINESS_NONCE;
  const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({origin:'http://127.0.0.1:1'}) + '\\n'); process.exit(7);"],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await assert.rejects(awaitCurrentD7OriginReadiness(child, { readyTimeoutMs: 500, readinessNonce: nonce }),
    refused("REHEARSAL_ORIGIN_START_FAILED"));
  assert.equal(child.exitCode, 7);
  assert.equal(child.signalCode, null);
});

test("D7 origin readiness refuses an already-exited IPC child without missed-event waits", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({origin:'http://127.0.0.1:1'}) + '\\n'); process.exit(7);"],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolveClose, rejectClose) => {
    child.once("close", resolveClose);
    child.once("error", rejectClose);
  });
  await assert.rejects(awaitCurrentD7OriginReadiness(child,
    { readyTimeoutMs: 500, readinessNonce: READINESS_NONCE }), refused("REHEARSAL_ORIGIN_START_FAILED"));
  assert.equal(child.exitCode, 7);
  assert.equal(child.signalCode, null);
});

test("wrong, relative and symlink current image paths refuse before executable or source access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "current-image-pin-negative-"));
  try {
    const fake = join(directory, "fake-node");
    await writeFile(fake, "synthetic untrusted binary", { flag: "wx" });
    const linked = join(directory, "linked-node"); await symlink(fake, linked);
    for (const node22 of [fake, linked, directory, "relative-node", join(directory, "absent-node")]) {
      let accessed = false;
      const options = { comparisonMode: "current-worker-d1", reuseSchema: null,
        out: join(directory, "report.json"), node22 };
      for (const key of ["golden", "stagedPrimary"]) Object.defineProperty(options, key, {
        get() { accessed = true; throw new Error("SOURCE_ACCESS_BEFORE_REFUSAL"); },
      });
      await assert.rejects(runRehearsal(options), refused("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID"));
      assert.equal(accessed, false);
    }
    await assert.rejects(verifyCurrentImageRuntimePath(fake), refused("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("current gates cannot promote saved comparison-only evidence without the actual controller receipt", () => {
  // This tests the pure gate selector, not execution or receipt authenticity.
  const comparison = { schemaVersion: "analytics-v2-current-contract-report-v2", comparisonMode: "current-worker-d1",
    referenceBound: true, referenceComplete: true, recomputationComplete: true, corpusConvergenceComplete: true,
    strictExportRefusalVerified: true, referenceSha256: "d".repeat(64), recomputationSha256: "a".repeat(64), corpusConvergenceSha256: "b".repeat(64),
    strictExportRefusalSha256: "c".repeat(64), equal: true, unexpectedDiffs: 0,
    evidenceScope: "reference-comparison-only", establishesNativeExecution: false };
  const arguments_ = { comparisonMode: "current-worker-d1", currentContractParity: comparison,
    parity: { schemaVersion: "analytics-v2-parity-report-v4", unexpectedDiffs: 9, breakdownsV13: { accepted: false },
      days: { golden: 168, actual: 168, missingInActual: [], extraInActual: [] },
      families: ["daily-days", "daily-totals", "daily-cells", "daily-other"].map((family) => ({ family,
        expected: false, compared: family === "daily-days" ? 1 : 168, equal: family === "daily-days" ? 1 : 168, diffCount: 0 })) },
    hasAllowanceBreakdowns: true,
    perDate: { equal: false } };
  assert.deepEqual(rehearsalComparisonGates(arguments_), { currentWorkerD1ProducerAccepted: false,
    currentWorkerD1ReferenceComplete: false, currentWorkerD1Equality: false, immutableCorpusDailyConserved: true });
  const producerAcceptance = { schemaVersion: "current-q1-d1-producer-acceptance-v2", accepted: true,
    actualHelperInvocation: true, resultReturnedAfterOwnedCleanup: true, cryptographicExecutionAttestation: false,
    referenceSha256: "d".repeat(64), recomputationSha256: "a".repeat(64), corpusConvergenceSha256: "b".repeat(64), strictExportRefusalSha256: "c".repeat(64) };
  assert.deepEqual(rehearsalComparisonGates({ ...arguments_, producerAcceptance }), { currentWorkerD1ProducerAccepted: true,
    currentWorkerD1ReferenceComplete: true, currentWorkerD1Equality: true, immutableCorpusDailyConserved: true });
  for (const [field, value] of [["schemaVersion", "unknown"], ["accepted", false], ["actualHelperInvocation", false],
    ["resultReturnedAfterOwnedCleanup", false], ["cryptographicExecutionAttestation", true],
    ["referenceSha256", undefined], ["referenceSha256", "a".repeat(64)],
    ["recomputationSha256", undefined], ["recomputationSha256", "d".repeat(64)],
    ["corpusConvergenceSha256", undefined], ["corpusConvergenceSha256", "d".repeat(64)],
    ["strictExportRefusalSha256", undefined], ["strictExportRefusalSha256", "d".repeat(64)]]) {
    const gates = rehearsalComparisonGates({ ...arguments_, producerAcceptance: { ...producerAcceptance, [field]: value } });
    for (const name of ["currentWorkerD1ProducerAccepted", "currentWorkerD1ReferenceComplete", "currentWorkerD1Equality"]) {
      assert.equal(gates[name], false);
    }
    assert.equal(gates.immutableCorpusDailyConserved, true, "corpus conservation is independent of producer acceptance");
  }
  for (const [field, value] of [["schemaVersion", "analytics-v2-parity-report-v4"], ["comparisonMode", "historical"],
    ["referenceBound", false], ["referenceComplete", false], ["recomputationComplete", false],
    ["corpusConvergenceComplete", false], ["strictExportRefusalVerified", false], ["referenceSha256", "a".repeat(64)],
    ["recomputationSha256", "a"], ["corpusConvergenceSha256", null], ["strictExportRefusalSha256", "d".repeat(64)],
    ["equal", false], ["unexpectedDiffs", 1]]) {
    const gates = rehearsalComparisonGates({ ...arguments_, producerAcceptance,
      currentContractParity: { ...comparison, [field]: value } });
    assert.equal(gates.currentWorkerD1Equality, false);
  }
  for (const mutate of [
    (parity) => { delete parity.families; },
    (parity) => { parity.families.pop(); },
    (parity) => { parity.families.push(structuredClone(parity.families[0])); },
    (parity) => { parity.families[1].diffCount = 1; },
    (parity) => { parity.families[1].compared = 0; parity.families[1].equal = 0; },
    (parity) => { parity.families[1].expected = true; },
    (parity) => { parity.days.actual -= 1; },
    (parity) => { parity.days.missingInActual.push("2026-09-01"); },
    (parity) => { parity.schemaVersion = "unknown"; },
  ]) {
    const parity = structuredClone(arguments_.parity); mutate(parity);
    const gates = rehearsalComparisonGates({ ...arguments_, parity, producerAcceptance });
    assert.equal(gates.currentWorkerD1Equality, true, "equal current outputs do not substitute for conservation");
    assert.equal(gates.immutableCorpusDailyConserved, false);
  }
  assert.deepEqual(rehearsalComparisonGates({ ...arguments_, comparisonMode: "historical" }), {
    parityZeroUnexpected: false, breakdownsV13Declared: false, perDateEqual: false });
});

test("qualifying driver invokes the fixed actual D1 producer and preserves original acceptance before any PG query", async () => {
  // Source-control-flow regression guard; actual D1 execution remains a separate gate.
  const source = await readFile(new URL("./gcp-fastpath-rehearsal.mjs", import.meta.url), "utf8");
  assert.match(source, /await import\("\.\.\/postgres-test\/fixtures\/current-q1-d1-reference\.mjs"\)/u);
  const positions = [
    'currentReferenceBinding = await timed(timings, "current-d1:input-binding", captureCurrentQ1ReferenceBinding)',
    'currentReference = await timed(timings, "current-d1:replay", runCurrentQ1D1Reference)',
    'validateCurrentQ1ReferenceBinding({ reference: currentReference, expected: currentReferenceBinding })',
    'const complete = assessCurrentQ1ReferenceCompleteness({ reference: currentReference',
    'if (currentReference.qualification !== "complete" || complete.state !== "complete")',
    'const currentEvidenceSha256 = Object.fromEntries(["recomputation", "corpusConvergence", "strictExportRefusal"]',
    'currentReferenceSha256 = createHash("sha256").update(JSON.stringify(currentReference))',
    'writeFile(`${options.out}.current-reference-acceptance.json`',
    'const version = await pool.query("SELECT current_setting',
  ].map((statement) => source.indexOf(statement));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  const entry = source.slice(source.indexOf("export async function runRehearsal(options)"));
  assert.ok(entry.indexOf("currentRehearsalOutputDestinations(options.out)") < entry.indexOf("existsSync(options.node22)"));
  assert.ok(entry.indexOf("await assertCurrentRehearsalOutputsNew(options.out)") < entry.indexOf("existsSync(options.node22)"));
  const currentBranch = entry.slice(entry.indexOf('const retained = await verifyCurrentImageRuntimePath(options.node22)'));
  assert.ok(currentBranch.indexOf('const retained = await verifyCurrentImageRuntimePath(options.node22)')
    < currentBranch.indexOf('execFileAsync(options.node22, ["--version"])'), "pin check precedes execution");
  assert.ok(currentBranch.indexOf('await verifyCurrentImageRuntimePath(options.node22)')
    < currentBranch.indexOf('await readFile(join(options.golden'), "trusted runtime precedes source access");
  assert.match(entry, /await writeFile\(options\.out, text, \{ flag: "wx", mode: 0o600 \}\);\s*process\.stdout\.write\(text\)/u,
    "current report is wx-preserved before any qualifying stdout report");
  assert.match(source, /referenceSha256: currentReferenceSha256, actual, actualPreview/u,
    "comparison consumes the original producer digest, not a reminted PG or saved-file digest");
});

// S9 failure diagnostics use synthetic child results, with no subprocess, database or network.
test("S9 preserves success and closes failed child results without exposing raw error fields", async () => {
  assert.equal(S9_REHEARSAL_DEADLINE_MS, 2_400_000, "the original 40-minute child budget is retained");
  const success = await captureS9ChildCompletion(async () => ({ stdout: "synthetic", stderr: "" }), () => 1);
  assert.deepEqual(success.metadata, { state: "completed", exitCode: 0, signal: null, killed: false,
    childCode: null, deadlineMs: S9_REHEARSAL_DEADLINE_MS, deadlineElapsed: false });
  assert.doesNotThrow(() => assertS9ChildCompleted(success.metadata));
  assert.equal(success.stdout.bytes.toString(), "synthetic");
  for (const input of [
    { code: 2, signal: null, killed: false },
    { code: null, signal: "SIGTERM", killed: true },
    { code: "ENOENT", signal: null, killed: false },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: null, killed: true },
    { code: "PRIVATE_TOKEN", signal: "PRIVATE_PATH", killed: "yes" },
  ]) {
    let time = 0;
    const completion = await captureS9ChildCompletion(async () => {
      time = S9_REHEARSAL_DEADLINE_MS;
      throw { ...input, message: "PRIVATE_MESSAGE", path: "/private/synthetic", cmd: "PRIVATE_COMMAND",
        stdout: "synthetic stdout", stderr: "synthetic stderr" };
    }, () => time);
    assert.equal(completion.metadata.state, "failed");
    assert.equal(completion.metadata.deadlineElapsed, true);
    assert.equal(completion.metadata.killed, input.killed === true);
    assert.equal(completion.metadata.exitCode, input.code === 2 ? 2 : null);
    assert.equal(completion.metadata.signal, input.signal === "SIGTERM" ? "SIGTERM" : null);
    assert.equal(completion.metadata.childCode, ["ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(input.code)
      ? input.code : "other");
    assert.doesNotMatch(JSON.stringify(completion.metadata), /PRIVATE_|private\/synthetic/u);
    assert.throws(() => assertS9ChildCompleted(completion.metadata), (error) =>
      error.code === "S9_REHEARSAL_CHILD_FAILED" && error.message === error.code
        && error.diagnostic === completion.metadata);
  }
});

test("S9 keeps a valid failed report available for exact schema cleanup and refuses missing or malformed reports closed", async () => {
  const failed = (await captureS9ChildCompletion(async () => { throw { code: 2 }; })).metadata;
  const valid = { status: "error", reusedSchema: false,
    schema: "typed_legacy_transfer_rehearsal_target_fastpath_0123abcd",
    keptSchemas: ["typed_legacy_transfer_rehearsal_target_fastpath_0123abcd",
      "typed_legacy_transfer_rehearsal_ctl_0123abcd"] };
  assert.deepEqual(await readS9ChildReport("synthetic", failed, async () => JSON.stringify(valid)), valid,
    "a child failure does not bypass the caller's owned-schema boundary");
  for (const read of [async () => { throw { code: "ENOENT", message: "PRIVATE" }; },
    async () => "bad JSON PRIVATE", async () => "[]", async () => "null"]) {
    await assert.rejects(readS9ChildReport("synthetic", failed, read), (error) =>
      error.code === "S9_REHEARSAL_CHILD_FAILED" && error.message === error.code);
    await assert.rejects(readS9ChildReport("synthetic", { state: "completed" }, read),
      (error) => error.code === "S9_REHEARSAL_REPORT_INVALID" && error.message === error.code);
  }
  const edge = await readFile(new URL("../postgres-test/edge-origin-e2e.spec.mjs", import.meta.url), "utf8");
  const producerStart = edge.indexOf("async function seededRehearsal()");
  const producerEnd = edge.indexOf("\nasync function removeCurrentD7PrivateOutput", producerStart);
  assert.ok(producerStart >= 0 && producerEnd > producerStart, "the S9 producer boundary is present");
  const producer = edge.slice(producerStart, producerEnd);
  const readReport = producer.indexOf("const report = await readS9ChildReport(out, completion.metadata);");
  const validateOwnership = producer.indexOf("if (!CURRENT_D7) ownedKeptRehearsalSchemas(report);");
  const handoff = producer.indexOf("result = { report, evidence, runtime, imageRuntime, staged, artifactsPreserved,");
  const returnResult = producer.indexOf("return result;");
  assert.ok(readReport >= 0 && validateOwnership > readReport && handoff > validateOwnership && returnResult > handoff,
    "a valid failed-child report reaches the caller with its exact owned schemas before cleanup is decided");
  assert.doesNotMatch(producer, /catch\(\(\) => undefined\)/u,
    "report and ownership failures cannot be swallowed before the cleanup boundary");
  const goldenLabel = edge.indexOf('"S9 golden:');
  const integrationStart = edge.lastIndexOf("test(CURRENT_D7", goldenLabel);
  assert.ok(goldenLabel >= 0 && integrationStart >= 0, "the integrated S9 consumer test is present");
  const integration = edge.slice(integrationStart);
  const seeded = integration.indexOf("const seeded = await seededRehearsal();");
  const rehearsal = integration.indexOf("const rehearsal = seeded.report;");
  const cleanup = integration.indexOf("await withS9OwnedSchemaCleanup(rehearsal, async (kept) => {");
  const failedChild = integration.indexOf("assertS9ChildCompleted(seeded.childCompletion);");
  assert.ok(seeded >= 0 && rehearsal > seeded && cleanup > rehearsal && failedChild > cleanup,
    "the consumer carries the report into exact schema cleanup before rejecting a failed child");
  assert.match(integration, /async \(kept\) => \{[\s\S]*?for \(const name of \[\.\.\.kept\]\.reverse\(\)/u);
});

test("S9 private output preserves a bounded exact tail and its truncation fact", () => {
  const bytes = Buffer.alloc(S9_DIAGNOSTIC_BYTES + 17, 120); bytes[bytes.length - 1] = 121;
  const result = boundedS9ChildOutput(bytes);
  assert.equal(result.originalBytes, bytes.length);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.bytes, bytes.subarray(17));
  assert.equal(result.bytes.length, S9_DIAGNOSTIC_BYTES);
  assert.deepEqual(boundedS9ChildOutput({ secret: "PRIVATE" }), { bytes: Buffer.alloc(0), originalBytes: 0, truncated: false });
});

test("S9 progress uses fixed stages, a monotonic clock, bounded numeric counters and a finite heartbeat", () => {
  let time = 0, tick, interval, cancelled = 0;
  const output = [];
  const progress = createS9Progress("producer", { now: () => time, emit: (line) => output.push(JSON.parse(line)),
    schedule: (callback, ms) => { tick = callback; interval = ms; return 7; },
    cancel: (timer) => { assert.equal(timer, 7); cancelled++; } });
  assert.equal(interval, 5_000);
  tick(); assert.equal(output.length, 0);
  progress.phase("admission");
  progress.counts({ ownerOrdinal: 2, completedChunks: 3, iteration: 10_000_001,
    completedDays: -1, scopeOrdinal: NaN, dayOrdinal: 1.5, phase: "PRIVATE", path: "/private/synthetic" });
  time = 5_000; tick();
  assert.deepEqual(output.at(-1), { event: "s9_rehearsal_progress", component: "producer", phase: "admission",
    elapsedMs: 5_000, ownerOrdinal: 2, completedChunks: 3 });
  assert.throws(() => progress.phase("PRIVATE"), /S9_PROGRESS_PHASE_INVALID/u);
  progress.phase("native_probes");
  assert.deepEqual(Object.keys(output.at(-1)), ["event", "component", "phase", "elapsedMs"]);
  time = 100_000_000; tick(); assert.equal(output.at(-1).elapsedMs, 86_400_000);
  for (let n = 0; n < 2_000; n++) tick();
  assert.equal(output.length, 1_024);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|private\/synthetic/u);
  progress.close(); progress.close(); tick();
  assert.equal(cancelled, 1); assert.equal(output.length, 1_024);
  assert.throws(() => createS9Progress("PRIVATE"), /S9_PROGRESS_COMPONENT_INVALID/u);
  const broken = createS9Progress("controller", { emit: () => { throw new Error("sink unavailable"); },
    schedule: () => 8, cancel: () => {} });
  assert.doesNotThrow(() => broken.phase("current_d1_replay")); broken.close();
});


test("current D7 reports a failed child before qualification and still cleans only verified pairs", async () => {
  const edge = await readFile(new URL("../postgres-test/edge-origin-e2e.spec.mjs", import.meta.url), "utf8");
  const helperStart = edge.indexOf("const SHA256 = /^[a-f0-9]{64}$/u;");
  const helperEnd = edge.indexOf("\nasync function readCurrentD7PrivateSidecar", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "the actual D7 ownership and failure helpers are extractable");
  const helperSource = edge.slice(helperStart, helperEnd);
  assert.ok(helperSource.includes("assertS9ChildCompleted(childCompletion);"));
  assert.ok(helperSource.includes("validateCurrentD7SchemaHandoff(report, candidates)"));
  const extracted = new Function("assert", "createHash", "basename", "S9_REHEARSAL_DEADLINE_MS",
    "ownedKeptRehearsalSchemas", "assertS9ChildCompleted", `${helperSource}
return {
  withCurrentD7OwnedSchemaCleanup, currentD7FailureDiagnostic, validateCurrentD7SchemaHandoff,
  CURRENT_D7_CONTROLLER_ERROR_CODES, CURRENT_D7_CONTROLLER_PHASES,
};`)(assert, createHash, basename, S9_REHEARSAL_DEADLINE_MS, ownedKeptRehearsalSchemas, assertS9ChildCompleted);
  const { withCurrentD7OwnedSchemaCleanup, currentD7FailureDiagnostic, CURRENT_D7_CONTROLLER_ERROR_CODES,
    CURRENT_D7_CONTROLLER_PHASES } = extracted;
  const controllerSource = await readFile(new URL("./gcp-fastpath-rehearsal.mjs", import.meta.url), "utf8");
  const sourceFailureCodes = [...new Set([
    ...[...controllerSource.matchAll(/\bfail\("([A-Z0-9_]+)"/gu)].map((match) => match[1]),
    ...[...controllerSource.matchAll(/new RehearsalError\("([A-Z0-9_]+)"/gu)].map((match) => match[1]),
    "REHEARSAL_CURRENT_D7_FAILED",
  ])].sort();
  assert.deepEqual([...CURRENT_D7_CONTROLLER_ERROR_CODES].sort(), sourceFailureCodes,
    "the TAP error-code allowlist matches only fixed controller source codes and its fixed fallback");
  const diagnosticsSource = await readFile(new URL("./s9-rehearsal-diagnostics.mjs", import.meta.url), "utf8");
  const controllerPhaseBlock = /controller:\s*\[([\s\S]*?)\]/u.exec(diagnosticsSource)?.[1];
  assert.ok(controllerPhaseBlock, "the closed S9 controller phase list is present");
  const sourceControllerPhases = [...controllerPhaseBlock.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual([...CURRENT_D7_CONTROLLER_PHASES].sort(), sourceControllerPhases,
    "the TAP phase projection matches the validated S9 controller phase contract");
  const d7RunStart = edge.indexOf("async function runCurrentD7S9(f, testContext)");
  const d7RunEnd = edge.indexOf("\ntest(CURRENT_D7", d7RunStart);
  assert.ok(d7RunStart >= 0 && d7RunEnd > d7RunStart, "the current D7 consumer is present");
  const d7Run = edge.slice(d7RunStart, d7RunEnd);
  const cleanupInvocation = d7Run.indexOf("withCurrentD7OwnedSchemaCleanup(rehearsal, seeded.childCompletion,");
  const tapDiagnostic = d7Run.indexOf("testContext.diagnostic(JSON.stringify(currentD7FailureDiagnostic(");
  assert.ok(cleanupInvocation >= 0 && tapDiagnostic > cleanupInvocation
    && d7Run.indexOf("throw error;", tapDiagnostic) > tapDiagnostic,
  "the closed TAP projection follows the cleanup wrapper and precedes the failed test outcome");
  const producerStart = edge.indexOf("async function seededRehearsal()");
  const producerEnd = edge.indexOf("\nasync function removeCurrentD7PrivateOutput", producerStart);
  const producer = edge.slice(producerStart, producerEnd);
  const validatedJournal = producer.indexOf("validateS9ProgressJournal(await readFile(progressPath), liveProgress)");
  const phaseProjection = producer.indexOf("records.toReversed()", validatedJournal);
  const returnedPhase = producer.indexOf("lastValidatedControllerPhase, temporaryOutputRemoved: false", phaseProjection);
  assert.ok(validatedJournal >= 0 && phaseProjection > validatedJournal && returnedPhase > phaseProjection,
    "only the controller phase from the validated private progress journal reaches the TAP projection");
  const caseIds = ["conflictPreserving", "conflictFreePositive"];
  const digest = "a".repeat(64);
  const makePair = (caseId, suffix) => ({ caseId,
    schema: `typed_legacy_transfer_rehearsal_target_fastpath_${suffix}`,
    controlSchema: `typed_legacy_transfer_rehearsal_ctl_${suffix}` });
  const pairs = [makePair(caseIds[0], "0123abcd"), makePair(caseIds[1], "89abcdef")];
  const cleanupNames = (selected) => selected.flatMap(({ schema, controlSchema }) => [schema, controlSchema]);
  const makeCompleteReport = () => {
    const caseReceipts = Object.fromEntries(pairs.map((pair) => [pair.caseId, {
      caseId: pair.caseId, schemaVersion: "current-q1-d7-controller-case-receipt-v1",
      referenceSha256: digest, expectationSha256: digest, corpusSha256: digest, admissionSha256: digest,
      sourceInvariantSha256: digest, pgInputSha256: digest, bootstrapPreservationSha256: digest,
      strictExportSha256: digest, actualResponseSha256: digest, actualPreviewSha256: digest,
      schema: pair.schema, controlSchema: pair.controlSchema, currentDay: "2026-10-01", retainedForS9Cleanup: true,
    }]));
    return { schemaVersion: "gcp-fastpath-current-d7-rehearsal-report-v1", comparisonMode: "current-worker-d1-d7",
      decisionId: "D7", status: "cleanup_pending", reusedSchema: false, keptSchemaPairs: pairs,
      keptSchemas: cleanupNames(pairs), currentD7Qualification: {
        schemaVersion: "current-q1-d7-controller-qualification-v1", comparisonMode: "current-worker-d1-d7",
        decisionId: "D7", caseIds, inputBindingSha256: digest, inputBindingCaptureContentSha256: digest,
        bindingSha256: digest, referenceContentSha256: digest, producerAcceptanceContentSha256: digest,
        contractContentSha256: digest, caseReceipts,
        sidecars: { inputBindingCaptureSha256: digest, referenceSha256: digest, bindingSha256: digest,
          producerAcceptanceSha256: digest, conflictPreservingCaseSha256: digest,
          conflictFreePositiveCaseSha256: digest, contractSha256: digest },
        cleanupPending: true, qualifying: false, establishesNativeExecution: false,
        deadlineMs: S9_REHEARSAL_DEADLINE_MS, elapsedMs: 1, pgInputSnapshotsRemoved: true,
      } };
  };
  const failedCompletion = (await captureS9ChildCompletion(async () => {
    throw Object.assign(new Error("PRIVATE_CANARY"), { code: 2, stdout: "PRIVATE_CANARY", stderr: "PRIVATE_CANARY" });
  })).metadata;
  const failedReport = { schemaVersion: "gcp-fastpath-current-d7-rehearsal-report-v1",
    comparisonMode: "current-worker-d1-d7", decisionId: "D7", status: "error", reusedSchema: false,
    qualifying: false, establishesNativeExecution: false, error: { code: "REHEARSAL_CURRENT_D7_CASE_INCOMPLETE" },
    keptSchemaPairs: [pairs[0], { caseId: caseIds[1], schema: "private_schema", controlSchema: "private_control" },
      { caseId: "unexpected", schema: "typed_legacy_transfer_rehearsal_target_fastpath_deadbeef",
        controlSchema: "typed_legacy_transfer_rehearsal_ctl_deadbeef" }],
    keptSchemas: [...cleanupNames(pairs), "private_schema", "private_control"],
  };
  const events = [];
  const expectedFailureCleanup = cleanupNames([pairs[0]]);
  await assert.rejects(withCurrentD7OwnedSchemaCleanup(failedReport, failedCompletion, async () => {
    events.push("work"); assert.fail("a failed controller cannot enter edge qualification");
  }, async (names) => { events.push("cleanup"); events.push(...names); }), (error) => {
    events.push("rejected");
    assert.equal(error.code, "S9_REHEARSAL_CHILD_FAILED");
    assert.equal(error.message, "S9_REHEARSAL_CHILD_FAILED");
    return true;
  });
  assert.deepEqual(events, ["cleanup", ...expectedFailureCleanup, "rejected"],
    "the child failure surfaces only after the exact independently accepted pair cleanup runs");
  const zeroPairReport = { ...failedReport,
    keptSchemaPairs: [{ caseId: "unexpected", schema: "private_schema", controlSchema: "private_control" }],
    keptSchemas: ["private_schema", "private_control"] };
  let zeroPairCleanup;
  await assert.rejects(withCurrentD7OwnedSchemaCleanup(zeroPairReport, failedCompletion,
    async () => assert.fail("unknown ownership cannot enter edge qualification"),
    async (names) => { zeroPairCleanup = names; }),
  (error) => error.code === "S9_REHEARSAL_CHILD_FAILED");
  assert.deepEqual(zeroPairCleanup, [], "unrecognized report pairs authorize no schema cleanup");
  const twoPairReport = { ...failedReport, keptSchemaPairs: pairs, keptSchemas: cleanupNames(pairs) };
  let twoPairCleanup;
  await assert.rejects(withCurrentD7OwnedSchemaCleanup(twoPairReport, failedCompletion,
    async () => assert.fail("a failed child cannot enter edge qualification"),
    async (names) => { twoPairCleanup = names; }),
  (error) => error.code === "S9_REHEARSAL_CHILD_FAILED");
  assert.deepEqual(twoPairCleanup, cleanupNames(pairs),
    "two independently valid generated pairs retain all four exact cleanup names on child failure");
  const diagnostic = currentD7FailureDiagnostic(failedReport, failedCompletion, "postgres");
  assert.deepEqual(Object.keys(diagnostic).sort(), ["schemaVersion", "controllerStatus", "controllerErrorCode", "childState",
    "childExitCode", "childSignal", "childKilled", "childCode", "deadlineMs", "deadlineElapsed",
    "lastValidatedControllerPhase"].sort(), "the TAP projection has a closed field set");
  assert.equal(diagnostic.controllerErrorCode, "REHEARSAL_CURRENT_D7_CASE_INCOMPLETE");
  assert.equal(diagnostic.lastValidatedControllerPhase, "postgres");
  assert.equal(diagnostic.childState, "failed");
  assert.equal(diagnostic.childExitCode, 2);
  assert.equal(diagnostic.deadlineMs, S9_REHEARSAL_DEADLINE_MS);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_CANARY|private_schema/u);
  const unknownCode = currentD7FailureDiagnostic({ ...failedReport, error: { code: "PRIVATE_CANARY" } },
    { ...failedCompletion, command: "LOCAL_PATH_CANARY" }, "PRIVATE_PHASE");
  assert.equal(unknownCode.controllerErrorCode, "unrecognized");
  assert.equal(unknownCode.lastValidatedControllerPhase, null);
  assert.doesNotMatch(JSON.stringify(unknownCode), /PRIVATE_CANARY|LOCAL_PATH_CANARY|PRIVATE_PHASE/u);
  const malformedError = currentD7FailureDiagnostic({ ...failedReport,
    error: { code: "REHEARSAL_CURRENT_D7_CASE_INCOMPLETE", message: "PRIVATE_CANARY" } }, failedCompletion, "postgres");
  assert.equal(malformedError.controllerErrorCode, "unavailable");
  assert.doesNotMatch(JSON.stringify(malformedError), /PRIVATE_CANARY/u);
  const sourceDefinedTimeout = currentD7FailureDiagnostic({ ...failedReport,
    error: { code: "REHEARSAL_ORIGIN_START_TIMEOUT" } }, failedCompletion, "origin");
  assert.equal(sourceDefinedTimeout.controllerErrorCode, "REHEARSAL_ORIGIN_START_TIMEOUT",
    "a fixed direct RehearsalError code is included in the finite controller projection");

  const actualRunCurrentD7S9 = new Function("assert", "seededRehearsal", "readFile", "join", "GOLDEN",
    "withCurrentD7OwnedSchemaCleanup", "CURRENT_D7_CASE_IDS", "currentD7FailureDiagnostic",
    `${d7Run}\nreturn runCurrentD7S9;`)(assert, async () => ({ report: failedReport,
      childCompletion: failedCompletion, lastValidatedControllerPhase: "postgres",
      privateOutputPath: "PRIVATE_PATH", runtime: "PRIVATE_RUNTIME", imageRuntime: "PRIVATE_IMAGE" }), async (path) => {
      assert.equal(path, "synthetic-golden/dump/usage-monitor-db.json");
      return "{\"synthetic\":true}";
    }, (...parts) => parts.join("/"), "synthetic-golden", withCurrentD7OwnedSchemaCleanup,
    caseIds, currentD7FailureDiagnostic);
  const cleanupFailure = Object.assign(new Error("PRIVATE_CLEANUP_MESSAGE"), { code: "PRIVATE_CLEANUP_CODE" });
  const actualEvents = [], tapLines = [], cleanupQueries = [];
  const fakeContext = { diagnostic(line) { actualEvents.push("diagnostic"); tapLines.push(line); } };
  const fakeFixture = { base: { async query(sql) {
    actualEvents.push("cleanup"); cleanupQueries.push(sql); throw cleanupFailure;
  } } };
  await assert.rejects(actualRunCurrentD7S9(fakeFixture, fakeContext), (error) => error === cleanupFailure,
    "the cleanup error remains the actual test failure");
  assert.deepEqual(actualEvents, ["cleanup", "diagnostic"],
    "the actual D7 catch emits its diagnostic after rejected exact cleanup");
  assert.deepEqual(cleanupQueries, [`DROP SCHEMA IF EXISTS \"${pairs[0].controlSchema}\" CASCADE`],
    "the extracted consumer attempts only the exact generated pair cleanup");
  assert.equal(tapLines.length, 1, "the fake Node test context receives one visible diagnostic");
  const visibleDiagnostic = JSON.parse(tapLines[0]);
  assert.deepEqual(visibleDiagnostic, diagnostic);
  assert.doesNotMatch(tapLines[0], /PRIVATE_CANARY|PRIVATE_PATH|PRIVATE_RUNTIME|PRIVATE_IMAGE|PRIVATE_CLEANUP|private_schema/u);

  const completed = (await captureS9ChildCompletion(async () => ({ stdout: "", stderr: "" }))).metadata;
  const completeReport = makeCompleteReport();
  const successEvents = [];
  assert.equal(await withCurrentD7OwnedSchemaCleanup(completeReport, completed, async (validated, names) => {
    successEvents.push("work");
    assert.deepEqual(validated, pairs, "completed children still pass all original qualification checks");
    assert.deepEqual(names, cleanupNames(pairs));
    return "qualified-handoff";
  }, async (names) => { successEvents.push("cleanup"); assert.deepEqual(names, cleanupNames(pairs)); }), "qualified-handoff");
  assert.deepEqual(successEvents, ["work", "cleanup"]);
  const malformedSuccess = { ...completeReport };
  delete malformedSuccess.currentD7Qualification;
  const malformedSuccessCleanup = [];
  await assert.rejects(withCurrentD7OwnedSchemaCleanup(malformedSuccess, completed,
    async () => assert.fail("a completed child still requires the full qualification handoff"),
    async (names) => malformedSuccessCleanup.push(...names)));
  assert.deepEqual(malformedSuccessCleanup, cleanupNames(pairs),
    "qualification failures after completed children still retain exact cleanup");
});

test("S9 executes exact owned-schema cleanup before a sanitized failed-child rejection", async () => {
  const report = { reusedSchema: false, schema: "typed_legacy_transfer_rehearsal_target_fastpath_0123abcd",
    keptSchemas: ["typed_legacy_transfer_rehearsal_target_fastpath_0123abcd", "typed_legacy_transfer_rehearsal_ctl_0123abcd"] };
  const completion = (await captureS9ChildCompletion(async () => { throw { code: 2, message: "PRIVATE" }; })).metadata;
  const events = [];
  await assert.rejects(withS9OwnedSchemaCleanup(report, async (kept) => {
    events.push("entered"); assert.deepEqual(kept, report.keptSchemas); assertS9ChildCompleted(completion);
  }, async (kept) => {
    for (const name of [...kept].reverse()) events.push(name);
  }), (error) => { events.push("rejected"); return error.code === "S9_REHEARSAL_CHILD_FAILED"; });
  assert.deepEqual(events, ["entered", ...report.keptSchemas.toReversed(), "rejected"]);
  for (const invalid of [{}, { ...report, reusedSchema: true }, { ...report, schema: "private_schema" },
    { ...report, keptSchemas: ["private_schema"] }, { ...report, keptSchemas: [...report.keptSchemas, report.schema] },
    { ...report, keptSchemas: [report.schema, report.schema] }, { ...report, keptSchemas: null }]) {
    let touched = false;
    await assert.rejects(withS9OwnedSchemaCleanup(invalid, async () => { touched = true; }, async () => { touched = true; }));
    assert.equal(touched, false, "unknown ownership cannot enter a work or cleanup callback");
  }
  const success = (await captureS9ChildCompletion(async () => ({ stdout: "", stderr: "" }))).metadata;
  assert.equal(await withS9OwnedSchemaCleanup(report, async () => {
    assertS9ChildCompleted(success); return "same result";
  }, async () => events.push("successful cleanup")), "same result");
  assert.equal(events.at(-1), "successful cleanup");
  assert.deepEqual(ownedKeptRehearsalSchemas({ ...report, keptSchemas: [] }), [], "pre-PG errors own no schema");
});

test("S9 live progress preserves split records and heartbeats before child completion and closes exactly", async () => {
  const stderr = new EventEmitter(), lines = [], published = [], buffered = [];
  stderr.on("data", (chunk) => buffered.push(chunk));
  const observer = observeS9ChildProgress({ stderr }, async (line) => lines.push(line),
    (line) => published.push(line));
  const value = { event: "s9_rehearsal_progress", component: "producer", phase: "settle_cache", elapsedMs: 5_000, iteration: 3 };
  const line = `${JSON.stringify(value)}\n`;
  stderr.emit("data", Buffer.from(line.slice(0, 17)));
  stderr.emit("data", Buffer.from(line.slice(17, 41)));
  stderr.emit("data", Buffer.from(line.slice(41)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines.map((text) => JSON.parse(text)), [value], "the child has not exited, yet phase evidence is retained");
  assert.deepEqual(published, [`${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(value)}\n`],
    "only the written canonical record is published to the live TAP channel");
  stderr.emit("data", line);
  const first = await observer.close(), second = await observer.close();
  assert.equal(first.records, 2); assert.equal(first.rejected, 0); assert.equal(first.preserved, true);
  assert.equal(first.bytes, lines.reduce((sum, text) => sum + Buffer.byteLength(text), 0));
  assert.deepEqual(second, first);
  stderr.emit("data", line); assert.equal(lines.length, 2);
  assert.equal(buffered.length, 5, "the observer does not consume or alter execFile's own stream");
  assert.equal(stderr.listenerCount("data"), 1, "only the diagnostic observer is detached");
});

test("S9 live progress rejects raw, private, malformed, oversized and out-of-contract values", async () => {
  const stderr = new EventEmitter(), lines = [], published = [];
  const observer = observeS9ChildProgress({ stderr }, async (line) => lines.push(line),
    (line) => published.push(line));
  const good = { event: "s9_rehearsal_progress", component: "controller", phase: "current_d1_replay", elapsedMs: 0 };
  for (const value of [{ ...good, privatePath: "/private/SENSITIVE_CANARY" }, { ...good, phase: "SENSITIVE_CANARY" },
    { ...good, component: "SENSITIVE_CANARY" }, { ...good, component: { toString: "SENSITIVE_CANARY" } },
    { ...good, elapsedMs: -1 }, { ...good, elapsedMs: 86_400_001 }, { ...good, elapsedMs: 1.5 },
    { ...good, iteration: "SENSITIVE_CANARY" }, { ...good, iteration: -1 }, { ...good, iteration: 10_000_001 },
    { ...good, iteration: 1.5 }, { ...good, event: "SENSITIVE_CANARY" }, [], null, {}]) {
    assert.doesNotThrow(() => stderr.emit("data", `${JSON.stringify(value)}\n`));
  }
  stderr.emit("data", "raw stderr /private/SENSITIVE_CANARY\nmalformed SENSITIVE_CANARY\n");
  stderr.emit("data", "SENSITIVE_CANARY".repeat(100)); stderr.emit("data", "discarded remainder\n");
  stderr.emit("data", Buffer.alloc(64 * 1024 + 1, 120)); stderr.emit("data", "\n");
  stderr.emit("data", `${JSON.stringify(good)}\n`);
  stderr.emit("data", '{"event":"SENSITIVE_CANARY"');
  const result = await observer.close();
  assert.equal(result.records, 1); assert.equal(result.preserved, true); assert.ok(result.rejected >= 19);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [good]);
  assert.deepEqual(published, [`${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(good)}\n`]);
  assert.doesNotMatch(lines.join(""), /SENSITIVE_CANARY|private/u);
  assert.throws(() => observeS9ChildProgress({}, async () => {}), /S9_PROGRESS_STREAM_INVALID/u);
});

test("S9 live progress file and record caps remain finite and write failures are explicit", async () => {
  for (const large of [false, true]) {
    const stderr = new EventEmitter(), lines = [];
    const observer = observeS9ChildProgress({ stderr }, async (line) => lines.push(line));
    const value = { event: "s9_rehearsal_progress", component: "producer", phase: "admission", elapsedMs: 0,
      ...(large ? Object.fromEntries(["iteration", "completedSteps", "scopeOrdinal", "ownerOrdinal", "dayOrdinal",
        "chunkOrdinal", "completedOwners", "completedDays", "completedChunks"].map((key) => [key, 10_000_000])) : {}) };
    for (let n = 0; n < 2_000; n++) stderr.emit("data", `${JSON.stringify(value)}\n`);
    const result = await observer.close();
    assert.ok(result.records <= 1_024 && result.bytes <= S9_DIAGNOSTIC_BYTES);
    assert.ok(result.rejected > 0); assert.equal(result.preserved, true);
    assert.equal(lines.length, result.records);
    assert.equal(result.bytes, lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
    if (!large) assert.equal(result.records, 1_024); else assert.ok(result.records < 1_024, "byte cap is exercised independently");
  }
  const stderr = new EventEmitter(); let writes = 0;
  const observer = observeS9ChildProgress({ stderr }, async () => { writes++; throw new Error("PRIVATE_WRITE_FAILURE"); });
  const line = `${JSON.stringify({ event: "s9_rehearsal_progress", component: "producer", phase: "oracle", elapsedMs: 0 })}\n`;
  stderr.emit("data", line); stderr.emit("data", line);
  const result = await observer.close(); assert.equal(result.preserved, false); assert.equal(writes, 1);
  assert.equal(result.records, 0); assert.equal(result.bytes, 0); assert.equal(result.rejected, 2);
  const partial = new EventEmitter(), retained = []; let attempts = 0;
  const prefix = observeS9ChildProgress({ stderr: partial }, async (text) => {
    if (++attempts === 2) throw new Error("PRIVATE_WRITE_FAILURE"); retained.push(text);
  });
  partial.emit("data", line); partial.emit("data", line); partial.emit("data", line);
  const prefixResult = await prefix.close();
  assert.equal(prefixResult.preserved, false); assert.equal(attempts, 2);
  assert.equal(prefixResult.records, retained.length); assert.equal(prefixResult.records, 1);
  assert.equal(prefixResult.bytes, Buffer.byteLength(retained.join(""))); assert.equal(prefixResult.rejected, 2);

  const safeJournal = [], sinkFailure = new EventEmitter();
  const bestEffort = observeS9ChildProgress({ stderr: sinkFailure },
    async (text) => safeJournal.push(text), () => { throw new Error("PRIVATE_SINK_FAILURE"); });
  sinkFailure.emit("data", line);
  const bestEffortResult = await bestEffort.close();
  assert.equal(bestEffortResult.preserved, true);
  assert.equal(bestEffortResult.records, 1);
  assert.deepEqual(safeJournal, [line], "a failed visibility sink cannot alter the private journal or qualification facts");
});


test("S9 live progress enforces monotonic clocks separately for interleaved components", async () => {
  const stderr = new EventEmitter(), lines = [];
  const observer = observeS9ChildProgress({ stderr }, async (line) => lines.push(JSON.parse(line)));
  const send = (component, elapsedMs) => stderr.emit("data", `${JSON.stringify({ event: "s9_rehearsal_progress",
    component, phase: component === "producer" ? "oracle" : "current_d1_replay", elapsedMs })}\n`);
  send("controller", 5_000); send("producer", 0); send("producer", 5_000);
  send("producer", 0); send("controller", 1_000); send("controller", 5_000); send("producer", 5_001);
  const result = await observer.close();
  assert.equal(result.records, 5); assert.equal(result.rejected, 2); assert.equal(result.preserved, true);
  assert.deepEqual(lines.map(({ component, elapsedMs }) => [component, elapsedMs]),
    [["controller", 5_000], ["producer", 0], ["producer", 5_000], ["controller", 5_000], ["producer", 5_001]]);
});


test("S9 successful cleanup preserves only a bounded exact closed progress journal", async () => {
  const values = [{ event: "s9_rehearsal_progress", component: "producer", phase: "oracle", elapsedMs: 5_000 },
    { event: "s9_rehearsal_progress", component: "controller", phase: "current_d1_replay", elapsedMs: 0 }];
  const bytes = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
  const receipt = { records: 2, bytes: bytes.length, preserved: true };
  assert.deepEqual(validateS9ProgressJournal(bytes, receipt), values);
  assert.deepEqual(validateS9ProgressJournal(Buffer.alloc(0), { records: 0, bytes: 0, preserved: true }), []);
  for (const changed of [{ ...receipt, preserved: false }, { ...receipt, records: 1 },
    { ...receipt, records: 1_025 }, { ...receipt, bytes: bytes.length + 1 }]) {
    assert.throws(() => validateS9ProgressJournal(bytes, changed));
  }
  for (const content of ["raw SENSITIVE_CANARY\n", '{"privatePath":"SENSITIVE_CANARY"}\n',
    JSON.stringify(values[0]), `${JSON.stringify(values[0])}\n${JSON.stringify({ ...values[0], elapsedMs: 0 })}\n`,
    `${JSON.stringify({ ...values[0], iteration: 10_000_001 })}\n`, "x".repeat(1_025) + "\n"]) {
    const input = Buffer.from(content), records = content.endsWith("\n") ? content.split("\n").length - 1 : 1;
    assert.throws(() => validateS9ProgressJournal(input, { records, bytes: input.length, preserved: true }));
  }
  assert.throws(() => validateS9ProgressJournal(Buffer.alloc(S9_DIAGNOSTIC_BYTES + 1),
    { records: 0, bytes: S9_DIAGNOSTIC_BYTES + 1, preserved: true }));
  const edge = await readFile(new URL("../postgres-test/edge-origin-e2e.spec.mjs", import.meta.url), "utf8");
  const producerStart = edge.indexOf("async function seededRehearsal()");
  const producerEnd = edge.indexOf("\nasync function removeCurrentD7PrivateOutput", producerStart);
  assert.ok(producerStart >= 0 && producerEnd > producerStart, "the S9 producer boundary is present");
  const producer = edge.slice(producerStart, producerEnd);
  const report = producer.indexOf('if (!CURRENT_D7) await preserve("s9-rehearsal", report);');
  const completion = producer.indexOf('await preserve("s9-child-completion",');
  const progress = producer.indexOf('await preserve("s9-progress",');
  const discard = producer.indexOf('discardDirectory = !CURRENT_D7 && completion.metadata.state === "completed" && artifactsPreserved');
  const guard = producer.indexOf("if (discardDirectory) {", discard);
  const remove = producer.indexOf('await rm(directory, { recursive: true, force: true });', guard);
  assert.ok(report >= 0 && completion > report && progress > completion && discard > progress
    && guard > discard && remove > guard,
  "report, child-completion and closed progress sidecars are preserved before completed-run directory cleanup");
  assert.match(producer,
    /discardDirectory = !CURRENT_D7 && completion.metadata.state === "completed" && artifactsPreserved\s*&& \(!CURRENT_Q1 \|\| evidence !== null\);/u,
    "directory cleanup requires a completed child, successful preservation and any required current evidence");
  const preserveStart = edge.indexOf("async function preserveS9Artifact(suffix, value) {");
  const preserveEnd = edge.indexOf("\n}", preserveStart);
  assert.ok(preserveStart >= 0 && preserveEnd > preserveStart, "the S9 artifact writer is present");
  assert.match(edge.slice(preserveStart, preserveEnd), /\{ flag: "wx", mode: 0o600 \}/u,
    "requested sidecars use exact create-only owner-private writes");
  assert.match(producer.slice(guard), /if \(discardDirectory\) \{\s*try \{\s*await rm\(directory, \{ recursive: true, force: true \}\);/u,
    "only the completed-run preservation gate can remove the producer directory");
});
