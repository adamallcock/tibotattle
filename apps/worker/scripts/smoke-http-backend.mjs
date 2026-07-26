import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";

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
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
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
    this.created = false;
    this.deleted = false;
  }

  applyCookie(setCookie) {
    if (!setCookie) return;
    assertSessionCookie(setCookie, { cleared: setCookie.includes("Max-Age=0") });
    this.cookie = setCookie.includes("Max-Age=0") ? null : cookiePair(setCookie);
  }
}

const origin = boundedOrigin(optionValue("--origin", "http://127.0.0.1:8792"));
const contributionPathValue = optionValue("--file");
if (!contributionPathValue) {
  throw new Error("--file is required and must name a prepared telemetry-contribution-v0.1 JSON file.");
}
const contributionPath = resolve(contributionPathValue);
const invitePaths = optionValues("--invite-file").map((value) => resolve(value));
const sessions = [];
const COMMUNITY_SNAPSHOT_PARTICIPANTS = 20;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

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
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body,
    redirect: "error",
  });
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error(`The backend returned an unexpected cache policy for ${method} ${path}.`);
  }
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

async function enrollParticipant(inviteCode = null) {
  const session = new ParticipantSession();
  const body = {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
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
      || Object.hasOwn(enrollment, "accessToken")
      || !session.cookie) {
    throw new Error("Enrollment did not establish the bounded session contract.");
  }
  session.csrfToken = enrollment.csrfToken;
  session.recoveryCode = enrollment.recoveryCode;
  session.created = true;
  sessions.push(session);

  const probe = expectStatus(
    await request("/api/v1/session", { session }),
    200,
    "Session probe",
  );
  if (probe.csrfToken !== session.csrfToken) {
    throw new Error("The session probe did not preserve its CSRF binding.");
  }
  return session;
}

async function registerUpload(session, serializedEnvelope) {
  const body = JSON.stringify({
    envelopeDigest: sha256Hex(serializedEnvelope),
    contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
    contentType: "application/json",
  });
  const result = await request("/api/v1/me/upload-authorizations", {
    method: "POST",
    session,
    csrf: true,
    body,
  });
  const registration = expectStatus(result, 201, "Upload registration");
  if (typeof registration?.uploadAuthorization !== "string"
      || !registration.uploadAuthorization.startsWith("um_upload_")) {
    throw new Error("The upload registration did not return a one-use authority.");
  }
  return registration.uploadAuthorization;
}

async function pairDevice(session) {
  const pairing = expectStatus(
    await request("/api/v1/me/device-pairings", {
      method: "POST",
      session,
      csrf: true,
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      }),
    }),
    201,
    "Device pairing",
  );
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
  const authorization = await registerUpload(session, serializedEnvelope);
  const result = await request("/api/v1/contributions", {
    method: "POST",
    body: serializedEnvelope,
    authorization: `Upload ${authorization}`,
  });
  return { authorization, result };
}

async function recover(session) {
  const oldRecoveryCode = session.recoveryCode;
  const recoveryAttemptId = `um_recovery_attempt_${randomBytes(32).toString("base64url")}`;
  const recovered = await request("/api/v1/recover", {
    method: "POST",
    session,
    body: JSON.stringify({ recoveryCode: oldRecoveryCode, recoveryAttemptId }),
    originValue: origin.origin,
  });
  const value = expectStatus(recovered, 200, "Recovery");
  if (typeof value?.csrfToken !== "string"
      || typeof value?.recoveryCode !== "string"
      || value.recoveryCode === oldRecoveryCode) {
    throw new Error("Recovery did not rotate both session and recovery authority.");
  }
  session.csrfToken = value.csrfToken;
  session.recoveryCode = value.recoveryCode;
  session.lastRecoveryAttemptId = recoveryAttemptId;
  return oldRecoveryCode;
}

async function cleanupParticipant(session) {
  if (!session.created || session.deleted) return;
  if (!session.cookie && session.recoveryCode) {
    try {
      await recover(session);
    } catch {
      return;
    }
  }
  if (!session.cookie || !session.csrfToken) return;
  try {
    const deletion = await request("/api/v1/me", {
      method: "DELETE",
      session,
      csrf: true,
    });
    if (deletion.response.ok) session.deleted = true;
  } catch {
    // The fixed warning below contains no participant or authority value.
  }
}

try {
  const health = expectStatus(await request("/api/health"), 200, "Health");
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

  const contributionText = await ownerOnlyFile(contributionPath, "Contribution file");
  const contribution = JSON.parse(contributionText);
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

  const primary = await enrollParticipant(inviteCodes[0] ?? null);

  const missingCsrf = await request("/api/v1/me/upload-authorizations", {
    method: "POST",
    session: primary,
    body: JSON.stringify({
      envelopeDigest: sha256Hex(serializedEnvelope),
      contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
      contentType: "application/json",
    }),
  });
  expectStatus(missingCsrf, 403, "Missing-CSRF registration");

  const sessionOnlyUpload = await request("/api/v1/contributions", {
    method: "POST",
    session: primary,
    body: serializedEnvelope,
  });
  expectStatus(sessionOnlyUpload, 401, "Session-only upload");

  const device = await pairDevice(primary);
  const first = await uploadFromDevice(device, serializedEnvelope);
  const accepted = expectStatus(first.result, 202, "Contribution upload");
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

  const uploadOnlyPersonal = await request("/api/v1/me/stats", {
    authorization: `Upload ${await registerUpload(primary, serializedEnvelope)}`,
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
  const contributionStatus = expectStatus(
    await request("/api/v1/me/contributions/read", {
      method: "POST",
      session: primary,
      csrf: true,
      body: JSON.stringify({ contributionId: accepted.contributionId }),
    }),
    200,
    "Contribution status",
  );
  const personal = expectStatus(
    await request("/api/v1/me/stats", { session: primary }),
    200,
    "Personal statistics",
  );
  const unavailable = expectStatus(
    await request("/api/v1/stats/aggregate"),
    200,
    "Unavailable aggregate snapshot",
  );
  if (contributionStatus.recordCounts?.accepted !== expectedTotal
      || personal.totals?.usageEvents !== expected.usageEvents
      || personal.totals?.quotaSnapshots !== expected.quotaSnapshots
      || personal.totals?.activityMarkers !== expected.activityMarkers
      || unavailable.releaseStatus !== "not_yet_published"
      || unavailable.immutable !== true
      || unavailable.nonOverlapping !== true
      || Object.hasOwn(unavailable, "participantCount")) {
    throw new Error("Initial ingest and recomputed statistics did not match the contribution.");
  }

  for (let index = 1; index < COMMUNITY_SNAPSHOT_PARTICIPANTS; index += 1) {
    const cohortSession = await enrollParticipant(inviteCodes[index] ?? null);
    expectStatus(
      (await upload(cohortSession, serializedEnvelope)).result,
      202,
      "Cohort contribution upload",
    );
  }

  await triggerScheduledSnapshot(scheduledTime);
  const aggregateResult = await request("/api/v1/stats/aggregate");
  const aggregate = expectStatus(
    aggregateResult,
    200,
    "Published aggregate snapshot",
  );
  const aggregateAliasResult = await request("/api/v1/community/insights");
  const aggregateAlias = expectStatus(
    aggregateAliasResult,
    200,
    "Published aggregate snapshot alias",
  );
  const serializedAggregate = JSON.stringify(aggregate);
  if (aggregate.releaseStatus !== "published"
      || aggregate.immutable !== true
      || aggregate.nonOverlapping !== true
      || !Array.isArray(aggregate.cells)
      || aggregate.cells.length < 1
      || aggregateResult.text !== aggregateAliasResult.text
      || JSON.stringify(aggregateAlias) !== serializedAggregate
      || ["participantCount", "participantId", "modelFingerprint", "estimatedApiCostUsd"]
        .some((forbidden) => serializedAggregate.includes(forbidden))) {
    throw new Error(
      `${COMMUNITY_SNAPSHOT_PARTICIPANTS} distinct participants did not produce`
      + " a stable privacy-safe snapshot.",
    );
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

  const oldCookie = primary.cookie;
  const oldRecoveryCode = await recover(primary);
  const replacementCookie = primary.cookie;
  const replacementCsrf = primary.csrfToken;
  const replacementRecovery = primary.recoveryCode;
  const oldSession = new ParticipantSession();
  oldSession.cookie = oldCookie;
  expectStatus(
    await request("/api/v1/me/stats", { session: oldSession }),
    401,
    "Pre-recovery session",
  );
  for (let retryNumber = 1; retryNumber <= 2; retryNumber += 1) {
    const retrySession = new ParticipantSession();
    const retried = expectStatus(
      await request("/api/v1/recover", {
        method: "POST",
        session: retrySession,
        body: JSON.stringify({
          recoveryCode: oldRecoveryCode,
          recoveryAttemptId: primary.lastRecoveryAttemptId,
        }),
        originValue: origin.origin,
      }),
      200,
      `Lost-response recovery retry ${retryNumber}`,
    );
    if (retrySession.cookie !== replacementCookie
        || retried.csrfToken !== replacementCsrf
        || retried.recoveryCode !== replacementRecovery) {
      throw new Error("A lost-response recovery retry changed replacement authority.");
    }
  }
  expectStatus(
    await request("/api/v1/recover", {
      method: "POST",
      body: JSON.stringify({
        recoveryCode: oldRecoveryCode,
        recoveryAttemptId: primary.lastRecoveryAttemptId,
      }),
      originValue: origin.origin,
    }),
    401,
    "Exhausted recovery retry",
  );

  const pendingUpload = await registerUpload(primary, serializedEnvelope);
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
  if (typeof reset.recoveryCode !== "string" || reset.recoveryCode === primary.recoveryCode) {
    throw new Error("Security reset did not rotate the recovery authority.");
  }
  primary.recoveryCode = reset.recoveryCode;
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

  const logout = await request("/api/v1/logout", {
    method: "POST",
    session: primary,
    csrf: true,
    body: "{}",
  });
  expectStatus(logout, 200, "Logout");
  assertSessionCookie(logout.response.headers.get("set-cookie"), { cleared: true });
  if (primary.cookie !== null) throw new Error("Logout did not clear the local cookie jar.");
  await recover(primary);

  const contributionDeletion = expectStatus(
    await request("/api/v1/me/contributions/delete", {
      method: "POST",
      session: primary,
      csrf: true,
      body: JSON.stringify({ contributionId: accepted.contributionId }),
    }),
    200,
    "Contribution deletion",
  );
  if (contributionDeletion.deleted !== true) {
    throw new Error("Contribution deletion did not complete.");
  }
  const withdrawn = expectStatus(
    await request("/api/v1/stats/aggregate"),
    200,
    "Withdrawn aggregate snapshot",
  );
  const serializedWithdrawn = JSON.stringify(withdrawn);
  if (withdrawn.releaseStatus !== "withdrawn"
      || withdrawn.immutable !== true
      || withdrawn.nonOverlapping !== true
      || ["cells", "participantCount", "participantId", "modelFingerprint"]
        .some((forbidden) => serializedWithdrawn.includes(forbidden))) {
    throw new Error("Contribution deletion did not withdraw the published snapshot safely.");
  }

  for (const [index, session] of sessions.entries()) {
    const deletion = expectStatus(
      await request("/api/v1/me", {
        method: "DELETE",
        session,
        csrf: true,
      }),
      200,
      "Participant deletion",
    );
    const expectedDeletedContributions = index === 0 ? 0 : 1;
    if (deletion.deleted !== true
        || deletion.contributionsDeleted !== expectedDeletedContributions) {
      throw new Error("Participant deletion did not remove the expected contribution.");
    }
    session.deleted = true;
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    origin: origin.origin,
    enrollmentMode: health.enrollmentMode,
    participants: COMMUNITY_SNAPSHOT_PARTICIPANTS,
    acceptedRecordsPerParticipant: expectedTotal,
    idempotentReplay: true,
    personalStatisticsRecomputed: true,
    aggregateUnavailableBeforeSchedule: true,
    aggregatePublishedAtTwenty: true,
    aggregateStoredBytesStableAcrossAliases: true,
    aggregateWithdrawnOnContributionDeletion: true,
    authorityIsolation: true,
    devicePairingAndUpload: true,
    deviceRevocation: true,
    recoveryRotated: true,
    securityResetRevokedUpload: true,
    logoutClearedCookie: true,
    participantsDeleted: COMMUNITY_SNAPSHOT_PARTICIPANTS,
  }, null, 2)}\n`);
} finally {
  for (const session of sessions) await cleanupParticipant(session);
  if (sessions.some((session) => session.created && !session.deleted)) {
    process.stderr.write("Backend smoke cleanup was incomplete; inspect the isolated local D1/R2 state before reuse.\n");
  }
}
