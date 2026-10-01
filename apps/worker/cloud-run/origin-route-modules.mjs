/**
 * Origin route-module seam (GCP fast path, IN-1).
 *
 * A route module replaces one named built-in route of the Cloud Run origin.
 * Packages define modules with defineOriginRouteModule() and export them; the
 * composition root (server.mjs) builds one registry at startup with
 * createOriginRouteModuleRegistry() and consults it before the overridable
 * built-ins. Non-overridable built-ins keep precedence over every module.
 *
 * The seam is closed and fail-closed:
 * - a module may only replace a path in ORIGIN_OVERRIDABLE_BUILT_INS, and must
 *   say so with overridesBuiltIn: true;
 * - every pathname must be an exact route of the Worker route registry
 *   (apps/worker/src/route-registry.ts, WORKER_ROUTE_POLICY), and the method
 *   must be one the registry allows for it;
 * - any other built-in path, a non-registry pathname, a disallowed method, a
 *   duplicate method/pathname pair, or an object that did not come from
 *   defineOriginRouteModule() throws when the registry is built, so a bad
 *   registration stops the origin at startup instead of serving traffic.
 *
 * This file is plain JavaScript with no imports so node:test specs can load it
 * directly. The route policy is injected by the caller: server.mjs passes
 * WORKER_ROUTE_POLICY from ../src/route-registry.ts, and
 * origin-route-modules.check.mjs loads the same TypeScript source.
 */

/** @typedef {"GET" | "POST" | "DELETE"} OriginRouteMethod */

/**
 * The paths a registered module may replace. Each must be an exact pathname
 * in WORKER_ROUTE_POLICY; createOriginRouteModuleRegistry() re-verifies that
 * against the injected policy and origin-route-modules.check.mjs verifies it
 * against src/route-registry.ts.
 *
 * @type {readonly ["/api/v1/community/daily", "/api/v1/device/upload-authorizations"]}
 */
export const ORIGIN_OVERRIDABLE_BUILT_INS = Object.freeze([
  "/api/v1/community/daily",
  "/api/v1/device/upload-authorizations",
]);

/** @typedef {(typeof ORIGIN_OVERRIDABLE_BUILT_INS)[number]} OriginOverridableBuiltIn */

/**
 * Per-request context the origin passes to a module handler. The composition
 * root (IN-1b) fixes its fields; modules must treat unknown fields as absent.
 *
 * @typedef {Readonly<Record<string, unknown>>} OriginRouteModuleContext
 */

/**
 * @typedef {(request: Request, context: OriginRouteModuleContext) => Response | Promise<Response>} OriginRouteModuleHandler
 */

/**
 * @typedef {Readonly<{
 *   method: OriginRouteMethod,
 *   pathname: string,
 *   overridesBuiltIn: boolean,
 *   handler: OriginRouteModuleHandler,
 * }>} OriginRouteModule
 */

/**
 * The slice of a WORKER_ROUTE_POLICY entry the seam reads.
 *
 * @typedef {Readonly<{
 *   pathname: string,
 *   methods: readonly OriginRouteMethod[] | "all",
 * }>} OriginRoutePolicyEntry
 */

/**
 * @typedef {Readonly<{
 *   pathnames: readonly string[],
 *   size: number,
 *   resolve: (method: string, pathname: string) => OriginRouteModule | null,
 * }>} OriginRouteModuleRegistry
 */

const ROUTE_METHODS = Object.freeze(["GET", "POST", "DELETE"]);
const MODULE_KEYS = Object.freeze(["handler", "method", "overridesBuiltIn", "pathname"]);
const DEFINED_MODULES = new WeakSet();

function seamError(message) {
  return new Error("ORIGIN_ROUTE_MODULE_INVALID: " + message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Define one origin route module. Validates the shape only; the registry
 * validates the pathname and method against the route policy at startup.
 *
 * @param {{
 *   method: OriginRouteMethod,
 *   pathname: string,
 *   overridesBuiltIn: boolean,
 *   handler: OriginRouteModuleHandler,
 * }} definition
 * @returns {OriginRouteModule}
 */
export function defineOriginRouteModule(definition) {
  if (!isPlainObject(definition)) {
    throw seamError("a route module definition must be a plain object");
  }
  const keys = Object.keys(definition).sort();
  if (keys.length !== MODULE_KEYS.length || keys.some((key, index) => key !== MODULE_KEYS[index])) {
    throw seamError("a route module definition has exactly method, pathname, overridesBuiltIn and handler");
  }
  const { method, pathname, overridesBuiltIn, handler } = definition;
  if (!ROUTE_METHODS.includes(method)) {
    throw seamError("method must be one of " + ROUTE_METHODS.join(", "));
  }
  if (typeof pathname !== "string" || !pathname.startsWith("/api/")) {
    throw seamError("pathname must be an exact /api/ route pathname");
  }
  if (typeof overridesBuiltIn !== "boolean") {
    throw seamError("overridesBuiltIn must be a boolean");
  }
  if (typeof handler !== "function") {
    throw seamError("handler must be a function");
  }
  const routeModule = Object.freeze({ method, pathname, overridesBuiltIn, handler });
  DEFINED_MODULES.add(routeModule);
  return routeModule;
}

function indexRoutePolicy(routePolicy) {
  if (!Array.isArray(routePolicy) || routePolicy.length === 0) {
    throw seamError("routePolicy must be the non-empty WORKER_ROUTE_POLICY array");
  }
  /** @type {Map<string, readonly string[] | "all">} */
  const byPathname = new Map();
  for (const entry of routePolicy) {
    if (entry === null || typeof entry !== "object" || typeof entry.pathname !== "string"
        || (entry.methods !== "all" && !Array.isArray(entry.methods))) {
      throw seamError("routePolicy entries need a pathname and methods");
    }
    if (byPathname.has(entry.pathname)) {
      throw seamError("routePolicy repeats a pathname");
    }
    byPathname.set(entry.pathname, entry.methods);
  }
  for (const pathname of ORIGIN_OVERRIDABLE_BUILT_INS) {
    if (!byPathname.has(pathname)) {
      throw seamError("overridable built-in " + pathname + " is not in the route policy");
    }
  }
  return byPathname;
}

/**
 * Build the startup registry of origin route modules. An empty module list is
 * valid and resolves nothing, so the built-ins serve every route.
 *
 * @param {{
 *   modules: readonly OriginRouteModule[],
 *   routePolicy: readonly OriginRoutePolicyEntry[],
 * }} options
 * @returns {OriginRouteModuleRegistry}
 */
export function createOriginRouteModuleRegistry({ modules, routePolicy } = {}) {
  const policy = indexRoutePolicy(routePolicy);
  if (!Array.isArray(modules)) {
    throw seamError("modules must be an array");
  }
  /** @type {Map<string, OriginRouteModule>} */
  const byRoute = new Map();
  for (const routeModule of modules) {
    if (!DEFINED_MODULES.has(routeModule)) {
      throw seamError("register only modules returned by defineOriginRouteModule()");
    }
    const { method, pathname, overridesBuiltIn } = routeModule;
    const methods = policy.get(pathname);
    if (methods === undefined) {
      throw seamError(pathname + " is not a route in the Worker route registry");
    }
    if (!ORIGIN_OVERRIDABLE_BUILT_INS.includes(pathname)) {
      throw seamError(pathname + " is a built-in route that modules may not replace");
    }
    if (overridesBuiltIn !== true) {
      throw seamError(pathname + " replaces a built-in and must declare overridesBuiltIn: true");
    }
    if (methods !== "all" && !methods.includes(method)) {
      throw seamError(method + " is not a registry method for " + pathname);
    }
    const key = method + " " + pathname;
    if (byRoute.has(key)) {
      throw seamError("more than one module claims " + key);
    }
    byRoute.set(key, routeModule);
  }
  const pathnames = Object.freeze([...new Set([...byRoute.values()].map((entry) => entry.pathname))]);
  return Object.freeze({
    pathnames,
    size: byRoute.size,
    resolve(method, pathname) {
      if (typeof method !== "string" || typeof pathname !== "string") return null;
      return byRoute.get(method + " " + pathname) ?? null;
    },
  });
}
