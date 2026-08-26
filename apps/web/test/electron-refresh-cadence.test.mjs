import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

function extractRefreshLifecycleSignal() {
  const start = appSource.indexOf(
    "function signalElectronRefreshLifecycle",
  );
  const end = appSource.indexOf(
    "\n\nasync function requestRefresh",
    start,
  );
  assert.ok(start >= 0, "refresh lifecycle signal helper must exist");
  assert.ok(end > start, "refresh lifecycle signal helper must be bounded");
  return appSource.slice(start, end);
}

async function evaluateRefreshLifecycleSignal({
  bridge,
  electron = true,
  signalTimeoutMs = 25,
} = {}) {
  const context = vm.createContext({
    Promise,
    clearTimeout,
    setTimeout,
    ELECTRON_REFRESH_LIFECYCLE_SIGNAL_TIMEOUT_MS: signalTimeoutMs,
    runsInsideElectronDashboard: () => electron,
    tibotattleDesktop: bridge,
  });
  vm.runInContext(
    `${extractRefreshLifecycleSignal()}\nglobalThis.__signal = signalElectronRefreshLifecycle;`,
    context,
  );
  return context.__signal;
}

test("Electron refresh lifecycle signals preserve accepted terminal order", async () => {
  const calls = [];
  const signal = await evaluateRefreshLifecycleSignal({
    bridge: {
      async refreshStarted() {
        calls.push("refreshStarted");
        return 7;
      },
      async refreshSettled(value) {
        calls.push(["refreshSettled", value]);
      },
    },
  });

  assert.equal(await signal("refreshStarted"), 7);
  assert.equal(await signal("refreshSettled", [{ lease: 7 }]), undefined);
  assert.deepEqual(calls, ["refreshStarted", ["refreshSettled", { lease: 7 }]]);
});

test("Electron refresh lifecycle signaling is optional for old or rejecting bridges", async () => {
  const missingSignal = await evaluateRefreshLifecycleSignal();
  assert.equal(await missingSignal("refreshStarted"), null);
  assert.equal(await missingSignal("refreshSettled", [{ lease: 1 }]), null);

  const rejectingSignal = await evaluateRefreshLifecycleSignal({
    bridge: {
      async refreshStarted() {
        throw new Error("old preload");
      },
    },
  });
  assert.equal(await rejectingSignal("refreshStarted"), null);
  assert.equal(await rejectingSignal("refreshSettled", [{ lease: 1 }]), null);

  const hangingSignal = await evaluateRefreshLifecycleSignal({
    bridge: {
      refreshStarted: () => new Promise(() => {}),
    },
  });
  assert.equal(await hangingSignal("refreshStarted"), null);
});

test("late refresh-start leases are surfaced after the bridge timeout", async () => {
  let resolveStart;
  const lateLeases = [];
  const settledLeases = [];
  const signal = await evaluateRefreshLifecycleSignal({
    signalTimeoutMs: 5,
    bridge: {
      refreshStarted: () => new Promise((resolve) => {
        resolveStart = resolve;
      }),
      refreshSettled: ({ lease }) => {
        settledLeases.push(lease);
      },
    },
  });

  const pending = signal("refreshStarted", [], {
    onLateValue: (lease) => {
      lateLeases.push(lease);
      void signal("refreshSettled", [{ lease }]);
    },
  });
  assert.equal(await pending, null);
  resolveStart(11);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateLeases, [11]);
  assert.deepEqual(settledLeases, [11]);
});

test("requestRefresh signals start only after acceptance and settles only for accepted work", () => {
  const requestStart = appSource.indexOf("async function requestRefresh(");
  const refreshRequest = appSource.indexOf("await localClient.refresh();", requestStart);
  const accepted = appSource.indexOf("refreshAccepted = true;", refreshRequest);
  const started = appSource.indexOf(
    'refreshStartSignal = signalElectronRefreshLifecycle(\n        "refreshStarted",',
    accepted,
  );
  const settledGuard = appSource.indexOf(
    "if (electronRefresh && refreshAccepted)",
    started,
  );
  const settled = appSource.indexOf(
    'signalElectronRefreshLifecycle("refreshSettled", [{ lease }])',
    settledGuard,
  );

  assert.ok(requestStart >= 0, "requestRefresh must exist");
  assert.ok(refreshRequest > requestStart, "requestRefresh must issue the companion request");
  assert.ok(accepted > refreshRequest, "acceptance must follow a successful companion request");
  assert.ok(started > accepted, "refreshStarted must follow acceptance");
  assert.doesNotMatch(
    appSource.slice(accepted, started),
    /await signalElectronRefreshLifecycle\("refreshStarted"\)/u,
    "refreshStarted must not block renderer polling startup",
  );
  assert.ok(settledGuard > started, "refreshSettled must be guarded by accepted Electron work");
  assert.ok(settled > settledGuard, "refreshSettled must run from the terminal cleanup path");
});
