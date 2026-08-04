import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  handleSparkleAppcastGuard,
  readSparkleAppcastGuardConfiguration,
  SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
  SPARKLE_APPCAST_GUARD_CHANNEL,
  SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
  SPARKLE_APPCAST_GUARD_KEY,
  SPARKLE_APPCAST_GUARD_ROUTE,
  SPARKLE_APPCAST_GUARD_SCHEMA,
} from "../src/sparkle-appcast-guard";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const TOKEN = "test-owner-release-guard-token-0123456789";
const NOW = Date.parse("2026-08-04T22:00:00.000Z");
const encoder = new TextEncoder();

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  contentType: string;
  cacheControl: string;
}

class FakeR2Bucket {
  object: StoredObject | null = null;
  putCalls = 0;
  mutateBeforePut = false;

  private metadata(): R2Object {
    if (this.object === null) throw new Error("object is absent");
    return {
      key: SPARKLE_APPCAST_GUARD_KEY,
      version: this.object.etag,
      size: this.object.bytes.byteLength,
      etag: this.object.etag,
      httpEtag: `"${this.object.etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(NOW),
      httpMetadata: {
        contentType: this.object.contentType,
        cacheControl: this.object.cacheControl,
      },
      storageClass: "Standard",
      writeHttpMetadata: () => {},
    };
  }

  async head(): Promise<R2Object | null> {
    return this.object === null ? null : this.metadata();
  }

  async get(): Promise<R2ObjectBody | null> {
    if (this.object === null) return null;
    const metadata = this.metadata();
    return {
      ...metadata,
      arrayBuffer: async () => this.object!.bytes.slice().buffer,
      bytes: async () => this.object!.bytes.slice(),
      text: async () => new TextDecoder().decode(this.object!.bytes),
      blob: async () => new Blob([this.object!.bytes]),
      json: async () => JSON.parse(new TextDecoder().decode(this.object!.bytes)),
      get body() {
        return new ReadableStream<Uint8Array>();
      },
      bodyUsed: false,
      writeHttpMetadata: metadata.writeHttpMetadata,
    };
  }

  async put(
    _: string,
    value: ArrayBufferView,
    options: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putCalls += 1;
    if (this.mutateBeforePut) {
      this.mutateBeforePut = false;
      this.object = {
        bytes: encoder.encode("concurrent state"),
        etag: "concurrent",
        contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
        cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
      };
    }
    const condition = options.onlyIf as R2Conditional;
    const current = this.object === null ? null : this.metadata();
    if (condition.etagMatches !== undefined
        && (current === null || current.httpEtag !== condition.etagMatches)) {
      return null;
    }
    if (condition.etagDoesNotMatch !== undefined
        && condition.etagDoesNotMatch === "*" && current !== null) {
      return null;
    }
    const bytes = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    const digest = await sha256Hex(bytes);
    const metadata = options.httpMetadata as R2HTTPMetadata;
    this.object = {
      bytes,
      etag: digest.slice(0, 16),
      contentType: metadata.contentType ?? "",
      cacheControl: metadata.cacheControl ?? "",
    };
    return this.metadata();
  }
}

function bindings(bucket: FakeR2Bucket | null, overrides: Record<string, unknown> = {}): Env {
  const runtime = env as TestBindings;
  return {
    ASSETS: runtime.ASSETS,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    ENROLLMENT_MODE: runtime.ENROLLMENT_MODE,
    SIGN_IN_START_MAX_PER_MINUTE: "1200",
    ENROLLMENT_RATE_LIMIT: runtime.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: runtime.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: "",
    ENVELOPE_PUBLIC_JWK: "",
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: runtime.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: runtime.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: runtime.RECOVERY_RATE_LIMIT,
    USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    SPARKLE_RELEASES: bucket,
    SPARKLE_APPCAST_GUARD_MODE: "enabled",
    SPARKLE_APPCAST_GUARD_CHANNEL: SPARKLE_APPCAST_GUARD_CHANNEL,
    SPARKLE_APPCAST_GUARD_BUCKET: "tibotattle-updates",
    SPARKLE_APPCAST_GUARD_APPCAST_KEY: SPARKLE_APPCAST_GUARD_KEY,
    SPARKLE_APPCAST_GUARD_ENDPOINT_PATH: SPARKLE_APPCAST_GUARD_ROUTE,
    SPARKLE_APPCAST_GUARD_CONTENT_TYPE: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    SPARKLE_APPCAST_GUARD_CACHE_CONTROL: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    SPARKLE_APPCAST_GUARD_MAX_XML_BYTES: "1048576",
    SPARKLE_APPCAST_GUARD_TOKEN: TOKEN,
    ...overrides,
  } as unknown as Env;
}

async function signedRequest(
  payload: Record<string, unknown>,
  token = TOKEN,
  timestamp = Math.floor(NOW / 1000),
  nonce = "deterministic-nonce-0001",
): Promise<Request> {
  const body = JSON.stringify(payload);
  const bodySha256 = await sha256Hex(encoder.encode(body));
  const canonical = `${SPARKLE_APPCAST_GUARD_SCHEMA}\0POST\0${SPARKLE_APPCAST_GUARD_ROUTE}`
    + `\0${timestamp}\0${nonce}\0${bodySha256}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonical),
  ));
  return new Request(`https://example.test${SPARKLE_APPCAST_GUARD_ROUTE}`, {
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

interface PayloadOptions {
  candidate?: Uint8Array;
  expectedCurrent?: Record<string, unknown>;
  key?: string;
  channel?: string;
}

async function payload({
  candidate = encoder.encode("<?xml version=\"1.0\"?><rss><channel/></rss>"),
  expectedCurrent = { state: "empty", bytes: 0, sha256: null, etag: null },
  key = SPARKLE_APPCAST_GUARD_KEY,
  channel = SPARKLE_APPCAST_GUARD_CHANNEL,
}: PayloadOptions = {}): Promise<Record<string, unknown>> {
  return {
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    channel,
    bucket: "tibotattle-updates",
    key,
    contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    expectedCurrent,
    candidate: {
      bytes: candidate.byteLength,
      sha256: await sha256Hex(candidate),
      base64: base64Url(candidate),
    },
  };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json<Record<string, unknown>>();
}

async function invoke(request: Request, runtimeEnv: Env, nowEpoch = NOW): Promise<Response> {
  try {
    return await handleSparkleAppcastGuard(request, runtimeEnv, nowEpoch);
  } catch (error) {
    if (error instanceof Error && "status" in error
        && typeof error.status === "number") {
      return Response.json({ error: { code: error.message } }, { status: error.status });
    }
    throw error;
  }
}

beforeEach(async () => {
  await reset();
  const runtime = env as TestBindings;
  await applyD1Migrations(runtime.USAGE_MONITOR_DB, runtime.TEST_MIGRATIONS);
});

describe("Sparkle appcast atomic guard", () => {
  it("is disabled and indistinguishable from an unregistered route by default", async () => {
    const bucket = new FakeR2Bucket();
    const disabled = bindings(bucket, { SPARKLE_APPCAST_GUARD_MODE: undefined });
    expect(readSparkleAppcastGuardConfiguration(disabled).enabled).toBe(false);
    const response = await invoke(
      new Request(`https://example.test${SPARKLE_APPCAST_GUARD_ROUTE}`, { method: "GET" }),
      disabled,
      NOW,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a mismatched enabled target configuration before any R2 mutation", async () => {
    const bucket = new FakeR2Bucket();
    const mismatched = bindings(bucket, {
      SPARKLE_APPCAST_GUARD_BUCKET: "wrong-release-bucket",
    });
    const response = await invoke(
      await signedRequest(await payload()),
      mismatched,
      NOW,
    );
    expect(response.status).toBe(503);
    expect(bucket.putCalls).toBe(0);
  });

  it("rejects bad authentication and stale timestamps without touching R2", async () => {
    const bucket = new FakeR2Bucket();
    const body = await payload();
    const badAuth = await signedRequest(body, "wrong-owner-release-token-0123456789");
    const badAuthResponse = await invoke(badAuth, bindings(bucket), NOW);
    expect(badAuthResponse.status).toBe(401);
    const stale = await signedRequest(body, TOKEN, Math.floor(NOW / 1000) - 301, "stale-nonce-0000001");
    const staleResponse = await invoke(stale, bindings(bucket), NOW);
    expect(staleResponse.status).toBe(401);
    expect(bucket.putCalls).toBe(0);
  });

  it("consumes a nonce once, so an identical signed request cannot replay", async () => {
    const bucket = new FakeR2Bucket();
    const body = await payload();
    const first = await invoke(
      await signedRequest(body),
      bindings(bucket),
      NOW,
    );
    const replay = await invoke(
      await signedRequest(body),
      bindings(bucket),
      NOW,
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(bucket.putCalls).toBe(1);
  });

  it("retains a nonce through the exact accepted timestamp boundary", async () => {
    const bucket = new FakeR2Bucket();
    const body = await payload();
    const timestamp = Math.floor(NOW / 1000);
    const nonce = "boundary-nonce-0000001";
    const first = await invoke(
      await signedRequest(body, TOKEN, timestamp, nonce),
      bindings(bucket),
      NOW,
    );
    const replayAtBoundary = await invoke(
      await signedRequest(body, TOKEN, timestamp, nonce),
      bindings(bucket),
      NOW + 300_000,
    );
    expect(first.status).toBe(200);
    expect(replayAtBoundary.status).toBe(401);
    expect(bucket.putCalls).toBe(1);
  });

  it("rejects the wrong channel/key before any R2 mutation", async () => {
    const bucket = new FakeR2Bucket();
    const wrongChannel = await invoke(
      await signedRequest(await payload({ channel: "internal-dogfood" })),
      bindings(bucket),
      NOW,
    );
    const wrongKey = await invoke(
      await signedRequest(await payload({ key: "releases/other.xml" }), TOKEN, Math.floor(NOW / 1000), "different-nonce-0002"),
      bindings(bucket),
      NOW,
    );
    const wrongPath = await invoke(
      new Request("https://example.test/api/v1/internal/release/other", {
        method: "POST",
        headers: (await signedRequest(
          await payload(),
          TOKEN,
          Math.floor(NOW / 1000),
          "different-nonce-0003",
        )).headers,
        body: JSON.stringify(await payload()),
      }),
      bindings(bucket),
      NOW,
    );
    expect(wrongChannel.status).toBe(403);
    expect(wrongKey.status).toBe(403);
    expect(wrongPath.status).toBe(404);
    expect(bucket.putCalls).toBe(0);
  });

  it("returns a current-state conflict without mutating the appcast", async () => {
    const bucket = new FakeR2Bucket();
    bucket.object = {
      bytes: encoder.encode("old appcast"),
      etag: "old-etag",
      contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
      cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    };
    const response = await invoke(
      await signedRequest(await payload()),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(409);
    expect(await jsonResponse(response)).toMatchObject({
      status: "conflict",
      reason: "current_state_conflict",
    });
    expect(bucket.putCalls).toBe(0);
  });

  it("returns a distinct R2 conditional-write conflict", async () => {
    const bucket = new FakeR2Bucket();
    const current = encoder.encode("current appcast");
    bucket.object = {
      bytes: current,
      etag: "current-etag",
      contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
      cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    };
    bucket.mutateBeforePut = true;
    const response = await invoke(
      await signedRequest(await payload({
        expectedCurrent: {
          state: "present",
          bytes: current.byteLength,
          sha256: await sha256Hex(current),
          etag: null,
        },
      })),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(409);
    expect(await jsonResponse(response)).toMatchObject({
      status: "conflict",
      reason: "r2_conditional_write_conflict",
    });
    expect(bucket.putCalls).toBe(1);
  });

  it("rejects an incorrect candidate checksum before R2 put", async () => {
    const bucket = new FakeR2Bucket();
    const body = await payload();
    const candidate = body.candidate as Record<string, unknown>;
    candidate.sha256 = "0".repeat(64);
    const response = await invoke(
      await signedRequest(body),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(422);
    expect(bucket.putCalls).toBe(0);
  });
});
