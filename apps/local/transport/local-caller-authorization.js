import { randomBytes, timingSafeEqual } from "node:crypto";

export const LOCAL_CAPABILITY_HEADER = "X-TiboTattle-Local-Capability";
export const LOCAL_OPERATION_HEADER = "X-TiboTattle-Operation-Authorization";
export const LOCAL_AUTHORIZATION_PATH = "/api/local/authorization";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const OPERATION_TTL_MS = 15_000;
const MAX_PENDING_OPERATIONS = 128;

export function isLocalCapability(value) {
  return typeof value === "string" && TOKEN.test(value);
}

export function localMethodRequiresOperation(method) {
  return MUTATING_METHODS.has(method);
}

// This object stays in the owning process. HTTP/static responses never expose
// the launch secret. The header helper is solely a trusted composition port.
export function createLocalCallerAuthorization({
  capability = randomBytes(32).toString("base64url"),
  now = () => performance.now(),
} = {}) {
  if (!isLocalCapability(capability) || typeof now !== "function") {
    throw new TypeError("local authorization configuration is invalid");
  }
  const expected = Buffer.from(capability, "ascii");
  const operations = new Map();
  let active = true;
  function prune() {
    const timestamp = now();
    for (const [key, value] of operations) {
      if (timestamp >= value.expiresAt) operations.delete(key);
    }
  }
  function issue(method, path) {
    prune();
    if (!active || !localMethodRequiresOperation(method)
        || typeof path !== "string" || !/^\/api\/[A-Za-z0-9/_-]+$/u.test(path)
        || path === LOCAL_AUTHORIZATION_PATH
        || operations.size >= MAX_PENDING_OPERATIONS) return null;
    const token = randomBytes(32).toString("base64url");
    operations.set(token, { method, path, expiresAt: now() + OPERATION_TTL_MS });
    return token;
  }
  return Object.freeze({
    authorize(value) {
      return active && isLocalCapability(value)
        && timingSafeEqual(expected, Buffer.from(value, "ascii"));
    },
    issue,
    consume(value, method, path) {
      prune();
      if (!active || !isLocalCapability(value)) return false;
      const operation = operations.get(value);
      // Consume before awaiting body parsing or any side effect. Even a failed
      // request cannot replay its operation credential.
      operations.delete(value);
      return operation !== undefined && operation.method === method
        && operation.path === path && now() < operation.expiresAt;
    },
    headers({ method = "GET", path } = {}) {
      if (!active) throw new Error("local authorization is unavailable");
      const headers = { [LOCAL_CAPABILITY_HEADER]: capability };
      if (localMethodRequiresOperation(method) && path !== LOCAL_AUTHORIZATION_PATH) {
        const token = issue(method, path);
        if (token === null) throw new Error("local operation authorization is unavailable");
        headers[LOCAL_OPERATION_HEADER] = token;
      }
      return headers;
    },
    revoke() {
      active = false;
      expected.fill(0);
      operations.clear();
    },
  });
}
