import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createTelemetryEnvelope,
  validateTelemetryContribution,
} from "../../web/public/lib.js";

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
    cookie: null,
    csrfToken: null,
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
      }),
    }),
    201,
    "Enrollment",
  );
  if (typeof enrolled?.csrfToken !== "string" || !session.cookie) {
    throw new Error("Enrollment did not establish a bounded session.");
  }
  session.csrfToken = enrolled.csrfToken;
  session.created = true;
  sessions.push(session);
  return session;
}

async function registerUpload(session, envelope) {
  const registered = expect(
    await request("/api/v1/me/upload-authorizations", {
      method: "POST",
      session,
      csrf: true,
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

async function deleteParticipant(session) {
  if (!session.created || session.deleted || !session.cookie) return false;
  const result = await request("/api/v1/me", {
    method: "DELETE",
    session,
    csrf: true,
  });
  if (result.response.status !== 200) return false;
  session.deleted = true;
  return true;
}

try {
  const initial = expect(await request("/api/health"), 200, "Initial health");
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
    await request("/api/v1/me/upload-authorizations", {
      method: "POST",
      session: resumedParticipant,
      csrf: true,
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
    await request("/api/v1/stats/aggregate"),
    503,
    "Contained publication",
    "PUBLICATION_DISABLED",
  );
  expect(
    await request("/api/v1/me/stats", { session: rightsParticipant }),
    200,
    "Contained private statistics",
  );
  expect(
    await request("/api/v1/me/export", { session: rightsParticipant }),
    200,
    "Contained participant export",
  );
  if (!await deleteParticipant(rightsParticipant)) {
    throw new Error("Participant deletion failed during containment.");
  }

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
  const stats = expect(
    await request("/api/v1/me/stats", { session: resumedParticipant }),
    200,
    "Resumed participant statistics",
  );
  if (stats?.totals?.usageEvents !== contribution.usageEvents.length
      || stats?.totals?.quotaSnapshots !== contribution.quotaSnapshots.length
      || stats?.totals?.activityMarkers !== contribution.activityMarkers.length) {
    throw new Error("Resumed ingestion did not update private statistics.");
  }
  if (!await deleteParticipant(resumedParticipant)) {
    throw new Error("Participant deletion failed after restoration.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    target: "local",
    noRedeployContainmentObserved: true,
    enrollmentBlocked: true,
    uploadRegistrationBlocked: true,
    processingBlockedWithoutConsumingAuthority: true,
    publicationBlocked: true,
    privateStatsAvailableDuringContainment: true,
    exportAvailableDuringContainment: true,
    deletionAvailableDuringContainment: true,
    explicitRestoreRequired: true,
    ingestionResumedAfterRestore: true,
    privateStatsUpdatedAfterRestore: true,
    participantsDeleted: sessions.filter((session) => session.deleted).length,
  }, null, 2)}\n`);
} finally {
  if (controlState !== "operational") {
    try {
      operate("restore-all", { confirm: true });
    } catch {
      process.stderr.write(
        "Incident smoke could not restore local collection controls.\n",
      );
    }
  }
  for (const session of sessions) {
    try {
      await deleteParticipant(session);
    } catch {
      // The fixed cleanup warning below contains no authority or participant ID.
    }
  }
  if (sessions.some((session) => session.created && !session.deleted)) {
    process.stderr.write(
      "Incident smoke participant cleanup was incomplete; discard the isolated local state.\n",
    );
  }
}
