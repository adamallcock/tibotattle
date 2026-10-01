import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDashboardReportPreloader } from "../public/dashboard-report-preload.js";

function harness(reports) {
  const timers = new Map(), listeners = new Map();
  let nextId = 0;
  const documentRef = {
    visibilityState: "visible",
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
  };
  const windowRef = {
    setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const controller = createDashboardReportPreloader({ reports, documentRef, windowRef });
  return {
    controller, timers, listeners,
    visibility(value) { documentRef.visibilityState = value; listeners.get("visibilitychange")?.(); },
    async run() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      assert.equal(timer.delay, 250);
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test("report preparation waits for primary readiness, yields first paint, and coalesces notifications", async () => {
  const calls = [];
  const h = harness(["projects", "performance"].map(id => ({ preload: () => calls.push(id) })));
  assert.equal(h.timers.size, 0, "mounting the coordinator must not start background reports");
  h.controller.schedule(); h.controller.schedule();
  assert.equal(calls.length, 0, "primary rendering is never blocked by report calls");
  assert.equal(h.timers.size, 1);
  await h.run();
  assert.deepEqual(calls, ["projects", "performance"]);
  h.controller.destroy();
});

test("hidden startup defers reports and foreground resume restarts canceled preparation", async () => {
  let calls = 0;
  const h = harness([{ preload: () => calls++ }]);
  h.visibility("hidden"); h.controller.schedule();
  assert.equal(h.timers.size, 0);
  h.visibility("visible");
  assert.equal(h.timers.size, 1);
  h.visibility("hidden");
  assert.equal(h.timers.size, 0, "hiding before the deferred callback cancels it");
  h.visibility("visible"); await h.run();
  h.visibility("hidden"); h.visibility("visible"); await h.run();
  assert.equal(calls, 2, "reports receive an idempotent resume opportunity");
  h.controller.destroy();
});

test("one report failure cannot prevent its sibling from preparing", async () => {
  let calls = 0;
  const h = harness([{ preload() { throw new Error("unavailable"); } }, { preload: () => calls++ }]);
  h.controller.schedule(); await h.run();
  assert.equal(calls, 1);
  h.controller.destroy();
});

test("teardown fences queued work and removes the visibility listener", () => {
  let calls = 0;
  const h = harness([{ preload: () => calls++ }]);
  h.controller.schedule();
  const callback = [...h.timers.values()][0].callback;
  h.controller.destroy(); callback();
  h.controller.schedule(); h.visibility("visible");
  assert.equal(calls, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test("both real dashboard success paths schedule mounted reports after rendering", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const start of ["async function loadLocalDashboard()", "async function loadQuickResultDashboard()"]) {
    const offset = source.indexOf(start);
    assert.ok(offset >= 0);
    const tail = source.slice(offset + start.length);
    const next = tail.search(/\n(?:async )?function /u);
    assert.ok(next >= 0);
    const body = source.slice(offset, offset + start.length + next);
    assert.match(body, /renderDashboard\(data\);[\s\S]*?dashboardReportPreloader\.schedule\(\);/);
  }
  assert.match(source, /reports: \[workUsageView, modelPerformance\]/);
});
