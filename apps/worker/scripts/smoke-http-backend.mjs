import { createHash, randomBytes } from "node:crypto";
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
  return { response, value };
}

function expectStatus(result, status, label) {
  if (result.response.status !== status) {
    throw new Error(`${label} returned ${result.response.status}; expected ${status}.`);
  }
  return result.value;
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
  if (health.enrollmentMode === "invite_only" && invitePaths.length !== 3) {
    throw new Error("Invite-only aggregate smoke requires exactly three repeated --invite-file arguments.");
  }
  if (health.enrollmentMode === "local_open" && invitePaths.length !== 0) {
    throw new Error("Do not pass invitation files to a local-open smoke.");
  }

  const contributionText = await ownerOnlyFile(contributionPath, "Contribution file");
  const contribution = JSON.parse(contributionText);
  validateTelemetryContribution(contribution);
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

  const first = await upload(primary, serializedEnvelope);
  const accepted = expectStatus(first.result, 202, "Contribution upload");
  const reusedUpload = await request("/api/v1/contributions", {
    method: "POST",
    body: serializedEnvelope,
    authorization: `Upload ${first.authorization}`,
  });
  expectStatus(reusedUpload, 401, "Reused upload authority");

  const replay = expectStatus(
    (await upload(primary, serializedEnvelope)).result,
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

  const expected = {
    usageEvents: contribution.usageEvents.length,
    quotaSnapshots: contribution.quotaSnapshots.length,
    activityMarkers: contribution.activityMarkers.length,
  };
  const expectedTotal = expected.usageEvents + expected.quotaSnapshots + expected.activityMarkers;
  const contributionStatus = expectStatus(
    await request(
      `/api/v1/contributions/${encodeURIComponent(accepted.contributionId)}`,
      { session: primary },
    ),
    200,
    "Contribution status",
  );
  const personal = expectStatus(
    await request("/api/v1/me/stats", { session: primary }),
    200,
    "Personal statistics",
  );
  const suppressed = expectStatus(
    await request("/api/v1/stats/aggregate"),
    200,
    "Suppressed aggregate statistics",
  );
  if (contributionStatus.recordCounts?.accepted !== expectedTotal
      || personal.totals?.usageEvents !== expected.usageEvents
      || personal.totals?.quotaSnapshots !== expected.quotaSnapshots
      || personal.totals?.activityMarkers !== expected.activityMarkers
      || suppressed.suppressed !== true
      || suppressed.participantCount !== 1) {
    throw new Error("Initial ingest and recomputed statistics did not match the contribution.");
  }

  for (let index = 1; index < 3; index += 1) {
    const cohortSession = await enrollParticipant(inviteCodes[index] ?? null);
    expectStatus(
      (await upload(cohortSession, serializedEnvelope)).result,
      202,
      "Cohort contribution upload",
    );
  }

  const aggregate = expectStatus(
    await request("/api/v1/stats/aggregate"),
    200,
    "Eligible aggregate statistics",
  );
  if (aggregate.suppressed !== false || aggregate.participantCount !== 3) {
    throw new Error("Three distinct participants did not unlock the aggregate result.");
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

  for (const session of sessions) {
    const deletion = expectStatus(
      await request("/api/v1/me", {
        method: "DELETE",
        session,
        csrf: true,
      }),
      200,
      "Participant deletion",
    );
    if (deletion.deleted !== true || deletion.contributionsDeleted !== 1) {
      throw new Error("Participant deletion did not remove the expected contribution.");
    }
    session.deleted = true;
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    origin: origin.origin,
    enrollmentMode: health.enrollmentMode,
    participants: 3,
    acceptedRecordsPerParticipant: expectedTotal,
    idempotentReplay: true,
    personalStatisticsRecomputed: true,
    aggregateSuppressedAtOne: true,
    aggregateDevelopmentAvailableAtThree: true,
    authorityIsolation: true,
    recoveryRotated: true,
    securityResetRevokedUpload: true,
    logoutClearedCookie: true,
    participantsDeleted: 3,
  }, null, 2)}\n`);
} finally {
  for (const session of sessions) await cleanupParticipant(session);
  if (sessions.some((session) => session.created && !session.deleted)) {
    process.stderr.write("Backend smoke cleanup was incomplete; inspect the isolated local D1/R2 state before reuse.\n");
  }
}
