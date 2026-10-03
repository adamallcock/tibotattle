// Wave 1A: the typed-id decoder's fast path (tags 1-11 skip the re-encode
// check) decodes exactly as the kernel-4 decoder did, on the portable hex
// path (src/host-primitives.ts as Workers see it). The Node host path (the
// Cloud Run adapter's Buffer hex) runs the same cases in
// node-host-primitives.spec.ts. Synthetic byte patterns only.
import { describe, expect, it } from "vitest";
import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { hostBytesHex } from "../src/host-primitives";
import {
  compressedFormCases,
  edgeCases,
  expectDecoderMatchesReference,
  syntheticBytes,
  taggedId,
  TYPED_ID_FORMS,
} from "./fixtures/typed-id-codec-cases";

describe("typed-id codec fast path, portable hex", () => {
  it("runs without a host hex encoder", () => {
    expect(hostBytesHex).toBeNull();
  });

  it("decodes every compressed form (tags 1-11) as the re-encoding decoder did, for every byte at every position", () => {
    const cases = [...compressedFormCases()];
    expect(expectDecoderMatchesReference(cases)).toBe(6 * 256 * 16 + 5 * 256 * 32 + 2 * 11);
    // Every compressed case is canonical: it decodes, and re-encodes to its own bytes.
    for (const value of cases) {
      expect([...encodeTypedTelemetryId(decodeTypedTelemetryId(value))]).toEqual([...value]);
    }
  });

  it("refuses wrong lengths and unknown tags, and keeps tag 0's full canonical check", () => {
    expect(expectDecoderMatchesReference(edgeCases())).toBeGreaterThan(80);
    // Tag 0 holding a compressible id is an alternate spelling: TYPED_TELEMETRY_INVALID.
    for (const form of TYPED_ID_FORMS) {
      const id = form.prefix + (form.uuid ? "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" : "ab".repeat(32));
      const raw = new Uint8Array([0, ...new TextEncoder().encode(id)]);
      expect(() => decodeTypedTelemetryId(raw)).toThrow("TYPED_TELEMETRY_INVALID");
      expect(decodeTypedTelemetryId(encodeTypedTelemetryId(id))).toBe(id);
    }
    expect(decodeTypedTelemetryId(new Uint8Array([0, ...new TextEncoder().encode("device:ABC")]))).toBe("device:ABC");
    for (const length of [15, 17]) {
      expect(() => decodeTypedTelemetryId(taggedId(3, syntheticBytes(length, length)))).toThrow("TYPED_TELEMETRY_INVALID");
    }
    expect(() => decodeTypedTelemetryId(taggedId(12, syntheticBytes(1, 16)))).toThrow("TYPED_TELEMETRY_INVALID");
    expect(() => decodeTypedTelemetryId("device:x" as unknown as Uint8Array)).toThrow("TYPED_TELEMETRY_INVALID");
  });
});
