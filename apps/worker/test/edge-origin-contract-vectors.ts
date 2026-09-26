/**
 * Shared vectors for the edge/origin transport contract. The Workers vitest
 * spec (workerd) and the Cloud Run Node check both run every check below
 * against their own load of src/edge-origin-contract.ts, so the contract is
 * proven identical in both runtimes. This module has no runtime imports: the
 * contract and the assertion adapter are injected. All values are synthetic.
 */
import type * as EdgeOriginContract from "../src/edge-origin-contract";

export type EdgeOriginContractModule = typeof EdgeOriginContract;

export interface ContractAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
}

export interface EdgeOriginContractCheck {
  readonly name: string;
  run(contract: EdgeOriginContractModule, assert: ContractAssert): void;
}

// ---------------------------------------------------------------------------
// Expected contract surface

const EXPECTED_EXPORT_NAMES = Object.freeze([
  "ADMIN_ONLY_FORWARDED_REQUEST_HEADERS",
  "DROPPED_RESPONSE_HEADERS",
  "EDGE_ADMISSION_OUTCOMES",
  "EDGE_ADMISSION_PURPOSES",
  "EDGE_CONTRACT_REQUEST_HEADERS",
  "EDGE_FENCE_RETRY_AFTER_SECONDS",
  "EDGE_HEADERS",
  "EDGE_HOST_KINDS",
  "EDGE_INVOKER_CLOCK_SKEW_SECONDS",
  "EDGE_LOCAL_ONLY_REQUEST_HEADERS",
  "EDGE_MAX_FORWARD_BODY_BYTES",
  "EDGE_MAX_OVERVIEW_MERGE_BYTES",
  "EDGE_MIN_CLIENT_KEY_SECRET_LENGTH",
  "EDGE_NOT_CONFIGURED",
  "EDGE_ORIGIN_UNAVAILABLE",
  "EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS",
  "EDGE_UPSTREAM_MODES",
  "FORWARDED_REQUEST_HEADERS",
  "GOOGLE_CALLBACK_PATH",
  "MAX_GOOGLE_CALLBACK_URL_LENGTH",
  "ORIGIN_BOUNDARY_ERROR_BODY",
  "decodeEdgeAdmission",
  "encodeEdgeAdmission",
  "isEdgeRequestId",
  "parseCloudRunInvokerClaims",
  "parseEdgeOriginConfiguration",
  "parseEdgeUpstreamMode",
  "validGoogleCallbackQuery",
]);

const EXPECTED_HEADERS = Object.freeze({
  host: "x-tibotattle-edge-host",
  admission: "x-tibotattle-edge-admission",
  requestId: "x-tibotattle-edge-request-id",
  callbackQuery: "x-tibotattle-google-callback-query",
  invokerToken: "x-serverless-authorization",
  originMarker: "x-tibotattle-origin",
});

const EXPECTED_FORWARDED_REQUEST_HEADERS = Object.freeze([
  "content-type",
  "content-length",
  "authorization",
  "cookie",
  "origin",
  "sec-fetch-site",
  "x-usage-monitor-csrf",
  "x-usage-monitor-admin",
  "x-previous-device-authorization",
]);

const EXPECTED_EDGE_LOCAL_ONLY_REQUEST_HEADERS = Object.freeze([
  "x-usage-monitor-release-timestamp",
  "x-usage-monitor-release-nonce",
  "x-usage-monitor-release-signature",
  "cf-connecting-ip",
]);

const EXPECTED_DROPPED_RESPONSE_HEADERS = Object.freeze([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "server",
  "via",
  "alt-svc",
  "x-cloud-trace-context",
  "traceparent",
  "x-tibotattle-origin",
]);

const EXPECTED_ADMISSION_PURPOSES = Object.freeze([
  "enrollment",
  "sign_in_start",
  "recovery",
  "device_disconnect",
  "device_credential_renew",
  "device_sync",
  "accountless_ownership",
  "accountless_renewal",
  "public_aggregate_read",
  "upload_ingress",
]);

const EXPECTED_ADMISSION_OUTCOMES = Object.freeze(["allowed", "limited", "unavailable"]);

// ---------------------------------------------------------------------------
// Modes, request ids and admission

const MODE_CASES: readonly { readonly value: unknown; readonly expected: string | null }[] = [
  { value: "worker", expected: "worker" },
  { value: "fenced", expected: "fenced" },
  { value: "gcp", expected: "gcp" },
  { value: undefined, expected: null },
  { value: null, expected: null },
  { value: "", expected: null },
  { value: "GCP", expected: null },
  { value: "Worker", expected: null },
  { value: " gcp", expected: null },
  { value: "gcp ", expected: null },
  { value: "fence", expected: null },
  { value: "worker,gcp", expected: null },
  { value: 1, expected: null },
  { value: ["gcp"], expected: null },
];

const REQUEST_ID_CASES: readonly { readonly value: unknown; readonly valid: boolean }[] = [
  { value: "0f8fad5b-d9cb-469f-a165-70867728950e", valid: true },
  { value: "00000000-0000-4000-8000-000000000000", valid: true },
  { value: "ffffffff-ffff-4fff-bfff-ffffffffffff", valid: true },
  { value: "0F8FAD5B-D9CB-469F-A165-70867728950E", valid: false },
  { value: "0f8fad5b-d9cb-169f-a165-70867728950e", valid: false },
  { value: "0f8fad5b-d9cb-469f-c165-70867728950e", valid: false },
  { value: "0f8fad5bd9cb469fa16570867728950e", valid: false },
  { value: "{0f8fad5b-d9cb-469f-a165-70867728950e}", valid: false },
  { value: " 0f8fad5b-d9cb-469f-a165-70867728950e", valid: false },
  { value: "0f8fad5b-d9cb-469f-a165-70867728950e\n", valid: false },
  { value: "0f8fad5b-d9cb-469f-a165-70867728950", valid: false },
  { value: "", valid: false },
  { value: undefined, valid: false },
  { value: 42, valid: false },
];

const MALFORMED_ADMISSION_VALUES: readonly unknown[] = [
  "v1;upload_authorization;allowed",
  "v2;enrollment;allowed",
  "V1;enrollment;allowed",
  "v1;enrollment",
  "v1;enrollment;allowed;extra",
  "v1;enrollment;allowed;",
  " v1;enrollment;allowed",
  "v1;enrollment;allowed ",
  "v1; enrollment;allowed",
  "v1;enrollment;\tallowed",
  "v1;ENROLLMENT;allowed",
  "v1;enrollment;Allowed",
  "v1;enrollment;denied",
  "v1;;allowed",
  "v1;enrollment;",
  ";;",
  "",
  "v1,enrollment,allowed",
  `v1;${"a".repeat(90)};allowed`,
  `v1;enrollment;allowed${" ".repeat(76)}`,
  "v1;enrollment;allowed".padEnd(10_000, ";"),
  undefined,
  null,
  1,
  {},
  ["v1", "enrollment", "allowed"],
];

const MALFORMED_ADMISSION_INPUTS: readonly unknown[] = [
  { purpose: "upload_authorization", outcome: "allowed" },
  { purpose: "enrollment", outcome: "denied" },
  { purpose: "enrollment;x", outcome: "allowed" },
  { purpose: "enrollment" },
  {},
  null,
  undefined,
  "v1;enrollment;allowed",
];

// ---------------------------------------------------------------------------
// Google callback query (also compared with cloud-run/request-boundary.mjs)

export interface CallbackQueryCase {
  readonly label: string;
  readonly query: unknown;
  readonly valid: boolean;
}

export const GOOGLE_CALLBACK_QUERY_CASES: readonly CallbackQueryCase[] = Object.freeze([
  { label: "bare question mark", query: "?", valid: true },
  { label: "code and state", query: "?code=synthetic-code&state=synthetic-state", valid: true },
  { label: "percent-encoded values", query: "?code=4%2Fsynthetic&scope=email%20openid", valid: true },
  { label: "provider error", query: "?error=access_denied&state=synthetic-state", valid: true },
  { label: "double question mark", query: "??a=b", valid: true },
  { label: "bare percent", query: "?%zz", valid: true },
  { label: "8192 characters", query: `?${"a".repeat(8_191)}`, valid: true },
  { label: "8192 UTF-16 units of astral text", query: `?${"\u{1F600}".repeat(4_095)}a`, valid: true },
  { label: "non-ASCII letter", query: "?a=\u00e9", valid: true },
  { label: "C1 control", query: "?a=\u0080", valid: true },
  { label: "no-break space", query: "?a=\u00a0", valid: true },
  { label: "lone surrogate", query: "?a=\ud800", valid: true },
  { label: "8193 characters", query: `?${"a".repeat(8_192)}`, valid: false },
  { label: "8193 UTF-16 units of astral text", query: `?${"\u{1F600}".repeat(4_096)}`, valid: false },
  { label: "backslash", query: "?a=b\\c", valid: false },
  { label: "trailing backslash", query: "?a=b\\", valid: false },
  { label: "fragment marker", query: "?a=b#fragment", valid: false },
  { label: "leading fragment marker", query: "#?a=b", valid: false },
  { label: "space", query: "?a=b c", valid: false },
  { label: "leading space", query: " ?a=b", valid: false },
  { label: "NUL", query: "?a=\u0000", valid: false },
  { label: "unit separator control", query: "?a=\u001f", valid: false },
  { label: "tab", query: "?a=\t", valid: false },
  { label: "line feed", query: "?a=b\n", valid: false },
  { label: "carriage return", query: "?a=b\r", valid: false },
  { label: "delete", query: "?a=\u007f", valid: false },
  { label: "missing question mark", query: "code=synthetic-code", valid: false },
  { label: "question mark not first", query: "a?b", valid: false },
  { label: "empty string", query: "", valid: false },
  { label: "null", query: null, valid: false },
  { label: "number", query: 42, valid: false },
  { label: "array", query: ["?a=b"], valid: false },
  { label: "object", query: { toString: () => "?a=b" }, valid: false },
]);

// ---------------------------------------------------------------------------
// Cloud Run invoker claims

export const INVOKER_NOW_SECONDS = 1_800_000_000;
export const INVOKER_SERVICE_ACCOUNT = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
export const INVOKER_AUDIENCE = "https://origin.synthetic.example/edge";
const SIGNATURE_REMOVED = "SIGNATURE_REMOVED_BY_GOOGLE";
const INVOKER_HEADER = Object.freeze({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" });
const INVOKER_PAYLOAD = Object.freeze({
  aud: INVOKER_AUDIENCE,
  azp: "100000000000000000000",
  email: INVOKER_SERVICE_ACCOUNT,
  email_verified: true,
  exp: INVOKER_NOW_SECONDS + 3_000,
  iat: INVOKER_NOW_SECONDS - 600,
  iss: "https://accounts.google.com",
  sub: "100000000000000000000",
});

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlText(text: string): string {
  return base64UrlBytes(new TextEncoder().encode(text));
}

function base64UrlJson(value: unknown): string {
  return base64UrlText(JSON.stringify(value));
}

interface TokenParts {
  readonly header?: unknown;
  readonly payload?: unknown;
  readonly headerSegment?: string;
  readonly payloadSegment?: string;
  readonly signature?: string;
}

/** Synthetic delivered token: base64url header and payload, removed signature. */
export function invokerToken(parts: TokenParts = {}): string {
  const header = parts.headerSegment ?? base64UrlJson(parts.header ?? INVOKER_HEADER);
  const payload = parts.payloadSegment ?? base64UrlJson(parts.payload ?? INVOKER_PAYLOAD);
  return `Bearer ${header}.${payload}.${parts.signature ?? SIGNATURE_REMOVED}`;
}

function withPayload(overrides: Record<string, unknown>, omit: readonly string[] = []): string {
  const payload: Record<string, unknown> = { ...INVOKER_PAYLOAD, ...overrides };
  for (const key of omit) delete payload[key];
  return invokerToken({ payload });
}

/** A valid token padded with an unrelated claim to exactly `length` characters. */
function invokerTokenOfLength(length: number): string {
  for (let kidPadding = 0; kidPadding < 4; kidPadding += 1) {
    const header = { ...INVOKER_HEADER, kid: "0".repeat(40 + kidPadding) };
    const base = invokerToken({ header, payload: { ...INVOKER_PAYLOAD, pad: "" } }).length;
    const start = Math.max(0, Math.floor(((length - base) * 3) / 4) - 8);
    for (let padding = start; padding < start + 24; padding += 1) {
      const token = invokerToken({ header, payload: { ...INVOKER_PAYLOAD, pad: "x".repeat(padding) } });
      if (token.length === length) return token;
      if (token.length > length) break;
    }
  }
  throw new Error("SYNTHETIC_TOKEN_LENGTH_UNREACHABLE");
}

const EXPECTED_CLAIMS = Object.freeze({
  email: INVOKER_SERVICE_ACCOUNT,
  emailVerified: true,
  audiences: [INVOKER_AUDIENCE],
  expiresAt: INVOKER_NOW_SECONDS + 3_000,
});

interface ValidClaimsCase {
  readonly label: string;
  readonly value: string;
  readonly now?: number;
  readonly expected: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly audiences: readonly string[];
    readonly expiresAt: number;
  };
}

function validClaimsCases(): readonly ValidClaimsCase[] {
  const token = invokerToken();
  return [
    { label: "delivered token", value: token, expected: EXPECTED_CLAIMS },
    {
      label: "fractional clock reading",
      value: token,
      now: INVOKER_NOW_SECONDS + 0.5,
      expected: EXPECTED_CLAIMS,
    },
    {
      label: "email_verified false",
      value: withPayload({ email_verified: false }),
      expected: { ...EXPECTED_CLAIMS, emailVerified: false },
    },
    {
      label: "email_verified absent",
      value: withPayload({}, ["email_verified"]),
      expected: { ...EXPECTED_CLAIMS, emailVerified: false },
    },
    {
      label: "audience list",
      value: withPayload({ aud: [INVOKER_AUDIENCE, "https://edge-origin-abc123-uc.a.run.app"] }),
      expected: { ...EXPECTED_CLAIMS, audiences: [INVOKER_AUDIENCE, "https://edge-origin-abc123-uc.a.run.app"] },
    },
    {
      label: "expiry inside the clock skew",
      value: withPayload({ exp: INVOKER_NOW_SECONDS - 59, iat: INVOKER_NOW_SECONDS - 3_659 }),
      expected: { ...EXPECTED_CLAIMS, expiresAt: INVOKER_NOW_SECONDS - 59 },
    },
    {
      label: "issue time at the clock skew",
      value: withPayload({ exp: INVOKER_NOW_SECONDS + 3_660, iat: INVOKER_NOW_SECONDS + 60 }),
      expected: { ...EXPECTED_CLAIMS, expiresAt: INVOKER_NOW_SECONDS + 3_660 },
    },
    {
      label: "UTF-8 in an unrelated claim",
      value: withPayload({ name: "synth\u00e9tique \u{1F600}" }),
      expected: EXPECTED_CLAIMS,
    },
    {
      label: "other base64url signature shape",
      value: invokerToken({ signature: "c3ludGhldGlj-_0" }),
      expected: EXPECTED_CLAIMS,
    },
    { label: "exactly 8192 characters", value: invokerTokenOfLength(8_192), expected: EXPECTED_CLAIMS },
  ];
}

interface InvalidClaimsCase {
  readonly label: string;
  readonly value: unknown;
  /** Replaces the default clock reading when present, including undefined. */
  readonly clock?: unknown;
}

function invalidClaimsCases(): readonly InvalidClaimsCase[] {
  const token = invokerToken();
  const segments = token.slice("Bearer ".length);
  const [header = "", payload = ""] = segments.split(".");
  const cases: InvalidClaimsCase[] = [
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "number", value: 42 },
    { label: "object", value: {} },
    { label: "array", value: [token] },
    { label: "empty", value: "" },
    { label: "prefix only", value: "Bearer " },
    { label: "missing scheme", value: segments },
    { label: "lowercase scheme", value: `bearer ${segments}` },
    { label: "double space", value: `Bearer  ${segments}` },
    { label: "leading space", value: ` ${token}` },
    { label: "Basic scheme", value: `Basic ${segments}` },
    { label: "trailing space", value: `${token} ` },
    { label: "trailing line feed", value: `${token}\n` },
    { label: "two segments", value: `Bearer ${header}.${payload}` },
    { label: "four segments", value: `${token}.${SIGNATURE_REMOVED}` },
    { label: "empty header segment", value: invokerToken({ headerSegment: "" }) },
    { label: "empty payload segment", value: invokerToken({ payloadSegment: "" }) },
    { label: "empty signature segment", value: invokerToken({ signature: "" }) },
    { label: "padded payload segment", value: invokerToken({ payloadSegment: `${payload}==` }) },
    { label: "standard base64 character", value: invokerToken({ headerSegment: `${header}+` }) },
    { label: "slash in signature", value: invokerToken({ signature: "SIGNATURE/REMOVED" }) },
    { label: "impossible base64 length", value: invokerToken({ headerSegment: "eyJhb" }) },
    { label: "header not JSON", value: invokerToken({ headerSegment: base64UrlText("not json") }) },
    { label: "header JSON array", value: invokerToken({ header: [INVOKER_HEADER] }) },
    { label: "header JSON null", value: invokerToken({ headerSegment: base64UrlText("null") }) },
    { label: "payload not JSON", value: invokerToken({ payloadSegment: base64UrlText("{email:") }) },
    { label: "payload JSON array", value: invokerToken({ payload: [INVOKER_PAYLOAD] }) },
    { label: "payload JSON string", value: invokerToken({ payload: "synthetic" }) },
    { label: "payload JSON number", value: invokerToken({ payload: 7 }) },
    {
      label: "payload invalid UTF-8",
      value: invokerToken({ payloadSegment: base64UrlBytes(Uint8Array.of(0x7b, 0xff, 0x7d)) }),
    },
    { label: "email missing", value: withPayload({}, ["email"]) },
    { label: "email number", value: withPayload({ email: 7 }) },
    { label: "email empty", value: withPayload({ email: "" }) },
    { label: "email with space", value: withPayload({ email: "edge invoker@synthetic.example" }) },
    { label: "email without at", value: withPayload({ email: "edge-invoker.synthetic.example" }) },
    { label: "email with two at signs", value: withPayload({ email: "edge@invoker@synthetic.example" }) },
    { label: "email too long", value: withPayload({ email: `${"a".repeat(64)}@${"b".repeat(190)}` }) },
    { label: "email_verified string", value: withPayload({ email_verified: "true" }) },
    { label: "email_verified number", value: withPayload({ email_verified: 1 }) },
    { label: "audience missing", value: withPayload({}, ["aud"]) },
    { label: "audience empty", value: withPayload({ aud: "" }) },
    { label: "audience list empty", value: withPayload({ aud: [] }) },
    { label: "audience list non-string", value: withPayload({ aud: [INVOKER_AUDIENCE, 7] }) },
    {
      label: "audience list too long",
      value: withPayload({ aud: Array.from({ length: 17 }, (_, index) => `aud-${index}`) }),
    },
    { label: "audience 257 characters", value: withPayload({ aud: "a".repeat(257) }) },
    { label: "audience control character", value: withPayload({ aud: "aud\u0001" }) },
    { label: "audience leading space", value: withPayload({ aud: ` ${INVOKER_AUDIENCE}` }) },
    { label: "audience object", value: withPayload({ aud: { value: INVOKER_AUDIENCE } }) },
    { label: "expiry missing", value: withPayload({}, ["exp"]) },
    { label: "expiry string", value: withPayload({ exp: String(INVOKER_NOW_SECONDS + 3_000) }) },
    { label: "expiry fractional", value: withPayload({ exp: INVOKER_NOW_SECONDS + 3_000.5 }) },
    { label: "expiry negative", value: withPayload({ exp: -1 }) },
    { label: "expiry not after issue", value: withPayload({ exp: INVOKER_NOW_SECONDS, iat: INVOKER_NOW_SECONDS }) },
    { label: "issue time missing", value: withPayload({}, ["iat"]) },
    { label: "issue time string", value: withPayload({ iat: String(INVOKER_NOW_SECONDS) }) },
    {
      label: "issued beyond the clock skew",
      value: withPayload({ iat: INVOKER_NOW_SECONDS + 61, exp: INVOKER_NOW_SECONDS + 3_661 }),
    },
    {
      label: "expired beyond the clock skew",
      value: withPayload({ exp: INVOKER_NOW_SECONDS - 60, iat: INVOKER_NOW_SECONDS - 3_660 }),
    },
    { label: "clock NaN", value: token, clock: Number.NaN },
    { label: "clock negative", value: token, clock: -1 },
    { label: "clock infinite", value: token, clock: Number.POSITIVE_INFINITY },
    { label: "clock string", value: token, clock: String(INVOKER_NOW_SECONDS) },
    { label: "clock missing", value: token, clock: undefined },
    { label: "8193 characters", value: invokerTokenOfLength(8_193) },
    { label: "oversized", value: `${token}${"A".repeat(100_000)}` },
  ];
  return cases;
}

// ---------------------------------------------------------------------------
// Edge origin configuration

const ORIGIN = "https://edge-origin-abc123-uc.a.run.app";
const AUDIENCE = INVOKER_AUDIENCE;
const SERVICE_ACCOUNT = INVOKER_SERVICE_ACCOUNT;
const BASE_CONFIGURATION: Readonly<Record<string, unknown>> = Object.freeze({
  EDGE_UPSTREAM_ORIGIN: ORIGIN,
  EDGE_ORIGIN_AUDIENCE: AUDIENCE,
  EDGE_INVOKER_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
});
const EXPECTED_CONFIGURATION = Object.freeze({
  upstreamOrigin: ORIGIN,
  audience: AUDIENCE,
  invokerServiceAccount: SERVICE_ACCOUNT,
  upstreamHeadersTimeoutSeconds: 100,
});

function getter(overrides: Record<string, unknown>): (name: string) => unknown {
  const settings: Record<string, unknown> = { ...BASE_CONFIGURATION, ...overrides };
  return (name) => (Object.hasOwn(settings, name) ? settings[name] : undefined);
}

const VALID_CONFIGURATION_CASES: readonly {
  readonly label: string;
  readonly overrides: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
}[] = [
  { label: "defaults the headers timeout", overrides: {}, expected: {} },
  {
    label: "regional run.app host",
    overrides: { EDGE_UPSTREAM_ORIGIN: "https://edge-origin-123456789012.europe-west1.run.app" },
    expected: { upstreamOrigin: "https://edge-origin-123456789012.europe-west1.run.app" },
  },
  { label: "minimum timeout", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "5" }, expected: { upstreamHeadersTimeoutSeconds: 5 } },
  { label: "maximum timeout", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "300" }, expected: { upstreamHeadersTimeoutSeconds: 300 } },
  { label: "explicit default timeout", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: "100" }, expected: { upstreamHeadersTimeoutSeconds: 100 } },
  { label: "numeric timeout", overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: 42 }, expected: { upstreamHeadersTimeoutSeconds: 42 } },
  { label: "one-character audience", overrides: { EDGE_ORIGIN_AUDIENCE: "a" }, expected: { audience: "a" } },
  { label: "256-character audience", overrides: { EDGE_ORIGIN_AUDIENCE: "a".repeat(256) }, expected: { audience: "a".repeat(256) } },
  { label: "audience with inner space", overrides: { EDGE_ORIGIN_AUDIENCE: "edge origin" }, expected: { audience: "edge origin" } },
  {
    label: "shortest service account",
    overrides: { EDGE_INVOKER_SERVICE_ACCOUNT: "abcdef@ghijkl.iam.gserviceaccount.com" },
    expected: { invokerServiceAccount: "abcdef@ghijkl.iam.gserviceaccount.com" },
  },
  {
    label: "longest service account",
    overrides: { EDGE_INVOKER_SERVICE_ACCOUNT: `a${"b".repeat(28)}c@d${"e".repeat(28)}f.iam.gserviceaccount.com` },
    expected: { invokerServiceAccount: `a${"b".repeat(28)}c@d${"e".repeat(28)}f.iam.gserviceaccount.com` },
  },
];

const INVALID_CONFIGURATION_CASES: readonly { readonly label: string; readonly overrides: Record<string, unknown> }[] = [
  ...[
    [undefined, "absent"],
    ["", "empty"],
    ["http://edge-origin-abc123-uc.a.run.app", "http"],
    [`${ORIGIN}/`, "trailing slash path"],
    [`${ORIGIN}/api`, "path"],
    [`${ORIGIN}?region=us`, "query"],
    [`${ORIGIN}#fragment`, "fragment"],
    ["https://origin.synthetic.example", "non-run.app host"],
    ["https://run.app", "bare run.app"],
    ["https://edge.run.app.synthetic.example", "run.app prefix of another host"],
    ["https://edge.a.run.app.", "trailing dot"],
    ["https://user@edge-origin-abc123-uc.a.run.app", "username"],
    ["https://user:secret@edge-origin-abc123-uc.a.run.app", "credentials"],
    [`${ORIGIN}:443`, "default port"],
    [`${ORIGIN}:8443`, "explicit port"],
    ["HTTPS://EDGE-ORIGIN-ABC123-UC.A.RUN.APP", "non-canonical case"],
    [` ${ORIGIN}`, "leading space"],
    [`${ORIGIN} `, "trailing space"],
    ["https://edge_origin.a.run.app", "underscore host"],
    ["https://-edge.a.run.app", "leading hyphen label"],
    ["https://\u00fc.run.app", "non-ASCII host"],
    ["https://127.0.0.1", "IPv4 host"],
    ["https://[::1]", "IPv6 host"],
    ["wss://edge-origin-abc123-uc.a.run.app", "other scheme"],
    [42, "number"],
  ].map(([value, label]) => ({ label: `origin ${String(label)}`, overrides: { EDGE_UPSTREAM_ORIGIN: value } })),
  ...[
    [undefined, "absent"],
    ["", "empty"],
    [" aud", "leading space"],
    ["aud ", "trailing space"],
    ["a".repeat(257), "257 characters"],
    ["a\u0000b", "NUL"],
    ["a\nb", "line feed"],
    ["a\u007fb", "delete"],
    ["\u00e9", "non-ASCII"],
    [42, "number"],
  ].map(([value, label]) => ({ label: `audience ${String(label)}`, overrides: { EDGE_ORIGIN_AUDIENCE: value } })),
  ...[
    [undefined, "absent"],
    ["", "empty"],
    ["Edge-invoker@synthetic-edge-0.iam.gserviceaccount.com", "uppercase"],
    ["edge@synthetic-edge-0.iam.gserviceaccount.com", "local part too short"],
    [`a${"b".repeat(29)}c@synthetic-edge-0.iam.gserviceaccount.com`, "local part too long"],
    ["edge-invoker-@synthetic-edge-0.iam.gserviceaccount.com", "local part ends in hyphen"],
    ["1edge-invoker@synthetic-edge-0.iam.gserviceaccount.com", "local part starts with a digit"],
    ["edge-invoker@edge.iam.gserviceaccount.com", "project too short"],
    ["edge-invoker@synthetic-edge-0.iam.gserviceaccount.com.synthetic.example", "suffix"],
    ["123456789012-compute@developer.gserviceaccount.com", "default compute account"],
    ["edge-invoker@synthetic-edge-0.iam.gserviceaccount.co", "wrong domain"],
    [`${SERVICE_ACCOUNT} `, "trailing space"],
    [42, "number"],
  ].map(([value, label]) => ({ label: `service account ${String(label)}`, overrides: { EDGE_INVOKER_SERVICE_ACCOUNT: value } })),
  ...[
    ["4", "4"],
    ["301", "301"],
    ["0", "0"],
    ["-5", "negative"],
    ["5.5", "fractional string"],
    ["05", "leading zero"],
    ["1e2", "exponent"],
    ["0x64", "hex"],
    ["1000", "1000"],
    ["", "empty"],
    [" 100", "leading space"],
    ["100 ", "trailing space"],
    [4, "number 4"],
    [301, "number 301"],
    [5.5, "fractional number"],
    [Number.NaN, "NaN"],
    [null, "null"],
    [true, "boolean"],
  ].map(([value, label]) => ({
    label: `timeout ${String(label)}`,
    overrides: { EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: value },
  })),
];

// ---------------------------------------------------------------------------
// Helpers

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function threwTypeError(callback: () => unknown, message: string): boolean {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof Error && error.name === "TypeError" && error.message === message;
  }
}

function neverThrows<T>(callback: () => T, assert: ContractAssert, label: string): T | undefined {
  try {
    return callback();
  } catch {
    assert.ok(false, `${label} threw`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Checks

export const EDGE_ORIGIN_CONTRACT_CHECKS: readonly EdgeOriginContractCheck[] = Object.freeze([
  {
    name: "exports exactly the reviewed surface and no per-address header, derivation or pattern",
    run(contract, assert) {
      assert.deepEqual(Object.keys(contract).sort(), [...EXPECTED_EXPORT_NAMES].sort());
      // The edge-only secret's minimum length is the one permitted name.
      assert.deepEqual(
        Object.keys(contract).filter((name) => /client|address/iu.test(name)),
        ["EDGE_MIN_CLIENT_KEY_SECRET_LENGTH"],
      );
      assert.equal(contract.EDGE_MIN_CLIENT_KEY_SECRET_LENGTH, 32);
      // Every exported value except the never-forwarded edge-local list.
      const strings: string[] = [];
      for (const [name, value] of Object.entries(contract)) {
        if (typeof value === "function") assert.ok(!/client|address/iu.test(value.name), value.name);
        else if (name !== "EDGE_LOCAL_ONLY_REQUEST_HEADERS") collectStrings(value, strings);
      }
      assert.ok(strings.length > 40);
      for (const value of strings) {
        assert.ok(!/client|address|connecting-ip|forwarded|real-ip/iu.test(value), value);
      }
    },
  },
  {
    name: "freezes every exported collection",
    run(contract, assert) {
      for (const [name, value] of Object.entries(contract)) {
        if (value !== null && typeof value === "object") assert.ok(Object.isFrozen(value), name);
      }
    },
  },
  {
    name: "parses exactly the three upstream modes and the two host kinds",
    run(contract, assert) {
      assert.deepEqual([...contract.EDGE_UPSTREAM_MODES], ["worker", "fenced", "gcp"]);
      assert.deepEqual([...contract.EDGE_HOST_KINDS], ["apex", "admin"]);
      for (const { value, expected } of MODE_CASES) {
        assert.equal(contract.parseEdgeUpstreamMode(value), expected, `mode ${JSON.stringify(value)}`);
      }
    },
  },
  {
    name: "names the contract headers and keeps the request header classes disjoint",
    run(contract, assert) {
      assert.deepEqual({ ...contract.EDGE_HEADERS }, EXPECTED_HEADERS);
      assert.deepEqual([...contract.EDGE_CONTRACT_REQUEST_HEADERS], [
        EXPECTED_HEADERS.host,
        EXPECTED_HEADERS.admission,
        EXPECTED_HEADERS.requestId,
        EXPECTED_HEADERS.callbackQuery,
      ]);
      assert.deepEqual([...contract.FORWARDED_REQUEST_HEADERS], [...EXPECTED_FORWARDED_REQUEST_HEADERS]);
      assert.deepEqual([...contract.ADMIN_ONLY_FORWARDED_REQUEST_HEADERS], ["cf-access-jwt-assertion"]);
      assert.deepEqual(
        [...contract.EDGE_LOCAL_ONLY_REQUEST_HEADERS],
        [...EXPECTED_EDGE_LOCAL_ONLY_REQUEST_HEADERS],
      );
      assert.deepEqual([...contract.DROPPED_RESPONSE_HEADERS], [...EXPECTED_DROPPED_RESPONSE_HEADERS]);
      const classes = [
        contract.EDGE_CONTRACT_REQUEST_HEADERS,
        contract.FORWARDED_REQUEST_HEADERS,
        contract.ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
        contract.EDGE_LOCAL_ONLY_REQUEST_HEADERS,
        [contract.EDGE_HEADERS.invokerToken],
      ];
      const all: string[] = classes.flatMap((headers) => [...headers]);
      const dropped: readonly string[] = contract.DROPPED_RESPONSE_HEADERS;
      assert.equal(new Set(all).size, all.length, "request header classes overlap");
      for (const name of [...all, ...contract.DROPPED_RESPONSE_HEADERS]) {
        assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name), name);
      }
      for (const name of contract.EDGE_CONTRACT_REQUEST_HEADERS) {
        assert.ok(name.startsWith("x-tibotattle-"), name);
      }
      for (const name of [
        ...contract.FORWARDED_REQUEST_HEADERS,
        ...contract.ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
      ]) {
        assert.ok(!name.startsWith("x-tibotattle-") && !name.startsWith("x-forwarded-"), name);
        assert.ok(!dropped.includes(name), name);
      }
      assert.ok(!all.includes("x-tibotattle-edge-client-key"));
      assert.ok(dropped.includes(contract.EDGE_HEADERS.originMarker));
      assert.ok(!dropped.includes("set-cookie"));
    },
  },
  {
    name: "round-trips every admission purpose and outcome",
    run(contract, assert) {
      assert.deepEqual([...contract.EDGE_ADMISSION_PURPOSES], [...EXPECTED_ADMISSION_PURPOSES]);
      assert.deepEqual([...contract.EDGE_ADMISSION_OUTCOMES], [...EXPECTED_ADMISSION_OUTCOMES]);
      const encoded = new Set<string>();
      for (const purpose of contract.EDGE_ADMISSION_PURPOSES) {
        for (const outcome of contract.EDGE_ADMISSION_OUTCOMES) {
          const value = contract.encodeEdgeAdmission({ purpose, outcome });
          assert.equal(value, `v1;${purpose};${outcome}`);
          assert.ok(value.length <= 96, value);
          const decoded = contract.decodeEdgeAdmission(value);
          assert.deepEqual(decoded, { purpose, outcome });
          assert.ok(Object.isFrozen(decoded), value);
          encoded.add(value);
        }
      }
      assert.equal(encoded.size, 30);
    },
  },
  {
    name: "rejects malformed admission values and inputs",
    run(contract, assert) {
      for (const value of MALFORMED_ADMISSION_VALUES) {
        const decoded = neverThrows(() => contract.decodeEdgeAdmission(value), assert, "decode");
        assert.equal(decoded, null, `decode ${JSON.stringify(value)?.slice(0, 80)}`);
      }
      for (const input of MALFORMED_ADMISSION_INPUTS) {
        assert.ok(
          threwTypeError(() => contract.encodeEdgeAdmission(input as never), "EDGE_ADMISSION_INVALID"),
          `encode ${JSON.stringify(input)}`,
        );
      }
    },
  },
  {
    name: "accepts only lowercase version 4 request ids",
    run(contract, assert) {
      for (const { value, valid } of REQUEST_ID_CASES) {
        assert.equal(contract.isEdgeRequestId(value), valid, `request id ${JSON.stringify(value)}`);
      }
      assert.ok(contract.isEdgeRequestId(crypto.randomUUID()));
    },
  },
  {
    name: "validates Google callback queries on the shared table",
    run(contract, assert) {
      assert.equal(contract.GOOGLE_CALLBACK_PATH, "/api/v1/identity/google/callback");
      assert.equal(contract.MAX_GOOGLE_CALLBACK_URL_LENGTH, 8_192);
      assert.ok(GOOGLE_CALLBACK_QUERY_CASES.length >= 20);
      const queries = GOOGLE_CALLBACK_QUERY_CASES.map(({ query }) => query);
      for (const required of ["?", "?a=b\\c", "?a=b#fragment", "?a=b c", "?a=\u0000", "code=synthetic-code"]) {
        assert.ok(queries.includes(required), `table covers ${JSON.stringify(required)}`);
      }
      assert.ok(queries.some((query) => typeof query === "string" && query.length === 8_192));
      assert.ok(queries.some((query) => typeof query === "string" && query.length === 8_193));
      for (const { label, query, valid } of GOOGLE_CALLBACK_QUERY_CASES) {
        assert.equal(contract.validGoogleCallbackQuery(query), valid, label);
      }
      assert.equal(contract.validGoogleCallbackQuery(undefined), false);
    },
  },
  {
    name: "decodes delivered invoker claims without retaining the token",
    run(contract, assert) {
      for (const { label, value, now, expected } of validClaimsCases()) {
        const claims = neverThrows(
          () => contract.parseCloudRunInvokerClaims(value, now ?? INVOKER_NOW_SECONDS),
          assert,
          label,
        );
        assert.deepEqual(claims, expected, label);
        assert.ok(Object.isFrozen(claims) && Object.isFrozen(claims?.audiences), label);
        const serialized = JSON.stringify(claims);
        const [, payloadSegment = ""] = value.slice("Bearer ".length).split(".");
        assert.ok(!serialized.includes(payloadSegment), label);
        assert.ok(!serialized.includes(SIGNATURE_REMOVED) && !serialized.includes("Bearer"), label);
      }
    },
  },
  {
    name: "rejects every malformed invoker claim variant without throwing",
    run(contract, assert) {
      for (const variant of invalidClaimsCases()) {
        const clock = Object.hasOwn(variant, "clock") ? variant.clock : INVOKER_NOW_SECONDS;
        const claims = neverThrows(
          () => contract.parseCloudRunInvokerClaims(variant.value, clock as number),
          assert,
          variant.label,
        );
        assert.equal(claims, null, variant.label);
      }
      assert.equal(contract.EDGE_INVOKER_CLOCK_SKEW_SECONDS, 60);
    },
  },
  {
    name: "accepts a canonical edge origin configuration",
    run(contract, assert) {
      for (const { label, overrides, expected } of VALID_CONFIGURATION_CASES) {
        const configuration = contract.parseEdgeOriginConfiguration(getter(overrides));
        assert.deepEqual(configuration, { ...EXPECTED_CONFIGURATION, ...expected }, label);
        assert.ok(Object.isFrozen(configuration), label);
      }
    },
  },
  {
    name: "rejects every malformed edge origin configuration without throwing",
    run(contract, assert) {
      assert.ok(INVALID_CONFIGURATION_CASES.length > 60);
      for (const { label, overrides } of INVALID_CONFIGURATION_CASES) {
        const configuration = neverThrows(
          () => contract.parseEdgeOriginConfiguration(getter(overrides)),
          assert,
          label,
        );
        assert.equal(configuration, null, label);
      }
      const throwing = neverThrows(
        () => contract.parseEdgeOriginConfiguration(() => {
          throw new Error("SYNTHETIC_GETTER_FAILURE");
        }),
        assert,
        "throwing getter",
      );
      assert.equal(throwing, null, "throwing getter");
      for (const get of [undefined, null, {}, "EDGE_UPSTREAM_ORIGIN"]) {
        const configuration = neverThrows(
          () => contract.parseEdgeOriginConfiguration(get as never),
          assert,
          `getter ${String(get)}`,
        );
        assert.equal(configuration, null, `getter ${String(get)}`);
      }
    },
  },
  {
    name: "pins the transport constants",
    run(contract, assert) {
      assert.equal(contract.EDGE_FENCE_RETRY_AFTER_SECONDS, 300);
      assert.equal(contract.EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS, 60);
      assert.equal(contract.EDGE_MAX_FORWARD_BODY_BYTES, 8 * 1024 * 1024);
      assert.equal(contract.EDGE_MAX_OVERVIEW_MERGE_BYTES, 4 * 1024 * 1024);
      assert.equal(contract.EDGE_MIN_CLIENT_KEY_SECRET_LENGTH, 32);
      assert.equal(contract.EDGE_NOT_CONFIGURED, "EDGE_NOT_CONFIGURED");
      assert.equal(contract.EDGE_ORIGIN_UNAVAILABLE, "EDGE_ORIGIN_UNAVAILABLE");
      assert.equal(contract.ORIGIN_BOUNDARY_ERROR_BODY, "{\"error\":\"HOST_REQUEST_UNAVAILABLE\"}");
      assert.deepEqual(JSON.parse(contract.ORIGIN_BOUNDARY_ERROR_BODY), { error: "HOST_REQUEST_UNAVAILABLE" });
    },
  },
]);
