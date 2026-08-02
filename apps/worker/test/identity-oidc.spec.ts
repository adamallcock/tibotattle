import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encodeBase64Url } from "../src/crypto";
import { ApiError } from "../src/errors";
import {
  clearIdentityJwksCacheForTests,
  identityRequired,
  verifyHostedIdentity,
} from "../src/identity-oidc";

/**
 * Direct, unit-level adversarial coverage for the hosted OIDC verifier.
 *
 * Every case here talks to `verifyHostedIdentity` directly with a synthetic
 * RSA keypair and an injected `jwksFetcher`, so nothing touches the network
 * or D1. Route-level coverage of the enrollment flow already lives in
 * worker.spec.ts ("mandatory hosted identity"); this file exists to pin the
 * exact claim-by-claim adversarial behaviour (issuer, audience, expiry,
 * signature, alg, kid) and the pairwise link-key derivation that route only
 * exercises at a coarse grain.
 */

const GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const APPLE_SERVICES_ID = "com.tibotattle.web";
const IDENTITY_LINK_SECRET = "identity-link-secret-for-tests-0123456789abcdef";
const GOOGLE_ISSUER = "https://accounts.google.com";
const APPLE_ISSUER = "https://appleid.apple.com";

// A fixed instant so exp/skew arithmetic in these tests is exact rather than
// racing the wall clock.
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

interface JwksKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface KeyMaterial {
  kid: string;
  privateKey: CryptoKey;
  jwk: JwksKey;
}

function bindings(overrides: Record<string, unknown> = {}): Env {
  return {
    GOOGLE_OIDC_CLIENT_ID: GOOGLE_CLIENT_ID,
    APPLE_SERVICES_ID: APPLE_SERVICES_ID,
    IDENTITY_LINK_SECRET,
    ...overrides,
  } as unknown as Env;
}

async function generateRsaKey(kid: string): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...publicJwk, kty: "RSA", kid, alg: "RS256", use: "sig" },
  };
}

function jsonSegment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function signingInputFor(header: object, payload: object): string {
  return `${jsonSegment(header)}.${jsonSegment(payload)}`;
}

async function rs256Signature(privateKey: CryptoKey, signingInput: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function hs256Signature(secretMaterial: string, signingInput: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function rs256Token(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signer: CryptoKey,
): Promise<string> {
  const input = signingInputFor(header, payload);
  return `${input}.${await rs256Signature(signer, input)}`;
}

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: "RS256", typ: "JWT", kid: "primary-kid", ...overrides };
}

function googlePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GOOGLE_ISSUER,
    aud: GOOGLE_CLIENT_ID,
    sub: "google-subject-0001",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 600,
    ...overrides,
  };
}

function applePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: APPLE_ISSUER,
    aud: APPLE_SERVICES_ID,
    sub: "apple-subject-0001",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 600,
    ...overrides,
  };
}

/**
 * Flips one base64url character to a different one. Deliberately targets the
 * middle of the string rather than the last character: base64's final
 * character of a non-multiple-of-3 byte length carries don't-care padding
 * bits that `atob` ignores, so flipping *that* specific character can
 * silently decode to the same bytes and produce a false-negative test.
 */
function flipMiddleChar(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = Math.floor(value.length / 2);
  const original = value[index]!;
  const replacement = alphabet[(alphabet.indexOf(original) + 1) % alphabet.length]!;
  return value.slice(0, index) + replacement + value.slice(index + 1);
}

function jwksFetcherFor(
  keys: JwksKey[],
  calls: string[] = [],
): (url: string) => Promise<{ keys: JwksKey[] }> {
  return async (url: string) => {
    calls.push(url);
    return { keys };
  };
}

/**
 * A fetcher that always throws. Used for cases that must be rejected purely
 * from the token's own claims/shape/header, before any JWKS lookup would
 * happen — using this in place of a working fetcher doubles as an assertion
 * that verification never reaches the network for these inputs.
 */
const poisonFetcher = async (): Promise<{ keys: JwksKey[] }> => {
  throw new Error("JWKS should not have been fetched for this case");
};

async function hmacSha256Hex(secret: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function expectedLinkKeyHex(
  secret: string,
  canonicalIssuer: string,
  subject: string,
): Promise<string> {
  return hmacSha256Hex(secret, `${canonicalIssuer}\0${subject}`);
}

let primary: KeyMaterial;
let decoy: KeyMaterial;
let attacker: KeyMaterial;

beforeAll(async () => {
  primary = await generateRsaKey("primary-kid");
  decoy = await generateRsaKey("decoy-kid");
  attacker = await generateRsaKey("attacker-kid");
});

beforeEach(() => {
  clearIdentityJwksCacheForTests();
});

describe("pairwise pseudonymous identifier derivation", () => {
  it("derives HMAC-SHA256(secret, issuer NUL subject) as lowercase hex, never containing the subject", async () => {
    const subject = "google-subject-alpha-1234567890";
    const token = await rs256Token(header(), googlePayload({ sub: subject }), primary.privateKey);
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");
    expect(verified.linkKeyHex).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.linkKeyHex).toBe(
      await expectedLinkKeyHex(IDENTITY_LINK_SECRET, GOOGLE_ISSUER, subject),
    );
    expect(verified.linkKeyHex.includes(subject)).toBe(false);
    // A space-separated material (a plausible off-by-one-byte regression: the
    // module doc comment renders identically to a NUL byte at a glance) must
    // NOT match: the actual separator is a NUL byte, not a space.
    expect(verified.linkKeyHex).not.toBe(
      await hmacSha256Hex(IDENTITY_LINK_SECRET, `${GOOGLE_ISSUER} ${subject}`),
    );
    // Nor may the issuer and subject be simply concatenated with no
    // separator at all (which would also make "AB"+"C" collide with "A"+"BC").
    expect(verified.linkKeyHex).not.toBe(
      await hmacSha256Hex(IDENTITY_LINK_SECRET, `${GOOGLE_ISSUER}${subject}`),
    );
  });

  it("canonicalizes both accepted Google issuer spellings to the same pseudonym", async () => {
    const subject = "google-subject-canonical";
    const canonical = await rs256Token(
      header(),
      googlePayload({ sub: subject, iss: "https://accounts.google.com" }),
      primary.privateKey,
    );
    const shortForm = await rs256Token(
      header(),
      googlePayload({ sub: subject, iss: "accounts.google.com" }),
      primary.privateKey,
    );
    const fetcher = jwksFetcherFor([primary.jwk]);
    const first = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: canonical },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    const second = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: shortForm },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    expect(second.linkKeyHex).toBe(first.linkKeyHex);
  });

  it("never collides Google and Apple subjects that share the same raw string", async () => {
    const sharedSubject = "shared-subject-value";
    const googleToken = await rs256Token(
      header(),
      googlePayload({ sub: sharedSubject }),
      primary.privateKey,
    );
    const appleToken = await rs256Token(
      header(),
      applePayload({ sub: sharedSubject }),
      primary.privateKey,
    );
    const fetcher = jwksFetcherFor([primary.jwk]);
    const google = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: googleToken },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    const apple = await verifyHostedIdentity(
      bindings(),
      { provider: "apple", idToken: appleToken },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    expect(apple.linkKeyHex).not.toBe(google.linkKeyHex);
  });
});

describe("adversarial claim validation", () => {
  it("rejects a wrong, downgraded, suffix-tricked, or cross-provider issuer", async () => {
    for (const badIssuer of [
      "https://not-google.example",
      "http://accounts.google.com",
      "https://accounts.google.com.evil.example",
      "https://accounts.google.com ",
      APPLE_ISSUER,
    ]) {
      const token = await rs256Token(
        header(),
        googlePayload({ iss: badIssuer }),
        primary.privateKey,
      );
      const rejected = verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      );
      await expect(rejected, badIssuer).rejects.toMatchObject({
        status: 401,
        code: "IDENTITY_TOKEN_INVALID",
      });
    }

    const appleWithGoogleIssuer = await rs256Token(
      header(),
      applePayload({ iss: GOOGLE_ISSUER }),
      primary.privateKey,
    );
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "apple", idToken: appleWithGoogleIssuer },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects a wrong audience, whether a single string or an array missing it", async () => {
    const wrongString = await rs256Token(
      header(),
      googlePayload({ aud: "someone-elses-client-id" }),
      primary.privateKey,
    );
    const wrongArray = await rs256Token(
      header(),
      googlePayload({ aud: ["someone-elses-client-id", "also-wrong"] }),
      primary.privateKey,
    );
    for (const token of [wrongString, wrongArray]) {
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });

  it("accepts an audience array that contains the expected client id among others", async () => {
    const token = await rs256Token(
      header(),
      googlePayload({ aud: ["some-other-audience", GOOGLE_CLIENT_ID] }),
      primary.privateKey,
    );
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");
  });

  it("enforces the 300-second expiry skew boundary precisely", async () => {
    const justWithinSkew = await rs256Token(
      header(),
      googlePayload({ exp: NOW_SECONDS - 300 }),
      primary.privateKey,
    );
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: justWithinSkew },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");

    const justOutsideSkew = await rs256Token(
      header(),
      googlePayload({ exp: NOW_SECONDS - 301 }),
      primary.privateKey,
    );
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: justOutsideSkew },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects a missing or non-numeric expiry", async () => {
    for (const payload of [
      (() => {
        const value = googlePayload();
        delete value.exp;
        return value;
      })(),
      googlePayload({ exp: "9999999999" }),
      googlePayload({ exp: null }),
    ]) {
      const token = await rs256Token(header(), payload, primary.privateKey);
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });

  it("accepts a subject at exactly the 256-character boundary and rejects one character over", async () => {
    const atLimit = "s".repeat(256);
    const overLimit = "s".repeat(257);
    const okToken = await rs256Token(
      header(),
      googlePayload({ sub: atLimit }),
      primary.privateKey,
    );
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: okToken },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");

    const tooLong = await rs256Token(
      header(),
      googlePayload({ sub: overLimit }),
      primary.privateKey,
    );
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: tooLong },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects a missing, empty, or non-string subject", async () => {
    for (const payload of [
      (() => {
        const value = googlePayload();
        delete value.sub;
        return value;
      })(),
      googlePayload({ sub: "" }),
      googlePayload({ sub: 12345 }),
    ]) {
      const token = await rs256Token(header(), payload, primary.privateKey);
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });
});

describe("signature integrity", () => {
  it("rejects a tampered signature", async () => {
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
    const tampered =
      `${headerSegment}.${payloadSegment}.${flipMiddleChar(signatureSegment!)}`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: tampered },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects claims edited after signing, even though the original signature is well-formed", async () => {
    const signingInput = signingInputFor(header(), googlePayload({ sub: "original-subject" }));
    const signature = await rs256Signature(primary.privateKey, signingInput);
    const editedPayload = googlePayload({ sub: "attacker-substituted-subject" });
    const forged = `${jsonSegment(header())}.${jsonSegment(editedPayload)}.${signature}`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: forged },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects a truncated signature as an invalid token rather than throwing an unhandled error", async () => {
    const signingInput = signingInputFor(header(), googlePayload());
    const truncated = `${signingInput}.AA`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: truncated },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects an empty signature segment", async () => {
    const signingInput = signingInputFor(header(), googlePayload());
    const empty = `${signingInput}.`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: empty },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });
});

describe("algorithm confusion", () => {
  it("rejects alg:none regardless of the signature segment", async () => {
    const signingInput = signingInputFor(header({ alg: "none" }), googlePayload());
    const token = `${signingInput}.`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects an RS256-to-HS256 downgrade signed with the RSA public modulus as an HMAC secret", async () => {
    const confusedHeader = header({ alg: "HS256" });
    const payload = googlePayload();
    const signingInput = signingInputFor(confusedHeader, payload);
    // The textbook alg-confusion attack: treat the server's own public key
    // material as if it were an HMAC secret it would never actually use.
    const forgedSignature = await hs256Signature(
      String(primary.jwk.n),
      signingInput,
    );
    const token = `${signingInput}.${forgedSignature}`;
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("rejects other RSA algorithms and a missing alg header", async () => {
    for (const badHeader of [
      header({ alg: "RS384" }),
      header({ alg: "PS256" }),
      (() => {
        const value = header({ alg: undefined });
        return value;
      })(),
    ]) {
      const token = await rs256Token(badHeader, googlePayload(), primary.privateKey);
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });
});

describe("key id (kid) handling", () => {
  it("rejects an unknown kid even though the signature would otherwise verify", async () => {
    const token = await rs256Token(
      header({ kid: "not-in-jwks" }),
      googlePayload(),
      primary.privateKey,
    );
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("tries every key when kid is absent, skipping non-matching candidates", async () => {
    const token = await rs256Token(
      header({ kid: undefined }),
      googlePayload(),
      primary.privateKey,
    );
    // Decoy listed first so a correct implementation must fall through it.
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([decoy.jwk, primary.jwk]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");
  });

  it("rejects a kid-less token when no candidate key verifies it", async () => {
    const token = await rs256Token(
      header({ kid: undefined }),
      googlePayload(),
      attacker.privateKey,
    );
    await expect(verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([decoy.jwk, primary.jwk]), nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
  });

  it("selects the matching key by kid out of a multi-key JWKS", async () => {
    const token = await rs256Token(
      header({ kid: "decoy-kid" }),
      googlePayload({ sub: "decoy-signed-subject" }),
      decoy.privateKey,
    );
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([primary.jwk, decoy.jwk]), nowMs: NOW_MS },
    );
    expect(verified.linkKeyHex).toBe(
      await expectedLinkKeyHex(IDENTITY_LINK_SECRET, GOOGLE_ISSUER, "decoy-signed-subject"),
    );
  });

  it("accepts a JWKS entry that omits the optional alg field", async () => {
    const bareKey = { ...primary.jwk };
    delete bareKey.alg;
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    const verified = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: jwksFetcherFor([bareKey]), nowMs: NOW_MS },
    );
    expect(verified.provider).toBe("google");
  });
});

describe("malformed identity envelopes", () => {
  it("requires identity to be a plain object", async () => {
    for (const identity of [null, [], "a-token", 42, true]) {
      await expect(verifyHostedIdentity(
        bindings(),
        identity,
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_REQUIRED" });
    }
  });

  it("rejects a malformed identity shape before ever touching a JWKS", async () => {
    const cases: unknown[] = [
      { provider: "google" },
      { idToken: "a.b.c" },
      { provider: "microsoft", idToken: "a.b.c" },
      { provider: "google", idToken: "" },
      { provider: "google", idToken: "a.b.c", extra: true },
      { provider: "google", idToken: "a".repeat(16_385) },
      { provider: "google", idToken: "only-one-segment" },
      { provider: "google", idToken: "two.segments" },
      { provider: "google", idToken: "a.b.c.d" },
      { provider: "google", idToken: "not-base64url!.b.c" },
      { provider: "google", idToken: `${jsonSegment([1, 2, 3])}.${jsonSegment({})}.c` },
    ];
    for (const identity of cases) {
      await expect(verifyHostedIdentity(
        bindings(),
        identity,
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });

  it("rejects an otherwise-perfect, correctly-signed token wrapped with an extra field or a bad provider", async () => {
    // Unlike the shape cases above (which pair a violation with token
    // content that would also fail JWT decoding on its own), these wrap a
    // fully valid, correctly signed token — isolating the envelope-shape and
    // provider-enum checks from every other layer that could reject it.
    const validToken = await rs256Token(header(), googlePayload(), primary.privateKey);
    const sanityCheck = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: validToken },
      { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
    );
    expect(sanityCheck.provider).toBe("google");

    for (const identity of [
      { provider: "google", idToken: validToken, extra: "unexpected" },
      { provider: "microsoft", idToken: validToken },
    ]) {
      await expect(verifyHostedIdentity(
        bindings(),
        identity,
        { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
      ), JSON.stringify(identity)).rejects.toMatchObject({
        status: 401,
        code: "IDENTITY_TOKEN_INVALID",
      });
    }
  });

  it("rejects a payload segment that is not a JSON object", async () => {
    const headerSegment = jsonSegment(header());
    for (const payloadSegment of [
      jsonSegment([1, 2, 3]),
      jsonSegment("just-a-string"),
      jsonSegment(42),
      jsonSegment(null),
    ]) {
      const token = `${headerSegment}.${payloadSegment}.signature`;
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_TOKEN_INVALID" });
    }
  });
});

describe("configuration failures", () => {
  it("fails closed with 503 when the expected audience is not configured, without leaking secrets", async () => {
    for (const overrides of [
      { GOOGLE_OIDC_CLIENT_ID: "" },
      { GOOGLE_OIDC_CLIENT_ID: undefined },
    ]) {
      const token = await rs256Token(header(), googlePayload(), primary.privateKey);
      const rejected = verifyHostedIdentity(
        bindings(overrides),
        { provider: "google", idToken: token },
        { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
      );
      await expect(rejected, JSON.stringify(overrides)).rejects.toMatchObject({
        status: 503,
        code: "IDENTITY_CONFIGURATION_INVALID",
      });
    }
    const appleToken = await rs256Token(header(), applePayload(), primary.privateKey);
    await expect(verifyHostedIdentity(
      bindings({ APPLE_SERVICES_ID: "" }),
      { provider: "apple", idToken: appleToken },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 503, code: "IDENTITY_CONFIGURATION_INVALID" });
  });

  it("fails closed with 503 for a missing or too-short link secret, only after the signature verifies", async () => {
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    for (const overrides of [
      { IDENTITY_LINK_SECRET: undefined },
      { IDENTITY_LINK_SECRET: "" },
      { IDENTITY_LINK_SECRET: "too-short-secret" },
    ]) {
      const rejected = verifyHostedIdentity(
        bindings(overrides),
        { provider: "google", idToken: token },
        { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
      );
      await expect(rejected, JSON.stringify(overrides)).rejects.toMatchObject({
        status: 503,
        code: "IDENTITY_CONFIGURATION_INVALID",
      });
    }
  });

  it("never echoes the configured secret or the token in a configuration error", async () => {
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    try {
      await verifyHostedIdentity(
        bindings({ IDENTITY_LINK_SECRET: "" }),
        { provider: "google", idToken: token },
        { jwksFetcher: jwksFetcherFor([primary.jwk]), nowMs: NOW_MS },
      );
      throw new Error("expected verifyHostedIdentity to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const serialized = JSON.stringify({
        code: (error as ApiError).code,
        message: (error as ApiError).message,
      });
      expect(serialized.includes(IDENTITY_LINK_SECRET)).toBe(false);
      expect(serialized.includes(token)).toBe(false);
    }
  });

  // NOTE: every other configuration failure in this file surfaces as 503
  // (a direct `new ApiError(503, "IDENTITY_CONFIGURATION_INVALID")`). This
  // one path is routed through the `identityError` helper instead, which is
  // hardcoded to 401 for every caller-facing token failure. The result is
  // that the very same error code answers with two different HTTP statuses
  // depending on which check tripped it. IDENTITY_TEST_JWKS_JSON is a
  // test-only escape hatch never set in deployed configuration, so this is
  // unreachable in production — but it is a real inconsistency in
  // src/identity-oidc.ts worth a deliberate look. See the final report.
  it("documents the current (inconsistent) status code for a malformed IDENTITY_TEST_JWKS_JSON", async () => {
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    await expect(verifyHostedIdentity(
      bindings({ IDENTITY_TEST_JWKS_JSON: "{not-json" }),
      { provider: "google", idToken: token },
      { jwksFetcher: poisonFetcher, nowMs: NOW_MS },
    )).rejects.toMatchObject({ status: 401, code: "IDENTITY_CONFIGURATION_INVALID" });
  });
});

describe("JWKS caching", () => {
  it("reuses cached keys within the TTL and refetches once it elapses", async () => {
    const calls: string[] = [];
    const fetcher = jwksFetcherFor([primary.jwk], calls);
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);

    await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    expect(calls).toHaveLength(1);

    await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: fetcher, nowMs: NOW_MS + 60_000 },
    );
    expect(calls).toHaveLength(1);

    await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: fetcher, nowMs: NOW_MS + 10 * 60_000 + 1 },
    );
    expect(calls).toHaveLength(2);
  });

  it("clearIdentityJwksCacheForTests forces a fresh fetch", async () => {
    const calls: string[] = [];
    const fetcher = jwksFetcherFor([primary.jwk], calls);
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);

    await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    expect(calls).toHaveLength(1);

    clearIdentityJwksCacheForTests();
    await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: token },
      { jwksFetcher: fetcher, nowMs: NOW_MS },
    );
    expect(calls).toHaveLength(2);
  });
});

describe("default JWKS fetcher", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fails closed as IDENTITY_PROVIDER_UNAVAILABLE for an unusable JWKS response", async () => {
    const token = await rs256Token(header(), googlePayload(), primary.privateKey);
    const responders: Array<() => Response> = [
      () => new Response("server error", { status: 500 }),
      () => new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
      () => new Response("not json", { status: 200 }),
      () => Response.json({ keys: "not-an-array" }),
      () => Response.json({ notKeys: [] }),
    ];
    for (const respond of responders) {
      globalThis.fetch = (async () => respond()) as typeof fetch;
      clearIdentityJwksCacheForTests();
      await expect(verifyHostedIdentity(
        bindings(),
        { provider: "google", idToken: token },
        { nowMs: NOW_MS },
      )).rejects.toMatchObject({ status: 401, code: "IDENTITY_PROVIDER_UNAVAILABLE" });
    }
  });

  it("verifies a real token through the default fetcher against the documented JWKS URLs", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      seenUrls.push(url);
      return Response.json({ keys: [primary.jwk] });
    }) as typeof fetch;

    const googleToken = await rs256Token(header(), googlePayload(), primary.privateKey);
    const google = await verifyHostedIdentity(
      bindings(),
      { provider: "google", idToken: googleToken },
      { nowMs: NOW_MS },
    );
    expect(google.provider).toBe("google");

    const appleToken = await rs256Token(header(), applePayload(), primary.privateKey);
    const apple = await verifyHostedIdentity(
      bindings(),
      { provider: "apple", idToken: appleToken },
      { nowMs: NOW_MS },
    );
    expect(apple.provider).toBe("apple");

    expect(seenUrls).toEqual([
      "https://www.googleapis.com/oauth2/v3/certs",
      "https://appleid.apple.com/auth/keys",
    ]);
  });
});

describe("identityRequired", () => {
  it("is mandatory outside every recognized development environment", () => {
    for (const environment of [
      "production", "staging", undefined, "", "SYNTHETIC-DEVELOPMENT", "prod",
    ]) {
      expect(
        identityRequired({ ENVIRONMENT: environment } as unknown as Env),
        String(environment),
      ).toBe(true);
    }
  });

  it("is optional inside every recognized development environment", () => {
    for (const environment of [
      "synthetic-development", "development", "local-development", "test",
    ]) {
      expect(
        identityRequired({ ENVIRONMENT: environment } as unknown as Env),
        environment,
      ).toBe(false);
    }
  });
});
