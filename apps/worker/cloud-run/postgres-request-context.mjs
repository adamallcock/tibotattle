/**
 * Root-owned per-request context for the PostgreSQL route families.
 *
 * Families keep the one-argument dispatcher signature. The composition root
 * registers a frozen context on the exact Request object it is about to
 * dispatch and hands families only the read-only accessor (FC-4). A clone,
 * or a new Request with the same URL and headers, is a different key and
 * has no context, so nothing a client sends can select or forge one. The
 * WeakMap never keeps a Request alive, and the root releases each entry once
 * the dispatcher settles.
 */

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROUTE_ID = /^[a-z][a-z0-9_]{0,79}$/u;
const MAX_ADMIN_IDENTITY_KEY_LENGTH = 512;
const CONTEXT_KEYS = new Set(["requestId", "routeId", "adminIdentityKey"]);

function contextError(code) {
  return Object.assign(new TypeError(code), { code });
}

function assertRequest(request) {
  if (typeof Request !== "function" || !(request instanceof Request)) {
    throw contextError("REQUEST_CONTEXT_REQUEST_INVALID");
  }
}

function frozenContext(context) {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw contextError("REQUEST_CONTEXT_INVALID");
  }
  const prototype = Object.getPrototypeOf(context);
  if ((prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(context).length > 0
      || Object.keys(context).some((key) => !CONTEXT_KEYS.has(key))) {
    throw contextError("REQUEST_CONTEXT_INVALID");
  }
  const { requestId, routeId, adminIdentityKey } = context;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    throw contextError("REQUEST_CONTEXT_REQUEST_ID_INVALID");
  }
  if (typeof routeId !== "string" || !ROUTE_ID.test(routeId)) {
    throw contextError("REQUEST_CONTEXT_ROUTE_ID_INVALID");
  }
  if (Object.hasOwn(context, "adminIdentityKey")
      && (typeof adminIdentityKey !== "string"
        || adminIdentityKey.length === 0
        || adminIdentityKey.length > MAX_ADMIN_IDENTITY_KEY_LENGTH)) {
    throw contextError("REQUEST_CONTEXT_ADMIN_IDENTITY_INVALID");
  }
  return Object.freeze({
    requestId,
    routeId,
    ...(Object.hasOwn(context, "adminIdentityKey") ? { adminIdentityKey } : {}),
  });
}

/**
 * The root's request id for this exact Request through a context accessor
 * (FC-4), so the log line, the diagnostic row and the error body share one
 * id. Without an accessor, or for an unregistered request (a unit harness or
 * a legacy loopback mode), a fresh id is minted. The one definition both the
 * route families (postgres-family-contract.mjs requestIdFor) and the
 * PostgreSQL test dispatchers (OD-CR-6 (i)) use.
 */
export function requestIdFrom(accessor, request) {
  const context = typeof accessor === "function" ? accessor(request) : undefined;
  const requestId = context !== null && typeof context === "object" ? context.requestId : undefined;
  return typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : crypto.randomUUID();
}

/**
 * Create one store per runtime. register, release and dispatch belong to the
 * root; families receive only accessor (as deps.requestContext).
 */
export function createRequestContextStore() {
  const contexts = new WeakMap();

  /** Attach a validated, frozen context to this exact Request object. */
  function register(request, context) {
    assertRequest(request);
    const value = frozenContext(context);
    if (contexts.has(request)) throw contextError("REQUEST_CONTEXT_ALREADY_REGISTERED");
    contexts.set(request, value);
    return value;
  }

  /** Read-only: the registered context for this exact object, else undefined. */
  function accessor(request) {
    if (request === null || (typeof request !== "object" && typeof request !== "function")) {
      return undefined;
    }
    return contexts.get(request);
  }

  /** Remove this Request's context; true when one was registered. */
  function release(request) {
    if (request === null || (typeof request !== "object" && typeof request !== "function")) {
      return false;
    }
    return contexts.delete(request);
  }

  /**
   * Register the context, call dispatcher(request) with exactly that one
   * argument, and release the entry once the dispatcher settles, whether it
   * resolves or throws.
   */
  async function dispatch(request, context, dispatcher) {
    if (typeof dispatcher !== "function") throw contextError("REQUEST_CONTEXT_DISPATCHER_INVALID");
    register(request, context);
    try {
      return await dispatcher(request);
    } finally {
      release(request);
    }
  }

  return Object.freeze({ register, accessor, release, dispatch });
}
