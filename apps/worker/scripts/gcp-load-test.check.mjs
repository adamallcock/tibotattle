// Offline checks for scripts/gcp-load-test.mjs (OPS-11) and the request
// builders it reuses from scripts/edge-live-check.mjs: no network, no
// PostgreSQL, no Miniflare, no child process. The default is a dry run that
// makes no request; production hostnames are refused outright and run.app
// origins too; every non-staging target is explicit; execution needs the exact
// authorization; the recording fetch never leaves the target, labels refusals
// by closed code and keeps the receipt content-free; the drill accepts only
// staging OPS-10 rollout steps and never kills one. The end-to-end run is
// postgres-test/gcp-load-test.spec.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
  parseTelemetryV12DayManifest,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  validateTelemetryV12DayUsageOrder,
} from "@app-usagemonitor/telemetry-contract";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { EDGE_MODE_PRODUCTION_HOSTNAMES } from "./edge-mode-configuration.mjs";
import {
  ACCOUNTLESS_V12_AUTHORIZATION,
  LABORATORY_ORIGIN,
  accountlessDeviceRequests,
  liveWriteRows,
  syntheticV12Day,
} from "./edge-live-check.mjs";
import {
  LOAD_TEST_DEFAULTS,
  LOAD_TEST_PRODUCTION_HOSTNAMES,
  LoadTestError,
  classifyLoadTestTarget,
  createLoadRecorder,
  createPacer,
  createRecordingFetch,
  enrollSyntheticDevice,
  errorCodeOf,
  loadTestPlan,
  main,
  parseLoadTestArguments,
  predictAdmission,
  readCommittedAdmissionLimits,
  readDrillFile,
  routeLabel,
  runDrill,
  runLoadTest,
  spawnDrillStep,
  statusLabel,
  summarizeSamples,
  transportKind,
} from "./gcp-load-test.mjs";

const STAGING = DEPLOYMENT_ENDPOINTS.staging.origin;
const STAGING_HOST = new URL(STAGING).hostname;

function refusal(code, work) {
  return assert.throws(work, (error) => error instanceof LoadTestError && error.code === code, code);
}

async function rejection(code, work) {
  await assert.rejects(work, (error) => error instanceof LoadTestError && error.code === code, code);
}

function sink() {
  const chunks = [];
  return { write: (text) => { chunks.push(text); return true; }, text: () => chunks.join("") };
}

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

// ---------------------------------------------------------------------------
// The reused builders (edge-live-check.mjs)

test("syntheticV12Day: the default is the live check's one-record day; more chunks stay a valid ordered day", async () => {
  const day = "2026-10-02";
  const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
  const single = await syntheticV12Day(day);
  // The live check's original construction, byte for byte.
  const [record] = single.chunks[0].records;
  assert.equal(record.eventId, `event:v2:${sha256Hex(`edge-live-check:${day}`)}`);
  assert.equal(record.eventTime, `${day}T12:00:00.000Z`);
  assert.equal(single.manifest.parserVersion, "synthetic-edge-live-check");
  assert.equal(single.chunks[0].chunkId, `usage:${day}:0`);
  assert.equal(single.chunks[0].chunkDigest, sha256Hex(Buffer.from(canonicalTelemetryV12Json([record]))));
  assert.deepEqual(single.manifest.chunks, [{ chunkId: `usage:${day}:0`, chunkDigest: single.chunks[0].chunkDigest,
    recordCount: 1 }]);
  assert.deepEqual(single.chunks[0].consent, telemetryV12RequiredConsent());
  const many = await syntheticV12Day(day, { chunks: 5, recordsPerChunk: 3, eventSeed: "gcp-load-test:x:1",
    parserVersion: "synthetic-gcp-load-test" });
  assert.deepEqual(many.chunks.map((chunk) => chunk.chunkId), [0, 1, 2, 3, 4].map((n) => `usage:${day}:${n}`));
  assert.equal(parseTelemetryV12DayManifest(many.manifest).manifestDigest,
    sha256Hex(Buffer.from(telemetryV12DayManifestDigestInput(many.manifest))));
  for (const chunk of many.chunks) {
    assert.equal(parseTelemetryV12Chunk(chunk).manifestDigest, many.manifest.manifestDigest);
    assert.equal(chunk.records.length, 3);
  }
  const records = many.chunks.flatMap((chunk) => chunk.records);
  assert.equal(validateTelemetryV12DayUsageOrder(day, records).length, 15);
  assert.equal(new Set(records.map((value) => value.eventId)).size, 15);
  const other = await syntheticV12Day(day, { chunks: 5, recordsPerChunk: 3, eventSeed: "gcp-load-test:x:2" });
  assert.notEqual(other.chunks[0].records[0].eventId, records[0].eventId, "the seed separates devices");
  await assert.rejects(() => syntheticV12Day(day, { chunks: 4_097 }), RangeError);
  await assert.rejects(() => syntheticV12Day(day, { recordsPerChunk: 201 }), RangeError);
});

test("accountlessDeviceRequests: three closed admission requests bound to one fresh device credential", () => {
  const first = accountlessDeviceRequests();
  const second = accountlessDeviceRequests();
  assert.notEqual(first.deviceAuthorization, second.deviceAuthorization);
  assert.deepEqual(first.requests.map(({ id, path }) => [id, path]), [
    ["accountless-enrollment", "/api/v1/accountless/enrollment"],
    ["accountless-ownership", "/api/v1/accountless/ownership"],
    ["accountless-v12-authorization", "/api/v1/accountless/telemetry-v1.2-authorization"],
  ]);
  const match = /^Device um_device_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(first.deviceAuthorization);
  assert.ok(match);
  const enrollment = JSON.parse(first.requests[0].init.body);
  const secretHash = createHash("sha256").update(`app-usagemonitor/device/v1\0${match[1]}\0`)
    .update(Buffer.from(match[2], "base64url")).digest("hex");
  assert.deepEqual(enrollment, { schemaVersion: "accountless-enrollment-v0.1", deviceId: match[1],
    deviceSecretHash: secretHash, policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" });
  assert.equal(first.requests[0].init.headers.authorization, undefined, "enrollment carries no bearer");
  assert.equal(first.requests[0].init.body.includes(match[2]), false, "the secret never leaves in a body");
  for (const request of first.requests.slice(1)) {
    assert.equal(request.init.headers.authorization, first.deviceAuthorization);
  }
  assert.deepEqual(JSON.parse(first.requests[2].init.body), { ...ACCOUNTLESS_V12_AUTHORIZATION });
});

test("liveWriteRows still sends the three admission rows first, under their write- ids, with one device bearer",
  async () => {
    const sent = [];
    const send = async (id, path, init = {}) => {
      sent.push({ id, path, method: init.method ?? "GET", authorization: new Headers(init.headers ?? {}).get("authorization"),
        body: init.body });
      if (sent.length > 3) throw new Error("synthetic stop after the admission rows");
      return { answer: { status: 201, headers: [["content-type", "application/json"]], body: Buffer.from("{}") } };
    };
    await assert.rejects(() => liveWriteRows({ send, publicOrigin: "https://tibotattle.test" }),
      (error) => error.code === "EDGE_LIVE_CHECK_V12_SYNC_INCOMPLETE");
    assert.deepEqual(sent.slice(0, 3).map(({ id, path, method }) => [id, path, method]), [
      ["write-accountless-enrollment", "/api/v1/accountless/enrollment", "POST"],
      ["write-accountless-ownership", "/api/v1/accountless/ownership", "POST"],
      ["write-accountless-v12-authorization", "/api/v1/accountless/telemetry-v1.2-authorization", "POST"],
    ]);
    assert.equal(sent[0].authorization, null);
    assert.match(sent[1].authorization, /^Device um_device_/u);
    assert.equal(sent[2].authorization, sent[1].authorization);
    assert.equal(sent[3].id, "write-v12-sync-1", "then the shipped client's first request");
    assert.equal(sent[3].authorization, sent[1].authorization);
  });

// ---------------------------------------------------------------------------
// Target, arguments and the dry run

test("the default is a dry run against the reviewed staging origin with the OPS-11 profile", () => {
  const options = parseLoadTestArguments([]);
  assert.equal(options.execute, false);
  assert.equal(options.explicitTarget, false);
  assert.deepEqual({ ...options.target }, { origin: STAGING, hostname: STAGING_HOST, class: "staging" });
  assert.equal(options.expectedDestinationOrigin, STAGING);
  assert.equal(options.profile.ratePerMinute, 3_000);
  assert.equal(options.profile.devices, 600);
  assert.equal(options.profile.chunksPerDevice, 50);
  assert.equal(options.profile.plannedUploads, 30_000);
  assert.equal(options.profile.perDeviceIntervalMs, 12_000);
  assert.equal(options.profile.chunksPerPass, 20);
  assert.equal(options.profile.passesPerDeviceEstimate, 3);
  assert.equal(options.profile.chunksPerDeviceSource, "derived_from_rate_and_window");
  assert.deepEqual(Object.keys(LOAD_TEST_DEFAULTS).sort(), ["devices", "durationSeconds", "enrollConcurrency",
    "enrollRatePerMinute", "enrollTimeoutSeconds", "passBudgetMs", "ratePerMinute", "recordsPerChunk",
    "requestTimeoutMs"]);
});

test("production hostnames are refused outright, whatever else is given", () => {
  for (const host of EDGE_MODE_PRODUCTION_HOSTNAMES) {
    assert.ok(LOAD_TEST_PRODUCTION_HOSTNAMES.includes(host), `${host} is in the refusal list`);
  }
  assert.ok(LOAD_TEST_PRODUCTION_HOSTNAMES.includes("app-usagemonitor.adamallcock.workers.dev"));
  assert.equal(LOAD_TEST_PRODUCTION_HOSTNAMES.includes(STAGING_HOST), false);
  const variants = (host) => [`https://${host}`, `https://${host.toUpperCase()}`, `https://${host}.`,
    `https://${host}:8443`, `http://${host}`];
  for (const host of [...LOAD_TEST_PRODUCTION_HOSTNAMES, "0123abcd-app-usagemonitor.adamallcock.workers.dev"]) {
    for (const target of variants(host)) {
      refusal("LOAD_TEST_TARGET_PRODUCTION", () => classifyLoadTestTarget(target));
      refusal("LOAD_TEST_TARGET_PRODUCTION", () => parseLoadTestArguments([`--target=${target}`, "--execute",
        `--authorize=GCP_LOAD_TEST:${host}`, "--out=/tmp/x"]));
    }
  }
  refusal("LOAD_TEST_ARGUMENT_INVALID", () => parseLoadTestArguments(["--target=https://staging.example.test",
    "--expected-destination-origin=https://tibotattle.com"]));
});

test("run.app origins, http: off loopback, IP literals, paths and credentials are refused", () => {
  for (const [target, code] of [
    ["https://tibotattle-staging-origin-806510610397.us-east1.run.app", "LOAD_TEST_TARGET_ORIGIN_DIRECT"],
    ["https://tibotattle-origin-abc.a.run.app", "LOAD_TEST_TARGET_ORIGIN_DIRECT"],
    ["http://staging.example.test", "LOAD_TEST_TARGET_INVALID"],
    ["https://203.0.113.7", "LOAD_TEST_TARGET_INVALID"],
    ["https://[2001:db8::1]", "LOAD_TEST_TARGET_INVALID"],
    ["https://staging.example.test/api", "LOAD_TEST_TARGET_INVALID"],
    ["https://staging.example.test/?x=1", "LOAD_TEST_TARGET_INVALID"],
    ["https://user:pass@staging.example.test", "LOAD_TEST_TARGET_INVALID"],
    ["ftp://staging.example.test", "LOAD_TEST_TARGET_INVALID"],
    ["not a url", "LOAD_TEST_TARGET_INVALID"],
  ]) {
    refusal(code, () => classifyLoadTestTarget(target));
  }
  assert.equal(classifyLoadTestTarget("http://127.0.0.1:8792").class, "loopback");
  assert.equal(classifyLoadTestTarget("http://[::1]:8792").class, "loopback");
  assert.equal(classifyLoadTestTarget("https://staging-edge.example.test").class, "other");
  assert.equal(classifyLoadTestTarget(STAGING).class, "staging");
});

test("execution needs the exact authorization for its target and a receipt directory", () => {
  refusal("LOAD_TEST_AUTHORIZATION_REQUIRED", () => parseLoadTestArguments(["--execute", "--out=/tmp/x"]));
  refusal("LOAD_TEST_AUTHORIZATION_MISMATCH", () => parseLoadTestArguments(["--authorize=GCP_LOAD_TEST:other.test"]));
  refusal("LOAD_TEST_AUTHORIZATION_MISMATCH", () => parseLoadTestArguments(["--execute", "--out=/tmp/x",
    `--authorize=${STAGING_HOST}`]));
  refusal("LOAD_TEST_OUT_REQUIRED", () => parseLoadTestArguments(["--execute",
    `--authorize=GCP_LOAD_TEST:${STAGING_HOST}`]));
  const staged = parseLoadTestArguments(["--execute", `--authorize=GCP_LOAD_TEST:${STAGING_HOST}`, "--out=/tmp/x"]);
  assert.equal(staged.execute, true);
  const other = ["--target=https://staging-edge.example.test", "--execute", "--out=/tmp/x"];
  refusal("LOAD_TEST_AUTHORIZATION_REQUIRED", () => parseLoadTestArguments(other));
  assert.equal(parseLoadTestArguments([...other, "--authorize=GCP_LOAD_TEST:staging-edge.example.test"]).target.class,
    "other");
  assert.equal(parseLoadTestArguments(["--target=http://127.0.0.1:8792", "--execute", "--out=/tmp/x"]).execute, true);
});

test("arguments are closed, bounded and unique", () => {
  for (const argv of [["--unknown=1"], ["--rate"], ["--rate=1", "--rate=2"], ["--execute", "--execute"], ["plan"],
    ["--rate=0"], ["--rate=1.5"], ["--rate=-1"], ["--devices=01"]]) {
    assert.throws(() => parseLoadTestArguments(argv), LoadTestError, JSON.stringify(argv));
  }
  refusal("LOAD_TEST_ARGUMENT_OUT_OF_RANGE", () => parseLoadTestArguments(["--rate=30001"]));
  refusal("LOAD_TEST_ARGUMENT_OUT_OF_RANGE", () => parseLoadTestArguments(["--devices=5001"]));
  refusal("LOAD_TEST_ARGUMENT_OUT_OF_RANGE", () => parseLoadTestArguments(["--records-per-chunk=201"]));
  refusal("LOAD_TEST_PROFILE_CHUNKS_EXCEED_DAY", () => parseLoadTestArguments(["--rate=30000", "--devices=1",
    "--duration=60"]));
  const explicit = parseLoadTestArguments(["--uploads-per-device=7", "--devices=10", "--rate=60"]);
  assert.equal(explicit.profile.chunksPerDevice, 7);
  assert.equal(explicit.profile.chunksPerDeviceSource, "explicit");
  assert.equal(explicit.profile.perDeviceIntervalMs, 10_000);
});

test("main without --execute prints the plan and makes no request", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("no request in a dry run"); };
  try {
    const stdout = sink();
    const limits = { staging: { CLIENT_ATTEMPT_RATE_LIMIT: 5, UPLOAD_INGRESS_BUDGET: 120 } };
    const plan = await main(["--rate=600"], { stdout, readLimits: async () => limits,
      fetchFor: () => { throw new Error("no request in a dry run"); } });
    assert.equal(plan.mode, "dry_run");
    assert.equal(JSON.parse(stdout.text()).schemaVersion, "gcp-load-test-plan-v1");
    assert.equal(plan.authorization, "required_to_execute");
    assert.ok(plan.admission.staging.refusedBy.includes("UPLOAD_INGRESS_BUDGET/upload_ingress"));
    const unavailable = await main([], { stdout: sink(), readLimits: async () => { throw new Error("x"); } });
    assert.equal(unavailable.admission, null);
    assert.equal(unavailable.admissionPrediction, "unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Admission prediction

test("the committed limits: staging edge and origin tiers and both ingress budgets", async () => {
  const limits = await readCommittedAdmissionLimits();
  assert.equal(limits.staging.CLIENT_ATTEMPT_RATE_LIMIT, 5);
  assert.equal(limits.staging.UPLOAD_INGRESS_CLIENT_RATE_LIMIT, 20);
  assert.equal(limits.staging.UPLOAD_AUTHORIZATION_RATE_LIMIT, 300);
  assert.equal(limits.staging.UPLOAD_PRINCIPAL_RATE_LIMIT, 6);
  assert.equal(limits.staging.UPLOAD_INGRESS_BUDGET, 120);
  assert.equal(limits.production.UPLOAD_AUTHORIZATION_RATE_LIMIT, 3_000);
  assert.equal(limits.production.UPLOAD_INGRESS_BUDGET, 1_200);
  const profile = parseLoadTestArguments([]).profile;
  const staging = predictAdmission(profile, limits.staging);
  const byKey = Object.fromEntries(staging.map((row) => [`${row.binding}/${row.purpose}`, row]));
  assert.equal(byKey["UPLOAD_PRINCIPAL_RATE_LIMIT/upload_authorization"].exceeds, false, "5 a minute per device");
  assert.equal(byKey["UPLOAD_AUTHORIZATION_RATE_LIMIT/upload_authorization"].exceeds, true);
  assert.equal(byKey["CLIENT_ATTEMPT_RATE_LIMIT/device_sync"].demandPerMinute, 900);
  const spread = predictAdmission(profile, limits.staging, { clientAddresses: 600 });
  assert.equal(spread.find((row) => row.binding === "CLIENT_ATTEMPT_RATE_LIMIT" && row.purpose === "device_sync")
    .demandPerMinute, 1.5);
  const plan = loadTestPlan(parseLoadTestArguments([]), { limits });
  assert.ok(plan.admission.production.refusedBy.includes("UPLOAD_INGRESS_BUDGET/upload_ingress"),
    "3,000 a minute exceeds the committed production ingress budget");
  assert.equal(predictAdmission(profile, {})[0].exceeds, null, "an unknown limit is not a verdict");
});

// ---------------------------------------------------------------------------
// Pacing

test("pacing: one slot per 60000/rate ms overall, per-device spacing, no burst credit after idle", async () => {
  const pacer = createPacer({ ratePerMinute: 3_000, perDeviceIntervalMs: 12_000 });
  const a = { nextSlotAt: Number.NEGATIVE_INFINITY };
  const b = { nextSlotAt: Number.NEGATIVE_INFINITY };
  assert.equal(pacer.reserve(a, 1_000), 1_000);
  assert.equal(pacer.reserve(b, 1_000), 1_020);
  assert.equal(pacer.reserve(a, 1_000), 13_000, "the device waits its own interval");
  assert.equal(pacer.reserve(b, 100_000), 100_000, "idle time is not saved up");
  assert.equal(pacer.reserve(null, 100_000), 100_020);
  let now = 0;
  const waits = [];
  const timed = createPacer({ ratePerMinute: 60, clock: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  await timed.acquire(null);
  await timed.acquire(null);
  await timed.acquire(null);
  assert.deepEqual(waits, [1_000, 1_000]);
  timed.close();
  await rejection("LOAD_TEST_WINDOW_CLOSED", () => timed.acquire(null));
});

// ---------------------------------------------------------------------------
// Recording

test("labels: routes, closed error codes and transport kinds; never other body content", () => {
  assert.equal(routeLabel("POST", "/api/v1/contributions"), "contribution");
  assert.equal(routeLabel("POST", "/api/v1/device/upload-authorizations"), "upload_authorization");
  assert.equal(routeLabel("GET", "/api/v1/contributions"), "other");
  assert.equal(errorCodeOf(Buffer.from('{"error":{"code":"POSTGRES_ROUTE_NOT_PORTED","requestId":"r"}}')),
    "POSTGRES_ROUTE_NOT_PORTED");
  assert.equal(errorCodeOf(Buffer.from('{"error":{"code":"lowercase secret value"}}')), null);
  assert.equal(errorCodeOf(Buffer.from("<html>")), null);
  assert.equal(statusLabel({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" }), "503:BACKEND_STORAGE_UNAVAILABLE");
  assert.equal(statusLabel({ status: 201, code: "IGNORED" }), "201");
  assert.equal(statusLabel({ status: 502 }), "502");
  assert.equal(statusLabel({ transport: "refused" }), "transport:refused");
  assert.equal(transportKind(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "refused");
  assert.equal(transportKind(Object.assign(new Error("x"), { name: "AbortError" })), "aborted");
  assert.equal(transportKind(new Error("anything at all")), "other");
});

test("the recording fetch maps the laboratory origin, records codes and rewrites only the capability destination",
  async () => {
    const target = "https://staging-edge.example.test";
    const recorder = createLoadRecorder();
    const fatal = [];
    const seen = [];
    const answers = new Map([
      ["/api/v1/device/sync-capabilities-v1.2", () => jsonResponse(200, { destinationOrigin: target, other: 1 })],
      ["/api/v1/admin/x", () => jsonResponse(503, { error: { code: "POSTGRES_ROUTE_NOT_PORTED" } })],
      ["/api/v1/device/upload-authorizations", () => jsonResponse(503, { error: { code: "BACKEND_STORAGE_UNAVAILABLE" } })],
      ["/api/v1/contributions", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }],
      ["/big", () => new Response("x".repeat(10), { status: 200, headers: { "content-length": String(3 * 1_024 * 1_024) } })],
    ]);
    const fetch = createRecordingFetch({
      fetch: async (url, init) => {
        seen.push({ url, method: init.method, redirect: init.redirect });
        return answers.get(new URL(url).pathname)();
      },
      targetOrigin: target, expectedDestinationOrigin: target, recorder, phase: () => "load",
      onFatal: (code) => fatal.push(code),
    });
    const capability = await fetch(`${LABORATORY_ORIGIN}/api/v1/device/sync-capabilities-v1.2`, { method: "GET" });
    assert.deepEqual(await capability.json(), { destinationOrigin: LABORATORY_ORIGIN, other: 1 });
    assert.equal(capability.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${target}/api/v1/admin/x`)).status, 503);
    const refused = await fetch(`${LABORATORY_ORIGIN}/api/v1/device/upload-authorizations`, { method: "POST", body: "{}" });
    assert.equal((await refused.json()).error.code, "BACKEND_STORAGE_UNAVAILABLE", "the client still sees the body");
    await assert.rejects(() => fetch(`${LABORATORY_ORIGIN}/api/v1/contributions`, { method: "POST", body: "{}" }));
    await rejection("LOAD_TEST_RESPONSE_OVERSIZE", () => fetch(`${target}/big`));
    assert.ok(seen.every((entry) => entry.url.startsWith(`${target}/`) && entry.redirect === "manual"));
    await rejection("LOAD_TEST_OUTBOUND_REFUSED", () => fetch("https://tibotattle.com/api/health"));
    assert.deepEqual(fatal, ["LOAD_TEST_OUTBOUND_REFUSED"]);
    const summary = recorder.summary({ windowMs: 60_000 });
    assert.deepEqual(summary.statusMix, { 200: 1, "503:POSTGRES_ROUTE_NOT_PORTED": 1,
      "503:BACKEND_STORAGE_UNAVAILABLE": 1, "transport:reset": 1, "transport:oversize": 1 });
    assert.deepEqual(summary.refusalsByCode, { POSTGRES_ROUTE_NOT_PORTED: 1, BACKEND_STORAGE_UNAVAILABLE: 1 });
    assert.deepEqual(summary.transportFailures, { reset: 1, oversize: 1 });
    // A capability answer for another destination aborts the run.
    const wrong = createRecordingFetch({ fetch: async () => jsonResponse(200, { destinationOrigin: "https://x.test" }),
      targetOrigin: target, expectedDestinationOrigin: target, recorder, phase: () => "load",
      onFatal: (code) => fatal.push(code) });
    await rejection("LOAD_TEST_DESTINATION_UNEXPECTED",
      () => wrong(`${LABORATORY_ORIGIN}/api/v1/device/sync-capabilities-v1.2`));
    assert.equal(fatal.at(-1), "LOAD_TEST_DESTINATION_UNEXPECTED");
  });

test("summary: refusals exclude the preflight, uploads per minute, and drill windows", () => {
  const sample = (atMs, phase, route, label, ok, code = null) => ({ atMs, phase, route, label, ok, code,
    transport: null, latencyMs: 10 });
  const samples = [
    sample(0, "preflight", "ready", "503", false),
    sample(10, "enrollment", "accountless_enrollment", "429:ATTEMPT_LIMIT_REACHED", false, "ATTEMPT_LIMIT_REACHED"),
    sample(1_000, "load", "contribution", "202", true),
    sample(61_000, "load", "contribution", "202", true),
    sample(70_000, "load", "upload_authorization", "503:BACKEND_STORAGE_UNAVAILABLE", false, "BACKEND_STORAGE_UNAVAILABLE"),
    sample(90_000, "load", "contribution", "202", true),
    sample(130_000, "load", "contribution", "202", true),
  ];
  const summary = summarizeSamples({ samples, passes: [{ status: "complete", failure: null },
    { status: "failed", failure: "service_unavailable" }], counters: { uploadsPaced: 5, uploadsDeclinedAfterWindow: 0 },
  loadStartedAt: 500, windowMs: 120_000, drillSteps: [{ id: "migrate", startMs: 65_000, endMs: 75_000 },
    { id: "roll", startMs: 75_000, endMs: 80_000 }] });
  assert.deepEqual(summary.refusalsByCode, { ATTEMPT_LIMIT_REACHED: 1, BACKEND_STORAGE_UNAVAILABLE: 1 });
  assert.deepEqual(summary.statusMixByPhase.preflight, { 503: 1 });
  assert.equal(summary.uploads.accepted, 4);
  assert.equal(summary.uploads.acceptedInWindow, 3);
  assert.deepEqual(summary.uploads.perMinute, [1, 2]);
  assert.equal(summary.uploads.achievedPerMinute, 1.5);
  assert.deepEqual(summary.passes, { complete: 1, partial: 0, failed: 1, byFailureCode: { service_unavailable: 1 } });
  assert.deepEqual(summary.drill.windowMs, { from: 65_000, to: 80_000 });
  assert.equal(summary.drill.before.contributionsAccepted, 2);
  assert.deepEqual(summary.drill.during.statusMix, { "503:BACKEND_STORAGE_UNAVAILABLE": 1 });
  assert.equal(summary.drill.after.contributionsAccepted, 2);
});

// ---------------------------------------------------------------------------
// Enrollment and the run's refusals

test("enrollment retries 429 and 5xx after Retry-After within its deadline and stops on a closed code", async () => {
  const signal = new AbortController().signal;
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const script = [jsonResponse(429, { error: { code: "ATTEMPT_LIMIT_REACHED" } }, { "retry-after": "2" }),
    jsonResponse(201, {}), jsonResponse(503, { error: { code: "BACKEND_STORAGE_UNAVAILABLE" } }),
    jsonResponse(201, {}), jsonResponse(201, {})];
  const paths = [];
  const ok = await enrollSyntheticDevice({ fetch: async (url) => { paths.push(new URL(url).pathname); return script.shift(); },
    targetOrigin: "https://t.test", deadline: Date.now() + 600_000, sleep, signal });
  assert.equal(ok.ok, true);
  assert.match(ok.deviceAuthorization, /^Device um_device_/u);
  assert.deepEqual(paths, ["/api/v1/accountless/enrollment", "/api/v1/accountless/enrollment",
    "/api/v1/accountless/ownership", "/api/v1/accountless/ownership", "/api/v1/accountless/telemetry-v1.2-authorization"]);
  assert.equal(waits[0], 2_000);
  const rejected = await enrollSyntheticDevice({ fetch: async () => jsonResponse(400, { error: { code: "BODY_INVALID" } }),
    targetOrigin: "https://t.test", deadline: Date.now() + 600_000, sleep, signal });
  assert.deepEqual(rejected, { ok: false, code: "accountless-enrollment:400" });
  const late = await enrollSyntheticDevice({ fetch: async () => jsonResponse(429, {}, { "retry-after": "60" }),
    targetOrigin: "https://t.test", deadline: Date.now() + 10_000, sleep, signal });
  assert.deepEqual(late, { ok: false, code: "accountless-enrollment:429" });
});

test("runLoadTest refuses without --execute and stops at an unhealthy target or a missing envelope key", async () => {
  await rejection("LOAD_TEST_EXECUTE_REQUIRED", () => runLoadTest(parseLoadTestArguments([])));
  const options = parseLoadTestArguments(["--target=http://127.0.0.1:9", "--execute", "--out=/tmp/x", "--devices=1",
    "--rate=1"]);
  await rejection("LOAD_TEST_TARGET_UNHEALTHY", () => runLoadTest(options, {
    fetchFor: () => async () => jsonResponse(503, { error: { code: "BACKEND_STORAGE_UNAVAILABLE" } }) }));
  await rejection("LOAD_TEST_TARGET_UNREACHABLE", () => runLoadTest(options, {
    fetchFor: () => async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }));
  await rejection("LOAD_TEST_ENVELOPE_KEY_UNAVAILABLE", () => runLoadTest(options, {
    fetchFor: () => async (url) => jsonResponse(new URL(url).pathname === "/api/v1/envelope-key" ? 404 : 200, {}) }));
  const stderr = sink();
  await rejection("LOAD_TEST_TARGET_UNHEALTHY", () => main(["--target=http://127.0.0.1:9", "--execute", "--out=/tmp/x",
    "--devices=1", "--rate=1"], { stdout: sink(), stderr, fetchFor: () => async () => jsonResponse(500, {}) }));
});

// ---------------------------------------------------------------------------
// The drill

test("drill files: staging OPS-10 migrate and roll steps only, closed shape, no symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-load-test-drill-"));
  try {
    const commit = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    const step = (verb, environment = "staging") => ["scripts/gcp-production-rollout.mjs", verb,
      `--environment=${environment}`, `--commit=${commit}`, `--digest=${digest}`, "--backup-audit=/private/audit.json",
      "--migrate-receipt=/private/migrate.json", ...(verb === "roll" ? ["--edge-live=/private/edge.json"] : []),
      `--authorize=${verb}:${environment}:${digest}`, "--execute"];
    const write = async (name, value) => {
      const path = join(directory, name);
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
      return path;
    };
    const good = await write("good.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 120,
      steps: [{ id: "migrate", argv: step("migrate") }, { id: "roll", argv: step("roll") }] });
    const drill = await readDrillFile(good, { durationSeconds: 600 });
    assert.deepEqual(drill.steps.map(({ id, verb, execute }) => [id, verb, execute]),
      [["migrate", "migrate", true], ["roll", "roll", true]]);
    for (const [name, value, code] of [
      ["production.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1,
        steps: [{ id: "migrate", argv: step("migrate", "production") }] }, "LOAD_TEST_DRILL_NOT_STAGING"],
      ["script.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1,
        steps: [{ id: "x", argv: ["scripts/gcp-infra.mjs", "migrate"] }] }, "LOAD_TEST_DRILL_INVALID"],
      ["verb.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1,
        steps: [{ id: "build", argv: ["scripts/gcp-production-rollout.mjs", "build", "--environment=staging",
          `--commit=${commit}`] }] }, "LOAD_TEST_DRILL_INVALID"],
      ["unauthorized.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1,
        steps: [{ id: "migrate", argv: step("migrate").map((value) => value.startsWith("--authorize=")
          ? "--authorize=migrate:staging:sha256:0" : value) }] }, "LOAD_TEST_DRILL_ROLLOUT_INVALID"],
      ["late.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 600,
        steps: [{ id: "migrate", argv: step("migrate") }] }, "LOAD_TEST_DRILL_INVALID"],
      ["extra.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1, extra: true,
        steps: [{ id: "migrate", argv: step("migrate") }] }, "LOAD_TEST_DRILL_INVALID"],
      ["duplicate.json", { schemaVersion: "gcp-load-test-drill-v1", startAfterSeconds: 1,
        steps: [{ id: "migrate", argv: step("migrate") }, { id: "migrate", argv: step("roll") }] },
      "LOAD_TEST_DRILL_INVALID"],
      ["text.json", "not json", "LOAD_TEST_DRILL_INVALID"],
    ]) {
      await rejection(code, async () => readDrillFile(await write(name, value), { durationSeconds: 600 }));
    }
    const link = join(directory, "link.json");
    await symlink(good, link);
    await rejection("LOAD_TEST_DRILL_INVALID", () => readDrillFile(link, { durationSeconds: 600 }));
    // A dry run with a drill file shows the steps without running them.
    const plan = await main([`--drill=${good}`], { stdout: sink(), readLimits: async () => null });
    assert.deepEqual(plan.drill, { startAfterSeconds: 120, steps: [{ id: "migrate", verb: "migrate", execute: true },
      { id: "roll", verb: "roll", execute: true }] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a started drill runs every step until one fails, even after the load aborts; an unstarted one never runs",
  async () => {
    let now = 0;
    const ran = [];
    const controller = new AbortController();
    const steps = await runDrill({ startAfterMs: 5, steps: [
      { id: "migrate", run: async () => { ran.push("migrate"); controller.abort(); now += 7; return { exitCode: 0 }; } },
      { id: "roll", run: async () => { ran.push("roll"); now += 3; return { exitCode: 0 }; } },
    ] }, { signal: controller.signal, now: () => now, sleep: async () => {} });
    assert.deepEqual(ran, ["migrate", "roll"], "the roll follows its migrate although the load aborted");
    assert.deepEqual(steps, [{ id: "migrate", startMs: 0, endMs: 7, outcome: "completed", exitCode: 0 },
      { id: "roll", startMs: 7, endMs: 10, outcome: "completed", exitCode: 0 }]);
    const failed = await runDrill({ startAfterMs: 0, steps: [
      { id: "migrate", run: async () => ({ exitCode: 4 }) },
      { id: "roll", run: async () => { throw new Error("must not run"); } },
    ] }, { signal: new AbortController().signal, now: () => 0, sleep: async () => {} });
    assert.deepEqual(failed.map(({ id, outcome, exitCode }) => [id, outcome, exitCode]), [["migrate", "failed", 4]]);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await runDrill({ startAfterMs: 1_000, steps: [{ id: "migrate", run: async () => {
      throw new Error("must not run"); } }] }, { signal: aborted.signal, now: () => 0, sleep: async () => {} }), []);
  });

test("a drill step runs node with its argv, no shell and no signal, and is never killed", async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => { throw new Error("a drill step is never killed"); };
    setImmediate(() => child.emit("close", 3));
    return child;
  };
  const result = await spawnDrillStep(["scripts/gcp-production-rollout.mjs", "migrate"], { spawn })();
  assert.deepEqual(result, { exitCode: 3 });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ["scripts/gcp-production-rollout.mjs", "migrate"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.signal, undefined);
  assert.deepEqual(calls[0].options.stdio, ["ignore", 2, 2], "no stdin; output to the harness's stderr");
  assert.match(calls[0].options.cwd, /apps\/worker$/u);
});
