import assert from "node:assert/strict";
import test from "node:test";

import {
  safeCount,
  validSha256,
} from "../src/application/export-sources/source-validation.js";

test("validSha256 accepts only lowercase 64-character hexadecimal strings", () => {
  const valid = "0123456789abcdef".repeat(4);
  const cases = [
    ["valid", valid, true],
    ["too short", valid.slice(1), false],
    ["too long", `${valid}0`, false],
    ["uppercase", valid.slice(0, -1) + "F", false],
    ["non-hex character", valid.slice(0, -1) + "g", false],
    ["trailing newline", `${valid}\n`, false],
    ["boxed string", new String(valid), false],
    ["null", null, false],
    ["number", 0, false],
  ];

  for (const [label, value, expected] of cases) {
    assert.equal(validSha256(value), expected, label);
  }
});

test("safeCount accepts only non-negative safe integers", () => {
  const cases = [
    ["zero", 0, true],
    ["maximum safe integer", Number.MAX_SAFE_INTEGER, true],
    ["negative", -1, false],
    ["above maximum safe integer", Number.MAX_SAFE_INTEGER + 1, false],
    ["fraction", 1.5, false],
    ["NaN", Number.NaN, false],
    ["infinity", Number.POSITIVE_INFINITY, false],
    ["numeric string", "0", false],
    ["bigint", 0n, false],
    ["null", null, false],
  ];

  for (const [label, value, expected] of cases) {
    assert.equal(safeCount(value), expected, label);
  }
});
