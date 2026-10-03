// Wave 1A: the Cloud Run Node host primitives (cloud-run/node-crypto-adapter.mjs)
// are byte-identical to the portable paths they replace.
//
// - SHA-256: node:crypto against WebCrypto for strings (ASCII, multi-byte,
//   lone surrogates, which both encode as U+FFFD), byte views at offsets
//   (pooled Buffer slices), ArrayBuffers and large inputs; through our
//   src/crypto.ts (host-primitives.ts mocked to the adapter, as the Cloud Run
//   build composes it) and through the adapter's vendored-crypto surface.
// - Hex: Buffer's encoder against the byte table, and the typed-id decoder
//   on the Buffer path against the kernel-4 decoder (every compressed form).
// - The esbuild alias: ESM bundles replace exactly src/host-primitives.ts
//   and the vendored crypto.ts; the registry resolver's IIFE keeps WebCrypto.
// Synthetic inputs only.
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/host-primitives", async () => {
  const adapter = await import("../cloud-run/node-crypto-adapter.mjs");
  return { hostSha256: adapter.hostSha256, hostSha256Hex: adapter.hostSha256Hex, hostBytesHex: adapter.hostBytesHex };
});

import * as adapter from "../cloud-run/node-crypto-adapter.mjs";
import { sha256, sha256Hex } from "../src/crypto";
import { hostBytesHex, hostSha256Hex } from "../src/host-primitives";
import {
  compressedFormCases,
  edgeCases,
  expectDecoderMatchesReference,
  syntheticBytes,
} from "./fixtures/typed-id-codec-cases";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const encoder = new TextEncoder();

async function webCryptoHex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inputs(): Array<string | Uint8Array> {
  const pooled = Buffer.from("x".repeat(40) + "pooled-slice-body" + "y".repeat(40));
  const backing = syntheticBytes(17, 4096);
  return [
    "",
    "a",
    "app-usagemonitor/session/v1\0token\0secret",
    JSON.stringify({ day: "2026-09-30", values: [1, 2.5, null], text: "café 中文 \u{1f600}" }),
    "lone high \ud800 surrogate",
    "lone low \udc00 surrogate",
    "\ud83d",
    "x".repeat(1 << 20),
    new Uint8Array(0),
    syntheticBytes(3, 64),
    backing.subarray(1, 1 + 333),
    backing.subarray(4095),
    pooled.subarray(40, 57),
    new Uint8Array(syntheticBytes(5, 1 << 16).buffer, 3, 1000),
  ];
}

describe("Node host primitives (Cloud Run)", () => {
  it("the mocked host-primitives module is the adapter, as the Cloud Run build composes it", () => {
    expect(hostSha256Hex).toBe(adapter.hostSha256Hex);
    expect(hostBytesHex).toBe(adapter.hostBytesHex);
  });

  it("hashes every input to WebCrypto's digest, through our crypto.ts and the vendored surface", async () => {
    for (const value of inputs()) {
      const expected = await webCryptoHex(value);
      expect(adapter.hostSha256Hex(value)).toBe(expected);
      expect(await sha256Hex(value)).toBe(expected);
      expect(await adapter.sha256Hex(value)).toBe(expected);
      const bytes = await sha256(value);
      const vendored = await adapter.sha256(value);
      for (const digest of [bytes, vendored]) {
        // A fresh, plain 32-byte array (as WebCrypto returns), never a pooled Buffer view.
        expect(Object.getPrototypeOf(digest)).toBe(Uint8Array.prototype);
        expect(digest.byteOffset).toBe(0);
        expect(digest.buffer.byteLength).toBe(32);
        expect(Buffer.from(digest).toString("hex")).toBe(expected);
      }
    }
    const buffer = syntheticBytes(9, 48).buffer;
    expect(await adapter.sha256Hex(buffer as unknown as Uint8Array)).toBe(await webCryptoHex(new Uint8Array(buffer)));
  });

  it("keeps the async contract: the digest is a promise, and a bad input is a rejection", async () => {
    expect(sha256Hex("a")).toBeInstanceOf(Promise);
    expect(adapter.sha256Hex("a")).toBeInstanceOf(Promise);
    await expect(adapter.sha256Hex(42 as unknown as string)).rejects.toThrow("SHA256_INPUT_INVALID");
    await expect(adapter.sha256({} as unknown as string)).rejects.toThrow("SHA256_INPUT_INVALID");
  });

  it("hex-encodes like the byte table, at any offset", () => {
    const table = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
    const all = Uint8Array.from({ length: 256 }, (_, byte) => byte);
    expect(adapter.hostBytesHex(all, 0, 256)).toBe(table.join(""));
    const backing = syntheticBytes(23, 512);
    for (const [offset, start, end] of [[0, 1, 17], [7, 1, 33], [100, 0, 0], [3, 5, 200]] as const) {
      const view = backing.subarray(offset, offset + 260);
      expect(adapter.hostBytesHex(view, start, end)).toBe([...view.subarray(start, end)].map((byte) => table[byte]).join(""));
    }
  });

  it("decodes typed ids on the Buffer path exactly as the kernel-4 decoder did", () => {
    expect(expectDecoderMatchesReference(compressedFormCases())).toBe(6 * 256 * 16 + 5 * 256 * 32 + 2 * 11);
    expect(expectDecoderMatchesReference(edgeCases())).toBeGreaterThan(80);
  });

  it("aliases exactly the two replaced files in ESM bundles, and nothing in the registry resolver's IIFE", async () => {
    const { build } = createRequire(join(WORKER_ROOT, "cloud-run", "package.json"))("esbuild");
    const inputsOf = async (format: "esm" | "iife") => {
      const result = await build({ entryPoints: [join(WORKER_ROOT, "src", "typed-telemetry-repository.ts")], bundle: true,
        platform: "node", format, write: false, metafile: true, logLevel: "silent", absWorkingDir: WORKER_ROOT,
        outdir: join(WORKER_ROOT, "cloud-run", "dist-spec"), external: ["pg"],
        plugins: [adapter.nodeHostAliasPlugin(WORKER_ROOT)] });
      return new Set(Object.keys(result.metafile.inputs).map((path) => relative(WORKER_ROOT, resolve(WORKER_ROOT, path))));
    };
    const esm = await inputsOf("esm");
    expect(esm.has("cloud-run/node-crypto-adapter.mjs")).toBe(true);
    expect(esm.has("src/host-primitives.ts")).toBe(false);
    expect(esm.has("src/crypto.ts")).toBe(true);
    const iife = await inputsOf("iife");
    expect(iife.has("cloud-run/node-crypto-adapter.mjs")).toBe(false);
    expect(iife.has("src/host-primitives.ts")).toBe(true);
    expect(adapter.nodeHostAliasedFiles(WORKER_ROOT).map((path) => relative(WORKER_ROOT, path))).toEqual([
      "src/host-primitives.ts", "vendor/analytics-d43c8f92/apps/worker/src/crypto.ts"]);
    expect(() => adapter.nodeHostAliasPlugin("")).toThrow("NODE_HOST_ALIAS_ROOT_INVALID");
  });
});
