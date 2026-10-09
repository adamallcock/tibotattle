import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_AUTO_REVIEW_SEPARATE_ALLOWANCE_START_AT,
  codexUsageAllowanceTrack,
  codexModelAllowanceTrack,
} from "../src/export/index.js";

const model = "codex-auto-review";
const track = (observedAt, threadSource = "auto_review", id = model) =>
  codexUsageAllowanceTrack(id, { observedAt, threadSource });

test("auto-review allowance follows an inclusive explicit UTC event boundary", () => {
  assert.equal(CODEX_AUTO_REVIEW_SEPARATE_ALLOWANCE_START_AT, "2026-10-06T00:00:00.000Z");
  assert.equal(track("2026-10-05T23:59:59.999Z"), "primary");
  assert.equal(track("2026-10-06T00:00:00.000Z"), "separate");
  assert.equal(track("2026-10-06T00:00:00.001Z"), "separate");
  assert.equal(track("2026-10-05T23:59:59.999999999Z"), "primary");
  assert.equal(track("2026-10-06T00:00:00.000000001Z"), "separate");
  assert.equal(track("2026-10-05T20:00:00-04:00"), "separate");
  assert.equal(track("2026-10-06T00:30:00+01:00"), "primary");
  assert.equal(track(Date.parse(CODEX_AUTO_REVIEW_SEPARATE_ALLOWANCE_START_AT)), "separate");
  assert.equal(track(Date.parse(CODEX_AUTO_REVIEW_SEPARATE_ALLOWANCE_START_AT) - 1), "primary");
});

test("an alias, unproven marker or missing instant never establishes an exemption", () => {
  for (const marker of [undefined, null, "unknown", "subagent", "automation", "guardian_review", "Auto_review", "auto_review "]) {
    assert.equal(codexUsageAllowanceTrack(model, { observedAt: "2026-10-07T00:00:00Z", threadSource: marker }), "primary");
  }
  for (const at of [null, undefined, "", "2026-10-06", "2026-10-06T00:00:00", "invalid", "2026-10-06T99:00:00Z", NaN, Infinity, 8.65e15, 1.5]) {
    assert.equal(track(at), "primary", String(at));
  }
  assert.equal(codexUsageAllowanceTrack(model), "primary");
  assert.equal(codexModelAllowanceTrack(model), "primary");
});

test("explicit auto-review metadata applies independently of model, while Spark retains its own track", () => {
  for (const id of ["gpt-6.1-sol", "unknown", "unreviewed-model", null, undefined]) {
    assert.equal(codexUsageAllowanceTrack(id, {
      observedAt: "2026-10-07T00:00:00Z", threadSource: "auto_review",
    }), "separate");
    assert.equal(codexUsageAllowanceTrack(id, {
      observedAt: "2026-10-07T00:00:00Z", threadSource: "unknown",
    }), "primary");
  }
  assert.equal(track("2026-10-07T00:00:00Z", "user", "gpt-6.1-sol"), "primary");
  for (const at of [undefined, "2026-10-05T23:59:59Z", "2026-10-06T00:00:00Z"]) {
    for (const marker of [undefined, "auto_review", "user"]) {
      assert.equal(codexUsageAllowanceTrack("gpt-5.3-codex-spark", { observedAt: at, threadSource: marker }), "spark");
    }
  }
});


test("invalid calendar dates and normalized day rollover cannot exempt usage", () => {
  for (const at of [
    "2026-11-31T00:00:00Z",
    "2027-02-29T00:00:00Z",
    "2027-02-29T00:00:00+02:00",
    "2026-10-05T24:00:00Z",
    "2026-10-06T24:00:00-04:00",
    "2026-10-06T00:00:00+24:00",
  ]) assert.equal(track(at), "primary", at);
  assert.equal(track("2028-02-29T00:00:00+02:00"), "separate");
});
