// Process-wide runtime adapters for running d43c8f92's Worker code under Node.
// Installed once, before the oracle bundle is imported. None of them changes a
// production module; each replaces a host facility the Worker reads:
//
// - Clock: `new Date()` and `Date.now()` return a pinned instant that the
//   oracle sets explicitly (the Q-1 oracle froze Date the same way with vitest
//   fake timers). Parsing, `Date.UTC` and every explicit-argument constructor
//   are the host's.
// - Randomness: `crypto.randomUUID`, `crypto.getRandomValues` and Math.random
//   draw from one seeded SHA-256 counter stream, and SQLite's randomblob() and
//   random() on every database the sealed adapter opens draw from the same
//   stream, so a run is reproducible byte for byte. (Production draws owner
//   digests and link identifiers from randomblob in SQL triggers.)
// - workerd's `crypto.subtle.timingSafeEqual` extension, which d43c8f92's
//   src/crypto.ts calls, is provided from node:crypto.
//
// The pinned clock does not move by itself: a run sets it for seeding, for
// analysis and for each lease-expiry probe step.
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const RealDate = Date;
let pinnedMs = null;
const SQLITE_CACHE_KIB = 2 * 1024 * 1024;
const SQLITE_MMAP_BYTES = 16 * 1024 * 1024 * 1024;
let installed = false;

export function setPinnedNow(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new TypeError("DENSE_ORACLE_CLOCK_INVALID");
  pinnedMs = ms;
}
export function pinnedNow() {
  return pinnedMs;
}

function installClock() {
  function PinnedDate(...args) {
    if (!new.target) return new RealDate(pinnedMs ?? RealDate.now()).toString();
    return args.length === 0 ? Reflect.construct(RealDate, [pinnedMs ?? RealDate.now()], new.target)
      : Reflect.construct(RealDate, args, new.target);
  }
  Object.setPrototypeOf(PinnedDate, RealDate);
  PinnedDate.prototype = RealDate.prototype;
  PinnedDate.now = () => pinnedMs ?? RealDate.now();
  PinnedDate.parse = RealDate.parse;
  PinnedDate.UTC = RealDate.UTC;
  globalThis.Date = PinnedDate;
}

/** A seeded byte stream: SHA-256(seed, counter) blocks. */
function byteStream(seed) {
  let counter = 0, block = Buffer.alloc(0), offset = 0;
  const draw = { bytes: 0 };
  return {
    draw,
    fill(target) {
      for (let index = 0; index < target.length; index++) {
        if (offset >= block.length) {
          block = createHash("sha256").update(`${seed}\u0000${counter++}`).digest();
          offset = 0;
        }
        target[index] = block[offset++];
      }
      draw.bytes += target.length;
      return target;
    },
  };
}

export function installDenseOracleRuntime({ seed }) {
  if (installed) throw new Error("DENSE_ORACLE_RUNTIME_ALREADY_INSTALLED");
  if (typeof seed !== "string" || seed.length === 0) throw new TypeError("DENSE_ORACLE_SEED_INVALID");
  installed = true;
  installClock();
  const stream = byteStream(seed);
  const webcrypto = globalThis.crypto;
  webcrypto.getRandomValues = (target) => {
    if (!ArrayBuffer.isView(target) || target instanceof Float32Array || target instanceof Float64Array
      || target instanceof DataView) {
      throw new TypeError("getRandomValues requires an integer typed array");
    }
    stream.fill(new Uint8Array(target.buffer, target.byteOffset, target.byteLength));
    return target;
  };
  webcrypto.randomUUID = () => {
    const bytes = stream.fill(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  Math.random = () => {
    const bytes = stream.fill(new Uint8Array(8));
    // 53 random bits, as V8's Math.random provides.
    const high = (bytes[0] << 13) | (bytes[1] << 5) | (bytes[2] >>> 3);
    const low = (bytes[3] << 24 >>> 0) + (bytes[4] << 16) + (bytes[5] << 8) + bytes[6];
    return (high * 2 ** 32 + low) / 2 ** 53;
  };
  webcrypto.subtle.timingSafeEqual = (left, right) => {
    const view = (value) => value instanceof ArrayBuffer ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const a = view(left), b = view(right);
    if (a.byteLength !== b.byteLength) throw new TypeError("Input buffers must have the same byte length");
    return nodeTimingSafeEqual(a, b);
  };
  // The sealed adapter installs its authorizer on every database it opens,
  // after its pinned clock; register the seeded randomblob()/random() there.
  const setAuthorizer = DatabaseSync.prototype.setAuthorizer;
  DatabaseSync.prototype.setAuthorizer = function seededRandomThenAuthorizer(callback) {
    // Performance only: a large page cache, memory-mapped reads and in-memory
    // temporary b-trees change no query result, only how fast the dense
    // owner's window-wide queries run.
    this.exec(`PRAGMA cache_size=-${SQLITE_CACHE_KIB}; PRAGMA mmap_size=${SQLITE_MMAP_BYTES}; PRAGMA temp_store=MEMORY;`);
    this.function("randomblob", { deterministic: false, useBigIntArguments: true }, (length) => {
      const size = Number(length ?? 0);
      return stream.fill(new Uint8Array(Math.max(1, Number.isFinite(size) ? size : 1)));
    });
    this.function("random", { deterministic: false }, () => {
      const bytes = stream.fill(new Uint8Array(8));
      return Buffer.from(bytes).readBigInt64LE(0);
    });
    return setAuthorizer.call(this, callback);
  };
  return { randomBytesDrawn: () => stream.draw.bytes };
}
