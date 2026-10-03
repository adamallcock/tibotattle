import { createHash, timingSafeEqual as nativeTimingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";

function asBuffer(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("TIMING_SAFE_EQUAL_BYTES_INVALID");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Native Node implementation for the shared Worker timing-safe comparison.
 * The unequal-length path still compares the supplied bytes against an equal
 * length dummy buffer before returning false, so callers do not turn the
 * length check into an early content comparison.
 */
export function nodeTimingSafeEqual(left, right) {
  const leftBytes = asBuffer(left);
  const rightBytes = asBuffer(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    nativeTimingSafeEqual(leftBytes, Buffer.alloc(leftBytes.byteLength));
    return false;
  }
  return nativeTimingSafeEqual(leftBytes, rightBytes);
}

export function installNodeTimingSafeEqual(setter) {
  if (typeof setter !== "function") throw new TypeError("TIMING_SAFE_EQUAL_SETTER_INVALID");
  setter(nodeTimingSafeEqual);
}

// Synchronous SHA-256 and hex (Wave 1A). The Cloud Run build resolves
// src/host-primitives.ts and the vendored d43c8f92 crypto.ts to this module
// (nodeHostAliasPlugin below), so both sha256Hex implementations hash here
// instead of awaiting WebCrypto through libuv's shared thread pool. The
// bytes are WebCrypto's: a string is hashed as its UTF-8 encoding, which
// Node and TextEncoder both form per WHATWG (a lone surrogate becomes
// U+FFFD), and any other input as the bytes its view covers.

function digestInput(value) {
  if (typeof value === "string" || ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("SHA256_INPUT_INVALID");
}

/** host-primitives.ts hostSha256: a fresh 32-byte Uint8Array (never a pooled Buffer view), as WebCrypto returns. */
export function hostSha256(value) {
  return new Uint8Array(createHash("sha256").update(digestInput(value)).digest());
}

/** host-primitives.ts hostSha256Hex: 64 lowercase hex digits from Buffer's encoder. */
export function hostSha256Hex(value) {
  return createHash("sha256").update(digestInput(value)).digest("hex");
}

/** host-primitives.ts hostBytesHex: lowercase hex of bytes[start, end), read in place. */
export function hostBytesHex(bytes, start, end) {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("hex");
}

/**
 * The vendored d43c8f92 crypto.ts surface the kernels import (sha256,
 * sha256Hex), with its async signature: the value is already resolved, and a
 * synchronous failure becomes a rejection, as WebCrypto's would. A vendored
 * module importing any other name from ./crypto fails the bundle (esbuild:
 * no matching export), so nothing falls back silently.
 */
export async function sha256(value) {
  return hostSha256(value);
}

export async function sha256Hex(value) {
  return hostSha256Hex(value);
}

/** The files nodeHostAliasPlugin resolves to this module (a build asserts neither remains in a bundle). */
export function nodeHostAliasedFiles(workerRoot) {
  if (typeof workerRoot !== "string" || workerRoot.length === 0) throw new TypeError("NODE_HOST_ALIAS_ROOT_INVALID");
  return Object.freeze([
    resolve(workerRoot, "src", "host-primitives.ts"),
    resolve(workerRoot, "vendor", "analytics-d43c8f92", "apps", "worker", "src", "crypto.ts"),
  ]);
}

/**
 * The esbuild plugin that composes the Node host primitives into the Cloud
 * Run bundles. Build-time only (cloud-run/build.mjs, and the kernel-registry
 * check, which must see the build's import graph); never called at run time.
 *
 * It resolves exactly the nodeHostAliasedFiles, from any importer, to this
 * module. The vendored crypto.ts stays byte-identical: it leaves the bundle,
 * and this module enters the compute closure in its place (a new kernel id).
 *
 * Only ESM output is aliased. The kernel-registry resolver bundles
 * src/analytics-v2/kernel.ts as a self-contained IIFE and evaluates it in a
 * bare vm context with WebCrypto and no `require`; there the portable
 * default stays, and it computes the same digests.
 */
export function nodeHostAliasPlugin(workerRoot) {
  const aliased = new Set(nodeHostAliasedFiles(workerRoot));
  const adapter = resolve(workerRoot, "cloud-run", "node-crypto-adapter.mjs");
  return Object.freeze({
    name: "node-host-primitives",
    setup(build) {
      if (build.initialOptions.format !== "esm") return;
      // esbuild filters are Go regular expressions: no `u` flag.
      build.onResolve({ filter: /^\.{1,2}\/(?:.*\/)?(?:host-primitives|crypto)(?:\.ts)?$/ }, (args) => {
        const target = resolve(args.resolveDir, args.path);
        return aliased.has(target.endsWith(".ts") ? target : `${target}.ts`) ? { path: adapter } : undefined;
      });
    },
  });
}
