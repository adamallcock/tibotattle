import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";

// The production containment proof (operation
// "production_containment_observed") was deleted on 2026-08-07: production is
// enrollment-open and operational, so that receipt could never be truthfully
// written without an intake outage, and production deploys now gate on
// unapplied D1 migrations instead. Only the staging proof kinds remain.
// See docs/governance/2026-08-07-production-deploy-migration-gate.md.
export const DEPLOYMENT_PROOF_SCHEMA_VERSION =
  "tibotattle-worker-deployment-proof-v0.1";
export const STAGING_DISABLED_WORKER_PROOF_OPERATION =
  "staging_disabled_worker_observed";
export const DEFAULT_DEPLOYMENT_PROOF_MAX_AGE_MS = 15 * 60 * 1000;
export const MAX_DEPLOYMENT_PROOF_BYTES = 32 * 1024;
export const DEPLOYMENT_IDENTITY_SCHEMA_VERSION =
  "tibotattle-worker-deployment-identity-v0.1";
export const STAGING_DEPLOYMENT_IDENTITY_OPERATION =
  "staging_disabled_worker_deployment_intent";

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;
const WORKER_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const OWNER_ONLY_MODE = 0o600n;

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.pathname !== "/"
        || parsed.search
        || parsed.hash
        || parsed.origin !== value) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function validObservedAt(value, now, maxAgeMs) {
  if (typeof value !== "string") return false;
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt)) return false;
  const age = now - observedAt;
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

function validWorkerEvidence(worker, evidence) {
  return worker?.revision
      && typeof worker.revision === "string"
      && WORKER_REVISION_PATTERN.test(worker.revision)
      && typeof worker.sourceCommit === "string"
      && SOURCE_COMMIT_PATTERN.test(worker.sourceCommit)
      && worker.enrollmentMode === "disabled"
      && worker.collectionControls === "contained"
      && evidence?.ownerObservedRemoteRevision === true
      && evidence?.ownerObservedDisabledMode === true
      && evidence?.ownerObservedContainment === true
      && evidence?.ownerObservedCanonicalTarget === true;
}

function validStagingTarget(target, expectedOrigin) {
  const origin = canonicalOrigin(target?.origin);
  if (!origin || !origin.endsWith(".workers.dev")) return false;
  if (origin === DEPLOYMENT_ENDPOINTS.public.origin) return false;
  return !expectedOrigin || origin === expectedOrigin;
}

function invalid(code) {
  return Object.freeze({ ok: false, code });
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function identityPayload(identity) {
  const { intentId: _intentId, sha256: _sha256, ...payload } = identity;
  return payload;
}

export function createStagingDeploymentIdentity({
  origin,
  sourceCommit,
  workerName = "app-usagemonitor-staging",
  generatedAt = new Date().toISOString(),
} = {}) {
  const payload = {
    schemaVersion: DEPLOYMENT_IDENTITY_SCHEMA_VERSION,
    operation: STAGING_DEPLOYMENT_IDENTITY_OPERATION,
    environment: "staging",
    generatedAt,
    deployment: {
      origin,
      revision: null,
      revisionObserved: false,
      revisionObservation: "owner_observation_required",
      sourceCommit,
      endpointManifest: {
        status: "matched",
        environment: "staging",
        origin,
        workerName,
        workersDev: true,
        previewUrls: false,
        routes: [],
      },
    },
  };
  const digest = sha256(payload);
  return Object.freeze({
    ...payload,
    intentId: `staging-${digest.slice(0, 16)}`,
    sha256: digest,
  });
}

function validateStagingDeploymentIdentity({
  identity,
  expectedOrigin = null,
  expectedSourceCommit = null,
} = {}) {
  if (!objectRecord(identity)
      || identity.schemaVersion !== DEPLOYMENT_IDENTITY_SCHEMA_VERSION
      || identity.operation !== STAGING_DEPLOYMENT_IDENTITY_OPERATION
      || identity.environment !== "staging"
      || typeof identity.generatedAt !== "string"
      || !Number.isFinite(Date.parse(identity.generatedAt))
      || !/^staging-[a-f0-9]{16}$/u.test(identity.intentId ?? "")
      || !/^[a-f0-9]{64}$/u.test(identity.sha256 ?? "")
      || identity.sha256 !== sha256(identityPayload(identity))) {
    return invalid("STAGING_DEPLOYMENT_IDENTITY_MALFORMED");
  }
  const deployment = identity.deployment;
  const manifest = deployment?.endpointManifest;
  if (!validStagingTarget({ origin: deployment?.origin }, expectedOrigin)
      || deployment.revision !== null
      || deployment.revisionObserved !== false
      || deployment.revisionObservation !== "owner_observation_required"
      || typeof deployment.sourceCommit !== "string"
      || !SOURCE_COMMIT_PATTERN.test(deployment.sourceCommit)
      || (expectedSourceCommit !== null
        && deployment.sourceCommit !== expectedSourceCommit)
      || manifest?.status !== "matched"
      || manifest.environment !== "staging"
      || manifest.origin !== deployment.origin
      || manifest.workerName !== "app-usagemonitor-staging"
      || manifest.workersDev !== true
      || manifest.previewUrls !== false
      || !Array.isArray(manifest.routes)
      || manifest.routes.length !== 0) {
    return invalid("STAGING_DEPLOYMENT_IDENTITY_MISMATCH");
  }
  return Object.freeze({ ok: true, code: null, identity });
}

export function validateStagingDeploymentIdentityReference({
  identity,
  reference,
  expectedOrigin = null,
  expectedSourceCommit = null,
} = {}) {
  const identityCheck = validateStagingDeploymentIdentity({
    identity,
    expectedOrigin,
    expectedSourceCommit,
  });
  if (!identityCheck.ok) return identityCheck;
  if (reference?.schemaVersion !== DEPLOYMENT_IDENTITY_SCHEMA_VERSION
      || reference.intentId !== identity.intentId
      || reference.sha256 !== identity.sha256) {
    return invalid("STAGING_DEPLOYMENT_IDENTITY_REFERENCE_MISMATCH");
  }
  return identityCheck;
}

function bigint(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function metadataBigint(value) {
  try {
    return bigint(value);
  } catch {
    return null;
  }
}

export function validateOwnerOnlyRegularFileMetadata(
  metadata,
  { ownerUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null } = {},
) {
  const mode = metadataBigint(metadata?.mode);
  const uid = metadataBigint(metadata?.uid);
  const expectedUid = ownerUid === null ? null : metadataBigint(ownerUid);
  if (!metadata?.isFile?.() || metadata.isSymbolicLink?.()
      || mode === null
      || (mode & 0o777n) !== OWNER_ONLY_MODE
      || (expectedUid !== null && uid !== expectedUid)) {
    return false;
  }
  return true;
}

function stableFileFingerprint(metadata) {
  return ["dev", "ino", "size", "mode", "uid", "mtimeNs", "ctimeNs"]
    .map((key) => metadataBigint(metadata?.[key] ?? 0));
}

function sameFileFingerprint(left, right) {
  const leftFingerprint = stableFileFingerprint(left);
  const rightFingerprint = stableFileFingerprint(right);
  return leftFingerprint.every((value, index) => value === rightFingerprint[index]);
}

async function readOwnerOnlyProofText(filename, { afterRead = null } = {}) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(filename, { bigint: true });
  } catch {
    return invalid("DEPLOYMENT_PROOF_UNREADABLE");
  }
  if (!validateOwnerOnlyRegularFileMetadata(pathMetadata)) {
    return invalid("DEPLOYMENT_PROOF_FILE_UNSAFE");
  }

  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const beforeRead = await handle.stat({ bigint: true });
    if (!validateOwnerOnlyRegularFileMetadata(beforeRead)
        || !sameFileFingerprint(pathMetadata, beforeRead)) {
      return invalid("DEPLOYMENT_PROOF_FILE_UNSAFE");
    }

    const buffer = Buffer.alloc(MAX_DEPLOYMENT_PROOF_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (typeof afterRead === "function") await afterRead();

    const afterReadMetadata = await handle.stat({ bigint: true });
    if (!validateOwnerOnlyRegularFileMetadata(afterReadMetadata)
        || !sameFileFingerprint(beforeRead, afterReadMetadata)) {
      return invalid("DEPLOYMENT_PROOF_MUTATED");
    }
    if (offset > MAX_DEPLOYMENT_PROOF_BYTES) {
      return invalid("DEPLOYMENT_PROOF_MALFORMED");
    }
    return Object.freeze({
      ok: true,
      text: buffer.subarray(0, offset).toString("utf8"),
    });
  } catch {
    return invalid("DEPLOYMENT_PROOF_UNREADABLE");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function validateDeploymentProof({
  proof,
  kind,
  expectedOrigin = null,
  expectedSourceCommit = null,
  expectedDeploymentIdentity = null,
  now = Date.now(),
  maxAgeMs = DEFAULT_DEPLOYMENT_PROOF_MAX_AGE_MS,
} = {}) {
  if (!objectRecord(proof)) return invalid("DEPLOYMENT_PROOF_MALFORMED");
  if (proof.schemaVersion !== DEPLOYMENT_PROOF_SCHEMA_VERSION
      || !validObservedAt(proof.observedAt, now, maxAgeMs)
      || !validWorkerEvidence(proof.worker, proof.evidence)) {
    return invalid("DEPLOYMENT_PROOF_MALFORMED");
  }
  if (kind === "staging") {
    if (proof.operation !== STAGING_DISABLED_WORKER_PROOF_OPERATION
        || proof.environment !== "staging"
        || proof.channel !== "staging"
        || proof.phase !== "pre_migration_compatibility"
        || !validStagingTarget(proof.target, expectedOrigin)
        || (expectedSourceCommit !== null
          && proof.worker.sourceCommit !== expectedSourceCommit)
        || expectedDeploymentIdentity === null
        || !validateStagingDeploymentIdentityReference({
          identity: expectedDeploymentIdentity,
          reference: proof.deploymentIdentity,
          expectedOrigin,
          expectedSourceCommit,
        }).ok) {
      return invalid("STAGING_DISABLED_WORKER_PROOF_MISMATCH");
    }
    return Object.freeze({ ok: true, code: null, proof });
  }
  // kind "production" was deliberately removed on 2026-08-07 and now fails
  // closed here: no receipt can authorize a production deploy, and the deploy
  // wrapper gates on unapplied D1 migrations instead
  // (docs/governance/2026-08-07-production-deploy-migration-gate.md).
  return invalid("DEPLOYMENT_PROOF_KIND_INVALID");
}

export async function readDeploymentProof({
  filename,
  afterRead = null,
  ...options
} = {}) {
  if (typeof filename !== "string" || filename.length === 0) {
    return invalid("DEPLOYMENT_PROOF_REQUIRED");
  }
  const file = await readOwnerOnlyProofText(filename, { afterRead });
  if (!file.ok) return file;
  if (file.text.length === 0) return invalid("DEPLOYMENT_PROOF_MALFORMED");
  let proof;
  try {
    proof = JSON.parse(file.text);
  } catch {
    return invalid("DEPLOYMENT_PROOF_MALFORMED");
  }
  return validateDeploymentProof({ proof, ...options });
}

export async function readStagingDeploymentIdentity({
  filename,
  expectedOrigin = null,
  expectedSourceCommit = null,
} = {}) {
  if (typeof filename !== "string" || filename.length === 0) {
    return invalid("STAGING_DEPLOYMENT_IDENTITY_REQUIRED");
  }
  const file = await readOwnerOnlyProofText(filename);
  if (!file.ok) return file;
  let identity;
  try {
    identity = JSON.parse(file.text);
  } catch {
    return invalid("STAGING_DEPLOYMENT_IDENTITY_MALFORMED");
  }
  return validateStagingDeploymentIdentity({
    identity,
    expectedOrigin,
    expectedSourceCommit,
  });
}
