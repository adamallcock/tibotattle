import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PARTICIPANT_ID = new RegExp(`^participant:${UUID}$`, "u");
const SESSION_COOKIE = new RegExp(
  `^__Host-usage_monitor_session=um_session_${UUID}\\.[A-Za-z0-9_-]{43}$`, "u",
);
const CSRF_TOKEN = /^um_csrf_[A-Za-z0-9_-]{43}$/u;
const OPERATION_ID = new RegExp(`^${UUID}$`, "u");
const MESSAGES = Object.freeze({
  LOCAL_OWNER_ACCESS_REQUIRED:
    "--owner-access-file is required before enrollment. Use a dedicated local lab owner fixture; participant DELETE is retired and is not cleanup.",
  LOCAL_OWNER_ACCESS_INVALID:
    "The local owner access file must be unexpired, owner-only, and bound to this exact loopback origin.",
  LOCAL_OWNER_NOT_AUTHORIZED:
    "The local owner fixture is not authorized. Pin only its identity with ADMIN_IDENTITY_LINK_KEY in the isolated local Worker configuration.",
  LOCAL_OWNER_ENVIRONMENT_INVALID:
    "Owner erasure harnesses require the local-development or synthetic-development Worker environment.",
  LOCAL_ERASURE_ORIGIN_INVALID: "Owner erasure accepts only an unauthenticated loopback HTTP origin.",
  LOCAL_ERASURE_TARGET_INVALID: "Owner erasure requires a separate participant:<UUID> target created by this harness.",
  LOCAL_ERASURE_TRANSPORT_FAILED: "The bounded local erasure HTTP request failed.",
  LOCAL_ERASURE_RESPONSE_INVALID: "The local erasure HTTP response violated its bounded JSON/cache contract.",
  LOCAL_ERASURE_RECEIPT_INVALID: "Owner erasure did not return a valid admin-action-v0.1 participant-erasure receipt.",
  LOCAL_ERASURE_SESSION_NOT_REVOKED: "Owner erasure did not revoke the erased participant session.",
  LOCAL_RETIREMENT_CONTRACT_INVALID: "The service did not advertise retired self-service deletion with deletion-safe restore replay.",
  LOCAL_RETIREMENT_REFUSAL_INVALID: "A retired deletion or unauthorized owner-erasure request was not refused as required.",
  LOCAL_RETIREMENT_STATE_CHANGED: "A refused deletion request changed participant export, session, or device state.",
  LOCAL_PARTICIPANT_SNAPSHOT_INVALID: "The participant state could not be verified before or after deletion refusal.",
});

export class LocalOwnerErasureError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? "The local owner erasure check failed.");
    this.name = "LocalOwnerErasureError";
    this.code = Object.hasOwn(MESSAGES, code) ? code : "LOCAL_ERASURE_RESPONSE_INVALID";
  }
}

function fail(code) {
  throw new LocalOwnerErasureError(code);
}

export function localErasureOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail("LOCAL_ERASURE_ORIGIN_INVALID"); }
  if (url.protocol !== "http:"
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("LOCAL_ERASURE_ORIGIN_INVALID");
  }
  return url.origin;
}

export function assertRetiredDeletionHealth(health) {
  if (health?.capabilities?.participantDeletion !== false
      || health?.capabilities?.deletionSafeRestoreReplay !== true) {
    fail("LOCAL_RETIREMENT_CONTRACT_INVALID");
  }
}

export async function readLocalOwnerAccess(path, origin, nowEpoch = Date.now()) {
  const expectedOrigin = localErasureOrigin(origin);
  if (!path) fail("LOCAL_OWNER_ACCESS_REQUIRED");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      fail("LOCAL_OWNER_ACCESS_INVALID");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value?.schemaVersion !== "local-backend-owner-access-v0.1"
        || value.origin !== expectedOrigin
        || !PARTICIPANT_ID.test(value.participantId)
        || !SESSION_COOKIE.test(value.sessionCookie)
        || !CSRF_TOKEN.test(value.csrfToken)
        || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= nowEpoch
        || Object.keys(value).sort().join("\0")
          !== "csrfToken\0expiresAt\0origin\0participantId\0schemaVersion\0sessionCookie") {
      fail("LOCAL_OWNER_ACCESS_INVALID");
    }
    return Object.freeze(value);
  } catch {
    fail("LOCAL_OWNER_ACCESS_INVALID");
  } finally {
    await handle?.close();
  }
}

function erasureBody(participantId) {
  return {
    action: "run_maintenance",
    participantErasure: { participantId, confirmation: "erase_hosted_participant" },
  };
}

export function validateOwnerErasureReceipt(value, { expectedContributions, retry = false } = {}) {
  const result = value?.result;
  if (value?.schemaVersion !== "admin-action-v0.1" || value.action !== "run_maintenance"
      || Object.keys(value).sort().join("\0") !== "action\0result\0schemaVersion"
      || result?.task !== "participant_erasure" || !OPERATION_ID.test(result.operationId)
      || result.deleted !== true || typeof result.alreadyDeleted !== "boolean"
      || Object.keys(result).sort().join("\0")
        !== "alreadyDeleted\0contributionsDeleted\0deleted\0operationId\0task"
      || (result.alreadyDeleted
        ? !retry || result.contributionsDeleted !== null
        : !Number.isSafeInteger(result.contributionsDeleted) || result.contributionsDeleted < 0
          || (expectedContributions !== undefined
            && result.contributionsDeleted !== expectedContributions))) {
    fail("LOCAL_ERASURE_RECEIPT_INVALID");
  }
  return result;
}

// This is deliberately a local HTTP client, not an auth bypass or a production
// erasure tool. The supplied owner must pass the Worker's existing admin gate.
export async function createLocalOwnerEraser({
  origin,
  ownerAccessFile,
  fetchImpl = fetch,
  requestTimeoutMilliseconds = 30_000,
} = {}) {
  const localOrigin = localErasureOrigin(origin);
  const owner = await readLocalOwnerAccess(ownerAccessFile, localOrigin);
  if (!Number.isSafeInteger(requestTimeoutMilliseconds)
      || requestTimeoutMilliseconds < 1 || requestTimeoutMilliseconds > 120_000) {
    fail("LOCAL_ERASURE_RESPONSE_INVALID");
  }
  const ownerSession = { cookie: owner.sessionCookie, csrfToken: owner.csrfToken };
  const targets = new Set();

  async function request(path, {
    session = null, method = "GET", body, csrf = false, requestOrigin = localOrigin,
  } = {}) {
    const headers = { Accept: "application/json" };
    if (session?.cookie) headers.Cookie = session.cookie;
    if (method !== "GET") headers.Origin = requestOrigin;
    if (csrf) headers["X-Usage-Monitor-CSRF"] = session?.csrfToken ?? "";
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    let value;
    try {
      response = await fetchImpl(new URL(path, localOrigin), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      value = await response.json();
    } catch {
      fail("LOCAL_ERASURE_TRANSPORT_FAILED");
    }
    if (response.headers.get("cache-control") !== "no-store") {
      fail("LOCAL_ERASURE_RESPONSE_INVALID");
    }
    return { response, value };
  }

  const probe = await request("/api/v1/session", { session: ownerSession });
  if (probe.response.status !== 200 || probe.value?.participantId !== owner.participantId
      || probe.value?.csrfToken !== owner.csrfToken) fail("LOCAL_OWNER_NOT_AUTHORIZED");
  const overview = await request("/api/v1/admin/overview", { session: ownerSession });
  if (overview.response.status !== 200 || overview.value?.schemaVersion !== "admin-overview-v0.3") {
    fail("LOCAL_OWNER_NOT_AUTHORIZED");
  }
  if (!["local-development", "synthetic-development"].includes(overview.value?.service?.environment)) {
    fail("LOCAL_OWNER_ENVIRONMENT_INVALID");
  }

  function trackParticipant(session) {
    if (!PARTICIPANT_ID.test(session?.participantId)
        || session.participantId === owner.participantId || session.cookie === owner.sessionCookie) {
      fail("LOCAL_ERASURE_TARGET_INVALID");
    }
    targets.add(session.participantId);
  }

  function assertTarget(session) {
    if (!targets.has(session?.participantId)) fail("LOCAL_ERASURE_TARGET_INVALID");
  }

  async function snapshot(session) {
    const exported = await request("/api/v1/me/export", { session });
    const active = await request("/api/v1/session", { session });
    const devices = await request("/api/v1/me/devices", { session });
    if (exported.response.status !== 200 || active.response.status !== 200 || devices.response.status !== 200
        || exported.value?.schemaVersion !== "participant-export-v0.2"
        || exported.value?.participant?.participantId !== session.participantId
        || !Array.isArray(exported.value?.contributions)
        || active.value?.participantId !== session.participantId
        || active.value?.csrfToken !== session.csrfToken || !Array.isArray(devices.value?.devices)) {
      fail("LOCAL_PARTICIPANT_SNAPSHOT_INVALID");
    }
    // Export generation time is volatile; participant data and authorities are not.
    const { generatedAt: _generatedAt, ...participantExport } = exported.value;
    return { participantExport, session: active.value, devices: devices.value };
  }

  async function verifyParticipantRefusal(session) {
    assertTarget(session);
    const before = await snapshot(session);
    const body = erasureBody(session.participantId);
    const probes = [
      ["/api/v1/me", { method: "DELETE" }, 404, "NOT_FOUND"],
      ["/api/v1/me", { method: "DELETE", session }, 404, "NOT_FOUND"],
      ["/api/v1/me", { method: "DELETE", session, csrf: true }, 404, "NOT_FOUND"],
      ["/api/v1/me", { method: "DELETE", session, csrf: true, requestOrigin: "https://refused.invalid" }, 404, "NOT_FOUND"],
      ["/api/v1/admin/action", { method: "POST", session, csrf: true, body }, 403, "ADMIN_REQUIRED"],
      ["/api/v1/admin/action", { method: "POST", session: ownerSession, body }, 403, "CSRF_INVALID"],
      ["/api/v1/admin/action", {
        method: "POST", session: { ...ownerSession, csrfToken: "incorrect-local-csrf" }, csrf: true, body,
      }, 403, "CSRF_INVALID"],
      ["/api/v1/admin/action", {
        method: "POST", session: ownerSession, csrf: true, body, requestOrigin: "https://refused.invalid",
      }, 403, "CSRF_INVALID"],
    ];
    for (const [path, options, status, code] of probes) {
      const result = await request(path, options);
      if (result.response.status !== status || result.value?.error?.code !== code
          || result.response.headers.has("set-cookie")) fail("LOCAL_RETIREMENT_REFUSAL_INVALID");
    }
    if (!isDeepStrictEqual(before, await snapshot(session))) fail("LOCAL_RETIREMENT_STATE_CHANGED");
    return { selfServiceDeletionRefused: true, participantStateUnchanged: true, ownerAuthAndCsrfRequired: true };
  }

  async function erase(session, options) {
    const response = await request("/api/v1/admin/action", {
      method: "POST", session: ownerSession, csrf: true, body: erasureBody(session.participantId),
    });
    if (response.response.status !== 200) fail("LOCAL_ERASURE_RECEIPT_INVALID");
    const receipt = validateOwnerErasureReceipt(response.value, options);
    if (session.cookie) {
      const revoked = await request("/api/v1/me/export", { session });
      if (revoked.response.status !== 401 || revoked.value?.error?.code !== "AUTH_INVALID") {
        fail("LOCAL_ERASURE_SESSION_NOT_REVOKED");
      }
    }
    session.deleted = true;
    return receipt;
  }

  return Object.freeze({
    trackParticipant,
    verifyParticipantRefusal,
    async eraseParticipant(session, options = {}) {
      assertTarget(session);
      return erase(session, options);
    },
    // Only the lab creator calls this after all workload participants are erased.
    async eraseOwnerFixture() {
      return erase({ ...ownerSession, participantId: owner.participantId }, { expectedContributions: 0 });
    },
  });
}
