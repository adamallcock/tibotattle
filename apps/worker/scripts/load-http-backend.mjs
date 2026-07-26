import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";
import {
  FULL_PROFILE,
  deriveLoadProfile,
  latencySummary,
  loopbackOrigin,
  mapConcurrent,
  readOwnerOnlyInvitation,
} from "./load-profile-lib.mjs";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const FIXED_FATAL_MESSAGE =
  "The backend load runner stopped at a fixed configuration or receipt boundary\n";
process.on("uncaughtException", () => {
  process.stderr.write(FIXED_FATAL_MESSAGE);
  process.exitCode = 1;
});
process.on("unhandledRejection", () => {
  process.stderr.write(FIXED_FATAL_MESSAGE);
  process.exitCode = 1;
});

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integerOption(name, fallback) {
  const raw = optionValue(name, String(fallback));
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`${name} requires a positive integer`);
  return Number(raw);
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

const profileOnly = process.argv.includes("--profile-only");
const allowFullProfile = process.argv.includes("--allow-full-profile") || profileOnly;
const defaults = profileOnly
  ? {
    participants: FULL_PROFILE.participants,
    attemptsPerParticipant: FULL_PROFILE.attemptsPerParticipant,
    recordsPerAttempt: FULL_PROFILE.recordsPerAttempt,
    concurrency: 25,
    hotParticipantCount: 0,
    hotAttemptsPerParticipant: FULL_PROFILE.attemptsPerParticipant,
    enrollmentSpacingMilliseconds: 3_100,
  }
  : {
    participants: 20,
    attemptsPerParticipant: 4,
    recordsPerAttempt: 50,
    concurrency: 8,
    hotParticipantCount: 2,
    hotAttemptsPerParticipant: 20,
    enrollmentSpacingMilliseconds: 0,
  };
const profile = deriveLoadProfile({
  participants: integerOption("--participants", defaults.participants),
  attemptsPerParticipant: integerOption(
    "--attempts-per-participant",
    defaults.attemptsPerParticipant,
  ),
  recordsPerAttempt: integerOption("--records-per-attempt", defaults.recordsPerAttempt),
  concurrency: integerOption("--concurrency", defaults.concurrency),
  hotParticipantCount: integerOption(
    "--hot-participant-count",
    defaults.hotParticipantCount,
  ),
  hotAttemptsPerParticipant: integerOption(
    "--hot-attempts-per-participant",
    defaults.hotAttemptsPerParticipant,
  ),
  requestTimeoutMilliseconds: integerOption("--request-timeout-ms", 30_000),
  enrollmentSpacingMilliseconds: integerOption(
    "--enrollment-spacing-ms",
    defaults.enrollmentSpacingMilliseconds,
  ),
  allowFullProfile,
});

if (profileOnly) {
  process.stdout.write(`${JSON.stringify({
    status: "profile",
    ...profile,
    executesNetworkRequests: false,
    literalFullProfileRequiresExplicitFlag: true,
  }, null, 2)}\n`);
  process.exit(0);
}

const origin = loopbackOrigin(optionValue("--origin", "http://127.0.0.1:8792"));
const exerciseAggregate = process.argv.includes("--exercise-aggregate");
const receiptFileValue = optionValue("--receipt-file");
const receiptFile = receiptFileValue ? resolve(receiptFileValue) : null;
const invitePaths = optionValues("--invite-file").map((value) => resolve(value));
if (invitePaths.length !== 0 && invitePaths.length !== profile.participants) {
  throw new Error("Pass exactly one owner-only invitation file per participant");
}
if (exerciseAggregate && invitePaths.length !== profile.participants) {
  throw new Error(
    "Aggregate load evidence requires independently issued owner-only invitations",
  );
}

class LoadFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LoadFailure";
    this.code = code;
  }
}

class Session {
  cookie = null;
  csrfToken = null;
  deleted = false;

  applyCookie(setCookie) {
    if (typeof setCookie !== "string") return;
    if (!setCookie.startsWith("__Host-usage_monitor_session=")
        || !setCookie.includes("Path=/")
        || !setCookie.includes("Secure")
        || !setCookie.includes("HttpOnly")
        || !setCookie.includes("SameSite=Strict")) {
      throw new LoadFailure("SESSION_COOKIE_INVALID");
    }
    this.cookie = setCookie.includes("Max-Age=0")
      ? null
      : setCookie.split(";", 1)[0] ?? null;
  }
}

const sessions = [];
const latencies = {
  enrollment: [],
  registration: [],
  upload: [],
  privateResults: [],
  deletion: [],
  scheduledRebuild: [],
};
const failureCounts = new Map();
const counters = {
  enrollments: 0,
  uploadRegistrations: 0,
  uploads: 0,
  contributionRows: 0,
  acceptedRecords: 0,
  deduplicatedRecords: 0,
  participantResults: 0,
  participantsDeleted: 0,
};

function recordFailure(error) {
  const code = error instanceof LoadFailure ? error.code : "UNEXPECTED_CLIENT_FAILURE";
  failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventId(index) {
  return `event:v2:${sha256Hex(`usage-monitor/backend-load-profile/v0.1/${index}`)}`;
}

function contributionForAttempt(attempt, recordsPerAttempt, baseEpoch) {
  const usageEvents = Array.from({ length: recordsPerAttempt }, (_, index) => {
    const eventTime = new Date(baseEpoch + index * 1_000).toISOString();
    return {
      schemaVersion: "usage-event-v0.1",
      eventTime,
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "standard",
      apiServiceTier: "standard",
      reasoningEffort: "medium",
      components: {
        inputUncachedTokens: 100 + index,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 50,
        outputReasoningTokens: 25,
        outputCombinedTokens: null,
      },
      totalInputContextTokens: 1_000 + index,
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
      eventId: eventId(index),
      accounting: {
        estimatedApiCostUsd: "0.000100",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    };
  });
  const createdAt = new Date(baseEpoch + 10 * 60 * 1_000 + attempt * 1_000).toISOString();
  const estimatedApiCostUsd = (recordsPerAttempt * 0.0001).toFixed(6);
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt,
    coveredAt: {
      startAt: usageEvents[0].eventTime,
      endAt: usageEvents[usageEvents.length - 1].eventTime,
    },
    clientPlatform: "other",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents,
    quotaSnapshots: [],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd,
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

async function timed(stage, operation) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    latencies[stage].push(Number((performance.now() - started).toFixed(3)));
  }
}

async function request(path, {
  method = "GET",
  session = null,
  body = null,
  csrf = false,
  authorization = null,
  expectStatus = 200,
  cachePolicy = true,
} = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (authorization) headers.Authorization = authorization;
  if (body !== null) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Origin = origin.origin;
  if (csrf) {
    headers["X-Usage-Monitor-CSRF"] = session?.csrfToken ?? "";
  }
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(profile.requestTimeoutMilliseconds),
    });
  } catch {
    throw new LoadFailure("REQUEST_TRANSPORT_FAILED");
  }
  if (response.status !== expectStatus) {
    const observedStatus = [
      400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504,
    ].includes(response.status) ? response.status : "OTHER";
    throw new LoadFailure(
      `HTTP_${expectStatus}_EXPECTED_${observedStatus}_RECEIVED`,
    );
  }
  if (cachePolicy && response.headers.get("cache-control") !== "no-store") {
    throw new LoadFailure("CACHE_POLICY_INVALID");
  }
  if (session) session.applyCookie(response.headers.get("set-cookie"));
  try {
    return await response.json();
  } catch {
    throw new LoadFailure("RESPONSE_JSON_INVALID");
  }
}

async function enroll(inviteCode = null) {
  const session = new Session();
  const body = {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
  };
  if (inviteCode) body.inviteCode = inviteCode;
  const result = await timed("enrollment", () => request("/api/v1/enroll", {
    method: "POST",
    session,
    body: JSON.stringify(body),
    expectStatus: 201,
  }));
  if (typeof result?.csrfToken !== "string"
      || typeof result?.recoveryCode !== "string"
      || typeof result?.participantId !== "string"
      || !session.cookie) {
    throw new LoadFailure("ENROLLMENT_CONTRACT_INVALID");
  }
  session.csrfToken = result.csrfToken;
  sessions.push(session);
  counters.enrollments += 1;
  return session;
}

async function registerUpload(session, serializedEnvelope) {
  const result = await timed("registration", () => request(
    "/api/v1/me/upload-authorizations",
    {
      method: "POST",
      session,
      csrf: true,
      body: JSON.stringify({
        envelopeDigest: sha256Hex(serializedEnvelope),
        contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
        contentType: "application/json",
      }),
      expectStatus: 201,
    },
  ));
  if (typeof result?.uploadAuthorization !== "string"
      || !result.uploadAuthorization.startsWith("um_upload_")) {
    throw new LoadFailure("UPLOAD_REGISTRATION_CONTRACT_INVALID");
  }
  counters.uploadRegistrations += 1;
  return result.uploadAuthorization;
}

async function upload(session, serializedEnvelope, expectedAccepted) {
  const authorization = await registerUpload(session, serializedEnvelope);
  const result = await timed("upload", () => request("/api/v1/contributions", {
    method: "POST",
    body: serializedEnvelope,
    authorization: `Upload ${authorization}`,
    expectStatus: 202,
  }));
  const accepted = result?.recordCounts?.accepted;
  const deduplicated = result?.recordCounts?.deduplicated;
  if (accepted !== expectedAccepted
      || deduplicated !== profile.recordsPerAttempt - expectedAccepted
      || typeof result?.contributionId !== "string") {
    throw new LoadFailure("UPLOAD_RESULT_CONTRACT_INVALID");
  }
  counters.uploads += 1;
  counters.contributionRows += result.replayed === true ? 0 : 1;
  counters.acceptedRecords += accepted;
  counters.deduplicatedRecords += deduplicated;
}

async function verifyPrivateResults(session, expectedContributions) {
  const [stats, participant] = await timed("privateResults", () => Promise.all([
    request("/api/v1/me/stats", { session }),
    request("/api/v1/me", { session }),
  ]));
  if (stats?.totals?.contributions !== expectedContributions
      || stats?.totals?.usageEvents !== profile.recordsPerAttempt
      || participant?.schemaVersion !== "participant-profile-v0.2"
      || participant?.contributionCount !== expectedContributions
      || !Array.isArray(participant?.contributions)
      || participant.contributions.length !== expectedContributions) {
    throw new LoadFailure("PRIVATE_RESULTS_CONTRACT_INVALID");
  }
  counters.participantResults += 1;
}

async function deleteParticipant(session) {
  if (session.deleted || !session.cookie || !session.csrfToken) return;
  const result = await timed("deletion", () => request("/api/v1/me", {
    method: "DELETE",
    session,
    csrf: true,
  }));
  if (result?.deleted !== true) throw new LoadFailure("DELETION_CONTRACT_INVALID");
  session.deleted = true;
  counters.participantsDeleted += 1;
}

function scheduledSnapshotTime(baseEpoch) {
  const first = new Date(baseEpoch);
  first.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (first.getUTCDay() + 6) % 7;
  return first.getTime() - daysSinceMonday * DAY_MILLISECONDS
    + 9 * DAY_MILLISECONDS;
}

async function triggerScheduledSnapshot(scheduledTime) {
  const url = new URL("/cdn-cgi/handler/scheduled", origin);
  url.searchParams.set("format", "json");
  url.searchParams.set("time", String(scheduledTime));
  const result = await timed("scheduledRebuild", async () => {
    let response;
    try {
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(profile.requestTimeoutMilliseconds),
      });
    } catch {
      throw new LoadFailure("SCHEDULED_TRIGGER_TRANSPORT_FAILED");
    }
    if (!response.ok) throw new LoadFailure("SCHEDULED_TRIGGER_FAILED");
    try {
      return await response.json();
    } catch {
      throw new LoadFailure("SCHEDULED_TRIGGER_JSON_INVALID");
    }
  });
  if (result?.outcome !== "ok") throw new LoadFailure("SCHEDULED_TRIGGER_CONTRACT_INVALID");
}

async function prepareEnvelopes(publicJwk, keyId, maximumAttempts, baseEpoch) {
  const envelopes = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const contribution = contributionForAttempt(
      attempt,
      profile.recordsPerAttempt,
      baseEpoch,
    );
    validateTelemetryContribution(contribution);
    const envelope = await createTelemetryEnvelope({ payload: contribution, publicJwk, keyId });
    envelopes.push(JSON.stringify(envelope));
  }
  return envelopes;
}

async function runParticipant(session, index, envelopes) {
  try {
    const attempts = index < profile.hotParticipantCount
      ? profile.hotAttemptsPerParticipant
      : profile.attemptsPerParticipant;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await upload(
        session,
        envelopes[attempt],
        attempt === 0 ? profile.recordsPerAttempt : 0,
      );
    }
    await verifyPrivateResults(session, attempts);
    return true;
  } catch (error) {
    recordFailure(error);
    return false;
  }
}

async function enrollCohort() {
  const indices = Array.from({ length: profile.participants }, (_, index) => index);
  let inviteCodes;
  try {
    inviteCodes = invitePaths.map(readOwnerOnlyInvitation);
  } catch {
    throw new LoadFailure("INVITATION_FILE_INVALID");
  }
  if (profile.enrollmentSpacingMilliseconds === 0) {
    return mapConcurrent(indices, profile.concurrency, async (_value, index) => {
      try {
        return await enroll(inviteCodes[index] ?? null);
      } catch (error) {
        recordFailure(error);
        return null;
      }
    });
  }
  const enrolled = [];
  for (const index of indices) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        profile.enrollmentSpacingMilliseconds,
      ));
    }
    try {
      enrolled.push(await enroll(inviteCodes[index] ?? null));
    } catch (error) {
      recordFailure(error);
      enrolled.push(null);
    }
  }
  return enrolled;
}

async function cleanupParticipants() {
  await mapConcurrent(sessions, profile.concurrency, async (session) => {
    try {
      await deleteParticipant(session);
    } catch (error) {
      recordFailure(error);
    }
  });
}

const startedAt = new Date().toISOString();
const started = performance.now();
let aggregateEvidence = {
  exercised: false,
  initialReleaseStatus: null,
  initialRevision: null,
  afterMassDeletionStatus: null,
  afterMassDeletionRevision: null,
  afterFullDeletionStatus: null,
  afterFullDeletionRevision: null,
};
let scheduledSnapshotEpoch = null;

try {
  const health = await request("/api/health");
  const expectedEnrollmentMode = invitePaths.length > 0 ? "invite_only" : "local_open";
  if (health?.enrollmentMode !== expectedEnrollmentMode) {
    throw new LoadFailure("ENROLLMENT_MODE_MISMATCH");
  }
  const key = await request("/api/v1/envelope-key");
  if (typeof key?.keyId !== "string" || typeof key?.publicJwk !== "object") {
    throw new LoadFailure("ENVELOPE_KEY_CONTRACT_INVALID");
  }
  const baseEpoch = Date.now() - 15 * 60 * 1_000;
  const maximumAttempts = Math.max(
    profile.attemptsPerParticipant,
    profile.hotAttemptsPerParticipant,
  );
  const envelopes = await prepareEnvelopes(
    key.publicJwk,
    key.keyId,
    maximumAttempts,
    baseEpoch,
  );
  const enrolled = await enrollCohort();
  if (enrolled.some((session) => session === null) || failureCounts.size > 0) {
    throw new LoadFailure("ENROLLMENT_PHASE_FAILED");
  }
  const outcomes = await mapConcurrent(
    enrolled,
    profile.concurrency,
    (session, index) => runParticipant(session, index, envelopes),
  );
  if (outcomes.some((outcome) => outcome !== true) || failureCounts.size > 0) {
    throw new LoadFailure("PARTICIPANT_WORKLOAD_FAILED");
  }

  if (exerciseAggregate) {
    if (profile.participants < 20) throw new LoadFailure("AGGREGATE_REQUIRES_20_PARTICIPANTS");
    scheduledSnapshotEpoch = scheduledSnapshotTime(baseEpoch);
    await triggerScheduledSnapshot(scheduledSnapshotEpoch);
    const initial = await request("/api/v1/stats/aggregate");
    if (initial?.releaseStatus !== "published" || !Array.isArray(initial?.cells)) {
      throw new LoadFailure("INITIAL_AGGREGATE_NOT_PUBLISHED");
    }
    const initialRevision = initial.snapshotRevision;
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 1) {
      throw new LoadFailure("INITIAL_AGGREGATE_REVISION_INVALID");
    }
    const massDeleteCount = Math.max(1, Math.ceil(profile.participants / 10));
    await mapConcurrent(
      sessions.slice(0, massDeleteCount),
      profile.concurrency,
      async (session) => {
        try {
          await deleteParticipant(session);
        } catch (error) {
          recordFailure(error);
        }
      },
    );
    if (failureCounts.size > 0) throw new LoadFailure("MASS_DELETION_FAILED");
    const withdrawn = await request("/api/v1/stats/aggregate");
    if (withdrawn?.releaseStatus !== "withdrawn") {
      throw new LoadFailure("AGGREGATE_NOT_WITHDRAWN");
    }
    await triggerScheduledSnapshot(scheduledSnapshotEpoch + 60 * 60 * 1_000);
    const rebuilt = await request("/api/v1/stats/aggregate");
    const expectedRebuiltStatus = profile.participants - massDeleteCount >= 20
      ? "published"
      : "suppressed";
    if (rebuilt?.releaseStatus !== expectedRebuiltStatus
        || rebuilt?.snapshotRevision !== initialRevision + 1) {
      throw new LoadFailure("MASS_DELETION_REBUILD_INVALID");
    }
    aggregateEvidence = {
      exercised: true,
      initialReleaseStatus: initial.releaseStatus,
      initialRevision,
      afterMassDeletionStatus: rebuilt.releaseStatus,
      afterMassDeletionRevision: rebuilt.snapshotRevision,
      afterFullDeletionStatus: null,
      afterFullDeletionRevision: null,
    };
  }
} catch (error) {
  recordFailure(error);
} finally {
  await cleanupParticipants();
}

if (exerciseAggregate && aggregateEvidence.exercised && failureCounts.size === 0) {
  try {
    await triggerScheduledSnapshot(scheduledSnapshotEpoch + 2 * 60 * 60 * 1_000);
    const finalAggregate = await request("/api/v1/stats/aggregate");
    if (finalAggregate?.releaseStatus !== "suppressed"
        || finalAggregate?.snapshotRevision !== aggregateEvidence.initialRevision + 2) {
      throw new LoadFailure("FULL_DELETION_REBUILD_INVALID");
    }
    aggregateEvidence.afterFullDeletionStatus = finalAggregate.releaseStatus;
    aggregateEvidence.afterFullDeletionRevision = finalAggregate.snapshotRevision;
  } catch (error) {
    recordFailure(error);
  }
}

const elapsedMilliseconds = Number((performance.now() - started).toFixed(3));
const failed = failureCounts.size > 0
  || counters.enrollments !== profile.participants
  || counters.uploads !== profile.bundleAttempts
  || counters.participantsDeleted !== counters.enrollments;
const receipt = {
  schemaVersion: "backend-load-receipt-v0.1",
  status: failed ? "failed" : "passed",
  startedAt,
  completedAt: new Date().toISOString(),
  originClass: "loopback_http",
  workload: profile,
  counters,
  aggregateEvidence,
  elapsedMilliseconds,
  throughput: {
    bundleAttemptsPerSecond: elapsedMilliseconds > 0
      ? Number((counters.uploads / (elapsedMilliseconds / 1_000)).toFixed(3))
      : null,
    expandedRecordsPerSecond: elapsedMilliseconds > 0
      ? Number(((counters.uploads * profile.recordsPerAttempt)
        / (elapsedMilliseconds / 1_000)).toFixed(3))
      : null,
  },
  latency: Object.fromEntries(
    Object.entries(latencies).map(([stage, values]) => [stage, latencySummary(values)]),
  ),
  failures: [...failureCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count })),
  privacy: {
    contentFreeFixture: true,
    aggregateOnlyDiagnostics: true,
    credentialsPrinted: false,
    participantIdentifiersPrinted: false,
    responseBodiesPrinted: false,
    independentInvitationEligibility: invitePaths.length === profile.participants,
  },
  fullProfileClaim: profile.fullProfileSatisfied && !failed,
};
const serializedReceipt = `${JSON.stringify(receipt, null, 2)}\n`;
if (receiptFile) {
  let descriptor;
  try {
    descriptor = openSync(receiptFile, "wx", 0o600);
    writeFileSync(descriptor, serializedReceipt, { encoding: "utf8" });
    fsyncSync(descriptor);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new LoadFailure("RECEIPT_WRITE_FAILED");
  }
  closeSync(descriptor);
}
process.stdout.write(serializedReceipt);
if (failed) process.exitCode = 1;
