import { describe, expect, it } from "vitest";

import { readBoundedRequestBody } from "../src/bounded-body";

describe("readBoundedRequestBody", () => {
  it("cancels a body that becomes idle before it can occupy a shared slot indefinitely", async () => {
    let cancelled = false;
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    await expect(readBoundedRequestBody(request, 1_024, {
      maximumTotalMilliseconds: 100,
      maximumIdleMilliseconds: 5,
    })).rejects.toMatchObject({ status: 408, code: "BODY_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("keeps the existing byte ceiling and closes the source after an oversize chunk", async () => {
    let cancelled = false;
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    await expect(readBoundedRequestBody(request, 8, {
      maximumTotalMilliseconds: 100,
      maximumIdleMilliseconds: 20,
    })).rejects.toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("returns a complete bounded body without retaining a stream lock", async () => {
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body: new TextEncoder().encode("{}"),
    });

    await expect(readBoundedRequestBody(request, 8, {
      maximumTotalMilliseconds: 100,
      maximumIdleMilliseconds: 20,
    })).resolves.toEqual(new TextEncoder().encode("{}"));
  });
});
