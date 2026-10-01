import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGoogleIdTokenSource,
  EDGE_INVOKER_KEY_INVALID,
  EDGE_TOKEN_UNAVAILABLE,
  EdgeGoogleIdTokenError,
  GOOGLE_OAUTH_TOKEN_URL,
  JWT_BEARER_GRANT_TYPE,
  type GoogleIdTokenFetcher,
  type GoogleIdTokenSource,
} from "../src/edge-google-id-token";

// Every key, account and token here is synthetic and generated in-process.
const SERVICE_ACCOUNT = "tibotattle-edge-invoker@tibotattle-synthetic.iam.gserviceaccount.com";
const OTHER_SERVICE_ACCOUNT = "tibotattle-other-account@tibotattle-synthetic.iam.gserviceaccount.com";
const BODY_MARKER = "SYNTHETIC-PROVIDER-BODY-MARKER";
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
// The brief's bounds, pinned as literals so a changed module constant fails.
const MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES = 8_192;
const MAX_TOKEN_RESPONSE_BYTES = 16_384;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

const encoder = new TextEncoder();
// Captured before any case installs fake timers.
const realSetTimeout = globalThis.setTimeout;
let audienceSequence = 0;

// The token cache is per isolate and keyed by account + audience, so each
// case takes its own audience unless it is testing that sharing.
function freshAudience(): string {
  audienceSequence += 1;
  return `https://tibotattle-origin-${audienceSequence}.synthetic.test`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function jsonSegment(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pem(label: string, der: ArrayBuffer): string {
  const body = base64(new Uint8Array(der)).match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${body.join("\n")}\n-----END ${label}-----\n`;
}

interface SyntheticKey {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly publicKey: CryptoKey;
}

async function rsaKey(modulusLength: number): Promise<SyntheticKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer;
  return { keyId: randomHex(20), privateKeyPem: pem("PRIVATE KEY", der), publicKey: pair.publicKey };
}

function keyJson(key: SyntheticKey, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "tibotattle-synthetic",
    private_key_id: key.keyId,
    private_key: key.privateKeyPem,
    client_email: SERVICE_ACCOUNT,
    client_id: "100000000000000000001",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/synthetic",
    universe_domain: "googleapis.com",
    ...overrides,
  });
}

function paddedKeyJson(key: SyntheticKey, totalBytes: number): string {
  const base = keyJson(key, { padding: "" });
  const missing = totalBytes - encoder.encode(base).byteLength;
  if (missing < 0) throw new Error("padding does not fit");
  return keyJson(key, { padding: "x".repeat(missing) });
}

// 8192 UTF-16 code units, but more than 8192 UTF-8 bytes.
function multiByteKeyJson(key: SyntheticKey): string {
  const base = keyJson(key, { padding: "" });
  const json = keyJson(key, { padding: "\u00e9".repeat(MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES - base.length) });
  if (json.length !== MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES
      || encoder.encode(json).byteLength <= MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES) {
    throw new Error("multi-byte padding does not fit");
  }
  return json;
}

function fakeIdToken(claims: Record<string, unknown>): string {
  return [
    jsonSegment({ alg: "RS256", kid: "synthetic-google-kid", typ: "JWT" }),
    jsonSegment({ iss: "https://accounts.google.com", ...claims }),
    base64Url(crypto.getRandomValues(new Uint8Array(256))),
  ].join(".");
}

// Lengthens a token's signature segment so the token is exactly `length`
// characters and still three base64url segments.
function paddedIdToken(token: string, length: number): string {
  if (token.length > length) throw new Error("token already too long");
  return `${token}${"A".repeat(length - token.length)}`;
}

function tokenSegments(token: string): [string, string, string] {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("not a three-segment token");
  return segments as [string, string, string];
}

interface Exchange {
  readonly url: string;
  readonly init: RequestInit;
  readonly form: URLSearchParams;
}

type Responder = (exchange: Exchange, index: number) => Response | Promise<Response>;

interface RecordingFetcher {
  readonly exchanges: Exchange[];
  readonly fetcher: GoogleIdTokenFetcher;
}

function recordingFetcher(respond: Responder): RecordingFetcher {
  const exchanges: Exchange[] = [];
  return {
    exchanges,
    fetcher: async (url, init) => {
      const exchange = { url, init, form: new URLSearchParams(String(init.body)) };
      exchanges.push(exchange);
      return respond(exchange, exchanges.length - 1);
    },
  };
}

function tokenResponse(token: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({
    access_token: "unused-synthetic-access-token",
    id_token: token,
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

function mintedToken(audience: string, now: () => number, extra: Record<string, unknown> = {}): string {
  const issuedAt = Math.floor(now() / 1_000);
  return fakeIdToken({
    aud: audience,
    azp: SERVICE_ACCOUNT,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: issuedAt,
    exp: issuedAt + 3_600,
    sub: "100000000000000000001",
    ...extra,
  });
}

function serializedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const own = Object.getOwnPropertyNames(error)
    .map((name) => `${name}=${String(Reflect.get(error, name))}`);
  return [String(error), error.stack ?? "", JSON.stringify(error), ...own].join("\n");
}

function expectCodeWithoutSecrets(error: unknown, code: string, secrets: readonly string[]): void {
  expect(error).toBeInstanceOf(EdgeGoogleIdTokenError);
  const typed = error as EdgeGoogleIdTokenError;
  expect(typed.code).toBe(code);
  expect(typed.message).toBe(code);
  expect(typed.cause).toBeUndefined();
  const rendered = serializedError(error);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(8);
    expect(rendered.includes(secret)).toBe(false);
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function keySecrets(key: SyntheticKey): string[] {
  const body = key.privateKeyPem.split("\n").slice(1, -2);
  return [key.keyId, ...body.filter((line) => line.length === 64).slice(0, 6), key.privateKeyPem];
}

let primary: SyntheticKey;
let secondary: SyntheticKey;
let weak: SyntheticKey;
let ecPkcs8Pem: string;

beforeAll(async () => {
  primary = await rsaKey(2_048);
  secondary = await rsaKey(2_048);
  weak = await rsaKey(1_024);
  const ec = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  ecPkcs8Pem = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", ec.privateKey) as ArrayBuffer);
});

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
  try {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

interface Harness {
  readonly audience: string;
  readonly source: GoogleIdTokenSource;
  readonly recorder: RecordingFetcher;
  readonly clock: { now: number };
}

type ResponderFactory = (audience: string, clock: { now: number }) => Responder;

const validResponder: ResponderFactory = (audience, clock) => () =>
  tokenResponse(mintedToken(audience, () => clock.now));

async function harness(makeResponder: ResponderFactory = validResponder): Promise<Harness> {
  const audience = freshAudience();
  const clock = { now: T0 };
  const recorder = recordingFetcher(makeResponder(audience, clock));
  const source = await createGoogleIdTokenSource({
    serviceAccountKeyJson: keyJson(primary),
    expectedServiceAccount: SERVICE_ACCOUNT,
    audience,
    fetcher: recorder.fetcher,
    clock: () => clock.now,
  });
  return { audience, source, recorder, clock };
}

describe("edge Google ID-token source: the JWT-bearer exchange", () => {
  it("signs a verifiable RS256 assertion with the exact header and claims and posts a form-encoded jwt-bearer grant", async () => {
    const { audience, source, recorder, clock } = await harness();
    expect(recorder.exchanges).toHaveLength(0);

    const token = await source.getToken();

    expect(recorder.exchanges).toHaveLength(1);
    const [exchange] = recorder.exchanges;
    expect(exchange!.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(exchange!.url).toBe("https://oauth2.googleapis.com/token");
    expect(exchange!.init.method).toBe("POST");
    expect(new Headers(exchange!.init.headers).get("content-type"))
      .toBe("application/x-www-form-urlencoded");
    expect(exchange!.init.redirect).toBe("manual");
    expect(exchange!.init.cache).toBe("no-store");
    expect(exchange!.init.signal).toBeInstanceOf(AbortSignal);
    expect(typeof exchange!.init.body).toBe("string");
    expect([...exchange!.form.keys()]).toEqual(["grant_type", "assertion"]);
    expect(exchange!.form.get("grant_type")).toBe(JWT_BEARER_GRANT_TYPE);
    expect(exchange!.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const assertion = exchange!.form.get("assertion")!;
    const segments = assertion.split(".");
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_-]+$/u);
    const [headerSegment, claimsSegment, signatureSegment] = segments as [string, string, string];
    expect(new TextDecoder().decode(fromBase64Url(headerSegment)))
      .toBe(`{"alg":"RS256","typ":"JWT","kid":"${primary.keyId}"}`);
    const issuedAt = Math.floor(clock.now / 1_000);
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(claimsSegment))) as unknown;
    expect(claims).toStrictEqual({
      iss: SERVICE_ACCOUNT,
      sub: SERVICE_ACCOUNT,
      aud: "https://oauth2.googleapis.com/token",
      target_audience: audience,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    });
    await expect(crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      primary.publicKey,
      fromBase64Url(signatureSegment),
      encoder.encode(`${headerSegment}.${claimsSegment}`),
    )).resolves.toBe(true);
    await expect(crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      secondary.publicKey,
      fromBase64Url(signatureSegment),
      encoder.encode(`${headerSegment}.${claimsSegment}`),
    )).resolves.toBe(false);

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(token.split(".")[1]!))) as Record<string, unknown>;
    expect(payload["aud"]).toBe(audience);
    expect(payload["email"]).toBe(SERVICE_ACCOUNT);
  });

  it("uses fetch options workerd accepts; workerd rejects redirect 'error' outright", async () => {
    const { source, recorder } = await harness();
    await source.getToken();
    const init = recorder.exchanges[0]!.init;
    // The exact init the source hands to fetch is valid in this runtime.
    const request = new Request(GOOGLE_OAUTH_TOKEN_URL, init);
    expect(request.redirect).toBe("manual");
    expect(request.method).toBe("POST");
    // This is why redirects are refused with manual mode plus the exact-200
    // check rather than with redirect: "error".
    expect(() => new Request(GOOGLE_OAUTH_TOKEN_URL, { redirect: "error" }))
      .toThrow(/Invalid redirect value/u);
  });

  it("uses the global fetch when no fetcher is injected, called without a foreign receiver", async () => {
    const audience = freshAudience();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    const receivers: unknown[] = [];
    // A non-arrow function sees its real receiver. workerd's fetch throws
    // "Illegal invocation" for any receiver other than undefined or the
    // global scope, which this Workers pool does not reproduce, so the
    // receiver itself is the pinned contract.
    globalThis.fetch = async function recordingGlobalFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      receivers.push(this);
      calls.push(`${String(input)} ${init?.method ?? ""}`);
      return tokenResponse(mintedToken(audience, Date.now));
    } as typeof fetch;
    try {
      const source = await createGoogleIdTokenSource({
        serviceAccountKeyJson: keyJson(primary),
        expectedServiceAccount: SERVICE_ACCOUNT,
        audience,
      });
      await expect(source.getToken()).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([`${GOOGLE_OAUTH_TOKEN_URL} POST`]);
    expect(receivers).toHaveLength(1);
    expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
  });

  it("calls an injected fetcher as a plain function, so the runtime's own fetch can be injected", async () => {
    const audience = freshAudience();
    const receivers: unknown[] = [];
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: async function injectedFetcher(this: unknown): Promise<Response> {
        receivers.push(this);
        return tokenResponse(mintedToken(audience, () => T0));
      },
      clock: () => T0,
    });
    await expect(source.getToken()).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    // Called as a method, the receiver would be the source's internal context
    // and an injected `fetch` would throw "Illegal invocation" in workerd.
    expect(receivers).toEqual([undefined]);
  });
});

describe("edge Google ID-token source: cache, single flight and negative cache", () => {
  it("serves a cached token without a fetch and refreshes at 300 s before expiry", async () => {
    const { source, recorder, clock } = await harness();
    const first = await source.getToken();
    expect(recorder.exchanges).toHaveLength(1);

    clock.now = T0 + 60_000;
    await expect(source.getToken()).resolves.toBe(first);
    clock.now = T0 + (3_600 - 300 - 1) * 1_000;
    await expect(source.getToken()).resolves.toBe(first);
    expect(recorder.exchanges).toHaveLength(1);

    clock.now = T0 + (3_600 - 300) * 1_000;
    const second = await source.getToken();
    expect(second).not.toBe(first);
    expect(recorder.exchanges).toHaveLength(2);
    // The refresh assertion is issued at the refresh time.
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(
      recorder.exchanges[1]!.form.get("assertion")!.split(".")[1]!,
    ))) as { iat: number };
    expect(claims.iat).toBe(Math.floor(clock.now / 1_000));
    await expect(source.getToken()).resolves.toBe(second);
    expect(recorder.exchanges).toHaveLength(2);
  });

  it("does not cache beyond one hour even when the token claims a later exp", async () => {
    const audience = freshAudience();
    const clock = { now: T0 };
    const recorder = recordingFetcher(() => tokenResponse(
      mintedToken(audience, () => clock.now, { exp: Math.floor(clock.now / 1_000) + 86_400 }),
    ));
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: recorder.fetcher,
      clock: () => clock.now,
    });
    await source.getToken();
    clock.now = T0 + (3_600 - 300 - 1) * 1_000;
    await source.getToken();
    expect(recorder.exchanges).toHaveLength(1);
    clock.now = T0 + (3_600 - 300) * 1_000;
    await source.getToken();
    expect(recorder.exchanges).toHaveLength(2);
  });

  it("refreshes by the token's own exp when it is shorter than the one-hour cap", async () => {
    const audience = freshAudience();
    const clock = { now: T0 };
    // Ten minutes of validity, as seen by this clock: a short-lived token or a
    // Worker clock running ahead of the issuer's.
    const recorder = recordingFetcher(() => tokenResponse(
      mintedToken(audience, () => clock.now, { exp: Math.floor(clock.now / 1_000) + 600 }),
    ));
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: recorder.fetcher,
      clock: () => clock.now,
    });
    const first = await source.getToken();
    clock.now = T0 + (600 - 300 - 1) * 1_000;
    await expect(source.getToken()).resolves.toBe(first);
    expect(recorder.exchanges).toHaveLength(1);
    clock.now = T0 + (600 - 300) * 1_000;
    await expect(source.getToken()).resolves.not.toBe(first);
    expect(recorder.exchanges).toHaveLength(2);
  });

  it("shares one in-flight exchange across 20 concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const audience = freshAudience();
    const recorder = recordingFetcher(async () => {
      await gate;
      return tokenResponse(mintedToken(audience, () => T0));
    });
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: recorder.fetcher,
      clock: () => T0,
    });
    const pending = Array.from({ length: 20 }, () => source.getToken());
    // Let the single exchange reach the fetcher before releasing it.
    for (let turn = 0; turn < 50 && recorder.exchanges.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(recorder.exchanges).toHaveLength(1);
    release();
    const tokens = await Promise.all(pending);
    expect(new Set(tokens).size).toBe(1);
    expect(recorder.exchanges).toHaveLength(1);
  });

  it("rejects 20 concurrent callers of one failed exchange with one fetch", async () => {
    const { source, recorder } = await harness(() => () => new Response(BODY_MARKER, { status: 503 }));
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => source.getToken()));
    expect(recorder.exchanges).toHaveLength(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expectCodeWithoutSecrets((outcome as PromiseRejectedResult).reason, EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    }
  });

  it("holds a 10 s negative cache after a failed exchange", async () => {
    const { source, recorder, clock } = await harness((audience, providerClock) => (_, index) => (index === 0
      ? new Response(BODY_MARKER, { status: 500 })
      : tokenResponse(mintedToken(audience, () => providerClock.now))));

    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(recorder.exchanges).toHaveLength(1);

    clock.now = T0 + 1;
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    clock.now = T0 + 9_999;
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(recorder.exchanges).toHaveLength(1);

    clock.now = T0 + 10_000;
    await expect(source.getToken()).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    expect(recorder.exchanges).toHaveLength(2);
  });

  it("drops a token that fails to refresh inside the margin instead of serving it", async () => {
    const { source, recorder, clock } = await harness((audience, providerClock) => (_, index) => (index === 1
      ? new Response(BODY_MARKER, { status: 500 })
      : tokenResponse(mintedToken(audience, () => providerClock.now))));
    await source.getToken();
    clock.now = T0 + (3_600 - 120) * 1_000;
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, []);
    clock.now += 9_999;
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, []);
    expect(recorder.exchanges).toHaveLength(2);
    clock.now += 1;
    await source.getToken();
    expect(recorder.exchanges).toHaveLength(3);
  });

  it("keys the per-isolate cache by account and audience", async () => {
    const { audience, source, recorder, clock } = await harness();
    const first = await source.getToken();

    const rebuilt = recordingFetcher(() => tokenResponse(mintedToken(audience, () => clock.now)));
    const rebuiltSource = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(secondary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: rebuilt.fetcher,
      clock: () => clock.now,
    });
    await expect(rebuiltSource.getToken()).resolves.toBe(first);
    expect(rebuilt.exchanges).toHaveLength(0);

    const otherAudience = freshAudience();
    const separate = recordingFetcher(() => tokenResponse(mintedToken(otherAudience, () => clock.now)));
    const separateSource = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience: otherAudience,
      fetcher: separate.fetcher,
      clock: () => clock.now,
    });
    const other = await separateSource.getToken();
    expect(other).not.toBe(first);
    expect(separate.exchanges).toHaveLength(1);

    const otherAccount = recordingFetcher(() => tokenResponse(mintedToken(audience, () => clock.now, {
      email: OTHER_SERVICE_ACCOUNT,
    })));
    const otherAccountSource = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary, { client_email: OTHER_SERVICE_ACCOUNT }),
      expectedServiceAccount: OTHER_SERVICE_ACCOUNT,
      audience,
      fetcher: otherAccount.fetcher,
      clock: () => clock.now,
    });
    const otherAccountToken = await otherAccountSource.getToken();
    expect(otherAccountToken).not.toBe(first);
    expect(otherAccount.exchanges).toHaveLength(1);
    expect(recorder.exchanges).toHaveLength(1);
  });
});

describe("edge Google ID-token source: every exchange failure is content-free", () => {
  interface FailureCase {
    readonly name: string;
    readonly respond: (audience: string, now: () => number) => Response | Promise<Response>;
  }

  function streamed(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    });
  }

  const cases: readonly FailureCase[] = [
    { name: "a 500", respond: () => new Response(`${BODY_MARKER} internal`, { status: 500 }) },
    { name: "a 400 invalid_grant", respond: () => Response.json({ error: "invalid_grant", error_description: BODY_MARKER }, { status: 400 }) },
    { name: "a 401", respond: () => new Response(BODY_MARKER, { status: 401 }) },
    { name: "a 429", respond: () => new Response(BODY_MARKER, { status: 429 }) },
    {
      name: "a non-200 success carrying an otherwise valid token",
      respond: (audience, now) => tokenResponse(mintedToken(audience, now), { status: 201 }),
    },
    {
      name: "a 302 redirect",
      respond: () => new Response(BODY_MARKER, {
        status: 302,
        headers: { location: `https://redirect.synthetic.test/${BODY_MARKER}` },
      }),
    },
    { name: "a 307 redirect", respond: () => Response.redirect(`https://redirect.synthetic.test/${BODY_MARKER}`, 307) },
    { name: "a 308 redirect", respond: () => Response.redirect(`https://redirect.synthetic.test/${BODY_MARKER}`, 308) },
    {
      name: "a streamed body over 16 KiB",
      respond: (audience, now) => {
        const valid = JSON.stringify({ id_token: mintedToken(audience, now), padding: "" });
        const oversize = JSON.stringify({
          id_token: mintedToken(audience, now),
          padding: `${BODY_MARKER}${"x".repeat(MAX_TOKEN_RESPONSE_BYTES + 1 - encoder.encode(valid).byteLength - BODY_MARKER.length)}`,
        });
        expect(encoder.encode(oversize).byteLength).toBe(MAX_TOKEN_RESPONSE_BYTES + 1);
        const bytes = encoder.encode(oversize);
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += 1_000) chunks.push(bytes.slice(offset, offset + 1_000));
        return new Response(streamed(chunks), { status: 200 });
      },
    },
    {
      name: "a declared content-length over 16 KiB, even over an otherwise valid body",
      respond: (audience, now) => new Response(streamed([encoder.encode(JSON.stringify({
        id_token: mintedToken(audience, now),
        padding: BODY_MARKER,
      }))]), {
        status: 200,
        headers: { "content-length": String(MAX_TOKEN_RESPONSE_BYTES + 1) },
      }),
    },
    { name: "invalid JSON", respond: () => new Response(`{"id_token": "${BODY_MARKER}`, { status: 200 }) },
    { name: "invalid UTF-8", respond: () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 }) },
    { name: "a JSON array", respond: () => Response.json([BODY_MARKER]) },
    { name: "an empty body", respond: () => new Response(null, { status: 200 }) },
    { name: "a missing id_token", respond: () => Response.json({ access_token: BODY_MARKER, token_type: "Bearer" }) },
    { name: "a non-string id_token", respond: () => Response.json({ id_token: { value: BODY_MARKER } }) },
    { name: "an id_token without three segments", respond: () => Response.json({ id_token: `${BODY_MARKER}.segment` }) },
    {
      // Only the segment count is wrong: the payload is valid.
      name: "an otherwise valid id_token with two segments",
      respond: (audience, now) => {
        const [header, payload] = tokenSegments(mintedToken(audience, now));
        return tokenResponse(`${header}.${payload}`);
      },
    },
    {
      name: "an otherwise valid id_token with four segments",
      respond: (audience, now) => {
        const [header, payload, signature] = tokenSegments(mintedToken(audience, now));
        return tokenResponse(`${header}.${payload}.${signature}.${signature}`);
      },
    },
    { name: "an id_token whose payload is not JSON", respond: () => Response.json({ id_token: `header.${base64Url(encoder.encode(BODY_MARKER))}.signature` }) },
    { name: "an id_token over the origin's bearer bound", respond: (audience, now) => Response.json({ id_token: `${mintedToken(audience, now)}${"A".repeat(8_192)}` }) },
    {
      name: "an id_token one character over the origin's bearer bound",
      respond: (audience, now) => tokenResponse(paddedIdToken(mintedToken(audience, now), 8_192 - "Bearer ".length + 1)),
    },
    { name: "a wrong aud", respond: (_, now) => tokenResponse(mintedToken("https://other-origin.synthetic.test", now)) },
    { name: "an aud array", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { aud: [audience] })) },
    { name: "a wrong email", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { email: OTHER_SERVICE_ACCOUNT })) },
    { name: "a missing email", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { email: undefined })) },
    { name: "email_verified false", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { email_verified: false })) },
    { name: "a missing email_verified", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { email_verified: undefined })) },
    { name: "a string email_verified", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { email_verified: "true" })) },
    { name: "an expired token", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { exp: Math.floor(now() / 1_000) })) },
    { name: "a string exp", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { exp: `${Math.floor(now() / 1_000) + 3_600}` })) },
    { name: "a fractional exp", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { exp: Math.floor(now() / 1_000) + 3_600.5 })) },
    { name: "an exp beyond the safe integers", respond: (audience, now) => tokenResponse(mintedToken(audience, now, { exp: 2 ** 53 })) },
    { name: "a network error", respond: () => Promise.reject(new TypeError(`network failure ${BODY_MARKER}`)) },
    { name: "a non-Response result", respond: () => ({ status: 200, body: BODY_MARKER }) as unknown as Response },
  ];

  for (const failure of cases) {
    it(`rejects ${failure.name} with EDGE_TOKEN_UNAVAILABLE and no secret material`, async () => {
      const { source, recorder } = await harness((audience, clock) => () =>
        failure.respond(audience, () => clock.now));
      const error = await rejection(source.getToken());
      expect(recorder.exchanges).toHaveLength(1);
      const assertion = recorder.exchanges[0]!.form.get("assertion")!;
      expectCodeWithoutSecrets(error, EDGE_TOKEN_UNAVAILABLE, [
        BODY_MARKER,
        assertion,
        assertion.split(".")[2]!,
        ...keySecrets(primary),
      ]);
    });
  }

  it("never leaks a token it received but refused", async () => {
    let refused = "";
    const { source } = await harness((audience, clock) => () => {
      refused = mintedToken(audience, () => clock.now, { email: OTHER_SERVICE_ACCOUNT });
      return tokenResponse(refused);
    });
    const error = await rejection(source.getToken());
    expectCodeWithoutSecrets(error, EDGE_TOKEN_UNAVAILABLE, [refused, refused.split(".")[1]!]);
  });

  it("cancels an oversize stream instead of draining it", async () => {
    let pulledBytes = 0;
    let cancelled = false;
    // Finite (128 KiB) so a missing cap fails the assertions instead of hanging.
    const { source } = await harness(() => () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulledBytes >= 32 * 4_096) {
          controller.close();
          return;
        }
        const chunk = encoder.encode(BODY_MARKER.padEnd(4_096, "x"));
        pulledBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 }));
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(cancelled).toBe(true);
    expect(pulledBytes).toBeLessThanOrEqual(MAX_TOKEN_RESPONSE_BYTES + 3 * 4_096);
  });

  it("cancels the body of a refused non-200 response", async () => {
    let cancelled = false;
    const { source } = await harness(() => () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(BODY_MARKER));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 503 }));
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("accepts a response of exactly 16 KiB", async () => {
    const { source } = await harness((audience, clock) => () => {
      const token = mintedToken(audience, () => clock.now);
      const base = JSON.stringify({ id_token: token, padding: "" });
      const exact = JSON.stringify({
        id_token: token,
        padding: "x".repeat(MAX_TOKEN_RESPONSE_BYTES - encoder.encode(base).byteLength),
      });
      expect(encoder.encode(exact).byteLength).toBe(MAX_TOKEN_RESPONSE_BYTES);
      return new Response(exact, { status: 200 });
    });
    await expect(source.getToken()).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
  });

  it("accepts an id_token at the origin's bearer bound (8192 characters less 'Bearer ')", async () => {
    let served = "";
    const { source } = await harness((audience, clock) => () => {
      served = paddedIdToken(mintedToken(audience, () => clock.now), 8_192 - "Bearer ".length);
      return tokenResponse(served);
    });
    const token = await source.getToken();
    expect(served).toHaveLength(8_185);
    expect(token).toBe(served);
  });

  it("rejects a fetcher that throws synchronously", async () => {
    const audience = freshAudience();
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience,
      fetcher: () => {
        throw new Error(`synchronous ${BODY_MARKER}`);
      },
      clock: () => T0,
    });
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
  });

  it("rejects a throwing clock with EDGE_TOKEN_UNAVAILABLE and without a fetch", async () => {
    const recorder = recordingFetcher(() => new Response(BODY_MARKER));
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience: freshAudience(),
      fetcher: recorder.fetcher,
      clock: () => {
        throw new Error(`clock failure ${BODY_MARKER}`);
      },
    });
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(recorder.exchanges).toHaveLength(0);
  });

  it("rejects an unusable clock without a fetch", async () => {
    const recorder = recordingFetcher(() => new Response(BODY_MARKER));
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience: freshAudience(),
      fetcher: recorder.fetcher,
      clock: () => Number.NaN,
    });
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, []);
    expect(recorder.exchanges).toHaveLength(0);
  });
});

describe("edge Google ID-token source: the 5 s deadline", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    return { promise, resolve };
  }

  async function settledState(promise: Promise<unknown>): Promise<"pending" | "settled"> {
    let state: "pending" | "settled" = "pending";
    promise.then(() => { state = "settled"; }, () => { state = "settled"; });
    await vi.advanceTimersByTimeAsync(0);
    return state;
  }

  const TOKEN_SHAPE = /^[^.]+\.[^.]+\.[^.]+$/u;

  // A cancelled request loses its timers with it. Installed after the fake
  // timers, this drops the next timer set (the originating request's exchange
  // deadline) so that exchange's fetch can stay pending forever.
  function dropOriginatorDeadline(): { dropped: () => boolean; restore: () => void } {
    const fakeSetTimeout = globalThis.setTimeout;
    let pending = true;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      milliseconds?: number,
    ) => {
      if (pending) {
        pending = false;
        return 0;
      }
      return fakeSetTimeout(handler, milliseconds);
    }) as unknown as typeof setTimeout);
    return { dropped: () => !pending, restore: () => spy.mockRestore() };
  }

  // Resolves to the promise's value, or to "still-pending" after `milliseconds`
  // of real time, so a caller that wrongly waits on a fake timer fails fast.
  function withinRealTime<T>(promise: Promise<T>, milliseconds: number): Promise<T | "still-pending"> {
    return Promise.race([
      promise,
      new Promise<"still-pending">((resolve) => realSetTimeout(() => resolve("still-pending"), milliseconds)),
    ]);
  }

  // The first exchange is orphaned (its fetch never settles); later ones mint.
  const orphanThenMint = (called: { resolve: () => void }): ResponderFactory =>
    (audience, providerClock) => (_, index) => {
      if (index === 0) {
        called.resolve();
        return new Promise<Response>(() => undefined);
      }
      return tokenResponse(mintedToken(audience, () => providerClock.now));
    };

  it("aborts an exchange whose headers do not arrive within 5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const called = deferred();
    let observedAbort = false;
    const { source } = await harness(() => (exchange) => new Promise<Response>((_, reject) => {
      exchange.init.signal!.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error(`aborted ${BODY_MARKER}`));
      });
      called.resolve();
    }));
    const pending = source.getToken();
    const outcome = rejection(pending);
    await called.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settledState(pending)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expectCodeWithoutSecrets(await outcome, EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(observedAbort).toBe(true);
  });

  it("times out a fetcher that ignores the abort signal, and discards its late response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const called = deferred();
    let deliverLate!: (response: Response) => void;
    let lateBodyCancelled = false;
    const { source } = await harness(() => () => new Promise<Response>((resolve) => {
      deliverLate = resolve;
      called.resolve();
    }));
    const outcome = rejection(source.getToken());
    await called.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expectCodeWithoutSecrets(await outcome, EDGE_TOKEN_UNAVAILABLE, []);
    deliverLate(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(BODY_MARKER));
      },
      cancel() {
        lateBodyCancelled = true;
      },
    }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateBodyCancelled).toBe(true);
  });

  it("aborts a body that stalls after the headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const called = deferred();
    let bodyCancelled = false;
    const { source } = await harness(() => () => {
      called.resolve();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`{"id_token":"${BODY_MARKER}`));
        },
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          bodyCancelled = true;
        },
      }), { status: 200 });
    });
    const pending = source.getToken();
    const outcome = rejection(pending);
    await called.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settledState(pending)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expectCodeWithoutSecrets(await outcome, EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
    expect(bodyCancelled).toBe(true);
  });

  it("fails the originator and a joiner together at 5 s and starts the negative cache", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const called = deferred();
    const { source, recorder, clock } = await harness(() => () => {
      called.resolve();
      return new Promise<Response>(() => undefined);
    });
    const outcome = rejection(source.getToken());
    await called.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    const joined = source.getToken();
    const joinedOutcome = rejection(joined);
    clock.now = T0 + 5_000;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(await settledState(joined)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expectCodeWithoutSecrets(await outcome, EDGE_TOKEN_UNAVAILABLE, []);
    expectCodeWithoutSecrets(await joinedOutcome, EDGE_TOKEN_UNAVAILABLE, []);
    clock.now = T0 + 5_000 + 9_999;
    expectCodeWithoutSecrets(await rejection(source.getToken()), EDGE_TOKEN_UNAVAILABLE, []);
    expect(recorder.exchanges).toHaveLength(1);
  });

  it("frees an exchange orphaned by a cancelled originating request after a joiner's own 6 s wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      const { source, recorder } = await harness(orphanThenMint(called));
      void source.getToken();
      await called.promise;
      expect(timers.dropped()).toBe(true);

      const joined = source.getToken();
      const joinedOutcome = rejection(joined);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(await settledState(joined)).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expectCodeWithoutSecrets(await joinedOutcome, EDGE_TOKEN_UNAVAILABLE, []);

      // An orphan is not a provider failure: no negative cache, a fresh mint.
      await expect(source.getToken()).resolves.toMatch(TOKEN_SHAPE);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("replaces an orphaned exchange found 6 s or more after it started instead of joining it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      const { source, recorder, clock } = await harness(orphanThenMint(called));
      void source.getToken();
      await called.promise;
      expect(timers.dropped()).toBe(true);

      // Ten minutes later no fake timer is advanced: a caller that joined the
      // orphan would never settle here.
      clock.now = T0 + 600_000;
      await expect(withinRealTime(source.getToken(), 2_000)).resolves.toMatch(TOKEN_SHAPE);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("bounds a late joiner by the exchange's age, not by when it joined", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      const { source, recorder, clock } = await harness(orphanThenMint(called));
      void source.getToken();
      await called.promise;

      await vi.advanceTimersByTimeAsync(5_500);
      clock.now = T0 + 5_500;
      const joined = source.getToken();
      const joinedOutcome = rejection(joined);
      await vi.advanceTimersByTimeAsync(499);
      expect(await settledState(joined)).toBe("pending");
      clock.now = T0 + 6_000;
      await vi.advanceTimersByTimeAsync(1);
      // 0.5 s after joining, not 6 s: the orphan's own budget has run out.
      expect(await settledState(joined)).toBe("settled");
      expectCodeWithoutSecrets(await joinedOutcome, EDGE_TOKEN_UNAVAILABLE, []);

      clock.now = T0 + 6_020;
      await expect(withinRealTime(source.getToken(), 2_000)).resolves.toMatch(TOKEN_SHAPE);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("hands a joiner whose wait ends late the newer exchange that replaced its orphan", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      const secondCalled = deferred();
      const secondGate = deferred();
      const { source, recorder, clock } = await harness((audience, providerClock) => async (_, index) => {
        if (index === 0) {
          called.resolve();
          return new Promise<Response>(() => undefined);
        }
        secondCalled.resolve();
        await secondGate.promise;
        return tokenResponse(mintedToken(audience, () => providerClock.now));
      });
      void source.getToken();
      await called.promise;
      const joined = source.getToken();
      await vi.advanceTimersByTimeAsync(5_000);

      // The joiner's timer runs late against the clock: a new caller already
      // sees the orphan as 6 s old and replaces it.
      clock.now = T0 + 6_000;
      const replacing = source.getToken();
      await secondCalled.promise;
      expect(recorder.exchanges).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1_000);
      // The joiner's wait has ended; it is now waiting on the newer exchange.
      expect(await settledState(joined)).toBe("pending");
      secondGate.resolve();
      const [joinedToken, replacingToken] = await Promise.all([joined, replacing]);
      expect(joinedToken).toBe(replacingToken);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("caches a slow exchange that succeeds after a joiner freed its slot, when nothing newer started", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      let settleSlow!: (response: Response) => void;
      const { source, recorder, audience } = await harness(() => (_, index) => {
        if (index === 0) {
          called.resolve();
          return new Promise<Response>((resolve) => { settleSlow = resolve; });
        }
        return new Response(BODY_MARKER, { status: 500 });
      });
      const slow = source.getToken();
      await called.promise;
      const joinedOutcome = rejection(source.getToken());
      await vi.advanceTimersByTimeAsync(6_000);
      expectCodeWithoutSecrets(await joinedOutcome, EDGE_TOKEN_UNAVAILABLE, []);

      settleSlow(tokenResponse(mintedToken(audience, () => T0)));
      const token = await slow;
      await expect(source.getToken()).resolves.toBe(token);
      expect(recorder.exchanges).toHaveLength(1);
    } finally {
      timers.restore();
    }
  });

  it("does not let a replaced orphan's late success overwrite the newer token", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      let settleOrphan!: (response: Response) => void;
      const { source, recorder, clock, audience } = await harness((providerAudience, providerClock) => (_, index) => {
        if (index === 0) {
          called.resolve();
          return new Promise<Response>((resolve) => { settleOrphan = resolve; });
        }
        return tokenResponse(mintedToken(providerAudience, () => providerClock.now));
      });
      const orphan = source.getToken();
      await called.promise;

      clock.now = T0 + 6_000;
      const replacement = await source.getToken();
      settleOrphan(tokenResponse(mintedToken(audience, () => T0)));
      await expect(orphan).resolves.not.toBe(replacement);
      await expect(source.getToken()).resolves.toBe(replacement);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("ignores a replaced orphan that settles late: no clobbered token, no negative cache", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = dropOriginatorDeadline();
    try {
      const called = deferred();
      let settleOrphan!: (response: Response) => void;
      const { source, recorder, clock } = await harness((audience, providerClock) => (_, index) => {
        if (index === 0) {
          called.resolve();
          return new Promise<Response>((resolve) => { settleOrphan = resolve; });
        }
        return tokenResponse(mintedToken(audience, () => providerClock.now));
      });
      const orphanOutcome = rejection(source.getToken());
      await called.promise;

      clock.now = T0 + 6_000;
      const replacement = await source.getToken();
      expect(recorder.exchanges).toHaveLength(2);

      settleOrphan(new Response(BODY_MARKER, { status: 500 }));
      expectCodeWithoutSecrets(await orphanOutcome, EDGE_TOKEN_UNAVAILABLE, [BODY_MARKER]);
      await expect(source.getToken()).resolves.toBe(replacement);
      expect(recorder.exchanges).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });
});

describe("edge Google ID-token source: invoker key validation", () => {
  interface KeyCase {
    readonly name: string;
    readonly options: () => Record<string, unknown>;
  }

  function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      serviceAccountKeyJson: keyJson(primary),
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience: freshAudience(),
      fetcher: recordingFetcher(() => new Response(BODY_MARKER)).fetcher,
      clock: () => T0,
      ...overrides,
    };
  }

  function pkcs1Wrapped(pkcs8Pem: string): string {
    return pkcs8Pem.replace("BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY").replace("END PRIVATE KEY", "END RSA PRIVATE KEY");
  }

  const cases: readonly KeyCase[] = [
    { name: "a mismatched client_email", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { client_email: OTHER_SERVICE_ACCOUNT }) }) },
    { name: "a missing client_email", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { client_email: undefined }) }) },
    { name: "an expected account outside the dedicated-account shape", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { client_email: "123456789-compute@developer.gserviceaccount.com" }), expectedServiceAccount: "123456789-compute@developer.gserviceaccount.com" }) },
    { name: "a non-service_account type", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { type: "authorized_user" }) }) },
    { name: "a PKCS#1 PEM", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: pkcs1Wrapped(primary.privateKeyPem) }) }) },
    { name: "a PEM without its END line", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: primary.privateKeyPem.replace("-----END PRIVATE KEY-----\n", "") }) }) },
    { name: "a PEM with a corrupted body", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: primary.privateKeyPem.replace(/\n[A-Za-z0-9+/]{64}\n/u, "\n!!!!\n") }) }) },
    { name: "a PEM whose DER is truncated", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: primary.privateKeyPem.split("\n").filter((_, index, lines) => index < 4 || index >= lines.length - 2).join("\n") }) }) },
    { name: "an EC PKCS#8 key", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: ecPkcs8Pem }) }) },
    { name: "a 1024-bit RSA key", options: () => baseOptions({ serviceAccountKeyJson: keyJson(weak) }) },
    { name: "a non-string private_key", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key: [primary.privateKeyPem] }) }) },
    { name: "a 39-hex private_key_id", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key_id: primary.keyId.slice(1) }) }) },
    { name: "an uppercase private_key_id", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key_id: primary.keyId.toUpperCase().replace(/^[0-9]/u, "A") }) }) },
    { name: "a missing private_key_id", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary, { private_key_id: undefined }) }) },
    { name: "8193 bytes of key JSON", options: () => baseOptions({ serviceAccountKeyJson: paddedKeyJson(primary, MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES + 1) }) },
    { name: "multi-byte key JSON over 8 KiB in UTF-8 but not in UTF-16", options: () => baseOptions({ serviceAccountKeyJson: multiByteKeyJson(primary) }) },
    { name: "invalid JSON", options: () => baseOptions({ serviceAccountKeyJson: keyJson(primary).slice(0, -1) }) },
    { name: "a JSON array", options: () => baseOptions({ serviceAccountKeyJson: JSON.stringify([JSON.parse(keyJson(primary))]) }) },
    { name: "an empty key", options: () => baseOptions({ serviceAccountKeyJson: "" }) },
    { name: "a non-string key", options: () => baseOptions({ serviceAccountKeyJson: JSON.parse(keyJson(primary)) }) },
    { name: "an empty audience", options: () => baseOptions({ audience: "" }) },
    { name: "a 257-character audience", options: () => baseOptions({ audience: `https://${"a".repeat(249)}` }) },
    { name: "an audience with a control character", options: () => baseOptions({ audience: "https://origin.synthetic.test\n" }) },
    { name: "a non-function fetcher", options: () => baseOptions({ fetcher: "fetch" }) },
    { name: "a non-function clock", options: () => baseOptions({ clock: T0 }) },
  ];

  for (const keyCase of cases) {
    it(`refuses ${keyCase.name} with EDGE_INVOKER_KEY_INVALID and no key material`, async () => {
      const options = keyCase.options();
      const error = await rejection(createGoogleIdTokenSource(options as never));
      expectCodeWithoutSecrets(error, EDGE_INVOKER_KEY_INVALID, keySecrets(primary));
    });
  }

  // The EP-0 contract vectors for isEdgeServiceAccountEmail and
  // isEdgeOriginAudience (edge-origin-contract-vectors.ts). The source keeps
  // private copies of those shapes until EP-0 lands; these tables keep the
  // copies identical at every edge, so swapping in the imports changes nothing.
  const VALID_SERVICE_ACCOUNTS: readonly string[] = [
    SERVICE_ACCOUNT,
    "abcdef@ghijkl.iam.gserviceaccount.com",
    `a${"b".repeat(28)}c@d${"e".repeat(28)}f.iam.gserviceaccount.com`,
  ];
  const INVALID_SERVICE_ACCOUNTS: readonly (readonly [unknown, string])[] = [
    [undefined, "absent"],
    ["", "empty"],
    ["Edge-invoker@synthetic-edge-0.iam.gserviceaccount.com", "uppercase"],
    ["edge@synthetic-edge-0.iam.gserviceaccount.com", "a four-character local part"],
    ["abcde@synthetic-edge-0.iam.gserviceaccount.com", "a five-character local part"],
    [`a${"b".repeat(29)}c@synthetic-edge-0.iam.gserviceaccount.com`, "a 31-character local part"],
    ["edge-invoker-@synthetic-edge-0.iam.gserviceaccount.com", "a local part ending in a hyphen"],
    ["1edge-invoker@synthetic-edge-0.iam.gserviceaccount.com", "a local part starting with a digit"],
    ["edge-invoker@edge.iam.gserviceaccount.com", "a four-character project"],
    ["edge-invoker@abcde.iam.gserviceaccount.com", "a five-character project"],
    [`edge-invoker@a${"b".repeat(29)}c.iam.gserviceaccount.com`, "a 31-character project"],
    ["edge-invoker@synthetic-edge-0.iam.gserviceaccount.com.synthetic.example", "suffixed"],
    ["123456789012-compute@developer.gserviceaccount.com", "the default compute account"],
    ["edge-invoker@synthetic-edge-0.iam.gserviceaccount.co", "the wrong domain"],
    [`${SERVICE_ACCOUNT} `, "trailing-spaced"],
    [42, "a number"],
  ];
  const VALID_AUDIENCES: readonly string[] = ["a", "a".repeat(256), "edge origin"];
  const INVALID_AUDIENCES: readonly (readonly [unknown, string])[] = [
    [undefined, "absent"],
    ["", "empty"],
    [" ", "a lone space"],
    [" aud", "leading-spaced"],
    ["aud ", "trailing-spaced"],
    [" https://origin.synthetic.test", "a leading-spaced URL"],
    ["https://origin.synthetic.test ", "a trailing-spaced URL"],
    ["a".repeat(257), "257 characters"],
    ["a\u0000b", "holding NUL"],
    ["a\nb", "holding a line feed"],
    ["a\u007fb", "holding DEL"],
    ["\u00e9", "non-ASCII"],
    [42, "a number"],
  ];

  for (const [account, label] of INVALID_SERVICE_ACCOUNTS) {
    it(`refuses an expected account that is ${label}, even when the key names it`, async () => {
      const error = await rejection(createGoogleIdTokenSource(baseOptions({
        serviceAccountKeyJson: keyJson(primary, { client_email: account }),
        expectedServiceAccount: account,
      }) as never));
      expectCodeWithoutSecrets(error, EDGE_INVOKER_KEY_INVALID, keySecrets(primary));
    });
  }

  for (const [audience, label] of INVALID_AUDIENCES) {
    it(`refuses an audience that is ${label}`, async () => {
      const error = await rejection(createGoogleIdTokenSource(baseOptions({ audience }) as never));
      expectCodeWithoutSecrets(error, EDGE_INVOKER_KEY_INVALID, keySecrets(primary));
    });
  }

  it("accepts every account and audience shape the edge origin configuration accepts", async () => {
    for (const account of VALID_SERVICE_ACCOUNTS) {
      await expect(createGoogleIdTokenSource(baseOptions({
        serviceAccountKeyJson: keyJson(primary, { client_email: account }),
        expectedServiceAccount: account,
      }) as never)).resolves.toBeDefined();
    }
    for (const audience of VALID_AUDIENCES) {
      await expect(createGoogleIdTokenSource(baseOptions({ audience }) as never)).resolves.toBeDefined();
    }
  });

  it("accepts exactly 8 KiB of key JSON and makes no fetch while constructing", async () => {
    const json = paddedKeyJson(primary, MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES);
    expect(encoder.encode(json).byteLength).toBe(MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES);
    const recorder = recordingFetcher(() => new Response(BODY_MARKER));
    const source = await createGoogleIdTokenSource({
      serviceAccountKeyJson: json,
      expectedServiceAccount: SERVICE_ACCOUNT,
      audience: freshAudience(),
      fetcher: recorder.fetcher,
      clock: () => T0,
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.keys(source)).toEqual(["getToken"]);
    expect(recorder.exchanges).toHaveLength(0);
  });

  it("refuses a missing options object", async () => {
    expectCodeWithoutSecrets(
      await rejection(createGoogleIdTokenSource(null as never)),
      EDGE_INVOKER_KEY_INVALID,
      [],
    );
  });
});
