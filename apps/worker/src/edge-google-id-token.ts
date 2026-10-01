import { encodeBase64Url } from "./crypto";

/**
 * Google ID-token source for the thin edge.
 *
 * The Cloud Run origin is IAM-private: the edge authenticates as one dedicated
 * service account whose JSON key is the Worker secret EDGE_INVOKER_KEY_JSON,
 * and sends a Google-signed ID token (custom audience) in
 * X-Serverless-Authorization. This module turns that key into ID tokens with
 * the OAuth 2.0 JWT-bearer grant (RFC 7523) against Google's fixed token
 * endpoint, and nothing else:
 *
 * - The key is validated and imported once, non-extractable and sign-only.
 *   The parsed JSON is not retained; only the key id, the account and the
 *   CryptoKey survive construction.
 * - Minted tokens are cached per isolate, keyed by account and audience, and
 *   served while more than five minutes of validity remain (never past the
 *   token's own exp, never longer than one hour). Concurrent callers share one
 *   in-flight exchange; a joiner waits at most until six seconds after that
 *   exchange started, and an exchange older than that is treated as orphaned
 *   and replaced. A failed exchange makes every caller fail fast for ten
 *   seconds so an outage cannot amplify into a token-endpoint stampede.
 * - Every exchange is bounded: one fixed URL, a five-second deadline covering
 *   the headers and the body, and a 16 KiB streaming cap on the response.
 * - A token is accepted only when its payload names the configured audience,
 *   the expected account with email_verified true (the origin's own rule), and
 *   an integer exp still in the future.
 * - Every failure is the same content-free error. Messages never carry the
 *   provider body, the signed assertion, a token, or key material, and this
 *   module never writes to the console.
 * - The injected fetcher is always called as a plain function, never as a
 *   method: workerd's global fetch throws "Illegal invocation" when called
 *   with a foreign `this`, so passing `fetch` itself must keep working.
 *
 * Redirects are refused with `redirect: "manual"` plus the exact-200 check.
 * workerd rejects `redirect: "error"` outright ("won't be implemented since it
 * does not make sense at the edge"), so requesting it would make every
 * exchange fail; the spec pins both facts.
 */

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export const EDGE_INVOKER_KEY_INVALID = "EDGE_INVOKER_KEY_INVALID";
export const EDGE_TOKEN_UNAVAILABLE = "EDGE_TOKEN_UNAVAILABLE";

export const MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES = 8_192;
export const ID_TOKEN_REFRESH_MARGIN_MILLISECONDS = 300_000;
export const ID_TOKEN_NEGATIVE_CACHE_MILLISECONDS = 10_000;
export const TOKEN_EXCHANGE_TIMEOUT_MILLISECONDS = 5_000;
/**
 * The age at which an in-flight exchange is treated as orphaned. A live
 * exchange settles within its own 5 s deadline, so a joiner waits at most
 * until this long after the exchange started, and a caller that finds an
 * exchange at least this old replaces it instead of joining.
 */
export const IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS = TOKEN_EXCHANGE_TIMEOUT_MILLISECONDS + 1_000;
export const MAX_TOKEN_RESPONSE_BYTES = 16_384;
export const ASSERTION_LIFETIME_SECONDS = 3_600;
/** Google issues one-hour ID tokens; a longer claimed exp is not trusted for caching. */
export const MAX_ID_TOKEN_CACHE_MILLISECONDS = 3_600_000;
/** The origin bounds `Bearer <token>` at 8192 characters. */
export const MAX_ID_TOKEN_CHARACTERS = 8_192 - "Bearer ".length;

const MIN_RSA_MODULUS_BITS = 2_048;
const MAX_CACHED_IDENTITIES = 16;
// Verbatim copies of the EP-0 edge/origin contract's shapes for
// EDGE_INVOKER_SERVICE_ACCOUNT (isEdgeServiceAccountEmail) and
// EDGE_ORIGIN_AUDIENCE (isEdgeOriginAudience): a user-managed account with a
// 6-30 character account id and project id, and 1-256 printable ASCII
// characters without leading or trailing spaces. The spec pins both edges so
// swapping in the EP-0 imports stays behaviour-preserving.
const SERVICE_ACCOUNT_PATTERN =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;
const AUDIENCE_PATTERN = /^[!-~](?:[ -~]{0,254}[!-~])?$/u;
const PRIVATE_KEY_ID_PATTERN = /^[0-9a-f]{40}$/u;
const PKCS8_PEM_PATTERN =
  /^-----BEGIN PRIVATE KEY-----\r?\n((?:[A-Za-z0-9+/=]{1,76}\r?\n)+)-----END PRIVATE KEY-----(?:\r?\n)?$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const JOIN_WAIT_EXPIRED: unique symbol = Symbol("join-wait-expired");
const encoder = new TextEncoder();

export type EdgeGoogleIdTokenErrorCode =
  | typeof EDGE_INVOKER_KEY_INVALID
  | typeof EDGE_TOKEN_UNAVAILABLE;

/** A content-free failure: the message is the code and there is never a cause. */
export class EdgeGoogleIdTokenError extends Error {
  readonly code: EdgeGoogleIdTokenErrorCode;

  constructor(code: EdgeGoogleIdTokenErrorCode) {
    super(code);
    this.name = "EdgeGoogleIdTokenError";
    this.code = code;
  }
}

export type GoogleIdTokenFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface GoogleIdTokenSourceOptions {
  /** The service-account JSON key (the EDGE_INVOKER_KEY_JSON secret). */
  readonly serviceAccountKeyJson: string;
  /** The only account the key may belong to (EDGE_INVOKER_SERVICE_ACCOUNT). */
  readonly expectedServiceAccount: string;
  /** The Cloud Run custom audience (EDGE_ORIGIN_AUDIENCE). */
  readonly audience: string;
  readonly fetcher?: GoogleIdTokenFetcher;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
}

export interface GoogleIdTokenSource {
  /** Resolves to a raw ID token; rejects only with EDGE_TOKEN_UNAVAILABLE. */
  getToken(): Promise<string>;
}

interface InFlightExchange {
  readonly generation: number;
  readonly startedAtMilliseconds: number;
  readonly promise: Promise<string>;
}

interface IdentityTokenState {
  token: string | null;
  expiresAtMilliseconds: number;
  unavailableUntilMilliseconds: number;
  /** Increments per exchange, so a late-settling exchange can tell it was superseded. */
  generation: number;
  inFlight: InFlightExchange | null;
}

// Per-isolate cache. The token is minted for exactly one account and one
// audience, so that pair is the whole identity of a cache entry; a source
// rebuilt in the same isolate reuses it rather than minting again.
const isolateTokenStates = new Map<string, IdentityTokenState>();

function identityState(serviceAccount: string, audience: string): IdentityTokenState {
  const key = `${serviceAccount}\n${audience}`;
  const existing = isolateTokenStates.get(key);
  if (existing !== undefined) return existing;
  if (isolateTokenStates.size >= MAX_CACHED_IDENTITIES) {
    const oldest = isolateTokenStates.keys().next();
    if (oldest.done !== true) isolateTokenStates.delete(oldest.value);
  }
  const created: IdentityTokenState = {
    token: null,
    expiresAtMilliseconds: 0,
    unavailableUntilMilliseconds: 0,
    generation: 0,
    inFlight: null,
  };
  isolateTokenStates.set(key, created);
  return created;
}

function keyInvalid(): EdgeGoogleIdTokenError {
  return new EdgeGoogleIdTokenError(EDGE_INVOKER_KEY_INVALID);
}

function tokenUnavailable(): EdgeGoogleIdTokenError {
  return new EdgeGoogleIdTokenError(EDGE_TOKEN_UNAVAILABLE);
}

function defaultFetcher(input: string, init: RequestInit): Promise<Response> {
  // Read at call time and called as a plain function: workerd refuses fetch
  // with a foreign `this`.
  return fetch(input, init);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) return null;
  try {
    return binaryToBytes(atob(value));
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array | null {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = standard.length % 4;
  if (remainder === 1) return null;
  return decodeBase64(remainder === 0 ? standard : standard.padEnd(standard.length + 4 - remainder, "="));
}

function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  return plainObject(parsed) ? parsed : null;
}

function encodeJsonSegment(value: Record<string, unknown>): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

interface ParsedServiceAccountKey {
  readonly keyId: string;
  readonly signingKey: CryptoKey;
}

async function importServiceAccountKey(
  serviceAccountKeyJson: unknown,
  expectedServiceAccount: string,
): Promise<ParsedServiceAccountKey> {
  // UTF-16 length bounds UTF-8 length from below, so this rejects oversize
  // input before encoding it.
  if (typeof serviceAccountKeyJson !== "string"
      || serviceAccountKeyJson.length === 0
      || serviceAccountKeyJson.length > MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES
      || encoder.encode(serviceAccountKeyJson).byteLength > MAX_SERVICE_ACCOUNT_KEY_JSON_BYTES) {
    throw keyInvalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountKeyJson);
  } catch {
    throw keyInvalid();
  }
  if (!plainObject(parsed)) throw keyInvalid();
  const type = parsed["type"];
  const clientEmail = parsed["client_email"];
  const keyId = parsed["private_key_id"];
  const privateKey = parsed["private_key"];
  if (type !== "service_account"
      || clientEmail !== expectedServiceAccount
      || typeof keyId !== "string"
      || !PRIVATE_KEY_ID_PATTERN.test(keyId)
      || typeof privateKey !== "string") {
    throw keyInvalid();
  }
  const pem = PKCS8_PEM_PATTERN.exec(privateKey);
  const der = pem?.[1] === undefined ? null : decodeBase64(pem[1].replace(/\r?\n/gu, ""));
  if (der === null) throw keyInvalid();
  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw keyInvalid();
  }
  const modulusLength: unknown = Reflect.get(signingKey.algorithm, "modulusLength");
  if (signingKey.type !== "private"
      || signingKey.extractable
      || signingKey.usages.length !== 1
      || signingKey.usages[0] !== "sign"
      || signingKey.algorithm.name !== "RSASSA-PKCS1-v1_5"
      || typeof modulusLength !== "number"
      || modulusLength < MIN_RSA_MODULUS_BITS) {
    throw keyInvalid();
  }
  return { keyId, signingKey };
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  clear(): void;
}

function startDeadline(milliseconds: number): Deadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(tokenUnavailable());
    }, milliseconds);
  });
  // Only racers observe expiry; an unraced deadline must not surface as an
  // unhandled rejection.
  expired.catch(() => undefined);
  return {
    signal: controller.signal,
    expired,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function discardBody(response: Response): void {
  try {
    // Never await an untrusted stream's cancellation.
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A locked or already-consumed body has nothing left to release.
  }
}

async function readCappedBody(response: Response, deadline: Deadline): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/u.test(declared)
      && Number(declared) > MAX_TOKEN_RESPONSE_BYTES) {
    discardBody(response);
    throw tokenUnavailable();
  }
  if (response.body === null) throw tokenUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), deadline.expired]);
      if (step.done) {
        completed = true;
        break;
      }
      if (!(step.value instanceof Uint8Array)) throw tokenUnavailable();
      total += step.value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) throw tokenUnavailable();
      chunks.push(step.value);
    }
  } catch {
    throw tokenUnavailable();
  } finally {
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The failure below is the outcome; cancellation is best effort.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader can already have released its lock.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface MintedIdToken {
  readonly token: string;
  readonly expiresAtMilliseconds: number;
}

interface MintContext {
  readonly keyId: string;
  readonly signingKey: CryptoKey;
  readonly serviceAccount: string;
  readonly audience: string;
  readonly fetcher: GoogleIdTokenFetcher;
}

async function signAssertion(context: MintContext, nowMilliseconds: number): Promise<string> {
  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const signingInput = `${encodeJsonSegment({
    alg: "RS256",
    typ: "JWT",
    kid: context.keyId,
  })}.${encodeJsonSegment({
    iss: context.serviceAccount,
    sub: context.serviceAccount,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    target_audience: context.audience,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    context.signingKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function acceptedIdToken(
  body: Uint8Array,
  context: MintContext,
  nowMilliseconds: number,
): MintedIdToken {
  const parsed = decodeJsonObject(body);
  const token = parsed?.["id_token"];
  if (typeof token !== "string"
      || token.length > MAX_ID_TOKEN_CHARACTERS
      || !JWT_PATTERN.test(token)) {
    throw tokenUnavailable();
  }
  const payloadSegment = token.split(".")[1];
  const payloadBytes = payloadSegment === undefined ? null : decodeBase64Url(payloadSegment);
  const payload = payloadBytes === null ? null : decodeJsonObject(payloadBytes);
  const expiresAtSeconds = payload?.["exp"];
  // The origin requires aud, email and email_verified true; a token it would
  // always refuse must fail here (and start the negative cache) rather than
  // be cached as good.
  if (payload === null
      || payload["aud"] !== context.audience
      || payload["email"] !== context.serviceAccount
      || payload["email_verified"] !== true
      || typeof expiresAtSeconds !== "number"
      || !Number.isSafeInteger(expiresAtSeconds)
      || expiresAtSeconds * 1_000 <= nowMilliseconds) {
    throw tokenUnavailable();
  }
  return {
    token,
    expiresAtMilliseconds: Math.min(
      expiresAtSeconds * 1_000,
      nowMilliseconds + MAX_ID_TOKEN_CACHE_MILLISECONDS,
    ),
  };
}

async function mintIdToken(context: MintContext, nowMilliseconds: number): Promise<MintedIdToken> {
  const assertion = await signAssertion(context, nowMilliseconds);
  const body = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion,
  }).toString();
  const deadline = startDeadline(TOKEN_EXCHANGE_TIMEOUT_MILLISECONDS);
  // Never `context.fetcher(...)`: that passes the context as `this`, and
  // workerd's global fetch rejects any foreign receiver with "Illegal
  // invocation", so an injected `fetch` would fail every exchange.
  const { fetcher } = context;
  try {
    let pending: Promise<Response>;
    try {
      pending = Promise.resolve(fetcher(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
        cache: "no-store",
        signal: deadline.signal,
      }));
    } catch {
      throw tokenUnavailable();
    }
    let response: Response;
    try {
      response = await Promise.race([pending, deadline.expired]);
    } catch {
      // A fetcher that settles after the deadline must neither surface an
      // unhandled rejection nor leave a response body open.
      pending.then(
        (late) => {
          if (late instanceof Response) discardBody(late);
        },
        () => undefined,
      );
      throw tokenUnavailable();
    }
    if (!(response instanceof Response)) throw tokenUnavailable();
    if (response.status !== 200 || response.redirected) {
      discardBody(response);
      throw tokenUnavailable();
    }
    const responseBody = await readCappedBody(response, deadline);
    return acceptedIdToken(responseBody, context, nowMilliseconds);
  } finally {
    deadline.clear();
  }
}

/**
 * Validate and import the invoker key and return a cached, single-flight ID
 * token source. Any construction defect rejects with EDGE_INVOKER_KEY_INVALID;
 * `getToken()` rejects only with EDGE_TOKEN_UNAVAILABLE.
 */
export async function createGoogleIdTokenSource(
  options: GoogleIdTokenSourceOptions,
): Promise<GoogleIdTokenSource> {
  if (!plainObject(options)) throw keyInvalid();
  const { expectedServiceAccount, audience } = options;
  const fetcher = options.fetcher ?? defaultFetcher;
  const clock = options.clock ?? Date.now;
  if (typeof expectedServiceAccount !== "string"
      || !SERVICE_ACCOUNT_PATTERN.test(expectedServiceAccount)
      || typeof audience !== "string"
      || !AUDIENCE_PATTERN.test(audience)
      || typeof fetcher !== "function"
      || typeof clock !== "function") {
    throw keyInvalid();
  }
  const { keyId, signingKey } = await importServiceAccountKey(
    options.serviceAccountKeyJson,
    expectedServiceAccount,
  );
  const context: MintContext = {
    keyId,
    signingKey,
    serviceAccount: expectedServiceAccount,
    audience,
    fetcher,
  };
  const state = identityState(expectedServiceAccount, audience);

  function now(): number {
    let value: unknown;
    try {
      value = clock();
    } catch {
      // A throwing clock must not let its own error escape getToken().
      throw tokenUnavailable();
    }
    if (typeof value !== "number" || !Number.isFinite(value)) throw tokenUnavailable();
    return value;
  }

  function cachedToken(current: number): string | null {
    return state.token !== null
      && state.expiresAtMilliseconds - current > ID_TOKEN_REFRESH_MARGIN_MILLISECONDS
      ? state.token
      : null;
  }

  // The in-flight exchange a caller may join, or null. An exchange at least
  // IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS old has outlived its own deadline, so
  // the request that started it was cancelled together with its timers: the
  // slot is freed and the caller mints afresh instead of waiting on it.
  function joinableInFlight(current: number): InFlightExchange | null {
    const exchange = state.inFlight;
    if (exchange === null) return null;
    if (current - exchange.startedAtMilliseconds < IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS) {
      return exchange;
    }
    state.inFlight = null;
    return null;
  }

  async function refresh(generation: number, startedAt: number): Promise<string> {
    // An exchange that settles late must not undo newer state. A success is
    // cached unless a later exchange has started (a slow exchange whose slot a
    // joiner freed is still the newest evidence); a failure clears the token
    // and starts the negative cache only while this exchange holds the slot,
    // so an abandoned or replaced orphan never does.
    try {
      const minted = await mintIdToken(context, startedAt);
      if (state.generation === generation) {
        state.token = minted.token;
        state.expiresAtMilliseconds = minted.expiresAtMilliseconds;
        state.unavailableUntilMilliseconds = 0;
      }
      return minted.token;
    } catch {
      if (state.inFlight?.generation === generation) {
        state.token = null;
        state.expiresAtMilliseconds = 0;
        let failedAt = startedAt;
        try {
          failedAt = now();
        } catch {
          // Keep the start time when the clock itself is unusable.
        }
        state.unavailableUntilMilliseconds = failedAt + ID_TOKEN_NEGATIVE_CACHE_MILLISECONDS;
      }
      throw tokenUnavailable();
    }
  }

  function startExchange(current: number): Promise<string> {
    state.generation += 1;
    const generation = state.generation;
    // refresh() reaches its first await before it reads the generation or the
    // slot, so both below are set by the time it checks them.
    const promise = refresh(generation, current);
    const exchange: InFlightExchange = { generation, startedAtMilliseconds: current, promise };
    state.inFlight = exchange;
    // Clear the single-flight slot once settled; this branch handles the
    // rejection so it never becomes an unhandled one.
    const release = (): void => {
      if (state.inFlight === exchange) state.inFlight = null;
    };
    promise.then(release, release);
    return promise;
  }

  // A joining caller is usually a different request on this isolate. If the
  // request that started the exchange is cancelled, its fetch and deadline
  // timer can be torn down with it and the shared promise may never settle.
  // A joiner therefore waits only until the exchange is
  // IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS old, however late it joined. When
  // that wait ends it uses a token or a newer exchange that appeared in the
  // meantime (rejoining at most once); otherwise it frees the orphaned slot and
  // fails. An orphan is not a provider failure, so it never starts the negative
  // cache.
  async function joinInFlight(
    exchange: InFlightExchange,
    joinedAt: number,
    mayRejoin: boolean,
  ): Promise<string> {
    const remaining = Math.min(
      IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS,
      exchange.startedAtMilliseconds + IN_FLIGHT_JOIN_TIMEOUT_MILLISECONDS - joinedAt,
    );
    const wait = startDeadline(remaining);
    let outcome: string | typeof JOIN_WAIT_EXPIRED;
    try {
      outcome = await Promise.race([
        exchange.promise,
        wait.expired.catch((): typeof JOIN_WAIT_EXPIRED => JOIN_WAIT_EXPIRED),
      ]);
    } catch {
      throw tokenUnavailable();
    } finally {
      wait.clear();
    }
    if (outcome !== JOIN_WAIT_EXPIRED) return outcome;
    const current = now();
    const token = cachedToken(current);
    if (token !== null) return token;
    if (state.inFlight === exchange) {
      state.inFlight = null;
      throw tokenUnavailable();
    }
    const newer = mayRejoin ? joinableInFlight(current) : null;
    if (newer === null) throw tokenUnavailable();
    return joinInFlight(newer, current, false);
  }

  async function getToken(): Promise<string> {
    const current = now();
    const token = cachedToken(current);
    if (token !== null) return token;
    const inFlight = joinableInFlight(current);
    if (inFlight !== null) return joinInFlight(inFlight, current, true);
    if (current < state.unavailableUntilMilliseconds) throw tokenUnavailable();
    return startExchange(current);
  }

  return Object.freeze({ getToken });
}
