import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const paceSource = appSource.match(
  /function renderWeeklyPaceForecast[\s\S]*?\n\}\n\nfunction renderWeekly\(data\)/u,
)?.[0] ?? "";

function sliceDeclaration(name) {
  const source = appSource.match(
    new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`, "u"),
  )?.[0];
  assert.ok(source, `${name} is declared at the top level of app.js`);
  return source;
}

function sliceConstant(name) {
  const source = appSource.match(new RegExp(`\\nconst ${name} = [^;]+;`, "u"))?.[0];
  assert.ok(source, `${name} is declared at the top level of app.js`);
  return source;
}

// The classification is pure arithmetic over numbers the payload already
// carries, so it is exercised directly rather than asserted about as text. The
// slice keeps the test bound to the shipped source: app.js is a boot script
// with no exports, and a copy of the maths here could drift from it silently.
const pace = new Function(
  "finite",
  "formatDecimal",
  `
  ${sliceConstant("PACE_ON_TRACK_LOWER_RATIO")}
  ${sliceConstant("PACE_ON_TRACK_UPPER_RATIO")}
  ${sliceConstant("PACE_CRITICAL_RATIO")}
  ${sliceConstant("PACE_AVERAGE_MINIMUM_HOURS")}
  ${sliceDeclaration("firstFiniteForecastNumber")}
  ${sliceDeclaration("weeklyPaceRates")}
  ${sliceDeclaration("weeklyPaceStanding")}
  ${sliceDeclaration("formatPaceRatio")}
  return {
    weeklyPaceRates,
    weeklyPaceStanding,
    formatPaceRatio,
    PACE_ON_TRACK_LOWER_RATIO,
    PACE_ON_TRACK_UPPER_RATIO,
    PACE_CRITICAL_RATIO,
  };
`,
)(
  (value) => (typeof value === "number" && Number.isFinite(value) ? value : null),
  (value, digits) => value.toFixed(digits),
);

test("pace standing is measured against what the window can still sustain", () => {
  // 50% left with 84 hours to run sustains 0.595pp/hour. The three readings
  // below sit either side of that rate, not either side of a fixed
  // 100%-per-seven-days rate, which is the whole point of the change.
  const under = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .3,
  });
  const on = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .6,
  });
  const over = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .9,
  });
  assert.equal(under.state, "under");
  assert.equal(on.state, "on");
  assert.equal(over.state, "over");
  assert.equal(over.critical, false);

  // The reading that prompted the change: 3% left, a day and five hours to
  // run, and a pace that empties it inside the hour. The old card called this
  // "ahead of a steady weekly pace" and rendered green.
  const emergency = pace.weeklyPaceStanding({
    remainingPercent: 3,
    hoursToReset: 29,
    pacePpPerHour: 11.3,
  });
  assert.equal(emergency.state, "over");
  assert.equal(emergency.critical, true);
  assert.ok(emergency.coveredHours < .3);
  assert.ok(emergency.dryHours > 28);
  assert.equal(emergency.sparePercent, 0);
});

test("the critical step is exactly the point where dry time exceeds covered time", () => {
  const atThreshold = pace.weeklyPaceStanding({
    remainingPercent: 40,
    hoursToReset: 100,
    // Twice the sustainable 0.4pp/hour.
    pacePpPerHour: .8,
  });
  assert.equal(atThreshold.ratio, pace.PACE_CRITICAL_RATIO);
  assert.equal(atThreshold.critical, true);
  assert.equal(atThreshold.coveredHours, 50);
  assert.equal(atThreshold.dryHours, 50);
});

test("an under-pace standing reports the allowance left over at the reset", () => {
  const standing = pace.weeklyPaceStanding({
    remainingPercent: 60,
    hoursToReset: 100,
    pacePpPerHour: .4,
  });
  assert.equal(standing.state, "under");
  // 0.4pp/hour for 100 hours spends 40 of the 60 points that are left.
  assert.equal(Math.round(standing.sparePercent), 20);
  assert.equal(standing.dryHours, 0);
  assert.equal(standing.coveredHours, 100);
});

test("pace standing refuses readings it cannot classify", () => {
  const cases = [
    { remainingPercent: null, hoursToReset: 84, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: null, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: 0, pacePpPerHour: .6 },
    { remainingPercent: 0, hoursToReset: 84, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: 84, pacePpPerHour: 0 },
    { remainingPercent: 50, hoursToReset: 84, pacePpPerHour: null },
  ];
  for (const input of cases) {
    assert.equal(pace.weeklyPaceStanding(input), null, JSON.stringify(input));
  }
});

test("the headline rate counts idle time and the active rate stays separate", () => {
  // The engine's percentagePointsPerHour is a median over intervals that
  // moved, so it measures the pace while working. Extrapolating it alone is
  // what made every forecast land earlier than it should.
  const rates = pace.weeklyPaceRates(
    { percentagePointsPerHour: 11.3, elapsedHours: 100, movementPp: 97 },
    {},
  );
  assert.equal(rates.active, 11.3);
  assert.equal(Math.round(rates.average * 100) / 100, .97);
  assert.equal(rates.headline, rates.average);
});

test("too short an observation span falls back to the active rate", () => {
  const rates = pace.weeklyPaceRates(
    { percentagePointsPerHour: 4, elapsedHours: .5, movementPp: 2 },
    {},
  );
  assert.equal(rates.average, null);
  assert.equal(rates.headline, 4);

  const noMovement = pace.weeklyPaceRates(
    { percentagePointsPerHour: 4, elapsedHours: 12, movementPp: 0 },
    {},
  );
  assert.equal(noMovement.average, null);
  assert.equal(noMovement.headline, 4);
});

test("weekly pace forecast is an optional, allowance-scoped dashboard surface", () => {
  assert.match(paceSource, /data\?\.weekly\?\.paceForecast/u);
  assert.match(paceSource, /weekly-pace-forecast/u);
  assert.match(paceSource, /status === "available"/u);
  assert.match(paceSource, /will_reach_reset_first/u);
  assert.match(
    paceSource,
    /status === "insufficient_observations"[\s\S]*?observations === 1/u,
  );
  assert.match(paceSource, /At this pace the weekly allowance runs out/u);
  assert.match(paceSource, /lasts to the reset with room to spare/u);
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

test("the standing drives the card's class and is also stated in words", () => {
  // Colour alone must never carry the reading: the chip names the state, so a
  // monochrome screen, a colour-vision difference and a screen reader all get
  // the same answer the border does.
  assert.match(paceSource, /is-over-pace/u);
  assert.match(paceSource, /is-on-pace/u);
  assert.match(paceSource, /is-under-pace/u);
  assert.match(paceSource, /is-critical/u);
  assert.match(paceSource, /weekly-pace-forecast-state-chip/u);
  assert.match(appSource, /over: "Over pace"/u);
  assert.match(appSource, /on: "On pace"/u);
  assert.match(appSource, /under: "Under pace"/u);
  // The engine's own split is no longer what colours the card, but it stays
  // readable from the DOM.
  assert.match(paceSource, /reachesResetFirst \? "is-reset-first" : ""/u);
});

test("weekly pace forecast styles map each standing to its own accent", () => {
  assert.match(styles, /\.weekly-pace-forecast\[hidden\]\s*\{\s*display:\s*none;/u);
  assert.match(styles, /\.weekly-pace-forecast-metrics/u);
  assert.match(styles, /\.weekly-pace-forecast-metric/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-insufficient/u);
  assert.match(styles, /\.weekly-pace-forecast-early-chip/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-on-pace/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-over-pace/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-over-pace\.is-critical/u);
  // Under pace keeps the calm accent; every other standing overrides it.
  assert.match(
    styles,
    /\.weekly-pace-forecast \{[\s\S]*?--pace-accent: var\(--green\);/u,
  );
  assert.match(
    styles,
    /\.weekly-pace-forecast\.is-over-pace \{[\s\S]*?--pace-accent: var\(--amber\);/u,
  );
  assert.match(
    styles,
    /\.weekly-pace-forecast\.is-over-pace\.is-critical \{[\s\S]*?--pace-accent: var\(--rust\);/u,
  );
  assert.match(styles, /\.weekly-pace-track-bar/u);
  assert.match(styles, /\.weekly-pace-track-covered/u);
  assert.match(styles, /\.weekly-pace-track-mark/u);
  // The dry remainder is hatched, not merely a paler colour.
  assert.match(styles, /repeating-linear-gradient/u);
});
