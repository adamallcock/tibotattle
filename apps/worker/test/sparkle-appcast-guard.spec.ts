import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  handleSparkleAppcastGuard,
  readSparkleAppcastGuardConfiguration,
  SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
  SPARKLE_APPCAST_GUARD_CHANNEL,
  SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
  SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL,
  SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE,
  SPARKLE_APPCAST_GUARD_KEY,
  SPARKLE_APPCAST_GUARD_OBJECT_PREFIX,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV,
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
const ARTIFACT_FILE_NAME = "TiboTattle.dmg";
const ARTIFACT_BYTES = encoder.encode("signed-dmg-artifact");
let sparkleKeyPair: CryptoKeyPair;
let sparklePublicEdKey = "";
let sparklePublicEdKeySha256 = "";

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

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sparkleSignature(value: Uint8Array): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    sparkleKeyPair.privateKey,
    value,
  ));
  return base64(signature);
}

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  contentType: string;
  cacheControl: string;
}

class FakeR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  putCalls = 0;
  mutateBeforePut = false;

  get object(): StoredObject | null {
    return this.objects.get(SPARKLE_APPCAST_GUARD_KEY) ?? null;
  }

  set object(value: StoredObject | null) {
    if (value === null) this.objects.delete(SPARKLE_APPCAST_GUARD_KEY);
    else this.objects.set(SPARKLE_APPCAST_GUARD_KEY, value);
  }

  setArtifact(key: string, value: StoredObject): void {
    this.objects.set(key, value);
  }

  private metadata(key: string, object: StoredObject): R2Object {
    return {
      key,
      version: object.etag,
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(NOW),
      httpMetadata: {
        contentType: object.contentType,
        cacheControl: object.cacheControl,
      },
      storageClass: "Standard",
      writeHttpMetadata: () => {},
    };
  }

  async head(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key);
    return object === undefined ? null : this.metadata(key, object);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    const metadata = this.metadata(key, object);
    return {
      ...metadata,
      arrayBuffer: async () => object.bytes.slice().buffer,
      bytes: async () => object.bytes.slice(),
      text: async () => new TextDecoder().decode(object.bytes),
      blob: async () => new Blob([object.bytes]),
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
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
      this.objects.set(SPARKLE_APPCAST_GUARD_KEY, {
        bytes: encoder.encode("concurrent state"),
        etag: "concurrent",
        contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
        cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
      });
    }
    const condition = options.onlyIf as R2Conditional;
    const currentObject = this.objects.get(_);
    const current = currentObject === undefined
      ? null
      : this.metadata(_, currentObject);
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
    this.objects.set(_, {
      bytes,
      etag: digest.slice(0, 16),
      contentType: metadata.contentType ?? "",
      cacheControl: metadata.cacheControl ?? "",
    });
    return this.metadata(_, this.objects.get(_) as StoredObject);
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
    [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV]: sparklePublicEdKey,
    [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV]: sparklePublicEdKeySha256,
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

function artifactKey(version: string, digest: string): string {
  return `${SPARKLE_APPCAST_GUARD_OBJECT_PREFIX}/${version}/${digest}/${ARTIFACT_FILE_NAME}`;
}

async function appcastBytes(
  version: string,
  artifactBytes = ARTIFACT_BYTES,
  enclosureSuffix = "",
): Promise<Uint8Array> {
  const enclosure = await appcastEnclosure(version, artifactBytes);
  return encoder.encode(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
${enclosure}${enclosureSuffix}
</item></channel></rss>`);
}

async function appcastEnclosure(
  version: string,
  artifactBytes = ARTIFACT_BYTES,
): Promise<string> {
  const digest = await sha256Hex(artifactBytes);
  const signature = await sparkleSignature(artifactBytes);
  return `<enclosure url="https://updates.tibotattle.com/${artifactKey(version, digest)}" length="${artifactBytes.byteLength}" sparkle:version="${version}" sparkle:edSignature="${signature}" />`;
}

async function installArtifact(
  bucket: FakeR2Bucket,
  version: string,
  bytes = ARTIFACT_BYTES,
  overrides: Partial<StoredObject> = {},
): Promise<string> {
  const digest = await sha256Hex(bytes);
  const key = artifactKey(version, digest);
  bucket.setArtifact(key, {
    bytes,
    etag: `${version}-artifact-etag`,
    contentType: SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL,
    ...overrides,
  });
  return key;
}

async function seedAppcast(bucket: FakeR2Bucket, version: string): Promise<Uint8Array> {
  const current = await appcastBytes(version);
  bucket.object = {
    bytes: current,
    etag: `${version}-appcast-etag`,
    contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
  };
  return current;
}

async function payload({
  candidate,
  expectedCurrent = { state: "empty", bytes: 0, sha256: null, etag: null },
  key = SPARKLE_APPCAST_GUARD_KEY,
  channel = SPARKLE_APPCAST_GUARD_CHANNEL,
}: PayloadOptions = {}): Promise<Record<string, unknown>> {
  const candidateBytes = candidate ?? await appcastBytes("1");
  return {
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    channel,
    bucket: "tibotattle-updates",
    key,
    contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    expectedCurrent,
    candidate: {
      bytes: candidateBytes.byteLength,
      sha256: await sha256Hex(candidateBytes),
      base64: base64Url(candidateBytes),
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

beforeAll(async () => {
  sparkleKeyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", sparkleKeyPair.publicKey) as ArrayBuffer,
  );
  sparklePublicEdKey = base64(publicBytes);
  sparklePublicEdKeySha256 = await sha256Hex(publicBytes);
});

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

  it("keeps enabled mode dark when required R2 or D1 bindings are absent or malformed", async () => {
    const cases = [
      { SPARKLE_RELEASES: null },
      { SPARKLE_RELEASES: { head: () => {}, get: () => {} } },
      { USAGE_MONITOR_DB: null },
      { USAGE_MONITOR_DB: { prepare: "not-a-function" } },
    ];
    for (const [index, overrides] of cases.entries()) {
      const response = await invoke(
        new Request(`https://example.test${SPARKLE_APPCAST_GUARD_ROUTE}`, {
          method: "GET",
        }),
        bindings(new FakeR2Bucket(), overrides),
        NOW,
      );
      expect(response.status, `case ${index}`).toBe(404);
    }
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

  it("rejects a public-key fingerprint mismatch before any R2 put", async () => {
    const bucket = new FakeR2Bucket();
    const response = await invoke(
      await signedRequest(await payload(), TOKEN, Math.floor(NOW / 1000), "key-fingerprint-nonce-01"),
      bindings(bucket, {
        [SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV]: "0".repeat(64),
      }),
      NOW,
    );
    expect(response.status).toBe(503);
    expect(bucket.putCalls).toBe(0);
  });

  it("consumes a nonce once, so an identical signed request cannot replay", async () => {
    const bucket = new FakeR2Bucket();
    await installArtifact(bucket, "1");
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
    await installArtifact(bucket, "1");
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

  it("rejects arbitrary valid-looking XML without a canonical enclosure", async () => {
    const bucket = new FakeR2Bucket();
    const candidate = encoder.encode(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><title>looks valid</title></item></channel></rss>`);
    const response = await invoke(
      await signedRequest(await payload({ candidate })),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(422);
    expect(bucket.putCalls).toBe(0);
  });

  it("rejects root-external junk, namespace redeclaration, and Sparkle aliases or duplicates", async () => {
    const base = new TextDecoder().decode(await appcastBytes("1"));
    const candidates = [
      `junk${base}`,
      `${base}junk`,
      base.replace("<channel>", '<channel xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">'),
      base.replace(
        'sparkle:version="1"',
        'xmlns:s="http://www.andymatuschak.org/xml-namespaces/sparkle" s:version="1"',
      ),
      base.replace(
        'sparkle:version="1"',
        'sparkle:version="1" sparkle:version="1"',
      ),
    ];
    for (const [index, candidateText] of candidates.entries()) {
      const bucket = new FakeR2Bucket();
      const response = await invoke(
        await signedRequest(
          await payload({ candidate: encoder.encode(candidateText) }),
          TOKEN,
          Math.floor(NOW / 1000),
          `parser-adversary-nonce-${String(index).padStart(2, "0")}`,
        ),
        bindings(bucket),
        NOW,
      );
      expect(response.status, `case ${index}`).toBe(422);
      expect(bucket.putCalls).toBe(0);
    }
  });

  it("rejects unsigned and bad-signature candidates before any appcast put", async () => {
    const bucket = new FakeR2Bucket();
    const signed = new TextDecoder().decode(await appcastBytes("1"));
    const badSignature = encoder.encode(
      signed.replace(/sparkle:edSignature="[^"]+"/u, `sparkle:edSignature="${"A".repeat(88)}"`),
    );
    await installArtifact(bucket, "1");
    const badSignatureResponse = await invoke(
      await signedRequest(await payload({ candidate: badSignature })),
      bindings(bucket),
      NOW,
    );
    const unsigned = encoder.encode(
      signed.replace(/ sparkle:edSignature="[^"]+"/u, ""),
    );
    const unsignedResponse = await invoke(
      await signedRequest(
        await payload({ candidate: unsigned }),
        TOKEN,
        Math.floor(NOW / 1000),
        "unsigned-candidate-nonce-01",
      ),
      bindings(bucket),
      NOW,
    );
    expect(badSignatureResponse.status).toBe(422);
    expect(unsignedResponse.status).toBe(422);
    expect(bucket.putCalls).toBe(0);
  });

  it("requires the content-addressed artifact and immutable R2 metadata", async () => {
    const missing = new FakeR2Bucket();
    const missingResponse = await invoke(
      await signedRequest(await payload()),
      bindings(missing),
      NOW,
    );
    expect(missingResponse.status).toBe(422);
    expect(missing.putCalls).toBe(0);

    const mismatched = new FakeR2Bucket();
    await installArtifact(mismatched, "1", ARTIFACT_BYTES, {
      cacheControl: "public, max-age=60",
    });
    const mismatchedResponse = await invoke(
      await signedRequest(
        await payload(),
        TOKEN,
        Math.floor(NOW / 1000),
        "mismatched-artifact-nonce-01",
      ),
      bindings(mismatched),
      NOW,
    );
    expect(mismatchedResponse.status).toBe(422);
    expect(mismatched.putCalls).toBe(0);
  });

  it("rejects a valid-looking older entry when its artifact is missing", async () => {
    const bucket = new FakeR2Bucket();
    const missingOlderArtifact = encoder.encode("signed-but-not-uploaded-older-artifact");
    const candidate = encoder.encode(
      new TextDecoder().decode(await appcastBytes("2"))
        .replace(
          "</item>",
          `${await appcastEnclosure("1", missingOlderArtifact)}</item>`,
        ),
    );
    await installArtifact(bucket, "2");
    const response = await invoke(
      await signedRequest(await payload({ candidate })),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(422);
    expect(bucket.putCalls).toBe(0);
  });

  it("rejects delta enclosures even when the full artifact-looking data is signed", async () => {
    const bucket = new FakeR2Bucket();
    const candidate = encoder.encode(
      new TextDecoder().decode(await appcastBytes("2"))
        .replace("TiboTattle.dmg", "TiboTattle.delta")
        .replace(
          'sparkle:version="2"',
          'sparkle:version="2" sparkle:deltaFrom="1"',
        ),
    );
    const response = await invoke(
      await signedRequest(await payload({ candidate })),
      bindings(bucket),
      NOW,
    );
    expect(response.status).toBe(422);
    expect(bucket.putCalls).toBe(0);
  });

  it("rejects equal and lower active versions", async () => {
    for (const [version, nonce] of [["2", "equal-version-nonce-01"], ["1", "lower-version-nonce-01"]] as const) {
      const bucket = new FakeR2Bucket();
      const current = await seedAppcast(bucket, "2");
      await installArtifact(bucket, version);
      const response = await invoke(
        await signedRequest(
          await payload({
            candidate: await appcastBytes(version),
            expectedCurrent: {
              state: "present",
              bytes: current.byteLength,
              sha256: await sha256Hex(current),
              etag: null,
            },
          }),
          TOKEN,
          Math.floor(NOW / 1000),
          nonce,
        ),
        bindings(bucket),
        NOW,
      );
      expect(response.status).toBe(422);
      expect(bucket.putCalls).toBe(0);
    }
  });

  it("rejects malformed and multiple-current candidates", async () => {
    const malformed = new FakeR2Bucket();
    const malformedResponse = await invoke(
      await signedRequest(await payload({ candidate: encoder.encode("<rss>") })),
      bindings(malformed),
      NOW,
    );
    expect(malformedResponse.status).toBe(422);

    const one = new TextDecoder().decode(await appcastBytes("3"));
    const enclosure = one.match(/<enclosure\b[^>]*\/>/u)?.[0];
    expect(enclosure).toBeDefined();
    const multiple = encoder.encode(one.replace(enclosure as string, `${enclosure}${enclosure}`));
    const multipleResponse = await invoke(
      await signedRequest(
        await payload({ candidate: multiple }),
        TOKEN,
        Math.floor(NOW / 1000),
        "multiple-current-nonce-01",
      ),
      bindings(malformed),
      NOW,
    );
    expect(multipleResponse.status).toBe(422);
    expect(malformed.putCalls).toBe(0);
  });

  it("commits a valid higher candidate after independently verifying its artifact", async () => {
    const bucket = new FakeR2Bucket();
    const current = await seedAppcast(bucket, "1");
    await installArtifact(bucket, "2");
    const candidate = await appcastBytes("2");
    const response = await invoke(
      await signedRequest(await payload({
        candidate,
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
    expect(response.status).toBe(200);
    expect(bucket.putCalls).toBe(1);
    expect(bucket.object?.bytes).toEqual(candidate);
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
    const current = await appcastBytes("1");
    await installArtifact(bucket, "2");
    bucket.object = {
      bytes: current,
      etag: "current-etag",
      contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
      cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    };
    bucket.mutateBeforePut = true;
    const response = await invoke(
      await signedRequest(await payload({
        candidate: await appcastBytes("2"),
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
