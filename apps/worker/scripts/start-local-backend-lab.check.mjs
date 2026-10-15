import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  publishLocalCompanionBrowserBootstrap,
  startLocalCompanion,
  stopLocalCompanion,
  waitForLocalCompanion,
} from "./start-local-backend-lab.mjs";
import {
  assertOwnerErasureLifecycle,
  backendSmokeSourceArguments,
  localCompanionEnvironment,
  parseLocalBackendLabArguments,
  projectLocalBackendLabReceipt,
} from "./start-local-backend-lab-lib.mjs";

function fakeCompanion({ pipeFailure = false } = {}) {
  const child = new EventEmitter();
  const payloads = [];
  const launches = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.stdout = new PassThrough();
  const readyMessages = [];
  const pipe = new Writable({
    write(chunk, _encoding, complete) {
      payloads.push(Buffer.from(chunk));
      complete(pipeFailure ? new Error("synthetic pipe failure") : null);
    },
  });
  child.stdio = [null, null, null, null, null, pipe];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return {
    child, payloads, launches, pipe, readyMessages,
    reportReady() { readyMessages.push("ready"); },
    ready() { child.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:8891/\n"); },
    spawnProcess(command, arguments_, options) {
      launches.push({ command, arguments_, options });
      return child;
    },
  };
}

function readyCompanionResponse() {
  return {
    ok: true,
    async json() {
      return {
        status: "ready",
        capabilities: {
          localDashboard: true,
          centralServiceProxy: true,
          centralParticipantRelay: true,
        },
      };
    },
  };
}

test("laboratory companion sends a fresh capability only through FD5 and authorized health headers", async () => {
  const capabilities = [];
  for (let index = 0; index < 2; index += 1) {
    const fake = fakeCompanion();
    const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
    assert.equal(child, fake.child);
    const payload = Buffer.concat(fake.payloads).toString("ascii");
    assert.match(payload, /^[A-Za-z0-9_-]{43}\n$/u);
    const capability = payload.trimEnd();
    capabilities.push(capability);
    assert.deepEqual(fake.launches[0].options.stdio, ["inherit", "pipe", "inherit", "ignore", "ignore", "pipe"]);
    assert.equal(fake.launches[0].options.env.USAGE_MONITOR_LOCAL_AUTH_FD, "5");
    assert.equal(JSON.stringify(fake.launches).includes(capability), false);
    fake.ready();
    let requests = 0;
    await waitForLocalCompanion("http://127.0.0.1:8891", child, {
      async fetchResponse(url, options) {
        requests += 1;
        assert.equal(url, "http://127.0.0.1:8891/api/local/health");
        assert.equal(options.headers["X-TiboTattle-Local-Capability"], capability);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        return readyCompanionResponse();
      },
    });
    assert.equal(requests, 1);
    await stopLocalCompanion(child);
    assert.equal(fake.pipe.destroyed, true);
    await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8891", child), /exited before/u);
  }
  assert.notEqual(capabilities[0], capabilities[1]);
});

test("laboratory companion health cannot fall back to an unauthenticated request", async () => {
  const fake = fakeCompanion();
  let requests = 0;
  await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8891", fake.child, {
    async fetchResponse() { requests += 1; return readyCompanionResponse(); },
  }), /private launch authorization was unavailable/u);
  assert.equal(requests, 0);
  fake.pipe.destroy();
});

test("laboratory sends no capability-bearing HTTP before its child reports exact readiness", async () => {
  const fake = fakeCompanion();
  const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
  let requests = 0;
  const options = {
    async fetchResponse() { requests += 1; return readyCompanionResponse(); },
  };
  const waiting = waitForLocalCompanion("http://127.0.0.1:8891", child, options);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(requests, 0);
  await assert.rejects(publishLocalCompanionBrowserBootstrap("http://127.0.0.1:8891", child, options), /private launch authorization was unavailable/u);
  child.stdout.write("synthetic private startup text\nUSAGE_MONITOR_READY http://127.");
  assert.equal(requests, 0);
  assert.deepEqual(fake.readyMessages, []);
  child.stdout.write("0.0.1:8891/\n");
  await waiting;
  assert.equal(requests, 1);
  assert.deepEqual(fake.readyMessages, ["ready"]);
  await stopLocalCompanion(child);
});

test("laboratory fails boundedly when the trusted child omits or corrupts its readiness marker", async () => {
  for (const output of [
    "",
    "USAGE_MONITOR_READY http://127.0.0.1:8892/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:8891/?unexpected\n",
    "x".repeat(4097),
  ]) {
    const fake = fakeCompanion();
    const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
    let requests = 0;
    child.stdout.write(output);
    await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8891", child, {
      timeoutMs: 10,
      async fetchResponse() { requests += 1; return readyCompanionResponse(); },
    }));
    assert.equal(requests, 0);
    assert.deepEqual(fake.readyMessages, []);
    await stopLocalCompanion(child);
    assert.equal(fake.child.stdout.destroyed, true);
  }
});

test("laboratory companion private pipe failure stops the child without leaking transport errors", async () => {
  const fake = fakeCompanion({ pipeFailure: true });
  const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(fake.child.kills, ["SIGTERM"]);
  assert.equal(fake.pipe.destroyed, true);
  await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8891", child), (error) => {
    assert.equal(error.message, "The local companion exited before becoming ready");
    assert.equal(error.message.includes(Buffer.concat(fake.payloads).toString("ascii").trim()), false);
    return true;
  });
});

test("laboratory companion exit and cancellation discard unfinished private pipes", async () => {
  const fake = fakeCompanion();
  const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
  child.emit("error", new Error("synthetic spawn failure"));
  assert.equal(fake.pipe.destroyed, true);
  await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8891", child), /private launch authorization was unavailable/u);
  await stopLocalCompanion(child);
});

test("laboratory browser bootstrap uses an exact one-use authorized operation and reports platform availability", async () => {
  for (const available of [true, false]) {
    const fake = fakeCompanion();
    const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
    const capability = Buffer.concat(fake.payloads).toString("ascii").trim();
    const authorization = "s".repeat(43);
    fake.ready();
    const requests = [];
    const result = await publishLocalCompanionBrowserBootstrap("http://127.0.0.1:8891", child, {
      async fetchResponse(url, options) {
        requests.push({ url, options });
        return Response.json(requests.length === 1 ? { authorization } : { available });
      },
    });
    assert.equal(result, available);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "http://127.0.0.1:8891/api/local/authorization");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      method: "POST", path: "/api/local/authorization/browser-bootstrap",
    });
    assert.equal(requests[0].options.headers["X-TiboTattle-Operation-Authorization"], undefined);
    assert.equal(requests[1].url, "http://127.0.0.1:8891/api/local/authorization/browser-bootstrap");
    assert.equal(requests[1].options.body, "{}");
    assert.equal(requests[1].options.headers["X-TiboTattle-Operation-Authorization"], authorization);
    for (const { options } of requests) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Origin, "http://127.0.0.1:8891");
      assert.equal(options.headers["X-Usage-Monitor-Local"], "1");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.headers["X-TiboTattle-Local-Capability"], capability);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
    }
    await stopLocalCompanion(child);
  }
});

test("laboratory browser bootstrap refuses invalid, oversized, and failed grants with fixed private errors", async () => {
  for (const response of [
    Response.json({ authorization: "bad" }),
    Response.json({ authorization: "s".repeat(43), extra: true }),
    new Response("x".repeat(1025)),
    Response.json({ error: "synthetic private response" }, { status: 403 }),
  ]) {
    const fake = fakeCompanion();
    const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
    fake.ready();
    let requests = 0;
    await assert.rejects(publishLocalCompanionBrowserBootstrap("http://127.0.0.1:8891", child, {
      async fetchResponse() { requests += 1; return response; },
    }), { message: "The local companion browser authorization bootstrap was unavailable" });
    assert.equal(requests, 1);
    await stopLocalCompanion(child);
  }
});

test("laboratory companion authority is bound to the selected loopback origin", async () => {
  const fake = fakeCompanion();
  const child = startLocalCompanion(8891, "http://127.0.0.1:8892", "/private/lab/companion-state", fake);
  let requests = 0;
  const options = { async fetchResponse() { requests += 1; return readyCompanionResponse(); } };
  await assert.rejects(waitForLocalCompanion("http://127.0.0.1:8892", child, options), /private launch authorization was unavailable/u);
  await assert.rejects(publishLocalCompanionBrowserBootstrap("https://example.invalid", child, options), /private launch authorization was unavailable/u);
  assert.equal(requests, 0);
  await stopLocalCompanion(child);
});

function erasedLifecycle() {
  return {
    database: {
      activeParticipants: 0, deletingParticipants: 0, acceptedContributions: 0,
      canonicalRecords: 0, contributionOccurrences: 0, retainedQuarantineReferences: 0,
      activeSessions: 0, activeDevices: 0, publishedSnapshots: 0,
      suppressedSnapshots: 0, withdrawnSnapshots: 1, withdrawnSuppressedSnapshots: 1,
    },
    deletionLedger: { tombstones: 21 },
  };
}

test("owner cleanup proves prior suppression from an immutable withdrawn empty revision", () => {
  assert.deepEqual(assertOwnerErasureLifecycle(erasedLifecycle(), 0), {
    suppressionEvidence: "immutable_withdrawn_empty_snapshot",
    suppressedRevisionsWithdrawn: 1,
    publishedSnapshotsRemaining: 0,
  });
});

test("terminal owner cleanup rejects surviving data, published snapshots or missing suppression evidence", () => {
  for (const name of [
    "activeParticipants", "deletingParticipants", "acceptedContributions", "canonicalRecords",
    "contributionOccurrences", "retainedQuarantineReferences", "activeSessions", "activeDevices",
    "publishedSnapshots",
  ]) {
    const storage = erasedLifecycle();
    storage.database[name] = 1;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), new RegExp(name, "u"));
  }
  for (const invalid of [0, undefined, null, -1, 0.5, 2]) {
    const storage = erasedLifecycle();
    storage.database.withdrawnSuppressedSnapshots = invalid;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), /withdrawnSuppressedSnapshots/u);
  }
  const missingWithdrawal = erasedLifecycle();
  missingWithdrawal.database.withdrawnSnapshots = 0;
  assert.throws(() => assertOwnerErasureLifecycle(missingWithdrawal, 0), /withdrawnSnapshots/u);
  for (const tombstones of [20, 22]) {
    const storage = erasedLifecycle();
    storage.deletionLedger.tombstones = tombstones;
    assert.throws(() => assertOwnerErasureLifecycle(storage, 0), /tombstones/u);
  }
  assert.throws(() => assertOwnerErasureLifecycle(erasedLifecycle(), 1), /r2ObjectCount/u);
});

test("backend laboratory defaults to its generated content-free fixture", () => {
  const parsed = parseLocalBackendLabArguments([
    "--exit-after-receipt",
    "--port",
    "8793",
  ]);
  assert.equal(parsed.port, 8793);
  assert.equal(parsed.companionPort, 8791);
  assert.equal(parsed.exitAfterReceipt, true);
  assert.equal(parsed.startCompanion, false);
  assert.deepEqual(
    backendSmokeSourceArguments(parsed.source),
    ["--generated-content-free-fixture"],
  );
});

test("backend laboratory accepts exactly one explicit prepared contribution", () => {
  const parsed = parseLocalBackendLabArguments([
    "--file",
    "./prepared.json",
    "--state-directory",
    "./state",
  ]);
  assert.equal(parsed.source.mode, "prepared_contribution");
  assert.equal(parsed.startCompanion, true);
  assert.equal(parsed.companionPort, 8791);
  assert.deepEqual(
    backendSmokeSourceArguments(parsed.source),
    ["--file", parsed.source.contributionFile],
  );
  assert.throws(
    () => parseLocalBackendLabArguments([
      "--file",
      "./prepared.json",
      "--generated-content-free-fixture",
    ]),
    /mutually exclusive/u,
  );
  assert.throws(
    () => parseLocalBackendLabArguments(["--file", "one", "--file", "two"]),
    /Duplicate option/u,
  );
  assert.throws(
    () => parseLocalBackendLabArguments([
      "--port",
      "8792",
      "--companion-port",
      "8792",
    ]),
    /must differ/u,
  );
});

test("backend-only laboratory leaves the local companion stopped", () => {
  const parsed = parseLocalBackendLabArguments([
    "--backend-only",
    "--port",
    "8892",
    "--companion-port",
    "8891",
  ]);
  assert.equal(parsed.backendOnly, true);
  assert.equal(parsed.startCompanion, false);
});

test("backend laboratory isolates companion state from the installed app", () => {
  const environment = localCompanionEnvironment({
    environment: { EXISTING: "preserved" },
    port: 8891,
    centralOrigin: "http://127.0.0.1:8892",
    stateRoot: "/private/lab/companion-state",
  });
  assert.deepEqual(environment, {
    EXISTING: "preserved",
    USAGE_MONITOR_PORT: "8891",
    USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8892",
    USAGE_MONITOR_STATE_ROOT: "/private/lab/companion-state",
  });
  assert.throws(
    () => localCompanionEnvironment({
      port: 8891,
      centralOrigin: "http://127.0.0.1:8892",
      stateRoot: "relative-state",
    }),
    /state root must be absolute/u,
  );
});

test("real-file laboratory receipt projection excludes private locations", () => {
  const receipt = projectLocalBackendLabReceipt({
    receipt: {
      schemaVersion: "local-backend-lab-receipt-v0.4",
      status: "ready",
      smoke: { participants: 20 },
    },
    sourceMode: "prepared_contribution",
    locations: {
      stateDirectory: "/private/state",
      participantAccessFile: "/private/access",
      ownerAccessFile: "/private/owner-access",
      redeemedInvitationDirectory: "/private/invites",
      redeemedInvitationFilesRetained: 20,
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.source.mode, "prepared_contribution");
  assert.equal(receipt.cleanup.recoverableCleanupRequired, true);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("participantAccessFile"), false);
  assert.equal(serialized.includes("ownerAccessFile"), false);
  assert.equal(serialized.includes("stateDirectory"), false);
});

test("generated-fixture lab receipt identifies separate local owner authority", () => {
  const receipt = projectLocalBackendLabReceipt({
    receipt: { schemaVersion: "local-backend-lab-receipt-v0.4", status: "ready" },
    sourceMode: "generated_content_free_fixture",
    locations: {
      stateDirectory: "/private/lab", participantAccessFile: "/private/lab/access",
      ownerAccessFile: "/private/lab/owner/access", redeemedInvitationDirectory: "/private/lab/invites",
      redeemedInvitationFilesRetained: 20,
    },
  });
  assert.equal(receipt.ownerAccessFile, "/private/lab/owner/access");
  assert.equal(receipt.ownerAccessFileContainsSecret, true);
  assert.notEqual(receipt.participantAccessFile, receipt.ownerAccessFile);
  assert.equal(receipt.cleanup.automaticOnShutdown, false);
});
