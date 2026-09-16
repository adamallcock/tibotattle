import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createGcsTestReleaseWorker,
  GCS_TEST_RELEASE_APPCAST_KEY,
  GCS_TEST_RELEASE_ARTIFACT_CACHE_CONTROL,
  GCS_TEST_RELEASE_ARTIFACT_CONTENT_TYPE,
  GCS_TEST_RELEASE_CACHE_CONTROL,
  GCS_TEST_RELEASE_CHANNEL,
  GCS_TEST_RELEASE_CONTENT_TYPE,
  GCS_TEST_RELEASE_DEFAULT_RUN_ID,
  GCS_TEST_RELEASE_OBJECT_PREFIX,
  GCS_TEST_RELEASE_ROUTE,
  GCS_TEST_RELEASE_SCHEMA,
  GCS_TEST_RELEASE_UPDATE_ORIGIN,
} from "../src/gcs-test-release-worker";

interface TestBindings {
  readonly USAGE_MONITOR_DB: D1Database;
  readonly TEST_MIGRATIONS: D1Migration[];
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly generation: string;
  readonly etag: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

interface GcsTransport {
  readonly fetchImpl: typeof fetch;
  readonly calls: Array<{ readonly url: URL; readonly init: RequestInit }>;
  readonly objects: Map<string, StoredObject>;
}

const runtime = env as unknown as TestBindings;
const NOW = Date.parse("2026-09-15T20:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1000);
const BUCKET = "tibotattle-gcs-test-local";
const GCS_TOKEN = "gcs-test-access-token";
const RELEASE_TOKEN = "gcs-test-release-token-01234567890123456789";
const ARTIFACT_BYTES = new TextEncoder().encode("synthetic-gcs-release-artifact");
const ARTIFACT_FILE_NAME = "TiboTattle.dmg";
const encoder = new TextEncoder();
let signingKeyPair: CryptoKeyPair;
let signingPublicKey = "";
let signingPublicKeySha256 = "";

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(value: Uint8Array): string {
  return base64(value).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ed25519Signature(value: Uint8Array): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    signingKeyPair.privateKey,
    value,
  )));
}

function metadata(
  bucket: string,
  key: string,
  object: StoredObject,
): Record<string, unknown> {
  return {
    bucket,
    name: key,
    generation: object.generation,
    size: String(object.bytes.byteLength),
    etag: object.etag,
    contentType: object.contentType,
    cacheControl: object.cacheControl,
  };
}

function gcsTransport(bucket: string): GcsTransport {
  const calls: Array<{ readonly url: URL; readonly init: RequestInit }> = [];
  const objects = new Map<string, StoredObject>();
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof URL
      ? new URL(input.href)
      : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, init });
    const path = decodeURIComponent(url.pathname);
    const metadataPrefix = `/storage/v1/b/${bucket}/o/`;
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization !== `Bearer ${GCS_TOKEN}`) {
      return new Response("", { status: 401 });
    }
    if (init.method === "GET" && path.startsWith(metadataPrefix)) {
      const key = path.slice(metadataPrefix.length);
      const object = objects.get(key);
      if (object === undefined) return new Response("", { status: 404 });
      if (url.searchParams.get("alt") === "media") {
        if (url.searchParams.get("ifGenerationMatch") !== object.generation) {
          return new Response("", { status: 412 });
        }
        return new Response(object.bytes.slice(), { status: 200 });
      }
      return Response.json(metadata(bucket, key, object));
    }
    if (init.method === "POST"
        && path === `/upload/storage/v1/b/${bucket}/o`) {
      const key = url.searchParams.get("name");
      if (key === null) return new Response("", { status: 400 });
      const object = objects.get(key);
      const condition = url.searchParams.get("ifGenerationMatch");
      if ((condition === "0" && object !== undefined)
          || (condition !== "0" && condition !== object?.generation)) {
        return new Response("", { status: 412 });
      }
      const requestBody = await new Response(init.body).text();
      if (!requestBody.includes(`"name":"${key}"`)) {
        return new Response("", { status: 400 });
      }
      const stored: StoredObject = {
        bytes: encoder.encode("committed-appcast"),
        generation: "2",
        etag: "gcs-appcast-etag",
        contentType: GCS_TEST_RELEASE_CONTENT_TYPE,
        cacheControl: GCS_TEST_RELEASE_CACHE_CONTROL,
      };
      objects.set(key, stored);
      return Response.json(metadata(bucket, key, stored));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, objects };
}

function workerEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    GCS_TEST_BUCKET: BUCKET,
    GCS_TEST_RUN_ID: GCS_TEST_RELEASE_DEFAULT_RUN_ID,
    GCS_ACCESS_TOKEN: GCS_TOKEN,
    GCS_ACCESS_TOKEN_EXPIRES_AT: String(NOW_SECONDS + 600),
    GCS_TEST_RELEASE_TOKEN: RELEASE_TOKEN,
    GCS_TEST_PUBLIC_ED_KEY: signingPublicKey,
    GCS_TEST_PUBLIC_ED_KEY_SHA256: signingPublicKeySha256,
    // The production-shaped binding is deliberately aliased only inside this
    // Miniflare test; the worker entrypoint accepts TEST_RELEASE_NONCES only.
    TEST_RELEASE_NONCES: runtime.USAGE_MONITOR_DB,
    ...overrides,
  };
}

async function candidateAppcast(): Promise<{
  readonly bytes: Uint8Array;
  readonly artifactKey: string;
}> {
  const artifactDigest = await sha256Hex(ARTIFACT_BYTES);
  const artifactKey = `${GCS_TEST_RELEASE_OBJECT_PREFIX}/1.0.0/${artifactDigest}/${ARTIFACT_FILE_NAME}`;
  const artifactSignature = await ed25519Signature(ARTIFACT_BYTES);
  const text = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<enclosure url="${GCS_TEST_RELEASE_UPDATE_ORIGIN}/${artifactKey}" length="${ARTIFACT_BYTES.byteLength}" sparkle:version="1.0.0" sparkle:edSignature="${artifactSignature}" />
</item></channel></rss>`;
  return { bytes: encoder.encode(text), artifactKey };
}

async function signedRequest(
  payload: Record<string, unknown>,
  nonce = "gcs-test-nonce-0001",
  timestamp = NOW_SECONDS,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const bodySha256 = await sha256Hex(body);
  const canonical = `${GCS_TEST_RELEASE_SCHEMA}\0POST\0${GCS_TEST_RELEASE_ROUTE}`
    + `\0${timestamp}\0${nonce}\0${bodySha256}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(RELEASE_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonical),
  ));
  return new Request(`http://127.0.0.1:8799${GCS_TEST_RELEASE_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usage-monitor-release-timestamp": String(timestamp),
      "x-usage-monitor-release-nonce": nonce,
      "x-usage-monitor-release-signature": base64Url(signature),
    },
    body,
  });
}

async function releasePayload(candidate: Uint8Array): Promise<Record<string, unknown>> {
  return {
    schemaVersion: GCS_TEST_RELEASE_SCHEMA,
    channel: GCS_TEST_RELEASE_CHANNEL,
    bucket: BUCKET,
    key: GCS_TEST_RELEASE_APPCAST_KEY,
    contentType: GCS_TEST_RELEASE_CONTENT_TYPE,
    cacheControl: GCS_TEST_RELEASE_CACHE_CONTROL,
    expectedCurrent: { state: "empty", bytes: 0, sha256: null, etag: null },
    candidate: {
      bytes: candidate.byteLength,
      sha256: await sha256Hex(candidate),
      base64: base64Url(candidate),
    },
  };
}

function approvedProbeRequest(): Request {
  return new Request(`http://127.0.0.1:8799${GCS_TEST_RELEASE_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

beforeAll(async () => {
  signingKeyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", signingKeyPair.publicKey) as ArrayBuffer,
  );
  signingPublicKey = base64(publicBytes);
  signingPublicKeySha256 = await sha256Hex(publicBytes);
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
});

describe("GCS test release worker", () => {
  it("fails closed for missing, expired, and production bucket credentials before GCS access", async () => {
    const transport = gcsTransport(BUCKET);
    const missingConfigurations: Array<Record<string, unknown>> = [
      { GCS_TEST_BUCKET: undefined },
      { GCS_TEST_RUN_ID: undefined },
      { GCS_ACCESS_TOKEN: undefined },
      { GCS_ACCESS_TOKEN_EXPIRES_AT: undefined },
      { GCS_TEST_RELEASE_TOKEN: undefined },
      { GCS_TEST_PUBLIC_ED_KEY: undefined },
      { GCS_TEST_PUBLIC_ED_KEY_SHA256: undefined },
      { TEST_RELEASE_NONCES: undefined },
    ];
    for (const overrides of missingConfigurations) {
      const missing = createGcsTestReleaseWorker({
        env: workerEnv(overrides),
        fetchImpl: transport.fetchImpl,
        now: () => NOW,
      });
      const missingResponse = await missing.fetch(approvedProbeRequest());
      expect(missingResponse.status).toBe(503);
      expect(await missingResponse.json()).toMatchObject({
        error: { code: "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID" },
      });
      expect(transport.calls).toHaveLength(0);
    }

    const expired = createGcsTestReleaseWorker({
      env: workerEnv({ GCS_ACCESS_TOKEN_EXPIRES_AT: String(NOW_SECONDS - 1) }),
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
    });
    const expiredResponse = await expired.fetch(approvedProbeRequest());
    expect(expiredResponse.status).toBe(503);
    expect(transport.calls).toHaveLength(0);

    const productionBucket = createGcsTestReleaseWorker({
      env: workerEnv({ GCS_TEST_BUCKET: "tibotattle-updates" }),
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
    });
    const productionResponse = await productionBucket.fetch(approvedProbeRequest());
    expect(productionResponse.status).toBe(503);
    expect(transport.calls).toHaveLength(0);
  });

  it("handles only the approved loopback route and POST method", async () => {
    const transport = gcsTransport(BUCKET);
    const worker = createGcsTestReleaseWorker({
      env: workerEnv(),
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
    });
    const wrongPath = await worker.fetch(new Request("http://127.0.0.1:8799/not-approved"));
    expect(wrongPath.status).toBe(404);
    const wrongMethod = await worker.fetch(new Request(
      `http://127.0.0.1:8799${GCS_TEST_RELEASE_ROUTE}`,
      { method: "GET" },
    ));
    expect(wrongMethod.status).toBe(405);
    const remote = await worker.fetch(new Request(
      `https://example.invalid${GCS_TEST_RELEASE_ROUTE}`,
      { method: "POST" },
    ));
    expect(remote.status).toBe(503);
    expect(transport.calls).toHaveLength(0);
  });

  it("composes GCS storage and D1 replay protection for a valid commit", async () => {
    const transport = gcsTransport(BUCKET);
    const candidate = await candidateAppcast();
    transport.objects.set(candidate.artifactKey, {
      bytes: ARTIFACT_BYTES,
      generation: "1",
      etag: "artifact-etag",
      contentType: GCS_TEST_RELEASE_ARTIFACT_CONTENT_TYPE,
      cacheControl: GCS_TEST_RELEASE_ARTIFACT_CACHE_CONTROL,
    });
    const worker = createGcsTestReleaseWorker({
      env: workerEnv(),
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
    });
    const payload = await releasePayload(candidate.bytes);
    const first = await worker.fetch(await signedRequest(payload));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      schemaVersion: GCS_TEST_RELEASE_SCHEMA,
      status: "committed",
      bytes: candidate.bytes.byteLength,
      sha256: await sha256Hex(candidate.bytes),
    });
    expect(transport.calls).toHaveLength(4);

    const replay = await worker.fetch(await signedRequest(payload));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: "SPARKLE_APPCAST_GUARD_REPLAY_INVALID" },
    });
    expect(transport.calls).toHaveLength(4);
  });

  it("rechecks token expiry in the access-token callback before storage access", async () => {
    const transport = gcsTransport(BUCKET);
    const candidate = await candidateAppcast();
    transport.objects.set(candidate.artifactKey, {
      bytes: ARTIFACT_BYTES,
      generation: "1",
      etag: "artifact-etag",
      contentType: GCS_TEST_RELEASE_ARTIFACT_CONTENT_TYPE,
      cacheControl: GCS_TEST_RELEASE_ARTIFACT_CACHE_CONTROL,
    });
    let nowCalls = 0;
    const worker = createGcsTestReleaseWorker({
      env: workerEnv({ GCS_ACCESS_TOKEN_EXPIRES_AT: String(NOW_SECONDS + 60) }),
      fetchImpl: transport.fetchImpl,
      now: () => {
        nowCalls += 1;
        return nowCalls <= 2 ? NOW : NOW + 120_000;
      },
    });
    const response = await worker.fetch(
      await signedRequest(await releasePayload(candidate.bytes), "gcs-expiry-nonce-0001"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE" },
    });
    expect(transport.calls).toHaveLength(0);
  });
});
