import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors";
import { parseStrictJson } from "../src/strict-json";

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("expected strict JSON failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as Error).message).not.toContain("PRIVATE_CONTENT");
  }
}

describe("strict JSON trust boundary", () => {
  it("returns ordinary nested JSON without changing values", () => {
    expect(parseStrictJson(
      '{"safe":{"count":2},"rows":[true,null,"value"]}',
    )).toEqual({
      safe: { count: 2 },
      rows: [true, null, "value"],
    });
  });

  it("rejects duplicate keys at every nesting depth before JSON.parse", () => {
    expectCode(
      () => parseStrictJson(
        '{"prompt":"PRIVATE_CONTENT","prompt":"safe"}',
        "DECRYPTION_FAILED",
      ),
      "DECRYPTION_FAILED",
    );
    expectCode(
      () => parseStrictJson(
        '{"outer":{"safe":1,"safe":2}}',
        "DECRYPTION_FAILED",
      ),
      "DECRYPTION_FAILED",
    );
  });

  it("rejects comments, trailing commas, and malformed source", () => {
    for (const raw of [
      '{"safe":1,}',
      '{"safe":/* hidden */1}',
      '{"safe":',
    ]) {
      expectCode(
        () => parseStrictJson(raw, "DECRYPTION_FAILED"),
        "DECRYPTION_FAILED",
      );
    }
  });
});
