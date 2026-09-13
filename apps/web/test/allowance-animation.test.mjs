import test from "node:test";
import assert from "node:assert/strict";
import {
  allowanceTankPace,
  createTankMotion,
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
test("flow requires a fresh, matching forecast and never borrows another pool's pace", () => {
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

test("short windows use forty percent vessel width without changing height or observed capacity", () => {
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
    { ...options, widthScale: 0.4 },
  );
  assert.equal(rectangles[0][2], standard[2] * 0.4);
  assert.equal(rectangles[0][3], standard[3]);
  assert.equal(options.remaining, 67);
});
