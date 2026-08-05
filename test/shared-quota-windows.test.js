import assert from "node:assert/strict";
import test from "node:test";

import {
  FIVE_HOUR_WINDOW_MINUTES,
  isSupportedQuotaWindowDuration,
  isValidQuotaWindowDuration,
  MAX_QUOTA_WINDOW_DURATION_MINUTES,
  SEVEN_DAY_WINDOW_MINUTES,
  SUPPORTED_QUOTA_WINDOW_DURATIONS,
} from "../packages/quota-analysis/src/quota-windows.js";

test("named windows remain exact while bounded provider windows are accepted", () => {
  assert.equal(FIVE_HOUR_WINDOW_MINUTES, 300);
  assert.equal(SEVEN_DAY_WINDOW_MINUTES, 10_080);
  assert.equal(MAX_QUOTA_WINDOW_DURATION_MINUTES, 525_600);
  assert.deepEqual(
    SUPPORTED_QUOTA_WINDOW_DURATIONS,
    [FIVE_HOUR_WINDOW_MINUTES, SEVEN_DAY_WINDOW_MINUTES],
  );
  assert.equal(isSupportedQuotaWindowDuration(300), true);
  assert.equal(isSupportedQuotaWindowDuration(10_080), true);
  assert.equal(isSupportedQuotaWindowDuration(43_200), true);

  for (const duration of [1, 300, 10_080, 43_200, MAX_QUOTA_WINDOW_DURATION_MINUTES]) {
    assert.equal(isValidQuotaWindowDuration(duration), true, String(duration));
    assert.equal(isSupportedQuotaWindowDuration(duration), true, String(duration));
  }
});

test("generic quota-window validation rejects malformed and oversized durations", () => {
  for (const duration of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, 525_601]) {
    assert.equal(isValidQuotaWindowDuration(duration), false, String(duration));
    assert.equal(isSupportedQuotaWindowDuration(duration), false, String(duration));
  }
});
