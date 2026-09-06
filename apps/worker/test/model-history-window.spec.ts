import { describe, expect, it } from "vitest";
import { modelHistoryWindow } from "../src/model-history-window";

describe("historical model window", () => {
  it("keeps the current acquisition horizon and a fixed exclusive UTC end", () => {
    expect(modelHistoryWindow("2026-09-06")).toEqual({
      day: "2026-09-06", fromDay: "2026-05-29",
      observedAtCutoff: "2026-05-29T00:00:00.000Z",
      observedAtBefore: "2026-09-07T00:00:00.000Z",
      fixedNow: "2026-09-06T23:59:59.999Z",
    });
  });

  it("uses calendar boundaries across leap days and daylight-saving changes", () => {
    for (const day of ["2024-02-29", "2026-03-08", "2026-11-01", "2027-01-01"]) {
      const window = modelHistoryWindow(day);
      expect(Date.parse(window.observedAtBefore) - Date.parse(`${day}T00:00:00.000Z`)).toBe(86_400_000);
      expect(Date.parse(window.observedAtBefore) - Date.parse(window.fixedNow)).toBe(1);
      expect(Date.parse(`${day}T00:00:00.000Z`) - Date.parse(window.observedAtCutoff)).toBe(100 * 86_400_000);
    }
  });

  it.each(["", "2026-2-01", "2026-02-29", "2026-04-31", "2026-13-01", "2026-09-06T12:00:00Z", "1970-01-01"])(
    "refuses malformed or unrepresentable day %s", (day) => {
      expect(() => modelHistoryWindow(day)).toThrow(/model history/);
    },
  );
});
