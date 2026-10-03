/**
 * Synchronous host primitives, supplied at composition time by the bundler.
 *
 * On Cloudflare Workers (and under the Workers and analytics-v2 Vitest gates)
 * this module is what it says: every primitive is null, and callers keep
 * their portable implementations (WebCrypto's awaited digest, a byte-table
 * hex encoder). The dogfood release-guard Worker runs without nodejs_compat,
 * so nothing here may import a Node builtin.
 *
 * The Cloud Run build (cloud-run/build.mjs, nodeHostAliasPlugin in
 * cloud-run/node-host-build.mjs) replaces this module with
 * cloud-run/node-host-primitives.mjs, whose same-named exports are
 * node:crypto's synchronous SHA-256 and node:buffer's hex encoder. Both
 * produce byte-identical results to the portable paths: SHA-256 is one
 * algorithm, and a string is hashed as its WHATWG UTF-8 encoding (lone
 * surrogates as U+FFFD) on both.
 */

/** SHA-256 of `value` (a string is hashed as UTF-8) as a fresh 32-byte array. */
export type HostSha256 = (value: string | Uint8Array) => Uint8Array;
/** SHA-256 of `value` (a string is hashed as UTF-8) as 64 lowercase hex digits. */
export type HostSha256Hex = (value: string | Uint8Array) => string;
/** Lowercase hex of `bytes[start, end)`. */
export type HostBytesHex = (bytes: Uint8Array, start: number, end: number) => string;

export const hostSha256: HostSha256 | null = null;
export const hostSha256Hex: HostSha256Hex | null = null;
export const hostBytesHex: HostBytesHex | null = null;
