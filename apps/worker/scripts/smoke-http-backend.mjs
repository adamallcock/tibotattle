import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";
import { CommunityClient } from "../../web/public/data-client.js";

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
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
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file.`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must be owner-only (mode 0600).`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

const origin = boundedOrigin(optionValue("--origin", "http://127.0.0.1:8792"));
const contributionPathValue = optionValue("--file");
if (!contributionPathValue) {
  throw new Error("--file is required and must name a prepared telemetry-contribution-v0.1 JSON file.");
}
const contributionPath = resolve(contributionPathValue);
const invitePathValue = optionValue("--invite-file");
const invitePath = invitePathValue ? resolve(invitePathValue) : null;

let accessToken = null;
let participantCreated = false;
let deleted = false;
const fetchImpl = (input, init) => fetch(new URL(input, origin), init);
const client = new CommunityClient({
  fetchImpl,
  getAccessToken: () => accessToken,
});

try {
  const health = await client.health();
  if (!["local_open", "invite_only", "disabled"].includes(health?.enrollmentMode)) {
    throw new Error("The service returned an invalid enrollment mode.");
  }
  if (health.enrollmentMode === "disabled") {
    throw new Error("Enrollment is disabled.");
  }
  if (health.enrollmentMode === "invite_only" && !invitePath) {
    throw new Error("This service is invite-only; pass an owner-only --invite-file.");
  }

  const contributionText = await ownerOnlyFile(contributionPath, "Contribution file");
  const contribution = JSON.parse(contributionText);
  validateTelemetryContribution(contribution);

  const inviteCode = invitePath
    ? (await ownerOnlyFile(invitePath, "Invitation file")).trim()
    : null;
  const enrollment = await client.enroll(inviteCode);
  accessToken = enrollment.accessToken;
  participantCreated = true;
  if (typeof accessToken !== "string" || typeof enrollment.recoveryCode !== "string") {
    throw new Error("Enrollment did not return both participant capabilities.");
  }

  const envelopeKey = await client.envelopeKey();
  const envelope = await createTelemetryEnvelope({
    payload: contribution,
    publicJwk: envelopeKey.publicJwk,
    keyId: envelopeKey.keyId,
  });
  const accepted = await client.contribute(envelope);
  const replay = await client.contribute(envelope);
  const contributionStatus = await client.contribution(accepted.contributionId);
  const personal = await client.personalStats();
  const community = await client.communityStats();
  const participantExport = await client.participantExport();
  const serializedExport = JSON.stringify(participantExport);
  const expected = {
    usageEvents: contribution.usageEvents.length,
    quotaSnapshots: contribution.quotaSnapshots.length,
    activityMarkers: contribution.activityMarkers.length,
  };
  const expectedTotal = expected.usageEvents + expected.quotaSnapshots + expected.activityMarkers;

  if (accepted.status !== "accepted" || replay.status !== "accepted"
      || replay.replayed !== true
      || replay.contributionId !== accepted.contributionId
      || contributionStatus.contributionId !== accepted.contributionId
      || contributionStatus.status !== "accepted"
      || accepted.recordCounts?.usageEvents !== expected.usageEvents
      || accepted.recordCounts?.quotaSnapshots !== expected.quotaSnapshots
      || accepted.recordCounts?.activityMarkers !== expected.activityMarkers
      || accepted.recordCounts?.accepted !== expectedTotal
      || accepted.recordCounts?.deduplicated !== 0
      || replay.recordCounts?.accepted !== expectedTotal
      || replay.recordCounts?.deduplicated !== 0
      || contributionStatus.recordCounts?.declared !== expectedTotal
      || contributionStatus.recordCounts?.accepted !== expectedTotal
      || contributionStatus.records?.length !== expectedTotal
      || personal.totals?.usageEvents !== expected.usageEvents
      || personal.totals?.quotaSnapshots !== expected.quotaSnapshots
      || personal.totals?.activityMarkers !== expected.activityMarkers
      || community.suppressed !== true
      || community.participantCount !== 1
      || community.cohortEligibility !== "invite_only"
      || participantExport.contributions?.length !== 1
      || participantExport.contributions[0]?.contributionId !== accepted.contributionId
      || participantExport.contributions[0]?.records?.length !== expectedTotal) {
    throw new Error("Accept/status/replay behavior did not match the backend contract.");
  }
  if (["um_invite_", "um_access_", "um_recovery_", "eligibility:", "grant_id"]
    .some((forbidden) => serializedExport.includes(forbidden))) {
    throw new Error("The participant export exposed a private capability.");
  }

  const deletion = await client.deleteParticipant();
  if (deletion.deleted !== true || deletion.contributionsDeleted !== 1) {
    throw new Error("Participant deletion did not match the backend contract.");
  }
  deleted = true;
  let oldCredentialStatus = null;
  try {
    await client.personalStats();
  } catch (error) {
    oldCredentialStatus = error?.status ?? null;
  }
  if (oldCredentialStatus !== 401) {
    throw new Error("The deleted participant credential was not rejected.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    origin: origin.origin,
    enrollmentMode: health.enrollmentMode,
    acceptedRecords: expectedTotal,
    replayedRecords: expectedTotal,
    personalUsageEvents: expected.usageEvents,
    personalQuotaSnapshots: expected.quotaSnapshots,
    communitySuppressed: true,
    participantExportContributions: 1,
    participantDeleted: true,
    oldCredentialStatus,
  }, null, 2)}\n`);
} finally {
  if (participantCreated && !deleted && accessToken) {
    try {
      await client.deleteParticipant();
    } catch {
      process.stderr.write("Backend smoke cleanup failed; use the participant deletion endpoint before reusing this state.\n");
    }
  }
}
