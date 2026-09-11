import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";
import { assertRetiredDeletionHealth, createLocalOwnerEraser } from "./local-owner-erasure.mjs";
import { assertHttpSmokeCachePolicy } from "./http-smoke-cache-policy.mjs";

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function boundedOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)
      || origin.username || origin.password) {
    throw new Error("The backend smoke accepts only a loopback HTTP origin.");
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin;
}

async function ownerOnlyFile(path, label) {
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must be owner-only (mode 0600).`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createServerValidationProbe({ payload, publicJwk, keyId }) {
  const wrappingKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const payloadKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    payloadKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const rawPayloadKey = await crypto.subtle.exportKey("raw", payloadKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    wrappingKey,
    rawPayloadKey,
  );
  return {
    schemaVersion: "telemetry-envelope-v0.1",
    synthetic: false,
    keyId,
    wrappedKey: base64Url(wrappedKey),
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext),
  };
}

function cookiePair(setCookie) {
  if (typeof setCookie !== "string") return null;
  return setCookie.split(";", 1)[0] ?? null;
}

function assertSessionCookie(setCookie, { cleared = false } = {}) {
  if (typeof setCookie !== "string"
      || !setCookie.startsWith("__Host-usage_monitor_session=")
      || !setCookie.includes("Path=/")
      || !setCookie.includes("Secure")
      || !setCookie.includes("HttpOnly")
      || !setCookie.includes("SameSite=Strict")
      || (cleared ? !setCookie.includes("Max-Age=0") : setCookie.includes("Max-Age=0"))) {
    throw new Error("The service returned an invalid personal-session cookie.");
  }
}

class ParticipantSession {
  constructor() {
    this.cookie = null;
    this.csrfToken = null;
    this.recoveryCode = null;
    this.bootstrapPairing = null;
    this.device = null;
    this.created = false;
    this.deleted = false;
    this.participantId = null;
  }

  applyCookie(setCookie) {
    if (!setCookie) return;
    assertSessionCookie(setCookie, { cleared: setCookie.includes("Max-Age=0") });
    this.cookie = setCookie.includes("Max-Age=0") ? null : cookiePair(setCookie);
  }
}

const origin = boundedOrigin(optionValue("--origin", "http://127.0.0.1:8792"));
const contributionPathValue = optionValue("--file");
const generatedFixture = process.argv.includes("--generated-content-free-fixture");
const retainInspectionState = process.argv.includes("--retain-inspection-state");
const participantAccessFileValue = optionValue("--participant-access-file");
if (retainInspectionState !== Boolean(participantAccessFileValue)) {
  throw new Error(
    "--retain-inspection-state and --participant-access-file must be used together.",
  );
}
const participantAccessFile = participantAccessFileValue
  ? resolve(participantAccessFileValue)
  : null;
if (Boolean(contributionPathValue) === generatedFixture) {
  throw new Error(
    "Choose exactly one of --file or --generated-content-free-fixture.",
  );
}
const contributionPath = contributionPathValue ? resolve(contributionPathValue) : null;
const invitePaths = optionValues("--invite-file").map((value) => resolve(value));
const sessions = [];
let ownerEraser;
let preserveParticipants = false;
const COMMUNITY_SNAPSHOT_PARTICIPANTS = 20;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

async function writeParticipantAccessFile(path, session) {
  if (typeof session?.cookie !== "string"
      || !session.cookie.startsWith("__Host-usage_monitor_session=")
      || typeof session?.csrfToken !== "string") {
    throw new Error("The retained participant did not have a valid session capability.");
  }
  const flags = process.platform === "win32"
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: "local-backend-lab-access-v0.2",
      origin: origin.origin,
      sessionCookie: session.cookie,
      csrfToken: session.csrfToken,
      createdAt: new Date().toISOString(),
      warning: "Owner-only disposable local-development capability. Do not share.",
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function request(path, {
  method = "GET",
  session = null,
  body = null,
  csrf = false,
  authorization = null,
  originValue = null,
} = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (authorization) headers.Authorization = authorization;
  if (body !== null) headers["Content-Type"] = "application/json";
  if (csrf) {
    headers.Origin = originValue ?? origin.origin;
    headers["X-Usage-Monitor-CSRF"] = session?.csrfToken ?? "";
  } else if (originValue !== null) {
    headers.Origin = originValue;
  }
  const url = new URL(path, origin);
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "error",
  });
  assertHttpSmokeCachePolicy(response, { method, pathname: url.pathname });
  if (session) session.applyCookie(response.headers.get("set-cookie"));
  let value = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`The backend returned non-JSON for ${method} ${path}.`);
    }
  }
  return { response, value, text };
}

function expectStatus(result, status, label) {
  if (result.response.status !== status) {
    throw new Error(`${label} returned ${result.response.status}; expected ${status}.`);
  }
  return result.value;
}

function expectErrorCode(result, status, code, label) {
  const value = expectStatus(result, status, label);
  if (value?.error?.code !== code) {
    throw new Error(`${label} did not return ${code}.`);
  }
  return value;
}

function scheduledSnapshotTime(contribution) {
  const usageTimes = contribution.usageEvents.map((event) => Date.parse(event.eventTime));
  if (usageTimes.length === 0 || usageTimes.some((time) => !Number.isFinite(time))) {
    throw new Error("The backend smoke contribution must contain dated usage events.");
  }
  const first = new Date(Math.min(...usageTimes));
  first.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (first.getUTCDay() + 6) % 7;
  const weekStart = first.getTime() - daysSinceMonday * DAY_MILLISECONDS;
  const weekEnd = weekStart + 7 * DAY_MILLISECONDS;
  if (usageTimes.some((time) => time < weekStart || time >= weekEnd)) {
    throw new Error("The backend smoke usage events must fit within one Monday-to-Monday UTC week.");
  }
  const cutoff = weekEnd + 2 * DAY_MILLISECONDS;
  if (Date.now() >= cutoff) {
    throw new Error(
      "The contribution week is already past its ingestion cutoff; prepare a current-week contribution.",
    );
  }
  return cutoff;
}

function generatedContentFreeContribution() {
  const createdAt = new Date();
  const eventTime = new Date(createdAt.getTime() - 5 * 60 * 1000);
  const observedTime = new Date(createdAt.getTime() - 4 * 60 * 1000);
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: createdAt.toISOString(),
    coveredAt: {
      startAt: eventTime.toISOString(),
      endAt: observedTime.toISOString(),
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: eventTime.toISOString(),
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "standard",
      apiServiceTier: "standard",
      reasoningEffort: "medium",
      components: {
        inputUncachedTokens: 100,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 50,
        outputReasoningTokens: 25,
        outputCombinedTokens: null,
      },
      totalInputContextTokens: 1_000,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts: {
        webSearch: 0,
        fileSearch: 0,
        codeInterpreter: 0,
        hostedShell: 0,
        computerUse: 0,
        mcp: 0,
        applyPatch: 0,
        localShell: 0,
        subagent: 0,
        toolGateway: 0,
        other: 0,
        unknown: 0,
      },
      outcome: "completed",
      eventId: `event:v2:${"d".repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "0.000100",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1",
      observedTime: observedTime.toISOString(),
      receivedTime: createdAt.toISOString(),
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 31,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: new Date(createdAt.getTime() + 5 * DAY_MILLISECONDS).toISOString(),
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${"d".repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "0.000100",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

async function triggerScheduledSnapshot(scheduledTime) {
  const url = new URL("/cdn-cgi/handler/scheduled", origin);
  url.searchParams.set("format", "json");
  url.searchParams.set("time", String(scheduledTime));
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Scheduled snapshot trigger returned ${response.status}.`);
  }
  const result = await response.json();
  if (result?.outcome !== "ok") {
    throw new Error("Scheduled snapshot trigger did not complete successfully.");
  }
}

async function enrollParticipant(
  inviteCode = null,
  { deviceBootstrap = true } = {},
) {
  const session = new ParticipantSession();
  const body = {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
    ...(deviceBootstrap ? {
      deviceBootstrap: {
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      },
    } : {}),
  };
  if (inviteCode) body.inviteCode = inviteCode;
  const result = await request("/api/v1/enroll", {
    method: "POST",
    session,
    body: JSON.stringify(body),
    originValue: origin.origin,
  });
  const enrollment = expectStatus(result, 201, "Enrollment");
  assertSessionCookie(result.response.headers.get("set-cookie"));
  if (typeof enrollment?.participantId !== "string"
      || typeof enrollment?.csrfToken !== "string"
      || typeof enrollment?.recoveryCode !== "string"
      || enrollment?.schemaVersion !== "participant-bootstrap-v0.1"
      || enrollment?.state !== (deviceBootstrap ? "pairing_ready" : "enrolled")
      || enrollment?.session?.state !== "active"
      || !Number.isFinite(Date.parse(enrollment?.session?.issuedAt))
      || !Number.isFinite(Date.parse(enrollment?.session?.expiresAt))
      || enrollment?.recovery?.state !== "issued"
      || enrollment?.recovery?.requiresAcknowledgement !== true
      || (deviceBootstrap
        ? enrollment?.pairing?.state !== "claimable"
          || enrollment?.pairing?.scope !== "upload_registration"
          || enrollment?.pairing?.oneUse !== true
          || typeof enrollment?.pairing?.pairingCode !== "string"
          || !enrollment.pairing.pairingCode.startsWith("um_pair_")
          || !Number.isFinite(Date.parse(enrollment?.pairing?.issuedAt))
          || !Number.isFinite(Date.parse(enrollment?.pairing?.expiresAt))
        : enrollment?.pairing !== null)
      || Object.hasOwn(enrollment, "accessToken")
      || !session.cookie) {
    throw new Error("Enrollment did not establish the bounded session contract.");
  }
  session.csrfToken = enrollment.csrfToken;
  session.participantId = enrollment.participantId;
  session.recoveryCode = enrollment.recoveryCode;
  session.bootstrapPairing = enrollment.pairing;
  session.created = true;
  sessions.push(session);
  ownerEraser.trackParticipant(session);

  const probe = expectStatus(
    await request("/api/v1/session", { session }),
    200,
    "Session probe",
  );
  if (probe.csrfToken !== session.csrfToken) {
    throw new Error("The session probe did not preserve its CSRF binding.");
  }
  if (deviceBootstrap) session.device = await pairDevice(session);
  return session;
}

async function pairDevice(session, pairing = session.bootstrapPairing) {
  if (!pairing) {
    throw new Error("Enrollment did not supply the atomic device bootstrap.");
  }
  if (typeof pairing?.pairingCode !== "string"
      || !pairing.pairingCode.startsWith("um_pair_")
      || typeof pairing.expiresAt !== "string") {
    throw new Error("Device pairing did not return the bounded one-use contract.");
  }
  const deviceId = randomUUID();
  const rawSecret = randomBytes(32);
  const encodedSecret = rawSecret.toString("base64url");
  let deviceSecretHash;
  try {
    deviceSecretHash = createHash("sha256")
      .update("app-usagemonitor/device/v1\0")
      .update(deviceId)
      .update("\0")
      .update(rawSecret)
      .digest("hex");
  } finally {
    rawSecret.fill(0);
  }
  const claim = expectStatus(
    await request("/api/v1/device-pairings/claim", {
      method: "POST",
      authorization: `Pairing ${pairing.pairingCode}`,
      body: JSON.stringify({ deviceId, deviceSecretHash }),
    }),
    201,
    "Device pairing claim",
  );
  if (Object.keys(claim ?? {}).sort().join("\0")
        !== "deviceId\0expiresAt\0scope\0state"
      || claim.deviceId !== deviceId
      || claim.state !== "active"
      || claim.scope !== "upload_registration") {
    throw new Error("Device pairing claim returned an unexpected authority contract.");
  }
  return {
    deviceId,
    authorization: `um_device_${deviceId}.${encodedSecret}`,
  };
}

async function registerDeviceUpload(device, serializedEnvelope) {
  const registration = expectStatus(
    await request("/api/v1/device/upload-authorizations", {
      method: "POST",
      authorization: `Device ${device.authorization}`,
      body: JSON.stringify({
        envelopeDigest: sha256Hex(serializedEnvelope),
        contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
        contentType: "application/json",
      }),
    }),
    201,
    "Device upload registration",
  );
  if (typeof registration?.uploadAuthorization !== "string"
      || !registration.uploadAuthorization.startsWith("um_device_upload_")) {
    throw new Error("Device registration did not return a one-use upload authority.");
  }
  return registration.uploadAuthorization;
}

async function uploadFromDevice(device, serializedEnvelope) {
  const authorization = await registerDeviceUpload(device, serializedEnvelope);
  const result = await request("/api/v1/contributions", {
    method: "POST",
    body: serializedEnvelope,
    authorization: `Upload ${authorization}`,
  });
  return { authorization, result };
}

async function upload(session, serializedEnvelope) {
  if (!session.device) {
    throw new Error("The participant has no active upload device.");
  }
  return uploadFromDevice(session.device, serializedEnvelope);
}

async function cleanupParticipant(session) {
  if (!session.created || session.deleted) return;
  try {
    await ownerEraser.eraseParticipant(session, { retry: true });
  } catch {
    // The fixed warning below contains no participant or authority value.
  }
}

try {
  ownerEraser = await createLocalOwnerEraser({
    origin: origin.origin,
    ownerAccessFile: optionValue("--owner-access-file"),
  });
  const health = expectStatus(await request("/api/health"), 200, "Health");
  assertRetiredDeletionHealth(health);
  if (!["local_open", "invite_only"].includes(health?.enrollmentMode)) {
    throw new Error("Enrollment is disabled or the service returned an invalid enrollment mode.");
  }
  if (health.enrollmentMode === "invite_only"
      && invitePaths.length !== COMMUNITY_SNAPSHOT_PARTICIPANTS) {
    throw new Error(
      `Invite-only snapshot smoke requires exactly ${COMMUNITY_SNAPSHOT_PARTICIPANTS}`
      + " repeated --invite-file arguments.",
    );
  }
  if (health.enrollmentMode === "local_open" && invitePaths.length !== 0) {
    throw new Error("Do not pass invitation files to a local-open smoke.");
  }

  const contribution = generatedFixture
    ? generatedContentFreeContribution()
    : JSON.parse(await ownerOnlyFile(contributionPath, "Contribution file"));
  validateTelemetryContribution(contribution);
  const scheduledTime = scheduledSnapshotTime(contribution);
  const inviteCodes = [];
  for (const path of invitePaths) {
    inviteCodes.push((await ownerOnlyFile(path, "Invitation file")).trim());
  }

  const envelopeKey = expectStatus(
    await request("/api/v1/envelope-key"),
    200,
    "Envelope key",
  );
  const envelope = await createTelemetryEnvelope({
    payload: contribution,
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  const serializedEnvelope = JSON.stringify(envelope);

  const primary = await enrollParticipant(
    inviteCodes[0] ?? null,
    { deviceBootstrap: true },
  );

  const sessionOnlyUpload = await request("/api/v1/contributions", {
    method: "POST",
    session: primary,
    body: serializedEnvelope,
  });
  expectStatus(sessionOnlyUpload, 401, "Session-only upload");

  const device = primary.device;
  const first = await uploadFromDevice(device, serializedEnvelope);
  const accepted = expectStatus(first.result, 202, "Contribution upload");
  if (accepted.accountingVerification !== "server_repriced") {
    throw new Error("The accepted contribution was not canonically repriced.");
  }
  const reusedUpload = await request("/api/v1/contributions", {
    method: "POST",
    body: serializedEnvelope,
    authorization: `Upload ${first.authorization}`,
  });
  expectStatus(reusedUpload, 401, "Reused upload authority");

  const replay = expectStatus(
    (await uploadFromDevice(device, serializedEnvelope)).result,
    202,
    "Idempotent contribution replay",
  );
  if (replay.replayed !== true || replay.contributionId !== accepted.contributionId) {
    throw new Error("A fresh upload authority did not produce an idempotent replay.");
  }
  if (replay.accountingVerification !== "server_repriced") {
    throw new Error("The replay did not preserve canonical repricing.");
  }

  const conflictSafeAuthorization = await registerDeviceUpload(
    device,
    serializedEnvelope,
  );
  expectErrorCode(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${conflictSafeAuthorization}`,
      body: `${serializedEnvelope} `,
    }),
    401,
    "UPLOAD_AUTH_INVALID",
    "Upload scope conflict",
  );
  const conflictSafeRetry = expectStatus(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${conflictSafeAuthorization}`,
      body: serializedEnvelope,
    }),
    202,
    "Upload after rejected scope conflict",
  );
  if (conflictSafeRetry.replayed !== true
      || conflictSafeRetry.contributionId !== accepted.contributionId) {
    throw new Error("A rejected upload scope conflict damaged canonical replay state.");
  }

  const contaminatedEnvelope = await createServerValidationProbe({
    payload: {
      ...contribution,
      prompt: "FIXED_PRIVACY_CANARY",
    },
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  const contaminatedSerialized = JSON.stringify(contaminatedEnvelope);
  const contaminatedResult = (await upload(primary, contaminatedSerialized)).result;
  const contaminatedResponse = expectStatus(
    contaminatedResult,
    400,
    "Privacy-canary contribution",
  );
  if (contaminatedResponse?.error?.code !== "PRIVACY_CANARY_DETECTED") {
    throw new Error("The privacy-canary upload did not fail at the expected boundary.");
  }

  const invalidSchemaEnvelope = await createServerValidationProbe({
    payload: {
      ...contribution,
      schemaVersion: "telemetry-contribution-invalid",
    },
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  expectErrorCode(
    (await upload(primary, JSON.stringify(invalidSchemaEnvelope))).result,
    400,
    "TELEMETRY_RECORD_INVALID",
    "Invalid-schema contribution",
  );

  const invalidTimestampContribution = structuredClone(contribution);
  invalidTimestampContribution.usageEvents[0].eventTime = new Date(
    Date.parse(contribution.coveredAt.startAt) - 1,
  ).toISOString();
  const invalidTimestampEnvelope = await createServerValidationProbe({
    payload: invalidTimestampContribution,
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  expectErrorCode(
    (await upload(primary, JSON.stringify(invalidTimestampEnvelope))).result,
    400,
    "TELEMETRY_RECORD_INVALID",
    "Out-of-range timestamp contribution",
  );

  const countLimitedContribution = structuredClone(contribution);
  const countProbeEvent = structuredClone(contribution.usageEvents[0]);
  countProbeEvent.accounting = {
    estimatedApiCostUsd: null,
    pricingCoveragePercent: 0,
    unknownBillableUnits: 0,
    priceBasis: "unpriced",
  };
  countLimitedContribution.usageEvents = Array.from({ length: 201 }, (_, index) => ({
    ...structuredClone(countProbeEvent),
    eventId: `event:v2:${index.toString(16).padStart(64, "0")}`,
  }));
  countLimitedContribution.accounting = {
    estimatedApiCostUsd: null,
    pricedEventCoveragePercent: 0,
    unknownModelEventCount: countProbeEvent.modelId === "unknown" ? 201 : 0,
    unknownBillableUnits: 0,
    priceBasis: "unpriced",
  };
  const countLimitedEnvelope = await createServerValidationProbe({
    payload: countLimitedContribution,
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  expectErrorCode(
    (await upload(primary, JSON.stringify(countLimitedEnvelope))).result,
    400,
    "TELEMETRY_RECORD_INVALID",
    "Over-count contribution",
  );

  const oversizedBody = JSON.stringify({
    padding: "x".repeat(2 * 1024 * 1024),
  });
  expectErrorCode(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: "Upload intentionally_invalid",
      body: oversizedBody,
    }),
    413,
    "BODY_TOO_LARGE",
    "Oversized contribution request",
  );

  const uploadOnlyPersonal = await request("/api/v1/me/export", {
    authorization: `Upload ${await registerDeviceUpload(device, serializedEnvelope)}`,
  });
  expectStatus(uploadOnlyPersonal, 401, "Upload-only personal read");

  const devices = expectStatus(
    await request("/api/v1/me/devices", { session: primary }),
    200,
    "Device list",
  );
  if (!Array.isArray(devices?.devices)
      || devices.devices.length !== 1
      || devices.devices[0]?.deviceId !== device.deviceId
      || devices.devices[0]?.state !== "active") {
    throw new Error("The personal device list did not expose the paired device.");
  }
  const pendingDeviceUpload = await registerDeviceUpload(device, serializedEnvelope);
  expectStatus(
    await request("/api/v1/me/devices/revoke", {
      method: "POST",
      session: primary,
      csrf: true,
      body: JSON.stringify({ deviceId: device.deviceId }),
    }),
    200,
    "Device revocation",
  );
  expectStatus(
    await request("/api/v1/device/upload-authorizations", {
      method: "POST",
      authorization: `Device ${device.authorization}`,
      body: JSON.stringify({
        envelopeDigest: sha256Hex(serializedEnvelope),
        contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
        contentType: "application/json",
      }),
    }),
    401,
    "Revoked device",
  );
  expectStatus(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${pendingDeviceUpload}`,
      body: serializedEnvelope,
    }),
    401,
    "Revoked device upload",
  );

  const expected = {
    usageEvents: contribution.usageEvents.length,
    quotaSnapshots: contribution.quotaSnapshots.length,
    activityMarkers: contribution.activityMarkers.length,
  };
  const expectedTotal = expected.usageEvents + expected.quotaSnapshots + expected.activityMarkers;
  for (let index = 1; index < COMMUNITY_SNAPSHOT_PARTICIPANTS; index += 1) {
    const cohortSession = await enrollParticipant(inviteCodes[index] ?? null);
    expectStatus(
      (await upload(cohortSession, serializedEnvelope)).result,
      202,
      "Cohort contribution upload",
    );
  }

  await triggerScheduledSnapshot(scheduledTime);
  const communityDay = contribution.coveredAt.endAt.slice(0, 10);
  const communityDaily = expectStatus(
    await request(
      `/api/v1/community/daily?from=${communityDay}&to=${communityDay}`,
    ),
    200,
    "Community daily output",
  );
  const serializedCommunityDaily = JSON.stringify(communityDaily);
  if (communityDaily.schemaVersion !== "community-daily-read-v1.0"
      || !Array.isArray(communityDaily.days)
      || ["participantId", "accountTrackId", "modelFingerprint"]
        .some((forbidden) => serializedCommunityDaily.includes(forbidden))) {
    throw new Error("The daily community output violated its public contract.");
  }

  const participantExport = expectStatus(
    await request("/api/v1/me/export", { session: primary }),
    200,
    "Participant export",
  );
  const serializedExport = JSON.stringify(participantExport);
  if (participantExport.contributions?.length !== 1
      || participantExport.contributions[0]?.records?.length !== expectedTotal
      || ["um_invite_", "um_session_", "um_recovery_", "um_upload_", "um_csrf_", "eligibility:", "grant_id"]
        .some((forbidden) => serializedExport.includes(forbidden))) {
    throw new Error("The participant export was incomplete or exposed private authority.");
  }

  for (const session of sessions) await ownerEraser.verifyParticipantRefusal(session);

  if (retainInspectionState) {
    await writeParticipantAccessFile(participantAccessFile, primary);
    preserveParticipants = true;
    process.stdout.write(`${JSON.stringify({
      status: "passed_inspectable",
      origin: origin.origin,
      enrollmentMode: health.enrollmentMode,
      participants: COMMUNITY_SNAPSHOT_PARTICIPANTS,
      acceptedRecordsPerParticipant: expectedTotal,
      idempotentReplay: true,
      uploadScopeConflictRejected: true,
      privacyCanaryRejected: true,
      invalidSchemaRejected: true,
      oversizedRequestRejected: true,
      overCountRejected: true,
      outOfRangeTimestampRejected: true,
      serverValidation: true,
      canonicalServerRepricing: true,
      communityDailyVerified: true,
      participantExportVerified: true,
      selfServiceDeletionRefused: true,
      participantStateUnchangedAfterRefusal: true,
      ownerAuthAndCsrfRequired: true,
      generatedContentFreeFixture: generatedFixture,
      authorityIsolation: true,
      devicePairingAndUpload: true,
      deviceRevocation: true,
      participantAccessFile,
      participantAccessFileContainsSecret: true,
      participantsRetainedForInspection: COMMUNITY_SNAPSHOT_PARTICIPANTS,
    }, null, 2)}\n`);
  } else {
  const replacementPairing = expectStatus(
    await request("/api/v1/me/device-pairings", {
      method: "POST",
      session: primary,
      csrf: true,
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      }),
    }),
    201,
    "Replacement device pairing",
  );
  primary.device = await pairDevice(primary, replacementPairing);
  const pendingUpload = await registerDeviceUpload(
    primary.device,
    serializedEnvelope,
  );
  const previousCsrfToken = primary.csrfToken;
  const reset = expectStatus(
    await request("/api/v1/me/security-reset", {
      method: "POST",
      session: primary,
      csrf: true,
      body: "{}",
    }),
    200,
    "Security reset",
  );
  if (reset.reset !== true || reset.csrfToken !== previousCsrfToken) {
    throw new Error("Security reset did not preserve the active session contract.");
  }
  primary.csrfToken = reset.csrfToken;
  expectStatus(
    await request("/api/v1/contributions", {
      method: "POST",
      body: serializedEnvelope,
      authorization: `Upload ${pendingUpload}`,
    }),
    401,
    "Pre-reset upload authority",
  );

  for (const session of sessions) {
    await ownerEraser.eraseParticipant(session, { expectedContributions: 1 });
  }
  const retriedErasure = await ownerEraser.eraseParticipant(primary, { retry: true });
  if (!retriedErasure.alreadyDeleted || retriedErasure.contributionsDeleted !== null) {
    throw new Error("Owner erasure retry did not preserve the ledger-proven unknown count.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    origin: origin.origin,
    enrollmentMode: health.enrollmentMode,
    participants: COMMUNITY_SNAPSHOT_PARTICIPANTS,
    acceptedRecordsPerParticipant: expectedTotal,
    idempotentReplay: true,
    uploadScopeConflictRejected: true,
    privacyCanaryRejected: true,
    invalidSchemaRejected: true,
    oversizedRequestRejected: true,
    overCountRejected: true,
    outOfRangeTimestampRejected: true,
    serverValidation: true,
    canonicalServerRepricing: true,
    communityDailyVerified: true,
    participantExportVerified: true,
    selfServiceDeletionRefused: true,
    participantStateUnchangedAfterRefusal: true,
    ownerAuthAndCsrfRequired: true,
    ownerErasureRetryVerified: true,
    generatedContentFreeFixture: generatedFixture,
    authorityIsolation: true,
    devicePairingAndUpload: true,
    deviceRevocation: true,
    securityResetRevokedUpload: true,
    participantsErasedByOwner: sessions.filter((session) => session.deleted).length,
  }, null, 2)}\n`);
  }
} finally {
  if (!preserveParticipants) {
    for (const session of sessions) await cleanupParticipant(session);
  }
  if (!preserveParticipants
      && sessions.some((session) => session.created && !session.deleted)) {
    process.stderr.write("Backend smoke cleanup was incomplete; inspect the isolated local D1/R2 state before reuse.\n");
    process.exitCode = 1;
  }
}
