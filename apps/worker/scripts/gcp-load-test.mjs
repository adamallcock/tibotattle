#!/usr/bin/env node

/**
 * OPS-11 load-test harness: a synthetic, content-free load generator for the
 * staging GCP origin behind its edge (owner decision, round 2 of 2026-10-02:
 * "3,000 uploads a minute, plus a migrate-and-roll under load, on synthetic
 * data", run by the owner in staging after D-CRB).
 *
 *   node scripts/gcp-load-test.mjs [--target=<origin>] [profile flags]
 *       The default: a dry run. Validates every argument, classifies the
 *       target, and prints the derived profile, the request budget and the
 *       admission ceiling the committed limits predict. It makes no request,
 *       starts no process and writes no file.
 *   node scripts/gcp-load-test.mjs --execute --authorize=GCP_LOAD_TEST:<host> \
 *       --out=<private receipt directory> [--target=<origin>] [--drill=<file>] [profile flags]
 *       The run, which the owner authorizes in chat for that exact target.
 *
 * TARGET. Without --target the target is the reviewed staging origin
 * (config/deployment-endpoints.js DEPLOYMENT_ENDPOINTS.staging). Any other
 * target must be given explicitly with --target. Production hostnames (the
 * public, www, admin, updates and dogfood-release hosts, and the production
 * Worker's workers.dev names) are refused outright, whatever else is given; so
 * is a run.app origin (the load goes through an edge's public routes, never
 * straight at an IAM-protected origin), any non-loopback http: origin and any
 * non-loopback IP literal. An executed run against anything but loopback needs
 * --authorize=GCP_LOAD_TEST:<target hostname>; a supplied authorization must
 * match in a dry run too. --out must be (or is created as) a private directory
 * of this user's (0700 or narrower, not a symlink) and is proved writable
 * before the first request.
 *
 * WORKLOAD. N synthetic accountless devices are enrolled through the real
 * public routes (accountless enrollment, the ownership grant and the v1.2
 * authorization: edge-live-check.mjs's accountlessDeviceRequests), paced by
 * --enroll-rate, honoring Retry-After. Each device then syncs one synthetic
 * v1.2 day (edge-live-check.mjs's syntheticV12Day: C usage chunks, content-free)
 * with the shipped accountless v1.2 client (runTelemetryV12Sync, day
 * manifests, upload authorizations and contributions, then the domain
 * activation), each envelope sealed by the shipped createTelemetryV12Envelope.
 * Uploads are paced to --rate per minute overall and spread evenly across the
 * devices; a pass that stops on a retryable refusal resumes after its
 * Retry-After or a bounded backoff, exactly as a client would. A pass whose
 * budget ends while it waits for a slot gives the slot back; a pass that the
 * window's close stops is recorded as window_closed, not as a failure; and an
 * upload counts as paced only once its envelope reaches a running pass. As in
 * E12's S5, the client is configured for its loopback laboratory origin and
 * the run maps that origin to the target, rewriting only the capability
 * answers' destinationOrigin, which must equal --expected-destination-origin
 * (default: the target origin).
 *
 * DRILL. --drill=<file> names a gcp-load-test-drill-v1 JSON file whose steps
 * are OPS-10 rollout invocations (scripts/gcp-production-rollout.mjs migrate or
 * roll, --environment=staging only, validated by that script's own parser).
 * Starting startAfterSeconds into the load window, the steps run in order as
 * child processes (no shell; their content-free output goes to stderr and the
 * rollout writes its own receipts). Once started, a drill runs until a step
 * fails and no step is ever killed. The receipt splits the status mix into
 * before, during and after the drill. The drill runs only rollout steps: it
 * starts no maintenance pass, and OPS-10 reports a failed migration Job as
 * ROLLOUT_MIGRATION_FAILED without the runner's code, so OPS-11's
 * conflict-and-rerun sub-check (POSTGRES_MIGRATION_CONFLICT) is run by the
 * owner outside this harness.
 *
 * RECEIPT. Latency percentiles per route, the status mix (a non-2xx answer is
 * labelled with its closed error code, nested ({ error: { code } }) or flat
 * ({ error: "<CODE>" }), so an unported route's 503 POSTGRES_TEST_ROUTE_UNSUPPORTED
 * or POSTGRES_ROUTE_NOT_PORTED and the storage gate's 503
 * BACKEND_STORAGE_UNAVAILABLE stay distinct), refusals by
 * code, transport failures by kind, the achieved upload rate per minute, pass
 * outcomes and the drill windows. Written 0600 into a 0700 directory. It
 * never holds a device id, secret, bearer, envelope, body or client address.
 *
 * Outbound traffic goes only to the target origin: a URL that does not resolve
 * to it (another host, or a path such as //host or /\host that would escape it)
 * aborts the run.
 * Exit 0 with a receipt, 2 for a refusal (one JSON line on stderr with a closed
 * code), 1 for anything else.
 */

import { spawn as spawnProcess } from "node:child_process";
import { randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  ACCOUNTLESS_V12_AUTHORIZATION,
  LABORATORY_ORIGIN,
  accountlessDeviceRequests,
  isCapabilityPath,
  syntheticV12Day,
} from "./edge-live-check.mjs";
import { percentile } from "./load-profile-lib.mjs";

export const LOAD_TEST_RECEIPT_SCHEMA = "gcp-load-test-receipt-v1";
export const LOAD_TEST_PLAN_SCHEMA = "gcp-load-test-plan-v1";
export const LOAD_TEST_DRILL_SCHEMA = "gcp-load-test-drill-v1";
export const LOAD_TEST_AUTHORIZATION_PREFIX = "GCP_LOAD_TEST:";
export const LOAD_TEST_PARSER_VERSION = "synthetic-gcp-load-test";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LOAD_TEST_DEFAULTS = Object.freeze({
  ratePerMinute: 3_000,
  devices: 600,
  durationSeconds: 600,
  recordsPerChunk: 1,
  enrollRatePerMinute: 120,
  enrollConcurrency: 8,
  enrollTimeoutSeconds: 3_600,
  requestTimeoutMs: 30_000,
  passBudgetMs: 240_000,
});

/** Inclusive bounds for every numeric flag. */
export const LOAD_TEST_BOUNDS = Object.freeze({
  ratePerMinute: [1, 30_000],
  devices: [1, 5_000],
  durationSeconds: [10, 7_200],
  recordsPerChunk: [1, 200],
  enrollRatePerMinute: [1, 6_000],
  enrollConcurrency: [1, 64],
  enrollTimeoutSeconds: [10, 14_400],
  requestTimeoutMs: [1_000, 120_000],
  passBudgetMs: [10_000, 300_000],
  uploadsPerDevice: [1, 4_096],
});

/** The shipped client's per-pass chunk ceiling and the v1.2 day's chunk ceiling. */
const MAX_CHUNKS_PER_PASS = 2_000;
const MAX_CHUNKS_PER_DEVICE = 4_096;
/** Requests one complete v1.2 pass sends besides its uploads: capabilities twice, predecessor, one day manifest, activation. */
const DEVICE_SYNC_REQUESTS_PER_PASS = 5;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const ENROLLMENT_MAX_ATTEMPTS = 6;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_DRILL_FILE_BYTES = 65_536;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export class LoadTestError extends Error {
  constructor(code) {
    super(code);
    this.name = "LoadTestError";
    this.code = code;
  }
}

function fail(code) {
  throw new LoadTestError(code);
}

// ---------------------------------------------------------------------------
// Target

const STAGING_ORIGIN = DEPLOYMENT_ENDPOINTS.staging.origin;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function workersSubdomain() {
  const host = new URL(STAGING_ORIGIN).hostname;
  const prefix = `${DEPLOYMENT_ENDPOINTS.staging.workerName}.`;
  if (!host.startsWith(prefix) || !host.endsWith(".workers.dev")) fail("LOAD_TEST_ENDPOINTS_UNEXPECTED");
  return host.slice(prefix.length);
}

/** The production Worker's name, from wrangler.jsonc env.production (the deploy authority). */
function productionWorkerName() {
  const config = parseJsonc(readFileSync(join(WORKER_ROOT, "wrangler.jsonc"), "utf8"));
  const name = config?.env?.production?.name;
  if (typeof name !== "string" || !/^[a-z0-9-]{1,63}$/u.test(name)) fail("LOAD_TEST_ENDPOINTS_UNEXPECTED");
  return name;
}

const PRODUCTION_WORKER_HOST = `${productionWorkerName()}.${workersSubdomain()}`;

/**
 * Every production hostname the harness refuses outright: the public route
 * hosts, the admin host and the updates host from the reviewed endpoint
 * manifest, the dogfood-release guard Worker's host, and the production
 * Worker's workers.dev name. Preview names of the production Worker
 * (`<prefix>-<name>.<subdomain>`) are refused by suffix.
 */
export const LOAD_TEST_PRODUCTION_HOSTNAMES = Object.freeze([...new Set([
  ...DEPLOYMENT_ENDPOINTS.public.routeHosts,
  DEPLOYMENT_ENDPOINTS.admin.host,
  new URL(DEPLOYMENT_ENDPOINTS.sparkle.origin).hostname,
  `dogfood-release.${new URL(DEPLOYMENT_ENDPOINTS.public.origin).hostname}`,
  PRODUCTION_WORKER_HOST,
])].sort());

function isProductionHostname(hostname) {
  return LOAD_TEST_PRODUCTION_HOSTNAMES.includes(hostname) || hostname.endsWith(`-${PRODUCTION_WORKER_HOST}`);
}

/**
 * Classify a target origin: 'staging' (the reviewed staging origin),
 * 'loopback' or 'other'. Production hostnames, run.app origins, credentials,
 * paths, non-loopback http: and non-loopback IP literals are refused.
 */
export function classifyLoadTestTarget(value) {
  let url;
  try { url = new URL(value); } catch { fail("LOAD_TEST_TARGET_INVALID"); }
  if (typeof value !== "string" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && url.protocol !== "http:")) {
    fail("LOAD_TEST_TARGET_INVALID");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (isProductionHostname(hostname)) fail("LOAD_TEST_TARGET_PRODUCTION");
  if (hostname === "run.app" || hostname.endsWith(".run.app")) fail("LOAD_TEST_TARGET_ORIGIN_DIRECT");
  const loopback = LOOPBACK_HOSTNAMES.has(hostname);
  if (!loopback && (url.protocol !== "https:" || isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0)) {
    fail("LOAD_TEST_TARGET_INVALID");
  }
  const klass = url.origin === STAGING_ORIGIN ? "staging" : loopback ? "loopback" : "other";
  return Object.freeze({ origin: url.origin, hostname, class: klass });
}

// ---------------------------------------------------------------------------
// Arguments

const VALUE_FLAGS = Object.freeze({
  "--target": "target",
  "--authorize": "authorize",
  "--out": "out",
  "--drill": "drill",
  "--expected-destination-origin": "expectedDestinationOrigin",
  "--rate": "ratePerMinute",
  "--devices": "devices",
  "--duration": "durationSeconds",
  "--records-per-chunk": "recordsPerChunk",
  "--enroll-rate": "enrollRatePerMinute",
  "--enroll-concurrency": "enrollConcurrency",
  "--enroll-timeout": "enrollTimeoutSeconds",
  "--request-timeout-ms": "requestTimeoutMs",
  "--pass-budget-ms": "passBudgetMs",
  "--uploads-per-device": "uploadsPerDevice",
});

function boundedInteger(raw, name) {
  if (!/^[1-9][0-9]{0,8}$/u.test(raw)) fail("LOAD_TEST_ARGUMENT_INVALID");
  const value = Number(raw);
  const [minimum, maximum] = LOAD_TEST_BOUNDS[name];
  if (value < minimum || value > maximum) fail("LOAD_TEST_ARGUMENT_OUT_OF_RANGE");
  return value;
}

/** Parses argv (`--name=value` and a bare `--execute`); never reads the environment. */
export function parseLoadTestArguments(argv) {
  if (!Array.isArray(argv)) fail("LOAD_TEST_ARGUMENT_INVALID");
  const values = new Map();
  let execute = false;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) fail("LOAD_TEST_ARGUMENT_INVALID");
      execute = true;
      continue;
    }
    const match = typeof argument === "string" ? /^(--[a-z-]+)=(.+)$/u.exec(argument) : null;
    if (match === null || !Object.hasOwn(VALUE_FLAGS, match[1]) || values.has(match[1]) || match[2].includes("\0")) {
      fail("LOAD_TEST_ARGUMENT_INVALID");
    }
    values.set(match[1], match[2]);
  }
  const explicitTarget = values.has("--target");
  const target = classifyLoadTestTarget(explicitTarget ? values.get("--target") : STAGING_ORIGIN);
  // Without --target the run is the reviewed staging origin; nothing else is implicit.
  if (!explicitTarget && target.class !== "staging") fail("LOAD_TEST_TARGET_NOT_STAGING");
  const options = { execute, explicitTarget, target, authorize: values.get("--authorize") ?? null,
    out: values.get("--out") ?? null, drill: values.get("--drill") ?? null, expectedDestinationOrigin: target.origin };
  if (values.has("--expected-destination-origin")) {
    let destination;
    try { destination = new URL(values.get("--expected-destination-origin")); } catch {
      fail("LOAD_TEST_ARGUMENT_INVALID");
    }
    if (destination.origin !== values.get("--expected-destination-origin")
        || isProductionHostname(destination.hostname.toLowerCase())) fail("LOAD_TEST_ARGUMENT_INVALID");
    options.expectedDestinationOrigin = destination.origin;
  }
  for (const name of Object.keys(LOAD_TEST_DEFAULTS)) {
    const flag = Object.keys(VALUE_FLAGS).find((candidate) => VALUE_FLAGS[candidate] === name);
    options[name] = values.has(flag) ? boundedInteger(values.get(flag), name) : LOAD_TEST_DEFAULTS[name];
  }
  options.uploadsPerDevice = values.has("--uploads-per-device")
    ? boundedInteger(values.get("--uploads-per-device"), "uploadsPerDevice") : null;
  const expected = `${LOAD_TEST_AUTHORIZATION_PREFIX}${target.hostname}`;
  if (options.authorize !== null && options.authorize !== expected) fail("LOAD_TEST_AUTHORIZATION_MISMATCH");
  if (execute && target.class !== "loopback" && options.authorize === null) fail("LOAD_TEST_AUTHORIZATION_REQUIRED");
  if (execute && options.out === null) fail("LOAD_TEST_OUT_REQUIRED");
  options.profile = deriveLoadTestProfile(options);
  return Object.freeze(options);
}

// ---------------------------------------------------------------------------
// Profile and admission prediction

/**
 * The workload one set of options implies; pure. Each device uploads one
 * chunk per upload; by default enough chunks to keep its share of the rate
 * busy for the whole window (--uploads-per-device sets fewer or more).
 */
export function deriveLoadTestProfile({ ratePerMinute, devices, durationSeconds, recordsPerChunk, enrollRatePerMinute,
  enrollConcurrency, enrollTimeoutSeconds, requestTimeoutMs, passBudgetMs, uploadsPerDevice = null }) {
  const perDeviceIntervalMs = Math.ceil((60_000 * devices) / ratePerMinute);
  const chunksPerDevice = uploadsPerDevice ?? Math.ceil((ratePerMinute * durationSeconds) / 60 / devices);
  if (chunksPerDevice > MAX_CHUNKS_PER_DEVICE) fail("LOAD_TEST_PROFILE_CHUNKS_EXCEED_DAY");
  const chunksPerPass = Math.max(1, Math.min(MAX_CHUNKS_PER_PASS, chunksPerDevice,
    Math.floor(passBudgetMs / perDeviceIntervalMs)));
  const passesPerDevice = Math.ceil(chunksPerDevice / chunksPerPass);
  return Object.freeze({
    ratePerMinute,
    devices,
    durationSeconds,
    recordsPerChunk,
    chunksPerDevice,
    chunksPerDeviceSource: uploadsPerDevice === null ? "derived_from_rate_and_window" : "explicit",
    plannedUploads: chunksPerDevice * devices,
    plannedRecords: chunksPerDevice * devices * recordsPerChunk,
    perDeviceIntervalMs,
    perDeviceUploadsPerMinute: Math.round((60_000 / perDeviceIntervalMs) * 100) / 100,
    chunksPerPass,
    passesPerDeviceEstimate: passesPerDevice,
    passBudgetMs,
    requestTimeoutMs,
    enrollRatePerMinute,
    enrollConcurrency,
    enrollTimeoutSeconds,
    minimumEnrollmentSeconds: Math.ceil((devices * 60) / enrollRatePerMinute),
    requestsPerUpload: 2,
  });
}

/**
 * Demand per minute on each admission control against `limits`, for
 * `clientAddresses` distinct client addresses (1 for one load machine). Edge
 * coarse limits are per Cloudflare location; client limits are keyed by the
 * client address and purpose; the principal limit is per device. Pure.
 */
export function predictAdmission(profile, limits, { clientAddresses = 1 } = {}) {
  const passesPerMinute = (profile.devices * profile.passesPerDeviceEstimate) / (profile.durationSeconds / 60);
  const deviceSync = passesPerMinute * DEVICE_SYNC_REQUESTS_PER_PASS;
  const enrollment = Math.min(profile.enrollRatePerMinute, profile.devices);
  const ownership = 2 * enrollment;
  const rows = [
    ["ENROLLMENT_RATE_LIMIT", "enrollment", "per_location", enrollment],
    ["CLIENT_ATTEMPT_RATE_LIMIT", "enrollment", "per_client_address", enrollment / clientAddresses],
    ["RECOVERY_RATE_LIMIT", "accountless_ownership", "per_location", ownership],
    ["CLIENT_ATTEMPT_RATE_LIMIT", "accountless_ownership", "per_client_address", ownership / clientAddresses],
    ["RECOVERY_RATE_LIMIT", "device_sync", "per_location", deviceSync],
    ["CLIENT_ATTEMPT_RATE_LIMIT", "device_sync", "per_client_address", deviceSync / clientAddresses],
    ["UPLOAD_INGRESS_REQUEST_RATE_LIMIT", "upload_ingress", "per_location", profile.ratePerMinute],
    ["UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "upload_ingress", "per_client_address", profile.ratePerMinute / clientAddresses],
    ["UPLOAD_INGRESS_BUDGET", "upload_ingress", "global_starts", profile.ratePerMinute],
    ["UPLOAD_AUTHORIZATION_RATE_LIMIT", "upload_authorization", "global", profile.ratePerMinute],
    ["UPLOAD_PRINCIPAL_RATE_LIMIT", "upload_authorization", "per_device", profile.perDeviceUploadsPerMinute],
  ];
  return rows.map(([binding, purpose, scope, demand]) => {
    const limit = limits?.[binding] ?? null;
    const demandPerMinute = Math.round(demand * 100) / 100;
    return Object.freeze({ binding, purpose, scope, limitPerMinute: limit, demandPerMinute,
      exceeds: limit === null ? null : demandPerMinute > limit });
  });
}

function wranglerLimits(config, environment) {
  const limits = {};
  for (const entry of config?.env?.[environment]?.ratelimits ?? []) {
    if (entry?.simple?.period !== 60 || !Number.isSafeInteger(entry?.simple?.limit)) fail("LOAD_TEST_LIMITS_UNREADABLE");
    limits[entry.name] = entry.simple.limit;
  }
  return limits;
}

/**
 * The committed admission limits per plane: the edge tier from wrangler.jsonc
 * (env.staging, the checked-in staging Worker; env.production), the origin
 * tier and the ingress budget's starts per minute from the committed GCP
 * configuration (cloud-run/postgres-production-configuration.mjs). The
 * OWN-7b staging edge and a D-CRB staging service may carry other values.
 */
export async function readCommittedAdmissionLimits(workerRoot = WORKER_ROOT) {
  const config = parseJsonc(await readFile(join(workerRoot, "wrangler.jsonc"), "utf8"));
  const gcp = await import("../cloud-run/postgres-production-configuration.mjs");
  const origin = (tier) => Object.fromEntries(Object.values(tier).map(({ binding, limit, periodSeconds }) => {
    if (periodSeconds !== 60) fail("LOAD_TEST_LIMITS_UNREADABLE");
    return [binding, limit];
  }));
  return Object.freeze({
    staging: Object.freeze({ ...wranglerLimits(config, "staging"), ...origin(gcp.STAGING_ORIGIN_TIER_RATE_LIMITS),
      UPLOAD_INGRESS_BUDGET: Number(gcp.STAGING_CONTAINMENT_VARS.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE) }),
    production: Object.freeze({ ...wranglerLimits(config, "production"), ...origin(gcp.ORIGIN_TIER_RATE_LIMITS),
      UPLOAD_INGRESS_BUDGET: Number(gcp.PRODUCTION_VARS.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE) }),
  });
}

/** The dry-run plan: the options, the profile and (given limits) the predicted admission. */
export function loadTestPlan(options, { limits = null, limitsUnavailable = false } = {}) {
  const admission = limits === null ? null : Object.fromEntries(Object.entries(limits).map(([plane, values]) => {
    const rows = predictAdmission(options.profile, values, { clientAddresses: 1 });
    return [plane, { rows, refusedBy: rows.filter((row) => row.exceeds === true)
      .map((row) => `${row.binding}/${row.purpose}`) }];
  }));
  return {
    schemaVersion: LOAD_TEST_PLAN_SCHEMA,
    mode: options.execute ? "execute" : "dry_run",
    target: { class: options.target.class, hostname: options.target.hostname, explicit: options.explicitTarget },
    expectedDestinationOrigin: options.expectedDestinationOrigin,
    authorization: options.target.class === "loopback" ? "not_required"
      : options.authorize === null ? "required_to_execute" : "matches_target",
    profile: options.profile,
    drill: options.drill === null ? null : "file",
    admission,
    admissionPrediction: limits === null ? (limitsUnavailable ? "unavailable" : "not_computed")
      : "one_client_address_against_committed_limits",
    prerequisites: [
      "D-CRB: the staging service template and its origin-tier limits",
      "the staging service in STAGING_ADMISSION_MODE=synthetic-rehearsal (accountless admission)",
      "OWN-7b: the staging edge in gcp mode in front of the staging origin",
      "edge-tier, origin-tier and ingress-budget limits sized for the target rate, or the refusals accepted as the measurement",
      "the owner's authorization in chat for this exact target, and for each drill step",
    ],
    notCovered: [
      "OPS-11's maintenance-pass sub-check (C-MAINT): a migration Job that meets a running maintenance pass must "
        + "refuse POSTGRES_MIGRATION_CONFLICT and then rerun cleanly. The drill runs only OPS-10 rollout steps, starts "
        + "no maintenance pass, and OPS-10 reports a failed migration Job only as ROLLOUT_MIGRATION_FAILED; the owner "
        + "runs this check outside the harness and reads the code from the Job's log.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Pacing

/**
 * Slot pacing with no burst credit. Global slots lie on a fixed grid, one per
 * 60000/ratePerMinute ms from the first reservation, and each holds at most
 * one upload; when a device state is given, that device also waits
 * perDeviceIntervalMs between its own slots. A reservation takes the earliest
 * free grid slot at or after max(now, the device's next slot), so a device
 * waiting out its own interval leaves the slots before it to other devices,
 * and a slot in the past is never handed out. reserve() is pure given `now`.
 *
 * acquire(device, signal) reserves and waits for the slot. If `signal` (the
 * pass) aborts first it rejects LOAD_TEST_PASS_ENDED and gives the slot and
 * the device's spacing back; close() wakes every waiter, which rejects
 * LOAD_TEST_WINDOW_CLOSED and gives its slot back. sleep(ms, signal) must
 * settle (either way) when its signal aborts.
 */
export function createPacer({ ratePerMinute, perDeviceIntervalMs = 0, clock = Date.now, sleep = defaultSleep }) {
  const intervalMs = 60_000 / ratePerMinute;
  const reserved = new Set();
  const closer = new AbortController();
  let anchor = null;
  let pruneAt = 1_024;
  const indexAtOrAfter = (time) => Math.max(0, Math.ceil((time - anchor) / intervalMs - 1e-9));
  function take(device, now) {
    anchor ??= now;
    if (reserved.size >= pruneAt) {
      // Slots before the current one can never be chosen again.
      const floor = indexAtOrAfter(now) - 1;
      for (const index of reserved) if (index < floor) reserved.delete(index);
      pruneAt = Math.max(1_024, reserved.size * 2);
    }
    let index = indexAtOrAfter(Math.max(now, device?.nextSlotAt ?? Number.NEGATIVE_INFINITY));
    while (reserved.has(index)) index += 1;
    reserved.add(index);
    const at = anchor + index * intervalMs;
    const previousDeviceSlot = device?.nextSlotAt;
    if (device) device.nextSlotAt = at + perDeviceIntervalMs;
    return { index, at, device, previousDeviceSlot };
  }
  function release({ index, at, device, previousDeviceSlot }) {
    reserved.delete(index);
    if (device && device.nextSlotAt === at + perDeviceIntervalMs) device.nextSlotAt = previousDeviceSlot;
  }
  return Object.freeze({
    reserve: (device, now) => take(device, now).at,
    async acquire(device, signal = undefined) {
      if (closer.signal.aborted) fail("LOAD_TEST_WINDOW_CLOSED");
      if (signal?.aborted) fail("LOAD_TEST_PASS_ENDED");
      const now = clock();
      const reservation = take(device, now);
      if (reservation.at > now) {
        const wake = signal === undefined ? closer.signal : AbortSignal.any([closer.signal, signal]);
        try { await sleep(reservation.at - now, wake); } catch { /* woken: the window closed or the pass ended */ }
      }
      if (closer.signal.aborted || signal?.aborted) {
        release(reservation);
        fail(closer.signal.aborted ? "LOAD_TEST_WINDOW_CLOSED" : "LOAD_TEST_PASS_ENDED");
      }
    },
    close() { closer.abort(); },
    get closed() { return closer.signal.aborted; },
  });
}

// ---------------------------------------------------------------------------
// Recording

const ROUTE_LABELS = Object.freeze({
  "GET /api/health": "health",
  "GET /api/ready": "ready",
  "GET /api/v1/envelope-key": "envelope_key",
  "POST /api/v1/accountless/enrollment": "accountless_enrollment",
  "POST /api/v1/accountless/ownership": "accountless_ownership",
  "POST /api/v1/accountless/telemetry-v1.2-authorization": "accountless_v12_authorization",
  "GET /api/v1/device/sync-capabilities-v1.2": "v12_capabilities",
  "POST /api/v1/me/telemetry-v12/domain-predecessor": "v12_predecessor",
  "POST /api/v1/device/telemetry/v1.2/day-manifests": "v12_day_manifests",
  "POST /api/v1/device/upload-authorizations": "upload_authorization",
  "POST /api/v1/contributions": "contribution",
  "POST /api/v1/me/telemetry-v12/domain-activate": "v12_activate",
});

export function routeLabel(method, pathname) {
  return ROUTE_LABELS[`${method} ${pathname}`] ?? "other";
}

/**
 * The closed error code of a JSON error body, or null; never any other body
 * content. Both shapes the hosted service answers with count: the API error
 * `{ error: { code } }` (the origin's unported routes answer
 * POSTGRES_ROUTE_NOT_PORTED in it) and the flat `{ error: "<CODE>" }` of the
 * loopback fallback (postgres-test-dispatch.mjs).
 */
export function errorCodeOf(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const error = value !== null && typeof value === "object" && !Array.isArray(value) ? value.error : undefined;
    const code = typeof error === "string" ? error : error?.code;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** A transport failure's closed kind; never the message. */
export function transportKind(error) {
  if (error instanceof LoadTestError && error.code === "LOAD_TEST_RESPONSE_OVERSIZE") return "oversize";
  if (error?.name === "AbortError") return "aborted";
  if (error?.name === "TimeoutError") return "timeout";
  const code = error?.cause?.code ?? error?.code;
  if (code === "ECONNREFUSED") return "refused";
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(code)) return "reset";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
    return "timeout";
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  return "other";
}

/** The status-mix label: '201', '503:BACKEND_STORAGE_UNAVAILABLE', 'transport:refused'. */
export function statusLabel({ status = null, code = null, transport = null }) {
  if (transport !== null) return `transport:${transport}`;
  return status >= 200 && status < 300 ? String(status) : code === null ? String(status) : `${status}:${code}`;
}

const round = (value) => Math.round(value * 10) / 10;

function latencySummary(values) {
  if (values.length === 0) return { p50: null, p90: null, p95: null, p99: null, max: null };
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  return { p50: round(percentile(values, 0.5)), p90: round(percentile(values, 0.9)),
    p95: round(percentile(values, 0.95)), p99: round(percentile(values, 0.99)), max: round(max) };
}

function increment(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/** Content-free request samples and pass outcomes; summary() is the receipt body. */
export function createLoadRecorder({ clock = Date.now } = {}) {
  const startedAt = clock();
  const samples = [];
  const passes = [];
  const counters = { uploadsPaced: 0, uploadsDeclinedAfterWindow: 0, reservationsReleasedAtPassEnd: 0,
    envelopesDiscardedAtPassEnd: 0 };
  let loadStartedAt = null;
  return Object.freeze({
    startedAt,
    counters,
    now: () => clock() - startedAt,
    markLoadStart() { loadStartedAt = clock() - startedAt; },
    get loadStartedAt() { return loadStartedAt; },
    record({ phase, route, status = null, code = null, transport = null, latencyMs }) {
      samples.push({ atMs: clock() - startedAt, phase, route, label: statusLabel({ status, code, transport }),
        ok: transport === null && status >= 200 && status < 300, code, transport, latencyMs: round(latencyMs) });
    },
    pass(outcome) {
      passes.push({ atMs: clock() - startedAt, status: outcome.status, failure: outcome.failure?.code ?? null,
        chunksUploaded: outcome.chunksUploaded ?? 0 });
    },
    summary({ windowMs, drillSteps = [] }) {
      return summarizeSamples({ samples, passes, counters, loadStartedAt, windowMs, drillSteps });
    },
  });
}

function mixOf(samples) {
  const mix = {};
  for (const sample of samples) increment(mix, sample.label);
  return mix;
}

/** Pure: the receipt's measurement sections from recorded samples. */
export function summarizeSamples({ samples, passes, counters, loadStartedAt, windowMs, drillSteps }) {
  const routes = {};
  const latencies = {};
  const refusalsByCode = {};
  const transportFailures = {};
  for (const sample of samples) {
    const route = routes[sample.route] ??= { count: 0, statusMix: {} };
    route.count += 1;
    increment(route.statusMix, sample.label);
    (latencies[sample.route] ??= []).push(sample.latencyMs);
    // The preflight's own answers stay in statusMixByPhase.preflight, not here:
    // /api/ready may legitimately be 503 (the local fastpath-test origin, for
    // one, answers it 503 POSTGRES_TEST_ROUTE_UNSUPPORTED).
    if (sample.phase === "preflight") continue;
    if (sample.transport !== null) increment(transportFailures, sample.transport);
    else if (!sample.ok) increment(refusalsByCode, sample.code ?? `HTTP_${String(sample.label).split(":")[0]}`);
  }
  for (const [route, values] of Object.entries(latencies)) routes[route].latencyMs = latencySummary(values);
  const load = samples.filter((sample) => sample.phase === "load");
  const start = loadStartedAt ?? 0;
  const accepted = load.filter((sample) => sample.route === "contribution" && sample.ok);
  const inWindow = accepted.filter((sample) => sample.atMs - start < windowMs);
  const minutes = Math.max(1, Math.ceil(windowMs / 60_000));
  const perMinute = Array.from({ length: minutes }, () => 0);
  for (const sample of inWindow) perMinute[Math.min(minutes - 1, Math.floor((sample.atMs - start) / 60_000))] += 1;
  const passOutcomes = { complete: 0, partial: 0, failed: 0, windowClosed: 0, byFailureCode: {} };
  for (const pass of passes) {
    const key = pass.status === "window_closed" ? "windowClosed" : pass.status;
    passOutcomes[key] = (passOutcomes[key] ?? 0) + 1;
    if (pass.failure !== null) increment(passOutcomes.byFailureCode, pass.failure);
  }
  let drill = null;
  if (drillSteps.length > 0) {
    const from = Math.min(...drillSteps.map((step) => step.startMs));
    const to = Math.max(...drillSteps.map((step) => step.endMs ?? step.startMs));
    const window = (predicate) => {
      const selected = load.filter(predicate);
      const uploads = selected.filter((sample) => sample.route === "contribution");
      return { requests: selected.length, statusMix: mixOf(selected),
        contributionsAccepted: uploads.filter((sample) => sample.ok).length,
        contributionsRefused: uploads.filter((sample) => !sample.ok).length,
        latencyMs: latencySummary(selected.map((sample) => sample.latencyMs)) };
    };
    drill = { steps: drillSteps, windowMs: { from, to },
      before: window((sample) => sample.atMs < from),
      during: window((sample) => sample.atMs >= from && sample.atMs <= to),
      after: window((sample) => sample.atMs > to) };
  }
  return {
    uploads: {
      paced: counters.uploadsPaced,
      declinedAfterWindow: counters.uploadsDeclinedAfterWindow,
      releasedAtPassEnd: counters.reservationsReleasedAtPassEnd ?? 0,
      discardedAtPassEnd: counters.envelopesDiscardedAtPassEnd ?? 0,
      authorizationsGranted: load.filter((sample) => sample.route === "upload_authorization" && sample.ok).length,
      accepted: accepted.length,
      acceptedInWindow: inWindow.length,
      contributionsRefused: load.filter((sample) => sample.route === "contribution" && !sample.ok).length,
      achievedPerMinute: round(inWindow.length / (windowMs / 60_000)),
      perMinute,
    },
    passes: passOutcomes,
    routes,
    statusMix: mixOf(samples),
    statusMixByPhase: { enrollment: mixOf(samples.filter((sample) => sample.phase === "enrollment")),
      preflight: mixOf(samples.filter((sample) => sample.phase === "preflight")), load: mixOf(load) },
    refusalsByCode,
    transportFailures,
    drill,
  };
}

// ---------------------------------------------------------------------------
// The guarded, recording fetch

async function boundedBytes(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel?.().catch(() => {});
    fail("LOAD_TEST_RESPONSE_OVERSIZE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      fail("LOAD_TEST_RESPONSE_OVERSIZE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A fetch for one device (or the harness): the shipped client's laboratory
 * origin and the target origin both map to the target; every other URL is a
 * fatal outbound refusal. Each exchange is recorded (route, status, closed
 * error code or transport kind, latency) and answered with an equivalent
 * Response; a 200 capability answer's destinationOrigin must equal
 * expectedDestinationOrigin and is rewritten to the laboratory origin.
 */
export function createRecordingFetch({ fetch: baseFetch, targetOrigin, expectedDestinationOrigin, recorder, phase,
  onFatal }) {
  return async function recordingFetch(input, init = {}) {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    let path = null;
    for (const origin of [LABORATORY_ORIGIN, targetOrigin]) {
      if (typeof href === "string" && href.startsWith(`${origin}/`)) path = href.slice(origin.length);
    }
    // A path such as //host, /\host or /<tab>/host resolves to another
    // authority; only what resolves to the target itself is sent.
    let url = null;
    if (path !== null) {
      try { url = new URL(path, targetOrigin); } catch { url = null; }
    }
    if (url === null || url.origin !== targetOrigin) {
      onFatal("LOAD_TEST_OUTBOUND_REFUSED");
      fail("LOAD_TEST_OUTBOUND_REFUSED");
    }
    const method = (init.method ?? "GET").toUpperCase();
    const route = routeLabel(method, url.pathname);
    const headers = new Headers(init.headers ?? {});
    const started = performance.now();
    let response;
    let bytes;
    try {
      response = await baseFetch(url.href, { method, headers: Object.fromEntries(headers), body: init.body,
        redirect: "manual", signal: init.signal });
      bytes = await boundedBytes(response);
    } catch (error) {
      recorder.record({ phase: phase(), route, transport: transportKind(error), latencyMs: performance.now() - started });
      throw error;
    }
    const ok = response.status >= 200 && response.status < 300;
    recorder.record({ phase: phase(), route, status: response.status, code: ok ? null : errorCodeOf(bytes),
      latencyMs: performance.now() - started });
    const outHeaders = new Headers(response.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    if (isCapabilityPath(url.pathname) && response.status === 200) {
      let value;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { value = null; }
      if (value === null || typeof value !== "object" || value.destinationOrigin !== expectedDestinationOrigin) {
        onFatal("LOAD_TEST_DESTINATION_UNEXPECTED");
        fail("LOAD_TEST_DESTINATION_UNEXPECTED");
      }
      value.destinationOrigin = LABORATORY_ORIGIN;
      bytes = Buffer.from(JSON.stringify(value));
    }
    const empty = [101, 204, 205, 304].includes(response.status) || method === "HEAD";
    return new Response(empty ? null : bytes, { status: response.status, headers: outHeaders });
  };
}

// ---------------------------------------------------------------------------
// The run

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  return /^\d{1,6}$/u.test(value) ? Number(value) * 1_000 : null;
}

function backoffMs(attempt) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

function retryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function sleepUntil(ms, signal, sleep) {
  if (ms <= 0 || signal.aborted) return;
  try { await sleep(ms, signal); } catch { /* aborted */ }
}

/**
 * Enroll one synthetic accountless device: the three admission requests in
 * order, each retried on 408, 429 or 5xx after its Retry-After (or a bounded
 * backoff) while the enrollment deadline allows. Returns the Device
 * authorization, or the closed code that stopped it.
 */
export async function enrollSyntheticDevice({ fetch, targetOrigin, deadline, clock = Date.now, sleep, signal }) {
  const { deviceAuthorization, requests } = accountlessDeviceRequests();
  for (const request of requests) {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return { ok: false, code: "aborted" };
      let wait;
      let stopCode;
      try {
        const response = await fetch(`${targetOrigin}${request.path}`, request.init);
        await response.body?.cancel?.().catch(() => {});
        if (response.status >= 200 && response.status < 300) break;
        if (!retryable(response.status)) return { ok: false, code: `${request.id}:${response.status}` };
        wait = retryAfterMs(response) ?? backoffMs(attempt);
        stopCode = `${request.id}:${response.status}`;
      } catch (error) {
        if (error instanceof LoadTestError && error.code !== "LOAD_TEST_RESPONSE_OVERSIZE") throw error;
        wait = backoffMs(attempt);
        stopCode = `${request.id}:transport`;
      }
      if (attempt + 1 >= ENROLLMENT_MAX_ATTEMPTS || clock() + wait >= deadline) return { ok: false, code: stopCode };
      await sleepUntil(wait, signal, sleep);
    }
  }
  return { ok: true, deviceAuthorization };
}

function defaultSleep(ms, signal) {
  return delay(ms, undefined, signal === undefined ? undefined : { signal });
}

/**
 * Run the load test. deps (all optional; the spec injects them):
 *   fetchFor(index): the base fetch for device `index` (-1 for the harness's
 *     own requests); default the global fetch;
 *   clientAddresses: how many client addresses fetchFor spreads over (1);
 *   drill: { startAfterMs, steps: [{ id, run: async () => ({ exitCode }) }] } (see runDrill);
 *   clock, sleep, day, runId, progress(line).
 */
export async function runLoadTest(options, deps = {}) {
  if (!options?.execute) fail("LOAD_TEST_EXECUTE_REQUIRED");
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const fetchFor = deps.fetchFor ?? (() => globalThis.fetch);
  const profile = options.profile;
  const targetOrigin = options.target.origin;
  const recorder = createLoadRecorder({ clock });
  const controller = new AbortController();
  let fatal = null;
  const onFatal = (code) => {
    fatal ??= code;
    controller.abort();
  };
  let phase = "preflight";
  const fetchOf = (index) => createRecordingFetch({ fetch: fetchFor(index), targetOrigin,
    expectedDestinationOrigin: options.expectedDestinationOrigin, recorder, phase: () => phase, onFatal });
  const harness = fetchOf(-1);
  const progress = deps.progress ?? (() => {});

  // Preflight: health must answer 200; ready and the envelope key are recorded.
  const preflight = {};
  let health;
  try {
    health = await harness(`${targetOrigin}/api/health`, { headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof LoadTestError) throw error;
    fail("LOAD_TEST_TARGET_UNREACHABLE");
  }
  const healthBody = await health.json().catch(() => null);
  preflight.health = { status: health.status,
    sourceCommit: COMMIT.test(healthBody?.deployment?.sourceCommit ?? "") ? healthBody.deployment.sourceCommit : null };
  if (health.status !== 200) fail("LOAD_TEST_TARGET_UNHEALTHY");
  const ready = await harness(`${targetOrigin}/api/ready`, { headers: { accept: "application/json" } });
  await ready.body?.cancel?.().catch(() => {});
  preflight.ready = { status: ready.status };
  const keyAnswer = await harness(`${targetOrigin}/api/v1/envelope-key`, { headers: { accept: "application/json" } });
  const key = await keyAnswer.json().catch(() => null);
  preflight.envelopeKey = { status: keyAnswer.status };
  if (keyAnswer.status !== 200 || key === null || typeof key.keyId !== "string" || key.publicJwk === null
      || typeof key.publicJwk !== "object") {
    fail("LOAD_TEST_ENVELOPE_KEY_UNAVAILABLE");
  }

  // Enrollment through the public routes.
  phase = "enrollment";
  const enrollStartedAt = recorder.now();
  const enrollDeadline = clock() + profile.enrollTimeoutSeconds * 1_000;
  const enrollPacer = createPacer({ ratePerMinute: profile.enrollRatePerMinute, clock,
    sleep: (ms) => sleepUntil(ms, controller.signal, sleep) });
  const devices = Array.from({ length: profile.devices }, (_, index) => ({ index, authorization: null,
    nextSlotAt: Number.NEGATIVE_INFINITY, completed: false, stoppedBy: null, retries: 0 }));
  const enrollFailures = {};
  let nextDevice = 0;
  await Promise.all(Array.from({ length: Math.min(profile.enrollConcurrency, profile.devices) }, async () => {
    while (nextDevice < devices.length && !controller.signal.aborted && clock() < enrollDeadline) {
      const device = devices[nextDevice];
      nextDevice += 1;
      await enrollPacer.acquire(null);
      const result = await enrollSyntheticDevice({ fetch: fetchOf(device.index), targetOrigin, deadline: enrollDeadline,
        clock, sleep, signal: controller.signal });
      if (result.ok) device.authorization = result.deviceAuthorization;
      else increment(enrollFailures, result.code);
    }
  }));
  if (fatal !== null) fail(fatal);
  const enrolled = devices.filter((device) => device.authorization !== null);
  const enrollment = { requested: profile.devices, enrolled: enrolled.length,
    notAttempted: profile.devices - Math.min(nextDevice, profile.devices), failedByCode: enrollFailures,
    durationMs: Math.round(recorder.now() - enrollStartedAt) };
  progress(`enrollment: ${enrolled.length}/${profile.devices} devices`);
  if (enrolled.length === 0) fail("LOAD_TEST_ENROLLMENT_FAILED");

  // Sustained v1.2 uploads with the shipped client.
  const { runTelemetryV12Sync } = await import("../../../src/contribution/telemetry-v12-sync.js");
  const { createTelemetryV12Envelope } = await import("../../../src/platform/telemetry-v12-envelope.js");
  phase = "load";
  recorder.markLoadStart();
  const windowMs = profile.durationSeconds * 1_000;
  const loadStart = clock();
  const deadline = loadStart + windowMs;
  const graceMs = profile.passBudgetMs + profile.requestTimeoutMs;
  const pacer = createPacer({ ratePerMinute: profile.ratePerMinute, perDeviceIntervalMs: profile.perDeviceIntervalMs,
    clock, sleep: (ms, wake) => sleep(ms, AbortSignal.any([wake, controller.signal])) });
  const closeTimer = setTimeout(() => pacer.close(), windowMs);
  const abortTimer = setTimeout(() => controller.abort(), windowMs + graceMs);
  const day = deps.day ?? utcDay(loadStart);
  if (!DAY.test(day)) fail("LOAD_TEST_DAY_INVALID");
  const runId = deps.runId ?? randomBytes(8).toString("hex");
  const authorization = { ...ACCOUNTLESS_V12_AUTHORIZATION };
  const staggerMs = 60_000 / profile.ratePerMinute;
  const progressTimer = setInterval(() => {
    progress(`load: ${Math.round((clock() - loadStart) / 1_000)}s, ${recorder.counters.uploadsPaced} uploads paced`);
  }, 30_000);
  progressTimer.unref?.();

  async function deviceLoop(device, position) {
    await sleepUntil(position * staggerMs, controller.signal, sleep);
    const fetchImpl = fetchOf(device.index);
    const readDay = () => syntheticV12Day(day, { chunks: profile.chunksPerDevice, recordsPerChunk: profile.recordsPerChunk,
      eventSeed: `gcp-load-test:${runId}:${device.index}`, parserVersion: LOAD_TEST_PARSER_VERSION });
    // The shipped client runs createEnvelope under its pass budget but cannot
    // cancel it: when the budget ends the pass returns while the envelope is
    // still waiting for its slot. Each pass therefore carries its own signal,
    // aborted when the pass returns, so a reservation it can no longer use is
    // released and an envelope it can no longer send is not counted.
    let pass = null;
    const createEnvelope = async (chunk) => {
      const current = pass;
      try {
        await pacer.acquire(device, current.signal);
      } catch (error) {
        if (error?.code === "LOAD_TEST_WINDOW_CLOSED") {
          current.windowClosed = true;
          recorder.counters.uploadsDeclinedAfterWindow += 1;
        } else if (error?.code === "LOAD_TEST_PASS_ENDED") {
          recorder.counters.reservationsReleasedAtPassEnd += 1;
        }
        throw error;
      }
      const envelope = await createTelemetryV12Envelope({ chunk, publicJwk: key.publicJwk, keyId: key.keyId,
        cryptoImpl: webcrypto });
      if (current.signal.aborted) {
        recorder.counters.envelopesDiscardedAtPassEnd += 1;
        fail("LOAD_TEST_PASS_ENDED");
      }
      // Counted only once the envelope goes back to a pass that is still running.
      recorder.counters.uploadsPaced += 1;
      return envelope;
    };
    while (!controller.signal.aborted && clock() < deadline) {
      const passController = new AbortController();
      pass = { signal: passController.signal, windowClosed: false };
      let outcome;
      try {
        outcome = await runTelemetryV12Sync({
          serverBaseUrl: LABORATORY_ORIGIN, deviceAuthorization: device.authorization, authorization, laboratory: true,
          days: [day], readDay, createEnvelope, fetchImpl, signal: controller.signal,
          maxDurationMs: profile.passBudgetMs, requestTimeoutMs: profile.requestTimeoutMs,
          maxChunks: Math.min(MAX_CHUNKS_PER_PASS, profile.chunksPerDevice),
        });
      } finally {
        passController.abort();
      }
      // The client reports an envelope refused at the window's close as a local
      // index failure; it is the end of the measurement, not a failed pass.
      if (pass.windowClosed && outcome.status !== "complete") {
        recorder.pass({ status: "window_closed", failure: null, chunksUploaded: outcome.chunksUploaded });
        return;
      }
      recorder.pass(outcome);
      if (outcome.chunksUploaded > 0) device.retries = 0;
      if (outcome.status === "complete") {
        device.completed = true;
        return;
      }
      const failure = outcome.failure;
      if (failure === null) continue;
      if (failure.deviceUnavailable || !failure.retryable) {
        device.stoppedBy = failure.code;
        return;
      }
      const wait = failure.retryAfterMilliseconds ?? backoffMs(device.retries);
      device.retries += 1;
      if (clock() + wait >= deadline) return;
      await sleepUntil(wait, controller.signal, sleep);
    }
  }

  let drillSteps = [];
  const drillRun = deps.drill == null ? Promise.resolve()
    : runDrill(deps.drill, { signal: controller.signal, now: () => recorder.now(), sleep, progress })
      .then((steps) => { drillSteps = steps; });

  try {
    await Promise.all([...enrolled.map((device, position) => deviceLoop(device, position)), drillRun]);
  } finally {
    clearTimeout(closeTimer);
    clearTimeout(abortTimer);
    clearInterval(progressTimer);
    pacer.close();
  }
  if (fatal !== null) fail(fatal);
  const measured = recorder.summary({ windowMs, drillSteps });
  const stoppedBy = {};
  for (const device of enrolled) if (device.stoppedBy !== null) increment(stoppedBy, device.stoppedBy);
  return {
    schemaVersion: LOAD_TEST_RECEIPT_SCHEMA,
    generatedAt: new Date(clock()).toISOString(),
    target: { class: options.target.class, hostname: options.target.hostname },
    clientAddresses: deps.clientAddresses ?? 1,
    profile,
    preflight,
    enrollment,
    load: {
      windowMs,
      elapsedMs: Math.round(clock() - loadStart),
      targetPerMinute: profile.ratePerMinute,
      ...measured.uploads,
      targetMet: measured.uploads.achievedPerMinute >= 0.95 * profile.ratePerMinute,
      passes: measured.passes,
      devices: {
        completed: enrolled.filter((device) => device.completed).length,
        stoppedByCode: stoppedBy,
        unfinished: enrolled.filter((device) => !device.completed && device.stoppedBy === null).length,
      },
    },
    routes: measured.routes,
    statusMix: measured.statusMix,
    statusMixByPhase: measured.statusMixByPhase,
    refusalsByCode: measured.refusalsByCode,
    transportFailures: measured.transportFailures,
    drill: measured.drill,
    claimBoundary: [
      "Synthetic, content-free accountless devices and records only.",
      "Measures this target, from these client addresses, at this time; another edge, origin, limit set or region is a separate measurement.",
      "Latency is client-observed and includes the network path to the target.",
      "Not covered: OPS-11's maintenance-pass sub-check (a migration Job meeting a running pass refuses POSTGRES_MIGRATION_CONFLICT, then reruns cleanly); the owner runs it outside this harness.",
    ],
  };
}

/**
 * Run a drill: wait startAfterMs (an abort before then cancels it), then run
 * every step in order until one fails. Once started it ignores the signal, so
 * a completed migrate is always followed by its roll whatever happens to the
 * load. Returns one { id, startMs, endMs, outcome, exitCode } per step run.
 */
export async function runDrill(drill, { signal, now, sleep = defaultSleep, progress = () => {} }) {
  await sleepUntil(drill.startAfterMs, signal, sleep);
  if (signal.aborted) return [];
  const steps = [];
  for (const step of drill.steps) {
    const record = { id: step.id, startMs: Math.round(now()), endMs: null, outcome: null, exitCode: null };
    steps.push(record);
    progress(`drill: ${step.id} started`);
    try {
      const result = await step.run();
      record.exitCode = Number.isSafeInteger(result?.exitCode) ? result.exitCode : null;
      record.outcome = record.exitCode === null || record.exitCode === 0 ? "completed" : "failed";
    } catch {
      record.outcome = "failed";
    }
    record.endMs = Math.round(now());
    progress(`drill: ${step.id} ${record.outcome}`);
    if (record.outcome !== "completed") break;
  }
  return steps;
}

// ---------------------------------------------------------------------------
// The drill file (CLI)

/**
 * Read and validate a drill file: a regular non-symlink file of at most 64
 * KiB holding { schemaVersion, startAfterSeconds, steps: [{ id, argv }] }.
 * Each argv is `scripts/gcp-production-rollout.mjs <migrate|roll> ...` and is
 * checked by that script's own parser, with --environment=staging only.
 */
export async function readDrillFile(path, { durationSeconds, parseRollout = null } = {}) {
  let text;
  try {
    const metadata = await lstat(resolve(path));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DRILL_FILE_BYTES) fail("LOAD_TEST_DRILL_INVALID");
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    if (error instanceof LoadTestError) throw error;
    fail("LOAD_TEST_DRILL_INVALID");
  }
  let value;
  try { value = JSON.parse(text); } catch { fail("LOAD_TEST_DRILL_INVALID"); }
  const exact = (object, keys) => object !== null && typeof object === "object" && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((name) => Object.hasOwn(object, name));
  if (!exact(value, ["schemaVersion", "startAfterSeconds", "steps"]) || value.schemaVersion !== LOAD_TEST_DRILL_SCHEMA
      || !Number.isSafeInteger(value.startAfterSeconds) || value.startAfterSeconds < 0
      || value.startAfterSeconds >= durationSeconds
      || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4) {
    fail("LOAD_TEST_DRILL_INVALID");
  }
  const parse = parseRollout ?? (await import("./gcp-production-rollout.mjs")).parseRolloutArguments;
  const ids = new Set();
  const steps = value.steps.map((step) => {
    if (!exact(step, ["id", "argv"]) || typeof step.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(step.id)
        || ids.has(step.id) || !Array.isArray(step.argv) || step.argv.length < 2 || step.argv.length > 32
        || step.argv.some((argument) => typeof argument !== "string" || argument.length === 0 || argument.length > 512
          || argument.includes("\0"))
        || step.argv[0] !== "scripts/gcp-production-rollout.mjs" || !["migrate", "roll"].includes(step.argv[1])) {
      fail("LOAD_TEST_DRILL_INVALID");
    }
    ids.add(step.id);
    let parsed;
    try { parsed = parse(step.argv.slice(1)); } catch { fail("LOAD_TEST_DRILL_ROLLOUT_INVALID"); }
    if (parsed.environment !== "staging") fail("LOAD_TEST_DRILL_NOT_STAGING");
    return Object.freeze({ id: step.id, argv: Object.freeze([...step.argv]), verb: parsed.verb, execute: parsed.execute });
  });
  return Object.freeze({ startAfterSeconds: value.startAfterSeconds, steps: Object.freeze(steps) });
}

/**
 * A drill step as a child process: node <argv> in the Worker root, no shell,
 * no stdin; its stdout and stderr (the rollout's content-free lines) go to the
 * harness's stderr, so the harness's stdout stays one JSON line. Resolves its
 * exit code. The step is never killed: the load window ending, or the run
 * aborting, must not interrupt a migrate or a roll, so the run waits for it.
 */
export function spawnDrillStep(argv, { spawn = spawnProcess } = {}) {
  return () => new Promise((resolveStep) => {
    let child;
    try {
      child = spawn(process.execPath, [...argv], { cwd: WORKER_ROOT, shell: false, stdio: ["ignore", 2, 2] });
    } catch {
      resolveStep({ exitCode: null });
      return;
    }
    child.on("error", () => resolveStep({ exitCode: null }));
    child.on("close", (code) => resolveStep({ exitCode: Number.isSafeInteger(code) ? code : null }));
  });
}

// ---------------------------------------------------------------------------
// CLI

/**
 * The receipt directory, made ready before the first request: created 0700
 * when missing; otherwise a real directory (not a symlink) owned by this user
 * with no group or other access. A probe file is created and removed to prove
 * it is writable. Returns the absolute path. With create: false and probe:
 * false (at write time) it only re-checks an existing directory.
 */
export async function prepareReceiptDirectory(out, { create = true, probe = true } = {}) {
  if (typeof out !== "string" || out.length === 0) fail("LOAD_TEST_OUT_INVALID");
  const directory = resolve(out);
  let metadata = null;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) fail("LOAD_TEST_OUT_INVALID");
  }
  if (metadata === null) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      metadata = await lstat(directory);
    } catch {
      fail("LOAD_TEST_OUT_INVALID");
    }
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("LOAD_TEST_OUT_INVALID");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) fail("LOAD_TEST_OUT_NOT_PRIVATE");
  if (probe) {
    const path = join(directory, `.gcp-load-test-probe-${randomBytes(8).toString("hex")}`);
    try {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
      await unlink(path);
    } catch {
      fail("LOAD_TEST_OUT_UNWRITABLE");
    }
  }
  return directory;
}

/** Writes the receipt 0600 (never over an existing file) after re-checking its directory. */
export async function writeReceipt(out, receipt) {
  const directory = await prepareReceiptDirectory(out, { create: false, probe: false });
  const path = join(directory, `gcp-load-test-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const options = parseLoadTestArguments(argv);
  const drill = options.drill === null ? null
    : await readDrillFile(options.drill, { durationSeconds: options.profile.durationSeconds,
      parseRollout: deps.parseRollout ?? null });
  if (!options.execute) {
    let limits = null;
    let limitsUnavailable = false;
    try { limits = await (deps.readLimits ?? readCommittedAdmissionLimits)(); } catch { limitsUnavailable = true; }
    const plan = loadTestPlan(options, { limits, limitsUnavailable });
    if (drill !== null) {
      plan.drill = { startAfterSeconds: drill.startAfterSeconds,
        steps: drill.steps.map(({ id, verb, execute }) => ({ id, verb, execute })) };
    }
    stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  // A receipt directory that cannot hold the receipt is refused before any request.
  const out = await prepareReceiptDirectory(options.out);
  const receipt = await runLoadTest(options, {
    ...deps,
    drill: drill === null ? deps.drill ?? null : {
      startAfterMs: drill.startAfterSeconds * 1_000,
      steps: drill.steps.map((step) => ({ id: step.id, run: spawnDrillStep(step.argv, deps) })),
    },
    progress: deps.progress ?? ((line) => stderr.write(`${JSON.stringify({ status: "progress", line })}\n`)),
  });
  const path = await (deps.writeReceipt ?? writeReceipt)(out, receipt);
  stdout.write(`${JSON.stringify({ status: "ok", target: receipt.target.class, acceptedInWindow: receipt.load.acceptedInWindow,
    achievedPerMinute: receipt.load.achievedPerMinute, targetMet: receipt.load.targetMet, receipt: path })}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const refusal = error instanceof LoadTestError;
    process.stderr.write(`${JSON.stringify({ status: "error", code: refusal ? error.code : "LOAD_TEST_FAILED" })}\n`);
    process.exitCode = refusal ? 2 : 1;
  });
}
