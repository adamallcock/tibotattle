import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  claimContributionDevicePairing,
} from "../../../src/contribution-device-client.js";
import {
  removeContributionDeviceCapability,
} from "../../../src/contribution-device-capability.js";
import { localContributionSyncQueue } from
  "../../../src/local-node-runtime.js";
import {
  PREPARED_CONTRIBUTION_SET_VERSION,
  publishPreparedContributionFile,
  publishPreparedContributionManifest,
} from "../../../src/telemetry-prepared-set.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "../../../src/telemetry-contribution-builder.js";
import { stableJson } from "../../../src/storage.js";
import {
  validateTelemetryContribution,
} from "../../web/public/lib.js";
import { assertRetiredDeletionHealth, createLocalOwnerEraser } from "./local-owner-erasure.mjs";

const {
  inspectContributionSyncQueue,
  runContributionSyncQueueOnce,
} = localContributionSyncQueue;

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
  if (origin.protocol !== "http:"
      || !["127.0.0.1", "localhost"].includes(origin.hostname)
      || origin.username !== "" || origin.password !== "") {
    throw new Error("The queue smoke accepts only a loopback HTTP origin.");
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin.origin;
}

async function ownerOnlyFile(path, label) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1
        || (typeof process.getuid === "function" && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      throw new Error(`${label} must be an owner-only regular file.`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

function cookiePair(value) {
  return typeof value === "string" ? value.split(";", 1)[0] : null;
}

class MemorySecretBackend {
  constructor() {
    this.value = null;
  }

  async read() {
    return this.value === null ? null : Buffer.from(this.value);
  }

  async createIfMissing(_capability, secret) {
    if (this.value !== null) return "existing";
    this.value = Buffer.from(secret);
    return "created";
  }

  async deleteExact(_capability, expected) {
    if (this.value === null) return "missing";
    if (this.value.length !== expected.length
        || !timingSafeEqual(this.value, expected)) {
      return "conflict";
    }
    this.value.fill(0);
    this.value = null;
    return "deleted";
  }

  dispose() {
    this.value?.fill(0);
    this.value = null;
  }
}

function occurrenceId(prefix, value, suffix) {
  return `${prefix}:${createHash("sha256")
    .update(String(value))
    .update("\0")
    .update(suffix)
    .digest("hex")}`;
}

function secondContribution(value) {
  const copy = structuredClone(value);
  copy.createdAt = new Date(
    Math.min(Date.now(), Date.parse(value.createdAt) + 1000),
  ).toISOString();
  copy.usageEvents = copy.usageEvents.map((row) => ({
    ...row,
    eventId: occurrenceId("event:v2", row.eventId, "queue-revocation"),
  }));
  copy.quotaSnapshots = copy.quotaSnapshots.map((row) => ({
    ...row,
    snapshotId: occurrenceId(
      "snapshot:v2",
      row.snapshotId,
      "queue-revocation",
    ),
  }));
  copy.activityMarkers = copy.activityMarkers.map((row) => ({
    ...row,
    markerId: occurrenceId("marker:v2", row.markerId, "queue-revocation"),
  }));
  validateTelemetryContribution(copy);
  return copy;
}

async function publishSet(spool, setName, contribution) {
  const directory = join(spool, setName);
  await mkdir(directory, { mode: 0o700 });
  const published = await publishPreparedContributionFile({
    directory,
    name: "telemetry-contribution-000001.json",
    content: stableJson(contribution),
  });
  await publishPreparedContributionManifest({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    manifest: {
      schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
      eligibleSchemaVersion: "telemetry-contribution-v0.1",
      batchCount: 1,
      files: [{
        basename: published.basename,
        sha256: published.sha256,
        bytes: published.bytes,
        recordCounts: {
          usageEvents: contribution.usageEvents.length,
          quotaSnapshots: contribution.quotaSnapshots.length,
          activityMarkers: contribution.activityMarkers.length,
        },
      }],
    },
  });
}

const origin = boundedOrigin(
  optionValue("--origin", "http://127.0.0.1:8792"),
);
const contributionFile = optionValue("--file");
if (!contributionFile) {
  throw new Error("--file must name one privacy-safe v0.1 contribution.");
}
const inviteFile = optionValue("--invite-file");
const session = {
  participantId: null,
  cookie: null,
  csrfToken: null,
  created: false,
  deleted: false,
};
let ownerEraser;

async function request(path, {
  method = "GET",
  body = null,
  authorization = null,
  csrf = false,
} = {}) {
  const headers = { Accept: "application/json" };
  if (session.cookie) headers.Cookie = session.cookie;
  if (authorization) headers.Authorization = authorization;
  if (body !== null) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Origin = origin;
  if (csrf) {
    headers["X-Usage-Monitor-CSRF"] = session.csrfToken ?? "";
  }
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body,
    redirect: "error",
  });
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error("The backend returned an invalid cache policy.");
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) session.cookie = cookiePair(setCookie);
  const text = await response.text();
  let value = null;
  if (text) value = JSON.parse(text);
  return { response, value };
}

function expect(result, status, label) {
  if (result.response.status !== status) {
    throw new Error(`${label} returned an unexpected status.`);
  }
  return result.value;
}

async function eraseParticipantFixture() {
  if (!session.created || session.deleted) {
    return;
  }
  try {
    await ownerEraser.eraseParticipant(session, { retry: true });
  } catch {
    // The final fixed warning is sufficient and contains no authority.
  }
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "app-usagemonitor-queue-http-smoke-"),
);
const spool = join(temporaryRoot, "spool");
const privateDirectory = join(temporaryRoot, "private");
await mkdir(spool, { mode: 0o700 });
await mkdir(privateDirectory, { mode: 0o700 });
const queueFile = join(privateDirectory, "queue.sqlite3");
const stateFile = join(privateDirectory, "device.json");
const backend = new MemorySecretBackend();

try {
  ownerEraser = await createLocalOwnerEraser({
    origin,
    ownerAccessFile: optionValue("--owner-access-file"),
  });
  const health = expect(await request("/api/health"), 200, "Health");
  assertRetiredDeletionHealth(health);
  if (!["local_open", "invite_only"].includes(health?.enrollmentMode)) {
    throw new Error("The backend is not open for this smoke.");
  }
  if (health.enrollmentMode === "invite_only" && !inviteFile) {
    throw new Error("Invite-only mode requires --invite-file.");
  }
  if (health.enrollmentMode === "local_open" && inviteFile) {
    throw new Error("Do not pass an invitation to a local-open smoke.");
  }

  const parsed = JSON.parse(await ownerOnlyFile(
    resolve(contributionFile),
    "Contribution",
  ));
  validateTelemetryContribution(parsed);
  await publishSet(spool, `prepared-set-${randomUUID()}`, parsed);

  const enrollmentBody = {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
  };
  if (inviteFile) {
    enrollmentBody.inviteCode = (
      await ownerOnlyFile(resolve(inviteFile), "Invitation")
    ).trim();
  }
  const enrollment = expect(
    await request("/api/v1/enroll", {
      method: "POST",
      body: JSON.stringify(enrollmentBody),
    }),
    201,
    "Enrollment",
  );
  if (typeof enrollment?.csrfToken !== "string" || !session.cookie) {
    throw new Error("Enrollment did not establish a session.");
  }
  session.csrfToken = enrollment.csrfToken;
  session.participantId = enrollment.participantId;
  session.created = true;
  ownerEraser.trackParticipant(session);

  const pairing = expect(
    await request("/api/v1/me/device-pairings", {
      method: "POST",
      csrf: true,
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      }),
    }),
    201,
    "Pairing issuance",
  );
  const paired = await claimContributionDevicePairing({
    origin,
    pairingCode: pairing.pairingCode,
    capabilityOptions: { backend, stateFile },
  });

  const first = await runContributionSyncQueueOnce({
    directory: spool,
    origin,
    backend,
    stateFile,
    queueFile,
  });
  if (first.accepted !== 1 || first.queue.counts.accepted !== 1) {
    throw new Error("The queue did not accept the first prepared set.");
  }
  const restarted = await runContributionSyncQueueOnce({
    directory: spool,
    origin,
    backend,
    stateFile,
    queueFile,
  });
  if (restarted.processed !== 0 || restarted.queue.counts.accepted !== 1) {
    throw new Error("A restarted queue replayed an accepted job.");
  }
  const participantExport = expect(
    await request("/api/v1/me/export"),
    200,
    "Participant export",
  );
  if (participantExport?.contributions?.length !== 1
      || participantExport.contributions[0]?.records?.length
        !== parsed.usageEvents.length
          + parsed.quotaSnapshots.length
          + parsed.activityMarkers.length) {
    throw new Error("Participant export did not reflect the queued contribution.");
  }

  const devices = expect(
    await request("/api/v1/me/devices"),
    200,
    "Device list",
  );
  if (!Array.isArray(devices?.devices)
      || devices.devices[0]?.deviceId !== paired.deviceId) {
    throw new Error("The paired queue device was not participant-visible.");
  }
  expect(
    await request("/api/v1/me/devices/revoke", {
      method: "POST",
      csrf: true,
      body: JSON.stringify({ deviceId: paired.deviceId }),
    }),
    200,
    "Device revocation",
  );

  await publishSet(
    spool,
    `prepared-set-${randomUUID()}`,
    secondContribution(parsed),
  );
  const revoked = await runContributionSyncQueueOnce({
    directory: spool,
    origin,
    backend,
    stateFile,
    queueFile,
  });
  if (revoked.status !== "paused"
      || revoked.queue.counts.retryable !== 1) {
    throw new Error("A revoked device did not pause its pending queue job.");
  }
  const inspected = await inspectContributionSyncQueue({ queueFile });
  if (!inspected.paused || inspected.counts.accepted !== 1
      || inspected.counts.retryable !== 1) {
    throw new Error("Restarted queue state did not preserve pause and receipts.");
  }

  await removeContributionDeviceCapability({
    backend,
    stateFile,
    expectedOrigin: origin,
    confirmDeviceId: paired.deviceId,
    remoteRevocationConfirmed: true,
  });
  await ownerEraser.verifyParticipantRefusal(session);
  await ownerEraser.eraseParticipant(session, { expectedContributions: 1 });

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    preparedSetsDiscovered: 2,
    acceptedBeforeRestart: 1,
    acceptedRowsAfterRestart: 1,
    replayedAfterRestart: 0,
    privateStatisticsUpdated: true,
    deviceVisibleToParticipant: true,
    revokedDevicePausedQueue: true,
    retryableJobsPreserved: 1,
    localCredentialRemovedAfterRemoteRevocation: true,
    selfServiceDeletionRefused: true,
    participantStateUnchangedAfterRefusal: true,
    ownerAuthAndCsrfRequired: true,
    participantErasedByOwner: true,
    printedContentPathsIdentitiesOriginsCredentials: false,
  }, null, 2)}\n`);
} finally {
  await eraseParticipantFixture();
  backend.dispose();
  await rm(temporaryRoot, { recursive: true, force: true });
  if (session.created && !session.deleted) {
    process.stderr.write(
      "Queue smoke cleanup was incomplete; inspect the isolated local backend state.\n",
    );
    process.exitCode = 1;
  }
}
