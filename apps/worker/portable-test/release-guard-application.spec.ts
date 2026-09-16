import { describe, expect, it } from "vitest";
import { createReleaseGuardApplication } from "../src/release-guard-application";
import { GcsReleaseObjectStore } from "../src/gcs-release-object-store";
import { sha256Hex } from "../src/content-digest";
import type { ReleaseNonceStore } from "../src/release-nonce-store";
import contract from "../src/sparkle-release-contract.json";

const encoder = new TextEncoder();
const now = 1_800_000_000_000;
const token = "synthetic-owner-token-portable-tests-only";
const bucket = "synthetic-gcp-release-test";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array) => b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  const artifact = encoder.encode("synthetic artifact; no executable or private data");
  const artifactKey = `${contract.objectPrefix}/1/${await sha256Hex(artifact)}/Synthetic.dmg`;
  const signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, artifact)));
  const candidate = encoder.encode(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<enclosure url="${contract.updateOrigin}/${artifactKey}" length="${artifact.byteLength}" sparkle:version="1" sparkle:edSignature="${signature}" />
</item></channel></rss>`);
  const payload = {
    schemaVersion: contract.guardSchema, channel: contract.channel, bucket: contract.r2Bucket,
    key: contract.appcastObjectKey, contentType: contract.appcastContentType,
    cacheControl: contract.appcastCacheControl,
    expectedCurrent: { state: "empty", bytes: 0, sha256: null, etag: null },
    candidate: { bytes: candidate.byteLength, sha256: await sha256Hex(candidate), base64: b64url(candidate) },
  };
  const body = JSON.stringify(payload);
  const signedRequest = async (nonce = "portable-test-nonce-0001") => {
    const timestamp = Math.floor(now / 1000);
    const canonical = `${contract.guardSchema}\0POST\0${contract.guardRoute}\0${timestamp}\0${nonce}\0${await sha256Hex(body)}`;
    const hmac = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const requestSignature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(canonical))));
    const request = () => new Request(`https://synthetic.test${contract.guardRoute}`, {
      method: "POST", headers: {
        "content-type": "application/json",
        "x-usage-monitor-release-timestamp": String(timestamp),
        "x-usage-monitor-release-nonce": nonce,
        "x-usage-monitor-release-signature": requestSignature,
      }, body,
    });
    return request();
  };
  const originalRequest = await signedRequest();
  return {
    artifact, artifactKey, candidate, signedRequest, request: () => originalRequest.clone(),
    signing: { token, publicEdKey: b64(publicBytes), publicEdKeySha256: await sha256Hex(publicBytes) },
  };
}

describe("release application outside Cloudflare", () => {
  it("publishes through a GCS adapter and rejects replay before any second storage access", async () => {
    const f = await fixture();
    let consumed = false;
    // Test double only. Deployed services require a durable shared nonce store.
    const nonces: ReleaseNonceStore = {
      async consume() {
        if (consumed) return "replay";
        consumed = true;
        return "consumed";
      },
    };
    const operations: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      expect(consumed).toBe(true);
      const url = new URL(String(input));
      expect(url.origin).toBe("https://storage.googleapis.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access-token");
      expect(init?.redirect).toBe("manual");
      operations.push(`${init?.method} ${url.pathname}`);
      if (url.pathname.startsWith("/upload/")) {
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        expect(url.searchParams.get("uploadType")).toBe("multipart");
        const uploaded = await new Response(init?.body).text();
        expect(uploaded).toContain(new TextDecoder().decode(f.candidate));
        expect(uploaded).toContain(contract.appcastCacheControl);
        return Response.json({
          bucket, name: contract.appcastObjectKey, generation: "9007199254740993",
          etag: "wire-appcast-tag", size: String(f.candidate.byteLength),
          contentType: contract.appcastContentType, cacheControl: contract.appcastCacheControl,
        });
      }
      const key = decodeURIComponent(url.pathname.split("/o/")[1]!);
      if (key === contract.appcastObjectKey) return new Response(null, { status: 404 });
      expect(key).toBe(f.artifactKey);
      if (url.searchParams.get("alt") === "media") {
        expect(url.searchParams.get("ifGenerationMatch")).toBe("9007199254740992");
        expect(url.searchParams.has("generation")).toBe(false);
        return new Response(f.artifact);
      }
      return Response.json({
        bucket, name: key, generation: "9007199254740992", etag: "wire-artifact-tag",
        size: String(f.artifact.byteLength), contentType: contract.artifactContentType,
        cacheControl: contract.artifactCacheControl,
      });
    };
    const app = createReleaseGuardApplication({
      contract, nonces, signing: f.signing, now: () => now,
      objects: new GcsReleaseObjectStore(bucket, async () => "synthetic-access-token", transport),
    });
    const first = await app.fetch(f.request());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      schemaVersion: contract.guardSchema, status: "committed", bytes: f.candidate.byteLength,
      sha256: await sha256Hex(f.candidate),
    });
    expect(operations).toHaveLength(4);
    const replay = await app.fetch(f.request());
    expect(replay.status).toBe(401);
    expect(operations).toHaveLength(4);
  });

  it.each([true, false])("recovers uncertain upload outcomes without replaying writes (committed=%s)", async (committedBeforeFailure) => {
    const f = await fixture();
    const claimed = new Set<string>();
    let stored = false;
    let failUpload = true;
    let uploads = 0;
    let calls = 0;
    const metadata = (key: string, bytes: Uint8Array) => ({
      bucket, name: key, generation: "9007199254740993", etag: "synthetic-tag",
      size: String(bytes.byteLength),
      contentType: key === f.artifactKey ? contract.artifactContentType : contract.appcastContentType,
      cacheControl: key === f.artifactKey ? contract.artifactCacheControl : contract.appcastCacheControl,
    });
    const transport: typeof fetch = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      if (url.pathname.startsWith("/upload/")) {
        uploads++;
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        if (stored) return new Response(null, { status: 412 });
        if (failUpload) {
          stored = committedBeforeFailure;
          throw new Error("synthetic-private-provider-error");
        }
        stored = true;
        return Response.json(metadata(contract.appcastObjectKey, f.candidate));
      }
      const key = decodeURIComponent(url.pathname.split("/o/")[1]!);
      if (key === contract.appcastObjectKey && !stored) return new Response(null, { status: 404 });
      expect([f.artifactKey, contract.appcastObjectKey]).toContain(key);
      const bytes = key === f.artifactKey ? f.artifact : f.candidate;
      if (url.searchParams.get("alt") === "media") {
        expect(url.searchParams.get("ifGenerationMatch")).toBe("9007199254740993");
        return new Response(bytes);
      }
      return Response.json(metadata(key, bytes));
    };
    const objects = new GcsReleaseObjectStore(bucket, async () => "synthetic-token", transport);
    const app = createReleaseGuardApplication({
      contract, objects, signing: f.signing, now: () => now,
      nonces: { async consume(nonce) {
        if (claimed.has(nonce)) return "replay";
        claimed.add(nonce);
        return "consumed";
      } },
    });
    const uncertain = await app.fetch(f.request());
    expect(uncertain.status).toBe(503);
    expect(await uncertain.text()).not.toContain("synthetic-private-provider-error");
    expect(uploads).toBe(1);
    const callsBeforeReplay = calls;
    expect((await app.fetch(f.request())).status).toBe(401);
    expect(calls).toBe(callsBeforeReplay);

    // Read-back resolves the uncertain outcome before a newly signed attempt.
    const observed = await objects.head(contract.appcastObjectKey);
    if (committedBeforeFailure) {
      expect(observed).not.toBeNull();
      const current = await objects.get(contract.appcastObjectKey, observed!.version);
      expect(current.status).toBe("found");
      if (current.status !== "found") throw new Error("expected committed object");
      expect(new Uint8Array(await current.arrayBuffer())).toEqual(f.candidate);
    } else {
      expect(observed).toBeNull();
    }
    failUpload = false;
    const retry = await app.fetch(await f.signedRequest("portable-test-nonce-0002"));
    expect(retry.status).toBe(committedBeforeFailure ? 409 : 200);
    expect(uploads).toBe(committedBeforeFailure ? 1 : 2);
  });

  it("refuses bad authentication, wrong routes and methods before consuming nonces or calling GCS", async () => {
    const f = await fixture();
    let touched = false;
    const app = createReleaseGuardApplication({
      contract, signing: f.signing, now: () => now,
      nonces: { async consume() { touched = true; throw new Error("must not call"); } },
      objects: new GcsReleaseObjectStore(bucket, async () => { touched = true; throw new Error("must not call"); }),
    });
    expect((await app.fetch(new Request("https://synthetic.test/unknown"))).status).toBe(404);
    expect((await app.fetch(new Request(`https://synthetic.test${contract.guardRoute}`))).status).toBe(405);
    const invalid = f.request();
    invalid.headers.set("x-usage-monitor-release-signature", "wrong");
    expect((await app.fetch(invalid)).status).toBe(401);
    expect(touched).toBe(false);
  });

  it("sanitizes a failed durable nonce operation and never accesses object storage", async () => {
    const f = await fixture();
    let touched = false;
    const app = createReleaseGuardApplication({
      contract, signing: f.signing, now: () => now,
      nonces: { async consume() { throw new Error("synthetic-secret-must-not-escape"); } },
      objects: new GcsReleaseObjectStore(bucket, async () => { touched = true; throw new Error("must not call"); }),
    });
    const response = await app.fetch(f.request());
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
    expect(text).not.toContain("synthetic-secret");
    expect(touched).toBe(false);
  });
});
