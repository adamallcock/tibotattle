import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite's ?raw query hands the ratchet the unchanged index.ts text. It is left
// untyped here on purpose: a program-wide `vite/client` reference would give
// src/** Vite-only ambient types (import.meta.env, import.meta.glob, asset
// modules) that the deployed Worker bundle does not provide.
// @ts-expect-error -- test-only Vite ?raw import, checked by rawText below.
import rawIndexSource from "../src/index.ts?raw";
import {
  EDGE_ADMISSION_BINDINGS,
  EDGE_ADMISSION_POLICY,
  edgeAdmissionPolicyFor,
  evaluateEdgeAdmission,
} from "../src/edge-admission-policy";
import type {
  EdgeAdmissionHelper,
  EdgeAdmissionLimiters,
  EdgeAdmissionPolicy,
  EdgeAdmissionPolicyEntry,
} from "../src/edge-admission-policy";
import { handleRequest } from "../src/index";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import type { WorkerRouteDefinition } from "../src/route-registry";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

function rawText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected the Vite ?raw text of index.ts");
  return value;
}

const indexSource = rawText(rawIndexSource);

// Synthetic, content-free fixtures: a documentation-range address and a
// throwaway key that only ever exists in this spec.
const ORIGIN = "https://example.test";
const CLIENT_ADDRESS = "203.0.113.7";
const EDGE_SECRET = "edge-admission-spec-synthetic-secret-00000000";
const RATE_LIMIT_KEY_PREFIX = "app-usagemonitor/rate-limit/v1";
const KEY_PATTERN = /^usage-monitor:([a-z_]+):(global|client:[0-9a-f]{64})$/u;

// The edge-tier bindings plus the identity-keyed origin-tier pair, so a probe
// also observes any call a route makes outside the edge tier.
const ALL_RATE_LIMIT_BINDINGS = [
  ...EDGE_ADMISSION_BINDINGS,
  "UPLOAD_AUTHORIZATION_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
] as const;

const LIMITED_CODE: Readonly<Record<EdgeAdmissionHelper, string>> = {
  attempt: "ATTEMPT_LIMIT_REACHED",
  public_read: "ATTEMPT_LIMIT_REACHED",
  upload_ingress: "UPLOAD_INGRESS_LIMIT_REACHED",
};

interface LimiterCall {
  readonly binding: string;
  readonly key: string;
}

type LimiterAnswer = boolean | "throw";

function recordingLimiters(
  answer: (call: LimiterCall, callNumber: number) => LimiterAnswer = () => true,
): { calls: LimiterCall[]; limiters: Record<string, RateLimit> } {
  const calls: LimiterCall[] = [];
  const limiters: Record<string, RateLimit> = {};
  for (const binding of ALL_RATE_LIMIT_BINDINGS) {
    limiters[binding] = {
      async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
        const call = { binding, key };
        calls.push(call);
        const result = answer(call, calls.length);
        if (result === "throw") throw new Error("synthetic limiter failure");
        return { success: result };
      },
    };
  }
  return { calls, limiters };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Independent oracle for admission.ts's keyed client subject. */
async function expectedClientKey(
  purpose: string,
  subject: string,
  secret = EDGE_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${RATE_LIMIT_KEY_PREFIX}\0${purpose}\0${subject}`),
  );
  return `usage-monitor:${purpose}:client:${hex(signature)}`;
}

async function expectedKeys(
  entry: EdgeAdmissionPolicyEntry,
  subject = CLIENT_ADDRESS,
): Promise<LimiterCall[]> {
  const client = {
    binding: entry.clientBinding,
    key: await expectedClientKey(entry.purpose, subject),
  };
  return entry.coarseBinding === null
    ? [client]
    : [{ binding: entry.coarseBinding, key: `usage-monitor:${entry.purpose}:global` }, client];
}

function lookup(
  policy: EdgeAdmissionPolicy,
  routeId: string,
): EdgeAdmissionPolicyEntry | null {
  return Object.hasOwn(policy, routeId)
    ? (Reflect.get(policy, routeId) as EdgeAdmissionPolicyEntry | undefined) ?? null
    : null;
}

function doctor(
  routeId: string,
  entry: Record<string, unknown> | null,
): EdgeAdmissionPolicy {
  const copy: Record<string, unknown> = { ...EDGE_ADMISSION_POLICY };
  if (entry === null) delete copy[routeId];
  else copy[routeId] = { ...(lookup(EDGE_ADMISSION_POLICY, routeId) ?? {}), ...entry };
  return copy as EdgeAdmissionPolicy;
}

function probeRequest(
  pathname: string,
  method: string,
  headers: Record<string, string> = { "cf-connecting-ip": CLIENT_ADDRESS },
): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method,
    headers: {
      // The union of what the pre-limiter guards need: same-origin for the
      // browser-started routes, a JSON body, and a well-formed synthetic
      // upload bearer for the contribution preflight.
      origin: ORIGIN,
      "content-type": "application/json",
      authorization: `Upload um_device_upload_${crypto.randomUUID()}.${"A".repeat(43)}`,
      ...headers,
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

function probeEnv(limiters: Record<string, RateLimit>): Env {
  return {
    ...(env as TestBindings),
    ENVIRONMENT: "synthetic-development",
    // The Worker keys its client subjects under IDENTITY_LINK_SECRET; using
    // the edge secret here makes handleRequest's keys directly comparable
    // with evaluateEdgeAdmission's.
    IDENTITY_LINK_SECRET: EDGE_SECRET,
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    PUBLIC_ANALYTICS_MODE: "enabled",
    ...limiters,
  } as unknown as Env;
}

function probeMethods(definition: Readonly<WorkerRouteDefinition>): readonly string[] {
  return definition.methods === "all" ? ["GET", "POST", "DELETE"] : definition.methods;
}

interface ProbeObservation {
  readonly routeId: string;
  readonly method: string;
  readonly calls: readonly LimiterCall[];
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: string | null;
}

/**
 * Drives the unchanged Worker handleRequest with spy limiters.
 *
 * "limit-last": the spies succeed until the last call the policy predicts and
 * fail that one, so both the coarse and the client binding are observed and
 * the request ends at the limiter instead of reaching storage or
 * authentication.
 *
 * "admit-all": every spy succeeds, so the request continues past admission
 * until a later guard refuses it, and any further address-keyed call the
 * route makes after the predicted ones (deviceSyncPrincipal admits before it
 * authenticates) is observed too.
 */
async function observeRoute(
  policy: EdgeAdmissionPolicy,
  definition: Readonly<WorkerRouteDefinition>,
  method: string,
  mode: "limit-last" | "admit-all" = "limit-last",
): Promise<ProbeObservation> {
  const entry = lookup(policy, definition.id);
  const failingCall = entry === null || mode === "admit-all"
    ? Number.POSITIVE_INFINITY
    : entry.coarseBinding === null ? 1 : 2;
  const { calls, limiters } = recordingLimiters(
    (_call, callNumber) => callNumber < failingCall,
  );
  const response = await handleRequest(
    probeRequest(definition.pathname, method),
    probeEnv(limiters),
  );
  let code: string | null = null;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const payload = await response.json() as { error?: { code?: unknown } };
      code = typeof payload.error?.code === "string" ? payload.error.code : null;
    } catch {
      code = null;
    }
  } else {
    await response.body?.cancel();
  }
  return {
    routeId: definition.id,
    method,
    calls,
    status: response.status,
    code,
    retryAfter: response.headers.get("retry-after"),
  };
}

function edgeTierCalls(calls: readonly LimiterCall[]): LimiterCall[] {
  return calls.filter((call) =>
    (EDGE_ADMISSION_BINDINGS as readonly string[]).includes(call.binding));
}

function helperForPurpose(purpose: string): EdgeAdmissionHelper {
  if (purpose === "upload_ingress") return "upload_ingress";
  if (purpose === "public_aggregate_read") return "public_read";
  return "attempt";
}

/** Every way an observation can disagree with a policy, as readable labels. */
function probeMismatches(
  policy: EdgeAdmissionPolicy,
  observation: ProbeObservation,
): string[] {
  const label = `${observation.method} ${observation.routeId}`;
  const entry = lookup(policy, observation.routeId);
  const edgeCalls = edgeTierCalls(observation.calls);
  if (entry === null) {
    return edgeCalls.length === 0
      ? []
      : [`${label}: calls ${edgeCalls.map((call) => call.binding).join(",")} without a policy entry`];
  }
  const mismatches: string[] = [];
  const expectedBindings = entry.coarseBinding === null
    ? [entry.clientBinding]
    : [entry.coarseBinding, entry.clientBinding];
  const observedBindings = observation.calls.map((call) => call.binding);
  if (observedBindings.join(",") !== expectedBindings.join(",")) {
    mismatches.push(`${label}: bindings ${observedBindings.join(",")} != ${expectedBindings.join(",")}`);
  }
  observation.calls.forEach((call, index) => {
    const parsed = KEY_PATTERN.exec(call.key);
    if (!parsed?.[1] || !parsed[2]) {
      mismatches.push(`${label}: call ${index + 1} key is not a rate-limit key`);
      return;
    }
    const scope = entry.coarseBinding !== null && index === 0 ? "global" : "client";
    if (parsed[1] !== entry.purpose) {
      mismatches.push(`${label}: call ${index + 1} purpose ${parsed[1]} != ${entry.purpose}`);
    }
    if (helperForPurpose(parsed[1]) !== entry.helper) {
      mismatches.push(`${label}: call ${index + 1} helper ${helperForPurpose(parsed[1])} != ${entry.helper}`);
    }
    if ((scope === "global") !== (parsed[2] === "global")) {
      mismatches.push(`${label}: call ${index + 1} scope is not ${scope}`);
    }
  });
  if (observation.status !== 429
      || observation.code !== LIMITED_CODE[entry.helper]
      || observation.retryAfter !== "60") {
    mismatches.push(
      `${label}: limited response ${observation.status} ${observation.code} != 429 ${LIMITED_CODE[entry.helper]}`,
    );
  }
  return mismatches;
}

function registryDefinition(routeId: string): Readonly<WorkerRouteDefinition> {
  const definition = WORKER_ROUTE_POLICY.find((candidate) => candidate.id === routeId);
  if (!definition) throw new Error(`unknown registry route ${routeId}`);
  return definition;
}

async function migrate(): Promise<void> {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
}

const HELPER_NAMES = [
  "assertAttemptAllowed",
  "assertPublicAggregateReadAllowed",
  "assertUploadIngressRequestAllowed",
] as const;
const HELPER_CALL = /\b(?:assertAttemptAllowed|assertPublicAggregateReadAllowed|assertUploadIngressRequestAllowed)\s*\(/gu;
const HELPER_REFERENCE = /\b(?:assertAttemptAllowed|assertPublicAggregateReadAllowed|assertUploadIngressRequestAllowed)\b/gu;
// The reviewed argument shapes, matched at each call site (sticky).
const CALL_SHAPES: readonly (readonly [RegExp, (match: RegExpExecArray) => string])[] = [
  [
    /assertAttemptAllowed\(\s*env\.([A-Z_]+),\s*env\.([A-Z_]+),\s*request,\s*env,\s*"([a-z_]+)",?\s*\)/uy,
    (match) => `attempt ${match[3]} ${match[1]} ${match[2]}`,
  ],
  [
    /assertUploadIngressRequestAllowed\(\s*env\.([A-Z_]+),\s*env\.([A-Z_]+),\s*request,\s*env,?\s*\)/uy,
    (match) => `upload_ingress upload_ingress ${match[1]} ${match[2]}`,
  ],
  [
    /assertPublicAggregateReadAllowed\(\s*env\.([A-Z_]+),\s*request,\s*env,?\s*\)/uy,
    (match) => `public_read public_aggregate_read null ${match[1]}`,
  ],
];
// Thirteen today: eleven attempt calls (deviceSyncPrincipal counted once for
// its twelve routes), one upload ingress call and one public read call.
const EXPECTED_CALL_SITES = 13;
// Ten today: the handlers that reach assertAttemptAllowed through
// deviceSyncPrincipal (the two domain handlers serve two route ids each).
const EXPECTED_WRAPPER_CALL_SITES = 10;
// Column-0 declarations bound the top-level scopes of index.ts.
const TOP_LEVEL_BOUNDARY = /^(?:export\b|import\b|(?:async\s+)?function\b|const\b|let\b|var\b|class\b|type\b|interface\b|enum\b|declare\b)/gmu;
const FUNCTION_DECLARATION = /^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*[<(]/u;
const ROUTE_API_DECLARATION = /^async function routeApi\(/mu;
const ROUTE_API_CASE = /\bcase\s/gu;
const ROUTE_API_DISPATCH = /\bcase\s+"([a-z0-9_]+)":\s*return\s+([A-Za-z_$][\w$]*)\(/gu;

function signature(entry: EdgeAdmissionPolicyEntry): string {
  return `${entry.helper} ${entry.purpose} ${entry.coarseBinding ?? "null"} ${entry.clientBinding}`;
}

const DEVICE_SYNC_SIGNATURE = "attempt device_sync RECOVERY_RATE_LIMIT CLIENT_ATTEMPT_RATE_LIMIT";

/** Inserts `text` after the first `anchor` that follows `declaration`. */
function insertAfter(source: string, declaration: string, anchor: string, text: string): string {
  const start = source.indexOf(declaration);
  const at = start < 0 ? -1 : source.indexOf(anchor, start);
  if (at < 0) throw new Error(`doctoring anchor not found after ${declaration}`);
  const end = at + anchor.length;
  return `${source.slice(0, end)}${text}${source.slice(end)}`;
}

function callSignature(source: string, index: number): string | null {
  for (const [shape, describe] of CALL_SHAPES) {
    shape.lastIndex = index;
    const match = shape.exec(source);
    if (match) return describe(match);
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface AdmissionGraph {
  readonly violations: readonly string[];
  /** Route id -> sorted signatures of every helper call its handler reaches. */
  readonly routeSignatures: ReadonlyMap<string, readonly string[]>;
  /** Calls to admitting functions other than routeApi's dispatch. */
  readonly wrapperCallSites: number;
}

/**
 * Follows every address-keyed helper call site in index.ts up through its
 * callers (a wrapper such as deviceSyncPrincipal, then its handlers) to the
 * route ids routeApi dispatches to them. Anything the walk cannot attribute
 * to a top-level function declaration is reported, never skipped.
 */
function admissionGraph(source: string): AdmissionGraph {
  const violations: string[] = [];
  const boundaries = [...source.matchAll(TOP_LEVEL_BOUNDARY)].map((match) => match.index);
  const enclosingFunction = (index: number): string | null => {
    let start = -1;
    for (const boundary of boundaries) {
      if (boundary >= index) break;
      start = boundary;
    }
    if (start < 0) return null;
    return FUNCTION_DECLARATION.exec(source.slice(start, start + 200))?.[1] ?? null;
  };
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;

  // Direct helper call sites, by enclosing function.
  const signatures = new Map<string, Set<string>>();
  const addSignatures = (name: string, added: Iterable<string>): boolean => {
    let set = signatures.get(name);
    if (!set) signatures.set(name, set = new Set());
    const before = set.size;
    for (const value of added) set.add(value);
    return set.size !== before;
  };
  for (const match of source.matchAll(HELPER_CALL)) {
    const enclosing = enclosingFunction(match.index);
    if (enclosing === null) {
      violations.push(`helper call on line ${lineOf(match.index)} is outside a top-level function declaration`);
      continue;
    }
    addSignatures(enclosing, [callSignature(source, match.index) ?? "unreviewed-shape"]);
  }

  // Propagate to callers until nothing changes; routeApi is the dispatch
  // boundary and is read separately below.
  const callSites = new Map<string, number[]>();
  const callSitesOf = (name: string): number[] => {
    let sites = callSites.get(name);
    if (sites) return sites;
    sites = [];
    for (const match of source.matchAll(new RegExp(String.raw`\b${escapeRegExp(name)}\s*\(`, "gu"))) {
      if (/\bfunction\*?\s+$/u.test(source.slice(Math.max(0, match.index - 24), match.index))) continue;
      sites.push(match.index);
    }
    callSites.set(name, sites);
    const references = [...source.matchAll(new RegExp(String.raw`\b${escapeRegExp(name)}\b`, "gu"))].length;
    if (references !== sites.length + 1) {
      violations.push(`admitting function ${name} is referenced outside its declaration and call sites`);
    }
    if (sites.length === 0) violations.push(`admitting function ${name} is never called`);
    for (const site of sites) {
      if (enclosingFunction(site) === null) {
        violations.push(`call to admitting function ${name} on line ${lineOf(site)} is outside a top-level function declaration`);
      }
    }
    return sites;
  };
  const pending = [...signatures.keys()];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    const reached = signatures.get(name) ?? new Set<string>();
    for (const site of callSitesOf(name)) {
      const caller = enclosingFunction(site);
      if (caller === null || caller === "routeApi") continue;
      if (addSignatures(caller, reached)) pending.push(caller);
    }
  }
  let wrapperCallSites = 0;
  for (const name of signatures.keys()) {
    wrapperCallSites += callSitesOf(name)
      .filter((site) => enclosingFunction(site) !== "routeApi").length;
  }

  // routeApi's route id -> handler dispatch.
  const routeSignatures = new Map<string, readonly string[]>();
  const routeApiStart = source.search(ROUTE_API_DECLARATION);
  if (routeApiStart < 0) {
    violations.push("routeApi dispatch was not found");
  } else {
    const routeApiEnd = boundaries.find((boundary) => boundary > routeApiStart) ?? source.length;
    const body = source.slice(routeApiStart, routeApiEnd);
    const dispatches = [...body.matchAll(ROUTE_API_DISPATCH)];
    if (dispatches.length !== [...body.matchAll(ROUTE_API_CASE)].length) {
      violations.push("routeApi has a case that is not a direct `return handler(` dispatch");
    }
    for (const [, routeId, handler] of dispatches) {
      const reached = signatures.get(handler as string);
      if (reached) routeSignatures.set(routeId as string, [...reached].sort());
    }
  }
  return { violations, routeSignatures, wrapperCallSites };
}

/** Violations of the index.ts call-site ratchet for a (possibly doctored) source. */
function ratchetViolations(source: string): string[] {
  const calls = [...source.matchAll(HELPER_CALL)].length;
  const references = [...source.matchAll(HELPER_REFERENCE)].length;
  const siteSignatures = [...source.matchAll(HELPER_CALL)]
    .map((match) => callSignature(source, match.index));
  const signatures = siteSignatures.filter((value): value is string => value !== null);
  const violations: string[] = [];
  if (calls !== EXPECTED_CALL_SITES) {
    violations.push(`expected ${EXPECTED_CALL_SITES} address-keyed helper call sites, found ${calls}`);
  }
  // One import specifier per helper; any other reference (an alias, a
  // re-export, a callback) would escape the call count.
  if (references !== calls + HELPER_NAMES.length) {
    violations.push(`helpers referenced outside their import and call sites (${references - calls} extra)`);
  }
  if (signatures.length !== calls) {
    violations.push(`${calls - signatures.length} call sites use an unreviewed argument shape`);
  }
  const fromSource = [...new Set(signatures)].sort();
  const fromPolicy = [...new Set(Object.values(EDGE_ADMISSION_POLICY).map(signature))].sort();
  if (fromSource.join("\n") !== fromPolicy.join("\n")) {
    violations.push(`call-site signatures ${fromSource.join("; ")} != policy ${fromPolicy.join("; ")}`);
  }

  // Indirect reach: every route whose handler reaches a helper, directly or
  // through a wrapper, is exactly a policy route with exactly its signature.
  const graph = admissionGraph(source);
  violations.push(...graph.violations);
  if (graph.wrapperCallSites !== EXPECTED_WRAPPER_CALL_SITES) {
    violations.push(
      `expected ${EXPECTED_WRAPPER_CALL_SITES} admission wrapper call sites, found ${graph.wrapperCallSites}`,
    );
  }
  const outsidePolicy = [...graph.routeSignatures.keys()]
    .filter((routeId) => lookup(EDGE_ADMISSION_POLICY, routeId) === null)
    .sort();
  if (outsidePolicy.length > 0) {
    violations.push(`routes reaching an address-keyed helper outside the policy: ${outsidePolicy.join(",")}`);
  }
  const unreached = Object.keys(EDGE_ADMISSION_POLICY)
    .filter((routeId) => !graph.routeSignatures.has(routeId))
    .sort();
  if (unreached.length > 0) {
    violations.push(`policy routes whose handler reaches no address-keyed helper: ${unreached.join(",")}`);
  }
  for (const [routeId, reached] of graph.routeSignatures) {
    const entry = lookup(EDGE_ADMISSION_POLICY, routeId);
    if (entry !== null && reached.join("; ") !== signature(entry)) {
      violations.push(`${routeId} reaches ${reached.join("; ")} != policy ${signature(entry)}`);
    }
  }
  return violations;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

function captureConsole(): { output: () => string } {
  const spies = CONSOLE_METHODS.map((name) =>
    vi.spyOn(console, name).mockImplementation(() => undefined));
  return {
    output: () => spies.flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("edge admission policy shape", () => {
  it("names exactly the six address-keyed Rate Limiting bindings", () => {
    expect(EDGE_ADMISSION_BINDINGS).toEqual([
      "ENROLLMENT_RATE_LIMIT",
      "RECOVERY_RATE_LIMIT",
      "CLIENT_ATTEMPT_RATE_LIMIT",
      "PUBLIC_READ_RATE_LIMIT",
      "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
      "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
    ]);
    expect(Object.isFrozen(EDGE_ADMISSION_BINDINGS)).toBe(true);
    for (const name of EDGE_ADMISSION_BINDINGS) {
      // Each is an existing Worker binding, not a new namespace.
      expect(typeof Reflect.get(Reflect.get(env, name) as object, "limit"), name).toBe("function");
    }
  });

  it("is frozen, prototype-free, keyed by registry ids and uses every edge binding", () => {
    expect(Object.isFrozen(EDGE_ADMISSION_POLICY)).toBe(true);
    expect(Object.getPrototypeOf(EDGE_ADMISSION_POLICY)).toBeNull();
    const registryIds = new Set(WORKER_ROUTE_POLICY.map((definition) => definition.id));
    const used = new Set<string>();
    for (const [routeId, entry] of Object.entries(EDGE_ADMISSION_POLICY)) {
      expect(registryIds.has(routeId), routeId).toBe(true);
      expect(Object.isFrozen(entry), routeId).toBe(true);
      expect(Object.keys(entry).sort(), routeId)
        .toEqual(["clientBinding", "coarseBinding", "helper", "purpose"]);
      if (entry.coarseBinding !== null) used.add(entry.coarseBinding);
      used.add(entry.clientBinding);
      if (entry.helper === "attempt") {
        expect(entry.clientBinding, routeId).toBe("CLIENT_ATTEMPT_RATE_LIMIT");
      }
    }
    expect([...used].sort()).toEqual([...EDGE_ADMISSION_BINDINGS].sort());
    // Identity-keyed upload admission stays at the origin tier.
    expect(edgeAdmissionPolicyFor("device_upload_authorization")).toBeNull();
  });

  it("pins the reviewed route contract that the origin replay and parity gates consume", () => {
    const byPurpose: Record<string, string[]> = {};
    for (const [routeId, entry] of Object.entries(EDGE_ADMISSION_POLICY)) {
      const group = `${entry.helper}/${entry.purpose}/${entry.coarseBinding}/${entry.clientBinding}`;
      (byPurpose[group] ??= []).push(routeId);
    }
    for (const routes of Object.values(byPurpose)) routes.sort();
    expect(byPurpose).toEqual({
      "attempt/enrollment/ENROLLMENT_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT":
        ["accountless_enrollment", "enroll"],
      "attempt/accountless_ownership/RECOVERY_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT": [
        "accountless_ownership",
        "accountless_telemetry_performance_authorization",
        "accountless_telemetry_v12_authorization",
      ],
      "attempt/accountless_renewal/RECOVERY_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT":
        ["accountless_renewal"],
      "attempt/sign_in_start/ENROLLMENT_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT":
        ["identity_apple_start", "identity_google_start"],
      "attempt/device_disconnect/RECOVERY_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT":
        ["device_disconnect"],
      "attempt/device_credential_renew/RECOVERY_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT":
        ["device_credential_renew"],
      "attempt/device_sync/RECOVERY_RATE_LIMIT/CLIENT_ATTEMPT_RATE_LIMIT": [
        "device_sync_capabilities",
        "device_sync_capabilities_v12",
        "device_sync_manifest",
        "device_sync_state",
        "telemetry_performance_capabilities",
        "telemetry_performance_reports",
        "telemetry_v11_day_manifests",
        "telemetry_v11_domain_activate",
        "telemetry_v11_domain_predecessor",
        "telemetry_v12_day_manifests",
        "telemetry_v12_domain_activate",
        "telemetry_v12_domain_predecessor",
      ],
      "upload_ingress/upload_ingress/UPLOAD_INGRESS_REQUEST_RATE_LIMIT/UPLOAD_INGRESS_CLIENT_RATE_LIMIT":
        ["contributions"],
      "public_read/public_aggregate_read/null/PUBLIC_READ_RATE_LIMIT":
        ["community_daily"],
    });
  });
});

describe("edge admission derivation probe through handleRequest", () => {
  beforeEach(migrate);

  it("matches the policy for every registry route and every allowed method", async () => {
    const mismatches: string[] = [];
    let admittedPairs = 0;
    for (const definition of WORKER_ROUTE_POLICY) {
      for (const method of probeMethods(definition)) {
        const observation = await observeRoute(EDGE_ADMISSION_POLICY, definition, method);
        mismatches.push(...probeMismatches(EDGE_ADMISSION_POLICY, observation));
        const entry = lookup(EDGE_ADMISSION_POLICY, definition.id);
        if (entry === null) {
          // No route outside the policy spends any limiter at all here.
          expect(observation.calls, `${method} ${definition.id}`).toEqual([]);
          continue;
        }
        admittedPairs += 1;
        // Exact keys: the coarse key is global and the client key is the
        // admission.ts HMAC of the address under the (edge) secret.
        expect(observation.calls, `${method} ${definition.id}`)
          .toEqual(await expectedKeys(entry));
        // With every limiter admitting, the route makes no edge-tier call
        // beyond the predicted ones before a later guard refuses it (for
        // example a deviceSyncPrincipal call added after the upload ingress
        // helper, which admits before it authenticates).
        const admitted = await observeRoute(EDGE_ADMISSION_POLICY, definition, method, "admit-all");
        expect(admitted.status, `${method} ${definition.id} admitted`).not.toBe(429);
        expect(edgeTierCalls(admitted.calls), `${method} ${definition.id} admitted`)
          .toEqual(await expectedKeys(entry));
        // The edge evaluation reproduces the Worker's calls byte for byte.
        const edge = recordingLimiters();
        const evaluation = await evaluateEdgeAdmission({
          routeId: definition.id,
          request: probeRequest(definition.pathname, method),
          limiters: edge.limiters,
          clientKeySecret: EDGE_SECRET,
        });
        expect(evaluation, `${method} ${definition.id}`)
          .toEqual({ purpose: entry.purpose, outcome: "allowed" });
        expect(edge.calls, `${method} ${definition.id}`).toEqual(observation.calls);
      }
    }
    expect(mismatches).toEqual([]);
    // 24 routes; performance reports and both day-manifest routes admit GET and POST.
    expect(admittedPairs).toBe(27);
  });

  it("fails on a wrong client binding for an upload ingress entry and an attempt entry", async () => {
    for (const [routeId, clientBinding] of [
      ["contributions", "CLIENT_ATTEMPT_RATE_LIMIT"],
      ["device_sync_state", "PUBLIC_READ_RATE_LIMIT"],
      ["enroll", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT"],
    ] as const) {
      const doctored = doctor(routeId, { clientBinding });
      const definition = registryDefinition(routeId);
      const observation = await observeRoute(doctored, definition, definition.methods[0] as string);
      expect(probeMismatches(EDGE_ADMISSION_POLICY, observation), routeId).toEqual([]);
      expect(probeMismatches(doctored, observation).join("\n"), routeId)
        .toContain("bindings");
    }
  });

  it("fails on a wrong purpose, helper, coarse binding, extra entry or missing entry", async () => {
    const cases: [string, Record<string, unknown> | null, string][] = [
      ["device_disconnect", { purpose: "device_sync" }, "purpose"],
      ["accountless_renewal", { purpose: "accountless_ownership" }, "purpose"],
      ["community_daily", { helper: "attempt" }, "helper"],
      ["identity_google_start", { coarseBinding: "RECOVERY_RATE_LIMIT" }, "bindings"],
      ["enroll", { coarseBinding: null }, "bindings"],
      ["community_daily", { coarseBinding: "ENROLLMENT_RATE_LIMIT" }, "bindings"],
      ["device_sync_manifest", null, "without a policy entry"],
    ];
    for (const [routeId, entry, expected] of cases) {
      const doctored = doctor(routeId, entry);
      const definition = registryDefinition(routeId);
      const observation = await observeRoute(doctored, definition, definition.methods[0] as string);
      expect(probeMismatches(doctored, observation).join("\n"), `${routeId} ${expected}`)
        .toContain(expected);
    }
    const extra = {
      ...EDGE_ADMISSION_POLICY,
      session: EDGE_ADMISSION_POLICY.device_sync_state,
    } as EdgeAdmissionPolicy;
    const session = await observeRoute(extra, registryDefinition("session"), "GET");
    expect(probeMismatches(extra, session).join("\n")).toContain("bindings");
  });
});

describe("edge admission call-site ratchet over index.ts", () => {
  it("passes on the real index.ts", () => {
    expect(indexSource.length).toBeGreaterThan(10_000);
    expect(ratchetViolations(indexSource)).toEqual([]);
  });

  it("fails on a doctored copy with an extra helper call site", () => {
    const doctored = `${indexSource}
async function doctoredExtraAdmission(request: Request, env: Env): Promise<void> {
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_sync",
  );
}
`;
    expect(ratchetViolations(doctored).join("\n"))
      .toContain(`expected ${EXPECTED_CALL_SITES} address-keyed helper call sites, found 14`);
  });

  it("fails on a doctored copy that changes a call-site purpose or binding", () => {
    const purpose = indexSource.replace(`"device_disconnect",`, `"device_sync",`);
    expect(purpose).not.toBe(indexSource);
    expect(ratchetViolations(purpose).join("\n")).toContain("call-site signatures");

    const binding = indexSource.replace(
      "assertPublicAggregateReadAllowed(env.PUBLIC_READ_RATE_LIMIT,",
      "assertPublicAggregateReadAllowed(env.CLIENT_ATTEMPT_RATE_LIMIT,",
    );
    expect(binding).not.toBe(indexSource);
    expect(ratchetViolations(binding).join("\n")).toContain("call-site signatures");
  });

  it("fails on a doctored copy that aliases a helper past the call count", () => {
    const aliased = `${indexSource}\nconst doctoredAlias = assertPublicAggregateReadAllowed;\n`;
    expect(ratchetViolations(aliased).join("\n"))
      .toContain("helpers referenced outside their import and call sites");
  });

  it("derives every policy route and signature through deviceSyncPrincipal and routeApi", () => {
    const graph = admissionGraph(indexSource);
    expect(graph.violations).toEqual([]);
    expect(graph.wrapperCallSites).toBe(EXPECTED_WRAPPER_CALL_SITES);
    expect(Object.fromEntries(graph.routeSignatures)).toEqual(Object.fromEntries(
      Object.entries(EDGE_ADMISSION_POLICY).map(([routeId, entry]) => [routeId, [signature(entry)]]),
    ));
  });

  it("fails when an admitted handler also reaches deviceSyncPrincipal after its own helper", () => {
    const doctored = insertAfter(
      indexSource,
      "async function handleContribution(",
      "    env.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,\n    request,\n    env,\n  );\n",
      '  await deviceSyncPrincipal(request, env, "POST");\n',
    );
    expect(admissionGraph(doctored).routeSignatures.get("contributions"))
      .toEqual([DEVICE_SYNC_SIGNATURE, signature(EDGE_ADMISSION_POLICY.contributions!)].sort());
    const violations = ratchetViolations(doctored).join("\n");
    expect(violations).toContain("contributions reaches");
    expect(violations).toContain(
      `expected ${EXPECTED_WRAPPER_CALL_SITES} admission wrapper call sites, found ${EXPECTED_WRAPPER_CALL_SITES + 1}`,
    );
  });

  it("fails when a route outside the policy reaches deviceSyncPrincipal behind its own guards", () => {
    const doctored = insertAfter(
      indexSource,
      "async function handleTelemetryV11Consent(",
      "  assertCsrf(request, session);\n",
      '  await deviceSyncPrincipal(request, env, "POST");\n',
    );
    expect(admissionGraph(doctored).routeSignatures.get("telemetry_v11_consent"))
      .toEqual([DEVICE_SYNC_SIGNATURE]);
    expect(ratchetViolations(doctored).join("\n"))
      .toContain("routes reaching an address-keyed helper outside the policy: telemetry_v11_consent");
  });

  it("fails on a new wrapper that a route outside the policy reaches", () => {
    const doctored = `${insertAfter(
      indexSource,
      "async function handleSession(",
      "  const session = await personalSession(request, env);\n",
      "  await doctoredSessionAdmission(request, env);\n",
    )}
async function doctoredSessionAdmission(request: Request, env: Env): Promise<void> {
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_sync",
  );
}
`;
    expect(admissionGraph(doctored).routeSignatures.get("session")).toEqual([DEVICE_SYNC_SIGNATURE]);
    const violations = ratchetViolations(doctored).join("\n");
    expect(violations).toContain("routes reaching an address-keyed helper outside the policy: session");
    expect(violations).toContain(
      `expected ${EXPECTED_WRAPPER_CALL_SITES} admission wrapper call sites, found ${EXPECTED_WRAPPER_CALL_SITES + 1}`,
    );
  });

  it("fails when a wrapper escapes the walk by alias, by an unattributable call or by an indirect dispatch", () => {
    const aliased = `${indexSource}\nconst doctoredWrapperAlias = deviceSyncPrincipal;\n`;
    expect(ratchetViolations(aliased).join("\n"))
      .toContain("admitting function deviceSyncPrincipal is referenced outside its declaration and call sites");

    const arrow = `${indexSource}
export const doctoredArrowAdmission = async (request: Request, env: Env) =>
  deviceSyncPrincipal(request, env);
`;
    expect(ratchetViolations(arrow).join("\n"))
      .toMatch(/call to admitting function deviceSyncPrincipal on line \d+ is outside a top-level function declaration/u);

    const dispatch = indexSource.replace(
      'case "contributions":\n      return handleContribution(request, env);',
      'case "contributions": {\n      const response = handleContribution(request, env);\n      return response;\n    }',
    );
    expect(dispatch).not.toBe(indexSource);
    const violations = ratchetViolations(dispatch).join("\n");
    expect(violations).toContain("routeApi has a case that is not a direct `return handler(` dispatch");
    expect(violations).toContain("policy routes whose handler reaches no address-keyed helper: contributions");
  });
});

describe("evaluateEdgeAdmission", () => {
  async function evaluate(
    routeId: string,
    answer?: (call: LimiterCall, callNumber: number) => LimiterAnswer,
    options: {
      headers?: Record<string, string>;
      limiters?: (limiters: Record<string, RateLimit>) => Record<string, unknown>;
      clientKeySecret?: unknown;
    } = {},
  ) {
    const definition = registryDefinition(routeId);
    const recorded = recordingLimiters(answer);
    const request = probeRequest(
      definition.pathname,
      definition.methods[0] as string,
      options.headers,
    );
    const result = await evaluateEdgeAdmission({
      routeId,
      request,
      limiters: (options.limiters?.(recorded.limiters) ?? recorded.limiters) as EdgeAdmissionLimiters,
      clientKeySecret: (options.clientKeySecret ?? EDGE_SECRET) as string,
    });
    return { result, calls: recorded.calls, request };
  }

  it("allows with the admission.ts keys for each helper", async () => {
    for (const routeId of ["enroll", "device_sync_state", "contributions", "community_daily"]) {
      const entry = edgeAdmissionPolicyFor(routeId)!;
      const { result, calls } = await evaluate(routeId);
      expect(result, routeId).toEqual({ purpose: entry.purpose, outcome: "allowed" });
      expect(Object.isFrozen(result), routeId).toBe(true);
      expect(calls, routeId).toEqual(await expectedKeys(entry));
    }
  });

  it("reports a coarse limit without ever calling the client limiter", async () => {
    for (const routeId of ["enroll", "accountless_renewal", "contributions"]) {
      const entry = edgeAdmissionPolicyFor(routeId)!;
      const { result, calls } = await evaluate(
        routeId,
        (call) => call.binding !== entry.coarseBinding,
      );
      expect(result, routeId).toEqual({ purpose: entry.purpose, outcome: "limited" });
      expect(calls.map((call) => call.binding), routeId).toEqual([entry.coarseBinding]);
      expect(calls.filter((call) => call.binding === entry.clientBinding), routeId).toEqual([]);
    }
  });

  it("reports a client limit after the coarse limiter admits", async () => {
    for (const routeId of ["identity_apple_start", "device_credential_renew", "contributions", "community_daily"]) {
      const entry = edgeAdmissionPolicyFor(routeId)!;
      const { result, calls } = await evaluate(
        routeId,
        (call) => call.binding !== entry.clientBinding,
      );
      expect(result, routeId).toEqual({ purpose: entry.purpose, outcome: "limited" });
      expect(calls, routeId).toEqual(await expectedKeys(entry));
    }
  });

  it("reports unavailable for a throwing limiter, a missing binding or an unusable secret", async () => {
    for (const routeId of ["enroll", "telemetry_v12_day_manifests", "contributions", "community_daily"]) {
      const entry = edgeAdmissionPolicyFor(routeId)!;
      const coarseThrows = await evaluate(routeId, (_call, callNumber) =>
        callNumber === 1 ? "throw" : true);
      expect(coarseThrows.result, routeId).toEqual({ purpose: entry.purpose, outcome: "unavailable" });
      expect(coarseThrows.calls, routeId).toHaveLength(1);

      const clientThrows = await evaluate(routeId, (call) =>
        call.binding === entry.clientBinding ? "throw" : true);
      expect(clientThrows.result, routeId).toEqual({ purpose: entry.purpose, outcome: "unavailable" });

      const missing = await evaluate(routeId, undefined, {
        limiters: (limiters) => {
          const copy: Record<string, unknown> = { ...limiters };
          delete copy[entry.clientBinding];
          return copy;
        },
      });
      expect(missing.result, routeId).toEqual({ purpose: entry.purpose, outcome: "unavailable" });
      expect(missing.calls, routeId).toEqual([]);

      for (const clientKeySecret of ["too-short-edge-secret", "", 42]) {
        const unusable = await evaluate(routeId, undefined, { clientKeySecret });
        expect(unusable.result, routeId).toEqual({ purpose: entry.purpose, outcome: "unavailable" });
        expect(unusable.calls, routeId).toEqual([]);
      }
    }
  });

  it("keys a missing or malformed CF-Connecting-IP as the 'unavailable' subject", async () => {
    for (const routeId of ["device_disconnect", "contributions", "community_daily"]) {
      const entry = edgeAdmissionPolicyFor(routeId)!;
      const variants: Record<string, string>[] = [{}, { "cf-connecting-ip": "not an address" }];
      for (const headers of variants) {
        const { result, calls } = await evaluate(routeId, undefined, { headers });
        expect(result, routeId).toEqual({ purpose: entry.purpose, outcome: "allowed" });
        expect(calls, routeId).toEqual(await expectedKeys(entry, "unavailable"));
      }
    }
  });

  it("keys only under the edge secret, even when handed a whole Worker-shaped env", async () => {
    const entry = edgeAdmissionPolicyFor("device_sync_manifest")!;
    const { result, calls } = await evaluate("device_sync_manifest", undefined, {
      limiters: (limiters) => ({
        ...limiters,
        ENVIRONMENT: "synthetic-development",
        IDENTITY_LINK_SECRET: "a-worker-identity-secret-that-is-long-enough",
      }),
    });
    expect(result).toEqual({ purpose: entry.purpose, outcome: "allowed" });
    expect(calls).toEqual(await expectedKeys(entry));
  });

  it("never logs or returns keys, addresses or secrets, and never reads the body", async () => {
    const captured = captureConsole();
    const serialized: string[] = [];
    const keys: string[] = [];
    for (const [routeId, answer] of [
      ["contributions", () => true],
      ["enroll", (_call: LimiterCall, callNumber: number) => callNumber !== 2],
      ["community_daily", () => "throw" as const],
    ] as const) {
      const { result, calls, request } = await evaluate(routeId, answer);
      expect(Object.keys(result!).sort()).toEqual(["outcome", "purpose"]);
      serialized.push(JSON.stringify(result));
      keys.push(...calls.map((call) => call.key));
      expect(request.bodyUsed, routeId).toBe(false);
      expect(await request.text(), routeId).toBe(request.method === "GET" ? "" : "{}");
    }
    const exposed = `${serialized.join("\n")}\n${captured.output()}`;
    expect(captured.output()).toBe("");
    for (const secret of [CLIENT_ADDRESS, EDGE_SECRET, "usage-monitor:", ...keys]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("returns null without touching a limiter for routes outside the policy", async () => {
    const outside = [
      ...WORKER_ROUTE_POLICY
        .map((definition) => definition.id)
        .filter((routeId) => edgeAdmissionPolicyFor(routeId) === null),
      "asset",
      "unknown_api",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "",
    ];
    for (const routeId of [
      "session",
      "logout",
      "participant_export",
      "device_pairing",
      "device_pairing_claim",
      "device_upload_authorization",
    ]) {
      expect(outside, routeId).toContain(routeId);
    }
    const { calls, limiters } = recordingLimiters();
    for (const routeId of outside) {
      expect(await evaluateEdgeAdmission({
        routeId,
        request: probeRequest("/api/v1/session", "GET"),
        limiters,
        clientKeySecret: EDGE_SECRET,
      }), routeId).toBeNull();
    }
    expect(calls).toEqual([]);
  });
});
