/**
 * telemetry-envelope-v1.1 contribution handler for the PostgreSQL origin
 * (GCP fast path, IN-2).
 *
 * A registry entry, not a route: POST /api/v1/contributions keeps one shared
 * preamble (bearer auth, upload-authorization claim, deletion tombstone,
 * transport floor), and dispatches here on body.schemaVersion. The oracle is
 * d43c8f92 index.ts handleTelemetryV11Contribution plus the tail of
 * handleContribution it relies on (exact envelope keys, receipt recording,
 * abandon on failure), in typed storage mode, which is how production runs
 * v1.1.
 *
 * Storage is injected (src/postgres-telemetry-v11-live-admission.ts through
 * the composition root), so this file imports only plain JavaScript and the
 * telemetry contract package and node:test specs can load it directly.
 *
 * Order and answers follow the Worker:
 *   1. exact envelope key occurrences            400 ENVELOPE_INVALID
 *   2. participant consent (social / accountless) 400 TELEMETRY_REQUIRED
 *   3. validateTelemetryV11Envelope              500 INTERNAL_ERROR (the
 *      Worker's top-level answer to a contract error that is not an ApiError)
 *   4. decrypt                                   400 KEY_ID_INVALID / DECRYPTION_FAILED
 *   5. staged chunk                              400 CHUNK_INVALID / CHUNK_DIGEST_MISMATCH
 *   6. replay of a retained chunk                202 replayed (receipt bound to
 *      the retained contribution), 409 on a different chunk
 *   7. register the object journal, write the object, persist in one
 *      transaction, record the receipt           202 staged
 * A persist failure is resolved by an exact readback: our own committed row
 * answers as committed, an identical retained chunk as a replay, and only an
 * absent or conflicting outcome abandons the claim and retires the object.
 */

import {
  TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION,
  validateTelemetryV11Envelope,
} from "@app-usagemonitor/telemetry-contract";
import { registerContributionEnvelope } from "../contribution-envelope-registry.mjs";

const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
].sort());
const REQUIRED_DEPENDENCIES = Object.freeze([
  "readStorageReplay",
  "persistStagedChunk",
  "readUploadOutcome",
  "recordUploadReceipt",
  "registerPendingObject",
  "retirePendingObject",
  "abandonUploadAuthorization",
  "validateStagedChunk",
  "decryptSyntheticEnvelope",
  "sha256Hex",
]);

function failure(status, code, responseHeaders) {
  return Object.assign(new Error(code), {
    code, status, ...(responseHeaders ? { responseHeaders } : {}),
  });
}

function unavailable() {
  return failure(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function configurationError(message) {
  return Object.assign(new Error("TELEMETRY_V11_ENVELOPE_CONFIGURATION_INVALID: " + message), {
    code: "TELEMETRY_V11_ENVELOPE_CONFIGURATION_INVALID",
  });
}

/** The Worker's hasExactEnvelopeKeyOccurrences over the exact raw body. */
export function hasExactV11EnvelopeKeyOccurrences(raw) {
  if (typeof raw !== "string") return false;
  const keys = [...raw.matchAll(/"([^"\\]+)"\s*:/gu)].map((match) => match[1]).sort();
  return keys.length === ENVELOPE_KEYS.length && keys.every((key, index) => key === ENVELOPE_KEYS[index]);
}

function json(status, value, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...additionalHeaders,
    },
  });
}

function receipt(contributionId, manifestId, chunk, replayed) {
  return json(202, {
    schemaVersion: "telemetry-chunk-receipt-v1.1",
    contributionId,
    manifestId,
    chunkId: chunk.chunkId,
    chunkRevision: 1,
    status: "staged",
    replayed,
    recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
  }, replayed ? { "idempotency-replayed": "true" } : {});
}

/** The parsed envelope and its exact raw text, from the D1 {raw, value} body or the context. */
function envelopeInput(body, context) {
  const wrapped = body !== null && typeof body === "object" && !Array.isArray(body)
    && typeof body.raw === "string" && "value" in body;
  const raw = typeof context?.raw === "string" ? context.raw : wrapped ? body.raw : null;
  const value = wrapped ? body.value : body;
  return { raw, value };
}

function participantInput(participant) {
  if (participant === null || typeof participant !== "object") throw unavailable();
  const participantId = typeof participant.id === "string" ? participant.id
    : typeof participant.participantId === "string" ? participant.participantId : null;
  const ownerKind = participant.ownerKind ?? participant.owner_kind;
  const consentVersion = "consentVersion" in participant ? participant.consentVersion
    : participant.consent_version;
  if (!participantId || (ownerKind !== "social" && ownerKind !== "accountless")
      || (consentVersion !== null && typeof consentVersion !== "string")) {
    throw unavailable();
  }
  return { participantId, ownerKind, consentVersion };
}

/**
 * The claimed authorization as the PostgreSQL abandon adapter takes it, from
 * the claim receipt or (as the Worker passes it to its v1.1 handler) a bare
 * authorization id.
 */
function claimInput(claimed, participantId) {
  const authorizationId = typeof claimed === "string" ? claimed : claimed?.authorizationId;
  if (typeof authorizationId !== "string" || authorizationId.length < 1) throw unavailable();
  const claimParticipant = typeof claimed === "object" && claimed !== null
    && typeof claimed.participantId === "string" ? claimed.participantId : participantId;
  return {
    authorizationId,
    claim: Object.freeze({ authorizationKind: "device", authorizationId, participantId: claimParticipant }),
  };
}

/**
 * Build the v1.1 envelope registration. `dependencies` are bound once at
 * startup; per-request storage handles come from the preamble context
 * (primaryPool, schema, objectStore, markPersistStarted) or, failing that,
 * from `dependencies`.
 */
export function createTelemetryV11ContributionEnvelope(dependencies) {
  if (dependencies === null || typeof dependencies !== "object") {
    throw configurationError("dependencies must be an object");
  }
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[name] !== "function") throw configurationError(name + " must be a function");
  }
  if (typeof dependencies.socialConsentVersion !== "string" || dependencies.socialConsentVersion.length < 1
      || typeof dependencies.sourceNamespace !== "string" || dependencies.sourceNamespace.length < 1
      || typeof dependencies.envelopePublicJwk !== "string" || dependencies.envelopePublicJwk.length < 1
      || typeof dependencies.envelopePrivateJwk !== "string" || dependencies.envelopePrivateJwk.length < 1) {
    throw configurationError("consent version, source namespace and envelope keys are required");
  }
  const deps = Object.freeze({ ...dependencies });

  async function handleTelemetryV11Contribution(body, participant, sourceDeviceId, claimed, context = {}) {
    const { raw, value } = envelopeInput(body, context);
    if (!hasExactV11EnvelopeKeyOccurrences(raw)) throw failure(400, "ENVELOPE_INVALID");
    const owner = participantInput(participant);
    if ((owner.ownerKind === "social" && owner.consentVersion !== deps.socialConsentVersion)
        || (owner.ownerKind === "accountless" && owner.consentVersion !== null)) {
      throw failure(400, "TELEMETRY_REQUIRED");
    }
    if (typeof sourceDeviceId !== "string" || sourceDeviceId.length < 1) throw failure(401, "UPLOAD_AUTH_INVALID");
    const claim = claimInput(claimed, owner.participantId);
    const pool = context.primaryPool ?? deps.primaryPool;
    const objectStore = context.objectStore ?? deps.objectStore;
    const schema = context.schema ?? deps.schema;
    if (!pool || typeof pool.connect !== "function" || !objectStore
        || typeof objectStore.put !== "function" || typeof objectStore.delete !== "function") {
      throw unavailable();
    }
    const options = { schema, sourceNamespace: deps.sourceNamespace };
    const principal = Object.freeze({ participantId: owner.participantId, deviceId: sourceDeviceId });

    let envelope;
    try {
      envelope = validateTelemetryV11Envelope(value);
    } catch {
      // The Worker never maps this contract error to an ApiError, so its
      // top-level handler answers 500 INTERNAL_ERROR (keys were exact above).
      throw failure(500, "INTERNAL_ERROR");
    }
    const plaintext = await deps.decryptSyntheticEnvelope(
      envelope, deps.envelopePublicJwk, deps.envelopePrivateJwk,
    );
    const chunk = await deps.validateStagedChunk(plaintext);

    const prior = await deps.readStorageReplay(pool, principal, chunk, options);
    if (prior) {
      await deps.recordUploadReceipt(pool, claim.authorizationId, prior.id, Date.now(), options);
      return receipt(prior.id, prior.manifestId, chunk, true);
    }

    const chunkRowId = "chunk:" + crypto.randomUUID();
    const objectKey = "telemetry/v11-" + crypto.randomUUID();
    // As the Worker: the chunk records sha256 of the decoded body text, and
    // the persist transaction requires the claimed grant to carry that same
    // digest, so a body the claim bound differently is refused there.
    const envelopeDigest = await deps.sha256Hex(raw);
    const attempt = Object.freeze({ chunkRowId, objectKey, r2Key: objectKey, authorizationId: claim.authorizationId });
    await deps.registerPendingObject(pool, chunkRowId, objectKey, Date.now(), options);
    try {
      await objectStore.put(objectKey, new TextEncoder().encode(raw), {
        contentType: "application/json",
        customMetadata: {
          contributionId: chunkRowId,
          schemaVersion: TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION,
          plaintextSchemaVersion: chunk.schemaVersion,
          synthetic: "false",
        },
      });
    } catch {
      // A failed PUT may still have stored bytes; the registered journal row
      // is the cleanup record. Nothing durable references the object.
      throw unavailable();
    }

    // From here the outcome of the durable write can be uncertain, so the
    // preamble must not abandon the claim: this handler resolves it.
    if (typeof context.markPersistStarted === "function") context.markPersistStarted();
    let result;
    try {
      result = await deps.persistStagedChunk(pool, principal, chunk, {
        chunkRowId,
        r2Key: objectKey,
        envelopeDigest,
        deviceUploadAuthorizationId: claim.authorizationId,
      }, Date.now(), options);
    } catch (error) {
      let outcome;
      try {
        outcome = await deps.readUploadOutcome(pool, principal, chunk, attempt, options);
      } catch {
        // Still uncertain: keep the object, the journal row and the claim
        // lease for reconciliation.
        throw unavailable();
      }
      if (outcome.outcome === "committed" && outcome.row) {
        await deps.recordUploadReceipt(pool, claim.authorizationId, outcome.row.id, Date.now(), options);
        return receipt(outcome.row.id, outcome.row.manifestId, chunk, false);
      }
      if (outcome.outcome === "replay" && outcome.row) {
        await deps.recordUploadReceipt(pool, claim.authorizationId, outcome.row.id, Date.now(), options);
        await deps.retirePendingObject(pool, objectStore, attempt, options).catch(() => false);
        return receipt(outcome.row.id, outcome.row.manifestId, chunk, true);
      }
      try {
        await deps.abandonUploadAuthorization(pool, claim.claim, principal, { schema });
      } catch { /* The bounded claim lease expires on its own. */ }
      try {
        await deps.retirePendingObject(pool, objectStore, attempt, options);
      } catch { /* The deleting journal row is the cleanup record. */ }
      if (outcome.outcome === "conflict") throw failure(409, "TELEMETRY_MANIFEST_CONFLICT");
      if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 500
          && typeof error?.code === "string") {
        throw error;
      }
      throw unavailable();
    }
    if (result.replay && result.contributionId !== chunkRowId) {
      // A content replay won after the first lookup. Only our unreferenced
      // object is removable; the retained winner is never touched.
      await deps.retirePendingObject(pool, objectStore, attempt, options).catch(() => false);
    }
    await deps.recordUploadReceipt(pool, claim.authorizationId, result.contributionId, Date.now(), options);
    return receipt(result.contributionId, result.manifestId, chunk, result.replay);
  }

  return registerContributionEnvelope(TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION, handleTelemetryV11Contribution);
}
