import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";
import { assertRetiredDeletionHealth, createLocalOwnerEraser } from "./local-owner-erasure.mjs";

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
      || origin.username !== ""
      || origin.password !== "") {
    throw new Error("The incident smoke accepts only a loopback HTTP origin.");
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
    if (!stats.isFile()
        || stats.nlink !== 1
        || (typeof process.getuid === "function" && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      throw new Error(`${label} must be an owner-only regular file.`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cookiePair(value) {
  return typeof value === "string" ? value.split(";", 1)[0] : null;
}

const origin = boundedOrigin(
  optionValue("--origin", "http://127.0.0.1:8792"),
);
const contributionPath = optionValue("--file");
const persistTo = optionValue("--persist-to");
if (!contributionPath || !persistTo) {
  throw new Error(
    "--file and --persist-to are required; the running Worker must use the same local state.",
  );
}

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const operator = resolve(workerDirectory, "scripts/collection-control.mjs");
const sessions = [];
let ownerEraser;
let controlState = "unknown";

function operate(action, { confirm = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      operator,
      "--action", action,
      "--persist-to", resolve(persistTo),
      ...(confirm ? ["--confirm", "RESTORE_COLLECTION"] : []),
    ],
    {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error("The local collection-control operation failed.");
  }
  const state = JSON.parse(result.stdout);
  if (state?.target !== "local") {
    throw new Error("The operator did not confirm a local-only target.");
  }
  controlState = state.state;
  return state;
}

async function request(path, {
  method = "GET",
  session = null,
  body = null,
  csrf = false,
  authorization = null,
} = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (authorization) headers.Authorization = authorization;
  if (body !== null) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Origin = origin;
  if (csrf) headers["X-Usage-Monitor-CSRF"] = session?.csrfToken ?? "";
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
  if (session && setCookie) {
    session.cookie = setCookie.includes("Max-Age=0")
      ? null
      : cookiePair(setCookie);
  }
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("The backend returned non-JSON.");
    }
  }
  return { response, value };
}

function expect(result, status, label, code = null) {
  if (result.response.status !== status
      || (code !== null && result.value?.error?.code !== code)) {
    throw new Error(`${label} did not return its expected bounded result.`);
  }
  return result.value;
}

async function enroll() {
  const session = {
    participantId: null,
    cookie: null,
    csrfToken: null,
    bootstrapPairing: null,
    device: null,
    created: false,
    deleted: false,
  };
  const enrolled = expect(
    await request("/api/v1/enroll", {
      method: "POST",
      session,
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        deviceBootstrap: true,
      }),
    }),
    201,
    "Enrollment",
  );
  if (typeof enrolled?.csrfToken !== "string" || !session.cookie) {
    throw new Error("Enrollment did not establish a bounded session.");
  }
  session.csrfToken = enrolled.csrfToken;
  session.participantId = enrolled.participantId;
  session.bootstrapPairing = enrolled.pairing;
  session.created = true;
  sessions.push(session);
  ownerEraser.trackParticipant(session);
  return session;
}

async function registerUpload(session, envelope) {
  if (session.device === null) {
    const pairingCode = session.bootstrapPairing?.pairingCode;
    if (typeof pairingCode !== "string") {
      throw new Error("Enrollment did not issue a device pairing authority.");
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
    expect(
      await request("/api/v1/device-pairings/claim", {
        method: "POST",
        authorization: `Pairing ${pairingCode}`,
        body: JSON.stringify({ deviceId, deviceSecretHash }),
      }),
      201,
      "Device pairing claim",
    );
    session.device = `um_device_${deviceId}.${encodedSecret}`;
  }
  const registered = expect(
    await request("/api/v1/device/upload-authorizations", {
      method: "POST",
      authorization: `Device ${session.device}`,
      body: JSON.stringify({
        envelopeDigest: sha256Hex(envelope),
        contentLengthBytes: Buffer.byteLength(envelope, "utf8"),
        contentType: "application/json",
      }),
    }),
    201,
    "Upload registration",
  );
  if (typeof registered?.uploadAuthorization !== "string") {
    throw new Error("Upload registration did not return a bounded authority.");
  }
  return registered.uploadAuthorization;
}

async function eraseParticipant(session, options = { retry: true }) {
  if (!session.created || session.deleted) return;
  await ownerEraser.eraseParticipant(session, options);
}

try {
  ownerEraser = await createLocalOwnerEraser({
    origin,
    ownerAccessFile: optionValue("--owner-access-file"),
  });
  const initial = expect(await request("/api/health"), 200, "Initial health");
  assertRetiredDeletionHealth(initial);
  if (initial?.collectionControls?.state !== "operational") {
    throw new Error("The incident drill requires an initially operational backend.");
  }
  controlState = "operational";

  const contribution = JSON.parse(
    await ownerOnlyFile(resolve(contributionPath), "Contribution"),
  );
  validateTelemetryContribution(contribution);
  const key = expect(
    await request("/api/v1/envelope-key"),
    200,
    "Envelope key",
  );
  const serializedEnvelope = JSON.stringify(await createTelemetryEnvelope({
    payload: contribution,
    publicJwk: key.publicJwk,
    keyId: key.keyId,
  }));

  const rightsParticipant = await enroll();
  const resumedParticipant = await enroll();
  const pendingUpload = await registerUpload(
    resumedParticipant,
    serializedEnvelope,
  );

  const contained = operate("contain-all");
  if (contained.state !== "contained"
      || Object.values({
        enrollment: contained.enrollment,
        uploadRegistration: contained.uploadRegistration,
        processing: contained.processing,
        publication: contained.publication,
      }).some(Boolean)) {
    throw new Error("The operator did not enter full containment.");
  }
  const containedHealth = expect(
    await request("/api/health"),
    200,
    "Contained health",
  );
  assertRetiredDeletionHealth(containedHealth);
  if (containedHealth?.collectionControls?.state !== "contained") {
    throw new Error("The running Worker did not observe containment.");
  }

  expect(
    await request("/api/v1/enroll", {
      method: "POST",
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
      }),
    }),
    503,
    "Contained enrollment",
    "COLLECTION_ENROLLMENT_DISABLED",
  );
  expect(
    await request("/api/v1/device/upload-authorizations", {
      method: "POST",
      authorization: `Device ${resumedParticipant.device}`,
      body: JSON.stringify({
        envelopeDigest: sha256Hex(serializedEnvelope),
        contentLengthBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
        contentType: "application/json",
      }),
    }),
    503,
    "Contained upload registration",
    "UPLOAD_REGISTRATION_DISABLED",
  );
  expect(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${pendingUpload}`,
      body: serializedEnvelope,
    }),
    503,
    "Contained ingestion",
    "PROCESSING_DISABLED",
  );
  expect(
    await request("/api/v1/community/daily"),
    503,
    "Contained publication",
    "PUBLICATION_DISABLED",
  );
  expect(
    await request("/api/v1/me/export", { session: rightsParticipant }),
    200,
    "Contained participant export",
  );
  await ownerEraser.verifyParticipantRefusal(rightsParticipant);
  await eraseParticipant(rightsParticipant, { expectedContributions: 0 });

  const restored = operate("restore-all", { confirm: true });
  if (restored.state !== "operational"
      || [
        restored.enrollment,
        restored.uploadRegistration,
        restored.processing,
        restored.publication,
      ].some((value) => value !== true)) {
    throw new Error("Explicit restoration did not re-enable every control.");
  }
  const restoredHealth = expect(
    await request("/api/health"),
    200,
    "Restored health",
  );
  if (restoredHealth?.collectionControls?.state !== "operational") {
    throw new Error("The running Worker did not observe restoration.");
  }

  const accepted = expect(
    await request("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${pendingUpload}`,
      body: serializedEnvelope,
    }),
    202,
    "Resumed ingestion",
  );
  if (typeof accepted?.contributionId !== "string") {
    throw new Error("Resumed ingestion did not return an accepted contribution.");
  }
  const participantExport = expect(
    await request("/api/v1/me/export", { session: resumedParticipant }),
    200,
    "Resumed participant export",
  );
  const expectedRecords = contribution.usageEvents.length
    + contribution.quotaSnapshots.length
    + contribution.activityMarkers.length;
  if (participantExport?.contributions?.length !== 1
      || participantExport.contributions[0]?.records?.length !== expectedRecords) {
    throw new Error("Resumed ingestion did not update the participant export.");
  }
  await ownerEraser.verifyParticipantRefusal(resumedParticipant);
  await eraseParticipant(resumedParticipant, { expectedContributions: 1 });

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    target: "local",
    noRedeployContainmentObserved: true,
    enrollmentBlocked: true,
    uploadRegistrationBlocked: true,
    processingBlockedWithoutConsumingAuthority: true,
    publicationBlocked: true,
    exportAvailableDuringContainment: true,
    selfServiceDeletionRefusedDuringContainment: true,
    selfServiceDeletionRefusedAfterRestore: true,
    participantStateUnchangedAfterRefusal: true,
    ownerAuthAndCsrfRequired: true,
    ownerErasureAvailableDuringContainment: true,
    explicitRestoreRequired: true,
    ingestionResumedAfterRestore: true,
    participantExportUpdatedAfterRestore: true,
    participantsErasedByOwner: sessions.filter((session) => session.deleted).length,
  }, null, 2)}\n`);
} finally {
  if (controlState !== "unknown" && controlState !== "operational") {
    try {
      operate("restore-all", { confirm: true });
    } catch {
      process.stderr.write(
        "Incident smoke could not restore local collection controls.\n",
      );
      process.exitCode = 1;
    }
  }
  for (const session of sessions) {
    try {
      await eraseParticipant(session);
    } catch {
      // The fixed cleanup warning below contains no authority or participant ID.
    }
  }
  if (sessions.some((session) => session.created && !session.deleted)) {
    process.stderr.write(
      "Incident smoke owner cleanup was incomplete; inspect the isolated local state before reuse.\n",
    );
    process.exitCode = 1;
  }
}
