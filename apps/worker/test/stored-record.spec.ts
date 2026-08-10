import { describe, expect, it } from "vitest";
import {
  MAX_STORED_RECORD_JSON_BYTES,
  parseStoredJson,
  parseStoredRecordJson,
} from "../src/stored-record";

describe("parseStoredJson", () => {
  it("decodes bounded JSON values", () => {
    expect(parseStoredJson<{ status: string }>("{\"status\":\"ok\"}"))
      .toEqual({ status: "ok" });
    expect(parseStoredJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it.each(["", "not-json"]) ("returns null for invalid JSON %j", (raw) => {
    expect(parseStoredJson(raw)).toBeNull();
  });

  it("returns null for an oversized JSON value", () => {
    const raw = JSON.stringify("x".repeat(MAX_STORED_RECORD_JSON_BYTES));
    expect(parseStoredJson(raw)).toBeNull();
  });
});

describe("parseStoredRecordJson", () => {
  it("returns JSON object records", () => {
    expect(parseStoredRecordJson('{"receivedTime":"2026-08-03T12:00:00Z"}'))
      .toEqual({ receivedTime: "2026-08-03T12:00:00Z" });
  });

  it.each([
    "",
    "not-json",
    "null",
    "[]",
    "42",
  ])("returns null for invalid stored record %j", (raw) => {
    expect(parseStoredRecordJson(raw)).toBeNull();
  });

  it("returns null for an oversized record", () => {
    const raw = JSON.stringify({ value: "x".repeat(MAX_STORED_RECORD_JSON_BYTES) });
    expect(parseStoredRecordJson(raw)).toBeNull();
  });
});
