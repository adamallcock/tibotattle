import { createSessionMaterialFromSecret } from "../src/session.ts";
import { hashCapability } from "../src/crypto.ts";
import { SESSION_TTL_MILLISECONDS } from "../src/constants.ts";

const FIXTURE_SCHEMA = "gcp-test-owner-fixture-v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const PARTICIPANT_ID = /^participant:[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

class OwnerBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = "OwnerBootstrapError";
    this.code = code;
  }
}

function fail(code) {
  throw new OwnerBootstrapError(code);
}

function stringField(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${name}_INVALID`);
  return value;
}

function fixtureField(fixture, name, pattern) {
  return stringField(fixture[name], name, pattern);
}

function parseInstant(value, name) {
  const raw = stringField(value, name, /^\d{4}-\d{2}-\d{2}T[^\s]+Z$/u);
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== raw) {
    fail(`${name}_INVALID`);
  }
  return { raw, epoch };
}

/**
 * Parse the only secret accepted by the owner bootstrap job.  The fixture is
 * deliberately explicit: the session token is created from the supplied
 * session secret, so a later journey job can use the same Secret Manager
 * value without putting credentials in a Cloud Logging result.
 */
export function parseOwnerFixture(
  raw,
  { requireStandardSessionTtl = false, allowExpired = false } = {},
) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || value.schemaVersion !== FIXTURE_SCHEMA) {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  const participantId = fixtureField(value, "participantId", PARTICIPANT_ID);
  const identityLinkKey = fixtureField(value, "identityLinkKey", HEX64);
  const ownerDigest = fixtureField(value, "ownerDigest", HEX64);
  const attributionNamespace = fixtureField(value, "attributionNamespace", HEX64);
  const accessTokenId = fixtureField(value, "accessTokenId", TOKEN_ID);
  const accessTokenSecret = fixtureField(value, "accessTokenSecret", SECRET);
  const recoveryTokenId = fixtureField(value, "recoveryTokenId", TOKEN_ID);
  const recoveryTokenSecret = fixtureField(value, "recoveryTokenSecret", SECRET);
  const sessionId = fixtureField(value, "sessionId", UUID);
  const sessionSecret = fixtureField(value, "sessionSecret", SECRET);
  const issuedAt = parseInstant(value.issuedAt, "issuedAt");
  const expiresAt = parseInstant(value.expiresAt, "expiresAt");
  if (expiresAt.epoch <= issuedAt.epoch) fail("SESSION_EXPIRY_INVALID");
  if (!allowExpired && expiresAt.epoch <= Date.now()) fail("SESSION_EXPIRED");
  if (requireStandardSessionTtl
      && expiresAt.epoch - issuedAt.epoch !== SESSION_TTL_MILLISECONDS) {
    fail("SESSION_TTL_INVALID");
  }
  const consentVersion = fixtureField(
    value,
    "consentVersion",
    VERSION,
  );
  const ownerLabel = value.ownerLabel === undefined
    ? "synthetic-admin"
    : stringField(value.ownerLabel, "ownerLabel", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  return Object.freeze({
    schemaVersion: FIXTURE_SCHEMA,
    ownerLabel,
    participantId,
    identityLinkKey,
    ownerDigest,
    attributionNamespace,
    accessTokenId,
    accessTokenSecret,
    recoveryTokenId,
    recoveryTokenSecret,
    sessionId,
    sessionSecret,
    issuedAt: issuedAt.raw,
    expiresAt: expiresAt.raw,
    consentVersion,
  });
}

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)
      || left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index] ^ right[index];
  }
  return different === 0;
}

function copyBytes(value) {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

async function expectedMaterial(fixture) {
  const [accessTokenHash, recoveryTokenHash, session] = await Promise.all([
    hashCapability("access", fixture.accessTokenId, fixture.accessTokenSecret),
    hashCapability("recovery", fixture.recoveryTokenId, fixture.recoveryTokenSecret),
    createSessionMaterialFromSecret(
      fixture.participantId,
      fixture.sessionId,
      fixture.sessionSecret,
      fixture.issuedAt,
      fixture.expiresAt,
    ),
  ]);
  return Object.freeze({ accessTokenHash, recoveryTokenHash, session });
}

async function verifyExistingOwner(backend, fixture, material) {
  const identity = await backend.authority.identity.readByLinkKey(fixture.identityLinkKey);
  if (!identity || identity.id !== fixture.participantId || identity.state !== "active") {
    fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  }
  const session = await backend.authority.sessions.read(fixture.sessionId);
  if (!session
      || session.participantId !== fixture.participantId
      || session.state !== "active"
      || !equalBytes(copyBytes(session.secretHash), material.session.secretHash)
      || !equalBytes(copyBytes(session.csrfHash), material.session.csrfHash)
      || session.issuedAt !== fixture.issuedAt
      || session.expiresAt !== fixture.expiresAt) {
    fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  }
  const ownerDigest = await backend.application.ownerDigest(fixture.participantId);
  if (ownerDigest !== fixture.ownerDigest) fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  return Object.freeze({ created: false, ownerDigest });
}

/**
 * Refresh only the dedicated synthetic owner's expired session.  This uses
 * the authority session insert port, keeps identity, recovery/access, and
 * owner/source rows untouched, and accepts only the normal application
 * session TTL.  It is a test bootstrap operation, not a public recovery API.
 */
export async function refreshOwnerSessionFixture({
  backend,
  fixture: rawFixture,
  previousFixture: rawPreviousFixture = undefined,
}) {
  if (!backend || backend.provider !== "postgres"
      || !backend.authority?.identity
      || typeof backend.authority.sessions?.read !== "function"
      || typeof backend.authority.sessions?.insert !== "function") {
    fail("POSTGRES_BACKEND_INVALID");
  }
  const fixture = typeof rawFixture === "string"
    ? parseOwnerFixture(rawFixture, { requireStandardSessionTtl: true })
    : rawFixture;
  if (!fixture || fixture.schemaVersion !== FIXTURE_SCHEMA) {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  // Refresh is a privileged test setup operation, but it must still prove
  // possession of the currently stored owner session.  Requiring the old
  // fixture prevents a caller who knows only the identity link from minting
  // an unrelated session for the owner.
  if (rawPreviousFixture === undefined) fail("ADMIN_OWNER_PREVIOUS_FIXTURE_REQUIRED");
  const previousFixture = typeof rawPreviousFixture === "string"
    ? parseOwnerFixture(rawPreviousFixture, { allowExpired: true })
    : rawPreviousFixture;
  if (!previousFixture || previousFixture.schemaVersion !== FIXTURE_SCHEMA) {
    fail("ADMIN_OWNER_FIXTURE_INVALID");
  }
  for (const field of [
    "participantId", "identityLinkKey", "ownerDigest", "attributionNamespace",
    "accessTokenId", "accessTokenSecret", "recoveryTokenId", "recoveryTokenSecret",
    "consentVersion",
  ]) {
    if (previousFixture[field] !== fixture[field]) fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  }
  const identity = await backend.authority.identity.readByLinkKey(fixture.identityLinkKey);
  if (!identity || identity.id !== fixture.participantId || identity.state !== "active") {
    fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  }
  const ownerDigest = await backend.application.ownerDigest(fixture.participantId);
  if (ownerDigest !== fixture.ownerDigest) fail("ADMIN_OWNER_FIXTURE_CONFLICT");
  const previousMaterial = await expectedMaterial(previousFixture);
  const previousSession = await backend.authority.sessions.read(previousFixture.sessionId);
  if (!previousSession
      || previousSession.participantId !== previousFixture.participantId
      || previousSession.state !== "active"
      || previousSession.participantState !== "active"
      || previousSession.scope !== "personal"
      || previousSession.issuedAt !== previousFixture.issuedAt
      || previousSession.expiresAt !== previousFixture.expiresAt
      || previousSession.consentVersion !== previousFixture.consentVersion
      || Date.parse(previousSession.expiresAt) > Date.now()
      || !equalBytes(copyBytes(previousSession.secretHash), previousMaterial.session.secretHash)
      || !equalBytes(copyBytes(previousSession.csrfHash), previousMaterial.session.csrfHash)) {
    fail("ADMIN_OWNER_PREVIOUS_SESSION_INVALID");
  }
  const material = await expectedMaterial(fixture);
  const existingSession = await backend.authority.sessions.read(fixture.sessionId);
  if (existingSession !== null) {
    if (existingSession.participantId !== fixture.participantId
        || existingSession.state !== "active"
        || existingSession.participantState !== "active"
        || existingSession.scope !== "personal"
        || !equalBytes(copyBytes(existingSession.secretHash), material.session.secretHash)
        || !equalBytes(copyBytes(existingSession.csrfHash), material.session.csrfHash)
        || existingSession.issuedAt !== fixture.issuedAt
        || existingSession.expiresAt !== fixture.expiresAt
        || existingSession.consentVersion !== fixture.consentVersion) {
      fail("ADMIN_OWNER_FIXTURE_CONFLICT");
    }
    return Object.freeze({
      status: "ok",
      mode: "refresh-owner-session",
      fixture: fixture.schemaVersion,
      ownerLabel: fixture.ownerLabel,
      created: false,
    });
  }
  // Insert only the replacement session.  Reattach intentionally rotates the
  // recovery capability in the normal public flow, which would silently
  // invalidate the owner fixture and alter credentials during a test refresh.
  await backend.authority.sessions.insert({
    id: material.session.id,
    participantId: material.session.participantId,
    secretHash: copyBytes(material.session.secretHash),
    csrfHash: copyBytes(material.session.csrfHash),
    scope: material.session.scope,
    issuedAt: material.session.issuedAt,
    expiresAt: material.session.expiresAt,
  });
  const inserted = await backend.authority.sessions.read(fixture.sessionId);
  if (inserted === null || inserted.participantId !== fixture.participantId
      || inserted.state !== "active"
      || inserted.participantState !== "active"
      || inserted.scope !== "personal"
      || !equalBytes(copyBytes(inserted.secretHash), material.session.secretHash)
      || !equalBytes(copyBytes(inserted.csrfHash), material.session.csrfHash)
      || inserted.issuedAt !== fixture.issuedAt
      || inserted.expiresAt !== fixture.expiresAt
      || inserted.consentVersion !== fixture.consentVersion) {
    fail("ADMIN_OWNER_SESSION_REFRESH_FAILED");
  }
  return Object.freeze({
    status: "ok",
    mode: "refresh-owner-session",
    fixture: fixture.schemaVersion,
    ownerLabel: fixture.ownerLabel,
    created: true,
  });
}

/**
 * Ensure the dedicated owner exists through the same authority transaction as
 * normal enrollment. Re-running the migrator is safe only for the exact same
 * fixture; a participant/link/session mismatch fails closed.
 */
export async function bootstrapOwnerFixture({ backend, fixture: rawFixture }) {
  if (!backend || backend.provider !== "postgres" || !backend.authority?.enrollment) {
    fail("POSTGRES_BACKEND_INVALID");
  }
  const fixture = typeof rawFixture === "string" ? parseOwnerFixture(rawFixture) : rawFixture;
  if (!fixture || fixture.schemaVersion !== FIXTURE_SCHEMA) fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  const material = await expectedMaterial(fixture);
  const existing = await backend.authority.identity.readByLinkKey(fixture.identityLinkKey);
  let result;
  if (existing !== null) {
    result = await verifyExistingOwner(backend, fixture, material);
  } else {
    const participant = await backend.authority.enrollment.enroll({
      participant: {
        id: fixture.participantId,
        accessTokenId: fixture.accessTokenId,
        accessTokenHash: copyBytes(material.accessTokenHash),
        recoveryTokenId: fixture.recoveryTokenId,
        recoveryTokenHash: copyBytes(material.recoveryTokenHash),
        consentVersion: fixture.consentVersion,
        createdAt: fixture.issuedAt,
        identityLinkKey: fixture.identityLinkKey,
        identityCooldownDigest: null,
      },
      session: {
        id: material.session.id,
        participantId: material.session.participantId,
        secretHash: copyBytes(material.session.secretHash),
        csrfHash: copyBytes(material.session.csrfHash),
        scope: material.session.scope,
        issuedAt: material.session.issuedAt,
        expiresAt: material.session.expiresAt,
      },
      pairing: null,
      bootstrap: {
        sourceId: backend.sourceIdentity.sourceId,
        ownerDigest: fixture.ownerDigest,
        attributionNamespace: fixture.attributionNamespace,
        now: fixture.issuedAt,
      },
    });
    if (participant.id !== fixture.participantId || participant.state !== "active") {
      fail("ADMIN_OWNER_BOOTSTRAP_FAILED");
    }
    const ownerDigest = await backend.application.ownerDigest(fixture.participantId);
    if (ownerDigest !== fixture.ownerDigest) fail("ADMIN_OWNER_BOOTSTRAP_FAILED");
    result = Object.freeze({ created: true, ownerDigest });
  }
  return Object.freeze({
    status: "ok",
    mode: "bootstrap-owner",
    fixture: fixture.schemaVersion,
    ownerLabel: fixture.ownerLabel,
    created: result.created,
  });
}

export async function ownerSessionCredentials(rawFixture) {
  const fixture = typeof rawFixture === "string" ? parseOwnerFixture(rawFixture) : rawFixture;
  if (!fixture || fixture.schemaVersion !== FIXTURE_SCHEMA) fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  const session = await createSessionMaterialFromSecret(
    fixture.participantId,
    fixture.sessionId,
    fixture.sessionSecret,
    fixture.issuedAt,
    fixture.expiresAt,
  );
  return Object.freeze({
    participantId: fixture.participantId,
    cookie: `__Host-usage_monitor_session=${session.token}`,
    sessionToken: session.token,
    csrfToken: session.csrfToken,
    identityLinkKey: fixture.identityLinkKey,
  });
}

export { FIXTURE_SCHEMA };
