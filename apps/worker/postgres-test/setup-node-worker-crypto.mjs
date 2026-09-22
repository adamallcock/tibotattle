import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

// Cloudflare Workers exposes subtle.timingSafeEqual; Node's Web Crypto API
// does not. Keep the real Worker implementation unchanged and provide the
// equivalent primitive only for the host-side PostgreSQL route harness.
Object.defineProperty(globalThis.crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value(left, right) {
    return nodeTimingSafeEqual(Buffer.from(left), Buffer.from(right));
  },
});
