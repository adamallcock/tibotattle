import assert from "node:assert/strict";
import test from "node:test";

import { formatTokenTotal } from "../public/lib.js";
import {
  CHART_CLOCK_OPTIONS,
  CHART_DAY_OPTIONS,
  CHART_MONTH_OPTIONS,
  UNKNOWN_DISPLAY_VALUE,
  dateTimeFormatter,
  formatAge,
  formatApiMoney,
  formatChartTimeLabel,
  formatChartTimestamp,
  formatCount,
  formatDate,
  formatDecimal,
  formatLocal,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPp,
  formatSharePercent,
  formatSignedPp,
  formatSignedPpHours,
  formatSpanLength,
  formatTimeRemaining,
  formatTimeZoneLabel,
  formatUtcCalendarDay,
  getFormattingLocale,
  relativeTimeFormatter,
  setFormattingLocale,
  setMessageLocale,
} from "../public/ui-format.js";

test.afterEach(() => {
  setFormattingLocale("en-US");
  setMessageLocale("en-US");
});

test("shared number formatters keep missing values separate from zero", () => {
  assert.equal(formatNumber(null), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatNumber(undefined), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatNumber(0), "0");
  assert.equal(formatCount(null), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(12_345.9), "12,345");
  assert.equal(formatDecimal(12.5, 2), "12.50");
  assert.equal(formatDecimal(null, 2), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatMoney(0, 2), "$0.00");
  assert.equal(formatMoney("9007199254740993.00", 2), "$9,007,199,254,740,993.00");
  assert.equal(formatMoney(null, 2), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatApiMoney("0.001"), "<$0.01");
  assert.equal(formatApiMoney("9007199254740993.00"), "$9,007,199,254,740,993.00");
  assert.equal(formatApiMoney("0"), "$0.00");
  assert.equal(formatApiMoney(null), UNKNOWN_DISPLAY_VALUE);
});

test("percentage and percentage-point helpers preserve units and endpoints", () => {
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(100), "100%");
  assert.equal(formatPercent(0.04, 1), "<0.1%");
  assert.equal(formatPercent(99.96, 1), ">99.9%");
  assert.equal(formatSharePercent(0, 10), "0.0%");
  assert.equal(formatSharePercent(1, 0), null);
  assert.equal(formatPp(2.5), "2.5 pp");
  assert.equal(formatSignedPp(-2.5), "-2.5 pp");
  assert.equal(formatSignedPp(2.5), "+2.5 pp");
  assert.equal(formatSignedPpHours(-2.5), "-2.5 pp·h");
  assert.equal(formatSignedPpHours(2.5), "+2.5 pp·h");
  assert.equal(formatSignedPpHours(null), UNKNOWN_DISPLAY_VALUE);
});

test("shared date helpers preserve UTC day partitions and local timestamp provenance", () => {
  const value = "2026-08-14T03:04:05.000Z";
  const date = new Date(value);
  assert.equal(
    formatDate(value, {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    dateTimeFormatter({
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date),
  );
  assert.equal(
    formatUtcCalendarDay("2026-08-14"),
    dateTimeFormatter({
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date("2026-08-14T00:00:00.000Z")),
  );
  assert.equal(formatUtcCalendarDay("2026-02-30"), "Unknown");
  assert.equal(formatLocal("not-a-date"), "Unknown");
  assert.equal(
    formatChartTimestamp(value),
    `${dateTimeFormatter(CHART_DAY_OPTIONS).format(date)} · ${dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date)}`,
  );
  assert.equal(
    formatChartTimeLabel(value, { spanMs: 24 * 60 * 60 * 1_000 }),
    dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date),
  );
  assert.equal(
    formatChartTimeLabel(value, { spanMs: 400 * 24 * 60 * 60 * 1_000 }),
    dateTimeFormatter(CHART_MONTH_OPTIONS).format(date),
  );
  assert.equal(formatChartTimeLabel(null), "Unknown");
  const timeZoneParts = dateTimeFormatter({
    timeZone: "UTC",
    timeZoneName: "longGeneric",
  }).formatToParts(date);
  assert.equal(
    formatTimeZoneLabel({ timeZone: "UTC", value }),
    timeZoneParts.find((part) => part.type === "timeZoneName")?.value,
  );
});

test("relative and elapsed-time helpers use localized messages while keeping known zero", () => {
  assert.equal(formatAge(null), "Unknown age");
  assert.equal(formatAge(0), "1 minute ago");
  assert.equal(
    formatTimeRemaining("2026-01-01T00:10:00.000Z", {
      now: "2026-01-01T00:00:00.000Z",
    }),
    "10m remaining",
  );
  assert.equal(
    formatTimeRemaining("2026-01-01T00:00:00.000Z", {
      now: "2026-01-01T00:00:00.000Z",
    }),
    "Reset due or recently passed",
  );
  assert.equal(formatTimeRemaining(null), "Time remaining unavailable");
  assert.equal(formatSpanLength(0), "1 minute");
  assert.equal(formatSpanLength(null), UNKNOWN_DISPLAY_VALUE);
  assert.equal(relativeTimeFormatter({ numeric: "always" }).format(-1, "minute"), "1 minute ago");

  setFormattingLocale("es");
  setMessageLocale("zh-Hans");
  assert.equal(getFormattingLocale(), "es");
  assert.equal(formatCount(1_234), new Intl.NumberFormat("es", { maximumFractionDigits: 0 }).format(1_234));
  assert.equal(formatAge(null), "未知时间");
});

test("legacy token total formatting is complete-or-unavailable and never double counts output", () => {
  const zero = {
    inputUncachedTokens: 0,
    inputCachedTokens: 0,
    outputTextTokens: 0,
    outputReasoningTokens: 0,
    outputCombinedTokens: 99_000,
  };
  assert.equal(formatTokenTotal(zero), "0");
  assert.equal(formatTokenTotal({
    ...zero,
    inputUncachedTokens: 1_000,
    inputCachedTokens: 2_000,
    outputTextTokens: 3_000,
    outputReasoningTokens: 4_000,
  }), "10K");
  assert.equal(formatTokenTotal({ ...zero, outputReasoningTokens: undefined }), UNKNOWN_DISPLAY_VALUE);
  assert.equal(formatTokenTotal(null), UNKNOWN_DISPLAY_VALUE);
});

test("Intl formatters are reused for equivalent locale and option keys", () => {
  assert.strictEqual(
    dateTimeFormatter({ timeZone: "UTC", year: "numeric" }),
    dateTimeFormatter({ timeZone: "UTC", year: "numeric" }),
  );
  assert.strictEqual(
    relativeTimeFormatter({ numeric: "always" }),
    relativeTimeFormatter({ numeric: "always" }),
  );
});
