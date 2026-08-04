import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const paceSource = appSource.match(
  /function renderWeeklyPaceForecast[\s\S]*?\n\}\n\nfunction renderWeekly\(data\)/u,
)?.[0] ?? "";

test("weekly pace forecast is an optional, allowance-scoped dashboard surface", () => {
  assert.match(paceSource, /data\?\.weekly\?\.paceForecast/u);
  assert.match(paceSource, /weekly-pace-forecast/u);
  assert.match(paceSource, /status === "available"/u);
  assert.match(paceSource, /will_reach_reset_first/u);
  assert.match(
    paceSource,
    /status === "insufficient_observations"[\s\S]*?observations === 1/u,
  );
  assert.match(paceSource, /At this pace: reaches weekly allowance/u);
  assert.match(paceSource, /weekly allowance should last to reset/u);
  assert.match(paceSource, /Pace estimate ready after one more refresh/u);
  assert.match(paceSource, /Early estimate/u);
  assert.match(
    paceSource,
    /if \(!available && !reachesResetFirst && !collectingEvidence\) return/u,
  );
  assert.match(
    paceSource,
    /forecast\.observationCount[\s\S]*?paceIntervals === null \? null : paceIntervals \+ 1/u,
  );
  assert.doesNotMatch(paceSource, /probability|tokens/iu);
});

test("weekly pace forecast styles keep the card hidden until data is usable", () => {
  assert.match(styles, /\.weekly-pace-forecast\[hidden\]\s*\{\s*display:\s*none;/u);
  assert.match(styles, /\.weekly-pace-forecast-metrics/u);
  assert.match(styles, /\.weekly-pace-forecast-metric/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-insufficient/u);
  assert.match(styles, /\.weekly-pace-forecast-early-chip/u);
  assert.match(styles, /weekly-pace-forecast/u);
});
