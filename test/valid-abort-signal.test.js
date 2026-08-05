import assert from "node:assert/strict";
import { test } from "node:test";

import { validAbortSignal } from "../src/valid-abort-signal.js";
import * as providerNormalization from "../src/providers/codex/log-normalization.js";

test("validAbortSignal accepts null", () => {
  assert.equal(validAbortSignal(null), true);
});

test("validAbortSignal accepts a real AbortSignal", () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(validAbortSignal(controller.signal), true);
});

test("validAbortSignal accepts a structural stand-in", () => {
  assert.equal(validAbortSignal({
    aborted: false,
    addEventListener() {},
  }), true);
});

test("validAbortSignal rejects malformed objects", () => {
  const malformed = [
    undefined,
    false,
    0,
    "signal",
    {},
    Object.create(null),
    { aborted: false },
    { aborted: "false", addEventListener() {} },
    { aborted: false, addEventListener: null },
    { aborted: false, addEventListener: "addEventListener" },
  ];

  for (const value of malformed) assert.equal(validAbortSignal(value), false);
});

test("provider normalization preserves validator behavior within its owner", () => {
  const values = [
    null,
    new AbortController().signal,
    { aborted: false, addEventListener() {} },
    undefined,
    {},
    { aborted: "false", addEventListener() {} },
  ];
  for (const value of values) {
    assert.equal(
      providerNormalization.validAbortSignal(value),
      validAbortSignal(value),
    );
  }
});
