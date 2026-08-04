import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  STABLE_RELEASE_CHANNEL,
} from "../../../config/release-channels.js";

export const DEPLOYMENT_PROOF_SCHEMA_VERSION =
  "tibotattle-worker-deployment-proof-v0.1";
export const STAGING_DISABLED_WORKER_PROOF_OPERATION =
  "staging_disabled_worker_observed";
export const PRODUCTION_CONTAINMENT_PROOF_OPERATION =
  "production_containment_observed";
export const PRODUCTION_OBSERVATION_CHANNEL =
  "production_containment_observer";
export const DEFAULT_DEPLOYMENT_PROOF_MAX_AGE_MS = 15 * 60 * 1000;
export const MAX_DEPLOYMENT_PROOF_BYTES = 32 * 1024;

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;
const WORKER_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function canonicalProductionManifest() {
  return {
    public: {
      origin: DEPLOYMENT_ENDPOINTS.public.origin,
      routeHosts: [...DEPLOYMENT_ENDPOINTS.public.routeHosts],
    },
    schemaVersion: DEPLOYMENT_ENDPOINTS.schemaVersion,
    sparkle: {
      appcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      origin: DEPLOYMENT_ENDPOINTS.sparkle.origin,
      r2Bucket: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket,
    },
  };
}

const CANONICAL_PRODUCTION_MANIFEST = canonicalProductionManifest();
const CANONICAL_PRODUCTION_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(CANONICAL_PRODUCTION_MANIFEST), "utf8")
  .digest("hex");

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

function validProductionTarget(target) {
  const manifest = target?.endpointManifest;
  return target?.origin === DEPLOYMENT_ENDPOINTS.public.origin
    && manifest?.status === "matched"
    && manifest?.schemaVersion === CANONICAL_PRODUCTION_MANIFEST.schemaVersion
    && manifest?.sha256 === CANONICAL_PRODUCTION_MANIFEST_SHA256
    && manifest?.publicOrigin === DEPLOYMENT_ENDPOINTS.public.origin
    && manifest?.appcastURL === DEPLOYMENT_ENDPOINTS.sparkle.appcastURL
    && JSON.stringify(manifest?.routeHosts)
      === JSON.stringify(CANONICAL_PRODUCTION_MANIFEST.public.routeHosts);
}

function invalid(code) {
  return Object.freeze({ ok: false, code });
}

export function validateDeploymentProof({
  proof,
  kind,
  expectedOrigin = null,
  expectedSourceCommit = null,
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
          && proof.worker.sourceCommit !== expectedSourceCommit)) {
      return invalid("STAGING_DISABLED_WORKER_PROOF_MISMATCH");
    }
    return Object.freeze({ ok: true, code: null, proof });
  }
  if (kind === "production") {
    if (proof.operation !== PRODUCTION_CONTAINMENT_PROOF_OPERATION
        || proof.environment !== "production"
        || proof.channel !== STABLE_RELEASE_CHANNEL
        || proof.observationChannel !== PRODUCTION_OBSERVATION_CHANNEL
        || proof.status !== "remote_containment_observed"
        || !validProductionTarget(proof.target)) {
      return invalid("PRODUCTION_CONTAINMENT_PROOF_MISMATCH");
    }
    return Object.freeze({ ok: true, code: null, proof });
  }
  return invalid("DEPLOYMENT_PROOF_KIND_INVALID");
}

export async function readDeploymentProof({
  filename,
  ...options
} = {}) {
  if (typeof filename !== "string" || filename.length === 0) {
    return invalid("DEPLOYMENT_PROOF_REQUIRED");
  }
  let metadata;
  let text;
  try {
    metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size <= 0 || metadata.size > MAX_DEPLOYMENT_PROOF_BYTES) {
      return invalid("DEPLOYMENT_PROOF_MALFORMED");
    }
    text = await readFile(filename, "utf8");
  } catch {
    return invalid("DEPLOYMENT_PROOF_UNREADABLE");
  }
  let proof;
  try {
    proof = JSON.parse(text);
  } catch {
    return invalid("DEPLOYMENT_PROOF_MALFORMED");
  }
  return validateDeploymentProof({ proof, ...options });
}

export const CANONICAL_PRODUCTION_DEPLOYMENT_PROOF = Object.freeze({
  manifest: Object.freeze({
    status: "matched",
    code: null,
    schemaVersion: CANONICAL_PRODUCTION_MANIFEST.schemaVersion,
    publicOrigin: CANONICAL_PRODUCTION_MANIFEST.public.origin,
    appcastURL: CANONICAL_PRODUCTION_MANIFEST.sparkle.appcastURL,
    routeHosts: Object.freeze([...CANONICAL_PRODUCTION_MANIFEST.public.routeHosts]),
  }),
  manifestSha256: CANONICAL_PRODUCTION_MANIFEST_SHA256,
});
