#!/usr/bin/env node
// E12 optional live check (OD-E3): the local edge in gcp mode against the GCP
// fast-path test origin, through Google's real front end.
//
//   node scripts/edge-live-check.mjs plan
//       prints the steps and the exact commands; runs nothing (the default).
//   node scripts/edge-live-check.mjs run --authorize=EDGE_LIVE_CHECK_READ_ONLY \
//       --origin-url=<pinned test origin> --invoker=<pinned journey account> \
//       --expected-body-sha=<S9 sha256> --out=<private receipt directory>
//       the read-only tier.
//   ... run --authorize=EDGE_LIVE_CHECK_WRITES ...
//       the write tier as well (separately authorized): accountless enrollment,
//       ownership, v1.2 authorization and one v1.2 sync into the seeded test
//       schema.
//
// Each run needs the owner's authorization in chat for that tier, and the
// fast-path test origin redeployed as the direct edge-test variant (a GCP
// write this script never makes). Only the origin URL and invoker pinned in
// scripts/gcp-fastpath-test-deploy.mjs are accepted.
//
// The identity token comes from `gcloud auth print-identity-token` impersonating
// the journey account, spawned without a shell. It is checked for JWT shape,
// the pinned email and the audience, held in memory, handed to the edge's own
// EP-2 path as the token endpoint's answer, and never printed, logged or
// written. The edge's synthetic key never leaves the process. Outbound traffic
// is the token-endpoint interception and requests to the pinned origin host;
// every other host is refused. The receipt holds statuses, header names, body
// digests, framing and timings per row, and the origin revision and image the
// health answer reports; never a token, key, email or address.

import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FASTPATH_TEST } from "./gcp-fastpath-test-deploy.mjs";

export const EDGE_LIVE_CHECK_AUTHORIZATIONS = Object.freeze({
  readOnly: "EDGE_LIVE_CHECK_READ_ONLY",
  writes: "EDGE_LIVE_CHECK_WRITES",
});
export const EDGE_LIVE_CHECK_ORIGIN = FASTPATH_TEST.originUrl;
export const EDGE_LIVE_CHECK_INVOKER = FASTPATH_TEST.journeyServiceAccount;
export const EDGE_LIVE_CHECK_TOKEN_HOST = "oauth2.googleapis.com";
const RECEIPT_SCHEMA = "edge-live-check-receipt-v1";
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GCLOUD_TIMEOUT_MS = 60_000;
const MAX_TOKEN_BYTES = 8_192;

export class EdgeLiveCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = "EdgeLiveCheckError";
    this.code = code;
  }
}

function fail(code) {
  throw new EdgeLiveCheckError(code);
}

/** Parses argv; never reads the environment. */
export function parseLiveCheckArguments(argv) {
  const [command = "plan", ...rest] = argv;
  if (command !== "plan" && command !== "run") fail("EDGE_LIVE_CHECK_COMMAND_INVALID");
  const options = { command, authorize: null, originUrl: EDGE_LIVE_CHECK_ORIGIN, invoker: EDGE_LIVE_CHECK_INVOKER,
    audience: null, expectedBodySha: null, out: null, golden: null };
  const names = { "--authorize": "authorize", "--origin-url": "originUrl", "--invoker": "invoker",
    "--audience": "audience", "--expected-body-sha": "expectedBodySha", "--out": "out", "--golden": "golden" };
  for (const argument of rest) {
    const match = /^(--[a-z-]+)=(.*)$/u.exec(argument);
    if (match === null || !Object.hasOwn(names, match[1])) fail("EDGE_LIVE_CHECK_ARGUMENT_INVALID");
    options[names[match[1]]] = match[2];
  }
  options.audience ??= options.originUrl;
  return options;
}

/** The steps and exact commands; nothing is run. */
export function liveCheckPlan() {
  return [
    "Edge live check (OD-E3): plan only. Nothing below has been run.",
    "",
    "Owner authorization in chat is required for each step:",
    "1. Redeploy the fast-path test origin as the direct edge-test variant (a GCP write):",
    `   node scripts/gcp-fastpath-test-deploy.mjs origin --image=<image digest> --origin-variant=direct \\`,
    "     --origin-env=EDGE_ORIGIN_MODE=edge-test \\",
    `     --origin-env=EDGE_ORIGIN_AUDIENCE=${EDGE_LIVE_CHECK_ORIGIN} \\`,
    `     --origin-env=EDGE_INVOKER_SERVICE_ACCOUNT=${EDGE_LIVE_CHECK_INVOKER}`,
    "2. Run E12's S9 stage on the same commit and seed and keep its community/daily sha256.",
    "3. Read-only tier (no write anywhere):",
    "   node scripts/edge-live-check.mjs run --authorize=EDGE_LIVE_CHECK_READ_ONLY \\",
    `     --origin-url=${EDGE_LIVE_CHECK_ORIGIN} --invoker=${EDGE_LIVE_CHECK_INVOKER} \\`,
    "     --expected-body-sha=<S9 sha256> --golden=analytics-v2-test/golden --out=<private receipt directory>",
    "4. Write tier (separately authorized; synthetic accountless rows in the seeded test schema):",
    "   the same command with --authorize=EDGE_LIVE_CHECK_WRITES.",
    "",
    "The token the run uses is minted in memory by:",
    `   gcloud auth print-identity-token --impersonate-service-account=${EDGE_LIVE_CHECK_INVOKER} \\`,
    `     --audiences=${EDGE_LIVE_CHECK_ORIGIN} --include-email`,
    "",
    "It qualifies Google's front end in front of the edge-test origin. It does not qualify Cloudflare's",
    "network, Workers Rate Limiting, custom domains, Access, the production origin composition or",
    "production data.",
  ].join("\n");
}

function decodePayload(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Runs `gcloud` without a shell and returns its stdout in memory, or refuses. */
function runGcloud(spawn, args) {
  return new Promise((resolveRun, reject) => {
    let child;
    try {
      child = spawn("gcloud", args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      reject(new EdgeLiveCheckError("EDGE_LIVE_CHECK_GCLOUD_UNAVAILABLE"));
      return;
    }
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill?.("SIGKILL"), GCLOUD_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_TOKEN_BYTES) chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new EdgeLiveCheckError("EDGE_LIVE_CHECK_GCLOUD_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > MAX_TOKEN_BYTES) reject(new EdgeLiveCheckError("EDGE_LIVE_CHECK_GCLOUD_FAILED"));
      else resolveRun(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** The journey account's identity token for `audience`, checked; never logged. */
export async function mintLiveIdentityToken({ invoker, audience, spawn = spawnProcess }) {
  await runGcloud(spawn, ["--version"]);
  const output = await runGcloud(spawn, ["auth", "print-identity-token",
    `--impersonate-service-account=${invoker}`, `--audiences=${audience}`, "--include-email"]);
  const token = output.trim();
  if (!JWT.test(token)) fail("EDGE_LIVE_CHECK_TOKEN_INVALID");
  const payload = decodePayload(token);
  const audiences = typeof payload?.aud === "string" ? [payload.aud] : payload?.aud;
  if (payload === null || payload.email !== invoker || payload.email_verified !== true
      || !Array.isArray(audiences) || !audiences.includes(audience)) {
    fail("EDGE_LIVE_CHECK_TOKEN_INVALID");
  }
  return token;
}

/** The only hosts a live run's outbound traffic may reach. */
export function createLiveOutboundGuard({ originUrl }) {
  const originHost = new URL(originUrl).host;
  return Object.freeze({
    allows(host) {
      const value = String(host ?? "").toLowerCase();
      return value === EDGE_LIVE_CHECK_TOKEN_HOST || value === originHost;
    },
  });
}

function validateRun(options) {
  if (options.authorize !== EDGE_LIVE_CHECK_AUTHORIZATIONS.readOnly
      && options.authorize !== EDGE_LIVE_CHECK_AUTHORIZATIONS.writes) {
    fail("EDGE_LIVE_CHECK_AUTHORIZATION_REQUIRED");
  }
  if (options.originUrl !== EDGE_LIVE_CHECK_ORIGIN) fail("EDGE_LIVE_CHECK_ORIGIN_NOT_PINNED");
  if (options.invoker !== EDGE_LIVE_CHECK_INVOKER) fail("EDGE_LIVE_CHECK_INVOKER_NOT_PINNED");
  if (options.audience !== EDGE_LIVE_CHECK_ORIGIN) fail("EDGE_LIVE_CHECK_AUDIENCE_NOT_PINNED");
  if (!SHA256.test(options.expectedBodySha ?? "")) fail("EDGE_LIVE_CHECK_EXPECTED_SHA_REQUIRED");
  if (typeof options.out !== "string" || options.out.length === 0) fail("EDGE_LIVE_CHECK_OUT_REQUIRED");
  if (typeof options.golden !== "string" || options.golden.length === 0) fail("EDGE_LIVE_CHECK_GOLDEN_REQUIRED");
}

function receiptRow(id, answer, startedAt, exchanges) {
  return {
    id,
    status: answer.status,
    headerNames: [...new Set(answer.headers.map(([name]) => name))].sort(),
    bodySha256: createHash("sha256").update(answer.body).digest("hex"),
    bodyBytes: answer.body.length,
    framing: exchanges.map((exchange) => exchange.framing),
    forwarded: exchanges.length,
    ms: Math.round(performance.now() - startedAt),
  };
}

/** The default edge for a live run: the e2e bundle in gcp mode behind the live front end. */
async function startLiveEdge({ token, originUrl, invoker, audience, workerRoot }) {
  const { buildEdgeBundle } = await import("./edge-e2e/edge-bundle.mjs");
  const instances = await import("./edge-e2e/edge-instances.mjs");
  const { createGoogleFrontEnd, createSyntheticServiceAccountKey } = await import("./edge-e2e/google-front-end.mjs");
  const bundle = await buildEdgeBundle({ workerRoot });
  const key = createSyntheticServiceAccountKey(invoker);
  const frontEnd = createGoogleFrontEnd({ invoker: key, audience, upstreamOrigin: originUrl,
    live: { idToken: async () => token, target: new URL(originUrl) } });
  const edge = await instances.createEdgeInstance({
    bundle, mode: "gcp", frontEnd, invokerKeyJson: key.keyJson,
    access: instances.createAccessFixture(), sparkle: await instances.createSparkleFixture(workerRoot),
    assets: await instances.createFixtureAssets(workerRoot),
    overrides: { EDGE_UPSTREAM_ORIGIN: originUrl, EDGE_ORIGIN_AUDIENCE: audience, EDGE_INVOKER_SERVICE_ACCOUNT: invoker,
      EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "60" },
  });
  return {
    fetch: (url, options) => edge.fetch(url, options),
    frontEnd,
    async close() {
      await edge.dispose();
      await bundle.cleanup();
    },
  };
}

/**
 * The read-only rows, then (write tier) the write rows. Returns the receipt.
 * deps: spawn, startEdge, fetch (the direct no-token probe), now.
 */
export async function runLiveCheck(options, deps = {}) {
  validateRun(options);
  const spawn = deps.spawn ?? spawnProcess;
  const startEdge = deps.startEdge ?? startLiveEdge;
  const directFetch = deps.fetch ?? globalThis.fetch;
  const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const token = await mintLiveIdentityToken({ invoker: options.invoker, audience: options.audience, spawn });
  const guard = createLiveOutboundGuard({ originUrl: options.originUrl });
  const edge = await startEdge({ token, originUrl: options.originUrl, invoker: options.invoker,
    audience: options.audience, workerRoot, guard });
  const publicOrigin = "https://tibotattle.test";
  const rows = [];
  const send = async (id, path, init = {}) => {
    const mark = edge.frontEnd?.mark?.() ?? 0;
    const startedAt = performance.now();
    const answer = await edge.fetch(`${init.host ?? publicOrigin}${path}`, {
      ip: `203.0.113.${1 + rows.length}`, ...init });
    const exchanges = edge.frontEnd?.since?.(mark) ?? [];
    for (const exchange of exchanges) {
      const host = exchange.forwardedHeaders?.host;
      if (host !== undefined && !guard.allows(host)) fail("EDGE_LIVE_CHECK_OUTBOUND_REFUSED");
    }
    const row = receiptRow(id, answer, startedAt, exchanges);
    rows.push(row);
    return { answer, row };
  };
  let origin = null;
  try {
    const health = await send("health", "/api/health");
    try {
      const body = JSON.parse(health.answer.body.toString("utf8"));
      origin = { revision: typeof body?.revision === "string" ? body.revision : null,
        image: typeof body?.image === "string" ? body.image : null,
        sourceCommit: typeof body?.deployment?.sourceCommit === "string" ? body.deployment.sourceCommit : null };
    } catch {
      origin = null;
    }
    await send("ready", "/api/ready");
    await send("envelope-key", "/api/v1/envelope-key");
    const golden = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(resolve(options.golden), "community-daily-response.json"), "utf8"));
    const daily = await send("community-daily", `/api/v1/community/daily?from=${golden.from}&to=${golden.to}`);
    if (daily.row.bodySha256 !== options.expectedBodySha) fail("EDGE_LIVE_CHECK_BODY_SHA_MISMATCH");
    await send("device-sync-no-bearer", "/api/v1/device/sync/state");
    await send("device-sync-unknown-bearer", "/api/v1/device/sync/state", {
      headers: { authorization: `Device um_device_${randomUUID()}.${randomBytes(32).toString("base64url")}` } });
    for (const [id, path, host] of [["local-www", "/privacy.html", "https://www.tibotattle.test"],
      ["local-asset", "/privacy.html", publicOrigin], ["local-unknown-api", "/api/v1/nope", publicOrigin],
      ["local-admin-no-access", "/admin", "https://admin.tibotattle.test"]]) {
      const { row } = await send(id, path, { host });
      if (row.forwarded !== 0) fail("EDGE_LIVE_CHECK_LOCAL_ROW_FORWARDED");
    }
    const startedAt = performance.now();
    const unauthenticated = await directFetch(`${options.originUrl}/api/health`, { redirect: "manual" });
    rows.push({ id: "origin-without-token", status: unauthenticated.status, ms: Math.round(performance.now() - startedAt) });
    await unauthenticated.body?.cancel?.().catch(() => {});
    if (options.authorize === EDGE_LIVE_CHECK_AUTHORIZATIONS.writes) {
      await (deps.writeRows ?? liveWriteRows)({ send, publicOrigin });
    }
  } finally {
    await edge.close?.();
  }
  return {
    schemaVersion: RECEIPT_SCHEMA,
    tier: options.authorize === EDGE_LIVE_CHECK_AUTHORIZATIONS.writes ? "writes" : "read_only",
    origin,
    rows,
  };
}

const LABORATORY_ORIGIN = "http://127.0.0.1:49111";
const CAPABILITY_PATHS = new Set(["/api/v1/device/sync-capabilities", "/api/v1/device/sync-capabilities-v1.2"]);

/** One deterministic synthetic v1.2 day (E12's makeV12Day), content-free. */
async function syntheticV12Day(day) {
  const contract = await import("@app-usagemonitor/telemetry-contract");
  const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
  const consent = contract.telemetryV12RequiredConsent();
  const parserVersion = "synthetic-edge-live-check";
  const records = [{
    schemaVersion: "usage-event-v1.2", eventId: `event:v2:${sha256Hex(`edge-live-check:${day}`)}`,
    eventTime: `${day}T12:00:00.000Z`, sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b", provider: "openai_codex",
    modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root", outcome: "completed",
    totalInputContextTokens: 1000, components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75 },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
      planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  }];
  const chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64), chunkId: `usage:${day}:0`,
    chunkRevision: 1, chunkDigest: sha256Hex(Buffer.from(contract.canonicalTelemetryV12Json(records))), parserVersion,
    consent, records };
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(Buffer.from(contract.telemetryV12DayManifestDigestInput(manifest)));
  chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks: [chunk] };
}

/**
 * The write tier: accountless enrollment, ownership and the v1.2 authorization
 * through the edge, then one v1.2 sync with the shipped client. The shipped
 * accountless client accepts only its laboratory, staging and production
 * destinations, so (as in E12's S5) it is configured for the loopback
 * laboratory origin and the run maps that origin to the edge's public origin,
 * and the capability answers' destinationOrigin back; nothing else changes.
 */
async function liveWriteRows({ send, publicOrigin }) {
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const secretHash = createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`).update(secret).digest("hex");
  const deviceAuthorization = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const json = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body) });
  const authorization = { schemaVersion: "accountless-upload-owner-v1.2", policyVersion: "accountless-telemetry-v1.2-policy-v1",
    authorizationBasis: "accountless-policy-v1.2", telemetrySchemaVersion: "telemetry-contribution-v1.2" };
  await send("write-accountless-enrollment", "/api/v1/accountless/enrollment", json({
    schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash: secretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }));
  await send("write-accountless-ownership", "/api/v1/accountless/ownership", json({
    schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" },
  { authorization: deviceAuthorization }));
  await send("write-accountless-v12-authorization", "/api/v1/accountless/telemetry-v1.2-authorization",
    json(authorization, { authorization: deviceAuthorization }));
  const { runTelemetryV12Sync } = await import("../../../src/contribution/telemetry-v12-sync.js");
  const { createTelemetryV12Envelope } = await import("../../../src/platform/telemetry-v12-envelope.js");
  let syncCalls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${LABORATORY_ORIGIN}/`)) fail("EDGE_LIVE_CHECK_CLIENT_ORIGIN_INVALID");
    const path = url.slice(LABORATORY_ORIGIN.length);
    syncCalls += 1;
    const { answer } = await send(`write-v12-sync-${syncCalls}`, path, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers ?? {})), body: init.body });
    const headers = new Headers();
    for (const [name, value] of answer.headers) headers.append(name, value);
    let body = answer.body;
    if (CAPABILITY_PATHS.has(new URL(url).pathname) && answer.status === 200) {
      const value = JSON.parse(answer.body.toString("utf8"));
      if (value.destinationOrigin !== publicOrigin) fail("EDGE_LIVE_CHECK_DESTINATION_UNEXPECTED");
      value.destinationOrigin = LABORATORY_ORIGIN;
      body = Buffer.from(JSON.stringify(value));
      headers.delete("content-length");
    }
    return new Response([204, 304].includes(answer.status) ? null : body, { status: answer.status, headers });
  };
  let key;
  const day = new Date().toISOString().slice(0, 10);
  const result = await runTelemetryV12Sync({
    serverBaseUrl: LABORATORY_ORIGIN, deviceAuthorization, authorization, laboratory: true, days: [day],
    readDay: () => syntheticV12Day(day),
    createEnvelope: async (chunk) => {
      key ??= await (await fetchImpl(`${LABORATORY_ORIGIN}/api/v1/envelope-key`)).json();
      return createTelemetryV12Envelope({ chunk, publicJwk: key.publicJwk, keyId: key.keyId });
    },
    fetchImpl, maxDurationMs: 240_000,
  });
  if (result.status !== "complete") fail("EDGE_LIVE_CHECK_V12_SYNC_INCOMPLETE");
}

/** Writes the receipt as 0600 files in a 0700 directory. */
async function writeReceipt(out, receipt) {
  const directory = resolve(out);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `edge-live-check-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const options = parseLiveCheckArguments(argv);
  if (options.command === "plan") {
    stdout.write(`${liveCheckPlan()}\n`);
    return null;
  }
  const receipt = await runLiveCheck(options, deps);
  const path = await (deps.writeReceipt ?? writeReceipt)(options.out, receipt);
  stdout.write(`${JSON.stringify({ status: "ok", tier: receipt.tier, rows: receipt.rows.length, receipt: path })}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EdgeLiveCheckError ? error.code : "EDGE_LIVE_CHECK_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 2;
  });
}
