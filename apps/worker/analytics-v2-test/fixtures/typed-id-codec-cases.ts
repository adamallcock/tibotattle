// Wave 1A: the typed-id codec's equivalence cases, shared by the portable
// spec (typed-id-codec.spec.ts) and the Node host spec
// (node-host-primitives.spec.ts), which runs the codec with the Cloud Run
// adapter in place of src/host-primitives.ts.
//
// referenceDecodeTypedTelemetryId is the decoder as it stood before the fast
// path (kernel 4): every tag, 0 to 11, re-encoded and compared with its input.
// The cases are synthetic byte patterns only.
import { expect } from "vitest";
import { decodeTypedTelemetryId, encodeTypedTelemetryId, TypedTelemetryError } from "../../src/typed-telemetry-codec";

/** The storage forms, by tag - 1, as the codec declares them (a copy, so a changed table fails here). */
export const TYPED_ID_FORMS = Object.freeze([
  { prefix: "", bytes: 16, uuid: true },
  { prefix: "participant:", bytes: 16, uuid: true },
  { prefix: "device:", bytes: 16, uuid: true },
  { prefix: "v1:", bytes: 16, uuid: true },
  { prefix: "contribution:", bytes: 16, uuid: true },
  { prefix: "", bytes: 32, uuid: false },
  { prefix: "event:v2:", bytes: 32, uuid: false },
  { prefix: "quota-occurrence:v1:", bytes: 32, uuid: false },
  { prefix: "account-track:v2:", bytes: 32, uuid: false },
  { prefix: "plan-era:v1:", bytes: 32, uuid: false },
  { prefix: "chunk:", bytes: 16, uuid: true },
] as const);

const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The kernel-4 decoder: decode, then re-encode and require the same bytes, for every tag. */
export function referenceDecodeTypedTelemetryId(value: Uint8Array): string {
  const invalid = (): never => { throw new TypedTelemetryError("TYPED_TELEMETRY_INVALID"); };
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > 257) invalid();
  const tag = value[0]!;
  let result: string;
  if (tag === 0) {
    try { result = strictDecoder.decode(value.subarray(1)); } catch { return invalid(); }
  } else {
    const form = TYPED_ID_FORMS[tag - 1];
    if (!form || value.byteLength !== form.bytes + 1) return invalid();
    const hex = Array.from(value.subarray(1), (byte) => byte.toString(16).padStart(2, "0")).join("");
    result = form.prefix + (form.uuid
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : hex);
  }
  const canonical = encodeTypedTelemetryId(result);
  if (canonical.length !== value.length || canonical.some((byte, index) => byte !== value[index])) invalid();
  return result;
}

/** A deterministic byte stream (xorshift32), so every run checks the same patterns. */
export function syntheticBytes(seed: number, length: number): Uint8Array {
  let state = seed >>> 0 || 0x9e3779b9;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** A tagged id of `tag` with `body`, inside a larger buffer at an odd offset (as a pooled pg Buffer slice is). */
export function taggedId(tag: number, body: Uint8Array): Uint8Array {
  const backing = new Uint8Array(body.byteLength + 1 + 11);
  backing[5] = tag;
  backing.set(body, 6);
  return backing.subarray(5, 6 + body.byteLength);
}

function decodeOutcome(decode: (value: Uint8Array) => string, value: Uint8Array): string {
  try {
    return `ok:${decode(value)}`;
  } catch (error) {
    return `error:${error instanceof TypedTelemetryError ? error.code : String(error)}`;
  }
}

/** Every case decodes exactly as the kernel-4 decoder does: the same id, or the same refusal. */
export function expectDecoderMatchesReference(cases: Iterable<Uint8Array>): number {
  let count = 0;
  for (const value of cases) {
    expect(decodeOutcome(decodeTypedTelemetryId, value)).toBe(decodeOutcome(referenceDecodeTypedTelemetryId, value));
    count += 1;
  }
  return count;
}

/** Tags 1-11: every byte value at every body position, plus synthetic and extreme bodies. */
export function* compressedFormCases(): Generator<Uint8Array> {
  for (const [index, form] of TYPED_ID_FORMS.entries()) {
    const tag = index + 1;
    yield taggedId(tag, new Uint8Array(form.bytes));
    yield taggedId(tag, new Uint8Array(form.bytes).fill(0xff));
    for (let byte = 0; byte < 256; byte += 1) {
      for (let position = 0; position < form.bytes; position += 1) {
        const body = syntheticBytes(tag * 7919 + position, form.bytes);
        body[position] = byte;
        yield taggedId(tag, body);
      }
    }
  }
}

/** Refusals and the raw tag: wrong lengths, unknown tags, and tag-0 spellings, valid and alternate. */
export function* edgeCases(): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  const raw = (text: string) => { const bytes = encoder.encode(text); const out = new Uint8Array(bytes.length + 1); out.set(bytes, 1); return out; };
  for (const [index, form] of TYPED_ID_FORMS.entries()) {
    for (const length of [0, 1, form.bytes - 1, form.bytes + 1, 16 + 32 - form.bytes, 256]) {
      yield taggedId(index + 1, syntheticBytes(length + index, length));
    }
  }
  for (const tag of [12, 13, 0x7f, 0x80, 0xff]) {
    yield taggedId(tag, syntheticBytes(tag, 16));
    yield taggedId(tag, syntheticBytes(tag, 32));
  }
  yield new Uint8Array([]);
  yield new Uint8Array([1]);
  yield new Uint8Array(258);
  // Tag 0 spellings of every compressible form are alternate spellings: refused.
  const uuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const hex64 = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  for (const form of TYPED_ID_FORMS) yield raw(form.prefix + (form.uuid ? uuid : hex64));
  // Tag 0 ids that do not compress are canonical: uppercase, unknown prefixes, other tokens.
  yield raw(uuid.toUpperCase());
  yield raw(`device:${uuid.toUpperCase()}`);
  yield raw(`session:${uuid}`);
  yield raw(`event:v3:${hex64}`);
  yield raw(hex64.slice(0, 63));
  yield raw("a");
  yield raw("x".repeat(256));
  // Tag 0 refusals: characters outside the id token, invalid UTF-8, a BOM, too long.
  yield raw("has space");
  yield raw("snowman-☃");
  yield raw("x".repeat(257));
  yield new Uint8Array([0, 0xff, 0xfe]);
  yield new Uint8Array([0, 0xc0, 0x80]);
  yield new Uint8Array([0, 0xef, 0xbb, 0xbf, 0x61]);
}
