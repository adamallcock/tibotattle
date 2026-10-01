import test from "node:test";
import assert from "node:assert/strict";
import {
  allowanceTankPace,
  createTankMotion,
  mountAllowanceTanks,
  createTankSlosh,
} from "../public/allowance-tanks.js";
import { drawAllowanceTank } from "../public/allowance-tank-renderer.js";

const tank = {
  remaining: "67",
  resetAt: "2000",
  forecastPool: "true",
  stale: "false",
};
const forecast = {
  tankRatio: "3.8",
  tankReset: "2000",
  tankRemaining: "67",
  hidden: false,
};

test("slosh impulses preserve surface continuity and settle without further input", () => {
  const slosh = createTankSlosh();
  assert.equal(slosh.agitation, 0);
  slosh.kick(0.15);
  assert.ok(slosh.agitation > 0, "pressure responds immediately to the impulse");
  assert.deepEqual(slosh.values, [0, 0, 0], "a click applies velocity instead of teleporting the surface");
  slosh.step(1 / 30);
  assert.ok(slosh.values.some(value => Math.abs(value) > 1));
  const before = [...slosh.values];
  slosh.kick(0.8);
  assert.deepEqual(slosh.values, before, "a second click continues the current wave");
  for (let frame = 0; frame < 240; frame++) slosh.step(1 / 30);
  assert.ok(slosh.values.every(value => Math.abs(value) < 0.01));
  assert.ok(slosh.agitation < 0.001, "flame pressure settles with the fuel");
});

test("slosh follows impact location and stays bounded under repeated taps", () => {
  const left = createTankSlosh(), right = createTankSlosh(), center = createTankSlosh();
  left.kick(0); right.kick(1); center.kick(0.5);
  for (const slosh of [left, right, center]) slosh.step(0.1);
  assert.ok(Math.abs(left.values[0] + right.values[0]) < 1e-10);
  assert.ok(Math.abs(center.values[0]) < 1e-10);
  assert.ok(Math.abs(center.values[1]) > 1, "a central tap makes a symmetric ripple");
  for (let frame = 0; frame < 1000; frame++) {
    center.kick((frame % 11) / 10);
    center.step(1 / 30);
    assert.ok(center.agitation >= 0 && center.agitation <= 1);
    center.values.forEach((value, index) => assert.ok(Math.abs(value) <= 120 / [6, 10, 14][index]));
  }
});

test("slosh decay is independent of frame partitioning", () => {
  const coarse = createTankSlosh(), fine = createTankSlosh();
  coarse.kick(0.3); fine.kick(0.3);
  coarse.step(1);
  for (let frame = 0; frame < 60; frame++) fine.step(1 / 60);
  coarse.values.forEach((value, index) => assert.ok(Math.abs(value - fine.values[index]) < 1e-10));
});
test("forecast pace requires fresh matching evidence and never borrows another pool's pace", () => {
  assert.equal(allowanceTankPace(tank, forecast, 1000), 3.8);
  for (const change of [
    { forecastPool: "false" },
    { stale: "true" },
    { remaining: "" },
    { remaining: "0" },
    { remaining: "68" },
    { resetAt: "3000" },
  ]) {
    assert.equal(
      allowanceTankPace({ ...tank, ...change }, forecast, 1000),
      null,
    );
  }
  for (const change of [
    { hidden: true },
    { tankRatio: "" },
    { tankRatio: "NaN" },
    { tankRatio: "Infinity" },
    { tankRatio: "-1" },
    { tankReset: "" },
  ]) {
    assert.equal(
      allowanceTankPace(tank, { ...forecast, ...change }, 1000),
      null,
    );
  }
  assert.equal(allowanceTankPace(tank, forecast, 2000), null);
  assert.equal(allowanceTankPace(tank, null, 1000), null);
});
test("single bounded frame loop sleeps when inactive and cannot restart after disposal", () => {
  let active = true,
    id = 0;
  const pending = new Map(),
    draws = [];
  const motion = createTankMotion({
    request: (cb) => {
      pending.set(++id, cb);
      return id;
    },
    cancel: (key) => pending.delete(key),
    active: () => active,
    draw: (...args) => draws.push(args),
  });
  const advance = (stamp) => {
    const [key, callback] = pending.entries().next().value;
    pending.delete(key);
    callback(stamp);
  };
  motion.sync();
  motion.sync();
  assert.equal(pending.size, 1);
  advance(0);
  advance(16);
  advance(34);
  assert.equal(draws.length, 2);
  assert.equal(pending.size, 1);
  active = false;
  motion.sync();
  assert.equal(pending.size, 0);
  active = true;
  motion.sync();
  advance(10000);
  assert.equal(
    draws.at(-1)[0],
    draws.at(-2)[0],
    "hidden time does not advance the simulation",
  );
  motion.dispose();
  assert.equal(pending.size, 0);
  motion.sync();
  assert.equal(pending.size, 0);
});
test("renderer keeps observed capacity fixed, handles empty/full and bounded extremes", () => {
  let calls = 0;
  const gradient = { addColorStop() {} };
  const context = new Proxy(
    {},
    {
      get(target, key) {
        if (key.startsWith("create")) return () => gradient;
        return (...args) => {
          calls++;
          for (const value of args)
            if (typeof value === "number") assert.ok(Number.isFinite(value));
        };
      },
      set() {
        return true;
      },
    },
  );
  const canvas = { getContext: () => context };
  const colors = Object.fromEntries(
    [
      "bg",
      "panel",
      "ink",
      "muted",
      "edge",
      "metal",
      "bright",
      "shadow",
      "fluid",
      "glow",
      "deep",
    ].map((key) => [key, "rgb(100, 150, 120)"]),
  );
  for (const remaining of [0, 1, 67, 100])
    for (const pace of [null, 0.6, 1, 1.5, 3.8, 10000]) {
      const options = { remaining, pace, colors, width: 196, time: 12, dpr: 2 };
      assert.equal(drawAllowanceTank(canvas, options), true);
      assert.equal(options.remaining, remaining);
    }
  assert.ok(calls > 0);
  assert.equal(
    drawAllowanceTank({ getContext: () => null }, { remaining: 67 }),
    false,
  );
});

test("short windows use sixty percent vessel width without changing height or observed capacity", () => {
  const rectangles = [];
  const context = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "roundRect") return (...args) => rectangles.push(args);
        if (key.startsWith("create")) return () => ({ addColorStop() {} });
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  const colors = Object.fromEntries(
    [
      "bg",
      "panel",
      "ink",
      "muted",
      "edge",
      "metal",
      "bright",
      "shadow",
      "fluid",
      "glow",
      "deep",
    ].map((key) => [key, "rgb(100, 150, 120)"]),
  );
  const options = { remaining: 67, pace: null, width: 300, colors };
  drawAllowanceTank({ getContext: () => context }, options);
  const standard = rectangles[0];
  rectangles.length = 0;
  drawAllowanceTank(
    { getContext: () => context },
    { ...options, widthScale: 0.6 },
  );
  assert.equal(rectangles[0][2], standard[2] * 0.6);
  assert.equal(rectangles[0][3], standard[3]);
  assert.equal(options.remaining, 67);
});


// A deliberately small DOM/scheduler harness exercises lifecycle behavior without
// coupling it to the canvas painter or starting real wall-clock timers.
function mountedTanks(datasets, { reducedMotion = false, forecastData = forecast } = {}) {
  const timers = new Map(), frames = new Map();
  let sequence = 0, intersections;
  class Element {
    constructor() {
      this.dataset = {}; this.children = []; this.attributes = {}; this.events = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = { add() {}, remove() {} };
    }
    append(child) { child.parent = this; this.children.push(child); }
    insertBefore(child) { this.append(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, callback) { this.events[key] = callback; }
    removeEventListener(key) { delete this.events[key]; }
    querySelector() { return this.header; }
    getContext() { return {}; }
  }
  const view = {
    matchMedia: query => ({ matches: query.includes("reduced") && reducedMotion,
      addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ color: "rgb(100, 150, 120)" }),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout: id => timers.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback) { intersections = callback; }
      observe() {} disconnect() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  const doc = { defaultView: view, hidden: false, documentElement: new Element(),
    createElement: () => new Element(), addEventListener() {}, removeEventListener() {} };
  const cards = datasets.map(dataset => {
    const card = new Element(); card.dataset = { ...dataset }; card.header = new Element(); return card;
  });
  const container = new Element();
  container.ownerDocument = doc; container.isConnected = true;
  container.querySelectorAll = () => cards;
  container.header = cards[0]?.header;
  const panel = new Element(); panel.dataset = { ...forecastData }; panel.hidden = forecastData.hidden;
  panel.header = new Element();
  const manager = mountAllowanceTanks(container, panel, { t: key => key });
  return { manager, cards, panel, frames, timers,
    controls: panel.header.children[0],
    showForecast: () => intersections([{ target: panel, isIntersecting: true }]),
  };
}

test("motion control is hidden when all tanks are stale or empty, or reduced motion is enabled", () => {
  for (const datasets of [
    [{ ...tank, stale: "true" }],
    [{ ...tank, remaining: "0" }],
    [{ ...tank, stale: "true" }, { ...tank, remaining: "0" }],
  ]) {
    const h = mountedTanks(datasets);
    assert.equal(h.controls.hidden, true);
    assert.equal(h.frames.size, 0);
    assert.equal(h.panel.dataset.motion, "paused");
    h.manager.dispose();
  }
  const fresh = mountedTanks([{ ...tank, resetAt: String(Date.now() + 10000) }]);
  assert.equal(fresh.controls.hidden, false, "fresh liquid can slosh even without a usable flow estimate");
  fresh.manager.dispose();
  const reduced = mountedTanks([tank], { reducedMotion: true });
  assert.equal(reduced.controls.hidden, true);
  reduced.manager.dispose();
});

test("forecast motion expires while tanks are offscreen and its cleanup cancels the expiry timer", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const h = mountedTanks([tank]);
  h.showForecast();
  assert.equal(h.panel.dataset.motion, "running");
  assert.equal(h.frames.size, 0, "offscreen tanks do not keep a frame loop alive");
  assert.equal(h.timers.size, 1);
  const [id, scheduled] = h.timers.entries().next().value;
  assert.equal(scheduled.delay, 1000);
  context.mock.timers.tick(1000);
  h.timers.delete(id);
  scheduled.callback();
  assert.equal(h.panel.dataset.motion, "paused", "CSS flow stops at reset without another render or visibility event");
  assert.equal(h.cards[0].dataset.flow, "unknown");
  assert.equal(h.timers.size, 0);
  h.manager.dispose();
  const pending = mountedTanks([{ ...tank, resetAt: "3000" }], {
    forecastData: { ...forecast, tankReset: "3000" },
  });
  assert.equal(pending.timers.size, 1);
  pending.manager.dispose();
  assert.equal(pending.timers.size, 0, "remount/disposal never retains an old forecast timer");
});

test("tank glow reaches transparency before the canvas edge", () => {
  let halo = null;
  let painted = null;
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createRadialGradient") return (...bounds) => {
        halo = { bounds, addColorStop() {} };
        return halo;
      };
      if (key === "createLinearGradient") return () => gradient;
      if (key === "fillRect") return (...rect) => {
        if (target.fillStyle === halo) painted = rect;
      };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const colors = Object.fromEntries(
    ["bg", "panel", "ink", "muted", "edge", "metal", "bright", "shadow", "fluid", "glow", "deep"]
      .map((key) => [key, "rgb(100, 150, 120)"]),
  );
  drawAllowanceTank({ getContext: () => context }, { remaining: 55, pace: 2, colors, width: 300 });
  const [,, , centerX, centerY, radius] = halo.bounds;
  const [x, y, width, height] = painted;
  assert.ok(x <= centerX - radius && x + width >= centerX + radius);
  assert.ok(y <= centerY - radius && y + height >= centerY + radius);
  assert.ok(x >= 0 && x + width <= 300, "the glow is transparent before the canvas edge");
});

test("unknown forecast shares the gentle idle visual without changing forecast admission", () => {
  const trace = (pace, flowEnabled = true, agitation = 0) => {
    const calls = [];
    const gradient = { addColorStop: (...args) => calls.push(["colorStop", ...args]) };
    const context = new Proxy({}, {
      get(_target, key) {
        return (...args) => {
          calls.push([key, ...args]);
          if (key.startsWith("create")) return gradient;
        };
      },
      set(_target, key, value) { calls.push([key, value]); return true; },
    });
    const colors = Object.fromEntries(
      ["bg", "panel", "ink", "muted", "edge", "metal", "bright", "shadow", "fluid", "glow", "deep"]
        .map(key => [key, "rgb(100, 150, 120)"]),
    );
    drawAllowanceTank({ getContext: () => context }, {
      remaining: 55, pace, flowEnabled, agitation, width: 300, height: 278, time: 3, colors,
    });
    return JSON.stringify(calls);
  };
  assert.equal(trace(null), trace(0.55));
  assert.notEqual(trace(0.55, true, 1), trace(0.55), "interaction changes the live plume");
  assert.equal(trace(null, false, 1), trace(null, false), "interaction cannot ignite disabled flow");
  assert.notEqual(trace(null, false), trace(null), "stale or expired evidence suppresses the idle plume");
  assert.equal(allowanceTankPace(tank, null, 1000), null, "idle artwork does not manufacture a pace estimate");
});
